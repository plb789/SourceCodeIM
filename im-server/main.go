package main

import (
	"context"
	"net"
	"net/http"
	pprof "net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
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

// realClientIP 提取真实客户端 IP（阶段二百二十一：登录连接风暴排查加固）
// 原缺陷：经 nginx 反代后 conn.RemoteAddr() 恒为 127.0.0.1，单 IP 高频限流
// （checkIPLimit 按 RemoteAddr 分桶）实际是全站用户共享一个 20 次/10 秒的配额桶——
// 任一波动（服务重启集中重连/恶意刷连接）即可打爆共享桶，全体用户被拒后前端
// 3 秒重试继续刷计数，形成"卡在登录无法登录"的自锁风暴，且属可被恶意利用的 DoS 面。
//
// 分桶判据（阿里云 CDN 链路适配）：用户 → 阿里云 CDN → nginx → 本服务。
// X-Real-IP 在该链路被 nginx 以 $remote_addr 覆盖为"CDN 回源节点 IP"（节点池共享，
// 不可用作用户分桶）；X-Forwarded-For 末段同样是回源节点 IP，而倒数第二段才是
// CDN 看到的用户真实 IP——用户自带的伪造 XFF 值会被 CDN 的覆盖/追加排在更前，
// 无法污染该位置。直连反代（无 CDN）时 XFF 为单段用户 IP，同样命中。
// 兜底：无 XFF 时回退 X-Real-IP（既有直连反代行为），再回退 RemoteAddr。
// 遗留面：绕过 CDN 直连源站可伪造 XFF，由"源站安全组仅放行 CDN 回源段"收口（运维建议）
func realClientIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if v := r.Header.Get("X-Forwarded-For"); v != "" {
			parts := strings.Split(v, ",")
			if len(parts) >= 2 {
				// CDN/多级代理链：倒数第一=最后一级代理（CDN 回源节点/nginx），倒数第二=真实用户 IP
				if prev := strings.TrimSpace(parts[len(parts)-2]); prev != "" {
					return prev
				}
			}
			if first := strings.TrimSpace(parts[0]); first != "" {
				return first
			}
		}
		if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
			return v
		}
	}
	return host
}

func main() {
	// 原实现：cfg := config.Default() 纯硬编码，现改为读取 config.yaml（缺省时回退默认值）
	// cfg := config.Default()
	cfg := config.Load()

	// 性能诊断：IM_PPROF=1 时开本机 pprof（仅 127.0.0.1:6060，默认关闭不影响生产路由）
	if os.Getenv("IM_PPROF") != "" {
		go func() {
			mux := http.NewServeMux()
			mux.HandleFunc("/debug/pprof/", pprof.Index)
			mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
			mux.HandleFunc("/debug/pprof/heap", pprof.Handler("heap").ServeHTTP)
			_ = http.ListenAndServe("127.0.0.1:6060", mux)
		}()
		runtime.SetMutexProfileFraction(1)
		runtime.SetBlockProfileRate(1)
	}

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

	// 3.5 网盘存储后端初始化（drive.storage=auto：MinIO 已配置即用 MinIO，否则降级本地磁盘
	// drive_data；MinIO 连接失败启动即报错退出，避免运行期才发现存储不可用）
	if cfg.Drive.Enabled {
		if err := store.InitDriveStore(cfg); err != nil {
			logger.Error("%v", err)
			os.Exit(1)
		}
		// 3.6 DCDN 远程鉴权票据初始化（drive.edge_auth.enabled：Presign 签发 auth_ticket 短时效票据，
		// /auth 端点供 DCDN 边缘节点校验，防跳过分享页直连 MinIO；关闭时零开销行为不变）
		store.DriveTicketInit(cfg.Drive.EdgeAuth.Enabled, cfg.Drive.EdgeAuth.TicketTTL)
	}

	// 4. WebSocket 监听入口
	srv := server.NewServer(cfg)
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		realIP := realClientIP(r)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Error("WebSocket 升级失败: %v", err)
			return
		}
		// 阶段二百二十一：接入日志移入 HandleWS 校验通过后（带真实 IP）——原在升级后立即打，
		// 被限流拒绝的连接也刷 INFO 日志，攻击者可借此制造日志 IO 噪声
		srv.HandleWS(conn, realIP)
	})
	// 头像上传接口
	http.HandleFunc("/upload/avatar", srv.HandleAvatarUpload)
	// 群头像上传接口（阶段二百六十六：仅群主可更换，落盘后全员 73 全量同步）
	http.HandleFunc("/upload/group-avatar", srv.HandleGroupAvatarUpload)
	// 聊天文件持久化上传接口（阶段二十四：图片/文件消息落库，历史可重现）
	http.HandleFunc("/upload/file", srv.HandleFileUpload)
	// 超大文件分片直传接口（阶段三十二：>20MB 文件按片 HTTP 上传，进度节流推送接收方）
	http.HandleFunc("/upload/chunk", srv.HandleChunkUpload)
	// 群聊图片上传接口（阶段二十六：HTTP 上传落库 + 广播群成员，不走点对点分片协议）
	http.HandleFunc("/upload/group/image", srv.HandleGroupImageUpload)
	// 群聊文件上传接口（阶段一百三十四：与群图片同链路，不限图片类型，落库 msg_type=5 + 广播 MsgTypeGroupFile）
	http.HandleFunc("/upload/group/file", srv.HandleGroupFileUpload)
	// 文件/图片消息转发接口（阶段二百七十七：微信同款元数据归口零字节重传——接收方即时见卡片，点击时按需下载）
	http.HandleFunc("/upload/forward", srv.HandleFileForward)
	// AI 图片提问上传接口（阶段四十四：仅落盘不落库，提问正文由 AI_CHAT 图片信封统一落库）
	http.HandleFunc("/upload/ai/image", srv.HandleAIImageUpload)
	// 朋友圈图片上传接口（阶段二百八十：仅落盘不落库，发布正文由 /api/moments 归口落库）
	http.HandleFunc("/upload/moment/image", srv.HandleMomentUpload)
	// 朋友圈视频上传接口（阶段二百八十一：拍摄/相册视频动态直传，微信同款单视频独占）
	http.HandleFunc("/upload/moment/video", srv.HandleMomentVideoUpload)
	// 朋友圈 API（阶段二百八十：微信同款朋友圈，发布/时间线/我的相册/点赞/评论回复/删除/红点）
	http.HandleFunc("POST /api/moments", srv.HandleMomentCreate)
	http.HandleFunc("GET /api/moments", srv.HandleMomentList)
	http.HandleFunc("GET /api/moments/mine", srv.HandleMomentMine)
	http.HandleFunc("DELETE /api/moments/{id}", srv.HandleMomentDelete)
	http.HandleFunc("POST /api/moments/{id}/like", srv.HandleMomentLike)
	http.HandleFunc("DELETE /api/moments/{id}/like", srv.HandleMomentUnlike)
	http.HandleFunc("POST /api/moments/{id}/comments", srv.HandleMomentComment)
	http.HandleFunc("DELETE /api/moments/{id}/comment/{cid}", srv.HandleMomentCommentDelete)
	http.HandleFunc("GET /api/moments/unread", srv.HandleMomentUnread)
	http.HandleFunc("POST /api/moments/unread/read", srv.HandleMomentUnreadRead)
	// 朋友圈封面（阶段二百八十一：微信同款"更换相册封面"，支持图片/GIF/短视频）
	http.HandleFunc("GET /api/moments/cover", srv.HandleMomentCoverGet)
	http.HandleFunc("POST /api/moments/cover", srv.HandleMomentCoverSet)
	http.HandleFunc("DELETE /api/moments/cover", srv.HandleMomentCoverDelete)
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
	// 截图屏幕翻译（阶段一百三十九：OCR 文本服务端归口 AI 翻译，复用已配置智能体上游）
	http.HandleFunc("POST /api/translate", srv.HandleTranslate)
	// 截图提取文字（阶段一百三十九：选区图视觉模型 OCR，服务端归口）
	http.HandleFunc("POST /api/ocr", srv.HandleScreenOCR)
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

	// 阶段一百二十二：网页资源清单（PC 客户端本地缓存增量更新归口；无鉴权，与静态文件同级水位）
	http.HandleFunc("GET /api/web-manifest", srv.HandleWebManifest)

	// 阶段一百四十一：通话话单查询（本人相关话单分页倒序，鉴权水位与 /api/kb 一致）
	http.HandleFunc("GET /api/call/logs", srv.HandleCallLogs)

	// 阶段二百四十：扫码登录（PC/WEB 登录页二维码申请/状态轮询 + 系统相机扫码落地页；
	// 无鉴权——登录前调用，安全归口一次性 qr_id/登录码 + 限频，见 server/qrlogin.go）
	http.HandleFunc("POST /api/qrlogin/create", srv.HandleQRLoginCreate)
	http.HandleFunc("GET /api/qrlogin/poll", srv.HandleQRLoginPoll)
	http.HandleFunc("/qrl", srv.HandleQRLanding)

	// 阶段二百四十一：APP 启动广告图配置下发（微信启动页同款：服务端可运营广告图，
	// APP 预下载缓存下次冷启动显示；无鉴权登录前调用，纯配置无敏感数据）
	http.HandleFunc("GET /api/splash/ads", srv.HandleSplashAdGet)

	// 阶段一百三十六：前端资源密文下发（PC 端磁盘零明文；无鉴权——密文本身即屏障，
	// 排除规则与清单一致，密钥未配置时 503 由客户端回退明文链路）
	http.HandleFunc("GET /api/secure-file", srv.HandleSecureFile)

	// 阶段六十四：Agent 任务历史（用户端仅本人任务，鉴权水位与 /api/agents 一致；管理端审计走 adminGuard）
	http.HandleFunc("GET /api/agent/tasks", srv.HandleAgentTaskList)
	http.HandleFunc("GET /api/agent/task/{task_id}", srv.HandleAgentTaskDetail)
	// 阶段六十五：Agent 任务执行轨迹（每步工具调用留痕，详情展开时拉取）
	http.HandleFunc("GET /api/agent/task/{task_id}/steps", srv.HandleAgentTaskSteps)
	// 阶段一百八十五：任务报告导出 Markdown（服务端渲染归口，鉴权水位与任务详情一致）
	http.HandleFunc("GET /api/agent/task/{task_id}/report", srv.HandleAgentTaskReport)

	// 阶段一百八十二：任务模板一键重跑（用户端仅本人模板，鉴权水位与任务历史一致）
	http.HandleFunc("GET /api/agent/tasks/tpl", srv.HandleAgentTaskTplList)
	http.HandleFunc("POST /api/agent/tasks/tpl", srv.HandleAgentTaskTplAdd)
	http.HandleFunc("DELETE /api/agent/tasks/tpl/{id}", srv.HandleAgentTaskTplDel)

	// 阶段一百八十四：定时/巡检任务（到期自动发起 Agent 任务，结果经既有完结链路落会话；
	// 鉴权水位与任务模板一致）
	http.HandleFunc("GET /api/agent/cron/list", srv.HandleAgentCronList)
	http.HandleFunc("POST /api/agent/cron/save", srv.HandleAgentCronSave)
	http.HandleFunc("POST /api/agent/cron/toggle", srv.HandleAgentCronToggle)
	http.HandleFunc("POST /api/agent/cron/delete", srv.HandleAgentCronDel)
	// 调度循环（启动即扫描一次：重启后 next_run_at 过期的任务补跑）
	server.StartAgentCron(srv)

	// 阶段一百九十：已启用模型服务列表（会话内模型选择器数据源；仅名称/模型名/图片能力，
	// 凭据字段绝不出现；鉴权水位与 /api/agent/tasks 一致）
	http.HandleFunc("GET /api/ai/models", srv.HandleAIModels)

	// 阶段一百八十三：工作区文件上传（服务端模式直落工作区；PC 本地模式转发执行器，
	// 路径安全归口 agentSafePath + wsEntryName，鉴权水位与 /agent/preview 一致）
	http.HandleFunc("POST /api/agent/ws/upload", srv.HandleAgentWsUpload)

	// 阶段五十九：Agent 工作区静态访问（页面预览支撑，仅限本人工作区内文件）
	http.HandleFunc("GET /agent/preview", srv.HandleAgentPreview)
	// 阶段一百九十一：工作区目录级静态预览（多文件 HTML 产物整页打开 + Agent 视觉自检截图链路）
	http.HandleFunc("GET /agent/site/{username}/{path...}", srv.HandleAgentSite)
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
	// 网盘分享站内链接入口 /s/<code>（Go 1.22 具体路径优先于 "/"）：
	// 原实现：http.ServeFile(w, r, filepath.Join(cfg.WebDir, "index.html"))（回完整前端，登录态恢复后由
	//         前端解析 pathname 弹分享详情，校验归口分享 API）
	// 现改为独立分享页 share.html（百度网盘同款）：免登录查看/下载（凭 code+extract 校验归口分享 API），
	// 保存到网盘在页面内自绘登录面板建立 WS 会话后调用（driveCheckUser 在线水位归口不变）
	http.HandleFunc("GET /s/{code}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(cfg.WebDir, "share.html"))
	})
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 原实现：仅对 HTML 入口禁用缓存（css/js 走浏览器启发式缓存，存在陈旧缓存风险）
		// if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
		// 	w.Header().Set("Cache-Control", "no-cache")
		// }
		// 阶段二百六十三：头像强缓存——头像文件名上传时含纳秒时间戳+随机数全局唯一，
		// 换头像必然换 URL，按 URL 永久缓存不存在陈旧风险，immutable 后浏览器/手机 WebView
		// 二次启动直接读本地磁盘缓存零回源（微信同款：头像首次下载后本地秒出）
		// 阶段二百八十一：聊天文件强缓存同款语义——上传文件名同样含纳秒时间戳+随机数全局
		// 唯一、内容与 URL 一一不可变（转发/多端复用同 URL），immutable 后二次预览（pptx/doc
		// 预览页 XHR）、二次下载（fetch）直接读 WebView/浏览器磁盘缓存零回源（微信同款：
		// 已下载文件点开秒出，不再每次重新下载）。注：阶段一百六十超期物理清理后 URL 失效，
		// 历史消息本已不可点，缓存命中无陈旧风险。
		if strings.HasPrefix(r.URL.Path, "/static/avatar/") || strings.HasPrefix(r.URL.Path, "/static/upload/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
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
	// 阶段一百四十四：公司公告与动态路由（后台发布管理 + 用户端阅读/已读归口）
	server.RegisterAnnouncementRoutes(srv)
	// 阶段一百四十五：工作台路由（后台维护办公网站清单 + 客户端宫格导航只读归口）
	server.RegisterWorkbenchRoutes(srv)
	// 阶段二百六十：客户端自动更新路由（后台上传安装包/启停版本 + 客户端版本检查归口）
	server.RegisterAppVersionRoutes(srv)
	// 网盘路由（个人云盘：元数据 MySQL + 文件本体 MinIO/本地双后端，全部操作服务端归口代理）
	server.RegisterDriveRoutes(srv)
	// 网盘分享路由（二期：好友/群卡片投递 + 站内链接 /s/<code>，服务端归口校验与零拷贝保存）
	server.RegisterDriveShareRoutes(srv)
	// 阶段二百六十一：向日葵同款远程控制路由（设备注册/验证码管理/历史话单；信令面 rc_connect 归 remote.go）
	server.RegisterRCRoutes(srv, cfg.RC)
	// DCDN 远程鉴权路由（drive.edge_auth.enabled：公开端点 GET /auth 供阿里云 DCDN 边缘节点
	// 校验 MinIO 预签名票据，未启用静默不注册）
	server.RegisterEdgeAuthRoutes(cfg)
	// 网盘挂载路由（WebDAV /dav/：资源管理器 net use 映射本地盘符，与 /api/drive 同一存储归口；
	// drive.enabled + drive.webdav.enabled 双开关，未启用静默不注册）
	server.RegisterWebDavRoutes(srv)
	// 阶段五十：性能仪表盘——上传目录后台定时扫描（指标接口只读缓存，避免轮询 walk 目录）
	server.StartAdminUploadScanner(cfg.UploadDir)
	// 阶段一百四十二：内置 TURN/STUN 中继服务（音视频通话 P2P 打洞失败兜底；turn.enabled=false 时静默不启动）
	if err := server.StartTURN(cfg); err != nil {
		logger.Error("%v", err)
		os.Exit(1)
	}
	// 阶段一百五十四：积分红包 24 小时过期退回后台扫描（未领完红包剩余积分自动退回发送者）
	server.StartRedPacketRefundLoop()
	// 阶段一百六十：聊天文件定期清理（static/upload 超期文件物理删除，默认保留 7 天，-1 永不清理；
	// 目录兜底逻辑与 uploadfile.go 一致：UploadDir 缺省时基于 WebDir 推导）
	cleanupDir := cfg.UploadDir
	if cleanupDir == "" {
		cleanupDir = filepath.Join(cfg.WebDir, "static", "upload")
	}
	server.StartFileCleanupLoop(cleanupDir, cfg.FileRetentionDays)
	// 网盘分享：过期分享记录定期清理（过期留痕 30 天后删除记录，已取消记录永久留痕）
	server.StartShareCleanupLoop()

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
