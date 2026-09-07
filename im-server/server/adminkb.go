package server

// ===== 阶段五十一：后台管理——知识库管理 API 归口 =====
// 库 CRUD（im_kb）/ 文件上传与删除（im_kb_file + 磁盘 + 向量联动清理）/ 命中测试
// 鉴权复用 adminGuard；响应归口 adminJSON / adminFail（与 AI 管理接口同风格）
// 上传后异步流水线向量化（kbProcessFile），前端轮询文件列表刷新状态

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
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

// handleAdminKBStatus embedding 通道状态与切片参数（前端提示归口：未配置时禁用上传入口）
func (s *Server) handleAdminKBStatus(w http.ResponseWriter, r *http.Request) {
	adminJSON(w, map[string]interface{}{
		"embed_enabled":   kbEmbedEnabled(),
		"model":           kbEmbedCfg.Model,
		"chunk_size":      kbChunkSize,
		"chunk_overlap":   kbChunkOverlap,
		"top_k":           kbTopK,
		"max_context":     kbMaxContext,
		"max_file_size":   kbMaxFileSize,
		"score_threshold": kbScoreThreshold, // 阶段五十二：命中相似度阈值（0=不过滤），前端状态行展示归口
	})
}

// handleAdminKBList 知识库列表（含文件数与切片数聚合，管理端全量可见）
func (s *Server) handleAdminKBList(w http.ResponseWriter, r *http.Request) {
	var kbs []model.KB
	if err := store.DB.Order("scope ASC, id ASC").Find(&kbs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询知识库失败")
		return
	}
	out := make([]map[string]interface{}, 0, len(kbs))
	for _, kb := range kbs {
		var fileCount int64
		var chunkSum int64
		store.DB.Model(&model.KBFile{}).Where("kb_id = ?", kb.ID).Count(&fileCount)
		store.DB.Model(&model.KBFile{}).Select("COALESCE(SUM(chunks),0)").Where("kb_id = ?", kb.ID).Scan(&chunkSum)
		out = append(out, map[string]interface{}{
			"id":          kb.ID,
			"name":        kb.Name,
			"scope":       kb.Scope,
			"owner":       kb.Owner,
			"desc":        kb.Desc,
			"embed_model": kb.EmbedModel,
			"dim":         kb.Dim,
			"file_count":  fileCount,
			"chunk_count": chunkSum,
			"create_time": kb.CreateTime.Unix(),
		})
	}
	adminJSON(w, out)
}

// adminKBReq 知识库创建/更新请求体
type adminKBReq struct {
	Name  string `json:"name"`
	Scope string `json:"scope"`
	Owner string `json:"owner"`
	Desc  string `json:"desc"`
}

// kbReqValidate 建库参数校验归口（名称必填；scope 仅 public/user；个人库必须指定归属者）
func kbReqValidate(req *adminKBReq) string {
	req.Name = strings.TrimSpace(req.Name)
	req.Scope = strings.TrimSpace(strings.ToLower(req.Scope))
	req.Owner = strings.TrimSpace(req.Owner)
	req.Desc = strings.TrimSpace(req.Desc)
	if req.Name == "" {
		return "知识库名称不能为空"
	}
	if req.Scope == "" {
		req.Scope = "public"
	}
	if req.Scope != "public" && req.Scope != "user" {
		return "库范围仅支持 public（公共库）或 user（个人库）"
	}
	if req.Scope == "user" && req.Owner == "" {
		return "个人库必须指定归属用户名"
	}
	if req.Scope == "public" {
		req.Owner = ""
	}
	return ""
}

// handleAdminKBCreate 新建知识库
func (s *Server) handleAdminKBCreate(w http.ResponseWriter, r *http.Request) {
	var req adminKBReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := kbReqValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	// 同 scope 下名称唯一（idx_kb_name_scope 唯一索引）
	var dup model.KB
	if err := store.DB.Where("name = ? AND scope = ?", req.Name, req.Scope).First(&dup).Error; err == nil {
		adminFail(w, http.StatusConflict, "同名知识库已存在："+req.Name)
		return
	}
	rec := model.KB{Name: req.Name, Scope: req.Scope, Owner: req.Owner, Desc: req.Desc}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("新建知识库 %s 失败: %v", req.Name, err)
		adminFail(w, http.StatusInternalServerError, "新建知识库失败")
		return
	}
	logger.Info("后台管理：新建知识库 %s（%s，归属 %s）", rec.Name, rec.Scope, rec.Owner)
	adminJSON(w, rec)
}

// handleAdminKBUpdate 更新知识库（名称/范围/归属/描述）
func (s *Server) handleAdminKBUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var req adminKBReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := kbReqValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	var kb model.KB
	if err := store.DB.First(&kb, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return
	}
	// 同 scope 下名称唯一（排除自身）
	var dup model.KB
	if err := store.DB.Where("name = ? AND scope = ? AND id <> ?", req.Name, req.Scope, id).First(&dup).Error; err == nil {
		adminFail(w, http.StatusConflict, "同名知识库已存在："+req.Name)
		return
	}
	if err := store.DB.Model(&model.KB{}).Where("id = ?", id).Updates(map[string]interface{}{
		"name":  req.Name,
		"scope": req.Scope,
		"owner": req.Owner,
		"desc":  req.Desc,
	}).Error; err != nil {
		logger.Error("更新知识库失败（id=%d）: %v", id, err)
		adminFail(w, http.StatusInternalServerError, "更新知识库失败")
		return
	}
	logger.Info("后台管理：更新知识库 %s（id=%d）", req.Name, id)
	adminJSON(w, map[string]interface{}{"id": id})
}

// handleAdminKBDelete 删除知识库（联动清理：文件记录 + 磁盘文件 + 向量集合）
func (s *Server) handleAdminKBDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var kb model.KB
	if err := store.DB.First(&kb, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return
	}
	// 阶段五十六：清理逻辑抽归口 kbDestroyKB（用户端个人库删除共用）
	// 原实现：清理逻辑内联于本 handler
	//	// 先清文件（记录 + 磁盘），再清向量集合，最后删库记录
	//	var files []model.KBFile
	//	store.DB.Where("kb_id = ?", id).Find(&files)
	//	for _, f := range files {
	//		if f.Path != "" {
	//			if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
	//				logger.Warn("删除知识文件失败 %s: %v", f.Path, err)
	//			}
	//		}
	//		store.DB.Delete(&model.KBFile{}, f.ID)
	//	}
	//	// 阶段五十二：联动清理知识文件目录（仅空目录可删，防历史遗留文件被误清；实测踩坑：原先残留空目录）
	//	if err := os.Remove(filepath.Join(kbDataDir, "files", fmt.Sprintf("kb_%d", id))); err != nil && !os.IsNotExist(err) {
	//		logger.Warn("清理知识文件目录失败 kb_%d: %v", id, err)
	//	}
	//	kbDeleteKBCollection(id)
	//	if err := store.DB.Delete(&model.KB{}, id).Error; err != nil {
	//		logger.Error("删除知识库失败（id=%d）: %v", id, err)
	//		adminFail(w, http.StatusInternalServerError, "删除知识库失败")
	//		return
	//	}
	if err := kbDestroyKB(&kb); err != nil {
		logger.Error("删除知识库失败（id=%d）: %v", id, err)
		adminFail(w, http.StatusInternalServerError, "删除知识库失败")
		return
	}
	logger.Info("后台管理：删除知识库 %s（id=%d，文件与向量集合已联动清理）", kb.Name, id)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// kbDestroyKB 知识库销毁归口（阶段五十六从 handleAdminKBDelete 抽出，管理端与用户端共用）：
// 先清文件（记录 + 磁盘），再清向量集合与知识文件目录，最后删库记录
func kbDestroyKB(kb *model.KB) error {
	id := kb.ID
	var files []model.KBFile
	store.DB.Where("kb_id = ?", id).Find(&files)
	for _, f := range files {
		if f.Path != "" {
			if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
				logger.Warn("删除知识文件失败 %s: %v", f.Path, err)
			}
		}
		store.DB.Delete(&model.KBFile{}, f.ID)
	}
	// 阶段五十二：联动清理知识文件目录（仅空目录可删，防历史遗留文件被误清；实测踩坑：原先残留空目录）
	if err := os.Remove(filepath.Join(kbDataDir, "files", fmt.Sprintf("kb_%d", id))); err != nil && !os.IsNotExist(err) {
		logger.Warn("清理知识文件目录失败 kb_%d: %v", id, err)
	}
	kbDeleteKBCollection(id)
	if err := store.DB.Delete(&model.KB{}, id).Error; err != nil {
		return err
	}
	logger.Info("知识库已删除 %s（id=%d，清理 %d 个文件与向量集合）", kb.Name, id, len(files))
	return nil
}

// handleAdminKBFileList 知识库文件列表（含向量化状态，前端轮询刷新）
func (s *Server) handleAdminKBFileList(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var files []model.KBFile
	if err := store.DB.Where("kb_id = ?", id).Order("id DESC").Find(&files).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询文件列表失败")
		return
	}
	adminJSON(w, files)
}

// handleAdminKBFileUpload 上传知识文件（落盘建记录后异步流水线向量化）
// 仅支持 kbAllowedExt 白名单扩展名；大小上限 kbMaxFileSize（config 归口）
func (s *Server) handleAdminKBFileUpload(w http.ResponseWriter, r *http.Request) {
	kbID, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "未取到上传文件（字段名 file）")
		return
	}
	defer file.Close()

	// 大小限制归口：ParseMultipartForm 以 kbMaxFileSize 为上限（超限解析报错）
	if err := r.ParseMultipartForm(kbMaxFileSize); err != nil {
		adminFail(w, http.StatusBadRequest, "文件上传解析失败或超出大小限制")
		return
	}

	// 阶段五十六：落盘/校验/建记录逻辑抽归口 kbSaveUploadFile（用户端个人库上传共用）
	// 原实现：逻辑内联于本 handler
	//	if err := r.ParseMultipartForm(kbMaxFileSize); err != nil {
	//		adminFail(w, http.StatusBadRequest, "文件上传解析失败或超出大小限制")
	//		return
	//	}
	//	ext := filepath.Ext(header.Filename)
	//	if !kbAllowedExt(ext) {
	//		adminFail(w, http.StatusBadRequest, "仅支持 docx/xlsx/xlsm/csv/md/txt 文件")
	//		return
	//	}
	//	if header.Size > kbMaxFileSize {
	//		adminFail(w, http.StatusBadRequest, fmt.Sprintf("文件超出大小限制（%d MB）", kbMaxFileSize>>20))
	//		return
	//	}
	//	// 落盘归口：DataDir/files/kb_<id>/<纳秒时间戳>_<原始文件名>（避免重名覆盖）
	//	dir := filepath.Join(kbDataDir, "files", fmt.Sprintf("kb_%d", kbID))
	//	if err := os.MkdirAll(dir, 0o755); err != nil {
	//		logger.Error("知识文件目录创建失败 %s: %v", dir, err)
	//		adminFail(w, http.StatusInternalServerError, "知识文件目录创建失败")
	//		return
	//	}
	//	safeName := kbSafeFileName(header.Filename)
	//	diskPath := filepath.Join(dir, fmt.Sprintf("%d_%s", time.Now().UnixNano(), safeName))
	//	dst, err := os.Create(diskPath)
	//	if err != nil {
	//		logger.Error("知识文件落盘失败 %s: %v", diskPath, err)
	//		adminFail(w, http.StatusInternalServerError, "知识文件落盘失败")
	//		return
	//	}
	//	written, copyErr := io.Copy(dst, file)
	//	closeErr := dst.Close()
	//	if copyErr != nil || closeErr != nil {
	//		os.Remove(diskPath)
	//		logger.Error("知识文件写入失败 %s: %v", diskPath, copyErr)
	//		adminFail(w, http.StatusInternalServerError, "知识文件写入失败")
	//		return
	//	}
	//	rec := model.KBFile{
	//		KBID:   kbID,
	//		Name:   header.Filename,
	//		Path:   diskPath,
	//		Size:   written,
	//		Status: "processing",
	//	}
	//	if err := store.DB.Create(&rec).Error; err != nil {
	//		os.Remove(diskPath)
	//		logger.Error("知识文件记录创建失败: %v", err)
	//		adminFail(w, http.StatusInternalServerError, "知识文件记录创建失败")
	//		return
	//	}
	//	// 异步流水线：解析 → 切片 → 向量化 → 入库（前端轮询状态）
	//	go kbProcessFile(rec.ID)
	rec, status, errMsg := kbSaveUploadFile(kbID, header, file)
	if errMsg != "" {
		adminFail(w, status, errMsg)
		return
	}
	logger.Info("后台管理：上传知识文件 %s（库 %s，%d 字节），异步向量化已启动", rec.Name, kb.Name, rec.Size)
	adminJSON(w, rec)
}

// kbSaveUploadFile 知识文件上传落盘归口（阶段五十六从 handleAdminKBFileUpload 抽出，管理端与用户端共用）：
// 校验扩展名白名单/大小上限 → 落盘 DataDir/files/kb_<id>/<纳秒时间戳>_<原名> → 建记录 → 异步流水线向量化
// 返回 (记录, HTTP状态码, 错误消息)；错误消息为空表示成功
func kbSaveUploadFile(kbID uint, header *multipart.FileHeader, file multipart.File) (*model.KBFile, int, string) {
	ext := filepath.Ext(header.Filename)
	if !kbAllowedExt(ext) {
		return nil, http.StatusBadRequest, "仅支持 docx/xlsx/xlsm/csv/md/txt 文件"
	}
	if header.Size > kbMaxFileSize {
		return nil, http.StatusBadRequest, fmt.Sprintf("文件超出大小限制（%d MB）", kbMaxFileSize>>20)
	}
	// 落盘归口：DataDir/files/kb_<id>/<纳秒时间戳>_<原始文件名>（避免重名覆盖）
	dir := filepath.Join(kbDataDir, "files", fmt.Sprintf("kb_%d", kbID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		logger.Error("知识文件目录创建失败 %s: %v", dir, err)
		return nil, http.StatusInternalServerError, "知识文件目录创建失败"
	}
	safeName := kbSafeFileName(header.Filename)
	diskPath := filepath.Join(dir, fmt.Sprintf("%d_%s", time.Now().UnixNano(), safeName))
	dst, err := os.Create(diskPath)
	if err != nil {
		logger.Error("知识文件落盘失败 %s: %v", diskPath, err)
		return nil, http.StatusInternalServerError, "知识文件落盘失败"
	}
	written, copyErr := io.Copy(dst, file)
	closeErr := dst.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(diskPath)
		logger.Error("知识文件写入失败 %s: %v", diskPath, copyErr)
		return nil, http.StatusInternalServerError, "知识文件写入失败"
	}
	rec := model.KBFile{
		KBID:   kbID,
		Name:   header.Filename,
		Path:   diskPath,
		Size:   written,
		Status: "processing",
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		os.Remove(diskPath)
		logger.Error("知识文件记录创建失败: %v", err)
		return nil, http.StatusInternalServerError, "知识文件记录创建失败"
	}
	// 异步流水线：解析 → 切片 → 向量化 → 入库（前端轮询状态）
	go kbProcessFile(rec.ID)
	return &rec, http.StatusOK, ""
}

// kbSafeFileName 清洗上传文件名：仅保留路径基本名，过滤控制符与文件系统保留字符
func kbSafeFileName(name string) string {
	name = filepath.Base(name)
	return strings.Map(func(r rune) rune {
		switch {
		case r < 0x20 || r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|':
			return -1
		}
		return r
	}, name)
}

// handleAdminKBFileDelete 删除知识文件（联动清理：向量 + 磁盘 + 记录）
func (s *Server) handleAdminKBFileDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var f model.KBFile
	if err := store.DB.First(&f, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识文件不存在")
		return
	}
	// 阶段五十六：清理逻辑抽归口 kbDestroyFile（用户端个人库文件删除共用）
	// 原实现：清理逻辑内联于本 handler
	//	kbDeleteFileVectors(f.KBID, f.ID)
	//	if f.Path != "" {
	//		if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
	//			logger.Warn("删除知识文件磁盘文件失败 %s: %v", f.Path, err)
	//		}
	//	}
	//	if err := store.DB.Delete(&model.KBFile{}, id).Error; err != nil {
	//		logger.Error("删除知识文件记录失败（id=%d）: %v", id, err)
	//		adminFail(w, http.StatusInternalServerError, "删除知识文件失败")
	//		return
	//	}
	if err := kbDestroyFile(&f); err != nil {
		logger.Error("删除知识文件记录失败（id=%d）: %v", id, err)
		adminFail(w, http.StatusInternalServerError, "删除知识文件失败")
		return
	}
	logger.Info("后台管理：删除知识文件 %s（id=%d，向量已联动清理）", f.Name, id)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// kbDestroyFile 知识文件销毁归口（阶段五十六从 handleAdminKBFileDelete 抽出，管理端与用户端共用）：
// 向量联动清理 + 磁盘文件删除 + 记录删除
func kbDestroyFile(f *model.KBFile) error {
	kbDeleteFileVectors(f.KBID, f.ID)
	if f.Path != "" {
		if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
			logger.Warn("删除知识文件磁盘文件失败 %s: %v", f.Path, err)
		}
	}
	return store.DB.Delete(&model.KBFile{}, f.ID).Error
}

// adminKBSearchReq 命中测试请求体
type adminKBSearchReq struct {
	KBIDs []uint `json:"kb_ids"`
	Query string `json:"query"`
}

// handleAdminKBSearch 命中测试（管理端放行全部库，含个人库；用于验证向量检索效果与 RAG 注入内容）
func (s *Server) handleAdminKBSearch(w http.ResponseWriter, r *http.Request) {
	var req adminKBSearchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if !kbEmbedEnabled() {
		adminFail(w, http.StatusBadRequest, "embedding 服务未配置（config.yaml ai.embedding），无法检索")
		return
	}
	hits := kbSearchWhere(req.KBIDs, req.Query, func(model.KB) bool { return true })
	adminJSON(w, hits)
}

// ===== 阶段五十二：知识库进阶（文本直贴/切片详情/重新向量化） =====

// handleAdminKBFileText 文本直贴建知识：内容落盘 .txt 建文件记录后复用现有向量化流水线（零特殊化）
func (s *Server) handleAdminKBFileText(w http.ResponseWriter, r *http.Request) {
	kbID, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return
	}
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		adminFail(w, http.StatusBadRequest, "知识内容不能为空")
		return
	}
	if len(req.Content) > int(kbMaxFileSize) {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("内容超出大小限制（%d MB）", kbMaxFileSize>>20))
		return
	}
	if req.Name == "" {
		req.Name = "文本条目"
	}
	// 补 .txt 扩展名（流水线按扩展名选择解析器）
	if filepath.Ext(req.Name) == "" {
		req.Name += ".txt"
	}
	if !kbEmbedEnabled() {
		adminFail(w, http.StatusBadRequest, "embedding 服务未配置（config.yaml ai.embedding），无法向量化")
		return
	}

	// 落盘归口与文件上传同规则（DataDir/files/kb_<id>/<纳秒时间戳>_<名称>）
	dir := filepath.Join(kbDataDir, "files", fmt.Sprintf("kb_%d", kbID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		logger.Error("知识条目目录创建失败 %s: %v", dir, err)
		adminFail(w, http.StatusInternalServerError, "知识条目目录创建失败")
		return
	}
	safeName := kbSafeFileName(req.Name)
	diskPath := filepath.Join(dir, fmt.Sprintf("%d_%s", time.Now().UnixNano(), safeName))
	if err := os.WriteFile(diskPath, []byte(req.Content), 0o644); err != nil {
		logger.Error("知识条目落盘失败 %s: %v", diskPath, err)
		adminFail(w, http.StatusInternalServerError, "知识条目落盘失败")
		return
	}
	rec := model.KBFile{
		KBID:   kbID,
		Name:   req.Name,
		Path:   diskPath,
		Size:   int64(len(req.Content)),
		Status: "processing",
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		os.Remove(diskPath)
		logger.Error("知识条目记录创建失败: %v", err)
		adminFail(w, http.StatusInternalServerError, "知识条目记录创建失败")
		return
	}
	go kbProcessFile(rec.ID)
	logger.Info("后台管理：文本直贴建知识 %s（库 %s，%d 字节），异步向量化已启动", rec.Name, kb.Name, rec.Size)
	adminJSON(w, rec)
}

// handleAdminKBFileChunks 切片详情查询（查看已入库切片内容，验证切片质量）
func (s *Server) handleAdminKBFileChunks(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var f model.KBFile
	if err := store.DB.First(&f, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识文件不存在")
		return
	}
	var chunks []kbFileChunk
	if f.Status == "ready" && f.Chunks > 0 {
		chunks = kbGetFileChunks(f.KBID, f.ID, f.Chunks)
	}
	if chunks == nil {
		chunks = []kbFileChunk{}
	}
	adminJSON(w, map[string]interface{}{
		"file_id":    f.ID,
		"name":       f.Name,
		"status":     f.Status,
		"chunks":     f.Chunks,
		"chunk_list": chunks,
	})
}

// handleAdminKBFileRebuild 单文件重新向量化（磁盘原文件复用，清旧向量后重跑流水线）
func (s *Server) handleAdminKBFileRebuild(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if !kbEmbedEnabled() {
		adminFail(w, http.StatusBadRequest, "embedding 服务未配置（config.yaml ai.embedding），无法重建")
		return
	}
	if err := kbRebuildFile(id); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"rebuilding": true})
}

// handleAdminKBRebuild 整库重建（embedding 模型变更后使用：清空向量集合，串行重跑全部文件）
func (s *Server) handleAdminKBRebuild(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	count, err := kbRebuildKB(id)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	logger.Info("后台管理：发起知识库整库重建（id=%d，%d 个文件）", id, count)
	adminJSON(w, map[string]interface{}{"rebuilding": true, "files": count})
}

// ===== 阶段五十三：知识库数据微调（检索调试/切片编辑删除/源文编辑重建） =====

// handleAdminKBDebug 检索调试：单库返回 topK+余量 候选并标注阈值过滤/注入判定（调参可视化，
// 区别于 /admin/api/kb/search 只返回对话链路的最终命中）
func (s *Server) handleAdminKBDebug(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var req struct {
		Query string `json:"query"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	hits, kb, err := kbDebugQuery(id, req.Query)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	// 库内切片总数（集合 Count，调试面板头部展示用）
	chunkTotal := 0
	if col, err := kbGetCollection(kb.ID); err == nil {
		chunkTotal = col.Count()
	}
	adminJSON(w, map[string]interface{}{
		"kb_id":       kb.ID,
		"kb_name":     kb.Name,
		"dim":         kb.Dim,
		"embed_model": kb.EmbedModel,
		"threshold":   kbScoreThreshold,
		"top_k":       kbTopK,
		"chunk_total": chunkTotal,
		"hits":        hits,
	})
}

// adminPathChunkID 切片序号路径参数解析（/chunk/{cid}，0 起的切片下标，区别于 adminPathID 的记录 ID）
func adminPathChunkID(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.PathValue("cid")
	idx, err := strconv.Atoi(raw)
	if err != nil || idx < 0 {
		adminFail(w, http.StatusBadRequest, "路径参数切片序号非法")
		return 0, false
	}
	return idx, true
}

// handleAdminKBChunkEdit 编辑单切片文本（删旧片→重嵌新文→同 ID 写回；源文件不动，重建会覆盖）
func (s *Server) handleAdminKBChunkEdit(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	idx, ok := adminPathChunkID(w, r)
	if !ok {
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if err := kbChunkEdit(id, idx, req.Content); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"edited": true})
}

// handleAdminKBChunkDelete 删除单切片（末片删除联动收缩计数，中间片留空洞）
func (s *Server) handleAdminKBChunkDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	idx, ok := adminPathChunkID(w, r)
	if !ok {
		return
	}
	if err := kbChunkDelete(id, idx); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// kbSourceEditable 仅纯文本类文件支持源文编辑（docx/xlsx 为二进制容器，改动无法回写原格式，须重新上传）
func kbSourceEditable(ext string) bool {
	switch strings.ToLower(ext) {
	case ".txt", ".md", ".csv":
		return true
	}
	return false
}

// handleAdminKBFileSourceGet 读取源文本内容（源文编辑弹窗回显）
func (s *Server) handleAdminKBFileSourceGet(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var f model.KBFile
	if err := store.DB.First(&f, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识文件不存在")
		return
	}
	if !kbSourceEditable(filepath.Ext(f.Path)) {
		adminFail(w, http.StatusBadRequest, "仅文本类文件（txt/md/csv）支持源文编辑，docx/xlsx 请重新上传")
		return
	}
	if f.Status == "processing" {
		adminFail(w, http.StatusBadRequest, "文件正在向量化中，请稍后再试")
		return
	}
	data, err := os.ReadFile(f.Path)
	if err != nil {
		logger.Error("读取知识源文件失败 %s: %v", f.Path, err)
		adminFail(w, http.StatusInternalServerError, "读取源文件失败")
		return
	}
	adminJSON(w, map[string]interface{}{
		"file_id": f.ID,
		"name":    f.Name,
		"content": string(data),
	})
}

// handleAdminKBFileSourcePut 保存源文本并触发该文件重新向量化（重写磁盘文件 → 单文件重建流水线归口）
func (s *Server) handleAdminKBFileSourcePut(w http.ResponseWriter, r *http.Request) {
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var f model.KBFile
	if err := store.DB.First(&f, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识文件不存在")
		return
	}
	if !kbSourceEditable(filepath.Ext(f.Path)) {
		adminFail(w, http.StatusBadRequest, "仅文本类文件（txt/md/csv）支持源文编辑，docx/xlsx 请重新上传")
		return
	}
	if !kbEmbedEnabled() {
		adminFail(w, http.StatusBadRequest, "embedding 服务未配置（config.yaml ai.embedding），无法重建")
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		adminFail(w, http.StatusBadRequest, "源文件内容不能为空")
		return
	}
	if int64(len(req.Content)) > kbMaxFileSize {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("内容超出大小限制（%d MB）", kbMaxFileSize>>20))
		return
	}
	// 覆写磁盘源文件后走单文件重建归口（内部有 processing 防并发与模型一致性校验）
	if err := os.WriteFile(f.Path, []byte(req.Content), 0o644); err != nil {
		logger.Error("写回知识源文件失败 %s: %v", f.Path, err)
		adminFail(w, http.StatusInternalServerError, "写回源文件失败")
		return
	}
	if err := kbRebuildFile(f.ID); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	store.DB.Model(&model.KBFile{}).Where("id = ?", f.ID).Update("size", int64(len(req.Content)))
	logger.Info("后台管理：源文编辑保存并重建 %s（id=%d，%d 字节）", f.Name, f.ID, len(req.Content))
	adminJSON(w, map[string]interface{}{"rebuilding": true})
}

// ===== 阶段五十四：量化数据管理（跨库切片聚合表格化展示/关键词搜索/分页） =====

// handleAdminKBVecChunks 量化数据管理归口：遍历全部（或指定）库的已就绪文件，
// 逐片还原向量库文档并按关键词过滤，分页返回表格行数据（编辑/删除/源文复用既有 API）
// GET /admin/api/kb/chunks?kb_id=0&file_id=0&q=&page=1&size=20
func (s *Server) handleAdminKBVecChunks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kbID := adminQueryUint(q.Get("kb_id"))     // 0=全部库
	fileID := adminQueryUint(q.Get("file_id")) // 0=全部文件
	keyword := strings.TrimSpace(q.Get("q"))   // 关键词：切片内容模糊匹配
	page := adminQueryUint(q.Get("page"))
	size := adminQueryUint(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}

	// 文件清单归口：指定 file_id 时仅该文件（校验存在），否则按库范围全量拉取 ready 且已有切片的文件
	var files []model.KBFile
	db := store.DB.Where("status = ? AND chunks > 0", "ready")
	if fileID > 0 {
		db = db.Where("id = ?", fileID)
	} else if kbID > 0 {
		db = db.Where("kb_id = ?", kbID)
	}
	if err := db.Order("kb_id ASC, id ASC").Find(&files).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询知识文件失败")
		return
	}
	if len(files) == 0 {
		adminJSON(w, map[string]interface{}{"total": 0, "page": page, "size": size, "items": []interface{}{}})
		return
	}

	// 库名缓存归口（避免逐文件重复查库表）
	kbNames := make(map[uint]string)
	var kbs []model.KB
	store.DB.Find(&kbs)
	for _, kb := range kbs {
		kbNames[kb.ID] = kb.Name
	}

	// 全量还原切片后内存过滤（管理端低频操作；chromem GetByID 为内存 map 查找，千片级毫秒耗时）
	rows := make([]map[string]interface{}, 0, size)
	total := 0
	start := int((page - 1) * size)
	end := start + int(size)
	for _, f := range files {
		for _, c := range kbGetFileChunks(f.KBID, f.ID, f.Chunks) {
			if keyword != "" && !strings.Contains(c.Content, keyword) {
				continue
			}
			total++
			if total <= start || total > end {
				continue // 窗口外仅计数不组装，省去序列化开销
			}
			rows = append(rows, map[string]interface{}{
				"kb_id":   f.KBID,
				"kb_name": kbNames[f.KBID],
				"file_id": f.ID,
				"file":    f.Name,
				"chunk":   c.Chunk,
				"chars":   c.Chars,
				"dim":     c.Dim,
				"norm":    c.Norm,
				"head":    c.Head,
				"content": c.Content,
			})
		}
	}
	if rows == nil {
		rows = []map[string]interface{}{}
	}
	adminJSON(w, map[string]interface{}{"total": total, "page": page, "size": size, "items": rows})
}
