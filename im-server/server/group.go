package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
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

// resolveGroupUploadScope 群图片/文件上传的群作用域解析——
// group 参数为空=全局群（已废弃，拒绝）；非空=多群聊（校验群存在 + 上传者是成员）。
// 返回（是否多群, 错误信息）
func resolveGroupUploadScope(groupParam, username string) (bool, string) {
	if groupParam == "" {
		// 容量优化 E8 前置：全局群路径废弃，媒体消息（图片/文件/网盘转存）同样不再支持空群参数
		return false, "全局群聊已废弃，请在群聊中发送"
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
// 集群化批量归口：在线判定全局化（跨实例连接仍判在线，投递经总线跨实例送达）、
// 离线批量入队、会话去抖推送一条信封覆盖全部在线成员
func (s *Server) broadcastGroupMediaNotice(notice *protocol.Message, summary string) {
	groupID := groupIDFromTarget(notice.ToUser)
	memberIDs := getGroupMemberIDs(groupID)
	data, _ := json.Marshal(notice)
	s.sendToGroupMembers(memberIDs, data)

	// 在线/离线分流（发送者自身不入离线队列，与群聊文字消息行为一致）
	onlineMembers := make([]string, 0, len(memberIDs))
	offlineMembers := make([]string, 0, len(memberIDs))
	for _, name := range memberIDs {
		if name != notice.FromUser && !s.isOnlineFast(name) {
			offlineMembers = append(offlineMembers, name)
		} else {
			onlineMembers = append(onlineMembers, name)
		}
	}
	s.queueOfflineBatch(offlineMembers, notice)

	// 在线成员会话摘要标脏去抖（E8：不落库不阻塞，50ms 窗口合并多 worker 批写；带消息 ID 供删除水位）+
	// 会话列表去抖推送（离线成员登录时按 to_user 拉取群历史，摘要行入群时已创建）
	s.touchConversationMarkDirtyBatch(onlineMembers, notice.ToUser, summary, notice.MsgID)
	s.notifyConvUpdateBatch(onlineMembers)
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

// groupMembersCache 群成员名单进程内缓存（并发优化 E6）：群消息 fanout/撤回/红包/会议/网盘
// 共 14 个读点每条消息都要成员名单，千人群每条消息一次成员表 Pluck。进程内命中零 RTT，
// 优于 Redis 直存（每消息一次网络往返）；TTL 5min 兜底 + 变更即失效（本实例 + 集群事件），
// 成员变更后其他实例的名单经 invGroupMembers 广播即时失效，正确性与直查一致
type groupMembersEntry struct {
	ids    []string
	expire time.Time
}

var groupMembersCache sync.Map // groupID(uint) → *groupMembersEntry

const groupMembersTTL = 5 * time.Minute

// getGroupMemberIDs 查询群全部成员用户名（E6 缓存归口；返回副本——调用方可能就地 append，
// 共享底层切片会污染缓存）
func getGroupMemberIDs(groupID uint) []string {
	if v, ok := groupMembersCache.Load(groupID); ok {
		e := v.(*groupMembersEntry)
		if time.Now().Before(e.expire) {
			out := make([]string, len(e.ids))
			copy(out, e.ids)
			return out
		}
	}
	var ids []string
	store.DB.Model(&model.GroupMember{}).Where("group_id = ?", groupID).Order("role asc, id asc").Pluck("user_id", &ids)
	groupMembersCache.Store(groupID, &groupMembersEntry{ids: ids, expire: time.Now().Add(groupMembersTTL)})
	out := make([]string, len(ids))
	copy(out, ids)
	return out
}

// myGroupTargets 查询用户所在全部群的会话目标列表（'gN'）——搜索可见性归口用。
// 解散群聊已删成员行与群行（handleGroupDissolve），按成员表直查即为有效群集合
func myGroupTargets(username string) []string {
	var gids []uint
	store.DB.Model(&model.GroupMember{}).Where("user_id = ?", username).Pluck("group_id", &gids)
	targets := make([]string, 0, len(gids))
	for _, gid := range gids {
		targets = append(targets, groupTargetOf(gid))
	}
	return targets
}

// invalidateGroupMembersCache 群成员名单失效归口（成员表任何写操作后调用）：
// 本实例立即失效 + 集群模式广播 invGroupMembers（各实例删除同 key），跨实例名单即时一致
func invalidateGroupMembersCache(groupID uint) {
	groupMembersCache.Delete(groupID)
	if s := defaultServer(); s != nil && s.hub.bus != nil {
		s.hub.bus.publish(&busEnvelope{
			Kind:    busKindInvalidate,
			InvKind: invGroupMembers,
			Targets: []string{strconv.FormatUint(uint64(groupID), 10)},
		})
	}
}

// groupMemberCount 群成员数
func groupMemberCount(groupID uint) int64 {
	var count int64
	store.DB.Model(&model.GroupMember{}).Where("group_id = ?", groupID).Count(&count)
	return count
}

// sendToGroupMembers 向指定成员集合的全部在线连接定向发送（多端同步；替代全员广播的成员过滤原语，
// 全局群路径仍走 hub.Broadcast 不变）
// 集群批量归口：一次总线定向信封覆盖全部成员（原逐成员 sendToUser = 千人群每条消息 N 次 PUBLISH → 1 次）
func (s *Server) sendToGroupMembers(memberIDs []string, data []byte) {
	s.sendToUsers(memberIDs, data)
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
	Action      string            `json:"action"`          // create=群聊已创建 / join=新成员加入 / reject=邀请被拒绝（仅邀请人收）/ kick=被移出群聊 / leave=已退出群聊（阶段一百四十三）/ transfer=群主已转让（阶段二百六十四，users=新群主）/ dissolve=群聊已解散（阶段二百六十四，带群名）/ role=管理员任命或罢免（阶段二百六十七，users=被操作者含新角色）
	Users       []GroupMemberInfo `json:"users,omitempty"` // action=join 时为新成员；action=reject 时为被拒绝对象；action=transfer 时为新群主；action=role 时为被操作成员
	MemberCount int               `json:"member_count"`
	Name        string            `json:"name,omitempty"` // 阶段一百四十三：群名（kick/leave/dissolve 提示语归口服务端下发，避免前端离线期数据缺失）
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
	invalidateGroupMembersCache(group.ID) // E6：新群名单入缓存前先清（幂等防握手期脏读）

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

// handleGroupInvite 处理邀请入群（阶段二百六十五：全员可邀请，原一期仅群主）：邀请人须为群成员（服务端归口校验）→
// 校验被邀请人非成员/无在途邀请 → 写 im_group_invite(Status=0，FromUser=实际邀请人) →
// 被邀请人在线推 75；离线由登录补推兜底（与好友申请同款，不入离线队列防重复）；
// 拒绝回执（77 reject）天然推给实际邀请人，群主/普通成员链路同构
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
	// 阶段二百六十五：全员可邀请——邀请人须为本群成员（服务端归口，防非成员/已退群者发起）
	if !isGroupMember(group.ID, c.username) {
		s.sendError(c, "你不是该群成员，无法邀请")
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
		invalidateGroupMembersCache(group.ID) // E6：新成员入群，名单即时失效（本实例 + 集群）
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

// groupActorRole 查询用户在群内的角色（0=非成员；1 群主 2 成员 3 管理员，阶段二百六十七）
func groupActorRole(groupID uint, username string) int8 {
	var m model.GroupMember
	if err := store.DB.Where("group_id = ? AND user_id = ?", groupID, username).First(&m).Error; err != nil {
		return 0
	}
	return m.Role
}

// handleGroupSetting 处理群设置修改（78，群主/管理员，阶段二百六十七放宽）：群名/公告校验（长度+敏感词，与建群同口径）→
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
	if role := groupActorRole(p.GroupID, c.username); role != 1 && role != 3 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSettingResp, p.GroupID, false, "仅群主和管理员可修改群设置")
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

// handleGroupKick 处理移出成员（80，群主/管理员，阶段二百六十七放宽）：校验目标在群且非自己；
// 管理员仅可移出普通成员（不可动群主/其他管理员）→ 删成员行 + 删其会话行
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
	actorRole := groupActorRole(p.GroupID, c.username)
	if actorRole != 1 && actorRole != 3 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "仅群主和管理员可移出成员")
		return
	}
	if p.Member == c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "不能移出自己")
		return
	}
	if actorRole == 3 {
		// 阶段二百六十七：管理员只能移出普通成员，群主与其他管理员不可动
		var target model.GroupMember
		if err := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, p.Member).First(&target).Error; err != nil || target.Role != 2 {
			s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "管理员仅可移出普通成员")
			return
		}
	}
	res := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, p.Member).Delete(&model.GroupMember{})
	if res.Error != nil || res.RowsAffected == 0 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupKickResp, p.GroupID, false, "该用户不是群成员")
		return
	}
	invalidateGroupMembersCache(p.GroupID) // E6：成员被移出，名单即时失效（本实例 + 集群）
	// 被踢者会话行删除（target=gN）
	target := groupTargetOf(p.GroupID)
	// E8：带删除水位丢弃——群消息 persistMessage 已回填消息 ID，水位拦截乱序写入
	//（摘要标脏晚于本删除帧到达时，靠水位拦截删除前历史摘要写回，防删行后被 flush 复活）
	touchDiscardWatermarked(p.Member, target, convMaxMsgID(p.Member, target))
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

// handleGroupQuit 处理退出群聊（82）：群主不可退（出口：转让/解散，阶段二百六十四），
// 普通成员/管理员退群 → 删成员行 + 删自己的会话行 → 回执 83 + 退群者推 77 leave + 其余成员 73 同步刷新
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
		s.sendGroupOkResp(c, protocol.MsgTypeGroupQuitResp, p.GroupID, false, "群主不可直接退出群聊，请先转让群主或解散群聊")
		return
	}
	res := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, c.username).Delete(&model.GroupMember{})
	if res.Error != nil || res.RowsAffected == 0 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupQuitResp, p.GroupID, false, "你不是群成员")
		return
	}
	invalidateGroupMembersCache(p.GroupID) // E6：退群，名单即时失效（本实例 + 集群）
	target := groupTargetOf(p.GroupID)
	// E8：带删除水位丢弃（与被踢同语义：水位拦截窗口内乱序摘要写回）
	touchDiscardWatermarked(c.username, target, convMaxMsgID(c.username, target))
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

// ===== 阶段二百六十七：群管理员角色体系（微信同款 Role=3 管理员：日常管理权下放，任命/罢免仍群主专属） =====
// Role 语义：1 群主 / 2 成员 / 3 管理员；管理员可改群名公告（78）、移出普通成员（80），
// 任命/罢免管理员（102）、转让群主（98）、解散群聊（100）仍归群主专属

// groupSetRolePayload 102 任命/罢免管理员载荷
type groupSetRolePayload struct {
	GroupID uint   `json:"group_id"`
	Member  string `json:"member"`
	Admin   bool   `json:"admin"` // true=设为管理员（Role 2→3）false=取消管理员（Role 3→2）
}

// handleGroupSetRole 处理任命/罢免管理员（102，仅群主）：校验目标为在群成员且非自己，
// admin=true 须目标为普通成员、false 须目标为管理员 → 写库 → 回执 103 +
// 全员 77 action=role（users=被操作者含新角色）+ 73 全量同步归口刷新
func (s *Server) handleGroupSetRole(c *Client, msg *protocol.Message) {
	var p groupSetRolePayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.GroupID == 0 {
		s.sendError(c, "参数格式错误")
		return
	}
	p.Member = strings.TrimSpace(p.Member)
	if p.Member == "" {
		s.sendError(c, "请选择要设置的成员")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", p.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	if group.OwnerID != c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, "仅群主可设置管理员")
		return
	}
	if p.Member == c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, "不能设置自己")
		return
	}
	var target model.GroupMember
	if err := store.DB.Where("group_id = ? AND user_id = ?", p.GroupID, p.Member).First(&target).Error; err != nil {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, "该用户不是群成员")
		return
	}
	if p.Admin {
		if target.Role != 2 {
			hint := "该成员已是管理员"
			if target.Role == 1 {
				hint = "群主无需设置"
			}
			s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, hint)
			return
		}
	} else if target.Role != 3 {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, "该成员不是管理员")
		return
	}
	newRole := int8(2)
	if p.Admin {
		newRole = 3
	}
	if err := store.DB.Model(&model.GroupMember{}).Where("group_id = ? AND user_id = ?", p.GroupID, p.Member).Update("role", newRole).Error; err != nil {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, false, "保存失败，请稍后重试")
		logger.Error("设置群管理员写库失败：群 %d %v", p.GroupID, err)
		return
	}
	logger.Info("群管理员变更：群 %d「%s」%s 由 %s 设置 role=%d", p.GroupID, group.Name, p.Member, c.username, newRole)
	invalidateGroupMembersCache(p.GroupID) // E6：角色变更，名单（按 role 排序）即时失效（本实例 + 集群），与转让/踢人同惯例

	// 回执 + 全员 77 role（被操作者含新角色，前端据此提示与归位）+ 73 全量同步
	s.sendGroupOkResp(c, protocol.MsgTypeGroupSetRoleResp, p.GroupID, true, "")
	var u model.User
	store.DB.Where("username = ?", p.Member).First(&u)
	s.pushGroupMemberNotice(getGroupMemberIDs(p.GroupID), groupMemberNoticePayload{
		GroupID: p.GroupID,
		Action:  "role",
		Users: []GroupMemberInfo{{
			Username: p.Member,
			Name:     nicknameOf(p.Member),
			Role:     newRole,
			Avatar:   u.Avatar,
		}},
		Name: group.Name,
	})
	s.notifyGroupListSync(getGroupMemberIDs(p.GroupID))
}

// ===== 阶段二百六十四：群主转让与解散群聊（微信同款群管理闭环，收尾 82/83 遗留的群主出口） =====

// groupTransferPayload 98 转让群主载荷
type groupTransferPayload struct {
	GroupID uint   `json:"group_id"`
	To      string `json:"to"`
}

// handleGroupTransfer 处理群主转让（98，仅群主）：校验目标为在群成员且非自己 →
// 群主字段与成员角色同步翻转（新群主 Role=1、原群主降为 Role=2）→ 名单缓存失效 →
// 回执 99 + 全员 77 action=transfer（users=新群主，提示归口）+ 全员 73 全量同步归口
// （owner/角色随 73 刷新，前端群管理入口/邀请按钮/退出按钮显隐自动归位）
func (s *Server) handleGroupTransfer(c *Client, msg *protocol.Message) {
	var p groupTransferPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.GroupID == 0 {
		s.sendError(c, "参数格式错误")
		return
	}
	p.To = strings.TrimSpace(p.To)
	if p.To == "" {
		s.sendError(c, "请选择新群主")
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", p.GroupID).First(&group).Error; err != nil {
		s.sendError(c, "群不存在")
		return
	}
	if group.OwnerID != c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupTransferResp, p.GroupID, false, "仅群主可转让群主")
		return
	}
	if p.To == c.username {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupTransferResp, p.GroupID, false, "不能转让给自己")
		return
	}
	if !isGroupMember(p.GroupID, p.To) {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupTransferResp, p.GroupID, false, "该用户不是群成员")
		return
	}
	// 群主字段写库（角色翻转紧随其后；任一写库失败即回执失败，下次转让可重试归位）
	if err := store.DB.Model(&model.Group{}).Where("id = ?", p.GroupID).Update("owner_id", p.To).Error; err != nil {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupTransferResp, p.GroupID, false, "转让失败，请稍后重试")
		logger.Error("群主转让写库失败：群 %d %v", p.GroupID, err)
		return
	}
	store.DB.Model(&model.GroupMember{}).Where("group_id = ? AND user_id = ?", p.GroupID, p.To).Update("role", 1)
	store.DB.Model(&model.GroupMember{}).Where("group_id = ? AND user_id = ?", p.GroupID, c.username).Update("role", 2)
	invalidateGroupMembersCache(p.GroupID) // E6：角色翻转，名单（含 role 排序）即时失效（本实例 + 集群）
	logger.Info("群主转让：群 %d「%s」群主 %s → %s", p.GroupID, group.Name, c.username, p.To)

	// 全员 77 transfer（users=新群主，前端提示归口）+ 73 全量同步（owner/角色归口刷新）
	memberIDs := getGroupMemberIDs(p.GroupID)
	s.pushGroupMemberNotice(memberIDs, groupMemberNoticePayload{
		GroupID:     p.GroupID,
		Action:      "transfer",
		Users:       []GroupMemberInfo{{Username: p.To, Name: nicknameOf(p.To), Role: 1}},
		MemberCount: len(memberIDs),
	})
	s.notifyGroupListSync(memberIDs)
	s.sendGroupOkResp(c, protocol.MsgTypeGroupTransferResp, p.GroupID, true, "")
}

// groupDissolvePayload 100 解散群聊载荷
type groupDissolvePayload struct {
	GroupID uint `json:"group_id"`
}

// handleGroupDissolve 处理解散群聊（100，仅群主）：全员会话行删除（含删除水位防摘要 flush 复活）→
// 在途邀请清理（防登录补推死邀请）→ 成员行/群行删除 + 名单缓存失效 →
// 回执 101 + 全员 77 action=dissolve（带群名，客户端清会话并提示）。
// 群历史消息行保留（与被踢/退群同口径：仅删会话入口，不物理清消息）
func (s *Server) handleGroupDissolve(c *Client, msg *protocol.Message) {
	var p groupDissolvePayload
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
		s.sendGroupOkResp(c, protocol.MsgTypeGroupDissolveResp, p.GroupID, false, "仅群主可解散群聊")
		return
	}

	target := groupTargetOf(p.GroupID)
	memberIDs := getGroupMemberIDs(p.GroupID)
	// 全员会话行删除 + 逐成员删除水位（E8：与被踢/退群同语义——摘要标脏晚于删除帧到达时，
	// 靠水位拦截删除前历史摘要写回，防删行后被 flush 复活）
	for _, name := range memberIDs {
		touchDiscardWatermarked(name, target, convMaxMsgID(name, target))
	}
	store.DB.Where("target = ?", target).Delete(&model.Conversation{})
	// 在途邀请清理（Status=0）：pushPendingGroupInvites 虽有群缺位兜底，归口直清更干净
	store.DB.Where("group_id = ? AND status = 0", p.GroupID).Delete(&model.GroupInvite{})
	// 成员行 + 群行删除
	store.DB.Where("group_id = ?", p.GroupID).Delete(&model.GroupMember{})
	if err := store.DB.Delete(&model.Group{}, p.GroupID).Error; err != nil {
		s.sendGroupOkResp(c, protocol.MsgTypeGroupDissolveResp, p.GroupID, false, "解散失败，请稍后重试")
		logger.Error("群解散写库失败：群 %d %v", p.GroupID, err)
		return
	}
	invalidateGroupMembersCache(p.GroupID) // E6：群已解散，名单即时失效（本实例 + 集群）
	logger.Info("解散群聊：群 %d「%s」群主 %s 解散，成员 %v 会话清理完成", p.GroupID, group.Name, c.username, memberIDs)

	// 全员 77 dissolve（带群名，客户端清会话并提示；含操作者多端同步）
	s.pushGroupMemberNotice(memberIDs, groupMemberNoticePayload{
		GroupID: p.GroupID,
		Action:  "dissolve",
		Name:    group.Name,
	})
	s.sendGroupOkResp(c, protocol.MsgTypeGroupDissolveResp, p.GroupID, true, "")
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
	memberIDs := getGroupMemberIDs(groupID)
	s.sendToGroupMembers(memberIDs, data)

	// 在线成员会话摘要更新并推送；离线成员入离线队列（按成员过滤，优于全局群全表扫描）
	// 并发改造 A4：在线判定改全局判定（isOnlineFast，跨实例连接仍判在线，投递经总线跨实例送达）
	// 并发优化 E8：多群会话摘要标脏去抖——原 A3 同步批写在发送者 readPump 内联等待
	//（千人群每条消息 ~40ms），现逐成员标脏（同 key 50ms 窗口合并），flush 多 worker 批写，
	// 热路径零 DB 操作；带消息 ID 供被踢/退群/清空/删会话的删除水位拦截
	// 集群批量归口：会话去抖推送一条信封覆盖全部在线成员（原逐成员 N 次 PUBLISH → 1 次）、
	// 离线成员 pipeline 一次往返批量入队
	summary := messageSummary(msg.Content)
	target := groupTargetOf(groupID)
	onlineMembers := make([]string, 0, len(memberIDs))
	offlineMembers := make([]string, 0, len(memberIDs))
	for _, name := range memberIDs {
		if s.isOnlineFast(name) {
			onlineMembers = append(onlineMembers, name)
		} else if name != c.username {
			offlineMembers = append(offlineMembers, name)
		}
	}
	s.touchConversationMarkDirtyBatch(onlineMembers, target, summary, record.ID)
	s.notifyConvUpdateBatch(onlineMembers)
	s.queueOfflineBatch(offlineMembers, msg)

	// 阶段二百七十四：纯 URL 文本消息异步抓取网页卡片（OG 元数据落库 + CARD_UPDATE 全群成员
	// 回填帧，主链路零阻塞；离线成员登录后历史加载自带 card 列）
	s.enrichWebCardAsync(&record, target, memberIDs)
}
