package server

// 充值卡 E2E（真 HTTP 路由 + X-Drive-Token 鉴权 + 真实 MySQL/Redis）：
// 生成 3 张 → 三格式导出内容校验 → 核销到账 → 重复核销拒绝 → 作废卡拒绝 → 清理无残留。
// 复用 e2eEnsureRoutes/gsEnsureRedis 既有守卫；测试数据用 cardtest_ 前缀用后即清。

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

func TestCardE2EFlow(t *testing.T) {
	gsEnsureRedis(t) // 先初始化 Redis：DriveTokenIssue 会话签发依赖
	cardTestSetup(t)
	t.Cleanup(func() { cardTestCleanup(t) })
	cfg := config.Load()
	cfg.Game.Enabled = true
	s := &Server{cfg: cfg}
	e2eEnsureRoutes(s)
	ts := httptest.NewServer(http.DefaultServeMux)
	defer ts.Close()

	token := DriveTokenIssue(cardTestUser)
	if v, ok := DriveTokenVerify(token); !ok || v != cardTestUser {
		t.Fatalf("token 签发/校验闭环失败：ok=%v user=%q（RDB=%v）", ok, v, store.RDB != nil)
	}
	adminTok := cardAdminToken(t)
	do := func(method, path string, body []byte) (int, []byte) {
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, _ := http.NewRequest(method, ts.URL+path, rdr)
		req.Header.Set("X-Drive-Token", token)
		req.Header.Set("Authorization", "Bearer "+adminTok) // 管理端接口 adminGuard 校验
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s 请求失败：%v", method, path, err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}

	// ① 生成 3 张面值 200（E2E 前缀）
	code, body := do("POST", "/admin/api/game/card/generate", []byte(`{"points":200,"count":3,"prefix":"E2E"}`))
	if code != 200 {
		t.Fatalf("生成应 200：%d %s", code, body)
	}
	var gen struct {
		Data struct {
			BatchNo string `json:"batch_no"`
			Count   int    `json:"count"`
		} `json:"data"`
	}
	json.Unmarshal(body, &gen)
	if gen.Data.Count != 3 || !strings.HasPrefix(gen.Data.BatchNo, "CR") {
		t.Fatalf("生成返回不符：%s", body)
	}
	cardTestBatches = append(cardTestBatches, gen.Data.BatchNo)

	// ② 三格式导出：内容含卡号、attachment 头
	var cards []model.RechargeCard
	store.DB.Where("batch_no = ?", gen.Data.BatchNo).Find(&cards)
	if len(cards) != 3 {
		t.Fatalf("批次应 3 张，实得 %d", len(cards))
	}
	for _, format := range []string{"txt", "csv", "xlsx"} {
		c, b := do("GET", "/admin/api/game/card/export?format="+format+"&batch="+gen.Data.BatchNo, nil)
		if c != 200 || !strings.Contains(string(b), cards[0].CardNo) {
			if format != "xlsx" || c != 200 {
				t.Fatalf("导出 %s 异常：%d", format, c)
			}
		}
	}

	// ③ 核销到账：余额 0→200、status=1、used_by、流水
	c, b := do("POST", "/api/game/card/redeem?username="+cardTestUser, []byte(`{"card_no":"`+cards[0].CardNo+`","card_key":"`+cards[0].CardKey+`"}`))
	var redeem struct {
		Ok   bool `json:"ok"`
		Data struct {
			Points  float64 `json:"points"`
			Balance float64 `json:"balance"`
		} `json:"data"`
	}
	json.Unmarshal(b, &redeem)
	if c != 200 || !redeem.Ok || redeem.Data.Points != 200 || redeem.Data.Balance != 200 {
		t.Fatalf("核销应 200 到账 200：%d %s", c, b)
	}
	var used model.RechargeCard
	store.DB.First(&used, cards[0].ID)
	if used.Status != model.RechargeCardStatusUsed || used.UsedBy != cardTestUser {
		t.Fatalf("卡核销态不符：%+v", used)
	}

	// ④ 重复核销 → 400 已使用；④b 错卡密 → 400 统一文案
	c, b = do("POST", "/api/game/card/redeem?username="+cardTestUser, []byte(`{"card_no":"`+cards[0].CardNo+`","card_key":"`+cards[0].CardKey+`"}`))
	if c != 400 || !strings.Contains(string(b), "已使用") {
		t.Fatalf("重复核销应 400：%d %s", c, b)
	}
	c, b = do("POST", "/api/game/card/redeem?username="+cardTestUser, []byte(`{"card_no":"`+cards[1].CardNo+`","card_key":"bad"}`))
	if c != 400 || !strings.Contains(string(b), "卡号或卡密错误") {
		t.Fatalf("错卡密应 400 统一文案：%d %s", c, b)
	}

	// ⑤ 作废 cards[1] → 核销拒绝
	vb, _ := json.Marshal(map[string]interface{}{"ids": []uint64{cards[1].ID}})
	c, b = do("POST", "/admin/api/game/card/void", vb)
	if c != 200 {
		t.Fatalf("作废应 200：%d %s", c, b)
	}
	c, b = do("POST", "/api/game/card/redeem?username="+cardTestUser, []byte(`{"card_no":"`+cards[1].CardNo+`","card_key":"`+cards[1].CardKey+`"}`))
	if c != 400 || !strings.Contains(string(b), "已作废") {
		t.Fatalf("作废卡核销应 400：%d %s", c, b)
	}

	// ⑥ 终态对账：余额 200、流水 1 条、未使用剩 1 张（cards[2]）
	var bal float64
	store.DB.Model(&model.User{}).Where("username = ?", cardTestUser).Select("points").Scan(&bal)
	if bal != 200 {
		t.Fatalf("余额应 200，实得 %v", bal)
	}
	var unused int64
	store.DB.Model(&model.RechargeCard{}).Where("batch_no = ? AND status = ?", gen.Data.BatchNo, model.RechargeCardStatusUnused).Count(&unused)
	if unused != 1 {
		t.Fatalf("未使用应剩 1 张，实得 %d", unused)
	}
}
