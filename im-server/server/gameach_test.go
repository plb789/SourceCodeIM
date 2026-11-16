package server

// 游戏端成就解锁对接集成测试（真实 MySQL/Redis：需本地 bin/config.yaml 可连，无库自动跳过）。
// 覆盖方案 §14.8 测试要点：
//   1. 签名死锁修复回归：会话密钥签名通过 / 复用不轮换 / 错误签名拒绝 / 无密钥降级开关两态；
//   2. 防刷回归：重放 nonce 拒绝、未入库游戏拒绝；
//   3. achUnlockCore 幂等：同成就重复解锁零副作用（经验/日志只入账一次）；
//   4. 自动引擎规则表：时长/次数/时段边界（05:59/06:00/09:00/09:01、23:00/04:00）；
//   5. 自动引擎端到端：end 上报跨阈值只解锁一次（重复判定不重复发经验）；
//   6. play_count 会话计数：start 新会话 +1，心跳续期不计数。
// 测试数据全部用 achtest 前缀并在末尾清理，不触碰真实数据。

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

const achTestUser = "achtest_user"     // 主用户（有会话密钥链路）
const achTestUser3 = "achtest_user3"   // 无会话密钥用户（降级开关两态）
const achTestSecret = "achtest-launch-secret-0123456789abcdef"

var achOnce sync.Once
var achGameID uint

// achSetup 测试数据：用户×2 + 游戏 + 库条目 + 成就定义（幂等可重跑）
func achSetup(t *testing.T) uint {
	t.Helper()
	if err := store.DB.AutoMigrate(&model.User{}, &model.Game{}, &model.GameLibrary{},
		&model.GameAchievement{}, &model.UserAchievement{}, &model.UserBadge{}, &model.ProfileExpLog{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}

	for _, un := range []string{achTestUser, achTestUser3} {
		var u model.User
		if err := store.DB.Where("username = ?", un).First(&u).Error; err != nil {
			u = model.User{Username: un, Password: "x", Level: 1, Exp: 100}
			if err := store.DB.Create(&u).Error; err != nil {
				t.Fatalf("测试用户创建失败：%v", err)
			}
		}
	}

	achOnce.Do(func() {
		// 幂等：历史运行已建过测试游戏/成就定义时直接复用（slug 唯一索引防重复创建）
		var g model.Game
		if err := store.DB.Where("slug = ?", "achtest-game").First(&g).Error; err == nil {
			achGameID = g.ID
		} else {
			g = model.Game{Slug: "achtest-game", Name: "成就测试游戏", GameSecret: achTestSecret}
			if err := store.DB.Create(&g).Error; err != nil {
				t.Fatalf("测试游戏创建失败：%v", err)
			}
			achGameID = g.ID
		}
		defs := []model.GameAchievement{
			{GameID: achGameID, Code: "first_play", Name: "初入江湖", Desc: "第一次启动", Rarity: 0, ExpReward: 10},
			{GameID: achGameID, Code: "play_1h", Name: "初尝滋味", Desc: "累计游玩 1 小时", Rarity: 0, ExpReward: 10},
			{GameID: achGameID, Code: "play_10_times", Name: "常客", Desc: "累计启动 10 次", Rarity: 0, ExpReward: 10},
			{GameID: achGameID, Code: "early_bird", Name: "早起的鸟儿", Desc: "清晨游玩", Rarity: 1, ExpReward: 25},
			{GameID: achGameID, Code: "play_night_owl", Name: "夜猫子", Desc: "深夜游玩", Rarity: 2, ExpReward: 50},
			{GameID: achGameID, Code: "first_screenshot", Name: "留影纪念", Desc: "首张截图", Rarity: 0, ExpReward: 10},
		}
		for _, d := range defs {
			var cnt int64
			store.DB.Model(&model.GameAchievement{}).Where("game_id = ? AND code = ?", achGameID, d.Code).Count(&cnt)
			if cnt == 0 {
				store.DB.Create(&d)
			}
		}
	})

	// 库条目（两位用户均在库）+ 成就解锁/经验日志每用例前清理（幂等可重跑）
	for _, un := range []string{achTestUser, achTestUser3} {
		var cnt int64
		store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", un, achGameID).Count(&cnt)
		if cnt == 0 {
			store.DB.Create(&model.GameLibrary{Username: un, GameID: achGameID})
		}
		store.DB.Where("username = ? AND game_id = ?", un, achGameID).Delete(&model.UserAchievement{})
		store.DB.Where("username = ?", un).Delete(&model.ProfileExpLog{})
	}
	return achGameID
}

// achCleanup 每用例后清解锁/计数（用例间互不影响）
func achCleanup(t *testing.T) {
	t.Helper()
	for _, un := range []string{achTestUser, achTestUser3} {
		store.DB.Where("username = ?", un).Delete(&model.UserAchievement{})
		store.DB.Where("username = ?", un).Delete(&model.ProfileExpLog{})
		store.DB.Model(&model.GameLibrary{}).Where("username = ?", un).
			Updates(map[string]interface{}{"play_seconds": 0, "play_count": 0})
	}
}

// achNonce 动态 nonce（防跨运行重放：Redis 黑名单 300s 内固定串会被拒）
func achNonce(tag string) string {
	return "achtest-nonce-" + tag + "-" + hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
}

// achDoUnlock 直调 unlock handler；sigKeyHex 非空时按服务端冻结口径对真实请求体签名。
// body 未带 client_ts/nonce 时自动补齐（签名口径要求三者同源）；返回响应 data 与 err 文案
func achDoUnlock(t *testing.T, s *Server, user string, body map[string]interface{}, sigKeyHex string) (map[string]interface{}, string) {
	t.Helper()
	if _, ok := body["client_ts"]; !ok {
		body["client_ts"] = time.Now().Unix()
	}
	if _, ok := body["nonce"]; !ok {
		body["nonce"] = achNonce("auto")
	}
	bodyBytes, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/game/achievement/unlock?username="+user, bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Drive-Token", DriveTokenIssue(user))
	if sigKeyHex != "" {
		ts, _ := body["client_ts"].(int64)
		if ts == 0 {
			if f, ok := body["client_ts"].(float64); ok {
				ts = int64(f)
			}
		}
		nonce, _ := body["nonce"].(string)
		bodyHash := sha256.Sum256(bodyBytes)
		canonical := strconv.FormatInt(ts, 10) + "\n" + nonce + "\n" + hex.EncodeToString(bodyHash[:])
		key, _ := hex.DecodeString(sigKeyHex)
		mac := hmac.New(sha256.New, key)
		mac.Write([]byte(canonical))
		req.Header.Set("X-Game-Signature", hex.EncodeToString(mac.Sum(nil)))
	}
	w := httptest.NewRecorder()
	s.HandleGameAchievementUnlock(w, req)
	var resp struct {
		Ok   bool                   `json:"ok"`
		Data map[string]interface{} `json:"data"`
		Err  string                 `json:"err"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("响应解析失败：%v（body=%s）", err, w.Body.String())
	}
	return resp.Data, resp.Err
}

// achResetRedis 用例开始前清理限流/签名键（防跨运行累计：限流 60s 滑窗、nonce 黑名单 300s）
func achResetRedis(t *testing.T) {
	t.Helper()
	if !store.RedisAvailable() {
		return
	}
	ctx := context.Background()
	for _, un := range []string{achTestUser, achTestUser3} {
		store.RDB.Del(ctx, achRatelimitKey(un))
		store.RDB.Del(ctx, achSignKeyRedisKey(un, achGameID))
	}
}

// 1. 签名死锁修复回归 + 防刷回归（§14.8.1/§14.8.2）
func TestAchSignatureFlow(t *testing.T) {
	gid := achSetup(t)
	defer achCleanup(t)
	if err := store.InitRedis(config.Load()); err != nil {
		t.Skip("Redis 不可用：会话签名密钥链路需 Redis，跳过")
	}
	achResetRedis(t)
	s := NewServer(config.Load())

	// 会话密钥签发（与库/详情下发同源路径）
	signKey := achSessionSignKeyIssue(achTestUser, gid, achTestSecret)
	if signKey == "" {
		t.Fatal("会话签名密钥签发失败（Redis 不可用或写入失败）")
	}
	// 复用语义：二次签发返回同一密钥（不轮换，已启动会话签名持续有效）
	if again := achSessionSignKeyIssue(achTestUser, gid, achTestSecret); again != signKey {
		t.Fatalf("会话密钥二次签发发生轮换：%s != %s", signKey, again)
	}

	// ① 带有效会话签名上报 → 通过
	ts := time.Now().Unix()
	nonce := achNonce("first")
	data, errStr := achDoUnlock(t, s, achTestUser, map[string]interface{}{
		"game_id": gid, "achievement_code": "first_play", "client_ts": ts, "nonce": nonce,
	}, signKey)
	if errStr != "" || data["unlocked"] != true {
		t.Fatalf("有效签名上报被拒：err=%q data=%v", errStr, data)
	}

	// ② 重放同一 nonce → 拒绝（防重放防线在签名修复后仍生效）
	_, errStr = achDoUnlock(t, s, achTestUser, map[string]interface{}{
		"game_id": gid, "achievement_code": "play_1h", "client_ts": ts, "nonce": nonce,
	}, signKey)
	if !strings.Contains(errStr, "重复提交") {
		t.Fatalf("重放 nonce 未被拒绝：%q", errStr)
	}

	// ③ 有会话密钥但签名错误 → 拒绝
	_, errStr = achDoUnlock(t, s, achTestUser, map[string]interface{}{
		"game_id": gid, "achievement_code": "play_10_times", "client_ts": ts, "nonce": achNonce("bad"),
	}, "deadbeef")
	if !strings.Contains(errStr, "签名") {
		t.Fatalf("错误签名未被拒绝：%q", errStr)
	}

	// ④ 无会话密钥 + 开关 false（默认）→ 降级放行（登录 token+在库+防重放+限流四道防线兜底）
	data, errStr = achDoUnlock(t, s, achTestUser3, map[string]interface{}{
		"game_id": gid, "achievement_code": "first_play", "client_ts": ts, "nonce": achNonce("degrade"),
	}, "")
	if errStr != "" || data["unlocked"] != true {
		t.Fatalf("降级模式（开关 false 无签名）未放行：err=%q data=%v", errStr, data)
	}

	// ⑤ 未入库/不存在游戏 → 拒绝（在库校验独立于签名降级）
	_, errStr = achDoUnlock(t, s, achTestUser3, map[string]interface{}{
		"game_id": gid + 99999, "achievement_code": "first_play", "client_ts": ts, "nonce": achNonce("nolib"),
	}, "")
	if !strings.Contains(errStr, "不存在") && !strings.Contains(errStr, "尚未加入") {
		t.Fatalf("未入库/不存在游戏未被拒绝：%q", errStr)
	}

	// ⑥ 开关 true + 无会话密钥 → 一律拒绝（收紧模式；config.Load 每次重读文件，
	// 进程内改内存无效，故走测试覆盖钩子）
	required := true
	achSignRequiredOverride = &required
	defer func() { achSignRequiredOverride = nil }()
	_, errStr = achDoUnlock(t, s, achTestUser3, map[string]interface{}{
		"game_id": gid, "achievement_code": "play_1h", "client_ts": ts, "nonce": achNonce("strict"),
	}, "")
	if !strings.Contains(errStr, "签名") {
		t.Fatalf("收紧模式无签名未被拒绝：%q", errStr)
	}
}

// 2. achUnlockCore 幂等回归（§14.8.4/§14.8.5）：同成就重复解锁零副作用
func TestAchUnlockCoreIdempotent(t *testing.T) {
	if err := store.InitRedis(config.Load()); err != nil {
		t.Skip("Redis 不可用：DriveToken 会话签发依赖 Redis，跳过")
	}
	gid := achSetup(t)
	defer achCleanup(t)
	achResetRedis(t)
	s := NewServer(config.Load())

	var ach model.GameAchievement
	if err := store.DB.Where("game_id = ? AND code = ?", gid, "play_1h").First(&ach).Error; err != nil {
		t.Fatalf("成就定义缺失：%v", err)
	}

	already, expGain, _, _, _, err := achUnlockCore(achTestUser, ach)
	if err != nil || already || expGain != 10 {
		t.Fatalf("首次解锁异常：already=%v expGain=%d err=%v", already, expGain, err)
	}
	var u1 model.User
	store.DB.Where("username = ?", achTestUser).First(&u1)

	already2, expGain2, _, _, _, err2 := achUnlockCore(achTestUser, ach)
	if err2 != nil || !already2 || expGain2 != 0 {
		t.Fatalf("重复解锁未幂等：already=%v expGain=%d err=%v", already2, expGain2, err2)
	}
	var u2 model.User
	store.DB.Where("username = ?", achTestUser).First(&u2)
	if u1.Exp != u2.Exp {
		t.Fatalf("重复解锁重复发经验：%d → %d", u1.Exp, u2.Exp)
	}
	var logs int64
	store.DB.Model(&model.ProfileExpLog{}).Where("username = ? AND reason = ?", achTestUser, "unlock_achievement").Count(&logs)
	if logs != 1 {
		t.Fatalf("经验日志应为 1 条，实得 %d", logs)
	}

	// HTTP 幂等路径：已解锁成就上报返回 already=true（先清主用户会话密钥模拟过期，
	// 走降级放行；否则无签名会被会话密钥验签拒绝）
	if store.RedisAvailable() {
		store.RDB.Del(context.Background(), achSignKeyRedisKey(achTestUser, gid))
	}
	data, errStr := achDoUnlock(t, s, achTestUser, map[string]interface{}{
		"game_id": gid, "achievement_code": "play_1h", "client_ts": time.Now().Unix(), "nonce": achNonce("idem"),
	}, "")
	if errStr != "" || data["already"] != true {
		t.Fatalf("HTTP 幂等上报异常：already=%v err=%s", data["already"], errStr)
	}
}

// 3. 引擎规则表 + 时段边界（§14.8.3：05:59/06:00/09:00/09:01、23:00/04:00）
func TestAchEngineRules(t *testing.T) {
	cases := []struct {
		code        string
		event       string
		playSeconds int64
		playCount   int64
		now         time.Time
		want        bool
	}{
		{"first_play", "start", 0, 1, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), true},
		{"first_play", "start", 0, 0, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), false},
		{"play_1h", "end", 3600, 0, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), true},
		{"play_1h", "end", 3599, 0, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), false},
		{"play_10_times", "end", 0, 10, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), true},
		{"play_10_times", "end", 0, 9, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), false},
		{"early_bird", "start", 0, 0, time.Date(2026, 1, 1, 5, 59, 0, 0, time.Local), false},
		{"early_bird", "start", 0, 0, time.Date(2026, 1, 1, 6, 0, 0, 0, time.Local), true},
		{"early_bird", "start", 0, 0, time.Date(2026, 1, 1, 9, 0, 0, 0, time.Local), false},
		{"early_bird", "start", 0, 0, time.Date(2026, 1, 1, 9, 1, 0, 0, time.Local), false},
		{"early_bird", "end", 0, 0, time.Date(2026, 1, 1, 7, 0, 0, 0, time.Local), false}, // end 不判时段
		{"play_night_owl", "start", 0, 0, time.Date(2026, 1, 1, 23, 0, 0, 0, time.Local), true},
		{"play_night_owl", "start", 0, 0, time.Date(2026, 1, 1, 3, 59, 0, 0, time.Local), true},
		{"play_night_owl", "start", 0, 0, time.Date(2026, 1, 1, 4, 0, 0, 0, time.Local), false},
		{"play_night_owl", "start", 0, 0, time.Date(2026, 1, 1, 10, 0, 0, 0, time.Local), false},
		{"first_screenshot", "start", 0, 1, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), false}, // 未匹配规则：留给链路 B/C
		{"war3_exclusive_win4", "start", 0, 5, time.Date(2026, 1, 1, 12, 0, 0, 0, time.Local), false},
	}
	for _, c := range cases {
		if got := achEngineRuleHit(c.code, c.event, c.playSeconds, c.playCount, c.now); got != c.want {
			t.Errorf("规则 %s(%s) %s 秒=%d 次=%d：期望 %v 实得 %v",
				c.code, c.event, c.now.Format("15:04"), c.playSeconds, c.playCount, c.want, got)
		}
	}
}

// 4. 引擎端到端：end 上报跨阈值只解锁一次（§14.8.3/§14.8.4）
func TestAchEngineEvaluateOnce(t *testing.T) {
	gid := achSetup(t)
	defer achCleanup(t)
	s := NewServer(config.Load())

	// 库条目跨阈值（achSetup 已建行，防重复插入走 Updates）
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", achTestUser, gid).
		Updates(map[string]interface{}{"play_seconds": 3700, "play_count": 3})

	// 清定义缓存（防其他用例污染）
	achEngineMu.Lock()
	delete(achEngineDefs, gid)
	achEngineMu.Unlock()

	// 第 1 次 end 判定：解锁 play_1h + first_play；first_screenshot 无规则跳过
	s.achEngineEvaluate(achTestUser, gid, "end", 3700, 3)
	codes := achUnlockedCodes(t, gid)
	if !codes["play_1h"] || !codes["first_play"] {
		t.Fatalf("首次判定解锁不全：%v", codes)
	}
	if codes["first_screenshot"] {
		t.Fatalf("无规则成就 first_screenshot 不应被自动解锁")
	}

	// 第 2 次 end 判定：不重复解锁（幂等）
	s.achEngineEvaluate(achTestUser, gid, "end", 7400, 4)
	codes2 := achUnlockedCodes(t, gid)
	if len(codes2) != len(codes) {
		t.Fatalf("重复判定重复解锁：%v → %v", codes, codes2)
	}
}

func achUnlockedCodes(t *testing.T, gid uint) map[string]bool {
	t.Helper()
	var rows []model.UserAchievement
	store.DB.Where("username = ? AND game_id = ?", achTestUser, gid).Find(&rows)
	out := map[string]bool{}
	for _, ua := range rows {
		var d model.GameAchievement
		store.DB.First(&d, ua.AchievementID)
		out[d.Code] = true
	}
	return out
}

// 5. HandleGamePlay 会话计数 + 引擎触发（start 新会话 +1，心跳续期不计数）
func TestGamePlayCountAndEngineTrigger(t *testing.T) {
	if err := store.InitRedis(config.Load()); err != nil {
		t.Skip("Redis 不可用：DriveToken 会话签发依赖 Redis，跳过")
	}
	gid := achSetup(t)
	defer achCleanup(t)
	s := NewServer(config.Load())
	gamePlayMu.Lock()
	gamePlaying = map[string]map[uint]time.Time{} // 清 presence（防其他用例残留）
	gamePlayMu.Unlock()

	// 库条目清零起步（achSetup 已建行，防重复插入走 Updates）
	store.DB.Model(&model.GameLibrary{}).Where("username = ? AND game_id = ?", achTestUser, gid).
		Updates(map[string]interface{}{"play_seconds": 0, "play_count": 0})

	play := func(action string, seconds int64) {
		body, _ := json.Marshal(map[string]interface{}{"action": action, "seconds": seconds})
		req := httptest.NewRequest(http.MethodPost, "/api/game/play/"+strconv.FormatUint(uint64(gid), 10)+"?username="+achTestUser, bytes.NewReader(body))
		req.SetPathValue("id", strconv.FormatUint(uint64(gid), 10))
		req.Header.Set("X-Drive-Token", DriveTokenIssue(achTestUser))
		w := httptest.NewRecorder()
		s.HandleGamePlay(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("play %s 失败：code=%d body=%s", action, w.Code, w.Body.String())
		}
		time.Sleep(150 * time.Millisecond) // 引擎异步判定落库
	}

	play("start", 0)  // 新会话：count → 1
	play("start", 0)  // 心跳续期：count 不变
	play("start", 0)  // 心跳续期：count 不变
	play("end", 3600) // end：秒数累加 + 引擎判定

	var lib model.GameLibrary
	store.DB.Where("username = ? AND game_id = ?", achTestUser, gid).First(&lib)
	if lib.PlayCount != 1 {
		t.Fatalf("play_count 期望 1（新会话计数、心跳不计），实得 %d", lib.PlayCount)
	}
	if lib.PlaySeconds != 3600 {
		t.Fatalf("play_seconds 期望 3600，实得 %d", lib.PlaySeconds)
	}
	codes := achUnlockedCodes(t, gid)
	if !codes["play_1h"] {
		t.Fatalf("end 上报后引擎未自动解锁 play_1h：%v", codes)
	}

	gamePlayMu.Lock()
	delete(gamePlaying, achTestUser)
	gamePlayMu.Unlock()
}
