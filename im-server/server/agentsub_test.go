package server

// 阶段一百七十八：子 Agent 并行协作单测（agentSubChatFn 注入假上游，不依赖真实模型）。
// 覆盖：工具注册（schema 注入/serverOnly/免审批/并行白名单）、子工具白名单与防递归
// （spawn_agent 不在子工具集、白名单外工具被拦截）、正常结链路（工具轮→结论）、
// 步数上限强制收口、每任务派生数上限。

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"im-server/config"
)

// subTestTask 构造父任务桩（runCtx 必须初始化：子 Agent 挂父任务取消树下）
func subTestTask(t *testing.T, username string) *AgentTask {
	t.Helper()
	tk := &AgentTask{
		ID:       "sub-test-" + username,
		Username: username,
		Agent:    &AIRunAgent{Name: "subbot"},
		Goal:     "测试子 Agent 派生",
		Status:   "running",
	}
	tk.runCtx, tk.runCancel = context.WithCancel(context.Background())
	t.Cleanup(tk.runCancel)
	return tk
}

// subFakeChat 假上游脚本桩：依次弹出脚本项；tools 为 nil 的强制收口调用按脚本处理
type subFakeCall struct {
	content string
	calls   []aiToolCall
	tools   []aiToolDefinition
	msgs    []aiChatMessage
}

func TestAgentSubRegistration(t *testing.T) {
	s := NewServer(config.Load())
	// schema 注入主任务工具定义
	found := false
	for _, d := range s.agentToolDefinitions("subreg1") {
		if name, _ := d.Function["name"].(string); name == "spawn_agent" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("agentToolDefinitions 未注入 spawn_agent 工具 schema")
	}
	// 服务端专属 + 免审批 + 并行白名单
	if !agentToolServerOnly("spawn_agent") {
		t.Fatalf("spawn_agent 应为服务端专属工具")
	}
	if ok, _ := agentNeedsApproval("subreg1", "spawn_agent", map[string]interface{}{"goal": "g"}); ok {
		t.Fatalf("spawn_agent 应免审批（只读调研语义）")
	}
	if !agentToolParallelizable(s, subTestTask(t, "subreg1"), "spawn_agent", map[string]interface{}{"goal": "g"}) {
		t.Fatalf("spawn_agent 应入并行白名单")
	}
	// 子工具集不含 spawn_agent（防递归第一层）且全部在白名单内
	defs := agentSubToolDefs()
	for _, d := range defs {
		name, _ := d.Function["name"].(string)
		if name == "spawn_agent" {
			t.Fatalf("子 Agent 工具集不应包含 spawn_agent（防递归）")
		}
		if !agentSubToolAllowed(name) {
			t.Fatalf("子工具集 %s 应全部在白名单内", name)
		}
	}
	// 白名单拒绝副作用/交互/递归工具
	for _, bad := range []string{"spawn_agent", "write_file", "edit_file", "delete_file", "run_command", "ask_user", "todo_write", "http_request"} {
		if agentSubToolAllowed(bad) {
			t.Fatalf("子 Agent 白名单不应包含 %s", bad)
		}
	}
}

// TestAgentSubRunConclude 正常链路：工具轮（read_file 真实读取工作区文件）→ 无 tool_calls 即结论
func TestAgentSubRunConclude(t *testing.T) {
	ws := agentRulesTestSetup(t, "subrun1")
	if err := os.WriteFile(filepath.Join(ws, "sub-a.txt"), []byte("子 Agent 调研目标内容"), 0o644); err != nil {
		t.Fatalf("测试文件写入失败：%v", err)
	}
	s := NewServer(config.Load())
	tk := subTestTask(t, "subrun1")

	var trace []subFakeCall
	origin := agentSubChatFn
	agentSubChatFn = func(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition) (string, []aiToolCall, error) {
		trace = append(trace, subFakeCall{tools: tools, msgs: append([]aiChatMessage(nil), msgs...)})
		if len(trace) == 1 {
			// 第 1 轮：发起 read_file 工具调用
			return "", []aiToolCall{parCall("sc1", "read_file", `{"path":"sub-a.txt"}`)}, nil
		}
		// 第 2 轮：不再调用工具 → 输出结论
		return "调研结论：已读取 sub-a.txt", nil, nil
	}
	t.Cleanup(func() { agentSubChatFn = origin })

	out := s.agentSubAgentRun(tk, "梳理 sub-a.txt 内容")
	if out != "调研结论：已读取 sub-a.txt" {
		t.Fatalf("子 Agent 结论不符：%q", out)
	}
	if len(trace) != 2 {
		t.Fatalf("模型调用轮数不符：want 2 got %d", len(trace))
	}
	// 第 2 轮上下文应含工具结果（role=tool 且带子 Agent 真实读取内容）
	var toolMsg *aiChatMessage
	for i := range trace[1].msgs {
		m := trace[1].msgs[i]
		if m.Role == "tool" {
			toolMsg = &trace[1].msgs[i]
		}
	}
	if toolMsg == nil {
		t.Fatalf("第 2 轮上下文缺少 tool 结果消息")
	}
	if c, _ := toolMsg.Content.(string); !strings.Contains(c, "子 Agent 调研目标内容") {
		t.Fatalf("工具结果应含文件内容：%q", c)
	}
	if toolMsg.ToolCallID != "sc1" {
		t.Fatalf("工具结果 tool_call_id 配对不符：%q", toolMsg.ToolCallID)
	}
}

// TestAgentSubRunBlockedTool 白名单外工具拦截：模型被诱导调 write_file → 结果为拒绝文本，循环继续
func TestAgentSubRunBlockedTool(t *testing.T) {
	agentRulesTestSetup(t, "subrun2")
	s := NewServer(config.Load())
	tk := subTestTask(t, "subrun2")

	origin := agentSubChatFn
	round := 0
	var blockedResult string
	agentSubChatFn = func(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition) (string, []aiToolCall, error) {
		round++
		if round == 1 {
			return "", []aiToolCall{parCall("sc2", "write_file", `{"path":"x.txt","content":"越权"}`)}, nil
		}
		if round == 2 {
			// 检查上一轮 write_file 的结果消息已被拒绝文本替换
			for _, m := range msgs {
				if m.Role == "tool" {
					if c, _ := m.Content.(string); strings.Contains(c, "仅允许只读调研工具") {
						blockedResult = c
					}
				}
			}
			return "结论：越权调用被拦截", nil, nil
		}
		t.Fatalf("不应有第 %d 轮调用", round)
		return "", nil, nil
	}
	t.Cleanup(func() { agentSubChatFn = origin })

	out := s.agentSubAgentRun(tk, "越权测试")
	if !strings.Contains(out, "越权调用被拦截") {
		t.Fatalf("子 Agent 应继续输出结论：%q", out)
	}
	if blockedResult == "" {
		t.Fatalf("白名单外工具应被拦截并返回拒绝文本")
	}
}

// TestAgentSubRunStepCap 步数上限：模型永不输出结论 → 强制收口调用（tools=nil）→ 返回收口结论
func TestAgentSubRunStepCap(t *testing.T) {
	agentRulesTestSetup(t, "subrun3")
	s := NewServer(config.Load())
	tk := subTestTask(t, "subrun3")

	origin := agentSubChatFn
	forced := false
	agentSubChatFn = func(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition) (string, []aiToolCall, error) {
		if tools == nil {
			forced = true // 强制收口调用：不带工具
			return "收口结论", nil, nil
		}
		return "", []aiToolCall{parCall("sc3-"+string(rune('a'+len(msgs)%26)), "list_dir", `{}`)}, nil
	}
	t.Cleanup(func() { agentSubChatFn = origin })

	out := s.agentSubAgentRun(tk, "无限调研测试")
	if !forced || out != "收口结论" {
		t.Fatalf("步数耗尽应强制收口：forced=%v out=%q", forced, out)
	}
}

// TestAgentSubRunCapPerTask 每任务派生数上限：超过 agentSubMaxPerTask 后返回错误文本
func TestAgentSubRunCapPerTask(t *testing.T) {
	agentRulesTestSetup(t, "subrun4")
	s := NewServer(config.Load())
	tk := subTestTask(t, "subrun4")

	origin := agentSubChatFn
	agentSubChatFn = func(ctx context.Context, agent *AIRunAgent, msgs []aiChatMessage, tools []aiToolDefinition) (string, []aiToolCall, error) {
		return "ok", nil, nil // 立即结论
	}
	t.Cleanup(func() { agentSubChatFn = origin })

	for i := 0; i < agentSubMaxPerTask; i++ {
		if out := s.agentSubAgentRun(tk, "目标"); out != "ok" {
			t.Fatalf("第 %d 个子 Agent 应正常返回：%q", i+1, out)
		}
	}
	if out := s.agentSubAgentRun(tk, "目标"); !strings.Contains(out, "已达上限") {
		t.Fatalf("超限派生应返回上限错误：%q", out)
	}
}

// TestAgentSubEmptyGoal 空目标快速失败
func TestAgentSubEmptyGoal(t *testing.T) {
	agentRulesTestSetup(t, "subrun5")
	s := NewServer(config.Load())
	tk := subTestTask(t, "subrun5")
	if out := s.agentSubAgentRun(tk, "  "); !strings.Contains(out, "错误") {
		t.Fatalf("空目标应返回错误文本：%q", out)
	}
}
