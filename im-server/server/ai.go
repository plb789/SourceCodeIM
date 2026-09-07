package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	Name         string
	SystemPrompt string
	Avatar       string
	Provider     *config.AIProviderConfig // nil 表示未绑定可用模型服务，使用本地 Mock 应答
	// SupportsImage 绑定的模型是否支持图片识别（阶段四十四：继承 provider 配置归口）
	SupportsImage bool
	// KBIDs 阶段五十一：绑定的知识库 ID 列表（逗号分隔字符串，空=不启用 RAG 检索注入；
	// 个人库仅归属者对话时参与检索，权限过滤归口 kbSearch）
	KBIDs string
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
			SupportsImage: p.SupportsImage,
		}
	}

	newIndex := make(map[string]*AIRunAgent)
	newList := make([]*AIRunAgent, 0, len(agents))
	for _, a := range agents {
		if strings.TrimSpace(a.Name) == "" {
			continue
		}
		ra := &AIRunAgent{Name: a.Name, SystemPrompt: a.SystemPrompt, Avatar: a.Avatar, KBIDs: a.KBIDs}
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
func aiAgentByName(name string) *AIRunAgent {
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiAgentIndex[name]
}

// aiAgentList 运行时智能体列表快照（读锁保护，后台广播与列表下发归口）
func aiAgentList() []*AIRunAgent {
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiAgents
}

// aiChatMessage OpenAI 兼容对话消息
// 阶段四十四：Content 改为 interface{}——纯文本消息为 string，多模态消息为 []aiContentPart 数组
type aiChatMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
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

// aiNewStreamID 生成本次流式回复的关联 ID
func aiNewStreamID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// aiStreamChat 调用 OpenAI 兼容 chat/completions 流式接口（SSE），逐段回调增量文本，返回完整回复。
// provider 为 nil 时使用本地 Mock 应答（未配置模型服务的降级路径）
func aiStreamChat(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, onDelta func(string)) (string, error) {
	if agent.Provider == nil {
		reply := "我是 " + agent.Name + "（本地演示模式）。服务端尚未配置模型服务，请在 im-server/bin/config.yaml 的 ai 节点配置 providers（api_url/api_key/model）与 agents 后重启服务。"
		onDelta(reply)
		return reply, nil
	}

	body, err := json.Marshal(map[string]interface{}{
		"model":    agent.Provider.Model,
		"messages": msgs,
		"stream":   true,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, agent.Provider.APIURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if agent.Provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+agent.Provider.APIKey)
	}

	resp, err := aiHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("AI 服务返回 %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	// 解析 SSE 流：形如 "data: {...}"，终止帧 "data: [DONE]"；增量取 choices[0].delta.content
	var full strings.Builder
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
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			delta := chunk.Choices[0].Delta.Content
			full.WriteString(delta)
			onDelta(delta)
		}
	}
	if err := scanner.Err(); err != nil {
		return full.String(), err
	}
	if full.Len() == 0 {
		return "", fmt.Errorf("AI 服务未返回内容")
	}
	return full.String(), nil
}

// aiBuildContext 组装多轮对话上下文（服务端归口：按 用户+智能体 隔离取最近 N 条历史，他人不可见）
func (s *Server) aiBuildContext(username string, agent *AIRunAgent, question string) []aiChatMessage {
	msgs := make([]aiChatMessage, 0, aiContextWindow+2)
	if agent.SystemPrompt != "" {
		msgs = append(msgs, aiChatMessage{Role: "system", Content: agent.SystemPrompt})
	}
	// 阶段五十一：RAG 知识库检索注入（agent 绑定库归口，个人库仅归属者生效；无命中/未配置时为空不注入）
	if kbCtx := kbContextForAgent(agent.KBIDs, question, username); kbCtx != "" {
		msgs = append(msgs, aiChatMessage{Role: "system", Content: kbCtx})
	}
	var records []model.Message
	store.DB.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		2, username, agent.Name, agent.Name, username).
		Order("id DESC").Limit(aiContextWindow).Find(&records)
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
	msgs = append(msgs, aiChatMessage{Role: "user", Content: question})
	return msgs
}

// handleAIAgents 下发 AI 智能体列表（服务端归口：仅下发名称/头像/模型名/图片能力标记，不下发任何密钥）
func (s *Server) handleAIAgents(c *Client, _ *protocol.Message) {
	data, _ := json.Marshal(aiAgentsPublicInfo())
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeAIAgents,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(resp)
	c.send(out)
}

// aiAgentsPublicInfo 阶段四十九：构建对外下发的智能体公开信息列表（原实现内联于 handleAIAgents，
// 现抽归口函数供消息下发与后台变更广播共用，保证两链路格式一致）
func aiAgentsPublicInfo() []map[string]interface{} {
	list := make([]map[string]interface{}, 0)
	for _, a := range aiAgentList() {
		modelName := ""
		if a.Provider != nil {
			modelName = a.Provider.Model
		}
		list = append(list, map[string]interface{}{
			"name":   a.Name,
			"avatar": a.Avatar,
			"model":  modelName,
			"image":  a.SupportsImage,
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
	agent := aiAgentByName(strings.TrimSpace(msg.ToUser))
	if agent == nil {
		s.sendError(c, "AI 助手不存在或已被移除")
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

	// 先组装上下文（此时本次提问尚未落库，避免上下文重复）
	chatMsgs := s.aiBuildContext(c.username, agent, question)

	// 阶段四十四：图片提问——最后一条 user 消息替换为多模态 content 数组（文本 + base64 图片）
	if imageEnv != nil {
		dataURL, err := s.aiLoadImageDataURL(imageEnv.Image)
		if err != nil {
			s.sendError(c, err.Error())
			return
		}
		chatMsgs[len(chatMsgs)-1].Content = []aiContentPart{
			{Type: "text", Text: question},
			{Type: "image_url", ImageURL: &aiImageURLField{URL: dataURL}},
		}
	}

	// 阶段四十五：文档提问——最后一条 user 消息替换为文档全文信封 + 附言（纯文本注入，任意文本模型可答）
	if docEnv != nil {
		chatMsgs[len(chatMsgs)-1].Content = docPrompt
	}

	// 提问落库（is_read=true：AI 会话无已读回执语义，避免自己发的提问永远显示"未读"）
	record := model.Message{
		MsgType:  2,
		FromUser: c.username,
		ToUser:   agent.Name,
		Content:  msg.Content,
		IsRead:   true,
	}
	store.DB.Create(&record)

	// 回显提问给自己全部在线连接（复用私聊渲染链路，多端同步）
	echo := protocol.Message{
		MsgType:   protocol.MsgTypePrivate,
		FromUser:  c.username,
		ToUser:    agent.Name,
		Content:   msg.Content,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	}
	echoData, _ := json.Marshal(echo)
	s.sendToUser(c.username, echoData)

	// 会话摘要归口（会话列表显示提问正文并排序置顶）
	s.touchConversation(c.username, agent.Name, messageSummary(msg.Content))
	s.notifyConvUpdate(c.username)

	// 异步调用模型流式接口，避免阻塞 WebSocket 主调度
	streamID := aiNewStreamID()
	go func() {
		askCtx, cancel := context.WithTimeout(context.Background(), aiAskTimeout)
		defer cancel()
		full, err := aiStreamChat(askCtx, agent, chatMsgs, func(delta string) {
			chunk := protocol.Message{
				MsgType:   protocol.MsgTypeAIStream,
				FromUser:  agent.Name,
				ToUser:    c.username,
				Content:   delta,
				StreamID:  streamID,
				Timestamp: time.Now().Unix(),
			}
			data, _ := json.Marshal(chunk)
			// 推送增量到用户全部在线连接（多端同步打字机效果）
			s.sendToUser(c.username, data)
		})
		if err != nil {
			logger.Error("AI 问答失败（用户 %s，智能体 %s）：%v", c.username, agent.Name, err)
			s.sendError(c, "AI 服务异常，请稍后重试")
			// 结束帧（error 标记）：前端移除打字中的气泡
			endMsg := protocol.Message{
				MsgType:   protocol.MsgTypeAIStreamEnd,
				FromUser:  agent.Name,
				ToUser:    c.username,
				StreamID:  streamID,
				Remark:    "error",
				Timestamp: time.Now().Unix(),
			}
			data, _ := json.Marshal(endMsg)
			s.sendToUser(c.username, data)
			return
		}

		// 完整回复落库（is_read=false：计入会话未读，多端打开会话后由回执归口清除）
		reply := model.Message{
			MsgType:  2,
			FromUser: agent.Name,
			ToUser:   c.username,
			Content:  full,
		}
		store.DB.Create(&reply)
		s.touchConversation(c.username, agent.Name, messageSummary(full))
		s.notifyConvUpdate(c.username)

		endMsg := protocol.Message{
			MsgType:   protocol.MsgTypeAIStreamEnd,
			FromUser:  agent.Name,
			ToUser:    c.username,
			Content:   full,
			MsgID:     reply.ID,
			StreamID:  streamID,
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(endMsg)
		s.sendToUser(c.username, data)
		logger.Info("AI 回复用户 %s（智能体 %s，%d 字）", c.username, agent.Name, len([]rune(full)))
	}()
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
		// 阶段五十一：群聊 @AI 助手同样注入 RAG 知识库上下文（个人库按提问者权限过滤）
		if kbCtx := kbContextForAgent(agent.KBIDs, question, c.username); kbCtx != "" {
			promptMsgs = append(promptMsgs, aiChatMessage{Role: "system", Content: kbCtx})
		}
		promptMsgs = append(promptMsgs, aiChatMessage{Role: "user", Content: question})
		reply, err := aiStreamChat(askCtx, agent, promptMsgs, func(string) {}) // 群聊场景整段回复，增量丢弃
		if err != nil {
			logger.Error("群聊 AI 应答失败（用户 %s）：%v", c.username, err)
			return
		}
		reply = "@" + c.username + " " + reply

		record := model.Message{
			MsgType:  int8(protocol.MsgTypeGroupChat),
			FromUser: AIBotName,
			ToUser:   "",
			Content:  reply,
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
