package server

// ===== 商户独立后台·管理端增量（商户独立后台开发文档 §3.4，adminGuard 鉴权） =====
//
// 商户管理：建号（users.role=2 + im_merchant 行）/ 改显示名/分成比例 / 启停 / 重置密码
// 游戏审核：待审核队列 + 通过（audit=2，保持原上架状态，商户自主决定上架/下架）/ 驳回（audit=3 + 必填理由）

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// registerMerchantAdminRoutes 管理端商户路由（game.go 注册归口调用）。
// 审核路由挂 /admin/api/merchant/audit/*（字面量前缀）：不能挂 /admin/api/game/audit/{id}——
// 与既有 POST /admin/api/game/{id}/version 构成两可匹配（Go 1.22 ServeMux 直接 panic）
func registerMerchantAdminRoutes(s *Server) {
	http.HandleFunc("GET /admin/api/merchants", s.adminGuard(s.handleAdminMerchantList))
	http.HandleFunc("POST /admin/api/merchants", s.adminGuard(s.handleAdminMerchantCreate))
	http.HandleFunc("PUT /admin/api/merchants/{username}", s.adminGuard(s.handleAdminMerchantUpdate))
	// 游戏审核
	http.HandleFunc("GET /admin/api/merchant/audit/list", s.adminGuard(s.handleAdminGameAuditList))
	http.HandleFunc("POST /admin/api/merchant/audit/{id}", s.adminGuard(s.handleAdminGameAuditAct))
}

// handleAdminMerchantList 商户列表（含游戏数与成功充值总额聚合）
func (s *Server) handleAdminMerchantList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.Merchant{})
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		db = db.Where("username LIKE ? OR name LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var list []model.Merchant
	db.Order("id ASC").Offset((page - 1) * size).Limit(size).Find(&list)
	// 存储占用批量汇总（一次分组查询）：避免逐商户 N+1，口径与 merchantQuotaUsed 一致
	owners := make([]string, 0, len(list))
	for _, m := range list {
		owners = append(owners, m.Username)
	}
	usedMap := merchantQuotaUsedBatch(owners)
	items := make([]map[string]interface{}, 0, len(list))
	for _, m := range list {
		var gameCnt int64
		store.DB.Model(&model.Game{}).Where("owner_username = ?", m.Username).Count(&gameCnt)
		var sum float64
		store.DB.Model(&model.RechargeOrder{}).
			Select("COALESCE(SUM(points),0)").
			Where("status = ? AND game_id IN (?)",
				model.RechargeOrderStatusSuccess,
				store.DB.Model(&model.Game{}).Select("id").Where("owner_username = ?", m.Username)).
			Scan(&sum)
		items = append(items, map[string]interface{}{
			"username": m.Username, "name": m.Name, "commission_rate": m.CommissionRate,
			"status": m.Status, "remark": m.Remark, "game_count": gameCnt,
			"recharge_total": sum,
			// 存储配额与占用（安全加固）：管理员分配视角——quota 0=跟随全局 / -1=不限 / >0=专属字节
			"storage_quota_bytes": m.StorageQuotaBytes,
			"storage_used_bytes":  usedMap[m.Username],
			// 单版本文件清单条数上限：0=跟随全局 / -1=不限 / >0=专属条数
			"max_files_per_version": m.MaxFilesPerVersion,
			"create_time":           m.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

// handleAdminMerchantCreate 创建商户（users.role=2 + im_merchant 行；账号=IM 账号体系）
// storage_quota_bytes 可选：0=跟随全局默认（缺省），-1=不限，>0=专属配额（字节）
func (s *Server) handleAdminMerchantCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username            string  `json:"username"`
		Password            string  `json:"password"`
		Name                string  `json:"name"`
		CommissionRate      float64 `json:"commission_rate"`
		StorageQuotaBytes   int64   `json:"storage_quota_bytes"`
		MaxFilesPerVersion  int     `json:"max_files_per_version"`
		Remark              string  `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if len(req.Username) < 2 || len(req.Username) > 32 || !isAlphaNum(req.Username) {
		adminFail(w, http.StatusBadRequest, "账号须为 2~32 位字母数字")
		return
	}
	if reservedUsernameRe.MatchString(req.Username) {
		adminFail(w, http.StatusBadRequest, "该用户名不可用")
		return
	}
	if utf8.RuneCountInString(req.Password) < 6 || len(req.Password) > 64 {
		adminFail(w, http.StatusBadRequest, "密码须为 6~64 位")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if utf8.RuneCountInString(req.Name) > 64 {
		adminFail(w, http.StatusBadRequest, "显示名过长（最多 64 字）")
		return
	}
	if req.CommissionRate < 0 || req.CommissionRate > 100 {
		adminFail(w, http.StatusBadRequest, "分成比例须为 0~100")
		return
	}
	if req.StorageQuotaBytes != 0 && req.StorageQuotaBytes != -1 && req.StorageQuotaBytes < 1048576 {
		adminFail(w, http.StatusBadRequest, "存储配额须为 -1（不限）或不小于 1MB 的字节数（0=跟随全局）")
		return
	}
	if req.MaxFilesPerVersion != 0 && req.MaxFilesPerVersion != -1 && req.MaxFilesPerVersion < 1 {
		adminFail(w, http.StatusBadRequest, "文件数上限须为 -1（不限）或正整数（0=跟随全局默认 5000）")
		return
	}
	var cnt int64
	store.DB.Model(&model.User{}).Where("username = ?", req.Username).Count(&cnt)
	if cnt > 0 {
		adminFail(w, http.StatusConflict, "账号已存在")
		return
	}
	// 双行落库（users 行 + 商户资料行）；users.Points 显式赋值防 GORM 零值插 0 后走默认 100——
	// 商户号不参与游戏充值/消费，赠送与否无意义，直接给 0 并显式归零（registerGiftPoints 语义不适用）
	u := model.User{Username: req.Username, Password: hashPassword(req.Password), Role: 2, Points: 0}
	if err := store.DB.Create(&u).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "账号创建失败")
		return
	}
	store.DB.Model(&model.User{}).Where("username = ?", req.Username).Update("points", 0)
	m := model.Merchant{Username: req.Username, Name: req.Name, CommissionRate: req.CommissionRate,
		StorageQuotaBytes: req.StorageQuotaBytes, MaxFilesPerVersion: req.MaxFilesPerVersion,
		Status: 0, Remark: strings.TrimSpace(req.Remark)}
	if err := store.DB.Create(&m).Error; err != nil {
		store.DB.Where("username = ?", req.Username).Delete(&model.User{}) // 回滚孤儿账号
		adminFail(w, http.StatusInternalServerError, "商户资料创建失败")
		return
	}
	logger.Info("创建商户账号: %s（比例 %.1f%%）, 操作人=%s", req.Username, req.CommissionRate, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"username": req.Username})
}

// handleAdminMerchantUpdate 编辑商户（显示名/比例/启停/重置密码；按 path username 定位）
func (s *Server) handleAdminMerchantUpdate(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	var m model.Merchant
	if err := store.DB.Where("username = ?", username).First(&m).Error; err != nil {
		adminFail(w, http.StatusNotFound, "商户不存在")
		return
	}
	var req struct {
		Name               *string  `json:"name"`
		CommissionRate     *float64 `json:"commission_rate"` // 指针：未传=不改（0 也是合法比例值）
		Status             *int8    `json:"status"`
		StorageQuota       *int64   `json:"storage_quota_bytes"`  // 指针：未传=不改；0=跟随全局，-1=不限，>0=专属（字节）
		MaxFilesPerVersion *int     `json:"max_files_per_version"` // 指针：未传=不改；0=跟随全局，-1=不限，>0=专属条数
		Password           string   `json:"password"`             // 非空=重置密码
		Remark             *string  `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if utf8.RuneCountInString(name) > 64 {
			adminFail(w, http.StatusBadRequest, "显示名过长（最多 64 字）")
			return
		}
		updates["name"] = name
	}
	if req.CommissionRate != nil {
		if *req.CommissionRate < 0 || *req.CommissionRate > 100 {
			adminFail(w, http.StatusBadRequest, "分成比例须为 0~100")
			return
		}
		updates["commission_rate"] = *req.CommissionRate
	}
	if req.Status != nil {
		if *req.Status != 0 && *req.Status != 1 {
			adminFail(w, http.StatusBadRequest, "参数错误")
			return
		}
		updates["status"] = *req.Status
	}
	if req.StorageQuota != nil {
		q := *req.StorageQuota
		if q != 0 && q != -1 && q < 1048576 {
			adminFail(w, http.StatusBadRequest, "存储配额须为 -1（不限）或不小于 1MB 的字节数（0=跟随全局）")
			return
		}
		updates["storage_quota_bytes"] = q
	}
	if req.MaxFilesPerVersion != nil {
		v := *req.MaxFilesPerVersion
		if v != 0 && v != -1 && v < 1 {
			adminFail(w, http.StatusBadRequest, "文件数上限须为 -1（不限）或正整数（0=跟随全局）")
			return
		}
		updates["max_files_per_version"] = v
	}
	if req.Remark != nil {
		if utf8.RuneCountInString(*req.Remark) > 255 {
			adminFail(w, http.StatusBadRequest, "备注过长（最多 255 字）")
			return
		}
		updates["remark"] = strings.TrimSpace(*req.Remark)
	}
	if req.Password != "" {
		if utf8.RuneCountInString(req.Password) < 6 || len(req.Password) > 64 {
			adminFail(w, http.StatusBadRequest, "密码须为 6~64 位")
			return
		}
		store.DB.Model(&model.User{}).Where("username = ?", username).Update("password", hashPassword(req.Password))
	}
	if len(updates) > 0 {
		if err := store.DB.Model(&model.Merchant{}).Where("username = ?", username).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败")
			return
		}
	}
	logger.Info("编辑商户 %s（字段 %d 个）, 操作人=%s", username, len(updates), adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameAuditList 审核列表（audit=1 待审核优先；status 可选过滤 1/2/3）
func (s *Server) handleAdminGameAuditList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	st, _ := strconv.Atoi(r.URL.Query().Get("status"))
	db := store.DB.Model(&model.Game{}).Where("owner_username <> ''")
	if st >= 1 && st <= 4 {
		db = db.Where("audit_status = ?", st)
	} else {
		// 默认显示除官方免审外的全部商户游戏（含隔离态 4，管理员在列表中可见以决定是否介入）
		db = db.Where("audit_status IN ?", []int8{
			model.GameAuditPending, model.GameAuditApproved, model.GameAuditRejected, model.GameAuditQuarantined,
		})
	}
	var games []model.Game
	db.Order("audit_status ASC, id DESC").Limit(200).Find(&games)
	list := make([]map[string]interface{}, 0, len(games))
	for _, g := range games {
		list = append(list, map[string]interface{}{
			"id": g.ID, "slug": g.Slug, "name": g.Name, "short_desc": g.ShortDesc, "cover": g.Cover,
			"screenshots": g.Screenshots, "description": g.Description, "tags": g.Tags,
			"price": g.Price, "status": g.Status,
			"recharge_enabled": g.RechargeEnabled, "recharge_rate": g.RechargeRate,
			"owner_username": g.OwnerUsername, "audit_status": g.AuditStatus,
			"audit_remark": g.AuditRemark, "audit_time": g.AuditTime,
			"create_time": g.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"list": list})
}

// handleAdminGameAuditAct 审核动作：通过（audit=2 + 自动上架）/驳回（audit=3 + 必填理由）
func (s *Server) handleAdminGameAuditAct(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	if g.OwnerUsername == "" {
		adminFail(w, http.StatusBadRequest, "官方游戏无需审核")
		return
	}
	// 隔离态（audit=4）游戏不能通过人工审核接口操作，必须走隔离库管理入口
	if g.AuditStatus == model.GameAuditQuarantined {
		adminFail(w, http.StatusBadRequest, "该游戏处于病毒隔离库（audit_status=4），请通过「隔离库管理」操作通过/驳回，不能在此处审核")
		return
	}
	var req struct {
		Action string `json:"action"` // pass / reject
		Remark string `json:"remark"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	now := time.Now()
	operator := adminUserFromCtx(r)
	switch strings.ToLower(strings.TrimSpace(req.Action)) {
	case "pass":
		updates := map[string]interface{}{
			"audit_status": model.GameAuditApproved, "audit_remark": "",
			"audit_time": &now, "audited_by": operator,
			// 不再自动上架——商户自主决定上架/下架（审核通过后默认为下架，需商户主动点"申请上架"）
		}
		if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "审核操作失败")
			return
		}
		logger.Info("游戏审核通过: %s (%s), 商户=%s, 操作人=%s", g.Name, g.Slug, g.OwnerUsername, operator)
		emitGameAuditChanged(s, g.OwnerUsername, g.ID, model.GameAuditApproved, "", g.Name)
		adminJSON(w, map[string]interface{}{"ok": true, "audit_status": model.GameAuditApproved})
	case "reject":
		remark := strings.TrimSpace(req.Remark)
		if remark == "" {
			adminFail(w, http.StatusBadRequest, "驳回必须填写理由")
			return
		}
		if utf8.RuneCountInString(remark) > 255 {
			adminFail(w, http.StatusBadRequest, "驳回理由过长（最多 255 字）")
			return
		}
		updates := map[string]interface{}{
			"audit_status": model.GameAuditRejected, "audit_remark": remark,
			"audit_time": &now, "audited_by": operator,
		}
		if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(updates).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "审核操作失败")
			return
		}
		logger.Info("游戏审核驳回: %s (%s), 商户=%s, 理由=%s, 操作人=%s", g.Name, g.Slug, g.OwnerUsername, remark, operator)
		emitGameAuditChanged(s, g.OwnerUsername, g.ID, model.GameAuditRejected, remark, g.Name)
		adminJSON(w, map[string]interface{}{"ok": true, "audit_status": model.GameAuditRejected})
	default:
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("未知审核动作: %s", req.Action))
	}
}
