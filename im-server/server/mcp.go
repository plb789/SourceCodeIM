package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== 阶段八十八：MCP（Model Context Protocol）客户端核心 =====
// TRAE CN 同款 MCP 能力的服务端归口实现：Go 服务端作为 MCP Host，统一管理所有
// MCP Server 连接（stdio 本地子进程 / sse / http 远程端点），发现的工具供 AI 问答
// 与智能 Agent 注入调用（阶段八十九接入 Agent Loop）。配置以 im_mcp_server 表为
// 唯一数据源（与 AI 模型服务同款 DB 归口 + 热重载模式），后台管理增删改即生效。

// MCP 传输类型（transport 字段取值）
const (
	mcpTransportStdio = "stdio" // 服务端本地子进程（npx/uvx/node/python/exe 等）
	mcpTransportSSE   = "sse"   // 远程 SSE 端点（2024-11-05 协议版）
	mcpTransportHTTP  = "http"  // 远程 Streamable HTTP 端点（新版协议，推荐）
)

// MCP 运行状态（im_mcp_server.status 字段与内存条目双写，管理页离线可见）
const (
	mcpStatusConnecting   = "connecting"
	mcpStatusConnected    = "connected"
	mcpStatusDisconnected = "disconnected"
	mcpStatusError        = "error"
)

// mcpToolInfo 工具发现缓存条目（入库 tools_cache，阶段八十九转 OpenAI function calling 定义）
type mcpToolInfo struct {
	Name        string          `json:"name"`                   // 工具原始名（服务器内唯一）
	Description string          `json:"description,omitempty"`  // 工具说明（供模型理解）
	InputSchema json.RawMessage `json:"input_schema,omitempty"` // 参数 JSON Schema（原样透传）
}

// mcpSettings 运行时设置（config.yaml mcp 节点归口，启动加载；修改需重启）
type mcpSettings struct {
	Enabled        bool
	UserEnabled    bool
	StdioWhitelist []string
	ConnectTimeout time.Duration
	ToolTimeout    time.Duration
}

var (
	mcpMu      sync.Mutex // 保护 settings 与 entries map（连接管理低频，互斥即可）
	mcpSet     = mcpSettings{Enabled: true, ConnectTimeout: 30 * time.Second, ToolTimeout: 60 * time.Second}
	mcpEntries = map[string]*mcpClientEntry{} // key: 服务器名（name 全局唯一）
)

// mcpClientEntry 单个 MCP 服务器连接条目（生命周期由独立 goroutine mcpServeLoop 管理；
// rec 为创建时的配置快照永不就地修改——配置变更经指纹对比重建新条目，规避并发修改）
type mcpClientEntry struct {
	mu        sync.Mutex
	rec       model.MCPServer    // 配置快照
	session   *mcp.ClientSession // nil=未建连
	cancel    context.CancelFunc // 会话生命周期 ctx 取消（建连挂起/已建连均可被 stop 路径打断）
	quit      chan struct{}      // 关闭即要求连接循环退出（删除/停用/总开关关闭/配置变更替换）
	quitOnce  sync.Once
	status    string
	statusMsg string
	tools     []mcpToolInfo // 最近一次工具发现结果（内存实时值）
	stderrLog []string      // stdio 子进程 stderr 环形日志（最近 16 行，排障归口，管理页可见）
}

// mcpStop 关停条目：关闭 quit 信号并取消会话 ctx（含建连挂起态），连接循环随之退出
func (e *mcpClientEntry) mcpStop() {
	e.quitOnce.Do(func() { close(e.quit) })
	e.mu.Lock()
	if e.cancel != nil {
		e.cancel()
	}
	e.mu.Unlock()
}

// mcpStopped 是否已要求退出
func (e *mcpClientEntry) mcpStopped() bool {
	select {
	case <-e.quit:
		return true
	default:
		return false
	}
}

// InitMCP 阶段八十八：MCP 客户端初始化（须在 DB 就绪后调用）
// 首次启动（表空）从 config.yaml mcp.servers 种子导入，之后数据库为唯一数据源；
// 后台管理界面增删改后调用 reloadMCPServers() 热生效（无需重启）
func InitMCP(cfg *config.Config) {
	connectTimeout := time.Duration(cfg.MCP.ConnectTimeoutSeconds) * time.Second
	if connectTimeout <= 0 {
		connectTimeout = 30 * time.Second
	}
	toolTimeout := time.Duration(cfg.MCP.ToolTimeoutSeconds) * time.Second
	if toolTimeout <= 0 {
		toolTimeout = 60 * time.Second
	}
	mcpMu.Lock()
	mcpSet = mcpSettings{
		Enabled:        cfg.MCP.Enabled,
		UserEnabled:    cfg.MCP.UserEnabled,
		StdioWhitelist: cfg.MCP.StdioWhitelist,
		ConnectTimeout: connectTimeout,
		ToolTimeout:    toolTimeout,
	}
	mcpMu.Unlock()
	if !cfg.MCP.Enabled {
		logger.Info("MCP 功能未开启（config.yaml mcp.enabled=false），连接管理器空转；后台已配置的服务器记录保留")
		return
	}
	seedMCPFromConfig(cfg)
	reloadMCPServers()
}

// seedMCPFromConfig 种子导入——仅当 im_mcp_server 表为空（全新部署）时，将 config.yaml
// 的 mcp.servers 导入数据库；之后数据库为唯一数据源，后台删除全部记录后重启不会重复导入
func seedMCPFromConfig(cfg *config.Config) {
	if len(cfg.MCP.Servers) == 0 {
		return
	}
	var count int64
	store.DB.Model(&model.MCPServer{}).Count(&count)
	if count > 0 {
		return
	}
	imported := 0
	for i, s := range cfg.MCP.Servers {
		name := strings.TrimSpace(s.Name)
		if name == "" {
			name = fmt.Sprintf("mcp-server-%d", i+1)
		}
		enabled := true
		if s.Enabled != nil {
			enabled = *s.Enabled
		}
		rec := model.MCPServer{
			Name:      name,
			Transport: mcpNormalizeTransport(s.Transport),
			Command:   strings.TrimSpace(s.Command),
			URL:       strings.TrimSpace(s.URL),
			Enabled:   enabled,
			Status:    mcpStatusDisconnected,
		}
		if b, err := json.Marshal(s.Args); err == nil {
			rec.Args = string(b)
		}
		if len(s.Env) > 0 {
			if b, err := json.Marshal(s.Env); err == nil {
				rec.Env = string(b)
			}
		}
		if len(s.Headers) > 0 {
			if b, err := json.Marshal(s.Headers); err == nil {
				rec.Headers = string(b)
			}
		}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("MCP 种子导入服务器 %s 失败: %v", name, err)
			continue
		}
		imported++
	}
	logger.Info("MCP 配置种子导入完成：%d 个服务器（源自 config.yaml，后续以后台管理配置为准）", imported)
}

// mcpNormalizeTransport 传输类型规整（未知值回退 stdio）
func mcpNormalizeTransport(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case mcpTransportSSE:
		return mcpTransportSSE
	case mcpTransportHTTP:
		return mcpTransportHTTP
	default:
		return mcpTransportStdio
	}
}

// mcpFingerprint 连接相关配置指纹（重载时对比，未变化的条目不重连——避免每次管理操作惊扰全部连接）
func mcpFingerprint(rec model.MCPServer) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%t", rec.Transport, rec.Command, rec.Args, rec.Env, rec.URL, rec.Headers, rec.Owner, rec.Enabled)
}

// reloadMCPServers 从数据库重建 MCP 连接（热重载归口）：
// 新增/配置变更的建连，删除/停用的断开，无变化的保持现有连接不惊扰
func reloadMCPServers() {
	mcpMu.Lock()
	enabled := mcpSet.Enabled
	mcpMu.Unlock()
	if !enabled {
		mcpStopAll()
		return
	}
	var recs []model.MCPServer
	if err := store.DB.Order("id ASC").Find(&recs).Error; err != nil {
		logger.Error("MCP 重载读取配置失败: %v", err)
		return
	}
	desired := make(map[string]model.MCPServer, len(recs))
	for _, r := range recs {
		if r.Enabled {
			desired[r.Name] = r
		}
	}

	mcpMu.Lock()
	// 第一步：断开——已删除/已停用/指纹变更的条目；指纹未变的原地刷新策略字段
	// （auto_approve/disabled_tools/owner 不影响连接，若只在指纹变更时重建，单改开关需断线重连，体验差）
	for name, e := range mcpEntries {
		want, ok := desired[name]
		if ok {
			e.mu.Lock()
			same := mcpFingerprint(want) == mcpFingerprint(e.rec)
			if same && (e.rec.AutoApprove != want.AutoApprove || e.rec.DisabledTools != want.DisabledTools || e.rec.Owner != want.Owner) {
				e.rec.AutoApprove = want.AutoApprove
				e.rec.DisabledTools = want.DisabledTools
				e.rec.Owner = want.Owner
			}
			e.mu.Unlock()
			if same {
				continue
			}
		}
		e.mcpStop()
		delete(mcpEntries, name)
	}
	// 第二步：启动——期望集中尚无条目的（变更条目已在第一步清理，此处按新配置重建）
	started := 0
	for name, rec := range desired {
		if _, ok := mcpEntries[name]; ok {
			continue
		}
		e := &mcpClientEntry{
			rec:    rec,
			quit:   make(chan struct{}),
			status: mcpStatusConnecting,
		}
		mcpEntries[name] = e
		go mcpServeLoop(e)
		started++
	}
	total := len(mcpEntries)
	mcpMu.Unlock()
	if started > 0 {
		logger.Info("MCP 连接重载完成：新增/重建 %d 个连接，当前启用 %d 个服务器", started, total)
	}
}

// mcpStopAll 断开全部连接（总开关关闭时归口）
func mcpStopAll() {
	mcpMu.Lock()
	for _, e := range mcpEntries {
		e.mcpStop()
	}
	mcpEntries = map[string]*mcpClientEntry{}
	mcpMu.Unlock()
}

// mcpRestartEntry 单条目强制重建（手动重连归口）：断开现有连接循环，按最新配置重新建连
func mcpRestartEntry(rec model.MCPServer) {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	if e, ok := mcpEntries[rec.Name]; ok {
		e.mcpStop()
		delete(mcpEntries, rec.Name)
	}
	if !rec.Enabled {
		return
	}
	e := &mcpClientEntry{rec: rec, quit: make(chan struct{}), status: mcpStatusConnecting}
	mcpEntries[rec.Name] = e
	go mcpServeLoop(e)
}

// mcpServeLoop 单服务器连接循环：建连 → 工具发现 → 保活等待 → 断线退避重连。
// 仅在条目被 stop（删除/停用/总开关关闭/配置变更替换）时退出；网络故障无限退避重试
func mcpServeLoop(e *mcpClientEntry) {
	e.mu.Lock()
	rec := e.rec // 配置快照（连接字段不可变；策略字段以 e.mu 下的实时值为准）
	e.mu.Unlock()
	backoff := 5 * time.Second
	for {
		if e.mcpStopped() {
			return
		}
		e.mu.Lock()
		e.status = mcpStatusConnecting
		e.statusMsg = ""
		e.mu.Unlock()
		mcpPersistStatus(rec.Name, mcpStatusConnecting, "")

		sess, err := mcpDial(e, rec)
		if e.mcpStopped() {
			if sess != nil {
				_ = sess.Close()
			}
			return
		}
		if err != nil {
			e.mu.Lock()
			e.status = mcpStatusError
			e.statusMsg = err.Error()
			e.mu.Unlock()
			mcpPersistStatus(rec.Name, mcpStatusError, err.Error())
			logger.Warn("MCP[%s] 连接失败：%v（%s 后重试）", rec.Name, err, backoff)
			if !mcpSleepQuit(e, backoff) {
				return
			}
			if backoff < time.Minute {
				backoff *= 2
			}
			continue
		}
		backoff = 5 * time.Second

		// 建连成功：登记会话、注册工具列表变更通知（TRAE 同款：服务器侧工具变化自动重新发现）
		e.mu.Lock()
		e.session = sess
		e.status = mcpStatusConnected
		e.statusMsg = ""
		e.mu.Unlock()
		mcpPersistStatus(rec.Name, mcpStatusConnected, "")
		serverLabel := rec.Transport
		if ir := sess.InitializeResult(); ir != nil && ir.ServerInfo != nil {
			serverLabel = fmt.Sprintf("%s %s（%s）", rec.Transport, ir.ServerInfo.Name, ir.ServerInfo.Version)
		}
		logger.Info("MCP[%s] 已连接：%s", rec.Name, serverLabel)

		// 工具发现异步执行（失败不影响已建连状态，仅告警；结果回写内存 + DB 缓存）
		mcpDiscoverTools(e, rec.Name, sess)

		// 保活等待：会话自然断开（子进程退出/网络断开）或被 stop 打断
		waitCh := make(chan struct{})
		go func() {
			_ = sess.Wait()
			close(waitCh)
		}()
		select {
		case <-waitCh:
		case <-e.quit:
		}
		_ = sess.Close()

		e.mu.Lock()
		e.session = nil
		if e.mcpStopped() {
			e.mu.Unlock()
			return
		}
		e.status = mcpStatusDisconnected
		e.statusMsg = "连接断开，自动重连中"
		e.mu.Unlock()
		mcpPersistStatus(rec.Name, mcpStatusDisconnected, "连接断开，自动重连中")
		logger.Warn("MCP[%s] 连接断开，%s 后自动重连", rec.Name, 3*time.Second)
		if !mcpSleepQuit(e, 3*time.Second) {
			return
		}
	}
}

// mcpSleepQuit 可中断退避等待（false=等待期间条目被停用，连接循环应退出）
func mcpSleepQuit(e *mcpClientEntry, d time.Duration) bool {
	if d > time.Minute {
		d = time.Minute
	}
	// 分片睡眠：保证 stop 信号最迟 500ms 内被感知（重载删除条目不悬挂）
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		select {
		case <-e.quit:
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
	return !e.mcpStopped()
}

// mcpDial 建立 MCP 会话（Initialize 握手成功才返回）。
// 会话生命周期与登记到 entry 的 cancel 绑定：stop 路径取消 ctx 即断连（含建连挂起态打断）；
// 握手超时由 mcpSet.ConnectTimeout 归口，超时同样取消 ctx 防子进程/连接悬挂
func mcpDial(e *mcpClientEntry, rec model.MCPServer) (*mcp.ClientSession, error) {
	transport, err := mcpBuildTransport(rec, &mcpStderrWriter{entry: e})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancel = cancel
	e.mu.Unlock()

	var (
		sess *mcp.ClientSession
		derr error
	)
	done := make(chan struct{})
	go func() {
		// cli := mcp.NewClient(&mcp.Implementation{Name: "im-server", Version: "1.0"}, nil)
		// 原实现：第二参 nil（不挂任何通知 handler）。阶段一百零九：挂载进度通知 handler，
		// 服务器发来的 notifications/progress 按 progressToken 反查转发给调用中的工具（长任务实时进度）
		cli := mcp.NewClient(&mcp.Implementation{Name: "im-server", Version: "1.0"}, &mcp.ClientOptions{
			ProgressNotificationHandler: mcpOnProgressNotification,
		})
		sess, derr = cli.Connect(ctx, transport, nil)
		close(done)
	}()
	timeout := mcpConnectTimeout()
	select {
	case <-done:
		if derr != nil {
			cancel()
			return nil, derr
		}
		return sess, nil
	case <-e.quit:
		cancel()
		return nil, errors.New("已停用")
	case <-time.After(timeout):
		cancel()
		return nil, fmt.Errorf("连接超时（%s 内未完成初始化握手）", timeout)
	}
}

// mcpBuildTransport 按传输类型构建 Transport（stderr 捕获仅 stdio 生效）
func mcpBuildTransport(rec model.MCPServer, stderr io.Writer) (mcp.Transport, error) {
	switch rec.Transport {
	case mcpTransportStdio:
		return mcpBuildStdioTransport(rec, stderr)
	case mcpTransportSSE:
		if !mcpValidURL(rec.URL) {
			return nil, errors.New("sse 传输缺少合法的 http(s) 端点地址")
		}
		hc, err := mcpHTTPClient(rec.Headers)
		if err != nil {
			return nil, err
		}
		return &mcp.SSEClientTransport{Endpoint: rec.URL, HTTPClient: hc}, nil
	case mcpTransportHTTP:
		if !mcpValidURL(rec.URL) {
			return nil, errors.New("http 传输缺少合法的 http(s) 端点地址")
		}
		hc, err := mcpHTTPClient(rec.Headers)
		if err != nil {
			return nil, err
		}
		return &mcp.StreamableClientTransport{Endpoint: rec.URL, HTTPClient: hc}, nil
	default:
		return nil, fmt.Errorf("未知传输类型 %q", rec.Transport)
	}
}

// mcpBuildStdioTransport stdio 子进程传输构建：
// 1) exec.LookPath 全路径解析（防 PATH 依赖歧义）；2) Windows 下 .cmd/.bat 脚本
// （如 npx.cmd）无法被 CreateProcess 直接执行，经 cmd /c 中转；3) 附加环境变量；
// 4) stderr 接入环形日志（MCP server 启动失败原因排障归口）
func mcpBuildStdioTransport(rec model.MCPServer, stderr io.Writer) (mcp.Transport, error) {
	command := strings.TrimSpace(rec.Command)
	if command == "" {
		return nil, errors.New("stdio 传输缺少 command")
	}
	if !mcpStdioAllowed(rec) {
		return nil, fmt.Errorf("命令 %q 未命中用户自建 stdio 白名单（config.yaml mcp.stdio_whitelist）", command)
	}
	resolved, err := exec.LookPath(command)
	if err != nil {
		return nil, fmt.Errorf("命令未找到：%s", command)
	}
	args, err := mcpParseArgs(rec.Args)
	if err != nil {
		return nil, fmt.Errorf("args 解析失败: %w", err)
	}
	env, err := mcpParseKV(rec.Env)
	if err != nil {
		return nil, fmt.Errorf("env 解析失败: %w", err)
	}
	var cmd *exec.Cmd
	switch strings.ToLower(filepath.Ext(resolved)) {
	case ".cmd", ".bat":
		cmd = exec.Command("cmd", append([]string{"/c", resolved}, args...)...)
	default:
		cmd = exec.Command(resolved, args...)
	}
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if stderr != nil {
		cmd.Stderr = stderr
	}
	return &mcp.CommandTransport{Command: cmd}, nil
}

// mcpStdioAllowed stdio 命令放行判断：管理员公共服务器（owner 空）不限——管理员本就掌控
// 服务端主机，配置面与 config.yaml 同权；用户自建服务器（owner 非空，阶段八十九开放）
// 须命中白名单（可执行名精确比对，兼容 .exe/.cmd/.bat 后缀；白名单空=全部拒绝）
func mcpStdioAllowed(rec model.MCPServer) bool {
	if rec.Owner == "" {
		return true
	}
	mcpMu.Lock()
	wl := mcpSet.StdioWhitelist
	mcpMu.Unlock()
	base := strings.ToLower(mcpExeName(rec.Command))
	for _, item := range wl {
		if strings.ToLower(mcpExeName(item)) == base {
			return true
		}
	}
	return false
}

// mcpExeName 取可执行名（去路径、去 .exe/.cmd/.bat 后缀，白名单比对归口）
func mcpExeName(s string) string {
	base := filepath.Base(strings.TrimSpace(s))
	return strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(base, ".exe"), ".cmd"), ".bat")
}

// mcpValidURL 端点地址校验（仅 http/https）
func mcpValidURL(u string) bool {
	u = strings.TrimSpace(u)
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

// mcpHTTPClient sse/http 附加请求头注入（Bearer 鉴权归口）；无头时返回 nil 用 SDK 默认客户端
func mcpHTTPClient(headersJSON string) (*http.Client, error) {
	headers, err := mcpParseKV(headersJSON)
	if err != nil {
		return nil, fmt.Errorf("headers 解析失败: %w", err)
	}
	if len(headers) == 0 {
		return nil, nil
	}
	return &http.Client{Transport: mcpHeaderTransport{base: http.DefaultTransport, headers: headers}}, nil
}

// mcpHeaderTransport 请求头注入 RoundTripper（对 POST 请求与 SSE 长连接统一生效）
type mcpHeaderTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (t mcpHeaderTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	return t.base.RoundTrip(req)
}

// mcpStderrWriter stdio 子进程 stderr 环形日志（最近 16 行；同步进服务端日志，排障归口）
type mcpStderrWriter struct {
	entry *mcpClientEntry
	buf   []byte
}

func (w *mcpStderrWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		idx := -1
		for i, b := range w.buf {
			if b == '\n' {
				idx = i
				break
			}
		}
		if idx < 0 {
			// 防超长无换行刷爆内存（单行上限 4KB）
			if len(w.buf) > 4096 {
				line := strings.TrimSpace(string(w.buf))
				w.buf = w.buf[:0]
				w.emit(line)
			}
			break
		}
		line := strings.TrimSpace(string(w.buf[:idx]))
		w.buf = w.buf[idx+1:]
		w.emit(line)
	}
	return len(p), nil
}

func (w *mcpStderrWriter) emit(line string) {
	if line == "" {
		return
	}
	name := ""
	if w.entry != nil {
		name = w.entry.rec.Name
	}
	logger.Info("MCP[%s] stderr: %s", name, line)
	if w.entry == nil {
		return
	}
	w.entry.mu.Lock()
	w.entry.stderrLog = append(w.entry.stderrLog, line)
	if len(w.entry.stderrLog) > 16 {
		w.entry.stderrLog = w.entry.stderrLog[len(w.entry.stderrLog)-16:]
	}
	w.entry.mu.Unlock()
}

// mcpListTools 分页拉取全部工具（NextCursor 追页，防大目录服务器截断）
func mcpListTools(sess *mcp.ClientSession, timeout time.Duration) ([]mcpToolInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var tools []mcpToolInfo
	params := &mcp.ListToolsParams{}
	for {
		res, err := sess.ListTools(ctx, params)
		if err != nil {
			return tools, err
		}
		for _, t := range res.Tools {
			info := mcpToolInfo{Name: t.Name, Description: t.Description}
			if t.InputSchema != nil {
				if b, err := json.Marshal(t.InputSchema); err == nil && string(b) != "null" {
					info.InputSchema = b
				}
			}
			tools = append(tools, info)
		}
		if res.NextCursor == "" {
			return tools, nil
		}
		params.Cursor = res.NextCursor
	}
}

// mcpDiscoverTools 工具发现：结果回写内存条目 + DB 缓存（管理页离线可见、重启不丢）
func mcpDiscoverTools(e *mcpClientEntry, name string, sess *mcp.ClientSession) {
	tools, err := mcpListTools(sess, mcpConnectTimeout())
	if err != nil {
		logger.Warn("MCP[%s] 工具发现失败: %v（不影响已建连状态，重连后重试）", name, err)
		return
	}
	e.mu.Lock()
	e.tools = tools
	e.mu.Unlock()
	cache, _ := json.Marshal(tools)
	if err := store.DB.Model(&model.MCPServer{}).Where("name = ?", name).Updates(map[string]interface{}{
		"tools_cache": string(cache),
		"tool_count":  len(tools),
	}).Error; err != nil {
		logger.Error("MCP[%s] 工具缓存回写失败: %v", name, err)
	}
	logger.Info("MCP[%s] 工具发现完成：%d 个工具", name, len(tools))
}

// mcpPersistStatus 状态回写 DB（低频事件驱动：connecting/connected/disconnected/error 四态迁移时）
func mcpPersistStatus(name, status, msg string) {
	msg = strings.TrimSpace(msg)
	if len(msg) > 512 {
		msg = msg[:512]
	}
	if err := store.DB.Model(&model.MCPServer{}).Where("name = ?", name).Updates(map[string]interface{}{
		"status":     status,
		"status_msg": msg,
	}).Error; err != nil {
		logger.Error("MCP[%s] 状态回写失败: %v", name, err)
	}
}

// ===== 阶段八十九接入预留：工具注入与调用核心（Agent Loop 对接面） =====

// ===== 阶段一百零八：agent 型 MCP 工具描述增强（防"AI 调用另一个 AI"递归套娃滥用） =====
// 此类工具本身是完整 Agent（内部自带独立大模型循环并会再次调用工具），本方 Agent 调用它
// 即形成递归套娃：token 双重消耗、耗时长、返回结果长易被截断进模型上下文（agentTruncateToolResult）。
// 注入层无法阻止接入，故在工具定义出模型可见的描述上追加调用须知，引导模型仅在
// 复杂多步编码/调试任务且内置工具不足以完成时才使用

// mcpAgentToolExactNames 已知 agent 型工具名全集（小写完全匹配）
var mcpAgentToolExactNames = map[string]bool{
	"agent": true, "agent_run": true, "run_agent": true, "agent_execute": true,
	"execute_agent": true, "agent_task": true, "task_agent": true, "subagent": true,
	"spawn_agent": true, "dispatch_agent": true, "ask_agent": true, "delegate_agent": true,
}

// mcpAgentToolFragments agent 型工具名匹配片段（小写子串命中即认定，
// 覆盖带前缀/后缀的变体，如 "code_agent_run"、"subagent_manager"）
var mcpAgentToolFragments = []string{"agent_run", "run_agent", "subagent", "sub_agent", "spawn_agent", "dispatch_agent", "delegate_to_agent"}

// mcpAgentToolGuidance agent 型工具注入时追加的调用须知（原描述保留在前，
// 模型仍可了解工具本身能力；须知在后约束使用场景与代价）
const mcpAgentToolGuidance = "【调用须知】该工具内部是一个完整 Agent（自带独立大模型循环并会再次调用工具），调用它等于 AI 调用另一个 AI：token 消耗大、耗时长、返回结果长（超长部分会被截断）。仅当任务为复杂多步编码/调试且内置工具（读文件/搜索/执行命令等）不足以完成时才使用；简单查询、单文件读写、常规检索一律改用内置工具，禁止用本工具替代。"

// mcpEnhanceAgentToolDesc agent 型工具描述增强归口：命中 agent 型命名时在原描述后
// 追加调用须知；未命中原样返回（服务端与用户本机 MCP 两路注入共用）
func mcpEnhanceAgentToolDesc(toolName, desc string) string {
	lower := strings.ToLower(toolName)
	if mcpAgentToolExactNames[lower] {
		return desc + mcpAgentToolGuidance
	}
	for _, frag := range mcpAgentToolFragments {
		if strings.Contains(lower, frag) {
			return desc + mcpAgentToolGuidance
		}
	}
	return desc
}

// mcpOpenAIToolDefinitions 将全部已连接且启用服务器的未禁用工具转为 OpenAI 兼容
// function calling 定义（阶段八十九由 agentToolDefinitions() 注入）。
// 命名空间化命名 mcp_<服务器名>_<工具名> 防跨服务器重名冲突（见 mcpToolKey）
func mcpOpenAIToolDefinitions() []aiToolDefinition {
	mcpMu.Lock()
	enabled := mcpSet.Enabled
	entries := make([]*mcpClientEntry, 0, len(mcpEntries))
	for _, e := range mcpEntries {
		entries = append(entries, e)
	}
	mcpMu.Unlock()
	if !enabled {
		return nil
	}
	var defs []aiToolDefinition
	for _, e := range entries {
		e.mu.Lock()
		rec, sess, tools := e.rec, e.session, e.tools
		e.mu.Unlock()
		if sess == nil || !rec.Enabled {
			continue
		}
		disabled := mcpDisabledSet(rec.DisabledTools)
		for _, t := range tools {
			if disabled[t.Name] {
				continue
			}
			// 参数 schema：缺省时给空对象 schema（部分上游要求 parameters 必须为合法 schema）
			var params interface{} = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
			if len(t.InputSchema) > 0 {
				params = json.RawMessage(t.InputSchema)
			}
			desc := t.Description
			if desc == "" {
				desc = "MCP 工具 " + t.Name + "（服务器 " + rec.Name + "）"
			}
			// 阶段一百零八：agent 型工具描述增强——命中即追加调用须知防递归套娃滥用
			desc = mcpEnhanceAgentToolDesc(t.Name, desc)
			defs = append(defs, aiToolDefinition{
				Type: "function",
				Function: map[string]interface{}{
					"name":        mcpToolKey(rec.Name, t.Name),
					"description": desc,
					"parameters":  params,
				},
			})
		}
	}
	return defs
}

// mcpToolKey 服务器+工具名 → OpenAI function 名（mcp_<服务器>_<工具>）。
// OpenAI 兼容规范要求 ^[-_a-zA-Z0-9]+$ 且 ≤64 字符：非法字符规整为下划线，
// 规整/截断后追加 fnv 前 8 位十六进制后缀，保证不同原名映射结果不冲突。
// 阶段九十：用户本机 MCP 复用此算法（agentPcToolKey = mcpToolKey("pc_"+server, tool)，
// mcp_pc_ 命名空间归用户本机工具；mcpValidateReq 已拒绝 pc_ 前缀服务器名防撞名）
func mcpToolKey(server, tool string) string {
	raw := "mcp_" + server + "_" + tool
	var b strings.Builder
	changed := false
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
			changed = true
		}
	}
	name := b.String()
	const maxLen = 55 // 64 - 8（hash 后缀） - 1（连接符）
	if !changed && len(name) <= maxLen {
		return name
	}
	if len(name) > maxLen {
		name = name[:maxLen]
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(raw))
	return name + "_" + fmt.Sprintf("%08x", h.Sum32())
}

// mcpPcOpenAIToolDefinitions 阶段九十：用户本机 MCP 工具 → OpenAI function calling 定义
// （mcp_pc_ 命名空间，仅注入该用户上报的清单；总开关 mcp.enabled 与用户自建开关
// mcp.user_enabled 双闸门，PC 端离线时由 agentPcToolsFor 归口返回空不注入）
func (s *Server) mcpPcOpenAIToolDefinitions(username string) []aiToolDefinition {
	mcpMu.Lock()
	enabled, userEnabled := mcpSet.Enabled, mcpSet.UserEnabled
	mcpMu.Unlock()
	if !enabled || !userEnabled {
		return nil
	}
	tools := s.agentPcToolsFor(username)
	if len(tools) == 0 {
		return nil
	}
	defs := make([]aiToolDefinition, 0, len(tools))
	for _, t := range tools {
		// 参数 schema：缺省时给空对象 schema（部分上游要求 parameters 必须为合法 schema）
		var params interface{} = map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
		if len(t.InputSchema) > 0 {
			params = json.RawMessage(t.InputSchema)
		}
		desc := t.Description
		if desc == "" {
			desc = "本机 MCP 工具 " + t.Tool + "（服务器 " + t.Server + "，经用户电脑本地执行）"
		}
		// 阶段一百零八：agent 型工具描述增强——用户本机接入 trae-agent 等同样会递归套娃
		desc = mcpEnhanceAgentToolDesc(t.Tool, desc)
		defs = append(defs, aiToolDefinition{
			Type: "function",
			Function: map[string]interface{}{
				"name":        agentPcToolKey(t.Server, t.Tool),
				"description": desc,
				"parameters":  params,
			},
		})
	}
	return defs
}

// mcpRouteToolKey 按注入名反查路由（模型 tool_calls 携带 key，分发归口）：
// 遍历条目计算匹配（条目与工具量级小，O(n) 足够）；false=未知 key（模型幻觉工具名）。
// 阶段九十：mcp_pc_ 命名空间归用户本机工具（agentPcRouteToolKey 归口），
// 服务端条目即使意外命中同名 key 也不路由（本机工具绝不走服务端连接执行）
func mcpRouteToolKey(key string) (serverName, toolName string, ok bool) {
	mcpMu.Lock()
	entries := make([]*mcpClientEntry, 0, len(mcpEntries))
	for _, e := range mcpEntries {
		entries = append(entries, e)
	}
	mcpMu.Unlock()
	if strings.HasPrefix(key, "mcp_pc_") {
		return "", "", false // 阶段九十：本机命名空间归 agentPcRouteToolKey 归口（防撞名误路由）
	}
	for _, e := range entries {
		e.mu.Lock()
		rec, tools := e.rec, e.tools
		e.mu.Unlock()
		for _, t := range tools {
			if mcpToolKey(rec.Name, t.Name) == key {
				return rec.Name, t.Name, true
			}
		}
	}
	return "", "", false
}

// mcpCallTool 执行 MCP 工具调用（阶段八十九 Agent 工具分发归口接入）。
// 返回拼接后的文本结果（多段 TextContent 顺序拼接，非文本内容 JSON 兜底序列化）；
// isError 结果同样以 error 返回（正文附错误文本），与内置工具错误处理同款语义。
// 阶段一百零九：改为无取消联动/无进度透传的兼容入口（测试与既有调用），实现已迁入 mcpCallToolWithProgress
func mcpCallTool(serverName, tool string, arguments map[string]interface{}) (string, error) {
	// 原实现：本函数内含全部校验与调用逻辑，已整体迁入 mcpCallToolWithProgress，此处仅保留签名转发；
	// 超时语义保持不变（context.WithTimeout + mcpToolTimeout，回归检查时补齐——迁移时曾遗漏致测试路径无超时保护）
	ctx, cancel := context.WithTimeout(context.Background(), mcpToolTimeout())
	defer cancel()
	return mcpCallToolWithProgress(ctx, serverName, tool, arguments, nil)
}

// ===== 阶段一百零九：MCP 工具进度透传与取消联动 =====

// mcpProgressReg 进度回调注册表（progressToken → 回调）：调用前注册、结束后注销；
// 通知 handler 按 token 反查转发，查不到即忽略（迟到的通知/异常场景静默丢弃）
var (
	mcpProgressMu        sync.Mutex
	mcpProgressCallbacks = map[string]func(message string, progress, total float64){}
	mcpProgressSeq       atomic.Uint64 // 进度 token 发生器（唯一性归口）
)

// mcpOnProgressNotification 客户端进度通知 handler（mcpDial 经 ClientOptions 全局挂载）：
// 按 progressToken 反查调用中的工具调用逐条转发（trae-agent 等长任务工具的中间进度实时可见）
func mcpOnProgressNotification(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
	if req == nil || req.Params == nil {
		return
	}
	token := fmt.Sprintf("%v", req.Params.ProgressToken)
	mcpProgressMu.Lock()
	cb, ok := mcpProgressCallbacks[token]
	mcpProgressMu.Unlock()
	if ok {
		cb(req.Params.Message, req.Params.Progress, req.Params.Total)
	}
}

// mcpCallToolWithProgress 带取消联动与进度透传的 MCP 工具调用归口。
// ctx 由调用方构建（含超时；Agent 侧随任务取消即时中断阻塞中的 CallTool，不再干等超时）；
// onProgress 非空时生成唯一 progressToken 写入请求 _meta 并注册回调，服务器发来的
// notifications/progress 逐条转发（协议约定：仅请求携带 progressToken 时服务器才回报进度）。
// 校验、结果拼装与错误语义同原 mcpCallTool
func mcpCallToolWithProgress(ctx context.Context, serverName, tool string, arguments map[string]interface{}, onProgress func(message string, progress, total float64)) (string, error) {
	mcpMu.Lock()
	setEnabled := mcpSet.Enabled
	e, ok := mcpEntries[serverName]
	mcpMu.Unlock()
	if !setEnabled || !ok {
		return "", fmt.Errorf("MCP 服务器 %q 未连接", serverName)
	}
	e.mu.Lock()
	sess := e.session
	recEnabled := e.rec.Enabled
	disabled := mcpDisabledSet(e.rec.DisabledTools)
	e.mu.Unlock()
	if sess == nil || !recEnabled || e.mcpStopped() {
		return "", fmt.Errorf("MCP 服务器 %q 当前未连接，请稍后重试", serverName)
	}
	if disabled[tool] {
		return "", fmt.Errorf("工具 %s 已被禁用", tool)
	}
	params := &mcp.CallToolParams{Name: tool, Arguments: arguments}
	if onProgress != nil {
		token := strconv.FormatUint(mcpProgressSeq.Add(1), 10)
		mcpProgressMu.Lock()
		mcpProgressCallbacks[token] = onProgress
		mcpProgressMu.Unlock()
		defer func() {
			mcpProgressMu.Lock()
			delete(mcpProgressCallbacks, token)
			mcpProgressMu.Unlock()
		}()
		params.Meta = mcp.Meta{"progressToken": token}
	}
	res, err := sess.CallTool(ctx, params)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, isText := c.(*mcp.TextContent); isText {
			sb.WriteString(tc.Text)
			continue
		}
		// 阶段一百一十四：ImageContent（Computer Use 截图等）转为内联标记——与 PC 端执行器约定一致，
		// agentrun 侧在工具结果截断前统一抽出并注入多模态消息
		if ic, isImage := c.(*mcp.ImageContent); isImage && len(ic.Data) > 0 {
			mime := ic.MIMEType
			if mime == "" {
				mime = "image/png"
			}
			sb.WriteString("[[MCP_IMAGE:data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(ic.Data) + "]]")
			continue
		}
		if b, merr := json.Marshal(c); merr == nil {
			sb.Write(b)
		}
	}
	out := strings.TrimSpace(sb.String())
	if res.IsError {
		return out, fmt.Errorf("工具返回错误：%s", out)
	}
	return out, nil
}

// mcpServerAutoApprove 服务器免审批开关读取归口（内存实时值；条目不存在视为 false 走审批）
func mcpServerAutoApprove(serverName string) bool {
	mcpMu.Lock()
	e, ok := mcpEntries[serverName]
	mcpMu.Unlock()
	if !ok {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.rec.AutoApprove
}

// mcpDisabledSet 禁用工具清单解析（JSON 数组字符串 → 集合）
func mcpDisabledSet(s string) map[string]bool {
	set := map[string]bool{}
	if strings.TrimSpace(s) == "" {
		return set
	}
	var list []string
	if json.Unmarshal([]byte(s), &list) != nil {
		return set
	}
	for _, v := range list {
		if v = strings.TrimSpace(v); v != "" {
			set[v] = true
		}
	}
	return set
}

// mcpParseArgs / mcpParseKV JSON 存储字段解析（空/坏值优雅归零）
func mcpParseArgs(s string) ([]string, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	var args []string
	if err := json.Unmarshal([]byte(s), &args); err != nil {
		return nil, err
	}
	return args, nil
}

func mcpParseKV(s string) (map[string]string, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	var kv map[string]string
	if err := json.Unmarshal([]byte(s), &kv); err != nil {
		return nil, err
	}
	return kv, nil
}

func mcpConnectTimeout() time.Duration {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	return mcpSet.ConnectTimeout
}

func mcpToolTimeout() time.Duration {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	return mcpSet.ToolTimeout
}

// ===== 阶段八十八：后台管理 HTTP 接口（TRAE CN 同款 MCP 管理能力归口） =====

// adminMCPServerReq MCP 服务器创建/编辑请求（env/headers 明文提交，仅服务端归口存储，
// 不经普通聊天链路下发；管理接口属管理员能力面，与 config.yaml 同权）
type adminMCPServerReq struct {
	Name          string            `json:"name"`
	Transport     string            `json:"transport"`
	Command       string            `json:"command"`
	Args          []string          `json:"args"`
	Env           map[string]string `json:"env"`
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	Enabled       *bool             `json:"enabled"`
	AutoApprove   bool              `json:"auto_approve"`
	DisabledTools []string          `json:"disabled_tools"`
}

// adminMCPServerView 管理页视图（含运行状态、工具清单、stdio 子进程 stderr 尾部日志）
type adminMCPServerView struct {
	ID            uint              `json:"id"`
	Name          string            `json:"name"`
	Transport     string            `json:"transport"`
	Command       string            `json:"command"`
	Args          []string          `json:"args"`
	Env           map[string]string `json:"env"`
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers"`
	Owner         string            `json:"owner"`
	Enabled       bool              `json:"enabled"`
	AutoApprove   bool              `json:"auto_approve"`
	DisabledTools []string          `json:"disabled_tools"`
	Status        string            `json:"status"`
	StatusMsg     string            `json:"status_msg"`
	ToolCount     int               `json:"tool_count"`
	Tools         []mcpToolInfo     `json:"tools"`
	StderrLog     []string          `json:"stderr_log"`
	CreateTime    time.Time         `json:"create_time"`
}

// mcpServerView 视图构建（entry 非 nil 时以内存实时状态覆盖 DB 持久状态）
func mcpServerView(rec model.MCPServer, e *mcpClientEntry) adminMCPServerView {
	view := adminMCPServerView{
		ID:          rec.ID,
		Name:        rec.Name,
		Transport:   rec.Transport,
		Command:     rec.Command,
		URL:         rec.URL,
		Owner:       rec.Owner,
		Enabled:     rec.Enabled,
		AutoApprove: rec.AutoApprove,
		Status:      rec.Status,
		StatusMsg:   rec.StatusMsg,
		ToolCount:   rec.ToolCount,
		CreateTime:  rec.CreateTime,
	}
	view.Args, _ = mcpParseArgs(rec.Args)
	view.Env, _ = mcpParseKV(rec.Env)
	if view.Env == nil {
		view.Env = map[string]string{}
	}
	view.Headers, _ = mcpParseKV(rec.Headers)
	if view.Headers == nil {
		view.Headers = map[string]string{}
	}
	view.DisabledTools = make([]string, 0)
	// 工具清单：内存实时值优先，离线时回退 DB 缓存（重启后/未连接场景管理页仍可查看）
	toolsJSON := rec.ToolsCache
	if e != nil {
		e.mu.Lock()
		view.AutoApprove = e.rec.AutoApprove
		for name := range mcpDisabledSet(e.rec.DisabledTools) {
			view.DisabledTools = append(view.DisabledTools, name)
		}
		view.Status, view.StatusMsg = e.status, e.statusMsg
		view.StderrLog = append([]string{}, e.stderrLog...)
		if e.tools != nil {
			if b, err := json.Marshal(e.tools); err == nil {
				toolsJSON = string(b)
			}
		}
		e.mu.Unlock()
	} else {
		for name := range mcpDisabledSet(rec.DisabledTools) {
			view.DisabledTools = append(view.DisabledTools, name)
		}
		view.StderrLog = []string{}
	}
	if strings.TrimSpace(toolsJSON) != "" {
		var tools []mcpToolInfo
		if json.Unmarshal([]byte(toolsJSON), &tools) == nil {
			view.Tools = tools
			view.ToolCount = len(tools)
		}
	}
	if view.Tools == nil {
		view.Tools = []mcpToolInfo{}
	}
	return view
}

// mcpValidateReq 请求校验与存储字段构建归口（requireUnique 控制重名校验——测试连接复用同结构免查库）
func mcpValidateReq(req *adminMCPServerReq, excludeID uint, requireUnique bool) (model.MCPServer, error) {
	rec := model.MCPServer{
		Name:      strings.TrimSpace(req.Name),
		Transport: mcpNormalizeTransport(req.Transport),
		Command:   strings.TrimSpace(req.Command),
		URL:       strings.TrimSpace(req.URL),
		Enabled:   true,
	}
	if rec.Name == "" {
		return rec, errors.New("服务器名称不能为空")
	}
	if len(rec.Name) > 64 {
		return rec, errors.New("服务器名称不能超过 64 字符")
	}
	if strings.HasPrefix(rec.Name, "pc_") || strings.HasPrefix(rec.Name, "pc-") {
		return rec, errors.New("服务器名称不能以 pc_ / pc- 开头（该前缀保留给用户本机 MCP 命名空间）")
	}
	switch rec.Transport {
	case mcpTransportStdio:
		if rec.Command == "" {
			return rec, errors.New("stdio 传输必须填写启动命令")
		}
		if len(req.Args) > 64 {
			return rec, errors.New("命令参数不能超过 64 个")
		}
		for _, a := range req.Args {
			if len(a) > 512 {
				return rec, errors.New("单个命令参数不能超过 512 字符")
			}
		}
		if len(req.Env) > 32 {
			return rec, errors.New("环境变量不能超过 32 个")
		}
	case mcpTransportSSE, mcpTransportHTTP:
		if !mcpValidURL(rec.URL) {
			return rec, errors.New("远程传输必须填写 http(s) 端点地址")
		}
		if len(req.Headers) > 32 {
			return rec, errors.New("请求头不能超过 32 个")
		}
	}
	if requireUnique {
		var count int64
		q := store.DB.Model(&model.MCPServer{}).Where("name = ?", rec.Name)
		if excludeID > 0 {
			q = q.Where("id <> ?", excludeID)
		}
		q.Count(&count)
		if count > 0 {
			return rec, fmt.Errorf("服务器名称已存在：%s", rec.Name)
		}
	}
	if req.Enabled != nil {
		rec.Enabled = *req.Enabled
	}
	rec.AutoApprove = req.AutoApprove
	if b, err := json.Marshal(req.Args); err == nil {
		rec.Args = string(b)
	}
	if len(req.Env) > 0 {
		if b, err := json.Marshal(req.Env); err == nil {
			rec.Env = string(b)
		}
	}
	if len(req.Headers) > 0 {
		if b, err := json.Marshal(req.Headers); err == nil {
			rec.Headers = string(b)
		}
	}
	// 禁用工具清单：规整去重后入库（未知工具名允许——服务器暂未连接时前端仍可预禁用）
	if len(req.DisabledTools) > 0 {
		seen := map[string]bool{}
		var list []string
		for _, t := range req.DisabledTools {
			if t = strings.TrimSpace(t); t != "" && !seen[t] {
				seen[t] = true
				list = append(list, t)
			}
		}
		if len(list) > 0 {
			if b, err := json.Marshal(list); err == nil {
				rec.DisabledTools = string(b)
			}
		}
	}
	// Owner 强制为空：阶段八十八仅开放管理员公共服务器，用户自建入口随阶段八十九开放
	rec.Owner = ""
	rec.Status = mcpStatusDisconnected
	return rec, nil
}

// handleAdminMCPList 服务器列表（运行时状态实时覆盖；响应附带 settings 供前端展示总开关）
func (s *Server) handleAdminMCPList(w http.ResponseWriter, r *http.Request) {
	var list []model.MCPServer
	if err := store.DB.Order("id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询 MCP 服务器失败")
		return
	}
	mcpMu.Lock()
	entries := make(map[string]*mcpClientEntry, len(mcpEntries))
	for k, e := range mcpEntries {
		entries[k] = e
	}
	set := mcpSet
	mcpMu.Unlock()
	views := make([]adminMCPServerView, 0, len(list))
	for _, rec := range list {
		views = append(views, mcpServerView(rec, entries[rec.Name]))
	}
	adminJSON(w, map[string]interface{}{
		"servers": views,
		"settings": map[string]interface{}{
			"enabled":           set.Enabled,
			"user_enabled":      set.UserEnabled,
			"stdio_whitelist":   set.StdioWhitelist,
			"connect_timeout_s": int(set.ConnectTimeout.Seconds()),
			"tool_timeout_s":    int(set.ToolTimeout.Seconds()),
		},
	})
}

// handleAdminMCPCreate 新增服务器（创建即建连；总开关关闭时仅入库待启用）
func (s *Server) handleAdminMCPCreate(w http.ResponseWriter, r *http.Request) {
	var req adminMCPServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	rec, err := mcpValidateReq(&req, 0, true)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("新增 MCP 服务器 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "新增 MCP 服务器失败")
		return
	}
	logger.Info("后台管理：新增 MCP 服务器 %s（%s），已触发建连", rec.Name, rec.Transport)
	reloadMCPServers()
	adminJSON(w, map[string]interface{}{"id": rec.ID})
}

// handleAdminMCPUpdate 编辑服务器（配置指纹变更自动重建连接，无变化不惊扰）
func (s *Server) handleAdminMCPUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var old model.MCPServer
	if err := store.DB.First(&old, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "MCP 服务器不存在")
		return
	}
	var req adminMCPServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	rec, err := mcpValidateReq(&req, id, true)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	// 归属与统计字段不随编辑重置；状态由连接管理器回写
	rec.ID = old.ID
	rec.Owner = old.Owner
	rec.ToolsCache = old.ToolsCache
	rec.ToolCount = old.ToolCount
	rec.CreateTime = old.CreateTime
	if err := store.DB.Save(&rec).Error; err != nil {
		logger.Error("编辑 MCP 服务器 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "编辑 MCP 服务器失败")
		return
	}
	logger.Info("后台管理：编辑 MCP 服务器 %s（%s），已按指纹差异重建连接", rec.Name, rec.Transport)
	reloadMCPServers()
	adminJSON(w, map[string]interface{}{"id": rec.ID})
}

// handleAdminMCPDelete 删除服务器（先断连再删记录，避免连接循环引用悬空配置）
func (s *Server) handleAdminMCPDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var old model.MCPServer
	if err := store.DB.First(&old, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "MCP 服务器不存在")
		return
	}
	if err := store.DB.Delete(&old).Error; err != nil {
		logger.Error("删除 MCP 服务器 %s 失败: %v", old.Name, err)
		adminFail(w, http.StatusInternalServerError, "删除 MCP 服务器失败")
		return
	}
	logger.Info("后台管理：删除 MCP 服务器 %s", old.Name)
	reloadMCPServers()
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// handleAdminMCPReconnect 手动重连（TRAE 同款 restart 归口）：断开现有连接按最新配置重建
func (s *Server) handleAdminMCPReconnect(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.MCPServer
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "MCP 服务器不存在")
		return
	}
	if !rec.Enabled {
		adminFail(w, http.StatusBadRequest, "服务器已停用，请先启用后再重连")
		return
	}
	mcpRestartEntry(rec)
	adminJSON(w, map[string]interface{}{"reconnecting": true})
}

// handleAdminMCPTest 测试连接（TRAE 同款"保存前验证"）：按提交的未持久化配置临时建连
// 并拉取工具清单，返回耗时与服务器信息；stdio 测试会真实拉起子进程，用完即收
func (s *Server) handleAdminMCPTest(w http.ResponseWriter, r *http.Request) {
	var req adminMCPServerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	rec, err := mcpValidateReq(&req, 0, false)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	transport, err := mcpBuildTransport(rec, io.Discard)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	cli := mcp.NewClient(&mcp.Implementation{Name: "im-server", Version: "1.0"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), mcpConnectTimeout())
	defer cancel()
	start := time.Now()
	sess, err := cli.Connect(ctx, transport, nil)
	if err != nil {
		adminFail(w, http.StatusBadRequest, "连接失败："+err.Error())
		return
	}
	defer sess.Close()
	tools, err := mcpListTools(sess, mcpConnectTimeout())
	if err != nil {
		adminFail(w, http.StatusBadRequest, "已连接但工具发现失败："+err.Error())
		return
	}
	elapsed := time.Since(start).Milliseconds()
	svName, svVer := "", ""
	if ir := sess.InitializeResult(); ir != nil && ir.ServerInfo != nil {
		svName, svVer = ir.ServerInfo.Name, ir.ServerInfo.Version
	}
	if tools == nil {
		tools = []mcpToolInfo{}
	}
	adminJSON(w, map[string]interface{}{
		"tool_count":     len(tools),
		"tools":          tools,
		"elapsed_ms":     elapsed,
		"server_name":    svName,
		"server_version": svVer,
		"protocol_version": func() string {
			if ir := sess.InitializeResult(); ir != nil {
				return ir.ProtocolVersion
			}
			return ""
		}(),
	})
}
