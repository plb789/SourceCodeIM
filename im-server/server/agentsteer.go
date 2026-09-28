package server

// 阶段一百七十九：任务运行中追加指令（Steering，TRAE 同款插话）
// 任务 running 期间用户在同一会话发纯文本提问 → 转"追加指令"入任务队列（照常落库回显，
// 会话历史成对可见），运行中任务在下一轮模型决策前取出，以【用户追加指令】user 消息注入
// 上下文，模型自然调整方向——无需停止任务。
// 范围约束：仅 running 任务（queued 任务目标已定不插话）；仅纯文本提问（图片/文档/联网
// 提问走原问答链路）；审批/提问挂起期间插话只入队不唤醒（唤醒后下一轮同样可见）；
// 任务取消/完结后插话自然丢弃（队列随任务对象即弃）。

import (
	"strings"
)

// agentPushSteer 入队一条用户追加指令（并发安全：主循环 drain 与上行归口 push 并发）
func (t *AgentTask) agentPushSteer(text string) {
	t.mu.Lock()
	t.steers = append(t.steers, strings.TrimSpace(text))
	t.mu.Unlock()
}

// agentDrainSteers 取出并清空全部待注入追加指令（主循环每轮模型调用前调用一次）
func (t *AgentTask) agentDrainSteers() []string {
	t.mu.Lock()
	out := t.steers
	t.steers = nil
	t.mu.Unlock()
	return out
}

// agentActiveTaskFor 查用户对指定智能体+会话的运行中任务（Steering 归口；无则 nil）。
// 同会话同智能体同时最多一个 running 任务（排队机制保证），取首个命中
func agentActiveTaskFor(username, agentName string, sid uint) *AgentTask {
	var found *AgentTask
	agentTasks.Range(func(k, v interface{}) bool {
		tk, ok := v.(*AgentTask)
		if !ok || tk.Agent == nil {
			return true
		}
		tk.mu.Lock()
		st := tk.Status
		tk.mu.Unlock()
		if st == "running" && tk.Username == username && tk.SessionID == sid && tk.Agent.Name == agentName {
			found = tk
			return false
		}
		return true
	})
	return found
}
