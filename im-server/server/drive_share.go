package server

// ===== 网盘二期：文件分享（好友/群卡片 + 站内链接双模式，服务端统一数据归口） =====
// 设计归口：
//  1. 分享状态（取消/过期/源文件删除）服务端归口计算，客户端只展示；FileName/IsDir/Size 为
//     创建时快照，管理列表不随源文件改名/删除失真
//  2. 零拷贝保存：受让方"保存到我的网盘"仅复制元数据记录（指向同一 object_key），文件本体
//     零复制；源主删除时由 handleDriveDelete 的 object_key 引用计数保护兜底，防受让方悬空
//  3. 卡片消息与红包(86)同链路：服务端创建分享后构造信封落库转发（私聊双方/群成员定向），
//     历史按 msg_type=92 渲染卡片气泡，点击弹分享详情（保存/下载）
//  4. 链接模式：/s/<share_code> 站内访问，可选 4 位提取码（去易混淆字符）；有效期 永久/1天/7天/30天
//  5. 鉴权水位：创建/列表/取消/保存须本人在线（driveCheckUser 归口，同网盘其余接口）；
//     详情/下载凭 分享码+提取码 访问（百度网盘同款链接语义），不暴露任何盘内枚举能力

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"

	"gorm.io/gorm"
)

// RegisterDriveShareRoutes 注册网盘分享路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
func RegisterDriveShareRoutes(s *Server) {
	http.HandleFunc("POST /api/drive/share/create", s.handleDriveShareCreate)
	http.HandleFunc("GET /api/drive/share/list", s.guardDrive(s.handleDriveShareList))
	http.HandleFunc("POST /api/drive/share/cancel", s.handleDriveShareCancel)
	http.HandleFunc("POST /api/drive/share/delete", s.handleDriveShareDelete)
	http.HandleFunc("GET /api/drive/share/info", s.handleDriveShareInfo)
	http.HandleFunc("GET /api/drive/share/children", s.handleDriveShareChildren)
	http.HandleFunc("POST /api/drive/share/save", s.handleDriveShareSave)
	http.HandleFunc("GET /api/drive/share/download", s.handleDriveShareDownload)
}

// StartShareCleanupLoop 启动过期分享记录清理后台任务（main.go 启动时调用，单协程）
// 只清理"已过期"记录（expire_at>0 且过期超过 30 天——留痕期过后删除，防表无限膨胀）；
// 已取消记录不自动清理（分享者可在分享管理里手动删除记录，注释同 handleDriveShareCancel）
func StartShareCleanupLoop() {
	go func() {
		shareCleanupOnce() // 启动先执行一次（与文件清理同款节奏）
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			shareCleanupOnce()
		}
	}()
	logger.Info("过期分享清理已启动（过期留痕 30 天后删除记录，每 6 小时扫描一轮）")
}

// shareCleanupOnce 单轮清理：删除过期超 30 天的分享记录（记录删除不影响源文件/副本数据）
func shareCleanupOnce() {
	cutoff := time.Now().Add(-30 * 24 * time.Hour).Unix()
	res := store.DB.Where("expire_at > 0 AND expire_at < ?", cutoff).Delete(&model.DriveShare{})
	if res.Error != nil {
		logger.Warn("过期分享清理失败: %v", res.Error)
		return
	}
	if res.RowsAffected > 0 {
		logger.Info("过期分享清理: 删除 %d 条过期记录", res.RowsAffected)
	}
}

// driveExtractAlphabet 提取码字符集（去 0O1I 等易混淆字符，4 位 8.3 亿组合）
const driveExtractAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

// driveGenExtract 生成 4 位提取码
func driveGenExtract() string {
	b := make([]byte, 4)
	rand.Read(b)
	for i := range b {
		b[i] = driveExtractAlphabet[int(b[i])%len(driveExtractAlphabet)]
	}
	return string(b)
}

// driveGenShareCode 生成站内链接码：纳秒 base36 + 16hex（与上传对象 key 同款命名，全局唯一）
func driveGenShareCode() string {
	b := make([]byte, 8)
	rand.Read(b)
	return strconv.FormatInt(time.Now().UnixNano(), 36) + hex.EncodeToString(b)
}

// ===== 提取码防暴力（服务端内存归口，覆盖 info/download/save 三个凭提取码访问的接口） =====
// 同一来源 IP 对同一分享码连续错 5 次 → 锁定 10 分钟（锁定内直接拒绝，不再比对提取码）；
// 校验成功即清零。内存态重启清零可接受（防暴力而非审计；4 位码 8.3 亿组合，重启清零不构成可利用绕过）。
// 来源仅取 RemoteAddr（X-Forwarded-For 可伪造不可作为限流依据；若未来加反向代理应在其层加限速）
const (
	shareExtractMaxFails   = 5
	shareExtractLockMillis = int64(10 * 60 * 1000)
)

// shareExtractState 单个 code|ip 维度的连续错误与锁定状态
type shareExtractState struct {
	fails     int
	lockUntil int64 // UnixMilli，0=未锁定
}

var (
	shareExtractMu    sync.Mutex
	shareExtractFails = map[string]*shareExtractState{}
)

// driveShareExtractKey 限流 key 归口：分享码|来源IP
func driveShareExtractKey(code, ip string) string { return code + "|" + ip }

// driveShareExtractLocked 提取码锁定检查：true=锁定中（应直接拒绝尝试）
func driveShareExtractLocked(code, ip string) bool {
	shareExtractMu.Lock()
	defer shareExtractMu.Unlock()
	st := shareExtractFails[driveShareExtractKey(code, ip)]
	return st != nil && st.lockUntil > time.Now().UnixMilli()
}

// driveShareExtractFail 记录一次提取码错误；达到上限即落锁并写日志
func driveShareExtractFail(code, ip string) {
	shareExtractMu.Lock()
	defer shareExtractMu.Unlock()
	// 惰性清理：条目超 1 万条时全量清已过期（count 清零+锁定过期）条目，防 map 无界膨胀
	if len(shareExtractFails) > 10000 {
		now := time.Now().UnixMilli()
		for k, v := range shareExtractFails {
			if v.lockUntil <= now && v.fails == 0 {
				delete(shareExtractFails, k)
			}
		}
	}
	key := driveShareExtractKey(code, ip)
	st := shareExtractFails[key]
	if st == nil {
		st = &shareExtractState{}
		shareExtractFails[key] = st
	}
	st.fails++
	if st.fails >= shareExtractMaxFails {
		st.lockUntil = time.Now().UnixMilli() + shareExtractLockMillis
		st.fails = 0
		logger.Warn("网盘分享提取码防暴力: code=%s ip=%s 连续错误%d次，锁定%d分钟", code, ip, shareExtractMaxFails, shareExtractLockMillis/60000)
	}
}

// driveShareExtractReset 提取码校验成功清零（区分于落锁：清零不删条目保留锁定状态语义）
func driveShareExtractReset(code, ip string) {
	shareExtractMu.Lock()
	defer shareExtractMu.Unlock()
	if st := shareExtractFails[driveShareExtractKey(code, ip)]; st != nil {
		st.fails = 0
	}
}

// ===== 分享统计（服务端归口原子计数，客户端只展示） =====
// 浏览 = info 成功查看（提取码通过后才计，打开页/刷新即一次浏览，百度网盘同款语义）；
// 下载 = download 非 preview 成功下发，60 秒同 code|ip 去重（浏览器 Range 分片/断点续传会把
// 一次下载拆成多次请求，不去重会虚增；预览走 preview=1 不计下载，视频拖进度条不污染计数）；
// 保存 = save 成功（按动作计 1 次，返回的 saved 为保存条目数，两者语义独立）。
// 计数失败仅告警不影响主流程；UpdateColumn 原子自增防读改写竞态。

// driveShareBump 指定计数字段原子自增
func driveShareBump(id uint, field string) {
	if err := store.DB.Model(&model.DriveShare{}).Where("id = ?", id).
		UpdateColumn(field, gorm.Expr(field+" + 1")).Error; err != nil {
		logger.Warn("网盘分享统计更新失败: id=%d %s %v", id, field, err)
	}
}

// shareDlWindowMillis 下载计数去重窗口（同 code|ip 窗口内多次请求只计 1 次）
const shareDlWindowMillis = int64(60 * 1000)

var (
	shareDlMu   sync.Mutex
	shareDlSeen = map[string]int64{} // code|ip -> 最近计数 UnixMilli
)

// driveShareDlShouldCount 下载是否应计数（窗口内首次 true；超 1 万条惰性清理过期项防膨胀）；
// code 参数可内嵌文件 ID（如 code|fileID，文件夹分享批量下载时各文件独立去重窗口）
func driveShareDlShouldCount(code, ip string) bool {
	shareDlMu.Lock()
	defer shareDlMu.Unlock()
	now := time.Now().UnixMilli()
	if len(shareDlSeen) > 10000 {
		for k, ts := range shareDlSeen {
			if now-ts > shareDlWindowMillis {
				delete(shareDlSeen, k)
			}
		}
	}
	key := code + "|" + ip
	if ts, ok := shareDlSeen[key]; ok && now-ts < shareDlWindowMillis {
		return false
	}
	shareDlSeen[key] = now
	return true
}

// driveShareInvalidReason 分享有效性归口校验（空串=有效；否则返回用户可读失效原因）
// 三态：分享者取消 / 已过期 / 源文件已删除（快照仍在，本体/元数据已不存在则保存下载均无意义）
func (s *Server) driveShareInvalidReason(sh *model.DriveShare) string {
	if sh.Canceled {
		return "分享已取消"
	}
	if sh.ExpireAt > 0 && time.Now().Unix() > sh.ExpireAt {
		return "分享已过期"
	}
	if _, err := s.driveOwnFile(sh.FileID, sh.Owner); err != nil {
		return "文件已被删除"
	}
	return ""
}

// driveShareClientFields 分享记录客户端字段归口（服务端统一计算，客户端零拼装）
type driveShareClient struct {
	ID        uint   `json:"id"`
	Code      string `json:"code"`
	FileName  string `json:"file_name"`
	IsDir     bool   `json:"is_dir"`
	Size      int64  `json:"size"`
	From      string `json:"from"`
	HasCode   bool   `json:"has_extract"` // 是否需要提取码
	ExpireAt  int64  `json:"expire_at"`   // Unix 秒，0=永久
	Status    string `json:"status"`      // valid/canceled/expired/deleted（列表与管理页归口展示）
	ValidMsg  string `json:"valid_msg"`   // 失效原因（status != valid 时携带）
	ShareLink string `json:"share_link"`  // 站内链接路径 /s/<code>（列表/详情共用）
	// 分享统计（服务端归口计数，info/list 响应共用；管理列表与分享页展示）
	ViewCount     int64 `json:"view_count"`
	DownloadCount int64 `json:"download_count"`
	SaveCount     int64 `json:"save_count"`
}

func driveShareToClient(s *Server, sh *model.DriveShare, withStatus bool) driveShareClient {
	out := driveShareClient{
		ID: sh.ID, Code: sh.ShareCode, FileName: sh.FileName, IsDir: sh.IsDir,
		Size: sh.Size, From: sh.Owner, HasCode: sh.ExtractCode != "",
		ExpireAt:  sh.ExpireAt,
		ShareLink: "/s/" + sh.ShareCode,
		ViewCount: sh.ViewCount, DownloadCount: sh.DownloadCount, SaveCount: sh.SaveCount,
	}
	if withStatus {
		if r := s.driveShareInvalidReason(sh); r != "" {
			out.Status = "invalid"
			out.ValidMsg = r
		} else {
			out.Status = "valid"
		}
	}
	return out
}

// driveShareCardEnvelope 分享卡片消息信封归口（聊天气泡数据源，92 帧与历史渲染共用结构）
func driveShareCardEnvelope(sh *model.DriveShare, fromName string) string {
	card, _ := json.Marshal(map[string]interface{}{
		"share": map[string]interface{}{
			"id": sh.ID, "code": sh.ShareCode, "name": sh.FileName,
			"is_dir": sh.IsDir, "size": sh.Size, "from": sh.Owner,
			"has_extract": sh.ExtractCode != "", "expire_at": sh.ExpireAt,
			"from_name": fromName,
		},
	})
	return string(card)
}

// driveShareCreateReq 创建分享请求体
type driveShareCreateReq struct {
	Username   string   `json:"username"`
	FileID     uint     `json:"file_id"`
	ExpireDays int      `json:"expire_days"` // 0永久 / 1 / 7 / 30
	WithCode   bool     `json:"with_code"`   // 链接模式是否需要提取码
	ToUsers    []string `json:"to_users"`    // 发给好友（用户名列表，可空）
	ToGroups   []string `json:"to_groups"`   // 发给群（'gN' 编码列表，可空）
}

// handleDriveShareCreate 创建分享 POST /api/drive/share/create
// 双模式合一：to_users/to_groups 任一非空则额外投递卡片消息（私聊双方/群成员定向）；
// 无论是否投递卡片都会生成分享记录（链接模式与卡片点击详情共用同一 share_code）
func (s *Server) handleDriveShareCreate(w http.ResponseWriter, r *http.Request) {
	var body driveShareCreateReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.FileID == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	rec, err := s.driveOwnFile(body.FileID, body.Username)
	if err != nil {
		driveFail(w, http.StatusNotFound, "文件不存在")
		return
	}
	// 有效期白名单（服务端归口：0永久/1/7/30，其余一律拒绝）
	if body.ExpireDays != 0 && body.ExpireDays != 1 && body.ExpireDays != 7 && body.ExpireDays != 30 {
		driveFail(w, http.StatusBadRequest, "有效期仅支持 永久/1天/7天/30天")
		return
	}
	sh := model.DriveShare{
		ShareCode: driveGenShareCode(),
		Owner:     body.Username,
		FileID:    rec.ID,
		FileName:  rec.Name,
		IsDir:     rec.IsDir,
		Size:      rec.Size,
		ExpireAt:  0,
		Canceled:  false,
	}
	if body.ExpireDays > 0 {
		sh.ExpireAt = time.Now().AddDate(0, 0, body.ExpireDays).Unix()
	}
	if body.WithCode {
		sh.ExtractCode = driveGenExtract()
	}
	if err := store.DB.Create(&sh).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "分享创建失败")
		return
	}

	// 卡片投递（服务端归口构造 92 信封，与红包同链路：落库+转发+离线入队+会话摘要）
	delivered := 0
	if len(body.ToUsers) > 0 || len(body.ToGroups) > 0 {
		delivered = s.deliverDriveShareCards(&sh, body.Username, body.ToUsers, body.ToGroups)
	}

	logger.Info("网盘分享创建: %s file=%d(%s) code=%s 有效期=%d天 提取码=%v 投递=%d",
		body.Username, rec.ID, rec.Name, sh.ShareCode, body.ExpireDays, body.WithCode, delivered)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"share":        driveShareToClient(s, &sh, false),
		"extract_code": sh.ExtractCode, // 链接模式回显提取码（仅创建者本人一次性可见，详情接口不回传）
		"url":          "/s/" + sh.ShareCode,
		"delivered":    delivered,
	})
}

// deliverDriveShareCards 卡片投递归口（私聊=双方推送；群=成员定向广播）；返回成功投递的会话数
func (s *Server) deliverDriveShareCards(sh *model.DriveShare, owner string, toUsers, toGroups []string) int {
	fromName := nicknameOf(owner)
	envelope := driveShareCardEnvelope(sh, fromName)
	summary := "[网盘分享] " + sh.FileName
	count := 0

	for _, target := range toUsers {
		target = strings.TrimSpace(target)
		// 收件人校验归口：非自己 / 真实存在 / 双方互不拉黑（AI 智能体不是好友关系天然不会出现在选人列表）
		if target == "" || target == owner {
			continue
		}
		var cnt int64
		store.DB.Model(&model.User{}).Where("username = ?", target).Count(&cnt)
		if cnt == 0 || s.isBlocked(owner, target) {
			continue
		}
		chatMsg := protocol.Message{
			MsgType: protocol.MsgTypeDriveShare, FromUser: owner, FromName: fromName,
			ToUser: target, Content: envelope, Timestamp: time.Now().Unix(),
		}
		record := model.Message{MsgType: int8(protocol.MsgTypeDriveShare), FromUser: owner, ToUser: target, Content: envelope}
		if err := store.DB.Create(&record).Error; err != nil {
			logger.Error("网盘分享卡片落库失败（%s -> %s）：%v", owner, target, err)
			continue
		}
		chatMsg.MsgID = record.ID
		data, _ := json.Marshal(chatMsg)
		if s.hub.Count(target) > 0 {
			s.sendToUser(target, data)
		} else if !s.isOnline(target) {
			s.queueOffline(target, &chatMsg)
		}
		s.sendToUser(owner, data) // 自己多端同步（与私聊消息回显同口径）
		s.touchConversation(owner, target, summary)
		s.touchConversation(target, owner, summary)
		s.notifyConvUpdate(owner)
		s.notifyConvUpdate(target)
		count++
	}

	for _, g := range toGroups {
		gid, ok := isGroupTarget(strings.TrimSpace(g))
		if !ok || !isGroupMember(gid, owner) {
			continue
		}
		chatMsg := protocol.Message{
			MsgType: protocol.MsgTypeDriveShare, FromUser: owner, FromName: fromName,
			ToUser: "g" + strconv.FormatUint(uint64(gid), 10), Content: envelope, Timestamp: time.Now().Unix(),
		}
		record := model.Message{MsgType: int8(protocol.MsgTypeDriveShare), FromUser: owner, ToUser: chatMsg.ToUser, Content: envelope}
		if err := store.DB.Create(&record).Error; err != nil {
			logger.Error("网盘分享群卡片落库失败（%s -> 群%d）：%v", owner, gid, err)
			continue
		}
		chatMsg.MsgID = record.ID
		data, _ := json.Marshal(chatMsg)
		memberIDs := getGroupMemberIDs(gid)
		s.sendToGroupMembers(memberIDs, data)
		for _, name := range memberIDs {
			if name != owner && !s.isOnline(name) {
				s.queueOffline(name, &chatMsg)
			}
			if s.isOnline(name) {
				s.touchConversation(name, chatMsg.ToUser, summary)
				s.notifyConvUpdate(name)
			}
		}
		count++
	}
	return count
}

// handleDriveShareList 我发出的分享 GET /api/drive/share/list?username=xxx
// 状态服务端归口计算（valid/invalid + 失效原因），按创建时间倒序，上限 200 条
func (s *Server) handleDriveShareList(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	var shares []model.DriveShare
	if err := store.DB.Where("owner = ?", username).Order("create_time DESC").Limit(200).Find(&shares).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	out := make([]driveShareClient, 0, len(shares))
	for i := range shares {
		out = append(out, driveShareToClient(s, &shares[i], true))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": out})
}

// handleDriveShareCancel 取消分享 POST /api/drive/share/cancel {username,id}
// 软删除（Canceled=true）：链接与已投递卡片点击详情立即失效，管理列表保留留痕
// （不自动清理，分享者可在分享管理里对已取消记录手动删除，见 handleDriveShareDelete）
func (s *Server) handleDriveShareCancel(w http.ResponseWriter, r *http.Request) {
	var body driveItemReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.ID == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	var sh model.DriveShare
	if err := store.DB.Where("id = ? AND owner = ?", body.ID, body.Username).First(&sh).Error; err != nil {
		driveFail(w, http.StatusNotFound, "分享不存在")
		return
	}
	store.DB.Model(&sh).Update("canceled", true)
	logger.Info("网盘分享取消: %s share=%d code=%s", body.Username, sh.ID, sh.ShareCode)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
}

// handleDriveShareDelete 删除失效分享的留痕记录 POST /api/drive/share/delete {username,id}
// 仅允许删除已失效记录（已取消/已过期/源文件已删除——分享已永久不可用，留痕失去意义）；
// 生效中的分享不支持删（须先取消）。物理删除 im_drive_share 行，纯记录操作——
// 源文件、副本引用、对象存储分毫不动
func (s *Server) handleDriveShareDelete(w http.ResponseWriter, r *http.Request) {
	var body driveItemReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" || body.ID == 0 {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	var sh model.DriveShare
	if err := store.DB.Where("id = ? AND owner = ?", body.ID, body.Username).First(&sh).Error; err != nil {
		driveFail(w, http.StatusNotFound, "分享不存在")
		return
	}
	if r := s.driveShareInvalidReason(&sh); r == "" {
		driveFail(w, http.StatusBadRequest, "分享生效中，请先取消分享后再删除记录")
		return
	}
	if err := store.DB.Delete(&sh).Error; err != nil {
		driveFail(w, http.StatusInternalServerError, "删除失败")
		return
	}
	logger.Info("网盘分享记录删除: %s share=%d code=%s", body.Username, sh.ID, sh.ShareCode)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
}

// driveShareLoadAndCheck 分享访问凭据校验归口（详情/保存/下载共用）：
// 按 share_code 查记录 → 有效性三态校验 → 提取码校验（need=true 表示前端应弹出输入框）；
// 提取码防暴力归口接入（同一 IP 同一 code 连续错 5 次锁 10 分钟，成功清零）；
// 返回 (分享记录, 错误文本, HTTP 状态码, 需要提取码)
// 原签名：func (s *Server) driveShareLoadAndCheck(code, extract string) (*model.DriveShare, string, int, bool)
func (s *Server) driveShareLoadAndCheck(r *http.Request, code, extract string) (*model.DriveShare, string, int, bool) {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 40 {
		return nil, "分享不存在或已失效", http.StatusNotFound, false
	}
	var sh model.DriveShare
	if err := store.DB.Where("share_code = ?", code).First(&sh).Error; err != nil {
		return nil, "分享不存在或已失效", http.StatusNotFound, false
	}
	if reason := s.driveShareInvalidReason(&sh); reason != "" {
		return nil, reason, http.StatusForbidden, false
	}
	if sh.ExtractCode != "" {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		// 锁定内直接拒绝（不比对提取码，防绕过计数继续枚举）；need=true 让前端输入行展示原因
		if driveShareExtractLocked(code, ip) {
			return nil, "提取码错误次数过多，请稍后再试", http.StatusTooManyRequests, true
		}
		if strings.TrimSpace(extract) == "" {
			return nil, "请输入提取码", http.StatusUnauthorized, true
		}
		// 提取码比对不区分大小写（百度网盘同款语义，用户输入 8zkl/8ZKL 均应通过）
		// if strings.TrimSpace(extract) != sh.ExtractCode {
		if !strings.EqualFold(strings.TrimSpace(extract), sh.ExtractCode) {
			driveShareExtractFail(code, ip)
			return nil, "提取码错误", http.StatusUnauthorized, true
		}
		driveShareExtractReset(code, ip)
	}
	return &sh, "", 0, false
}

// handleDriveShareInfo 分享详情 GET /api/drive/share/info?code=xxx&extract=yyyy
// 凭 分享码+提取码 访问（无需登录态，百度网盘同款链接语义）；仅回卡片展示字段，不泄露路径
func (s *Server) handleDriveShareInfo(w http.ResponseWriter, r *http.Request) {
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r, r.URL.Query().Get("code"), r.URL.Query().Get("extract"))
	if errMsg != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": errMsg, "need_extract": need})
		return
	}
	// 浏览计数归口：info 成功查看即 +1（提取码分享需通过提取码后才会走到这里；响应即含本次，打开页立见）
	driveShareBump(sh.ID, "view_count")
	sh.ViewCount++ // bump 只落库，内存快照同步 +1 保证响应即含本次
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"share": driveShareToClient(s, sh, false)})
}

// driveShareInSubtree 判断 fid 是否位于分享根 rootID 的子树内（防越权枚举兄弟目录）：
// 从 fid 沿 parent 链向上走（限深 32 与 BFS 同款防环），每步限定 owner（他人目录视为不存在）；
// 中间节点被软删级联时查询为空直接 false（天然容错，无需区分删除与越权）
func (s *Server) driveShareInSubtree(rootID, fid uint, owner string) bool {
	cur := fid
	for i := 0; i < 32 && cur > 0; i++ {
		if cur == rootID {
			return true
		}
		var rec model.DriveFile
		if err := store.DB.Where("id = ? AND owner = ?", cur, owner).First(&rec).Error; err != nil {
			return false
		}
		cur = rec.ParentID
	}
	return false
}

// driveShareNode 子树收集节点：rec 为源记录；parentID 仅顶层节点使用（落库挂新父），
// 子节点 parentID=0，落库时经 idMap 按 BFS 序挂接；depth 用于限深防环与顶层判定
type driveShareNode struct {
	rec      model.DriveFile
	parentID uint
	depth    int
}

// driveShareCollectSubtree BFS 收集 root 子树（限深 32 防环、上限 maxNodes 防滥用），
// 返回（先父后子的落库序列, 文件字节总量——目录不计容，配额校验归口）
func (s *Server) driveShareCollectSubtree(owner string, root model.DriveFile, rootParentID uint, maxNodes int) ([]driveShareNode, int64) {
	subtree := []driveShareNode{}
	frontier := []driveShareNode{{rec: root, parentID: rootParentID, depth: 0}}
	seen := map[uint]bool{}
	total := int64(0)
	for len(frontier) > 0 && len(subtree) < maxNodes {
		cur := frontier[0]
		frontier = frontier[1:]
		if seen[cur.rec.ID] || cur.depth > 32 {
			continue
		}
		seen[cur.rec.ID] = true
		subtree = append(subtree, cur)
		if !cur.rec.IsDir {
			total += cur.rec.Size
		} else {
			var children []model.DriveFile
			store.DB.Where("owner = ? AND parent_id = ?", owner, cur.rec.ID).Find(&children)
			for _, c := range children {
				frontier = append(frontier, driveShareNode{rec: c, parentID: 0, depth: cur.depth + 1}) // parent 落库时按新树挂接
			}
		}
	}
	return subtree, total
}

// handleDriveShareChildren 分享内容浏览 GET /api/drive/share/children?code=xxx&extract=yyyy&fid=0
// 凭 分享码+提取码 浏览分享子树（123 云盘同款文件夹展开语义）：fid=0 取分享根——
// 根为文件时返回单行列表，根为目录时返回其子项；fid>0 须位于分享子树内（driveShareInSubtree
// 沿 parent 链校验，防越权枚举分享范围外的兄弟目录）且必须是目录。
// 仅回展示字段，不泄露 object_key/owner/md5；浏览不 bump view_count（info 归口）
func (s *Server) handleDriveShareChildren(w http.ResponseWriter, r *http.Request) {
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r, r.URL.Query().Get("code"), r.URL.Query().Get("extract"))
	if errMsg != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": errMsg, "need_extract": need})
		return
	}
	fid, _ := strconv.ParseUint(r.URL.Query().Get("fid"), 10, 64)
	var dirID uint
	if fid == 0 {
		root, err := s.driveOwnFile(sh.FileID, sh.Owner)
		if err != nil {
			driveFail(w, http.StatusForbidden, "文件已被删除")
			return
		}
		if !root.IsDir {
			// 分享根为文件：单行列表（前端直接渲染为可勾选的一行）
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"items": []map[string]interface{}{{
				"id": root.ID, "name": root.Name, "is_dir": false,
				"size": root.Size, "mime_type": root.MimeType, "update_time": root.UpdateTime,
			}}})
			return
		}
		dirID = root.ID
	} else {
		rec, err := s.driveOwnFile(uint(fid), sh.Owner)
		if err != nil || !s.driveShareInSubtree(sh.FileID, rec.ID, sh.Owner) {
			driveFail(w, http.StatusForbidden, "无权访问该目录")
			return
		}
		if !rec.IsDir {
			driveFail(w, http.StatusBadRequest, "该文件不支持展开浏览")
			return
		}
		dirID = rec.ID
	}
	// 子项排序与本人网盘列表同款：文件夹在前，名称升序
	var list []model.DriveFile
	store.DB.Where("owner = ? AND parent_id = ?", sh.Owner, dirID).Order("is_dir DESC, name ASC").Find(&list)
	items := make([]map[string]interface{}, 0, len(list))
	for _, f := range list {
		items = append(items, map[string]interface{}{
			"id": f.ID, "name": f.Name, "is_dir": f.IsDir,
			"size": f.Size, "mime_type": f.MimeType, "update_time": f.UpdateTime,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"items": items})
}

// handleDriveShareSave 保存到我的网盘 POST /api/drive/share/save {username,code,extract,parent_id,items}
// 零拷贝归口：文件=单条元数据记录指向同一 object_key；目录=整棵子树记录复制（本体零复制）；
// items 为空=整树保存（旧语义向后兼容），items 非空=勾选批量保存（123 云盘同款：逐项子树
// 归属校验防越权，祖先目录已勾选时冗余后代自动跳过随祖先整体保存）；
// 配额校验/同名拦截/父目录归属全部服务端归口
func (s *Server) handleDriveShareSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Code     string `json:"code"`
		Extract  string `json:"extract"`
		ParentID uint   `json:"parent_id"`
		Items    []uint `json:"items"` // 勾选批量保存（空=整树保存）
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r, body.Code, body.Extract)
	if errMsg != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": errMsg, "need_extract": need})
		return
	}
	src, err := s.driveOwnFile(sh.FileID, sh.Owner)
	if err != nil {
		driveFail(w, http.StatusForbidden, "文件已被删除")
		return
	}
	// 父目录归属校验（0=我的文件根目录）
	if body.ParentID > 0 {
		if _, err := s.driveOwnFile(body.ParentID, body.Username); err != nil {
			driveFail(w, http.StatusNotFound, "目标目录不存在")
			return
		}
	}
	// BFS 收集待保存子树（限深 32 防环、上限 1 万节点），配额校验归口（目录不计容）
	var subtree []driveShareNode
	total := int64(0)
	if len(body.Items) == 0 {
		subtree, total = s.driveShareCollectSubtree(sh.Owner, *src, body.ParentID, 10000)
	} else {
		// 勾选批量保存：去重+上限 500，逐项校验归属（越权/已删除整批拒绝，防半保存态）
		sel := map[uint]bool{}
		items := make([]uint, 0, len(body.Items))
		for _, id := range body.Items {
			if id > 0 && !sel[id] && len(items) < 500 {
				sel[id] = true
				items = append(items, id)
			}
		}
		recs := make(map[uint]model.DriveFile, len(items))
		for _, id := range items {
			rec, err := s.driveOwnFile(id, sh.Owner)
			if err != nil || !s.driveShareInSubtree(sh.FileID, id, sh.Owner) {
				driveFail(w, http.StatusForbidden, "所选文件已不在分享范围内")
				return
			}
			recs[id] = *rec
		}
		// 冗余跳过：祖先目录已被勾选时，其子树随祖先整体保存，后代不再重复收集
		tops := make([]uint, 0, len(items))
		for _, id := range items {
			redundant := false
			for cur, i := recs[id].ParentID, 0; i < 32 && cur > 0 && cur != sh.FileID; i++ {
				if sel[cur] {
					redundant = true
					break
				}
				var p model.DriveFile
				if err := store.DB.Where("id = ? AND owner = ?", cur, sh.Owner).First(&p).Error; err != nil {
					break
				}
				cur = p.ParentID
			}
			if !redundant {
				tops = append(tops, id)
			}
		}
		if len(tops) == 0 {
			driveFail(w, http.StatusBadRequest, "请选择要保存的文件")
			return
		}
		subtree = []driveShareNode{}
		for _, id := range tops {
			ns, t := s.driveShareCollectSubtree(sh.Owner, recs[id], body.ParentID, 10000-len(subtree))
			subtree = append(subtree, ns...)
			total += t
		}
	}
	if quota := s.cfg.Drive.QuotaBytes; quota >= 0 {
		var used struct{ Total int64 }
		store.DB.Model(&model.DriveFile{}).Select("COALESCE(SUM(size),0) AS total").
			Where("owner = ? AND is_dir = ?", body.Username, false).Scan(&used)
		if used.Total+total > quota {
			driveFail(w, http.StatusRequestEntityTooLarge, "网盘空间不足，无法保存")
			return
		}
	}
	// 顶层同名拦截（勾选模式对每个顶层项逐一校验，同批重名一并拒绝；
	// 子树内部结构原样复制，不会产生新冲突）
	seenTop := map[string]bool{}
	for _, n := range subtree {
		if n.depth != 0 {
			continue
		}
		if seenTop[n.rec.Name] {
			driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
			return
		}
		seenTop[n.rec.Name] = true
		var cnt int64
		store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
			body.Username, body.ParentID, n.rec.Name).Count(&cnt)
		if cnt > 0 {
			driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
			return
		}
	}
	// 按收集顺序落库（BFS 先父后子）：新记录 id 回填映射，子节点挂新父
	idMap := map[uint]uint{}
	saved := 0
	for _, n := range subtree {
		newParent := n.parentID
		if n.depth > 0 {
			newParent = idMap[n.rec.ParentID] // BFS 序保证父已落库
		}
		rec := model.DriveFile{
			Owner: body.Username, ParentID: newParent, Name: n.rec.Name,
			IsDir: n.rec.IsDir, Size: n.rec.Size, ObjectKey: n.rec.ObjectKey, MimeType: n.rec.MimeType,
		}
		if err := store.DB.Create(&rec).Error; err != nil {
			logger.Error("网盘分享保存落库失败（%s <- %s code=%s）：%v", body.Username, sh.Owner, sh.ShareCode, err)
			continue
		}
		idMap[n.rec.ID] = rec.ID
		saved++
	}
	logger.Info("网盘分享保存: %s <- %s code=%s, 保存 %d 项 (parent=%d, items=%d)", body.Username, sh.Owner, sh.ShareCode, saved, body.ParentID, len(body.Items))
	driveShareBump(sh.ID, "save_count") // 保存计数归口：成功保存即 +1（按动作计，条目数另由 saved 体现）
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"saved": saved})
}

// handleDriveShareDownload 分享下载 GET /api/drive/share/download?code=xxx&extract=yyyy&fid=0
// 校验分享有效后复用 serveDriveFile 下发链路（MinIO 302 预签名 / 本地流式，与本人下载同款）；
// fid=0 下载分享根（原语义），fid>0 下载分享子树内勾选的单文件（须 driveShareInSubtree
// 归属校验，防越权枚举分享范围外文件）；计数键含文件 ID，多文件各自独立去重窗口
func (s *Server) handleDriveShareDownload(w http.ResponseWriter, r *http.Request) {
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r, r.URL.Query().Get("code"), r.URL.Query().Get("extract"))
	if errMsg != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": errMsg, "need_extract": need})
		return
	}
	rec, err := s.driveOwnFile(sh.FileID, sh.Owner)
	if err != nil {
		http.Error(w, "文件已被删除", http.StatusForbidden)
		return
	}
	// fid>0：文件夹分享内勾选的单文件下载（须位于分享子树内；403 不区分越权与不存在，不泄露枚举信息）
	if fidStr := r.URL.Query().Get("fid"); fidStr != "" && fidStr != "0" {
		if fid, perr := strconv.ParseUint(fidStr, 10, 64); perr == nil && fid > 0 {
			sub, serr := s.driveOwnFile(uint(fid), sh.Owner)
			if serr != nil || !s.driveShareInSubtree(sh.FileID, sub.ID, sh.Owner) {
				http.Error(w, "无权访问该文件", http.StatusForbidden)
				return
			}
			rec = sub
		}
	}
	if rec.IsDir {
		http.Error(w, "文件夹不支持下载", http.StatusBadRequest)
		return
	}
	// preview=1 时以 inline 方式下发（分享页在线预览：img/video/pdf/文本标签内联渲染）
	if r.URL.Query().Get("preview") == "1" {
		s.serveDriveFile(w, r, rec, true)
		return
	}
	// 下载计数归口：非预览成功下发 +1；60 秒同 code|ip|文件 去重（Range 分片/断点续传不虚增，
	// 勾选批量下载时每个文件各自计数，窗口互不挤占）
	ip := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = h
	}
	dlKey := sh.ShareCode + "|" + strconv.FormatUint(uint64(rec.ID), 10)
	if driveShareDlShouldCount(dlKey, ip) {
		driveShareBump(sh.ID, "download_count")
	}
	s.serveDriveFile(w, r, rec, false)
}
