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
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
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
	http.HandleFunc("POST /api/drive/upload", s.guardDrive(s.handleDriveUpload))
	http.HandleFunc("GET /api/drive/download", s.guardDrive(s.handleDriveDownload))
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

// handleDriveDelete 删除 POST /api/drive/delete {username,id}
// 目录递归删除全部子孙（BFS 收集后事务清行、逐个清对象；对象删除失败仅记日志不阻断——
// 孤儿对象可由后续清理任务回收，元数据为准）
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
	// BFS 收集子孙 id（含自身）；owner 条件贯穿每层，杜绝跨用户越权
	ids := []uint{root.ID}
	frontier := []uint{root.ID}
	var fileKeys []string
	if !root.IsDir && root.ObjectKey != "" {
		fileKeys = append(fileKeys, root.ObjectKey)
	}
	for len(frontier) > 0 {
		var children []model.DriveFile
		if err := store.DB.Where("owner = ? AND parent_id IN ?", body.Username, frontier).Find(&children).Error; err != nil {
			break
		}
		frontier = frontier[:0]
		for _, c := range children {
			ids = append(ids, c.ID)
			if !c.IsDir && c.ObjectKey != "" {
				fileKeys = append(fileKeys, c.ObjectKey)
			}
			frontier = append(frontier, c.ID)
		}
	}
	store.DB.Where("id IN ?", ids).Delete(&model.DriveFile{})
	// 文件本体清理（幂等；失败不阻断——元数据已删，孤儿对象不影响功能正确性）
	// 零拷贝保护归口：分享保存指向同一 object_key 不复制本体，物理删除前必须确认
	// 已无任何其他记录（未被级联删除的）引用同一 key，否则只删记录保留对象，防受让方悬空
	if st := store.GetObjectStore(); st != nil {
		for _, key := range fileKeys {
			var refCnt int64
			store.DB.Model(&model.DriveFile{}).Where("object_key = ? AND id NOT IN ?", key, ids).Count(&refCnt)
			if refCnt > 0 {
				continue // 对象仍被其他记录引用（分享受让副本等），跳过物理删除
			}
			if err := st.Delete(key); err != nil {
				logger.Warn("网盘对象删除失败（孤儿对象）: %s, %v", key, err)
			}
		}
	}
	logger.Info("网盘删除: %s id=%d (%s), 级联 %d 项, 对象 %d 个", body.Username, root.ID, root.Name, len(ids), len(fileKeys))
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
	s.serveDriveFile(w, r, rec)
}

// serveDriveFile 文件下发归口（本人下载与分享下载共用：校验后传记录即可，两种存储后端统一在此收口）
func (s *Server) serveDriveFile(w http.ResponseWriter, r *http.Request, rec *model.DriveFile) {
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
	// 中文文件名 RFC 5987 编码（filename* 兜底 filename，浏览器/Electron 另存为均正确显示）
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": rec.Name}))
	if seeker, ok := rc.(io.ReadSeeker); ok {
		http.ServeContent(w, r, rec.Name, rec.UpdateTime, seeker)
		return
	}
	w.Header().Set("Content-Type", rec.MimeType)
	io.Copy(w, rc)
}
