package server

// 成就自动解锁引擎（方案「Steam 同款个人资料功能开发文档.md §14.3」链路 A，P0）
//
// 触发点：HandleGamePlay（game.go）start/end 上报落库后异步判定（不阻塞上报响应）。
// 规则表按 seed code 约定匹配（未匹配规则的成就静默跳过，留给链路 B/C 游戏内事件上报）：
//
//	first_play      游玩次数 ≥ 1                          （start 新会话即满足）
//	play_Xh         累计秒数 ≥ X*3600                     （正则 ^play_(\d+)h$）
//	play_X_times    游玩次数 ≥ X                          （正则 ^play_(\d+)_times$）
//	early_bird      start 上报时间在 06:00–09:00          （服务端时间归口，防客户端改钟）
//	play_night_owl  start 上报时间在 23:00–次日 04:00      （同上）
//
// 命中且未解锁者循环调用 achUnlockCore（事务幂等，无需额外加锁）；
// 解锁成功经 pushAchievementUnlocked 实时推送该用户全部在线端（msg_type=122 成就 toast）。
// 单次触发最多解锁 achEngineMaxPerTrigger 条（play_seconds 异常暴涨时防轰炸，方案 §14.9）。
// 成就定义会话内缓存（TTL 5min）：规则比对纯内存，常态零额外 SQL 压力（方案 §14.8.7）。

import (
	"regexp"
	"strconv"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// achEngineMaxPerTrigger 单次触发最多自动解锁条数（防 play_seconds 异常暴涨轰炸）
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
}
