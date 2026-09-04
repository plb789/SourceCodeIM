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
	URL  string `json:"url"`  // 静态资源 URL（/static/upload/xxx）
	Name string `json:"name"` // 原始文件名
	Size int64  `json:"size"` // 文件大小（字节）
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
func (s *Server) HandleFileUpload(w http.ResponseWriter, r *http.Request) {
	fileID := r.URL.Query().Get("file_id")
	username := r.URL.Query().Get("username")
	if fileID == "" || username == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
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
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = "../im-client/web/static/upload"
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
