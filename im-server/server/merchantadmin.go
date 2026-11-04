package server

// ===== 商户独立后台·管理端增量（商户独立后台开发文档 §3.4，adminGuard 鉴权） =====
//
// 商户管理：建号（users.role=2 + im_merchant 行）/ 改显示名/分成比例 / 启停 / 重置密码
// 游戏审核：待审核队列 + 通过（audit=2 且自动上架）/ 驳回（audit=3 + 必填理由）

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// registerMerchantAdminRoutes 管理端商户路由（game.go 注册归口调用）。
// 审核路由挂 /admin/api/merchant/audit/*（字面量前缀）：不能挂 /admin/api/game/audit/{id}——
// 与既有 POST /admin/api/game/{id}/version 构成两可匹配（Go 1.22 ServeMux 直接 panic）
func registerMerchantAdminRoutes(s *Server) {
	http.HandleFunc("GET /admin/api/merchants", s.adminGuard(s.handleAdminMerchantList))
	http.HandleFunc("POST /admin/api/merchants", s.adminGuard(s.handleAdminMerchantCreate))
	http.HandleFunc("PUT /admin/api/merchants/{username}", s.adminGuard(s.handleAdminMerchantUpdate))
	// 游戏审核
	http.HandleFunc("GET /admin/api/merchant/audit/list", s.adminGuard(s.handleAdminGameAuditList))
	http.HandleFunc("POST /admin/api/merchant/audit/{id}", s.adminGuard(s.handleAdminGameAuditAct))
}

// handleAdminMerchantList 商户列表（含游戏数与成功充值总额聚合）
func (s *Server) handleAdminMerchantList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.Merchant{})
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		db = db.Where("username LIKE ? OR name LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var list []model.Merchant
	db.Order("id ASC").Offset((page - 1) * size).Limit(size).Find(&list)
	items := make([]map[string]interface{}, 0, len(list))
	for _, m := range list {
		var gameCnt int64
		store.DB.Model(&model.Game{}).Where("owner_username = ?", m.Username).Count(&gameCnt)
		var sum float64
		store.DB.Model(&model.RechargeOrder{}).
			Select("COALESCE(SUM(points),0)").
			Where("status = ? AND game_id IN (?)",
				model.RechargeOrderStatusSuccess,
				store.DB.Model(&model.Game{}).Select("id").Where("owner_username = ?", m.Username)).
			Scan(&sum)
		items = append(items, map[string]interface{}{
			"username": m.Username, "name": m.Name, "commission_rate": m.CommissionRate,
			"status": m.Status, "remark": m.Remark, "game_count": gameCnt,
			"recharge_total": sum,
			"create_time":    m.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

// handleAdminMerchantCreate 创建商户（users.role=2 + im_merchant 行；账号=IM 账号体系）
func (s *Server) handleAdminMerchantCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username       string  `json:"username"`
		Password       string  `json:"password"`
		Name           string  `json:"name"`
		CommissionRate float64 `json:"commission_rate"`
		Remark         string  `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if len(req.Username) < 2 || len(req.Username) > 32 || !isAlphaNum(req.Username) {
		adminFail(w, http.StatusBadRequest, "账号须为 2~32 位字母数字")
		return
	}
	if reservedUsernameRe.MatchString(req.Username) {
		adminFail(w, http.StatusBadRequest, "该用户名不可用")
		return
	}
	if utf8.RuneCountInString(req.Password) < 6 || len(req.Password) > 64 {
		adminFail(w, http.StatusBadRequest, "密码须为 6~64 位")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if utf8.RuneCountInString(req.Name) > 64 {
		adminFail(w, http.StatusBadRequest, "显示名过长（最多 64 字）")
		return
	}
	if req.CommissionRate < 0 || req.CommissionRate > 100 {
		adminFail(w, http.StatusBadRequest, "分成比例须为 0~100")
		return
	}
	var cnt int64
	store.DB.Model(&model.User{}).Where("username = ?", req.Username).Count(&cnt)
	if cnt > 0 {
		adminFail(w, http.StatusConflict, "账号已存在")
		return
	}
	// 双行落库（users 行 + 商户资料行）；users.Points 显式赋值防 GORM 零值插 0 后走默认 100——
	// 商户号不参与游戏充值/消费，赠送与否无意义，直接给 0 并显式归零（registerGiftPoints 语义不适用）
	u := model.User{Username: req.Username, Password: hashPassword(req.Password), Role: 2, Points: 0}
	if err := store.DB.Create(&u).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "账号创建失败")
		return
	}
	store.DB.Model(&model.User{}).Where("username = ?", req.Username).Update("points", 0)
	m := model.Merchant{Username: req.Username, Name: req.Name, CommissionRate: req.CommissionRate, Status: 0, Remark: strings.TrimSpace(req.Remark)}
	if err := store.DB.Create(&m).Error; err != nil {
		store.DB.Where("username = ?", req.Username).Delete(&model.User{}) // 回滚孤儿账号
		adminFail(w, http.StatusInternalServerError, "商户资料创建失败")
		return
	}
	logger.Info("创建商户账号: %s（比例 %.1f%%）, 操作人=%s", req.Username, req.CommissionRate, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"username": req.Username})
}

// handleAdminMerchantUpdate 编辑商户（显示名/比例/启停/重置密码；按 path username 定位）
func (s *Server) handleAdminMerchantUpdate(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	var m model.Merchant
	if err := store.DB.Where("username = ?", username).First(&m).Error; err != nil {
		adminFail(w, http.StatusNotFound, "商户不存在")
		return
	}
	var req struct {
		Name           *string  `json:"name"`
		CommissionRate *float64 `json:"commission_rate"` // 指针：未传=不改（0 也是合法比例值）
		Status         *int8    `json:"status"`
		Password       string   `json:"password"` // 非空=重置密码
		Remark         *string  `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if utf8.RuneCountInString(name) > 64 {
			adminFail(w, http.StatusBadRequest, "显示名过长（最多 64 字）")
			return
		}
		updates["name"] = name
	}
	if req.CommissionRate != nil {
		if *req.CommissionRate < 0 || *req.CommissionRate > 100 {
			adminFail(w, http.StatusBadRequest, "分成比例须为 0~100")
			return
		}
		updates["commission_rate"] = *req.CommissionRate
	}
	if req.Status != nil {
		if *req.Status != 0 && *req.Status != 1 {
			adminFail(w, http.StatusBadRequest, "参数错误")
			return
		}
		updates["status"] = *req.Status
	}
	if req.Remark != nil {
		if utf8.RuneCountInString(*req.Remark) > 255 {
			adminFail(w, http.StatusBadRequest, "备注过长（最多 255 字）")
			return
		}
		updates["remark"] = strings.TrimSpace(*req.Remark)
	}
	if req.Password != "" {
		if utf8.RuneCountInString(req.Password) < 6 || len(req.Password) > 64 {
			adminFail(w, http.StatusBadRequest, "密码须为 6~64 位")
			return
		}
		store.DB.Model(&model.User{}).Where("username = ?", username).Update("password", hashPassword(req.Password))
	}
	if len(updates) > 0 {
		if err := store.DB.Model(&model.Merchant{}).Where("username = ?", username).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败")
			return
		}
	}
	logger.Info("编辑商户 %s（字段 %d 个）, 操作人=%s", username, len(updates), adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameAuditList 审核列表（audit=1 待审核优先；status 可选过滤 1/2/3）
func (s *Server) handleAdminGameAuditList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	st, _ := strconv.Atoi(r.URL.Query().Get("status"))
	db := store.DB.Model(&model.Game{}).Where("owner_username <> ''")
	if st >= 1 && st <= 3 {
		db = db.Where("audit_status = ?", st)
	} else {
		db = db.Where("audit_status IN ?", []int8{model.GameAuditPending, model.GameAuditApproved, model.GameAuditRejected})
	}
	var games []model.Game
	db.Order("audit_status ASC, id DESC").Limit(200).Find(&games)
	list := make([]map[string]interface{}, 0, len(games))
	for _, g := range games {
		list = append(list, map[string]interface{}{
			"id": g.ID, "slug": g.Slug, "name": g.Name, "short_desc": g.ShortDesc, "cover": g.Cover,
			"screenshots": g.Screenshots, "description": g.Description, "tags": g.Tags,
			"price": g.Price, "status": g.Status,
			"recharge_enabled": g.RechargeEnabled, "recharge_rate": g.RechargeRate,
			"owner_username": g.OwnerUsername, "audit_status": g.AuditStatus,
			"audit_remark": g.AuditRemark, "audit_time": g.AuditTime,
			"create_time": g.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"list": list})
}

// handleAdminGameAuditAct 审核动作：通过（audit=2 + 自动上架）/驳回（audit=3 + 必填理由）
func (s *Server) handleAdminGameAuditAct(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	if g.OwnerUsername == "" {
		adminFail(w, http.StatusBadRequest, "官方游戏无需审核")
		return
	}
	var req struct {
		Action string `json:"action"` // pass / reject
		Remark string `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	now := time.Now()
	operator := adminUserFromCtx(r)
	switch strings.ToLower(strings.TrimSpace(req.Action)) {
	case "pass":
		updates := map[string]interface{}{
			"audit_status": model.GameAuditApproved, "audit_remark": "",
			"audit_time": &now, "audited_by": operator,
			"status": 0, // 通过即上架（商户此前无从上架；玩家侧过滤墙随 audit=2 放行）
		}
		if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "审核操作失败")
			return
		}
		logger.Info("游戏审核通过: %s (%s), 商户=%s, 操作人=%s", g.Name, g.Slug, g.OwnerUsername, operator)
		adminJSON(w, map[string]interface{}{"ok": true, "audit_status": model.GameAuditApproved})
	case "reject":
		remark := strings.TrimSpace(req.Remark)
		if remark == "" {
			adminFail(w, http.StatusBadRequest, "驳回必须填写理由")
			return
		}
		if utf8.RuneCountInString(remark) > 255 {
			adminFail(w, http.StatusBadRequest, "驳回理由过长（最多 255 字）")
			return
		}
		updates := map[string]interface{}{
			"audit_status": model.GameAuditRejected, "audit_remark": remark,
			"audit_time": &now, "audited_by": operator,
		}
		if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "审核操作失败")
			return
		}
		logger.Info("游戏审核驳回: %s (%s), 商户=%s, 理由=%s, 操作人=%s", g.Name, g.Slug, g.OwnerUsername, remark, operator)
		adminJSON(w, map[string]interface{}{"ok": true, "audit_status": model.GameAuditRejected})
	default:
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("未知审核动作: %s", req.Action))
	}
}
