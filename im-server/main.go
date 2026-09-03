package main

import (
	"context"
	"net/http"
	"os"

	"github.com/gorilla/websocket"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/server"
	"im-server/store"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	cfg := config.Default()

	// 1. 初始化 MySQL
	if err := store.InitMySQL(cfg); err != nil {
		logger.Error("%v", err)
		os.Exit(1)
	}
	// 2. 初始化 Redis
	if err := store.InitRedis(cfg); err != nil {
		logger.Error("%v", err)
		os.Exit(1)
	}
	// 3. 缓存预热
	prewarm()

	// 4. WebSocket 监听入口
	srv := server.NewServer(cfg)
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Error("WebSocket 升级失败: %v", err)
			return
		}
		logger.Info("客户端接入: %s", conn.RemoteAddr())
		srv.HandleWS(conn)
	})
	// 头像上传接口
	http.HandleFunc("/upload/avatar", srv.HandleAvatarUpload)
	// 静态文件托管前端（im-client/web）
	http.Handle("/", http.FileServer(http.Dir("../im-client/web")))

	logger.Info("IM 服务端启动，监听 %s", cfg.WSAddr)
	if err := http.ListenAndServe(cfg.WSAddr, nil); err != nil {
		logger.Error("服务启动失败: %v", err)
		os.Exit(1)
	}
}

// prewarm 启动预热：清理在线缓存残留，加载用户基础信息到会话缓存
func prewarm() {
	ctx := context.Background()

	// 重启后所有旧连接已失效，清理在线缓存残留
	keys, err := store.RDB.Keys(ctx, store.KeyOnlineUser+"*").Result()
	if err == nil && len(keys) > 0 {
		store.RDB.Del(ctx, keys...)
	}

	// 从 MySQL 加载用户基础信息，写入会话缓存
	var users []model.User
	if err := store.DB.Find(&users).Error; err != nil {
		logger.Warn("预热加载用户失败: %v", err)
		return
	}
	for _, u := range users {
		store.RDB.Set(ctx, store.KeySession+u.Username, u.Username, 0)
	}
	logger.Info("缓存预热完成，加载用户 %d 个", len(users))
}
