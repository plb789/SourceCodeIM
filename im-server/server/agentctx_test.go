package server

// 阶段一百七十：@ 上下文引用链路测试（纯函数级，不依赖数据库/网络）。
// 覆盖：agentTaskContextsLoad（空集直通/数量上限/路径逃逸拒绝/不存在/目录标记/小文件内联/
// 大文件与二进制只给路径/总量钳制截断）、agentContextBlock（区块格式拼装）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"im-server/config"
)

// ctxTestWrite 工作区内写测试文件（内容重复填充到指定字节数）
func ctxTestWrite(t *testing.T, ws, rel, content string, size int) {
	t.Helper()
	full := filepath.Join(ws, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	if size > 0 {
		for len(content) < size {
			content += content
		}
		content = content[:size]
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
}

func TestAgentTaskContextsLoad(t *testing.T) {
	s := NewServer(config.Load())
	agentWorkRoot = t.TempDir() // 隔离工作区（agentWorkspaceDir 按此根拼 username 子目录）
	ws, err := agentWorkspaceDir("ctxuser1")
	if err != nil {
		t.Fatalf("工作区创建失败：%v", err)
	}
	ctxTestWrite(t, ws, "small.txt", "hello @ctx", 0)
	ctxTestWrite(t, ws, "big.log", strings.Repeat("x", agentCtxInlineMax+1), 0) // 超单文件上限 1 字节
	ctxTestWrite(t, ws, "bin.dat", "AB\x00CD", 0)                               // 二进制（含 NUL）
	ctxTestWrite(t, ws, "sub/note.md", "# note", 0)

	// 1) 空集直通（无引用任务零开销）
	out, err := s.agentTaskContextsLoad("ctxuser1", nil)
	if err != nil || out != nil {
		t.Fatalf("空集应直通：out=%v err=%v", out, err)
	}

	// 2) 数量上限：9 项 > agentCtxMaxCount(8)
	many := make([]AgentCtxReq, agentCtxMaxCount+1)
	for i := range many {
		many[i] = AgentCtxReq{Path: "small.txt"}
	}
	if _, err := s.agentTaskContextsLoad("ctxuser1", many); err == nil || !strings.Contains(err.Error(), "最多") {
		t.Fatalf("超限应报数量错误：err=%v", err)
	}

	// 3) 路径安全：逃逸/绝对路径/空路径拒绝
	for name, bad := range map[string]string{
		"上级逃逸": "../outside.txt",
		"绝对路径": "C:\\Windows\\system32\\cmd.exe",
		"空路径":   "  ",
	} {
		if _, err := s.agentTaskContextsLoad("ctxuser1", []AgentCtxReq{{Path: bad}}); err == nil {
			t.Fatalf("%s 应被拒绝：%q", name, bad)
		}
	}

	// 4) 不存在路径
	if _, err := s.agentTaskContextsLoad("ctxuser1", []AgentCtxReq{{Path: "missing.txt"}}); err == nil {
		t.Fatalf("缺失引用应报错")
	}

	// 5) 混合装载：小文件内联 / 目录标记 / 大文件与二进制只给路径
	out, err = s.agentTaskContextsLoad("ctxuser1", []AgentCtxReq{
		{Path: "small.txt"},
		{Path: "sub", Dir: true},
		{Path: "big.log"},
		{Path: "bin.dat"},
		{Path: `sub\note.md`}, // 反斜杠路径规整为斜杠
	})
	if err != nil {
		t.Fatalf("混合装载失败：%v", err)
	}
	if len(out) != 5 {
		t.Fatalf("装载条数不符：%d", len(out))
	}
	if out[0].Inline != "hello @ctx" || out[0].Dir || out[0].Size != 0 {
		t.Fatalf("小文件应内联且无目录标记：%+v", out[0])
	}
	if !out[1].Dir || out[1].Inline != "" {
		t.Fatalf("目录应仅记路径：%+v", out[1])
	}
	if out[2].Inline != "" || out[2].Size != int64(agentCtxInlineMax+1) {
		t.Fatalf("超限文件应只给路径与大小：%+v", out[2])
	}
	if out[3].Inline != "" || out[3].Size != 5 {
		t.Fatalf("二进制文件不应内联：%+v", out[3])
	}
	if out[4].Path != "sub/note.md" || out[4].Inline != "# note" {
		t.Fatalf("反斜杠路径应规整：%+v", out[4])
	}

	// 6) 总量钳制：5 个 7KB 文件 = 35KB > 32KB，第 5 个被截断到剩余额度并标注
	for i := 0; i < 5; i++ {
		ctxTestWrite(t, ws, "bulk"+string(rune('a'+i))+".txt", strings.Repeat("y", 7<<10), 0)
	}
	reqs := make([]AgentCtxReq, 0, 5)
	for i := 0; i < 5; i++ {
		reqs = append(reqs, AgentCtxReq{Path: "bulk" + string(rune('a'+i)) + ".txt"})
	}
	out, err = s.agentTaskContextsLoad("ctxuser1", reqs)
	if err != nil {
		t.Fatalf("总量钳制装载失败：%v", err)
	}
	sum := 0
	for i, c := range out {
		if c.Inline == "" {
			t.Fatalf("7KB 文件 %d 应内联：%+v", i, c)
		}
		sum += len([]rune(c.Inline))
	}
	if sum > agentCtxInlineTotal {
		t.Fatalf("内联总量超上限：sum=%d", sum)
	}
	if !strings.Contains(out[4].Inline, "已截断") {
		t.Fatalf("最后一个文件应被截断标注：%q", out[4].Inline[len(out[4].Inline)-60:])
	}
}

func TestAgentContextBlock(t *testing.T) {
	// 空集返回空串（goal 不加前缀）
	if got := agentContextBlock(nil); got != "" {
		t.Fatalf("空集应返回空串：%q", got)
	}
	block := agentContextBlock([]AgentTaskContext{
		{Path: "src", Dir: true},
		{Path: "main.go", Inline: "package main"},
		{Path: "big.log", Size: 2048},
	})
	if !strings.HasPrefix(block, "【引用上下文】") {
		t.Fatalf("区块头部缺失：%q", block)
	}
	if !strings.Contains(block, "[目录] src（用 list_dir 查看内容）") {
		t.Fatalf("目录行格式不符：%q", block)
	}
	if !strings.Contains(block, "[文件] main.go 内容如下：\npackage main") {
		t.Fatalf("内联文件行格式不符：%q", block)
	}
	if !strings.Contains(block, "[文件] big.log（2048 字节，内容未内联，请用 read_file 按需读取）") {
		t.Fatalf("大文件行格式不符：%q", block)
	}
}
