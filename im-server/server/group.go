package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ===== 阶段一百四十二：微信同款多群聊（一期：建群 + 邀请 + 多群收发，服务端归口） =====
// 会话目标编码：新群 target = 'g' + 群ID（如 g1），存于 Conversation.Target 与 Message.ToUser；
// 全局群 target='' 语义不变；邀请状态机复用好友申请链路模式（在线实时推送 + 登录补推兜底）。

// groupTargetPrefix 群会话目标前缀
const groupTargetPrefix = "g"

// resolveGroupUploadScope 阶段一百四十二：群图片/文件上传的群作用域解析——
// group 参数为空=全局群（原行为完全不变）；非空=多群聊（校验群存在 + 上传者是成员）。
// 返回（是否多群, 错误信息）
func resolveGroupUploadScope(groupParam, username string) (bool, string) {
	if groupParam == "" {
		return false, ""
	}
	groupID, ok := isGroupTarget(groupParam)
	if !ok {
		return false, "群聊不存在"
	}
	if !isGroupMember(groupID, username) {
		return true, "你不是该群成员，无法发送消息"
	}
	return true, ""
}

// broadcastGroupMediaNotice 阶段一百四十二：多群聊图片/文件广播归口——按群成员定向广播 +
// 离线成员入队 + 在线成员会话摘要更新（与全局群原链路同序；全局群仍走调用方原 hub.Broadcast 路径）
func (s *Server) broadcastGroupMediaNotice(notice *protocol.Message, summary string) {
	groupID := groupIDFromTarget(notice.ToUser)
	memberIDs := getGroupMemberIDs(groupID)
	data, _ := json.Marshal(notice)
	s.sendToGroupMembers(memberIDs, data)

	// 离线成员入队（与群聊文字消息行为一致：发送者自身不入队）
	for _, name := range memberIDs {
		if name != notice.FromUser && !s.isOnline(name) {
			s.queueOffline(name, notice)
		}
	}

	// 在线成员会话摘要更新并推送（离线成员登录时按 to_user 拉取群历史，摘要行入群时已创建）
	for _, name := range memberIDs {
		if s.isOnline(name) {
			s.touchConversation(name, notice.ToUser, summary)
			s.notifyConvUpdate(name)
		}
	}
}

// groupTargetOf 群ID → 会话目标编码（如 1 → "g1"）
func groupTargetOf(groupID uint) string {
	return groupTargetPrefix + strconv.FormatUint(uint64(groupID), 10)
}

// groupIDFromTarget 会话目标编码 → 群ID（非 'g'+数字 形式返回 0）
func groupIDFromTarget(target string) uint {
	if len(target) < 2 || !strings.HasPrefix(target, groupTargetPrefix) {
		return 0
	}
	id, err := strconv.ParseUint(target[1:], 10, 64)
	if err != nil || id == 0 {
		return 0
	}
	return uint(id)
}

// isGroupTarget 判定会话目标是否为多群聊会话（服务端以查表为准，不信前缀）：
// 命中返回 true 并回填群ID；全局群（target=”）与私聊/AI 目标均不命中
func isGroupTarget(target string) (uint, bool) {
	id := groupIDFromTarget(target)
	if id == 0 {
		return 0, false
	}
	var count int64
	store.DB.Model(&model.Group{}).Where("id = ?", id).Count(&count)
	return id, count > 0
}

// isGroupMember 判定用户是否群成员
func isGroupMember(groupID uint, username string) bool {
	var count int64
	store.DB.Model(&model.GroupMember{}).Where("group_id = ? AND user_id = ?", groupID, username).Count(&count)
	return count > 0
}

// getGroupMemberIDs 查询群全部成员用户名（一期直查，复合唯一索引足够快；预留下一步 Redis 缓存位）
func getGroupMemberIDs(groupID uint) []string {
	var ids []string
	store.DB.Model(&model.GroupMember{}).Where("group_id = ?", groupID).Order("role asc, id asc").Pluck("user_id", &ids)
	return ids
}

// groupMemberCount 群成员数
func groupMemberCount(groupID uint) int64 {
	var count int64
	store.DB.Model(&model.GroupMember{}).Where("group_id = ?", groupID).Count(&count)
	return count
}

// sendToGroupMembers 向指定成员集合的全部在线连接定向发送（多端同步；替代全员广播的成员过滤原语，
// 全局群路径仍走 hub.Broadcast 不变）
func (s *Server) sendToGroupMembers(memberIDs []string, data []byte) {
	for _, name := range memberIDs {
		s.sendToUser(name, data)
	}
}

// GroupMemberInfo 群成员信息（随 73 群列表同步下发）
type GroupMemberInfo struct {
	Username string `json:"username"`
	Name     string `json:"name"` // 昵称（服务端归口解析，空昵称前端降级显示账号）
	Role     int8   `json:"role"` // 1群主 2成员
	Avatar   string `json:"avatar"`
}

// GroupInfo 群信息（随 73 群列表同步下发）
type GroupInfo struct {
	GroupID     uint              `json:"group_id"`
	Name        string            `json:"name"`
	Avatar      string            `json:"avatar"`
	Owner       string            `json:"owner"`
	Announce    string            `json:"announce"` // 阶段一百四十三：群公告（群设置面板展示）
	MemberCount int               `json:"member_count"`
	Members     []GroupMemberInfo `json:"members"`
	CreateTime  int64             `json:"create_time"`
}

// buildGroupInfos 批量构造群信息（含成员明细，服务端归口一次组装）
func buildGroupInfos(groupIDs []uint) []GroupInfo {
	infos := make([]GroupInfo, 0, len(groupIDs))
	for _, gid := range groupIDs {
		var g model.Group
		if err := store.DB.Where("id = ?", gid).First(&g).Error; err != nil {
			continue
		}
		var members []model.GroupMember
		store.DB.Where("group_id = ?", gid).Order("role asc, id asc").Find(&members)

		// 批量取成员头像（一次 IN 查询，避免逐成员回源）；昵称走 nicknameOf 缓存
		memberInfos := make([]GroupMemberInfo, 0, len(members))
		if len(members) > 0 {
			names := make([]string, 0, len(members))
			for _, m := range members {
				names = append(names, m.UserID)
			}
			var users []model.User
			store.DB.Where("username IN ?", names).Find(&users)
			avatarMap := make(map[string]string, len(users))
			for _, u := range users {
				avatarMap[u.Username] = u.Avatar
			}
			for _, m := range members {
				memberInfos = append(memberInfos, GroupMemberInfo{
					Username: m.UserID,
					Name:     nicknameOf(m.UserID),
					Role:     m.Role,
					Avatar:   avatarMap[m.UserID],
				})
			}
		}
		infos = append(infos, GroupInfo{
			GroupID:     g.ID,
			Name:        g.Name,
			Avatar:      g.Avatar,
			Owner:       g.OwnerID,
			Announce:    g.Announce,
			MemberCount: len(memberInfos),
			Members:     memberInfos,
			CreateTime:  g.CreateTime.Unix(),
		})
	}
	return infos
}

// sendGroupListSync 向指定用户推送 73 群列表全量同步（推送其全部在线连接，多端同步；
// 登录时与成员/信息变更时归口调用，前端据此维护 groupMap）
func (s *Server) sendGroupListSync(username string) {
	var groupIDs []uint
	store.DB.Model(&model.GroupMember{}).Where("user_id = ?", username).Pluck("group_id", &groupIDs)

	content, _ := json.Marshal(map[string]interface{}{
		"groups": buildGroupInfos(groupIDs),
	})
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeGroupListSync,
		ToUser:    username,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, data)
}

// notifyGroupListSync 向多个用户逐一推送 73 群列表（全群成员/新成员变更时归口调用）
func (s *Server) notifyGroupListSync(usernames []string) {
	for _, name := range usernames {
		s.sendGroupListSync(name)
	}
}

// groupMemberNoticePayload 77 成员变更通知载荷
type groupMemberNoticePayload struct {
	GroupID     uint              `json:"group_id"`
	Action      string            `json:"action"`          // create=群聊已创建 / join=新成员加入 / reject=邀请被拒绝（仅邀请人收）/ kick=被移出群聊 / leave=已退出群聊（阶段一百四十三）
	Users       []GroupMemberInfo `json:"users,omitempty"` // action=join 时为新成员；action=reject 时为被拒绝对象
	MemberCount int               `json:"member_count"`
	Name        string            `json:"name,omitempty"` // 阶段一百四十三：群名（kick/leave 提示语归口服务端下发，避免前端离线期数据缺失）
}

// pushGroupMemberNotice 向成员集合推送 77 成员变更通知
func (s *Server) pushGroupMemberNotice(memberIDs []string, payload groupMemberNoticePayload) {
	content, _ := json.Marshal(payload)
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeGroupMemberNotice,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	s.sendToGroupMembers(memberIDs, data)
}

// groupCreatePayload 71 建群载荷
type groupCreatePayload struct {
	Name    string   `json:"name"`
	Members []string `json:"members"` // 选自好友列表，不含自己
}

// handleGroupCreate 处理建群：校验群名/成员均为好友 → 建 im_group + 成员行（含群主）→
// 逐成员建会话 + 推 73 群列表 → 建群者收 72 回执 → 全员收 77 create 通知
func (s *Server) handleGroupCreate(c *Client, msg *protocol.Message) {
	var payload groupCreatePayload
	if err := json.Unmarshal([]byte(msg.Content), &payload); err != nil {
		s.sendError(c, "建群参数格式错误")
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		s.sendError(c, "群名称不能为空")
		return
	}
	// 群名长度按字符截取（varchar(64) 字节上限，中文 3 字节，限 20 字符留余量）
	if runes := []rune(name); len(runes) > 20 {
		name = string(runes[:20])
	}
	// 群名敏感词过滤（与消息同口径）
	if word, ok := containsSensitive(name); ok {
		s.sendError(c, "群名称包含敏感词，已拦截")
		logger.Warn("敏感词拦截：%s 建群名称包含 '%s'", c.username, word)
		return
	}

	// 成员去重 + 剔除自己 + 好友校验（一期选人范围仅限好友）
	seen := map[string]bool{c.username: true}
	members := make([]string, 0, len(payload.Members))
	for _, m := range payload.Members {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		if !s.isFriend(c.username, m) {
			s.sendError(c, "仅支持邀请好友建群："+m+" 不是你的好友")
			return
		}
		seen[m] = true
		members = append(members, m)
	}
	if len(members) == 0 {
		s.sendError(c, "请至少选择 1 位好友建群")
		return
	}

	// 建群 + 写成员行（群主 Role=1，成员 Role=2）
	group := model.Group{Name: name, OwnerID: c.username}
	if err := store.DB.Create(&group).Error; err != nil {
		s.sendError(c, "建群失败，请稍后重试")
		logger.Error("建群写库失败：%s %v", c.username, err)
		return
	}
	rows := []model.GroupMember{{GroupID: group.ID, UserID: c.username, Role: 1}}
	for _, m := range members {
		rows = append(rows, model.GroupMember{GroupID: group.ID, UserID: m, Role: 2})
	}
	if err := store.DB.Create(&rows).Error; err != nil {
		store.DB.Delete(&group)
		s.sendError(c, "建群失败，请稍后重试")
		logger.Error("群成员写库失败：群 %d %v", group.ID, err)
		return
	}
	logger.Info("建群成功：群 %d「%s」群主 %s 成员 %v", group.ID, name, c.username, members)

	// 逐成员建会话行（target=gN）并推送 73 群列表
	target := groupTargetOf(group.ID)
	s.touchConversation(c.username, target, "已创建群聊「"+name+"」")
	for _, m := range members {
		s.touchConversation(m, target, c.username+" 邀请你加入了群聊「"+name+"」")
	}
	allMembers := append([]string{c.username}, members...)
	s.notifyGroupListSync(allMembers)

	// 建群回执（72）给建群者
	respContent, _ := json.Marshal(map[string]interface{}{
		"group_id":    group.ID,
		"name":        name,
		"members":     allMembers,
		"create_time": group.CreateTime.Unix(),
	})
	respData, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeGroupCreateResp,
		ToUser:    c.username,
		Content:   string(respContent),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(c.username, respData)

	// 77 create 通知全群（前端主要依赖 73 归口，此帧仅作提示补充）
	s.pushGroupMemberNotice(allMembers, groupMemberNoticePayload{
		GroupID:     group.ID,
		Action:      "create",
		MemberCount: len(allMembers),
	})
}

// groupInvitePayload 74 邀请载荷
type groupInvitePayload struct {
	GroupID uint     `json:"group_id"`
	Members []string `json:"members"`
}

// handleGroupInvite 处理邀请入群（一期仅群主可邀请）：校验成员身份/被邀请人非成员/在途邀请去重 →
// 写 im_group_invite(Status=0) → 被邀请人在线推 75；离线由登录补推兜底（与好友申请同款，不入离线队列防重复）
func (s *Server) handleGroupInvite(c *Client, msg *protocol.Message) {
	var payload groupInvitePayload
	if err := json.Unmarshal([]byte(msg.Content), &payload); err != nil {
		s.sendError(c, "邀请参数格式错误")
		return
	}
	if payload.GroupID == 0 {
		s.sendError(c, "群不存在")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", payload.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	// 一期仅群主可邀请（二期扩展管理员）
	if group.OwnerID != c.username {
		s.sendError(c, "仅群主可以邀请成员")
		return
	}

	invited, skipped := 0, 0
	for _, m := range payload.Members {
		m = strings.TrimSpace(m)
		if m == "" || m == c.username {
			continue
		}
		// 已是成员拦截
		if isGroupMember(group.ID, m) {
			skipped++
			continue
		}
		// 在途邀请去重（同群同人 Status=0 拦截；已拒绝可再次邀请）
		var pending int64
		store.DB.Model(&model.GroupInvite{}).
			Where("group_id = ? AND to_user = ? AND status = 0", group.ID, m).Count(&pending)
		if pending > 0 {
			skipped++
			continue
		}

		req := model.GroupInvite{GroupID: group.ID, FromUser: c.username, ToUser: m, Status: 0}
		if err := store.DB.Create(&req).Error; err != nil {
			logger.Error("群邀请写库失败：%s -> %s 群 %d %v", c.username, m, group.ID, err)
			skipped++
			continue
		}
		invited++

		// 被邀请人在线实时推送 75（微信式邀请通知，前端进"新的朋友"列表处理）
		noticeContent, _ := json.Marshal(map[string]interface{}{
			"invite_id":    req.ID,
			"group_id":     group.ID,
			"name":         group.Name,
			"from_user":    c.username,
			"from_name":    nicknameOf(c.username),
			"member_count": groupMemberCount(group.ID),
		})
		noticeData, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeGroupInviteNotice,
			FromUser:  c.username,
			ToUser:    m,
			Content:   string(noticeContent),
			Timestamp: time.Now().Unix(),
			MsgID:     req.ID,
		})
		s.sendToUser(m, noticeData)
		logger.Info("群邀请：%s 邀请 %s 加入群 %d", c.username, m, group.ID)
	}

	if invited > 0 {
		s.sendError(c, "邀请已发送")
	} else if skipped > 0 {
		s.sendError(c, "邀请发送失败：对方已是成员或存在待处理的邀请")
	} else {
		s.sendError(c, "请选择要邀请的好友")
	}
}

// groupInviteRespPayload 76 邀请响应载荷
type groupInviteRespPayload struct {
	InviteID uint `json:"invite_id"`
	Accept   bool `json:"accept"`
}

// handleGroupInviteResp 处理邀请响应（状态机，复用好友申请链路模式）：
// 校验归属与 Status=0 → 改状态 → 同意则插成员行（幂等）→ 全群推 73 + 77 join →
// 邀请人收 77（join=同意回执 / reject=拒绝回执）
func (s *Server) handleGroupInviteResp(c *Client, msg *protocol.Message) {
	var payload groupInviteRespPayload
	if err := json.Unmarshal([]byte(msg.Content), &payload); err != nil {
		s.sendError(c, "邀请响应参数格式错误")
		return
	}
	// 归属校验：仅被邀请人本人可响应
	var invite model.GroupInvite
	if err := store.DB.Where("id = ?", payload.InviteID).First(&invite).Error; err != nil {
		s.sendError(c, "未找到该邀请")
		return
	}
	if invite.ToUser != c.username {
		s.sendError(c, "无权处理该邀请")
		return
	}
	if invite.Status != 0 {
		s.sendError(c, "该邀请已处理")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", invite.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "该群聊已不存在")
		invite.Status = 2
		store.DB.Save(&invite)
		return
	}

	if !payload.Accept {
		invite.Status = 2
		store.DB.Save(&invite)
		s.sendError(c, "已拒绝邀请")
		// 拒绝回执：仅邀请人收 77 reject
		s.pushGroupMemberNotice([]string{invite.FromUser}, groupMemberNoticePayload{
			GroupID: group.ID,
			Action:  "reject",
			Users:   []GroupMemberInfo{{Username: c.username, Name: nicknameOf(c.username), Role: 2}},
		})
		logger.Info("群邀请拒绝：%s 拒绝加入群 %d", c.username, group.ID)
		return
	}

	// 同意：改状态 + 幂等插成员行（并发响应防重复入群）
	invite.Status = 1
	store.DB.Save(&invite)
	if !isGroupMember(group.ID, c.username) {
		if err := store.DB.Create(&model.GroupMember{GroupID: group.ID, UserID: c.username, Role: 2}).Error; err != nil {
			logger.Error("群成员写入失败：%s 群 %d %v", c.username, group.ID, err)
			s.sendError(c, "加入群聊失败，请稍后重试")
			return
		}
	}

	// 新成员会话行 + 全群推 73（群列表归口刷新）+ 77 join 通知（同时作为邀请人同意回执）
	memberIDs := getGroupMemberIDs(group.ID)
	s.touchConversation(c.username, groupTargetOf(group.ID), "已加入群聊「"+group.Name+"」")
	s.notifyGroupListSync(memberIDs)
	s.pushGroupMemberNotice(memberIDs, groupMemberNoticePayload{
		GroupID:     group.ID,
		Action:      "join",
		Users:       []GroupMemberInfo{{Username: c.username, Name: nicknameOf(c.username), Role: 2}},
		MemberCount: len(memberIDs),
	})
	s.sendError(c, "已加入群聊「"+group.Name+"」")
	logger.Info("群邀请同意：%s 加入群 %d", c.username, group.ID)
}

// GroupInviteItem 群邀请通知（随 75 下发，字段对齐好友申请的展示要素）
type GroupInviteItem struct {
	InviteID    uint   `json:"invite_id"`
	GroupID     uint   `json:"group_id"`
	Name        string `json:"name"`         // 群名
	FromUser    string `json:"from_user"`    // 邀请人
	FromName    string `json:"from_name"`    // 邀请人昵称
	MemberCount int64  `json:"member_count"` // 当前群成员数
}

// pushPendingGroupInvites 登录补推待处理的群邀请（仅推送登录前已存在的邀请，登录后新邀请由实时推送负责，
// 与好友申请 pushPendingRequests 同款防重复策略）
func (s *Server) pushPendingGroupInvites(c *Client) {
	var invites []model.GroupInvite
	store.DB.Where("to_user = ? AND status = 0 AND create_time < ?", c.username, c.loginTime).Find(&invites)
	for _, inv := range invites {
		var group model.Group
		if err := store.DB.Where("id = ?", inv.GroupID).First(&group).Error; err != nil {
			continue
		}
		content, _ := json.Marshal(GroupInviteItem{
			InviteID:    inv.ID,
			GroupID:     inv.GroupID,
			Name:        group.Name,
			FromUser:    inv.FromUser,
			FromName:    nicknameOf(inv.FromUser),
			MemberCount: groupMemberCount(inv.GroupID),
		})
		data, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeGroupInviteNotice,
			FromUser:  inv.FromUser,
			ToUser:    c.username,
			Content:   string(content),
			Timestamp: inv.CreateTime.Unix(),
			MsgID:     inv.ID,
		})
		c.send(data)
	}
	if len(invites) > 0 {
		logger.Info("用户 %s 登录补推 %d 条待处理群邀请", c.username, len(invites))
	}
}

// ===== 阶段一百四十三：群设置面板（微信同款：群资料查看 + 群主管理） =====
// groupSettingPayload 78 设置载荷（name/announce 均可选，至少一项非空才生效）
type groupSettingPayload struct {
	GroupID  uint   `json:"group_id"`
	Name     string `json:"name"`
	Announce string `json:"announce"`
}

// sendGroupOkResp 通用群操作回执（79/81/83 同构：ok + group_id + err）
func (s *Server) sendGroupOkResp(c *Client, msgType int, groupID uint, ok bool, errMsg string) {
	content, _ := json.Marshal(map[string]interface{}{
		"ok":       ok,
		"group_id": groupID,
		"err":      errMsg,
	})
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   msgType,
		ToUser:    c.username,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(c.username, data)
}

// handleGroupSetting 处理群设置修改（78，仅群主）：群名/公告校验（长度+敏感词，与建群同口径）→
// 更新写库 → 回执 79 + 全群 73 同步归口刷新（前端 groupMap/标题/设置面板自动更新）
func (s *Server) handleGroupSetting(c *Client, msg *protocol.Message) {
	var p groupSettingPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.GroupID == 0 {
		s.sendError(c, "参数格式错误")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", p.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	if group.OwnerID != c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, p.GroupID, false, "仅群主可修改群设置")
		return
	}
	name := strings.TrimSpace(p.Name)
	announce := strings.TrimSpace(p.Announce)
	if name == "" && announce == "" {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, p.GroupID, false, "没有需要修改的内容")
		return
	}
	updates := map[string]interface{}{}
	if name != "" && name != group.Name {
		// 群名长度按字符截取（与建群同口径，限 20 字符）+ 敏感词过滤
		if runes := []rune(name); len(runes) > 20 {
			name = string(runes[:20])
		}
		if word, ok := containsSensitive(name); ok {
			s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, p.GroupID, false, "群名称包含敏感词")
			logger.Warn("敏感词拦截：%s 改群名包含 '%s'", c.username, word)
			return
		}
		updates["name"] = name
	}
	if announce != group.Announce {
		// 公告按字符限 300（varchar(1024) 字节上限留余量）+ 敏感词过滤（空公告=清除，放行）
		if runes := []rune(announce); len(runes) > 300 {
			announce = string(runes[:300])
		}
		if announce != "" {
			if word, ok := containsSensitive(announce); ok {
				s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, p.GroupID, false, "群公告包含敏感词")
				logger.Warn("敏感词拦截：%s 群公告包含 '%s'", c.username, word)
				return
			}
		}
		updates["announce"] = announce
	}
	if len(updates) > 0 {
		if err := store.DB.Model(&model.Group{}).Where("id = ?", group.ID).Updates(updates).Error; err != nil {
			s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, group.ID, false, "保存失败，请稍后重试")
			logger.Error("群设置写库失败：群 %d %v", group.ID, err)
			return
		}
		logger.Info("群设置变更：群 %d「%s」操作人 %s 字段 %v", group.ID, group.Name, c.username, updates)
	}
	s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, group.ID, true, "")
	// 全群 73 同步归口（含操作者全部在线连接），前端据此刷新群名/标题/设置面板
	s.notifyGroupListSync(getGroupMemberIDs(group.ID))
}

// groupKickPayload 80 踢人载荷
type groupKickPayload struct {
	GroupID uint   `json:"group_id"`
	Member  string `json:"member"`
}

// handleGroupKick 处理移出成员（80，仅群主）：校验目标在群且非自己 → 删成员行 + 删其会话行
// （防重新登录残留）→ 回执 81 + 被踢者推 77 kick（含群名，客户端清会话并提示）+ 其余成员 73 同步刷新
func (s *Server) handleGroupKick(c *Client, msg *protocol.Message) {
	var p groupKickPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.GroupID == 0 {
		s.sendError(c, "参数格式错误")
		return
	}
	p.Member = strings.TrimSpace(p.Member)
	if p.Member == "" {
		s.sendError(c, "请选择要移出的成员")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", p.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	if group.OwnerID != c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "仅群主可移出成员")
		return
	}
	if p.Member == c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "不能移出自己")
		return
	}
	res := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, p.Member).Delete(&model.GroupMember{})
	if res.Error != nil || res.RowsAffected == 0 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "该用户不是群成员")
		return
	}
	// 被踢者会话行删除（target=gN）
	target := groupTargetOf(p.GroupID)
	store.DB.Where("user_id = ? AND target = ?", p.Member, target).Delete(&model.Conversation{})
	logger.Info("移出群成员：群 %d「%s」%s 被 %s 移出", p.GroupID, group.Name, p.Member, c.username)

	// 被踢者收 77 kick（带群名）；其余成员（含操作者多端）走 73 同步归口
	s.pushGroupMemberNotice([]string{p.Member}, groupMemberNoticePayload{
		GroupID: p.GroupID,
		Action:  "kick",
		Name:    group.Name,
	})
	s.notifyGroupListSync(getGroupMemberIDs(p.GroupID))
	s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, true, "")
}

// groupQuitPayload 82 退群载荷
type groupQuitPayload struct {
	GroupID uint `json:"group_id"`
}

// handleGroupQuit 处理退出群聊（82）：一期群主不可退（转让/解散归二期），普通成员退群 →
// 删成员行 + 删自己的会话行 → 回执 83 + 退群者推 77 leave + 其余成员 73 同步刷新
func (s *Server) handleGroupQuit(c *Client, msg *protocol.Message) {
	var p groupQuitPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.GroupID == 0 {
		s.sendError(c, "参数格式错误")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", p.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	if group.OwnerID == c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupQuitResp, p.GroupID, false, "群主暂不支持退出群聊（转让/解散功能规划中）")
		return
	}
	res := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, c.username).Delete(&model.GroupMember{})
	if res.Error != nil || res.RowsAffected == 0 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupQuitResp, p.GroupID, false, "你不是群成员")
		return
	}
	target := groupTargetOf(p.GroupID)
	store.DB.Where("user_id = ? AND target = ?", c.username, target).Delete(&model.Conversation{})
	logger.Info("退出群聊：群 %d「%s」成员 %s 退群", p.GroupID, group.Name, c.username)

	s.pushGroupMemberNotice([]string{c.username}, groupMemberNoticePayload{
		GroupID: p.GroupID,
		Action:  "leave",
		Name:    group.Name,
	})
	s.notifyGroupListSync(getGroupMemberIDs(p.GroupID))
	s.sendGroupOkResp(c, protocol.MsgTypeGroupQuitResp, p.GroupID, true, "")
}

// handleMultiGroupChat 阶段一百四十二：多群聊消息广播并持久化（to_user='gN'，由 handleGroupChat 开头分流进入；
// 全局群路径 handleGroupChat 原逻辑不动）。链路对齐全局群：敏感词已在入口过滤 → 成员校验 → 落库（to_user=gN，
// msg_type=1 不变）→ 按成员定向广播 → 在线成员会话摘要更新 → 离线成员入队
func (s *Server) handleMultiGroupChat(c *Client, msg *protocol.Message, groupID uint) {
	// 成员校验：非成员不可在群内发言
	if !isGroupMember(groupID, c.username) {
		s.sendError(c, "你不是该群成员，无法发送消息")
		return
	}

	msg.MsgType = protocol.MsgTypeGroupChat
	msg.FromUser = c.username
	// 阶段八十五：群聊帧携带发送者昵称（与全局群同规则，服务端归口）
	msg.FromName = nicknameOf(c.username)
	// ToUser 保持 'gN'：前端按 target 归口渲染，历史/会话清空按 to_user 参数化过滤
	msg.Timestamp = time.Now().Unix()

	// 持久化到 MySQL，回填消息唯一 ID
	record := model.Message{
		MsgType:  int8(msg.MsgType),
		FromUser: msg.FromUser,
		ToUser:   msg.ToUser,
		Content:  msg.Content,
	}
	store.DB.Create(&record)
	msg.MsgID = record.ID

	data, _ := json.Marshal(msg)
	memberIDs := getGroupMemberIDs(groupID)
	s.sendToGroupMembers(memberIDs, data)

	// 在线成员会话摘要更新并推送；离线成员入离线队列（按成员过滤，优于全局群全表扫描）
	summary := messageSummary(msg.Content)
	target := groupTargetOf(groupID)
	for _, name := range memberIDs {
		if s.isOnline(name) {
			s.touchConversation(name, target, summary)
			s.notifyConvUpdate(name)
		} else if name != c.username {
			s.queueOffline(name, msg)
		}
	}
}
