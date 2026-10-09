package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/protocol"
	"im-server/store"
)

// ===== 阶段二百二十六：厂商推送通道（方案 B：进程被杀兜底）=====
// 微信"杀不死"的本质不是进程不死，而是厂商系统级推送兜底：MiPush/华为 HMS 等推送服务
// 是系统常驻进程，应用进程被杀后系统照样代收消息弹通知。本文件归口服务端侧：
// 1. 消息离线入队（queueOffline/queueOfflineBatch，即接收端无任何在线连接）时，
//    对聊天类消息抽取摘要，异步投递厂商推送接口（vendorPushNotify → pushDeliver）；
// 2. 通道二选一（EMAS 启用即优先，全量替代路线）：
//    - 阿里云 EMAS 移动推送（emasPush）：聚合推送平台，服务端只调阿里云一个 OpenAPI
//      （按账号 Target=ACCOUNT 推送，客户端 SDK 原生 bindAccount 绑定，无需 regId 注册表），
//      在线走阿里云 ACCS 长连接、进程被杀自动降级华为/小米/OPPO/vivo 等厂商离线通道；
//    - 小米 MiPush 直连（REST v3）：APP 端经 96 号帧上报 regId → Redis im:regid:<username>
//      （handlePushRegID），逐设备定向推送；
// 3. 点击通知经深链 imapp://chat?to=<target> 打开会话，与前台服务通知同款，
//    前端 initNativeDeepLink（appUrlOpen/getLaunchUrl）归口消费。
// 未启用/未配置凭据时全链路直通返回，零开销零回归。凭据仅存 config.yaml 不下发客户端。
// 注意：FGS 后台接管时连接在线（isOnlineFast 命中）不会进入离线入队，天然不重复推送。

const (
	pushQueueSize   = 8192            // 推送任务队列长度（超限丢新保旧，离线消息本体已入队由登录补推兜底）
	pushWorkerCount = 4               // 推送投递并发 worker 数（厂商接口为外网 REST，低并发即可）
	pushHTTPTimeout = 5 * time.Second // 单次投递超时
	pushBatchLimit  = 40              // 单条消息触发的批量推送上限（万级群离线名单防队列打爆；超出成员走登录补推兜底）
)

// pushJob 单条推送任务（worker 池消费，防群发场景 goroutine 风暴）
type pushJob struct {
	username string // 目标用户（查其 regId）
	title    string // 通知标题（发送方）
	body     string // 通知正文（消息摘要）
	target   string // 点击跳转目标（会话编码：用户名 / g+群ID；空=仅打开应用）
	notifyID int    // 同会话通知合并 ID（MiPush 同 notify_id 折叠展示）
}

// pushHTTP 厂商推送共用 HTTP 客户端（连接池复用，超时统一归口）
var pushHTTP = &http.Client{Timeout: pushHTTPTimeout}

// emasEndpoint 阿里云移动推送 OpenAPI 接入点（POP RPC 风格，GET + HMAC-SHA1 签名）。
// 注意：官方服务端唯一接入点为 cloudpush.aliyuncs.com（OpenAPI 门户与网络白名单文档一致；
// mobilepush.aliyuncs.com 并不存在，DNS 权威应答 NXDOMAIN，2026-09-29 实测）。
const emasEndpoint = "https://cloudpush.aliyuncs.com/"

// emasEnabled 阿里云 EMAS 通道是否可用（配置归口：子开关 + AppKey + AccessKey 双凭据非空）
func (s *Server) emasEnabled() bool {
	return s.cfg != nil && s.cfg.Push.Enabled && s.cfg.Push.EMAS.Enabled &&
		s.cfg.Push.EMAS.AppKey != "" && s.cfg.Push.EMAS.AccessKeyID != "" &&
		s.cfg.Push.EMAS.AccessKeySecret != ""
}

// pushEnabled 厂商推送是否可用（任一通道可用即可：EMAS 优先，MiPush 为备用直连通道）
func (s *Server) pushEnabled() bool {
	return s.emasEnabled() || (s.cfg != nil && s.cfg.Push.Enabled &&
		s.cfg.Push.MiPush.Enabled && s.cfg.Push.MiPush.AppSecret != "")
}

// startPushWorkers 启动推送投递 worker 池（NewServer 归口调用；未启用配置时队列恒空零开销）
func (s *Server) startPushWorkers() {
	s.pushCh = make(chan pushJob, pushQueueSize)
	for i := 0; i < pushWorkerCount; i++ {
		go s.pushWorker()
	}
}

func (s *Server) pushWorker() {
	for job := range s.pushCh {
		s.pushDeliver(job)
	}
}

// vendorPushNotify 离线消息厂商推送入口（queueOffline/queueOfflineBatch 归口调用）。
// 异步入队不阻塞消息投递链路；仅对聊天类消息推送——同步/信令类帧离线补推即可，弹通知反而打扰
func (s *Server) vendorPushNotify(usernames []string, from string, msg *protocol.Message) {
	if !s.pushEnabled() || len(usernames) == 0 || msg == nil {
		return
	}
	// 可推送消息类型：1 群文字 2 私文字 3 文件 20 好友申请 34 群图片 69 群文件 75 群邀请 86 红包 92 网盘分享 104 位置 107 名片
	switch msg.MsgType {
	case protocol.MsgTypeGroupChat, protocol.MsgTypePrivate, protocol.MsgTypeFile,
		protocol.MsgTypeFriendRequest, protocol.MsgTypeGroupImage, protocol.MsgTypeGroupFile,
		protocol.MsgTypeGroupInviteNotice, protocol.MsgTypeRedPacket, protocol.MsgTypeDriveShare,
		protocol.MsgTypeLocation, protocol.MsgTypeContactCard:
	default:
		return
	}
	body := pushBody(msg)
	if body == "" {
		return
	}
	// 点击跳转目标：私聊=对端用户名，群聊=g+群ID（与 KeepAliveService 通知深链同款编码）
	target := msg.ToUser
	// 标题：发送方（微信式"发送方：摘要"）；联调后可换发方昵称（现取账号，零查询开销）
	title := from
	// 通知合并 ID：同会话折叠（私聊按发送方、群聊按群）
	notifyID := pushHash(target)
	// 万级群离线名单限流：仅前 N 名入队（超出成员离线消息已入队，登录补推兜底不丢）
	if len(usernames) > pushBatchLimit {
		usernames = usernames[:pushBatchLimit]
	}
	for _, u := range usernames {
		job := pushJob{username: u, title: title, body: body, target: target, notifyID: notifyID}
		select {
		case s.pushCh <- job:
		default: // 队列满：丢弃本条通知（消息本体已入离线队列，不阻塞投递协程）
		}
	}
}

// pushBody 抽取推送正文摘要（微信通知"发送方：摘要"中的摘要段；文本走会话摘要归口解析信封）
func pushBody(msg *protocol.Message) string {
	switch msg.MsgType {
	case protocol.MsgTypePrivate, protocol.MsgTypeGroupChat:
		return messageSummary(msg.Content)
	case protocol.MsgTypeFile:
		return "[文件] " + msg.FileName
	case protocol.MsgTypeGroupImage:
		return "[图片]"
	case protocol.MsgTypeGroupFile:
		return "[群文件] " + msg.FileName
	case protocol.MsgTypeFriendRequest:
		return "请求添加你为好友"
	case protocol.MsgTypeGroupInviteNotice:
		return "邀请你加入群聊"
	case protocol.MsgTypeRedPacket:
		return "[红包]"
	case protocol.MsgTypeDriveShare:
		return "[文件分享] " + msg.FileName
	case protocol.MsgTypeLocation:
		return "[位置]"
	case protocol.MsgTypeContactCard:
		return "[联系人]"
	}
	return ""
}

// pushHash 会话编码 → 通知合并 ID（MiPush notify_id 要求非负 int）
func pushHash(s string) int {
	h := 0
	for i := 0; i < len(s); i++ {
		h = h*31 + int(s[i])
	}
	if h < 0 {
		h = -h
	}
	return h % 100000
}

// pushDeliver 单条推送投递，按通道分流：EMAS 启用即全量走阿里云聚合通道（免 regId 注册表），
// 否则回落小米 MiPush 直连（查目标用户 regId → REST v3 逐设备定向）。
// 华为 HMS/OPPO/vivo 独立直连接入时在 MiPush 分支同位置按厂商扩展
func (s *Server) pushDeliver(job pushJob) {
	if s.emasEnabled() {
		s.emasPush(job)
		return
	}
	s.mipushDeliver(job)
}

// mipushDeliver MiPush 直连投递：查目标用户 regId → 调小米 REST v3 单推接口
func (s *Server) mipushDeliver(job pushJob) {
	ctx, cancel := context.WithTimeout(context.Background(), pushHTTPTimeout)
	defer cancel()
	regID, err := store.RDB.Get(ctx, store.KeyPushRegID+job.username).Result()
	if err != nil || regID == "" {
		return // 无 regId（未上报/仅 web/PC 端用户）：静默跳过
	}
	mcfg := s.cfg.Push.MiPush
	form := url.Values{}
	form.Set("registration_id", regID)
	form.Set("restricted_package_name", mcfg.Package) // 包名校验（与 APK applicationId 一致才可达）
	form.Set("title", job.title)
	form.Set("description", job.body)
	form.Set("notify_type", "-1") // 提示全部（铃声/振动/呼吸灯随系统）
	form.Set("notify_id", strconv.Itoa(job.notifyID))
	// 点击打开指定页（Intent 深链）：notify_effect=2 → intent_uri 打开会话。
	// Manifest 已为 MainActivity 注册 scheme=imapp 的 BROWSABLE intent-filter（本阶段补齐，
	// 原前台服务通知为显式 Intent 不依赖该 filter）
	form.Set("extra.notify_effect", "2")
	intent := "intent://chat?to=" + url.QueryEscape(job.target) +
		"#Intent;scheme=imapp;package=" + mcfg.Package + ";end"
	form.Set("extra.intent_uri", intent)
	form.Set("extra.notify_foreground", "1")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.xmpush.xiaomi.com/v3/message/regId", strings.NewReader(form.Encode()))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "key="+mcfg.AppSecret)
	resp, err := pushHTTP.Do(req)
	if err != nil {
		logger.Warn("MiPush 投递失败（用户 %s）: %v", job.username, err)
		return
	}
	defer resp.Body.Close()
	var out struct {
		Result string `json:"result"`
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Result != "ok" {
		logger.Warn("MiPush 投递被拒（用户 %s）: result=%s reason=%s", job.username, out.Result, out.Reason)
	}
}

// ===== 阿里云 EMAS 移动推送通道（聚合推送，EMAS 启用即优先于 MiPush）=====
// 阿里云 POP RPC 协议直连实现（HMAC-SHA1 签名，无外部 SDK 依赖），按账号 Target=ACCOUNT
// 单账号推送：客户端 EMAS SDK 原生调 bindAccount(用户名) 绑定，服务端无需 regId 注册表；
// 在线设备走阿里云 ACCS 长连接，进程被杀由阿里云自动转发厂商离线通道（华为/小米/OPPO/vivo
// 等，凭据在各厂商开放平台申请后配置到 EMAS 控制台）。接入联调时按阿里云官方文档实测校准
// 点击行为参数（OpenType/自定义参数由客户端 onNotification 消费跳 imapp://chat 深链）

// emasPush EMAS 按账号推送一条消息摘要通知（pushDeliver 分流归口）
func (s *Server) emasPush(job pushJob) {
	ec := s.cfg.Push.EMAS
	region := ec.Region
	if region == "" {
		region = "cn-hangzhou"
	}
	params := map[string]string{
		"Action":      "Push",
		"Version":     "2016-08-01",
		"AppKey":      ec.AppKey,
		"Target":      "ACCOUNT",
		"TargetValue": job.username,
		"DeviceType":  "ANDROID",
		"PushType":    "NOTICE",
		"Title":       job.title,
		"Body":        job.body,
		// 点击深链：以自定义参数下发目标会话，客户端通知点击回调消费后跳 imapp://chat?to=<target>
		"AndroidNotificationParameters.1.Key":   "target",
		"AndroidNotificationParameters.1.Value": job.target,
	}
	// 厂商离线通道"辅助弹窗"参数（官方文档硬性要求，缺一则进程被杀后厂商通道不可达）：
	// AndroidPopupActivity 指向客户端 EmasPopupActivity（厂商系统代发通知的点击中转页），
	// Title/Body 为弹窗展示内容。Package 未配置时跳过（仅在线 ACCS 通道可达）
	if ec.Package != "" {
		params["AndroidPopupActivity"] = ec.Package + ".EmasPopupActivity"
		params["AndroidPopupTitle"] = job.title
		params["AndroidPopupBody"] = job.body
	}
	if _, err := emasRPCGet(emasEndpoint, region, ec.AccessKeyID, ec.AccessKeySecret, params); err != nil {
		logger.Warn("EMAS 投递失败（用户 %s）: %v", job.username, err)
	}
}

// emasRPCGet 阿里云 POP RPC GET 请求（公共参数组装 + HMAC-SHA1 签名 + 响应错误归口）。
// 签名流程：参数按 key 字典序 → canonical query（percentEncode）→
// StringToSign = "GET&%2F&" + enc(canonical) → base64(HMAC-SHA1(AccessKeySecret+"&", StringToSign))
func emasRPCGet(endpoint, region, akID, akSecret string, biz map[string]string) (json.RawMessage, error) {
	params := map[string]string{
		"AccessKeyId":      akID,
		"Format":           "JSON",
		"RegionId":         region,
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureVersion": "1.0",
		"SignatureNonce":   emasNonce(),
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
	}
	for k, v := range biz {
		params[k] = v
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, emasEncode(k)+"="+emasEncode(params[k]))
	}
	canonical := strings.Join(pairs, "&")
	mac := hmac.New(sha1.New, []byte(akSecret+"&"))
	mac.Write([]byte("GET&%2F&" + emasEncode(canonical)))
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		endpoint+"?Signature="+emasEncode(signature)+"&"+canonical, nil)
	if err != nil {
		return nil, err
	}
	resp, err := pushHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		MessageID string `json:"MessageId"`
		Code      string `json:"Code"`
		Message   string `json:"Message"`
	}
	// Push 成功返回 {MessageId, RequestId}；失败返回 {Code, Message, RequestId}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Code != "" {
		return nil, fmt.Errorf("%s: %s", out.Code, out.Message)
	}
	return nil, nil
}

// emasEncode 阿里云 POP percentEncode（RFC3986：+→%20、*→%2A、%7E→~）
func emasEncode(s string) string {
	s = url.QueryEscape(s)
	s = strings.ReplaceAll(s, "+", "%20")
	s = strings.ReplaceAll(s, "*", "%2A")
	return strings.ReplaceAll(s, "%7E", "~")
}

// emasNonce 签名防重放随机数（crypto/rand 16 字节 hex）
func emasNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// handlePushRegID 96 号帧：APP 端上报厂商推送 regId（登录成功后/变更时全量覆盖上报）。
// content 为 JSON：{vendor:"mipush", reg_id:"..."}；reg_id 空=注销上报（退出登录清空绑定，
// 防消息通知泄漏到已登出设备）。注册表仅服务于 MiPush 直连通道；EMAS 通道按账号推送，
// 客户端 SDK 原生 bindAccount 即可无需上报。vendor 门禁预留多厂商直连扩展
func (s *Server) handlePushRegID(c *Client, msg *protocol.Message) {
	if !s.pushEnabled() {
		return
	}
	var in struct {
		Vendor string `json:"vendor"`
		RegID  string `json:"reg_id"`
	}
	if json.Unmarshal([]byte(msg.Content), &in) != nil || in.Vendor != "mipush" {
		return
	}
	key := store.KeyPushRegID + c.username
	if in.RegID == "" {
		store.RDB.Del(context.Background(), key)
		return
	}
	// regId 经登录态连接上报（与 22/73 等信令同级信任）；无过期（每次登录覆盖刷新）
	if err := store.RDB.Set(context.Background(), key, in.RegID, 0).Err(); err != nil {
		logger.Warn("regId 上报存储失败（用户 %s）: %v", c.username, err)
	}
}
