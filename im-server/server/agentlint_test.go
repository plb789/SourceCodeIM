package server

// 阶段一百八十九：编辑后 Lint 回喂单测——纯函数（扩展名判定/JSON 校验/截断）+ 外部检查器
// 集成（gofmt/node/python 环境缺失自动 Skip）+ agentLintWrap 回喂闭环（临时工作区，
// 仿 agentcron_test.go 惯例无需 DB）

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentLintable(t *testing.T) {
	cases := map[string]bool{
		"main.go": true, "app.js": true, "app.mjs": true, "app.cjs": true,
		"main.py": true, "cfg.json": true, "a.JS": true, // 大写扩展名也应命中
		"a.txt": false, "a.md": false, "a.go Bak": false, "go": false, "": false,
		"makefile": false, "a.yaml": false,
	}
	for p, want := range cases {
		if got := agentLintable(p); got != want {
			t.Errorf("agentLintable(%q)=%v，期望 %v", p, got, want)
		}
	}
}

func TestAgentLintJSON(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		full := filepath.Join(dir, name)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return full
	}
	// 合法 JSON：通过
	if _, ok := agentLintJSON(write("ok.json", `{"a":1,"b":[2,3]}`), "ok.json"); !ok {
		t.Error("合法 JSON 应通过")
	}
	// 语法错误：不通过且报错含相对路径与行号（第 3 行坏点）
	msg, ok := agentLintJSON(write("bad.json", "{\n  \"a\": 1,\n  \"b\": \n}"), "bad.json")
	if ok {
		t.Fatal("语法错误 JSON 应不通过")
	}
	if !strings.HasPrefix(msg, "bad.json:4:") {
		t.Errorf("报错应带相对路径行号，实际：%s", msg)
	}
	// 空文件：非法 JSON（unexpected end）
	if _, ok := agentLintJSON(write("empty.json", ""), "empty.json"); ok {
		t.Error("空 JSON 文件应不通过")
	}
	// 读不到的文件：放行（不拦任务）
	if _, ok := agentLintJSON(filepath.Join(dir, "not_exist.json"), "not_exist.json"); !ok {
		t.Error("读取失败应放行")
	}
}

func TestAgentLintClip(t *testing.T) {
	if got := agentLintClip("short"); got != "short" {
		t.Errorf("短文本不应截断，实际：%q", got)
	}
	long := strings.Repeat("x", agentLintMaxOutput+100)
	got := agentLintClip(long)
	if len(got) > agentLintMaxOutput+40 { // 截断提示本身有长度，允许少量余量
		t.Errorf("超长文本应被截断，实际长度 %d", len(got))
	}
}

// TestAgentLintWrap 回喂闭环：坏 JSON 写入 → 结果改写为「错误：【Lint】」前缀
// （agentDebugAnalyze 依该前缀自动接住，此处验证改写与放行语义）
func TestAgentLintWrap(t *testing.T) {
	oldRoot := agentWorkRoot
	tDir := t.TempDir()
	agentWorkRoot = tDir
	defer func() { agentWorkRoot = oldRoot }()

	tk := &AgentTask{ID: "lint-test", Username: "lint_tester"}
	rel := "lcfg.json"
	full, err := agentSafePath(tk.Username, rel)
	if err != nil {
		t.Fatalf("工作区路径解析失败：%v", err)
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 成功结果 + 坏 JSON → 改写为错误前缀
	out := agentLintWrap(tk, rel, "已创建 "+rel+"（7 字节）")
	if !strings.HasPrefix(out, "错误：【Lint】") {
		t.Fatalf("坏文件应改写为错误前缀，实际：%s", out)
	}
	if !strings.Contains(out, rel+":1:") {
		t.Errorf("改写结果应含相对路径行号报错，实际：%s", out)
	}
	if !strings.Contains(out, "文件内容已写入") {
		t.Errorf("改写结果应说明文件已写入，实际：%s", out)
	}
	// 好文件 → 原样返回
	if err := os.WriteFile(full, []byte(`{"ok":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	pass := "已创建 " + rel
	if got := agentLintWrap(tk, rel, pass); got != pass {
		t.Errorf("好文件应原样返回，实际：%s", got)
	}
	// 原结果已是错误 → 原样返回（不二次包装）
	errOut := "错误：写入失败 x"
	if got := agentLintWrap(tk, rel, errOut); got != errOut {
		t.Errorf("错误结果应原样返回，实际：%s", got)
	}
	// 不可检扩展名 → 原样返回
	if got := agentLintWrap(tk, "a.txt", pass); got != pass {
		t.Errorf("不可检扩展名应原样返回，实际：%s", got)
	}
}

// TestAgentLintRunExternal 外部检查器集成（环境缺失自动跳过）
func TestAgentLintRunExternal(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		full := filepath.Join(dir, name)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return full
	}
	// Go：语法错不通过（报错含相对路径），语法对通过（格式差异不报——只报错误不报格式）
	if agentLintLookup("gofmt") != "" {
		msg, ok := agentLintRun(write("bad.go", "package main\n\nfunc main( {\n}\n"), "bad.go")
		if ok {
			t.Error("Go 语法错误应不通过")
		} else if !strings.Contains(msg, "bad.go") {
			t.Errorf("Go 报错应含相对路径，实际：%s", msg)
		}
		if msg2, ok := agentLintRun(write("ugly.go", "package main\nfunc main( ) {\nx:=1\n_ = x\n}\n"), "ugly.go"); !ok {
			t.Errorf("Go 格式差异（未 gofmt）不应报错（只报错误不报格式），实际：%s", msg2)
		}
	} else {
		t.Log("gofmt 不在 PATH，跳过 Go 检查器用例")
	}
	// JS：语法错不通过，语法对通过
	if agentLintLookup("node") != "" {
		msg, ok := agentLintRun(write("bad.js", "const x = ;\n"), "bad.js")
		if ok {
			t.Error("JS 语法错误应不通过")
		} else if !strings.Contains(msg, "bad.js") {
			t.Errorf("JS 报错应含相对路径，实际：%s", msg)
		}
		if _, ok := agentLintRun(write("ok.js", "const x = 1;\nconsole.log(x);\n"), "ok.js"); !ok {
			t.Error("合法 JS 应通过")
		}
	} else {
		t.Log("node 不在 PATH，跳过 JS 检查器用例")
	}
	// Python：语法错不通过且报「rel:line: msg」单行格式，语法对通过
	if agentLintLookup("python") != "" {
		msg, ok := agentLintRun(write("bad.py", "def f(:\n    pass\n"), "bad.py")
		if ok {
			t.Error("Python 语法错误应不通过")
		} else if !strings.HasPrefix(msg, "bad.py:1:") {
			t.Errorf("Python 报错应为「rel:line: msg」格式，实际：%s", msg)
		}
		if _, ok := agentLintRun(write("ok.py", "def f():\n    return 1\n"), "ok.py"); !ok {
			t.Error("合法 Python 应通过")
		}
	} else {
		t.Log("python 不在 PATH，跳过 Python 检查器用例")
	}
}
