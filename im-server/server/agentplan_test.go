package server

// 阶段一百六十四：计划模式（TRAE CN Plan 同款）链路集成测试（真实 MySQL：需本地 config.yaml 可连，无库自动跳过）。
// 覆盖：工具门禁判定、计划审批挂起→批准（planApproved 置位+步骤同步清单）→驳回（意见回传）、
// 任务停止取消、等待超时、非发起人审批忽略、present_plan schema 注入。

import (
	"context"
	"testing"
	"time"

	"im-server/config"
	"im-server/protocol"
)

func planTestTask(s *Server, username string) *AgentTask {
	tk := &AgentTask{
		ID:       "plan-test-" + username,
		Username: username,
		Agent:    &AIRunAgent{Name: "planbot"}, // 事件流 FromUser 取 t.Agent.Name（生产任务恒已绑定，测试桩需显式补齐）
		Goal:     "测试计划模式链路",
		Status:   "running",
		PlanMode: true,
	}
	// 对齐生产创建归口（handleAgentRun）初始化任务级取消上下文，防空指针
	tk.runCtx, tk.runCancel = context.WithCancel(context.Background())
	// handleAgentPlan 按任务注册表归口查找（生产由 handleAgentRun 登记），测试桩需显式注册
	agentTasks.Store(tk.ID, tk)
	return tk
}

func planTestApprove(s *Server, c *Client, taskID, step, action, feedback string) {
	content := `{"task_id":"` + taskID + `","step":"` + step + `","action":"` + action + `","feedback":"` + feedback + `"}`
	s.handleAgentPlan(c, &protocol.Message{MsgType: protocol.MsgTypeAgentPlan, FromUser: c.username, Content: content})
}

// TestAgentPlanToolBlocked 门禁判定归口：副作用工具锁定、只读工具放行、MCP 一律锁定
func TestAgentPlanToolBlocked(t *testing.T) {
	blocked := []string{"write_file", "edit_file", "delete_file", "run_command", "browser_click", "browser_input", "browser_eval", "mcp_pc_fs_write", "mcp_serper_search"}
	for _, tool := range blocked {
		if !agentPlanBlockedTool(tool, map[string]interface{}{}) {
			t.Fatalf("工具 %s 计划批准前应被门禁锁定", tool)
		}
	}
	allowed := []string{"read_file", "list_dir", "grep", "todo_write", "ask_user", "web_search", "present_plan", "browser_navigate", "browser_snapshot", "browser_screenshot", "browser_tabs"}
	for _, tool := range allowed {
		if agentPlanBlockedTool(tool, map[string]interface{}{}) {
			t.Fatalf("只读工具 %s 不应被门禁锁定", tool)
		}
	}
	// http_request 按方法分流：GET/HEAD 放行，非只读方法锁定
	if agentPlanBlockedTool("http_request", map[string]interface{}{"method": "GET"}) {
		t.Fatalf("http_request GET 只读请求不应被门禁锁定")
	}
	if agentPlanBlockedTool("http_request", map[string]interface{}{}) {
		t.Fatalf("http_request 缺省方法（GET）不应被门禁锁定")
	}
	if !agentPlanBlockedTool("http_request", map[string]interface{}{"method": "post"}) {
		t.Fatalf("http_request POST 非只读请求应被门禁锁定")
	}
}

// TestAgentPlanToolInjected present_plan 仅计划模式任务注入（非计划任务不注入防误调用）
func TestAgentPlanToolInjected(t *testing.T) {
	s := NewServer(config.Load())
	tk := planTestTask(s, "plantest1")
	found := false
	for _, d := range s.agentToolDefinitions(tk.Username) {
		if name, _ := d.Function["name"].(string); name == "present_plan" {
			found = true
			break
		}
	}
	if found {
		t.Fatalf("agentToolDefinitions 通用注入不应包含 present_plan（应仅计划模式任务在 runAgentTask 内追加）")
	}
	def := agentPlanToolDef()
	if name, _ := def.Function["name"].(string); name != "present_plan" {
		t.Fatalf("agentPlanToolDef 工具名不符：%v", def.Function["name"])
	}
}

// TestAgentPlanApproveFlow 计划挂起 → 用户批准 → planApproved 置位 + 步骤同步任务清单
func TestAgentPlanApproveFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest1"
	tk := planTestTask(s, user)
	steps := []map[string]interface{}{
		{"content": "创建配置模块", "detail": "config.go"},
		{"content": "接入启动流程"},
	}

	type waitResult struct {
		action string
		fb     string
		err    error
	}
	done := make(chan waitResult, 1)
	go func() {
		action, fb, err := s.agentWaitPlanApproval(tk, "plan-step-1", "配置模块方案", "复用现有 viper", steps)
		done <- waitResult{action, fb, err}
	}()

	time.Sleep(200 * time.Millisecond) // 等挂起建立（planCh 注册）
	tk.mu.Lock()
	waiting := tk.planCh != nil && tk.planStep == "plan-step-1"
	status := tk.Status
	tk.mu.Unlock()
	if !waiting {
		t.Fatalf("提交计划后任务未进入挂起等待态（planCh 未注册或步骤键不符）")
	}
	if status != "waiting_approval" {
		t.Fatalf("挂起期间任务状态应为 waiting_approval，实际 %q", status)
	}

	planTestApprove(s, planTestClient(s, user), tk.ID, "plan-step-1", "approve", "")

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("批准路径返回错误：%v", r.err)
		}
		if r.action != "approve" {
			t.Fatalf("批准路径结果不符：action=%q", r.action)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("批准后任务未从挂起中唤醒")
	}
	if !tk.planApprovedLoad() {
		t.Fatalf("批准后 planApproved 应置位（门禁解锁依据）")
	}
	tk.mu.Lock()
	todo := tk.todo
	tk.mu.Unlock()
	if len(todo) != 2 || todo[0].Content != "创建配置模块" || todo[0].Status != "pending" {
		t.Fatalf("批准后计划步骤未同步为任务清单：%+v", todo)
	}
}

// TestAgentPlanRejectFlow 用户驳回 → 意见回传模型，门禁保持锁定
func TestAgentPlanRejectFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest2"
	tk := planTestTask(s, user)

	done := make(chan struct{}, 1)
	var gotAction, gotFB string
	go func() {
		action, fb, err := s.agentWaitPlanApproval(tk, "plan-step-2", "", "", []map[string]interface{}{{"content": "步骤"}})
		if err == nil {
			gotAction = action
			gotFB = fb
		}
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	planTestApprove(s, planTestClient(s, user), tk.ID, "plan-step-2", "reject", "改用独立包不要塞进 config")

	select {
	case <-done:
		if gotAction != "reject" {
			t.Fatalf("驳回路径结果不符：action=%q", gotAction)
		}
		if gotFB != "改用独立包不要塞进 config" {
			t.Fatalf("驳回意见未回传：%q", gotFB)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("驳回后任务未从挂起中唤醒")
	}
	if tk.planApprovedLoad() {
		t.Fatalf("驳回后 planApproved 不应置位（门禁须保持锁定）")
	}
}

// TestAgentPlanCancelFlow 用户停止任务 → 挂起中的计划审批被取消唤醒（与审批取消同语义）
func TestAgentPlanCancelFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest3"
	tk := planTestTask(s, user)

	done := make(chan struct{}, 1)
	var gotAction string
	go func() {
		action, _, err := s.agentWaitPlanApproval(tk, "plan-step-3", "", "", []map[string]interface{}{{"content": "步骤"}})
		if err == nil {
			gotAction = action
		}
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	// 模拟停止按钮路径：handleAgentRun 取消分支对 planCh 的唤醒逻辑
	tk.mu.Lock()
	ch := tk.planCh
	tk.mu.Unlock()
	if ch == nil {
		t.Fatalf("计划审批挂起未建立")
	}
	select {
	case ch <- &AgentApproval{Action: "cancel"}:
	default:
	}

	select {
	case <-done:
		if gotAction != "cancel" {
			t.Fatalf("取消路径结果不符：action=%q", gotAction)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("取消后任务未从挂起中唤醒")
	}
}

// TestAgentPlanTimeoutFlow 等待超时 → 返回错误（任务收口为 failed，与审批超时同语义）
func TestAgentPlanTimeoutFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest4"
	tk := planTestTask(s, user)

	origin := agentApproveWait.Load()
	agentApproveWait.Store(1)
	defer agentApproveWait.Store(origin)

	start := time.Now()
	_, _, err := s.agentWaitPlanApproval(tk, "plan-step-4", "", "", []map[string]interface{}{{"content": "步骤"}})
	if err == nil {
		t.Fatalf("超时路径应返回错误")
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("超时触发过早（%v），未按配置等待", elapsed)
	}
}

// TestAgentPlanForeignUserRejected 非发起人审批直接忽略（不投递、不报错、不崩溃）
func TestAgentPlanForeignUserRejected(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest5"
	tk := planTestTask(s, user)

	done := make(chan struct{}, 1)
	go func() {
		s.agentWaitPlanApproval(tk, "plan-step-5", "", "", []map[string]interface{}{{"content": "步骤"}})
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	// 他人审批：handleAgentPlan 应静默忽略（任务保持挂起）
	planTestApprove(s, planTestClient(s, "otheruser"), tk.ID, "plan-step-5", "approve", "")

	select {
	case <-done:
		t.Fatalf("非发起人的审批不应唤醒挂起中的计划")
	case <-time.After(500 * time.Millisecond):
		// 符合预期：仍挂起
	}
	// 清理：投递 cancel 唤醒收尾
	tk.mu.Lock()
	ch := tk.planCh
	tk.mu.Unlock()
	if ch != nil {
		select {
		case ch <- &AgentApproval{Action: "cancel"}:
		default:
		}
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("清理投递未被唤醒")
	}
}

// TestAgentPlanUnknownActionRejected 非法审批操作被拒收（协议校验归口）
func TestAgentPlanUnknownActionRejected(t *testing.T) {
	s := NewServer(config.Load())
	user := "plantest6"
	tk := planTestTask(s, user)

	done := make(chan struct{}, 1)
	go func() {
		s.agentWaitPlanApproval(tk, "plan-step-6", "", "", []map[string]interface{}{{"content": "步骤"}})
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	planTestApprove(s, planTestClient(s, user), tk.ID, "plan-step-6", "whitelist", "")

	select {
	case <-done:
		t.Fatalf("非法审批操作不应唤醒挂起中的计划")
	case <-time.After(500 * time.Millisecond):
		// 符合预期：仍挂起
	}
	tk.mu.Lock()
	ch := tk.planCh
	tk.mu.Unlock()
	if ch != nil {
		select {
		case ch <- &AgentApproval{Action: "cancel"}:
		default:
		}
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("清理投递未被唤醒")
	}
}

// planTestClient 构造测试客户端（与 askTestClient 同款）
func planTestClient(s *Server, username string) *Client {
	c := newClient(s, nil, "")
	c.username = username
	return c
}
