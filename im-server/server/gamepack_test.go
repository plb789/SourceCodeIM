package server

// ===== 游戏版本 ZIP 打包方式（pack_type）测试归口 =====
// 覆盖：分卷命名校验（gameSplitZipCheck）、单 ZIP 实算与条目安检（gameZipUnpackSize）、
//       版本登记全链路 pack_type 校验（单 ZIP / 分卷 / 非法值 / 缺 pack_size / 命名断档）
// 基建复用 merchant_test.go（merchantTestSeed/dbwServer/merchantTestSeedGame/merchantTestToken）

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"im-server/config"
	"im-server/model"
	"im-server/store"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// buildZipBytes 内存构造 zip（测试用）：entries 为 name→content
func buildZipBytes(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip 条目创建失败: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip 条目写入失败: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip 关闭失败: %v", err)
	}
	return buf.Bytes()
}

// zipUploadSeed 直造一个分片会话（等价于已走完上传通道，Owner=owner），返回 sha256
func zipUploadSeed(t *testing.T, s *Server, owner, uploadID string, data []byte) string {
	t.Helper()
	tmpDir := s.gameTmpDir(uploadID)
	if err := os.MkdirAll(tmpDir, os.ModePerm); err != nil {
		t.Fatalf("临时目录创建失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "0.part"), data, 0644); err != nil {
		t.Fatalf("分片写入失败：%v", err)
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	gameUploadSessions.Lock()
	gameUploadSessions.m[uploadID] = &gameUploadSession{UploadID: uploadID, Owner: owner,
		Kind: "game", Total: 1, FileSize: int64(len(data)),
		Received: map[int]int64{0: int64(len(data))}, CreatedAt: time.Now()}
	gameUploadSessions.Unlock()
	t.Cleanup(func() {
		gameUploadSessions.Lock()
		delete(gameUploadSessions.m, uploadID)
		gameUploadSessions.Unlock()
		os.RemoveAll(tmpDir)
	})
	return sha
}

// registerPackVersion 商户身份走版本登记（pack 参数透传）
func registerPackVersion(t *testing.T, s *Server, token string, gid uint, version string,
	packType int, packSize int64, files []map[string]interface{}) (int, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{
		"version": version, "pack_type": packType, "pack_size": packSize, "files": files,
	})
	req := httptest.NewRequest("POST", "/api/merchant/games/"+fmt.Sprint(gid)+"/version", bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(gid))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionCreate)(rec, req)
	code, resp := gwrUnwrap(rec)
	if resp == nil {
		resp = map[string]interface{}{}
	}
	return code, resp
}

// TestGameSplitZipCheck 分卷命名校验单元测试（纯函数无 DB）
func TestGameSplitZipCheck(t *testing.T) {
	mk := func(paths ...string) []gameUploadItem {
		items := make([]gameUploadItem, 0, len(paths))
		for _, p := range paths {
			items = append(items, gameUploadItem{relPath: p})
		}
		return items
	}
	if err := gameSplitZipCheck(mk("game.zip.001", "game.zip.002", "game.zip.003")); err != nil {
		t.Fatalf("连续分卷应通过: %v", err)
	}
	if err := gameSplitZipCheck(mk("vols/game.zip.001", "vols/game.zip.002")); err != nil {
		t.Fatalf("同目录分卷应通过: %v", err)
	}
	if err := gameSplitZipCheck(mk("game.zip.001", "game.zip.003")); err == nil {
		t.Fatal("序号断档应拒绝")
	}
	if err := gameSplitZipCheck(mk("game.zip.002", "game.zip.003")); err == nil {
		t.Fatal("不从 001 起应拒绝")
	}
	if err := gameSplitZipCheck(mk("game.zip.001", "other.zip.002")); err == nil {
		t.Fatal("前缀不一致应拒绝")
	}
	if err := gameSplitZipCheck(mk("game.zip.001", "game.zip.2")); err == nil {
		t.Fatal("非 3 位序号应拒绝")
	}
	if err := gameSplitZipCheck(mk("a/game.zip.001", "b/game.zip.002")); err == nil {
		t.Fatal("跨目录分卷应拒绝")
	}
	if err := gameSplitZipCheck(mk("game.zip")); err == nil {
		t.Fatal("非分卷命名应拒绝")
	}
}

// TestGameZipUnpackSize 单 ZIP 实算与条目安检
func TestGameZipUnpackSize(t *testing.T) {
	data := buildZipBytes(t, map[string]string{
		"readme.txt": "hello", "bin/launch.exe": "12345678",
	})
	f := filepath.Join(t.TempDir(), "game.zip")
	if err := os.WriteFile(f, data, 0644); err != nil {
		t.Fatalf("写 zip 失败: %v", err)
	}
	size, err := gameZipUnpackSize(f)
	if err != nil {
		t.Fatalf("正常 zip 应解析成功: %v", err)
	}
	if want := int64(len("hello") + len("12345678")); size != want {
		t.Fatalf("解压后总大小应为 %d，实得 %d", want, size)
	}

	// Zip Slip：../ 父目录引用 / 盘符绝对路径 一律拒绝
	for _, bad := range []map[string]string{
		{"../evil.txt": "x"},
		{"dir/../../evil.txt": "x"},
		{"C:\\evil.txt": "x"},
		{"/abs/evil.txt": "x"},
	} {
		p := filepath.Join(t.TempDir(), "bad.zip")
		if err := os.WriteFile(p, buildZipBytes(t, bad), 0644); err != nil {
			t.Fatalf("写坏 zip 失败: %v", err)
		}
		if _, err := gameZipUnpackSize(p); err == nil {
			t.Fatalf("非法条目 %v 应被拒绝", bad)
		}
	}
}

// buildPatchZip 内存构造补丁包：changeFiles 为 change 条目（name→content），meta 为 patch.json 字节
func buildPatchZip(t *testing.T, changeFiles map[string]string, meta []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range changeFiles {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("补丁条目创建失败: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("补丁条目写入失败: %v", err)
		}
	}
	if meta != nil {
		w, err := zw.Create("patch.json")
		if err != nil {
			t.Fatalf("patch.json 条目创建失败: %v", err)
		}
		if _, err := w.Write(meta); err != nil {
			t.Fatalf("patch.json 写入失败: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("补丁包关闭失败: %v", err)
	}
	return buf.Bytes()
}

// registerPatchVersion 商户身份登记补丁版本（pack_type=3，带 base_version）
func registerPatchVersion(t *testing.T, s *Server, token string, gid uint, version, baseVersion string,
	files []map[string]interface{}) (int, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{
		"version": version, "pack_type": 3, "base_version": baseVersion, "files": files,
	})
	req := httptest.NewRequest("POST", "/api/merchant/games/"+fmt.Sprint(gid)+"/version", bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(gid))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionCreate)(rec, req)
	code, resp := gwrUnwrap(rec)
	if resp == nil {
		resp = map[string]interface{}{}
	}
	return code, resp
}

// TestMerchantVersionPatch 补丁版本登记全链路：解包落位 + 合成清单物化 + 校验分支 + 清单导出
func TestMerchantVersionPatch(t *testing.T) {
	if err := store.DB.AutoMigrate(&model.GameVersion{}); err != nil {
		t.Fatalf("GameVersion 迁移失败：%v", err)
	}
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_pt", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	g := merchantTestSeedGame(t, "mtest_pt", "mtest-gpatch", "补丁游戏", model.GameAuditApproved, 0)
	tk := merchantTestToken(t, "mtest_pt")
	t.Cleanup(func() {
		os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gpatch"))
		var vids []uint
		store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Pluck("id", &vids)
		if len(vids) > 0 {
			store.DB.Where("version_id IN ?", vids).Delete(&model.GameFile{})
		}
		store.DB.Where("game_id = ?", g.ID).Delete(&model.GameVersion{})
	})

	// 基底 v1.0.0（散文件 3 文件：keep.txt 保留 / old.txt 删除 / chg.txt 变更）
	shaKeep := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-keep", []byte("KEEP"))
	shaOld := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-old", []byte("OLD"))
	shaChgOld := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-chgold", []byte("OLDCHG"))
	if code, resp := registerPackVersion(t, s, tk, g.ID, "1.0.0", 0, 0, []map[string]interface{}{
		{"rel_path": "keep.txt", "size": 4, "sha256": shaKeep, "upload_id": "mtest-pt-keep"},
		{"rel_path": "old.txt", "size": 3, "sha256": shaOld, "upload_id": "mtest-pt-old"},
		{"rel_path": "chg.txt", "size": 6, "sha256": shaChgOld, "upload_id": "mtest-pt-chgold"},
	}); code != 200 {
		t.Fatalf("基底登记应 200：%d %v", code, resp)
	}

	// 补丁 v1.0.1：变更 chg.txt + 新增 added/new.bin + 删除 old.txt
	patchZip := buildPatchZip(t, map[string]string{
		"chg.txt": "NEWCHG", "added/new.bin": "NEWBIN",
	}, []byte(`{"format":1,"base_version":"1.0.0","version":"1.0.1","change":["added/new.bin","chg.txt"],"delete":["old.txt"]}`))
	shaPatch := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-patch", patchZip)
	code, resp := registerPatchVersion(t, s, tk, g.ID, "1.0.1", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(patchZip), "sha256": shaPatch, "upload_id": "mtest-pt-patch"},
	})
	if code != 200 {
		t.Fatalf("补丁登记应 200：%d %v", code, resp)
	}
	var v1 model.GameVersion
	if err := store.DB.Where("game_id = ? AND version = ?", g.ID, "1.0.1").First(&v1).Error; err != nil {
		t.Fatalf("补丁版本行未登记：%v", err)
	}
	if v1.PackType != 3 || v1.BaseVersion != "1.0.0" || !strings.Contains(v1.PatchDelete, "old.txt") {
		t.Fatalf("补丁版本行不符: type=%d base=%q del=%s", v1.PackType, v1.BaseVersion, v1.PatchDelete)
	}
	// 合成清单断言：keep 继承基底 sha / chg 为新 sha / old.txt 消失 / added 出现
	shaNewChg := hexSha256([]byte("NEWCHG"))
	shaNewBin := hexSha256([]byte("NEWBIN"))
	var rows []model.GameFile
	store.DB.Where("version_id = ?", v1.ID).Order("rel_path ASC").Find(&rows)
	got := map[string]model.GameFile{}
	for _, r := range rows {
		got[r.RelPath] = r
	}
	if len(rows) != 3 {
		t.Fatalf("合成清单应 3 个文件，实得 %d: %+v", len(rows), rows)
	}
	if got["keep.txt"].SHA256 != shaKeep || got["chg.txt"].SHA256 != shaNewChg || got["added/new.bin"].SHA256 != shaNewBin {
		t.Fatalf("合成清单哈希不符: %+v", got)
	}
	if _, exists := got["old.txt"]; exists {
		t.Fatal("删除的 old.txt 不应出现在合成清单")
	}
	if got["chg.txt"].SizeBytes != 6 || got["added/new.bin"].SizeBytes != 6 {
		t.Fatalf("合成清单大小不符: %+v", got)
	}
	if v1.SizeBytes != 4+6+6 {
		t.Fatalf("合成总量应为 16，实得 %d", v1.SizeBytes)
	}
	// 继承条目 StoragePath 必须指向基底版本目录（物理文件在基底，防下载 404）；补丁条目指向本版本
	if got["keep.txt"].StoragePath != "games/mtest-gpatch/1.0.0/keep.txt" {
		t.Fatalf("继承条目 storage 应为基底目录，实得 %q", got["keep.txt"].StoragePath)
	}
	if got["chg.txt"].StoragePath != "games/mtest-gpatch/1.0.1/chg.txt" {
		t.Fatalf("补丁条目 storage 应为本版本目录，实得 %q", got["chg.txt"].StoragePath)
	}
	// 落位文件存在（补丁解包 + patch.json 审计留档）
	if _, err := os.Stat(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gpatch", "1.0.1", "added", "new.bin")); err != nil {
		t.Fatalf("补丁文件未落位：%v", err)
	}
	if _, err := os.Stat(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gpatch", "1.0.1", "patch.json")); err != nil {
		t.Fatalf("patch.json 未审计留档：%v", err)
	}

	// 清单导出接口（补丁版导出的是合成后的最终清单——可作下一层补丁基准）
	reqFL := httptest.NewRequest("GET", "/api/merchant/games/"+fmt.Sprint(g.ID)+"/versions/1.0.1/filelist", nil)
	reqFL.SetPathValue("id", fmt.Sprint(g.ID))
	reqFL.SetPathValue("ver", "1.0.1")
	reqFL.Header.Set("Authorization", "Bearer "+tk)
	recFL := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionFilelist)(recFL, reqFL)
	if recFL.Code != 200 {
		t.Fatalf("清单导出应 200：%d %s", recFL.Code, recFL.Body.String())
	}
	body := recFL.Body.String()
	for _, want := range []string{"0|added/new.bin|" + shaNewBin + "|6", "0|chg.txt|" + shaNewChg + "|6", "0|keep.txt|" + shaKeep + "|4"} {
		if !strings.Contains(body, want) {
			t.Fatalf("导出清单缺行 %q：%s", want, body)
		}
	}
	if strings.Contains(body, "old.txt") {
		t.Fatal("导出清单不应包含已删除文件")
	}
	if !strings.Contains(recFL.Header().Get("Content-Disposition"), "filelist-1.0.1.txt") {
		t.Fatalf("导出文件名不符：%q", recFL.Header().Get("Content-Disposition"))
	}

	// 中文版本号导出：Content-Disposition 须归一为 ASCII（非 ASCII header 值会导致 Go 写出失败）
	shaCn := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-cn", []byte("CNDATA"))
	if code, resp := registerPackVersion(t, s, tk, g.ID, "1.0.中文版", 0, 0, []map[string]interface{}{
		{"rel_path": "cn.txt", "size": 6, "sha256": shaCn, "upload_id": "mtest-pt-cn"},
	}); code != 200 {
		t.Fatalf("中文版本号登记应 200：%d %v", code, resp)
	}
	reqCN := httptest.NewRequest("GET", "/api/merchant/games/"+fmt.Sprint(g.ID)+"/versions/1.0.中文版/filelist", nil)
	reqCN.SetPathValue("id", fmt.Sprint(g.ID))
	reqCN.SetPathValue("ver", "1.0.中文版")
	reqCN.Header.Set("Authorization", "Bearer "+tk)
	recCN := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionFilelist)(recCN, reqCN)
	if recCN.Code != 200 {
		t.Fatalf("中文版本号清单导出应 200：%d %s", recCN.Code, recCN.Body.String())
	}
	cdCN := recCN.Header().Get("Content-Disposition")
	for _, r := range cdCN {
		if r >= 0x80 {
			t.Fatalf("Content-Disposition 含非 ASCII 字符（会导致真实网络写出失败）：%q", cdCN)
		}
	}
	if !strings.Contains(cdCN, "filelist-1.0.___.txt") {
		t.Fatalf("中文版本号文件名未归一：%q", cdCN)
	}
	if !strings.Contains(recCN.Body.String(), "0|cn.txt|"+shaCn+"|6") {
		t.Fatalf("中文版本号清单内容缺失：%s", recCN.Body.String())
	}

	// 校验分支（各独立会话防前序消费）：返回 (会话id, sha, zip字节)
	newPatch := func(meta string, files map[string]string) (string, string, []byte) {
		z := buildPatchZip(t, files, []byte(meta))
		id := "mtest-pt-b" + fmt.Sprint(len(z)) + fmt.Sprint(time.Now().UnixNano())
		sha := zipUploadSeed(t, s, "mtest_pt", id, z)
		return id, sha, z
	}
	// ① 基底不存在 → 404
	idA, shaA, zA := newPatch(`{"format":1,"base_version":"9.9.9","change":["x.txt"],"delete":[]}`, map[string]string{"x.txt": "X"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.0", "9.9.9", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zA), "sha256": shaA, "upload_id": idA},
	}); code != 404 {
		t.Fatalf("基底不存在应 404，实得 %d", code)
	}
	// ② delete 不在基底 → 400
	idB, shaB, zB := newPatch(`{"format":1,"base_version":"1.0.0","change":["chg.txt"],"delete":["nope.txt"]}`, map[string]string{"chg.txt": "N2"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.1", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zB), "sha256": shaB, "upload_id": idB},
	}); code != 400 {
		t.Fatalf("delete 不在基底应 400，实得 %d", code)
	}
	// ③ change 与 zip 条目不一致 → 400
	idC, shaC, zC := newPatch(`{"format":1,"base_version":"1.0.0","change":["chg.txt","ghost.txt"],"delete":[]}`, map[string]string{"chg.txt": "N3"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.2", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zC), "sha256": shaC, "upload_id": idC},
	}); code != 400 {
		t.Fatalf("change 不一致应 400，实得 %d", code)
	}
	// ④ delete ∩ change → 400
	idD, shaD, zD := newPatch(`{"format":1,"base_version":"1.0.0","change":["keep.txt"],"delete":["keep.txt"]}`, map[string]string{"keep.txt": "N4"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.3", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zD), "sha256": shaD, "upload_id": idD},
	}); code != 400 {
		t.Fatalf("delete∩change 应 400，实得 %d", code)
	}
	// ⑤ 恶意路径条目 → 400
	idE, shaE, zE := newPatch(`{"format":1,"base_version":"1.0.0","change":["../evil.txt"],"delete":[]}`, map[string]string{"../evil.txt": "PWN"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.4", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zE), "sha256": shaE, "upload_id": idE},
	}); code != 400 {
		t.Fatalf("恶意路径应 400，实得 %d", code)
	}
	// ⑥ 缺 patch.json → 400
	idF, shaF, zF := newPatch("", map[string]string{"chg.txt": "N6"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.5", "1.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zF), "sha256": shaF, "upload_id": idF},
	}); code != 400 {
		t.Fatalf("缺 patch.json 应 400，实得 %d", code)
	}
	// ⑦ base 是 ZIP 整包版 → 400
	zBase := buildZipBytes(t, map[string]string{"game.exe": "ZIPGAME"})
	shaZB := zipUploadSeed(t, s, "mtest_pt", "mtest-pt-zbase", zBase)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "5.0.0", 1, 0, []map[string]interface{}{
		{"rel_path": "game.zip", "size": len(zBase), "sha256": shaZB, "upload_id": "mtest-pt-zbase"},
	}); code != 200 {
		t.Fatalf("ZIP 整包基底登记应 200：%d", code)
	}
	idG, shaG, zG := newPatch(`{"format":1,"base_version":"5.0.0","change":["x.txt"],"delete":[]}`, map[string]string{"x.txt": "X"})
	if code, _ := registerPatchVersion(t, s, tk, g.ID, "9.0.6", "5.0.0", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zG), "sha256": shaG, "upload_id": idG},
	}); code != 400 {
		t.Fatalf("ZIP 整包版作基底应 400，实得 %d", code)
	}
	// ⑧ 链式补丁：以补丁版 1.0.1 为基底再打一层 → 200，合成结果正确叠加
	idH, shaH, zH := newPatch(`{"format":1,"base_version":"1.0.1","change":["keep.txt"],"delete":[]}`, map[string]string{"keep.txt": "KEEP2"})
	if code, resp := registerPatchVersion(t, s, tk, g.ID, "1.0.2", "1.0.1", []map[string]interface{}{
		{"rel_path": "patch.zip", "size": len(zH), "sha256": shaH, "upload_id": idH},
	}); code != 200 {
		t.Fatalf("链式补丁登记应 200：%d %v", code, resp)
	}
	var v2 model.GameVersion
	store.DB.Where("game_id = ? AND version = ?", g.ID, "1.0.2").First(&v2)
	if v2.BaseVersion != "1.0.1" {
		t.Fatalf("链式补丁 base 应为 1.0.1，实得 %q", v2.BaseVersion)
	}
	var rows2 []model.GameFile
	store.DB.Where("version_id = ?", v2.ID).Find(&rows2)
	got2 := map[string]string{}
	for _, r := range rows2 {
		got2[r.RelPath] = r.SHA256
	}
	if got2["keep.txt"] != hexSha256([]byte("KEEP2")) || got2["chg.txt"] != shaNewChg {
		t.Fatalf("链式合成结果不符: %+v", got2)
	}
	if _, exists := got2["old.txt"]; exists {
		t.Fatal("链式合成不应复活已删除文件")
	}
	if len(rows2) != 3 {
		t.Fatalf("链式合成应 3 个文件，实得 %d", len(rows2))
	}

	// ⑨ 补丁基底删除保护：v1.0.0 是 1.0.1/1.0.2 的基底，删除应 409（防继承条目物理文件被删后下载 404）
	var vb model.GameVersion
	if err := store.DB.Where("game_id = ? AND version = ?", g.ID, "1.0.0").First(&vb).Error; err != nil {
		t.Fatalf("基底版本行缺失：%v", err)
	}
	reqD := httptest.NewRequest("DELETE", "/api/merchant/version/"+fmt.Sprint(vb.ID), nil)
	reqD.SetPathValue("vid", fmt.Sprint(vb.ID))
	reqD.Header.Set("Authorization", "Bearer "+tk)
	recD := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionDelete)(recD, reqD)
	if recD.Code != 409 {
		t.Fatalf("补丁基底删除应 409，实得 %d %s", recD.Code, recD.Body.String())
	}
	// 基底行仍在、文件仍在（保护生效未误删）
	var cntBase int64
	store.DB.Model(&model.GameVersion{}).Where("id = ?", vb.ID).Count(&cntBase)
	if cntBase != 1 {
		t.Fatal("保护拒绝后基底版本行不应被删除")
	}
}

// hexSha256 测试用字节哈希
func hexSha256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// TestMerchantVersionPackTypes 版本登记全链路 pack_type 校验
func TestMerchantVersionPackTypes(t *testing.T) {
	// 生产由服务端启动 AutoMigrate 建表，测试进程需自行补齐（pack_type/pack_size 新列）
	if err := store.DB.AutoMigrate(&model.GameVersion{}); err != nil {
		t.Fatalf("GameVersion 迁移失败：%v", err)
	}
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_pk", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	g := merchantTestSeedGame(t, "mtest_pk", "mtest-gpack", "打包游戏", model.GameAuditApproved, 0)
	tk := merchantTestToken(t, "mtest_pk")
	t.Cleanup(func() {
		os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gpack"))
		var vids []uint
		store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Pluck("id", &vids)
		if len(vids) > 0 {
			store.DB.Where("version_id IN ?", vids).Delete(&model.GameFile{})
		}
		store.DB.Where("game_id = ?", g.ID).Delete(&model.GameVersion{})
	})

	zipData := buildZipBytes(t, map[string]string{"game.exe": "GAMEEXE", "data/readme.txt": "readme"})
	sha := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-zip", zipData)

	// ① 单 ZIP 正常登记：200，服务端实算 PackSize>0
	code, resp := registerPackVersion(t, s, tk, g.ID, "1.0.0", 1, 0, []map[string]interface{}{
		{"rel_path": "game.zip", "size": len(zipData), "sha256": sha, "upload_id": "mtest-pk-zip"},
	})
	if code != 200 {
		t.Fatalf("单 ZIP 登记应 200：%d %v", code, resp)
	}
	var v1 model.GameVersion
	if err := store.DB.Where("game_id = ? AND version = ?", g.ID, "1.0.0").First(&v1).Error; err != nil {
		t.Fatalf("版本行未登记：%v", err)
	}
	if v1.PackType != 1 || v1.PackSize != int64(len("GAMEEXE")+len("readme")) {
		t.Fatalf("单 ZIP 应 pack_type=1 pack_size 实算=%d，实得 type=%d size=%d",
			len("GAMEEXE")+len("readme"), v1.PackType, v1.PackSize)
	}

	// ② 单 ZIP 但清单含非 zip 项 → 400（注意：①成功后原分片会话已被服务端清理，需新会话）
	shaB := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-zipb", zipData)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "1.0.1", 1, 0, []map[string]interface{}{
		{"rel_path": "game.exe", "size": len(zipData), "sha256": shaB, "upload_id": "mtest-pk-zipb"},
	}); code != 400 {
		t.Fatalf("单 ZIP 非 zip 项应 400，实得 %d", code)
	}

	// ③ 分卷 ZIP 正常登记：200
	vol1 := []byte("VOLONE")
	vol2 := []byte("VOLTWO")
	sha1 := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-vol1", vol1)
	sha2 := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-vol2", vol2)
	code, resp = registerPackVersion(t, s, tk, g.ID, "2.0.0", 2, 12345678, []map[string]interface{}{
		{"rel_path": "game.zip.001", "size": len(vol1), "sha256": sha1, "upload_id": "mtest-pk-vol1"},
		{"rel_path": "game.zip.002", "size": len(vol2), "sha256": sha2, "upload_id": "mtest-pk-vol2"},
	})
	if code != 200 {
		t.Fatalf("分卷登记应 200：%d %v", code, resp)
	}
	var v2 model.GameVersion
	store.DB.Where("game_id = ? AND version = ?", g.ID, "2.0.0").First(&v2)
	if v2.PackType != 2 || v2.PackSize != 12345678 {
		t.Fatalf("分卷应 pack_type=2 pack_size=12345678，实得 type=%d size=%d", v2.PackType, v2.PackSize)
	}

	// ④ 分卷缺 pack_size → 400（独立会话，③成功后原会话已清理）
	shaC := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-volc1", vol1)
	shaD := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-volc2", vol2)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "2.0.1", 2, 0, []map[string]interface{}{
		{"rel_path": "game.zip.001", "size": len(vol1), "sha256": shaC, "upload_id": "mtest-pk-volc1"},
		{"rel_path": "game.zip.002", "size": len(vol2), "sha256": shaD, "upload_id": "mtest-pk-volc2"},
	}); code != 400 {
		t.Fatalf("分卷缺 pack_size 应 400，实得 %d", code)
	}

	// ⑤ 分卷序号断档 → 400
	sha3 := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-vol3", vol1)
	sha4 := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-vol4", vol2)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "2.0.2", 2, 100, []map[string]interface{}{
		{"rel_path": "game.zip.001", "size": len(vol1), "sha256": sha3, "upload_id": "mtest-pk-vol3"},
		{"rel_path": "game.zip.003", "size": len(vol2), "sha256": sha4, "upload_id": "mtest-pk-vol4"},
	}); code != 400 {
		t.Fatalf("分卷断档应 400，实得 %d", code)
	}

	// ⑥ 非法 pack_type → 400（独立会话，防前序用例消费）
	shaF := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-zipf", zipData)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "3.0.0", 9, 0, []map[string]interface{}{
		{"rel_path": "game.zip", "size": len(zipData), "sha256": shaF, "upload_id": "mtest-pk-zipf"},
	}); code != 400 {
		t.Fatalf("非法 pack_type 应 400，实得 %d", code)
	}

	// ⑦ 散文件（pack_type 缺省 0）回归：现状路径不受影响
	sha5 := zipUploadSeed(t, s, "mtest_pk", "mtest-pk-plain", zipData)
	if code, _ := registerPackVersion(t, s, tk, g.ID, "0.9.0", 0, 0, []map[string]interface{}{
		{"rel_path": "bin/game.exe", "size": len(zipData), "sha256": sha5, "upload_id": "mtest-pk-plain"},
	}); code != 200 {
		t.Fatalf("散文件登记应 200，实得 %d", code)
	}
	var v0 model.GameVersion
	store.DB.Where("game_id = ? AND version = ?", g.ID, "0.9.0").First(&v0)
	if v0.PackType != 0 {
		t.Fatalf("散文件版本 pack_type 应为 0，实得 %d", v0.PackType)
	}
}

// TestAdminGameToolRoute 管理端/商户端 gametool 下载路由分发实测（DefaultServeMux 真实分发，非直调 handler）：
// ① 字面量 /admin/api/game/gametool 优先于 {id} 通配命中——go test 二进制目录无 gametool.exe，
//
//	命中新 handler 的铁证是 404 文案"未随服务端部署"（若被 {id} 劫持则文案为"游戏不存在"）
//
// ② /admin/api/game/{id} 未被劫持（详情 404 文案照常）
// ③ 商户端 /api/merchant/gametool（gameToolDownloadServe 公共核心重构）行为等价
// ④ 未登录一律 401（双端 guard 均在路由层生效）
func TestAdminGameToolRoute(t *testing.T) {
	cfg := config.Load()
	if !cfg.Game.Enabled {
		t.Skip("游戏中心未启用，跳过")
	}
	s := NewServer(cfg)
	gsEnsureRoutes(s)
	gsEnsureRedis(t)
	if err := store.DB.AutoMigrate(&model.User{}, &model.Merchant{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	// admin（role=1）与 merchant（role=2）双账号 + 双 token（键前缀隔离，与守卫校验同键）
	adm := "admtest_gametool"
	if err := store.DB.Create(&model.User{Username: adm, Role: 1, Points: 0}).Error; err != nil {
		t.Fatalf("admin 账号创建失败：%v", err)
	}
	t.Cleanup(func() { store.DB.Where("username IN ?", []string{adm, "mtest_pt"}).Delete(&model.User{}) })
	admTk := "admtest-tk-" + fmt.Sprintf("%d", time.Now().UnixNano())
	store.RDB.Set(context.Background(), adminTokenKey+admTk, adm, time.Hour)
	t.Cleanup(func() { store.RDB.Del(context.Background(), adminTokenKey+admTk) })

	merchantTestSeed(t, "mtest_pt", 0, 100)
	mtk := merchantTestToken(t, "mtest_pt")
	t.Cleanup(func() {
		store.RDB.Del(context.Background(), merchantTokenKey+mtk)
		store.DB.Where("username = ?", "mtest_pt").Delete(&model.Merchant{})
	})

	get := func(path, token string) (int, string) {
		req := httptest.NewRequest("GET", path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		http.DefaultServeMux.ServeHTTP(rec, req)
		return rec.Code, rec.Body.String()
	}

	// ① 管理端 gametool：字面量路由命中（404 未部署文案，非"游戏不存在"）
	code, body := get("/admin/api/game/gametool", admTk)
	if code != 404 || !strings.Contains(body, "未随服务端部署") {
		t.Fatalf("管理端 gametool 应命中专用 handler（404 未部署），实得 %d %s", code, body)
	}
	// ② {id} 通配未被劫持：详情 404 文案照常
	code, body = get("/admin/api/game/987654321", admTk)
	if code != 404 || !strings.Contains(body, "游戏不存在") {
		t.Fatalf("详情路由 {id} 应照常命中（游戏不存在），实得 %d %s", code, body)
	}
	// ③ 商户端 gametool：公共核心重构后行为等价（同款 404 未部署文案）
	code, body = get("/api/merchant/gametool", mtk)
	if code != 404 || !strings.Contains(body, "未随服务端部署") {
		t.Fatalf("商户端 gametool 应行为等价（404 未部署），实得 %d %s", code, body)
	}
	// ④ 未登录一律 401（双端 guard）
	for _, p := range []string{"/admin/api/game/gametool", "/api/merchant/gametool"} {
		if code, _ := get(p, ""); code != 401 {
			t.Fatalf("%s 未登录应 401，实得 %d", p, code)
		}
	}

	// ⑤ 200 成功路径：临时在测试二进制同目录放假 gametool.exe（os.Executable 定位即命中），
	//    断言下发 200 + octet-stream + attachment 头，结束清理（验证 ServeContent 下发链路，非仅 404 分支）
	exePath, err := os.Executable()
	if err != nil {
		t.Fatalf("测试二进制路径解析失败：%v", err)
	}
	fakeTool := filepath.Join(filepath.Dir(exePath), "gametool.exe")
	if err := os.WriteFile(fakeTool, []byte("FAKE-GAMETOOL-BYTES"), 0644); err != nil {
		t.Fatalf("假工具文件写入失败：%v", err)
	}
	t.Cleanup(func() { os.Remove(fakeTool) })
	code, body = get("/admin/api/game/gametool", admTk)
	if code != 200 || !strings.Contains(body, "FAKE-GAMETOOL-BYTES") {
		t.Fatalf("gametool 存在时应 200 下发文件内容，实得 %d %q", code, body)
	}
	reqCT := httptest.NewRequest("GET", "/admin/api/game/gametool", nil)
	reqCT.Header.Set("Authorization", "Bearer "+admTk)
	recCT := httptest.NewRecorder()
	http.DefaultServeMux.ServeHTTP(recCT, reqCT)
	if ct := recCT.Header().Get("Content-Type"); !strings.Contains(ct, "octet-stream") {
		t.Fatalf("下发 Content-Type 应为 octet-stream，实得 %q", ct)
	}
	if cd := recCT.Header().Get("Content-Disposition"); !strings.Contains(cd, "gametool.exe") {
		t.Fatalf("下发 Content-Disposition 应含 gametool.exe，实得 %q", cd)
	}
}

// TestGameVersionLockTry 分桶锁语义：同 ID 同锁互斥、异 ID 互不阻塞、释放后可重取
func TestGameVersionLockTry(t *testing.T) {
	a1, a2, b := gameVersionLock(900001), gameVersionLock(900001), gameVersionLock(900002)
	if a1 != a2 {
		t.Fatal("同游戏 ID 应取到同一把锁")
	}
	if a1 == b {
		t.Fatal("异游戏 ID 不应共享锁")
	}
	if !a1.TryLock() {
		t.Fatal("空闲锁应可获取")
	}
	if a2.TryLock() {
		t.Fatal("已持有的同游戏锁 TryLock 应失败")
	}
	if !b.TryLock() {
		t.Fatal("异游戏锁不应被同游戏锁阻塞")
	}
	b.Unlock()
	a1.Unlock()
	if !a2.TryLock() {
		t.Fatal("释放后应可重新获取")
	}
	a2.Unlock()
}

// TestGameVersionCreateConcurrent 并发登记同一 version 的查重-落位竞态防护：
// 分桶锁保证恰一个 200（其余 409——TryLock 快速失败或查重拦截，均属 409）、
// 版本行恰 1 行、磁盘文件完整且与登记清单 sha 一致（无交错写盘/回滚误删）
func TestGameVersionCreateConcurrent(t *testing.T) {
	if err := store.DB.AutoMigrate(&model.GameVersion{}); err != nil {
		t.Fatalf("GameVersion 迁移失败：%v", err)
	}
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_cc", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	g := merchantTestSeedGame(t, "mtest_cc", "mtest-gcc", "并发游戏", model.GameAuditApproved, 0)
	tk := merchantTestToken(t, "mtest_cc")
	t.Cleanup(func() {
		os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gcc"))
		var vids []uint
		store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Pluck("id", &vids)
		if len(vids) > 0 {
			store.DB.Where("version_id IN ?", vids).Delete(&model.GameFile{})
		}
		store.DB.Where("game_id = ?", g.ID).Delete(&model.GameVersion{})
	})

	const n = 6
	contents := make([]string, n)
	type reqArg struct {
		uid, sha string
		size     int
	}
	args := make([]reqArg, n)
	for i := 0; i < n; i++ {
		contents[i] = fmt.Sprintf("FILE-CONTENT-%d", i)
		uid := fmt.Sprintf("mtest-cc-%d", i)
		args[i] = reqArg{uid: uid, size: len(contents[i]),
			sha: zipUploadSeed(t, s, "mtest_cc", uid, []byte(contents[i]))}
	}
	codes := make(chan int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := registerPackVersion(t, s, tk, g.ID, "9.9.9", 0, 0, []map[string]interface{}{
				{"rel_path": "f.txt", "size": args[i].size, "sha256": args[i].sha, "upload_id": args[i].uid},
			})
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	okCnt, conflictCnt := 0, 0
	for c := range codes {
		switch c {
		case 200:
			okCnt++
		case http.StatusConflict:
			conflictCnt++
		default:
			t.Fatalf("并发登记返回非预期状态码: %d", c)
		}
	}
	if okCnt != 1 || conflictCnt != n-1 {
		t.Fatalf("并发登记应恰 1 个 200 + %d 个 409，实得 200×%d 409×%d", n-1, okCnt, conflictCnt)
	}
	// 版本行恰 1 行
	var cnt int64
	store.DB.Model(&model.GameVersion{}).Where("game_id = ? AND version = ?", g.ID, "9.9.9").Count(&cnt)
	if cnt != 1 {
		t.Fatalf("版本行应恰 1 行，实得 %d", cnt)
	}
	// 磁盘文件完整：与某一方上传内容完全一致（无交错写盘）
	data, err := os.ReadFile(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gcc", "9.9.9", "f.txt"))
	if err != nil {
		t.Fatalf("落位文件读取失败：%v", err)
	}
	matched := false
	for _, c := range contents {
		if string(data) == c {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("落位文件内容与任一方均不一致（疑似交错写盘）: %q", data)
	}
	// 登记清单 sha 与磁盘内容一致（清单行与落位文件同属成功方，回滚未误删）
	var v model.GameVersion
	store.DB.Where("game_id = ? AND version = ?", g.ID, "9.9.9").First(&v)
	var fr model.GameFile
	if err := store.DB.Where("version_id = ?", v.ID).First(&fr).Error; err != nil {
		t.Fatalf("清单行缺失：%v", err)
	}
	if fr.SHA256 != hexSha256(data) {
		t.Fatalf("清单 sha 与磁盘内容不符: db=%s disk=%s", fr.SHA256, hexSha256(data))
	}
}
