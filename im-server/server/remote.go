package server

// ===== 阶段一百五十五：QQ 同款远程协助（一期 PC↔PC 完整互控） =====
// 职责划分（服务端数据归口）：
//   1. 信令转发：msg_type=90（invite/accept/reject/cancel/disconnect/offer/answer/candidate），
//      服务端校验好友关系与状态机后按用户名定向转发（多端在线全部下发）
//   2. 状态归口：内存会话表（等待响应/协助中）——好友强校验、与通话双向忙互斥、
//      60s 无响应超时兜底、30s 对端全下线宽限均在服务端
//   3. 话单落库：im_remote_log（仅话单不写聊天信封消息——远程协助不产生聊天气泡，历史可查即可）
//   4. 媒体面零参与：屏幕流走 WebRTC P2P 视频轨、鼠标键盘控制事件走 DataChannel 点对点直传，
//      服务端只中继 SDP/ICE 信令（与通话同水位，第一期不部署 STUN/TURN）
// 鉴权水位：比通话严一层——好友关系强校验（isFriend）+ 黑名单拦截；
// 双方都必须 PC 端在线（hub.HasPC，WEB/手机端不支持被控/控制）
// 角色语义：请求方按入口决定 mode——control（请求控制对方，请求方=控制方）/
// assist（请求对方协助，请求方=被控方）；被控方 accept 时决定最终授权 grant（control 允许操作 / view 仅观看）

import (
	"encoding/json"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 协助状态
const (
	remoteStatePending int8 = 0 // 等待响应（被控方未应答）
	remoteStateActive  int8 = 1 // 协助中（已接受，含媒体协商阶段）
)

// remoteRingTimeout 等待响应超时（60s 无人响应服务端自动结束，双方同步收口，对齐通话响铃超时）
const remoteRingTimeout = 60 * time.Second

// remoteOfflineGrace 协助中对端信令断开的下线宽限期：切网场景信令 WS 闪断（数秒后重连）≠
// 媒体断线，宽限期内重连则协助自动恢复（媒体由客户端 ICE restart 兜底）；
// 取 30s 与通话宽限及客户端 disconnected 看门狗对齐，双方同窗口内放弃
const remoteOfflineGrace = 30 * time.Second

// remoteSession 协助会话（内存态，重启即清空——话单已落库不丢历史）
type remoteSession struct {
	ID           string
	Requester    string // 请求发起人
	Peer         string // 对方
	Controller   string // 控制方（invite 时按 mode 预填，accept 后不变）
	Sharer       string // 被控方
	Mode         string // control 请求控制对方 / assist 请求对方协助
	Grant        string // 最终授权：control 允许操作 / view 仅观看（接受后落定，话单归口）
	State        int8
	StartAt      time.Time   // 请求发起时间
	AcceptAt     time.Time   // 接受时间（计时长起点）
	timer        *time.Timer // 等待响应超时定时器（accept/finish 时停止）
	offlineTimer *time.Timer // 对端全下线宽限收口定时器（重连上线时取消）
}

var (
	remoteMu       sync.RWMutex
	remoteSessions = map[string]*remoteSession{} // session_id -> 会话
	remoteUserBusy = map[string]string{}         // username -> session_id（等待响应/协助中均算忙）
)

// remoteSignalPayload 信令 content 公共字段（轻解析归口：仅取 action/session_id，媒体字段原样中继不解析）
type remoteSignalPayload struct {
	Action    string `json:"action"`
	SessionID string `json:"session_id"`
}

// HandleRemoteSignal 远程协助信令入口（msg_type=90）
func (s *Server) HandleRemoteSignal(c *Client, msg *protocol.Message) {
	var p remoteSignalPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" {
		s.sendError(c, "远程协助信令格式错误")
		return
	}
	// from_user 一律以连接登录名归口（防伪造他人身份发信令）
	from := c.username

	switch p.Action {
	case "invite":
		s.remoteInvite(c, msg, from, &p)
	case "accept":
		s.remoteAccept(msg, from, &p)
	case "reject":
		s.remoteReject(from, &p)
	case "cancel":
		s.remoteCancel(from, &p)
	case "disconnect":
		s.remoteDisconnect(from, &p)
	case "offer", "answer", "candidate":
		s.remoteRelayMedia(msg, from, &p)
	default:
		s.sendError(c, "未知远程协助信令")
	}
}

// remoteForwardByUser 以服务端归口身份构造信令帧并按用户名下发（该用户全部在线连接）
func (s *Server) remoteForwardByUser(action, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeRemoteSignal,
		FromUser:  "", // 服务端归口帧不携带发起人（error/timeout/dismiss/ended）
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// remoteForward 信令转发：原 content 中继 + from_user 强制为发送者登录名
func (s *Server) remoteForward(from, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeRemoteSignal,
		FromUser:  from,
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// remoteSendError 协助专用错误帧（不走全局 ERROR——错误随信令下发，由聊天/协助窗口展示，
// 避免主窗口 toast 与会话提示双通道重复打扰，对齐通话 callSendError）
func (s *Server) remoteSendError(toUser, sessionID, reason string) {
	b, _ := json.Marshal(map[string]string{"action": "error", "session_id": sessionID, "reason": reason})
	s.remoteForwardByUser("error", toUser, string(b))
}

// remoteSessionOf 查会话（不校验参与者）
func remoteSessionOf(sessionID string) *remoteSession {
	remoteMu.RLock()
	defer remoteMu.RUnlock()
	return remoteSessions[sessionID]
}

// callUserBusyAny 通话忙表互查（供 remoteInvite 使用，不在 remoteMu 锁内调用防死锁）
func callUserBusyAny(users ...string) bool {
	callMu.RLock()
	defer callMu.RUnlock()
	for _, u := range users {
		if _, busy := callUserBusy[u]; busy {
			return true
		}
	}
	return false
}

// remoteUserBusyAny 协助忙表互查（供 callInvite 使用，不在 callMu 锁内调用防死锁）
func remoteUserBusyAny(users ...string) bool {
	remoteMu.RLock()
	defer remoteMu.RUnlock()
	for _, u := range users {
		if _, busy := remoteUserBusy[u]; busy {
			return true
		}
	}
	return false
}

// remoteInvite 请求方发起协助请求
func (s *Server) remoteInvite(c *Client, msg *protocol.Message, from string, p *remoteSignalPayload) {
	var body struct {
		Mode string `json:"mode"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	if body.Mode != "control" && body.Mode != "assist" {
		body.Mode = "control"
	}
	peer := msg.ToUser
	if peer == "" || peer == from {
		s.sendError(c, "远程协助对象无效")
		return
	}
	if p.SessionID == "" {
		s.sendError(c, "远程协助信令缺少 session_id")
		return
	}

	// 目标用户存在且未注销
	var u model.User
	if err := store.DB.Where("username = ? AND status = ?", peer, model.UserStatusNormal).First(&u).Error; err != nil {
		s.remoteSendError(from, p.SessionID, "对方不存在或已注销")
		return
	}
	// 好友关系强校验（远程协助比通话严一层：仅限好友之间）
	if !s.isFriend(from, peer) {
		s.remoteSendError(from, p.SessionID, "仅好友之间可发起远程协助")
		return
	}
	// 黑名单任一方向拉黑即禁止协助
	if s.isBlocked(from, peer) {
		s.remoteSendError(from, p.SessionID, "无法发起远程协助（黑名单关系）")
		return
	}
	// 对方必须在线
	if s.hub.Count(peer) == 0 {
		s.remoteSendError(from, p.SessionID, "对方不在线")
		return
	}
	// 双方必须 PC 端在线（远程协助比通话严：WEB/手机端不支持，hub.HasPC 归口）
	if !s.hub.HasPC(from) || !s.hub.HasPC(peer) {
		s.remoteSendError(from, p.SessionID, "双方需在 PC 客户端在线才能使用远程协助")
		return
	}
	// 与通话双向忙互斥：通话中/协助中均不可再发起（先查通话忙表，后查协助忙表）
	if callUserBusyAny(from, peer) {
		s.remoteSendError(from, p.SessionID, "对方忙，请稍后再试")
		return
	}

	remoteMu.Lock()
	if _, busy := remoteUserBusy[from]; busy {
		remoteMu.Unlock()
		s.remoteSendError(from, p.SessionID, "你正在远程协助中")
		return
	}
	if _, busy := remoteUserBusy[peer]; busy {
		remoteMu.Unlock()
		s.remoteSendError(from, p.SessionID, "对方忙，请稍后再试")
		return
	}
	// 角色预填：control=请求方控制对方；assist=对方控制请求方
	sess := &remoteSession{
		ID:        p.SessionID,
		Requester: from,
		Peer:      peer,
		Mode:      body.Mode,
		State:     remoteStatePending,
		StartAt:   time.Now(),
	}
	if body.Mode == "control" {
		sess.Controller = from
		sess.Sharer = peer
	} else {
		sess.Controller = peer
		sess.Sharer = from
	}
	remoteSessions[sess.ID] = sess
	remoteUserBusy[from] = sess.ID
	remoteUserBusy[peer] = sess.ID
	remoteMu.Unlock()

	// 60s 无人响应超时兜底（服务端归口：同时通知双方收口 UI 并落"无人响应"话单）
	sess.timer = time.AfterFunc(remoteRingTimeout, func() {
		remoteMu.Lock()
		cur, ok := remoteSessions[sess.ID]
		if !ok || cur != sess || cur.State != remoteStatePending {
			remoteMu.Unlock()
			return
		}
		remoteMu.Unlock()
		s.remoteFinish(sess, "missed", true)
	})

	logger.Info("远程协助发起：%s → %s（%s，session_id=%s）", from, peer, body.Mode, sess.ID)
	// 信令转发给被控方（from_user 强制请求方，防伪造）
	s.remoteForward(from, peer, msg.Content)
}

// remoteAccept 被控方接受（等待响应中才有效；grant 最终授权在此落定，话单时长从此刻起算）
func (s *Server) remoteAccept(msg *protocol.Message, from string, p *remoteSignalPayload) {
	sess := remoteSessionOf(p.SessionID)
	if sess == nil {
		return // 会话已结束（超时竞态）：静默丢弃
	}
	var body struct {
		Grant string `json:"grant"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	if body.Grant != "control" && body.Grant != "view" {
		body.Grant = "view" // 缺省安全取向：仅观看（未显式授权操作一律降级）
	}
	remoteMu.Lock()
	// accept 合法发送人=被邀请人（sess.Peer）：control 模式即被控方，assist 模式即协助方（控制方）
	//（修复：此前校验 Sharer，assist 模式 Sharer=发起人，对方 accept 被丢弃导致会话超时死锁）
	if sess.Peer != from || sess.State != remoteStatePending {
		remoteMu.Unlock()
		return
	}
	sess.State = remoteStateActive
	sess.Grant = body.Grant
	sess.AcceptAt = time.Now()
	if sess.timer != nil {
		sess.timer.Stop()
	}
	remoteMu.Unlock()

	// 同账号其他设备撤下协助弹窗（多端同时响铃，一台接受即收口；弹窗方=被邀请人）
	dismiss, _ := json.Marshal(map[string]string{"action": "dismiss", "session_id": sess.ID})
	s.remoteForwardByUser("dismiss", sess.Peer, string(dismiss))
	// accept 转发请求方（invite 发送人，两种模式通用）：
	// control 模式=控制方（开观看窗等 offer）/ assist 模式=被协助方（开悬浮条 + 起共享流）
	//（修复：此前转发 Controller，assist 模式 Controller=accept 发送人自己，回环自收且发起方收不到）
	s.remoteForward(from, sess.Requester, msg.Content)
}

// remoteReject 被邀请人拒绝（等待响应中有效；写"已拒绝"话单）
func (s *Server) remoteReject(from string, p *remoteSignalPayload) {
	sess := remoteSessionOf(p.SessionID)
	if sess == nil || sess.Peer != from || sess.State != remoteStatePending {
		return
	}
	s.remoteFinish(sess, "rejected", true, from)
}

// remoteCancel 请求方响应前放弃（等价微信"已取消"；写"已取消"话单）
func (s *Server) remoteCancel(from string, p *remoteSignalPayload) {
	sess := remoteSessionOf(p.SessionID)
	if sess == nil || sess.Requester != from {
		return
	}
	if sess.State != remoteStatePending {
		// 竞态兜底：已接受后请求方发 cancel 按断开处理
		s.remoteDisconnect(from, p)
		return
	}
	s.remoteFinish(sess, "canceled", true, from)
}

// remoteDisconnect 会话中任一方断开（写"已接通"话单含时长）
func (s *Server) remoteDisconnect(from string, p *remoteSignalPayload) {
	sess := remoteSessionOf(p.SessionID)
	if sess == nil {
		return
	}
	remoteMu.RLock()
	isParty := (sess.Controller == from || sess.Sharer == from) && sess.State == remoteStateActive
	remoteMu.RUnlock()
	if !isParty {
		return
	}
	s.remoteFinish(sess, "connected", true, from)
}

// remoteRelayMedia 媒体协商中继（offer/answer/candidate）：仅校验会话存在与参与者身份，content 原样透传
func (s *Server) remoteRelayMedia(msg *protocol.Message, from string, p *remoteSignalPayload) {
	sess := remoteSessionOf(p.SessionID)
	if sess == nil {
		return
	}
	remoteMu.RLock()
	ok := sess.Controller == from || sess.Sharer == from
	remoteMu.RUnlock()
	if !ok {
		return
	}
	peer := sess.Controller
	if from == sess.Controller {
		peer = sess.Sharer
	}
	s.remoteForward(from, peer, msg.Content)
}

// remoteFinish 协助收口归口：清状态 → 转发结束信令 → 写话单（不写聊天信封消息）
// notify=true 时向对方转发结束信令（reject/cancel/disconnect 由客户端发起，content 已带语义；
// timeout/missed 由服务端发起，构造 timeout/ended 帧通知双方）
func (s *Server) remoteFinish(sess *remoteSession, status string, notify bool, sender ...string) {
	remoteMu.Lock()
	if cur, ok := remoteSessions[sess.ID]; !ok || cur != sess {
		remoteMu.Unlock()
		return
	}
	delete(remoteSessions, sess.ID)
	delete(remoteUserBusy, sess.Controller)
	delete(remoteUserBusy, sess.Sharer)
	if sess.timer != nil {
		sess.timer.Stop()
	}
	if sess.offlineTimer != nil {
		sess.offlineTimer.Stop()
	}
	remoteMu.Unlock()

	// 时长归口：仅接通的话单计时长（服务端 AcceptAt 起算，不信任客户端时长）
	duration := 0
	if status == "connected" {
		duration = int(time.Since(sess.AcceptAt).Seconds())
	}

	// 对端通知：客户端发起的结束信令（reject/cancel/disconnect）原样语义转发给对方（服务端归口构造轻量帧）；
	// 服务端归口结束（missed 超时）则向双方构造 timeout 帧
	if notify {
		if status == "missed" {
			timeout, _ := json.Marshal(map[string]string{"action": "timeout", "session_id": sess.ID})
			s.remoteForwardByUser("timeout", sess.Controller, string(timeout))
			s.remoteForwardByUser("timeout", sess.Sharer, string(timeout))
		} else if len(sender) > 0 && sender[0] != "" {
			s.remoteForward(sender[0], remotePeerOf(sess, sender[0]), remoteMapFinishContent(status, sess.ID))
		}
	}

	// ===== 话单落库（服务端数据归口） =====
	record := model.RemoteLog{
		SessionID: sess.ID,
		Requester: sess.Requester,
		Peer:      sess.Peer,
		Mode:      sess.Mode,
		AuthMode:  sess.Grant,
		Status:    status,
		Duration:  duration,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("远程协助话单落库失败（session_id=%s）：%v", sess.ID, err)
	}
	logger.Info("远程协助结束：%s → %s（%s，%s，授权 %s，时长 %ds）", sess.Requester, sess.Peer, sess.Mode, status, sess.Grant, duration)
}

// remotePeerOf 会话中 from 的对方
func remotePeerOf(sess *remoteSession, from string) string {
	if from == sess.Controller {
		return sess.Sharer
	}
	return sess.Controller
}

// remoteMapFinishContent 客户端发起结束时构造轻量结束帧（服务端归口语义，避免依赖客户端原始 content 字段完整性）
func remoteMapFinishContent(status, sessionID string) string {
	action := "reject"
	if status == "canceled" {
		action = "cancel"
	} else if status == "connected" {
		action = "disconnect"
	}
	b, _ := json.Marshal(map[string]string{"action": action, "session_id": sessionID})
	return string(b)
}

// remoteOfflineCleanup 用户最后连接离线时的协助状态归口清理（对齐 callOfflineCleanup）：
// 等待响应中仍立即收口（对方在等，宽限无意义）；协助中走 30s 宽限——期间用户任一连接重连上线
// 即取消收口（媒体由客户端 ICE restart 自动恢复），超时未回按断开收口（忙态不残留）
func remoteOfflineCleanup(s *Server, username string) {
	remoteMu.RLock()
	sessionID, busy := remoteUserBusy[username]
	remoteMu.RUnlock()
	if !busy {
		return
	}
	sess := remoteSessionOf(sessionID)
	if sess != nil && sess.State == remoteStateActive {
		remoteMu.Lock()
		if sess.offlineTimer == nil { // 幂等：宽限定时器已在跑不重复起（多连接闪断场景）
			logger.Info("远程协助 %s：用户 %s 信令断开，%v 内重连自动恢复", sessionID, username, remoteOfflineGrace)
			sess.offlineTimer = time.AfterFunc(remoteOfflineGrace, func() {
				remoteMu.Lock()
				if cur, ok := remoteSessions[sessionID]; !ok || cur != sess { // 会话已被其他路径收口：空转
					remoteMu.Unlock()
					return
				}
				sess.offlineTimer = nil
				remoteMu.Unlock()
				logger.Info("远程协助 %s：用户 %s 宽限期未重连，自动收口", sessionID, username)
				s.remoteFinish(sess, "connected", false)
			})
		}
		remoteMu.Unlock()
		return
	}
	// 等待响应中离线：立即收口（对齐通话响铃期离线策略）
	s.remoteFinish(sess, "missed", false)
}

// remoteCancelOfflineGrace 用户重连上线时取消其活跃协助的下线宽限收口（宽限期内回来 = 协助继续）；
// 媒体面由客户端 ICE restart 自动恢复，服务端只需不收口
func remoteCancelOfflineGrace(username string) {
	remoteMu.Lock()
	for _, sess := range remoteSessions {
		if sess.State != remoteStateActive || (sess.Controller != username && sess.Sharer != username) {
			continue
		}
		if sess.offlineTimer != nil {
			sess.offlineTimer.Stop()
			sess.offlineTimer = nil
		}
	}
	remoteMu.Unlock()
}
