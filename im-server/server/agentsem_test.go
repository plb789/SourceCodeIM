package server

// 阶段一百七十四：工作区语义检索单测（不依赖外部 embedding 服务——httptest 起假 /embeddings，
// 词袋向量使相似度可断言）。覆盖：切片口径（40 行/片、CRLF 归一）、扫描口径（跳依赖目录、
// 二进制 NUL 排除、超限大文件排除）、快照增量（新增/删除/修改后检索结果跟随）、
// path 前缀过滤与 max_results 限流、embedding 未配置降级指引、模型变更整库重建。

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/philippgille/chromem-go"

	"im-server/config"
)

// semTestVocab 词袋词典（测试用向量：统计词频后 L2 归一化，同词文本方向相近，相似度可断言）
var semTestVocab = []string{"登录", "心跳", "数据库", "缓存", "网络", "配置", "文件", "删除"}

func semTestEmbed(text string) []float32 {
	vec := make([]float32, len(semTestVocab))
	for i, w := range semTestVocab {
		vec[i] = float32(strings.Count(text, w))
	}
	var sum float32
	for _, v := range vec {
		sum += v * v
	}
	if sum == 0 {
		vec[0] = 1e-6 // 零向量保护（余弦计算防 NaN）
		sum = vec[0] * vec[0]
	}
	inv := float32(1 / math.Sqrt(float64(sum)))
	for i := range vec {
		vec[i] *= inv
	}
	return vec
}

// semTestEmbedServer 假 OpenAI 兼容 /embeddings 接口（按词袋词典向量化请求 input）
func semTestEmbedServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Input []string `json:"input"`
		}
		_ = json.Unmarshal(body, &req)
		type embItem struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		}
		data := make([]embItem, len(req.Input))
		for i, text := range req.Input {
			data[i] = embItem{Index: i, Embedding: semTestEmbed(text)}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
	}))
}

// semTestSetup 语义检索测试环境归口：隔离工作区/向量库/嵌入配置，返回任务对象
func semTestSetup(t *testing.T, user string) (*AgentTask, string) {
	t.Helper()
	oldRoot, oldDB, oldCfg := agentWorkRoot, kbVectorDB, kbEmbedCfg
	oldSnap := semSnaps[user]
	t.Cleanup(func() {
		agentWorkRoot, kbVectorDB, kbEmbedCfg = oldRoot, oldDB, oldCfg
		semMu.Lock()
		if oldSnap != nil {
			semSnaps[user] = oldSnap
		} else {
			delete(semSnaps, user)
		}
		semMu.Unlock()
	})
	agentWorkRoot = t.TempDir()
	db, err := chromem.NewPersistentDB(filepath.Join(t.TempDir(), "vectors"), false)
	if err != nil {
		t.Fatal(err)
	}
	kbVectorDB = db
	semMu.Lock()
	delete(semSnaps, user)
	semMu.Unlock()
	// 注意返回用户工作区目录（agentWorkspaceDir = agentWorkRoot/<用户目录>），非工作区根本身
	ws, err := agentWorkspaceDir(user)
	if err != nil {
		t.Fatal(err)
	}
	return &AgentTask{ID: "semtest_" + user, Username: user}, ws
}

func TestAgentSemChunks(t *testing.T) {
	// CRLF 归一 + 40 行/片 + 空片剔除
	var sb strings.Builder
	for i := 0; i < 85; i++ {
		fmt.Fprintf(&sb, "line%d\r\n", i+1)
	}
	chunks := agentSemChunks(sb.String())
	if len(chunks) != 3 { // 40+40+5
		t.Fatalf("85 行应切 3 片，实际 %d", len(chunks))
	}
	if strings.Contains(chunks[0], "\r") {
		t.Fatal("切片应归一 CRLF")
	}
	if !strings.HasPrefix(chunks[0], "line1\n") || !strings.HasSuffix(chunks[0], "line40") {
		t.Fatalf("第 1 片边界不符：%q…%q", chunks[0][:24], chunks[0][len(chunks[0])-12:])
	}
	if !strings.HasPrefix(chunks[1], "line41\n") || !strings.HasSuffix(chunks[1], "line80") {
		t.Fatalf("第 2 片边界不符")
	}
	if !strings.HasPrefix(chunks[2], "line81\n") || !strings.HasSuffix(chunks[2], "line85") {
		t.Fatalf("第 3 片边界不符：%q", chunks[2])
	}
	if got := agentSemChunks("   \n \n "); len(got) != 0 {
		t.Fatalf("纯空白应切 0 片，实际 %d", len(got))
	}
}

func TestAgentSemScan(t *testing.T) {
	_, ws := semTestSetup(t, "semscan1")
	if err := os.MkdirAll(filepath.Join(ws, "skipdir", "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"a.txt":               "登录鉴权",
		"sub/c.txt":           "数据库配置",
		"bin.dat":             "PK\x00\x03\x00\x00binary", // NUL 头部 → 二进制排除
		"node_modules/pkg.js": "登录",                       // 依赖目录排除
	}
	for rel, content := range files {
		p := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 超限大文件（200KB+1）排除
	big := strings.Repeat("登录", 100<<10+1)
	if err := os.WriteFile(filepath.Join(ws, "big.txt"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}

	got, truncated, err := agentSemScan("semscan1")
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("11 个文件不应触发截断")
	}
	if len(got) != 2 || got["a.txt"] <= 0 || got["sub/c.txt"] <= 0 { // filepath.WalkDir 词序：node_modules 在 a.txt 前被 SkipDir
		t.Fatalf("仅 a.txt 与 sub/c.txt 应入快照，实际 %v", got)
	}
	for _, want := range []string{"bin.dat", "big.txt", "node_modules/pkg.js"} {
		if _, ok := got[want]; ok {
			t.Fatalf("%s 不应入快照（二进制/超限/依赖目录）", want)
		}
	}
}

func TestAgentSemanticSearchEndToEnd(t *testing.T) {
	ts := semTestEmbedServer()
	defer ts.Close()
	task, ws := semTestSetup(t, "semsearch1")
	kbEmbedCfg = config.EmbeddingConfig{APIURL: ts.URL, Model: "test-model", BatchSize: 2}

	// 预置三个语义不同的文件 + 一个子目录文件
	files := map[string]string{
		"a.txt":     "用户登录鉴权逻辑\n校验账号密码\n签发 token 完成登录",
		"b.txt":     "WebSocket 心跳处理\n定时 ping pong 维持心跳\n心跳超时断线重连",
		"sub/c.txt": "数据库连接池配置\nmysql dsn 配置\n数据库最大连接数",
	}
	for rel, content := range files {
		p := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	search := func(query string, extra map[string]interface{}) string {
		t.Helper()
		params := map[string]interface{}{"query": query}
		for k, v := range extra {
			params[k] = v
		}
		return agentToolSemanticSearch(task, params)
	}

	// 1. 首查触发全量构建：登录 query 命中 a.txt；无关文件（正交向量相似度 0）应被过滤
	out := search("登录鉴权是怎么实现的", nil)
	if !strings.Contains(out, "a.txt") {
		t.Fatalf("登录 query 应命中 a.txt：%s", out)
	}
	if got := strings.Count(out, "【"); got != 1 {
		t.Fatalf("无关文件应被相似度过滤，仅 a.txt 命中，实际 %d 个：%s", got, out)
	}

	// 2. 增量：删 b.txt + 新增 d.txt → 心跳无结果、缓存命中 d.txt（旧向量已按 path 删除）
	if err := os.Remove(filepath.Join(ws, "b.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "d.txt"), []byte("进程内缓存实现\n缓存过期淘汰策略"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := search("心跳超时怎么处理", nil); !strings.Contains(out, "无语义匹配结果") {
		t.Fatalf("b.txt 删除后心跳 query 应无结果：%s", out)
	}
	if out := search("缓存淘汰策略在哪", nil); !strings.Contains(out, "d.txt") {
		t.Fatalf("缓存 query 应命中新增 d.txt：%s", out)
	}

	// 3. 修改文件内容 → 语义跟随更新（c.txt 改为纯网络主题）
	if err := os.WriteFile(filepath.Join(ws, "sub/c.txt"), []byte("网络代理转发\n反向代理网络配置"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := search("数据库连接池", nil); strings.Contains(out, "sub/c.txt") {
		t.Fatalf("c.txt 改主题后数据库 query 不应再命中：%s", out)
	}
	if out := search("网络代理转发逻辑", nil); !strings.Contains(out, "sub/c.txt") {
		t.Fatalf("网络 query 应命中修改后的 c.txt：%s", out)
	}

	// 4. path 前缀过滤：限定 sub 只检索子目录
	out = search("网络代理", map[string]interface{}{"path": "sub"})
	if !strings.Contains(out, "sub/c.txt") || strings.Contains(out, "【a.txt") {
		t.Fatalf("path=sub 应只命中子目录：%s", out)
	}

	// 5. max_results 限流：单结果
	out = search("网络代理", map[string]interface{}{"max_results": 1})
	if got := strings.Count(out, "【"); got != 1 {
		t.Fatalf("max_results=1 应只返回 1 片，实际 %d：%s", got, out)
	}

	// 6. 模型变更 → 整库重建（向量维度不变仍可检索，不报错）
	kbEmbedCfg.Model = "other-model"
	if out := search("缓存淘汰", nil); !strings.Contains(out, "d.txt") {
		t.Fatalf("模型变更重建后检索应正常：%s", out)
	}

	// 7. 参数校验：空 query
	if out := search("  ", nil); !strings.Contains(out, "query 不能为空") {
		t.Fatalf("空 query 应报错：%s", out)
	}
}

func TestAgentSemanticSearchDisabled(t *testing.T) {
	task, _ := semTestSetup(t, "semoff1")
	// kbVectorDB 已被 setup 置为可用，此处关闭 embedding 配置模拟未配置
	oldCfg := kbEmbedCfg
	kbEmbedCfg = config.EmbeddingConfig{}
	t.Cleanup(func() { kbEmbedCfg = oldCfg })

	out := agentToolSemanticSearch(task, map[string]interface{}{"query": "登录"})
	if !strings.Contains(out, "语义检索未启用") || !strings.Contains(out, "grep") {
		t.Fatalf("未配置 embedding 应返回降级指引：%s", out)
	}
}
