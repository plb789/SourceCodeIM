package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// 阶段四十六：OnlyOffice 在线文档编辑对接
// 链路说明：前端点击可编辑文档 → /doc/editor 校验归属并签发编辑器配置（JWT）→ 浏览器 DocsAPI 拉起编辑器
// → DocumentServer 回源 /doc/download 拉取最新版本文件 → 用户保存后 DocumentServer 回调 /doc/callback
// → 服务端落盘新版本并更新 im_doc_edit（版本归口，原文件保留不覆盖）
// 已知边界：两人同时编辑同一条文档消息时为同一协同会话，先后保存为后写胜（last-write-wins）

// ooEditableExt 阶段四十六：可在线编辑的扩展名白名单
func ooEditableExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".docx", ".xlsx", ".pptx":
		return true
	}
	return false
}

// ooDocumentType 阶段四十六：扩展名 → OnlyOffice documentType 映射（word=文档 cell=表格 slide=演示）
func ooDocumentType(ext string) string {
	switch strings.ToLower(ext) {
	case ".docx":
		return "word"
	case ".xlsx":
		return "cell"
	case ".pptx":
		return "slide"
	}
	return ""
}

// ooDocMeta 消息中解析出的文档元信息
type ooDocMeta struct {
	URL  string // 原始静态 URL（/static/upload/xxx）
	Name string // 展示文件名
	Ext  string // 带点小写扩展名
}

// ooParseDocMeta 解析消息 content 中的文档信息：
// msg_type=5 文件消息（content JSON {url,name,size}）或 AI 文档信封（{"doc":url,"name":...}）
func ooParseDocMeta(msg *model.Message) *ooDocMeta {
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(msg.Content), &raw); err != nil {
		return nil
	}
	rawURL := ""
	name := ""
	switch int8(msg.MsgType) {
	case MsgTypeFileSaved: // 文件消息：url/name 直出
		if v, ok := raw["url"].(string); ok {
			rawURL = v
		}
		if v, ok := raw["name"].(string); ok {
			name = v
		}
	case 1, 2: // 群聊/私聊文字消息：仅识别 AI 文档信封 {"doc":url,"name":...}
		if v, ok := raw["doc"].(string); ok {
			rawURL = v
		}
		if v, ok := raw["name"].(string); ok {
			name = v
		}
	default:
		return nil
	}
	if rawURL == "" {
		return nil
	}
	ext := strings.ToLower(filepath.Ext(rawURL))
	if name == "" {
		name = filepath.Base(rawURL)
	}
	return &ooDocMeta{URL: rawURL, Name: name, Ext: ext}
}

// ooResolveDoc 阶段四十六：解析消息对应的最新版本文档
// username 非空时校验消息归属（发送方/接收方/群聊可见），为空时跳过（DocumentServer 回源内部通道）
// 返回：最新版本文件绝对路径、元信息、当前版本号（im_doc_edit 优先，无记录回退消息原始 URL）
func (s *Server) ooResolveDoc(msgID uint, username string) (string, *ooDocMeta, int, error) {
	var msg model.Message
	if err := store.DB.First(&msg, msgID).Error; err != nil {
		return "", nil, 0, fmt.Errorf("消息不存在")
	}
	// 已撤回消息拒绝编辑（内容已不可见，避免绕过撤回语义）
	if msg.Recalled {
		return "", nil, 0, fmt.Errorf("消息已撤回，无法编辑")
	}
	// 归属校验：私聊仅收发双方；群聊（ToUser 为空）所有成员可见可编辑；AI 会话用户为接收方
	if username != "" && username != msg.FromUser && username != msg.ToUser && msg.ToUser != "" {
		return "", nil, 0, fmt.Errorf("无权访问该文档")
	}
	meta := ooParseDocMeta(&msg)
	if meta == nil || meta.URL == "" {
		return "", nil, 0, fmt.Errorf("该消息不是可解析的文档")
	}
	if !ooEditableExt(meta.Ext) {
		return "", nil, 0, fmt.Errorf("该文件类型不支持在线编辑")
	}
	// 版本归口：查编辑版本表，最新版本优先
	latestURL := meta.URL
	version := 0
	var rec model.DocEdit
	if err := store.DB.Where("msg_id = ?", msgID).First(&rec).Error; err == nil && rec.LatestURL != "" {
		latestURL = rec.LatestURL
		version = rec.Version
	}
	// URL → 磁盘路径：仅允许 UploadDir 目录下的文件名（basename 防目录穿越）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	filename := filepath.Base(latestURL)
	absPath := filepath.Join(dir, filename)
	// 拼接后目录必须仍为原目录（basename 防目录穿越，Clean 归一两侧再比较）
	if filepath.Dir(absPath) != filepath.Clean(dir) {
		return "", nil, 0, fmt.Errorf("非法的文件路径")
	}
	if _, err := os.Stat(absPath); err != nil {
		return "", nil, 0, fmt.Errorf("文档文件不存在")
	}
	return absPath, meta, version, nil
}

// ooSignToken 阶段四十六：HS256 签发 JWT（claims 顶层即业务字段，与 OnlyOffice 官方要求同构；1 小时有效期）
func ooSignToken(secret string, claims jwt.MapClaims) (string, error) {
	claims["exp"] = time.Now().Add(time.Hour).Unix()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

// ooVerifyToken 阶段四十六：校验 JWT（限制 HS256 防算法混淆），返回 claims（顶层即业务字段）
func ooVerifyToken(secret, tokenStr string) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		return []byte(secret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("JWT 校验失败")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("JWT 载荷异常")
	}
	return claims, nil
}

// ooBearerToken 从请求头提取 Bearer JWT（DocumentServer 回源/回调均携带 Authorization: Bearer）
func ooBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	}
	return ""
}

// ooError 阶段四十六：统一 JSON 错误响应
func ooError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{"error": msg})
}

// HandleDocEditor GET /doc/editor?msg_id=xxx&username=yyy
// 阶段四十六：签发 OnlyOffice 编辑器配置（含 JWT），前端拿配置后 DocsAPI.DocEditor 拉起编辑器
func (s *Server) HandleDocEditor(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.OnlyOffice.Enabled {
		ooError(w, http.StatusForbidden, "未启用在线编辑")
		return
	}
	username := r.URL.Query().Get("username")
	msgIDStr := r.URL.Query().Get("msg_id")
	// 解析 msg_id（与 aidoc.go 同解析口径：ParseUint 32 位）
	msgID64, err := strconv.ParseUint(msgIDStr, 10, 32)
	if username == "" || err != nil || msgID64 == 0 {
		ooError(w, http.StatusBadRequest, "缺少参数")
		return
	}
	absPath, meta, version, err := s.ooResolveDoc(uint(msgID64), username)
	if err != nil {
		ooError(w, http.StatusForbidden, err.Error())
		return
	}
	_ = absPath // 配置阶段仅做归属与存在性校验，文件内容由 /doc/download 归口下发

	serverURL := strings.TrimRight(s.cfg.OnlyOffice.ServerURL, "/")
	docID := uint(msgID64)
	// 编辑器配置（官方要求：token 的 claims 与该配置同构，顶层字段一致）
	configMap := map[string]interface{}{
		"documentType": ooDocumentType(meta.Ext),
		"document": map[string]interface{}{
			"fileType": strings.TrimPrefix(meta.Ext, "."),
			// key 随版本变化：保存回调 version++ 后新开编辑器拿新内容，防 DocumentServer 缓存旧版
			"key":   fmt.Sprintf("doc_%d_v%d", docID, version),
			"title": meta.Name,
			// 统一回源下载接口：服务端归口解析最新版本（避免直接暴露静态原始 URL 拿到旧版）
			"url": fmt.Sprintf("%s/doc/download?msg_id=%d", serverURL, docID),
			"permissions": map[string]interface{}{
				"edit":     true,
				"download": true,
				"print":    true,
			},
		},
		"editorConfig": map[string]interface{}{
			"mode": "edit",
			// 保存回调地址（携带 msg_id 定位版本记录）
			"callbackUrl": fmt.Sprintf("%s/doc/callback?msg_id=%d", serverURL, docID),
			"lang":        "zh-CN",
			"region":      "zh-CN",
			"user": map[string]interface{}{
				"id":   username,
				"name": username,
			},
			"customization": map[string]interface{}{
				"forcesave":     true, // Ctrl+S 立即触发保存回调（而非等会话关闭）
				"compactHeader": false,
			},
		},
		"height": "100%",
		"width":  "100%",
		"type":   "desktop",
	}
	// JWT 签发：claims 与配置同构（复制一份，避免 exp 污染返回给前端的配置对象）
	tokenClaims := jwt.MapClaims{}
	for k, v := range configMap {
		tokenClaims[k] = v
	}
	token, err := ooSignToken(s.cfg.OnlyOffice.JWTSecret, tokenClaims)
	if err != nil {
		logger.Error("编辑器配置签发失败: %v", err)
		ooError(w, http.StatusInternalServerError, "配置签发失败")
		return
	}
	configMap["token"] = token
	logger.Info("文档编辑配置签发: %s 打开消息%d（版本%d）", username, docID, version)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"config": configMap, "api_url": s.cfg.OnlyOffice.APIURL})
}

// HandleDocDownload GET /doc/download?msg_id=xxx[&username=yyy]
// 阶段四十六：文档内容下发（双鉴权）——DocumentServer 回源走 Bearer JWT；
// 浏览器弹窗"下载"按钮走 username 归属校验（与 /upload/file 同信任水位）
func (s *Server) HandleDocDownload(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.OnlyOffice.Enabled {
		ooError(w, http.StatusForbidden, "未启用在线编辑")
		return
	}
	msgID64, derr := strconv.ParseUint(r.URL.Query().Get("msg_id"), 10, 32)
	if derr != nil || msgID64 == 0 {
		ooError(w, http.StatusBadRequest, "缺少参数")
		return
	}
	// 鉴权：Bearer JWT 有效即放行（DocumentServer 内部通道）；否则要求 username 归属校验
	username := ""
	if tokenStr := ooBearerToken(r); tokenStr != "" {
		if _, err := ooVerifyToken(s.cfg.OnlyOffice.JWTSecret, tokenStr); err != nil {
			ooError(w, http.StatusUnauthorized, "鉴权失败")
			return
		}
	} else {
		username = r.URL.Query().Get("username")
		if username == "" {
			ooError(w, http.StatusUnauthorized, "缺少鉴权信息")
			return
		}
	}
	absPath, meta, _, err := s.ooResolveDoc(uint(msgID64), username)
	if err != nil {
		ooError(w, http.StatusForbidden, err.Error())
		return
	}
	// 下载名使用消息内展示名（中文文件名走 RFC 5987 编码）
	w.Header().Set("Content-Disposition", `attachment; filename*=UTF-8''`+url.PathEscape(meta.Name))
	http.ServeFile(w, r, absPath)
}

// ooCallbackBody DocumentServer 保存回调体（JWT claims 顶层即该结构）
type ooCallbackBody struct {
	Key      string `json:"key"`      // 编辑会话 key（doc_<msgid>_v<version>）
	Status   int    `json:"status"`   // 1编辑中 2已保存就绪 3保存失败 4关闭无改动 6强制保存 7强制保存失败
	URL      string `json:"url"`      // status=2/6 时新版本文件的下载地址（DocumentServer 临时 URL）
	FileType string `json:"filetype"` // 新文件类型（如 docx）
}

// HandleDocCallback POST /doc/callback（DocumentServer 调用）
// 阶段四十六：保存回调——status=2/6 时下载新版本落盘，im_doc_edit 版本推进（原文件保留，不覆盖）
// 官方约定：任何分支都必须返回 {"error":0}，否则 DocumentServer 会持续重试
func (s *Server) HandleDocCallback(w http.ResponseWriter, r *http.Request) {
	// 回调鉴权：必须携带有效的 Bearer JWT（与签发密钥一致）
	claims, err := ooVerifyToken(s.cfg.OnlyOffice.JWTSecret, ooBearerToken(r))
	if err != nil {
		logger.Warn("文档保存回调鉴权失败: %v", err)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"error": 1})
		return
	}
	// claims 顶层即回调体（官方要求 token payload 与请求体同构），重新序列化解析
	raw, _ := json.Marshal(claims)
	var body ooCallbackBody
	if err := json.Unmarshal(raw, &body); err != nil {
		logger.Warn("文档保存回调体解析失败: %v", err)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"error": 0})
		return
	}

	// 仅 status=2（保存就绪）/6（强制保存）需要落盘新版本
	if body.Status == 2 || body.Status == 6 {
		if body.URL != "" {
			s.ooSaveNewVersion(body)
		}
	}
	// 其余状态（编辑中/关闭/失败）无需处理，按官方约定返回成功
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"error": 0})
}

// ooSaveNewVersion 阶段四十六：下载 DocumentServer 提供的新版本文件并落盘，推进 im_doc_edit 版本
func (s *Server) ooSaveNewVersion(body ooCallbackBody) {
	// 从 key 解出 msg_id（doc_<msgid>_v<version>，callbackUrl 中也携带 msg_id，双通道互为校验）
	msgID := uint(0)
	if _, err := fmt.Sscanf(body.Key, "doc_%d_", &msgID); err != nil || msgID == 0 {
		logger.Warn("文档保存回调 key 非法: %s", body.Key)
		return
	}
	// 拉取新版本文件（DocumentServer 临时 URL，限 120 秒超时防挂死）
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(body.URL)
	if err != nil {
		logger.Error("文档新版本下载失败: msg=%d, %v", msgID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logger.Error("文档新版本下载失败: msg=%d, 状态码 %d", msgID, resp.StatusCode)
		return
	}
	// 存储目录归口（与 uploadfile.go 同规则）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	// 新版本扩展名：优先用回调声明的 filetype，校验白名单后回退原扩展名
	ext := "." + strings.ToLower(strings.TrimPrefix(body.FileType, "."))
	if !ooEditableExt(ext) {
		var meta model.DocEdit
		if err := store.DB.Where("msg_id = ?", msgID).First(&meta).Error; err == nil {
			ext = strings.ToLower(filepath.Ext(meta.LatestURL))
		}
	}
	if !ooEditableExt(ext) {
		var msg model.Message
		if err := store.DB.First(&msg, msgID).Error; err == nil {
			if m := ooParseDocMeta(&msg); m != nil {
				ext = m.Ext
			}
		}
	}
	if !ooEditableExt(ext) {
		logger.Error("文档新版本扩展名非法: msg=%d, filetype=%q", msgID, body.FileType)
		return
	}
	// 新版本文件名（沿用 时间戳_随机hex.ext 命名，原版本文件保留不覆盖）
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		logger.Error("文档版本目录创建失败: %v", err)
		return
	}
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		logger.Error("文档版本文件创建失败: %v", err)
		return
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		logger.Error("文档版本文件写入失败: %v", err)
		return
	}
	out.Close()
	latestURL := "/static/upload/" + filename

	// 版本推进：已有记录则 version++ + latest_url 更新，否则建档 v1（消息版本归口，服务端统一维护）
	var rec model.DocEdit
	if err := store.DB.Where("msg_id = ?", msgID).First(&rec).Error; err == nil {
		newVersion := rec.Version + 1
		store.DB.Model(&model.DocEdit{}).Where("id = ?", rec.ID).
			Updates(map[string]interface{}{"version": newVersion, "latest_url": latestURL})
		logger.Info("文档保存回调: 消息%d 新版本 v%d, url=%s", msgID, newVersion, latestURL)
	} else {
		rec = model.DocEdit{MsgID: msgID, LatestURL: latestURL, Version: 1}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("文档版本记录创建失败: msg=%d, %v", msgID, err)
			return
		}
		logger.Info("文档保存回调: 消息%d 首个版本 v1, url=%s", msgID, latestURL)
	}
}
