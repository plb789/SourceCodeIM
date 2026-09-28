package server

// 阶段一百八十六：智能调试循环——报错结构化解析 + 自动定位回喂 + 同错熔断
// （TRAE CN 自主调试同款强化：现状工具失败结果已照常回传模型自纠，但纯文本报错缺乏
// 结构化定位，模型常需额外 read_file 轮次试探出错代码；本模块在失败结果回喂前——
//  1. agentErrParse 解析「文件:行号」（Go/gcc/Node 通用格式 + Python traceback，去重取前 3 处）；
//  2. 服务端执行（env=server）且文件在任务工作区内时，读报错行 ±5 行作为「定位快照」一并回喂，
//     模型零额外轮次直接看到出错代码（PC 本地执行文件在用户磁盘，服务端读不到，仅给位置列表）；
//  3. 错误指纹（去行号/地址波动后哈希）同任务内连续 ≥3 次 → 附加「建议换一种思路」软提示，
//     打破重复同错死循环（步数上限仍兜底，不中断任务）。
// 纯函数 + 安全读归口（agentSafePath），单测仿 agentcron_test.go 惯例无需 DB。）
//
// 阶段一百八十七追加两项闭环能力：
//  4. 专项调试模式（agentDebugModeUpdate/agentDebugActive）——run_command 失败即进入调试模式，
//     主循环每轮模型调用前注入调试纪律消息强制「定位→最小修复→重跑同命令验证」循环，
//     同一 run_command 成功即解除（不再依赖模型自觉）；其它工具成败不影响状态；
//  5. 构建/测试感知（agentBuildProbe/agentBuildHint）——任务启动扫描工作区根识别构建/测试体系
//     （go.mod/package.json/Makefile/Cargo.toml/pom.xml/Python 标志），注入系统提示引导模型
//     修改代码后主动运行对应构建/测试命令验证。

import (
	"fmt"
	"hash/fnv"
	"im-server/logger"
	"os"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// agentDebugBreakerN 同类报错连续出现该次数即触发换思路提示（软提示不中断任务）
const agentDebugBreakerN = 3

// agentDebugSnapLines 定位快照回喂的行窗口半径（报错行 ± N 行）
const agentDebugSnapLines = 5

// AgentErrLoc 报错位置（自失败工具结果解析出的文件与行号）
type AgentErrLoc struct {
	File string
	Line int
}

var (
	// 通用「file.ext:line[:col]」——覆盖 Go（main.go:10:5: undefined）、gcc（main.c:10:5）、
	// Node 栈帧（at fn (app.js:42:13)）等主流编译器/运行时报错；扩展名限纯字母防误吞
	// 版本号（v1.2.3）与 IP:端口（127.0.0.1:8080）；容忍盘符前缀与反斜杠路径
	agentErrLocRe = regexp.MustCompile(`((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z]{1,6}):(\d{1,6})(?::\d{1,6})?`)
	// Python traceback 专用「File "x.py", line 12」（无冒号行号，通用式覆盖不到）
	agentErrPyRe = regexp.MustCompile(`File "([^"\r\n]+)", line (\d{1,6})`)
	// 指纹降噪：行号/列号波动（:10:5）与内存地址（0xc000010）不影响"同类报错"判定
	agentErrFpLineRe = regexp.MustCompile(`:\d+`)
	agentErrFpAddrRe = regexp.MustCompile(`0x[0-9a-fA-F]+`)
)

// agentErrParse 从失败工具结果文本解析报错位置（文件:行号），按出现顺序去重，最多 3 处。
// URL（https://…）中的伪位置与无字母扩展名的伪路径已排除；无位置返回 nil
func agentErrParse(result string) []AgentErrLoc {
	if result == "" {
		return nil
	}
	locs := make([]AgentErrLoc, 0, 4)
	seen := make(map[string]bool, 4)
	add := func(file string, line int) {
		file = strings.TrimSpace(file)
		if file == "" || line <= 0 {
			return
		}
		key := file + ":" + strconv.Itoa(line)
		if seen[key] || strings.Contains(file, "://") { // 去重；URL 内伪位置跳过
			return
		}
		seen[key] = true
		locs = append(locs, AgentErrLoc{File: file, Line: line})
	}
	for _, m := range agentErrLocRe.FindAllStringSubmatchIndex(result, -1) {
		// 捕获组可能自 URL 主机段起吞进本体（前缀为 ://），该匹配整体跳过
		if m[2] >= 3 && result[m[2]-3:m[2]] == "://" {
			continue
		}
		line, _ := strconv.Atoi(result[m[4]:m[5]])
		add(result[m[2]:m[3]], line)
		if len(locs) >= 3 {
			return locs
		}
	}
	for _, m := range agentErrPyRe.FindAllStringSubmatch(result, -1) {
		line, _ := strconv.Atoi(m[2])
		add(m[1], line)
		if len(locs) >= 3 {
			break
		}
	}
	if len(locs) == 0 {
		return nil
	}
	return locs
}

// agentErrSnapshotLoc 服务端执行时读取报错行 ±agentDebugSnapLines 行的定位快照。
// 文件必须位于任务工作区内（agentSafePath 安全归口防越界读取），超 1MB / 二进制（NUL）/ 行号
// 超界返回空（仅列位置不给快照）；非 UTF-8 按 GBK 兜底转码（与 read_file/run_command 同语义）
func agentErrSnapshotLoc(username, file string, line int) string {
	full, err := agentSafePath(username, file)
	if err != nil {
		return ""
	}
	st, err := os.Stat(full)
	if err != nil || !st.Mode().IsRegular() || st.Size() > 1<<20 {
		return ""
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	text := string(data)
	if strings.ContainsRune(text, 0) { // NUL 判二进制
		return ""
	}
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if line > len(lines) {
		return ""
	}
	lo, hi := line-agentDebugSnapLines, line+agentDebugSnapLines
	if lo < 1 {
		lo = 1
	}
	if hi > len(lines) {
		hi = len(lines)
	}
	var b strings.Builder
	for i := lo; i <= hi; i++ {
		runes := []rune(lines[i-1])
		if len(runes) > 200 {
			runes = append(runes[:200], '…')
		}
		mark := " "
		if i == line {
			mark = ">"
		}
		fmt.Fprintf(&b, "%s %5d | %s\n", mark, i, string(runes))
	}
	return strings.TrimRight(b.String(), "\n")
}

// agentErrFingerprint 错误指纹：错误文本去行号/列号波动（:10:5）与内存地址（0xc…）后压白哈希——
// 同根因报错（行号随编辑漂移）聚合为同类，供熔断连续计数
func agentErrFingerprint(result string) string {
	s := agentErrFpAddrRe.ReplaceAllString(result, "0xX")
	s = agentErrFpLineRe.ReplaceAllString(s, ":N")
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 300 {
		s = string(r[:300])
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return fmt.Sprintf("%08x", h.Sum32())
}

// agentDebugBump 失败结果同指纹计数；返回 (当前累计次数, 是否达熔断阈值)。
// 语义：同一任务内同指纹失败**累计**（不因中间成功的工具调用清零——"修一下没修好、又错、
// 又修、又错"的循环中夹杂的 todo_write 等成功调用若清零计数，熔断将永不触发，实测验证）；
// 出现不同指纹的失败时切换计数目标重新起算
func (t *AgentTask) agentDebugBump(fp string) (int, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if fp != "" && fp == t.dbgLastFP {
		t.dbgFPCount++
	} else {
		t.dbgLastFP = fp
		t.dbgFPCount = 1
	}
	return t.dbgFPCount, t.dbgFPCount >= agentDebugBreakerN
}

// agentDebugAnalyze 阶段一百八十六：工具结果调试增强分析归口（串行与并行批回喂共用，dispatch 后、
// 事件/留痕/入史前调用）。成功结果原样返回（熔断计数按任务内同指纹累计，不因成功清零，
// 详见 agentDebugBump）；失败结果（工具级「错误：」/
// 命令非零退出「命令退出码异常」）解析报错位置生成定位快照（仅 env=server——PC 本地文件
// 服务端读不到），同错累计 ≥agentDebugBreakerN 次附加换思路软提示。
// toolName 用于阶段一百八十七调试模式状态机：仅 run_command 成败驱动进出（详见 agentDebugModeUpdate）。
// 返回：enhanced=原结果+增强块（事件/留痕展示用，调试过程透明）；block=增强块本体
// （模型上下文须在 agentTruncateToolResult 截断原结果后再追加——块尾随超长编译输出
// 一并截断会被吃掉定位头部，失去增强意义）
func agentDebugAnalyze(t *AgentTask, result, env, toolName string) (enhanced, block string) {
	ok := agentResultOK(result)
	t.agentDebugModeUpdate(toolName, ok) // 阶段一百八十七：调试模式进出（仅 run_command 生效）
	if ok {
		return result, ""
	}
	n, trip := t.agentDebugBump(agentErrFingerprint(result))
	var b strings.Builder
	if locs := agentErrParse(result); len(locs) > 0 {
		b.WriteString(fmt.Sprintf("\n\n[调试增强] 检测到 %d 处报错位置：", len(locs)))
		for _, loc := range locs {
			b.WriteString("\n- " + loc.File + ":" + strconv.Itoa(loc.Line))
			if env == "server" {
				if snap := agentErrSnapshotLoc(t.Username, loc.File, loc.Line); snap != "" {
					b.WriteString(" → 附近代码：\n" + snap)
				}
			}
		}
	}
	if trip {
		b.WriteString(fmt.Sprintf("\n\n[调试增强] 同类报错已连续出现 %d 次，建议换一种思路：先定位根本原因（读相关文件/核对依赖与环境），或更换实现方案最小化验证，不要重复相同的修复动作。", n))
	}
	if b.Len() == 0 {
		return result, ""
	}
	block = b.String()
	return result + block, block
}

// agentResultOK 工具结果成败判据归口（事件推送/留痕/并行批共用）：失败结果以
// 工具级「错误：」或命令非零退出「命令退出码异常」前缀标记（与 agentDebugAnalyze
// 失败识别同源）——命令链 & echo 哨兵吞退出码后 cmd.Wait 恒成功，必须以结果
// 前缀为准，否则命令失败仍显示 ok=true
func agentResultOK(result string) bool {
	return !strings.HasPrefix(result, "错误") && !strings.HasPrefix(result, "命令退出码异常")
}

// agentDebugDirective 阶段一百八十七：调试模式纪律消息——run_command 失败进入调试模式后，
// 主循环每轮模型调用前注入（user 角色，steer 同款插话通道），强制「定位→最小修复→重跑
// 同命令验证」循环；同一 run_command 成功即解除注入。文案固定轻量，控制重复注入的上下文开销
const agentDebugDirective = "【调试模式】本任务刚才有一次命令执行失败，当前处于调试状态。每轮请按以下顺序工作：" +
	"1) 依据报错回喂中的报错位置与附近代码定位根本原因（必要时 read_file 相关文件、核对依赖与环境）；" +
	"2) 做最小化修复；" +
	"3) 重新运行触发失败的同一命令验证。" +
	"验证通过后才可继续其它工作；不要在没有定位根因的情况下重复尝试相同的修复动作。"

// agentDebugModeUpdate 阶段一百八十七：调试模式状态机（mu 保护）——仅 run_command 成败驱动：
// 失败进入（true），成功解除（false）；其它工具成败不改变状态（调试期间穿插的编辑/清单
// 操作不打断调试节奏）。进出留日志供实测核验
func (t *AgentTask) agentDebugModeUpdate(toolName string, ok bool) {
	if toolName != "run_command" {
		return
	}
	t.mu.Lock()
	was := t.dbgActive
	t.dbgActive = !ok
	t.mu.Unlock()
	if !was && !ok {
		logger.Info("Agent 任务 %s 命令执行失败，进入调试模式", t.ID)
	} else if was && ok {
		logger.Info("Agent 任务 %s 命令执行成功，退出调试模式", t.ID)
	}
}

// agentDebugActive 调试模式状态读取（mu 保护）
func (t *AgentTask) agentDebugActive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dbgActive
}

// agentBuildProbe 阶段一百八十七：构建/测试感知纯函数（单测归口）——按工作区根文件名
// 识别构建/测试体系，返回注入系统提示的感知区块；未识别返回空串
func agentBuildProbe(names []string) string {
	has := func(want string) bool {
		for _, n := range names {
			if strings.EqualFold(n, want) {
				return true
			}
		}
		return false
	}
	var items []string
	if has("go.mod") {
		items = append(items, "- Go 项目：构建 go build ./...，测试 go test ./...")
	}
	if has("package.json") {
		items = append(items, "- Node.js 项目：构建/测试以 package.json scripts 为准（如 npm run build / npm test）")
	}
	if has("Makefile") {
		items = append(items, "- Makefile 项目：可运行 make（常用目标以 Makefile 为准，如 make test）")
	}
	if has("Cargo.toml") {
		items = append(items, "- Rust 项目：构建 cargo build，测试 cargo test")
	}
	if has("pom.xml") {
		items = append(items, "- Maven 项目：构建 mvn compile，测试 mvn test")
	}
	if has("pyproject.toml") || has("pytest.ini") || has("requirements.txt") {
		items = append(items, "- Python 项目：测试 python -m pytest（以项目实际配置为准）")
	}
	if len(items) == 0 {
		return ""
	}
	return "【构建/测试感知】检测到项目构建/测试体系：\n" + strings.Join(items, "\n") +
		"\n完成代码修改后应主动运行对应构建/测试命令验证修复效果，不要只凭静态检查判断正确。"
}

// agentBuildHint 任务启动时扫描工作区根一层目录生成构建/测试感知区块（仅服务端工作区——
// PC 本地文件服务端读不到，env=pc 自然无感知；读失败/空工作区返回空串不阻断）
func agentBuildHint(wsDir string) string {
	entries, err := os.ReadDir(wsDir)
	if err != nil {
		return ""
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	block := agentBuildProbe(names)
	if block != "" {
		logger.Info("构建/测试感知：工作区 %s 检测到构建体系，已注入系统提示", wsDir)
	}
	return block
}
