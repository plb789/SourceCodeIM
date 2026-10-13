package server

// ===== 云存档（Steam 同款云存档） =====
// P1（单设备闭环）：清单/上传/定稿/下载/删除；P2（版本保留）：修订快照 + 裁剪 + 回滚；P3（多槽位）：槽位枚举
// 设计归口：
//   1. 元数据：一个 (username, game_id, slot) 一组存档落 im_game_save，其文件清单落
//      im_game_save_file（rel_path 为该存档内的逻辑相对路径，如 0/save01.sav）
//   2. 文件本体经 store.GetObjectStore() 对象存储，ObjectKey = game_saves/<username>/<gameID>/<slot>/<sha256>，
//      json:"-" 绝不外泄（下载按文件 ID 归口校验归属）
//   3. 上传流式复算 sha256/size（不信任客户端声明），单文件/单游戏总量上限归口校验
//   4. 鉴权水位与 /api/game/* 一致（username 查询参数）+ 库归属校验（防清单外枚举）；开关 game.save.enabled
//   5. 路由一律字面量前缀式（第 3 段固定字面量 save），与 /api/game/{id} 等现有路由无两可冲突

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

const (
	gameSaveDefaultMaxFile  = 50 << 20  // 单存档文件上限缺省 50MB（配置 0 时生效）
	gameSaveDefaultMaxTotal = 200 << 20 // 单用户单游戏云存档总上限缺省 200MB（配置 0 时生效）
	gameSaveDefaultKeep     = 5         // 版本保留数缺省（配置 0 时生效）
	gameSaveSlotDefault     = "default" // slot 缺省归口（为空时归一为此值，ObjectKey 路径安全）
)

// gameSaveSlotRe slot 白名单（字母/数字/下划线/中划线，1-32 位；避免落入 ObjectKey 路径穿越）
var gameSaveSlotRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// ===== 云存档并发串行化（阶段二百九十一） =====
// 对象存储 key 为内容寻址（game_saves/<user>/<game>/<slot>/<sha>），同内容的多 rel_path 共享同一对象；
// 上传覆盖/定稿/回滚/删除均需「读旧行 → 写对象 → 判定 → 删旧对象 → 更新行」原子完成，
// 否则并发下会误删他行共享的对象（下载 404）或双方各保留导致孤儿对象泄漏。
// 归口：按 (username, game_id, slot) 分片加互斥锁——固定 gameSaveLockStripes 把，哈希取模，
// O(1) 内存、无需清理；同组必得同一把，不同组极少碰撞（碰撞仅轻微串行，语义仍正确）。
// 1024 把分片锁（2 的幂，哈希取模分布均匀；1024×8B≈8KB 内存，可忽略；分片越多碰撞越少）
const gameSaveLockStripes = 1024

var gameSaveLocks [gameSaveLockStripes]sync.Mutex

// gameSaveLockFor 返回该存档组对应的互斥锁（同一存档组必得同一把）
func gameSaveLockFor(username string, gameID uint, slot string) *sync.Mutex {
	h := fnv.New32a()
	_, _ = h.Write([]byte(username))
	_, _ = h.Write([]byte{0})
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], uint64(gameID))
	_, _ = h.Write(b[:])
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(slot))
	return &gameSaveLocks[h.Sum32()%gameSaveLockStripes]
}

// gameSaveEnabled 云存档开关归口（游戏中心未启用或云存档未启用时接口统一拒绝）
func (s *Server) gameSaveEnabled(w http.ResponseWriter) bool {
	if !s.gameEnabled(w) {
		return false
	}
	if !s.cfg.Game.Save.Enabled {
		adminFail(w, http.StatusForbidden, "云存档未启用")
		return false
	}
	return true
}

// gameSaveSlotClean 清洗 slot：空归一为 default；非法（超长/含非法字符）返回空串由调用方拒绝
func gameSaveSlotClean(slot string) string {
	slot = strings.TrimSpace(slot)
	if slot == "" {
		return gameSaveSlotDefault
	}
	if !gameSaveSlotRe.MatchString(slot) {
		return ""
	}
	return slot
}

// gameSaveMaxFile 单存档文件上限（配置 0 回退 50MB）
func (s *Server) gameSaveMaxFile() int64 {
	if v := s.cfg.Game.Save.MaxFileSize; v > 0 {
		return v
	}
	return gameSaveDefaultMaxFile
}

// gameSaveMaxTotal 单用户单游戏云存档总量上限（配置 0 回退 200MB）
func (s *Server) gameSaveMaxTotal() int64 {
	if v := s.cfg.Game.Save.MaxTotalSize; v > 0 {
		return v
	}
	return gameSaveDefaultMaxTotal
}

// gameSaveRetention 历史修订保留数（配置 0 回退 5；至少 1，保证当前修订必留）
func (s *Server) gameSaveRetention() int {
	if v := s.cfg.Game.Save.Retention; v > 0 {
		return v
	}
	return gameSaveDefaultKeep
}

// gameSaveSnapshotFile 修订快照内的单文件记录（回滚重建用；不含服务端私有 ObjectKey）
type gameSaveSnapshotFile struct {
	RelPath string `json:"rel_path"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

// gameSaveSnapshotOf 由当前清单行生成快照 JSON 串与统计（rel_path 升序幂等输出）
func gameSaveSnapshotOf(files []model.GameSaveFile) (string, int64, int) {
	list := make([]gameSaveSnapshotFile, 0, len(files))
	var total int64
	for _, f := range files {
		list = append(list, gameSaveSnapshotFile{RelPath: f.RelPath, Size: f.SizeBytes, SHA256: f.SHA256})
		total += f.SizeBytes
	}
	b, _ := json.Marshal(list)
	return string(b), total, len(list)
}

// gameSaveParseSnapshot 快照 JSON → 文件记录（解析失败返回空，按空清单处理）
func gameSaveParseSnapshot(raw string) []gameSaveSnapshotFile {
	var list []gameSaveSnapshotFile
	if raw == "" {
		return list
	}
	_ = json.Unmarshal([]byte(raw), &list)
	return list
}

// gameSaveShaReferenced 该 sha 是否仍被任一修订快照引用（上传覆盖旧对象前的“是否可安全删除”判据；
// 被历史修订引用的对象需保留以支持回滚）
func (s *Server) gameSaveShaReferenced(saveID uint, sha string) bool {
	if sha == "" {
		return false
	}
	var revs []model.GameSaveRev
	store.DB.Where("save_id = ?", saveID).Find(&revs)
	for _, r := range revs {
		for _, f := range gameSaveParseSnapshot(r.Files) {
			if f.SHA256 == sha {
				return true
			}
		}
	}
	return false
}

// gameSaveShaLiveReferenced 该 sha 是否仍被「其他」存活清单行（除 exceptID 外）引用；
// 与 gameSaveShaReferenced（修订快照判据）互补：同内容多路径时防覆盖一行误删他行仍指向的对象
func (s *Server) gameSaveShaLiveReferenced(saveID uint, sha string, exceptID uint) bool {
	if sha == "" {
		return false
	}
	var cnt int64
	store.DB.Model(&model.GameSaveFile{}).
		Where("save_id = ? AND sha256 = ? AND id <> ?", saveID, sha, exceptID).
		Count(&cnt)
	return cnt > 0
}

// gameSaveDropOne 删除单个存档组（对象 + 文件行 + 修订行 + 主行）：对象引用取存活清单 ∪ 全部修订快照，
// 幂等；供「用户删除存档」与「删游戏/退库级联」共用
func (s *Server) gameSaveDropOne(save model.GameSave) {
	st := store.GetObjectStore()
	var files []model.GameSaveFile
	store.DB.Where("save_id = ?", save.ID).Find(&files)
	shas := map[string]bool{}
	for i := range files {
		if files[i].SHA256 != "" {
			shas[files[i].SHA256] = true
		}
	}
	var revs []model.GameSaveRev
	store.DB.Where("save_id = ?", save.ID).Find(&revs)
	for _, r := range revs {
		for _, f := range gameSaveParseSnapshot(r.Files) {
			if f.SHA256 != "" {
				shas[f.SHA256] = true
			}
		}
	}
	if st != nil {
		for sh := range shas {
			_ = st.Delete(gameSaveObjectKey(save.Username, save.GameID, save.Slot, sh))
		}
	}
	store.DB.Where("save_id = ?", save.ID).Delete(&model.GameSaveFile{})
	store.DB.Where("save_id = ?", save.ID).Delete(&model.GameSaveRev{})
	store.DB.Delete(&model.GameSave{}, save.ID)
}

// gameSaveCascadePurge 级联清理某游戏的全部云存档（username 空=全部用户；非空=仅该用户）：
// 删游戏时调用（防孤儿行/孤儿对象累积）；返回清理的存档组数
func (s *Server) gameSaveCascadePurge(gameID uint, username string) int {
	q := store.DB.Where("game_id = ?", gameID)
	if username != "" {
		q = q.Where("username = ?", username)
	}
	var saves []model.GameSave
	q.Find(&saves)
	for _, sv := range saves {
		lk := gameSaveLockFor(sv.Username, sv.GameID, sv.Slot)
		lk.Lock()
		s.gameSaveDropOne(sv)
		lk.Unlock()
	}
	return len(saves)
}

// gameSavePruneRevisions 裁剪超出保留数的旧修订（在事务句柄 db 上执行），
// 返回「仅被被裁剪修订引用」的 sha 列表（供对象 GC）
func (s *Server) gameSavePruneRevisions(db *gorm.DB, saveID uint) []string {
	keep := s.gameSaveRetention()
	var revs []model.GameSaveRev
	db.Where("save_id = ?", saveID).Order("revision DESC").Find(&revs)
	if len(revs) <= keep {
		return nil
	}
	// 保留集引用：最新 keep 条快照 ∪ 当前存活清单行
	ref := map[string]bool{}
	for i := 0; i < keep; i++ {
		for _, f := range gameSaveParseSnapshot(revs[i].Files) {
			ref[f.SHA256] = true
		}
	}
	var liveShas []string
	db.Model(&model.GameSaveFile{}).Where("save_id = ?", saveID).Pluck("sha256", &liveShas)
	for _, sh := range liveShas {
		ref[sh] = true
	}
	drop := map[string]bool{}
	for i := keep; i < len(revs); i++ {
		for _, f := range gameSaveParseSnapshot(revs[i].Files) {
			if f.SHA256 != "" && !ref[f.SHA256] {
				drop[f.SHA256] = true
			}
		}
		db.Delete(&model.GameSaveRev{}, revs[i].ID)
	}
	out := make([]string, 0, len(drop))
	for sh := range drop {
		out = append(out, sh)
	}
	return out
}

// gameSaveGCObjects 在事务句柄 db 上按最新视图计算「不再被任何引用（存活清单 ∪ 剩余修订快照）指向」的
// 对象 key 列表，交由调用方在事务提交后删除。对象存储在 DB 之外、不能纳入事务，故提交后才删：
// 这样若事务回滚则不会有对象被提前删除（避免回滚后指向已删对象的损坏），失败仅留可回收孤儿。
// 候选来源：本次被移除的清单行 + 被裁剪修订独享的 sha
func (s *Server) gameSaveGCObjects(db *gorm.DB, save model.GameSave, removed []model.GameSaveFile, candidateShas []string) []string {
	ref := map[string]bool{}
	var liveShas []string
	db.Model(&model.GameSaveFile{}).Where("save_id = ?", save.ID).Pluck("sha256", &liveShas)
	for _, sh := range liveShas {
		ref[sh] = true
	}
	var revs []model.GameSaveRev
	db.Where("save_id = ?", save.ID).Find(&revs)
	for _, r := range revs {
		for _, f := range gameSaveParseSnapshot(r.Files) {
			ref[f.SHA256] = true
		}
	}
	var keys []string
	add := func(sha string) {
		if sha != "" && !ref[sha] {
			keys = append(keys, gameSaveObjectKey(save.Username, save.GameID, save.Slot, sha))
		}
	}
	for _, f := range removed {
		add(f.SHA256)
	}
	for _, sh := range candidateShas {
		add(sh)
	}
	return keys
}

// gameSaveCommit 以 desired 快照为准重建该 save 的当前清单：校验对象可用 → 事务内 增删改清单行 →
// 落新修订快照（revision+1）→ 裁剪旧修订 → 更新主行统计 → 计算待回收对象 → 提交 → 删除对象。返回新修订号。
// 上传端与之解耦：上传仅落清单行，定稿/回滚才提交（保证每次提交都是一个完整可回滚的版本）。
// 事务保证中途任一步失败都不会留下「清单与修订不一致」的中间态；对象删除在提交后进行，
// 事务回滚时不会提前删对象（避免回滚后指向已删对象的损坏）
func (s *Server) gameSaveCommit(save model.GameSave, desired []gameSaveSnapshotFile) (int64, error) {
	st := store.GetObjectStore()
	if st != nil {
		for _, d := range desired {
			rc, _, err := st.Open(gameSaveObjectKey(save.Username, save.GameID, save.Slot, d.SHA256))
			if err != nil {
				return 0, fmt.Errorf("修订文件已不可用：%s", d.RelPath)
			}
			rc.Close()
		}
	}
	var newRev int64
	var gcKeys []string
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		var live []model.GameSaveFile
		tx.Where("save_id = ?", save.ID).Find(&live)
		liveByRel := map[string]model.GameSaveFile{}
		for _, f := range live {
			liveByRel[f.RelPath] = f
		}
		want := map[string]bool{}
		for _, d := range desired {
			want[d.RelPath] = true
		}
		var removed []model.GameSaveFile
		for _, f := range live {
			if !want[f.RelPath] {
				removed = append(removed, f)
				if err := tx.Delete(&model.GameSaveFile{}, f.ID).Error; err != nil {
					return err
				}
			}
		}
		for _, d := range desired {
			key := gameSaveObjectKey(save.Username, save.GameID, save.Slot, d.SHA256)
			if old, ok := liveByRel[d.RelPath]; ok {
				if old.SHA256 != d.SHA256 || old.SizeBytes != d.Size {
					if err := tx.Model(&old).Updates(map[string]interface{}{
						"size_bytes": d.Size, "sha256": d.SHA256, "object_key": key,
					}).Error; err != nil {
						return err
					}
				}
			} else {
				if err := tx.Create(&model.GameSaveFile{SaveID: save.ID, RelPath: d.RelPath, SizeBytes: d.Size, SHA256: d.SHA256, ObjectKey: key}).Error; err != nil {
					return err
				}
			}
		}
		var after []model.GameSaveFile
		tx.Where("save_id = ?", save.ID).Order("rel_path ASC").Find(&after)
		snapJSON, totalSize, fileCount := gameSaveSnapshotOf(after)
		newRev = save.Revision + 1
		var revRow model.GameSaveRev
		if err := tx.Where("save_id = ? AND revision = ?", save.ID, newRev).First(&revRow).Error; err == nil {
			if err := tx.Model(&revRow).Updates(map[string]interface{}{"total_size": totalSize, "file_count": fileCount, "files": snapJSON}).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Create(&model.GameSaveRev{SaveID: save.ID, Revision: newRev, TotalSize: totalSize, FileCount: fileCount, Files: snapJSON}).Error; err != nil {
				return err
			}
		}
		pruned := s.gameSavePruneRevisions(tx, save.ID)
		if err := tx.Model(&save).Updates(map[string]interface{}{"revision": newRev, "total_size": totalSize, "file_count": fileCount}).Error; err != nil {
			return err
		}
		gcKeys = s.gameSaveGCObjects(tx, save, removed, pruned)
		return nil
	})
	if err != nil {
		return 0, err
	}
	// 事务已提交，再删对象（对象存储不参与 DB 事务；失败仅留可再回收孤儿，不影响一致性）
	if st != nil {
		for _, k := range gcKeys {
			_ = st.Delete(k)
		}
	}
	return newRev, nil
}

// gameSaveObjectKey 对象存储 key 归口：game_saves/<username>/<gameID>/<slot>/<sha256>（key 内含内容指纹，
// 同内容天然幂等去重；sha 变化即新 key，旧对象由上传/清理归口删除）
func gameSaveObjectKey(username string, gameID uint, slot, sha string) string {
	return "game_saves/" + username + "/" + strconv.FormatUint(uint64(gameID), 10) + "/" + slot + "/" + sha
}

// gameSaveAccess 用户侧云存档身份 + 库归属归口（username 查询参数 + 该用户名对本 game 已入库，
// 未入库拒绝——与 /api/game/file/{fid} 同款防枚举口径）
func (s *Server) gameSaveAccess(w http.ResponseWriter, r *http.Request) (string, uint, bool) {
	username, ok := gameUsername(w, r)
	if !ok {
		return "", 0, false
	}
	gid, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if gid == 0 {
		adminFail(w, http.StatusBadRequest, "游戏参数错误")
		return "", 0, false
	}
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, gid).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusForbidden, "请先将游戏加入库")
		return "", 0, false
	}
	return username, uint(gid), true
}

// HandleGameSaveManifest 云存档清单拉取 GET /api/game/save/manifest/{id}?username=&slot=
// 无存档返回 {exists:false,files:[]}；有则返回 revision/total_size/file_count/update_time/files（按 rel_path 升序）
func (s *Server) HandleGameSaveManifest(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法（仅字母/数字/下划线/中划线，限 32 位）")
		return
	}
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		adminJSON(w, map[string]interface{}{"exists": false, "slot": slot, "files": []map[string]interface{}{}})
		return
	}
	var files []model.GameSaveFile
	store.DB.Where("save_id = ?", save.ID).Order("rel_path ASC").Find(&files)
	list := make([]map[string]interface{}, 0, len(files))
	for _, f := range files {
		list = append(list, map[string]interface{}{
			"id":       f.ID,
			"rel_path": f.RelPath,
			"size":     f.SizeBytes,
			"sha256":   f.SHA256,
			"url":      "/api/game/save/download/" + strconv.FormatUint(uint64(f.ID), 10),
		})
	}
	adminJSON(w, map[string]interface{}{
		"exists":      true,
		"slot":        slot,
		"revision":    save.Revision,
		"total_size":  save.TotalSize,
		"file_count":  save.FileCount,
		"update_time": save.UpdateTime.Format("2006-01-02 15:04"),
		"files":       list,
	})
}

// HandleGameSaveFileUpload 云存档单文件上传 POST /api/game/save/file/{id}?username=&slot=&rel_path=&sha256=&size=
// 请求体为原始文件字节流（非 multipart）：流式落临时文件并复算 sha256/size 校验（不信任客户端声明），
// 校验通过后写入对象存储并 Upsert 清单行（同 rel_path 覆盖旧对象）；返回 {ok:true,file_id:N}
func (s *Server) HandleGameSaveFileUpload(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法")
		return
	}
	relPath := gameRelPathClean(r.URL.Query().Get("rel_path"))
	if relPath == "" {
		adminFail(w, http.StatusBadRequest, "rel_path 非法（须为存档内相对路径）")
		return
	}
	wantSHA := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sha256")))
	if len(wantSHA) != 64 {
		adminFail(w, http.StatusBadRequest, "sha256 参数非法")
		return
	}
	wantSize, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("size")), 10, 64)
	if err != nil || wantSize < 0 {
		adminFail(w, http.StatusBadRequest, "size 参数非法")
		return
	}
	maxFile := s.gameSaveMaxFile()
	if wantSize > maxFile {
		adminFail(w, http.StatusBadRequest, "存档文件超过单文件上限")
		return
	}
	st := store.GetObjectStore()
	if st == nil {
		adminFail(w, http.StatusInternalServerError, "存储后端未就绪")
		return
	}
	// 流式落临时文件并复算 sha256（MaxBytesReader 硬限长兜底，防声明 size 与实际体量不符）
	tmpDir := filepath.Join(s.cfg.Game.LocalDir, "save_tmp")
	if err := os.MkdirAll(tmpDir, os.ModePerm); err != nil {
		adminFail(w, http.StatusInternalServerError, "临时目录创建失败")
		return
	}
	tf, err := os.CreateTemp(tmpDir, "upload_*.tmp")
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "临时文件创建失败")
		return
	}
	tmpName := tf.Name()
	defer func() { tf.Close(); os.Remove(tmpName) }()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tf, h), http.MaxBytesReader(w, r.Body, maxFile+1))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "存档文件读取失败或超过单文件上限")
		return
	}
	if n != wantSize {
		adminFail(w, http.StatusBadRequest, "文件大小校验不一致")
		return
	}
	gotSHA := hex.EncodeToString(h.Sum(nil))
	if gotSHA != wantSHA {
		adminFail(w, http.StatusBadRequest, "文件 SHA256 校验不一致")
		return
	}
	// 存档组互斥：覆盖上传的「读旧行→写对象→判定→删旧对象→更新行」必须原子，防并发误删共享对象
	saveLock := gameSaveLockFor(username, gid, slot)
	saveLock.Lock()
	defer saveLock.Unlock()
	// 找到或创建存档主行
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		save = model.GameSave{Username: username, GameID: gid, Slot: slot}
		if err := store.DB.Create(&save).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "存档创建失败")
			return
		}
	}
	// 同 rel_path 覆盖：先取旧行（旧对象 key/大小）；总量配额按净增量校验
	var old model.GameSaveFile
	hasOld := store.DB.Where("save_id = ? AND rel_path = ?", save.ID, relPath).First(&old).Error == nil
	var oldSize int64
	if hasOld {
		oldSize = old.SizeBytes
	}
	newTotal := save.TotalSize - oldSize + n
	if newTotal > s.gameSaveMaxTotal() {
		adminFail(w, http.StatusBadRequest, "云存档总量超过单游戏上限")
		return
	}
	objectKey := gameSaveObjectKey(username, gid, slot, gotSHA)
	if _, err := tf.Seek(0, io.SeekStart); err != nil {
		adminFail(w, http.StatusInternalServerError, "临时文件回卷失败")
		return
	}
	if err := st.Put(context.Background(), objectKey, tf, n, "", "application/octet-stream"); err != nil {
		adminFail(w, http.StatusInternalServerError, "存档写入失败")
		return
	}
	// 旧对象清理（同 rel_path 覆盖且 key 变化时；key 内含 sha，内容相同则 key 相同不重复删）
	// 阶段二百九十一：旧内容既未被历史修订快照引用、也未被其他存活清单行引用时才删除
	// （防同内容多路径时误删他行仍指向的对象，导致该行下载 404）
	if hasOld && old.ObjectKey != "" && old.ObjectKey != objectKey {
		if !s.gameSaveShaReferenced(save.ID, old.SHA256) && !s.gameSaveShaLiveReferenced(save.ID, old.SHA256, old.ID) {
			_ = st.Delete(old.ObjectKey)
		}
	}
	var fileID uint
	if hasOld {
		if err := store.DB.Model(&old).Updates(map[string]interface{}{
			"size_bytes": n, "sha256": gotSHA, "object_key": objectKey,
		}).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "存档清单更新失败")
			return
		}
		fileID = old.ID
	} else {
		row := model.GameSaveFile{SaveID: save.ID, RelPath: relPath, SizeBytes: n, SHA256: gotSHA, ObjectKey: objectKey}
		if err := store.DB.Create(&row).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "存档清单写入失败")
			return
		}
		fileID = row.ID
	}
	fileCount := save.FileCount
	if !hasOld {
		fileCount++
	}
	store.DB.Model(&save).Updates(map[string]interface{}{"total_size": newTotal, "file_count": fileCount})
	adminJSON(w, map[string]interface{}{"ok": true, "file_id": fileID})
}

// HandleGameSaveFinalize 云存档定稿 POST /api/game/save/finalize/{id}?username=&slot=（body {rel_paths:[...]}）
// 删除本 save 下不在 rel_paths 中的清单行与对象，重算 TotalSize/FileCount，Revision+1；返回 {ok:true,revision:N}
func (s *Server) HandleGameSaveFinalize(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法")
		return
	}
	var req struct {
		RelPaths []string `json:"rel_paths"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	// 存档组互斥：定稿（重建清单→裁修订→GC 对象）与上传/回滚/删除串行化
	saveLock := gameSaveLockFor(username, gid, slot)
	saveLock.Lock()
	defer saveLock.Unlock()
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		adminFail(w, http.StatusNotFound, "云存档不存在")
		return
	}
	// 保留集（清洗后仍合法者；非法路径静默忽略——其对应行视同不保留被清理）
	keep := map[string]bool{}
	for _, p := range req.RelPaths {
		if c := gameRelPathClean(p); c != "" {
			keep[c] = true
		}
	}
	// 以当前清单中「保留集内」的文件构成目标快照（sha 取自清单行，对象必已存在）
	var live []model.GameSaveFile
	store.DB.Where("save_id = ?", save.ID).Find(&live)
	desired := make([]gameSaveSnapshotFile, 0, len(live))
	for _, f := range live {
		if keep[f.RelPath] {
			desired = append(desired, gameSaveSnapshotFile{RelPath: f.RelPath, Size: f.SizeBytes, SHA256: f.SHA256})
		}
	}
	rev, err := s.gameSaveCommit(save, desired)
	if err != nil {
		adminFail(w, http.StatusConflict, err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true, "revision": rev})
}

// HandleGameSaveDownload 云存档文件下载 GET /api/game/save/download/{fid}?username=
// 查 GameSaveFile → 其 GameSave 校验归属（username 匹配）→ Open 对象 → http.ServeContent 流式下发
// （本地后端返回 *os.File 支持 Seek，自动支持 Range/HEAD）
func (s *Server) HandleGameSaveDownload(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	fid, _ := strconv.ParseUint(r.PathValue("fid"), 10, 64)
	var f model.GameSaveFile
	if err := store.DB.First(&f, fid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "存档文件不存在")
		return
	}
	var save model.GameSave
	if err := store.DB.First(&save, f.SaveID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "存档文件不存在")
		return
	}
	if save.Username != username {
		adminFail(w, http.StatusForbidden, "无权访问该存档文件")
		return
	}
	st := store.GetObjectStore()
	if st == nil {
		adminFail(w, http.StatusInternalServerError, "存储后端未就绪")
		return
	}
	rc, _, err := st.Open(f.ObjectKey)
	if err != nil {
		adminFail(w, http.StatusNotFound, "存档文件已丢失")
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	if seeker, ok := rc.(io.ReadSeeker); ok {
		http.ServeContent(w, r, "", time.Time{}, seeker)
		return
	}
	io.Copy(w, rc)
}

// HandleGameSaveDelete 删除云存档 DELETE /api/game/save/data/{id}?username=&slot=
// 删除该 save 全部文件行与对象后再删主行；不存在时幂等返回 {ok:true}
func (s *Server) HandleGameSaveDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法")
		return
	}
	// 存档组互斥：删除（清对象+行）与上传/定稿/回滚串行化
	saveLock := gameSaveLockFor(username, gid, slot)
	saveLock.Lock()
	defer saveLock.Unlock()
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		adminJSON(w, map[string]interface{}{"ok": true}) // 幂等：不存在视为已删除
		return
	}
	s.gameSaveDropOne(save)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleGameSaveHistory 云存档版本历史 GET /api/game/save/history/{id}?username=&slot=
// 返回保留窗口内的修订（按 revision 降序）：{exists,slot,current_revision,revisions:[{revision,total_size,file_count,create_time,current}]}
func (s *Server) HandleGameSaveHistory(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法")
		return
	}
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		adminJSON(w, map[string]interface{}{"exists": false, "slot": slot, "current_revision": 0, "revisions": []interface{}{}})
		return
	}
	var revs []model.GameSaveRev
	store.DB.Where("save_id = ?", save.ID).Order("revision DESC").Find(&revs)
	list := make([]map[string]interface{}, 0, len(revs))
	for _, rv := range revs {
		list = append(list, map[string]interface{}{
			"revision":    rv.Revision,
			"total_size":  rv.TotalSize,
			"file_count":  rv.FileCount,
			"create_time": rv.CreateTime.Format("2006-01-02 15:04"),
			"current":     rv.Revision == save.Revision,
		})
	}
	adminJSON(w, map[string]interface{}{
		"exists": true, "slot": slot, "current_revision": save.Revision, "revisions": list,
	})
}

// HandleGameSaveRollback 云存档版本回滚 POST /api/game/save/rollback/{id}?username=&slot=（body {revision:N}）
// 以历史修订快照重建当前清单（对象须仍可用），并 revision+1 形成新修订（原版本保留不丢）；返回 {ok,revision}
func (s *Server) HandleGameSaveRollback(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	slot := gameSaveSlotClean(r.URL.Query().Get("slot"))
	if slot == "" {
		adminFail(w, http.StatusBadRequest, "slot 非法")
		return
	}
	var req struct {
		Revision int64 `json:"revision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	// 存档组互斥：回滚（以历史快照重建清单）与上传/定稿/删除串行化
	saveLock := gameSaveLockFor(username, gid, slot)
	saveLock.Lock()
	defer saveLock.Unlock()
	var save model.GameSave
	if err := store.DB.Where("username = ? AND game_id = ? AND slot = ?", username, gid, slot).First(&save).Error; err != nil {
		adminFail(w, http.StatusNotFound, "云存档不存在")
		return
	}
	var rev model.GameSaveRev
	if err := store.DB.Where("save_id = ? AND revision = ?", save.ID, req.Revision).First(&rev).Error; err != nil {
		adminFail(w, http.StatusNotFound, "该历史版本已不可用（可能已被保留策略清理）")
		return
	}
	newRev, err := s.gameSaveCommit(save, gameSaveParseSnapshot(rev.Files))
	if err != nil {
		adminFail(w, http.StatusConflict, err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true, "revision": newRev, "restored_from": req.Revision})
}

// HandleGameSaveSlots 云存档槽位列表 GET /api/game/save/slots/{id}?username=
// 返回该用户对该游戏的全部槽位：{slots:[{slot,revision,total_size,file_count,update_time}]}（按更新时间降序）
func (s *Server) HandleGameSaveSlots(w http.ResponseWriter, r *http.Request) {
	if !s.gameSaveEnabled(w) {
		return
	}
	username, gid, ok := s.gameSaveAccess(w, r)
	if !ok {
		return
	}
	var saves []model.GameSave
	store.DB.Where("username = ? AND game_id = ?", username, gid).Order("update_time DESC").Find(&saves)
	list := make([]map[string]interface{}, 0, len(saves))
	for _, sv := range saves {
		list = append(list, map[string]interface{}{
			"slot":        sv.Slot,
			"revision":    sv.Revision,
			"total_size":  sv.TotalSize,
			"file_count":  sv.FileCount,
			"update_time": sv.UpdateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"slots": list})
}
