package server

// ============= 阶段二百九十三：服务号功能（微信同款公众号） =============
//
// 本文件归口：用户端 WebSocket 信令处理（P2 阶段完整实现）
//   MsgType 113  OfficialSubList      下行：已关注服务号列表（登录推送 + 变更同步）
//   MsgType 114  OfficialSubAction    双向：关注/取消关注（落库 + 建/删会话 + 推 113 + 推 18）
//   MsgType 115  OfficialMenu         下行：自定义菜单（P6 实现）
//   MsgType 116  OfficialMenuClick    上行：点击菜单（P6 实现）
//   MsgType 118  OfficialMsgAck       下行：审核状态通知（P5 实现）
//   MsgType 119  OfficialSearch       双向：搜索服务号（P2 实现）
//   MsgType 120  OfficialCard         双向：聊天内服务号名片（骨架）
//
// 服务号消息推送核心（MsgType 117）归口 official_message.go
// HTTP API 网关归口 official_api.go
// 管理员/商户后台归口 official_admin.go / official_merchant.go
//
// 服务号会话 target = 'o_' + app_id（与多群 'g<群ID>' 范式统一，前端 isOfficialTarget 前缀判定）
// 未读角标完全复用 im_conversation + cv.unread 机制（touchConversation 在推送链路中调用）
//
// 关键链路：
//   关注 → upsert subscribe → upsert im_conversation → 推 113 SubList → 推 18 ConvList
//   取消 → UPDATE unsubscribed=1 → DELETE im_conversation → 推 113 → 推 18
//   搜索 → WHERE status=0 AND (display_name LIKE ? OR description LIKE ?) + LEFT JOIN subscribed

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// handleOfficialSubList 下行：登录后推送用户已关注的服务号列表 + 基本信息 + 未读数
// 触发时机：finishLogin 内部并行调用（与 FRIEND_LIST / GROUP_LIST 同层，保证进入主界面时数据就绪）
// 返回 JSON 数组：[{app_id, display_name, avatar, description, subscribe_time, unread}]
func (s *Server) handleOfficialSubList(c *Client) {
	if c == nil || c.username == "" {
		return
	}
	var rows []struct {
		Subscribe      model.OfficialSubscribe `gorm:"embedded"`
		DisplayName    string                  `gorm:"column:display_name"`
		Avatar         string                  `gorm:"column:avatar"`
		Description    string                  `gorm:"column:description"`
		NeedAudit      bool                    `gorm:"column:need_audit"`
	}
	db := store.DB.Table("im_official_subscribe AS sub").
		Select("sub.id, sub.account_id, sub.app_id, sub.username, sub.source, sub.unsubscribed, sub.subscribe_time, sub.unsubscribe_time, "+
			"acc.display_name, acc.avatar, acc.description, acc.need_audit").
		Joins("JOIN im_official_account AS acc ON acc.id = sub.account_id AND acc.status = 0").
		Where("sub.username = ? AND sub.unsubscribed = false", c.username).
		Order("sub.subscribe_time DESC")
	if err := db.Find(&rows).Error; err != nil {
		logger.Error("SubList 查询失败 user=%s err=%s", c.username, err.Error())
		return
	}
	if len(rows) == 0 {
		return
	}
	// 未读数聚合（按 from_user='o_xxx' 分组 COUNT 未读消息）
	appIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		appIDs = append(appIDs, "o_"+r.Subscribe.AppID)
	}
	unreadMap := map[string]int64{}
	var ureprs []struct {
		FromUser string
		Cnt      int64
	}
	store.DB.Model(&model.Message{}).
		Select("from_user, COUNT(*) as cnt").
		Where("to_user = ? AND from_user IN ? AND is_read = false AND (msg_type = ? OR msg_type = ?)",
			c.username, appIDs, int8(protocol.MsgTypeOfficialMsg), int8(protocol.MsgTypeOfficialCard)).
		Group("from_user").Scan(&ureprs)
	for _, r := range ureprs {
		unreadMap[r.FromUser] = r.Cnt
	}
	// 组装下行 JSON
	items := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		target := "o_" + r.Subscribe.AppID
		items = append(items, map[string]interface{}{
			"app_id":         r.Subscribe.AppID,
			"target":         target,
			"display_name":   r.DisplayName,
			"avatar":         r.Avatar,
			"description":    r.Description,
			"subscribe_time": r.Subscribe.SubscribeTime,
			"source":         r.Subscribe.Source,
			"unread":         unreadMap[target],
		})
	}
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialSubList,
		FromUser:  "system",
		ToUser:    c.username,
		Content:   string(mustJSON(items)),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(chatMsg)
	s.sendToUser(c.username, data)
}

// handleOfficialSubAction 双向：关注/取消关注
// 上行 content 为 JSON {"action":"subscribe|unsubscribe","app_id"}
// 下行同帧回执（content: {"ok":true, "app_id":"..."} 或 {"ok":false, "err":"..."}）
//
// 完整链路：
//   subscribe: upsert subscribe → upsert im_conversation('o_'+appid) → 推 113 SubList → 推 18 ConvList
//   unsubscribe: UPDATE subscribe SET unsubscribed=true → DELETE conversation → 推 113 → 推 18
func (s *Server) handleOfficialSubAction(c *Client, msg *protocol.Message) {
	if c == nil || c.username == "" {
		return
	}
	var p struct {
		Action string `json:"action"`
		AppID  string `json:"app_id"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "参数错误")
		return
	}
	p.AppID = strings.TrimSpace(p.AppID)
	if p.AppID == "" {
		s.sendError(c, "缺少 app_id")
		return
	}
	if p.Action != "subscribe" && p.Action != "unsubscribe" {
		s.sendError(c, "未知 action，仅支持 subscribe / unsubscribe")
		return
	}
	// 校验服务号存在且启用
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", p.AppID).First(&acc).Error; err != nil {
		s.sendError(c, "服务号不存在或已停用")
		return
	}

	var err error

	switch p.Action {
	case "subscribe":
		err = s.doSubscribe(c.username, &acc, "search")
	case "unsubscribe":
		err = s.doUnsubscribe(c.username, &acc)
	}

	if err != nil {
		s.sendError(c, err.Error())
		return
	}
	// 推 113 SubList 刷新（触发 handleOfficialSubList）
	s.handleOfficialSubList(c)
	// 推 18 ConvList 刷新（复用现有 notifyConvUpdate，触发前端会话列表重拉）
	s.notifyConvUpdate(c.username)

	logger.Info("服务号 %s user=%s action=%s", p.AppID, c.username, p.Action)

	// 回执
	payload, _ := json.Marshal(map[string]interface{}{"ok": true, "app_id": p.AppID})
	chatMsg := protocol.Message{MsgType: protocol.MsgTypeOfficialSubAction, FromUser: "system", ToUser: c.username, Content: string(payload), Timestamp: time.Now().Unix()}
	data, _ := json.Marshal(chatMsg)
	s.sendToUser(c.username, data)
}

// doSubscribe 关注核心（事务：upsert subscribe + upsert conversation）
func (s *Server) doSubscribe(username string, acc *model.OfficialAccount, source string) error {
	tx := store.DB.Begin()
	// upsert subscribe（已有关注行直接返回；取消关注行置为 false）
	var sub model.OfficialSubscribe
	res := tx.Where("username = ? AND app_id = ?", username, acc.AppID).First(&sub)
	now := time.Now()
	if res.Error == nil {
		if sub.Unsubscribed {
			sub.Unsubscribed = false
			sub.Source = source
			sub.UnsubscribeTime = nil
			sub.SubscribeTime = now
			tx.Save(&sub)
		}
	} else {
		sub = model.OfficialSubscribe{
			AccountID:    acc.ID,
			AppID:        acc.AppID,
			Username:     username,
			Source:       source,
			Unsubscribed: false,
			SubscribeTime: now,
		}
		if err := tx.Create(&sub).Error; err != nil {
			tx.Rollback()
			return fmt.Errorf("写入关注关系失败: %s", err.Error())
		}
	}
	// upsert im_conversation（target='o_'+appid）
	target := "o_" + acc.AppID
	var conv model.Conversation
	cres := tx.Where("user_id = ? AND target = ?", username, target).First(&conv)
	if cres.Error != nil {
		conv = model.Conversation{
			UserID:   username,
			Target:   target,
			LastMsg:  "您已关注「" + acc.DisplayName + "」",
			LastTime: now,
		}
		if err := tx.Create(&conv).Error; err != nil {
			tx.Rollback()
			return fmt.Errorf("创建会话失败: %s", err.Error())
		}
	}
	tx.Commit()
	return nil
}

// doUnsubscribe 取消关注核心（事务：UPDATE unsubscribed + DELETE conversation）
func (s *Server) doUnsubscribe(username string, acc *model.OfficialAccount) error {
	tx := store.DB.Begin()
	now := time.Now()
	tx.Model(&model.OfficialSubscribe{}).
		Where("username = ? AND app_id = ?", username, acc.AppID).
		Updates(map[string]interface{}{"unsubscribed": true, "unsubscribe_time": now})
	target := "o_" + acc.AppID
	tx.Where("user_id = ? AND target = ?", username, target).Delete(&model.Conversation{})
	tx.Commit()
	return nil
}

// handleOfficialSearch 双向：搜索服务号（P2 实现）
// 上行 content 为关键词字符串；下行 JSON 数组 [{app_id, display_name, avatar, description, subscribed}]
// 搜索范围：display_name LIKE 关键词 或 description LIKE 关键词
func (s *Server) handleOfficialSearch(c *Client, msg *protocol.Message) {
	keyword := strings.TrimSpace(msg.Content)
	if keyword == "" {
		return
	}
	var list []model.OfficialAccount
	if err := store.DB.Where("status = 0 AND (display_name LIKE ? OR description LIKE ?)",
		"%"+keyword+"%", "%"+keyword+"%").
		Order("id DESC").
		Limit(20).Find(&list).Error; err != nil {
		logger.Error("服务号搜索失败 kw=%s err=%s", keyword, err.Error())
		return
	}
	if len(list) == 0 {
		return
	}
	// 批量查 subscribed 状态
	appIDs := make([]string, 0, len(list))
	for _, a := range list {
		appIDs = append(appIDs, a.AppID)
	}
	subSet := map[string]struct{}{}
	var subs []model.OfficialSubscribe
	store.DB.Where("username = ? AND app_id IN ? AND unsubscribed = false", c.username, appIDs).Find(&subs)
	for _, sub := range subs {
		subSet[sub.AppID] = struct{}{}
	}
	items := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		_, sub := subSet[a.AppID]
		items = append(items, map[string]interface{}{
			"app_id":       a.AppID,
			"display_name": a.DisplayName,
			"avatar":       a.Avatar,
			"description":  a.Description,
			"subscribed":   sub,
		})
	}
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialSearch,
		FromUser:  "system",
		ToUser:    c.username,
		Content:   string(mustJSON(items)),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(chatMsg)
	s.sendToUser(c.username, data)
}

// handleOfficialMenu 下行：打开服务号会话时拉取底部自定义菜单
// 触发时机：前端打开 'o_<appid>' 会话 → 发 MSG 115（to_user = 'o_<appid>'）
// 后端：解析 to_user → app_id → 查菜单表 → 组树 JSON 回推 115 给该用户
func (s *Server) handleOfficialMenu(c *Client, msg *protocol.Message) {
	if c == nil || c.username == "" {
		return
	}
	target := strings.TrimSpace(msg.ToUser)
	if !strings.HasPrefix(target, "o_") || len(target) < 3 {
		return
	}
	appID := target[2:]

	// 查服务号有效性
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		// 服务号不存在或已停用 → 返回空菜单
		s.pushOfficialMenu(c, appID, acc.ID, nil)
		return
	}

	// 查菜单（一级+二级）
	var menus []model.OfficialMenu
	if err := store.DB.Where("account_id = ?", acc.ID).
		Order("parent_id ASC, sort_order ASC, id ASC").Find(&menus).Error; err != nil {
		s.pushOfficialMenu(c, appID, acc.ID, nil)
		return
	}

	type node struct {
		ID       uint   `json:"-"`
		Name     string `json:"name"`
		Action   string `json:"action"`
		Value    string `json:"value"`
		Children []node `json:"children,omitempty"`
	}
	roots := []node{}
	byParent := map[uint][]node{}
	for _, m := range menus {
		n := node{ID: m.ID, Name: m.Name, Action: m.Action, Value: m.Value}
		if m.ParentID == 0 {
			roots = append(roots, n)
		} else {
			byParent[m.ParentID] = append(byParent[m.ParentID], n)
		}
	}
	var attach func([]node) []node
	attach = func(nodes []node) []node {
		out := []node{}
		for _, n := range nodes {
			n.Children = attach(byParent[n.ID])
			out = append(out, n)
		}
		return out
	}
	s.pushOfficialMenu(c, appID, acc.ID, attach(roots))
}

// pushOfficialMenu 组装 envelope + 115 下行
func (s *Server) pushOfficialMenu(c *Client, appID string, accountID uint, menus interface{}) {
	envelope := map[string]interface{}{
		"app_id":      appID,
		"account_id":  accountID,
		"menus":       menus,
		"menu_source": "official",
	}
	payload, _ := json.Marshal(envelope)
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialMenu,
		FromUser:  "system",
		FromName:  "服务号",
		ToUser:    c.username,
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(chatMsg)
	s.sendToUser(c.username, data)
}

// handleOfficialMenuClick 上行：点击底部菜单事件
// 前端点菜单项（click 或 view）→ 发 116 上行 → 后端：
//   action=click → 触发自动回复（菜单 value 作为关键词）；action=view → 后端不下行，前端自己跳 URL
// 自动回复：
//   - 把菜单 value 当成"用户输入"触发服务号 keyword 回复（与用户手动发关键词同路径）
//   - 如果服务号没配关键词表，回退到 default_reply（config 配置）
func (s *Server) handleOfficialMenuClick(c *Client, msg *protocol.Message) {
	if c == nil || c.username == "" {
		return
	}
	var p struct {
		AppID  string `json:"app_id"`
		Action string `json:"action"`
		Value  string `json:"value"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "菜单参数错误")
		return
	}
	p.Action = strings.TrimSpace(p.Action)
	p.Value = strings.TrimSpace(p.Value)
	p.AppID = strings.TrimSpace(p.AppID)
	if p.AppID == "" {
		s.sendError(c, "缺少 app_id")
		return
	}
	if p.Action == "view" {
		// 跳转 URL：后端不下行回复，前端自己按 value 打开浏览器 / iframe
		// 这里只记录一次点击事件（后续可能做点击统计）
		logger.Info("服务号菜单点击 app=%s action=view value=%s user=%s", p.AppID, p.Value, c.username)
		return
	}
	// action=click（默认）：触发自动回复
	// 查服务号 account
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", p.AppID).First(&acc).Error; err != nil {
		return
	}

	// 关键词匹配：用菜单 value 作为触发词 → 命中则 reply = keyword.reply_text；
	// 否则 value 本身是纯文案（P6 phase 1 行为）；都不命中回退 default_reply
	var replyText string
	matched := s.matchOfficialKeyword(acc.ID, p.Value)
	if matched != "" {
		replyText = matched
	} else if p.Value != "" {
		replyText = p.Value
	} else {
		replyText = s.cfg.Official.DefaultReply
	}
	if replyText == "" {
		replyText = "您好，请问有什么可以帮您？"
	}

	// 下行两条消息：① click 回执（告诉前端点击成功）② 自动回复 bubble
	target := "o_" + p.AppID

	// 回执（前端用它消掉 loading 态）
	ack, _ := json.Marshal(map[string]interface{}{
		"app_id": p.AppID, "action": p.Action, "value": p.Value, "ok": true,
	})
	s.pushToConvTarget(c.username, target, protocol.MsgTypeOfficialMenuClick, "system", string(ack))

	// 自动回复（117 下行 / 或直接用普通 1 号消息类型）
	// 用普通 MsgType=1（文本消息）更自然地显示在聊天区
	s.pushToConvTarget(c.username, target, 1, "o_"+p.AppID, replyText)

	logger.Info("服务号菜单点击自动回复 app=%s user=%s", p.AppID, c.username)
}

// pushToConvTarget 辅助：从 fromUser 向 target（用户）推一条指定 msg_type 消息
// 同时落库 im_message + touchConversation（让多端会话列表显示未读）
func (s *Server) pushToConvTarget(toUser, target string, msgType int8, fromUser, content string) {
	chatMsg := protocol.Message{
		MsgType:   int(msgType),
		FromUser:  fromUser,
		FromName:  "服务号",
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(chatMsg)

	// 落库
	store.DB.Create(&struct {
		MsgType    int8      `gorm:"column:msg_type"`
		FromUser   string    `gorm:"column:from_user"`
		ToUser     string    `gorm:"column:to_user"`
		Content    string    `gorm:"column:content;type:text"`
		CreateTime time.Time `gorm:"column:create_time"`
	}{msgType, fromUser, toUser, content, time.Now()})

	// touch + 推
	s.touchConversationDebounced(toUser, target, content, 0)
	s.notifyConvUpdate(toUser)

	if s.isOnlineFast(toUser) {
		s.sendToUser(toUser, data)
	} else {
		s.queueOffline(toUser, &chatMsg)
	}
}

// matchOfficialKeyword 在指定服务号下按 exact > fuzzy > sort_order 优先级匹配关键词
// 返回 reply_text（未命中则返回空串）
func (s *Server) matchOfficialKeyword(accountID uint, input string) string {
	input = strings.TrimSpace(input)
	if input == "" {
		return ""
	}
	// exact 优先
	var exact model.OfficialKeyword
	if err := store.DB.Where("account_id = ? AND keyword = ? AND enabled = true AND match_type = 'exact'",
		accountID, input).First(&exact).Error; err == nil {
		return exact.ReplyText
	}
	// fuzzy 兜底
	var fuzzy model.OfficialKeyword
	if err := store.DB.Where("account_id = ? AND enabled = true AND match_type = 'fuzzy' AND ? LIKE CONCAT('%', keyword, '%')",
		accountID, input).Order("sort_order ASC, id ASC").First(&fuzzy).Error; err == nil {
		return fuzzy.ReplyText
	}
	return ""
}

// handleOfficialUserChat 用户发消息进服务号会话 → 自动回复钩子
// 在 handlePrivateChat 落库成功后调用；非 o_ 前缀 target 直接 return
func (s *Server) handleOfficialUserChat(c *Client, target, content string) {
	if c == nil || c.username == "" || target == "" || !strings.HasPrefix(target, "o_") {
		return
	}
	appID := target[2:]
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		return
	}
	reply := s.matchOfficialKeyword(acc.ID, content)
	if reply == "" {
		reply = s.cfg.Official.DefaultReply
	}
	if reply == "" {
		reply = "您好，请问有什么可以帮您？"
	}
	// 用 goroutine 异步推送，不阻塞原始私聊链路
	go func() {
		s.pushToConvTarget(c.username, target, 1, "o_"+appID, reply)
	}()
}

// handleOfficialCard 聊天内服务号名片（骨架阶段已实现，复用私聊/群聊普通消息链路）
func (s *Server) handleOfficialCard(c *Client, msg *protocol.Message) {
	var p struct {
		AppID string `json:"app_id"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil {
		s.sendError(c, "名片参数错误")
		return
	}
	p.AppID = strings.TrimSpace(p.AppID)
	if p.AppID == "" {
		s.sendError(c, "缺少 app_id")
		return
	}
	if msg.ToUser == "" {
		s.sendError(c, "名片缺少接收方")
		return
	}
	if _, ok := isGroupTarget(msg.ToUser); !ok {
		if s.isBlocked(c.username, msg.ToUser) {
			s.sendError(c, "对方已将你拉黑")
			return
		}
	} else {
		gid, _ := isGroupTarget(msg.ToUser)
		if !isGroupMember(gid, c.username) {
			s.sendError(c, "你不是该群成员")
			return
		}
	}
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", p.AppID).First(&acc).Error; err != nil {
		s.sendError(c, "服务号不存在或已停用")
		return
	}
	envelope, _ := json.Marshal(map[string]interface{}{
		"app_id":     acc.AppID,
		"name":       acc.DisplayName,
		"avatar":     acc.Avatar,
		"desc":       acc.Description,
		"account_id": acc.ID,
	})
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialCard,
		FromUser:  c.username,
		FromName:  nicknameOf(c.username),
		ToUser:    msg.ToUser,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	record := model.Message{MsgType: int8(protocol.MsgTypeOfficialCard), FromUser: c.username, ToUser: msg.ToUser, Content: chatMsg.Content}
	record.ID = s.persistMessage(&record)
	if record.ID == 0 {
		logger.Error("服务号名片落库失败 %s→%s", c.username, msg.ToUser)
		s.sendError(c, "发送失败")
		return
	}
	chatMsg.MsgID = record.ID
	data, _ := json.Marshal(chatMsg)
	summary := "[服务号] " + acc.DisplayName
	if gid, ok := isGroupTarget(msg.ToUser); ok {
		memberIDs := getGroupMemberIDs(gid)
		s.sendToGroupMembers(memberIDs, data)
		for _, uname := range memberIDs {
			if uname != c.username {
				if !s.isOnlineFast(uname) {
					s.queueOffline(uname, &chatMsg)
				} else {
					s.touchConversation(uname, msg.ToUser, summary)
					s.notifyConvUpdate(uname)
				}
			}
		}
	} else {
		if s.isOnlineFast(msg.ToUser) {
			s.sendToUser(msg.ToUser, data)
		} else {
			s.queueOffline(msg.ToUser, &chatMsg)
		}
		s.sendToUser(c.username, data)
		s.touchConversation(c.username, msg.ToUser, summary)
		s.touchConversation(msg.ToUser, c.username, summary)
		s.notifyConvUpdate(c.username)
		s.notifyConvUpdate(msg.ToUser)
	}
	logger.Info("服务号名片 %s → %s（%s）", c.username, msg.ToUser, p.AppID)
}

// ============= 工具函数 =============

// isOfficialTarget 判定会话 target 是否为服务号（'o_' 前缀 + 长度 > 2）
func isOfficialTarget(target string) bool {
	return strings.HasPrefix(target, "o_") && len(target) > 2
}

// officialAccountByAppID 按 app_id 查服务号
func officialAccountByAppID(appID string) (*model.OfficialAccount, error) {
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ?", appID).First(&acc).Error; err != nil {
		return nil, err
	}
	return &acc, nil
}

// userIsSubscribed 判定用户是否已关注（推送时二次校验）
func userIsSubscribed(username, appID string) bool {
	var cnt int64
	store.DB.Model(&model.OfficialSubscribe{}).Where("username = ? AND app_id = ? AND unsubscribed = false", username, appID).Count(&cnt)
	return cnt > 0
}
