package main

// dbwrite 热重载与落盘测试：reload 校验拒绝（非法配置不破坏运行中 runner）、enabled 切换、
// gateway.yaml 落盘 round-trip（首次启用建键 / 已有节原位更新，注释保留）

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func reloadCfg(enabled bool, insertTpl string) *Config {
	return &Config{
		TokenSecret: "reload-test-secret",
		Dbwrite: DbwriteConfig{
			Enabled: enabled, GatewayName: "gw-reload", IMAddr: "http://127.0.0.1:2087",
			Type: "mysql", DSN: "u:p@tcp(127.0.0.1:3306)/gamedb", Strategy: "insert", PollSec: 5,
			SQLInsert: insertTpl,
		},
	}
}

// TestDbwriteDriverNames 四类型驱动注册存在性 + 映射归口断言：
// go-mssqldb 注册名是 sqlserver（非 mssql）、pgx stdlib 注册名是 pgx（非 postgres）——
// 映射错或驱动未编译进二进制时 sql.Open 即报 unknown driver（Open 不拨号，仅验证注册表，零外部环境必跑）
func TestDbwriteDriverNames(t *testing.T) {
	cases := map[string]string{ // 配置 type → 期望驱动注册名
		"mysql": "mysql", "mssql": "sqlserver", "postgres": "pgx", "sqlite": "sqlite",
	}
	for typ, driver := range cases {
		if got := dbwriteDriverName(typ); got != driver {
			t.Fatalf("type %s 应映射到驱动 %s，实得 %s", typ, driver, got)
		}
		db, err := sql.Open(driver, "") // 空 DSN：仅验证驱动已注册（不拨号）
		if err != nil {
			t.Fatalf("驱动 %s（type=%s）未注册或打开失败：%v", driver, typ, err)
		}
		db.Close()
	}
	// 非法 type 走 default 同名（白名单在 newDbwriteRunner/dbwriteTestConn 拦截，此处仅确认映射不 panic）
	if got := dbwriteDriverName("oracle"); got != "oracle" {
		t.Fatalf("未知名应原样透传，实得 %s", got)
	}
}

// TestDbwriteAddrNorm im_addr 规范化（实测用户手填两类格式错误带进运行期）：
// Markdown 反引号包裹（`http://…` → URL 整串带引号解析超时）、scheme 缺 //（http:1.2.3.4 → no Host）；
// 正常值原样、畸形值由 newDbwriteRunner 拒绝保存
func TestDbwriteAddrNorm(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"http://1.2.3.4:2087", "http://1.2.3.4:2087"},     // 正常值原样
		{"`http://1.2.3.4:2087`", "http://1.2.3.4:2087"},   // Markdown 反引号剥离
		{"  http://1.2.3.4:2087  ", "http://1.2.3.4:2087"}, // 首尾空白
		{"http:1.2.3.4:2087", "http://1.2.3.4:2087"},       // scheme 缺 // 补全
		{"https:im.sxgyxny.com", "https://im.sxgyxny.com"}, // https 同款补全
		{"\"http://1.2.3.4:2087\"", "http://1.2.3.4:2087"}, // 双引号剥离
		{"`http://1.2.3.4:2087` ", "http://1.2.3.4:2087"},  // 反引号+空格混合
		{"http://1.2.3.4:2087/", "http://1.2.3.4:2087/"},   // 尾斜杠保留（TrimRight 在调用方）
	}
	for _, c := range cases {
		if got := dbwriteAddrNorm(c.in); got != c.want {
			t.Fatalf("dbwriteAddrNorm(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
	// 畸形值（无法清洗）经 runner 校验拒绝：im_addr 带非法 scheme
	cfg := reloadCfg(true, "INSERT INTO t VALUES ({user},{password})")
	cfg.Dbwrite.IMAddr = "ftp://1.2.3.4"
	if _, err := newDbwriteRunner(cfg); err == nil || !strings.Contains(err.Error(), "im_addr 非法") {
		t.Fatalf("非法 scheme 应被拒绝且提示 im_addr 非法，实得 err=%v", err)
	}
}

func TestDbwriteReloadLifecycle(t *testing.T) {
	t.Cleanup(func() { // 测试结束清理全局 runner
		if old := dbwriteMgr.Swap(nil); old != nil {
			old.shutdown()
		}
	})
	if old := dbwriteMgr.Swap(nil); old != nil {
		old.shutdown() // 清理其他测试可能残留的 runner
	}

	// 1. 首次启用（合法配置）→ runner 建立
	if err := dbwriteReload(reloadCfg(true, "INSERT INTO t(a) VALUES({user})")); err != nil {
		t.Fatalf("合法配置应热更成功：%v", err)
	}
	r1 := dbwriteMgr.Load()
	if r1 == nil {
		t.Fatal("启用后应有活跃 runner")
	}

	// 2. 非法模板 reload → 拒绝且运行中 runner 原封不动（旧配置继续拉取）
	if err := dbwriteReload(reloadCfg(true, "DELETE FROM t")); err == nil {
		t.Fatal("非法模板应被拒绝")
	}
	if dbwriteMgr.Load() != r1 {
		t.Fatal("非法配置被拒后 runner 应保持不变")
	}
	// 2.5 非法 type reload → 拒绝（四类型白名单 mysql/mssql/postgres/sqlite）
	badType := reloadCfg(true, "INSERT INTO t(a) VALUES({user})")
	badType.Dbwrite.Type = "oracle"
	if err := dbwriteReload(badType); err == nil {
		t.Fatal("非法 type 应被拒绝")
	}
	if dbwriteMgr.Load() != r1 {
		t.Fatal("非法 type 被拒后 runner 应保持不变")
	}

	// 3. 合法变更 reload → runner 替换（新模板生效）
	if err := dbwriteReload(reloadCfg(true, "INSERT INTO t2(b) VALUES({password})")); err != nil {
		t.Fatalf("合法变更应热更成功：%v", err)
	}
	r2 := dbwriteMgr.Load()
	if r2 == nil || r2 == r1 {
		t.Fatal("合法变更应替换为新 runner")
	}
	if r2.ins == nil || r2.ins.SQL != "INSERT INTO t2(b) VALUES(?)" {
		t.Fatalf("新模板应已编译生效：%v", r2.ins)
	}

	// 4. 停用 → runner 摘除（隧道转发不受影响，此处仅验证管理器状态）
	if err := dbwriteReload(reloadCfg(false, "")); err != nil {
		t.Fatalf("停用应成功：%v", err)
	}
	if dbwriteMgr.Load() != nil {
		t.Fatal("停用后应无活跃 runner")
	}
}

func TestSaveDbwriteYAMLRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gateway.yaml")
	base := "# 网关配置\n# 顶部说明注释\ntoken_secret: \"abc\"\nlisten_tcp: \"0.0.0.0:30100\"\nallow_targets: [3054]\n"
	if err := os.WriteFile(path, []byte(base), 0600); err != nil {
		t.Fatal(err)
	}
	d1 := DbwriteConfig{Enabled: true, GatewayName: "GW-Reload", IMAddr: "http://im:2087/",
		Type: "mysql", DSN: "u:p@tcp(127.0.0.1:3306)/gamedb", Strategy: "upsert", PollSec: 45,
		SQLInsert: "INSERT INTO members(account, password) VALUES({user}, {password})",
		SQLUpdate: "UPDATE members SET password={password} WHERE account={user}"}
	// 首次启用：无 dbwrite 节 → 追加
	if err := saveDbwriteYAML(path, &d1); err != nil {
		t.Fatalf("首次落盘失败：%v", err)
	}
	raw, _ := os.ReadFile(path)
	for _, want := range []string{"dbwrite:", "gateway_name: GW-Reload", "poll_sec: 45", "token_secret:", "allow_targets:"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("落盘内容缺 %q：\n%s", want, raw)
		}
	}
	// 二次更新：已存在节 → 原位改值（追加不重复）
	d2 := d1
	d2.Strategy = "update"
	d2.PollSec = 60
	if err := saveDbwriteYAML(path, &d2); err != nil {
		t.Fatalf("更新落盘失败：%v", err)
	}
	raw2, _ := os.ReadFile(path)
	if n := strings.Count(string(raw2), "gateway_name:"); n != 1 {
		t.Fatalf("重复落盘应原位更新而非追加键，gateway_name 出现 %d 次", n)
	}
	if !strings.Contains(string(raw2), "strategy: update") || !strings.Contains(string(raw2), "poll_sec: 60") {
		t.Fatalf("更新值未写入：\n%s", raw2)
	}
	// 注释保留（顶部说明未丢）
	if !strings.Contains(string(raw2), "# 顶部说明注释") {
		t.Fatalf("落盘丢失原注释：\n%s", raw2)
	}
}
