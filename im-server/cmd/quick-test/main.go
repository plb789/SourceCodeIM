// quick-test - 最短路径测 manifest 缓存
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"im-server/config"
	"im-server/server"
	"im-server/store"
)

func main() {
	cfg := config.Load()
	_ = store.InitRedis(cfg)
	_ = store.InitMySQL(cfg)

	token := server.DriveTokenIssue("admin")
	fmt.Printf("Token=%s\n\n", token)

	client := &http.Client{Timeout: 15 * time.Second}

	// 先加入库（manifest 接口要求）
	joinURL := "http://127.0.0.1:2087/api/game/library/1?username=admin"
	joinReq, _ := http.NewRequest("POST", joinURL, nil)
	joinReq.Header.Set("X-Drive-Token", token)
	joinResp, _ := client.Do(joinReq)
	joinBody, _ := io.ReadAll(joinResp.Body)
	joinResp.Body.Close()
	fmt.Printf("加入库: HTTP %d  %s\n\n", joinResp.StatusCode, string(joinBody[:min(100, len(joinBody))]))

	url := "http://127.0.0.1:2087/api/game/manifest/1?username=admin"
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-Drive-Token", token)

	for i := 1; i <= 3; i++ {
		t0 := time.Now()
		resp, err := client.Do(req)
		d := time.Since(t0)
		if err != nil {
			fmt.Printf("req %d ERR: %v\n", i, err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		snippet := ""
		if len(body) > 0 {
			snippet = string(body[:min(120, len(body))])
		}
		fmt.Printf("req %d: HTTP %d  %.2fms  len=%d\n  body=%s\n",
			i, resp.StatusCode, float64(d.Microseconds())/1000, len(body), snippet)
	}

	fmt.Println("\nRedis im:game:* keys:")
	if store.RedisAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		keys, _, _ := store.RDB.Scan(ctx, 0, "im:game:*", 100).Result()
		if len(keys) == 0 {
			fmt.Println("  NONE ❌ 缓存没写入 Redis")
		} else {
			for _, k := range keys {
				ttl, _ := store.RDB.TTL(ctx, k).Result()
				fmt.Printf("  ✅ %s  TTL=%s\n", k, ttl)
			}
		}
	} else {
		fmt.Println("  Redis 不可用 → 进程内缓存")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
