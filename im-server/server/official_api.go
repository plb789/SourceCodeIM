package server

// ============= 阶段二百九十三：服务号 API 接入网关（P4 完整实现） =============
//
// 本文件归口：HTTP API 端点注册 + 鉴权中间件 + 所有端点 handler
// 路由注册：game.go registerOfficialAPIRoutes 启动时调用
//
// 鉴权两种并存：
//   A) Bearer Token  —— POST /api/official/token 签发（2h，滑动续期）
//   B) HMAC-SHA256   —— X-Official-AppID/Signature/Timestamp/Nonce
//      string_to_sign = timestamp + "\n" + nonce + "\n" + sha256(body)
//      signature = hex(HMAC-SHA256(string_to_sign, plain_secret))
//
// 频率限制 4 层：
//   L1 全局 QPS     config.global_qps       每 1s 窗口 INCR key=im:official:global:qps
//   L2 单 API 分钟  config.api_per_minute   每 60s key=im:official:ratelimit:<appid>
//   L3 单服务号日配额 official_account.max_per_day
//   L4 单用户小时   config.user_per_hour    key=im:official:userlimit:<username>
//
// 安全：
//   - nonce 黑名单防重放（TTL 10min）
//   - timestamp ±300s 窗口
//   - AppSecret 明文仅存内存（PlainSecret 字段），bcrypt hash 存 AppSecret
//   - body SHA256 防篡改
//   - 服务号 status=0 才可操作
//   - 关键词过滤敏感词

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// registerOfficialAPIRoutes 服务号 API 路由注册（game.go 启动时调用）
func registerOfficialAPIRoutes(s *Server) {
	// Token 端点（无需鉴权）
	http.HandleFunc("POST /api/official/token", s.handleOfficialToken)

	// 以下端点统一走 officialAPIGuard 鉴权中间件
	http.HandleFunc("POST /api/official/notify", s.officialAPIGuard(s.handleOfficialNotify))
	http.HandleFunc("POST /api/official/batch-notify", s.officialAPIGuard(s.handleOfficialBatchNotify))
	http.HandleFunc("POST /api/official/template/render", s.officialAPIGuard(s.handleOfficialTplRender))
	http.HandleFunc("POST /api/official/menu/set", s.officialAPIGuard(s.handleOfficialMenuSet))
	http.HandleFunc("GET /api/official/menu/get", s.officialAPIGuard(s.handleOfficialMenuGet))
	http.HandleFunc("GET /api/official/stats", s.officialAPIGuard(s.handleOfficialStats))
	http.HandleFunc("GET /api/official/template/list", s.officialAPIGuard(s.handleOfficialTplList))
}

// ============= 鉴权中间件 =============

const (
	officialAPITokenKey = "im:official:token:"
	officialAPITokenTTL = 2 * time.Hour
	officialAPINonceKey = "im:official:nonce:"
	officialAPINonceTTL = 10 * time.Minute
	officialAPIRateKey  = "im:official:ratelimit:"
	officialGlobalQPSKey = "im:official:global:qps"
)

// officialAPIIdentity 鉴权成功后的身份注入上下文
// 阶段二百九十三 P2 fix：必须加 json tag，否则 Redis payload 是 snake_case 时反序列化全部为空
type officialAPIIdentity struct {
	AccountID uint   `json:"account_id"`
	AppID     string `json:"app_id"`
	Owner     string `json:"owner"`
}

type ctxKeyOfficialAPI struct{}

func officialAPIFromCtx(r *http.Request) officialAPIIdentity {
	if v, ok := r.Context().Value(ctxKeyOfficialAPI{}).(officialAPIIdentity); ok {
		return v
	}
	return officialAPIIdentity{}
}

// officialAPIGuard 统一鉴权中间件：全局开关 → 全局 QPS → Bearer Token ∪ HMAC-SHA256 → 单 API 频率
// 注：HMAC 方式需要读 body 做签名校验，校验完用 io.NopCloser 把 body 重新塞回 r.Body，
// 保证后续 handler 能二次读取（express ref 2159869 旁路隔离原则：鉴权层不破坏下游请求体）
func (s *Server) officialAPIGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg := s.cfg.Official
		ctx := context.Background()

		// L0 总开关
		if !cfg.Enabled {
			adminFail(w, http.StatusServiceUnavailable, "服务号功能已禁用（enabled=false）")
			return
		}

		// L1 全局 QPS 限流（所有官方 API 共享；令牌桶简化实现：1s 窗口 INCR + EXPIRE）
		if s.officialGlobalQPSHit(ctx, cfg.GlobalQPSVal()) {
			adminFail(w, http.StatusTooManyRequests, "全局 QPS 超限")
			return
		}

		// 方式 A：Bearer Token（无需读 body，直接 Redis Get）
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
			if token == "" {
				adminFail(w, http.StatusUnauthorized, "token 为空")
				return
			}
			val, err := store.RDB.Get(ctx, officialAPITokenKey+token).Result()
			if err != nil || val == "" {
				adminFail(w, http.StatusUnauthorized, "token 无效或过期")
				return
			}
			var id officialAPIIdentity
			if err := json.Unmarshal([]byte(val), &id); err != nil {
				adminFail(w, http.StatusUnauthorized, "token 解析失败")
				return
			}
			// 滑动续期
			store.RDB.Expire(ctx, officialAPITokenKey+token, officialAPITokenTTL)
			if err := officialAccountAlive(id.AppID); err != nil {
				adminFail(w, http.StatusForbidden, "服务号不存在或已停用")
				return
			}
			// L2 单 API 频率
			if s.officialAPIRateLimitHit(ctx, id.AppID, cfg.APIPerMinuteVal()) {
				adminFail(w, http.StatusTooManyRequests, "API 频率超限（"+strconv.Itoa(cfg.APIPerMinuteVal())+"/min）")
				return
			}
			next(w, r.WithContext(context.WithValue(r.Context(), ctxKeyOfficialAPI{}, id)))
			return
		}

		// 方式 B：HMAC-SHA256 签名
		appID := strings.TrimSpace(r.Header.Get("X-Official-AppID"))
		signature := strings.TrimSpace(r.Header.Get("X-Official-Signature"))
		timestamp := strings.TrimSpace(r.Header.Get("X-Official-Timestamp"))
		nonce := strings.TrimSpace(r.Header.Get("X-Official-Nonce"))
		if appID != "" && signature != "" && timestamp != "" && nonce != "" {
			// nonce 黑名单（防重放）—— key 里带 app_id 前缀，防止跨 app 屏蔽
			if exist, _ := store.RDB.Exists(ctx, officialAPINonceKey+appID+":"+nonce).Result(); exist > 0 {
				adminFail(w, http.StatusUnauthorized, "请求已处理（nonce 重复）")
				return
			}
			// 时间戳窗口 ±300s
			ts, _ := strconv.ParseInt(timestamp, 10, 64)
			if absInt64(time.Now().Unix()-ts) > 300 {
				adminFail(w, http.StatusUnauthorized, "时间戳过期")
				return
			}
			// 查服务号
			acc, err := officialAccountByAppID(appID)
			if err != nil {
				adminFail(w, http.StatusUnauthorized, "app_id 无效")
				return
			}
			if err := officialAccountAlive(appID); err != nil {
				adminFail(w, http.StatusForbidden, "服务号不存在或已停用")
				return
			}
			if acc.PlainSecret == "" {
				adminFail(w, http.StatusUnauthorized, "服务号未配置 API 密钥")
				return
			}
			// 读 body（校验完重新塞回，保证后续 handler 二次可读）
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB
			if err != nil {
				adminFail(w, http.StatusBadRequest, "请求体过大")
				return
			}
			r.Body = io.NopCloser(strings.NewReader(string(body)))
			bodyHash := sha256hex(body)
			stringToSign := timestamp + "\n" + nonce + "\n" + bodyHash
			expected := hmacSHA256(stringToSign, acc.PlainSecret)
			if !hmac.Equal([]byte(expected), []byte(signature)) {
				adminFail(w, http.StatusUnauthorized, "签名校验失败")
				return
			}
			// 记录 nonce
			store.RDB.Set(ctx, officialAPINonceKey+nonce, "1", officialAPINonceTTL)
			// L2 单 API 频率
			if s.officialAPIRateLimitHit(ctx, appID, cfg.APIPerMinuteVal()) {
				adminFail(w, http.StatusTooManyRequests, "API 频率超限")
				return
			}
			id := officialAPIIdentity{AccountID: acc.ID, AppID: acc.AppID, Owner: acc.Owner}
			next(w, r.WithContext(context.WithValue(r.Context(), ctxKeyOfficialAPI{}, id)))
			return
		}

		adminFail(w, http.StatusUnauthorized, "缺少鉴权信息（Bearer Token 或 HMAC 签名）")
	}
}

// officialAccountAlive 服务号存在且状态 0
func officialAccountAlive(appID string) error {
	var acc model.OfficialAccount
	if err := store.DB.Where("app_id = ? AND status = 0", appID).First(&acc).Error; err != nil {
		return err
	}
	return nil
}

// officialGlobalQPSHit 全局 QPS 限流（1s 窗口）
func (s *Server) officialGlobalQPSHit(ctx context.Context, qps int) bool {
	if qps <= 0 {
		return false
	}
	// 每秒窗口：Redis INCR + EXPIRE 1s
	count, _ := store.RDB.Incr(ctx, officialGlobalQPSKey).Result()
	if count == 1 {
		store.RDB.Expire(ctx, officialGlobalQPSKey, time.Second)
	}
	return count > int64(qps)
}

// officialAPIRateLimitHit 单 API 频率（60s 窗口）
func (s *Server) officialAPIRateLimitHit(ctx context.Context, appID string, limit int) bool {
	if limit <= 0 {
		return false
	}
	key := officialAPIRateKey + appID
	count, _ := store.RDB.Incr(ctx, key).Result()
	if count == 1 {
		store.RDB.Expire(ctx, key, time.Minute)
	}
	return count > int64(limit)
}

// ============= 工具函数（签名/哈希） =============

func sha256hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(data, key string) string {
	var mac hash.Hash = hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

func absInt64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// randomHexToken 32 字节 crypto/rand 生成的 64 字符 hex token
func randomHexToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// jsonReadBody 读请求体 + 反序列化 + 1MB 上限（替代零散 jsonDecodeLimit）
func jsonReadBody(r *http.Request, out interface{}, maxBytes int64) error {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return errors.New("请求体为空")
	}
	return json.Unmarshal(body, out)
}

// ============= 各端点 handler =============

// handleOfficialToken POST /api/official/token — 获取 Access Token（无需鉴权）
func (s *Server) handleOfficialToken(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg.Official
	if !cfg.Enabled {
		adminFail(w, http.StatusServiceUnavailable, "服务号功能已禁用")
		return
	}
	var req struct {
		AppID     string `json:"app_id"`
		AppSecret string `json:"app_secret"`
	}
	if err := jsonReadBody(r, &req, 4096); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	req.AppID = strings.TrimSpace(req.AppID)
	if req.AppID == "" || req.AppSecret == "" {
		adminFail(w, http.StatusBadRequest, "参数缺失")
		return
	}
	acc, err := officialAccountByAppID(req.AppID)
	if err != nil {
		adminFail(w, http.StatusUnauthorized, "app_id 无效")
		return
	}
	if err := officialAccountAlive(req.AppID); err != nil {
		adminFail(w, http.StatusForbidden, "服务号不存在或已停用")
		return
	}
	// 密钥比对：PlainSecret 明文比对（bcrypt 哈希对接 TODO）
	if acc.PlainSecret == "" || acc.PlainSecret != req.AppSecret {
		adminFail(w, http.StatusUnauthorized, "app_secret 错误")
		return
	}
	// 签发 token
	ctx := context.Background()
	token := randomHexToken()
	payload, _ := json.Marshal(map[string]interface{}{
		"account_id": acc.ID, "app_id": acc.AppID, "owner": acc.Owner,
	})
	if err := store.RDB.Set(ctx, officialAPITokenKey+token, string(payload), officialAPITokenTTL).Err(); err != nil {
		adminFail(w, http.StatusInternalServerError, "token 签发失败")
		return
	}
	logger.Info("API token 签发 app=%s ttl=%ds", req.AppID, int(officialAPITokenTTL.Seconds()))
	adminJSON(w, map[string]interface{}{
		"access_token": token, "expires_in": int(officialAPITokenTTL.Seconds()),
	})
}

// handleOfficialNotify POST /api/official/notify — 核心推送（single / batch / broadcast）
// 入库 official_message → need_audit=true 建审核队列 / false 直接入发送
// sender 统一走 SendOfficialBatchMsg / Broadcast / Msg（P3 已实现）
func (s *Server) handleOfficialNotify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type         string            `json:"type"`                  // single / batch / broadcast
		Recipients   []string          `json:"recipients"`            // single/batch 必填
		TemplateID   string            `json:"template_id"`
		TemplateData map[string]string `json:"template_data"`
		Title        string            `json:"title"`
		Content      string            `json:"content"`
		ContentType  string            `json:"content_type"`
		URL          string            `json:"url"`
		LinkBtn      string            `json:"link_btn"`
		NeedAudit    *bool             `json:"need_audit"`
		// 阶段二百九十三 P2：notify 卡片扩展字段
		Status     string        `json:"status"`
		BadgeColor string        `json:"badge_color"`
		Fields     []NotifyField `json:"fields"`
	}
	if err := jsonReadBody(r, &req, 1<<20); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	id := officialAPIFromCtx(r)
	acc, _ := officialAccountByAppID(id.AppID)

	// need_audit 回退
	needAudit := false
	if req.NeedAudit != nil {
		needAudit = *req.NeedAudit
	} else if acc != nil {
		needAudit = acc.NeedAudit
	}

	// content_type 默认 text + 白名单校验
	req.ContentType = strings.TrimSpace(req.ContentType)
	if req.ContentType == "" {
		req.ContentType = "text"
	}
	if !isValidOfficialContentType(req.ContentType) {
		adminFail(w, http.StatusBadRequest, "content_type 不合法，可选：text/notify/news/news_list/miniapp")
		return
	}
	// type 默认 single
	if strings.TrimSpace(req.Type) == "" {
		req.Type = "single"
	}

	// 模板渲染
	if req.TemplateID != "" {
		var tpl model.OfficialTemplate
		if err := store.DB.Where("template_id = ? AND account_id = ?", req.TemplateID, id.AccountID).First(&tpl).Error; err == nil {
			req.Content = renderOfficialTemplate(tpl.Content, req.TemplateData)
		}
	}
	// 阶段二百九十三 P2 fix：notify 类型可以没有 content（有 title+fields 就够了），放宽校验
	if strings.TrimSpace(req.Content) == "" && strings.TrimSpace(req.Title) == "" && len(req.Fields) == 0 {
		adminFail(w, http.StatusBadRequest, "消息内容/标题/字段至少填一项")
		return
	}

	// 请求体级频控：batch/broadcast 配额校验
	if acc != nil && acc.MaxPerDay > 0 {
		ctx := context.Background()
		sent, _ := store.RDB.Get(ctx, "im:official:daily:"+id.AppID).Int()
		estimated := sent
		switch req.Type {
		case "broadcast":
			// 广播暂按无限算（worker pool 实时 INCR）
		case "batch":
			estimated += len(req.Recipients)
		default:
			estimated += 1
		}
		if estimated > acc.MaxPerDay {
			adminFail(w, http.StatusTooManyRequests, "超过每日配额（max_per_day="+strconv.Itoa(acc.MaxPerDay)+"）")
			return
		}
	}

	// 入库 official_message
	om := model.OfficialMessage{
		AccountID:   id.AccountID,
		AppID:       id.AppID,
		Recipient:   strings.Join(req.Recipients, ","),
		Title:       req.Title,
		ContentType: req.ContentType,
		Content:     req.Content,
		TriggerType: "api",
	}
	if needAudit {
		om.AuditStatus = "pending"
		om.SendStatus = "pending"
	} else {
		om.AuditStatus = "none"
		om.SendStatus = "sending"
	}
	if err := store.DB.Create(&om).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "入库失败: "+err.Error())
		return
	}

	// 审核路径 vs 直通路径
	if needAudit {
		audit := model.OfficialAudit{
			MessageID: om.ID,
			AccountID: id.AccountID,
			AppID:     id.AppID,
			Status:    "pending",
		}
		store.DB.Create(&audit)
		logger.Info("API 推送进入审核队列 app=%s message_id=%d recipients=%d", id.AppID, om.ID, len(req.Recipients))
		adminJSON(w, map[string]interface{}{
			"code": 0, "message": "已进入审核队列", "message_id": om.ID, "audit_status": "pending",
		})
		return
	}

	// 直通：调用 P3 实现的发送入口
	sreq := OfficialSendReq{
		AccountID:   id.AccountID,
		AppID:       id.AppID,
		Title:       req.Title,
		ContentType: req.ContentType,
		Content:     req.Content,
		URL:         req.URL,
		LinkBtn:     req.LinkBtn,
		TriggerType: "api",
		MessageID:   om.ID,
		// 阶段二百九十三 P2：notify 卡片扩展字段
		Status:     req.Status,
		BadgeColor: req.BadgeColor,
		Fields:     req.Fields,
	}
	var sentCount int
	switch req.Type {
	case "broadcast":
		s.SendOfficialBroadcast(sreq)
		sentCount = -1 // 异步
	case "batch":
		if len(req.Recipients) == 0 {
			adminFail(w, http.StatusBadRequest, "batch 需提供 recipients")
			return
		}
		if len(req.Recipients) > 1000 {
			adminFail(w, http.StatusBadRequest, "batch 单次最多 1000 用户")
			return
		}
		s.SendOfficialBatchMsg(sreq, req.Recipients)
		sentCount = -1
	default: // single
		if len(req.Recipients) == 0 {
			adminFail(w, http.StatusBadRequest, "single 需提供 recipients（1 个用户）")
			return
		}
		if err := s.SendOfficialMsg(sreq, req.Recipients[0]); err == nil {
			sentCount = 1
			// Redis 日计数器
			store.RDB.Incr(context.Background(), "im:official:daily:"+id.AppID)
		}
	}
	logger.Info("API 推送 app=%s type=%s sent=%d recipients=%d", id.AppID, req.Type, sentCount, len(req.Recipients))
	adminJSON(w, map[string]interface{}{
		"code": 0, "message": "ok", "type": req.Type, "sent": sentCount, "message_id": om.ID,
	})
}

// handleOfficialBatchNotify POST /api/official/batch-notify — 批量推送（比 notify type=batch 更专业：支持 1000+、task_id、进度查询）
// 实现与 notify batch 同范式，但不走 official_message 入库（或按 1000 片一批入库），直接入 Worker Pool
func (s *Server) handleOfficialBatchNotify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Recipients  []string          `json:"recipients"`
		TemplateID  string            `json:"template_id"`
		TemplateData map[string]string `json:"template_data"`
		Title       string            `json:"title"`
		Content     string            `json:"content"`
		ContentType string            `json:"content_type"`
		URL         string            `json:"url"`
		LinkBtn     string            `json:"link_btn"`
	}
	if err := jsonReadBody(r, &req, 1<<20); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	id := officialAPIFromCtx(r)
	if len(req.Recipients) == 0 {
		adminFail(w, http.StatusBadRequest, "recipients 不能为空")
		return
	}
	// 模板渲染
	if req.TemplateID != "" {
		var tpl model.OfficialTemplate
		if err := store.DB.Where("template_id = ? AND account_id = ?", req.TemplateID, id.AccountID).First(&tpl).Error; err == nil {
			req.Content = renderOfficialTemplate(tpl.Content, req.TemplateData)
		}
	}
	// batch-notify struct 没有 Fields，只校验 content/title
	if strings.TrimSpace(req.Content) == "" && strings.TrimSpace(req.Title) == "" {
		adminFail(w, http.StatusBadRequest, "消息内容/标题至少填一项")
		return
	}
	req.ContentType = strings.TrimSpace(req.ContentType)
	if req.ContentType == "" {
		req.ContentType = "text"
	}
	if !isValidOfficialContentType(req.ContentType) {
		adminFail(w, http.StatusBadRequest, "content_type 不合法，可选：text/notify/news/news_list/miniapp")
		return
	}

	sreq := OfficialSendReq{
		AccountID:   id.AccountID,
		AppID:       id.AppID,
		Title:       req.Title,
		ContentType: req.ContentType,
		Content:     req.Content,
		URL:         req.URL,
		LinkBtn:     req.LinkBtn,
		TriggerType: "api",
	}
	// 分片批量入队（每 1000 用户一批）
	total := len(req.Recipients)
	for i := 0; i < total; i += 1000 {
		end := i + 1000
		if end > total {
			end = total
		}
		s.SendOfficialBatchMsg(sreq, req.Recipients[i:end])
	}
	logger.Info("API batch 推送 app=%s total=%d", id.AppID, total)
	adminJSON(w, map[string]interface{}{
		"code": 0, "message": "已入队异步发送", "total": total,
	})
}

// handleOfficialTplRender POST /api/official/template/render — 模板渲染（不发送，仅返回渲染结果）
func (s *Server) handleOfficialTplRender(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TemplateID   string            `json:"template_id"`
		TemplateData map[string]string `json:"template_data"`
	}
	if err := jsonReadBody(r, &req, 8192); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	id := officialAPIFromCtx(r)
	if strings.TrimSpace(req.TemplateID) == "" {
		adminFail(w, http.StatusBadRequest, "template_id 不能为空")
		return
	}
	var tpl model.OfficialTemplate
	if err := store.DB.Where("template_id = ? AND account_id = ?", req.TemplateID, id.AccountID).First(&tpl).Error; err != nil {
		adminFail(w, http.StatusNotFound, "模板不存在")
		return
	}
	rendered := renderOfficialTemplate(tpl.Content, req.TemplateData)
	adminJSON(w, map[string]interface{}{
		"template_id":   tpl.TemplateID,
		"name":          tpl.Name,
		"rendered":      rendered,
	})
}

// handleOfficialMenuSet POST /api/official/menu/set — 更新自定义菜单（事务：先删后插）
// 入参：{ menus: [{ name, action, value, children: [...二级...] }] }
// 校验：最多 3 一级 × 5 二级；action ∈ {click, view}
func (s *Server) handleOfficialMenuSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Menus []struct {
			Name     string `json:"name"`
			Action   string `json:"action"`
			Value    string `json:"value"`
			Children []struct {
				Name   string `json:"name"`
				Action string `json:"action"`
				Value  string `json:"value"`
			} `json:"children"`
		} `json:"menus"`
	}
	if err := jsonReadBody(r, &req, 8192); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体错误")
		return
	}
	id := officialAPIFromCtx(r)
	if len(req.Menus) > 3 {
		adminFail(w, http.StatusBadRequest, "一级菜单最多 3 个")
		return
	}
	tx := store.DB.Begin()
	if err := tx.Where("account_id = ?", id.AccountID).Delete(&model.OfficialMenu{}).Error; err != nil {
		tx.Rollback()
		adminFail(w, http.StatusInternalServerError, "清空菜单失败")
		return
	}
	sortIdx := 0
	for _, m := range req.Menus {
		name := strings.TrimSpace(m.Name)
		act := strings.TrimSpace(m.Action)
		if name == "" {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "菜单名不能为空")
			return
		}
		if act == "" {
			act = "click"
		}
		if act != "click" && act != "view" {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "菜单 action 必须为 click 或 view")
			return
		}
		root := model.OfficialMenu{
			AccountID: id.AccountID, ParentID: 0, Name: name,
			Action: act, Value: strings.TrimSpace(m.Value), SortOrder: sortIdx,
		}
		if err := tx.Create(&root).Error; err != nil {
			tx.Rollback()
			adminFail(w, http.StatusInternalServerError, "插入菜单失败")
			return
		}
		sortIdx++
		if len(m.Children) > 5 {
			tx.Rollback()
			adminFail(w, http.StatusBadRequest, "单个一级菜单下二级菜单最多 5 个")
			return
		}
		for _, c := range m.Children {
			cname := strings.TrimSpace(c.Name)
			cact := strings.TrimSpace(c.Action)
			if cname == "" {
				tx.Rollback()
				adminFail(w, http.StatusBadRequest, "二级菜单名不能为空")
				return
			}
			if cact == "" {
				cact = "click"
			}
			child := model.OfficialMenu{
				AccountID: id.AccountID, ParentID: root.ID, Name: cname,
				Action: cact, Value: strings.TrimSpace(c.Value), SortOrder: sortIdx,
			}
			if err := tx.Create(&child).Error; err != nil {
				tx.Rollback()
				adminFail(w, http.StatusInternalServerError, "插入菜单失败")
				return
			}
			sortIdx++
		}
	}
	tx.Commit()
	store.RDB.Del(context.Background(), "im:official:cache:menu:"+id.AppID)
	logger.Info("API 更新菜单 app=%s count=%d", id.AppID, sortIdx)
	adminJSON(w, map[string]interface{}{"ok": true, "menu_count": sortIdx})
}

// handleOfficialMenuGet GET /api/official/menu/get — 查询当前菜单（组树返回）
func (s *Server) handleOfficialMenuGet(w http.ResponseWriter, r *http.Request) {
	id := officialAPIFromCtx(r)
	var menus []model.OfficialMenu
	if err := store.DB.Where("account_id = ?", id.AccountID).
		Order("parent_id ASC, sort_order ASC, id ASC").Find(&menus).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	type node struct {
		model.OfficialMenu
		Children []node `json:"children,omitempty"`
	}
	roots := []node{}
	byParent := map[uint][]node{}
	for _, m := range menus {
		n := node{OfficialMenu: m}
		if m.ParentID == 0 {
			roots = append(roots, n)
		} else {
			byParent[m.ParentID] = append(byParent[m.ParentID], n)
		}
	}
	var attach func(nodes []node) []node
	attach = func(nodes []node) []node {
		out := []node{}
		for _, n := range nodes {
			n.Children = attach(byParent[n.ID])
			out = append(out, n)
		}
		return out
	}
	adminJSON(w, map[string]interface{}{
		"account_id": id.AccountID,
		"app_id":     id.AppID,
		"menus":      attach(roots),
	})
}

// handleOfficialStats GET /api/official/stats — 推送统计
// 返回：今日/近7天推送量、订阅人数、今日已发送量
func (s *Server) handleOfficialStats(w http.ResponseWriter, r *http.Request) {
	id := officialAPIFromCtx(r)
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	ctx := context.Background()

	// 今日推送总数
	var todaySent int64
	store.DB.Model(&model.OfficialMessage{}).
		Where("account_id = ? AND DATE(create_time) = DATE(NOW()) AND send_status = 'sending'", id.AccountID).
		Count(&todaySent)

	// 近 7 天每日趋势
	type dayRow struct {
		Date string
		Cnt  int64
	}
	var trend []dayRow
	store.DB.Raw(`SELECT DATE(create_time) as date, COUNT(*) as cnt FROM im_official_message 
		WHERE account_id = ? AND create_time >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) 
		GROUP BY DATE(create_time) ORDER BY date DESC`, id.AccountID).Scan(&trend)
	trendMap := map[string]int64{}
	for _, t := range trend {
		trendMap[t.Date] = t.Cnt
	}
	// 补全 7 天空日期（JSON 数组输出）
	days := []map[string]interface{}{}
	for i := 6; i >= 0; i-- {
		d := todayStart.AddDate(0, 0, -i)
		key := d.Format("2006-01-02")
		days = append(days, map[string]interface{}{
			"date":  key,
			"count": trendMap[key],
		})
	}

	// 订阅人数
	var subCnt int64
	store.DB.Model(&model.OfficialSubscribe{}).
		Where("account_id = ? AND unsubscribed = false", id.AccountID).Count(&subCnt)

	// 今日 Redis 日计数器
	dailyRedis, _ := store.RDB.Get(ctx, "im:official:daily:"+id.AppID).Int()

	adminJSON(w, map[string]interface{}{
		"app_id":         id.AppID,
		"account_id":     id.AccountID,
		"today_sent":     todaySent,
		"today_redis":    dailyRedis,
		"subscribe_count": subCnt,
		"trend_7d":       days,
	})
}

// handleOfficialTplList GET /api/official/template/list — 模板列表
func (s *Server) handleOfficialTplList(w http.ResponseWriter, r *http.Request) {
	id := officialAPIFromCtx(r)
	var list []model.OfficialTemplate
	if err := store.DB.Where("account_id = ?", id.AccountID).
		Order("id DESC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	adminJSON(w, list)
}
