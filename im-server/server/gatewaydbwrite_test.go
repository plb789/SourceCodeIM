package server

// 端口透传·网关写库链路集成测试（真实 MySQL：TestMain 已锚定 bin/config.yaml，无库环境自动退出）。
// 覆盖：入队过滤（仅网关规则游戏）与幂等、按网关过滤拉取（gw 指定/缺省归属互斥）、
// 响应 AES-GCM 加密、ack 回执幂等、签名攻击面（无签名/过期/篡改 body）拒绝。
// 测试数据全部用 gw-dbwtest / gw_dbwtest_ 前缀并在末尾清理，不触碰真实数据。

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"im-server/config"
	"im-server/gwproto"
	"im-server/model"
	"im-server/store"
)

const dbwTestUser = "gw_dbwtest_user"
const dbwTestSecret = "dbwtest-launch-secret"

// dbwOneSecret 地址簿测试条目 gw-dbwtest-one 的专属密钥（逐网关独立密钥主路径断言用）
const dbwOneSecret = "1111111122222222333333334444444455555555666666667777777788888888"

// dbwSetup 测试地址簿与游戏行（sort 控制：gw-one 排第一 = 缺省规则归属；返回三个游戏 ID）
func dbwSetup(t *testing.T) (gameTwo, gameDefault, gameWriteOnly uint) {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.GatewayBook{}, &model.Game{}, &model.GatewayDbwrite{}, &model.GatewayDbwriteAck{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	// 清理历史测试残留（幂等可重跑）
	dbwCleanup(t)
	// 地址簿两条目：one 带专属密钥（逐网关独立密钥主路径）；two 不带（回退共享密钥兼容路径）
	for name, sortv := range map[string]int{"gw-dbwtest-one": -99, "gw-dbwtest-two": -98} {
		row := model.GatewayBook{Name: name, Addr: "127.0.0.1:30100", Fingerprint: "aa", Enabled: true, Sort: sortv}
		if name == "gw-dbwtest-one" {
			row.Secret = dbwOneSecret
		}
		if err := store.DB.Create(&row).Error; err != nil {
			t.Fatalf("地址簿测试行创建失败：%v", err)
		}
	}
	// 游戏两：规则 @gw-dbwtest-two（仅 two 可拉），带专属密钥（主路径派生）；
	// 游戏缺省：gw 空串（归第一条=one），不带专属密钥（验证回退全局 launch_secret 兜底路径）；
	// 游戏仅写库：无转发规则、dbwrite_gw=gw-dbwtest-one（仅写库归属路径）
	g2 := model.Game{Slug: "dbwtest-g2", Name: "写库测试游戏二", GameSecret: "dbwtest-game-secret-2",
		PortForwards: `[{"proto":"tcp","mode":"gateway","gw":"gw-dbwtest-two","listen":3054,"remote_port":3054}]`}
	gd := model.Game{Slug: "dbwtest-gd", Name: "写库测试游戏缺省",
		PortForwards: `[{"proto":"udp","mode":"gateway","gw":"","listen":3053,"remote_port":3053}]`}
	gw3 := model.Game{Slug: "dbwtest-g3", Name: "写库测试游戏仅写库", DbwriteGw: "gw-dbwtest-one"}
	if err := store.DB.Create(&g2).Error; err != nil {
		t.Fatalf("游戏测试行创建失败：%v", err)
	}
	if err := store.DB.Create(&gd).Error; err != nil {
		t.Fatalf("游戏测试行创建失败：%v", err)
	}
	if err := store.DB.Create(&gw3).Error; err != nil {
		t.Fatalf("游戏测试行创建失败：%v", err)
	}
	return g2.ID, gd.ID, gw3.ID
}

func dbwCleanup(t *testing.T) {
	t.Helper()
	store.DB.Where("slug LIKE ?", "dbwtest-%").Delete(&model.Game{})
	store.DB.Where("name LIKE ?", "gw-dbwtest-%").Delete(&model.GatewayBook{})
	// 队列/回执按测试用户前缀清（含派生用户 dbwTestUser-empty 等，防失败路径残留跨运行累计）
	store.DB.Where("username LIKE ?", dbwTestUser+"%").Delete(&model.GatewayDbwrite{})
	store.DB.Where("username LIKE ?", dbwTestUser+"%").Delete(&model.GatewayDbwriteAck{})
	store.DB.Where("gateway_name LIKE ?", "gw-dbwtest-%").Delete(&model.GatewayDbwriteAck{})
}

func dbwServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.Load()
	return &Server{cfg: cfg}
}

// dbwPull 按网关拉取（密钥选择归口与 gwDbwriteAuth 一致：条目专属密钥优先，回退共享）
func dbwPull(t *testing.T, s *Server, gw string) (code int, items []map[string]interface{}) {
	t.Helper()
	secret := s.gameGatewaySecret()
	if gw == "gw-dbwtest-one" {
		secret = dbwOneSecret
	}
	uri := "/internal/gateway/dbwrite?gw=" + gw
	req := httptest.NewRequest("GET", uri, nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(secret, time.Now(), "GET", uri, nil))
	rec := httptest.NewRecorder()
	s.handleInternalGatewayDbwrite(rec, req)
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

func TestGwDbwriteFlow(t *testing.T) {
	g2, gd, gw3 := dbwSetup(t)
	t.Cleanup(func() { dbwCleanup(t) }) // 测试结束清理全部测试行（游戏/地址簿/队列/回执）
	s := dbwServer(t)

	// 1. 入队（含直连规则与无规则游戏一并传入，应被过滤；仅写库游戏 gw3 按 dbwrite_gw 归属入队）
	onlyGateway := []uint{g2, gd, gw3}
	gwDbwriteEnqueue(dbwTestUser, dbwTestSecret, onlyGateway)
	var rows []model.GatewayDbwrite
	store.DB.Where("username = ?", dbwTestUser).Find(&rows)
	if len(rows) != 3 {
		t.Fatalf("入队应恰好 3 行（两条网关规则游戏 + 一条仅写库游戏），实得 %d", len(rows))
	}
	// 密码派生断言：g2 按游戏专属密钥（主路径）；gd/gw3 无专属密钥回退全局 launch_secret（兜底路径）
	pw2 := gameLaunchPassword("dbwtest-game-secret-2", dbwTestUser, g2)
	for _, r := range rows {
		want := pw2
		if r.GameID == gd || r.GameID == gw3 {
			want = gameLaunchPassword(dbwTestSecret, dbwTestUser, r.GameID)
		}
		if r.Password != want {
			t.Fatalf("启动密码派生不符（游戏#%d）：%s ≠ %s", r.GameID, r.Password, want)
		}
	}

	// 2. 重复入队幂等（不产生新行）
	gwDbwriteEnqueue(dbwTestUser, dbwTestSecret, onlyGateway)
	var rows2Count int64
	store.DB.Model(&model.GatewayDbwrite{}).Where("username = ?", dbwTestUser).Count(&rows2Count)
	if rows2Count != 3 {
		t.Fatalf("重复入队应仍为 3 行，实得 %d", rows2Count)
	}

	// 2.5 兜底密钥缺失语义（空 launchSecret 不再整体阻断——有专属密钥的游戏主路径不受影响）：
	//     g2 有专属密钥 → 正常入队；gd/gw3 无专属密钥且兜底为空 → 跳过（派生无材料，空密钥 HMAC 密码等同无防护）
	emptyUser := dbwTestUser + "-empty"
	store.DB.Where("username = ?", emptyUser).Delete(&model.GatewayDbwrite{}) // 清历史运行残留（幂等起点）
	gwDbwriteEnqueue(emptyUser, "", onlyGateway)
	var pwEmpty string
	if err := store.DB.Model(&model.GatewayDbwrite{}).Where("username = ? AND game_id = ?", emptyUser, g2).Pluck("password", &pwEmpty).Error; err != nil || pwEmpty == "" {
		t.Fatalf("空兜底密钥：有专属密钥的游戏应正常入队（err=%v pw=%q）", err, pwEmpty)
	}
	if pwEmpty != gameLaunchPassword("dbwtest-game-secret-2", emptyUser, g2) {
		t.Fatalf("空兜底下专属密钥派生密码不符：%s ≠ 期望（按 emptyUser+专属密钥派生）", pwEmpty)
	}
	var cntEmpty int64
	store.DB.Model(&model.GatewayDbwrite{}).Where("username = ?", emptyUser).Count(&cntEmpty)
	if cntEmpty != 1 {
		t.Fatalf("空兜底密钥：无专属密钥的游戏应跳过（仅专属密钥游戏入队 1 行），实得 %d", cntEmpty)
	}
	// 用后即删（拉取按网关过滤不分 username，残留行会污染步骤 3 的拉取计数断言）
	store.DB.Where("username = ?", emptyUser).Delete(&model.GatewayDbwrite{})

	// 3. 按网关过滤拉取：two 仅见游戏二；one 仅见缺省游戏（互斥）
	code, items := dbwPull(t, s, "gw-dbwtest-two")
	if code != 200 || len(items) != 1 {
		t.Fatalf("gw-dbwtest-two 拉取应 200 且恰 1 条，code=%d items=%v", code, items)
	}
	if int(items[0]["id"].(float64)) == 0 || items[0]["username"] != dbwTestUser {
		t.Fatalf("条目内容不符：%v", items[0])
	}
	code, items = dbwPull(t, s, "gw-dbwtest-one")
	if code != 200 || len(items) != 2 {
		t.Fatalf("gw-dbwtest-one 拉取应 200 且恰 2 条（缺省规则游戏 + 仅写库游戏），code=%d items=%v", code, items)
	}
	// 取缺省游戏 gd 的队列行 ID（供后续 ack 断言）
	var gdRow model.GatewayDbwrite
	if err := store.DB.Where("username = ? AND game_id = ?", dbwTestUser, gd).First(&gdRow).Error; err != nil {
		t.Fatalf("查询缺省游戏队列行失败：%v", err)
	}
	defaultID := gdRow.ID

	// 4. 无签名/过期签名 → 401
	req := httptest.NewRequest("GET", "/internal/gateway/dbwrite?gw=gw-dbwtest-one", nil)
	rec := httptest.NewRecorder()
	s.handleInternalGatewayDbwrite(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无签名拉取应 401，实得 %d", rec.Code)
	}
	req = httptest.NewRequest("GET", "/internal/gateway/dbwrite?gw=gw-dbwtest-one", nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now().Add(-10*time.Minute), "GET", "/internal/gateway/dbwrite?gw=gw-dbwtest-one", nil))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwrite(rec, req)
	if rec.Code != 401 {
		t.Fatalf("过期签名拉取应 401，实得 %d", rec.Code)
	}
	// 不在地址簿的网关 → 403
	uri := "/internal/gateway/dbwrite?gw=gw-not-in-book"
	req = httptest.NewRequest("GET", uri, nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now(), "GET", uri, nil))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwrite(rec, req)
	if rec.Code != 403 {
		t.Fatalf("地址簿外网关应 403，实得 %d", rec.Code)
	}
	// 逐网关独立密钥：one（已配专属密钥）用共享密钥签名 → 401（签名通过=身份密码学验证）
	uri = "/internal/gateway/dbwrite?gw=gw-dbwtest-one"
	req = httptest.NewRequest("GET", uri, nil)
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now(), "GET", uri, nil))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwrite(rec, req)
	if rec.Code != 401 {
		t.Fatalf("专属密钥网关用共享密钥签名应 401，实得 %d", rec.Code)
	}
	// 下发结构断言：条目 token 按专属密钥签发（与顶层共享 token 不同）；无专属密钥条目不带 token
	resp := s.gameGatewayResp(dbwTestUser)
	if resp == nil {
		t.Fatal("gameGatewayResp 不应为空（地址簿已配置）")
	}
	// 泄漏面断言：用户端下发 JSON 绝不携带任何网关专属密钥（secret 仅管理端接口回显）
	respJSON, _ := json.Marshal(resp)
	if strings.Contains(string(respJSON), `"secret"`) || strings.Contains(string(respJSON), dbwOneSecret) {
		t.Fatalf("用户端下发结构泄漏 secret：%s", respJSON)
	}
	gws, _ := resp["gateways"].([]map[string]string)
	if len(gws) < 2 {
		t.Fatalf("下发条目应 ≥2，实得 %d", len(gws))
	}
	topToken, _ := resp["token"].(string)
	for _, g := range gws {
		if g["name"] == "gw-dbwtest-one" {
			want := gameGatewayToken(dbwOneSecret, dbwTestUser, time.Now())
			if g["token"] == "" || g["token"] == topToken {
				t.Fatalf("one 条目应携带专属 token（区别于顶层）：%q", g["token"])
			}
			if g["token"] != want {
				t.Fatalf("one 条目 token 应按专属密钥签发")
			}
		}
		if g["name"] == "gw-dbwtest-two" {
			if _, has := g["token"]; has {
				t.Fatalf("two 条目（无专属密钥）不应携带条目 token")
			}
		}
	}

	// 5. ack 回执（签名带 body；one 已配专属密钥，按该密钥签名——与真实网关行为一致）
	ackBody := []byte(`{"gw":"gw-dbwtest-one","ids":[` + uint64s(defaultID) + `]}`)
	uri = "/internal/gateway/dbwrite/ack"
	req = httptest.NewRequest("POST", uri, bytes.NewReader(ackBody))
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(dbwOneSecret, time.Now(), "POST", uri, ackBody))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwriteAck(rec, req)
	if rec.Code != 200 {
		t.Fatalf("ack 应 200，实得 %d：%s", rec.Code, rec.Body.String())
	}
	_, items = dbwPull(t, s, "gw-dbwtest-one")
	// 回执后仅剩仅写库游戏 gw3（未回执），缺省游戏 gd 条目应消失
	if len(items) != 1 {
		t.Fatalf("回执后 one 应恰剩 1 条（仅写库游戏），实得 %v", items)
	}
	if uint64(items[0]["id"].(float64)) == defaultID {
		t.Fatalf("回执的缺省游戏条目应已消失，仍返回：%v", items[0])
	}
	// 篡改 body 的 ack（签名与 body 不符）→ 401
	req = httptest.NewRequest("POST", uri, bytes.NewReader([]byte(`{"gw":"gw-dbwtest-one","ids":[999999]}`)))
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(dbwOneSecret, time.Now(), "POST", uri, ackBody))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwriteAck(rec, req)
	if rec.Code != 401 {
		t.Fatalf("篡改 body 的 ack 应 401，实得 %d", rec.Code)
	}
	// 共享密钥签名的 ack（对已配专属密钥的网关）→ 401（密钥错=身份不符）
	req = httptest.NewRequest("POST", uri, bytes.NewReader(ackBody))
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(s.gameGatewaySecret(), time.Now(), "POST", uri, ackBody))
	rec = httptest.NewRecorder()
	s.handleInternalGatewayDbwriteAck(rec, req)
	if rec.Code != 401 {
		t.Fatalf("共享密钥 ack 应 401，实得 %d", rec.Code)
	}
}

// uint64s 数字转 JSON 片段（测试内联构造 ack body 用）
func uint64s(v uint64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
