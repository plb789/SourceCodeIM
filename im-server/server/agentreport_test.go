package server

// 阶段一百八十五：任务报告导出 Markdown——渲染归口纯函数单测（无需 DB）。
// 覆盖：状态三选一结果段（completed/failed/cancelled）、表格竖线转义、围栏嵌套升级、
// 耗时/Token/积分零值兜底、来源标注（手动/定时）、空步骤与空变更省略。

import (
	"strings"
	"testing"
	"time"

	"im-server/model"
)

func TestAgentReportDuration(t *testing.T) {
	cases := map[int64]string{
		0:     "—",
		-5:    "—",
		900:   "0 秒", // 不足 1 秒仍按秒取整显示 0 秒（如实）
		5900:  "5 秒",
		83000: "1 分 23 秒",
		3661000: "61 分 1 秒",
	}
	for ms, want := range cases {
		if got := agentReportDuration(ms); got != want {
			t.Fatalf("agentReportDuration(%d)=%q, want %q", ms, got, want)
		}
	}
}

func TestMdTableEscape(t *testing.T) {
	if got := mdTableEscape("a|b\nc\nd"); got != "a\\|b c d" {
		t.Fatalf("表格转义不符: %q", got)
	}
	if got := mdTableEscape("普通文本"); got != "普通文本" {
		t.Fatalf("普通文本不应被改写: %q", got)
	}
}

func TestMdFence(t *testing.T) {
	if got := mdFence(`{"k":1}`); !strings.HasPrefix(got, "```text\n") {
		t.Fatalf("普通内容应三反引号: %q", got)
	}
	nested := "前面\n```\n内部围栏"
	got := mdFence(nested)
	if !strings.HasPrefix(got, "````text\n") {
		t.Fatalf("含三反引号内容应升级四反引号: %q", got)
	}
	if !strings.HasSuffix(got, "\n````") {
		t.Fatalf("围栏应闭合且结尾换行: %q", got)
	}
}

func TestAgentReportMarkdownCompleted(t *testing.T) {
	now := time.Date(2026, 9, 28, 5, 14, 0, 0, time.Local)
	rec := &model.AgentTaskRecord{
		TaskID: "agt_123", Username: "alice", AgentName: "coder", Status: "completed",
		Goal: "巡检服务日志", Result: "截断版结果", Source: "cron",
		ElapsedMs: 83000, Steps: 2, PointsCost: 3.5,
		CreateTime: now, UpdateTime: now.Add(83 * time.Second),
	}
	steps := []model.AgentStepRecord{
		{TaskID: "agt_123", Seq: 1, Tool: "write_file", Params: `{"path":"a.md"}`, Result: "ok", OK: true, Env: "server", Approval: "auto", DurationMS: 120},
		{TaskID: "agt_123", Seq: 2, Tool: "run_cmd", Params: `{}`, Result: "err line", OK: false, Env: "server", DurationMS: 5000},
	}
	changes := []model.AgentChangeRecord{
		{TaskID: "agt_123", Username: "alice", Path: "docs/a.md", Kind: "create", Adds: 12, Status: "kept", Explanation: "新报告"},
	}
	got := agentReportMarkdown(rec, "全文结果", [3]int{100, 200, 300}, steps, changes)

	// 元信息：来源 cron 标注 / 状态 / 耗时 / 积分 / Token
	for _, want := range []string{
		"# Agent 任务报告", "| 发起来源 | 定时任务 |", "| 状态 | 已完成 |",
		"| 耗时 | 1 分 23 秒 |", "| 积分消耗 | 3.5 |", "| Token 消耗 | 提问 100 / 回答 200 / 合计 300 |",
		"巡检服务日志", // goal 原文
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("completed 报告缺 %q\n---\n%s", want, got)
		}
	}
	// 执行结果应为全文（reply 内容）而非库内截断版
	if !strings.Contains(got, "全文结果") || strings.Contains(got, "截断版结果") {
		t.Fatalf("执行结果应取答复全文而非截断版")
	}
	// 变更表与步骤段
	for _, want := range []string{
		"## 文件变更（1 项）", "| docs/a.md | 新增 | 已保留 | +12 / -0 | 新报告 |",
		"## 执行轨迹（2 步）", "### 第 1 步 · write_file（成功）", "### 第 2 步 · run_cmd（失败）",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("completed 报告缺 %q\n---\n%s", want, got)
		}
	}
}

func TestAgentReportMarkdownStatesAndEmpties(t *testing.T) {
	// failed：失败原因段 + 零值兜底（耗时/积分/Token —、手动来源）
	rec := &model.AgentTaskRecord{TaskID: "agt_f", AgentName: "bot", Status: "failed", Error: "超时", Steps: 0}
	got := agentReportMarkdown(rec, "", [3]int{}, nil, nil)
	for _, want := range []string{"| 状态 | 失败 |", "| 发起来源 | 手动发起 |", "| 耗时 | — |", "| 积分消耗 | — |", "| Token 消耗 | — |", "## 失败原因", "超时", "无工具调用。"} {
		if !strings.Contains(got, want) {
			t.Fatalf("failed 报告缺 %q\n---\n%s", want, got)
		}
	}
	if strings.Contains(got, "## 执行结果") || strings.Contains(got, "## 文件变更") {
		t.Fatalf("failed 报告不应有结果/变更段")
	}

	// cancelled：取消说明段
	rec2 := &model.AgentTaskRecord{TaskID: "agt_c", AgentName: "bot", Status: "cancelled"}
	got2 := agentReportMarkdown(rec2, "", [3]int{}, nil, nil)
	if !strings.Contains(got2, "## 取消说明") || !strings.Contains(got2, "任务已取消") {
		t.Fatalf("cancelled 报告缺取消说明\n---\n%s", got2)
	}

	// running：无结果段、无轨迹说明
	rec3 := &model.AgentTaskRecord{TaskID: "agt_r", AgentName: "bot", Status: "running"}
	got3 := agentReportMarkdown(rec3, "", [3]int{}, nil, nil)
	if strings.Contains(got3, "## 执行结果") || strings.Contains(got3, "## 失败原因") {
		t.Fatalf("running 报告不应有结果段")
	}

	// 空目标兜底
	rec4 := &model.AgentTaskRecord{TaskID: "agt_e", AgentName: "bot", Status: "completed"}
	got4 := agentReportMarkdown(rec4, "", [3]int{}, nil, nil)
	if !strings.Contains(got4, "（无）") || !strings.Contains(got4, "（无结果记录）") {
		t.Fatalf("空目标/空结果应兜底占位\n---\n%s", got4)
	}
}
