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
	"fmt"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

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
	// 商家销售分成·收益查询（2026-11-19 Phase 2）
	http.HandleFunc("GET /api/merchant/revenue/summary", s.merchantGuard(s.handleMerchantRevenueSummary))
	http.HandleFunc("GET /api/merchant/revenue/orders", s.merchantGuard(s.handleMerchantRevenueOrders))
	http.HandleFunc("GET /api/merchant/withdraw/min", s.merchantGuard(s.handleMerchantWithdrawMin))
	// 商家提现（2026-11-19 Phase 3）
	http.HandleFunc("POST /api/merchant/withdraw/apply", s.merchantGuard(s.handleMerchantWithdrawApply))
	http.HandleFunc("GET /api/merchant/withdraw/orders", s.merchantGuard(s.handleMerchantWithdrawOrders))
	// P2.2：成就定义 CRUD + 图标上传
	http.HandleFunc("POST /api/merchant/games/{id}/achievement", s.merchantGuard(s.handleMerchantAchievementSave))
	http.HandleFunc("GET /api/merchant/games/{id}/achievements", s.merchantGuard(s.handleMerchantAchievementsGet))
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

// ===== 商家销售分成·收益查询（2026-11-19 新增，Phase 2） =====

// handleMerchantRevenueSummary GET /api/merchant/revenue/summary
// 返回当前商户收益概览：余额 + 待结算 + 累计收益/退款/提现 + 今日/本周新增
func (s *Server) handleMerchantRevenueSummary(w http.ResponseWriter, r *http.Request) {
	musername := merchantUserFromCtx(r)
	var m model.Merchant
	if err := store.DB.Select("username, name, balance_points, pending_points, total_earned, total_refunded, total_withdrawn, commission_rate").
		Where("username = ?", musername).First(&m).Error; err != nil {
		adminFail(w, http.StatusNotFound, "商户不存在")
		return
	}
	// 今日新增（本地自然日）
	todayStart := timeBeginOfDay(time.Now())
	var todayEarn, todayRefund float64
	store.DB.Model(&model.MerchantIncomeLog{}).
		Where("merchant = ? AND type = 1 AND create_time >= ?", musername, todayStart).
		Select("COALESCE(SUM(merchant_earn),0)").Scan(&todayEarn)
	store.DB.Model(&model.MerchantIncomeLog{}).
		Where("merchant = ? AND type = 2 AND create_time >= ?", musername, todayStart).
		Select("COALESCE(SUM(ABS(merchant_earn)),0)").Scan(&todayRefund)
	// 本周新增
	weekStart := timeBeginOfWeek(time.Now())
	var weekEarn float64
	store.DB.Model(&model.MerchantIncomeLog{}).
		Where("merchant = ? AND type = 1 AND create_time >= ?", musername, weekStart).
		Select("COALESCE(SUM(merchant_earn),0)").Scan(&weekEarn)
	adminJSON(w, map[string]interface{}{
		"merchant":       m.Username,
		"name":           m.Name,
		"commission":     m.CommissionRate,
		"balance":        aiPointsRound3(m.BalancePoints),
		"pending":        aiPointsRound3(m.PendingPoints),
		"total_earned":   aiPointsRound3(m.TotalEarned),
		"total_refund":   aiPointsRound3(m.TotalRefunded),
		"total_withdraw": aiPointsRound3(m.TotalWithdrawn),
		"net_earned":     aiPointsRound3(m.TotalEarned - m.TotalRefunded),
		"today_earn":     aiPointsRound3(todayEarn),
		"today_refund":   aiPointsRound3(todayRefund),
		"week_earn":      aiPointsRound3(weekEarn),
		"min_withdraw":   aiPointsRound3(s.cfg.Game.MinWithdrawPoints),
		"revenue_enabled": s.cfg.Game.MerchantRevenueEnabled,
	})
}

// handleMerchantRevenueOrders GET /api/merchant/revenue/orders
// 分账明细流水：支持 type 过滤（1=入库分账 2=入库退款扣回 3=提现扣减 4=手动调整 5=赞助充值分账 6=赞助退款扣回）、分页
// 返回 game_name（关联游戏名）+ username（付费用户）+ status（pending/settled/refunded）
func (s *Server) handleMerchantRevenueOrders(w http.ResponseWriter, r *http.Request) {
	musername := merchantUserFromCtx(r)
	qType := strings.TrimSpace(r.URL.Query().Get("type"))
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 30
	}
	db := store.DB.Where("merchant = ?", musername)
	if qType != "" {
		db = db.Where("type = ?", qType)
	}
	var total int64
	db.Model(&model.MerchantIncomeLog{}).Count(&total)
	var logs []model.MerchantIncomeLog
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&logs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	// 关联游戏名 + 状态文案
	type enrich struct {
		model.MerchantIncomeLog
		GameName string `json:"game_name"`
		TypeText string `json:"type_text"`
		StatusText string `json:"status_text"`
	}
	// 批量查游戏名
	gameIDs := make(map[uint]bool)
	for _, l := range logs {
		gameIDs[l.GameID] = true
	}
	gameNames := map[uint]string{}
	if len(gameIDs) > 0 {
		var games []model.Game
		if err := store.DB.Select("id, name").Where("id IN ?", maps.Keys(gameIDs)).Find(&games).Error; err == nil {
			for _, g := range games {
				gameNames[g.ID] = g.Name
			}
		}
	}
	typeMap := map[int8]string{1: "入库分账", 2: "入库退款扣回", 3: "提现扣减", 4: "手动调整", 5: "赞助充值分账", 6: "赞助退款扣回"}
	statusMap := map[int8]string{1: "锁定中", 2: "已解锁", 3: "已扣回"}
	items := make([]map[string]interface{}, 0, len(logs))
	for _, l := range logs {
		item := map[string]interface{}{
			"id":           l.ID,
			"game_id":      l.GameID,
			"game_name":    gameNames[l.GameID],
			"username":     l.Username,
			"purchase_id":  l.PurchaseID,
			"user_pay":     aiPointsRound3(l.UserPay),
			"commission":   l.Commission,
			"merchant_earn": aiPointsRound3(l.MerchantEarn),
			"type":         l.Type,
			"type_text":    typeMap[l.Type],
			"status":       l.Status,
			"status_text":  statusMap[l.Status],
			"settle_time":  l.SettleTime,
			"create_time":  l.CreateTime,
		}
		items = append(items, item)
		_ = enrich{} // avoid unused
	}
	adminJSON(w, map[string]interface{}{
		"total": total,
		"page":  page,
		"size":  size,
		"items": items,
	})
}

// handleMerchantWithdrawMin GET /api/merchant/withdraw/min
// 返回当前提现最小积分额（前端预校验）
func (s *Server) handleMerchantWithdrawMin(w http.ResponseWriter, r *http.Request) {
	adminJSON(w, map[string]interface{}{
		"min_withdraw": aiPointsRound3(s.cfg.Game.MinWithdrawPoints),
		"enabled":      s.cfg.Game.MerchantRevenueEnabled,
	})
}

// handleMerchantWithdrawApply POST /api/merchant/withdraw/apply
// 商家提交提现申请：事务内扣 balance_points → total_withdrawn 增加 → 写 withdraw_order status=0 → 写 type=3 流水
// 设计（方案 D3 Phase 3）：申请即扣余额，管理员审批=确认；拒绝时回滚
func (s *Server) handleMerchantWithdrawApply(w http.ResponseWriter, r *http.Request) {
	musername := merchantUserFromCtx(r)
	var req struct {
		Points float64 `json:"points"`
		Remark string  `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	points := aiPointsRound3(req.Points)
	minW := aiPointsRound3(s.cfg.Game.MinWithdrawPoints)
	if points <= 0 {
		adminFail(w, http.StatusBadRequest, "提现积分须大于 0")
		return
	}
	if minW > 0 && points < minW {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("提现积分不得小于最小额 %.3f", minW))
		return
	}
	if len(strings.TrimSpace(req.Remark)) > 255 {
		adminFail(w, http.StatusBadRequest, "备注过长（最多 255 字）")
		return
	}
	if !s.cfg.Game.MerchantRevenueEnabled {
		adminFail(w, http.StatusBadRequest, "商家收益功能未启用")
		return
	}
	var orderID uint64
	var afterBalance float64
	errTx := store.DB.Transaction(func(tx *gorm.DB) error {
		var m model.Merchant
		if err := tx.Where("username = ?", musername).First(&m).Error; err != nil {
			return fmt.Errorf("商户不存在: %w", err)
		}
		if m.BalancePoints < points {
			return fmt.Errorf("可提现余额不足（当前 %.3f，申请 %.3f）", m.BalancePoints, points)
		}
		res := tx.Model(&m).Where("username = ? AND balance_points >= ?", musername, points).
			Updates(map[string]interface{}{
				"balance_points":  gorm.Expr("ROUND(balance_points - ?, 3)", points),
				"total_withdrawn": gorm.Expr("ROUND(total_withdrawn + ?, 3)", points),
			})
		if res.Error != nil {
			return fmt.Errorf("余额扣减失败: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return fmt.Errorf("余额不足，请稍后重试")
		}
		// 写提现申请单
		wo := model.MerchantWithdrawOrder{
			Merchant: musername,
			Points:   points,
			Status:   0, // pending
			Remark:   strings.TrimSpace(req.Remark),
		}
		if err := tx.Create(&wo).Error; err != nil {
			return err
		}
		orderID = wo.ID
		// 写商家收益流水 type=3 提现扣减（balance→withdraw 属于商家内部转账）
		if err := tx.Create(&model.MerchantIncomeLog{
			Merchant:     musername,
			GameID:       0,
			Username:     musername,
			PurchaseID:   uint(wo.ID),
			UserPay:      -points,
			Commission:   0,
			MerchantEarn: -points,
			Type:         3,
			Status:       3, // 终态
		}).Error; err != nil {
			return err
		}
		afterBalance = aiPointsRound3(m.BalancePoints - points)
		return nil
	})
	if errTx != nil {
		adminFail(w, http.StatusBadRequest, errTx.Error())
		return
	}
	logger.Info("商家提现申请: 商户 %s 积分 %.3f 订单#%d 余额剩 %.3f", musername, points, orderID, afterBalance)
	adminJSON(w, map[string]interface{}{
		"ok":          true,
		"order_id":    orderID,
		"balance":     afterBalance,
	})
}

// handleMerchantWithdrawOrders GET /api/merchant/withdraw/orders
// 商家自己的提现申请列表：status 可选过滤（0=pending / 1=approved / 2=rejected）+ 分页
func (s *Server) handleMerchantWithdrawOrders(w http.ResponseWriter, r *http.Request) {
	musername := merchantUserFromCtx(r)
	st, _ := strconv.Atoi(r.URL.Query().Get("status"))
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 30
	}
	db := store.DB.Where("merchant = ?", musername)
	if st >= 0 && st <= 2 {
		db = db.Where("status = ?", st)
	}
	var total int64
	db.Model(&model.MerchantWithdrawOrder{}).Count(&total)
	var list []model.MerchantWithdrawOrder
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	statusMap := map[int8]string{0: "待审批", 1: "已批准", 2: "已拒绝"}
	items := make([]map[string]interface{}, 0, len(list))
	for _, o := range list {
		items = append(items, map[string]interface{}{
			"id":            o.ID,
			"points":        aiPointsRound3(o.Points),
			"status":        o.Status,
			"status_text":   statusMap[o.Status],
			"reject_reason": o.RejectReason,
			"operator":      o.Operator,
			"remark":        o.Remark,
			"audit_time":    o.AuditTime,
			"create_time":   o.CreateTime,
		})
	}
	adminJSON(w, map[string]interface{}{"total": total, "page": page, "size": size, "items": items})
}

// ===== 辅助：自然日/周起始 =====

func timeBeginOfDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func timeBeginOfWeek(t time.Time) time.Time {
	// Go time.Weekday: Sunday=0 ... Monday=1
	// 中国习惯周一起始
	offset := (int(t.Weekday()) + 6) % 7 // 周一=0, 周日=6
	day := timeBeginOfDay(t)
	return day.AddDate(0, 0, -offset)
}

