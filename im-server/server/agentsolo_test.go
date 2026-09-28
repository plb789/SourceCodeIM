package server

// 阶段一百七十六：SOLO 全自动模式测试（真实 MySQL：需本地 config.yaml 可连，无库自动跳过）。
// 覆盖：SOLO 绕过对象基线（白名单全关时写/删/命令需审批，即 SOLO 自动放行的目标集合）、
// 只读工具行为不受 SOLO 影响、计划模式门禁与 SOLO 互不干涉（门禁只看工具不看 SoloMode）、
// 留痕 approval="solo" 落库（前端 thApprovalLabel 据此展示"SOLO 自动放行"标签）。

import (
	"encoding/json"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

// soloTestTask 构造任务桩（parallelTestTask 同款；SoloMode 为创建后只读字段，无需锁保护）
func soloTestTask(username string, solo bool) *AgentTask {
	return &AgentTask{
		ID:       "solo-test-" + username,
		Username: username,
		Agent:    &AIRunAgent{Name: "solobot"}, // 事件流 FromUser 取 t.Agent.Name（测试桩需显式补齐）
		Goal:     "测试 SOLO 全自动模式",
		Status:   "running",
		SoloMode: solo,
	}
}

// soloNeedsApprovalParams 解析工具参数 JSON（失败视为测试编写错误）
func soloNeedsApprovalParams(t *testing.T, raw string) map[string]interface{} {
	t.Helper()
	var params map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatalf("参数 JSON 解析失败：%v", err)
	}
	return params
}

// TestAgentSoloNeedsApprovalBaseline SOLO 绕过对象基线：白名单全关时写/编辑/删/命令需审批
// （即 SOLO 分支放行的目标集合）；只读工具恒免审批，SOLO 下行为不变
func TestAgentSoloNeedsApprovalBaseline(t *testing.T) {
	_ = NewServer(config.Load())
	user := "solotest1"
	// 强制白名单全关（保存/恢复，防污染其他用例）：SOLO 语义建立在"无白名单也放行"之上
	agentWlMu.Lock()
	originAutoWrite := agentAutoWrite
	_, originUserWrite := agentUserWrite[user]
	originAutoCmds := agentAutoCmds
	originUserCmds, hadUserCmds := agentUserCmds[user]
	agentAutoWrite = false
	delete(agentUserWrite, user)
	agentAutoCmds = nil
	delete(agentUserCmds, user)
	agentWlMu.Unlock()
	t.Cleanup(func() {
		agentWlMu.Lock()
		agentAutoWrite = originAutoWrite
		if originUserWrite {
			agentUserWrite[user] = true
		}
		agentAutoCmds = originAutoCmds
		if hadUserCmds {
			agentUserCmds[user] = originUserCmds
		}
		agentWlMu.Unlock()
	})

	// 需审批集合：SOLO 分支的对象（needApprove && t.SoloMode 才绕过）
	needs := []struct {
		tool   string
		params string
	}{
		{"write_file", `{"path":"a.txt","content":"x"}`},
		{"edit_file", `{"path":"a.txt","old":"a","new":"b"}`},
		{"delete_file", `{"path":"a.txt"}`},
		{"run_command", `{"command":"go build ./..."}`},
	}
	for _, c := range needs {
		ok, reason := agentNeedsApproval(user, c.tool, soloNeedsApprovalParams(t, c.params))
		if !ok || reason == "" {
			t.Fatalf("SOLO 绕过对象基线不符：%s 白名单全关时应需审批且 reason 非空，got ok=%v reason=%q", c.tool, ok, reason)
		}
	}

	// 免审批集合：只读/检索类，SOLO 下路径不变（仍走 none 留痕分支）
	free := []struct {
		tool   string
		params string
	}{
		{"read_file", `{"path":"a.txt"}`},
		{"list_dir", `{"path":"."}`},
		{"grep", `{"pattern":"x"}`},
		{"web_search", `{"query":"x"}`},
		{"fetch_page", `{"url":"https://example.com"}`},
		{"http_request", `{"url":"https://example.com","method":"GET"}`},
	}
	for _, c := range free {
		if ok, _ := agentNeedsApproval(user, c.tool, soloNeedsApprovalParams(t, c.params)); ok {
			t.Fatalf("只读工具行为应不受 SOLO 影响：%s 应免审批", c.tool)
		}
	}
}

// TestAgentSoloStepTraceSoloLabel SOLO 分支留痕：approval="solo" 落库可查，
// 前端 thApprovalLabel 按 "solo" 映射"SOLO 自动放行"标签依赖该值
func TestAgentSoloStepTraceSoloLabel(t *testing.T) {
	s := NewServer(config.Load())
	tk := soloTestTask("solotest2", true)
	// 步骤留痕表由本测试自行补齐建表（TestMain 仅迁移变更记录表）
	_ = store.DB.AutoMigrate(&model.AgentStepRecord{})
	store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{})
	t.Cleanup(func() { store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{}) })

	// 复现 SOLO 分支的留痕调用形态（agentrun.go：写操作自动放行后 approval="solo"）
	s.agentStepTrace(tk, "write_file",
		map[string]interface{}{"path": "solo-a.txt", "content": "x"},
		"写入成功", true, "server", "solo", 5)

	var rows []model.AgentStepRecord
	if err := store.DB.Where("task_id = ?", tk.ID).Order("seq ASC").Find(&rows).Error; err != nil {
		t.Fatalf("留痕查询失败：%v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("留痕条数不符：want 1 got %d", len(rows))
	}
	if rows[0].Approval != "solo" {
		t.Fatalf("留痕 approval 应为 solo，got %q", rows[0].Approval)
	}
	if rows[0].Tool != "write_file" || !rows[0].OK || rows[0].Env != "server" {
		t.Fatalf("留痕其余字段不符：tool=%s ok=%v env=%s", rows[0].Tool, rows[0].OK, rows[0].Env)
	}
}

// TestAgentSoloPlanGateUnaffected 计划模式门禁与 SOLO 互不干涉：门禁 agentPlanBlockedTool
// 只看工具名与参数（不读任务字段），SOLO 开启也不会绕过批准前的副作用门禁
func TestAgentSoloPlanGateUnaffected(t *testing.T) {
	_ = NewServer(config.Load())
	tkSolo := soloTestTask("solotest3", true) // 门禁函数不消费任务：仅用于表达"SOLO 任务同样受门禁约束"
	_ = tkSolo

	blocked := []struct {
		tool   string
		params string
	}{
		{"write_file", `{"path":"a.txt","content":"x"}`},
		{"edit_file", `{"path":"a.txt"}`},
		{"delete_file", `{"path":"a.txt"}`},
		{"run_command", `{"command":"dir"}`},
		{"http_request", `{"url":"https://example.com","method":"POST"}`},
		{"mcp_demo_tool", `{}`},
	}
	for _, c := range blocked {
		if !agentPlanBlockedTool(c.tool, soloNeedsApprovalParams(t, c.params)) {
			t.Fatalf("计划门禁应阻断副作用工具：%s", c.tool)
		}
	}

	notBlocked := []struct {
		tool   string
		params string
	}{
		{"read_file", `{"path":"a.txt"}`},
		{"list_dir", `{"path":"."}`},
		{"grep", `{"pattern":"x"}`},
		{"http_request", `{"url":"https://example.com","method":"GET"}`},
		{"web_search", `{"query":"x"}`},
	}
	for _, c := range notBlocked {
		if agentPlanBlockedTool(c.tool, soloNeedsApprovalParams(t, c.params)) {
			t.Fatalf("计划门禁不应阻断只读工具：%s", c.tool)
		}
	}
}
