package server

// ===== 网盘 API 鉴权 token（阶段一百九十八） =====
// 背景：网盘 HTTP API 族（guardDrive）历史为"自报身份"模型（query username + 目标在线校验），
// 请求者与 username 无绑定——分享提取码明文回传后泄露面升级，故引入会话级 token 根治：
//   登录成功签发（Redis 会话 7 天滑动续期）→ 登录回执下发 → 网盘请求头 X-Drive-Token 携带
//   → guardDrive 强校验（自报 username 必须与 token 归属一致）→ 连接断开即吊销（下线即失效）。
// 兼容：旧客户端（老 APK 内嵌 web）不带 token 走历史路径，基础功能零影响；
// 敏感字段（分享提取码）仅 token 校验通过后回传——越权面不扩大，新客户端完成收口。
// 多端并存：每连接独立 token，同端替换/其他端下线互不影响（按 token 吊销非按用户）。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"im-server/store"
)

// driveTokenTTL token 有效期（滑动续期：活跃请求顺路续期；连接断开立即吊销）
const driveTokenTTL = 7 * 24 * time.Hour

// DriveTokenIssue 登录成功签发（128bit 随机 hex，Redis 会话 im:drivetoken:<token> → username）
func DriveTokenIssue(username string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "" // 签发失败回空串：登录回执不带 token，前端走兼容路径（降级可用不阻断登录）
	}
	token := hex.EncodeToString(b)
	store.RDB.Set(context.Background(), store.KeyDriveToken+token, username, driveTokenTTL)
	return token
}

// DriveTokenVerify 校验并滑动续期（返回 token 归属用户名）
func DriveTokenVerify(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	ctx := context.Background()
	v, err := store.RDB.Get(ctx, store.KeyDriveToken+token).Result()
	if err != nil || v == "" {
		return "", false
	}
	store.RDB.Expire(ctx, store.KeyDriveToken+token, driveTokenTTL)
	return v, true
}

// DriveTokenRevoke 吊销（连接断开归口调用；空串安全）
func DriveTokenRevoke(token string) {
	if token != "" {
		store.RDB.Del(context.Background(), store.KeyDriveToken+token)
	}
}
