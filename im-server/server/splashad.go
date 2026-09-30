package server

import (
	"net/http"
)

// 阶段二百四十一：APP 启动广告图接口（微信启动页同款思路的服务端侧：
// APP 冷启动原生层拉取本接口决定显示缓存广告图/预下载新图；无状态纯配置下发，
// 不鉴权（广告配置非敏感数据，且调用发生在登录前））

// HandleSplashAdGet 返回启动广告图配置
// GET /api/splash/ads → {"enabled":true,"image_url":"https://.../ad.jpg","duration":3}
// enabled=false 时 APP 端不显示任何广告图直接进入主界面并清空旧缓存
func (s *Server) HandleSplashAdGet(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg.SplashAd
	qrWriteJSON(w, map[string]interface{}{
		"enabled":   cfg.Enabled,
		"image_url": cfg.ImageURL,
		"duration":  cfg.Duration,
	})
}
