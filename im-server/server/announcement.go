package server

// ===== 阶段一百四十四：公司公告与动态模块 =====
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 发布侧：后台管理界面（admin.html 公告管理视图）走 /admin/api/announcements*，
//     复用 adminGuard 鉴权（仅管理员可发布/编辑/撤回/删除）
//  2. 富文本安全：后台编辑器产出的 HTML 一律经白名单消毒（sanitizeAnnouncementHTML）
//     后入库，客户端只渲染可信 HTML，杜绝存储型 XSS
//  3. 阅读侧：用户端 GET /api/announcements*（沿用 /api/kb 的 username 参数口径），
//     已读/签收记录服务端落库（im_announcement_read），多端一致
//  4. 实时提醒：发布成功即 WS 广播 84 帧（MsgTypeAnnouncementPush），在线客户端公告
//     图标亮红点；离线用户登录时拉取 /api/announcements/unread 补红点

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// RegisterAnnouncementRoutes 注册公告模块路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
func RegisterAnnouncementRoutes(s *Server) {
	// 管理端（复用后台会话鉴权）
	http.HandleFunc("GET /admin/api/announcements", s.adminGuard(s.handleAdminAnnouncementList))
	http.HandleFunc("GET /admin/api/announcements/{id}", s.adminGuard(s.handleAdminAnnouncementGet))
	http.HandleFunc("POST /admin/api/announcements", s.adminGuard(s.handleAdminAnnouncementCreate))
	http.HandleFunc("PUT /admin/api/announcements/{id}", s.adminGuard(s.handleAdminAnnouncementUpdate))
	http.HandleFunc("DELETE /admin/api/announcements/{id}", s.adminGuard(s.handleAdminAnnouncementDelete))
	http.HandleFunc("POST /admin/api/announcements/{id}/publish", s.adminGuard(s.handleAdminAnnouncementPublish))
	http.HandleFunc("POST /admin/api/announcements/{id}/withdraw", s.adminGuard(s.handleAdminAnnouncementWithdraw))
	http.HandleFunc("GET /admin/api/announcements/{id}/reads", s.adminGuard(s.handleAdminAnnouncementReads))
	http.HandleFunc("POST /admin/api/announcement/attach", s.adminGuard(s.handleAdminAnnouncementAttach))
	// 用户端（口径同 /api/kb：username 参数标识当前用户，只读 + 已读记录）
	http.HandleFunc("GET /api/announcements", s.handleAnnouncementList)
	http.HandleFunc("GET /api/announcements/unread", s.handleAnnouncementUnread)
	http.HandleFunc("GET /api/announcements/{id}", s.handleAnnouncementDetail)
	http.HandleFunc("POST /api/announcements/{id}/confirm", s.handleAnnouncementConfirm)
}

// ===== 富文本白名单消毒（存储型 XSS 防线，入库前归口执行） =====

// 允许保留的标签及白名单属性（其余标签剔除但保留内文，其余属性一律丢弃）
// 阶段一百四十四三期：span/p/div/td/th/img 开放 style 属性（经 annSafeStyle 白名单过滤，
// 支持颜色/字号/对齐/加粗等更多编辑样式；url()/expression 等 CSS 注入向量一律剔除）
var annAllowedTags = map[string][]string{
	"p": {"style"}, "br": {}, "hr": {}, "div": {"style"}, "span": {"style"},
	"b": {}, "strong": {}, "i": {}, "em": {}, "u": {}, "s": {},
	"ul": {}, "ol": {}, "li": {}, "h1": {}, "h2": {}, "h3": {}, "h4": {},
	"blockquote": {"style"}, "pre": {}, "code": {},
	"table": {"style"}, "thead": {}, "tbody": {}, "tr": {}, "th": {"style"}, "td": {"style"},
	"img": {"src", "alt", "width", "height", "style"},
	"a":   {"href", "target", "style"},
}

// 危险整块移除（含内容）：脚本/样式/嵌入对象；注释一并剔除
var (
	annReScript   = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	annReStyle    = regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	annReComment  = regexp.MustCompile(`(?s)<!--.*?-->`)
	annReEmbedTag = regexp.MustCompile(`(?i)</?(iframe|object|embed|form|input|button|select|textarea|link|meta|base)\b[^>]*>`)
	annReTag      = regexp.MustCompile(`(?is)<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*/?>`)
	annReAttr     = regexp.MustCompile(`([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)`)
)

// annSafeURL 链接白名单：仅 http/https 与站内相对路径，禁 javascript:/vbscript:/data:
func annSafeURL(raw string) bool {
	v := strings.ToLower(strings.TrimSpace(raw))
	v = strings.ReplaceAll(v, "\\", "")
	if v == "" {
		return true // 空值交由标签语义处理
	}
	for _, bad := range []string{"javascript:", "vbscript:", "data:"} {
		if strings.Contains(v, bad) {
			return false
		}
	}
	return strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") || strings.HasPrefix(v, "/") || strings.HasPrefix(v, "./") || strings.HasPrefix(v, "#")
}

// annSafeStyleDecl 内联样式一票否决向量（CSS 注入/IE 表达式/外链资源）
var annReStyleDecl = regexp.MustCompile(`(?i)url\s*\(|expression|behavior|@import|javascript:|vbscript:|<|>`)

// annSafeStyle 内联样式白名单归口（阶段一百四十四三期更多编辑样式的安全底线）：
// 仅放行颜色/字号/字重/对齐/装饰/背景色等展示型声明，含引号括号或危险向量的值整条丢弃
func annSafeStyle(raw string) string {
	raw = strings.ReplaceAll(raw, "\n", " ")
	if annReStyleDecl.MatchString(raw) {
		return ""
	}
	var kept []string
	for _, decl := range strings.Split(raw, ";") {
		kv := strings.SplitN(decl, ":", 2)
		if len(kv) != 2 {
			continue
		}
		prop := strings.ToLower(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		if val == "" || strings.ContainsAny(val, "\"'(){}") {
			continue
		}
		switch prop {
		case "color", "background-color", "font-size", "font-weight", "font-style",
			"text-align", "text-decoration", "text-indent", "line-height",
			"width", "height", "border", "border-collapse", "padding", "margin": // 阶段一百四十四三期补齐：表格/封面布局常用展示型声明（编辑器插入表格依赖 width/border/border-collapse/padding）
			kept = append(kept, prop+": "+val)
		}
	}
	return strings.Join(kept, "; ")
}

// sanitizeAnnouncementHTML 富文本消毒归口：仅保留白名单标签与属性，事件属性/危险链接一律剔除
func sanitizeAnnouncementHTML(html string) string {
	if strings.TrimSpace(html) == "" {
		return ""
	}
	out := annReScript.ReplaceAllString(html, "")
	out = annReStyle.ReplaceAllString(out, "")
	out = annReComment.ReplaceAllString(out, "")
	out = annReEmbedTag.ReplaceAllString(out, "")
	out = annReTag.ReplaceAllStringFunc(out, func(m string) string {
		parts := annReTag.FindStringSubmatch(m)
		if parts == nil {
			return ""
		}
		closing, tag, attrStr := parts[1] == "/", strings.ToLower(parts[2]), parts[3]
		allowAttrs, ok := annAllowedTags[tag]
		if !ok {
			return "" // 非白名单标签整体剔除（内文保留，仅去壳）
		}
		if closing {
			return "</" + tag + ">"
		}
		kept := ""
		for _, ap := range annReAttr.FindAllStringSubmatch(attrStr, -1) {
			name := strings.ToLower(ap[1])
			val := strings.Trim(ap[2], `"'`)
			if name == "src" || name == "href" {
				if !annSafeURL(val) {
					continue
				}
			}
			if name == "style" {
				val = annSafeStyle(val) // 阶段一百四十四三期：内联样式白名单过滤（更多编辑样式的安全底线）
				if val == "" {
					continue
				}
			}
			if strings.HasPrefix(name, "on") {
				continue // 事件属性一律剔除
			}
			allowed := false
			for _, a := range allowAttrs {
				if a == name {
					allowed = true
					break
				}
			}
			if !allowed {
				continue
			}
			kept += fmt.Sprintf(` %s="%s"`, name, strings.ReplaceAll(val, `"`, "&quot;"))
		}
		if tag == "a" && !strings.Contains(kept, "target=") {
			kept += ` target="_blank" rel="noopener noreferrer"` // 站外链接新窗口打开
		}
		return "<" + tag + kept + ">"
	})
	return strings.TrimSpace(out)
}

// ===== 管理端 =====

// annAttachPayload 公告保存请求的附件结构（前端整体提交，服务端整体替换）
type annAttachPayload struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

// annSaveBody 新建/编辑公告请求体
type annSaveBody struct {
	Title          string             `json:"title"`
	Category       string             `json:"category"`
	Cover          string             `json:"cover"`
	Digest         string             `json:"digest"`
	ContentHTML    string             `json:"content_html"`
	ContentType    string             `json:"content_type"`    // html/doc/link（阶段一百四十四三期：文档还是富文本归口）
	CardStyle      string             `json:"card_style"`      // standard/cover-left/cover-top/compact（卡牌样式归口）
	ExternalURL    string             `json:"external_url"`    // link 型目标地址（仅 http/https）
	OpenInBrowser  bool               `json:"open_in_browser"` // link 型是否用 PC 内置浏览器打开
	Stick          bool               `json:"stick"`
	RequireConfirm bool               `json:"require_confirm"`
	Status         int8               `json:"status"` // 0 存草稿 1 直接发布
	Attachments    []annAttachPayload `json:"attachments"`
}

// annValidCategory 分类合法校验
func annValidCategory(c string) bool {
	return c == model.AnnCategoryNotice || c == model.AnnCategoryNews || c == model.AnnCategoryRed
}

// annValidContentType 正文类型合法校验（html=富文本页 / doc=文档型 / link=链接型）
func annValidContentType(t string) bool {
	return t == "html" || t == "doc" || t == "link"
}

// annValidCardStyle 卡牌样式合法校验（客户端预设样式集归口，非法值回退 standard）
func annValidCardStyle(s string) bool {
	return s == "standard" || s == "cover-left" || s == "cover-top" || s == "compact"
}

// annReplaceAttachments 整体替换附件（编辑/新建共用；附件 URL 必须为本站静态资源，防外链注入）
func annReplaceAttachments(annID uint, list []annAttachPayload) {
	store.DB.Where("announcement_id = ?", annID).Delete(&model.AnnouncementAttachment{})
	for i, at := range list {
		if strings.TrimSpace(at.Name) == "" || !strings.HasPrefix(at.URL, "/static/upload/") {
			continue
		}
		store.DB.Create(&model.AnnouncementAttachment{
			AnnouncementID: annID,
			Name:           at.Name,
			URL:            at.URL,
			Size:           at.Size,
			SortID:         i,
		})
	}
}

// annFromPayload 公共字段装配归口（新建/编辑同口径；富文本此处消毒）
// 阶段一百四十四三期：正文类型/卡牌样式/链接型公告归口——link 型仅收 http(s) 地址并清空正文，
// doc 型以附件为主正文可空，html 型消毒富文本；卡牌样式非法值回退 standard（客户端零信任）
func annFromPayload(a *model.Announcement, body annSaveBody, publisher string) bool {
	body.Title = strings.TrimSpace(body.Title)
	if body.Title == "" || len([]rune(body.Title)) > 128 {
		return false
	}
	if !annValidCategory(body.Category) {
		return false
	}
	ct := body.ContentType
	if !annValidContentType(ct) {
		ct = "html"
	}
	if ct == "link" {
		url := strings.TrimSpace(body.ExternalURL)
		low := strings.ToLower(url)
		if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
			return false // 链接型必须 http/https（服务端校验归口，杜绝 javascript: 等注入向量）
		}
		a.ExternalURL = url
		a.OpenInBrowser = body.OpenInBrowser
		a.ContentHTML = ""
	} else {
		a.ExternalURL = ""
		a.OpenInBrowser = false
		a.ContentHTML = sanitizeAnnouncementHTML(body.ContentHTML)
	}
	style := body.CardStyle
	if !annValidCardStyle(style) {
		style = "standard"
	}
	a.ContentType = ct
	a.CardStyle = style
	a.Title = body.Title
	a.Category = body.Category
	a.Cover = strings.TrimSpace(body.Cover)
	a.Digest = strings.TrimSpace(body.Digest)
	a.Stick = body.Stick
	a.RequireConfirm = body.RequireConfirm
	a.Publisher = publisher
	return true
}

// handleAdminAnnouncementList 管理端公告列表（分类/状态/关键词筛选 + 分页 + 已读/签收/附件计数聚合）
func (s *Server) handleAdminAnnouncementList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.Announcement{})
	if c := q.Get("category"); c != "" && annValidCategory(c) {
		db = db.Where("category = ?", c)
	}
	if st := q.Get("status"); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 2 {
			db = db.Where("status = ?", v)
		}
	}
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		db = db.Where("title LIKE ?", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var list []model.Announcement
	if err := db.Order("stick DESC, id DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询公告失败")
		return
	}
	// 计数聚合（一次分组查询防 N+1）：已读数 / 签收数 / 附件数
	ids := make([]uint, 0, len(list))
	for _, a := range list {
		ids = append(ids, a.ID)
	}
	readCnt := map[uint]int64{}
	confirmCnt := map[uint]int64{}
	attachCnt := map[uint]int64{}
	if len(ids) > 0 {
		var rows []struct {
			AnnouncementID uint
			Cnt            int64
			Confirmed      int64
		}
		store.DB.Model(&model.AnnouncementRead{}).
			Select("announcement_id, COUNT(*) as cnt, COALESCE(SUM(confirmed),0) as confirmed").
			Where("announcement_id IN ?", ids).Group("announcement_id").Scan(&rows)
		for _, row := range rows {
			readCnt[row.AnnouncementID] = row.Cnt
			confirmCnt[row.AnnouncementID] = row.Confirmed
		}
		var arows []struct {
			AnnouncementID uint
			Cnt            int64
		}
		store.DB.Model(&model.AnnouncementAttachment{}).
			Select("announcement_id, COUNT(*) as cnt").
			Where("announcement_id IN ?", ids).Group("announcement_id").Scan(&arows)
		for _, row := range arows {
			attachCnt[row.AnnouncementID] = row.Cnt
		}
	}
	items := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		items = append(items, map[string]interface{}{
			"id":              a.ID,
			"title":           a.Title,
			"category":        a.Category,
			"cover":           a.Cover,
			"digest":          a.Digest,
			"status":          a.Status,
			"stick":           a.Stick,
			"require_confirm": a.RequireConfirm,
			"publisher":       a.Publisher,
			"publish_time":    a.PublishTime,
			"create_time":     a.CreateTime,
			"read_count":      readCnt[a.ID],
			"confirm_count":   confirmCnt[a.ID],
			"attach_count":    attachCnt[a.ID],
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

// handleAdminAnnouncementGet 管理端公告详情（编辑回填数据源：含正文与附件全量）
func (s *Server) handleAdminAnnouncementGet(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	var atts []model.AnnouncementAttachment
	store.DB.Where("announcement_id = ?", a.ID).Order("sort_id ASC").Find(&atts)
	adminJSON(w, map[string]interface{}{"announcement": a, "attachments": atts})
}

// handleAdminAnnouncementCreate 新建公告（status=1 时直接发布并实时推送）
func (s *Server) handleAdminAnnouncementCreate(w http.ResponseWriter, r *http.Request) {
	var body annSaveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	a := model.Announcement{}
	if !annFromPayload(&a, body, adminUserFromCtx(r)) {
		adminFail(w, http.StatusBadRequest, "标题/分类不合法")
		return
	}
	if body.Status == model.AnnStatusPublished {
		a.Status = model.AnnStatusPublished
		a.PublishTime = time.Now()
	}
	if err := store.DB.Create(&a).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存公告失败")
		return
	}
	annReplaceAttachments(a.ID, body.Attachments)
	if a.Status == model.AnnStatusPublished {
		s.pushAnnouncementPublish(&a)
	}
	logger.Info("公告已保存: id=%d 标题=%s 状态=%d 操作人=%s", a.ID, a.Title, a.Status, a.Publisher)
	adminJSON(w, map[string]interface{}{"id": a.ID})
}

// handleAdminAnnouncementUpdate 编辑公告（不改发布状态，发布/撤回走专用端点；已发布内容编辑即时生效）
func (s *Server) handleAdminAnnouncementUpdate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	var body annSaveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !annFromPayload(&a, body, a.Publisher) {
		adminFail(w, http.StatusBadRequest, "标题/分类不合法")
		return
	}
	if err := store.DB.Save(&a).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存公告失败")
		return
	}
	annReplaceAttachments(a.ID, body.Attachments)
	adminJSON(w, map[string]interface{}{"id": a.ID})
}

// handleAdminAnnouncementDelete 删除公告（主表 + 附件 + 已读记录一并清理）
func (s *Server) handleAdminAnnouncementDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	store.DB.Where("announcement_id = ?", a.ID).Delete(&model.AnnouncementAttachment{})
	store.DB.Where("announcement_id = ?", a.ID).Delete(&model.AnnouncementRead{})
	store.DB.Delete(&a)
	logger.Info("公告已删除: id=%d 标题=%s 操作人=%s", a.ID, a.Title, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminAnnouncementPublish 发布公告（幂等：重复发布不重复推送）
func (s *Server) handleAdminAnnouncementPublish(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	if a.Status != model.AnnStatusPublished {
		a.Status = model.AnnStatusPublished
		a.PublishTime = time.Now()
		a.Publisher = adminUserFromCtx(r)
		if err := store.DB.Save(&a).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "发布失败")
			return
		}
		s.pushAnnouncementPublish(&a)
		logger.Info("公告已发布: id=%d 标题=%s 操作人=%s", a.ID, a.Title, a.Publisher)
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminAnnouncementWithdraw 撤回公告（客户端立即不可见，数据保留可再发布）
func (s *Server) handleAdminAnnouncementWithdraw(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	if err := store.DB.Model(&model.Announcement{}).Where("id = ?", id).
		Update("status", model.AnnStatusWithdrawn).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "撤回失败")
		return
	}
	logger.Info("公告已撤回: id=%d 操作人=%s", id, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminAnnouncementReads 已读/签收统计（红头文件签收看板数据源）
func (s *Server) handleAdminAnnouncementReads(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	var reads []model.AnnouncementRead
	store.DB.Where("announcement_id = ?", a.ID).Order("create_time ASC").Find(&reads)
	items := make([]map[string]interface{}, 0, len(reads))
	for _, rd := range reads {
		items = append(items, map[string]interface{}{
			"username":    rd.Username,
			"confirmed":   rd.Confirmed,
			"create_time": rd.CreateTime,
		})
	}
	adminJSON(w, map[string]interface{}{"title": a.Title, "require_confirm": a.RequireConfirm, "reads": items})
}

// handleAdminAnnouncementAttach 公告附件上传（管理端专用；20MB 内直传，复用聊天静态资源目录）
func (s *Server) handleAdminAnnouncementAttach(w http.ResponseWriter, r *http.Request) {
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		adminFail(w, http.StatusBadRequest, "文件过大或解析失败")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "缺少文件")
		return
	}
	defer file.Close()
	if isDangerousFile(header.Filename) {
		adminFail(w, http.StatusBadRequest, "禁止上传可执行文件")
		return
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{
		".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
		".ppt": true, ".pptx": true, ".txt": true, ".md": true, ".csv": true,
		".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true,
	}
	if !allowed[ext] {
		adminFail(w, http.StatusBadRequest, "不支持的附件格式")
		return
	}
	// 存储目录（与聊天文件同规则：读配置，兜底基于 WebDir 推导）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		adminFail(w, http.StatusInternalServerError, "存储目录创建失败")
		return
	}
	buf := make([]byte, 4)
	rand.Read(buf)
	filename := fmt.Sprintf("ann_%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(buf), ext)
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	defer out.Close()
	size, err := io.Copy(out, file)
	if err != nil {
		os.Remove(dst)
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	adminJSON(w, map[string]interface{}{
		"url":  "/static/upload/" + filename,
		"name": header.Filename,
		"size": size,
	})
}

// ===== 实时推送 =====

// pushAnnouncementPublish 发布成功 WS 广播（在线客户端亮红点；离线用户登录补拉未读数）
func (s *Server) pushAnnouncementPublish(a *model.Announcement) {
	payload, _ := json.Marshal(map[string]interface{}{
		"id":           a.ID,
		"title":        a.Title,
		"category":     a.Category,
		"digest":       a.Digest,
		"publisher":    a.Publisher,
		"publish_time": a.PublishTime,
	})
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeAnnouncementPush,
		FromUser:  "system",
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	s.hub.Broadcast(data)
}

// ===== 用户端 =====

// annUsernameParam 用户名参数解析（口径同 /api/kb）
func annUsernameParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return "", false
	}
	return username, true
}

// handleAnnouncementList 用户端公告列表（仅已发布；置顶在前；含本人已读/签收态）
func (s *Server) handleAnnouncementList(w http.ResponseWriter, r *http.Request) {
	username, ok := annUsernameParam(w, r)
	if !ok {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 50 {
		size = 20
	}
	db := store.DB.Model(&model.Announcement{}).Where("status = ?", model.AnnStatusPublished)
	var total int64
	db.Count(&total)
	var list []model.Announcement
	if err := db.Order("stick DESC, publish_time DESC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询公告失败")
		return
	}
	ids := make([]uint, 0, len(list))
	for _, a := range list {
		ids = append(ids, a.ID)
	}
	readMap := map[uint]model.AnnouncementRead{}
	if len(ids) > 0 {
		var reads []model.AnnouncementRead
		store.DB.Where("announcement_id IN ? AND username = ?", ids, username).Find(&reads)
		for _, rd := range reads {
			readMap[rd.AnnouncementID] = rd
		}
	}
	items := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		rd := readMap[a.ID]
		items = append(items, map[string]interface{}{
			"id":              a.ID,
			"title":           a.Title,
			"category":        a.Category,
			"cover":           a.Cover,
			"digest":          a.Digest,
			"content_type":    a.ContentType, // 阶段一百四十四三期：卡片流 doc/link 直开链路数据源（漏发会导致前端回退富文本分支）
			"card_style":      a.CardStyle,
			"external_url":    a.ExternalURL,
			"stick":           a.Stick,
			"require_confirm": a.RequireConfirm,
			"publisher":       a.Publisher,
			"publish_time":    a.PublishTime,
			"read":            rd.ID > 0,
			"confirmed":       rd.Confirmed,
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": total, "page": page, "size": size})
}

// handleAnnouncementUnread 未读数（登录后拉取驱动红点；红点口径 = 已发布且无已读记录）
// 阶段一百四十四二期：增加 by_category 分类未读聚合（左侧公告分类卡牌角标数据源，服务端归口计算）
func (s *Server) handleAnnouncementUnread(w http.ResponseWriter, r *http.Request) {
	username, ok := annUsernameParam(w, r)
	if !ok {
		return
	}
	var total int64
	store.DB.Model(&model.Announcement{}).Where("status = ?", model.AnnStatusPublished).Count(&total)
	var read int64
	store.DB.Model(&model.AnnouncementRead{}).
		Where("username = ? AND announcement_id IN (?)", username,
			store.DB.Model(&model.Announcement{}).Select("id").Where("status = ?", model.AnnStatusPublished)).
		Count(&read)
	// 分类聚合：各分类已发布总数 - 本人该分类已读数（两次轻查询，避免 JOIN 自定义表名耦合）
	var totRows []struct {
		Category string
		Cnt      int64
	}
	store.DB.Model(&model.Announcement{}).
		Select("category, COUNT(*) as cnt").
		Where("status = ?", model.AnnStatusPublished).
		Group("category").Scan(&totRows)
	var readIDs []uint
	store.DB.Model(&model.AnnouncementRead{}).
		Where("username = ? AND announcement_id IN (?)", username,
			store.DB.Model(&model.Announcement{}).Select("id").Where("status = ?", model.AnnStatusPublished)).
		Pluck("announcement_id", &readIDs)
	readRows := map[string]int64{}
	if len(readIDs) > 0 {
		var rr []struct {
			Category string
			Cnt      int64
		}
		store.DB.Model(&model.Announcement{}).
			Select("category, COUNT(*) as cnt").
			Where("id IN ?", readIDs).
			Group("category").Scan(&rr)
		for _, row := range rr {
			readRows[row.Category] = row.Cnt
		}
	}
	byCat := map[string]int64{}
	for _, row := range totRows {
		n := row.Cnt - readRows[row.Category]
		if n < 0 {
			n = 0
		}
		byCat[row.Category] = n
	}
	adminJSON(w, map[string]interface{}{"unread": total - read, "by_category": byCat})
}

// handleAnnouncementDetail 公告详情（打开即记已读；附件全量下发，预览由客户端 file-viewer 链路承接）
func (s *Server) handleAnnouncementDetail(w http.ResponseWriter, r *http.Request) {
	username, ok := annUsernameParam(w, r)
	if !ok {
		return
	}
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.Where("status = ?", model.AnnStatusPublished).First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在或已撤回")
		return
	}
	var atts []model.AnnouncementAttachment
	store.DB.Where("announcement_id = ?", a.ID).Order("sort_id ASC").Find(&atts)
	// 打开即记已读（FirstOrCreate 幂等；签收状态独立字段不受影响）
	var rd model.AnnouncementRead
	store.DB.Where("announcement_id = ? AND username = ?", a.ID, username).First(&rd)
	if rd.ID == 0 {
		rd = model.AnnouncementRead{AnnouncementID: a.ID, Username: username, Confirmed: false}
		store.DB.Create(&rd)
	}
	attItems := make([]map[string]interface{}, 0, len(atts))
	for _, at := range atts {
		attItems = append(attItems, map[string]interface{}{
			"id":   at.ID,
			"name": at.Name,
			"url":  at.URL,
			"size": at.Size,
		})
	}
	adminJSON(w, map[string]interface{}{
		"id":              a.ID,
		"title":           a.Title,
		"category":        a.Category,
		"cover":           a.Cover,
		"digest":          a.Digest,
		"content_html":    a.ContentHTML,
		"content_type":    a.ContentType,   // 阶段一百四十四三期：doc/link 直开链路数据源（漏发会导致 link 型提示"链接地址为空"）
		"card_style":      a.CardStyle,     // 卡牌样式（详情直开 doc 无卡片流兜底时仍需）
		"external_url":    a.ExternalURL,   // link 型目标地址
		"open_in_browser": a.OpenInBrowser, // link 型打开方式（内置浏览器/系统浏览器）
		"stick":           a.Stick,
		"require_confirm": a.RequireConfirm,
		"confirmed":       rd.Confirmed,
		"publisher":       a.Publisher,
		"publish_time":    a.PublishTime,
		"attachments":     attItems,
	})
}

// handleAnnouncementConfirm 红头文件签收（幂等）
func (s *Server) handleAnnouncementConfirm(w http.ResponseWriter, r *http.Request) {
	username, ok := annUsernameParam(w, r)
	if !ok {
		return
	}
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.Announcement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	rd := model.AnnouncementRead{AnnouncementID: a.ID, Username: username, Confirmed: true}
	// 存在则仅置签收位，不存在则带签收位新建（幂等归口）
	var exist model.AnnouncementRead
	store.DB.Where("announcement_id = ? AND username = ?", a.ID, username).First(&exist)
	if exist.ID > 0 {
		store.DB.Model(&exist).Update("confirmed", true)
	} else {
		store.DB.Create(&rd)
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}
