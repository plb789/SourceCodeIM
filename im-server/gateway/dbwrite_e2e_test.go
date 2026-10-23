package main

// dbwrite 网关侧端到端测试：拉取器 ↔ 模拟 im-server（httptest，复用 gwproto 真协议签名/加密）
// + 写库执行器落真实 MySQL 临时表（TestMain 无库环境自动跳过）。覆盖 fetch 解密解析、
// ack body 与签名、execOne 三策略（insert / upsert 更新分支）与参数绑定逐字写入。

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"im-server/config"

	"im-server/gwproto"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

const e2eSecret = "e2e-test-secret"

func TestDbwriteEndToEnd(t *testing.T) {
	var ackBody atomic.Value
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/gateway/dbwrite", func(w http.ResponseWriter, r *http.Request) {
		if err := gwproto.VerifyAuth(e2eSecret, r.Header.Get(gwproto.AuthHeader), "GET", r.URL.RequestURI(), nil, time.Now()); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		plain, _ := json.Marshal(map[string]interface{}{"items": []map[string]interface{}{
			{"id": 7, "username": "e2e_user", "password": "3847798341565109"},
		}})
		enc, _ := gwproto.SealResp(e2eSecret, plain)
		w.Header().Set(gwproto.RespEncHeader, gwproto.RespEncVer)
		_, _ = w.Write([]byte(enc))
	})
	mux.HandleFunc("POST /internal/gateway/dbwrite/ack", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if err := gwproto.VerifyAuth(e2eSecret, r.Header.Get(gwproto.AuthHeader), "POST", r.URL.RequestURI(), b, time.Now()); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		ackBody.Store(string(b))
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := &dbwriteRunner{cfg: DbwriteConfig{Enabled: true, GatewayName: "GW-E2E", IMAddr: srv.URL,
		Type: "mysql", Strategy: "upsert"}, secret: e2eSecret, client: srv.Client(), last: map[string]string{}}

	// 1. fetch：签名请求 → 密文解密 → 条目解析
	items, err := r.fetch()
	if err != nil {
		t.Fatalf("fetch 失败：%v", err)
	}
	if len(items) != 1 || items[0].ID != 7 || items[0].Username != "e2e_user" || items[0].Password != "3847798341565109" {
		t.Fatalf("fetch 条目不符：%+v", items)
	}

	// 2. 写库执行（真实 MySQL 临时表；无库环境跳过）
	cfg := config.Load()
	db, err := sql.Open("mysql", cfg.MySQLDSN)
	if err != nil {
		t.Skipf("无 MySQL 环境，跳过写库段：%v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Skipf("MySQL 不可达，跳过写库段：%v", err)
	}
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS gw_dbwrite_e2e (account varchar(64) PRIMARY KEY, password varchar(64))"); err != nil {
		t.Fatalf("临时表创建失败：%v", err)
	}
	defer db.Exec("DROP TABLE gw_dbwrite_e2e")
	db.Exec("DELETE FROM gw_dbwrite_e2e WHERE account='e2e_user'")
	ins, err := compileDbwriteTemplate("INSERT INTO gw_dbwrite_e2e(account, password) VALUES({user}, {password})", "mysql")
	if err != nil {
		t.Fatalf("insert 模板编译失败：%v", err)
	}
	upd, err := compileDbwriteTemplate("UPDATE gw_dbwrite_e2e SET password={password} WHERE account={user}", "mysql")
	if err != nil {
		t.Fatalf("update 模板编译失败：%v", err)
	}
	r.db, r.ins, r.upd = db, ins, upd

	// upsert 首次：UPDATE 影响 0 行 → INSERT 兜底
	if err := r.execOne(items[0]); err != nil {
		t.Fatalf("upsert 写入失败：%v", err)
	}
	var got string
	if err := db.QueryRow("SELECT password FROM gw_dbwrite_e2e WHERE account='e2e_user'").Scan(&got); err != nil || got != "3847798341565109" {
		t.Fatalf("写入内容不符：got=%q err=%v", got, err)
	}
	// upsert 更新分支：密码变更 → UPDATE 命中，仍单行
	items[0].Password = "1111222233334444"
	if err := r.execOne(items[0]); err != nil {
		t.Fatalf("upsert 更新失败：%v", err)
	}
	var cnt int
	if err := db.QueryRow("SELECT COUNT(*) FROM gw_dbwrite_e2e WHERE account='e2e_user'").Scan(&cnt); err != nil || cnt != 1 {
		t.Fatalf("upsert 应保持单行，cnt=%d err=%v", cnt, err)
	}
	if err := db.QueryRow("SELECT password FROM gw_dbwrite_e2e WHERE account='e2e_user'").Scan(&got); err != nil || got != "1111222233334444" {
		t.Fatalf("更新后内容不符：got=%q err=%v", got, err)
	}

	// 3. ack：签名带 body、网关名小写归一
	if err := r.ack([]uint64{7, 8}); err != nil {
		t.Fatalf("ack 失败：%v", err)
	}
	if body, _ := ackBody.Load().(string); body != `{"gw":"gw-e2e","ids":[7,8]}` {
		t.Fatalf("ack body 不符：%s", body)
	}
}

// TestDbwriteSqliteExec SQLite（P2 驱动 modernc.org/sqlite，纯 Go 零 CGO）真实写库验证：
// 临时库文件跑「测试连接」+ upsert 插入/更新两分支 + 参数绑定逐字写入——零外部环境依赖必跑，
// 作为四类型支持的执行层回归锚点（postgres/mssql 方言由模板编译测试与映射测试覆盖）
func TestDbwriteSqliteExec(t *testing.T) {
	dir := t.TempDir()
	dsn := "file:" + filepath.ToSlash(filepath.Join(dir, "gamedb.db"))
	if err := dbwriteTestConn("sqlite", dsn); err != nil {
		t.Fatalf("sqlite 测试连接应成功：%v", err)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("sqlite 打开失败：%v", err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE members(account varchar(64) PRIMARY KEY, password varchar(64))"); err != nil {
		t.Fatalf("建表失败：%v", err)
	}
	ins, err := compileDbwriteTemplate("INSERT INTO members(account, password) VALUES({user}, {password})", "sqlite")
	if err != nil {
		t.Fatalf("insert 模板编译失败：%v", err)
	}
	upd, err := compileDbwriteTemplate("UPDATE members SET password={password} WHERE account={user}", "sqlite")
	if err != nil {
		t.Fatalf("update 模板编译失败：%v", err)
	}
	r := &dbwriteRunner{cfg: DbwriteConfig{Type: "sqlite", Strategy: "upsert"},
		db: db, ins: ins, upd: upd, last: map[string]string{}}
	// upsert 首次：UPDATE 零命中 → INSERT 兜底
	if err := r.execOne(dbwriteEntry{ID: 1, Username: "pg_user", Password: "1111222233334444"}); err != nil {
		t.Fatalf("upsert 写入失败：%v", err)
	}
	// upsert 更新分支：密码变更 → UPDATE 命中，仍单行
	if err := r.execOne(dbwriteEntry{ID: 1, Username: "pg_user", Password: "5555666677778888"}); err != nil {
		t.Fatalf("upsert 更新失败：%v", err)
	}
	var cnt int
	var got string
	if err := db.QueryRow("SELECT COUNT(*) FROM members WHERE account='pg_user'").Scan(&cnt); err != nil || cnt != 1 {
		t.Fatalf("upsert 应保持单行，cnt=%d err=%v", cnt, err)
	}
	if err := db.QueryRow("SELECT password FROM members WHERE account='pg_user'").Scan(&got); err != nil || got != "5555666677778888" {
		t.Fatalf("更新后内容不符：got=%q err=%v", got, err)
	}
}
