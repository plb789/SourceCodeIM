package server

import (
	"strings"
	"testing"
)

// 阶段八十四：历史对话压缩纯逻辑单元测试（边界完整性/截断/估算）。
// LLM 摘要链路依赖真实 provider，不在本文件覆盖（与 ws_proj_clone_real_test 分层同理）。

// TestAiEstimateTokens 估算粗校：中文显著高于英文（同等字符数），空串为 0
func TestAiEstimateTokens(t *testing.T) {
	if got := aiEstimateTokens(""); got != 0 {
		t.Fatalf("空串估算应为 0，实际 %d", got)
	}
	cjk := aiEstimateTokens(strings.Repeat("聊", 100))
	asc := aiEstimateTokens(strings.Repeat("a", 100))
	if cjk < 80 || cjk > 120 {
		t.Fatalf("中文 100 字估算 %d，应约 100", cjk)
	}
	if asc < 20 || asc > 30 {
		t.Fatalf("英文 100 字符估算 %d，应约 25", asc)
	}
	if cjk <= asc {
		t.Fatalf("中文估算 %d 应显著高于英文 %d", cjk, asc)
	}
}

// TestAiMsgsEstimateTokens 多消息合计与 role 计入
func TestAiMsgsEstimateTokens(t *testing.T) {
	msgs := []aiChatMessage{
		{Role: "system", Content: "系统提示词"},
		{Role: "user", Content: "你好"},
	}
	if got := aiMsgsEstimateTokens(msgs); got <= 0 {
		t.Fatalf("合计估算应大于 0，实际 %d", got)
	}
	// 单条与合计一致性
	one := aiEstimateTokens("system") + aiEstimateTokens("系统提示词")
	if got := aiMsgsEstimateTokens(msgs[:1]); got != one {
		t.Fatalf("单条估算 %d 与归口 %d 不一致", got, one)
	}
}

// TestAgentCompressBoundary 压缩边界：切割点必须落在 assistant(tool_calls) 组起点，
// 保留区为最近 keepTurns 个完整组（assistant 与其 tool 结果不拆分）
func TestAgentCompressBoundary(t *testing.T) {
	mkGroup := func(idx int, toolResults int) []aiChatMessage {
		g := []aiChatMessage{{Role: "assistant", Content: "调用", ToolCalls: []aiToolCall{{ID: "c" + string(rune('0'+idx)), Type: "function"}}}}
		for j := 0; j < toolResults; j++ {
			g = append(g, aiChatMessage{Role: "tool", Content: "结果", ToolCallID: "c" + string(rune('0'+idx))})
		}
		return g
	}
	msgs := []aiChatMessage{
		{Role: "system", Content: "sys"},
		{Role: "user", Content: "目标"},
	}
	msgs = append(msgs, mkGroup(1, 2)...)
	msgs = append(msgs, mkGroup(2, 1)...)
	msgs = append(msgs, mkGroup(3, 2)...)
	msgs = append(msgs, mkGroup(4, 1)...)
	msgs = append(msgs, mkGroup(5, 1)...)

	bnd := agentCompressBoundary(msgs, 3)
	if bnd <= 2 {
		t.Fatalf("5 组保留 3 组应有压缩边界，实际 %d", bnd)
	}
	// 边界必须是某组 assistant 起点，且压缩区内配对完整（每个 tool_call_id 的 tool 结果都在压缩区内）
	if msgs[bnd].Role != "assistant" || len(msgs[bnd].ToolCalls) == 0 {
		t.Fatalf("边界 %d 应为 assistant(tool_calls) 起点，实际 role=%s", bnd, msgs[bnd].Role)
	}
	compCalls := map[string]bool{}
	for i := 1; i < bnd; i++ {
		for _, tc := range msgs[i].ToolCalls {
			compCalls[tc.ID] = true
		}
	}
	for i := 1; i < bnd; i++ {
		if msgs[i].Role == "tool" && !compCalls[msgs[i].ToolCallID] {
			t.Fatalf("压缩区 tool 结果 %s 的调用方不在压缩区内（配对被拆分）", msgs[i].ToolCallID)
		}
	}
	// 保留区同样配对完整
	keepCalls := map[string]bool{}
	for i := bnd; i < len(msgs); i++ {
		for _, tc := range msgs[i].ToolCalls {
			keepCalls[tc.ID] = true
		}
	}
	for i := bnd; i < len(msgs); i++ {
		if msgs[i].Role == "tool" && !keepCalls[msgs[i].ToolCallID] {
			t.Fatalf("保留区 tool 结果 %s 的调用方不在保留区内（配对被拆分）", msgs[i].ToolCallID)
		}
	}
	// 组数不足时返回 0（无可压缩）
	if got := agentCompressBoundary(msgs[:5], 3); got != 0 {
		t.Fatalf("仅 2 个完整组时边界应为 0，实际 %d", got)
	}
	if got := agentCompressBoundary(msgs, 5); got != 0 {
		t.Fatalf("5 组保留 5 组时边界应为 0，实际 %d", got)
	}
}

// TestAgentTruncateToolResult 截断归口：超长保留头尾+省略标注；短文原样；负数上限禁用
func TestAgentTruncateToolResult(t *testing.T) {
	old := agentToolResultMaxChars
	defer func() { agentToolResultMaxChars = old }()

	agentToolResultMaxChars = 100
	long := strings.Repeat("H", 80) + strings.Repeat("T", 80) // 160 字符
	got := agentTruncateToolResult(long)
	if len([]rune(got)) >= len([]rune(long)) {
		t.Fatalf("超长结果应被截短")
	}
	if !strings.Contains(got, "省略") || !strings.HasPrefix(got, "HHHH") || !strings.HasSuffix(got, "TTTT") {
		t.Fatalf("截断结果应含省略标注且保留头尾，实际：%q", got[:40])
	}
	short := "正常结果"
	if agentTruncateToolResult(short) != short {
		t.Fatalf("短结果不应被截断")
	}
	agentToolResultMaxChars = -1
	if agentTruncateToolResult(long) != long {
		t.Fatalf("负数上限应禁用截断")
	}
}

// TestAiCompressEntryCache 缓存条目存取与覆盖语义（sync.Map 归口）
func TestAiCompressEntryCache(t *testing.T) {
	key := "999|testuser|测试智能体"
	aiCompressCache.Delete(key)
	defer aiCompressCache.Delete(key)

	aiCompressMu.Lock()
	aiCompressCache.Store(key, &aiCompressEntry{Summary: "摘要v1", UptoID: 10})
	aiCompressMu.Unlock()
	v, ok := aiCompressCache.Load(key)
	if !ok {
		t.Fatal("缓存条目应可读回")
	}
	ent := v.(*aiCompressEntry)
	if ent.Summary != "摘要v1" || ent.UptoID != 10 {
		t.Fatalf("缓存读回不符：%+v", ent)
	}
}
