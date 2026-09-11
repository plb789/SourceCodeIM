package server

// ===== 阶段七十八：后台用户积分管理 =====
// GET /admin/api/users                     用户列表（含积分余额，后台用户管理数据源）
// PUT /admin/api/users/{username}/points   调整用户积分（绝对值设置，充值/纠正归口）
// 积分本身由 AI 问答链路扣减（aipoints.go），后台只做查询与人工调整，不做任何 AI 计算

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"im-server/model"
	"im-server/store"
)

// handleAdminUserList GET /admin/api/users 用户列表（用户名/昵称/角色/积分/注册时间）
func (s *Server) handleAdminUserList(w http.ResponseWriter, r *http.Request) {
	var users []model.User
	if err := store.DB.Select("id", "username", "nickname", "role", "points", "create_time").
		Order("create_time ASC").Find(&users).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询用户列表失败")
		return
	}
	type userRow struct {
		ID         uint    `json:"id"`
		Username   string  `json:"username"`
		Nickname   string  `json:"nickname"`
		Role       int8    `json:"role"`
		Points     float64 `json:"points"`
		CreateTime string  `json:"create_time"`
	}
	rows := make([]userRow, 0, len(users))
	for _, u := range users {
		rows = append(rows, userRow{
			ID:         u.ID,
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
// 请求体 {"points": 100}：绝对值设置（>=0，支持小数如 12.5，服务端四舍五入到 2 位小数），
// 充值/纠正均走此归口；
// 阶段七十八：调整写入积分流水（记录变动量与操作管理员）
func (s *Server) handleAdminUserPointsPut(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	username = strings.TrimSpace(username)
	if username == "" {
		adminFail(w, http.StatusBadRequest, "用户名不能为空")
		return
	}
	var body struct {
		Points *float64 `json:"points"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Points == nil {
		adminFail(w, http.StatusBadRequest, "参数错误：需要 points 字段")
		return
	}
	if *body.Points < 0 {
		adminFail(w, http.StatusBadRequest, "积分不能为负数")
		return
	}
	// 双精度归口：服务端统一四舍五入到 2 位小数（防管理员传任意精度导致流水对账困难）
	pts := math.Round(*body.Points*100) / 100
	// 先取旧余额用于计算流水变动量（用户不存在时此处即报错，避免误写调整流水）
	var old model.User
	if err := store.DB.Select("username", "points").Where("username = ?", username).First(&old).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Update("points", pts).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "积分更新失败")
		return
	}
	// 阶段七十八：调整流水审计（变动量 = 新 - 旧，记录操作管理员；金额均为双精度）
	recordPointsLog(username, pts-old.Points, pts, "admin_adjust",
		adminUserFromCtx(r), fmt.Sprintf("管理员手动调整积分：%s → %s", fmtF2(old.Points), fmtF2(pts)))
	adminJSON(w, map[string]interface{}{"ok": true, "username": username, "points": pts})
}

// pointsTimeFilter 阶段七十八：解析 start/end 时间范围参数并附加到查询（流水查询与导出共用，口径一致）。
// 支持三种格式：纯日期 / 日期+时分 / 日期+时分秒；end 为纯日期时按当天 23:59:59 收口（闭区间）；
// 格式非法回 400（防静默忽略导致管理员误以为已按时间过滤）
func pointsTimeFilter(w http.ResponseWriter, r *http.Request, db *gorm.DB) (*gorm.DB, bool) {
	q := r.URL.Query()
	startStr := strings.TrimSpace(q.Get("start"))
	endStr := strings.TrimSpace(q.Get("end"))
	if startStr == "" && endStr == "" {
		return db, true
	}
	layouts := []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"}
	parse := func(s string) (time.Time, bool) {
		for _, l := range layouts {
			if t, err := time.ParseInLocation(l, s, time.Local); err == nil {
				return t, true
			}
		}
		return time.Time{}, false
	}
	if startStr != "" {
		t, ok := parse(startStr)
		if !ok {
			adminFail(w, http.StatusBadRequest, "start 时间格式错误，支持 2026-01-02 或 2026-01-02 15:04")
			return db, false
		}
		db = db.Where("create_time >= ?", t)
	}
	if endStr != "" {
		t, ok := parse(endStr)
		if !ok {
			adminFail(w, http.StatusBadRequest, "end 时间格式错误，支持 2026-01-02 或 2026-01-02 15:04")
			return db, false
		}
		if len(endStr) == 10 {
			t = t.AddDate(0, 0, 1).Add(-time.Second) // 纯日期按当天末秒收口
		}
		db = db.Where("create_time <= ?", t)
	}
	return db, true
}

// pointsUserFilter 阶段七十八：用户 ID 筛选（流水查询与导出共用）。
// 流水表冗余的是用户名，此处把数字 ID 解析成用户名后按用户名过滤；
// 非正整数/用户不存在均回 400（审计导出宁可显式报错，不给静默空结果）
func pointsUserFilter(w http.ResponseWriter, r *http.Request, db *gorm.DB) (*gorm.DB, bool) {
	idStr := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if idStr == "" {
		return db, true
	}
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil || id == 0 {
		adminFail(w, http.StatusBadRequest, "user_id 必须为正整数")
		return db, false
	}
	var u model.User
	if err := store.DB.Select("id", "username").First(&u, id).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "用户 ID 不存在")
		return db, false
	}
	return db.Where("username = ?", u.Username), true
}

// handleAdminPointsLogsExport GET /admin/api/points/logs/export?username=&user_id=&reason=&start=&end=
// 导出当前筛选条件下全部流水（CSV，UTF-8 BOM 便于 Excel 直接打开中文）。
// 设计归口：文件由服务端流式生成（keyset 分批读取，无行数上限、内存占用恒定）；
// 导出列与后台流水表格一致，类型导出为中文标签
func (s *Server) handleAdminPointsLogsExport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	username := strings.TrimSpace(q.Get("username"))
	reason := strings.TrimSpace(q.Get("reason"))

	db := store.DB.Model(&model.PointsLog{})
	if username != "" {
		db = db.Where("username = ?", username)
	}
	if reason != "" {
		db = db.Where("reason = ?", reason)
	}
	// 阶段七十八：用户 ID 筛选（与用户名筛选互斥使用，同时传以先解析出的用户为准叠加）
	db, ok := pointsUserFilter(w, r, db)
	if !ok {
		return
	}
	// 阶段七十八：时间范围筛选（与流水查询共用，导出范围 = 当前筛选条件）
	db, ok = pointsTimeFilter(w, r, db)
	if !ok {
		return
	}

	const batch = 1000
	exportRow := func(l model.PointsLog) []string {
		return []string{
			l.CreateTime.Format("2006-01-02 15:04:05"),
			csvSafe(l.Username),
			pointsReasonText(l.Reason),
			fmtF3(l.Change),
			fmtF3(l.BalanceAfter),
			csvSafe(l.Operator),
			csvSafe(l.Detail),
		}
	}

	// 首批先查：建表失败等错误仍可返回 JSON 错误（响应头未写出）
	lastID := int64(0)
	var logs []model.PointsLog
	if err := db.Where("id > ?", lastID).Order("id ASC").Limit(batch).Find(&logs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "流水导出失败")
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	// RFC 5987：中文文件名走 filename* 编码，filename 提供 ASCII 降级
	w.Header().Set("Content-Disposition", `attachment; filename="points_logs.csv"; filename*=UTF-8''`+
		url.PathEscape("积分流水_"+time.Now().Format("20060102_150405")+".csv"))

	w.WriteHeader(http.StatusOK)
	// UTF-8 BOM：Excel 识别中文表头/内容的兜底
	_, _ = w.Write([]byte("\uFEFF"))
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"时间", "用户", "类型", "变动", "变动后余额", "操作人", "说明"})
	for {
		for _, l := range logs {
			lastID = l.ID
			_ = cw.Write(exportRow(l))
		}
		if len(logs) < batch {
			break // 末批不满页：导出完成
		}
		logs = logs[:0]
		if err := db.Where("id > ?", lastID).Order("id ASC").Limit(batch).Find(&logs).Error; err != nil {
			break // 中途失败：已写出的部分保持原样（截断文件），不再写半行
		}
	}
	cw.Flush()
}

// pointsReasonText 流水类型的中文标签（与后台面板展示口径一致）
func pointsReasonText(reason string) string {
	switch reason {
	case "ai_deduct":
		return "AI 问答扣除"
	case "admin_adjust":
		return "管理员调整"
	case "register_grant":
		return "注册赠送"
	default:
		return reason
	}
}

// fmtF2 余额类展示：浮点保留 2 位小数并去掉多余的尾零（95 → "95"，12.5 → "12.5"）
func fmtF2(v float64) string {
	return strconv.FormatFloat(math.Round(v*100)/100, 'f', -1, 64)
}

// fmtF3 变动/余额 CSV 导出：保留 3 位小数并去尾零（-4.506 → "-4.506"，95 → "95"）
func fmtF3(v float64) string {
	return strconv.FormatFloat(math.Round(v*1000)/1000, 'f', -1, 64)
}

// csvSafe CSV 公式注入防护：以 = + @ 开头（及含制表/换行）的单元格前加单引号，
// 防 Excel 打开导出文件时执行公式（用户名/说明等来自用户可编辑数据）
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	if strings.HasPrefix(s, "=") || strings.HasPrefix(s, "+") || strings.HasPrefix(s, "@") ||
		strings.ContainsAny(s, "\t\r\n") {
		return "'" + s
	}
	return s
}

// handleAdminPointsLogs GET /admin/api/points/logs?username=&reason=&page=&page_size=
// 积分流水分页查询（按时间倒序）；username/reason 可选过滤
func (s *Server) handleAdminPointsLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	username := strings.TrimSpace(q.Get("username"))
	reason := strings.TrimSpace(q.Get("reason"))
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(q.Get("page_size"))
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100 // 上限防拉全表
	}

	db := store.DB.Model(&model.PointsLog{})
	if username != "" {
		db = db.Where("username = ?", username)
	}
	if reason != "" {
		db = db.Where("reason = ?", reason)
	}
	// 阶段七十八：用户 ID 筛选（解析为用户名后过滤，口径与导出一致）
	db, ok := pointsUserFilter(w, r, db)
	if !ok {
		return
	}
	// 阶段七十八：时间范围筛选（查询与导出共用同一口径，所见即所导）
	db, ok = pointsTimeFilter(w, r, db)
	if !ok {
		return
	}
	var total int64
	if err := db.Count(&total).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "流水统计失败")
		return
	}
	var logs []model.PointsLog
	if err := db.Order("id DESC").Offset((page - 1) * pageSize).Limit(pageSize).Find(&logs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "流水查询失败")
		return
	}
	type logRow struct {
		ID           int64   `json:"id"`
		Username     string  `json:"username"`
		Change       float64 `json:"change"`
		BalanceAfter float64 `json:"balance_after"`
		Reason       string  `json:"reason"`
		Operator     string  `json:"operator"`
		Detail       string  `json:"detail"`
		CreateTime   string  `json:"create_time"`
	}
	rows := make([]logRow, 0, len(logs))
	for _, l := range logs {
		rows = append(rows, logRow{
			ID:           l.ID,
			Username:     l.Username,
			Change:       l.Change,
			BalanceAfter: l.BalanceAfter,
			Reason:       l.Reason,
			Operator:     l.Operator,
			Detail:       l.Detail,
			CreateTime:   l.CreateTime.Format("2006-01-02 15:04:05"),
		})
	}
	adminJSON(w, map[string]interface{}{
		"logs":      rows,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}
