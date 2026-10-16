package server

// ===== 游戏中心（Steam 同款游戏浏览/下载，管理员自建游戏库，P1 全免费） =====
// 设计归口：
//   1. 元数据与文件清单落 MySQL（im_game / im_game_version / im_game_file / im_game_library），
//      文件本体落本地磁盘 game_data/games/<slug>/<version>/（cfg.Game.LocalDir，P1 本地盘；
//      storage 字段预留 P2 对象存储扩展）
//   2. 用户端：商店浏览/详情/加入库/清单拉取/分文件下载（http.ServeContent 原生 Range 断点续传）/
//      库状态上报/游玩时长上报；鉴权水位与 /upload/* / /api/kb 系列一致（username 查询参数）
//   3. 管理端（gameadmin.go）：游戏增删改查、分片上传游戏文件、版本上架登记、封面截图上传
//   4. 下载按文件 ID 归口：storage_path 服务端私有（json:"-" 绝不外泄），客户端仅凭清单内
//      文件 ID 逐个下载；库归属校验后才放行，防清单外枚举下载

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

// InitGame 游戏中心初始化：建表（惰性 AutoMigrate，与 Agent 任务表同模式）
func InitGame(cfg *config.Config) {
	if !cfg.Game.Enabled {
		return
	}
	// 逐表迁移：单表失败不再连坐其余表。原实现整批 AutoMigrate 一处报错即提前 return，
	// 实测生产库（MySQL 5.6）因 im_game_file 索引键超长只建成 im_game/im_game_version 两张表，
	// im_game_library 等 11 张表全部缺失 → 用户端 /api/game/library 返回 500「查询游戏库失败」，
	// 商店空态下也弹出该报错 toast。逐表迁移 + 按表记日志，失败面收窄且可直接定位到具体表。
	tables := []interface{}{&model.Game{}, &model.GameVersion{}, &model.GameFile{}, &model.GameLibrary{},
		&model.GameSave{}, &model.GameSaveFile{}, &model.GameSaveRev{}, &model.GameConfig{},
		&model.GameReview{}, &model.GameReviewLike{}, &model.GameReviewReply{}, &model.GameSection{}, &model.GameNotice{}}
	migrateFailed := false
	for _, t := range tables {
		if err := store.DB.AutoMigrate(t); err != nil {
			migrateFailed = true
			logger.Error("游戏中心表迁移失败(%T): %v", t, err)
		}
	}
	if migrateFailed {
		return
	}
	// 商店布局配置单行表种子（幂等：已存在则跳过；缺省全默认=Steam 布局+全区块开+无置顶）
	var cnt int64
	store.DB.Model(&model.GameConfig{}).Count(&cnt)
	if cnt == 0 {
		store.DB.Create(&model.GameConfig{ID: 1, Layout: "steam", Sections: "{}", Featured: "[]"})
	}
	logger.Info("游戏中心已启用，数据目录: %s", cfg.Game.LocalDir)
}

// gameEnabled 游戏中心开关归口（关闭时用户端与管理端接口统一拒绝）
func (s *Server) gameEnabled(w http.ResponseWriter) bool {
	if !s.cfg.Game.Enabled {
		adminFail(w, http.StatusForbidden, "游戏中心未启用")
		return false
	}
	return true
}

// gameUsername 用户侧接口身份解析归口（与 /upload/* 同水位：username 查询参数，缺失拒绝）
func gameUsername(w http.ResponseWriter, r *http.Request) (string, bool) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return "", false
	}
	return username, true
}

// gameStoreConfig 商店布局配置归口加载（单行表 im_game_config id=1）：
//   - layout/sections 缺失或字段非法时回退默认（steam 布局 + 全区块开），保证商店永远可渲染
//   - featured 置顶推荐按下发顺序返回游戏摘要，且仅保留上架游戏（下架/已删除的置顶项静默剔除，
//     商店不留死链——上架状态在管理端写入时校验，此处为运行期兜底）
func gameStoreConfig(viewer string) (string, map[string]bool, []map[string]interface{}) {
	layout := "steam"
	sections := map[string]bool{"carousel": true, "featured": true, "tagbar": true}
	featured := []map[string]interface{}{}
	var cfg model.GameConfig
	if err := store.DB.First(&cfg, 1).Error; err != nil {
		return layout, sections, featured
	}
	if cfg.Layout == "grid" {
		layout = "grid"
	}
	if cfg.Sections != "" {
		var raw map[string]bool
		if json.Unmarshal([]byte(cfg.Sections), &raw) == nil {
			for k := range sections {
				if v, ok := raw[k]; ok {
					sections[k] = v
				}
			}
		}
	}
	if cfg.Featured != "" {
		var ids []uint
		if json.Unmarshal([]byte(cfg.Featured), &ids) == nil && len(ids) > 0 {
			var games []model.Game
			store.DB.Where("id IN ? AND status = 0", ids).Find(&games)
			byID := map[uint]model.Game{}
			for _, g := range games {
				byID[g.ID] = g
			}
			// 评测聚合（轮播信息面板 Steam 同款摘要"特别好评 (N 篇评测)"；归口 helper 一条 GROUP BY）
			fids := make([]uint, 0, len(byID))
			for id := range byID {
				fids = append(fids, id)
			}
			revOf := gameReviewAggOf(fids)
			ownOf, playOf := friendSocialOf(viewer, fids)
			seen := map[uint]bool{}
			for _, id := range ids { // 按管理员指定的置顶顺序保序输出，去重兜底
				if g, ok := byID[id]; ok && !seen[id] {
					seen[id] = true
					item := gameSummary(g)
					if a, ok2 := revOf[g.ID]; ok2 {
						attachReviewSummary(item, a)
					}
					if fs, ok2 := ownOf[g.ID]; ok2 {
						item["friends_own"] = fs
					}
					if fs, ok2 := playOf[g.ID]; ok2 {
						item["friends_playing"] = fs
					}
					featured = append(featured, item)
				}
			}
		}
	}
	return layout, sections, featured
}

// HandleGameStoreConfig 商店布局配置下发（公开接口：未登录概略浏览亦可取，无敏感字段；
// username 查询参数可选——传了才随行下发"好友拥有"区块，未登录/未传零额外查询）
func (s *Server) HandleGameStoreConfig(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	viewer := strings.TrimSpace(r.URL.Query().Get("username"))
	layout, sections, featured := gameStoreConfig(viewer)
	adminJSON(w, map[string]interface{}{
		"layout":         layout,
		"sections":       sections,
		"featured_games": featured,
		// 自定义推荐区块（Steam 首页多区块同构：标题+样式+有序游戏，管理端配置）
		"store_sections": gameSectionList(viewer),
	})
}

// gameSectionStyles 商店自定义推荐区块展示样式枚举（key→管理端展示名；前端按样式分支渲染）
var gameSectionStyles = map[string]string{
	"promo":   "活动大图轮播（1 大图 + 2 小卡）",
	"capsule": "主图信息面板轮播（精选和推荐同款）",
	"row":     "横排卡片流",
	"grid":    "网格卡片",
	"list":    "榜单列表行",
}

// gameSectionList 自定义推荐区块下发归口：按 sort 升序加载区块，逐区块解析游戏摘要
// （保序、去重、仅保留上架游戏，下架/已删除静默剔除不留死链；全空区块不下发自动隐藏）
func gameSectionList(viewer string) []map[string]interface{} {
	list := []map[string]interface{}{}
	var secs []model.GameSection
	if err := store.DB.Order("sort ASC, id ASC").Find(&secs).Error; err != nil {
		return list
	}
	for _, sec := range secs {
		ids := []uint{}
		_ = json.Unmarshal([]byte(sec.Games), &ids)
		games := []map[string]interface{}{}
		if len(ids) > 0 {
			var gs []model.Game
			store.DB.Where("id IN ? AND status = 0", ids).Find(&gs)
			byID := map[uint]model.Game{}
			for _, g := range gs {
				byID[g.ID] = g
			}
			// 评测聚合随行下发（区块卡片悬停气泡"评测"行与商店列表同源；整区块一条 GROUP BY）
			gids := make([]uint, 0, len(byID))
			for id := range byID {
				gids = append(gids, id)
			}
			revOf := gameReviewAggOf(gids)
			ownOf, playOf := friendSocialOf(viewer, gids)
			seen := map[uint]bool{}
			for _, id := range ids {
				if g, ok := byID[id]; ok && !seen[id] {
					seen[id] = true
					item := gameSummary(g)
					if a, ok2 := revOf[g.ID]; ok2 {
						attachReviewSummary(item, a)
					}
					if fs, ok2 := ownOf[g.ID]; ok2 {
						item["friends_own"] = fs
					}
					if fs, ok2 := playOf[g.ID]; ok2 {
						item["friends_playing"] = fs
					}
					games = append(games, item)
				}
			}
		}
		if len(games) == 0 {
			continue
		}
		list = append(list, map[string]interface{}{
			"id": sec.ID, "title": sec.Title, "style": sec.Style, "games": games,
		})
	}
	return list
}

// gameSummary 游戏卡片摘要（列表/详情共用，零敏感字段）
func gameSummary(g model.Game) map[string]interface{} {
	shots := []string{}
	_ = json.Unmarshal([]byte(g.Screenshots), &shots)
	videos := []string{}
	_ = json.Unmarshal([]byte(g.Videos), &videos)
	tags := []string{}
	if g.Tags != "" {
		// 兼容英文逗号与中文顿号分隔（管理端录入存在两种格式），拆分为独立标签
		for _, t := range strings.FieldsFunc(g.Tags, func(r rune) bool { return r == ',' || r == '、' }) {
			if t = strings.TrimSpace(t); t != "" {
				tags = append(tags, t)
			}
		}
	}
	return map[string]interface{}{
		"id":             g.ID,
		"slug":           g.Slug,
		"name":           g.Name,
		"short_desc":     g.ShortDesc,
		"cover":          g.Cover,
		"banner":         g.Banner,
		"screenshots":    shots,
		"videos":         videos,
		"tags":           tags,
		"developer":      g.Developer,
		"publisher":      g.Publisher,
		"size_bytes":     g.SizeBytes,
		"latest_version": g.LatestVersion,
		"price":          g.Price,
		// 下载方式（0=HTTP 清单直连[默认] 1=BT/P2SP 混合）——PC 客户端按此选下载通道
		"download_method": g.DownloadMethod,
		"down_count":      g.DownCount,
		"sort":            g.Sort,
		// 默认启动程序（管理端上架时配置）：launch_exe 相对安装根的相对路径、launch_name 显示名、
		// launch_args 参数模板（含 {0}=登录账号 {1}=账号专属16位密码 占位符，仅模板不含密钥）
		"launch_exe":  g.LaunchExe,
		"launch_name": g.LaunchName,
		"launch_args": g.LaunchArgs,
		// 功能二期：联机端口登记（逗号分隔串原样下发，客户端自行解析；建房选游戏自动预填 +
		// 开局实测发现新端口自动累加，管理端手工登记为准）
		"online_ports_tcp": g.OnlinePortsTCP,
		"online_ports_udp": g.OnlinePortsUDP,
		// 云存档采集/排除路径（原始 JSON 数组串直接下发，客户端自行解析；非敏感字段）
		"save_paths":   g.SavePaths,
		"save_exclude": g.SaveExclude,
		// 上架时间（商店悬停气泡卡"发行于"行；RFC3339 由前端本地化格式）
		"create_time": g.CreateTime,
	}
}

// gameLaunchPassword 按"账号+游戏"确定性派生16位专属密码
// （HMAC-SHA256(secret, "im-game-launch:<username>:<gameID>")）：
// 同账号同游戏恒定、不同账号/不同游戏不同（单游戏泄露不影响其他游戏）；
// 作为启动参数 {1} 占位符的值下发给本人，仅本人在库游戏中可得。
// 与真实登录密码无关（真实密码绝不下发/绝不出现在启动参数），降低明文命令行的隐私风险
func gameLaunchPassword(secret, username string, gameID uint) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("im-game-launch:" + username + ":" + strconv.FormatUint(uint64(gameID), 10)))
	sum := mac.Sum(nil)
	var b strings.Builder
	b.Grow(16)
	for i := 0; i < 16; i++ {
		b.WriteByte(byte('0' + sum[i]%10))
	}
	return b.String()
}

// ===== 好友正在玩（Steam 同款"N 名好友正在玩"） =====
// 内存 presence 归口：username → 正在运行的 gameID 集合（值为最近一次心跳时刻）。
// 写入：客户端 /api/game/play/{id} action=start 记入并在运行期间周期心跳续期，action=end 摘除；
// 用户全部连接断开时 unregister 归口清理（下线即摘，不留幽灵"在线游戏"态）。
// 读取：按 gamePlayingTTL 新鲜度过滤——客户端崩溃/异常退出（心跳停止）3 个周期后自动收敛
var (
	gamePlayMu  sync.RWMutex
	gamePlaying = map[string]map[uint]time.Time{}
)

const gamePlayingTTL = 180 * time.Second // 心跳周期 60s，超 3 个周期未续期即判定为残留

// gamePresenceStart 记入/续期"正在玩"（同账号同游戏重复上报幂等，仅刷新心跳时刻）
func gamePresenceStart(username string, gid uint) {
	if username == "" || gid == 0 {
		return
	}
	gamePlayMu.Lock()
	set := gamePlaying[username]
	if set == nil {
		set = map[uint]time.Time{}
		gamePlaying[username] = set
	}
	set[gid] = time.Now()
	gamePlayMu.Unlock()
}

// gamePresenceEnd 摘除单款游戏的"正在玩"（同账号多款并行时仅移除本款；集合空即删账号键）
func gamePresenceEnd(username string, gid uint) {
	if username == "" {
		return
	}
	gamePlayMu.Lock()
	if set := gamePlaying[username]; set != nil {
		delete(set, gid)
		if len(set) == 0 {
			delete(gamePlaying, username)
		}
	}
	gamePlayMu.Unlock()
}

// gamePresenceClear 账号整体摘除（最后一条连接断开时归口调用）
func gamePresenceClear(username string) {
	if username == "" {
		return
	}
	gamePlayMu.Lock()
	delete(gamePlaying, username)
	gamePlayMu.Unlock()
}

// gamePlayingUsers 仍在新鲜窗口内、正在运行指定游戏的账号（读侧过滤残留；非好友过滤在调用方）
func gamePlayingUsers(gid uint) []string {
	deadline := time.Now().Add(-gamePlayingTTL)
	gamePlayMu.RLock()
	defer gamePlayMu.RUnlock()
	out := make([]string, 0, 4)
	for un, set := range gamePlaying {
		if t, ok := set[gid]; ok && t.After(deadline) {
			out = append(out, un)
		}
	}
	return out
}

// RegisterGameRoutes 游戏中心路由注册（用户端 + 管理端归口一次挂载）
func RegisterGameRoutes(s *Server) {
	// 用户端（商店/库/下载）
	http.HandleFunc("GET /api/game/config", s.HandleGameStoreConfig) // 字面量段与 /api/game/{id} 交叉时字面量优先（Go 1.22 ServeMux 规则），无两可冲突
	http.HandleFunc("GET /api/game/list", s.HandleGameList)
	http.HandleFunc("GET /api/game/library", s.HandleGameLibrary)
	http.HandleFunc("POST /api/game/library/{id}", s.HandleGameLibraryJoin)
	http.HandleFunc("PUT /api/game/library/{id}/state", s.HandleGameLibraryState)
	http.HandleFunc("DELETE /api/game/library/{id}", s.HandleGameLibraryLeave)
	http.HandleFunc("GET /api/game/{id}", s.HandleGameDetail)
	// 注意：不可写成 /api/game/{id}/manifest——与 /api/game/file/{fid} 在 ServeMux 中
	// 产生 /api/game/file/manifest 两可匹配冲突（Go 1.22 启动即 panic），故归口为前缀式路由
	http.HandleFunc("GET /api/game/manifest/{id}", s.HandleGameManifest)
	// 方案 A 一期：BT/P2SP 混合下载——版本种子下发（生成+磁盘缓存，与 manifest 同水位鉴权）
	http.HandleFunc("GET /api/game/torrent/{id}", s.HandleGameTorrent)
	// P2SP 直链源：字面量前缀式路由（/api/game/p2sp 与 {id} 交叉时字面量优先，无两可冲突）；
	// 鉴权走路径段（引擎把追加路径拼在 query 之后，query 鉴权必坏）；{rest...} 吞 <slug>/<rel...>
	http.HandleFunc("GET /api/game/p2sp/{username}/{gid}/{version}/{rest...}", s.HandleGameP2SP)
	http.HandleFunc("GET /api/game/file/{fid}", s.HandleGameFileDownload)
	// 同理用字面量前缀式：/api/game/{id}/play 会与 /api/game/library/{id} 在
	// /api/game/library/play 路径上两可冲突（Go 1.22 启动即 panic）
	http.HandleFunc("POST /api/game/play/{id}", s.HandleGamePlay)
	// P2 商店化：积分余额 + Steam 同款评测。路由形态沿用项目踩坑先例（见下方 manifest/play
	// 注释）：评测一律用字面量前缀式 /api/game/review[s]/...，绝不写 /api/game/{id}/reviews——
	// 那会与 /api/game/file/{fid}、/api/game/library/{id}、/api/game/play/{id} 在
	// /api/game/file/reviews 等路径两可匹配（Go 1.22 启动即 panic）
	http.HandleFunc("GET /api/game/points", s.HandleGamePoints) // 字面量段与 /{id} 交叉时字面量优先
	http.HandleFunc("GET /api/game/me", s.HandleGameMe)         // 游戏中心标题栏账号区（头像/昵称；字面量段精确优先同 points 先例）
	http.HandleFunc("GET /api/game/reviews/{id}", s.HandleGameReviews)
	http.HandleFunc("POST /api/game/review/{id}", s.HandleGameReviewUpsert)
	http.HandleFunc("DELETE /api/game/review/{id}", s.HandleGameReviewDelete)
	// 字面量 /helpful 比通配 /{id} 更具体，Go 1.22 精确优先无冲突
	http.HandleFunc("POST /api/game/review/helpful", s.HandleGameReviewHelpful)
	// 评测回复三接口：字面量段精确优先于 {id}（helpful 同款先例），DELETE /reply/{rid} 5 段
	// 与 DELETE /api/game/review/{id}（4 段）长度不同无冲突
	http.HandleFunc("GET /api/game/review/replies", s.HandleGameReviewReplies)
	http.HandleFunc("POST /api/game/review/reply", s.HandleGameReviewReplyUpsert)
	http.HandleFunc("DELETE /api/game/review/reply/{rid}", s.HandleGameReviewReplyDelete)
	// 云存档（Steam 同款 P1 单设备闭环，server/gamesave.go 归口）：一律字面量前缀式 5 段路由
	// （第 3 段固定字面量 save，与现有 config/list/library/manifest/file/play/reviews/review 均不冲突；
	// 第 4 段再固定 manifest/file/finalize/download/data 字面量，绝无两可匹配——Go 1.22 启动不 panic）
	http.HandleFunc("GET /api/game/save/manifest/{id}", s.HandleGameSaveManifest)
	http.HandleFunc("POST /api/game/save/file/{id}", s.HandleGameSaveFileUpload)
	http.HandleFunc("POST /api/game/save/finalize/{id}", s.HandleGameSaveFinalize)
	http.HandleFunc("GET /api/game/save/download/{fid}", s.HandleGameSaveDownload)
	http.HandleFunc("DELETE /api/game/save/data/{id}", s.HandleGameSaveDelete)
	// 阶段二百九十：云存档 P2（版本保留 + 历史）与 P3（多槽位）用户端路由
	http.HandleFunc("GET /api/game/save/history/{id}", s.HandleGameSaveHistory)
	http.HandleFunc("POST /api/game/save/rollback/{id}", s.HandleGameSaveRollback)
	http.HandleFunc("GET /api/game/save/slots/{id}", s.HandleGameSaveSlots)
	// 管理端（上架/版本/分片上传）
	registerGameAdminRoutes(s)
}

// HandleGameList 商店列表：仅上架游戏，keyword 命中名称/简介，tag 精确命中标签串
func (s *Server) HandleGameList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 60 {
		size = 24
	}
	db := store.DB.Model(&model.Game{}).Where("status = ?", 0)
	if kw := strings.TrimSpace(q.Get("keyword")); kw != "" {
		like := "%" + kw + "%"
		db = db.Where("name LIKE ? OR short_desc LIKE ?", like, like)
	}
	if tag := strings.TrimSpace(q.Get("tag")); tag != "" {
		db = db.Where("tags LIKE ?", "%"+tag+"%")
	}
	var total int64
	db.Count(&total)
	var games []model.Game
	if err := db.Order("sort ASC, id DESC").Offset((page - 1) * size).Limit(size).Find(&games).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询游戏列表失败")
		return
	}
	// 用户已入库状态随行下发（未传 username 概略浏览则缺省）
	viewer := strings.TrimSpace(q.Get("username"))
	libState := map[uint]int8{}
	if viewer != "" {
		var libs []model.GameLibrary
		store.DB.Where("username = ?", viewer).Find(&libs)
		for _, l := range libs {
			libState[l.GameID] = l.State
		}
	}
	// 评测聚合随行下发（商店悬停气泡卡"评测"行 Steam 同款摘要；一条 GROUP BY 归口仅查本页游戏）
	gids := make([]uint, 0, len(games))
	for _, g := range games {
		gids = append(gids, g.ID)
	}
	revOf := gameReviewAggOf(gids)
	ownOf, playOf := friendSocialOf(viewer, gids) // 好友拥有/正在玩（气泡"N 位好友拥有""N 名好友正在玩"；viewer 为空返回空表零开销）
	list := make([]map[string]interface{}, 0, len(games))
	for _, g := range games {
		item := gameSummary(g)
		// 未入库不下发 in_library（前端约定 undefined=未入库：商店卡片不挂徽标、详情渲染购买块；
		// 入库后值为库状态 0-4，0=正常在库即"已入库"徽标）
		if st, ok := libState[g.ID]; ok {
			item["in_library"] = st
		}
		if a, ok := revOf[g.ID]; ok {
			attachReviewSummary(item, a)
		}
		if fs, ok := ownOf[g.ID]; ok {
			item["friends_own"] = fs
		}
		if fs, ok := playOf[g.ID]; ok {
			item["friends_playing"] = fs
		}
		list = append(list, item)
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}

// HandleGameDetail 游戏详情：元数据 + 版本列表（上架游戏；下架后已入库用户仍可看详情下载）
func (s *Server) HandleGameDetail(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	// 下架游戏仅对已入库用户可见（商店下架语义；未入库访问按不存在处理防枚举）
	if g.Status != 0 {
		var cnt int64
		store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, g.ID).Count(&cnt)
		if cnt == 0 {
			adminFail(w, http.StatusNotFound, "游戏不存在")
			return
		}
	}
	var versions []model.GameVersion
	store.DB.Where("game_id = ?", g.ID).Order("id DESC").Find(&versions)
	verList := make([]map[string]interface{}, 0, len(versions))
	for _, v := range versions {
		verList = append(verList, map[string]interface{}{
			"id": v.ID, "version": v.Version, "size_bytes": v.SizeBytes,
			"file_count": v.FileCount, "changelog": v.Changelog, "min_req": v.MinReq,
			"create_time": v.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	item := gameSummary(g)
	// 好友正在玩（Steam 同款详情页"N 名好友正在玩"；仅本款一条归口查询）
	if _, playOf := friendSocialOf(username, []uint{g.ID}); len(playOf) > 0 {
		item["friends_playing"] = playOf[g.ID]
	}
	item["description"] = g.Description
	item["versions"] = verList
	// 启动参数 {1} 占位符专属密码（按请求者账号+本游戏确定性派生，仅本人可得；真实登录密码不下发）
	item["launch_password"] = gameLaunchPassword(s.cfg.Game.LaunchSecret, username, g.ID)
	// 游戏公告（库内游戏页"动态"区左栏公告卡；管理端发布，倒序；images 解析为数组下发）
	var notices []model.GameNotice
	store.DB.Where("game_id = ?", g.ID).Order("id DESC").Find(&notices)
	noticeList := make([]map[string]interface{}, 0, len(notices))
	for _, n := range notices {
		imgs := []string{}
		if strings.TrimSpace(n.Images) != "" {
			_ = json.Unmarshal([]byte(n.Images), &imgs)
		}
		noticeList = append(noticeList, map[string]interface{}{
			"id": n.ID, "title": n.Title, "content": n.Content,
			"images": imgs, "cover": n.Cover, "layout": n.Layout,
			"create_time": n.CreateTime.Format("2006-01-02 15:04"),
		})
	}
	item["notices"] = noticeList
	// 个人库状态（未入库不下发 in_library：前端以 undefined/null=未入库渲染 Steam 同款购买块，
	// 入库后值为库状态 0-4，0=正常在库渲染安装/启动按钮组）
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, g.ID).First(&lib).Error; err == nil {
		item["in_library"] = lib.State
		item["lib"] = map[string]interface{}{
			"state":             lib.State,
			"installed_version": lib.InstalledVersion,
			"install_path":      lib.InstallPath,
			"play_seconds":      lib.PlaySeconds,
		}
	}
	adminJSON(w, item)
}

// HandleGameLibrary 我的游戏库：入库条目 + 游戏摘要（下架游戏在库内照常展示）
func (s *Server) HandleGameLibrary(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	var libs []model.GameLibrary
	if err := store.DB.Where("username = ?", username).Order("update_time DESC, id DESC").Find(&libs).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询游戏库失败")
		return
	}
	ids := make([]uint, 0, len(libs))
	for _, l := range libs {
		ids = append(ids, l.GameID)
	}
	gameByID := map[uint]model.Game{}
	if len(ids) > 0 {
		var games []model.Game
		store.DB.Where("id IN ?", ids).Find(&games)
		for _, g := range games {
			gameByID[g.ID] = g
		}
	}
	list := make([]map[string]interface{}, 0, len(libs))
	// 好友正在玩（Steam 同款库卡片标记）：本批一次归口（好友集/用户资料各一条 SQL），仅命中游戏下发
	_, playOf := friendSocialOf(username, ids)
	for _, l := range libs {
		g, ok := gameByID[l.GameID]
		if !ok {
			continue // 游戏被彻底删除的孤儿条目跳过（管理端删除时已级联清行，此处兜底）
		}
		gm := gameSummary(g)
		if fs, ok := playOf[l.GameID]; ok {
			gm["friends_playing"] = fs
		}
		list = append(list, map[string]interface{}{
			"lib": map[string]interface{}{
				"game_id":           l.GameID,
				"state":             l.State,
				"installed_version": l.InstalledVersion,
				"install_path":      l.InstallPath,
				"play_seconds":      l.PlaySeconds,
				"last_play_at":      l.LastPlayAt.Format("2006-01-02 15:04"),
				// 启动参数 {1} 专属密码（按当前账号+本游戏派生；真实登录密码不下发）
				"launch_password": gameLaunchPassword(s.cfg.Game.LaunchSecret, username, l.GameID),
			},
			"game": gm,
		})
	}
	adminJSON(w, map[string]interface{}{"list": list})
}

// HandleGameLibraryJoin 加入游戏库（P2 商店化 Steam 同款购买流）：
// 免费（price=0）直接入库；收费（price>0）严格扣除积分入库（共用 AI 积分钱包，
// 余额不足整体失败不钳零，区别于 AI 问答的钳零语义）；已入库幂等返回不重复扣分。
// 实付金额快照落库（pay_price），移出库按实付全额退还（game_refund 流水）
func (s *Server) HandleGameLibraryJoin(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	if g.Status != 0 {
		adminFail(w, http.StatusForbidden, "游戏已下架")
		return
	}
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, g.ID).First(&lib).Error; err != nil {
		// 收费游戏先严格扣分再入库（扣分失败整体失败，库条目不落库）
		pay := aiPointsRound3(g.Price)
		if pay > 0 {
			// 先查余额给出可读错误（区分用户不存在与余额不足）
			balance, err := userPoints(username)
			if err != nil {
				adminFail(w, http.StatusInternalServerError, "积分查询失败")
				return
			}
			if balance < pay {
				adminFail(w, http.StatusBadRequest, fmt.Sprintf("积分不足（余额 %.3f，需 %.3f），请联系管理员发放", balance, pay))
				return
			}
			// 严格原子扣分：WHERE points >= pay 保证并发下不透支（失败即余额不足）
			res := store.DB.Model(&model.User{}).
				Where("username = ? AND points >= ?", username, pay).
				Update("points", gorm.Expr("ROUND(points - ?, 3)", pay))
			if res.Error != nil {
				adminFail(w, http.StatusInternalServerError, "积分扣除失败")
				return
			}
			if res.RowsAffected == 0 {
				adminFail(w, http.StatusBadRequest, "积分不足，请联系管理员发放")
				return
			}
			after, _ := userPoints(username)
			recordPointsLog(username, -pay, after, "game_purchase", "system", "获取游戏: "+g.Name)
		}
		lib = model.GameLibrary{Username: username, GameID: g.ID, State: 0, PayPrice: pay}
		if err := store.DB.Create(&lib).Error; err != nil {
			// 入库落库失败回滚扣分（尽力补偿，失败仅记日志人工对账）
			if pay > 0 {
				if res := store.DB.Model(&model.User{}).Where("username = ?", username).
					Update("points", gorm.Expr("ROUND(points + ?, 3)", pay)); res.Error == nil {
					after, _ := userPoints(username)
					recordPointsLog(username, pay, after, "game_refund", "system", "入库失败自动退还: "+g.Name)
				}
			}
			adminFail(w, http.StatusInternalServerError, "加入游戏库失败")
			return
		}
		// 下载计数（仅首次入库计一次，重复加入幂等不重复计）
		store.DB.Model(&model.Game{}).Where("id = ?", g.ID).UpdateColumn("down_count", g.DownCount+1)
	}
	balance, _ := userPoints(username)
	manifest, err := s.gameManifest(&g, "")
	if err != nil {
		adminFail(w, http.StatusNotFound, "该游戏暂无可下载版本")
		return
	}
	adminJSON(w, map[string]interface{}{"lib_id": lib.ID, "state": lib.State, "manifest": manifest, "balance": aiPointsRound3(balance)})
}

// HandleGameLibraryState 库状态上报：客户端下载器暂停/续传/完成/发现待更新时归口落库
func (s *Server) HandleGameLibraryState(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var req struct {
		State            int8   `json:"state"`
		InstalledVersion string `json:"installed_version"`
		InstallPath      string `json:"install_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if req.State < 0 || req.State > 4 {
		adminFail(w, http.StatusBadRequest, "状态非法")
		return
	}
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, id).First(&lib).Error; err != nil {
		adminFail(w, http.StatusNotFound, "该游戏不在你的库中")
		return
	}
	updates := map[string]interface{}{"state": req.State}
	if req.InstalledVersion != "" {
		updates["installed_version"] = req.InstalledVersion
	}
	if req.InstallPath != "" {
		updates["install_path"] = req.InstallPath
	}
	if err := store.DB.Model(&lib).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "状态保存失败")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleGameLibraryLeave 移出游戏库（本地安装目录清理由客户端负责，服务端仅清归属条目）：
// 收费游戏按入库实付快照（pay_price）全额退还积分（game_refund 流水），防误操作损失；
// 已安装态不可移出（上游校验保留），退款仅在条目删除成功后执行
func (s *Server) HandleGameLibraryLeave(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, id).First(&lib).Error; err != nil {
		adminFail(w, http.StatusNotFound, "该游戏不在你的库中")
		return
	}
	if err := store.DB.Delete(&lib).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "移出失败")
		return
	}
	pay := aiPointsRound3(lib.PayPrice)
	if pay > 0 {
		res := store.DB.Model(&model.User{}).Where("username = ?", username).
			Update("points", gorm.Expr("ROUND(points + ?, 3)", pay))
		if res.Error == nil {
			after, _ := userPoints(username)
			recordPointsLog(username, pay, after, "game_refund", "system", "移出游戏库退还: 游戏#"+strconv.FormatUint(id, 10))
		} else {
			logger.Error("移出库退款失败（用户 %s，应退 %.3f）：%v", username, pay, res.Error)
		}
	}
	balance, _ := userPoints(username)
	adminJSON(w, map[string]interface{}{"ok": true, "balance": aiPointsRound3(balance)})
}

// gameManifest 版本清单构建（version 空=最新版）：文件 ID/相对路径/大小/SHA256/下载地址归口下发
func (s *Server) gameManifest(g *model.Game, version string) (map[string]interface{}, error) {
	// 下载方式=2（管理员上传种子）：合成清单——文件清单不下发（完整性由 BT 分片校验承担），
	// slug 取种子内 info.name（安装锚点必须与引擎落盘根一致，否则 exe 探测/启动错位），
	// 版本沿用最新版本号（未上架过版本用占位 "torrent"），size/file_count 取种子内统计；
	// torrent_kind="uploaded" 供客户端识别（纯 BT，不叠加 P2SP 直链源）
	if g.DownloadMethod == 2 {
		anchor, total, count, err := s.gameUploadedTorrentMeta(g)
		if err != nil {
			return nil, err
		}
		ver := "torrent"
		var v model.GameVersion
		if err := store.DB.Where("game_id = ?", g.ID).Order("id DESC").First(&v).Error; err == nil && v.Version != "" {
			ver = v.Version
		}
		return map[string]interface{}{
			"game_id": g.ID, "slug": anchor, "name": g.Name,
			"version": ver, "manifest_hash": "uploaded",
			"size_bytes": total, "file_count": count,
			"files":        []map[string]interface{}{},
			"torrent_kind": "uploaded",
		}, nil
	}
	var v model.GameVersion
	var err error
	if version == "" {
		err = store.DB.Where("game_id = ?", g.ID).Order("id DESC").First(&v).Error
	} else {
		err = store.DB.Where("game_id = ? AND version = ?", g.ID, version).First(&v).Error
	}
	if err != nil {
		return nil, errVersionNotFound
	}
	var files []model.GameFile
	if err := store.DB.Where("version_id = ?", v.ID).Order("rel_path ASC").Find(&files).Error; err != nil {
		return nil, errVersionNotFound
	}
	list := make([]map[string]interface{}, 0, len(files))
	for _, f := range files {
		list = append(list, map[string]interface{}{
			"id":       f.ID,
			"rel_path": f.RelPath,
			"size":     f.SizeBytes,
			"sha256":   f.SHA256,
			"url":      "/api/game/file/" + strconv.FormatUint(uint64(f.ID), 10),
		})
	}
	return map[string]interface{}{
		"game_id": g.ID, "slug": g.Slug, "name": g.Name,
		"version": v.Version, "manifest_hash": v.ManifestHash,
		"size_bytes": v.SizeBytes, "file_count": v.FileCount,
		"files": list,
	}, nil
}

// errVersionNotFound 版本不存在哨兵（清单构建归口复用）
var errVersionNotFound = errGame("该游戏暂无可下载版本")

// errGame 业务错误类型（errors.New 语义等价，独立命名便于清单链路识别）
type errGame string

func (e errGame) Error() string { return string(e) }

// HandleGameManifest 版本清单拉取：加入库后按版本（默认最新）获取文件清单开始下载；
// 待更新场景客户端传旧版本比对清单增量
func (s *Server) HandleGameManifest(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, id).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusForbidden, "请先将游戏加入库")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	manifest, err := s.gameManifest(&g, strings.TrimSpace(r.URL.Query().Get("version")))
	if err != nil {
		adminFail(w, http.StatusNotFound, "该游戏暂无可下载版本")
		return
	}
	adminJSON(w, manifest)
}

// HandleGameFileDownload 游戏文件下载：库归属校验 → 本地磁盘流式下发（http.ServeContent
// 原生支持 Range 断点续传与 HEAD），文件名不落响应头——客户端按清单 rel_path 落盘
func (s *Server) HandleGameFileDownload(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	fid, _ := strconv.ParseUint(r.PathValue("fid"), 10, 64)
	var f model.GameFile
	if err := store.DB.First(&f, fid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "文件不存在")
		return
	}
	var v model.GameVersion
	if err := store.DB.First(&v, f.VersionID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "文件不存在")
		return
	}
	// 库归属校验：仅加入库的用户可下载该游戏文件（防清单外枚举直拉）
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", username, v.GameID).Count(&cnt)
	if cnt == 0 {
		adminFail(w, http.StatusForbidden, "请先将游戏加入库")
		return
	}
	// storage_path 服务端私有：路径穿越已在上架归口清洗，此处按根目录拼接后二次校验兜底
	abs := filepath.Join(s.cfg.Game.LocalDir, filepath.FromSlash(f.StoragePath))
	root := filepath.Clean(s.cfg.Game.LocalDir)
	if !strings.HasPrefix(filepath.Clean(abs), root+string(os.PathSeparator)) {
		adminFail(w, http.StatusForbidden, "非法文件路径")
		return
	}
	fp, err := os.Open(abs)
	if err != nil {
		adminFail(w, http.StatusNotFound, "文件已丢失，请联系管理员重新上架")
		return
	}
	defer fp.Close()
	st, err := fp.Stat()
	if err != nil {
		adminFail(w, http.StatusNotFound, "文件已丢失，请联系管理员重新上架")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", st.ModTime(), fp)
}

// HandleGamePlay 游玩时长上报：start 记开始（服务端归口打点），end 累加时长
// （seconds 客户端自报的本次会话秒数，单次上限 24h 防异常值污染统计）
func (s *Server) HandleGamePlay(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var req struct {
		Action  string `json:"action"`
		Seconds int64  `json:"seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, id).First(&lib).Error; err != nil {
		adminFail(w, http.StatusNotFound, "该游戏不在你的库中")
		return
	}
	updates := map[string]interface{}{"last_play_at": store.DB.NowFunc()}
	switch req.Action {
	case "end":
		if req.Seconds > 0 && req.Seconds <= 86400 {
			updates["play_seconds"] = lib.PlaySeconds + req.Seconds
		}
		gamePresenceEnd(username, uint(id)) // 退出即摘除"好友正在玩"标记（读侧另按心跳新鲜度兜底）
	case "start":
		// 开始游玩仅刷新最近游玩时间；同时记入/续期"正在玩"presence（客户端运行期间周期心跳复用本动作）
		gamePresenceStart(username, uint(id))
	default:
		adminFail(w, http.StatusBadRequest, "action 须为 start/end")
		return
	}
	store.DB.Model(&lib).Updates(updates)
	adminJSON(w, map[string]interface{}{"ok": true, "play_seconds": lib.PlaySeconds})
}

// ===== P2 商店化：积分余额 + Steam 同款评测 =====

// HandleGamePoints 当前积分余额（商店购买块/确认弹窗显示；共用 AI 积分钱包）
func (s *Server) HandleGamePoints(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	balance, err := userPoints(username)
	if err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	adminJSON(w, map[string]interface{}{"balance": aiPointsRound3(balance)})
}

// HandleGameMe 游戏中心当前用户资料（标题栏账号区头像/昵称显示归口；username 查询参数鉴权
// 与 /api/game/* 同水位；昵称优先回退账号；已注销号按不存在拒绝）
func (s *Server) HandleGameMe(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	un, ok := gameUsername(w, r)
	if !ok {
		return
	}
	var u model.User
	if err := store.DB.Select("username, avatar, nickname").
		Where("username = ? AND status != ?", un, 2).First(&u).Error; err != nil {
		adminFail(w, http.StatusNotFound, "用户不存在")
		return
	}
	name := u.Nickname
	if name == "" {
		name = u.Username
	}
	adminJSON(w, map[string]interface{}{"username": u.Username, "avatar": u.Avatar, "nickname": name})
}

// gameReviewSummaryText Steam 同款好评率文案（正评占比分级，评测总数为 0 时返回空串）
func gameReviewSummaryText(total, positive int64) string {
	if total <= 0 {
		return ""
	}
	rate := float64(positive) / float64(total)
	switch {
	case rate >= 0.8:
		return "特别好评"
	case rate >= 0.7:
		return "多半好评"
	case rate >= 0.4:
		return "褒贬不一"
	default:
		return "差评居多"
	}
}

// revAgg 评测聚合行（悬停气泡卡/轮播信息面板/推荐区块摘要共用）
type revAgg struct {
	GameID   uint
	Total    int64
	Positive int64
}

// gameReviewAggOf 一条 GROUP BY 批量聚合多游戏评测总数与正评数（悬停气泡卡/轮播/区块共用归口，
// 空入参返回空表；严禁逐游戏 N 次查询）
func gameReviewAggOf(gids []uint) map[uint]revAgg {
	revOf := map[uint]revAgg{}
	if len(gids) == 0 {
		return revOf
	}
	var aggs []revAgg
	store.DB.Model(&model.GameReview{}).
		Select("game_id, COUNT(*) AS total, SUM(recommended = 1) AS positive").
		Where("game_id IN ?", gids).
		Group("game_id").Scan(&aggs)
	for _, a := range aggs {
		revOf[a.GameID] = a
	}
	return revOf
}

// attachReviewSummary 评测聚合三键写入列表项（与详情页/轮播摘要文案同源）
func attachReviewSummary(item map[string]interface{}, a revAgg) {
	item["review_total"] = a.Total
	item["review_positive"] = a.Positive
	item["review_summary"] = gameReviewSummaryText(a.Total, a.Positive)
}

// friendSocialOf 好友"拥有 / 正在玩"归口（Steam 同款气泡"N 位好友拥有""N 名好友正在玩"）：
// viewer 好友集 → 游戏库归属 + 内存 presence 命中 → 头像/昵称，固定 3 条 SQL 归口
// （严禁逐游戏/逐好友 N 次查询；presence 为内存读取零 SQL）；
// 隐私口径：仅展示查看者自己的好友，零越权关系链下发；已注销号（status=2）与 viewer 自身剔除；
// 每游戏最多 24 人（前端展示前 6 头像 + "+N"，防超大盘好友库膨胀载荷）
func friendSocialOf(viewer string, gids []uint) (map[uint][]map[string]string, map[uint][]map[string]string) {
	ownOf := map[uint][]map[string]string{}
	playOf := map[uint][]map[string]string{}
	if viewer == "" || len(gids) == 0 {
		return ownOf, playOf
	}
	// 1. 好友集：关系可能仅单向一行存储，user_id/friend_id 任一侧命中即取对方用户名
	var fs []model.Friend
	store.DB.Where("user_id = ? OR friend_id = ?", viewer, viewer).Find(&fs)
	friends := make([]string, 0, len(fs))
	inSet := map[string]bool{viewer: true} // viewer 自身永不入集（自己不算"好友正在玩"）
	for _, f := range fs {
		other := f.FriendID
		if other == viewer {
			other = f.UserID
		}
		if other != "" && !inSet[other] {
			inSet[other] = true
			friends = append(friends, other)
		}
	}
	if len(friends) == 0 {
		return ownOf, playOf
	}
	// 2. 好友库归属：两条 IN 条件一条查询覆盖本批全部游戏（"拥有"）
	var libs []model.GameLibrary
	store.DB.Select("username, game_id").Where("username IN ? AND game_id IN ?", friends, gids).Find(&libs)
	byGame := map[uint][]string{}
	for _, l := range libs {
		byGame[l.GameID] = append(byGame[l.GameID], l.Username)
	}
	// 2.5 好友正在玩：内存 presence × 本批游戏 × 好友集预筛（零 SQL；新鲜度已在 gamePlayingUsers 过滤）
	playByGame := map[uint][]string{}
	playing := 0
	for _, gid := range gids {
		for _, un := range gamePlayingUsers(gid) {
			if inSet[un] {
				playByGame[gid] = append(playByGame[gid], un)
				playing++
			}
		}
	}
	if len(byGame) == 0 && playing == 0 {
		return ownOf, playOf
	}
	// 3. 头像/昵称批量取（排除已注销；展示名昵称优先回退用户名）
	type uInfo struct {
		Username string
		Avatar   string
		Nickname string
	}
	var us []uInfo
	store.DB.Model(&model.User{}).Select("username, avatar, nickname").
		Where("username IN ? AND status != ?", friends, 2).Find(&us)
	info := map[string]uInfo{}
	for _, u := range us {
		info[u.Username] = u
	}
	build := func(unames []string) []map[string]string {
		out := make([]map[string]string, 0, len(unames))
		for _, un := range unames {
			u, ok := info[un]
			if !ok { // 已注销好友不下发（拥有/在玩状态对查看者不可见）
				continue
			}
			name := u.Nickname
			if name == "" {
				name = u.Username
			}
			out = append(out, map[string]string{"username": un, "avatar": u.Avatar, "nickname": name})
			if len(out) >= 24 {
				break
			}
		}
		return out
	}
	for gid, unames := range byGame {
		if owns := build(unames); len(owns) > 0 {
			ownOf[gid] = owns
		}
	}
	for gid, unames := range playByGame {
		if sets := build(unames); len(sets) > 0 {
			playOf[gid] = sets
		}
	}
	return ownOf, playOf
}

// HandleGameReviews 评测列表 + 汇总（公开浏览：未登录 username 可缺省，仅 liked 需要身份）。
// 分页 size 默认 10（clamp 1-10）；type=all/1/0 筛选；sort=helpful（默认，"最有价值"口径：
// 有帮助数降序再时间降序）| latest（"最近发布"：create_time 降序，按发布时间而非编辑时间）
func (s *Server) HandleGameReviews(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	revPageSize, _ := strconv.Atoi(q.Get("size"))
	if revPageSize < 1 || revPageSize > 10 {
		revPageSize = 10
	}
	db := store.DB.Model(&model.GameReview{}).Where("game_id = ?", id)
	revType := q.Get("type")
	if revType == "1" || revType == "0" {
		db = db.Where("recommended = ?", revType)
	}
	order := "helpful_count DESC, id DESC"
	if q.Get("sort") == "latest" {
		order = "create_time DESC, id DESC"
	}
	// 汇总（不受 type 筛选影响，始终全量口径）
	var total, positive int64
	store.DB.Model(&model.GameReview{}).Where("game_id = ?", id).Count(&total)
	store.DB.Model(&model.GameReview{}).Where("game_id = ? AND recommended = 1", id).Count(&positive)
	var reviews []model.GameReview
	db.Order(order).Offset((page - 1) * revPageSize).Limit(revPageSize).Find(&reviews)
	// 头像批量查询 + 当前用户 liked 批量查询
	unames := make([]string, 0, len(reviews))
	revIDs := make([]uint, 0, len(reviews))
	for _, rv := range reviews {
		unames = append(unames, rv.Username)
		revIDs = append(revIDs, rv.ID)
	}
	avatars := map[string]string{}
	if len(unames) > 0 {
		var us []model.User
		store.DB.Select("username", "avatar").Where("username IN ?", unames).Find(&us)
		for _, u := range us {
			avatars[u.Username] = u.Avatar
		}
	}
	likedSet := map[uint]bool{}
	if viewer := strings.TrimSpace(q.Get("username")); viewer != "" && len(revIDs) > 0 {
		var likes []model.GameReviewLike
		store.DB.Where("username = ? AND review_id IN ?", viewer, revIDs).Find(&likes)
		for _, l := range likes {
			likedSet[l.ReviewID] = true
		}
	}
	list := make([]map[string]interface{}, 0, len(reviews))
	for _, rv := range reviews {
		list = append(list, map[string]interface{}{
			"id":          rv.ID,
			"username":    rv.Username,
			"avatar":      avatars[rv.Username],
			"recommended": rv.Recommended,
			"content":     rv.Content,
			"play_hours":  rv.PlayHours,
			"helpful":     rv.HelpfulCount,
			"liked":       likedSet[rv.ID],
			"reply_count": rv.ReplyCount,
			"create_time": rv.CreateTime,
			"update_time": rv.UpdateTime,
		})
	}
	adminJSON(w, map[string]interface{}{
		"list":         list,
		"page":         page,
		"total":        total,
		"positive":     positive,
		"summary_text": gameReviewSummaryText(total, positive),
		"has_more":     page*revPageSize < int(total),
	})
}

// HandleGameReviewUpsert 提交/更新自己的评测（一人一评；仅已入库用户可评——Steam 同款）。
// play_hours 从库条目 play_seconds 冗余快照（评测卡展示评测时游玩时长）
func (s *Server) HandleGameReviewUpsert(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var req struct {
		Recommended *int8  `json:"recommended"`
		Content     string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if req.Recommended == nil || (*req.Recommended != 0 && *req.Recommended != 1) {
		adminFail(w, http.StatusBadRequest, "须选择推荐或不推荐")
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		adminFail(w, http.StatusBadRequest, "评测内容不能为空")
		return
	}
	if utf8.RuneCountInString(content) > 2000 {
		adminFail(w, http.StatusBadRequest, "评测内容过长（限 2000 字）")
		return
	}
	// 入库校验（Steam 同款：拥有才可评）
	var lib model.GameLibrary
	if err := store.DB.Where("username = ? AND game_id = ?", username, id).First(&lib).Error; err != nil {
		adminFail(w, http.StatusForbidden, "先将游戏加入库后才能评测")
		return
	}
	playHours := math.Round(float64(lib.PlaySeconds)/36) / 100 // 秒→小时保留 2 位
	var rev model.GameReview
	err := store.DB.Where("game_id = ? AND username = ?", id, username).First(&rev).Error
	if err != nil {
		rev = model.GameReview{GameID: uint(id), Username: username, Recommended: *req.Recommended, Content: content, PlayHours: playHours}
		if err := store.DB.Create(&rev).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "评测提交失败")
			return
		}
	} else {
		rev.Recommended = *req.Recommended
		rev.Content = content
		rev.PlayHours = playHours
		if err := store.DB.Save(&rev).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "评测保存失败")
			return
		}
	}
	adminJSON(w, map[string]interface{}{"ok": true, "id": rev.ID, "play_hours": rev.PlayHours})
}

// HandleGameReviewDelete 删除自己的评测（连带清理"有帮助"标记，计数随评测删除一并消失）
func (s *Server) HandleGameReviewDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	var rev model.GameReview
	if err := store.DB.Where("game_id = ? AND username = ?", id, username).First(&rev).Error; err != nil {
		adminFail(w, http.StatusNotFound, "你还没有评测过该游戏")
		return
	}
	if err := store.DB.Delete(&rev).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "评测删除失败")
		return
	}
	store.DB.Where("review_id = ?", rev.ID).Delete(&model.GameReviewLike{})
	// 连带清理该评测的全部回复（防孤儿行；回复计数随评测删除一并消失）
	store.DB.Where("review_id = ?", rev.ID).Delete(&model.GameReviewReply{})
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleGameReviewHelpful "有帮助"标记 toggle（唯一索引幂等：未点插入+1，已点删除-1；
// 不能标记自己的评测——Steam 同款）
func (s *Server) HandleGameReviewHelpful(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	var req struct {
		ReviewID uint `json:"review_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ReviewID == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var rev model.GameReview
	if err := store.DB.First(&rev, req.ReviewID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "评测不存在或已删除")
		return
	}
	if rev.Username == username {
		adminFail(w, http.StatusBadRequest, "不能标记自己的评测")
		return
	}
	var exist model.GameReviewLike
	err := store.DB.Where("review_id = ? AND username = ?", rev.ID, username).First(&exist).Error
	if err != nil {
		if err := store.DB.Create(&model.GameReviewLike{ReviewID: rev.ID, Username: username}).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "标记失败")
			return
		}
		store.DB.Model(&model.GameReview{}).Where("id = ?", rev.ID).UpdateColumn("helpful_count", gorm.Expr("helpful_count + 1"))
		rev.HelpfulCount++
	} else {
		store.DB.Delete(&exist)
		store.DB.Model(&model.GameReview{}).Where("id = ?", rev.ID).UpdateColumn("helpful_count", gorm.Expr("GREATEST(helpful_count - 1, 0)"))
		rev.HelpfulCount--
		if rev.HelpfulCount < 0 {
			rev.HelpfulCount = 0
		}
	}
	adminJSON(w, map[string]interface{}{"ok": true, "liked": err != nil, "helpful": rev.HelpfulCount})
}

// ===== 评测回复（朋友圈 MomentComment 同款楼中楼：平铺展示"张三回复李四"，Steam 评论区同款纯文字行） =====

// HandleGameReviewReplies GET /api/game/review/replies?review_id=N 某评测的回复列表。
// 公开浏览（username 可缺省，与评测列表同水位）；楼层正序；量级小一次拉全（limit 200 兜底）
func (s *Server) HandleGameReviewReplies(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	revID, _ := strconv.ParseUint(r.URL.Query().Get("review_id"), 10, 64)
	if revID == 0 {
		adminFail(w, http.StatusBadRequest, "缺少 review_id 参数")
		return
	}
	var replies []model.GameReviewReply
	store.DB.Where("review_id = ?", revID).Order("create_time ASC, id ASC").Limit(200).Find(&replies)
	list := make([]map[string]interface{}, 0, len(replies))
	for _, rp := range replies {
		list = append(list, map[string]interface{}{
			"id":            rp.ID,
			"username":      rp.Username,
			"reply_to":      rp.ReplyTo,
			"reply_to_user": rp.ReplyToUser,
			"content":       rp.Content,
			"create_time":   rp.CreateTime,
		})
	}
	adminJSON(w, map[string]interface{}{"list": list})
}

// HandleGameReviewReplyUpsert POST /api/game/review/reply 发布回复（body: {review_id, content, reply_to}）。
// 登录即可回复（Steam 社区评论同语义，无需入库）；reply_to>0 为楼中楼回复——目标回复须属于本评测，
// 被回复人冗余存储；回复的回复平铺归一不嵌套
func (s *Server) HandleGameReviewReplyUpsert(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	var req struct {
		ReviewID uint   `json:"review_id"`
		Content  string `json:"content"`
		ReplyTo  uint   `json:"reply_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ReviewID == 0 {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		adminFail(w, http.StatusBadRequest, "回复内容不能为空")
		return
	}
	if utf8.RuneCountInString(content) > 500 {
		adminFail(w, http.StatusBadRequest, "回复最长 500 字")
		return
	}
	var rev model.GameReview
	if err := store.DB.First(&rev, req.ReviewID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "评测不存在或已删除")
		return
	}
	// 楼中楼归口：目标回复须属于本评测；被回复人取原回复人（"张三回复李四"平铺展示）
	replyToUser := ""
	if req.ReplyTo > 0 {
		var target model.GameReviewReply
		if err := store.DB.Where("id = ? AND review_id = ?", req.ReplyTo, rev.ID).First(&target).Error; err != nil {
			adminFail(w, http.StatusNotFound, "被回复的回复不存在")
			return
		}
		replyToUser = target.Username
	}
	rp := model.GameReviewReply{
		ReviewID:    rev.ID,
		Username:    username,
		ReplyTo:     req.ReplyTo,
		ReplyToUser: replyToUser,
		Content:     content,
	}
	if err := store.DB.Create(&rp).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "回复失败")
		return
	}
	store.DB.Model(&model.GameReview{}).Where("id = ?", rev.ID).UpdateColumn("reply_count", gorm.Expr("reply_count + 1"))
	adminJSON(w, map[string]interface{}{"ok": true, "id": rp.ID})
}

// HandleGameReviewReplyDelete DELETE /api/game/review/reply/{rid}?username= 删除回复。
// 回复人或评测主人可删（MomentComment "评论人或动态主人"同款）；计数 GREATEST 兜底防负
func (s *Server) HandleGameReviewReplyDelete(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	rid, _ := strconv.ParseUint(r.PathValue("rid"), 10, 64)
	var rp model.GameReviewReply
	if err := store.DB.First(&rp, rid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "回复不存在或已删除")
		return
	}
	var rev model.GameReview
	if err := store.DB.First(&rev, rp.ReviewID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "评测不存在或已删除")
		return
	}
	if rp.Username != username && rev.Username != username {
		adminFail(w, http.StatusForbidden, "无权删除该回复")
		return
	}
	if err := store.DB.Delete(&rp).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "回复删除失败")
		return
	}
	store.DB.Model(&model.GameReview{}).Where("id = ?", rev.ID).UpdateColumn("reply_count", gorm.Expr("GREATEST(reply_count - 1, 0)"))
	adminJSON(w, map[string]interface{}{"ok": true})
}
