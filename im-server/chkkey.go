//go:build ignore

package main

import (
	"context"
	"fmt"
	"im-server/store"

	"github.com/go-redis/redis/v8"
)

func main() {
	store.InitRedis()
	rdb := store.RDB
	ctx := context.Background()

	// 扫描所有 key
	var cursor uint64
	for {
		keys, next, err := rdb.Scan(ctx, cursor, "*", 20).Result()
		if err != nil {
			panic(err)
		}
		for _, k := range keys {
			t, _ := rdb.Type(ctx, k).Result()
			fmt.Printf("%-50s type=%s\n", k, t)
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	_ = redis.Nil
}
