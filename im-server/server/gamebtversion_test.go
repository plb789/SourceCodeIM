package server

// BT·上传种子游戏版本上架拦截集成测试（真实 MySQL：需本地 config.yaml 可连）。
// 覆盖：download_method=2 的版本上架请求被 400 拒绝（防孤儿版本文件 + 防 BT 清单版本号被
// 版本表记录固化导致"换新种子=日期变=触发更新"闭环失效）；非 BT 游戏不受拦截影响（请求
// 推进到后续正常校验环节）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

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

// 同日重传种子 latest_version 序号递归：客户端按字符串比较判"待更新"，日期粒度下同日重传
// 不变会漏掉更新提示——种子实际更换（seedChanged=true）时同日自动递增 .2/.3、跨日自然重置；
// 种子未换（false，普通编辑保存/删版回填）原值保留防误触全员更新
func TestTorrentMetaFillVersionSeq(t *testing.T) {
	s := NewServer(config.Load())
	if !s.cfg.Game.Enabled {
		t.Skip("游戏中心未启用，跳过")
	}
	dir := s.gameUploadedTorrentDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建种子目录失败：%v", err)
	}
	mk := func(name string, mt time.Time) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("d4:infod4:name4:seqx6:lengthi100eee"), 0o644); err != nil {
			t.Fatalf("写测试种子失败：%v", err)
		}
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatalf("设种子 mtime 失败：%v", err)
		}
		t.Cleanup(func() { os.Remove(p) })
	}
	now := time.Now()
	today := now.Format("2006-01-02")
	yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")
	mk("seqa.torrent", now)
	mk("seqb.torrent", now)
	mk("seqc.torrent", now)
	mk("seqd.torrent", now.AddDate(0, 0, -1))

	g := model.Game{Name: "序号递归测试", Slug: "btverseq", DownloadMethod: 2, TorrentPath: "seqa.torrent"}
	defer store.DB.Unscoped().Where("slug = ?", "btverseq").Delete(&model.Game{})

	// 首次填充（无旧值）：种子日期
	g.LatestVersion = ""
	s.gameTorrentMetaFill(&g, true)
	if g.LatestVersion != today {
		t.Fatalf("首次填充应为今天 %q，实际 %q", today, g.LatestVersion)
	}
	// 同日重传（换种子 B）：递增 .2
	g.TorrentPath = "seqb.torrent"
	s.gameTorrentMetaFill(&g, true)
	if g.LatestVersion != today+".2" {
		t.Fatalf("同日重传应递增为 %q，实际 %q", today+".2", g.LatestVersion)
	}
	// 同日再重传（换种子 C）：递增 .3
	g.TorrentPath = "seqc.torrent"
	s.gameTorrentMetaFill(&g, true)
	if g.LatestVersion != today+".3" {
		t.Fatalf("同日二度重传应递增为 %q，实际 %q", today+".3", g.LatestVersion)
	}
	// 跨日重传（换种子 D，mtime=昨天）：重置为新日期无序号
	g.TorrentPath = "seqd.torrent"
	s.gameTorrentMetaFill(&g, true)
	if g.LatestVersion != yesterday {
		t.Fatalf("跨日重传应重置为 %q，实际 %q", yesterday, g.LatestVersion)
	}
	// 种子未换（普通编辑保存）：原值保留（含序号形态）不递增
	g.LatestVersion = yesterday + ".7"
	s.gameTorrentMetaFill(&g, false)
	if g.LatestVersion != yesterday+".7" {
		t.Fatalf("未换种子应保留原值 %q，实际 %q", yesterday+".7", g.LatestVersion)
	}
	// 未换种子且库中无值（存量补齐）：按种子日期填充
	g.LatestVersion = ""
	s.gameTorrentMetaFill(&g, false)
	if g.LatestVersion != yesterday {
		t.Fatalf("存量补齐应为种子日期 %q，实际 %q", yesterday, g.LatestVersion)
	}
}

// 库状态签名轻量轮询端点：签名随服务端 latest_version 变化而变化（BT 同日重传 .2 即签名推进，
// 客户端据此感知拉全量），鉴权水位与全量同（缺 username 拒绝）
func TestGameLibrarySigEndpoint(t *testing.T) {
	s := NewServer(config.Load())
	if !s.cfg.Game.Enabled {
		t.Skip("游戏中心未启用，跳过")
	}
	store.DB.Where("slug = ?", "btversig").Delete(&model.Game{})
	g := model.Game{Name: "签名端点测试", Slug: "btversig", DownloadMethod: 2, Status: 0, LatestVersion: "2026-01-01"}
	if err := store.DB.Create(&g).Error; err != nil {
		t.Fatalf("建测试游戏失败：%v", err)
	}
	defer store.DB.Unscoped().Where("slug = ?", "btversig").Delete(&model.Game{})
	store.DB.Where("username = ?", "sigtest").Delete(&model.GameLibrary{})
	lib := model.GameLibrary{Username: "sigtest", GameID: g.ID, State: 3, InstalledVersion: "2026-01-01", InstallPath: `H:\T`}
	if err := store.DB.Create(&lib).Error; err != nil {
		t.Fatalf("建库条目失败：%v", err)
	}
	defer store.DB.Where("username = ?", "sigtest").Delete(&model.GameLibrary{})

	sigOf := func() string {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/api/game/library/sig?username=sigtest", nil)
		s.HandleGameLibrarySig(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("sig 端点应 200，实际 %d：%s", w.Code, w.Body.String())
		}
		var out struct {
			Ok   bool `json:"ok"`
			Data struct {
				Sig string `json:"sig"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("解析 sig 响应失败：%v", err)
		}
		return out.Data.Sig
	}

	sig1 := sigOf()
	if !strings.Contains(sig1, strconv.FormatUint(uint64(g.ID), 10)) {
		t.Fatalf("签名应含游戏条目：%q", sig1)
	}
	// 模拟同日重传：latest_version 推进 → 签名变化
	store.DB.Model(&g).Update("latest_version", "2026-01-01.2")
	sig2 := sigOf()
	if sig2 == sig1 {
		t.Fatalf("latest_version 推进后签名应变化")
	}
	// 未变化：签名稳定
	if sig2 != sigOf() {
		t.Fatalf("服务端无变化签名应稳定")
	}
	// 缺 username：400
	w := httptest.NewRecorder()
	s.HandleGameLibrarySig(w, httptest.NewRequest(http.MethodGet, "/api/game/library/sig", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("缺 username 应 400，实际 %d", w.Code)
	}
}
