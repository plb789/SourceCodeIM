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
	"im-server/store"
)

// 允许的头像格式
var allowedExt = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
}

// avatarDir 头像静态资源目录（相对服务端运行目录）
const avatarDir = "../im-client/web/static/avatar"

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

	// 广播用户列表更新，全端刷新头像
	s.pushUserList()
	logger.Info("用户 %s 更新头像: %s", username, avatarURL)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"avatar": avatarURL})
}
