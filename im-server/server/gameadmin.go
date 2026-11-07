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
	"archive/zip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
	"io"
	"net"
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
	Owner     string // 会话归属（上传发起者：管理员或商户用户名；版本登记时校验防跨身份串用）
	Kind      string // game=游戏包 / video=宣传视频（两通道共用会话表与临时目录，Kind 区分互不串道）
	Ext       string // 视频扩展名（video 会话专用，如 ".mp4"，合并落位取名用）
	Total     int
	FileSize  int64
	Received  map[int]int64
	CreatedAt time.Time
}

// uploadOwnerFromCtx 上传发起者身份归口（管理端/商户端守卫二选一注入；版本登记时与会话 Owner 比对）
func uploadOwnerFromCtx(r *http.Request) string {
	if u := adminUserFromCtx(r); u != "" {
		return u
	}
	return merchantUserFromCtx(r)
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

// gamePortForwardsClean 端口透传转发规则清洗（归口）：入参须为合法 JSON 数组串，元素逐条校验——
// proto 仅 tcp/udp；mode 仅 空串=直连 / gateway=经加密网关（网关模式 remote_host 留空，远端端口
// 语义=网关本机 127.0.0.1 端口，网关地址/指纹/token 由服务端全局配置随库接口下发）；
// listen 1024~65535（保留端口 3478/2087 禁用）；remote_port 1~65535；
// 直连模式 remote_host 须为 IPv4/域名字符集；同批 proto+listen 去重；上限 16 条。
// 任一条非法整串拒绝（管理端保存即报错，避免脏规则下发后客户端启动失败）；结果限 2048 字符。
// 空串/空数组一律回空串（无规则=客户端不开启转发，零开销直通）
func gamePortForwardsClean(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	var raw []struct {
		Proto      string `json:"proto"`
		Mode       string `json:"mode"`
		Gw         string `json:"gw"`
		Listen     int    `json:"listen"`
		RemoteHost string `json:"remote_host"`
		RemotePort int    `json:"remote_port"`
	}
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return "", fmt.Errorf("端口转发规则须为 JSON 数组")
	}
	if len(raw) == 0 {
		return "", nil
	}
	if len(raw) > 16 {
		return "", errors.New("端口转发规则过多（上限 16 条）")
	}
	type rule struct {
		Proto      string `json:"proto"`
		Mode       string `json:"mode,omitempty"`
		Gw         string `json:"gw,omitempty"`
		Listen     int    `json:"listen"`
		RemoteHost string `json:"remote_host,omitempty"`
		RemotePort int    `json:"remote_port"`
	}
	out := make([]rule, 0, len(raw))
	seen := map[string]bool{}
	hostRe := regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}$`)
	gwRe := regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)
	for _, r := range raw {
		r.Proto = strings.ToLower(strings.TrimSpace(r.Proto))
		r.Mode = strings.ToLower(strings.TrimSpace(r.Mode))
		r.Gw = strings.ToLower(strings.TrimSpace(r.Gw))
		r.RemoteHost = strings.TrimSpace(r.RemoteHost)
		if r.Proto != "tcp" && r.Proto != "udp" {
			return "", fmt.Errorf("第 %d 条规则协议非法（仅 tcp/udp）", len(out)+1)
		}
		if r.Mode != "" && r.Mode != "gateway" {
			return "", fmt.Errorf("第 %d 条规则模式非法（仅 空串=直连 / gateway=经加密网关）", len(out)+1)
		}
		if r.Listen < 1024 || r.Listen > 65535 {
			return "", fmt.Errorf("第 %d 条规则监听端口须在 1024~65535", len(out)+1)
		}
		if r.Listen == 3478 || r.Listen == 2087 {
			return "", fmt.Errorf("第 %d 条规则监听端口 %d 为客户端保留端口", len(out)+1, r.Listen)
		}
		if r.RemotePort < 1 || r.RemotePort > 65535 {
			return "", fmt.Errorf("第 %d 条规则远端端口非法", len(out)+1)
		}
		if r.Mode == "gateway" {
			// 网关模式：远端=网关本机 127.0.0.1 端口（remote_host 留空；gw=@网关名 引用服务端
			// 地址簿 gateways 中的条目决定连哪台网关，留空=缺省第一条）。仅格式校验不做存在性
			// 校验（网关改名/删除不应卡死历史游戏规则的编辑；客户端启动时查不到会明确提示）
			r.RemoteHost = ""
			if r.Gw != "" && !gwRe.MatchString(r.Gw) {
				return "", fmt.Errorf("第 %d 条规则网关名非法（小写字母/数字/_/-，1-32 位）", len(out)+1)
			}
		} else {
			// 直连模式：不允许带网关名；remote_host 必填且须为 IPv4/域名字符集
			if r.Gw != "" {
				return "", fmt.Errorf("第 %d 条规则为直连模式，不应携带网关名（@名 仅网关模式使用）", len(out)+1)
			}
			if r.RemoteHost == "" || !hostRe.MatchString(r.RemoteHost) || strings.Contains(r.RemoteHost, "..") ||
				strings.HasPrefix(r.RemoteHost, ".") || strings.HasPrefix(r.RemoteHost, "-") ||
				strings.HasSuffix(r.RemoteHost, ".") || strings.HasSuffix(r.RemoteHost, "-") {
				return "", fmt.Errorf("第 %d 条规则远端地址非法（须为 IPv4 或域名）", len(out)+1)
			}
		}
		key := r.Proto + ":" + strconv.Itoa(r.Listen)
		if seen[key] {
			return "", fmt.Errorf("存在重复监听 %s", key)
		}
		seen[key] = true
		out = append(out, rule{Proto: r.Proto, Mode: r.Mode, Gw: r.Gw, Listen: r.Listen, RemoteHost: r.RemoteHost, RemotePort: r.RemotePort})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", fmt.Errorf("端口转发规则序列化失败")
	}
	if len(b) > 2048 {
		return "", fmt.Errorf("端口转发规则串超长（上限 2048 字节）")
	}
	return string(b), nil
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
	// 版本清单导出（GamePatchTool -base-list 基准数据源；与上面 version/{vid} 段数不同无冲突）
	http.HandleFunc("GET /admin/api/game/version/{vid}/filelist", s.adminGuard(s.handleAdminVersionFilelist))
	// 补丁工具下载（与商户端 /api/merchant/gametool 同一文件托管核心，adminGuard 鉴权）
	http.HandleFunc("GET /admin/api/game/gametool", s.adminGuard(s.handleAdminGameToolDownload))
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
	// 网关地址簿（后台热更归口：增删改查全走 DB 表 im_gateway_book；token 密钥仍留 config.yaml）
	http.HandleFunc("GET /admin/api/game/gateways", s.adminGuard(s.handleAdminGameGateways))
	http.HandleFunc("POST /admin/api/game/gateways", s.adminGuard(s.handleAdminGameGatewayCreate))
	http.HandleFunc("PUT /admin/api/game/gateways/{id}", s.adminGuard(s.handleAdminGameGatewayUpdate))
	http.HandleFunc("DELETE /admin/api/game/gateways/{id}", s.adminGuard(s.handleAdminGameGatewayDelete))
	// 指纹自动探测（添加/编辑弹窗「从网关获取」按钮：TLS 连公网地址取对端证书算 SHA256）
	http.HandleFunc("POST /admin/api/game/gateway/probe", s.adminGuard(s.handleAdminGameGatewayProbe))
	// 积分兑换充值订单审计页（gamerecharge.go 归口；管理端只读）
	http.HandleFunc("GET /admin/api/game/recharge/orders", s.adminGuard(s.HandleAdminGameRechargeOrders))
	// 充值卡（gamecard.go 归口）：生成/列表/作废/导出
	http.HandleFunc("POST /admin/api/game/card/generate", s.adminGuard(s.HandleAdminCardGenerate))
	http.HandleFunc("GET /admin/api/game/card/list", s.adminGuard(s.HandleAdminCardList))
	http.HandleFunc("POST /admin/api/game/card/void", s.adminGuard(s.HandleAdminCardVoid))
	http.HandleFunc("GET /admin/api/game/card/export", s.adminGuard(s.HandleAdminCardExport))
}

// 网关地址簿条目清洗正则（包级编译一次：name 规则 / addr host / fingerprint hex）
var (
	gwBookNameRe   = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)
	gwBookHostRe   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}$`)
	gwBookFPRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	gwBookSecretRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// gameGatewayBookClean 网关地址簿条目清洗（后台增改归口）：name 小写化后须匹配 ^[a-z0-9_-]{1,64}$ 且全表唯一；
// addr 须为 IPv4/域名:端口（host 字符集 [A-Za-z0-9._-]+，端口 1~65535）且全表唯一（同 addr 两条目语义重复无意义）；
// fingerprint 须为 64 位 hex；secret 可选——空=回退共享 gateway_token_secret，非空须 64hex（本网关专属
// 验签密钥，须与该网关机 gateway.yaml token_secret 一致）。返回清洗后的行与错误说明
func gameGatewayBookClean(req *model.GatewayBook) (model.GatewayBook, string) {
	row := model.GatewayBook{
		Name:        strings.ToLower(strings.TrimSpace(req.Name)),
		Addr:        strings.TrimSpace(req.Addr),
		Fingerprint: strings.ToLower(strings.TrimSpace(req.Fingerprint)),
		Secret:      strings.ToLower(strings.TrimSpace(req.Secret)),
		Enabled:     req.Enabled,
		Sort:        req.Sort,
	}
	if !gwBookNameRe.MatchString(row.Name) {
		return row, "引用名须为 1~64 位小写字母/数字/_/-"
	}
	host, portStr, err := net.SplitHostPort(row.Addr)
	if err != nil || host == "" || !gwBookHostRe.MatchString(host) {
		return row, "地址须为 host:port 格式（如 1.2.3.4:30100）"
	}
	if p, e := strconv.Atoi(portStr); e != nil || p < 1 || p > 65535 {
		return row, "地址端口须为 1~65535"
	}
	if !gwBookFPRe.MatchString(row.Fingerprint) {
		return row, "证书指纹须为 64 位十六进制（SHA256，取网关首启日志输出）"
	}
	if row.Secret != "" && !gwBookSecretRe.MatchString(row.Secret) {
		return row, "专属密钥须为 64 位十六进制（留空=回退共享密钥）"
	}
	if row.Sort < 0 {
		row.Sort = 0
	}
	return row, ""
}

// handleAdminGameGateways 管理端查询网关地址簿（全字段回显：编辑弹窗需回填指纹；
// adminGuard 已鉴权，管理员本就可改 config，无泄漏面）。
// 未配置返回 {ok:true, gateways:[]}，前端提示到本页添加
func (s *Server) handleAdminGameGateways(w http.ResponseWriter, r *http.Request) {
	var rows []model.GatewayBook
	store.DB.Order("sort asc, id asc").Find(&rows)
	out := make([]model.GatewayBook, 0, len(rows))
	for _, g := range rows {
		g.Fingerprint = strings.ToLower(strings.TrimSpace(g.Fingerprint))
		out = append(out, g)
	}
	adminJSON(w, map[string]interface{}{"gateways": out})
}

// handleAdminGameGatewayCreate 新增网关条目（清洗 + name/addr 唯一校验 + 上限 32 条）
func (s *Server) handleAdminGameGatewayCreate(w http.ResponseWriter, r *http.Request) {
	var req model.GatewayBook
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	row, why := gameGatewayBookClean(&req)
	if why != "" {
		adminFail(w, http.StatusBadRequest, why)
		return
	}
	var cnt int64
	store.DB.Model(&model.GatewayBook{}).Count(&cnt)
	if cnt >= 32 {
		adminFail(w, http.StatusBadRequest, "地址簿已达上限 32 条")
		return
	}
	var dup int64
	store.DB.Model(&model.GatewayBook{}).Where("name = ? OR addr = ?", row.Name, row.Addr).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusBadRequest, "引用名或地址已存在（同地址勿重复登记）")
		return
	}
	// 专属密钥留空=服务端自动生成（推荐：逐网关独立密钥，泄露/轮换半径=单网关）；非空=管理员手填
	if row.Secret == "" {
		row.Secret = gameRandomSecret() + gameRandomSecret() // 2×32hex = 64hex（32 字节）
	}
	if err := store.DB.Create(&row).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	adminJSON(w, map[string]interface{}{"gateway": row})
}

// handleAdminGameGatewayUpdate 更新网关条目（清洗 + 唯一性排除自身 + 启用状态随改随生效）
func (s *Server) handleAdminGameGatewayUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil || id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var g model.GatewayBook
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "条目不存在")
		return
	}
	var req model.GatewayBook
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	row, why := gameGatewayBookClean(&req)
	if why != "" {
		adminFail(w, http.StatusBadRequest, why)
		return
	}
	var dup int64
	store.DB.Model(&model.GatewayBook{}).Where("(name = ? OR addr = ?) AND id <> ?", row.Name, row.Addr, id).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusBadRequest, "引用名或地址已存在（同地址勿重复登记）")
		return
	}
	// 专属密钥留空=保留库内原值（不打断在用网关）；非空=更新为指定值（64hex，前端「重新生成」
	// 按钮本地随机生成后填入——更换后须同步更新该网关机 gateway.yaml 并重启，否则验签/拉取 401）
	finalSecret := g.Secret
	if row.Secret != "" {
		finalSecret = row.Secret
	}
	if err := store.DB.Model(&g).Updates(map[string]interface{}{
		"name": row.Name, "addr": row.Addr, "fingerprint": row.Fingerprint, "secret": finalSecret, "enabled": row.Enabled, "sort": row.Sort,
	}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	store.DB.First(&g, id)
	adminJSON(w, map[string]interface{}{"gateway": g})
}

// handleAdminGameGatewayDelete 删除网关条目（引用了该 @名 的游戏规则将在客户端启动时报"未在地址簿中配置"）
func (s *Server) handleAdminGameGatewayDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil || id == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if err := store.DB.Delete(&model.GatewayBook{}, id).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除失败")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminGameGatewayProbe 自动获取网关证书指纹（后台「添加/编辑网关」的「从网关获取」按钮归口）：
// im-server 主动向公网地址发起 TLS 连接（网关为自签证书，跳过系统校验——TOFU 首次信任语义），
// 取回对端证书算 DER SHA256 指纹。安全面说明：证书在 TLS 握手阶段本就向任何连接者公开（协议设计如此），
// 指纹是公开摘要非机密，本接口不放大暴露面；TOFU 污染窗口仅"获取时刻"一次，结果附证书有效期供人工核对，
// 之后客户端 pin 校验比获取时更严格（后续劫持者指纹对不上直接被拒）。仅 adminGuard 后可调、5s 超时
func (s *Server) handleAdminGameGatewayProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Addr string `json:"addr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	host, portStr, err := net.SplitHostPort(strings.TrimSpace(req.Addr))
	if err != nil || host == "" || !gwBookHostRe.MatchString(host) {
		adminFail(w, http.StatusBadRequest, "地址须为 host:port 格式（如 1.2.3.4:30100）")
		return
	}
	if p, e := strconv.Atoi(portStr); e != nil || p < 1 || p > 65535 {
		adminFail(w, http.StatusBadRequest, "地址端口须为 1~65535")
		return
	}
	// TLS 探测：InsecureSkipVerify 因网关为自签（我们正是要取它的自签证书）；5s 超时防挂死
	d := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(d, "tcp", host+":"+portStr, &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		adminFail(w, http.StatusBadGateway, "连接网关失败（检查公网地址/防火墙/网关是否已启动）："+err.Error())
		return
	}
	defer conn.Close()
	crt := conn.ConnectionState().PeerCertificates[0]
	sum := sha256.Sum256(crt.Raw)
	fp := hex.EncodeToString(sum[:])
	issuer := strings.TrimSpace(crt.Issuer.String())
	selfSigned := issuer != "" && issuer == strings.TrimSpace(crt.Subject.String())
	adminJSON(w, map[string]interface{}{
		"fingerprint": fp,
		"not_before":  crt.NotBefore.Format("2006-01-02"),
		"not_after":   crt.NotAfter.Format("2006-01-02"),
		"self_signed": selfSigned,
	})
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
	if g.SteamEmu != 0 && g.SteamEmu != 1 {
		g.SteamEmu = 0 // 启动方式白名单：0=直接启动（默认）1=SmartSteamEmu 模拟器
	}
	g.SteamAppId = gameSteamAppIdClean(g.SteamAppId)
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
	// 端口透传转发规则清洗（保存即校验：任一条非法整串拒绝，防脏规则下发后客户端启动失败）
	pfClean, pfErr := gamePortForwardsClean(g.PortForwards)
	if pfErr != nil {
		adminFail(w, http.StatusBadRequest, pfErr.Error())
		return
	}
	g.PortForwards = pfClean
	// 联机方式路由（设计文档 §二/四）：白名单校验 + 与 supernode 多选联动——
	// supernode 方式需至少一个节点；tunnel 方式清空 Supernodes（隧道不消费，防脏数据）
	g.NetMode = strings.TrimSpace(g.NetMode)
	if g.NetMode != "" && g.NetMode != "supernode" && g.NetMode != "tunnel" {
		adminFail(w, http.StatusBadRequest, "联机方式非法（仅支持 跟随全局/虚拟网卡/端口隧道）")
		return
	}
	// 联机 supernode 白名单校验（虚拟网卡路线 §8.3）：所选必须 ⊆ 当前生效候选（后台热更值优先），
	// 防后台接口被直接调用提交任意地址；空=未配置走全局兜底
	snClean, serr := vipSupernodesClean(g.Supernodes)
	if serr != nil {
		adminFail(w, http.StatusBadRequest, serr.Error())
		return
	}
	if g.NetMode == "supernode" && snClean == "" {
		adminFail(w, http.StatusBadRequest, "虚拟网卡方式需至少选择一个 supernode")
		return
	}
	if g.NetMode == "tunnel" {
		snClean = ""
	}
	g.Supernodes = snClean
	// 写库网关名清洗（仅写库游戏归口）：小写格式校验（与转发规则 @名 同口径，仅格式不做存在性
	// 校验——网关改名/删除不卡死编辑；不命中则静默不写）。空=纯游戏/走转发规则归属
	g.DbwriteGw = strings.ToLower(strings.TrimSpace(g.DbwriteGw))
	if g.DbwriteGw != "" && !gwBookNameRe.MatchString(g.DbwriteGw) {
		adminFail(w, http.StatusBadRequest, "写库网关名须为 1~64 位小写字母/数字/_/-（留空=不写库或按转发规则归属）")
		return
	}
	// 积分充值配置清洗（gamerecharge.go 归口，创建/更新同口径：网关名/汇率/日限额/档位归一）
	if err := rechargeGameCfgClean(&g); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
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
	// 归属/审核态强制归一（防请求体注入：model.Game 整体解码会接收 owner_username/audit_status——
	// 官方游戏被注入 audit=3 会从玩家端消失、注入任意 owner 会造成脏归属；管理员创建一律官方免审。
	// 商户游戏归属仅经商户接口链路写入，管理员调整归属走商户管理归口）
	g.OwnerUsername = ""
	g.AuditStatus = model.GameAuditOfficial
	g.AuditRemark = ""
	g.AuditedBy = ""
	g.AuditTime = nil
	// 游戏专属派生密钥强制服务端生成（覆盖请求可能携带的任意值；模型 json:"-" 本就不接收，
	// 此处双保险）：每游戏独立持钥，单游戏密钥泄露/轮换不影响其他游戏
	g.GameSecret = gameRandomSecret()
	// BT·上传种子方式：从落盘种子填充 size_bytes/latest_version（用户端详情"游戏大小/最新版本"展示源）
	s.gameTorrentMetaFill(&g, true)
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
		// 归属/审核态（管理端列表列展示：官方/商户名+审核徽标；商户字段不入 gameSummary 公开摘要）
		item["owner_username"] = g.OwnerUsername
		item["audit_status"] = g.AuditStatus
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
			// 打包方式下发（管理端版本管理徽标/基底下拉/导出清单数据源，与商户端同口径）
			"pack_type": v.PackType, "pack_size": v.PackSize, "base_version": v.BaseVersion,
			"create_time": v.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	item := gameSummary(g)
	item["status"] = g.Status
	item["description"] = g.Description
	item["versions"] = verList
	// 上传种子文件名（管理端表单回填/上架切换全量回写保真；服务端私有字段 json:"-" 不随 model 下发）
	item["torrent_path"] = g.TorrentPath
	// 联机 supernode 列表/联机方式回填（管理端表单编辑用；仅管理端详情下发，商店公开摘要 gameSummary 的
	// net_mode 为建房页数据源非敏感，supernodes 仍仅管理端可见）
	item["supernodes"] = g.Supernodes
	item["net_mode"] = g.NetMode
	// 写库网关名回填（管理端编辑弹窗下拉；仅写库游戏——无网关转发规则时显式声明写库归属）
	item["dbwrite_gw"] = g.DbwriteGw
	// 积分充值配置回填（管理端编辑弹窗；档位还原为原始数组便于表单回显）
	item["recharge_enabled"] = g.RechargeEnabled
	item["recharge_gw"] = g.RechargeGw
	item["recharge_rate"] = g.RechargeRate
	item["recharge_tiers"] = g.RechargeTiers
	item["recharge_daily_max"] = g.RechargeDailyMax
	// 归属/审核态回填（管理端编辑弹窗「游戏归属」下拉；与列表列同语义：空=官方，非空=商户账号）
	item["owner_username"] = g.OwnerUsername
	item["audit_status"] = g.AuditStatus
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
		// OwnerTransfer 归属转移显式开关（阶段二百九十七补丁）：仅新版前端编辑表单保存时携带 true。
		// 缺省 false=完全不动归属——旧版前端缓存（payload 不带 owner_username）与上下架全量回写
		// 通道在混布窗口期不会把商户游戏误判为"转官方"清掉归属（实测推演踩坑，防御性收口）
		OwnerTransfer bool `json:"owner_transfer"`
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
	if u.SteamEmu != 0 && u.SteamEmu != 1 {
		u.SteamEmu = 0 // 启动方式白名单（同创建口径）：0=直接启动 1=SmartSteamEmu 模拟器
	}
	u.SteamAppId = gameSteamAppIdClean(u.SteamAppId)
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
	// 端口透传转发规则清洗（同创建口径：任一条非法整串拒绝）
	pfClean, pfErr := gamePortForwardsClean(u.PortForwards)
	if pfErr != nil {
		adminFail(w, http.StatusBadRequest, pfErr.Error())
		return
	}
	u.PortForwards = pfClean
	// 联机方式路由（同创建口径）：白名单 + 联动校验（supernode 需节点 / tunnel 清空 Supernodes）
	u.NetMode = strings.TrimSpace(u.NetMode)
	if u.NetMode != "" && u.NetMode != "supernode" && u.NetMode != "tunnel" {
		adminFail(w, http.StatusBadRequest, "联机方式非法（仅支持 跟随全局/虚拟网卡/端口隧道）")
		return
	}
	snClean, serr := vipSupernodesClean(u.Supernodes)
	if serr != nil {
		adminFail(w, http.StatusBadRequest, serr.Error())
		return
	}
	if u.NetMode == "supernode" && snClean == "" {
		adminFail(w, http.StatusBadRequest, "虚拟网卡方式需至少选择一个 supernode")
		return
	}
	if u.NetMode == "tunnel" {
		snClean = ""
	}
	u.Supernodes = snClean
	// 写库网关名清洗（同创建口径）：小写格式校验，非法拒绝
	u.DbwriteGw = strings.ToLower(strings.TrimSpace(u.DbwriteGw))
	if u.DbwriteGw != "" && !gwBookNameRe.MatchString(u.DbwriteGw) {
		adminFail(w, http.StatusBadRequest, "写库网关名须为 1~64 位小写字母/数字/_/-（留空=不写库或按转发规则归属）")
		return
	}
	// 积分充值配置清洗（gamerecharge.go 归口，创建/更新同口径）
	if err := rechargeGameCfgClean(&u); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	// BT·上传种子方式：种子落定后重扫填充 size_bytes/latest_version。种子实际更换（tp≠旧值）时
	// latest_version 按种子日期递增（同日重传自动追加序号 .2/.3——客户端按字符串比较判更新，
	// 同日重传日期不变会漏掉更新提示）；未换种子（普通编辑保存）latest_version 原值保留不递增
	// （防每次编辑保存都误触全员更新）。u.LatestVersion 先预置库中旧值作递增基线
	u.TorrentPath = tp
	u.LatestVersion = g.LatestVersion
	s.gameTorrentMetaFill(&u, tp != "" && tp != g.TorrentPath)
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
		"steam_emu": u.SteamEmu, "steam_app_id": u.SteamAppId,
		"port_forwards": u.PortForwards,
		"dbwrite_gw":    u.DbwriteGw,
		// 积分充值配置（gamerecharge.go 清洗后的归一值全量回写）
		"recharge_enabled":   u.RechargeEnabled,
		"recharge_gw":        u.RechargeGw,
		"recharge_rate":      u.RechargeRate,
		"recharge_tiers":     u.RechargeTiers,
		"recharge_daily_max": u.RechargeDailyMax,
		"save_paths":         u.SavePaths, "save_exclude": u.SaveExclude,
		"online_ports_tcp": gamePortsClean(u.OnlinePortsTCP), "online_ports_udp": gamePortsClean(u.OnlinePortsUDP),
		"supernodes": u.Supernodes, "net_mode": u.NetMode,
		"torrent_path": tp,
		// BT·上传种子元信息全量回写（种子重扫结果）：换新种子保存即更新大小与版本日期
		"size_bytes": u.SizeBytes, "latest_version": u.LatestVersion,
	}
	// 归属转移（受控放开，阶段二百九十七）：仅当请求携带显式开关 owner_transfer=true 才评估归属变更
	//（仅新版前端编辑表单保存时携带）——u.OwnerUsername 随 model.Game 嵌入解码，与库内值相等视为
	// 未变更（表单全量回写零影响）：
	//   目标空 = 转官方：清审核字段回官方免审，玩家端即时恢复可见；
	//   目标非空 = 转商户：目标必须是 users.role=2 商户账号（不存在/非商户整单拒绝并提示），
	//   转移即回待审核——玩家侧过滤墙只放行 audit IN (0,2)，官方转商户后游戏即时从玩家端隐藏，
	//   商户管理「游戏审核」通过后自动重新上架（商户后台按 owner 过滤，转移后立即可见可编辑）
	ownTarget := strings.TrimSpace(u.OwnerUsername)
	if req.OwnerTransfer && ownTarget != g.OwnerUsername {
		if ownTarget == "" {
			updates["owner_username"] = ""
			updates["audit_status"] = model.GameAuditOfficial
			updates["audit_remark"] = ""
			// audit_time 清 NULL 须用显式表达式：GORM map 更新对裸 nil 跳过赋值（实测踩坑）
			updates["audit_time"] = gorm.Expr("NULL")
			updates["audited_by"] = ""
			logger.Info("游戏转官方: %s (%s), 原归属=%s, 操作人=%s", u.Name, g.Slug, g.OwnerUsername, adminUserFromCtx(r))
		} else {
			var mCnt int64
			store.DB.Model(&model.User{}).Where("username = ? AND role = ?", ownTarget, 2).Count(&mCnt)
			if mCnt == 0 {
				adminFail(w, http.StatusBadRequest, "归属目标账号不存在或不是商户账号（请在商户管理中先创建）")
				return
			}
			nowOwn := time.Now()
			updates["owner_username"] = ownTarget
			updates["audit_status"] = model.GameAuditPending
			updates["audit_remark"] = ""
			updates["audit_time"] = &nowOwn
			updates["audited_by"] = ""
			logger.Info("游戏归属转移: %s (%s), %s → %s, 操作人=%s", u.Name, g.Slug, g.OwnerUsername, ownTarget, adminUserFromCtx(r))
		}
	} else if g.OwnerUsername != "" {
		// 管理员代改商户游戏对外字段（归属未变）→ 回待审核（与商户侧编辑同语义；官方游戏不受影响）
		now := time.Now()
		updates["audit_status"] = model.GameAuditPending
		updates["audit_remark"] = ""
		updates["audit_time"] = &now
	}
	if err := store.DB.Model(&g).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	store.DB.First(&g, id)
	adminJSON(w, gameSummary(g))
}

// gameSteamAppIdClean Steam 应用 ID 清洗（SmartSteamEmu 联机匹配用）：去空白；仅允许纯数字
// （Steam AppId 本身即数字串），非法/超长返回空串（=客户端写 0 由 SSE 读游戏目录 steam_appid.txt）
func gameSteamAppIdClean(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 32 {
		return ""
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return s
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
	// 与版本登记/版本删除同一把分桶锁：本函数 RemoveAll 整个 games/<slug>/ 目录并清全部
	// 版本行，不持锁会与进行中的版本登记交错（登记落位中目录被整删 → 孤儿版本行/孤儿文件）
	vlock := gameVersionLock(g.ID)
	if !vlock.TryLock() {
		adminFail(w, http.StatusConflict, "该游戏有版本登记/删除操作进行中，请稍后重试")
		return
	}
	defer vlock.Unlock()
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
		sess = &gameUploadSession{UploadID: uploadID, Owner: uploadOwnerFromCtx(r), Kind: "game", Total: total, FileSize: fileSize,
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

// gameTorrentMetaFill BT·上传种子游戏的元信息归口（下载方式=2 且种子已上传时调用）：
// 从落盘的 .torrent 重扫 info（与上传接口同源），填充 size_bytes（种子内文件总大小）与
// latest_version（种子上传日期 yyyy-MM-dd——BT 方式无版本概念，换新种子=日期自动更新，
// 语义即"该版本的发布日期"）。seedChanged=true（种子实际更换：新建/重传）时同日重传自动追加
// 递增序号（2026-10-24 → 2026-10-24.2 → .3，跨日自然重置）——客户端按 latest_version 字符串
// 比较判定"待更新"，同日重传日期不变会漏掉更新提示；seedChanged=false（普通编辑保存/冗余回填）
// 仅重扫大小，latest_version 原值保留（防每次编辑保存都递增序号误触全员更新）。解析失败静默跳过
func (s *Server) gameTorrentMetaFill(g *model.Game, seedChanged bool) {
	if g.DownloadMethod != 2 || strings.TrimSpace(g.TorrentPath) == "" {
		return
	}
	fp := filepath.Join(s.gameUploadedTorrentDir(), g.TorrentPath)
	data, err := os.ReadFile(fp)
	if err != nil {
		return
	}
	_, total, count := torrentInfoScan(data)
	if total <= 0 || count <= 0 {
		return
	}
	g.SizeBytes = total
	if st, err := os.Stat(fp); err == nil {
		today := st.ModTime().Format("2006-01-02")
		if !seedChanged {
			if g.LatestVersion == "" {
				g.LatestVersion = today // 存量补齐（库中无旧值）：按种子日期填充
			}
			return // 种子未换：latest_version 原值保留（含同日序号）
		}
		// 种子更换：同日重传序号递增（防同日重传漏更新提示）
		prev := g.LatestVersion
		switch {
		case prev == today:
			g.LatestVersion = today + ".2"
		case strings.HasPrefix(prev, today+"."):
			if n, err := strconv.Atoi(strings.TrimPrefix(prev, today+".")); err == nil {
				g.LatestVersion = today + "." + strconv.Itoa(n+1)
			} else {
				g.LatestVersion = today
			}
		default:
			g.LatestVersion = today // 跨日/无旧值：自然重置为新日期
		}
	}
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
		sess = &gameUploadSession{UploadID: uploadID, Owner: uploadOwnerFromCtx(r), Kind: "video", Ext: ext, Total: total,
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

// handleAdminGameVersionCreate 版本上架登记入口（管理端）：归属校验后走共享核心
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
	s.gameVersionCreateCore(w, r, &g, uploadOwnerFromCtx(r))
}

// gameVersionLocks 版本登记/删除互斥（按游戏 ID 分桶）：串行化同一游戏的
// 「查重 → 合并落位 → 入库」临界区——防并发登记同一 version 双过查重后交错写盘、
// 失败方回滚 os.RemoveAll 误删成功方文件；删除同拿锁防与落位中的目录交错。
// map 项只增不减（量级=游戏数，可忽略）
var gameVersionLocks sync.Map // map[uint]*sync.Mutex

// gameVersionLock 取游戏分桶锁（不存在即原子创建）
func gameVersionLock(gameID uint) *sync.Mutex {
	v, _ := gameVersionLocks.LoadOrStore(gameID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// gameVersionCreateCore 版本上架登记共享核心（管理端/商户端同链路，商户侧前置归属校验）：
// 入参 {version, changelog, min_req, files:[{rel_path,size,sha256,upload_id}]}
// 流程：清洗校验 → 逐文件合并分片至 games/<slug>/<version>/<rel_path>（MultiWriter 单遍复算
// SHA256 与总大小，不信任客户端声明）→ 全部通过后登记版本与清单行 → 刷新游戏最新版冗余 → 清理临时分片。
// 分片会话 Owner 与操作者强制比对（防跨身份串用他人会话）
func (s *Server) gameVersionCreateCore(w http.ResponseWriter, r *http.Request, g *model.Game, operator string) {
	// BT·上传种子方式禁走版本上架：客户端清单按种子合成（files 恒空，下载走 BT 分片校验），
	// 上架的版本文件客户端永远不下载（孤儿数据）；且版本表记录会让 BT 清单版本号恒为该版本号，
	// 覆盖"换新种子=日期变=触发更新"的检测闭环（gameManifest 版本号优先级：版本表 > latest_version）。
	// 换新版本请走「编辑游戏 → 上传新种子」：gameTorrentMetaFill 重扫即更新大小与版本日期
	if g.DownloadMethod == 2 {
		adminFail(w, http.StatusBadRequest, "BT 种子方式无需版本上架：换新种子（编辑游戏→上传新种子文件）即自动更新大小与版本日期")
		return
	}
	var req struct {
		Version   string `json:"version"`
		Changelog string `json:"changelog"`
		MinReq    string `json:"min_req"`
		// PackType 打包方式（0=散文件清单现状 1=单ZIP 2=分卷ZIP；manifest 随版本下发客户端），
		// 缺省 0 等价历史行为——散文件上架链路零改动
		PackType int8 `json:"pack_type"`
		// PackSize 解压后总大小（字节）：pack_type=1 由服务端读 central directory 实算（本字段忽略）；
		// pack_type=2 分卷服务端无法解析，必须由商户端填写；pack_type=0 忽略
		PackSize int64 `json:"pack_size"`
		// BaseVersion 补丁基底版本号（pack_type=3 专用必填）：必须为同游戏已登记的散文件版或另一补丁版
		BaseVersion string `json:"base_version"`
		Files       []struct {
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
	// 查重-落位竞态防护：按游戏分桶 TryLock 快速失败（大版本落位耗时分钟级，
	// 并发请求挂起占连接不如直接 409 让操作者稍后重试）。锁覆盖查重→合并落位→入库全程
	vlock := gameVersionLock(g.ID)
	if !vlock.TryLock() {
		adminFail(w, http.StatusConflict, "该游戏有另一个版本登记/删除操作进行中，请稍后重试")
		return
	}
	defer vlock.Unlock()
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
		sess, ok := gameUploadSessions.m[f.UploadID]
		gameUploadSessions.Unlock()
		if !ok {
			adminFail(w, http.StatusGone, "分片会话不存在或已过期: "+rp+"（请重新上传该文件）")
			return
		}
		// 会话归属校验：登记者必须与上传发起者一致（防商户/管理员跨身份串用他人 upload_id）
		if operator == "" || sess.Owner != operator {
			adminFail(w, http.StatusForbidden, "分片会话归属校验失败: "+rp+"（请以当前登录身份重新上传）")
			return
		}
		items = append(items, gameUploadItem{relPath: rp, size: f.Size, sha: sha, uploadID: f.UploadID})
	}

	// 打包方式校验（ZIP 整包/分卷新增通道；0=散文件现状不校验，存量版本与历史调用不受影响）
	packType := req.PackType
	if packType < 0 || packType > 3 {
		adminFail(w, http.StatusBadRequest, "打包方式非法（0=散文件清单 1=单 ZIP 2=分卷 ZIP 3=补丁包）")
		return
	}
	packSize := req.PackSize
	baseVer := strings.TrimSpace(req.BaseVersion)
	if packType != 3 {
		baseVer = "" // 基底版本号仅补丁通道有意义，其余方式强制置空（防请求参数污染 BaseVersion 列）
	}
	switch packType {
	case 1: // 单 ZIP：清单必须恰好 1 项且以 .zip 结尾（大小写不敏感）；解压后大小合并落位后服务端实算
		if len(items) != 1 || !strings.HasSuffix(strings.ToLower(items[0].relPath), ".zip") {
			adminFail(w, http.StatusBadRequest, "单 ZIP 打包方式的文件清单必须恰好包含 1 个 .zip 文件")
			return
		}
	case 2: // 分卷 ZIP：同前缀 .zip.001 起连续递增（7z 原生命名）；服务端无法解析分卷，解压后大小必填
		if len(items) < 2 {
			adminFail(w, http.StatusBadRequest, "分卷 ZIP 打包方式的文件清单至少需要 2 个分卷")
			return
		}
		if err := gameSplitZipCheck(items); err != nil {
			adminFail(w, http.StatusBadRequest, err.Error())
			return
		}
		if packSize <= 0 {
			adminFail(w, http.StatusBadRequest, "分卷 ZIP 必须填写解压后总大小（服务端无法从分卷解析）")
			return
		}
	case 3: // 补丁包：清单必须恰好 1 项 .zip；基底版本必填且须为同游戏散文件版/补丁版（合并落位后解包合成）
		if len(items) != 1 || !strings.HasSuffix(strings.ToLower(items[0].relPath), ".zip") {
			adminFail(w, http.StatusBadRequest, "补丁包方式的文件清单必须恰好包含 1 个 patch.zip 文件")
			return
		}
		if baseVer == "" {
			adminFail(w, http.StatusBadRequest, "补丁包必须指定基底版本 base_version")
			return
		}
	}
	if packType == 2 { // ZIP 炸弹防护：分卷按商户申报值预检（单 ZIP 实算后再查）
		if cap := s.cfg.Game.MaxUnpackSize; cap > 0 && packSize > cap {
			adminFail(w, http.StatusBadRequest, "解压后总大小超出上限（上限 "+strconv.FormatInt(cap>>20, 10)+"MB）")
			return
		}
	}

	// 合并落位：目标根目录 games/<slug>/<version>/，逐文件校验（失败即整版回滚删目录）
	// 商户存储总量配额·预检（快）：申报大小 + 已用 > 配额直接拒绝（大版本合并耗时分钟级，
	// 提前拦截不浪费 IO；落位后还有实算复检兜底，见 gameMerchantQuotaCheck）
	if g.OwnerUsername != "" {
		var incoming int64
		for _, it := range items {
			incoming += it.size
		}
		if err := s.gameMerchantQuotaCheck(g.OwnerUsername, incoming); err != nil {
			adminFail(w, http.StatusBadRequest, err.Error())
			return
		}
	}
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
	// 商户存储总量配额·复检（准）：落位实算 totalSize 与申报可能有差（防申报缩水绕过预检），
	// 超限整版回滚（目录清理与预检拒绝同一语义，商户拿明确报错自助删旧版本腾额度）
	if g.OwnerUsername != "" {
		if err := s.gameMerchantQuotaCheck(g.OwnerUsername, totalSize); err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	// 单 ZIP：合并落位后读 central directory 实算解压后总大小（不信任商户申报），
	// 同时做条目路径安检（Zip Slip 服务端第一道防线，客户端解压前还有第二道）
	if packType == 1 {
		zipPath := filepath.Join(verRoot, filepath.FromSlash(items[0].relPath))
		computed, err := gameZipUnpackSize(zipPath)
		if err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "ZIP 包损坏或无法解析（"+err.Error()+"）")
			return
		}
		if cap := s.cfg.Game.MaxUnpackSize; cap > 0 && computed > cap {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "ZIP 解压后总大小超出上限（上限 "+strconv.FormatInt(cap>>20, 10)+"MB）")
			return
		}
		packSize = computed
	}

	// pack_type=3 补丁：解包 patch.zip 落位 + 依基底版本清单合成完整清单。合成结果物化落
	// GameFile 行——manifest 对客户端透明表现为普通散文件版本（dedup 硬链接天然增量、
	// _commit 整目录换入使删除文件自动消失），链式补丁逐版本物化无需运行期递归。
	// patch.json 为保留名（元数据），不作为游戏文件登记。
	var finalItems []gameUploadItem // pack 0/1/2：与 items 相同；pack 3：合成后的最终清单
	var patchDelJSON string
	storageOverride := map[string]string{} // pack 3 继承条目的存储路径覆写（物理文件在基底版本目录）
	if packType == 3 {
		var bv model.GameVersion
		if err := store.DB.Where("game_id = ? AND version = ?", g.ID, baseVer).First(&bv).Error; err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusNotFound, "基底版本不存在: "+baseVer)
			return
		}
		if bv.PackType != 0 && bv.PackType != 3 {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "基底版本必须为散文件版或补丁版（ZIP 整包/分卷版无逐文件清单，无法合成），请改发完整版")
			return
		}
		var baseFiles []model.GameFile
		store.DB.Where("version_id = ?", bv.ID).Find(&baseFiles)
		if len(baseFiles) == 0 {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusInternalServerError, "基底版本清单缺失")
			return
		}
		baseMap := make(map[string]gameUploadItem, len(baseFiles))
		for _, f := range baseFiles {
			baseMap[f.RelPath] = gameUploadItem{relPath: f.RelPath, size: f.SizeBytes, sha: f.SHA256}
		}
		zipPath := filepath.Join(verRoot, filepath.FromSlash(items[0].relPath))
		changeMap, pjBytes, err := gamePatchUnpack(zipPath, verRoot, s.cfg.Game.MaxUnpackSize)
		if err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "补丁包解包失败（"+err.Error()+"）")
			return
		}
		var pj struct {
			Format      int      `json:"format"`
			BaseVersion string   `json:"base_version"`
			Version     string   `json:"version"`
			Change      []string `json:"change"`
			Delete      []string `json:"delete"`
		}
		if err := json.Unmarshal(pjBytes, &pj); err != nil {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "patch.json 解析失败（"+err.Error()+"）")
			return
		}
		if pj.Format != 1 {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "patch.json 格式版本不支持")
			return
		}
		if pj.BaseVersion != "" && pj.BaseVersion != baseVer {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "patch.json 基底版本("+pj.BaseVersion+")与登记参数("+baseVer+")不一致")
			return
		}
		if pj.Version != "" && pj.Version != version {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "patch.json 版本号("+pj.Version+")与登记版本号("+version+")不一致，请用 gametool diff -ver "+version+" 重新生成")
			return
		}
		if len(pj.Change) != len(changeMap) {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "patch.json change 数量与 zip 条目不一致")
			return
		}
		for _, c := range pj.Change {
			if _, ok := changeMap[c]; !ok {
				s.gameVersionRollback(verRoot, items, true)
				adminFail(w, http.StatusBadRequest, "patch.json change 与 zip 条目不一致: "+c)
				return
			}
		}
		delSet := make(map[string]bool, len(pj.Delete))
		for _, d := range pj.Delete {
			if zipEntryUnsafe(d) {
				s.gameVersionRollback(verRoot, items, true)
				adminFail(w, http.StatusBadRequest, "补丁删除清单含非法路径: "+d)
				return
			}
			if _, ok := changeMap[d]; ok {
				s.gameVersionRollback(verRoot, items, true)
				adminFail(w, http.StatusBadRequest, "delete 与 change 冲突: "+d)
				return
			}
			if _, ok := baseMap[d]; !ok {
				s.gameVersionRollback(verRoot, items, true)
				adminFail(w, http.StatusBadRequest, "delete 路径不在基底版本清单中: "+d)
				return
			}
			delSet[d] = true
		}
		// 合成：基底 − 删除 − 变更 ∪ 补丁条目（变更/新增以补丁为准）。
		// 继承条目的物理文件仍在基底版本目录——storage 路径必须继承基底行（防下载 404），
		// 仅补丁变更/新增条目落在本版本目录
		finalMap := make(map[string]gameUploadItem, len(baseFiles)+len(changeMap))
		for _, f := range baseFiles {
			if delSet[f.RelPath] {
				continue
			}
			if _, changed := changeMap[f.RelPath]; changed {
				continue
			}
			finalMap[f.RelPath] = gameUploadItem{relPath: f.RelPath, size: f.SizeBytes, sha: f.SHA256}
			storageOverride[f.RelPath] = f.StoragePath
		}
		for rel, it := range changeMap {
			finalMap[rel] = it
			storageOverride[rel] = "games/" + g.Slug + "/" + version + "/" + rel
		}
		if len(finalMap) == 0 {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "合成清单为空（基底文件被全部删除？）")
			return
		}
		finalItems = make([]gameUploadItem, 0, len(finalMap))
		var sumUp int64
		for _, it := range finalMap {
			finalItems = append(finalItems, it)
			sumUp += it.size
		}
		sort.Slice(finalItems, func(i, j int) bool { return finalItems[i].relPath < finalItems[j].relPath })
		if cap := s.cfg.Game.MaxUnpackSize; cap > 0 && sumUp > cap {
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "合成清单总大小超出上限（上限 "+strconv.FormatInt(cap>>20, 10)+"MB）")
			return
		}
		packSize = sumUp
		patchDelJSON = "[]"
		if len(pj.Delete) > 0 {
			if b, err := json.Marshal(pj.Delete); err == nil {
				patchDelJSON = string(b)
			}
		}
	}
	if finalItems == nil {
		finalItems = items
	}
	if packType == 3 { // 合成清单口径重算哈希行与总量（基底继承 + 补丁变更）
		hashLines = hashLines[:0]
		totalSize = 0
		for _, it := range finalItems {
			hashLines = append(hashLines, it.relPath+":"+strconv.FormatInt(it.size, 10)+":"+it.sha)
			totalSize += it.size
		}
	}
	sort.Strings(hashLines)
	mh := sha256.Sum256([]byte(strings.Join(hashLines, "\n")))
	manifestHash := hex.EncodeToString(mh[:])

	// 病毒扫描·同步模式（安全加固，clamav.sync=true）：登记前扫描本版本落位文件——检出即
	// 整版回滚拒绝（病毒文件不落库存，商户拿明确报错）；clamd 异常 fail-open 放行记日志
	// （扫描服务故障不阻断正常上架，人工审核兜底）。异步模式（默认）在登记成功后后台扫描
	if g.OwnerUsername != "" && s.cfg.ClamAV.Enabled && s.cfg.ClamAV.Sync {
		_, hits, serr := clamScanDir(s.cfg.ClamAV.Addr, verRoot, time.Duration(s.cfg.ClamAV.TimeoutSec)*time.Second)
		switch {
		case serr != nil:
			logger.Warn("病毒扫描服务异常（fail-open 放行）: 游戏=%s(%s) v%s, %v", g.Name, g.Slug, version, serr)
		case len(hits) > 0:
			s.gameVersionRollback(verRoot, items, true)
			adminFail(w, http.StatusBadRequest, "病毒扫描不通过：检出 "+hits[0].Sig+"（"+filepath.Base(hits[0].Path)+
				"），版本已回滚未上架（共检出 "+strconv.Itoa(len(hits))+" 处）")
			logger.Error("病毒扫描拦截版本上架: 游戏=%s(%s) v%s, 商户=%s, 检出 %d 处, 首个=%s（%s）",
				g.Name, g.Slug, version, operator, len(hits), filepath.Base(hits[0].Path), hits[0].Sig)
			return
		}
	}

	// 登记版本与清单（文件行已在合并循环中登记——此处仅版本行与冗余刷新）
	v := model.GameVersion{GameID: g.ID, Version: version, ManifestHash: manifestHash,
		SizeBytes: totalSize, FileCount: len(finalItems), Changelog: req.Changelog, MinReq: req.MinReq,
		PackType: packType, PackSize: packSize, BaseVersion: baseVer, PatchDelete: patchDelJSON}
	if err := store.DB.Create(&v).Error; err != nil {
		s.gameVersionRollback(verRoot, items, false)
		adminFail(w, http.StatusInternalServerError, "版本登记失败")
		return
	}
	fileRows := make([]model.GameFile, 0, len(finalItems))
	for _, it := range finalItems {
		storageRel := "games/" + g.Slug + "/" + version + "/" + it.relPath
		if so, inherited := storageOverride[it.relPath]; inherited { // 补丁继承条目：物理文件在基底版本目录
			storageRel = so
		}
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
		g.Name, g.Slug, version, len(items), totalSize, operator)
	// 病毒扫描·异步模式（安全加固，默认）：仅商户名下游戏 + clamav.enabled 时异步逐文件扫描
	// 本版本落位文件，不阻塞上架响应（大包扫描分钟级）；检出病毒自动驳回（audit=3 + remark
	// 携带签名），clamd 不可达 fail-open 仅记日志（人工审核兜底不变）。同步模式见上方登记前拦截
	if g.OwnerUsername != "" && s.cfg.ClamAV.Enabled && !s.cfg.ClamAV.Sync {
		go clamScanGameVersionAsync(g.ID, g.Name, g.Slug, version, verRoot)
	}
	adminJSON(w, map[string]interface{}{"version_id": v.ID, "version": version,
		"file_count": len(items), "size_bytes": totalSize, "manifest_hash": manifestHash,
		"pack_type": packType, "pack_size": packSize})
}

// merchantQuotaUsed 商户存储配额占用口径：名下全部游戏全部版本 size_bytes 之和
// （官方游戏 OwnerUsername 为空天然不参与；空库/无版本 COALESCE 兜底 0）
func merchantQuotaUsed(owner string) int64 {
	var used int64
	store.DB.Model(&model.GameVersion{}).
		Select("COALESCE(SUM(im_game_version.size_bytes), 0)").
		Joins("JOIN im_game ON im_game.id = im_game_version.game_id").
		Where("im_game.owner_username = ?", owner).
		Scan(&used)
	return used
}

// merchantQuotaLimit 商户存储配额解析归口（管理员后台分配支持）：商户行专属值优先——
// -1=不限 / >0=专属配额；0（未分配）或商户行缺失=跟随全局 game.merchant_quota_bytes
func (s *Server) merchantQuotaLimit(owner string) int64 {
	var mq int64
	if err := store.DB.Model(&model.Merchant{}).Select("storage_quota_bytes").
		Where("username = ?", owner).Scan(&mq).Error; err == nil && (mq == -1 || mq > 0) {
		return mq
	}
	return s.cfg.Game.MerchantQuotaBytes
}

// gameMerchantQuotaCheck 商户存储总量配额校验（版本登记预检/落位复检共用）：
// 已用 + 本次新增 > 配额即拒绝；quota=-1 不限。报错文案带已用/配额，商户可自助删旧版本腾额度
func (s *Server) gameMerchantQuotaCheck(owner string, incoming int64) error {
	quota := s.merchantQuotaLimit(owner)
	if quota == -1 {
		return nil
	}
	if quota <= 0 {
		quota = 50 << 30 // Load 已兜底，此处防御（直接 new Server 的测试路径）
	}
	used := merchantQuotaUsed(owner)
	if used+incoming > quota {
		return fmt.Errorf("商户存储总量超出配额：已用 %s + 本次 %s > 配额 %s（请先删除不需要的旧版本）",
			humanBytes(used), humanBytes(incoming), humanBytes(quota))
	}
	return nil
}

// humanBytes 字节数人性化文案（配额报错用）
func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2fGB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	default:
		return fmt.Sprintf("%dB", n)
	}
}

// gameSplitZipCheck 分卷 ZIP 命名校验：同目录、同前缀、`.zip.001` 起连续递增（7z/WinRAR 原生
// 分卷命名）。序号固定 3 位数字（超 999 卷不支持——50GB/100MB 单卷也远用不到）。
// 返回 nil 表示命名合法；否则返回可直接提示商户的错误
func gameSplitZipCheck(items []gameUploadItem) error {
	volRe := regexp.MustCompile(`^(.+)\.zip\.([0-9]{3})$`)
	var dir, prefix string
	start, prev := -1, -1
	for _, it := range items {
		base := it.relPath
		if i := strings.LastIndexByte(base, '/'); i >= 0 {
			base = base[i+1:]
			if dir == "" {
				dir = it.relPath[:i]
			} else if dir != it.relPath[:i] {
				return errors.New("分卷文件必须位于同一目录")
			}
		} else if dir != "" {
			return errors.New("分卷文件必须位于同一目录")
		}
		m := volRe.FindStringSubmatch(strings.ToLower(base))
		if m == nil {
			return errors.New("分卷命名非法: " + it.relPath + "（须为 前缀.zip.001 形式）")
		}
		if prefix == "" {
			prefix = m[1]
		} else if prefix != m[1] {
			return errors.New("分卷前缀不一致: " + it.relPath)
		}
		n, _ := strconv.Atoi(m[2])
		if start < 0 {
			if n != 1 {
				return errors.New("分卷必须从 .zip.001 开始: " + it.relPath)
			}
			start, prev = 1, 1
			continue
		}
		if n != prev+1 {
			return errors.New("分卷序号不连续（缺 " + fmt.Sprintf("%03d", prev+1) + " 卷）")
		}
		prev = n
	}
	return nil
}

// gameZipUnpackSize 单 ZIP 包解析：读 central directory 实算解压后总大小（防 ZIP 炸弹的
// 申报口径归服务端），并校验条目路径安全（绝对路径/盘符/父目录引用一律拒绝——Zip Slip 防线一）
func gameZipUnpackSize(zipPath string) (int64, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, err
	}
	defer zr.Close()
	var sum int64
	for _, zf := range zr.File {
		if zipEntryUnsafe(zf.Name) {
			return 0, errors.New("压缩包内含非法路径条目: " + zf.Name)
		}
		sum += int64(zf.UncompressedSize64)
	}
	return sum, nil
}

// zipEntryUnsafe ZIP 条目路径安检：拒绝绝对路径（/ 或 \\ 开头）、盘符/UNC（含冒号）、
// 路径段含 ..（解压可逃逸出目标目录）。Windows 反斜杠按分隔符归一处理
func zipEntryUnsafe(name string) bool {
	n := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(n, "/") || strings.Contains(n, ":") {
		return true
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// gamePatchUnpack 补丁包解包（pack_type=3 登记专用）：把 patch.zip 内游戏文件条目解压落位到
// verRoot 并流式复算 SHA256（不信任 zip 声明），返回 change 条目映射与 patch.json 字节。
// patch.json 为保留元数据名：不作为游戏文件登记/落 GameFile 行，但落盘保留供审计。
// 目录条目与空文件条目拒绝（补丁工具产出约定；服务端登记通道本就跳过空文件）。
// maxBytes：解压总量预检上限（解包前扫 central directory 拒绝，防 ZIP 炸弹先写满磁盘再被检查）
func gamePatchUnpack(zipPath, verRoot string, maxBytes int64) (map[string]gameUploadItem, []byte, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, nil, err
	}
	defer zr.Close()
	// ZIP 炸弹预检：central directory 声明的解压总量超限直接拒绝（写盘前拦截）
	var declared int64
	for _, zf := range zr.File {
		declared += int64(zf.UncompressedSize64)
	}
	if maxBytes > 0 && declared > maxBytes {
		return nil, nil, errors.New("补丁解压总量超出上限（上限 " + strconv.FormatInt(maxBytes>>20, 10) + "MB）")
	}
	out := make(map[string]gameUploadItem)
	var meta []byte
	for _, zf := range zr.File {
		if zf.Name == "patch.json" {
			rc, err := zf.Open()
			if err != nil {
				return nil, nil, err
			}
			meta, err = io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return nil, nil, err
			}
			continue
		}
		if strings.HasSuffix(zf.Name, "/") {
			return nil, nil, errors.New("补丁含目录条目: " + zf.Name)
		}
		if zipEntryUnsafe(zf.Name) {
			return nil, nil, errors.New("压缩包内含非法路径条目: " + zf.Name)
		}
		size := int64(zf.UncompressedSize64)
		if size <= 0 {
			return nil, nil, errors.New("补丁含空文件条目: " + zf.Name)
		}
		if _, dup := out[zf.Name]; dup {
			return nil, nil, errors.New("补丁含重复条目: " + zf.Name)
		}
		dst := filepath.Join(verRoot, filepath.FromSlash(zf.Name))
		abs, err := filepath.Abs(dst)
		if err != nil || !strings.HasPrefix(filepath.Clean(abs), filepath.Clean(verRoot)+string(os.PathSeparator)) {
			return nil, nil, errors.New("非法条目路径: " + zf.Name)
		}
		if err := os.MkdirAll(filepath.Dir(dst), os.ModePerm); err != nil {
			return nil, nil, errors.New("目录创建失败")
		}
		rc, err := zf.Open()
		if err != nil {
			return nil, nil, err
		}
		fout, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return nil, nil, errors.New("补丁文件落盘失败")
		}
		h := sha256.New()
		written, err := io.Copy(io.MultiWriter(fout, h), rc)
		fout.Close()
		rc.Close()
		if err != nil {
			return nil, nil, errors.New("补丁文件写入失败")
		}
		if written != size {
			return nil, nil, errors.New("补丁条目大小不符: " + zf.Name)
		}
		out[zf.Name] = gameUploadItem{relPath: zf.Name, size: size, sha: hex.EncodeToString(h.Sum(nil))}
	}
	if meta == nil {
		return nil, nil, errors.New("补丁缺少 patch.json 元数据")
	}
	if err := os.WriteFile(filepath.Join(verRoot, "patch.json"), meta, 0644); err != nil {
		return nil, nil, errors.New("patch.json 落盘失败")
	}
	return out, meta, nil
}

// gameVersionFilelistText 版本清单文本输出归口（商户/管理端清单导出共用）：
// 每文件一行 `0|rel_path|sha256|size`（rel_path 升序），附件下载
func (s *Server) gameVersionFilelistText(w http.ResponseWriter, v *model.GameVersion) {
	var files []model.GameFile
	store.DB.Where("version_id = ?", v.ID).Order("rel_path ASC").Find(&files)
	var b strings.Builder
	b.WriteString("# game version filelist: type|rel_path|sha256|size (version=" + v.Version + ")\n")
	for _, f := range files {
		b.WriteString("0|" + f.RelPath + "|" + f.SHA256 + "|" + strconv.FormatInt(f.SizeBytes, 10) + "\n")
	}
	// 下载文件名白名单归一：version 登记口径允许中文/引号等（gameVersionClean 仅禁路径字符），
	// 直接嵌入 Content-Disposition 会导致 Go 写 header 失败（非 ASCII）或文件名混乱（引号）——
	// 仅文件名归一，正文首行 version= 注释保留原值
	fn := strings.Map(func(r rune) rune {
		if r >= 0x80 || strings.ContainsRune("\"\\\r\n ;/", r) {
			return '_'
		}
		return r
	}, v.Version)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\"filelist-"+fn+".txt\"")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(b.String()))
}

// handleAdminGameToolDownload 管理端补丁工具下载（gameToolDownloadServe 公共核心，adminGuard 已在路由层）
func (s *Server) handleAdminGameToolDownload(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	gameToolDownloadServe(w, r)
}

// handleAdminVersionFilelist 管理端版本清单导出（自建游戏生成补丁的基准数据源）
func (s *Server) handleAdminVersionFilelist(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	vid, _ := strconv.ParseUint(r.PathValue("vid"), 10, 64)
	var v model.GameVersion
	if err := store.DB.First(&v, vid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本不存在")
		return
	}
	s.gameVersionFilelistText(w, &v)
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

// handleAdminGameVersionDelete 删除版本入口（管理端）：归属链路校验后走共享核心
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
	s.gameVersionDeleteCore(w, &v, &g, uploadOwnerFromCtx(r))
}

// gameVersionDeleteCore 版本删除共享核心（管理端/商户端同链路，商户侧前置归属校验）：
// 清清单行与版本行、删版本磁盘目录；被删版本为最新版时回退到剩余版本（无剩余则清空冗余）。
// 补丁基底保护：存在以本版本为 base 的补丁版本时拒绝删除——补丁合成清单的继承条目
// 物理文件在本版本目录，删掉会导致补丁版本全部继承文件下载 404（须先删依赖补丁）
func (s *Server) gameVersionDeleteCore(w http.ResponseWriter, v *model.GameVersion, g *model.Game, operator string) {
	// 与登记同一把分桶锁：防删除与落位中的版本目录交错（RemoveAll 扫到半成品目录）
	vlock := gameVersionLock(v.GameID)
	if !vlock.TryLock() {
		adminFail(w, http.StatusConflict, "该游戏有另一个版本登记/删除操作进行中，请稍后重试")
		return
	}
	defer vlock.Unlock()
	var patchCnt int64
	store.DB.Model(&model.GameVersion{}).Where("game_id = ? AND base_version = ?", v.GameID, v.Version).Count(&patchCnt)
	if patchCnt > 0 {
		adminFail(w, http.StatusConflict, "该版本是 "+strconv.FormatInt(patchCnt, 10)+" 个补丁版本的基底，请先删除依赖它的补丁版本（或改发全量包）")
		return
	}
	store.DB.Where("version_id = ?", v.ID).Delete(&model.GameFile{})
	store.DB.Delete(&v)
	os.RemoveAll(filepath.Join(s.cfg.Game.LocalDir, "games", g.Slug, v.Version))
	// 最新版冗余回退。BT·上传种子游戏不走版本体系（版本行只可能是历史误上架的孤儿数据），
	// 删除后冗余字段须回填种子重扫结果（latest_version=种子上传日期、size_bytes=种子总大小），
	// 而非按版本逻辑清空/置剩余版本号——否则 BT 清单版本号回退 "torrent" 占位且全部玩家
	// installed 与清单不一致，种子未变却被误标"待更新"触发一轮无意义重装
	if g.DownloadMethod == 2 {
		s.gameTorrentMetaFill(g, false) // 种子未换：latest_version 原值保留（含同日序号），仅重扫大小
		store.DB.Model(g).Updates(map[string]interface{}{"latest_version": g.LatestVersion, "size_bytes": g.SizeBytes})
	} else {
		var rest model.GameVersion
		if err := store.DB.Where("game_id = ?", g.ID).Order("id DESC").First(&rest).Error; err == nil {
			var total int64
			store.DB.Model(&model.GameFile{}).Select("COALESCE(SUM(size_bytes),0)").Where("version_id = ?", rest.ID).Scan(&total)
			store.DB.Model(g).Updates(map[string]interface{}{"latest_version": rest.Version, "size_bytes": total})
		} else {
			store.DB.Model(g).Updates(map[string]interface{}{"latest_version": "", "size_bytes": 0})
		}
	}
	logger.Info("游戏版本删除: %s v%s, 操作人=%s", g.Name, v.Version, operator)
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
		store.DB.Model(&model.Game{}).Where("id IN ? AND status = 0 AND audit_status IN ?", feat, []int8{model.GameAuditOfficial, model.GameAuditApproved}).Count(&cnt)
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
			store.DB.Model(&model.Game{}).Where("id IN ? AND status = 0 AND audit_status IN ?", ids, []int8{model.GameAuditOfficial, model.GameAuditApproved}).Count(&cnt)
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
