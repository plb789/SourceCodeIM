// 阶段二百八十九：云存档 P1（单设备闭环）用户端接口集成测试（真实 MySQL + 对象存储）。
// 覆盖：上传→清单→下载→定稿(revision+1)→删除 全链路，以及 sha 校验不一致被拒。
// 环境：TestMain 已锚定 bin/config.yaml 初始化 MySQL；无库/对象存储不可用时本用例跳过。
package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

const (
	gsTestUser = "gamesave_test_u"
	gsTestGid  = 999999
)

// gsRoutesOnce 路由注册守卫：RegisterGameRoutes 走全局 http.DefaultServeMux，
// 多个测试用例重复注册同一 pattern 会 panic（Go 1.22 ServeMux 冲突检测），故全测试进程仅注册一次
var gsRoutesOnce sync.Once

// gsEnsureRoutes 幂等注册游戏路由（首个用例绑定的 Server 实例，后续用例复用同款 cfg 实例等价）
func gsEnsureRoutes(s *Server) {
	gsRoutesOnce.Do(func() { RegisterGameRoutes(s) })
}

type gsEnvelope struct {
	Ok   bool            `json:"ok"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

type gsManifest struct {
	Exists    bool  `json:"exists"`
	Revision  int64 `json:"revision"`
	TotalSize int64 `json:"total_size"`
	FileCount int   `json:"file_count"`
	Files     []struct {
		ID       uint   `json:"id"`
		RelPath  string `json:"rel_path"`
		Size     int64  `json:"size"`
		SHA256   string `json:"sha256"`
		URL      string `json:"url"`
		ObjKeyLe string `json:"object_key"` // 期望恒为空（模型 json:"-" 不外泄）
	} `json:"files"`
}

func gsCleanup() {
	var saves []model.GameSave
	store.DB.Where("username = ? AND game_id = ?", gsTestUser, gsTestGid).Find(&saves)
	st := store.GetObjectStore()
	for _, save := range saves {
		var files []model.GameSaveFile
		store.DB.Where("save_id = ?", save.ID).Find(&files)
		var revs []model.GameSaveRev
		store.DB.Where("save_id = ?", save.ID).Find(&revs)
		// 对象：存活清单行 ∪ 修订快照里的 sha（与生产删除口径一致）
		shas := map[string]bool{}
		for _, f := range files {
			if f.SHA256 != "" {
				shas[f.SHA256] = true
			}
		}
		for _, r := range revs {
			var list []gameSaveSnapshotFile
			_ = json.Unmarshal([]byte(r.Files), &list)
			for _, x := range list {
				if x.SHA256 != "" {
					shas[x.SHA256] = true
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
	store.DB.Where("username = ? AND game_id = ?", gsTestUser, gsTestGid).Delete(&model.GameLibrary{})
}

// gsDo 发请求返回 (状态码, 响应体)；非 2xx 不视为失败（由用例断言）
func gsDo(t *testing.T, method, fullURL string, body []byte, ctype string) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, fullURL, rdr)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败 %s %s：%v", method, fullURL, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// gsData 断言 2xx 并解出 adminJSON 包络中的 data
func gsData(t *testing.T, method, fullURL string, body []byte, ctype string, out interface{}) {
	t.Helper()
	status, resp := gsDo(t, method, fullURL, body, ctype)
	if status < 200 || status >= 300 {
		t.Fatalf("%s %s 期望 2xx，实际 %d：%s", method, fullURL, status, resp)
	}
	var env gsEnvelope
	if err := json.Unmarshal(resp, &env); err != nil {
		t.Fatalf("响应解析失败：%v（%s）", err, resp)
	}
	if !env.Ok {
		t.Fatalf("业务失败：%s", env.Msg)
	}
	if out != nil {
		if err := json.Unmarshal(env.Data, out); err != nil {
			t.Fatalf("data 解析失败：%v（%s）", err, string(env.Data))
		}
	}
}

func gsManifestOf(t *testing.T, base, user string, gid int) gsManifest {
	t.Helper()
	q := url.Values{}
	q.Set("username", user)
	full := base + "/api/game/save/manifest/" + strconv.Itoa(gid) + "?" + q.Encode()
	var man gsManifest
	gsData(t, "GET", full, nil, "", &man)
	return man
}

func TestGameSaveP1Flow(t *testing.T) {
	cfg := config.Load()
	if !cfg.Game.Enabled || !cfg.Game.Save.Enabled {
		t.Skip("游戏中心或云存档未启用，跳过")
	}
	if err := store.InitDriveStore(cfg); err != nil {
		t.Skipf("对象存储不可用，跳过：%v", err)
	}
	InitGame(cfg) // 幂等：补齐云存档两表（生产由 main 调用）
	s := NewServer(cfg)
	gsEnsureRoutes(s)
	ts := httptest.NewServer(http.DefaultServeMux)
	defer ts.Close()

	// 预置库归属（gameSaveAccess 要求该用户名对本 game 已入库）
	gsCleanup()
	if err := store.DB.Create(&model.GameLibrary{Username: gsTestUser, GameID: gsTestGid, State: 3}).Error; err != nil {
		t.Fatalf("预置游戏库失败：%v", err)
	}
	defer gsCleanup()

	gidStr := strconv.Itoa(gsTestGid)
	content := []byte("cloud-save-p1-payload-测试内容-2026")
	sum := sha256.Sum256(content)
	sha := hex.EncodeToString(sum[:])
	relPath := "0/save01.sav"

	// 1) 上传单文件（原始字节流）
	uq := url.Values{}
	uq.Set("username", gsTestUser)
	uq.Set("slot", "")
	uq.Set("rel_path", relPath)
	uq.Set("sha256", sha)
	uq.Set("size", strconv.Itoa(len(content)))
	var up struct {
		Ok     bool `json:"ok"`
		FileID uint `json:"file_id"`
	}
	gsData(t, "POST", ts.URL+"/api/game/save/file/"+gidStr+"?"+uq.Encode(), content, "application/octet-stream", &up)
	if !up.Ok || up.FileID == 0 {
		t.Fatalf("上传应返回 file_id，实际：%+v", up)
	}

	// 2) 清单：1 文件、哈希一致、object_key 不外泄
	man := gsManifestOf(t, ts.URL, gsTestUser, gsTestGid)
	if !man.Exists || man.FileCount != 1 || len(man.Files) != 1 {
		t.Fatalf("清单应为 1 文件：%+v", man)
	}
	if man.Files[0].RelPath != relPath || man.Files[0].SHA256 != sha || man.Files[0].Size != int64(len(content)) {
		t.Fatalf("清单元数据不符：%+v", man.Files[0])
	}
	if man.Files[0].ObjKeyLe != "" {
		t.Fatalf("object_key 不应外泄：%q", man.Files[0].ObjKeyLe)
	}

	// 3) 下载：字节一致
	dlURL := ts.URL + "/api/game/save/download/" + strconv.Itoa(int(up.FileID)) + "?username=" + gsTestUser
	status, dl := gsDo(t, "GET", dlURL, nil, "")
	if status != 200 || !bytes.Equal(dl, content) {
		t.Fatalf("下载内容不一致（status=%d）：%q", status, dl)
	}

	// 4) 定稿（保留该文件）→ revision=1
	fq := url.Values{}
	fq.Set("username", gsTestUser)
	fq.Set("slot", "")
	var fin struct {
		Ok       bool  `json:"ok"`
		Revision int64 `json:"revision"`
	}
	gsData(t, "POST", ts.URL+"/api/game/save/finalize/"+gidStr+"?"+fq.Encode(),
		[]byte(`{"rel_paths":["0/save01.sav"]}`), "application/json", &fin)
	if !fin.Ok || fin.Revision != 1 {
		t.Fatalf("定稿应 revision=1：%+v", fin)
	}

	// 5) sha 校验不一致 → 400（不信任客户端声明）
	bq := url.Values{}
	bq.Set("username", gsTestUser)
	bq.Set("slot", "")
	bq.Set("rel_path", "0/bad.sav")
	bq.Set("sha256", strings.Repeat("0", 64))
	bq.Set("size", strconv.Itoa(len(content)))
	badStatus, _ := gsDo(t, "POST", ts.URL+"/api/game/save/file/"+gidStr+"?"+bq.Encode(), content, "application/octet-stream")
	if badStatus != http.StatusBadRequest {
		t.Fatalf("错误 sha 应 400，实际 %d", badStatus)
	}

	// 6) 删除云存档 → 清单不存在
	dq := url.Values{}
	dq.Set("username", gsTestUser)
	dq.Set("slot", "")
	var del struct {
		Ok bool `json:"ok"`
	}
	gsData(t, "DELETE", ts.URL+"/api/game/save/data/"+gidStr+"?"+dq.Encode(), nil, "", &del)
	if !del.Ok {
		t.Fatalf("删除应成功")
	}
	if after := gsManifestOf(t, ts.URL, gsTestUser, gsTestGid); after.Exists {
		t.Fatalf("删除后清单应不存在：%+v", after)
	}
}

// ===== 阶段二百九十：云存档 P2（版本保留 + 回滚）与 P3（多槽位）集成测试 =====

func gsUpload(t *testing.T, base string, user string, gid int, slot, relPath string, content []byte) uint {
	t.Helper()
	sum := sha256.Sum256(content)
	q := url.Values{}
	q.Set("username", user)
	q.Set("slot", slot)
	q.Set("rel_path", relPath)
	q.Set("sha256", hex.EncodeToString(sum[:]))
	q.Set("size", strconv.Itoa(len(content)))
	var up struct {
		Ok     bool `json:"ok"`
		FileID uint `json:"file_id"`
	}
	gsData(t, "POST", base+"/api/game/save/file/"+strconv.Itoa(gid)+"?"+q.Encode(), content, "application/octet-stream", &up)
	if !up.Ok || up.FileID == 0 {
		t.Fatalf("上传失败：%+v", up)
	}
	return up.FileID
}

func gsFinalize(t *testing.T, base, user string, gid int, slot string, rels []string) int64 {
	t.Helper()
	q := url.Values{}
	q.Set("username", user)
	q.Set("slot", slot)
	b, _ := json.Marshal(map[string]interface{}{"rel_paths": rels})
	var fin struct {
		Ok       bool  `json:"ok"`
		Revision int64 `json:"revision"`
	}
	gsData(t, "POST", base+"/api/game/save/finalize/"+strconv.Itoa(gid)+"?"+q.Encode(), b, "application/json", &fin)
	if !fin.Ok {
		t.Fatalf("定稿失败")
	}
	return fin.Revision
}

type gsHistory struct {
	Exists          bool  `json:"exists"`
	CurrentRevision int64 `json:"current_revision"`
	Revisions       []struct {
		Revision   int64  `json:"revision"`
		TotalSize  int64  `json:"total_size"`
		FileCount  int    `json:"file_count"`
		CreateTime string `json:"create_time"`
		Current    bool   `json:"current"`
	} `json:"revisions"`
}

func TestGameSaveP2RetentionRollbackSlots(t *testing.T) {
	cfg := config.Load()
	if !cfg.Game.Enabled || !cfg.Game.Save.Enabled {
		t.Skip("游戏中心或云存档未启用，跳过")
	}
	if err := store.InitDriveStore(cfg); err != nil {
		t.Skipf("对象存储不可用，跳过：%v", err)
	}
	InitGame(cfg) // 幂等：补齐云存档（含修订）表
	s := NewServer(cfg)
	gsEnsureRoutes(s)
	ts := httptest.NewServer(http.DefaultServeMux)
	defer ts.Close()

	gsCleanup()
	if err := store.DB.Create(&model.GameLibrary{Username: gsTestUser, GameID: gsTestGid, State: 3}).Error; err != nil {
		t.Fatalf("预置游戏库失败：%v", err)
	}
	defer gsCleanup()

	gid := gsTestGid
	rel := "0/save01.sav"
	retention := cfg.Game.Save.Retention
	if retention <= 0 {
		retention = 5
	}
	// 迭代 retention+2 次修订（每次换内容），触发最早的修订被裁剪
	rounds := retention + 2
	contents := make([][]byte, 0, rounds)
	var lastRev int64
	for i := 1; i <= rounds; i++ {
		c := []byte("payload-v" + strconv.Itoa(i) + "-云存档内容")
		contents = append(contents, c)
		gsUpload(t, ts.URL, gsTestUser, gid, "", rel, c)
		lastRev = gsFinalize(t, ts.URL, gsTestUser, gid, "", []string{rel})
		if lastRev != int64(i) {
			t.Fatalf("第 %d 次定稿应 revision=%d，实际 %d", i, i, lastRev)
		}
	}

	// 历史：保留窗口内条数=retention、最新=当前修订
	var hist gsHistory
	hq := url.Values{}
	hq.Set("username", gsTestUser)
	hq.Set("slot", "")
	gsData(t, "GET", ts.URL+"/api/game/save/history/"+strconv.Itoa(gid)+"?"+hq.Encode(), nil, "", &hist)
	if !hist.Exists || hist.CurrentRevision != lastRev {
		t.Fatalf("历史当前修订应为 %d：%+v", lastRev, hist)
	}
	if len(hist.Revisions) != retention {
		t.Fatalf("保留窗口应为 %d 条，实际 %d：%+v", retention, len(hist.Revisions), hist.Revisions)
	}
	if hist.Revisions[0].Revision != lastRev || !hist.Revisions[0].Current {
		t.Fatalf("首条应为当前修订 %d：%+v", lastRev, hist.Revisions[0])
	}

	// 已裁剪的最早修订（revision=1）回滚 → 404（版本已清理）
	rbq := url.Values{}
	rbq.Set("username", gsTestUser)
	rbq.Set("slot", "")
	st404, _ := gsDo(t, "POST", ts.URL+"/api/game/save/rollback/"+strconv.Itoa(gid)+"?"+rbq.Encode(), []byte(`{"revision":1}`), "application/json")
	if st404 != http.StatusNotFound {
		t.Fatalf("回滚已裁剪版本应 404，实际 %d", st404)
	}

	// 回滚到 revision=3 → 新修订 = lastRev+1，清单/下载内容应为第 3 版
	target := int64(3)
	var rb struct {
		Ok       bool  `json:"ok"`
		Revision int64 `json:"revision"`
	}
	gsData(t, "POST", ts.URL+"/api/game/save/rollback/"+strconv.Itoa(gid)+"?"+rbq.Encode(),
		[]byte(`{"revision":3}`), "application/json", &rb)
	if !rb.Ok || rb.Revision != lastRev+1 {
		t.Fatalf("回滚应产生修订 %d：%+v", lastRev+1, rb)
	}
	man := gsManifestOf(t, ts.URL, gsTestUser, gid)
	sum3 := sha256.Sum256(contents[target-1])
	if !man.Exists || len(man.Files) != 1 || man.Files[0].SHA256 != hex.EncodeToString(sum3[:]) {
		t.Fatalf("回滚后清单应为第 3 版内容：%+v", man)
	}
	dlURL := ts.URL + "/api/game/save/download/" + strconv.Itoa(int(man.Files[0].ID)) + "?username=" + gsTestUser
	stDl, dl := gsDo(t, "GET", dlURL, nil, "")
	if stDl != 200 || !bytes.Equal(dl, contents[target-1]) {
		t.Fatalf("回滚后下载内容应为第 3 版（status=%d）：%q", stDl, dl)
	}

	// 多槽位：另建槽位 bk1（同 rel_path，独立对象/清单），槽位列表应含 default 与 bk1
	gsUpload(t, ts.URL, gsTestUser, gid, "bk1", rel, []byte("backup-content-备份"))
	gsFinalize(t, ts.URL, gsTestUser, gid, "bk1", []string{rel})
	var slotRes struct {
		Slots []struct {
			Slot     string `json:"slot"`
			Revision int64  `json:"revision"`
		} `json:"slots"`
	}
	sq := url.Values{}
	sq.Set("username", gsTestUser)
	gsData(t, "GET", ts.URL+"/api/game/save/slots/"+strconv.Itoa(gid)+"?"+sq.Encode(), nil, "", &slotRes)
	if len(slotRes.Slots) != 2 {
		t.Fatalf("应有 2 个槽位：%+v", slotRes.Slots)
	}
	found := map[string]bool{}
	for _, sl := range slotRes.Slots {
		found[sl.Slot] = true
	}
	if !found["default"] || !found["bk1"] {
		t.Fatalf("槽位应含 default 与 bk1：%+v", slotRes.Slots)
	}
}
