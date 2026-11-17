package server

// 成就自动解锁引擎（方案「Steam 同款个人资料功能开发文档.md §14.3」链路 A + 充值成就链路 D + 每日成就链路 E，P0/P1）
//
// 触发点：
//   - 链路 A：HandleGamePlay（game.go）start/end 上报落库后异步判定（不阻塞上报响应）
//   - 链路 D：充值订单 ack 成功后异步判定（gamerecharge.go handleInternalGatewayRechargeAck）
//   - 链路 E：每日成就复用链路 A/D 触发点 + HandleGameReviewHelpful 独立触发
//
// 规则表按 seed code 约定匹配（未匹配规则的成就静默跳过，留给链路 B/C 游戏内事件上报）：
//
// 【一次性成就（GameAchievement）】
//   first_play      游玩次数 ≥ 1                          （start 新会话即满足）
//   play_Xh         累计秒数 ≥ X*3600                     （正则 ^play_(\d+)h$）
//   play_X_times    游玩次数 ≥ X                          （正则 ^play_(\d+)_times$）
//   early_bird      start 上报时间在 06:00–09:00          （服务端时间归口，防客户端改钟）
//   play_night_owl  start 上报时间在 23:00–次日 04:00      （同上）
//   first_pay       首次充值成功（累计充值积分 ≥ 1）         （充值链路 D）
//   pay_X           累计充值积分 ≥ X                       （正则 ^pay_(\d+)$，充值链路 D）
//
// 【每日成就（GameDailyAchievement，独立表，可每日重复解锁）】
//   daily_play            当日游玩该游戏至少一次           （start 触发；仅检查是否已有当日记录）
//   daily_play_30m        当日累计游玩 ≥ 30 分钟           （end 触发；Redis 临时累计秒数，TTL 48h）
//   daily_pay             当日完成一次充值                 （充值 ack success 触发）
//   daily_review_helpful  当日给评测点「有帮助」            （HandleGameReviewHelpful 独立触发）
//
// 命中且未解锁者循环调用 achUnlockCore / achDailyUnlockCore（事务幂等，无需额外加锁）；
// 解锁成功经 pushAchievementUnlocked 实时推送该用户全部在线端（msg_type=122 成就 toast）。
// 单次触发最多解锁 achEngineMaxPerTrigger 条（play_seconds 异常暴涨时防轰炸，方案 §14.9）。
// 成就定义会话内缓存（TTL 5min）：规则比对纯内存，常态零额外 SQL 压力（方案 §14.8.7）。

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// achEngineMaxPerTrigger 单次触发最多自动解锁条数（防 play_seconds 异常暴涨 / 充值时连充轰炸）
const achEngineMaxPerTrigger = 3

// achEngineDefCacheTTL 成就定义缓存有效期（管理端调整定义后最迟 5min 生效）
const achEngineDefCacheTTL = 5 * time.Minute

var (
	achEngineMu      sync.Mutex
	achEngineDefs    = map[uint][]model.GameAchievement{}
	achEngineDefsAt  = map[uint]time.Time{}
	achRuleHoursRe   = regexp.MustCompile(`^play_(\d+)h$`)
	achRuleTimesRe   = regexp.MustCompile(`^play_(\d+)_times$`)
	achRuleFirstPlay = regexp.MustCompile(`^first_play$`)
	achRulePayRe     = regexp.MustCompile(`^pay_(\d+)$`)      // 累计充值积分阈值
	achRuleFirstPay  = regexp.MustCompile(`^first_pay$`)     // 首次充值
)

// achEngineDefsOf 指定游戏的成就定义（带 TTL 缓存；空表/查询失败返回 nil 静默跳过）
func achEngineDefsOf(gameID uint) []model.GameAchievement {
	achEngineMu.Lock()
	defer achEngineMu.Unlock()
	if defs, ok := achEngineDefs[gameID]; ok && time.Since(achEngineDefsAt[gameID]) < achEngineDefCacheTTL {
		return defs
	}
	var defs []model.GameAchievement
	if err := store.DB.Where("game_id = ?", gameID).Find(&defs).Error; err != nil || len(defs) == 0 {
		return nil
	}
	achEngineDefs[gameID] = defs
	achEngineDefsAt[gameID] = time.Now()
	return defs
}

// achEngineRuleHit 单条成就规则判定（event: start/end；playSeconds/playCount 为本次上报后的
// 服务端权威快照；now 为服务端时间——时段型一律以服务端时钟为准，防客户端改钟）
func achEngineRuleHit(code, event string, playSeconds, playCount int64, now time.Time) bool {
	// 次数型：first_play（游玩 ≥ 1 次）
	if achRuleFirstPlay.MatchString(code) {
		return playCount >= 1
	}
	// 时长型：play_Xh（累计秒数跨阈值）
	if m := achRuleHoursRe.FindStringSubmatch(code); m != nil {
		hours, _ := strconv.ParseInt(m[1], 10, 64)
		return hours > 0 && playSeconds >= hours*3600
	}
	// 次数型：play_X_times（累计启动次数跨阈值）
	if m := achRuleTimesRe.FindStringSubmatch(code); m != nil {
		times, _ := strconv.ParseInt(m[1], 10, 64)
		return times > 0 && playCount >= times
	}
	// 时段型（仅 start 上报判定；end 不重复判）：
	if event == "start" {
		hour := now.Hour()
		if code == "early_bird" {
			return hour >= 6 && hour < 9 // 06:00–09:00（边界：05:59 否 / 06:00 是 / 09:00 否）
		}
		if code == "play_night_owl" {
			return hour >= 23 || hour < 4 // 23:00–次日 04:00
		}
	}
	// 未匹配规则（first_screenshot / 游戏专属成就等）：静默跳过，留给链路 B/C
	return false
}

// achEngineEvaluate 自动判定入口（异步 goroutine 调用，任何失败静默记日志不打扰用户）：
// 查该游戏全部成就定义 → 已解锁集合 → 内存规则逐条比对 → 命中者走 achUnlockCore 幂等解锁
func (s *Server) achEngineEvaluate(username string, gameID uint, event string, playSeconds, playCount int64) {
	if username == "" || gameID == 0 {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("成就自动判定 panic（user=%s game#%d）: %v", username, gameID, r)
		}
	}()

	defs := achEngineDefsOf(gameID)
	if len(defs) == 0 {
		return
	}
	// 已解锁集合（一条查询覆盖；全部已解锁时规则循环空转零写库）
	var unlockedIDs []uint
	if err := store.DB.Model(&model.UserAchievement{}).
		Where("username = ? AND game_id = ?", username, gameID).
		Pluck("achievement_id", &unlockedIDs).Error; err != nil {
		logger.Warn("成就自动判定查已解锁失败（user=%s game#%d）: %v", username, gameID, err)
		return
	}
	unlocked := make(map[uint]bool, len(unlockedIDs))
	for _, id := range unlockedIDs {
		unlocked[id] = true
	}

	now := time.Now()
	granted := 0
	for _, def := range defs {
		if unlocked[def.ID] {
			continue
		}
		if !achEngineRuleHit(def.Code, event, playSeconds, playCount, now) {
			continue
		}
		already, expGain, _, newLevel, levelUp, err := achUnlockCore(username, def)
		if err != nil {
			logger.Warn("成就自动解锁失败（user=%s game#%d code=%s）: %v", username, gameID, def.Code, err)
			continue
		}
		if already {
			continue // 并发竞态下他人/他端已解锁：幂等静默
		}
		logger.Info("成就自动解锁：user=%s game#%d code=%s +%dexp 升级=%v", username, gameID, def.Code, expGain, levelUp)
		s.pushAchievementUnlocked(username, def, expGain, levelUp, newLevel)
		if granted++; granted >= achEngineMaxPerTrigger {
			break // 单次触发上限保护（方案 §14.9）
		}
	}
	// 每日成就联动：start → daily_play，end → daily_play_30m（复用同一触发点，异步不阻塞主链路）
	go s.achEngineEvaluateDaily(username, gameID, event, playSeconds)
}

// ===== 充值成就链路 D（gamerecharge.go ack success 后触发） =====

// achUserTotalPointsPaid 查询用户在某游戏的累计成功充值积分（status=1 已到账）。
// 口径：SUM(points)——points 为平台统一积分（3 位小数），与 amount（游戏内到账数值，随游戏汇率不同）解耦。
// 查询失败按 0 兜底（宁可放过勿阻塞充值主链路）。
func achUserTotalPointsPaid(username string, gameID uint) float64 {
	var total float64
	err := store.DB.Model(&model.RechargeOrder{}).
		Where("username = ? AND game_id = ? AND status = ?", username, gameID, model.RechargeOrderStatusSuccess).
		Select("COALESCE(SUM(points), 0)").Scan(&total).Error
	if err != nil {
		logger.Warn("成就充值累计查询失败（user=%s game#%d）: %v", username, gameID, err)
		return 0
	}
	return total
}

// achEngineRuleHitPay 充值成就规则判定：
//   first_pay   累计充值 ≥ 1 积分（首次充值成功即满足）
//   pay_X       累计充值 ≥ X 积分（正则 ^pay_(\d+)$，X 为整数门槛）
func achEngineRuleHitPay(code string, totalPoints float64) bool {
	if achRuleFirstPay.MatchString(code) {
		return totalPoints >= 1
	}
	if m := achRulePayRe.FindStringSubmatch(code); m != nil {
		threshold, _ := strconv.ParseFloat(m[1], 64)
		return threshold > 0 && totalPoints >= threshold
	}
	return false
}

// achEngineEvaluatePay 充值成就自动判定入口（链路 D：充值 ack 成功后异步 goroutine 调用）。
// 逻辑与 achEngineEvaluate 对称但独立：只跑充值规则，避免把游玩类成就拉进一次充值触发里。
// 任何失败静默记日志不打扰用户充值体验。
func (s *Server) achEngineEvaluatePay(username string, gameID uint) {
	if username == "" || gameID == 0 {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("充值成就自动判定 panic（user=%s game#%d）: %v", username, gameID, r)
		}
	}()

	defs := achEngineDefsOf(gameID)
	if len(defs) == 0 {
		return
	}
	// 先过滤：只留充值类 code 有意义（否则累计额为 0 时全跳过，等价性能）
	var payDefs []model.GameAchievement
	for _, d := range defs {
		if achRuleFirstPay.MatchString(d.Code) || achRulePayRe.MatchString(d.Code) {
			payDefs = append(payDefs, d)
		}
	}
	if len(payDefs) == 0 {
		return // 该游戏未配置充值成就，直接返回，免一次累计查询
	}

	// 已解锁集合（查一次 game_id 范围就够，因为 payDefs 是其子集）
	var unlockedIDs []uint
	if err := store.DB.Model(&model.UserAchievement{}).
		Where("username = ? AND game_id = ?", username, gameID).
		Pluck("achievement_id", &unlockedIDs).Error; err != nil {
		logger.Warn("充值成就自动判定查已解锁失败（user=%s game#%d）: %v", username, gameID, err)
		return
	}
	unlocked := make(map[uint]bool, len(unlockedIDs))
	for _, id := range unlockedIDs {
		unlocked[id] = true
	}

	// 累计充值积分（服务端权威口径，points 字段，已排除 pending/failed）
	totalPoints := achUserTotalPointsPaid(username, gameID)

	granted := 0
	for _, def := range payDefs {
		if unlocked[def.ID] {
			continue
		}
		if !achEngineRuleHitPay(def.Code, totalPoints) {
			continue
		}
		already, expGain, _, newLevel, levelUp, err := achUnlockCore(username, def)
		if err != nil {
			logger.Warn("充值成就自动解锁失败（user=%s game#%d code=%s）: %v", username, gameID, def.Code, err)
			continue
		}
		if already {
			continue
		}
		logger.Info("充值成就自动解锁：user=%s game#%d code=%s +%dexp 升级=%v（累计积分=%.3f）",
			username, gameID, def.Code, expGain, levelUp, totalPoints)
		s.pushAchievementUnlocked(username, def, expGain, levelUp, newLevel)
		if granted++; granted >= achEngineMaxPerTrigger {
			break
		}
	}
	// 每日充值成就联动：daily_pay
	go s.achEngineEvaluateDaily(username, gameID, "pay", 0)
}

// ===== P1 每日成就引擎（独立表，可每日重复解锁） =====

const (
	// achDailyPlaySecsTTL Redis 临时累计秒数 key 的 TTL（48h 跨日后自动过期，不占永久存储）
	achDailyPlaySecsTTL = 48 * time.Hour
	// achDailyPlay30mThreshold 每日游玩成就 30 分钟阈值（秒）
	achDailyPlay30mThreshold = 30 * 60
)

var (
	// achDailyDefs 每日成就定义缓存（独立于 achEngineDefs，TTL 5min）
	achDailyDefs   = map[uint][]model.GameDailyAchievement{}
	achDailyDefsAt = map[uint]time.Time{}
)

// achDailyDefsOf 指定游戏的每日成就定义（带 TTL 缓存；空表/查询失败返回 nil 静默跳过）
func achDailyDefsOf(gameID uint) []model.GameDailyAchievement {
	achEngineMu.Lock()
	defer achEngineMu.Unlock()
	if defs, ok := achDailyDefs[gameID]; ok && time.Since(achDailyDefsAt[gameID]) < achEngineDefCacheTTL {
		return defs
	}
	var defs []model.GameDailyAchievement
	if err := store.DB.Where("game_id = ?", gameID).Find(&defs).Error; err != nil || len(defs) == 0 {
		return nil
	}
	achDailyDefs[gameID] = defs
	achDailyDefsAt[gameID] = time.Now()
	return defs
}

// achDailyTodayKey 本地自然日 YYYY-MM-DD（东八区口径，与 rechargeTodayUsed 的 dayStart 一致）
func achDailyTodayKey() string {
	now := time.Now()
	return fmt.Sprintf("%04d-%02d-%02d", now.Year(), now.Month(), now.Day())
}

// achDailyRedisKeyPlaySecs 每日游玩累计秒数 Redis key
func achDailyRedisKeyPlaySecs(username string, gameID uint, dateKey string) string {
	return fmt.Sprintf("ach_daily:play_secs:%s:%d:%s", username, gameID, dateKey)
}

// achDailyRecordPlaySecs 向 Redis 累加用户当日游玩秒数（原子 INCRBY；返回累加后的总值，失败返回 0）
func achDailyRecordPlaySecs(username string, gameID uint, seconds int64, dateKey string) int64 {
	if store.RDB == nil {
		return 0
	}
	key := achDailyRedisKeyPlaySecs(username, gameID, dateKey)
	newVal, err := store.RDB.IncrBy(context.Background(), key, seconds).Result()
	if err != nil {
		logger.Warn("每日成就游玩秒数累计失败（user=%s game#%d）: %v", username, gameID, err)
		return 0
	}
	// 首次写入时设置 TTL（EXPIRE 是重置，幂等安全，每次 end 上报触发无妨）
	store.RDB.Expire(context.Background(), key, achDailyPlaySecsTTL)
	return newVal
}

// achDailyPlayAchievementCodes 每日成就 code 集合（用于从每日成就定义中快速过滤）
var achDailyPlayAchievementCodes = map[string]bool{
	"daily_play":           true,
	"daily_play_30m":       true,
	"daily_pay":            true,
	"daily_review_helpful": true,
}

// achDailyAlreadyUnlocked 查询用户当日某游戏某每日成就是否已解锁（返回成就定义 ID，0=未解锁）
func achDailyAlreadyUnlocked(username string, gameID uint, dailyAchievementID uint, dateKey string) bool {
	var cnt int64
	store.DB.Model(&model.UserDailyAchievement{}).
		Where("username = ? AND game_id = ? AND daily_achievement_id = ? AND date_key = ?",
			username, gameID, dailyAchievementID, dateKey).
		Count(&cnt)
	return cnt > 0
}

// achDailyUnlockCore 每日成就解锁核心（独立表，每日可重复解锁）
// 事务化幂等：OnConflict DoNothing 消并发冲突；经验值增量 + 等级升级逻辑复用 achUnlockCore 口径。
// 返回 (already 今日是否已解锁, expGain 获得经验, newLevel 新等级, levelUp 是否升级, err)
func achDailyUnlockCore(username string, dach model.GameDailyAchievement, dateKey string) (bool, int, int, bool, error) {
	var already bool
	var expGain int
	var levelUp bool
	var newLevel int

	err := store.DB.Transaction(func(tx *gorm.DB) error {
		unlock := model.UserDailyAchievement{
			Username:           username,
			GameID:             dach.GameID,
			DailyAchievementID: dach.ID,
			DateKey:            dateKey,
		}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&unlock)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			already = true
			return nil
		}
		// 经验值增量（复用 achUnlockCore 口径：FOR UPDATE 行锁 + exp 原子增量）
		var user model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&user).Error; err != nil {
			return err
		}
		expGain = dach.ExpReward
		newExp := user.Exp + int64(expGain)
		newLevel = calcLevelFromExp(int(newExp))
		levelUp = newLevel > user.Level

		updates := map[string]interface{}{"exp": newExp}
		if levelUp {
			updates["level"] = newLevel
			// 等级徽章也用 OnConflict DoNothing 防并发重复发（同 achUnlockCore）
			tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserBadge{
				Username: username, Type: "level",
				Code: "lv" + strconv.Itoa(newLevel),
				Name: "等级 " + strconv.Itoa(newLevel),
				Icon: "", Desc: "Steam 同款个人等级徽章",
			})
		}
		if err := tx.Model(&user).Updates(updates).Error; err != nil {
			return err
		}
		// 经验值日志（每日成就专属 reason 口径；detail 与其他 3 个入口统一用友好中文，避免技术化调试信息）
		detail := "完成每日任务「" + dach.Name + "」"
		if err := tx.Create(&model.ProfileExpLog{
			Username: username, Change: expGain, Reason: "daily_achievement", Detail: detail,
		}).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return false, 0, 0, false, err
	}
	return already, expGain, newLevel, levelUp, nil
}

// dailyAchRule 每日成就规则配置（映射表驱动，引擎零改动）
// Type: "bool"（布尔型：触发即判定）/ "redis_threshold"（Redis 累计达阈值）
// RedisKey: Redis key 模板（{username}/{gameID}/{dateKey} 占位符）
// Threshold: 阈值（秒/次数等，由 Redis 累计值类型决定）
type dailyAchRule struct {
	Code      string
	Type      string // "bool" / "redis_threshold"
	RedisKey  string // redis_threshold 类型必填
	Threshold int64  // redis_threshold 类型必填
}

// dailyEventCodeMap 每日成就 event→规则映射表（统一归口，新增每日成就只改此表，引擎零改动）
// 映射规则：event → 规则列表；引擎按 Rule.Type 动态走判定分支
var dailyEventCodeMap = map[string][]dailyAchRule{
	"start": {
		{Code: "daily_play", Type: "bool"},
	},
	"end": {
		{Code: "daily_play_30m", Type: "redis_threshold", RedisKey: "ach_daily:play_secs:{username}:{gameID}:{dateKey}", Threshold: achDailyPlay30mThreshold},
	},
	"pay":            {{Code: "daily_pay", Type: "bool"}},
	"review_helpful": {{Code: "daily_review_helpful", Type: "bool"}},
	"save_finalize":  {{Code: "daily_save", Type: "bool"}},
	"review_upsert":  {{Code: "daily_review", Type: "bool"}},
	"review_reply":   {{Code: "daily_review_reply", Type: "bool"}},
	// TODO: "card_redeem": {{Code: "daily_card_redeem", Type: "bool"}} —— 卡密充值无 game_id，暂不触发
}

// achEngineEvaluateDaily 每日成就评估入口（链路 E：游玩/充值/互动行为触发后异步调用）
// event 参数见 dailyEventCodeMap key；playSeconds 仅 end 事件传本次秒数（已废弃，Redis 累计在源头完成）
// 任何失败静默记日志不打扰用户主链路
func (s *Server) achEngineEvaluateDaily(username string, gameID uint, event string, playSeconds int64) {
	if username == "" || gameID == 0 {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("每日成就判定 panic（user=%s game#%d event=%s）: %v", username, gameID, event, r)
		}
	}()

	// 事件→规则映射（未注册的 event 直接返回，避免误匹配）
	wantRules, ok := dailyEventCodeMap[event]
	if !ok {
		return
	}

	defs := achDailyDefsOf(gameID)
	if len(defs) == 0 {
		return
	}

	dateKey := achDailyTodayKey()

	// 按 wantRules 过滤候选（精确匹配 Code；同时保存 rule 供后续 Threshold 判定用）
	type candidateRule struct {
		def  model.GameDailyAchievement
		rule dailyAchRule
	}
	var candidates []candidateRule
	for _, d := range defs {
		for _, r := range wantRules {
			if d.Code == r.Code {
				candidates = append(candidates, candidateRule{def: d, rule: r})
				break
			}
		}
	}
	if len(candidates) == 0 {
		return
	}

	// 逐条判定 + 解锁
	granted := 0
	for _, cr := range candidates {
		d := cr.def
		rule := cr.rule

		// 已经解锁过 → 跳过
		if achDailyAlreadyUnlocked(username, gameID, d.ID, dateKey) {
			continue
		}

		// 按 Rule.Type 动态判定（新增类型只改映射表，引擎零改动）
		switch rule.Type {
		case "redis_threshold":
			if store.RDB == nil {
				continue
			}
			key := strings.ReplaceAll(rule.RedisKey, "{username}", username)
			key = strings.ReplaceAll(key, "{gameID}", strconv.Itoa(int(gameID)))
			key = strings.ReplaceAll(key, "{dateKey}", dateKey)
			total, err := store.RDB.Get(context.Background(), key).Int64()
			if err != nil || total < rule.Threshold {
				continue // 累计未达阈值
			}
		case "bool":
			// 布尔型：触发即解锁（start/pay/save 等事件到来 = 条件满足）
		default:
			continue // 未知类型跳过
		}

		already, expGain, newLevel, levelUp, err := achDailyUnlockCore(username, d, dateKey)
		if err != nil {
			logger.Warn("每日成就解锁失败（user=%s game#%d code=%s）: %v", username, gameID, d.Code, err)
			continue
		}
		if already {
			continue
		}
		logger.Info("每日成就解锁：user=%s game#%d code=%s +%dexp 升级=%v",
			username, gameID, d.Code, expGain, levelUp)
		// 构造 GameAchievement 副本复用推送（字段完全一致，仅结构不同）
		pushAch := model.GameAchievement{
			GameID: d.GameID, Code: d.Code, Name: d.Name, Desc: d.Desc,
			Icon: d.Icon, Rarity: d.Rarity, ExpReward: expGain,
		}
		s.pushAchievementUnlocked(username, pushAch, expGain, levelUp, newLevel)
		if granted++; granted >= achEngineMaxPerTrigger {
			break
		}
	}
}

// ===== 每日成就历史清理（优化项3） =====

// dailyAchKeepDays UserDailyAchievement 历史保留天数（30 天前的记录自动清理）
const dailyAchKeepDays = 30

// startDailyAchHistoryCleanup 启动每日成就历史记录定时清理协程（每 24 小时清一次 30 天前的记录）
// 对齐 startGameTmpSweeper 风格；失败静默记日志不影响主链路
func (s *Server) startDailyAchHistoryCleanup() {
	go func() {
		// 启动先清一次遗留垃圾，再进入定时
		s.sweepDailyAchHistory()
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			s.sweepDailyAchHistory()
		}
	}()
}

// sweepDailyAchHistory 清理 30 天前的每日成就解锁记录
// MySQL 唯一约束 (username, game_id, daily_achievement_id, date_key) 天然去重，直接按 date_key 批量删
func (s *Server) sweepDailyAchHistory() {
	cutoff := time.Now().AddDate(0, 0, -dailyAchKeepDays).Format("2006-01-02")
	res := store.DB.Where("date_key < ?", cutoff).Delete(&model.UserDailyAchievement{})
	if res.Error != nil {
		logger.Warn("每日成就历史清理失败: %v", res.Error)
		return
	}
	if res.RowsAffected > 0 {
		logger.Info("每日成就历史清理：删除 %d 条 %s 前的过期记录", res.RowsAffected, cutoff)
	}
}
