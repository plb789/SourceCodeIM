package server

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// Server 服务端核心：承载连接管理、消息调度
type Server struct {
	cfg *config.Config
	hub *Hub
	// 阶段三十二：超大文件分片直传会话表（upload_id → 会话），进度归口与收齐判定依据
	// 仅存内存（重启丢失即重传，不落库不进 Redis，超大文件场景避免高频写）
	uploadSessions map[string]*directUploadSession
	uploadMu       sync.RWMutex
}

// NewServer 创建服务端实例
func NewServer(cfg *config.Config) *Server {
	return &Server{
		cfg:            cfg,
		hub:            NewHub(),
		uploadSessions: make(map[string]*directUploadSession),
	}
}

// HandleWS 处理新连接
func (s *Server) HandleWS(conn *websocket.Conn) {
	// 异常连接防护：单 IP 高频限制
	ip := conn.RemoteAddr().String()
	if !s.checkIPLimit(ip) {
		logger.Warn("拒绝高频连接: %s", ip)
		conn.Close()
		return
	}

	// 阶段三十一：最大在线连接数限制（max_connections 配置）
	// 原实现：该配置项从未被执行校验，连接数仅受系统资源约束
	if s.cfg.MaxConnections > 0 && s.hub.TotalConns() >= s.cfg.MaxConnections {
		logger.Warn("拒绝新连接: 在线连接数已达上限 %d", s.cfg.MaxConnections)
		// 回执错误提示后再关闭，前端可感知原因
		errMsg, _ := json.Marshal(&protocol.Message{MsgType: protocol.MsgTypeError, Content: "服务器连接数已达上限，请稍后重试"})
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		conn.WriteMessage(websocket.TextMessage, errMsg)
		conn.Close()
		return
	}

	c := newClient(s, conn)
	go c.writePump()
	c.readPump()
}

// sendToUser 向指定用户的全部在线连接推送数据（多端同步归口）
func (s *Server) sendToUser(username string, data []byte) {
	for _, c := range s.hub.GetAll(username) {
		c.send(data)
	}
}

// sendToUserBlock 向指定用户的全部在线连接阻塞推送（带超时）：文件分片等不可丢弃消息使用
// 阶段三十一：任一连接推送失败返回 false，由调用方向发送方反馈传输失败（原实现静默丢弃分片导致文件损坏）
func (s *Server) sendToUserBlock(username string, data []byte, timeout time.Duration) bool {
	ok := true
	for _, c := range s.hub.GetAll(username) {
		if !c.sendBlock(data, timeout) {
			ok = false
		}
	}
	return ok
}

// unregister 连接断开后的清理（按连接移除，同账号其他设备仍在线时不判定离线）
func (s *Server) unregister(c *Client) {
	if c.username == "" {
		return
	}
	// 移除当前连接，返回该用户剩余连接数
	// 原实现：s.hub.Remove(c.username) 按用户名删除，旧连接断开时存在误删新连接的竞态
	remaining := s.hub.Remove(c)
	if remaining > 0 {
		// 其他设备仍在线：不下线、不删缓存、不广播
		logger.Info("用户 %s 一台设备断开，剩余在线连接 %d", c.username, remaining)
		return
	}

	// 最后一个连接断开：删除 Redis 在线缓存
	store.RDB.Del(context.Background(), store.KeyOnlineUser+c.username)

	// 广播下线通知
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeOnline,
		FromUser:  c.username,
		Content:   "offline",
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	s.hub.Broadcast(data)
	logger.Info("用户 %s 下线", c.username)
}

// handleMessage 消息分发
func (s *Server) handleMessage(c *Client, msg *protocol.Message) {
	switch msg.MsgType {
	case protocol.MsgTypeLogin:
		s.handleLogin(c, msg)
	case protocol.MsgTypeHeartbeat:
		s.handleHeartbeat(c)
	case protocol.MsgTypeGroupChat:
		s.handleGroupChat(c, msg)
	case protocol.MsgTypePrivate:
		s.handlePrivateChat(c, msg)
	case protocol.MsgTypeHistory:
		s.handleHistory(c, msg)
	case protocol.MsgTypeFile:
		s.handleFile(c, msg)
	case protocol.MsgTypeTyping:
		s.handleTyping(c, msg)
	case protocol.MsgTypeRead:
		s.handleRead(c, msg)
	case protocol.MsgTypeRecall:
		s.handleRecall(c, msg)
	case protocol.MsgTypeDelete:
		s.handleDelete(c, msg)
	case protocol.MsgTypeSearch:
		s.handleSearch(c, msg)
	case protocol.MsgTypeConvPin:
		s.handleConvPin(c, msg)
	case protocol.MsgTypeConvClear:
		s.handleConvClear(c, msg)
	case protocol.MsgTypeConvDelete:
		s.handleConvDelete(c, msg)
	case protocol.MsgTypeMsgPin:
		s.handleMsgPin(c, msg)
	case protocol.MsgTypeConvSearch:
		s.handleConvSearch(c, msg)
	case protocol.MsgTypeFriendRequest:
		s.handleFriendRequest(c, msg)
	case protocol.MsgTypeFriendRequestResp:
		s.handleFriendRequestResp(c, msg)
	// 阶段二十九：好友申请列表查询（微信式"新的朋友"归口）
	case protocol.MsgTypeFriendReqList:
		s.handleFriendReqList(c, msg)
	case protocol.MsgTypeFriendDelete:
		s.handleFriendDelete(c, msg)
	case protocol.MsgTypeBlacklist:
		s.handleBlacklist(c, msg)
	case protocol.MsgTypeFriendUpdate:
		s.handleFriendUpdate(c, msg)
	// 阶段三十：个人资料更新（微信式资料面板）与查询（微信式好友资料卡）
	case protocol.MsgTypeProfileUpdate:
		s.handleProfileUpdate(c, msg)
	case protocol.MsgTypeProfileQuery:
		s.handleProfileQuery(c, msg)
	// 阶段三十二：超大文件分片直传取消（发送方上行，服务端清理会话并同步双方）
	case protocol.MsgTypeFileCancel:
		s.handleFileCancel(c, msg)
	// 阶段四十三：AI 问答（智能体列表查询 + 流式问答）
	case protocol.MsgTypeAIAgents:
		s.handleAIAgents(c, msg)
	case protocol.MsgTypeAIChat:
		s.handleAIChatMsg(c, msg)
	// 阶段七十三：AI 流式问答停止（Trae 同款"停止"按钮）
	case protocol.MsgTypeAIStop:
		s.handleAIStop(c, msg)
	// 阶段五十九：智能 Agent 自动化任务（任务发起/取消 + 审批结果上行）
	case protocol.MsgTypeAgentRun:
		s.handleAgentRun(c, msg)
	case protocol.MsgTypeAgentApprove:
		s.handleAgentApprove(c, msg)
	// 阶段六十：Agent 本地执行器——PC 端回传本地工具执行结果
	case protocol.MsgTypeAgentExecResp:
		s.handleAgentExecResp(c, msg)
	// 阶段六十一：Agent 沙箱白名单——PC 端上报用户自选工作区/授权目录
	case protocol.MsgTypeAgentSandbox:
		s.handleAgentSandbox(c, msg)
	// 阶段七十五：命令实时输出流（PC 上行转发任务事件流）+ 长命令转后台
	case protocol.MsgTypeAgentToolOutput:
		s.handleAgentToolOutput(c, msg)
	case protocol.MsgTypeAgentBg:
		s.handleAgentBg(c, msg)
	// 阶段七十六：工作区文件面板（web 请求归口 + PC 本地文件操作回传投递）
	case protocol.MsgTypeWsFileReq:
		s.handleWsFileReq(c, msg)
	case protocol.MsgTypePcFileResp:
		s.handlePcFileResp(c, msg)
	// 阶段七十一：AI 多会话（Trae 同款"新建会话"）——列表/新建/删除
	case protocol.MsgTypeAISessionList:
		s.handleAISessionList(c, msg)
	case protocol.MsgTypeAISessionNew:
		s.handleAISessionNew(c, msg)
	// 阶段七十二：私聊永久删除审批（发起/响应，会话内审批卡片）
	case protocol.MsgTypePurgeApply:
		s.handlePurgeApply(c, msg)
	case protocol.MsgTypePurgeResp:
		s.handlePurgeResp(c, msg)
	case protocol.MsgTypeAISessionDel:
		s.handleAISessionDel(c, msg)
	default:
		s.sendError(c, "未知消息类型")
	}
}

// handleLogin 处理登录/注册
func (s *Server) handleLogin(c *Client, msg *protocol.Message) {
	username := msg.FromUser
	password := msg.Content

	// 用户名不存在则自动注册，存在则校验密码
	// 登录失败提示修复：原实现 verifyUser 对"用户不存在"与"密码错误"返回同一错误（ErrInvalidLogin），
	// 密码错误也会进入注册分支，最终提示误导性的"用户名已存在"
	// 现改为仅用户不存在（ErrUserNotFound）时尝试自动注册，密码错误直接提示"用户名或密码错误"
	user, err := verifyUser(username, password)
	if err == ErrUserNotFound {
		// 尝试注册
		user, err = registerUser(username, password)
	}
	if err != nil {
		// 登录失败提示修复：原实现 sendError 走发送队列异步写出后立即 Close，
		// 错误消息常因竞态来不及送达客户端，导致密码错误等场景无任何提示
		// 现改为同步写错误消息送达后再关闭连接
		// 原代码：s.sendError(c, err.Error()); c.Close()
		// 错误分级：仅业务校验错误（用户名或密码错误/密码不能为空等）原样下发；
		// 底层依赖错误（如 MySQL 空闲连接失效的 invalid connection）统一下发通用中文提示，
		// 完整错误记日志排查——避免英文底层错误直接暴露给客户端
		userErrMsg := err.Error()
		if !isAuthBusinessError(err) {
			logger.Error("登录底层依赖异常: %v", err)
			userErrMsg = "登录服务暂不可用，请稍后重试"
		}
		c.SendErrorAndClose(userErrMsg)
		return
	}

	c.username = user.Username
	c.loginTime = time.Now() // 记录登录时间，用于好友申请去重
	// 阶段六十：记录登录设备类型（"pc"=Electron 桌面端）——Agent 本地执行器据此判定工具下发目标
	c.platform = strings.TrimSpace(msg.Platform)
	s.hub.Add(c)

	// 写入 Redis 在线缓存
	ctx := context.Background()
	store.RDB.Set(ctx, store.KeyOnlineUser+user.Username, "online", 120*time.Second)

	// 登录成功响应
	// 头像缺失修复：原实现仅下发 result 与 recall_window，前端拿不到自己头像，聊天消息气泡无法渲染头像
	// 原代码：s.sendLoginResp(c, "ok")
	// 阶段三十：改传整个 user，登录响应携带完整个人资料（昵称/性别/地区/签名）
	s.sendLoginResp(c, "ok", *user)

	// 批量推送离线消息
	s.pushOfflineMessages(c)

	// 仅首个设备上线时广播上线通知，多端重复登录不重复广播
	if s.hub.Count(user.Username) == 1 {
		onlineMsg := protocol.Message{
			MsgType:   protocol.MsgTypeOnline,
			FromUser:  user.Username,
			Content:   "online",
			Timestamp: time.Now().Unix(),
		}
		onlineData, _ := json.Marshal(onlineMsg)
		s.hub.BroadcastExcept(user.Username, onlineData)
	}

	// 推送在线用户列表给所有在线用户
	s.pushUserList()

	// 推送好友列表 + 待处理好友申请 + 黑名单列表 + 会话列表 + 置顶消息
	s.pushFriendList(c)
	s.pushPendingRequests(c)
	s.pushBlacklist(c)
	s.ensureGroupConv(user.Username)
	s.pushConvList(c)
	s.pushPinList(c)
	// 阶段七十二：补推与我相关的未处理永久删除审批卡片（离线审批不丢失）
	s.pushPendingPurges(c)
	// 阶段十四增强：登录补发对端已读水位，重连/重登后本地"已读"显示即时恢复（多端同步）
	s.pushReadWatermarks(c)
	logger.Info("用户 %s 上线", user.Username)
}

// handleHeartbeat 处理心跳，续期 Redis 在线缓存
func (s *Server) handleHeartbeat(c *Client) {
	store.RDB.Set(context.Background(), store.KeyOnlineUser+c.username, "online", 120*time.Second)
}

// messageSummary 阶段四十：引用消息会话摘要归口——引用消息 content 为信封 JSON
// （{"quote":{"msg_id","from","text"},"text":"回复正文"}），会话列表摘要必须取回复正文，
// 否则 JSON 原串会直接显示在会话列表；解析失败（普通文本/历史数据）回退原文
func messageSummary(content string) string {
	var envelope struct {
		Quote json.RawMessage `json:"quote"`
		Text  string          `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &envelope); err == nil && envelope.Quote != nil && envelope.Text != "" {
		return envelope.Text
	}
	// 阶段四十四：AI 图片提问信封归口——会话摘要与模型上下文显示"[图片] 附言"，JSON 原串不外泄
	var imgEnv struct {
		Image string `json:"image"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &imgEnv); err == nil && imgEnv.Image != "" {
		if strings.TrimSpace(imgEnv.Text) == "" {
			return "[图片]"
		}
		return "[图片] " + imgEnv.Text
	}
	// 阶段四十五：AI 文档问答信封归口——会话摘要与模型历史上下文显示"[文档] 文件名 附言"，
	// JSON 原串不外泄；文档全文仅注入当次提问（handleAIChatMsg 归口），历史上下文只带摘要避免重复携带撑爆 token
	var docEnv struct {
		Doc  string `json:"doc"`
		Name string `json:"name"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &docEnv); err == nil && docEnv.Doc != "" {
		summary := "[文档] " + docEnv.Name
		if note := strings.TrimSpace(docEnv.Text); note != "" {
			summary += " " + note
		}
		return summary
	}
	return content
}

// handleGroupChat 群聊广播并持久化
func (s *Server) handleGroupChat(c *Client, msg *protocol.Message) {
	// 敏感词过滤
	if word, ok := containsSensitive(msg.Content); ok {
		s.sendError(c, "消息包含敏感词，已拦截")
		logger.Warn("敏感词拦截：%s 群聊消息包含 '%s'", c.username, word)
		return
	}

	// 群聊 @AI 唤醒应答
	if strings.HasPrefix(strings.TrimSpace(msg.Content), "@"+AIBotName) {
		s.handleGroupAI(c, msg)
		return
	}

	msg.MsgType = protocol.MsgTypeGroupChat
	msg.FromUser = c.username
	msg.ToUser = ""
	msg.Timestamp = time.Now().Unix()

	// 持久化到 MySQL，回填消息唯一 ID
	record := model.Message{
		MsgType:  int8(msg.MsgType),
		FromUser: msg.FromUser,
		ToUser:   "",
		Content:  msg.Content,
	}
	store.DB.Create(&record)
	msg.MsgID = record.ID

	data, _ := json.Marshal(msg)
	s.hub.Broadcast(data)

	// 更新所有在线用户的群聊会话并推送会话列表（离线用户登录时确保存在）
	// 阶段四十补充：群聊路径同样走会话摘要归口——引用消息 content 为信封 JSON，
	// 原实现：touchConversation 直存 msg.Content，JSON 原串显示在会话列表（私聊路径已归口，群聊路径漏改）
	summary := messageSummary(msg.Content)
	for _, name := range s.hub.Usernames() {
		s.touchConversation(name, "", summary)
		s.notifyConvUpdate(name)
	}

	// 群聊离线消息：给所有离线的注册用户入队
	var usernames []string
	if err := store.DB.Model(&model.User{}).Pluck("username", &usernames).Error; err == nil {
		for _, name := range usernames {
			if name != c.username && !s.isOnline(name) {
				s.queueOffline(name, msg)
			}
		}
	}
}

// handlePrivateChat 私聊定向转发并持久化
func (s *Server) handlePrivateChat(c *Client, msg *protocol.Message) {
	// 敏感词过滤
	if word, ok := containsSensitive(msg.Content); ok {
		s.sendError(c, "消息包含敏感词，已拦截")
		logger.Warn("敏感词拦截：%s 私聊消息包含 '%s'", c.username, word)
		return
	}

	// 阶段四十三：私聊目标为任意配置的 AI 智能体时走 AI 问答链路（流式打字机，按用户隔离）
	// 原实现：仅支持固定 AIBotName 单一机器人，且不落库提问、无多轮上下文
	// 原实现：aiAgentByName(msg.ToUser) != nil（阶段五十七起走权限归口，他人个人智能体视同不存在，回落普通私聊被"用户不存在"拦截）
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.handleAIChatMsg(c, msg)
		return
	}

	// 黑名单拦截：任一方向拉黑则禁止私聊
	if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送消息")
		return
	}

	msg.MsgType = protocol.MsgTypePrivate
	msg.FromUser = c.username
	msg.Timestamp = time.Now().Unix()

	// 持久化到 MySQL，回填消息唯一 ID
	record := model.Message{
		MsgType:  int8(msg.MsgType),
		FromUser: msg.FromUser,
		ToUser:   msg.ToUser,
		Content:  msg.Content,
	}
	store.DB.Create(&record)
	msg.MsgID = record.ID

	data, _ := json.Marshal(msg)

	// 推送给接收方全部在线连接（多端同步）
	if s.hub.Count(msg.ToUser) > 0 {
		s.sendToUser(msg.ToUser, data)
	} else if !s.isOnline(msg.ToUser) {
		// 目标用户离线，消息入离线队列
		s.queueOffline(msg.ToUser, msg)
	}
	// 回显给发送方全部在线连接（多端同步自己发送的消息）
	// 原实现：c.send(data) 仅回显当前连接
	s.sendToUser(c.username, data)

	// 更新双方最近会话并推送
	// 阶段四十：引用消息 content 为信封 JSON，会话摘要归口解析出回复正文（原实现：summary := msg.Content 直存 JSON 原串）
	summary := messageSummary(msg.Content)
	s.touchConversation(c.username, msg.ToUser, summary)
	s.touchConversation(msg.ToUser, c.username, summary)
	s.notifyConvUpdate(c.username)
	s.notifyConvUpdate(msg.ToUser)
}

// handleFile 文件传输处理：文件头（ChunkIndex=-1）与分片数据（ChunkIndex>=0）
func (s *Server) handleFile(c *Client, msg *protocol.Message) {
	msg.MsgType = protocol.MsgTypeFile
	msg.FromUser = c.username

	if msg.ChunkIndex == -1 {
		s.handleFileHeader(c, msg)
		return
	}
	s.handleFileChunk(c, msg)
}

// handleFileHeader 处理文件头消息：写入 im_file、初始化 Redis 分片缓存、中转文件头
func (s *Server) handleFileHeader(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		s.sendError(c, "文件传输缺少接收方")
		return
	}
	// 拦截可执行/危险文件
	if isDangerousFile(msg.FileName) {
		s.sendError(c, "禁止传输可执行文件")
		logger.Warn("文件拦截：%s 尝试传输危险文件 %s", c.username, msg.FileName)
		return
	}

	record := model.FileRecord{
		FileName: msg.FileName,
		FileSize: msg.FileSize,
		FilePath: "",
		FromUser: c.username,
		ToUser:   msg.ToUser,
		Status:   0, // 传输中
	}
	if err := store.DB.Create(&record).Error; err != nil {
		s.sendError(c, "文件记录创建失败")
		return
	}

	// 生成文件唯一标识（用记录 ID）
	fileID := strconv.FormatUint(uint64(record.ID), 10)
	msg.FileID = fileID

	// 初始化 Redis 分片缓存
	ctx := context.Background()
	store.RDB.Del(ctx, store.KeyFileChunk+fileID)
	store.RDB.Expire(ctx, store.KeyFileChunk+fileID, 24*time.Hour)

	// 中转文件头给接收方全部在线连接（多端同步）
	if s.hub.Count(msg.ToUser) > 0 {
		data, _ := json.Marshal(msg)
		logger.Info("文件头中转: %s -> %s, 在线连接 %d, 帧 %d 字节, chunk=%d", c.username, msg.ToUser, s.hub.Count(msg.ToUser), len(data), msg.ChunkIndex)
		s.sendToUser(msg.ToUser, data)
	} else {
		logger.Warn("文件头中转跳过: 接收方 %s 不在线（hub 无连接）", msg.ToUser)
	}
	// 回显给发送方（携带 fileID）
	data, _ := json.Marshal(msg)
	c.send(data)
	logger.Info("文件传输发起: %s -> %s, 文件 %s (%d 字节), fileID=%s", c.username, msg.ToUser, msg.FileName, msg.FileSize, fileID)
}

// handleFileChunk 处理文件分片：中转 + 记录进度 + 完成判定
func (s *Server) handleFileChunk(c *Client, msg *protocol.Message) {
	if msg.FileID == "" {
		s.sendError(c, "分片缺少文件标识")
		return
	}

	ctx := context.Background()
	key := store.KeyFileChunk + msg.FileID

	// 中转分片给接收方全部在线连接（多端同步）
	// 原实现：s.sendToUser(msg.ToUser, data) 非阻塞投递，接收方队列满时静默丢片，文件永远组装不齐且无提示
	// 阶段三十一：改用阻塞背压推送（5 秒超时），接收方消费不及时节流发送方；失败时向发送方反馈，杜绝静默损坏
	if s.hub.Count(msg.ToUser) > 0 {
		data, _ := json.Marshal(msg)
		if !s.sendToUserBlock(msg.ToUser, data, 5*time.Second) {
			s.sendError(c, "对方接收队列已满，文件传输中断，请重新发送")
			return
		}
	}

	// 记录已传输分片序号
	store.RDB.SAdd(ctx, key, msg.ChunkIndex)

	// 完成判定：已传输分片数达到总分片数
	// 原实现：每个分片都执行一次 SCard 查询（20MB 文件产生 5120 次冗余 Redis 往返）
	// 阶段三十一：仅最后一片到达时判定一次（发送方读循环串行处理，最后一片到达时其余分片必然已入集合）
	if msg.TotalChunks > 0 && msg.ChunkIndex == msg.TotalChunks-1 {
		count, _ := store.RDB.SCard(ctx, key).Result()
		if int(count) >= msg.TotalChunks {
			// 阶段二十四：条件更新，避免覆盖持久化状态 3（上传接口与分片完成判定存在并发时序）
			store.DB.Model(&model.FileRecord{}).Where("id = ? AND status < ?", msg.FileID, 3).Update("status", 1)
			logger.Info("文件传输完成: fileID=%s", msg.FileID)
			store.RDB.Del(ctx, key)
		}
	}
}

// handleTyping 输入状态提示：私聊时中转给对方
func (s *Server) handleTyping(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		return
	}
	msg.MsgType = protocol.MsgTypeTyping
	msg.FromUser = c.username
	data, _ := json.Marshal(msg)
	// 输入状态推送给对方全部在线连接（多端同步）
	s.sendToUser(msg.ToUser, data)
}

func (s *Server) handleHistory(c *Client, msg *protocol.Message) {
	page := msg.Page
	pageSize := msg.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	var records []model.Message
	query := store.DB.Model(&model.Message{})

	// 排除当前用户已删除的消息（删除仅影响自己的视图）
	var delIDs []uint
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ?", c.username).Pluck("msg_id", &delIDs)
	if len(delIDs) > 0 {
		query = query.Where("id NOT IN ?", delIDs)
	}

	if msg.ToUser == "" {
		// 群聊历史
		// 阶段二十六：纳入群聊图片消息(4)，需限定 to_user 为空——私聊图片同样为 msg_type=4 但 to_user 非空
		// 原实现：query.Where("msg_type = ?", 1)
		query = query.Where("msg_type IN ? AND to_user = ''", []int{1, 4})
	} else {
		// 私聊历史：双方互发的私聊消息
		// 阶段二十四：纳入图片消息(4)与文件消息(5)，content 为 JSON（url/name/size），前端按类型渲染
		query = query.Where("msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			[]int{2, 4, 5}, c.username, msg.ToUser, msg.ToUser, c.username)
		// 阶段七十一：AI 多会话历史归口——智能体会话按消息盖戳 ai_session_id 过滤
		// （0=默认会话存量全量；普通私聊无会话语义不受影响。会话归属由上行声明、服务端校验）。
		// 图片/文件消息不经 AI_CHAT 通道，恒为默认会话盖戳（已知边界，后续可按需扩展上行声明）
		if aiAgentForUser(msg.ToUser, c.username) != nil {
			query = query.Where("ai_session_id = ?", msg.SessionID)
		}
	}

	if err := query.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&records).Error; err != nil {
		s.sendError(c, "查询历史记录失败")
		return
	}

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeHistoryResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Page:      page,
		PageSize:  pageSize,
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}

// UserInfo 在线用户信息（用户名 + 头像）
type UserInfo struct {
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

// pushUserList 推送在线用户列表（携带头像）给所有在线用户
func (s *Server) pushUserList() {
	names := s.hub.Usernames()

	// 查询在线用户的头像
	avatarMap := map[string]string{}
	if len(names) > 0 {
		var users []model.User
		if err := store.DB.Model(&model.User{}).Where("username IN ?", names).Find(&users).Error; err == nil {
			for _, u := range users {
				avatarMap[u.Username] = u.Avatar
			}
		}
	}

	infos := make([]UserInfo, 0, len(names))
	for _, n := range names {
		infos = append(infos, UserInfo{Username: n, Avatar: avatarMap[n]})
	}
	content, _ := json.Marshal(infos)

	listMsg := protocol.Message{
		MsgType:   protocol.MsgTypeUserList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(listMsg)
	s.hub.Broadcast(data)
}

// sendLoginResp 发送登录响应（携带服务端撤回时间窗口，供前端撤回菜单判断与窗口配置保持一致）
// 头像缺失修复：追加 avatar 参数，登录时下发登录用户自己头像（服务端归口），供导航栏与消息气泡渲染
// 原代码：func (s *Server) sendLoginResp(c *Client, result string) {
// 阶段三十：avatar 参数改为整个 user，content JSON 追加 profile 完整个人资料
func (s *Server) sendLoginResp(c *Client, result string, user model.User) {
	respInfo, _ := json.Marshal(map[string]interface{}{
		"result":        result,
		"recall_window": s.cfg.RecallWindow,
		// 阶段三十一：下发文件分片大小与大文件直传阈值（服务端归口，前端分片/分流逻辑与服务端配置保持一致）
		// 原代码：无 chunk_size / upload_threshold 字段（前端硬编码 4KB）
		"chunk_size":       s.cfg.ChunkSize,
		"upload_threshold": s.cfg.HttpUploadThreshold,
		// 阶段三十二：下发单请求直传上限/分片直传单片大小/分片直传上限（前端三层分流与服务端配置保持一致）
		"max_file_size":     s.cfg.MaxFileSize,
		"upload_chunk_size": s.cfg.UploadChunkSize,
		"max_direct_size":   s.cfg.MaxDirectSize,
		// 原代码：无 avatar 字段
		"avatar": user.Avatar,
		// 阶段三十：下发完整个人资料（微信式"我的个人资料"面板数据源）
		"profile": map[string]interface{}{
			"nickname":  user.Nickname,
			"gender":    user.Gender,
			"region":    user.Region,
			"signature": user.Signature,
		},
	})
	msg := protocol.Message{
		MsgType: protocol.MsgTypeLoginResp,
		// 原实现：Content 为固定字符串 "ok"，现改为 JSON 携带配置下发
		Content: string(respInfo),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// sendError 发送错误提示
func (s *Server) sendError(c *Client, errMsg string) {
	msg := protocol.Message{
		MsgType: protocol.MsgTypeError,
		Content: errMsg,
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}
