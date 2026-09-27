package server

import (
	"strings"
	"testing"
)

// ===== 阶段一百六十一：GLM 文本工具标记泄漏过滤回归 =====
// 背景：GLM 系端点在无工具定义的普通聊天中，遇"打开网站"类诉求会幻觉输出文本形式
// 工具调用标记（<|tool_calls_section_begin|>...连排单行），原过滤器仅识别 DSML 协议导致原文
// 直进正文。修复后 aiIsToolLeakLine 同时识别 GLM 标记前缀，流式/落库两道防线共用。

func TestLeakLineGlmMark(t *testing.T) {
	line := `<|tool_calls_section_begin|><|tool_call_begin|>functions.execute_bash:0<|tool_call_argument_begin|>{"command": "pwd && ls -la"}<|tool_call_end|><|tool_calls_section_end|>`
	if !aiIsToolLeakLine(line) {
		t.Fatalf("GLM 连排标记行应判为泄漏")
	}
	if !aiIsToolLeakLine("<tool_call_begin>functions.list_directory:0</tool_call_begin>") {
		t.Fatalf("不带竖线的标记变体应判为泄漏")
	}
}

func TestLeakLineDsmlMark(t *testing.T) {
	if !aiIsToolLeakLine(`<|DSML|invoke name="bash">`) {
		t.Fatalf("DSML 协议行应判为泄漏（原行为回归）")
	}
}

func TestLeakLineNormalText(t *testing.T) {
	if aiIsToolLeakLine("正常讨论：a < b 并且提到 tool_call 概念") {
		t.Fatalf("无尖括号+标记组合的正文不应误拦")
	}
	if aiIsToolLeakLine("普通回答，无任何标记。") {
		t.Fatalf("普通正文不应误拦")
	}
}

func TestLeakFilterMixedContent(t *testing.T) {
	// 混排：正文行保留、标记行吞掉（流式逐段喂入模拟分片）
	f := &aiLeakFilter{out: func(string) {}}
	var sb strings.Builder
	f.out = func(s string) { sb.WriteString(s) }
	f.write("我需要先了解当前项目的工作区结构。\n")
	f.write(`<|tool_calls_section_begin|><|tool_call_begin|>functions.execute_bash:0<|tool_call_argument_begin|>{"command": "pwd"}<|tool_call_end|><|tool_calls_section_end|>`)
	f.write("\n继续为你说明。\n")
	f.flush()
	got := sb.String()
	if !strings.Contains(got, "我需要先了解当前项目的工作区结构。") || !strings.Contains(got, "继续为你说明。") {
		t.Fatalf("正文行应完整保留，实际：%q", got)
	}
	if strings.Contains(got, "tool_call") || strings.Contains(got, "execute_bash") {
		t.Fatalf("标记原文应被吞掉，实际：%q", got)
	}
	if !f.blocked {
		t.Fatalf("应标记 blocked 供诊断")
	}
}

func TestSanitizeAllMarkContent(t *testing.T) {
	// 全文均为标记 → 友好提示语
	in := `<|tool_calls_section_begin|><|tool_call_begin|>functions.execute_bash:0<|tool_call_argument_begin|>{"command": "ls"}<|tool_call_end|><|tool_calls_section_end|>`
	if got := aiSanitizeToolLeak(in); got != aiToolLeakNotice {
		t.Fatalf("全文标记应替换为提示语，实际：%q", got)
	}
	// 普通正文原样返回（快路径不误伤）
	if got := aiSanitizeToolLeak("你好，请问有什么可以帮你？"); got != "你好，请问有什么可以帮你？" {
		t.Fatalf("普通正文不应被净化，实际：%q", got)
	}
}
