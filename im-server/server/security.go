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

// staticInlineExts 静态托管 /static/upload/** 内联白名单扩展名（业务必须内联、浏览器可安全
// 渲染的媒体类型）：图片（聊天气泡 <img>/商店封面/截图/公告图/admin 预览）+ 视频（商店详情页
// <video> 宣传片）+ 音频（语音条/音频文件播放）。白名单之外（pdf/docx/zip/html/svg……）
// 由 main.go 静态托管入口下发 Content-Disposition: attachment——浏览器直链打开即触发下载
// 而非渲染执行，杜绝 .html/.svg 等可渲染文件绕过 isDangerousFile 黑名单的存储型 XSS 面
var staticInlineExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true,
	".mp4": true, ".webm": true, ".mkv": true,
	".mp3": true, ".wav": true, ".amr": true, ".aac": true, ".ogg": true, ".m4a": true,
}

// IsStaticInlineFile 判断扩展名（含点，大小写不敏感）是否允许浏览器内联渲染（main.go 归口调用）
func IsStaticInlineFile(ext string) bool {
	return staticInlineExts[strings.ToLower(ext)]
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
