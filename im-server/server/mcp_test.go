package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"im-server/model"
)

// mcpTestSession 进程内构建真实 MCP 会话（SDK in-memory 传输，协议栈全真）：
// 服务端带 echo（正常回显）与 boom（isError 结果）两个工具，供核心链路实测
func mcpTestSession(t *testing.T) *mcp.ClientSession {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "test-srv-proc", Version: "1.0"}, nil)
	server.AddTool(&mcp.Tool{
		Name:        "echo",
		Description: "回显测试",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"msg":{"type":"string"}},"required":["msg"]}`),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var args struct {
			Msg string `json:"msg"`
		}
		_ = json.Unmarshal(req.Params.Arguments, &args)
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "echo:" + args.Msg}}}, nil
	})
	server.AddTool(&mcp.Tool{
		Name:        "boom",
		Description: "报错测试",
		InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "故意的错误"}}}, nil
	})
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	srvSess, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("测试 MCP 服务端连接失败: %v", err)
	}
	cliSess, err := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1.0"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		_ = srvSess.Close()
		t.Fatalf("测试 MCP 客户端连接失败: %v", err)
	}
	t.Cleanup(func() {
		_ = cliSess.Close()
		_ = srvSess.Close()
	})
	return cliSess
}

// mcpInjectEntry 向运行时注入测试条目（模拟 reloadMCPServers 建连后的内存态，不触碰 DB）
func mcpInjectEntry(t *testing.T, name string, rec model.MCPServer, sess *mcp.ClientSession, tools []mcpToolInfo) {
	t.Helper()
	rec.Name = name
	e := &mcpClientEntry{
		rec:     rec,
		quit:    make(chan struct{}),
		session: sess,
		status:  mcpStatusConnected,
		tools:   tools,
	}
	mcpMu.Lock()
	prev, had := mcpEntries[name]
	mcpEntries[name] = e
	mcpMu.Unlock()
	t.Cleanup(func() {
		mcpMu.Lock()
		if had {
			mcpEntries[name] = prev
		} else {
			delete(mcpEntries, name)
		}
		mcpMu.Unlock()
	})
}

// TestMCPToolKey 工具命名空间化命名：合法名直通、非法字符规整、规整冲突靠哈希后缀区分、总长合规
func TestMCPToolKey(t *testing.T) {
	if got := mcpToolKey("server-a", "echo"); got != "mcp_server-a_echo" {
		t.Fatalf("常规名应直通，实际 %q", got)
	}
	// 中文/空格规整后同形：不同原名必须产出不同 key（哈希后缀区分）
	k1 := mcpToolKey("服 务A", "echo")
	k2 := mcpToolKey("服_务A", "echo")
	if k1 == k2 {
		t.Fatalf("规整同形的原名必须以哈希后缀区分，实际均为 %q", k1)
	}
	// 超长名截断 + 后缀，且总长不超过 64
	long := mcpToolKey(strings.Repeat("长", 40), strings.Repeat("t", 60))
	if len(long) > 64 {
		t.Fatalf("key 超长：%d", len(long))
	}
	// 合法字符集校验
	for _, r := range long {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			t.Fatalf("key 含非法字符 %q：%q", r, long)
		}
	}
}

// TestMCPJSONFields JSON 存储字段解析边界（空值/坏值优雅归零）
func TestMCPJSONFields(t *testing.T) {
	args, err := mcpParseArgs("")
	if err != nil || args != nil {
		t.Fatalf("空 args 应归零无错: %v %v", args, err)
	}
	if _, err := mcpParseArgs("{bad"); err == nil {
		t.Fatal("坏 JSON 应报错")
	}
	kv, err := mcpParseKV("null")
	if err != nil || kv != nil {
		t.Fatalf("null 应归零无错: %v %v", kv, err)
	}
	set := mcpDisabledSet(`["a", " b ", ""]`)
	if !set["a"] || !set["b"] || len(set) != 2 {
		t.Fatalf("禁用清单解析不符: %v", set)
	}
	if len(mcpDisabledSet("x")) != 0 {
		t.Fatal("坏禁用清单应归零")
	}
}

// TestMCPCoreE2E 核心链路实测：工具发现 → OpenAI 定义注入 → 路由反查 → 调用 → isError → 禁用
func TestMCPCoreE2E(t *testing.T) {
	sess := mcpTestSession(t)

	// 工具发现（含分页归口）
	tools, err := mcpListTools(sess, 5*time.Second)
	if err != nil {
		t.Fatalf("工具发现失败: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("期望发现 2 个工具，实际 %d：%v", len(tools), tools)
	}

	const srvName = "测试服务器A"
	mcpInjectEntry(t, srvName, model.MCPServer{Transport: mcpTransportStdio, Enabled: true}, sess, tools)

	// OpenAI function 定义注入：命名空间化 key 存在且字符集合法
	defs := mcpOpenAIToolDefinitions()
	echoKey := mcpToolKey(srvName, "echo")
	var echoDef map[string]interface{}
	for _, d := range defs {
		if d.Function["name"] == echoKey {
			echoDef = d.Function
		}
	}
	if echoDef == nil {
		t.Fatalf("工具定义未注入 echo（key=%s），实际 %d 个", echoKey, len(defs))
	}
	if echoDef["description"] != "回显测试" {
		t.Fatalf("工具描述不符: %v", echoDef["description"])
	}

	// 路由反查：注入名 → 服务器+原始工具名
	gotSrv, gotTool, ok := mcpRouteToolKey(echoKey)
	if !ok || gotSrv != srvName || gotTool != "echo" {
		t.Fatalf("路由反查不符: %q %q %v", gotSrv, gotTool, ok)
	}
	if _, _, ok := mcpRouteToolKey("mcp_unknown_tool"); ok {
		t.Fatal("未知 key 不应路由成功")
	}

	// 正常调用（中文参数透传）
	out, err := mcpCallTool(srvName, "echo", map[string]interface{}{"msg": "你好"})
	if err != nil || out != "echo:你好" {
		t.Fatalf("工具调用不符: out=%q err=%v", out, err)
	}

	// isError 结果以 error 返回且附错误正文
	if _, err = mcpCallTool(srvName, "boom", map[string]interface{}{}); err == nil || !strings.Contains(err.Error(), "工具返回错误") || !strings.Contains(err.Error(), "故意的错误") {
		t.Fatalf("isError 处理不符: %v", err)
	}

	// 未知服务器 / 未知工具
	if _, err = mcpCallTool("no-such-server", "echo", nil); err == nil {
		t.Fatal("未知服务器应报错")
	}
	if _, err = mcpCallTool(srvName, "no-such-tool", nil); err == nil {
		t.Fatal("未知工具应报错")
	}

	// 单工具禁用（TRAE 同款 per-tool 开关）
	mcpEntries[srvName].mu.Lock()
	mcpEntries[srvName].rec.DisabledTools = `["echo"]`
	mcpEntries[srvName].mu.Unlock()
	if _, err = mcpCallTool(srvName, "echo", nil); err == nil || !strings.Contains(err.Error(), "已被禁用") {
		t.Fatalf("禁用工具应拒绝调用: %v", err)
	}
	// 禁用工具不出现在注入定义里
	for _, d := range mcpOpenAIToolDefinitions() {
		if d.Function["name"] == echoKey {
			t.Fatal("禁用工具不应注入定义")
		}
	}
}

// TestMCPValidateReq 请求校验归口（不触碰 DB 的路径）
func TestMCPValidateReq(t *testing.T) {
	// 空名拒绝
	if _, err := mcpValidateReq(&adminMCPServerReq{Transport: "stdio", Command: "npx"}, 0, false); err == nil {
		t.Fatal("空名应拒绝")
	}
	// stdio 缺 command
	if _, err := mcpValidateReq(&adminMCPServerReq{Name: "a", Transport: "stdio"}, 0, false); err == nil {
		t.Fatal("stdio 缺 command 应拒绝")
	}
	// sse 缺合法 url
	if _, err := mcpValidateReq(&adminMCPServerReq{Name: "a", Transport: "sse", URL: "ftp://x"}, 0, false); err == nil {
		t.Fatal("非法 url 应拒绝")
	}
	// 合法 stdio：args/env 序列化入库、未知传输回退 stdio
	rec, err := mcpValidateReq(&adminMCPServerReq{
		Name: "a", Transport: "weird", Command: " npx ", Args: []string{"-y", "pkg"},
		Env: map[string]string{"K": "V"}, Enabled: nil,
	}, 0, false)
	if err != nil {
		t.Fatalf("合法请求被拒: %v", err)
	}
	if rec.Transport != mcpTransportStdio {
		t.Fatalf("未知传输应回退 stdio，实际 %q", rec.Transport)
	}
	if rec.Command != "npx" || rec.Args != `["-y","pkg"]` || rec.Env != `{"K":"V"}` {
		t.Fatalf("字段归整不符: %+v", rec)
	}
	if !rec.Enabled {
		t.Fatal("Enabled 缺省应为 true")
	}
	if rec.Owner != "" {
		t.Fatal("Owner 应强制为空（用户自建随阶段八十九开放）")
	}
}

// mcpEchoServerScript 极简真实 MCP stdio 服务器（零依赖 node 脚本，NDJSON JSON-RPC 全真协议）：
// 提供 add 工具（两数相加），initialize 回显客户端请求的协议版本（最广泛兼容的握手应答）
func mcpEchoServerScript() string {
	return `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-test', version: '0.0.1' }
    }});
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'add', description: 'add two numbers',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
    }]}});
  } else if (msg.method === 'tools/call') {
    const a = Number(msg.params.arguments.a), b = Number(msg.params.arguments.b);
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.resume();
`
}

// mcpWaitStatus 轮询等待条目状态（连接循环为异步 goroutine，事件驱动断言归口）
func mcpWaitStatus(t *testing.T, e *mcpClientEntry, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		status, tools := e.status, len(e.tools)
		e.mu.Unlock()
		if status == want && (want != mcpStatusConnected || tools > 0) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	t.Fatalf("等待状态 %s 超时（%s）：%s（%s），工具 %d", want, timeout, e.status, e.statusMsg, len(e.tools))
}

// TestMCPStdioRealProcess 真实 stdio 子进程集成实测（TRAE 同款拉起本地 MCP 服务器场景）：
// 1) node 直连；2) Windows .cmd 批处理脚本中转（cmd /c 分支）；3) 命令不存在时 error 状态与明确报错
func TestMCPStdioRealProcess(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("本机未安装 node，跳过真实 stdio 集成测试")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "mcp-echo-server.js")
	if err := os.WriteFile(script, []byte(mcpEchoServerScript()), 0o644); err != nil {
		t.Fatalf("写测试脚本失败: %v", err)
	}
	// .cmd 包装脚本（Windows 批处理启动分支实测）
	cmdScript := filepath.Join(dir, "mcp-echo-cmd-test.cmd")
	if err := os.WriteFile(cmdScript, []byte("@node \""+script+"\" %*\r\n"), 0o644); err != nil {
		t.Fatalf("写测试 .cmd 失败: %v", err)
	}

	cases := []struct {
		name    string
		command string
		args    []string
	}{
		{"node直连", "node", []string{script}},
		{"cmd脚本中转", cmdScript, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			argsJSON, _ := json.Marshal(tc.args)
			e := &mcpClientEntry{
				rec:  model.MCPServer{Name: "stdio-real-" + tc.name, Transport: mcpTransportStdio, Command: tc.command, Args: string(argsJSON), Enabled: true},
				quit: make(chan struct{}),
			}
			// 注册进运行时表（mcpCallTool 按名查找归口），用后还原防污染其他用例
			mcpMu.Lock()
			prev, had := mcpEntries[e.rec.Name]
			mcpEntries[e.rec.Name] = e
			mcpMu.Unlock()
			t.Cleanup(func() {
				e.mcpStop()
				mcpMu.Lock()
				if had {
					mcpEntries[e.rec.Name] = prev
				} else {
					delete(mcpEntries, e.rec.Name)
				}
				mcpMu.Unlock()
			})
			go mcpServeLoop(e)
			mcpWaitStatus(t, e, mcpStatusConnected, 15*time.Second)
			// 经运行时条目调用工具（mcpCallTool 全链路：查找→会话→执行→结果拼接）
			out, err := mcpCallTool(e.rec.Name, "add", map[string]interface{}{"a": 2, "b": 3})
			if err != nil || strings.TrimSpace(out) != "5" {
				t.Fatalf("真实 stdio 工具调用不符: out=%q err=%v", out, err)
			}
		})
	}

	// 命令不存在：进入 error 状态并给出明确报错（退避重试中不悬挂）
	badJSON, _ := json.Marshal([]string{filepath.Join(dir, "mcp-echo-server.js")})
	e := &mcpClientEntry{
		rec:  model.MCPServer{Name: "stdio-real-bad", Transport: mcpTransportStdio, Command: "definitely-not-exist-xyz-123", Args: string(badJSON), Enabled: true},
		quit: make(chan struct{}),
	}
	go mcpServeLoop(e)
	t.Cleanup(e.mcpStop)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		status, msg := e.status, e.statusMsg
		e.mu.Unlock()
		if status == mcpStatusError && msg != "" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("命令不存在应进入 error 状态，实际 %s", e.status)
}
