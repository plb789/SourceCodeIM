package server

import (
	"fmt"
	"strings"
	"sync/atomic"
)

// ===== 阶段九十一：Agent 内置浏览器工具（TRAE CN 同款内置浏览区，PC 端本地执行） =====
//
// 工具族 browser_*：由 PC 端 BrowserManager（Electron 主进程 WebContentsView）在用户电脑上执行，
// 服务端仅负责 schema 注入、审批分级与 PC 本地执行分派（与 mcp_pc_ 同款链路：非 serverOnly 工具
// 经 agentToolExecDispatch 下发 msg 50/51 回传）。
//
// 与 http_request（服务端静态抓取）的分工：browser_* 能执行页面 JS、点击/填表、截图，
// 覆盖登录后动态页面与 SPA 场景；http_request 仍归口服务端（无 PC 也能用）。

// agentBrowserEnabled 内置浏览器工具开关（InitAgent 从 ai.agent.pc_browser 加载，后台可热改）
var agentBrowserEnabled atomic.Bool

// agentBrowserTools browser_* 工具名集合（注入/审批/label 归口判定用）
var agentBrowserTools = map[string]bool{
	"browser_navigate":  true,
	"browser_snapshot":  true,
	"browser_click":     true,
	"browser_input":     true,
	"browser_screenshot": true,
	"browser_eval":      true,
	"browser_tabs":      true,
	"browser_close":     true,
}

// agentBrowserSnapshotMax 快照回传字符上限（防超长页面撑爆模型上下文）
const agentBrowserSnapshotMax = 12000

// isAgentBrowserTool 判定是否内置浏览器工具
func isAgentBrowserTool(tool string) bool {
	return agentBrowserTools[tool]
}

// agentBrowserToolDefs browser_* 工具 OpenAI function calling 定义（仅 PC 在线时注入，
// 由 agentToolDefinitions 归口把关；描述里给模型写清 ref 工作流：先 snapshot 拿 ref 再 click/input）
func agentBrowserToolDefs() []aiToolDefinition {
	return []aiToolDefinition{
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_navigate",
			"description": "在用户的内置浏览器中打开网页（自动展示浏览区面板，用户可实时看到页面）。用于访问需要登录态/JS 渲染的页面，配合 browser_snapshot 读取内容、browser_click/browser_input 操作页面。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url":     map[string]interface{}{"type": "string", "description": "完整网址（http/https，须带协议）"},
					"new_tab": map[string]interface{}{"type": "boolean", "description": "是否在新标签页打开（默认 false 复用当前标签页）"},
				},
				"required": []string{"url"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_snapshot",
			"description": "读取当前浏览器页面：返回可交互元素清单（带 ref 编号：链接/按钮/输入框/下拉框等）与页面文本概要。点击或填写前必须先调用本工具获取元素 ref。",
			"parameters": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_click",
			"description": "点击浏览器页面中的元素（按 browser_snapshot 返回的 ref 定位）。页面跳转/弹层后需重新 snapshot。需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"ref": map[string]interface{}{"type": "string", "description": "browser_snapshot 返回的元素 ref 编号"},
				},
				"required": []string{"ref"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_input",
			"description": "向浏览器页面的输入框填写文本（按 browser_snapshot 返回的 ref 定位；支持 input/textarea/contenteditable）。需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"ref":   map[string]interface{}{"type": "string", "description": "browser_snapshot 返回的输入框 ref 编号"},
					"text":  map[string]interface{}{"type": "string", "description": "要填写的文本"},
					"clear": map[string]interface{}{"type": "boolean", "description": "填写前是否清空原内容，默认 true"},
				},
				"required": []string{"ref", "text"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_screenshot",
			"description": "对当前浏览器页面截图（PNG），保存到用户电脑并返回文件路径（用户可在浏览区实时看到页面）。",
			"parameters": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_eval",
			"description": "在当前浏览器页面执行任意 JavaScript 并返回结果（读取页面变量/DOM、触发复杂交互时使用）。高危操作，需要用户审批。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"expression": map[string]interface{}{"type": "string", "description": "要执行的 JavaScript 表达式（返回值需可 JSON 序列化）"},
				},
				"required": []string{"expression"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_tabs",
			"description": "管理浏览器标签页：list 列出全部标签页（含 tab_id/标题/网址）、select 切换活动标签页、close 关闭指定标签页。",
			"parameters": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"action": map[string]interface{}{"type": "string", "enum": []string{"list", "select", "close"}, "description": "操作类型"},
					"tab_id": map[string]interface{}{"type": "string", "description": "select/close 时的目标标签页 ID（list 结果中获取）"},
				},
				"required": []string{"action"},
			},
		}},
		{Type: "function", Function: map[string]interface{}{
			"name":        "browser_close",
			"description": "关闭当前浏览器标签页（不传 tab_id）；全部标签页关闭后浏览区自动收起。",
			"parameters": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		}},
	}
}

// agentBrowserNeedsApproval browser_* 审批分级：只读/导航/tab 管理免审批（与用户手动浏览一致，
// 页面内容用户在浏览区实时可见）；click/input 会改变页面状态或提交数据、eval 执行任意脚本——
// 逐次人工审批（审批弹窗可改参放行/直接放行/拒绝）
func agentBrowserNeedsApproval(tool string) (bool, string) {
	switch tool {
	case "browser_navigate", "browser_snapshot", "browser_screenshot", "browser_tabs", "browser_close":
		return false, ""
	case "browser_click":
		return true, "在内置浏览器页面中点击元素，可能跳转或提交数据，请确认"
	case "browser_input":
		return true, "向内置浏览器页面输入框填写内容，可能涉及表单提交，请确认"
	case "browser_eval":
		return true, "在内置浏览器页面执行任意 JavaScript 脚本，请确认脚本内容无风险"
	}
	return true, "未知浏览器工具默认走人工审批"
}

// agentBrowserLabel browser_* 工具的人类可读展示名（tool_start 事件 label 归口下发）
func agentBrowserLabel(tool string) string {
	labels := map[string]string{
		"browser_navigate":   "内置浏览器 · 打开页面",
		"browser_snapshot":   "内置浏览器 · 读取页面",
		"browser_click":      "内置浏览器 · 点击元素",
		"browser_input":      "内置浏览器 · 填写输入",
		"browser_screenshot": "内置浏览器 · 页面截图",
		"browser_eval":       "内置浏览器 · 执行脚本",
		"browser_tabs":       "内置浏览器 · 标签页管理",
		"browser_close":      "内置浏览器 · 关闭标签页",
	}
	if l, ok := labels[tool]; ok {
		return l
	}
	return ""
}

// agentBrowserPcFallbackMsg browser_* 工具落到服务端兜底时的报错（stdio 等价物不存在——
// WebContentsView 在用户电脑上，服务端无浏览器可执行；与 mcp_pc_ 兜底同款语义）
func agentBrowserPcFallbackMsg(tool string) string {
	if !isAgentBrowserTool(tool) {
		return ""
	}
	if !agentBrowserEnabled.Load() {
		return fmt.Sprintf("错误：内置浏览器功能已关闭（ai.agent.pc_browser），工具 %s 不可用", tool)
	}
	return "错误：内置浏览器工具仅在用户的 PC 端在线时可用（当前 PC 端离线或执行回传超时），请告知用户启动 PC 端后重试"
}

// agentBrowserNameClean URL 协议白名单校验（服务端注入前快检：file/javascript/data 等协议直接拒绝，
// 真正执行仍由 PC 端二次校验——服务端快检让模型在审批前就拿到明确错误）
func agentBrowserURLAllowed(raw string) bool {
	u := strings.ToLower(strings.TrimSpace(raw))
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}
