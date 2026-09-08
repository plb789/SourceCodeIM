package server

// 阶段七十二：私聊永久删除审批（双方同意才物理删除，会话内审批卡片）
// 语义：发起方点"永久删除"→服务端落申请单并推双方会话卡片→对方同意→物理删除申请时点前的双方互发消息（分批防锁表）；
// 拒绝则仅留痕不动数据。删除范围取申请发起时点：审批可能搁置多日，期间新聊的消息不被连带误删。
// AI 会话不适用（自己的数据自己删，走 CONV_CLEAR clear=true）；群聊不提供永久删除。

import (
	"encoding/json"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// purgePayload 57 帧下行卡片载荷（发起/审批/终态 复用同一结构；发起方由 from_user===自己 判定）
type purgePayload struct {
	ApplyID  uint   `json:"apply_id"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Status   int8   `json:"status"` // 0待处理 1已同意 2已拒绝
}

// handlePurgeApply 上行：发起永久删除申请（仅好友私聊；群聊/AI 不走审批流）
func (s *Server) handlePurgeApply(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser)
	if target == "" || target == c.username {
		s.sendError(c, "参数错误")
		return
	}
	// AI 智能体不适用审批流
	if aiAgentForUser(target, c.username) != nil {
		s.sendError(c, "AI 会话记录可直接清空，无需审批")
		return
	}
	// 仅好友间可用（与私聊可达口径一致）
	if !s.isFriend(c.username, target) {
		s.sendError(c, "仅好友间可发起删除申请")
		return
	}

	// 同一对用户同时仅允许一条待处理申请
	var cnt int64
	store.DB.Model(&model.MsgPurgeApply{}).
		Where("((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) AND status = 0",
			c.username, target, target, c.username).
		Count(&cnt)
	if cnt > 0 {
		s.sendError(c, "已有待处理的删除申请，等待对方处理")
		return
	}

	req := model.MsgPurgeApply{FromUser: c.username, ToUser: target}
	if err := store.DB.Create(&req).Error; err != nil {
		logger.Error("永久删除申请落库失败（%s/%s）: %v", c.username, target, err)
		s.sendError(c, "发送申请失败，请稍后重试")
		return
	}
	// 双方推卡片：发起方见"等待处理"，审批方见同意/拒绝按钮（前端按 from_user 区分视角）
	s.pushPurgeCard(req)
	s.sendError(c, "删除申请已发送，待对方同意后执行")
	logger.Info("永久删除申请发起：%s -> %s（申请 %d）", c.username, target, req.ID)
}

// handlePurgeResp 上行：审批结果（agree=同意并物理删除 / reject=拒绝留痕）
func (s *Server) handlePurgeResp(c *Client, msg *protocol.Message) {
	// 归属校验：仅审批方本人可处理待处理申请
	var req model.MsgPurgeApply
	if err := store.DB.Where("id = ? AND to_user = ? AND status = 0", msg.MsgID, c.username).First(&req).Error; err != nil {
		s.sendError(c, "申请不存在或已被处理")
		return
	}

	agree := msg.Content == "agree"
	if agree {
		// 物理删除申请时点之前的双方互发消息（口径与历史加载一致含图片/文件，分批防长事务锁表）
		cond := "msg_type IN (2,4,5) AND create_time <= ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))"
		args := []interface{}{req.CreateTime, req.FromUser, req.ToUser, req.ToUser, req.FromUser}
		for i := 0; i < 10000; i++ { // 万批保险丝：防异常死循环
			res := store.DB.Exec("DELETE FROM im_message WHERE "+cond+" LIMIT ?", append(args, 5000)...)
			if res.Error != nil {
				logger.Error("永久删除执行失败（申请 %d）: %v", req.ID, res.Error)
				break
			}
			if res.RowsAffected < 5000 {
				break
			}
		}
	}
	req.Status = map[bool]int8{true: 1, false: 2}[agree]
	now := time.Now()
	req.HandleTime = &now
	store.DB.Save(&req)

	// 双方尾务清理 + 终态卡片推送
	if agree {
		s.purgeConvTails(req.FromUser, req.ToUser)
	}
	s.pushPurgeCard(req)
	if agree {
		logger.Info("永久删除申请已同意并执行：%s/%s（申请 %d）", req.FromUser, req.ToUser, req.ID)
	} else {
		logger.Info("永久删除申请被拒绝：%s/%s（申请 %d）", req.FromUser, req.ToUser, req.ID)
	}
}

// pushPurgeCard 向申请双方推送审批卡片（sendToUser 归口多端同步；发起方视角由前端按 from_user 判定）
func (s *Server) pushPurgeCard(req model.MsgPurgeApply) {
	body, _ := json.Marshal(purgePayload{ApplyID: req.ID, FromUser: req.FromUser, ToUser: req.ToUser, Status: req.Status})
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypePurgeApply,
		FromUser:  req.FromUser,
		ToUser:    req.ToUser,
		MsgID:     req.ID,
		Content:   string(body),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(req.FromUser, data)
	s.sendToUser(req.ToUser, data)
}

// pushPendingPurges 登录补推与我相关的未处理审批卡片（离线审批不丢失；已终态的不再补推，历史结论无重放需求）
func (s *Server) pushPendingPurges(c *Client) {
	var reqs []model.MsgPurgeApply
	store.DB.Where("(from_user = ? OR to_user = ?) AND status = 0", c.username, c.username).Find(&reqs)
	for _, req := range reqs {
		s.pushPurgeCard(req)
	}
}

// purgeConvTails 永久删除执行后的双方会话尾务：置顶清理（消息已物理删除防孤儿展示）+ 摘要清空（保留会话行）
func (s *Server) purgeConvTails(a, b string) {
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		u, other := pair[0], pair[1]
		var pin model.MessagePin
		if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(u, other), u).First(&pin).Error; err == nil {
			store.DB.Delete(&model.MessagePin{}, pin.ID)
			s.syncPinByKey(pin.ConvKey)
		}
		store.DB.Model(&model.Conversation{}).Where("user_id = ? AND target = ?", u, other).Update("last_msg", "")
	}
}
