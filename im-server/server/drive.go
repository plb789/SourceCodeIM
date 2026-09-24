package server

// ===== 网盘模块（百度网盘同款个人云盘，服务端统一数据归口） =====
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 元数据归口 MySQL im_drive_file（owner+parent_id 目录树），文件本体经 store.ObjectStore
//     抽象层落 MinIO 或本地磁盘（drive.storage=auto 时 MinIO 已配置即用 MinIO，否则降级本地），
//     客户端永不接触 MinIO 凭据，全部操作经本模块 API 代理
//  2. 鉴权水位：与群聊图片上传同水位——username 须有活跃 WS 连接（轻量活性锚点，防离线/不存在
//     用户名冒用），全部查询/写入强制 owner=username 隔离（仅能操作自己的文件）
//  3. 安全：名称白名单消毒（拒绝路径分隔符与穿越向量）、单文件上限、每用户配额服务端聚合校验、
//     对象 key 服务端生成（纳秒+随机串，客户端零控制权）
//  4. 下载：MinIO 后端 302 跳短时效预签名地址（直连 MinIO 省服务端带宽）；本地后端
//     http.ServeContent 流式下发（天然支持 Range 断点续传）
//  5. 与聊天文件（static/upload，7 天清理）完全隔离：网盘文件永久存储，object_key 不落
//     static/upload 目录，清理白名单正则天然免疫

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// driveEnabled 网盘总开关（config.yaml drive.enabled，false 时接口统一明确拒绝）
func (s *Server) driveEnabled() bool { return s.cfg.Drive.Enabled }

// driveUsernameRe 用户名白名单（对象 key/本地路径拼装防注入：账号仅允许字母数字与 _ @ . -）
var driveUsernameRe = regexp.MustCompile(`^[A-Za-z0-9_@.\-]{1,32}$`)

// driveCheckUser 网盘通用校验归口：总开关 → 用户名合法 → 用户在线（返回错误文本，空=通过）
func (s *Server) driveCheckUser(username string) string {
	if !s.driveEnabled() {
		return "网盘功能未启用"
	}
	if !driveUsernameRe.MatchString(username) {
		return "非法用户名"
	}
	if s.hub.Count(username) == 0 {
		return "用户未在线，请先登录"
	}
	return ""
}

// driveValidName 名称消毒归口：去首尾空白；拒绝空名/穿越向量/路径分隔符/控制字符；
// 尾部点与空格剔除（Windows 文件系统约束，保存时同样非法）
func driveValidName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	name = strings.TrimRight(name, ". ")
	if name == "" || name == "." || name == ".." || len([]rune(name)) > 255 {
		return "", false
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, ":") || strings.Contains(name, "..") {
		return "", false
	}
	for _, r := range name {
		if r < 0x20 {
			return "", false
		}
	}
	return name, true
}

// driveOwnFile 按 id+owner 查记录（所有权隔离归口：查不到/非本人一律 404，不泄露存在性）
func (s *Server) driveOwnFile(id uint, username string) (*model.DriveFile, error) {
	var rec model.DriveFile
	if err := store.DB.Where("id = ? AND owner = ?", id, username).First(&rec).Error; err != nil {
		return nil, err
	}
	return &rec, nil
}

// RegisterDriveRoutes 注册网盘模块路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
// 鉴权水位说明：list/upload/download 的 username 走查询参数，统一 guardDrive 包装校验；
// mkdir/rename/delete 的 username 在 JSON 体内（各处理器内 driveCheckUser 归口校验，同水位）
func RegisterDriveRoutes(s *Server) {
	http.HandleFunc("GET /api/drive/list", s.guardDrive(s.handleDriveList))
	http.HandleFunc("GET /api/drive/search", s.guardDrive(s.handleDriveSearch))
	http.HandleFunc("POST /api/drive/mkdir", s.handleDriveMkdir)
	http.HandleFunc("POST /api/drive/rename", s.handleDriveRename)
	http.HandleFunc("POST /api/drive/delete", s.handleDriveDelete)
	http.HandleFunc("POST /api/drive/delete_batch", s.handleDriveDeleteBatch)
	// 移动/复制（网盘三期）：username 在 JSON 体内（处理器内 driveCheckUser 归口校验，同 delete 水位）
	http.HandleFunc("POST /api/drive/move", s.handleDriveMove)
	http.HandleFunc("POST /api/drive/copy", s.handleDriveCopy)
	http.HandleFunc("POST /api/drive/upload", s.guardDrive(s.handleDriveUpload))
	http.HandleFunc("GET /api/drive/download", s.guardDrive(s.handleDriveDownload))
	// 大文件链路（网盘二期）：MD5 秒传 + 分片上传 + 断点续传——username 走查询参数统一 guardDrive 包装；
	// 分片会话持久 MySQL（重启不丢断点），分片本体落本地临时盘，complete 流式合并进对象存储
	http.HandleFunc("POST /api/drive/upload/init", s.guardDrive(s.handleDriveUploadInit))
	http.HandleFunc("POST /api/drive/upload/chunk", s.guardDrive(s.handleDriveUploadChunk))
	http.HandleFunc("POST /api/drive/upload/complete", s.guardDrive(s.handleDriveUploadComplete))
	// 回收站（网盘二期）：list 走查询参数统一 guardDrive 包装；restore/delete/clear 的
	// username 在 JSON 体内（处理器内 driveCheckUser 归口校验，同 delete 水位）
	http.HandleFunc("GET /api/drive/trash/list", s.guardDrive(s.handleDriveTrashList))
	http.HandleFunc("POST /api/drive/trash/restore", s.handleDriveTrashRestore)
	http.HandleFunc("POST /api/drive/trash/delete", s.handleDriveTrashDelete)
	http.HandleFunc("POST /api/drive/trash/clear", s.handleDriveTrashClear)
	// 分片会话定时 GC（断点续传孤儿数据归口：启动清一次 + 每 6 小时一轮）
	s.startDriveUploadGC()
}

// guardDrive 网盘接口统一包装：总开关/用户名/在线校验归口（通过后才进具体处理器）
func (s *Server) guardDrive(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		if msg := s.driveCheckUser(username); msg != "" {
			http.Error(w, msg, http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

// driveFail JSON 错误归口（前端 toast 直显 message）
func driveFail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{"error": msg})
}

// handleDriveList 目录列表 GET /api/drive/list?username=xxx&parent_id=0
// 返回 {items, used_bytes, quota_bytes, storage}：目录/文件混排（目录在前），
// 排序服务端归口；used/quota 顺路返回省一次请求（前端容量条渲染）
func (s *Server) handleDriveList(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	parentID, _ := strconv.ParseUint(r.URL.Query().Get("parent_id"), 10, 64)
	// 父目录归属校验（根目录 0 放行；防越权枚举他人目录内容）
	if parentID > 0 {
		if _, err := s.driveOwnFile(uint(parentID), username); err != nil {
			driveFail(w, http.StatusNotFound, "目录不存在")
			return
		}
	}
	var items []model.DriveFile
	if err := store.DB.Where("owner = ? AND parent_id = ?", username, parentID).
		Order("is_dir DESC, name ASC").Find(&items).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	if items == nil {
		items = []model.DriveFile{}
	}
	var used struct{ Total int64 }
	store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
		Where("owner = ? AND is_dir = ?", username, false).Scan(&used)
	kind := ""
	if st := store.GetObjectStore(); st != nil {
		kind = st.Kind()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"items":       items,
		"used_bytes":  used.Total,
		"quota_bytes": s.cfg.Drive.QuotaBytes,
		"storage":     kind,
	})
}

// handleDriveSearch 搜索 GET /api/drive/search?username=xxx&keyword=yyy
// 按文件名模糊匹配当前用户网盘全部条目（数据归口：服务端拼好"所在位置"完整路径，前端零拼装）；
// 命中上限 100 条防大结果；路径由该用户目录全量一次查询在内存拼链（目录数有限，避免逐层查库）
func (s *Server) handleDriveSearch(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	// 关键词长度上限（LIKE 已参数化无注入，仅资源保护）
	if len([]rune(keyword)) > 64 {
		keyword = string([]rune(keyword)[:64])
	}
	items := []model.DriveFile{}
	if keyword != "" {
		if err := store.DB.Where("owner = ? AND name LIKE ?", username, "%"+keyword+"%").
			Order("is_dir DESC, name ASC").Limit(100).Find(&items).Error; err != nil {
			driveFail(w, http.StatusInternalServerError, "查询失败")
			return
		}
	}
	// 该用户全部目录一次查出建映射（id → 记录），内存拼祖先链；防环限深 32
	dirs := []model.DriveFile{}
	store.DB.Where("owner = ? AND is_dir = ?", username, true).Find(&dirs)
	dirMap := make(map[uint]model.DriveFile, len(dirs))
	for _, d := range dirs {
		dirMap[d.ID] = d
	}
	type searchItem struct {
		model.DriveFile
		Path string `json:"path"`
	}
	out := make([]searchItem, 0, len(items))
	for _, it := range items {
		out = append(out, searchItem{DriveFile: it, Path: driveBuildPath(dirMap, it.ParentID)})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": out})
}

// driveBuildPath 拼接"我的文件 / a / b"形式所在路径（dirMap 为该用户目录映射；断链/环回兜底"我的文件"）
func driveBuildPath(dirMap map[uint]model.DriveFile, parentID uint) string {
	if parentID == 0 {
		return "我的文件"
	}
	segs := []string{}
	cur := parentID
	for i := 0; i < 32 && cur != 0; i++ {
		p, ok := dirMap[cur]
		if !ok {
			return "我的文件"
		}
		segs = append([]string{p.Name}, segs...)
		cur = p.ParentID
	}
	return "我的文件 / " + strings.Join(segs, " / ")
}

// driveItemReq 目录/改名/删除请求体（JSON）
type driveItemReq struct {
	Username string `json:"username"`
	ParentID uint   `json:"parent_id"`
	ID       uint   `json:"id"`
	Name     string `json:"name"`
}

// handleDriveMkdir 新建文件夹 POST /api/drive/mkdir {username,parent_id,name}
func (s *Server) handleDriveMkdir(w http.ResponseWriter, r *http.Request) {
	var body driveItemReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	name, ok := driveValidName(body.Name)
	if !ok {
		driveFail(w, http.StatusBadRequest, "名称不合法")
		return
	}
	if body.ParentID > 0 {
		if _, err := s.driveOwnFile(body.ParentID, body.Username); err != nil {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return
		}
	}
	// 同目录同名拦截（目录与文件统一命名空间，微信/网盘同款约束）
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		body.Username, body.ParentID, name).Count(&cnt)
	if cnt > 0 {
		driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
		return
	}
	rec := model.DriveFile{Owner: body.Username, ParentID: body.ParentID, Name: name, IsDir: true}
	if err := store.DB.Create(&rec).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "创建失败")
		return
	}
	logger.Info("网盘新建文件夹: %s -> %s (parent=%d)", body.Username, name, body.ParentID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"item": rec})
}

// handleDriveRename 重命名 POST /api/drive/rename {username,id,name}
func (s *Server) handleDriveRename(w http.ResponseWriter, r *http.Request) {
	var body driveItemReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.ID == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	rec, err := s.driveOwnFile(body.ID, body.Username)
	if err != nil {
		driveFail(w, http.StatusNotFound, "文件不存在")
		return
	}
	name, ok := driveValidName(body.Name)
	if !ok {
		driveFail(w, http.StatusBadRequest, "名称不合法")
		return
	}
	if name != rec.Name {
		// 同目录同名拦截（排除自身）
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ? AND id != ?",
			body.Username, rec.ParentID, name, rec.ID).Count(&cnt)
		if cnt > 0 {
			driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
			return
		}
	}
	store.DB.Model(rec).Update("name", name)
	logger.Info("网盘重命名: %s %d %s -> %s", body.Username, rec.ID, rec.Name, name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"item": *rec})
}

// driveDeleteOne 单条删除归口（单删/批量删共用）：BFS 收集子孙 id（含自身）后整棵移入
// 回收站（软删除）；返回移入回收站的记录条数（含级联子孙）
func (s *Server) driveDeleteOne(username string, root *model.DriveFile) int {
	// BFS 收集子孙 id（含自身）；owner 条件贯穿每层，杜绝跨用户越权
	ids := []uint{root.ID}
	frontier := []uint{root.ID}
	for len(frontier) > 0 {
		var children []model.DriveFile
		if err := store.DB.Where("owner = ? AND parent_id IN ?", username, frontier).Find(&children).Error; err != nil {
			break
		}
		frontier = frontier[:0]
		for _, c := range children {
			ids = append(ids, c.ID)
			frontier = append(frontier, c.ID)
		}
	}
	// 软删除归口：整棵子树统一 deleted_at 时间戳（回收站顶层项按删除时间倒序展示）；
	// 文件本体对象保留（恢复零成本），彻底删除（trash/delete、trash/clear）时才物理清理
	if err := store.DB.Model(&model.DriveFile{}).Where("id IN ?", ids).
		Update("deleted_at", time.Now()).Error; err != nil {
		logger.Warn("网盘移入回收站失败: %s id=%d, %v", username, root.ID, err)
		return 0
	}
	logger.Info("网盘移入回收站: %s id=%d (%s), 级联 %d 项", username, root.ID, root.Name, len(ids))
	return len(ids)
}

// handleDriveDelete 删除 POST /api/drive/delete {username,id}
// 目录递归移入回收站（BFS 收集整棵子树后统一软删除；对象本体保留，彻底删除时才物理清理）
func (s *Server) handleDriveDelete(w http.ResponseWriter, r *http.Request) {
	var body driveItemReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.ID == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	root, err := s.driveOwnFile(body.ID, body.Username)
	if err != nil {
		driveFail(w, http.StatusNotFound, "文件不存在")
		return
	}
	n := s.driveDeleteOne(body.Username, root)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"deleted": n})
}

// driveBatchReq 批量操作请求体
type driveBatchReq struct {
	Username string `json:"username"`
	IDs      []uint `json:"ids"`
}

// handleDriveDeleteBatch 批量删除 POST /api/drive/delete_batch {username, ids:[]}
// 循环复用单条删除归口（目录级联/零拷贝保护同水位）；不存在的 id 跳过不阻断整批，
// 返回实际删除记录数（含级联子孙）
func (s *Server) handleDriveDeleteBatch(w http.ResponseWriter, r *http.Request) {
	var body driveBatchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || len(body.IDs) == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	deleted := 0
	for _, id := range body.IDs {
		root, err := s.driveOwnFile(id, body.Username)
		if err != nil {
			continue // 单条不存在/越权 id 跳过，不阻断整批
		}
		deleted += s.driveDeleteOne(body.Username, root)
	}
	logger.Info("网盘批量删除: %s 请求 %d 项, 删除 %d 条记录", body.Username, len(body.IDs), deleted)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"deleted": deleted})
}

// ===== 移动/复制（网盘三期：批量移动/复制到指定目录，百度网盘同款） =====
// 存储归口：复制文件只浅拷贝记录行（object_key/md5/mime/size 原样复用，对象本体零拷贝零新增
// 存储开销——彻底删除的引用计数已按 Unscoped 全表归口，副本存活则对象必存活）；目录 BFS 递归
// 复制整棵子树新建记录并重挂父子链，子文件同样浅拷贝

// driveMoveCopyReq 移动/复制请求体（JSON）
type driveMoveCopyReq struct {
	Username string `json:"username"`
	IDs      []uint `json:"ids"`
	TargetID uint   `json:"target_id"` // 目标目录 id（0=我的文件根目录）
}

// driveMoveCopyGuard 移动/复制公共校验归口：参数 → driveCheckUser → 单批上限 → 目标目录存在
// 且为本人目录（0=根目录放行）→ 逐项归属收集（不存在的 id 跳过不阻断整批，批量删除同水位）。
// 返回 recs（归属命中记录）、dirSet（其中目录 id 集合，防环用）、请求体；校验失败已直接写响应返回 false
func (s *Server) driveMoveCopyGuard(w http.ResponseWriter, r *http.Request) ([]*model.DriveFile, map[uint]bool, *driveMoveCopyReq, bool) {
	var body driveMoveCopyReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || len(body.IDs) == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return nil, nil, nil, false
	}
	if len(body.IDs) > 200 {
		driveFail(w, http.StatusBadRequest, "单次最多操作 200 项")
		return nil, nil, nil, false
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return nil, nil, nil, false
	}
	if body.TargetID > 0 {
		tgt, err := s.driveOwnFile(body.TargetID, body.Username)
		if err != nil || !tgt.IsDir {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return nil, nil, nil, false
		}
	}
	recs := make([]*model.DriveFile, 0, len(body.IDs))
	dirSet := make(map[uint]bool, len(body.IDs))
	for _, id := range body.IDs {
		rec, err := s.driveOwnFile(id, body.Username)
		if err != nil {
			continue // 单条不存在/越权 id 跳过，不阻断整批
		}
		recs = append(recs, rec)
		if rec.IsDir {
			dirSet[rec.ID] = true
		}
	}
	if len(recs) == 0 {
		driveFail(w, http.StatusNotFound, "所选文件不存在")
		return nil, nil, nil, false
	}
	return recs, dirSet, &body, true
}

// driveCycleHit 防环归口：从 target 沿 parent_id 向上找祖先链（owner 条件贯穿杜绝跨用户链路），
// 命中 dirSet（被移动/复制的目录 id 集合）= 目标为其中目录自身或其子孙，落位将成环
func (s *Server) driveCycleHit(username string, target uint, dirSet map[uint]bool) bool {
	cur := target
	for i := 0; i < 64 && cur != 0; i++ {
		if dirSet[cur] {
			return true
		}
		var rec model.DriveFile
		if err := store.DB.Select("parent_id").Where("id = ? AND owner = ?", cur, username).First(&rec).Error; err != nil {
			return false // 断链兜底：数据异常不误伤正常操作
		}
		cur = rec.ParentID
	}
	return false
}

// handleDriveMove 移动 POST /api/drive/move {username, ids:[], target_id}
// 防环（目标不得为被移动目录自身或其子孙）→ 逐项落位：跨目录时目标同名自动改名
// （name(n).ext，复用回收站恢复策略归口；同父移动为原位无操作）。返回 {moved, renamed}
func (s *Server) handleDriveMove(w http.ResponseWriter, r *http.Request) {
	recs, dirSet, body, ok := s.driveMoveCopyGuard(w, r)
	if !ok {
		return
	}
	if body.TargetID > 0 && s.driveCycleHit(body.Username, body.TargetID, dirSet) {
		driveFail(w, http.StatusBadRequest, "不能移动到自身或其子文件夹内")
		return
	}
	moved, renamed := 0, 0
	for _, rec := range recs {
		name := rec.Name
		if rec.ParentID != body.TargetID {
			// 跨目录落位才查同名（目录与文件统一命名空间；同父名本就唯一）
			var cnt int64
			store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ? AND id != ?",
				body.Username, body.TargetID, rec.Name, rec.ID).Count(&cnt)
			if cnt > 0 {
				name = driveRestoreName(body.Username, body.TargetID, rec.Name, rec.IsDir)
				renamed++
			}
		}
		if err := store.DB.Model(&model.DriveFile{}).Where("id = ? AND owner = ?", rec.ID, body.Username).
			Updates(map[string]interface{}{"parent_id": body.TargetID, "name": name}).Error; err != nil {
			continue
		}
		moved++
	}
	logger.Info("网盘移动: %s 请求 %d 项 -> parent=%d, 成功 %d, 改名 %d", body.Username, len(body.IDs), body.TargetID, moved, renamed)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"moved": moved, "renamed": renamed})
}

// driveSubtreeSize 目录子树文件字节总和（BFS 收集子孙目录 id 后一次聚合查询；限深 64 防环兜底）
func (s *Server) driveSubtreeSize(username string, dirID uint) int64 {
	dirIDs := []uint{dirID}
	frontier := []uint{dirID}
	for depth := 0; depth < 64 && len(frontier) > 0; depth++ {
		var next []uint
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND is_dir = ? AND parent_id IN ?",
			username, true, frontier).Pluck("id", &next)
		dirIDs = append(dirIDs, next...)
		frontier = next
	}
	var total struct{ Total int64 }
	store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
		Where("owner = ? AND is_dir = ? AND parent_id IN ?", username, false, dirIDs).Scan(&total)
	return total.Total
}

// handleDriveCopy 复制 POST /api/drive/copy {username, ids:[], target_id}
// 校验链：公共归口 → 防环（同移动）→ 配额服务端聚合校验（待复制文件字节总和+已用 vs 配额，
// 与上传同水位）；落位：目标同名自动改名 → 文件浅拷贝记录行 / 目录新建后 BFS 递归复制子树。
// 返回 {copied, renamed}
func (s *Server) handleDriveCopy(w http.ResponseWriter, r *http.Request) {
	recs, dirSet, body, ok := s.driveMoveCopyGuard(w, r)
	if !ok {
		return
	}
	if body.TargetID > 0 && s.driveCycleHit(body.Username, body.TargetID, dirSet) {
		driveFail(w, http.StatusBadRequest, "不能复制到自身或其子文件夹内")
		return
	}
	// 配额校验（复制产生同体积新记录）
	var need int64
	for _, rec := range recs {
		if rec.IsDir {
			need += s.driveSubtreeSize(body.Username, rec.ID)
		} else {
			need += rec.Size
		}
	}
	if need > 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", body.Username, false).Scan(&used)
		if used.Total+need > s.cfg.Drive.QuotaBytes {
			driveFail(w, http.StatusForbidden, "网盘空间不足，复制失败")
			return
		}
	}
	copied, renamed := 0, 0
	for _, rec := range recs {
		name := rec.Name
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
			body.Username, body.TargetID, rec.Name).Count(&cnt)
		if cnt > 0 {
			name = driveRestoreName(body.Username, body.TargetID, rec.Name, rec.IsDir)
			renamed++
		}
		nrec := model.DriveFile{Owner: body.Username, ParentID: body.TargetID, Name: name, IsDir: rec.IsDir,
			Size: rec.Size, ObjectKey: rec.ObjectKey, MimeType: rec.MimeType, MD5: rec.MD5}
		if err := store.DB.Create(&nrec).Error; err != nil {
			continue
		}
		copied++
		if rec.IsDir {
			copied += s.driveCopySubtree(body.Username, rec.ID, nrec.ID)
		}
	}
	logger.Info("网盘复制: %s 请求 %d 项 -> parent=%d, 新建 %d, 顶层改名 %d", body.Username, len(body.IDs), body.TargetID, copied, renamed)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"copied": copied, "renamed": renamed})
}

// driveCopySubtree BFS 递归复制 srcID 目录整棵子树重挂到 newParentID 下（子文件同样浅拷贝记录
// 行复用对象本体；子项落新建目录名必不冲突无需改名；限量 5000 条防异常数据拖垮服务端）
func (s *Server) driveCopySubtree(username string, srcID uint, newParentID uint) int {
	type copyNode struct{ src, parent uint }
	queue := []copyNode{{srcID, newParentID}}
	n := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		var children []model.DriveFile
		if err := store.DB.Where("owner = ? AND parent_id = ?", username, cur.src).
			Order("is_dir DESC, name ASC").Find(&children).Error; err != nil {
			break
		}
		for _, ch := range children {
			if n >= 5000 {
				return n
			}
			nrec := model.DriveFile{Owner: username, ParentID: cur.parent, Name: ch.Name, IsDir: ch.IsDir,
				Size: ch.Size, ObjectKey: ch.ObjectKey, MimeType: ch.MimeType, MD5: ch.MD5}
			if err := store.DB.Create(&nrec).Error; err != nil {
				continue
			}
			n++
			if ch.IsDir {
				queue = append(queue, copyNode{ch.ID, nrec.ID})
			}
		}
	}
	return n
}

// ===== 回收站（网盘二期：删除=移入回收站，可恢复/彻底删除/清空，数据归口服务端） =====
// 查询铁律：回收站内行对普通查询不可见（GORM 软删自动过滤），本区块全部经 Unscoped 归口；
// 对象本体在移入回收站时不清理（恢复零成本），仅在彻底删除/清空时按零拷贝保护物理清理

// driveTrashItem 回收站列表项（服务端归口拼装：原位置路径 + 删除时间，前端零计算；
// 独立出参结构避免 gorm.DeletedAt 直接序列化，删除时间以标准 time 输出）
type driveTrashItem struct {
	ID         uint      `json:"id"`
	Name       string    `json:"name"`
	IsDir      bool      `json:"is_dir"`
	Size       int64     `json:"size"`
	MimeType   string    `json:"mime_type"`
	CreateTime time.Time `json:"create_time"`
	UpdateTime time.Time `json:"update_time"`
	DeletedAt  time.Time `json:"deleted_at"`
	Path       string    `json:"path"` // 原位置（"我的文件 / a / b"，祖先链服务端拼好）
}

// driveTrashSubtree BFS 收集回收站软删子树（含自身；Unscoped 查询——软删行普通查询不可见；
// 仅收集 deleted_at 非空的子孙且 owner 贯穿每层杜绝跨用户越权；顺带收集文件对象 key 供彻底删除清理）
func driveTrashSubtree(root *model.DriveFile) (ids []uint, fileKeys []string) {
	ids = []uint{root.ID}
	if !root.IsDir && root.ObjectKey != "" {
		fileKeys = append(fileKeys, root.ObjectKey)
	}
	frontier := []uint{root.ID}
	for len(frontier) > 0 {
		var children []model.DriveFile
		store.DB.Unscoped().Where("owner = ? AND parent_id IN ? AND deleted_at IS NOT NULL",
			root.Owner, frontier).Find(&children)
		frontier = frontier[:0]
		for _, c := range children {
			ids = append(ids, c.ID)
			if !c.IsDir && c.ObjectKey != "" {
				fileKeys = append(fileKeys, c.ObjectKey)
			}
			frontier = append(frontier, c.ID)
		}
	}
	return ids, fileKeys
}

// drivePurgeObjects 彻底删除后的对象本体清理归口（幂等；失败仅记日志不阻断——孤儿对象不影响
// 功能正确性）。零拷贝保护：引用计数 Unscoped 全表统计（软删记录同样占用对象——仍在回收站
// 或分享受让副本恢复后仍需对象存活），排除本批 ids 防自引用误判；同 key 去重防重复物理删
func (s *Server) drivePurgeObjects(ids []uint, fileKeys []string) int {
	st := store.GetObjectStore()
	if st == nil || len(fileKeys) == 0 {
		return 0
	}
	purged := 0
	seen := make(map[string]bool, len(fileKeys))
	for _, key := range fileKeys {
		if seen[key] {
			continue
		}
		seen[key] = true
		var refCnt int64
		store.DB.Unscoped().Model(&model.DriveFile{}).Where("object_key = ? AND id NOT IN ?", key, ids).Count(&refCnt)
		if refCnt > 0 {
			continue // 对象仍被其他记录引用（回收站其他项/分享受让副本等），保留
		}
		if err := st.Delete(key); err != nil {
			logger.Warn("网盘对象删除失败（孤儿对象）: %s, %v", key, err)
			continue
		}
		purged++
	}
	return purged
}

// handleDriveTrashList 回收站列表 GET /api/drive/trash/list?username=xxx
// 仅展示顶层项（父目录同样在回收站的子项跟随父级整体恢复/删除，不单列）；按删除时间倒序
func (s *Server) handleDriveTrashList(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var trashed []model.DriveFile
	if err := store.DB.Unscoped().Where("owner = ? AND deleted_at IS NOT NULL", username).
		Order("deleted_at DESC, is_dir DESC, name ASC").Find(&trashed).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	trashSet := make(map[uint]bool, len(trashed))
	for _, t := range trashed {
		trashSet[t.ID] = true
	}
	// 该用户全量目录映射（Unscoped 含软删目录）：原位置路径拼链归口（复用 search 的 driveBuildPath）
	var dirs []model.DriveFile
	store.DB.Unscoped().Where("owner = ? AND is_dir = ?", username, true).Find(&dirs)
	dirMap := make(map[uint]model.DriveFile, len(dirs))
	for _, d := range dirs {
		dirMap[d.ID] = d
	}
	out := make([]driveTrashItem, 0, len(trashed))
	for _, it := range trashed {
		if it.ParentID != 0 && trashSet[it.ParentID] {
			continue // 父目录也在回收站 → 非顶层项，跟随父级整体恢复/删除
		}
		out = append(out, driveTrashItem{
			ID: it.ID, Name: it.Name, IsDir: it.IsDir, Size: it.Size, MimeType: it.MimeType,
			CreateTime: it.CreateTime, UpdateTime: it.UpdateTime,
			DeletedAt: it.DeletedAt.Time, Path: driveBuildPath(dirMap, it.ParentID),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": out})
}

// driveRestoreName 恢复落位同名冲突自动改名归口：文件 name(n).ext / 目录 name(n)，
// n 从 1 递增直至当前目录无冲突（普通查询只统计存活记录，回收站项不占名）
func driveRestoreName(owner string, parentID uint, name string, isDir bool) string {
	base, ext := name, ""
	if !isDir {
		if e := filepath.Ext(name); e != "" {
			base, ext = strings.TrimSuffix(name, e), e
		}
	}
	// 候选名防超长：预留 "(9999)" 与扩展名后仍超 255 rune 则截短 base（列宽 varchar(255)）
	maxBase := 255 - len([]rune(ext)) - 6
	if rb := []rune(base); len(rb) > maxBase {
		base = string(rb[:maxBase])
	}
	for n := 1; ; n++ {
		cand := fmt.Sprintf("%s(%d)%s", base, n, ext)
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
			owner, parentID, cand).Count(&cnt)
		if cnt == 0 {
			return cand
		}
	}
}

// handleDriveTrashRestore 回收站恢复 POST /api/drive/trash/restore {username, ids:[]}
// 顶层项整棵软删子树统一恢复：父目录存活原位放回（同名自动改名），父目录已物理缺失移根兜底；
// 父目录仍在回收站的请求项跳过（恢复父级即整棵带回），杜绝悬空引用
func (s *Server) handleDriveTrashRestore(w http.ResponseWriter, r *http.Request) {
	var body driveBatchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || len(body.IDs) == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	restored := 0
	for _, id := range body.IDs {
		var root model.DriveFile
		// Unscoped 查：须为本人在回收站的记录（存活记录/他人记录一律跳过）
		if err := store.DB.Unscoped().Where("id = ? AND owner = ? AND deleted_at IS NOT NULL", id, body.Username).
			First(&root).Error; err != nil {
			continue
		}
		// 父目录状态归口：0=根放行；存活=原位恢复；在回收站=跳过；已物理缺失=移根兜底
		targetParent := root.ParentID
		if root.ParentID > 0 {
			var parent model.DriveFile
			if err := store.DB.Unscoped().Where("id = ?", root.ParentID).First(&parent).Error; err != nil {
				targetParent = 0
			} else if parent.DeletedAt.Valid {
				continue
			}
		}
		// 顶层项落位修正（同名冲突自动改名 / 移根）：UpdateColumn 不触发 hooks 不误改 update_time
		patch := map[string]interface{}{}
		if targetParent != root.ParentID {
			patch["parent_id"] = targetParent
		}
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
			body.Username, targetParent, root.Name).Count(&cnt)
		if cnt > 0 {
			patch["name"] = driveRestoreName(body.Username, targetParent, root.Name, root.IsDir)
		}
		if len(patch) > 0 {
			store.DB.Unscoped().Model(&root).UpdateColumns(patch)
		}
		// 整棵软删子树恢复：deleted_at 置 NULL（Unscoped 绕过软删过滤条件直达软删行）
		ids, _ := driveTrashSubtree(&root)
		if err := store.DB.Unscoped().Model(&model.DriveFile{}).Where("id IN ?", ids).
			UpdateColumn("deleted_at", nil).Error; err != nil {
			continue
		}
		restored++
		logger.Info("网盘回收站恢复: %s id=%d (%s), 整树 %d 项", body.Username, root.ID, root.Name, len(ids))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"restored": restored})
}

// handleDriveTrashDelete 彻底删除 POST /api/drive/trash/delete {username, ids:[]}
// 顶层项整棵物理删除：清行后按零拷贝保护清理对象本体；父级仍在回收站的请求项跳过（删父级联整棵）
func (s *Server) handleDriveTrashDelete(w http.ResponseWriter, r *http.Request) {
	var body driveBatchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || len(body.IDs) == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	deleted := 0
	for _, id := range body.IDs {
		var root model.DriveFile
		// Unscoped 查：须为本人在回收站的记录（已恢复/已彻底删/非本人一律跳过）
		if err := store.DB.Unscoped().Where("id = ? AND owner = ? AND deleted_at IS NOT NULL", id, body.Username).
			First(&root).Error; err != nil {
			continue
		}
		if root.ParentID > 0 {
			var parent model.DriveFile
			if err := store.DB.Unscoped().Where("id = ?", root.ParentID).First(&parent).Error; err == nil && parent.DeletedAt.Valid {
				continue // 父也在回收站 → 跟随父级级联处理，不重复统计
			}
		}
		ids, fileKeys := driveTrashSubtree(&root)
		store.DB.Unscoped().Where("id IN ?", ids).Delete(&model.DriveFile{})
		s.drivePurgeObjects(ids, fileKeys)
		deleted++
		logger.Info("网盘回收站彻底删除: %s id=%d (%s), 整树 %d 项", body.Username, root.ID, root.Name, len(ids))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"deleted": deleted})
}

// handleDriveTrashClear 清空回收站 POST /api/drive/trash/clear {username}
// 该用户全部软删项物理删除（记录间父子必同态：软删子树整体圈定即全部回收站内容），
// 对象本体按零拷贝保护清理
func (s *Server) handleDriveTrashClear(w http.ResponseWriter, r *http.Request) {
	var body driveBatchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	var all []model.DriveFile
	store.DB.Unscoped().Where("owner = ? AND deleted_at IS NOT NULL", body.Username).Find(&all)
	if len(all) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"deleted": 0})
		return
	}
	ids := make([]uint, 0, len(all))
	fileKeys := make([]string, 0, len(all))
	for _, it := range all {
		ids = append(ids, it.ID)
		if !it.IsDir && it.ObjectKey != "" {
			fileKeys = append(fileKeys, it.ObjectKey)
		}
	}
	store.DB.Unscoped().Where("id IN ?", ids).Delete(&model.DriveFile{})
	purged := s.drivePurgeObjects(ids, fileKeys)
	logger.Info("网盘清空回收站: %s, 清除 %d 条记录, 对象 %d 个", body.Username, len(ids), purged)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"deleted": len(ids)})
}

// handleDriveUpload 上传 POST /api/drive/upload?username=xxx&parent_id=0（multipart 字段 file）
// 流式链路：MaxBytesReader 限额 → FormFile（>32MB 自动落临时盘文件，不占内存）→ 配额聚合校验
// → 流式写对象存储 → 落库元数据；失败路径兜底清理孤儿对象
func (s *Server) handleDriveUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	parentID, _ := strconv.ParseUint(r.URL.Query().Get("parent_id"), 10, 64)
	if parentID > 0 {
		var parent model.DriveFile
		if err := store.DB.Where("id = ? AND owner = ? AND is_dir = ?", parentID, username, true).
			First(&parent).Error; err != nil {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return
		}
	}
	maxSize := s.cfg.Drive.MaxFileSize
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	// FormFile 内部以默认 32MB 为内存上限，超限部分自动落盘临时文件——大文件内存友好
	file, header, err := r.FormFile("file")
	if err != nil {
		driveFail(w, http.StatusBadRequest, "文件过大或解析失败")
		return
	}
	defer file.Close()
	if header.Size > maxSize {
		driveFail(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("单文件上限 %d MB", maxSize>>20))
		return
	}
	name, ok := driveValidName(header.Filename)
	if !ok {
		driveFail(w, http.StatusBadRequest, "文件名不合法")
		return
	}

	// 配额聚合校验（服务端归口；quota=-1 不限）：现有占用 + 本次上传 > 配额 → 拒绝
	if quota := s.cfg.Drive.QuotaBytes; quota >= 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", username, false).Scan(&used)
		if used.Total+header.Size > quota {
			driveFail(w, http.StatusRequestEntityTooLarge, "网盘空间不足，请清理后再上传")
			return
		}
	}

	// 同目录同名拦截（与 mkdir/rename 同约束）
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		username, parentID, name).Count(&cnt)
	if cnt > 0 {
		driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
		return
	}

	st := store.GetObjectStore()
	if st == nil {
		driveFail(w, http.StatusInternalServerError, "存储后端未就绪")
		return
	}

	// 对象 key 服务端生成：drive/u/<owner>/<纳秒>_<16hex><ext>（纳秒_16hex 命名与聊天上传物同款，
	// 天然避开本地清理白名单正则的语义重叠；对象 key 与 static/upload 完全隔离）
	ext := strings.ToLower(filepath.Ext(name))
	b := make([]byte, 8)
	rand.Read(b)
	key := fmt.Sprintf("drive/u/%s/%d_%s%s", username, time.Now().UnixNano(), hex.EncodeToString(b), ext)

	// 对象级 Content-Disposition（原始文件名随对象存储，MinIO 预签名直连下载另存为显示原文件名）
	dispo := mime.FormatMediaType("attachment", map[string]string{"filename": name})

	if err := st.Put(r.Context(), key, file, header.Size, dispo); err != nil {
		driveFail(w, http.StatusInternalServerError, "文件保存失败")
		return
	}

	rec := model.DriveFile{
		Owner:     username,
		ParentID:  uint(parentID),
		Name:      name,
		Size:      header.Size,
		ObjectKey: key,
		MimeType:  driveMimeOf(name),
		MD5:       driveValidMD5(r.FormValue("md5")), // 客户端可带指纹（网盘前端统一分片链路，此为兼容位）
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		st.Delete(key) // 兜底清理孤儿对象
		driveFail(w, http.StatusInternalServerError, "记录创建失败")
		return
	}
	logger.Info("网盘上传: %s -> parent=%d, %s (%d 字节), key=%s, 后端=%s", username, parentID, name, header.Size, key, st.Kind())
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"item": rec})
}

// ===== 大文件链路（网盘二期）：MD5 秒传 + 分片上传 + 断点续传 =====
// 设计归口：
//  1. 秒传：init 按 owner+md5+size 命中本人历史对象（im_drive_file.md5 索引）→ 复用 object_key
//     直接建记录免传文件本体（drivePurgeObjects 引用计数归口天然支持共享对象，彻底删除零误删）
//  2. 断点续传：会话持久 MySQL（服务重启不丢断点），单片落盘成功即更新已传索引 JSON；
//     同 owner+md5+size 再次 init 自动复用会话并返回已传分片列表，前端跳过已传片
//  3. 分片本体落本地临时盘 up_tmp/<session_id>/<index>.part（独立于对象存储后端，不进
//     static/upload 清理范围），complete 时 MultiReader 流式合并进对象存储（TeeReader 顺路
//     复核 MD5，防伪造指纹占坑与传输损坏），随后会话与分片一并清理
//  4. 安全校验沿用水位：guardDrive 在线校验 + owner 隔离 + 名称消毒 + 会话码白名单（防路径
//     注入）+ 单片限长 + 配额 init/complete 双校验

// driveMD5Re MD5 指纹白名单（32 位 hex）
var driveMD5Re = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

// driveSessionIDRe 会话码白名单（服务端生成格式 纳秒_16hex；临时目录拼装防路径注入）
var driveSessionIDRe = regexp.MustCompile(`^[0-9]{19}_[0-9a-f]{16}$`)

// driveUploadSessionTTL 断点续传会话保留时长（超期会话连同分片目录被定时 GC 清理）
const driveUploadSessionTTL = 72 * time.Hour

// driveValidMD5 指纹消毒归口：非 32 位 hex 一律返回空串（合法值统一小写）
func driveValidMD5(s string) string {
	if driveMD5Re.MatchString(s) {
		return strings.ToLower(s)
	}
	return ""
}

// driveParseUploaded 解析已传分片索引 JSON 数组（空串/脏数据容错为空切片）
func driveParseUploaded(s string) []int {
	var arr []int
	if s != "" {
		_ = json.Unmarshal([]byte(s), &arr)
	}
	return arr
}

// handleDriveUploadInit 上传初始化 POST /api/drive/upload/init?username=xxx
// body {name,size,md5,parent_id}；响应二选一：
//   - 秒传命中：{instant:true, item}（复用历史 object_key，免传文件本体）
//   - 需传本体：{instant:false, session_id, chunk_size, chunk_total, uploaded:[已传分片索引]}
//
// 校验顺序：指纹/大小/名称消毒 → 目标目录存在 → 同名拦截 → 配额 → 秒传 → 断点会话复用 → 新建会话
func (s *Server) handleDriveUploadInit(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		MD5      string `json:"md5"`
		ParentID uint   `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	md5hex := driveValidMD5(body.MD5)
	if md5hex == "" {
		driveFail(w, http.StatusBadRequest, "文件指纹缺失")
		return
	}
	if body.Size < 0 || body.Size > s.cfg.Drive.MaxFileSize {
		driveFail(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("单文件上限 %d MB", s.cfg.Drive.MaxFileSize>>20))
		return
	}
	name, ok := driveValidName(body.Name)
	if !ok {
		driveFail(w, http.StatusBadRequest, "文件名不合法")
		return
	}
	if body.ParentID > 0 {
		if _, err := s.driveOwnFile(body.ParentID, username); err != nil {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return
		}
	}
	// 同名拦截（complete 为权威校验，此处前置拦截给用户即时反馈）
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		username, body.ParentID, name).Count(&cnt)
	if cnt > 0 {
		driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
		return
	}
	// 配额校验（服务端归口；quota=-1 不限）
	if quota := s.cfg.Drive.QuotaBytes; quota >= 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", username, false).Scan(&used)
		if used.Total+body.Size > quota {
			driveFail(w, http.StatusRequestEntityTooLarge, "网盘空间不足，请清理后再上传")
			return
		}
	}
	st := store.GetObjectStore()
	if st == nil {
		driveFail(w, http.StatusInternalServerError, "存储后端未就绪")
		return
	}
	// 秒传：本人历史对象命中即复用 object_key（零字节传输，秒级完成）
	var hit model.DriveFile
	if err := store.DB.Where("owner = ? AND md5 = ? AND size = ? AND object_key != ''",
		username, md5hex, body.Size).Order("create_time ASC").First(&hit).Error; err == nil {
		rec := model.DriveFile{
			Owner: username, ParentID: body.ParentID, Name: name, Size: body.Size,
			ObjectKey: hit.ObjectKey, MimeType: driveMimeOf(name), MD5: md5hex,
		}
		if err := store.DB.Create(&rec).Error; err != nil {
			driveFail(w, http.StatusInternalServerError, "记录创建失败")
			return
		}
		logger.Info("网盘秒传: %s -> parent=%d, %s (%d 字节), 复用 key=%s", username, body.ParentID, name, body.Size, hit.ObjectKey)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"instant": true, "item": rec})
		return
	}
	// 断点续传：本人同指纹未完成会话直接复用（chunk_size 取会话快照，跨配置变更仍一致）
	var sess model.DriveUploadSession
	if err := store.DB.Where("owner = ? AND md5 = ? AND size = ?", username, md5hex, body.Size).
		Order("update_time DESC").First(&sess).Error; err == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"instant": false, "session_id": sess.SessionID,
			"chunk_size": sess.ChunkSize, "chunk_total": sess.ChunkTotal,
			"uploaded": driveParseUploaded(sess.Uploaded),
		})
		return
	}
	// 新建会话（chunk_total = ceil(size/chunk_size)；空文件 0 片 complete 直通）
	chunkSize := s.cfg.Drive.ChunkSize
	total := (body.Size + chunkSize - 1) / chunkSize
	b := make([]byte, 8)
	rand.Read(b)
	sess = model.DriveUploadSession{
		SessionID:  fmt.Sprintf("%d_%s", time.Now().UnixNano(), hex.EncodeToString(b)),
		Owner:      username,
		Size:       body.Size,
		MD5:        md5hex,
		ChunkSize:  chunkSize,
		ChunkTotal: int(total),
		Uploaded:   "[]",
	}
	if err := store.DB.Create(&sess).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "会话创建失败")
		return
	}
	logger.Info("网盘分片会话创建: %s, %s (%d 字节), %d 片 x %d 字节, session=%s",
		username, name, body.Size, total, chunkSize, sess.SessionID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"instant": false, "session_id": sess.SessionID,
		"chunk_size": chunkSize, "chunk_total": sess.ChunkTotal,
		"uploaded": []int{},
	})
}

// handleDriveUploadChunk 上传单片 POST /api/drive/upload/chunk?username=&session_id=&index=
// raw body 流式落临时盘（os.Create 截断写，重试重传天然幂等）；成功后更新会话已传索引；
// 已传分片重复上传直接应答成功（断网重试/请求重放安全）
func (s *Server) handleDriveUploadChunk(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	sid := r.URL.Query().Get("session_id")
	if !driveSessionIDRe.MatchString(sid) {
		driveFail(w, http.StatusBadRequest, "非法会话")
		return
	}
	idx, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var sess model.DriveUploadSession
	if err := store.DB.Where("session_id = ? AND owner = ?", sid, username).First(&sess).Error; err != nil {
		driveFail(w, http.StatusNotFound, "上传会话不存在")
		return
	}
	if idx < 0 || idx >= sess.ChunkTotal {
		driveFail(w, http.StatusBadRequest, "分片序号越界")
		return
	}
	set := map[int]bool{}
	for _, v := range driveParseUploaded(sess.Uploaded) {
		set[v] = true
	}
	if !set[idx] {
		// 单片限长（chunk_size + 1MB 余量防异常超发；超限在 io.Copy 阶段报错统一拒绝）
		r.Body = http.MaxBytesReader(w, r.Body, sess.ChunkSize+1<<20)
		if err := driveWriteChunk(sid, idx, r.Body); err != nil {
			logger.Warn("网盘分片写入失败: %s[%d]: %v", sid, idx, err)
			driveFail(w, http.StatusBadRequest, "分片写入失败")
			return
		}
		// 已传索引落库（自动刷新 update_time 续命 TTL）
		set[idx] = true
		arr := make([]int, 0, len(set))
		for v := range set {
			arr = append(arr, v)
		}
		sort.Ints(arr)
		buf, _ := json.Marshal(arr)
		if err := store.DB.Model(&sess).Update("uploaded", string(buf)).Error; err != nil {
			logger.Warn("网盘分片索引更新失败: %s[%d]: %v", sid, idx, err)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "uploaded_count": len(set)})
}

// driveWriteChunk 单片落临时盘归口（路径经会话码白名单消毒，防路径注入）
func driveWriteChunk(sid string, idx int, rd io.Reader) error {
	p := filepath.Join(store.DriveTmpDir(), sid, fmt.Sprintf("%d.part", idx))
	if err := os.MkdirAll(filepath.Dir(p), os.ModePerm); err != nil {
		return err
	}
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, rd)
	return err
}

// handleDriveUploadComplete 完成合并 POST /api/drive/upload/complete?username=xxx
// body {session_id,name,parent_id}（重传场景以 complete 提交的目录/名称为准）
// 全片齐套 → 配额/同名权威校验 → MultiReader 流式合并进对象存储（TeeReader 复核 MD5）→ 落库
// → 会话与分片目录一并清理；MD5 不符视为数据损坏，对象/会话/分片全作废要求重传
func (s *Server) handleDriveUploadComplete(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var body struct {
		SessionID string `json:"session_id"`
		Name      string `json:"name"`
		ParentID  uint   `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !driveSessionIDRe.MatchString(body.SessionID) {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var sess model.DriveUploadSession
	if err := store.DB.Where("session_id = ? AND owner = ?", body.SessionID, username).First(&sess).Error; err != nil {
		driveFail(w, http.StatusNotFound, "上传会话不存在")
		return
	}
	// 全片齐套校验
	set := map[int]bool{}
	for _, v := range driveParseUploaded(sess.Uploaded) {
		set[v] = true
	}
	for i := 0; i < sess.ChunkTotal; i++ {
		if !set[i] {
			driveFail(w, http.StatusBadRequest, fmt.Sprintf("分片不完整（缺 %d/%d 片）", sess.ChunkTotal-len(set), sess.ChunkTotal))
			return
		}
	}
	name, ok := driveValidName(body.Name)
	if !ok {
		driveFail(w, http.StatusBadRequest, "文件名不合法")
		return
	}
	if body.ParentID > 0 {
		if _, err := s.driveOwnFile(body.ParentID, username); err != nil {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return
		}
	}
	// 同名拦截（权威校验：init 之后目标目录可能已新增同名项）
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		username, body.ParentID, name).Count(&cnt)
	if cnt > 0 {
		driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
		return
	}
	// 配额权威校验（init 后占用可能变化；失败保留会话与分片，清理空间后重传同文件自动续传直通 complete）
	if quota := s.cfg.Drive.QuotaBytes; quota >= 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", username, false).Scan(&used)
		if used.Total+sess.Size > quota {
			driveFail(w, http.StatusRequestEntityTooLarge, "网盘空间不足，请清理后再上传")
			return
		}
	}
	st := store.GetObjectStore()
	if st == nil {
		driveFail(w, http.StatusInternalServerError, "存储后端未就绪")
		return
	}
	// 合并流：按 index 顺序打开全部分片 MultiReader 串接，TeeReader 边写边算 MD5（零二次读盘）
	files := make([]*os.File, 0, sess.ChunkTotal)
	readers := make([]io.Reader, 0, sess.ChunkTotal)
	cleanup := false
	defer func() {
		for _, f := range files {
			f.Close()
		}
		// 句柄全部关闭后再删分片目录：Windows 下先删会因句柄占用静默失败残留孤儿目录
		if cleanup {
			s.driveAbortSession(&sess)
		}
	}()
	for i := 0; i < sess.ChunkTotal; i++ {
		f, err := os.Open(filepath.Join(store.DriveTmpDir(), sess.SessionID, fmt.Sprintf("%d.part", i)))
		if err != nil {
			driveFail(w, http.StatusInternalServerError, "分片读取失败，请重新上传")
			return
		}
		files = append(files, f)
		readers = append(readers, f)
	}
	ext := strings.ToLower(filepath.Ext(name))
	b := make([]byte, 8)
	rand.Read(b)
	key := fmt.Sprintf("drive/u/%s/%d_%s%s", username, time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dispo := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	h := md5.New()
	if err := st.Put(r.Context(), key, io.TeeReader(io.MultiReader(readers...), h), sess.Size, dispo); err != nil {
		st.Delete(key) // 兜底清理半写对象
		driveFail(w, http.StatusInternalServerError, "文件保存失败")
		return
	}
	// MD5 复核不符 = 传输损坏/指纹伪造：对象、会话、分片全作废
	if hex.EncodeToString(h.Sum(nil)) != sess.MD5 {
		st.Delete(key)
		cleanup = true // 分片目录随 defer（句柄关闭后）清理
		logger.Warn("网盘分片合并 MD5 不符: %s, %s, session=%s", username, name, sess.SessionID)
		driveFail(w, http.StatusBadRequest, "文件校验失败，请重新上传")
		return
	}
	rec := model.DriveFile{
		Owner: username, ParentID: body.ParentID, Name: name, Size: sess.Size,
		ObjectKey: key, MimeType: driveMimeOf(name), MD5: sess.MD5,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		st.Delete(key) // 兜底清理孤儿对象
		driveFail(w, http.StatusInternalServerError, "记录创建失败")
		return
	}
	cleanup = true // 会话行与分片目录随 defer（句柄关闭后）一并清理
	logger.Info("网盘分片上传完成: %s -> parent=%d, %s (%d 字节, %d 片), key=%s, 后端=%s",
		username, body.ParentID, name, sess.Size, sess.ChunkTotal, key, st.Kind())
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"item": rec})
}

// driveAbortSession 会话作废归口：删会话行 + 删分片目录（均幂等；GC 与 complete 共用）
func (s *Server) driveAbortSession(sess *model.DriveUploadSession) {
	store.DB.Delete(sess) // 模型无 DeletedAt 字段=物理删
	os.RemoveAll(filepath.Join(store.DriveTmpDir(), sess.SessionID))
}

// startDriveUploadGC 分片会话定时 GC：启动即清一次，此后每 6 小时一轮；
// 超 TTL 未更新的会话连同分片目录清理（断网/取消/放弃上传的孤儿数据归口）
func (s *Server) startDriveUploadGC() {
	go func() {
		for {
			var stale []model.DriveUploadSession
			store.DB.Where("update_time < ?", time.Now().Add(-driveUploadSessionTTL)).Find(&stale)
			for i := range stale {
				s.driveAbortSession(&stale[i])
			}
			if len(stale) > 0 {
				logger.Info("网盘分片会话 GC: 清理 %d 个超期会话", len(stale))
			}
			time.Sleep(6 * time.Hour)
		}
	}()
}

// driveMimeOf 按扩展名归口 MIME（前端图标/预览用；未知回退二进制流）
func driveMimeOf(name string) string {
	if m := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); m != "" {
		if i := strings.Index(m, ";"); i > 0 {
			m = m[:i]
		}
		return m
	}
	return "application/octet-stream"
}

// handleDriveDownload 下载 GET /api/drive/download?username=xxx&id=1
// MinIO 后端：302 跳 30 分钟短时效预签名地址（客户端直连 MinIO，省服务端带宽）；
// 本地后端：http.ServeContent 流式下发（自动支持 Range 断点续传与中文附件名）
func (s *Server) handleDriveDownload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	id, _ := strconv.ParseUint(r.URL.Query().Get("id"), 10, 64)
	rec, err := s.driveOwnFile(uint(id), username)
	if err != nil {
		http.Error(w, "文件不存在", http.StatusNotFound)
		return
	}
	if rec.IsDir {
		http.Error(w, "目录不支持下载", http.StatusBadRequest)
		return
	}
	// preview=1 时 inline 下发（网盘内在线预览：img/video/audio/pdf 标签内联渲染、文本 fetch 直显）
	s.serveDriveFile(w, r, rec, r.URL.Query().Get("preview") == "1")
}

// serveDriveFile 文件下发归口（本人下载与分享下载共用：校验后传记录即可，两种存储后端统一在此收口）
// inline=true 时以 Content-Disposition:inline 下发（分享页在线预览用，浏览器直接渲染而非另存）；
// 原签名：func (s *Server) serveDriveFile(w http.ResponseWriter, r *http.Request, rec *model.DriveFile)
func (s *Server) serveDriveFile(w http.ResponseWriter, r *http.Request, rec *model.DriveFile, inline bool) {
	st := store.GetObjectStore()
	if st == nil {
		http.Error(w, "存储后端未就绪", http.StatusInternalServerError)
		return
	}
	// MinIO 后端优先预签名直连（客户端不可达 MinIO 时自动回退服务端流式代理，两种部署形态都通）
	if st.Kind() == "minio" {
		if url, err := st.Presign(rec.ObjectKey, 30*time.Minute); err == nil {
			http.Redirect(w, r, url, http.StatusFound)
			return
		}
		logger.Warn("网盘预签名失败，回退服务端代理下载: key=%s", rec.ObjectKey)
	}
	rc, _, err := st.Open(rec.ObjectKey)
	if err != nil {
		http.Error(w, "文件读取失败", http.StatusNotFound)
		return
	}
	defer rc.Close()
	// 中文文件名 RFC 5987 编码（filename* 兜底 filename，浏览器/Electron 另存为均正确显示）；
	// inline=预览直显（img/video/pdf 标签内联渲染），attachment=另存为下载
	disp := "attachment"
	if inline {
		disp = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": rec.Name}))
	if seeker, ok := rc.(io.ReadSeeker); ok {
		http.ServeContent(w, r, rec.Name, rec.UpdateTime, seeker)
		return
	}
	w.Header().Set("Content-Type", rec.MimeType)
	io.Copy(w, rc)
}
