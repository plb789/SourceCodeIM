package server

// 阶段七十六：Agent 工作区文件面板（Trae CN 同款——Agent 会话右侧文件树 + 高亮预览 + 手动编辑保存）
// 归口原则：文件面板与 Agent 工具同源执行环境——
//   PC 在线（本地执行器开启）：经 msg 64/65 转发到用户本地磁盘执行（与本地执行工具同一套 safePath 校验）；
//   PC 离线：回退服务端工作区（agentWorkspaceDir，按用户名隔离，agentSafePath 双保险防逃逸）。
// 相对路径 → 工作区根；绝对路径 → 仅 PC 在线时允许（落在沙箱授权目录内），服务端模式拒绝。
// 所有请求按 req_id 归属（web 上行 62 携带，下行 63 原样带回），PC 回传超时自动回退服务端。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"

	"im-server/logger"
	"im-server/protocol"
)

// 面板操作限额（防超长内容撑爆 WS 帧 / 防滥用）
const (
	wsFileReadMax    = 512 << 10        // 单次读文件上限 512KB（超出截断，编辑保存不受限但帧体过大由 WS 层兜底）
	wsFileReadB64Max = 2 << 20          // readb 二进制读上限 2MB（base64 后约 2.7MB，PC 65 上行需在 WS 读限 4MB 内；供 docx 预览等场景）
	wsFileOpTimeout  = 15 * time.Second // PC 文件操作回传等待上限（本地磁盘 IO 很快，超时视为 PC 无响应）
)

// wsFileEntry 文件树节点（一级目录条目）
type wsFileEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size,omitempty"`
}

// wsFileResult 文件操作统一结果
type wsFileResult struct {
	OK        bool          `json:"ok"`
	Error     string        `json:"error,omitempty"`
	Root      string        `json:"root,omitempty"`      // tree：工作区根展示名（PC=主工作区真实路径 / 服务端=服务器工作区）
	Entries   []wsFileEntry `json:"entries,omitempty"`   // tree：目录条目（子目录在前文件在后）
	Content   string        `json:"content,omitempty"`   // read：文本内容（二进制为空）
	Binary    bool          `json:"binary,omitempty"`    // read：二进制文件（不回传内容）
	Truncated bool          `json:"truncated,omitempty"` // read：内容超出上限被截断
}

// PC 文件操作挂起等待表（key: username|req_id → 回传通道）
var (
	wsFileMu    sync.Mutex
	wsFileWaits = make(map[string]chan *wsFileResult)
)

// wsFileSkipDirs 目录树跳过项（与执行器/服务端 list_dir 同一套噪音目录）
var wsFileSkipDirs = map[string]bool{
	".git": true, ".idea": true, ".vscode": true, "node_modules": true, "vendor": true,
	"__pycache__": true, "dist": true, "build": true, "bin": true, "obj": true, "target": true,
}

// handleWsFileReq 上行（msg 62）：web 文件面板请求归口（tree/read/save），结果经 63 回推
func (s *Server) handleWsFileReq(c *Client, msg *protocol.Message) {
	if c.username == "" {
		return
	}
	var req struct {
		Op      string `json:"op"`
		ReqID   string `json:"req_id"`
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		logger.Warn("文件面板 62 帧解析失败（用户 %s）：%s", c.username, msg.Content)
		return
	}
	reqID := strings.TrimSpace(req.ReqID)
	if reqID == "" || reqID == " " {
		return
	}
	logger.Info("文件面板请求（用户 %s op %s path %q req_id %s PC在线 %v 执行器开关 %v）",
		c.username, req.Op, req.Path, reqID, s.hub.HasPC(c.username), agentPcExec)
	// 阶段七十六修复：PC 回传等待最长 15s，绝不能同步卡在 readPump——
	// 否则本连接的 65 回传滞留 TCP 缓冲读不进来，必然"超时→回退→迟到丢弃"死循环
	// （实测全链 trace：64 下行 12ms 即达、渲染层 10ms 完成并回 65，唯独 65 上行滞后 15s）
	go func() {
		res := s.wsFileDispatch(c.username, reqID, req.Op, req.Path, req.Content)
		if !res.OK {
			logger.Warn("文件面板执行失败（用户 %s op %s）：%s", c.username, req.Op, res.Error)
		} else {
			logger.Info("文件面板执行完成（用户 %s op %s root %q 条目 %d 截断 %v 二进制 %v）",
				c.username, req.Op, res.Root, len(res.Entries), res.Truncated, res.Binary)
		}
		s.wsFileSendResp(c.username, req.Op, reqID, res)
	}()
}

// wsFileSendResp 下行 63 回推
func (s *Server) wsFileSendResp(username, op, reqID string, res *wsFileResult) {
	if res == nil {
		res = &wsFileResult{Error: "内部错误"}
	}
	data, _ := json.Marshal(map[string]interface{}{
		"op": op, "req_id": reqID, "ok": res.OK, "error": res.Error,
		"root": res.Root, "entries": res.Entries,
		"content": res.Content, "binary": res.Binary, "truncated": res.Truncated,
	})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypeWsFileResp, FromUser: "系统", ToUser: username,
		Content: string(data), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
}

// wsFileDispatch 执行环境分派：PC 在线转发本地（64/65），离线/超时回退服务端工作区。
// 绝对路径是 PC 本地概念（沙箱授权目录），服务端回退模式不支持。
func (s *Server) wsFileDispatch(username, reqID, op, path, content string) *wsFileResult {
	if isAbsishPath(path) && !(agentPcExec && s.hub.HasPC(username)) {
		return &wsFileResult{Error: "本地绝对路径仅在 PC 端在线时可用（沙箱授权目录内）"}
	}
	if agentPcExec && s.hub.HasPC(username) {
		if res := s.wsFileWaitPC(username, reqID, op, path, content); res != nil {
			return res
		}
		logger.Warn("文件面板 PC 回传超时，回退服务端工作区（用户 %s op %s）", username, op)
		if isAbsishPath(path) {
			return &wsFileResult{Error: "PC 端无响应，本地绝对路径不可用"}
		}
	}
	return wsFileServerOp(username, op, path, content)
}

// isAbsishPath 绝对路径判定（盘符/根分隔符，与 agentSafePath 口径一致）
func isAbsishPath(p string) bool {
	p = strings.TrimSpace(p)
	return filepath.IsAbs(p) || strings.Contains(p, ":") || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`)
}

// wsFileWaitPC 转发 PC 并挂起等待回传（msg 64 下发，65 回传经 handlePcFileResp 投递）；超时返回 nil
func (s *Server) wsFileWaitPC(username, reqID, op, path, content string) *wsFileResult {
	key := username + "|" + reqID
	ch := make(chan *wsFileResult, 1)
	wsFileMu.Lock()
	if _, dup := wsFileWaits[key]; dup {
		wsFileMu.Unlock()
		return &wsFileResult{Error: "请求重复发送"}
	}
	wsFileWaits[key] = ch
	wsFileMu.Unlock()
	defer func() {
		wsFileMu.Lock()
		delete(wsFileWaits, key)
		wsFileMu.Unlock()
	}()

	reqData, _ := json.Marshal(map[string]interface{}{"op": op, "req_id": reqID, "path": path, "content": content})
	out, _ := json.Marshal(protocol.Message{
		MsgType: protocol.MsgTypePcFileReq, FromUser: "系统", ToUser: username,
		Content: string(reqData), Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, out)
	logger.Info("文件面板转发 PC（用户 %s op %s req_id %s）", username, op, reqID)

	select {
	case res := <-ch:
		logger.Info("文件面板 PC 回传（用户 %s op %s req_id %s ok %v error %q root %q 条目 %d）",
			username, op, reqID, res.OK, res.Error, res.Root, len(res.Entries))
		return res
	case <-time.After(wsFileOpTimeout):
		logger.Warn("文件面板 PC 回传超时（用户 %s op %s req_id %s）", username, op, reqID)
		return nil
	}
}

// handlePcFileResp 上行（msg 65）：PC 本地文件操作结果投递（req_id 归属，迟到丢弃）
func (s *Server) handlePcFileResp(c *Client, msg *protocol.Message) {
	if c.username == "" {
		return
	}
	var req struct {
		Op      string        `json:"op"`
		ReqID   string        `json:"req_id"`
		OK      bool          `json:"ok"`
		Error   string        `json:"error"`
		Root    string        `json:"root"`
		Entries []wsFileEntry `json:"entries"`
		Content string        `json:"content"`
		Binary  bool          `json:"binary"`
		Trunc   bool          `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil || req.ReqID == "" {
		logger.Warn("文件面板 65 帧解析失败（用户 %s）：%s", c.username, msg.Content)
		return
	}
	wsFileMu.Lock()
	ch, ok := wsFileWaits[c.username+"|"+req.ReqID]
	wsFileMu.Unlock()
	if !ok {
		logger.Warn("文件面板 65 迟到回传丢弃（用户 %s req_id %s）", c.username, req.ReqID)
		return // 迟到/不匹配回传直接丢弃
	}
	ch <- &wsFileResult{
		OK: req.OK, Error: req.Error, Root: req.Root, Entries: req.Entries,
		Content: req.Content, Binary: req.Binary, Truncated: req.Trunc,
	}
}

// wsFileServerOp 服务端工作区执行（PC 离线回退）
func wsFileServerOp(username, op, path, content string) *wsFileResult {
	switch op {
	case "tree":
		return wsServerTree(username, path)
	case "read":
		return wsServerRead(username, path)
	case "readb":
		return wsServerReadB64(username, path)
	case "save":
		return wsServerSave(username, path, content)
	}
	return &wsFileResult{Error: "未知操作"}
}

// wsServerTree 列目录（相对路径解析到用户工作区，agentSafePath 防 .. 逃逸；路径为空=根目录）
func wsServerTree(username, path string) *wsFileResult {
	full, root, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	items, err := os.ReadDir(full)
	if err != nil {
		return &wsFileResult{Error: "无法读取目录：" + err.Error()}
	}
	entries := make([]wsFileEntry, 0, len(items))
	for _, it := range items {
		if it.IsDir() {
			if wsFileSkipDirs[it.Name()] {
				continue
			}
			entries = append(entries, wsFileEntry{Name: it.Name(), Dir: true})
			continue
		}
		var size int64
		if info, err := it.Info(); err == nil {
			size = info.Size()
		}
		entries = append(entries, wsFileEntry{Name: it.Name(), Size: size})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir // 子目录在前
		}
		return entries[i].Name < entries[j].Name
	})
	return &wsFileResult{OK: true, Root: root, Entries: entries}
}

// wsServerRead 读文本文件（512KB 截断；NUL 判二进制；非 UTF-8 按 GBK 兜底转码，与服务端 read_file 同语义）
func wsServerRead(username, path string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	info, err := os.Stat(full)
	if err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	if info.IsDir() {
		return &wsFileResult{Error: "目标是目录，请展开浏览"}
	}
	f, err := os.Open(full)
	if err != nil {
		return &wsFileResult{Error: "读取失败：" + err.Error()}
	}
	defer f.Close()
	buf := make([]byte, wsFileReadMax)
	n, _ := f.Read(buf)
	data := buf[:n]
	truncated := info.Size() > int64(n)
	headLen := n
	if headLen > 8000 {
		headLen = 8000
	}
	if n > 0 && bytes.IndexByte(data[:headLen], 0) >= 0 {
		return &wsFileResult{OK: true, Binary: true, Truncated: truncated}
	}
	text := string(data)
	if n > 0 && !utf8.Valid(data) {
		if dec, err := simplifiedchinese.GB18030.NewDecoder().String(text); err == nil {
			text = dec
		}
	}
	return &wsFileResult{OK: true, Content: text, Truncated: truncated}
}

// wsServerReadB64 读二进制文件转 base64（≤2MB，供 docx 等文档前端解析预览；Binary 标记二进制模式）
func wsServerReadB64(username, path string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	info, err := os.Stat(full)
	if err != nil {
		return &wsFileResult{Error: "文件不存在或无法访问"}
	}
	if info.IsDir() {
		return &wsFileResult{Error: "目标是目录，请展开浏览"}
	}
	if info.Size() > int64(wsFileReadB64Max) {
		return &wsFileResult{Error: "文档过大（超过 2MB），暂不支持预览"}
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return &wsFileResult{Error: "读取失败：" + err.Error()}
	}
	return &wsFileResult{OK: true, Binary: true, Content: base64.StdEncoding.EncodeToString(data)}
}

// wsServerSave 写文件（自动建父目录；UTF-8 落盘，与执行器 write_file 同语义）
func wsServerSave(username, path, content string) *wsFileResult {
	full, _, err := wsServerResolve(username, path)
	if err != nil {
		return &wsFileResult{Error: err.Error()}
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return &wsFileResult{Error: "创建目录失败：" + err.Error()}
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return &wsFileResult{Error: "保存失败：" + err.Error()}
	}
	return &wsFileResult{OK: true}
}

// wsServerResolve 面板路径解析：空=工作区根；否则 agentSafePath（拒绝绝对路径与 .. 逃逸）
// 返回 (盘上绝对路径, 工作区展示名, 错误)
func wsServerResolve(username, path string) (string, string, error) {
	ws, err := agentWorkspaceDir(username)
	if err != nil {
		return "", "", err
	}
	root := "服务器工作区"
	if path == "" || path == "." || path == "/" {
		return ws, root, nil
	}
	full, err := agentSafePath(username, path)
	if err != nil {
		return "", "", err
	}
	return full, root, nil
}

// min 整数较小值（Go 版本内建 min 不可用时的兜底）
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
