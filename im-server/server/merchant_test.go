package server

// 商户独立后台单测（真实 MySQL + Redis，TestMain 已锚定 bin/config.yaml）：
// 鉴权（role=2/启用校验/防越权）、审核状态机（新增→待审→通过上架→编辑回审→驳回）、
// 玩家侧过滤墙（audit IN (0,2)）、横向越权隔离、停用商户即时失效。
// 测试数据 mtest_ 前缀用后即清。

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"im-server/model"
	"im-server/store"
)

// merchantTestSeed 建商户账号（users.role=2 + im_merchant 行；Points 显式归零防 default:100 零值陷阱）
func merchantTestSeed(t *testing.T, username string, status int8, rate float64) {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.Merchant{}, &model.User{}, &model.Game{}, &model.GameNotice{}, &model.RechargeOrder{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	if err := store.DB.Create(&model.User{Username: username, Role: 2, Points: 0}).Error; err != nil {
		t.Fatalf("商户账号创建失败：%v", err)
	}
	store.DB.Model(&model.User{}).Where("username = ?", username).Update("points", 0)
	if err := store.DB.Create(&model.Merchant{Username: username, Name: "测试商户", CommissionRate: rate, Status: status}).Error; err != nil {
		t.Fatalf("商户资料创建失败：%v", err)
	}
}

// merchantTestToken 直写 Redis 会话（与 merchantGuard 校验同键；tk 含用户名防同纳秒撞车互相覆盖）
func merchantTestToken(t *testing.T, username string) string {
	t.Helper()
	gsEnsureRedis(t)
	tk := "mtest-" + username + "-" + fmt.Sprintf("%d", time.Now().UnixNano())
	store.RDB.Set(context.Background(), merchantTokenKey+tk, username, time.Hour)
	return tk
}

// merchantTestSeedGame 直建商户游戏行（slug 需全局唯一：按 username 区分）
func merchantTestSeedGame(t *testing.T, owner, slug, name string, audit, status int8) model.Game {
	t.Helper()
	g := model.Game{Slug: slug, Name: name, OwnerUsername: owner, AuditStatus: audit, Status: status, GameSecret: gameRandomSecret()}
	if err := store.DB.Create(&g).Error; err != nil {
		t.Fatalf("测试游戏创建失败：%v", err)
	}
	return g
}

// merchantReq 商户接口调用归口（merchantGuard 包裹直调）
func merchantReq(t *testing.T, s *Server, token, method, path string, body interface{}) (int, map[string]interface{}) {
	t.Helper()
	gsEnsureRedis(t)
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader([]byte{})
	}
	req := httptest.NewRequest(method, path, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	// 从路径提取 {id} 段注入 PathValue（直调 handler 时 httptest 不解析路由模式）
	if segs := strings.Split(path, "/"); len(segs) > 4 && segs[3] == "games" {
		if _, err := strconv.ParseUint(segs[4], 10, 64); err == nil {
			req.SetPathValue("id", segs[4])
		}
	}
	rec := httptest.NewRecorder()
	switch {
	case strings.HasPrefix(path, "/api/merchant/games") && strings.Contains(path, "/status"):
		s.merchantGuard(s.handleMerchantGameStatus)(rec, req)
	case strings.HasPrefix(path, "/api/merchant/games") && strings.Contains(path, "/notices"):
		if method == "GET" {
			s.merchantGuard(s.handleMerchantNoticesGet)(rec, req)
		} else if method == "POST" {
			s.merchantGuard(s.handleMerchantNoticeCreate)(rec, req)
		}
	default:
		t.Fatalf("merchantReq 未覆盖的路由: %s %s", method, path)
	}
	code, resp := gwrUnwrap(rec)
	if resp == nil {
		resp = map[string]interface{}{}
	}
	return code, resp
}

// merchantTestCleanup 清理 mtest_ 前缀数据（按 owner/username 精确删除防污染真实数据；
// 充值订单按名下游戏子查询清理——玩家账号非 mtest_ 前缀，不能按 username 删）
func merchantTestCleanup(t *testing.T) {
	t.Helper()
	// 按归属删 + 按测试 slug 删（官方测试游戏 owner 为空，slug 是唯一可靠标识）
	store.DB.Where("owner_username LIKE ? OR slug LIKE ?", "mtest_%", "mtest-%").Delete(&model.Game{})
	store.DB.Where("game_id IN (?)",
		store.DB.Model(&model.Game{}).Select("id").Where("owner_username LIKE ?", "mtest_%")).Delete(&model.RechargeOrder{})
	store.DB.Where("username LIKE ?", "mtest_%").Delete(&model.Merchant{})
	store.DB.Where("username LIKE ?", "mtest_%").Delete(&model.User{})
	store.DB.Where("username LIKE ?", "mtest_%").Delete(&model.PointsLog{})
}

func TestMerchantAuthAndGuard(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_ok", 0, 100)
	merchantTestSeed(t, "mtest_off", 1, 100) // 停用商户
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)

	// 无 token → 401
	req := httptest.NewRequest("GET", "/api/merchant/profile", nil)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantProfile)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 应 401，实得 %d", rec.Code)
	}

	// 停用商户 token → 403（即时失效，不待 TTL）
	tkOff := merchantTestToken(t, "mtest_off")
	req = httptest.NewRequest("GET", "/api/merchant/profile", nil)
	req.Header.Set("Authorization", "Bearer "+tkOff)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantProfile)(rec, req)
	if rec.Code != 403 {
		t.Fatalf("停用商户应 403，实得 %d", rec.Code)
	}

	// 正常商户 → 200 且资料含分成比例
	tk := merchantTestToken(t, "mtest_ok")
	req = httptest.NewRequest("GET", "/api/merchant/profile", nil)
	req.Header.Set("Authorization", "Bearer "+tk)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantProfile)(rec, req)
	code, resp := gwrUnwrap(rec)
	if code != 200 || resp["commission_rate"].(float64) != 100 {
		t.Fatalf("正常商户资料应 200 且比例 100：%d %v", code, resp)
	}

	// 普通用户（role=0）直造 token → 403（实时复核 role）
	gsEnsureRedis(t)
	if err := store.DB.Create(&model.User{Username: "mtest_plain", Points: 0}).Error; err != nil {
		t.Fatalf("普通用户创建失败：%v", err)
	}
	store.DB.Model(&model.User{}).Where("username = ?", "mtest_plain").Update("points", 0)
	tkPlain := merchantTestToken(t, "mtest_plain")
	req = httptest.NewRequest("GET", "/api/merchant/profile", nil)
	req.Header.Set("Authorization", "Bearer "+tkPlain)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantProfile)(rec, req)
	if rec.Code != 403 {
		t.Fatalf("非商户角色应 403，实得 %d", rec.Code)
	}
}

func TestMerchantAuditFlowAndPlayerFilter(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_flow", 0, 80)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	tk := merchantTestToken(t, "mtest_flow")

	// ① 商户新增游戏（直调 handler）→ audit=1 待审核
	body, _ := json.Marshal(map[string]interface{}{
		"name": "商户测试游戏", "slug": "mtest-g1", "short_desc": "测试", "price": 0,
		"recharge_enabled": true, "recharge_rate": 2, "recharge_tiers": "10,50",
	})
	req := httptest.NewRequest("POST", "/api/merchant/games", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tk)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantGameCreate)(rec, req)
	code, resp := gwrUnwrap(rec)
	if code != 200 || resp["audit_status"].(float64) != model.GameAuditPending {
		t.Fatalf("商户新增游戏应 200 且待审核：%d %v", code, resp)
	}
	var g model.Game
	store.DB.Where("slug = ?", "mtest-g1").First(&g)
	if g.OwnerUsername != "mtest_flow" || g.RechargeRate != 2 {
		t.Fatalf("归属/汇率不符：%+v", g)
	}

	// ② 待审核游戏不出现在玩家侧列表（过滤墙）
	req = httptest.NewRequest("GET", "/api/game/list?page=1&size=60&keyword=商户测试", nil)
	rec = httptest.NewRecorder()
	s.HandleGameList(rec, req)
	code, resp = gwrUnwrap(rec)
	if code != 200 {
		t.Fatalf("玩家列表应 200：%d", code)
	}
	if items := resp["list"].([]interface{}); len(items) != 0 {
		t.Fatalf("待审核游戏不应出现在玩家列表，实得 %d 条", len(items))
	}

	// ③ 管理员通过 → audit=2 + 自动上架 → 玩家列表可见
	areq := httptest.NewRequest("POST", "/admin/api/merchant/audit/"+fmt.Sprint(g.ID),
		bytes.NewReader([]byte(`{"action":"pass"}`)))
	areq.SetPathValue("id", fmt.Sprint(g.ID)) // 直调 handler 须手动注入路径参数（httptest 不解析模式）
	arec := httptest.NewRecorder()
	s.handleAdminGameAuditAct(arec, areq)
	if arec.Code != 200 {
		t.Fatalf("审核通过应 200：%s", arec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.AuditStatus != model.GameAuditApproved || g.Status != 0 {
		t.Fatalf("通过后应 audit=2 且上架：%+v", g)
	}
	req = httptest.NewRequest("GET", "/api/game/list?page=1&size=60&keyword=商户测试", nil)
	rec = httptest.NewRecorder()
	s.HandleGameList(rec, req)
	_, resp = gwrUnwrap(rec)
	if items := resp["list"].([]interface{}); len(items) != 1 {
		t.Fatalf("过审游戏应出现在玩家列表，实得 %d 条", len(items))
	}

	// ④ 商户编辑对外字段 → 回待审核 → 玩家列表再次不可见
	body, _ = json.Marshal(map[string]interface{}{
		"name": "商户测试游戏V2", "slug": "mtest-g1", "short_desc": "改版", "price": 0,
	})
	req = httptest.NewRequest("PUT", fmt.Sprintf("/api/merchant/games/%d", g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	req.Header.Set("Authorization", "Bearer "+tk)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantGameUpdate)(rec, req)
	if rec.Code != 200 {
		t.Fatalf("商户编辑应 200：%s", rec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.AuditStatus != model.GameAuditPending || g.Name != "商户测试游戏V2" {
		t.Fatalf("编辑后应回待审核且名称已更新：%+v", g)
	}
	req = httptest.NewRequest("GET", "/api/game/list?page=1&size=60&keyword=商户测试", nil)
	rec = httptest.NewRecorder()
	s.HandleGameList(rec, req)
	_, resp = gwrUnwrap(rec)
	if items := resp["list"].([]interface{}); len(items) != 0 {
		t.Fatalf("回审游戏不应出现在玩家列表，实得 %d 条", len(items))
	}

	// ⑤ 驳回：无理由 400；有理由 → audit=3 附理由
	areq = httptest.NewRequest("POST", "/admin/api/merchant/audit/"+fmt.Sprint(g.ID), bytes.NewReader([]byte(`{"action":"reject"}`)))
	areq.SetPathValue("id", fmt.Sprint(g.ID))
	arec = httptest.NewRecorder()
	s.handleAdminGameAuditAct(arec, areq)
	if arec.Code != 400 {
		t.Fatalf("无理由驳回应 400，实得 %d", arec.Code)
	}
	areq = httptest.NewRequest("POST", "/admin/api/merchant/audit/"+fmt.Sprint(g.ID),
		bytes.NewReader([]byte(`{"action":"reject","remark":"封面不合规"}`)))
	areq.SetPathValue("id", fmt.Sprint(g.ID))
	arec = httptest.NewRecorder()
	s.handleAdminGameAuditAct(arec, areq)
	if arec.Code != 200 {
		t.Fatalf("驳回应 200：%s", arec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.AuditStatus != model.GameAuditRejected || g.AuditRemark != "封面不合规" {
		t.Fatalf("驳回态/理由不符：%+v", g)
	}

	// ⑥ 驳回态商户不能上架；官方游戏审核接口拒绝
	body, _ = json.Marshal(map[string]interface{}{"status": 0})
	code, _ = merchantReq(t, s, tk, "POST", fmt.Sprintf("/api/merchant/games/%d/status", g.ID), map[string]interface{}{"status": 0})
	if code != 403 {
		t.Fatalf("驳回态上架应 403，实得 %d", code)
	}
	og := merchantTestSeedGame(t, "", "mtest-official", "官方游戏", model.GameAuditOfficial, 0)
	areq = httptest.NewRequest("POST", "/admin/api/merchant/audit/"+fmt.Sprint(og.ID), bytes.NewReader([]byte(`{"action":"pass"}`)))
	areq.SetPathValue("id", fmt.Sprint(og.ID))
	arec = httptest.NewRecorder()
	s.handleAdminGameAuditAct(arec, areq)
	if arec.Code != 400 {
		t.Fatalf("官方游戏审核应 400，实得 %d", arec.Code)
	}
}

func TestMerchantOwnershipIsolation(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_a", 0, 100)
	merchantTestSeed(t, "mtest_b", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	ga := merchantTestSeedGame(t, "mtest_a", "mtest-ga", "A的游戏", model.GameAuditApproved, 0)
	gb := merchantTestSeedGame(t, "mtest_b", "mtest-gb", "B的游戏", model.GameAuditApproved, 0)
	tkA := merchantTestToken(t, "mtest_a")
	tkB := merchantTestToken(t, "mtest_b")

	// B 操作 A 的游戏（状态/编辑）→ 404（不暴露存在性）
	code, _ := merchantReq(t, s, tkB, "POST", fmt.Sprintf("/api/merchant/games/%d/status", ga.ID), map[string]interface{}{"status": 1})
	if code != 404 {
		t.Fatalf("B 下架 A 的游戏应 404，实得 %d", code)
	}
	req := httptest.NewRequest("PUT", fmt.Sprintf("/api/merchant/games/%d", ga.ID),
		bytes.NewReader([]byte(`{"name":"篡改","slug":"mtest-ga"}`)))
	req.Header.Set("Authorization", "Bearer "+tkB)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantGameUpdate)(rec, req)
	if rec.Code != 404 {
		t.Fatalf("B 编辑 A 的游戏应 404，实得 %d", rec.Code)
	}

	// B 在 A 的游戏下发公告 → 404；A 游戏列表只含自己的
	code, _ = merchantReq(t, s, tkB, "POST", fmt.Sprintf("/api/merchant/games/%d/notices", ga.ID),
		map[string]interface{}{"game_id": ga.ID, "title": "越权公告"})
	if code != 404 {
		t.Fatalf("B 在 A 游戏下发公告应 404，实得 %d", code)
	}
	req = httptest.NewRequest("GET", "/api/merchant/games?page=1&size=100", nil)
	req.Header.Set("Authorization", "Bearer "+tkA)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantGameList)(rec, req)
	code, resp := gwrUnwrap(rec)
	if code != 200 {
		t.Fatalf("A 游戏列表应 200：%d", code)
	}
	items := resp["list"].([]interface{})
	if len(items) != 1 || items[0].(map[string]interface{})["id"].(float64) != float64(ga.ID) {
		t.Fatalf("A 列表应仅含自己的游戏：%v", items)
	}
	_ = gb
}

func TestMerchantRechargeStats(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_st", 0, 60) // 分成比例 60%
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	tk := merchantTestToken(t, "mtest_st")

	// 名下游戏 + 成功/处理中/失败订单各一笔（仅成功计入口径）
	g := merchantTestSeedGame(t, "mtest_st", "mtest-gst", "统计游戏", model.GameAuditApproved, 0)
	mk := func(id uint, username string, status int8, points float64) {
		store.DB.Create(&model.RechargeOrder{GameID: id, Username: username, Points: points, Amount: points, Status: status, Gw: "mtest-gw"})
	}
	mk(g.ID, "player1", model.RechargeOrderStatusSuccess, 100)
	mk(g.ID, "player2", model.RechargeOrderStatusSuccess, 50)
	mk(g.ID, "player3", model.RechargeOrderStatusPending, 999) // 处理中不计入
	mk(g.ID, "player4", model.RechargeOrderStatusFailed, 888)  // 失败不计入

	req := httptest.NewRequest("GET", "/api/merchant/recharge/summary", nil)
	req.Header.Set("Authorization", "Bearer "+tk)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantRechargeSummary)(rec, req)
	code, resp := gwrUnwrap(rec)
	if code != 200 {
		t.Fatalf("统计应 200：%d %v", code, resp)
	}
	if resp["total_points"].(float64) != 150 {
		t.Fatalf("总额应 150（仅成功单），实得 %v", resp["total_points"])
	}
	if resp["commission_rate"].(float64) != 60 {
		t.Fatalf("比例应 60，实得 %v", resp["commission_rate"])
	}
	if resp["payable"].(float64) != 90 {
		t.Fatalf("应结应 150×60%%=90，实得 %v", resp["payable"])
	}
	bg := resp["by_game"].([]interface{})
	if len(bg) != 1 || bg[0].(map[string]interface{})["points"].(float64) != 150 {
		t.Fatalf("按游戏聚合不符：%v", bg)
	}

	// 订单列表：仅自己名下游戏订单（4 条，含各状态）
	req = httptest.NewRequest("GET", "/api/merchant/recharge/orders?page=1&size=15", nil)
	req.Header.Set("Authorization", "Bearer "+tk)
	rec = httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantRechargeOrders)(rec, req)
	code, resp = gwrUnwrap(rec)
	if code != 200 || resp["total"].(float64) != 4 {
		t.Fatalf("订单列表应 200 且 4 条：%d %v", code, resp)
	}
}

func TestMerchantVersionOwnership(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_va", 0, 100)
	merchantTestSeed(t, "mtest_vb", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	ga := merchantTestSeedGame(t, "mtest_va", "mtest-gver", "版本游戏A", model.GameAuditApproved, 0)
	gb := merchantTestSeedGame(t, "mtest_vb", "mtest-gvb", "版本游戏B", model.GameAuditApproved, 0)
	tkA := merchantTestToken(t, "mtest_va")
	tkB := merchantTestToken(t, "mtest_vb")

	// 直造分片会话（Owner=商户 A）与 part 文件（等价于 A 走上传通道后的状态）
	uploadID := "mtest-ver-upload-1"
	data := []byte("hello merchant version")
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
	gameUploadSessions.m[uploadID] = &gameUploadSession{UploadID: uploadID, Owner: "mtest_va", Kind: "game",
		Total: 1, FileSize: int64(len(data)), Received: map[int]int64{0: int64(len(data))}, CreatedAt: time.Now()}
	gameUploadSessions.Unlock()
	t.Cleanup(func() {
		gameUploadSessions.Lock()
		delete(gameUploadSessions.m, uploadID)
		gameUploadSessions.Unlock()
		os.RemoveAll(tmpDir)
		// 版本磁盘目录与清单/版本行（按测试 slug 精确清理）
		os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gver"))
		os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gvb"))
		for _, gid := range []uint{ga.ID, gb.ID} {
			var vids []uint
			store.DB.Model(&model.GameVersion{}).Where("game_id = ?", gid).Pluck("id", &vids)
			if len(vids) > 0 {
				store.DB.Where("version_id IN ?", vids).Delete(&model.GameFile{})
			}
			store.DB.Where("game_id = ?", gid).Delete(&model.GameVersion{})
		}
	})

	merchantRegister := func(token string, gid uint, version string) (int, map[string]interface{}) {
		body, _ := json.Marshal(map[string]interface{}{
			"version": version,
			"files": []map[string]interface{}{
				{"rel_path": "bin/game.exe", "size": len(data), "sha256": sha, "upload_id": uploadID},
			},
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

	// ① 会话 Owner=商户 A 登记商户 A 自己的游戏 → 200，版本与文件落位、最新版冗余刷新
	code, resp := merchantRegister(tkA, ga.ID, "1.0.0")
	if code != 200 {
		t.Fatalf("归属一致登记应 200：%d %v", code, resp)
	}
	var v model.GameVersion
	if err := store.DB.Where("game_id = ?", ga.ID).First(&v).Error; err != nil {
		t.Fatalf("版本行未登记：%v", err)
	}
	if _, err := os.Stat(filepath.Join(s.cfg.Game.LocalDir, "games", "mtest-gver", "1.0.0", "bin", "game.exe")); err != nil {
		t.Fatalf("文件未落位：%v", err)
	}
	var gAfter model.Game
	store.DB.First(&gAfter, ga.ID)
	if gAfter.LatestVersion != "1.0.0" {
		t.Fatalf("最新版冗余应刷新为 1.0.0，实得 %q", gAfter.LatestVersion)
	}

	// ② 商户 B 用「A 的新分片会话」登记 B 自己的游戏 → 403（会话归属校验拦截跨身份串用；
	// 注：①登记成功后原会话已被服务端清理，故此处再造一个 Owner=A 的会话）
	uploadID2 := "mtest-ver-upload-2"
	if err := os.MkdirAll(s.gameTmpDir(uploadID2), os.ModePerm); err != nil {
		t.Fatalf("临时目录创建失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(s.gameTmpDir(uploadID2), "0.part"), data, 0644); err != nil {
		t.Fatalf("分片写入失败：%v", err)
	}
	gameUploadSessions.Lock()
	gameUploadSessions.m[uploadID2] = &gameUploadSession{UploadID: uploadID2, Owner: "mtest_va", Kind: "game",
		Total: 1, FileSize: int64(len(data)), Received: map[int]int64{0: int64(len(data))}, CreatedAt: time.Now()}
	gameUploadSessions.Unlock()
	t.Cleanup(func() {
		gameUploadSessions.Lock()
		delete(gameUploadSessions.m, uploadID2)
		gameUploadSessions.Unlock()
		os.RemoveAll(s.gameTmpDir(uploadID2))
	})
	body2, _ := json.Marshal(map[string]interface{}{
		"version": "9.9.9",
		"files": []map[string]interface{}{
			{"rel_path": "bin/game.exe", "size": len(data), "sha256": sha, "upload_id": uploadID2},
		},
	})
	req2 := httptest.NewRequest("POST", "/api/merchant/games/"+fmt.Sprint(gb.ID)+"/version", bytes.NewReader(body2))
	req2.SetPathValue("id", fmt.Sprint(gb.ID))
	req2.Header.Set("Authorization", "Bearer "+tkB)
	rec2 := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantVersionCreate)(rec2, req2)
	if rec2.Code != 403 {
		t.Fatalf("跨身份串用会话应 403：%d %s", rec2.Code, rec2.Body.String())
	}

	// ③ B 登记 A 的游戏 → 404（游戏归属拦截，先于会话校验）
	code, _ = merchantRegister(tkB, ga.ID, "8.8.8")
	if code != 404 {
		t.Fatalf("B 登记 A 的游戏应 404，实得 %d", code)
	}
	_ = v
}

// TestAdminGameOwnershipTransfer 管理端编辑接口归属转移（阶段二百九十七）：
// 官方→商户（回待审核）/ 商户→官方（清审核回免审）/ 非商户目标拒绝 / 归属未变编辑不误清
func TestAdminGameOwnershipTransfer(t *testing.T) {
	merchantTestCleanup(t)
	merchantTestSeed(t, "mtest_own", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	// 官方测试游戏（owner 空、免审、上架；slug mtest- 前缀供 cleanup 精确回收）
	g := model.Game{Slug: "mtest-official", Name: "官方转移测试", AuditStatus: model.GameAuditOfficial, Status: 0, GameSecret: gameRandomSecret()}
	if err := store.DB.Create(&g).Error; err != nil {
		t.Fatalf("官方测试游戏创建失败：%v", err)
	}

	// ① 官方 → 商户（显式开关 owner_transfer=true，同新版前端编辑表单口径）：owner 落库 + 回待审核
	body, _ := json.Marshal(map[string]interface{}{"name": "官方转移测试", "owner_username": "mtest_own", "owner_transfer": true})
	req := httptest.NewRequest("PUT", "/admin/api/game/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	rec := httptest.NewRecorder()
	s.handleAdminGameUpdate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("官方转商户应 200：%d %s", rec.Code, rec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.OwnerUsername != "mtest_own" || g.AuditStatus != model.GameAuditPending {
		t.Fatalf("转商户后应 owner=mtest_own 且待审核：%+v", g)
	}

	// ② 归属未变的编辑（管理员代改对外字段）→ 保持回待审核语义，owner 不丢
	body, _ = json.Marshal(map[string]interface{}{"name": "官方转移测试V2", "owner_username": "mtest_own", "owner_transfer": true})
	req = httptest.NewRequest("PUT", "/admin/api/game/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	rec = httptest.NewRecorder()
	s.handleAdminGameUpdate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("归属未变编辑应 200：%d %s", rec.Code, rec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.OwnerUsername != "mtest_own" || g.AuditStatus != model.GameAuditPending || g.Name != "官方转移测试V2" {
		t.Fatalf("归属未变编辑应保持商户归属+待审核：%+v", g)
	}

	// ②补 混布兼容：不带 owner_transfer 开关（旧版前端缓存/上下架全量回写口径）→ 归属绝不变更，
	//   即便 payload 缺失 owner_username（解码为空串）也不得误判为"转官方"清掉归属
	body, _ = json.Marshal(map[string]interface{}{"name": "官方转移测试V2"})
	req = httptest.NewRequest("PUT", "/admin/api/game/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	rec = httptest.NewRecorder()
	s.handleAdminGameUpdate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("无开关编辑应 200：%d %s", rec.Code, rec.Body.String())
	}
	var g3 model.Game // 全新结构体变量回读（复用旧变量时指针字段 NULL 回填有残留，实测踩坑）
	store.DB.First(&g3, g.ID)
	if g3.OwnerUsername != "mtest_own" || g3.AuditStatus != model.GameAuditPending {
		t.Fatalf("无开关编辑不得变更归属：%+v", g3)
	}

	// ③ 目标账号不是商户（role=0）→ 整单 400，归属不变
	body, _ = json.Marshal(map[string]interface{}{"name": "官方转移测试V2", "owner_username": "mtest_noperm", "owner_transfer": true})
	req = httptest.NewRequest("PUT", "/admin/api/game/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	rec = httptest.NewRecorder()
	s.handleAdminGameUpdate(rec, req)
	if rec.Code != 400 {
		t.Fatalf("非商户目标应 400，实得 %d：%s", rec.Code, rec.Body.String())
	}
	store.DB.First(&g, g.ID)
	if g.OwnerUsername != "mtest_own" {
		t.Fatalf("拒绝后归属应不变：%+v", g)
	}

	// ④ 商户 → 官方：owner 清空 + 审核字段归官方免审
	body, _ = json.Marshal(map[string]interface{}{"name": "官方转移测试V2", "owner_username": "", "owner_transfer": true})
	req = httptest.NewRequest("PUT", "/admin/api/game/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	rec = httptest.NewRecorder()
	s.handleAdminGameUpdate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("商户转官方应 200：%d %s", rec.Code, rec.Body.String())
	}
	// 回读统一用全新结构体变量（复用旧变量时 GORM 对已置值指针字段的 NULL 回填存在残留，实测踩坑）
	var g4 model.Game
	store.DB.First(&g4, g.ID)
	if g4.OwnerUsername != "" || g4.AuditStatus != model.GameAuditOfficial || g4.AuditTime != nil || g4.AuditedBy != "" {
		t.Fatalf("转官方后应清归属+审核字段归零：%+v", g4)
	}
}

func TestGatewayPackageBuild(t *testing.T) {
	sources := gatewayCollectSources()
	if len(sources) == 0 {
		t.Skip("bin 下无任何网关构建产物，跳过打包测试")
	}
	zipPath := filepath.Join(t.TempDir(), "im-gateway.zip")
	if err := gatewayZipBuild(zipPath, sources); err != nil {
		t.Fatalf("打包失败：%v", err)
	}
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("zip 读取失败：%v", err)
	}
	defer r.Close()
	names := map[string]bool{}
	var yamlContent string
	for _, f := range r.File {
		names[f.Name] = true
		if f.Name == "gateway.yaml" {
			rc, _ := f.Open()
			buf := make([]byte, f.UncompressedSize64)
			rc.Read(buf)
			rc.Close()
			yamlContent = string(buf)
		}
	}
	// 每个归集到的二进制都必须在包内（多平台一次下载）
	for _, src := range sources {
		if !names[src.ZipName] {
			t.Fatalf("zip 缺少二进制 %s：%v", src.ZipName, names)
		}
	}
	// 2008R2 兼容版为本仓库必有产物；yaml 与说明必在
	if !names["im-gateway-2008r2.exe"] || !names["gateway.yaml"] || !names["部署说明.txt"] {
		t.Fatalf("zip 缺少必备文件：%v", names)
	}
	if yamlContent != gatewayTemplateYAML {
		t.Fatal("gateway.yaml 必须与服务端模板逐字一致（保证包内无任何真实密钥）")
	}
}

// TestMerchantQuotaAllocation 管理员按商户分配专属存储配额（安全加固）三分支回归：
// 专属 >0 覆盖全局 / -1 不限量 / 0 未分配回退全局；专属配额下的拒绝/放行路径；
// 编辑接口入参校验（-2 等非法值 400，合法值落库后即时生效）。测试数据 mtest_ 前缀用后即清。
func TestMerchantQuotaAllocation(t *testing.T) {
	merchantTestSeed(t, "mtest_quota", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	global := s.cfg.Game.MerchantQuotaBytes
	const gbyte = int64(1) << 30

	// 1) 未分配（0）→ 回退全局配额
	if got := s.merchantQuotaLimit("mtest_quota"); got != global {
		t.Fatalf("未分配应回退全局配额 %d, 实得 %d", global, got)
	}

	// 2) 专属 10GB 覆盖全局：已用 0 时 11GB 拒绝 / 9GB 放行
	store.DB.Model(&model.Merchant{}).Where("username = ?", "mtest_quota").Update("storage_quota_bytes", 10*gbyte)
	if got := s.merchantQuotaLimit("mtest_quota"); got != 10*gbyte {
		t.Fatalf("专属配额应生效 10GB, 实得 %d", got)
	}
	if err := s.gameMerchantQuotaCheck("mtest_quota", 11*gbyte); err == nil {
		t.Fatal("11GB 超出专属 10GB 配额应被拒绝")
	}
	if err := s.gameMerchantQuotaCheck("mtest_quota", 9*gbyte); err != nil {
		t.Fatalf("9GB 未超专属配额不应拒绝: %v", err)
	}

	// 3) -1 不限量：任意大小放行，解析值 -1
	store.DB.Model(&model.Merchant{}).Where("username = ?", "mtest_quota").Update("storage_quota_bytes", -1)
	if got := s.merchantQuotaLimit("mtest_quota"); got != -1 {
		t.Fatalf("不限量应解析为 -1, 实得 %d", got)
	}
	if err := s.gameMerchantQuotaCheck("mtest_quota", 1<<40); err != nil {
		t.Fatalf("不限量配额不应拒绝: %v", err)
	}

	// 4) 重置 0 → 再次回退全局（管理员"取消专属"路径）
	store.DB.Model(&model.Merchant{}).Where("username = ?", "mtest_quota").Update("storage_quota_bytes", 0)
	if got := s.merchantQuotaLimit("mtest_quota"); got != global {
		t.Fatalf("重置后应回退全局 %d, 实得 %d", global, got)
	}

	// 5) 编辑接口入参校验：-2 等非法值 400；合法值（5GB）落库即时生效
	req := httptest.NewRequest("PUT", "/admin/api/merchants/mtest_quota", strings.NewReader(`{"storage_quota_bytes":-2}`))
	req.SetPathValue("username", "mtest_quota")
	rec := httptest.NewRecorder()
	s.handleAdminMerchantUpdate(rec, req)
	if rec.Code != 400 {
		t.Fatalf("非法配额 -2 应 400, 实得 %d %s", rec.Code, rec.Body.String())
	}
	req2 := httptest.NewRequest("PUT", "/admin/api/merchants/mtest_quota", strings.NewReader(`{"storage_quota_bytes":5368709120}`))
	req2.SetPathValue("username", "mtest_quota")
	rec2 := httptest.NewRecorder()
	s.handleAdminMerchantUpdate(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("合法配额 5GB 应保存成功, 实得 %d %s", rec2.Code, rec2.Body.String())
	}
	if got := s.merchantQuotaLimit("mtest_quota"); got != 5*gbyte {
		t.Fatalf("编辑后专属配额应生效 5GB, 实得 %d", got)
	}
}

// TestMerchantDirectHTTP 商户直连 HTTP（download_method=3）全链路回归：
// 版本登记无分片会话（纯清单）→ StoragePath 空 → manifest url 拼接商户地址（QueryEscape）
// → pack_type=1 / 携带 upload_id 拒绝 → 编辑 dm=3 空 base_url 拒绝。测试数据 mtest_ 前缀用后即清。
func TestMerchantDirectHTTP(t *testing.T) {
	merchantTestSeed(t, "mtest_direct", 0, 100)
	t.Cleanup(func() { merchantTestCleanup(t) })
	s := dbwServer(t)
	token := merchantTestToken(t, "mtest_direct")
	g := merchantTestSeedGame(t, "mtest_direct", "mtest-direct", "直连游戏", model.GameAuditApproved, 0)
	store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(map[string]interface{}{
		"download_method": 3, "direct_base_url": "https://cdn.mtest.com/g/",
	})
	store.DB.First(&g, g.ID)
	const gbyte = int64(1) << 30

	// 1) 直连登记：无 upload_id 纯清单 → 成功；StoragePath 空、pack_type=0、size 累加正确
	code, resp := registerPackVersion(t, s, token, g.ID, "v1", 0, 0, []map[string]interface{}{
		{"rel_path": "bin/game.exe", "size": 1024, "sha256": strings.Repeat("a", 64)},
		{"rel_path": "数据/readme.txt", "size": 128, "sha256": strings.Repeat("b", 64)},
	})
	if code != 200 {
		t.Fatalf("直连登记应成功: %d %v", code, resp)
	}
	vid := uint(resp["version_id"].(float64))
	var v model.GameVersion
	store.DB.First(&v, vid)
	if v.PackType != 0 || v.SizeBytes != 1152 || v.FileCount != 2 {
		t.Fatalf("直连版本行口径不符: %+v", v)
	}
	var files []model.GameFile
	store.DB.Where("version_id = ?", vid).Find(&files)
	if len(files) != 2 {
		t.Fatalf("文件行应 2 条, 实得 %d", len(files))
	}
	for _, f := range files {
		if f.StoragePath != "" {
			t.Fatalf("直连文件 StoragePath 应为空: %s", f.StoragePath)
		}
	}

	// 2) manifest：url 拼接商户地址（rel_path QueryEscape）+ download_method=3
	m, err := s.gameManifest(&g, "v1")
	if err != nil {
		t.Fatalf("清单构建失败: %v", err)
	}
	if dm, ok := m["download_method"].(int8); !ok || dm != 3 {
		t.Fatalf("清单应下发 download_method=3, 实得 %v", m["download_method"])
	}
	mFiles := m["files"].([]map[string]interface{})
	var directURL string
	for _, mf := range mFiles {
		if mf["rel_path"] == "数据/readme.txt" {
			directURL = mf["url"].(string)
		}
	}
	if want := "https://cdn.mtest.com/g/" + url.QueryEscape("数据/readme.txt"); directURL != want {
		t.Fatalf("直连 url 应为 %q, 实得 %q", want, directURL)
	}

	// 3) pack_type=1 拒绝（直连一期仅散文件清单）
	code1, _ := registerPackVersion(t, s, token, g.ID, "v2", 1, gbyte, []map[string]interface{}{
		{"rel_path": "game.zip", "size": gbyte, "sha256": strings.Repeat("c", 64)},
	})
	if code1 != 400 {
		t.Fatalf("直连 pack_type=1 应 400, 实得 %d", code1)
	}

	// 4) 携带 upload_id 拒绝（直连模式无需分片）
	codeU, _ := registerPackVersion(t, s, token, g.ID, "v3", 0, 0, []map[string]interface{}{
		{"rel_path": "x.txt", "size": 1, "sha256": strings.Repeat("d", 64), "upload_id": "up-x"},
	})
	if codeU != 400 {
		t.Fatalf("直连携带 upload_id 应 400, 实得 %d", codeU)
	}

	// 5) 编辑 dm=3 但 base_url 为空 → 拒绝（清洗归口）
	body, _ := json.Marshal(map[string]interface{}{"name": "直连游戏V2", "download_method": 3, "direct_base_url": ""})
	req := httptest.NewRequest("PUT", "/api/merchant/games/"+fmt.Sprint(g.ID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprint(g.ID))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.merchantGuard(s.handleMerchantGameUpdate)(rec, req)
	if rec.Code != 400 {
		t.Fatalf("dm=3 空 base_url 编辑应 400, 实得 %d %s", rec.Code, rec.Body.String())
	}

	// 6) 管理端详情回填直连地址（回归：详情接口漏下发曾致管理员编辑保存清空 base_url）
	reqD := httptest.NewRequest("GET", "/admin/api/game/"+fmt.Sprint(g.ID), nil)
	reqD.SetPathValue("id", fmt.Sprint(g.ID))
	recD := httptest.NewRecorder()
	s.handleAdminGameDetail(recD, reqD)
	if recD.Code != 200 {
		t.Fatalf("管理端详情应 200, 实得 %d", recD.Code)
	}
	var detail struct {
		OK   bool                   `json:"ok"`
		Data map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(recD.Body.Bytes(), &detail); err != nil {
		t.Fatalf("详情解析失败: %v", err)
	}
	if detail.Data["direct_base_url"] != "https://cdn.mtest.com/g/" {
		t.Fatalf("管理端详情应回填 direct_base_url, 实得 %v", detail.Data["direct_base_url"])
	}
}
