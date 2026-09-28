package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"im-server/config"
	"im-server/store"
)

// TestEdgeAuthHandler /auth 端点 HTTP 层全链路：有效票 200 / 无效票 403 / 吊销后 403 / 限流 429
func TestEdgeAuthHandler(t *testing.T) {
	edgeAuthRateInit(1000) // 大额度：限流用例单独收口，避免干扰
	store.DriveTicketInit(true, 60)
	defer store.DriveTicketInit(false, 0)

	// 无票 / 伪造票 → 403
	for _, q := range []string{"/auth", "/auth?auth_ticket=deadbeefdeadbeefdeadbeefdeadbeef"} {
		r := httptest.NewRequest("GET", q, nil)
		w := httptest.NewRecorder()
		handleEdgeAuth(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s 应 403 实得 %d", q, w.Code)
		}
	}
	// 有效票 → 200
	tk := store.DriveTicketIssue("drive/test/a.txt")
	if tk == "" {
		t.Fatal("签发失败")
	}
	r := httptest.NewRequest("GET", "/auth?auth_ticket="+tk+"&X-Amz-Signature=xx", nil)
	w := httptest.NewRecorder()
	handleEdgeAuth(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("有效票应 200 实得 %d", w.Code)
	}
	// 按对象吊销 → 同票 403（分享取消即时收回链路）
	if n := store.DriveTicketRevokeKey("drive/test/a.txt"); n != 1 {
		t.Fatalf("吊销计数异常: %d", n)
	}
	r = httptest.NewRequest("GET", "/auth?auth_ticket="+tk, nil)
	w = httptest.NewRecorder()
	handleEdgeAuth(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("吊销后应 403 实得 %d", w.Code)
	}
}

// TestEdgeAuthRateLimit 全局令牌桶限流：超额请求 429
func TestEdgeAuthRateLimit(t *testing.T) {
	edgeAuthRateInit(3) // 3 QPS（桶容量 6）：7 连发必触限流
	store.DriveTicketInit(true, 60)
	defer store.DriveTicketInit(false, 0)

	sawLimited := false
	for i := 0; i < 10; i++ {
		r := httptest.NewRequest("GET", "/auth?auth_ticket=bad", nil)
		w := httptest.NewRecorder()
		handleEdgeAuth(w, r)
		if w.Code == http.StatusTooManyRequests {
			sawLimited = true
			break
		}
	}
	if !sawLimited {
		t.Fatal("超额请求未触发 429 限流")
	}
}

// TestRegisterEdgeAuthRoutesDisabled 未启用时不注册 /auth（行为与历史一致）
func TestRegisterEdgeAuthRoutesDisabled(t *testing.T) {
	cfg := &config.Config{}
	cfg.Drive.EdgeAuth.Enabled = false
	RegisterEdgeAuthRoutes(cfg) // 不应 panic；/auth 保持未注册状态（http.NotFound）
	r := httptest.NewRequest("GET", "/auth?auth_ticket=x", nil)
	w := httptest.NewRecorder()
	http.DefaultServeMux.ServeHTTP(w, r)
	if w.Code == http.StatusOK {
		t.Fatal("未启用时 /auth 不应放行")
	}
}
