// curl-game - 本机直接测试 gameManifest 缓存链路
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"time"

	"im-server/config"
	"im-server/model"
	"im-server/server"
	"im-server/store"
)

func main() {
	cfg := config.Load()
	fmt.Println("=== 初始化 Redis + MySQL ===")
	_ = store.InitRedis(cfg)
	if err := store.InitMySQL(cfg); err != nil {
		fmt.Printf("  [FAIL] MySQL 连接失败: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("  [OK] 就绪")

	// AutoMigrate
	fmt.Println("\n=== AutoMigrate 表 ===")
	store.DB.AutoMigrate(&model.Game{}, &model.GameVersion{}, &model.GameFile{})
	fmt.Println("  [OK]")

	// 查游戏
	var games []model.Game
	store.DB.Where("deleted_at IS NULL").Find(&games)
	fmt.Printf("\n=== 游戏列表 (%d 个) ===\n", len(games))
	if len(games) == 0 {
		fmt.Println("  造测试数据...")
		seedTestData()
		store.DB.Find(&games)
	}
	for _, g := range games {
		var vc int64
		store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Count(&vc)
		fmt.Printf("  ID=%d  DM=%d  versions=%d  %s\n", g.ID, g.DownloadMethod, vc, g.Name)
	}

	// 选一个 DM != 2 且有版本的
	var targetGameID uint
	for _, g := range games {
		if g.DownloadMethod != 2 {
			var vc int64
			store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Count(&vc)
			if vc > 0 {
				targetGameID = g.ID
				break
			}
		}
	}
	if targetGameID == 0 {
		fmt.Println("\n[WARN] 找不到 DM!=2 且有版本的游戏")
		os.Exit(0)
	}
	fmt.Printf("\n选游戏 ID=%d\n", targetGameID)

	token := server.DriveTokenIssue("admin")
	fmt.Printf("Token: %s...\n", token[:25])

	url := fmt.Sprintf("http://127.0.0.1:2087/api/game/manifest/%d?username=admin", targetGameID)
	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-Drive-Token", token)

	fmt.Println("\n=== 第 1 次请求 (预期 MISS → 慢) ===")
	t0 := time.Now()
	r1, _ := client.Do(req)
	d1 := time.Since(t0)
	b1, _ := io.ReadAll(r1.Body)
	r1.Body.Close()
	fmt.Printf("  HTTP %d  耗时 %v  len=%d\n", r1.StatusCode, d1, len(b1))

	fmt.Println("\n=== 第 2 次请求 (预期 HIT → 快) ===")
	t0 = time.Now()
	r2, _ := client.Do(req)
	d2 := time.Since(t0)
	b2, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	fmt.Printf("  HTTP %d  耗时 %v  len=%d\n", r2.StatusCode, d2, len(b2))

	if d2 < 500*time.Millisecond {
		fmt.Println("  ✅ 第二次 < 500ms → 缓存命中！")
	} else if d2 < 2*time.Second {
		fmt.Println("  ⚠️ 第二次 500ms-2s → 不确定，看服务端日志")
	} else {
		fmt.Println("  ❌ 第二次仍 > 2s → 缓存没命中")
	}

	// 查 Redis
	fmt.Println("\n=== Redis im:game:* ===")
	if store.RedisAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var keys []string
		var cur uint64
		for {
			k, next, _ := store.RDB.Scan(ctx, cur, "im:game:*", 100).Result()
			keys = append(keys, k...)
			cur = next
			if cur == 0 {
				break
			}
		}
		if len(keys) == 0 {
			fmt.Println("  ❌ Redis 没有任何 im:game:* key")
			fmt.Println("     → 说明服务端 exe 可能不是最新版，或请求没走到 gameManifest")
		} else {
			sort.Strings(keys)
			fmt.Printf("  ✅ 找到 %d 个 key:\n", len(keys))
			for _, k := range keys {
				ttl, _ := store.RDB.TTL(ctx, k).Result()
				val := ""
				if v, err := store.RDB.Get(ctx, k).Result(); err == nil {
					if len(v) > 100 {
						val = v[:100] + "..."
					} else {
						val = v
					}
				}
				fmt.Printf("    %-50s TTL=%-8s %s\n", k, ttl.String(), val)
			}
		}
	} else {
		fmt.Println("  [INFO] Redis 不可用 → 进程内缓存")
	}

	// manifest 摘要
	var parsed map[string]interface{}
	if json.Unmarshal(b2, &parsed) == nil {
		fmt.Printf("\n=== manifest 摘要 ===\n")
		fmt.Printf("  file_count=%v size=%v dm=%v\n", parsed["file_count"], parsed["size_bytes"], parsed["download_method"])
	}

	fmt.Println("\n=== 完成 ===")
	fmt.Println("👉 同时看 im-server 控制台有没有 [game-cache] 开头的日志！")
}

func seedTestData() {
	g := model.Game{
		Name:           "缓存测试游戏",
		Slug:           "cache-test",
		DownloadMethod: 0,
		DirectBaseURL:  "http://test.local/files/",
	}
	store.DB.Create(&g)
	v := model.GameVersion{
		GameID:    g.ID,
		Version:   "1.0.0",
		FileCount: 3,
		SizeBytes: 102400,
	}
	store.DB.Create(&v)
	store.DB.Create(&model.GameFile{VersionID: v.ID, RelPath: "bin/game.exe", SizeBytes: 40960, SHA256: "abc123"})
	store.DB.Create(&model.GameFile{VersionID: v.ID, RelPath: "assets/data.dat", SizeBytes: 51200, SHA256: "def456"})
	store.DB.Create(&model.GameFile{VersionID: v.ID, RelPath: "config.ini", SizeBytes: 1024, SHA256: "ghi789"})
	fmt.Printf("  ✅ game_id=%d version=1.0.0 files=3\n", g.ID)
}
