package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"im-server/model"
	"im-server/store"
)

// ErrUserExists 用户名已存在
var ErrUserExists = errors.New("用户名已存在")

// ErrInvalidLogin 用户名或密码错误
var ErrInvalidLogin = errors.New("用户名或密码错误")

// ErrUserNotFound 用户名不存在（与密码错误区分：不存在时登录尝试自动注册，密码错误时直接提示）
var ErrUserNotFound = errors.New("用户名不存在")

// ErrEmptyUsername 用户名为空
var ErrEmptyUsername = errors.New("用户名不能为空")

// ErrEmptyPassword 密码为空
var ErrEmptyPassword = errors.New("密码不能为空")

// isAuthBusinessError 判定登录/注册链路的业务校验错误（可直接下发客户端展示）：
// 底层依赖错误（MySQL/Redis 连接异常等，如 invalid connection）不属于业务错误，
// 由调用方统一下发通用中文提示，完整错误仅记日志，避免英文底层错误暴露给客户端
func isAuthBusinessError(err error) bool {
	return err == ErrUserExists || err == ErrInvalidLogin || err == ErrEmptyUsername || err == ErrEmptyPassword
}

// hashPassword 密码加密（SHA256）
func hashPassword(password string) string {
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:])
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
	if user.Password != hashPassword(password) {
		return nil, ErrInvalidLogin
	}
	return &user, nil
}
