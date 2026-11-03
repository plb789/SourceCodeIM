package server

// 积分兑换网关充值链路集成测试（真实 MySQL：TestMain 已锚定 bin/config.yaml，无库环境自动退出）。
// 覆盖：档位解析/归一、下单校验链（档位白名单/日限额/余额）、事务扣分+建单、
// 网关按 recharge_gw 过滤拉取（响应不下发 points）、ack 成功/失败退分幂等、超时扫描退分幂等。
// 测试数据全部用 gwrtest_ / gw-gwrtest 前缀并在末尾清理，不触碰真实数据。

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"im-server/gwproto"
	"im-server/model"
	"im-server/store"
)

const gwrTestUser = "gwrtest_user"
const gwrTestUser2 = "gwrtest_user2"
const gwrTestGw = "gw-gwrtest"

// gwrSetup 测试基建：地址簿条目 + 充值游戏（档位 100/500/1000，汇率 10，日限额 600）+ 测试用户
func gwrSetup(t *testing.T) uint {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.GatewayBook{}, &model.Game{}, &model.User{}, &model.RechargeOrder{}, &model.PointsLog{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	gwrCleanup(t)
	row := model.GatewayBook{Name: gwrTestGw, Addr: "127.0.0.1:30100", Fingerprint: "aa", Enabled: true, Sort: -96}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatalf("地址簿测试行创建失败：%v", err)
	}
	// 第二条目（本用例自建，避免依赖 dbwrite 用例的条目）：承接其他网关拉取为空的断言
	row2 := model.GatewayBook{Name: gwrTestGw + "-b", Addr: "127.0.0.1:30101", Fingerprint: "bb", Enabled: true, Sort: -95}
	if err := store.DB.Create(&row2).Error; err != nil {
		t.Fatalf("地址簿测试行2创建失败：%v", err)
	}
	g := model.Game{Slug: "gwrtest-game", Name: "充值测试游戏", Status: 0,
		RechargeEnabled: true, RechargeGw: gwrTestGw, RechargeRate: 10,
		RechargeTiers: `[100,500,1000]`, RechargeDailyMax: 600, GameSecret: "gwrtest-secret"}
	if err := store.DB.Create(&g).Error; err != nil {
		t.Fatalf("游戏测试行创建失败：%v", err)
	}
	u := model.User{Username: gwrTestUser, Points: 800}
	if err := store.DB.Create(&u).Error; err != nil {
		t.Fatalf("用户测试行创建失败：%v", err)
	}
	return g.ID
}

func gwrCleanup(t *testing.T) {
	t.Helper()
	store.DB.Where("username LIKE ?", "gwrtest_%").Delete(&model.RechargeOrder{})
	store.DB.Where("username LIKE ?", "gwrtest_%").Delete(&model.PointsLog{})
	store.DB.Where("username LIKE ?", "gwrtest_%").Delete(&model.User{})
	store.DB.Where("slug LIKE ?", "gwrtest-%").Delete(&model.Game{})
	store.DB.Where("name LIKE ?", gwrTestGw+"%").Delete(&model.GatewayBook{})
}

// gwrOrder POST /api/game/recharge 归口：返回 (code, respJSON)。
// adminJSON 统一包装 {"ok":true,"data":{...}}：此处解包 data 并回填 ok，断言按平铺字段书写
func gwrOrder(t *testing.T, s *Server, username string, gameID uint, points float64) (int, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{"game_id": gameID, "points": points})
	uri := "/api/game/recharge?username=" + username
	req := httptest.NewRequest("POST", uri, bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.HandleGameRecharge(rec, req)
	return gwrUnwrap(rec)
}

// gwrUnwrap adminJSON 包装解包归口（失败响应无 data，仅回填 ok）
func gwrUnwrap(rec *httptest.ResponseRecorder) (int, map[string]interface{}) {
	var out struct {
		Ok   bool                   `json:"ok"`
		Msg  string                 `json:"msg"`
		Data map[string]interface{} `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Data == nil {
		out.Data = map[string]interface{}{}
	}
	out.Data["ok"] = out.Ok
	out.Data["msg"] = out.Msg
	return rec.Code, out.Data
}

func gwrBalance(t *testing.T, username string) float64 {
	t.Helper()
	var p float64
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Select("points").Scan(&p).Error; err != nil {
		t.Fatalf("查询用户余额失败：%v", err)
	}
	return p
}

// gwrPull 网关拉取待执行订单（签名/解密归口与 dbwrite 测试一致）
func gwrPull(t *testing.T, s *Server, gw string) (int, []map[string]interface{}) {
	t.Helper()
	secret := s.gameGatewaySecret()
	uri := "/internal/gateway/recharge?gw=" + gw
	req := httptest.NewRequest("GET", uri, nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(secret, time.Now(), "GET", uri, nil))
	rec := httptest.NewRecorder()
	s.handleInternalGatewayRecharge(rec, req)
	if rec.Code != 200 {
		return rec.Code, nil
	}
	plain, err := gwproto.OpenResp(secret, rec.Body.String(), rec.Header().Get(gwproto.RespEncHeader))
	if err != nil {
		t.Fatalf("拉取响应解密失败：%v", err)
	}
	var out struct {
		Items []map[string]interface{} `json:"items"`
	}
	if err := json.Unmarshal(plain, &out); err != nil {
		t.Fatalf("响应 JSON 解析失败：%v", err)
	}
	return rec.Code, out.Items
}

// gwrAck 网关回执（body 纳签）
func gwrAck(t *testing.T, s *Server, gw string, okIDs []uint64, failed []map[string]interface{}) (int, map[string]interface{}) {
	t.Helper()
	payload := map[string]interface{}{"gw": gw, "ok": okIDs, "failed": failed}
	body, _ := json.Marshal(payload)
	uri := "/internal/gateway/recharge/ack"
	req := httptest.NewRequest("POST", uri, bytes.NewReader(body))
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now(), "POST", uri, body))
	rec := httptest.NewRecorder()
	s.handleInternalGatewayRechargeAck(rec, req)
	return gwrUnwrap(rec)
}

func TestRechargeTiersParse(t *testing.T) {
	// JSON 数组解析 + 升序去重
	if tiers := rechargeTiersParse(`[500,100,500,1000]`); len(tiers) != 3 || tiers[0] != 100 || tiers[2] != 1000 {
		t.Fatalf("档位解析/去重/升序不符：%v", tiers)
	}
	if tiers := rechargeTiersParse(``); tiers != nil {
		t.Fatalf("空串应返回 nil：%v", tiers)
	}
	if tiers := rechargeTiersParse(`not-json`); tiers != nil {
		t.Fatalf("非法 JSON 应返回 nil：%v", tiers)
	}
	// 归一：逗号分隔录入 → JSON 数组串；中文逗号兼容；负数/非法拒绝
	norm, err := rechargeTiersNormalize(`100，200, 300`)
	if err != nil || norm != "[100,200,300]" {
		t.Fatalf("逗号归一不符：%q err=%v", norm, err)
	}
	if _, err := rechargeTiersNormalize(`100,abc`); err == nil {
		t.Fatal("非法片段应报错")
	}
	if _, err := rechargeTiersNormalize(`[100,0,-5]`); err == nil {
		t.Fatal("非正数档位应报错")
	}
}

func TestRechargeGuard(t *testing.T) {
	s := dbwServer(t)
	// 无 token → 401（DriveTokenVerify 空 token 直接 false，不依赖 Redis）
	body, _ := json.Marshal(map[string]interface{}{"game_id": uint(1), "points": 100.0})
	req := httptest.NewRequest("POST", "/api/game/recharge?username=gwrtest_user", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.guardRecharge(s.HandleGameRecharge)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 下单应 401，实得 %d", rec.Code)
	}
	// 记录接口同水位
	req = httptest.NewRequest("GET", "/api/game/recharge/orders?username=gwrtest_user", nil)
	rec = httptest.NewRecorder()
	s.guardRecharge(s.HandleGameRechargeOrders)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 查记录应 401，实得 %d", rec.Code)
	}
}

func TestGameGuard(t *testing.T) {
	s := dbwServer(t)
	// guardGame（存量接口收口守卫）：无 token → 401（不依赖 Redis；Token 缺失即拒绝）
	req := httptest.NewRequest("POST", "/api/game/library/1?username=gwrtest_user", nil)
	rec := httptest.NewRecorder()
	s.guardGame(s.HandleGameLibraryJoin)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 入库应 401，实得 %d", rec.Code)
	}
	req = httptest.NewRequest("GET", "/api/game/save/slots/1?username=gwrtest_user", nil)
	rec = httptest.NewRecorder()
	s.guardGame(s.HandleGameSaveSlots)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 查存档槽位应 401，实得 %d", rec.Code)
	}
	// token 归属不符 → 401（伪造他人 username 即便带自己的 token 也拒绝）
	req = httptest.NewRequest("POST", "/api/game/library/1?username=gwrtest_user", nil)
	req.Header.Set("X-Drive-Token", "forged-token")
	rec = httptest.NewRecorder()
	s.guardGame(s.HandleGameLibraryJoin)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("伪造 token 入库应 401，实得 %d", rec.Code)
	}
}

func TestRechargeOrderFlow(t *testing.T) {
	gid := gwrSetup(t)
	t.Cleanup(func() { gwrCleanup(t) })
	s := dbwServer(t)

	// 1. 非档位数值（377）→ 400，不扣分不建单
	code, _ := gwrOrder(t, s, gwrTestUser, gid, 377)
	if code != 400 {
		t.Fatalf("非档位数值应 400，实得 %d", code)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != 800 {
		t.Fatalf("非档位拒绝不应扣分，余额 %v ≠ 800", bal)
	}

	// 2. 正常下单 100 → 事务扣分 + 建单 + 到账快照（汇率 10 → 1000）+ 流水
	code, resp := gwrOrder(t, s, gwrTestUser, gid, 100)
	if code != 200 || resp["ok"] != true {
		t.Fatalf("档位 100 下单应 200：%d %v", code, resp)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != 700 {
		t.Fatalf("下单后余额应 700，实得 %v", bal)
	}
	orderID := uint64(resp["order_id"].(float64))
	if resp["amount"].(float64) != 1000 {
		t.Fatalf("到账快照应 1000（100×10），实得 %v", resp["amount"])
	}
	var order model.RechargeOrder
	if err := store.DB.First(&order, orderID).Error; err != nil || order.Status != model.RechargeOrderStatusPending || order.Gw != gwrTestGw {
		t.Fatalf("订单状态不符：%v err=%v", order, err)
	}
	var logCnt int64
	store.DB.Model(&model.PointsLog{}).Where("username = ? AND reason = ?", gwrTestUser, "game_recharge").Count(&logCnt)
	if logCnt != 1 {
		t.Fatalf("game_recharge 流水应 1 条，实得 %d", logCnt)
	}

	// 3. 连续下单 500（日累计恰 600=上限）→ 成功；余额 200
	code, _ = gwrOrder(t, s, gwrTestUser, gid, 500)
	if code != 200 {
		t.Fatalf("日限额内下单应 200，实得 %d", code)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != 200 {
		t.Fatalf("两次下单后余额应 200，实得 %v", bal)
	}

	// 4. 再下 100 → 超日限额（600+100>600）→ 400
	code, _ = gwrOrder(t, s, gwrTestUser, gid, 100)
	if code != 400 {
		t.Fatalf("超日限额应 400，实得 %d", code)
	}

	// 5. 余额不足（用户2 仅 50）→ 400 不透支
	u2 := model.User{Username: gwrTestUser2, Points: 50}
	if err := store.DB.Create(&u2).Error; err != nil {
		t.Fatalf("用户2创建失败：%v", err)
	}
	code, _ = gwrOrder(t, s, gwrTestUser2, gid, 100)
	if code != 400 {
		t.Fatalf("余额不足应 400，实得 %d", code)
	}
	if bal := gwrBalance(t, gwrTestUser2); bal != 50 {
		t.Fatalf("余额不足不应扣分，余额 %v ≠ 50", bal)
	}

	// 6. 网关拉取：仅本网关 pending 订单；响应绝不下发 points 字段
	code, items := gwrPull(t, s, gwrTestGw)
	if code != 200 || len(items) != 2 {
		t.Fatalf("拉取应 200 且 2 条 pending，code=%d items=%v", code, items)
	}
	raw, _ := json.Marshal(items)
	if strings.Contains(string(raw), "points") {
		t.Fatalf("拉取响应泄漏 points：%s", raw)
	}
	// 不承接该网关充值（recharge_gw 不匹配）的其他网关拉不到
	code, items = gwrPull(t, s, gwrTestGw+"-b")
	if code != 200 || len(items) != 0 {
		t.Fatalf("其他网关拉取应为空：%d %v", code, items)
	}

	// 7. ack 成功订单1 → success；再拉取只剩订单2；重复 ack 幂等（不重复计数）
	okID := uint64(resp["order_id"].(float64))
	var pendings []model.RechargeOrder
	store.DB.Where("username = ? AND game_id = ? AND status = ? AND id <> ?", gwrTestUser, gid, model.RechargeOrderStatusPending, okID).
		Order("id ASC").Find(&pendings)
	if len(pendings) != 1 {
		t.Fatalf("除订单1外应恰剩 1 条 pending（订单2），实得 %d", len(pendings))
	}
	order2ID := pendings[0].ID
	code, aresp := gwrAck(t, s, gwrTestGw, []uint64{okID}, nil)
	if code != 200 || aresp["acked"].(float64) != 1 {
		t.Fatalf("成功回执应 acked=1：%d %v", code, aresp)
	}
	var o1 model.RechargeOrder // 独立变量：复用带主键的 dest 会让 gorm 把旧主键并入查询条件（实测踩坑）
	if err := store.DB.First(&o1, okID).Error; err != nil || o1.Status != model.RechargeOrderStatusSuccess {
		t.Fatalf("订单1应 success：%+v err=%v", o1, err)
	}
	code, items = gwrPull(t, s, gwrTestGw)
	if code != 200 || len(items) != 1 || uint64(items[0]["id"].(float64)) != order2ID {
		t.Fatalf("回执后应只剩订单2：%d %v", code, items)
	}
	code, aresp = gwrAck(t, s, gwrTestGw, []uint64{okID}, nil)
	if code != 200 || aresp["acked"].(float64) != 0 {
		t.Fatalf("重复回执应幂等 acked=0：%v", aresp)
	}

	// 8. ack 失败订单2 → failed + 全额退分（200+500=700）+ 退分流水
	balBefore := gwrBalance(t, gwrTestUser)
	code, aresp = gwrAck(t, s, gwrTestGw, nil, []map[string]interface{}{{"id": order2ID, "reason": "游戏库连接失败"}})
	if code != 200 || aresp["refunded"].(float64) != 1 {
		t.Fatalf("失败回执应 refunded=1：%d %v", code, aresp)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != balBefore+500 {
		t.Fatalf("失败退分后余额应 %v，实得 %v", balBefore+500, bal)
	}
	var o2 model.RechargeOrder
	if err := store.DB.First(&o2, order2ID).Error; err != nil || o2.Status != model.RechargeOrderStatusFailed || !strings.Contains(o2.FailReason, "游戏库连接失败") {
		t.Fatalf("订单2终态/原因不符：%+v err=%v", o2, err)
	}
	// 9. 重复失败回执 → 幂等不双退
	code, aresp = gwrAck(t, s, gwrTestGw, nil, []map[string]interface{}{{"id": order2ID, "reason": "重复"}})
	if code != 200 || aresp["refunded"].(float64) != 0 {
		t.Fatalf("重复失败回执应幂等 refunded=0：%v", aresp)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != balBefore+500 {
		t.Fatalf("重复退分不应再扣加，余额 %v", bal)
	}

	// 10. 超时扫描：pending 订单回拨 31 分钟 → sweep 退分；重复 sweep 幂等
	code, resp3 := gwrOrder(t, s, gwrTestUser, gid, 100)
	if code != 200 {
		t.Fatalf("超时用例下单应 200：%d", code)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != balBefore+400 {
		t.Fatalf("超时用例下单后余额应 %v，实得 %v", balBefore+400, bal)
	}
	timeoutID := uint64(resp3["order_id"].(float64))
	past := time.Now().Add(-31 * time.Minute)
	store.DB.Model(&model.RechargeOrder{}).Where("id = ?", timeoutID).Update("create_time", past)
	if n := rechargeTimeoutSweep(); n != 1 {
		t.Fatalf("超时扫描应退 1 单，实得 %d", n)
	}
	if bal := gwrBalance(t, gwrTestUser); bal != balBefore+500 {
		t.Fatalf("超时退分后余额应 %v，实得 %v", balBefore+500, bal)
	}
	if n := rechargeTimeoutSweep(); n != 0 {
		t.Fatalf("重复扫描应幂等 0，实得 %d", n)
	}

	// 11. 越权面：非地址簿网关回执/拉取 → 403；篡改 gw 回执他人订单 → 无效果
	uri := "/internal/gateway/recharge?gw=gw-not-in-book"
	req := httptest.NewRequest("GET", uri, nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now(), "GET", uri, nil))
	rec := httptest.NewRecorder()
	s.handleInternalGatewayRecharge(rec, req)
	if rec.Code != 403 {
		t.Fatalf("地址簿外网关拉取应 403，实得 %d", rec.Code)
	}
	code, _ = gwrAck(t, s, "gw-not-in-book", []uint64{okID}, nil)
	if code != 403 {
		t.Fatalf("地址簿外网关回执应 403，实得 %d", code)
	}
}
