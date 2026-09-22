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
	"math/rand"
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

// meetRingTimeout 阶段一百五十：会议邀请响铃超时——60s 内无人 accept 自动解散（1v1 callRingTimeout
// 同款兜底）。否则发起人会议窗一直开着不点结束、被邀人不接不拒时，被邀人响铃卡片永久残留且双方忙态不释放
const meetRingTimeout = 60 * time.Second

// meetRoom 会议房间（内存态，与 1v1 callSession 同源生命周期：重启即清空，话单已落库不丢历史）
type meetRoom struct {
	ID       string
	Caller   string          // 发起人（退出不结束会议，微信同款）
	CallType string          // audio / video
	GroupID  uint            // 发起群（0=无群关联，一期恒从群发起）
	MeetNo   string          // 阶段一百五十二：9 位数字会议号（建房时服务端生成，加入会议凭此号查房入会）
	Members  map[string]bool // 已入会成员（含发起人）
	Invited  map[string]bool // 已邀请响铃中（accept/decline 后移除）
	Started  time.Time       // 首人入会时间（话单计时长起点）
	// offlineTimers 阶段一百四十八：成员断网宽限收口定时器（username → timer；重连上线/退出/解散时清理）
	offlineTimers map[string]*time.Timer
	// ringTimer 阶段一百五十：响铃超时定时器（任一人 accept 或解散时停止；防无人接听时忙态与响铃卡片永久残留）
	ringTimer *time.Timer
	// Sharing 阶段一百五十一补丁：正在共享屏幕的成员表（username → true）——meet_share 广播只发
	// 在会成员，中途入会者收不到入会前开始的共享广播；入会时按此快照向新人补发，保证舞台布局全员一致
	Sharing map[string]bool
	// Media 阶段一百五十一补丁：成员设备可用性快照（username → mic/cam 是否可用）——
	// meet_media 上报落表，中途入会者按快照补发，保证「叉麦/叉摄」状态全员一致可见
	Media map[string]meetMediaState
	// Recording 会议录制状态快照（username → true 正在录制）——录制为纯客户端行为
	// （本地 MediaRecorder 写盘，服务端零媒体参与），服务端只归口状态可见性：
	// meet_record 广播发在会成员，中途入会者按快照补发，保证「正在录制」提示全员一致
	Recording map[string]bool
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

// meetMediaState 阶段一百五十一补丁：成员设备可用性（麦克风/摄像头是否可用；不可用仅降级不阻断通信）
type meetMediaState struct {
	Mic bool `json:"mic"`
	Cam bool `json:"cam"`
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
	// 阶段一百五十二：创建等待模式（members 为空：工具栏下拉"创建会议"不选人直接建房，
	// 创建人进会等待后经会议窗"邀请成员"再加人）——邀请模式下被邀者全部不可用仍报错；
	// 等待模式放行空邀请名单（会议成立标记见下方建房段 Started 置位）
	if len(body.Members) > 0 && len(invitees) == 0 {
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
		Sharing:  map[string]bool{},
		Media:    map[string]meetMediaState{},
	}
	for _, m := range invitees {
		room.Invited[m] = true
	}
	// 阶段一百五十二：创建等待模式会议成立标记——创建人已入会即置 Started
	// （ringTimeout 守卫见 Started 非零即空转，等待期不被 60s 误解散；话单计时长起点同语义）
	if len(body.Members) == 0 {
		room.Started = time.Now()
	}
	meetRooms[room.ID] = room
	// 阶段一百五十二：生成 9 位数字会议号（锁内生成并查重，冲突重试；加入会议凭此号入会）
	for i := 0; i < 5 && room.MeetNo == ""; i++ {
		no := fmt.Sprintf("%d", 100000000+rand.Intn(900000000))
		dup := false
		for _, r := range meetRooms {
			if r.MeetNo == no {
				dup = true
				break
			}
		}
		if !dup {
			room.MeetNo = no
		}
	}
	callUserBusy[from] = room.ID
	for _, m := range invitees {
		callUserBusy[m] = room.ID
	}
	meetMu.Unlock()

	// 阶段一百五十：60s 无人接听超时兜底（1v1 callRingTimeout 同款语义）——期间任一人 accept 即取消；
	// 超时自动解散复用 meetDismiss cancel 通知链路（响铃中被邀人撤下来电卡片）+ 发起人会议窗 error 收口。
	// 原代码：无响铃超时，发起人不结束会议且被邀人不接不拒时响铃卡片永久残留。
	// 阶段一百五十二：仅邀请模式（members 非空）起响铃超时——创建等待模式无响铃，创建人等待期不被误解散
	if len(invitees) > 0 {
		room.ringTimer = time.AfterFunc(meetRingTimeout, func() {
			meetMu.Lock()
			cur, ok := meetRooms[room.ID]
			if !ok || cur != room || !room.Started.IsZero() { // 房间已解散或已有人入会：空转
				meetMu.Unlock()
				return
			}
			caller := room.Caller
			meetMu.Unlock()
			logger.Info("会议 %s：%v 无人接听，自动解散", room.ID, meetRingTimeout)
			s.meetDismiss(room, "missed", 0)
			// 发起人会议窗收口（全员拒绝解散同款 error 帧；会议窗 error 分支 finish 显示原因后关窗）
			errB, _ := json.Marshal(map[string]string{"action": "error", "call_id": room.ID, "reason": "无人接听，会议已取消"})
			s.callForward(caller, caller, string(errB))
		})
	}

	// 阶段一百五十二：向发起人下发会议号（创建人会议窗展示"会议号 xxx"并可复制转发；
	// call_id 关联会议窗，窗内 meet_no 动作更新展示。窗口可能尚在加载——PC/WEB 信令缓冲队列兜底）
	if room.MeetNo != "" {
		noB, _ := json.Marshal(map[string]interface{}{"action": "meet_no", "call_id": room.ID, "meet_no": room.MeetNo})
		s.callForward(from, from, string(noB))
	}

	// 逐被邀人转发 meet_invite（from=发起人；带发起人显示名 + 群ID + 会议号；注入 ICE 配置）
	for _, m := range invitees {
		content, _ := json.Marshal(map[string]interface{}{
			"action":    "meet_invite",
			"call_id":   room.ID,
			"call_type": room.CallType,
			"group_id":  room.GroupID,
			"meet_no":   room.MeetNo,
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
	realMeetNo := room.MeetNo // 阶段一百五十二：会议号随追加邀请下发（被邀人 accept 后会议窗展示）
	meetMu.Unlock()

	// 逐新成员转发 meet_invite（from=邀请人；带邀请人显示名 + 群ID + 会议号；注入 ICE 配置）
	for _, m := range invitees {
		content, _ := json.Marshal(map[string]interface{}{
			"action":    "meet_invite",
			"call_id":   p.CallID,
			"call_type": callType,
			"group_id":  realGroup,
			"meet_no":   realMeetNo,
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
	// 阶段一百五十：任一人入会即取消响铃超时（会议已成立；后续余员响铃由发起人手动收口）
	if room.ringTimer != nil {
		room.ringTimer.Stop()
		room.ringTimer = nil
	}
	// 快照广播名单（锁内取，锁外发信令防死锁：callForward 内部另持 hub 锁）
	members := make([]string, 0, len(room.Members))
	for m := range room.Members {
		members = append(members, m)
	}
	callType := room.CallType
	caller := room.Caller
	// 阶段一百五十一补丁：共享快照（锁内取名单）——中途入会者补发用，
	// meet_share 开启广播只发在会成员，晚到者收不到，需按快照补齐
	sharers := make([]string, 0, len(room.Sharing))
	for sh := range room.Sharing {
		sharers = append(sharers, sh)
	}
	// 阶段一百五十一补丁：设备可用性快照（锁内取）——中途入会者补发叉麦/叉摄状态
	media := make(map[string]meetMediaState, len(room.Media))
	for mu, ms := range room.Media {
		media[mu] = ms
	}
	// 录制状态快照（锁内取）——中途入会者补发「正在录制」提示
	recorders := make([]string, 0, len(room.Recording))
	for ru := range room.Recording {
		recorders = append(recorders, ru)
	}
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
		// 阶段一百五十二：会议号随 room_info 下发（会议窗展示）；group_id 供加入会议者定位群名开窗
		"meet_no":  room.MeetNo,
		"group_id": room.GroupID,
	})
	s.callForward(from, from, string(ri))
	// 阶段一百五十一补丁：向新人补发当前共享快照（在 room_info 之后发出，同一 WS 顺序到达——
	// 前端先建成员再标记 sharing，直接进主舞台布局，与同时入会场景一致；from_user=共享者）
	for _, sh := range sharers {
		sc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_share",
			"call_id": p.CallID,
			"on":      true,
		})
		s.callForward(sh, from, string(sc))
	}
	// 阶段一百五十一补丁：向新人补发全员设备可用性（room_info 之后同 WS 顺序；from_user=状态归属者）
	for mu, ms := range media {
		mc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_media",
			"call_id": p.CallID,
			"mic":     ms.Mic,
			"cam":     ms.Cam,
		})
		s.callForward(mu, from, string(mc))
	}
	// 向新人补发录制状态（room_info 之后同 WS 顺序；from_user=录制者，前端显示「正在录制」徽标）
	for _, ru := range recorders {
		rc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_record",
			"call_id": p.CallID,
			"on":      true,
		})
		s.callForward(ru, from, string(rc))
	}
	logger.Info("会议入会：%s 加入房间 %s（当前 %d 人）", from, p.CallID, len(members))
}

// handleMeetJoinNo 阶段一百五十二：加入会议——用户输入 9 位会议号直接加入进行中的会议
// （工具栏会议下拉"加入会议"入口；不经邀请响铃。权限归口：群会议要求加入者在会关联群内，
// 与邀请链路的群成员校验同语义）。上行 content：{action:'meet_join_no', meet_no}；
// 成功后 joiner 收 room_info（含 meet_no/group_id）由主窗口开会议窗，在会成员收 meet_join 自动加 tile，
// 共享/设备可用性快照按阶段一百五十一机制补发；响铃期加入视为会议成立（停响铃超时定时器）
func (s *Server) handleMeetJoinNo(from string, msg *protocol.Message, p *callSignalPayload) {
	var body struct {
		MeetNo string `json:"meet_no"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	body.MeetNo = strings.TrimSpace(body.MeetNo)
	if body.MeetNo == "" {
		s.callSendError(from, "", "请输入会议号")
		return
	}
	meetMu.Lock()
	var room *meetRoom
	for _, r := range meetRooms {
		if r.MeetNo == body.MeetNo {
			room = r
			break
		}
	}
	if room == nil {
		meetMu.Unlock()
		s.callSendError(from, "", "会议不存在或已结束")
		return
	}
	if _, busy := callUserBusy[from]; busy {
		meetMu.Unlock()
		s.callSendError(from, "", "你正在通话中")
		return
	}
	if room.Members[from] {
		meetMu.Unlock()
		s.callSendError(from, "", "你已在会议中")
		return
	}
	if room.GroupID > 0 && !isGroupMember(room.GroupID, from) {
		meetMu.Unlock()
		s.callSendError(from, "", "你不在该会议关联的群聊中")
		return
	}
	// 设备能力校验（与邀请链路同归口 HasCall：PC/WEB 均可入会；手机端一期不支持）
	if s.hub.Count(from) == 0 || !s.hub.HasCall(from) {
		meetMu.Unlock()
		s.callSendError(from, "", "当前设备不支持加入会议")
		return
	}
	delete(room.Invited, from) // 响铃期加入场景：先移出邀请名单
	room.Members[from] = true
	callUserBusy[from] = room.ID
	if room.Started.IsZero() {
		room.Started = time.Now()
	}
	if room.ringTimer != nil {
		room.ringTimer.Stop()
		room.ringTimer = nil
	}
	// 名单/快照（锁内取，锁外发信令防死锁：callForward 内部另持 hub 锁——handleMeetAccept 同款）
	// 注意：joiner 上行只有 meet_no 无 call_id（p.CallID 为空），下行帧一律用房间 ID 归口
	roomID := room.ID
	members := make([]string, 0, len(room.Members))
	for m := range room.Members {
		members = append(members, m)
	}
	callType := room.CallType
	caller := room.Caller
	groupID := room.GroupID
	meetNo := room.MeetNo
	sharers := make([]string, 0, len(room.Sharing))
	for sh := range room.Sharing {
		sharers = append(sharers, sh)
	}
	media := make(map[string]meetMediaState, len(room.Media))
	for mu, ms := range room.Media {
		media[mu] = ms
	}
	// 录制状态快照（锁内取）——中途入会者补发「正在录制」提示
	recorders := make([]string, 0, len(room.Recording))
	for ru := range room.Recording {
		recorders = append(recorders, ru)
	}
	meetMu.Unlock()

	// 已在会成员收 meet_join（from=新人；ice 注入同 accept——首个 meet_join 向发起人下发中继配置）
	joinInfo := meetInfoOf(from)
	for _, m := range members {
		if m == from {
			continue
		}
		content, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_join",
			"call_id": roomID,
			"member":  joinInfo,
			"ice":     TurnICEServers(),
		})
		s.callForward(from, m, string(content))
	}
	// joiner 收 room_info（meet_no 供会议窗展示会议号；group_id 供主窗口解析群名开窗）
	infos := make([]meetMemberInfo, 0, len(members))
	for _, m := range members {
		if m == from {
			continue
		}
		infos = append(infos, meetInfoOf(m))
	}
	ri, _ := json.Marshal(map[string]interface{}{
		"action":    "room_info",
		"call_id":   roomID,
		"call_type": callType,
		"caller":    caller,
		"members":   infos,
		"ice":       TurnICEServers(),
		"meet_no":   meetNo,
		"group_id":  groupID,
	})
	s.callForward(from, from, string(ri))
	// 共享/设备可用性快照补发（room_info 之后同一 WS 顺序到达——accept 同款）
	for _, sh := range sharers {
		sc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_share",
			"call_id": roomID,
			"on":      true,
		})
		s.callForward(sh, from, string(sc))
	}
	for mu, ms := range media {
		mc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_media",
			"call_id": roomID,
			"mic":     ms.Mic,
			"cam":     ms.Cam,
		})
		s.callForward(mu, from, string(mc))
	}
	// 向新人补发录制状态（room_info 之后同 WS 顺序；from_user=录制者，前端显示「正在录制」徽标）
	for _, ru := range recorders {
		rc, _ := json.Marshal(map[string]interface{}{
			"action":  "meet_record",
			"call_id": roomID,
			"on":      true,
		})
		s.callForward(ru, from, string(rc))
	}
	logger.Info("会议加入：%s 凭会议号 %s 加入房间 %s（当前 %d 人）", from, meetNo, roomID, len(members))
}

// meetMemberAskInfo 阶段一百五十三：会议窗邀请面板成员条目（昵称头像服务端归口下发 + 可邀状态）
type meetMemberAskInfo struct {
	Username  string `json:"username"`
	Name      string `json:"name"`       // 昵称（空昵称前端降级显示账号）
	Avatar    string `json:"avatar"`     // 头像（空则前端降级首字母）
	Online    bool   `json:"online"`     // 信令在线
	CallOK    bool   `json:"call_ok"`    // 设备可入会（PC 端或 WEB 端）
	Busy      bool   `json:"busy"`       // 正在通话/会议中
	InMeeting bool   `json:"in_meeting"` // 已在本会议（在会或响铃中，不可重复邀请）
}

// handleMeetMembersAsk 阶段一百五十三：会议窗内邀请面板拉取群成员名单（含可邀状态归口）。
// 会议窗「邀请成员」按钮直发本信令，不再经主窗口选人弹窗（避免弹窗被会议窗遮挡来回切窗）。
// 上行 content：{action:'meet_members_ask', call_id}；下行 meet_members_list
// {call_id, members:[meetMemberAskInfo...]}，前端按状态置灰不可选项。
// 注意：本动作一律不回 error 帧——会议窗 error 分支会 finish 收口整窗，拉取失败只能
// 静默回空名单（前端显示"暂无可邀请的成员"），绝不误关会议窗
func (s *Server) handleMeetMembersAsk(from string, msg *protocol.Message, p *callSignalPayload) {
	if p.CallID == "" {
		return
	}
	emptyOut, _ := json.Marshal(map[string]interface{}{"action": "meet_members_list", "call_id": p.CallID, "members": []meetMemberAskInfo{}})
	meetMu.RLock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Members[from] || room.GroupID == 0 {
		// 房间不存在/非在会成员/无群关联：回空名单兜底（空名单前端显示"暂无可邀请的成员"）
		meetMu.RUnlock()
		s.callForward(from, from, string(emptyOut))
		return
	}
	// 名单/状态快照（锁内取：Invited/Members/callUserBusy 均归 meetMu 守卫；锁外查库与 hub 防持锁慢路径）
	inMeet := make(map[string]bool, len(room.Members)+len(room.Invited))
	for m := range room.Members {
		inMeet[m] = true
	}
	for m := range room.Invited {
		inMeet[m] = true
	}
	busySet := make(map[string]bool, len(callUserBusy))
	for m := range callUserBusy {
		busySet[m] = true
	}
	groupID := room.GroupID
	meetMu.RUnlock()

	ids := getGroupMemberIDs(groupID)
	list := make([]meetMemberAskInfo, 0, len(ids))
	for _, id := range ids {
		if id == from {
			continue // 排除自己（发起邀请者本人已在会）
		}
		info := meetInfoOf(id)
		list = append(list, meetMemberAskInfo{
			Username:  info.Username,
			Name:      info.Name,
			Avatar:    info.Avatar,
			Online:    s.hub.Count(id) > 0,
			CallOK:    s.hub.HasCall(id),
			Busy:      busySet[id],
			InMeeting: inMeet[id],
		})
	}
	out, _ := json.Marshal(map[string]interface{}{"action": "meet_members_list", "call_id": p.CallID, "members": list})
	s.callForward(from, from, string(out))
	logger.Info("会议邀请名单：%s 于会议 %s 拉取群%d成员（列表 %d 人）", from, p.CallID, groupID, len(list))
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

// handleMeetShare 阶段一百五十一：会议共享状态广播（上行 {action:'meet_share', call_id, on:true/false}）。
// 校验发送者是房间成员后，把共享开/关状态转发给房间内其他所有成员（from_user=共享者）——
// 前端据此把共享画面切主舞台大区域、参会者切右侧缩略图（腾讯会议同款布局的全员一致视图）
func (s *Server) handleMeetShare(from string, msg *protocol.Message, p *callSignalPayload) {
	var body struct {
		On bool `json:"on"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	// 原代码：meetMu.RLock() 只读转发——阶段一百五十一补丁升级写锁：共享状态落房间快照
	// （Sharing 表），新成员入会时补发，解决中途加入者收不到入会前共享广播、退回宫格布局的问题
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Members[from] {
		meetMu.Unlock()
		return // 非房间成员/房间已解散：静默丢弃
	}
	if room.Sharing == nil {
		room.Sharing = map[string]bool{} // 兼容旧房间的惰性初始化
	}
	if body.On {
		room.Sharing[from] = true
	} else {
		delete(room.Sharing, from)
	}
	others := make([]string, 0, len(room.Members))
	for m := range room.Members {
		if m != from {
			others = append(others, m)
		}
	}
	meetMu.Unlock()
	content, _ := json.Marshal(map[string]interface{}{
		"action":  "meet_share",
		"call_id": p.CallID,
		"on":      body.On,
	})
	for _, m := range others {
		s.callForward(from, m, string(content))
	}
}

// handleMeetMedia 阶段一百五十一补丁：会议设备可用性广播（上行 {action:'meet_media', call_id, mic, cam}）。
// 校验发送者是房间成员后，把麦克风/摄像头可用状态转发给房间内其他成员（from_user=上报者），
// 同时落房间快照供中途入会者补发——设备不可用此前仅本端可见，全员可见后远端 tile 显示叉麦/叉摄
func (s *Server) handleMeetMedia(from string, msg *protocol.Message, p *callSignalPayload) {
	var body struct {
		Mic bool `json:"mic"`
		Cam bool `json:"cam"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Members[from] {
		meetMu.Unlock()
		return // 非房间成员/房间已解散：静默丢弃
	}
	if room.Media == nil {
		room.Media = map[string]meetMediaState{} // 兼容旧房间的惰性初始化
	}
	room.Media[from] = meetMediaState{Mic: body.Mic, Cam: body.Cam}
	others := make([]string, 0, len(room.Members))
	for m := range room.Members {
		if m != from {
			others = append(others, m)
		}
	}
	meetMu.Unlock()
	content, _ := json.Marshal(map[string]interface{}{
		"action":  "meet_media",
		"call_id": p.CallID,
		"mic":     body.Mic,
		"cam":     body.Cam,
	})
	for _, m := range others {
		s.callForward(from, m, string(content))
	}
}

// handleMeetRecord 会议录制状态广播（上行 {action:'meet_record', call_id, on:true/false}）。
// 校验发送者是房间成员后，把录制开/关状态转发给房间内其他成员（from_user=录制者），
// 同时落房间快照供中途入会者补发——录制本体为纯客户端行为（MediaRecorder 本地写盘，
// 服务端零媒体参与），服务端只归口状态可见性（腾讯会议同款「正在录制」提示，参会知情）
func (s *Server) handleMeetRecord(from string, msg *protocol.Message, p *callSignalPayload) {
	var body struct {
		On bool `json:"on"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	meetMu.Lock()
	room, ok := meetRooms[p.CallID]
	if !ok || !room.Members[from] {
		meetMu.Unlock()
		return // 非房间成员/房间已解散：静默丢弃
	}
	if room.Recording == nil {
		room.Recording = map[string]bool{} // 兼容旧房间的惰性初始化
	}
	if body.On {
		room.Recording[from] = true
	} else {
		delete(room.Recording, from)
	}
	others := make([]string, 0, len(room.Members))
	for m := range room.Members {
		if m != from {
			others = append(others, m)
		}
	}
	meetMu.Unlock()
	content, _ := json.Marshal(map[string]interface{}{
		"action":  "meet_record",
		"call_id": p.CallID,
		"on":      body.On,
	})
	for _, m := range others {
		s.callForward(from, m, string(content))
	}
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
	delete(room.Sharing, from)   // 阶段一百五十一补丁：退出清共享快照（防滞留致后续入会者收到失效共享标记）
	delete(room.Media, from)     // 阶段一百五十一补丁：退出清设备可用性快照
	delete(room.Recording, from) // 退出清录制快照（录制者已离会，后续入会者不再收到其「正在录制」补发）
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
	// 阶段一百五十：解散时停响铃超时定时器（回调内已有房间守卫，此处显式停止防滞留）
	if room.ringTimer != nil {
		room.ringTimer.Stop()
		room.ringTimer = nil
	}
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
// （宽限期内回来 = 会议继续；媒体面由客户端成员级 ICE restart 自动恢复，服务端只需不收口）
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
