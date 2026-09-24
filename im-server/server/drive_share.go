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
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// RegisterDriveShareRoutes 注册网盘分享路由（main.go 调用归口；Go 1.22+ 方法+路径模式）
func RegisterDriveShareRoutes(s *Server) {
	http.HandleFunc("POST /api/drive/share/create", s.handleDriveShareCreate)
	http.HandleFunc("GET /api/drive/share/list", s.guardDrive(s.handleDriveShareList))
	http.HandleFunc("POST /api/drive/share/cancel", s.handleDriveShareCancel)
	http.HandleFunc("GET /api/drive/share/info", s.handleDriveShareInfo)
	http.HandleFunc("POST /api/drive/share/save", s.handleDriveShareSave)
	http.HandleFunc("GET /api/drive/share/download", s.handleDriveShareDownload)
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
}

func driveShareToClient(s *Server, sh *model.DriveShare, withStatus bool) driveShareClient {
	out := driveShareClient{
		ID: sh.ID, Code: sh.ShareCode, FileName: sh.FileName, IsDir: sh.IsDir,
		Size: sh.Size, From: sh.Owner, HasCode: sh.ExtractCode != "",
		ExpireAt:  sh.ExpireAt,
		ShareLink: "/s/" + sh.ShareCode,
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

// driveShareLoadAndCheck 分享访问凭据校验归口（详情/保存/下载共用）：
// 按 share_code 查记录 → 有效性三态校验 → 提取码校验（need=true 表示前端应弹出输入框）；
// 返回 (分享记录, 错误文本, HTTP 状态码, 需要提取码)
func (s *Server) driveShareLoadAndCheck(code, extract string) (*model.DriveShare, string, int, bool) {
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
		if strings.TrimSpace(extract) == "" {
			return nil, "请输入提取码", http.StatusUnauthorized, true
		}
		// 提取码比对不区分大小写（百度网盘同款语义，用户输入 8zkl/8ZKL 均应通过）
		// if strings.TrimSpace(extract) != sh.ExtractCode {
		if !strings.EqualFold(strings.TrimSpace(extract), sh.ExtractCode) {
			return nil, "提取码错误", http.StatusUnauthorized, true
		}
	}
	return &sh, "", 0, false
}

// handleDriveShareInfo 分享详情 GET /api/drive/share/info?code=xxx&extract=yyyy
// 凭 分享码+提取码 访问（无需登录态，百度网盘同款链接语义）；仅回卡片展示字段，不泄露路径
func (s *Server) handleDriveShareInfo(w http.ResponseWriter, r *http.Request) {
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r.URL.Query().Get("code"), r.URL.Query().Get("extract"))
	if errMsg != "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{"error": errMsg, "need_extract": need})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"share": driveShareToClient(s, sh, false)})
}

// handleDriveShareSave 保存到我的网盘 POST /api/drive/share/save {username,code,extract,parent_id}
// 零拷贝归口：文件=单条元数据记录指向同一 object_key；目录=整棵子树记录复制（本体零复制）；
// 配额校验/同名拦截/父目录归属全部服务端归口
func (s *Server) handleDriveShareSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Code     string `json:"code"`
		Extract  string `json:"extract"`
		ParentID uint   `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
		driveFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if msg := s.driveCheckUser(body.Username); msg != "" {
		driveFail(w, http.StatusUnauthorized, msg)
		return
	}
	sh, errMsg, code, need := s.driveShareLoadAndCheck(body.Code, body.Extract)
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
	// BFS 先收集子树（限深 32 防环），配额校验归口（目录不计容）
	type node struct {
		rec      model.DriveFile
		parentID uint
		depth    int
	}
	subtree := []node{}
	frontier := []node{{rec: *src, parentID: body.ParentID, depth: 0}}
	seen := map[uint]bool{}
	total := int64(0)
	for len(frontier) > 0 && len(subtree) < 10000 {
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
			store.DB.Where("owner = ? AND parent_id = ?", src.Owner, cur.rec.ID).Find(&children)
			for _, c := range children {
				frontier = append(frontier, node{rec: c, parentID: 0, depth: cur.depth + 1}) // parent 落库时按新树挂接
			}
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
	// 根节点同名拦截（子树内部结构原样复制，不会产生新冲突）
	var cnt int64
	store.DB.Model(&model.DriveFile{}).Where("owner = ? AND parent_id = ? AND name = ?",
		body.Username, body.ParentID, src.Name).Count(&cnt)
	if cnt > 0 {
		driveFail(w, http.StatusConflict, "同名文件或文件夹已存在")
		return
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
	logger.Info("网盘分享保存: %s <- %s code=%s, 保存 %d 项 (parent=%d)", body.Username, sh.Owner, sh.ShareCode, saved, body.ParentID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"saved": saved})
}

// handleDriveShareDownload 分享下载 GET /api/drive/share/download?code=xxx&extract=yyyy
// 校验分享有效后复用 serveDriveFile 下发链路（MinIO 302 预签名 / 本地流式，与本人下载同款）
func (s *Server) handleDriveShareDownload(w http.ResponseWriter, r *http.Request) {
	sh, errMsg, code, need := s.driveShareLoadAndCheck(r.URL.Query().Get("code"), r.URL.Query().Get("extract"))
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
	if rec.IsDir {
		http.Error(w, "文件夹不支持下载", http.StatusBadRequest)
		return
	}
	s.serveDriveFile(w, r, rec)
}
