package server

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// recallWindow 撤回时间窗口：2 分钟内可撤回
// 原实现：const recallWindow = 2 * time.Minute 硬编码，现改为配置文件 recall_window 参数
// const recallWindow = 2 * time.Minute

// handleRead 已读回执：更新已读状态并转发给对方
// content 为已读到的最大消息 ID，服务端统一归口更新该范围内的消息状态
// 阶段十一增强：基于会话行 last_read_id 水位去重，仅水位前进才写库+转发+推送，
// 防止多端同时打开同一会话重复发送回执造成回执风暴（重复写库、重复转发、重复推送会话列表）
func (s *Server) handleRead(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" || msg.ToUser == c.username {
		return
	}
	lastID, err := strconv.ParseUint(strings.TrimSpace(msg.Content), 10, 64)
	if err != nil || lastID == 0 {
		return
	}

	// 读取者会话行：承载已读回执水位（对方发消息时会创建会话行，此处兜底创建保证水位有落点）
	var conv model.Conversation
	if err := store.DB.Where("user_id = ? AND target = ?", c.username, msg.ToUser).First(&conv).Error; err != nil {
		conv = model.Conversation{UserID: c.username, Target: msg.ToUser}
		store.DB.Create(&conv)
	}
	// 原实现：无水位判断，多端重复回执每次都写库+转发+推送
	if uint(lastID) <= conv.LastReadID {
		// 水位未前进：重复回执，去重跳过（不写库、不转发、不推送会话列表）
		return
	}
	// 水位前进：先落水位，再更新消息状态
	store.DB.Model(&model.Conversation{}).Where("id = ?", conv.ID).Update("last_read_id", lastID)

	// 更新对方发给我的、ID 不超过 lastID 的消息为已读
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ? AND id <= ?", msg.ToUser, c.username, lastID).
		Update("is_read", true)

	// 回执转发给对方全部在线连接，供其界面显示"已读"（多端同步）
	// 原实现：s.hub.Get(msg.ToUser) 仅转发单一连接
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeRead,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   msg.Content,
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(msg.ToUser, data)

	// 未读数变化，刷新读取者全部在线连接的会话列表（多端同步未读清零）
	// 原实现：s.pushConvList(c) 仅刷新当前连接
	for _, conn := range s.hub.GetAll(c.username) {
		s.pushConvList(conn)
	}
}

// handleRecall 消息撤回：仅限 2 分钟内自己发送的消息
func (s *Server) handleRecall(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		s.sendError(c, "撤回消息无效")
		return
	}
	var record model.Message
	if err := store.DB.First(&record, msg.MsgID).Error; err != nil {
		s.sendError(c, "消息不存在")
		return
	}
	if record.FromUser != c.username {
		s.sendError(c, "只能撤回自己发送的消息")
		return
	}
	// 撤回时间窗口从配置文件读取（recall_window，单位秒）
	if time.Since(record.CreateTime) > time.Duration(s.cfg.RecallWindow)*time.Second {
		s.sendError(c, "超过撤回时间限制的消息无法撤回")
		return
	}
	// 阶段十二增强：撤回幂等校验，已撤回消息拒绝重复撤回，
	// 防止重复撤回通知（多端重复系统提示）、重复摘要刷新与重复置顶清理
	// 原实现：无已撤回校验，同一消息可被重复撤回并重复通知双方
	if record.Recalled {
		s.sendError(c, "该消息已撤回，请勿重复操作")
		return
	}

	// 标记为已撤回（保留记录，历史中显示"撤回了一条消息"）
	store.DB.Model(&model.Message{}).Where("id = ?", record.ID).Update("recalled", true)

	// 撤回后会话摘要联动：若撤回的是会话最后一条可见消息，摘要更新为撤回提示（服务端归口，多端随 CONV_LIST 同步）
	s.refreshConvSummaryAfterRecall(record)

	// 被撤回消息若已被置顶，自动取消置顶并同步双方
	var pins []model.MessagePin
	store.DB.Where("msg_id = ?", record.ID).Find(&pins)
	for _, p := range pins {
		store.DB.Delete(&model.MessagePin{}, p.ID)
		s.syncPinByKey(p.ConvKey)
	}

	// 通知双方（群聊则广播）
	// 阶段十二增强：通知携带原始消息接收方 ToUser（群聊为空），
	// 供前端校验撤回消息归属会话，杜绝跨会话串窗（撤回提示渲染进无关会话窗口）
	// 原实现：通知仅携带 FromUser/MsgID，前端无法判断归属，元素未找到时误渲染到当前打开的会话
	notice := protocol.Message{
		MsgType:   protocol.MsgTypeRecall,
		FromUser:  c.username,
		ToUser:    record.ToUser,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	if record.ToUser == "" {
		s.hub.Broadcast(data)
	} else {
		// 私聊撤回：通知双方全部在线连接（多端同步）
		s.sendToUser(record.ToUser, data)
		s.sendToUser(c.username, data)
	}
}

// refreshConvSummaryAfterRecall 撤回后会话摘要联动：
// 若被撤回消息是该会话最后一条可见消息，则相关会话行摘要更新为撤回提示，并推送会话列表多端同步
// 原实现：撤回不影响会话摘要，撤回最后一条消息后会话列表仍显示原消息内容
func (s *Server) refreshConvSummaryAfterRecall(record model.Message) {
	// 查询该会话最新的未撤回消息，判断撤回的是否为最后一条可见消息
	query := store.DB.Model(&model.Message{}).Where("recalled = ?", false)
	var users []string // 需要更新摘要的会话归属者
	if record.ToUser == "" {
		// 群聊会话：全部群消息，摘要更新所有已存在群会话行的用户
		query = query.Where("msg_type = ?", 1)
		store.DB.Model(&model.Conversation{}).Where("target = ''").Pluck("user_id", &users)
	} else {
		// 私聊会话：双方互发消息，摘要更新双方
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, record.FromUser, record.ToUser, record.ToUser, record.FromUser)
		users = []string{record.FromUser, record.ToUser}
	}
	var latest model.Message
	err := query.Order("id desc").First(&latest).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		// 查询异常，保守跳过
		return
	}
	// 原实现：err != nil 一律 return，会话内全部消息均已撤回时查询无结果（ErrRecordNotFound），
	// 被误判为"存在更新的可见消息"导致摘要不更新；实际此时被撤回的就是最后的可见消息，应更新摘要
	// 摘要重算：撤回最后一条可见消息时显示撤回提示；撤回中间消息时重算为最新可见消息内容，
	// 避免摘要残留已撤回内容（服务端统一归口，与会话列表展示保持一致）
	summary := "[消息已撤回]"
	if err == nil && latest.ID != record.ID {
		// 会话存在更新的可见消息：摘要重算为最新可见消息内容
		summary = latest.Content
		if len(summary) > 200 {
			summary = summary[:200]
		}
	}
	// 更新相关会话行摘要（保留 LastTime 不变，避免列表排序跳动）
	for _, u := range users {
		// 原实现：双方统一按 record.ToUser 匹配会话行，接收方的会话 target 为发送者导致匹配失败，摘要不更新
		target := record.ToUser // 发送方视角：会话对端为接收者
		if u == record.ToUser {
			// 接收方视角：会话对端为发送者
			target = record.FromUser
		}
		store.DB.Model(&model.Conversation{}).
			Where("user_id = ? AND target = ?", u, target).
			Update("last_msg", summary)
		s.notifyConvUpdate(u)
	}
}

// handleDelete 消息删除：仅记录删除者视角，不影响对方
func (s *Server) handleDelete(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		return
	}
	var count int64
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ? AND msg_id = ?", c.username, msg.MsgID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.MessageDelete{UserID: c.username, MsgID: msg.MsgID})
	}
	s.sendError(c, "消息已删除")
}

// handleSearch 消息关键词搜索：ToUser 为空时搜索全部会话，否则搜索指定会话
// 搜索范围仅限当前用户可见的消息（排除已撤回与自己删除的）
func (s *Server) handleSearch(c *Client, msg *protocol.Message) {
	keyword := strings.TrimSpace(msg.Content)
	if keyword == "" {
		s.sendError(c, "请输入搜索关键词")
		return
	}
	// 转义 LIKE 通配符，避免 % 和 _ 影响匹配
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(keyword)

	query := store.DB.Model(&model.Message{}).
		Where("content LIKE ? AND recalled = ?", "%"+escaped+"%", false)

	// 排除当前用户已删除的消息
	var delIDs []uint
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ?", c.username).Pluck("msg_id", &delIDs)
	if len(delIDs) > 0 {
		query = query.Where("id NOT IN ?", delIDs)
	}

	if msg.ToUser != "" {
		// 指定会话搜索（私聊双向）
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, c.username, msg.ToUser, msg.ToUser, c.username)
	} else {
		// 全局搜索：与我相关的群聊 + 私聊
		query = query.Where("(msg_type = 1 OR (msg_type = 2 AND (from_user = ? OR to_user = ?)))", c.username, c.username)
	}

	var records []model.Message
	if err := query.Order("id desc").Limit(20).Find(&records).Error; err != nil {
		s.sendError(c, "搜索失败")
		return
	}

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeSearchResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}

// handleConvSearch 会话内消息搜索：在当前聊天窗口对应会话范围内搜索
// ToUser 为空表示群聊会话，非空表示与指定用户的私聊会话
func (s *Server) handleConvSearch(c *Client, msg *protocol.Message) {
	keyword := strings.TrimSpace(msg.Content)
	if keyword == "" {
		s.sendError(c, "请输入搜索关键词")
		return
	}
	// 转义 LIKE 通配符，避免 % 和 _ 影响匹配
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(keyword)

	query := store.DB.Model(&model.Message{}).
		Where("content LIKE ? AND recalled = ?", "%"+escaped+"%", false)

	// 排除当前用户已删除的消息
	var delIDs []uint
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ?", c.username).Pluck("msg_id", &delIDs)
	if len(delIDs) > 0 {
		query = query.Where("id NOT IN ?", delIDs)
	}

	if msg.ToUser == "" {
		// 群聊会话内搜索：全部群消息
		query = query.Where("msg_type = ?", 1)
	} else {
		// 私聊会话内搜索：双方互发的消息
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, c.username, msg.ToUser, msg.ToUser, c.username)
	}

	var records []model.Message
	if err := query.Order("id desc").Limit(50).Find(&records).Error; err != nil {
		s.sendError(c, "搜索失败")
		return
	}

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeConvSearchResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}
