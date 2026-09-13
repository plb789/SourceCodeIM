package server

// ===== 阶段五十七：用户端个人智能体（自建/编辑/删除，仅归属者可见可对话） =====
// 与管理端 /admin/api/ai/agents 的分工：管理员建公共智能体（Owner 空，全员可见），
// 用户建个人智能体（Scope=user，Owner=本人，仅自己可见可对话，提示词/头像/模型自定）
// 归口复用：配置白名单（config.yaml ai.user_agent，模型供给归口防费用失控）、
// 运行时热更新（aiChangeApply：重建索引+按用户视角广播）、名称全局唯一（对话路由按名字的协议约束）
// 鉴权水位：与 /api/kb、/upload/* 系列一致（username 查询参数）

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// userAgentCreateReq 用户自建/编辑智能体请求体
type userAgentSaveReq struct {
	Name         string `json:"name"`
	Avatar       string `json:"avatar"`
	SystemPrompt string `json:"system_prompt"`
	Provider     string `json:"provider"`
	Enabled      *bool  `json:"enabled"` // 可选（不传保持现状/默认启用）
}

// aiUserProviderAllowed 白名单校验归口：provider 名须在 config.yaml ai.user_agent.providers 白名单内，
// 且该模型服务在数据库中存在并启用（双通道校验，防白名单配置漂移后失效名仍可选）
func aiUserProviderAllowed(name string) bool {
	name = strings.TrimSpace(name)
	allowed := false
	for _, p := range aiUserProviders {
		if p == name {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}
	var count int64
	store.DB.Model(&model.AIProvider{}).Where("name = ? AND enabled = ?", name, true).Count(&count)
	return count > 0
}

// HandleUserAgentGet 用户端智能体管理总览：功能开关 + 可选模型白名单 + 我的个人智能体完整信息（编辑表单数据源）
func (s *Server) HandleUserAgentGet(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	// 白名单展示：名称 + 模型名（前端下拉展示用，不含密钥）
	provs := make([]map[string]interface{}, 0, len(aiUserProviders))
	for _, p := range aiUserProviders {
		var rec model.AIProvider
		if err := store.DB.Where("name = ? AND enabled = ?", p, true).First(&rec).Error; err != nil {
			continue // 白名单中已停用/已删除的服务不下发
		}
		provs = append(provs, map[string]interface{}{"name": rec.Name, "model": rec.Model})
	}
	// 我的个人智能体（完整字段，编辑表单回显）
	var mine []model.AIAgent
	store.DB.Where("scope = ? AND owner = ?", "user", username).Order("id ASC").Find(&mine)
	adminJSON(w, map[string]interface{}{
		"enabled":      aiUserEnabled,
		"providers":    provs,
		"max_per_user": aiUserMaxPerUser,
		"mine":         mine,
	})
}

// userAgentValidate 用户自建/编辑智能体字段校验归口（create 与 update 共用）
// 返回 (错误消息, HTTP 状态码)；空串表示通过
func userAgentValidate(name, avatar, prompt, provider string, promptMax int) (string, int) {
	if name == "" {
		return "智能体名称不能为空", http.StatusBadRequest
	}
	// 与表字段宽度对齐的轻校验（varchar(64)，按字符数）
	if utf8.RuneCountInString(name) > 64 {
		return "智能体名称过长（最多 64 字）", http.StatusBadRequest
	}
	if utf8.RuneCountInString(avatar) > 255 {
		return "头像标识过长", http.StatusBadRequest
	}
	if utf8.RuneCountInString(prompt) > promptMax {
		return "提示词过长（最多 " + strconv.Itoa(promptMax) + " 字）", http.StatusBadRequest
	}
	if !aiUserProviderAllowed(provider) {
		return "所选模型不在可用范围内（请联系管理员在 config.yaml ai.user_agent 配置白名单）", http.StatusBadRequest
	}
	return "", 0
}

// HandleUserAgentCreate 用户创建个人智能体（服务端强制 scope=user、owner=当前用户、enabled=true）
func (s *Server) HandleUserAgentCreate(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	// 功能总开关（config.yaml ai.user_agent.enabled 归口，关闭时整体不可用）
	if !aiUserEnabled {
		adminFail(w, http.StatusForbidden, "管理员未开放自建智能体功能")
		return
	}
	var req userAgentSaveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if msg, status := userAgentValidate(req.Name, req.Avatar, req.SystemPrompt, req.Provider, aiUserPromptMax); msg != "" {
		adminFail(w, status, msg)
		return
	}
	// 数量上限（config 归口，防滥用）
	var count int64
	store.DB.Model(&model.AIAgent{}).Where("scope = ? AND owner = ?", "user", username).Count(&count)
	if count >= int64(aiUserMaxPerUser) {
		adminFail(w, http.StatusBadRequest, "自建智能体数量已达上限（"+strconv.Itoa(aiUserMaxPerUser)+" 个）")
		return
	}
	// 名称全局唯一（与管理员公共智能体及他人个人智能体查重——对话路由按名字，重名会歧义）
	var dup int64
	store.DB.Model(&model.AIAgent{}).Where("name = ?", req.Name).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusConflict, "智能体名称已被使用："+req.Name)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	rec := model.AIAgent{
		Name:         req.Name,
		Provider:     strings.TrimSpace(req.Provider),
		SystemPrompt: req.SystemPrompt,
		Avatar:       req.Avatar,
		Enabled:      enabled,
		SortID:       1000, // 个人智能体统一排在管理员公共智能体之后
		Scope:        "user",
		Owner:        username,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("用户 %s 新建智能体 %s 失败: %v", username, req.Name, err)
		adminFail(w, http.StatusInternalServerError, "新建智能体失败")
		return
	}
	logger.Info("用户端：用户 %s 新建个人智能体 %s（id=%d，模型服务 %s）", username, rec.Name, rec.ID, rec.Provider)
	// 热更新归口：重建索引 + 按用户视角广播（本人其他端立即看到新智能体）
	s.aiChangeApply("用户端：用户 " + username + " 新建个人智能体 " + rec.Name)
	adminJSON(w, rec)
}

// HandleUserAgentUpdate 用户编辑本人个人智能体（名称/头像/提示词/模型/启用状态）
func (s *Server) HandleUserAgentUpdate(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	if !aiUserEnabled {
		adminFail(w, http.StatusForbidden, "管理员未开放自建智能体功能")
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.AIAgent
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "智能体不存在")
		return
	}
	// 归属校验：仅本人个人智能体可编辑（公共智能体与管理员的配置走后台管理页）
	if rec.Scope != "user" || rec.Owner != username {
		adminFail(w, http.StatusForbidden, "无权操作该智能体（仅个人智能体归属者可编辑）")
		return
	}
	var req userAgentSaveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if msg, status := userAgentValidate(req.Name, req.Avatar, req.SystemPrompt, req.Provider, aiUserPromptMax); msg != "" {
		adminFail(w, status, msg)
		return
	}
	// 改名时查重（排除自身）
	if req.Name != rec.Name {
		var dup int64
		store.DB.Model(&model.AIAgent{}).Where("name = ? AND id <> ?", req.Name, rec.ID).Count(&dup)
		if dup > 0 {
			adminFail(w, http.StatusConflict, "智能体名称已被使用："+req.Name)
			return
		}
	}
	updates := map[string]interface{}{
		"name":          req.Name,
		"avatar":        req.Avatar,
		"system_prompt": req.SystemPrompt,
		"provider":      strings.TrimSpace(req.Provider),
	}
	if req.Enabled != nil {
		updates["enabled"] = *req.Enabled
	}
	if err := store.DB.Model(&model.AIAgent{}).Where("id = ?", rec.ID).Updates(updates).Error; err != nil {
		logger.Error("用户 %s 编辑智能体 %s 失败: %v", username, rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "编辑智能体失败")
		return
	}
	logger.Info("用户端：用户 %s 编辑个人智能体 %s（id=%d）", username, req.Name, rec.ID)
	s.aiChangeApply("用户端：用户 " + username + " 编辑个人智能体 " + req.Name)
	adminJSON(w, map[string]interface{}{"updated": true})
}

// HandleUserAgentDelete 用户删除本人个人智能体（历史消息保留可回看，仅不可再对话）
func (s *Server) HandleUserAgentDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.AIAgent
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "智能体不存在")
		return
	}
	if rec.Scope != "user" || rec.Owner != username {
		adminFail(w, http.StatusForbidden, "无权操作该智能体（仅个人智能体归属者可删除）")
		return
	}
	if err := store.DB.Delete(&model.AIAgent{}, rec.ID).Error; err != nil {
		logger.Error("用户 %s 删除智能体 %s 失败: %v", username, rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "删除智能体失败")
		return
	}
	// 阶段五十八：级联清理该智能体的长期记忆（MySQL 行 + 向量集合）
	memDestroyAgent(rec.ID)
	// 阶段一百零四：级联清理该智能体的规则（全局规则不受影响）
	ruleDestroyAgent(rec.ID)
	logger.Info("用户端：用户 %s 删除个人智能体 %s（id=%d，历史消息保留）", username, rec.Name, rec.ID)
	s.aiChangeApply("用户端：用户 " + username + " 删除个人智能体 " + rec.Name)
	adminJSON(w, map[string]interface{}{"deleted": true})
}
