package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"golang.org/x/crypto/bcrypt"
)

// ErrUserExists 用户名已存在
var ErrUserExists = errors.New("用户名已存在")

// ErrInvalidLogin 用户名或密码错误
var ErrInvalidLogin = errors.New("用户名或密码错误")

// ErrUserNotFound 用户名不存在（与密码错误区分：不存在时登录尝试自动注册，密码错误时直接提示）
var ErrUserNotFound = errors.New("用户名不存在")

// ErrEmptyUsername 用户名为空
var ErrEmptyUsername = errors.New("用户名不能为空")

// ErrEmptyPassword 密码不能为空
var ErrEmptyPassword = errors.New("密码不能为空")

// ErrReservedUsername 保留字用户名（阶段一百四十二：'g'+数字 形式为群聊会话专用编码，
// 注册占用会造成用户会话与群会话目标歧义，故拒绝注册；存量用户不受影响，群 target 解析只查 im_group 表）
var ErrReservedUsername = errors.New("该用户名不可用")

// ErrNeedRegister 阶段一四五：登录自动注册关闭（register_enabled=false）后，
// 账号不存在不再静默注册，改为提示引导用户前往独立注册页注册
var ErrNeedRegister = errors.New("该账号不存在，请先注册账号")

// ErrRegisterRateLimited 阶段二百九十八：注册请求频率超限（同 IP 30s 内请求过多）
var ErrRegisterRateLimited = errors.New("请求过于频繁，请稍后再试")

// ErrRegisterFailLocked 阶段二百九十八：连续注册失败达阈值，IP 被临时锁定
var ErrRegisterFailLocked = errors.New("注册失败次数过多，请稍后再试")

// ErrRegisterIPExceeded 阶段二百九十八：同 IP 24h 内注册成功账号数超限
var ErrRegisterIPExceeded = errors.New("该 IP 今日注册账号数已达上限")

// ErrRegisterBot 阶段二百九十八：前端行为检测（蜜罐/停留时间）命中
var ErrRegisterBot = errors.New("注册请求异常，请稍后重试")

// reservedUsernameRe 保留字用户名规则：g 开头跟纯数字（如 g1、g123），与群会话 target 编码 'g'+群ID 同形
var reservedUsernameRe = regexp.MustCompile(`^g[0-9]+$`)

// isAuthBusinessError 判定登录/注册链路的业务校验错误（可直接下发客户端展示）：
// 底层依赖错误（MySQL/Redis 连接异常等，如 invalid connection）不属于业务错误，
// 由调用方统一下发通用中文提示，完整错误仅记日志，避免英文底层错误暴露给客户端
func isAuthBusinessError(err error) bool {
	return err == ErrUserExists || err == ErrInvalidLogin || err == ErrEmptyUsername || err == ErrEmptyPassword || err == ErrReservedUsername || err == ErrNeedRegister ||
		err == ErrQRLoginExpired || err == ErrQRLoginInvalid || // 阶段二百四十：扫码登录业务错误原样下发
		err == ErrRegisterRateLimited || err == ErrRegisterFailLocked || err == ErrRegisterIPExceeded || // 阶段二百九十八：注册防刷业务错误
		err == ErrRegisterBot // 阶段二百九十八：前端蜜罐/停留时间命中（对外统一模糊提示）
}

// hashPassword 密码加密（阶段二百六十四：升级 bcrypt 自描述哈希）。
// 新写入一律 bcrypt（cost 10，60 字符 $2a$ 前缀，User.password varchar(64) 可容纳）；
// 存量 SHA256 哈希由 verifyPassword 双路兼容，并在登录成功时惰性升级（upgradePasswordHash）
func hashPassword(password string) string {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		// bcrypt 仅密码超 72 字节等极端场景失败——回落 SHA256 保证注册/改密不中断
		sum := sha256.Sum256([]byte(password))
		return hex.EncodeToString(sum[:])
	}
	return string(h)
}

// verifyPassword 双路校验归口：$2 前缀走 bcrypt 比对，否则按存量 SHA256 比对。
// 返回 needUpgrade=true 表示存量旧格式校验通过，调用方应择机回写 bcrypt 哈希
func verifyPassword(stored, password string) (ok bool, needUpgrade bool) {
	if stored == "" {
		return false, false
	}
	if strings.HasPrefix(stored, "$2") {
		return bcrypt.CompareHashAndPassword([]byte(stored), []byte(password)) == nil, false
	}
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:]) == stored, true
}

// upgradePasswordHash 惰性升级：存量 SHA256 账号登录成功后回写 bcrypt（明文此刻仅在
// 内存中，校验通过即换）。回写失败不影响本次登录（保持旧哈希，下次登录再升）。
// 注意：WebDAV 挂载密码由 DB 密码哈希派生（webdav.go driveDavPassword），本次升级会使
// 已挂载用户的 dav 密码一次性轮换——与"改密自动轮换"同语义，设置页始终显示当前密码，用户重输即可
func upgradePasswordHash(userID uint, password string) {
	if err := store.DB.Model(&model.User{}).Where("id = ?", userID).
		Update("password", hashPassword(password)).Error; err != nil {
		logger.Warn("密码哈希惰性升级失败（uid=%d）：%v", userID, err)
	}
}

// registerGiftPoints 注册赠送积分取值归口（nil 安全：config.Load 保证非 nil，
// 测试/旁路直构造 Server{cfg:&config.Config{}} 时回退默认 100，防空指针解引用）
func (s *Server) registerGiftPoints() float64 {
	if s.cfg == nil || s.cfg.RegisterGiftPoints == nil {
		return 100
	}
	return *s.cfg.RegisterGiftPoints
}

// registerUser 注册新用户，用户名查重。
// giftPoints 注册赠送积分（config.yaml register_gift_points 归口，Load 已归一：
// 缺省该键=100、显式写 0/负数=0 不赠送），>0 时到账并写 register_grant 流水
func registerUser(username, password string, giftPoints float64) (*model.User, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil, ErrEmptyUsername
	}
	if password == "" {
		return nil, ErrEmptyPassword
	}
	// 阶段一百四十二：保留字拦截——'g'+数字 形式与群聊会话 target 编码同形，拒绝注册
	// 原实现：无保留字校验，用户可注册 g1 造成用户会话与群会话目标歧义
	if reservedUsernameRe.MatchString(username) {
		return nil, ErrReservedUsername
	}

	var count int64
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Count(&count).Error; err != nil {
		return nil, err
	}
	if count > 0 {
		return nil, ErrUserExists
	}

	if giftPoints < 0 {
		giftPoints = 0 // 负数防御归一（Load 已兜，直调场景兜底）
	}
	user := &model.User{
		Username: username,
		Password: hashPassword(password),
		Points:   giftPoints, // 新用户注册赠送积分（写 0=不赠送）
	}
	if err := store.DB.Create(user).Error; err != nil {
		return nil, err
	}
	if giftPoints == 0 {
		// GORM default:100 零值陷阱（实测踩坑）：Points=0 会被列默认值标签跳过插成 100，
		// "写 0 就是不送"必须显式归零落库
		if err := store.DB.Model(&model.User{}).Where("id = ?", user.ID).Update("points", 0).Error; err != nil {
			return nil, err
		}
		user.Points = 0
	} else {
		// 注册赠送流水审计（系统行为，操作人 system）；0 赠送不写流水（无资金变动）
		recordPointsLog(username, giftPoints, giftPoints, "register_grant", "system", fmt.Sprintf("新用户注册赠送 %v 积分", giftPoints))
	}
	return user, nil
}

// verifyUser 校验用户名密码
func verifyUser(username, password string) (*model.User, error) {
	var user model.User
	if err := store.DB.Where("username = ?", username).First(&user).Error; err != nil {
		// 登录失败提示修复：原实现用户不存在与密码错误共用 ErrInvalidLogin，
		// 导致密码错误也会被 handleLogin 当作"用户不存在"去尝试注册，最终提示误导性的"用户名已存在"
		// 现改为用户不存在返回 ErrUserNotFound，由调用方决定是否自动注册
		return nil, ErrUserNotFound
	}
	ok, needUpgrade := verifyPassword(user.Password, password)
	if !ok {
		return nil, ErrInvalidLogin
	}
	if needUpgrade {
		// 存量 SHA256 账号登录成功：惰性升级回写 bcrypt（IM 登录与后台登录共用本函数，双通道收口）
		upgradePasswordHash(user.ID, password)
	}
	return &user, nil
}

// ===== 阶段二百九十八：注册防刷 IP 限流 =====

// 注册防刷 Redis key 前缀
const (
	regKeyReq   = "im:register:req:"   // 请求频率计数（30s 窗口）
	regKeySucc  = "im:register:succ:"  // 注册成功计数（24h 窗口）
	regKeyFail  = "im:register:fail:"  // 连续失败计数（锁定窗口）
)

// checkRegisterRateLimit 阶段二百九十八：注册前检查三层 IP 限流
// 返回 nil 放行，返回业务错误则立即拒绝（由调用方下发客户端）
// Redis 不可用时安全降级——仅记 warn 跳过限流，不阻塞注册
func checkRegisterRateLimit(ip string, cfg *config.RegisterRateLimitConfig) error {
	if cfg == nil || !cfg.Enabled {
		return nil // 防刷关闭，放行
	}
	if ip == "" {
		return nil // IP 为空（理论上不会），放行
	}
	// Redis 不可用直接降级放行（惰性探测：正常态仅一次 atomic.LoadInt32）
	if !store.RedisAvailable() {
		logger.Warn("注册防刷跳过：Redis 不可用（降级放行） ip=%s", ip)
		return nil
	}
	ctx := context.Background()

	// ③ 先查锁定状态（最高优先级）——已锁定直接拒绝
	if cfg.FailLock > 0 {
		if count, err := store.RDB.Get(ctx, regKeyFail+ip).Int(); err == nil && count >= cfg.FailLock {
			return ErrRegisterFailLocked
		}
	}

	// ① 请求频率检查：30s 窗口内 INCR + EXPIRE
	if cfg.MaxPer30s > 0 {
		cnt, err := store.RDB.Incr(ctx, regKeyReq+ip).Result()
		if err != nil {
			logger.Warn("注册防刷请求频率 INCR 降级（Redis 异常）：ip=%s err=%v", ip, err)
		} else {
			if cnt == 1 {
				store.RDB.Expire(ctx, regKeyReq+ip, 30*time.Second) // 首次写入窗口
			}
			if cnt > int64(cfg.MaxPer30s) {
				return ErrRegisterRateLimited
			}
		}
	}

	// ② 成功数检查：24h 窗口内已注册账号数
	if cfg.MaxPerDay > 0 {
		if count, err := store.RDB.Get(ctx, regKeySucc+ip).Int(); err == nil && count >= cfg.MaxPerDay {
			return ErrRegisterIPExceeded
		}
	}

	return nil
}

// markRegisterSuccess 阶段二百九十八：注册成功后调用
// 清失败计数 + 成功数累加（24h 窗口）
func markRegisterSuccess(ip string) {
	if ip == "" || !store.RedisAvailable() {
		return
	}
	ctx := context.Background()
	// 清失败计数（成功即重置）
	store.RDB.Del(ctx, regKeyFail+ip)
	// 成功数累加（24h 窗口）
	cnt, err := store.RDB.Incr(ctx, regKeySucc+ip).Result()
	if err != nil {
		logger.Warn("注册防刷成功数 INCR 降级（Redis 异常）：ip=%s err=%v", ip, err)
		return
	}
	if cnt == 1 {
		store.RDB.Expire(ctx, regKeySucc+ip, 24*time.Hour)
	}
}

// markRegisterFail 阶段二百九十八：注册失败后调用
// 累加失败计数（锁定窗口内），达阈值后下次 checkRegisterRateLimit 会直接返回锁定错误
func markRegisterFail(ip string, cfg *config.RegisterRateLimitConfig) {
	if ip == "" || cfg == nil || !cfg.Enabled || cfg.FailLock <= 0 || !store.RedisAvailable() {
		return
	}
	ctx := context.Background()
	cnt, err := store.RDB.Incr(ctx, regKeyFail+ip).Result()
	if err != nil {
		logger.Warn("注册防刷失败计数 INCR 降级（Redis 异常）：ip=%s err=%v", ip, err)
		return
	}
	if cnt == 1 {
		store.RDB.Expire(ctx, regKeyFail+ip, time.Duration(cfg.FailLockMins)*time.Minute)
	}
}

// ===== 阶段二百九十八：前端行为检测（蜜罐 + 停留时间） =====

// registerEnvelope 前端注册信令可选 JSON 信封（content 字段既可能是纯密码字符串，也可能是此 JSON 信封）
// 前端新格式：content={"p":"密码","hp":"","ts":页面打开毫秒时间戳}
// 老客户端零回归：content=纯密码字符串（无 { 前缀时跳过行为检测）
type registerEnvelope struct {
	P  string `json:"p"`  // 密码
	HP string `json:"hp"` // 蜜罐字段（机器人自动填所有 input，人不会填 display:none 的）
	TS int64  `json:"ts"` // 页面打开毫秒时间戳（now-ts < 2000ms 视为脚本秒提交）
}

// parseRegisterContent 阶段二百九十八：解析注册信令 content 字段
// 返回 (password, envelope存在)；envelope 不存在时 envelopeFields 返回零值（hp="" ts=0）
func parseRegisterContent(content string) (password string, hp string, pageOpenMs int64) {
	content = strings.TrimSpace(content)
	if content == "" {
		return "", "", 0
	}
	if strings.HasPrefix(content, "{") {
		var env registerEnvelope
		if err := json.Unmarshal([]byte(content), &env); err == nil {
			return env.P, env.HP, env.TS
		}
	}
	// 老客户端零回归：非 JSON 或解析失败 → 直接当纯密码
	return content, "", 0
}

// checkRegisterBotSignals 阶段二百九十八：前端行为检测（蜜罐 + 停留时间）
// 返回 nil 放行；返回 ErrRegisterBot 命中可疑信号
// 只有 envelope 格式（新前端）才做检测；老客户端无这两个字段时自动跳过（零回归）
func checkRegisterBotSignals(ip, hp string, pageOpenMs int64) error {
	if hp == "" && pageOpenMs == 0 {
		return nil // 老客户端（无信封字段）自动放行，零回归
	}
	// ① 蜜罐检测：人类不会填 display:none 的 input，机器人自动填充所有字段 → 非空即可疑
	if hp != "" {
		logger.Warn("注册蜜罐命中：ip=%s hp_len=%d", ip, len(hp))
		return ErrRegisterBot
	}
	// ② 停留时间检测：now - pageOpenMs < 2000ms → 脚本秒级提交（人类不可能）
	if pageOpenMs > 0 && time.Now().UnixMilli()-pageOpenMs < 2000 {
		logger.Warn("注册停留时间过短：ip=%s spend_ms=%d", ip, time.Now().UnixMilli()-pageOpenMs)
		return ErrRegisterBot
	}
	return nil
}
