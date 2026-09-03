package server

import (
	"encoding/json"
	"strings"
	"time"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// PinMsgInfo 推送给前端的置顶消息信息（MsgID=0 表示该会话无置顶消息）
type PinMsgInfo struct {
	Target     string `json:"target"`      // 前端会话目标（群聊为空）
	MsgID      uint   `json:"msg_id"`      // 置顶消息 ID
	FromUser   string `json:"from_user"`   // 置顶消息发送者
	Content    string `json:"content"`     // 置顶消息内容
	CreateTime int64  `json:"create_time"` // 置顶消息时间戳
	PinUser    string `json:"pin_user"`    // 置顶操作人
}

// convKey 会话键：群聊固定 group，私聊按字典序拼接双方用户名（同一会话双方计算结果一致）
func convKey(self, target string) string {
	if target == "" {
		return "group"
	}
	if self < target {
		return self + "|" + target
	}
	return target + "|" + self
}

// handleMsgPin 消息置顶/取消置顶：每个会话仅保留一条置顶消息，新置顶自动替换旧置顶
func (s *Server) handleMsgPin(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空
	pin := msg.Content == "pin"
	key := convKey(c.username, target)

	if pin {
		if msg.MsgID == 0 {
			s.sendError(c, "置顶消息无效")
			return
		}
		// 校验消息存在且未撤回
		var record model.Message
		if err := store.DB.First(&record, msg.MsgID).Error; err != nil {
			s.sendError(c, "消息不存在")
			return
		}
		if record.Recalled {
			s.sendError(c, "已撤回的消息不能置顶")
			return
		}
		// 校验消息归属当前会话（群聊消息或双方互发的私聊消息）
		if target == "" {
			if record.MsgType != 1 {
				s.sendError(c, "消息不属于当前会话")
				return
			}
		} else {
			isRelated := (record.FromUser == c.username && record.ToUser == target) ||
				(record.FromUser == target && record.ToUser == c.username)
			if record.MsgType != 2 || !isRelated {
				s.sendError(c, "消息不属于当前会话")
				return
			}
		}
		// 每个会话仅一条置顶：存在则替换，不存在则创建
		var count int64
		store.DB.Model(&model.MessagePin{}).Where("conv_key = ?", key).Count(&count)
		if count > 0 {
			store.DB.Model(&model.MessagePin{}).Where("conv_key = ?", key).
				Updates(map[string]interface{}{"msg_id": record.ID, "pin_user": c.username})
		} else {
			store.DB.Create(&model.MessagePin{ConvKey: key, MsgID: record.ID, PinUser: c.username})
		}
		s.sendError(c, "消息已置顶")
	} else {
		store.DB.Where("conv_key = ?", key).Delete(&model.MessagePin{})
		s.sendError(c, "已取消置顶")
	}

	// 推送置顶状态给会话双方（群聊广播）
	s.syncPinByKey(key)
}

// syncPinByKey 按会话键推送置顶状态：群聊广播全体，私聊推送给双方
func (s *Server) syncPinByKey(key string) {
	info := s.buildPinInfo(key)
	if key == "group" {
		// 群聊：全体广播，会话目标为空
		info.Target = ""
		data, _ := json.Marshal(info)
		out, _ := json.Marshal(protocol.Message{
			MsgType:   protocol.MsgTypeMsgPinSync,
			Content:   string(data),
			Timestamp: time.Now().Unix(),
		})
		s.hub.Broadcast(out)
		return
	}
	// 私聊：分别以双方的视角推送（各自会话目标为对方）
	parts := strings.SplitN(key, "|", 2)
	if len(parts) != 2 {
		return
	}
	for _, u := range parts {
		other := parts[0]
		if u == parts[0] {
			other = parts[1]
		}
		view := info
		view.Target = other
		data, _ := json.Marshal(view)
		out, _ := json.Marshal(protocol.Message{
			MsgType:   protocol.MsgTypeMsgPinSync,
			ToUser:    other,
			Content:   string(data),
			Timestamp: time.Now().Unix(),
		})
		// 用户任一连接在线则推送其全部连接（多端同步）
		if s.hub.Count(u) > 0 {
			s.sendToUser(u, out)
		}
	}
}

// buildPinInfo 查询会话置顶消息并组装推送信息（无置顶或消息已撤回时 MsgID=0）
func (s *Server) buildPinInfo(key string) PinMsgInfo {
	info := PinMsgInfo{MsgID: 0}
	var mp model.MessagePin
	if err := store.DB.Where("conv_key = ?", key).First(&mp).Error; err != nil {
		return info
	}
	var record model.Message
	if err := store.DB.First(&record, mp.MsgID).Error; err != nil {
		return info
	}
	if record.Recalled {
		return info
	}
	return PinMsgInfo{
		MsgID:      record.ID,
		FromUser:   record.FromUser,
		Content:    record.Content,
		CreateTime: record.CreateTime.Unix(),
		PinUser:    mp.PinUser,
	}
}

// pushPinList 登录时推送当前用户所有会话的置顶消息（服务端归口，多端同步）
func (s *Server) pushPinList(c *Client) {
	var pins []model.MessagePin
	store.DB.Where("conv_key = ? OR conv_key LIKE ? OR conv_key LIKE ?",
		"group", c.username+"|%", "%|"+c.username).Find(&pins)

	for _, p := range pins {
		// 私聊会话按对方视角推送（buildPinInfo 重新查询可校验撤回状态）
		if p.ConvKey == "group" {
			info := s.buildPinInfo(p.ConvKey)
			info.Target = ""
			data, _ := json.Marshal(info)
			out, _ := json.Marshal(protocol.Message{
				MsgType:   protocol.MsgTypeMsgPinSync,
				Content:   string(data),
				Timestamp: time.Now().Unix(),
			})
			c.send(out)
			continue
		}
		parts := strings.SplitN(p.ConvKey, "|", 2)
		if len(parts) != 2 {
			continue
		}
		other := parts[0]
		if c.username == parts[0] {
			other = parts[1]
		}
		info := s.buildPinInfo(p.ConvKey)
		info.Target = other
		data, _ := json.Marshal(info)
		out, _ := json.Marshal(protocol.Message{
			MsgType:   protocol.MsgTypeMsgPinSync,
			ToUser:    other,
			Content:   string(data),
			Timestamp: time.Now().Unix(),
		})
		c.send(out)
	}
}
