package server

import (
	"encoding/json"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ProfileInfo 个人资料（阶段三十：微信式资料面板/资料卡归口数据）
// 自己：PROFILE_UPDATE 落库后回推本人全部连接（多端同步）；他人：PROFILE_QUERY 查询响应（好友携带备注）
type ProfileInfo struct {
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	Gender    int8   `json:"gender"` // 0未知 1男 2女
	Region    string `json:"region"`
	Signature string `json:"signature"`
	Avatar    string `json:"avatar"`
	IsFriend  bool   `json:"is_friend"` // 查询者与目标是否好友（自己为 false）
	Remark    string `json:"remark"`    // 查询者给目标设置的备注名（非好友为空）
}

// profileUpdateReq 个人资料更新请求（content JSON，仅允许修改这四个字段，用户名/头像走原有通道）
type profileUpdateReq struct {
	Nickname  string `json:"nickname"`
	Gender    int8   `json:"gender"`
	Region    string `json:"region"`
	Signature string `json:"signature"`
}

// sendProfileResp 向指定连接下发个人资料响应（content 为 ProfileInfo JSON）
func (s *Server) sendProfileResp(c *Client, info ProfileInfo) {
	content, _ := json.Marshal(info)
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeProfileResp,
		ToUser:    c.username, // 响应归属人（多端区分）
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	c.send(data)
}

// buildProfileInfo 查询目标用户资料并按查询者视角组装（好友关系与备注服务端归口，防前端伪造）
func (s *Server) buildProfileInfo(viewer, target string) (ProfileInfo, bool) {
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		return ProfileInfo{}, false
	}
	info := ProfileInfo{
		Username:  u.Username,
		Nickname:  u.Nickname,
		Gender:    u.Gender,
		Region:    u.Region,
		Signature: u.Signature,
		Avatar:    u.Avatar,
	}
	if viewer != target {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			info.IsFriend = true
			info.Remark = f.Remark
		}
	}
	return info, true
}

// handleProfileUpdate 处理个人资料更新：校验后落库并回推本人全部连接（多端同步）
// 原实现：无个人资料概念，点击头像直接弹文件选择换图
func (s *Server) handleProfileUpdate(c *Client, msg *protocol.Message) {
	var req profileUpdateReq
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		s.sendError(c, "资料格式错误")
		return
	}
	// 性别合法性校验：仅允许 0未知 1男 2女
	if req.Gender < 0 || req.Gender > 2 {
		s.sendError(c, "性别参数无效")
		return
	}
	// 长度截断（与数据库字段宽度一致，超长直接拒绝更直观）
	if len(req.Nickname) > 32*3 || len(req.Region) > 64*3 || len(req.Signature) > 128*3 {
		s.sendError(c, "资料内容过长")
		return
	}

	updates := map[string]interface{}{
		"nickname":  req.Nickname,
		"gender":    req.Gender,
		"region":    req.Region,
		"signature": req.Signature,
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", c.username).Updates(updates).Error; err != nil {
		s.sendError(c, "资料保存失败")
		return
	}
	// 阶段八十五：昵称缓存失效（群聊帧/历史帧下发用），下次读取回源取新昵称
	nickCache.Delete(c.username)

	// 回推本人全部在线连接（多端同步），is_friend/remark 对自己无意义固定零值
	info, ok := s.buildProfileInfo(c.username, c.username)
	if !ok {
		s.sendError(c, "资料读取失败")
		return
	}
	for _, cc := range s.hub.GetAll(c.username) {
		s.sendProfileResp(cc, info)
	}
	s.sendError(c, "资料已保存")
	logger.Info("用户 %s 更新个人资料：昵称=%s 性别=%d 地区=%s", c.username, info.Nickname, info.Gender, info.Region)
}

// handleProfileQuery 处理个人资料查询：返回目标用户资料（好友携带备注，服务端归口）
// 原实现：点击好友头像无资料卡，仅右键菜单可设置备注
func (s *Server) handleProfileQuery(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		s.sendError(c, "查询目标无效")
		return
	}
	info, ok := s.buildProfileInfo(c.username, msg.ToUser)
	if !ok {
		s.sendError(c, "用户不存在")
		return
	}
	s.sendProfileResp(c, info)
}
