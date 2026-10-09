package server

// ===== 阶段二百七十六：联系人名片推荐（微信同款"个人名片"） =====
// 链路归口（对齐位置 104 / 红包 86 的普通消息链路，资金无关故走轻量校验）：
//   1. 上行仅携带被推荐账号 {user:"用户名"}，昵称/头像由服务端查库富化后以快照落库——
//      防伪造（客户端自填昵称头像冒充他人）与昵称漂移（改昵称后历史名片保持当时快照）
//   2. 被推荐账号须为真实注册用户（AI 智能体与不存在账号拒绝）；允许推荐自己（微信同款）
//   3. 落库 msg_type=107 后按私聊/群聊链路转发，气泡渲染与会话摘要均为服务端归口
//   4. 点击名片走 PROFILE_QUERY(38) 复用资料卡，非好友可直接"添加到通讯录"——
//      名片推荐即好友裂变入口，资料卡三态（好友/非好友/已注销）由既有链路自洽处理

import (
	"encoding/json"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// handleContactCardSend 名片消息上行（msg_type=107，content 为 JSON：{user}，to_user=收件人/gN 群号）。
// 校验被推荐用户存在 → 查库富化 name/avatar 快照 → 落库转发（气泡 + 会话摘要）
func (s *Server) handleContactCardSend(c *Client, msg *protocol.Message) {
	var p struct {
		User string `json:"user"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "名片消息参数错误")
		return
	}
	target := strings.TrimSpace(p.User)
	if target == "" {
		s.sendError(c, "名片缺少被推荐联系人")
		return
	}
	if msg.ToUser == "" {
		s.sendError(c, "名片消息缺少接收方")
		return
	}
	// AI 智能体目标拦截（智能体无资料卡入口，不能作为名片接收方）
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.sendError(c, "智能体不支持名片消息")
		return
	}

	// 群名片成员校验（私聊走黑名单校验）
	var groupID uint
	if gid, ok := isGroupTarget(msg.ToUser); ok {
		if !isGroupMember(gid, c.username) {
			s.sendError(c, "你不是该群成员，无法发送名片")
			return
		}
		groupID = gid
	} else if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送名片")
		return
	}

	// 被推荐账号校验：须为真实注册用户（不存在/AI 智能体拒绝；允许推荐自己——微信同款）
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		s.sendError(c, "该用户不存在，无法推荐")
		return
	}
	if aiAgentByName(u.Username) != nil {
		s.sendError(c, "智能体不支持被推荐")
		return
	}
	// 富化快照：昵称空回退账号（对齐 displayNameOf 口径），头像原样快照
	name := u.Nickname
	if strings.TrimSpace(name) == "" {
		name = u.Username
	}

	// 落库信封（user/name/avatar 快照；历史渲染按 msg_type=107 出名片气泡）
	envelope, _ := json.Marshal(map[string]interface{}{
		"user":   u.Username,
		"name":   name,
		"avatar": u.Avatar,
	})
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeContactCard,
		FromUser:  c.username,
		FromName:  nicknameOf(c.username),
		ToUser:    msg.ToUser,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	record := model.Message{
		MsgType:  int8(protocol.MsgTypeContactCard),
		FromUser: chatMsg.FromUser,
		ToUser:   chatMsg.ToUser,
		Content:  chatMsg.Content,
	}
	record.ID = s.persistMessage(&record)
	if record.ID == 0 {
		logger.Error("名片消息落库失败（用户 %s → %s）", c.username, msg.ToUser)
		s.sendError(c, "名片发送失败，请重试")
		return
	}
	chatMsg.MsgID = record.ID
	data, _ := json.Marshal(chatMsg)
	summary := "[联系人] " + name

	if groupID > 0 {
		// 群名片：按成员定向广播 + 离线入队 + 会话摘要（对齐 handleMultiGroupChat 链路）
		memberIDs := getGroupMemberIDs(groupID)
		s.sendToGroupMembers(memberIDs, data)
		for _, uname := range memberIDs {
			if uname != c.username && !s.isOnlineFast(uname) {
				s.queueOffline(uname, &chatMsg)
			}
			if s.isOnlineFast(uname) {
				s.touchConversation(uname, msg.ToUser, summary)
				s.notifyConvUpdate(uname)
			}
		}
	} else {
		// 私聊名片：双方定向推送（多端同步）+ 离线入队 + 会话摘要（对齐 handlePrivateChat 链路）
		if s.isOnlineFast(msg.ToUser) {
			s.sendToUser(msg.ToUser, data)
		} else {
			s.queueOffline(msg.ToUser, &chatMsg)
		}
		s.sendToUser(c.username, data)
		s.touchConversation(c.username, msg.ToUser, summary)
		s.touchConversation(msg.ToUser, c.username, summary)
		s.notifyConvUpdate(c.username)
		s.notifyConvUpdate(msg.ToUser)
	}
	logger.Info("名片消息：%s → %s（推荐 %s）", c.username, msg.ToUser, u.Username)
}
