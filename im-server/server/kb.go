package server

// ===== 阶段五十一：知识库 + 自动向量化（RAG 数据源归口） =====
// 流水线（全自动，服务端归口）：文件上传落盘 → aiExtractDocText 解析文本 → 按段落+定长切片 →
// 调 OpenAI 兼容 /embeddings 批量向量化 → 写入 chromem-go 嵌入式向量库（磁盘持久化）→ 状态 ready
// 检索：AI 对话时按问题向量在 agent 绑定的知识库中检索 top-K，注入 system prompt（个人库仅归属者生效）
// 降级：embedding 未配置或调用失败时，知识库功能静默降级（上传报错/检索跳过），不影响聊天与 AI 问答

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/philippgille/chromem-go"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// 运行时配置快照（InitKB 启动时从 config 归口，之后只读）
var (
	kbChunkSize    = 500
	kbChunkOverlap = 50
	kbTopK         = 3
	kbMaxContext   = 4000
	kbDataDir      = ""
	kbEmbedCfg     config.EmbeddingConfig
	kbVectorDB     *chromem.DB
	// kbMaxFileSize 知识文件上传大小上限（字节，config.yaml max_file_size 归口，不硬编码）
	kbMaxFileSize int64
	// kbScoreThreshold 阶段五十二：命中相似度阈值（0=不过滤；低于阈值的命中视为不相关不注入；与向量相似度同为 float32 归口）
	kbScoreThreshold float32
)

// InitKB 阶段五十一：知识库模块初始化（main.go 调用一次）
// chromem-go 持久化目录 = DataDir/vectors；embedding 未配置时仅记录日志降级（管理界面仍可建库但不可向量化）
func InitKB(cfg *config.Config) {
	kbChunkSize = cfg.AI.KB.ChunkSize
	kbChunkOverlap = cfg.AI.KB.ChunkOverlap
	kbTopK = cfg.AI.KB.TopK
	kbMaxContext = cfg.AI.KB.MaxContext
	kbDataDir = cfg.AI.KB.DataDir
	kbEmbedCfg = cfg.AI.Embedding
	kbScoreThreshold = float32(cfg.AI.KB.ScoreThreshold)
	if cfg.MaxFileSize > 0 {
		kbMaxFileSize = int64(cfg.MaxFileSize)
	} else {
		kbMaxFileSize = 100 << 20 // 配置缺省时的兜底（100MB），仅防异常大文件拖垮内存
	}

	if err := os.MkdirAll(filepath.Join(kbDataDir, "files"), 0o755); err != nil {
		logger.Error("知识库文件目录创建失败 %s: %v", kbDataDir, err)
		return
	}
	db, err := chromem.NewPersistentDB(filepath.Join(kbDataDir, "vectors"), false)
	if err != nil {
		logger.Error("知识库向量库初始化失败: %v", err)
		return
	}
	kbVectorDB = db
	if !kbEmbedEnabled() {
		logger.Warn("embedding 服务未配置（ai.embedding.api_url 为空），知识库文件无法向量化；请在 config.yaml 配置后重启")
		return
	}
	logger.Info("知识库模块初始化完成：数据目录 %s，embedding 模型 %s", kbDataDir, kbEmbedCfg.Model)
}

// kbEmbedEnabled embedding 通道是否可用
func kbEmbedEnabled() bool {
	return kbVectorDB != nil && kbEmbedCfg.APIURL != "" && kbEmbedCfg.Model != ""
}

// kbCollectionName 向量库 collection 命名归口（kbID → kb_<id>）
func kbCollectionName(kbID uint) string {
	return "kb_" + strconv.FormatUint(uint64(kbID), 10)
}

// kbCollectionMu 阶段五十二：集合获取互斥锁——chromem-go v0.7.0 的 GetOrCreateCollection
// 内部为"先 Get 后 Create"两段式且无原子保护，并发首建同名集合时 CreateCollection 会
// 无条件覆盖 db.collections[name]，导致先建实例中的文档全部不可见（文件状态 ready 但
// 检索与切片查询均查不到，实测踩坑）。此处串行化 GetOrCreate 调用关闭竞态窗口；
// 锁内仅做 map 查找/创建（微秒级），不阻塞向量检索本身
var kbCollectionMu sync.Mutex

// kbGetCollection 获取或创建知识库 collection（embeddingFunc 传 nil：入库自带向量）
// 原实现：直接调用 kbVectorDB.GetOrCreateCollection（内部 Get/Create 两段无原子性，并发首建覆盖丢文档）
//
//	func kbGetCollection(kbID uint) (*chromem.Collection, error) {
//		if kbVectorDB == nil {
//			return nil, fmt.Errorf("向量库未初始化")
//		}
//		return kbVectorDB.GetOrCreateCollection(kbCollectionName(kbID), nil, nil)
//	}
func kbGetCollection(kbID uint) (*chromem.Collection, error) {
	if kbVectorDB == nil {
		return nil, fmt.Errorf("向量库未初始化")
	}
	kbCollectionMu.Lock()
	defer kbCollectionMu.Unlock()
	return kbVectorDB.GetOrCreateCollection(kbCollectionName(kbID), nil, nil)
}

// ===== 切片 =====

// kbSplitChunks 切片归口（阶段五十五：表格感知标准化切片）：
//  1. 优先按行聚合，普通超长段落按字符硬切（含 overlap 回看）
//  2. 表格行（" | " 分隔风格）超长时按列边界聚合切分——保持单元格完整，不再拦腰切断出孤立碎片
//  3. 表头继承：每个表格连续块的首行为表头，块内数据行切出的每个切片自动带上表头前缀，
//     使每片自含语义（模型能理解孤立数据行归属哪列表头）
//  4. 工作表边界（"## 工作表："标题行）强制起新片并重置表头
//
// 参数从 config.yaml ai.kb 归口（chunk_size/chunk_overlap）
func kbSplitChunks(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	// 段落拆分（保留非空段）
	paras := strings.Split(text, "\n")
	segments := make([]string, 0, len(paras))
	for _, p := range paras {
		p = strings.TrimSpace(p)
		if p != "" {
			segments = append(segments, p)
		}
	}
	if len(segments) == 0 {
		return nil
	}

	// 表格行判定：提取层/Markdown 表格风格（"a | b | c"）
	isTableRow := func(s string) bool { return strings.Contains(s, " | ") }

	chunks := make([]string, 0)
	var buf strings.Builder
	curHeader := ""       // 当前表格连续块的表头行（块首表格行）
	lastWasTable := false // 上一段是否表格行（判定表格块边界）
	// tryPrefix 表头继承：新片起始为表格数据行时注入表头（表头占片预算）
	tryPrefix := func(seg string) {
		if buf.Len() == 0 && isTableRow(seg) && curHeader != "" && seg != curHeader {
			buf.WriteString(curHeader)
		}
	}
	flush := func() {
		if buf.Len() > 0 {
			chunks = append(chunks, strings.TrimSpace(buf.String()))
			buf.Reset()
		}
	}
	for _, seg := range segments {
		// 工作表边界：强制起新片并重置表头上下文
		if strings.HasPrefix(seg, "## 工作表：") {
			flush()
			curHeader = ""
			lastWasTable = false
		} else if isTableRow(seg) {
			if !lastWasTable {
				curHeader = seg // 表格连续块首行 = 表头
			}
			lastWasTable = true
		} else {
			curHeader = "" // 普通行打断表格块，表头失效
			lastWasTable = false
		}

		// 单段超长：先落已聚合内容，再分段
		if len([]rune(seg)) > kbChunkSize {
			flush()
			if isTableRow(seg) {
				// 表格行按列边界聚合（单元格完整；每片注入表头；列语义天然连续不带 overlap）
				cells := strings.Split(seg, " | ")
				var cb strings.Builder
				writeHeader := func() {
					if curHeader != "" && curHeader != seg {
						cb.WriteString(curHeader + "\n")
					}
				}
				writeHeader()
				for _, c := range cells {
					if cb.Len()+len([]rune(c))+3 > kbChunkSize && cb.Len() > 0 {
						chunks = append(chunks, strings.TrimSpace(cb.String()))
						cb.Reset()
						writeHeader()
					}
					if cb.Len() > 0 {
						cb.WriteString(" | ")
					}
					cb.WriteString(c)
				}
				if cb.Len() > 0 {
					chunks = append(chunks, strings.TrimSpace(cb.String()))
				}
				continue
			}
			// 普通超长段按字符硬切（含 overlap 回看，原逻辑）
			runes := []rune(seg)
			step := kbChunkSize - kbChunkOverlap
			if step <= 0 {
				step = kbChunkSize
			}
			for start := 0; start < len(runes); start += step {
				end := start + kbChunkSize
				if end > len(runes) {
					end = len(runes)
				}
				chunks = append(chunks, string(runes[start:end]))
				if end >= len(runes) {
					break
				}
			}
			continue
		}
		// 表头继承：新片起始为表格数据行时注入表头
		tryPrefix(seg)
		// 聚合段落：当前缓冲+新段超过上限则先落盘
		if buf.Len()+len(seg) > kbChunkSize && buf.Len() > 0 {
			flush()
			tryPrefix(seg) // 落盘后新片再次注入表头
		}
		if buf.Len() > 0 {
			buf.WriteString("\n")
		}
		buf.WriteString(seg)
	}
	flush()
	return chunks
}

// ===== Embedding 调用（OpenAI 兼容 /embeddings，批量归口） =====

type kbEmbedResp struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// kbEmbed 批量向量化：按 batch_size 分批请求，返回与输入等长的向量切片（失败返回 error）
func kbEmbed(texts []string) ([][]float32, error) {
	if !kbEmbedEnabled() {
		return nil, fmt.Errorf("embedding 服务未配置（config.yaml ai.embedding）")
	}
	batch := kbEmbedCfg.BatchSize
	result := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += batch {
		end := start + batch
		if end > len(texts) {
			end = len(texts)
		}
		vecs, err := kbEmbedOnce(texts[start:end])
		if err != nil {
			return nil, err
		}
		result = append(result, vecs...)
	}
	return result, nil
}

// kbEmbedOnce 单次批量请求（带 30 秒超时与 1 次重试）
func kbEmbedOnce(texts []string) ([][]float32, error) {
	payload, _ := json.Marshal(map[string]interface{}{
		"model": kbEmbedCfg.Model,
		"input": texts,
	})
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		req, err := http.NewRequest(http.MethodPost, kbEmbedCfg.APIURL, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if kbEmbedCfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+kbEmbedCfg.APIKey)
		}
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("embedding 接口返回 %d: %s", resp.StatusCode, truncateStr(string(data), 200))
			continue
		}
		var parsed kbEmbedResp
		if err := json.Unmarshal(data, &parsed); err != nil {
			lastErr = err
			continue
		}
		if parsed.Error != nil && parsed.Error.Message != "" {
			lastErr = fmt.Errorf("embedding 接口错误: %s", parsed.Error.Message)
			continue
		}
		if len(parsed.Data) != len(texts) {
			lastErr = fmt.Errorf("embedding 返回条数不符（期望 %d 实际 %d）", len(texts), len(parsed.Data))
			continue
		}
		// 按 index 归位（部分服务不保证顺序）
		out := make([][]float32, len(texts))
		for _, item := range parsed.Data {
			if item.Index >= 0 && item.Index < len(out) {
				out[item.Index] = item.Embedding
			}
		}
		return out, nil
	}
	return nil, lastErr
}

// truncateStr 按字符截断（日志归口，防超长刷屏）
func truncateStr(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "..."
}

// ===== 上传处理流水线（异步） =====

// kbAllowedExt 知识库允许的文件扩展名（与 aiExtractDocText 解析能力一致：docx/xlsx/xlsm/csv/md/txt）
func kbAllowedExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".docx", ".xlsx", ".xlsm", ".csv", ".md", ".txt":
		return true
	}
	return false
}

// kbProcessFile 异步流水线入口（上传接口落盘建记录后 go 调用）：
// 解析文本 → 切片 → 批量 embedding → 写入向量库 → 更新状态（任一步失败标记 failed 并记录原因）
func kbProcessFile(kbFileID uint) {
	var file model.KBFile
	if err := store.DB.First(&file, kbFileID).Error; err != nil {
		logger.Error("知识文件处理失败（记录不存在 id=%d）: %v", kbFileID, err)
		return
	}
	fail := func(err error) {
		store.DB.Model(&model.KBFile{}).Where("id = ?", file.ID).Updates(map[string]interface{}{
			"status": "failed",
			"error":  truncateStr(err.Error(), 200),
		})
		logger.Warn("知识文件向量化失败 %s: %v", file.Name, err)
	}

	var kb model.KB
	if err := store.DB.First(&kb, file.KBID).Error; err != nil {
		fail(fmt.Errorf("所属知识库不存在"))
		return
	}
	// 解析文本（复用 AI 文档问答的解析器，服务端归口）
	text, err := aiExtractDocText(file.Path, strings.ToLower(filepath.Ext(file.Path)))
	if err != nil {
		fail(fmt.Errorf("文档解析失败: %w", err))
		return
	}
	if strings.TrimSpace(text) == "" {
		fail(fmt.Errorf("文档未提取到文本内容"))
		return
	}
	// 切片
	chunks := kbSplitChunks(text)
	if len(chunks) == 0 {
		fail(fmt.Errorf("切片结果为空"))
		return
	}
	// 批量向量化
	vectors, err := kbEmbed(chunks)
	if err != nil {
		fail(err)
		return
	}
	// 首片确定维度并校验一致性（换 embedding 模型/维度不同的文件拒绝混入）
	dim := len(vectors[0])
	if kb.Dim == 0 || kb.EmbedModel == "" {
		store.DB.Model(&model.KB{}).Where("id = ?", kb.ID).Updates(map[string]interface{}{
			"dim":         dim,
			"embed_model": kbEmbedCfg.Model,
		})
	} else if kb.Dim != dim {
		fail(fmt.Errorf("向量维度不一致（库维度 %d，本文件 %d；embedding 模型变更后请使用整库重建）", kb.Dim, dim))
		return
	}

	// 写入向量库（文档 ID 含 kb/file/chunk 三级锚点，删除按 file_id 过滤归口）
	col, err := kbGetCollection(kb.ID)
	if err != nil {
		fail(err)
		return
	}
	docs := make([]chromem.Document, 0, len(chunks))
	for i, chunk := range chunks {
		docs = append(docs, chromem.Document{
			ID: kbChunkID(kb.ID, file.ID, i),
			Metadata: map[string]string{
				"file_id": strconv.FormatUint(uint64(file.ID), 10),
				"file":    file.Name,
				"chunk":   strconv.Itoa(i),
			},
			Content:   chunk,
			Embedding: vectors[i],
		})
	}
	if err := col.AddDocuments(context.Background(), docs, 2); err != nil {
		fail(err)
		return
	}
	store.DB.Model(&model.KBFile{}).Where("id = ?", file.ID).Updates(map[string]interface{}{
		"status": "ready",
		"chunks": len(chunks),
		"error":  "",
	})
	logger.Info("知识文件向量化完成 %s：%d 个切片入库（库 %s）", file.Name, len(chunks), kb.Name)
}

// ===== 检索与注入 =====

// kbHit 检索命中（内容 + 来源 + 相似度）
type kbHit struct {
	KBID       uint    `json:"kb_id"`
	KBName     string  `json:"kb_name"`
	FileName   string  `json:"file_name"`
	Chunk      int     `json:"chunk"`
	Content    string  `json:"content"`
	Similarity float32 `json:"similarity"`
}

// kbSearch 知识库检索归口（权限过滤：公共库全量可用；个人库仅归属者对话时参与）
// kbIDs 为智能体绑定的库；talkUser 为当前对话用户；embedding 不可用时返回空（静默降级）
func kbSearch(kbIDs []uint, query string, talkUser string) []kbHit {
	return kbSearchWhere(kbIDs, query, func(kb model.KB) bool {
		return kb.Scope == "public" || (kb.Scope == "user" && kb.Owner == talkUser)
	})
}

// kbSearchWhere 检索执行归口（allow 对库做准入过滤；管理端命中测试放行全部库，对话链路做权限过滤）
func kbSearchWhere(kbIDs []uint, query string, allow func(model.KB) bool) []kbHit {
	if !kbEmbedEnabled() || len(kbIDs) == 0 || strings.TrimSpace(query) == "" || allow == nil {
		return nil
	}
	// 加载库记录做准入过滤
	var kbs []model.KB
	store.DB.Where("id IN ?", kbIDs).Find(&kbs)
	allowed := make([]model.KB, 0, len(kbs))
	for _, kb := range kbs {
		if allow(kb) {
			allowed = append(allowed, kb)
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	// 问题向量化（失败静默降级，不影响对话主链路）
	qVecs, err := kbEmbed([]string{query})
	if err != nil || len(qVecs) == 0 || len(qVecs[0]) == 0 {
		logger.Warn("知识库检索问题向量化失败: %v", err)
		return nil
	}
	qVec := qVecs[0]

	// 各库独立检索 topK 后按相似度归并取前 topK（dim 不匹配的库自动跳过）
	hits := make([]kbHit, 0)
	for _, kb := range allowed {
		if kb.Dim != 0 && kb.Dim != len(qVec) {
			continue
		}
		col, err := kbGetCollection(kb.ID)
		if err != nil {
			continue
		}
		// chromem-go 要求 nResults <= 集合文档数：先取集合内文档数，钳制 topK（空集合直接跳过）
		count := col.Count()
		if count == 0 {
			continue
		}
		n := kbTopK
		if n > count {
			n = count
		}
		results, err := col.QueryEmbedding(context.Background(), qVec, n, nil, nil)
		if err != nil {
			logger.Warn("知识库 %s 检索失败: %v", kb.Name, err)
			continue
		}
		for _, r := range results {
			chunkIdx, _ := strconv.Atoi(r.Metadata["chunk"])
			hits = append(hits, kbHit{
				KBID:       kb.ID,
				KBName:     kb.Name,
				FileName:   r.Metadata["file"],
				Chunk:      chunkIdx,
				Content:    r.Content,
				Similarity: r.Similarity,
			})
		}
	}
	// 相似度降序归并
	for i := 0; i < len(hits); i++ {
		for j := i + 1; j < len(hits); j++ {
			if hits[j].Similarity > hits[i].Similarity {
				hits[i], hits[j] = hits[j], hits[i]
			}
		}
	}
	// 阶段五十二：相似度阈值过滤——低于阈值视为不相关（防低质量命中注入造成噪声）；阈值 0 表示不过滤
	if kbScoreThreshold > 0 {
		filtered := hits[:0]
		for _, h := range hits {
			if h.Similarity >= kbScoreThreshold {
				filtered = append(filtered, h)
			}
		}
		hits = filtered
	}
	// 截断至 topK
	if len(hits) > kbTopK {
		hits = hits[:kbTopK]
	}
	return hits
}

// kbContextForAgent RAG 注入归口（aiBuildContext 调用）：
// 解析 agent 绑定的知识库 → 权限过滤检索 → 组装参考资料文本（超长截断）
// 返回空串表示无注入（未绑定/embedding 不可用/无命中）
func kbContextForAgent(agentKBIDs string, question string, talkUser string) string {
	if strings.TrimSpace(agentKBIDs) == "" {
		return ""
	}
	ids := parseKBIDs(agentKBIDs)
	if len(ids) == 0 {
		return ""
	}
	hits := kbSearch(ids, question, talkUser)
	if len(hits) == 0 {
		return ""
	}
	// 阶段五十二：要求模型在回答末尾标注实际引用的资料出处（引用溯源），未引用则不标注
	var buf strings.Builder
	buf.WriteString("以下是知识库中的参考资料，回答时优先依据其中内容；若回答引用了其中的内容，须在回答末尾另起一行以【来源：文件名】格式标注实际引用的资料出处（可多个，未引用任何资料则不加）；与问题无关的资料请忽略：")
	total := 0
	for i, h := range hits {
		line := fmt.Sprintf("\n[%d] （来源：%s / %s，相似度 %.2f）\n%s", i+1, h.KBName, h.FileName, h.Similarity, h.Content)
		lineLen := len([]rune(line))
		if total+lineLen > kbMaxContext {
			break
		}
		buf.WriteString(line)
		total += lineLen
	}
	return buf.String()
}

// parseKBIDs 解析智能体绑定的知识库 ID 列表（逗号分隔 → 去重去空白）
func parseKBIDs(raw string) []uint {
	parts := strings.Split(raw, ",")
	ids := make([]uint, 0, len(parts))
	seen := make(map[uint]bool)
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		id, err := strconv.ParseUint(p, 10, 64)
		if err != nil || id == 0 || seen[uint(id)] {
			continue
		}
		seen[uint(id)] = true
		ids = append(ids, uint(id))
	}
	return ids
}

// ===== 向量清理归口 =====

// kbDeleteFileVectors 删除单个文件的向量（文件删除时联动，按 metadata file_id 过滤）
func kbDeleteFileVectors(kbID uint, fileID uint) {
	col, err := kbGetCollection(kbID)
	if err != nil {
		return
	}
	if err := col.Delete(context.Background(), map[string]string{
		"file_id": strconv.FormatUint(uint64(fileID), 10),
	}, nil); err != nil {
		logger.Warn("删除文件向量失败（kb=%d file=%d）: %v", kbID, fileID, err)
	}
}

// kbDeleteKBCollection 删除整个知识库的向量集合（删库时联动）
func kbDeleteKBCollection(kbID uint) {
	if kbVectorDB == nil {
		return
	}
	if err := kbVectorDB.DeleteCollection(kbCollectionName(kbID)); err != nil {
		logger.Warn("删除知识库向量集合失败 kb_%d: %v", kbID, err)
	}
}

// ===== 阶段五十二：知识库进阶（切片详情/文本直贴/重新向量化） =====

// kbChunkID 向量文档 ID 生成归口（入库与切片详情查询共用，格式变更须两处同步）
func kbChunkID(kbID uint, fileID uint, chunkIdx int) string {
	return fmt.Sprintf("kb%d_f%d_c%d", kbID, fileID, chunkIdx)
}

// kbFileChunk 向量库中单个切片的内容（切片详情查询结果归口）
type kbFileChunk struct {
	Chunk   int       `json:"chunk"`
	Content string    `json:"content"`
	Chars   int       `json:"chars"`
	Dim     int       `json:"dim"`  // 阶段五十三：向量维度（健康检查：应与库维度一致）
	Norm    float64   `json:"norm"` // 阶段五十三：向量 L2 范数（归一化向量应≈1，异常说明 embedding 服务返回未归一化）
	Head    []float32 `json:"head"` // 阶段五十三：向量前 8 维预览（全量向量不下发，仅作数据健康肉眼检查）
}

// kbGetFileChunks 查询单个文件已入库的全部切片（按确定性 ID 逐个 GetByID 归口；
// chromem-go v0.7.0 无文档列举 API，ID 含 chunk 序号可确定性还原）
func kbGetFileChunks(kbID uint, fileID uint, chunkCount int) []kbFileChunk {
	out := make([]kbFileChunk, 0, chunkCount)
	if kbVectorDB == nil || chunkCount <= 0 {
		return out
	}
	col, err := kbGetCollection(kbID)
	if err != nil {
		return out
	}
	ctx := context.Background()
	for i := 0; i < chunkCount; i++ {
		doc, err := col.GetByID(ctx, kbChunkID(kbID, fileID, i))
		if err != nil {
			continue // 个别切片缺失不阻断整体展示
		}
		// 阶段五十三：向量健康摘要（维度/范数/前 8 维预览）
		dim := len(doc.Embedding)
		norm := 0.0
		for _, v := range doc.Embedding {
			norm += float64(v) * float64(v)
		}
		norm = math.Sqrt(norm)
		head := doc.Embedding
		if len(head) > 8 {
			head = head[:8]
		}
		out = append(out, kbFileChunk{
			Chunk:   i,
			Content: doc.Content,
			Chars:   len([]rune(doc.Content)),
			Dim:     dim,
			Norm:    norm,
			Head:    head,
		})
	}
	return out
}

// kbEnsureFileIdle 文件重复处理防护：processing 状态拒绝再次触发重建（防双流水线并发写同 ID 文档）
func kbEnsureFileIdle(f *model.KBFile) bool {
	return f.Status != "processing"
}

// kbRebuildFile 单文件重新向量化归口：清旧向量 → 状态置 processing → 异步重跑流水线（磁盘原文件复用，无需重新上传）
// 调用方已校验 embedding 可用与文件空闲；返回 error 为同步校验错误（不落库）
func kbRebuildFile(fileID uint) error {
	var f model.KBFile
	if err := store.DB.First(&f, fileID).Error; err != nil {
		return fmt.Errorf("知识文件不存在")
	}
	if !kbEnsureFileIdle(&f) {
		return fmt.Errorf("文件正在向量化中，请稍后再试")
	}
	var kb model.KB
	if err := store.DB.First(&kb, f.KBID).Error; err != nil {
		return fmt.Errorf("所属知识库不存在")
	}
	// embedding 模型与建库时不一致：单文件向量维度可能与库不匹配，须走整库重建（报错归口提示）
	if kb.EmbedModel != "" && kb.EmbedModel != kbEmbedCfg.Model {
		return fmt.Errorf("embedding 模型已变更（库由 %s 建立，当前 %s），请使用整库重建", kb.EmbedModel, kbEmbedCfg.Model)
	}
	store.DB.Model(&model.KBFile{}).Where("id = ?", f.ID).Updates(map[string]interface{}{
		"status": "processing",
		"error":  "",
	})
	kbDeleteFileVectors(f.KBID, f.ID)
	go kbProcessFile(f.ID)
	logger.Info("知识文件重新向量化已启动 %s（id=%d，库 %s）", f.Name, f.ID, kb.Name)
	return nil
}

// kbRebuildKB 整库重建归口：清空向量集合 → 库维度/模型重置 → 全部文件状态置 processing →
// 后台单 goroutine 串行重跑各文件流水线（串行避免并发打爆 embedding 服务）
func kbRebuildKB(kbID uint) (int, error) {
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		return 0, fmt.Errorf("知识库不存在")
	}
	if !kbEmbedEnabled() {
		return 0, fmt.Errorf("embedding 服务未配置（config.yaml ai.embedding），无法重建")
	}
	// 处理中文件拒绝重建（防双流水线并发）
	var busy int64
	store.DB.Model(&model.KBFile{}).Where("kb_id = ? AND status = ?", kbID, "processing").Count(&busy)
	if busy > 0 {
		return 0, fmt.Errorf("有 %d 个文件正在向量化中，请等待完成后再重建", busy)
	}
	var files []model.KBFile
	store.DB.Where("kb_id = ?", kbID).Find(&files)
	if len(files) == 0 {
		return 0, fmt.Errorf("库内暂无文件，无需重建")
	}
	// 向量集合整体清除（下次 GetOrCreateCollection 自动重建空集合），库维度/模型重置
	kbDeleteKBCollection(kbID)
	store.DB.Model(&model.KB{}).Where("id = ?", kbID).Updates(map[string]interface{}{
		"dim":         0,
		"embed_model": "",
	})
	ids := make([]uint, 0, len(files))
	for _, f := range files {
		store.DB.Model(&model.KBFile{}).Where("id = ?", f.ID).Updates(map[string]interface{}{
			"status": "processing",
			"chunks": 0,
			"error":  "",
		})
		ids = append(ids, f.ID)
	}
	go func() {
		for _, id := range ids {
			kbProcessFile(id)
		}
		logger.Info("知识库整库重建完成 %s（id=%d，共 %d 个文件）", kb.Name, kbID, len(ids))
	}()
	logger.Info("知识库整库重建已启动 %s（id=%d，共 %d 个文件，串行处理）", kb.Name, kbID, len(ids))
	return len(files), nil
}

// ===== 阶段五十三：知识库数据微调（检索调试/切片编辑删除） =====

// kbDebugHit 检索调试命中（含阈值过滤与注入判定标注，管理端调参可视化）
type kbDebugHit struct {
	File          string  `json:"file"`
	Chunk         int     `json:"chunk"`
	Content       string  `json:"content"`
	Similarity    float32 `json:"similarity"`
	PassThreshold bool    `json:"pass_threshold"` // 是否达到相似度阈值（阈值 0=不过滤恒为 true）
	Inject        bool    `json:"inject"`         // 是否会被实际注入（阈值通过且排名在 topK 内）
}

// kbDebugQuery 管理端检索调试归口：单库返回 topK+余量 候选并逐条标注
// （被阈值过滤与被 topK 截断的候选也一并返回，让调参有数据依据，区别于对话链路的只返回最终命中）
func kbDebugQuery(kbID uint, query string) ([]kbDebugHit, *model.KB, error) {
	if !kbEmbedEnabled() {
		return nil, nil, fmt.Errorf("embedding 服务未配置（config.yaml ai.embedding）")
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("测试问题不能为空")
	}
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		return nil, nil, fmt.Errorf("知识库不存在")
	}
	qVecs, err := kbEmbed([]string{query})
	if err != nil || len(qVecs) == 0 || len(qVecs[0]) == 0 {
		return nil, nil, fmt.Errorf("问题向量化失败: %v", err)
	}
	qVec := qVecs[0]
	col, err := kbGetCollection(kb.ID)
	if err != nil {
		return nil, nil, err
	}
	count := col.Count()
	if count == 0 {
		return []kbDebugHit{}, &kb, nil
	}
	// 候选量 = topK + 10 余量（钳制到集合文档数）：把"被阈值过滤/被 topK 截断"的命中也翻出来
	n := kbTopK + 10
	if n > count {
		n = count
	}
	results, err := col.QueryEmbedding(context.Background(), qVec, n, nil, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("检索失败: %w", err)
	}
	// chromem-go 检索结果按相似度降序返回，rank 记录通过阈值后的排名（0 起）
	out := make([]kbDebugHit, 0, len(results))
	rank := 0
	for _, r := range results {
		chunkIdx, _ := strconv.Atoi(r.Metadata["chunk"])
		pass := kbScoreThreshold <= 0 || r.Similarity >= kbScoreThreshold
		hit := kbDebugHit{
			File:          r.Metadata["file"],
			Chunk:         chunkIdx,
			Content:       r.Content,
			Similarity:    r.Similarity,
			PassThreshold: pass,
		}
		if pass {
			hit.Inject = rank < kbTopK
			rank++
		}
		out = append(out, hit)
	}
	return out, &kb, nil
}

// kbChunkGuard 切片编辑/删除公共防护归口：文件就绪 + embedding 可用 + 库模型一致（单切片重嵌向量维度须与库一致）
// 返回文件、库记录与向量集合；任一不满足返回 error（管理端直接提示）
func kbChunkGuard(fileID uint) (*model.KBFile, *model.KB, *chromem.Collection, error) {
	var f model.KBFile
	if err := store.DB.First(&f, fileID).Error; err != nil {
		return nil, nil, nil, fmt.Errorf("知识文件不存在")
	}
	if f.Status != "ready" {
		return nil, nil, nil, fmt.Errorf("文件未就绪（处理中或失败），无法操作切片")
	}
	if !kbEnsureFileIdle(&f) {
		return nil, nil, nil, fmt.Errorf("文件正在向量化中，请稍后再试")
	}
	var kb model.KB
	if err := store.DB.First(&kb, f.KBID).Error; err != nil {
		return nil, nil, nil, fmt.Errorf("所属知识库不存在")
	}
	if !kbEmbedEnabled() {
		return nil, nil, nil, fmt.Errorf("embedding 服务未配置（config.yaml ai.embedding）")
	}
	// 与单文件重建同规：库由旧模型建立时单切片重嵌维度可能不匹配，须走整库重建
	if kb.EmbedModel != "" && kb.EmbedModel != kbEmbedCfg.Model {
		return nil, nil, nil, fmt.Errorf("embedding 模型已变更（库由 %s 建立，当前 %s），请使用整库重建", kb.EmbedModel, kbEmbedCfg.Model)
	}
	col, err := kbGetCollection(kb.ID)
	if err != nil {
		return nil, nil, nil, err
	}
	return &f, &kb, col, nil
}

// kbChunkEdit 编辑单切片文本：删旧片 → 重嵌新文 → 同 ID 写回（保留原 metadata 锚点与文件归属）
// 编辑仅作用于向量库层面，源文件不改动（整库/单文件重建会以源文件重新切片覆盖本次编辑）
func kbChunkEdit(fileID uint, chunkIdx int, content string) error {
	f, kb, col, err := kbChunkGuard(fileID)
	if err != nil {
		return err
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return fmt.Errorf("切片内容不能为空")
	}
	if chunkIdx < 0 || chunkIdx >= f.Chunks {
		return fmt.Errorf("切片序号超出范围（0-%d）", f.Chunks-1)
	}
	ctx := context.Background()
	oldID := kbChunkID(kb.ID, f.ID, chunkIdx)
	old, err := col.GetByID(ctx, oldID)
	if err != nil {
		return fmt.Errorf("切片不存在或未入库")
	}
	vectors, err := kbEmbed([]string{content})
	if err != nil {
		return err
	}
	vec := vectors[0]
	if kb.Dim != 0 && len(vec) != kb.Dim {
		return fmt.Errorf("向量维度不一致（库维度 %d，本次 %d）", kb.Dim, len(vec))
	}
	// 同 ID 删旧写新：metadata 原样保留（file_id/file/chunk 锚点不变，检索来源标注不漂移）
	if err := col.Delete(ctx, nil, nil, oldID); err != nil {
		return fmt.Errorf("删除旧切片失败: %w", err)
	}
	if err := col.AddDocument(ctx, chromem.Document{
		ID:        oldID,
		Metadata:  old.Metadata,
		Content:   content,
		Embedding: vec,
	}); err != nil {
		return fmt.Errorf("写回新切片失败: %w", err)
	}
	logger.Info("后台管理：编辑切片 %s（库 %s，%d 字 → %d 字）", oldID, kb.Name, len([]rune(old.Content)), len([]rune(content)))
	return nil
}

// kbChunkDelete 删除单切片；仅当删除末片时收缩 chunks 计数（中间片删除留空洞，
// 计数语义为"最大切片序号+1"，保证 kbGetFileChunks 按序号确定性还原的完整性）
func kbChunkDelete(fileID uint, chunkIdx int) error {
	f, kb, col, err := kbChunkGuard(fileID)
	if err != nil {
		return err
	}
	if chunkIdx < 0 || chunkIdx >= f.Chunks {
		return fmt.Errorf("切片序号超出范围（0-%d）", f.Chunks-1)
	}
	oldID := kbChunkID(kb.ID, f.ID, chunkIdx)
	if _, err := col.GetByID(context.Background(), oldID); err != nil {
		return fmt.Errorf("切片不存在或未入库")
	}
	if err := col.Delete(context.Background(), nil, nil, oldID); err != nil {
		return fmt.Errorf("删除切片失败: %w", err)
	}
	// 末片删除联动收缩计数（中间片删除计数不动，列表按序号还原时自动跳过空洞）
	if chunkIdx == f.Chunks-1 {
		store.DB.Model(&model.KBFile{}).Where("id = ?", f.ID).Update("chunks", f.Chunks-1)
	}
	logger.Info("后台管理：删除切片 %s（库 %s，文件 %s）", oldID, kb.Name, f.Name)
	return nil
}
