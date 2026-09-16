package server

// ===== 阶段一百三十四：后台账号管理 =====
// PUT /admin/api/users/{username}/profile   修改账号资料（昵称/性别/地区/个性签名/头像，部分更新：字段缺省=不修改）
// PUT /admin/api/users/{username}/password  重置账号密码（管理员归口，无需旧密码）
// 设计归口：
//   1. 账号数据服务端统一校验与落库（im_user 表），前端仅提交表单；
//   2. 用户名是全库引用主键（消息/会话/好友/积分流水均以 username 关联），不提供改名，保证数据一致性；
//   3. 资料修改复用个人资料链路口径（profile.go）：失效昵称缓存 + 向目标全部在线连接推送
//      PROFILE_RESP 实时同步（多端即时可见，无需重登）；
//   4. 密码复用 hashPassword（SHA256）加密存储；在线会话不受影响（连接级登录态），新密码下次登录生效。

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// handleAdminUserProfilePut PUT /admin/api/users/{username}/profile
// 请求体（指针字段=nil=不修改，与 Agent 设置同款部分更新口径）：
// {"nickname":"...","gender":0,"region":"...","signature":"...","avatar":"..."}
func (s *Server) handleAdminUserProfilePut(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	var req struct {
		Nickname  *string `json:"nickname"`
		Gender    *int8   `json:"gender"`
		Region    *string `json:"region"`
		Signature *string `json:"signature"`
		Avatar    *string `json:"avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 目标用户必须存在（防拼错用户名静默无效）
	var u model.User
	if err := store.DB.Select("id", "username").Where("username = ?", username).First(&u).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	// 逐字段校验并装配（长度上限与 im_user 列宽/个人资料链路口径一致）
	updates := map[string]interface{}{}
	if req.Nickname != nil {
		v := strings.TrimSpace(*req.Nickname)
		if utf8.RuneCountInString(v) > 32 {
			adminFail(w, http.StatusBadRequest, "昵称不能超过 32 个字")
			return
		}
		updates["nickname"] = v
	}
	if req.Gender != nil {
		if *req.Gender < 0 || *req.Gender > 2 {
			adminFail(w, http.StatusBadRequest, "性别取值非法（0未知 1男 2女）")
			return
		}
		updates["gender"] = *req.Gender
	}
	if req.Region != nil {
		v := strings.TrimSpace(*req.Region)
		if utf8.RuneCountInString(v) > 64 {
			adminFail(w, http.StatusBadRequest, "地区不能超过 64 个字")
			return
		}
		updates["region"] = v
	}
	if req.Signature != nil {
		v := strings.TrimSpace(*req.Signature)
		if utf8.RuneCountInString(v) > 128 {
			adminFail(w, http.StatusBadRequest, "个性签名不能超过 128 个字")
			return
		}
		updates["signature"] = v
	}
	if req.Avatar != nil {
		v := strings.TrimSpace(*req.Avatar)
		if utf8.RuneCountInString(v) > 255 {
			adminFail(w, http.StatusBadRequest, "头像地址不能超过 255 个字符")
			return
		}
		updates["avatar"] = v
	}
	if len(updates) == 0 {
		adminFail(w, http.StatusBadRequest, "没有需要修改的字段")
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Updates(updates).Error; err != nil {
		logger.Error("后台修改账号资料失败（%s）: %v", username, err)
		adminFail(w, http.StatusInternalServerError, "账号资料修改失败")
		return
	}
	// 昵称缓存失效（群聊帧/历史帧下发用），下次读取回源取新昵称
	nickCache.Delete(username)
	// 向目标全部在线连接推送最新资料（PROFILE_RESP 与本人改资料同帧同口径，多端实时同步）
	if info, ok := s.buildProfileInfo(username, username); ok {
		for _, cc := range s.hub.GetAll(username) {
			s.sendProfileResp(cc, info)
		}
	}
	logger.Info("后台管理：管理员 %s 修改账号 %s 资料", adminUserFromCtx(r), username)
	adminJSON(w, map[string]interface{}{"ok": true, "username": username})
}

// handleAdminUserPasswordPut PUT /admin/api/users/{username}/password
// 请求体 {"password":"新密码"}：管理员归口重置，无需旧密码（与注册同口径仅要求非空）
func (s *Server) handleAdminUserPasswordPut(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.Password == "" {
		adminFail(w, http.StatusBadRequest, "密码不能为空")
		return
	}
	// 目标用户必须存在
	var u model.User
	if err := store.DB.Select("id", "username").Where("username = ?", username).First(&u).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).
		Update("password", hashPassword(req.Password)).Error; err != nil {
		logger.Error("后台重置账号密码失败（%s）: %v", username, err)
		adminFail(w, http.StatusInternalServerError, "密码重置失败")
		return
	}
	logger.Info("后台管理：管理员 %s 重置账号 %s 密码", adminUserFromCtx(r), username)
	adminJSON(w, map[string]interface{}{"ok": true, "username": username})
}

// userStatusRejectMsg 阶段一百三十五：账号状态登录拦截归口（IM 登录 handleLogin 与后台登录 handleAdminLogin 共用）
// 返回给用户看的拒绝原因（封禁账号提示管理员填写的封禁原因）；空串=正常放行
func userStatusRejectMsg(u *model.User) string {
	switch u.Status {
	case model.UserStatusLocked:
		if reason := strings.TrimSpace(u.LockReason); reason != "" {
			return "账号已被管理员封禁：" + reason
		}
		return "账号已被管理员封禁，请联系管理员"
	case model.UserStatusDeleted:
		return "账号已注销"
	}
	return ""
}

// handleAdminUserLockPut PUT /admin/api/users/{username}/lock
// 请求体 {"locked":true,"reason":"封禁原因"} 锁定封禁（原因必填，登录拒绝时提示用户）；
// {"locked":false} 解锁恢复（清空封禁原因）；锁定即时踢出该账号全部在线连接
func (s *Server) handleAdminUserLockPut(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	var req struct {
		Locked bool   `json:"locked"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 防自锁：管理员不能锁定自己（避免误操作把自己锁在后台外）；注销同口径
	if username == adminUserFromCtx(r) {
		adminFail(w, http.StatusBadRequest, "不能对当前登录的管理员账号执行该操作")
		return
	}
	// 目标用户必须存在且未被注销（注销账号不可再锁定/解锁）
	var u model.User
	if err := store.DB.Select("id", "username", "status").Where("username = ?", username).First(&u).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if u.Status == model.UserStatusDeleted {
		adminFail(w, http.StatusBadRequest, "账号已注销，无法操作")
		return
	}
	if req.Locked {
		reason := strings.TrimSpace(req.Reason)
		if reason == "" {
			adminFail(w, http.StatusBadRequest, "封禁原因不能为空")
			return
		}
		if utf8.RuneCountInString(reason) > 200 {
			adminFail(w, http.StatusBadRequest, "封禁原因不能超过 200 个字")
			return
		}
		if err := store.DB.Model(&model.User{}).Where("username = ?", username).
			Updates(map[string]interface{}{"status": model.UserStatusLocked, "lock_reason": reason}).Error; err != nil {
			logger.Error("后台锁定账号失败（%s）: %v", username, err)
			adminFail(w, http.StatusInternalServerError, "账号锁定失败")
			return
		}
		// 即时踢出全部在线连接（下发封禁原因，客户端弹窗展示后回退登录界面，不自动重连）
		s.kickUserConnections(username, "账号已被管理员封禁："+reason)
		logger.Info("后台管理：管理员 %s 锁定账号 %s（原因：%s）", adminUserFromCtx(r), username, reason)
	} else {
		if err := store.DB.Model(&model.User{}).Where("username = ?", username).
			Updates(map[string]interface{}{"status": model.UserStatusNormal, "lock_reason": ""}).Error; err != nil {
			logger.Error("后台解锁账号失败（%s）: %v", username, err)
			adminFail(w, http.StatusInternalServerError, "账号解锁失败")
			return
		}
		logger.Info("后台管理：管理员 %s 解锁账号 %s", adminUserFromCtx(r), username)
	}
	adminJSON(w, map[string]interface{}{"ok": true, "username": username})
}

// handleAdminUserDeletePut PUT /admin/api/users/{username}/delete
// 阶段一百三十五：删除（注销）账号——软删除归口：status 置 2，用户名继续占用
// （防同名重新注册继承旧好友/消息/积分数据，保证数据一致性），列表不再展示、登录一律拒绝并提示"账号已注销"；
// 历史消息保留（他人会话完整性不受影响），展示侧用户名/头像缺失自动降级为首字母徽标
func (s *Server) handleAdminUserDeletePut(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	// 防自删：管理员不能注销自己（与锁定同口径）
	if username == adminUserFromCtx(r) {
		adminFail(w, http.StatusBadRequest, "不能对当前登录的管理员账号执行该操作")
		return
	}
	var u model.User
	if err := store.DB.Select("id", "username", "status").Where("username = ?", username).First(&u).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if u.Status == model.UserStatusDeleted {
		adminFail(w, http.StatusBadRequest, "账号已注销，请勿重复操作")
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).
		Updates(map[string]interface{}{"status": model.UserStatusDeleted, "lock_reason": ""}).Error; err != nil {
		logger.Error("后台注销账号失败（%s）: %v", username, err)
		adminFail(w, http.StatusInternalServerError, "账号注销失败")
		return
	}
	// 踢出在线连接并告知已注销
	s.kickUserConnections(username, "账号已注销")
	logger.Info("后台管理：管理员 %s 注销账号 %s", adminUserFromCtx(r), username)
	adminJSON(w, map[string]interface{}{"ok": true, "username": username})
}

// kickUserConnections 阶段一百三十五：向指定用户全部在线连接同步下发提示并断开（锁定封禁/注销即时生效）
// 客户端侧约定：1 秒内收到 ERROR 帧后连接关闭视为服务端拒绝（非网络断开），不再自动重连
func (s *Server) kickUserConnections(username, reason string) {
	for _, cc := range s.hub.GetAll(username) {
		cc.SendErrorAndClose(reason)
	}
}
