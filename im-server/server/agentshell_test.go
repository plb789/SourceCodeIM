package server

// 阶段一百七十一：持久终端会话单测——run_command 环境状态跨调用保留（cd/set 快照记账）。
// 覆盖：记账类命令判定（cd/盘符/set/链式不拦截/set 开关不拦截）、cd 记账（子目录/上级/非法路径/
// 裸 cd 显示）、set 记账（赋值/查询/删除/列表/大小写规整）、env 合并注入（覆盖/新增/删除）、
// 集成链路（agentToolRunCommand：cd 后会话目录保留，后续命令在新目录执行；set 后变量生效）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"im-server/config"
)

func TestAgentShellStateKind(t *testing.T) {
	cases := []struct {
		cmd  string
		want string
	}{
		{"cd", "cd"},
		{"cd build", "cd"},
		{"CD  build", "cd"}, // 大小写 + 多空格
		{"cd /d E:\\x", "cd"},
		{"e:", "cd"},
		{"E:", "cd"},
		{"cdx", ""},       // 非前缀
		{"cdx build", ""}, // cd 不是词边界
		{"dir", ""},
		{"set", "set"},
		{"set GOFLAGS=-mod=vendor", "set"},
		{"SET PATH=C:\\x", "set"},
		{"set GOOS", "set"},
		{"set GOOS=", "set"},
		{"setx PATH x", ""}, // setx 是独立命令（持久化注册表），不进记账
		{"set /a 1+1", ""},  // set 开关：cmd 自有语义，不进记账
		{"set /p X=prompt", ""},
		{"cd build && go build", ""}, // 链式不拦截（cmd /C 内 cd 不影响会话目录）
		{"\"cd build\"", "cd"},       // 整条包引号
	}
	for _, c := range cases {
		if got := agentShellStateKind(c.cmd); got != c.want {
			t.Errorf("agentShellStateKind(%q)=%q，期望 %q", c.cmd, got, c.want)
		}
	}
}

func TestAgentShellCdSet(t *testing.T) {
	agentWorkRoot = t.TempDir() // 隔离工作区
	user := "shelltest1"
	ws, err := agentWorkspaceDir(user)
	if err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(ws, "build", "out")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	tk := &AgentTask{ID: "shelltest" + user, Username: user}

	// 1. cd 相对路径 → 记账更新
	if out := agentShellCdSet(tk, ws, "cd build"); !strings.Contains(out, "已切换到") || !strings.Contains(out, "build") {
		t.Fatalf("cd build 结果异常：%s", out)
	}
	if got := agentShellCwd(tk); got != filepath.Join(ws, "build") {
		t.Fatalf("记账 cwd=%q，期望 %q", got, filepath.Join(ws, "build"))
	}
	// 2. cd 相对下钻（基于上一态）
	if out := agentShellCdSet(tk, ws, "cd out"); !strings.Contains(out, filepath.Join("build", "out")) {
		t.Fatalf("cd out 结果异常：%s", out)
	}
	// 3. cd .. 回上级
	agentShellCdSet(tk, ws, "cd ..")
	if got := agentShellCwd(tk); got != filepath.Join(ws, "build") {
		t.Fatalf("cd .. 记账 cwd=%q，期望 %q", got, filepath.Join(ws, "build"))
	}
	// 4. cd 不存在路径 → 错误且状态不变
	if out := agentShellCdSet(tk, ws, "cd no_such_dir"); !strings.Contains(out, "错误") {
		t.Fatalf("cd 非法路径应报错：%s", out)
	}
	if got := agentShellCwd(tk); got != filepath.Join(ws, "build") {
		t.Fatalf("失败 cd 不应改状态：%q", got)
	}
	// 5. 裸 cd 显示当前目录（不改状态）
	if out := agentShellCdSet(tk, ws, "cd"); !strings.Contains(out, "当前目录") {
		t.Fatalf("裸 cd 应显示当前目录：%s", out)
	}
	// 6. cd 绝对路径（工作区所在盘符根：环境无关的盘符切换验证；vol="C:"，切盘命令用小写单盘符）
	vol := filepath.VolumeName(ws)                                                                                      // 如 "C:"
	if out := agentShellCdSet(tk, ws, strings.ToLower(vol[:1])+":"); !strings.Contains(strings.ToUpper(out), vol+`\`) { // 切到该盘根（盘符大小写保留原命令）
		t.Fatalf("盘符切换结果异常：%s", out)
	}
	// 7. cd /d 绝对路径回工作区
	if out := agentShellCdSet(tk, ws, "cd /d "+ws); !strings.Contains(out, "已切换到") {
		t.Fatalf("cd /d 结果异常：%s", out)
	}
	if got := agentShellCwd(tk); got != ws {
		t.Fatalf("cd /d 后 cwd=%q，期望 %q", got, ws)
	}

	// ===== set 记账 =====
	if out := agentShellCdSet(tk, ws, "set"); !strings.Contains(out, "尚未") {
		t.Fatalf("空记账裸 set 结果异常：%s", out)
	}
	if out := agentShellCdSet(tk, ws, "set GOFLAGS=-mod=vendor"); !strings.Contains(out, "GOFLAGS=-mod=vendor") {
		t.Fatalf("set 赋值结果异常：%s", out)
	}
	if out := agentShellCdSet(tk, ws, "set goflags"); !strings.Contains(out, "GOFLAGS=-mod=vendor") { // 查询大小写不敏感
		t.Fatalf("set 查询结果异常：%s", out)
	}
	if out := agentShellCdSet(tk, ws, "set GOFLAGS="); !strings.Contains(out, "已删除") {
		t.Fatalf("set 删除结果异常：%s", out)
	}
	if _, ok := tk.shellEnv["GOFLAGS"]; ok {
		t.Fatal("删除后记账不应残留 GOFLAGS")
	}
	if out := agentShellCdSet(tk, ws, "set BAD NAME=x"); !strings.Contains(out, "错误") {
		t.Fatalf("非法变量名应报错：%s", out)
	}
	if out := agentShellCdSet(tk, ws, "set /a 1+1"); strings.Contains(out, "记账") {
		t.Fatalf("set /a 不应进记账（cmd 自有语义）：%s", out)
	}
}

func TestAgentShellEnvCmd(t *testing.T) {
	tk := &AgentTask{ID: "shellenvtest", Username: "shelltest2"}
	// 无记账 → nil（继承父进程）
	if env := agentShellEnvCmd(tk); env != nil {
		t.Fatalf("无记账应返回 nil，得到 %v", env)
	}
	// 覆盖已有变量（OS 必存在于 Windows 环境）
	tk.shellEnv = map[string]string{"OS": "LinuxOS", "AGENT_X": "1", "PATH": ""}
	env := agentShellEnvCmd(tk)
	var osLine, agentLine string
	pathCount := 0
	for _, kv := range env {
		switch {
		case strings.HasPrefix(kv, "OS="):
			osLine = kv
		case strings.HasPrefix(kv, "AGENT_X="):
			agentLine = kv
		case strings.HasPrefix(kv, "PATH="):
			pathCount++
		}
	}
	if osLine != "OS=LinuxOS" {
		t.Fatalf("覆盖变量异常：%q", osLine) // key 保留原大小写、值被覆盖
	}
	if agentLine != "AGENT_X=1" {
		t.Fatalf("新增变量异常：%q", agentLine)
	}
	if pathCount != 0 {
		t.Fatalf("值空=删除语义失效：PATH 应被移除（出现 %d 次）", pathCount)
	}
	seenOS := 0
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "OS=") {
			seenOS++
		}
	}
	if seenOS != 1 {
		t.Fatalf("同 key 重复条目（Windows 环境块行为未定义）：OS 出现 %d 次", seenOS)
	}
}

// TestAgentToolRunCommandShellPersist 集成：cd/set 跨调用保留 + spawn 以记账状态执行
func TestAgentToolRunCommandShellPersist(t *testing.T) {
	agentWorkRoot = t.TempDir()
	s := NewServer(config.Load())
	user := "shelltest3"
	ws, err := agentWorkspaceDir(user)
	if err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(ws, "subdir")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	tk := &AgentTask{ID: "shellpersist1", Username: user}

	// 1. cd 记账类：不 spawn，立即返回并更新会话
	out := agentToolRunCommand(s, tk, "c1", map[string]interface{}{"command": "cd subdir"})
	if !strings.Contains(out, "已切换到") {
		t.Fatalf("cd 结果异常：%s", out)
	}
	// 2. 后续 echo %CD% 在新目录执行（验证 spawn cwd=记账值 + 跨调用保留）
	out = agentToolRunCommand(s, tk, "c2", map[string]interface{}{"command": "echo %CD%"})
	if !strings.Contains(out, "subdir") {
		t.Fatalf("会话目录未保留（echo %%CD%% 应输出 subdir）：%s", out)
	}
	// 3. set 记账 → 后续命令变量生效（验证 env 注入）
	if out := agentToolRunCommand(s, tk, "c3", map[string]interface{}{"command": "set AGENT_SHELL_TEST=hello123"}); !strings.Contains(out, "AGENT_SHELL_TEST=hello123") {
		t.Fatalf("set 结果异常：%s", out)
	}
	out = agentToolRunCommand(s, tk, "c4", map[string]interface{}{"command": "echo %AGENT_SHELL_TEST%"})
	if !strings.Contains(out, "hello123") {
		t.Fatalf("set 环境变量未跨命令生效：%s", out)
	}
	// 4. 结果尾注会话目录
	if !strings.Contains(out, "[会话目录]") {
		t.Fatalf("结果缺会话目录尾注：%s", out)
	}
	// 5. set 取消 → 后续命令变量失效（cmd 对未定义变量原样输出 %VAR%）
	agentToolRunCommand(s, tk, "c5", map[string]interface{}{"command": "set AGENT_SHELL_TEST="})
	out = agentToolRunCommand(s, tk, "c6", map[string]interface{}{"command": "echo %AGENT_SHELL_TEST%"})
	if strings.Contains(out, "hello123") {
		t.Fatalf("set 取消未生效：%s", out)
	}
}
