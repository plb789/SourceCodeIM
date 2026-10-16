package server

// ===== 游戏中心·管理端（Steam 同款游戏库运营，adminGuard 鉴权） =====
// 设计归口：
//   1. 游戏增删改查与版本管理走 /admin/api/game/*（复用 adminGuard + adminJSON/adminFail 归口）
//   2. 游戏文件经专用分片上传通道 POST /admin/api/game/upload/chunk（raw body，与聊天分片直传
//      隔离——游戏文件数十 GB 且面向管理员，不入聊天会话体系），临时分片落
//      game_data/tmp_chunks/<upload_id>/<seq>.part，版本上架登记时流式合并落位并复算 SHA256
//      （不信任客户端声明的哈希，合并即校验，单遍 MultiWriter 零额外 IO）
//   3. 封面/截图走 multipart 小图通道 POST /admin/api/game/upload/image，落 WebDir/static/upload/games/
//      由静态服务天然托管
//   4. rel_path 上架时归口清洗（禁绝对路径/父目录引用/盘符），storage_path 服务端私有绝不外泄

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

// 游戏分片上传会话超时：游戏包大、上传链路慢，放宽至 24 小时（惰性清理，不启定时器）
const gameUploadSessionTimeout = 24 * time.Hour

// gameUploadSessions 分片上传会话表（仅内存：重启丢失即重传，会话内分片已落盘仍有效但
// 登记表丢失后 upload_id 不可续传——管理端上传失败重开即可，量级可接受）
var gameUploadSessions = struct {
	sync.Mutex
	m map[string]*gameUploadSession
}{m: make(map[string]*gameUploadSession)}

type gameUploadSession struct {
	UploadID  string
	Kind      string // game=游戏包 / video=宣传视频（两通道共用会话表与临时目录，Kind 区分互不串道）
	Ext       string // 视频扩展名（video 会话专用，如 ".mp4"，合并落位取名用）
	Total     int
	FileSize  int64
	Received  map[int]int64
	CreatedAt time.Time
}

// gameSlugRe slug 白名单：小写字母/数字/下划线/中划线（=安装目录名，跨平台路径安全）
var gameSlugRe = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

// gameImageExts 封面/截图扩展名白名单
var gameImageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

// gameTmpDir 分片临时目录：game_data/tmp_chunks/<upload_id>/
func (s *Server) gameTmpDir(uploadID string) string {
	return filepath.Join(s.cfg.Game.LocalDir, "tmp_chunks", uploadID)
}

// gameRelPathClean 清洗清单相对路径（归口）：反斜杠转正斜杠、禁父目录引用/绝对路径/盘符/空白，
// 返回清洗后的相对路径；非法返回空串
func gameRelPathClean(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "//") {
		return ""
	}
	// 与 im_game_file.rel_path varchar(245) 对齐（按字符数计，utf8mb4 下 245×4B=980B 压入索引上限）：
	// 超长路径入库必截断破坏唯一索引语义，直接拒绝
	if utf8.RuneCountInString(p) > 245 {
		return ""
	}
	if strings.Contains(p, ":") { // 盘符（C:/）与协议（http://）一并拒绝
		return ""
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return ""
		}
	}
	if strings.ContainsAny(p, "\x00") {
		return ""
	}
	return p
}

// gameVersionClean 清洗版本号（=版本目录名）：禁路径分隔符与父目录引用，限 1-32 字符
func gameVersionClean(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 32 || strings.ContainsAny(v, "/\\") || strings.Contains(v, "..") || strings.Contains(v, ":") {
		return ""
	}
	return v
}

// gameLaunchArgsClean 清洗启动参数模板：限 1024 字符（与 varchar(1024) 对齐），去首尾空白；
// 占位符 {0}=登录账号 {1}=账号专属16位密码 由客户端启动时替换，此处仅做长度/空白归口
func gameLaunchArgsClean(a string) string {
	a = strings.TrimSpace(a)
	if utf8.RuneCountInString(a) > 1024 {
		r := []rune(a)
		a = string(r[:1024])
	}
	return a
}

// gameLaunchNameClean 清洗启动程序显示名称：限 128 字符（与 varchar(128) 对齐）
func gameLaunchNameClean(n string) string {
	n = strings.TrimSpace(n)
	if utf8.RuneCountInString(n) > 128 {
		r := []rune(n)
		n = string(r[:128])
	}
	return n
}

// gameSavePathsClean 清洗云存档采集/排除路径（归口）：入参须为合法 JSON 数组串（元素 trim 去空后重组），
// 结果限 1024 字符（与 varchar(1024) 对齐）；解析失败或为空一律回退空串（与现有清洗 helper 一致的容错语义）
func gameSavePathsClean(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var raw []string
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return ""
	}
	out := make([]string, 0, len(raw))
	for _, p := range raw {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return ""
	}
	b, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	if utf8.RuneCountInString(string(b)) > 1024 {
		return ""
	}
	return string(b)
}

// sweepExpiredGameUploads 惰性清理过期分片会话（每次首片顺带扫描）
func (s *Server) sweepExpiredGameUploads() {
	now := time.Now()
	gameUploadSessions.Lock()
	defer gameUploadSessions.Unlock()
	for id, sess := range gameUploadSessions.m {
		if now.Sub(sess.CreatedAt) > gameUploadSessionTimeout {
			delete(gameUploadSessions.m, id)
			os.RemoveAll(s.gameTmpDir(id))
		}
	}
}

// registerGameAdminRoutes 管理端路由（adminGuard 包裹）
func registerGameAdminRoutes(s *Server) {
	http.HandleFunc("POST /admin/api/game", s.adminGuard(s.handleAdminGameCreate))
	http.HandleFunc("GET /admin/api/game/list", s.adminGuard(s.handleAdminGameList))
	http.HandleFunc("GET /admin/api/game/{id}", s.adminGuard(s.handleAdminGameDetail))
	http.HandleFunc("PUT /admin/api/game/{id}", s.adminGuard(s.handleAdminGameUpdate))
	http.HandleFunc("DELETE /admin/api/game/{id}", s.adminGuard(s.handleAdminGameDelete))
	http.HandleFunc("POST /admin/api/game/{id}/version", s.adminGuard(s.handleAdminGameVersionCreate))
	http.HandleFunc("DELETE /admin/api/game/version/{vid}", s.adminGuard(s.handleAdminGameVersionDelete))
	// 游戏公告（库内游戏页"动态"区数据源）
	http.HandleFunc("GET /admin/api/game/notices", s.adminGuard(s.handleAdminGameNoticesGet))
	http.HandleFunc("POST /admin/api/game/notice", s.adminGuard(s.handleAdminGameNoticeCreate))
	http.HandleFunc("PUT /admin/api/game/notice/{id}", s.adminGuard(s.handleAdminGameNoticeUpdate))
	http.HandleFunc("DELETE /admin/api/game/notice/{id}", s.adminGuard(s.handleAdminGameNoticeDelete))
	http.HandleFunc("POST /admin/api/game/upload/chunk", s.adminGuard(s.handleAdminGameChunk))
	http.HandleFunc("POST /admin/api/game/upload/cancel", s.adminGuard(s.handleAdminGameChunkCancel))
	http.HandleFunc("POST /admin/api/game/upload/image", s.adminGuard(s.handleAdminGameImage))
	// 自制种子上传通道（下载方式=2=BT·上传种子；multipart 单文件，轻校验后落 LocalDir/torrents/uploaded/）
	http.HandleFunc("POST /admin/api/game/upload/torrent", s.adminGuard(s.handleAdminGameTorrentUpload))
	// 宣传视频分片通道（商店详情页媒体区 <video> 内联播放用；与游戏包通道共用会话表，Kind 区分）
	http.HandleFunc("POST /admin/api/game/upload/video", s.adminGuard(s.handleAdminGameVideoChunk))
	http.HandleFunc("POST /admin/api/game/upload/video/finish", s.adminGuard(s.handleAdminGameVideoFinish))
	// 商店布局配置（字面量段 /config 与 /{id} 交叉时字面量优先，无两可冲突）
	http.HandleFunc("GET /admin/api/game/config", s.adminGuard(s.handleAdminGameConfigGet))
	http.HandleFunc("PUT /admin/api/game/config", s.adminGuard(s.handleAdminGameConfigPut))
	// 自定义推荐区块（同上字面量优先先例）
	http.HandleFunc("GET /admin/api/game/sections", s.adminGuard(s.handleAdminGameSectionsGet))
	http.HandleFunc("PUT /admin/api/game/sections", s.adminGuard(s.handleAdminGameSectionsPut))
}

// handleAdminGameCreate 上架游戏（元数据先行，版本与文件随后登记）
func (s *Server) handleAdminGameCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	// TorrentPath 在 model.Game 上标记 json:"-"（服务端私有不下发），故请求体单独收 torrent_path；
	// SavePaths/SaveExclude 为 JSON 数组串，模型上以具名字段显式接收（与外层同名字段避免歧义）
	var req struct {
		model.Game
		TorrentPath string `json:"torrent_path"`
		SavePaths   string `json:"save_paths"`
		SaveExclude string `json:"save_exclude"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	g := req.Game
	g.SavePaths = gameSavePathsClean(req.SavePaths)
	g.SaveExclude = gameSavePathsClean(req.SaveExclude)
	g.Slug = strings.ToLower(strings.TrimSpace(g.Slug))
	g.Name = strings.TrimSpace(g.Name)
	if !gameSlugRe.MatchString(g.Slug) {
		adminFail(w, http.StatusBadRequest, "slug 仅允许小写字母/数字/下划线/中划线（1-64 位）")
		return
	}
	if g.Name == "" {
		adminFail(w, http.StatusBadRequest, "游戏名称不能为空")
		return
	}
	if g.Price < 0 {
		g.Price = 0
	}
	if g.DownloadMethod != 0 && g.DownloadMethod != 1 && g.DownloadMethod != 2 {
		g.DownloadMethod = 0 // 下载方式白名单：0=HTTP（默认）1=BT（服务端生成种子）2=BT（上传种子）
	}
	tp, terr := s.gameTorrentPathClean(req.TorrentPath)
	if terr != nil {
		adminFail(w, http.StatusBadRequest, terr.Error())
		return
	}
	if g.DownloadMethod == 2 && tp == "" {
		adminFail(w, http.StatusBadRequest, "下载方式为「上传种子」时必须先上传 .torrent 文件")
		return
	}
	g.TorrentPath = tp
	// 启动程序相对路径：非空时必须通过路径安全清洗（禁 .. / 绝对路径 / 盘符，防目录穿越）
	if rawExe := strings.TrimSpace(g.LaunchExe); rawExe != "" {
		g.LaunchExe = gameRelPathClean(rawExe)
		if g.LaunchExe == "" {
			adminFail(w, http.StatusBadRequest, "启动程序路径非法（须为安装目录内的相对路径，如 bin/game.exe）")
			return
		}
	}
	g.LaunchName = gameLaunchNameClean(g.LaunchName)
	g.LaunchArgs = gameLaunchArgsClean(g.LaunchArgs)
	vids, verr := gameVideosClean(g.Videos)
	if verr != nil {
		adminFail(w, http.StatusBadRequest, verr.Error())
		return
	}
	g.Videos = vids
	if g.Status != 0 && g.Status != 1 {
		g.Status = 0
	}
	g.ID = 0
	if err := store.DB.Create(&g).Error; err != nil {
		adminFail(w, http.StatusConflict, "slug 已存在或保存失败")
		return
	}
	logger.Info("游戏上架: %s (%s), 操作人=%s", g.Name, g.Slug, adminUserFromCtx(r))
	adminJSON(w, gameSummary(g))
}

// handleAdminGameList 游戏列表（含下架，管理视角）
func (s *Server) handleAdminGameList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.Game{})
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		db = db.Where("name LIKE ? OR slug LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var games []model.Game
	db.Order("sort ASC, id DESC").Offset((page - 1) * size).Limit(size).Find(&games)
	list := make([]map[string]interface{}, 0, len(games))
	for _, g := range games {
		item := gameSummary(g)
		item["status"] = g.Status
		item["create_time"] = g.CreateTime.Format("2006-01-02 15:04")
		list = append(list, item)
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// handleAdminGameDetail 游戏详情（管理视角：全字段 + 版本列表）
func (s *Server) handleAdminGameDetail(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var versions []model.GameVersion
	store.DB.Where("game_id = ?", g.ID).Order("id DESC").Find(&versions)
	verList := make([]map[string]interface{}, 0, len(versions))
	for _, v := range versions {
		verList = append(verList, map[string]interface{}{
			"id": v.ID, "version": v.Version, "size_bytes": v.SizeBytes, "file_count": v.FileCount,
			"changelog": v.Changelog, "min_req": v.MinReq, "manifest_hash": v.ManifestHash,
			"create_time": v.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	item := gameSummary(g)
	item["status"] = g.Status
	item["description"] = g.Description
	item["versions"] = verList
	// 上传种子文件名（管理端表单回填/上架切换全量回写保真；服务端私有字段 json:"-" 不随 model 下发）
	item["torrent_path"] = g.TorrentPath
	adminJSON(w, item)
}

// handleAdminGameUpdate 编辑游戏元数据（slug 不可改——安装目录与文件落位锚点）
func (s *Server) handleAdminGameUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var req struct {
		model.Game
		TorrentPath string `json:"torrent_path"`
		SavePaths   string `json:"save_paths"`
		SaveExclude string `json:"save_exclude"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	u := req.Game
	u.SavePaths = gameSavePathsClean(req.SavePaths)
	u.SaveExclude = gameSavePathsClean(req.SaveExclude)
	u.Slug = strings.ToLower(strings.TrimSpace(u.Slug))
	if u.Slug != "" && u.Slug != g.Slug {
		adminFail(w, http.StatusBadRequest, "slug 不可修改（已作为安装目录锚点）")
		return
	}
	u.Name = strings.TrimSpace(u.Name)
	if u.Name == "" {
		adminFail(w, http.StatusBadRequest, "游戏名称不能为空")
		return
	}
	if u.Price < 0 {
		u.Price = 0
	}
	if u.DownloadMethod != 0 && u.DownloadMethod != 1 && u.DownloadMethod != 2 {
		u.DownloadMethod = 0
	}
	// 上传种子归口：请求带 torrent_path=新上传文件名；不带则保留库内既有值
	// （上架/下架切换等全量回写场景不丢种子）；下载方式=2 时必须最终有值
	tp, terr := s.gameTorrentPathClean(req.TorrentPath)
	if terr != nil {
		adminFail(w, http.StatusBadRequest, terr.Error())
		return
	}
	if tp == "" {
		tp = g.TorrentPath
	}
	if u.DownloadMethod == 2 && strings.TrimSpace(tp) == "" {
		adminFail(w, http.StatusBadRequest, "下载方式为「上传种子」时必须先上传 .torrent 文件")
		return
	}
	// 启动程序相对路径清洗（同创建：非空必须为安装目录内的安全相对路径）
	if rawExe := strings.TrimSpace(u.LaunchExe); rawExe != "" {
		u.LaunchExe = gameRelPathClean(rawExe)
		if u.LaunchExe == "" {
			adminFail(w, http.StatusBadRequest, "启动程序路径非法（须为安装目录内的相对路径，如 bin/game.exe）")
			return
		}
	}
	u.LaunchName = gameLaunchNameClean(u.LaunchName)
	u.LaunchArgs = gameLaunchArgsClean(u.LaunchArgs)
	vids, verr := gameVideosClean(u.Videos)
	if verr != nil {
		adminFail(w, http.StatusBadRequest, verr.Error())
		return
	}
	if u.Status != 0 && u.Status != 1 {
		u.Status = g.Status
	}
	updates := map[string]interface{}{
		"name": u.Name, "short_desc": u.ShortDesc, "description": u.Description,
		"cover": u.Cover, "banner": u.Banner, "screenshots": u.Screenshots, "tags": u.Tags, "videos": vids,
		"developer": u.Developer, "publisher": u.Publisher,
		"price": u.Price, "download_method": u.DownloadMethod, "status": u.Status, "sort": u.Sort,
		"launch_exe": u.LaunchExe, "launch_name": u.LaunchName, "launch_args": u.LaunchArgs,
		"save_paths": u.SavePaths, "save_exclude": u.SaveExclude,
		"online_ports_tcp": gamePortsClean(u.OnlinePortsTCP), "online_ports_udp": gamePortsClean(u.OnlinePortsUDP),
		"torrent_path": tp,
	}
	if err := store.DB.Model(&g).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	store.DB.First(&g, id)
	adminJSON(w, gameSummary(g))
}

// gamePortsClean 联机端口登记串清洗：逗号/空格分隔 → 去重 + 1024~65535 范围校验 + 升序还原逗号串。
// 非法片段丢弃（不做整串失败，管理端录入容错）；空串/全非法返回空串
func gamePortsClean(s string) string {
	seen := map[int]bool{}
	var out []string
	for _, seg := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '；' || r == '，' }) {
		p, err := strconv.Atoi(strings.TrimSpace(seg))
		if err != nil || p < 1024 || p > 65535 || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, strconv.Itoa(p))
	}
	return strings.Join(out, ",")
}

// handleAdminGameDelete 下架删除：级联清版本/文件清单行与磁盘目录（不可恢复，管理端二次确认归口前端）
func (s *Server) handleAdminGameDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var verIDs []uint
	store.DB.Model(&model.GameVersion{}).Where("game_id = ?", g.ID).Pluck("id", &verIDs)
	// 独立删除（清单表按版本 ID 归口；行数远小于文件数，无事务必要——磁盘目录清理为准）
	store.DB.Where("version_id IN ?", verIDs).Delete(&model.GameFile{})
	store.DB.Where("game_id = ?", g.ID).Delete(&model.GameVersion{})
	store.DB.Where("game_id = ?", g.ID).Delete(&model.GameLibrary{})
	store.DB.Where("game_id = ?", g.ID).Delete(&model.GameNotice{})
	// P2：连带清理评测与"有帮助"标记（防孤儿评测；先取本游戏评测 ID 删 like，再删评测行）
	var revIDs []uint
	store.DB.Model(&model.GameReview{}).Where("game_id = ?", g.ID).Pluck("id", &revIDs)
	if len(revIDs) > 0 {
		store.DB.Where("review_id IN ?", revIDs).Delete(&model.GameReviewLike{})
	}
	store.DB.Where("game_id = ?", g.ID).Delete(&model.GameReview{})
	// 云存档级联清理：删游戏后存档不可再访问，清行 + 清 game_saves/ 对象（防孤儿数据累积）
	if n := s.gameSaveCascadePurge(g.ID, ""); n > 0 {
		logger.Info("删除游戏级联清理云存档: %s (%s), 存档组=%d", g.Name, g.Slug, n)
	}
	if err := store.DB.Delete(&g).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除失败")
		return
	}
	// 磁盘目录整删（版本子目录随根目录一并清理）
	os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", g.Slug))
	// 上传种子一并清理（LocalDir/torrents/uploaded/<文件名>；文件名经 Base 归一防穿越）
	if fp := s.gameUploadedTorrentFile(&g); fp != "" {
		os.Remove(fp)
	}
	// 服务端生成种子缓存一并清理（LocalDir/torrents/<slug>-*.torrent；glob 归口防 slug 复用误命中，
	// slug 字符集限定 [a-z0-9_-] 无 glob 元字符，安全）
	if matches, err := filepath.Glob(filepath.Join(s.cfg.Game.LocalDir, "torrents", g.Slug+"-*.torrent")); err == nil {
		for _, m := range matches {
			os.Remove(m)
		}
	}
	logger.Info("游戏删除: %s (%s), 操作人=%s", g.Name, g.Slug, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameChunk 分片上传（raw body）：POST /admin/api/game/upload/chunk?upload_id=&seq=&total=&size=
// seq 从 0 开始；响应 {received, total}；单片 ≤ ChunkSize+1KB（MaxBytesReader 硬截断）
func (s *Server) handleAdminGameChunk(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	uploadID := strings.TrimSpace(q.Get("upload_id"))
	seq, _ := strconv.Atoi(q.Get("seq"))
	total, _ := strconv.Atoi(q.Get("total"))
	fileSize, _ := strconv.ParseInt(q.Get("size"), 10, 64)
	if uploadID == "" || len(uploadID) > 64 || strings.ContainsAny(uploadID, "/\\") {
		adminFail(w, http.StatusBadRequest, "upload_id 非法")
		return
	}
	if total <= 0 || seq < 0 || seq >= total {
		adminFail(w, http.StatusBadRequest, "分片参数非法")
		return
	}
	if fileSize <= 0 || fileSize > s.cfg.Game.MaxFileSize {
		adminFail(w, http.StatusBadRequest, "文件超出大小上限")
		return
	}
	maxChunk := s.cfg.Game.ChunkSize
	if maxChunk <= 0 {
		maxChunk = 8 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxChunk+1024)

	s.sweepExpiredGameUploads() // 惰性清理过期会话（内部自持锁，先于下方会话登记）
	gameUploadSessions.Lock()
	sess, ok := gameUploadSessions.m[uploadID]
	if !ok {
		sess = &gameUploadSession{UploadID: uploadID, Kind: "game", Total: total, FileSize: fileSize,
			Received: make(map[int]int64), CreatedAt: time.Now()}
		gameUploadSessions.m[uploadID] = sess
		gameUploadSessions.Unlock()
		// 会话登记后建临时目录（首片）
		if err := os.MkdirAll(s.gameTmpDir(uploadID), os.ModePerm); err != nil {
			adminFail(w, http.StatusInternalServerError, "临时目录创建失败")
			return
		}
	} else {
		gameUploadSessions.Unlock()
	}
	if sess.Kind != "game" || sess.Total != total || sess.FileSize != fileSize {
		adminFail(w, http.StatusBadRequest, "分片参数与会话不一致")
		return
	}
	s.gameChunkReceive(uploadID, seq, total, sess, w, r)
}

// gameChunkReceive 分片落盘公共逻辑（游戏包/宣传视频两通道共用）：写 <seq>.part 并登记会话进度
func (s *Server) gameChunkReceive(uploadID string, seq, total int, sess *gameUploadSession, w http.ResponseWriter, r *http.Request) {
	partPath := filepath.Join(s.gameTmpDir(uploadID), fmt.Sprintf("%d.part", seq))
	part, err := os.Create(partPath)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "分片写入失败")
		return
	}
	n, err := io.Copy(part, r.Body)
	part.Close()
	if err != nil {
		os.Remove(partPath)
		adminFail(w, http.StatusInternalServerError, "分片写入失败")
		return
	}
	sess.Received[seq] = n
	adminJSON(w, map[string]interface{}{"received": len(sess.Received), "total": total})
}

// handleAdminGameChunkCancel 取消分片上传（清会话与临时目录）
func (s *Server) handleAdminGameChunkCancel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UploadID string `json:"upload_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UploadID == "" {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	gameUploadSessions.Lock()
	delete(gameUploadSessions.m, req.UploadID)
	gameUploadSessions.Unlock()
	os.RemoveAll(s.gameTmpDir(req.UploadID))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// gameTorrentPathClean 清洗上传种子文件名（下载方式=2）：仅接受纯文件名（Base 归一防目录穿越）、
// .torrent 扩展名、且必须存在于 LocalDir/torrents/uploaded/；空串=未上传（非 2 方式可空）
func (s *Server) gameTorrentPathClean(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", nil
	}
	if p != filepath.Base(p) || strings.ContainsAny(p, "/\\") || utf8.RuneCountInString(p) > 255 {
		return "", errGame("种子文件名非法")
	}
	if strings.ToLower(filepath.Ext(p)) != ".torrent" {
		return "", errGame("仅接受 .torrent 种子文件")
	}
	fp := filepath.Join(s.gameUploadedTorrentDir(), p)
	if st, err := os.Stat(fp); err != nil || !st.Mode().IsRegular() {
		return "", errGame("种子文件不存在，请重新上传")
	}
	return p, nil
}

// gameTorrentUploadMax 上传种子大小上限（字节，默认 8MB）：种子的 piece 哈希占绝对主体
// （4MiB 分片下 50GB 游戏约 256KB），8MB 对超大游戏与超长文件清单均有充足余量
func (s *Server) gameTorrentUploadMax() int64 { return 8 << 20 }

// handleAdminGameTorrentUpload 上传自制 .torrent（下载方式=2 专用）：
// multipart 字段 file，轻校验（.torrent 扩展名 + 体积上限 + bencode 首字节 'd'）后落
// LocalDir/torrents/uploaded/<slug 前缀随机名>.torrent，返回 {path, name, size_bytes, file_count}
// （name/size/file_count 为种子内 info.name 与文件统计，供管理端回显确认，也用于 method=2 的安装锚点）
func (s *Server) handleAdminGameTorrentUpload(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	maxSize := s.gameTorrentUploadMax()
	r.Body = http.MaxBytesReader(w, r.Body, maxSize+1<<20) // multipart 边界余量
	if err := r.ParseMultipartForm(maxSize); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误或种子超出大小上限")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "缺少文件")
		return
	}
	defer file.Close()
	if strings.ToLower(filepath.Ext(header.Filename)) != ".torrent" {
		adminFail(w, http.StatusBadRequest, "仅接受 .torrent 种子文件")
		return
	}
	if header.Size > maxSize {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("种子文件超出 %dMB 上限", maxSize>>20))
		return
	}
	data, err := io.ReadAll(file)
	if err != nil || len(data) == 0 {
		adminFail(w, http.StatusBadRequest, "种子读取失败")
		return
	}
	// 轻校验：bencode 顶层必为字典（首字节 'd'），否则多为错误页/文本被当种子喂引擎
	if data[0] != 'd' {
		adminFail(w, http.StatusBadRequest, "种子内容非法（非 bencode 字典格式）")
		return
	}
	name, total, count := torrentInfoScan(data)
	if name == "" {
		adminFail(w, http.StatusBadRequest, "种子信息解析失败（缺少 info.name，可能非标准 .torrent）")
		return
	}
	dir := s.gameUploadedTorrentDir()
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		adminFail(w, http.StatusInternalServerError, "目录创建失败")
		return
	}
	b := make([]byte, 6)
	rand.Read(b)
	fname := fmt.Sprintf("t%d_%s.torrent", time.Now().UnixNano(), hex.EncodeToString(b))
	if err := os.WriteFile(filepath.Join(dir, fname), data, 0644); err != nil {
		adminFail(w, http.StatusInternalServerError, "种子写入失败")
		return
	}
	logger.Info("上传游戏种子: %s（info.name=%s, %d 文件, %d 字节）, 操作人=%s",
		fname, name, count, total, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{
		"path": fname, "name": name, "size_bytes": total, "file_count": count,
	})
}

// handleAdminGameImage 封面/截图上传（multipart 小图 ≤20MB）：落 WebDir/static/upload/games/，
// 返回 {url}（静态服务天然托管，客户端预览与商店展示同 URL）
func (s *Server) handleAdminGameImage(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "缺少文件")
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !gameImageExts[ext] {
		adminFail(w, http.StatusBadRequest, "仅支持 png/jpg/jpeg/gif/webp")
		return
	}
	if header.Size > 20<<20 {
		adminFail(w, http.StatusBadRequest, "图片超出 20MB 上限")
		return
	}
	dir := filepath.Join(s.cfg.WebDir, "static", "upload", "games")
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		adminFail(w, http.StatusInternalServerError, "目录创建失败")
		return
	}
	b := make([]byte, 6)
	rand.Read(b)
	name := fmt.Sprintf("g%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dst, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(filepath.Join(dir, name))
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	adminJSON(w, map[string]interface{}{"url": "/static/upload/games/" + name})
}

// gameVideoExts 宣传视频扩展名白名单（详情页 <video> 原生可播格式优先）
var gameVideoExts = map[string]bool{".mp4": true, ".webm": true, ".mkv": true}

// gameVideoMaxSize 宣传视频大小上限归口（config 未配置时默认 200MB）
func (s *Server) gameVideoMaxSize() int64 {
	if s.cfg.Game.VideoMaxSize > 0 {
		return s.cfg.Game.VideoMaxSize
	}
	return 200 << 20
}

// handleAdminGameVideoChunk 宣传视频分片上传（raw body）：POST /admin/api/game/upload/video
//
//	?upload_id=&seq=&total=&size=&name=xxx.mp4
//
// 与游戏包分片共用会话表与临时目录（Kind 区分互不串道），首片登记时校验扩展名白名单与大小上限
func (s *Server) handleAdminGameVideoChunk(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	uploadID := strings.TrimSpace(q.Get("upload_id"))
	seq, _ := strconv.Atoi(q.Get("seq"))
	total, _ := strconv.Atoi(q.Get("total"))
	fileSize, _ := strconv.ParseInt(q.Get("size"), 10, 64)
	name := strings.TrimSpace(q.Get("name"))
	if uploadID == "" || len(uploadID) > 64 || strings.ContainsAny(uploadID, "/\\") {
		adminFail(w, http.StatusBadRequest, "upload_id 非法")
		return
	}
	if total <= 0 || seq < 0 || seq >= total {
		adminFail(w, http.StatusBadRequest, "分片参数非法")
		return
	}
	maxVideo := s.gameVideoMaxSize()
	if fileSize <= 0 || fileSize > maxVideo {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("视频超出大小上限（%dMB）", maxVideo>>20))
		return
	}
	ext := strings.ToLower(filepath.Ext(name))
	if !gameVideoExts[ext] {
		adminFail(w, http.StatusBadRequest, "仅支持 mp4/webm/mkv 视频")
		return
	}
	maxChunk := s.cfg.Game.ChunkSize
	if maxChunk <= 0 {
		maxChunk = 8 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxChunk+1024)

	s.sweepExpiredGameUploads() // 惰性清理过期会话（内部自持锁，先于下方会话登记）
	gameUploadSessions.Lock()
	sess, ok := gameUploadSessions.m[uploadID]
	if !ok {
		sess = &gameUploadSession{UploadID: uploadID, Kind: "video", Ext: ext, Total: total,
			FileSize: fileSize, Received: make(map[int]int64), CreatedAt: time.Now()}
		gameUploadSessions.m[uploadID] = sess
		gameUploadSessions.Unlock()
		// 会话登记后建临时目录（首片）
		if err := os.MkdirAll(s.gameTmpDir(uploadID), os.ModePerm); err != nil {
			adminFail(w, http.StatusInternalServerError, "临时目录创建失败")
			return
		}
	} else {
		gameUploadSessions.Unlock()
	}
	if sess.Kind != "video" || sess.Total != total || sess.FileSize != fileSize {
		adminFail(w, http.StatusBadRequest, "分片参数与会话不一致")
		return
	}
	s.gameChunkReceive(uploadID, seq, total, sess, w, r)
}

// handleAdminGameVideoFinish 宣传视频合并落位：POST /admin/api/game/upload/video/finish?upload_id=
// 校验分片齐全后顺序合并至 WebDir/static/upload/games/videos/（静态服务天然托管），返回 {url}
func (s *Server) handleAdminGameVideoFinish(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	uploadID := strings.TrimSpace(r.URL.Query().Get("upload_id"))
	if uploadID == "" || len(uploadID) > 64 || strings.ContainsAny(uploadID, "/\\") {
		adminFail(w, http.StatusBadRequest, "upload_id 非法")
		return
	}
	gameUploadSessions.Lock()
	sess, ok := gameUploadSessions.m[uploadID]
	gameUploadSessions.Unlock()
	if !ok || sess.Kind != "video" {
		adminFail(w, http.StatusGone, "上传会话不存在或已过期")
		return
	}
	if len(sess.Received) != sess.Total {
		adminFail(w, http.StatusBadRequest, "分片未上传完整")
		return
	}
	tmpDir := s.gameTmpDir(uploadID)
	dir := filepath.Join(s.cfg.WebDir, "static", "upload", "games", "videos")
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		adminFail(w, http.StatusInternalServerError, "目录创建失败")
		return
	}
	b := make([]byte, 6)
	rand.Read(b)
	name := fmt.Sprintf("v%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), sess.Ext)
	dst := filepath.Join(dir, name)
	out, err := os.Create(dst)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	var size int64
	failed := false
	for i := 0; i < sess.Total; i++ {
		part, err := os.Open(filepath.Join(tmpDir, fmt.Sprintf("%d.part", i)))
		if err != nil {
			failed = true
			break
		}
		n, err := io.Copy(out, part)
		part.Close()
		if err != nil {
			failed = true
			break
		}
		size += n
	}
	out.Close()
	if failed || size != sess.FileSize { // 任一分片缺失/读写失败统一按失败落盘清理
		os.Remove(dst)
		adminFail(w, http.StatusBadRequest, "分片合并失败或大小不符")
		return
	}
	gameUploadSessions.Lock()
	delete(gameUploadSessions.m, uploadID)
	gameUploadSessions.Unlock()
	os.RemoveAll(tmpDir)
	logger.Info("游戏宣传视频上传: %s (%d 字节), 操作人=%s", name, size, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"url": "/static/upload/games/videos/" + name})
}

// gameVideosClean 清洗视频清单（归口）：JSON 字符串数组，每项须为站内 /static/upload/games/videos/
// 前缀相对 URL，最多 8 个；非法项直接拒绝（防外链/路径注入，管理端把好第一道关）
func gameVideosClean(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "[]", nil
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return "", fmt.Errorf("videos 须为字符串数组")
	}
	if len(list) > 8 {
		return "", fmt.Errorf("视频最多 8 个")
	}
	out := make([]string, 0, len(list))
	for _, u := range list {
		u = strings.TrimSpace(u)
		if u == "" || strings.Contains(u, "\\") || strings.Contains(u, "..") ||
			!strings.HasPrefix(u, "/static/upload/games/videos/") {
			return "", fmt.Errorf("非法视频地址: %s", u)
		}
		out = append(out, u)
	}
	b, _ := json.Marshal(out)
	return string(b), nil
}

// gameUploadItem 版本登记的待合并文件项（清单预处理产物，跨函数传递归口）
type gameUploadItem struct {
	relPath  string
	size     int64
	sha      string
	uploadID string
}

// handleAdminGameVersionCreate 版本上架登记：把已分片上传的文件流式合并落位
// POST /admin/api/game/{id}/version
// 入参 {version, changelog, min_req, files:[{rel_path,size,sha256,upload_id}]}
// 流程：清洗校验 → 逐文件合并分片至 games/<slug>/<version>/<rel_path>（MultiWriter 单遍复算
// SHA256 与总大小，不信任客户端声明）→ 全部通过后登记版本与清单行 → 刷新游戏最新版冗余 → 清理临时分片
func (s *Server) handleAdminGameVersionCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var req struct {
		Version   string `json:"version"`
		Changelog string `json:"changelog"`
		MinReq    string `json:"min_req"`
		Files     []struct {
			RelPath  string `json:"rel_path"`
			Size     int64  `json:"size"`
			SHA256   string `json:"sha256"`
			UploadID string `json:"upload_id"`
		} `json:"files"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	version := gameVersionClean(req.Version)
	if version == "" {
		adminFail(w, http.StatusBadRequest, "版本号非法（1-32 字符，禁路径分隔符）")
		return
	}
	var exist model.GameVersion
	if err := store.DB.Where("game_id = ? AND version = ?", g.ID, version).First(&exist).Error; err == nil {
		adminFail(w, http.StatusConflict, "该版本已存在")
		return
	}
	if len(req.Files) == 0 || len(req.Files) > 5000 {
		adminFail(w, http.StatusBadRequest, "文件清单为空或超出 5000 项上限")
		return
	}
	// 清单预处理：路径清洗 + 归并分片会话（同文件重复项拒绝）
	items := make([]gameUploadItem, 0, len(req.Files))
	seenPath := map[string]bool{}
	for _, f := range req.Files {
		rp := gameRelPathClean(f.RelPath)
		if rp == "" {
			adminFail(w, http.StatusBadRequest, "非法文件路径: "+f.RelPath)
			return
		}
		if seenPath[rp] {
			adminFail(w, http.StatusBadRequest, "文件路径重复: "+rp)
			return
		}
		seenPath[rp] = true
		if f.Size <= 0 || f.Size > s.cfg.Game.MaxFileSize {
			adminFail(w, http.StatusBadRequest, "文件大小非法: "+rp)
			return
		}
		sha := strings.ToLower(strings.TrimSpace(f.SHA256))
		if len(sha) != 64 {
			adminFail(w, http.StatusBadRequest, "SHA256 格式非法: "+rp)
			return
		}
		gameUploadSessions.Lock()
		_, ok := gameUploadSessions.m[f.UploadID]
		gameUploadSessions.Unlock()
		if !ok {
			adminFail(w, http.StatusGone, "分片会话不存在或已过期: "+rp+"（请重新上传该文件）")
			return
		}
		items = append(items, gameUploadItem{relPath: rp, size: f.Size, sha: sha, uploadID: f.UploadID})
	}

	// 合并落位：目标根目录 games/<slug>/<version>/，逐文件校验（失败即整版回滚删目录）
	verRoot := filepath.Join(s.cfg.Game.LocalDir, "games", g.Slug, version)
	var totalSize int64
	hashLines := make([]string, 0, len(items))
	for _, it := range items {
		dst := filepath.Join(verRoot, filepath.FromSlash(it.relPath))
		abs, err := filepath.Abs(dst)
		if err != nil || !strings.HasPrefix(filepath.Clean(abs), filepath.Clean(verRoot)+string(os.PathSeparator)) {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "非法文件路径: "+it.relPath)
			return
		}
		if err := os.MkdirAll(filepath.Dir(dst), os.ModePerm); err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusInternalServerError, "目录创建失败")
			return
		}
		if err := s.gameMergeChunks(s.gameTmpDir(it.uploadID), dst, it.size, it.sha); err != nil {
			os.Remove(dst)
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "文件校验失败: "+it.relPath+"（"+err.Error()+"）")
			return
		}
		totalSize += it.size
		hashLines = append(hashLines, it.relPath+":"+strconv.FormatInt(it.size, 10)+":"+it.sha)
	}
	sort.Strings(hashLines)
	mh := sha256.Sum256([]byte(strings.Join(hashLines, "\n")))
	manifestHash := hex.EncodeToString(mh[:])

	// 登记版本与清单（文件行已在合并循环中登记——此处仅版本行与冗余刷新）
	v := model.GameVersion{GameID: g.ID, Version: version, ManifestHash: manifestHash,
		SizeBytes: totalSize, FileCount: len(items), Changelog: req.Changelog, MinReq: req.MinReq}
	if err := store.DB.Create(&v).Error; err != nil {
		s.gameVersionRollback(verRoot, items, false)
		adminFail(w, http.StatusInternalServerError, "版本登记失败")
		return
	}
	fileRows := make([]model.GameFile, 0, len(items))
	for _, it := range items {
		storageRel := "games/" + g.Slug + "/" + version + "/" + it.relPath
		fileRows = append(fileRows, model.GameFile{VersionID: v.ID, RelPath: it.relPath,
			SizeBytes: it.size, SHA256: it.sha, StoragePath: storageRel})
	}
	if err := store.DB.CreateInBatches(&fileRows, 500).Error; err != nil {
		store.DB.Delete(&v)
		s.gameVersionRollback(verRoot, items, false)
		adminFail(w, http.StatusInternalServerError, "文件清单登记失败")
		return
	}
	// 最新版冗余刷新（版本号取字符串最大者：语义上"上架的最新版"以本次登记为准）
	store.DB.Model(&g).Updates(map[string]interface{}{"latest_version": version, "size_bytes": totalSize})
	// 清理全部临时分片目录与会话
	for _, it := range items {
		gameUploadSessions.Lock()
		delete(gameUploadSessions.m, it.uploadID)
		gameUploadSessions.Unlock()
		os.RemoveAll(s.gameTmpDir(it.uploadID))
	}
	logger.Info("游戏版本上架: %s (%s) v%s, 文件 %d 个, 共 %d 字节, 操作人=%s",
		g.Name, g.Slug, version, len(items), totalSize, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"version_id": v.ID, "version": version,
		"file_count": len(items), "size_bytes": totalSize, "manifest_hash": manifestHash})
}

// gameMergeChunks 流式合并分片并复算 SHA256（MultiWriter 单遍完成写盘+校验）
func (s *Server) gameMergeChunks(tmpDir, dst string, wantSize int64, wantSHA string) error {
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return fmt.Errorf("分片缺失")
	}
	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("目标文件创建失败")
	}
	defer out.Close()
	h := sha256.New()
	var size int64
	for i := 0; i < len(entries); i++ {
		part, err := os.Open(filepath.Join(tmpDir, fmt.Sprintf("%d.part", i)))
		if err != nil {
			return fmt.Errorf("分片缺失")
		}
		n, err := io.Copy(io.MultiWriter(out, h), part)
		part.Close()
		if err != nil {
			return fmt.Errorf("分片写入失败")
		}
		size += n
	}
	if size != wantSize {
		return fmt.Errorf("大小不符（期望 %d 实际 %d）", wantSize, size)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return fmt.Errorf("SHA256 不符")
	}
	return nil
}

// gameVersionRollback 版本上架中途失败回滚：删已写文件/整版本目录；clearTmp=false 时保留
// 临时分片（登记型失败可重试），true 时一并清理
func (s *Server) gameVersionRollback(verRoot string, items []gameUploadItem, clearTmp bool) {
	os.RemoveAll(verRoot)
	if clearTmp {
		for _, it := range items {
			os.RemoveAll(s.gameTmpDir(it.uploadID))
			gameUploadSessions.Lock()
			delete(gameUploadSessions.m, it.uploadID)
			gameUploadSessions.Unlock()
		}
	}
}

// handleAdminGameVersionDelete 删除版本：清清单行与版本行、删版本磁盘目录；
// 被删版本为最新版时回退到剩余版本（无剩余则清空冗余）
func (s *Server) handleAdminGameVersionDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	vid, _ := strconv.ParseUint(r.PathValue("vid"), 10, 64)
	var v model.GameVersion
	if err := store.DB.First(&v, vid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本不存在")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, v.GameID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	store.DB.Where("version_id = ?", v.ID).Delete(&model.GameFile{})
	store.DB.Delete(&v)
	os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", g.Slug, v.Version))
	// 最新版冗余回退
	var rest model.GameVersion
	if err := store.DB.Where("game_id = ?", g.ID).Order("id DESC").First(&rest).Error; err == nil {
		var total int64
		store.DB.Model(&model.GameFile{}).Select("COALESCE(SUM(size_bytes),0)").Where("version_id = ?", rest.ID).Scan(&total)
		store.DB.Model(&g).Updates(map[string]interface{}{"latest_version": rest.Version, "size_bytes": total})
	} else {
		store.DB.Model(&g).Updates(map[string]interface{}{"latest_version": "", "size_bytes": 0})
	}
	logger.Info("游戏版本删除: %s v%s, 操作人=%s", g.Name, v.Version, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameNoticesGet 公告列表（公告管理页表格 + 游戏管理发布卡计数，倒序+分页）
func (s *Server) handleAdminGameNoticesGet(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	gid, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	// gid=0 表示全部游戏（公告管理页跨游戏总览）；>0 时按游戏过滤
	// 分页归口：公告量可能持续增长（不定期发布），列表接口强制分页防全量拉取；
	// keyword 模糊搜索（公告管理页按标题/内容过滤），参数化 LIKE 防注入
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	kw := strings.TrimSpace(r.URL.Query().Get("keyword"))
	cond := func() *gorm.DB {
		c := store.DB
		if gid > 0 {
			c = c.Where("game_id = ?", gid)
		}
		if kw != "" {
			c = c.Where("(title LIKE ? OR content LIKE ?)", "%"+kw+"%", "%"+kw+"%")
		}
		return c
	}
	var total int64
	cond().Model(&model.GameNotice{}).Count(&total)
	var list []model.GameNotice
	cond().Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&list)
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// gameNoticeImagesClean 公告图片列表清洗：JSON 数组串，≤9 张、单条 ≤512 字，
// 允许 http(s) 绝对链或站内相对路径（GIF 动图同通道）；返回规范化 JSON 串，非法返回错误
func gameNoticeImagesClean(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return "", fmt.Errorf("images 需为字符串数组")
	}
	if len(arr) > 9 {
		return "", fmt.Errorf("公告图片最多 9 张")
	}
	cleaned := make([]string, 0, len(arr))
	for _, u := range arr {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		if utf8.RuneCountInString(u) > 512 {
			return "", fmt.Errorf("公告图片地址过长")
		}
		low := strings.ToLower(u)
		if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") && !strings.HasPrefix(u, "/") {
			return "", fmt.Errorf("公告图片地址需为 http(s) 或站内相对路径")
		}
		cleaned = append(cleaned, u)
	}
	if len(cleaned) == 0 {
		return "", nil
	}
	b, _ := json.Marshal(cleaned)
	return string(b), nil
}

// gameNoticeLayoutClean 公告布局白名单归口（thumb=横向缩略图/grid=图片网格/banner=通栏大图；
// 空/未知值一律回退 thumb，与旧数据行为一致）
func gameNoticeLayoutClean(v string) string {
	switch strings.TrimSpace(v) {
	case "grid":
		return "grid"
	case "banner":
		return "banner"
	default:
		return "thumb"
	}
}

// handleAdminGameNoticeCreate 发布游戏公告（标题/正文可空支持"纯图片公告"，但三者至少一项非空；
// 图片支持 GIF 动图，最多 9 张，首图兼作动态卡头图；layout 卡片布局白名单校验）
func (s *Server) handleAdminGameNoticeCreate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var req struct {
		GameID  uint   `json:"game_id"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Images  string `json:"images"`
		Cover   string `json:"cover"`
		Layout  string `json:"layout"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Content = strings.TrimSpace(req.Content)
	req.Cover = strings.TrimSpace(req.Cover)
	if req.GameID == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if utf8.RuneCountInString(req.Title) > 64 {
		adminFail(w, http.StatusBadRequest, "公告标题不能超过 64 字")
		return
	}
	if utf8.RuneCountInString(req.Content) > 2000 {
		adminFail(w, http.StatusBadRequest, "公告内容不能超过 2000 字")
		return
	}
	if utf8.RuneCountInString(req.Cover) > 512 {
		adminFail(w, http.StatusBadRequest, "公告头图地址过长")
		return
	}
	imgs, ierr := gameNoticeImagesClean(req.Images)
	if ierr != nil {
		adminFail(w, http.StatusBadRequest, ierr.Error())
		return
	}
	if req.Title == "" && req.Content == "" && imgs == "" {
		adminFail(w, http.StatusBadRequest, "标题、内容、图片至少填写一项")
		return
	}
	var cnt int64
	store.DB.Model(&model.Game{}).Where("id = ?", req.GameID).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	n := model.GameNotice{GameID: req.GameID, Title: req.Title, Content: req.Content, Images: imgs, Cover: req.Cover, Layout: gameNoticeLayoutClean(req.Layout)}
	if err := store.DB.Create(&n).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "发布失败")
		return
	}
	logger.Info("游戏公告发布: game=%d title=%s, 操作人=%s", req.GameID, req.Title, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true, "id": n.ID})
}

// handleAdminGameNoticeUpdate 编辑公告（公告管理页行内"编辑"：游戏归属/标题/内容/图片均可改，校验同发布）
func (s *Server) handleAdminGameNoticeUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var req struct {
		GameID  uint   `json:"game_id"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Images  string `json:"images"`
		Layout  string `json:"layout"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Content = strings.TrimSpace(req.Content)
	if req.GameID == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
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
	if req.Title == "" && req.Content == "" && imgs == "" {
		adminFail(w, http.StatusBadRequest, "标题、内容、图片至少填写一项")
		return
	}
	var cnt int64
	store.DB.Model(&model.Game{}).Where("id = ?", req.GameID).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	var n model.GameNotice
	if err := store.DB.First(&n, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "公告不存在")
		return
	}
	// cover 头图同步：新图列表非空时首图兼作头图（与发布卡语义一致）；
	// 图片清空时保留原 cover 兜底（旧 cover-only 数据编辑文字不丢头图）
	cover := n.Cover
	if imgs != "" {
		var arr []string
		if json.Unmarshal([]byte(imgs), &arr) == nil && len(arr) > 0 {
			cover = arr[0]
		}
	}
	// map 更新只改指定键，不触碰 create_time（发布时间保持原值）
	if err := store.DB.Model(&model.GameNotice{}).Where("id = ?", id).Updates(map[string]interface{}{
		"game_id": req.GameID, "title": req.Title, "content": req.Content, "images": imgs, "cover": cover,
		"layout": gameNoticeLayoutClean(req.Layout),
	}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	logger.Info("游戏公告编辑: id=%d game=%d title=%s, 操作人=%s", id, req.GameID, req.Title, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameNoticeDelete 删除公告（行级删除，无磁盘资源）
func (s *Server) handleAdminGameNoticeDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if err := store.DB.Delete(&model.GameNotice{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除失败")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameConfigGet 商店布局配置读取（返回与公开接口同构：layout/sections/featured_games）
func (s *Server) handleAdminGameConfigGet(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	layout, sections, featured := gameStoreConfig("")
	adminJSON(w, map[string]interface{}{
		"layout": layout, "sections": sections, "featured_games": featured,
	})
}

// handleAdminGameConfigPut 商店布局配置保存（热生效：用户下次打开商店即按新配置渲染）：
//   - layout 枚举校验（steam/grid）
//   - sections 仅认 carousel/featured/tagbar 三键，未传键保持默认开
//   - featured 去重截断至 8 个并逐一校验存在且上架（下架/不存在拒绝，管理端把好第一道关）
func (s *Server) handleAdminGameConfigPut(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var req struct {
		Layout   string          `json:"layout"`
		Sections map[string]bool `json:"sections"`
		Featured []uint          `json:"featured"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if req.Layout != "steam" && req.Layout != "grid" {
		adminFail(w, http.StatusBadRequest, "layout 须为 steam 或 grid")
		return
	}
	sec := map[string]bool{"carousel": true, "featured": true, "tagbar": true}
	for _, k := range []string{"carousel", "featured", "tagbar"} {
		if v, ok := req.Sections[k]; ok {
			sec[k] = v
		}
	}
	secJSON, _ := json.Marshal(sec)
	// 置顶推荐：去重 + 上限 8 个
	feat := make([]uint, 0, len(req.Featured))
	seen := map[uint]bool{}
	for _, id := range req.Featured {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		feat = append(feat, id)
		if len(feat) >= 8 {
			break
		}
	}
	if len(feat) > 0 {
		var cnt int64
		store.DB.Model(&model.Game{}).Where("id IN ? AND status = 0", feat).Count(&cnt)
		if int(cnt) != len(feat) {
			adminFail(w, http.StatusBadRequest, "置顶推荐包含不存在或已下架的游戏")
			return
		}
	}
	featJSON, _ := json.Marshal(feat)
	var cfg model.GameConfig
	if err := store.DB.First(&cfg, 1).Error; err != nil {
		cfg = model.GameConfig{ID: 1}
		if err := store.DB.Create(&cfg).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "配置保存失败")
			return
		}
	}
	if err := store.DB.Model(&cfg).Updates(map[string]interface{}{
		"layout": req.Layout, "sections": string(secJSON), "featured": string(featJSON),
	}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "配置保存失败")
		return
	}
	logger.Info("商店布局配置更新: layout=%s, 操作人=%s", req.Layout, adminUserFromCtx(r))
	layout, sections, featured := gameStoreConfig("")
	adminJSON(w, map[string]interface{}{
		"layout": layout, "sections": sections, "featured_games": featured,
	})
}

// handleAdminGameSectionsGet 推荐区块列表（解析后游戏摘要仅含上架游戏，与管理端编辑视图同构；
// styles 附样式枚举展示名供前端渲染下拉）
func (s *Server) handleAdminGameSectionsGet(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	adminJSON(w, map[string]interface{}{"sections": gameSectionList(""), "styles": gameSectionStyles})
}

// handleAdminGameSectionsPut 推荐区块全量保存（整表替换，事务保证原子性）：
//   - 区块数量≤8；标题非空≤64 字、样式枚举校验
//   - 每区块游戏 ID 去重≤12 个且逐一校验存在且上架（下架/不存在拒绝，管理端把好第一道关）
//   - sort 按数组下标归一（前端上移/下移后整表提交即完成重排）
func (s *Server) handleAdminGameSectionsPut(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var req struct {
		Sections []struct {
			Title string `json:"title"`
			Style string `json:"style"`
			Games []uint `json:"games"`
		} `json:"sections"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if len(req.Sections) > 8 {
		adminFail(w, http.StatusBadRequest, "推荐区块最多 8 个")
		return
	}
	type secRow struct {
		title, style, games string
	}
	rows := make([]secRow, 0, len(req.Sections))
	for i, sec := range req.Sections {
		title := strings.TrimSpace(sec.Title)
		if title == "" {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("第 %d 个区块标题不能为空", i+1))
			return
		}
		if utf8.RuneCountInString(title) > 64 {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("第 %d 个区块标题过长（最多 64 字）", i+1))
			return
		}
		if _, ok := gameSectionStyles[sec.Style]; !ok {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("第 %d 个区块展示样式非法", i+1))
			return
		}
		ids := make([]uint, 0, len(sec.Games))
		seen := map[uint]bool{}
		for _, id := range sec.Games {
			if id == 0 || seen[id] {
				continue
			}
			seen[id] = true
			ids = append(ids, id)
			if len(ids) >= 12 {
				break
			}
		}
		if len(ids) > 0 {
			var cnt int64
			store.DB.Model(&model.Game{}).Where("id IN ? AND status = 0", ids).Count(&cnt)
			if int(cnt) != len(ids) {
				adminFail(w, http.StatusBadRequest, fmt.Sprintf("第 %d 个区块包含不存在或已下架的游戏", i+1))
				return
			}
		}
		gj, _ := json.Marshal(ids)
		rows = append(rows, secRow{title: title, style: sec.Style, games: string(gj)})
	}
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1=1").Delete(&model.GameSection{}).Error; err != nil {
			return err
		}
		for i, rw := range rows {
			rec := model.GameSection{Title: rw.title, Style: rw.style, Sort: i, Games: rw.games}
			if err := tx.Create(&rec).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "推荐区块保存失败")
		return
	}
	logger.Info("商店推荐区块更新: %d 个区块, 操作人=%s", len(rows), adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"sections": gameSectionList("")})
}
