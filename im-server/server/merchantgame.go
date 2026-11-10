package server

// ===== 商户独立后台·游戏/公告/版本自助管理（商户独立后台开发文档 §3.3） =====
//
// 与管理端共用清洗 helper 与版本合并链路（gameadmin.go 归口），差异仅在：
//   1. 身份：merchantGuard（role=2 + 商户启用），归属 merchantOwnGame SQL 层隔离
//   2. 字段白名单：商户仅可改对外字段 + 汇率/档位/网关绑定；运营字段（联机/存档/种子/owner/audit）拒绝
//   3. 审核状态机：新增/编辑对外字段 → audit=1 待审核；通过(audit=2)后可自主上架；下架随时

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// merchantImgURLClean 商户图片 URL 清洗（封面/头图）：仅接受站内 /static/upload/games/ 前缀相对路径
// （商户上传图片通道 handleAdminGameImage 落位前缀），禁外链/穿越；空串合法（=未设置）
func merchantImgURLClean(u string) (string, error) {
	u = strings.TrimSpace(u)
	if u == "" {
		return "", nil
	}
	if len(u) > 512 || strings.Contains(u, "\\") || strings.Contains(u, "..") ||
		!strings.HasPrefix(u, "/static/upload/games/") {
		return "", fmt.Errorf("图片地址非法（须为站内 /static/upload/games/ 路径）")
	}
	return u, nil
}

// merchantScreenshotsClean 商户截图清单清洗：JSON 字符串数组（每项经 merchantImgURLClean），≤12 张
func merchantScreenshotsClean(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "[]", nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return "", fmt.Errorf("screenshots 须为字符串数组")
	}
	if len(arr) > 12 {
		return "", fmt.Errorf("截图最多 12 张")
	}
	out := make([]string, 0, len(arr))
	for _, u := range arr {
		c, err := merchantImgURLClean(u)
		if err != nil {
			return "", err
		}
		if c != "" {
			out = append(out, c)
		}
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// merchantGameReq 商户游戏字段白名单（对外字段 + 汇率/档位；运营字段一律不在此结构，
// 结构体未覆盖即天然拒绝——商户接口字段面收口归口此处）
type merchantGameReq struct {
	Name        string  `json:"name"`
	Slug        string  `json:"slug"`
	ShortDesc   string  `json:"short_desc"`
	Description string  `json:"description"`
	Cover       string  `json:"cover"`
	Banner      string  `json:"banner"`
	Screenshots string  `json:"screenshots"`
	Tags        string  `json:"tags"`
	Developer   string  `json:"developer"`
	Publisher   string  `json:"publisher"`
	Price       float64 `json:"price"`
	LaunchExe   string  `json:"launch_exe"`
	LaunchName  string  `json:"launch_name"`
	LaunchArgs  string  `json:"launch_args"`
	// 积分赞助配置（拍板 3：商户可自配汇率/档位，管理员可改）
	RechargeEnabled  bool    `json:"recharge_enabled"`
	RechargeGw       string  `json:"recharge_gw"`
	RechargeRate     float64 `json:"recharge_rate"`
	RechargeTiers    string  `json:"recharge_tiers"`
	RechargeDailyMax float64 `json:"recharge_daily_max"`
	// 下载方式（商户白名单：0=HTTP 服务端分发[默认] 3=HTTP·商户直连[自带文件服务器]；
	// 1/2 BT 通道归管理员）。直连需配套 direct_base_url
	DownloadMethod int8   `json:"download_method"`
	DirectBaseURL  string `json:"direct_base_url"`
}

// merchantGameBaseClean 白名单公共清洗（创建/更新同口径）：返回错误即拒绝。
// 充值配置写入 g 对应字段并经 rechargeGameCfgClean 归一（与管理端同清洗器）；
// 下载方式 0/3 解析（BT 归管理员）与直连 base_url 校验归口本函数
func (s *Server) merchantGameBaseClean(g *model.Game, req *merchantGameReq) error {
	g.Name = strings.TrimSpace(req.Name)
	if g.Name == "" {
		return fmt.Errorf("游戏名称不能为空")
	}
	if utf8.RuneCountInString(g.Name) > 128 {
		return fmt.Errorf("游戏名称过长（最多 128 字）")
	}
	if utf8.RuneCountInString(req.ShortDesc) > 255 {
		return fmt.Errorf("一句话简介过长（最多 255 字）")
	}
	g.ShortDesc = strings.TrimSpace(req.ShortDesc)
	if utf8.RuneCountInString(req.Description) > 20000 {
		return fmt.Errorf("详细介绍过长（最多 20000 字）")
	}
	g.Description = strings.TrimSpace(req.Description)
	if utf8.RuneCountInString(req.Tags) > 255 {
		return fmt.Errorf("标签过长（最多 255 字）")
	}
	g.Tags = strings.TrimSpace(req.Tags)
	if utf8.RuneCountInString(req.Developer) > 64 || utf8.RuneCountInString(req.Publisher) > 64 {
		return fmt.Errorf("开发商/发行商过长（最多 64 字）")
	}
	g.Developer = strings.TrimSpace(req.Developer)
	g.Publisher = strings.TrimSpace(req.Publisher)
	if req.Price < 0 {
		return fmt.Errorf("售价不能为负数")
	}
	g.Price = req.Price
	cover, err := merchantImgURLClean(req.Cover)
	if err != nil {
		return err
	}
	g.Cover = cover
	banner, err := merchantImgURLClean(req.Banner)
	if err != nil {
		return err
	}
	g.Banner = banner
	ss, err := merchantScreenshotsClean(req.Screenshots)
	if err != nil {
		return err
	}
	g.Screenshots = ss
	// 启动程序（商户自己的游戏，启动配置由商户提供；清洗归口复用管理端 helper）
	if rawExe := strings.TrimSpace(req.LaunchExe); rawExe != "" {
		g.LaunchExe = gameRelPathClean(rawExe)
		if g.LaunchExe == "" {
			return fmt.Errorf("启动程序路径非法（须为安装目录内的相对路径，如 bin/game.exe）")
		}
	}
	g.LaunchName = gameLaunchNameClean(req.LaunchName)
	g.LaunchArgs = gameLaunchArgsClean(req.LaunchArgs)
	// 积分赞助配置（网关名/汇率/日限额/档位归一，与管理端同口径）
	g.RechargeEnabled = req.RechargeEnabled
	g.RechargeGw = strings.ToLower(strings.TrimSpace(req.RechargeGw))
	g.RechargeRate = req.RechargeRate
	g.RechargeTiers = req.RechargeTiers
	g.RechargeDailyMax = req.RechargeDailyMax
	if err := rechargeGameCfgClean(g); err != nil {
		return err
	}
	// 下载方式（商户白名单 0/3，BT 1/2 归管理员）：直连需有效 base_url（https 归口
	// directHTTPRequired——商户后台属生产入口，恒强制 https）
	switch req.DownloadMethod {
	case 0:
		g.DownloadMethod = 0
		g.DirectBaseURL = ""
	case 3:
		g.DownloadMethod = 3
		g.DirectBaseURL = gameDirectBaseURLClean(req.DirectBaseURL, s.directHTTPRequired())
		if g.DirectBaseURL == "" {
			return fmt.Errorf("直连 HTTP 模式必须填写有效的文件服务器根地址（https://...，禁空白/.. /查询串）")
		}
	default:
		g.DownloadMethod = 0
		g.DirectBaseURL = ""
	}
	return nil
}

// handleMerchantProfile 商户资料（含分成比例，赞助统计页展示口径参数）
// 存储配额三字段（安全加固）：商户自助掌握已用/总量/占比——版本上架触发配额拒绝前可自查腾额度；
// quota=-1（不限）时 percent 下发 null，前端显示"不限量"
func (s *Server) handleMerchantProfile(w http.ResponseWriter, r *http.Request) {
	me := merchantUserFromCtx(r)
	var m model.Merchant
	if err := store.DB.Where("username = ?", me).First(&m).Error; err != nil {
		adminFail(w, http.StatusNotFound, "商户资料不存在")
		return
	}
	var gameCnt, pendingCnt int64
	store.DB.Model(&model.Game{}).Where("owner_username = ?", me).Count(&gameCnt)
	store.DB.Model(&model.Game{}).Where("owner_username = ? AND audit_status = ?", me, model.GameAuditPending).Count(&pendingCnt)
	used := merchantQuotaUsed(me)
	quota := s.merchantQuotaLimit(me) // 专属分配优先，未分配跟随全局（管理员后台可改，商户端即时跟随）
	var percent interface{}
	if quota > 0 {
		percent = math.Round(float64(used)/float64(quota)*1000) / 10
	}
	fileLimit := s.merchantFileLimit(me)
	adminJSON(w, map[string]interface{}{
		"username": me, "name": m.Name, "commission_rate": m.CommissionRate,
		"game_count": gameCnt, "pending_count": pendingCnt,
		"storage_used_bytes": used, "storage_quota_bytes": quota, "storage_used_percent": percent,
		"max_files_per_version": fileLimit, // 实际生效的文件清单上限（-1=不限）
	})
}

// handleMerchantGameList 商户游戏列表（全部审核状态，商户自查）
func (s *Server) handleMerchantGameList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.Game{}).Where("owner_username = ?", me)
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		db = db.Where("name LIKE ? OR slug LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var games []model.Game
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&games)
	list := make([]map[string]interface{}, 0, len(games))
	for _, g := range games {
		// 商户列表按"编辑回填全量"口径下发（商户端无独立详情接口，列表即数据源；
		// owner/audit 审计字段与 GameSecret 等服务端私有项绝不下发）
		list = append(list, map[string]interface{}{
			"id": g.ID, "slug": g.Slug, "name": g.Name, "short_desc": g.ShortDesc, "cover": g.Cover,
			"description": g.Description, "screenshots": g.Screenshots, "tags": g.Tags,
			"developer": g.Developer, "publisher": g.Publisher, "price": g.Price,
			"launch_exe": g.LaunchExe, "launch_name": g.LaunchName, "launch_args": g.LaunchArgs,
			// 下载方式与直连地址（商户直连·编辑回填数据源；base_url 可下发——本就属商户自己填写）
			"download_method": g.DownloadMethod, "direct_base_url": g.DirectBaseURL,
			"status": g.Status, "audit_status": g.AuditStatus, "audit_remark": g.AuditRemark,
			"audit_time":       g.AuditTime,
			"recharge_enabled": g.RechargeEnabled, "recharge_rate": g.RechargeRate,
			"recharge_tiers_raw": g.RechargeTiers, "recharge_gw": g.RechargeGw,
			"recharge_daily_max": g.RechargeDailyMax,
			"latest_version":     g.LatestVersion, "size_bytes": g.SizeBytes,
			"create_time": g.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// handleMerchantGameCreate 商户新增游戏（audit=1 待审核；status=1 预置下架——
// 审核通过后也保持下架，商户自主决定何时上架/下架；玩家侧过滤墙保证待审核态不可见）
func (s *Server) handleMerchantGameCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	var req merchantGameReq
	if err := jsonDecodeLimit(w, r, &req, 65536); err != nil {
		return
	}
	g := model.Game{}
	if err := s.merchantGameBaseClean(&g, &req); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	g.Slug = strings.ToLower(strings.TrimSpace(req.Slug))
	if !gameSlugRe.MatchString(g.Slug) {
		adminFail(w, http.StatusBadRequest, "slug 仅允许小写字母/数字/下划线/中划线（1-64 位）")
		return
	}
	g.OwnerUsername = merchantUserFromCtx(r)
	g.AuditStatus = model.GameAuditPending
	g.Status = 1 // 预置下架：审核通过后也保持下架，商户自主点"申请上架"才上线
	g.GameSecret = gameRandomSecret()
	g.ID = 0
	if err := store.DB.Create(&g).Error; err != nil {
		adminFail(w, http.StatusConflict, "slug 已存在或保存失败")
		return
	}
	logger.Info("商户新增游戏: %s (%s), 商户=%s（待审核）", g.Name, g.Slug, me)
	adminJSON(w, map[string]interface{}{"id": g.ID, "audit_status": g.AuditStatus, "status": g.Status})
}

// handleMerchantGameUpdate 商户编辑游戏（对外字段白名单；改后回待审核——已过审内容对玩家
// 保持展示直到新内容过审，见玩家侧过滤语义）
func (s *Server) handleMerchantGameUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	g, ok := merchantOwnGame(me, id)
	if !ok {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	// 隔离态游戏禁止编辑（避免商户绕过隔离审核直接回到待审核）
	if g.AuditStatus == model.GameAuditQuarantined {
		adminFail(w, http.StatusBadRequest, "该游戏处于病毒隔离库，需管理员通过后才能编辑；请耐心等待审核结果")
		return
	}
	var req merchantGameReq
	if err := jsonDecodeLimit(w, r, &req, 65536); err != nil {
		return
	}
	if strings.TrimSpace(req.Slug) != "" && strings.ToLower(strings.TrimSpace(req.Slug)) != g.Slug {
		adminFail(w, http.StatusBadRequest, "slug 不可修改（已作为安装目录锚点）")
		return
	}
	u := model.Game{}
	if err := s.merchantGameBaseClean(&u, &req); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now()
	updates := map[string]interface{}{
		"name": u.Name, "short_desc": u.ShortDesc, "description": u.Description,
		"cover": u.Cover, "banner": u.Banner, "screenshots": u.Screenshots, "tags": u.Tags,
		"developer": u.Developer, "publisher": u.Publisher, "price": u.Price,
		"launch_exe": u.LaunchExe, "launch_name": u.LaunchName, "launch_args": u.LaunchArgs,
		"recharge_enabled":   u.RechargeEnabled,
		"recharge_gw":        u.RechargeGw,
		"recharge_rate":      u.RechargeRate,
		"recharge_tiers":     u.RechargeTiers,
		"recharge_daily_max": u.RechargeDailyMax,
		// 下载方式与直连地址（安全加固·商户直连）：变更随对外字段统一回待审核
		"download_method": u.DownloadMethod,
		"direct_base_url": u.DirectBaseURL,
		// 编辑对外字段即回待审核（官方免审态 0 不会出现在商户名下，防御性归一到 1）；清空旧驳回理由
		"audit_status": model.GameAuditPending,
		"audit_remark": "",
		"audit_time":   &now,
	}
	if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	logger.Info("商户编辑游戏: %s (%s), 商户=%s（回待审核）", g.Name, g.Slug, me)
	adminJSON(w, map[string]interface{}{"ok": true, "audit_status": model.GameAuditPending})
}

// handleMerchantGameStatus 商户上架/下架（上架仅已过审；下架随时）
func (s *Server) handleMerchantGameStatus(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	g, ok := merchantOwnGame(me, id)
	if !ok {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var req struct {
		Status int8 `json:"status"`
	}
	if err := jsonDecodeLimit(w, r, &req, 512); err != nil {
		return
	}
	if req.Status != 0 && req.Status != 1 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if req.Status == 0 && g.AuditStatus != model.GameAuditApproved {
		adminFail(w, http.StatusForbidden, "游戏尚未审核通过，不能上架")
		return
	}
	if err := store.DB.Model(&model.Game{}).Where("id = ?", g.ID).Update("status", req.Status).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "操作失败")
		return
	}
	logger.Info("商户变更游戏状态: %s (%s) → %d, 商户=%s", g.Name, g.Slug, req.Status, me)
	adminJSON(w, map[string]interface{}{"ok": true, "status": req.Status})
}

// ===== 公告（复用 GameNotice，归属校验） =====

// handleMerchantNoticesGet 商户公告列表（可按 game_id 过滤，仅自己游戏）
func (s *Server) handleMerchantNoticesGet(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	gid, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	// 归属锚点：自己名下游戏 ID 集合（商户游戏量级小，内存过滤最简且天然隔离）
	var myIDs []uint
	store.DB.Model(&model.Game{}).Where("owner_username = ?", me).Pluck("id", &myIDs)
	if len(myIDs) == 0 {
		adminJSON(w, map[string]interface{}{"list": []model.GameNotice{}, "total": 0, "page": page, "size": size})
		return
	}
	db := store.DB.Model(&model.GameNotice{}).Where("game_id IN ?", myIDs)
	if gid > 0 {
		db = db.Where("game_id = ?", gid)
	}
	var total int64
	db.Count(&total)
	var list []model.GameNotice
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&list)
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// merchantNoticeClean 公告字段清洗（商户与管理端同口径；game_id 归属由调用方校验）
func merchantNoticeClean(req *struct {
	GameID  uint   `json:"game_id"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Images  string `json:"images"`
	Cover   string `json:"cover"`
	Layout  string `json:"layout"`
}, me string) (imgs, cover string, errCode int, err error) {
	req.Title = strings.TrimSpace(req.Title)
	req.Content = strings.TrimSpace(req.Content)
	if req.GameID == 0 {
		return "", "", http.StatusBadRequest, fmt.Errorf("参数错误")
	}
	if utf8.RuneCountInString(req.Title) > 64 {
		return "", "", http.StatusBadRequest, fmt.Errorf("公告标题不能超过 64 字")
	}
	if utf8.RuneCountInString(req.Content) > 2000 {
		return "", "", http.StatusBadRequest, fmt.Errorf("公告内容不能超过 2000 字")
	}
	imgs, lerr := gameNoticeImagesClean(req.Images)
	if lerr != nil {
		return "", "", http.StatusBadRequest, lerr
	}
	cover, err = merchantImgURLClean(req.Cover)
	if err != nil {
		return "", "", http.StatusBadRequest, err
	}
	if req.Title == "" && req.Content == "" && imgs == "" {
		return "", "", http.StatusBadRequest, fmt.Errorf("标题、内容、图片至少填写一项")
	}
	// 归属校验：目标游戏必须属于当前商户
	if _, ok := merchantOwnGame(me, uint64(req.GameID)); !ok {
		return "", "", http.StatusNotFound, fmt.Errorf("游戏不存在")
	}
	return imgs, cover, 0, nil
}

// handleMerchantNoticeCreate 商户发布公告
func (s *Server) handleMerchantNoticeCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	var req struct {
		GameID  uint   `json:"game_id"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Images  string `json:"images"`
		Cover   string `json:"cover"`
		Layout  string `json:"layout"`
	}
	if err := jsonDecodeLimit(w, r, &req, 65536); err != nil {
		return
	}
	imgs, cover, code, err := merchantNoticeClean(&req, me)
	if err != nil {
		adminFail(w, code, err.Error())
		return
	}
	n := model.GameNotice{GameID: req.GameID, Title: req.Title, Content: req.Content, Images: imgs, Cover: cover, Layout: gameNoticeLayoutClean(req.Layout)}
	if err := store.DB.Create(&n).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "发布失败")
		return
	}
	logger.Info("商户发布游戏公告: game=%d title=%s, 商户=%s", req.GameID, req.Title, me)
	adminJSON(w, map[string]interface{}{"ok": true, "id": n.ID})
}

// handleMerchantNoticeUpdate 商户编辑公告（公告归属其游戏，越权 404）
func (s *Server) handleMerchantNoticeUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var n model.GameNotice
	if err := store.DB.First(&n, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	if _, ok := merchantOwnGame(me, uint64(n.GameID)); !ok {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	var req struct {
		Title   string `json:"title"`
		Content string `json:"content"`
		Images  string `json:"images"`
		Cover   string `json:"cover"`
		Layout  string `json:"layout"`
	}
	if err := jsonDecodeLimit(w, r, &req, 65536); err != nil {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Content = strings.TrimSpace(req.Content)
	if utf8.RuneCountInString(req.Title) > 64 {
		adminFail(w, http.StatusBadRequest, "公告标题不能超过 64 字")
		return
	}
	if utf8.RuneCountInString(req.Content) > 2000 {
		adminFail(w, http.StatusBadRequest, "公告内容不能超过 2000 字")
		return
	}
	imgs, ierr := gameNoticeImagesClean(req.Images)
	if ierr != nil {
		adminFail(w, http.StatusBadRequest, ierr.Error())
		return
	}
	cover, cerr := merchantImgURLClean(req.Cover)
	if cerr != nil {
		adminFail(w, http.StatusBadRequest, cerr.Error())
		return
	}
	if req.Title == "" && req.Content == "" && imgs == "" {
		adminFail(w, http.StatusBadRequest, "标题、内容、图片至少填写一项")
		return
	}
	if imgs != "" {
		var arr []string
		if json.Unmarshal([]byte(imgs), &arr) == nil && len(arr) > 0 {
			cover = arr[0]
		}
	}
	if err := store.DB.Model(&model.GameNotice{}).Where("id = ?", id).Updates(map[string]interface{}{
		"title": req.Title, "content": req.Content, "images": imgs, "cover": cover,
		"layout": gameNoticeLayoutClean(req.Layout),
	}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	logger.Info("商户编辑游戏公告: id=%d game=%d, 商户=%s", id, n.GameID, me)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleMerchantNoticeDelete 商户删除公告（归属其游戏）
func (s *Server) handleMerchantNoticeDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var n model.GameNotice
	if err := store.DB.First(&n, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	if _, ok := merchantOwnGame(me, uint64(n.GameID)); !ok {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	store.DB.Delete(&n)
	logger.Info("商户删除游戏公告: id=%d game=%d, 商户=%s", id, n.GameID, me)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// ===== 版本（复用合并链路，归属校验） =====

// handleMerchantGameVersions 商户版本列表
func (s *Server) handleMerchantGameVersions(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	g, ok := merchantOwnGame(me, id)
	if !ok {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var versions []model.GameVersion
	store.DB.Where("game_id = ?", g.ID).Order("id DESC").Find(&versions)
	verList := make([]map[string]interface{}, 0, len(versions))
	for _, v := range versions {
		verList = append(verList, map[string]interface{}{
			"id": v.ID, "version": v.Version, "size_bytes": v.SizeBytes, "file_count": v.FileCount,
			"changelog": v.Changelog, "create_time": v.CreateTime.Format("2006-01-02 15:04"),
			"pack_type": v.PackType, "pack_size": v.PackSize, "base_version": v.BaseVersion,
			"register_state": v.RegisterState, "register_error": v.RegisterError,
		})
	}
	adminJSON(w, map[string]interface{}{"versions": verList, "latest_version": g.LatestVersion})
}

// handleMerchantVersionFilelist 商户版本清单导出（GamePatchTool -base-list 基准数据源）：
// 按 GameFile 行输出 `0|rel_path|sha256|size` 排序文本（与 FileListGenerator 清单格式同构）。
// 补丁版（pack_type=3）导出的是登记时合成的最终完整清单——可直接作为下一层补丁的基准
func (s *Server) handleMerchantVersionFilelist(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	g, ok := merchantOwnGame(me, id)
	if !ok {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var v model.GameVersion
	// register_state=0：登记中/失败版本 GameFile 行为空（或已删除），导出空清单会误导商户当补丁基准
	if err := store.DB.Where("game_id = ? AND version = ? AND register_state = 0", g.ID, strings.TrimSpace(r.PathValue("ver"))).First(&v).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本不存在或未就绪")
		return
	}
	s.gameVersionFilelistText(w, &v)
}

// handleMerchantGameToolDownload 商户补丁工具（gametool.exe）下载：工具与 im-server.exe 同目录
// 托管（go build 产物同落 bin/，零部署步骤），缺失时明确提示未随服务端部署
func (s *Server) handleMerchantGameToolDownload(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	if merchantUserFromCtx(r) == "" {
		adminFail(w, http.StatusUnauthorized, "请先登录商户账号")
		return
	}
	gameToolDownloadServe(w, r)
}

// gameToolDownloadServe gametool.exe 下载公共核心（管理端/商户端共用）：
// os.Executable 同目录定位（无用户输入参与路径，无穿越面），ServeContent 支持断点续传
func gameToolDownloadServe(w http.ResponseWriter, r *http.Request) {
	exePath, err := os.Executable()
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "服务端路径解析失败")
		return
	}
	toolPath := filepath.Join(filepath.Dir(exePath), "gametool.exe")
	f, err := os.Open(toolPath)
	if err != nil {
		adminFail(w, http.StatusNotFound, "补丁工具未随服务端部署（gametool.exe 与 im-server.exe 不在同目录），请联系管理员")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "工具文件读取失败")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\"gametool.exe\"")
	http.ServeContent(w, r, "gametool.exe", st.ModTime(), f)
}

// handleMerchantVersionCreate 商户版本上架（共享核心 gameVersionCreateCore，前置归属校验）
func (s *Server) handleMerchantVersionCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	g, ok := merchantOwnGame(me, id)
	if !ok {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	s.gameVersionCreateCore(w, r, &g, me)
}

// handleMerchantVersionDelete 商户删除版本（共享核心，前置归属校验）
func (s *Server) handleMerchantVersionDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	vid, _ := strconv.ParseUint(r.PathValue("vid"), 10, 64)
	var v model.GameVersion
	// register_state != 1：登记中版本不让删——Phase 2 goroutine 持有版本锁，
	// 此时删行 goroutine 会对不存在的行 Updates（0 行影响，但语义上"删成功"会误导）
	if err := store.DB.Where("id = ? AND register_state <> 1", vid).First(&v).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本不存在或登记中无法删除")
		return
	}
	g, ok := merchantOwnGame(me, uint64(v.GameID))
	if !ok {
		adminFail(w, http.StatusNotFound, "版本不存在")
		return
	}
	s.gameVersionDeleteCore(w, &v, &g, me)
}
