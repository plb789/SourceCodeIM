package server

// 充值卡单测（真实 MySQL + Redis）：生成唯一性/字符集、并发核销唯一赢家、作废后不可核销、
// 频控锁定、token 越权 401、导出内容。测试数据用 cardtest_ 前缀，用后即清。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"im-server/model"
	"im-server/store"
)

const cardTestUser = "cardtest_user"

var (
	cardTestBatches []string // 本进程测试生成的批次（清理按批次精确删除，防污染真实卡数据）
)

func cardTestSetup(t *testing.T) {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.RechargeCard{}, &model.User{}, &model.PointsLog{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	cardTestCleanup(t)
	if err := store.DB.Create(&model.User{Username: cardTestUser, Points: 0}).Error; err != nil {
		t.Fatalf("用户创建失败：%v", err)
	}
	// User.Points 零值会被 GORM 按 default:100 跳过（实测踩坑）：显式归零保证断言基线
	store.DB.Model(&model.User{}).Where("username = ?", cardTestUser).Update("points", 0)
	// 管理员账号（role=1）+ admin 会话 token（E2E 走真 HTTP 时 adminGuard 校验用）
	if err := store.DB.Create(&model.User{Username: "cardtest_admin", Role: 1, Points: 0}).Error; err != nil {
		t.Fatalf("管理员创建失败：%v", err)
	}
	store.DB.Model(&model.User{}).Where("username = ?", "cardtest_admin").Update("points", 0)
	// 频控表跨用例重置（进程内存同包直清）
	cardRateMu.Lock()
	cardRateTable = map[string]*cardRateEntry{}
	cardRateMu.Unlock()
}

// cardAdminToken 管理端 Bearer token 签发（直写 Redis 会话，与 adminGuard 校验同键）
func cardAdminToken(t *testing.T) string {
	t.Helper()
	gsEnsureRedis(t)
	tk := "cardtest-admin-token-" + fmt.Sprintf("%d", time.Now().UnixNano())
	store.RDB.Set(context.Background(), "im:admin:token:"+tk, "cardtest_admin", time.Hour)
	return tk
}

func cardTestCleanup(t *testing.T) {
	t.Helper()
	store.DB.Where("used_by LIKE ?", "cardtest_%").Delete(&model.RechargeCard{}) // 表列为 used_by（曾误写 username 报 1054）
	if len(cardTestBatches) > 0 {
		// 直调生成接口时 created_by 为空串（无管理 ctx），按测试批次精确删除
		store.DB.Where("batch_no IN ?", cardTestBatches).Delete(&model.RechargeCard{})
	}
	// 兜底：created_by 为空的未使用卡只可能来自测试直调（生产必经 adminGuard 带操作人）
	store.DB.Where("created_by = '' AND status = ?", model.RechargeCardStatusUnused).Delete(&model.RechargeCard{})
	store.DB.Where("username LIKE ?", "cardtest_%").Delete(&model.PointsLog{})
	store.DB.Where("username LIKE ?", "cardtest_%").Delete(&model.User{})
}

// cardAdminGen 管理端生成归口（直调 handler；adminUserFromCtx 从 ctx 取，缺失为空可接受）
func cardAdminGen(t *testing.T, s *Server, points float64, count int, prefix string) (int, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(map[string]interface{}{"points": points, "count": count, "prefix": prefix})
	req := httptest.NewRequest("POST", "/admin/api/game/card/generate", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.HandleAdminCardGenerate(rec, req)
	code, r := gwrUnwrap(rec)
	if code == 200 && r["batch_no"] != nil {
		cardTestBatches = append(cardTestBatches, r["batch_no"].(string)) // 登记批次供清理
	}
	return code, r
}

// cardRedeem 用户核销归口（guardRecharge 包裹直调；资金接口须携带登录会话 token）
func cardRedeem(t *testing.T, s *Server, username, cardNo, cardKey string) (int, map[string]interface{}) {
	t.Helper()
	gsEnsureRedis(t)
	body, _ := json.Marshal(map[string]interface{}{"card_no": cardNo, "card_key": cardKey})
	req := httptest.NewRequest("POST", "/api/game/card/redeem?username="+username, bytes.NewReader(body))
	req.Header.Set("X-Drive-Token", DriveTokenIssue(username))
	rec := httptest.NewRecorder()
	s.guardRecharge(s.HandleGameCardRedeem)(rec, req)
	return gwrUnwrap(rec)
}

func TestCardGenerateAndCharset(t *testing.T) {
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	s := dbwServer(t)

	// 生成 100 张面值 50（前缀 TEST）：唯一性 + 字符集 + 面值/状态
	code, resp := cardAdminGen(t, s, 50, 100, "TEST")
	if code != 200 || resp["count"].(float64) != 100 {
		t.Fatalf("生成应 200 且 100 张：%d %v", code, resp)
	}
	var rows []model.RechargeCard
	store.DB.Where("batch_no = ?", resp["batch_no"]).Find(&rows)
	if len(rows) != 100 {
		t.Fatalf("应 100 行，实得 %d", len(rows))
	}
	seen := map[string]bool{}
	for _, c := range rows {
		if seen[c.CardNo] || seen[c.CardKey] {
			t.Fatalf("卡号/卡密重复：%s %s", c.CardNo, c.CardKey)
		}
		seen[c.CardNo], seen[c.CardKey] = true, true
		if !strings.HasPrefix(c.CardNo, "TEST") || len(c.CardNo) != 16 {
			t.Fatalf("卡号格式不符：%s", c.CardNo)
		}
		if len(c.CardKey) != 16 {
			t.Fatalf("卡密长度不符：%s", c.CardKey)
		}
		for _, r := range c.CardKey {
			if !strings.ContainsRune(cardKeyCharset, r) {
				t.Fatalf("卡密含非法字符 %q：%s", r, c.CardKey)
			}
		}
		if c.Status != model.RechargeCardStatusUnused || c.Points != 50 {
			t.Fatalf("初始状态/面值不符：%+v", c)
		}
	}
	// 非法面值/数量/前缀拒绝
	if code, _ := cardAdminGen(t, s, 0, 10, ""); code != 400 {
		t.Fatalf("面值 0 应 400")
	}
	if code, _ := cardAdminGen(t, s, 50, 5001, ""); code != 400 {
		t.Fatalf("超上限应 400")
	}
	if code, _ := cardAdminGen(t, s, 50, 10, "前缀!"); code != 400 {
		t.Fatalf("非法前缀应 400")
	}
}

func TestCardRedeemFlow(t *testing.T) {
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	s := dbwServer(t)

	// 生成 2 张（一张正常核销、一张用于作废）
	_, resp := cardAdminGen(t, s, 100, 2, "IM")
	batch := resp["batch_no"].(string)
	var cards []model.RechargeCard
	store.DB.Where("batch_no = ?", batch).Order("id ASC").Find(&cards)

	// ── 1. 正常核销：加分 + status=1 + used_by/used_at + 流水 ──
	code, r := cardRedeem(t, s, cardTestUser, cards[0].CardNo, cards[0].CardKey)
	if code != 200 || r["points"].(float64) != 100 || r["balance"].(float64) != 100 {
		t.Fatalf("核销应 200 且到账 100：%d %v", code, r)
	}
	var used model.RechargeCard
	store.DB.First(&used, cards[0].ID)
	if used.Status != model.RechargeCardStatusUsed || used.UsedBy != cardTestUser || used.UsedAt == nil {
		t.Fatalf("卡状态/使用者/时间不符：%+v", used)
	}
	var logCnt int64
	store.DB.Model(&model.PointsLog{}).Where("username = ? AND reason = ?", cardTestUser, "card_recharge").Count(&logCnt)
	if logCnt != 1 {
		t.Fatalf("card_recharge 流水应 1 条，实得 %d", logCnt)
	}

	// ── 2. 重复核销同一卡 → 拒绝 ──
	code, r = cardRedeem(t, s, cardTestUser, cards[0].CardNo, cards[0].CardKey)
	if code != 400 || !strings.Contains(r["msg"].(string), "已使用") {
		t.Fatalf("重复核销应 400 已使用：%d %v", code, r)
	}

	// ── 3. 卡密错误（同卡号）→ 统一文案 ──
	code, r = cardRedeem(t, s, cardTestUser, cards[1].CardNo, "wrongkey")
	if code != 400 || !strings.Contains(r["msg"].(string), "卡号或卡密错误") {
		t.Fatalf("卡密错误应 400 统一文案：%d %v", code, r)
	}

	// ── 4. 作废后核销拒绝 ──
	vbody, _ := json.Marshal(map[string]interface{}{"ids": []uint64{cards[1].ID}})
	vreq := httptest.NewRequest("POST", "/admin/api/game/card/void", bytes.NewReader(vbody))
	vrec := httptest.NewRecorder()
	s.HandleAdminCardVoid(vrec, vreq)
	if vrec.Code != 200 {
		t.Fatalf("作废应 200：%s", vrec.Body.String())
	}
	code, r = cardRedeem(t, s, cardTestUser, cards[1].CardNo, cards[1].CardKey)
	if code != 400 || !strings.Contains(r["msg"].(string), "已作废") {
		t.Fatalf("作废卡核销应 400 已作废：%d %v", code, r)
	}
	// 已使用/已作废的 void 跳过（重复作废返回 0）
	vreq = httptest.NewRequest("POST", "/admin/api/game/card/void", bytes.NewReader(vbody))
	vrec = httptest.NewRecorder()
	s.HandleAdminCardVoid(vrec, vreq)
	if _, vr := gwrUnwrap(vrec); vr["voided"].(float64) != 0 {
		t.Fatal("重复作废应 voided=0")
	}
}

func TestCardConcurrentRedeem(t *testing.T) {
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	s := dbwServer(t)
	_, resp := cardAdminGen(t, s, 100, 1, "IM")
	// 必须按本批次取卡：全表 First 会取到库中遗留的历史卡（本地实测数据），卡密对不上导致全失败
	var card model.RechargeCard
	store.DB.Where("batch_no = ?", resp["batch_no"]).First(&card)

	// 并发 8 goroutine 核销同一卡：仅 1 个成功，余额恰 100
	var wg sync.WaitGroup
	okCnt := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := cardRedeem(t, s, cardTestUser, card.CardNo, card.CardKey)
			if code == 200 {
				okCnt <- 1
			} else {
				okCnt <- 0
			}
		}()
	}
	wg.Wait()
	close(okCnt)
	success := 0
	for v := range okCnt {
		success += v
	}
	if success != 1 {
		t.Fatalf("并发核销应恰 1 次成功，实得 %d", success)
	}
	if bal := gwrBalance(t, cardTestUser); bal != 100 {
		t.Fatalf("余额应恰 100（无双得），实得 %v", bal)
	}
}

func TestCardRateLimit(t *testing.T) {
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	s := dbwServer(t)
	// 5 次失败 → 第 6 次 429 锁定
	for i := 0; i < 5; i++ {
		code, _ := cardRedeem(t, s, cardTestUser, "IM000000000000000", "badkey")
		if code != 400 {
			t.Fatalf("第 %d 次失败应 400，实得 %d", i+1, code)
		}
	}
	code, r := cardRedeem(t, s, cardTestUser, "IM000000000000000", "badkey")
	if code != 429 {
		t.Fatalf("超频应 429，实得 %d：%v", code, r)
	}
	if !strings.Contains(r["msg"].(string), "频繁") {
		t.Fatalf("锁定文案不符：%v", r)
	}
	cardRateSuccess(cardTestUser) // 成功清零路径
	if remain := cardRateCheck(cardTestUser); remain != 0 {
		t.Fatalf("成功后应解锁，剩余 %d", remain)
	}
}

func TestCardGuardAndExport(t *testing.T) {
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	s := dbwServer(t)
	_, resp := cardAdminGen(t, s, 100, 2, "IM")

	// 无 token → 401（守卫在真链路生效）
	req := httptest.NewRequest("POST", "/api/game/card/redeem?username="+cardTestUser, bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	s.guardRecharge(s.HandleGameCardRedeem)(rec, req)
	if rec.Code != 401 {
		t.Fatalf("无 token 核销应 401，实得 %d", rec.Code)
	}

	// 导出 txt/csv/xlsx 内容非空且含卡号（按本批次取卡，防库中遗留历史卡干扰）
	var card model.RechargeCard
	store.DB.Where("batch_no = ?", resp["batch_no"]).First(&card)
	for _, format := range []string{"txt", "csv", "xlsx"} {
		ereq := httptest.NewRequest("GET", "/admin/api/game/card/export?format="+format, nil)
		erec := httptest.NewRecorder()
		s.HandleAdminCardExport(erec, ereq)
		if erec.Code != 200 {
			t.Fatalf("导出 %s 应 200：%d %s", format, erec.Code, erec.Body.String())
		}
		if !strings.Contains(erec.Body.String(), card.CardNo) && format != "xlsx" {
			t.Fatalf("导出 %s 应含卡号", format)
		}
		if format == "xlsx" && erec.Body.Len() < 100 {
			t.Fatalf("xlsx 内容异常小：%d", erec.Body.Len())
		}
		if cd := erec.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
			t.Fatalf("导出应 attachment：%q", cd)
		}
	}
	// 空范围导出 → 400
	ereq := httptest.NewRequest("GET", "/admin/api/game/card/export?format=txt&batch=no-such-batch", nil)
	erec := httptest.NewRecorder()
	s.HandleAdminCardExport(erec, ereq)
	if erec.Code != 400 {
		t.Fatalf("空范围导出应 400，实得 %d", erec.Code)
	}
}
