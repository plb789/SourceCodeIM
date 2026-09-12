package server

import (
	"encoding/json"
	"strings"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/protocol"
)

// pctoolsSeed 向运行时注册用户本机 MCP 工具清单快照（用后还原防污染其他用例）
func pctoolsSeed(t *testing.T, username string, tools []AgentPcTool) {
	t.Helper()
	agentPcToolStore.Store(username, &agentPcToolSet{tools: tools})
	t.Cleanup(func() { agentPcToolStore.Delete(username) })
}

// pctoolsEnable 打开本机工具注入前置开关（agentPcExec + mcp 双闸门），用后还原
func pctoolsEnable(t *testing.T) {
	t.Helper()
	prevExec := agentPcExec.Load()
	agentPcExec.Store(true)
	mcpMu.Lock()
	prevEnabled, prevUser := mcpSet.Enabled, mcpSet.UserEnabled
	mcpSet.Enabled, mcpSet.UserEnabled = true, true
	mcpMu.Unlock()
	t.Cleanup(func() {
		agentPcExec.Store(prevExec)
		mcpMu.Lock()
		mcpSet.Enabled, mcpSet.UserEnabled = prevEnabled, prevUser
		mcpMu.Unlock()
	})
}

// pctoolsSnapshot 直接读运行时存储快照（绕过 PC 在线性校验，供清洗断言用）
func pctoolsSnapshot(username string) []AgentPcTool {
	if v, ok := agentPcToolStore.Load(username); ok {
		return v.(*agentPcToolSet).tools
	}
	return nil
}

// TestAgentPcToolKeyConsistency 本机工具注入名与服务端 mcpToolKey 同一算法（PC 端
// mcp-manager.js pcToolKey 按同名算法上报，两端不一致即路由错位）：mcp_pc_ 前缀、
// 常规名直通、规整同形原名哈希区分、总长 ≤64 且字符集合规
func TestAgentPcToolKeyConsistency(t *testing.T) {
	if got := agentPcToolKey("files", "read"); got != "mcp_pc_files_read" {
		t.Fatalf("常规名应直通，实际 %q", got)
	}
	if agentPcToolKey("files", "read") != mcpToolKey("pc_files", "read") {
		t.Fatal("agentPcToolKey 必须与 mcpToolKey(pc_ 前缀) 算法逐字节一致")
	}
	k1 := agentPcToolKey("服 务", "echo")
	k2 := agentPcToolKey("服_务", "echo")
	if k1 == k2 || !strings.HasPrefix(k1, "mcp_pc_") || !strings.Contains(k1, "_") {
		t.Fatalf("规整同形原名须哈希后缀区分且保持 mcp_pc_ 前缀: %q %q", k1, k2)
	}
	long := agentPcToolKey(strings.Repeat("长", 40), strings.Repeat("t", 60))
	if len(long) > 64 || !strings.HasPrefix(long, "mcp_pc_") {
		t.Fatalf("key 长度/前缀不符: %q (%d)", long, len(long))
	}
	for _, r := range long {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			t.Fatalf("key 含非法字符 %q：%q", r, long)
		}
	}
}

// TestAgentPcRouteNamespace 命名空间隔离：服务端条目即使撞出 mcp_pc_ 同形 key 也不得被
// 服务端路由命中（本机工具绝不走服务端连接执行）；本机路由按该用户上报清单反查
func TestAgentPcRouteNamespace(t *testing.T) {
	// 恶意/巧合场景：服务端条目名 pc_x + 工具 y 的 key 恰为 mcp_pc_x_y
	mcpInjectEntry(t, "pc_x", model.MCPServer{Transport: mcpTransportStdio, Enabled: true}, nil, []mcpToolInfo{{Name: "y"}})
	key := mcpToolKey("pc_x", "y")
	if key != "mcp_pc_x_y" {
		t.Fatalf("前置假设不成立: %q", key)
	}
	if _, _, ok := mcpRouteToolKey(key); ok {
		t.Fatal("mcp_pc_ 命名空间不得被服务端条目路由命中")
	}
	if _, _, ok := mcpRouteToolKey("mcp_pc_unknown_tool"); ok {
		t.Fatal("未知 mcp_pc_ key 不应路由成功")
	}

	pctoolsSeed(t, "alice", []AgentPcTool{{Server: "x", Tool: "y", Description: "d"}})
	srv, tool, ok := agentPcRouteToolKey("alice", key)
	if !ok || srv != "x" || tool != "y" {
		t.Fatalf("本机路由反查不符: %q %q %v", srv, tool, ok)
	}
	if _, _, ok = agentPcRouteToolKey("alice", "mcp_pc_nope"); ok {
		t.Fatal("未上报的 key 不应路由成功")
	}
	if _, _, ok = agentPcRouteToolKey("bob", key); ok {
		t.Fatal("其他用户的清单不应命中（按用户隔离）")
	}
}

// TestAgentPcNeedsApprovalLabel 本机工具风险分级与展示名：恒需人工审批（提示归属）、
// label 带（本机）标记、未知工具回落通用审批
func TestAgentPcNeedsApprovalLabel(t *testing.T) {
	pctoolsSeed(t, "alice", []AgentPcTool{{Server: "浏览器", Tool: "打开", Description: "d"}})
	key := agentPcToolKey("浏览器", "打开")
	need, reason := agentNeedsApproval("alice", key, nil)
	if !need || !strings.Contains(reason, "浏览器") || !strings.Contains(reason, "打开") {
		t.Fatalf("本机工具应需审批且提示归属: %v %q", need, reason)
	}
	if label := agentToolLabel("alice", key); label != "MCP · 浏览器 / 打开（本机）" {
		t.Fatalf("展示名不符: %q", label)
	}
	if agentToolServerOnly(key) {
		t.Fatal("本机工具不应判定为服务端执行（执行载体在用户电脑）")
	}
	if _, reason2 := agentNeedsApproval("alice", "mcp_pc_missing_tool_x", nil); !strings.Contains(reason2, "未知工具") {
		t.Fatalf("未上报的本机 key 应回落通用审批: %q", reason2)
	}
}

// TestHandleAgentPcToolsSanitize 上报清洗归口：非 PC 连接拒收、去重、坏项剔除、
// 超限截断、空清单清除注入、回执 {ok,count}
func TestHandleAgentPcToolsSanitize(t *testing.T) {
	s := NewServer(&config.Config{})

	mkClient := func(platform string) *Client {
		return &Client{server: s, username: "alice", platform: platform, sendCh: make(chan []byte, 16)}
	}
	upload := func(c *Client, tools []AgentPcTool) (int, map[string]interface{}) {
		body, _ := json.Marshal(map[string]interface{}{"tools": tools})
		s.handleAgentPcTools(c, &protocol.Message{MsgType: 67, Content: string(body)})
		select {
		case raw := <-c.sendCh:
			var m struct {
				MsgType int    `json:"msg_type"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatalf("回执帧解析失败: %v", err)
			}
			if m.MsgType != 67 {
				t.Fatalf("回执 msg_type 应为 67，实际 %d", m.MsgType)
			}
			var ack map[string]interface{}
			if err := json.Unmarshal([]byte(m.Content), &ack); err != nil {
				t.Fatalf("回执内容解析失败: %v（%q）", err, m.Content)
			}
			v, _ := agentPcToolStore.Load("alice")
			var n int
			if v != nil {
				n = len(v.(*agentPcToolSet).tools)
			}
			return n, ack
		default:
			t.Fatal("应收到回执帧")
			return 0, nil
		}
	}

	// 非 PC 连接拒收（不落库不回执）
	webC := mkClient("")
	{
		body, _ := json.Marshal(map[string]interface{}{"tools": []AgentPcTool{{Server: "a", Tool: "b"}}})
		s.handleAgentPcTools(webC, &protocol.Message{MsgType: 67, Content: string(body)})
		if _, ok := agentPcToolStore.Load("alice"); ok {
			t.Fatal("非 PC 连接上报不应入库")
		}
		select {
		case raw := <-webC.sendCh:
			t.Fatalf("非 PC 连接不应收到回执: %s", raw)
		default:
		}
	}

	pcC := mkClient("pc")
	s.hub.Add(pcC) // 回执经 sendToUser 投递，须先入 hub
	t.Cleanup(func() { s.hub.Remove(pcC) })
	// 常规入库 + 回执计数
	n, ack := upload(pcC, []AgentPcTool{
		{Server: "fs", Tool: "read", Description: "读", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Server: "fs", Tool: "read"},                   // server+tool 重复：去重
		{Server: "fs", Tool: "  "},                     // 空工具名：剔除
		{Server: " ", Tool: "x"},                       // 空服务器名：剔除
		{Server: "db", Tool: strings.Repeat("q", 200)}, // 超长工具名：剔除
		{Server: "web", Tool: "fetch", Description: strings.Repeat("长", 600)},
	})
	if n != 2 || ack["count"].(float64) != 2 || ack["ok"] != true {
		t.Fatalf("清洗结果/回执不符: n=%d ack=%v", n, ack)
	}
	snap := pctoolsSnapshot("alice")
	if len(snap) != 2 {
		t.Fatalf("快照数量不符: %d", len(snap))
	}
	if len([]rune(snap[1].Description)) > agentPcMcpMaxDescLen {
		t.Fatalf("超长描述应按字符截断: %d", len([]rune(snap[1].Description)))
	}
	if string(snap[0].InputSchema) != `{"type":"object"}` {
		t.Fatalf("schema 应原样透传: %s", snap[0].InputSchema)
	}

	// 服务器数量超限：整批防御性截断到 10
	many := make([]AgentPcTool, 0, 12)
	for i := 0; i < 12; i++ {
		many = append(many, AgentPcTool{Server: "srv" + string(rune('a'+i)), Tool: "t"})
	}
	n, _ = upload(pcC, many)
	if n > agentPcMcpMaxServers {
		t.Fatalf("服务器数量超限未截断: %d", n)
	}

	// 工具总数超限：截断到 64（单服务器 100 个工具）
	dup := make([]AgentPcTool, 0, 100)
	for i := 0; i < 100; i++ {
		dup = append(dup, AgentPcTool{Server: "one", Tool: "tool" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + strings.Repeat("y", i/26)})
	}
	n, _ = upload(pcC, dup)
	if n > agentPcMcpMaxTools {
		t.Fatalf("工具总数超限未截断: %d", n)
	}

	// 空清单=清除注入
	n, ack = upload(pcC, nil)
	if n != 0 || ack["count"].(float64) != 0 {
		t.Fatalf("空清单应清除并回执 count=0: n=%d ack=%v", n, ack)
	}
	if _, ok := agentPcToolStore.Load("alice"); ok {
		t.Fatal("空清单后存储应删除")
	}
}

// TestMcpPcDefinitionsGate 注入闸门与定义内容：双开关关闭不注入、PC 离线不注入、
// 在线时按清单生成 mcp_pc_ 定义（schema 缺省兜底空对象）
func TestMcpPcDefinitionsGate(t *testing.T) {
	pctoolsEnable(t)
	s := NewServer(&config.Config{})
	c := &Client{server: s, username: "alice", platform: "pc", sendCh: make(chan []byte, 8)}
	s.hub.Add(c)
	t.Cleanup(func() { s.hub.Remove(c) })

	tools := []AgentPcTool{
		{Server: "fs", Tool: "read", Description: "读文件"},
		{Server: "fs", Tool: "write", InputSchema: json.RawMessage(`{"type":"object","properties":{"p":{"type":"string"}}}`)},
	}
	pctoolsSeed(t, "alice", tools)

	// 离线：另一用户（无 PC 连接）不注入
	if defs := s.mcpPcOpenAIToolDefinitions("bob"); len(defs) != 0 {
		t.Fatalf("PC 离线用户不应注入: %d", len(defs))
	}
	// 在线：全量注入 + schema 透传/兜底
	defs := s.mcpPcOpenAIToolDefinitions("alice")
	if len(defs) != 2 {
		t.Fatalf("注入数量不符: %d", len(defs))
	}
	byName := map[string]map[string]interface{}{}
	for _, d := range defs {
		byName[d.Function["name"].(string)] = d.Function
	}
	fw := byName[agentPcToolKey("fs", "write")]
	if fw == nil || fw["parameters"].(json.RawMessage) == nil {
		t.Fatalf("schema 应原样透传: %v", fw)
	}
	fr := byName[agentPcToolKey("fs", "read")]
	if fr == nil {
		t.Fatal("read 定义缺失")
	}
	if _, ok := fr["parameters"].(map[string]interface{}); !ok {
		t.Fatalf("缺省 schema 应兜底空对象: %T", fr["parameters"])
	}
	// 注入名走 agentToolDefinitions 全链路（含内置工具合并不冲突）
	all := s.agentToolDefinitions("alice")
	hit := 0
	for _, d := range all {
		if strings.HasPrefix(d.Function["name"].(string), "mcp_pc_") {
			hit++
		}
	}
	if hit != 2 {
		t.Fatalf("agentToolDefinitions 应合并本机定义: hit=%d total=%d", hit, len(all))
	}

	// 双闸门关闭：总开关关闭不注入
	mcpMu.Lock()
	mcpSet.Enabled = false
	mcpMu.Unlock()
	if defs := s.mcpPcOpenAIToolDefinitions("alice"); len(defs) != 0 {
		t.Fatal("MCP 总开关关闭不应注入本机工具")
	}
	mcpMu.Lock()
	mcpSet.Enabled, mcpSet.UserEnabled = true, false
	mcpMu.Unlock()
	if defs := s.mcpPcOpenAIToolDefinitions("alice"); len(defs) != 0 {
		t.Fatal("用户自建开关关闭不应注入本机工具")
	}
}

// TestMcpValidateReservedName 后台服务器名保留前缀校验（防与本机 mcp_pc_ 命名空间撞名）
func TestMcpValidateReservedName(t *testing.T) {
	for _, name := range []string{"pc_x", "pc-x", "pc_"} {
		if _, err := mcpValidateReq(&adminMCPServerReq{Name: name, Transport: "stdio", Command: "npx"}, 0, false); err == nil {
			t.Fatalf("保留前缀名 %q 应拒绝", name)
		}
	}
	if _, err := mcpValidateReq(&adminMCPServerReq{Name: "pcx", Transport: "stdio", Command: "npx"}, 0, false); err != nil {
		t.Fatalf("普通名 pcx 不应拒绝: %v", err)
	}
}
