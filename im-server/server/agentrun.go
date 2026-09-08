package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段五十九：智能 Agent 自动化任务（工具调用闭环 + 权限审批）
// 运行逻辑：发起任务 → 模型决策（thought）→ 选择工具 → 风险分级（白名单自动放行 / 高危推送审批）
// → 执行工具回传结果 → 循环迭代 → 无工具调用时输出最终答复（done）。
// 每步事件实时推送给发起用户（思考过程 / 工具执行 / 审批请求 / 任务清单 / 进度）。

// 体积与次数上限（防超长输出撑爆模型上下文 / 防滥用）
const (
	agentReadMaxChars   = 50000         // read_file 单次返回字符上限
	agentWriteMaxChars  = 200000        // write_file 单次写入字符上限
	agentCmdOutMaxChars = 8000          // run_command 输出字符上限
	agentCmdTimeoutMax  = 300           // run_command 超时秒上限
	agentTodoMaxItems   = 50            // 任务清单条数上限
	agentTaskIdleClean  = 2 * time.Hour // 结束任务在内存注册表中的保留时长（防泄漏）
)

// 运行时配置（InitAgent 从 config.yaml ai.agent 节点加载，均有兜底默认值）
var (
	agentEnabled     = false
	agentMaxSteps    = 30
	agentToolTimeout = 60 * time.Second
	agentApproveWait = 300 * time.Second
	agentAutoWrite   = false
	agentAutoCmds    []string
	agentWorkRoot    = ""
	agentPcExec      = false // 阶段六十：本地执行器开关（true 时 PC 端在线则文件/命令下放用户本地执行）
	agentConcurrency = 1     // 阶段六十七：每用户同时运行任务数上限
	agentQueueSize   = 5     // 阶段六十七：每用户排队任务数上限（排队已满直接拒绝）
)

// AgentTodoItem 任务清单条目（todo_write 全量替换，前端渲染进度条）
type AgentTodoItem struct {
	Content string `json:"content"`
	Status  string `json:"status"` // pending/in_progress/done
}

// AgentApproval 审批结果（用户上行投递到等待中的任务）
type AgentApproval struct {
	Action string                 // approve / reject / cancel（取消任务时服务端内部投递）
	Params map[string]interface{} // 改参放行后的新参数（approve 且非空时替换执行参数）
}

// AgentExecResult 阶段六十：PC 本地执行器回传的工具执行结果（handleAgentExecResp 投递到等待中的任务）
type AgentExecResult struct {
	OK     bool   // false=工具级失败（路径越界/读失败等），结果照常回传模型自纠
	Output string // 给模型的结果文本（与服务端执行同格式约定）
}

// AgentTask 运行中任务状态（内存态；结束态落库 im_agent_task 供追溯）
type AgentTask struct {
	ID       string
	Username string
	Agent    *AIRunAgent
	Goal     string

	Status    string // queued / running / waiting_approval / completed / failed / cancelled
	Cancelled atomic.Bool

	EnqueueSeq uint64 // 阶段六十七：入队序号（FIFO 派发排序依据，直接启动的任务不使用）
	SessionID  uint   // 阶段七十一：归属 AI 会话（受理时盖戳，0=默认会话；任务卡重放按会话过滤）

	mu          sync.Mutex
	todo        []AgentTodoItem
	approveCh   chan *AgentApproval   // 容量 1：等待审批时由 handleAgentApprove 投递
	approveStep string                // 当前等待审批的步骤 key（toolCall.ID，防跨任务/跨步骤错投）
	approveTool string                // 阶段六十二：当前等待审批的工具名（"同意并加白"按工具分流）
	execCh      chan *AgentExecResult // 阶段六十：容量 1，等待 PC 本地执行回传时由 handleAgentExecResp 投递
	execStep    string                // 当前等待本地执行回传的步骤 key（toolCall.ID，防迟到回传错投）
	steps       int
	stepSeq     int // 阶段六十五：执行轨迹序号计数器（与 steps 区分——steps 为模型迭代轮次，stepSeq 为工具调用留痕序号）
	endOnce     sync.Once
}

// 任务注册表（taskID → task；含近期结束任务用于取消竞态兜底，定期清理防泄漏）
var agentTasks sync.Map // map[string]*AgentTask

// agentQueueMu 阶段六十七：任务发起/派发互斥锁——「统计并发+入队/启动」与「完结后派发队首」
// 均在锁内完成，防止并发发起时双双判定有空位超开任务（sendToUser 为非阻塞投递，锁内推送安全）
var agentQueueMu sync.Mutex

// agentEnqueueSeq 阶段六十七：全局入队序号发生器（保证 FIFO 严格递增）
var agentEnqueueSeq atomic.Uint64

// agentCountForUser 统计用户当前活动任务数（running/waiting_approval）与排队任务列表（按 EnqueueSeq 升序）
// 调用方须持有 agentQueueMu
func agentCountForUser(username string) (active int, queued []*AgentTask) {
	agentTasks.Range(func(_, value any) bool {
		t := value.(*AgentTask)
		if t.Username != username {
			return true
		}
		t.mu.Lock()
		st := t.Status
		t.mu.Unlock()
		switch st {
		case "running", "waiting_approval":
			active++
		case "queued":
			queued = append(queued, t)
		}
		return true
	})
	sort.Slice(queued, func(i, j int) bool { return queued[i].EnqueueSeq < queued[j].EnqueueSeq })
	return active, queued
}

// agentDispatchNext 阶段六十七：派发归口——用户活动任务数低于并发上限时，启动队首最早入队的排队任务；
// 无论是否派发，均给全部排队任务广播当前位次（队首取走/取消中段任务后位次前移，未变的幂等刷新）。
// 任务完结（completed/failed/cancelled）与取消排队后统一调用
func (s *Server) agentDispatchNext(username string) {
	agentQueueMu.Lock()
	active, queued := agentCountForUser(username)
	var head *AgentTask
	if active < agentConcurrency && len(queued) > 0 {
		head = queued[0]
		queued = queued[1:]
		head.mu.Lock()
		head.Status = "running"
		head.mu.Unlock()
		store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", head.ID).Update("status", "running")
	}
	// 排队位次广播（i+1 即当前位次：队首被派发取走或中段任务取消后，后续任务位次前移）
	for i := range queued {
		s.agentEmit(queued[i], "status", map[string]interface{}{"status": "queued", "text": "排队中", "position": i + 1})
	}
	agentQueueMu.Unlock()
	if head == nil {
		return
	}
	logger.Info("Agent 任务自队列派发 %s（用户 %s，剩余排队 %d）", head.ID, username, len(queued))
	// 已受理事件（前端将排队卡片切换为执行中）
	s.agentEmit(head, "status", map[string]interface{}{"status": "running", "text": "任务已受理", "goal": head.Goal, "agent": head.Agent.Name, "from_queue": true})
	// 异步执行状态机（不阻塞 WebSocket 主调度）
	go s.runAgentTask(head)
}

// usernameSanitizeRe 用户名 → 目录名归口（注册用户名本就受限，防御性兜底：
// 仅保留字母数字下划线中划线与常用中文，其余字符替换为下划线，防路径拼接注入）
var usernameSanitizeRe = regexp.MustCompile(`[^0-9A-Za-z_\-\x{4e00}-\x{9fa5}]`)

func agentUsernameDir(username string) string {
	return usernameSanitizeRe.ReplaceAllString(username, "_")
}

// InitAgent 阶段五十九：初始化智能 Agent 模块（config 归口 + 任务表迁移）
func InitAgent(cfg *config.Config) {
	agentEnabled = cfg.AI.Agent.Enabled
	if cfg.AI.Agent.MaxSteps > 0 {
		agentMaxSteps = cfg.AI.Agent.MaxSteps
	}
	if cfg.AI.Agent.ToolTimeoutSeconds > 0 {
		t := cfg.AI.Agent.ToolTimeoutSeconds
		if t > agentCmdTimeoutMax {
			t = agentCmdTimeoutMax
		}
		agentToolTimeout = time.Duration(t) * time.Second
	}
	if cfg.AI.Agent.ApproveTimeoutSeconds > 0 {
		agentApproveWait = time.Duration(cfg.AI.Agent.ApproveTimeoutSeconds) * time.Second
	}
	agentAutoWrite = cfg.AI.Agent.AutoWrite
	agentAutoCmds = cfg.AI.Agent.AutoCommands
	agentPcExec = cfg.AI.Agent.PcExecutor
	// 阶段六十七：任务队列参数归口（并发上限 0=1，排队上限 0=5）
	if cfg.AI.Agent.Concurrency > 0 {
		agentConcurrency = cfg.AI.Agent.Concurrency
	}
	if cfg.AI.Agent.QueueSize > 0 {
		agentQueueSize = cfg.AI.Agent.QueueSize
	}
	// 工作区根目录已在 config.Load 归口解析为绝对路径（空=exe目录/agent_workspace）
	agentWorkRoot = cfg.AI.Agent.WorkspaceRoot
	// 阶段六十八：网络工具配置归口（http_request 默认开启；web_search 默认关闭须显式配置服务商）
	agentHttpEnabled = cfg.AI.Agent.HttpEnabled == nil || *cfg.AI.Agent.HttpEnabled
	agentHttpAllowPrivate = cfg.AI.Agent.HttpAllowPrivate == nil || *cfg.AI.Agent.HttpAllowPrivate
	agentSearchEnabled = cfg.AI.Agent.WebSearch.Enabled != nil && *cfg.AI.Agent.WebSearch.Enabled
	agentSearchProvider = strings.ToLower(strings.TrimSpace(cfg.AI.Agent.WebSearch.Provider))
	agentSearchAPIKey = strings.TrimSpace(cfg.AI.Agent.WebSearch.APIKey)
	agentSearchEndpoint = strings.TrimSpace(cfg.AI.Agent.WebSearch.Endpoint)
	if err := store.DB.AutoMigrate(&model.AgentTaskRecord{}); err != nil {
		logger.Error("Agent 任务表迁移失败: %v", err)
	}
	// 阶段六十七：服务重启遗留态归口——内存任务注册表随进程消失，落库的 queued/running 记录
	// 已不可能恢复（queued 从未启动、running 执行中断），统一标记 failed 防任务历史出现幻影进行态
	if err := store.DB.Model(&model.AgentTaskRecord{}).
		Where("status IN ?", []string{"queued", "running"}).
		Updates(map[string]interface{}{"status": "failed", "error": "服务重启，任务中断"}); err != nil {
		logger.Error("Agent 遗留任务状态清理失败: %v", err)
	}
	// 阶段六十五：执行步骤留痕表迁移
	if err := store.DB.AutoMigrate(&model.AgentStepRecord{}); err != nil {
		logger.Error("Agent 执行轨迹表迁移失败: %v", err)
	}
	// 阶段七十一：AI 多会话表迁移（用户+智能体 多会话归口，Trae 同款"新建会话"）
	initAISessionTable()
	// 阶段七十二：私聊永久删除审批表迁移（双方同意才物理删除）
	if err := store.DB.AutoMigrate(&model.MsgPurgeApply{}); err != nil {
		logger.Error("永久删除审批表迁移失败: %v", err)
	}
	// 阶段六十二：加载审批白名单（命令前缀 + 写文件免审批开关）——审批弹窗"同意并加白"持久化，重启不丢
	if err := store.DB.AutoMigrate(&model.AgentWhitelist{}); err != nil {
		logger.Error("Agent 白名单表迁移失败: %v", err)
	} else {
		var wlRows []model.AgentWhitelist
		store.DB.Where("kind = ?", "cmd").Find(&wlRows)
		for _, r := range wlRows {
			v := strings.ToLower(strings.TrimSpace(r.Value))
			if v != "" && !agentCmdWhitelisted(v) {
				agentAutoCmds = append(agentAutoCmds, v)
			}
		}
		var awRow model.AgentWhitelist
		if err := store.DB.Where("kind = ?", "autowrite").First(&awRow).Error; err == nil {
			agentAutoWrite = true
		}
		logger.Info("Agent 审批白名单加载完成：命令前缀 %d 条（含配置），写文件免审批=%v", len(agentAutoCmds), agentAutoWrite)
	}
	// 定期清理已结束任务（防注册表泄漏）
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			agentTasks.Range(func(key, value any) bool {
				t := value.(*AgentTask)
				t.mu.Lock()
				st := t.Status
				t.mu.Unlock()
				if st == "completed" || st == "failed" || st == "cancelled" {
					agentTasks.Delete(key)
				}
				return true
			})
		}
	}()
	logger.Info("智能 Agent 模块加载完成：enabled=%v，max_steps=%d，工作区=%s", agentEnabled, agentMaxSteps, agentWorkRoot)
	// 阶段六十八：网络工具状态日志（web_search 未开启时提示配置方式，方便管理员启用）
	logger.Info("Agent 网络工具：http_request=%v（内网访问=%v），web_search=%v（provider=%s）",
		agentHttpEnabled, agentHttpAllowPrivate, agentSearchEnabled, agentSearchProvider)
}

// agentWorkspaceDir 用户工作区目录（按 username 隔离，不存在则创建）
func agentWorkspaceDir(username string) (string, error) {
	dir := filepath.Join(agentWorkRoot, agentUsernameDir(username))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// agentSafePath 路径安全归口：将模型给定的相对路径解析到用户工作区内。
// 拒绝绝对路径 / 盘符 / 任意 .. 逃逸；返回工作区内绝对路径（双保险：Join 后 Rel 校验）
func agentSafePath(username, p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("路径不能为空")
	}
	if filepath.IsAbs(p) || strings.Contains(p, ":") || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return "", errors.New("仅允许工作区内的相对路径")
	}
	clean := filepath.Clean(filepath.FromSlash(p))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "..") {
		return "", errors.New("路径不允许包含 .. 上级引用")
	}
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "", err
	}
	full := filepath.Join(ws, clean)
	rel, err := filepath.Rel(ws, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", errors.New("路径越界")
	}
	return full, nil
}

// agentWebSearchToolDef web_search 工具 schema 归口（阶段六十九提取：Agent 任务与普通聊天
// 联网问答共用同一 schema，文案/参数防两处漂移）
func agentWebSearchToolDef() aiToolDefinition {
	return aiToolDefinition{Type: "function", Function: map[string]interface{}{
		"name":        "web_search",
		"description": "联网搜索获取实时信息（新闻/资料/行情/文档等）。返回网页标题、链接与摘要；需要页面或接口全文时再用 http_request 抓取。",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "搜索关键词（可用空格组合多个词）"},
				"count": map[string]interface{}{"type": "integer", "description": "结果条数（1-10，默认 5）"},
			},
			"required": []string{"query"},
		},
	}}
}

// agentToolDefinitions 注入模型的工具 schema（OpenAI function calling 格式；
// 阶段六十八：http_request/web_search 按配置开关动态注入，未开启不进 schema 防模型误调用）
func agentToolDefinitions() []aiToolDefinition {
	tools := []aiToolDefinition{
		{Type: "function", Function: map[string]interface{}{
			"name":        "read_file",
			"description": "读取文本文件内容（代码/文档/配置等）。支持工作区相对路径；用户配置白名单后也可用授权目录内的绝对路径。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "工作区内相对路径（如 src/main.go），或授权目录内的绝对路径"},
				},
				"required": []string{"path"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "write_file",
			"description": "新建或覆盖写入文本文件（自动创建父目录）。需要用户审批（除非管理员开启免审批）。支持工作区相对路径；用户配置白名单后也可用授权目录内的绝对路径。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":    map[string]interface{}{"type": "string", "description": "工作区内相对路径，或授权目录内的绝对路径"},
					"content": map[string]interface{}{"type": "string", "description": "写入的完整文本内容"},
					"mode":    map[string]interface{}{"type": "string", "enum": []string{"overwrite", "append"}, "description": "写入模式，默认 overwrite"},
				},
				"required": []string{"path", "content"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "todo_write",
			"description": "建立或更新任务清单（全量替换）。接到任务后应先建立清单，并在推进过程中实时更新条目状态（pending/in_progress/done），用户端实时显示进度。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"todos": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"content": map[string]interface{}{"type": "string", "description": "条目内容"},
								"status":  map[string]interface{}{"type": "string", "enum": []string{"pending", "in_progress", "done"}},
							},
							"required": []string{"content", "status"},
						},
					},
				},
				"required": []string{"todos"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "run_command",
			"description": "在工作区目录执行命令行指令（运行程序、安装依赖、调试项目等）。默认超时 60 秒。白名单外命令需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"command": map[string]interface{}{"type": "string", "description": "要执行的命令"},
					"timeout": map[string]interface{}{"type": "integer", "description": "超时秒数（1-300，默认 60）"},
				},
				"required": []string{"command"},
			},
		}},
	}
	// 阶段六十八：网络工具（HTTP 请求 + 联网搜索）
	if agentHttpEnabled {
		tools = append(tools, aiToolDefinition{Type: "function", Function: map[string]interface{}{
			"name":        "http_request",
			"description": "向指定 URL 发起 HTTP 请求（调用接口/查询数据/抓取网页内容）。支持自定义方法、请求头与请求体；GET/HEAD 只读请求自动放行，POST/PUT/DELETE/PATCH 需用户审批。返回状态码与响应体。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url":     map[string]interface{}{"type": "string", "description": "完整请求地址（http/https）"},
					"method":  map[string]interface{}{"type": "string", "enum": []string{"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"}, "description": "HTTP 方法，默认 GET"},
					"headers": map[string]interface{}{"type": "object", "description": "自定义请求头键值对（可选，如 {\"Authorization\": \"Bearer xxx\"}）"},
					"body":    map[string]interface{}{"type": "string", "description": "请求体（POST/PUT/PATCH 时使用，通常为 JSON 字符串）"},
					"timeout": map[string]interface{}{"type": "integer", "description": "超时秒数（1-300，默认 60）"},
				},
				"required": []string{"url"},
			},
		}})
	}
	if agentSearchEnabled {
		tools = append(tools, agentWebSearchToolDef())
	}
	return tools
}

// agentEmit 任务事件推送归口（事件流实时送达发起用户全部在线连接）
func (s *Server) agentEmit(t *AgentTask, eventType string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	payload["task_id"] = t.ID
	payload["type"] = eventType
	// 阶段七十一：事件流携带会话归属，客户端任务卡按会话盖戳过滤渲染（多端防串会话）
	payload["session_id"] = t.SessionID
	data, _ := json.Marshal(payload)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentEvent,
		FromUser:  t.Agent.Name, // 前端按会话归属渲染事件卡片
		ToUser:    t.Username,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(msg)
	s.sendToUser(t.Username, out)
}

// agentSetStatus 状态变更 + 推送（统一归口，前端据此更新进度条与状态标签）
func (s *Server) agentSetStatus(t *AgentTask, status, text string) {
	t.mu.Lock()
	t.Status = status
	t.mu.Unlock()
	s.agentEmit(t, "status", map[string]interface{}{"status": status, "text": text})
}

// agentCommandAutoAllowed run_command 白名单归口：命令（小写化）恰以白名单前缀开头（词边界）时自动放行
func agentCommandAutoAllowed(command string) bool {
	lc := strings.ToLower(strings.TrimSpace(command))
	agentWlMu.RLock()
	defer agentWlMu.RUnlock()
	for _, p := range agentAutoCmds {
		p = strings.ToLower(strings.TrimSpace(p))
		if p == "" {
			continue
		}
		if lc == p || strings.HasPrefix(lc, p+" ") {
			return true
		}
	}
	return false
}

// agentWlMu 阶段六十二：白名单运行态并发保护（agentAutoCmds 追加/agentAutoWrite 翻转 vs 风险分级读取）
var agentWlMu sync.RWMutex

// agentCmdWhitelisted 命令前缀是否已在白名单（启动加载与"同意并加白"去重用）
func agentCmdWhitelisted(prefix string) bool {
	agentWlMu.RLock()
	defer agentWlMu.RUnlock()
	for _, p := range agentAutoCmds {
		if strings.ToLower(strings.TrimSpace(p)) == prefix {
			return true
		}
	}
	return false
}

// agentWhitelistCmd 审批"同意并加白"（run_command）：命令首词入白名单（内存+DB 持久化）。
// 安全护栏：链式命令（含 && / || / | / & ）不加白——首词无法担保后续段落的危险性，仍仅本次放行
func agentWhitelistCmd(command string) (string, bool) {
	lc := strings.ToLower(strings.TrimSpace(command))
	if lc == "" {
		return "", false
	}
	if strings.ContainsAny(lc, "&|") {
		return "", false
	}
	token := strings.Fields(lc)[0]
	token = strings.Trim(token, "\"'")
	if token == "" || len(token) > 64 {
		return "", false
	}
	if agentCmdWhitelisted(token) {
		return token, true
	}
	agentWlMu.Lock()
	agentAutoCmds = append(agentAutoCmds, token)
	agentWlMu.Unlock()
	store.DB.Create(&model.AgentWhitelist{Kind: "cmd", Value: token})
	logger.Info("Agent 命令加白：%s（审批放行时用户确认）", token)
	return token, true
}

// agentWhitelistAutoWrite 审批"同意并加白"（write_file）：开启写文件免审批（内存+DB 持久化）
func agentWhitelistAutoWrite() {
	agentWlMu.Lock()
	already := agentAutoWrite
	agentAutoWrite = true
	agentWlMu.Unlock()
	if !already {
		store.DB.Create(&model.AgentWhitelist{Kind: "autowrite", Value: "on"})
		logger.Info("Agent 写文件免审批已开启（审批放行时用户确认）")
	}
}

// agentNeedsApproval 工具风险分级归口：返回是否需要人工审批与提示原因
func agentNeedsApproval(tool string, params map[string]interface{}) (bool, string) {
	switch tool {
	case "read_file", "todo_write":
		return false, "" // 只读与任务清单：安全，自动放行
	case "write_file":
		agentWlMu.RLock()
		auto := agentAutoWrite
		agentWlMu.RUnlock()
		if auto {
			return false, ""
		}
		return true, "写入文件属于敏感操作，请确认文件路径与内容"
	case "run_command":
		cmd, _ := params["command"].(string)
		if agentCommandAutoAllowed(cmd) {
			return false, ""
		}
		return true, "命令不在自动放行白名单内，请确认后执行"
	case "web_search":
		return false, "" // 阶段六十八：只读搜索，自动放行
	case "http_request":
		// 阶段六十八：GET/HEAD 只读请求自动放行；非只读方法可能改变远端数据，走审批
		method := strings.ToUpper(strings.TrimSpace(agentParamString(params["method"])))
		if method == "GET" || method == "HEAD" || method == "" {
			return false, ""
		}
		return true, "向外部服务发起非只读请求（" + method + "），请确认目标地址与请求内容"
	}
	return true, "未知工具默认走人工审批"
}

// agentToolExec 工具执行归口（均已在调用前完成审批）；返回给模型的结果文本
func agentToolExec(s *Server, t *AgentTask, tool string, params map[string]interface{}) string {
	switch tool {
	case "read_file":
		return agentToolReadFile(t.Username, params)
	case "write_file":
		return agentToolWriteFile(t.Username, params)
	case "todo_write":
		return agentToolTodoWrite(s, t, params)
	case "run_command":
		return agentToolRunCommand(t.Username, params)
	case "http_request":
		return agentToolHttpRequest(params) // 阶段六十八：服务端代理 HTTP 请求
	case "web_search":
		return agentToolWebSearch(params) // 阶段六十八：联网搜索
	}
	return "错误：未知工具 " + tool
}

// agentToolServerOnly 阶段六十八：始终服务端执行的工具归口（不下放 PC 本地执行器）——
// todo_write 为纯任务清单状态；http_request/web_search 为服务端网络操作
// （数据归口服务端统一执行，且 PC 本地执行器无对应实现）
func agentToolServerOnly(tool string) bool {
	return tool == "todo_write" || tool == "http_request" || tool == "web_search"
}

// agentToolEnvHint 阶段六十：tool_start 事件携带的执行环境预判（仅供前端即时展示提示）。
// 实际环境以 tool_result 事件的 env 为准——本地等待超时会回退服务端执行
func agentToolEnvHint(s *Server, t *AgentTask, tool string) string {
	if agentToolServerOnly(tool) || !agentPcExec {
		return "server"
	}
	if s.hub.HasPC(t.Username) {
		return "pc"
	}
	return "server"
}

// agentToolExecDispatch 阶段六十：工具执行环境分派归口。
// todo_write/http_request/web_search 等服务端工具始终服务端处理（agentToolServerOnly 归口）；
// 文件/命令工具在「本地执行器开启 + 发起人 PC 端在线」时下放到其电脑本地执行（文件直接落在用户磁盘），
// PC 离线或回传超时自动回退服务端工作区执行，任务不中断。
// 返回 (结果文本, 执行环境 env)，env 用于事件流展示（pc=用户本地 / server=服务端）
func (s *Server) agentToolExecDispatch(t *AgentTask, callID, tool string, params map[string]interface{}) (string, string) {
	if agentToolServerOnly(tool) {
		return agentToolExec(s, t, tool, params), "server"
	}
	if agentPcExec && s.hub.HasPC(t.Username) {
		if result, ok := s.agentWaitLocalExec(t, callID, tool, params); ok {
			return result, "pc"
		}
		// 回传超时（PC 掉线/异常）：回退服务端工作区执行
		// 注：若 PC 已实际执行但回传丢失，回退可能重复执行一次（write_file 幂等覆盖、命令重跑），
		// 与既有工具超时语义一致，保证任务闭环优先
		logger.Warn("Agent 本地执行回传超时，回退服务端执行：%s 工具 %s", t.ID, tool)
	}
	return agentToolExec(s, t, tool, params), "server"
}

// agentStepTrace 阶段六十五：单步工具调用轨迹落库归口（免审/审批通过/拒绝/取消/超时/本地回退各分支统一收口）。
// 每步即时落库（任务运行中查看详情亦可追溯已执行部分），序号取任务内递增 stepSeq；
// 参数摘要截断 1000 字、结果摘要截断 2000 字防超长撑表；落库失败仅记日志不阻断任务执行
func (s *Server) agentStepTrace(t *AgentTask, tool string, params map[string]interface{}, result string, ok bool, env, approval string, durationMS int64) {
	t.mu.Lock()
	t.stepSeq++
	seq := t.stepSeq
	t.mu.Unlock()
	paramsJSON := ""
	if len(params) > 0 {
		if b, err := json.Marshal(params); err == nil {
			paramsJSON = truncateRunes(string(b), 1000)
		}
	}
	rec := model.AgentStepRecord{
		TaskID:     t.ID,
		Seq:        seq,
		Tool:       tool,
		Params:     paramsJSON,
		Result:     truncateRunes(result, 2000),
		OK:         ok,
		Env:        env,
		Approval:   approval,
		DurationMS: durationMS,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("Agent 执行轨迹落库失败（任务 %s 步骤 %d）：%v", t.ID, seq, err)
	}
}

// agentWaitLocalExec 阶段六十：下发本地执行请求并挂起等待 PC 回传。
// step 用 toolCall.ID 归口（与服务端审批同款防错投机制），迟到/不匹配回传直接丢弃。
// 返回 (结果文本, true=已收到 PC 回传；false=等待超时需回退服务端)
func (s *Server) agentWaitLocalExec(t *AgentTask, step, tool string, params map[string]interface{}) (string, bool) {
	ch := make(chan *AgentExecResult, 1)
	t.mu.Lock()
	t.execCh = ch
	t.execStep = step
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.execCh = nil
		t.execStep = ""
		t.mu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": t.ID,
		"step":    step,
		"tool":    tool,
		"params":  params,
	})
	reqMsg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentExecReq,
		FromUser:  t.Agent.Name, // 前端按会话归属桥接到本地执行器
		ToUser:    t.Username,
		Content:   string(reqData),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(reqMsg)
	s.sendToUser(t.Username, out)

	// 等待上限 = 工具自身超时 + 回传余量（PC 端命令执行已有自身超时强杀；余量覆盖 WS 转发与 IPC 往返）
	wait := agentToolTimeout + 15*time.Second
	if tool == "run_command" {
		if v, ok := params["timeout"].(float64); ok && v > 0 {
			if v > agentCmdTimeoutMax {
				v = agentCmdTimeoutMax
			}
			wait = time.Duration(v)*time.Second + 15*time.Second
		}
	}
	select {
	case r := <-ch:
		// 工具级失败（路径越界等）照常回传，模型据此自纠；仅超时走回退
		return r.Output, true
	case <-time.After(wait):
		return "", false
	}
}

// handleAgentExecResp 阶段六十：PC 本地执行结果上行（msg_type=51）。
// 校验发起人与步骤后投递到等待中的任务；非等待态/步骤不匹配（迟到回传）静默丢弃
func (s *Server) handleAgentExecResp(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string `json:"task_id"`
		Step   string `json:"step"`
		OK     bool   `json:"ok"`
		Output string `json:"output"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		return // 本地执行回传属于旁路信令，格式异常静默丢弃即可
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人自己的 PC 连接可回传
		return
	}
	t.mu.Lock()
	ch := t.execCh
	step := t.execStep
	t.mu.Unlock()
	if ch == nil || step != req.Step { // 非等待态或步骤不匹配（迟到的回传）直接丢弃
		return
	}
	select {
	case ch <- &AgentExecResult{OK: req.OK, Output: req.Output}:
	default:
	}
}

// agentSandbox 阶段六十一：PC 端上报的用户本地沙箱白名单（主工作区 + 授权目录列表）。
// 仅内存保存不落库（本地磁盘路径机器相关，隐私归口用户本机）；仅提示词注入与 HasPC 判定使用，
// 服务端不据此放行任何本地路径——服务端工作区安全仍归口 agentSafePath
type AgentSandbox struct {
	Primary string   // 主工作区：相对路径的落盘根目录（空=PC 端默认工作区）
	Dirs    []string // 授权目录列表：绝对路径文件操作仅允许落在这些目录内（PC 端执行时强校验）
}

// agentSandboxes username → *AgentSandbox（登录后/变更时由 PC 端上报覆盖）
var agentSandboxes sync.Map

const (
	agentSandboxMaxDirs    = 10  // 授权目录数量上限（防滥用）
	agentSandboxMaxPathLen = 512 // 单目录路径长度上限
)

// handleAgentSandbox 阶段六十一：PC 端沙箱白名单上报（msg_type=52）。
// 仅接受 platform=pc 的连接上报；校验裁剪后原子覆盖内存态（异常静默丢弃，旁路信令不影响主链路）
func (s *Server) handleAgentSandbox(c *Client, msg *protocol.Message) {
	if c.platform != "pc" {
		return // 仅 PC 端存在本地磁盘沙箱概念
	}
	var req struct {
		Primary string   `json:"primary"`
		Dirs    []string `json:"dirs"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		return
	}
	if len(req.Dirs) > agentSandboxMaxDirs {
		req.Dirs = req.Dirs[:agentSandboxMaxDirs]
	}
	// 清洗：去空白/超长项，保序去重
	dirs := make([]string, 0, len(req.Dirs))
	seen := make(map[string]bool)
	for _, d := range req.Dirs {
		d = strings.TrimSpace(d)
		if d == "" || len(d) > agentSandboxMaxPathLen || seen[d] {
			continue
		}
		seen[d] = true
		dirs = append(dirs, d)
	}
	primary := strings.TrimSpace(req.Primary)
	if len(primary) > agentSandboxMaxPathLen {
		primary = ""
	}
	// 主工作区必须在授权目录列表内（不在则回退首个目录；列表为空则无主工作区=PC 默认工作区）
	if primary != "" && !seen[primary] {
		if len(dirs) > 0 {
			primary = dirs[0]
		} else {
			primary = ""
		}
	}
	if len(dirs) == 0 {
		agentSandboxes.Delete(c.username) // 空白名单=回到默认工作区语义
		return
	}
	agentSandboxes.Store(c.username, &AgentSandbox{Primary: primary, Dirs: dirs})
}

// agentSandboxFor 阶段六十一：读取用户沙箱白名单（仅在 PC 端在线时返回——
// Web/手机端发起的任务永远走服务端执行，注入本地目录提示反而误导模型）
func (s *Server) agentSandboxFor(username string) *AgentSandbox {
	if !agentPcExec || !s.hub.HasPC(username) {
		return nil
	}
	if v, ok := agentSandboxes.Load(username); ok {
		return v.(*AgentSandbox)
	}
	return nil
}

// agentToolReadFile 读取工作区文本文件（UTF-8 输出，超长截断，GBK 兜底转码）
func agentToolReadFile(username string, params map[string]interface{}) string {
	path, _ := params["path"].(string)
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "错误：读取失败 " + err.Error()
	}
	text := string(data)
	// GBK 编码兜底：Windows 常见中文文本为 GBK，UTF-8 解码出现替换符时尝试转码
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	runes := []rune(text)
	if len(runes) == 0 {
		return "（空文件）"
	}
	if len(runes) > agentReadMaxChars {
		return fmt.Sprintf("文件共 %d 字符，已截断显示前 %d 字符：\n%s", len(runes), agentReadMaxChars, string(runes[:agentReadMaxChars]))
	}
	return text
}

// agentToolWriteFile 工作区写文件（自动建父目录；overwrite/append）
func agentToolWriteFile(username string, params map[string]interface{}) string {
	path, _ := params["path"].(string)
	content, _ := params["content"].(string)
	mode, _ := params["mode"].(string)
	if mode == "" {
		mode = "overwrite"
	}
	if mode != "overwrite" && mode != "append" {
		return "错误：mode 仅支持 overwrite/append"
	}
	runes := []rune(content)
	if len(runes) > agentWriteMaxChars {
		return fmt.Sprintf("错误：内容超长（%d 字符，上限 %d）", len(runes), agentWriteMaxChars)
	}
	full, err := agentSafePath(username, path)
	if err != nil {
		return "错误：" + err.Error()
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "错误：创建目录失败 " + err.Error()
	}
	var n int
	var diffStat string // 阶段六十二：+N -M 行变化统计（Trae CN 同款，仅 overwrite 且旧文件存在时计算）
	if mode == "append" {
		f, err := os.OpenFile(full, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return "错误：" + err.Error()
		}
		defer f.Close()
		n, err = f.WriteString(content)
		if err != nil {
			return "错误：写入失败 " + err.Error()
		}
	} else {
		// 覆盖前读旧内容（存在才统计 diff；不存在视为创建）
		oldContent, oldErr := os.ReadFile(full)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return "错误：写入失败 " + err.Error()
		}
		n = len(content)
		if oldErr == nil {
			add, del := agentLineDiffStat(string(oldContent), content)
			diffStat = fmt.Sprintf("+%d -%d ", add, del)
		}
	}
	verb := "写入"
	if mode == "append" {
		verb = "追加"
	}
	if diffStat != "" {
		return fmt.Sprintf("已编辑 %s（%s，%d 字节）", path, diffStat, n)
	}
	if mode == "overwrite" {
		return fmt.Sprintf("已创建 %s（%d 字节）", path, n)
	}
	return fmt.Sprintf("已%s %s（%d 字节）", verb, path, n)
}

// agentLineDiffStat 行级 diff 统计（多行集合交集近似：added=新文独有行数 removed=旧文独有行数，
// 展示用足够，非严格 LCS diff）
func agentLineDiffStat(oldContent, newContent string) (int, int) {
	oldSet := make(map[string]int)
	for _, l := range strings.Split(oldContent, "\n") {
		oldSet[l]++
	}
	common := 0
	newCount := 0
	for _, l := range strings.Split(newContent, "\n") {
		newCount++
		if oldSet[l] > 0 {
			oldSet[l]--
			common++
		}
	}
	oldCount := len(strings.Split(oldContent, "\n"))
	return newCount - common, oldCount - common
}

// agentToolTodoWrite 任务清单全量替换 + 进度事件推送（前端渲染清单卡片与进度条）
func agentToolTodoWrite(s *Server, t *AgentTask, params map[string]interface{}) string {
	raw, ok := params["todos"].([]interface{})
	if !ok {
		return "错误：todos 必须为数组"
	}
	if len(raw) > agentTodoMaxItems {
		return fmt.Sprintf("错误：清单条数超限（%d > %d）", len(raw), agentTodoMaxItems)
	}
	items := make([]AgentTodoItem, 0, len(raw))
	for _, it := range raw {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		content, _ := m["content"].(string)
		status, _ := m["status"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		if status != "pending" && status != "in_progress" && status != "done" {
			status = "pending"
		}
		items = append(items, AgentTodoItem{Content: content, Status: status})
	}
	if len(items) == 0 {
		return "错误：清单不能为空"
	}
	t.mu.Lock()
	t.todo = items
	t.mu.Unlock()
	done := 0
	for _, it := range items {
		if it.Status == "done" {
			done++
		}
	}
	s.agentEmit(t, "todo", map[string]interface{}{
		"todos": items,
		"done":  done,
		"total": len(items),
	})
	return fmt.Sprintf("任务清单已更新（共 %d 项，已完成 %d 项）", len(items), done)
}

// agentToolRunCommand 工作区内执行命令（cmd /C，超时强杀，输出截断；chcp 65001 统一 UTF-8 输出）
func agentToolRunCommand(username string, params map[string]interface{}) string {
	command, _ := params["command"].(string)
	command = strings.TrimSpace(command)
	if command == "" {
		return "错误：command 不能为空"
	}
	timeout := agentToolTimeout
	if v, ok := params["timeout"].(float64); ok && v > 0 {
		if v > agentCmdTimeoutMax {
			v = agentCmdTimeoutMax
		}
		timeout = time.Duration(v) * time.Second
	}
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "错误：" + err.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// chcp 65001 先切控制台代码页为 UTF-8（失败不中断），解决中文输出乱码
	cmd := exec.CommandContext(ctx, "cmd", "/C", "chcp 65001 >nul 2>&1 & "+command)
	cmd.Dir = ws
	out, err := cmd.CombinedOutput()
	text := string(out)
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(out); gerr == nil {
			text = string(gbk)
		}
	}
	runes := []rune(text)
	if len(runes) > agentCmdOutMaxChars {
		text = string(runes[:agentCmdOutMaxChars]) + fmt.Sprintf("\n…（输出过长已截断，共 %d 字符）", len(runes))
	}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Sprintf("错误：命令执行超时（%v），已终止\n输出：\n%s", timeout, text)
		}
		// 非零退出码也把已有输出带回（编译报错等场景输出比退出码更有价值）
		return fmt.Sprintf("命令退出码异常：%v\n输出：\n%s", err, text)
	}
	if strings.TrimSpace(text) == "" {
		return "（命令执行成功，无输出）"
	}
	return text
}

// agentNewTaskID 生成任务 ID（agt_时间戳_随机 hex）
func agentNewTaskID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("agt_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("agt_%d_%s", time.Now().Unix(), hex.EncodeToString(b))
}

// agentSystemPrompt Agent 系统提示词（工作区说明 + 本地授权目录 + 工具纪律 + 任务清单指引）。
// 阶段六十二修复：配置了主工作区（沙箱白名单）时主工作区优先宣传、命令无需 cd——
// 此前服务端工作区路径排在最前，模型会 cd 到服务端路径（cd...&&... 链式命令必触发审批），
// 与用户本地主工作区语义冲突
func agentSystemPrompt(username string, wsDir string, sandbox *AgentSandbox) string {
	workRule := "当前服务端为用户 " + username + " 分配了独立工作区（你的所有文件操作与命令执行都限制在该目录内）：" + wsDir + "。\n"
	pathRule := "4. 所有文件操作仅使用工作区内的相对路径。"
	if sandbox != nil && len(sandbox.Dirs) > 0 {
		// 主工作区优先：命令执行的工作目录就是主工作区，模型无需（也不应）cd 切换目录
		primary := sandbox.Primary
		if primary == "" {
			primary = sandbox.Dirs[0]
		}
		workRule = "用户已在本地电脑授权以下目录（沙箱白名单，可直接读写），你的文件操作与命令执行默认发生在主工作区：\n"
		for i, d := range sandbox.Dirs {
			mark := ""
			if d == primary {
				mark = "（主工作区）"
			}
			workRule += fmt.Sprintf("%d. %s%s\n", i+1, d, mark)
		}
		workRule += "命令执行的当前目录已经是主工作区，直接执行目标命令即可，禁止用 cd 切换目录（cd ... && ... 链式命令会触发人工审批）。\n"
		workRule += "服务端另为用户 " + username + " 保留了独立回退工作区：" + wsDir + "（仅在本地执行器离线时使用）。\n"
		pathRule = "4. 文件操作优先使用相对路径（落在主工作区）；操作白名单内其他授权目录时使用完整绝对路径，禁止访问白名单外的任何路径。"
	}
	// 阶段六十八：工具列表动态归口（与 agentToolDefinitions 注入 schema 同口径，未开启不宣传防误调用）
	toolList := "read_file（读文件）、write_file（写文件，需用户审批）、todo_write（任务清单）、run_command（执行命令，白名单外需审批）"
	if agentHttpEnabled {
		toolList += "、http_request（HTTP 接口调用/网页抓取，非只读方法需审批）"
	}
	if agentSearchEnabled {
		toolList += "、web_search（联网搜索）"
	}
	return "你是运行在即时通讯软件内的智能 Agent（自动化任务执行器）。\n" +
		workRule +
		"可用工具：" + toolList + "。\n" +
		"工作纪律：\n" +
		"1. 接到任务先分析，第一步必须调用 todo_write 建立任务清单（拆解为可执行的子步骤），并在推进过程中持续更新各条目状态。\n" +
		"2. 每轮先输出你的思考（简述本步要做什么、为什么），再发起工具调用；需要用户审批的操作会先推送给用户确认。\n" +
		"3. 工具结果回传后继续下一步；遇到错误要分析原因并调整方案，不要盲目重试同一操作。\n" +
		pathRule + "\n" +
		"5. 需要实时/外部信息（新闻、行情、文档、接口数据）时优先 web_search 检索，再用 http_request 抓取具体接口或页面；向用户转述时注明信息来源链接。\n" +
		"6. 任务完成后（所有清单条目 done），不再调用任何工具，直接输出最终总结答复（做了什么、产出在哪里、结果如何）。"
}

// agentEchoGoal 阶段七十：任务目标落库并回显（服务端归口会话历史——切会话/重登后提问不丢失，
// 与 AI 问答提问落库回显同口径 ai.go handleAIChat；最终答复由 agentFinish 落库，问答成对可见）。
// 阶段七十一：sid 指定归属会话（0=默认会话），回显/落库同源盖戳
func (s *Server) agentEchoGoal(c *Client, agentName, goal string, sid uint) {
	record := model.Message{
		MsgType:     2,
		FromUser:    c.username,
		ToUser:      agentName,
		Content:     goal,
		IsRead:      true, // AI 会话无已读回执语义，避免自己发的提问永远显示"未读"
		AISessionID: sid,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("Agent 任务目标落库失败（用户 %s）：%v", c.username, err)
		return
	}
	// 阶段七十一：占位标题会话以任务目标生成标题（与 AI 提问同归口）
	aiSessionAutoTitle(c.username, agentName, sid, goal)
	// 回显给发起人全部在线连接（复用私聊渲染链路，多端同步），真实 msg_id 随帧下发；
	// SessionID 随帧下发：多端按会话归属过滤渲染
	echo := protocol.Message{
		MsgType:   protocol.MsgTypePrivate,
		FromUser:  c.username,
		ToUser:    agentName,
		Content:   goal,
		MsgID:     record.ID,
		SessionID: sid,
		IsRead:    true,
		Timestamp: time.Now().Unix(),
	}
	echoData, _ := json.Marshal(echo)
	s.sendToUser(c.username, echoData)
	// 会话摘要归口（会话列表显示任务目标并排序置顶）
	s.touchConversation(c.username, agentName, messageSummary(goal))
	s.notifyConvUpdate(c.username)
}

// handleAgentRun 阶段五十九：任务发起/取消（上行 msg_type=46）
// 发起 content 为 JSON {goal, agent_name}；取消 content 为 JSON {task_id, action:"cancel"}
func (s *Server) handleAgentRun(c *Client, msg *protocol.Message) {
	content := strings.TrimSpace(msg.Content)
	var req struct {
		TaskID    string `json:"task_id"`
		Action    string `json:"action"`
		Goal      string `json:"goal"`
		AgentName string `json:"agent_name"`
		SessionID uint   `json:"session_id"` // 阶段七十一：归属会话（0=默认会话），任务全程按此盖戳
	}
	if err := json.Unmarshal([]byte(content), &req); err != nil {
		s.sendError(c, "任务请求格式错误")
		return
	}

	// 取消分支
	if req.Action == "cancel" {
		if req.TaskID == "" {
			s.sendError(c, "缺少 task_id")
			return
		}
		if v, ok := agentTasks.Load(req.TaskID); ok {
			t := v.(*AgentTask)
			if t.Username == c.username { // 仅发起人可取消
				t.mu.Lock()
				st := t.Status
				t.mu.Unlock()
				// 阶段六十七：排队任务取消——未启动无状态机可唤醒，直接收尾
				// （agentFinish 落库 cancelled+"任务已取消"通知留档，is_read=true 本人操作无未读），随后派发队首
				if st == "queued" {
					s.agentFinish(t, "cancelled", "", "")
					s.agentDispatchNext(t.Username)
					return
				}
				t.Cancelled.Store(true)
				t.mu.Lock()
				ch := t.approveCh
				step := t.approveStep
				t.mu.Unlock()
				if ch != nil && step != "" {
					// 唤醒等待中的审批（携带 cancel 标记，状态机内统一收口）
					select {
					case ch <- &AgentApproval{Action: "cancel"}:
					default:
					}
				}
			}
		}
		return
	}

	// 发起分支
	if !agentEnabled {
		s.sendError(c, "智能 Agent 功能未开启（服务端 config.yaml ai.agent.enabled=false）")
		return
	}
	goal := strings.TrimSpace(req.Goal)
	if goal == "" {
		s.sendError(c, "任务目标不能为空")
		return
	}
	agentName := strings.TrimSpace(req.AgentName)
	if agentName == "" {
		agentName = aiAgentList()[0].Name // 缺省取首个智能体
	}
	agent := aiAgentForUser(agentName, c.username)
	if agent == nil {
		s.sendError(c, "智能体不存在或无权使用")
		return
	}
	if agent.Provider == nil {
		s.sendError(c, "该智能体未绑定模型服务，无法执行自动化任务")
		return
	}

	// 阶段七十一：多会话归属校验（0=默认会话），任务回显/答复/记录全程按此会话盖戳
	sid := req.SessionID
	if !aiSessionValidate(c.username, agent.Name, sid) {
		s.sendError(c, "会话不存在或已被删除")
		return
	}

	// 阶段六十七：任务队列归口——活动任务数低于并发上限直接启动，超出入队排队（FIFO），
	// 排队已满拒绝；全程持锁防并发发起竞态超开（sendToUser 非阻塞投递，锁内推送安全）
	agentQueueMu.Lock()
	active, queued := agentCountForUser(c.username)
	if active >= agentConcurrency && len(queued) >= agentQueueSize {
		agentQueueMu.Unlock()
		s.sendError(c, fmt.Sprintf("已有任务在执行中且排队已满（并发 %d + 排队 %d），请等待任务完成或取消后再发起", agentConcurrency, agentQueueSize))
		return
	}

	t := &AgentTask{
		ID:        agentNewTaskID(),
		Username:  c.username,
		Agent:     agent,
		Goal:      goal,
		SessionID: sid, // 阶段七十一：任务全程会话归属（事件流/答复/任务记录同源）
	}
	if active < agentConcurrency {
		// 有空位：直接启动（阶段五十九原路径）
		t.Status = "running"
		agentTasks.Store(t.ID, t)
		agentQueueMu.Unlock()

		// 落库初始记录（running 态即建行，结束态更新，任务全程可追溯）
		rec := model.AgentTaskRecord{
			TaskID:    t.ID,
			Username:  c.username,
			AgentName: agent.Name,
			Goal:      goal,
			Status:    "running",
			SessionID: sid,
		}
		store.DB.Create(&rec)

		// 阶段七十：任务目标落库回显（提问进会话历史，切会话/重登不丢；先于受理事件保证提问气泡在任务卡上方）
		s.agentEchoGoal(c, agent.Name, goal, sid)

		// 已受理事件（前端创建任务面板）
		s.agentEmit(t, "status", map[string]interface{}{"status": "running", "text": "任务已受理", "goal": goal, "agent": agent.Name})

		// 异步执行状态机（不阻塞 WebSocket 主调度）
		go s.runAgentTask(t)
		return
	}

	// 无空位：入队排队（FIFO 序号归口，落库 queued 态，任务历史可见）
	t.Status = "queued"
	t.EnqueueSeq = agentEnqueueSeq.Add(1)
	agentTasks.Store(t.ID, t)
	position := len(queued) + 1
	agentQueueMu.Unlock()

	rec := model.AgentTaskRecord{
		TaskID:    t.ID,
		Username:  c.username,
		AgentName: agent.Name,
		Goal:      goal,
		Status:    "queued",
		SessionID: sid,
	}
	store.DB.Create(&rec)
	logger.Info("Agent 任务入队 %s（用户 %s，排队位次 %d）", t.ID, c.username, position)
	// 阶段七十：任务目标落库回显（排队任务同口径，提问进会话历史；先于受理事件保证提问气泡在任务卡上方）
	s.agentEchoGoal(c, agent.Name, goal, sid)
	s.agentEmit(t, "status", map[string]interface{}{"status": "queued", "text": "排队中", "position": position, "goal": goal, "agent": agent.Name})
}

// agentFinish 任务结束归口：状态落库 + done/error 事件推送（endOnce 防重复收尾）
func (s *Server) agentFinish(t *AgentTask, status, result, errMsg string) {
	t.endOnce.Do(func() {
		t.mu.Lock()
		t.Status = status
		t.mu.Unlock()
		store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", t.ID).
			Updates(map[string]interface{}{"status": status, "result": result, "error": errMsg, "steps": t.steps})
		// 阶段六十六：任务完结通知落库（会话流留档+未读归口：切走会话/最小化/离线后经历史与角标可靠感知）
		// completed 落最终答复（修复事件流不落库、重登后最终答复丢失）；failed/cancelled 落简短通知；
		// cancelled 由用户本人现场操作触发，is_read=true 不产生未读提醒
		notifyContent := ""
		notifyRead := false
		switch status {
		case "completed":
			notifyContent = result
		case "cancelled":
			notifyContent = "任务已取消"
			notifyRead = true
		default:
			if errMsg != "" {
				notifyContent = "任务执行失败：" + errMsg
			} else {
				notifyContent = "任务执行失败"
			}
		}
		var msgID uint
		if notifyContent != "" {
			reply := model.Message{
				MsgType:     2,
				FromUser:    t.Agent.Name,
				ToUser:      t.Username,
				Content:     notifyContent,
				IsRead:      notifyRead,
				AISessionID: t.SessionID, // 阶段七十一：完结答复与任务目标同会话盖戳，问答成对归位
			}
			if err := store.DB.Create(&reply).Error; err == nil {
				msgID = reply.ID
				// 阶段七十：完结答复消息 ID 回写任务记录（前端重进会话按此锚点在答复气泡前内联重放任务卡）
				store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ?", t.ID).Update("reply_msg_id", msgID)
			} else {
				logger.Error("Agent 完结通知落库失败（任务 %s）：%v", t.ID, err)
			}
			// 会话摘要与未读归口联动（CONV_LIST 推送后托盘角标/闪动自动生效）
			s.touchConversation(t.Username, t.Agent.Name, messageSummary(notifyContent))
			s.notifyConvUpdate(t.Username)
		}
		switch status {
		case "completed":
			s.agentEmit(t, "done", map[string]interface{}{"result": result, "steps": t.steps, "msg_id": msgID})
			// 阶段六十三：任务完成后异步提炼可复用经验入库（原实现：任务结束即止，无经验沉淀）
			var todoSummary string
			t.mu.Lock()
			for _, it := range t.todo {
				todoSummary += "[" + it.Status + "] " + it.Content + "\n"
			}
			t.mu.Unlock()
			agentExpEnqueue(t.Agent, t.Username, t.Goal, todoSummary, result, t.steps)
			// 阶段七十：后续提问建议（Trae 同款，与普通 AI 问答同链路）——done 帧先行下发（答复立即收尾），
			// 建议异步生成后经独立帧推送（客户端胶囊点击直接续问：Agent 模式开启发起新任务，关闭走普通问答）；
			// 仅 completed 生成（失败/取消无追问语义），失败静默无建议
			go func() {
				sugs := aiGenerateSuggestions(t.Agent, t.Goal, result)
				if len(sugs) == 0 {
					return
				}
				payload, _ := json.Marshal(sugs)
				sugMsg := protocol.Message{
					MsgType:   protocol.MsgTypeAISuggest,
					FromUser:  t.Agent.Name,
					ToUser:    t.Username,
					Content:   string(payload),
					Timestamp: time.Now().Unix(),
				}
				sugData, _ := json.Marshal(sugMsg)
				s.sendToUser(t.Username, sugData)
			}()
		case "cancelled":
			s.agentEmit(t, "status", map[string]interface{}{"status": "cancelled", "text": "任务已取消", "msg_id": msgID})
		default:
			s.agentEmit(t, "error", map[string]interface{}{"message": errMsg, "steps": t.steps, "msg_id": msgID})
		}
		logger.Info("Agent 任务结束 %s（用户 %s，状态 %s，%d 步）", t.ID, t.Username, status, t.steps)
		// 阶段六十七：任务释放并发名额后派发归口——队首排队任务自动启动（活动数达上限时为空操作）
		s.agentDispatchNext(t.Username)
	})
}

// runAgentTask Agent Loop 状态机：模型决策 → 工具调用（含审批挂起）→ 循环迭代 → 最终答复
func (s *Server) runAgentTask(t *AgentTask) {
	wsDir, err := agentWorkspaceDir(t.Username)
	if err != nil {
		s.agentFinish(t, "failed", "", "工作区创建失败："+err.Error())
		return
	}

	// 阶段六十三：系统提示词追加历史经验上下文（按任务目标向量检索该用户与该智能体的记忆与任务经验，
	// 原实现：仅注入 agentSystemPrompt，无经验复用）
	sysContent := agentSystemPrompt(t.Username, wsDir, s.agentSandboxFor(t.Username))
	if expCtx := agentExpContext(t.Agent, t.Username, t.Goal); expCtx != "" {
		sysContent += "\n\n" + expCtx
	}
	msgs := []aiChatMessage{
		// 阶段六十一：PC 端在线且用户配置了沙箱白名单时，注入本地授权目录（模型据此可用绝对路径操作用户自选目录）
		{Role: "system", Content: sysContent},
		{Role: "user", Content: t.Goal},
	}
	tools := agentToolDefinitions()

	for {
		// 取消检查（模型调用前）
		if t.Cancelled.Load() {
			s.agentFinish(t, "cancelled", "", "用户取消")
			return
		}

		t.mu.Lock()
		t.Status = "running"
		t.mu.Unlock()

		askCtx, cancelAsk := context.WithTimeout(context.Background(), aiAskTimeout)
		// 阶段六十二：改流式调用（Trae CN 同款打字机）——正文/推理增量经 text_delta/thought_delta
		// 事件实时推送；无增量（上游一次性返回）时回退整段 thought 事件兼容
		content, toolCalls, streamed, err := aiAgentChatStream(askCtx, t.Agent, msgs, tools,
			func(delta string) {
				s.agentEmit(t, "text_delta", map[string]interface{}{"text": delta})
			},
			func(delta string) {
				s.agentEmit(t, "thought_delta", map[string]interface{}{"text": delta})
			})
		cancelAsk()
		if err != nil {
			s.agentFinish(t, "failed", "", "模型调用失败："+err.Error())
			return
		}
		if t.Cancelled.Load() {
			s.agentFinish(t, "cancelled", "", "用户取消")
			return
		}

		// 无工具调用：模型给出最终答复，任务完成
		if len(toolCalls) == 0 {
			if strings.TrimSpace(content) == "" {
				s.agentFinish(t, "failed", "", "模型未返回有效内容")
				return
			}
			// 本轮已流式推送过（streamed）则不再重复整段；一次性返回的上游回退 thought 事件
			if !streamed {
				s.agentEmit(t, "thought", map[string]interface{}{"text": content})
			}
			s.agentFinish(t, "completed", content, "")
			return
		}

		// 有思考文本且未流式推送过则补推（体现思考过程）
		if strings.TrimSpace(content) != "" && !streamed {
			s.agentEmit(t, "thought", map[string]interface{}{"text": content})
		}

		// assistant 消息（含 tool_calls）入历史，后续 tool 结果按 tool_call_id 对应回传
		msgs = append(msgs, aiChatMessage{Role: "assistant", Content: content, ToolCalls: toolCalls})

		for _, tc := range toolCalls {
			if t.Cancelled.Load() {
				s.agentFinish(t, "cancelled", "", "用户取消")
				return
			}
			toolName := tc.Function.Name
			// 参数解析（非法 JSON 视为空参数，工具内部按缺参报错回传模型自纠）
			var params map[string]interface{}
			if strings.TrimSpace(tc.Function.Arguments) != "" {
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &params); err != nil {
					params = map[string]interface{}{"_parse_error": err.Error()}
				}
			}

			// 阶段六十五：计时起点前移至 tool_start 之前，轨迹耗时覆盖"审批等待 + 执行"全程
			start := time.Now()

			s.agentEmit(t, "tool_start", map[string]interface{}{"tool": toolName, "params": params, "env": agentToolEnvHint(s, t, toolName)})

			// 风险分级：需审批的工具挂起等待用户确认（改参放行/直接放行/拒绝/取消/超时）
			needApprove, reason := agentNeedsApproval(toolName, params)
			var result string
			var env string
			if needApprove {
				approved, out, aerr := s.agentWaitApproval(t, tc.ID, toolName, params, reason)
				if aerr != nil {
					// 阶段六十五：审批等待超时先留痕再中止任务
					s.agentStepTrace(t, toolName, params, aerr.Error(), false, "server", "timeout", time.Since(start).Milliseconds())
					s.agentFinish(t, "failed", "", aerr.Error())
					return
				}
				if approved == "cancel" {
					// 阶段六十五：审批中取消先留痕再收尾任务
					s.agentStepTrace(t, toolName, params, "用户取消了任务", false, "server", "cancelled", time.Since(start).Milliseconds())
					s.agentFinish(t, "cancelled", "", "用户取消")
					return
				}
				if approved == "reject" {
					result = "用户拒绝了该操作" + out
					s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": false, "output": result, "rejected": true})
					// 阶段六十五：用户拒绝留痕（该步未执行）
					s.agentStepTrace(t, toolName, params, result, false, "server", "rejected", time.Since(start).Milliseconds())
				} else {
					// 阶段六十：执行环境分派（PC 在线且开关开启时本地执行，事件流带 env 标签）
					result, env = s.agentToolExecDispatch(t, tc.ID, toolName, params)
					s.agentEmit(t, "tool_result", map[string]interface{}{"tool": toolName, "ok": !strings.HasPrefix(result, "错误"), "output": result, "env": env})
					// 阶段六十五：审批通过留痕（params 已含用户改参后的最终参数）
					s.agentStepTrace(t, toolName, params, result, !strings.HasPrefix(result, "错误"), env, "approved", time.Since(start).Milliseconds())
				}
			} else {
				result, env = s.agentToolExecDispatch(t, tc.ID, toolName, params)
				s.agentEmit(t, "tool_result", map[string]interface{}{
					"tool": toolName, "ok": !strings.HasPrefix(result, "错误"), "output": result,
					"duration_ms": time.Since(start).Milliseconds(), "env": env,
				})
				// 阶段六十五：免审批步骤留痕
				s.agentStepTrace(t, toolName, params, result, !strings.HasPrefix(result, "错误"), env, "none", time.Since(start).Milliseconds())
			}

			// tool 结果消息入历史（role=tool + tool_call_id，OpenAI 兼容格式）
			msgs = append(msgs, aiChatMessage{Role: "tool", Content: result, ToolCallID: tc.ID, Name: toolName})
		}

		// 步数限制：防模型死循环
		t.steps++
		if t.steps >= agentMaxSteps {
			s.agentFinish(t, "failed", "", fmt.Sprintf("已达最大迭代步数（%d），任务中止", agentMaxSteps))
			return
		}
	}
}

// agentWaitApproval 审批挂起：推送审批请求，阻塞等待用户上行结果（approve/reject/cancel/超时）。
// 返回 (action, 附加说明, error)；approve 时 params 已按用户改参更新
func (s *Server) agentWaitApproval(t *AgentTask, callID, tool string, params map[string]interface{}, reason string) (string, string, error) {
	ch := make(chan *AgentApproval, 1)
	step := callID // 审批步骤 key：tool_call ID 全局唯一且与本次调用一一对应
	t.mu.Lock()
	t.approveCh = ch
	t.approveStep = step
	t.approveTool = tool // 阶段六十二："同意并加白"按工具分流（run_command 加命令前缀 / write_file 开免审批）
	t.Status = "waiting_approval"
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		t.approveCh = nil
		t.approveStep = ""
		t.approveTool = ""
		t.mu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{
		"task_id": t.ID,
		"step":    step,
		"tool":    tool,
		"params":  params,
		"reason":  reason,
	})
	reqMsg := protocol.Message{
		MsgType:   protocol.MsgTypeAgentApproveReq,
		FromUser:  t.Agent.Name, // 前端按会话归属渲染审批卡片
		ToUser:    t.Username,
		Content:   string(reqData),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(reqMsg)
	s.sendToUser(t.Username, out)
	s.agentSetStatus(t, "waiting_approval", "等待用户审批："+tool)

	select {
	case ap := <-ch:
		switch ap.Action {
		case "approve":
			if ap.Params != nil {
				// 改参放行：用户审阅并修改后的参数替换执行参数
				for k, v := range ap.Params {
					params[k] = v
				}
			}
			s.agentSetStatus(t, "running", "审批通过，继续执行")
			return "approve", "", nil
		case "reject":
			s.agentSetStatus(t, "running", "用户拒绝，继续寻找替代方案")
			return "reject", "（如可行请调整方案，或说明任务无法继续的原因）", nil
		default: // cancel
			return "cancel", "", nil
		}
	case <-time.After(agentApproveWait):
		return "", "", fmt.Errorf("审批等待超时（%v），任务中止", agentApproveWait)
	}
}

// handleAgentApprove 审批结果上行（msg_type=49）：校验发起人与步骤后投递到等待中的任务
func (s *Server) handleAgentApprove(c *Client, msg *protocol.Message) {
	var req struct {
		TaskID string                 `json:"task_id"`
		Step   string                 `json:"step"`
		Action string                 `json:"action"`
		Params map[string]interface{} `json:"params"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.TaskID == "" {
		s.sendError(c, "审批请求格式错误")
		return
	}
	if req.Action != "approve" && req.Action != "reject" && req.Action != "whitelist" {
		s.sendError(c, "未知的审批操作")
		return
	}
	v, ok := agentTasks.Load(req.TaskID)
	if !ok {
		s.sendError(c, "任务不存在或已结束")
		return
	}
	t := v.(*AgentTask)
	if t.Username != c.username { // 仅发起人可审批
		return
	}
	t.mu.Lock()
	ch := t.approveCh
	step := t.approveStep
	tool := t.approveTool
	t.mu.Unlock()
	if ch == nil || step != req.Step { // 非等待态或步骤不匹配（迟到的审批）直接忽略
		return
	}
	// 阶段六十二："同意并加白"= 先按工具持久化白名单，再按 approve 放行本次
	if req.Action == "whitelist" {
		switch tool {
		case "run_command":
			cmd, _ := req.Params["command"].(string)
			agentWhitelistCmd(cmd) // 链式命令内部拒白，仅本次放行
		case "write_file":
			agentWhitelistAutoWrite()
		}
		req.Action = "approve"
	}
	select {
	case ch <- &AgentApproval{Action: req.Action, Params: req.Params}:
	default:
	}
}

// HandleAgentPreview 工作区静态访问（阶段五十九：页面预览工具的前端支撑，iframe 加载工作区 HTML 等产物）。
// 鉴权与现有 HTTP 接口一致（query username，内网信任模式）；路径安全归口 agentSafePath，
// 仅允许访问本人工作区内的文件
func (s *Server) HandleAgentPreview(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		http.Error(w, "缺少 username 参数", http.StatusBadRequest)
		return
	}
	p := strings.TrimSpace(r.URL.Query().Get("path"))
	full, err := agentSafePath(username, p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.Error(w, "文件不存在", http.StatusNotFound)
		return
	}
	// ServeFile 自动处理 MIME/Range/缓存头；路径已归口校验不越界
	http.ServeFile(w, r, full)
}

// ===== 阶段六十四：Agent 任务历史查看 =====
// 用户端：查看本人任务分页列表与单任务详情（鉴权水位与 /api/agents 一致：username 查询参数）；
// 管理端：审计全部用户任务（adminGuard 保护，支持用户名/状态筛选）。
// 数据归口 im_agent_task（running 态即建行、结束态更新，任务全程可追溯）；
// 列表项 goal/result 截断防超长记录撑大响应，全文经详情接口获取。

// agentTaskListQuery 任务列表查询参数解析归口（用户端与管理端共用）：页码/条数/状态筛选
// 返回 (page, size, status)；status 为空表示不筛选
func agentTaskListQuery(r *http.Request) (int, int, string) {
	page := int(adminQueryUint(r.URL.Query().Get("page")))
	if page <= 0 {
		page = 1
	}
	size := int(adminQueryUint(r.URL.Query().Get("size")))
	if size <= 0 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	return page, size, status
}

// agentTaskBrief 列表项构造归口：goal 截断 100 字、result 截断 300 字（全文走详情接口），
// 其余字段原样输出（含 update_time 供前端展示最近活动时间）
func agentTaskBrief(rows []model.AgentTaskRecord) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]interface{}{
			"task_id":      r.TaskID,
			"username":     r.Username,
			"agent_name":   r.AgentName,
			"goal":         truncateRunes(r.Goal, 100),
			"result":       truncateRunes(r.Result, 300),
			"error":        truncateRunes(r.Error, 200),
			"status":       r.Status,
			"steps":        r.Steps,
			"reply_msg_id": r.ReplyMsgID,
			"session_id":   r.SessionID,
			"create_time":  r.CreateTime,
			"update_time":  r.UpdateTime,
		})
	}
	return out
}

// HandleAgentTaskList 用户端任务历史分页列表（仅本人任务；status 可选筛选）
func (s *Server) HandleAgentTaskList(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	page, size, status := agentTaskListQuery(r)
	db := store.DB.Model(&model.AgentTaskRecord{}).Where("username = ?", username)
	if status != "" {
		db = db.Where("status = ?", status)
	}
	// 阶段七十：agent 过滤（会话内任务卡重放按智能体归口拉取，不掺其他会话任务）
	if ag := strings.TrimSpace(r.URL.Query().Get("agent")); ag != "" {
		db = db.Where("agent_name = ?", ag)
	}
	// 阶段七十一：会话过滤（任务卡重放按当前查看会话拉取；参数缺省=不过滤（任务历史弹窗全量），
	// 显式传 0=默认会话（未盖戳存量任务），防跨会话运行中任务卡串显）
	if r.URL.Query().Has("session_id") {
		db = db.Where("session_id = ?", adminQueryUint(r.URL.Query().Get("session_id")))
	}
	var total int64
	db.Count(&total)
	var rows []model.AgentTaskRecord
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&rows)
	adminJSON(w, map[string]interface{}{
		"total": total, "page": page, "size": size,
		"tasks": agentTaskBrief(rows),
	})
}

// HandleAgentTaskDetail 用户端单任务详情（归属校验：仅本人任务可看，全文返回）
func (s *Server) HandleAgentTaskDetail(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rec model.AgentTaskRecord
	if err := store.DB.Where("task_id = ? AND username = ?", taskID, username).First(&rec).Error; err != nil {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	adminJSON(w, rec)
}

// HandleAdminAgentTaskList 管理端全量任务审计列表（user 用户名模糊筛选 + status 精确筛选 + 分页）
func (s *Server) HandleAdminAgentTaskList(w http.ResponseWriter, r *http.Request) {
	page, size, status := agentTaskListQuery(r)
	user := strings.TrimSpace(r.URL.Query().Get("user"))
	db := store.DB.Model(&model.AgentTaskRecord{})
	if user != "" {
		db = db.Where("username LIKE ?", "%"+user+"%")
	}
	if status != "" {
		db = db.Where("status = ?", status)
	}
	var total int64
	db.Count(&total)
	var rows []model.AgentTaskRecord
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&rows)
	adminJSON(w, map[string]interface{}{
		"total": total, "page": page, "size": size,
		"tasks": agentTaskBrief(rows),
	})
}

// HandleAdminAgentTaskDetail 管理端单任务详情（管理员权限，不做 username 限制，全文返回）
func (s *Server) HandleAdminAgentTaskDetail(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rec model.AgentTaskRecord
	if err := store.DB.Where("task_id = ?", taskID).First(&rec).Error; err != nil {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	adminJSON(w, rec)
}

// ===== 阶段六十五：Agent 执行轨迹留痕 =====
// 每步工具调用即时落库 im_agent_step（免审/审批通过/拒绝/取消/超时各分支统一走 agentStepTrace 归口），
// 用户端/管理端均按任务维度拉取全量步骤（步数上限 agentMaxSteps 且摘要已截断，体积可控，不分页）

// HandleAgentTaskSteps 用户端单任务执行轨迹（归属校验：仅本人任务可看，按序号升序全量返回）
func (s *Server) HandleAgentTaskSteps(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	// 归属校验归口 im_agent_task：非本人任务一律 404（与详情接口同语义）
	var cnt int64
	store.DB.Model(&model.AgentTaskRecord{}).Where("task_id = ? AND username = ?", taskID, username).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}
	var rows []model.AgentStepRecord
	store.DB.Where("task_id = ?", taskID).Order("seq ASC").Find(&rows)
	adminJSON(w, map[string]interface{}{"task_id": taskID, "total": len(rows), "steps": rows})
}

// HandleAdminAgentTaskSteps 管理端单任务执行轨迹（管理员权限，不做 username 限制）
func (s *Server) HandleAdminAgentTaskSteps(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rows []model.AgentStepRecord
	store.DB.Where("task_id = ?", taskID).Order("seq ASC").Find(&rows)
	adminJSON(w, map[string]interface{}{"task_id": taskID, "total": len(rows), "steps": rows})
}
