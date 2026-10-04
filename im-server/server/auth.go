package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

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

// reservedUsernameRe 保留字用户名规则：g 开头跟纯数字（如 g1、g123），与群会话 target 编码 'g'+群ID 同形
var reservedUsernameRe = regexp.MustCompile(`^g[0-9]+$`)

// isAuthBusinessError 判定登录/注册链路的业务校验错误（可直接下发客户端展示）：
// 底层依赖错误（MySQL/Redis 连接异常等，如 invalid connection）不属于业务错误，
// 由调用方统一下发通用中文提示，完整错误仅记日志，避免英文底层错误暴露给客户端
func isAuthBusinessError(err error) bool {
	return err == ErrUserExists || err == ErrInvalidLogin || err == ErrEmptyUsername || err == ErrEmptyPassword || err == ErrReservedUsername || err == ErrNeedRegister ||
		err == ErrQRLoginExpired || err == ErrQRLoginInvalid // 阶段二百四十：扫码登录业务错误原样下发
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

// registerUser 注册新用户，用户名查重
func registerUser(username, password string) (*model.User, error) {
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

	user := &model.User{
		Username: username,
		Password: hashPassword(password),
		Points:   100, // 阶段七十八：新用户注册赠送 100 积分（列默认值兜底，此处显式赋值防 GORM 零值插 0）
	}
	if err := store.DB.Create(user).Error; err != nil {
		return nil, err
	}
	// 阶段七十八：注册赠送流水审计（系统行为，操作人 system）
	recordPointsLog(username, 100, 100, "register_grant", "system", "新用户注册赠送 100 积分")
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
