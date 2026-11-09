package server

// ============= 阶段二百九十三：服务号商户后台 P1 实现 =============
//
// 路由 /api/merchant/official/*，与 admin 后台 API 完全隔离
// 商户只能操作 owner = 自己 username 的服务号（SQL 层归属校验）
// 功能覆盖：服务号 CRUD / 菜单 / 模板 / 手动发送（归属受限）
// 归属校验通过 merchantUserFromCtx 取当前商户用户名 + merchantOwnOfficial() 二次验证

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// registerOfficialMerchantRoutes 商户后台服务号路由（merchant.go 启动时追加）
func registerOfficialMerchantRoutes(s *Server) {
	// 服务号 CRUD（归属受限）
	http.HandleFunc("GET /api/merchant/official/accounts", s.merchantGuard(s.handleOfficialMerchantAccountList))
	http.HandleFunc("POST /api/merchant/official/accounts", s.merchantGuard(s.handleOfficialMerchantAccountCreate))
	http.HandleFunc("PUT /api/merchant/official/accounts/{id}", s.merchantGuard(s.handleOfficialMerchantAccountUpdate))
	http.HandleFunc("DELETE /api/merchant/official/accounts/{id}", s.merchantGuard(s.handleOfficialMerchantAccountDelete))
	http.HandleFunc("PUT /api/merchant/official/accounts/{id}/secret", s.merchantGuard(s.handleOfficialMerchantAccountResetSecret))
	http.HandleFunc("GET /api/merchant/official/accounts/{id}", s.merchantGuard(s.handleOfficialMerchantAccountGet))

	// 菜单 / 模板
	http.HandleFunc("GET /api/merchant/official/accounts/{id}/menu", s.merchantGuard(s.handleOfficialMerchantMenuList))
	http.HandleFunc("POST /api/merchant/official/accounts/{id}/menu", s.merchantGuard(s.handleOfficialMerchantMenuSet))
	http.HandleFunc("GET /api/merchant/official/accounts/{id}/templates", s.merchantGuard(s.handleOfficialMerchantTplList))
	http.HandleFunc("POST /api/merchant/official/accounts/{id}/templates", s.merchantGuard(s.handleOfficialMerchantTplCreate))
	http.HandleFunc("PUT /api/merchant/official/templates/{id}", s.merchantGuard(s.handleOfficialMerchantTplUpdate))
	http.HandleFunc("DELETE /api/merchant/official/templates/{id}", s.merchantGuard(s.handleOfficialMerchantTplDelete))

	// 关键词自动回复（P7）
	http.HandleFunc("GET /api/merchant/official/accounts/{id}/keywords", s.merchantGuard(s.handleOfficialMerchantKwList))
	http.HandleFunc("POST /api/merchant/official/accounts/{id}/keywords", s.merchantGuard(s.handleOfficialMerchantKwCreate))
	http.HandleFunc("PUT /api/merchant/official/keywords/{id}", s.merchantGuard(s.handleOfficialMerchantKwUpdate))
	http.HandleFunc("DELETE /api/merchant/official/keywords/{id}", s.merchantGuard(s.handleOfficialMerchantKwDelete))

	// 手动推送 / 审核（P3/P5）
	http.HandleFunc("POST /api/merchant/official/send", s.merchantGuard(s.handleOfficialMerchantSend))
	http.HandleFunc("GET /api/merchant/official/audit/pending", s.merchantGuard(s.handleOfficialMerchantAuditPending))
	http.HandleFunc("GET /api/merchant/official/audit/all", s.merchantGuard(s.handleOfficialMerchantAuditAll))
	http.HandleFunc("POST /api/merchant/official/audit/{id}/approve", s.merchantGuard(s.handleOfficialMerchantAuditApprove))
	http.HandleFunc("POST /api/merchant/official/audit/{id}/reject", s.merchantGuard(s.handleOfficialMerchantAuditReject))

	// 统计
	http.HandleFunc("GET /api/merchant/official/stats", s.merchantGuard(s.handleOfficialMerchantStats))
}

// merchantOwnOfficial 商户服务号归属校验（SQL 层隔离，owner 不匹配一律返回零值）
func merchantOwnOfficial(merchantUser string, accountID uint) (model.OfficialAccount, bool) {
	var acc model.OfficialAccount
	if err := store.DB.Where("id = ? AND owner = ?", accountID, merchantUser).First(&acc).Error; err != nil {
		return acc, false
	}
	return acc, true
}

// ============= 服务号 CRUD（商户侧，owner 强制设为 merchantUserFromCtx） =============

func (s *Server) handleOfficialMerchantAccountList(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	if merchantUser == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.OfficialAccount{}).Where("owner = ?", merchantUser)
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		db = db.Where("display_name LIKE ? OR app_id LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var list []model.OfficialAccount
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	// 聚合订阅数
	ids := make([]uint, 0, len(list))
	for _, a := range list {
		ids = append(ids, a.ID)
	}
	subCount := map[uint]int64{}
	if len(ids) > 0 {
		var rows []struct {
			AccountID uint
			Cnt       int64
		}
		store.DB.Model(&model.OfficialSubscribe{}).
			Select("account_id, COUNT(*) as cnt").
			Where("account_id IN ? AND unsubscribed = false", ids).
			Group("account_id").Scan(&rows)
		for _, row := range rows {
			subCount[row.AccountID] = row.Cnt
		}
	}
	items := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		items = append(items, map[string]interface{}{
			"id":              a.ID,
			"app_id":          a.AppID,
			"display_name":    a.DisplayName,
			"description":     a.Description,
			"status":          a.Status,
			"need_audit":      a.NeedAudit,
			"max_per_day":     a.MaxPerDay,
			"subscribe_count": subCount[a.ID],
			"today_sent":      a.TodaySent,
			"avatar":          a.Avatar,
			"create_time":     a.CreateTime,
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

func (s *Server) handleOfficialMerchantAccountGet(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	var subCnt int64
	store.DB.Model(&model.OfficialSubscribe{}).Where("account_id = ? AND unsubscribed = false", acc.ID).Count(&subCnt)
	adminJSON(w, map[string]interface{}{"account": acc, "subscribe_count": subCnt})
}

func (s *Server) handleOfficialMerchantAccountCreate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	if merchantUser == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	var req struct {
		DisplayName string `json:"display_name"`
		Description string `json:"description"`
		Avatar      string `json:"avatar"`
		NeedAudit   *bool  `json:"need_audit"`
		MaxPerDay   int    `json:"max_per_day"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		adminFail(w, http.StatusBadRequest, "display_name 不能为空")
		return
	}
	// 生成唯一 app_id
	var appID string
	for i := 0; i < 3; i++ {
		b := make([]byte, 4)
		rand.Read(b)
		candidate := "o_" + hex.EncodeToString(b)
		var exists int64
		store.DB.Model(&model.OfficialAccount{}).Where("app_id = ?", candidate).Count(&exists)
		if exists == 0 {
			appID = candidate
			break
		}
	}
	if appID == "" {
		adminFail(w, http.StatusInternalServerError, "生成 app_id 失败，请重试")
		return
	}
	sb := make([]byte, 16)
	rand.Read(sb)
	plainSecret := hex.EncodeToString(sb)
	needAudit := true // 商户默认开启审核（管理员可关闭）
	if req.NeedAudit != nil {
		needAudit = *req.NeedAudit
	}
	acc := model.OfficialAccount{
		Owner:       merchantUser, // 强制归属当前商户
		AppID:       appID,
		AppSecret:   plainSecret,
		PlainSecret: plainSecret,
		DisplayName: req.DisplayName,
		Description: req.Description,
		Avatar:      strings.TrimSpace(req.Avatar),
		NeedAudit:   needAudit,
		MaxPerDay:   req.MaxPerDay,
		Status:      0,
	}
	if err := store.DB.Create(&acc).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "创建失败: "+err.Error())
		return
	}
	logger.Info("商户 %s 创建服务号 %s", merchantUser, appID)
	adminJSON(w, map[string]interface{}{
		"id": acc.ID, "app_id": acc.AppID, "app_secret": plainSecret,
		"message": "创建成功，请妥善保管 app_secret（仅显示一次）",
	})
}

func (s *Server) handleOfficialMerchantAccountUpdate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	var req struct {
		DisplayName *string `json:"display_name"`
		Description *string `json:"description"`
		Avatar      *string `json:"avatar"`
		NeedAudit   *bool   `json:"need_audit"`
		MaxPerDay   *int    `json:"max_per_day"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.DisplayName != nil {
		v := strings.TrimSpace(*req.DisplayName)
		if v == "" {
			adminFail(w, http.StatusBadRequest, "display_name 不能为空")
			return
		}
		updates["display_name"] = v
	}
	if req.Description != nil {
		updates["description"] = strings.TrimSpace(*req.Description)
	}
	if req.Avatar != nil {
		updates["avatar"] = strings.TrimSpace(*req.Avatar)
	}
	if req.NeedAudit != nil {
		updates["need_audit"] = *req.NeedAudit
	}
	if req.MaxPerDay != nil {
		updates["max_per_day"] = *req.MaxPerDay
	}
	if len(updates) == 0 {
		adminFail(w, http.StatusBadRequest, "未提供任何修改字段")
		return
	}
	updates["update_time"] = time.Now()
	if err := store.DB.Model(&acc).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "更新失败: "+err.Error())
		return
	}
	store.RDB.Del(context.Background(), "im:official:cache:accounts")
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialMerchantAccountDelete(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	tx := store.DB.Begin()
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialMenu{})
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialTemplate{})
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialSubscribe{})
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialMessage{})
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialAudit{})
	tx.Delete(&acc)
	tx.Commit()
	store.RDB.Del(context.Background(), "im:official:cache:accounts")
	logger.Info("商户 %s 删除服务号 %s", merchantUser, acc.AppID)
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialMerchantAccountResetSecret(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	sb := make([]byte, 16)
	rand.Read(sb)
	plainSecret := hex.EncodeToString(sb)
	acc.AppSecret = plainSecret
	acc.PlainSecret = plainSecret
	if err := store.DB.Save(&acc).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "重置失败: "+err.Error())
		return
	}
	logger.Info("商户 %s 重置服务号密钥 id=%d", merchantUser, id)
	adminJSON(w, map[string]interface{}{
		"app_id": acc.AppID, "app_secret": plainSecret,
		"message": "密钥已重置，原密钥立即失效。请妥善保管新密钥（仅显示一次）",
	})
}

// ============= 菜单 / 模板（归属校验复用 merchantOwnOfficial） =============

func (s *Server) handleOfficialMerchantMenuList(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	var menus []model.OfficialMenu
	store.DB.Where("account_id = ?", acc.ID).Order("parent_id ASC, sort_order ASC").Find(&menus)
	type node struct {
		model.OfficialMenu
		Children []node `json:"children,omitempty"`
	}
	roots := []node{}
	byParent := map[uint][]node{}
	for _, m := range menus {
		n := node{OfficialMenu: m}
		if m.ParentID == 0 {
			roots = append(roots, n)
		} else {
			byParent[m.ParentID] = append(byParent[m.ParentID], n)
		}
	}
	var attach func(nodes []node) []node
	attach = func(nodes []node) []node {
		out := []node{}
		for _, n := range nodes {
			n.Children = attach(byParent[n.ID])
			out = append(out, n)
		}
		return out
	}
	adminJSON(w, map[string]interface{}{"menus": attach(roots)})
}

func (s *Server) handleOfficialMerchantMenuSet(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	// 复用 admin 菜单逻辑但改 account_id 归属
	var req struct {
		Menus []struct {
			Name     string `json:"name"`
			Action   string `json:"action"`
			Value    string `json:"value"`
			Children []struct {
				Name   string `json:"name"`
				Action string `json:"action"`
				Value  string `json:"value"`
			} `json:"children"`
		} `json:"menus"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	if len(req.Menus) > 3 {
		adminFail(w, http.StatusBadRequest, "一级菜单最多 3 个")
		return
	}
	tx := store.DB.Begin()
	tx.Where("account_id = ?", acc.ID).Delete(&model.OfficialMenu{})
	sortIdx := 0
	for _, m := range req.Menus {
		name := strings.TrimSpace(m.Name)
		act := strings.TrimSpace(m.Action)
		if act == "" {
			act = "click"
		}
		root := model.OfficialMenu{
			AccountID: acc.ID, ParentID: 0, Name: name,
			Action: act, Value: strings.TrimSpace(m.Value), SortOrder: sortIdx,
		}
		tx.Create(&root)
		sortIdx++
		for _, c := range m.Children {
			cname := strings.TrimSpace(c.Name)
			cact := strings.TrimSpace(c.Action)
			if cact == "" {
				cact = "click"
			}
			child := model.OfficialMenu{
				AccountID: acc.ID, ParentID: root.ID, Name: cname,
				Action: cact, Value: strings.TrimSpace(c.Value), SortOrder: sortIdx,
			}
			tx.Create(&child)
			sortIdx++
		}
	}
	tx.Commit()
	store.RDB.Del(context.Background(), "im:official:cache:menu:"+acc.AppID)
	adminJSON(w, map[string]interface{}{"ok": true, "menu_count": sortIdx})
}

func (s *Server) handleOfficialMerchantTplList(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	var list []model.OfficialTemplate
	store.DB.Where("account_id = ?", acc.ID).Order("id DESC").Find(&list)
	adminJSON(w, list)
}

func (s *Server) handleOfficialMerchantTplCreate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	acc, ok := merchantOwnOfficial(merchantUser, uint(id))
	if !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	var req struct {
		Name       string `json:"name"`
		Content    string `json:"content"`
		Example    string `json:"example"`
		TemplateID string `json:"template_id"`
	}
	if err := jsonDecodeLimit(w, r, &req, 32768); err != nil {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Content = strings.TrimSpace(req.Content)
	if req.Name == "" || req.Content == "" {
		adminFail(w, http.StatusBadRequest, "name 和 content 不能为空")
		return
	}
	tplID := strings.TrimSpace(req.TemplateID)
	if tplID == "" {
		b := make([]byte, 4)
		rand.Read(b)
		tplID = "tpl_" + hex.EncodeToString(b)
	}
	tpl := model.OfficialTemplate{
		AccountID: acc.ID, TemplateID: tplID, Name: req.Name,
		Content: req.Content, Example: req.Example,
	}
	if err := store.DB.Create(&tpl).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "创建失败: "+err.Error())
		return
	}
	adminJSON(w, tpl)
}

func (s *Server) handleOfficialMerchantTplUpdate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	var tpl model.OfficialTemplate
	if err := store.DB.First(&tpl, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "模板不存在")
		return
	}
	// 归属校验：模板所属服务号必须属于当前商户
	if _, ok := merchantOwnOfficial(merchantUser, tpl.AccountID); !ok {
		adminFail(w, http.StatusNotFound, "模板不存在或无权限")
		return
	}
	var req struct {
		Name    *string `json:"name"`
		Content *string `json:"content"`
		Example *string `json:"example"`
	}
	if err := jsonDecodeLimit(w, r, &req, 32768); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.Name != nil {
		v := strings.TrimSpace(*req.Name)
		if v != "" {
			updates["name"] = v
		}
	}
	if req.Content != nil {
		v := strings.TrimSpace(*req.Content)
		if v != "" {
			updates["content"] = v
		}
	}
	if req.Example != nil {
		updates["example"] = *req.Example
	}
	if len(updates) == 0 {
		adminFail(w, http.StatusBadRequest, "未提供任何修改字段")
		return
	}
	store.DB.Model(&tpl).Updates(updates)
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialMerchantTplDelete(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	var tpl model.OfficialTemplate
	if err := store.DB.First(&tpl, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "模板不存在")
		return
	}
	if _, ok := merchantOwnOfficial(merchantUser, tpl.AccountID); !ok {
		adminFail(w, http.StatusNotFound, "模板不存在或无权限")
		return
	}
	store.DB.Delete(&tpl)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// ============= 关键词自动回复（P7）—— 复用 admin 逻辑 + merchantOwnOfficial 归属隔离 =============

func (s *Server) handleOfficialMerchantKwList(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	if _, ok := merchantOwnOfficial(merchantUser, uint(id)); !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	s.handleOfficialAdminKwList(w, r)
}

func (s *Server) handleOfficialMerchantKwCreate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	if _, ok := merchantOwnOfficial(merchantUser, uint(id)); !ok {
		adminFail(w, http.StatusNotFound, "服务号不存在或无权限")
		return
	}
	s.handleOfficialAdminKwCreate(w, r)
}

func (s *Server) handleOfficialMerchantKwUpdate(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	var kw model.OfficialKeyword
	if err := store.DB.First(&kw, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "关键词不存在")
		return
	}
	if _, ok := merchantOwnOfficial(merchantUser, kw.AccountID); !ok {
		adminFail(w, http.StatusNotFound, "关键词不存在或无权限")
		return
	}
	s.handleOfficialAdminKwUpdate(w, r)
}

func (s *Server) handleOfficialMerchantKwDelete(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	id, _ := strconv.Atoi(r.PathValue("id"))
	var kw model.OfficialKeyword
	if err := store.DB.First(&kw, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "关键词不存在")
		return
	}
	if _, ok := merchantOwnOfficial(merchantUser, kw.AccountID); !ok {
		adminFail(w, http.StatusNotFound, "关键词不存在或无权限")
		return
	}
	s.handleOfficialAdminKwDelete(w, r)
}

// ============= 预留骨架（P3/P5 已完成审核部分，此处仅手动推送） =============

func (s *Server) handleOfficialMerchantSend(w http.ResponseWriter, r *http.Request) {
	adminFail(w, http.StatusNotImplemented, "P3 阶段实现")
}

func (s *Server) handleOfficialMerchantStats(w http.ResponseWriter, r *http.Request) {
	// P4 实现：聚合商户名下所有服务号的推送统计
	adminFail(w, http.StatusNotImplemented, "P4 阶段实现")
}
