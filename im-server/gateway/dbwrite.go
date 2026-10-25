// gateway/dbwrite.go - 游戏账号写库：拉取器 + 参数化写库执行器（网关开发文档 §3.2/§4）
//
// 链路：poll_sec 周期调 im-server GET /internal/gateway/dbwrite?gw={自报名}（X-GW-Auth HMAC 签名，
// body 纳签）→ 响应体 AES-256-GCM 密文（X-GW-Enc 头，无头/解密失败一律拒收防降级窃听）→
// 逐条按策略执行 SQL 模板（占位符强制参数绑定，绝不字符串拼接）→ 成功条目批量回执 ack。
// 失败不回执 = im-server 侧下次仍返回，天然重试；写库异常绝不影响游戏隧道转发（独立 goroutine）。
//
// 安全归口：
//   1. 模板保存口径校验（启动即拦）：仅 INSERT/UPDATE 开头、禁分号多语句、禁 -- 与 /* 注释、
//      仅 {user}/{password} 占位符（{credential} 预留未启用）、替换后禁残留花括号（未知形态拒绝）；
//   2. 数据侧双保险：username 服务端限字符集、password 为 16 位纯数字派生，叠加参数绑定注入归零；
//   3. 凭证不落日志（username 可打、password 永不出现在日志），不落盘，仅写目标库。

package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/go-sql-driver/mysql"  // MySQL（im-server 既有依赖）
	_ "github.com/jackc/pgx/v5/stdlib"  // PostgreSQL（pgx stdlib，注册名 pgx）
	_ "github.com/microsoft/go-mssqldb" // MSSQL（注册名 sqlserver）
	_ "modernc.org/sqlite"              // SQLite（纯 Go 零 CGO，注册名 sqlite）

	"im-server/gwproto"
)

// DbwriteConfig gateway.yaml dbwrite 配置节（可选；enabled 才启动拉取器）。
// json tag 与 yaml 一致（snake_case）：Web 后台 GET 回显/POST 保存的 JSON body 靠它解析——
// 无 tag 时 Go 按字段名大小写不敏感匹配（GatewayName≠gateway_name，下划线不忽略），
// 下划线字段全部解析失败（实测踩坑：后台保存报 gateway_name 未配置）
type DbwriteConfig struct {
	Enabled     bool   `yaml:"enabled" json:"enabled"`           // 总开关
	GatewayName string `yaml:"gateway_name" json:"gateway_name"` // 自报网关名（须与 im-server 地址簿条目名一致，服务端据此按网关过滤）
	IMAddr      string `yaml:"im_addr" json:"im_addr"`           // im-server 拉取地址（http://host:2087）
	Type        string `yaml:"type" json:"type"`                 // mysql / mssql / postgres / sqlite
	DSN         string `yaml:"dsn" json:"dsn"`                   // 驱动连接串
	Strategy    string `yaml:"strategy" json:"strategy"`         // insert / update / upsert
	PollSec     int    `yaml:"poll_sec" json:"poll_sec"`         // 拉取周期秒（默认 30，clamp 5~600）
	SQLInsert   string `yaml:"sql_insert" json:"sql_insert"`     // INSERT 模板（{user}/{password} 占位符）
	SQLUpdate   string `yaml:"sql_update" json:"sql_update"`     // UPDATE 模板（strategy=update/upsert 必填）
}

// dbwriteDriverName 配置 type → database/sql 驱动注册名映射归口：
// go-mssqldb 注册名是 sqlserver（非 mssql）、pgx stdlib 注册名是 pgx（非 postgres）——
// 不做映射直接 sql.Open("mssql",…) 会 unknown driver panic（P1 遗留隐患，本映射修复）
func dbwriteDriverName(dbType string) string {
	switch dbType {
	case "mssql":
		return "sqlserver"
	case "postgres":
		return "pgx"
	default: // mysql / sqlite 同名
		return dbType
	}
}

// dbwriteTemplate 编译后的 SQL 模板：方言化参数符 SQL + 占位符取值顺序 + 语句类型
type dbwriteTemplate struct {
	SQL  string
	Args []string // 顺序即参数顺序，仅 "user"/"password"
	Kind string   // 语句类型（白名单动词小写）：insert/update/merge/call/exec/execute
}

// 占位符扫描（仅小写 {user}/{password} 形态；其余形态在替换后花括号残留检查中拒绝）
var dbwritePlaceholderRe = regexp.MustCompile(`\{[a-z_]+\}`)

// dbwriteStmtRe 语句类型白名单（大小写不敏感，启动/保存即拦）：
//   - INSERT/UPDATE：常规单条写（语句内部可任意复杂：子查询/JOIN/INSERT..SELECT/多表关联更新）
//   - MERGE：SQL Server/PG 15+ 合并语句（自带 WHEN MATCHED/NOT MATCHED 全语义；MSSQL 要求尾分号，已豁免）
//   - CALL/EXEC/EXECUTE：存储过程调用（复杂多表+事务逻辑写在游戏库端存储过程，网关只带参调用，
//     安全模型不变；sqlite 无存储过程不支持）。DELETE/DROP/TRUNCATE/ALTER/CREATE 等一律拒绝
var dbwriteStmtRe = regexp.MustCompile(`(?i)^\s*(insert|update|merge|call|exec|execute)\b`)

// compileDbwriteTemplate 模板编译归口：白名单校验 + 占位符→方言参数符替换。
// dialect：mysql/sqlite→?；mssql→@p1/@p2...；postgres→$1/$2...
func compileDbwriteTemplate(tpl, dialect string) (*dbwriteTemplate, error) {
	raw := strings.TrimSpace(tpl)
	if raw == "" {
		return nil, errors.New("模板为空")
	}
	// 语句类型提取与白名单校验（动词小写存 Kind；未命中白名单即拒绝）
	m := dbwriteStmtRe.FindStringSubmatch(raw)
	if m == nil {
		return nil, errors.New("仅允许 INSERT/UPDATE/MERGE/CALL/EXEC 开头的语句")
	}
	kind := strings.ToLower(m[1])
	// 禁多语句：尾分号剥掉后出现任何分号即拒
	body := strings.TrimRight(raw, " \t\r\n;")
	if strings.Contains(body, ";") {
		return nil, errors.New("禁止多语句（出现分号）")
	}
	// 禁注释（防注释逃逸）
	if strings.Contains(raw, "--") || strings.Contains(raw, "/*") {
		return nil, errors.New("禁止 SQL 注释（-- 与 /*）")
	}
	ph := dbwritePlaceholderRe.FindAllString(raw, -1)
	if len(ph) == 0 {
		return nil, errors.New("模板不含任何占位符（须含 {user} 或 {password}）")
	}
	args := make([]string, 0, len(ph))
	for _, p := range ph {
		name := strings.Trim(p, "{}")
		if name != "user" && name != "password" {
			return nil, fmt.Errorf("未知占位符 %s（仅支持 {user}/{password}）", p)
		}
		args = append(args, name)
	}
	mark := func(i int) string {
		switch dialect {
		case "mssql":
			return "@p" + strconv.Itoa(i)
		case "postgres":
			return "$" + strconv.Itoa(i)
		default: // mysql / sqlite 同为 ?
			return "?"
		}
	}
	n := 0
	out := dbwritePlaceholderRe.ReplaceAllStringFunc(raw, func(string) string {
		n++
		return mark(n)
	})
	// 未知占位符形态（如 {User}/{foo}/{1}）替换后残留花括号 → 拒绝（绝不带未解析占位符进 SQL）
	if strings.ContainsAny(out, "{}") {
		return nil, errors.New("模板含未知占位符形态（仅支持小写 {user}/{password}）")
	}
	return &dbwriteTemplate{SQL: out, Args: args, Kind: kind}, nil
}

// dbwriteEntry 拉取响应条目
type dbwriteEntry struct {
	ID       uint64 `json:"id"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// dbwriteRunner 拉取器 + 写库执行器（独立 goroutine，绝不阻塞游戏数据转发）。
// 热重载语义：每次配置变更由 dbwriteReload 构建全新 runner（新连接池/新模板）原子替换，
// 旧 runner 收到 stop 后退出并关闭旧池——替换边界内进行中的写库失败不回执自动重试，无损
type dbwriteRunner struct {
	cfg    DbwriteConfig
	secret string // 与 im-server 共享的 token_secret（签名 + 响应解密同源）
	client *http.Client
	stop   chan struct{} // 关闭即退出 loop（热重载/停用归口）
	mu     sync.Mutex
	db     *sql.DB
	ins    *dbwriteTemplate
	upd    *dbwriteTemplate
	last   map[string]string // username → 最近成功写入 password（同内容跳过，防重复写）
}

// dbwriteMgr 管理器：当前活跃 runner（nil=未启用）；Web 后台热更经 dbwriteReload 原子替换
var dbwriteMgr atomic.Pointer[dbwriteRunner]

// startDbwrite 写库链路启动归口（进程启动时调用一次）：enabled 且配置合法才启动；
// 配置/模板非法仅记日志不启动（隧道转发完全独立，不受影响）
func startDbwrite(cfg *Config) {
	if !cfg.Dbwrite.Enabled {
		log.Printf("[dbwrite] 未启用（dbwrite.enabled=false），拉取器不启动")
		return
	}
	r, err := newDbwriteRunner(cfg)
	if err != nil {
		log.Printf("[dbwrite] 未启动：%v", err)
		return
	}
	dbwriteMgr.Store(r)
	log.Printf("[dbwrite] 拉取器已启动：目标=%s 库=%s 策略=%s 周期=%ds 网关名=%s",
		strings.TrimRight(strings.TrimSpace(r.cfg.IMAddr), "/"), r.cfg.Type, r.cfg.Strategy, r.cfg.PollSec, strings.ToLower(strings.TrimSpace(r.cfg.GatewayName)))
	go r.loop()
}

// dbwriteAddrNorm 规范化 im_addr（保存/启动/热更共用，防手填格式错误带进运行期）：
// 剥离首尾空白与 Markdown 反引号/引号（实测用户从文档复制 `http://…` 带代码标记，整串包进
// URL 致解析超时）；scheme 后缺 // 自动补全（实测 http:1.2.3.4:2087 → no Host in request URL）
func dbwriteAddrNorm(s string) string {
	s = strings.Trim(strings.TrimSpace(s), "`\"' ")
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "http:") && !strings.HasPrefix(s, "http://") {
		s = "http://" + strings.TrimPrefix(s, "http:")
	} else if strings.HasPrefix(s, "https:") && !strings.HasPrefix(s, "https://") {
		s = "https://" + strings.TrimPrefix(s, "https:")
	}
	return s
}

// newDbwriteRunner 配置校验 + runner 构建归口（启动与热更共用同一校验口径，热更绝不绕过）：
// 必填项/类型/策略白名单/模板编译在此拦截；DSN 连通性不在此阻断（写库失败自动重试，「测试连接」负责提前验证）
func newDbwriteRunner(cfg *Config) (*dbwriteRunner, error) {
	d := cfg.Dbwrite
	name := strings.ToLower(strings.TrimSpace(d.GatewayName))
	dsn := strings.TrimSpace(d.DSN)
	imAddr := strings.TrimRight(dbwriteAddrNorm(d.IMAddr), "/")
	d.IMAddr = imAddr // 规范化回写：落盘与拉取 URL 同源干净值（cfg 为指针，保存热更路径的落盘随此值）
	d.Type = strings.ToLower(strings.TrimSpace(d.Type))
	d.Strategy = strings.ToLower(strings.TrimSpace(d.Strategy))
	if name == "" {
		return nil, errors.New("gateway_name 未配置（自报网关名，须与 im-server 地址簿一致）")
	}
	if imAddr == "" {
		return nil, errors.New("im_addr 未配置")
	}
	// 畸形地址拦截（须能解析出主机名）：防 http:1.2.3.4:2087 缺 //、纯主机名、多余字符等带进运行期
	if u, err := url.Parse(imAddr); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("im_addr 非法（须为完整 http://host:port 或 https://host，当前 %q）", imAddr)
	}
	if d.Type != "mysql" && d.Type != "mssql" && d.Type != "postgres" && d.Type != "sqlite" {
		return nil, fmt.Errorf("type 仅支持 mysql/mssql/postgres/sqlite（当前 %q）", d.Type)
	}
	if dsn == "" {
		return nil, errors.New("dsn 未配置")
	}
	switch d.Strategy {
	case "insert", "update", "upsert":
	default:
		return nil, fmt.Errorf("strategy 须为 insert/update/upsert（当前 %q）", d.Strategy)
	}
	if d.PollSec <= 0 {
		d.PollSec = 30
	}
	if d.PollSec < 5 {
		d.PollSec = 5
	}
	if d.PollSec > 600 {
		d.PollSec = 600
	}
	r := &dbwriteRunner{cfg: d, secret: cfg.TokenSecret,
		client: &http.Client{Timeout: 15 * time.Second}, stop: make(chan struct{}), last: map[string]string{}}
	// 模板编译（非法即拒绝，绝不带非法模板进运行期）
	if d.Strategy != "update" {
		t, err := compileDbwriteTemplate(d.SQLInsert, d.Type)
		if err != nil {
			return nil, fmt.Errorf("sql_insert 非法：%v", err)
		}
		r.ins = t
	}
	if d.Strategy != "insert" {
		t, err := compileDbwriteTemplate(d.SQLUpdate, d.Type)
		if err != nil {
			return nil, fmt.Errorf("sql_update 非法：%v", err)
		}
		r.upd = t
	}
	// mssql/postgres 的 URL 形态连接串中，密码含 # 会被 URL 解析器当 fragment 截断（实测
	// parse "sqlserver://sa:sq#123@…" invalid port，Open 阶段即失败）——Open 前预判给明确指引：
	// 建议改用 key=value 形态（密码无需转义）或将 # 编码为 %23
	if (d.Type == "mssql" || d.Type == "postgres") && strings.Contains(dsn, "://") && strings.Contains(dsn, "#") {
		return nil, fmt.Errorf("连接串含 # 会被 URL 截断（密码无法正确解析）：请改用 key=value 形态，密码无需转义——mssql: server=…;user id=…;password=…;database=…｜postgres: host=… port=… user=… password=… dbname=… sslmode=disable；或将 # 编码为 %%23")
	}
	// 连接池（Ping 失败不致命：写库时再报错，恢复后自动续写；驱动名经映射归口）。
	// sqlite 固定单连接：modernc sqlite 多连接并发写会 SQLITE_BUSY（拉取器 loop 本就串行，池收为 1 最稳）
	db, err := sql.Open(dbwriteDriverName(d.Type), dsn)
	if err != nil {
		return nil, fmt.Errorf("数据库连接池创建失败：%v", err)
	}
	if d.Type == "sqlite" {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(2)
		db.SetMaxIdleConns(1)
	}
	db.SetConnMaxLifetime(5 * time.Minute)
	r.db = db
	if err := r.db.Ping(); err != nil {
		// mssql/postgres 的 URL 形态连接串中，密码含 # 会被当 URL fragment 截断（实测
		// parse "sqlserver://sa:sq#123@…" invalid port）——识别到该特征时附明确指引
		if strings.Contains(dsn, "://") && strings.Contains(dsn, "#") {
			log.Printf("[dbwrite] 数据库暂时不可达（将继续重试）：%v", err)
			return nil, fmt.Errorf("数据库连接失败：%v——连接串含 # 会被 URL 截断：请改用 key=value 形态（mssql: server=…;user id=…;password=…;database=…｜postgres: host=… user=… password=… dbname=… sslmode=disable，密码无需转义），或将 # 编码为 %%23", err)
		}
		log.Printf("[dbwrite] 数据库暂时不可达（将继续重试）：%v", err)
	}
	return r, nil
}

// dbwriteReload dbwrite 配置热更归口（Web 后台保存后调用）：
//   - enabled=true：校验并构建新 runner（非法返回错误，旧配置保持运行不受影响）→ 原子替换 → 起新 loop → 停旧；
//     替换边界内新旧 runner 可能短暂并存（旧 poll 进行中 + 新启动即拉一轮），同条目双写为幂等 SQL 无害
//   - enabled=false：停用拉取器（隧道转发完全独立，不受影响）
func dbwriteReload(cfg *Config) error {
	if !cfg.Dbwrite.Enabled {
		if old := dbwriteMgr.Swap(nil); old != nil {
			old.shutdown()
			log.Printf("[dbwrite] 已停用（后台热更）")
		}
		return nil
	}
	nr, err := newDbwriteRunner(cfg)
	if err != nil {
		return err
	}
	old := dbwriteMgr.Swap(nr)
	go nr.loop()
	if old != nil {
		old.shutdown()
		log.Printf("[dbwrite] 配置热更生效：目标=%s 库=%s 策略=%s 周期=%ds 网关名=%s",
			strings.TrimRight(strings.TrimSpace(nr.cfg.IMAddr), "/"), nr.cfg.Type, nr.cfg.Strategy, nr.cfg.PollSec, strings.ToLower(strings.TrimSpace(nr.cfg.GatewayName)))
	}
	return nil
}

// shutdown 停止 runner：关 stop 让 loop 退出 + 关连接池（进行中 Exec 完成后归还即关，无损）
func (r *dbwriteRunner) shutdown() {
	select {
	case <-r.stop: // 已关闭
	default:
		close(r.stop)
	}
	if r.db != nil {
		_ = r.db.Close()
	}
}

// loop 拉取主循环（异常自恢复：panic 兜底不让写库链路拖垮进程；stop 关闭即退出支持热重载）
func (r *dbwriteRunner) loop() {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[dbwrite] 写库链路异常退出（隧道转发不受影响）：%v\n%s", e, debug.Stack())
		}
	}()
	t := time.NewTicker(time.Duration(r.cfg.PollSec) * time.Second)
	defer t.Stop()
	r.poll() // 启动即拉一轮（登录早于网关启动的存量条目立即补写）
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.poll()
		}
	}
}

// poll 单轮：拉取 → 逐条写库 → 成功条目回执
func (r *dbwriteRunner) poll() {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[dbwrite] 单轮异常（下轮重试）：%v\n%s", e, debug.Stack())
		}
	}()
	items, err := r.fetch()
	if err != nil {
		log.Printf("[dbwrite] 拉取失败（不回执，im-server 侧保持待写）：%v", err)
		return
	}
	if len(items) == 0 {
		return
	}
	acked := make([]uint64, 0, len(items))
	for _, it := range items {
		if it.Username == "" || it.Password == "" || it.ID == 0 {
			continue
		}
		// 摘要跳过：同账号同密码已在库（重复登录/多游戏共库场景不重复写）
		r.mu.Lock()
		same := r.last[it.Username] == it.Password
		r.mu.Unlock()
		if same {
			acked = append(acked, it.ID)
			continue
		}
		if err := r.execOne(it); err != nil {
			log.Printf("[dbwrite] 写库失败 username=%s id=%d：%v", it.Username, it.ID, err)
			continue // 不回执 → im-server 下次仍返回，天然重试
		}
		r.mu.Lock()
		r.last[it.Username] = it.Password
		r.mu.Unlock()
		acked = append(acked, it.ID)
	}
	if len(acked) > 0 {
		if err := r.ack(acked); err != nil {
			log.Printf("[dbwrite] 回执失败（已写入将随下轮重复执行，幂等模板无害）：%v", err)
		} else {
			log.Printf("[dbwrite] 本轮写入成功 %d 条", len(acked))
		}
	}
}

// fetch 拉取待写条目（HMAC 签名请求 + 强制解密响应）
func (r *dbwriteRunner) fetch() ([]dbwriteEntry, error) {
	name := strings.ToLower(strings.TrimSpace(r.cfg.GatewayName))
	uri := "/internal/gateway/dbwrite?gw=" + url.QueryEscape(name)
	req, err := http.NewRequest(http.MethodGet, r.cfg.IMAddr+uri, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(r.secret, time.Now(), "GET", uri, nil))
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("im-server 返回 %d：%s", resp.StatusCode, truncate(string(body), 120))
	}
	plain, err := gwproto.OpenResp(r.secret, string(body), resp.Header.Get(gwproto.RespEncHeader))
	if err != nil {
		return nil, fmt.Errorf("响应解密拒绝（%v）", err)
	}
	var out struct {
		Items []dbwriteEntry `json:"items"`
	}
	if err := json.Unmarshal(plain, &out); err != nil {
		return nil, fmt.Errorf("响应 JSON 解析失败：%v", err)
	}
	return out.Items, nil
}

// ack 成功条目回执（body 纳入签名：中间人篡改 ids 即验签失败）
func (r *dbwriteRunner) ack(ids []uint64) error {
	uri := "/internal/gateway/dbwrite/ack"
	payload, _ := json.Marshal(map[string]interface{}{"gw": strings.ToLower(strings.TrimSpace(r.cfg.GatewayName)), "ids": ids})
	req, err := http.NewRequest(http.MethodPost, r.cfg.IMAddr+uri, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(gwproto.AuthHeader, gwproto.SignAuth(r.secret, time.Now(), "POST", uri, payload))
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("im-server 返回 %d：%s", resp.StatusCode, truncate(string(b), 120))
	}
	return nil
}

// isStandaloneKind merge/call/exec 类语句自带完整合并语义（WHEN MATCHED/过程体），
// 无论执行策略均单次执行，绝不参与 upsert 的 UPDATE→INSERT 组合（防重复写）
func isStandaloneKind(kind string) bool {
	switch kind {
	case "merge", "call", "exec", "execute":
		return true
	}
	return false
}

// execOne 按策略执行参数化 SQL（占位符顺序取值，绝不字符串拼接）
func (r *dbwriteRunner) execOne(e dbwriteEntry) error {
	val := func(name string) string {
		if name == "user" {
			return e.Username
		}
		return e.Password
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	switch r.cfg.Strategy {
	case "insert":
		args := r.bindArgs(r.ins.Args, val)
		_, err := r.db.Exec(r.ins.SQL, args...)
		return err
	case "update":
		args := r.bindArgs(r.upd.Args, val)
		_, err := r.db.Exec(r.upd.SQL, args...)
		return err
	default: // upsert：merge/call/exec 类模板自带全语义 → 单次执行；普通模板先 UPDATE，影响 0 行（账号不在库）再 INSERT
		if isStandaloneKind(r.upd.Kind) {
			args := r.bindArgs(r.upd.Args, val)
			_, err := r.db.Exec(r.upd.SQL, args...)
			return err
		}
		if isStandaloneKind(r.ins.Kind) {
			args := r.bindArgs(r.ins.Args, val)
			_, err := r.db.Exec(r.ins.SQL, args...)
			return err
		}
		args := r.bindArgs(r.upd.Args, val)
		res, err := r.db.Exec(r.upd.SQL, args...)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err == nil && n > 0 {
			return nil
		}
		args = r.bindArgs(r.ins.Args, val)
		_, err = r.db.Exec(r.ins.SQL, args...)
		return err
	}
}

// bindArgs 按模板占位符顺序生成参数切片
func (r *dbwriteRunner) bindArgs(order []string, val func(string) string) []interface{} {
	args := make([]interface{}, 0, len(order))
	for _, a := range order {
		args = append(args, val(a))
	}
	return args
}

// dbwriteTestConn 「测试连接」归口（Web 后台按钮）：按 type+dsn 现场建临时连接池 Ping（5s 超时），
// 即建即关不落任何状态——成功返回 nil，失败返回可读错误（DSN 明文仅经本机回环传输，不落日志）
func dbwriteTestConn(dbType, dsn string) error {
	dbType = strings.ToLower(strings.TrimSpace(dbType))
	if dbType != "mysql" && dbType != "mssql" && dbType != "postgres" && dbType != "sqlite" {
		return fmt.Errorf("type 仅支持 mysql/mssql/postgres/sqlite（当前 %q）", dbType)
	}
	if strings.TrimSpace(dsn) == "" {
		return errors.New("dsn 未填写")
	}
	// mssql/postgres URL 形态密码含 # 会被 URL 截断（实测 invalid port）——预检给明确指引
	if (dbType == "mssql" || dbType == "postgres") && strings.Contains(dsn, "://") && strings.Contains(dsn, "#") {
		return errors.New("连接串含 # 会被 URL 截断：请改用 key=value 形态（密码无需转义，如 mssql: server=…;user id=…;password=…;database=…），或将 # 编码为 %23")
	}
	db, err := sql.Open(dbwriteDriverName(dbType), strings.TrimSpace(dsn))
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("连接失败：%v", err)
	}
	return nil
}

// truncate 日志截断（错误响应不落全量内容，防泄漏敏感信息）
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
