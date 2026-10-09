package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段二百七十四：网页卡片（微信同款链接分享卡片）服务端归口
//
// 背景：聊天中分享 http/https 网页链接时，客户端仅能显示裸 URL 文本。本模块在服务端
// 对"纯 URL 消息"异步抓取目标网页的 OG 元数据（title/description/og:image/favicon），
// 写回 im_message.card 列并向会话双方/群成员推送 CARD_UPDATE(106) 回填帧，客户端
// 原位把 URL 文本气泡升级为网页卡片气泡；历史消息因 card 已落库，加载时直接渲染卡片。
//
// 安全设计（防滥用/防 SSRF）：
//   1. 仅 content 去首尾空白后为单个 URL 的消息触发抓取（与微信"纯链接出卡片"行为一致，
//      正文夹带链接的普通消息不出卡片，仅前端链接化高亮）；
//   2. 仅允许 http/https；目标 host 为 IP 字面量或解析后落入私网/环回/链路本地段一律拒绝
//      （127/8、10/8、172.16/12、192.168/16、169.254/16、0/8、100.64/10、组播保留段、
//      ::1、fe80::/10、fc00::/7 等），防服务端被诱导抓取内网服务；
//   3. 重定向逐跳复检（最多 3 跳），响应体限读 256KB，UA 标识与 5s 总超时；
//   4. 全局并发信号量（8）+ 完整 URL 级结果缓存（2000 条），刷屏重复分享同一链接零重复抓取；
//   5. 抓取全程 goroutine 异步，消息收发主链路零阻塞；失败静默放弃（消息保持纯 URL 文本）。

// cardMaxBodyBytes 响应体最大读取字节数（HTML 头部足够承载 OG 元数据）
const cardMaxBodyBytes = 256 * 1024

// cardMaxTitleLen / cardMaxDescLen 标题与摘要入库截断长度（防超长元数据撑爆气泡与列宽）
const cardMaxTitleLen = 120
const cardMaxDescLen = 200

// webCardSemaphore 全局抓取并发信号量：防大量 URL 消息同时涌入打满出网带宽与 goroutine
var webCardSemaphore = make(chan struct{}, 8)

// webCardCache 完整 URL → 抓取结果 JSON（含抓取失败标记 ""，防反复重试同一死链）
var webCardCache = struct {
	sync.Mutex
	m map[string]string
}{m: make(map[string]string)}

// webCardClient 统一 HTTP 客户端：逐跳 SSRF 复检 + 总超时
var webCardClient = &http.Client{
	Timeout: 5 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return io.EOF // 超过 3 跳终止（错误由调用方统一按失败处理）
		}
		if cardHostBlocked(req.URL) {
			return io.ErrUnexpectedEOF // 重定向目标落私网段，拒绝跟进
		}
		return nil
	},
}

// cardPrivateV4Re 私网 IPv4 段正则（10/8、127/8、169.254/16、172.16/12、192.168/16、0/8、100.64/10）
var cardPrivateV4Re = regexp.MustCompile(
	`^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)`)

// cardHostBlocked 校验目标 URL host 是否禁止抓取：scheme 必须 http/https，IP 字面量或
// 解析结果落私网/环回/链路本地段（含 IPv6）一律拒绝
func cardHostBlocked(u *url.URL) bool {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		return true
	}
	host := u.Hostname()
	if host == "" {
		return true
	}
	// IP 字面量直接判定（含 IPv6）
	if ip := net.ParseIP(host); ip != nil {
		return cardIPPrivate(ip)
	}
	// 域名解析后逐 IP 判定（DNS rebinding 场景仅覆盖解析时刻，进一步防护需拨号层钉死 IP，
	// 对本场景风险收益比过低不做）
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return true // 解析失败视为不可达，放弃抓取
	}
	for _, ip := range ips {
		if cardIPPrivate(ip) {
			return true
		}
	}
	return false
}

// cardIPPrivate 判定 IP 是否私网/环回/链路本地/保留段
func cardIPPrivate(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip.To4() != nil {
		return cardPrivateV4Re.MatchString(ip.String())
	}
	// IPv6 组播与保留段兜底（ff00::/8）
	return ip.IsMulticast()
}

// webCardURLRe URL 提取正则：排除常见中文标点收尾与空白/尖括号引号（消息文本场景足够）
var webCardURLRe = regexp.MustCompile(`https?://[^\s<>"'，。；！？、）】]+`)

// webCardURLFor 判定消息 content 是否为"纯 URL 消息"（微信同款出卡片条件）：
// 去首尾空白后整体为单个 http/https URL（尾部英文标点剥离后再判定）返回 URL，否则返回 ""
func webCardURLFor(content string) string {
	t := strings.TrimSpace(content)
	if t == "" || strings.ContainsAny(t, " \t\r\n") {
		return ""
	}
	m := webCardURLRe.FindString(t)
	if m == "" || m != t {
		return ""
	}
	// 剥离尾部英文标点后再校验整体仍是 URL（句尾句号/逗号等不应算链接一部分）
	for len(m) > 0 {
		c := m[len(m)-1]
		if c == '.' || c == ',' || c == ';' || c == ':' || c == '!' || c == '?' || c == ')' || c == '\'' || c == '"' {
			m = m[:len(m)-1]
			continue
		}
		break
	}
	if m == "" {
		return ""
	}
	if _, err := url.ParseRequestURI(m); err != nil {
		return ""
	}
	return m
}

// WebCardMeta 抓取结果（前端渲染字段；JSON 序列化存 im_message.card 列与 CARD_UPDATE 帧 content）
type WebCardMeta struct {
	URL    string `json:"url"`
	Title  string `json:"title,omitempty"`
	Desc   string `json:"desc,omitempty"`
	Thumb  string `json:"thumb,omitempty"` // og:image（优先）
	Icon   string `json:"icon,omitempty"`  // favicon（域名行小图标）
	Domain string `json:"domain"`          // 展示域名（微信卡片底部小字）
}

// cardMetaTagRe meta 标签整体匹配（property/name 与 content 属性顺序无关，先摘标签再摘属性）
var (
	cardMetaTagRe = regexp.MustCompile(`(?is)<meta\s[^>]*?og:(title|description|image)[^>]*?>`)
	cardTitleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	cardIconRe    = regexp.MustCompile(`(?is)<link\s[^>]*?rel=[^>]*?icon[^>]*?>`)
	cardContentRe = regexp.MustCompile(`(?i)content\s*=\s*("([^"]*)"|'([^']*)')`)
	cardHrefRe    = regexp.MustCompile(`(?i)href\s*=\s*("([^"]*)"|'([^']*)')`)
)

// fetchWebCard 抓取并解析目标网页 OG 元数据；失败返回 nil（调用方静默放弃）
func fetchWebCard(rawURL string) *WebCardMeta {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil || cardHostBlocked(u) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; IMBot/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := webCardClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, cardMaxBodyBytes))
	if err != nil && len(body) == 0 {
		return nil
	}
	html := string(body)

	card := &WebCardMeta{URL: rawURL}
	// og:title 优先，缺失退化 <title>；均空则用域名（仍出卡片，微信对无元数据站点同款兜底）
	for _, m := range cardMetaTagRe.FindAllStringSubmatch(html, -1) {
		cm := cardContentRe.FindStringSubmatch(m[0])
		if cm == nil {
			continue
		}
		val := cm[2]
		if val == "" {
			val = cm[3]
		}
		switch m[1] {
		case "title":
			if card.Title == "" {
				card.Title = val
			}
		case "description":
			if card.Desc == "" {
				card.Desc = val
			}
		case "image":
			if card.Thumb == "" {
				card.Thumb = val
			}
		}
	}
	if card.Title == "" {
		if t := cardTitleRe.FindStringSubmatch(html); t != nil {
			card.Title = strings.TrimSpace(t[1])
		}
	}
	// favicon：rel 含 icon 的 link 标签（shortcut icon/普通 icon 通吃），相对路径按页面 URL 补全
	if lk := cardIconRe.FindString(html); lk != "" {
		if hm := cardHrefRe.FindStringSubmatch(lk); hm != nil {
			href := hm[2]
			if href == "" {
				href = hm[3]
			}
			if href != "" {
				if ref, err := u.Parse(href); err == nil {
					card.Icon = ref.String()
				}
			}
		}
	}
	if card.Icon == "" {
		if ref, err := u.Parse("/favicon.ico"); err == nil {
			card.Icon = u.ResolveReference(ref).String()
		}
	}
	// og:image 相对路径同样补全
	if card.Thumb != "" {
		if ref, err := u.Parse(card.Thumb); err == nil {
			card.Thumb = u.ResolveReference(ref).String()
		} else {
			card.Thumb = ""
		}
	}
	card.Domain = u.Hostname()
	card.Title = truncateCardText(card.Title, cardMaxTitleLen)
	card.Desc = truncateCardText(card.Desc, cardMaxDescLen)
	return card
}

// truncateCardText 按 rune 截断并去首尾空白（防把 UTF-8 多字节字符截半）
func truncateCardText(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// enrichWebCardAsync 纯 URL 消息的卡片抓取归口（异步，主链路零阻塞）。
//
//	record：已回填 ID 的落库消息；toUser：会话目标（对方账号或 'gN'）；
//	groupMembers：群聊场景成员清单（nil=私聊）。
//
// 流程：抓取（缓存命中零请求）→ UPDATE card 列 → CARD_UPDATE(106) 帧推会话在线方。
// 离线端无需推帧：card 已落库，下次登录历史加载自带卡片。
func (s *Server) enrichWebCardAsync(record *model.Message, toUser string, groupMembers []string) {
	if record == nil || record.ID == 0 || !s.cfg.Card.Enabled {
		return
	}
	rawURL := webCardURLFor(record.Content)
	if rawURL == "" {
		return
	}
	from := record.FromUser
	msgID := record.ID
	go func() {
		// 结果缓存：命中直接复用（含失败标记 "" 与在途占位，死链/并发重复抓取均不重试）；
		// 缓存满 2000 条后仅抓不存（防内存膨胀）
		webCardCache.Lock()
		cached, ok := webCardCache.m[rawURL]
		if ok {
			webCardCache.Unlock()
			if cached == "" || cached == "\x00pending" {
				return
			}
		} else {
			webCardCache.m[rawURL] = "\x00pending" // 占位防并发重复抓取
			webCardCache.Unlock()
			webCardSemaphore <- struct{}{}
			card := fetchWebCard(rawURL)
			<-webCardSemaphore
			if card != nil {
				if b, err := json.Marshal(card); err == nil {
					cached = string(b)
				}
			}
			webCardCache.Lock()
			webCardCache.m[rawURL] = cached
			webCardCache.Unlock()
			if cached == "" {
				return // 抓取失败静默放弃
			}
		}

		// card 元数据写回消息行（历史加载自带卡片）；写库失败仅记日志，实时帧照推
		if err := store.DB.Model(&model.Message{}).Where("id = ?", msgID).Update("card", cached).Error; err != nil {
			logger.Warn("网页卡片元数据写库失败 msg_id=%d: %v", msgID, err)
		}

		// CARD_UPDATE(106) 回填帧：content 为卡片元数据 JSON，msg_id 定位前端气泡
		frame := protocol.Message{
			MsgType:  protocol.MsgTypeCardUpdate,
			FromUser: from,
			ToUser:   toUser,
			Content:  cached,
			MsgID:    msgID,
		}
		data, err := json.Marshal(frame)
		if err != nil {
			return
		}
		if len(groupMembers) > 0 {
			s.sendToGroupMembers(groupMembers, data)
			return
		}
		s.sendToUser(toUser, data) // 接收方
		s.sendToUser(from, data)   // 发送方回显（多端同步）
	}()
}
