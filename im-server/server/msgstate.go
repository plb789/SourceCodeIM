package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// recallWindow 撤回时间窗口：2 分钟内可撤回
const recallWindow = 2 * time.Minute

// handleRead 已读回执：更新已读状态并转发给对方
// content 为已读到的最大消息 ID，服务端统一归口更新该范围内的消息状态
func (s *Server) handleRead(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" || msg.ToUser == c.username {
		return
	}
	lastID, err := strconv.ParseUint(strings.TrimSpace(msg.Content), 10, 64)
	if err != nil || lastID == 0 {
		return
	}

	// 更新对方发给我的、ID 不超过 lastID 的消息为已读
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ? AND id <= ?", msg.ToUser, c.username, lastID).
		Update("is_read", true)

	// 回执转发给对方，供其界面显示"已读"
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeRead,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   msg.Content,
		Timestamp: time.Now().Unix(),
	})
	if target, ok := s.hub.Get(msg.ToUser); ok {
		target.send(data)
	}
}

// handleRecall 消息撤回：仅限 2 分钟内自己发送的消息
func (s *Server) handleRecall(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		s.sendError(c, "撤回消息无效")
		return
	}
	var record model.Message
	if err := store.DB.First(&record, msg.MsgID).Error; err != nil {
		s.sendError(c, "消息不存在")
		return
	}
	if record.FromUser != c.username {
		s.sendError(c, "只能撤回自己发送的消息")
		return
	}
	if time.Since(record.CreateTime) > recallWindow {
		s.sendError(c, "超过 2 分钟的消息无法撤回")
		return
	}

	// 标记为已撤回（保留记录，历史中显示"撤回了一条消息"）
	store.DB.Model(&model.Message{}).Where("id = ?", record.ID).Update("recalled", true)

	// 通知双方（群聊则广播）
	notice := protocol.Message{
		MsgType:   protocol.MsgTypeRecall,
		FromUser:  c.username,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	if record.ToUser == "" {
		s.hub.Broadcast(data)
	} else {
		if target, ok := s.hub.Get(record.ToUser); ok {
			target.send(data)
		}
		c.send(data)
	}
}

// handleDelete 消息删除：仅记录删除者视角，不影响对方
func (s *Server) handleDelete(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		return
	}
	var count int64
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ? AND msg_id = ?", c.username, msg.MsgID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.MessageDelete{UserID: c.username, MsgID: msg.MsgID})
	}
	s.sendError(c, "消息已删除")
}
