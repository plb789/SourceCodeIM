package server

// ===== 阶段一百六十八：聊天附件管理（后台 static/upload 目录全量视图 + 管理操作） =====
// 设计归口：
//   1. 统计对象：聊天附件上传目录 static/upload（IM 聊天图片/文件、AI 文件、群公告附件、工作台文件），
//      与仪表盘「聊天附件占用」同目录但本模块提供文件级明细与管理能力（头像在 static/avatar 独立目录，不在本模块范围）
//   2. 分类口径：
//      chat    聊天文件  —— im_file.file_path 命中（/static/upload/<name>），可显示原始名/发送人→接收人/状态
//      feature 功能文件  —— ann_（群公告附件）/ wb_（工作台文件）等功能前缀命名，独立表持有引用，免疫定期清理
//      orphan  未关联    —— 其余直接落盘文件（AI 图片提问上传等，消息 content 内嵌 URL 引用）
//   3. 保留期口径与 fileCleanupOnce（阶段一百六十）完全一致：仅「非图片扩展 + 标准命名白名单」适用保留天数；
//      剩余天数按磁盘 ModTime 估算（清理实际每 6 小时一轮，显示为近似倒计时），-1=不适用（永存/免疫），-2=清理未启用
//   4. 删除 = 物理删除（与保留清理同语义，无回收站）：只接受纯文件名（防路径穿越），不删 im_file 审计记录
//      —— 前端消息卡片按既有「文件已过期」灰显逻辑呈现，与定期清理的用户感知一致
//   5. 数据缓存：目录扫描 + im_file 反查结果 60 秒包级缓存（管理端低频操作，与仪表盘 5 分钟扫描互不影响）

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

// errAdminUploadDirEmpty 上传目录未配置（cfg.UploadDir 为空）
var errAdminUploadDirEmpty = errors.New("上传目录未配置")

// uploadAdminFilenameRe 标准聊天上传物命名白名单（与 uploadCleanupNameRe 同口径）
var uploadAdminFilenameRe = regexp.MustCompile(`^\d{15,}_[0-9a-f]{16}\.[^.]+$`)

// uploadAdminFeaturePrefixes 功能前缀文件（公告附件/工作台文件，独立表持有引用，免疫定期清理）
var uploadAdminFeaturePrefixes = []string{"ann_", "wb_"}

// uploadAdminCache 聊天附件管理缓存（扫描结果 + im_file 反查，60 秒 TTL）
var uploadAdminCache struct {
	sync.Mutex
	at     time.Time
	rows   []uploadAdminFileRow
	byName map[string]uploadAdminFileRow
}

// uploadAdminFileRow 聊天附件列表行
type uploadAdminFileRow struct {
	Name       string `json:"name"`        // 磁盘文件名
	OrigName   string `json:"orig_name"`   // im_file 原始文件名（无记录为空）
	Owner      string `json:"owner"`       // 归属：发送人 → 接收人（无记录为空）
	Size       int64  `json:"size"`        // 磁盘字节
	Ext        string `json:"ext"`         // 小写扩展名（含点）
	Category   string `json:"category"`    // chat | feature | orphan
	Status     int    `json:"status"`      // im_file status（0-3），无记录 -1
	ModTime    string `json:"mod_time"`    // 磁盘修改时间（保留期计算基准，与清理口径一致）
	RetainDays int    `json:"retain_days"` // 剩余保留天数估算：>=0 剩余天；-1 不适用（永存/免疫）；-2 清理未启用
}

// uploadAdminDir 归口取聊天附件目录（config UploadDir；为空返回 err 由调用方统一提示）
func uploadAdminDir(cfg *config.Config) (string, bool) {
	if cfg == nil || strings.TrimSpace(cfg.UploadDir) == "" {
		return "", false
	}
	return cfg.UploadDir, true
}

// uploadAdminLoad 扫描目录 + 反查 im_file 建 60 秒缓存（归口，stats 与 files 共用保证口径一致）
func uploadAdminLoad(cfg *config.Config) ([]uploadAdminFileRow, map[string]uploadAdminFileRow, error) {
	uploadAdminCache.Lock()
	defer uploadAdminCache.Unlock()
	if uploadAdminCache.rows != nil && time.Since(uploadAdminCache.at) < 60*time.Second {
		return uploadAdminCache.rows, uploadAdminCache.byName, nil
	}

	dir, ok := uploadAdminDir(cfg)
	if !ok {
		return nil, nil, errAdminUploadDirEmpty
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}

	// 与 fileCleanupOnce 同口径：只看一层常规文件（子目录含分片临时目录 tmp_chunks 永不涉及）
	type diskItem struct {
		name string
		size int64
		mod  time.Time
	}
	items := make([]diskItem, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		items = append(items, diskItem{name: e.Name(), size: info.Size(), mod: info.ModTime()})
	}

	// im_file 反查：一次拉取目录内命中的全部传输记录（file_path = /static/upload/<name>）
	urlByDisk := make(map[string]string, len(items))
	names := make([]string, 0, len(items))
	for _, it := range items {
		u := "/static/upload/" + it.name
		urlByDisk[u] = it.name
		names = append(names, u)
	}
	recByURL := make(map[string]model.FileRecord, len(items))
	if len(names) > 0 {
		var recs []model.FileRecord
		if err := store.DB.Where("file_path IN ?", names).
			Select("file_path", "file_name", "from_user", "to_user", "status").
			Find(&recs).Error; err == nil {
			for _, r := range recs {
				recByURL[r.FilePath] = r
			}
		} // 查询失败不阻断视图：降级为全部未关联，界面仍可看磁盘实况
	}

	// 保留期基准（与 fileCleanupOnce 相同公式）；-2 表示清理未启用（retention<0）
	retention := cfg.FileRetentionDays
	enabled := retention >= 0
	now := time.Now()
	rows := make([]uploadAdminFileRow, 0, len(items))
	byName := make(map[string]uploadAdminFileRow, len(items))
	for _, it := range items {
		lower := strings.ToLower(it.name)
		ext := filepath.Ext(lower)
		rec, hasRec := recByURL["/static/upload/"+it.name]

		category := "orphan"
		switch {
		case hasRec:
			category = "chat"
		case hasFeaturePrefix(lower):
			category = "feature"
		}

		// 剩余保留天数：仅非图片扩展 + 白名单命名适用（清理口径）；其余永存/免疫
		retain := -1
		if enabled && !uploadImageExts[ext] && uploadAdminFilenameRe.MatchString(it.name) {
			left := retention - int(now.Sub(it.mod).Hours()/24)
			if left < 0 {
				left = 0 // 已超期待下一轮清理（最多再等 6 小时）
			}
			retain = left
		} else if !enabled {
			retain = -2
		}

		row := uploadAdminFileRow{
			Name: it.name, Size: it.size, Ext: ext, Category: category,
			Status: -1, ModTime: it.mod.Format("2006-01-02 15:04"), RetainDays: retain,
		}
		if hasRec {
			row.OrigName = rec.FileName
			row.Owner = rec.FromUser + " → " + rec.ToUser
			row.Status = int(rec.Status)
		}
		rows = append(rows, row)
		byName[it.name] = row
	}

	uploadAdminCache.rows = rows
	uploadAdminCache.byName = byName
	uploadAdminCache.at = time.Now()
	return rows, byName, nil
}

// errAdminUploadDirEmpty 上传目录未配置（cfg.UploadDir 为空）

func hasFeaturePrefix(name string) bool {
	for _, p := range uploadAdminFeaturePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// handleAdminUploadStats GET /admin/api/upload/stats 聊天附件总览
func (s *Server) handleAdminUploadStats(w http.ResponseWriter, r *http.Request) {
	rows, _, err := uploadAdminLoad(s.cfg)
	if err == errAdminUploadDirEmpty {
		adminFail(w, http.StatusInternalServerError, "上传目录未配置")
		return
	}
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "目录扫描失败")
		return
	}
	var totalSize, chatN, featureN, orphanN, imgN int64
	for _, r0 := range rows {
		totalSize += r0.Size
		switch r0.Category {
		case "chat":
			chatN++
		case "feature":
			featureN++
		default:
			orphanN++
		}
		if uploadImageExts[r0.Ext] {
			imgN++
		}
	}
	adminJSON(w, map[string]interface{}{
		"total_size":     totalSize,
		"file_count":     int64(len(rows)),
		"chat_count":     chatN,
		"feature_count":  featureN,
		"orphan_count":   orphanN,
		"image_count":    imgN,
		"retention_days": s.cfg.FileRetentionDays,
	})
}

// handleAdminUploadFiles GET /admin/api/upload/files 聊天附件分页列表
// 参数：page/page_size(≤100)/keyword(文件名或原始名包含)/category(chat|feature|orphan|image)/sort(time_desc|time_asc|size_desc|size_asc)
func (s *Server) handleAdminUploadFiles(w http.ResponseWriter, r *http.Request) {
	rows, _, err := uploadAdminLoad(s.cfg)
	if err == errAdminUploadDirEmpty {
		adminFail(w, http.StatusInternalServerError, "上传目录未配置")
		return
	}
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "目录扫描失败")
		return
	}

	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	sortKey := r.URL.Query().Get("sort")

	// 内存过滤（磁盘条目量级可控，管理端低频）
	filtered := make([]uploadAdminFileRow, 0, len(rows))
	for _, r0 := range rows {
		if category == "image" && !uploadImageExts[r0.Ext] {
			continue
		}
		if (category == "chat" || category == "feature" || category == "orphan") && r0.Category != category {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(r0.Name), strings.ToLower(keyword)) &&
			!strings.Contains(strings.ToLower(r0.OrigName), strings.ToLower(keyword)) {
			continue
		}
		filtered = append(filtered, r0)
	}
	switch sortKey {
	case "time_asc":
		sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].ModTime < filtered[j].ModTime })
	case "size_desc":
		sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].Size > filtered[j].Size })
	case "size_asc":
		sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].Size < filtered[j].Size })
	default: // time_desc 默认
		sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].ModTime > filtered[j].ModTime })
	}

	total := len(filtered)
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	start := (page - 1) * pageSize
	if start > total {
		start = total
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	adminJSON(w, map[string]interface{}{
		"list": filtered[start:end], "total": total, "page": page, "page_size": pageSize,
	})
}

// handleAdminUploadDelete POST /admin/api/upload/delete
// 入参：{names:["x.png",...]} 按名删除（≤200，只接受纯文件名），或 {orphans:true} 一键清理全部未关联
// 物理删除（与保留清理同语义）；不删 im_file 审计记录（前端消息卡片按「文件已过期」灰显）
func (s *Server) handleAdminUploadDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Names   []string `json:"names"`
		Orphans bool     `json:"orphans"`
	}
	// 请求体解析（与 admindrive.go 同款直解析；空体/坏 JSON 统一 400）
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}

	_, byName, err := uploadAdminLoad(s.cfg)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "目录扫描失败")
		return
	}
	dir, ok := uploadAdminDir(s.cfg)
	if !ok {
		adminFail(w, http.StatusInternalServerError, "上传目录未配置")
		return
	}

	// 目标文件名归口：orphans 模式展开全部未关联；否则校验纯文件名（防路径穿越）
	targets := make([]string, 0, len(req.Names))
	if req.Orphans {
		for name, r0 := range byName {
			if r0.Category == "orphan" {
				targets = append(targets, name)
			}
		}
	} else {
		if len(req.Names) == 0 {
			adminFail(w, http.StatusBadRequest, "未选择文件")
			return
		}
		if len(req.Names) > 200 {
			adminFail(w, http.StatusBadRequest, "单次最多操作 200 项")
			return
		}
		seen := make(map[string]bool, len(req.Names))
		for _, n := range req.Names {
			n = strings.TrimSpace(n)
			// 只接受纯文件名：禁止路径分隔符与父目录引用
			if n == "" || strings.ContainsAny(n, "/\\") || strings.Contains(n, "..") || n != filepath.Base(n) {
				adminFail(w, http.StatusBadRequest, "非法文件名: "+n)
				return
			}
			if seen[n] {
				continue
			}
			seen[n] = true
			targets = append(targets, n)
		}
	}

	deleted, failed := 0, 0
	var freedBytes int64
	for _, name := range targets {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			failed++
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			failed++
			continue
		}
		deleted++
		freedBytes += info.Size()
	}

	// 删除成功即失效缓存（下次请求重扫，保证列表/总览即时一致）
	uploadAdminCache.Lock()
	uploadAdminCache.rows = nil
	uploadAdminCache.byName = nil
	uploadAdminCache.at = time.Time{}
	uploadAdminCache.Unlock()

	adminJSON(w, map[string]interface{}{"deleted": deleted, "failed": failed, "freed_bytes": freedBytes})
}
