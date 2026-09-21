package server

// ===== 阶段一百五十六：好友文件 P2P 直传（WebRTC DataChannel，P2P 优先 + 现有 HTTP 链路兜底） =====
// 职责划分（服务端数据归口）：
//   1. 决策归口：是否走 P2P 由服务端判定（enabled 开关/好友校验/大小上限/在线判定/并发上限），
//      客户端仅按服务端结果分流，不硬编码决策参数
//   2. 信令转发：msg_type=91（probe/accept/offer/answer/candidate/abort），
//      服务端校验会话双方与状态机后按用户名定向转发（多端在线全部下发）
//   3. 竞态归口：接收方多端在线全部自动 accept，会话表先到先得锁定唯一赢家，
//      后到端收服务端生成 abort(already_accepted)，杜绝双通道
//   4. 元信息落库：传输完成后双方各自上报 done，服务端归口写 im_message（msg_type=5 文件消息，
//      content JSON url 为空 + p2p=true 标记）→ done_ack 回填 msg_id，双端气泡转正式文件卡片
//   5. 文件内容零参与：DataChannel 点对点直传（DTLS 加密），服务端只见信令不见字节
// 鉴权水位：与远程协助同层——好友关系强校验（isFriend）+ 黑名单拦截 + 身份归口连接登录名；
// 接收方可 P2P 端在线判定同 hub.HasCall 先例（PC/WEB 端，手机端不支持）
// 超时兜底：懒清理模式（同 uploadSessionTimeout 先例，不启用定时器风暴）——
//   probe 后 15s 未进入协商 / 协商后 30s 未收到双方 done，任一新信令触发清扫时
//   删除过期会话并向双方发服务端 abort，客户端看门狗（30s 无数据）兜底独立生效

import (
	"encoding/json"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 直传会话状态
const (
	fileP2PStateNegotiating int8 = 0 // 已 probe，等待接收方 accept（先到先得）
	fileP2PStateAccepted    int8 = 1 // 赢家已锁定，SDP/ICE 协商与传输中
)

// 懒清理超时阈值（同 call.go 常量风格，取值见《P2P文件传输详细设计》§3.3）
const (
	fileP2PProbeTimeout = 15 * time.Second // probe 后未进入协商（无 accept）的兜底
	fileP2PDoneTimeout  = 30 * time.Second // 进入协商后未收到双方 done 的兜底
)

// fileP2PSession 直传会话（内存态，重启即清空——客户端看门狗自动回退 HTTP 链路，不丢功能）
type fileP2PSession struct {
	ID         string // transfer_id（发送方生成的传输唯一标识）
	From       string // 发送方
	To         string // 接收方
	FileName   string
	FileSize   int64
	Nonce      string // 发送端本地气泡标识（done_ack 回填 msg_id 时精确匹配）
	SHA256     string // 整文件哈希（发送方 probe 携带，落库随 content 下发）
	State      int8
	Accepted   bool      // accept 竞态归口：是否已有赢家端
	AcceptAt   time.Time // 赢家锁定时间
	CreateAt   time.Time // probe 建会话时间（15s 协商兜底的起算锚点）
	LastActive time.Time // 最近信令活跃时间（阶段一百五十六补丁：传输期 ping/中继帧刷新，
	// 防长传输（大文件超 30s）被懒清扫按固定锚点误杀——服务端不参与数据面，无法感知传输活跃，由客户端定时 ping 归口）
	DoneFrom bool // 发送方 done 已上报
	DoneTo   bool // 接收方 done 已上报
}

var (
	fileP2PMu       sync.RWMutex
	fileP2PSessions = map[string]*fileP2PSession{} // transfer_id -> 会话
)

// fileP2PSignalPayload 信令 content 公共字段（轻解析归口：仅取 action/transfer_id/platform，
// sdp/candidate/name/size/mime/sha256/nonce 等媒体与元信息字段原样中继不解析，同通话信令轻解析原则）
type fileP2PSignalPayload struct {
	Action     string `json:"action"`
	TransferID string `json:"transfer_id"`
	Platform   string `json:"platform"` // accept 携带被选端平台（pc/web），供发送方 UI 提示
}

// fileP2PProbeBody probe 帧扩展字段（文件元信息，服务端归口校验用）
type fileP2PProbeBody struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Nonce  string `json:"nonce"`
}

// fileP2PDoneBody done 帧扩展字段（sha256 终验值，以双方最后一次上报归口）
type fileP2PDoneBody struct {
	SHA256 string `json:"sha256"`
}

// fileP2PMsgContent 直传文件消息落库 content 结构（msg_type=5 文件消息，与 persistedMsgContent 同命名空间）：
// url 恒空串——直传不经服务器，历史气泡点击下载时前端提示"直传文件不保存到服务器"；
// p2p=true 供前端渲染"直传"角标区分服务器中转文件；nonce 供双端本地气泡按 nonce 精确回填 msg_id
type fileP2PMsgContent struct {
	URL    string `json:"url"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	P2P    bool   `json:"p2p"`
	SHA256 string `json:"sha256,omitempty"`
	Nonce  string `json:"nonce,omitempty"`
}

// HandleFileP2PSignal 好友文件直传信令入口（msg_type=91）
func (s *Server) HandleFileP2PSignal(c *Client, msg *protocol.Message) {
	var p fileP2PSignalPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" || p.TransferID == "" {
		s.sendError(c, "文件直传信令格式错误")
		return
	}
	// from_user 一律以连接登录名归口（防伪造他人身份发信令，同 call.go/remote.go）
	from := c.username

	switch p.Action {
	case "probe":
		s.fileP2PProbe(c, msg, from, &p)
	case "accept":
		s.fileP2PAccept(c, msg, from, &p)
	case "offer", "answer", "candidate":
		s.fileP2PRelay(from, msg.Content, &p)
	case "done":
		s.fileP2PDone(c, msg, from, &p)
	case "ping":
		s.fileP2PPing(from, &p)
	case "abort":
		s.fileP2PAbort(from, msg.Content, &p)
	default:
		s.sendError(c, "未知文件直传信令")
	}
}

// fileP2PSessionOf 查会话（不校验参与者，同 callSessionOf 模式）
func fileP2PSessionOf(transferID string) *fileP2PSession {
	fileP2PMu.RLock()
	defer fileP2PMu.RUnlock()
	return fileP2PSessions[transferID]
}

// fileP2PForward 信令转发：原 content 中继 + from_user 强制为发送者登录名（防伪造，同 callForward）
func (s *Server) fileP2PForward(from, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeFileP2PSignal,
		FromUser:  from,
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// fileP2PSystem 以服务端归口身份构造系统帧下发（probe_fail/abort/done_ack，同 callForwardByUser 模式）
func (s *Server) fileP2PSystem(toUser string, payload map[string]interface{}) {
	content, _ := json.Marshal(payload)
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeFileP2PSignal,
		FromUser:  "", // 服务端归口帧不携带发起人
		ToUser:    toUser,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// fileP2PCountByUser 统计发送方当前并发会话数（含协商中与传输中，DoS 边界归口）
func fileP2PCountByUser(username string) int {
	n := 0
	fileP2PMu.RLock()
	for _, sess := range fileP2PSessions {
		if sess.From == username {
			n++
		}
	}
	fileP2PMu.RUnlock()
	return n
}

// fileP2PSweep 懒清理过期会话：probe 后 15s 未进入协商 / 协商后 30s 未收到双方 done，
// 删除会话并向双方发服务端 abort（同 uploadSessionTimeout 懒清理模式：任一新信令触发清扫，
// 不启用定时器风暴；无人触发时由客户端 30s 看门狗独立兜底回退）
func (s *Server) fileP2PSweep() {
	now := time.Now()
	fileP2PMu.Lock()
	var expired []*fileP2PSession
	for id, sess := range fileP2PSessions {
		anchor := sess.CreateAt
		limit := fileP2PProbeTimeout
		if sess.State == fileP2PStateAccepted {
			// 阶段一百五十六补丁：协商后以最近信令活跃时间兜底（客户端传输期每 15s ping 刷新），
			// 长传输不再被固定锚点误杀；LastActive 为零值（旧数据/异常）回退 AcceptAt
			anchor = sess.LastActive
			if anchor.IsZero() {
				anchor = sess.AcceptAt
			}
			limit = fileP2PDoneTimeout
		}
		if now.Sub(anchor) > limit {
			delete(fileP2PSessions, id)
			expired = append(expired, sess)
		}
	}
	fileP2PMu.Unlock()
	for _, sess := range expired {
		reason := "timeout"
		logger.Warn("文件直传会话超时清理：%s → %s（transfer_id=%s）", sess.From, sess.To, sess.ID)
		s.fileP2PSystem(sess.From, map[string]interface{}{"action": "abort", "transfer_id": sess.ID, "reason": reason})
		s.fileP2PSystem(sess.To, map[string]interface{}{"action": "abort", "transfer_id": sess.ID, "reason": reason})
	}
}

// fileP2PProbe 发送方发起直传探测（决策归口：逐项校验不满足即 probe_fail，发送方立即回退 HTTP 链路不产生等待）
func (s *Server) fileP2PProbe(c *Client, msg *protocol.Message, from string, p *fileP2PSignalPayload) {
	// 懒清理入口：新探测触发一次过期会话清扫
	s.fileP2PSweep()

	to := msg.ToUser
	if to == "" || to == from {
		s.sendError(c, "文件直传对象无效")
		return
	}
	var body fileP2PProbeBody
	_ = json.Unmarshal([]byte(msg.Content), &body)
	if body.Size <= 0 {
		s.sendError(c, "文件直传信令缺少文件大小")
		return
	}

	// 总开关归口（false 时全部文件走现有链路）
	if !s.cfg.FileP2P.Enabled {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "disabled"})
		return
	}
	// 大小上限归口（复用 max_direct_size，防超大文件滥用）
	if body.Size > int64(s.cfg.MaxDirectSize) {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "toobig"})
		return
	}
	// 单用户并发会话上限归口（DoS 边界）
	if fileP2PCountByUser(from) >= s.cfg.FileP2P.MaxPerUser {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "busy"})
		return
	}
	// 目标用户存在且未注销（口径与通话一致）
	var u model.User
	if err := store.DB.Where("username = ? AND status = ?", to, model.UserStatusNormal).First(&u).Error; err != nil {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "offline"})
		return
	}
	// 好友关系强校验（仅限好友之间，口径与远程协助一致）
	if !s.isFriend(from, to) {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "forbidden"})
		return
	}
	// 黑名单任一方向拉黑即禁止直传（与私聊同水位）
	if s.isBlocked(from, to) {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "forbidden"})
		return
	}
	// 接收方可 P2P 端在线判定（hub 在线 + 平台非手机，同 hub.HasCall 先例；离线走现有 HTTP 链路历史行为）
	if !s.hub.HasCall(to) {
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "offline"})
		return
	}

	sess := &fileP2PSession{
		ID:       p.TransferID,
		From:     from,
		To:       to,
		FileName: body.Name,
		FileSize: body.Size,
		Nonce:    body.Nonce,
		SHA256:   body.SHA256,
		State:    fileP2PStateNegotiating,
		CreateAt: time.Now(),
	}
	fileP2PMu.Lock()
	if _, exists := fileP2PSessions[sess.ID]; exists {
		// transfer_id 冲突（重发/碰撞）：拒绝重复建会话
		fileP2PMu.Unlock()
		s.fileP2PSystem(from, map[string]interface{}{"action": "probe_fail", "transfer_id": p.TransferID, "reason": "busy"})
		return
	}
	fileP2PSessions[sess.ID] = sess
	fileP2PMu.Unlock()

	logger.Info("文件直传探测：%s → %s（%s，%d 字节，transfer_id=%s）", from, to, body.Name, body.Size, sess.ID)
	// probe 转发到接收方全部在线端（TURN 启用时服务端注入 iceServers，复用 callInjectICE）
	s.fileP2PForward(from, to, callInjectICE(msg.Content))
}

// fileP2PAccept 接收方应答（多端在线全部自动 accept，服务端会话表先到先得归口唯一赢家）
func (s *Server) fileP2PAccept(c *Client, msg *protocol.Message, from string, p *fileP2PSignalPayload) {
	sess := fileP2PSessionOf(p.TransferID)
	if sess == nil {
		// 会话已结束（超时竞态）：回服务端 abort 让该端立即回退，不等看门狗
		s.fileP2PSystem(from, map[string]interface{}{"action": "abort", "transfer_id": p.TransferID, "reason": "timeout"})
		return
	}
	fileP2PMu.Lock()
	// 防竞态：锁内校验会话仍有效（与懒清扫并发时防止操作孤儿会话，同 call.go callFinish 惯用法）
	if cur, ok := fileP2PSessions[sess.ID]; !ok || cur != sess {
		fileP2PMu.Unlock()
		return
	}
	// 参与者归口：仅接收方可 accept，发送方/无关人员帧静默丢弃
	if sess.To != from {
		fileP2PMu.Unlock()
		return
	}
	if sess.Accepted {
		// 竞态归口：赢家已锁定，后到端收服务端 abort(already_accepted) 自行收口
		fileP2PMu.Unlock()
		s.fileP2PSystem(from, map[string]interface{}{"action": "abort", "transfer_id": p.TransferID, "reason": "already_accepted"})
		return
	}
	sess.Accepted = true
	sess.State = fileP2PStateAccepted
	sess.AcceptAt = time.Now()
	sess.LastActive = sess.AcceptAt
	fileP2PMu.Unlock()

	logger.Info("文件直传应答：%s 接受 %s 的直传（端=%s，transfer_id=%s）", from, sess.From, p.Platform, sess.ID)
	// accept 转发发送方（from 强制接收方；TURN 启用时服务端注入 iceServers）
	s.fileP2PForward(from, sess.From, callInjectICE(msg.Content))
}

// fileP2PRelay WebRTC 协商中继（offer/answer/candidate）：校验会话存在与参与者身份后向对端转发，
// TURN 启用时服务端注入 iceServers（复用 callInjectICE，原样中继媒体字段不解析）
func (s *Server) fileP2PRelay(from, content string, p *fileP2PSignalPayload) {
	sess := fileP2PSessionOf(p.TransferID)
	if sess == nil {
		return // 会话已结束：静默丢弃（客户端看门狗兜底）
	}
	fileP2PMu.RLock()
	ok := sess.From == from || sess.To == from
	peer := ""
	if sess.From == from {
		peer = sess.To
	} else if sess.To == from {
		peer = sess.From
	}
	fileP2PMu.RUnlock()
	if !ok || peer == "" {
		return
	}
	// 阶段一百五十六补丁：协商中继帧刷新会话活跃（防长协商/传输被懒清扫误杀）
	fileP2PMu.Lock()
	if cur, ok2 := fileP2PSessions[sess.ID]; ok2 && cur == sess {
		sess.LastActive = time.Now()
	}
	fileP2PMu.Unlock()
	s.fileP2PForward(from, peer, callInjectICE(content))
}

// fileP2PPing 传输期保活帧（阶段一百五十六补丁）：客户端传输期间每 15s 上报，
// 服务端刷新会话活跃防懒清扫误杀长传输（服务端不参与数据面，无法感知传输是否存活），
// 并原样转发对端喂其看门狗；帧不落库不产生业务副作用
func (s *Server) fileP2PPing(from string, p *fileP2PSignalPayload) {
	sess := fileP2PSessionOf(p.TransferID)
	if sess == nil {
		return
	}
	fileP2PMu.Lock()
	var peer string
	if sess.From == from {
		peer = sess.To
	} else if sess.To == from {
		peer = sess.From
	}
	if peer != "" {
		if cur, ok := fileP2PSessions[sess.ID]; ok && cur == sess {
			sess.LastActive = time.Now()
		}
	}
	fileP2PMu.Unlock()
	if peer == "" {
		return
	}
	s.fileP2PForward(from, peer, `{"action":"ping","transfer_id":"`+sess.ID+`"}`)
}

// fileP2PAbort 任一方中止直传（协商失败/中途取消/校验失败），原 content 转发对方并清理会话；
// 客户端按 reason 决定是否自动回退 HTTP 链路（服务端只归口转发与会话清理）
func (s *Server) fileP2PAbort(from, content string, p *fileP2PSignalPayload) {
	sess := fileP2PSessionOf(p.TransferID)
	if sess == nil {
		return
	}
	fileP2PMu.RLock()
	ok := sess.From == from || sess.To == from
	peer := ""
	if sess.From == from {
		peer = sess.To
	} else if sess.To == from {
		peer = sess.From
	}
	fileP2PMu.RUnlock()
	if !ok || peer == "" {
		return
	}
	fileP2PMu.Lock()
	// 防竞态：锁内校验会话仍有效（与懒清扫并发时防止误删同名新会话）
	if cur, ok := fileP2PSessions[sess.ID]; !ok || cur != sess {
		fileP2PMu.Unlock()
		return
	}
	delete(fileP2PSessions, sess.ID)
	fileP2PMu.Unlock()
	logger.Info("文件直传中止：%s（transfer_id=%s）", from, sess.ID)
	s.fileP2PForward(from, peer, content)
}

// fileP2PDone 传输完成上报（双方各自上报，服务端归口落库）：
// 双方齐备才写 im_message（msg_type=5 文件消息，content 携带 p2p=true 与空 url），
// 落库后 done_ack 回填 msg_id 推送双方全部在线连接（气泡按 nonce 精确匹配转正式文件卡片）
func (s *Server) fileP2PDone(c *Client, msg *protocol.Message, from string, p *fileP2PSignalPayload) {
	sess := fileP2PSessionOf(p.TransferID)
	if sess == nil {
		return // 会话已结束（超时/已落库）：静默丢弃，防重复落库
	}
	var body fileP2PDoneBody
	_ = json.Unmarshal([]byte(msg.Content), &body)
	fileP2PMu.Lock()
	// 参与者归口 + 状态归口：仅协商锁定后的会话接受 done（防伪造与未协商先 done）
	if sess.From != from && sess.To != from {
		fileP2PMu.Unlock()
		return
	}
	if sess.State != fileP2PStateAccepted {
		fileP2PMu.Unlock()
		return
	}
	// 防竞态：锁内校验会话仍有效（与懒清扫并发时防止误删新会话，同 call.go callFinish 惯用法）
	if cur, ok := fileP2PSessions[sess.ID]; !ok || cur != sess {
		fileP2PMu.Unlock()
		return
	}
	if from == sess.From {
		sess.DoneFrom = true
	} else {
		sess.DoneTo = true
	}
	if body.SHA256 != "" {
		sess.SHA256 = body.SHA256 // 以双方上报归口终验哈希（probe 未携带时兜底补全）
	}
	// 双方齐备才落库（服务端归口：元信息与消息记录以双方确认为准）
	if !sess.DoneFrom || !sess.DoneTo {
		fileP2PMu.Unlock()
		return
	}
	// 快照后先删会话（防并发重复落库），落库失败走 abort 兜底
	snapshot := *sess
	delete(fileP2PSessions, sess.ID)
	fileP2PMu.Unlock()

	contentBytes, _ := json.Marshal(fileP2PMsgContent{
		URL:    "", // 直传不经服务器，url 恒空（历史下载走前端提示）
		Name:   snapshot.FileName,
		Size:   snapshot.FileSize,
		P2P:    true,
		SHA256: snapshot.SHA256,
		Nonce:  snapshot.Nonce,
	})
	record := model.Message{
		MsgType:  int8(MsgTypeFileSaved), // 文件消息（im_message 存储侧类型 5，与普通文件落库同命名空间）
		FromUser: snapshot.From,
		ToUser:   snapshot.To,
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("文件直传消息落库失败（transfer_id=%s）：%v", snapshot.ID, err)
		// 落库失败：通知双方中止，客户端自动回退 HTTP 链路重传
		s.fileP2PSystem(snapshot.From, map[string]interface{}{"action": "abort", "transfer_id": snapshot.ID, "reason": "persist_failed"})
		s.fileP2PSystem(snapshot.To, map[string]interface{}{"action": "abort", "transfer_id": snapshot.ID, "reason": "persist_failed"})
		return
	}

	// 更新双方会话摘要并推送（服务端归口文案，与普通文件消息同口径）
	s.touchConversation(snapshot.From, snapshot.To, "[文件]")
	s.touchConversation(snapshot.To, snapshot.From, "[文件]")
	s.notifyConvUpdate(snapshot.From)
	s.notifyConvUpdate(snapshot.To)

	logger.Info("文件直传完成：%s → %s，%s（%d 字节）→ 消息%d", snapshot.From, snapshot.To, snapshot.FileName, snapshot.FileSize, record.ID)

	// done_ack 回执推送双方全部在线连接：携带 transfer_id + msg_id + nonce（双端气泡按 nonce 精确回填 msg_id）
	ack := map[string]interface{}{
		"action":      "done_ack",
		"transfer_id": snapshot.ID,
		"msg_id":      record.ID,
		"nonce":       snapshot.Nonce,
	}
	s.fileP2PSystem(snapshot.From, ack)
	s.fileP2PSystem(snapshot.To, ack)
}
