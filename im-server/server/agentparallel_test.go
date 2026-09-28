package server

// 阶段一百六十五：并行工具调用链路测试（真实 MySQL：需本地 config.yaml 可连，无库自动跳过）。
// 覆盖：并行化判定（只读放行/副作用与交互工具拒绝/http_request 按方法分流）、
// 执行段切分（连续只读归批、副作用独立段、段序=原 tool_calls 序）、
// 并行批执行（tool_call_id 原序配对、错误结果标记、步骤留痕落库）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

// parallelTestTask 构造任务桩（agentEmit 需要 Agent.Name 与 Username；无在线连接时事件投递为空操作）
func parallelTestTask(username string) *AgentTask {
	return &AgentTask{
		ID:       "par-test-" + username,
		Username: username,
		Agent:    &AIRunAgent{Name: "parbot"},
		Goal:     "测试并行工具调用",
		Status:   "running",
	}
}

// parCall 构造模型工具调用桩
func parCall(id, name, argsJSON string) aiToolCall {
	var tc aiToolCall
	tc.ID = id
	tc.Type = "function"
	tc.Function.Name = name
	tc.Function.Arguments = argsJSON
	return tc
}

// TestAgentToolParallelizable 并行化判定：只读免审批服务端工具放行，副作用/交互工具拒绝
func TestAgentToolParallelizable(t *testing.T) {
	s := NewServer(config.Load())
	tk := parallelTestTask("partest1")
	cases := []struct {
		tool   string
		params string
		want   bool
	}{
		{"read_file", `{"path":"a.txt"}`, true},
		{"list_dir", `{"path":"."}`, true},
		{"grep", `{"pattern":"x"}`, true},
		{"web_search", `{"query":"x"}`, true},
		{"http_request", `{"url":"https://example.com"}`, true}, // 缺 method 视为 GET
		{"http_request", `{"url":"https://example.com","method":"get"}`, true},
		{"http_request", `{"url":"https://example.com","method":"POST"}`, false},
		{"write_file", `{"path":"a.txt","content":"x"}`, false},
		{"edit_file", `{"path":"a.txt"}`, false},
		{"delete_file", `{"path":"a.txt"}`, false},
		{"run_command", `{"command":"dir"}`, false},
		{"todo_write", `{"todos":[]}`, false},
		{"ask_user", `{"question":"q"}`, false},
		{"present_plan", `{"steps":[]}`, false},
	}
	for _, c := range cases {
		var params map[string]interface{}
		_ = json.Unmarshal([]byte(c.params), &params)
		if got := agentToolParallelizable(s, tk, c.tool, params); got != c.want {
			t.Fatalf("%s 并行化判定不符：want %v got %v", c.tool, c.want, got)
		}
	}
}

// TestAgentToolSegments 执行段切分：连续只读归批、副作用/交互工具独立成段、段序=原序
func TestAgentToolSegments(t *testing.T) {
	s := NewServer(config.Load())
	tk := parallelTestTask("partest2")
	calls := []aiToolCall{
		parCall("c1", "read_file", `{"path":"a.txt"}`),
		parCall("c2", "grep", `{"pattern":"x"}`),
		parCall("c3", "write_file", `{"path":"b.txt","content":"x"}`),
		parCall("c4", "list_dir", `{"path":"."}`),
		parCall("c5", "web_search", `{"query":"x"}`),
		parCall("c6", "run_command", `{"command":"dir"}`),
		parCall("c7", "http_request", `{"url":"https://example.com","method":"POST"}`),
	}
	segs := agentToolSegments(s, tk, calls)
	// 期望：[c1,c2] 并行批 / [c3] / [c4,c5] 并行批 / [c6] / [c7]
	if len(segs) != 5 {
		t.Fatalf("切分段数不符：want 5 got %d", len(segs))
	}
	if len(segs[0]) != 2 || segs[0][0].ID != "c1" || segs[0][1].ID != "c2" {
		t.Fatalf("第 1 段应为 [c1,c2] 并行批")
	}
	if len(segs[1]) != 1 || segs[1][0].ID != "c3" {
		t.Fatalf("第 2 段应为 [c3] 单工具段")
	}
	if len(segs[2]) != 2 || segs[2][0].ID != "c4" || segs[2][1].ID != "c5" {
		t.Fatalf("第 3 段应为 [c4,c5] 并行批")
	}
	if len(segs[3]) != 1 || segs[3][0].ID != "c6" {
		t.Fatalf("第 4 段应为 [c6] 单工具段")
	}
	if len(segs[4]) != 1 || segs[4][0].ID != "c7" {
		t.Fatalf("第 5 段应为 [c7] 单工具段")
	}
}

// TestAgentRunToolBatch 并行批执行：真实读取工作区文件，验证 tool_call_id 原序配对、
// 错误结果标记、留痕落库（留痕与历史消息均按原 tool_calls 顺序落位）
func TestAgentRunToolBatch(t *testing.T) {
	s := NewServer(config.Load())
	user := "partest3"
	tk := parallelTestTask(user)
	// 步骤留痕表由本测试自行补齐建表（TestMain 仅迁移变更记录表）
	_ = store.DB.AutoMigrate(&model.AgentStepRecord{})
	// 前置清理：测试可重复运行，残留留痕行会污染计数断言
	store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{})
	t.Cleanup(func() { store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{}) })

	// 准备工作区文件（经 agentSafePath 归口定位，防串扰）
	write := func(name, content string) string {
		t.Helper()
		full, err := agentSafePath(user, name)
		if err != nil {
			t.Fatalf("工作区路径解析失败：%v", err)
		}
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("工作区目录创建失败：%v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("测试文件写入失败：%v", err)
		}
		t.Cleanup(func() { _ = os.Remove(full) })
		return name
	}
	aName := write("par-test-a.txt", "AAA 内容")
	bName := write("par-test-b.txt", "BBB 内容")

	tools := []aiToolCall{
		parCall("p1", "read_file", `{"path":"`+aName+`"}`),
		parCall("p2", "read_file", `{"path":"不存在文件-par-test.txt"}`),
		parCall("p3", "read_file", `{"path":"`+bName+`"}`),
	}
	msgs := s.agentRunToolBatch(tk, tools)
	if len(msgs) != 3 {
		t.Fatalf("并行批返回消息数不符：want 3 got %d", len(msgs))
	}
	// tool_call_id 原序配对（OpenAI 兼容格式次序稳定，模型按 id 取结果）
	wantIDs := []string{"p1", "p2", "p3"}
	for i, m := range msgs {
		if m.Role != "tool" || m.ToolCallID != wantIDs[i] {
			t.Fatalf("第 %d 条消息不符：role=%s tool_call_id=%s", i, m.Role, m.ToolCallID)
		}
	}
	// Content 为 interface{}（兼容多模态消息），单工具结果恒为 string
	contentOf := func(m aiChatMessage) string {
		s, _ := m.Content.(string)
		return s
	}
	if !strings.Contains(contentOf(msgs[0]), "AAA 内容") {
		t.Fatalf("p1 读取结果不符：%q", contentOf(msgs[0]))
	}
	if !strings.HasPrefix(contentOf(msgs[1]), "错误") {
		t.Fatalf("p2 应为错误结果：%q", contentOf(msgs[1]))
	}
	if !strings.Contains(contentOf(msgs[2]), "BBB 内容") {
		t.Fatalf("p3 读取结果不符：%q", contentOf(msgs[2]))
	}
	// 步骤留痕已按序落库（agentStepTrace 归口，approval=none）
	var rows []model.AgentStepRecord
	if err := store.DB.Where("task_id = ?", tk.ID).Order("seq ASC").Find(&rows).Error; err != nil {
		t.Fatalf("留痕查询失败：%v", err)
	}
	if len(rows) != 3 || rows[0].Tool != "read_file" || rows[0].Approval != "none" {
		t.Fatalf("留痕落库不符：%d 条", len(rows))
	}
}
