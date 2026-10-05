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
	"im-server/store"
)

// 允许的头像格式
var allowedExt = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
}

// avatarDir 头像静态资源目录
// 原实现：const avatarDir = "../im-client/web/static/avatar"（相对进程工作目录，从 bin 目录双击 exe 启动会失效）
// 现改为变量，由 main.go 启动时按配置注入（锚定 exe 所在目录解析，任意目录启动均正确）
var avatarDir = "../im-client/web/static/avatar"

// SetAvatarDir 注入头像目录（由 main.go 启动时调用，替代原相对路径常量）
func SetAvatarDir(dir string) {
	avatarDir = dir
}

// HandleAvatarUpload 处理头像上传：POST /upload/avatar?username=xxx
func (s *Server) HandleAvatarUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		http.Error(w, "缺少用户名", http.StatusBadRequest)
		return
	}

	// 限制请求体大小 5MB
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	if err := r.ParseMultipartForm(5 << 20); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("avatar")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 校验文件格式
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExt[ext] {
		http.Error(w, "仅支持 jpg/png/gif 格式", http.StatusBadRequest)
		return
	}

	// 生成唯一文件名
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)

	// 保存文件
	if err := os.MkdirAll(avatarDir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(avatarDir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, file); err != nil {
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}

	// 更新数据库头像路径
	avatarURL := "/static/avatar/" + filename
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).Update("avatar", avatarURL).Error; err != nil {
		http.Error(w, "数据库更新失败", http.StatusInternalServerError)
		return
	}

	// 5万容量改造（E9）：头像变更走在线名单增量帧（其余用户更新该用户头像），
	// 原实现触发全量快照广播（广播帧体积与总下行随在线人数平方增长）；同步更新快照头像缓存
	avatarCache.Store(username, avatarURL)
	s.pushUserListOnline(UserInfo{Username: username, Avatar: avatarURL})
	logger.Info("用户 %s 更新头像: %s", username, avatarURL)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"avatar": avatarURL})
}

// HandleGroupAvatarUpload 处理群头像上传（阶段二百六十六）：POST /upload/group-avatar?group_id=N&username=xxx
// 仅群主可更换（owner_id 归口校验）；落盘复用 avatarDir（g+群ID 前缀区分个人头像）→ 回写 im_group.avatar →
// 全员 73 全量同步归口（前端 groupMap 刷新后，会话列表/群设置面板的单图/九宫格降级头像自动归位）
func (s *Server) HandleGroupAvatarUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	gid, err := strconv.ParseUint(r.URL.Query().Get("group_id"), 10, 64)
	if username == "" || err != nil || gid == 0 {
		http.Error(w, "参数缺失", http.StatusBadRequest)
		return
	}
	var group model.Group
	if err := store.DB.Where("id = ?", gid).First(&group).Error; err != nil {
		http.Error(w, "群不存在", http.StatusNotFound)
		return
	}
	if group.OwnerID != username {
		http.Error(w, "仅群主可更换群头像", http.StatusForbidden)
		return
	}

	// 与个人头像同链路：5MB 限制 / 格式校验 / 唯一文件名 / 落盘
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	if err := r.ParseMultipartForm(5 << 20); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("avatar")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExt[ext] {
		http.Error(w, "仅支持 jpg/png/gif 格式", http.StatusBadRequest)
		return
	}
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("g%d_%d_%s%s", gid, time.Now().UnixNano(), hex.EncodeToString(b), ext)
	if err := os.MkdirAll(avatarDir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(avatarDir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	defer out.Close()
	if _, err := io.Copy(out, file); err != nil {
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}

	avatarURL := "/static/avatar/" + filename
	if err := store.DB.Model(&model.Group{}).Where("id = ?", gid).Update("avatar", avatarURL).Error; err != nil {
		http.Error(w, "数据库更新失败", http.StatusInternalServerError)
		return
	}
	// 全员 73 全量同步归口（含群主多端；群头像随 GroupInfo.Avatar 下发）
	memberIDs := getGroupMemberIDs(uint(gid))
	s.notifyGroupListSync(memberIDs)
	logger.Info("群 %d「%s」群主 %s 更新群头像: %s", gid, group.Name, username, avatarURL)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"avatar": avatarURL})
}
