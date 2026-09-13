package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

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
	// AI 文档问答上传接口（阶段四十五：仅落盘+试解析不落库，提问正文由 AI_CHAT 文档信封统一落库）
	http.HandleFunc("/upload/ai/doc", srv.HandleAIDocUpload)
	// AI 回复表格导出 Excel（阶段四十五：服务端归口解析 Markdown 表格转 xlsx，文件消息回发会话）
	http.HandleFunc("/export/ai/excel", srv.HandleAIExportExcel)
	// AI 回复导出 Word（阶段四十五：Markdown → docx 转档，标题/段落/列表/引用/表格）
	http.HandleFunc("/export/ai/word", srv.HandleAIExportWord)
	// 文档在线编辑（阶段四十六：OnlyOffice 对接——编辑器配置签发 / 文档回源下载 / 保存回调）
	http.HandleFunc("/doc/editor", srv.HandleDocEditor)
	http.HandleFunc("/doc/download", srv.HandleDocDownload)
	http.HandleFunc("/doc/callback", srv.HandleDocCallback)
	// 用户端个人知识库（阶段五十六：自建/上传/勾选，勾选后对所有智能体对话生效；个人库仅归属者可管理）
	http.HandleFunc("GET /api/kb", srv.HandleUserKBGet)
	http.HandleFunc("POST /api/kb", srv.HandleUserKBCreate)
	http.HandleFunc("PUT /api/kb/select", srv.HandleUserKBSelect)
	http.HandleFunc("POST /api/kb/file", srv.HandleUserKBFileUpload)
	http.HandleFunc("GET /api/kb/{id}/files", srv.HandleUserKBFiles)
	http.HandleFunc("DELETE /api/kb/file/{id}", srv.HandleUserKBFileDelete)
	http.HandleFunc("DELETE /api/kb/{id}", srv.HandleUserKBDelete)
	// 用户端个人智能体（阶段五十七：自建/编辑/删除，仅归属者可见可对话；模型走 config.yaml 白名单）
	http.HandleFunc("GET /api/agents", srv.HandleUserAgentGet)
	http.HandleFunc("POST /api/agents", srv.HandleUserAgentCreate)
	http.HandleFunc("PUT /api/agents/{id}", srv.HandleUserAgentUpdate)
	http.HandleFunc("DELETE /api/agents/{id}", srv.HandleUserAgentDelete)
	// 智能体长期记忆（阶段五十八：提取/注入归口 memory.go，管理接口鉴权水位与 /api/agents 一致）
	http.HandleFunc("GET /api/agents/{id}/memory", srv.HandleMemoryGet)
	http.HandleFunc("POST /api/agents/{id}/memory", srv.HandleMemoryAdd)
	http.HandleFunc("PUT /api/agents/{id}/memory/pref", srv.HandleMemoryPref)
	http.HandleFunc("DELETE /api/agents/{id}/memory/{mid}", srv.HandleMemoryDelete)
	http.HandleFunc("DELETE /api/agents/{id}/memory", srv.HandleMemoryClear)
	// 用户自定义 AI 规则（阶段一百零四：TRAE CN 同款"AI 回答前先看规则"；注入/管理归口 rules.go，鉴权水位与记忆一致）
	http.HandleFunc("GET /api/agents/{id}/rules", srv.HandleRuleGet)
	http.HandleFunc("POST /api/agents/{id}/rules", srv.HandleRuleAdd)
	http.HandleFunc("PUT /api/agents/{id}/rules/{rid}/enabled", srv.HandleRuleEnabled)
	http.HandleFunc("DELETE /api/agents/{id}/rules/{rid}", srv.HandleRuleDelete)
	http.HandleFunc("DELETE /api/agents/{id}/rules", srv.HandleRuleClear)

	// 阶段六十四：Agent 任务历史（用户端仅本人任务，鉴权水位与 /api/agents 一致；管理端审计走 adminGuard）
	http.HandleFunc("GET /api/agent/tasks", srv.HandleAgentTaskList)
	http.HandleFunc("GET /api/agent/task/{task_id}", srv.HandleAgentTaskDetail)
	// 阶段六十五：Agent 任务执行轨迹（每步工具调用留痕，详情展开时拉取）
	http.HandleFunc("GET /api/agent/task/{task_id}/steps", srv.HandleAgentTaskSteps)

	// 阶段五十九：Agent 工作区静态访问（页面预览支撑，仅限本人工作区内文件）
	http.HandleFunc("GET /agent/preview", srv.HandleAgentPreview)
	// 静态文件托管前端（im-client/web）
	// 原实现：http.Handle("/", http.FileServer(http.Dir("../im-client/web")))（相对进程工作目录，从 bin 目录双击 exe 启动会 404）
	// 现改为读取配置 WebDir（锚定 exe 所在目录解析，双击 bin 目录下的 exe 亦可正常访问）
	// 阶段四十三：入口 HTML 禁用缓存（no-cache=每次回源校验），前端发版后普通刷新即可拿到新版；
	// js/css 带 ?v= 版本号仍走浏览器缓存，不受影响
	// 阶段四十八：所有静态资源统一 no-cache（每次回源校验，资源未变更时服务端返回 304，开销极小）。
	// 根因修复：css/js 无 Cache-Control 时浏览器按启发式缓存且期间不回源验证，改版后客户端可能继续
	// 复用陈旧甚至损坏的缓存副本（实例：登录界面改版后 PC 端仍加载旧样式，且 ?v= 版本号被并行会话
	// 回退时彻底失效）。原先仅靠 ?v= 手动 bump，现服务端归口兜底。
	fileServer := http.FileServer(http.Dir(cfg.WebDir))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 原实现：仅对 HTML 入口禁用缓存（css/js 走浏览器启发式缓存，存在陈旧缓存风险）
		// if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
		// 	w.Header().Set("Cache-Control", "no-cache")
		// }
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	}))
	// 头像目录注入（锚定 exe 所在目录解析，替代 avatar.go 中原相对路径实现）
	server.SetAvatarDir(filepath.Join(cfg.WebDir, "static", "avatar"))
	// 阶段四十九：后台管理——admin_users 白名单标记管理员角色（未注册账号注册后下次启动补标记）
	server.MarkAdminUsers(cfg)
	// 阶段四十三：AI 问答初始化（服务端归口）
	// 原实现：providers/agents 直接从 config.yaml 构建，修改后需重启
	// 阶段四十九起：首次启动种子导入数据库，之后从数据库加载；后台管理界面增删改后热生效
	server.InitAI(cfg)
	// 阶段五十一：知识库模块初始化（chromem-go 向量库 + embedding 配置归口，未配置时静默降级）
	server.InitKB(cfg)
	// 阶段五十八：智能体长期记忆初始化（须在 InitKB 之后：向量库实例由 KB 模块创建）
	server.InitMemory(cfg)
	// 阶段一百零四：用户自定义 AI 规则初始化（TRAE CN 同款"规则"功能，纯 MySQL 无向量依赖）
	server.InitRules()
	// 阶段五十九：智能 Agent 自动化任务初始化（工具调用闭环+权限审批，须在 InitAI 之后复用智能体索引）
	server.InitAgent(cfg)
	// 阶段八十八：MCP 客户端初始化（TRAE CN 同款 MCP 能力，服务端归口；须在 DB 就绪后调用）
	server.InitMCP(cfg)
	// 阶段四十九：后台管理路由（管理员登录 + AI 模型服务/智能体管理热更新）
	server.RegisterAdminRoutes(srv)
	// 阶段五十：性能仪表盘——上传目录后台定时扫描（指标接口只读缓存，避免轮询 walk 目录）
	server.StartAdminUploadScanner(cfg.UploadDir)

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
