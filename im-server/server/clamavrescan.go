package server

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== ClamAV 存量回溯扫描（管理端入口，安全加固） =====
// 上架扫描只覆盖新登记版本，历史已上架版本需一次性回溯排查。本模块提供管理端触发的
// 全量/单游戏后台重扫任务（单飞防并发重复）：
//   - 范围 = 全部商户名下游戏（owner_username <> ''）的全部版本，逐版本扫描落位目录；
//   - 检出即自动驳回该游戏（与上架异步扫描同一处置语义：audit=3 + remark 携带签名，
//     玩家侧过滤墙立即下架隐藏），命中明细留在任务态供管理端轮询展示；
//   - clamd 异常 fail-open：跳过该版本记日志继续（不驳回），管理端任务态可见 scanned/hits 进度；
//   - 任务态纯内存（重启归零），与既有告警/指标同水位，不引入持久化负担。
// 路由：POST /admin/api/security/clamav/rescan（启动）、GET /admin/api/security/clamav/rescan/status
// 前端入口：admin.html 游戏审核页「病毒扫描（存量回溯）」卡片。
// 设计文档：docs/商户上传安全加固方案.md §4

// clamRescanHit 单个检出明细（管理端展示口径）
type clamRescanHit struct {
	GameID  uint   `json:"game_id"`
	Slug    string `json:"slug"`
	Version string `json:"version"`
	RelPath string `json:"rel_path"` // 版本目录内相对路径（正斜杠）
	Sig     string `json:"sig"`      // ClamAV 病毒签名
}

// clamRescanJob 回溯扫描任务态（内存态，Mu 保护；Running=false 且 StartedAt 非零=上次结果）
type clamRescanJob struct {
	Mu              sync.Mutex
	Running         bool
	GameID          uint // 0=全部商户游戏；>0=指定游戏（启动参数留档）
	StartedAt       time.Time
	FinishedAt      time.Time
	VersionsTotal   int
	VersionsScanned int
	FilesTotal      int // 启动扫描前预计算的总文件数（供前端文件级进度条）
	FilesScanned    int
	Hits            []clamRescanHit
	Err             string // 任务级致命错误（如配置缺失）；版本级异常走日志不置位
	// 实时进度反馈（每扫完一个文件更新，status 接口返回供前端轮询展示）
	CurrentGameSlug  string // 当前正在扫描的游戏 slug
	CurrentVersion   string // 当前正在扫描的版本
	CurrentFile      string // 最近一个完成扫描的文件路径（绝对路径）
	CurrentFileRel   string // 同上，版本目录内相对路径（正斜杠）
	LastFileAt       time.Time
}

// clamRescan 包级单例任务态（单实例部署；集群模式每实例独立任务态，与告警/指标同水位）
var clamRescan clamRescanJob

// handleClamAVRescan POST /admin/api/security/clamav/rescan 启动存量回溯扫描
// 入参（可选 JSON）：{"game_id": 123}——缺省/0=全部商户游戏；指定游戏须为商户名下游戏
func (s *Server) handleClamAVRescan(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.ClamAV.Enabled {
		adminFail(w, http.StatusBadRequest, "病毒扫描未启用（config.yaml clamav.enabled=true 并部署 clamd 后可用）")
		return
	}
	var req struct {
		GameID uint `json:"game_id"`
	}
	// body 可缺省（全量模式）；解析失败按全量处理
	_ = jsonDecodeLimit(w, r, &req, 512)
	if req.GameID > 0 {
		var g model.Game
		if err := store.DB.First(&g, req.GameID).Error; err != nil {
			adminFail(w, http.StatusNotFound, "游戏不存在")
			return
		}
		if g.OwnerUsername == "" {
			adminFail(w, http.StatusBadRequest, "官方游戏不走商户扫描通道（官方上架内容管理员自管）")
			return
		}
	}
	clamRescan.Mu.Lock()
	if clamRescan.Running {
		clamRescan.Mu.Unlock()
		adminFail(w, http.StatusConflict, "已有回溯扫描任务进行中，请通过「刷新进度」查看")
		return
	}
	clamRescan.Running = true
	clamRescan.GameID = req.GameID
	clamRescan.StartedAt = time.Now()
	clamRescan.FinishedAt = time.Time{}
	clamRescan.VersionsTotal = 0
	clamRescan.VersionsScanned = 0
	clamRescan.FilesScanned = 0
	clamRescan.Hits = nil
	clamRescan.Err = ""
	clamRescan.CurrentGameSlug = ""
	clamRescan.CurrentVersion = ""
	clamRescan.CurrentFile = ""
	clamRescan.CurrentFileRel = ""
	clamRescan.LastFileAt = time.Time{}
	clamRescan.Mu.Unlock()

	go s.clamRescanRun(req.GameID)
	logger.Info("存量病毒回溯扫描已启动: 范围=%s, 操作人=%s", clamRescanScopeText(req.GameID), adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true, "running": true})
}

// handleClamAVRescanStatus GET /admin/api/security/clamav/rescan/status 任务态快照
func (s *Server) handleClamAVRescanStatus(w http.ResponseWriter, r *http.Request) {
	clamRescan.Mu.Lock()
	defer clamRescan.Mu.Unlock()
	hits := make([]clamRescanHit, len(clamRescan.Hits))
	copy(hits, clamRescan.Hits)
	resp := map[string]interface{}{
		"running":            clamRescan.Running,
		"game_id":            clamRescan.GameID,
		"versions_total":     clamRescan.VersionsTotal,
		"versions_scanned":  clamRescan.VersionsScanned,
		"files_total":        clamRescan.FilesTotal,
		"files_scanned":      clamRescan.FilesScanned,
		"hits":               hits,
		"err":                clamRescan.Err,
		"current_game_slug":  clamRescan.CurrentGameSlug,
		"current_version":    clamRescan.CurrentVersion,
		"current_file":       clamRescan.CurrentFile,
		"current_file_rel":   clamRescan.CurrentFileRel,
	}
	if !clamRescan.StartedAt.IsZero() {
		resp["started_at"] = clamRescan.StartedAt.Format("2006-01-02 15:04:05")
	}
	if !clamRescan.FinishedAt.IsZero() {
		resp["finished_at"] = clamRescan.FinishedAt.Format("2006-01-02 15:04:05")
	}
	if !clamRescan.LastFileAt.IsZero() {
		resp["last_file_at"] = clamRescan.LastFileAt.Format("2006-01-02 15:04:05")
	}
	adminJSON(w, resp)
}

// clamRescanRun 回溯扫描执行体（goroutine 内）：逐版本扫描 → 检出自动驳回 → 进度实时落任务态
func (s *Server) clamRescanRun(gameID uint) {
	defer func() {
		clamRescan.Mu.Lock()
		clamRescan.Running = false
		clamRescan.FinishedAt = time.Now()
		clamRescan.Mu.Unlock()
		logger.Info("存量病毒回溯扫描结束: 范围=%s, 版本 %d/%d, 文件 %d 个, 检出 %d 处",
			clamRescanScopeText(gameID), clamRescan.VersionsScanned, clamRescan.VersionsTotal, clamRescan.FilesScanned, len(clamRescan.Hits))
	}()

	// 版本清单：全部商户名下游戏（可选单游戏过滤）；version/slug 均为服务端清洗过的安全命名
	var rows []struct {
		GameID        uint
		GameName      string
		Slug          string
		Version       string
		OwnerUsername string
	}
	db := store.DB.Table("im_game_version v").
		Select("v.game_id AS game_id, g.name AS game_name, g.slug AS slug, v.version AS version, g.owner_username AS owner_username").
		Joins("JOIN im_game g ON g.id = v.game_id").
		Where("g.owner_username <> ''")
	if gameID > 0 {
		db = db.Where("v.game_id = ?", gameID)
	}
	if err := db.Order("v.id ASC").Scan(&rows).Error; err != nil {
		clamRescan.Mu.Lock()
		clamRescan.Err = "版本清单查询失败: " + err.Error()
		clamRescan.Mu.Unlock()
		logger.Error("存量病毒回溯扫描版本清单查询失败: %v", err)
		return
	}
	clamRescan.Mu.Lock()
	clamRescan.VersionsTotal = len(rows)
	// 预计算总文件数：WalkDir 每个版本目录，用于文件级进度条
	var totalFiles int
	for _, row := range rows {
		verRoot := filepath.Join(s.cfg.Game.LocalDir, "games", row.Slug, row.Version)
		if st, err := os.Stat(verRoot); err != nil || !st.IsDir() {
			continue
		}
		_ = filepath.WalkDir(verRoot, func(p string, e os.DirEntry, werr error) error {
			if werr != nil || e.IsDir() {
				return nil
			}
			totalFiles++
			return nil
		})
	}
	clamRescan.FilesTotal = totalFiles
	clamRescan.Mu.Unlock()

	timeout := time.Duration(s.cfg.ClamAV.TimeoutSec) * time.Second
	rejected := map[uint]bool{} // 同一游戏多次命中只驳回一次（后续命中仍入明细）
	// 节流：每个版本扫完让磁盘 IO 喘口气（100ms），避免大包连续读盘影响玩家下载
	const perVersionThrottle = 100 * time.Millisecond
	for _, row := range rows {
		verRoot := filepath.Join(s.cfg.Game.LocalDir, "games", row.Slug, row.Version)
		if st, err := os.Stat(verRoot); err != nil || !st.IsDir() {
			continue // 落位目录不存在（历史数据被清理/BT 种子方式无本地版本）跳过
		}
		// 标记当前正在扫描的游戏+版本（供前端轮询展示）
		clamRescan.Mu.Lock()
		clamRescan.CurrentGameSlug = row.Slug
		clamRescan.CurrentVersion = row.Version
		clamRescan.Mu.Unlock()
		onFile := func(path string) {
			rel, rerr := filepath.Rel(verRoot, path)
			if rerr != nil {
				rel = filepath.Base(path)
			}
			clamRescan.Mu.Lock()
			// 每扫完一个文件立刻累加（包括 clamd 异常跳过的，因为"扫过了"就是扫过了）
			clamRescan.FilesScanned++
			clamRescan.CurrentFile = path
			clamRescan.CurrentFileRel = filepath.ToSlash(rel)
			clamRescan.LastFileAt = time.Now()
			clamRescan.Mu.Unlock()
		}
		_, hits, err := clamScanDir(s.cfg.ClamAV.Addr, verRoot, timeout, onFile)
		if err == nil {
			clamRescan.Mu.Lock()
			clamRescan.VersionsScanned++
			clamRescan.Mu.Unlock()
		} else {
			// clamd 拨号失败等硬错误：这个版本没完整扫完，不计 VersionsScanned
			logger.Warn("存量回溯扫描跳过（clamd 异常）: %s(%s) v%s, %v", row.GameName, row.Slug, row.Version, err)
			continue
		}
		for _, h := range hits {
			rel, rerr := filepath.Rel(verRoot, h.Path)
			if rerr != nil {
				rel = filepath.Base(h.Path)
			}
			clamRescan.Mu.Lock()
			clamRescan.Hits = append(clamRescan.Hits, clamRescanHit{
				GameID: row.GameID, Slug: row.Slug, Version: row.Version,
				RelPath: filepath.ToSlash(rel), Sig: h.Sig,
			})
			clamRescan.Mu.Unlock()
			logger.Error("存量回溯检出: %s(%s) v%s ← %s（%s）", row.GameName, row.Slug, row.Version, filepath.ToSlash(rel), h.Sig)
		}
		// 检出自动驳回（同游戏去重；与人工驳回同一状态机语义）
		if len(hits) > 0 && !rejected[row.GameID] {
			first := hits[0]
			remark := fmt.Sprintf("存量病毒回溯扫描不通过（自动驳回）：检出 %s（%s）；请清理文件后重新提交审核",
				first.Sig, filepath.Base(first.Path))
			res := store.DB.Model(&model.Game{}).Where("id = ?", row.GameID).Updates(map[string]interface{}{
				"audit_status": model.GameAuditRejected, "audit_remark": remark,
			})
			if res.Error != nil {
				logger.Error("存量回溯检出但自动驳回失败（请人工处理）: 游戏=%d, %v", row.GameID, res.Error)
			} else if res.RowsAffected > 0 {
				rejected[row.GameID] = true
				logger.Error("存量回溯自动驳回: 游戏=%s(%s), 检出 %d 处, 首个=%s（%s）", row.GameName, row.Slug, len(hits), filepath.Base(first.Path), first.Sig)
				// 推 WS 通知商户实时刷新
				if row.OwnerUsername != "" {
					emitGameAuditChanged(s, row.OwnerUsername, row.GameID, model.GameAuditRejected, remark, row.GameName)
				}
			}
		}
		time.Sleep(perVersionThrottle)
	}
}

// clamRescanScopeText 扫描范围文案（日志用）
func clamRescanScopeText(gameID uint) string {
	if gameID > 0 {
		return fmt.Sprintf("游戏%d", gameID)
	}
	return "全部商户游戏"
}
