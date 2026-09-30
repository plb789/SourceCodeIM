package server

// ===== 阶段二百四十：PC/WEB 端扫码登录（微信同款） =====
// 职责划分：
//   1. HTTP 三端点：/api/qrlogin/create（登录页申请二维码，IP 限频）、/api/qrlogin/poll（登录页轮询
//      状态机，confirmed 时一次性下发登录码）、/qrl?t=（系统相机扫码落地页，提示改用 APP 扫一扫）
//   2. WS 信令（msg_type=97）：手机端已登录态扫码确认（scan 扫描 / confirm 确认 / cancel 取消），
//      确认者身份即登录账号（天然鉴权，无需密码）
//   3. 一次性登录码换账号：handleLogin content 前缀 qrc: 通道（qrLoginResolveUser），
//      校验通过按绑定账号走 handleLogin 既有登录链路（状态拦截/多端/配置下发零重复实现）
// 安全水位：qr_id 与登录码均一次性 + 短 TTL（二维码 2 分钟 / 登录码 60 秒）；poll 响应不含用户名
// （防枚举）；create 限频防刷；确认动作用户归口 WS 登录名（防伪造他人身份确认）

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

const (
	qrLoginTTL     = 2 * time.Minute  // 二维码有效期（微信同款约 2 分钟，过期置灰刷新）
	qrLoginCodeTTL = 60 * time.Second // 确认后签发的一次性登录码有效期
	qrLoginLimitN  = 30               // 单 IP 每分钟 create 次数上限（防刷）
)

// QRLoginCodePrefix 扫码登录通道登录帧 content 前缀（复用 msg_type=7 登录链路，服务端识别走免密码通道）
const QRLoginCodePrefix = "qrc:"

// 扫码登录业务错误（加入 isAuthBusinessError 白名单：客户端原样展示，不按底层依赖错误吞掉）
var (
	ErrQRLoginExpired = errors.New("二维码已过期，请刷新后重试")
	ErrQRLoginInvalid = errors.New("登录码无效或已使用")
)

// 扫码会话状态机：waiting →(手机扫描)→ scanned →(手机确认)→ confirmed →(PC 凭码登录)→ used
// 任意状态超时 / 取消 → expired / waiting
const (
	qrStateWaiting   = "waiting"
	qrStateScanned   = "scanned"
	qrStateConfirmed = "confirmed"
	qrStateUsed      = "used"
)

// qrSession 扫码登录会话（内存态，重启即清空——登录页重新出码即可）
type qrSession struct {
	ID       string
	Platform string // 申请方端别（pc / web），手机确认页展示
	State    string
	Username string    // confirm 时绑定（确认者=登录账号）
	Expires  time.Time // 二维码有效期
	Code     string    // confirmed 后签发的一次性登录码
	CodeExp  time.Time // 登录码有效期
}

var (
	qrMu       sync.Mutex
	qrSessions = map[string]*qrSession{} // qr_id -> 会话
	qrByCode   = map[string]string{}     // 登录码 -> qr_id（凭码登录检索）
	qrLimitMu  sync.Mutex
	qrLimits   = map[string][]time.Time{} // ip -> create 时间窗（限频）
)

// qrRandToken 生成 n 字节随机数的 hex 串（qr_id / 登录码统一归口）
func qrRandToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// qrSweepExpired 惰性清理过期会话（持锁调用）
func qrSweepExpired() {
	now := time.Now()
	for id, s := range qrSessions {
		if now.After(s.Expires) || s.State == qrStateUsed {
			if s.Code != "" {
				delete(qrByCode, s.Code)
			}
			delete(qrSessions, id)
		}
	}
}

// qrClientIP 客户端真实 IP 归口（X-Forwarded-For 首跳优先，回退 RemoteAddr；限频用）
func qrClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			xff = xff[:i]
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// qrWriteJSON 统一 JSON 响应写出
func qrWriteJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	b, err := json.Marshal(v)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Write(b)
}

// HandleQRLoginCreate 登录页申请二维码（POST {platform}）→ {ok, id, expires_in}
// 无鉴权（登录前调用）；单 IP 每分钟限 qrLoginLimitN 次
func (s *Server) HandleQRLoginCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		qrWriteJSON(w, map[string]interface{}{"ok": false, "err": "method"})
		return
	}
	ip := qrClientIP(r)
	now := time.Now()
	qrLimitMu.Lock()
	wins := qrLimits[ip]
	fresh := wins[:0]
	for _, t := range wins {
		if now.Sub(t) < time.Minute {
			fresh = append(fresh, t)
		}
	}
	if len(fresh) >= qrLoginLimitN {
		qrLimitMu.Unlock()
		qrWriteJSON(w, map[string]interface{}{"ok": false, "err": "too_many"})
		return
	}
	qrLimits[ip] = append(fresh, now)
	qrLimitMu.Unlock()

	var body struct {
		Platform string `json:"platform"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	platform := strings.TrimSpace(body.Platform)
	if platform != "pc" && platform != "web" {
		platform = "web"
	}
	id := qrRandToken(16)
	if id == "" {
		qrWriteJSON(w, map[string]interface{}{"ok": false, "err": "server"})
		return
	}
	qrMu.Lock()
	qrSweepExpired()
	qrSessions[id] = &qrSession{
		ID:       id,
		Platform: platform,
		State:    qrStateWaiting,
		Expires:  now.Add(qrLoginTTL),
	}
	qrMu.Unlock()
	logger.Info("扫码登录：申请二维码 %s（%s 端，IP %s）", id, platform, ip)
	qrWriteJSON(w, map[string]interface{}{"ok": true, "id": id, "expires_in": int(qrLoginTTL.Seconds())})
}

// HandleQRLoginPoll 登录页轮询扫码状态（GET ?id=）→ {state: waiting|scanned|confirmed|expired}
// confirmed 时一次性下发登录码 code 并置 used（重复轮询/并发轮询仅首个拿到，拿码后即停轮询）
// 响应不携带用户名（防枚举——账号归属仅手机确认页可见）
func (s *Server) HandleQRLoginPoll(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	qrMu.Lock()
	sess, ok := qrSessions[id]
	if !ok || time.Now().After(sess.Expires) {
		if ok {
			if sess.Code != "" {
				delete(qrByCode, sess.Code)
			}
			delete(qrSessions, id)
		}
		qrMu.Unlock()
		qrWriteJSON(w, map[string]interface{}{"state": "expired"})
		return
	}
	switch sess.State {
	case qrStateConfirmed:
		// 签发一次性登录码并立即消费（防重放：同一会话只发一次）
		code := qrRandToken(24)
		if code == "" {
			qrMu.Unlock()
			qrWriteJSON(w, map[string]interface{}{"state": "expired"})
			return
		}
		sess.Code = code
		sess.CodeExp = time.Now().Add(qrLoginCodeTTL)
		sess.State = qrStateUsed
		qrByCode[code] = sess.ID
		qrMu.Unlock()
		logger.Info("扫码登录：二维码 %s 已确认（%s 端），签发一次性登录码", sess.ID, sess.Platform)
		qrWriteJSON(w, map[string]interface{}{"state": "confirmed", "code": code})
	default:
		state := sess.State
		qrMu.Unlock()
		qrWriteJSON(w, map[string]interface{}{"state": state})
	}
}

// qrLandingHTML 系统相机扫码落地页（非 APP 扫一扫场景的兜底提示）
const qrLandingHTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
	`<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">` +
	`<title>扫码登录</title><style>body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;` +
	`display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;color:#333}` +
	`.card{text-align:center;padding:40px 28px}.icon{font-size:52px;margin-bottom:16px}` +
	`h1{font-size:18px;font-weight:600;margin:0 0 8px}p{font-size:14px;color:#888;margin:0;line-height:1.6}</style></head>` +
	`<body><div class="card"><div class="icon">📱</div><h1>请使用即时通讯 APP 扫一扫</h1>` +
	`<p>打开手机 APP，在「+」菜单中使用扫一扫<br>扫描电脑上的登录二维码</p></div></body></html>`

// HandleQRLanding 系统相机扫码落地页（提示改用 APP 扫一扫）
func (s *Server) HandleQRLanding(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(qrLandingHTML))
}

// HandleQRSign 扫码确认信令（msg_type=97，手机端已登录态）
// 上行 content JSON：{action: scan|confirm|cancel, qr_id}; 下行回执：{action, ok, reason?}
func (s *Server) HandleQRSign(c *Client, msg *protocol.Message) {
	if c.username == "" {
		s.sendError(c, "请先登录")
		return
	}
	var body struct {
		Action string `json:"action"`
		QRID   string `json:"qr_id"`
	}
	if err := json.Unmarshal([]byte(msg.Content), &body); err != nil || body.QRID == "" {
		s.sendError(c, "扫码信令格式错误")
		return
	}
	// 阶段二百四十修复：回执必须携带 msg_type=97（原裸 map 序列化后缺 msg_type 字段，
	// 客户端解析得 msg_type=0 → 前端按 97 归口回执永远匹配不上 → 手机扫码后确认卡不弹出）
	reply := func(ok bool, reason, platform string) {
		m := map[string]interface{}{"msg_type": protocol.MsgTypeQRSign, "action": body.Action, "ok": ok}
		if reason != "" {
			m["reason"] = reason
		}
		if platform != "" {
			m["platform"] = platform
		}
		b, _ := json.Marshal(m)
		c.send(b)
	}

	qrMu.Lock()
	sess, ok := qrSessions[body.QRID]
	if !ok || time.Now().After(sess.Expires) {
		if ok {
			if sess.Code != "" {
				delete(qrByCode, sess.Code)
			}
			delete(qrSessions, body.QRID)
		}
		qrMu.Unlock()
		reply(false, "二维码已过期，请刷新后重新扫描", "")
		return
	}
	switch body.Action {
	case "scan":
		// 手机扫描：waiting/scanned 均可再扫（重复扫描覆盖前次，最后扫描者有效）
		if sess.State == qrStateWaiting || sess.State == qrStateScanned {
			sess.State = qrStateScanned
			platform := sess.Platform
			qrMu.Unlock()
			// 回执携带申请方端别（手机确认页展示「确认在 PC/网页 端登录」文案）
			reply(true, "", platform)
			return
		}
		qrMu.Unlock()
		reply(false, "二维码状态已变化，请重新扫描", "")
	case "confirm":
		// 确认登录：绑定确认者账号（确认者=登录账号，身份归口 WS 登录名）
		if sess.State != qrStateScanned {
			qrMu.Unlock()
			reply(false, "请先扫描二维码", "")
			return
		}
		sess.Username = c.username
		sess.State = qrStateConfirmed
		qrMu.Unlock()
		logger.Info("扫码登录：%s 已确认二维码 %s（%s 端待登录）", c.username, sess.ID, sess.Platform)
		reply(true, "", "")
	case "cancel":
		// 手机端取消：回退 waiting（PC 端轮询自动回到待扫描态，可再次扫码）
		if sess.State == qrStateScanned {
			sess.State = qrStateWaiting
		}
		qrMu.Unlock()
		reply(true, "", "")
	default:
		qrMu.Unlock()
		reply(false, "未知扫码动作", "")
	}
}

// qrLoginResolveUser 凭一次性登录码换取账号（handleLogin qrc: 通道归口）
// 校验：登录码存在 / 会话 confirmed 态 / 未过期 → 消费（一次性）→ 按绑定账号查 DB 返回
func qrLoginResolveUser(code string) (*model.User, error) {
	code = strings.TrimPrefix(strings.TrimSpace(code), QRLoginCodePrefix)
	qrMu.Lock()
	qrID, ok := qrByCode[code]
	if !ok {
		qrMu.Unlock()
		return nil, ErrQRLoginInvalid
	}
	// 阶段二百四十修复：状态校验与签发侧对齐——poll 签发码时已把会话置为 qrStateUsed
	// （防重复签发），原条件要求 qrStateConfirmed 导致刚签发的码必然校验失败
	// （实测复现：「登录码无效或已使用」）。used 态+code 匹配+未过期=待消费有效码；
	// 消费后 Code 已清空且 qrByCode 已删（下方消费段），同码二次登录仍被拒绝（一次性不破）
	sess, ok := qrSessions[qrID]
	if !ok || sess.State != qrStateUsed || sess.Code != code || time.Now().After(sess.CodeExp) {
		// 无效/过期：顺手清残留
		if ok && sess.Code == code {
			sess.Code = ""
		}
		delete(qrByCode, code)
		qrMu.Unlock()
		return nil, ErrQRLoginInvalid
	}
	username := sess.Username
	sess.Code = ""
	sess.State = qrStateUsed
	delete(qrByCode, code)
	qrMu.Unlock()
	logger.Info("扫码登录：%s 凭登录码登录（会话 %s）", username, qrID)

	// 按绑定账号加载用户（与通话 invite 同款查库口径：存在且未注销）
	var u model.User
	if err := store.DB.Where("username = ? AND status = ?", username, model.UserStatusNormal).First(&u).Error; err != nil {
		return nil, ErrQRLoginInvalid
	}
	return &u, nil
}
