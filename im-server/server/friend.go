package server

import (
	"encoding/json"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// FriendInfo 好友信息（用于好友列表同步）
type FriendInfo struct {
	Username string `json:"username"`
	Remark   string `json:"remark"`
	Group    string `json:"group"`
	Online   bool   `json:"online"`
	Avatar   string `json:"avatar"`
}

// handleFriendRequest 处理好友申请
func (s *Server) handleFriendRequest(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" || msg.ToUser == c.username {
		s.sendError(c, "好友申请目标无效")
		return
	}
	// 已是好友则无需申请
	if s.isFriend(c.username, msg.ToUser) {
		s.sendError(c, "对方已是你的好友")
		return
	}

	// 写入申请记录
	req := model.FriendRequest{
		FromUser: c.username,
		ToUser:   msg.ToUser,
		Message:  msg.Content,
		Status:   0,
	}
	if err := store.DB.Create(&req).Error; err != nil {
		s.sendError(c, "好友申请发送失败")
		return
	}

	// 推送给在线接收方
	if target, ok := s.hub.Get(msg.ToUser); ok {
		data, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeFriendRequest,
			FromUser:  c.username,
			ToUser:    msg.ToUser,
			Content:   msg.Content,
			Timestamp: time.Now().Unix(),
		})
		target.send(data)
	}
	s.sendError(c, "好友申请已发送")
	logger.Info("好友申请：%s -> %s", c.username, msg.ToUser)
}

// handleFriendRequestResp 处理好友申请响应（同意/拒绝）
func (s *Server) handleFriendRequestResp(c *Client, msg *protocol.Message) {
	// 查找待处理的申请
	var req model.FriendRequest
	err := store.DB.Where("from_user = ? AND to_user = ? AND status = 0", msg.ToUser, c.username).
		Order("id desc").First(&req).Error
	if err != nil {
		s.sendError(c, "未找到待处理的好友申请")
		return
	}

	if msg.Content == "agree" {
		req.Status = 1
		store.DB.Save(&req)
		// 双向建立好友关系
		s.addFriend(req.FromUser, req.ToUser)
		s.addFriend(req.ToUser, req.FromUser)
		s.sendError(c, "已同意好友申请")
		logger.Info("好友申请同意：%s <-> %s", req.FromUser, req.ToUser)
	} else {
		req.Status = 2
		store.DB.Save(&req)
		s.sendError(c, "已拒绝好友申请")
	}

	// 双方刷新好友列表
	s.refreshFriendList(req.FromUser)
	s.refreshFriendList(req.ToUser)
}

// handleFriendDelete 删除好友
func (s *Server) handleFriendDelete(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		return
	}
	store.DB.Where("(user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
		c.username, msg.ToUser, msg.ToUser, c.username).Delete(&model.Friend{})

	s.refreshFriendList(c.username)
	s.refreshFriendList(msg.ToUser)
	s.sendError(c, "已删除好友")
	logger.Info("删除好友：%s <-> %s", c.username, msg.ToUser)
}

// handleBlacklist 黑名单操作（block/unblock）
func (s *Server) handleBlacklist(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" || msg.ToUser == c.username {
		return
	}
	if msg.Content == "block" {
		// 拉黑前先删除好友关系
		store.DB.Where("(user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)",
			c.username, msg.ToUser, msg.ToUser, c.username).Delete(&model.Friend{})
		// 写入黑名单（不存在则创建）
		var count int64
		store.DB.Model(&model.Blacklist{}).Where("user_id = ? AND blocked_id = ?", c.username, msg.ToUser).Count(&count)
		if count == 0 {
			store.DB.Create(&model.Blacklist{UserID: c.username, BlockedID: msg.ToUser})
		}
		s.sendError(c, "已加入黑名单")
		logger.Info("拉黑：%s -> %s", c.username, msg.ToUser)
	} else if msg.Content == "unblock" {
		store.DB.Where("user_id = ? AND blocked_id = ?", c.username, msg.ToUser).Delete(&model.Blacklist{})
		s.sendError(c, "已移出黑名单")
		logger.Info("取消拉黑：%s -> %s", c.username, msg.ToUser)
	}
	s.refreshFriendList(c.username)
}

// handleFriendUpdate 好友备注/分组更新
func (s *Server) handleFriendUpdate(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		return
	}
	updates := map[string]interface{}{}
	if msg.Remark != "" {
		updates["remark"] = msg.Remark
	}
	if msg.Group != "" {
		updates["group_name"] = msg.Group
	}
	if len(updates) > 0 {
		store.DB.Model(&model.Friend{}).Where("user_id = ? AND friend_id = ?", c.username, msg.ToUser).Updates(updates)
	}
	s.refreshFriendList(c.username)
	s.sendError(c, "好友信息已更新")
}

// isFriend 判断两人是否好友
func (s *Server) isFriend(a, b string) bool {
	var count int64
	store.DB.Model(&model.Friend{}).Where("user_id = ? AND friend_id = ?", a, b).Count(&count)
	return count > 0
}

// addFriend 建立单向好友关系
func (s *Server) addFriend(a, b string) {
	var count int64
	store.DB.Model(&model.Friend{}).Where("user_id = ? AND friend_id = ?", a, b).Count(&count)
	if count == 0 {
		store.DB.Create(&model.Friend{UserID: a, FriendID: b})
	}
}

// isBlocked 判断 a 是否被 b 拉黑，或 b 是否被 a 拉黑（任一方向拉黑即拦截）
func (s *Server) isBlocked(a, b string) bool {
	var count int64
	store.DB.Model(&model.Blacklist{}).
		Where("(user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)", a, b, b, a).
		Count(&count)
	return count > 0
}

// refreshFriendList 向指定在线用户推送好友列表
func (s *Server) refreshFriendList(username string) {
	if c, ok := s.hub.Get(username); ok {
		s.pushFriendList(c)
	}
}

// pushFriendList 查询好友并推送好友列表（含备注、分组、在线状态、头像）
func (s *Server) pushFriendList(c *Client) {
	var friends []model.Friend
	store.DB.Where("user_id = ?", c.username).Find(&friends)

	infos := make([]FriendInfo, 0, len(friends))
	for _, f := range friends {
		var u model.User
		store.DB.Where("username = ?", f.FriendID).First(&u)
		infos = append(infos, FriendInfo{
			Username: f.FriendID,
			Remark:   f.Remark,
			Group:    f.GroupName,
			Online:   s.isOnline(f.FriendID),
			Avatar:   u.Avatar,
		})
	}

	content, _ := json.Marshal(infos)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeFriendList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// pushPendingRequests 推送待处理的好友申请给指定用户
func (s *Server) pushPendingRequests(c *Client) {
	var reqs []model.FriendRequest
	store.DB.Where("to_user = ? AND status = 0", c.username).Find(&reqs)
	for _, r := range reqs {
		data, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeFriendRequest,
			FromUser:  r.FromUser,
			ToUser:    r.ToUser,
			Content:   r.Message,
			Timestamp: r.CreateTime.Unix(),
		})
		c.send(data)
	}
}
