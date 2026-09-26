package server

import (
	"context"
	"strings"
	"time"

	"im-server/logger"
	"im-server/store"
)

// 敏感词库（示例，可扩展）
var sensitiveWords = []string{
	"赌博", "博彩", "色情", "毒品", "枪支", "诈骗",
}

// containsSensitive 检测内容是否包含敏感词
func containsSensitive(content string) (string, bool) {
	for _, word := range sensitiveWords {
		if strings.Contains(content, word) {
			return word, true
		}
	}
	return "", false
}

// 危险文件扩展名（可执行文件、脚本等）
var dangerousExts = []string{
	".exe", ".bat", ".cmd", ".sh", ".msi", ".com", ".scr",
	".js", ".vbs", ".ps1", ".jar",
}

// isDangerousFile 判断文件是否为危险/可执行文件
func isDangerousFile(filename string) bool {
	lower := strings.ToLower(filename)
	for _, ext := range dangerousExts {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// ipLimitKey 单 IP 连接频率计数键
const ipLimitKey = "im:ip:conn:"

// checkIPLimit 异常连接防护：单 IP 高频连接限制
// 并发改造 B3：阈值与窗口由 config.yaml 下发（ip_conn_limit / ip_conn_window，缺省 20 次/10 秒
// 与原硬编码一致）；NAT 办公网共用出口 IP 场景可调大防误伤
func (s *Server) checkIPLimit(ip string) bool {
	ctx := context.Background()
	key := ipLimitKey + ip

	count, err := store.RDB.Incr(ctx, key).Result()
	if err != nil {
		return true // Redis 异常时放行，避免误伤
	}
	if count == 1 {
		store.RDB.Expire(ctx, key, time.Duration(s.cfg.IPConnWindow)*time.Second)
	}

	if count > int64(s.cfg.IPConnLimit) {
		logger.Warn("异常连接防护：IP %s 连接过于频繁", ip)
		return false
	}
	return true
}
