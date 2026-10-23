// Package gwproto 端口透传·网关拉取协议归口（网关开发文档 §3.1）：im-server 内部拉取接口与
// im-gateway 拉取器共用同一实现——X-GW-Auth HMAC 请求签名（body 纳入签名，防中间人篡改 ack）
// 与 X-GW-Enc AES-256-GCM 响应体加密（明文 HTTP 链路防窃听）。单一实现零漂移，两侧各自单测。
//
// 签名格式：X-GW-Auth: {ts}.{hex(HMAC-SHA256(secret, ts+method+uri+"."+hex(SHA256(body))))}
//   - uri 为含 query 的 RequestURI（gw 自报参数纳入签名防换参重放）；GET 空 body 用空串哈希；
//   - ts ±300s 防重放；密钥本体不上线（2087 可能明文 HTTP）。
//
// 响应加密格式：X-GW-Enc: v1，body = base64(12B随机nonce ‖ AES-256-GCM密文‖16Btag)，
// 密钥 = SHA256(secret + "|dbwrite-resp")（与验签密钥域分离，防跨用途密钥重用）。
package gwproto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 请求签名头 / 响应加密头 / 加密版本标记（两侧协议常量唯一来源）
const (
	AuthHeader    = "X-GW-Auth"
	RespEncHeader = "X-GW-Enc"
	RespEncVer    = "v1"
)

// authWindow 拉取请求签名时间窗（±300s 防重放；网关与 im-server 时钟漂移容忍）
const authWindow = 300 * time.Second

// respKey 响应加密密钥派生：与 token 验签密钥域分离（"|dbwrite-resp" 域分隔），防跨用途重用
func respKey(secret string) []byte {
	sum := sha256.Sum256([]byte(secret + "|dbwrite-resp"))
	return sum[:]
}

// SignAuth 构造请求签名头（网关拉取/回执侧归口；GET 传 body=nil）
func SignAuth(secret string, now time.Time, method, uri string, body []byte) string {
	if body == nil {
		body = []byte{}
	}
	ts := now.Unix()
	bh := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d%s%s.%s", ts, method, uri, hex.EncodeToString(bh[:]))
	return strconv.FormatInt(ts, 10) + "." + hex.EncodeToString(mac.Sum(nil))
}

// VerifyAuth 校验请求签名头（im-server 内部接口侧归口）：
// 时间窗 ±authWindow + 常量时间比较防时序侧信道；不匹配返回错误（含原因，日志归口脱敏使用）
func VerifyAuth(secret, auth, method, uri string, body []byte, now time.Time) error {
	parts := strings.SplitN(auth, ".", 2)
	if len(parts) != 2 {
		return errors.New("签名头格式非法")
	}
	ts, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return errors.New("时间戳非法")
	}
	if d := now.Unix() - ts; d < -int64(authWindow/time.Second) || d > int64(authWindow/time.Second) {
		return errors.New("签名已过期（防重放）")
	}
	if body == nil {
		body = []byte{}
	}
	bh := sha256.Sum256(body)
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d%s%s.%s", ts, method, uri, hex.EncodeToString(bh[:]))
	got, err := hex.DecodeString(parts[1])
	if err != nil || len(got) != sha256.Size {
		return errors.New("签名值非法")
	}
	if !hmac.Equal(got, mac.Sum(nil)) {
		return errors.New("签名校验失败")
	}
	return nil
}

// SealResp 加密响应体（im-server 归口）：随机 12B nonce 前置，GCM 密文+tag 后接，base64 承载
func SealResp(secret string, plain []byte) (string, error) {
	block, err := aes.NewCipher(respKey(secret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(append(nonce, gcm.Seal(nil, nonce, plain, nil)...)), nil
}

// OpenResp 解密响应体（网关归口）：无头/版本不符/解密失败一律拒收（防降级为明文窃听）
func OpenResp(secret, enc, ver string) ([]byte, error) {
	if ver != RespEncVer {
		return nil, fmt.Errorf("响应加密版本不符: %q", ver)
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return nil, errors.New("响应体 base64 解码失败")
	}
	block, err := aes.NewCipher(respKey(secret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(raw) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("响应体过短")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return nil, errors.New("响应体解密失败（密钥不一致或遭篡改）")
	}
	return plain, nil
}
