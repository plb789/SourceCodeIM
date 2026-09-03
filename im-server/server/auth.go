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

// hashPassword 密码加密（SHA256）
func hashPassword(password string) string {
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:])
}

// registerUser 注册新用户，用户名查重
func registerUser(username, password string) (*model.User, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil, errors.New("用户名不能为空")
	}
	if password == "" {
		return nil, errors.New("密码不能为空")
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
		return nil, ErrInvalidLogin
	}
	if user.Password != hashPassword(password) {
		return nil, ErrInvalidLogin
	}
	return &user, nil
}
