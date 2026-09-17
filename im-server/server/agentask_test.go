package server

// 阶段一百二十五：ask_user 向用户提问链路集成测试（真实 MySQL：需本地 config.yaml 可连，无库自动跳过）。
// 覆盖：提问挂起→用户上行回答→答案回喂、跳过（取消回答）、任务停止取消、等待超时、
// 工具注册（schema 注入与服务端专属标记，防误下发 PC 本地执行器）。

import (
	"context"
	"testing"
	"time"

	"im-server/config"
	"im-server/protocol"
)

func askTestTask(s *Server, username string) *AgentTask {
	tk := &AgentTask{
		ID:       "ask-test-" + username,
		Username: username,
		Agent:    &AIRunAgent{Name: "askbot"}, // 事件流 FromUser 取 t.Agent.Name（生产任务恒已绑定，测试桩需显式补齐）
		Goal:     "测试提问链路",
		Status:   "running",
	}
	// 阶段一百三十八：对齐生产创建归口（handleAgentRun）初始化任务级取消上下文，
	// 防止测试路径触达 runCtx 相关逻辑时空指针
	tk.runCtx, tk.runCancel = context.WithCancel(context.Background())
	// handleAgentAsk 按任务注册表归口查找（生产由 handleAgentRun 登记），测试桩需显式注册
	agentTasks.Store(tk.ID, tk)
	return tk
}

func askTestClient(s *Server, username string) *Client {
	c := newClient(s, nil)
	c.username = username
	return c
}

// askTestAsk 上行用户回答（构造 68 号消息走 handleAgentAsk 真实入口）
func askTestAsk(s *Server, c *Client, taskID, step, action, answer string) {
	content := `{"task_id":"` + taskID + `","step":"` + step + `","action":"` + action + `","answer":"` + answer + `"}`
	s.handleAgentAsk(c, &protocol.Message{MsgType: protocol.MsgTypeAgentAsk, FromUser: c.username, Content: content})
}

// TestAgentAskToolRegistered 工具注册归口：schema 注入 + 服务端专属（不下发 PC 本地执行器）
func TestAgentAskToolRegistered(t *testing.T) {
	s := NewServer(config.Load())
	if !agentToolServerOnly("ask_user") {
		t.Fatalf("ask_user 应标记为服务端专属工具（禁止下发 PC 本地执行器）")
	}
	defs := s.agentToolDefinitions("asktest1")
	found := false
	for _, d := range defs {
		if name, _ := d.Function["name"].(string); name == "ask_user" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("agentToolDefinitions 未注入 ask_user 工具 schema")
	}
}

// TestAgentAskAnswerFlow 提问挂起 → 用户选择选项回答 → 答案回喂模型
func TestAgentAskAnswerFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "asktest1"
	tk := askTestTask(s, user)
	params := map[string]interface{}{
		"question": "升级后首次启动如何处理旧登录态？",
		"options": []interface{}{
			map[string]interface{}{"label": "自动迁移登录态", "recommended": true},
			map[string]interface{}{"label": "接受一次性重新登录"},
		},
	}

	type waitResult struct {
		action string
		answer string
		err    error
	}
	done := make(chan waitResult, 1)
	go func() {
		action, answer, err := s.agentWaitAskUser(tk, "step-1", params)
		done <- waitResult{action, answer, err}
	}()

	time.Sleep(200 * time.Millisecond) // 等挂起建立（askCh 注册）
	tk.mu.Lock()
	waiting := tk.askCh != nil && tk.askStep == "step-1"
	tk.mu.Unlock()
	if !waiting {
		t.Fatalf("提问后任务未进入挂起等待态（askCh 未注册或步骤键不符）")
	}

	askTestAsk(s, askTestClient(s, user), tk.ID, "step-1", "answer", "自动迁移登录态")

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("回答路径返回错误：%v", r.err)
		}
		if r.action != "answer" || r.answer != "自动迁移登录态" {
			t.Fatalf("回答路径结果不符：action=%q answer=%q", r.action, r.answer)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("回答后任务未从挂起中唤醒")
	}
}

// TestAgentAskSkipFlow 用户取消本次回答（skip）→ 模型收到跳过说明继续推进
func TestAgentAskSkipFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "asktest2"
	tk := askTestTask(s, user)
	params := map[string]interface{}{"question": "需要用户决策的问题"}

	done := make(chan struct{}, 1)
	var gotAction string
	go func() {
		action, _, err := s.agentWaitAskUser(tk, "step-2", params)
		if err == nil {
			gotAction = action
		}
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	askTestAsk(s, askTestClient(s, user), tk.ID, "step-2", "skip", "")

	select {
	case <-done:
		if gotAction != "skip" {
			t.Fatalf("跳过路径结果不符：action=%q", gotAction)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("跳过后任务未从挂起中唤醒")
	}
}

// TestAgentAskCancelFlow 用户停止任务 → 挂起中的提问被取消唤醒（与审批取消同语义）
func TestAgentAskCancelFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "asktest3"
	tk := askTestTask(s, user)

	done := make(chan struct{}, 1)
	var gotAction string
	go func() {
		action, _, err := s.agentWaitAskUser(tk, "step-3", map[string]interface{}{"question": "q"})
		if err == nil {
			gotAction = action
		}
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	// 模拟停止按钮路径：直接向 askCh 投递 cancel（handleAgentRun 取消分支对提问通道的唤醒逻辑）
	tk.mu.Lock()
	ch := tk.askCh
	tk.mu.Unlock()
	if ch == nil {
		t.Fatalf("提问挂起未建立")
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

// TestAgentAskTimeoutFlow 等待超时 → 返回错误（任务收口为 failed，与审批超时同语义）
func TestAgentAskTimeoutFlow(t *testing.T) {
	s := NewServer(config.Load())
	user := "asktest4"
	tk := askTestTask(s, user)

	// 临时压缩等待秒数（全局 atomic，测试后恢复，防影响其他用例）
	origin := agentApproveWait.Load()
	agentApproveWait.Store(1)
	defer agentApproveWait.Store(origin)

	start := time.Now()
	_, _, err := s.agentWaitAskUser(tk, "step-4", map[string]interface{}{"question": "q"})
	if err == nil {
		t.Fatalf("超时路径应返回错误")
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("超时触发过早（%v），未按配置等待", elapsed)
	}
}

// TestAgentAskForeignUserRejected 非发起人回答直接忽略（不投递、不报错、不崩溃）
func TestAgentAskForeignUserRejected(t *testing.T) {
	s := NewServer(config.Load())
	user := "asktest5"
	tk := askTestTask(s, user)

	done := make(chan struct{}, 1)
	go func() {
		s.agentWaitAskUser(tk, "step-5", map[string]interface{}{"question": "q"})
		done <- struct{}{}
	}()

	time.Sleep(200 * time.Millisecond)
	// 他人回答：handleAgentAsk 应静默忽略（任务保持挂起）
	askTestAsk(s, askTestClient(s, "otheruser"), tk.ID, "step-5", "answer", "冒充回答")

	select {
	case <-done:
		t.Fatalf("非发起人的回答不应唤醒挂起中的提问")
	case <-time.After(500 * time.Millisecond):
		// 符合预期：仍挂起
	}
	// 清理：投递 skip 唤醒收尾
	askTestAsk(s, askTestClient(s, user), tk.ID, "step-5", "skip", "")
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("清理投递未被唤醒")
	}
}
