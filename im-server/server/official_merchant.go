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
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// officialContentTypeWhitelist 服务号消息/模板 content_type 白名单
// text 纯文本（默认）/ notify 通知卡片 / news 图文卡片 / news_list 多图文列表 / miniapp 小程序入口
var officialContentTypeWhitelist = map[string]bool{
	"text":      true,
	"notify":    true,
	"news":      true,
	"news_list": true,
	"miniapp":   true,
}

// isValidOfficialContentType 校验服务号 content_type 是否合法
func isValidOfficialContentType(ct string) bool {
	return officialContentTypeWhitelist[ct]
}

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
	http.HandleFunc("GET /api/merchant/official/messages", s.merchantGuard(s.handleOfficialMerchantMessageList))
	http.HandleFunc("POST /api/merchant/official/messages/{id}/recall", s.merchantGuard(s.handleOfficialMerchantMessageRecall))
	http.HandleFunc("GET /api/merchant/official/audit/pending", s.merchantGuard(s.handleOfficialMerchantAuditPending))
	http.HandleFunc("GET /api/merchant/official/audit/all", s.merchantGuard(s.handleOfficialMerchantAuditAll))
	http.HandleFunc("POST /api/merchant/official/audit/{id}/approve", s.merchantGuard(s.handleOfficialMerchantAuditApprove))
	http.HandleFunc("POST /api/merchant/official/audit/{id}/reject", s.merchantGuard(s.handleOfficialMerchantAuditReject))

	// 统计
	http.HandleFunc("GET /api/merchant/official/stats", s.merchantGuard(s.handleOfficialMerchantStats))

	// ===== 用户公开订阅接口（扫码关注用） =====
	// 公开服务号详情（无需登录）
	http.HandleFunc("GET /api/official/accounts/{app_id}", s.handleOfficialPublicAccountGet)
	// 订阅 / 取消订阅（需登录态：Bearer Token 或同源 Cookie）
	http.HandleFunc("POST /api/official/subscribe/{app_id}", s.handleOfficialPublicSubscribe)
	http.HandleFunc("POST /api/official/unsubscribe/{app_id}", s.handleOfficialPublicUnsubscribe)
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
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
		Content     string `json:"content"`
		Example     string `json:"example"`
		TemplateID  string `json:"template_id"`
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
	req.ContentType = strings.TrimSpace(req.ContentType)
	if req.ContentType == "" {
		req.ContentType = "text"
	}
	if !isValidOfficialContentType(req.ContentType) {
		adminFail(w, http.StatusBadRequest, "content_type 不合法，可选：text/notify/news/news_list/miniapp")
		return
	}
	tplID := strings.TrimSpace(req.TemplateID)
	if tplID == "" {
		b := make([]byte, 4)
		rand.Read(b)
		tplID = "tpl_" + hex.EncodeToString(b)
	}
	tpl := model.OfficialTemplate{
		AccountID:   acc.ID,
		TemplateID:  tplID,
		Name:        req.Name,
		ContentType: req.ContentType,
		Content:     req.Content,
		Example:     req.Example,
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
		Name        *string `json:"name"`
		ContentType *string `json:"content_type"`
		Content     *string `json:"content"`
		Example     *string `json:"example"`
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
	if req.ContentType != nil {
		v := strings.TrimSpace(*req.ContentType)
		if v == "" {
			v = "text"
		}
		if !isValidOfficialContentType(v) {
			adminFail(w, http.StatusBadRequest, "content_type 不合法，可选：text/notify/news/news_list/miniapp")
			return
		}
		updates["content_type"] = v
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

// ============= 手动推送（商户后台 /api/merchant/official/send） =============
// 鉴权走 merchantGuard（商户登录态 + owner 归属校验），无需 AppSecret
// 底层复用 official_api.go 的同一套入库 + 发送核心

func (s *Server) handleOfficialMerchantSend(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	if merchantUser == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	var req struct {
		AccountID   uint              `json:"account_id"`   // 必填，目标服务号
		Type        string            `json:"type"`         // single / batch / broadcast，默认 single
		Recipients  []string          `json:"recipients"`   // single/batch 必填
		TemplateID  string            `json:"template_id"`
		TemplateData map[string]string `json:"template_data"`
		Title       string            `json:"title"`
		Content     string            `json:"content"`
		ContentType string            `json:"content_type"`
		URL         string            `json:"url"`
		LinkBtn     string            `json:"link_btn"`
		NeedAudit   *bool             `json:"need_audit"` // 可强制覆盖服务号默认
		// 阶段二百九十三 P2：notify 卡片扩展字段
		Status     string        `json:"status"`
		BadgeColor string        `json:"badge_color"`
		Fields     []NotifyField `json:"fields"`
	}
	if err := jsonReadBody(r, &req, 1<<20); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	if req.AccountID == 0 {
		adminFail(w, http.StatusBadRequest, "account_id 必填")
		return
	}
	// 归属校验：确保是当前商户自己的服务号
	acc, ok := merchantOwnOfficial(merchantUser, req.AccountID)
	if !ok {
		adminFail(w, http.StatusForbidden, "服务号不存在或无权限")
		return
	}

	// 默认值
	if strings.TrimSpace(req.Type) == "" {
		req.Type = "single"
	}
	if strings.TrimSpace(req.ContentType) == "" {
		req.ContentType = "text"
	}

	// 模板渲染
	if req.TemplateID != "" {
		var tpl model.OfficialTemplate
		if err := store.DB.Where("template_id = ? AND account_id = ?", req.TemplateID, acc.ID).First(&tpl).Error; err == nil {
			// text 模板：content 就是一段占位符文本
			if strings.TrimSpace(tpl.ContentType) == "text" || strings.TrimSpace(tpl.ContentType) == "" {
				req.ContentType = "text"
				req.Content = renderOfficialTemplate(tpl.Content, req.TemplateData)
			} else {
				// 结构化模板：从模板 content JSON 里填充专属字段，发送接口显式传的值优先覆盖
				if req.ContentType == "text" || req.ContentType == "" {
					req.ContentType = strings.TrimSpace(tpl.ContentType)
				}
				var sendReq OfficialSendReq
				fillOfficialTemplateFields(tpl, req.TemplateData, &sendReq)
				// 回填：模板默认值 + 发送接口显式传的值
				if req.Title == "" {
					req.Title = sendReq.Title
				}
				if req.Content == "" {
					req.Content = sendReq.Content
				}
				if req.Status == "" {
					req.Status = sendReq.Status
				}
				if req.BadgeColor == "" {
					req.BadgeColor = sendReq.BadgeColor
				}
				if len(req.Fields) == 0 {
					req.Fields = sendReq.Fields
				}
				if req.URL == "" {
					req.URL = sendReq.URL
				}
				if req.LinkBtn == "" {
					req.LinkBtn = sendReq.LinkBtn
				}
			}
		}
	}
	if strings.TrimSpace(req.Content) == "" && strings.TrimSpace(req.Title) == "" {
		adminFail(w, http.StatusBadRequest, "消息内容/标题至少填一项（请填写 content 或使用 template_id）")
		return
	}

	// need_audit 回退
	needAudit := acc.NeedAudit
	if req.NeedAudit != nil {
		needAudit = *req.NeedAudit
	}

	// 配额校验
	if acc.MaxPerDay > 0 {
		ctx := context.Background()
		sent, _ := store.RDB.Get(ctx, "im:official:daily:"+acc.AppID).Int()
		estimated := sent
		switch req.Type {
		case "batch":
			estimated += len(req.Recipients)
		case "single":
			estimated += 1
		}
		if estimated > acc.MaxPerDay {
			adminFail(w, http.StatusTooManyRequests, "超过每日配额（max_per_day="+strconv.Itoa(acc.MaxPerDay)+"）")
			return
		}
	}

	// single/batch 格式校验
	if req.Type == "single" && len(req.Recipients) != 1 {
		adminFail(w, http.StatusBadRequest, "single 模式必须提供恰好 1 个 recipient")
		return
	}
	if req.Type == "batch" {
		if len(req.Recipients) == 0 {
			adminFail(w, http.StatusBadRequest, "batch 模式必须提供 recipients")
			return
		}
		if len(req.Recipients) > 1000 {
			adminFail(w, http.StatusBadRequest, "batch 单次最多 1000 用户，超过请分批或用 API 网关的 batch-notify")
			return
		}
	}

	// 入库
	om := model.OfficialMessage{
		AccountID:   acc.ID,
		AppID:       acc.AppID,
		Recipient:   strings.Join(req.Recipients, ","),
		Title:       req.Title,
		ContentType: req.ContentType,
		Content:     req.Content,
		TriggerType: "merchant",
	}
	if needAudit {
		om.AuditStatus = "pending"
		om.SendStatus = "pending"
	} else {
		om.AuditStatus = "none"
		om.SendStatus = "sending"
	}
	if err := store.DB.Create(&om).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "入库失败: "+err.Error())
		return
	}

	// 审核路径 vs 直通路径
	if needAudit {
		audit := model.OfficialAudit{
			MessageID: om.ID,
			AccountID: acc.ID,
			AppID:     acc.AppID,
			Status:    "pending",
		}
		store.DB.Create(&audit)
		logger.Info("商户推送进入审核队列 merchant=%s app=%s message_id=%d type=%s",
			merchantUser, acc.AppID, om.ID, req.Type)
		adminJSON(w, map[string]interface{}{
			"ok": true, "code": 0, "message": "已进入审核队列",
			"message_id": om.ID, "audit_status": "pending",
		})
		return
	}

	// 直通：调用发送核心
	sreq := OfficialSendReq{
		AccountID:   acc.ID,
		AppID:       acc.AppID,
		Title:       req.Title,
		ContentType: req.ContentType,
		Content:     req.Content,
		URL:         req.URL,
		LinkBtn:     req.LinkBtn,
		TriggerType: "merchant",
		MessageID:   om.ID,
		// 阶段二百九十三 P2：notify 卡片扩展字段
		Status:     req.Status,
		BadgeColor: req.BadgeColor,
		Fields:     req.Fields,
	}
	switch req.Type {
	case "broadcast":
		s.SendOfficialBroadcast(sreq)
	case "batch":
		s.SendOfficialBatchMsg(sreq, req.Recipients)
	default: // single
		s.SendOfficialMsg(sreq, req.Recipients[0])
	}

	adminJSON(w, map[string]interface{}{
		"ok": true, "code": 0, "message": "发送已入队",
		"message_id": om.ID, "type": req.Type,
	})
}

func (s *Server) handleOfficialMerchantStats(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	if merchantUser == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	// 聚合商户名下所有服务号的今日推送量
	type row struct {
		AppID    string `json:"app_id"`
		Name     string `json:"display_name"`
		TodaySent int   `json:"today_sent"`
	}
	var rows []row
	store.DB.Model(&model.OfficialAccount{}).
		Select("app_id, display_name, today_sent").
		Where("owner = ?", merchantUser).
		Scan(&rows)
	total := 0
	for _, r := range rows {
		total += r.TodaySent
	}
	adminJSON(w, map[string]interface{}{
		"ok": true, "accounts": rows, "total_today_sent": total,
	})
}

// ============= 推送历史 & 撤回（P6：商户后台撤回已发消息） =============

// handleOfficialMerchantMessageList 商户推送历史列表（归属隔离，只返回本商户服务号的推送记录）
func (s *Server) handleOfficialMerchantMessageList(w http.ResponseWriter, r *http.Request) {
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
	if size < 1 || size > 200 {
		size = 20
	}
	db := store.DB.Model(&model.OfficialMessage{}).
		Joins("JOIN im_official_account a ON a.id = im_official_message.account_id").
		Where("a.owner = ?", merchantUser)
	if aid := q.Get("account_id"); aid != "" {
		db = db.Where("im_official_message.account_id = ?", aid)
	}
	if st := q.Get("send_status"); st != "" {
		db = db.Where("im_official_message.send_status = ?", st)
	}
	var total int64
	db.Count(&total)
	var list []model.OfficialMessage
	if err := db.Order("im_official_message.id DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{
		"list":  list,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// handleOfficialMerchantMessageRecall 商户撤回已发推送
// 约束：send_status='sent' 才能撤；群发（recipient 为空）暂不支持
func (s *Server) handleOfficialMerchantMessageRecall(w http.ResponseWriter, r *http.Request) {
	merchantUser := merchantUserFromCtx(r)
	if merchantUser == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	idStr := r.PathValue("id")
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var rec model.OfficialMessage
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "记录不存在")
		return
	}
	// 归属校验
	if _, ok := merchantOwnOfficial(merchantUser, rec.AccountID); !ok {
		adminFail(w, http.StatusForbidden, "无权操作")
		return
	}
	if rec.SendStatus != "sent" {
		adminFail(w, http.StatusBadRequest, "当前状态不可撤回（仅已发送的消息可撤回）")
		return
	}
	if rec.Recipient == "" {
		adminFail(w, http.StatusBadRequest, "群发消息暂不支持撤回")
		return
	}
	if strings.Contains(rec.Recipient, ",") {
		adminFail(w, http.StatusBadRequest, "批量消息暂不支持撤回")
		return
	}
	if rec.MsgID == 0 {
		adminFail(w, http.StatusBadRequest, "消息未落库，无法撤回")
		return
	}

	// 1+2. 事务：同时更新 official_message 和 im_message，保证一致
	tx := store.DB.Begin()
	if err := tx.Model(&rec).Update("send_status", "recalled").Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "撤回失败: "+err.Error())
		return
	}
	if res := tx.Model(&model.Message{}).Where("id = ? AND recalled = 0", rec.MsgID).Update("recalled", 1); res.Error != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "撤回失败: "+res.Error.Error())
		return
	}
	if err := tx.Commit().Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "撤回失败: "+err.Error())
		return
	}

	// 3. WS 通知订阅用户
	recallContent, _ := json.Marshal(map[string]interface{}{
		"msg_id":           rec.MsgID,
		"official_msg_id":   rec.ID,
	})
	recallMsg, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeOfficialRecall,
		FromUser:  "o_" + rec.AppID,
		ToUser:    rec.Recipient,
		Content:   string(recallContent),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(rec.Recipient, recallMsg)

	logger.Info("服务号撤回：商户 %s 撤回 app=%s msg_id=%d recipient=%s", merchantUser, rec.AppID, rec.MsgID, rec.Recipient)

	adminJSON(w, map[string]interface{}{
		"ok":      true,
		"message": "撤回成功",
	})
}

// ============= 用户公开订阅接口（扫码关注用） =============

// resolvePublicUser 从 Bearer Token 或同源 Cookie 取 username
// 多前缀尝试：商户 token → 直接 username；API token → JSON payload；Cookie 同上
func (s *Server) resolvePublicUser(r *http.Request) string {
	// 1. Bearer Token
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return resolveTokenUsername(strings.TrimPrefix(auth, "Bearer "))
	}
	// 2. Cookie
	cookie, err := r.Cookie("im_user_token")
	if err == nil {
		return resolveTokenUsername(cookie.Value)
	}
	return ""
}

// resolveTokenUsername 尝试多 token key 前缀解析 username
func resolveTokenUsername(token string) string {
	if token == "" {
		return ""
	}
	ctx := context.Background()
	// 前缀 1：商户 token（value 直接是 username）
	if v, err := store.RDB.Get(ctx, "im:merchant:token:"+token).Result(); err == nil && v != "" {
		return v
	}
	// 前缀 2：admin token
	if v, err := store.RDB.Get(ctx, "im:admin:token:"+token).Result(); err == nil && v != "" {
		return v
	}
	// 前缀 3：API token（value 是 JSON payload {username, app_id...}）
	if v, err := store.RDB.Get(ctx, "im:official:token:"+token).Result(); err == nil && v != "" {
		var id struct {
			Username string `json:"username"`
		}
		if json.Unmarshal([]byte(v), &id) == nil && id.Username != "" {
			return id.Username
		}
	}
	// 前缀 4：网盘 drive token（普通聊天用户登录后签发的 token，value 直接是 username）
	if v, err := store.RDB.Get(ctx, store.KeyDriveToken+token).Result(); err == nil && v != "" {
		return v
	}
	return ""
}

// handleOfficialPublicAccountGet 公开服务号详情（无需鉴权）
// 返回 app_id / display_name / avatar / description / subscribe_count / subscribed(若登录)
func (s *Server) handleOfficialPublicAccountGet(w http.ResponseWriter, r *http.Request) {
	appID := strings.TrimSpace(r.PathValue("app_id"))
	if appID == "" {
		adminFail(w, http.StatusBadRequest, "app_id 不能为空")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在或已禁用")
		return
	}
	// 订阅数
	var subCount int64
	store.DB.Model(&model.OfficialSubscribe{}).Where("app_id = ? AND unsubscribed = false", appID).Count(&subCount)
	// 当前用户是否已订阅（如果已登录）
	user := s.resolvePublicUser(r)
	subscribed := false
	if user != "" {
		subscribed = userIsSubscribed(user, appID)
	}
	adminJSON(w, map[string]interface{}{
		"app_id":          acc.AppID,
		"display_name":    acc.DisplayName,
		"avatar":          acc.Avatar,
		"description":     acc.Description,
		"subscribe_count": subCount,
		"subscribed":      subscribed,
		"login_required":  user == "",
	})
}

// checkSubscribeRateLimit 订阅/取消订阅频率限制（Redis 计数器 + TTL）
// 同一用户对同一 app_id，10 秒内最多 allow 次；正常扫码一天才 1 次，阈值很宽
// subscribe 和 unsubscribe 分别限流，互不影响（用户刷了几次订阅后想取消不能被挡）
// action: "sub" 或 "unsub"
// 返回 blocked=true 表示触发限流；err 非空表示 Redis 异常（调用方应放宽放行）
func checkSubscribeRateLimit(user, appID, action string) (bool, error) {
	const allow = 5          // 10 秒内最多 5 次
	window := 10 * time.Second
	key := fmt.Sprintf("im:official:ratelimit:%s:%s:%s", action, user, appID)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	count, err := store.RDB.Incr(ctx, key).Result()
	if err != nil {
		return false, err
	}
	// 首次建立计数器 → 设 TTL（滑动窗口简化版）
	if count == 1 {
		_ = store.RDB.Expire(ctx, key, window).Err()
	}
	if count > allow {
		logger.Warn("订阅限流触发 action=%s user=%s app=%s count=%d", action, user, appID, count)
		return true, nil
	}
	return false, nil
}

// retrySendWelcome 异步重试欢迎消息推送（指数退避：2s → 4s → 8s，最多 maxRetries 次）
func retrySendWelcome(s *Server, req OfficialSendReq, user string, maxRetries int) {
	for attempt := 1; attempt <= maxRetries; attempt++ {
		backoff := time.Duration(1<<uint(attempt)) * time.Second // 2s, 4s, 8s
		time.Sleep(backoff)
		if err := s.sendOfficialOne(req, user); err != nil {
			logger.Error("欢迎消息重试推送失败 attempt=%d/%d user=%s app=%s err=%s",
				attempt, maxRetries, user, req.AppID, err)
		} else {
			logger.Info("欢迎消息重试推送成功 user=%s app=%s attempt=%d", user, req.AppID, attempt)
			return
		}
	}
	logger.Error("欢迎消息推送最终放弃（已重试 %d 次）user=%s app=%s", maxRetries, user, req.AppID)
}

// handleOfficialPublicSubscribe 用户订阅（需登录态）
func (s *Server) handleOfficialPublicSubscribe(w http.ResponseWriter, r *http.Request) {
	user := s.resolvePublicUser(r)
	if user == "" {
		adminFail(w, http.StatusUnauthorized, "请先登录")
		return
	}
	appID := strings.TrimSpace(r.PathValue("app_id"))
	// 频率限制：同一用户对同一 app_id，10 秒内最多 5 次（防脚本刷订阅计数；正常扫码一天才 1 次，阈值很宽）
	if blocked, err := checkSubscribeRateLimit(user, appID, "sub"); err != nil {
		logger.Warn("订阅限流 Redis 异常，放宽放行: %s", err)
	} else if blocked {
		adminFail(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在或已禁用")
		return
	}
	if err := s.doSubscribe(user, &acc, "qr_scan"); err != nil {
		logger.Error("扫码订阅失败 user=%s app=%s err=%s", user, acc.AppID, err)
		adminFail(w, http.StatusInternalServerError, "订阅失败: "+err.Error())
		return
	}
	logger.Info("扫码订阅：user=%s app=%s name=%s", user, acc.AppID, acc.DisplayName)
	// 给用户推一条欢迎消息（sendOfficialOne 会自己构造信封，Content 只传纯文本）
	welcomeContent := acc.Description
	if welcomeContent == "" {
		welcomeContent = "感谢您的关注！"
	}
	req := OfficialSendReq{
		AccountID:   acc.ID,
		AppID:       acc.AppID,
		Title:       "欢迎关注「" + acc.DisplayName + "」",
		ContentType: "text",
		Content:     welcomeContent,
		TriggerType: "subscribe",
	}
	// 落库 + 推送；失败则异步重试（指数退避，最多 3 次，间隔 2s/4s/8s）
	if err := s.sendOfficialOne(req, user); err != nil {
		logger.Error("扫码订阅欢迎消息推送失败 user=%s app=%s err=%s，将异步重试", user, acc.AppID, err)
		go retrySendWelcome(s, req, user, 3)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "message": "订阅成功"})
}

// handleOfficialPublicUnsubscribe 用户取消订阅（需登录态）
func (s *Server) handleOfficialPublicUnsubscribe(w http.ResponseWriter, r *http.Request) {
	user := s.resolvePublicUser(r)
	if user == "" {
		adminFail(w, http.StatusUnauthorized, "请先登录")
		return
	}
	appID := strings.TrimSpace(r.PathValue("app_id"))
	// 频率限制：同 subscribe，取消也是幂等操作，刷太多没意义
	if blocked, err := checkSubscribeRateLimit(user, appID, "unsub"); err != nil {
		logger.Warn("取消订阅限流 Redis 异常，放宽放行: %s", err)
	} else if blocked {
		adminFail(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	if err := s.doUnsubscribe(user, &acc); err != nil {
		logger.Error("扫码取消订阅失败 user=%s app=%s err=%s", user, acc.AppID, err)
		adminFail(w, http.StatusInternalServerError, "取消订阅失败: "+err.Error())
		return
	}
	logger.Info("扫码取消订阅：user=%s app=%s name=%s", user, acc.AppID, acc.DisplayName)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "message": "已取消关注"})
}
