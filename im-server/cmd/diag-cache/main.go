// diag-cache - 远端 Redis 缓存诊断工具
// 编译: go build -o diag-cache.exe ./cmd/diag-cache/
// 使用: ./diag-cache.exe (自动找 bin/config.yaml)
// 依赖: go.mod 已包含 go-redis/v9
package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"im-server/config"
	"im-server/store"
)

func main() {
	fmt.Println("=== IM-Server 缓存诊断工具 ===")
	fmt.Println()

	// 1. 加载配置（自动找 config.yaml / bin/config.yaml）
	cfg := config.Load()
	fmt.Printf("[OK] 配置加载成功\n")
	fmt.Printf("     Redis: %s db=%d pass=%v\n", cfg.RedisAddr, cfg.RedisDB, cfg.RedisPassword != "")
	fmt.Println()

	// 2. InitRedis + Ping
	fmt.Println("--- Redis 连通性检测 ---")
	if err := store.InitRedis(cfg); err != nil {
		fmt.Printf("[FAIL] InitRedis 失败: %v\n", err)
		fmt.Println("       → 检查 redis_addr/redis_password/redis_db")
		fmt.Println("       → 检查网络可达（防火墙/安全组）")
		os.Exit(1)
	}
	fmt.Println("[OK] Redis Init 成功")

	if !store.RedisAvailable() {
		fmt.Println("[FAIL] RedisAvailable() 返回 false")
		os.Exit(1)
	}
	fmt.Println("[OK] RedisAvailable() = true")
	fmt.Println()

	// 3. 查 im:game:* 缓存 key
	fmt.Println("--- im:game:* 缓存 key ---")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var allKeys []string
	var cursor uint64
	for {
		keys, next, err := store.RDB.Scan(ctx, cursor, "im:game:*", 100).Result()
		if err != nil {
			fmt.Printf("[FAIL] SCAN 失败: %v\n", err)
			break
		}
		allKeys = append(allKeys, keys...)
		cursor = next
		if cursor == 0 {
			break
		}
	}

	if len(allKeys) == 0 {
		fmt.Println("[WARN] Redis 中没有 im:game:* 缓存 key！")
		fmt.Println()
		fmt.Println("  可能原因：")
		fmt.Println("    1. exe 不是 2026-11-14 之后编译的（没 manifestCache 代码）")
		fmt.Println("    2. 没人点过「加入库/安装」触发缓存构建")
		fmt.Println("    3. 测试的游戏 DownloadMethod=2（BT 上传种子不走缓存）")
		fmt.Println("    4. 远端 im-server 没重启（新代码未生效）")
	} else {
		sort.Strings(allKeys)
		fmt.Printf("[OK] 找到 %d 个 key:\n", len(allKeys))
		for _, k := range allKeys {
			ttl, _ := store.RDB.TTL(ctx, k).Result()
			var val string
			if strings.HasPrefix(k, store.KeyGameManifest) {
				v, _ := store.RDB.Get(ctx, k).Result()
				if len(v) > 150 {
					val = v[:150] + "..."
				} else {
					val = v
				}
			} else if strings.HasPrefix(k, store.KeyGameDelta) {
				n, _ := store.RDB.Get(ctx, k).Result()
				val = n + " bytes (delta)"
			} else {
				val = "(其他类型)"
			}
			fmt.Printf("  %-55s TTL=%-7s %s\n", k, ttl.String(), val)
		}
	}
	fmt.Println()

	// 4. Redis 总体概览
	fmt.Println("--- Redis DB2 概览 ---")
	dbsize, _ := store.RDB.DBSize(ctx).Result()
	fmt.Printf("  DB2 总 key 数: %d\n", dbsize)
	used, _ := store.RDB.Info(ctx, "memory").Result()
	for _, line := range strings.Split(used, "\r\n") {
		if strings.HasPrefix(line, "used_memory_human") {
			fmt.Println("  " + line)
		}
	}

	fmt.Println()
	fmt.Println("=== 诊断完成 ===")
}
