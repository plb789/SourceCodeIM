package server

// 阶段一百七十五：项目规则文件注入单测（走服务端工作区路径——PC 执行器关闭，wsFileDispatch
// 自动回退本地文件读取，与 PC 在线时同一分派归口）。覆盖：AGENTS.md 固定候选、.trae/rules/*.md
// 通配（仅 md、大小写不敏感）、工作区根+当前项目两层发现、单文件/总量截断、空工作区静默空块、
// 60s 缓存命中与项目切换失效。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// agentRulesTestSetup 隔离工作区与全局开关，返回用户工作区目录
func agentRulesTestSetup(t *testing.T, user string) string {
	t.Helper()
	oldRoot := agentWorkRoot
	oldExec := agentPcExec.Load()
	t.Cleanup(func() {
		agentWorkRoot = oldRoot
		agentPcExec.Store(oldExec)
		agentRulesInvalidate(user) // 清缓存防跨用例污染
	})
	agentWorkRoot = t.TempDir()
	agentPcExec.Store(false) // 关执行器：wsFileDispatch 全部落服务端工作区
	ws, err := agentWorkspaceDir(user)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	return ws
}

func TestAgentRulesDiscover(t *testing.T) {
	ws := agentRulesTestSetup(t, "rulesdisc1")
	// 工作区根层：AGENTS.md + .trae/rules 两个 md + 一个 txt（应被忽略）
	if err := os.MkdirAll(filepath.Join(ws, ".trae", "rules"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"AGENTS.md":                "根规则：所有回答使用中文",
		".trae/rules/开发规则.md":      "根规则：禁止硬编码路径",
		".trae/rules/style.MD":     "根规则：样式跟随主题", // 大写扩展名也应命中
		".trae/rules/notes.txt":    "不应被采纳的文本",
		"proj1/AGENTS.md":          "项目规则：接口一律先写单测",
		"proj1/.trae/rules/prj.md": "项目规则：禁止使用系统弹窗",
	}
	for rel, content := range files {
		p := filepath.Join(ws, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 当前项目指向 proj1（两层发现：根 + proj1）
	if err := os.WriteFile(filepath.Join(ws, ".im_proj.json"), []byte(`{"cur":"proj1","ts":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	block, srcs := s.agentRulesFilesBlock("rulesdisc1")
	if block == "" {
		t.Fatal("存在规则文件时应产出非空区块")
	}
	for _, want := range []string{"[来源: AGENTS.md]", "[来源: .trae/rules/开发规则.md]", "[来源: proj1/AGENTS.md]", "[来源: proj1/.trae/rules/prj.md]", "根规则：禁止硬编码路径", "项目规则：禁止使用系统弹窗"} {
		if !strings.Contains(block, want) {
			t.Fatalf("区块缺少 %q\n区块内容：\n%s", want, block)
		}
	}
	if strings.Contains(block, "notes.txt") || strings.Contains(block, "不应被采纳") {
		t.Fatal("txt 文件不应被注入")
	}
	if !strings.Contains(block, "样式跟随主题") {
		t.Fatal("大写 .MD 扩展名应被通配命中")
	}
	if len(srcs) != 5 {
		t.Fatalf("应发现 5 个规则文件，实际 %d：%v", len(srcs), srcs)
	}
}

func TestAgentRulesTruncate(t *testing.T) {
	ws := agentRulesTestSetup(t, "rulestrunc1")
	big := strings.Repeat("长", agentRulesFileMaxRunes+100)
	if err := os.WriteFile(filepath.Join(ws, "AGENTS.md"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	block, _ := s.agentRulesFilesBlock("rulestrunc1")
	runes := []rune(strings.Split(block, "[来源: AGENTS.md]\n")[1])
	if len(runes) != agentRulesFileMaxRunes+len([]rune("\n…（超长截断）")) { // 截断标记按字符数计（len() 是字节长度）
		t.Fatalf("单文件应截断到 %d 字符+截断标记，实际 %d", agentRulesFileMaxRunes, len(runes))
	}
	if !strings.HasSuffix(strings.TrimRight(block, "\n"), "…（超长截断）") {
		t.Fatal("截断应带标记")
	}
}

func TestAgentRulesEmpty(t *testing.T) {
	agentRulesTestSetup(t, "rulesempty1")
	s := &Server{}
	block, srcs := s.agentRulesFilesBlock("rulesempty1")
	if block != "" || len(srcs) != 0 {
		t.Fatalf("无规则文件应返回空块，实际 %q %v", block, srcs)
	}
}

func TestAgentRulesCache(t *testing.T) {
	ws := agentRulesTestSetup(t, "rulescache1")
	if err := os.WriteFile(filepath.Join(ws, "AGENTS.md"), []byte("版本一"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	block1, _ := s.agentRulesFilesBlock("rulescache1")
	if !strings.Contains(block1, "版本一") {
		t.Fatal("首次扫描应读到版本一")
	}
	// TTL 内修改文件：命中缓存仍为旧内容
	if err := os.WriteFile(filepath.Join(ws, "AGENTS.md"), []byte("版本二"), 0o644); err != nil {
		t.Fatal(err)
	}
	block2, _ := s.agentRulesFilesBlock("rulescache1")
	if !strings.Contains(block2, "版本一") || strings.Contains(block2, "版本二") {
		t.Fatal("TTL 内应命中缓存返回旧内容")
	}
	// 切换当前项目触发失效：立即读到新内容
	if err := os.WriteFile(filepath.Join(ws, ".im_proj.json"), []byte(`{"cur":"proj2","ts":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	wsProjTouch("rulescache1", "proj2")
	block3, _ := s.agentRulesFilesBlock("rulescache1")
	if !strings.Contains(block3, "版本二") {
		t.Fatal("失效后应重扫读到版本二")
	}
}
