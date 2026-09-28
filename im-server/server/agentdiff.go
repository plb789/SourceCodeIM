package server

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/text/encoding/simplifiedchinese"

	"im-server/model"
	"im-server/store"
)

// ===== 阶段一百八十一：任务变更 Diff 汇总面板 =====
// 基于阶段七十七/一百七十三变更留痕：首触备份（BackupFile，before）vs 工作区当前内容（after）
// 生成行级 LCS diff，经 66 号帧 diff 字段下发，前端弹层逐行着色（+绿/-红）。
// 仅服务端工作区行（env=server）支持；pc 行文件在用户磁盘服务端读不到，前端不下发按钮。

const (
	agentDiffSideMaxLines = 1500 // 单侧源文件行数上限（防 DP 内存过大：1500×1500 uint16 ≈ 4.5MB）
	agentDiffOutMaxLines  = 2000 // diff 输出行数上限（防前端弹层/帧体过大）
	agentDiffLineMaxRunes = 500  // 单行展示字符上限（超长截断，防极端长行撑爆弹层）
)

// agentSplitLines 文本按行切分（CRLF 归一为 LF；去掉末尾换行的伪空行；空串视为无行）。
// 与 agentLineDiffStat（统计口径，保留末尾伪行）刻意不同：diff 展示按实际内容行
func agentSplitLines(s string) []string {
	s = strings.TrimSuffix(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// agentLineDiff 行级 LCS diff：返回带前缀的行序列（' '上下文 / '-'旧文删除 / '+'新文新增）。
// 顺序输出全部行（单 hunk 全覆盖，不做 hunk 切分）；任一侧超 agentDiffSideMaxLines 行返回 nil（降级，由调用方提示）。
func agentLineDiff(oldS, newS string) []string {
	oldLines := agentSplitLines(oldS)
	newLines := agentSplitLines(newS)
	if len(oldLines) > agentDiffSideMaxLines || len(newLines) > agentDiffSideMaxLines {
		return nil
	}
	n, m := len(oldLines), len(newLines)
	// LCS 长度表（滚动构造自底向上；值 ≤ 1500，uint16 够用）
	dp := make([]uint16, (n+1)*(m+1))
	at := func(i, j int) *uint16 { return &dp[i*(m+1)+j] }
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				*at(i, j) = *at(i+1, j+1) + 1
			} else if *at(i+1, j) >= *at(i, j+1) {
				*at(i, j) = *at(i+1, j)
			} else {
				*at(i, j) = *at(i, j+1)
			}
		}
	}
	// 回溯取路径：优先删除（旧文先行），再新增
	out := make([]string, 0, n+m)
	i, j := 0, 0
	for i < n && j < m {
		if oldLines[i] == newLines[j] {
			out = append(out, " "+oldLines[i])
			i++
			j++
		} else if *at(i+1, j) >= *at(i, j+1) {
			out = append(out, "-"+oldLines[i])
			i++
		} else {
			out = append(out, "+"+newLines[j])
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, "-"+oldLines[i])
	}
	for ; j < m; j++ {
		out = append(out, "+"+newLines[j])
	}
	if len(out) > agentDiffOutMaxLines {
		out = out[:agentDiffOutMaxLines]
		out = append(out, "…（差异过大，已截断）")
	}
	return out
}

// agentDiffClip 单行展示截断（500 字符上限，超长加省略号；防极端长行撑爆弹层与帧体）
func agentDiffClip(line string) string {
	r := []rune(line)
	if len(r) <= agentDiffLineMaxRunes {
		return line
	}
	return string(r[:agentDiffLineMaxRunes]) + "…"
}

// agentDiffReadText 读文件文本（UTF-8 优先，GBK 兜底转码，与 read_file 同口径）。
// 文件不存在返回 ("", os.ErrNotExist)；二进制（含 NUL）返回可读错误
func agentDiffReadText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", os.ErrNotExist
		}
		return "", fmt.Errorf("文件读取失败")
	}
	if strings.IndexByte(string(data), 0) >= 0 {
		return "", fmt.Errorf("二进制文件暂不支持差异查看")
	}
	text := string(data)
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	return text, nil
}

// agentChangeDiff 单文件变更差异：before=首触备份（create 为空），after=工作区当前内容（delete 后已不存在为空）。
// 仅 pending 行可查（keep/revert 后备份即删，无从比对）；env=pc 行不支持。
// 返回 unified 风格文本（--- / +++ / @@ 单 hunk + 前缀行）；文件过大（单侧 >1500 行）降级返回统计提示。
func agentChangeDiff(username, taskID, path string) (string, error) {
	var row model.AgentChangeRecord
	if err := store.DB.Select("kind", "backup_file", "env", "status").
		Where("task_id = ? AND username = ? AND path = ?", taskID, username, path).
		Order("id ASC").First(&row).Error; err != nil {
		return "", fmt.Errorf("变更记录不存在或已处理（保留/撤销后无法查看差异）")
	}
	if row.Env == "pc" {
		return "", fmt.Errorf("本地（PC 端）文件差异暂不支持在线查看")
	}
	if row.Status != "pending" {
		return "", fmt.Errorf("变更已处理（保留/撤销），无法查看差异")
	}
	var before string
	if row.BackupFile != "" {
		b, err := agentDiffReadText(row.BackupFile)
		if err != nil {
			return "", fmt.Errorf("改前备份丢失，无法生成差异")
		}
		before = b
	}
	var after string
	full, err := agentSafePath(username, path)
	if err != nil {
		return "", fmt.Errorf("路径非法，无法生成差异")
	}
	after, aerr := agentDiffReadText(full)
	if aerr != nil && aerr != os.ErrNotExist {
		return "", aerr // 二进制/其他读取错误原样提示（删除语义文件不存在=空 after，正常走全删 diff）
	}
	oldLines := agentSplitLines(before)
	newLines := agentSplitLines(after)
	if len(oldLines) > agentDiffSideMaxLines || len(newLines) > agentDiffSideMaxLines {
		return fmt.Sprintf("文件过大（超过 %d 行），暂不支持在线差异查看", agentDiffSideMaxLines), nil
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "--- a/%s\n+++ b/%s\n@@ -1,%d +1,%d @@\n", path, path, len(oldLines), len(newLines))
	for _, l := range agentLineDiff(before, after) {
		sb.WriteString(agentDiffClip(l))
		sb.WriteByte('\n')
	}
	return strings.TrimRight(sb.String(), "\n"), nil
}
