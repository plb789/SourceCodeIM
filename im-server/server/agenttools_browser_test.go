package server

import (
	"strings"
	"testing"

	"im-server/config"
)

// browserEnable 打开内置浏览器工具开关（用后还原）
func browserEnable(t *testing.T) {
	t.Helper()
	prev := agentBrowserEnabled.Load()
	agentBrowserEnabled.Store(true)
	t.Cleanup(func() { agentBrowserEnabled.Store(prev) })
}

// browserPcClient 注册在线 PC 连接（用后还原）
func browserPcClient(t *testing.T, s *Server, username string) *Client {
	t.Helper()
	c := &Client{server: s, username: username, platform: "pc", sendCh: make(chan []byte, 8)}
	s.hub.Add(c)
	t.Cleanup(func() { s.hub.Remove(c) })
	return c
}

// TestAgentBrowserApprovalLabel 内置浏览器工具审批分级与展示名：只读/导航/tab 管理免审批，
// click/input/eval 逐次审批；label 走「内置浏览器 · X」归口
func TestAgentBrowserApprovalLabel(t *testing.T) {
	free := []string{"browser_navigate", "browser_snapshot", "browser_screenshot", "browser_tabs", "browser_close"}
	for _, tool := range free {
		if need, _ := agentBrowserNeedsApproval(tool); need {
			t.Fatalf("%s 应免审批", tool)
		}
		if need, _ := agentNeedsApproval("alice", tool, nil); need {
			t.Fatalf("%s 应免审批（agentNeedsApproval 归口）", tool)
		}
	}
	risky := map[string]string{
		"browser_click": "点击",
		"browser_input": "输入框",
		"browser_eval":  "JavaScript",
	}
	for tool, kw := range risky {
		need, reason := agentNeedsApproval("alice", tool, nil)
		if !need || !strings.Contains(reason, kw) {
			t.Fatalf("%s 应需审批且提示含 %q: %v %q", tool, kw, need, reason)
		}
	}
	if l := agentBrowserLabel("browser_navigate"); !strings.HasPrefix(l, "内置浏览器") {
		t.Fatalf("label 应带内置浏览器前缀: %q", l)
	}
	if l := agentToolLabel("alice", "browser_eval"); l != "内置浏览器 · 执行脚本" {
		t.Fatalf("label 归口不符: %q", l)
	}
}

// TestAgentBrowserDefsSchema 工具定义 schema 合规：8 个工具、名称唯一、参数为合法结构
func TestAgentBrowserDefsSchema(t *testing.T) {
	defs := agentBrowserToolDefs()
	if len(defs) != len(agentBrowserTools) {
		t.Fatalf("定义数量与工具集合不符: %d vs %d", len(defs), len(agentBrowserTools))
	}
	seen := map[string]bool{}
	for _, d := range defs {
		name, _ := d.Function["name"].(string)
		if !agentBrowserTools[name] || seen[name] {
			t.Fatalf("工具名非法或重复: %q", name)
		}
		seen[name] = true
		if _, ok := d.Function["parameters"].(map[string]interface{}); !ok {
			t.Fatalf("%s 缺 parameters", name)
		}
		if desc, _ := d.Function["description"].(string); len(desc) < 10 {
			t.Fatalf("%s 描述缺失", name)
		}
	}
}

// TestAgentBrowserInjectionGate 注入闸门：开关关/PC 执行器关/PC 离线不注入；全开时
// agentToolDefinitions 全链路合并 browser_* 定义
func TestAgentBrowserInjectionGate(t *testing.T) {
	browserEnable(t)
	prevExec := agentPcExec.Load()
	agentPcExec.Store(true)
	t.Cleanup(func() { agentPcExec.Store(prevExec) })
	s := NewServer(&config.Config{})
	browserPcClient(t, s, "alice")

	// 开关关闭：不注入
	agentBrowserEnabled.Store(false)
	if defs := browserDefsIn(s.agentToolDefinitions("alice")); len(defs) != 0 {
		t.Fatalf("开关关闭不应注入: %d", len(defs))
	}
	// PC 离线：不注入
	agentBrowserEnabled.Store(true)
	if defs := browserDefsIn(s.agentToolDefinitions("bob")); len(defs) != 0 {
		t.Fatalf("PC 离线用户不应注入: %d", len(defs))
	}
	// 开关开 + PC 执行器开 + PC 在线：8 个全注入
	if defs := browserDefsIn(s.agentToolDefinitions("alice")); len(defs) != len(agentBrowserTools) {
		t.Fatalf("注入数量不符: %d", len(defs))
	}
}

// TestAgentBrowserServerOnlyFallback serverOnly 恒 false（PC 本地执行）+ 服务端兜底报错语义
func TestAgentBrowserServerOnlyFallback(t *testing.T) {
	for tool := range agentBrowserTools {
		if agentToolServerOnly(tool) {
			t.Fatalf("%s 不应判定为服务端执行", tool)
		}
	}
	// 开关开：兜底报 PC 离线
	browserEnable(t)
	if msg := agentBrowserPcFallbackMsg("browser_navigate"); !strings.Contains(msg, "PC 端在线") {
		t.Fatalf("兜底报错语义不符: %q", msg)
	}
	// 开关关：报功能关闭
	agentBrowserEnabled.Store(false)
	if msg := agentBrowserPcFallbackMsg("browser_navigate"); !strings.Contains(msg, "已关闭") {
		t.Fatalf("关闭态兜底报错不符: %q", msg)
	}
	// 非 browser 工具返回空串（不影响其他工具路由）
	if msg := agentBrowserPcFallbackMsg("read_file"); msg != "" {
		t.Fatalf("非浏览器工具不应命中兜底: %q", msg)
	}
	// URL 协议白名单快检
	if agentBrowserURLAllowed("file:///C:/Windows") || agentBrowserURLAllowed("javascript:alert(1)") {
		t.Fatal("file/javascript 协议应拒绝")
	}
	if !agentBrowserURLAllowed("https://example.com") || !agentBrowserURLAllowed("http://example.com") {
		t.Fatal("http/https 应放行")
	}
}

// browserDefsIn 从工具定义列表中筛出 browser_*
func browserDefsIn(defs []aiToolDefinition) []aiToolDefinition {
	out := make([]aiToolDefinition, 0, 8)
	for _, d := range defs {
		if name, _ := d.Function["name"].(string); agentBrowserTools[name] {
			out = append(out, d)
		}
	}
	return out
}
