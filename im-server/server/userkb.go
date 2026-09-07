package server

// ===== 阶段五十六：用户端个人知识库（自建/上传/勾选使用，对所有智能体生效） =====
// 与管理端 /admin/api/kb 的分工：上传/清理等核心流水线复用 adminkb.go 抽出的归口函数
// （kbSaveUploadFile / kbDestroyKB / kbDestroyFile），本文件只做用户侧入口与权限收口：
//   1. 个人库（scope=user 且 owner=本人）：可建/可传文件/可删/可管理文件
//   2. 公共库（scope=public）：只读展示，可勾选参与 AI 问答（kbSearch 权限过滤兜底）
//   3. 勾选存储于 im_user_kb（用户级，对所有智能体生效，多端登录一致）
// 检索权限归口：kbSearch allow 过滤（个人库仅归属者命中），勾选串仅是候选集不构成越权面
// 鉴权水位：与 /upload/* 系列一致（username 查询参数）

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// userKBUsername 用户侧接口身份解析归口（与 /upload/* 同水位：username 查询参数，缺失拒绝）
func userKBUsername(w http.ResponseWriter, r *http.Request) (string, bool) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return "", false
	}
	return username, true
}

// userKBOwnedKB 库归属校验归口：仅个人库（scope=user）且归属者为 username 时放行（管理权收口）
func userKBOwnedKB(w http.ResponseWriter, kbID uint, username string) (*model.KB, bool) {
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return nil, false
	}
	if kb.Scope != "user" || kb.Owner != username {
		adminFail(w, http.StatusForbidden, "无权操作该知识库（仅个人库归属者可管理）")
		return nil, false
	}
	return &kb, true
}

// userKBReadableKB 库可读校验归口：个人库仅归属者可读，公共库对所有用户可读（文件列表用）
func userKBReadableKB(w http.ResponseWriter, kbID uint, username string) (*model.KB, bool) {
	var kb model.KB
	if err := store.DB.First(&kb, kbID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识库不存在")
		return nil, false
	}
	if kb.Scope == "public" || (kb.Scope == "user" && kb.Owner == username) {
		return &kb, true
	}
	adminFail(w, http.StatusForbidden, "无权查看该知识库")
	return nil, false
}

// HandleUserKBGet 用户侧知识库总览：我的个人库 + 公共库（含文件数/切片数聚合）+ 勾选状态 + embedding 状态
func (s *Server) HandleUserKBGet(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	// 我的个人库 + 公共库（公共库可勾选使用，仅不可管理）；个人库排前便于操作
	var kbs []model.KB
	if err := store.DB.Where("(scope = ? AND owner = ?) OR scope = ?", "user", username, "public").
		Order("scope ASC, id ASC").Find(&kbs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询知识库失败")
		return
	}
	selected := parseKBIDs(kbUserSelectedIDs(username))
	selSet := make(map[uint]bool, len(selected))
	for _, id := range selected {
		selSet[id] = true
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
			"desc":        kb.Desc,
			"embed_model": kb.EmbedModel,
			"file_count":  fileCount,
			"chunk_count": chunkSum,
			"selected":    selSet[kb.ID],
		})
	}
	adminJSON(w, map[string]interface{}{
		"embed_enabled": kbEmbedEnabled(),
		"model":         kbEmbedCfg.Model,
		"max_file_size": kbMaxFileSize,
		"top_k":         kbTopK,
		"kbs":           out,
		"selected":      selected,
	})
}

// userKBCreateReq 用户建库请求体
type userKBCreateReq struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}

// HandleUserKBCreate 用户创建个人知识库（服务端强制 scope=user、owner=当前用户）
func (s *Server) HandleUserKBCreate(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var req userKBCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Desc = strings.TrimSpace(req.Desc)
	if req.Name == "" {
		adminFail(w, http.StatusBadRequest, "知识库名称不能为空")
		return
	}
	// 与表字段宽度对齐的轻校验（varchar(64)/varchar(255)，按字符数）
	if utf8.RuneCountInString(req.Name) > 64 {
		adminFail(w, http.StatusBadRequest, "知识库名称过长（最多 64 字）")
		return
	}
	if utf8.RuneCountInString(req.Desc) > 255 {
		adminFail(w, http.StatusBadRequest, "库描述过长（最多 255 字）")
		return
	}
	// 同 scope 下名称唯一（idx_kb_name_scope 唯一索引，与管理端同约束）
	var dup model.KB
	if err := store.DB.Where("name = ? AND scope = ?", req.Name, "user").First(&dup).Error; err == nil {
		adminFail(w, http.StatusConflict, "同名知识库已存在："+req.Name)
		return
	}
	rec := model.KB{Name: req.Name, Scope: "user", Owner: username, Desc: req.Desc, EmbedModel: kbEmbedCfg.Model}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("用户 %s 新建知识库 %s 失败: %v", username, req.Name, err)
		adminFail(w, http.StatusInternalServerError, "新建知识库失败")
		return
	}
	logger.Info("用户端：新建个人知识库 %s（id=%d，归属 %s）", rec.Name, rec.ID, username)
	adminJSON(w, rec)
}

// userKBSelectReq 用户勾选请求体（kb_ids 传空数组=清空勾选）
type userKBSelectReq struct {
	KBIDs []uint `json:"kb_ids"`
}

// HandleUserKBSelect 用户保存知识库勾选（对所有智能体对话生效；个人库仅归属者能勾选成功）
func (s *Server) HandleUserKBSelect(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var req userKBSelectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 合理上限：与 kb_ids 字段宽度（varchar 1024）及检索归并开销对齐
	if len(req.KBIDs) > 100 {
		adminFail(w, http.StatusBadRequest, "勾选知识库数量过多（最多 100 个）")
		return
	}
	// 逐个校验：库存在且（公共库 或 本人个人库）——他人的个人库不允许出现在勾选里
	if len(req.KBIDs) > 0 {
		var kbs []model.KB
		store.DB.Where("id IN ?", req.KBIDs).Find(&kbs)
		allow := make(map[uint]bool, len(kbs))
		for _, kb := range kbs {
			if kb.Scope == "public" || (kb.Scope == "user" && kb.Owner == username) {
				allow[kb.ID] = true
			}
		}
		for _, id := range req.KBIDs {
			if !allow[id] {
				adminFail(w, http.StatusForbidden, "包含无权使用的知识库（id="+strconv.FormatUint(uint64(id), 10)+"）")
				return
			}
		}
	}
	// 去重去零归一（parseKBIDs 归口）
	ids := parseKBIDs(joinUintIDs(req.KBIDs))
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, strconv.FormatUint(uint64(id), 10))
	}
	idsStr := strings.Join(parts, ",")

	// Upsert：有记录则更新，无记录且非空勾选才建（空勾选且无记录不产生垃圾行）
	var rec model.UserKB
	if err := store.DB.Where("username = ?", username).First(&rec).Error; err == nil {
		if err := store.DB.Model(&model.UserKB{}).Where("id = ?", rec.ID).Update("kb_ids", idsStr).Error; err != nil {
			logger.Error("用户 %s 保存知识库勾选失败: %v", username, err)
			adminFail(w, http.StatusInternalServerError, "保存勾选失败")
			return
		}
	} else if idsStr != "" {
		rec = model.UserKB{Username: username, KBIDs: idsStr}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("用户 %s 创建知识库勾选失败: %v", username, err)
			adminFail(w, http.StatusInternalServerError, "保存勾选失败")
			return
		}
	}
	logger.Info("用户端：用户 %s 更新知识库勾选（%s）", username, idsStr)
	adminJSON(w, map[string]interface{}{"selected": ids})
}

// joinUintIDs []uint → 逗号串（仅供 parseKBIDs 复用归一，非持久化格式归口）
func joinUintIDs(ids []uint) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, strconv.FormatUint(uint64(id), 10))
	}
	return strings.Join(parts, ",")
}

// HandleUserKBFileUpload 用户上传知识文件到本人个人库（复用管理端抽取的落盘流水线归口）
func (s *Server) HandleUserKBFileUpload(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	kbID, err := strconv.ParseUint(strings.TrimSpace(r.URL.Query().Get("kb_id")), 10, 64)
	if err != nil || kbID == 0 {
		adminFail(w, http.StatusBadRequest, "缺少或非法 kb_id 参数")
		return
	}
	kb, ok := userKBOwnedKB(w, uint(kbID), username)
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(kbMaxFileSize); err != nil {
		adminFail(w, http.StatusBadRequest, "文件上传解析失败或超出大小限制")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "未取到上传文件（字段名 file）")
		return
	}
	defer file.Close()
	rec, status, errMsg := kbSaveUploadFile(kb.ID, header, file)
	if errMsg != "" {
		adminFail(w, status, errMsg)
		return
	}
	logger.Info("用户端：用户 %s 上传知识文件 %s（个人库 %s，%d 字节），异步向量化已启动", username, rec.Name, kb.Name, rec.Size)
	adminJSON(w, rec)
}

// HandleUserKBFiles 用户查看知识库文件列表（个人库仅归属者，公共库全员可读）
func (s *Server) HandleUserKBFiles(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	kbID, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := userKBReadableKB(w, kbID, username); !ok {
		return
	}
	var files []model.KBFile
	if err := store.DB.Where("kb_id = ?", kbID).Order("id DESC").Find(&files).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询文件列表失败")
		return
	}
	adminJSON(w, files)
}

// HandleUserKBFileDelete 用户删除本人个人库中的知识文件（联动清理向量 + 磁盘 + 记录）
func (s *Server) HandleUserKBFileDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	fileID, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var f model.KBFile
	if err := store.DB.First(&f, fileID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "知识文件不存在")
		return
	}
	if _, ok := userKBOwnedKB(w, f.KBID, username); !ok {
		return
	}
	if err := kbDestroyFile(&f); err != nil {
		logger.Error("用户端删除知识文件记录失败（id=%d）: %v", fileID, err)
		adminFail(w, http.StatusInternalServerError, "删除知识文件失败")
		return
	}
	logger.Info("用户端：用户 %s 删除知识文件 %s（id=%d，向量已联动清理）", username, f.Name, fileID)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// HandleUserKBDelete 用户删除本人个人知识库（联动清理文件/向量/勾选引用）
func (s *Server) HandleUserKBDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	kbID, ok := adminPathID(w, r)
	if !ok {
		return
	}
	kb, ok := userKBOwnedKB(w, kbID, username)
	if !ok {
		return
	}
	if err := kbDestroyKB(kb); err != nil {
		logger.Error("用户端删除知识库失败（id=%d）: %v", kbID, err)
		adminFail(w, http.StatusInternalServerError, "删除知识库失败")
		return
	}
	// 联动摘除勾选引用（防勾选串累积悬空 ID；他人勾选串中的残留由 kbSearch 缺记录自动忽略）
	kbPruneSelection(kbID)
	logger.Info("用户端：用户 %s 删除个人知识库 %s（id=%d）", username, kb.Name, kbID)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// kbPruneSelection 从所有用户的勾选中摘除指定库 ID（删库联动归口）
func kbPruneSelection(kbID uint) {
	var recs []model.UserKB
	store.DB.Where("kb_ids LIKE ?", "%"+strconv.FormatUint(uint64(kbID), 10)+"%").Find(&recs)
	for _, rec := range recs {
		ids := parseKBIDs(rec.KBIDs)
		parts := make([]string, 0, len(ids))
		changed := false
		for _, id := range ids {
			if id == kbID {
				changed = true
				continue
			}
			parts = append(parts, strconv.FormatUint(uint64(id), 10))
		}
		if changed {
			store.DB.Model(&model.UserKB{}).Where("id = ?", rec.ID).Update("kb_ids", strings.Join(parts, ","))
		}
	}
}

// kbUserSelectedIDs 用户勾选的知识库 ID 串（im_user_kb 归口；未勾选/无记录返回空串）
func kbUserSelectedIDs(username string) string {
	username = strings.TrimSpace(username)
	if username == "" {
		return ""
	}
	var rec model.UserKB
	if err := store.DB.Where("username = ?", username).First(&rec).Error; err != nil {
		return ""
	}
	return rec.KBIDs
}

// kbMergeIDStrings 合并两个逗号 ID 串（parseKBIDs 去重归口，任一为空串安全）
func kbMergeIDStrings(a, b string) string {
	if strings.TrimSpace(a) == "" {
		return b
	}
	if strings.TrimSpace(b) == "" {
		return a
	}
	ids := parseKBIDs(a + "," + b)
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, strconv.FormatUint(uint64(id), 10))
	}
	return strings.Join(parts, ",")
}
