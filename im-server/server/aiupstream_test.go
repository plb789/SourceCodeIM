package server

// aiUpstreamErrBody 上游错误体归一提取单测：OpenAI 风格 error.message / 顶层 message / 非 JSON 兜底

import (
	"strings"
	"testing"
)

func TestAIUpstreamErrBody(t *testing.T) {
	// ① OpenAI 风格嵌套 error.message（用户实测场景：one_api 令牌额度用尽）
	err := aiUpstreamErrBody(401, []byte(`{"error":{"message":"该令牌额度已用尽 (request id: 2026091019575982153148654254283)","type":"one_api_error"}}`))
	if !strings.Contains(err.Error(), "该令牌额度已用尽") || strings.Contains(err.Error(), "{") {
		t.Fatalf("嵌套 error.message 未提取：%v", err)
	}
	// ② 顶层 message 结构
	err = aiUpstreamErrBody(429, []byte(`{"message":"请求过于频繁"}`))
	if !strings.Contains(err.Error(), "请求过于频繁") || strings.Contains(err.Error(), "{") {
		t.Fatalf("顶层 message 未提取：%v", err)
	}
	// ③ 非 JSON / 截断损坏响应体：原样兜底不报错
	err = aiUpstreamErrBody(502, []byte(`Bad Gateway`))
	if !strings.Contains(err.Error(), "Bad Gateway") {
		t.Fatalf("非 JSON 未原样兜底：%v", err)
	}
	// ④ 空响应体
	err = aiUpstreamErrBody(500, nil)
	if !strings.Contains(err.Error(), "（无响应体）") {
		t.Fatalf("空响应体未兜底：%v", err)
	}
}
