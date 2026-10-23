package main

// dbwrite 模板编译单测：合法矩阵 + 注入形态拒绝矩阵（网关开发文档 §4 白名单）

import (
	"strings"
	"testing"
)

func TestCompileTemplateOK(t *testing.T) {
	// mysql 方言：占位符按出现顺序转 ?
	tp, err := compileDbwriteTemplate("INSERT INTO members(account, password) VALUES({user}, {password})", "mysql")
	if err != nil {
		t.Fatalf("合法 INSERT 模板应通过：%v", err)
	}
	if tp.SQL != "INSERT INTO members(account, password) VALUES(?, ?)" {
		t.Fatalf("mysql SQL 转换不符：%s", tp.SQL)
	}
	if strings.Join(tp.Args, ",") != "user,password" {
		t.Fatalf("参数顺序不符：%v", tp.Args)
	}
	// mssql 方言：@p1/@p2
	tp, err = compileDbwriteTemplate("UPDATE members SET password={password} WHERE account={user}", "mssql")
	if err != nil {
		t.Fatalf("合法 UPDATE 模板应通过：%v", err)
	}
	if tp.SQL != "UPDATE members SET password=@p1 WHERE account=@p2" {
		t.Fatalf("mssql SQL 转换不符：%s", tp.SQL)
	}
	// postgres 方言：$1/$2（P2 驱动 pgx stdlib）
	tp, err = compileDbwriteTemplate("INSERT INTO members(account, password) VALUES({user}, {password})", "postgres")
	if err != nil {
		t.Fatalf("合法 postgres 模板应通过：%v", err)
	}
	if tp.SQL != "INSERT INTO members(account, password) VALUES($1, $2)" {
		t.Fatalf("postgres SQL 转换不符：%s", tp.SQL)
	}
	// sqlite 方言：与 mysql 同为 ?（P2 驱动 modernc.org/sqlite）
	tp, err = compileDbwriteTemplate("INSERT INTO members(account, password) VALUES({user}, {password})", "sqlite")
	if err != nil {
		t.Fatalf("合法 sqlite 模板应通过：%v", err)
	}
	if tp.SQL != "INSERT INTO members(account, password) VALUES(?, ?)" {
		t.Fatalf("sqlite SQL 转换不符：%s", tp.SQL)
	}
	// 尾分号合法（唯一豁免）
	if _, err = compileDbwriteTemplate("INSERT INTO t(a) VALUES({user});", "mysql"); err != nil {
		t.Fatalf("尾分号应豁免：%v", err)
	}
	// 大小写不敏感语句头
	if _, err = compileDbwriteTemplate("insert into t(a) values({user})", "mysql"); err != nil {
		t.Fatalf("小写 insert 应通过：%v", err)
	}
	// 重复占位符（同参数多列）
	tp, err = compileDbwriteTemplate("INSERT INTO t(a,b) VALUES({user}, {user})", "mysql")
	if err != nil || len(tp.Args) != 2 {
		t.Fatalf("重复占位符应通过且各占一参：err=%v args=%v", err, tp.Args)
	}
	// —— 存储过程/合并语句白名单（Kind 归口） ——
	// MySQL CALL：模板占位符编译 + Kind=call
	tp, err = compileDbwriteTemplate("CALL upsert_member({user}, {password})", "mysql")
	if err != nil || tp.Kind != "call" {
		t.Fatalf("CALL 应通过且 Kind=call：err=%v kind=%s", err, tp.Kind)
	}
	if tp.SQL != "CALL upsert_member(?, ?)" {
		t.Fatalf("CALL 参数符转换不符：%s", tp.SQL)
	}
	// MSSQL EXEC：Kind=exec，@p 方言
	tp, err = compileDbwriteTemplate("EXEC upsert_member {user}, {password}", "mssql")
	if err != nil || tp.Kind != "exec" || tp.SQL != "EXEC upsert_member @p1, @p2" {
		t.Fatalf("EXEC 应通过且 Kind=exec @p 方言：err=%v kind=%s sql=%s", err, tp.Kind, tp.SQL)
	}
	// EXECUTE 全称：Kind=execute
	tp, err = compileDbwriteTemplate("EXECUTE upsert_member {user}", "mssql")
	if err != nil || tp.Kind != "execute" {
		t.Fatalf("EXECUTE 应通过且 Kind=execute：err=%v kind=%s", err, tp.Kind)
	}
	// MERGE（MSSQL 形态，尾分号豁免）：Kind=merge
	tp, err = compileDbwriteTemplate("MERGE INTO members WITH (HOLDLOCK) AS t USING (SELECT {user} AS account) AS s ON t.account = s.account WHEN MATCHED THEN UPDATE SET password = {password} WHEN NOT MATCHED THEN INSERT (account, password) VALUES ({user}, {password});", "mssql")
	if err != nil || tp.Kind != "merge" {
		t.Fatalf("MERGE 应通过且 Kind=merge：err=%v kind=%s", err, tp.Kind)
	}
	// PG MERGE（15+）
	if _, err = compileDbwriteTemplate("MERGE INTO members t USING (SELECT {user} AS account) s ON t.account = s.account WHEN MATCHED THEN UPDATE SET password = {password}", "postgres"); err != nil {
		t.Fatalf("PG MERGE 应通过：%v", err)
	}
	// 旧 Kind 回归：insert/update
	if tp, err = compileDbwriteTemplate("INSERT INTO t(a) VALUES({user})", "mysql"); err != nil || tp.Kind != "insert" {
		t.Fatalf("INSERT Kind 应为 insert：err=%v kind=%s", err, tp.Kind)
	}
}

func TestCompileTemplateRejects(t *testing.T) {
	cases := map[string]string{
		"空模板":            "",
		"DELETE 语句":      "DELETE FROM members WHERE account={user}",
		"DROP 语句":        "DROP TABLE members",
		"UPDATE 大写后无白名单": "TRUNCATE TABLE members",
		"多语句":            "INSERT INTO t(a) VALUES({user}); DROP TABLE members",
		"行内注释":           "INSERT INTO t(a) VALUES({user}) -- hack",
		"块注释":            "INSERT /* hack */ INTO t(a) VALUES({user})",
		"未知占位符":          "INSERT INTO t(a,b) VALUES({user}, {token})",
		"大写占位符残留":        "INSERT INTO t(a) VALUES({User})",
		"花括号残留":          "INSERT INTO t(a) VALUES({user}) {{{",
		"无占位符":           "INSERT INTO t(a) VALUES('x')",
		"SELECT 语句":      "SELECT * FROM members WHERE account={user}",
		"ALTER 语句":       "ALTER TABLE members ADD col int",
	}
	for name, tpl := range cases {
		if _, err := compileDbwriteTemplate(tpl, "mysql"); err == nil {
			t.Fatalf("[%s] 应被拒绝：%s", name, tpl)
		}
	}
}
