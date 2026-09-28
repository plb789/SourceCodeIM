package server

// 阶段一百八十三：工作区文件上传测试（纯 HTTP 层，不依赖数据库/网络）。
// 覆盖：根目录/子目录落盘、同名覆盖、路径逃逸拒绝、非法文件名拒绝、未在线 401、
// 同名目录冲突 400、超限 413（含残片清理）、PC 本地模式转发 64 帧（≤2MB）/超限 413/执行器关回退服务端。

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"im-server/config"
	"im-server/protocol"
)

// wsUploadPost 构造上传请求并执行，返回响应记录器
func wsUploadPost(s *Server, dir, name string, body []byte) *httptest.ResponseRecorder {
	q := url.Values{}
	q.Set("username", "upuser")
	if dir != "" {
		q.Set("dir", dir)
	}
	q.Set("name", name)
	req := httptest.NewRequest("POST", "/api/agent/ws/upload?"+q.Encode(), bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.HandleAgentWsUpload(w, req)
	return w
}

// wsUploadPCReply 从假 PC 连接的发送队列等取 msg 64 帧，回 65 成功帧（模拟执行器回传）
func wsUploadPCReply(t *testing.T, pc *Client) {
	t.Helper()
	var frame []byte
	for i := 0; i < 100; i++ { // 最多等 2s：POST goroutine 转发 64 帧有调度时延，不能 select-default 立即断言
		select {
		case frame = <-pc.sendCh:
		case <-time.After(20 * time.Millisecond):
			continue
		}
		break
	}
	if frame == nil {
		t.Fatalf("2s 内未收到 64 转发帧（PC 模式应先转发再落盘）")
	}
	var msg protocol.Message
	if err := json.Unmarshal(frame, &msg); err != nil {
		t.Fatalf("64 帧解析失败：%v", err)
	}
	if msg.MsgType != protocol.MsgTypePcFileReq {
		t.Fatalf("应为 64 帧实际 %d", msg.MsgType)
	}
	var req struct {
		Op    string `json:"op"`
		ReqID string `json:"req_id"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &req)
	if req.Op != "upload" || req.ReqID == "" {
		t.Fatalf("64 帧内容异常：%s", msg.Content)
	}
	resp, _ := json.Marshal(map[string]interface{}{
		"op": "upload", "req_id": req.ReqID, "ok": true,
	})
	pc2 := &Client{username: "upuser", server: pc.server, sendCh: make(chan []byte, 4)}
	pc.server.handlePcFileResp(pc2, &protocol.Message{MsgType: protocol.MsgTypePcFileResp, Content: string(resp)})
}

func TestHandleAgentWsUpload(t *testing.T) {
	s := NewServer(config.Load())
	agentWorkRoot = t.TempDir() // 隔离工作区
	prevExec := agentPcExec.Load()
	agentPcExec.Store(false) // 默认服务端模式（关执行器）
	defer agentPcExec.Store(prevExec)

	// 假在线连接（非 PC 端，不走真 WS）
	webC := &Client{username: "upuser", server: s, platform: "web", sendCh: make(chan []byte, 16)}
	s.hub.Add(webC)
	defer s.hub.Remove(webC)
	ws, err := agentWorkspaceDir("upuser")
	if err != nil {
		t.Fatalf("工作区创建失败：%v", err)
	}

	// 1) 根目录上传：落盘 + 响应 JSON（overwritten=false）
	w := wsUploadPost(s, "", "hello.txt", []byte("hello upload"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"overwritten":false`) {
		t.Fatalf("根目录上传失败：code=%d body=%s", w.Code, w.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(ws, "hello.txt")); err != nil || string(data) != "hello upload" {
		t.Fatalf("根目录文件内容不符：%q err=%v", data, err)
	}

	// 2) 子目录上传：父目录自动创建
	w = wsUploadPost(s, "sub/dir", "note.md", []byte("# note"))
	if w.Code != 200 {
		t.Fatalf("子目录上传失败：code=%d body=%s", w.Code, w.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(ws, "sub", "dir", "note.md")); err != nil || string(data) != "# note" {
		t.Fatalf("子目录文件内容不符：%q err=%v", data, err)
	}

	// 3) 同名覆盖：overwritten=true 且内容替换
	w = wsUploadPost(s, "", "hello.txt", []byte("v2 content"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"overwritten":true`) {
		t.Fatalf("同名覆盖标记缺失：code=%d body=%s", w.Code, w.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(ws, "hello.txt")); err != nil || string(data) != "v2 content" {
		t.Fatalf("覆盖后内容不符：%q err=%v", data, err)
	}

	// 4) 路径逃逸拒绝（dir 含 ..）
	w = wsUploadPost(s, "../evil", "x.txt", []byte("evil"))
	if w.Code != 400 {
		t.Fatalf("逃逸目录应 400：%d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ws), "evil", "x.txt")); err == nil {
		t.Fatalf("逃逸文件不应存在")
	}

	// 5) 非法文件名拒绝（.. / 控制字符 / 空名）
	for name := range map[string]bool{"..": true, "a<b>.txt": true, "  ": true} {
		if w = wsUploadPost(s, "", name, []byte("x")); w.Code != 400 {
			t.Fatalf("非法文件名 %q 应 400：%d", name, w.Code)
		}
	}

	// 6) 未在线用户 401（ghostuser 未加入 hub）
	req := httptest.NewRequest("POST", "/api/agent/ws/upload?username=ghostuser&name=x.txt", bytes.NewReader([]byte("x")))
	w2 := httptest.NewRecorder()
	s.HandleAgentWsUpload(w2, req)
	if w2.Code != 401 {
		t.Fatalf("未在线应 401：%d", w2.Code)
	}

	// 7) 同名目录冲突：先建目录再传同名文件
	if err := os.MkdirAll(filepath.Join(ws, "conflict"), 0o755); err != nil {
		t.Fatalf("建冲突目录失败：%v", err)
	}
	w = wsUploadPost(s, "", "conflict", []byte("x"))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "同名目录") {
		t.Fatalf("同名目录冲突应 400：code=%d body=%s", w.Code, w.Body.String())
	}

	// 8) 超限 413（s.cfg.MaxFileSize 调小到 1KB）+ 残片清理
	s.cfg.MaxFileSize = 1024
	big := bytes.Repeat([]byte("z"), 4096)
	w = wsUploadPost(s, "", "big.bin", big)
	if w.Code != 413 {
		t.Fatalf("超限应 413：%d body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(ws, "big.bin")); err == nil {
		t.Fatalf("超限残片应被清理")
	}
	s.cfg.MaxFileSize = 20 << 20

	// 9) PC 本地模式（执行器开+PC 在线）：≤2MB 走 64 转发，65 回传后 200
	agentPcExec.Store(true)
	pc := &Client{username: "upuser", server: s, platform: "pc", sendCh: make(chan []byte, 16)}
	s.hub.Add(pc)
	defer s.hub.Remove(pc)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- wsUploadPost(s, "", "pc.txt", []byte("pc content"))
	}()
	wsUploadPCReply(t, pc)
	w = <-done
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"mode":"pc"`) {
		t.Fatalf("PC 模式上传失败：code=%d body=%s", w.Code, w.Body.String())
	}
	// PC 模式不应落服务端工作区（执行器写的是 PC 本地盘）
	if _, err := os.Stat(filepath.Join(ws, "pc.txt")); err == nil {
		t.Fatalf("PC 模式不应写服务端工作区")
	}

	// 10) PC 本地模式超限：>2MB 直接 413（不经 64 转发）
	w = wsUploadPost(s, "", "toobig.bin", bytes.Repeat([]byte("y"), 2<<20+64))
	if w.Code != 413 {
		t.Fatalf("PC 模式超限应 413：%d body=%s", w.Code, w.Body.String())
	}
	select {
	case f := <-pc.sendCh:
		t.Fatalf("超限不应转发 64 帧：%s", string(f))
	default:
	}

	// 11) 执行器关闭回退服务端：PC 在线但 agentPcExec=false 仍直落服务端工作区
	agentPcExec.Store(false)
	w = wsUploadPost(s, "", "fallback.txt", []byte("fallback"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"mode":"server"`) {
		t.Fatalf("执行器关应回退服务端：code=%d body=%s", w.Code, w.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(ws, "fallback.txt")); err != nil || string(data) != "fallback" {
		t.Fatalf("回退落盘内容不符：%q err=%v", data, err)
	}
}
