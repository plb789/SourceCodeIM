package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	gormlogger "gorm.io/gorm/logger"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
)

var DB *gorm.DB

// SlowQueryCount 慢查询累计（仪表盘观测）：gorm 执行 >500ms 计一次
// （与日志 SlowThreshold 同阈值；持续增长=索引劣化/锁等待信号）
var SlowQueryCount atomic.Int64

// slowQueryLogger gorm 日志包装：全部行为转发内置 logger，仅 Trace 中加慢查询计数
type slowQueryLogger struct{ gormlogger.Interface }

func (l slowQueryLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
	if err == nil && time.Since(begin) > 500*time.Millisecond {
		SlowQueryCount.Add(1)
	}
	l.Interface.Trace(ctx, begin, fc, err)
}

// InitMySQL 初始化 MySQL 连接池、自动创建数据库与数据表
func InitMySQL(cfg *config.Config) error {
	// 先连接不含数据库的 DSN，确保数据库存在
	if err := ensureDatabase(cfg.MySQLDSN); err != nil {
		return err
	}

	// GORM 日志降噪：RecordNotFound 是业务正常分支（挂载盘探测文件/用户是否存在等高频路径），
	// 默认配置会打红字误导排查（实测：资源管理器粘贴前 PROPFIND 探测不存在文件每次刷红字）。
	// 官方正规配置 IgnoreRecordNotFoundError=true——真正的 SQL 执行错误仍照常输出
	db, err := gorm.Open(mysql.Open(cfg.MySQLDSN), &gorm.Config{
		Logger: slowQueryLogger{gormlogger.New(log.New(os.Stdout, "\r\n", log.LstdFlags), gormlogger.Config{
			SlowThreshold:             500 * time.Millisecond,
			IgnoreRecordNotFoundError: true,
			LogLevel:                  gormlogger.Warn,
		})},
	})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}

	// 并发优化 E4：连接池参数配置化（原实现未设置——Go 默认 max_open=0 无上限、max_idle=2，
	// 风暴后空闲连接仅留 2 个，高峰重建握手开销大；现从配置读取，缺省兜底见 config.go 注释）
	if sqlDB, err := db.DB(); err == nil {
		maxOpen := cfg.DBMaxOpenConns
		if maxOpen <= 0 {
			maxOpen = 2000
		}
		maxIdle := cfg.DBMaxIdleConns
		if maxIdle <= 0 {
			maxIdle = 50
		}
		if maxIdle > maxOpen {
			maxIdle = maxOpen
		}
		sqlDB.SetMaxOpenConns(maxOpen)
		sqlDB.SetMaxIdleConns(maxIdle)
		// 连接最长存活期：配置 >0 用配置；0 兜底 240s（沿用原加固值——防复用临期死连接，
		// 兼容已删除的历史硬编码段语义）
		lifetime := cfg.DBConnMaxLifetime
		if lifetime <= 0 {
			lifetime = 240
		}
		sqlDB.SetConnMaxLifetime(time.Duration(lifetime) * time.Second)
		logger.Info("MySQL 连接池：max_open=%d max_idle=%d lifetime=%ds", maxOpen, maxIdle, lifetime)
	}

	// 自动创建数据表（首次启动）；阶段四十六追加文档编辑版本表 im_doc_edit
	// 阶段四十九：追加 AI 模型服务表 im_ai_provider 与 AI 智能体表 im_ai_agent（后台管理热更新数据源）
	// 阶段五十一：追加知识库表 im_kb 与知识文件表 im_kb_file（RAG 向量化数据源）
	// 阶段五十六：追加用户知识库勾选表 im_user_kb（用户端自选知识库，对所有智能体生效）
	// 阶段八十八：追加 MCP 服务器配置表 im_mcp_server（TRAE CN 同款 MCP 能力，服务端归口）
	// 原实现：迁移列表不含 im_user_kb
	//	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}); err != nil {
	// 阶段一百四十二：追加群聊三表 im_group / im_group_member / im_group_invite（微信同款多群聊一期）
	// 原实现：迁移列表不含群聊三表
	//	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}, &model.UserKB{}, &model.PointsLog{}, &model.MCPServer{}, &model.CallLog{}); err != nil {
	// 阶段一百四十五：追加工作台应用表 im_workbench_app（后台维护办公网站清单，客户端宫格导航）
	// 阶段一百五十四：追加积分红包两表 im_red_packet / im_red_packet_claim（微信同款红包，积分归口）
	// 阶段二百六十：追加客户端版本表 im_app_version（APP/PC 自动更新，服务端版本归口）
	// 阶段二百六十一：追加远程控制设备表 im_device（向日葵同款设备ID+验证码远程控制）
	// 阶段二百六十二：追加跨账号信任对表 im_remote_trust（静态密码成功连接免码直连）与
	// 自定义远程卡片表 im_remote_card（设备ID+备注，服务端存储三端同步）
	// 阶段二百八十：追加朋友圈四表 im_moment / im_moment_like / im_moment_comment / im_moment_unread
	// （微信同款朋友圈：动态+点赞+评论回复+互动红点归口）
	// 阶段二百九十三：追加服务号六表 im_official_account / im_official_subscribe / im_official_menu /
	// im_official_template / im_official_message / im_official_audit（微信同款公众号服务）
	// 阶段二百九十五：追加 Steam 同款个人资料四表 im_game_achievement / im_user_achievement / im_user_badge / im_profile_exp_log
	// 阶段二百九十五 P1：追加展示柜 + 留言板 im_profile_showcase / im_profile_comment
	// 阶段二百九十五 P2.3：追加截图表 im_profile_screenshot
	// 阶段二百九十五 P3：追加卡片合成徽章三表 im_card / im_user_card / im_badge_template
	// 补充遗漏：Agent/AI 记忆规则/MCP 插件相关 13 表（运行时高频查询，缺失即 500）
	// A1：追加等级配置表 im_user_level_config（文档附录 A，管理员预设等级权益数据）
	// A2：追加每日成就独立两表 im_game_daily_achievement / im_user_daily_achievement（方案 A，可每日重复解锁）
	// AutoMigrate 之前先清洗存量负值数据——CHECK 约束（points >= 0）会 VALIDATE 存量行，
	// 如果有任何一行 points < 0（绕过应用层的直连 SQL / 管理端误操作）会导致 ALTER TABLE 直接失败。
	// 这些清洗与应用层的 GREATEST(points - ?, 0) 守卫口径一致，幂等可重跑
	if r := db.Exec(`UPDATE im_user SET points = GREATEST(points, 0) WHERE points < 0`); r.Error != nil {
		fmt.Printf("[store] WARN 存量 im_user.points 负值清洗失败（不影响主流程，服务启动后需手工对账）: %v\n", r.Error)
	}
	if r := db.Exec(`UPDATE im_merchant SET pending_points = GREATEST(pending_points, 0), balance_points = GREATEST(balance_points, 0), total_refunded = GREATEST(total_refunded, 0) WHERE pending_points < 0 OR balance_points < 0 OR total_refunded < 0`); r.Error != nil {
		fmt.Printf("[store] WARN 存量 im_merchant 负值清洗失败（不影响主流程）: %v\n", r.Error)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}, &model.UserKB{}, &model.PointsLog{}, &model.MCPServer{}, &model.MCPPlugin{}, &model.SysPrompt{}, &model.CallLog{}, &model.Group{}, &model.GroupMember{}, &model.GroupInvite{}, &model.Announcement{}, &model.AnnouncementAttachment{}, &model.AnnouncementRead{}, &model.WorkbenchApp{}, &model.RedPacket{}, &model.RedPacketClaim{}, &model.RemoteLog{}, &model.DriveFile{}, &model.DriveShare{}, &model.DriveUploadSession{}, &model.AppVersion{}, &model.Device{}, &model.RemoteTrust{}, &model.RemoteCard{}, &model.Moment{}, &model.MomentLike{}, &model.MomentComment{}, &model.MomentUnread{}, &model.GatewayBook{}, &model.GatewayDbwrite{}, &model.GatewayDbwriteAck{}, &model.RechargeOrder{}, &model.OfficialAccount{}, &model.OfficialSubscribe{}, &model.OfficialMenu{}, &model.OfficialKeyword{}, &model.OfficialTemplate{}, &model.OfficialMessage{}, &model.OfficialAudit{}, &model.ClamavQuarantine{}, &model.ClamavWhitelist{}, &model.GameAchievement{}, &model.UserAchievement{}, &model.UserBadge{}, &model.ProfileExpLog{}, &model.ProfileShowcase{}, &model.ProfileComment{}, &model.ProfileScreenshot{}, &model.ProfileScreenshotLike{}, &model.Card{}, &model.UserCard{}, &model.BadgeTemplate{}, &model.UserShopItem{}, &model.AIMemory{}, &model.AIMemoryPref{}, &model.AIRule{}, &model.AISession{}, &model.AgentTaskRecord{}, &model.AgentTaskTpl{}, &model.AgentCronTask{}, &model.AgentWhitelist{}, &model.AgentStepRecord{}, &model.AgentChangeRecord{}, &model.MsgPurgeApply{}, &model.UserLevelConfig{}, &model.GameDailyAchievement{}, &model.UserDailyAchievement{}); err != nil {
		return fmt.Errorf("自动建表失败: %w", err)
	}

	// 存量数据修复（幂等，每次启动都会跑但只有旧格式数据时才更新）
	// 把 ProfileExpLog.reason='daily_achievement' 的技术化 detail（"每日成就: game#X code=Y date=Z"）
	// 自动更新为友好中文（"完成每日任务「<成就名>」"），跨版本部署时历史数据也能自动修正
	// 注意：db.Exec 的错误绝对不能 return——迁移失败不影响主流程，服务必须能正常启动
	if r := db.Exec(`UPDATE im_profile_exp_log l
		INNER JOIN im_game_daily_achievement d
		ON d.game_id = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(l.detail, '#', -1), ' ', 1) AS UNSIGNED)
		AND d.code   = SUBSTRING_INDEX(SUBSTRING_INDEX(l.detail, 'code=', -1), ' ', 1)
		SET l.detail = CONCAT('完成每日任务「', d.name, '」')
		WHERE l.reason = 'daily_achievement' AND l.detail LIKE '每日成就:%'`); r.Error != nil {
		fmt.Printf("[store] WARN 存量 exp_log detail 迁移失败（不影响主流程）: %v\n", r.Error)
	}

	// 系统保留账户 seed：platform_pool（孤儿积分暂存池）
	// 充值退/退款时原用户被硬删或注销 → 无处可退的积分归入此账户
	// Role=UserRoleSystem, Status=UserStatusLocked → 不能登录、不能消费，只能被系统代码加分
	// 用 OnConflict DoNothing 幂等写入（唯一键 idx_username），已存在时不覆盖（保留已有 points 余额）
	ppSeed := model.User{
		Username:  model.StorePlatformPool,
		Nickname:  "系统积分暂存池",
		Role:      model.UserRoleSystem,
		Status:    model.UserStatusLocked,
		LockReason: "系统保留账户，不可登录",
		Points:    0,
	}
	if r := db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "username"}},
		DoNothing: true,
	}).Create(&ppSeed); r.Error != nil {
		fmt.Printf("[store] WARN platform_pool seed 失败（不影响主流程）: %v\n", r.Error)
	}
	// 二次校验：如果已存在但 role/status 不对（手工误改），强制修正
	db.Model(&model.User{}).
		Where("username = ? AND (role != ? OR status != ?)", model.StorePlatformPool, model.UserRoleSystem, model.UserStatusLocked).
		Updates(map[string]interface{}{"role": model.UserRoleSystem, "status": model.UserStatusLocked, "lock_reason": "系统保留账户，不可登录"})

	// 角色分离迁移（2026-11-19）：UserRoleSystem=2 与原商户 role=2 冲突
	// 把所有 role=2 且在 im_merchant 表中有记录的商户账号迁移到 role=3（UserRoleMerchant）
	// platform_pool 已在上面强制修正回 role=2，不会被误改
	// 用原生 SQL 避免 GORM 子查询 IN (?) 绑定丢失括号的 bug（实测生成 "IN SELECT" 而非 "IN (SELECT)"）
	res := db.Exec("UPDATE im_user SET role = ?, update_time = NOW() WHERE role = ? AND username IN (SELECT username FROM im_merchant)",
		model.UserRoleMerchant, model.UserRoleSystem)
	if res.Error != nil {
		fmt.Printf("[store] WARN 商户角色迁移失败（不影响主流程）: %v\n", res.Error)
	} else {
		fmt.Printf("[store] 商户角色迁移完成：%d 条记录从 role=2 迁移到 role=3\n", res.RowsAffected)
	}
	// 兜底：platform_pool 必须保持 role=2（不受上面子查询影响，因为它不在 im_merchant 表里）
	db.Model(&model.User{}).
		Where("username = ?", model.StorePlatformPool).
		UpdateColumn("role", model.UserRoleSystem)

	// A1 seed：等级配置表首次建表后自动 INSERT/UPDATE 文档附录 A 预设数据
	// 必须用 Save 或 OnConflict UPDATE（不是 DoNothing）—— 保证 ShowcaseSlots/Title 等字段是最新值
	// 否则旧表如果已经有 Lv1-Lv5 行，DoNothing 会跳过更新，seed 里 ShowcaseSlots=4 不会生效
	levelSeed := []model.UserLevelConfig{
		{Level: 1, ExpRequired: 0,    BadgeCode: "lv1",  Title: "新人玩家", ShowcaseSlots: 3},
		{Level: 2, ExpRequired: 500,  BadgeCode: "lv2",  Title: "",        ShowcaseSlots: 3},
		{Level: 3, ExpRequired: 1125, BadgeCode: "lv3",  Title: "",        ShowcaseSlots: 3},
		{Level: 4, ExpRequired: 2000, BadgeCode: "lv4",  Title: "",        ShowcaseSlots: 3},
		{Level: 5, ExpRequired: 3125, BadgeCode: "lv5",  Title: "初级玩家", ShowcaseSlots: 4},
		{Level: 10, ExpRequired: 50000,  BadgeCode: "lv10",  Title: "资深玩家", ShowcaseSlots: 5},
		{Level: 15, ExpRequired: 112500, BadgeCode: "lv15",  Title: "",         ShowcaseSlots: 6},
		{Level: 20, ExpRequired: 200000, BadgeCode: "lv20",  Title: "老玩家",   ShowcaseSlots: 7},
		{Level: 30, ExpRequired: 450000, BadgeCode: "lv30",  Title: "",         ShowcaseSlots: 8},
		{Level: 40, ExpRequired: 800000, BadgeCode: "lv40",  Title: "",         ShowcaseSlots: 9},
		{Level: 50, ExpRequired: 1250000, BadgeCode: "lv50", Title: "传奇玩家", ShowcaseSlots: 10},
	}
	for _, lc := range levelSeed {
		db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "level"}},
			DoUpdates: clause.AssignmentColumns([]string{"exp_required", "badge_code", "title", "showcase_slots"}),
		}).Create(&lc)
	}

	// A2 seed：游戏成就定义（文档附录 B 稀有度 → 经验值映射）
	// 启动时查所有现有 im_game，按 slug 匹配专属成就模板 + 通用成就池兜底
	// 用 OnConflict DoNothing 幂等写入（唯一键 idx_game_code(game_id, code)）
	// 口径：每个游戏至少 12 条成就（Common×6 + Uncommon×3 + Rare×2 + Epic×1）
	achRarityExp := map[int8]int{0: 10, 1: 25, 2: 50, 3: 100, 4: 200} // Common 0 → Legendary 4

	type achTpl struct {
		Code   string
		Name   string
		Desc   string
		Rarity int8
	}

	// 通用成就池：覆盖所有游戏的跨场景里程碑
	// 分类口径（P0 游玩类 13 条 + P1 充值类 6 条，共计 19 条/游戏）：
	//   游玩类：Common×6 + Uncommon×3 + Rare×2 + Epic×1 + Legendary×1
	//   充值类：Common×2 + Uncommon×1 + Rare×1 + Epic×1 + Legendary×1（积分口径）
	achGeneric := []achTpl{
		// ===== 游玩类（链路 A：play/start/end/时段） =====

		// Common (6) — +10 exp each
		{"first_play", "初入江湖", "第一次启动该游戏", 0},
		{"play_1h", "初尝滋味", "累计游玩 1 小时", 0},
		{"play_5h", "渐入佳境", "累计游玩 5 小时", 0},
		{"play_10h", "小有成就", "累计游玩 10 小时", 0},
		{"play_10_times", "常客", "累计启动 10 次", 0},
		{"first_screenshot", "留影纪念", "在该游戏中截取第一张截图", 0},

		// Uncommon (3) — +25 exp each
		{"play_25h", "沉浸其中", "累计游玩 25 小时", 1},
		{"play_30_times", "回头客", "累计启动 30 次", 1},
		{"early_bird", "早起的鸟儿", "在清晨 6:00-9:00 之间游玩", 1},

		// Rare (2) — +50 exp each
		{"play_50h", "深度玩家", "累计游玩 50 小时", 2},
		{"play_night_owl", "夜猫子", "在深夜 23:00-3:00 之间累计游玩 10 小时", 2},

		// Epic (1) — +100 exp
		{"play_100h", "资深玩家", "累计游玩 100 小时", 3},

		// Legendary (1) — +200 exp
		{"play_200h", "传奇玩家", "累计游玩 200 小时", 4},

		// ===== 充值类（链路 D：积分充值成功 ack 后触发，points 口径） =====

		// Common (2) — +10 exp each
		{"first_pay", "初次充值", "在该游戏中完成第一次充值", 0},
		{"pay_100", "小试牛刀", "累计充值 100 积分", 0},

		// Uncommon (1) — +25 exp
		{"pay_500", "小有投入", "累计充值 500 积分", 1},

		// Rare (1) — +50 exp
		{"pay_1000", "慷慨解囊", "累计充值 1000 积分", 2},

		// Epic (1) — +100 exp
		{"pay_5000", "氪金玩家", "累计充值 5000 积分", 3},

		// Legendary (1) — +200 exp
		{"pay_10000", "至尊金主", "累计充值 10000 积分", 4},
	}

	// 专属成就模板：按游戏 slug 匹配（仅定义与通用池不同的特色成就，通用池仍然会一并插入）
	// 格式：slug → []achTpl
	achBySlug := map[string][]achTpl{
		// ===== FPS / 射击类 =====
		"counter-strike-2": {
			{"first_blood", "初战告捷", "在对战中取得第一次击杀", 0},
			{"ace", "ACE", "一回合内击杀对方全部 5 人", 3},
			{"defuse_ace", "拆弹 ACE", "残局 1v5 成功拆除炸弹", 4},
			{"headshot_master", "爆头大师", "累计完成 1000 次爆头", 2},
			{"deagle_only", "沙鹰专家", "使用 Desert Eagle 完成 50 次击杀", 2},
			{"clutch_1v5", "残局大师", "在 1v5 残局中成功翻盘", 4},
		},
		"valorant": {
			{"first_blood", "首杀", "获得第一次击杀", 0},
			{"ace_round", "王牌回合", "一回合内击杀所有敌人", 3},
			{"operator_main", "狙击手", "使用 Operator 完成 100 次击杀", 2},
			{"flawless_victory", "完美胜利", "在竞技模式中以 13:0 获胜", 4},
		},
		"overwatch-2": {
			{"first_elimination", "首杀", "获得第一次消灭", 0},
			{"teammate_rescue", "救命恩人", "一次对局中复活队友 5 次", 1},
			{"payload_hero", "推车英雄", "在推车模式中累计推车上限 50 次", 2},
			{"potg", "全场最佳", "获得一次全场最佳（Play of the Game）", 3},
		},
		"rainbow-six-siege": {
			{"first_blood", "首杀", "取得第一次击杀", 0},
			{"one_vs_five", "孤胆英雄", "1v5 残局成功获胜", 4},
			{"drone_master", "侦查大师", "一局中用无人机标记敌人 20 次", 1},
		},

		// ===== MOBA 类 =====
		"dota-2": {
			{"first_blood", "一血", "送出或拿到一血", 0},
			{"rampage", "暴走", "连续击杀对方 5 人且自己未死", 4},
			{"triple_kill", "三杀", "一次团战中连续击杀 3 人", 2},
			{"ward_master", "视野大师", "累计放置 500 个守卫", 1},
			{"comeback_king", "翻盘之王", "落后 1 万经济差的情况下获胜", 4},
		},
		"league-of-legends": {
			{"first_blood", "一血", "在对局中取得第一次击杀", 0},
			{"penta_kill", "五杀", "一次团战中连续击杀对方 5 人", 4},
			{"triple_kill", "三杀", "一次团战中连续击杀 3 人", 2},
			{"dragon_slayer", "屠龙勇士", "累计击杀 50 条小龙", 1},
			{"baron_steal", "抢龙", "从对方手中抢到纳什男爵", 4},
		},
		"smite": {
			{"first_blood", "首杀", "获得第一次击杀", 0},
			{"pentakill", "五杀", "一次团战中连续击杀 5 人", 4},
			{"fire_giant", "火焰巨人杀手", "累计击杀 20 次火焰巨人", 2},
		},

		// ===== 沙盒 / 生存类 =====
		"minecraft": {
			{"first_craft", "工匠学徒", "完成第一次合成", 0},
			{"first_mine", "矿工", "挖到第一块矿石", 0},
			{"diamond_hunter", "钻石猎人", "挖到第一颗钻石", 1},
			{"ender_dragon", "龙之杀手", "击败末影龙", 3},
			{"nether_portal", "下界之门", "点亮下界传送门", 1},
			{"full_armor", "铁甲战士", "集齐一整套钻石护甲", 2},
			{"wither_killer", "凋灵猎人", "击败凋灵 Boss", 3},
			{"elytra", "翱翔天际", "获得鞘翅并飞行 1000 格", 4},
		},
		"rust": {
			{"first_survive", "活下来", "存活超过 24 小时（游戏内时间）", 0},
			{"first_kill", "生存本能", "在 PVP 中取得第一次击杀", 0},
			{"base_builder", "建筑师", "建造超过 100 个建筑部件", 1},
			{"raider", "掠夺者", "成功突袭并掠夺他人基地 5 次", 3},
		},
		"don_t_starve": {
			{"first_survive", "活下去", "存活 10 天", 0},
			{"winter_survivor", "过冬达人", "成功度过第一个冬天", 1},
			{"ancient_guardian", "远古守护者", "击败远古守卫者", 3},
		},

		// ===== RPG / 动作类 =====
		"elden-ring": {
			{"first_boss", "褪色者的第一步", "击败第一个 Boss", 0},
			{"margit", "恶兆已除", "击败恶兆玛尔基特", 2},
			{"godrick", "黄金树种子", "击败接肢葛德文", 2},
			{"malenia", "米凯拉之刃", "击败米凯拉之刃·玛莲妮亚", 4},
			{"radahn", "碎星之战", "在碎星之战中击败拉塔恩", 3},
			{"rune_bearer", "大卢恩持有者", "装备第一个大卢恩", 1},
			{"all_bosses", "艾尔登之王", "击败所有主线 Boss", 4},
		},
		"cyberpunk-2077": {
			{"first_kill", "街头佣兵", "取得第一次击杀", 0},
			{"ripperdoc", "赛博改造", "安装第一个义体", 0},
			{"main_story_end", "夜之城传奇", "通关主线剧情", 3},
			{"all_romances", "情场浪子", "与所有可攻略对象达成亲密关系", 3},
			{"legendary_hunter", "传说收藏家", "收集 10 件传说级装备", 2},
		},
		"gta-5": {
			{"first_heist", "江洋大盗", "完成第一次抢劫", 1},
			{"story_complete", "洛圣都之王", "通关所有主线任务", 3},
			{"first_million", "百万富翁", "累计资产达到 100 万", 2},
			{"wanted_5min", "五星通缉", "在五星通缉下存活 5 分钟", 2},
			{"all_stunts", "特技大师", "完成全部 50 个特技跳跃", 3},
		},
		"witcher-3": {
			{"first_sign", "法印学徒", "第一次使用法印", 0},
			{"griffin", "狮鹫已除", "击败皇家狮鹫", 1},
			{"story_complete", "猎魔人传奇", "通关主线剧情", 3},
			{"all_gwent", "昆特牌大师", "收集所有昆特牌", 3},
			{"blood_and_wine", "陶森特守护者", "完成血与酒 DLC 主线", 3},
		},

		// ===== 体育 / 竞速类 =====
		"fifa-24": {
			{"first_match", "初登场", "完成第一场比赛", 0},
			{"first_goal", "破门得分", "打进第一个进球", 0},
			{"hat_trick", "帽子戏法", "一场比赛中打进 3 球", 2},
			{"champion", "联赛冠军", "带领球队夺得联赛冠军", 3},
		},
		"nba-2k24": {
			{"first_match", "首秀", "完成第一场比赛", 0},
			{"first_3pointer", "三分出手", "投进第一个三分球", 0},
			{"triple_double", "三双机器", "一场比赛中取得三双数据", 3},
			{"champion", "总冠军", "夺得 NBA 总冠军", 3},
		},
		"forza_horizon-5": {
			{"first_race", "竞速新秀", "完成第一场比赛", 0},
			{"first_win", "初次夺冠", "赢得第一场比赛", 0},
			{"all_cars", "车库大师", "收集 100 辆不同的车辆", 2},
			{"s1_classic", "S1 经典赛冠军", "赢得 S1 赛季经典赛", 3},
		},

		// ===== 策略 / 模拟类 =====
		"civilization-6": {
			{"first_city", "建国之父", "建立第一座城市", 0},
			{"first_tech", "科技之光", "研究第一项科技", 0},
			{"science_victory", "科学胜利", "以科学胜利方式通关", 4},
			{"domination_victory", "统治胜利", "以统治胜利方式通关", 4},
			{"20_cities", "超级大国", "同时拥有 20 座城市", 3},
		},
		"stellaris": {
			{"first_contact", "第一次接触", "与外星文明第一次接触", 1},
			{"wonders", "奇观建造者", "建造 5 个不同的奇观", 2},
			{"galactic_conqueror", "银河征服者", "控制银河系 50% 的领土", 4},
		},
		"europa_universalis_4": {
			{"first_royal_marriage", "王室联姻", "完成第一次王室联姻", 0},
			{"first_war", "第一次战争", "赢得第一场战争", 0},
			{"puella_magna", "普鲁士的崛起", "成立普鲁士", 3},
		},

		// ===== 平台 / 冒险类 =====
		"hollow_knight": {
			{"first_charm", "护符收藏家", "收集第一个护符", 0},
			{"first_boss", "小骑士", "击败第一个 Boss", 0},
			{"all_bosses", "空洞骑士", "击败所有 Boss（含寻神者）", 4},
			{"steel_soul", "钢魂通关", "在钢魂模式下通关", 4},
		},
		"celeste": {
			{"first_chapter", "启程", "完成第一章", 0},
			{"all_chapters", "登顶", "完成所有章节", 3},
			{"b_sides", "B 面通关", "完成所有 B 面关卡", 3},
			{"c_sides", "C 面通关", "完成所有 C 面关卡", 4},
		},

		// ===== 多人合作 / 生存类 =====
		"left_4_dead_2": {
			{"first_helped", "救命恩人", "拉起倒下的队友 5 次", 0},
			{"no_incap", "毫发无损", "一个战役中不被击倒", 2},
			{"realism_survivor", "绝境求生", "在写实模式下通关一个战役", 3},
		},
		"warframe": {
			{"first_warframe", "战甲收集家", "获得第一个战甲", 0},
			{"first_sortie", "出击", "完成第一次每日出击", 1},
			{"mr20", "精通 20 级", "达到精通等级 20", 4},
		},
		"destiny-2": {
			{"first_strike", "打击完成", "完成第一个打击任务", 0},
			{"first_raid", "初次突袭", "完成第一次突袭", 2},
			{"lfg_titan", "泰坦征服者", "在《希望的火花》突袭中通关", 4},
		},
	}

	// B1：查所有现有游戏，逐个匹配模板
	var allGames []model.Game
	if err := db.Select("id, slug, name").Find(&allGames).Error; err != nil {
		logger.Warn("成就 seed：查询游戏列表失败，跳过：%v", err)
	} else {
		totalSeeded := 0
		for _, g := range allGames {
			var templates []achTpl
			// ① 通用池（所有游戏都有）
			templates = append(templates, achGeneric...)
			// ② 专属模板（按 slug 精确匹配）
			if extra, ok := achBySlug[g.Slug]; ok {
				templates = append(templates, extra...)
			}
			// ③ 批量插入（OnConflict DoNothing 幂等）
			for _, t := range templates {
				expReward := achRarityExp[t.Rarity]
				if expReward == 0 {
					expReward = 10 // 兜底
				}
				ach := model.GameAchievement{
					GameID:    g.ID,
					Code:      t.Code,
					Name:      t.Name,
					Desc:      t.Desc,
					Icon:      "",
					Rarity:    t.Rarity,
					ExpReward: expReward,
				}
				res := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&ach)
				if res.Error == nil && res.RowsAffected > 0 {
					totalSeeded++
				}
			}
		}
		if len(allGames) > 0 {
			logger.Info("成就 seed：覆盖 %d 款游戏，新增 %d 条成就定义（DoNothing 幂等，已存在不计）", len(allGames), totalSeeded)
		} else {
			logger.Info("成就 seed：im_game 为空，跳过（游戏上架后下次启动自动补齐）")
		}
	}

	// ===== P1 每日成就 seed（方案 A 独立表，覆盖所有已上架游戏，DoNothing 幂等） =====
	// 分类：游戏使用类 3 条 + 充值类 1 条 + 社交互动类 3 条，共计 7 条/游戏
	achDailyGeneric := []achTpl{
		// --- 游戏使用类 ---
		{"daily_play", "每日游玩", "当日启动该游戏至少一次", 0},
		{"daily_play_30m", "每日耕耘", "当日累计游玩 30 分钟以上", 1},
		{"daily_save", "每日存档", "当日完成一次云存档上传", 0},

		// --- 充值类 ---
		{"daily_pay", "每日充值", "当日在该游戏完成一次充值", 1},

		// --- 社交互动类 ---
		{"daily_review_helpful", "乐于助人", "当日给他人评测点「有帮助」", 0},
		{"daily_review", "每日评测", "当日发布一条游戏评测", 1},
		{"daily_review_reply", "每日评论", "当日在评测区回复一条", 0},
		// TODO: daily_card_redeem（每日兑换）——卡密充值无 game_id，暂不触发；
		// 后续可改为触发时遍历用户所有已加入游戏，在每个游戏下都尝试解锁
	}
	if len(allGames) > 0 {
		totalDailySeeded := 0
		for _, g := range allGames {
			for _, t := range achDailyGeneric {
				expReward := achRarityExp[t.Rarity]
				if expReward == 0 {
					expReward = 10
				}
				dach := model.GameDailyAchievement{
					GameID:    g.ID,
					Code:      t.Code,
					Name:      t.Name,
					Desc:      t.Desc,
					Icon:      "",
					Rarity:    t.Rarity,
					ExpReward: expReward,
				}
				res := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&dach)
				if res.Error == nil && res.RowsAffected > 0 {
					totalDailySeeded++
				}
			}
		}
		logger.Info("每日成就 seed：覆盖 %d 款游戏，新增 %d 条每日成就定义（DoNothing 幂等）", len(allGames), totalDailySeeded)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	// 登录回归加固：部分环境 MySQL 会主动断开空闲连接（日志出现 wsarecv: connection aborted），
	// 池中死连接导致"空闲后首次查询"报 invalid connection（该英文底层错误修复前还会原样下发客户端）
	// 连接最长存活期/空闲滞留期 + 后台 Ping 保活：剔除失效连接并按需重建，保证连接池始终可用。
	// 并发优化 E4 修正：原硬编码 SetMaxOpenConns(100)/SetMaxIdleConns(10) 在配置化设置之后执行
	// 会覆盖配置值（仪表盘恒显 100 的根因），现删除硬编码，池上限以 E4 段配置为准
	sqlDB.SetConnMaxIdleTime(1 * time.Minute) // 空闲连接最长滞留期，超时回收防死连接驻留
	go keepMySQLAlive(sqlDB)                  // 后台定时 Ping 保活：剔除失效连接并按需重建，保证连接池始终可用

	DB = db
	logger.Info("MySQL 连接成功，数据表已就绪")
	return nil
}

// keepMySQLAlive 后台保活：定时 Ping 数据库，剔除池中被服务端断开的死连接并按需重建
func keepMySQLAlive(sqlDB *sql.DB) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := sqlDB.Ping(); err != nil {
			logger.Warn("MySQL 保活 Ping 失败: %v", err)
		}
	}
}

// ensureDatabase 自动创建 im 数据库（不存在时）
func ensureDatabase(dsn string) error {
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return fmt.Errorf("解析 MySQL DSN 失败: %w", err)
	}
	dbName := cfg.DBName
	if dbName == "" {
		return nil
	}

	// 去除数据库名，连接服务器本身（ensureDatabase 短连接仅建库，静默 not-found 噪音同上）
	cfg.DBName = ""
	db, err := gorm.Open(mysql.Open(cfg.FormatDSN()), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Silent),
	})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	if err := db.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci", dbName)).Error; err != nil {
		return fmt.Errorf("创建数据库失败: %w", err)
	}
	return nil
}
