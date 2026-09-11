package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// AIBotName 默认 AI 机器人名（群聊 @AI助手 唤醒触发沿用该名称）
const AIBotName = "AI助手"

// aiLimitKey AI 限流计数键前缀（Redis）
const aiLimitKey = "im:ai:limit:"

// aiAskTimeout 单次 AI 问答总超时（长回答场景放宽）
const aiAskTimeout = 5 * time.Minute

// AIRunAgent 运行时 AI 智能体（配置中的 agent + 解析后的 provider 引用）
type AIRunAgent struct {
	// ID 数据库记录 ID（阶段五十八：长期记忆按 agent_id 归键，改名不变；内置 mock 兜底智能体无 DB 记录为 0，不做记忆）
	ID           uint
	Name         string
	SystemPrompt string
	Avatar       string
	Provider     *config.AIProviderConfig // nil 表示未绑定可用模型服务，使用本地 Mock 应答
	// SupportsImage 绑定的模型是否支持图片识别（阶段四十四：继承 provider 配置归口）
	SupportsImage bool
	// KBIDs 阶段五十一：绑定的知识库 ID 列表（逗号分隔字符串，空=不启用 RAG 检索注入；
	// 个人库仅归属者对话时参与检索，权限过滤归口 kbSearch）
	KBIDs string
	// Owner 阶段五十七：个人智能体归属用户名（空=管理员公共智能体全员可见；个人智能体仅归属者可见可对话）
	Owner string
}

// 运行时状态（阶段四十九起可热重载，读写锁保护：对话链路 RLock 读，后台管理变更时 Lock 写）
var (
	aiMu         sync.RWMutex
	aiAgents     []*AIRunAgent
	aiAgentIndex map[string]*AIRunAgent
	// 限流与上下文参数（config.yaml ai 节点可配，均有兜底默认值）
	aiLimitCount    = 10
	aiLimitWindow   = 60 * time.Second
	aiContextWindow = 20
	// 阶段四十五：文档问答单文档提取文本上限（字符，config.yaml ai.doc_max_chars 可配）
	aiDocMaxChars = 60000
	// 阶段八十四：TRAE 同款历史对话压缩参数（config.yaml ai.compress_* 归口，AI 问答与 Agent 任务共用）
	aiCompressThreshold = 12000 // 历史上下文估算 token 达到该值触发压缩（<=0 禁用）
	aiCompressKeep      = 6     // 压缩时保留最近原文消息条数，更早历史并入摘要
	aiCompressScanExtra = 60    // 压缩启用时额外回溯的更早历史条数（原窗口外不再"滑走即丢"）
	aiCompressMaxOut    = 4000  // 摘要文本字符上限（防摘要本身失控膨胀）
	// 阶段八十四：会话摘要缓存（key "sid|user|agent" → 已覆盖到 uptoID 的摘要；服务重启后
	// 首问触发一次重压缩，属派生缓存可接受；会话清空/删除时同步失效）
	aiCompressMu    sync.Mutex
	aiCompressCache sync.Map
	// 阶段五十七：用户自建智能体配置（config.yaml ai.user_agent 归口，启动时加载）
	aiUserEnabled    = false  // 总开关（默认关闭，需 config 显式开启）
	aiUserProviders  []string // 用户可选模型服务白名单（provider 名）
	aiUserMaxPerUser = 10     // 每人自建数量上限
	aiUserPromptMax  = 2000   // 提示词最大字符数
	// AI 专用 HTTP 客户端：不设总超时（流式长回复），仅限制响应头等待时间防死连接
	aiHTTP = &http.Client{
		Transport: &http.Transport{
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}
)

// InitAI 阶段四十三：初始化 AI 智能体（服务端归口：API 地址与密钥仅存服务端，客户端不接触）
// 未配置任何智能体时内置默认"AI助手"（本地 Mock 应答），保证功能开箱可用
// 原实现：直接从 config.yaml 的 cfg.AI 构建，修改配置后需重启服务端生效
// 阶段四十九：AI 配置迁入数据库（im_ai_provider / im_ai_agent）——首次启动（两表均空）时
// 从 config.yaml 导入种子数据，之后以数据库为唯一运行时数据源；后台管理界面增删改后
// 调用 reloadAIAgents() 热生效（无需重启）
func InitAI(cfg *config.Config) {
	// 种子导入：全新部署（AI 两表均空）时从 config.yaml 迁入一次
	seedAIFromConfig(cfg)
	// 从数据库构建运行时索引
	reloadAIAgents()

	// 限流与上下文参数兜底
	if cfg.AI.LimitCount > 0 {
		aiLimitCount = cfg.AI.LimitCount
	}
	if cfg.AI.LimitWindow > 0 {
		aiLimitWindow = time.Duration(cfg.AI.LimitWindow) * time.Second
	}
	if cfg.AI.ContextWindow > 0 {
		aiContextWindow = cfg.AI.ContextWindow
	}
	// 阶段四十五：文档问答提取上限兜底（config 归口，启动时覆盖）
	if cfg.AI.DocMaxChars > 0 {
		aiDocMaxChars = cfg.AI.DocMaxChars
	}
	// 阶段八十四：历史压缩参数兜底（0=默认，负数=禁用压缩）
	if cfg.AI.CompressThresholdTokens > 0 {
		aiCompressThreshold = cfg.AI.CompressThresholdTokens
	} else if cfg.AI.CompressThresholdTokens < 0 {
		aiCompressThreshold = -1
	}
	if cfg.AI.CompressKeepMessages > 0 {
		aiCompressKeep = cfg.AI.CompressKeepMessages
	}
	// 阶段五十七：用户自建智能体配置（config 归口，启动时加载；白名单/上限均有兜底默认值）
	aiUserEnabled = cfg.AI.UserAgent.Enabled
	aiUserProviders = cfg.AI.UserAgent.Providers
	if cfg.AI.UserAgent.MaxPerUser > 0 {
		aiUserMaxPerUser = cfg.AI.UserAgent.MaxPerUser
	}
	if cfg.AI.UserAgent.PromptLimit > 0 {
		aiUserPromptMax = cfg.AI.UserAgent.PromptLimit
	}
}

// seedAIFromConfig 阶段四十九：种子导入——仅当 im_ai_provider 与 im_ai_agent 两表均空（全新部署）时，
// 将 config.yaml 的 ai.providers / ai.agents 导入数据库；之后数据库为唯一数据源，
// 管理员在后台删除全部配置后重启不会重复导入（如需恢复出厂可手动清空两张表后重启）
func seedAIFromConfig(cfg *config.Config) {
	var provCount, agentCount int64
	store.DB.Model(&model.AIProvider{}).Count(&provCount)
	store.DB.Model(&model.AIAgent{}).Count(&agentCount)
	if provCount > 0 || agentCount > 0 {
		return
	}

	// 迁入模型服务
	for i := range cfg.AI.Providers {
		p := cfg.AI.Providers[i]
		if strings.TrimSpace(p.Name) == "" {
			p.Name = fmt.Sprintf("provider-%d", i+1)
		}
		rec := model.AIProvider{
			Name:          p.Name,
			APIURL:        p.APIURL,
			APIKey:        p.APIKey,
			Model:         p.Model,
			SupportsImage: p.SupportsImage,
			Enabled:       true,
		}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("AI 种子导入模型服务 %s 失败: %v", p.Name, err)
		}
	}
	// 迁入智能体
	for _, a := range cfg.AI.Agents {
		if strings.TrimSpace(a.Name) == "" {
			continue
		}
		rec := model.AIAgent{
			Name:         a.Name,
			Provider:     a.Provider,
			SystemPrompt: a.SystemPrompt,
			Avatar:       a.Avatar,
			Enabled:      true,
			SortID:       0,
		}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("AI 种子导入智能体 %s 失败: %v", a.Name, err)
		}
	}
	logger.Info("AI 配置种子导入完成：%d 个模型服务，%d 个智能体（源自 config.yaml，后续以后台管理配置为准）", len(cfg.AI.Providers), len(cfg.AI.Agents))
}

// reloadAIAgents 阶段四十九：从数据库重建 AI 运行时索引（写锁保护，支持运行中热重载）
// 原实现：InitAI 直接遍历 cfg.AI.Agents 构建索引（修改配置需重启）
// 模型服务未启用（enabled=false）或智能体停用（enabled=false）时不参与运行时构建：
// 停用的智能体不下发客户端；停用的模型服务使绑定智能体降级本地 Mock 应答
func reloadAIAgents() {
	// 读取数据库配置
	var provs []model.AIProvider
	store.DB.Order("id ASC").Find(&provs)
	var agents []model.AIAgent
	store.DB.Where("enabled = ?", true).Order("sort_id ASC, id ASC").Find(&agents)

	// 提供方索引（值拷贝，与数据库记录解耦，热重载时原子替换）
	provMap := make(map[string]*config.AIProviderConfig)
	for i := range provs {
		p := &provs[i]
		if !p.Enabled {
			continue
		}
		provMap[p.Name] = &config.AIProviderConfig{
			Name:          p.Name,
			APIURL:        p.APIURL,
			APIKey:        p.APIKey,
			Model:         p.Model,
			VisionModel:   p.VisionModel,
			SupportsImage: p.SupportsImage,
		}
	}

	newIndex := make(map[string]*AIRunAgent)
	newList := make([]*AIRunAgent, 0, len(agents))
	for _, a := range agents {
		if strings.TrimSpace(a.Name) == "" {
			continue
		}
		ra := &AIRunAgent{ID: a.ID, Name: a.Name, SystemPrompt: a.SystemPrompt, Avatar: a.Avatar, KBIDs: a.KBIDs, Owner: a.Owner}
		if p, ok := provMap[a.Provider]; ok {
			ra.Provider = p
			ra.SupportsImage = p.SupportsImage // 图片识别能力随 provider 继承
		} else {
			logger.Warn("AI 智能体 %s 绑定的提供方 %q 未配置或已停用，将使用本地 Mock 应答", a.Name, a.Provider)
		}
		newList = append(newList, ra)
		newIndex[a.Name] = ra
	}
	if len(newList) == 0 {
		ra := &AIRunAgent{Name: AIBotName}
		newList = append(newList, ra)
		newIndex[AIBotName] = ra
		logger.Warn("未配置 AI 智能体，内置默认\"AI助手\"（本地 Mock 应答）；请在后台管理界面添加智能体")
	}

	// 写锁原子替换（对话链路持 RLock 读取，替换期间阻塞极短）
	aiMu.Lock()
	aiAgents = newList
	aiAgentIndex = newIndex
	aiMu.Unlock()
	logger.Info("AI 助手加载完成：%d 个智能体，%d 个可用模型服务", len(newList), len(provMap))
}

// aiAgentByName 按名称查找智能体（nil 表示不存在，读锁保护）
// 原实现：直接按名返回（阶段五十七起对话路由统一走 aiAgentForUser 权限归口，本函数保留供列表构建等无权限场景）
func aiAgentByName(name string) *AIRunAgent {
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiAgentIndex[name]
}

// aiAgentForUser 按名称查找当前用户可对话的智能体（阶段五十七权限归口）：
// 公共智能体（Owner 空）全员可用；个人智能体（Owner 非空）仅归属者可用，他人访问视同不存在
// （防探测：错误提示与"不存在"一致，不泄露他人个人智能体的存在性）
func aiAgentForUser(name, username string) *AIRunAgent {
	a := aiAgentByName(name)
	if a == nil {
		return nil
	}
	if a.Owner != "" && a.Owner != username {
		return nil
	}
	return a
}

// aiAgentList 运行时智能体列表快照（读锁保护，后台广播与列表下发归口）
func aiAgentList() []*AIRunAgent {
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiAgents
}

// aiChatMessage OpenAI 兼容对话消息
// 阶段四十四：Content 改为 interface{}——纯文本消息为 string，多模态消息为 []aiContentPart 数组
// 阶段五十九：扩展工具调用链路字段——ToolCalls（assistant 发起的工具调用）、ToolCallID/Name（role=tool 结果回传）
type aiChatMessage struct {
	Role       string       `json:"role"`
	Content    interface{}  `json:"content"`
	ToolCalls  []aiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
	Name       string       `json:"name,omitempty"`
}

// aiToolCall 模型返回的工具调用请求（阶段五十九：OpenAI 兼容 tool_calls 格式）
type aiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"` // JSON 字符串形式的参数
	} `json:"function"`
}

// aiToolDefinition OpenAI 兼容工具定义（阶段五十九：Agent Loop 注入模型的 tools 数组元素）
type aiToolDefinition struct {
	Type     string                 `json:"type"` // 固定 "function"
	Function map[string]interface{} `json:"function"`
}

// aiContentPart OpenAI 兼容多模态消息片段（阶段四十四：图片识别）
type aiContentPart struct {
	Type     string           `json:"type"` // "text" 或 "image_url"
	Text     string           `json:"text,omitempty"`
	ImageURL *aiImageURLField `json:"image_url,omitempty"`
}

type aiImageURLField struct {
	URL string `json:"url"` // 支持 data:image/xxx;base64,... 格式（服务端读盘转码，图片无需公网地址）
}

// aiUsage 模型响应 Token 消耗（OpenAI 兼容 usage 字段归口，随结束帧下发并随回复落库）
type aiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// aiNewStreamID 生成本次流式回复的关联 ID
func aiNewStreamID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ===== 阶段七十三：AI 流式问答停止归口（Trae CN 同款"停止"按钮）=====

// aiStreamStopEntry 活跃流停止句柄（streamID → 归属 + context 取消函数）
type aiStreamStopEntry struct {
	username string
	agent    string
	cancel   context.CancelFunc
}

var (
	aiStreamStopMu sync.Mutex
	aiStreamStops  = map[string]*aiStreamStopEntry{}
)

// aiStreamStopRegister 注册活跃流停止句柄（问答上下文建立时调用，含"思考中"检索阶段）
func aiStreamStopRegister(streamID, username, agent string, cancel context.CancelFunc) {
	aiStreamStopMu.Lock()
	aiStreamStops[streamID] = &aiStreamStopEntry{username: username, agent: agent, cancel: cancel}
	aiStreamStopMu.Unlock()
}

// aiStreamStopUnregister 注销停止句柄（问答协程退出统一调用）
func aiStreamStopUnregister(streamID string) {
	aiStreamStopMu.Lock()
	delete(aiStreamStops, streamID)
	aiStreamStopMu.Unlock()
}

// aiStreamStopTrigger 停止该用户对该智能体的全部活跃流（含"思考中"与流式输出中），
// 返回停止条数（0=无可停止流：已自然结束或他端已停止，请求方静默）。
// 取消后在锁外逐个触发，问答协程统一收口（已生成部分落库 + stopped 结束帧）
func aiStreamStopTrigger(username, agent string) int {
	aiStreamStopMu.Lock()
	var cancels []context.CancelFunc
	for id, e := range aiStreamStops {
		if e.username == username && e.agent == agent {
			cancels = append(cancels, e.cancel)
			delete(aiStreamStops, id)
		}
	}
	aiStreamStopMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	return len(cancels)
}

// handleAIStop 阶段七十三：停止正在进行的 AI 流式问答（上行 msg_type=59，to_user=智能体名）
// 仅中断模型流式调用，不产生错误提示；收口由问答协程负责（见 handleAIChatMsg 的 stopped 分支）
func (s *Server) handleAIStop(c *Client, msg *protocol.Message) {
	agent := strings.TrimSpace(msg.ToUser)
	if agent == "" {
		s.sendError(c, "缺少智能体名")
		return
	}
	aiStreamStopTrigger(c.username, agent)
}

// aiStreamChat 调用 OpenAI 兼容 chat/completions 流式接口（SSE），逐段回调增量文本，返回完整回复
// 与本次消耗的 Token 统计（stream_options.include_usage 请求归口，兼容服务无该字段时 usage 归零优雅降级）。
// provider 为 nil 时使用本地 Mock 应答（未配置模型服务的降级路径）
func aiStreamChat(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, onDelta func(string)) (string, aiUsage, error) {
	if agent.Provider == nil {
		reply := "我是 " + agent.Name + "（本地演示模式）。服务端尚未配置模型服务，请在 im-server/bin/config.yaml 的 ai 节点配置 providers（api_url/api_key/model）与 agents 后重启服务。"
		onDelta(reply)
		return reply, aiUsage{}, nil
	}

	// 视觉模型自动路由：消息中出现多模态 content 数组（带图提问）且配置了 vision_model 时，
	// 本次请求自动改用视觉模型，纯文本仍走主模型——同一智能体无需手动切换模型
	modelName := agent.Provider.Model
	for _, m := range msgs {
		if _, isText := m.Content.(string); !isText {
			if agent.Provider.VisionModel != "" {
				modelName = agent.Provider.VisionModel
				logger.Info("AI 视觉路由：智能体 %s 带图提问，使用视觉模型 %s", agent.Name, modelName)
			} else {
				logger.Warn("AI 视觉路由：智能体 %s 带图提问，但模型服务 %s 未配置视觉模型，仍使用主模型 %s（多模态内容可能被模型忽略）", agent.Name, agent.Provider.Name, modelName)
			}
			break
		}
	}

	body, err := json.Marshal(map[string]interface{}{
		"model":          modelName,
		"messages":       msgs,
		"stream":         true,
		"stream_options": map[string]interface{}{"include_usage": true},
	})
	if err != nil {
		return "", aiUsage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agent.Provider.APIURL, bytes.NewReader(body))
	if err != nil {
		return "", aiUsage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if agent.Provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+agent.Provider.APIKey)
	}

	resp, err := aiHTTP.Do(req)
	if err != nil {
		return "", aiUsage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", aiUsage{}, fmt.Errorf("AI 服务返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	// 解析 SSE 流：形如 "data: {...}"，终止帧 "data: [DONE]"；增量取 choices[0].delta.content，
	// usage 随末尾帧下发（include_usage），取到即记（无则保持零值，前端不显示）
	var full strings.Builder
	var usage aiUsage
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *aiUsage `json:"usage"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Usage != nil && chunk.Usage.TotalTokens > 0 {
			usage = *chunk.Usage
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			delta := chunk.Choices[0].Delta.Content
			full.WriteString(delta)
			onDelta(delta)
		}
	}
	if err := scanner.Err(); err != nil {
		return full.String(), usage, err
	}
	if full.Len() == 0 {
		return "", usage, fmt.Errorf("AI 服务未返回内容")
	}
	return full.String(), usage, nil
}

// aiAgentChat 阶段五十九：带工具定义的非流式对话调用（Agent Loop 决策专用）。
// 请求体携带 tools（OpenAI 兼容 function calling 格式），返回助手文本与工具调用请求列表；
// 未发起工具调用时 toolCalls 为空、content 即最终答复。
// provider 为 nil 时返回本地 Mock 应答（与聊天链路同款降级提示，Agent 无法执行任务）。
func aiAgentChat(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition) (string, []aiToolCall, error) {
	if agent.Provider == nil {
		reply := "本地演示模式：服务端尚未配置模型服务，智能 Agent 需要 function calling 能力的模型（如 deepseek/glm/gpt 等），请先在服务端配置 providers。"
		return reply, nil, nil
	}

	body := map[string]interface{}{
		"model":    agent.Provider.Model,
		"messages": msgs,
		"stream":   false,
	}
	// tools 为空时不携带该字段：后续提问建议复用本函数发起纯文本调用，部分上游对 "tools": null 报错
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	data, err := json.Marshal(body)
	if err != nil {
		return "", nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agent.Provider.APIURL, bytes.NewReader(data))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if agent.Provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+agent.Provider.APIKey)
	}

	resp, err := aiHTTP.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("AI 服务返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content   string       `json:"content"`
				ToolCalls []aiToolCall `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", nil, fmt.Errorf("AI 响应解析失败: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", nil, fmt.Errorf("AI 服务未返回内容")
	}
	msg := out.Choices[0].Message
	return msg.Content, msg.ToolCalls, nil
}

// aiAgentChatStream 阶段六十二：带工具定义的流式对话调用（Agent Loop 专用，Trae CN 同款打字机体验）。
// onText/onReasoning 分别回调可见正文与推理摘要增量（reasoning_content，仅推理模型才有）；
// 工具调用按 index 增量聚合（OpenAI 流式 tool_calls 分片下发），返回累计正文与完整调用列表。
// streamed 表示本轮是否产生过增量：上游不支持流式/一次性返回时为 false，调用方回退整段事件兼容。
func aiAgentChatStream(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition, onText, onReasoning func(string)) (string, []aiToolCall, bool, error) {
	if agent.Provider == nil {
		reply := "本地演示模式：服务端尚未配置模型服务，智能 Agent 需要 function calling 能力的模型（如 deepseek/glm/gpt 等），请先在服务端配置 providers。"
		if onText != nil {
			onText(reply)
		}
		return reply, nil, true, nil
	}

	body := map[string]interface{}{
		"model":          agent.Provider.Model,
		"messages":       msgs,
		"stream":         true,
		"stream_options": map[string]interface{}{"include_usage": true},
	}
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	data, err := json.Marshal(body)
	if err != nil {
		return "", nil, false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agent.Provider.APIURL, bytes.NewReader(data))
	if err != nil {
		return "", nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if agent.Provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+agent.Provider.APIKey)
	}

	resp, err := aiHTTP.Do(req)
	if err != nil {
		return "", nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		return "", nil, false, fmt.Errorf("AI 服务返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var content strings.Builder
	type accToolCall struct {
		id   string
		name string
		args strings.Builder
	}
	tcs := map[int]*accToolCall{}
	var order []int
	streamed := false

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		d := chunk.Choices[0].Delta
		if d.ReasoningContent != "" && onReasoning != nil {
			streamed = true
			onReasoning(d.ReasoningContent)
		}
		if d.Content != "" {
			streamed = true
			content.WriteString(d.Content)
			if onText != nil {
				onText(d.Content)
			}
		}
		for _, tc := range d.ToolCalls {
			acc := tcs[tc.Index]
			if acc == nil {
				acc = &accToolCall{}
				tcs[tc.Index] = acc
				order = append(order, tc.Index)
			}
			if tc.ID != "" {
				acc.id = tc.ID
			}
			if tc.Function.Name != "" {
				acc.name = tc.Function.Name
			}
			acc.args.WriteString(tc.Function.Arguments)
		}
	}
	if err := scanner.Err(); err != nil {
		return "", nil, streamed, err
	}

	var calls []aiToolCall
	for _, i := range order {
		acc := tcs[i]
		if acc.name == "" {
			continue
		}
		var c aiToolCall
		c.ID = acc.id
		c.Type = "function"
		c.Function.Name = acc.name
		c.Function.Arguments = acc.args.String()
		calls = append(calls, c)
	}
	return content.String(), calls, streamed, nil
}

// aiBuildContext 组装多轮对话上下文（服务端归口：按 用户+智能体 隔离取最近 N 条历史，他人不可见）
// 阶段八十五：消息时序固定为 系统提示 → [历史摘要] → 历史原文 → [知识库命中] → [长期记忆] → 本轮提问
// （稳定前缀在前、逐问易变内容在后，命中 OpenAI 兼容服务的隐式前缀缓存降低 prompt 计费，勿再前插易变内容）
// excludeID：排除指定消息（本次提问已先行落库回显，组装历史时排除防上下文重复）；0 表示不排除
// sessionID：阶段七十一多会话归口——仅取该会话盖戳的历史（0=默认会话存量全量；
// 新建会话即干净上下文，任意历史会话续聊即恢复该会话上下文）
// streamID：阶段八十四历史压缩提示帧关联（压缩触发时随帧下发"历史对话压缩中"，与流式回复同 ID）
// ctx：阶段八十四压缩摘要调用挂接停止句柄（"思考中/压缩中"阶段点停止同样即时生效）
func (s *Server) aiBuildContext(ctx context.Context, username string, agent *AIRunAgent, question string, excludeID uint, sessionID uint, streamID string) []aiChatMessage {
	msgs := make([]aiChatMessage, 0, aiContextWindow+4)
	if agent.SystemPrompt != "" {
		msgs = append(msgs, aiChatMessage{Role: "system", Content: agent.SystemPrompt})
	}
	var records []model.Message
	query := store.DB.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		2, username, agent.Name, agent.Name, username)
	// 阶段七十一：AI 多会话上下文归口——仅取本会话盖戳的历史（新建会话即干净上下文，
	// 避免单会话内容无界累积；0=默认会话，存量历史全量，老用户行为不变）
	query = query.Where("ai_session_id = ?", sessionID)
	if excludeID > 0 {
		query = query.Where("id <> ?", excludeID)
	}
	// 阶段八十四：压缩启用时额外回溯 aiCompressScanExtra 条更早历史（原窗口外滑走即丢 → 可进摘要长期保留）；
	// 未触发压缩时仍按原 aiContextWindow 窗口取尾，行为与 token 上界完全不变
	limit := aiContextWindow
	if aiCompressThreshold > 0 {
		limit += aiCompressScanExtra
	}
	query.Order("id DESC").Limit(limit).Find(&records)
	// 阶段八十四：TRAE 同款历史压缩——估算 token 超阈值时把较旧历史 LLM 摘要成一条消息，
	// 最近 aiCompressKeep 条保留原文（摘要按会话缓存增量合并，未触发/失败时行为与原窗口完全一致）
	records, summary := s.aiCompressHistory(ctx, username, agent, records, sessionID, streamID)
	if summary != "" {
		// 摘要消息时序：更早摘要 → 最近原文 → 本轮提问；role=user 紧随其后为原文历史，OpenAI 兼容格式允许
		msgs = append(msgs, aiChatMessage{Role: "user", Content: "[历史对话摘要（较早轮次已压缩归并）]\n" + summary})
	}
	for i := len(records) - 1; i >= 0; i-- {
		content := messageSummary(records[i].Content) // 引用信封取正文，JSON 原串不进模型上下文
		if content == "" {
			continue
		}
		role := "assistant"
		if records[i].FromUser == username {
			role = "user"
		}
		msgs = append(msgs, aiChatMessage{Role: role, Content: content})
	}
	// 阶段八十五：TRAE CN 同款"提示缓存友好"尾部注入——知识库命中与长期记忆是逐问变化的易变内容，
	// 原插在 system 之后/历史之前，会把"系统提示+摘要+历史"这段稳定前缀的隐式前缀缓存打穿
	// （DeepSeek/GLM/Kimi/硅基流动等 OpenAI 兼容服务按 messages 数组前缀命中缓存，命中部分约 1/10 计费，
	// 多轮追问时前缀逐问原样增长可反复命中）；移到历史之后、本轮提问之前，注入内容与 role 均不变，
	// 仅时序调整——语义无任何变化，长会话 prompt 计费显著下降
	// 原实现：仅注入智能体绑定的知识库（阶段五十一，个人库仅归属者生效；无命中/未配置时为空不注入）
	// 阶段五十六：合并用户勾选库（im_user_kb 归口，对所有智能体生效）；个人库命中仍由 kbSearch 权限过滤兜底
	// （2026-09-07 实测教训：注入调用曾被并行编辑还原为旧实现，导致私聊 AI 问答不注入用户勾选库，E2E 暴露后重新修复——勿删合并逻辑）
	if kbCtx := kbContextForAgent(kbMergeIDStrings(agent.KBIDs, kbUserSelectedIDs(username)), question, username); kbCtx != "" {
		msgs = append(msgs, aiChatMessage{Role: "system", Content: kbCtx})
	}
	// 阶段五十八：长期记忆注入（按 用户+智能体 隔离的向量召回，top_k 条；关闭/降级/无命中时为空不注入）
	if memCtx := memContextForAgent(agent, username, question); memCtx != "" {
		msgs = append(msgs, aiChatMessage{Role: "system", Content: memCtx})
	}
	msgs = append(msgs, aiChatMessage{Role: "user", Content: question})
	// 阶段八十五：组装结果估算日志（"提示占用过多"排查归口——与模型侧 usage 口径有粗估误差，仅供趋势观察）
	logger.Info("AI 上下文组装（%s/%s/sid=%d）：消息 %d 条，估算 prompt ≈ %d tokens", username, agent.Name, sessionID, len(msgs), aiMsgsEstimateTokens(msgs))
	return msgs
}

// aiCompressEntry 阶段八十四：会话历史摘要缓存条目（summary 覆盖到消息 ID <= uptoID 的全部历史）
type aiCompressEntry struct {
	Summary string
	UptoID  uint
}

// aiCompressHistory 阶段八十四：AI 问答历史压缩归口（TRAE 同款"历史对话压缩"）。
// 入参 records 为按 id DESC 拉取的本会话历史（含窗口外回溯）；行为分三档：
//  1. 估算 token < 阈值：返回原窗口尾部（aiContextWindow 条），与既有行为逐字节一致，零额外开销
//  2. 超阈值且摘要可生成：LLM 把"较旧部分"（剔除最近 aiCompressKeep 条原文）摘要为一条文本，
//     与缓存摘要增量合并（只摘要缓存未覆盖的新增段），缓存更新后返回 最近原文 + 摘要
//  3. 摘要失败（未配模型/网络异常）：回退原窗口尾部，不注入摘要（下一问重试）
//
// 返回值：实际参与上下文的原文历史 records + 非空 summary（调用方按 摘要→原文→提问 顺序注入）
func (s *Server) aiCompressHistory(ctx context.Context, username string, agent *AIRunAgent, records []model.Message, sessionID uint, streamID string) ([]model.Message, string) {
	rawTail := func() []model.Message {
		if len(records) > aiContextWindow {
			return records[len(records)-aiContextWindow:]
		}
		return records
	}
	if aiCompressThreshold <= 0 || agent == nil || agent.Provider == nil {
		return rawTail(), ""
	}
	total := 0
	for i := range records {
		total += aiEstimateTokens(records[i].Content)
	}
	if total < aiCompressThreshold {
		return rawTail(), "" // 未达阈值：原窗口行为不变
	}
	keep := aiCompressKeep
	if keep >= len(records) {
		return rawTail(), "" // 原文不足以让出时直接维持原样（阈值超得多时靠下一档兜底也无妨）
	}
	old := records[:len(records)-keep] // 待摘要的较旧段（按 id ASC 语义处理，存储序为 DESC）
	key := fmt.Sprintf("%d|%s|%s", sessionID, username, agent.Name)
	entry, _ := aiCompressCache.Load(key)
	var ent *aiCompressEntry
	if entry != nil {
		ent = entry.(*aiCompressEntry)
	}
	// 增量收集：只摘要缓存未覆盖（id > ent.UptoID）的段落；缓存已全覆盖则直接复用，零 LLM 调用
	segs := make([]string, 0, len(old))
	maxOldID := uint(0)
	for i := len(old) - 1; i >= 0; i-- { // id ASC 顺序转录
		if old[i].ID > maxOldID {
			maxOldID = old[i].ID
		}
		if ent != nil && old[i].ID <= ent.UptoID {
			continue
		}
		content := messageSummary(old[i].Content)
		if content == "" {
			continue
		}
		role := "用户"
		if old[i].FromUser != username {
			role = "AI"
		}
		segs = append(segs, role+"："+content)
	}
	prev := ""
	if ent != nil {
		prev = ent.Summary
	}
	summary := prev
	if len(segs) > 0 {
		s.aiPushCompressFrame(agent, username, streamID) // 提示帧先发（"历史对话压缩中"与思考中指示同屏期）
		summary = aiCompressSummarize(ctx, agent, prev, segs)
		if summary == "" {
			return rawTail(), "" // 摘要失败：回退原窗口，不注入
		}
		aiCompressMu.Lock()
		aiCompressCache.Store(key, &aiCompressEntry{Summary: summary, UptoID: maxOldID})
		aiCompressMu.Unlock()
	}
	kept := records[len(records)-keep:]
	logger.Info("AI 历史压缩触发（%s/%s/sid=%d）：摘要 %d 字，保留原文 %d 条", username, agent.Name, sessionID, len([]rune(summary)), len(kept))
	return kept, summary
}

// aiCompressSummarize 阶段八十四：LLM 摘要归口——把上一摘要与新增历史段合并为一份紧凑摘要
// （provider 未配置/调用失败返回空串；aiStreamChat 丢弃增量，不产生对用户的流式输出；
// ctx 为空时按独立超时上下文处理——Agent 任务路径无停止句柄可挂）
func aiCompressSummarize(ctx context.Context, agent *AIRunAgent, prevSummary string, segs []string) string {
	var b strings.Builder
	b.WriteString("你是即时通讯系统的对话上下文压缩器。请把提供的历史对话记录蒸馏为一份紧凑摘要，供 AI 在后续对话中作为较早历史的记忆使用。要求：\n" +
		"1. 保留关键事实、结论、决定、数字、文件/路径/命令及其结果、未解决的问题；\n" +
		"2. 合并重复内容，省略寒暄与无信息量语句；\n" +
		"3. 只输出摘要正文本身，使用中文，不要任何开场白或解释。")
	msgs := []aiChatMessage{{Role: "system", Content: b.String()}}
	var q strings.Builder
	if strings.TrimSpace(prevSummary) != "" {
		q.WriteString("[已有摘要]\n" + prevSummary + "\n\n")
	}
	q.WriteString("[新增历史记录]\n")
	for _, s := range segs {
		q.WriteString(s + "\n")
	}
	q.WriteString("\n请输出合并后的完整摘要。")
	msgs = append(msgs, aiChatMessage{Role: "user", Content: q.String()})
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), aiAskTimeout)
		defer cancel()
	}
	out, _, err := aiStreamChat(ctx, agent, msgs, func(string) {})
	if err != nil {
		logger.Error("AI 历史压缩摘要生成失败: %v", err)
		return ""
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return ""
	}
	if r := []rune(out); len(r) > aiCompressMaxOut { // 摘要自身失控膨胀兜底（保留头部）
		out = string(r[:aiCompressMaxOut]) + "…（摘要过长已截断）"
	}
	return out
}

// aiPushCompressFrame 阶段八十四：历史压缩状态帧（复用 AI_STREAM 通道，remark="compress" 区分；
// 前端在回复气泡正文上方渲染"历史对话压缩中"状态行，与联网搜索行同款交互，仅实时展示不落库）
func (s *Server) aiPushCompressFrame(agent *AIRunAgent, username, streamID string) {
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeAIStream,
		FromUser:  agent.Name,
		ToUser:    username,
		Content:   "{}",
		Remark:    "compress",
		StreamID:  streamID,
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(msg)
	s.sendToUser(username, out)
}

// aiEstimateTokens 阶段八十四：token 粗估归口——CJK/全角区约 1 字符 1 token，其余约 4 字符 1 token
// （压缩触发判据仅用粗估，无需精确分词；误差由阈值余量吸收）
func aiEstimateTokens(s string) int {
	cjk, other := 0, 0
	for _, r := range s {
		if r > 0x2E7F { // CJK 统一表意、扩展、全角标点、假名等宽字符区粗归一类
			cjk++
		} else {
			other++
		}
	}
	return cjk + other/4
}

// aiChatMsgText 阶段八十四：消息文本化归口（Content 通常为 string；多模态数组等结构化内容
// 序列化为 JSON 计入估算/转录，保证压缩判据不漏算）
func aiChatMsgText(m aiChatMessage) string {
	if v, ok := m.Content.(string); ok {
		return v
	}
	b, err := json.Marshal(m.Content)
	if err != nil {
		return ""
	}
	return string(b)
}

// aiMsgsEstimateTokens 阶段八十四：一组消息的 token 粗估（role 标签一并计入）
func aiMsgsEstimateTokens(msgs []aiChatMessage) int {
	total := 0
	for i := range msgs {
		total += aiEstimateTokens(msgs[i].Role) + aiEstimateTokens(aiChatMsgText(msgs[i]))
	}
	return total
}

// handleAIAgents 下发 AI 智能体列表（服务端归口：仅下发名称/头像/模型名/图片能力标记，不下发任何密钥）
func (s *Server) handleAIAgents(c *Client, _ *protocol.Message) {
	// 阶段五十七：按请求者视角下发（公共智能体 + 该用户自建的个人智能体）
	data, _ := json.Marshal(aiAgentsPublicInfo(c.username))
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeAIAgents,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(resp)
	c.send(out)
}

// aiAgentsPublicInfo 构建对外下发的智能体公开信息列表（原实现内联于 handleAIAgents，
// 现抽归口函数供消息下发与后台变更广播共用，保证两链路格式一致）
// 阶段五十七：按视角过滤——公共智能体（Owner 空）全员可见，个人智能体仅归属者可见；不下发任何密钥
func aiAgentsPublicInfo(username string) []map[string]interface{} {
	list := make([]map[string]interface{}, 0)
	for _, a := range aiAgentList() {
		if a.Owner != "" && a.Owner != username {
			continue
		}
		modelName := ""
		if a.Provider != nil {
			modelName = a.Provider.Model
		}
		list = append(list, map[string]interface{}{
			// 阶段五十八：下发 DB ID（前端据此调用记忆管理接口 /api/agents/{id}/memory）
			"id":     a.ID,
			"name":   a.Name,
			"avatar": a.Avatar,
			"model":  modelName,
			"image":  a.SupportsImage,
			// 阶段五十七：个人标记（前端据此显示"个人"小标与管理入口）
			"owner": a.Owner,
			// 阶段六十九：服务端联网搜索开关（前端据此显隐普通聊天联网按钮，配置全局归口）
			"web_search": agentSearchEnabled.Load(),
		})
	}
	return list
}

// aiImageEnvelope 阶段四十四：AI 图片提问信封（前端经 /upload/ai/image 上传后发送）
type aiImageEnvelope struct {
	Image string `json:"image"` // 服务端静态资源 URL（/static/upload/xxx）
	Text  string `json:"text"`  // 附言（可为空）
}

// parseAIImageEnvelope 解析 AI 图片提问信封（非图片提问返回 nil）
func parseAIImageEnvelope(content string) *aiImageEnvelope {
	var env aiImageEnvelope
	if err := json.Unmarshal([]byte(content), &env); err != nil || env.Image == "" {
		return nil
	}
	return &env
}

// aiDocEnvelope 阶段四十五：AI 文档问答信封（前端经 /upload/ai/doc 上传后发送）
// 服务端归口：提问时按 url 重新解析落盘文档提取文本，文档正文不经过前端
type aiDocEnvelope struct {
	Doc  string `json:"doc"`  // 服务端静态资源 URL（/static/upload/xxx，扩展名决定解析器）
	Name string `json:"name"` // 原始文件名（会话摘要/回显展示用）
	Text string `json:"text"` // 附言（可为空）
}

// parseAIDocEnvelope 解析 AI 文档问答信封（非文档提问返回 nil）
func parseAIDocEnvelope(content string) *aiDocEnvelope {
	var env aiDocEnvelope
	if err := json.Unmarshal([]byte(content), &env); err != nil || env.Doc == "" {
		return nil
	}
	return &env
}

// aiImageMimeByExt 按扩展名返回 data URL 的 MIME（仅允许常见图片格式）
func aiImageMimeByExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	}
	return ""
}

// aiLoadImageDataURL 阶段四十四：读取服务端已上传图片并转为 base64 data URL（多模态接口无需公网地址）。
// 路径安全：仅接受 /static/upload/ 下的纯文件名，杜绝目录穿越
func (s *Server) aiLoadImageDataURL(url string) (string, error) {
	const prefix = "/static/upload/"
	if !strings.HasPrefix(url, prefix) {
		return "", fmt.Errorf("图片路径不合法")
	}
	name := strings.TrimPrefix(url, prefix)
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", fmt.Errorf("图片路径不合法")
	}
	dotIdx := strings.LastIndex(name, ".")
	if dotIdx < 0 {
		return "", fmt.Errorf("不支持的图片格式")
	}
	mime := aiImageMimeByExt(name[dotIdx:])
	if mime == "" {
		return "", fmt.Errorf("不支持的图片格式")
	}
	// 与 uploadfile.go 的目录归口保持一致（UploadDir 配置优先，兜底 WebDir/static/upload）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	data, err := os.ReadFile(filepath.Join(dir, filepath.Base(name)))
	if err != nil {
		return "", fmt.Errorf("图片文件不存在或已清理")
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// handleAIChatMsg 阶段四十三：AI 问答（流式）——每人按 用户+智能体 隔离，多轮上下文，逐段推送实现打字机效果
// 阶段四十四：content 为图片信封 JSON（{"image":url,"text":附言}）时走多模态链路，模型不支持图片直接拒绝
func (s *Server) handleAIChatMsg(c *Client, msg *protocol.Message) {
	// 原实现：agent := aiAgentByName(strings.TrimSpace(msg.ToUser))（阶段五十七起走权限归口，个人智能体仅归属者可对话）
	agent := aiAgentForUser(strings.TrimSpace(msg.ToUser), c.username)
	if agent == nil {
		s.sendError(c, "AI 助手不存在或已被移除")
		return
	}

	// 阶段七十一：多会话归属校验（上行 session_id 指定目标会话，0=默认会话；
	// 非法 id 拒绝，防协议直发把消息盖到他人/不存在的会话）
	sid := msg.SessionID
	if !aiSessionValidate(c.username, agent.Name, sid) {
		s.sendError(c, "会话不存在或已被删除")
		return
	}

	// 阶段七十八：积分余额校验（TRAE CN 同款问答积分）——余额 <= 0 拦截提问，
	// 仅拦 AI 问答，聊天其余功能不受影响；前端经 toast 提示
	if balance, err := userPoints(c.username); err != nil {
		logger.Error("积分余额查询失败（用户 %s）：%v", c.username, err)
		s.sendError(c, "积分查询失败，请稍后重试")
		return
	} else if balance <= 0 {
		s.sendError(c, "积分不足，无法进行 AI 问答，请联系管理员充值")
		return
	}

	// 阶段四十四：图片提问信封解析（引用信封之外的另一类 JSON content）
	var imageEnv *aiImageEnvelope
	if env := parseAIImageEnvelope(msg.Content); env != nil {
		imageEnv = env
	}

	// 阶段四十五：文档问答信封解析（与图片信封互斥：image/doc 字段不同时存在）
	var docEnv *aiDocEnvelope
	if imageEnv == nil {
		if env := parseAIDocEnvelope(msg.Content); env != nil {
			docEnv = env
		}
	}

	// 问题文本：引用信封取正文（阶段四十同款归口），JSON 原串不发给模型
	question := strings.TrimSpace(messageSummary(msg.Content))
	if imageEnv != nil {
		// 阶段四十四：图片提问发给模型的指令用附言原文（messageSummary 的 "[图片] " 前缀仅用于会话摘要，
		// 不应混入模型指令）；无附言时给默认指令（图是必要输入，不按空消息拦截）
		question = strings.TrimSpace(imageEnv.Text)
		if question == "" {
			question = "请描述并分析这张图片"
		}
	}
	if docEnv != nil {
		// 阶段四十五：文档提问发给模型的指令用附言原文；无附言时给默认指令（文档是必要输入，不按空消息拦截）
		question = strings.TrimSpace(docEnv.Text)
		if question == "" {
			question = "请总结这份文档的核心内容"
		}
	}
	if question == "" {
		s.sendError(c, "不能发送空消息")
		return
	}

	// 阶段六十九：普通聊天联网搜索开关（前端经上行 remark="web_search" 传递；服务端配置未开启时
	// 静默降级为普通问答，配置归口与 Agent 任务共用 agentSearchEnabled）
	useSearch := msg.Remark == "web_search" && agentSearchEnabled.Load()

	// 阶段四十四：图片能力双保险校验（前端入口已隐藏，此处兜底防止协议直发绕过）
	if imageEnv != nil {
		if agent.Provider == nil || !agent.SupportsImage {
			s.sendError(c, "该助手不支持图片识别，请选择标注「支持图片」的助手")
			return
		}
	}

	// 阶段四十五：文档问答——服务端归口解析落盘文档提取文本（文档正文不经过前端，
	// 前端仅持有 URL），限流前先解析，文档非法/不存在时快速失败不消耗提问额度。
	// 文档解析不依赖多模态能力：提取文本注入提示词，纯文本模型同样可答
	var docPrompt string
	if docEnv != nil {
		text, err := s.aiLoadDocText(docEnv.Doc)
		if err != nil {
			s.sendError(c, err.Error())
			return
		}
		docPrompt = aiBuildDocPrompt(docEnv.Name, text, question)
	}

	// 限流：单用户窗口内最多 aiLimitCount 次（Redis 计数，多端共享额度）
	ctx := context.Background()
	limitKey := aiLimitKey + c.username
	count, _ := store.RDB.Incr(ctx, limitKey).Result()
	if count == 1 {
		store.RDB.Expire(ctx, limitKey, aiLimitWindow)
	}
	if count > int64(aiLimitCount) {
		s.sendError(c, "AI 提问过于频繁，请稍后再试")
		return
	}

	// 阶段四十四：图片提问数据加载（本地文件读 + base64，快速操作；失败直接报错不落库）
	var imageDataURL string
	if imageEnv != nil {
		dataURL, err := s.aiLoadImageDataURL(imageEnv.Image)
		if err != nil {
			s.sendError(c, err.Error())
			return
		}
		imageDataURL = dataURL
	}

	// 提问先落库并立即回显：用户消息秒级上屏（原实现先做知识库/记忆向量检索再回显，
	// embedding API 网络慢时自己发的提问要等数秒才显示；回显/思考中应在提问瞬间出现）
	// 落库 is_read=true：AI 会话无已读回执语义，避免自己发的提问永远显示"未读"
	record := model.Message{
		MsgType:     2,
		FromUser:    c.username,
		ToUser:      agent.Name,
		Content:     msg.Content,
		IsRead:      true,
		AISessionID: sid, // 阶段七十一：消息级会话盖戳（0=默认会话）
	}
	store.DB.Create(&record)
	// 阶段七十一：占位标题会话以首问生成标题（服务端归口）
	aiSessionAutoTitle(c.username, agent.Name, sid, question)

	// 回显提问给自己全部在线连接（复用私聊渲染链路，多端同步）
	// IsRead=true 随帧下发：AI 会话无回执语义，与落库口径一致，客户端直接显示"已读"；
	// SessionID 随帧下发：多端按会话归属过滤渲染（他端在其他会话的提问不串入本端视图）
	echo := protocol.Message{
		MsgType:   protocol.MsgTypePrivate,
		FromUser:  c.username,
		ToUser:    agent.Name,
		Content:   msg.Content,
		MsgID:     record.ID,
		SessionID: sid,
		IsRead:    true,
		Timestamp: time.Now().Unix(),
	}
	echoData, _ := json.Marshal(echo)
	s.sendToUser(c.username, echoData)

	// 会话摘要归口（会话列表显示提问正文并排序置顶）
	s.touchConversation(c.username, agent.Name, messageSummary(msg.Content))
	s.notifyConvUpdate(c.username)

	// 再组装上下文（此时本次提问已落库，按 excludeID 排除防上下文重复）：
	// 知识库命中与长期记忆均为向量检索（embedding API 调用），耗时随网络波动，
	// 放在回显之后——用户先看到自己的消息和"思考中"，模型首字延迟不受影响
	// 阶段七十三：停止句柄在此处（检索阶段开始前）即注册——"思考中"阶段同样可停止，
	// 避免 embedding 检索耗时期间点停止无效的死区；问答协程退出时注销
	streamID := aiNewStreamID()
	askCtx, cancelAsk := context.WithTimeout(context.Background(), aiAskTimeout)
	aiStreamStopRegister(streamID, c.username, agent.Name, cancelAsk)

	chatMsgs := s.aiBuildContext(askCtx, c.username, agent, question, record.ID, sid, streamID)

	// 阶段四十四：图片提问——最后一条 user 消息替换为多模态 content 数组（文本 + base64 图片）
	if imageDataURL != "" {
		chatMsgs[len(chatMsgs)-1].Content = []aiContentPart{
			{Type: "text", Text: question},
			{Type: "image_url", ImageURL: &aiImageURLField{URL: imageDataURL}},
		}
	}

	// 阶段四十五：文档提问——最后一条 user 消息替换为文档全文信封 + 附言（纯文本注入，任意文本模型可答）
	if docEnv != nil {
		chatMsgs[len(chatMsgs)-1].Content = docPrompt
	}

	// 异步调用模型流式接口，避免阻塞 WebSocket 主调度
	go func() {
		// 阶段七十三：协程退出统一收口（注销停止句柄 + 释放超时上下文）
		defer cancelAsk()
		defer aiStreamStopUnregister(streamID)
		// 已推送增量累计（服务端侧留档口径）：正常完成时与 aiStreamChat 返回值一致；
		// 用户停止（context.Canceled）时按它落库已生成部分（联网搜索循环链路自身不返回部分内容）
		var pushed strings.Builder
		pushDelta := func(delta string) {
			pushed.WriteString(delta)
			chunk := protocol.Message{
				MsgType:   protocol.MsgTypeAIStream,
				FromUser:  agent.Name,
				ToUser:    c.username,
				Content:   delta,
				StreamID:  streamID,
				SessionID: sid, // 阶段七十一：流帧携带会话归属，客户端按会话过滤渲染
				Timestamp: time.Now().Unix(),
			}
			data, _ := json.Marshal(chunk)
			// 推送增量到用户全部在线连接（多端同步打字机效果）
			s.sendToUser(c.username, data)
		}
		var full string
		var usage aiUsage
		var err error
		if useSearch {
			// 阶段六十九：联网问答循环（模型按需调用 web_search 后作答）
			full, usage, err = s.aiChatLoopWithSearch(askCtx, agent, c.username, chatMsgs, streamID, pushDelta)
		} else {
			full, usage, err = aiStreamChat(askCtx, agent, chatMsgs, pushDelta)
		}
		if err != nil {
			// 阶段七十三：用户主动停止（Trae 同款）——已生成部分落库留档（无则不落库），
			// 结束帧 remark="stopped" 前端收尾气泡；不报错、不提取记忆（部分回答不进长期记忆）
			if errors.Is(err, context.Canceled) {
				partial := pushed.String()
				var msgID uint
				if strings.TrimSpace(partial) != "" {
					reply := model.Message{
						MsgType:     2,
						FromUser:    agent.Name,
						ToUser:      c.username,
						Content:     partial,
						IsRead:      false,
						AISessionID: sid, // 与提问同会话盖戳，问答成对归位
					}
					store.DB.Create(&reply)
					msgID = reply.ID
					s.touchConversation(c.username, agent.Name, messageSummary(partial))
					s.notifyConvUpdate(c.username)
				}
				endMsg := protocol.Message{
					MsgType:   protocol.MsgTypeAIStreamEnd,
					FromUser:  agent.Name,
					ToUser:    c.username,
					Content:   partial,
					MsgID:     msgID,
					StreamID:  streamID,
					SessionID: sid,
					Remark:    "stopped",
					Timestamp: time.Now().Unix(),
				}
				data, _ := json.Marshal(endMsg)
				s.sendToUser(c.username, data)
				logger.Info("AI 问答被用户停止（用户 %s，智能体 %s，已生成 %d 字）", c.username, agent.Name, len([]rune(partial)))
				return
			}
			logger.Error("AI 问答失败（用户 %s，智能体 %s）：%v", c.username, agent.Name, err)
			s.sendError(c, "AI 服务异常，请稍后重试")
			// 结束帧（error 标记）：前端移除打字中的气泡
			endMsg := protocol.Message{
				MsgType:   protocol.MsgTypeAIStreamEnd,
				FromUser:  agent.Name,
				ToUser:    c.username,
				StreamID:  streamID,
				SessionID: sid,
				Remark:    "error",
				Timestamp: time.Now().Unix(),
			}
			data, _ := json.Marshal(endMsg)
			s.sendToUser(c.username, data)
			return
		}

		// 完整回复落库（is_read=false：计入会话未读，多端打开会话后由回执归口清除）
		// Token 消耗随回复落库（服务端 usage 归口，历史加载同样可显示）；
		// 回复与提问同会话盖戳（闭包捕获 sid），保证问答成对归位
		reply := model.Message{
			MsgType:          2,
			FromUser:         agent.Name,
			ToUser:           c.username,
			Content:          full,
			PromptTokens:     usage.PromptTokens,
			CompletionTokens: usage.CompletionTokens,
			TotalTokens:      usage.TotalTokens,
			AISessionID:      sid,
		}
		store.DB.Create(&reply)
		s.touchConversation(c.username, agent.Name, messageSummary(full))
		s.notifyConvUpdate(c.username)

		// 阶段五十八：异步记忆提取（有界队列，满则丢弃本轮；仅私聊，群聊不提取）
		memEnqueueExtract(agent, c.username, question, full)

		// 阶段七十八：问答成功完成才扣积分（失败/停止路径已在上方 return，不扣分即"失败自动退还"）；
		// 按 usage 折算（1000 tokens = 1 积分，双精度保留 3 位小数如 4506 tokens = 4.506，
		// 无 usage 按最低 1 积分），余额钳制非负；
		// 扣后余额随结束帧下发，PC 端标题栏 ⚡ 积分实时刷新（服务端归口，客户端不做任何积分计算）；
		// 指针携带：扣分成功才置值（余额为 0 也会下发），nil=扣分失败时前端保持旧值
		cost := aiPointsCost(usage.TotalTokens)
		var balancePtr *float64
		if balance, err := userPointsDeduct(c.username, cost); err != nil {
			// 扣分失败不阻断回复展示（回复已落库），仅记日志便于对账
			logger.Error("积分扣除失败（用户 %s，消耗 %d tokens）：%v", c.username, usage.TotalTokens, err)
		} else {
			balancePtr = &balance
			logger.Info("积分扣除（用户 %s，- %.3f 积分，%d tokens，余额 %.3f）", c.username, cost, usage.TotalTokens, balance)
			// 阶段七十八：流水审计（AI 问答扣除，操作人 system）
			recordPointsLog(c.username, -cost, balance, "ai_deduct", "system",
				fmt.Sprintf("AI 问答（智能体 %s）消耗 %d tokens，按 1000 tokens = 1 积分折算（保留 3 位小数）", agent.Name, usage.TotalTokens))
		}

		endMsg := protocol.Message{
			MsgType:          protocol.MsgTypeAIStreamEnd,
			FromUser:         agent.Name,
			ToUser:           c.username,
			Content:          full,
			MsgID:            reply.ID,
			StreamID:         streamID,
			SessionID:        sid, // 阶段七十一：流帧携带会话归属，客户端按会话过滤渲染
			PromptTokens:     usage.PromptTokens,
			CompletionTokens: usage.CompletionTokens,
			TotalTokens:      usage.TotalTokens,
			PointsBalance:    balancePtr, // 阶段七十八：扣后余额（nil=扣分失败，前端保持旧值）
			Timestamp:        time.Now().Unix(),
		}
		data, _ := json.Marshal(endMsg)
		s.sendToUser(c.username, data)
		logger.Info("AI 回复用户 %s（智能体 %s，%d 字，tokens：%d 提问/%d 生成/%d 共）", c.username, agent.Name, len([]rune(full)), usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens)

		// 阶段六十二：后续提问建议（Trae CN 同款）——结束帧先行下发（回复立即收尾），
		// 建议异步生成后经独立帧推送，浮现稍晚不阻塞交互；失败静默无建议
		go func() {
			sugs := aiGenerateSuggestions(agent, question, full)
			if len(sugs) == 0 {
				return
			}
			payload, _ := json.Marshal(sugs)
			sugMsg := protocol.Message{
				MsgType:   protocol.MsgTypeAISuggest,
				FromUser:  agent.Name,
				ToUser:    c.username,
				Content:   string(payload),
				Timestamp: time.Now().Unix(),
			}
			sugData, _ := json.Marshal(sugMsg)
			s.sendToUser(c.username, sugData)
		}()
	}()
}

// ===== 阶段六十九：普通聊天联网问答（输入框联网开关开启时，模型按需调用 web_search 后作答） =====

// aiSearchLoopMaxRounds 普通聊天联网问答最大工具轮数（轻量问答场景，远少于 Agent 任务的 agentMaxSteps；
// 达到上限后不再注入工具，强制模型基于已有信息作答防死循环）
const aiSearchLoopMaxRounds = 4

// aiChatLoopWithSearch 普通聊天联网问答循环：复用 aiAgentChatStream 流式接口与 agentToolWebSearch
// 执行归口（只读免审批、始终服务端执行）。仅注入 web_search 单工具（普通聊天轻量问答，不开放
// 文件/命令等 Agent 工具）；每轮工具调用经 aiPushToolFrame 推送搜索状态帧供前端渲染「联网搜索」行。
// 注意：流式链路不返回 usage（与 Agent 任务一致），联网问答的 Token 统计记 0。
func (s *Server) aiChatLoopWithSearch(ctx context.Context, agent *AIRunAgent, username string, msgs []aiChatMessage, streamID string, onText func(string)) (string, aiUsage, error) {
	var usage aiUsage
	tools := []aiToolDefinition{agentWebSearchToolDef()}
	for round := 0; ; round++ {
		var useTools []aiToolDefinition
		if round < aiSearchLoopMaxRounds {
			useTools = tools
		}
		content, toolCalls, _, err := aiAgentChatStream(ctx, agent, msgs, useTools, onText, nil)
		if err != nil {
			return "", usage, err
		}
		// 无工具调用：模型给出最终答复（正文已流式推送，usage 不可得记 0）
		if len(toolCalls) == 0 {
			return content, usage, nil
		}
		// assistant 消息（含 tool_calls）入历史，后续 tool 结果按 tool_call_id 对应回传
		msgs = append(msgs, aiChatMessage{Role: "assistant", Content: content, ToolCalls: toolCalls})
		for _, tc := range toolCalls {
			var result string
			meta := map[string]interface{}{"tool": tc.Function.Name, "ok": false, "query": "", "results": 0}
			if tc.Function.Name != "web_search" {
				// 普通聊天仅开放搜索：模型误调其它工具时回传错误文本，模型据此自纠
				result = "错误：普通聊天模式仅支持联网搜索工具"
			} else {
				var params map[string]interface{}
				if strings.TrimSpace(tc.Function.Arguments) != "" {
					if err := json.Unmarshal([]byte(tc.Function.Arguments), &params); err != nil {
						params = nil // 非法参数按缺参处理，工具内部报错回传模型自纠
					}
				}
				result = agentToolWebSearch(params)
				meta["ok"] = !strings.HasPrefix(result, "错误")
				meta["query"] = agentParamString(params["query"])
				meta["results"] = strings.Count(result, "链接：") // agentSearchFormat 固定格式计数
			}
			s.aiPushToolFrame(agent, username, streamID, meta)
			msgs = append(msgs, aiChatMessage{Role: "tool", Content: result, ToolCallID: tc.ID, Name: tc.Function.Name})
		}
	}
}

// aiPushToolFrame 普通聊天搜索状态帧推送（复用 AI_STREAM 通道，remark="tool" 区分正文增量；
// content 为 JSON {tool,ok,query,results}，仅实时展示不落库）
func (s *Server) aiPushToolFrame(agent *AIRunAgent, username, streamID string, meta map[string]interface{}) {
	data, _ := json.Marshal(meta)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeAIStream,
		FromUser:  agent.Name,
		ToUser:    username,
		Content:   string(data),
		Remark:    "tool",
		StreamID:  streamID,
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(msg)
	s.sendToUser(username, out)
}

// aiGenerateSuggestions 生成后续提问建议：仅用最后一轮问答做轻量调用（不重发整套上下文，控制成本），
// 15s 超时/失败静默返回空（建议属增强体验，不因它报错打扰用户）
func aiGenerateSuggestions(agent *AIRunAgent, question, reply string) []string {
	if agent.Provider == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	replyCut := reply
	if r := []rune(replyCut); len(r) > 800 {
		replyCut = string(r[:800])
	}
	prompt := "基于下面这轮用户与AI助手的问答，提出3个用户最可能继续追问的问题。\n" +
		"要求：每条不超过20个字、口语化、可直接作为用户下一条消息发送；只输出JSON字符串数组（示例：[\"问题1\",\"问题2\",\"问题3\"]），不要输出任何其他内容。\n\n" +
		"用户提问：" + question + "\n\n助手回复：" + replyCut
	out, _, err := aiAgentChat(ctx, agent, []aiChatMessage{{Role: "user", Content: prompt}}, nil)
	if err != nil {
		return nil
	}
	return aiParseSuggestions(out)
}

// aiParseSuggestions 解析建议输出：优先按 JSON 数组解析，失败降级按行拆；
// 过滤空/超长项（>40 字视为非短问题），最多保留 3 条
func aiParseSuggestions(out string) []string {
	out = strings.TrimSpace(out)
	var arr []string
	if strings.HasPrefix(out, "[") {
		if err := json.Unmarshal([]byte(out), &arr); err != nil {
			arr = nil
		}
	}
	if arr == nil {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			line = strings.Trim(line, "-*•>、）)\"“”0123456789. ")
			if line != "" {
				arr = append(arr, line)
			}
		}
	}
	res := make([]string, 0, 3)
	for _, s := range arr {
		s = strings.TrimSpace(s)
		n := len([]rune(s))
		if n < 2 || n > 40 {
			continue
		}
		res = append(res, s)
		if len(res) >= 3 {
			break
		}
	}
	return res
}

// handleGroupAI 群聊 @AI助手 唤醒应答（阶段四十三：改用配置的模型服务，取第一个智能体的人设与非流式整段回复）
func (s *Server) handleGroupAI(c *Client, msg *protocol.Message) {
	// 仅当消息以 @AI助手 开头时触发
	content := strings.TrimSpace(msg.Content)
	if !strings.HasPrefix(content, "@"+AIBotName) {
		return
	}
	question := strings.TrimSpace(strings.TrimPrefix(content, "@"+AIBotName))
	if question == "" {
		return
	}
	agent := aiAgentList()[0] // 阶段四十九：读锁快照取首个智能体（原实现直读全局切片）

	// 异步调用 AI 并在群聊回复
	go func() {
		askCtx, cancel := context.WithTimeout(context.Background(), aiAskTimeout)
		defer cancel()
		promptMsgs := make([]aiChatMessage, 0, 2)
		if agent.SystemPrompt != "" {
			promptMsgs = append(promptMsgs, aiChatMessage{Role: "system", Content: agent.SystemPrompt})
		}
		// 原实现：仅注入智能体绑定的知识库（阶段五十一，群聊 @AI 助手按提问者权限过滤个人库）
		// if kbCtx := kbContextForAgent(agent.KBIDs, question, c.username); kbCtx != "" {
		// 阶段五十六：合并用户勾选库（im_user_kb 归口，群聊 @AI 同样生效，个人库按提问者权限过滤）
		if kbCtx := kbContextForAgent(kbMergeIDStrings(agent.KBIDs, kbUserSelectedIDs(c.username)), question, c.username); kbCtx != "" {
			promptMsgs = append(promptMsgs, aiChatMessage{Role: "system", Content: kbCtx})
		}
		promptMsgs = append(promptMsgs, aiChatMessage{Role: "user", Content: question})
		reply, usage, err := aiStreamChat(askCtx, agent, promptMsgs, func(string) {}) // 群聊场景整段回复，增量丢弃
		if err != nil {
			logger.Error("群聊 AI 应答失败（用户 %s）：%v", c.username, err)
			return
		}
		reply = "@" + c.username + " " + reply

		record := model.Message{
			MsgType:          int8(protocol.MsgTypeGroupChat),
			FromUser:         AIBotName,
			ToUser:           "",
			Content:          reply,
			PromptTokens:     usage.PromptTokens,
			CompletionTokens: usage.CompletionTokens,
			TotalTokens:      usage.TotalTokens,
		}
		store.DB.Create(&record)

		resp := protocol.Message{
			MsgType:   protocol.MsgTypeGroupChat,
			FromUser:  AIBotName,
			Content:   reply,
			MsgID:     record.ID,
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(resp)
		s.hub.Broadcast(data)
	}()
}
