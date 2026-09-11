package server

// ===== 阶段七十八：后台用户积分管理 =====
// GET /admin/api/users                     用户列表（含积分余额，后台用户管理数据源）
// PUT /admin/api/users/{username}/points   调整用户积分（绝对值设置，充值/纠正归口）
// 积分本身由 AI 问答链路扣减（aipoints.go），后台只做查询与人工调整，不做任何 AI 计算

import (
	"encoding/json"
	"net/http"
	"strings"

	"im-server/model"
	"im-server/store"
)

// handleAdminUserList GET /admin/api/users 用户列表（用户名/昵称/角色/积分/注册时间）
func (s *Server) handleAdminUserList(w http.ResponseWriter, r *http.Request) {
	var users []model.User
	if err := store.DB.Select("username", "nickname", "role", "points", "create_time").
		Order("create_time ASC").Find(&users).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询用户列表失败")
		return
	}
	type userRow struct {
		Username   string `json:"username"`
		Nickname   string `json:"nickname"`
		Role       int8   `json:"role"`
		Points     int    `json:"points"`
		CreateTime string `json:"create_time"`
	}
	rows := make([]userRow, 0, len(users))
	for _, u := range users {
		rows = append(rows, userRow{
			Username:   u.Username,
			Nickname:   u.Nickname,
			Role:       u.Role,
			Points:     u.Points,
			CreateTime: u.CreateTime.Format("2006-01-02 15:04:05"),
		})
	}
	adminJSON(w, map[string]interface{}{"users": rows})
}

// handleAdminUserPointsPut PUT /admin/api/users/{username}/points
// 请求体 {"points": 100}：绝对值设置（>=0），充值/纠正均走此归口
func (s *Server) handleAdminUserPointsPut(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	username = strings.TrimSpace(username)
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	var body struct {
		Points *int `json:"points"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Points == nil {
		adminFail(w, http.StatusBadRequest, "参数错误：需要 points 字段")
		return
	}
	if *body.Points < 0 {
		adminFail(w, http.StatusBadRequest, "积分不能为负数")
		return
	}
	res := store.DB.Model(&model.User{}).Where("username = ?", username).Update("points", *body.Points)
	if res.Error != nil {
		adminFail(w, http.StatusInternalServerError, "积分更新失败")
		return
	}
	if res.RowsAffected == 0 {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true, "username": username, "points": *body.Points})
}
