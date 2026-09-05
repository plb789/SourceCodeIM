package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"

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
	// 原实现：cfg := config.Default() 纯硬编码，现改为读取 config.yaml（缺省时回退默认值）
	// cfg := config.Default()
	cfg := config.Load()

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
	// 聊天文件持久化上传接口（阶段二十四：图片/文件消息落库，历史可重现）
	http.HandleFunc("/upload/file", srv.HandleFileUpload)
	// 超大文件分片直传接口（阶段三十二：>20MB 文件按片 HTTP 上传，进度节流推送接收方）
	http.HandleFunc("/upload/chunk", srv.HandleChunkUpload)
	// 群聊图片上传接口（阶段二十六：HTTP 上传落库 + 广播群成员，不走点对点分片协议）
	http.HandleFunc("/upload/group/image", srv.HandleGroupImageUpload)
	// AI 图片提问上传接口（阶段四十四：仅落盘不落库，提问正文由 AI_CHAT 图片信封统一落库）
	http.HandleFunc("/upload/ai/image", srv.HandleAIImageUpload)
	// 静态文件托管前端（im-client/web）
	// 原实现：http.Handle("/", http.FileServer(http.Dir("../im-client/web")))（相对进程工作目录，从 bin 目录双击 exe 启动会 404）
	// 现改为读取配置 WebDir（锚定 exe 所在目录解析，双击 bin 目录下的 exe 亦可正常访问）
	// 阶段四十三：入口 HTML 禁用缓存（no-cache=每次回源校验），前端发版后普通刷新即可拿到新版；
	// js/css 带 ?v= 版本号仍走浏览器缓存，不受影响
	fileServer := http.FileServer(http.Dir(cfg.WebDir))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	}))
	// 头像目录注入（锚定 exe 所在目录解析，替代 avatar.go 中原相对路径实现）
	server.SetAvatarDir(filepath.Join(cfg.WebDir, "static", "avatar"))
	// 阶段四十三：AI 问答初始化（服务端归口：providers/agents 密钥仅存 config.yaml）
	server.InitAI(cfg)

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
