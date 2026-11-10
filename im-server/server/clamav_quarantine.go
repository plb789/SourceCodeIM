package server

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== ClamAV 隔离库管理（阶段一核心） =====
// 检出病毒后进入隔离库（audit_status=4），等待管理员人工审核确认。
// 管理后台 CRUD 接口：列表（支持筛选）/ 详情 / 通过审核 / 确认病毒驳回 / 清理过期记录

// handleAdminClamavQuarantineList GET /admin/api/security/quarantine/list
func (s *Server) handleAdminClamavQuarantineList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// 子查询：先过滤再 GROUP BY 聚合，得到每个 (game_id, version, quarantined_at) 组的聚合行
	// 用 MIN/MAX 取组内代表值，COUNT 算 hit_count——标准 GROUP BY 兼容 MySQL 5.7/8.0 全版本
	sub := store.DB.Table("im_clamav_quarantine q").
		Select("q.game_id, q.version, q.quarantined_at, q.game_name, q.slug, q.owner, q.status, "+
			"COUNT(*) as hit_count, "+
			"MIN(q.file_path) as first_file, "+
			"MIN(q.virus_sig) as first_sig, "+
			"MIN(q.id) as id")

	if v := q.Get("status"); v != "" {
		sub = sub.Where("q.status = ?", v)
	}
	if v := q.Get("owner"); v != "" {
		sub = sub.Where("q.owner LIKE ?", "%"+v+"%")
	}
	if v := q.Get("game_id"); v != "" {
		sub = sub.Where("q.game_id = ?", v)
	}
	sub = sub.Group("q.game_id, q.version, q.quarantined_at, q.game_name, q.slug, q.owner, q.status").
		Order("MAX(q.quarantined_at) DESC, MIN(q.id) ASC")

	type groupedItem struct {
		ID             uint      `json:"id"`
		GameID         uint      `json:"game_id"`
		GameName       string    `json:"game_name"`
		Slug           string    `json:"slug"`
		Version        string    `json:"version"`
		Owner          string    `json:"owner"`
		HitCount       int       `json:"hit_count"`
		FirstFile      string    `json:"first_file"`
		FirstSig       string    `json:"first_sig"`
		QuarantinedAt  time.Time `json:"quarantined_at"`
		Status         int8      `json:"status"`
		VersionID      uint      `json:"version_id"`
		GameStatus     int8      `json:"game_status"`
		GameAuditRemark string   `json:"game_audit_remark"`
	}
	var groups []groupedItem
	if err := sub.Scan(&groups).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询隔离库失败: "+err.Error())
		return
	}

	// 补充 version_id + 当前 game.audit_status / audit_remark（聚合查询无法 JOIN，单独批量查）
	if len(groups) > 0 {
		// 批量查 game_version id
		vmap := make(map[uint]uint) // gameID -> versionID（取最新 version）
		gmap := make(map[uint]*model.Game)
		gameIDs := make([]uint, 0, len(groups))
		for _, g := range groups {
			if _, ok := vmap[g.GameID]; !ok {
				gameIDs = append(gameIDs, g.GameID)
			}
		}
		var gvs []model.GameVersion
		if err := store.DB.Where("game_id IN ?", gameIDs).Select("id, game_id, version").Find(&gvs).Error; err == nil {
			for _, gv := range gvs {
				if gv.ID > vmap[gv.GameID] {
					vmap[gv.GameID] = gv.ID
				}
			}
		}
		var gs []model.Game
		if err := store.DB.Where("id IN ?", gameIDs).Select("id, audit_status, audit_remark").Find(&gs).Error; err == nil {
			for i := range gs {
				gmap[gs[i].ID] = &gs[i]
			}
		}
		for i := range groups {
			groups[i].VersionID = vmap[groups[i].GameID]
			if g, ok := gmap[groups[i].GameID]; ok {
				groups[i].GameStatus = g.AuditStatus
				groups[i].GameAuditRemark = g.AuditRemark
			}
		}
	}

	// 统计总数
	var total int64
	if err := store.DB.Model(&model.ClamavQuarantine{}).Distinct("game_id").Count(&total).Error; err != nil {
		total = int64(len(groups))
	}

	adminJSON(w, map[string]interface{}{"items": groups, "total": total})
}

// formatTimeIfNeeded GORM scan 出来的时间可能是多种格式，统一格式化
func formatTimeIfNeeded(t string) string {
	if t == "" {
		return ""
	}
	// 如果已经是标准格式则直接返回
	if len(t) >= 19 {
		if _, err := time.Parse("2006-01-02 15:04:05", t[:19]); err == nil {
			return t[:19]
		}
	}
	return t
}

// handleAdminClamavQuarantineDetail GET /admin/api/security/quarantine/{id}
func (s *Server) handleAdminClamavQuarantineDetail(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/admin/api/security/quarantine/")
	idStr = strings.TrimSuffix(idStr, "/")
	var id uint
	fmt.Sscanf(idStr, "%d", &id)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "无效的隔离记录 ID")
		return
	}
	// 查出该 game_id 下所有隔离记录（同一游戏同一版本可能多条）
	var first model.ClamavQuarantine
	if err := store.DB.First(&first, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "隔离记录不存在")
		return
	}
	var all []model.ClamavQuarantine
	// 优先按 version_id 精确匹配（同一版本多条检出），比 quarantined_at 更可靠
	// 同游戏不同版本、同秒扫描不会串到一起；老数据 version_id 为空时退回到 game_id 单条件
	if first.VersionID > 0 {
		if err := store.DB.Where("game_id = ? AND version_id = ?", first.GameID, first.VersionID).Order("id ASC").Find(&all).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "查询隔离记录详情失败: "+err.Error())
			return
		}
	} else {
		if err := store.DB.Where("game_id = ?", first.GameID).Order("id ASC").Find(&all).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "查询隔离记录详情失败: "+err.Error())
			return
		}
	}

	adminJSON(w, map[string]interface{}{
		"game_id":          first.GameID,
		"game_name":        first.GameName,
		"version_id":       first.VersionID,
		"version":          first.Version,
		"owner":            first.Owner,
		"hit_count":        len(all),
		"quarantined_at":   first.QuarantinedAt,
		"records":          all,
	})
}

// handleAdminClamavQuarantineApprove POST /admin/api/security/quarantine/{id}/approve
func (s *Server) handleAdminClamavQuarantineApprove(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/admin/api/security/quarantine/")
	idStr = strings.TrimSuffix(idStr, "/approve")
	var id uint
	fmt.Sscanf(idStr, "%d", &id)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "无效的隔离记录 ID")
		return
	}
	var req struct {
		AdminNote string `json:"admin_note"`
	}
	_ = jsonDecodeLimit(w, r, &req, 2048) // 忽略解析错误（note 可选）

	var first model.ClamavQuarantine
	if err := store.DB.First(&first, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "隔离记录不存在")
		return
	}
	now := time.Now()
	adminName := adminUserFromCtx(r)

	tx := store.DB.Begin()
	// 隔离记录标记为已通过
	if err := tx.Model(&model.ClamavQuarantine{}).
		Where("game_id = ? AND status = 0", first.GameID).
		Updates(map[string]interface{}{
			"status":     1,
			"admin_note": req.AdminNote,
			"decided_by": adminName,
			"decided_at": &now,
		}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "更新隔离记录失败: "+err.Error())
		return
	}
	// 游戏从隔离态 → 待审核（让商户重新提交审核流程，或直接通过待管理员决定）
	// 这里置为待审核（audit_status=1），让商户端明确知道"需要重新提交审核"
	if first.Owner != "" {
		if err := tx.Model(&model.Game{}).Where("id = ? AND audit_status = 4", first.GameID).Updates(map[string]interface{}{
			"audit_status": model.GameAuditPending,
			"audit_remark": "病毒隔离已通过（管理员确认安全），请点击重新提交审核",
		}).Error; err != nil {
			tx.Rollback()
			adminFail(w, http.StatusInternalServerError, "更新游戏审核状态失败: "+err.Error())
			return
		}
	}
	if err := tx.Commit().Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "操作失败: "+err.Error())
		return
	}

	logger.Info("隔离记录审核通过: 游戏=%s(%s), 管理员=%s, 记录数同上", first.GameName, first.Slug, adminName)

	// 推 WS 通知商户（游戏从隔离态回到待审核）
	if first.Owner != "" {
		s := defaultServer()
		if s != nil {
			emitGameAuditChanged(s, first.Owner, first.GameID, model.GameAuditPending,
				"病毒隔离已通过，请重新提交审核", first.GameName)
		}
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminClamavQuarantineReject POST /admin/api/security/quarantine/{id}/reject
func (s *Server) handleAdminClamavQuarantineReject(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/admin/api/security/quarantine/")
	idStr = strings.TrimSuffix(idStr, "/reject")
	var id uint
	fmt.Sscanf(idStr, "%d", &id)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "无效的隔离记录 ID")
		return
	}
	var req struct {
		AdminNote string `json:"admin_note"`
	}
	if err := jsonDecodeLimit(w, r, &req, 2048); err != nil {
		return
	}
	if req.AdminNote == "" {
		adminFail(w, http.StatusBadRequest, "驳回时管理员备注为必填")
		return
	}
	if len(req.AdminNote) > 500 {
		adminFail(w, http.StatusBadRequest, "备注长度不能超过 500 字")
		return
	}

	var first model.ClamavQuarantine
	if err := store.DB.First(&first, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "隔离记录不存在")
		return
	}
	now := time.Now()
	adminName := adminUserFromCtx(r)

	tx := store.DB.Begin()
	if err := tx.Model(&model.ClamavQuarantine{}).
		Where("game_id = ? AND status = 0", first.GameID).
		Updates(map[string]interface{}{
			"status":     2,
			"admin_note": req.AdminNote,
			"decided_by": adminName,
			"decided_at": &now,
		}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "更新隔离记录失败: "+err.Error())
		return
	}
	// 游戏隔离态 → 已驳回（audit_status=3）
	if first.Owner != "" {
		remark := "病毒隔离审核驳回：" + req.AdminNote
		if err := tx.Model(&model.Game{}).Where("id = ? AND audit_status = 4", first.GameID).Updates(map[string]interface{}{
			"audit_status": model.GameAuditRejected,
			"audit_remark": remark,
		}).Error; err != nil {
			tx.Rollback()
			adminFail(w, http.StatusInternalServerError, "更新游戏审核状态失败: "+err.Error())
			return
		}
	}
	if err := tx.Commit().Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "操作失败: "+err.Error())
		return
	}

	logger.Info("隔离记录审核驳回: 游戏=%s(%s), 管理员=%s, 备注=%s", first.GameName, first.Slug, adminName, req.AdminNote)

	// 推 WS 通知商户
	if first.Owner != "" {
		ss := defaultServer()
		if ss != nil {
			emitGameAuditChanged(ss, first.Owner, first.GameID, model.GameAuditRejected,
				"病毒隔离审核驳回："+req.AdminNote, first.GameName)
		}
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminClamavQuarantineCleanup DELETE /admin/api/security/quarantine/cleanup
func (s *Server) handleAdminClamavQuarantineCleanup(w http.ResponseWriter, r *http.Request) {
	maxAge := s.cfg.ClamAV.MaxQuarantineAgeDays
	if maxAge <= 0 {
		maxAge = 30
	}
	cutoff := time.Now().AddDate(0, 0, -maxAge)
	res := store.DB.Where("status IN (1,2) AND decided_at < ?", cutoff).Delete(&model.ClamavQuarantine{})
	if res.Error != nil {
		adminFail(w, http.StatusInternalServerError, "清理失败: "+res.Error.Error())
		return
	}
	logger.Info("隔离记录手动清理: 删除 %d 条过期已处置记录（超过 %d 天）", res.RowsAffected, maxAge)
	adminJSON(w, map[string]interface{}{"cleaned": res.RowsAffected})
}
