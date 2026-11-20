package server

import (
	"context"
	"crypto/hmac"
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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ============= E1：成就解锁防刷 - 内存降级结构（Redis 不可用时兜底） =============
// 单进程内 Redis 不可用时，用内存做简易 nonce 去重 + 限流（进程级，集群多进程各自独立；
// 正常 Redis 模式下这两个 map 不会被用到）。

var (
	achUnlockMemMu      sync.Mutex
	achUnlockMemNonces  = map[string]time.Time{} // key=username:nonce → expireAt
	achUnlockMemCounter = map[string][]int64{}   // key=username → []unixMilli timestamps (滑窗)
)

func achNonceBlockKey(username, nonce string) string { return "im:achievement:nonce:" + username + ":" + nonce }
func achRatelimitKey(username string) string         { return "im:achievement:ratelimit:" + username }

// ============= 成就会话签名密钥（方案 §14.2 签名死锁修复） =============
// 原机制缺陷：验签密钥为全局 launch_secret，仅存 config 从不下发 → 客户端永远算不出合法签名（死锁）。
// 修复：游戏库/详情下发 launch_password 时同步签发一次性会话签名密钥（24h TTL 存 Redis），
// 验签优先取会话密钥；launch_secret 本体永不出服务器，泄露半径=单用户×单游戏×24h。

const achSignKeyTTL = 24 * time.Hour // 会话签名密钥有效期（与游戏会话 24h 对齐）

// achSignRequiredOverride 签名强制开关测试覆盖钩子（非 nil 时优先于 config；
// 生产恒 nil 走 config.Load() 热读——config.Load 每次重读文件，进程内改内存值无效）
var achSignRequiredOverride *bool

// achSignKeyRedisKey 会话签名密钥的 Redis 键（单用户单游戏一把，覆盖旧值实现轮换）
func achSignKeyRedisKey(username string, gameID uint) string {
	return "im:ach:signkey:" + username + ":" + strconv.FormatUint(uint64(gameID), 10)
}

// achSessionSignKeyOf 取当前会话签名密钥（存在即复用，不轮换：游戏启动后客户端持有旧钥
// 仍可用满 24h；库接口每次刷新都重签会导致已启动会话的签名失效）。空串=未签发/Redis 不可用
func achSessionSignKeyOf(username string, gameID uint) string {
	if username == "" || gameID == 0 || !store.RedisAvailable() {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	key, _ := store.RDB.Get(ctx, achSignKeyRedisKey(username, gameID)).Result()
	return key
}

// achSessionKeysMGet 批量取会话签名密钥（库接口整库一次 MGET，防逐游戏 N 次 Redis 往返；
// 缺失项由调用方对单游戏走 achSessionSignKeyIssue 补签——仅首次访问/过期后发生）
func achSessionKeysMGet(username string, gameIDs []uint) map[uint]string {
	out := map[uint]string{}
	if username == "" || len(gameIDs) == 0 || !store.RedisAvailable() {
		return out
	}
	keys := make([]string, 0, len(gameIDs))
	for _, gid := range gameIDs {
		keys = append(keys, achSignKeyRedisKey(username, gid))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	vals, err := store.RDB.MGet(ctx, keys...).Result()
	if err != nil {
		return out
	}
	for i, v := range vals {
		if s, ok := v.(string); ok && s != "" && i < len(gameIDs) {
			out[gameIDs[i]] = s
		}
	}
	return out
}

// achSessionSignKeyIssue 签发（或复用已有）一次性会话签名密钥：
// key = hex(hmac_sha256(secret, username|game_id|random|ts))，写 Redis TTL 24h。
// secret 归口游戏专属密钥（与 launch_password 同源，单游戏泄露/轮换半径=该游戏）；
// Redis 不可用返回空串（验签侧按降级开关兜底）。key 仅随 launch_password 同步下发本人。
func achSessionSignKeyIssue(username string, gameID uint, secret string) string {
	if username == "" || gameID == 0 || secret == "" {
		return ""
	}
	if existing := achSessionSignKeyOf(username, gameID); existing != "" {
		return existing // 复用当前会话密钥（不轮换，已启动会话签名持续有效）
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return ""
	}
	msg := username + "|" + strconv.FormatUint(uint64(gameID), 10) + "|" +
		hex.EncodeToString(random) + "|" + strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	key := hex.EncodeToString(mac.Sum(nil))
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := store.RDB.Set(ctx, achSignKeyRedisKey(username, gameID), key, achSignKeyTTL).Err(); err != nil {
		logger.Warn("成就会话密钥写入 Redis 失败（user=%s game#%d）: %v", username, gameID, err)
		return ""
	}
	return key
}

// achVerifySignature P2-c：成就解锁 HMAC-SHA256 签名校验（单一入口，方案 §14.2 改造）
// 口径冻结（ExperienceRecall 教训：前后端/多调用方必须共用同一份 canonicalMessage 公式）：
//
//	canonicalMessage = strconv.FormatInt(clientTs, 10) + "\n" + nonce + "\n" + sha256(bodyBytes)_hex
//	signature         = hex.EncodeToString(hmac_sha256(session_sign_key, canonicalMessage))
//	客户端放 header: X-Game-Signature（密钥来自游戏库/详情下发的 session_sign_key）
//
// 验签顺序（签名死锁修复）：
//  1. Redis 存在会话密钥 → 用会话密钥验签（无签名/不匹配一律拒绝）
//  2. 会话密钥不存在：
//     - achievement_sign_required: true → 拒绝
//     - 默认 false → 降级放行（登录 token + 在库校验 + 防重放 + 限流四道防线仍在）
func achVerifySignature(username string, gameID uint, clientTs int64, nonce string, bodyBytes []byte, clientSig string) bool {
	cfg := config.Load()
	if cfg.Game.LaunchSecret == "" {
		return true // 密钥未配置 → 降级跳过（向后兼容兜底；config.Load 保证非空，正常不走此分支）
	}

	// 1) 会话密钥优先（username+game_id 锚定，泄露半径=单会话）
	sessionKey := achSessionSignKeyOf(username, gameID)
	if sessionKey == "" {
		// 2) 无会话密钥：按强制开关决定（测试覆盖钩子优先，生产走 config 热读）
		required := cfg.Game.AchievementSignRequired
		if achSignRequiredOverride != nil {
			required = *achSignRequiredOverride
		}
		if required {
			logger.Warn("ach signature required but session key missing (user=%s game#%d)", username, gameID)
			return false
		}
		return true // 降级放行（评审结论：默认 false，四道防线兜底）
	}
	if clientSig == "" {
		logger.Warn("ach signature missing (session key exists but client sent no signature, user=%s game#%d)", username, gameID)
		return false
	}

	// 单一 canonicalMessage 构造（全工程唯一入口，避免不同模块各自拼接漂移）
	bodyHash := sha256.Sum256(bodyBytes)
	bodyHashHex := hex.EncodeToString(bodyHash[:])
	canonicalMessage := strconv.FormatInt(clientTs, 10) + "\n" + nonce + "\n" + bodyHashHex

	// HMAC-SHA256（会话密钥：签发侧写入的是 64 字符 hex，验签侧统一 hex 解码为 32 字节原始密钥，
	// 与客户端 ImGameSDK 口径一致——客户端 hex 解码后做 ipad/opad 异或构造标准 HMAC）
	keyBytes, err := hex.DecodeString(sessionKey)
	if err != nil {
		keyBytes = []byte(sessionKey) // 兜底：非 hex 密钥按原始字节（历史手写密钥场景）
	}
	mac := hmac.New(sha256.New, keyBytes)
	mac.Write([]byte(canonicalMessage))
	expectedSig := hex.EncodeToString(mac.Sum(nil))

	if hmac.Equal([]byte(expectedSig), []byte(strings.ToLower(clientSig))) {
		return true
	}
	// 验签失败 → 输出可对照证据（ExperienceRecall：字段值/顺序/编码差异一眼可见）
	logger.Warn("ach signature mismatch: expected=%s actual=%s canonical=%s",
		expectedSig, strings.ToLower(clientSig), canonicalMessage)
	return false
}

// achIsGameInLibrary 校验用户是否拥有该游戏（成就解锁防刷：不能解锁未入库游戏的成就）
func achIsGameInLibrary(username string, gameID uint) bool {
	var cnt int64
	store.DB.Model(&model.GameLibrary{}).
		Where("username = ? AND game_id = ? AND removed_at IS NULL", username, gameID).
		Count(&cnt)
	return cnt > 0
}

// achCheckReplayAndRateLimit 防重放 + 频率限制一体化
// - 入参 username/nonce/clientTs
// - allowWindow: 时间戳允许偏移秒数（绝对值）
// - rateWindowSec: 限流滑窗秒数
// - rateMax: 滑窗内最大次数
// - 返回 (ok bool, reason string)
func achCheckReplayAndRateLimit(username, nonce string, clientTs int64, allowWindow, rateWindowSec, rateMax int) (bool, string) {
	// 1) 时间戳窗口校验
	if clientTs > 0 {
		now := time.Now().Unix()
		diff := clientTs - now
		if diff < 0 { diff = -diff }
		if diff > int64(allowWindow) {
			return false, "客户端时间戳漂移过大，请同步系统时间"
		}
	}

	// 2) Redis 可用优先走 Redis
	if store.RedisAvailable() {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		pipe := store.RDB.TxPipeline()

		// nonce 黑名单（防重放，TTL=300s）
		nonceKey := achNonceBlockKey(username, nonce)
		pipe.Exists(ctx, nonceKey)
		if nonce != "" {
			pipe.SetNX(ctx, nonceKey, "1", 300*time.Second)
		}

		// 限流滑窗（INCR + EXPIRE + GET）
		rlKey := achRatelimitKey(username)
		pipe.Incr(ctx, rlKey)
		pipe.Expire(ctx, rlKey, time.Duration(rateWindowSec)*time.Second)

		results, _ := pipe.Exec(ctx)

		// 用类型遍历找命令结果，不用硬索引（SetNX 在 nonce="" 时跳过 → results 位置偏移）
		if nonce != "" {
			for _, r := range results {
				if exists, ok := r.(*redis.IntCmd); ok && strings.Contains(exists.Name(), "exists") {
					if exists.Val() > 0 {
						return false, "请求已处理，请勿重复提交"
					}
					break
				}
			}
		}
		for _, r := range results {
			if inc, ok := r.(*redis.IntCmd); ok && strings.Contains(inc.Name(), "incr") {
				if inc.Val() > int64(rateMax) {
					return false, "操作过于频繁，请稍后再试"
				}
				break
			}
		}
		return true, ""
	}

	// 3) Redis 不可用 → 内存降级（单进程）
	achUnlockMemMu.Lock()
	defer achUnlockMemMu.Unlock()

	// 先清理过期 nonce
	nowTs := time.Now()
	for k, exp := range achUnlockMemNonces {
		if nowTs.After(exp) { delete(achUnlockMemNonces, k) }
	}
	if nonce != "" {
		memKey := username + ":" + nonce
		if _, exists := achUnlockMemNonces[memKey]; exists {
			return false, "请求已处理，请勿重复提交"
		}
		achUnlockMemNonces[memKey] = nowTs.Add(300 * time.Second)
	}

	// 限流滑窗
	cutoff := nowTs.Add(-time.Duration(rateWindowSec) * time.Second).UnixMilli()
	timestamps := achUnlockMemCounter[username]
	trimmed := timestamps[:0]
	for _, t := range timestamps {
		if t >= cutoff {
			trimmed = append(trimmed, t)
		}
	}
	trimmed = append(trimmed, nowTs.UnixMilli())
	if len(trimmed) > rateMax {
		achUnlockMemCounter[username] = trimmed
		return false, "操作过于频繁，请稍后再试"
	}
	achUnlockMemCounter[username] = trimmed
	return true, ""
}

// ProfileInfo 个人资料（阶段三十：微信式资料面板/资料卡归口数据）
// 自己：PROFILE_UPDATE 落库后回推本人全部连接（多端同步）；他人：PROFILE_QUERY 查询响应（好友携带备注）
type ProfileInfo struct {
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	Gender    int8   `json:"gender"` // 0未知 1男 2女
	Region    string `json:"region"`
	Signature string `json:"signature"`
	Avatar    string `json:"avatar"`
	IsFriend  bool   `json:"is_friend"` // 查询者与目标是否好友（自己为 false）
	Remark    string `json:"remark"`    // 查询者给目标设置的备注名（非好友为空）
	// IP 属地（ip2region 离线解析，微信同款口径：国内省份/海外国家/内网「内网」）。
	// 服务端归口解析，报文只含属地文本不含 IP 明文；空串=不可用（未启用/目标离线/集群跨实例），前端整行隐藏
	IpRegion string `json:"ip_region"`
	// 阶段二百九十五+补丁：游戏中心等级/经验/称号（Steam 同款，扩展到 WS PROFILE_RESP 供 hover-card 轻量预览）
	Level int   `json:"level"`
	Exp   int64 `json:"exp"`
	Title string `json:"title"`
	// 统计数据（一次聚合，前端零计算）
	Stats ProfileStatsBrief `json:"stats"`
	// 正在玩的游戏列表（内存 presence 实时态，空列表=当前没在玩任何游戏）
	PlayingGames []PlayingGameBrief `json:"playing_games,omitempty"`
}

// ProfileStatsBrief hover-card 用的精简统计（区别于 HTTP API 的完整 ProfileStatsResp，这里只挑 4 个关键数据）
type ProfileStatsBrief struct {
	TotalGames        int64   `json:"total_games"`
	TotalPlayHours    float64 `json:"total_play_hours"`
	TotalAchievements int64   `json:"total_achievements"`
	TotalBadges       int64   `json:"total_badges"`
	FriendsCount      int64   `json:"friends_count"`
}

// profileUpdateReq 个人资料更新请求（content JSON，仅允许修改这四个字段，用户名/头像走原有通道）
type profileUpdateReq struct {
	Nickname  string `json:"nickname"`
	Gender    int8   `json:"gender"`
	Region    string `json:"region"`
	Signature string `json:"signature"`
}

// sendProfileResp 向指定连接下发个人资料响应（content 为 ProfileInfo JSON）
func (s *Server) sendProfileResp(c *Client, info ProfileInfo) {
	content, _ := json.Marshal(info)
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeProfileResp,
		ToUser:    c.username, // 响应归属人（多端区分）
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	c.send(data)
}

// buildProfileInfo 查询目标用户资料并按查询者视角组装（好友关系与备注服务端归口，防前端伪造）。
// includeGameExtra=true 时附加游戏中心扩展（stats 聚合 + playing_games presence）——仅用于 handleProfileQuery
// 路径（别人查我）；handleProfileUpdate / adminaccounts 回推自己路径传 false 减少 6+1 次 SQL 往返。
// 隐私规则与 HTTP 接口完全一致：ProfileVisibility 控制整体可见性，GameVisibility 控制游戏详情。
func (s *Server) buildProfileInfo(viewer, target string, includeGameExtra bool) (ProfileInfo, bool) {
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		return ProfileInfo{}, false
	}
	info := ProfileInfo{
		Username:  u.Username,
		Nickname:  u.Nickname,
		Gender:    u.Gender,
		Region:    u.Region,
		Signature: u.Signature,
		Avatar:    u.Avatar,
		// 阶段二百九十五+补丁：游戏中心等级/经验/称号（Steam 同款）—— User 表字段，随 First 查出无额外 SQL
		Level: u.Level,
		Exp:   u.Exp,
		Title: u.Title,
	}
	// IP 属地：目标在线时由其连接真实 IP 解析（服务端归口，离线/跨实例/未启用为空串降级）
	if ipRegionEnabled() {
		info.IpRegion = ipRegion(s.onlineIPOf(target))
	}

	// 隐私计算（与 HTTP 接口同口径：扁平公式）
	isSelf := viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
			info.IsFriend = true
			info.Remark = f.Remark
		}
	}
	// 资料整体可见性
	profileVisible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	// 游戏详情可见性（控制 stats 里的游戏数据 + playing_games）
	canSeeGame := isSelf || u.GameVisibility == 2 || (u.GameVisibility == 1 && isFriend)

	// 游戏中心扩展：仅外部查询路径开启（自我回推路径跳过避免冗余 SQL）
	if includeGameExtra {
		// ProfileVisibility 本身不通过：Stats 全置零（hover-card 仍显示但游戏统计区显示零值）
		// ProfileVisibility 通过但 GameVisibility 不通过：Stats 里游戏相关字段置零，徽章/好友数保留
		if !profileVisible {
			info.Stats = ProfileStatsBrief{} // 全零
		} else {
			var badgeCount int64
			store.DB.Model(&model.UserBadge{}).Where("username = ?", target).Count(&badgeCount)
			var friendCount int64
			store.DB.Model(&model.Friend{}).Where("user_id = ?", target).Count(&friendCount)

			var libCount int64
			var totalPlaySec int64
			var achCount int64
			if canSeeGame {
				store.DB.Model(&model.GameLibrary{}).Where("username = ? AND state >= 0 AND removed_at IS NULL", target).Count(&libCount)
				store.DB.Model(&model.GameLibrary{}).Where("username = ?", target).
					Select("COALESCE(SUM(play_seconds),0)").Scan(&totalPlaySec)
				store.DB.Model(&model.UserAchievement{}).Where("username = ?", target).Count(&achCount)
			}
			info.Stats = ProfileStatsBrief{
				TotalGames:        libCount,
				TotalPlayHours:    float64(totalPlaySec) / 3600.0,
				TotalAchievements: achCount,
				TotalBadges:       badgeCount,
				FriendsCount:      friendCount,
			}
		}

		// 正在玩的游戏（内存 presence；仅资料整体可见且游戏详情可见时返回）
		if profileVisible && canSeeGame {
			if playing := gamePlayingOf(target); len(playing) > 0 {
				info.PlayingGames = playing
			}
		}
	}
	return info, true
}

// handleProfileUpdate 处理个人资料更新：校验后落库并回推本人全部连接（多端同步）
// 原实现：无个人资料概念，点击头像直接弹文件选择换图
func (s *Server) handleProfileUpdate(c *Client, msg *protocol.Message) {
	var req profileUpdateReq
	if err := json.Unmarshal([]byte(msg.Content), &req); err != nil {
		s.sendError(c, "资料格式错误")
		return
	}
	// 性别合法性校验：仅允许 0未知 1男 2女
	if req.Gender < 0 || req.Gender > 2 {
		s.sendError(c, "性别参数无效")
		return
	}
	// 长度截断（与数据库字段宽度一致，超长直接拒绝更直观）
	if len(req.Nickname) > 32*3 || len(req.Region) > 64*3 || len(req.Signature) > 128*3 {
		s.sendError(c, "资料内容过长")
		return
	}

	updates := map[string]interface{}{
		"nickname":  req.Nickname,
		"gender":    req.Gender,
		"region":    req.Region,
		"signature": req.Signature,
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", c.username).Updates(updates).Error; err != nil {
		s.sendError(c, "资料保存失败")
		return
	}
	// 阶段八十五：昵称缓存失效（群聊帧/历史帧下发用），下次读取回源取新昵称
	// 集群模式：总线广播失效其他实例的昵称缓存（无 TTL 进程缓存，跨实例必须显式失效）
	s.invalidateNickname(c.username)

	// 回推本人全部在线连接（多端同步），is_friend/remark 对自己无意义固定零值
	// 集群模式：sendToUser 归口（总线定向信封覆盖跨实例的多端连接；原本地 GetAll 循环跨实例漏推）
	info, ok := s.buildProfileInfo(c.username, c.username, false) // 自我回推路径跳过游戏扩展（冗余）
	if !ok {
		s.sendError(c, "资料读取失败")
		return
	}
	pContent, _ := json.Marshal(info)
	pData, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeProfileResp,
		ToUser:    c.username,
		Content:   string(pContent),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(c.username, pData)
	s.sendError(c, "资料已保存")
	logger.Info("用户 %s 更新个人资料：昵称=%s 性别=%d 地区=%s", c.username, info.Nickname, info.Gender, info.Region)
}

// handleProfileQuery 处理个人资料查询：返回目标用户资料（好友携带备注，服务端归口）
// 原实现：点击好友头像无资料卡，仅右键菜单可设置备注
func (s *Server) handleProfileQuery(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" {
		s.sendError(c, "查询目标无效")
		return
	}
	info, ok := s.buildProfileInfo(c.username, msg.ToUser, true) // 外部查询路径包含游戏扩展（hover-card 好友预览）
	if !ok {
		s.sendError(c, "用户不存在")
		return
	}
	s.sendProfileResp(c, info)
}

// ==================== 阶段二百九十五：Steam 同款个人资料 HTTP API ====================

// ProfileHTTPResp /api/profile 聚合接口响应结构
type ProfileHTTPResp struct {
	Ok   bool        `json:"ok"`
	Data interface{} `json:"data,omitempty"`
	Err  string      `json:"err,omitempty"`
}

// ProfileBasicResp 基础资料（带 Steam 扩展字段）
type ProfileBasicResp struct {
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	Avatar    string `json:"avatar"`
	Gender    int8   `json:"gender"`
	Region    string `json:"region"`
	Signature string `json:"signature"`
	// Steam 扩展
	Level         int    `json:"level"`
	Exp           int64  `json:"exp"`
	Title         string `json:"title"`
	ProfileBg         string `json:"profile_bg"`
	ProfileBannerSkin string `json:"profile_banner_skin"` // 预设横幅皮肤（商店购买后应用，空=未使用预设）
	FavoriteGame      int    `json:"favorite_game_id"`
	// 隐私设置（仅自己查看时完整返回；他人查看时仅返回 profile_visibility 用于判断是否可见）
	ProfileVisibility int8 `json:"profile_visibility"`
	GameVisibility    int8 `json:"game_visibility"`
	FriendVisibility  int8 `json:"friend_visibility"`
	CommentEnabled    int8 `json:"comment_enabled"`
	// P3：积分余额（仅自己可见；他人返回 0 防泄露）
	Points float64 `json:"points"`
	// P3：已购买的积分商店物品 ID 列表（avatar_frame / golden_name 等）
	ShopItems []string `json:"shop_items,omitempty"`
}

// ProfileStatsResp 统计数据（聚合一次返回，前端零计算）
type ProfileStatsResp struct {
	TotalGames       int64   `json:"total_games"`
	TotalPlaySeconds int64   `json:"total_play_seconds"`
	TotalPlayHours   float64 `json:"total_play_hours"`
	TotalAchievements int64  `json:"total_achievements"`
	TotalBadges      int64   `json:"total_badges"`
	FriendsCount     int64   `json:"friends_count"`
}

// ProfileRecentGameResp 最近游戏条目
type ProfileRecentGameResp struct {
	GameID     uint   `json:"game_id"`
	Name       string `json:"name"`
	Cover      string `json:"cover"`
	PlaySeconds int64 `json:"play_seconds"`
	LastPlayAt string `json:"last_play_at"`
}

// ProfileBadgeResp 徽章横条条目
type ProfileBadgeResp struct {
	Type string `json:"type"`
	Code string `json:"code"`
	Name string `json:"name"`
	Icon string `json:"icon"`
	Desc string `json:"desc"`
}

// ProfileFavoriteGameResp 最爱游戏
type ProfileFavoriteGameResp struct {
	ID    uint   `json:"id"`
	Name  string `json:"name"`
	Cover string `json:"cover"`
}

// ProfileFullResp GET /api/profile 完整聚合响应
type ProfileFullResp struct {
	Basic        ProfileBasicResp          `json:"basic"`
	Stats        ProfileStatsResp          `json:"stats"`
	Badges       []ProfileBadgeResp        `json:"badges_horizontal"`
	RecentGames  []ProfileRecentGameResp   `json:"recent_games"`
	FavoriteGame *ProfileFavoriteGameResp  `json:"favorite_game,omitempty"`
	// IsFriend 查询者与目标是否好友（隐私过滤用，服务端归口）
	IsFriend bool `json:"is_friend"`
	// IsSelf 查询者就是目标本人
	IsSelf bool `json:"is_self"`
	// GameVisible 查询者是否有权查看目标的游戏详情（最近游戏/游戏统计/最爱游戏/成就）
	GameVisible bool `json:"game_visible"`
	// LevelPerks 等级权益（P0：展示柜槽位上限 / 自动称号 / 下一级需求）
	LevelPerks ProfileLevelPerksResp `json:"level_perks"`
}

// ProfileLevelPerksResp 等级权益
type ProfileLevelPerksResp struct {
	ShowcaseSlots int    `json:"showcase_slots"`           // 当前等级允许的展示柜槽位数
	Title         string `json:"title"`                    // 等级配置里的称号（空=用户自定义）
	CurrentLevel  int    `json:"level"`                    // 当前等级
	ExpRequired   int64  `json:"exp_required"`             // 当前等级累计经验需求
	NextLevelExp  int64  `json:"next_exp_required"`        // 下一级累计经验需求（0=满级）
	MaxLevel      int    `json:"max_level"`                // 配置表最高等级
}

// profileFail 写失败响应
func profileFail(w http.ResponseWriter, err string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(ProfileHTTPResp{Ok: false, Err: err})
}

// profileOK 写成功响应
func profileOK(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(ProfileHTTPResp{Ok: true, Data: data})
}

// HandleProfileGet GET /api/profile?username=xxx 聚合接口
// 鉴权：query 带 username + X-Drive-Token（token 可空但能查自己；查他人需要已登录态）
// 返回：基础资料 + 统计 + 徽章横条 + 最近游戏 + 最爱游戏（隐私受 User.ProfileVisibility 控制）
func (s *Server) HandleProfileGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" {
		profileFail(w, "username 必填")
		return
	}

	// 取查询者身份（游戏中心 X-Drive-Token 鉴权）
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target

	// 1. 查目标用户（不存在直接返回）
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在")
		return
	}

	// 2. 隐私过滤：ProfileVisibility 0=私密 1=仅好友 2=公开
	// 自己永远全量；他人按隐私设置过滤
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		// 私密 → 只返回用户名 + "该用户资料私密"提示
		profileOK(w, map[string]interface{}{
			"basic": ProfileBasicResp{Username: u.Username, Nickname: "该用户资料私密"},
			"is_friend": isFriend,
			"is_self":   isSelf,
		})
		return
	}

	// 游戏详情额外受 GameVisibility 控制（对标 Steam：资料可见 ≠ 游戏详情可见）
	// GameVisibility: 0=私密 1=仅好友 2=公开
	canSeeGame := isSelf || u.GameVisibility == 2 || (u.GameVisibility == 1 && isFriend)

	// 3. 基础资料（带 Steam 扩展字段）
	basic := ProfileBasicResp{
		Username:          u.Username,
		Nickname:          u.Nickname,
		Avatar:            u.Avatar,
		Gender:            u.Gender,
		Region:            u.Region,
		Signature:         u.Signature,
		Level:             u.Level,
		Exp:               u.Exp,
		Title:             u.Title,
		ProfileBg:         u.ProfileBg,
		FavoriteGame:      u.FavoriteGameID,
		ProfileVisibility: u.ProfileVisibility,
		GameVisibility:    u.GameVisibility,
		FriendVisibility:  u.FriendVisibility,
		CommentEnabled:    u.CommentEnabled,
	}
	// 积分仅本人可见
	if isSelf {
		basic.Points = u.Points
		// 已购积分商店物品
		var shopRows []model.UserShopItem
		store.DB.Where("username = ?", target).Find(&shopRows)
		shopItems := make([]string, 0, len(shopRows))
		for _, si := range shopRows {
			shopItems = append(shopItems, si.ItemID)
		}
		basic.ShopItems = shopItems
	}

	// 4. 统计数据（聚合查询：游戏数/总时长/成就/徽章/好友数）
	// 注意：游戏相关统计（游戏数/时长/成就）受 GameVisibility 控制；徽章和好友数不受
	var libCount int64
	var totalPlaySec int64
	var achCount int64
	if canSeeGame {
		store.DB.Model(&model.GameLibrary{}).Where("username = ? AND state >= 0 AND removed_at IS NULL", target).Count(&libCount)
		store.DB.Model(&model.GameLibrary{}).Where("username = ?", target).
			Select("COALESCE(SUM(play_seconds),0)").Scan(&totalPlaySec)
		store.DB.Model(&model.UserAchievement{}).Where("username = ?", target).Count(&achCount)
	}

	var badgeCount int64
	store.DB.Model(&model.UserBadge{}).Where("username = ?", target).Count(&badgeCount)

	var friendCount int64
	store.DB.Model(&model.Friend{}).Where("user_id = ?", target).Count(&friendCount)

	stats := ProfileStatsResp{
		TotalGames:        libCount,
		TotalPlaySeconds:  totalPlaySec,
		TotalPlayHours:    float64(totalPlaySec) / 3600.0,
		TotalAchievements: achCount,
		TotalBadges:       badgeCount,
		FriendsCount:      friendCount,
	}

	// 5. 徽章横条（等级徽章 + 特殊徽章，按 create_time 倒序取前 10）
	var badgeRows []model.UserBadge
	store.DB.Where("username = ?", target).Order("create_time DESC").Limit(10).Find(&badgeRows)
	badges := make([]ProfileBadgeResp, 0, len(badgeRows))
	for _, b := range badgeRows {
		badges = append(badges, ProfileBadgeResp{
			Type: b.Type, Code: b.Code, Name: b.Name, Icon: b.Icon, Desc: b.Desc,
		})
	}
	// 若没有等级徽章 → 兜底给一个（P0 阶段还没自动发等级徽章）
	hasLevelBadge := false
	for _, b := range badges {
		if b.Type == "level" { hasLevelBadge = true; break }
	}
	if !hasLevelBadge {
		badges = append([]ProfileBadgeResp{{
			Type: "level", Code: "lv" + strconv.Itoa(u.Level),
			Name: "等级 " + strconv.Itoa(u.Level), Icon: "", Desc: "个人等级徽章",
		}}, badges...)
	}

	// 6. 最近游戏（按 last_play_at 最近游玩时间倒序取前 6；受 GameVisibility 控制）
	recent := make([]ProfileRecentGameResp, 0)
	if canSeeGame {
		var libs []model.GameLibrary
		store.DB.Where("username = ? AND play_seconds > 0", target).
			Order("last_play_at DESC").Limit(6).Find(&libs)

		if len(libs) > 0 {
			// 批量查游戏元数据（避免 N+1 查询）
			gids := make([]uint, 0, len(libs))
			for _, l := range libs { gids = append(gids, l.GameID) }
			var games []model.Game
			store.DB.Where("id IN ?", gids).Find(&games)
			gameMap := make(map[uint]*model.Game, len(games))
			for i := range games { gameMap[games[i].ID] = &games[i] }

			for _, l := range libs {
				g := gameMap[l.GameID]
				name := ""
				cover := ""
				if g != nil { name = g.Name; cover = g.Cover }
				lastPlay := ""
				if !l.LastPlayAt.IsZero() { lastPlay = l.LastPlayAt.Format("2006-01-02 15:04") }
				recent = append(recent, ProfileRecentGameResp{
					GameID: l.GameID, Name: name, Cover: cover,
					PlaySeconds: l.PlaySeconds, LastPlayAt: lastPlay,
				})
			}
		}
	}

	// 7. 最爱游戏（同样受 GameVisibility 控制）
	var favGame *ProfileFavoriteGameResp
	if canSeeGame && u.FavoriteGameID > 0 {
		var g model.Game
		if err := store.DB.Where("id = ?", u.FavoriteGameID).First(&g).Error; err == nil {
			favGame = &ProfileFavoriteGameResp{ID: g.ID, Name: g.Name, Cover: g.Cover}
		}
	}

	// 8. 等级权益（P0：查 UserLevelConfig，前端按此限制展示柜槽位）
	perks := getLevelPerks(u.Level)

	// 组装响应
	full := ProfileFullResp{
		Basic:        basic,
		Stats:        stats,
		Badges:       badges,
		RecentGames:  recent,
		FavoriteGame: favGame,
		IsFriend:     isFriend,
		IsSelf:       isSelf,
		GameVisible:  canSeeGame,
		LevelPerks:   perks,
	}
	profileOK(w, full)
}

// ==================== 成就解锁上报 ====================

// HandleGameAchievementUnlock POST /api/game/achievement/unlock
// 客户端上报成就解锁（自己给自己解锁，token 鉴权）；幂等（已解锁直接返回）
// 解锁成功自动：发经验值 → 检查等级提升 → 可能自动发等级徽章
//
// E1 防刷机制（三层）：
//  1. 游戏在库校验：必须已入库该游戏才能解锁其成就（防止伪造 game_id）
//  2. 防重放 nonce + 时间戳窗口：±300s 漂移内有效，同一 nonce 5 分钟内只能用一次（Redis/内存双模式）
//  3. 频率限制：单用户 60s 内最多解锁 10 条成就（Redis INCR + 内存滑窗双模式）
func (s *Server) HandleGameAchievementUnlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		profileFail(w, "只支持 POST")
		return
	}
	// 鉴权：自己给自己解锁
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	var req struct {
		GameID   uint   `json:"game_id"`
		Code     string `json:"achievement_code"`
		ClientTs int64  `json:"client_ts"` // 客户端 Unix 秒时间戳（可选，用于时间窗口校验 + 签名）
		Nonce    string `json:"nonce"`     // 客户端随机串（可选，用于防重放 + 签名）
	}
	// P2-c：签名校验需要读取原始 body 算 SHA256；先 ReadAll 再 json.Decode
	bodyBytes, _ := io.ReadAll(r.Body)
	if len(bodyBytes) == 0 {
		profileFail(w, "参数不完整")
		return
	}
	if err := json.Unmarshal(bodyBytes, &req); err != nil || req.GameID == 0 || req.Code == "" {
		profileFail(w, "参数不完整")
		return
	}
	// R5 输入上限（与 DB 字段宽度一致，防恶意大串）
	if len(req.Code) > 64 {
		profileFail(w, "成就标识过长")
		return
	}
	if len(req.Nonce) > 128 {
		profileFail(w, "nonce 过长")
		return
	}

	// ① 查成就定义
	var ach model.GameAchievement
	if err := store.DB.Where("game_id = ? AND code = ?", req.GameID, req.Code).First(&ach).Error; err != nil {
		profileFail(w, "成就不存在")
		return
	}

	// ② 游戏在库校验（E1 核心防刷：不能解锁未入库游戏的成就）
	if !achIsGameInLibrary(username, req.GameID) {
		profileFail(w, "该游戏尚未加入您的游戏库，无法解锁其成就")
		return
	}

	// ③ 防重放 + 频率限制（E1）；nonce 为空时降级为纯限流
	if req.Nonce != "" {
		if ok, reason := achCheckReplayAndRateLimit(username, req.Nonce, req.ClientTs, 300, 60, 10); !ok {
			profileFail(w, reason)
			return
		}
	} else {
		if ok, reason := achCheckReplayAndRateLimit(username, "", req.ClientTs, 300, 60, 10); !ok {
			profileFail(w, reason)
			return
		}
	}

	// P2-c：HMAC-SHA256 签名校验（方案 §14.2 会话密钥优先 + 降级开关，单一 canonicalMessage 构造）：
	//   canonicalMessage = client_ts + "\n" + nonce + "\n" + sha256(bodyBytes)_hex
	//   signature         = hex(hmac_sha256(session_sign_key, canonicalMessage))
	//   客户端放 header: X-Game-Signature（密钥来自游戏库/详情下发的 session_sign_key）
	if !achVerifySignature(username, req.GameID, req.ClientTs, req.Nonce, bodyBytes, r.Header.Get("X-Game-Signature")) {
		profileFail(w, "签名校验失败"); return
	}

	// ④ 事务化幂等 + 经验值增量（公共核心 achUnlockCore：HTTP 上报与自动引擎同一入口，防逻辑漂移）
	already, expGain, newExp, newLevel, levelUp, err := achUnlockCore(username, ach)
	if err != nil {
		profileFail(w, "保存失败")
		return
	}
	if already {
		// 已解锁（幂等）：静默成功（链路 B 重试/多端并发上报不打扰用户）
		profileOK(w, map[string]interface{}{"unlocked": true, "already": true})
		return
	}

	// 实时推送全部在线端（PC/Web 弹成就 toast；不落库不进离线队列，历史走资料页成就列表）
	s.pushAchievementUnlocked(username, ach, expGain, levelUp, newLevel)

	profileOK(w, map[string]interface{}{
		"unlocked": true, "exp_gain": expGain, "new_exp": newExp,
		"level_up": levelUp, "new_level": newLevel,
		// 成就详情（链路 B 桥接上报方所在窗口无 WS，凭此块本地弹 toast，免二次查询）
		"achievement": map[string]interface{}{
			"game_id": ach.GameID, "code": ach.Code, "name": ach.Name,
			"desc": ach.Desc, "icon": ach.Icon, "rarity": ach.Rarity,
		},
	})
}

// achUnlockCore 成就解锁公共核心（方案 §14.3.1 抽取：HTTP 上报与自动引擎共用唯一入口，避免逻辑漂移）
// 事务化幂等：OnConflict DoNothing 消并发冲突 + FOR UPDATE 行锁 exp 原子增量 + 升级自动发等级徽章
// 返回 (already 已解锁与否, expGain 获得经验, newExp 新总经验, newLevel 新等级, levelUp 是否升级, err)
func achUnlockCore(username string, ach model.GameAchievement) (bool, int, int64, int, bool, error) {
	var already bool
	var expGain int
	var newExp int64
	var newLevel int
	var levelUp bool

	err := store.DB.Transaction(func(tx *gorm.DB) error {
		// R2+R3: OnConflict DoNothing 原子处理并发冲突（唯一索引兜底）
		unlock := model.UserAchievement{
			Username: username, GameID: ach.GameID, AchievementID: ach.ID,
		}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&unlock)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			// 已存在 → 幂等返回（事务正常提交，不报错）
			already = true
			return nil
		}

		// R1: FOR UPDATE 行锁 + exp 原子增量（read-modify-write 无竞态）
		var user model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&user).Error; err != nil {
			return err
		}
		expGain = ach.ExpReward
		newExp = user.Exp + int64(expGain)
		newLevel = calcLevelFromExp(int(newExp))
		levelUp = newLevel > user.Level

		updates := map[string]interface{}{"exp": newExp}
		if levelUp {
			updates["level"] = newLevel
			// R2: 等级徽章也用 OnConflict DoNothing 防并发重复发
			tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserBadge{
				Username: username, Type: "level",
				Code: "lv" + strconv.Itoa(newLevel),
				Name: "等级 " + strconv.Itoa(newLevel),
				Icon: "", Desc: "个人等级徽章",
			})
		}
		if err := tx.Model(&user).Updates(updates).Error; err != nil {
			return err
		}

		// 经验值日志（事务内保证原子性）
		tx.Create(&model.ProfileExpLog{
			Username: username, Change: expGain, Reason: "unlock_achievement",
			Detail:  "解锁成就 " + ach.Name,
		})
		return nil
	})
	if err != nil {
		return false, 0, 0, 0, false, err
	}
	return already, expGain, newExp, newLevel, levelUp, nil
}

// AchievementUnlockPush 成就解锁 WS 推送载荷（方案 §14.3.3 协议，msg_type=122）
type AchievementUnlockPush struct {
	GameID   uint   `json:"game_id"`
	Code     string `json:"code"`
	Name     string `json:"name"`
	Desc     string `json:"desc"`
	Icon     string `json:"icon"`
	Rarity   int8   `json:"rarity"`
	ExpReward int  `json:"exp_reward"`
	LevelUp  bool   `json:"level_up"`
	NewLevel int    `json:"new_level"`
}

// pushAchievementUnlocked 成就解锁实时推送归口：该用户全部在线端（PC/Web/APP），
// 由 sendToUser 按 username 广播（集群模式走总线定向信封）。不落库不进离线队列：
// 历史成就走资料页成就列表，仅推实时解锁（防离线补推轰炸）
func (s *Server) pushAchievementUnlocked(username string, ach model.GameAchievement, expGain int, levelUp bool, newLevel int) {
	content, _ := json.Marshal(AchievementUnlockPush{
		GameID: ach.GameID, Code: ach.Code, Name: ach.Name, Desc: ach.Desc,
		Icon: ach.Icon, Rarity: ach.Rarity, ExpReward: expGain,
		LevelUp: levelUp, NewLevel: newLevel,
	})
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeAchievementUnlock,
		ToUser:    username,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, data)
}

// calcLevelFromExp 服务端等级反推（经验公式：Level(N) = 最大 N 使 500*N² <= exp）
// 与前端 game-store.js levelExpRequired/calcLevelFromExp 口径严格一致
func calcLevelFromExp(exp int) int {
	n := 1
	for 500*(n+1)*(n+1) <= exp { n++ }
	return n
}

// getLevelPerks 按用户等级查等级权益（P0：展示柜槽位 / 称号 / 下一级需求）
// 优先查 UserLevelConfig（seed 预设）；查不到的等级兜底：3 槽位
func getLevelPerks(level int) ProfileLevelPerksResp {
	// 找 ≤ 当前等级 的最高配置行
	var cfg model.UserLevelConfig
	err := store.DB.Where("level <= ?", level).Order("level DESC").First(&cfg).Error

	// 找下一级配置（展示 next_exp_required）
	var nextCfg model.UserLevelConfig
	_ = store.DB.Where("level > ?", level).Order("level ASC").First(&nextCfg).Error

	// 配置表最高等级
	var maxLevel int
	store.DB.Model(&model.UserLevelConfig{}).Select("COALESCE(MAX(level), 50)").Scan(&maxLevel)

	slots := 3
	title := ""
	expReq := int64(0)
	if err == nil {
		slots = cfg.ShowcaseSlots
		title = cfg.Title
		expReq = cfg.ExpRequired
	}

	nextExp := int64(0)
	if nextCfg.Level > 0 {
		nextExp = nextCfg.ExpRequired
	}

	return ProfileLevelPerksResp{
		ShowcaseSlots: slots,
		Title:         title,
		CurrentLevel:  level,
		ExpRequired:   expReq,
		NextLevelExp:  nextExp,
		MaxLevel:      maxLevel,
	}
}

// ==================== 阶段二百九十五 P1.5：成就查看页 ====================

// AchievementGroup 成就按游戏分组
type AchievementGroup struct {
	GameID   uint              `json:"game_id"`
	GameName string            `json:"game_name"`
	Unlocked int               `json:"unlocked"`
	Total    int               `json:"total"`
	Items    []AchievementItem `json:"items"`
}

// AchievementItem 单条成就（含解锁状态）
type AchievementItem struct {
	ID          uint   `json:"id"`
	Code        string `json:"code"`
	Name        string `json:"name"`
	Desc        string `json:"desc"`
	Icon        string `json:"icon"`
	Rarity      int8   `json:"rarity"`
	ExpReward   int    `json:"exp_reward"`
	Unlocked    bool   `json:"unlocked"`
	UnlockTime  string `json:"unlock_time,omitempty"`
}

// HandleProfileAchievementsGet GET /api/profile/achievements?username=xxx&game_id=0
// game_id=0 返回全部成就（按游戏分组）；game_id>0 返回指定游戏的成就
// 返回：{ groups: [{game_id, game_name, unlocked, total, items: [{成就详情+解锁状态}]}], viewer_is_self }
func (s *Server) HandleProfileAchievementsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)

	// 1. 用户存在
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 2. 隐私过滤（GameVisibility 扁平公式：0=私密 1=仅好友 2=公开）
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	canSeeGame := isSelf || u.GameVisibility == 2 || (u.GameVisibility == 1 && isFriend)
	if !canSeeGame {
		profileOK(w, map[string]interface{}{
			"groups":      []interface{}{},
			"unlocked":    0,
			"total":       0,
			"viewer_self": isSelf,
		})
		return
	}

	// 3. 查成就定义（GameAchievement 表）
	var achDefs []model.GameAchievement
	q := store.DB
	if gameID > 0 {
		q = q.Where("game_id = ?", gameID)
	}
	if err := q.Find(&achDefs).Error; err != nil {
		profileFail(w, "查询成就失败"); return
	}

	// 4. 查用户已解锁成就（UserAchievement 表）
	var unlocked []model.UserAchievement
	uq := store.DB.Where("username = ?", target)
	if gameID > 0 {
		uq = uq.Where("game_id = ?", gameID)
	}
	if err := uq.Find(&unlocked).Error; err != nil {
		profileFail(w, "查询解锁记录失败"); return
	}

	// 5. 构建解锁 Map: key=game_id:achievement_id → UnlockTime
	unlockMap := make(map[string]time.Time, len(unlocked))
	for _, ua := range unlocked {
		key := strconv.FormatUint(uint64(ua.GameID), 10) + ":" + strconv.FormatUint(uint64(ua.AchievementID), 10)
		unlockMap[key] = ua.UnlockTime
	}

	// 6. 按 game_id 分组
	type gameBucket struct {
		gameID  uint
		items   []AchievementItem
	}
	buckets := make(map[uint]*gameBucket)
	var order []uint
	for _, a := range achDefs {
		b, ok := buckets[a.GameID]
		if !ok {
			b = &gameBucket{gameID: a.GameID}
			buckets[a.GameID] = b
			order = append(order, a.GameID)
		}
		key := strconv.FormatUint(uint64(a.GameID), 10) + ":" + strconv.FormatUint(uint64(a.ID), 10)
		unlockTimeStr := ""
		unlockedFlag := false
		if t, exists := unlockMap[key]; exists {
			unlockedFlag = true
			unlockTimeStr = t.Format("2006-01-02 15:04")
		}
		b.items = append(b.items, AchievementItem{
			ID: a.ID, Code: a.Code, Name: a.Name, Desc: a.Desc,
			Icon: a.Icon, Rarity: a.Rarity, ExpReward: a.ExpReward,
			Unlocked: unlockedFlag, UnlockTime: unlockTimeStr,
		})
	}

	// 7. 批量查游戏名（避免 N+1）
	var gameIDs []uint
	for _, gid := range order { gameIDs = append(gameIDs, gid) }
	gameNames := make(map[uint]string)
	if len(gameIDs) > 0 {
		var games []model.Game
		if err := store.DB.Where("id IN ?", gameIDs).Find(&games).Error; err == nil {
			for _, g := range games { gameNames[g.ID] = g.Name }
		}
	}

	// 8. 组装响应 + 统计总数
	var groups []AchievementGroup
	totalUnlocked := 0
	totalCount := 0
	for _, gid := range order {
		b := buckets[gid]
		uCount := 0
		for _, it := range b.items {
			if it.Unlocked { uCount++ }
		}
		groups = append(groups, AchievementGroup{
			GameID: gid, GameName: gameNames[gid],
			Unlocked: uCount, Total: len(b.items),
			Items: b.items,
		})
		totalUnlocked += uCount
		totalCount += len(b.items)
	}

	profileOK(w, map[string]interface{}{
		"groups":      groups,
		"unlocked":    totalUnlocked,
		"total":       totalCount,
		"viewer_self": isSelf,
	})
}

// ==================== P2：用户评测列表（资料页展示柜用） ====================

// HandleProfileReviewsGet GET /api/profile/reviews?username=xxx&limit=6
// 返回该用户写过的所有评测（跨游戏），按时间倒序，默认取最近 6 条
// 隐私：复用 ProfileVisibility 过滤（私密/仅好友时返回空）
func (s *Server) HandleProfileReviewsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 50 { limit = 6 }

	// 1. 用户存在
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 2. 隐私过滤（ProfileVisibility 扁平公式，与 HandleProfileGet 同口径）
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, map[string]interface{}{"list": []interface{}{}, "total": 0})
		return
	}

	// 查用户评测
	var reviews []model.GameReview
	store.DB.Where("username = ?", target).
		Order("create_time DESC").
		Limit(limit).
		Find(&reviews)

	// 总数
	var total int64
	store.DB.Model(&model.GameReview{}).Where("username = ?", target).Count(&total)

	// 批量查游戏名（避免 N+1）
	gids := make([]uint, 0, len(reviews))
	for _, rv := range reviews { gids = append(gids, rv.GameID) }
	gameNames := make(map[uint]string)
	if len(gids) > 0 {
		var games []model.Game
		if err := store.DB.Select("id", "name").Where("id IN ?", gids).Find(&games).Error; err == nil {
			for _, g := range games { gameNames[g.ID] = g.Name }
		}
	}

	// 组装响应
	list := make([]map[string]interface{}, 0, len(reviews))
	for _, rv := range reviews {
		list = append(list, map[string]interface{}{
			"id":          rv.ID,
			"game_id":     rv.GameID,
			"game_name":   gameNames[rv.GameID],
			"recommended": rv.Recommended,
			"content":     rv.Content,
			"play_hours":  rv.PlayHours,
			"helpful":     rv.HelpfulCount,
			"create_time": rv.CreateTime,
		})
	}

	profileOK(w, map[string]interface{}{
		"list":  list,
		"total": total,
	})
}

// ==================== P2.3：截图/艺术作品展示柜 ====================

var screenshotExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

// HandleProfileScreenshotUpload POST /api/profile/screenshot
// multipart 上传截图/艺术作品到个人资料展示柜；需登录
func (s *Server) HandleProfileScreenshotUpload(w http.ResponseWriter, r *http.Request) {
	username, _ := gameAuthToken(r)
	if username == "" { profileFail(w, "请先登录"); return }

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		profileFail(w, "参数错误"); return
	}
	file, header, err := r.FormFile("file")
	if err != nil { profileFail(w, "缺少文件"); return }
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !screenshotExts[ext] { profileFail(w, "仅支持 png/jpg/jpeg/gif/webp"); return }
	if header.Size > 10<<20 { profileFail(w, "图片超出 10MB 上限"); return }
	// MIME sniff：读取前 512 字节做真实类型校验（防改扩展名绕过）
	sniff := make([]byte, 512)
	sniffN, _ := file.Read(sniff)
	detected := http.DetectContentType(sniff[:sniffN])
	allowed := map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true,
		"image/webp": true, "image/x-webp": true,
	}
	if !allowed[detected] { profileFail(w, "文件类型不匹配："+detected); return }
	// 重置文件指针
	if seeker, ok := file.(io.Seeker); ok { seeker.Seek(0, io.SeekStart) }

	ssType := r.FormValue("type")
	if ssType != "artwork" { ssType = "screenshot" }
	title := r.FormValue("title")
	gameID, _ := strconv.ParseUint(r.FormValue("game_id"), 10, 64)

	dir := filepath.Join(s.cfg.WebDir, "static", "upload", "screenshots")
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		profileFail(w, "目录创建失败"); return
	}
	b := make([]byte, 6)
	rand.Read(b)
	name := fmt.Sprintf("ss%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dst, err := os.Create(filepath.Join(dir, name))
	if err != nil { profileFail(w, "文件写入失败"); return }
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(filepath.Join(dir, name))
		profileFail(w, "文件写入失败"); return
	}
	url := "/static/upload/screenshots/" + name

	ss := model.ProfileScreenshot{
		Username: username, Type: ssType, URL: url,
		Title: title, GameID: uint(gameID),
	}

	expGain := 5 // 上传截图 +5 EXP
	var newExp int64
	var newLevel int
	var levelUp bool

	err = store.DB.Transaction(func(tx *gorm.DB) error {
		// 1. 创建截图记录
		if err := tx.Create(&ss).Error; err != nil {
			return err
		}
		// 2. 给用户加经验（行锁防并发）
		var user model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&user).Error; err != nil {
			return err // 登录用户必然存在；FOR UPDATE 失败意味着数据库异常，整体回滚
		}
		newExp := user.Exp + int64(expGain)
		newLevel = calcLevelFromExp(int(newExp))
		levelUp = newLevel > user.Level
		updates := map[string]interface{}{"exp": newExp}
		if levelUp {
			updates["level"] = newLevel
			// 等级徽章 OnConflict DoNothing 防并发重复发（同 achUnlockCore）
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserBadge{
				Username: user.Username, Type: "level",
				Code: "lv" + strconv.Itoa(newLevel),
				Name: "等级 " + strconv.Itoa(newLevel),
				Icon: "", Desc: "个人等级徽章",
			}).Error; err != nil {
				return err
			}
		}
		if err := tx.Model(&user).Updates(updates).Error; err != nil {
			return err
		}
		// 3. 经验日志
		return tx.Create(&model.ProfileExpLog{
			Username: username, Change: expGain, Reason: "upload_screenshot",
			Detail:  "上传截图" + func() string {
				if title != "" { return "「" + title + "」" }
				return ""
			}(),
		}).Error
	})
	if err != nil {
		os.Remove(filepath.Join(dir, name))
		profileFail(w, "数据库写入失败: "+err.Error()); return
	}

	// WS 推送经验变动帧给该用户全部在线端（主窗口/游戏中心窗弹 toast + 桌面通知）
	// code 使用 ss.ID 生成唯一键，前端 6秒去重窗口吞掉本地回调和 WS 推送的重复
	expCode := fmt.Sprintf("upload_screenshot_%d", ss.ID)
	expName := "上传截图"
	if ssType == "artwork" {
		expName = "上传艺术作品"
	}
	expDesc := name
	if title != "" {
		expDesc = title
	}
	expPayload, _ := json.Marshal(map[string]interface{}{
		"reason":     "upload_screenshot",
		"code":       expCode,
		"name":       expName,
		"desc":       expDesc,
		"exp_reward": expGain,
		"level_up":   levelUp,
		"new_level":  newLevel,
	})
	wsData, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeExpGainPush,
		ToUser:    username,
		Content:   string(expPayload),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, wsData)

	resp := map[string]interface{}{
		"id": ss.ID, "url": url,
		"exp_gain": expGain,
		"new_exp":  newExp,
		"exp_code": expCode, // 供前端本地回调去重用
	}
	if levelUp {
		resp["level_up"] = true
		resp["new_level"] = newLevel
	}
	profileOK(w, resp)
}

// HandleProfileScreenshotsGet GET /api/profile/screenshots?username=xxx&type=all
// 返回用户截图/艺术作品列表（按 create_time 倒序）；已登录时附带每张截图的 liked 状态
func (s *Server) HandleProfileScreenshotsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }

	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 隐私过滤（ProfileVisibility 扁平公式，与 HandleProfileGet 同口径）
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, map[string]interface{}{"list": []interface{}{}}); return
	}

	ssType := r.URL.Query().Get("type")
	q := store.DB.Where("username = ?", target)
	if ssType == "screenshot" || ssType == "artwork" {
		q = q.Where("type = ?", ssType)
	}
	var list []model.ProfileScreenshot
	q.Order("create_time DESC").Find(&list)

	// 如果有 viewer（已登录），查询他对每张截图是否已点赞
	likedMap := make(map[uint]bool)
	if viewer != "" && len(list) > 0 {
		ids := make([]uint, 0, len(list))
		for _, ss := range list {
			ids = append(ids, ss.ID)
		}
		var likes []model.ProfileScreenshotLike
		store.DB.Where("screenshot_id IN ? AND username = ?", ids, viewer).Find(&likes)
		for _, l := range likes {
			likedMap[l.ScreenshotID] = true
		}
	}

	// 组装返回列表（附加 liked 字段）
	type ssResp struct {
		model.ProfileScreenshot
		Liked bool `json:"liked"`
	}
	resp := make([]ssResp, 0, len(list))
	for _, ss := range list {
		resp = append(resp, ssResp{ProfileScreenshot: ss, Liked: likedMap[ss.ID]})
	}
	profileOK(w, map[string]interface{}{"list": resp})
}

// HandleProfileScreenshotLike POST /api/profile/screenshot/like
// 截图/艺术作品点赞 toggle（唯一索引幂等：未点插入+1 + 作者 +2 exp；已点删除-1；
// 取消点赞不扣经验——避免赞→取消循环刷）；不能赞自己的图——Steam 同款。
func (s *Server) HandleProfileScreenshotLike(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		profileFail(w, "只支持 POST"); return
	}
	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	var req struct {
		ScreenshotID uint `json:"screenshot_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ScreenshotID == 0 {
		profileFail(w, "参数错误"); return
	}

	// ① 查截图是否存在
	var shot model.ProfileScreenshot
	if err := store.DB.Where("id = ?", req.ScreenshotID).First(&shot).Error; err != nil {
		profileFail(w, "截图不存在"); return
	}
	// 不能赞自己的
	if shot.Username == username {
		profileFail(w, "不能点赞自己的截图"); return
	}

	// ② 事务 toggle + 给作者发经验值（新增点赞时 +2 exp，取消不扣）
	var liked bool
	var expGain int
	var authorLevelUp bool
	var authorNewLevel int
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		// FOR UPDATE 锁截图行
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&shot, req.ScreenshotID).Error; err != nil {
			return err
		}

		var exist model.ProfileScreenshotLike
		err := tx.Where("screenshot_id = ? AND username = ?", req.ScreenshotID, username).First(&exist).Error
		if err != nil {
			// 未点过 → 新增 + 计数 + 给作者发经验
			if err := tx.Create(&model.ProfileScreenshotLike{ScreenshotID: req.ScreenshotID, Username: username}).Error; err != nil {
				return err
			}
			tx.Model(&model.ProfileScreenshot{}).Where("id = ?", req.ScreenshotID).
				UpdateColumn("like_count", gorm.Expr("like_count + 1"))
			liked = true
			// 给作者 +2 exp（只在新增时发，取消不扣）
			expGain = 2
			var author model.User
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("username = ?", shot.Username).First(&author).Error; err != nil {
				return nil // 作者用户不存在（理论上不会），经验不发但点赞仍生效
			}
			newExp := author.Exp + int64(expGain)
			newLevel := calcLevelFromExp(int(newExp))
			levelUp := newLevel > author.Level
			authorLevelUp = levelUp
			authorNewLevel = newLevel
			updates := map[string]interface{}{"exp": newExp}
			if levelUp { updates["level"] = newLevel }
			tx.Model(&author).Updates(updates)
			tx.Create(&model.ProfileExpLog{
				Username: shot.Username, Change: expGain, Reason: "screenshot_like",
				Detail:  "截图被 " + username + " 点赞",
			})
			if levelUp {
				tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserBadge{
					Username: author.Username, Type: "level",
					Code: "lv" + strconv.Itoa(newLevel),
					Name: "等级 " + strconv.Itoa(newLevel),
					Icon: "", Desc: "个人等级徽章",
				})
			}
		} else {
			// 已点过 → 取消 + 计数 -1（经验不扣）
			tx.Delete(&exist)
			tx.Model(&model.ProfileScreenshot{}).Where("id = ?", req.ScreenshotID).
				UpdateColumn("like_count", gorm.Expr("GREATEST(like_count - 1, 0)"))
			liked = false
		}
		return nil
	})
	if err != nil {
		profileFail(w, "操作失败"); return
	}

	// 重新查最新计数
	store.DB.First(&shot, req.ScreenshotID)

	// ③ 新增点赞时，WS 推送经验变动帧给作者（全部在线端弹 toast + 桌面通知）
	// code 使用 screenshot_id + 点赞人 生成唯一键，前端 6秒去重窗口吞掉重复
	if expGain > 0 && shot.Username != "" {
		expCode := fmt.Sprintf("screenshot_like_%d_%s", req.ScreenshotID, username)
		expDesc := username + " 点赞了你的截图"
		if shot.Title != "" {
			expDesc = username + " 点赞了你的「" + shot.Title + "」"
		}
		expPayload, _ := json.Marshal(map[string]interface{}{
			"reason":     "screenshot_like",
			"code":       expCode,
			"name":       "截图获得点赞",
			"desc":       expDesc,
			"exp_reward": expGain,
			"level_up":   authorLevelUp,
			"new_level":  authorNewLevel,
		})
		wsData, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeExpGainPush,
			ToUser:    shot.Username,
			Content:   string(expPayload),
			Timestamp: time.Now().Unix(),
		})
		s.sendToUser(shot.Username, wsData)
	}

	profileOK(w, map[string]interface{}{
		"liked":      liked,
		"like_count": shot.LikeCount,
		"exp_gain":   expGain, // 0=取消点赞无经验；>0=新增点赞给作者的经验
	})
}

// HandleProfileScreenshotView POST /api/profile/screenshot/view
// 浏览量累加：前端点击查看大图时调用，view_count + 1
// 不强制登录（游客也能浏览计数），防刷：同一 IP 30 秒内对同一张截图只计一次
// 安全降级：Redis 不可用或故障时跳过累加，仅返回当前 view_count，防止被刷
func (s *Server) HandleProfileScreenshotView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		profileFail(w, "只支持 POST"); return
	}
	var req struct {
		ScreenshotID uint `json:"screenshot_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ScreenshotID == 0 {
		profileFail(w, "参数错误"); return
	}

	// 防刷：通过 Redis SETNX 实现 30 秒去重
	viewerIP := r.RemoteAddr
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		viewerIP = strings.Split(fwd, ",")[0]
	}
	redisKey := "ss_view:" + strconv.FormatUint(uint64(req.ScreenshotID), 10) + ":" + viewerIP

	var counted bool // true=本次计入；false=被防刷跳过或 Redis 不可用
	if store.RDB != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		ok, err := store.RDB.SetNX(ctx, redisKey, "1", 30*time.Second).Result()
		cancel()
		if err == nil && ok {
			// SETNX 成功 = 30 秒内第一次浏览 → 累加
			res := store.DB.Model(&model.ProfileScreenshot{}).
				Where("id = ?", req.ScreenshotID).
				UpdateColumn("view_count", gorm.Expr("view_count + 1"))
			if res.Error == nil && res.RowsAffected > 0 {
				counted = true
			}
			// RowsAffected==0 → 截图不存在，静默忽略
		}
		// err != nil（Redis 故障）或 ok=false（30s 内重复）→ counted 保持 false
	}
	// Redis 不可用 → counted=false（安全降级，不做无防刷累加）

	// 返回最新 view_count（一次查询足矣）
	var shot model.ProfileScreenshot
	store.DB.First(&shot, req.ScreenshotID)
	profileOK(w, map[string]interface{}{
		"view_count": shot.ViewCount,
		"counted":    counted,
	})
}

// HandleProfileScreenshotDelete POST /api/profile/screenshot/delete
// 作者删除自己的截图/艺术作品：事务清点赞 + 删主记录，然后删物理文件
// 安全：只允许作者本人删；SQL 参数化；删文件前校验 URL 路径合法（防路径穿越）
// 事务：清点赞 + 删主记录必须原子（包在同一个事务里），物理文件在事务外删除（不可回滚）
func (s *Server) HandleProfileScreenshotDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete && r.Method != http.MethodPost {
		profileFail(w, "只支持 DELETE/POST"); return
	}
	username, _ := gameAuthToken(r)
	if username == "" { profileFail(w, "请先登录"); return }

	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		// 也支持 JSON body
		var body struct { ID uint `json:"id"` }
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil && body.ID > 0 {
			idStr = strconv.FormatUint(uint64(body.ID), 10)
		}
	}
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 { profileFail(w, "id 必填"); return }

	var shot model.ProfileScreenshot
	if err := store.DB.First(&shot, id).Error; err != nil {
		profileFail(w, "截图不存在"); return
	}
	if shot.Username != username {
		profileFail(w, "无权删除他人的作品"); return
	}

	// 1. 事务原子清理：点赞关系 + 主记录（必须同时成功或同时回滚）
	if err := store.DB.Transaction(func(tx *gorm.DB) error {
		// 先清点赞关系（无外键 CASCADE，必须手动清）
		if err := tx.Where("screenshot_id = ?", shot.ID).Delete(&model.ProfileScreenshotLike{}).Error; err != nil {
			return err
		}
		// 再删主记录
		if err := tx.Delete(&shot).Error; err != nil {
			return err
		}
		return nil
	}); err != nil {
		profileFail(w, "删除失败："+err.Error()); return
	}

	// 2. 事务提交成功后再删物理文件（不可回滚，放在事务外）
	// 安全：从 DB 的 URL 字段取，校验必须在 screenshots 目录下（防路径穿越）
	if shot.URL != "" {
		base := filepath.Join(s.cfg.WebDir, "static", "upload", "screenshots")
		fname := filepath.Base(shot.URL) // 取最后一段文件名
		// 二次校验：拒绝含 / \ .. 的恶意路径
		if !strings.ContainsAny(fname, "/\\..") {
			full := filepath.Join(base, fname)
			// 确保 full 仍在 base 目录下
			if strings.HasPrefix(filepath.Clean(full), filepath.Clean(base)) {
				os.Remove(full) // 文件不存在也不报错
			}
		}
	}

	profileOK(w, map[string]interface{}{"id": shot.ID})
}

// ==================== custom_html 展示柜安全清洗 ====================

// Go regexp（RE2 引擎）不支持反向引用 \1，所以危险标签成对匹配必须用显式 alternation 列出每一对
// 成对：<tag[^>]*>.*?</tag>；自闭合：<tag[^>]*/?>
var (
	// 清洗顺序：注释 → script/style → 危险标签（成对+自闭合）→ on* 事件属性 → 危险协议
	sanitizeCommentRe = regexp.MustCompile(`<!--.*?-->`)
	sanitizeScriptRe  = regexp.MustCompile(`(?i)<\s*script[^>]*>.*?<\s*/\s*script\s*>`)
	sanitizeStyleRe   = regexp.MustCompile(`(?i)<\s*style[^>]*>.*?<\s*/\s*style\s*>`)

	// 成对危险标签：显式 alternation（RE2 不支持 \1 反向引用，必须枚举出每一对）
	sanitizeDangerPairRe = regexp.MustCompile(`(?i)` +
		`<\s*iframe[^>]*>.*?<\s*/\s*iframe\s*>|` +
		`<\s*object[^>]*>.*?<\s*/\s*object\s*>|` +
		`<\s*embed[^>]*>.*?<\s*/\s*embed\s*>|` +
		`<\s*applet[^>]*>.*?<\s*/\s*applet\s*>|` +
		`<\s*form[^>]*>.*?<\s*/\s*form\s*>|` +
		`<\s*button[^>]*>.*?<\s*/\s*button\s*>|` +
		`<\s*textarea[^>]*>.*?<\s*/\s*textarea\s*>|` +
		`<\s*select[^>]*>.*?<\s*/\s*select\s*>|` +
		`<\s*noscript[^>]*>.*?<\s*/\s*noscript\s*>|` +
		`<\s*xmp[^>]*>.*?<\s*/\s*xmp\s*>|` +
		`<\s*template[^>]*>.*?<\s*/\s*template\s*>|` +
		`<\s*slot[^>]*>.*?<\s*/\s*slot\s*>|` +
		`<\s*frameset[^>]*>.*?<\s*/\s*frameset\s*>|` +
		`<\s*frame[^>]*>.*?<\s*/\s*frame\s*>`)

	// 自闭合/单标签危险：input / link / meta / base / body / head / html / title 等
	// 注意：img 不在此列（安全标签），onerror 交给 sanitizeEventAttrRe 单独移除
	sanitizeDangerSingleRe = regexp.MustCompile(`(?i)<\s*(input|link|meta|base|body|head|html|title)\b[^>]*/?>`)

	sanitizeEventAttrRe = regexp.MustCompile(`(?i)\son[a-zA-Z]+\s*=\s*"[^"]*"|\son[a-zA-Z]+\s*=\s*'[^']*'|\son[a-zA-Z]+\s*=\s*[^\s>]+`)

	sanitizeJSProtoRe  = regexp.MustCompile(`(?i)(href|src|action|formaction|xlink:href)\s*=\s*"(javascript|vbscript|data)\s*:[^"]*"`)
	sanitizeJSProtoRe2 = regexp.MustCompile(`(?i)(href|src|action|formaction|xlink:href)\s*=\s*'(javascript|vbscript|data)\s*:[^']*'`)
)

// sanitizeCustomHTML 清洗用户提交的自定义展示柜 HTML，防 XSS
// 清洗策略：移除所有危险标签和属性，只保留安全的排版/展示 HTML
func sanitizeCustomHTML(html string) string {
	if html == "" {
		return ""
	}

	// 1. HTML 注释（可能藏 <script>）
	html = sanitizeCommentRe.ReplaceAllString(html, "")

	// 2. <script> / <style> 整块
	html = sanitizeScriptRe.ReplaceAllString(html, "")
	html = sanitizeStyleRe.ReplaceAllString(html, "")

	// 3. 危险标签（成对 + 自闭合）
	html = sanitizeDangerPairRe.ReplaceAllString(html, "")
	html = sanitizeDangerSingleRe.ReplaceAllString(html, "")

	// 4. 所有 on* 事件属性（onclick/onerror/onload/onmouseover 等）
	html = sanitizeEventAttrRe.ReplaceAllString(html, "")

	// 5. javascript:/vbscript:/data: 协议
	html = sanitizeJSProtoRe.ReplaceAllString(html, `"#"`)
	html = sanitizeJSProtoRe2.ReplaceAllString(html, `'#'`)

	// 6. 裁剪空白
	html = strings.TrimSpace(html)

	return html
}

// ==================== 阶段二百九十五 P1：展示柜 CRUD ====================

// HandleProfileShowcaseGet GET /api/profile/showcase?username=xxx
// 获取用户展示柜配置列表（按 slot 升序）；自己看全部，他人按隐私过滤
func (s *Server) HandleProfileShowcaseGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }

	// 隐私可见性判断（ProfileVisibility 扁平公式，与 HandleProfileGet 同口径）
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, []interface{}{}); return
	}

	var rows []model.ProfileShowcase
	store.DB.Where("username = ? AND enabled = 1", target).
		Order("slot ASC").Find(&rows)
	profileOK(w, rows)
}

// HandleProfileShowcasePut PUT /api/profile/showcase 保存展示柜配置（整包提交）
// 请求体：{ "items": [ { "slot": 1, "type": "recent_games", "title": "", "config": "{...}" } ] }
// 鉴权：只能改自己的（guardGame 归口）
// 原子事务：Delete + Create 包裹在单个事务里，避免中途失败丢全部配置（B1 高优）
func (s *Server) HandleProfileShowcasePut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []struct {
			Slot   int    `json:"slot"`
			Type   string `json:"type"`
			Title  string `json:"title"`
			Config string `json:"config"`
		} `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		profileFail(w, "JSON 格式错误"); return
	}

	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	// P0 等级权益：查用户等级 → UserLevelConfig.ShowcaseSlots（默认 3）
	var user model.User
	if err := store.DB.Where("username = ?", username).First(&user).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}
	perks := getLevelPerks(user.Level)
	maxSlots := perks.ShowcaseSlots

	// B2: 数量上限校验 —— 不能超过 maxSlots + 10 防御性宽松（防止恶意传 10000 条）
	if len(body.Items) > maxSlots+10 {
		profileFail(w, "展示柜槽位提交过多"); return
	}

	// 白名单校验 type（防前端传非法类型）
	validTypes := map[string]bool{
		"recent_games": true, "favorite_game": true, "achievements": true,
		"badges": true, "screenshots": true, "artwork": true,
		"reviews": true, "friends": true, "custom_html": true, "cards": true,
	}
	// custom_html 需要 Lv30+ 权益
	customHTMLRequiresLevel := 30

	// B1 高优：事务包裹 Delete + Create —— 保证原子性，中途任何 Create 失败会自动回滚 Delete
	tx := store.DB.Begin()
	defer func() {
		if r := recover(); r != nil { tx.Rollback() }
	}()

	// 清空前用户所有展示柜
	if err := tx.Where("username = ?", username).Delete(&model.ProfileShowcase{}).Error; err != nil {
		tx.Rollback()
		profileFail(w, "保存失败，请稍后重试"); return
	}

	savedCount := 0
	for _, it := range body.Items {
		// P0 等级权益校验：slot 超出当前等级允许上限 → 跳过不保存（前端已限制，后端二次兜）
		if it.Slot < 1 || it.Slot > maxSlots { continue }
		if !validTypes[it.Type] { continue }

		// custom_html 等级门槛：Lv30+ 才能使用
		if it.Type == "custom_html" && user.Level < customHTMLRequiresLevel {
			continue
		}

		// Config 字段校验
		if it.Config != "" {
			if it.Type == "custom_html" {
				// custom_html 的 config 直接存 HTML 内容，不是 JSON；做长度上限（8KB）和安全清洗
				if len(it.Config) > 8192 {
					it.Config = it.Config[:8192]
				}
				// 移除 <script> 标签和事件处理器属性（XSS 基础防护）
				it.Config = sanitizeCustomHTML(it.Config)
				if it.Config == "" {
					continue // 清洗后为空 → 跳过
				}
			} else {
				// 其他类型：config 必须是合法 JSON
				var js interface{}
				if err := json.Unmarshal([]byte(it.Config), &js); err != nil {
					continue // 非法 JSON 跳过这条，不影响其他
				}
			}
		}
		// B4: Title 长度上限（model varchar(64)，DB 会静默截断，这里防御性跳过）
		if len(it.Title) > 64 { it.Title = it.Title[:64] }

		if err := tx.Create(&model.ProfileShowcase{
			Username: username, Slot: it.Slot, Type: it.Type,
			Title: it.Title, Config: it.Config, Enabled: 1, SortOrder: it.Slot,
		}).Error; err != nil {
			tx.Rollback()
			profileFail(w, "保存失败，请稍后重试"); return
		}
		savedCount++
	}

	if err := tx.Commit().Error; err != nil {
		profileFail(w, "保存失败，请稍后重试"); return
	}

	profileOK(w, map[string]interface{}{
		"saved": true, "max_slots": maxSlots, "level": user.Level, "saved_count": savedCount,
	})
}

// ==================== 阶段二百九十五 P1：留言板 CRUD ====================

// HandleProfileCommentsGet GET /api/profile/comments?username=xxx&page=1
// 分页获取顶层留言（每页 20 条，倒序）；每条带直接回复（最多 5 条）
func (s *Server) HandleProfileCommentsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 { page = 1 }
	size := 20
	offset := (page - 1) * size

	// 隐私：资料主人关闭留言 → 返回空
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}
	if u.CommentEnabled == 0 {
		profileOK(w, map[string]interface{}{
			"list": []interface{}{}, "total": 0, "page": page, "can_comment": false,
		}); return
	}

	// E2 补齐：ProfileVisibility 过滤（资料私密/仅好友时陌生人不应看到留言板）
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, map[string]interface{}{
			"list": []interface{}{}, "total": 0, "page": page, "can_comment": false,
		}); return
	}

	// 查顶层留言（parent_id=0, deleted=0）按时间倒序
	var roots []model.ProfileComment
	store.DB.Where("profile_user = ? AND parent_id = 0 AND deleted = 0", target).
		Order("create_time DESC").Offset(offset).Limit(size).Find(&roots)

	// 批量查回复（parent_id IN roots 的 id，deleted=0）
	rootIDs := make([]uint, 0, len(roots))
	for _, r := range roots { rootIDs = append(rootIDs, r.ID) }

	type CommentRow struct {
		model.ProfileComment
		FromNickname string `json:"from_nickname"`
		FromAvatar   string `json:"from_avatar"`
		ProfileNickname string `json:"profile_nickname"`
		Replies      []CommentRow `json:"replies,omitempty"`
	}
	result := make([]CommentRow, 0, len(roots))

	var replies []model.ProfileComment
	if len(rootIDs) > 0 {
		store.DB.Where("profile_user = ? AND parent_id IN ? AND deleted = 0", target, rootIDs).
			Order("create_time ASC").Find(&replies)
	}
	replyMap := make(map[uint][]model.ProfileComment)
	for _, rp := range replies { replyMap[rp.ParentID] = append(replyMap[rp.ParentID], rp) }

	// 批量查用户昵称/头像（避免 N+1）
	var usernames []string
	usernamesSet := make(map[string]bool)
	for _, r := range roots { if !usernamesSet[r.FromUser] { usernamesSet[r.FromUser] = true; usernames = append(usernames, r.FromUser) } }
	for _, rp := range replies { if !usernamesSet[rp.FromUser] { usernamesSet[rp.FromUser] = true; usernames = append(usernames, rp.FromUser) } }
	userMap := make(map[string]*model.User)
	if len(usernames) > 0 {
		var users []model.User
		store.DB.Where("username IN ?", usernames).Find(&users)
		for i := range users { userMap[users[i].Username] = &users[i] }
	}

	nick := func(un string) string {
		if u, ok := userMap[un]; ok {
			if u.Nickname != "" { return u.Nickname }
			return u.Username
		}
		return un
	}
	av := func(un string) string {
		if u, ok := userMap[un]; ok { return u.Avatar }
		return ""
	}

	for _, r := range roots {
		cr := CommentRow{
			ProfileComment: r,
			FromNickname:   nick(r.FromUser),
			FromAvatar:     av(r.FromUser),
		}
		rps := replyMap[r.ID]
		for _, rp := range rps {
			cr.Replies = append(cr.Replies, CommentRow{
				ProfileComment: rp,
				FromNickname:   nick(rp.FromUser),
				FromAvatar:     av(rp.FromUser),
				ProfileNickname: nick(rp.ReplyTo),
			})
		}
		result = append(result, cr)
	}

	var total int64
	store.DB.Model(&model.ProfileComment{}).Where("profile_user = ? AND parent_id = 0 AND deleted = 0", target).Count(&total)

	profileOK(w, map[string]interface{}{
		"list": result, "total": total, "page": page, "can_comment": u.CommentEnabled == 1,
	})
}

// HandleProfileCommentsPost POST /api/profile/comments 发表留言（顶层 / 回复）
// 请求体：{ "profile_user": "xxx", "content": "..." , "parent_id": 0, "reply_to": "" }
func (s *Server) HandleProfileCommentsPost(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	var body struct {
		ProfileUser string `json:"profile_user"`
		Content     string `json:"content"`
		ParentID    uint   `json:"parent_id"`
		ReplyTo     string `json:"reply_to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil { profileFail(w, "参数错误"); return }
	if body.ProfileUser == "" { profileFail(w, "目标用户无效"); return }
	if len(body.Content) == 0 { profileFail(w, "留言内容不能为空"); return }
	// 纵深防御：后端强制 HTML 清洗（与评测同策略，复用 sanitizeReviewHTML）
	body.Content = strings.TrimSpace(sanitizeReviewHTML(body.Content))
	if body.Content == "" {
		profileFail(w, "留言内容不合法"); return
	}
	if utf8.RuneCountInString(body.Content) > 500 {
		profileFail(w, "留言内容最长 500 字"); return
	}

	// 1. 目标用户是否允许留言
	var u model.User
	if err := store.DB.Where("username = ?", body.ProfileUser).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}
	if u.CommentEnabled == 0 { profileFail(w, "对方关闭了留言"); return }

	// 2. 回复时 parent_id 必须存在且属于目标用户
	if body.ParentID > 0 {
		var parent model.ProfileComment
		if err := store.DB.Where("id = ? AND profile_user = ? AND deleted = 0", body.ParentID, body.ProfileUser).First(&parent).Error; err != nil {
			profileFail(w, "回复的留言不存在"); return
		}
		// 嵌套回复强制挂到同根（parent.parent_id=0 保持顶层结构扁平）
		if parent.ParentID != 0 {
			body.ParentID = parent.ParentID
			body.ReplyTo = parent.FromUser
		}
	}

	c := model.ProfileComment{
		ProfileUser: body.ProfileUser, FromUser: username, Content: body.Content,
		ParentID: body.ParentID, ReplyTo: body.ReplyTo, Deleted: 0,
	}
	if err := store.DB.Create(&c).Error; err != nil {
		profileFail(w, "发表失败"); return
	}
	profileOK(w, map[string]interface{}{"id": c.ID})
}

// HandleProfileCommentDelete DELETE /api/profile/comments/{id}
// 删除权限：资料主人 / 留言人本人（服务端强制校验，防越权）
func (s *Server) HandleProfileCommentDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	idStr := r.PathValue("id")
	if idStr == "" { profileFail(w, "留言 ID 缺失"); return }
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 { profileFail(w, "留言 ID 无效"); return }

	var c model.ProfileComment
	if err := store.DB.Where("id = ? AND deleted = 0", id).First(&c).Error; err != nil {
		profileFail(w, "留言不存在或已删除"); return
	}

	// 权限校验：资料主人 或 留言人本人
	isOwner := username == c.ProfileUser
	isAuthor := username == c.FromUser
	if !isOwner && !isAuthor {
		profileFail(w, "无权删除"); return
	}

	store.DB.Model(&c).Updates(map[string]interface{}{
		"deleted": 1, "delete_reason": func() string {
			if isOwner { return "主人删除" }
			return "留言人删除"
		}(),
	})
	profileOK(w, map[string]interface{}{"deleted": true})
}

// ==================== 阶段二百九十五 P1：隐私 + 资料 HTTP 更新 ====================

// HandleProfilePrivacyPut PUT /api/profile/privacy 更新隐私设置
// 请求体：{ "profile_visibility": 2, "game_visibility": 1, "friend_visibility": 1, "comment_enabled": 1 }
func (s *Server) HandleProfilePrivacyPut(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	var body struct {
		ProfileVisibility *int8 `json:"profile_visibility"`
		GameVisibility    *int8 `json:"game_visibility"`
		FriendVisibility  *int8 `json:"friend_visibility"`
		CommentEnabled    *int8 `json:"comment_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil { profileFail(w, "JSON 错误"); return }

	updates := map[string]interface{}{}
	check := func(v *int8) bool { return v != nil && *v >= 0 && *v <= 2 } // 0/1/2 三值
	if check(body.ProfileVisibility) { updates["profile_visibility"] = *body.ProfileVisibility }
	if check(body.GameVisibility) { updates["game_visibility"] = *body.GameVisibility }
	if check(body.FriendVisibility) { updates["friend_visibility"] = *body.FriendVisibility }
	if body.CommentEnabled != nil { updates["comment_enabled"] = *body.CommentEnabled }

	if len(updates) == 0 { profileFail(w, "没有有效字段"); return }
	store.DB.Model(&model.User{}).Where("username = ?", username).Updates(updates)
	profileOK(w, map[string]interface{}{"saved": true})
}

// HandleProfileBasicPut PUT /api/profile/basic HTTP 更新基础资料（昵称/签名/称号/最爱游戏/背景）
// 与现有 handleProfileUpdate（WebSocket 通道）并行；HTTP 通道游戏中心前端用
func (s *Server) HandleProfileBasicPut(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" { profileFail(w, "请先登录"); return }

	var body struct {
		Nickname          string  `json:"nickname"`
		Signature         string  `json:"signature"`
		Title             string  `json:"title"`
		ProfileBg         string  `json:"profile_bg"`
		FavoriteGame      int     `json:"favorite_game_id"`
		ProfileTheme      *string `json:"profile_theme"`       // nil=未传 不更新；非nil 不管空/非空都处理
		ProfileBannerSkin *string `json:"profile_banner_skin"` // 同上，横幅皮肤
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil { profileFail(w, "JSON 错误"); return }

	updates := map[string]interface{}{}
	if body.Nickname != "" {
		if len(body.Nickname) > 32*3 { profileFail(w, "昵称过长"); return }
		updates["nickname"] = body.Nickname
	}
	if len(body.Signature) <= 128*3 { updates["signature"] = body.Signature }
	if len(body.Title) <= 64*3 { updates["title"] = body.Title }
	if len(body.ProfileBg) <= 255 { updates["profile_bg"] = body.ProfileBg }
	if body.FavoriteGame >= 0 { updates["favorite_game_id"] = body.FavoriteGame }
	// 展示柜主题：nil=未传 不更新；非nil 空串=恢复默认；非空=必须已在 UserShopItem 中
	if body.ProfileTheme != nil {
		if *body.ProfileTheme != "" {
			var owned model.UserShopItem
			if err := store.DB.Where("username = ? AND item_id = ?", username, *body.ProfileTheme).First(&owned).Error; err != nil {
				profileFail(w, "该主题未解锁，请先到积分商店购买"); return
			}
		}
		updates["profile_theme"] = *body.ProfileTheme
	}
	// 横幅皮肤：同 profile_theme 校验逻辑
	if body.ProfileBannerSkin != nil {
		if *body.ProfileBannerSkin != "" {
			var owned model.UserShopItem
			if err := store.DB.Where("username = ? AND item_id = ?", username, *body.ProfileBannerSkin).First(&owned).Error; err != nil {
				profileFail(w, "该横幅皮肤未解锁，请先到积分商店购买"); return
			}
		}
		// 容错：profile_banner_skin 列可能还没 AutoMigrate 加进 DB（服务端未重启）
		// 单独 Update 而不是放进 updates map，避免整个 Updates 一起挂
		_ = store.DB.Model(&model.User{}).Where("username = ?", username).Update("profile_banner_skin", *body.ProfileBannerSkin).Error
	}

	if len(updates) > 0 {
		if err := store.DB.Model(&model.User{}).Where("username = ?", username).Updates(updates).Error; err != nil {
			profileFail(w, "保存失败"); return
		}
	} else if body.ProfileBannerSkin == nil && body.ProfileTheme == nil {
		// 只传 profile_banner_skin 或 profile_theme 时 updates 为空（已单独 Update）
		// 如果两者都没传，才是真的"没有要更新的字段"
		profileFail(w, "没有要更新的字段"); return
	}

	// 昵称缓存失效（复用 profile.go 中已有的函数）
	s.invalidateNickname(username)
	profileOK(w, map[string]interface{}{"saved": true})
}

// ==================== 阶段二百九十五 P1：好友列表 ====================

// HandleProfileFriendsGet GET /api/profile/friends?username=xxx
// 返回用户好友列表（头像/昵称/在线状态/备注）；隐私 FriendVisibility 过滤
func (s *Server) HandleProfileFriendsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target

	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 隐私过滤（FriendVisibility 扁平公式：0=私密 1=仅好友 2=公开）
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.FriendVisibility == 2 || (u.FriendVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, map[string]interface{}{"list": []interface{}{}, "friend_visibility": u.FriendVisibility})
		return
	}

	// 查 Friend 表（注意：Friend 表中 user_id=target 的朋友在 friend_id 字段；双向好友）
	var rows []model.Friend
	store.DB.Where("user_id = ?", target).Order("id ASC").Find(&rows)

	type FriendResp struct {
		Username     string `json:"username"`
		Nickname     string `json:"nickname"`
		Avatar       string `json:"avatar"`
		Remark       string `json:"remark"`
		IsOnline     bool   `json:"is_online"`
	}
	// 批量查好友的用户资料
	friendUsernames := make([]string, 0, len(rows))
	for _, r := range rows { friendUsernames = append(friendUsernames, r.FriendID) }
	userMap := make(map[string]*model.User)
	if len(friendUsernames) > 0 {
		var users []model.User
		store.DB.Where("username IN ?", friendUsernames).Find(&users)
		for i := range users { userMap[users[i].Username] = &users[i] }
	}

	// 在线状态（Server.connections 或 GetOnlineUsers）
	result := make([]FriendResp, 0, len(rows))
	for _, r := range rows {
		ur := userMap[r.FriendID]
		nick := r.FriendID
		av := ""
		if ur != nil {
			if ur.Nickname != "" { nick = ur.Nickname }
			av = ur.Avatar
		}
		result = append(result, FriendResp{
			Username: r.FriendID, Nickname: nick, Avatar: av,
			Remark: r.Remark,
			IsOnline: s.isOnline(r.FriendID),
		})
	}
	profileOK(w, map[string]interface{}{"list": result})
}

// ==================== 增强：背景横幅上传 / 经验值日志 ====================

// HandleProfileBgUpload POST /api/profile/background
// multipart 上传资料页背景横幅图；需登录，仅本人可上传/更换
func (s *Server) HandleProfileBgUpload(w http.ResponseWriter, r *http.Request) {
	username, _ := gameAuthToken(r)
	if username == "" { profileFail(w, "请先登录"); return }

	if err := r.ParseMultipartForm(8 << 20); err != nil {
		profileFail(w, "参数错误"); return
	}
	file, header, err := r.FormFile("file")
	if err != nil { profileFail(w, "缺少文件"); return }
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !gameImageExts[ext] { profileFail(w, "仅支持 png/jpg/jpeg/gif/webp"); return }
	if header.Size > 8<<20 { profileFail(w, "图片超出 8MB 上限"); return }
	// MIME sniff：读取前 512 字节做真实类型校验
	sniff := make([]byte, 512)
	sniffN, _ := file.Read(sniff)
	detected := http.DetectContentType(sniff[:sniffN])
	allowed := map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true,
		"image/webp": true, "image/x-webp": true,
	}
	if !allowed[detected] { profileFail(w, "文件类型不匹配："+detected); return }
	if seeker, ok := file.(io.Seeker); ok { seeker.Seek(0, io.SeekStart) }

	dir := filepath.Join(s.cfg.WebDir, "static", "upload", "profile_bg")
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		profileFail(w, "目录创建失败"); return
	}
	b := make([]byte, 6)
	rand.Read(b)
	name := fmt.Sprintf("bg_%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dst, err := os.Create(filepath.Join(dir, name))
	if err != nil { profileFail(w, "文件写入失败"); return }
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(filepath.Join(dir, name))
		profileFail(w, "文件写入失败"); return
	}
	url := "/static/upload/profile_bg/" + name
	// 先更新 profile_bg（一定存在的列）
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Update("profile_bg", url).Error; err != nil {
		profileFail(w, "保存失败"); return
	}
	// 上传自定义横幅 → 自动取消预设皮肤（两者互斥）
	// 容错：profile_banner_skin 列可能还没 AutoMigrate 加（服务端未重启），单独 Update 忽略错误
	_ = store.DB.Model(&model.User{}).Where("username = ?", username).Update("profile_banner_skin", "").Error
	profileOK(w, map[string]interface{}{"url": url})
}

// HandleProfileBgDelete DELETE /api/profile/background
// 清空资料页背景横幅（恢复默认渐变）；需登录，仅本人
func (s *Server) HandleProfileBgDelete(w http.ResponseWriter, r *http.Request) {
	username, _ := gameAuthToken(r)
	if username == "" { profileFail(w, "请先登录"); return }
	store.DB.Model(&model.User{}).Where("username = ?", username).Update("profile_bg", "")
	profileOK(w, map[string]interface{}{"cleared": true})
}

// P1-b: 轻量独立接口 —— 让前端可以按需 fetch，避免每次都拉大聚合

// HandleProfileStatsGet GET /api/profile/stats?username=xxx
// 独立统计接口（聚合接口 HandleProfileGet 的轻量拆分）
// 隐私规则与聚合接口完全一致：基础可见性靠 ProfileVisibility，
// 游戏相关统计（游戏数/总时长/成就）额外受 GameVisibility 控制
func (s *Server) HandleProfileStatsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }

	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target

	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 好友判断（双向存储）
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}

	// ProfileVisibility: 0=私密 1=仅好友 2=公开
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileFail(w, "该用户资料私密"); return
	}
	// GameVisibility: 0=私密 1=仅好友 2=公开（控制游戏相关统计）
	canSeeGame := isSelf || u.GameVisibility == 2 || (u.GameVisibility == 1 && isFriend)

	var libCount int64
	var totalPlaySec int64
	var achCount int64
	if canSeeGame {
		store.DB.Model(&model.GameLibrary{}).Where("username = ? AND state >= 0 AND removed_at IS NULL", target).Count(&libCount)
		store.DB.Model(&model.GameLibrary{}).Where("username = ?", target).
			Select("COALESCE(SUM(play_seconds),0)").Scan(&totalPlaySec)
		store.DB.Model(&model.UserAchievement{}).Where("username = ?", target).Count(&achCount)
	}

	var badgeCount int64
	store.DB.Model(&model.UserBadge{}).Where("username = ?", target).Count(&badgeCount)

	var friendCount int64
	store.DB.Model(&model.Friend{}).Where("user_id = ?", target).Count(&friendCount)

	profileOK(w, ProfileStatsResp{
		TotalGames:        libCount,
		TotalPlaySeconds:  totalPlaySec,
		TotalPlayHours:    float64(totalPlaySec) / 3600.0,
		TotalAchievements: achCount,
		TotalBadges:       badgeCount,
		FriendsCount:      friendCount,
	})
}

// HandleProfileBadgesGet GET /api/profile/badges?username=xxx
// 独立徽章横条接口（取前 10 条，含等级徽章兜底）
func (s *Server) HandleProfileBadgesGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }

	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target

	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileFail(w, "该用户资料私密"); return
	}

	var badgeRows []model.UserBadge
	store.DB.Where("username = ?", target).Order("create_time DESC").Limit(10).Find(&badgeRows)

	badges := make([]ProfileBadgeResp, 0, len(badgeRows))
	hasLevelBadge := false
	for _, b := range badgeRows {
		badges = append(badges, ProfileBadgeResp{
			Type: b.Type, Code: b.Code, Name: b.Name, Icon: b.Icon, Desc: b.Desc,
		})
		if b.Type == "level" { hasLevelBadge = true }
	}
	if !hasLevelBadge {
		badges = append([]ProfileBadgeResp{{
			Type: "level", Code: "lv" + strconv.Itoa(u.Level),
			Name: "等级 " + strconv.Itoa(u.Level), Icon: "", Desc: "个人等级徽章",
		}}, badges...)
	}
	profileOK(w, map[string]interface{}{
		"list":  badges,
		"total": len(badgeRows),
	})
}

// HandleProfileExpLogGet GET /api/profile/exp-log?username=xxx
// 返回用户经验值变动日志列表（按 create_time 倒序）；自己看全部，他人按 ProfileVisibility 隐私过滤
// 注意：经验记录属于个人资料范畴，和资料页其他部分共用 ProfileVisibility 隐私控制（对标 Steam Activity）
// GameVisibility 控制的是游戏详情（游戏库/时长/成就列表），不控制经验记录
func (s *Server) HandleProfileExpLogGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" { profileFail(w, "username 必填"); return }

	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target

	// 1. 查目标用户（不存在直接返回）
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在"); return
	}

	// 2. 好友判断（双向存储）
	isFriend := false
	if !isSelf && viewer != "" {
		var f model.Friend
		if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
			isFriend = true
		}
	}

	// 3. 隐私过滤（与 HandleProfileGet 完全一致）
	// ProfileVisibility: 0=私密 1=仅好友 2=公开
	visible := isSelf || u.ProfileVisibility == 2 || (u.ProfileVisibility == 1 && isFriend)
	if !visible {
		profileOK(w, map[string]interface{}{"list": []interface{}{}}); return
	}

	// 4. 分页参数（page=1基, size默认30, 最大100；reason可选筛选）
	page := 1
	if v := r.URL.Query().Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 { page = n }
	}
	size := 30
	if v := r.URL.Query().Get("size"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 { size = n }
	}
	offset := (page - 1) * size
	reasonFilter := r.URL.Query().Get("reason")

	// 5. 构造查询（先算总数再分页）
	q := store.DB.Model(&model.ProfileExpLog{}).Where("username = ?", target)
	if reasonFilter != "" {
		q = q.Where("reason = ?", reasonFilter)
	}

	var total int64
	q.Count(&total)

	var list []model.ProfileExpLog
	q.Order("create_time DESC").Offset(offset).Limit(size).Find(&list)

	profileOK(w, map[string]interface{}{
		"list":  list,
		"total": total,
		"page":  page,
		"size":  size,
	})
}
