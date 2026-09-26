package server

// 阶段一百六十六：网盘上传扩展名黑名单后台设置（GET/PUT /admin/api/drive/blockexts）
// 黑名单归口 drive.go（driveBlockExts，网盘 API 上传与挂载盘 WebDAV 写入共用）；
// 保存即热生效 + 落库重启不丢，刻意不回写 config.yaml（注释会丢）：
// yaml 启动值仅作 DB 无记录时的初始默认（与历史压缩设置同策略）

import (
	"encoding/json"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleAdminDriveBlockExtsGet GET：当前生效黑名单（原始串/是否默认/内置默认值/来源标注）
// + ELF 检测开关 + 处置模式（rename=自动加 .im 隔离保存 / deny=直接拦截 403）
func (s *Server) handleAdminDriveBlockExtsGet(w http.ResponseWriter, r *http.Request) {
	raw, source := s.driveBlockExtsSnapshot()
	mode := "deny"
	if s.driveBlockRename() {
		mode = "rename"
	}
	adminJSON(w, map[string]interface{}{
		"exts":       raw,
		"is_default": raw == "",
		"default":    strings.Join(driveDefaultBlockExts, ","),
		"source":     source, // override=后台设置（DB 真源）/ config=config.yaml 初始默认
		"elf":        s.driveBlockElf(),
		"mode":       mode,
	})
}

// handleAdminDriveBlockExtsSave PUT：保存黑名单（空串=恢复内置默认；非空逐项校验后归一存储）与
// ELF 魔数检测开关、处置模式（均 nil=不修改）。保存即热生效返回生效值。
// 请求体 {"exts": ".exe,.msi", "elf": true, "mode": "rename"}
func (s *Server) handleAdminDriveBlockExtsSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ext  string  `json:"exts"`
		Elf  *bool   `json:"elf"`  // nil=不修改 ELF 检测开关（部分更新语义）
		Mode *string `json:"mode"` // "rename"=隔离改名 / "deny"=拦截；nil=不修改
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.Mode != nil && *req.Mode != "rename" && *req.Mode != "deny" {
		adminFail(w, http.StatusBadRequest, "处置模式取值错误")
		return
	}
	raw := strings.TrimSpace(req.Ext)
	parts := make([]string, 0, 8)
	if raw != "" {
		for _, e := range strings.Split(raw, ",") {
			e = strings.ToLower(strings.TrimSpace(e))
			e = strings.TrimPrefix(e, ".")
			// 逐项校验：1-10 位字母数字（.exe/.msi/.ps1 形态），防止写入空项/超长/特殊字符
			if e == "" || len(e) > 10 {
				adminFail(w, http.StatusBadRequest, "扩展名格式错误: "+e)
				return
			}
			for _, c := range e {
				if !('a' <= c && c <= 'z' || '0' <= c && c <= '9') {
					adminFail(w, http.StatusBadRequest, "扩展名仅支持字母数字: "+e)
					return
				}
			}
			parts = append(parts, "."+e)
		}
	}
	norm := strings.Join(parts, ",")
	if err := s.driveSetBlockExts(norm); err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
		return
	}
	elfNow := s.driveBlockElf()
	if req.Elf != nil && *req.Elf != elfNow {
		if err := s.driveSetBlockElf(*req.Elf); err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
			return
		}
		elfNow = *req.Elf
	}
	modeNow := s.driveBlockRename()
	if req.Mode != nil && (*req.Mode == "rename") != modeNow {
		if err := s.driveSetBlockMode(*req.Mode == "rename"); err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
			return
		}
		modeNow = *req.Mode == "rename"
	}
	shown := norm
	if shown == "" {
		shown = "内置默认"
	}
	modeName := "deny"
	if modeNow {
		modeName = "rename"
	}
	logger.Info("后台管理：管理员 %s 修改网盘上传黑名单（%s，ELF检测 %v，处置 %s）", adminUserFromCtx(r), shown, elfNow, modeName)
	adminJSON(w, map[string]interface{}{"ok": true, "exts": norm, "elf": elfNow, "mode": modeName})
}

// ===== 阶段一百六十七：文件存储管理（全站文件/分享统一管理视图） =====
// 数据归口：列表与统计直查 model.DriveFile / model.DriveShare（回收站经 Unscoped 归口）；
// 删除/还原复用 drive.go 现有归口（driveDeleteOne 软删级联 / driveTrashSubtree 子树圈定 /
// drivePurgeObjects 零拷贝引用计数 / driveRestoreName 同名改名），杜绝旁路重写；
// 分享状态口径复用 drive_share.go driveShareInvalidReason（取消/过期/源文件删除三态）

// handleAdminDriveStats GET /admin/api/drive/stats 存储总览
// 全部聚合直查（DriveFile 普通查询自动排除回收站；回收站 Unscoped 显式圈定），前端零计算
func (s *Server) handleAdminDriveStats(w http.ResponseWriter, r *http.Request) {
	var fileCount, userCount, totalSize, trashCount, trashSize, shareTotal int64
	store.DB.Model(&model.DriveFile{}).Where("is_dir = ?", false).Count(&fileCount)
	store.DB.Model(&model.DriveFile{}).Where("is_dir = ?", false).Select("COALESCE(SUM(size),0)").Scan(&totalSize)
	store.DB.Model(&model.DriveFile{}).Distinct("owner").Count(&userCount)
	store.DB.Unscoped().Model(&model.DriveFile{}).Where("is_dir = ? AND deleted_at IS NOT NULL", false).Count(&trashCount)
	store.DB.Unscoped().Model(&model.DriveFile{}).Where("is_dir = ? AND deleted_at IS NOT NULL", false).
		Select("COALESCE(SUM(size),0)").Scan(&trashSize)
	store.DB.Model(&model.DriveShare{}).Count(&shareTotal)
	backend := "未知"
	if st := store.GetObjectStore(); st != nil {
		backend = st.Kind()
	}
	adminJSON(w, map[string]interface{}{
		"file_count": fileCount, "user_count": userCount, "total_size": totalSize,
		"trash_count": trashCount, "trash_size": trashSize,
		"share_total": shareTotal, "backend": backend,
	})
}

// adminDriveFileRow 文件列表行（独立出参结构：deleted_at 以标准 time 输出 + 关联计数，前端零拼装）
type adminDriveFileRow struct {
	ID         uint       `json:"id"`
	Owner      string     `json:"owner"`
	Name       string     `json:"name"`
	Size       int64      `json:"size"`
	MimeType   string     `json:"mime_type"`
	CreateTime time.Time  `json:"create_time"`
	UpdateTime time.Time  `json:"update_time"`
	DeletedAt  *time.Time `json:"deleted_at"` // 非空=回收站内
	ShareCount int64      `json:"share_count"`
	RefCount   int64      `json:"ref_count"` // 同 object_key 全表引用数（秒传/受让副本共享同一对象）
}

// handleAdminDriveFiles GET /admin/api/drive/files 全站文件平铺列表（仅文件，目录不占存储）
// 参数：page/page_size（≤100）、keyword（文件名模糊）、owner（归属用户模糊）、
// trash=1（回收站）、shared=1（存在任一分享记录）、sort=time_desc|time_asc|size_desc|size_asc。
// 每行附带 share_count（关联分享条数）与 ref_count（Unscoped 全表同 key 引用数——
// 秒传副本/分享受让副本共享对象的可视化归口）
func (s *Server) handleAdminDriveFiles(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	q := store.DB.Model(&model.DriveFile{}).Where("is_dir = ?", false)
	if r.URL.Query().Get("trash") == "1" {
		q = q.Unscoped().Where("deleted_at IS NOT NULL")
	}
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		q = q.Where("name LIKE ?", "%"+kw+"%")
	}
	if ow := strings.TrimSpace(r.URL.Query().Get("owner")); ow != "" {
		q = q.Where("owner LIKE ?", "%"+ow+"%")
	}
	if r.URL.Query().Get("shared") == "1" {
		q = q.Where("EXISTS (SELECT 1 FROM im_drive_share s WHERE s.file_id = im_drive_file.id)")
	}
	switch r.URL.Query().Get("sort") {
	case "time_asc":
		q = q.Order("create_time ASC, id ASC")
	case "size_desc":
		q = q.Order("size DESC, id DESC")
	case "size_asc":
		q = q.Order("size ASC, id ASC")
	default:
		q = q.Order("create_time DESC, id DESC")
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询文件失败")
		return
	}
	var files []model.DriveFile
	if err := q.Offset((page - 1) * pageSize).Limit(pageSize).Find(&files).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询文件失败")
		return
	}
	// 批量关联计数（页内两次 GROUP BY，杜绝逐行 N+1）
	ids := make([]uint, 0, len(files))
	keys := make([]string, 0, len(files))
	for _, f := range files {
		ids = append(ids, f.ID)
		if f.ObjectKey != "" {
			keys = append(keys, f.ObjectKey)
		}
	}
	shareMap := map[uint]int64{}
	if len(ids) > 0 {
		var srows []struct {
			FID uint
			C   int64
		}
		store.DB.Model(&model.DriveShare{}).Select("file_id AS fid, COUNT(*) AS c").
			Where("file_id IN ?", ids).Group("file_id").Scan(&srows)
		for _, sr := range srows {
			shareMap[sr.FID] = sr.C
		}
	}
	refMap := map[string]int64{}
	if len(keys) > 0 {
		var krows []struct {
			Key string
			C   int64
		}
		// Unscoped 全表统计：回收站与受让副本同样占用对象本体，均计入引用数（与 drivePurgeObjects 同口径）
		store.DB.Unscoped().Model(&model.DriveFile{}).Select("object_key AS `key`, COUNT(*) AS c").
			Where("object_key IN ?", keys).Group("object_key").Scan(&krows)
		for _, kr := range krows {
			refMap[kr.Key] = kr.C
		}
	}
	rows := make([]adminDriveFileRow, 0, len(files))
	for _, f := range files {
		row := adminDriveFileRow{
			ID: f.ID, Owner: f.Owner, Name: f.Name, Size: f.Size, MimeType: f.MimeType,
			CreateTime: f.CreateTime, UpdateTime: f.UpdateTime,
			ShareCount: shareMap[f.ID], RefCount: refMap[f.ObjectKey],
		}
		if f.DeletedAt.Valid {
			t := f.DeletedAt.Time
			row.DeletedAt = &t
		}
		rows = append(rows, row)
	}
	adminJSON(w, map[string]interface{}{"list": rows, "total": total, "page": page, "page_size": pageSize})
}

// handleAdminDriveDelete POST /admin/api/drive/delete {ids:[], purge:false}
// purge=false 移入回收站（复用 driveDeleteOne：目录级联整树软删，已在回收站的项跳过）；
// purge=true 物理删除（alive 目录先级联软删再整树圈定，否则 driveTrashSubtree 收不到存活子孙；
// 文件单条圈定），对象本体经 drivePurgeObjects 零拷贝引用计数归口——同 key 仍被其他记录
// 引用（秒传副本/受让副本）则只清元数据保住共享对象，=1 才物理删除存储对象
func (s *Server) handleAdminDriveDelete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs   []uint `json:"ids"`
		Purge bool   `json:"purge"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if len(body.IDs) > 200 {
		adminFail(w, http.StatusBadRequest, "单次最多操作 200 项")
		return
	}
	deleted, purged := 0, 0
	for _, id := range body.IDs {
		var rec model.DriveFile
		// Unscoped 查：回收站项同样可彻底删除；不存在的 id 跳过不阻断整批
		if err := store.DB.Unscoped().Where("id = ?", id).First(&rec).Error; err != nil {
			continue
		}
		if body.Purge {
			if rec.IsDir && !rec.DeletedAt.Valid {
				s.driveDeleteOne(rec.Owner, &rec) // alive 目录先级联软删，整树再圈定
			}
			ids, fileKeys := driveTrashSubtree(&rec)
			store.DB.Unscoped().Where("id IN ?", ids).Delete(&model.DriveFile{})
			purged += s.drivePurgeObjects(ids, fileKeys)
			deleted++
			logger.Info("后台管理：管理员 %s 彻底删除 owner=%s id=%d (%s), 整树 %d 项", adminUserFromCtx(r), rec.Owner, rec.ID, rec.Name, len(ids))
		} else {
			if rec.DeletedAt.Valid {
				continue // 已在回收站，无需重复删除
			}
			deleted += s.driveDeleteOne(rec.Owner, &rec)
		}
	}
	logger.Info("后台管理：管理员 %s 文件删除（彻底=%v）请求 %d 项，删记录 %d 条，清对象 %d 个", adminUserFromCtx(r), body.Purge, len(body.IDs), deleted, purged)
	adminJSON(w, map[string]interface{}{"deleted": deleted, "purged": purged})
}

// handleAdminDriveRestore POST /admin/api/drive/restore {ids:[]}
// 复用用户端回收站还原语义：沿父链上溯定位最顶端软删祖先整树还原（文件在已删目录内时
// 连带还原整棵，杜绝悬空引用）；父目录存活原位放回（同名自动改名 driveRestoreName）、
// 已物理缺失移根兜底
func (s *Server) handleAdminDriveRestore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []uint `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if len(body.IDs) > 200 {
		adminFail(w, http.StatusBadRequest, "单次最多操作 200 项")
		return
	}
	restored := 0
	for _, id := range body.IDs {
		var rec model.DriveFile
		// 须为回收站内记录（存活/不存在一律跳过）
		if err := store.DB.Unscoped().Where("id = ?", id).First(&rec).Error; err != nil || !rec.DeletedAt.Valid {
			continue
		}
		// 上溯最顶端软删祖先（环防 64 层，与 driveCycleHit 同水位）
		root := rec
		cur := rec
		for i := 0; i < 64 && cur.ParentID > 0; i++ {
			var p model.DriveFile
			if err := store.DB.Unscoped().Where("id = ?", cur.ParentID).First(&p).Error; err != nil || !p.DeletedAt.Valid {
				break // 父级存活或已物理缺失：root 即当前定位
			}
			root = p
			cur = p
		}
		// 落位归口（与 handleDriveTrashRestore 同水位）：父存活原位恢复；父缺失移根
		targetParent := root.ParentID
		if targetParent > 0 {
			var p model.DriveFile
			if err := store.DB.Unscoped().Where("id = ?", targetParent).First(&p).Error; err != nil || p.DeletedAt.Valid {
				targetParent = 0
			}
		}
		patch := map[string]interface{}{}
		if targetParent != root.ParentID {
			patch["parent_id"] = targetParent
		}
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
			root.Owner, targetParent, root.Name).Count(&cnt)
		if cnt > 0 {
			patch["name"] = driveRestoreName(root.Owner, targetParent, root.Name, root.IsDir)
		}
		if len(patch) > 0 {
			store.DB.Unscoped().Model(&root).UpdateColumns(patch)
		}
		// 整棵软删子树恢复：deleted_at 置 NULL（Unscoped 绕过软删过滤直达软删行）
		ids, _ := driveTrashSubtree(&root)
		if err := store.DB.Unscoped().Model(&model.DriveFile{}).Where("id IN ?", ids).
			UpdateColumn("deleted_at", nil).Error; err != nil {
			continue
		}
		restored++
		logger.Info("后台管理：管理员 %s 还原 owner=%s id=%d (%s), 整树 %d 项", adminUserFromCtx(r), root.Owner, root.ID, root.Name, len(ids))
	}
	logger.Info("后台管理：管理员 %s 回收站还原请求 %d 项，还原 %d 项", adminUserFromCtx(r), len(body.IDs), restored)
	adminJSON(w, map[string]interface{}{"restored": restored})
}

// adminShareRow 分享列表行（driveShareClient 字段平铺 + state 四态归口，供筛选与徽标着色）
type adminShareRow struct {
	driveShareClient
	State string `json:"state"` // valid 有效 / canceled 已取消 / expired 已过期 / deleted 源文件已删除
}

// handleAdminDriveShares GET /admin/api/drive/shares 全站分享列表
// 参数：page/page_size（≤100）、keyword（分享人/文件名模糊）、status=valid|canceled|expired|deleted。
// state 由服务端归口计算（canceled/expired 走 SQL 条件，deleted 经存活文件 EXISTS 判定），
// 行内统计/链接复用 driveShareToClient
func (s *Server) handleAdminDriveShares(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	q := store.DB.Model(&model.DriveShare{})
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		q = q.Where("owner LIKE ? OR file_name LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	now := time.Now().Unix()
	// 源文件存活判定（与 driveShareInvalidReason 的 driveOwnFile 同口径：owner+id 存活记录）
	aliveFile := "EXISTS (SELECT 1 FROM im_drive_file f WHERE f.id = im_drive_share.file_id AND f.owner = im_drive_share.owner AND f.deleted_at IS NULL)"
	switch r.URL.Query().Get("status") {
	case "valid":
		q = q.Where("canceled = 0 AND (expire_at = 0 OR expire_at > ?) AND "+aliveFile, now)
	case "canceled":
		q = q.Where("canceled = 1")
	case "expired":
		q = q.Where("canceled = 0 AND expire_at > 0 AND expire_at <= ?", now)
	case "deleted":
		q = q.Where("canceled = 0 AND (expire_at = 0 OR expire_at > ?) AND NOT "+aliveFile, now)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询分享失败")
		return
	}
	var shares []model.DriveShare
	if err := q.Order("create_time DESC, id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&shares).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询分享失败")
		return
	}
	list := make([]adminShareRow, 0, len(shares))
	for i := range shares {
		sh := &shares[i]
		row := adminShareRow{driveShareClient: driveShareToClient(s, sh, false)}
		switch {
		case sh.Canceled:
			row.State = "canceled"
		case sh.ExpireAt > 0 && now > sh.ExpireAt:
			row.State = "expired"
		default:
			if _, err := s.driveOwnFile(sh.FileID, sh.Owner); err != nil {
				row.State = "deleted"
			} else {
				row.State = "valid"
			}
		}
		list = append(list, row)
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "page_size": pageSize})
}

// handleAdminDriveShareCancel POST /admin/api/drive/share/cancel {ids:[]}
// 管理员强制取消（与分享者本人取消同水位：canceled=1 后链接与卡片立即失效，
// 分享页即时提示"分享已取消"；已取消项自动跳过不重复计数）
func (s *Server) handleAdminDriveShareCancel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs []uint `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	// 批量上限与 delete/restore 同水位（≤200 项），防止超长 IN 列表
	if len(body.IDs) > 200 {
		adminFail(w, http.StatusBadRequest, "单次最多操作 200 项")
		return
	}
	res := store.DB.Model(&model.DriveShare{}).Where("id IN ? AND canceled = 0", body.IDs).UpdateColumn("canceled", true)
	logger.Info("后台管理：管理员 %s 强制取消分享 %d 条（请求 %d 项）", adminUserFromCtx(r), res.RowsAffected, len(body.IDs))
	adminJSON(w, map[string]interface{}{"canceled": res.RowsAffected})
}
