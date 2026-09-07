package server

// ===== 阶段五十八：智能体长期记忆 =====
// 五环闭环（全部服务端归口，客户端仅展示）：
//   1. 提取：私聊 AI 回复落库后异步投递有界队列（满则丢弃本轮，保并发稳定），用配置模型提取值得长期记住的用户事实
//   2. 去重：精确匹配 + 向量相似度双通道（dedup_threshold），重复不落库
//   3. 存储：MySQL im_ai_memory 为权威归口；chromem 集合 mem_<agentID> 仅作检索索引（元数据带 username/memid）
//   4. 注入：aiBuildContext 归口，问题向量检索该 用户+智能体 的 top_k 条记忆拼装 system 消息
//   5. 管理：用户侧 API（列表/手动新增/单删/清空/用户级开关）+ 前端聊天窗口「记忆」弹窗
// 隔离语义：记忆按 用户+智能体 隔离（agent_id + username），跨用户零泄露；检索 where 过滤兜底
// 降级策略：总开关关闭 / embedding 未配置 / 提取模型不可用 / 用户关闭偏好 → 静默跳过，不影响聊天主链路
// 作用范围：仅私聊（handleAIChatMsg）；群聊 @AI 涉及多用户混杂，不提取不注入（留后续版本）

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/philippgille/chromem-go"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// 记忆运行时参数（config.yaml ai.memory 归口，启动时加载，均有兜底默认值）
var (
	memEnabled        = false
	memTopK           = 5
	memMaxPerAgent    = 200
	memDedupThreshold = 0.88 // 实测校准（阶段五十八真实对话验证，12 对样本）：同义改写相似度 0.74~0.98、不同记忆 0.59~0.86 区间交叠无完美分界，取 0.88 零误杀（宁少量冗余不丢真实记忆；0.74 级改写漏网为已知局限）
	memExtractUser    = ""   // 提取用模型服务名（空=用智能体当前绑定模型）
)

// memQueue 有界提取队列（容量=待处理任务上限，满则丢弃本轮提取，不阻塞回复链路）
var memQueue chan memExtractTask

// memExtractTask 一次记忆提取任务（最近一轮问答对）
type memExtractTask struct {
	Agent    *AIRunAgent
	Username string
	Question string
	Answer   string
}

// InitMemory 阶段五十八：记忆模块初始化（config 归口加载 + AutoMigrate + 提取 worker 启动）
// 须在 InitKB 之后调用（向量库实例由 KB 模块创建）
func InitMemory(cfg *config.Config) {
	// 数据表迁移（权威归口表 + 用户偏好表）
	if err := store.DB.AutoMigrate(&model.AIMemory{}, &model.AIMemoryPref{}); err != nil {
		logger.Error("记忆数据表迁移失败: %v", err)
		return
	}
	m := cfg.AI.Memory
	memEnabled = m.Enabled
	if m.TopK > 0 {
		memTopK = m.TopK
	}
	if m.MaxPerAgent > 0 {
		memMaxPerAgent = m.MaxPerAgent
	}
	if m.DedupThreshold > 0 {
		memDedupThreshold = m.DedupThreshold
	}
	memExtractUser = strings.TrimSpace(m.ExtractProvider)
	if !memEnabled {
		logger.Info("智能体长期记忆功能已关闭（config.yaml ai.memory.enabled=false）")
		return
	}
	// 提取 worker（单消费者串行处理：提取/去重/入库互不竞态；失败仅记日志不影响聊天）
	memQueue = make(chan memExtractTask, 64)
	go memWorker()
	if !kbEmbedEnabled() {
		logger.Warn("记忆功能已开启但 embedding 未配置，向量召回/提取降级跳过（不影响聊天）")
	}
	logger.Info("智能体长期记忆已启用：top_k=%d，上限=%d 条/用户+智能体，去重阈值=%.2f，提取模型=%s",
		memTopK, memMaxPerAgent, memDedupThreshold, map[bool]string{true: memExtractUser, false: "智能体当前绑定"}[memExtractUser != ""])
}

// memWorker 提取任务消费者（串行：同一时刻只跑一次提取模型调用，天然限流）
func memWorker() {
	for t := range memQueue {
		memProcessTask(t)
	}
}

// memEnqueueExtract 提取入口（handleAIChatMsg 回复落库后调用）：异步非阻塞，队列满丢弃本轮
func memEnqueueExtract(agent *AIRunAgent, username, question, answer string) {
	// 内置 mock 兜底智能体（无 DB 记录 ID=0）不做记忆（无法定位归属与集合）
	if agent == nil || agent.ID == 0 || !memEnabled || memQueue == nil {
		return
	}
	question = strings.TrimSpace(question)
	answer = strings.TrimSpace(answer)
	if question == "" || answer == "" {
		return
	}
	select {
	case memQueue <- memExtractTask{Agent: agent, Username: username, Question: question, Answer: answer}:
	default:
		logger.Warn("记忆提取队列已满，丢弃本轮提取（用户 %s，智能体 %s）", username, agent.Name)
	}
}

// memUserEnabled 用户级记忆偏好（im_ai_memory_pref 归口，缺行默认开启）
func memUserEnabled(username string) bool {
	var pref model.AIMemoryPref
	if err := store.DB.Where("username = ?", username).First(&pref).Error; err != nil {
		return true
	}
	return pref.Enabled
}

// memExtractProvider 提取模型解析归口：独立配置优先（须为已启用模型服务），否则用智能体当前绑定；
// 均不可用时返回 nil（本轮静默跳过）
func memExtractProvider(agent *AIRunAgent) *AIRunAgent {
	if memExtractUser != "" {
		var p model.AIProvider
		if err := store.DB.Where("name = ? AND enabled = ?", memExtractUser, true).First(&p).Error; err == nil {
			return &AIRunAgent{
				Name:     "记忆提取",
				Provider: &config.AIProviderConfig{Name: p.Name, APIURL: p.APIURL, APIKey: p.APIKey, Model: p.Model},
			}
		}
		logger.Warn("记忆提取模型服务 %q 未配置或已停用，回退智能体当前绑定模型", memExtractUser)
	}
	if agent.Provider != nil {
		return &AIRunAgent{Name: "记忆提取", Provider: agent.Provider}
	}
	return nil
}

// memProcessTask 单任务处理：提取 → 清洗 → 去重 → 落库 + 向量索引（异常仅记日志，绝不外抛）
func memProcessTask(t memExtractTask) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("记忆提取异常恢复（用户 %s，智能体 %s）：%v", t.Username, t.Agent.Name, r)
		}
	}()
	if !kbEmbedEnabled() || !memUserEnabled(t.Username) {
		return
	}
	extractor := memExtractProvider(t.Agent)
	if extractor == nil {
		return
	}
	// 问答对截断（防超长文档问答撑爆提取调用）
	q, a := truncateRunes(t.Question, 2000), truncateRunes(t.Answer, 2000)
	sys := "你是对话记忆提取器。从用户与AI的对话中提取值得长期记住的信息：用户个人信息、偏好、习惯、进行中的事务、对AI提出的持续性要求等。" +
		"规则：每条记忆独立成句、第三人称陈述、不超过100字；最多3条；只提取明确可靠的信息，不推测、不编造；" +
		"没有值得记的内容时输出空数组。仅输出 JSON 字符串数组，格式如 [\"用户喜欢...\",\"用户正在...\"]，不要输出任何其他内容。"
	prompt := []aiChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: "对话内容：\n用户：" + q + "\n" + t.Agent.Name + "：" + a},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	raw, _, err := aiStreamChat(ctx, extractor, prompt, func(string) {}) // 记忆提取不关心 Token 统计
	if err != nil {
		logger.Warn("记忆提取模型调用失败（用户 %s，智能体 %s）：%v", t.Username, t.Agent.Name, err)
		return
	}
	items, err := parseMemoryItems(raw)
	if err != nil || len(items) == 0 {
		return // 无值得记的内容或输出异常，静默结束
	}
	for _, item := range items {
		memSaveItem(t.Agent.ID, t.Username, item, "auto")
	}
}

// parseMemoryItems 解析提取输出（容错 markdown 代码块包裹），仅保留 1~200 字的条目
func parseMemoryItems(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)
	var items []string
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		it = strings.TrimSpace(it)
		n := utf8.RuneCountInString(it)
		if n == 0 || n > 200 {
			continue
		}
		out = append(out, it)
	}
	return out, nil
}

// truncateRunes 按字符数截断（记忆提取与条目清洗共用）
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// memSaveItem 单条记忆落库归口（自动提取与手动新增共用）：精确去重 → 向量去重 → 超限淘汰 → MySQL + 集合
// 返回新记忆 ID（0=被去重跳过或失败）
func memSaveItem(agentID uint, username, content, source string) uint {
	content = strings.TrimSpace(truncateRunes(content, 200))
	if content == "" || !kbEmbedEnabled() {
		return 0
	}
	// 精确去重（完全相同内容跳过）
	var dupCount int64
	store.DB.Model(&model.AIMemory{}).Where("agent_id = ? AND username = ? AND content = ?", agentID, username, content).Count(&dupCount)
	if dupCount > 0 {
		return 0
	}
	// 向量去重：与已有记忆最高相似度达阈值视为重复
	col, err := memGetCollection(agentID)
	if err != nil {
		logger.Warn("记忆向量集合获取失败（agent=%d）：%v", agentID, err)
		return 0
	}
	vecs, err := kbEmbed([]string{content})
	if err != nil || len(vecs) == 0 {
		logger.Warn("记忆向量化失败（agent=%d）：%v", agentID, err)
		return 0
	}
	if n := col.Count(); n > 0 {
		topN := n
		if topN > 3 {
			topN = 3
		}
		if res, err := col.QueryEmbedding(context.Background(), vecs[0], topN, map[string]string{"username": username}, nil); err == nil {
			for _, r := range res {
				if float64(r.Similarity) >= memDedupThreshold {
					return 0 // 与已有记忆语义重复，跳过
				}
			}
		}
	}
	// 超限淘汰最旧（插入后保持条数上限）
	memEvictOldest(agentID, username, 1)
	// MySQL 权威归口
	rec := model.AIMemory{AgentID: agentID, Username: username, Content: content, Source: source}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Warn("记忆落库失败（agent=%d，用户 %s）：%v", agentID, username, err)
		return 0
	}
	// 向量索引（文档 ID 与元数据锚定 MySQL 记忆 ID，单删/清空按 memid/username 过滤归口）
	if err := col.AddDocuments(context.Background(), []chromem.Document{{
		ID:        fmt.Sprintf("m%d", rec.ID),
		Metadata:  map[string]string{"username": username, "memid": strconv.FormatUint(uint64(rec.ID), 10)},
		Content:   content,
		Embedding: vecs[0],
	}}, 1); err != nil {
		logger.Warn("记忆向量索引写入失败（agent=%d，mem=%d）：%v", agentID, rec.ID, err)
	}
	return rec.ID
}

// memEvictOldest 超限淘汰：reserve 条预留位，超出上限的最旧记忆被删除（MySQL + 向量集合同步）
func memEvictOldest(agentID uint, username string, reserve int) {
	var count int64
	store.DB.Model(&model.AIMemory{}).Where("agent_id = ? AND username = ?", agentID, username).Count(&count)
	overflow := int(count) + reserve - memMaxPerAgent
	if overflow <= 0 {
		return
	}
	var olds []model.AIMemory
	store.DB.Where("agent_id = ? AND username = ?", agentID, username).Order("id ASC").Limit(overflow).Find(&olds)
	for _, o := range olds {
		memDeleteRow(agentID, o.ID, username)
	}
}

// memDeleteRow 单条记忆删除归口（MySQL 归口 + 向量集合按 memid 过滤删除；集合不存在忽略）
func memDeleteRow(agentID, memID uint, username string) {
	store.DB.Where("id = ? AND agent_id = ? AND username = ?", memID, agentID, username).Delete(&model.AIMemory{})
	if col, err := memGetCollection(agentID); err == nil {
		if err := col.Delete(context.Background(), map[string]string{"memid": strconv.FormatUint(uint64(memID), 10)}, nil); err != nil {
			logger.Warn("记忆向量删除失败（agent=%d，mem=%d）：%v", agentID, memID, err)
		}
	}
}

// memGetCollection 记忆向量集合获取归口（与知识库共享 kbCollectionMu 串行化，
// 防 chromem-go v0.7.0 GetOrCreateCollection 并发竞态——阶段五十二实测教训）
func memGetCollection(agentID uint) (*chromem.Collection, error) {
	if kbVectorDB == nil {
		return nil, fmt.Errorf("向量库未初始化")
	}
	kbCollectionMu.Lock()
	defer kbCollectionMu.Unlock()
	return kbVectorDB.GetOrCreateCollection(fmt.Sprintf("mem_%d", agentID), nil, nil)
}

// memContextForAgent 注入归口（aiBuildContext 调用）：问题向量检索该 用户+智能体 的 top_k 条记忆，
// 拼装 system 消息；任何异常静默返回空串（不阻断问答链路）
func memContextForAgent(agent *AIRunAgent, username, question string) string {
	question = strings.TrimSpace(question)
	if agent == nil || agent.ID == 0 || !memEnabled || !kbEmbedEnabled() || question == "" {
		return ""
	}
	if !memUserEnabled(username) {
		return ""
	}
	col, err := memGetCollection(agent.ID)
	if err != nil {
		return ""
	}
	n := col.Count()
	if n <= 0 {
		return ""
	}
	if n > memTopK {
		n = memTopK
	}
	vecs, err := kbEmbed([]string{question})
	if err != nil || len(vecs) == 0 {
		return ""
	}
	res, err := col.QueryEmbedding(context.Background(), vecs[0], n, map[string]string{"username": username}, nil)
	if err != nil || len(res) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("以下是你要长期记住的关于该用户的记忆（背景参考，与本次问题相关时可自然运用，不要逐条复述）：")
	for _, r := range res {
		content := strings.TrimSpace(r.Content)
		if content != "" {
			b.WriteString("\n- ")
			b.WriteString(content)
		}
	}
	return b.String()
}

// memDestroyAgent 智能体删除级联归口：清理该智能体全部记忆（MySQL 行 + 向量集合整体删除）
func memDestroyAgent(agentID uint) {
	if agentID == 0 {
		return
	}
	store.DB.Where("agent_id = ?", agentID).Delete(&model.AIMemory{})
	if kbVectorDB != nil {
		if err := kbVectorDB.DeleteCollection(fmt.Sprintf("mem_%d", agentID)); err != nil {
			logger.Warn("删除记忆向量集合失败 mem_%d: %v", agentID, err)
		}
	}
}

// memAgentReadable 管理接口的智能体可读校验归口：智能体须存在，个人智能体（scope=user）仅归属者可访问
// （他人访问视同不存在，与对话路由 aiAgentForUser 同口径防探测）
func memAgentReadable(w http.ResponseWriter, agentID uint, username string) (*model.AIAgent, bool) {
	var a model.AIAgent
	if err := store.DB.First(&a, agentID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "智能体不存在")
		return nil, false
	}
	if a.Scope == "user" && a.Owner != username {
		adminFail(w, http.StatusNotFound, "智能体不存在")
		return nil, false
	}
	return &a, true
}

// ===== 用户侧管理 API（鉴权水位与 /api/agents 一致：username 查询参数） =====

// HandleMemoryGet 记忆列表（含用户级开关与功能可用状态）
func (s *Server) HandleMemoryGet(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	var rows []model.AIMemory
	store.DB.Where("agent_id = ? AND username = ?", id, username).Order("id DESC").Find(&rows)
	adminJSON(w, map[string]interface{}{
		"feature":  memEnabled && kbEmbedEnabled(), // 功能可用性（关闭/降级时前端隐藏新增与开关保存）
		"pref":     memUserEnabled(username),
		"memories": rows,
	})
}

// HandleMemoryAdd 手动新增记忆（同样走去重归口，防止用户手动灌入重复内容）
func (s *Server) HandleMemoryAdd(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	content := strings.TrimSpace(req.Content)
	n := utf8.RuneCountInString(content)
	if n == 0 {
		adminFail(w, http.StatusBadRequest, "记忆内容不能为空")
		return
	}
	if n > 200 {
		adminFail(w, http.StatusBadRequest, "记忆内容不能超过 200 字")
		return
	}
	if !memEnabled || !kbEmbedEnabled() {
		adminFail(w, http.StatusServiceUnavailable, "记忆功能未启用或向量化服务未配置")
		return
	}
	if mid := memSaveItem(id, username, content, "manual"); mid > 0 {
		adminJSON(w, map[string]interface{}{"id": mid})
		return
	}
	adminFail(w, http.StatusConflict, "该记忆已存在（与已有记忆重复）")
}

// HandleMemoryPref 用户级记忆开关（关闭后该用户不再自动提取与注入召回，手动新增不受影响）
func (s *Server) HandleMemoryPref(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 原实现一：First 找不到行时走 Save——GORM 主键（username）非零仅发 UPDATE，行不存在 0 行受影响且不报错，
	// 导致"缺行默认开启"永远成立、开关保存无效
	// 原实现二：FirstOrCreate+Assign(struct)——Assign 的 Enabled:false 为零值，GORM struct 更新忽略零值字段，
	// 关闭开关（true→false）静默失效；改 Assign(map) 归口（map 形式不忽略零值，找到即更新，缺行即创建）
	pref := model.AIMemoryPref{Username: username}
	if err := store.DB.Where(model.AIMemoryPref{Username: username}).
		Assign(map[string]interface{}{"enabled": req.Enabled}).
		FirstOrCreate(&pref).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	adminJSON(w, map[string]interface{}{"enabled": pref.Enabled})
}

// HandleMemoryDelete 单条记忆删除（归属校验：仅本人记忆可删）
func (s *Server) HandleMemoryDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	mid, err := strconv.ParseUint(r.PathValue("mid"), 10, 64)
	if err != nil || mid == 0 {
		adminFail(w, http.StatusBadRequest, "记忆 ID 非法")
		return
	}
	var count int64
	store.DB.Model(&model.AIMemory{}).Where("id = ? AND agent_id = ? AND username = ?", mid, id, username).Count(&count)
	if count == 0 {
		adminFail(w, http.StatusNotFound, "记忆不存在")
		return
	}
	memDeleteRow(id, uint(mid), username)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// HandleMemoryClear 清空该 用户+智能体 的全部记忆（MySQL + 向量集合按 username 过滤删除）
func (s *Server) HandleMemoryClear(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	store.DB.Where("agent_id = ? AND username = ?", id, username).Delete(&model.AIMemory{})
	if col, err := memGetCollection(id); err == nil {
		if err := col.Delete(context.Background(), map[string]string{"username": username}, nil); err != nil {
			logger.Warn("清空记忆向量失败（agent=%d，用户 %s）：%v", id, username, err)
		}
	}
	adminJSON(w, map[string]interface{}{"cleared": true})
}
