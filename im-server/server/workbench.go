package server

// ===== 阶段一百四十五：工作台模块（企业办公应用统一入口，钉钉工作台同款） =====
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 维护侧：后台管理界面（admin.html 工作台管理视图）走 /admin/api/workbench*，
//     复用 adminGuard 鉴权（仅管理员可增删改查/启停/排序）
//  2. 安全底线：网站地址仅收 http/https（杜绝 javascript: 等注入向量），名称/备注
//     纯文本入库（客户端 textContent 渲染），图标仅收本站静态资源路径
//  3. 阅读侧：用户端 GET /api/workbench（仅启用项，排序服务端归口），无用户态数据
//  4. 打开方式：window=内置窗体（PC 独立 BrowserWindow）/ system=系统默认浏览器，
//     由后台按应用配置，客户端按端能力映射

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// RegisterWorkbenchRoutes 注册工作台模块路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
func RegisterWorkbenchRoutes(s *Server) {
	// 管理端（复用后台会话鉴权）
	http.HandleFunc("GET /admin/api/workbench", s.adminGuard(s.handleAdminWorkbenchList))
	http.HandleFunc("POST /admin/api/workbench", s.adminGuard(s.handleAdminWorkbenchCreate))
	http.HandleFunc("PUT /admin/api/workbench/{id}", s.adminGuard(s.handleAdminWorkbenchUpdate))
	http.HandleFunc("DELETE /admin/api/workbench/{id}", s.adminGuard(s.handleAdminWorkbenchDelete))
	http.HandleFunc("POST /admin/api/workbench/icon", s.adminGuard(s.handleAdminWorkbenchIcon))
	// 用户端（纯只读清单，无用户态）
	http.HandleFunc("GET /api/workbench", s.handleWorkbenchList)
}

// wbValidCategory 分类合法校归（固定枚举，客户端按预设文案/配色渲染）
func wbValidCategory(c string) bool {
	return c == "office" || c == "biz" || c == "hr" || c == "it" || c == "other"
}

// wbValidOpenMode 打开方式合法校验（embed=内置浏览器浏览区面板 / window=内置窗体 / system=系统默认浏览器）
func wbValidOpenMode(m string) bool {
	return m == "embed" || m == "window" || m == "system"
}

// wbSaveBody 新建/编辑工作台应用请求体
type wbSaveBody struct {
	Name      string `json:"name"`
	URL       string `json:"url"`
	Icon      string `json:"icon"`
	Category  string `json:"category"`
	OpenMode  string `json:"open_mode"`
	SortOrder int    `json:"sort_order"`
	Status    int8   `json:"status"`
	Remark    string `json:"remark"`
}

// wbFromPayload 公共字段装配归口（新建/编辑同口径；URL/分类/打开方式服务端白名单校验）
func wbFromPayload(a *model.WorkbenchApp, body wbSaveBody, creator string) bool {
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len([]rune(body.Name)) > 64 {
		return false
	}
	body.URL = strings.TrimSpace(body.URL)
	low := strings.ToLower(body.URL)
	// 地址白名单：仅 http/https（服务端校验归口，杜绝 javascript: 等注入向量）
	if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
		return false
	}
	if len(body.URL) > 512 {
		return false
	}
	if !wbValidCategory(body.Category) {
		body.Category = "office"
	}
	if !wbValidOpenMode(body.OpenMode) {
		body.OpenMode = "window"
	}
	// 图标白名单：仅本站静态资源路径（复用公告附件上传链路产出）
	body.Icon = strings.TrimSpace(body.Icon)
	if body.Icon != "" && !strings.HasPrefix(body.Icon, "/static/upload/") {
		return false
	}
	a.Name = body.Name
	a.URL = body.URL
	a.Icon = body.Icon
	a.Category = body.Category
	a.OpenMode = body.OpenMode
	a.SortOrder = body.SortOrder
	a.Status = body.Status
	a.Remark = strings.TrimSpace(body.Remark)
	a.Creator = creator
	return true
}

// ===== 管理端 =====

// handleAdminWorkbenchList 管理端工作台应用列表（分类/状态/关键词筛选 + 分页）
func (s *Server) handleAdminWorkbenchList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 50
	}
	db := store.DB.Model(&model.WorkbenchApp{})
	if c := q.Get("category"); c != "" && wbValidCategory(c) {
		db = db.Where("category = ?", c)
	}
	if st := q.Get("status"); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 1 {
			db = db.Where("status = ?", v)
		}
	}
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		db = db.Where("name LIKE ? OR url LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var list []model.WorkbenchApp
	if err := db.Order("sort_order ASC, id ASC").Offset((page - 1) * size).Limit(size).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询工作台应用失败")
		return
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// handleAdminWorkbenchCreate 新建工作台应用
func (s *Server) handleAdminWorkbenchCreate(w http.ResponseWriter, r *http.Request) {
	var body wbSaveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	a := model.WorkbenchApp{}
	if !wbFromPayload(&a, body, adminUserFromCtx(r)) {
		adminFail(w, http.StatusBadRequest, "名称/地址不合法（地址需 http:// 或 https:// 开头）")
		return
	}
	if err := store.DB.Create(&a).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存工作台应用失败")
		return
	}
	logger.Info("工作台应用已保存: id=%d 名称=%s 地址=%s 操作人=%s", a.ID, a.Name, a.URL, a.Creator)
	adminJSON(w, map[string]interface{}{"id": a.ID})
}

// handleAdminWorkbenchUpdate 编辑工作台应用
func (s *Server) handleAdminWorkbenchUpdate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.WorkbenchApp
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "应用不存在")
		return
	}
	var body wbSaveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !wbFromPayload(&a, body, a.Creator) {
		adminFail(w, http.StatusBadRequest, "名称/地址不合法（地址需 http:// 或 https:// 开头）")
		return
	}
	if err := store.DB.Save(&a).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存工作台应用失败")
		return
	}
	logger.Info("工作台应用已更新: id=%d 名称=%s 操作人=%s", a.ID, a.Name, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"id": a.ID})
}

// handleAdminWorkbenchDelete 删除工作台应用
func (s *Server) handleAdminWorkbenchDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var a model.WorkbenchApp
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "应用不存在")
		return
	}
	store.DB.Delete(&a)
	logger.Info("工作台应用已删除: id=%d 名称=%s 操作人=%s", a.ID, a.Name, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminWorkbenchIcon 工作台应用图标上传（管理端专用；仅图片，复用公告附件静态资源目录）
func (s *Server) handleAdminWorkbenchIcon(w http.ResponseWriter, r *http.Request) {
	maxSize := int64(5 << 20) // 图标限 5MB（头像级小图，防滥用）
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
		".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".ico": true, ".svg": true,
	}
	if !allowed[ext] {
		adminFail(w, http.StatusBadRequest, "仅支持图片格式（png/jpg/gif/webp/bmp/ico/svg）")
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
	filename := fmt.Sprintf("wb_%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(buf), ext)
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, file); err != nil {
		os.Remove(dst)
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	adminJSON(w, map[string]interface{}{
		"url":  "/static/upload/" + filename,
		"name": header.Filename,
	})
}

// ===== 用户端 =====

// handleWorkbenchList 用户端工作台清单（仅启用项；排序服务端归口：sort_order 小在前）
func (s *Server) handleWorkbenchList(w http.ResponseWriter, r *http.Request) {
	var list []model.WorkbenchApp
	if err := store.DB.Where("status = ?", model.WbStatusEnabled).
		Order("sort_order ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询工作台应用失败")
		return
	}
	items := make([]map[string]interface{}, 0, len(list))
	for _, a := range list {
		items = append(items, map[string]interface{}{
			"id":         a.ID,
			"name":       a.Name,
			"url":        a.URL,
			"icon":       a.Icon,
			"category":   a.Category,
			"open_mode":  a.OpenMode,
			"sort_order": a.SortOrder,
			"remark":     a.Remark,
		})
	}
	adminJSON(w, map[string]interface{}{"list": items, "total": len(items)})
}
