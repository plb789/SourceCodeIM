// gateway/recharge.go - 积分兑换充值：拉取器 + 参数化 SQL 执行器（积分兑换网关充值功能开发文档 §3.2）
//
// 链路：poll_sec 周期调 im-server GET /internal/gateway/recharge?gw={自报名}（X-GW-Auth HMAC 签名，
// 响应 AES-256-GCM 强制解密）→ 逐条按游戏配置的 SQL 模板（占位符 {user}/{amount}/{order} 强制参数
// 绑定，绝不字符串拼接）执行到该游戏的游戏库 → 成功条目回执 ack（ok 列）。
// 失败不回执 = im-server 侧保持待写天然重试；持续失败 30 分钟后 im-server 侧超时自动退分。
//
// 幂等双保险（防重复加钱，开发文档 §3.2）：
//   1. 本地已处理订单号落盘（recharge_done.json）：执行成功先落盘再 ack；重启重放订单先查本地，
//      已处理直接补 ack 不再执行 SQL——防"已写库但 ack 丢失/进程崩溃"场景重复加钱；
//   2. 模板占位符 {order}：推荐游戏库端用存储过程按订单号去重（文档给模板），双保险 1 失效仍不重复加钱。
//
// 安全归口：
//   1. 模板保存口径校验（保存即拦）：仅 INSERT/UPDATE/MERGE/CALL/EXEC 开头、禁分号多语句、
//      禁注释、占位符白名单 {user}/{amount}/{order}（{password} 出现即拒：充值链路无密码语义）；
//   2. 数据侧校验：amount/order 纯数字正则二次校验、username 非空限长，叠加参数绑定注入归零；
//   3. 游戏未配置（订单 game_id 不在 games 表）：不执行不 ack（等管理员配好），绝不误写其他库；
//   4. 凭证不下发（拉取响应无 points/无密码）；执行失败仅记日志不落敏感数据。

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"database/sql"

	"im-gateway-legacy/gwproto"
)

// ===== 配置 =====

// RechargeGameConfig 单游戏充值配置：一组独立 DSN + SQL 模板（一个网关可服务多个游戏库）
type RechargeGameConfig struct {
	Game string `yaml:"game" json:"game"` // 游戏 ID（im-server 侧 Game.ID；订单按 game_id 路由）
	Type string `yaml:"type" json:"type"` // mysql / mssql / postgres / sqlite
	DSN  string `yaml:"dsn" json:"dsn"`   // 驱动连接串
	SQL  string `yaml:"sql" json:"sql"`   // 充值 SQL 模板（{user}/{amount}/{order} 占位符）
}

// RechargeConfig gateway.yaml recharge 配置节（可选；enabled 才启动拉取器）
type RechargeConfig struct {
	Enabled     bool                 `yaml:"enabled" json:"enabled"`
	GatewayName string               `yaml:"gateway_name" json:"gateway_name"` // 自报网关名（与 im-server 地址簿一致；空=回退 dbwrite.gateway_name 同名共用）
	IMAddr      string               `yaml:"im_addr" json:"im_addr"`           // im-server 拉取地址（http://host:2087）
	PollSec     int                  `yaml:"poll_sec" json:"poll_sec"`         // 拉取周期秒（默认 15，clamp 5~600）
	Games       []RechargeGameConfig `yaml:"games" json:"games"`
}

// rechargeDoneFile 本地已处理订单号落盘文件（幂等保险 1；工作目录相对）
const rechargeDoneFile = "recharge_done.json"

// rechargeDoneCap 落盘订单号上限（滚动裁剪最旧；正常业务量级远小于此）
const rechargeDoneCap = 10000

// rechargeAmountRe 到账数值二次校验（纯数字，最多 3 位小数——与 im-server aiPointsRound3 口径一致）
var rechargeAmountRe = regexp.MustCompile(`^\d+(\.\d{1,3})?$`)

// rechargeTemplateArgs 充值模板占位符白名单（compileSQLTemplate 共用归口）
var rechargeTemplateArgs = []string{"user", "amount", "order"}

// rechargeRunner 拉取器 + 执行器（独立 goroutine，绝不阻塞游戏数据转发）。
// 热重载语义：配置变更由 rechargeReload 构建全新 runner 原子替换，旧 runner stop 后退出关池——
// 替换边界内进行中的执行失败不回执自动重试，无损
type rechargeRunner struct {
	cfg      RechargeConfig
	secret   string // 与 im-server 共享的 token_secret（签名 + 响应解密同源）
	client   *http.Client
	stop     chan struct{}
	mu       sync.Mutex
	dbs      map[string]*sql.DB        // 游戏 ID → 连接池
	tpls     map[string]*dbwriteTemplate // 游戏 ID → 编译后模板
	done     map[uint64]bool           // 本地已处理订单号（幂等保险 1）
	donePath string
	warned   map[string]bool           // 未配置游戏告警去重（每游戏仅记一次，防长期刷屏）
}

// rechargeMgr 当前活跃 runner（nil=未启用）；Web 后台热更经 rechargeReload 原子替换
var rechargeMgr atomic.Pointer[rechargeRunner]

// rechargeGameKey 游戏 ID 键归一（配置与订单两侧同口径）
func rechargeGameKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// rechargeDoneLoad 落盘已处理订单号加载（文件缺失/损坏按空表起步——存储过程 {order} 幂等兜底）
func rechargeDoneLoad(path string) map[uint64]bool {
	done := map[uint64]bool{}
	b, err := os.ReadFile(path)
	if err != nil {
		return done
	}
	var raw struct {
		Done []uint64 `json:"done"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return done
	}
	for _, id := range raw.Done {
		if id > 0 {
			done[id] = true
		}
	}
	return done
}

// rechargeDoneSave 已处理订单号落盘（滚动裁剪最旧，防无限膨胀）；失败仅记日志（幂等保险 2 兜底）
func rechargeDoneSave(path string, done map[uint64]bool) {
	ids := make([]uint64, 0, len(done))
	for id := range done {
		ids = append(ids, id)
	}
	if len(ids) > rechargeDoneCap {
		// 升序排序后裁掉最旧（订单号自增，小=旧；sort 归口——容量 1 万时 O(n²) 插入排序会在
		// 持锁状态下做上亿次比较，实测级性能陷阱）
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		ids = ids[len(ids)-rechargeDoneCap:]
		drop := map[uint64]bool{}
		for _, id := range ids {
			drop[id] = true
		}
		for id := range done {
			if !drop[id] {
				delete(done, id)
			}
		}
	}
	b, err := json.Marshal(map[string]interface{}{"done": ids})
	if err != nil {
		return
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		log.Printf("[recharge] 已处理订单落盘失败（存储过程 {order} 幂等兜底仍有效）：%v", err)
	}
}

// startRecharge 充值链路启动归口（进程启动时调用一次）：enabled 且配置合法才启动；
// 配置/模板非法仅记日志不启动（隧道转发完全独立，不受影响）
func startRecharge(cfg *Config) {
	if !cfg.Recharge.Enabled {
		log.Printf("[recharge] 未启用（recharge.enabled=false），拉取器不启动")
		return
	}
	r, err := newRechargeRunner(cfg)
	if err != nil {
		log.Printf("[recharge] 未启动：%v", err)
		return
	}
	rechargeMgr.Store(r)
	log.Printf("[recharge] 拉取器已启动：目标=%s 游戏 %d 个 周期=%ds",
		strings.TrimRight(strings.TrimSpace(r.cfg.IMAddr), "/"), len(r.cfg.Games), r.cfg.PollSec)
	go r.loop()
}

// newRechargeRunner 配置校验 + runner 构建归口（启动与热更共用同一校验口径，热更绝不绕过）：
// 必填项/类型/模板编译在此拦截；DSN 连通性不在此阻断（写库失败自动重试，「测试连接」负责提前验证）
func newRechargeRunner(cfg *Config) (*rechargeRunner, error) {
	d := cfg.Recharge
	// 自报网关名归口：recharge 未单独配置时回退 dbwrite.gateway_name（同一台网关同名共用地址簿条目）
	if strings.TrimSpace(d.GatewayName) == "" {
		d.GatewayName = cfg.Dbwrite.GatewayName
	}
	d.GatewayName = strings.ToLower(strings.TrimSpace(d.GatewayName))
	if d.GatewayName == "" {
		return nil, errors.New("gateway_name 未配置（自报网关名，须与 im-server 地址簿一致）")
	}
	imAddr := strings.TrimRight(dbwriteAddrNorm(d.IMAddr), "/")
	d.IMAddr = imAddr // 规范化回写：落盘与拉取 URL 同源干净值
	d.PollSec = clampRechargePollSec(d.PollSec)
	if imAddr == "" {
		return nil, errors.New("im_addr 未配置")
	}
	if u, err := url.Parse(imAddr); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("im_addr 非法（须为完整 http://host:port 或 https://host，当前 %q）", imAddr)
	}
	if len(d.Games) == 0 {
		return nil, errors.New("games 未配置（至少一个游戏的 DSN+SQL）")
	}
	if len(d.Games) > 64 {
		return nil, errors.New("games 上限 64 个（防配置误植拖垮进程）")
	}
	r := &rechargeRunner{cfg: d, secret: cfg.TokenSecret,
		client: &http.Client{Timeout: 15 * time.Second}, stop: make(chan struct{}),
		dbs: map[string]*sql.DB{}, tpls: map[string]*dbwriteTemplate{},
		done: rechargeDoneLoad(rechargeDoneFile), donePath: rechargeDoneFile,
		warned: map[string]bool{}}
	seen := map[string]bool{}
	for _, g := range d.Games {
		key := rechargeGameKey(g.Game)
		if key == "" {
			r.closeAll()
			return nil, errors.New("存在 game 为空的条目（游戏 ID 必填，与 im-server 后台游戏 ID 一致）")
		}
		if seen[key] {
			r.closeAll()
			return nil, fmt.Errorf("游戏 %s 重复配置", key)
		}
		seen[key] = true
		g.Type = strings.ToLower(strings.TrimSpace(g.Type))
		if g.Type != "mysql" && g.Type != "mssql" && g.Type != "postgres" && g.Type != "sqlite" {
			r.closeAll()
			return nil, fmt.Errorf("游戏 %s 的 type 仅支持 mysql/mssql/postgres/sqlite（当前 %q）", key, g.Type)
		}
		if strings.TrimSpace(g.DSN) == "" {
			r.closeAll()
			return nil, fmt.Errorf("游戏 %s 的 dsn 未配置", key)
		}
		tpl, err := compileSQLTemplate(g.SQL, g.Type, rechargeTemplateArgs)
		if err != nil {
			r.closeAll()
			return nil, fmt.Errorf("游戏 %s 的 sql 非法：%v", key, err)
		}
		db, err := sql.Open(dbwriteDriverName(g.Type), strings.TrimSpace(g.DSN))
		if err != nil {
			r.closeAll()
			return nil, fmt.Errorf("游戏 %s 连接池创建失败：%v", key, err)
		}
		if g.Type == "sqlite" {
			db.SetMaxOpenConns(1)
			db.SetMaxIdleConns(1)
		} else {
			db.SetMaxOpenConns(2)
			db.SetMaxIdleConns(1)
		}
		db.SetConnMaxLifetime(5 * time.Minute)
		if err := db.Ping(); err != nil {
			log.Printf("[recharge] 游戏 %s 数据库暂时不可达（将继续重试）：%v", key, err)
		}
		r.dbs[key] = db
		r.tpls[key] = tpl
	}
	return r, nil
}

// clampRechargePollSec 拉取周期 clamp（默认 15，5~600）
func clampRechargePollSec(v int) int {
	if v <= 0 {
		return 15
	}
	if v < 5 {
		return 5
	}
	if v > 600 {
		return 600
	}
	return v
}

// closeAll 关闭 runner 全部连接池（校验中途失败清理归口）
func (r *rechargeRunner) closeAll() {
	for _, db := range r.dbs {
		_ = db.Close()
	}
}

// rechargeReload recharge 配置热更归口（Web 后台保存后调用）：
//   - enabled=true：校验并构建新 runner（非法返回错误，旧配置保持运行不受影响）→ 原子替换 → 起新 loop → 停旧
//   - enabled=false：停用拉取器（隧道转发完全独立，不受影响）
func rechargeReload(cfg *Config) error {
	if !cfg.Recharge.Enabled {
		if old := rechargeMgr.Swap(nil); old != nil {
			old.shutdown()
			log.Printf("[recharge] 已停用（后台热更）")
		}
		return nil
	}
	nr, err := newRechargeRunner(cfg)
	if err != nil {
		return err
	}
	old := rechargeMgr.Swap(nr)
	// 时序归口：先停旧再启新——旧 runner shutdown 后其当前 poll 执行完即退、不再拉取，
	// 新 loop 才开始首轮拉取。充值模板（如 gold=gold+{amount}）不可重入，若新旧 runner 并发
	// 执行同一 pending 订单即双倍加钱（dbwrite 的"双写幂等无害"对充值不成立，实测级陷阱）
	if old != nil {
		old.shutdown()
	}
	go nr.loop()
	if old != nil {
		log.Printf("[recharge] 配置热更生效：目标=%s 游戏 %d 个 周期=%ds",
			strings.TrimRight(strings.TrimSpace(nr.cfg.IMAddr), "/"), len(nr.cfg.Games), nr.cfg.PollSec)
	}
	return nil
}

// shutdown 停止 runner：关 stop 让 loop 退出 + 关全部连接池（进行中 Exec 完成后归还即关，无损）
func (r *rechargeRunner) shutdown() {
	select {
	case <-r.stop: // 已关闭
	default:
		close(r.stop)
	}
	r.closeAll()
}

// loop 拉取主循环（异常自恢复：panic 兜底不让充值链路拖垮进程；stop 关闭即退出支持热重载）
func (r *rechargeRunner) loop() {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[recharge] 充值链路异常退出（隧道转发不受影响）：%v\n%s", e, debug.Stack())
		}
	}()
	t := time.NewTicker(time.Duration(r.cfg.PollSec) * time.Second)
	defer t.Stop()
	r.poll() // 启动即拉一轮
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.poll()
		}
	}
}

// rechargeOrder 拉取响应条目（绝无 points/密码字段，见 im-server gamerecharge.go）；
// game_id/amount 用 json.Number 承接（im-server 下发数字字面量，转回无歧义十进制串参与校验）
type rechargeOrder struct {
	ID       uint64      `json:"id"`
	Username string      `json:"username"`
	GameID   json.Number `json:"game_id"`
	Amount   json.Number `json:"amount"`
}

// rechargeFailedItem ack 失败条目（网关明确报失败：im-server 即刻标 failed 退分，不等超时）
type rechargeFailedItem struct {
	ID     uint64 `json:"id"`
	Reason string `json:"reason"`
}

// poll 单轮：拉取 → 逐条执行 → 成功/明确失败条目回执
func (r *rechargeRunner) poll() {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("[recharge] 单轮异常（下轮重试）：%v\n%s", e, debug.Stack())
		}
	}()
	items, err := r.fetch()
	if err != nil {
		log.Printf("[recharge] 拉取失败（不回执，im-server 侧保持待写）：%v", err)
		return
	}
	if len(items) == 0 {
		return
	}
	var okIDs []uint64
	var failed []rechargeFailedItem
	for _, o := range items {
		key := rechargeGameKey(o.GameID.String())
		tpl := r.tpls[key]
		db := r.dbs[key]
		if tpl == nil || db == nil {
			// 未配置该游戏：不执行不 ack（im-server 侧 30 分钟超时自动退分，玩家无损）——
			// 绝不误写其他游戏库，也不让订单悬死重试；告警每游戏仅记一次（防 poll 周期刷屏）
			r.mu.Lock()
			first := !r.warned[key]
			r.warned[key] = true
			r.mu.Unlock()
			if first {
				log.Printf("[recharge] 订单 %d 游戏 %s 未配置 DSN/SQL，跳过（等待后台配置，此后同游戏告警静默）", o.ID, key)
			}
			continue
		}
		// 幂等保险 1：本地已处理（执行成功但 ack 丢失/进程重启重放）→ 直接补 ack 不再执行
		r.mu.Lock()
		already := r.done[o.ID]
		r.mu.Unlock()
		if already {
			okIDs = append(okIDs, o.ID)
			continue
		}
		// 数据侧二次校验（服务端已校验，防中间层异常数据带进 SQL）
		if o.Username == "" || len(o.Username) > 64 || !rechargeAmountRe.MatchString(o.Amount.String()) || o.ID == 0 {
			log.Printf("[recharge] 订单 %d 数据非法（username=%q amount=%q），跳过等待超时退分", o.ID, o.Username, o.Amount.String())
			continue
		}
		affected, err := r.execOne(db, tpl, o)
		if err != nil {
			// 不回执：下轮重试（连接抖动自愈）；持续失败由 im-server 30 分钟超时退分兜底
			log.Printf("[recharge] 订单 %d 执行失败（不回执，下轮重试）：%v", o.ID, err)
			continue
		}
		// UPDATE 影响 0 行 = 游戏账号不在库（语义性失败，重试无意义）→ 明确报失败即刻退分
		if affected == 0 && tpl.Kind == "update" {
			log.Printf("[recharge] 订单 %d 游戏账号 %s 不存在（UPDATE 影响 0 行），报失败退分", o.ID, o.Username)
			failed = append(failed, rechargeFailedItem{ID: o.ID, Reason: "游戏账号不存在（影响 0 行）"})
			continue
		}
		// 成功：先落盘再收集 ack（落盘在前——ack 丢失可补，反之不可）
		r.mu.Lock()
		r.done[o.ID] = true
		rechargeDoneSave(r.donePath, r.done)
		r.mu.Unlock()
		okIDs = append(okIDs, o.ID)
	}
	if len(okIDs) > 0 || len(failed) > 0 {
		if err := r.ack(okIDs, failed); err != nil {
			log.Printf("[recharge] 回执失败（成功条目已本地落盘，重放时直接补 ack）：%v", err)
		} else {
			log.Printf("[recharge] 本轮回执：成功 %d 条，失败 %d 条", len(okIDs), len(failed))
		}
	}
}

// execOne 参数化执行充值 SQL（占位符顺序取值，绝不字符串拼接）。返回影响行数
func (r *rechargeRunner) execOne(db *sql.DB, tpl *dbwriteTemplate, o rechargeOrder) (int64, error) {
	val := func(name string) string {
		switch name {
		case "user":
			return o.Username
		case "amount":
			return o.Amount.String()
		default: // order
			return strconv.FormatUint(o.ID, 10)
		}
	}
	args := make([]interface{}, 0, len(tpl.Args))
	for _, a := range tpl.Args {
		args = append(args, val(a))
	}
	res, err := db.Exec(tpl.SQL, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// fetch 拉取待执行订单（HMAC 签名请求 + 强制解密响应）
func (r *rechargeRunner) fetch() ([]rechargeOrder, error) {
	name := strings.ToLower(strings.TrimSpace(r.cfg.GatewayName))
	uri := "/internal/gateway/recharge?gw=" + url.QueryEscape(name)
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
		Items []rechargeOrder `json:"items"`
	}
	if err := json.Unmarshal(plain, &out); err != nil {
		return nil, fmt.Errorf("响应 JSON 解析失败：%v", err)
	}
	return out.Items, nil
}

// ack 回执（body 纳入签名：篡改 ok/failed 即验签失败）。failed 条目 im-server 侧即刻退分
func (r *rechargeRunner) ack(okIDs []uint64, failed []rechargeFailedItem) error {
	name := strings.ToLower(strings.TrimSpace(r.cfg.GatewayName))
	payload, _ := json.Marshal(map[string]interface{}{"gw": name, "ok": okIDs, "failed": failed})
	uri := "/internal/gateway/recharge/ack"
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
