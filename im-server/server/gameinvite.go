package server

// ===== 阶段二百九十二：局域网游戏跨公网联机「邀请卡片」（微信同款聊天卡片入口，msg_type=111） =====
// 链路归口（对齐位置 104 / 名片 107 的普通消息链路，资金无关故走轻量校验）：
//   1. 上行仅携带房间号 {invite:{room_id}}，房名/房主/端口/人数由服务端读房间态（Redis）富化后落库——
//      防伪造（客户端自填房名端口冒充他人房间）与泄漏成员名单（只带人数不带名单）
//   2. 邀请人须为房内成员；群房间仅限同群内邀请（防跨群外泄房间号）
//   3. 被邀请人走关系链校验（群目标=群成员，私聊=黑名单拦截；AI 智能体不支持联机）
//   4. 落库 msg_type=111 后按私聊/群聊链路转发（气泡渲染与会话摘要均为服务端归口）；
//      房间解散/超时后卡片点击由客户端自行收口（服务端不追改历史卡片）
//
// 注：房间态（房名/房主/端口/人数）以 Redis 房间键为准，此处只读不写，与 gamenet.go 共用键编码。

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// gnInviteCard 落库/下行信封体（前端按 msg_type=111 出邀请卡片气泡）
type gnInviteCard struct {
	RoomID   string `json:"room_id"`
	RoomName string `json:"room_name,omitempty"`
	Host     string `json:"host,omitempty"`
	HostName string `json:"host_name,omitempty"`
	HostPort int    `json:"host_port,omitempty"`
	Status   string `json:"status,omitempty"`
	Count    int    `json:"count,omitempty"`
}

// handleGameInviteSend 联机邀请卡片上行（msg_type=111，content 为 JSON：{invite:{room_id}}，
// to_user=收件人私聊账号 或 "gN" 群号）。校验后读房间态富化信封 → 落库 → 按私聊/群聊链路转发
func (s *Server) handleGameInviteSend(c *Client, msg *protocol.Message) {
	if !s.cfg.GameNet.Enabled {
		s.sendError(c, "游戏联机未启用")
		return
	}
	// 阶段二百九十五扩展：后台「功能开关」停用游戏中心时邀请信令同步拒绝（硬禁用归口 features.go）
	if !uiFeatureEnabled("game_center") {
		s.sendError(c, "游戏中心已被管理员停用")
		return
	}
	var p struct {
		Invite struct {
			RoomID string `json:"room_id"`
		} `json:"invite"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "联机邀请参数错误")
		return
	}
	roomID := strings.TrimSpace(p.Invite.RoomID)
	if roomID == "" {
		s.sendError(c, "联机邀请缺少房间号")
		return
	}
	if msg.ToUser == "" {
		s.sendError(c, "联机邀请缺少接收方")
		return
	}
	if msg.ToUser == c.username {
		s.sendError(c, "不能给自己发送联机邀请")
		return
	}
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.sendError(c, "智能体不支持联机邀请")
		return
	}

	// 关系链校验（群目标=群成员；私聊=黑名单拦截），对齐名片 107 口径
	var groupID uint
	if gid, ok := isGroupTarget(msg.ToUser); ok {
		if !isGroupMember(gid, c.username) {
			s.sendError(c, "你不是该群成员，无法发送联机邀请")
			return
		}
		groupID = gid
	} else if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送联机邀请")
		return
	}

	// 房间态读取（唯一数据源）：不存在/已解散直接拒绝
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散，无法邀请")
		return
	}
	// 邀请人须为房内成员（房外人员不得替他人拉人）
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), c.username).Result(); !ok {
		s.sendError(c, "你不在该房间内，无法邀请")
		return
	}
	// 群房间仅限同群内邀请（房间号不得外泄到其他会话）
	if roomGID, _ := strconv.Atoi(meta["group_id"]); roomGID > 0 && uint(roomGID) != groupID {
		s.sendError(c, "该房间为群房间，请在群聊内邀请")
		return
	}

	host := meta["host"]
	roomName := meta["name"]
	if strings.TrimSpace(roomName) == "" {
		roomName = roomID
	}
	hostPort, _ := strconv.Atoi(meta["host_port"])
	count, _ := store.RDB.HLen(ctx, gnMemberKey(roomID)).Result()
	card := gnInviteCard{
		RoomID:   roomID,
		RoomName: roomName,
		Host:     host,
		HostName: nicknameOf(host),
		HostPort: hostPort,
		Status:   meta["status"],
		Count:    int(count),
	}
	envelope, _ := json.Marshal(map[string]interface{}{"invite": card})

	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeGameInvite,
		FromUser:  c.username,
		FromName:  nicknameOf(c.username),
		ToUser:    msg.ToUser,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	record := model.Message{
		MsgType:  int8(protocol.MsgTypeGameInvite),
		FromUser: chatMsg.FromUser,
		ToUser:   chatMsg.ToUser,
		Content:  chatMsg.Content,
	}
	record.ID = s.persistMessage(&record)
	if record.ID == 0 {
		logger.Error("联机邀请落库失败（用户 %s → %s，房间 %s）", c.username, msg.ToUser, roomID)
		s.sendError(c, "邀请发送失败，请重试")
		return
	}
	chatMsg.MsgID = record.ID
	data, _ := json.Marshal(chatMsg)
	summary := "[联机邀请] " + roomName

	if groupID > 0 {
		// 群邀请：按成员定向广播 + 离线入队 + 会话摘要（对齐 handleMultiGroupChat 链路）
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
		// 私聊邀请：双方定向推送（多端同步）+ 离线入队 + 会话摘要（对齐 handlePrivateChat 链路）
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
	logger.Info("联机邀请：%s → %s（房间 %s %s）", c.username, msg.ToUser, roomID, roomName)
}
