package server

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// Server 服务端核心：承载连接管理、消息调度
type Server struct {
	cfg *config.Config
	hub *Hub
	// 阶段一百六十一：登录排队器（令牌桶准入 + FIFO 等待队列，重连风暴削峰）
	loginQ *loginQueue
	// 阶段三十二：超大文件分片直传会话表（upload_id → 会话），进度归口与收齐判定依据
	// 仅存内存（重启丢失即重传，不落库不进 Redis，超大文件场景避免高频写）
	uploadSessions map[string]*directUploadSession
	uploadMu       sync.RWMutex
	// 阶段二百二十一：未登录（半开）连接原子计数——恶意刷连接防护，
	// HandleWS 校验通过后 +1、readPump 退出时 -1，超 pending_limit 拒绝新连接
	pendingConns atomic.Int64
	// 阶段二百二十六：厂商推送投递队列（worker 池消费；未启用推送配置时恒空零开销）
	pushCh chan pushJob
	// 阶段二百四十六：红包发送幂等缓存（客户端令牌 → 首次收到时刻）。
	// 手机端启动卡顿窗口内双击"塞钱进红包"会连续上行两条同令牌 86 帧，服务端按
	// from_user+ct 去重只建一个红包（60 秒滑动窗口，重启丢失可接受——幂等窗口本就短）。
	rpCtSeen map[string]time.Time
	rpCtMu   sync.Mutex
}

// 阶段一百五十四：服务端实例引用（红包过期退回后台扫描等无连接上下文的包级函数广播帧用）
var defaultServerRef *Server

// defaultServer 获取服务端实例（未初始化返回 nil，调用方自行判空）
func defaultServer() *Server {
	return defaultServerRef
}

// NewServer 创建服务端实例
func NewServer(cfg *config.Config) *Server {
	s := &Server{
		cfg:            cfg,
		hub:            NewHub(),
		uploadSessions: make(map[string]*directUploadSession),
		rpCtSeen:       make(map[string]time.Time), // 阶段二百四十六：红包发送幂等缓存
	}
	defaultServerRef = s
	// 阶段一百六十一：登录排队器（enabled=false 时零开销旁路）
	s.loginQ = newLoginQueue(cfg.LoginQueue)
	s.loginQ.start()
	// 并发优化 E1：消息批量落库 worker（全站高频 Message 写归口，单事务批写一次 fsync）
	startMessageBatchWorker()
	// 阶段二百二十六：厂商推送投递 worker 池（未启用推送配置时队列恒空零开销）
	s.startPushWorkers()
	// 集群总线：cluster_enabled=true 时启动订阅消费端并注入 hub（默认关闭=单实例零行为变化）
	s.startClusterBus(cfg)
	if s.hub.bus != nil {
		startUserListCleanup()
	}
	startAlertEvaluator(s) // 监控告警评估协程（30s 周期，仪表盘告警横幅数据源）
	return s
}

// rejectWS 拒绝连接：同步写一条 ERROR 提示帧后关闭——客户端可感知拒绝原因，
// 前端 lastRejectAt 机制据 ERROR 帧停止自动重连，避免被拒端 3 秒重试持续轰击
func rejectWS(conn *websocket.Conn, text string) {
	errMsg, _ := json.Marshal(&protocol.Message{MsgType: protocol.MsgTypeError, Content: text})
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	conn.WriteMessage(websocket.TextMessage, errMsg)
	conn.Close()
}

// HandleWS 处理新连接（realIP=经反代透传的真实客户端 IP，限流按真实 IP 分桶）
func (s *Server) HandleWS(conn *websocket.Conn, realIP string) {
	// 异常连接防护：单 IP 高频限制（拒绝时回 ERROR 帧让前端停止重试风暴）
	if !s.checkIPLimit(realIP) {
		logger.Warn("拒绝高频连接: %s", realIP)
		rejectWS(conn, "连接过于频繁，请稍后重试")
		return
	}

	// 阶段二百二十一：未登录连接数上限——原实现未登录连接不受任何总量约束
	// （max_connections 校验的 hub.TotalConns 仅统计已登录连接），恶意刷连接/重连风暴
	// 可无限占用 goroutine 与内存直至 OOM；超限回 ERROR 帧后关闭
	if s.pendingConns.Load() >= int64(s.cfg.PendingLimit) {
		logger.Warn("拒绝新连接: 未登录连接数已达上限 %d", s.cfg.PendingLimit)
		rejectWS(conn, "服务器繁忙，请稍后重试")
		return
	}

	// 阶段三十一：最大在线连接数限制（max_connections 配置）
	// 原实现：该配置项从未被执行校验，连接数仅受系统资源约束
	if s.cfg.MaxConnections > 0 && s.hub.TotalConns() >= s.cfg.MaxConnections {
		logger.Warn("拒绝新连接: 在线连接数已达上限 %d", s.cfg.MaxConnections)
		rejectWS(conn, "服务器连接数已达上限，请稍后重试")
		return
	}

	// 接入日志在全部校验通过后打印（带真实 IP）——拒绝连接不刷 INFO 日志，防日志 IO 噪声
	logger.Info("客户端接入: %s", realIP)
	c := newClient(s, conn, realIP)
	s.pendingConns.Add(1)
	go c.writePump()
	c.readPump()
}

// sendToUser 向指定用户的全部在线连接推送数据（多端同步归口）
// 集群模式：本地投递 + 总线定向信封（各实例对本实例内该用户连接投递，From==self 回环跳过）
// 跨实例段为尽力而为（总线 fire-and-forget）；本地段语义不变
func (s *Server) sendToUser(username string, data []byte) {
	if s.hub.bus != nil {
		s.hub.bus.publish(&busEnvelope{Kind: busKindDirect, Targets: []string{username}, Data: data})
	}
	s.deliverLocal(username, data)
}

// sendToUsers 批量定向推送（多群成员等多人场景）：一次总线信封覆盖全部目标，
// 避免逐用户 PUBLISH 的 N 次往返（千人群每条消息 1000 次往返 → 1 次）
func (s *Server) sendToUsers(usernames []string, data []byte) {
	if len(usernames) == 0 {
		return
	}
	if s.hub.bus != nil {
		s.hub.bus.publish(&busEnvelope{Kind: busKindDirect, Targets: usernames, Data: data})
	}
	for _, name := range usernames {
		s.deliverLocal(name, data)
	}
}

// deliverLocal 纯本地定向投递（总线订阅回调回环投递归口）
func (s *Server) deliverLocal(username string, data []byte) {
	for _, c := range s.hub.GetAll(username) {
		c.send(data)
	}
}

// sendToUserBlock 向指定用户的全部在线连接阻塞推送（带超时）：文件分片等不可丢弃消息使用
// 阶段三十一：任一连接推送失败返回 false，由调用方向发送方反馈传输失败（原实现静默丢弃分片导致文件损坏）
func (s *Server) sendToUserBlock(username string, data []byte, timeout time.Duration) bool {
	ok := true
	for _, c := range s.hub.GetAll(username) {
		if !c.sendBlock(data, timeout) {
			ok = false
		}
	}
	return ok
}

// unregister 连接断开后的清理（按连接移除，同账号其他设备仍在线时不判定离线）
func (s *Server) unregister(c *Client) {
	// 阶段一百九十八：连接断开即吊销其网盘 API token（按 token 吊销，其他端 token 不受影响；
	// 未登录连接 token 为空串，Revoke 内部判空安全）
	DriveTokenRevoke(c.driveToken)
	if c.username == "" {
		return
	}
	// 移除当前连接，返回该用户剩余连接数
	// 原实现：s.hub.Remove(c.username) 按用户名删除，旧连接断开时存在误删新连接的竞态
	remaining := s.hub.Remove(c)
	if remaining > 0 {
		// 其他设备仍在线：不下线、不删缓存、不广播
		logger.Info("用户 %s 一台设备断开，剩余在线连接 %d", c.username, remaining)
		return
	}

	// 最后一个连接断开：删除 Redis 在线缓存
	store.RDB.Del(context.Background(), store.KeyOnlineUser+c.username)

	// 5号帧热点修复：下线通知不再单独全员广播（原每事件 O(N)，churn 风暴热点），
	// 并入 93 增量帧 1s 窗口聚合广播——好友在线态与会话上下线提示由前端增量处理器统一维护
	logger.Info("用户 %s 下线", c.username)

	// 阶段二百四十三：下线广播宽限调度（APP 端息屏/切后台连接交接好友无感，见 offlineBroadcastGrace 说明）。
	// 仅延迟"展示面"广播（93 增量/名单/集群在场事件）；Redis 在线缓存已在上方立即删除，
	// 消息路由与离线队列判定（isOnlineFast/isOnline）不受宽限影响，宽限期内新消息照常入离线队列
	s.scheduleOfflineBroadcast(c.username)

	// 通话/会议状态离线收口：响铃/通话/会议中掉线若不收口，忙态与房间残留，
	// 重连后被服务端恒判"忙"（无法再发起/被邀）。hangup 未命中 1v1 会话时自动回落
	// 会议退出（meetLeave），两种状态均全收口（余员通知 + 清忙 + 空会解散落话单）
	callOfflineCleanup(s, c.username)
	// 阶段一百五十五：远程协助状态离线收口（等待响应立即收口；协助中 30s 宽限，重连自动恢复）
	remoteOfflineCleanup(s, c.username)
}

// ===== 阶段二百四十三：下线广播宽限（APP 端息屏/切后台连接交接好友无感） =====
// APP 端停留在页面期间手机息屏/短暂切出会触发连接交接：页面 WebSocket 主动断开 →
// 原生前台服务（KeepAliveService，同协议同 platform）重连接管，重连耗时约 1~3 秒
// （跨进程拉起 + 公网 RTT）。交接期间该用户真实离线数秒，原实现下线增量直接入 1s 聚合
// 窗口——交接常超 1 秒，窗口过期即广播，好友看到"下线→上线"闪烁（用户观感即"莫名断线"）。
// 现加宽限期：最后一个连接断开时挂起下线广播，宽限内任一连接重新登录（handleLogin 调
// cancelOfflineBroadcast）即整体取消——好友全程无感；宽限耗尽仍未上线才真正广播下线，
// 真实离线场景仅延迟展示，无语义变化。集群模式的在场摘除（HDel/publishPresenceOff）
// 一并随宽限延迟，重连取消时两者同步取消（HSet 在登录路径先行续写，状态自洽）
const offlineBroadcastGrace = 5 * time.Second

var (
	offlineGraceMu     sync.Mutex
	offlineGraceTimers = make(map[string]*time.Timer) // 宽限期中的用户 → 下线广播定时器
)

// scheduleOfflineBroadcast 宽限调度下线广播（unregister 最后连接断开路径调用）：
// 同用户重复调度时续窗（多端先后断开），定时器到点仍离线才入队下线增量与集群在场摘除
func (s *Server) scheduleOfflineBroadcast(username string) {
	offlineGraceMu.Lock()
	if t := offlineGraceTimers[username]; t != nil {
		t.Reset(offlineBroadcastGrace)
	} else {
		offlineGraceTimers[username] = time.AfterFunc(offlineBroadcastGrace, func() {
			offlineGraceMu.Lock()
			delete(offlineGraceTimers, username)
			offlineGraceMu.Unlock()
			// 宽限内已重连（本实例 hub 或集群其他实例接管）：无需广播（防御性双查，
			// 正常路径重连时 cancelOfflineBroadcast 已先行取消定时器）
			if s.isOnlineFast(username) {
				return
			}
			logger.Info("用户 %s 下线广播宽限到期，正式广播下线", username)
			// 5万容量改造（E9）：在线名单增量广播（其余用户摘除本用户）
			s.pushUserListOffline(username)
			// 集群模式：同步摘除全局在线名单条目 + 发布在场下线事件——其他实例本地仍有该用户
			// 连接（多端跨实例）时抢注续写（cluster.go 订阅回调），防止多端场景误判全端离线
			if s.hub.bus != nil {
				store.RDB.HDel(context.Background(), KeyUserList, username)
				s.hub.bus.publishPresenceOff(username)
				invalidateGlobalListCache()
			}
		})
	}
	offlineGraceMu.Unlock()
}

// cancelOfflineBroadcast 用户重新上线时取消挂起中的下线广播（handleLogin 登录成功路径调用）：
// 宽限内回来 = 交接/闪断自愈，好友全程无感
func cancelOfflineBroadcast(username string) {
	offlineGraceMu.Lock()
	if t := offlineGraceTimers[username]; t != nil {
		t.Stop()
		delete(offlineGraceTimers, username)
		offlineGraceMu.Unlock()
		logger.Info("用户 %s 宽限期内重连，已取消下线广播", username)
		return
	}
	offlineGraceMu.Unlock()
}

// callOfflineCleanup 用户最后连接离线时的通话状态归口清理（callUserBusy 全覆盖 1v1 与会议）
// 阶段一百四十七修复：切网场景信令 WS 闪断（数秒后重连）≠ 媒体断线（媒体走 TURN/UDP 与信令独立），
// 原实现对通话中会话立即收口，误杀切网自愈中的通话（WS 回来会话已删，无法恢复）。
// 现策略：响铃中仍立即收口（对方在等，宽限无意义）；通话中走 30s 宽限——期间用户任一连接重连上线
// 即取消收口（媒体由客户端 ICE restart 自动恢复），超时未回按原逻辑收口（忙态不残留）。
// 原说明：会议收口路径保持原立即收口（会议 Mesh 恢复复杂度高，本期不动）。
// 阶段一百四十八：会议已入会成员同样走 30s 宽限（meetArmOfflineGrace，媒体由客户端成员级
// ICE restart 自动恢复），超时未回按 meetLeave 移出；响铃中被邀人仍立即收口
func callOfflineCleanup(s *Server, username string) {
	callMu.RLock()
	callID, busy := callUserBusy[username]
	callMu.RUnlock()
	if !busy {
		return
	}
	sess := callSessionOf(callID)
	if sess != nil && sess.State == callStateActive {
		callMu.Lock()
		if sess.offlineTimer == nil { // 幂等：宽限定时器已在跑不重复起（多连接闪断场景）
			logger.Info("通话 %s：用户 %s 信令断开，%v 内重连自动恢复通话", callID, username, callOfflineGrace)
			sess.offlineTimer = time.AfterFunc(callOfflineGrace, func() {
				callMu.Lock()
				if cur, ok := callSessions[callID]; !ok || cur != sess { // 会话已被其他路径收口：空转
					callMu.Unlock()
					return
				}
				sess.offlineTimer = nil
				callMu.Unlock()
				logger.Info("通话 %s：用户 %s 宽限期未重连，自动收口", callID, username)
				s.callHangup(nil, nil, username, &callSignalPayload{Action: "hangup", CallID: callID})
			})
		}
		callMu.Unlock()
		return
	}
	// 阶段一百四十八：会议房间（1v1 会话表未命中）——已入会成员走宽限，其余立即收口
	// 原代码：直接 callHangup（落 meetLeave 立即收口，切网成员被误移出会议）
	if room := meetRoomOf(callID); room != nil && s.meetArmOfflineGrace(room, username) {
		return
	}
	s.callHangup(nil, nil, username, &callSignalPayload{Action: "hangup", CallID: callID})
}

// callCancelOfflineHangup 用户重连上线时取消其活跃通话的下线宽限收口（宽限期内回来 = 通话继续）；
// 媒体面由客户端 ICE restart 自动恢复，服务端只需不收口
func callCancelOfflineHangup(username string) {
	callMu.Lock()
	for id, sess := range callSessions {
		if sess.State != callStateActive || (sess.Caller != username && sess.Callee != username) {
			continue
		}
		if sess.offlineTimer != nil {
			sess.offlineTimer.Stop()
			sess.offlineTimer = nil
			logger.Info("通话 %s：用户 %s 宽限期内重连，通话继续", id, username)
		}
	}
	callMu.Unlock()
}

// handleMessage 消息分发
func (s *Server) handleMessage(c *Client, msg *protocol.Message) {
	switch msg.MsgType {
	case protocol.MsgTypeLogin:
		s.handleLogin(c, msg)
	case protocol.MsgTypeHeartbeat:
		s.handleHeartbeat(c)
	case protocol.MsgTypeGroupChat:
		s.handleGroupChat(c, msg)
	case protocol.MsgTypePrivate:
		s.handlePrivateChat(c, msg)
	case protocol.MsgTypeHistory:
		s.handleHistory(c, msg)
	case protocol.MsgTypeFile:
		s.handleFile(c, msg)
	case protocol.MsgTypeTyping:
		s.handleTyping(c, msg)
	case protocol.MsgTypeRead:
		s.handleRead(c, msg)
	case protocol.MsgTypeRecall:
		s.handleRecall(c, msg)
	case protocol.MsgTypeDelete:
		s.handleDelete(c, msg)
	case protocol.MsgTypeSearch:
		s.handleSearch(c, msg)
	case protocol.MsgTypeConvPin:
		s.handleConvPin(c, msg)
	case protocol.MsgTypeConvClear:
		s.handleConvClear(c, msg)
	case protocol.MsgTypeConvDelete:
		s.handleConvDelete(c, msg)
	case protocol.MsgTypeMsgPin:
		s.handleMsgPin(c, msg)
	case protocol.MsgTypeConvSearch:
		s.handleConvSearch(c, msg)
	case protocol.MsgTypeFriendRequest:
		s.handleFriendRequest(c, msg)
	case protocol.MsgTypeFriendRequestResp:
		s.handleFriendRequestResp(c, msg)
	// 阶段二十九：好友申请列表查询（微信式"新的朋友"归口）
	case protocol.MsgTypeFriendReqList:
		s.handleFriendReqList(c, msg)
	// 阶段一百五十四：积分红包（发送/打开/详情查询；88 状态同步为纯下行帧无上行分支）
	case protocol.MsgTypeRedPacket:
		s.handleRedPacketSend(c, msg)
	case protocol.MsgTypeRedPacketOpen:
		s.handleRedPacketOpen(c, msg)
	case protocol.MsgTypeRedPacketDetail:
		s.handleRedPacketDetail(c, msg)
	case protocol.MsgTypeFriendDelete:
		s.handleFriendDelete(c, msg)
	case protocol.MsgTypeBlacklist:
		s.handleBlacklist(c, msg)
	case protocol.MsgTypeFriendUpdate:
		s.handleFriendUpdate(c, msg)
	// 阶段三十：个人资料更新（微信式资料面板）与查询（微信式好友资料卡）
	case protocol.MsgTypeProfileUpdate:
		s.handleProfileUpdate(c, msg)
	case protocol.MsgTypeProfileQuery:
		s.handleProfileQuery(c, msg)
	// 阶段三十二：超大文件分片直传取消（发送方上行，服务端清理会话并同步双方）
	case protocol.MsgTypeFileCancel:
		s.handleFileCancel(c, msg)
	// 阶段二百二十六：厂商推送 regId 上报（APP 端登录后上报，离线通知投递依据）
	case protocol.MsgTypePushRegID:
		s.handlePushRegID(c, msg)
	// 阶段四十三：AI 问答（智能体列表查询 + 流式问答）
	case protocol.MsgTypeAIAgents:
		s.handleAIAgents(c, msg)
	case protocol.MsgTypeAIChat:
		s.handleAIChatMsg(c, msg)
	// 阶段七十三：AI 流式问答停止（Trae 同款"停止"按钮）
	case protocol.MsgTypeAIStop:
		s.handleAIStop(c, msg)
	// 阶段五十九：智能 Agent 自动化任务（任务发起/取消 + 审批结果上行）
	case protocol.MsgTypeAgentRun:
		s.handleAgentRun(c, msg)
	case protocol.MsgTypeAgentApprove:
		s.handleAgentApprove(c, msg)
	// 阶段一百二十五：Agent 向用户提问的回答上行（TRAE CN 同款，任务挂起等待用户决策后继续）
	case protocol.MsgTypeAgentAsk:
		s.handleAgentAsk(c, msg)
	// 阶段一百六十四：计划模式计划审批结果上行（TRAE CN Plan 同款，批准前工具门禁锁定副作用操作）
	case protocol.MsgTypeAgentPlan:
		s.handleAgentPlan(c, msg)
	// 阶段六十：Agent 本地执行器——PC 端回传本地工具执行结果
	case protocol.MsgTypeAgentExecResp:
		s.handleAgentExecResp(c, msg)
	// 阶段六十一：Agent 沙箱白名单——PC 端上报用户自选工作区/授权目录
	case protocol.MsgTypeAgentSandbox:
		s.handleAgentSandbox(c, msg)
	// 阶段七十五：命令实时输出流（PC 上行转发任务事件流）+ 长命令转后台
	case protocol.MsgTypeAgentToolOutput:
		s.handleAgentToolOutput(c, msg)
	case protocol.MsgTypeAgentBg:
		s.handleAgentBg(c, msg)
	// 阶段七十六：工作区文件面板（web 请求归口 + PC 本地文件操作回传投递）
	case protocol.MsgTypeWsFileReq:
		s.handleWsFileReq(c, msg)
	case protocol.MsgTypePcFileResp:
		s.handlePcFileResp(c, msg)
	// 阶段七十七：文件变更审查（保留/撤销，回下行 66 全量刷新帧）
	case protocol.MsgTypeAgentChanges:
		s.handleAgentChanges(c, msg)
	// 阶段九十：用户自定义本机 MCP 工具清单上报（注入 Agent 工具 schema，调用经 PC 本地执行器执行）
	case protocol.MsgTypeAgentPcTools:
		s.handleAgentPcTools(c, msg)
	// 阶段七十一：AI 多会话（Trae 同款"新建会话"）——列表/新建/删除
	case protocol.MsgTypeAISessionList:
		s.handleAISessionList(c, msg)
	case protocol.MsgTypeAISessionNew:
		s.handleAISessionNew(c, msg)
	// 阶段七十二：私聊永久删除审批（发起/响应，会话内审批卡片）
	case protocol.MsgTypePurgeApply:
		s.handlePurgeApply(c, msg)
	case protocol.MsgTypePurgeResp:
		s.handlePurgeResp(c, msg)
	case protocol.MsgTypeAISessionDel:
		s.handleAISessionDel(c, msg)
	// 阶段一百四十一：音视频通话信令（invite/accept/reject/cancel/hangup + WebRTC 媒体中继，话单服务端归口）
	case protocol.MsgTypeCallSignal:
		s.HandleCallSignal(c, msg)
	// 阶段一百五十五：QQ 同款远程协助信令（invite/accept/reject/cancel/disconnect + WebRTC 媒体中继，好友强校验，话单服务端归口）
	case protocol.MsgTypeRemoteSignal:
		s.HandleRemoteSignal(c, msg)
	// 阶段一百五十六：好友文件 P2P 直传信令（probe/accept/协商中继/done 落库归口，好友强校验，文件字节点对点不过服务器）
	case protocol.MsgTypeFileP2PSignal:
		s.HandleFileP2PSignal(c, msg)
	// 阶段一百四十二：微信同款多群聊信令（建群 / 邀请入群 / 邀请响应）
	case protocol.MsgTypeGroupCreate:
		s.handleGroupCreate(c, msg)
	case protocol.MsgTypeGroupInvite:
		s.handleGroupInvite(c, msg)
	case protocol.MsgTypeGroupInviteResp:
		s.handleGroupInviteResp(c, msg)
	// 阶段一百四十三：群设置面板信令（群设置修改 / 移出成员 / 退出群聊）
	case protocol.MsgTypeGroupSetting:
		s.handleGroupSetting(c, msg)
	case protocol.MsgTypeGroupKick:
		s.handleGroupKick(c, msg)
	case protocol.MsgTypeGroupQuit:
		s.handleGroupQuit(c, msg)
	// 阶段一四五：独立注册页注册信令（注册页短连接，注册成功/失败均回执后由客户端自行断开）
	case protocol.MsgTypeRegister:
		s.handleRegister(c, msg)
	// 阶段二百四十：扫码登录确认信令（手机端已登录态扫描/确认/取消，归口 qrlogin.go）
	case protocol.MsgTypeQRSign:
		s.HandleQRSign(c, msg)
	default:
		s.sendError(c, "未知消息类型")
	}
}

// handleLogin 处理登录/注册
func (s *Server) handleLogin(c *Client, msg *protocol.Message) {
	username := msg.FromUser
	password := msg.Content

	// 阶段一百六十一：登录排队准入——排队必须在密码验证之前（排队保护的核心资源正是
	// 验证 DB 查询与登录后推送链路，验证后再排队等于没排队）；排队期间 94 帧定期推送
	// 排队位置，超时/队列满由排队器直接回执拒绝（返回 false 即终止登录，不进验证链路）
	if !s.loginQ.admit(c, username) {
		return
	}

	// 阶段二百四十：扫码登录通道判定（content 前缀 qrc: → 一次性登录码换账号，免密码登录；
	// 登录码由手机端扫码确认后签发，归口 qrlogin.go）——命中后按绑定账号走收尾登录链路
	if strings.HasPrefix(password, QRLoginCodePrefix) {
		user, qerr := qrLoginResolveUser(password)
		if qerr != nil {
			c.SendErrorAndClose(qerr.Error())
			return
		}
		s.finishLogin(c, msg, user)
		return
	}

	// 登录注册开关改造（阶段一四五）：
	// 原实现：用户不存在（ErrUserNotFound）时无条件自动注册，"首次登录即注册"
	// 现改为受后台 config.yaml 注册开关 register_enabled 控制：
	//   true  = 保留自动注册默认行为（存量部署零回归）
	//   false = 不再自动注册，提示"该账号不存在，请先注册账号"引导用户前往独立注册页
	user, err := verifyUser(username, password)
	if err == ErrUserNotFound {
		if s.cfg.RegisterEnabled {
			// 注册开关开启：尝试注册（全局群废弃：注册名单缓存已随全局群离线入队归口删除）
			user, err = registerUser(username, password)
		} else {
			// 注册开关关闭：登录链路不做静默注册，明确提示需先注册账号
			err = ErrNeedRegister
		}
	}
	if err != nil {
		// 登录失败提示修复：原实现 sendError 走发送队列异步写出后立即 Close，
		// 错误消息常因竞态来不及送达客户端，导致密码错误等场景无任何提示
		// 现改为同步写错误消息送达后再关闭连接
		// 原代码：s.sendError(c, err.Error()); c.Close()
		// 错误分级：仅业务校验错误（用户名或密码错误/密码不能为空等）原样下发；
		// 底层依赖错误（如 MySQL 空闲连接失效的 invalid connection）统一下发通用中文提示，
		// 完整错误记日志排查——避免英文底层错误直接暴露给客户端
		userErrMsg := err.Error()
		if !isAuthBusinessError(err) {
			logger.Error("登录底层依赖异常: %v", err)
			userErrMsg = "登录服务暂不可用，请稍后重试"
		}
		c.SendErrorAndClose(userErrMsg)
		return
	}

	// 阶段一百三十五：账号状态拦截移入 finishLogin（扫码登录共用同一状态拦截水位）
	s.finishLogin(c, msg, user)
}

// finishLogin 阶段二百四十：登录收尾链路归口（密码验证通过 / 扫码凭码通过 共用同一链路）
// 职责：账号状态拦截 → 会话绑定 → hub 注册 → Redis 在线缓存 → 登录响应下发 → 10 项并行推送 →
// 通话/会议/协助宽限取消。原 handleLogin 尾段原样抽取，行为时序不变
func (s *Server) finishLogin(c *Client, msg *protocol.Message, user *model.User) {
	// 阶段一百三十五：账号状态拦截（锁定封禁/已注销）——仅凭据校验通过的存量账号命中
	// （新注册账号恒为正常态），拒绝原因（含封禁原因）同步下发后关闭连接，前端弹窗提示
	if rejectMsg := userStatusRejectMsg(user); rejectMsg != "" {
		c.SendErrorAndClose(rejectMsg)
		return
	}

	c.username = user.Username
	c.loginTime = time.Now() // 记录登录时间，用于好友申请去重
	// 阶段一百九十八：签发网盘 API 鉴权 token（登录回执下发；连接断开即吊销，签发失败回空串走前端兼容路径）
	c.driveToken = DriveTokenIssue(user.Username)
	// 阶段六十：记录登录设备类型（"pc"=Electron 桌面端）——Agent 本地执行器据此判定工具下发目标
	c.platform = strings.TrimSpace(msg.Platform)
	// 5万容量改造（E9）：首设备判定改由 Add 返回（加入前连接集合为空）——
	// 原实现 Add 后 Count==1：同端互踢替换登录时旧连接已被同步移除，Count 同样为 1，
	// 误判首设备导致上线通知/名单增量重复广播（探针 T6 暴露）
	firstDevice := s.hub.Add(c)
	// 阶段二百四十三：登录重连取消挂起中的下线广播宽限（APP 息屏/切后台交接、切网闪断回来，好友无感）
	cancelOfflineBroadcast(user.Username)

	// 写入 Redis 在线缓存
	ctx := context.Background()
	store.RDB.Set(ctx, store.KeyOnlineUser+user.Username, "online", 120*time.Second)
	// 集群模式：登记全局在线名单（用户 → 心跳时间戳，跨实例 USER_LIST/在线判定/群 fanout 数据源）
	if s.hub.bus != nil {
		store.RDB.HSet(ctx, KeyUserList, user.Username, strconv.FormatInt(time.Now().Unix(), 10))
		invalidateGlobalListCache()
	}

	// 登录成功响应
	// 头像缺失修复：原实现仅下发 result 与 recall_window，前端拿不到自己头像，聊天消息气泡无法渲染头像
	// 原代码：s.sendLoginResp(c, "ok")
	// 阶段三十：改传整个 user，登录响应携带完整个人资料（昵称/性别/地区/签名）
	s.sendLoginResp(c, "ok", *user)

	// 仅首个设备上线时广播上线通知，多端重复登录/同端替换登录不重复广播（E9：判定改用 Add 返回值）
	// 5号帧热点修复：上线通知不再单独全员广播（原每事件 O(N)，上下线 churn 风暴下成为热点），
	// 并入下方 93 增量帧 1s 窗口聚合广播——好友在线态由前端增量处理器统一维护
	if firstDevice {
		// 5万容量改造（E9）：在线名单增量广播——其余用户补录本用户+头像（1s 窗口聚合），
		// 替代原全量快照广播（原实现广播帧体积与总下行随在线人数平方增长）
		s.pushUserListOnline(UserInfo{Username: user.Username, Avatar: user.Avatar})
	}

	// 5万容量改造（E9）：全量在线名单快照改为仅登录者单发（原 pushUserList 全量广播，见 E9 区块说明），
	// 移入并行推送组避免快照构建（全员名单序列化 + 头像缓存查询）阻塞登录链路

	// 并发改造 B2：登录后推送并行化——原 10 项推送串行执行（15+ 次 DB/Redis 往返逐个排队，
	// 登录延迟为全部往返之和），现相互独立的推送并行执行，登录延迟从"各往返之和"降为"最慢一组"。
	// 全局群废弃：ensureGroupConv（登录补建全局群会话行）已删除，pushConvList 直接读取既有会话行；
	// 其余 10 项（名单快照单发/离线补发/好友/申请/黑名单/群列表/群邀请/置顶/审批/已读水位）
	// 均为只读 + 经 sendCh 线程安全下发，互不依赖，WaitGroup 并行 + 末尾统一收口，
	// 与原串行行为时序等价（handleLogin 返回前登录期帧已全部入队）
	var wg sync.WaitGroup
	wg.Add(10)
	go func() { defer wg.Done(); s.pushUserListSnapshot(c) }()
	go func() { defer wg.Done(); s.pushOfflineMessages(c) }()
	go func() { defer wg.Done(); s.pushFriendList(c) }()
	go func() { defer wg.Done(); s.pushPendingRequests(c) }()
	go func() { defer wg.Done(); s.pushBlacklist(c) }()
	go func() { defer wg.Done(); s.sendGroupListSync(user.Username) }()
	go func() { defer wg.Done(); s.pushPendingGroupInvites(c) }()
	go func() { defer wg.Done(); s.pushPinList(c) }()
	go func() { defer wg.Done(); s.pushPendingPurges(c) }()
	go func() { defer wg.Done(); s.pushReadWatermarks(c) }()
	s.pushConvList(c)
	wg.Wait()
	// 阶段一百四十七：登录重连取消其活跃通话的下线宽限收口（切网闪断回来，通话继续）
	callCancelOfflineHangup(user.Username)
	// 阶段一百四十八：登录重连取消其所在会议房间的断网宽限收口（切网闪断回来，会议继续）
	meetCancelOfflineHangup(user.Username)
	// 阶段一百五十五：登录重连取消其活跃远程协助的下线宽限收口（切网闪断回来，协助继续）
	remoteCancelOfflineGrace(user.Username)
	logger.Info("用户 %s 上线", user.Username)
}

// handleRegister 阶段一四五：独立注册页注册信令处理（msg_type=85 双向同类型）
// 上行：from_user=用户名，content=密码；下行：content="ok" 或业务错误提示文本
// 说明：注册页为短连接，注册成功不在此登录（客户端保存凭据后跳转 index.html 走正式登录链路），
// 失败时同步写错误后关闭连接（与 handleLogin 错误同模式，防异步队列竞态导致提示丢失）
func (s *Server) handleRegister(c *Client, msg *protocol.Message) {
	user, err := registerUser(msg.FromUser, msg.Content)
	if err != nil {
		// 错误分级：仅业务校验错误（用户名已存在/密码不能为空等）原样下发；
		// 底层依赖错误统一下发通用中文提示，完整错误记日志排查
		userErrMsg := err.Error()
		if !isAuthBusinessError(err) {
			logger.Error("注册底层依赖异常: %v", err)
			userErrMsg = "注册服务暂不可用，请稍后重试"
		}
		c.SendErrorAndClose(userErrMsg)
		return
	}
	// 注册成功：回执 ok（不登录不建会话），连接交由客户端自行断开
	resp := protocol.Message{
		MsgType: protocol.MsgTypeRegister,
		Content: "ok",
	}
	data, _ := json.Marshal(resp)
	c.send(data)
	logger.Info("用户 %s 注册成功（独立注册页）", user.Username)
	// 全局群废弃：注册名单缓存失效（usersCacheInvalidate + invUsers 总线广播）已随之删除
}

// handleHeartbeat 处理心跳，续期 Redis 在线缓存
func (s *Server) handleHeartbeat(c *Client) {
	ctx := context.Background()
	store.RDB.Set(ctx, store.KeyOnlineUser+c.username, "online", 120*time.Second)
	// 阶段一百九十八：网盘 token 在线续期（30 分钟节流）——在线用户 token 永不静默过期
	// （7 天 TTL 只对离线场景兜底），避免长时间在线后提取码显示静默消失；Expire 极轻，节流后可忽略
	if c.driveToken != "" && time.Since(c.lastTokenTouch) >= 30*time.Minute {
		c.lastTokenTouch = time.Now()
		store.RDB.Expire(ctx, store.KeyDriveToken+c.driveToken, driveTokenTTL)
	}
	// 集群模式：全局在线名单心跳续期（60s 新鲜度过滤的判定依据）
	if s.hub.bus != nil {
		store.RDB.HSet(ctx, KeyUserList, c.username, strconv.FormatInt(time.Now().Unix(), 10))
	}
}

// messageSummary 阶段四十：引用消息会话摘要归口——引用消息 content 为信封 JSON
// （{"quote":{"msg_id","from","text"},"text":"回复正文"}），会话列表摘要必须取回复正文，
// 否则 JSON 原串会直接显示在会话列表；解析失败（普通文本/历史数据）回退原文
func messageSummary(content string) string {
	var envelope struct {
		Quote json.RawMessage `json:"quote"`
		Text  string          `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &envelope); err == nil && envelope.Quote != nil && envelope.Text != "" {
		return envelope.Text
	}
	// 阶段四十四：AI 图片提问信封归口——会话摘要与模型上下文显示"[图片] 附言"，JSON 原串不外泄
	var imgEnv struct {
		Image string `json:"image"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &imgEnv); err == nil && imgEnv.Image != "" {
		if strings.TrimSpace(imgEnv.Text) == "" {
			return "[图片]"
		}
		return "[图片] " + imgEnv.Text
	}
	// 阶段四十五：AI 文档问答信封归口——会话摘要与模型历史上下文显示"[文档] 文件名 附言"，
	// JSON 原串不外泄；文档全文仅注入当次提问（handleAIChatMsg 归口），历史上下文只带摘要避免重复携带撑爆 token
	var docEnv struct {
		Doc  string `json:"doc"`
		Name string `json:"name"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &docEnv); err == nil && docEnv.Doc != "" {
		summary := "[文档] " + docEnv.Name
		if note := strings.TrimSpace(docEnv.Text); note != "" {
			summary += " " + note
		}
		return summary
	}
	// 阶段八十七：合并转发信封归口——会话摘要显示"[聊天记录] N条消息"，JSON 原串不外泄
	var mergedEnv struct {
		Merged struct {
			C int               `json:"c"`
			I []json.RawMessage `json:"i"`
		} `json:"merged"`
	}
	if err := json.Unmarshal([]byte(content), &mergedEnv); err == nil && (mergedEnv.Merged.C > 0 || len(mergedEnv.Merged.I) > 0) {
		count := mergedEnv.Merged.C
		if count == 0 {
			count = len(mergedEnv.Merged.I)
		}
		return "[聊天记录] " + strconv.Itoa(count) + "条消息"
	}
	// 阶段一百五十四：红包信封归口——会话摘要显示"[红包] 祝福语"，JSON 原串不外泄
	var rpEnv struct {
		RP struct {
			Greeting string `json:"greeting"`
		} `json:"rp"`
	}
	if err := json.Unmarshal([]byte(content), &rpEnv); err == nil && rpEnv.RP.Greeting != "" {
		return "[红包] " + rpEnv.RP.Greeting
	}
	return content
}

// ===== 阶段八十五：群聊发送者昵称下发（服务端归口） =====
// nickCache 昵称缓存：群聊每条消息/每页历史都要携带发送者昵称，直查库会放大热点路径压力；
// 命中缓存零查询，未回源一次主键查询后回填；空昵称同样缓存防穿透；资料更新时删除对应条目（handleProfileUpdate）
var nickCache sync.Map // username -> nickname(string)

func nicknameOf(username string) string {
	if v, ok := nickCache.Load(username); ok {
		s, _ := v.(string)
		return s
	}
	var nk string
	store.DB.Model(&model.User{}).Select("nickname").Where("username = ?", username).Scan(&nk)
	nickCache.Store(username, nk)
	return nk
}

// handleGroupChat 群聊广播并持久化
// 容量优化 E8 前置：全局群路径废弃——原 to_user 为空的全局群消息对全体注册用户广播 +
// 全员会话批写 + 全员离线入队，扇出规模=注册用户数（不受群人数上限约束），是 5 万在线
// 容量目标下不可控的写放大源头。现仅保留多群聊（to_user='gN'）分流，全局群信令拒绝并提示；
// 全局群 @AI 唤醒（handleGroupAI）随之废弃，AI 问答请私聊智能体
func (s *Server) handleGroupChat(c *Client, msg *protocol.Message) {
	// 敏感词过滤（多群聊入口校验前置，handleMultiGroupChat 依赖此处已过滤）
	if word, ok := containsSensitive(msg.Content); ok {
		s.sendError(c, "消息包含敏感词，已拦截")
		logger.Warn("敏感词拦截：%s 群聊消息包含 '%s'", c.username, word)
		return
	}

	// 多群聊分流：to_user='gN' 走群成员定向广播（不进全局群 @AI 唤醒分支）
	if groupID, ok := isGroupTarget(msg.ToUser); ok {
		s.handleMultiGroupChat(c, msg, groupID)
		return
	}
	// 'gN' 形式但群已解散/不存在：给准确提示（原实现会落入全局群全员广播，属误投）
	if groupIDFromTarget(msg.ToUser) != 0 {
		s.sendError(c, "群聊不存在或已解散")
		return
	}

	// 全局群路径废弃：不再支持 to_user 为空的全员广播消息
	s.sendError(c, "全局群聊已废弃，请选择一个群聊发送消息")
}

// handlePrivateChat 私聊定向转发并持久化
func (s *Server) handlePrivateChat(c *Client, msg *protocol.Message) {
	// 敏感词过滤
	if word, ok := containsSensitive(msg.Content); ok {
		s.sendError(c, "消息包含敏感词，已拦截")
		logger.Warn("敏感词拦截：%s 私聊消息包含 '%s'", c.username, word)
		return
	}

	// 阶段四十三：私聊目标为任意配置的 AI 智能体时走 AI 问答链路（流式打字机，按用户隔离）
	// 原实现：仅支持固定 AIBotName 单一机器人，且不落库提问、无多轮上下文
	// 原实现：aiAgentByName(msg.ToUser) != nil（阶段五十七起走权限归口，他人个人智能体视同不存在，回落普通私聊被"用户不存在"拦截）
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.handleAIChatMsg(c, msg)
		return
	}

	// 黑名单拦截：任一方向拉黑则禁止私聊
	if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送消息")
		return
	}

	msg.MsgType = protocol.MsgTypePrivate
	msg.FromUser = c.username
	msg.Timestamp = time.Now().Unix()

	// 持久化到 MySQL，回填消息唯一 ID（并发优化 E1：批量落库归口，单事务批写一次 fsync）
	record := model.Message{
		MsgType:  int8(msg.MsgType),
		FromUser: msg.FromUser,
		ToUser:   msg.ToUser,
		Content:  msg.Content,
	}
	record.ID = s.persistMessage(&record)
	msg.MsgID = record.ID

	data, _ := json.Marshal(msg)

	// 推送给接收方全部在线连接（多端同步）
	// 并发改造 A4：离线判定改内存判定（消除原 Redis 判定在连接已断、在线键未过期窗口内
	// 既不投递也不入队的丢消息可能）
	// 集群模式：isOnlineFast 为全局判定——接收方连接在跨实例时仍实时投递（经总线定向信封送达），
	// 原本地 hub.Count 门限在跨实例场景会既不投递也不入队导致丢消息
	if s.isOnlineFast(msg.ToUser) {
		s.sendToUser(msg.ToUser, data)
	} else {
		// 目标用户离线，消息入离线队列
		s.queueOffline(msg.ToUser, msg)
	}
	// 回显给发送方全部在线连接（多端同步自己发送的消息）
	// 原实现：c.send(data) 仅回显当前连接
	s.sendToUser(c.username, data)

	// 更新双方最近会话并推送
	// 阶段四十：引用消息 content 为信封 JSON，会话摘要归口解析出回复正文（原实现：summary := msg.Content 直存 JSON 原串）
	// 并发优化 E7：私聊摘要去抖合并（50ms 窗口批量落库，消除每消息 4 次会话表写）
	summary := messageSummary(msg.Content)
	// 摘要携带消息 ID：删除水位（竞态修复）判定依据——persistMessage 等批写回填期间
	// 删除帧可能先到，靠水位拦截删除前历史摘要写回复活
	s.touchConversationDebounced(c.username, msg.ToUser, summary, record.ID)
	s.touchConversationDebounced(msg.ToUser, c.username, summary, record.ID)
	s.notifyConvUpdate(c.username)
	s.notifyConvUpdate(msg.ToUser)
}

// handleFile 文件传输处理：文件头（ChunkIndex=-1）与分片数据（ChunkIndex>=0）
func (s *Server) handleFile(c *Client, msg *protocol.Message) {
	msg.MsgType = protocol.MsgTypeFile
	msg.FromUser = c.username

	if msg.ChunkIndex == -1 {
		s.handleFileHeader(c, msg)
		return
	}
	s.handleFileChunk(c, msg)
}

// handleFileHeader 处理文件头消息：写入 im_file、初始化 Redis 分片缓存、中转文件头
func (s *Server) handleFileHeader(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		s.sendError(c, "文件传输缺少接收方")
		return
	}
	// 拦截可执行/危险文件
	if isDangerousFile(msg.FileName) {
		s.sendError(c, "禁止传输可执行文件")
		logger.Warn("文件拦截：%s 尝试传输危险文件 %s", c.username, msg.FileName)
		return
	}

	record := model.FileRecord{
		FileName: msg.FileName,
		FileSize: msg.FileSize,
		FilePath: "",
		FromUser: c.username,
		ToUser:   msg.ToUser,
		Status:   0, // 传输中
	}
	if err := store.DB.Create(&record).Error; err != nil {
		s.sendError(c, "文件记录创建失败")
		return
	}

	// 生成文件唯一标识（用记录 ID）
	fileID := strconv.FormatUint(uint64(record.ID), 10)
	msg.FileID = fileID

	// 初始化 Redis 分片缓存
	ctx := context.Background()
	store.RDB.Del(ctx, store.KeyFileChunk+fileID)
	store.RDB.Expire(ctx, store.KeyFileChunk+fileID, 24*time.Hour)

	// 中转文件头给接收方全部在线连接（多端同步）
	// 集群模式：在线判定全局化（接收方连接在跨实例时经总线定向信封送达，原本地 Count 门限会漏发）
	if s.isOnlineFast(msg.ToUser) {
		data, _ := json.Marshal(msg)
		logger.Info("文件头中转: %s -> %s, 帧 %d 字节, chunk=%d", c.username, msg.ToUser, len(data), msg.ChunkIndex)
		s.sendToUser(msg.ToUser, data)
	} else {
		logger.Warn("文件头中转跳过: 接收方 %s 不在线", msg.ToUser)
	}
	// 回显给发送方（携带 fileID）
	data, _ := json.Marshal(msg)
	c.send(data)
	logger.Info("文件传输发起: %s -> %s, 文件 %s (%d 字节), fileID=%s", c.username, msg.ToUser, msg.FileName, msg.FileSize, fileID)
}

// handleFileChunk 处理文件分片：中转 + 记录进度 + 完成判定
func (s *Server) handleFileChunk(c *Client, msg *protocol.Message) {
	if msg.FileID == "" {
		s.sendError(c, "分片缺少文件标识")
		return
	}

	ctx := context.Background()
	key := store.KeyFileChunk + msg.FileID

	// 中转分片给接收方全部在线连接（多端同步）
	// 原实现：s.sendToUser(msg.ToUser, data) 非阻塞投递，接收方队列满时静默丢片，文件永远组装不齐且无提示
	// 阶段三十一：改用阻塞背压推送（5 秒超时），接收方消费不及时节流发送方；失败时向发送方反馈，杜绝静默损坏
	// 集群模式：本实例有连接走阻塞背压；仅跨实例在线时走总线定向信封（尽力而为，无法阻塞确认，
	// 跨实例分片直传依赖会话粘性路由部署，此处保证不静默漏发）
	if local := s.hub.Count(msg.ToUser); local > 0 {
		data, _ := json.Marshal(msg)
		if !s.sendToUserBlock(msg.ToUser, data, 5*time.Second) {
			s.sendError(c, "对方接收队列已满，文件传输中断，请重新发送")
			return
		}
	} else if s.isOnlineFast(msg.ToUser) {
		if data, err := json.Marshal(msg); err == nil {
			s.hub.bus.publish(&busEnvelope{Kind: busKindDirect, Targets: []string{msg.ToUser}, Data: data})
		}
	}

	// 记录已传输分片序号
	store.RDB.SAdd(ctx, key, msg.ChunkIndex)

	// 完成判定：已传输分片数达到总分片数
	// 原实现：每个分片都执行一次 SCard 查询（20MB 文件产生 5120 次冗余 Redis 往返）
	// 阶段三十一：仅最后一片到达时判定一次（发送方读循环串行处理，最后一片到达时其余分片必然已入集合）
	if msg.TotalChunks > 0 && msg.ChunkIndex == msg.TotalChunks-1 {
		count, _ := store.RDB.SCard(ctx, key).Result()
		if int(count) >= msg.TotalChunks {
			// 阶段二十四：条件更新，避免覆盖持久化状态 3（上传接口与分片完成判定存在并发时序）
			store.DB.Model(&model.FileRecord{}).Where("id = ? AND status < ?", msg.FileID, 3).Update("status", 1)
			logger.Info("文件传输完成: fileID=%s", msg.FileID)
			store.RDB.Del(ctx, key)
		}
	}
}

// handleTyping 输入状态提示：私聊时中转给对方
func (s *Server) handleTyping(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		return
	}
	msg.MsgType = protocol.MsgTypeTyping
	msg.FromUser = c.username
	data, _ := json.Marshal(msg)
	// 输入状态推送给对方全部在线连接（多端同步）
	s.sendToUser(msg.ToUser, data)
}

func (s *Server) handleHistory(c *Client, msg *protocol.Message) {
	page := msg.Page
	pageSize := msg.PageSize
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	var records []model.Message
	query := store.DB.Model(&model.Message{})

	// 排除当前用户已删除的消息（删除仅影响自己的视图）
	// 回归修复：原实现每次翻页全量 Pluck 该用户全部已删消息 ID（删除记录多的用户每次翻页
	// 都拉全量 ID 列表 + SQL NOT IN 万级列表），现改 NOT EXISTS 反连接子查询，
	// 命中 idx_del_user_msg (user_id, msg_id) 索引，翻页查询恒定成本
	query = query.Where("NOT EXISTS (SELECT 1 FROM im_msg_delete d WHERE d.user_id = ? AND d.msg_id = im_message.id)", c.username)

	// 阶段一百四十二：多群聊历史归口——to_user='gN' 按群过滤（原写死的 '' 参数化，全局群传空串行为不变）；
	// 原实现：仅支持全局群 to_user = ''
	_, isGroup := isGroupTarget(msg.ToUser)
	if msg.ToUser == "" || isGroup {
		// 群聊历史
		// 阶段二十六：纳入群聊图片消息(4)，需限定 to_user 为空——私聊图片同样为 msg_type=4 但 to_user 非空
		// 原实现：query.Where("msg_type = ?", 1)
		// 阶段一百三十五：纳入群聊文件消息(5)——sendGroupFile 落库 msg_type=5 且 to_user 为空，
		// 原查询只含 (1,4) 导致群聊文件实时广播可见、重新登录后历史查询丢失（用户实测反馈）
		// 阶段一百四十二：to_user 参数化——''=全局群，'gN'=指定群
		// 阶段一百五十四：纳入群红包消息(86)——群红包实时广播可见、重新登录后历史查询丢失
		// 网盘二期：纳入网盘分享卡片(92)——卡片同走持久化链路，实时可见、历史同样可见
		query = query.Where("msg_type IN ? AND to_user = ?", []int{1, 4, 5, 86, 92}, msg.ToUser)
	} else {
		// 私聊历史：双方互发的私聊消息
		// 阶段二十四：纳入图片消息(4)与文件消息(5)，content 为 JSON（url/name/size），前端按类型渲染
		// 阶段一百五十四：纳入红包消息(86)——红包卡片历史渲染（信封 JSON 同走持久化消息链路）
		// 网盘二期：纳入网盘分享卡片(92)——同 86 口径，卡片历史渲染归口 renderHistoryRecord
		query = query.Where("msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			[]int{2, 4, 5, 86, 92}, c.username, msg.ToUser, msg.ToUser, c.username)
		// 阶段七十一：AI 多会话历史归口——智能体会话按消息盖戳 ai_session_id 过滤
		// （0=默认会话存量全量；普通私聊无会话语义不受影响。会话归属由上行声明、服务端校验）。
		// 图片/文件消息不经 AI_CHAT 通道，恒为默认会话盖戳（已知边界，后续可按需扩展上行声明）
		if aiAgentForUser(msg.ToUser, c.username) != nil {
			query = query.Where("ai_session_id = ?", msg.SessionID)
		}
	}

	if err := query.Order("id desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&records).Error; err != nil {
		s.sendError(c, "查询历史记录失败")
		return
	}

	// 阶段八十五：页内发送者昵称映射（服务端归口一次解析，前端合并缓存后按"备注→昵称→账号"渲染）。
	// 群聊标签/引用前缀/撤回提示共用；nicknameOf 自带缓存，页内去重后实际回源查询极少
	names := make(map[string]string)
	for _, r := range records {
		if _, done := names[r.FromUser]; done {
			continue
		}
		names[r.FromUser] = nicknameOf(r.FromUser)
	}

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeHistoryResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Names:     names,
		Page:      page,
		PageSize:  pageSize,
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}

// UserInfo 在线用户信息（用户名 + 头像）
type UserInfo struct {
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

// ===== 并发改造 B1→E9：在线名单增量同步（5万容量改造）=====
// 原实现：登录/头像更新触发全量在线快照广播（pushUserList 1s 去抖仅合并触发次数），快照帧体积
// O(在线人数)（5万在线 ≈ 4MB），广播总下行 O(在线人数²)（≈200GB/次），登录高峰（服务重启集中
// 重连）雪崩——sendCh 满载丢帧连锁。改造：
//  1. 全量快照仅登录者单发（pushUserListSnapshot，6 号帧语义收窄，O(N) 帧只发 1 份）；
//  2. 名单变更（上线/头像变更/下线）进聚合缓冲，1s 窗口合并为一条 USER_LIST_DELTA 增量帧广播，
//     帧体积 O(窗口内变更人数)；窗口内同用户先上线后下线（或反之）flush 时按当前在线状态过滤，闪烁自动收敛；
//  3. 快照头像走 avatarCache（sync.Map），消除登录高峰逐登录全员 IN 查询的 DB 写放大，
//     头像上传时同步更新缓存。
//
// 集群模式：增量帧经 hub.Broadcast 自动"本地+总线"全实例送达；快照名单源 globalOnlineNames（全局 HASH）
var (
	userListMu    sync.Mutex
	userListTimer *time.Timer
	deltaOnline   = make(map[string]UserInfo) // 窗口内上线/头像变更条目（同用户后写覆盖，头像取最新）
	deltaOffline  = make(map[string]bool)     // 窗口内下线用户
)

// avatarCache 在线名单快照头像缓存（username -> avatar；头像上传低频，avatar.go 更新时同步覆盖）
var avatarCache sync.Map

// avatarsByNames 批量取头像：缓存命中直取，miss 分批回源 DB 并回填（含查无用户缓存空串防重复回源）
func avatarsByNames(names []string) map[string]string {
	m := make(map[string]string, len(names))
	var miss []string
	for _, n := range names {
		if v, ok := avatarCache.Load(n); ok {
			s, _ := v.(string)
			m[n] = s
		} else {
			miss = append(miss, n)
		}
	}
	const step = 5000
	for i := 0; i < len(miss); i += step {
		end := i + step
		if end > len(miss) {
			end = len(miss)
		}
		var users []model.User
		if err := store.DB.Model(&model.User{}).Where("username IN ?", miss[i:end]).Select("username", "avatar").Find(&users).Error; err == nil {
			for _, u := range users {
				avatarCache.Store(u.Username, u.Avatar)
				m[u.Username] = u.Avatar
			}
		}
		for _, n := range miss[i:end] { // 查无用户（已注销）缓存空串，避免每次登录重复回源
			if _, ok := m[n]; !ok {
				avatarCache.Store(n, "")
				m[n] = ""
			}
		}
	}
	return m
}

// pushUserListOnline 上线/头像变更增量入队（多端重复登录仅在首设备上线时触发，不重复广播）
func (s *Server) pushUserListOnline(u UserInfo) {
	userListMu.Lock()
	deltaOnline[u.Username] = u
	delete(deltaOffline, u.Username) // 同窗口先下线后上线：抵消
	armUserListFlush(s)
	userListMu.Unlock()
}

// pushUserListOffline 下线增量入队（原实现下线不刷新名单，前端 onlineUsers 残留至下次全量推送——顺带修复）
func (s *Server) pushUserListOffline(username string) {
	userListMu.Lock()
	delete(deltaOnline, username) // 同窗口先上线后下线：抵消
	deltaOffline[username] = true
	armUserListFlush(s)
	userListMu.Unlock()
}

// armUserListFlush 1s 窗口定时器（调用方持 userListMu）：窗口满一次构建增量帧广播
func armUserListFlush(s *Server) {
	if userListTimer != nil {
		return
	}
	userListTimer = time.AfterFunc(time.Second, func() {
		userListMu.Lock()
		userListTimer = nil
		online := make([]UserInfo, 0, len(deltaOnline))
		for _, u := range deltaOnline {
			online = append(online, u)
		}
		offline := make([]string, 0, len(deltaOffline))
		for name := range deltaOffline {
			offline = append(offline, name)
		}
		deltaOnline = make(map[string]UserInfo)
		deltaOffline = make(map[string]bool)
		userListMu.Unlock()
		if len(online) == 0 && len(offline) == 0 {
			return
		}
		// 窗口内状态可能已再次变化：按当前在线判定过滤（上线后已离线→丢弃；下线后又上线→丢弃）
		live := online[:0]
		for _, u := range online {
			if s.isOnlineFast(u.Username) {
				live = append(live, u)
			}
		}
		stillOff := offline[:0]
		for _, name := range offline {
			if !s.isOnlineFast(name) {
				stillOff = append(stillOff, name)
			}
		}
		if len(live) == 0 && len(stillOff) == 0 {
			return
		}
		content, _ := json.Marshal(map[string]interface{}{"online": live, "offline": stillOff})
		msg := protocol.Message{
			MsgType:   protocol.MsgTypeUserListDelta,
			Content:   string(content),
			Timestamp: time.Now().Unix(),
		}
		data, _ := json.Marshal(msg)
		s.hub.Broadcast(data)
	})
}

// pushUserListSnapshot 推送全量在线名单快照给指定登录者（仅单发，不再广播）。
// 名单源：集群模式全局在线名单（HASH im:ulist 心跳时间戳），单实例本 hub 在线用户；
// 头像走 avatarCache 缓存（登录高峰逐登录全员 IN 查询的写放大收口）
func (s *Server) pushUserListSnapshot(c *Client) {
	names := s.globalOnlineNames()
	avatarMap := avatarsByNames(names)
	infos := make([]UserInfo, 0, len(names))
	for _, n := range names {
		infos = append(infos, UserInfo{Username: n, Avatar: avatarMap[n]})
	}
	content, _ := json.Marshal(infos)
	listMsg := protocol.Message{
		MsgType:   protocol.MsgTypeUserList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(listMsg)
	c.send(data)
}

// sendLoginResp 发送登录响应（携带服务端撤回时间窗口，供前端撤回菜单判断与窗口配置保持一致）
// 头像缺失修复：追加 avatar 参数，登录时下发登录用户自己头像（服务端归口），供导航栏与消息气泡渲染
// 原代码：func (s *Server) sendLoginResp(c *Client, result string) {
// 阶段三十：avatar 参数改为整个 user，content JSON 追加 profile 完整个人资料
func (s *Server) sendLoginResp(c *Client, result string, user model.User) {
	respInfo, _ := json.Marshal(map[string]interface{}{
		"result":        result,
		"recall_window": s.cfg.RecallWindow,
		// 阶段三十一：下发文件分片大小与大文件直传阈值（服务端归口，前端分片/分流逻辑与服务端配置保持一致）
		// 原代码：无 chunk_size / upload_threshold 字段（前端硬编码 4KB）
		"chunk_size":       s.cfg.ChunkSize,
		"upload_threshold": s.cfg.HttpUploadThreshold,
		// 阶段三十二：下发单请求直传上限/分片直传单片大小/分片直传上限（前端三层分流与服务端配置保持一致）
		"max_file_size":     s.cfg.MaxFileSize,
		"upload_chunk_size": s.cfg.UploadChunkSize,
		"max_direct_size":   s.cfg.MaxDirectSize,
		// 阶段一百五十七：下发群聊文件大小上限（服务端归口，群文件独立于私聊 max_file_size，
		// 前端发送前校验用，客户端零硬编码）
		"group_file_max_size": s.cfg.GroupFileMaxSize,
		// 阶段一百六十：下发文件保留天数（服务端归口，前端历史渲染按 create_time+保留期灰显过期卡片；
		// 负数=永不清理，前端仅对 >0 做过期标记）
		"file_retention_days": s.cfg.FileRetentionDays,
		// 阶段一百五十六：下发好友文件 P2P 直传决策与传输参数（服务端归口，客户端零硬编码：
		// enabled/threshold 分流判定，negotiate_timeout/chunk_size/high_water/low_water DataChannel
		// 传输面参数，archive 归档开关）
		"file_p2p_enabled":           s.cfg.FileP2P.Enabled,
		"file_p2p_threshold":         s.cfg.FileP2P.Threshold,
		"file_p2p_negotiate_timeout": s.cfg.FileP2P.NegotiateTimeout,
		"file_p2p_chunk_size":        s.cfg.FileP2P.ChunkSize,
		"file_p2p_high_water":        s.cfg.FileP2P.HighWater,
		"file_p2p_low_water":         s.cfg.FileP2P.LowWater,
		"file_p2p_archive":           s.cfg.FileP2P.Archive,
		// 原代码：无 avatar 字段
		"avatar": user.Avatar,
		// 阶段二百四十：下发归口账号名（扫码登录凭码登录时前端未输入账号，以服务端签发为准
		// 校正本地 currentUsername / 凭据存储；密码登录该值与输入一致，零回归）
		"username": user.Username,
		// 阶段一百九十八：下发网盘 API 鉴权 token（前端 localStorage 持久化，网盘请求头 X-Drive-Token 携带）
		"drive_token": c.driveToken,
		// 阶段三十：下发完整个人资料（微信式"我的个人资料"面板数据源）
		"profile": map[string]interface{}{
			"nickname":  user.Nickname,
			"gender":    user.Gender,
			"region":    user.Region,
			"signature": user.Signature,
		},
		// 阶段七十八：下发 AI 积分余额（PC 端标题栏 ⚡ 积分显示数据源，服务端归口）；
		// 阶段一百六十二：下发前归一 3 位——存量余额可能带历史 double 误差长尾
		"points": aiPointsRound3(user.Points),
		// 阶段一百三十八：下发当前计费模式与按次单价（标题栏 ⚡ 悬停提示按模式显示对应扣费口径；
		// 后台热更后重登/重连即取新模式，运行中扣费帧也会实时携带新模式刷新）
		"billing_mode": aiBillingMode(),
		"percall_cost": aiBillingGet().PercallCost,
	})
	msg := protocol.Message{
		MsgType: protocol.MsgTypeLoginResp,
		// 原实现：Content 为固定字符串 "ok"，现改为 JSON 携带配置下发
		Content: string(respInfo),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// sendError 发送错误提示
func (s *Server) sendError(c *Client, errMsg string) {
	msg := protocol.Message{
		MsgType: protocol.MsgTypeError,
		Content: errMsg,
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}
