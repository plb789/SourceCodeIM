package server

// 阶段一百六十六：Agent 任务图片输入链路测试（纯函数级，不依赖数据库/网络）。
// 覆盖：agentTaskImagesLoad（空集直通/能力拒绝/数量上限/路径校验/真实读盘转 data URL）、
// aiChatMsgText（多模态消息压缩口径仅取 text 片段——base64 图片不进入文本估算与压缩转录）。

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"im-server/config"
)

// imgTestAgent 构造任务图片链路测试用智能体桩（supports=false 时 Provider 缺失，模拟无图能力）
func imgTestAgent(supports bool) *AIRunAgent {
	a := &AIRunAgent{Name: "imgbot"}
	if supports {
		a.Provider = &config.AIProviderConfig{Name: "t", SupportsImage: true}
		a.SupportsImage = true
	}
	return a
}

// TestAgentTaskImagesLoad 任务图片归口加载：能力/数量/路径/读盘全链路
func TestAgentTaskImagesLoad(t *testing.T) {
	s := NewServer(config.Load())
	// 临时上传目录 + 假 PNG（归口只校验扩展名与可读性，不解析图像内容）
	dir := t.TempDir()
	s.cfg.UploadDir = dir
	if err := os.WriteFile(filepath.Join(dir, "task-img.png"), []byte("PNGDATA-test-bytes"), 0644); err != nil {
		t.Fatalf("测试图片写入失败：%v", err)
	}

	// 1) 空集直通（不带图任务零开销）
	out, err := s.agentTaskImagesLoad(imgTestAgent(true), nil)
	if err != nil || out != nil {
		t.Fatalf("空集应直通：out=%v err=%v", out, err)
	}

	// 2) 能力拒绝：无 Provider / SupportsImage=false / agent=nil 均拒绝
	for name, agent := range map[string]*AIRunAgent{"nil": nil, "无Provider": imgTestAgent(false)} {
		if _, err := s.agentTaskImagesLoad(agent, []string{"/static/upload/task-img.png"}); err == nil {
			t.Fatalf("%s 智能体带图应被拒绝", name)
		}
	}

	// 3) 数量上限：5 张 > agentTaskMaxImages(4)
	many := make([]string, agentTaskMaxImages+1)
	for i := range many {
		many[i] = "/static/upload/task-img.png"
	}
	if _, err := s.agentTaskImagesLoad(imgTestAgent(true), many); err == nil || !strings.Contains(err.Error(), "最多") {
		t.Fatalf("超限应报数量错误：err=%v", err)
	}

	// 4) 路径校验：非 /static/upload/ 前缀、含目录分隔/穿越、扩展名不在白名单
	for _, bad := range []string{
		"https://example.com/a.png",  // 外部 URL 拒绝（图片必须先落服务端静态目录）
		"/static/upload/../x.png",    // 穿越
		"/static/upload/sub/a.png",   // 子目录
		"/static/upload/a.png\r.txt", // 假扩展名（\r.txt 不在白名单）
		"/static/upload/no-ext",      // 无扩展名
	} {
		if _, err := s.agentTaskImagesLoad(imgTestAgent(true), []string{bad}); err == nil {
			t.Fatalf("非法路径应被拒绝：%q", bad)
		}
	}

	// 5) 文件不存在
	if _, err := s.agentTaskImagesLoad(imgTestAgent(true), []string{"/static/upload/missing.png"}); err == nil {
		t.Fatalf("缺失文件应报错")
	}

	// 6) 合法加载：data URL 前缀 + base64 内容与磁盘字节一致
	out, err = s.agentTaskImagesLoad(imgTestAgent(true), []string{"  /static/upload/task-img.png  "})
	if err != nil {
		t.Fatalf("合法图片加载失败：%v", err)
	}
	if len(out) != 1 || !strings.HasPrefix(out[0], "data:image/png;base64,") {
		t.Fatalf("data URL 前缀不符：%v", out)
	}
	b, derr := base64.StdEncoding.DecodeString(strings.TrimPrefix(out[0], "data:image/png;base64,"))
	if derr != nil || string(b) != "PNGDATA-test-bytes" {
		t.Fatalf("base64 内容与磁盘不符：%v", derr)
	}
}

// TestAIChatMsgTextParts 多模态消息压缩口径：仅取 text 片段，image_url（base64）不进入文本
func TestAIChatMsgTextParts(t *testing.T) {
	// 纯文本消息原样透传
	if got := aiChatMsgText(aiChatMessage{Role: "user", Content: "目标文本"}); got != "目标文本" {
		t.Fatalf("纯文本透传不符：%q", got)
	}
	// 多模态消息（任务 goal 多模态化后的形态）：text + 大体积 image_url
	parts := []aiContentPart{
		{Type: "text", Text: "执行任务"},
		{Type: "image_url", ImageURL: &aiImageURLField{URL: "data:image/png;base64," + strings.Repeat("A", 100000)}},
		{Type: "text", Text: "第二段"},
	}
	got := aiChatMsgText(aiChatMessage{Role: "user", Content: parts})
	if got != "执行任务\n第二段" {
		t.Fatalf("多模态文本口径不符（不得含 base64）：%q", got)
	}
	if strings.Contains(got, "AAAA") {
		t.Fatalf("base64 图片漏入文本口径：%q", got)
	}
	// 未知类型兜底走 JSON 序列化（原口径不变）
	if got := aiChatMsgText(aiChatMessage{Role: "user", Content: map[string]string{"k": "v"}}); got != `{"k":"v"}` {
		t.Fatalf("未知类型 JSON 兜底不符：%q", got)
	}
}
