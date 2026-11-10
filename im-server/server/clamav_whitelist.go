package server

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== ClamAV 病毒扫描白名单（阶段二） =====
// 命中白名单的文件跳过 ClamAV 扫描（已知安全的文件，如签名启动器、官方 DLL 等）。
// scope=0 全局生效 / scope=1 指定游戏生效。file_pattern 使用 Glob 风格匹配 filepath.Match。
// 管理后台热更接口：CRUD + 匹配测试，保存即刷新内存缓存，无需重启。

// clamavWhitelistCache 内存缓存（热更，避免每次扫描查 DB）
var (
	clamavWhitelistMu    sync.RWMutex
	clamavWhitelistCache []model.ClamavWhitelist
)

// ClamavWhitelistLoad 从 DB 加载全部启用的白名单规则（启动 + 热更刷新时调用）
func ClamavWhitelistLoad() {
	var rules []model.ClamavWhitelist
	if err := store.DB.Where("enabled = 1").Find(&rules).Error; err != nil {
		logger.Warn("白名单规则加载失败: %v（将使用空缓存）", err)
		rules = nil
	}
	clamavWhitelistMu.Lock()
	clamavWhitelistCache = rules
	clamavWhitelistMu.Unlock()
	logger.Info("病毒扫描白名单已加载: %d 条启用规则", len(rules))
}

// ClamavWhitelistRefresh 热更刷新（白名单 CRUD 后调用）
func ClamavWhitelistRefresh() {
	ClamavWhitelistLoad()
}

// ClamavWhitelistMatcherFactory 构建指定游戏的白名单匹配器（返回的 func 线程安全）
// 性能优化：先筛全局规则（无 game_id 依赖，O(n_global)），再筛 scope=1 指定游戏规则（O(n_game)）
// 规则总数通常 < 50 条，每条 filepath.Match 微秒级；按 scope 预分组后减少无效匹配
func ClamavWhitelistMatcherFactory(gameID uint) func(relPath string) bool {
	clamavWhitelistMu.RLock()
	var globalRules []model.ClamavWhitelist
	var gameRules []model.ClamavWhitelist
	for _, r := range clamavWhitelistCache {
		if r.Enabled != 1 {
			continue
		}
		if r.Scope == 0 {
			globalRules = append(globalRules, r)
		} else if r.TargetID == gameID {
			gameRules = append(gameRules, r)
		}
	}
	clamavWhitelistMu.RUnlock()
	if len(globalRules) == 0 && len(gameRules) == 0 {
		return nil
	}
	return func(relPath string) bool {
		for _, r := range globalRules {
			if matched, _ := filepath.Match(r.FilePattern, relPath); matched {
				return true
			}
		}
		for _, r := range gameRules {
			if matched, _ := filepath.Match(r.FilePattern, relPath); matched {
				return true
			}
		}
		return false
	}
}

// clamavWhitelistMatchSingle 单条匹配测试（供前端「匹配测试」接口使用）
// 返回命中的规则（含 scope/target_name 完整信息），未命中返回 nil
func clamavWhitelistMatchSingle(filePath string, gameID uint) *struct {
	ID         uint   `json:"id"`
	FilePattern string `json:"file_pattern"`
	Scope      int8   `json:"scope"`
	TargetName string `json:"target_name"`
} {
	var rules []model.ClamavWhitelist
	if err := store.DB.Where("enabled = 1").Find(&rules).Error; err != nil {
		return nil
	}
	for _, r := range rules {
		if r.Scope == 1 && r.TargetID != gameID {
			continue
		}
		if matched, _ := filepath.Match(r.FilePattern, filePath); matched {
			targetName := "全局"
			if r.Scope == 1 {
				var g model.Game
				if err := store.DB.Select("name").First(&g, r.TargetID).Error; err == nil {
					targetName = g.Name
				}
			}
			return &struct {
				ID         uint   `json:"id"`
				FilePattern string `json:"file_pattern"`
				Scope      int8   `json:"scope"`
				TargetName string `json:"target_name"`
			}{ID: r.ID, FilePattern: r.FilePattern, Scope: r.Scope, TargetName: targetName}
		}
	}
	return nil
}

// ===== 管理后台 CRUD 接口 =====

// handleAdminClamavWhitelistList GET /admin/api/security/whitelist/list
func (s *Server) handleAdminClamavWhitelistList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Scope   int8 `form:"scope"`    // 可选 0=全局 / 1=指定游戏
		Enabled int  `form:"enabled"`  // 可选 0/1
	}
	q := r.URL.Query()
	if v := q.Get("scope"); v != "" {
		fmt.Sscanf(v, "%d", &req.Scope)
	}
	if v := q.Get("enabled"); v != "" {
		fmt.Sscanf(v, "%d", &req.Enabled)
	}

	db := store.DB
	if q.Get("scope") != "" {
		db = db.Where("scope = ?", req.Scope)
	}
	if q.Get("enabled") != "" {
		db = db.Where("enabled = ?", req.Enabled)
	}

	var rules []model.ClamavWhitelist
	if err := db.Order("id ASC").Find(&rules).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询白名单失败: "+err.Error())
		return
	}

	// 补充 scope=1 的游戏名称
	type withGame struct {
		model.ClamavWhitelist
		GameName string `json:"game_name"`
	}
	result := make([]withGame, 0, len(rules))
	for _, r := range rules {
		item := withGame{ClamavWhitelist: r}
		if r.Scope == 1 {
			var g model.Game
			if err := store.DB.Select("name").First(&g, r.TargetID).Error; err == nil {
				item.GameName = g.Name
			}
		}
		result = append(result, item)
	}
	adminJSON(w, map[string]interface{}{"items": result, "total": len(rules)})
}

// handleAdminClamavWhitelistCreate POST /admin/api/security/whitelist
func (s *Server) handleAdminClamavWhitelistCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Scope       int8   `json:"scope"`       // 0=全局 / 1=指定游戏
		TargetID    uint   `json:"target_id"`   // scope=1 时必填
		FilePattern string `json:"file_pattern"` // Glob 风格匹配模式
		Reason      string `json:"reason"`
		Enabled     int8   `json:"enabled"`
	}
	if err := jsonDecodeLimit(w, r, &req, 1024); err != nil {
		return
	}
	if req.FilePattern == "" {
		adminFail(w, http.StatusBadRequest, "匹配模式不能为空")
		return
	}
	if req.Scope == 1 && req.TargetID == 0 {
		adminFail(w, http.StatusBadRequest, "指定游戏范围时必须提供 target_id")
		return
	}
	// 验证 Glob 模式合法性（filepath.Match 对非法模式也会返回 err）
	if _, err := filepath.Match(req.FilePattern, "test"); err != nil {
		adminFail(w, http.StatusBadRequest, "匹配模式格式无效: "+err.Error())
		return
	}
	// 检查重复
	var exist model.ClamavWhitelist
	checkScope := req.Scope
	checkTarget := req.TargetID
	if checkScope == 0 {
		checkTarget = 0
	}
	if err := store.DB.Where("scope = ? AND target_id = ? AND file_pattern = ? AND enabled = 1",
		checkScope, checkTarget, req.FilePattern).First(&exist).Error; err == nil {
		adminFail(w, http.StatusConflict, "该范围内已存在相同匹配模式的启用规则")
		return
	}

	rule := model.ClamavWhitelist{
		Scope:       req.Scope,
		TargetID:    checkTarget,
		FilePattern: req.FilePattern,
		Reason:      req.Reason,
		Enabled:     req.Enabled,
		CreatedBy:   adminUserFromCtx(r),
		CreatedAt:   func() *time.Time { t := time.Now(); return &t }(),
	}
	if rule.Enabled == 0 {
		rule.Enabled = 1
	}
	if err := store.DB.Create(&rule).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "创建白名单失败: "+err.Error())
		return
	}
	ClamavWhitelistRefresh()
	adminJSON(w, map[string]interface{}{"ok": true, "id": rule.ID})
}

// handleAdminClamavWhitelistUpdate PUT /admin/api/security/whitelist/{id}
func (s *Server) handleAdminClamavWhitelistUpdate(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/admin/api/security/whitelist/")
	idStr = strings.TrimSuffix(idStr, "/")
	var id uint
	fmt.Sscanf(idStr, "%d", &id)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "无效的规则 ID")
		return
	}
	var rule model.ClamavWhitelist
	if err := store.DB.First(&rule, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "规则不存在")
		return
	}
	var req struct {
		FilePattern *string `json:"file_pattern"`
		Reason      *string `json:"reason"`
		Enabled     *int8   `json:"enabled"`
		Scope       *int8   `json:"scope"`
		TargetID    *uint   `json:"target_id"`
	}
	if err := jsonDecodeLimit(w, r, &req, 1024); err != nil {
		return
	}
	updates := map[string]interface{}{}
	if req.FilePattern != nil {
		if _, err := filepath.Match(*req.FilePattern, "test"); err != nil {
			adminFail(w, http.StatusBadRequest, "匹配模式格式无效: "+err.Error())
			return
		}
		updates["file_pattern"] = *req.FilePattern
	}
	if req.Reason != nil {
		updates["reason"] = *req.Reason
	}
	if req.Enabled != nil {
		updates["enabled"] = *req.Enabled
	}
	if req.Scope != nil {
		updates["scope"] = *req.Scope
	}
	if req.TargetID != nil {
		updates["target_id"] = *req.TargetID
	}
	if len(updates) == 0 {
		adminJSON(w, map[string]interface{}{"ok": true})
		return
	}
	if err := store.DB.Model(&rule).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "更新白名单失败: "+err.Error())
		return
	}
	ClamavWhitelistRefresh()
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminClamavWhitelistDelete DELETE /admin/api/security/whitelist/{id}
func (s *Server) handleAdminClamavWhitelistDelete(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/admin/api/security/whitelist/")
	idStr = strings.TrimSuffix(idStr, "/")
	var id uint
	fmt.Sscanf(idStr, "%d", &id)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "无效的规则 ID")
		return
	}
	res := store.DB.Delete(&model.ClamavWhitelist{}, id)
	if res.Error != nil {
		adminFail(w, http.StatusInternalServerError, "删除白名单失败: "+res.Error.Error())
		return
	}
	if res.RowsAffected == 0 {
		adminFail(w, http.StatusNotFound, "规则不存在")
		return
	}
	ClamavWhitelistRefresh()
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminClamavWhitelistTest POST /admin/api/security/whitelist/test 匹配测试
func (s *Server) handleAdminClamavWhitelistTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		FilePath string `json:"file_path"`
		GameID   uint   `json:"game_id"`
	}
	if err := jsonDecodeLimit(w, r, &req, 1024); err != nil {
		return
	}
	if req.FilePath == "" {
		adminFail(w, http.StatusBadRequest, "file_path 不能为空")
		return
	}
	match := clamavWhitelistMatchSingle(req.FilePath, req.GameID)
	if match != nil {
		adminJSON(w, map[string]interface{}{
			"matched":     true,
			"rule_id":     match.ID,
			"file_pattern": match.FilePattern,
			"scope":       match.Scope,
			"target_name": match.TargetName,
		})
	} else {
		adminJSON(w, map[string]interface{}{"matched": false})
	}
}

// ===== 清理定时器（已处置隔离记录过期清理） =====

// StartClamavQuarantineCleanup 启动隔离记录定时清理协程（每小时扫一次）
// 分批删除（每批 100 条）避免大量过期记录一次性 DELETE 锁表过久
func StartClamavQuarantineCleanup(s *Server) {
	if s == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			maxAge := s.cfg.ClamAV.MaxQuarantineAgeDays
			if maxAge <= 0 {
				maxAge = 30
			}
			cutoff := time.Now().AddDate(0, 0, -maxAge)
			var total int64
			for {
				res := store.DB.Where("status IN (1,2) AND decided_at < ?", cutoff).
					Limit(100).
					Delete(&model.ClamavQuarantine{})
				if res.Error != nil {
					logger.Warn("隔离记录定时清理失败: %v", res.Error)
					break
				}
				total += res.RowsAffected
				if res.RowsAffected < 100 {
					break
				}
			}
			if total > 0 {
				logger.Info("隔离记录定时清理: 分批删除共 %d 条过期已处置记录（超过 %d 天）", total, maxAge)
			}
		}
	}()
}
