package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段二十四：图片/文件消息持久化
// 存储侧消息类型（im_message.msg_type，与文字消息的 1群聊/2私聊 同命名空间，与 WebSocket 协议常量无关）
const (
	MsgTypeImageSaved = 4 // 图片消息（content 为 JSON：url/name/size）
	MsgTypeFileSaved  = 5 // 文件消息（content 为 JSON：url/name/size）
)

// persistedMsgContent 持久化消息的 content 结构
type persistedMsgContent struct {
	URL   string `json:"url"`             // 静态资源 URL（/static/upload/xxx）
	Name  string `json:"name"`            // 原始文件名
	Size  int64  `json:"size"`            // 文件大小（字节）
	Nonce string `json:"nonce,omitempty"` // 阶段二十六：客户端本地气泡标识（仅群聊图片携带，广播回填 msg_id 时精确匹配，历史渲染忽略）
}

// isImageExt 判断扩展名是否为图片（图片落库为图片消息，其余为文件消息）
func isImageExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return true
	}
	return false
}

// HandleFileUpload 处理聊天文件持久化上传：POST /upload/file?file_id=xxx&username=yyy
// 流程：校验请求者身份 → 幂等检查（status==3 直接返回已有消息）→ 保存文件 → 落库 im_message
// → 回写 im_file（status=3 + msg_id + file_path）→ 更新双方会话摘要为 [图片]/[文件]
// 阶段三十一：file_id 为空时走大文件直传模式（handleDirectUpload），HTTP 先行落库，WebSocket 仅传信令
func (s *Server) HandleFileUpload(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("file_id")
	username := r.URL.Query().Get("username")
	// 原实现：if fileID == "" || username == "" → 400（必须先经分片文件头换取 file_id）
	if username == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	// 阶段三十一：直传模式分流（大文件绕开分片链路，避免海量分片占用 WebSocket 连接与 Redis）
	if fileID == "" {
		s.handleDirectUpload(w, r, username)
		return
	}

	// 查询文件传输记录并校验请求者身份（仅发送方或接收方可回传）
	var rec model.FileRecord
	if err := store.DB.First(&rec, fileID).Error; err != nil {
		http.Error(w, "文件记录不存在", http.StatusNotFound)
		return
	}
	if username != rec.FromUser && username != rec.ToUser {
		http.Error(w, "无权操作该文件", http.StatusForbidden)
		return
	}

	// 幂等：该文件已持久化时直接返回已有消息，杜绝多端同时回传/重复请求造成重复落库
	// 以 MsgID 为权威依据（status 可能被分片完成判定覆盖，见 handleFileChunk 的条件更新）
	if rec.MsgID > 0 {
		var existed model.Message
		if err := store.DB.First(&existed, rec.MsgID).Error; err == nil {
			var meta persistedMsgContent
			json.Unmarshal([]byte(existed.Content), &meta)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"msg_id": existed.ID, "url": meta.URL, "file_id": fileID})
			return
		}
	}

	// 大小限制（读配置，缺省 20MB）
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 危险文件拦截（与分片传输同规则，双保险）
	if isDangerousFile(header.Filename) {
		http.Error(w, "禁止传输可执行文件", http.StatusBadRequest)
		logger.Warn("持久化拦截： %s 尝试上传危险文件 %s", username, header.Filename)
		return
	}

	// 存储目录（读配置，位于前端静态目录内，静态服务已托管，URL 可直接访问）
	// 原实现：dir = "../im-client/web/static/upload"（相对进程工作目录，从 bin 目录双击 exe 启动会失效）
	// 现改为基于配置 WebDir 推导兜底（config.Load 已保证 UploadDir 为锚定 exe 目录的绝对路径，此处仅防御）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}

	// 生成唯一文件名（时间戳+随机串，保留原扩展名；原始文件名以 im_file 记录为准）
	ext := strings.ToLower(filepath.Ext(rec.FileName))
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)

	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	out.Close()

	url := "/static/upload/" + filename

	// 落库消息：图片为图片消息(4)，其余为文件消息(5)；content 存 JSON（历史渲染直出 URL）
	contentBytes, _ := json.Marshal(persistedMsgContent{URL: url, Name: rec.FileName, Size: rec.FileSize})
	msgType := int8(MsgTypeFileSaved)
	if isImageExt(ext) {
		msgType = int8(MsgTypeImageSaved)
	}
	record := model.Message{
		MsgType:  msgType,
		FromUser: rec.FromUser,
		ToUser:   rec.ToUser,
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		http.Error(w, "消息落库失败", http.StatusInternalServerError)
		return
	}

	// 回写文件记录：已持久化状态 + 消息 ID + 存储路径
	store.DB.Model(&model.FileRecord{}).Where("id = ?", rec.ID).
		Updates(map[string]interface{}{"status": 3, "msg_id": record.ID, "file_path": url})

	// 更新双方会话摘要并推送（按类型显示 [图片]/[文件]，避免 URL 原文出现在会话列表）
	summary := "[文件]"
	if msgType == int8(MsgTypeImageSaved) {
		summary = "[图片]"
	}
	s.touchConversation(rec.FromUser, rec.ToUser, summary)
	s.touchConversation(rec.ToUser, rec.FromUser, summary)
	s.notifyConvUpdate(rec.FromUser)
	s.notifyConvUpdate(rec.ToUser)

	logger.Info("聊天文件持久化: fileID=%s -> 消息%d, %s (%d 字节), url=%s", fileID, record.ID, rec.FileName, rec.FileSize, url)

	// 持久化完成通知双方全部在线连接（携带 file_id + msg_id）：
	// 双方实时气泡按 file_id 精确回填 msg_id，撤回/删除/置顶能力与撤回提示替换气泡随之可用（多端同步）
	// 原实现：仅 HTTP 响应回传发送方（msg_id），接收方气泡无 msg_id，
	// 对方撤回图片/文件时接收方提示走兜底追加，原气泡残留聊天窗口
	notice, _ := json.Marshal(&protocol.Message{
		MsgType:  protocol.MsgTypeFilePersisted,
		FromUser: rec.FromUser,
		ToUser:   rec.ToUser,
		FileID:   fileID,
		MsgID:    record.ID,
	})
	s.sendToUser(rec.FromUser, notice)
	s.sendToUser(rec.ToUser, notice)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"msg_id": record.ID, "url": url, "file_id": fileID})
}

// handleDirectUpload 阶段三十一：大文件直传模式（HTTP 先行落库，WebSocket 仅传信令）
// 触发条件：file_id 为空（发送端跳过分片协议，文件大小超过 upload_threshold 时前端分流至此）
// 流程：在线校验 → 大小限制 → 危险文件/黑名单拦截 → 流式落盘 → 建档 im_file(status=3)
// → 落库 im_message（content 携带 url/name/size/nonce）→ 推送 FILE_PERSISTED 给双方全部在线连接
// 与分片路径差异：无分片进度，一次性完成；接收方按 content 直接渲染，发送端按 nonce 回填本地气泡
// 已知边界：file_id 为空无幂等锚点，HTTP 层重试（网络超时后重发）会产生重复记录，前端失败时不自动重试
func (s *Server) handleDirectUpload(w http.ResponseWriter, r *http.Request, username string) {
	toUser := r.URL.Query().Get("to_user")
	nonce := r.URL.Query().Get("nonce") // 发送端本地气泡标识：FILE_PERSISTED 回填 msg_id 时按 nonce 精确匹配
	if toUser == "" {
		http.Error(w, "缺少接收方参数", http.StatusBadRequest)
		return
	}
	// 在线校验（与群聊图片上传同水位：轻量活性锚点，防止离线/不存在用户名被冒用上传）
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		logger.Warn("大文件直传拒绝： %s 无活跃连接", username)
		return
	}
	// 黑名单拦截：与私聊文字消息同规则
	if s.isBlocked(username, toUser) {
		http.Error(w, "对方已将你拉黑或你已拉黑对方，无法发送", http.StatusForbidden)
		return
	}

	// 大小限制（读配置，缺省 20MB，与分片持久化同规则）
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 危险文件拦截（与分片传输同规则）
	if isDangerousFile(header.Filename) {
		http.Error(w, "禁止传输可执行文件", http.StatusBadRequest)
		logger.Warn("大文件直传拦截： %s 尝试上传危险文件 %s", username, header.Filename)
		return
	}

	// 存储目录（与分片持久化同规则：读配置，兜底基于 WebDir 推导）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)

	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	// 流式落盘：io.Copy 逐块写磁盘，不经全量内存缓冲（大文件内存友好）
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	out.Close()

	url := "/static/upload/" + filename

	// 建档 im_file：直传一次完成，直接置为已持久化状态 3
	rec := model.FileRecord{
		FileName: header.Filename,
		FileSize: header.Size,
		FilePath: url,
		FromUser: username,
		ToUser:   toUser,
		Status:   3,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		http.Error(w, "文件记录创建失败", http.StatusInternalServerError)
		return
	}
	fileID := strconv.FormatUint(uint64(rec.ID), 10)

	// 落库消息：图片为图片消息(4)，其余为文件消息(5)；nonce 写入 content 供发送端本地气泡回填
	contentBytes, _ := json.Marshal(persistedMsgContent{URL: url, Name: header.Filename, Size: header.Size, Nonce: nonce})
	msgType := int8(MsgTypeFileSaved)
	if isImageExt(ext) {
		msgType = int8(MsgTypeImageSaved)
	}
	record := model.Message{
		MsgType:  msgType,
		FromUser: username,
		ToUser:   toUser,
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		http.Error(w, "消息落库失败", http.StatusInternalServerError)
		return
	}
	// 回写文件记录消息 ID（与分片持久化路径对齐，撤回/置顶能力前提）
	store.DB.Model(&model.FileRecord{}).Where("id = ?", rec.ID).Update("msg_id", record.ID)

	// 更新双方会话摘要并推送（按类型显示 [图片]/[文件]）
	summary := "[文件]"
	if msgType == int8(MsgTypeImageSaved) {
		summary = "[图片]"
	}
	s.touchConversation(username, toUser, summary)
	s.touchConversation(toUser, username, summary)
	s.notifyConvUpdate(username)
	s.notifyConvUpdate(toUser)

	logger.Info("大文件直传: %s -> %s, 文件 %s (%d 字节), fileID=%s -> 消息%d, url=%s", username, toUser, header.Filename, header.Size, fileID, record.ID, url)

	// 持久化完成通知双方全部在线连接：携带 content（url/name/size/nonce）+ msg_id + file_id
	// 接收方按 content 直接渲染（原实现无此通道，接收方离线/无分片场景拿不到文件）
	// 发送端按 nonce 精确回填本地气泡 msg_id；离线用户经历史加载与 CONV_LIST 覆盖（消息已落库）
	notice, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeFilePersisted,
		FromUser:  username,
		ToUser:    toUser,
		Content:   string(contentBytes),
		FileID:    fileID,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, notice)
	s.sendToUser(toUser, notice)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"msg_id": record.ID, "url": url, "file_id": fileID})
}

// HandleGroupImageUpload 群聊图片上传：POST /upload/group/image?username=xxx&nonce=yyy（阶段二十六）
// 群聊不走分片协议（分片协议为点对点设计，im_file 为收发双方模型），改走 HTTP 上传：
// 校验图片格式 → 保存文件 → 落库 im_message（msg_type=4，ToUser 为空表示群聊）
// → 广播 MsgTypeGroupImage 给全部在线用户（含发送方多端同步）→ 离线用户入队 → 会话摘要更新
func (s *Server) HandleGroupImageUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	nonce := r.URL.Query().Get("nonce") // 客户端生成的本地气泡标识：广播回填 msg_id 时按 nonce 精确匹配，杜绝并发发送错位
	if username == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	// 在线校验（并发加固）：要求所声明用户存在活跃 WS 连接，防止离线/不存在用户名被冒用上传。
	// 完整身份防伪需 WS 下发上传令牌（当前与 /upload/avatar 信任 username 参数的鉴权水位一致，此处为轻量活性锚点）
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		logger.Warn("群聊图片上传拒绝： %s 无活跃连接", username)
		return
	}

	// 大小限制（读配置，缺省 20MB，与私聊文件传输同规则）
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 群聊仅支持图片：按扩展名校验，非图片直接拒绝
	if !isImageExt(filepath.Ext(header.Filename)) {
		http.Error(w, "群聊仅支持发送图片", http.StatusBadRequest)
		return
	}
	// 危险文件拦截（双保险，与分片传输同规则）
	if isDangerousFile(header.Filename) {
		http.Error(w, "禁止传输可执行文件", http.StatusBadRequest)
		logger.Warn("群聊图片拦截： %s 尝试上传危险文件 %s", username, header.Filename)
		return
	}

	// 存储目录（读配置，位于前端静态目录内，静态服务已托管，URL 可直接访问）
	// 原实现：dir = "../im-client/web/static/upload"（相对进程工作目录，从 bin 目录双击 exe 启动会失效）
	// 现改为基于配置 WebDir 推导兜底（config.Load 已保证 UploadDir 为锚定 exe 目录的绝对路径，此处仅防御）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}

	// 生成唯一文件名（时间戳+随机串，保留原扩展名；原始文件名存入消息 content）
	ext := strings.ToLower(filepath.Ext(header.Filename))
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)

	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	out.Close()

	url := "/static/upload/" + filename

	// 落库消息：msg_type=4 图片消息，ToUser 为空表示群聊（与群聊文字消息同命名空间）
	// nonce 写入 content 随广播下发：发送端本地气泡按 nonce 精确回填 msg_id（历史渲染不依赖该字段）
	contentBytes, _ := json.Marshal(persistedMsgContent{URL: url, Name: header.Filename, Size: header.Size, Nonce: nonce})
	record := model.Message{
		MsgType:  int8(MsgTypeImageSaved),
		FromUser: username,
		ToUser:   "",
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		http.Error(w, "消息落库失败", http.StatusInternalServerError)
		return
	}

	// 广播群聊图片消息给全部在线用户（含发送方，多端同步；发送端本地气泡按 nonce 精确回填 msg_id）
	notice := &protocol.Message{
		MsgType:   protocol.MsgTypeGroupImage,
		FromUser:  username,
		ToUser:    "",
		Content:   string(contentBytes),
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	s.hub.Broadcast(data)

	// 群聊离线消息：给所有离线的注册用户入队（与群聊文字消息行为一致）
	var usernames []string
	if err := store.DB.Model(&model.User{}).Pluck("username", &usernames).Error; err == nil {
		for _, name := range usernames {
			if name != username && !s.isOnline(name) {
				s.queueOffline(name, notice)
			}
		}
	}

	// 更新所有在线用户的群聊会话摘要为 [图片] 并推送（离线用户登录时 ensureGroupConv 兜底存在）
	for _, name := range s.hub.Usernames() {
		s.touchConversation(name, "", "[图片]")
		s.notifyConvUpdate(name)
	}

	logger.Info("群聊图片消息: %s 上传 %s (%d 字节) -> 消息%d, url=%s", username, header.Filename, header.Size, record.ID, url)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"msg_id": record.ID, "url": url})
}

// HandleAIImageUpload 阶段四十四：AI 图片提问专用上传 POST /upload/ai/image?username=xxx&to_user=助手名
// 与私聊/群聊图片上传的差异：不落库 im_message、不触会话摘要——提问正文由随后的 AI_CHAT 图片信封
// 消息统一落库（单条记录同时承载图片与附言，历史/多端同步/会话摘要全走既有归口，避免重复气泡）。
// 流程：在线校验 → 智能体图片能力校验（双保险，前端入口已按能力显隐）→ 图片格式校验 → 落盘 → 返回 {url}
func (s *Server) HandleAIImageUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	toAgent := r.URL.Query().Get("to_user")
	if username == "" || toAgent == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		return
	}
	// 能力校验：不给不支持图片的智能体上传（配置归口，与 AI_CHAT 处理器同一判定口径）
	agent := aiAgentByName(toAgent)
	if agent == nil {
		http.Error(w, "AI 助手不存在", http.StatusBadRequest)
		return
	}
	if agent.Provider == nil || !agent.SupportsImage {
		http.Error(w, "该助手不支持图片识别", http.StatusForbidden)
		return
	}

	// 大小限制（与聊天文件同规则，读配置缺省 20MB）
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 仅允许图片格式（多模态接口同样只认图片）
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !isImageExt(ext) {
		http.Error(w, "仅支持发送图片文件", http.StatusBadRequest)
		return
	}

	// 存储目录归口（与直传一致：UploadDir 配置优先，兜底 WebDir/static/upload）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	out.Close()

	url := "/static/upload/" + filename
	logger.Info("AI 图片提问上传: %s -> %s, %s (%d 字节), url=%s", username, toAgent, header.Filename, header.Size, url)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"url": url})
}
