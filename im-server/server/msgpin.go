package server

import (
	"encoding/json"
	"strings"
	"time"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"

	"gorm.io/gorm/clause"
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

// convKey 会话键：全局群固定 group，多人群用群编码（g+群ID），私聊按字典序拼接双方用户名（同一会话双方计算结果一致）
// 阶段二百六十八：多人群会话（to_user='g'+群ID）归一群编码键——原实现按私聊拼接生成
// 'user|g123' 错误键，群消息置顶写库/联动清理/登录恢复全部失配（群置顶功能完全失效）
func convKey(self, target string) string {
	if target == "" {
		return "group"
	}
	if groupIDFromTarget(target) != 0 {
		return target
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
		if gid := groupIDFromTarget(target); gid != 0 {
			// 阶段二百六十八：多人群会话——消息须为本群消息（群消息以 to_user='g'+群ID 落库）
			if record.MsgType != 1 || record.ToUser != target {
				s.sendError(c, "消息不属于当前会话")
				return
			}
		} else if target == "" {
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
		// 通话/会议信封消息（{"type":"call",...}）以私聊文本类型落库（call.go 话单归口），
		// 类型校验拦不住——无置顶语义（微信同款），按信封结构拒绝（红包卡片同口径分层拦截）
		var envProbe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(record.Content), &envProbe); err == nil && envProbe.Type == "call" {
			s.sendError(c, "该消息不支持置顶")
			return
		}
		// 每个会话仅一条置顶：存在则替换，不存在则创建
		var existing model.MessagePin
		if err := store.DB.Where("conv_key = ?", key).First(&existing).Error; err == nil {
			// 阶段十三增强：置顶幂等——同一消息重复置顶时跳过写库与同步，
			// 防止重复操作引起的冗余写库与双方全部设备的重复推送
			// 原实现：无条件 Updates+同步，重复置顶同一消息会重复写库并重复推送
			if existing.MsgID == record.ID {
				s.sendError(c, "消息已在置顶中")
				return
			}
		}
		// 阶段十六增强：置顶写库并发安全——按会话键原子 upsert（唯一键冲突时更新），
		// 多端并发置顶不同消息时后写者胜出且仅保留一行，避免"先查后写"竞态撞唯一索引静默失败
		// 原实现：First→Create/Updates 两步写库且错误未检查，并发下第二个请求撞 conv_key 唯一索引后静默失败，提示与真实状态不一致
		if err := store.DB.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "conv_key"}},
			DoUpdates: clause.AssignmentColumns([]string{"msg_id", "pin_user"}),
		}).Create(&model.MessagePin{ConvKey: key, MsgID: record.ID, PinUser: c.username}).Error; err != nil {
			s.sendError(c, "置顶失败，请稍后重试")
			return
		}
		s.sendError(c, "消息已置顶")
	} else {
		// 阶段十三增强：取消置顶幂等——无置顶记录时跳过删库与同步，
		// 防止重复取消引起的冗余删库与双方全部设备的重复推送
		// 原实现：无条件 Delete+同步，重复取消置顶会重复删库并重复推送
		var count int64
		store.DB.Model(&model.MessagePin{}).Where("conv_key = ?", key).Count(&count)
		if count == 0 {
			s.sendError(c, "已取消置顶")
			return
		}
		// 阶段十六增强：取消置顶写库错误检查，失败时不误报成功也不触发同步
		// 原实现：Delete 错误未检查，失败时仍提示成功并同步错误状态
		if err := store.DB.Where("conv_key = ?", key).Delete(&model.MessagePin{}).Error; err != nil {
			s.sendError(c, "取消置顶失败，请稍后重试")
			return
		}
		s.sendError(c, "已取消置顶")
	}

	// 推送置顶状态给会话双方（群聊广播）
	s.syncPinByKey(key)
}

// syncPinByKey 按会话键推送置顶状态：多人群定向推送群成员，全局群广播，私聊推送给双方
func (s *Server) syncPinByKey(key string) {
	info := s.buildPinInfo(key)
	if key == "group" {
		// 全局群：全体广播，会话目标为空
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
	// 阶段二百六十八：多人群会话键（g+群ID）→ 定向推送全体群成员（各成员视角 Target=群编码，
	// 与前端 currentChatUser 群编码一致），成员离线者登录时由 pushPinList 补发
	if gid := groupIDFromTarget(key); gid != 0 {
		info.Target = key
		data, _ := json.Marshal(info)
		out, _ := json.Marshal(protocol.Message{
			MsgType:   protocol.MsgTypeMsgPinSync,
			ToUser:    key,
			Content:   string(data),
			Timestamp: time.Now().Unix(),
		})
		s.sendToGroupMembers(getGroupMemberIDs(gid), out)
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
		// 集群模式：isOnlineFast 全局判定（跨实例在线经总线定向信封送达，原本地 Count 门限会漏推）
		if s.isOnlineFast(u) {
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
// 阶段二百六十八：补发多人群会话（conv_key='g'+群ID）置顶——原查询仅覆盖全局群与私聊键，
// 群成员重登录后群置顶条丢失
func (s *Server) pushPinList(c *Client) {
	var pins []model.MessagePin
	store.DB.Where("conv_key = ? OR conv_key REGEXP '^g[0-9]+$' OR conv_key LIKE ? OR conv_key LIKE ?",
		"group", c.username+"|%", "%|"+c.username).Find(&pins)

	for _, p := range pins {
		// 多人群：登录者须为群成员，按群编码视角推送（buildPinInfo 重新查询可校验撤回状态）
		if gid := groupIDFromTarget(p.ConvKey); gid != 0 {
			if !isGroupMember(gid, c.username) {
				continue
			}
			info := s.buildPinInfo(p.ConvKey)
			info.Target = p.ConvKey
			data, _ := json.Marshal(info)
			out, _ := json.Marshal(protocol.Message{
				MsgType:   protocol.MsgTypeMsgPinSync,
				ToUser:    p.ConvKey,
				Content:   string(data),
				Timestamp: time.Now().Unix(),
			})
			c.send(out)
			continue
		}
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

// clearPinForConv 会话维度清理置顶记录并同步双方（阶段十六：删除好友/拉黑联动取消置顶）
// 关系终止属会话级事件，无论置顶人是谁均整条清理，防止关系终止后置顶条残留（孤儿置顶）
// 原实现：删除好友/拉黑仅删 im_friend/im_blacklist 记录，置顶记录残留导致双方重登仍还原置顶条
func (s *Server) clearPinForConv(self, target string) {
	key := convKey(self, target)
	var count int64
	store.DB.Model(&model.MessagePin{}).Where("conv_key = ?", key).Count(&count)
	if count == 0 {
		return
	}
	store.DB.Where("conv_key = ?", key).Delete(&model.MessagePin{})
	s.syncPinByKey(key)
}
