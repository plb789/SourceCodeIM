package server

// BT·上传种子游戏版本上架拦截集成测试（真实 MySQL：需本地 config.yaml 可连）。
// 覆盖：download_method=2 的版本上架请求被 400 拒绝（防孤儿版本文件 + 防 BT 清单版本号被
// 版本表记录固化导致"换新种子=日期变=触发更新"闭环失效）；非 BT 游戏不受拦截影响（请求
// 推进到后续正常校验环节）。

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

func TestAdminGameVersionCreateBtBlocked(t *testing.T) {
	s := NewServer(config.Load())
	if !s.cfg.Game.Enabled {
		t.Skip("游戏中心未启用，跳过")
	}
	// 测试游戏行（固定 slug，先清后建防历史残留；t.Cleanup 兜底清理）
	store.DB.Where("slug = ?", "btvertest").Delete(&model.Game{})
	bt := model.Game{Name: "BT拦截测试", Slug: "btvertest", DownloadMethod: 2, Status: 0}
	if err := store.DB.Create(&bt).Error; err != nil {
		t.Fatalf("建 BT 测试游戏失败：%v", err)
	}
	defer store.DB.Unscoped().Where("slug = ?", "btvertest").Delete(&model.Game{})

	// BT 游戏：请求在文件清单解析之前即被拦截（body 非法与否不影响断言语义）
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/admin/api/game/"+strconv.FormatUint(uint64(bt.ID), 10)+"/version", strings.NewReader(`{}`))
	r.SetPathValue("id", strconv.FormatUint(uint64(bt.ID), 10))
	s.handleAdminGameVersionCreate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("BT 游戏版本上架应被 400 拒绝，实际 %d：%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "BT 种子方式") {
		t.Fatalf("BT 拦截提示文案不符：%s", w.Body.String())
	}

	// 对照：非 BT 游戏（download_method=0）不受拦截——请求应推进到版本号校验（"版本号非法"）
	w2 := httptest.NewRecorder()
	r2 := httptest.NewRequest(http.MethodPost, "/admin/api/game/"+strconv.FormatUint(uint64(bt.ID), 10)+"/version", strings.NewReader(`{}`))
	bt0 := bt
	bt0.ID = 0
	bt0.DownloadMethod = 0
	bt0.Slug = "btvertest0"
	if err := store.DB.Create(&bt0).Error; err != nil {
		t.Fatalf("建对照测试游戏失败：%v", err)
	}
	defer store.DB.Unscoped().Where("slug = ?", "btvertest0").Delete(&model.Game{})
	r2.SetPathValue("id", strconv.FormatUint(uint64(bt0.ID), 10))
	s.handleAdminGameVersionCreate(w2, r2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("非 BT 游戏空清单应 400（版本号非法），实际 %d：%s", w2.Code, w2.Body.String())
	}
	if strings.Contains(w2.Body.String(), "BT 种子方式") {
		t.Fatalf("非 BT 游戏不应命中 BT 拦截：%s", w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), "版本号非法") {
		t.Fatalf("非 BT 游戏应推进到版本号校验：%s", w2.Body.String())
	}
}

// BT 游戏删除误上架版本：最新版冗余回退不走版本逻辑（清空/置剩余版本号——会让 BT 清单
// 版本号回退 "torrent" 占位并误标全员待更新），须回填种子重扫结果（latest_version=种子
// 上传日期、size_bytes=种子内总大小）。单文件最小种子 d4:infod4:name5:war310:lengthi…eee
func TestAdminGameVersionDeleteBtRefill(t *testing.T) {
	s := NewServer(config.Load())
	if !s.cfg.Game.Enabled {
		t.Skip("游戏中心未启用，跳过")
	}
	// 落一个最小合法种子（单文件 123456789 字节，name=war3del）
	seedDir := s.gameUploadedTorrentDir()
	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		t.Fatalf("建种子目录失败：%v", err)
	}
	seedName := "btvertest-del.torrent"
	seedPath := filepath.Join(seedDir, seedName)
	seed := "d4:infod4:name7:war3del6:lengthi123456789eee"
	if err := os.WriteFile(seedPath, []byte(seed), 0o644); err != nil {
		t.Fatalf("写测试种子失败：%v", err)
	}
	t.Cleanup(func() { os.Remove(seedPath) })

	store.DB.Where("slug = ?", "btverdel").Delete(&model.Game{})
	g := model.Game{Name: "BT删版回填测试", Slug: "btverdel", DownloadMethod: 2, Status: 0, TorrentPath: seedName}
	if err := store.DB.Create(&g).Error; err != nil {
		t.Fatalf("建 BT 测试游戏失败：%v", err)
	}
	defer store.DB.Unscoped().Where("slug = ?", "btverdel").Delete(&model.Game{})

	// 预置误上架的孤儿版本行（模拟历史脏数据）
	v := model.GameVersion{GameID: g.ID, Version: "0.0.0-bad", SizeBytes: 1, FileCount: 1, ManifestHash: "x"}
	if err := store.DB.Create(&v).Error; err != nil {
		t.Fatalf("建孤儿版本失败：%v", err)
	}

	// 删除该版本 → BT 分支应回填种子元数据而非清空
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodDelete, "/admin/api/game/version/"+strconv.FormatUint(uint64(v.ID), 10), nil)
	r.SetPathValue("vid", strconv.FormatUint(uint64(v.ID), 10))
	s.handleAdminGameVersionDelete(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("删除版本应成功，实际 %d：%s", w.Code, w.Body.String())
	}
	var cnt int64
	store.DB.Model(&model.GameVersion{}).Where("id = ?", v.ID).Count(&cnt)
	if cnt != 0 {
		t.Fatalf("版本行应已删除")
	}
	var got model.Game
	if err := store.DB.First(&got, g.ID).Error; err != nil {
		t.Fatalf("回读游戏失败：%v", err)
	}
	if got.SizeBytes != 123456789 {
		t.Fatalf("BT 删版后 size_bytes 应回填种子总大小 123456789，实际 %d", got.SizeBytes)
	}
	if got.LatestVersion == "" || got.LatestVersion == "0.0.0-bad" {
		t.Fatalf("BT 删版后 latest_version 应回填种子日期，实际 %q", got.LatestVersion)
	}
}
