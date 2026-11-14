package store

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"im-server/config"
	"im-server/logger"
)

var RDB *redis.Client

// Redis 缓存键前缀，与《开发文档》3.4 保持一致
const (
	KeyOnlineUser  = "im:online:"      // 在线用户缓存 im:online:username
	KeyFileChunk   = "im:file:chunk:"  // 文件分片缓存 im:file:chunk:fileid
	KeySession     = "im:session:"     // 用户会话缓存 im:session:username
	KeyOfflineMsg  = "im:offline:msg:" // 离线消息队列 im:offline:msg:username
	KeyDriveToken  = "im:drivetoken:"  // 网盘 API 鉴权 token 会话 im:drivetoken:<token> → username（阶段一百九十八）
	KeyPushRegID   = "im:regid:"       // 厂商推送 regId 注册表 im:regid:username → 厂商推送 token（阶段二百二十六）
	KeyGameManifest = "im:game:manifest:" // 游戏版本清单缓存 im:game:manifest:{gameID}:{version}（集群部署跨实例共享）
	KeyGameDelta    = "im:game:delta:"    // 增量下载字节缓存 im:game:delta:{gameID}:{from}:{toVersionID}
)

// Redis 可用性惰性探测（集群部署 Redis 挂时自动降级进程内缓存）
// redisOk: 1=可用, 0=未知, -1=不可用
var (
	redisOkState  int32
	redisFailTs   int64 // 上次失败毫秒时间戳
)

// RedisAvailable 检测 Redis 是否可用（惰性 Ping + 30s 失败冷却窗口）
// - RDB==nil 返回 false（未初始化）
// - 已知可用直接返回 true；已知不可用且冷却期内直接返回 false
// - 未知或冷却过期 → Ping 探测，成功=1/失败=-1 并记录时间戳
func RedisAvailable() bool {
	if RDB == nil {
		return false
	}
	switch atomic.LoadInt32(&redisOkState) {
	case 1:
		return true
	case -1:
		// 失败冷却 30s 后允许重试
		if time.Now().UnixMilli()-atomic.LoadInt64(&redisFailTs) > 30000 {
			atomic.StoreInt32(&redisOkState, 0)
		} else {
			return false
		}
	}
	// 未知或冷却过期 → Ping 探测
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := RDB.Ping(ctx).Err(); err != nil {
		atomic.StoreInt32(&redisOkState, -1)
		atomic.StoreInt64(&redisFailTs, time.Now().UnixMilli())
		logger.Warn("Redis Ping 失败，降级进程内缓存: %v", err)
		return false
	}
	atomic.StoreInt32(&redisOkState, 1)
	return true
}

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
	atomic.StoreInt32(&redisOkState, 1) // 启动时已 Ping 成功，直接标记可用避免首次调用重复探测
	logger.Info("Redis 连接成功")
	return nil
}
