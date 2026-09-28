package server

// 阶段一百八十六：智能调试循环——报错解析/指纹/定位快照/熔断纯函数单测（无需 DB 与网络）。
// 覆盖：agentErrParse（Go/gcc 通用格式/Node 栈帧/Python traceback/去重取前 3 处/IP:端口与
// URL 与版本号降噪）、agentErrFingerprint（行号漂移与内存地址归一稳定、异错异指纹）、
// agentErrSnapshotLoc（临时工作区真实文件窗口/越界路径拒绝/二进制拒绝/行号超界）、
// agentDebugBump 任务内累计计数（成功不清零、换指纹才重算）、agentDebugAnalyze
// 成功原样/失败增强/env=pc 不给快照/熔断提示；阶段一百八十七追加 agentDebugModeUpdate
// 调试模式状态机（run_command 进出/其它工具不干扰）与 agentBuildProbe 构建/测试感知。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentErrParseGoGccNode(t *testing.T) {
	// Go/gcc 通用「file:line:col: msg」
	locs := agentErrParse("命令退出码异常：exit status 1\n输出：\n.\\main.go:10:5: undefined: foo\n")
	if len(locs) != 1 || locs[0].File != ".\\main.go" || locs[0].Line != 10 {
		t.Fatalf("Go 风格解析不符：%+v", locs)
	}
	// Node 栈帧「at fn (E:\proj\src\app.js:42:13)」（含盘符与反斜杠路径）
	locs = agentErrParse("at Object.<anonymous> (E:\\proj\\src\\app.js:42:13)")
	if len(locs) != 1 || locs[0].File != "E:\\proj\\src\\app.js" || locs[0].Line != 42 {
		t.Fatalf("Node 栈帧解析不符：%+v", locs)
	}
	// 仅有行号（无列号）
	locs = agentErrParse("main.c:7: error: expected ';'")
	if len(locs) != 1 || locs[0].File != "main.c" || locs[0].Line != 7 {
		t.Fatalf("gcc 无列号解析不符：%+v", locs)
	}
}

func TestAgentErrParsePython(t *testing.T) {
	locs := agentErrParse(`Traceback (most recent call last):
  File "main.py", line 12, in <module>
ZeroDivisionError: division by zero`)
	if len(locs) != 1 || locs[0].File != "main.py" || locs[0].Line != 12 {
		t.Fatalf("Python traceback 解析不符：%+v", locs)
	}
}

func TestAgentErrParseSkipNoise(t *testing.T) {
	// IP:端口（扩展名非纯字母）不误判
	if locs := agentErrParse("listening on 127.0.0.1:8080"); locs != nil {
		t.Fatalf("IP:端口不应解析出位置：%+v", locs)
	}
	// URL 内伪位置跳过
	if locs := agentErrParse("详见 https://example.com/docs/guide.md:1"); locs != nil {
		t.Fatalf("URL 内不应解析出位置：%+v", locs)
	}
	// 版本号不误判
	if locs := agentErrParse("go version go1.21.0"); locs != nil {
		t.Fatalf("版本号不应解析出位置：%+v", locs)
	}
	if locs := agentErrParse(""); locs != nil {
		t.Fatalf("空文本应回 nil：%+v", locs)
	}
}

func TestAgentErrParseDedupCap(t *testing.T) {
	// 去重（同文件同行只留一处）+ 按出现顺序取前 3 处
	result := "a.go:1: x\na.go:1: x\nb.go:2: y\nc.go:3: z\nd.go:4: w"
	locs := agentErrParse(result)
	if len(locs) != 3 {
		t.Fatalf("应去重并截取前 3 处，got %d：%+v", len(locs), locs)
	}
	if locs[0].File != "a.go" || locs[1].File != "b.go" || locs[2].File != "c.go" {
		t.Fatalf("去重截取顺序不符：%+v", locs)
	}
}

func TestAgentErrFingerprint(t *testing.T) {
	// 行号/列号漂移不影响同类判定
	a := agentErrFingerprint("main.go:10:5: undefined: foo")
	b := agentErrFingerprint("main.go:12:5: undefined: foo")
	if a != b {
		t.Fatalf("行号漂移指纹应一致：%s vs %s", a, b)
	}
	// 内存地址归一
	if agentErrFingerprint("panic: x 0xc000010") != agentErrFingerprint("panic: x 0xdeadbeef") {
		t.Fatalf("内存地址指纹应归一")
	}
	// 空白差异归一
	if agentErrFingerprint("a:1: err\nx") != agentErrFingerprint("a:9: err   x") {
		t.Fatalf("空白差异指纹应归一")
	}
	// 不同错误不同指纹
	if agentErrFingerprint("undefined: foo") == agentErrFingerprint("declared and not used: bar") {
		t.Fatalf("不同错误指纹应不同")
	}
}

// withDbgWorkRoot 临时替换工作区根目录（用毕还原），返回用户工作区目录
func withDbgWorkRoot(t *testing.T, username string) string {
	t.Helper()
	old := agentWorkRoot
	agentWorkRoot = t.TempDir()
	t.Cleanup(func() { agentWorkRoot = old })
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		t.Fatalf("创建临时工作区失败：%v", err)
	}
	return ws
}

func TestAgentErrSnapshotLoc(t *testing.T) {
	const user = "dbgtester"
	ws := withDbgWorkRoot(t, user)
	content := "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(未定义变量)\n}\n"
	if err := os.WriteFile(filepath.Join(ws, "main.go"), []byte(content), 0o644); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
	// 报错行 ±5 行窗口 + 报错行标记
	snap := agentErrSnapshotLoc(user, "main.go", 6)
	if !strings.Contains(snap, ">") || !strings.Contains(snap, "未定义变量") {
		t.Fatalf("快照应含报错行标记与内容：%q", snap)
	}
	if !strings.Contains(snap, "package main") || strings.Contains(snap, "10 |") {
		t.Fatalf("快照窗口应覆盖 1-9 行内附近代码：%q", snap)
	}
	// 相对路径子目录
	if err := os.MkdirAll(filepath.Join(ws, "src"), 0o755); err != nil {
		t.Fatalf("建子目录失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(ws, "src", "a.js"), []byte("let x = ;\n"), 0o644); err != nil {
		t.Fatalf("写子文件失败：%v", err)
	}
	if snap := agentErrSnapshotLoc(user, filepath.ToSlash(filepath.Join("src", "a.js")), 1); !strings.Contains(snap, "let x = ;") {
		t.Fatalf("子目录相对路径快照不符：%q", snap)
	}
	// 越界路径拒绝（.. 逃逸）
	if snap := agentErrSnapshotLoc(user, "../outside.txt", 1); snap != "" {
		t.Fatalf("越界路径应拒绝：%q", snap)
	}
	// 文件不存在
	if snap := agentErrSnapshotLoc(user, "nope.go", 1); snap != "" {
		t.Fatalf("不存在文件应返回空：%q", snap)
	}
	// 行号超界
	if snap := agentErrSnapshotLoc(user, "main.go", 999); snap != "" {
		t.Fatalf("行号超界应返回空：%q", snap)
	}
	// 二进制（含 NUL）拒绝
	if err := os.WriteFile(filepath.Join(ws, "bin.dat"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatalf("写二进制失败：%v", err)
	}
	if snap := agentErrSnapshotLoc(user, "bin.dat", 1); snap != "" {
		t.Fatalf("二进制文件应返回空：%q", snap)
	}
}

func TestAgentDebugBreaker(t *testing.T) {
	task := &AgentTask{Username: "dbguser"}
	for i := 1; i <= 4; i++ {
		n, trip := task.agentDebugBump("fp1")
		if n != i {
			t.Fatalf("连续计数应 %d，got %d", i, n)
		}
		if trip != (i >= agentDebugBreakerN) {
			t.Fatalf("第 %d 次熔断判定不符（阈值 %d）", i, agentDebugBreakerN)
		}
	}
	// 换指纹重新起算
	if n, trip := task.agentDebugBump("fp2"); n != 1 || trip {
		t.Fatalf("换指纹应重新计数，got %d trip=%v", n, trip)
	}
	// 同指纹继续累计（成功不清零语义：计数只增，不同指纹才切换）
	if n, trip := task.agentDebugBump("fp2"); n != 2 || trip {
		t.Fatalf("同指纹应累计，got %d trip=%v", n, trip)
	}
}

func TestAgentDebugAnalyze(t *testing.T) {
	const user = "dbguser2"
	ws := withDbgWorkRoot(t, user)
	src := "package main\n\nvar y = 1\n"
	if err := os.WriteFile(filepath.Join(ws, "main.go"), []byte(src), 0o644); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
	task := &AgentTask{Username: user}

	// 成功结果原样返回（不增强、不清计数——失败计数任务内累计）
	okResult := "（命令执行成功，无输出）"
	if got, block := agentDebugAnalyze(task, okResult, "server", "read_file"); got != okResult || block != "" {
		t.Fatalf("成功结果不应增强")
	}

	// 失败结果（env=server）解析位置+定位快照，块本体可剥离（run_command 失败同时进入调试模式）
	failResult := "命令退出码异常：exit status 1\n输出：\nmain.go:3:1: undefined: x"
	got, block := agentDebugAnalyze(task, failResult, "server", "run_command")
	if !strings.HasPrefix(got, failResult) || !strings.HasSuffix(got, block) {
		t.Fatalf("增强结果应为原结果+尾部块")
	}
	if !strings.Contains(block, "[调试增强] 检测到 1 处报错位置") ||
		!strings.Contains(block, "- main.go:3") ||
		!strings.Contains(block, "var y = 1") {
		t.Fatalf("增强块应含位置与定位快照：%q", block)
	}
	// 块首尾剥离语义（模拟入史 TrimSuffix 流程）
	if core := strings.TrimSuffix(got, block); core != failResult {
		t.Fatalf("剥离增强块应还原原结果")
	}

	// env=pc：文件在用户磁盘服务端读不到，仅位置列表不给快照
	got2, block2 := agentDebugAnalyze(task, failResult, "pc", "run_command")
	if !strings.Contains(block2, "- main.go:3") || strings.Contains(block2, "附近代码") {
		t.Fatalf("pc 环境应仅给位置列表：%q", block2)
	}
	if got2 == failResult {
		t.Fatalf("pc 环境仍应有位置列表块")
	}

	// 同错连续 3 次触发换思路提示（无位置报错亦可；工具级错误用 read_file 不翻动调试模式）
	task2 := &AgentTask{Username: user}
	sameErr := "错误：读取失败：权限不足"
	var last string
	for i := 1; i <= agentDebugBreakerN; i++ {
		last, _ = agentDebugAnalyze(task2, sameErr, "server", "read_file")
		hasHint := strings.Contains(last, "同类报错已连续出现")
		if hasHint != (i >= agentDebugBreakerN) {
			t.Fatalf("第 %d 次不应/应含熔断提示", i)
		}
	}
	if !strings.Contains(last, "建议换一种思路") {
		t.Fatalf("熔断提示文案缺失：%q", last)
	}
	// 中途夹着成功不清零：同错第 4 次出现计数继续，直接再次熔断
	agentDebugAnalyze(task2, okResult, "server", "read_file")
	if got3, _ := agentDebugAnalyze(task2, sameErr, "server", "read_file"); !strings.Contains(got3, "同类报错已连续出现") {
		t.Fatalf("成功不清零，同错再现应立即熔断：%q", got3)
	}
	// 换一种错误（不同指纹）重新起算，不再携带熔断提示
	otherErr := "错误：写入失败：磁盘已满"
	if got4, _ := agentDebugAnalyze(task2, otherErr, "server", "read_file"); strings.Contains(got4, "同类报错已连续出现") {
		t.Fatalf("换指纹应重新起算不熔断：%q", got4)
	}
}

func TestAgentDebugModeUpdate(t *testing.T) {
	task := &AgentTask{Username: "dbgmode"}
	// 非命令工具成败均不改变状态
	task.agentDebugModeUpdate("todo_write", false)
	if task.agentDebugActive() {
		t.Fatalf("非命令工具失败不应进入调试模式")
	}
	// run_command 失败进入
	task.agentDebugModeUpdate("run_command", false)
	if !task.agentDebugActive() {
		t.Fatalf("命令失败应进入调试模式")
	}
	// 调试期间其它工具成败不打断调试节奏
	task.agentDebugModeUpdate("edit_file", true)
	task.agentDebugModeUpdate("read_file", false)
	if !task.agentDebugActive() {
		t.Fatalf("其它工具成败不应改变调试模式状态")
	}
	// run_command 成功解除
	task.agentDebugModeUpdate("run_command", true)
	if task.agentDebugActive() {
		t.Fatalf("命令成功应退出调试模式")
	}
}

func TestAgentBuildProbe(t *testing.T) {
	if got := agentBuildProbe([]string{"go.mod", "main.go"}); !strings.Contains(got, "go test ./...") || !strings.Contains(got, "构建/测试感知") {
		t.Fatalf("go.mod 应识别 Go 项目：%q", got)
	}
	if got := agentBuildProbe([]string{"package.json", "src"}); !strings.Contains(got, "npm test") {
		t.Fatalf("package.json 应识别 Node 项目：%q", got)
	}
	if got := agentBuildProbe([]string{"MAKEFILE"}); !strings.Contains(got, "make") {
		t.Fatalf("文件名识别应大小写不敏感：%q", got)
	}
	multi := agentBuildProbe([]string{"go.mod", "Makefile", "app.py"})
	if !strings.Contains(multi, "Go 项目") || !strings.Contains(multi, "Makefile 项目") {
		t.Fatalf("多体系应全部列出：%q", multi)
	}
	if got := agentBuildProbe([]string{"main.go", "README.md"}); got != "" {
		t.Fatalf("无构建体系应返回空：%q", got)
	}
	if got := agentBuildProbe(nil); got != "" {
		t.Fatalf("空列表应返回空：%q", got)
	}
}
