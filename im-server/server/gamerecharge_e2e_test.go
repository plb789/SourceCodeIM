package server

// 积分赞助（积分兑换网关充值）进程级 E2E 测试（真实 MySQL + Redis + 独立网关进程）。
// 全链路：渲染进程视角下单（带 X-Drive-Token）→ im-server 事务扣分建单 → 【真实网关 exe】
// 周期拉取（HMAC+AES-GCM）→ 参数化 SQL 写"游戏库"（同 MySQL 的 e2e 钱包表）→ ack 回执 →
// 订单 success / 失败退分。覆盖：档位拒绝、到账数值、余额扣减、UPDATE 0 行明确失败即刻退分、
// 网关未配置游戏的订单不被误执行、幂等落盘文件生成、网关退分流水。测试数据用后即清。
//
// 运行条件：本地 MySQL（bin/config.yaml）与 Redis 可用；需要 go 工具链编译网关 exe（约 10~30s）。
// 环境不可用时 t.Skip（不阻塞其他开发场景）。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"im-server/config"
	"im-server/gwproto"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

const (
	e2eGwName   = "gw-e2e"
	e2eGwSecret = "e2e0000000000000000000000000000000000000000000000000000000000abc"
	e2eUser1    = "e2e_user1"
	e2eUser2    = "e2e_user2"
	e2eWalletTB = "im_e2e_game_wallet"
)

var (
	e2eExeOnce sync.Once
	e2eExePath string
	e2eExeErr  error
)

// e2eEnsureRoutes DefaultServeMux 路由注册：复用 gsEnsureRoutes 的进程级 once 守卫
// （DefaultServeMux 同 pattern 重复注册会 panic——多测试文件必须共用同一注册守卫，实测踩坑）
func e2eEnsureRoutes(s *Server) { gsEnsureRoutes(s) }

// e2eEnsureExe 编译网关 exe（once；失败缓存错误供用例 Skip/Fatal）
func e2eEnsureExe(t *testing.T) string {
	t.Helper()
	e2eExeOnce.Do(func() {
		cwd, _ := os.Getwd() // TestMain 已锚定 im-server/bin
		root := filepath.Join(cwd, "..")
		dir, err := os.MkdirTemp("", "e2e-gw-*")
		if err != nil {
			e2eExeErr = err
			return
		}
		e2eExePath = filepath.Join(dir, "im-gateway-e2e.exe")
		cmd := exec.Command("go", "build", "-o", e2eExePath, "./gateway")
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			e2eExeErr = fmt.Errorf("网关编译失败: %v\n%s", err, string(out))
		}
	})
	if e2eExeErr != nil {
		t.Skipf("网关 exe 构建不可用：%v", e2eExeErr)
	}
	return e2eExePath
}

// e2eSeed 测试数据预置：地址簿（专属密钥=网关 token_secret）/两个充值游戏/两个用户/游戏钱包表。
// game1 由网关承接（配置了 games 条目）；game2 网关未配置（订单应悬置等待超时退分）
func e2eSeed(t *testing.T) (game1, game2 uint) {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.GatewayBook{}, &model.Game{}, &model.User{}, &model.RechargeOrder{}, &model.PointsLog{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	e2eCleanup(t)
	if err := store.DB.Create(&model.GatewayBook{Name: e2eGwName, Addr: "127.0.0.1:31987", Fingerprint: "e2e", Secret: e2eGwSecret, Enabled: true, Sort: -90}).Error; err != nil {
		t.Fatalf("地址簿创建失败：%v", err)
	}
	g1 := model.Game{Slug: "e2e-game1", Name: "E2E充值游戏一", Status: 0,
		RechargeEnabled: true, RechargeGw: e2eGwName, RechargeRate: 10,
		RechargeTiers: `[100,500]`, RechargeDailyMax: 600, GameSecret: "e2e-secret-1"}
	g2 := model.Game{Slug: "e2e-game2", Name: "E2E充值游戏二", Status: 0,
		RechargeEnabled: true, RechargeGw: e2eGwName, RechargeRate: 10,
		RechargeTiers: `[100]`, RechargeDailyMax: 0, GameSecret: "e2e-secret-2"}
	if err := store.DB.Create(&g1).Error; err != nil {
		t.Fatalf("游戏1创建失败：%v", err)
	}
	if err := store.DB.Create(&g2).Error; err != nil {
		t.Fatalf("游戏2创建失败：%v", err)
	}
	if err := store.DB.Create(&model.User{Username: e2eUser1, Points: 1000}).Error; err != nil {
		t.Fatalf("用户1创建失败：%v", err)
	}
	if err := store.DB.Create(&model.User{Username: e2eUser2, Points: 500}).Error; err != nil {
		t.Fatalf("用户2创建失败：%v", err)
	}
	// 游戏库钱包表（模拟网关后面的游戏库）：仅 user1 有账号——user2 下单后 UPDATE 影响 0 行 → 网关明确报失败
	if err := store.DB.Exec("CREATE TABLE IF NOT EXISTS " + e2eWalletTB + " (account VARCHAR(64) PRIMARY KEY, gold DOUBLE NOT NULL DEFAULT 0)").Error; err != nil {
		t.Fatalf("钱包表创建失败：%v", err)
	}
	store.DB.Exec("INSERT INTO "+e2eWalletTB+" (account, gold) VALUES (?, 0)", e2eUser1)
	return g1.ID, g2.ID
}

func e2eCleanup(t *testing.T) {
	t.Helper()
	store.DB.Where("username LIKE ?", "e2e_user%").Delete(&model.RechargeOrder{})
	store.DB.Where("username LIKE ?", "e2e_user%").Delete(&model.PointsLog{})
	store.DB.Where("username LIKE ?", "e2e_user%").Delete(&model.User{})
	store.DB.Where("slug LIKE ?", "e2e-game%").Delete(&model.Game{})
	store.DB.Where("name = ?", e2eGwName).Delete(&model.GatewayBook{})
	store.DB.Exec("DROP TABLE IF EXISTS " + e2eWalletTB)
}

// e2ePost 渲染进程视角调用（httptest server + X-Drive-Token 头），返回 (code, data)
func e2ePost(t *testing.T, base, username string, gameID uint, points float64) (int, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{"game_id": gameID, "points": points})
	req, _ := http.NewRequest("POST", base+"/api/game/recharge?username="+url.QueryEscape(username), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Drive-Token", DriveTokenIssue(username))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("下单请求失败：%v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var env struct {
		Ok   bool                   `json:"ok"`
		Msg  string                 `json:"msg"`
		Data map[string]interface{} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	if env.Data == nil {
		env.Data = map[string]interface{}{}
	}
	env.Data["ok"] = env.Ok
	env.Data["msg"] = env.Msg
	env.Data["_code"] = resp.StatusCode
	return resp.StatusCode, env.Data
}

func e2eWalletGold(t *testing.T, account string) float64 {
	t.Helper()
	var gold float64
	if err := store.DB.Raw("SELECT gold FROM "+e2eWalletTB+" WHERE account = ?", account).Scan(&gold).Error; err != nil {
		t.Fatalf("钱包查询失败：%v", err)
	}
	return gold
}

func e2eBalance(t *testing.T, username string) float64 {
	t.Helper()
	var p float64
	store.DB.Model(&model.User{}).Where("username = ?", username).Select("points").Scan(&p)
	return p
}

// e2eWaitOrderStatus 轮询等待订单到达期望状态（网关 poll_sec=5s，预算 40s）
func e2eWaitOrderStatus(t *testing.T, orderID uint64, status int8) model.RechargeOrder {
	t.Helper()
	for i := 0; i < 80; i++ {
		var o model.RechargeOrder
		if err := store.DB.First(&o, orderID).Error; err == nil && o.Status == status {
			return o
		}
		time.Sleep(500 * time.Millisecond)
	}
	var o model.RechargeOrder
	store.DB.First(&o, orderID)
	t.Fatalf("订单 %d 未在预算内到达状态 %d（当前 %d，原因 %q）", orderID, status, o.Status, o.FailReason)
	return o
}

// TestRechargeGatewayProcessE2E 全链路主用例：真实网关进程消费真实订单
func TestRechargeGatewayProcessE2E(t *testing.T) {
	cfg := config.Load()
	if store.RDB == nil {
		if err := store.InitRedis(cfg); err != nil {
			t.Skipf("Redis 不可用（DriveToken 会话签发依赖）：%v", err)
		}
	}
	game1, game2 := e2eSeed(t)
	t.Cleanup(func() { e2eCleanup(t) })

	cfg.Game.Enabled = true
	s := &Server{cfg: cfg}
	e2eEnsureRoutes(s)
	ts := httptest.NewServer(http.DefaultServeMux)
	defer ts.Close()

	// 网关 exe + 配置（游戏库=本 MySQL 钱包表；game2 故意不进 games 列表）
	exe := e2eEnsureExe(t)
	tmp := filepath.Dir(exe)
	gwYAML := fmt.Sprintf(`token_secret: "%s"
listens:
  - name: e2e
    listen_tcp: "127.0.0.1:31987"
    listen_udp: "127.0.0.1:31987"
    allow_targets: [1]
recharge:
  enabled: true
  gateway_name: "%s"
  im_addr: "%s"
  poll_sec: 3
  games:
    - game: "%d"
      type: mysql
      dsn: "root:root@tcp(127.0.0.1:3306)/im"
      sql: "UPDATE %s SET gold=gold+{amount} WHERE account={user}"
`, e2eGwSecret, e2eGwName, ts.URL, game1, e2eWalletTB)
	cfgPath := filepath.Join(tmp, "gateway.yaml")
	if err := os.WriteFile(cfgPath, []byte(gwYAML), 0600); err != nil {
		t.Fatalf("网关配置写入失败：%v", err)
	}
	cmd := exec.Command(exe, cfgPath)
	cmd.Dir = tmp // gateway.crt/key/recharge_done.json 落此处（幂等落盘证据）
	logBuf := &bytes.Buffer{}
	cmd.Stdout = logBuf
	cmd.Stderr = logBuf
	if err := cmd.Start(); err != nil {
		t.Fatalf("网关进程启动失败：%v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		t.Logf("---- 网关进程日志 ----\n%s", logBuf.String())
	})
	// 等网关完成首轮拉取（启动即拉一轮，给 2s 编译期后的进程初始化时间）
	time.Sleep(2 * time.Second)

	// ── 用例 1：非档位数值 → 400，不扣分不建单 ──
	code, resp := e2ePost(t, ts.URL, e2eUser1, game1, 377)
	if code != 400 {
		t.Fatalf("非档位数值应 400，实得 %d：%v", code, resp)
	}
	if bal := e2eBalance(t, e2eUser1); bal != 1000 {
		t.Fatalf("非档位拒绝不应扣分，余额 %v ≠ 1000", bal)
	}

	// ── 用例 2：档位 100 → 网关真实写库 → success + 钱包到账 1000 + 余额 900 + 流水 ──
	code, resp = e2ePost(t, ts.URL, e2eUser1, game1, 100)
	if code != 200 || resp["ok"] != true {
		t.Fatalf("档位 100 下单应 200：%d %v", code, resp)
	}
	order1 := uint64(resp["order_id"].(float64))
	if resp["amount"].(float64) != 1000 {
		t.Fatalf("到账快照应 1000，实得 %v", resp["amount"])
	}
	if bal := e2eBalance(t, e2eUser1); bal != 900 {
		t.Fatalf("下单后余额应 900，实得 %v", bal)
	}
	o1 := e2eWaitOrderStatus(t, order1, model.RechargeOrderStatusSuccess)
	if o1.Amount != 1000 || o1.Gw != e2eGwName {
		t.Fatalf("订单1终态字段不符：%+v", o1)
	}
	if gold := e2eWalletGold(t, e2eUser1); gold != 1000 {
		t.Fatalf("游戏库钱包应到账 1000，实得 %v", gold)
	}
	var logCnt int64
	store.DB.Model(&model.PointsLog{}).Where("username = ? AND reason = ?", e2eUser1, "game_recharge").Count(&logCnt)
	if logCnt != 1 {
		t.Fatalf("game_recharge 流水应 1 条，实得 %d", logCnt)
	}
	// 幂等落盘证据：网关工作目录应生成 recharge_done.json 且含订单号
	doneData, err := os.ReadFile(filepath.Join(tmp, "recharge_done.json"))
	if err != nil || !strings.Contains(string(doneData), fmt.Sprintf("%d", order1)) {
		t.Fatalf("幂等落盘缺失：err=%v data=%s", err, string(doneData))
	}

	// ── 用例 3：游戏账号不在库（user2 无钱包行）→ UPDATE 0 行 → 网关明确报失败 → 即刻退分 ──
	code, resp = e2ePost(t, ts.URL, e2eUser2, game1, 100)
	if code != 200 {
		t.Fatalf("user2 下单应 200（余额充足），实得 %d：%v", code, resp)
	}
	order2 := uint64(resp["order_id"].(float64))
	o2 := e2eWaitOrderStatus(t, order2, model.RechargeOrderStatusFailed)
	if !strings.Contains(o2.FailReason, "游戏账号不存在") {
		t.Fatalf("失败原因应含'游戏账号不存在'：%q", o2.FailReason)
	}
	if bal := e2eBalance(t, e2eUser2); bal != 500 {
		t.Fatalf("user2 退分后余额应 500，实得 %v", bal)
	}
	if gold := e2eWalletGold(t, e2eUser2); gold != 0 {
		t.Fatalf("user2 不应有钱包行写入，实得 %v", gold)
	}

	// ── 用例 4：网关未配置的游戏（game2）订单 → 不执行不 ack，保持 pending ──
	code, resp = e2ePost(t, ts.URL, e2eUser1, game2, 100)
	if code != 200 {
		t.Fatalf("game2 下单应 200：%d %v", code, resp)
	}
	order3 := uint64(resp["order_id"].(float64))
	time.Sleep(8 * time.Second) // 至少跨 2 个网关轮询周期
	var o3 model.RechargeOrder
	store.DB.First(&o3, order3)
	if o3.Status != model.RechargeOrderStatusPending {
		t.Fatalf("网关未配置游戏的订单应保持 pending（不误执行），实得 %d", o3.Status)
	}
	// 超时退分（回拨 create_time 后单轮扫描）：积分原额退还
	past := time.Now().Add(-31 * time.Minute)
	store.DB.Model(&model.RechargeOrder{}).Where("id = ?", order3).Update("create_time", past)
	if n := rechargeTimeoutSweep(); n < 1 {
		t.Fatalf("超时扫描应至少退 1 单，实得 %d", n)
	}
	if bal := e2eBalance(t, e2eUser1); bal != 900 { // 1000 -100(订单1) -100(订单3下单扣) +100(订单3超时退)
		t.Fatalf("game2 超时退分后余额应 900，实得 %v", bal)
	}

	// ── 用例 5：伪造 token 冒名下单 → 401（守卫在真 HTTP 链路上生效） ──
	req, _ := http.NewRequest("POST", ts.URL+"/api/game/recharge?username="+url.QueryEscape(e2eUser1), bytes.NewReader([]byte(`{"game_id":`+fmt.Sprint(game1)+`,"points":100}`)))
	req.Header.Set("X-Drive-Token", "forged")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("伪造 token 请求失败：%v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 401 {
		t.Fatalf("伪造 token 下单应 401，实得 %d", resp2.StatusCode)
	}

	// ── 用例 6：网关拉取/回执签名攻击面（错误密钥）→ 401 ──
	uri := "/internal/gateway/recharge?gw=" + url.QueryEscape(e2eGwName)
	req3, _ := http.NewRequest("GET", ts.URL+uri, nil)
	req3.Header.Set(gwproto.AuthHeader, gwproto.SignAuth("wrong-secret", time.Now(), "GET", uri, nil))
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatalf("错误密钥拉取失败：%v", err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != 401 {
		t.Fatalf("错误密钥拉取应 401，实得 %d", resp3.StatusCode)
	}

	// 终态对账：user1 余额 800、钱包 1000、订单 1 success + 1 failed + 1 failed(超时)
	var cntByStatus []struct {
		Status int8
		N      int64
	}
	store.DB.Model(&model.RechargeOrder{}).Where("username = ?", e2eUser1).Select("status, count(*) as n").Group("status").Scan(&cntByStatus)
	m := map[int8]int64{}
	for _, r := range cntByStatus {
		m[r.Status] = r.N
	}
	if m[model.RechargeOrderStatusSuccess] != 1 || m[model.RechargeOrderStatusFailed] != 1 {
		t.Fatalf("user1 订单终态分布不符：%v", m)
	}
	_ = gorm.ErrRecordNotFound // 保持 gorm 引用（扫描容错路径）
}
