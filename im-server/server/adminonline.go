package server

// ===== 阶段二百二十二：后台在线账号管理 =====
// GET  /admin/api/online        在线连接列表（账号/昵称/IP/登录端/上线时间/账号状态）
// POST /admin/api/online/kick   强制指定账号全部在线连接下线（不封禁，可重新登录）
// 设计归口：
//   1. 在线数据源为 hub 内存连接表（登录成功才入 hub，未登录半开连接不在此列）；
//   2. IP 取 WebSocket 建连时 realClientIP 解析的真实客户端 IP（经 CDN/反代链路，连接对象随建连记录）；
//   3. 登录端标记复用 platformName 归一化（PC/WEB/手机/分享页）；
//   4. 封禁不在本文件实现——复用既有 PUT /admin/api/users/{username}/lock（落库全局生效 +
//      kickUserConnections 即时踢出，在线页前端直接调用同款弹窗与接口）；
//   5. 集群模式边界：本列表仅本实例连接；封禁落库全局生效、跨实例踢出为总线尽力送达
//      （与 kickUserConnections 既有口径一致）。

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// handleAdminOnlineList GET /admin/api/online
// 返回 {ok, data:{conns:[{username,nickname,platform,platform_name,ip,login_time,status,lock_reason}], total}}
// 按上线时间倒序（最新登录在前）；昵称/状态经一次 IN 查询批量补齐（账号可能已封禁仍在线的边缘态也如实展示）
func (s *Server) handleAdminOnlineList(w http.ResponseWriter, r *http.Request) {
	snap := s.hub.Snapshot()
	sort.Slice(snap, func(i, j int) bool { return snap[i].LoginTime.After(snap[j].LoginTime) })

	usernames := make([]string, 0, len(snap))
	seen := map[string]bool{}
	for _, c := range snap {
		if !seen[c.Username] {
			seen[c.Username] = true
			usernames = append(usernames, c.Username)
		}
	}
	type acctInfo struct {
		Nickname   string
		Status     int8
		LockReason string
	}
	accts := map[string]acctInfo{}
	if len(usernames) > 0 {
		var users []model.User
		if err := store.DB.Select("username", "nickname", "status", "lock_reason").
			Where("username IN ?", usernames).Find(&users).Error; err == nil {
			for _, u := range users {
				accts[u.Username] = acctInfo{Nickname: u.Nickname, Status: u.Status, LockReason: u.LockReason}
			}
		}
	}

	conns := make([]map[string]interface{}, 0, len(snap))
	for _, c := range snap {
		a := accts[c.Username]
		conns = append(conns, map[string]interface{}{
			"username":      c.Username,
			"nickname":      a.Nickname,
			"platform":      c.Platform,
			"platform_name": platformName(c.Platform),
			"ip":            c.IP,
			"login_time":    c.LoginTime.Format("2006-01-02 15:04:05"),
			"status":        a.Status,
			"lock_reason":   a.LockReason,
		})
	}
	adminJSON(w, map[string]interface{}{"conns": conns, "total": len(conns)})
}

// handleAdminOnlineKick POST /admin/api/online/kick
// 请求体 {"username":"..."}：强制该账号全部在线连接下线（SendErrorAndClose 下发提示后断开，
// 客户端弹窗提示且不自动重连）；不封禁可重新登录。防自踢与管理员锁定/注销同口径。
func (s *Server) handleAdminOnlineKick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	// 防自踢：管理员不能对自己执行（误操作会把自己踢出后台正在使用的会话）
	if username == adminUserFromCtx(r) {
		adminFail(w, http.StatusBadRequest, "不能对当前登录的管理员账号执行该操作")
		return
	}
	if s.hub.Count(username) == 0 {
		adminFail(w, http.StatusNotFound, "该账号当前不在线")
		return
	}
	s.kickUserConnections(username, "您的账号已被管理员强制下线")
	logger.Info("后台管理：管理员 %s 将账号 %s 强制下线", adminUserFromCtx(r), username)
	adminJSON(w, map[string]interface{}{"username": username})
}
