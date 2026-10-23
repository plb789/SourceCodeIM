package main

import (
	"database/sql"
	"fmt"

	_ "github.com/microsoft/go-mssqldb"
)

func try(name, dsn string, query bool) {
	db, err := sql.Open("sqlserver", dsn)
	if err != nil {
		fmt.Printf("[%s] OPEN-FAIL: %v\n", name, err)
		return
	}
	defer db.Close()
	if !query {
		fmt.Printf("[%s] OPEN-OK（TLS 协商通过，未实际查询）\n", name)
		return
	}
	var ver string
	if err := db.QueryRow("SELECT @@VERSION").Scan(&ver); err != nil {
		fmt.Printf("[%s] QUERY-FAIL: %v\n", name, err)
		return
	}
	var one int
	if err := db.QueryRow("SELECT 1").Scan(&one); err != nil {
		fmt.Printf("[%s] QUERY-FAIL: %v\n", name, err)
		return
	}
	fmt.Printf("[%s] QUERY-OK: %s\n", name, ver)
}

func main() {
	// 1. 默认（加密协商）——预期：若本机 SQL Server 仅支持 TLS1.0 则复现用户的 TLS 错误
	try("A 默认加密协商   ", "sqlserver://127.0.0.1?Trusted_Connection=yes", false)
	// 2. encrypt=disable（跳过 TLS）+ 集成认证真实查询
	try("B encrypt=disable", "server=127.0.0.1;Trusted_Connection=yes;encrypt=disable", true)
}
