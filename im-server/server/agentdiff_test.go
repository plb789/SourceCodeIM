package server

import (
	"strings"
	"testing"
)

// 阶段一百八十一：行级 LCS diff 单测（纯函数；agentChangeDiff 集成链路靠浏览器实测验证）

// TestAgentLineDiffBasic 基础场景：新增/删除/修改混合，前缀与顺序正确
func TestAgentLineDiffBasic(t *testing.T) {
	oldS := "a\nb\nc\nd"
	newS := "a\nX\nc\nd\ne"
	got := agentLineDiff(oldS, newS)
	want := []string{" a", "-b", "+X", " c", " d", "+e"}
	if len(got) != len(want) {
		t.Fatalf("行数不符：got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 行不符：got %q want %q（全序列 %v）", i, got[i], want[i], got)
		}
	}
}

// TestAgentLineDiffCreateDelete create（旧空全增）/ delete（新空全删）语义
func TestAgentLineDiffCreateDelete(t *testing.T) {
	if got := agentLineDiff("", "l1\nl2"); len(got) != 2 || got[0] != "+l1" || got[1] != "+l2" {
		t.Fatalf("create 应全为新增行：%v", got)
	}
	if got := agentLineDiff("l1\nl2", ""); len(got) != 2 || got[0] != "-l1" || got[1] != "-l2" {
		t.Fatalf("delete 应全为删除行：%v", got)
	}
}

// TestAgentLineDiffCRLF CRLF 归一：行内容相同不产生伪差异
func TestAgentLineDiffCRLF(t *testing.T) {
	if got := agentLineDiff("a\r\nb\r\n", "a\nb\n"); len(got) != 2 || got[0] != " a" || got[1] != " b" {
		t.Fatalf("CRLF 应归一为 LF 无伪差异：%v", got)
	}
}

// TestAgentLineDiffOversize 单侧超 agentDiffSideMaxLines 行降级返回 nil
func TestAgentLineDiffOversize(t *testing.T) {
	big := strings.Repeat("x\n", agentDiffSideMaxLines+1)
	if got := agentLineDiff(big, "a"); got != nil {
		t.Fatalf("超限应返回 nil：%d 行", len(got))
	}
}

// TestAgentLineDiffOutCap 输出行数截断（双侧不相交各 1500 行 → 3000 行输出，上限 2000 + 截断提示尾行）
func TestAgentLineDiffOutCap(t *testing.T) {
	var ob, nb strings.Builder
	for i := 0; i < agentDiffSideMaxLines; i++ {
		ob.WriteString("old")
		ob.WriteByte('\n')
		nb.WriteString("new")
		nb.WriteByte('\n')
	}
	got := agentLineDiff(ob.String(), nb.String())
	if len(got) != agentDiffOutMaxLines+1 {
		t.Fatalf("截断后应恰为 %d 行+1 提示：%d", agentDiffOutMaxLines, len(got))
	}
	if got[agentDiffOutMaxLines] != "…（差异过大，已截断）" {
		t.Fatalf("尾行应为截断提示：%q", got[agentDiffOutMaxLines])
	}
}

// TestAgentDiffClip 单行 500 字符截断
func TestAgentDiffClip(t *testing.T) {
	if got := agentDiffClip(strings.Repeat("字", 600)); len([]rune(got)) != agentDiffLineMaxRunes+1 {
		t.Fatalf("超长行应截断为 %d 字符+省略号：%d", agentDiffLineMaxRunes, len([]rune(got)))
	}
	if got := agentDiffClip("短行"); got != "短行" {
		t.Fatalf("短行不应截断：%q", got)
	}
}
