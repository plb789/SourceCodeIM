package server

// ===== 阶段一百四十四：多人音视频会议（一期：群内发起 Mesh 网格架构，PC 端） =====
// 复用 msg_type=70 通话信令通道，新增 meet_* 动作族；媒体面全员两两 P2P 直连（Mesh），
// 服务端零媒体参与，TURN 中继兜底与 1v1 通话同源（callInjectICE）。
// 职责划分（服务端数据归口）：
//   1. 房间状态：内存房间表（发起人/类型/群ID/已入会/响铃中）——忙判定与 1v1 共用 callUserBusy
//   2. 成员资料：meet_join/room_info 帧携带昵称/头像（服务端归口查询下发，前端不自行解析）
//   3. 媒体信令：offer/answer/candidate 按 content.target 定向转发（校验双方均为房间成员）
//   4. 话单落库：房间解散（最后一人离开/全员拒绝）时写 im_call_log + 群聊会议信封消息
// 建连方向规则（防 offer 冲突 glare）：已在会成员 → 新加入成员单向发 offer，新成员只应答；
// 加入时间即全序，同帧到达顺序天然满足。
// 阶段一百四十八：Mesh 断网恢复——客户端按 pair 原 offer 方向做成员级 ICE restart（offerer 单点发起，
// answerer 幂等应答）；服务端会议成员信令断开走 meetOfflineGrace 宽限（同 1v1 callOfflineGrace 模式）：
// 期间重连自动取消收口，超时未回按 meetLeave 移出（响铃中被邀人仍立即收口）。

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// meetMaxMembers 会议成员上限（含发起人；Mesh 架构每人上行 N-1 路，控制规模保流畅）
const meetMaxMembers = 8

// meetOfflineGrace 阶段一百四十八：会议成员信令断开的下线宽限期。切网场景信令 WS 闪断（数秒后重连）
// ≠ 媒体断线（媒体走 TURN/UDP 与信令独立），宽限期内重连则参会自动恢复（媒体由客户端成员级
// ICE restart 兜底）；取 30s 与 1v1 callOfflineGrace 及客户端成员看门狗对齐
const meetOfflineGrace = 30 * time.Second

// meetRoom 会议房间（内存态，与 1v1 callSession 同源生命周期：重启即清空，话单已落库不丢历史）
type meetRoom struct {
	ID       string
	Caller   string          // 发起人（退出不结束会议，微信同款）
	CallType string          // audio / video
	GroupID  uint            // 发起群（0=无群关联，一期恒从群发起）
	Members  map[string]bool // 已入会成员（含发起人）
	Invited  map[string]bool // 已邀请响铃中（accept/decline 后移除）
	Started  time.Time       // 首人入会时间（话单计时长起点）
	// offlineTimers 阶段一百四十八：成员断网宽限收口定时器（username → timer；重连上线/退出/解散时清理）
	offlineTimers map[string]*time.Timer
}

var (
	meetMu    sync.RWMutex
	meetRooms = map[string]*meetRoom{} // room_id -> 房间
)

// meetMemberInfo 成员资料（服务端归口：昵称/头像查询下发）
type meetMemberInfo struct {
	Username string `json:"username"`
	Name     string `json:"name"` // 昵称（空昵称前端降级显示账号）
	Avatar   string `json:"avatar"`
}

// meetInfoOf 单成员资料归口（会议邀请为低频路径，直查不缓存）
func meetInfoOf(username string) meetMemberInfo {
	var u model.User
	if err := store.DB.Select("username,nickname,avatar").Where("username = ?", username).First(&u).Error; err != nil {
		return meetMemberInfo{Username: username, Name: username}
	}
	nk := u.Nickname
	if nk == "" {
		nk = u.Username
	}
	return meetMemberInfo{Username: u.Username, Name: nk, Avatar: u.Avatar}
}

// meetRoomOf 查房间（不校验成员）
func meetRoomOf(roomID string) *meetRoom {
	meetMu.RLock()
	defer meetMu.RUnlock()
	return meetRooms[roomID]
}

// meetRoomIDAvailable call_id 全局唯一校验（1v1 会话表 + 会议房间表均未占用）
func meetRoomIDAvailable(id string) bool {
	if _, ok := callSessions[id]; ok {
		return false
	}
	if _, ok := meetRooms[id]; ok {
		return false
	}
	return true
}

// handleMeetInvite 发起会议：校验成员 → 建房间 → 逐被邀人转发 meet_invite（注入 ICE 配置）
// 上行 content：{action:'meet_invite', call_id, call_type, group_id, members:[...]}
func (s *Server) handleMeetInvite(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	var body struct {
		CallType string   `json:"call_type"`
		GroupID  uint     `json:"group_id"`
		Members  []string `json:"members"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	if body.CallType != "audio" && body.CallType != "video" {
		body.CallType = "video"
	}
	if p.CallID == "" {
		s.sendError(c, "会议信令缺少 call_id")
		return
	}

	// 会中追加邀请：房间已存在 → 校验发起人是房间成员后走追加路径（同一 meet_invite 信令复用；
	// 会议窗"邀请成员"按钮经主窗口选人后上行同信令，新成员 accept 复用 meet_accept 全链路）
	if room := meetRoomOf(p.CallID); room != nil {
		s.meetInviteMore(from, p, body.Members)
		return
	}

	meetMu.Lock()
	if !meetRoomIDAvailable(p.CallID) {
		meetMu.Unlock()
		s.callSendError(from, p.CallID, "会议标识冲突，请重试")
		return
	}
	if _, busy := callUserBusy[from]; busy {
		meetMu.Unlock()
		s.callSendError(from, p.CallID, "你正在通话中")
		return
	}

	// 成员归口：去重 / 剔除自己 / 群成员校验 / 在线 + PC 端 + 不忙（忙/离线者跳过并告知发起人）
	seen := map[string]bool{from: true}
	invitees := make([]string, 0, len(body.Members))
	skipped := make([]string, 0)
	for _, m := range body.Members {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		if body.GroupID > 0 && !isGroupMember(body.GroupID, m) {
			skipped = append(skipped, m+"（不在群内）")
			continue
		}
		// 原代码：if s.hub.Count(m) == 0 || !s.hub.HasPC(m) {
		// 阶段一百四十五：WEB 端会议上线，成员可邀能力改归口 HasCall（PC 端或 WEB 端均可入会）
		if s.hub.Count(m) == 0 || !s.hub.HasCall(m) {
			skipped = append(skipped, nicknameOf(m)+"（当前设备不支持）")
			continue
		}
		if _, busy := callUserBusy[m]; busy {
			skipped = append(skipped, nicknameOf(m)+"（忙）")
			continue
		}
		invitees = append(invitees, m)
	}
	if len(invitees) == 0 {
		meetMu.Unlock()
		reason := "可邀请的成员均不可用"
		if len(skipped) > 0 {
			reason = "成员均不可用：" + skipped[0]
		}
		s.callSendError(from, p.CallID, reason)
		return
	}
	if len(invitees)+1 > meetMaxMembers {
		meetMu.Unlock()
		s.callSendError(from, p.CallID, fmt.Sprintf("会议成员最多 %d 人", meetMaxMembers))
		return
	}

	room := &meetRoom{
		ID:       p.CallID,
		Caller:   from,
		CallType: body.CallType,
		GroupID:  body.GroupID,
		Members:  map[string]bool{from: true},
		Invited:  map[string]bool{},
	}
	for _, m := range invitees {
		room.Invited[m] = true
	}
	meetRooms[room.ID] = room
	callUserBusy[from] = room.ID
	for _, m := range invitees {
		callUserBusy[m] = room.ID
	}
	meetMu.Unlock()

	// 逐被邀人转发 meet_invite（from=发起人；带发起人显示名 + 群ID；注入 ICE 配置）
	for _, m := range invitees {
		content, _ := json.Marshal(map[string]interface{}{
			"action":    "meet_invite",
			"call_id":   room.ID,
			"call_type": room.CallType,
			"group_id":  room.GroupID,
			"from_name": nicknameOf(from),
			"ice":       TurnICEServers(),
		})
		s.callForward(from, m, string(content))
	}
	// 被跳过成员告知发起人（通话窗 toast，避免无声无息）
	if len(skipped) > 0 {
		sk, _ := json.Marshal(map[string]interface{}{"action": "meet_skipped", "call_id": room.ID, "names": skipped})
		s.callForward(from, from, string(sk))
	}
	logger.Info("会议发起：%s（%s，群%d，房间 %s，已邀 %d 人，跳过 %d 人）", from, body.CallType, body.GroupID, room.ID, len(invitees), len(skipped))
}

// meetInviteMore 会中追加邀请：房间成员向新成员补发 meet_invite（与建房同校验：群内/在线/PC 端/不忙），
// 新成员 accept 后经 meet_join 广播 + room_info 下发与全员增量建连；反馈走 meet_skipped 帧
// （不用 error 帧——会议窗收到 error 会误收口整个会议）
func (s *Server) meetInviteMore(from string, p *callSignalPayload, members []string) {
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Members[from] {
		meetMu.Unlock()
		return // 非房间成员/房间已解散：静默丢弃
	}
	seen := map[string]bool{from: true}
	for m := range room.Members {
		seen[m] = true
	}
	for m := range room.Invited {
		seen[m] = true
	}
	invitees := make([]string, 0, len(members))
	skipped := make([]string, 0)
	for _, m := range members {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		if room.GroupID > 0 && !isGroupMember(room.GroupID, m) {
			skipped = append(skipped, m+"（不在群内）")
			continue
		}
		// 原代码：if s.hub.Count(m) == 0 || !s.hub.HasPC(m) {
		// 阶段一百四十五：WEB 端会议上线，会中邀请能力改归口 HasCall（PC 端或 WEB 端均可入会）
		if s.hub.Count(m) == 0 || !s.hub.HasCall(m) {
			skipped = append(skipped, nicknameOf(m)+"（当前设备不支持）")
			continue
		}
		if _, busy := callUserBusy[m]; busy {
			skipped = append(skipped, nicknameOf(m)+"（忙）")
			continue
		}
		invitees = append(invitees, m)
	}
	if len(invitees) == 0 {
		meetMu.Unlock()
		if len(skipped) > 0 {
			sk, _ := json.Marshal(map[string]interface{}{"action": "meet_skipped", "call_id": p.CallID, "names": skipped})
			s.callForward(from, from, string(sk))
		}
		return
	}
	if len(invitees)+len(room.Members)+len(room.Invited) > meetMaxMembers {
		meetMu.Unlock()
		sk, _ := json.Marshal(map[string]interface{}{"action": "meet_skipped", "call_id": p.CallID,
			"names": []string{fmt.Sprintf("已超会议人数上限（%d人）", meetMaxMembers)}})
		s.callForward(from, from, string(sk))
		return
	}
	for _, m := range invitees {
		room.Invited[m] = true
		callUserBusy[m] = room.ID
	}
	callType := room.CallType
	realGroup := room.GroupID
	meetMu.Unlock()

	// 逐新成员转发 meet_invite（from=邀请人；带邀请人显示名 + 群ID；注入 ICE 配置）
	for _, m := range invitees {
		content, _ := json.Marshal(map[string]interface{}{
			"action":    "meet_invite",
			"call_id":   p.CallID,
			"call_type": callType,
			"group_id":  realGroup,
			"from_name": nicknameOf(from),
			"ice":       TurnICEServers(),
		})
		s.callForward(from, m, string(content))
	}
	logger.Info("会中追加邀请：%s 在房间 %s 追加邀请 %d 人（跳过 %d 人）", from, p.CallID, len(invitees), len(skipped))
}

// handleMeetAccept 被邀人接受：入房间 + 广播 meet_join（带新人资料）+ 向新人发 room_info（全员资料）
func (s *Server) handleMeetAccept(from string, p *callSignalPayload) {
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Invited[from] {
		meetMu.Unlock()
		return // 房间已解散/重复 accept/非被邀人：静默丢弃
	}
	delete(room.Invited, from)
	room.Members[from] = true
	callUserBusy[from] = room.ID
	if room.Started.IsZero() {
		room.Started = time.Now()
	}
	// 快照广播名单（锁内取，锁外发信令防死锁：callForward 内部另持 hub 锁）
	members := make([]string, 0, len(room.Members))
	for m := range room.Members {
		members = append(members, m)
	}
	callType := room.CallType
	caller := room.Caller
	meetMu.Unlock()

	// 已在会成员收 meet_join（from=新人），各自向新人发 offer（建连方向规则）
	// ice 注入：发起人无 invite/accept 帧路径，ICE 配置随首个 meet_join 下发（TURN 启用时发起人也拿到中继配置）
	joinInfo := meetInfoOf(from)
	for _, m := range members {
		if m == from {
			continue
		}
		content, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_join",
			"call_id": p.CallID,
			"member":  joinInfo,
			"ice":     TurnICEServers(),
		})
		s.callForward(from, m, string(content))
	}
	// 新人收 room_info：全员资料 + 建连等待（对每个成员等 offer 应答）
	infos := make([]meetMemberInfo, 0, len(members))
	for _, m := range members {
		if m == from {
			continue
		}
		infos = append(infos, meetInfoOf(m))
	}
	ri, _ := json.Marshal(map[string]interface{}{
		"action":    "room_info",
		"call_id":   p.CallID,
		"call_type": callType,
		"caller":    caller,
		"members":   infos,
		"ice":       TurnICEServers(),
	})
	s.callForward(from, from, string(ri))
	logger.Info("会议入会：%s 加入房间 %s（当前 %d 人）", from, p.CallID, len(members))
}

// handleMeetDecline 被邀人拒绝：移出邀请名单 + 通知发起人；全员拒绝时解散房间
func (s *Server) handleMeetDecline(from string, p *callSignalPayload) {
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Invited[from] {
		meetMu.Unlock()
		return
	}
	delete(room.Invited, from)
	delete(callUserBusy, from)
	caller := room.Caller
	alone := len(room.Members) <= 1 && len(room.Invited) == 0
	meetMu.Unlock()

	// 发起人收 meet_declined（通话窗状态提示）
	content, _ := json.Marshal(map[string]interface{}{
		"action":  "meet_declined",
		"call_id": p.CallID,
		"name":    nicknameOf(from),
	})
	s.callForward(from, caller, string(content))

	if alone {
		// 仅剩发起人且无人响铃：解散（发起人通话窗收 error 收口）+ 落"已取消"话单与群信封
		s.meetDismiss(room, "canceled", 0)
		errB, _ := json.Marshal(map[string]string{"action": "error", "call_id": p.CallID, "reason": "成员均未加入，会议已取消"})
		s.callForward(from, caller, string(errB))
	}
	logger.Info("会议拒绝：%s 拒绝房间 %s", from, p.CallID)
}

// meetRelayMedia 会议媒体信令定向转发：content.target 指定接收方，双方均为房间成员才放行
func (s *Server) meetRelayMedia(from string, p *callSignalPayload, content string) {
	room := meetRoomOf(p.CallID)
	if room == nil || p.Target == "" {
		return
	}
	meetMu.RLock()
	ok := room.Members[from] && room.Members[p.Target]
	meetMu.RUnlock()
	if ok {
		s.callForward(from, p.Target, content)
	}
}

// meetLeave 成员退出（hangup 落到会议房间）：转发退出信令给余员 + 清忙；最后一人离开时解散落话单。
// 已入会（Members）与响铃中（Invited，断网/强退离线归口至此）均可退出，防忙态残留致重连后恒"忙"
func (s *Server) meetLeave(from string, p *callSignalPayload) {
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok {
		// 原代码：直接 return（房间已解散时不清忙）。
		// 修复：并发挂断场景下，房间已被先到者的 meetDismiss 删除，最后到达的 hangup
		// 若不清理自身忙标记会永久残留，后续发起 1v1 恒提示"你正在通话中"
		delete(callUserBusy, from)
		meetMu.Unlock()
		return
	}
	inMeet := room.Members[from]
	invited := room.Invited[from]
	if !inMeet && !invited {
		// 原代码：直接 return。补兜底清理（幂等）：重复退出信令不残留忙态
		delete(callUserBusy, from)
		meetMu.Unlock()
		return
	}
	delete(room.Members, from)
	delete(room.Invited, from)
	delete(callUserBusy, from)
	// 阶段一百四十八：成员退出时停其断网宽限定时器（防定时器滞留误触发/泄漏）
	if room.offlineTimers != nil {
		if t, ok := room.offlineTimers[from]; ok && t != nil {
			t.Stop()
			delete(room.offlineTimers, from)
		}
	}
	rest := make([]string, 0, len(room.Members))
	for m := range room.Members {
		rest = append(rest, m)
	}
	started := room.Started
	caller := room.Caller
	alone := len(room.Members) <= 1 && len(room.Invited) == 0
	meetMu.Unlock()

	// 响铃中离线：与主动拒绝同款收口（发起人收 meet_declined；空会解散落"已取消"话单）
	if invited && !inMeet {
		content, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_declined",
			"call_id": p.CallID,
			"name":    nicknameOf(from),
		})
		s.callForward(from, caller, string(content))
		if alone {
			s.meetDismiss(room, "canceled", 0)
		}
		logger.Info("会议退出：%s 于响铃中离开房间 %s（离线收口）", from, p.CallID)
		return
	}

	// 余员收 hangup（frame.from_user=退出者，前端据此关闭对应画面/收口空会）
	finishB, _ := json.Marshal(map[string]string{"action": "hangup", "call_id": p.CallID})
	for _, m := range rest {
		s.callForward(from, m, string(finishB))
	}

	// 原代码：仅 len(rest)==0 解散。
	// 修复：余员前端在"会议只剩自己"时收到上方 hangup 帧即自动收口关窗，且不会再补发
	// 退出信令——若服务端不解散，房间将永久滞留最后成员，其 busy 标记残留，
	// 此后发起 1v1 恒提示"你正在通话中"。rest==1 时同步解散并清忙（收口帧已发给余员）
	if len(rest) <= 1 {
		duration := 0
		if !started.IsZero() {
			duration = int(time.Since(started).Seconds())
		}
		s.meetDismiss(room, "completed", duration)
	}
	logger.Info("会议退出：%s 离开房间 %s（剩余 %d 人）", from, p.CallID, len(rest))
}

// meetDismiss 房间解散归口：删房间/清忙 → 话单落库 → 群聊会议信封消息（群成员全员可见，微信同款）
func (s *Server) meetDismiss(room *meetRoom, status string, duration int) {
	meetMu.Lock()
	if cur, ok := meetRooms[room.ID]; !ok || cur != room {
		meetMu.Unlock()
		return
	}
	delete(meetRooms, room.ID)
	for m := range room.Members {
		delete(callUserBusy, m)
	}
	for m := range room.Invited {
		delete(callUserBusy, m)
	}
	// 阶段一百四十八：解散时停全部成员断网宽限定时器（防定时器滞留触发空收口）
	for _, t := range room.offlineTimers {
		if t != nil {
			t.Stop()
		}
	}
	room.offlineTimers = nil
	callType := room.CallType
	caller := room.Caller
	groupID := room.GroupID
	memberCount := len(room.Members)
	// 快照响铃中被邀人（锁外定向转发用；解散后这些人的前端来电卡片仍显示，需通知撤下）
	invited := make([]string, 0, len(room.Invited))
	for m := range room.Invited {
		invited = append(invited, m)
	}
	meetMu.Unlock()

	// 阶段一百四十九：响铃中被邀人收取消信令（1v1 cancel 同款语义）——发起人挂断/会议解散时
	// 被邀人前端经既有 cancel 分支撤下来电响铃条；原代码仅发群信封不清被邀人来电态，
	// pendingRing 残留致响铃条永久显示且自动拒绝后续一切来电（会议+1v1）
	if len(invited) > 0 {
		cancelB, _ := json.Marshal(map[string]string{"action": "cancel", "call_id": room.ID})
		for _, m := range invited {
			s.callForward(caller, m, string(cancelB))
		}
	}

	// 话单落库（Callee 存会议人数摘要，话单查询页直接可读）
	record := model.CallLog{
		CallID:   room.ID,
		Caller:   caller,
		Callee:   fmt.Sprintf("会议（%d人）", memberCount),
		CallType: callType,
		Status:   status,
		Duration: duration,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("会议话单落库失败（call_id=%s）：%v", room.ID, err)
	}

	// 群聊会议信封消息：落库 + 实时推送群成员 + 会话摘要（气泡文案复用通话信封渲染，meet 标记会议语义）
	if groupID > 0 {
		env := map[string]interface{}{
			"type":     "call",
			"call":     callType,
			"status":   status,
			"duration": duration,
			"call_id":  room.ID,
			"meet":     true,
		}
		envBytes, _ := json.Marshal(env)
		target := groupTargetOf(groupID)
		record2 := model.Message{
			MsgType:  int8(protocol.MsgTypeGroupChat),
			FromUser: caller,
			ToUser:   target,
			Content:  string(envBytes),
		}
		if err := store.DB.Create(&record2).Error; err != nil {
			logger.Error("会议信封消息落库失败（call_id=%s）：%v", room.ID, err)
			return
		}
		frame := protocol.Message{
			MsgType:   protocol.MsgTypeGroupChat,
			FromUser:  caller,
			ToUser:    target,
			Content:   string(envBytes),
			MsgID:     record2.ID,
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(frame)
		memberIDs := getGroupMemberIDs(groupID)
		s.sendToGroupMembers(memberIDs, data)
		summary := callSummary(callType, status, duration)
		for _, name := range memberIDs {
			s.touchConversation(name, target, summary)
			s.notifyConvUpdate(name)
		}
	}
	logger.Info("会议解散：%s（%s，%s，时长 %ds，%d 人）", room.ID, callType, status, duration, memberCount)
}

// meetArmOfflineGrace 阶段一百四十八：会议成员信令断开的宽限安排（返回 true=已安排宽限，调用方不再立即收口）。
// 仅已入会成员走宽限（切网自愈窗口）；响铃中被邀人返回 false 走立即收口（对方在等，宽限无意义，同 1v1 响铃语义）
func (s *Server) meetArmOfflineGrace(room *meetRoom, username string) bool {
	meetMu.RLock()
	inMeet := room.Members[username]
	meetMu.RUnlock()
	if !inMeet {
		return false
	}
	meetMu.Lock()
	if room.offlineTimers == nil {
		room.offlineTimers = map[string]*time.Timer{}
	}
	if room.offlineTimers[username] == nil { // 幂等：定时器已在跑不重复起（多连接闪断场景）
		logger.Info("会议 %s：用户 %s 信令断开，%v 内重连自动恢复参会", room.ID, username, meetOfflineGrace)
		room.offlineTimers[username] = time.AfterFunc(meetOfflineGrace, func() {
			meetMu.Lock()
			if cur, ok := meetRooms[room.ID]; !ok || cur != room { // 房间已被其他路径解散：空转
				meetMu.Unlock()
				return
			}
			delete(room.offlineTimers, username)
			still := room.Members[username]
			meetMu.Unlock()
			if !still { // 已被其他路径移出（主动退出/解散）：空转
				return
			}
			// 竞态防线：定时器触发与重连取消（Stop）赛跑的毫秒级窗口内，hub 已有活跃连接
			// 视为已重连成功（登录路径即将/已经取消宽限），不收口
			if s.hub.Count(username) > 0 {
				logger.Info("会议 %s：用户 %s 定时器触发时已重连，取消移出", room.ID, username)
				return
			}
			logger.Info("会议 %s：用户 %s 宽限期未重连，自动移出会议", room.ID, username)
			s.meetLeave(username, &callSignalPayload{Action: "hangup", CallID: room.ID})
		})
	}
	meetMu.Unlock()
	return true
}

// meetCancelOfflineHangup 阶段一百四十八：用户重连上线时取消其所在会议房间的断网宽限收口
//（宽限期内回来 = 会议继续；媒体面由客户端成员级 ICE restart 自动恢复，服务端只需不收口）
func meetCancelOfflineHangup(username string) {
	meetMu.Lock()
	for _, room := range meetRooms {
		if !room.Members[username] || room.offlineTimers == nil {
			continue
		}
		if t, ok := room.offlineTimers[username]; ok && t != nil {
			t.Stop()
			delete(room.offlineTimers, username)
			logger.Info("会议 %s：用户 %s 宽限期内重连，会议继续", room.ID, username)
		}
	}
	meetMu.Unlock()
}
