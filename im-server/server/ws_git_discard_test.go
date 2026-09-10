package server

// 阶段八十一：源代码管理「放弃变更」场景级测试（staged 删除 pathspec 修复验证）
// 覆盖：staged 删除降级恢复（用户报错场景）/ staged 放弃（checkout HEAD --）/
// 未暂存删除回归（checkout --）/ staged 修改恢复 / staged 新增引导文案

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitDiscardRepo 在测试用户工作区的项目子目录准备 git 仓库（初始提交含 Developer.md），返回仓库路径
func gitDiscardRepo(t *testing.T, u, proj string) string {
	t.Helper()
	ws, err := agentWorkspaceDir(u)
	if err != nil {
		t.Fatalf("工作区目录创建失败: %v", err)
	}
	p := filepath.Join(ws, proj)
	_ = os.RemoveAll(p)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = p
		c.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失败: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(p, "Developer.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return p
}

// wsGitDiscardCall 调 wsServerGit 执行 discard 请求并解包结果
func wsGitDiscardCall(t *testing.T, u, proj string, staged bool, paths ...string) map[string]interface{} {
	t.Helper()
	b, _ := json.Marshal(map[string]interface{}{"sub": "discard", "proj": proj, "paths": paths, "staged": staged})
	res := wsServerGit(u, string(b))
	if res == nil {
		t.Fatal("wsServerGit 返回 nil")
	}
	m := map[string]interface{}{}
	if res.OK {
		_ = json.Unmarshal([]byte(res.Content), &m)
	} else {
		m["error"] = res.Error
	}
	return m
}

func gitDiscardStatus(t *testing.T, p string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", p, "status", "--porcelain=v1").CombinedOutput()
	if err != nil {
		t.Fatalf("git status 失败: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func gitDiscardFileExists(t *testing.T, p, name string, want bool) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(p, name)); (err == nil) != want {
		t.Fatalf("文件 %s 存在性不符（期望 %v）", name, want)
	}
}

// F：工作区根（非仓库）status 防护——GIT_CEILING_DIRECTORIES 阻断向上搜索，
// 不得窜到宿主目录仓库（如 E:\SourceCodeIM 主仓库）显示无关变更；应返回 repo:false
func TestWsGitStatusCeilingGuard(t *testing.T) {
	u := "gitdiscardtest"
	// 不带 proj：base=用户工作区根（无 .git），无防护时会向上找到宿主仓库
	b, _ := json.Marshal(map[string]interface{}{"sub": "status"})
	res := wsServerGit(u, string(b))
	if res == nil || !res.OK {
		t.Fatalf("status 请求失败: %+v", res)
	}
	var m struct {
		Repo bool `json:"repo"`
	}
	_ = json.Unmarshal([]byte(res.Content), &m)
	if m.Repo {
		t.Fatalf("工作区根 status 应 repo:false（ceiling 阻断向上搜索），实际识别为仓库: %s", res.Content)
	}
}

// G：branches 列表归一——本地+远端跟踪分支纳入审查目标，裸 remote 容器（refs/remotes/origin）剔除
func TestWsGitBranchesNormalize(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_g"
	ws, _ := agentWorkspaceDir(u)
	rem := filepath.Join(ws, "repo_g_remote.git")
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	defer os.RemoveAll(rem)
	_ = os.RemoveAll(rem)
	run := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = p
		c.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失败: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "--bare", rem)
	run("remote", "add", "origin", rem)
	run("push", "-q", "origin", "HEAD") // push 后 fetch 前：refs/remotes/origin 为裸容器条目
	b, _ := json.Marshal(map[string]interface{}{"sub": "branches", "proj": proj})
	res := wsServerGit(u, string(b))
	if res == nil || !res.OK {
		t.Fatalf("branches 请求失败: %+v", res)
	}
	var m struct {
		List []string `json:"list"`
	}
	_ = json.Unmarshal([]byte(res.Content), &m)
	joined := strings.Join(m.List, ",")
	// push 会同步更新本地远端跟踪引用：origin/master 应在列；裸 remote 容器（refs/remotes/origin）
	// 同时存在却绝不能出现在归一结果中——这是本次修复的核心断言
	if hasElem(m.List, "origin") {
		t.Fatalf("裸 remote 容器未剔除: %q", m.List)
	}
	if !hasElem(m.List, "master") {
		t.Fatalf("本地分支缺失: %q", m.List)
	}
	run("fetch", "-q", "origin") // fetch 重建跟踪引用，结果应稳定
	res = wsServerGit(u, string(b))
	_ = json.Unmarshal([]byte(res.Content), &m)
	if !hasElem(m.List, "origin/master") {
		t.Fatalf("远端跟踪分支未纳入: %q", m.List)
	}
	if hasElem(m.List, "origin") || contains(joined, "refs/") {
		t.Fatalf("归一结果异常: %q", m.List)
	}
}

func hasElem(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// A：staged 删除走默认 checkout --（index 无文件必报 pathspec）→ 服务端自动降级 HEAD 恢复（用户报错场景）
func TestWsGitDiscardStagedDeletionFallback(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_a"
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	_ = os.Remove(filepath.Join(p, "Developer.md"))
	_ = exec.Command("git", "-C", p, "add", "Developer.md").Run() // 暂存删除 → D_
	m := wsGitDiscardCall(t, u, proj, false, "Developer.md")
	if m["error"] != nil {
		t.Fatalf("降级恢复失败: %v", m["error"])
	}
	gitDiscardFileExists(t, p, "Developer.md", true)
	if s := gitDiscardStatus(t, p); s != "" {
		t.Fatalf("恢复后工作区应干净，实际: %q", s)
	}
}

// B：staged 删除带 staged 标记（前端暂存区新按钮路径）→ checkout HEAD -- 直接恢复
func TestWsGitDiscardStagedFlag(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_b"
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	_ = os.Remove(filepath.Join(p, "Developer.md"))
	_ = exec.Command("git", "-C", p, "add", "Developer.md").Run()
	m := wsGitDiscardCall(t, u, proj, true, "Developer.md")
	if m["error"] != nil {
		t.Fatalf("staged 放弃失败: %v", m["error"])
	}
	gitDiscardFileExists(t, p, "Developer.md", true)
	if s := gitDiscardStatus(t, p); s != "" {
		t.Fatalf("恢复后工作区应干净，实际: %q", s)
	}
}

// C：未暂存删除（_D）回归 → checkout -- 原路径恢复（不得触发降级也必须成功）
func TestWsGitDiscardWorktreeDeletion(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_c"
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	_ = os.Remove(filepath.Join(p, "Developer.md")) // 不暂存 → _D
	m := wsGitDiscardCall(t, u, proj, false, "Developer.md")
	if m["error"] != nil {
		t.Fatalf("未暂存删除放弃失败: %v", m["error"])
	}
	gitDiscardFileExists(t, p, "Developer.md", true)
	if s := gitDiscardStatus(t, p); s != "" {
		t.Fatalf("恢复后工作区应干净，实际: %q", s)
	}
}

// D：staged 修改（M_）带 staged 标记 → 恢复为 HEAD 内容
func TestWsGitDiscardStagedModify(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_d"
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	if err := os.WriteFile(filepath.Join(p, "Developer.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = exec.Command("git", "-C", p, "add", "Developer.md").Run()
	m := wsGitDiscardCall(t, u, proj, true, "Developer.md")
	if m["error"] != nil {
		t.Fatalf("staged 修改放弃失败: %v", m["error"])
	}
	b, err := os.ReadFile(filepath.Join(p, "Developer.md"))
	// Windows 下 git autocrlf 恢复文件时 LF→CRLF，规范化行尾后比较内容
	if err != nil || strings.ReplaceAll(string(b), "\r\n", "\n") != "hello\n" {
		t.Fatalf("内容未恢复到 HEAD（err=%v content=%q）", err, string(b))
	}
	if s := gitDiscardStatus(t, p); s != "" {
		t.Fatalf("恢复后工作区应干净，实际: %q", s)
	}
}

// E：staged 新增（A_）带 staged 标记 → HEAD 无此文件必失败，报错须含「取消暂存」引导
func TestWsGitDiscardStagedNewFileHint(t *testing.T) {
	u, proj := "gitdiscardtest", "repo_e"
	p := gitDiscardRepo(t, u, proj)
	defer os.RemoveAll(p)
	if err := os.WriteFile(filepath.Join(p, "newfile.md"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = exec.Command("git", "-C", p, "add", "newfile.md").Run()
	m := wsGitDiscardCall(t, u, proj, true, "newfile.md")
	if m["error"] == nil {
		t.Fatal("staged 新增放弃应失败（HEAD 无此文件），但返回成功")
	}
	if !strings.Contains(m["error"].(string), "取消暂存") {
		t.Fatalf("报错缺少引导文案: %q", m["error"])
	}
	gitDiscardFileExists(t, p, "newfile.md", true) // 不做自动删文件的危险动作
}
