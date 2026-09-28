package server

// 阶段一百八十九：编辑后 Lint 回喂（TRAE CN 同款「写完即检」）——write_file/edit_file 在
// 服务端工作区成功落盘后，按扩展名分发轻量静态检查（只报语法/结构错误，不报格式风格）：
//   .go           → gofmt -l（语法错误时 stderr 报 file:line:col 且退出非 0；退出 0 但
//                    stdout 列出文件名=仅格式差异，按「只报错误不报格式」原则忽略。
//                    选 -l 而非 -e：-e 会把格式化后的全部代码涌入 stdout，白占内存无意义）
//   .js/.mjs/.cjs → node --check（纯语法检查，报错首行含 file:line）
//   .py           → python + ast.parse（纯语法解析不落 __pycache__；自定义捕获 SyntaxError
//                    打印「rel:line: msg」单行报错——避免 traceback 噪音与 File "<string>"
//                    伪位置干扰 agentErrParse）
//   .json         → Go encoding/json 校验（零外部进程；SyntaxError.Offset 折算行号）
// 检查器经 exec.LookPath 探测（结果缓存），缺失则该类静默跳过（仅首次记日志）；单类超时 5 秒。
// 经 write_file/edit_file 落盘的文件必为 UTF-8（edit_file 对 GBK 文件统一转存 UTF-8），
// 故各检查器按 UTF-8 解析无误报问题。
// 检查失败时把成功结果整体改写为「错误：【Lint】<rel> 静态检查未通过（文件内容已写入）：+报错行」
// ——「错误：」前缀使 agentResultOK=false，agentDebugAnalyze（阶段一百八十六）自动解析报错位置
// 并回读 ±5 行定位快照，模型零额外轮次看到出错代码；agentDebugModeUpdate 仅认 run_command，
// lint 失败不干扰调试状态机（阶段一百八十七设计）。报错一律回显相对路径（agentSafePath
// 拒绝绝对路径，agentErrSnapshotLoc 的快照定位也按相对路径解析）。
// PC 本地执行（env=pc）时文件在用户磁盘，不经过 agentToolExec，天然不 lint。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"im-server/logger"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// agentLintTimeout 单文件单检查器超时（防异常检查器卡住任务循环）
const agentLintTimeout = 5 * time.Second

// agentLintMaxOutput 报错回喂上限（超长编译输出截断，保留头部已足够定位）
const agentLintMaxOutput = 1200

var (
	lintLookupMu sync.Mutex
	lintLookup   = map[string]string{} // 检查器名 → 可执行路径；""=已探测且缺失
	lintWarnOnce = map[string]bool{}   // 缺失警告只记一次日志
)

// agentLintLookup 检查器探测归口（缓存防反复扫 PATH）。LookPath 命中后做一次真执行验证
// （gofmt 无参 / node·python --version）——Windows 的 Microsoft Store python.exe 垫片
// 能被 LookPath 找到但 CreateProcess 报 9009，不验证会把不可用检查器误判为可用（实测踩坑）
func agentLintLookup(name string) string {
	lintLookupMu.Lock()
	defer lintLookupMu.Unlock()
	if p, ok := lintLookup[name]; ok {
		return p
	}
	p, err := exec.LookPath(name)
	if err == nil && !agentLintProbe(p, name) {
		p = ""
		err = exec.ErrNotFound
	}
	if err != nil {
		p = ""
		if !lintWarnOnce[name] {
			lintWarnOnce[name] = true
			logger.Info("Lint 检查器 %s 不可用（PATH 探测失败或无法执行），%s 文件的静态检查将跳过", name, lintExtHint(name))
		}
	}
	lintLookup[name] = p
	return p
}

// agentLintProbe 真执行验证检查器可用（3 秒超时；退出 0 视为有效）
func agentLintProbe(exe, name string) bool {
	args := []string{"--version"}
	if name == "gofmt" {
		args = nil // gofmt 无参从 stdin 读取，空 stdin 立即 EOF 正常退出
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, exe, args...).Run() == nil
}

// lintExtHint 探测日志用的扩展名提示
func lintExtHint(checker string) string {
	switch checker {
	case "gofmt":
		return ".go"
	case "node":
		return ".js/.mjs/.cjs"
	case "python":
		return ".py"
	}
	return "对应"
}

// agentLintable 扩展名是否纳入 Lint
func agentLintable(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go", ".js", ".mjs", ".cjs", ".py", ".json":
		return true
	}
	return false
}

// agentLintRun 按扩展名执行静态检查；返回 (报错文本, 通过与否)。检查器缺失/无对应检查器
// 视为通过（能力缺失不阻塞任务）；读文件失败同样放行（write 刚成功的文件不该发生）
func agentLintRun(full, rel string) (string, bool) {
	switch strings.ToLower(filepath.Ext(full)) {
	case ".go":
		if exe := agentLintLookup("gofmt"); exe != "" {
			return agentLintExec(exe, []string{"-l", full}, full, rel)
		}
	case ".js", ".mjs", ".cjs":
		if exe := agentLintLookup("node"); exe != "" {
			return agentLintExec(exe, []string{"--check", full}, full, rel)
		}
	case ".py":
		if exe := agentLintLookup("python"); exe != "" {
			// argv[1]=绝对路径供读取，argv[2]=相对路径供报错显示（ast.parse 的 filename
			// 决定 SyntaxError.filename，我们自行格式化输出，不依赖 traceback）
			code := "import ast,sys\n" +
				"try:\n" +
				"    ast.parse(open(sys.argv[1],'rb').read(), sys.argv[2])\n" +
				"    sys.exit(0)\n" +
				"except SyntaxError as e:\n" +
				"    print('%s:%s: %s' % (sys.argv[2], e.lineno or 0, e.msg))\n" +
				"    sys.exit(1)\n" +
				"except Exception as e:\n" +
				"    sys.exit(0)\n" // 解码失败等非语法问题不误报（文件已在工作区，任务可自行读查）
			return agentLintExec(exe, []string{"-c", code, full, rel}, full, rel)
		}
	case ".json":
		return agentLintJSON(full, rel)
	}
	return "", true
}

// agentLintExec 外部检查器执行归口：退出 0=通过；退出非 0=未通过（stderr/stdout 中的绝对路径
// 统一替换回相对路径）；超时按未通过处理并注明。只报错误不报格式——退出 0 恒通过
func agentLintExec(exe string, args []string, full, rel string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), agentLintTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		out := strings.TrimSpace(stderr.String())
		if out == "" {
			out = strings.TrimSpace(stdout.String())
		}
		if out == "" {
			out = fmt.Sprintf("%s: 检查器异常退出（%v）", rel, err)
		}
		out = strings.ReplaceAll(out, full, rel)
		if ctx.Err() != nil {
			out += "\n（检查超时，结果可能不完整）"
		}
		return agentLintClip(out), false
	}
	return "", true
}

// agentLintClip 报错上限截断（按行累积，防超长输出撑爆回喂）
func agentLintClip(out string) string {
	if len(out) <= agentLintMaxOutput {
		return out
	}
	lines := strings.Split(out, "\n")
	var b strings.Builder
	n := 0
	for _, l := range lines {
		if n+len(l)+1 > agentLintMaxOutput {
			b.WriteString("\n（报错过多已截断）")
			return b.String()
		}
		b.WriteString(l)
		b.WriteString("\n")
		n += len(l) + 1
	}
	return strings.TrimRight(b.String(), "\n")
}

// agentLintWrap 阶段一百八十九 Lint 接入归口（agentToolExec 的 write_file/edit_file case
// 调用）：原结果非成功（「错误：」前缀）或路径不可检时原样返回；检查通过原样返回；
// 检查失败把成功结果整体改写为「错误：【Lint】…」（文件已写入——修复用 edit_file，无需重写），
// agentDebugAnalyze 依「错误：」前缀自动接住（位置解析+定位快照+熔断计数）
func agentLintWrap(t *AgentTask, path, result string) string {
	if !agentResultOK(result) {
		return result
	}
	rel := strings.TrimSpace(path)
	if rel == "" || !agentLintable(rel) {
		return result
	}
	full, err := agentSafePath(t.Username, rel)
	if err != nil {
		return result // 非工作区路径（防御，write/edit 成功时已校验过）
	}
	msg, ok := agentLintRun(full, rel)
	if ok || msg == "" {
		return result
	}
	logger.Info("Agent 任务 %s 文件 %s Lint 未通过：%s", t.ID, rel, strings.SplitN(msg, "\n", 2)[0])
	return "错误：【Lint】" + rel + " 静态检查未通过（文件内容已写入，可用 edit_file 修复）：\n" + msg
}

// agentLintJSON JSON 结构校验（零外部进程）：语法错误按 Offset 折算行号回显
func agentLintJSON(full, rel string) (string, bool) {
	data, err := os.ReadFile(full)
	if err != nil {
		return "", true // 读不了不拦（write 刚成功不该发生）
	}
	if json.Valid(data) {
		return "", true
	}
	line := 1
	msg := "JSON 格式错误"
	if err := json.Unmarshal(data, new(interface{})); err != nil {
		msg = err.Error()
		if syn, ok := err.(*json.SyntaxError); ok {
			line = 1 + bytes.Count(data[:syn.Offset], []byte{'\n'})
		}
	}
	return agentLintClip(fmt.Sprintf("%s:%d: %s", rel, line, msg)), false
}
