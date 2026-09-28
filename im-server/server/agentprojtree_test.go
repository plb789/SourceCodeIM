package server

// 阶段一百七十七：项目结构注入单测（走服务端工作区路径——PC 执行器关闭，wsFileDispatch
// 自动回退本地目录遍历，与 PC 在线时同一分派归口）。覆盖：目录树渲染（连接符/排序）、
// 跳过依赖/构建目录、深度限制（超深只显名不展开）、当前项目根（.im_proj.json 的 cur）、
// 单目录条目省略、总行预算截断、空工作区静默、60s 缓存与失效重扫。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// agentTreeTestSetup 隔离工作区与全局开关，返回用户工作区目录（含双缓存清理防跨用例污染）
func agentTreeTestSetup(t *testing.T, user string) string {
	t.Helper()
	oldRoot := agentWorkRoot
	oldExec := agentPcExec.Load()
	t.Cleanup(func() {
		agentWorkRoot = oldRoot
		agentPcExec.Store(oldExec)
		agentTreeInvalidate(user)
		agentRulesInvalidate(user)
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

// agentTreeWrite 按 slash 相对路径写文件（自动建父目录）
func agentTreeWrite(t *testing.T, ws, rel, content string) {
	t.Helper()
	p := filepath.Join(ws, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestAgentProjTreeRender 渲染/排序/跳过目录/深度限制（根=工作区根）
func TestAgentProjTreeRender(t *testing.T) {
	ws := agentTreeTestSetup(t, "treerender1")
	agentTreeWrite(t, ws, "readme.md", "readme")
	agentTreeWrite(t, ws, "src/main.go", "package main")
	agentTreeWrite(t, ws, "src/util/helper.go", "package util")
	agentTreeWrite(t, ws, "docs/a/b/deep.txt", "超深层") // 第 4 层文件：不应出现（深度 ≤3）
	agentTreeWrite(t, ws, "node_modules/pkg/index.js", "依赖") // 跳过目录
	agentTreeWrite(t, ws, ".git/HEAD", "ref")                  // 跳过目录
	agentTreeWrite(t, ws, "dist/bundle.js", "构建产物")           // 跳过目录

	s := &Server{}
	block := s.agentProjTreeBlock("treerender1")
	if block == "" {
		t.Fatal("非空工作区应产出项目结构区块")
	}
	for _, want := range []string{
		"【项目结构】", "工作区根", "readme.md", "src/", "├── ", "└── ",
		"main.go", "util/", "helper.go", "docs/", "a/", "b/",
	} {
		if !strings.Contains(block, want) {
			t.Fatalf("区块缺少 %q\n区块内容：\n%s", want, block)
		}
	}
	for _, banned := range []string{"node_modules", "deep.txt", "bundle.js", ".git"} {
		if strings.Contains(block, banned) {
			t.Fatalf("区块不应包含 %q（跳过目录/超深条目）\n区块内容：\n%s", banned, block)
		}
	}
}

// TestAgentProjTreeCurRoot 当前项目根：cur 指向 proj1 时树根为 proj1，根层文件不出现
func TestAgentProjTreeCurRoot(t *testing.T) {
	ws := agentTreeTestSetup(t, "treecur1")
	agentTreeWrite(t, ws, "readme.md", "根层文件")
	agentTreeWrite(t, ws, "proj1/app.go", "package app")
	if err := os.WriteFile(filepath.Join(ws, ".im_proj.json"), []byte(`{"cur":"proj1","ts":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	block := s.agentProjTreeBlock("treecur1")
	if !strings.Contains(block, "当前项目 proj1") || !strings.Contains(block, "app.go") {
		t.Fatalf("应以当前项目为根渲染：\n%s", block)
	}
	if strings.Contains(block, "readme.md") {
		t.Fatalf("根层文件不应出现在项目根树中：\n%s", block)
	}
}

// TestAgentProjTreeLimits 单目录条目省略 + 总行预算截断
func TestAgentProjTreeLimits(t *testing.T) {
	ws := agentTreeTestSetup(t, "treelimit1")
	// 单目录 50 个文件 → 超 agentTreePerDirMax(40) 触发省略行
	for i := 0; i < 50; i++ {
		agentTreeWrite(t, ws, fmt.Sprintf("big/f%02d.txt", i), "x")
	}
	// 三个满目录（40 条+省略行）≈ 123 行 + 各层目录行，不足以触发总行截断；
	// 再塞一层多目录放大行数：10 个目录 × 40 条 = 400+ 行 → 超 agentTreeMaxLines(300) 截断
	for d := 0; d < 10; d++ {
		for i := 0; i < agentTreePerDirMax; i++ {
			agentTreeWrite(t, ws, fmt.Sprintf("massive/d%02d/f%02d.txt", d, i), "x")
		}
	}
	s := &Server{}
	block := s.agentProjTreeBlock("treelimit1")
	if !strings.Contains(block, "省略") {
		t.Fatalf("超单目录上限应出现省略行：\n%s", block)
	}
	if !strings.Contains(block, "…（结构已截断）") {
		t.Fatalf("超总行预算应出现截断标记：\n%s", block)
	}
	if lines := strings.Count(block, "\n"); lines > agentTreeMaxLines+3 {
		t.Fatalf("截断后总行数应收敛在预算附近，实际 %d 行", lines)
	}
}

// TestAgentProjTreeEmptyAndCache 空工作区静默；缓存 60s 复用；失效后重扫可见新文件
func TestAgentProjTreeEmptyAndCache(t *testing.T) {
	ws := agentTreeTestSetup(t, "treecache1")
	s := &Server{}
	if block := s.agentProjTreeBlock("treecache1"); block != "" {
		t.Fatalf("空工作区应静默不注入，实际 %q", block)
	}
	agentTreeWrite(t, ws, "late.txt", "后写入的文件")
	if block := s.agentProjTreeBlock("treecache1"); block != "" {
		t.Fatalf("空结果缓存期内应仍为空（不重扫），实际 %q", block)
	}
	agentTreeInvalidate("treecache1")
	block := s.agentProjTreeBlock("treecache1")
	if block == "" || !strings.Contains(block, "late.txt") {
		t.Fatalf("失效后重扫应看到新文件：\n%s", block)
	}
}
