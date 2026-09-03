package store

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"im-server/config"
	"im-server/logger"
)

var RDB *redis.Client

// Redis 缓存键前缀，与《开发文档》3.4 保持一致
const (
	KeyOnlineUser = "im:online:"      // 在线用户缓存 im:online:username
	KeyFileChunk  = "im:file:chunk:"  // 文件分片缓存 im:file:chunk:fileid
	KeySession    = "im:session:"     // 用户会话缓存 im:session:username
	KeyOfflineMsg = "im:offline:msg:" // 离线消息队列 im:offline:msg:username
)

// InitRedis 初始化 Redis 连接并校验连通性
func InitRedis(cfg *config.Config) error {
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("连接 Redis 失败: %w", err)
	}

	RDB = rdb
	logger.Info("Redis 连接成功")
	return nil
}
