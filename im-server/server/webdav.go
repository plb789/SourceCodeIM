package server

// ===== 网盘挂载层（WebDAV，路线一：阿里云盘企业版挂载盘同原理） =====
// 设计归口（服务端统一数据归口，与 /api/drive/* 完全同源，禁止任何旁路读写）：
//  1. 协议：golang.org/x/net/webdav 标准实现（PROPFIND/GET/PUT/MKCOL/COPY/MOVE/DELETE/LOCK/UNLOCK），
//     Windows 资源管理器（WebClient 服务 + net use 映射本地盘符）与跨平台 WebDAV 客户端通用
//  2. 存储：webdav.FileSystem 桥接 drive.go 同一归口——元数据 im_drive_file（parent_id 目录树）、
//     文件本体经 store.ObjectStore（MinIO/本地双后端）；删除走回收站软删除（driveDeleteOne 复用，
//     资源管理器删除 = 网盘页面删除同语义）；对象清理沿用引用计数口径（秒传副本/回收站引用不误删）
//  3. 鉴权：Basic Auth（资源管理器映射盘唯一可用凭据形态）。密码为账号专属"挂载密码"：
//     由 jwt_secret + 用户密码哈希派生（非明文密码、不可逆推，修改密码自动失效）；
//     不要求 WS 在线——映射盘须在 IM 客户端关闭时仍可用，凭密码即身份（与网盘 API 在线水位差异为刻意设计）
//  4. 写链路：对象存储不支持改写，PUT 整文件先落临时盘（driveTmpDir/webdav_tmp，独立于
//     static/upload 清理范围），Close 时配额/单文件上限校验 → Put 对象存储 → 落库，失败全路径清理
//  5. 路由：/dav/ 前缀（main.go 注册归口），映射地址 http://<host>:<port>/dav

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/webdav"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// davPasswordSalt 挂载密码派生盐（用户改密 → 密码哈希变化 → 挂载密码自动轮换）
const davPasswordSalt = "im-dav-v1"

// driveDavPassword 挂载密码派生归口：sha256(salt:密码哈希) 前 32 位 hex
// （盐+DB 存储的密码哈希双因子派生，永不接触明文密码；密码哈希仅存 DB，不可逆推）
func driveDavPassword(passwordHash string) string {
	sum := sha256.Sum256([]byte(davPasswordSalt + ":" + passwordHash))
	return hex.EncodeToString(sum[:])[:32]
}

// davRootSentinel 根目录哨兵（ID=0；只读使用，禁止修改）
var davRootSentinel = &model.DriveFile{ID: 0, Name: "网盘", IsDir: true}

// RegisterWebDavRoutes 注册网盘挂载路由（main.go 调用归口；未启用时静默不注册）
func RegisterWebDavRoutes(s *Server) {
	if !s.driveEnabled() || !s.cfg.Drive.WebDav.Enabled {
		return
	}
	d := &davServer{s: s, handlers: map[string]*webdav.Handler{}}
	// WebDAV 全方法入口（OPTIONS/PROPFIND/GET/PUT/MKCOL/MOVE/COPY/DELETE/LOCK/UNLOCK 由 handler 分发）
	http.HandleFunc("/dav/", d.serveHTTP)
	// 挂载凭据查询（水位与 /api/drive/* 一致：guardDrive 在线校验归口）
	http.HandleFunc("GET /api/drive/webdav/info", s.guardDrive(s.handleDriveDavInfo))
	logger.Info("网盘挂载服务已启动: /dav/（WebDAV，资源管理器 net use 映射）")
}

// handleDriveDavInfo GET /api/drive/webdav/info?username=xxx
// 返回挂载凭据与状态（设置页渲染归口：映射地址由前端按当前 origin 拼装，服务端零硬编码 host）
func (s *Server) handleDriveDavInfo(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var u model.User
	if err := store.DB.Where("username = ?", username).First(&u).Error; err != nil {
		driveFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":      s.cfg.Drive.WebDav.Enabled,
		"username":     username,
		"dav_password": driveDavPassword(u.Password),
		"mount_path":   "/dav",
	})
}

// ===== WebDAV 入口与鉴权 =====

// davServer WebDAV 入口（每用户独立 Handler+LockSystem：锁系统按路径键控，路径不含用户名，
// 共用会跨用户误冲突；Handler 极轻量按需缓存即可）
type davServer struct {
	s        *Server
	mu       sync.Mutex
	opts     *webdav.Handler
	handlers map[string]*webdav.Handler
}

func (d *davServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if !d.s.driveEnabled() || !d.s.cfg.Drive.WebDav.Enabled {
		http.Error(w, "网盘挂载服务未启用", http.StatusNotFound)
		return
	}
	// OPTIONS 能力探测免鉴权归口（RFC 4918：客户端用 OPTIONS 发现服务器 DAV 能力，
	// 必须明文可答——否则 Windows WebClient 看不到 DAV 头直接判错误 67"找不到网络名称"；
	// OPTIONS 不触达文件系统，无越权面）
	if r.Method == "OPTIONS" {
		d.optionsHandler().ServeHTTP(w, r)
		return
	}
	user, pass, ok := r.BasicAuth()
	user = strings.TrimSpace(user)
	if !ok || user == "" || pass == "" || !driveUsernameRe.MatchString(user) {
		d.unauthorized(w)
		return
	}
	// 鉴权归口：账号存在 + 挂载密码常量时间比对（防时序侧信道）
	var u model.User
	if err := store.DB.Where("username = ?", user).First(&u).Error; err != nil ||
		subtle.ConstantTimeCompare([]byte(pass), []byte(driveDavPassword(u.Password))) != 1 {
		logger.Warn("网盘挂载鉴权失败: user=%s, ip=%s", user, r.RemoteAddr)
		time.Sleep(300 * time.Millisecond) // 防爆破固定延迟
		d.unauthorized(w)
		return
	}
	// 写操作目标名黑名单校验（挂载盘禁传可执行文件，归口同网盘 API 上传 driveUploadBlocked）：
	// PUT/POST 目标在 URL path（URL 路径分隔符恒为 /，用 path.Base 而非 filepath.Base）；
	// COPY/MOVE 的目标在 Destination 头——挂载盘内移动/复制生成 .exe 同样拦截
	switch r.Method {
	case "PUT", "POST":
		if ext := d.s.driveUploadBlocked(path.Base(r.URL.Path)); ext != "" {
			logger.Warn("网盘挂载上传黑名单拦截: user=%s, %s, %s", user, r.Method, r.URL.Path)
			http.Error(w, "禁止上传 "+ext+" 文件", http.StatusForbidden)
			return
		}
	case "COPY", "MOVE":
		if dst := r.Header.Get("Destination"); dst != "" {
			if du, err := url.Parse(dst); err == nil {
				if ext := d.s.driveUploadBlocked(path.Base(du.Path)); ext != "" {
					logger.Warn("网盘挂载上传黑名单拦截: user=%s, %s, %s", user, r.Method, du.Path)
					http.Error(w, "禁止上传 "+ext+" 文件", http.StatusForbidden)
					return
				}
			}
		}
	}
	d.handlerFor(user).ServeHTTP(w, r)
}

func (d *davServer) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="IM Drive WebDAV"`)
	http.Error(w, "401 unauthorized", http.StatusUnauthorized)
}

// handlerFor 每用户 Handler 缓存归口（独立 LockSystem 防跨用户锁冲突）
func (d *davServer) handlerFor(user string) *webdav.Handler {
	d.mu.Lock()
	defer d.mu.Unlock()
	if h, ok := d.handlers[user]; ok {
		return h
	}
	h := &webdav.Handler{
		Prefix:     "/dav",
		FileSystem: &davFS{s: d.s, user: user},
		LockSystem: webdav.NewMemLS(),
		Logger: func(req *http.Request, err error) {
			// x/net/webdav 的 Logger 对每个请求都会回调（成功请求 err 为 nil），
			// 不过滤会造成海量 "<nil>" 误报（实测：正常挂载即刷屏），仅真实错误落日志
			if err == nil {
				return
			}
			logger.Warn("网盘挂载协议错误: %v, path=%s", err, req.URL.Path)
		},
	}
	d.handlers[user] = h
	return h
}

// optionsHandler OPTIONS 免鉴权应答归口（DAV 1+2 能力头；FileSystem 不参与应答，占位即可）
func (d *davServer) optionsHandler() *webdav.Handler {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.opts == nil {
		d.opts = &webdav.Handler{
			Prefix:     "/dav",
			FileSystem: &davFS{s: d.s, user: ""},
			LockSystem: webdav.NewMemLS(),
		}
	}
	return d.opts
}

// ===== webdav.FileSystem 桥接实现（元数据 MySQL，本体 store.ObjectStore） =====

// davFS 单用户虚拟文件系统（路径即网盘目录树，name 形如 "/a/b.txt"，"/"=根）
type davFS struct {
	s    *Server
	user string
}

// davSegs 拆分虚拟路径（"/a/b" → ["a","b"]）；拒绝空名/./..//超长/控制字符（防穿越：
// 目录树全走 parent_id 不碰真实文件系统路径，天然免疫路径注入）
func davSegs(name string) ([]string, bool) {
	segs := []string{}
	for _, seg := range strings.Split(name, "/") {
		if seg == "" {
			continue
		}
		if seg == "." || seg == ".." || len([]rune(seg)) > 255 {
			return nil, false
		}
		for _, c := range seg {
			if c < 0x20 {
				return nil, false
			}
		}
		segs = append(segs, seg)
	}
	return segs, true
}

// davResolve 逐段解析虚拟路径 → 记录（根返回哨兵）；任一段缺失返回 os.ErrNotExist
func (f *davFS) davResolve(name string) (*model.DriveFile, error) {
	segs, ok := davSegs(name)
	if !ok {
		return nil, os.ErrInvalid
	}
	var parentID uint
	var rec *model.DriveFile
	for _, seg := range segs {
		var cur model.DriveFile
		if err := store.DB.Where("owner = ? AND parent_id = ? AND name = ?", f.user, parentID, seg).
			First(&cur).Error; err != nil {
			// 包装为 *os.PathError（保留 os.ErrNotExist 语义）：x/net/webdav 的
			// PROPFIND 遍历仅对 *os.PathError 按"坏文件跳过"处理，裸 ErrNotExist
			// 会中断整棵目录树枚举（单条元数据异常即挂载盘整层不可见，实测踩坑）
			return nil, &os.PathError{Op: "resolve", Path: name, Err: os.ErrNotExist}
		}
		parentID = cur.ID
		tmp := cur
		rec = &tmp
	}
	if rec == nil {
		return davRootSentinel, nil
	}
	return rec, nil
}

// davParentID 父目录 ID 解析归口（末段之前的段必须存在且为目录）
func (f *davFS) davParentID(segs []string) (uint, error) {
	if len(segs) == 0 {
		return 0, nil // 根
	}
	rec, err := f.davResolve("/" + strings.Join(segs, "/"))
	if err != nil {
		return 0, err
	}
	if !rec.IsDir {
		return 0, os.ErrInvalid
	}
	return rec.ID, nil
}

// Mkdir MKCOL：单级目录创建（父必须存在为目录，同名拦截与网盘页面同约束）
func (f *davFS) Mkdir(_ context.Context, name string, _ os.FileMode) error {
	segs, ok := davSegs(name)
	if !ok {
		return os.ErrInvalid
	}
	if len(segs) == 0 {
		return os.ErrExist // 根目录已存在
	}
	parentID, err := f.davParentID(segs[:len(segs)-1])
	if err != nil {
		return err
	}
	leaf, ok := driveValidName(segs[len(segs)-1])
	if !ok {
		return os.ErrInvalid
	}
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		f.user, parentID, leaf).Count(&cnt)
	if cnt > 0 {
		return os.ErrExist
	}
	rec := model.DriveFile{Owner: f.user, ParentID: parentID, Name: leaf, IsDir: true}
	if err := store.DB.Create(&rec).Error; err != nil {
		return err
	}
	logger.Info("网盘挂载新建文件夹: %s -> %s (parent=%d)", f.user, leaf, parentID)
	return nil
}

// OpenFile 打开文件/目录（读：对象流或目录枚举；写：临时盘整文件暂存，Close 收口落存储）
func (f *davFS) OpenFile(_ context.Context, name string, flag int, _ os.FileMode) (webdav.File, error) {
	rec, err := f.davResolve(name)
	// 写路径允许目标尚不存在（O_CREATE 创建语义）；读路径目标必须存在
	if err != nil && !(writeFlag(flag) && errors.Is(err, os.ErrNotExist)) {
		return nil, err
	}
	if writeFlag(flag) {
		if err == nil && rec != davRootSentinel && rec.IsDir {
			return nil, os.ErrInvalid
		}
		// 解析父目录与末段名（OpenFile 时校验，失败提前回错误；注意不得遮蔽外层 resolve 的 err）
		segs, ok := davSegs(name)
		if !ok || len(segs) == 0 {
			return nil, os.ErrInvalid
		}
		parentID, perr := f.davParentID(segs[:len(segs)-1])
		if perr != nil {
			return nil, perr
		}
		leaf, ok := driveValidName(segs[len(segs)-1])
		if !ok {
			return nil, os.ErrInvalid
		}
		if err := os.MkdirAll(davSpoolDir(), os.ModePerm); err != nil {
			return nil, err
		}
		tmp, terr := os.CreateTemp(davSpoolDir(), "put-*")
		if terr != nil {
			return nil, terr
		}
		var exist *model.DriveFile
		if err == nil && rec != davRootSentinel && !rec.IsDir {
			exist = rec // 覆盖写目标（PUT 语义=整文件替换）
		}
		return &davWriteFile{fs: f, tmp: tmp, exist: exist, parentID: parentID, leaf: leaf,
			elfHead: davElfHeadInit(f.s)}, nil
	}
	// 读路径：目录 → 枚举器；文件 → 对象流
	if rec == davRootSentinel || rec.IsDir {
		return f.davDirFile(rec)
	}
	st := store.GetObjectStore()
	if st == nil {
		return nil, os.ErrInvalid
	}
	rc, _, err := st.Open(rec.ObjectKey)
	if err != nil {
		// 本体打开失败（对象缺失/存储后端故障）：元数据在而本体缺失属数据不一致，落日志便于排查。
		// 包装为单层 *os.PathError（Err 恒为 os.ErrNotExist，防止 PathError 嵌套破坏
		// os.IsNotExist 单层解包语义）：① PROPFIND 遍历跳过该坏文件，不再中断整棵
		// 目录树（挂载盘列表瘫痪根因）② GET/读路径 os.IsNotExist → 404 行为不变
		logger.Warn("网盘挂载本体打开失败: %s objkey=%s err=%v", name, rec.ObjectKey, err)
		return nil, &os.PathError{Op: "open", Path: name, Err: os.ErrNotExist}
	}
	return &davReadFile{rc: rc, info: davInfoOf(rec)}, nil
}

// writeFlag 判断 OpenFile 是否写语义（O_WRONLY/O_RDWR/O_APPEND 任一即写）
func writeFlag(flag int) bool {
	return flag&(os.O_WRONLY|os.O_RDWR|os.O_APPEND) != 0
}

// RFC 4331 配额属性名（DAV: 命名空间；rclone About → VFS 容量 → 资源管理器盘符
// "总空间/已用/可用"显示归口。x/net/webdav 内置 liveProps 不含 quota，挂载盘因此
// 显示 1PB 默认假值，经 DeadPropsHolder 注入归口修复）
var (
	davPropQuotaUsed  = xml.Name{Space: "DAV:", Local: "quota-used-bytes"}
	davPropQuotaAvail = xml.Name{Space: "DAV:", Local: "quota-available-bytes"}
)

// davDirFile 目录枚举器（PROPFIND 数据源；根目录附加 RFC 4331 配额属性）
func (f *davFS) davDirFile(rec *model.DriveFile) (webdav.File, error) {
	isRoot := rec == davRootSentinel
	var id uint
	if !isRoot {
		id = rec.ID
	}
	var items []model.DriveFile
	if err := store.DB.Where("owner = ? AND parent_id = ?", f.user, id).
		Order("is_dir DESC, name ASC").Find(&items).Error; err != nil {
		return nil, err
	}
	infos := make([]os.FileInfo, len(items))
	for i := range items {
		infos[i] = davInfoOf(&items[i])
	}
	df := &davDirFile{infos: infos, info: davInfoOf(rec)}
	// 配额查询仅在根目录 PROPFIND 时发生一次（与 /api/drive/list 的 used_bytes 同口径）
	if isRoot && f.s.cfg.Drive.QuotaBytes > 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", f.user, false).Scan(&used)
		df.usedBytes = used.Total
		df.quotaBytes = f.s.cfg.Drive.QuotaBytes
	}
	return df, nil
}

// RemoveAll DELETE：整棵子树移入回收站（软删除归口，与网盘页面删除完全同语义）
func (f *davFS) RemoveAll(_ context.Context, name string) error {
	rec, err := f.davResolve(name)
	if err != nil {
		return err
	}
	if rec == davRootSentinel {
		return os.ErrInvalid // 根目录不可删
	}
	f.s.driveDeleteOne(f.user, rec)
	return nil
}

// Rename MOVE：改名与移动一体（同父=改名，跨父=移动）；目录移入自身子孙拒绝（防环）；
// 覆盖已存在目标按拒绝处理（资源管理器拖拽极少命中，拒绝优于误删）
func (f *davFS) Rename(_ context.Context, oldName, newName string) error {
	src, err := f.davResolve(oldName)
	if err != nil {
		return err
	}
	if src == davRootSentinel {
		return os.ErrInvalid
	}
	segs, ok := davSegs(newName)
	if !ok || len(segs) == 0 {
		return os.ErrInvalid
	}
	parentID, err := f.davParentID(segs[:len(segs)-1])
	if err != nil {
		return err
	}
	leaf, ok := driveValidName(segs[len(segs)-1])
	if !ok {
		return os.ErrInvalid
	}
	// 防环：目标父链上溯命中自身 → 拒绝（与 /api/drive/move driveCycleHit 同语义）
	if src.IsDir {
		cur := parentID
		for i := 0; i < 64 && cur != 0; i++ {
			if cur == src.ID {
				return os.ErrInvalid
			}
			var p model.DriveFile
			if err := store.DB.Select("parent_id").Where("id = ?", cur).First(&p).Error; err != nil {
				break
			}
			cur = p.ParentID
		}
	}
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ? AND id != ?",
		f.user, parentID, leaf, src.ID).Count(&cnt)
	if cnt > 0 {
		return os.ErrExist
	}
	if err := store.DB.Model(&model.DriveFile{}).Where("id = ?", src.ID).
		Updates(map[string]interface{}{"name": leaf, "parent_id": parentID}).Error; err != nil {
		return err
	}
	logger.Info("网盘挂载重命名/移动: %s id=%d -> parent=%d name=%s", f.user, src.ID, parentID, leaf)
	return nil
}

// Stat 条目信息
func (f *davFS) Stat(_ context.Context, name string) (os.FileInfo, error) {
	rec, err := f.davResolve(name)
	if err != nil {
		return nil, err
	}
	return davInfoOf(rec), nil
}

// ===== FileInfo 实现（PROPFIND/资源管理器列目录数据源） =====

type davInfo struct {
	name    string
	size    int64
	isDir   bool
	modTime time.Time
}

func (i davInfo) Name() string { return i.name }
func (i davInfo) Size() int64  { return i.size }
func (i davInfo) Mode() os.FileMode {
	if i.isDir {
		return os.ModeDir | 0755
	}
	return 0644
}
func (i davInfo) ModTime() time.Time { return i.modTime }
func (i davInfo) IsDir() bool        { return i.isDir }
func (i davInfo) Sys() interface{}   { return nil }

// davInfoOf 记录 → FileInfo（空时间兜底当前时刻：WebDAV getlastmodified 零值时间部分客户端解析异常）
func davInfoOf(rec *model.DriveFile) os.FileInfo {
	mt := rec.UpdateTime
	if mt.IsZero() {
		mt = time.Now()
	}
	return davInfo{name: rec.Name, size: rec.Size, isDir: rec.IsDir, modTime: mt}
}

// ===== webdav.File 实现 =====

// davReadFile 文件读取流（本地后端 *os.File / MinIO Object 均支持 Seek，GET Range 断点续传直通）
type davReadFile struct {
	rc   io.ReadCloser
	info os.FileInfo
}

func (f *davReadFile) Read(p []byte) (int, error) { return f.rc.Read(p) }
func (f *davReadFile) Close() error               { return f.rc.Close() }
func (f *davReadFile) Seek(off int64, whence int) (int64, error) {
	if s, ok := f.rc.(io.Seeker); ok {
		return s.Seek(off, whence)
	}
	return 0, os.ErrInvalid
}
func (f *davReadFile) Readdir(int) ([]os.FileInfo, error) { return nil, os.ErrInvalid }
func (f *davReadFile) Stat() (os.FileInfo, error)         { return f.info, nil }
func (f *davReadFile) Write([]byte) (int, error)          { return 0, os.ErrInvalid }

// davDirFile 目录枚举器
type davDirFile struct {
	infos      []os.FileInfo
	info       os.FileInfo
	off        int
	usedBytes  int64 // 根目录配额数据（RFC 4331 DeadProps 注入用；非根恒为 0 不返回属性）
	quotaBytes int64
}

// DeadProps RFC 4331 配额属性注入（webdav.DeadPropsHolder）：仅根目录返回，rclone About
// 据此换算挂载盘真实容量（总空间=已用+可用=配额）；返回空 map 时属性走内置 404 分支，无副作用。
// 注意接口含 DeadProps+Patch 双方法，缺 Patch 时类型断言失败、注入静默失效（实测踩坑）
func (f *davDirFile) DeadProps() (map[xml.Name]webdav.Property, error) {
	if f.quotaBytes <= 0 {
		return nil, nil
	}
	avail := f.quotaBytes - f.usedBytes
	if avail < 0 {
		avail = 0
	}
	return map[xml.Name]webdav.Property{
		davPropQuotaUsed:  {XMLName: davPropQuotaUsed, InnerXML: []byte(strconv.FormatInt(f.usedBytes, 10))},
		davPropQuotaAvail: {XMLName: davPropQuotaAvail, InnerXML: []byte(strconv.FormatInt(avail, 10))},
	}, nil
}

// Patch PROPPATCH 处理归口（DeadPropsHolder 接口要求）：挂载层不支持死属性写，
// 一律 403 Forbidden，与 x/net/webdav 无 DeadPropsHolder 时的内置拒绝语义一致
func (f *davDirFile) Patch(patches []webdav.Proppatch) ([]webdav.Propstat, error) {
	pstat := webdav.Propstat{Status: http.StatusForbidden}
	for _, p := range patches {
		for _, pn := range p.Props {
			pstat.Props = append(pstat.Props, webdav.Property{XMLName: pn.XMLName})
		}
	}
	return []webdav.Propstat{pstat}, nil
}

func (f *davDirFile) Read([]byte) (int, error)       { return 0, os.ErrInvalid }
func (f *davDirFile) Close() error                   { return nil }
func (f *davDirFile) Seek(int64, int) (int64, error) { return 0, os.ErrInvalid }
func (f *davDirFile) Stat() (os.FileInfo, error)     { return f.info, nil }
func (f *davDirFile) Write([]byte) (int, error)      { return 0, os.ErrInvalid }
func (f *davDirFile) Readdir(count int) ([]os.FileInfo, error) {
	remaining := len(f.infos) - f.off
	if remaining <= 0 {
		if count > 0 {
			return nil, io.EOF
		}
		return nil, nil
	}
	if count <= 0 || count > remaining {
		count = remaining
	}
	out := f.infos[f.off : f.off+count]
	f.off += count
	return out, nil
}

// davWriteFile PUT 写入器：整文件暂存临时盘（对象存储不支持改写），Close 时校验+落库归口
type davWriteFile struct {
	fs       *davFS
	tmp      *os.File
	exist    *model.DriveFile // 覆盖写目标（nil=新建）
	parentID uint
	leaf     string
	done     bool
	// ELF 魔数检测状态（Linux 可执行无强制扩展名，扩展名黑名单挡不住改名 ELF）：
	// elfHead 非 nil 且 len<4 时仍在收集头字节，攒满 4 字节判定命中即断流；
	// aborted 置位后 Close 不再转正落库（半写临时文件由 defer os.Remove 兜底清理）
	elfHead []byte
	aborted bool
}

// davElfHeadInit ELF 检测启用时返回空收集器（nil=未启用零开销直通）
func davElfHeadInit(s *Server) []byte {
	if s.driveBlockElf() {
		return []byte{}
	}
	return nil
}

func (f *davWriteFile) Read([]byte) (int, error)                  { return 0, os.ErrInvalid }
func (f *davWriteFile) Seek(off int64, whence int) (int64, error) { return f.tmp.Seek(off, whence) }
func (f *davWriteFile) Readdir(int) ([]os.FileInfo, error)        { return nil, os.ErrInvalid }
func (f *davWriteFile) Stat() (os.FileInfo, error) {
	// 上传窗口期给临时文件口径（资源管理器不依赖该值；PUT 完成后 PROPFIND 走库）
	if fi, err := f.tmp.Stat(); err == nil {
		return davInfo{name: f.leaf, size: fi.Size(), modTime: time.Now()}, nil
	}
	return davInfo{name: f.leaf, modTime: time.Now()}, nil
}

func (f *davWriteFile) Write(p []byte) (int, error) {
	// ELF 头收集判定：首块写入即含文件头（rclone/资源管理器写块远大于 4 字节，一轮即判定）
	if f.elfHead != nil && len(f.elfHead) < 4 {
		need := 4 - len(f.elfHead)
		if need > len(p) {
			f.elfHead = append(f.elfHead, p...)
		} else {
			f.elfHead = append(f.elfHead, p[:need]...)
		}
		if len(f.elfHead) == 4 && bytes.Equal(f.elfHead, elfMagic) {
			f.aborted = true
			logger.Warn("网盘挂载上传黑名单拦截: %s, %s (ELF)", f.fs.user, f.leaf)
			return 0, errDriveElfBlocked // 断流：x/net/webdav 对 Copy/Close 错误统一映射 405，PUT 失败
		}
	}
	n, err := f.tmp.Write(p)
	// 单文件上限边写边拦（超限即断流，客户端立即可见失败，不再白传全量）
	if err == nil && n > 0 {
		if max := f.fs.s.cfg.Drive.MaxFileSize; max > 0 {
			if pos, _ := f.tmp.Seek(0, io.SeekCurrent); pos > max {
				return n, fmt.Errorf("单文件上限 %d MB", max>>20)
			}
		}
	}
	return n, err
}

func (f *davWriteFile) Close() error {
	if f.done {
		return nil
	}
	f.done = true
	defer os.Remove(f.tmp.Name()) // 临时文件全路径兜底清理
	if f.aborted {
		return errDriveElfBlocked // ELF 拦截断流：不转正不落库（与 Write 返回错误同口径）
	}
	fi, err := f.tmp.Stat()
	if err != nil {
		return err
	}
	size := fi.Size()
	if max := f.fs.s.cfg.Drive.MaxFileSize; max > 0 && size > max {
		return fmt.Errorf("单文件上限 %d MB", max>>20)
	}
	replace := int64(0)
	if f.exist != nil {
		replace = f.exist.Size
	}
	if !f.fs.davQuotaOK(size, replace) {
		return fmt.Errorf("网盘空间不足")
	}
	st := store.GetObjectStore()
	if st == nil {
		return os.ErrInvalid
	}
	// 对象 key 服务端生成（与网盘上传同款纳秒_16hex 命名，天然避开 static/upload 清理白名单）
	ext := strings.ToLower(filepath.Ext(f.leaf))
	b := make([]byte, 8)
	rand.Read(b)
	key := fmt.Sprintf("drive/u/%s/%d_%s%s", f.fs.user, time.Now().UnixNano(), hex.EncodeToString(b), ext)
	if _, err := f.tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	dispo := mime.FormatMediaType("attachment", map[string]string{"filename": f.leaf})
	if err := st.Put(context.Background(), key, f.tmp, size, dispo); err != nil {
		return err
	}
	if f.exist != nil {
		// 覆盖既有文件：元数据指向新对象；旧对象按引用计数口径清理（秒传副本/回收站引用不误删）
		updates := map[string]interface{}{"size": size, "object_key": key, "mime_type": driveMimeOf(f.leaf)}
		if err := store.DB.Model(&model.DriveFile{}).Where("id = ?", f.exist.ID).Updates(updates).Error; err != nil {
			st.Delete(key)
			return err
		}
		f.fs.davMaybeDeleteOldObject(f.exist.ID, f.exist.ObjectKey, key)
		logger.Info("网盘挂载覆盖写: %s id=%d %s (%d 字节)", f.fs.user, f.exist.ID, f.leaf, size)
	} else {
		rec := model.DriveFile{Owner: f.fs.user, ParentID: f.parentID, Name: f.leaf,
			Size: size, ObjectKey: key, MimeType: driveMimeOf(f.leaf)}
		if err := store.DB.Create(&rec).Error; err != nil {
			st.Delete(key) // 兜底清理孤儿对象（与网盘上传同口径）
			return err
		}
		logger.Info("网盘挂载写入: %s -> parent=%d, %s (%d 字节)", f.fs.user, f.parentID, f.leaf, size)
	}
	return nil
}

// davQuotaOK 配额校验归口（quota=-1 不限；覆盖写扣除被替换文件现有占用，与网盘上传聚合口径一致）
func (f *davFS) davQuotaOK(size int64, replace int64) bool {
	q := f.s.cfg.Drive.QuotaBytes
	if q < 0 {
		return true
	}
	var used struct {
		Total int64
	}
	store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
		Where("owner = ? AND is_dir = ?", f.user, false).Scan(&used)
	return used.Total+size-replace <= q
}

// davMaybeDeleteOldObject 覆盖写后旧对象清理（drivePurgeObjects 同口径：Unscoped 全表引用计数，
// 排除本记录与新 key 的既有引用；仍被引用则保留，孤儿容忍不影响正确性）
func (f *davFS) davMaybeDeleteOldObject(existID uint, oldKey, newKey string) {
	if oldKey == "" || oldKey == newKey {
		return
	}
	var refCnt int64
	store.DB.Unscoped().Model(&model.DriveFile{}).Where("object_key = ? AND id != ?", oldKey, existID).Count(&refCnt)
	if refCnt > 0 {
		return
	}
	if st := store.GetObjectStore(); st != nil {
		st.Delete(oldKey)
	}
}

// davSpoolDir PUT 临时盘归口（driveTmpDir/webdav_tmp：独立于对象存储后端与 static/upload 清理范围）
func davSpoolDir() string {
	return filepath.Join(store.DriveTmpDir(), "webdav_tmp")
}
