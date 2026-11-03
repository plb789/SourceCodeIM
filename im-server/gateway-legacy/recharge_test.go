package main

// 积分兑换充值链路单元测试（纯本地，无外部依赖）：模板编译白名单、数值校验、
// 已处理订单落盘幂等往返、runner 配置校验（sqlite 内存库验证构建主路径）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRechargeTemplateCompile(t *testing.T) {
	// 合法模板：三占位符全用（mysql → 顺序 ?）
	tp, err := compileSQLTemplate("UPDATE members SET gold=gold+{amount} WHERE account={user}", "mysql", rechargeTemplateArgs)
	if err != nil {
		t.Fatalf("合法模板编译失败：%v", err)
	}
	if tp.SQL != "UPDATE members SET gold=gold+? WHERE account=?" || len(tp.Args) != 2 || tp.Args[0] != "amount" || tp.Args[1] != "user" {
		t.Fatalf("编译结果不符：%s %v", tp.SQL, tp.Args)
	}
	// mssql 方言参数符
	if tp, err = compileSQLTemplate("CALL recharge_gold({user}, {amount}, {order})", "mssql", rechargeTemplateArgs); err != nil {
		t.Fatalf("mssql 模板编译失败：%v", err)
	}
	if tp.SQL != "CALL recharge_gold(@p1, @p2, @p3)" {
		t.Fatalf("mssql 参数符不符：%s", tp.SQL)
	}
	// {password} 在充值模板中禁止（充值链路无密码语义）
	if _, err = compileSQLTemplate("UPDATE t SET p={password} WHERE a={user}", "mysql", rechargeTemplateArgs); err == nil || !strings.Contains(err.Error(), "未知占位符") {
		t.Fatalf("{password} 应被拒绝，实得 %v", err)
	}
	// 多语句/注释/SELECT 开头拒绝
	if _, err = compileSQLTemplate("UPDATE t SET a={amount} WHERE b={user}; DROP TABLE t", "mysql", rechargeTemplateArgs); err == nil {
		t.Fatal("多语句应拒绝")
	}
	if _, err = compileSQLTemplate("UPDATE t SET a={amount} -- note", "mysql", rechargeTemplateArgs); err == nil {
		t.Fatal("注释应拒绝")
	}
	if _, err = compileSQLTemplate("SELECT 1", "mysql", rechargeTemplateArgs); err == nil {
		t.Fatal("SELECT 开头应拒绝")
	}
	// CALL 类 Kind 标记（charge 语义性失败判定只用 update，但 Kind 须正确落定）
	if tp, err = compileSQLTemplate("EXEC up {user},{amount},{order}", "mssql", rechargeTemplateArgs); err != nil || tp.Kind != "exec" {
		t.Fatalf("EXEC Kind 不符：%v %v", tp, err)
	}
}

func TestRechargeAmountRe(t *testing.T) {
	ok := []string{"0", "100", "999.99", "0.5", "123456789012"}
	for _, v := range ok {
		if !rechargeAmountRe.MatchString(v) {
			t.Fatalf("%q 应合法", v)
		}
	}
	bad := []string{"", "-1", "1e3", "0x10", "1.2345", "abc", "1;drop", " 1", "1 "}
	for _, v := range bad {
		if rechargeAmountRe.MatchString(v) {
			t.Fatalf("%q 应非法", v)
		}
	}
}

func TestRechargeDoneRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "done.json")
	// 空文件起步
	if done := rechargeDoneLoad(path); len(done) != 0 {
		t.Fatalf("缺失文件应空表：%v", done)
	}
	// 写入往返
	done := map[uint64]bool{1: true, 42: true, 0: true} // 0 号应被过滤
	rechargeDoneSave(path, done)
	loaded := rechargeDoneLoad(path)
	if !loaded[1] || !loaded[42] || loaded[0] || len(loaded) != 2 {
		t.Fatalf("落盘往返不符：%v", loaded)
	}
	// 损坏文件按空表起步（存储过程幂等兜底）
	os.WriteFile(path, []byte("not-json"), 0600)
	if done := rechargeDoneLoad(path); len(done) != 0 {
		t.Fatalf("损坏文件应空表：%v", done)
	}
	// 滚动裁剪：超 cap 保留最新（订单号大=新）
	big := map[uint64]bool{}
	for i := uint64(1); i <= rechargeDoneCap+10; i++ {
		big[i] = true
	}
	rechargeDoneSave(path, big)
	loaded = rechargeDoneLoad(path)
	if len(loaded) != rechargeDoneCap {
		t.Fatalf("裁剪后应恰 %d 条，实得 %d", rechargeDoneCap, len(loaded))
	}
	if loaded[1] || !loaded[rechargeDoneCap+10] {
		t.Fatal("裁剪应保留最新订单号（丢弃最旧）")
	}
}

func TestNewRechargeRunnerValidate(t *testing.T) {
	base := func() *Config {
		return &Config{TokenSecret: "test-secret", Dbwrite: DbwriteConfig{GatewayName: "gw-x"}}
	}
	// gateway_name 缺失（recharge 与 dbwrite 均空 → 无兜底，拒绝启动）
	cfg := &Config{TokenSecret: "test-secret"}
	cfg.Recharge = RechargeConfig{Enabled: true, IMAddr: "http://127.0.0.1:2087", Games: []RechargeGameConfig{{Game: "1", Type: "sqlite", DSN: "file::memory:", SQL: "UPDATE t SET g=g+{amount} WHERE a={user}"}}}
	if _, err := newRechargeRunner(cfg); err == nil || !strings.Contains(err.Error(), "gateway_name") {
		t.Fatalf("缺 gateway_name 应报错，实得 %v", err)
	}
	// dbwrite 兜底主路径：recharge 未配 gateway_name 时回退 dbwrite（sqlite 内存库构建成功）
	cfg = base()
	cfg.Recharge = RechargeConfig{Enabled: true, IMAddr: "http://127.0.0.1:2087", Games: []RechargeGameConfig{{Game: "1", Type: "sqlite", DSN: "file::memory:", SQL: "UPDATE t SET g=g+{amount} WHERE a={user}"}}}
	r, err := newRechargeRunner(cfg)
	if err != nil {
		t.Fatalf("合法配置构建失败：%v", err)
	}
	if r.cfg.GatewayName != "gw-x" || r.cfg.PollSec != 15 {
		t.Fatalf("兜底网关名/默认周期不符：%s %d", r.cfg.GatewayName, r.cfg.PollSec)
	}
	r.shutdown()
	// 游戏重复配置拒绝
	cfg = base()
	cfg.Recharge = RechargeConfig{Enabled: true, GatewayName: "gw-x", IMAddr: "http://127.0.0.1:2087",
		Games: []RechargeGameConfig{{Game: "1", Type: "sqlite", DSN: "file::memory:", SQL: "UPDATE t SET g={amount}"},
			{Game: "1", Type: "sqlite", DSN: "file::memory:", SQL: "UPDATE t SET g={amount}"}}}
	if _, err := newRechargeRunner(cfg); err == nil || !strings.Contains(err.Error(), "重复") {
		t.Fatalf("重复游戏应报错，实得 %v", err)
	}
	// 非法类型 / 非法模板 / 缺 DSN 拒绝
	cfg = base()
	cfg.Recharge = RechargeConfig{Enabled: true, GatewayName: "gw-x", IMAddr: "http://127.0.0.1:2087",
		Games: []RechargeGameConfig{{Game: "1", Type: "oracle", DSN: "x", SQL: "UPDATE t SET g={amount}"}}}
	if _, err := newRechargeRunner(cfg); err == nil || !strings.Contains(err.Error(), "type") {
		t.Fatalf("非法类型应报错，实得 %v", err)
	}
	cfg.Recharge.Games[0].Type = "mysql"
	cfg.Recharge.Games[0].DSN = "   " // 仅空白：TrimSpace 后视为未配置
	if _, err := newRechargeRunner(cfg); err == nil || !strings.Contains(err.Error(), "dsn") {
		t.Fatalf("缺 DSN 应报错，实得 %v", err)
	}
	cfg.Recharge.Games[0].DSN = "root:pw@tcp(127.0.0.1:3306)/db"
	cfg.Recharge.Games[0].SQL = "DELETE FROM t WHERE a={user}"
	if _, err := newRechargeRunner(cfg); err == nil {
		t.Fatal("DELETE 模板应拒绝")
	}
}
