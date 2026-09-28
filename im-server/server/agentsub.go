package server

// 阶段一百七十八：子 Agent 并行协作（TRAE CN 同款"子 Agent 派生"）
// 主 Agent 经 spawn_agent 工具派生轻量子 Agent 并行调研：子 Agent 是独立模型会话 +
// 固定只读工具集（read_file/list_dir/grep/web_search/fetch_page/semantic_search），
// 有限步数与超时内自主执行，最终结论文本作为 spawn_agent 的工具结果回喂主 Agent 汇总。
// 并行语义：spawn_agent 入并行白名单（agentToolParallelizable），主 Agent 一轮 tool_calls
// 发多个 spawn_agent 即天然并发执行（agentRunToolBatch goroutine 批）。
// 安全设计：①子 Agent 工具集为固定只读白名单（服务端直接执行，不碰 PC 通道——并行子任务
// 会争用任务级单槽 execCh）且 exec 层再防御（防递归派生/防副作用工具）；②子 Agent 挂在
// 父任务取消树下（父取消子即停）；③每任务派生数上限；④步数/超时双上限；⑤子 Agent 无
// 审批/提问/计划等交互分支（纯调研语义，无挂起面）。

import (
	"context"
	"encoding/json"
	"im-server/logger"
	"strconv"
	"strings"
	"time"
)

const (
	agentSubMaxSteps   = 12                // 子 Agent 最大模型轮数（步数上限，超限强制总结）
	agentSubTimeout    = 150 * time.Second // 子 Agent 总超时（挂父任务取消树下）
	agentSubMaxPerTask = 8                 // 每任务累计派生子 Agent 数上限（防模型循环派生烧钱）
)

// agentSubChatFn 子 Agent 模型调用归口（非流式带工具；包级变量供单测注入假上游）
var agentSubChatFn = aiAgentChat

// agentSubTools 子 Agent 固定只读工具集（spawn_agent 不在其中=递归防护第一层）
func agentSubToolDefs() []aiToolDefinition {
	tools := []aiToolDefinition{
		{Type: "function", Function: map[string]interface{}{
			"name":        "read_file",
			"description": "读取文本文件内容（工作区相对路径）。大文件可用 offset/limit 按行分段读取。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":   map[string]interface{}{"type": "string", "description": "工作区内相对路径"},
					"offset": map[string]interface{}{"type": "integer", "description": "起始行号（1 起）"},
					"limit":  map[string]interface{}{"type": "integer", "description": "最多读取行数"},
				},
				"required": []string{"path"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "list_dir",
			"description": "列出目录内容（子目录在前、文件在后，含文件大小）。",
			"parameters": map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{"path": map[string]interface{}{"type": "string", "description": "目录相对路径（默认工作区根目录）"}},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "grep",
			"description": "在工作区内按内容搜索文件（返回 文件:行号: 内容），自动跳过二进制与依赖目录。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"pattern":     map[string]interface{}{"type": "string", "description": "搜索文本或正则"},
					"is_regex":    map[string]interface{}{"type": "boolean", "description": "pattern 按正则解析，默认 false"},
					"path":        map[string]interface{}{"type": "string", "description": "搜索起点相对路径（默认根目录）"},
					"include":     map[string]interface{}{"type": "string", "description": "文件名过滤通配符（如 *.go）"},
					"max_results": map[string]interface{}{"type": "integer", "description": "最多返回条数（默认 50）"},
				},
				"required": []string{"pattern"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "web_search",
			"description": "联网搜索（只读），返回网页结果列表。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query":       map[string]interface{}{"type": "string", "description": "搜索关键词"},
					"max_results": map[string]interface{}{"type": "integer", "description": "最多返回条数（默认 8）"},
				},
				"required": []string{"query"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "fetch_page",
			"description": "抓取网页转 Markdown 正文（只读 GET）。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url": map[string]interface{}{"type": "string", "description": "完整网页地址"},
				},
				"required": []string{"url"},
			},
		}},
	}
	// 语义检索按主任务同口径门控（未配置嵌入服务不下发，防误调用）
	if kbEmbedEnabled() {
		tools = append(tools, aiToolDefinition{Type: "function", Function: map[string]interface{}{
			"name":        "semantic_search",
			"description": "工作区语义检索（按含义定位代码/文档片段）。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "自然语言查询"},
					"path":  map[string]interface{}{"type": "string", "description": "限定子目录（可选）"},
				},
				"required": []string{"query"},
			},
		}})
	}
	return tools
}

// agentSubToolAllowed 子 Agent 可用工具白名单（exec 层第二道递归/副作用防线：
// 即使模型被诱导调用白名单外工具，服务端也直接拒绝执行）
func agentSubToolAllowed(tool string) bool {
	switch tool {
	case "read_file", "list_dir", "grep", "web_search", "fetch_page", "semantic_search":
		return true
	}
	return false
}

// agentSubAgentRun 派生并运行一个子 Agent（spawn_agent 工具执行体），返回最终结论文本。
// 轻量循环：模型决策 → 只读工具执行 → 循环；无 tool_calls 即视为结论输出。
// 失败/超时/取消均以「错误：…」文本返回（与工具错误语义一致，主 Agent 自行降级）
func (s *Server) agentSubAgentRun(parent *AgentTask, goal string) string {
	goal = strings.TrimSpace(goal)
	if goal == "" {
		return "错误：子 Agent 缺少调研目标（goal）"
	}
	// 每任务派生数上限（并发安全：并行批里多个 spawn_agent 同时到达）
	parent.mu.Lock()
	parent.subCount++
	n := parent.subCount
	parent.mu.Unlock()
	if n > agentSubMaxPerTask {
		return "错误：本任务派生子 Agent 数已达上限（" + strconv.Itoa(agentSubMaxPerTask) + "）"
	}
	logger.Info("Agent 派生子 Agent（任务 %s，用户 %s，第 %d 个，目标 %q）", parent.ID, parent.Username, n, goal)

	// 挂父任务取消树下：父任务取消/超时，子 Agent 的上游调用即刻中止
	ctx, cancel := context.WithTimeout(parent.runCtx, agentSubTimeout)
	defer cancel()

	sys := "你是主 Agent 派生的子 Agent（并行调研专员）。工作纪律：\n" +
		"1. 你只有只读调研工具（读文件/列目录/搜索/联网检索），专注完成主 Agent 交给的单一调研目标。\n" +
		"2. 高效探查：优先 grep/semantic_search 定位，再精准 read_file；不要整读大文件、不要重复探查。\n" +
		"3. 调研完成后直接输出结论文本（不要再调用工具）：结论要具体、有据（引用文件路径与关键行内容），可直接供主 Agent 汇总使用。\n" +
		"4. 你没有写文件/执行命令等能力，也不要尝试。"
	msgs := []aiChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: goal},
	}
	tools := agentSubToolDefs()

	for step := 0; step < agentSubMaxSteps; step++ {
		if parent.Cancelled.Load() {
			return "错误：主任务已取消，子 Agent 中止"
		}
		if ctx.Err() != nil {
			return "错误：子 Agent 超时（" + strconv.Itoa(int(agentSubTimeout/time.Second)) + " 秒）"
		}
		content, calls, err := agentSubChatFn(ctx, parent.Agent, msgs, tools)
		if err != nil {
			return "错误：子 Agent 模型调用失败：" + err.Error()
		}
		if len(calls) == 0 {
			out := strings.TrimSpace(content)
			if out == "" {
				return "错误：子 Agent 返回空结论"
			}
			logger.Info("Agent 子 Agent 完成（任务 %s，用户 %s，%d 步，结论 %d 字）", parent.ID, parent.Username, step+1, len([]rune(out)))
			return out
		}
		// 工具调用轮：assistant 消息带 tool_calls 入历史，逐个白名单校验后服务端执行
		msgs = append(msgs, aiChatMessage{Role: "assistant", Content: content, ToolCalls: calls})
		for _, tc := range calls {
			var params map[string]interface{}
			_ = json.Unmarshal([]byte(tc.Function.Arguments), &params)
			out := "错误：子 Agent 仅允许只读调研工具（" + tc.Function.Name + " 不可用）"
			if agentSubToolAllowed(tc.Function.Name) {
				out = agentToolExec(s, parent, tc.ID, tc.Function.Name, params)
			} else {
				logger.Warn("Agent 子 Agent 调用白名单外工具已拦截（任务 %s 工具 %s）", parent.ID, tc.Function.Name)
			}
			msgs = append(msgs, aiChatMessage{
				Role: "tool", Content: agentTruncateToolResult(out), ToolCallID: tc.ID, Name: tc.Function.Name,
			})
		}
	}
	// 步数耗尽：不带工具强制模型收口总结（避免半途而废的空结果）
	if ctx.Err() != nil {
		return "错误：子 Agent 超时（" + strconv.Itoa(int(agentSubTimeout/time.Second)) + " 秒）"
	}
	msgs = append(msgs, aiChatMessage{Role: "user", Content: "已达步数上限，请立即停止探查，基于以上已获取的信息直接输出调研结论。"})
	content, _, err := agentSubChatFn(ctx, parent.Agent, msgs, nil)
	if err != nil {
		return "错误：子 Agent 未能在步数上限内完成（模型收口失败：" + err.Error() + "）"
	}
	out := strings.TrimSpace(content)
	if out == "" {
		return "错误：子 Agent 未能在步数上限内完成"
	}
	logger.Info("Agent 子 Agent 步数耗尽强制收口（任务 %s，用户 %s，%d 步）", parent.ID, parent.Username, agentSubMaxSteps)
	return out
}

// agentSubToolDef spawn_agent 工具 schema（主任务工具定义注入用；子 Agent 工具集不含它）
func agentSubToolDef() aiToolDefinition {
	return aiToolDefinition{Type: "function", Function: map[string]interface{}{
		"name":        "spawn_agent",
		"description": "派生一个子 Agent 并行执行独立的只读调研子任务（读代码/查资料/检索定位），返回其最终结论。适合把一个大调研拆成多个互不依赖的方向同时推进（如「同时梳理 A 模块和 B 模块的调用链」）；一次回复中可发起多个 spawn_agent 并行执行。子 Agent 只有只读工具，不能写文件或执行命令。",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"goal": map[string]interface{}{"type": "string", "description": "子任务目标：一句明确的调研任务描述（如「梳理登录鉴权的完整调用链并列出关键文件与函数」）"},
			},
			"required": []string{"goal"},
		},
	}}
}
