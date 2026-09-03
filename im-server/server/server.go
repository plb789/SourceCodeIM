package server

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
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
}

// NewServer 创建服务端实例
func NewServer(cfg *config.Config) *Server {
	return &Server{
		cfg: cfg,
		hub: NewHub(),
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

	c := newClient(s, conn)
	go c.writePump()
	c.readPump()
}

// unregister 连接断开后的清理
func (s *Server) unregister(c *Client) {
	if c.username == "" {
		return
	}
	s.hub.Remove(c.username)
	// 删除 Redis 在线缓存
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
	case protocol.MsgTypeFriendRequest:
		s.handleFriendRequest(c, msg)
	case protocol.MsgTypeFriendRequestResp:
		s.handleFriendRequestResp(c, msg)
	case protocol.MsgTypeFriendDelete:
		s.handleFriendDelete(c, msg)
	case protocol.MsgTypeBlacklist:
		s.handleBlacklist(c, msg)
	case protocol.MsgTypeFriendUpdate:
		s.handleFriendUpdate(c, msg)
	default:
		s.sendError(c, "未知消息类型")
	}
}

// handleLogin 处理登录/注册
func (s *Server) handleLogin(c *Client, msg *protocol.Message) {
	username := msg.FromUser
	password := msg.Content

	// 用户名不存在则自动注册，存在则校验密码
	user, err := verifyUser(username, password)
	if err == ErrInvalidLogin {
		// 尝试注册
		user, err = registerUser(username, password)
	}
	if err != nil {
		s.sendError(c, err.Error())
		c.Close()
		return
	}

	c.username = user.Username
	s.hub.Add(c)

	// 写入 Redis 在线缓存
	ctx := context.Background()
	store.RDB.Set(ctx, store.KeyOnlineUser+user.Username, "online", 120*time.Second)

	// 登录成功响应
	s.sendLoginResp(c, "ok")

	// 批量推送离线消息
	s.pushOfflineMessages(c)

	// 广播上线通知
	onlineMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOnline,
		FromUser:  user.Username,
		Content:   "online",
		Timestamp: time.Now().Unix(),
	}
	onlineData, _ := json.Marshal(onlineMsg)
	s.hub.BroadcastExcept(user.Username, onlineData)

	// 推送在线用户列表给所有在线用户
	s.pushUserList()

	// 推送好友列表 + 待处理好友申请
	s.pushFriendList(c)
	s.pushPendingRequests(c)
	logger.Info("用户 %s 上线", user.Username)
}

// handleHeartbeat 处理心跳，续期 Redis 在线缓存
func (s *Server) handleHeartbeat(c *Client) {
	store.RDB.Set(context.Background(), store.KeyOnlineUser+c.username, "online", 120*time.Second)
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

	// 私聊 AI 助手触发 AI 问答
	if msg.ToUser == AIBotName {
		s.handleAIChat(c, msg)
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

	if target, ok := s.hub.Get(msg.ToUser); ok {
		target.send(data)
	} else if !s.isOnline(msg.ToUser) {
		// 目标用户离线，消息入离线队列
		s.queueOffline(msg.ToUser, msg)
	}
	// 回显给发送方
	c.send(data)
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

	// 中转文件头给接收方
	if target, ok := s.hub.Get(msg.ToUser); ok {
		data, _ := json.Marshal(msg)
		target.send(data)
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

	// 中转分片给接收方
	if target, ok := s.hub.Get(msg.ToUser); ok {
		data, _ := json.Marshal(msg)
		target.send(data)
	}

	// 记录已传输分片序号
	store.RDB.SAdd(ctx, key, msg.ChunkIndex)

	// 完成判定：已传输分片数达到总分片数
	if msg.TotalChunks > 0 {
		count, _ := store.RDB.SCard(ctx, key).Result()
		if int(count) >= msg.TotalChunks {
			store.DB.Model(&model.FileRecord{}).Where("id = ?", msg.FileID).Update("status", 1)
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
	if target, ok := s.hub.Get(msg.ToUser); ok {
		target.send(data)
	}
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

	if msg.ToUser == "" {
		// 群聊历史
		query = query.Where("msg_type = ?", 1)
	} else {
		// 私聊历史：双方互发的私聊消息
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, c.username, msg.ToUser, msg.ToUser, c.username)
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

// sendLoginResp 发送登录响应
func (s *Server) sendLoginResp(c *Client, result string) {
	msg := protocol.Message{
		MsgType: protocol.MsgTypeLoginResp,
		Content: result,
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
