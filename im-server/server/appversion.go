package server

// ===== 阶段二百六十：客户端自动更新——版本管理模块（APP/PC 共用一套服务端归口） =====
// 设计归口：
//  1. 维护侧：admin 后台上传安装包（APK / PC Setup exe）走 /admin/api/appversion*，复用 adminGuard 鉴权；
//     安装包落盘 <WebDir>/static/download/<platform>/，服务端静态服务（main.go fileServer）天然托管，
//     URL 直接可下载，零新增下载路由；
//  2. 检查侧：公开只读 GET /api/app/version?platform=&code=&name=——客户端上报当前版本，
//     服务端比对当前生效版本（enabled）返回是否有更新/下载地址/是否强制。android 按 versionCode
//     整型比对，win 按语义化版本（x.y.z）比对；
//  3. PC 端 electron-updater 兼容：win 生效版本变更（上传/启用/删除）时动态生成
//     <download>/win/latest.yml（version/files/path/sha512/size 字段），generic feed 指向该目录即可全自动更新；
//  4. 强制更新：force 标记随检查接口下发，客户端弹窗不可关闭、更新后方可继续使用；
//  5. 安全底线：安装包扩展名白名单（.apk/.exe），落盘文件名服务端归口生成（版本名净化后拼装），
//     杜绝路径穿越；上传大小上限读配置（缺省 512MB）。

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// RegisterAppVersionRoutes 注册客户端版本管理路由（main.go 调用归口）
func RegisterAppVersionRoutes(s *Server) {
	// 管理端（复用后台会话鉴权）
	http.HandleFunc("POST /admin/api/appversion", s.adminGuard(s.handleAdminAppVersionUpload))
	http.HandleFunc("GET /admin/api/appversion", s.adminGuard(s.handleAdminAppVersionList))
	http.HandleFunc("POST /admin/api/appversion/{id}/enable", s.adminGuard(s.handleAdminAppVersionEnable))
	http.HandleFunc("DELETE /admin/api/appversion/{id}", s.adminGuard(s.handleAdminAppVersionDelete))
	// 客户端公开检查（无用户态，只读）
	http.HandleFunc("GET /api/app/version", s.handleAppVersionCheck)
}

// 平台白名单（固定枚举；android=APK 壳更新，win=PC electron-updater）
var appVerPlatforms = map[string]bool{"android": true, "win": true}

// appVerDownloadRoot 安装包存储根目录（<WebDir>/static/download，静态服务天然托管）
func (s *Server) appVerDownloadRoot() string {
	return filepath.Join(s.cfg.WebDir, "static", "download")
}

// appVerPkgMaxSize 安装包上传大小上限（字节，读配置兜底 512MB）
func (s *Server) appVerPkgMaxSize() int64 {
	if s.cfg.AppPkgMaxSize > 0 {
		return s.cfg.AppPkgMaxSize
	}
	return 512 << 20
}

// appVerSanitizeVersion 版本名净化（仅保留字母数字点横线下划线，防文件名注入）
var appVerNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func appVerSanitizeVersion(v string) string {
	return appVerNameRe.ReplaceAllString(strings.TrimSpace(v), "")
}

// appVerSemverCompare 语义化版本比对（x.y.z 数值段逐位比较，多余段忽略；a>b 返回 1）
func appVerSemverCompare(a, b string) int {
	pa := strings.Split(a, ".")
	pb := strings.Split(b, ".")
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var va, vb int
		if i < len(pa) {
			va, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			vb, _ = strconv.Atoi(pb[i])
		}
		if va != vb {
			if va > vb {
				return 1
			}
			return -1
		}
	}
	return 0
}

// appVerEnabled 取指定平台当前生效版本（无则 nil）
func appVerEnabled(platform string) *model.AppVersion {
	var v model.AppVersion
	if err := store.DB.Where("platform = ? AND enabled = ?", platform, true).
		Order("id DESC").First(&v).Error; err != nil {
		return nil
	}
	return &v
}

// ===== latest.yml 生成（electron-updater generic feed 兼容） =====

// writeWinLatestYml 按 win 当前生效版本重写 latest.yml（生效版本变更归口调用）；
// 无生效版本时删除该文件（客户端检查 404 视为无更新，不会误触发）
func (s *Server) writeWinLatestYml() {
	path := filepath.Join(s.appVerDownloadRoot(), "win", "latest.yml")
	v := appVerEnabled("win")
	if v == nil {
		os.Remove(path)
		return
	}
	// electron-updater 期望的 latest.yml 字段（generic provider 按 url/path 相对本目录解析安装包）
	yml := fmt.Sprintf("version: %s\nfiles:\n  - url: %s\n    sha512: %s\n    size: %d\npath: %s\nsha512: %s\nreleaseDate: '%s'\n",
		v.VersionName, v.FileName, v.SHA512Base64, v.Size, v.FileName, v.SHA512Base64,
		v.UpdateTime.Format(time.RFC3339))
	if err := os.WriteFile(path, []byte(yml), 0o644); err != nil {
		logger.Error("latest.yml 生成失败: %v", err)
	}
}

// ===== 管理端 =====

// handleAdminAppVersionUpload 上传安装包并登记版本（multipart：file + platform/version_name/version_code/notes/force）
func (s *Server) handleAdminAppVersionUpload(w http.ResponseWriter, r *http.Request) {
	maxSize := s.appVerPkgMaxSize()
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		adminFail(w, http.StatusBadRequest, "文件过大或解析失败")
		return
	}
	platform := strings.TrimSpace(r.FormValue("platform"))
	if !appVerPlatforms[platform] {
		adminFail(w, http.StatusBadRequest, "平台参数不合法（仅 android / win）")
		return
	}
	versionName := appVerSanitizeVersion(r.FormValue("version_name"))
	if versionName == "" || len(versionName) > 32 {
		adminFail(w, http.StatusBadRequest, "版本号不合法（字母数字点横线，≤32 字符）")
		return
	}
	versionCode, _ := strconv.Atoi(r.FormValue("version_code"))
	if platform == "android" && versionCode <= 0 {
		adminFail(w, http.StatusBadRequest, "Android 版本须填写 versionCode（正整数）")
		return
	}
	if platform == "win" && appVerSemverCompare(versionName, "0") <= 0 {
		adminFail(w, http.StatusBadRequest, "PC 版本号须为语义化格式（如 1.2.0）")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		adminFail(w, http.StatusBadRequest, "缺少安装包文件")
		return
	}
	defer file.Close()
	// 扩展名白名单（与平台匹配）
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if platform == "android" && ext != ".apk" {
		adminFail(w, http.StatusBadRequest, "Android 安装包须为 .apk 文件")
		return
	}
	if platform == "win" && ext != ".exe" {
		adminFail(w, http.StatusBadRequest, "PC 安装包须为 .exe 文件")
		return
	}
	// 落盘文件名服务端归口生成（版本名已净化，防路径穿越；同版本重复上传覆盖旧文件）
	fileName := fmt.Sprintf("im-client-%s.%s", versionName, strings.TrimPrefix(ext, "."))
	if platform == "android" {
		fileName = fmt.Sprintf("imapp-%s-%d.apk", versionName, versionCode)
	}
	dir := filepath.Join(s.appVerDownloadRoot(), platform)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		adminFail(w, http.StatusInternalServerError, "存储目录创建失败")
		return
	}
	dst := filepath.Join(dir, fileName)
	out, err := os.Create(dst)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	// 流式落盘同步计算 sha256（APP 端下载校验）+ sha512 base64（PC latest.yml 校验），避免二次读大文件
	h256 := sha256.New()
	h512 := sha512.New()
	size, err := io.Copy(io.MultiWriter(out, h256, h512), file)
	out.Close()
	if err != nil {
		os.Remove(dst)
		adminFail(w, http.StatusInternalServerError, "文件写入失败")
		return
	}
	force := r.FormValue("force") == "1"
	notes := strings.TrimSpace(r.FormValue("notes"))
	if len([]rune(notes)) > 2000 {
		notes = string([]rune(notes)[:2000])
	}
	rec := model.AppVersion{
		Platform:     platform,
		VersionName:  versionName,
		VersionCode:  versionCode,
		FileName:     fileName,
		URL:          "/static/download/" + platform + "/" + fileName,
		Size:         size,
		SHA256:       hex.EncodeToString(h256.Sum(nil)),
		SHA512Base64: base64.StdEncoding.EncodeToString(h512.Sum(nil)),
		Notes:        notes,
		Force:        force,
		Enabled:      false, // 上传后默认未生效，管理员"启用"才对外下发（防误传即更新全员）
		Creator:      adminUserFromCtx(r),
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		os.Remove(dst)
		adminFail(w, http.StatusInternalServerError, "版本记录保存失败")
		return
	}
	logger.Info("客户端安装包已上传: id=%d 平台=%s 版本=%s(%d) 大小=%d 强制=%v 操作人=%s",
		rec.ID, platform, versionName, versionCode, size, force, rec.Creator)
	adminJSON(w, map[string]interface{}{"id": rec.ID})
}

// handleAdminAppVersionList 版本列表（平台筛选，新在前）
func (s *Server) handleAdminAppVersionList(w http.ResponseWriter, r *http.Request) {
	db := store.DB.Model(&model.AppVersion{})
	if p := r.URL.Query().Get("platform"); appVerPlatforms[p] {
		db = db.Where("platform = ?", p)
	}
	var list []model.AppVersion
	if err := db.Order("id DESC").Limit(200).Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询版本列表失败")
		return
	}
	adminJSON(w, map[string]interface{}{"list": list})
}

// handleAdminAppVersionEnable 启用指定版本（同平台其余自动停用；win 启用后重写 latest.yml）
func (s *Server) handleAdminAppVersionEnable(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var v model.AppVersion
	if err := store.DB.First(&v, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本记录不存在")
		return
	}
	if err := store.DB.Model(&model.AppVersion{}).Where("platform = ? AND id <> ?", v.Platform, v.ID).
		Update("enabled", false).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "停用旧版本失败")
		return
	}
	if err := store.DB.Model(&v).Update("enabled", true).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "启用版本失败")
		return
	}
	if v.Platform == "win" {
		s.writeWinLatestYml()
	}
	logger.Info("客户端版本已启用: id=%d 平台=%s 版本=%s 操作人=%s", v.ID, v.Platform, v.VersionName, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminAppVersionDelete 删除版本（记录+安装包文件；同名文件被其他记录引用时保留文件；win 删除后重写 latest.yml）
func (s *Server) handleAdminAppVersionDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var v model.AppVersion
	if err := store.DB.First(&v, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本记录不存在")
		return
	}
	store.DB.Delete(&v)
	// 文件清理：仅当无其他记录引用同名文件时删除本体（同版本重复上传共享文件名）
	var refCount int64
	store.DB.Model(&model.AppVersion{}).Where("platform = ? AND file_name = ?", v.Platform, v.FileName).Count(&refCount)
	if refCount == 0 {
		os.Remove(filepath.Join(s.appVerDownloadRoot(), v.Platform, v.FileName))
	}
	if v.Platform == "win" && v.Enabled {
		s.writeWinLatestYml()
	}
	logger.Info("客户端版本已删除: id=%d 平台=%s 版本=%s 操作人=%s", v.ID, v.Platform, v.VersionName, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// ===== 客户端检查 =====

// handleAppVersionCheck 版本检查公开接口：
// GET /api/app/version?platform=android&code=<当前versionCode>
// GET /api/app/version?platform=win&name=<当前versionName>
// 返回 {has_update, version_name, version_code, url, size, sha256, notes, force, file_name}
func (s *Server) handleAppVersionCheck(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	platform := strings.TrimSpace(q.Get("platform"))
	if !appVerPlatforms[platform] {
		adminFail(w, http.StatusBadRequest, "平台参数不合法")
		return
	}
	resp := map[string]interface{}{"has_update": false}
	v := appVerEnabled(platform)
	if v == nil {
		adminJSON(w, resp)
		return
	}
	// 比对：android 整型 versionCode；win 语义化版本字符串
	hasUpdate := false
	if platform == "android" {
		cur, _ := strconv.Atoi(q.Get("code"))
		hasUpdate = v.VersionCode > cur
	} else {
		cur := appVerSanitizeVersion(q.Get("name"))
		hasUpdate = cur == "" || appVerSemverCompare(v.VersionName, cur) > 0
	}
	resp["has_update"] = hasUpdate
	// 版本信息始终返回（客户端"检查更新"手动场景展示当前最新版本）
	resp["version_name"] = v.VersionName
	resp["version_code"] = v.VersionCode
	resp["url"] = v.URL
	resp["size"] = v.Size
	resp["sha256"] = v.SHA256
	resp["notes"] = v.Notes
	resp["force"] = v.Force
	resp["file_name"] = v.FileName
	adminJSON(w, resp)
}
