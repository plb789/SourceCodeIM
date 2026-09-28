package server

// 阶段一百七十九：任务运行中追加指令（Steering）单测。
// 覆盖：入队/取出语义（取出即清空、TrimSpace）、活跃任务查找归口
//（用户+智能体+会话三键匹配、仅 running、queued/他人/跨会话不命中）。

import (
	"strings"
	"testing"
)

// steerTestTask 构造并注册任务桩（agentTasks 全局注册表，用完清理）
func steerTestTask(t *testing.T, id, username, agentName string, sid uint, status string) *AgentTask {
	t.Helper()
	tk := &AgentTask{
		ID:        id,
		Username:  username,
		Agent:     &AIRunAgent{Name: agentName},
		Goal:      "测试 Steering",
		Status:    status,
		SessionID: sid,
	}
	agentTasks.Store(tk.ID, tk)
	t.Cleanup(func() { agentTasks.Delete(tk.ID) })
	return tk
}

// TestAgentSteerPushDrain 入队/取出：FIFO 顺序、取出即清空、首尾空白归一
func TestAgentSteerPushDrain(t *testing.T) {
	tk := steerTestTask(t, "steer-t1", "steeru1", "bot", 0, "running")
	tk.agentPushSteer("  先看看配置文件 ")
	tk.agentPushSteer("然后顺便补个单测")
	if got := tk.agentDrainSteers(); len(got) != 2 || got[0] != "先看看配置文件" || got[1] != "然后顺便补个单测" {
		t.Fatalf("取出内容不符：%v", got)
	}
	if got := tk.agentDrainSteers(); len(got) != 0 {
		t.Fatalf("取出后应清空，实际再次取出 %v", got)
	}
}

// TestAgentSteerInjectFormat 注入格式：drain 结果以【用户追加指令】前缀成为 user 消息（主循环同款）
func TestAgentSteerInjectFormat(t *testing.T) {
	tk := steerTestTask(t, "steer-t2", "steeru2", "bot", 0, "running")
	tk.agentPushSteer("调整方向")
	steers := tk.agentDrainSteers()
	if len(steers) != 1 || !strings.HasPrefix("【用户追加指令】"+steers[0], "【用户追加指令】调整方向") {
		t.Fatalf("注入前缀格式不符：%v", steers)
	}
}

// TestAgentActiveTaskFor 活跃任务查找：三键匹配 + 仅 running 命中
func TestAgentActiveTaskFor(t *testing.T) {
	hit := steerTestTask(t, "steer-t3", "steeru3", "bot", 7, "running")
	if got := agentActiveTaskFor("steeru3", "bot", 7); got != hit {
		t.Fatalf("应命中运行中任务")
	}
	// queued 不命中（目标已定不接插话）
	steerTestTask(t, "steer-t4", "steeru4", "bot", 7, "queued")
	if got := agentActiveTaskFor("steeru4", "bot", 7); got != nil {
		t.Fatalf("queued 任务不应被 Steering 命中")
	}
	// 会话/用户/智能体不符不命中
	if got := agentActiveTaskFor("steeru3", "bot", 8); got != nil {
		t.Fatalf("跨会话不应命中")
	}
	if got := agentActiveTaskFor("other", "bot", 7); got != nil {
		t.Fatalf("他人任务不应命中")
	}
	if got := agentActiveTaskFor("steeru3", "other-bot", 7); got != nil {
		t.Fatalf("跨智能体不应命中")
	}
}
