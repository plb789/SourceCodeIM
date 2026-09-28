package server

// ===== 阶段一百七十四：工作区语义检索（semantic_search 工具，TRAE CN 同款按含义定位代码） =====
// 复用知识库向量设施：chromem-go 持久化库（kbVectorDB）+ OpenAI 兼容 /embeddings 批量嵌入（kbEmbed）
// + 知识库切片归口（kbSplitChunks）。每用户工作区一个 collection（ws_<username>），
// mtime 快照增量索引 + 搜索前惰性刷新（无快照=首次全量构建；embedding 模型变更=整 collection 重建）。
// 降级：embedding 未配置时工具返回明确指引改用 grep，不影响其他工具与任务执行。
// 边界：恒服务端执行（agentToolServerOnly）——嵌入调用在服务端归口；PC 本地执行的任务文件不经服务端
// 工作区，语义检索以服务端工作区为准（与 grep 在 PC 离线回退场景的口径一致）。

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/philippgille/chromem-go"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// 索引防护常量（工作区文件量级小，纯 Go 内存向量检索足够，无需外部向量服务）
const (
	semMaxFiles     = 500       // 单用户索引文件数上限（超出截断并在结果尾部提示）
	semMaxFileBytes = 200 << 10 // 单文件索引大小上限（200KB；grep 上限 2MB，此处再收窄防切片爆炸）
	semDefaultTopK  = 8         // 默认返回片段数
	semMaxTopK      = 30        // max_results 上限
	semContentRunes = 400       // 单片段展示字符上限（超出截断，全文用 read_file 读）
	semFileCap      = 3         // 单文件最多展示片段数（防同文件刷屏挤掉其他文件）
)

// semSnap 索引快照（per-user 内存态：重启后首查全量重建，开销可接受）
type semSnap struct {
	Model     string           `json:"model"`     // 构建时 embedding 模型（变更=向量维度不兼容，整库重建）
	Files     map[string]int64 `json:"files"`     // {工作区相对路径: mtimeUnixNano}（纳秒粒度：同秒内改写也要检出）
	Truncated bool             `json:"truncated"` // 扫描因文件数上限截断（true 时查询结果尾部提示覆盖面不全）
}

var (
	semMu    sync.Mutex              // 索引刷新串行化（构建频率低、量级小，全局锁足够）
	semSnaps = map[string]*semSnap{} // username → 快照
)

// semNameRe collection 名安全化（chromem 名约束保守处理，username 为注册名已较规整）
var semNameRe = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// agentSemCollectionName 语义检索 collection 命名归口（ws_ 前缀与知识库 kb_ 隔离）
func agentSemCollectionName(username string) string {
	return "ws_" + semNameRe.ReplaceAllString(username, "_")
}

// agentSemCollection 获取/创建工作区 collection（embeddingFunc 传 nil：入库自带向量，批量嵌入省请求）
// 复用 kbCollectionMu——chromem GetOrCreateCollection 内部 Get/Create 两段式无原子保护（阶段五十二教训）
func agentSemCollection(username string) (*chromem.Collection, error) {
	if kbVectorDB == nil {
		return nil, fmt.Errorf("向量库未初始化")
	}
	kbCollectionMu.Lock()
	defer kbCollectionMu.Unlock()
	return kbVectorDB.GetOrCreateCollection(agentSemCollectionName(username), nil, nil)
}

// semTextFile 判定文件是否为可索引文本：读头部 8KB 查 NUL（二进制不进索引也不进快照，
// mtime 变化后下次会再尝试，语义幂等）
func semTextFile(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 8<<10)
	n, _ := f.Read(buf)
	return n == 0 || bytes.IndexByte(buf[:n], 0) < 0
}

// agentSemScan 遍历工作区收集 {相对路径: mtime}（口径与 grep 对齐：跳过依赖/构建目录与超限大文件；
// 二进制文件头部 NUL 检测排除）
func agentSemScan(username string) (map[string]int64, bool, error) {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return nil, false, err
	}
	files := map[string]int64{}
	truncated := false
	count := 0
	walkErr := filepath.WalkDir(ws, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // 无权限/竞态删除等逐项跳过
		}
		if d.IsDir() {
			if p != ws && agentGrepSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if count >= semMaxFiles {
			truncated = true
			return fs.SkipAll
		}
		fi, ferr := d.Info()
		if ferr != nil || fi.Size() == 0 || fi.Size() > semMaxFileBytes {
			return nil
		}
		if !semTextFile(p) {
			return nil
		}
		rel, rerr := filepath.Rel(ws, p)
		if rerr != nil {
			return nil
		}
		files[filepath.ToSlash(rel)] = fi.ModTime().UnixNano() // 纳秒粒度（秒级粒度同秒改写检不出，实测踩坑）
		count++
		return nil
	})
	if walkErr != nil {
		return nil, truncated, walkErr
	}
	return files, truncated, nil
}

// agentSemDocID 文档 ID 归口：sem_<path哈希前12>_<chunkIdx>（同文件重建先按 path 删旧再入库，同 ID 无冲突）
func agentSemDocID(path string, idx int) string {
	sum := sha1.Sum([]byte(path))
	return "sem_" + hex.EncodeToString(sum[:])[:12] + "_" + fmt.Sprint(idx)
}

// agentSemChunk 语义检索单文件切片口径：按行聚合轻切片（复用 kbSplitChunks 会带表格表头继承等
// 知识库特化逻辑，代码文件直切更可控）——每 semChunkLines 行一片，行级边界不拦腰断语义
const semChunkLines = 40

func agentSemChunks(text string) []string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	chunks := make([]string, 0, len(lines)/semChunkLines+1)
	for start := 0; start < len(lines); start += semChunkLines {
		end := start + semChunkLines
		if end > len(lines) {
			end = len(lines)
		}
		if chunk := strings.TrimSpace(strings.Join(lines[start:end], "\n")); chunk != "" {
			chunks = append(chunks, chunk)
		}
	}
	return chunks
}

// agentSemRefresh 增量刷新索引（搜索前惰性调用；返回索引文件数与是否截断）。
// 差异三类：新增/变化（mtime 不同）→ 重嵌入入库；消失 → 按 path 过滤删除旧向量；
// embedding 模型变更 → DeleteCollection 全量重建（向量维度不兼容不可混存，知识库同语义）
func agentSemRefresh(username string) (int, bool, error) {
	semMu.Lock()
	defer semMu.Unlock()

	files, truncated, err := agentSemScan(username)
	if err != nil {
		return 0, truncated, err
	}
	snap := semSnaps[username]
	if snap == nil {
		snap = &semSnap{Files: map[string]int64{}}
	}

	col, err := agentSemCollection(username)
	if err != nil {
		return 0, truncated, err
	}
	if snap.Model != "" && snap.Model != kbEmbedCfg.Model {
		// 模型变更：删整库重建（快照清空 = 全部文件视为新增）
		if kbVectorDB != nil {
			_ = kbVectorDB.DeleteCollection(agentSemCollectionName(username))
		}
		col, err = agentSemCollection(username)
		if err != nil {
			return 0, truncated, err
		}
		snap.Files = map[string]int64{}
	}

	// 差异计算（removed/changed 排序保证删除先于重入库，行为可复现）
	var changed, removed []string
	for path, mt := range files {
		if old, ok := snap.Files[path]; !ok || old != mt {
			changed = append(changed, path)
		}
	}
	for path := range snap.Files {
		if _, ok := files[path]; !ok {
			removed = append(removed, path)
		}
	}
	sort.Strings(changed)
	sort.Strings(removed)

	for _, path := range removed {
		_ = col.Delete(context.Background(), map[string]string{"path": path}, nil)
	}

	// 变化文件：读文本（GBK 兜底）→ 切片 → 跨文件合并批量嵌入 → 一次性入库
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return 0, truncated, err
	}
	type fileChunks struct {
		path  string
		start int // 在合并 texts 中的起始下标
		count int
	}
	var texts []string
	var pend []fileChunks
	for _, path := range changed {
		data, rerr := os.ReadFile(filepath.Join(ws, filepath.FromSlash(path)))
		if rerr != nil {
			continue // 竞态删除等逐项跳过（快照按当前扫描结果写，下次不再重试）
		}
		text := string(data)
		if strings.ContainsRune(text, 0xFFFD) { // GBK 兜底（同 read_file/grep 口径）
			if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
				text = string(gbk)
			}
		}
		chunks := agentSemChunks(text)
		if len(chunks) == 0 {
			continue
		}
		_ = col.Delete(context.Background(), map[string]string{"path": path}, nil) // 先删旧片再入库
		pend = append(pend, fileChunks{path: path, start: len(texts), count: len(chunks)})
		texts = append(texts, chunks...)
	}
	if len(texts) > 0 {
		vecs, err := kbEmbed(texts)
		if err != nil {
			return 0, truncated, fmt.Errorf("索引向量化失败: %w", err)
		}
		for _, fc := range pend {
			docs := make([]chromem.Document, 0, fc.count)
			for i := 0; i < fc.count; i++ {
				docs = append(docs, chromem.Document{
					ID: agentSemDocID(fc.path, i),
					Metadata: map[string]string{
						"path":  fc.path,
						"chunk": fmt.Sprint(i),
					},
					Content:   texts[fc.start+i],
					Embedding: vecs[fc.start+i],
				})
			}
			if err := col.AddDocuments(context.Background(), docs, 2); err != nil {
				return 0, truncated, fmt.Errorf("索引入库失败: %w", err)
			}
		}
	}

	// 快照落内存（按本次扫描结果写：二进制/超限文件不入快照，mtime 变化会再尝试）
	semSnaps[username] = &semSnap{Model: kbEmbedCfg.Model, Files: files, Truncated: truncated}
	return len(files), truncated, nil
}

// agentToolSemanticSearch 语义检索工具执行归口：查询向量化 → 余弦 TopK → path 过滤/单文件限流 →
// 「【路径】相似度 + 片段」文本返回。embedding 未配置时明确指引降级 grep
func agentToolSemanticSearch(t *AgentTask, params map[string]interface{}) string {
	if !kbEmbedEnabled() {
		return "错误：语义检索未启用（服务端未配置 ai.embedding 向量服务），请改用 grep 按关键字搜索"
	}
	query := strings.TrimSpace(agentParamString(params["query"]))
	if query == "" {
		return "错误：query 不能为空"
	}
	pathFilter := strings.Trim(agentParamString(params["path"]), `/`)
	topK := semDefaultTopK
	if v, ok := params["max_results"].(float64); ok && v >= 1 {
		topK = int(v)
		if topK > semMaxTopK {
			topK = semMaxTopK
		}
	}

	_, scanTrunc, err := agentSemRefresh(t.Username)
	if err != nil {
		return "错误：语义索引刷新失败 " + err.Error()
	}
	col, err := agentSemCollection(t.Username)
	if err != nil {
		return "错误：" + err.Error()
	}
	count := col.Count()
	if count == 0 {
		return "（索引为空：工作区尚无可索引的文本文件）"
	}

	qVecs, err := kbEmbed([]string{query})
	if err != nil {
		return "错误：查询向量化失败 " + err.Error()
	}
	n := topK * 3 // 多取候选供 path 过滤与单文件限流收敛
	if n > count {
		n = count
	}
	results, err := col.QueryEmbedding(context.Background(), qVecs[0], n, nil, nil)
	if err != nil {
		return "错误：语义检索失败 " + err.Error()
	}
	// 显式按相似度降序（不依赖 chromem 返回序保证，输出排名稳定；知识库检索 kbSearch 同款防御）
	sort.Slice(results, func(i, j int) bool { return results[i].Similarity > results[j].Similarity })

	var b strings.Builder
	shown := 0
	fileHits := map[string]int{}
	for _, r := range results {
		p := r.Metadata["path"]
		if pathFilter != "" && p != pathFilter && !strings.HasPrefix(p, pathFilter+"/") {
			continue // 限定子目录：路径前缀过滤
		}
		if r.Similarity <= 0 {
			continue // 正交/负相关 = 无语义相关性，不展示（真实嵌入相关内容恒为正相似度）
		}
		if fileHits[p] >= semFileCap {
			continue
		}
		if shown >= topK {
			break
		}
		fileHits[p]++
		shown++
		content := []rune(strings.TrimSpace(r.Content))
		if len(content) > semContentRunes {
			content = append(content[:semContentRunes], []rune("…")...)
		}
		fmt.Fprintf(&b, "【%s】相似度 %.3f\n%s\n\n", p, r.Similarity, string(content))
	}
	if shown == 0 {
		return "（无语义匹配结果，可换个描述或用 grep 按关键字搜索）"
	}
	if scanTrunc {
		b.WriteString("\n（提示：工作区文件数超过索引上限，仅索引了部分文件，结果可能不全）")
	}
	return strings.TrimRight(b.String(), "\n")
}
