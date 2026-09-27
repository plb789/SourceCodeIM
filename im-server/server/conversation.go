package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ConvInfo 会话信息（推送给前端）
type ConvInfo struct {
	Target   string `json:"target"`    // 对方用户名，空表示群聊
	LastMsg  string `json:"last_msg"`  // 最后一条消息摘要
	LastTime int64  `json:"last_time"` // 最后消息时间戳
	Unread   int64  `json:"unread"`    // 未读数（仅私聊统计）
	Pinned   bool   `json:"pinned"`    // 是否置顶
}

// ===== 并发优化 E7：私聊会话摘要去抖合并落库 =====
// 写放大背景：私聊每条消息双向 touch 各 SELECT+UPDATE 共 4 次 DB 操作，5000 消息/s 时
// 会话表写操作 2 万次/s，超过消息本体 INSERT（E1 已批量）成为单主写入最大头。
// 机制：热路径摘要先进脏集合（同会话 50ms 窗口内只保留最后一条），单 timer 到期一次
// INSERT ... ON DUPLICATE KEY UPDATE 批量落库（同 A3 已验证的 SQL 路径）。
// 语义影响：窗口内 pushConvList 读库可能读到上一条摘要（滞后 ≤50ms，角标走未读计数不受影响）；
// 进程崩溃丢 ≤50ms 摘要（下次消息自动刷新，与 E1 批写风险同级）。
// 会话删除/清空/摘要清写路径必须先 touchDiscard（防窗口内 flush 把旧摘要写回/删行复活）。

const touchFlushDelay = 50 * time.Millisecond

type touchDirtyEntry struct {
	user, target, lastMsg string
	msgID                 uint // 摘要归属消息 ID（删除水位判定依据；0=无 ID 仅等锁兜底）
}

var (
	touchMu    sync.Mutex
	touchDirty = make(map[string]touchDirtyEntry) // key: user\x00target
	touchTimer *time.Timer
	// touchFlushMu flush 落库段互斥（竞态修复一）：flush 换批后条目脱离 touchMu 保护，
	// touchDiscard 删不到已换出的 batch——flush 落库全程持锁，touchDiscard 删脏集后等锁，
	// discard 后续的删行/清空写必然晚于在途 flush 的写。两把锁从不嵌套持有，无死锁
	touchFlushMu sync.Mutex
	// touchConvWatermark 删除水位（竞态修复二）：实测发现摘要写脏集发生在 persistMessage
	// （阻塞等 E1 批写回填 ~20ms）之后，删会话帧可能先于摘要写入到达——discard 删了个寂寞，
	// 摘要随后入集被 flush 复活（等锁也拦不住，写入发生在 discard 之后）。
	// 删会话/清空时记录该会话当前最大消息 ID，摘要写脏集时 MsgID ≤ 水位者属删除前历史，
	// 直接丢弃；新消息 MsgID > 水位正常写入（并清水位）。key 残留仅在"删除后永不再聊"时
	// 存在（每 key 几十字节、删除低频，量级无害；再次删除覆盖）
	touchConvWatermark = make(map[string]uint)
)

// touchConversationDebounced 热路径会话摘要（私聊双向调用；去抖合并；msgID=该消息 ID）
func (s *Server) touchConversationDebounced(userID, target, lastMsg string, msgID uint) {
	if runes := []rune(lastMsg); len(runes) > 200 {
		lastMsg = string(runes[:200])
	}
	touchMu.Lock()
	// 删除水位拦截：MsgID ≤ 水位说明该消息属已删除/已清空会话的历史，摘要不得写回
	if wm, ok := touchConvWatermark[userID+"\x00"+target]; ok && msgID > 0 {
		if msgID <= wm {
			touchMu.Unlock()
			return
		}
		delete(touchConvWatermark, userID+"\x00"+target) // 新消息越过水位，恢复正常
	}
	touchDirty[userID+"\x00"+target] = touchDirtyEntry{userID, target, lastMsg, msgID}
	if touchTimer == nil {
		touchTimer = time.AfterFunc(touchFlushDelay, func() { s.flushTouchDirty() })
	}
	touchMu.Unlock()
}

// touchDiscard 会话行删除/摘要清写前丢弃待落库摘要（防 flush 复活旧摘要/已删行）。
// 兜底一（等锁）：该条目可能已被换出 batch 正在落库——调用方随后的删行/清空写
// 因此必然晚于 flush 的写。群聊被踢/退群与永久删除路径使用（无水位参数场景）
func touchDiscard(userID, target string) {
	touchMu.Lock()
	delete(touchDirty, userID+"\x00"+target)
	touchMu.Unlock()
	touchFlushMu.Lock()
	touchFlushMu.Unlock()
}

// touchDiscardWatermarked 带删除水位的会话丢弃归口（私聊删会话/清空使用）：
// 水位拦截乱序写入（修复二）+ 删脏集 + 等在途 flush（修复一）双防线全闭合。
// maxMsgID=该会话当前最大消息 ID（调用方聚合查询），之后 MsgID ≤ 它的摘要一律丢弃
func touchDiscardWatermarked(userID, target string, maxMsgID uint) {
	touchMu.Lock()
	touchConvWatermark[userID+"\x00"+target] = maxMsgID
	delete(touchDirty, userID+"\x00"+target)
	touchMu.Unlock()
	touchFlushMu.Lock()
	touchFlushMu.Unlock()
}

// flushTouchDirty 脏摘要批量落库（单 timer 归口；500/批 ON DUPLICATE，失败回退逐条直写）
func (s *Server) flushTouchDirty() {
	touchMu.Lock()
	batch := touchDirty
	touchDirty = make(map[string]touchDirtyEntry)
	touchTimer = nil
	touchMu.Unlock()
	if len(batch) == 0 {
		return
	}
	now := time.Now()
	rows := make([]model.Conversation, 0, len(batch))
	for _, e := range batch {
		rows = append(rows, model.Conversation{UserID: e.user, Target: e.target, LastMsg: e.lastMsg, LastTime: now})
	}
	// 竞态修复：落库段全程持 touchFlushMu，touchDiscard 据此等待在途落库完成
	// （换批已在 touchMu 内完成，此处 batch 固定，持锁时间=批量写耗时，毫秒级）
	touchFlushMu.Lock()
	defer touchFlushMu.Unlock()
	const step = 500
	for i := 0; i < len(rows); i += step {
		end := i + step
		if end > len(rows) {
			end = len(rows)
		}
		part := rows[i:end]
		if err := store.DB.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "target"}},
			DoUpdates: clause.AssignmentColumns([]string{"last_msg", "last_time"}),
		}).Create(&part).Error; err != nil {
			logger.Error("会话摘要批量落库失败：%v", err)
			for _, r := range part { // 回退直写保证摘要不丢
				s.touchConversation(r.UserID, r.Target, r.LastMsg)
			}
		}
	}
}

// touchConversation 刷新会话（存在则更新最后消息，不存在则创建）
func (s *Server) touchConversation(userID, target, lastMsg string) {
	// 阶段六十六修复：摘要截断按字符截取——原实现 lastMsg[:200] 按字节截断，中文多字节字符
	// 被拦腰切断产生无效 UTF-8，MySQL 拒绝写入且错误被吞，导致会话行创建/更新静默失败（任务完结通知无角标）
	if runes := []rune(lastMsg); len(runes) > 200 {
		lastMsg = string(runes[:200])
	}
	now := time.Now()
	var conv model.Conversation
	err := store.DB.Where("user_id = ? AND target = ?", userID, target).First(&conv).Error
	if err != nil {
		if err := store.DB.Create(&model.Conversation{UserID: userID, Target: target, LastMsg: lastMsg, LastTime: now}).Error; err != nil {
			logger.Error("会话行创建失败（用户 %s，目标 %s）：%v", userID, target, err)
		}
	} else {
		conv.LastMsg = lastMsg
		conv.LastTime = now
		if err := store.DB.Save(&conv).Error; err != nil {
			logger.Error("会话行更新失败（用户 %s，目标 %s）：%v", userID, target, err)
		}
	}
}

// touchConversationBatch 并发改造 A3：批量刷新会话（存在则更新最后消息，不存在则创建）
// 全局群每条消息原对每个在线用户逐个 touchConversation（每人 SELECT+UPDATE/INSERT 共 2 次 DB），
// 现按 500 行/批一次 INSERT ... ON DUPLICATE KEY UPDATE（依赖 (user_id,target) 唯一索引 idx_conv_user_target），
// N 人在线 2N 次写 → ⌈N/500⌉ 次写；摘要截断口径与 touchConversation 一致（按字符截取防无效 UTF-8）
func (s *Server) touchConversationBatch(userIDs []string, target, lastMsg string) {
	if len(userIDs) == 0 {
		return
	}
	if runes := []rune(lastMsg); len(runes) > 200 {
		lastMsg = string(runes[:200])
	}
	now := time.Now()
	const batch = 500
	for i := 0; i < len(userIDs); i += batch {
		end := i + batch
		if end > len(userIDs) {
			end = len(userIDs)
		}
		rows := make([]model.Conversation, 0, end-i)
		for _, uid := range userIDs[i:end] {
			rows = append(rows, model.Conversation{UserID: uid, Target: target, LastMsg: lastMsg, LastTime: now})
		}
		if err := store.DB.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "target"}},
			DoUpdates: clause.AssignmentColumns([]string{"last_msg", "last_time"}),
		}).Create(&rows).Error; err != nil {
			logger.Error("会话批量刷新失败（目标 %s）：%v", target, err)
			// 批量失败兜底：回退逐条刷新，保证会话行不丢（与原行为对齐）
			for _, uid := range userIDs[i:end] {
				s.touchConversation(uid, target, lastMsg)
			}
		}
	}
}

// ensureGroupConv 登录时确保群聊会话存在（不刷新时间，避免每次登录都跳到最前）
func (s *Server) ensureGroupConv(userID string) {
	var count int64
	store.DB.Model(&model.Conversation{}).Where("user_id = ? AND target = ''", userID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.Conversation{UserID: userID, Target: "", LastMsg: "群聊", LastTime: time.Now()})
	}
}

// pushConvList 推送会话列表（置顶优先，按最后消息时间倒序）
// 并发改造 A2：未读数原逐会话 COUNT（最多 50 次查询），现一次聚合后内存匹配；
// 瓶颈优化 ①：会话列表 + 未读聚合两次往返合并为单条 SQL（LEFT JOIN 聚合子查询），
// 群消息风暴下每用户每去抖窗口 2 次往返 → 1 次。
// 未读口径与原 unreadCountsByFrom 完全一致：私聊收到的 msg_type 2/4/5/86、未读、
// 未撤回、未被本人删除（im_msg_delete 排除）；群会话 target 匹配不到 from_user，COALESCE 归 0
func (s *Server) pushConvList(c *Client) {
	var convs []ConvInfo
	// last_time 为毫秒精度 DATETIME(3)，UNIX_TIMESTAMP() 对其返回 DECIMAL 带小数秒
	//（驱动给 []uint8("1790444535.754")），Scan 到 int64 会整结果集失败 → 必须 CAST 为 SIGNED
	store.DB.Raw(`
SELECT c.target AS target, c.last_msg AS last_msg,
       CAST(UNIX_TIMESTAMP(c.last_time) AS SIGNED) AS last_time, c.pinned AS pinned,
       COALESCE(u.cnt, 0) AS unread
FROM im_conversation c
LEFT JOIN (
    SELECT from_user, COUNT(*) AS cnt
    FROM im_message
    WHERE msg_type IN (2, 4, 5, 86) AND to_user = ? AND is_read = 0 AND recalled = 0
      AND id NOT IN (SELECT msg_id FROM im_msg_delete WHERE user_id = ?)
    GROUP BY from_user
) u ON u.from_user = c.target
WHERE c.user_id = ?
ORDER BY c.pinned DESC, c.last_time DESC
LIMIT 50`, c.username, c.username, c.username).Scan(&convs)

	for i := range convs {
		// 阶段四十补充：读取侧摘要归口自愈——历史引用消息曾把 JSON 原串直存进群聊摘要，
		// 推送时统一再走一次 messageSummary，坏数据同时回写修正，避免旧摘要一直显示 JSON
		healed := messageSummary(convs[i].LastMsg)
		if healed != convs[i].LastMsg {
			convs[i].LastMsg = healed
			store.DB.Model(&model.Conversation{}).
				Where("user_id = ? AND target = ?", c.username, convs[i].Target).
				Update("last_msg", healed)
		}
	}

	content, _ := json.Marshal(convs)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeConvList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// ===== 并发改造 A1：会话列表推送去抖合并 =====
// convDirtyUsers 脏标记集合 + 单一全局 flush 定时器：同一用户去抖窗口内的多次会话更新
// 合并为一次全量会话列表推送（原实现每条消息对收发双方各推一次，群聊对每个在线用户各推一次，
// 刷屏/群消息风暴场景查询与下行帧被成倍放大）。窗口期 300ms，对用户无感知。
//
// 瓶颈优化 ②：去抖窗口自适应退避——群消息风暴时单轮脏用户数超阈值则窗口逐轮翻倍
// （上限 2s），负载回落按半衰期收敛回基准窗口。千人群每条消息对每个在线成员标脏，
// 3000 人在线持续风暴 ≈ 2 万 QPS 查询（触连接池上限）；退避后风暴期自动降频至
// 1/6 ~ 1/7，会话角标刷新延迟上限 2s（微信同量级），置顶/已读/删除等主动操作仍走直推不受影响。
var (
	convDirtyMu    sync.Mutex
	convDirtyUsers = make(map[string]struct{})
	convFlushTimer *time.Timer
	convFlushCur   = convFlushDelayBase // 当前生效窗口（风暴时动态退避）
)

const (
	convFlushDelayBase = 300 * time.Millisecond // 基准去抖窗口
	convFlushDelayMax  = 2 * time.Second        // 风暴退避上限
	convFlushBacklog   = 200                    // 单轮脏用户数超过该值时窗口翻倍
)

// notifyConvUpdate 标记指定用户的会话列表为脏，去抖窗口到期后统一推送其全部在线连接（多端同步）
// 集群模式：本地标脏 + 总线会话刷新事件（其他实例对本实例内该用户连接执行本地去抖推送，
// 未读角标多端跨实例同步）；发送方本地已标脏，订阅端 From==self 回环跳过防重复
func (s *Server) notifyConvUpdate(username string) {
	s.notifyConvUpdateLocal(username)
	if s.hub.bus != nil {
		s.hub.bus.publishConvUpdate([]string{username})
	}
}

// convBackoffMS 会话推送当前生效退避窗口（毫秒，仪表盘观测）：
// 300=常态，升档=会话推送风暴中（A1 自适应退避工作信号）。读竞态仅影响展示精度
func convBackoffMS() int64 { return int64(convFlushCur / time.Millisecond) }

// notifyConvUpdateLocal 本地去抖标记（总线会话刷新事件的本地归口）
func (s *Server) notifyConvUpdateLocal(username string) {
	convDirtyMu.Lock()
	convDirtyUsers[username] = struct{}{}
	if convFlushTimer == nil {
		delay := convFlushCur
		convFlushTimer = time.AfterFunc(delay, func() {
			convDirtyMu.Lock()
			users := make([]string, 0, len(convDirtyUsers))
			for name := range convDirtyUsers {
				users = append(users, name)
			}
			convDirtyUsers = make(map[string]struct{})
			convFlushTimer = nil
			// 自适应退避：本轮脏用户多 → 窗口翻倍削峰；负载回落 → 半衰收敛回基准
			if len(users) > convFlushBacklog {
				if convFlushCur*2 > convFlushDelayMax {
					convFlushCur = convFlushDelayMax
				} else {
					convFlushCur *= 2
				}
			} else {
				convFlushCur /= 2
				if convFlushCur < convFlushDelayBase {
					convFlushCur = convFlushDelayBase
				}
			}
			convDirtyMu.Unlock()
			for _, name := range users {
				for _, c := range s.hub.GetAll(name) {
					s.pushConvList(c)
				}
			}
		})
	}
	convDirtyMu.Unlock()
}

// notifyConvUpdateBatch 批量会话刷新（群聊消息热路径归口）：本实例内在线成员本地标脏去抖 +
// 总线一条会话刷新信封覆盖全部目标（集群模式避免逐用户 PUBLISH，千人群 N 次 → 1 次；
// 非本实例成员由订阅端对本实例内该用户连接执行本地去抖推送）
func (s *Server) notifyConvUpdateBatch(users []string) {
	if len(users) == 0 {
		return
	}
	for _, name := range users {
		if s.hub.Count(name) > 0 {
			s.notifyConvUpdateLocal(name)
		}
	}
	if s.hub.bus != nil {
		s.hub.bus.publishConvUpdate(users)
	}
}

// notifyConvUpdateDirect 立即推送会话列表（跳过去抖窗口）：置顶/清空/删除等用户主动操作后的即时反馈场景
// 使用，消息热路径一律走 notifyConvUpdate（去抖合并）。
// 集群模式：本地直推 + 会话刷新事件（其他实例走去抖推送，多端跨实例延迟 ≤ 去抖窗口）
func (s *Server) notifyConvUpdateDirect(username string) {
	for _, c := range s.hub.GetAll(username) {
		s.pushConvList(c)
	}
	if s.hub.bus != nil {
		s.hub.bus.publishConvUpdate([]string{username})
	}
}

// handleConvPin 会话置顶/取消置顶
func (s *Server) handleConvPin(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空
	pin := msg.Content == "pin"
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("pinned", pin)
	if pin {
		s.sendError(c, "已置顶该会话")
	} else {
		s.sendError(c, "已取消置顶")
	}
	s.pushConvList(c)
}

// convMessageQuery 构建指定会话的消息范围查询（target 为空表示全局群；'gN' 表示多群聊会话）
func convMessageQuery(userID, target string) *gorm.DB {
	query := store.DB.Model(&model.Message{})
	// 阶段一百四十二：多群聊归口——target='gN' 与全局群同走群消息分支（原写死的 '' 参数化，
	// 全局群传空串行为不变）；原实现：仅 target == '' 分支
	_, isGroup := isGroupTarget(target)
	if target == "" || isGroup {
		// 群聊：全部群消息
		// 阶段二十六：纳入群聊图片消息(4)，需限定 to_user 为空——私聊图片同样为 msg_type=4 但 to_user 非空
		// 原实现：return query.Where("msg_type = ?", 1)
		// 阶段一百五十四：纳入红包消息(86)——清空会话时红包卡片一并从视图清除
		return query.Where("msg_type IN ? AND to_user = ?", []int{1, 4, 86}, target)
	}
	// 私聊：双方互发的消息
	// 阶段一百五十四：纳入红包消息(86)，语义同群聊分支
	return query.Where("msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		[]int{2, 86}, userID, target, target, userID)
}

// convMaxMsgID 会话当前最大消息 ID（删除水位来源；COALESCE 兜底空会话返回 0）
func convMaxMsgID(userID, target string) uint {
	var maxID uint
	convMessageQuery(userID, target).Select("COALESCE(MAX(id),0)").Scan(&maxID)
	return maxID
}

// markConvRead 清空指定私聊会话未读：对方发给我的未读消息标记为已读，并同步提升已读回执水位
// 水位前进时转发回执给对方全部在线连接（多端同步），供发送方实时显示"已读"
// 原实现：仅更新 is_read 不同步水位，会话删除重建后水位从 0 开始，旧消息回执会重复写库+转发
func (s *Server) markConvRead(userID, target string) {
	// 对方发给我的最大消息 ID（含已读），作为水位提升目标
	var maxID uint
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ?", target, userID).
		Select("COALESCE(MAX(id), 0)").Scan(&maxID)

	// 未读清零：对方发给我的未读消息标记为已读
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ? AND is_read = ?", target, userID, false).
		Update("is_read", true)

	// 水位仅在前进时提升，避免回退
	var oldWater uint
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", userID, target).
		Select("COALESCE(last_read_id, 0)").Scan(&oldWater)
	if maxID <= oldWater {
		return
	}
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", userID, target).
		Update("last_read_id", maxID)

	// 转发回执给对方全部在线连接，发送方实时看到"已读"（多端同步）
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeRead,
		FromUser:  userID,
		ToUser:    target,
		Content:   strconv.FormatUint(uint64(maxID), 10),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(target, data)
}

// handleConvClear 会话清空（clear=false 缺省：视图清空——消息写入删除表，本端不再加载，云端记录保留；
// clear=true：永久删除——物理删除云端消息，仅 AI 会话可用（自己的数据自己删），
// 私聊永久删除已升级为双方审批流（MsgTypePurgeApply），协议直发不允许绕过对方同意）。
// 群聊仅支持视图清空（永久删除影响全员，协议层拒绝）；AI 会话永久删除范围为 session_id 指定的当前查看会话
// 同时清空未读与会话摘要，保留会话行与最后时间，避免列表排序跳动
func (s *Server) handleConvClear(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 阶段七十二：永久删除分支——仅 AI 会话直清，私聊引导走审批流
	if msg.Clear {
		if target == "" {
			s.sendError(c, "群聊不支持永久删除")
			return
		}
		agent := aiAgentForUser(target, c.username)
		if agent == nil {
			s.sendError(c, "私聊记录删除需对方同意，请使用删除申请")
			return
		}
		// AI 会话：sid>0 校验归属（防协议直发删他人会话），sid=0 默认会话恒通过；
		// 复用 aiSessionClearMessages（分批删除消息+任务记录，默认会话按用户对限定）
		if msg.SessionID > 0 {
			var row model.AISession
			if err := store.DB.Where("id = ? AND username = ? AND agent_name = ?", msg.SessionID, c.username, agent.Name).
				First(&row).Error; err != nil {
				s.sendError(c, "会话不存在或已被删除")
				return
			}
		}
		aiSessionClearMessages(c.username, agent.Name, msg.SessionID)
		// 尾务清理（置顶防孤儿展示 + 摘要清空保留会话行），与审批同意路径共用归口
		s.purgeConvTails(c.username, target)
		s.sendError(c, "云端聊天记录已永久删除")
		return
	}

	// 查询会话范围内全部消息 ID
	var ids []uint
	convMessageQuery(c.username, target).Pluck("id", &ids)
	if len(ids) > 0 {
		// 排除已存在于删除表的记录，避免重复插入
		var exist []uint
		store.DB.Model(&model.MessageDelete{}).
			Where("user_id = ? AND msg_id IN ?", c.username, ids).
			Pluck("msg_id", &exist)
		existSet := make(map[uint]bool, len(exist))
		for _, id := range exist {
			existSet[id] = true
		}
		var records []model.MessageDelete
		for _, id := range ids {
			if !existSet[id] {
				records = append(records, model.MessageDelete{UserID: c.username, MsgID: id})
			}
		}
		if len(records) > 0 {
			store.DB.CreateInBatches(&records, 500)
		}
	}

	// 清空未读：对方发给我的未读消息标记为已读，并同步提升回执水位转发对方
	// 原实现：仅批量更新 is_read，不同步水位、不转发回执
	if target != "" {
		s.markConvRead(c.username, target)
	}

	// 清空会话摘要（保留会话行，云端记录不受影响）
	// 竞态修复：带删除水位丢弃——摘要写脏集晚于本清空帧到达（persistMessage 等批写回填）
	// 时，靠水位拦截删除前历史摘要写回
	touchDiscardWatermarked(c.username, target, convMaxMsgID(c.username, target))
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("last_msg", "")

	// 阶段十五增强：清空联动置顶——清空者为置顶人时自动取消置顶并同步双方
	// （清空者视图内该会话消息已全部删除，置顶条不应继续展示；对方清空不影响置顶）
	// 原实现：清空不处理置顶记录，置顶者清空后置顶条仍展示已清空的消息
	var pin model.MessagePin
	if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(c.username, target), c.username).
		First(&pin).Error; err == nil {
		store.DB.Delete(&model.MessagePin{}, pin.ID)
		s.syncPinByKey(pin.ConvKey)
	}

	s.sendError(c, "聊天记录已清空")
	s.pushConvList(c)
}

// handleConvDelete 会话删除：从会话列表移除该会话（云端聊天记录保留，收到新消息时会话自动重建）
// 同时将未读清零，避免下次会话重建时旧未读重新出现
func (s *Server) handleConvDelete(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 删除会话记录
	// 竞态修复：带删除水位丢弃——摘要写脏集晚于本删除帧到达（persistMessage 等批写回填）时，
	// 原"删脏集+等 flush"拦不住（写入发生在 discard 之后），靠水位拦截删除前历史摘要复活
	touchDiscardWatermarked(c.username, target, convMaxMsgID(c.username, target))
	store.DB.Where("user_id = ? AND target = ?", c.username, target).Delete(&model.Conversation{})

	// 未读清零：对方发给我的未读消息标记为已读，并同步提升回执水位转发对方
	// 原实现：仅批量更新 is_read，会话删除重建后水位从 0 开始，旧消息回执会重复写库+转发
	if target != "" {
		s.markConvRead(c.username, target)
	}

	// 阶段十五增强：删除会话联动置顶——会话删除者为置顶人时自动取消置顶并同步双方，
	// 防止会话行删除后登录补发孤儿置顶（pushPinList 仍会推送已删除会话的置顶）
	// 原实现：删除会话不处理置顶记录，置顶者删除会话重登后仍被还原已删除会话的置顶条
	var pin model.MessagePin
	if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(c.username, target), c.username).
		First(&pin).Error; err == nil {
		store.DB.Delete(&model.MessagePin{}, pin.ID)
		s.syncPinByKey(pin.ConvKey)
	}

	s.sendError(c, "会话已删除")
	s.pushConvList(c)
}
