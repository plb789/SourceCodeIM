package server

// ============= 阶段二百九十三：服务号管理员后台 CRUD + 菜单 + 模板 =============
//
// 本文件归口：管理员（adminGuard）后台 API，注册路径 /admin/api/official/*
//   CRUD 服务号 / 自定义菜单 / 模板 / 重置密钥
//   审核管理（P5 预留骨架，handleOfficialAdminAudit*）
//   手动推送（P3 预留骨架，handleOfficialAdminSend）
//
// 路由注册：在 admin.go RegisterAdminRoutes 末尾调用 registerOfficialAdminRoutes
// 商户后台归口 official_merchant.go（路由 /api/merchant/official/*）
// 用户端信令归口 official.go（WebSocket MsgType 113-120）
// 消息推送核心归口 official_message.go
// HTTP API 网关归口 official_api.go（/api/official/*）

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// registerOfficialAdminRoutes 管理员后台服务号路由（admin.go 启动时调用）
func registerOfficialAdminRoutes(s *Server) {
	// 服务号 CRUD
	http.HandleFunc("GET /admin/api/official/accounts", s.adminGuard(s.handleOfficialAdminAccountList))
	http.HandleFunc("POST /admin/api/official/accounts", s.adminGuard(s.handleOfficialAdminAccountCreate))
	http.HandleFunc("PUT /admin/api/official/accounts/{id}", s.adminGuard(s.handleOfficialAdminAccountUpdate))
	http.HandleFunc("DELETE /admin/api/official/accounts/{id}", s.adminGuard(s.handleOfficialAdminAccountDelete))
	http.HandleFunc("PUT /admin/api/official/accounts/{id}/secret", s.adminGuard(s.handleOfficialAdminAccountResetSecret))
	// 服务号详情
	http.HandleFunc("GET /admin/api/official/accounts/{id}", s.adminGuard(s.handleOfficialAdminAccountGet))

	// 自定义菜单
	http.HandleFunc("GET /admin/api/official/accounts/{id}/menu", s.adminGuard(s.handleOfficialAdminMenuList))
	http.HandleFunc("POST /admin/api/official/accounts/{id}/menu", s.adminGuard(s.handleOfficialAdminMenuSet))

	// 模板（按 account_id 归属隔离，跨 account_id 的 template_id 全局唯一）
	http.HandleFunc("GET /admin/api/official/accounts/{id}/templates", s.adminGuard(s.handleOfficialAdminTplList))
	http.HandleFunc("POST /admin/api/official/accounts/{id}/templates", s.adminGuard(s.handleOfficialAdminTplCreate))
	http.HandleFunc("PUT /admin/api/official/templates/{id}", s.adminGuard(s.handleOfficialAdminTplUpdate))
	http.HandleFunc("DELETE /admin/api/official/templates/{id}", s.adminGuard(s.handleOfficialAdminTplDelete))

	// 关键词自动回复（P7）
	http.HandleFunc("GET /admin/api/official/accounts/{id}/keywords", s.adminGuard(s.handleOfficialAdminKwList))
	http.HandleFunc("POST /admin/api/official/accounts/{id}/keywords", s.adminGuard(s.handleOfficialAdminKwCreate))
	http.HandleFunc("PUT /admin/api/official/keywords/{id}", s.adminGuard(s.handleOfficialAdminKwUpdate))
	http.HandleFunc("DELETE /admin/api/official/keywords/{id}", s.adminGuard(s.handleOfficialAdminKwDelete))

	// 审核管理（P5）
	http.HandleFunc("GET /admin/api/official/audit/pending", s.adminGuard(s.handleOfficialAdminAuditPending))
	http.HandleFunc("GET /admin/api/official/audit/all", s.adminGuard(s.handleOfficialAdminAuditAll))
	http.HandleFunc("POST /admin/api/official/audit/{id}/approve", s.adminGuard(s.handleOfficialAdminAuditApprove))
	http.HandleFunc("POST /admin/api/official/audit/{id}/reject", s.adminGuard(s.handleOfficialAdminAuditReject))

	// 手动推送（P3）
	http.HandleFunc("POST /admin/api/official/send", s.adminGuard(s.handleOfficialAdminSend))

	// 订阅关系查询（管理面板预览订阅用户）
	http.HandleFunc("GET /admin/api/official/accounts/{id}/subscribers", s.adminGuard(s.handleOfficialAdminSubscribers))
}

// ============= 服务号 CRUD =============

// handleOfficialAdminAccountList GET /admin/api/official/accounts
// 查询参数：page, size(默认20), keyword(按 display_name LIKE), owner(按归属过滤), status(0/1)
// 额外聚合：subscribe_count（LEFT JOIN official_subscribe COUNT）
func (s *Server) handleOfficialAdminAccountList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.OfficialAccount{})
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		db = db.Where("display_name LIKE ? OR app_id LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	if ow := strings.TrimSpace(q.Get("owner")); ow != "" {
		if ow == "system" {
			db = db.Where("owner = ''")
		} else {
			db = db.Where("owner = ?", ow)
		}
	}
	if st := q.Get("status"); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 2 {
			db = db.Where("status = ?", int8(v))
		}
	}
	var total int64
	db.Count(&total)
	var list []model.OfficialAccount
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	// 聚合订阅人数
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
			"id":               a.ID,
			"app_id":           a.AppID,
			"owner":            a.Owner,
			"display_name":     a.DisplayName,
			"description":      a.Description,
			"status":           a.Status,
			"need_audit":       a.NeedAudit,
			"max_per_day":      a.MaxPerDay,
			"subscribe_count":  subCount[a.ID],
			"today_sent":       a.TodaySent,
			"avatar":           a.Avatar,
			"create_time":      a.CreateTime,
			"update_time":      a.UpdateTime,
			// AppSecret 不明文返回（创建时单独返回一次）
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

// handleOfficialAdminAccountGet GET /admin/api/official/accounts/{id}
func (s *Server) handleOfficialAdminAccountGet(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	var subCnt int64
	store.DB.Model(&model.OfficialSubscribe{}).Where("account_id = ? AND unsubscribed = false", acc.ID).Count(&subCnt)
	adminJSON(w, map[string]interface{}{
		"account":          acc,
		"subscribe_count":  subCnt,
	})
}

// handleOfficialAdminAccountCreate POST /admin/api/official/accounts
// 自动生成 app_id（o_ + 8 位 hex）与 app_secret（32 位 hex），明文仅创建时返回一次
func (s *Server) handleOfficialAdminAccountCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Owner       string `json:"owner"`        // 空=系统级；非空=指定商户用户名
		DisplayName string `json:"display_name"`
		Description string `json:"description"`
		Avatar      string `json:"avatar"`
		NeedAudit   *bool  `json:"need_audit"`   // 指针字段：未传=跟随默认
		MaxPerDay   int    `json:"max_per_day"`  // 0=不限
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		adminFail(w, http.StatusBadRequest, "display_name 不能为空")
		return
	}
	// Owner 归属校验：非空时校验对应用户存在且 role=2（商户）
	owner := strings.TrimSpace(req.Owner)
	if owner != "" {
		var u model.User
		if err := store.DB.Where("username = ? AND role = 2", owner).First(&u).Error; err != nil {
			adminFail(w, http.StatusBadRequest, "归属商户账号不存在或无权限")
			return
		}
	}
	// 生成唯一 app_id（循环重试过稀碰撞）
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
	// 生成 app_secret（32 字节 hex = 64 字符）
	sb := make([]byte, 16)
	rand.Read(sb)
	plainSecret := hex.EncodeToString(sb)

	// need_audit 默认 false
	needAudit := false
	if req.NeedAudit != nil {
		needAudit = *req.NeedAudit
	}

	acc := model.OfficialAccount{
		Owner:       owner,
		AppID:       appID,
		AppSecret:   plainSecret, // 开发阶段明文存（正式环境应 bcrypt hash + PlainSecret 内存加载）
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
	logger.Info("管理员创建服务号 %s (owner=%s)", appID, owner)

	adminJSON(w, map[string]interface{}{
		"id":         acc.ID,
		"app_id":     acc.AppID,
		"app_secret": plainSecret, // 仅创建时返回明文一次，前端提示"妥善保管"
		"message":    "创建成功，请妥善保管 app_secret（仅显示一次）",
	})
}

// handleOfficialAdminAccountUpdate PUT /admin/api/official/accounts/{id}
// 指针字段语义：nil=不修改；非 nil（含 *bool=false）=覆盖
func (s *Server) handleOfficialAdminAccountUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var req struct {
		DisplayName *string `json:"display_name"`
		Description *string `json:"description"`
		Avatar      *string `json:"avatar"`
		Status      *int8   `json:"status"`       // 0/1/2
		NeedAudit   *bool   `json:"need_audit"`
		MaxPerDay   *int    `json:"max_per_day"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
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
	if req.Status != nil {
		v := *req.Status
		if v < 0 || v > 2 {
			adminFail(w, http.StatusBadRequest, "status 必须为 0/1/2")
			return
		}
		updates["status"] = v
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
	// Redis 缓存失效
	store.RDB.Del(context.Background(), "im:official:cache:accounts")
	logger.Info("管理员更新服务号 id=%d", id)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleOfficialAdminAccountDelete DELETE /admin/api/official/accounts/{id}
// 级联删除：menu / template / subscribe / message / audit（事务包）
func (s *Server) handleOfficialAdminAccountDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	tx := store.DB.Begin()
	if err := tx.Where("account_id = ?", id).Delete(&model.OfficialMenu{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除菜单失败: "+err.Error())
		return
	}
	if err := tx.Where("account_id = ?", id).Delete(&model.OfficialTemplate{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除模板失败: "+err.Error())
		return
	}
	if err := tx.Where("account_id = ?", id).Delete(&model.OfficialSubscribe{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除订阅关系失败: "+err.Error())
		return
	}
	if err := tx.Where("account_id = ?", id).Delete(&model.OfficialMessage{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除推送记录失败: "+err.Error())
		return
	}
	if err := tx.Where("account_id = ?", id).Delete(&model.OfficialAudit{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除审核记录失败: "+err.Error())
		return
	}
	if err := tx.Delete(&acc).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "删除服务号失败: "+err.Error())
		return
	}
	tx.Commit()
	// Redis 清理
	store.RDB.Del(context.Background(), "im:official:cache:accounts")
	logger.Info("管理员删除服务号 id=%d app_id=%s", id, acc.AppID)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleOfficialAdminAccountResetSecret PUT /admin/api/official/accounts/{id}/secret
// 重新生成 app_secret，返回明文一次
func (s *Server) handleOfficialAdminAccountResetSecret(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	sb := make([]byte, 16)
	rand.Read(sb)
	plainSecret := hex.EncodeToString(sb)
	acc.AppSecret = plainSecret // 开发阶段明文存
	acc.PlainSecret = plainSecret
	if err := store.DB.Save(&acc).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "重置失败: "+err.Error())
		return
	}
	logger.Info("管理员重置服务号密钥 id=%d", id)
	adminJSON(w, map[string]interface{}{
		"app_id":     acc.AppID,
		"app_secret": plainSecret,
		"message":    "密钥已重置，原密钥立即失效。请妥善保管新密钥（仅显示一次）",
	})
}

// ============= 自定义菜单 =============

// handleOfficialAdminMenuList GET /admin/api/official/accounts/{id}/menu
// 返回 JSON 数组（扁平 + parent_id，前端自行组树；也可服务端组树返回）
func (s *Server) handleOfficialAdminMenuList(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	var menus []model.OfficialMenu
	if err := store.DB.Where("account_id = ?", id).Order("parent_id ASC, sort_order ASC, id ASC").Find(&menus).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询菜单失败: "+err.Error())
		return
	}
	// 组树：一级 → children[二级...]
	type menuNode struct {
		model.OfficialMenu
		Children []menuNode `json:"children,omitempty"`
	}
	roots := []menuNode{}
	byParent := map[uint][]menuNode{}
	for _, m := range menus {
		node := menuNode{OfficialMenu: m}
		if m.ParentID == 0 {
			roots = append(roots, node)
		} else {
			byParent[m.ParentID] = append(byParent[m.ParentID], node)
		}
	}
	var attach func(nodes []menuNode) []menuNode
	attach = func(nodes []menuNode) []menuNode {
		out := []menuNode{}
		for _, n := range nodes {
			n.Children = attach(byParent[n.ID])
			out = append(out, n)
		}
		return out
	}
	adminJSON(w, map[string]interface{}{
		"account_id": id,
		"app_id":     acc.AppID,
		"menus":      attach(roots),
	})
}

// handleOfficialAdminMenuSet POST /admin/api/official/accounts/{id}/menu
// 前端提交完整菜单树 JSON，服务端校验（最多 3 一级 × 5 二级）+ 事务重写
// 入参：{ menus: [{ name, action, value, children: [{name, action, value}] }] }
func (s *Server) handleOfficialAdminMenuSet(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
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
	// 事务：先删后插，按原始 req.Menus 顺序插一级并回填 children 的 parent_id
	tx := store.DB.Begin()
	if err := tx.Where("account_id = ?", uint(id)).Delete(&model.OfficialMenu{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "清空旧菜单失败: "+err.Error())
		return
	}
	sortIdx := 0
	for _, m := range req.Menus {
		name := strings.TrimSpace(m.Name)
		if name == "" {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "菜单名不能为空")
			return
		}
		act := strings.TrimSpace(m.Action)
		if act == "" {
			act = "click"
		}
		if act != "click" && act != "view" {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "菜单 action 必须为 click 或 view")
			return
		}
		root := model.OfficialMenu{
			AccountID: uint(id), ParentID: 0, Name: name,
			Action: act, Value: strings.TrimSpace(m.Value), SortOrder: sortIdx,
		}
		if err := tx.Create(&root).Error; err != nil {
			tx.Rollback()
			adminFail(w, http.StatusInternalServerError, "插入菜单失败: "+err.Error())
			return
		}
		sortIdx++
		if len(m.Children) > 5 {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "单个一级菜单下二级菜单最多 5 个")
			return
		}
		for _, c := range m.Children {
			cname := strings.TrimSpace(c.Name)
			if cname == "" {
				tx.Rollback()
				adminFail(w, http.StatusBadRequest, "菜单名不能为空")
				return
			}
			cact := strings.TrimSpace(c.Action)
			if cact == "" {
				cact = "click"
			}
			if cact != "click" && cact != "view" {
				tx.Rollback()
				adminFail(w, http.StatusBadRequest, "菜单 action 必须为 click 或 view")
				return
			}
			child := model.OfficialMenu{
				AccountID: uint(id), ParentID: root.ID, Name: cname,
				Action: cact, Value: strings.TrimSpace(c.Value), SortOrder: sortIdx,
			}
			if err := tx.Create(&child).Error; err != nil {
				tx.Rollback()
				adminFail(w, http.StatusInternalServerError, "插入菜单失败: "+err.Error())
				return
			}
			sortIdx++
		}
	}
	tx.Commit()
	logger.Info("管理员更新服务号菜单 account_id=%d", id)
	store.RDB.Del(context.Background(), "im:official:cache:menu:"+acc.AppID)
	adminJSON(w, map[string]interface{}{"ok": true, "menu_count": sortIdx})
}

// ============= 模板 =============

func (s *Server) handleOfficialAdminTplList(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var list []model.OfficialTemplate
	if err := store.DB.Where("account_id = ?", id).Order("id DESC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	adminJSON(w, list)
}

func (s *Server) handleOfficialAdminTplCreate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	var req struct {
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
		Content     string `json:"content"`
		Example     string `json:"example"`
		TemplateID  string `json:"template_id"` // 可选：不传自动生成
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
		// 自动生成：tpl_ + 8 位 hex
		b := make([]byte, 4)
		rand.Read(b)
		tplID = "tpl_" + hex.EncodeToString(b)
	}
	tpl := model.OfficialTemplate{
		AccountID:   uint(id),
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
	logger.Info("管理员创建模板 template_id=%s account_id=%d", tplID, id)
	adminJSON(w, tpl)
}

func (s *Server) handleOfficialAdminTplUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
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
	var tpl model.OfficialTemplate
	if err := store.DB.First(&tpl, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "模板不存在")
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
	if err := store.DB.Model(&tpl).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "更新失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialAdminTplDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if err := store.DB.Delete(&model.OfficialTemplate{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// ============= 关键词自动回复（P7）—— 按 account_id 归属隔离 =============

func (s *Server) handleOfficialAdminKwList(w http.ResponseWriter, r *http.Request) {
	accID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var list []model.OfficialKeyword
	if err := store.DB.Where("account_id = ?", accID).Order("sort_order ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	adminJSON(w, list)
}

func (s *Server) handleOfficialAdminKwCreate(w http.ResponseWriter, r *http.Request) {
	accID, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var req struct {
		Keyword   string `json:"keyword"`
		ReplyText string `json:"reply_text"`
		MatchType string `json:"match_type"` // exact / fuzzy
		Enabled   *bool  `json:"enabled"`
		SortOrder int    `json:"sort_order"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	req.Keyword = strings.TrimSpace(req.Keyword)
	req.ReplyText = strings.TrimSpace(req.ReplyText)
	if req.Keyword == "" || req.ReplyText == "" {
		adminFail(w, http.StatusBadRequest, "keyword 和 reply_text 不能为空")
		return
	}
	req.MatchType = strings.TrimSpace(req.MatchType)
	if req.MatchType == "" {
		req.MatchType = "fuzzy"
	}
	if req.MatchType != "exact" && req.MatchType != "fuzzy" {
		adminFail(w, http.StatusBadRequest, "match_type 必须是 exact 或 fuzzy")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	kw := model.OfficialKeyword{
		AccountID: uint(accID),
		Keyword:   req.Keyword,
		ReplyText: req.ReplyText,
		MatchType: req.MatchType,
		Enabled:   enabled,
		SortOrder: req.SortOrder,
	}
	if err := store.DB.Create(&kw).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "创建失败: "+err.Error())
		return
	}
	adminJSON(w, kw)
}

func (s *Server) handleOfficialAdminKwUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var req struct {
		Keyword   *string `json:"keyword"`
		ReplyText *string `json:"reply_text"`
		MatchType *string `json:"match_type"`
		Enabled   *bool   `json:"enabled"`
		SortOrder *int    `json:"sort_order"`
	}
	if err := jsonDecodeLimit(w, r, &req, 8192); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.Keyword != nil {
		v := strings.TrimSpace(*req.Keyword)
		if v != "" {
			updates["keyword"] = v
		}
	}
	if req.ReplyText != nil {
		v := strings.TrimSpace(*req.ReplyText)
		if v != "" {
			updates["reply_text"] = v
		}
	}
	if req.MatchType != nil {
		v := strings.TrimSpace(*req.MatchType)
		if v == "exact" || v == "fuzzy" {
			updates["match_type"] = v
		}
	}
	if req.Enabled != nil {
		updates["enabled"] = *req.Enabled
	}
	if req.SortOrder != nil {
		updates["sort_order"] = *req.SortOrder
	}
	if len(updates) == 0 {
		adminFail(w, http.StatusBadRequest, "未提供任何修改字段")
		return
	}
	if err := store.DB.Model(&model.OfficialKeyword{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "更新失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialAdminKwDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if err := store.DB.Delete(&model.OfficialKeyword{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

func (s *Server) handleOfficialAdminSubscribers(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
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
	var total int64
	db := store.DB.Model(&model.OfficialSubscribe{}).Where("account_id = ? AND unsubscribed = false", id)
	db.Count(&total)
	var list []model.OfficialSubscribe
	db.Order("subscribe_time DESC").Offset((page - 1) * size).Limit(size).Find(&list)
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// ============= 审核管理（P5 完整实现） =============

// handleOfficialAdminAuditPending GET /admin/api/official/audit/pending — 待办队列
// 管理员可看全部 pending；商户（通过 merchantGuard 调 merchant 版本）只看自己 owner 的
func (s *Server) handleOfficialAdminAuditPending(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditList(w, r, "pending", "")
}

// handleOfficialAdminAuditAll GET /admin/api/official/audit/all — 所有审核（含已完成）
// 分页 + 状态过滤 + 服务号归属过滤
func (s *Server) handleOfficialAdminAuditAll(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditList(w, r, "", "")
}

// handleOfficialMerchantAuditPending 商户侧待办（归属 owner 限制 + 授权 auditors 也可审核）
func (s *Server) handleOfficialMerchantAuditPending(w http.ResponseWriter, r *http.Request) {
	user := merchantUserFromCtx(r)
	s.handleOfficialAuditList(w, r, "pending", user)
}

// handleOfficialAdminAuditApprove POST /admin/api/official/audit/{id}/approve
// 单人审批通过 → 直接 approved → 触发 sendOfficialAfterAudit 进 Worker Pool
func (s *Server) handleOfficialAdminAuditApprove(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditAct(w, r, true, adminUserFromCtx(r))
}

// handleOfficialAdminAuditReject POST /admin/api/official/audit/{id}/reject
// 审核驳回（单人即生效，必须填写原因）
func (s *Server) handleOfficialAdminAuditReject(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditAct(w, r, false, adminUserFromCtx(r))
}

// handleOfficialMerchantAuditApprove 商户侧通过
func (s *Server) handleOfficialMerchantAuditApprove(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditAct(w, r, true, merchantUserFromCtx(r))
}

// handleOfficialMerchantAuditReject 商户侧驳回
func (s *Server) handleOfficialMerchantAuditReject(w http.ResponseWriter, r *http.Request) {
	s.handleOfficialAuditAct(w, r, false, merchantUserFromCtx(r))
}

// handleOfficialMerchantAuditAll 商户侧全部
func (s *Server) handleOfficialMerchantAuditAll(w http.ResponseWriter, r *http.Request) {
	user := merchantUserFromCtx(r)
	s.handleOfficialAuditList(w, r, "", user)
}

// handleOfficialAuditList 审核列表统一实现
// statusFilter: 空=全部；pending/approved/rejected 过滤
// ownerFilter: 空=全部（admin 调用）；非空=归属商户（merchant 调用，只看自己 owner + auditors 列表中含自己的）
func (s *Server) handleOfficialAuditList(w http.ResponseWriter, r *http.Request, statusFilter, ownerFilter string) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.OfficialAudit{})
	if statusFilter != "" {
		db = db.Where("im_official_audit.status = ?", statusFilter)
	}
	// ownerFilter：商户调用时，只看自己 owner 或 auditors 列表包含自己的
	if ownerFilter != "" {
		// JSON_CONTAINS 第二个参数必须是 JSON 字面量：字符串要双引号包裹
		// 用 GORM 参数化防止 JSON 字面量里的引号逃逸注入
		db = db.Joins("JOIN im_official_account acc ON acc.id = im_official_audit.account_id").
			Where("acc.owner = ? OR JSON_CONTAINS(acc.auditors, CAST(? AS JSON))",
				ownerFilter, "{\"" + strings.ReplaceAll(ownerFilter, "\"", "\\\"") + "\"}")
	}
	var total int64
	db.Count(&total)
	var audits []model.OfficialAudit
	if err := db.Order("im_official_audit.create_time DESC").
		Offset((page - 1) * size).Limit(size).Find(&audits).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败: "+err.Error())
		return
	}
	// 批量关联 official_message 与 official_account
	messageIDs := make([]uint, 0, len(audits))
	for _, a := range audits {
		messageIDs = append(messageIDs, a.MessageID)
	}
	msgMap := map[uint]model.OfficialMessage{}
	if len(messageIDs) > 0 {
		var msgs []model.OfficialMessage
		store.DB.Where("id IN ?", messageIDs).Find(&msgs)
		for _, m := range msgs {
			msgMap[m.ID] = m
		}
	}
	accountIDs := make([]uint, 0, len(audits))
	for _, a := range audits {
		accountIDs = append(accountIDs, a.AccountID)
	}
	accMap := map[uint]model.OfficialAccount{}
	if len(accountIDs) > 0 {
		var accs []model.OfficialAccount
		store.DB.Where("id IN ?", accountIDs).Find(&accs)
		for _, a := range accs {
			accMap[a.ID] = a
		}
	}
	// 组响应
	type auditItem struct {
		model.OfficialAudit
		Message       model.OfficialMessage       `json:"message"`
		AccountName   string                      `json:"account_name"`
		AccountAppID  string                      `json:"account_app_id"`
	}
	items := make([]auditItem, 0, len(audits))
	for _, a := range audits {
		item := auditItem{OfficialAudit: a}
		if m, ok := msgMap[a.MessageID]; ok {
			item.Message = m
		}
		if acc, ok := accMap[a.AccountID]; ok {
			item.AccountName = acc.DisplayName
			item.AccountAppID = acc.AppID
		}
		items = append(items, item)
	}
	adminJSON(w, map[string]interface{}{
		"list": items, "total": total, "page": page, "size": size,
	})
}

// handleOfficialAuditAct 审核动作统一实现（通过/驳回）
// approve → 单人直接 approved；reject → 单人直接 rejected（remark 必填）
func (s *Server) handleOfficialAuditAct(w http.ResponseWriter, r *http.Request, approve bool, auditorUsername string) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if strings.TrimSpace(auditorUsername) == "" {
		adminFail(w, http.StatusUnauthorized, "未登录")
		return
	}
	var body struct {
		Remark string `json:"remark"` // 驳回必填
	}
	_ = jsonDecodeLimit(w, r, &body, 4096)
	body.Remark = strings.TrimSpace(body.Remark)

	var audit model.OfficialAudit
	if err := store.DB.First(&audit, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "审核记录不存在")
		return
	}
	if audit.Status != "pending" {
		adminFail(w, http.StatusBadRequest, "审核记录已处理（状态="+audit.Status+"）")
		return
	}
	if !approve && body.Remark == "" {
		adminFail(w, http.StatusBadRequest, "驳回必须填写原因（remark）")
		return
	}

	// 权限校验：admin 可审核全部；商户审核自己 owner 或 auditors 白名单中的服务号
	acc, err := officialAccountByID(audit.AccountID)
	if err != nil {
		adminFail(w, http.StatusNotFound, "服务号不存在")
		return
	}
	if acc.Owner != "" && acc.Owner != auditorUsername {
		var auditors []string
		if acc.Auditors != "" {
			json.Unmarshal([]byte(acc.Auditors), &auditors)
		}
		isAuditor := false
		for _, a := range auditors {
			if a == auditorUsername {
				isAuditor = true
				break
			}
		}
		if !isAuditor {
			adminFail(w, http.StatusForbidden, "无权限审核该服务号")
			return
		}
	}

	newStatus := "approved"
	if !approve {
		newStatus = "rejected"
	}

	tx := store.DB.Begin()
	now := time.Now()

	// 审核记录：落最终状态 + 谁审的
	auditorsList := []string{auditorUsername}
	if err := tx.Model(&audit).Updates(map[string]interface{}{
		"auditors":    string(mustJSON(auditorsList)),
		"status":      newStatus,
		"update_time": now,
	}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "审核记录更新失败")
		return
	}

	// 同步 official_message 审核结果
	msgUpdates := map[string]interface{}{
		"audit_by":    auditorUsername,
		"audit_time":  now,
		"audit_status": newStatus,
	}
	if approve {
		msgUpdates["send_status"] = "approved"
	} else {
		msgUpdates["audit_remark"] = body.Remark
		msgUpdates["send_status"] = "failed"
	}
	if err := tx.Model(&model.OfficialMessage{}).Where("id = ?", audit.MessageID).Updates(msgUpdates).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "消息记录更新失败")
		return
	}
	tx.Commit()

	// 后置动作
	if approve {
		var om model.OfficialMessage
		store.DB.First(&om, audit.MessageID)
		go s.sendOfficialAfterAudit(om)
		logger.Info("审核通过桥接发送 message_id=%d app=%s", audit.MessageID, audit.AppID)
	} else {
		logger.Info("审核驳回 message_id=%d reason=%s actor=%s", audit.MessageID, body.Remark, auditorUsername)
	}

	s.broadcastOfficialAuditAck(audit, acc, newStatus, body.Remark, auditorUsername)

	adminJSON(w, map[string]interface{}{
		"code": 0, "status": newStatus,
	})
}

// broadcastOfficialAuditAck 审核状态变更后推 118 MSG_Ack 给所有审核人 + 商户 owner（发起人）
func (s *Server) broadcastOfficialAuditAck(audit model.OfficialAudit, acc *model.OfficialAccount, status, remark, actor string) {
	envelope, _ := json.Marshal(map[string]interface{}{
		"message_id":   audit.MessageID,
		"audit_id":     audit.ID,
		"app_id":       audit.AppID,
		"status":       status,
		"remark":       remark,
		"actor":        actor,
		"account_name":  acc.DisplayName,
	})
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialMsgAck,
		FromUser:  "system",
		FromName:  "服务号审核",
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(chatMsg)
	// 收集接收人
	recipients := map[string]bool{}
	var auditorsList []string
	json.Unmarshal([]byte(audit.Auditors), &auditorsList)
	for _, u := range auditorsList {
		recipients[u] = true
	}
	if acc.Owner != "" {
		recipients[acc.Owner] = true
	}
	for u := range recipients {
		if u == "" {
			continue
		}
		if s.isOnlineFast(u) {
			s.sendToUser(u, data)
		} else {
			s.queueOffline(u, &chatMsg)
		}
	}
	logger.Info("审核状态推送 ack status=%s receivers=%d", status, len(recipients))
}

// officialAccountByID 按主键查服务号（审核权限校验用）
func officialAccountByID(id uint) (*model.OfficialAccount, error) {
	var acc model.OfficialAccount
	if err := store.DB.First(&acc, id).Error; err != nil {
		return nil, err
	}
	return &acc, nil
}



// ============= 手动推送（P3 预留骨架） =============

func (s *Server) handleOfficialAdminSend(w http.ResponseWriter, r *http.Request) {
	adminFail(w, http.StatusNotImplemented, "P3 阶段实现")
}

// ============= 工具 =============

// bcryptHashString 占位：真实实现应接 golang.org/x/crypto/bcrypt
// 骨架阶段直接返回空串（当前版本明文同时存 PlainSecret 字段，鉴权逻辑不受影响）
func bcryptHashString(plain string) string {
	_ = plain
	return ""
}
