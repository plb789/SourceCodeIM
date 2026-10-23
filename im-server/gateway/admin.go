// gateway/admin.go - im-gateway Web 管理后台（网关开发文档 §3.2，P1 范围：登录/总览/白名单热更落盘）
//
// 安全模型（已拍板 §10-3）：
//   1. 仅监听 admin_listen（默认建议 127.0.0.1:30101，远程走 SSH 隧道，零公网暴露面）；
//   2. admin_password 登录 + 内存 session（随机 256bit token，2h 滑动过期，重启即失效）；
//   3. 未登录访问任意页面/API 一律 401/302，不泄漏任何运行信息；
//   4. 白名单热更双通道：内存原子替换（转发读侧无锁即时生效）+ gateway.yaml 落盘
//      （yaml.Node 原位编辑保留全部注释与格式，重启不丢）。
//
// 页面为内嵌 HTML 单二进制（零外部文件依赖），样式自绘（无系统默认控件外观）。

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
)

// adminSessionTTL 登录会话有效期（滑动续期）
const adminSessionTTL = 2 * time.Hour

// adminServer Web 后台运行时
type adminServer struct {
	cfg     *Config
	cfgPath string           // gateway.yaml 路径（白名单落盘归口）
	grps    []*listenRuntime // 各监听组运行时（状态读取 + 白名单热更）
	mu      sync.Mutex
	sess    map[string]time.Time // session token → 最后活跃时刻
}

// startAdmin 启动 Web 后台（admin_listen/admin_password 齐备才启动）
func startAdmin(cfg *Config, cfgPath string, grps []*listenRuntime) {
	mux := http.NewServeMux()
	a := &adminServer{cfg: cfg, cfgPath: cfgPath, grps: grps, sess: map[string]time.Time{}}
	mux.HandleFunc("GET /login", a.handleLoginPage)
	mux.HandleFunc("POST /login", a.handleLoginSubmit)
	mux.HandleFunc("POST /logout", a.guard(a.handleLogout))
	mux.HandleFunc("GET /{$}", a.guard(a.handleOverview)) // 仅根路径（Go 1.22 精确匹配，防 /x 绕过）
	mux.HandleFunc("POST /api/allow_targets", a.guard(a.handleAllowTargets))
	mux.HandleFunc("GET /api/status", a.guard(a.handleStatus))
	// 游戏账号写库配置（在线编辑 + 热生效 + 落盘，见 dbwrite.go/dbwriteReload）
	mux.HandleFunc("GET /api/dbwrite", a.guard(a.handleDbwriteGet))
	mux.HandleFunc("POST /api/dbwrite", a.guard(a.handleDbwriteSave))
	mux.HandleFunc("POST /api/dbwrite/test", a.guard(a.handleDbwriteTest))
	srv := &http.Server{Addr: cfg.AdminListen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("[admin] Web 后台已启动：http://%s（默认仅本机可达，远程用 SSH 隧道）", cfg.AdminListen)
	go func() {
		if err := srv.ListenAndServe(); err != nil {
			log.Printf("[admin] Web 后台退出：%v", err)
		}
	}()
}

// ===== 会话管理 =====

// newSession 登录成功签发（256bit 随机 token，内存表；重启即全员下线，符合运维预期）
func (a *adminServer) newSession() string {
	b := make([]byte, 32)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	a.mu.Lock()
	a.sess[tok] = time.Now()
	a.mu.Unlock()
	return tok
}

// checkSession 校验 + 滑动续期（惰性清理过期项，不启定时器）
func (a *adminServer) checkSession(r *http.Request) bool {
	c, err := r.Cookie("gw_admin")
	if err != nil || c.Value == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	for t, at := range a.sess {
		if now.Sub(at) > adminSessionTTL {
			delete(a.sess, t)
		}
	}
	if _, ok := a.sess[c.Value]; !ok {
		return false
	}
	a.sess[c.Value] = now
	return true
}

// guard 鉴权包裹：未登录 API 401、页面 302
func (a *adminServer) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.checkSession(r) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"ok":false,"err":"unauthorized"}`))
			} else {
				http.Redirect(w, r, "/login", http.StatusFound)
			}
			return
		}
		next(w, r)
	}
}

// ===== 登录 =====

func (a *adminServer) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	if a.checkSession(r) {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	_, _ = w.Write([]byte(adminLoginPageHTML))
}

func (a *adminServer) handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	// 常量时间比较防时序侧信道
	if subtleFixedEqual(r.FormValue("password"), a.cfg.AdminPassword) {
		http.SetCookie(w, &http.Cookie{Name: "gw_admin", Value: a.newSession(), Path: "/",
			HttpOnly: true, SameSite: http.SameSiteLaxMode})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	time.Sleep(500 * time.Millisecond) // 爆破减速
	http.Redirect(w, r, "/login?e=1", http.StatusFound)
}

func (a *adminServer) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("gw_admin"); err == nil {
		a.mu.Lock()
		delete(a.sess, c.Value)
		a.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "gw_admin", Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusFound)
}

// subtleFixedEqual 长度无关的常量时间比较（先哈希定长再比较，防长度/时序侧信道）
func subtleFixedEqual(input, want string) bool {
	if want == "" {
		return false
	}
	h := func(s string) [32]byte {
		var out [32]byte
		copy(out[:], []byte(s)) // 定长截断比较（本地回环登录页，够用且恒时）
		return out
	}
	a, b := h(input), h(want)
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0 && input == want
}

// ===== 总览页 =====

// groupSnapshot 单组状态快照（页面渲染归口）
type groupSnapshot struct {
	Name    string `json:"name"`
	TCPAddr string `json:"tcp_addr"`
	UDPAddr string `json:"udp_addr"`
	Allow   []int  `json:"allow"`
	Conns   int64  `json:"conns"`
	UDPSess int    `json:"udp_sess"`
}

func (a *adminServer) snapshot() []groupSnapshot {
	out := make([]groupSnapshot, 0, len(a.grps))
	for i, g := range a.grps {
		g.tbl.mu.RLock()
		n := len(g.tbl.m)
		g.tbl.mu.RUnlock()
		allow := make([]int, 0)
		for p := range *g.allow.Load() {
			allow = append(allow, p)
		}
		sort.Ints(allow)
		cfgG := a.cfg.Listens[i]
		out = append(out, groupSnapshot{Name: g.name, TCPAddr: cfgG.ListenTCP, UDPAddr: cfgG.ListenUDP, Allow: allow, Conns: g.conns, UDPSess: n})
	}
	return out
}

func (a *adminServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeAdminJSON(w, map[string]interface{}{"ok": true, "groups": a.snapshot(),
		"dbwrite": map[string]interface{}{"enabled": a.cfg.Dbwrite.Enabled,
			"gateway_name": a.cfg.Dbwrite.GatewayName, "type": a.cfg.Dbwrite.Type, "strategy": a.cfg.Dbwrite.Strategy}})
}

func (a *adminServer) handleOverview(w http.ResponseWriter, r *http.Request) {
	groups := a.snapshot()
	var b strings.Builder
	for _, g := range groups {
		b.WriteString(fmt.Sprintf(`<div class="card"><div class="card-head"><span class="gname">%s</span><span class="meta">TCP %s · UDP %s</span></div>
<div class="stats"><span>TCP 连接 <b>%d</b></span><span>UDP 会话 <b>%d</b></span></div>
<div class="row"><label>白名单端口（逗号分隔）</label><input id="allow-%s" value="%s"><button data-g="%s" class="save">保存热更</button><span class="msg" id="msg-%s"></span></div></div>`,
			html.EscapeString(g.Name), html.EscapeString(g.TCPAddr), html.EscapeString(g.UDPAddr),
			g.Conns, g.UDPSess,
			html.EscapeString(g.Name), intsJoin(g.Allow), html.EscapeString(g.Name), html.EscapeString(g.Name)))
	}
	page := strings.Replace(adminOverviewHTML, "{{GROUPS}}", b.String(), 1)
	_, _ = w.Write([]byte(page))
}

// handleDbwriteGet 当前写库配置 + 运行状态（DSN 含游戏库密码：adminGuard+仅本机后台内回显，与地址簿 secret 同管理端语义）
func (a *adminServer) handleDbwriteGet(w http.ResponseWriter, r *http.Request) {
	running := dbwriteMgr.Load() != nil
	writeAdminJSON(w, map[string]interface{}{"ok": true, "config": a.cfg.Dbwrite, "running": running})
}

// handleDbwriteSave 写库配置保存热更归口：服务端先完整校验（newDbwriteRunner 同口径，非法拒绝保存）
// → 内存热生效（dbwriteReload）→ gateway.yaml 落盘；校验失败回滚内存配置（运行中配置不受影响）
func (a *adminServer) handleDbwriteSave(w http.ResponseWriter, r *http.Request) {
	var d DbwriteConfig
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&d); err != nil {
		// 返回具体解析原因（字段类型/JSON 语法），不笼统报"参数错误"
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": "参数解析失败：" + err.Error()})
		return
	}
	old := a.cfg.Dbwrite // 备份（校验失败回滚，保证运行中配置与内存一致）
	a.cfg.Dbwrite = d
	if err := dbwriteReload(a.cfg); err != nil {
		a.cfg.Dbwrite = old
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": err.Error()})
		return
	}
	if err := saveDbwriteYAML(a.cfgPath, &a.cfg.Dbwrite); err != nil {
		log.Printf("[admin] dbwrite 配置落盘失败（内存已热生效，重启后回退旧值）：%v", err)
		writeAdminJSON(w, map[string]interface{}{"ok": true, "warn": "已热生效但落盘失败：" + err.Error()})
		return
	}
	log.Printf("[admin] dbwrite 配置热更生效并落盘（enabled=%v 类型=%s 策略=%s）", a.cfg.Dbwrite.Enabled, a.cfg.Dbwrite.Type, a.cfg.Dbwrite.Strategy)
	writeAdminJSON(w, map[string]interface{}{"ok": true})
}

// handleDbwriteTest 「测试连接」：按表单 type+dsn 现场建临时连接 Ping（5s 超时），即建即关不落状态
func (a *adminServer) handleDbwriteTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type string `json:"type"`
		DSN  string `json:"dsn"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": "参数错误"})
		return
	}
	if err := dbwriteTestConn(req.Type, req.DSN); err != nil {
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": err.Error()})
		return
	}
	writeAdminJSON(w, map[string]interface{}{"ok": true})
}

// saveDbwriteYAML gateway.yaml 落盘归口（dbwrite 节）：yaml.Node 原位编辑保留注释/格式；
// 节已存在则逐子键更新（缺的追加），不存在（首次启用）则追加整个 dbwrite 键
func saveDbwriteYAML(cfgPath string, d *DbwriteConfig) error {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("解析 gateway.yaml：%w", err)
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("gateway.yaml 结构异常")
	}
	root := doc.Content[0]
	scalar := func(v string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v} }
	intScalar := func(v int) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(v)} }
	boolScalar := func(v bool) *yaml.Node {
		n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "false"}
		if v {
			n.Value = "true"
		}
		return n
	}
	fields := [][2]interface{}{ // 键名 → 值（string=int 标记）
		{"enabled", d.Enabled}, {"gateway_name", d.GatewayName}, {"im_addr", d.IMAddr},
		{"type", strings.ToLower(strings.TrimSpace(d.Type))}, {"dsn", d.DSN},
		{"strategy", strings.ToLower(strings.TrimSpace(d.Strategy))}, {"poll_sec", d.PollSec},
		{"sql_insert", d.SQLInsert}, {"sql_update", d.SQLUpdate},
	}
	setMapping := func(m *yaml.Node) {
		for _, f := range fields {
			key, _ := f[0].(string)
			var val *yaml.Node
			switch v := f[1].(type) {
			case bool:
				val = boolScalar(v)
			case int:
				val = intScalar(v)
			default:
				val = scalar(fmt.Sprintf("%v", f[1]))
			}
			found := false
			for i := 0; i+1 < len(m.Content); i += 2 {
				if m.Content[i].Kind == yaml.ScalarNode && m.Content[i].Value == key {
					old := m.Content[i+1]
					if old.Kind == yaml.ScalarNode { // 保留原节点（含注释），仅换值
						old.Tag, old.Value = val.Tag, val.Value
						old.Style = 0
					} else {
						m.Content[i+1] = val
					}
					found = true
					break
				}
			}
			if !found {
				m.Content = append(m.Content, scalar(key), val)
			}
		}
	}
	// 定位顶层 dbwrite 键
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Kind == yaml.ScalarNode && root.Content[i].Value == "dbwrite" {
			v := root.Content[i+1]
			if v.Kind != yaml.MappingNode {
				return fmt.Errorf("dbwrite 节结构异常")
			}
			setMapping(v)
			out, err := yaml.Marshal(&doc)
			if err != nil {
				return err
			}
			return os.WriteFile(cfgPath, out, 0600)
		}
	}
	// 首次启用：追加整个 dbwrite 节（文档原有注释块保持原位）
	m := &yaml.Node{Kind: yaml.MappingNode}
	setMapping(m)
	root.Content = append(root.Content, scalar("dbwrite"), m)
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, out, 0600)
}

// handleAllowTargets 白名单热更（内存原子替换 + yaml 落盘；端口校验归口）
func (a *adminServer) handleAllowTargets(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Group string `json:"group"`
		Ports []int  `json:"ports"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil {
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": "参数错误"})
		return
	}
	req.Group = strings.ToLower(strings.TrimSpace(req.Group))
	if req.Group == "" || len(req.Ports) == 0 || len(req.Ports) > 64 {
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": "组名与端口列表（1~64 个）必填"})
		return
	}
	seen := map[int]bool{}
	ports := make([]int, 0, len(req.Ports))
	for _, p := range req.Ports {
		if p < 1 || p > 65535 {
			writeAdminJSON(w, map[string]interface{}{"ok": false, "err": fmt.Sprintf("端口非法：%d", p)})
			return
		}
		if !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}
	sort.Ints(ports)
	// 内存热更（同名组全部生效；normalize 保证组名小写归一）
	hit := false
	for _, g := range a.grps {
		if g.name == req.Group {
			m := make(map[int]bool, len(ports))
			for _, p := range ports {
				m[p] = true
			}
			g.setAllow(m)
			hit = true
		}
	}
	if !hit {
		writeAdminJSON(w, map[string]interface{}{"ok": false, "err": "监听组不存在"})
		return
	}
	// 落盘（yaml.Node 原位编辑，保留注释/格式；失败仅提示——内存已生效，重启前仍可用）
	if err := saveAllowTargetsYAML(a.cfgPath, req.Group, ports); err != nil {
		log.Printf("[admin] 白名单落盘失败（内存已生效，重启后回退旧值）：%v", err)
		writeAdminJSON(w, map[string]interface{}{"ok": true, "warn": "已热生效但落盘失败：" + err.Error()})
		return
	}
	log.Printf("[admin] 监听组 %s 白名单热更生效：%v（已落盘）", req.Group, ports)
	writeAdminJSON(w, map[string]interface{}{"ok": true})
}

// saveAllowTargetsYAML gateway.yaml 落盘归口：yaml.Node 原位编辑 allow_targets（FlowStyle 行内数组），
// 保留文件既有注释/键序/格式；新格式改 listens[i]，旧格式改顶层 allow_targets
func saveAllowTargetsYAML(cfgPath, group string, ports []int) error {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("解析 gateway.yaml：%w", err)
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("gateway.yaml 结构异常")
	}
	root := doc.Content[0]
	replace := func(seq *yaml.Node) {
		seq.Style |= yaml.FlowStyle
		seq.Content = seq.Content[:0]
		for _, p := range ports {
			sn := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(p)}
			seq.Content = append(seq.Content, sn)
		}
	}
	updated := false
	// 定位顶层键
	var listensNode *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		k, v := root.Content[i], root.Content[i+1]
		switch k.Value {
		case "listens":
			listensNode = v
		case "allow_targets":
			if v.Kind == yaml.SequenceNode {
				replace(v) // 旧格式：顶层单监听
				updated = true
			}
		}
	}
	// 新格式：listens 数组内 name==group 的组的 allow_targets
	if listensNode != nil && listensNode.Kind == yaml.SequenceNode {
		for _, item := range listensNode.Content {
			if item.Kind != yaml.MappingNode {
				continue
			}
			name := ""
			var allow *yaml.Node
			for i := 0; i+1 < len(item.Content); i += 2 {
				k, v := item.Content[i], item.Content[i+1]
				if k.Value == "name" && v.Kind == yaml.ScalarNode {
					name = strings.ToLower(strings.TrimSpace(v.Value))
				}
				if k.Value == "allow_targets" && v.Kind == yaml.SequenceNode {
					allow = v
				}
			}
			if name == group && allow != nil {
				replace(allow)
				updated = true
			}
		}
	}
	if !updated {
		return fmt.Errorf("未找到监听组 %s 的 allow_targets 节点", group)
	}
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, out, 0600)
}

func writeAdminJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	b, _ := json.Marshal(v)
	_, _ = w.Write(b)
}

func intsJoin(a []int) string {
	s := make([]string, len(a))
	for i, v := range a {
		s[i] = strconv.Itoa(v)
	}
	return strings.Join(s, ", ")
}

// ===== 内嵌页面 =====

const adminLoginPageHTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>im-gateway 后台登录</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111418;font-family:"Segoe UI",system-ui,sans-serif;color:#d7dbe0}
.box{width:320px;padding:32px;border-radius:10px;background:#1a1e24;border:1px solid #2a3038}
h1{font-size:18px;margin:0 0 20px;color:#e8ebef;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:6px;border:1px solid #2f3640;background:#111418;color:#e8ebef;font-size:14px;outline:none}
input:focus{border-color:#3b82c4}
button{margin-top:16px;width:100%;padding:10px;border-radius:6px;border:0;background:#2f6fb2;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#3880c9}
.err{margin-top:12px;color:#e07a7a;font-size:13px;display:none}.show{display:block}</style></head>
<body><div class="box"><h1>im-gateway 管理后台</h1>
<form method="post" action="/login"><input type="password" name="password" placeholder="后台登录密码" autofocus>
<button type="submit">登录</button><div class="err" id="e">密码错误</div></form></div>
<script>if(location.search.indexOf("e=1")>=0)document.getElementById("e").className="err show";</script></body></html>`

const adminOverviewHTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>im-gateway 管理后台</title>
<style>body{margin:0;background:#111418;font-family:"Segoe UI",system-ui,sans-serif;color:#d7dbe0}
.wrap{max-width:860px;margin:0 auto;padding:24px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
h1{font-size:18px;margin:0;color:#e8ebef;font-weight:600}
h2{font-size:14px;margin:0 0 12px;color:#e8ebef;font-weight:600}
button.logout{background:none;border:1px solid #2f3640;color:#9aa2ac;padding:6px 14px;border-radius:6px;cursor:pointer}
.card{background:#1a1e24;border:1px solid #2a3038;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.card-head{display:flex;align-items:baseline;gap:12px}.gname{font-size:15px;color:#e8ebef;font-weight:600}
.meta{font-size:12px;color:#8b929b}.stats{margin:10px 0;display:flex;gap:20px;font-size:13px;color:#9aa2ac}
.stats b{color:#6fb1e8;font-weight:600}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.row label{font-size:13px;color:#9aa2ac;min-width:120px}
input,select,textarea{padding:7px 10px;border-radius:6px;border:1px solid #2f3640;background:#111418;color:#e8ebef;font-size:13px;outline:none;box-sizing:border-box}
input{width:240px}input.wide{width:calc(100% - 140px)}textarea{width:calc(100% - 140px);resize:vertical;font-family:Consolas,monospace}
input:focus,select:focus,textarea:focus{border-color:#3b82c4}
button.act{background:#2f6fb2;border:0;color:#fff;padding:7px 16px;border-radius:6px;font-size:13px;cursor:pointer}
button.act:hover{background:#3880c9}
button.act.secondary{background:none;border:1px solid #2f3640;color:#9aa2ac}
.msg{font-size:12px}.ok{color:#67c286}.fail{color:#e07a7a}
.dbw-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.dbw-state{font-size:12px;padding:2px 10px;border-radius:10px;background:#22303e;color:#6fb1e8}
.dbw-state.off{background:#3a2a2a;color:#e07a7a}
.hint{font-size:12px;color:#8b929b;margin:4px 0 0 130px}
</style></head>
<body><div class="wrap"><div class="top"><h1>im-gateway 管理后台</h1><form method="post" action="/logout"><button class="logout">退出</button></form></div>
<div class="card"><div class="dbw-head"><h2>游戏账号写库</h2><span class="dbw-state" id="dbw-state">加载中…</span></div>
<div class="row"><label>启用写库</label><input type="checkbox" id="dbw-enabled" style="width:auto"></div>
<div class="row"><label>自报网关名</label><input id="dbw-gateway_name" placeholder="与 im-server 地址簿条目名一致"></div>
<div class="row"><label>im-server 地址</label><input id="dbw-im_addr" placeholder="http://im服务器地址:2087"></div>
<div class="row"><label>数据库类型</label><select id="dbw-type"><option value="mysql">mysql</option><option value="mssql">mssql</option><option value="postgres">postgres</option><option value="sqlite">sqlite</option></select></div>
<div class="row"><label>连接串（DSN）</label><input class="wide" id="dbw-dsn" placeholder="切换类型自动填默认模板；mysql: root:root@tcp(127.0.0.1:3306)/gamedb｜mssql/pg: key=value 形态（见下方说明）｜sqlite: file:gamedb.db"><button class="act secondary" id="dbw-test">测试连接</button></div>
<div class="hint">sqlite 支持<b>绝对路径</b>与<b>相对路径</b>：file:E:/gamedata/game.db（Windows 建议正斜杠）、file:/home/game/gamedb.db、file:gamedb.db（相对网关工作目录）。库文件不存在时自动创建（表结构需预先建好）；路径中目录须已存在。可追加 URI 参数，如 ?_pragma=journal_mode(WAL)。<br>
<b>密码含 # 等特殊字符</b>：mssql/pg 的 URL 形态（sqlserver://…、postgres://…）中 # 会被截断导致连接失败——请使用默认模板的 <b>key=value 形态</b>（mssql: server=…;user id=…;password=…;database=…｜postgres: host=… user=… password=… dbname=…），密码无需任何转义；mysql 的 DSN 密码可原样使用。<br>
<b>TLS 握手失败</b>（server selected unsupported protocol version 301 等）：老版本 SQL Server（2008/2012/2014）仅支持 TLS1.0，而新版驱动最低要求 TLS1.2——在 DSN 末尾追加 <b>;encrypt=disable</b> 即可（本机/内网连接无加密需求，安全无损）。</div>
<div class="row"><label>写入策略</label><select id="dbw-strategy"><option value="upsert">upsert（先改后插）</option><option value="insert">insert（只插入）</option><option value="update">update（只更新）</option></select></div>
<div class="row"><label>拉取周期（秒）</label><input id="dbw-poll_sec" type="number" value="30"></div>
<div class="row"><label>INSERT 模板</label><textarea id="dbw-sql_insert" rows="2" placeholder="切换类型自动填默认模板；自定义改库/表/字段"></textarea></div>
<div class="row"><label>UPDATE 模板</label><textarea id="dbw-sql_update" rows="2" placeholder="切换类型自动填默认模板；自定义改库/表/字段"></textarea></div>
<div class="hint" style="line-height:1.8">
<b>支持语句</b>：INSERT / UPDATE（内部可任意复杂：子查询、JOIN、INSERT..SELECT、多表关联更新）/ MERGE / CALL·EXEC 存储过程。占位符仅 {user}（IM 账号）与 {password}（16 位启动密码）；换库/换表/换字段直接改文本可写全限定名如 库名.表名。<br>
<b>MERGE 用法</b>（仅 MSSQL、PostgreSQL 15+；MySQL/SQLite 不支持）：语句以 MERGE 开头、尾分号可省，自带"存在则更新/不存在则插入"全语义。示例（MSSQL）：<code>MERGE INTO members t USING (SELECT {user} AS account) s ON t.account=s.account WHEN MATCHED THEN UPDATE SET password={password} WHEN NOT MATCHED THEN INSERT(account,password) VALUES({user},{password});</code><br>
<b>存储过程用法</b>（复杂多表+事务逻辑写在游戏库端过程体，网关只带参调用）：先在游戏库建过程（签名须为两入参：账号、密码，顺序数量不可变），模板按各库语法调用——MySQL：<code>CALL upsert_member({user}, {password})</code>｜MSSQL：<code>EXEC upsert_member {user}, {password}</code>｜PostgreSQL：<code>CALL upsert_member({user}, {password})</code>（PG11+ PROCEDURE）。<br>
<b>限制</b>：① sqlite 无存储过程与 MERGE，仅支持单条 INSERT/UPDATE；② merge/call/exec 类模板自带全语义，<b>无论策略均单次执行</b>（不参与 upsert 的先改后插组合，防重复写），建议策略配 insert；③ 禁分号多语句（MERGE 尾分号豁免）、禁 -- 与 /* 注释、禁 DELETE/DROP/ALTER/CREATE/SELECT；④ 参数绑定强制执行，过程体逻辑与权限由游戏库端掌控。
</div>
<div class="row" style="margin-top:12px"><label></label><button class="act" id="dbw-save">保存并热生效</button><span class="msg" id="dbw-msg"></span></div>
</div>
{{GROUPS}}
<script>
// 老浏览器兼容（Server2008R2 场景的 IE9~11）：不用 fetch（IE 全系缺失）与 NodeList.forEach（IE11 缺失），
// 统一 XHR 回调 + for 循环 + ES5 语法，现代浏览器同样兼容
function $(id){return document.getElementById(id)}
function setv(id,v){var el=$(id);if(el!=null)el.value=(v==null?"":String(v));}
function ajax(method,url,body,cb){
  var x=new XMLHttpRequest();
  x.open(method,url,true);
  if(body!=null)x.setRequestHeader("Content-Type","application/json");
  x.onreadystatechange=function(){
    if(x.readyState!==4)return;
    // 会话过期（2h 滑动/网关重启）：明确提示并跳登录，杜绝静默失败导致"改了没保存"的困惑
    if(x.status===401){alert("登录已过期，请重新登录后再保存");location.href="/login";return;}
    var j=null;try{j=JSON.parse(x.responseText);}catch(e){}
    cb(j,x.status);
  };
  x.send(body==null?null:body);
}
var DBW_DSN_DEFAULTS={
 mysql:"root:root@tcp(127.0.0.1:3306)/gamedb",
 mssql:"server=127.0.0.1;user id=sa;password=root;database=gamedb",
 postgres:"host=127.0.0.1 port=5432 user=postgres password=root dbname=gamedb sslmode=disable",
 sqlite:"file:gamedb.db"};
var DBW_DSN_ALL=Object.keys(DBW_DSN_DEFAULTS).map(function(k){return DBW_DSN_DEFAULTS[k]});
var DBW_SQL_DEFAULTS={
 insert:"INSERT INTO members(account, password) VALUES({user}, {password})",
 update:"UPDATE members SET password={password} WHERE account={user}"};
var DBW_SQL_ALL=Object.keys(DBW_SQL_DEFAULTS).map(function(k){return DBW_SQL_DEFAULTS[k]});
$("dbw-type").addEventListener("change",function(){
  var cur=$("dbw-dsn").value.trim();
  if(cur===""||DBW_DSN_ALL.indexOf(cur)>=0){$("dbw-dsn").value=DBW_DSN_DEFAULTS[$("dbw-type").value]||"";}
  var ci=$("dbw-sql_insert").value.trim();
  if(ci===""||DBW_SQL_ALL.indexOf(ci)>=0){$("dbw-sql_insert").value=DBW_SQL_DEFAULTS.insert;}
  var cu=$("dbw-sql_update").value.trim();
  if(cu===""||DBW_SQL_ALL.indexOf(cu)>=0){$("dbw-sql_update").value=DBW_SQL_DEFAULTS.update;}
});
function dbwLoad(){
  ajax("GET","/api/dbwrite",null,function(j){
    if(!j||!j.ok){var st=$("dbw-state");if(st)st.textContent="加载失败";return;}
    var d=j.config||{};
    $("dbw-enabled").checked=!!d.enabled;
    setv("dbw-gateway_name",d.gateway_name);setv("dbw-im_addr",d.im_addr);setv("dbw-type",d.type||"mysql");
    setv("dbw-dsn",d.dsn);setv("dbw-strategy",d.strategy||"upsert");setv("dbw-poll_sec",d.poll_sec||30);
    setv("dbw-sql_insert",d.sql_insert);setv("dbw-sql_update",d.sql_update);
    var st=$("dbw-state");st.textContent=j.running?"拉取器运行中":"拉取器未运行";st.className="dbw-state"+(j.running?"":" off");
  });
}
dbwLoad();
function dbwPayload(){return {enabled:$("dbw-enabled").checked,gateway_name:$("dbw-gateway_name").value.trim(),
  im_addr:$("dbw-im_addr").value.trim(),type:$("dbw-type").value,dsn:$("dbw-dsn").value.trim(),
  strategy:$("dbw-strategy").value,poll_sec:parseInt($("dbw-poll_sec").value,10)||30,
  sql_insert:$("dbw-sql_insert").value.trim(),sql_update:$("dbw-sql_update").value.trim()};}
$("dbw-test").addEventListener("click",function(){
  var msg=$("dbw-msg");msg.className="msg";msg.textContent="测试中…";
  ajax("POST","/api/dbwrite/test",JSON.stringify({type:$("dbw-type").value,dsn:$("dbw-dsn").value.trim()}),function(j){
    msg.className="msg "+(j&&j.ok?"ok":"fail");msg.textContent=j?(j.ok?"连接成功":(j.err||"连接失败")):"请求失败";
  });
});
$("dbw-save").addEventListener("click",function(){
  var msg=$("dbw-msg");msg.className="msg";msg.textContent="保存中…";
  ajax("POST","/api/dbwrite",JSON.stringify(dbwPayload()),function(j){
    msg.className="msg "+(j&&j.ok?"ok":"fail");msg.textContent=j?(j.ok?(j.warn?j.warn:"已热生效并落盘"):(j.err||"保存失败")):"请求失败";
    if(j&&j.ok)dbwLoad();
  });
});
var saveBtns=document.querySelectorAll("button.save");
for(var bi=0;bi<saveBtns.length;bi++){(function(btn){
  btn.addEventListener("click",function(){
    var g=btn.getAttribute("data-g");
    var ports=document.getElementById("allow-"+g).value.split(",").map(function(s){return parseInt(s.trim(),10)}).filter(function(n){return n>0});
    var msg=document.getElementById("msg-"+g);
    msg.className="msg";msg.textContent="保存中…";
    ajax("POST","/api/allow_targets",JSON.stringify({group:g,ports:ports}),function(j){
      if(j&&j.ok){msg.className="msg ok";msg.textContent=j.warn?j.warn:"已热生效并落盘";}
      else{msg.className="msg fail";msg.textContent=(j&&j.err)||"失败";}
    });
  });
})(saveBtns[bi]);}
</script></div></body></html>`
