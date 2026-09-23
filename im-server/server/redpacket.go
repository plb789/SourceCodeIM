package server

// ===== 阶段一百五十四：积分红包（微信同款，积分归口服务端计算） =====
// 规则归口（与 AI 积分同一工程原则：金额计算/拆分/扣减/退回全部服务端完成，客户端仅展示）：
//   1. 发送：严格扣款（余额不足直接失败，不钳零）→ 建红包记录 → 以 msg_type=86 走普通消息链路落库转发
//   2. 领取：行锁事务（SELECT FOR UPDATE）原子扣减剩余份数/金额防超领，数据库唯一索引兜底防同一用户重复领取
//   3. 拆分：毫单位整数（积分×1000）运算避免浮点误差；拼手信用微信同款两倍均值法
//   4. 过期：24 小时未领完自动退回剩余积分（后台定时扫描 + 领取时惰性校验双保险），全量流水可审计
//   5. 资格：私聊红包仅收件人可领（发送者点开看详情）；群红包群成员均可领（含发送者）

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 红包业务参数（微信同款口径，积分场景换算）
const (
	redPacketMaxCount    = 100            // 单个红包最大份数（微信同款上限 100）
	redPacketMaxAmount   = 50000.0        // 单个红包最大积分（防误操作；积分量级远大于微信金额，放宽上限）
	redPacketExpireAfter = 24 * time.Hour // 未领完过期时长（过期剩余积分退回发送者）
	redPacketRefundTick  = time.Minute    // 过期退回扫描周期
)

// rpMilli 双精度积分 → 毫单位整数（×1000 四舍五入），红包内部全部按毫单位运算避免浮点累积误差
func rpMilli(amount float64) int64 {
	return int64(math.Round(amount * 1000))
}

// rpFloat 毫单位整数 → 双精度积分（3 位小数）
func rpFloat(milli int64) float64 {
	return float64(milli) / 1000
}

// handleRedPacketSend 发红包上行（msg_type=86，content 为 JSON：{amount,count,type,greeting}，to_user=收件人/gN 群号）。
// 全部校验与扣款归口服务端；成功后红包以 86 信封 JSON 落库并按私聊/群聊链路转发（气泡渲染 + 会话摘要）
func (s *Server) handleRedPacketSend(c *Client, msg *protocol.Message) {
	var p struct {
		Amount   float64 `json:"amount"`
		Count    int     `json:"count"`
		Type     string  `json:"type"`
		Greeting string  `json:"greeting"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "红包参数错误")
		return
	}
	if msg.ToUser == "" {
		s.sendError(c, "红包缺少接收方")
		return
	}
	// 不能给自己发红包（微信同款语义：私聊会话无自身入口，自发自收无资金意义）
	if msg.ToUser == c.username {
		s.sendError(c, "不能给自己发送红包")
		return
	}
	// AI 智能体目标拦截（智能体无积分账户，不能收红包）
	if aiAgentForUser(msg.ToUser, c.username) != nil {
		s.sendError(c, "智能体不支持红包功能")
		return
	}

	// 类型归口：单聊恒为普通红包单份；群聊支持普通（等额）与拼手气
	p.Type = strings.TrimSpace(p.Type)
	if p.Type != model.RedPacketTypeLucky {
		p.Type = model.RedPacketTypeNormal
	}
	if p.Count < 1 {
		p.Count = 1
	}
	if p.Count > redPacketMaxCount {
		p.Count = redPacketMaxCount
	}

	// 金额校验：四舍五入到 3 位小数（与积分体系精度一致）；每份至少 0.001 积分
	amount := math.Round(p.Amount*1000) / 1000
	if amount <= 0 {
		s.sendError(c, "红包金额必须大于 0")
		return
	}
	if amount > redPacketMaxAmount {
		s.sendError(c, fmt.Sprintf("单个红包最多 %.3f 积分", redPacketMaxAmount))
		return
	}
	if rpMilli(amount) < int64(p.Count) {
		s.sendError(c, "红包金额太小，每份至少 0.001 积分")
		return
	}

	// 祝福语：默认微信同款"恭喜发财，大吉大利"；走敏感词过滤（红包卡片展示文本）
	greeting := strings.TrimSpace(p.Greeting)
	if greeting == "" {
		greeting = "恭喜发财，大吉大利"
	}
	if len([]rune(greeting)) > 32 {
		greeting = string([]rune(greeting)[:32])
	}
	if word, ok := containsSensitive(greeting); ok {
		s.sendError(c, "祝福语包含敏感词，请修改后发送")
		logger.Warn("敏感词拦截：%s 红包祝福语包含 '%s'", c.username, word)
		return
	}

	// 群红包成员校验（私聊走黑名单校验）
	var groupID uint
	if gid, ok := isGroupTarget(msg.ToUser); ok {
		if !isGroupMember(gid, c.username) {
			s.sendError(c, "你不是该群成员，无法发红包")
			return
		}
		groupID = gid
	} else if s.isBlocked(c.username, msg.ToUser) {
		s.sendError(c, "对方已将你拉黑或你已拉黑对方，无法发送红包")
		return
	} else if _, err := userPoints(msg.ToUser); err != nil {
		// 私聊收件人须为真实注册用户（用户不存在时积分查询报错）
		s.sendError(c, "对方不存在，无法发送红包")
		return
	}

	// 私聊红包归一：单聊恒为普通红包 1 份（微信同款，拼手气/多份为群聊专属语义）
	// 遗漏修复：异常客户端发私聊 count=N 红包时收件人仅能领 1 份，其余份数滞留 24 小时过期退回
	if groupID == 0 {
		p.Count = 1
		p.Type = model.RedPacketTypeNormal
	}

	// 严格扣款（余额不足直接失败）：原子 UPDATE 带 points>=? 守卫，并发安全
	balance, err := userPointsDeductStrict(c.username, amount)
	if err != nil {
		s.sendError(c, err.Error())
		return
	}
	recordPointsLog(c.username, -amount, balance, "redpacket_send", "system",
		fmt.Sprintf("发送红包（%s，%d 份，给 %s）", rpTypeName(p.Type), p.Count, msg.ToUser))

	// 建红包记录（过期时间 = 现在 + 24h）
	pkt := &model.RedPacket{
		FromUser:        c.username,
		ToUser:          msg.ToUser,
		GroupID:         groupID,
		Type:            p.Type,
		Greeting:        greeting,
		TotalAmount:     amount,
		Count:           p.Count,
		RemainingAmount: amount,
		RemainingCount:  p.Count,
		Status:          model.RedPacketStatusActive,
		ExpireTime:      time.Now().Add(redPacketExpireAfter),
	}
	if err := store.DB.Create(pkt).Error; err != nil {
		// 建包失败须回滚扣款（补偿性入账 + 流水，保证账实一致）
		logger.Error("红包记录创建失败（用户 %s，%.3f 积分）：%v", c.username, amount, err)
		if bal2, e2 := userPointsAdd(c.username, amount); e2 == nil {
			recordPointsLog(c.username, amount, bal2, "redpacket_refund", "system", "红包创建失败自动退回")
		}
		s.sendError(c, "红包发送失败，积分已退回")
		return
	}

	// 聊天消息信封（红包卡片数据源；status 快照恒为初始领取中，卡片实时态以 88 同步帧 + 89 详情查询归口）
	envelope, _ := json.Marshal(map[string]interface{}{
		"rp": map[string]interface{}{
			"id":       pkt.ID,
			"type":     pkt.Type,
			"count":    pkt.Count,
			"amount":   pkt.TotalAmount,
			"greeting": pkt.Greeting,
			"status":   model.RedPacketStatusActive,
		},
	})

	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeRedPacket,
		FromUser:  c.username,
		FromName:  nicknameOf(c.username),
		ToUser:    msg.ToUser,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}

	// 落库 + 回填消息 ID（红包卡片原位定位用）
	record := model.Message{
		MsgType:  int8(protocol.MsgTypeRedPacket),
		FromUser: chatMsg.FromUser,
		ToUser:   chatMsg.ToUser,
		Content:  chatMsg.Content,
	}
	if err := store.DB.Create(&record).Error; err != nil {
		logger.Error("红包消息落库失败（红包 %d）：%v", pkt.ID, err)
		s.sendError(c, "红包发送失败，积分已退回")
		if bal2, e2 := userPointsAdd(c.username, amount); e2 == nil {
			recordPointsLog(c.username, amount, bal2, "redpacket_refund", "system", "红包消息落库失败自动退回")
		}
		store.DB.Delete(pkt)
		return
	}
	chatMsg.MsgID = record.ID
	store.DB.Model(&model.RedPacket{}).Where("id = ?", pkt.ID).Update("msg_id", record.ID)

	data, _ := json.Marshal(chatMsg)
	summary := "[红包] " + pkt.Greeting

	if groupID > 0 {
		// 群红包：按成员定向广播 + 离线入队 + 会话摘要（对齐 handleMultiGroupChat 链路）
		memberIDs := getGroupMemberIDs(groupID)
		s.sendToGroupMembers(memberIDs, data)
		for _, name := range memberIDs {
			if name != c.username && !s.isOnline(name) {
				s.queueOffline(name, &chatMsg)
			}
			if s.isOnline(name) {
				s.touchConversation(name, msg.ToUser, summary)
				s.notifyConvUpdate(name)
			}
		}
	} else {
		// 私聊红包：双方定向推送（多端同步）+ 离线入队 + 会话摘要（对齐 handlePrivateChat 链路）
		if s.hub.Count(msg.ToUser) > 0 {
			s.sendToUser(msg.ToUser, data)
		} else if !s.isOnline(msg.ToUser) {
			s.queueOffline(msg.ToUser, &chatMsg)
		}
		s.sendToUser(c.username, data)
		s.touchConversation(c.username, msg.ToUser, summary)
		s.touchConversation(msg.ToUser, c.username, summary)
		s.notifyConvUpdate(c.username)
		s.notifyConvUpdate(msg.ToUser)
	}

	// 发送回执（仅发送者）：携带扣款后余额供前端实时刷新（标题栏 ⚡ 与发红包面板联动）
	s.sendRedPacketReceipt(c.username, map[string]interface{}{
		"act":       "send",
		"ok":        true,
		"packet_id": pkt.ID,
		"balance":   balance,
		"msg_id":    record.ID,
	})
	logger.Info("红包发送：%s → %s（%s，%.3f 积分 × %d 份，红包 %d）",
		c.username, msg.ToUser, rpTypeName(p.Type), amount, p.Count, pkt.ID)
}

// handleRedPacketOpen 打开红包上行（msg_type=87，content 为 JSON：{packet_id}）。
// 行锁事务原子领取：资格校验 → 拆分金额（普通等额/拼手气两倍均值）→ 扣减剩余 → 领取明细落库 →
// 入账 + 流水 → 87 领取结果回执（含详情）→ 88 状态同步帧刷新会话内所有红包卡片
func (s *Server) handleRedPacketOpen(c *Client, msg *protocol.Message) {
	var p struct {
		PacketID uint `json:"packet_id"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.PacketID == 0 {
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "err": "红包参数错误"})
		return
	}

	tx := store.DB.Begin()
	var pkt model.RedPacket
	// 行锁（SELECT ... FOR UPDATE）串行化同一红包的并发领取，防超领
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&pkt, p.PacketID).Error; err != nil {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "红包不存在"})
		return
	}

	// 领取资格归口：私聊仅收件人可领（发送者点开看详情）；群红包群成员可领（含发送者）
	if pkt.GroupID == 0 {
		if c.username != pkt.ToUser {
			tx.Rollback()
			s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "只能领取对方发给你的红包"})
			return
		}
	} else if !isGroupMember(pkt.GroupID, c.username) {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "你不在该群内，无法领取"})
		return
	}

	// 状态校验：已领完 / 已过期（领取时惰性校验，与后台扫描双保险）
	if pkt.Status == model.RedPacketStatusFinished {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "红包已被领完"})
		return
	}
	if pkt.Status == model.RedPacketStatusExpired || (!pkt.ExpireTime.IsZero() && time.Now().After(pkt.ExpireTime)) {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "红包已过期，剩余积分已退回"})
		return
	}

	// 重复领取拦截（数据库唯一索引兜底并发穿透）
	var dupCount int64
	tx.Model(&model.RedPacketClaim{}).Where("packet_id = ? AND username = ?", pkt.ID, c.username).Count(&dupCount)
	if dupCount > 0 {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "你已领取过该红包"})
		return
	}

	// 拆分金额（毫单位）：普通红包等额（最后一份兜余数）；拼手气微信同款两倍均值法（每份至少 1 毫）
	remainMilli := rpMilli(pkt.RemainingAmount)
	var claimMilli int64
	if pkt.Type == model.RedPacketTypeLucky {
		if pkt.RemainingCount <= 1 {
			claimMilli = remainMilli // 最后一份拿走全部剩余
		} else {
			upper := 2 * remainMilli / int64(pkt.RemainingCount) // 两倍均值上界
			if upper < 1 {
				upper = 1
			}
			claimMilli = rand.Int63n(upper) + 1                   // [1, upper] 闭区间
			maxLeave := remainMilli - int64(pkt.RemainingCount-1) // 给其余人各留至少 1 毫
			if claimMilli > maxLeave {
				claimMilli = maxLeave
			}
		}
	} else {
		claimMilli = remainMilli / int64(pkt.RemainingCount) // 等额：整除部分先领，余数自然归到最后一份
	}
	if claimMilli < 1 {
		claimMilli = 1
	}
	claimAmount := rpFloat(claimMilli)

	// 原子扣减剩余（行锁内条件更新，剩余不足立即回滚）
	res := tx.Model(&model.RedPacket{}).Where("id = ? AND remaining_count > 0", pkt.ID).
		Updates(map[string]interface{}{
			"remaining_count":  pkt.RemainingCount - 1,
			"remaining_amount": pkt.RemainingAmount - claimAmount,
			"status": func() int8 {
				if pkt.RemainingCount <= 1 {
					return model.RedPacketStatusFinished
				}
				return model.RedPacketStatusActive
			}(),
		})
	if res.Error != nil || res.RowsAffected == 0 {
		tx.Rollback()
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "红包已被领完"})
		return
	}

	// 领取明细落库（唯一索引兜底防重复）
	claim := &model.RedPacketClaim{PacketID: pkt.ID, Username: c.username, Amount: claimAmount}
	if err := tx.Create(claim).Error; err != nil {
		tx.Rollback()
		logger.Error("红包领取明细落库失败（红包 %d，用户 %s）：%v", pkt.ID, c.username, err)
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "领取失败，请重试"})
		return
	}
	if err := tx.Commit().Error; err != nil {
		logger.Error("红包领取事务提交失败（红包 %d，用户 %s）：%v", pkt.ID, c.username, err)
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"ok": false, "packet_id": p.PacketID, "err": "领取失败，请重试"})
		return
	}

	// 入账 + 流水（事务外补偿语义：明细已落库，入账失败仅记错误日志便于人工补偿）
	newBalance, err := userPointsAdd(c.username, claimAmount)
	if err != nil {
		logger.Error("红包积分入账失败（红包 %d，用户 %s，%.3f）：%v", pkt.ID, c.username, claimAmount, err)
	}
	recordPointsLog(c.username, claimAmount, newBalance, "redpacket_recv", pkt.FromUser,
		fmt.Sprintf("领取红包 #%d（%s）", pkt.ID, pkt.Greeting))

	// 重新读取红包终态（领完/部分领）用于回执与状态同步
	var latest model.RedPacket
	store.DB.First(&latest, pkt.ID)

	// 87 领取结果回执（含详情，打开即显免二次查询）
	detail := redpacketDetailPayload(&latest)
	detail["act"] = "open"
	detail["ok"] = true
	detail["amount"] = claimAmount
	detail["balance"] = newBalance
	s.sendRedPacketOpenResult(c.username, detail)

	// 88 状态同步帧：刷新会话内所有成员的红包卡片（领取数/领完/剩余）
	s.broadcastRedPacketSync(&latest)

	logger.Info("红包领取：%s 领取红包 %d（%.3f 积分，剩余 %d/%d）",
		c.username, pkt.ID, claimAmount, latest.RemainingCount, latest.Count)
}

// handleRedPacketDetail 红包详情查询上行（msg_type=89，content 为 JSON：{packet_id}）。
// 私聊限收发双方；群聊限当前群成员。响应含领取明细列表（打开红包页/详情页共用数据源）
func (s *Server) handleRedPacketDetail(c *Client, msg *protocol.Message) {
	var p struct {
		PacketID uint `json:"packet_id"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.PacketID == 0 {
		return
	}
	var pkt model.RedPacket
	if err := store.DB.First(&pkt, p.PacketID).Error; err != nil {
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"act": "detail", "ok": false, "packet_id": p.PacketID, "err": "红包不存在"})
		return
	}
	// 查看权限：私聊限收发双方；群聊限当前群成员
	if pkt.GroupID == 0 {
		if c.username != pkt.FromUser && c.username != pkt.ToUser {
			return
		}
	} else if !isGroupMember(pkt.GroupID, c.username) {
		s.sendRedPacketOpenResult(c.username, map[string]interface{}{"act": "detail", "ok": false, "packet_id": p.PacketID, "err": "你不在该群内，无法查看"})
		return
	}
	detail := redpacketDetailPayload(&pkt)
	detail["act"] = "detail"
	detail["ok"] = true
	s.sendRedPacketOpenResult(c.username, detail)
}

// redpacketDetailPayload 红包详情负载归口（87 回执与 89 查询共用）
func redpacketDetailPayload(pkt *model.RedPacket) map[string]interface{} {
	var claims []model.RedPacketClaim
	store.DB.Where("packet_id = ?", pkt.ID).Order("claim_time asc").Find(&claims)
	list := make([]map[string]interface{}, 0, len(claims))
	var claimedSum float64
	for _, cl := range claims {
		claimedSum += cl.Amount
		list = append(list, map[string]interface{}{
			"username":   cl.Username,
			"name":       displayNameOf(cl.Username),
			"amount":     cl.Amount,
			"claim_time": cl.ClaimTime.Format("2006-01-02 15:04:05"),
		})
	}
	return map[string]interface{}{
		"packet_id":        pkt.ID,
		"type":             pkt.Type,
		"count":            pkt.Count,
		"total_amount":     pkt.TotalAmount,
		"greeting":         pkt.Greeting,
		"from_user":        pkt.FromUser,
		"from_name":        displayNameOf(pkt.FromUser),
		"to_user":          pkt.ToUser,
		"group_id":         pkt.GroupID,
		"status":           pkt.Status,
		"claimed_count":    pkt.Count - pkt.RemainingCount,
		"claimed_amount":   claimedSum,
		"remaining_amount": pkt.RemainingAmount,
		"expire_time":      pkt.ExpireTime.Format("2006-01-02 15:04:05"),
		"msg_id":           pkt.MsgID,
		"list":             list,
	}
}

// broadcastRedPacketSync 红包状态同步（msg_type=88）：领取/领完/过期退回后向会话成员在线连接广播，
// 前端按 msg_id 原位刷新红包卡片状态（微信同款"已被领取/已领完/已过期"）
func (s *Server) broadcastRedPacketSync(pkt *model.RedPacket) {
	payload, _ := json.Marshal(map[string]interface{}{
		"packet_id":        pkt.ID,
		"status":           pkt.Status,
		"count":            pkt.Count,
		"claimed_count":    pkt.Count - pkt.RemainingCount,
		"claimed_amount":   pkt.TotalAmount - pkt.RemainingAmount,
		"remaining_amount": pkt.RemainingAmount,
		"msg_id":           pkt.MsgID,
		"to_user":          pkt.ToUser,
		"group_id":         pkt.GroupID,
		"from_user":        pkt.FromUser,
	})
	notice := protocol.Message{
		MsgType:   protocol.MsgTypeRedPacketSync,
		FromUser:  pkt.FromUser,
		ToUser:    pkt.ToUser,
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	if pkt.GroupID > 0 {
		s.sendToGroupMembers(getGroupMemberIDs(pkt.GroupID), data)
		return
	}
	s.sendToUser(pkt.FromUser, data)
	s.sendToUser(pkt.ToUser, data)
}

// sendRedPacketOpenResult 87 帧下行归口（领取结果/发送回执/详情响应共用，to_user 指定接收者）
func (s *Server) sendRedPacketOpenResult(username string, payload map[string]interface{}) {
	body, _ := json.Marshal(payload)
	m := protocol.Message{
		MsgType:   protocol.MsgTypeRedPacketOpen,
		ToUser:    username,
		Content:   string(body),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(m)
	s.sendToUser(username, data)
}

// sendRedPacketReceipt 87 帧别名语义化封装（发送回执专用，与领取结果同帧型不同 act）
func (s *Server) sendRedPacketReceipt(username string, payload map[string]interface{}) {
	s.sendRedPacketOpenResult(username, payload)
}

// userPointsDeductStrict 严格扣款：余额不足直接失败（区别于 AI 扣分的钳零语义——红包必须真扣到钱）
// 原子 UPDATE 带 points>=? 守卫，并发安全；影响行数 0 时区分"余额不足"与"用户不存在"
func userPointsDeductStrict(username string, cost float64) (float64, error) {
	res := store.DB.Model(&model.User{}).
		Where("username = ? AND points >= ?", username, cost).
		Update("points", gorm.Expr("ROUND(points - ?, 3)", cost)) // 阶段一百六十二：落库归一 3 位（double 减法误差长尾）
	if res.Error != nil {
		return 0, res.Error
	}
	if res.RowsAffected == 0 {
		var count int64
		store.DB.Model(&model.User{}).Where("username = ?", username).Count(&count)
		if count == 0 {
			return 0, fmt.Errorf("用户不存在: %s", username)
		}
		return 0, fmt.Errorf("积分余额不足")
	}
	return userPoints(username)
}

// userPointsAdd 积分入账（红包领取/退回），返回入账后余额
func userPointsAdd(username string, amount float64) (float64, error) {
	res := store.DB.Model(&model.User{}).
		Where("username = ?", username).
		Update("points", gorm.Expr("ROUND(points + ?, 3)", amount)) // 阶段一百六十二：落库归一 3 位（double 加法误差长尾）
	if res.Error != nil {
		return 0, res.Error
	}
	if res.RowsAffected == 0 {
		return 0, fmt.Errorf("用户不存在: %s", username)
	}
	return userPoints(username)
}

// rpTypeName 红包类型中文名（日志/流水用）
func rpTypeName(t string) string {
	if t == model.RedPacketTypeLucky {
		return "拼手气红包"
	}
	return "普通红包"
}

// displayNameOf 展示名归口：昵称优先，空则回退账号（对齐前端"备注→昵称→账号"中的昵称/账号两层）
func displayNameOf(username string) string {
	if nk := nicknameOf(username); nk != "" {
		return nk
	}
	return username
}

// StartRedPacketRefundLoop 启动 24 小时过期退回后台扫描（main.go 启动时调用，单协程轮询）
func StartRedPacketRefundLoop() {
	go func() {
		ticker := time.NewTicker(redPacketRefundTick)
		defer ticker.Stop()
		for range ticker.C {
			redpacketRefundExpired()
		}
	}()
	logger.Info("红包过期退回扫描已启动（周期 %s）", redPacketRefundTick)
}

// redpacketRefundExpired 扫描过期红包并退回剩余积分：
// 行锁事务内复核状态（防与领取并发双退）→ 退回 remaining_amount → 置已过期 → 状态同步帧通知会话成员
func redpacketRefundExpired() {
	var expired []model.RedPacket
	if err := store.DB.Where("status = ? AND expire_time < ?", model.RedPacketStatusActive, time.Now()).
		Limit(50).Find(&expired).Error; err != nil {
		logger.Error("红包过期扫描查询失败：%v", err)
		return
	}
	srv := defaultServer()
	if srv == nil {
		return
	}
	for i := range expired {
		pkt := &expired[i]
		tx := store.DB.Begin()
		var locked model.RedPacket
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, pkt.ID).Error; err != nil {
			tx.Rollback()
			continue
		}
		// 复核：仅"领取中且已过期"退回（领取路径可能刚把它领完）
		if locked.Status != model.RedPacketStatusActive || (!locked.ExpireTime.IsZero() && time.Now().Before(locked.ExpireTime)) {
			tx.Rollback()
			continue
		}
		refund := locked.RemainingAmount
		res := tx.Model(&model.RedPacket{}).Where("id = ?", locked.ID).
			Updates(map[string]interface{}{"status": model.RedPacketStatusExpired})
		if res.Error != nil || res.RowsAffected == 0 {
			tx.Rollback()
			continue
		}
		tx.Commit()

		if refund > 0.0001 {
			if balance, err := userPointsAdd(locked.FromUser, refund); err == nil {
				recordPointsLog(locked.FromUser, refund, balance, "redpacket_refund", "system",
					fmt.Sprintf("红包 #%d 过期退回（剩余 %d 份未领）", locked.ID, locked.RemainingCount))
			} else {
				logger.Error("红包过期退回入账失败（红包 %d，用户 %s，%.3f）：%v", locked.ID, locked.FromUser, refund, err)
			}
		}
		locked.Status = model.RedPacketStatusExpired
		srv.broadcastRedPacketSync(&locked)
		logger.Info("红包过期退回：红包 %d（%s）退回 %.3f 积分给 %s", locked.ID, locked.Greeting, refund, locked.FromUser)
	}
}
