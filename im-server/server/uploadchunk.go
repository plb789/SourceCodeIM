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
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段三十二：超大文件分片直传（>20MB 至 2GB）
// 背景：单请求直传受 max_file_size（20MB）限制且 fetch 无上传进度；超大文件按片 HTTP 上传可回显进度，
// 服务端节流推送接收方"发送中 xx%"（微信同款体验），海量分片不经 WebSocket 避免挤占连接队列与 Redis
// 链路：发送方逐片 POST /upload/chunk（raw body）→ 服务端按片落盘临时目录 → 收齐合并落库
// → 推送 FILE_PERSISTED（复用阶段二十四/三十一归口模式）→ 双端进度气泡替换为正式文件卡片

// uploadSessionTimeout 分片直传会话超时：超过该时间未收齐视为废弃（懒清理，不启用定时器避免资源泛滥）
const uploadSessionTimeout = 30 * time.Minute

// progressPushInterval 进度推送节流间隔：单会话最快 500ms 一条 FILE_PROGRESS，避免信令风暴
const progressPushInterval = 500 * time.Millisecond

// directUploadSession 分片直传会话（仅内存：重启丢失即重传，不落库不进 Redis，避免超大文件高频写）
type directUploadSession struct {
	UploadID    string        // 会话唯一标识（发送方生成）
	FromUser    string        // 发送方
	ToUser      string        // 接收方（群聊为空字符串）
	Nonce       string        // 发送端本地气泡标识（FILE_PERSISTED 回填 msg_id 时精确匹配）
	FileName    string        // 原始文件名
	FileSize    int64         // 文件总字节数
	TotalChunks int           // 总片数
	ChunkSize   int64         // 单片大小（服务端配置下发）
	Received    map[int]int64 // 已收分片：seq → 实际字节数
	ReceivedSum int64         // 已收字节累计（进度百分比依据）
	Cancelled   bool          // 取消标记（取消后拒绝后续分片与合并）
	LastPush    time.Time     // 上次进度推送时间（节流）
	CreatedAt   time.Time     // 创建时间（超时懒清理依据）
	mu          sync.Mutex
}

// chunkTempDir 会话临时分片目录：upload_dir/tmp_chunks/<upload_id>/（收齐合并后整目录删除）
func (s *Server) chunkTempDir(uploadID string) string {
	return filepath.Join(s.cfg.UploadDir, "tmp_chunks", uploadID)
}

// sweepExpiredUploadSessions 懒清理过期会话：每次创建新会话时顺带扫描，删除超时会话与临时目录
func (s *Server) sweepExpiredUploadSessions() {
	now := time.Now()
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	for id, sess := range s.uploadSessions {
		if now.Sub(sess.CreatedAt) > uploadSessionTimeout {
			delete(s.uploadSessions, id)
			os.RemoveAll(s.chunkTempDir(id))
			logger.Warn("分片直传会话超时清理: uploadID=%s, 文件=%s, 发起方=%s", id, sess.FileName, sess.FromUser)
		}
	}
}

// HandleChunkUpload 分片直传入口：POST /upload/chunk?username=&to_user=&nonce=&upload_id=&seq=&total_chunks=&file_name=&file_size=
// 请求体为原始分片字节（application/octet-stream，不经 multipart 解析省内存省 CPU），seq 从 0 开始
// 响应 JSON：单片成功 {received:已收片数, total:总片数}；最后一片收齐后返回 {msg_id, url, file_id}
func (s *Server) HandleChunkUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	username := q.Get("username")
	toUser := q.Get("to_user")     // 群聊为空字符串（与群聊图片上传口径一致）
	nonce := q.Get("nonce")        // 发送端本地气泡标识
	uploadID := q.Get("upload_id") // 会话唯一标识
	fileName := q.Get("file_name")
	seq, _ := strconv.Atoi(q.Get("seq"))
	totalChunks, _ := strconv.Atoi(q.Get("total_chunks"))
	fileSize, _ := strconv.ParseInt(q.Get("file_size"), 10, 64)
	if username == "" || uploadID == "" || fileName == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	// 在线校验（与直传/群聊图片同水位：防止离线/不存在用户名被冒用上传）
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		logger.Warn("分片直传拒绝： %s 无活跃连接", username)
		return
	}
	// 黑名单拦截：仅私聊校验（群聊 to_user 为空）
	if toUser != "" && s.isBlocked(username, toUser) {
		http.Error(w, "对方已将你拉黑或你已拉黑对方，无法发送", http.StatusForbidden)
		return
	}
	// 大小上限校验（服务端归口，超出即拒绝，防止超限文件占满磁盘）
	maxDirect := int64(2 << 30)
	if s.cfg.MaxDirectSize > 0 {
		maxDirect = int64(s.cfg.MaxDirectSize)
	}
	if fileSize <= 0 || fileSize > maxDirect {
		http.Error(w, "文件超出大小上限", http.StatusBadRequest)
		return
	}
	if totalChunks <= 0 {
		http.Error(w, "分片参数非法", http.StatusBadRequest)
		return
	}

	// 首片：校验文件名安全性并创建会话（重复 upload_id 幂等复用，防 HTTP 层重试产生重复会话）
	if seq == 0 {
		if isDangerousFile(fileName) {
			http.Error(w, "禁止传输可执行文件", http.StatusBadRequest)
			logger.Warn("分片直传拦截： %s 尝试上传危险文件 %s", username, fileName)
			return
		}
		// 原实现：sweepExpiredUploadSessions 在下方持有 uploadMu 写锁后再调用，其内部重复加同一把锁导致首片请求死锁挂起
		s.sweepExpiredUploadSessions() // 懒清理：加锁前独立执行（其内部自持锁），顺带扫掉超时会话
		s.uploadMu.Lock()
		if exist, ok := s.uploadSessions[uploadID]; !ok {
			s.uploadSessions[uploadID] = &directUploadSession{
				UploadID:    uploadID,
				FromUser:    username,
				ToUser:      toUser,
				Nonce:       nonce,
				FileName:    fileName,
				FileSize:    fileSize,
				TotalChunks: totalChunks,
				ChunkSize:   int64(s.cfg.UploadChunkSize),
				Received:    make(map[int]int64),
				CreatedAt:   time.Now(),
			}
			if err := os.MkdirAll(s.chunkTempDir(uploadID), os.ModePerm); err != nil {
				delete(s.uploadSessions, uploadID)
				s.uploadMu.Unlock()
				http.Error(w, "临时目录创建失败", http.StatusInternalServerError)
				return
			}
		} else if exist.FromUser != username {
			s.uploadMu.Unlock()
			http.Error(w, "会话归属校验失败", http.StatusForbidden)
			return
		}
		s.uploadMu.Unlock()
	}

	// 取会话并校验归属与参数一致性（非首片会话必须已存在：先发后片属非法序列）
	s.uploadMu.RLock()
	sess, ok := s.uploadSessions[uploadID]
	s.uploadMu.RUnlock()
	if !ok {
		http.Error(w, "上传会话不存在或已取消", http.StatusGone)
		return
	}
	if sess.FromUser != username {
		http.Error(w, "会话归属校验失败", http.StatusForbidden)
		return
	}
	if seq < 0 || seq >= sess.TotalChunks {
		http.Error(w, "分片序号非法", http.StatusBadRequest)
		return
	}

	// 会话取消后拒绝后续分片（发送方 abort 后的竞态在途请求）
	sess.mu.Lock()
	if sess.Cancelled {
		sess.mu.Unlock()
		http.Error(w, "上传已取消", http.StatusGone)
		return
	}
	sess.mu.Unlock()

	// 单片大小限制（服务端配置单片 + 1KB 容差）
	maxChunk := int64(s.cfg.UploadChunkSize)
	if maxChunk <= 0 {
		maxChunk = 4 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxChunk+1024)

	// 分片落盘：临时目录/<seq>.part（raw body 流式写盘，不经内存全量缓冲）
	partPath := filepath.Join(s.chunkTempDir(uploadID), fmt.Sprintf("%d.part", seq))
	part, err := os.Create(partPath)
	if err != nil {
		http.Error(w, "分片写入失败", http.StatusInternalServerError)
		return
	}
	n, err := io.Copy(part, r.Body)
	part.Close()
	if err != nil {
		os.Remove(partPath)
		http.Error(w, "分片写入失败", http.StatusInternalServerError)
		return
	}

	// 标记已收并累计字节（重复 seq 覆盖计数字节，防重复累计）
	sess.mu.Lock()
	if prev, seen := sess.Received[seq]; seen {
		sess.ReceivedSum -= prev
	}
	sess.Received[seq] = n
	sess.ReceivedSum += n
	complete := len(sess.Received) >= sess.TotalChunks
	receivedSum := sess.ReceivedSum
	sess.mu.Unlock()

	if complete {
		// 收齐：合并落库并清理会话（响应携带 msg_id 供发送端确认）
		s.finalizeChunkUpload(w, sess)
		return
	}
	// 未收齐：节流推送接收方进度（微信同款"发送中 xx%"）
	s.pushChunkProgress(sess, receivedSum)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"received": len(sess.Received), "total": sess.TotalChunks})
}

// pushChunkProgress 节流推送上传进度：单会话最快 500ms 一条（私聊推接收方全部连接，群聊广播全部在线用户）
// 发送方本端进度由 XHR 本地计算回显，不经服务端信令（多端其他连接依赖 FILE_PERSISTED 终态归口）
func (s *Server) pushChunkProgress(sess *directUploadSession, receivedSum int64) {
	sess.mu.Lock()
	if sess.Cancelled || time.Since(sess.LastPush) < progressPushInterval {
		sess.mu.Unlock()
		return
	}
	sess.LastPush = time.Now() // 先记推送时间再解锁：并发分片下保证 500ms 至多一条
	sess.mu.Unlock()
	content, _ := json.Marshal(map[string]interface{}{
		"upload_id": sess.UploadID,
		"nonce":     sess.Nonce,
		"received":  receivedSum,
		"total":     sess.FileSize,
		"file_name": sess.FileName,
		"file_size": sess.FileSize,
	})
	data, _ := json.Marshal(&protocol.Message{
		MsgType:  protocol.MsgTypeFileProgress,
		FromUser: sess.FromUser,
		ToUser:   sess.ToUser,
		Content:  string(content),
	})
	if sess.ToUser == "" {
		// 群聊：广播全部在线用户（含发送方其他端，进度语义一致）
		s.hub.Broadcast(data)
		return
	}
	s.sendToUser(sess.ToUser, data)
}

// finalizeChunkUpload 收齐合并：顺序拼接分片 → 移入正式存储目录 → 建档/落库/摘要/推送 FILE_PERSISTED → 清理会话
func (s *Server) finalizeChunkUpload(w http.ResponseWriter, sess *directUploadSession) {
	// 合并前终检：取消标记或分片缺失均拒绝落库
	sess.mu.Lock()
	if sess.Cancelled || len(sess.Received) < sess.TotalChunks {
		sess.mu.Unlock()
		http.Error(w, "分片不完整或已取消", http.StatusConflict)
		return
	}
	sess.mu.Unlock()

	tempDir := s.chunkTempDir(sess.UploadID)
	// 存储目录（与直传同规则：读配置，兜底基于 WebDir 推导）
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	ext := strings.ToLower(filepath.Ext(sess.FileName))
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		http.Error(w, "随机数生成失败", http.StatusInternalServerError)
		return
	}
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dst := filepath.Join(dir, filename)
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	// 顺序合并各分片（流式拷贝，不经内存全量缓冲；磁盘占用峰值≈文件大小）
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件创建失败", http.StatusInternalServerError)
		return
	}
	mergeOK := true
	for seq := 0; seq < sess.TotalChunks; seq++ {
		part, err := os.Open(filepath.Join(tempDir, fmt.Sprintf("%d.part", seq)))
		if err != nil {
			mergeOK = false
			break
		}
		_, err = io.Copy(out, part)
		part.Close()
		if err != nil {
			mergeOK = false
			break
		}
	}
	out.Close()
	if !mergeOK {
		os.Remove(dst)
		http.Error(w, "分片合并失败", http.StatusInternalServerError)
		return
	}
	url := "/static/upload/" + filename

	// 建档 im_file（直传一次完成，直接置为已持久化状态 3）
	rec := model.FileRecord{
		FileName: sess.FileName,
		FileSize: sess.FileSize,
		FilePath: url,
		FromUser: sess.FromUser,
		ToUser:   sess.ToUser,
		Status:   3,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		os.Remove(dst)
		http.Error(w, "文件记录创建失败", http.StatusInternalServerError)
		return
	}
	fileID := strconv.FormatUint(uint64(rec.ID), 10)

	// 落库消息：图片为图片消息(4)，其余为文件消息(5)；nonce 写入 content 供发送端本地气泡回填
	contentBytes, _ := json.Marshal(persistedMsgContent{URL: url, Name: sess.FileName, Size: sess.FileSize, Nonce: sess.Nonce})
	msgType := int8(MsgTypeFileSaved)
	if isImageExt(ext) {
		msgType = int8(MsgTypeImageSaved)
	}
	record := model.Message{
		MsgType:  msgType,
		FromUser: sess.FromUser,
		ToUser:   sess.ToUser,
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		os.Remove(dst)
		http.Error(w, "消息落库失败", http.StatusInternalServerError)
		return
	}
	store.DB.Model(&model.FileRecord{}).Where("id = ?", rec.ID).Update("msg_id", record.ID)

	// 会话摘要：私聊更新双方；群聊更新全部在线用户（与群聊图片口径一致）
	summary := "[文件]"
	if msgType == int8(MsgTypeImageSaved) {
		summary = "[图片]"
	}
	if sess.ToUser == "" {
		for _, name := range s.hub.Usernames() {
			s.touchConversation(name, "", summary)
			s.notifyConvUpdate(name)
		}
	} else {
		s.touchConversation(sess.FromUser, sess.ToUser, summary)
		s.touchConversation(sess.ToUser, sess.FromUser, summary)
		s.notifyConvUpdate(sess.FromUser)
		s.notifyConvUpdate(sess.ToUser)
	}
	logger.Info("分片直传完成: %s -> %s, 文件 %s (%d 字节, %d 片), fileID=%s -> 消息%d, url=%s",
		sess.FromUser, sess.ToUser, sess.FileName, sess.FileSize, sess.TotalChunks, fileID, record.ID, url)

	// 从会话表移除并清理临时分片（先移除防取消信令竞态再命中已删除会话）
	s.uploadMu.Lock()
	delete(s.uploadSessions, sess.UploadID)
	s.uploadMu.Unlock()
	os.RemoveAll(tempDir)

	// 持久化完成通知双方全部在线连接：携带 content（url/name/size/nonce）+ msg_id + file_id
	// 接收端移除"发送中"进度气泡渲染正式卡片；发送端按 nonce 回填本地气泡 msg_id
	notice, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeFilePersisted,
		FromUser:  sess.FromUser,
		ToUser:    sess.ToUser,
		Content:   string(contentBytes),
		FileID:    fileID,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	})
	if sess.ToUser == "" {
		s.hub.Broadcast(notice)
	} else {
		s.sendToUser(sess.FromUser, notice)
		s.sendToUser(sess.ToUser, notice)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"msg_id": record.ID, "url": url, "file_id": fileID})
}

// handleFileCancel 阶段三十二：上传取消（发送方 WS 上行，file_id 复用携带 upload_id）
// 流程：校验会话归属 → 打取消标记（在途分片请求被拒绝）→ 清理会话与临时分片 → 推送双方移除进度气泡
// 原实现：无取消通道，发送方关闭页面后接收方进度气泡永久滞留"发送中"
func (s *Server) handleFileCancel(c *Client, msg *protocol.Message) {
	uploadID := msg.FileID
	if uploadID == "" {
		return
	}
	s.uploadMu.RLock()
	sess, ok := s.uploadSessions[uploadID]
	s.uploadMu.RUnlock()
	if !ok {
		return // 会话不存在（已完成/已清理/已取消）：静默忽略
	}
	if sess.FromUser != c.username {
		s.sendError(c, "仅发送方可取消上传")
		return
	}
	sess.mu.Lock()
	already := sess.Cancelled
	sess.Cancelled = true
	sess.mu.Unlock()
	if already {
		return
	}
	// 清理会话与临时分片
	s.uploadMu.Lock()
	delete(s.uploadSessions, uploadID)
	s.uploadMu.Unlock()
	os.RemoveAll(s.chunkTempDir(uploadID))
	logger.Info("分片直传取消: %s 取消文件 %s (uploadID=%s)", c.username, sess.FileName, uploadID)
	// 推送取消：私聊双方全部连接（发送方多端同步移除进度气泡），群聊广播
	content, _ := json.Marshal(map[string]interface{}{"upload_id": uploadID, "nonce": sess.Nonce})
	notice, _ := json.Marshal(&protocol.Message{
		MsgType:  protocol.MsgTypeFileCancel,
		FromUser: c.username,
		ToUser:   sess.ToUser,
		Content:  string(content),
	})
	if sess.ToUser == "" {
		s.hub.Broadcast(notice)
		return
	}
	s.sendToUser(sess.FromUser, notice)
	s.sendToUser(sess.ToUser, notice)
}
