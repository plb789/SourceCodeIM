package gwproto

// 网关拉取协议单测：签名/验签/加解密 round-trip + 攻击面（篡改/过期/换参/降级）拒绝矩阵

import (
	"strings"
	"testing"
	"time"
)

const testSecret = "unit-test-secret"

func TestSignVerifyRoundTrip(t *testing.T) {
	now := time.Now()
	// GET（nil body）
	auth := SignAuth(testSecret, now, "GET", "/internal/gateway/dbwrite?gw=gw-x", nil)
	if err := VerifyAuth(testSecret, auth, "GET", "/internal/gateway/dbwrite?gw=gw-x", nil, now); err != nil {
		t.Fatalf("GET 签名验签应通过：%v", err)
	}
	// POST（body 纳签）
	body := []byte(`{"gw":"gw-x","ids":[1,2,3]}`)
	auth = SignAuth(testSecret, now, "POST", "/internal/gateway/dbwrite/ack", body)
	if err := VerifyAuth(testSecret, auth, "POST", "/internal/gateway/dbwrite/ack", body, now); err != nil {
		t.Fatalf("POST 签名验签应通过：%v", err)
	}
}

func TestVerifyRejects(t *testing.T) {
	now := time.Now()
	body := []byte(`{"gw":"gw-x","ids":[1]}`)
	auth := SignAuth(testSecret, now, "POST", "/internal/gateway/dbwrite/ack", body)

	// body 篡改（中间人改 ids）：验签必须失败（签名含 body 哈希）
	if err := VerifyAuth(testSecret, auth, "POST", "/internal/gateway/dbwrite/ack", []byte(`{"gw":"gw-x","ids":[9]}`), now); err == nil {
		t.Fatal("篡改 body 后验签应失败")
	}
	// URI 换参（gw 替换为他人）：验签必须失败
	if err := VerifyAuth(testSecret, auth, "POST", "/internal/gateway/dbwrite/ack?x=1", body, now); err == nil {
		t.Fatal("URI 变更后验签应失败")
	}
	// 过期（±300s 之外）
	if err := VerifyAuth(testSecret, auth, "POST", "/internal/gateway/dbwrite/ack", body, now.Add(10*time.Minute)); err == nil {
		t.Fatal("过期签名应失败")
	}
	// 边界内（±300s 之内）：应通过
	if err := VerifyAuth(testSecret, auth, "POST", "/internal/gateway/dbwrite/ack", body, now.Add(4*time.Minute)); err != nil {
		t.Fatalf("4 分钟漂移应通过：%v", err)
	}
	// 密钥不符
	if err := VerifyAuth("wrong-secret", auth, "POST", "/internal/gateway/dbwrite/ack", body, now); err == nil {
		t.Fatal("密钥不符应失败")
	}
	// 格式残缺
	for _, bad := range []string{"", "abc", "123.zzzz", "no-dot"} {
		if err := VerifyAuth(testSecret, bad, "POST", "/internal/gateway/dbwrite/ack", body, now); err == nil {
			t.Fatalf("残缺签名 %q 应失败", bad)
		}
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	plain := []byte(`{"items":[{"id":1,"username":"plb789","password":"3847798341565109"}]}`)
	enc, err := SealResp(testSecret, plain)
	if err != nil {
		t.Fatalf("加密失败：%v", err)
	}
	// 密文不得含明文片段（防假加密）
	if strings.Contains(enc, "plb789") {
		t.Fatal("密文中出现明文片段")
	}
	got, err := OpenResp(testSecret, enc, RespEncVer)
	if err != nil {
		t.Fatalf("解密失败：%v", err)
	}
	if string(got) != string(plain) {
		t.Fatal("round-trip 内容不一致")
	}
}

func TestOpenRejects(t *testing.T) {
	plain := []byte("sensitive")
	enc, _ := SealResp(testSecret, plain)
	// 版本不符（防降级为明文窃听）
	if _, err := OpenResp(testSecret, enc, ""); err == nil {
		t.Fatal("无加密版本头应拒收")
	}
	if _, err := OpenResp(testSecret, enc, "v0"); err == nil {
		t.Fatal("未知加密版本应拒收")
	}
	// 密钥不符
	if _, err := OpenResp("other-key", enc, RespEncVer); err == nil {
		t.Fatal("密钥不符应解密失败")
	}
	// 明文注入（非 base64 / 过短）
	if _, err := OpenResp(testSecret, "not-base64!!", RespEncVer); err == nil {
		t.Fatal("非法 base64 应拒收")
	}
	if _, err := OpenResp(testSecret, "AAAA", RespEncVer); err == nil {
		t.Fatal("过短密文应拒收")
	}
}
