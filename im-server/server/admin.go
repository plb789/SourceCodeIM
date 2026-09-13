package server

// ===== 阶段四十九：后台管理模块 =====
// 设计归口：
//   1. 管理后台复用 IM 账号体系（im_user 表），仅 role=1（管理员）或 config.yaml admin_users
//      白名单内的账号可登录；登录成功签发 Redis 会话 Token（2 小时 TTL，滑动续期）
//   2. AI 模型服务（im_ai_provider）与智能体（im_ai_agent）的增删改查接口；
//      每次变更成功后调用 reloadAIAgents() 重建运行时索引（写锁原子替换），
//      并向全部在线客户端广播 AI_AGENTS 列表刷新（前端零改动热生效，无需重启）
//   3. 登录防爆破：单 IP 10 分钟内最多失败 5 次（Redis 计数）
//   4. 所有响应均为 JSON：{"ok":true,"data":...} / {"ok":false,"msg":"..."}

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"context"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 管理会话 Token 存储键前缀与有效期
const (
	adminTokenKey = "im:admin:token:"
	adminTokenTTL = 2 * time.Hour
	// 登录防爆破：单 IP 失败计数键前缀 / 窗口 / 上限
	adminFailKey    = "im:admin:loginfail:"
	adminFailWindow = 10 * time.Minute
	adminFailMax    = 5
)

// MarkAdminUsers 阶段四十九：启动时按 config.yaml admin_users 白名单将对应账号标记为管理员角色
// 白名单中的账号若尚未注册则忽略（IM 首次登录自动注册后，下次启动自动补标记；
// 管理登录同时实时比对白名单，不受标记时序影响）
func MarkAdminUsers(cfg *config.Config) {
	if len(cfg.AdminUsers) == 0 {
		return
	}
	// 清理空白与重复项
	names := make([]string, 0, len(cfg.AdminUsers))
	seen := make(map[string]bool)
	for _, n := range cfg.AdminUsers {
		n = strings.TrimSpace(n)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		names = append(names, n)
	}
	if len(names) == 0 {
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username IN ?", names).Update("role", 1).Error; err != nil {
		logger.Error("管理员角色标记失败: %v", err)
		return
	}
	logger.Info("管理员角色标记完成：白名单 %d 个账号（未注册的账号将在注册后的下次启动补标记）", len(names))
}

// RegisterAdminRoutes 注册后台管理路由（Go 1.22+ 方法+路径模式，main.go 调用归口）
func RegisterAdminRoutes(s *Server) {
	http.HandleFunc("POST /admin/api/login", s.handleAdminLogin)
	http.HandleFunc("POST /admin/api/logout", s.adminGuard(s.handleAdminLogout))
	// 阶段五十：性能仪表盘指标
	http.HandleFunc("GET /admin/api/metrics", s.adminGuard(s.handleAdminMetrics))
	// AI 模型服务管理
	http.HandleFunc("GET /admin/api/ai/providers", s.adminGuard(s.handleAdminProviderList))
	http.HandleFunc("POST /admin/api/ai/providers", s.adminGuard(s.handleAdminProviderCreate))
	http.HandleFunc("PUT /admin/api/ai/providers/{id}", s.adminGuard(s.handleAdminProviderUpdate))
	http.HandleFunc("DELETE /admin/api/ai/providers/{id}", s.adminGuard(s.handleAdminProviderDelete))
	// AI 智能体管理
	http.HandleFunc("GET /admin/api/ai/agents", s.adminGuard(s.handleAdminAgentList))
	http.HandleFunc("POST /admin/api/ai/agents", s.adminGuard(s.handleAdminAgentCreate))
	http.HandleFunc("PUT /admin/api/ai/agents/{id}", s.adminGuard(s.handleAdminAgentUpdate))
	http.HandleFunc("DELETE /admin/api/ai/agents/{id}", s.adminGuard(s.handleAdminAgentDelete))
	// 阶段八十八：MCP 服务器管理（TRAE CN 同款 MCP 能力，服务端归口；配置热更新即建连/断连）
	http.HandleFunc("GET /admin/api/mcp/servers", s.adminGuard(s.handleAdminMCPList))
	http.HandleFunc("POST /admin/api/mcp/servers", s.adminGuard(s.handleAdminMCPCreate))
	http.HandleFunc("PUT /admin/api/mcp/servers/{id}", s.adminGuard(s.handleAdminMCPUpdate))
	http.HandleFunc("DELETE /admin/api/mcp/servers/{id}", s.adminGuard(s.handleAdminMCPDelete))
	http.HandleFunc("POST /admin/api/mcp/servers/{id}/reconnect", s.adminGuard(s.handleAdminMCPReconnect))
	http.HandleFunc("POST /admin/api/mcp/test", s.adminGuard(s.handleAdminMCPTest))
	// 阶段五十一：知识库管理（库 CRUD/文件上传删除/命中测试，实现归口 adminkb.go）
	http.HandleFunc("GET /admin/api/kb/status", s.adminGuard(s.handleAdminKBStatus))
	http.HandleFunc("GET /admin/api/kb/list", s.adminGuard(s.handleAdminKBList))
	http.HandleFunc("POST /admin/api/kb", s.adminGuard(s.handleAdminKBCreate))
	http.HandleFunc("PUT /admin/api/kb/{id}", s.adminGuard(s.handleAdminKBUpdate))
	http.HandleFunc("DELETE /admin/api/kb/{id}", s.adminGuard(s.handleAdminKBDelete))
	http.HandleFunc("GET /admin/api/kb/{id}/files", s.adminGuard(s.handleAdminKBFileList))
	http.HandleFunc("POST /admin/api/kb/{id}/files", s.adminGuard(s.handleAdminKBFileUpload))
	http.HandleFunc("DELETE /admin/api/kb/file/{id}", s.adminGuard(s.handleAdminKBFileDelete))
	http.HandleFunc("POST /admin/api/kb/search", s.adminGuard(s.handleAdminKBSearch))
	// 阶段五十二：文本直贴建知识 / 切片详情 / 单文件与整库重新向量化
	http.HandleFunc("POST /admin/api/kb/{id}/text", s.adminGuard(s.handleAdminKBFileText))
	http.HandleFunc("GET /admin/api/kb/file/{id}/chunks", s.adminGuard(s.handleAdminKBFileChunks))
	http.HandleFunc("POST /admin/api/kb/file/{id}/rebuild", s.adminGuard(s.handleAdminKBFileRebuild))
	http.HandleFunc("POST /admin/api/kb/{id}/rebuild", s.adminGuard(s.handleAdminKBRebuild))
	// 阶段五十三：知识库数据微调（检索调试/切片编辑删除/源文编辑重建）
	http.HandleFunc("POST /admin/api/kb/{id}/debug", s.adminGuard(s.handleAdminKBDebug))
	http.HandleFunc("PUT /admin/api/kb/file/{id}/chunk/{cid}", s.adminGuard(s.handleAdminKBChunkEdit))
	http.HandleFunc("DELETE /admin/api/kb/file/{id}/chunk/{cid}", s.adminGuard(s.handleAdminKBChunkDelete))
	http.HandleFunc("GET /admin/api/kb/file/{id}/source", s.adminGuard(s.handleAdminKBFileSourceGet))
	http.HandleFunc("PUT /admin/api/kb/file/{id}/source", s.adminGuard(s.handleAdminKBFileSourcePut))
	// 阶段五十四：量化数据管理（跨库切片聚合表格化展示/搜索/分页，实现归口 adminkb.go）
	http.HandleFunc("GET /admin/api/kb/chunks", s.adminGuard(s.handleAdminKBVecChunks))
	// 阶段六十四：Agent 任务审计（全量任务分页列表 + 单任务详情，实现归口 agentrun.go）
	http.HandleFunc("GET /admin/api/agent/tasks", s.adminGuard(s.HandleAdminAgentTaskList))
	http.HandleFunc("GET /admin/api/agent/task/{task_id}", s.adminGuard(s.HandleAdminAgentTaskDetail))
	// 阶段六十五：Agent 任务执行轨迹审计（单任务全量步骤留痕）
	http.HandleFunc("GET /admin/api/agent/task/{task_id}/steps", s.adminGuard(s.HandleAdminAgentTaskSteps))
	// 阶段八十一：Agent 运行参数设置（max_steps 后台热更新，保存即生效+落库重启不丢）
	http.HandleFunc("GET /admin/api/agent/settings", s.adminGuard(s.handleAdminAgentSettingsGet))
	http.HandleFunc("PUT /admin/api/agent/settings", s.adminGuard(s.handleAdminAgentSettingsSave))

	// 阶段七十八：用户积分管理（用户列表含积分余额；调整积分为绝对值设置，AI 问答扣分归口在 aipoints.go）
	http.HandleFunc("GET /admin/api/users", s.adminGuard(s.handleAdminUserList))
	http.HandleFunc("PUT /admin/api/users/{username}/points", s.adminGuard(s.handleAdminUserPointsPut))
	// 阶段七十八：积分流水审计查询（AI 扣分/管理员调整/注册赠送全量记录，服务端分页）
	http.HandleFunc("GET /admin/api/points/logs", s.adminGuard(s.handleAdminPointsLogs))
	// 阶段七十八：流水 CSV 导出（服务端流式生成，支持与查询一致的过滤条件）
	http.HandleFunc("GET /admin/api/points/logs/export", s.adminGuard(s.handleAdminPointsLogsExport))
}

// ===== Agent 运行参数设置（阶段八十一/八十二：后台热更新） =====

// agentSettingPut PUT /admin/api/agent/settings 请求体（指针字段=nil=不修改，部分更新）
type agentSettingPut struct {
	MaxSteps       *int     `json:"max_steps"`
	ToolTimeout    *int     `json:"tool_timeout"`
	ApproveTimeout *int     `json:"approve_timeout"`
	Concurrency    *int     `json:"concurrency"`
	QueueSize      *int     `json:"queue_size"`
	Enabled        *bool    `json:"enabled"`
	PcExecutor     *bool    `json:"pc_executor"`
	AutoWrite      *bool    `json:"auto_write"`
	AutoCommands   []string `json:"auto_commands"` // nil=不改；非 nil=全量替换全局白名单（DB 即唯一真值，不影响用户个人白名单）
	HttpEnabled    *bool    `json:"http_enabled"`
	HttpPrivate    *bool    `json:"http_allow_private"`
	BrowserEnabled *bool    `json:"browser_enabled"` // 阶段九十一：内置浏览器工具开关
	SearchEnabled  *bool    `json:"search_enabled"`
	SearchProvider *string  `json:"search_provider"`
	SearchKey      *string  `json:"search_key"` // ""=清除；字段缺省=保持不变
	SearchEndpoint *string  `json:"search_endpoint"`
	// 阶段八十三：个人白名单管理（审批弹窗"同意并加白"按用户隔离，后台可查看/收回）
	UserCmdRemove    *agentUserCmdRemove `json:"user_cmd_remove"`    // 非 nil=移除该用户的一条个人命令白名单
	UserAutoWriteOff *string             `json:"user_autowrite_off"` // 非 nil=收回该用户的个人写文件免审批
}

// agentUserCmdRemove 移除用户个人命令白名单条目（阶段八十三）
type agentUserCmdRemove struct {
	Username string `json:"username"`
	Command  string `json:"command"`
}

// agentSettingRowUpsert kind 行 upsert 归口（存在改值，不存在建行）。
// 阶段八十三：限定 username=” 全局行——个人白名单行不受后台参数保存影响
func agentSettingRowUpsert(kind, value string) {
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", kind, "").First(&row).Error; err == nil {
		store.DB.Model(&row).Update("value", value)
	} else {
		store.DB.Create(&model.AgentWhitelist{Kind: kind, Value: value})
	}
}

// agentSettingsPayload 当前生效参数快照（GET 响应与保存后回执共用归口；搜索密钥脱敏只回提示不回明文）。
// 阶段八十三：附带用户个人白名单视图（后台管理员查看/收回全体用户的审批加白）
func agentSettingsPayload() map[string]interface{} {
	agentWlMu.RLock()
	autowrite := agentAutoWrite
	cmds := make([]string, len(agentAutoCmds))
	copy(cmds, agentAutoCmds)
	userCmds := make(map[string][]string, len(agentUserCmds))
	for u, list := range agentUserCmds {
		cp := make([]string, len(list))
		copy(cp, list)
		userCmds[u] = cp
	}
	userWrite := make([]string, 0, len(agentUserWrite))
	for u, on := range agentUserWrite {
		if on {
			userWrite = append(userWrite, u)
		}
	}
	sort.Strings(userWrite)
	agentWlMu.RUnlock()
	scfg := agentSearchConfig()
	keyHint := ""
	if scfg.APIKey != "" {
		key := scfg.APIKey
		if len(key) > 4 {
			key = key[len(key)-4:]
		}
		keyHint = "已配置（尾4位 " + key + "）"
	}
	return map[string]interface{}{
		"max_steps":          agentMaxSteps.Load(),
		"tool_timeout":       agentToolTimeout.Load(),
		"approve_timeout":    agentApproveWait.Load(),
		"concurrency":        agentConcurrency.Load(),
		"queue_size":         agentQueueSize.Load(),
		"enabled":            agentEnabled.Load(),
		"pc_executor":        agentPcExec.Load(),
		"auto_write":         autowrite,
		"auto_commands":      cmds,
		"user_commands":      userCmds,  // 阶段八十三：用户个人命令白名单（map[username][]前缀）
		"user_autowrite":     userWrite, // 阶段八十三：已开启个人写免审批的用户名列表
		"http_enabled":       agentHttpEnabled.Load(),
		"http_allow_private": agentHttpAllowPrivate.Load(),
		"browser_enabled":    agentBrowserEnabled.Load(), // 阶段九十一：内置浏览器工具开关
		"search_enabled":     agentSearchEnabled.Load(),
		"search_provider":    scfg.Provider,
		"search_key_set":     scfg.APIKey != "",
		"search_key_hint":    keyHint,
		"search_endpoint":    scfg.Endpoint,
	}
}

// handleAdminAgentSettingsGet 返回当前生效的 Agent 运行参数（内存值为准，含后台热改未重启的部分）
func (s *Server) handleAdminAgentSettingsGet(w http.ResponseWriter, r *http.Request) {
	adminJSON(w, agentSettingsPayload())
}

// handleAdminAgentSettingsSave 保存 Agent 运行参数（部分更新：字段缺省=不改）：
// 内存原子写入立即热生效（运行中任务下一步即按新值判定），落库 im_agent_whitelist（启动加载，重启不丢）。
// 刻意不回写 config.yaml（注释会丢）：yaml 值仅作 DB 无记录时的初始默认
func (s *Server) handleAdminAgentSettingsSave(w http.ResponseWriter, r *http.Request) {
	var req agentSettingPut
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	applyInt := func(p *int, lo, hi int, kind, name string) bool {
		if p == nil {
			return true
		}
		if *p < lo || *p > hi {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("%s 取值范围 %d~%d", name, lo, hi))
			return false
		}
		switch kind {
		case "maxsteps":
			agentMaxSteps.Store(int64(*p))
		case "tool_timeout":
			agentToolTimeout.Store(int64(*p))
		case "approve_timeout":
			agentApproveWait.Store(int64(*p))
		case "concurrency":
			agentConcurrency.Store(int64(*p))
		case "queue_size":
			agentQueueSize.Store(int64(*p))
		}
		agentSettingRowUpsert(kind, strconv.Itoa(*p))
		return true
	}
	applyBool := func(p *bool, kind string, apply func(bool)) bool {
		if p == nil {
			return true
		}
		apply(*p)
		v := "0"
		if *p {
			v = "1"
		}
		agentSettingRowUpsert(kind, v)
		return true
	}
	if !applyInt(req.MaxSteps, agentStepsMin, agentStepsMax, "maxsteps", "最大迭代步数") ||
		!applyInt(req.ToolTimeout, agentToolTMin, agentCmdTimeoutMax, "tool_timeout", "命令超时秒") ||
		!applyInt(req.ApproveTimeout, agentApproveMin, agentApproveMax, "approve_timeout", "审批等待秒") ||
		!applyInt(req.Concurrency, agentConcMin, agentConcMax, "concurrency", "并发上限") ||
		!applyInt(req.QueueSize, agentQueueMin, agentQueueMax, "queue_size", "排队上限") {
		return
	}
	if !applyBool(req.Enabled, "enabled", agentEnabled.Store) ||
		!applyBool(req.PcExecutor, "pcexec", agentPcExec.Store) ||
		!applyBool(req.HttpEnabled, "http_enabled", agentHttpEnabled.Store) ||
		!applyBool(req.HttpPrivate, "http_private", agentHttpAllowPrivate.Store) ||
		!applyBool(req.BrowserEnabled, "browser_enabled", agentBrowserEnabled.Store) ||
		!applyBool(req.SearchEnabled, "search_enabled", agentSearchEnabled.Store) {
		return
	}
	// 写文件免审批：与审批弹窗"同意并加白"共用 agentWlMu 保护（内存翻转 + DB upsert）
	if req.AutoWrite != nil {
		agentWlMu.Lock()
		agentAutoWrite = *req.AutoWrite
		agentWlMu.Unlock()
		v := "0"
		if *req.AutoWrite {
			v = "1"
		}
		agentSettingRowUpsert("autowrite", v)
	}
	// 命令白名单全量替换（清洗：小写/去空/去重/限长限数；同步保证 cmdinit 标记存在）。
	// 阶段八十三：仅替换全局行（username=''），用户个人白名单不受影响
	if req.AutoCommands != nil {
		seen := map[string]bool{}
		cmds := make([]string, 0, len(req.AutoCommands))
		for _, raw := range req.AutoCommands {
			v := strings.ToLower(strings.TrimSpace(raw))
			if v == "" || len(v) > 64 || seen[v] {
				continue
			}
			seen[v] = true
			cmds = append(cmds, v)
			if len(cmds) >= 64 {
				break
			}
		}
		agentWlMu.Lock()
		agentAutoCmds = cmds
		agentWlMu.Unlock()
		store.DB.Where("kind = ? AND username = ?", "cmd", "").Delete(&model.AgentWhitelist{})
		for _, v := range cmds {
			store.DB.Create(&model.AgentWhitelist{Kind: "cmd", Value: v})
		}
		agentSettingRowUpsert("cmdinit", "1")
	}
	// 阶段八十三：个人白名单管理——移除用户个人命令白名单条目 / 收回个人写免审批（内存+DB 同步）
	if req.UserCmdRemove != nil {
		u := strings.TrimSpace(req.UserCmdRemove.Username)
		c := strings.ToLower(strings.TrimSpace(req.UserCmdRemove.Command))
		if u == "" || c == "" || len(c) > 64 {
			adminFail(w, http.StatusBadRequest, "移除个人白名单：username 与 command 必填")
			return
		}
		agentWlMu.Lock()
		list := agentUserCmds[u]
		out := make([]string, 0, len(list))
		for _, p := range list {
			if p != c {
				out = append(out, p)
			}
		}
		if len(out) != len(list) {
			if len(out) == 0 {
				delete(agentUserCmds, u)
			} else {
				agentUserCmds[u] = out
			}
		}
		agentWlMu.Unlock()
		store.DB.Where("kind = ? AND username = ? AND value = ?", "cmd", u, c).
			Delete(&model.AgentWhitelist{})
		logger.Info("后台移除个人命令白名单：用户 %s，前缀 %s", u, c)
	}
	if req.UserAutoWriteOff != nil {
		u := strings.TrimSpace(*req.UserAutoWriteOff)
		if u == "" {
			adminFail(w, http.StatusBadRequest, "收回个人写免审批：username 必填")
			return
		}
		agentWlMu.Lock()
		delete(agentUserWrite, u)
		agentWlMu.Unlock()
		store.DB.Where("kind = ? AND username = ?", "autowrite", u).Delete(&model.AgentWhitelist{})
		logger.Info("后台收回个人写文件免审批：用户 %s", u)
	}
	// web_search 服务商配置（三元组整体快照替换；密钥传空串=清除）
	if req.SearchProvider != nil || req.SearchKey != nil || req.SearchEndpoint != nil {
		scfg := agentSearchConfig()
		provider, key, endpoint := scfg.Provider, scfg.APIKey, scfg.Endpoint
		if req.SearchProvider != nil {
			provider = strings.ToLower(strings.TrimSpace(*req.SearchProvider))
			switch provider {
			case "", "tavily", "bocha", "searxng", "duckduckgo":
			default:
				adminFail(w, http.StatusBadRequest, "搜索服务商仅支持 tavily/bocha/searxng/duckduckgo")
				return
			}
		}
		if req.SearchKey != nil {
			key = strings.TrimSpace(*req.SearchKey)
		}
		if req.SearchEndpoint != nil {
			endpoint = strings.TrimSpace(*req.SearchEndpoint)
		}
		agentSearchConfigStore(provider, key, endpoint)
		if req.SearchProvider != nil {
			agentSettingRowUpsert("search_provider", provider)
		}
		if req.SearchKey != nil {
			agentSettingRowUpsert("search_key", key)
		}
		if req.SearchEndpoint != nil {
			agentSettingRowUpsert("search_endpoint", endpoint)
		}
	}
	logger.Info("后台管理：Agent 运行参数已更新（热生效）")
	adminJSON(w, agentSettingsPayload())
}

// ===== 通用归口 =====

// adminJSON 管理接口成功响应归口
func adminJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	resp := map[string]interface{}{"ok": true, "data": data}
	_ = json.NewEncoder(w).Encode(resp)
}

// adminFail 管理接口失败响应归口（httpStatus 用于区分 401 未登录 / 400 业务错误 / 409 冲突等）
func adminFail(w http.ResponseWriter, httpStatus int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	resp := map[string]interface{}{"ok": false, "msg": msg}
	_ = json.NewEncoder(w).Encode(resp)
}

// adminGuard 管理接口鉴权中间件：校验 Authorization: Bearer <token>（Redis 会话，滑动续期）
func (s *Server) adminGuard(next http.HandlerFunc) http.HandlerFunc {
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
		key := adminTokenKey + token
		username, err := store.RDB.Get(ctx, key).Result()
		if err != nil || username == "" {
			adminFail(w, http.StatusUnauthorized, "登录已过期，请重新登录")
			return
		}
		// 滑动续期：活跃会话自动延长
		store.RDB.Expire(ctx, key, adminTokenTTL)
		// 阶段五十一：实时复核管理员身份（role=1 或白名单，与登录校验同口径）
		// 原实现：仅校验 Redis 会话存在，管理员被移除后已签发会话仍可继续操作至 TTL 过期
		var u model.User
		if err := store.DB.Select("username", "role").Where("username = ?", username).First(&u).Error; err != nil {
			adminFail(w, http.StatusUnauthorized, "登录已过期，请重新登录")
			return
		}
		if u.Role != 1 && !s.isAdminWhitelisted(u.Username) {
			// 已无管理员权限：立即吊销会话
			store.RDB.Del(ctx, key)
			adminFail(w, http.StatusForbidden, "账号已无后台管理权限")
			return
		}
		// 阶段七十八：注入管理员身份到上下文（积分调整等写操作的流水审计需记录操作人）
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKeyAdminUser{}, u.Username)))
	}
}

// ctxKeyAdminUser 管理员身份上下文键（私有类型防碰撞）
type ctxKeyAdminUser struct{}

// adminUserFromCtx 读取当前登录管理员用户名（未注入时返回空串）
func adminUserFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyAdminUser{}).(string); ok {
		return v
	}
	return ""
}

// adminClientIP 提取客户端 IP（防爆破计数维度；反代场景取 X-Forwarded-For 首段）
func adminClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// ===== 登录 / 登出 =====

// handleAdminLogin 管理员登录：复用 IM 账号密码（SHA256），仅管理员角色或白名单账号放行
func (s *Server) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Username = strings.TrimSpace(req.Username)

	// 防爆破：单 IP 窗口内失败超限直接拒绝
	ctx := context.Background()
	ip := adminClientIP(r)
	failKey := adminFailKey + ip
	if count, _ := store.RDB.Get(ctx, failKey).Int(); count >= adminFailMax {
		adminFail(w, http.StatusTooManyRequests, "登录失败次数过多，请 10 分钟后再试")
		return
	}

	// 复用 IM 登录校验（用户不存在/密码错误与聊天端同口径）
	user, err := verifyUser(req.Username, req.Password)
	if err != nil {
		store.RDB.Incr(ctx, failKey)
		store.RDB.Expire(ctx, failKey, adminFailWindow)
		logger.Warn("后台管理登录失败（IP %s，账号 %s）：%v", ip, req.Username, err)
		adminFail(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	// 管理员身份校验：role=1 或 config.yaml admin_users 白名单（双通道，兼容注册后未重启未标记的场景）
	if user.Role != 1 && !s.isAdminWhitelisted(user.Username) {
		adminFail(w, http.StatusForbidden, "该账号无后台管理权限")
		return
	}

	// 签发会话 Token（32 字节随机数 hex，Redis 记录归属账号）
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		adminFail(w, http.StatusInternalServerError, "会话签发失败，请重试")
		return
	}
	token := hex.EncodeToString(b)
	store.RDB.Set(ctx, adminTokenKey+token, user.Username, adminTokenTTL)

	// 登录成功清除失败计数
	store.RDB.Del(ctx, failKey)
	logger.Info("管理员 %s 登录后台（IP %s）", user.Username, ip)
	adminJSON(w, map[string]interface{}{
		"token":    token,
		"username": user.Username,
		"nickname": user.Nickname,
	})
}

// isAdminWhitelisted 实时比对 config.yaml admin_users 白名单
func (s *Server) isAdminWhitelisted(username string) bool {
	for _, n := range s.cfg.AdminUsers {
		if strings.TrimSpace(n) == username {
			return true
		}
	}
	return false
}

// handleAdminLogout 管理员登出：销毁会话 Token
func (s *Server) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token != "" {
		store.RDB.Del(context.Background(), adminTokenKey+strings.TrimSpace(token))
	}
	adminJSON(w, map[string]interface{}{"logout": true})
}

// ===== AI 模型服务管理（im_ai_provider） =====

// adminProviderDTO 管理端模型服务响应体：显式包含 api_key——模型字段带 json:"-"（普通聊天链路
// 永不下发密钥），管理接口经登录鉴权后经本 DTO 归口输出，供管理界面编辑回显
type adminProviderDTO struct {
	ID            uint   `json:"id"`
	Name          string `json:"name"`
	APIURL        string `json:"api_url"`
	APIKey        string `json:"api_key"`
	Model         string `json:"model"`
	VisionModel   string `json:"vision_model"`
	SupportsImage bool   `json:"supports_image"`
	Enabled       bool   `json:"enabled"`
}

// adminProviderReq 管理端模型服务请求体：模型 APIKey 字段带 json:"-"（普通聊天链路不下发），
// 直接解码进模型会丢弃请求里的 api_key，故经本 DTO 归口接收后再映射回模型
type adminProviderReq struct {
	Name          string `json:"name"`
	APIURL        string `json:"api_url"`
	APIKey        string `json:"api_key"`
	Model         string `json:"model"`
	VisionModel   string `json:"vision_model"`
	SupportsImage bool   `json:"supports_image"`
	Enabled       bool   `json:"enabled"`
}

// adminProviderView 模型记录 → 管理 DTO 归口转换
func adminProviderView(p model.AIProvider) adminProviderDTO {
	return adminProviderDTO{
		ID:            p.ID,
		Name:          p.Name,
		APIURL:        p.APIURL,
		APIKey:        p.APIKey,
		Model:         p.Model,
		VisionModel:   p.VisionModel,
		SupportsImage: p.SupportsImage,
		Enabled:       p.Enabled,
	}
}

// handleAdminProviderList 模型服务列表（含 api_key：管理界面编辑需要，仅管理鉴权后可读）
func (s *Server) handleAdminProviderList(w http.ResponseWriter, r *http.Request) {
	var list []model.AIProvider
	if err := store.DB.Order("id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询模型服务失败")
		return
	}
	views := make([]adminProviderDTO, 0, len(list))
	for _, p := range list {
		views = append(views, adminProviderView(p))
	}
	adminJSON(w, views)
}

// handleAdminProviderCreate 新增模型服务
func (s *Server) handleAdminProviderCreate(w http.ResponseWriter, r *http.Request) {
	var req adminProviderReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || strings.TrimSpace(req.APIURL) == "" || strings.TrimSpace(req.Model) == "" {
		adminFail(w, http.StatusBadRequest, "名称、接口地址、模型名均不能为空")
		return
	}
	var count int64
	store.DB.Model(&model.AIProvider{}).Where("name = ?", req.Name).Count(&count)
	if count > 0 {
		adminFail(w, http.StatusConflict, "模型服务名称已存在："+req.Name)
		return
	}
	p := model.AIProvider{
		Name:          req.Name,
		APIURL:        strings.TrimSpace(req.APIURL),
		APIKey:        strings.TrimSpace(req.APIKey),
		Model:         strings.TrimSpace(req.Model),
		VisionModel:   strings.TrimSpace(req.VisionModel),
		SupportsImage: req.SupportsImage,
		Enabled:       req.Enabled,
	}
	if err := store.DB.Create(&p).Error; err != nil {
		logger.Error("新增模型服务 %s 失败: %v", p.Name, err)
		adminFail(w, http.StatusInternalServerError, "新增模型服务失败")
		return
	}
	s.adminAfterAIChange(fmt.Sprintf("新增模型服务 %s", p.Name))
	adminJSON(w, adminProviderView(p))
}

// handleAdminProviderUpdate 更新模型服务（按路径参数 id）
func (s *Server) handleAdminProviderUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var req adminProviderReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || strings.TrimSpace(req.APIURL) == "" || strings.TrimSpace(req.Model) == "" {
		adminFail(w, http.StatusBadRequest, "名称、接口地址、模型名均不能为空")
		return
	}
	// 名称唯一性校验（排除自身）
	var dup model.AIProvider
	if err := store.DB.Where("name = ? AND id <> ?", req.Name, id).First(&dup).Error; err == nil {
		adminFail(w, http.StatusConflict, "模型服务名称已存在："+req.Name)
		return
	}
	result := store.DB.Model(&model.AIProvider{}).Where("id = ?", id).Updates(map[string]interface{}{
		"name":           req.Name,
		"api_url":        strings.TrimSpace(req.APIURL),
		"api_key":        strings.TrimSpace(req.APIKey),
		"model":          strings.TrimSpace(req.Model),
		"vision_model":   strings.TrimSpace(req.VisionModel),
		"supports_image": req.SupportsImage,
		"enabled":        req.Enabled,
	})
	if result.Error != nil {
		logger.Error("更新模型服务失败（id=%d）: %v", id, result.Error)
		adminFail(w, http.StatusInternalServerError, "更新模型服务失败")
		return
	}
	if result.RowsAffected == 0 {
		adminFail(w, http.StatusNotFound, "模型服务不存在或内容未变化")
		return
	}
	s.adminAfterAIChange(fmt.Sprintf("更新模型服务 %s", req.Name))
	adminJSON(w, map[string]interface{}{"id": id})
}

// handleAdminProviderDelete 删除模型服务（被智能体绑定时拒绝，防止误删导致静默降级 Mock）
func (s *Server) handleAdminProviderDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var p model.AIProvider
	if err := store.DB.First(&p, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "模型服务不存在")
		return
	}
	var bindCount int64
	store.DB.Model(&model.AIAgent{}).Where("provider = ?", p.Name).Count(&bindCount)
	if bindCount > 0 {
		adminFail(w, http.StatusConflict, fmt.Sprintf("该模型服务被 %d 个智能体绑定，请先解除绑定后再删除", bindCount))
		return
	}
	if err := store.DB.Delete(&model.AIProvider{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除模型服务失败")
		return
	}
	s.adminAfterAIChange(fmt.Sprintf("删除模型服务 %s", p.Name))
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// ===== AI 智能体管理（im_ai_agent） =====

// handleAdminAgentList 智能体列表（含停用项，管理界面区分展示）
func (s *Server) handleAdminAgentList(w http.ResponseWriter, r *http.Request) {
	var list []model.AIAgent
	if err := store.DB.Order("sort_id ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询智能体失败")
		return
	}
	adminJSON(w, list)
}

// handleAdminAgentCreate 新增智能体
func (s *Server) handleAdminAgentCreate(w http.ResponseWriter, r *http.Request) {
	var a model.AIAgent
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	a.Name = strings.TrimSpace(a.Name)
	if a.Name == "" {
		adminFail(w, http.StatusBadRequest, "智能体名称不能为空")
		return
	}
	// 阶段五十七：管理端创建的智能体一律为公共智能体（Scope/Owner 强制归口，防请求体误传）
	a.Scope = "public"
	a.Owner = ""
	var count int64
	store.DB.Model(&model.AIAgent{}).Where("name = ?", a.Name).Count(&count)
	if count > 0 {
		adminFail(w, http.StatusConflict, "智能体名称已存在："+a.Name)
		return
	}
	if err := store.DB.Create(&a).Error; err != nil {
		logger.Error("新增智能体 %s 失败: %v", a.Name, err)
		adminFail(w, http.StatusInternalServerError, "新增智能体失败")
		return
	}
	s.adminAfterAIChange(fmt.Sprintf("新增智能体 %s", a.Name))
	adminJSON(w, a)
}

// handleAdminAgentUpdate 更新智能体（按路径参数 id）
func (s *Server) handleAdminAgentUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var a model.AIAgent
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	a.Name = strings.TrimSpace(a.Name)
	if a.Name == "" {
		adminFail(w, http.StatusBadRequest, "智能体名称不能为空")
		return
	}
	// 名称唯一性校验（排除自身）
	var dup model.AIAgent
	if err := store.DB.Where("name = ? AND id <> ?", a.Name, id).First(&dup).Error; err == nil {
		adminFail(w, http.StatusConflict, "智能体名称已存在："+a.Name)
		return
	}
	result := store.DB.Model(&model.AIAgent{}).Where("id = ?", id).Updates(map[string]interface{}{
		"name":          a.Name,
		"provider":      strings.TrimSpace(a.Provider),
		"system_prompt": a.SystemPrompt,
		"avatar":        strings.TrimSpace(a.Avatar),
		"enabled":       a.Enabled,
		"sort_id":       a.SortID,
		"kb_ids":        strings.TrimSpace(a.KBIDs), // 阶段五十一：绑定知识库（RAG 检索注入归口）
	})
	if result.Error != nil {
		logger.Error("更新智能体失败（id=%d）: %v", id, result.Error)
		adminFail(w, http.StatusInternalServerError, "更新智能体失败")
		return
	}
	if result.RowsAffected == 0 {
		adminFail(w, http.StatusNotFound, "智能体不存在或内容未变化")
		return
	}
	s.adminAfterAIChange(fmt.Sprintf("更新智能体 %s", a.Name))
	adminJSON(w, map[string]interface{}{"id": id})
}

// handleAdminAgentDelete 删除智能体
func (s *Server) handleAdminAgentDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var a model.AIAgent
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "智能体不存在")
		return
	}
	if err := store.DB.Delete(&model.AIAgent{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除智能体失败")
		return
	}
	// 阶段五十八：级联清理该智能体的长期记忆（MySQL 行 + 向量集合）
	memDestroyAgent(id)
	// 阶段一百零四：级联清理该智能体的规则（全局规则不受影响）
	ruleDestroyAgent(id)
	s.adminAfterAIChange(fmt.Sprintf("删除智能体 %s", a.Name))
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// ===== 变更后置归口 =====

// adminAfterAIChange 阶段四十九：AI 配置变更后置归口——重建运行时索引（写锁原子替换）
// 并向全部在线客户端广播 AI_AGENTS 列表刷新（前端 IMSocket.on(AI_AGENTS) 收到即重渲染，
// 无需重启服务端，无需客户端手动刷新）
// 阶段五十七：广播改为逐用户视角（公共智能体 + 该用户自建的个人智能体），用户侧自建智能体变更复用同一归口 aiChangeApply
func (s *Server) adminAfterAIChange(action string) {
	s.aiChangeApply(action)
	logger.Info("后台管理：%s，已热更新生效并广播在线客户端", action)
}

// aiChangeApply 阶段五十七：AI 配置变更应用归口（管理端与用户端共用）——
// 重建运行时索引 + 按用户视角广播 AI_AGENTS 刷新（每用户内容=公共智能体+其个人智能体）
func (s *Server) aiChangeApply(action string) {
	reloadAIAgents()
	s.hub.BroadcastUser(func(username string) []byte {
		msg := protocol.Message{
			MsgType:   protocol.MsgTypeAIAgents,
			Content:   string(mustJSON(aiAgentsPublicInfo(username))),
			Timestamp: time.Now().Unix(),
		}
		return mustJSON(msg)
	})
}

// mustJSON 序列化（失败返回空对象串，广播场景不允许中断主流程）
func mustJSON(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return data
}

// adminPathID 解析路径参数 {id}（Go 1.22+ r.PathValue），非法时直接写错误响应
func adminPathID(w http.ResponseWriter, r *http.Request) (uint, bool) {
	raw := r.PathValue("id")
	var id uint
	if _, err := fmt.Sscanf(raw, "%d", &id); err != nil || id == 0 {
		adminFail(w, http.StatusBadRequest, "路径参数 id 非法")
		return 0, false
	}
	return id, true
}

// adminQueryUint 解析 URL 查询参数为非负整数（非法或负值返回 0，由调用方决定缺省语义）
func adminQueryUint(raw string) uint {
	var id uint
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &id); err != nil {
		return 0
	}
	return id
}
