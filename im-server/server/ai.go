package server

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// AIBotName AI 机器人账号
const AIBotName = "AI助手"

// AIProvider AI 大模型接口（可插拔，后续可替换为真实大模型 API）
type AIProvider interface {
	Reply(ctx context.Context, question string) (string, error)
}

// MockAIProvider 模拟 AI 回复（无真实 API 时的默认实现）
type MockAIProvider struct{}

func (p *MockAIProvider) Reply(ctx context.Context, question string) (string, error) {
	return "我是 AI 助手，你问的是：" + question, nil
}

// aiProvider 当前 AI 实现
var aiProvider AIProvider = &MockAIProvider{}

// SetAIProvider 可插拔替换 AI 实现（接入真实大模型 API）
func SetAIProvider(p AIProvider) {
	aiProvider = p
}

// aiLimitKey AI 限流计数键
const aiLimitKey = "im:ai:limit:"

// handleAIChat 处理私聊 AI 助手消息：异步调用 AI、持久化、回复
func (s *Server) handleAIChat(c *Client, msg *protocol.Message) {
	// AI 限流：单用户 60 秒内最多 10 次
	ctx := context.Background()
	limitKey := aiLimitKey + c.username
	count, _ := store.RDB.Incr(ctx, limitKey).Result()
	if count == 1 {
		store.RDB.Expire(ctx, limitKey, 60*time.Second)
	}
	if count > 10 {
		s.sendError(c, "AI 提问过于频繁，请稍后再试")
		return
	}

	// 异步调用 AI，避免阻塞 WebSocket 主调度
	go func() {
		reply, err := aiProvider.Reply(context.Background(), msg.Content)
		if err != nil {
			s.sendError(c, "AI 服务异常，请稍后重试")
			return
		}

		// 持久化 AI 回复
		record := model.Message{
			MsgType:  int8(protocol.MsgTypePrivate),
			FromUser: AIBotName,
			ToUser:   c.username,
			Content:  reply,
		}
		store.DB.Create(&record)

		// 推送回复给用户
		resp := protocol.Message{
			MsgType:   protocol.MsgTypePrivate,
			FromUser:  AIBotName,
			ToUser:    c.username,
			Content:   reply,
			MsgID:     record.ID,
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(resp)
		c.send(data)
		logger.Info("AI 回复用户 %s", c.username)
	}()
}

// handleGroupAI 处理群聊 @AI 唤醒应答
func (s *Server) handleGroupAI(c *Client, msg *protocol.Message) {
	// 仅当消息以 @AI助手 开头时触发
	content := strings.TrimSpace(msg.Content)
	if !strings.HasPrefix(content, "@"+AIBotName) {
		return
	}
	question := strings.TrimSpace(strings.TrimPrefix(content, "@"+AIBotName))

	// 异步调用 AI 并在群聊回复
	go func() {
		reply, err := aiProvider.Reply(context.Background(), question)
		if err != nil {
			return
		}
		reply = "@" + c.username + " " + reply

		record := model.Message{
			MsgType:  int8(protocol.MsgTypeGroupChat),
			FromUser: AIBotName,
			ToUser:   "",
			Content:  reply,
		}
		store.DB.Create(&record)

		resp := protocol.Message{
			MsgType:   protocol.MsgTypeGroupChat,
			FromUser:  AIBotName,
			Content:   reply,
			MsgID:     record.ID,
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(resp)
		s.hub.Broadcast(data)
	}()
}
