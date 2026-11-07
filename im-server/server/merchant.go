package server

// ===== 商户独立后台·鉴权与登录归口（商户独立后台开发文档 §3.2） =====
//
// 与 adminGuard 同范式、独立键前缀（im:merchant:token:）互不通用：
//   登录 POST /api/merchant/login（username+password → verifyUser + role=2 + 商户启用校验 → 签发 Bearer）
//   守卫 merchantGuard：每请求回查 users.role=2 与 im_merchant.status（防改角色/停用后旧 token 残留）
//   归属 merchantOwnGame：商户操作游戏的 SQL 层隔离归口（owner_username 不匹配一律 404 不暴露存在性）

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

const (
	merchantTokenKey   = "im:merchant:token:" // 会话键前缀（与 adminTokenKey 隔离）
	merchantTokenTTL   = time.Hour            // 滑动续期（与 admin 同款）
	merchantFailKey    = "im:merchant:fail:"  // 登录防爆破计数键（按 IP）
	merchantFailMax    = 5                    // 窗口内最大失败次数
	merchantFailWindow = 10 * time.Minute     // 防爆破窗口
)

// registerMerchantRoutes 商户后台路由（game.go 注册归口调用；Go 1.22+ 方法+路径模式）。
// 上传通道直接挂 admin 既有 handler（分片/图片/种子实现与身份无关、响应同构 adminJSON），
// 会话归属见 gameUploadSession.Owner 注入——商户与管理员分轨防串道
func registerMerchantRoutes(s *Server) {
	http.HandleFunc("POST /api/merchant/login", s.handleMerchantLogin)
	http.HandleFunc("POST /api/merchant/logout", s.merchantGuard(s.handleMerchantLogout))
	http.HandleFunc("GET /api/merchant/profile", s.merchantGuard(s.handleMerchantProfile))
	// 游戏 CRUD 与审核状态机（merchantgame.go）
	http.HandleFunc("GET /api/merchant/games", s.merchantGuard(s.handleMerchantGameList))
	http.HandleFunc("POST /api/merchant/games", s.merchantGuard(s.handleMerchantGameCreate))
	http.HandleFunc("PUT /api/merchant/games/{id}", s.merchantGuard(s.handleMerchantGameUpdate))
	http.HandleFunc("POST /api/merchant/games/{id}/status", s.merchantGuard(s.handleMerchantGameStatus))
	// 公告（复用 GameNotice，归属校验）
	http.HandleFunc("GET /api/merchant/notices", s.merchantGuard(s.handleMerchantNoticesGet))
	http.HandleFunc("POST /api/merchant/notices", s.merchantGuard(s.handleMerchantNoticeCreate))
	http.HandleFunc("PUT /api/merchant/notices/{id}", s.merchantGuard(s.handleMerchantNoticeUpdate))
	http.HandleFunc("DELETE /api/merchant/notices/{id}", s.merchantGuard(s.handleMerchantNoticeDelete))
	// 版本（复用分片上传与合并链路；会话 Owner 注入防串道）
	http.HandleFunc("GET /api/merchant/games/{id}/versions", s.merchantGuard(s.handleMerchantGameVersions))
	http.HandleFunc("GET /api/merchant/games/{id}/versions/{ver}/filelist", s.merchantGuard(s.handleMerchantVersionFilelist))
	// 补丁工具下载（GamePatchTool gametool.exe，与 im-server.exe 同目录托管）
	http.HandleFunc("GET /api/merchant/gametool", s.merchantGuard(s.handleMerchantGameToolDownload))
	http.HandleFunc("POST /api/merchant/games/{id}/version", s.merchantGuard(s.handleMerchantVersionCreate))
	http.HandleFunc("DELETE /api/merchant/version/{vid}", s.merchantGuard(s.handleMerchantVersionDelete))
	http.HandleFunc("POST /api/merchant/upload/chunk", s.merchantGuard(s.handleAdminGameChunk))
	http.HandleFunc("POST /api/merchant/upload/cancel", s.merchantGuard(s.handleAdminGameChunkCancel))
	http.HandleFunc("POST /api/merchant/upload/image", s.merchantGuard(s.handleAdminGameImage))
	// 赞助统计与网关包（merchantrecharge.go / merchantgateway.go）
	http.HandleFunc("GET /api/merchant/recharge/summary", s.merchantGuard(s.handleMerchantRechargeSummary))
	http.HandleFunc("GET /api/merchant/recharge/orders", s.merchantGuard(s.handleMerchantRechargeOrders))
	http.HandleFunc("GET /api/merchant/gateway/package", s.merchantGuard(s.handleMerchantGatewayPackage))
}

// merchantLoginStatus 商户登录前置状态（登录与守卫共用口径）：
// 返回错误文案（空=可登录）。校验 role=2 + im_merchant 存在且启用
func merchantLoginStatus(username string) string {
	var u model.User
	if err := store.DB.Select("username", "role", "status").Where("username = ?", username).First(&u).Error; err != nil {
		return "账号不存在"
	}
	if u.Role != 2 {
		return "该账号无商户后台权限"
	}
	var m model.Merchant
	if err := store.DB.Where("username = ?", username).First(&m).Error; err != nil {
		return "商户资料不存在（请联系管理员）"
	}
	if m.Status != 0 {
		return "商户账号已停用，请联系管理员"
	}
	return ""
}

// handleMerchantLogin 商户登录（复用 IM 账号密码 + admin 同款防爆破/状态拦截）
func (s *Server) handleMerchantLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	req.Username = strings.TrimSpace(req.Username)

	ctx := context.Background()
	ip := adminClientIP(r)
	failKey := merchantFailKey + ip
	if count, _ := store.RDB.Get(ctx, failKey).Int(); count >= merchantFailMax {
		adminFail(w, http.StatusTooManyRequests, "登录失败次数过多，请 10 分钟后再试")
		return
	}
	user, err := verifyUser(req.Username, req.Password)
	if err != nil {
		store.RDB.Incr(ctx, failKey)
		store.RDB.Expire(ctx, failKey, merchantFailWindow)
		logger.Warn("商户后台登录失败（IP %s，账号 %s）：%v", ip, req.Username, err)
		adminFail(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	if rejectMsg := userStatusRejectMsg(user); rejectMsg != "" {
		adminFail(w, http.StatusForbidden, rejectMsg)
		return
	}
	if why := merchantLoginStatus(user.Username); why != "" {
		logger.Warn("商户后台登录被拦截（IP %s，账号 %s）：%s", ip, user.Username, why)
		adminFail(w, http.StatusForbidden, why)
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		adminFail(w, http.StatusInternalServerError, "会话签发失败，请重试")
		return
	}
	token := hex.EncodeToString(b)
	store.RDB.Set(ctx, merchantTokenKey+token, user.Username, merchantTokenTTL)
	store.RDB.Del(ctx, failKey)
	logger.Info("商户 %s 登录商户后台（IP %s）", user.Username, ip)
	var m model.Merchant
	store.DB.Where("username = ?", user.Username).First(&m)
	adminJSON(w, map[string]interface{}{
		"token": token, "username": user.Username, "nickname": user.Nickname, "merchant_name": m.Name,
	})
}

// handleMerchantLogout 登出：销毁会话
func (s *Server) handleMerchantLogout(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token != "" {
		store.RDB.Del(context.Background(), merchantTokenKey+strings.TrimSpace(token))
	}
	adminJSON(w, map[string]interface{}{"logout": true})
}

// merchantGuard 商户接口鉴权中间件：Bearer → username → 实时复核 role=2 + 商户启用（防改角色/
// 停用后旧 token 残留续权），通过后注入商户身份上下文
func (s *Server) merchantGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			adminFail(w, http.StatusUnauthorized, "未登录或登录已过期")
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if token == "" {
			adminFail(w, http.StatusUnauthorized, "未登录或登录已过期")
			return
		}
		ctx := context.Background()
		key := merchantTokenKey + token
		username, err := store.RDB.Get(ctx, key).Result()
		if err != nil || username == "" {
			adminFail(w, http.StatusUnauthorized, "登录已过期，请重新登录")
			return
		}
		if why := merchantLoginStatus(username); why != "" {
			// 已无商户权限/被停用：立即吊销会话
			store.RDB.Del(ctx, key)
			adminFail(w, http.StatusForbidden, why)
			return
		}
		store.RDB.Expire(ctx, key, merchantTokenTTL) // 滑动续期
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKeyMerchantUser{}, username)))
	}
}

// ctxKeyMerchantUser 商户身份上下文键（私有类型防碰撞）
type ctxKeyMerchantUser struct{}

// merchantUserFromCtx 读取当前登录商户用户名（未注入时返回空串）
func merchantUserFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyMerchantUser{}).(string); ok {
		return v
	}
	return ""
}

// merchantOwnGame 商户游戏归属校验归口（SQL 层隔离）：owner 必须匹配，否则按不存在处理（404 语义，
// 不暴露他人游戏存在性）
func merchantOwnGame(owner string, gameID uint64) (model.Game, bool) {
	var g model.Game
	if err := store.DB.Where("id = ? AND owner_username = ?", gameID, owner).First(&g).Error; err != nil {
		return g, false
	}
	return g, true
}

// merchantIP 复用 adminClientIP（防爆破维度一致），别名归口便于语义追踪
func merchantIP(r *http.Request) string { return adminClientIP(r) }
