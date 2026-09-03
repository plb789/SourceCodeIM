package server

import (
	"encoding/json"
	"strings"
	"time"

	"gorm.io/gorm"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ConvInfo 会话信息（推送给前端）
type ConvInfo struct {
	Target   string `json:"target"`    // 对方用户名，空表示群聊
	LastMsg  string `json:"last_msg"`  // 最后一条消息摘要
	LastTime int64  `json:"last_time"` // 最后消息时间戳
	Unread   int64  `json:"unread"`    // 未读数（仅私聊统计）
	Pinned   bool   `json:"pinned"`    // 是否置顶
}

// touchConversation 刷新会话（存在则更新最后消息，不存在则创建）
func (s *Server) touchConversation(userID, target, lastMsg string) {
	// 摘要截断，避免超出字段长度
	if len(lastMsg) > 200 {
		lastMsg = lastMsg[:200]
	}
	now := time.Now()
	var conv model.Conversation
	err := store.DB.Where("user_id = ? AND target = ?", userID, target).First(&conv).Error
	if err != nil {
		store.DB.Create(&model.Conversation{UserID: userID, Target: target, LastMsg: lastMsg, LastTime: now})
	} else {
		conv.LastMsg = lastMsg
		conv.LastTime = now
		store.DB.Save(&conv)
	}
}

// ensureGroupConv 登录时确保群聊会话存在（不刷新时间，避免每次登录都跳到最前）
func (s *Server) ensureGroupConv(userID string) {
	var count int64
	store.DB.Model(&model.Conversation{}).Where("user_id = ? AND target = ''", userID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.Conversation{UserID: userID, Target: "", LastMsg: "群聊", LastTime: time.Now()})
	}
}

// pushConvList 推送会话列表（置顶优先，按最后消息时间倒序）
func (s *Server) pushConvList(c *Client) {
	var convs []model.Conversation
	store.DB.Where("user_id = ?", c.username).
		Order("pinned DESC, last_time DESC").Limit(50).Find(&convs)

	infos := make([]ConvInfo, 0, len(convs))
	for _, cv := range convs {
		var unread int64
		if cv.Target != "" {
			// 私聊未读数：对方发给我且未读的未撤回消息
			store.DB.Model(&model.Message{}).
				Where("msg_type = ? AND from_user = ? AND to_user = ? AND is_read = ? AND recalled = ?",
					2, cv.Target, c.username, false, false).
				Count(&unread)
		}
		infos = append(infos, ConvInfo{
			Target:   cv.Target,
			LastMsg:  cv.LastMsg,
			LastTime: cv.LastTime.Unix(),
			Unread:   unread,
			Pinned:   cv.Pinned,
		})
	}

	content, _ := json.Marshal(infos)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeConvList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// notifyConvUpdate 在线时向指定用户推送会话列表（推送其全部在线连接，多端同步）
// 原实现：仅推送单一连接
func (s *Server) notifyConvUpdate(username string) {
	for _, c := range s.hub.GetAll(username) {
		s.pushConvList(c)
	}
}

// handleConvPin 会话置顶/取消置顶
func (s *Server) handleConvPin(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空
	pin := msg.Content == "pin"
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("pinned", pin)
	if pin {
		s.sendError(c, "已置顶该会话")
	} else {
		s.sendError(c, "已取消置顶")
	}
	s.pushConvList(c)
}

// convMessageQuery 构建指定会话的消息范围查询（target 为空表示群聊）
func convMessageQuery(userID, target string) *gorm.DB {
	query := store.DB.Model(&model.Message{})
	if target == "" {
		// 群聊：全部群消息
		return query.Where("msg_type = ?", 1)
	}
	// 私聊：双方互发的消息
	return query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		2, userID, target, target, userID)
}

// handleConvClear 会话清空：将该会话全部消息标记为当前用户已删除（复用消息删除表，云端记录保留）
// 同时清空未读与会话摘要，保留会话行与最后时间，避免列表排序跳动
func (s *Server) handleConvClear(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 查询会话范围内全部消息 ID
	var ids []uint
	convMessageQuery(c.username, target).Pluck("id", &ids)
	if len(ids) > 0 {
		// 排除已存在于删除表的记录，避免重复插入
		var exist []uint
		store.DB.Model(&model.MessageDelete{}).
			Where("user_id = ? AND msg_id IN ?", c.username, ids).
			Pluck("msg_id", &exist)
		existSet := make(map[uint]bool, len(exist))
		for _, id := range exist {
			existSet[id] = true
		}
		var records []model.MessageDelete
		for _, id := range ids {
			if !existSet[id] {
				records = append(records, model.MessageDelete{UserID: c.username, MsgID: id})
			}
		}
		if len(records) > 0 {
			store.DB.CreateInBatches(&records, 500)
		}
	}

	// 清空未读：对方发给我的未读消息标记为已读
	if target != "" {
		store.DB.Model(&model.Message{}).
			Where("from_user = ? AND to_user = ? AND is_read = ?", target, c.username, false).
			Update("is_read", true)
	}

	// 清空会话摘要（保留会话行，云端记录不受影响）
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("last_msg", "")

	s.sendError(c, "聊天记录已清空")
	s.pushConvList(c)
}

// handleConvDelete 会话删除：从会话列表移除该会话（云端聊天记录保留，收到新消息时会话自动重建）
// 同时将未读清零，避免下次会话重建时旧未读重新出现
func (s *Server) handleConvDelete(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 删除会话记录
	store.DB.Where("user_id = ? AND target = ?", c.username, target).Delete(&model.Conversation{})

	// 未读清零：对方发给我的未读消息标记为已读
	if target != "" {
		store.DB.Model(&model.Message{}).
			Where("from_user = ? AND to_user = ? AND is_read = ?", target, c.username, false).
			Update("is_read", true)
	}

	s.sendError(c, "会话已删除")
	s.pushConvList(c)
}
