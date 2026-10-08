package server

// ===== 阶段二百六十八：位置消息与实时位置共享（微信同款，高德地图 GCJ-02 坐标系） =====
// 归口原则（对齐红包/通话工程惯例）：
//   1. 静态位置（104）：客户端经高德 JS API 选点后上行，服务端仅校验关系链（黑名单/群成员）
//      并走私聊/群聊普通消息链路落库转发——坐标是用户主动发送的内容，随 im_message 持久化
//   2. 实时共享（105）：纯信令不落库，房间态仅内存（locRooms map）。坐标高频更新若落库会
//      淹没消息表（5s/次/人），重启丢失可接受——客户端收不到 state 自动收口，重新加入即可；
//      房间过期（60 分钟）由后台扫描协程统一清理并广播 ended
//   3. 房间锁与 callMu 同风格：全局 s.locMu 保护（房间数量级小，粒度换简单）
//   4. 断线处理：成员 WS 断开不主动移除（对齐微信——短暂断网不退出共享），坐标超 30 秒
//      未更新标记 stale 前端置灰；重连后客户端重新 join（幂等）恢复上报

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
)

// 位置共享业务参数（微信同款口径）
const (
	locRoomTTL    = 60 * time.Minute // 房间默认时长（到期自动结束，微信同款上限）
	locStaleAfter = 30 * time.Second // 成员坐标超时未更新视为 stale（前端置灰）
	locSweepTick  = 30 * time.Second // 过期房间扫描周期
)

// locMember 共享成员：坐标 GCJ-02 + 最近上报时刻
type locMember struct {
	Lat      float64
	Lng      float64
	UpdateAt time.Time
}

// locRoom 共享房间：GroupID>0 为群房间（ToUser 恒空），否则为私聊房间（ToUser=对方账号）
type locRoom struct {
	ID        string
	GroupID   uint
	ToUser    string
	Creator   string
	CreatedAt time.Time
	ExpireAt  time.Time
	Members   map[string]*locMember
}

// locMemberView 下行成员坐标视图（stale 服务端算好，前端零计算）
type locMemberView struct {
	Username string  `json:"username"`
	Name     string  `json:"name"`
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	TS       int64   `json:"ts"`
	Stale    bool    `json:"stale"`
}

// locEnvelope 下行统一信封（105 帧 content）
type locEnvelope struct {
	Action   string          `json:"action"`
	RoomID   string          `json:"room_id"`
	GroupID  uint            `json:"group_id,omitempty"`
	ToUser   string          `json:"to_user,omitempty"`
	FromUser string          `json:"from_user,omitempty"`
	Members  []locMemberView `json:"members,omitempty"`
	Reason   string          `json:"reason,omitempty"`
}

// locRoomTarget 房间会话目标编码（与会话列表 target 一致：对方账号 或 "g"+群ID）
func (r *locRoom) target() string {
	if r.GroupID > 0 {
		return fmt.Sprintf("g%d", r.GroupID)
	}
	return r.ToUser
}

// startLocSweeper 房间过期扫描协程（NewServer 启动，30 秒周期）
func (s *Server) startLocSweeper() {
	go func() {
		tick := time.NewTicker(locSweepTick)
		defer tick.Stop()
		for range tick.C {
			s.locSweep()
		}
	}()
}

// locSweep 扫描过期房间：广播 ended 并删除（发起方未主动 end 的兜底收口）
func (s *Server) locSweep() {
	now := time.Now()
	s.locMu.Lock()
	defer s.locMu.Unlock()
	for id, room := range s.locRooms {
		if now.After(room.ExpireAt) {
			delete(s.locRooms, id)
			s.locBroadcastLocked(room, "ended", "")
			logger.Info("位置共享房间 %s 到期自动结束（发起 %s）", id, room.Creator)
		}
	}
}

// locPushStarted 房间建立时推送 started（前端渲染共享入口/加入卡片）：
// 发起者必收（回执携带 room_id，据此进入共享面板并开始 update 上报）；
// 私聊推对方；群聊推除发起者外的全部在线成员（离线不补——上线后重新发起即可）
func (s *Server) locPushStarted(room *locRoom, from string) {
	env := locEnvelope{
		Action:   "started",
		RoomID:   room.ID,
		GroupID:  room.GroupID,
		ToUser:   room.ToUser,
		FromUser: from,
	}
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeLocationShare,
		FromUser:  from,
		FromName:  nicknameOf(from),
		ToUser:    room.target(),
		Content:   string(mustJSON(env)),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(from, data) // 发起者回执（room_id 归口）
	if room.GroupID > 0 {
		for _, name := range getGroupMemberIDs(room.GroupID) {
			if name != from && s.isOnlineFast(name) {
				s.sendToUser(name, data)
			}
		}
		return
	}
	if s.isOnlineFast(room.ToUser) {
		s.sendToUser(room.ToUser, data)
	}
}

// locBroadcastLocked 房间成员表广播（调用方须持 s.locMu）；exclude 为触发者自身时不再回推
func (s *Server) locBroadcastLocked(room *locRoom, action, exclude string) {
	members := make([]locMemberView, 0, len(room.Members))
	now := time.Now()
	for name, m := range room.Members {
		members = append(members, locMemberView{
			Username: name,
			Name:     nicknameOf(name),
			Lat:      m.Lat,
			Lng:      m.Lng,
			TS:       m.UpdateAt.Unix(),
			Stale:    now.Sub(m.UpdateAt) > locStaleAfter,
		})
	}
	env := locEnvelope{
		Action:  action,
		RoomID:  room.ID,
		GroupID: room.GroupID,
		ToUser:  room.ToUser,
		Members: members,
	}
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeLocationShare,
		ToUser:    room.target(),
		Content:   string(mustJSON(env)),
		Timestamp: now.Unix(),
	})
	for name := range room.Members {
		if name == exclude {
			continue
		}
		if s.isOnlineFast(name) {
			s.sendToUser(name, data)
		}
	}
}

// HandleLocationShare 位置共享信令入口（msg_type=105，action 分发）
func (s *Server) HandleLocationShare(c *Client, msg *protocol.Message) {
	if s.cfg.AmapKey == "" {
		s.sendError(c, "管理员未配置地图服务，位置共享不可用")
		return
	}
	var p struct {
		Action  string  `json:"action"`
		RoomID  string  `json:"room_id"`
		ToUser  string  `json:"to_user"`
		GroupID uint    `json:"group_id"`
		Lat     float64 `json:"lat"`
		Lng     float64 `json:"lng"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "位置共享参数错误")
		return
	}
	switch p.Action {
	case "start":
		s.locHandleStart(c, p.ToUser, p.GroupID)
	case "join":
		s.locHandleJoin(c, p.RoomID)
	case "leave":
		s.locHandleLeave(c, p.RoomID)
	case "update":
		s.locHandleUpdate(c, p.RoomID, p.Lat, p.Lng)
	case "end":
		s.locHandleEnd(c, p.RoomID)
	default:
		s.sendError(c, "未知位置共享操作")
	}
}

// locHandleStart 发起共享：私聊校验对方存在且关系链正常；群聊校验成员资格。
// 同发起者同目标已有活跃房间则幂等复用（重试/断线重连重新 start 不重复建房）
func (s *Server) locHandleStart(c *Client, toUser string, groupID uint) {
	from := c.username
	if groupID > 0 {
		if !isGroupMember(groupID, from) {
			s.sendError(c, "你不是该群成员，无法发起位置共享")
			return
		}
	} else {
		toUser = strings.TrimSpace(toUser)
		if toUser == "" || toUser == from {
			s.sendError(c, "位置共享缺少接收方")
			return
		}
		if aiAgentForUser(toUser, from) != nil {
			s.sendError(c, "智能体不支持位置共享")
			return
		}
		if s.isBlocked(from, toUser) {
			s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发起位置共享")
			return
		}
		if _, err := userPoints(toUser); err != nil {
			s.sendError(c, "对方不存在，无法发起位置共享")
			return
		}
	}

	s.locMu.Lock()
	defer s.locMu.Unlock()
	// 幂等：同发起者同目标已有活跃房间 → 复用（重新推送 started 入口给对方）
	for _, room := range s.locRooms {
		if room.Creator == from && room.GroupID == groupID && room.ToUser == toUser {
			s.locPushStarted(room, from)
			return
		}
	}
	room := &locRoom{
		ID:        fmt.Sprintf("loc_%d_%04d", time.Now().UnixNano()/int64(time.Millisecond), rand.Intn(10000)),
		GroupID:   groupID,
		ToUser:    toUser,
		Creator:   from,
		CreatedAt: time.Now(),
		ExpireAt:  time.Now().Add(locRoomTTL),
		Members:   map[string]*locMember{from: {UpdateAt: time.Now()}},
	}
	s.locRooms[room.ID] = room
	s.locPushStarted(room, from)
	logger.Info("位置共享房间 %s 建立：%s → %s", room.ID, from, room.target())
}

// locHandleJoin 加入共享：私聊仅对方可加入；群聊仅群成员可加入；已在房幂等（直接回 state）
func (s *Server) locHandleJoin(c *Client, roomID string) {
	s.locMu.Lock()
	defer s.locMu.Unlock()
	room, ok := s.locRooms[roomID]
	if !ok {
		s.sendError(c, "位置共享已结束")
		return
	}
	if c.username != room.Creator && c.username != room.ToUser && !isGroupMember(room.GroupID, c.username) {
		s.sendError(c, "你不在该位置共享范围内")
		return
	}
	if _, ok := room.Members[c.username]; !ok {
		room.Members[c.username] = &locMember{UpdateAt: time.Now()}
	}
	s.locBroadcastLocked(room, "state", "")
}

// locHandleLeave 主动退出：移除自己并广播剩余成员；全员走光自动删房
func (s *Server) locHandleLeave(c *Client, roomID string) {
	s.locMu.Lock()
	defer s.locMu.Unlock()
	room, ok := s.locRooms[roomID]
	if !ok {
		return // 已结束，静默（客户端态以 ended 为准）
	}
	if _, ok := room.Members[c.username]; !ok {
		return
	}
	delete(room.Members, c.username)
	if len(room.Members) == 0 {
		delete(s.locRooms, roomID)
		logger.Info("位置共享房间 %s 全员退出自动结束", roomID)
		return
	}
	s.locBroadcastLocked(room, "state", c.username)
}

// locHandleUpdate 坐标上报：仅成员可上报；坐标范围校验（GPS 漂移脏数据静默丢弃）；
// 更新后广播成员表（帧体仅成员坐标，5s 周期无压力）
func (s *Server) locHandleUpdate(c *Client, roomID string, lat, lng float64) {
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return
	}
	s.locMu.Lock()
	defer s.locMu.Unlock()
	room, ok := s.locRooms[roomID]
	if !ok {
		return // 房间已结束，静默丢弃（客户端随后收 sweeper/end 的 ended 帧收口）
	}
	m, ok := room.Members[c.username]
	if !ok {
		return
	}
	m.Lat, m.Lng, m.UpdateAt = lat, lng, time.Now()
	s.locBroadcastLocked(room, "state", "")
}

// locHandleEnd 结束共享：仅发起方可结束；广播 ended 后删房
func (s *Server) locHandleEnd(c *Client, roomID string) {
	s.locMu.Lock()
	defer s.locMu.Unlock()
	room, ok := s.locRooms[roomID]
	if !ok {
		return
	}
	if c.username != room.Creator {
		s.sendError(c, "仅发起方可以结束位置共享")
		return
	}
	delete(s.locRooms, roomID)
	s.locBroadcastLocked(room, "ended", "")
	logger.Info("位置共享房间 %s 由发起方 %s 结束", roomID, room.Creator)
}

// handleLocationSend 静态位置消息上行（msg_type=104，content 为 JSON：{loc:{lat,lng,name,address}}）。
// 校验关系链后以 104 信封落库并按私聊/群聊链路转发（对齐红包 86 链路）
func (s *Server) handleLocationSend(c *Client, msg *protocol.Message) {
	if s.cfg.AmapKey == "" {
		s.sendError(c, "管理员未配置地图服务，位置消息不可用")
		return
	}
	var p struct {
		Loc struct {
			Lat     float64 `json:"lat"`
			Lng     float64 `json:"lng"`
			Name    string  `json:"name"`
			Address string  `json:"address"`
		} `json:"loc"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "位置消息参数错误")
		return
	}
	if p.Loc.Lat < -90 || p.Loc.Lat > 90 || p.Loc.Lng < -180 || p.Loc.Lng > 180 {
		s.sendError(c, "位置坐标无效")
		return
	}
	// 位置名称按 rune 裁剪（POI 名可能超长，且须避免多字节字符截断破坏 UTF-8）
	name := []rune(strings.TrimSpace(p.Loc.Name))
	if len(name) > 64 {
		name = name[:64]
	}
	if len(name) == 0 {
		s.sendError(c, "位置名称为空，无法发送")
		return
	}
	if msg.ToUser == "" {
		s.sendError(c, "位置消息缺少接收方")
		return
	}
	if msg.ToUser == c.username {
		s.sendError(c, "不能给自己发送位置")
		return
	}
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.sendError(c, "智能体不支持位置消息")
		return
	}

	var groupID uint
	if gid, ok := isGroupTarget(msg.ToUser); ok {
		if !isGroupMember(gid, c.username) {
			s.sendError(c, "你不是该群成员，无法发送位置")
			return
		}
		groupID = gid
	} else if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送位置")
		return
	}

	// 落库信封（坐标+名称+地址；历史渲染按 msg_type=104 出位置气泡）
	envelope, _ := json.Marshal(map[string]interface{}{
		"loc": map[string]interface{}{
			"lat":     p.Loc.Lat,
			"lng":     p.Loc.Lng,
			"name":    string(name),
			"address": p.Loc.Address,
		},
	})
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeLocation,
		FromUser:  c.username,
		FromName:  nicknameOf(c.username),
		ToUser:    msg.ToUser,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	record := model.Message{
		MsgType:  int8(protocol.MsgTypeLocation),
		FromUser: chatMsg.FromUser,
		ToUser:   chatMsg.ToUser,
		Content:  chatMsg.Content,
	}
	record.ID = s.persistMessage(&record)
	if record.ID == 0 {
		logger.Error("位置消息落库失败（用户 %s → %s）", c.username, msg.ToUser)
		s.sendError(c, "位置发送失败，请重试")
		return
	}
	chatMsg.MsgID = record.ID
	data, _ := json.Marshal(chatMsg)
	summary := "[位置] " + string(name)

	if groupID > 0 {
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
	logger.Info("位置消息：%s → %s（%.6f, %.6f %s）", c.username, msg.ToUser, p.Loc.Lat, p.Loc.Lng, string(name))
}
