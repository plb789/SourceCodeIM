package server

// 阶段一百八十五：任务报告导出 Markdown——任务历史一键导出可留档/分享的报告文件。
// 内容归口服务端渲染（防前端双路径漂移）：任务元信息表格 + 目标/结果全文（完结答复消息为锚，
// 回退库内截断版）+ 文件变更清单 + 执行轨迹逐条摘要。
// 鉴权水位与任务详情/轨迹一致（userKBUsername + 归属校验），非本人任务一律 404。

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"im-server/model"
	"im-server/store"
)

// agentReportStateLabel 任务状态中文标签（与前端 thStateLabel 口径一致）
func agentReportStateLabel(s string) string {
	switch s {
	case "queued":
		return "排队中"
	case "running":
		return "运行中"
	case "completed":
		return "已完成"
	case "failed":
		return "失败"
	case "cancelled":
		return "已取消"
	}
	return s
}

// agentReportDuration 耗时格式化：0→"—"；<1 分钟→"N 秒"；其余→"X 分 Y 秒"（与前端展示同口径）
func agentReportDuration(ms int64) string {
	if ms <= 0 {
		return "—"
	}
	sec := ms / 1000
	if sec < 60 {
		return fmt.Sprintf("%d 秒", sec)
	}
	return fmt.Sprintf("%d 分 %d 秒", sec/60, sec%60)
}

// mdTableEscape 表格 cell 转义：竖线会破坏 Markdown 表格列边界，换行强制压平
func mdTableEscape(s string) string {
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.ReplaceAll(s, "|", "\\|")
}

// mdFence 围栏代码块：内容含三反引号时升级四反引号（Markdown 嵌套围栏惯例），结尾保证换行
func mdFence(body string) string {
	fence := "```"
	if strings.Contains(body, "```") {
		fence = "````"
	}
	return fence + "text\n" + body + "\n" + fence
}

// agentReportKindLabel 变更类型标签
func agentReportKindLabel(k string) string {
	switch k {
	case "create":
		return "新增"
	case "modify":
		return "修改"
	case "delete":
		return "删除"
	}
	return k
}

// agentReportChangeStatus 变更审查状态标签
func agentReportChangeStatus(s string) string {
	switch s {
	case "pending":
		return "待审查"
	case "kept":
		return "已保留"
	case "reverted":
		return "已撤销"
	}
	return s
}

// agentReportRow 表格行辅助（cell 统一转义）
func agentReportRow(cells ...string) string {
	for i, c := range cells {
		cells[i] = mdTableEscape(c)
	}
	return "| " + strings.Join(cells, " | ") + " |"
}

// agentReportMarkdown 报告 Markdown 渲染归口（纯函数，可单测）。
// resultText 为完结答复全文（调用方从消息表取，缺失回退库内截断版由调用方决定）；
// tokens 为 [提问/回答/合计]（合计 0 视为无数据显示 —）；steps/changes 可为空。
func agentReportMarkdown(rec *model.AgentTaskRecord, resultText string, tokens [3]int,
	steps []model.AgentStepRecord, changes []model.AgentChangeRecord) string {

	var b strings.Builder
	b.WriteString("# Agent 任务报告\n\n")

	// 任务信息表：零值时间显示 —（旧记录 UpdateTime 可能为准）
	source := "手动发起"
	if rec.Source == "cron" {
		source = "定时任务"
	}
	fmtTime := func(t time.Time) string {
		if t.IsZero() {
			return "—"
		}
		return t.Format("2006-01-02 15:04:05")
	}
	tokenCell := "—"
	if tokens[2] > 0 {
		tokenCell = fmt.Sprintf("提问 %d / 回答 %d / 合计 %d", tokens[0], tokens[1], tokens[2])
	}
	b.WriteString("| 项目 | 内容 |\n|---|---|\n")
	b.WriteString(agentReportRow("任务 ID", rec.TaskID) + "\n")
	b.WriteString(agentReportRow("状态", agentReportStateLabel(rec.Status)) + "\n")
	b.WriteString(agentReportRow("智能体", rec.AgentName) + "\n")
	b.WriteString(agentReportRow("发起来源", source) + "\n")
	b.WriteString(agentReportRow("发起时间", fmtTime(rec.CreateTime)) + "\n")
	b.WriteString(agentReportRow("完结时间", fmtTime(rec.UpdateTime)) + "\n")
	b.WriteString(agentReportRow("耗时", agentReportDuration(rec.ElapsedMs)) + "\n")
	b.WriteString(agentReportRow("执行步数", fmt.Sprintf("%d", rec.Steps)) + "\n")
	pointsCell := "—"
	if rec.PointsCost > 0 {
		pointsCell = fmt.Sprintf("%g", rec.PointsCost)
	}
	b.WriteString(agentReportRow("积分消耗", pointsCell) + "\n")
	b.WriteString(agentReportRow("Token 消耗", tokenCell) + "\n")

	// 任务目标（原文直出，保持 Markdown 可读性）
	b.WriteString("\n## 任务目标\n\n")
	if strings.TrimSpace(rec.Goal) != "" {
		b.WriteString(rec.Goal + "\n")
	} else {
		b.WriteString("（无）\n")
	}

	// 执行结果 / 失败原因 / 取消说明：按状态三选一（queued/running 无结果段）
	switch rec.Status {
	case "completed":
		b.WriteString("\n## 执行结果\n\n")
		if strings.TrimSpace(resultText) != "" {
			b.WriteString(resultText + "\n")
		} else {
			b.WriteString("（无结果记录）\n")
		}
	case "failed":
		b.WriteString("\n## 失败原因\n\n")
		if strings.TrimSpace(rec.Error) != "" {
			b.WriteString(rec.Error + "\n")
		} else {
			b.WriteString("（未记录）\n")
		}
	case "cancelled":
		b.WriteString("\n## 取消说明\n\n")
		if strings.TrimSpace(rec.Error) != "" {
			b.WriteString(rec.Error + "\n")
		} else {
			b.WriteString("任务已取消\n")
		}
	}

	// 文件变更清单（无变更省略整段）
	if len(changes) > 0 {
		b.WriteString(fmt.Sprintf("\n## 文件变更（%d 项）\n\n", len(changes)))
		b.WriteString("| 文件 | 类型 | 状态 | 行数变更 | 说明 |\n|---|---|---|---|---|\n")
		for _, c := range changes {
			lines := "—"
			if c.Adds > 0 || c.Dels > 0 {
				lines = fmt.Sprintf("+%d / -%d", c.Adds, c.Dels)
			}
			expl := c.Explanation
			if strings.TrimSpace(expl) == "" {
				expl = "—"
			}
			b.WriteString(agentReportRow(c.Path, agentReportKindLabel(c.Kind), agentReportChangeStatus(c.Status), lines, expl) + "\n")
		}
	}

	// 执行轨迹（逐条小节 + 参数/结果围栏摘要；无工具调用时说明一句）
	if len(steps) > 0 {
		b.WriteString(fmt.Sprintf("\n## 执行轨迹（%d 步）\n", len(steps)))
		for _, st := range steps {
			state := "成功"
			if !st.OK {
				state = "失败"
			}
			b.WriteString(fmt.Sprintf("\n### 第 %d 步 · %s（%s）\n\n", st.Seq, st.Tool, state))
			b.WriteString("- 环境：" + st.Env + " · 审批：" + st.Approval + " · 用时：" + agentReportDuration(st.DurationMS) + "\n")
			b.WriteString("- 参数：\n\n" + mdFence(st.Params) + "\n")
			if strings.TrimSpace(st.Result) != "" {
				b.WriteString("- 结果：\n\n" + mdFence(st.Result) + "\n")
			}
		}
	} else {
		b.WriteString("\n## 执行轨迹\n\n无工具调用。\n")
	}

	return b.String()
}

// HandleAgentTaskReport 用户端任务报告导出（GET，归属校验：仅本人任务可导出）。
// 完结答复全文从消息表按 reply_msg_id 锚点取（completed 时落库的最终答复原样全文），
// 查不到（旧数据/失败任务）回退库内 result 列（截断 2000 版）。
func (s *Server) HandleAgentTaskReport(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	taskID := strings.TrimSpace(r.PathValue("task_id"))
	var rec model.AgentTaskRecord
	if err := store.DB.Where("task_id = ? AND username = ?", taskID, username).First(&rec).Error; err != nil {
		adminFail(w, http.StatusNotFound, "任务不存在")
		return
	}

	// 完结答复全文（reply 消息 Content）+ Token 消耗随答复落库一并取
	resultText := rec.Result
	var tokens [3]int
	if rec.ReplyMsgID > 0 {
		var reply model.Message
		if err := store.DB.Select("content", "prompt_tokens", "completion_tokens", "total_tokens").
			Where("id = ?", rec.ReplyMsgID).First(&reply).Error; err == nil && reply.Content != "" {
			resultText = reply.Content
			tokens = [3]int{reply.PromptTokens, reply.CompletionTokens, reply.TotalTokens}
		}
	}

	var steps []model.AgentStepRecord
	store.DB.Where("task_id = ?", taskID).Order("seq ASC").Find(&steps)
	var changes []model.AgentChangeRecord
	store.DB.Where("task_id = ?", taskID).Order("id ASC").Find(&changes)

	body := agentReportMarkdown(&rec, resultText, tokens, steps, changes)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// filename ASCII 兜底 + filename* RFC 5987 中文原名（各浏览器下载框任一可辨识）
	w.Header().Set("Content-Disposition",
		`attachment; filename="agent-report-`+taskID+`.md"; filename*=UTF-8''`+url.PathEscape("Agent任务报告-"+taskID+".md"))
	w.Write([]byte(body))
}
