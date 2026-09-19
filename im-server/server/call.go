package server

// ===== 阶段一百四十一：音视频通话（第一期 PC↔PC 1v1） =====
// 职责划分（服务端数据归口）：
//   1. 信令转发：msg_type=70（invite/accept/reject/cancel/offer/answer/candidate/hangup），
//      服务端校验参与双方与状态机后按用户名定向转发（多端在线全部下发）
//   2. 状态归口：内存会话表（响铃中/通话中）——忙判定、60s 无人接听超时兜底均在服务端
//   3. 话单落库：im_call_log 话单 + im_message 通话信封消息（聊天记录零适配即可见通话记录，
//      content 为 JSON {"type":"call",...}，前端按视角渲染文案）
//   4. 媒体面零参与：WebRTC P2P 直连（第一期不部署 STUN/TURN），服务端只中继 SDP/ICE 信令
// 鉴权水位：与私聊一致（登录连接 + 黑名单拦截）；WEB 端通话上线后可发起（前端 web-call-bridge 桥承载，
// 手机端仍由前端隐藏入口），被叫无可通话端在线时服务端直接拒绝呼叫（hub.HasCall 判定：PC 端或 WEB 端）

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 通话状态
const (
	callStateRinging int8 = 0 // 响铃中（被叫未应答）
	callStateActive  int8 = 1 // 通话中（被叫已接受，含媒体协商阶段）
)

// callRingTimeout 响铃超时（60s 无人接听服务端自动结束，主/被叫两端同步收口）
const callRingTimeout = 60 * time.Second

// callSession 通话会话（内存态，重启即清空——话单已落库不丢历史）
type callSession struct {
	ID       string
	Caller   string
	Callee   string
	CallType string // audio / video
	State    int8
	StartAt  time.Time   // 呼叫发起时间
	AcceptAt time.Time   // 接通时间（计时长起点）
	timer    *time.Timer // 响铃超时定时器（accept/finish 时停止）
}

var (
	callMu       sync.RWMutex
	callSessions = map[string]*callSession{} // call_id -> 会话
	callUserBusy = map[string]string{}       // username -> call_id（响铃/通话中均算忙）
)

// callSignalPayload 信令 content 公共字段（轻解析归口：仅取 action/call_id，媒体字段原样中继不解析）
// Target 阶段一百四十四：会议模式下媒体帧（offer/answer/candidate）的定向接收方（Mesh 全员互连需逐对转发）
type callSignalPayload struct {
	Action string `json:"action"`
	CallID string `json:"call_id"`
	Target string `json:"target"`
}

// callEnvelope 通话信封（im_message content，聊天记录气泡数据源，视角文案由前端渲染）
type callEnvelope struct {
	Type     string `json:"type"` // 恒 "call"
	Call     string `json:"call"` // audio / video
	Status   string `json:"status"`
	Duration int    `json:"duration,omitempty"` // 秒，仅 completed 携带
	CallID   string `json:"call_id"`
}

// HandleCallSignal 通话信令入口（msg_type=70）
func (s *Server) HandleCallSignal(c *Client, msg *protocol.Message) {
	var p callSignalPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" {
		s.sendError(c, "通话信令格式错误")
		return
	}
	// from_user 一律以连接登录名归口（防伪造他人身份发信令）
	from := c.username

	switch p.Action {
	case "invite":
		s.callInvite(c, msg, from, &p)
	case "accept":
		s.callAccept(c, msg, from, &p)
	case "reject":
		s.callReject(c, msg, from, &p)
	case "cancel":
		s.callCancel(c, msg, from, &p)
	case "hangup":
		s.callHangup(c, msg, from, &p)
	case "offer", "answer", "candidate":
		s.callRelayMedia(c, msg, from, &p)
	// 阶段一百四十四：多人会议动作族（房间制归口 server/meet.go）
	case "meet_invite":
		s.handleMeetInvite(c, msg, from, &p)
	case "meet_accept":
		s.handleMeetAccept(from, &p)
	case "meet_decline":
		s.handleMeetDecline(from, &p)
	default:
		s.sendError(c, "未知通话信令")
	}
}

// callForwardByUser 以服务端归口身份构造信令帧并按用户名下发（该用户全部在线连接）
func (s *Server) callForwardByUser(action, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeCallSignal,
		FromUser:  "", // 服务端归口帧不携带发起人（error/timeout/dismiss）
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// callForward 信令转发：原 content 中继 + from_user 强制为发送者登录名
func (s *Server) callForward(from, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeCallSignal,
		FromUser:  from,
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// callSendError 通话专用错误帧（不走全局 ERROR——错误随信令下发，由通话窗口展示，
// 避免主窗口 toast 与通话窗提示双通道重复打扰）
func (s *Server) callSendError(toUser, callID, reason string) {
	b, _ := json.Marshal(map[string]string{"action": "error", "call_id": callID, "reason": reason})
	s.callForwardByUser("error", toUser, string(b))
}

// callSessionOf 查会话（不校验参与者）
func callSessionOf(callID string) *callSession {
	callMu.RLock()
	defer callMu.RUnlock()
	return callSessions[callID]
}

// callInjectICE 阶段一百四十二二期：invite/accept 转发帧注入服务端 ICE 配置（stun/turn 条目）
// TURN 未启用返回原 content（纯 P2P 直连模式，客户端零改动兼容）；凭证归口 config.yaml，不信任客户端传值
func callInjectICE(content string) string {
	ice := TurnICEServers()
	if ice == nil {
		return content
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(content), &m); err != nil {
		return content // 轻解析原则：非 JSON content 原样中继不拦
	}
	m["ice"] = ice
	b, err := json.Marshal(m)
	if err != nil {
		return content
	}
	return string(b)
}

// callInvite 主叫发起呼叫
func (s *Server) callInvite(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	var body struct {
		CallType string `json:"call_type"`
	}
	_ = json.Unmarshal([]byte(msg.Content), &body)
	if body.CallType != "audio" && body.CallType != "video" {
		body.CallType = "audio"
	}
	callee := msg.ToUser
	if callee == "" || callee == from {
		s.sendError(c, "通话对象无效")
		return
	}
	if p.CallID == "" {
		s.sendError(c, "通话信令缺少 call_id")
		return
	}

	// 目标用户存在且未注销
	var u model.User
	if err := store.DB.Where("username = ? AND status = ?", callee, model.UserStatusNormal).First(&u).Error; err != nil {
		s.callSendError(from, p.CallID, "对方不存在或已注销")
		return
	}
	// 黑名单任一方向拉黑即禁止通话（与私聊同水位）
	if s.isBlocked(from, callee) {
		s.callSendError(from, p.CallID, "无法发起通话（黑名单关系）")
		return
	}
	// 被叫必须在线
	if s.hub.Count(callee) == 0 {
		s.callSendError(from, p.CallID, "对方不在线")
		return
	}
	// 第一期仅 PC 端支持通话（Web/手机端无音视频能力）
	// 原代码：if !s.hub.HasPC(callee) {
	// 阶段一百四十五：WEB 端（浏览器）通话上线，被叫能力改归口 HasCall（PC 端或 WEB 端在线均可接听，手机端仍不支持）
	if !s.hub.HasCall(callee) {
		s.callSendError(from, p.CallID, "对方当前设备不支持音视频通话")
		return
	}

	callMu.Lock()
	// 双方忙判定（响铃中/通话中均算忙）
	if _, busy := callUserBusy[from]; busy {
		callMu.Unlock()
		s.callSendError(from, p.CallID, "你正在通话中")
		return
	}
	if _, busy := callUserBusy[callee]; busy {
		callMu.Unlock()
		s.callSendError(from, p.CallID, "对方忙，请稍后再试")
		return
	}
	sess := &callSession{
		ID:       p.CallID,
		Caller:   from,
		Callee:   callee,
		CallType: body.CallType,
		State:    callStateRinging,
		StartAt:  time.Now(),
	}
	callSessions[sess.ID] = sess
	callUserBusy[from] = sess.ID
	callUserBusy[callee] = sess.ID
	callMu.Unlock()

	// 60s 无人接听超时兜底（服务端归口：同时通知两端收口 UI 并落"无人接听"话单）
	sess.timer = time.AfterFunc(callRingTimeout, func() {
		callMu.Lock()
		cur, ok := callSessions[sess.ID]
		if !ok || cur != sess || cur.State != callStateRinging {
			callMu.Unlock()
			return
		}
		callMu.Unlock()
		s.callFinish(sess, "missed", true)
	})

	logger.Info("通话发起：%s → %s（%s，call_id=%s）", from, callee, body.CallType, sess.ID)
	// 信令转发给被叫（from_user 强制主叫，防伪造）；TURN 启用时服务端注入 iceServers（二期）
	s.callForward(from, callee, callInjectICE(msg.Content))
}

// callAccept 被叫接受（响铃中才有效；接通后进入媒体协商，话单时长从此刻起算）
func (s *Server) callAccept(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	sess := callSessionOf(p.CallID)
	if sess == nil {
		return // 会话已结束（超时竞态）：静默丢弃
	}
	callMu.Lock()
	if sess.Callee != from || sess.State != callStateRinging {
		callMu.Unlock()
		return
	}
	sess.State = callStateActive
	sess.AcceptAt = time.Now()
	if sess.timer != nil {
		sess.timer.Stop()
	}
	callMu.Unlock()

	peer := sess.Caller
	// 同账号其他设备撤下来电弹条（多端同时响铃，一台接受即收口）
	dismiss, _ := json.Marshal(map[string]string{"action": "dismiss", "call_id": sess.ID})
	s.callForwardByUser("dismiss", sess.Callee, string(dismiss))
	// accept 转发主叫：TURN 启用时服务端注入 iceServers（主叫在 buildPC 前收到）
	s.callForward(from, peer, callInjectICE(msg.Content))
}

// callReject 被叫拒绝（响铃中有效；写"已拒绝"话单）
func (s *Server) callReject(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	sess := callSessionOf(p.CallID)
	if sess == nil || sess.Callee != from || sess.State != callStateRinging {
		return
	}
	s.callFinish(sess, "rejected", true)
}

// callCancel 主叫响铃期放弃（等价微信"已取消"；写"已取消"话单）
func (s *Server) callCancel(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	sess := callSessionOf(p.CallID)
	if sess == nil || sess.Caller != from {
		return
	}
	if sess.State != callStateRinging {
		// 竞态兜底：已接通后主叫发 cancel 按挂断处理
		s.callHangup(c, msg, from, p)
		return
	}
	s.callFinish(sess, "canceled", true)
}

// callHangup 接通后任一方挂断（写"已接通"话单含时长）；未命中 1v1 会话时回落会议退出（阶段一百四十四）
func (s *Server) callHangup(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	sess := callSessionOf(p.CallID)
	if sess == nil {
		// 阶段一百四十四：非 1v1 会话按会议房间处理（成员退出/解散归口 meet.go）
		s.meetLeave(from, p)
		return
	}
	callMu.RLock()
	isParty := (sess.Caller == from || sess.Callee == from) && sess.State == callStateActive
	callMu.RUnlock()
	if !isParty {
		return
	}
	s.callFinish(sess, "completed", true)
}

// callRelayMedia 媒体协商中继（offer/answer/candidate）：仅校验会话存在与参与者身份，content 原样透传；
// 未命中 1v1 会话时回落会议房间定向转发（阶段一百四十四：content.target 指定接收方）
func (s *Server) callRelayMedia(c *Client, msg *protocol.Message, from string, p *callSignalPayload) {
	sess := callSessionOf(p.CallID)
	if sess == nil {
		s.meetRelayMedia(from, p, msg.Content)
		return
	}
	callMu.RLock()
	ok := sess.Caller == from || sess.Callee == from
	callMu.RUnlock()
	if !ok {
		return
	}
	peer := sess.Caller
	if from == sess.Caller {
		peer = sess.Callee
	}
	s.callForward(from, peer, msg.Content)
}

// callFinish 通话收口归口：清状态 → 转发结束信令 → 写话单 + 通话信封消息（双方会话可见）
// notify=true 时向对方转发结束信令（reject/cancel/hangup 由客户端发起，content 已带语义；
// timeout 由服务端发起，构造 timeout 帧同时通知双方）
func (s *Server) callFinish(sess *callSession, status string, notify bool) {
	callMu.Lock()
	if cur, ok := callSessions[sess.ID]; !ok || cur != sess {
		callMu.Unlock()
		return
	}
	delete(callSessions, sess.ID)
	delete(callUserBusy, sess.Caller)
	delete(callUserBusy, sess.Callee)
	if sess.timer != nil {
		sess.timer.Stop()
	}
	callMu.Unlock()

	// 时长归口：仅接通的话单计时长（服务端 AcceptAt 起算，不信任客户端时长）
	duration := 0
	if status == "completed" {
		duration = int(time.Since(sess.AcceptAt).Seconds())
	}

	// 对端通知：客户端发起的结束信令（reject/cancel/hangup）原样转发给对方；
	// 服务端超时则向双方构造 timeout 帧
	if notify {
		if status == "missed" {
			timeout, _ := json.Marshal(map[string]string{"action": "timeout", "call_id": sess.ID})
			s.callForwardByUser("timeout", sess.Caller, string(timeout))
			s.callForwardByUser("timeout", sess.Callee, string(timeout))
		} else {
			from := sess.Callee
			if status == "canceled" {
				from = sess.Caller
			}
			s.callForward(from, peerOf(sess, from), mapFinishContent(status, sess.ID))
		}
	}

	// ===== 话单落库（服务端数据归口） =====
	record := model.CallLog{
		CallID:   sess.ID,
		Caller:   sess.Caller,
		Callee:   sess.Callee,
		CallType: sess.CallType,
		Status:   status,
		Duration: duration,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("话单落库失败（call_id=%s）：%v", sess.ID, err)
	}

	// ===== 通话信封消息：im_message 落库（msg_type=2 私聊信封）+ 实时帧推送双方 =====
	env := callEnvelope{Type: "call", Call: sess.CallType, Status: status, Duration: duration, CallID: sess.ID}
	envBytes, _ := json.Marshal(env)
	record2 := model.Message{
		MsgType:  int8(protocol.MsgTypePrivate),
		FromUser: sess.Caller,
		ToUser:   sess.Callee,
		Content:  string(envBytes),
	}
	if err := store.DB.Create(&record2).Error; err != nil {
		logger.Error("通话消息落库失败（call_id=%s）：%v", sess.ID, err)
		return
	}
	frame := protocol.Message{
		MsgType:   protocol.MsgTypePrivate,
		FromUser:  sess.Caller,
		ToUser:    sess.Callee,
		Content:   string(envBytes),
		MsgID:     record2.ID,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(sess.Caller, data)
	s.sendToUser(sess.Callee, data)

	// 最近会话摘要更新（服务端归口文案，双方一致）
	summary := callSummary(sess.CallType, status, duration)
	s.touchConversation(sess.Caller, sess.Callee, summary)
	s.touchConversation(sess.Callee, sess.Caller, summary)
	s.notifyConvUpdate(sess.Caller)
	s.notifyConvUpdate(sess.Callee)
	logger.Info("通话结束：%s → %s（%s，%s，时长 %ds）", sess.Caller, sess.Callee, sess.CallType, status, duration)
}

// peerOf 会话中 from 的对方
func peerOf(sess *callSession, from string) string {
	if from == sess.Caller {
		return sess.Callee
	}
	return sess.Caller
}

// mapFinishContent 客户端发起结束时构造轻量结束帧（服务端归口语义，避免依赖客户端原始 content 字段完整性）
func mapFinishContent(status, callID string) string {
	action := "reject"
	if status == "canceled" {
		action = "cancel"
	} else if status == "completed" {
		action = "hangup"
	}
	b, _ := json.Marshal(map[string]string{"action": action, "call_id": callID})
	return string(b)
}

// callSummary 最近会话摘要文案（中性描述，双方一致；气泡内视角文案由前端渲染）
func callSummary(callType, status string, duration int) string {
	if status == "completed" {
		return fmt.Sprintf("通话时长 %02d:%02d", duration/60, duration%60)
	}
	switch status {
	case "rejected":
		return "通话已拒绝"
	case "canceled":
		return "通话已取消"
	case "missed":
		return "无人接听"
	case "busy":
		return "对方忙"
	}
	return "通话记录"
}

// HandleCallLogs 通话话单查询（REST）：GET /api/call/logs?username=xx&page=1&page_size=20
// 返回本人相关（主叫或被叫）话单，按时间倒序；鉴权水位与 /api/kb 一致（username 查询参数）
func (s *Server) HandleCallLogs(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	var total int64
	var list []model.CallLog
	q := store.DB.Model(&model.CallLog{}).Where("caller = ? OR callee = ?", username, username)
	if err := q.Count(&total).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询话单失败")
		return
	}
	if err := q.Order("id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询话单失败")
		return
	}
	if list == nil {
		list = []model.CallLog{}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "list": list, "total": total, "page": page, "page_size": pageSize})
}
