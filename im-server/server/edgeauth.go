package server

// ===== DCDN 远程鉴权端点（阶段一百九十七） =====
// 阿里云 DCDN 远程鉴权归口：minio 外网域名（public_endpoint）接入 DCDN 且开启远程鉴权后，
// 边缘节点对每个文件请求转发 GET {鉴权地址}+原始 query（官方转发格式不含原路径）到本端点，
// 200 放行回源 / 403 拒绝。校验逻辑：Presign 签发的 auth_ticket 票据有效（存在+未过期，
// 滑动续期）即放行——票据 128bit 随机不可伪造、短 TTL 限重放、分享取消即时吊销；
// MinIO 签名层独立挡 URL 参数篡改，双层防线。
//
// 部署顺序：先部署本服务（签发票据+/auth 在线），再在 DCDN 控制台开启远程鉴权——开关打开前
// 直连照旧（无鉴权层），打开后无缝切换，无断层窗口。
//
// 安全建议（DCDN 控制台）：「其他状态码是否放行」建议选否（仅 200 放行，服务异常不放行）；
// 「鉴权超时动作」按可用性权衡（放行=本服务故障时文件仍可下载，拒绝=更严格但全断）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== 后台热更设置归口（阶段一百九十七扩展） =====
// enabled/ticket_ttl/rate_limit 三项支持管理后台热更新（保存即生效 + DB 落库重启不丢），
// config.yaml drive.edge_auth 仅作首次启动初始默认（与黑名单/下载缓存同策略，DB 值优先）。
// DB 归口：AgentWhitelist 全局 kv 行（kind=drive_edge_auth，value=JSON），与 drive_cache 同款

const edgeAuthKind = "drive_edge_auth"

var (
	edgeSetMu       sync.Mutex
	edgeSetEnabled  bool // /auth 端点与票据签发总开关（热更；关闭时票据全清 + handler 返回 404）
	edgeSetTTL      int  // 票据滑动有效期秒（0=1800 缺省）
	edgeSetRate     int  // /auth 全局限流 QPS（0=500 缺省）
	edgeSetInitDone bool
)

// edgeAuthSettingsInit 设置初始化（持锁调用；RegisterEdgeAuthRoutes 启动归口调用一次）：
// yaml drive.edge_auth 打底 → DB 后台覆盖值优先（懒加载一次）
func edgeAuthSettingsInit(cfg *config.Config) {
	if edgeSetInitDone {
		return
	}
	edgeSetInitDone = true
	edgeSetEnabled = cfg.Drive.EdgeAuth.Enabled
	edgeSetTTL = cfg.Drive.EdgeAuth.TicketTTL
	edgeSetRate = cfg.Drive.EdgeAuth.RateLimit
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", edgeAuthKind, "").First(&row).Error; err == nil {
		var ov struct {
			Enabled   bool `json:"enabled"`
			TicketTTL int  `json:"ticket_ttl"`
			RateLimit int  `json:"rate_limit"`
		}
		if json.Unmarshal([]byte(row.Value), &ov) == nil {
			edgeSetEnabled = ov.Enabled
			edgeSetTTL = ov.TicketTTL
			edgeSetRate = ov.RateLimit
		}
	}
}

// RegisterEdgeAuthRoutes 注册 DCDN 远程鉴权路由（main.go 调用归口）。
// 路由始终注册（Go mux 无法注销路由——热关由 handler 内开关判断返回 404，对外语义与未注册一致）；
// 设置来源：yaml 初始默认 → DB 后台覆盖值优先（后台热更保存即生效）。
// 启用后票据签发（Presign 附 auth_ticket）与校验链同步生效；未启用时 Presign 不附票，行为与历史一致
func RegisterEdgeAuthRoutes(cfg *config.Config) {
	edgeSetMu.Lock()
	edgeAuthSettingsInit(cfg)
	enabled, ttl, rate := edgeSetEnabled, edgeSetTTL, edgeSetRate
	edgeSetMu.Unlock()
	store.DriveTicketInit(enabled, ttl)
	edgeAuthRateInit(rate)
	http.HandleFunc("GET /auth", handleEdgeAuth)
	if enabled {
		logger.Info("DCDN 远程鉴权已启用: GET /auth 端点在线（票据 TTL %s，全局限流 %d QPS，后台可热更）",
			store.DriveTicketTTL(), rate)
	} else {
		logger.Info("DCDN 远程鉴权未启用: GET /auth 返回 404（后台可随时开启热生效）")
	}
}

// ===== 限流（自写轻量实现，避免引入新依赖） =====
// 请求源是 DCDN 边缘节点（按 IP 限流会误伤共享节点），归口两层：
// 全局令牌桶（容量=2 倍速率，吸收短突发）+ 单票据滑窗计数（防单 URL 重放打满全局额度）

var (
	edgeRateMu     sync.Mutex
	edgeRateTokens float64   // 当前令牌数
	edgeRateLast   time.Time // 上次补充时刻
	edgeRateQPS    float64   // 每秒补充速率
	edgeTicketSeen sync.Map  // ticket -> *edgeTicketWindow（单票据滑窗）
	edgeWinSweep   sync.Once // 闲置窗口清扫协程启动归口（进程级一次，幂等）
)

type edgeTicketWindow struct {
	mu    sync.Mutex
	count int
	start time.Time
}

func edgeAuthRateInit(qps int) {
	if qps <= 0 {
		qps = 500 // config 缺省归口（EdgeAuthConfig.RateLimit 注释同口径）
	}
	edgeRateMu.Lock()
	edgeRateQPS = float64(qps)
	edgeRateTokens = float64(qps) * 2
	edgeRateLast = time.Now()
	edgeRateMu.Unlock()
	edgeWinSweep.Do(func() { // 热更改 QPS 重建令牌桶时重复调用幂等；顺带确保清扫协程在跑
		go func() {
			for range time.Tick(time.Minute) {
				edgeTicketWindowSweep()
			}
		}()
	})
}

// edgeTicketWindowSweep 清理闲置的单票据限流窗口（防 edgeTicketSeen 无限膨胀）：
// 票据过期/吊销后其窗口无存活意义；窗口 start 每 10 秒滚动，闲置超 1 分钟必为死票据。
// 误删仍在期但闲置的票据窗口无安全影响——下次请求重建窗口按新 10 秒窗计数
func edgeTicketWindowSweep() {
	deadline := time.Now().Add(-time.Minute)
	edgeTicketSeen.Range(func(k, v any) bool {
		w := v.(*edgeTicketWindow)
		w.mu.Lock()
		idle := w.start.Before(deadline)
		w.mu.Unlock()
		if idle {
			edgeTicketSeen.Delete(k)
		}
		return true
	})
}

// edgeRateAllow 全局令牌桶放行判断（true=放行）
func edgeRateAllow() bool {
	edgeRateMu.Lock()
	defer edgeRateMu.Unlock()
	now := time.Now()
	edgeRateTokens += now.Sub(edgeRateLast).Seconds() * edgeRateQPS
	if max := edgeRateQPS * 2; edgeRateTokens > max {
		edgeRateTokens = max
	}
	edgeRateLast = now
	if edgeRateTokens < 1 {
		return false
	}
	edgeRateTokens--
	return true
}

// edgeTicketAllow 单票据滑窗限流（每票据每 10 秒最多 60 次——视频在线预览的密集 Range 分段也足够）
func edgeTicketAllow(ticket string) bool {
	v, ok := edgeTicketSeen.LoadOrStore(ticket, &edgeTicketWindow{count: 1, start: time.Now()})
	if !ok {
		return true // 新票据首访
	}
	w := v.(*edgeTicketWindow)
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	if now.Sub(w.start) >= 10*time.Second {
		w.start, w.count = now, 1
		return true
	}
	if w.count >= 60 {
		return false
	}
	w.count++
	return true
}

// handleEdgeAuth DCDN 边缘节点鉴权归口（公开端点，无登录态——节点无凭证；
// 响应仅状态码：200 放行 / 403 拒绝 / 429 限流（DCDN「其他状态码放行=否」时 429 同样被拒））。
// 后台热关：开关关闭时返回 404（与未注册语义一致——边缘按「其他状态码放行=否」拒绝全部下载）
func handleEdgeAuth(w http.ResponseWriter, r *http.Request) {
	edgeSetMu.Lock()
	on := edgeSetEnabled
	edgeSetMu.Unlock()
	if !on {
		http.NotFound(w, r)
		return
	}
	if !edgeRateAllow() {
		logger.Warn("DCDN 鉴权限流触发（全局）: ip=%s", r.RemoteAddr)
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	ticket := r.URL.Query().Get(store.DriveTicketParam)
	if !store.DriveTicketVerify(ticket) {
		// 无效票据（伪造/过期/吊销）——403 拒绝并记录（扫描与盗链可见）；200 放行不记日志（量大）
		// 诊断增强：随日志打印转发原始 query（截断 200 字符）——区分转发来源域名：
		// 带 code=/t= 等分享 API 参数 = im 域名 DCDN 误开鉴权转发；带 X-Amz-* = minio 域名的无票预签名 URL
		q := r.URL.RawQuery
		if len(q) > 200 {
			q = q[:200] + "…"
		}
		logger.Info("DCDN 鉴权拒绝: ip=%s ticket=%s q=%s", r.RemoteAddr, ticketPrefix(ticket), q)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !edgeTicketAllow(ticket) {
		logger.Warn("DCDN 鉴权限流触发（单票据）: ticket=%s", ticketPrefix(ticket))
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// ticketPrefix 日志用票据前缀（防全量票据入日志）
func ticketPrefix(t string) string {
	if len(t) > 8 {
		return t[:8] + "…"
	}
	return t
}

// ===== 管理后台：DCDN 远程鉴权热更设置（GET/PUT /admin/api/drive/edgeauth） =====

// handleAdminEdgeAuthGet GET：当前生效设置（内存归口值）+ 来源标注
func (s *Server) handleAdminEdgeAuthGet(w http.ResponseWriter, r *http.Request) {
	edgeSetMu.Lock()
	edgeAuthSettingsInit(s.cfg)
	enabled, ttl, rate := edgeSetEnabled, edgeSetTTL, edgeSetRate
	edgeSetMu.Unlock()
	source := "config"
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", edgeAuthKind, "").First(&row).Error; err == nil {
		source = "override" // 后台设置（DB 真源）；config=config.yaml 初始默认
	}
	adminJSON(w, map[string]interface{}{
		"enabled":    enabled,
		"ticket_ttl": ttl,
		"rate_limit": rate,
		"source":     source,
	})
}

// handleAdminEdgeAuthSave PUT：保存设置（nil=不修改，部分更新语义）
// 请求体 {"enabled": true, "ticket_ttl": 1800, "rate_limit": 500}（0 值=恢复对应默认：TTL 1800 / QPS 500）
// 保存即热生效：enabled 联动票据开关（关闭时清空全部在期票据——已签发 URL 鉴权层立即失效）；
// ticket_ttl 联动滑动续期口径（在期票据下次校验按新 TTL 延展，自然收敛）；
// rate_limit 联动全局限流令牌桶重建。落库 JSON 整行（重启不丢，DB 值优先于 yaml）。
// ⚠️ 与 DCDN 控制台联动：关闭本开关前须先在 DCDN 控制台关闭远程鉴权，
// 否则边缘会把 minio 域名请求转发到已关闭的 /auth（404）→ 全部下载被拒
func (s *Server) handleAdminEdgeAuthSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled   *bool `json:"enabled"`
		TicketTTL *int  `json:"ticket_ttl"`
		RateLimit *int  `json:"rate_limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	edgeSetMu.Lock()
	edgeAuthSettingsInit(s.cfg)
	if req.TicketTTL != nil {
		if *req.TicketTTL != 0 && (*req.TicketTTL < 60 || *req.TicketTTL > 86400) {
			edgeSetMu.Unlock()
			adminFail(w, http.StatusBadRequest, "票据有效期须在 60~86400 秒（0=恢复默认 1800）")
			return
		}
		edgeSetTTL = *req.TicketTTL
	}
	if req.RateLimit != nil {
		if *req.RateLimit != 0 && (*req.RateLimit < 1 || *req.RateLimit > 100000) {
			edgeSetMu.Unlock()
			adminFail(w, http.StatusBadRequest, "限流 QPS 须在 1~100000（0=恢复默认 500）")
			return
		}
		edgeSetRate = *req.RateLimit
	}
	if req.Enabled != nil {
		edgeSetEnabled = *req.Enabled
	}
	enabled, ttl, rate := edgeSetEnabled, edgeSetTTL, edgeSetRate
	edgeSetMu.Unlock()
	val, _ := json.Marshal(map[string]interface{}{"enabled": enabled, "ticket_ttl": ttl, "rate_limit": rate})
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", edgeAuthKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", string(val)).Error; err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
			return
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: edgeAuthKind, Value: string(val)}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
		return
	}
	cleared := store.DriveTicketSetEnabled(enabled)
	store.DriveTicketSetTTL(ttl)
	edgeAuthRateInit(rate)
	state := "已启用"
	if !enabled {
		state = fmt.Sprintf("已关闭（清空在期票据 %d 条）", cleared)
	}
	logger.Info("后台管理：管理员 %s 修改 DCDN 远程鉴权（%s，票据 TTL %s，限流 %d QPS）", adminUserFromCtx(r), state, store.DriveTicketTTL(), rate)
	adminJSON(w, map[string]interface{}{"ok": true, "enabled": enabled, "ticket_ttl": ttl, "rate_limit": rate})
}
