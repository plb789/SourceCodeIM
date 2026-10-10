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

// ===== 阶段二百八十：朋友圈（微信同款，服务端归口） =====
// 数据归口：im_moment / im_moment_like / im_moment_comment / im_moment_unread 四表
// API 归口：/api/moments*（口径同 /api/kb：username 参数标识当前用户）
// 上传归口：/upload/moment/image（图片直传，仅存文件不落消息，返回 /static/upload/ URL）
// 可见范围：双向好友 + 自己；单条动态按 visibility 过滤（0公开 1私密 2部分可见 3不给谁看）
// 实时归口：点赞/评论/回复/删除后经 108 帧下发（红点 + 已打开页面原位刷新，不轮询）

// momentVis 常量（model.Moment.Visibility 取值口径）
const (
	momentVisPublic  int8 = 0 // 公开：全部好友可见
	momentVisPrivate int8 = 1 // 私密：仅自己
	momentVisPartly  int8 = 2 // 部分可见：仅 visible_users 内好友
	momentVisExcept  int8 = 3 // 不给谁看：visible_users 内好友不可见
	momentMaxImages       = 9 // 微信同款单条最多 9 图
	momentPageSize        = 20
	momentMaxVideos       = 1 // 微信同款：视频动态单视频独占（不与图片混排）
)

// isVideoExt 判断扩展名是否为浏览器 <video> 可直播的视频格式
func isVideoExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".mp4", ".webm", ".mov", ".m4v":
		return true
	}
	return false
}

// momentURLOf 按扩展名判断动态格子类型：返回 "video" / "image"（容错：无扩展名按图片）
func momentURLOf(url string) string {
	if isVideoExt(filepath.Ext(url)) {
		return "video"
	}
	return "image"
}

// momentVisUsers 解析 visible_users JSON（容错：空/坏 JSON 返回空数组）
func momentVisUsers(raw string) []string {
	if raw == "" {
		return nil
	}
	var users []string
	_ = json.Unmarshal([]byte(raw), &users)
	return users
}

// momentVisibleTo 判定动态对 viewer 是否可见（服务端归口，时间线与互动校验共用）
func momentVisibleTo(m *model.Moment, viewer string) bool {
	if m.Username == viewer {
		return true // 自己恒可见（含私密）
	}
	users := momentVisUsers(m.VisibleUsers)
	switch m.Visibility {
	case momentVisPrivate:
		return false
	case momentVisPartly:
		for _, u := range users {
			if u == viewer {
				return true
			}
		}
		return false
	case momentVisExcept:
		for _, u := range users {
			if u == viewer {
				return false
			}
		}
		return true
	}
	return true // 0 公开
}

// friendIDsOf 双向好友集合（朋友圈可见范围判定归口；addFriend 双向落行，此处双向查齐防御单向残留）
func friendIDsOf(username string) []string {
	var rows []model.Friend
	store.DB.Where("user_id = ?", username).Find(&rows)
	set := make(map[string]bool, len(rows))
	for _, f := range rows {
		set[f.FriendID] = true
	}
	var reverse []model.Friend
	store.DB.Where("friend_id = ?", username).Find(&reverse)
	for _, f := range reverse {
		set[f.UserID] = true
	}
	delete(set, username)
	delete(set, "")
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	return ids
}

// momentIsFriend 双向好友判定（点赞/评论权限校验归口）
func momentIsFriend(a, b string) bool {
	if a == b {
		return false
	}
	var count int64
	store.DB.Model(&model.Friend{}).Where("user_id = ? AND friend_id = ?", a, b).Count(&count)
	if count > 0 {
		return true
	}
	store.DB.Model(&model.Friend{}).Where("user_id = ? AND friend_id = ?", b, a).Count(&count)
	return count > 0
}

// momentUserBrief 用户名片（昵称/头像富化归口，批量查询避免 N+1）
func momentUserBrief(usernames ...string) map[string]map[string]string {
	out := make(map[string]map[string]string, len(usernames))
	if len(usernames) == 0 {
		return out
	}
	var users []model.User
	store.DB.Where("username IN ?", usernames).Find(&users)
	for _, u := range users {
		name := u.Nickname
		if name == "" {
			name = u.Username
		}
		out[u.Username] = map[string]string{"nickname": name, "avatar": u.Avatar}
	}
	return out
}

// momentJSON 统一 JSON 响应归口
func momentJSON(w http.ResponseWriter, payload map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(payload)
}

// momentFail 错误响应归口
func momentFail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
}

// momentArg 用户参数读取归口（口径同 /api/kb：username 参数标识当前用户）
func momentArg(r *http.Request) string {
	return strings.TrimSpace(r.URL.Query().Get("username"))
}

// pushMomentSync 108 帧下发归口（红点 + 已打开页面刷新；users 内在线者全连接接收）
func (s *Server) pushMomentSync(users []string, action string, momentID uint, actor string) {
	payload, _ := json.Marshal(map[string]interface{}{
		"action":    action,
		"moment_id": momentID,
		"actor":     actor,
	})
	notice := protocol.Message{
		MsgType:   protocol.MsgTypeMomentSync,
		FromUser:  actor,
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	s.sendToUsers(users, data)
}

// HandleMomentUpload POST /upload/moment/image 朋友圈图片直传（仅存文件返回 URL，不落消息）
func (s *Server) HandleMomentUpload(w http.ResponseWriter, r *http.Request) {
	s.momentUploadMedia(w, r, false)
}

// HandleMomentVideoUpload POST /upload/moment/video 朋友圈视频直传（阶段二百八十一：
// 微信同款拍摄/相册视频动态；大小上限跟随全局 MaxFileSize，扩展名白名单浏览器可播格式）
func (s *Server) HandleMomentVideoUpload(w http.ResponseWriter, r *http.Request) {
	s.momentUploadMedia(w, r, true)
}

// momentUploadMedia 朋友圈媒体直传归口：仅存文件返回 URL 不落消息；video=true 收视频，否则收图片
func (s *Server) momentUploadMedia(w http.ResponseWriter, r *http.Request, video bool) {
	username := momentArg(r)
	if username == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		return
	}
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
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if video {
		if !isVideoExt(ext) {
			http.Error(w, "朋友圈视频仅支持 mp4/webm/mov 格式", http.StatusBadRequest)
			return
		}
	} else if !isImageExt(ext) {
		http.Error(w, "朋友圈仅支持图片文件", http.StatusBadRequest)
		return
	}
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
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
	kind := "图片"
	if video {
		kind = "视频"
	}
	logger.Info("朋友圈%s上传: %s -> %s, %s (%d 字节)", kind, username, url, header.Filename, header.Size)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "url": url})
}

// HandleMomentCreate POST /api/moments 发布动态
// 请求体 JSON：{content, images[], visibility, visible_users[]}
func (s *Server) HandleMomentCreate(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	var body struct {
		Content      string   `json:"content"`
		Images       []string `json:"images"`
		Visibility   int8     `json:"visibility"`
		VisibleUsers []string `json:"visible_users"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		momentFail(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	body.Content = strings.TrimSpace(body.Content)
	if body.Content == "" && len(body.Images) == 0 {
		momentFail(w, http.StatusBadRequest, "内容不能为空")
		return
	}
	if len(body.Images) > momentMaxImages {
		momentFail(w, http.StatusBadRequest, "最多上传 9 张图片")
		return
	}
	// 正文长度上限：与发布页 textarea maxlength 一致（防绕过前端直打 API 撑爆 text 列）
	if len([]rune(body.Content)) > 2000 {
		momentFail(w, http.StatusBadRequest, "内容过长")
		return
	}
	// 图片路径白名单加固：仅接受本站 /static/upload/ 相对路径，防注入外链
	imgs := make([]string, 0, len(body.Images))
	for _, img := range body.Images {
		img = strings.TrimSpace(img)
		if strings.HasPrefix(img, "/static/upload/") && !strings.Contains(img, "..") {
			imgs = append(imgs, img)
		}
	}
	// 微信同款：视频动态单视频独占——任一格子为视频则仅允许 1 格，不与图片混排
	videos := 0
	for _, u := range imgs {
		if momentURLOf(u) == "video" {
			videos++
		}
	}
	if videos > momentMaxVideos {
		momentFail(w, http.StatusBadRequest, "视频动态仅支持单个视频")
		return
	}
	if videos == 1 && len(imgs) > 1 {
		momentFail(w, http.StatusBadRequest, "视频不能与图片混排发布")
		return
	}
	if body.Visibility < 0 || body.Visibility > 3 {
		body.Visibility = 0
	}
	visUsers := make([]string, 0, len(body.VisibleUsers))
	if body.Visibility == momentVisPartly || body.Visibility == momentVisExcept {
		for _, u := range body.VisibleUsers {
			if u = strings.TrimSpace(u); u != "" && u != username {
				visUsers = append(visUsers, u)
			}
		}
		// 部分/不给谁看须至少选择一名好友，否则语义落空
		if len(visUsers) == 0 {
			momentFail(w, http.StatusBadRequest, "请选择可见范围好友")
			return
		}
	}
	visBytes, _ := json.Marshal(visUsers)
	imgBytes, err := json.Marshal(imgs)
	if err != nil {
		momentFail(w, http.StatusInternalServerError, "图片序列化失败")
		return
	}
	m := model.Moment{
		Username:     username,
		Content:      body.Content,
		Images:       string(imgBytes),
		Visibility:   body.Visibility,
		VisibleUsers: string(visBytes),
	}
	if err := store.DB.Create(&m).Error; err != nil {
		momentFail(w, http.StatusInternalServerError, "发布失败")
		return
	}
	// 好友新动态未读（微信发现页头像归口）：给可见好友各落一行 action=publish，
	// 打开朋友圈整单已读；108 帧同步推给可见好友，入口头像叠加实时点亮
	audience := momentAudience(username, body.Visibility, visUsers)
	if len(audience) > 0 {
		unreads := make([]model.MomentUnread, 0, len(audience))
		for _, f := range audience {
			unreads = append(unreads, model.MomentUnread{Username: f, MomentID: m.ID, Actor: username, Action: "publish"})
		}
		store.DB.Create(&unreads)
		s.pushMomentSync(audience, "publish", m.ID, username)
	}
	s.pushMomentSync([]string{username}, "publish", m.ID, username) // 多端自身同步
	momentJSON(w, map[string]interface{}{"ok": true, "id": m.ID})
}

// momentAudience 动态可见好友归口：0=全部好友 1=仅自己(无) 2=指定好友 3=好友去掉指定
func momentAudience(owner string, visibility int8, visUsers []string) []string {
	if visibility == momentVisPrivate {
		return nil
	}
	friends := friendIDsOf(owner)
	if visibility == momentVisPartly || visibility == momentVisExcept {
		set := make(map[string]bool, len(visUsers))
		for _, u := range visUsers {
			set[u] = true
		}
		out := make([]string, 0, len(friends))
		for _, f := range friends {
			// 2=部分可见（须在名单内）；3=不给谁看（须不在名单内）
			if (visibility == momentVisPartly) == set[f] {
				out = append(out, f)
			}
		}
		return out
	}
	return friends
}

// HandleMomentList GET /api/moments 朋友圈时间线（双向好友 + 自己，visibility 过滤，游标分页）
// 参数：username / before_id（0=最新）/ size（缺省 20，上限 50）
func (s *Server) HandleMomentList(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	beforeID, _ := strconv.ParseUint(r.URL.Query().Get("before_id"), 10, 64)
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 50 {
		size = momentPageSize
	}

	// 可见作者集合：双向好友 + 自己（服务端归口，非好友动态一概不可见）
	authors := friendIDsOf(username)
	authors = append(authors, username)
	q := store.DB.Model(&model.Moment{}).Where("username IN ?", authors)
	if beforeID > 0 {
		q = q.Where("id < ?", beforeID)
	}
	// 超量拉取后内存过滤 visibility（过滤有损耗，按 3 倍冗余取，循环补齐到 size）
	items := make([]model.Moment, 0, size)
	cursor := beforeID
	for len(items) < size {
		batch := make([]model.Moment, 0, size*3)
		qq := store.DB.Model(&model.Moment{}).Where("username IN ?", authors)
		if cursor > 0 {
			qq = qq.Where("id < ?", cursor)
		}
		if err := qq.Order("id DESC").Limit(size * 3).Find(&batch).Error; err != nil || len(batch) == 0 {
			break
		}
		for i := range batch {
			if momentVisibleTo(&batch[i], username) {
				items = append(items, batch[i])
				if len(items) >= size {
					break
				}
			}
		}
		cursor = uint64(batch[len(batch)-1].ID)
		if len(batch) < size*3 {
			break // 底部到底
		}
	}
	momentJSON(w, map[string]interface{}{"ok": true, "list": s.momentRichList(items, username)})
}

// HandleMomentMine GET /api/moments/mine 我的相册（仅自己全部动态含私密）
func (s *Server) HandleMomentMine(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	beforeID, _ := strconv.ParseUint(r.URL.Query().Get("before_id"), 10, 64)
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 50 {
		size = momentPageSize
	}
	q := store.DB.Model(&model.Moment{}).Where("username = ?", username)
	if beforeID > 0 {
		q = q.Where("id < ?", beforeID)
	}
	items := make([]model.Moment, 0, size)
	if err := q.Order("id DESC").Limit(size).Find(&items).Error; err != nil {
		momentFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	momentJSON(w, map[string]interface{}{"ok": true, "list": s.momentRichList(items, username)})
}

// momentRichList 动态富化：点赞名单/评论楼（含被回复人名）/互动人数/当前用户已赞 + 发布者名片
func (s *Server) momentRichList(items []model.Moment, viewer string) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(items))
	if len(items) == 0 {
		return out
	}
	ids := make([]uint, 0, len(items))
	authors := make([]string, 0, len(items))
	for _, m := range items {
		ids = append(ids, m.ID)
		authors = append(authors, m.Username)
	}
	// 批量取点赞/评论（IN 一次查齐，内存分组）
	var likes []model.MomentLike
	store.DB.Where("moment_id IN ?", ids).Order("id ASC").Find(&likes)
	var comments []model.MomentComment
	store.DB.Where("moment_id IN ?", ids).Order("id ASC").Find(&comments)
	likesBy := map[uint][]model.MomentLike{}
	for _, l := range likes {
		likesBy[l.MomentID] = append(likesBy[l.MomentID], l)
	}
	commentsBy := map[uint][]model.MomentComment{}
	for _, c := range comments {
		commentsBy[c.MomentID] = append(commentsBy[c.MomentID], c)
	}
	// 名片集合：作者 + 点赞人 + 评论人 + 被回复人
	nameSet := map[string]bool{}
	for _, a := range authors {
		nameSet[a] = true
	}
	for _, l := range likes {
		nameSet[l.Username] = true
	}
	for _, c := range comments {
		nameSet[c.Username] = true
		if c.ReplyToUser != "" {
			nameSet[c.ReplyToUser] = true
		}
	}
	names := make([]string, 0, len(nameSet))
	for n := range nameSet {
		names = append(names, n)
	}
	briefs := momentUserBrief(names...)

	for _, m := range items {
		brief := briefs[m.Username]
		likeNames := make([]map[string]string, 0, len(likesBy[m.ID]))
		liked := false
		for _, l := range likesBy[m.ID] {
			b := briefs[l.Username]
			nick := l.Username
			avatar := ""
			if b != nil {
				nick = b["nickname"]
				avatar = b["avatar"]
			}
			if l.Username == viewer {
				liked = true
			}
			likeNames = append(likeNames, map[string]string{"username": l.Username, "nickname": nick, "avatar": avatar})
		}
		commentList := make([]map[string]interface{}, 0, len(commentsBy[m.ID]))
		for _, c := range commentsBy[m.ID] {
			b := briefs[c.Username]
			nick := c.Username
			avatar := ""
			if b != nil {
				nick = b["nickname"]
				avatar = b["avatar"]
			}
			replyName := ""
			if c.ReplyToUser != "" {
				if rb := briefs[c.ReplyToUser]; rb != nil {
					replyName = rb["nickname"]
				} else {
					replyName = c.ReplyToUser
				}
			}
			commentList = append(commentList, map[string]interface{}{
				"id":            c.ID,
				"username":      c.Username,
				"nickname":      nick,
				"avatar":        avatar,
				"reply_to":      c.ReplyTo,
				"reply_to_user": c.ReplyToUser,
				"reply_to_name": replyName,
				"content":       c.Content,
				"create_time":   c.CreateTime.Format(time.RFC3339),
			})
		}
		images := momentVisUsers(m.Images)
		visUsers := momentVisUsers(m.VisibleUsers)
		item := map[string]interface{}{
			"id":            m.ID,
			"username":      m.Username,
			"nickname":      brief["nickname"],
			"avatar":        brief["avatar"],
			"content":       m.Content,
			"images":        images,
			"visibility":    m.Visibility,
			"visible_users": visUsers,
			"create_time":   m.CreateTime.Format(time.RFC3339),
			"likes":         likeNames,
			"comments":      commentList,
			"liked":         liked,
			"is_owner":      m.Username == viewer,
		}
		out = append(out, item)
	}
	return out
}

// HandleMomentDelete DELETE /api/moments/{id} 删除自己的动态（级联清点赞/评论/互动未读）
func (s *Server) HandleMomentDelete(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if username == "" || id == 0 {
		momentFail(w, http.StatusBadRequest, "缺少参数")
		return
	}
	var m model.Moment
	if err := store.DB.First(&m, id).Error; err != nil {
		momentFail(w, http.StatusNotFound, "动态不存在")
		return
	}
	if m.Username != username {
		momentFail(w, http.StatusForbidden, "仅能删除自己的动态")
		return
	}
	// 级联清理：动态与附属数据同生共死，防孤儿行（量级极小，逐表删除足够）
	store.DB.Delete(&model.Moment{}, id)
	store.DB.Where("moment_id = ?", id).Delete(&model.MomentLike{})
	store.DB.Where("moment_id = ?", id).Delete(&model.MomentComment{})
	store.DB.Where("moment_id = ?", id).Delete(&model.MomentUnread{})
	s.pushMomentSync([]string{username}, "delete", m.ID, username)
	momentJSON(w, map[string]interface{}{"ok": true})
}

// HandleMomentLike POST /api/moments/{id}/like 点赞（好友权限 + 可见范围校验，幂等）
func (s *Server) HandleMomentLike(w http.ResponseWriter, r *http.Request) {
	s.momentLikeToggle(w, r, true)
}

// HandleMomentUnlike DELETE /api/moments/{id}/like 取消点赞（幂等）
func (s *Server) HandleMomentUnlike(w http.ResponseWriter, r *http.Request) {
	s.momentLikeToggle(w, r, false)
}

// momentLikeToggle 点赞/取消归口（like=true 幂等点赞，like=false 幂等取消）
func (s *Server) momentLikeToggle(w http.ResponseWriter, r *http.Request, like bool) {
	username := momentArg(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if username == "" || id == 0 {
		momentFail(w, http.StatusBadRequest, "缺少参数")
		return
	}
	var m model.Moment
	if err := store.DB.First(&m, id).Error; err != nil {
		momentFail(w, http.StatusNotFound, "动态不存在")
		return
	}
	if !momentVisibleTo(&m, username) {
		momentFail(w, http.StatusForbidden, "不可见动态")
		return
	}
	if like {
		if m.Username != username && !momentIsFriend(username, m.Username) {
			momentFail(w, http.StatusForbidden, "仅好友可点赞")
			return
		}
		var count int64
		store.DB.Model(&model.MomentLike{}).Where("moment_id = ? AND username = ?", id, username).Count(&count)
		if count == 0 {
			store.DB.Create(&model.MomentLike{MomentID: uint(id), Username: username})
			if m.Username != username {
				// 互动未读归口：点赞人维度去重（取消再赞不累积重复红点）
				store.DB.Where("username = ? AND moment_id = ? AND actor = ? AND action = ?", m.Username, id, username, "like").
					Delete(&model.MomentUnread{})
				store.DB.Create(&model.MomentUnread{Username: m.Username, MomentID: uint(id), Actor: username, Action: "like"})
			}
			s.pushMomentSync(momentSyncTargets(m.Username, "", username), "like", m.ID, username)
		}
	} else {
		store.DB.Where("moment_id = ? AND username = ?", id, username).Delete(&model.MomentLike{})
		if m.Username != username {
			store.DB.Where("username = ? AND moment_id = ? AND actor = ? AND action = ?", m.Username, id, username, "like").
				Delete(&model.MomentUnread{})
		}
		s.pushMomentSync(momentSyncTargets(m.Username, "", username), "unlike", m.ID, username)
	}
	momentJSON(w, map[string]interface{}{"ok": true})
}

// HandleMomentComment POST /api/moments/{id}/comments 评论/回复
// 请求体 JSON：{content, reply_to}（reply_to>0 为楼中楼回复）
func (s *Server) HandleMomentComment(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	id, _ := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if username == "" || id == 0 {
		momentFail(w, http.StatusBadRequest, "缺少参数")
		return
	}
	var body struct {
		Content string `json:"content"`
		ReplyTo uint   `json:"reply_to"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		momentFail(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	body.Content = strings.TrimSpace(body.Content)
	if body.Content == "" {
		momentFail(w, http.StatusBadRequest, "评论内容不能为空")
		return
	}
	if len([]rune(body.Content)) > 500 {
		momentFail(w, http.StatusBadRequest, "评论最长 500 字")
		return
	}
	var m model.Moment
	if err := store.DB.First(&m, id).Error; err != nil {
		momentFail(w, http.StatusNotFound, "动态不存在")
		return
	}
	if !momentVisibleTo(&m, username) {
		momentFail(w, http.StatusForbidden, "不可见动态")
		return
	}
	if m.Username != username && !momentIsFriend(username, m.Username) {
		momentFail(w, http.StatusForbidden, "仅好友可评论")
		return
	}
	// 回复归口：目标评论须属于本动态；被回复人取原评论人（微信同款"张三回复李四"）
	replyToUser := ""
	action := "comment"
	if body.ReplyTo > 0 {
		var target model.MomentComment
		if err := store.DB.Where("id = ? AND moment_id = ?", body.ReplyTo, id).First(&target).Error; err != nil {
			momentFail(w, http.StatusNotFound, "被回复的评论不存在")
			return
		}
		replyToUser = target.Username
		// 回复的回复：楼中楼层级归一到被回复评论本身（微信同款平铺展示，不再嵌套）
		action = "reply"
	}
	c := model.MomentComment{
		MomentID:    uint(id),
		Username:    username,
		ReplyTo:     body.ReplyTo,
		ReplyToUser: replyToUser,
		Content:     body.Content,
	}
	if err := store.DB.Create(&c).Error; err != nil {
		momentFail(w, http.StatusInternalServerError, "评论失败")
		return
	}
	// 未读归口：动态归属人 + 被回复人（去自身）
	readers := momentSyncTargets(m.Username, replyToUser, username)
	for _, rd := range readers {
		if rd == username {
			continue
		}
		act := "comment"
		if action == "reply" && rd == replyToUser {
			act = "reply"
		}
		store.DB.Create(&model.MomentUnread{Username: rd, MomentID: uint(id), Actor: username, Action: act})
	}
	s.pushMomentSync(readers, action, m.ID, username)
	momentJSON(w, map[string]interface{}{"ok": true, "id": c.ID})
}

// HandleMomentCommentDelete DELETE /api/moments/{id}/comment/{cid} 删除评论（评论人或动态主人）
func (s *Server) HandleMomentCommentDelete(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	id, _ := strconv.ParseUint(r.PathValue("cid"), 10, 64)
	if username == "" || id == 0 {
		momentFail(w, http.StatusBadRequest, "缺少参数")
		return
	}
	var c model.MomentComment
	if err := store.DB.First(&c, id).Error; err != nil {
		momentFail(w, http.StatusNotFound, "评论不存在")
		return
	}
	var m model.Moment
	if err := store.DB.First(&m, c.MomentID).Error; err != nil {
		momentFail(w, http.StatusNotFound, "动态不存在")
		return
	}
	if c.Username != username && m.Username != username {
		momentFail(w, http.StatusForbidden, "无权删除该评论")
		return
	}
	store.DB.Delete(&model.MomentComment{}, id)
	store.DB.Where("username = ? AND moment_id = ? AND actor = ?", m.Username, c.MomentID, c.Username).
		Where("action IN ?", []string{"comment", "reply"}).Delete(&model.MomentUnread{})
	s.pushMomentSync(momentSyncTargets(m.Username, c.ReplyToUser, username), "comment_delete", m.ID, username)
	momentJSON(w, map[string]interface{}{"ok": true})
}

// HandleMomentUnread GET /api/moments/unread 互动红点（未读条数 + 最新 20 条明细）
func (s *Server) HandleMomentUnread(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	var count int64
	store.DB.Model(&model.MomentUnread{}).Where("username = ? AND is_read = ?", username, false).Count(&count)
	var rows []model.MomentUnread
	store.DB.Where("username = ? AND is_read = ?", username, false).Order("id DESC").Limit(20).Find(&rows)
	actors := make([]string, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		if !seen[row.Actor] {
			seen[row.Actor] = true
			actors = append(actors, row.Actor)
		}
	}
	// 按人聚合（入口头像叠加归口）：最新未读在前，附昵称/头像/未读条数；
	// GROUP BY 全量聚合不受 list 的 20 条截断影响
	type momentActorAgg struct {
		Actor string
		Cnt   int64
		Last  uint
	}
	var aggs []momentActorAgg
	store.DB.Model(&model.MomentUnread{}).
		Select("actor, COUNT(*) AS cnt, MAX(id) AS last").
		Where("username = ? AND is_read = ?", username, false).
		Group("actor").Order("last DESC").Limit(12).Scan(&aggs)
	aggUsers := make([]string, 0, len(aggs))
	for _, a := range aggs {
		aggUsers = append(aggUsers, a.Actor)
	}
	briefs := momentUserBrief(aggUsers...)
	actorList := make([]map[string]interface{}, 0, len(aggs))
	for _, a := range aggs {
		b := briefs[a.Actor]
		nick := a.Actor
		avatar := ""
		if b != nil {
			nick = b["nickname"]
			avatar = b["avatar"]
		}
		actorList = append(actorList, map[string]interface{}{
			"username": a.Actor,
			"nickname": nick,
			"avatar":   avatar,
			"count":    a.Cnt,
		})
	}
	briefs2 := momentUserBrief(actors...)
	list := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		b := briefs2[row.Actor]
		nick := row.Actor
		if b != nil {
			nick = b["nickname"]
		}
		list = append(list, map[string]interface{}{
			"moment_id":   row.MomentID,
			"actor":       row.Actor,
			"nickname":    nick,
			"action":      row.Action,
			"create_time": row.CreateTime.Format(time.RFC3339),
		})
	}
	momentJSON(w, map[string]interface{}{"ok": true, "count": count, "list": list, "actors": actorList})
}

// HandleMomentUnreadRead POST /api/moments/unread/read 打开朋友圈整单已读（红点清零归口）
func (s *Server) HandleMomentUnreadRead(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	store.DB.Model(&model.MomentUnread{}).Where("username = ? AND is_read = ?", username, false).
		Update("is_read", true)
	momentJSON(w, map[string]interface{}{"ok": true})
}

// ===== 阶段二百八十一：朋友圈封面（微信同款"更换相册封面"） =====
// GET /api/moments/cover 打开页面时拉取当前封面；POST 保存；DELETE 恢复默认渐变。
// 封面支持图片/GIF/短视频 URL（/static/upload/ 白名单内），空串走前端默认背景。

// HandleMomentCoverGet GET /api/moments/cover 查询当前用户朋友圈封面
func (s *Server) HandleMomentCoverGet(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	var u model.User
	if err := store.DB.Select("moment_cover").Where("username = ?", username).First(&u).Error; err != nil {
		momentJSON(w, map[string]interface{}{"ok": true, "cover": ""})
		return
	}
	momentJSON(w, map[string]interface{}{"ok": true, "cover": u.MomentCover})
}

// HandleMomentCoverSet POST /api/moments/cover 保存封面（请求体 {url}；须在线，同上传口鉴权水位）
func (s *Server) HandleMomentCoverSet(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	if s.hub.Count(username) == 0 {
		momentFail(w, http.StatusUnauthorized, "用户未在线，请先登录")
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		momentFail(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	url := strings.TrimSpace(body.URL)
	if url != "" {
		// 白名单与动态媒体一致：仅本站上传目录 + 图片/视频扩展名，防注入外链
		if !strings.HasPrefix(url, "/static/upload/") || strings.Contains(url, "..") ||
			(!isImageExt(filepath.Ext(url)) && !isVideoExt(filepath.Ext(url))) {
			momentFail(w, http.StatusBadRequest, "封面地址不合法")
			return
		}
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).
		Update("moment_cover", url).Error; err != nil {
		momentFail(w, http.StatusInternalServerError, "封面保存失败")
		return
	}
	momentJSON(w, map[string]interface{}{"ok": true, "cover": url})
}

// HandleMomentCoverDelete DELETE /api/moments/cover 恢复默认封面（清空字段走默认渐变背景）
func (s *Server) HandleMomentCoverDelete(w http.ResponseWriter, r *http.Request) {
	username := momentArg(r)
	if username == "" {
		momentFail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	if s.hub.Count(username) == 0 {
		momentFail(w, http.StatusUnauthorized, "用户未在线，请先登录")
		return
	}
	if err := store.DB.Model(&model.User{}).Where("username = ?", username).
		Update("moment_cover", "").Error; err != nil {
		momentFail(w, http.StatusInternalServerError, "封面恢复失败")
		return
	}
	momentJSON(w, map[string]interface{}{"ok": true})
}

// momentSyncTargets 108 帧接收人归口：动态归属人 + 被回复人（去互动人自身、去重）
func momentSyncTargets(owner, replyToUser, actor string) []string {
	set := map[string]bool{owner: true}
	if replyToUser != "" {
		set[replyToUser] = true
	}
	delete(set, actor)
	delete(set, "")
	users := make([]string, 0, len(set))
	for u := range set {
		users = append(users, u)
	}
	return users
}
