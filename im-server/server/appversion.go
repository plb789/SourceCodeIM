package server

// ===== 阶段二百六十：客户端自动更新——版本管理模块（APP/PC 共用一套服务端归口） =====
// 设计归口：
//  1. 维护侧：admin 后台上传安装包（APK / PC Setup exe）走 /admin/api/appversion*，复用 adminGuard 鉴权；
//     安装包落盘 <WebDir>/static/download/<platform>/，服务端静态服务（main.go fileServer）天然托管，
//     URL 直接可下载，零新增下载路由；亦支持"外部 URL"模式——multipart 仅携带 url 字段（大文件免上传，
//     直填 OSS/网盘完整地址存库下发），size/sha256/sha512_b64 选填（PC 因 electron-updater 校验
//     硬约束须 sha512/sha256 二者其一，见其 Provider.resolveFiles 缺两者即 ERR_UPDATER_NO_CHECKSUM）；
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
	"mime/multipart"
	"net/http"
	"net/url"
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
	http.HandleFunc("PUT /admin/api/appversion/{id}", s.adminGuard(s.handleAdminAppVersionUpdate))
	http.HandleFunc("DELETE /admin/api/appversion/{id}", s.adminGuard(s.handleAdminAppVersionDelete))
	// 客户端公开检查（无用户态，只读）
	http.HandleFunc("GET /api/app/version", s.handleAppVersionCheck)
	// 启动自愈：按当前生效 win 版本重建 latest.yml（历史部署目录缺失/文件丢失时免人工重启用）
	s.writeWinLatestYml()
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

// appVerIsExternal 外链版本判定（URL 为完整 http/https 地址，非本站静态相对路径）
func appVerIsExternal(v *model.AppVersion) bool {
	return strings.HasPrefix(v.URL, "http://") || strings.HasPrefix(v.URL, "https://")
}

// writeWinLatestYml 按 win 当前生效版本重写 latest.yml（生效版本变更归口调用）；
// 无生效版本时删除该文件（客户端检查 404 视为无更新，不会误触发）
func (s *Server) writeWinLatestYml() {
	path := filepath.Join(s.appVerDownloadRoot(), "win", "latest.yml")
	v := appVerEnabled("win")
	if v == nil {
		os.Remove(path)
		return
	}
	// electron-updater 期望的 latest.yml 字段：files[0].url 经 new URL(url, baseUrl) 解析，
	// 完整外链绝对地址优先直接生效；校验和 sha512 缺省时降级 sha2（resolveFiles 对二者有其一即可）
	fileURL := v.FileName
	if appVerIsExternal(v) {
		fileURL = v.URL
	}
	var b strings.Builder
	b.WriteString("version: " + v.VersionName + "\nfiles:\n  - url: ")
	if appVerIsExternal(v) {
		b.WriteString(strconv.Quote(fileURL)) // 外链加引号防 YAML 特殊字符截断
	} else {
		b.WriteString(fileURL)
	}
	b.WriteString("\n")
	if v.SHA512Base64 != "" {
		b.WriteString("    sha512: " + v.SHA512Base64 + "\n")
	} else if v.SHA256 != "" {
		b.WriteString("    sha2: " + v.SHA256 + "\n")
	}
	b.WriteString(fmt.Sprintf("    size: %d\npath: %s\n", v.Size, v.FileName))
	if v.SHA512Base64 != "" {
		b.WriteString("sha512: " + v.SHA512Base64 + "\n")
	} else if v.SHA256 != "" {
		b.WriteString("sha2: " + v.SHA256 + "\n")
	}
	b.WriteString("releaseDate: '" + v.UpdateTime.Format(time.RFC3339) + "'\n")
	// 目录兜底：外链登记模式从不落盘安装包（无 MkdirAll 时机），win 目录可能不存在，
	// 直接 WriteFile 会因目录缺失失败（仅留一行日志），客户端检查 latest.yml 即 404
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		logger.Error("latest.yml 目录创建失败: %v", err)
		return
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		logger.Error("latest.yml 生成失败: %v", err)
	}
}

// ===== 管理端 =====

// handleAdminAppVersionUpload 登记新版本（双模式归口）：
//  1. 上传模式：multipart 携带 file——现有流程，落盘 + 流式哈希；
//  2. 外链模式：仅携带 url（大文件免上传，直填 OSS/网盘完整地址），size/sha256/sha512_b64 选填，
//     PC 平台因 electron-updater 校验硬约束须 sha512/sha256 二者其一。
//
// 公共参数：platform/version_name/version_code/notes/force
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
	force := r.FormValue("force") == "1"
	notes := strings.TrimSpace(r.FormValue("notes"))
	if len([]rune(notes)) > 2000 {
		notes = string([]rune(notes)[:2000])
	}
	// 双模式分流：有 file 走上传落盘；否则有 url 走外链登记；二者皆无拒绝
	file, header, err := r.FormFile("file")
	if err == nil {
		defer file.Close()
		s.appVerUploadFileMode(w, r, platform, versionName, versionCode, force, notes, header, file)
		return
	}
	extURL := strings.TrimSpace(r.FormValue("url"))
	if extURL == "" {
		adminFail(w, http.StatusBadRequest, "缺少安装包文件或外链 URL")
		return
	}
	s.appVerRegisterExternal(w, r, platform, versionName, versionCode, force, notes, extURL)
}

// appVerUploadFileMode 上传模式：落盘安装包并登记（文件名服务端归口生成，流式同步算 sha256/sha512）
func (s *Server) appVerUploadFileMode(w http.ResponseWriter, r *http.Request, platform, versionName string, versionCode int, force bool, notes string, header *multipart.FileHeader, file multipart.File) {
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

// appVerSHA256Re sha256 十六进制摘要格式
var appVerSHA256Re = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// appVerRegisterExternal 外链登记：URL 存库不落盘（安装包由外部源站直供，服务器零存储压力）
func (s *Server) appVerRegisterExternal(w http.ResponseWriter, r *http.Request, platform, versionName string, versionCode int, force bool, notes, extURL string) {
	u, err := url.Parse(extURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		adminFail(w, http.StatusBadRequest, "外链 URL 不合法（须为 http/https 完整地址）")
		return
	}
	// 扩展名白名单（与平台匹配，按 URL 路径末段判断）
	ext := strings.ToLower(filepath.Ext(u.Path))
	if platform == "android" && ext != ".apk" {
		adminFail(w, http.StatusBadRequest, "Android 外链须指向 .apk 文件")
		return
	}
	if platform == "win" && ext != ".exe" {
		adminFail(w, http.StatusBadRequest, "PC 外链须指向 .exe 文件")
		return
	}
	// 校验和选填（格式校验）；PC 强约束：electron-updater resolveFiles 缺 sha512/sha2 直接拒绝更新
	sha256Hex := strings.ToLower(strings.TrimSpace(r.FormValue("sha256")))
	if sha256Hex != "" && !appVerSHA256Re.MatchString(sha256Hex) {
		adminFail(w, http.StatusBadRequest, "sha256 须为 64 位十六进制摘要")
		return
	}
	sha512B64 := strings.TrimSpace(r.FormValue("sha512_b64"))
	if sha512B64 != "" {
		if raw, derr := base64.StdEncoding.DecodeString(sha512B64); derr != nil || len(raw) != 64 {
			adminFail(w, http.StatusBadRequest, "sha512 须为 base64 编码的 64 字节摘要")
			return
		}
	}
	if platform == "win" && sha512B64 == "" && sha256Hex == "" {
		adminFail(w, http.StatusBadRequest, "PC 外链须提供 sha512（base64）或 sha256（hex）校验和（electron-updater 下载校验硬约束）")
		return
	}
	var size int64
	if sv := strings.TrimSpace(r.FormValue("size")); sv != "" {
		size, err = strconv.ParseInt(sv, 10, 64)
		if err != nil || size < 0 {
			adminFail(w, http.StatusBadRequest, "文件大小须为非负整数（字节）")
			return
		}
	}
	// 文件名取外链路径末段净化（APP 端落盘名复用；空/异常回退版本名默认名）
	fileName := u.Path
	if i := strings.LastIndexByte(fileName, '/'); i >= 0 {
		fileName = fileName[i+1:]
	}
	fileName = appVerSanitizeVersion(fileName)
	if fileName == "" || fileName == "." {
		if platform == "android" {
			fileName = fmt.Sprintf("imapp-%s-%d.apk", versionName, versionCode)
		} else {
			fileName = fmt.Sprintf("im-client-%s.exe", versionName)
		}
	}
	rec := model.AppVersion{
		Platform:     platform,
		VersionName:  versionName,
		VersionCode:  versionCode,
		FileName:     fileName,
		URL:          extURL,
		Size:         size,
		SHA256:       sha256Hex,
		SHA512Base64: sha512B64,
		Notes:        notes,
		Force:        force,
		Enabled:      false, // 与上传模式一致，默认未生效，"启用"才对外下发
		Creator:      adminUserFromCtx(r),
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "版本记录保存失败")
		return
	}
	logger.Info("客户端版本已登记外链: id=%d 平台=%s 版本=%s(%d) url=%s 强制=%v 操作人=%s",
		rec.ID, platform, versionName, versionCode, extURL, force, rec.Creator)
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

// handleAdminAppVersionUpdate 编辑已登记版本（不换文件）：
//  1. 公共可改：版本名 / versionCode / 更新说明 / 强制标记；
//  2. 外链记录可改：URL/校验和/大小（重走登记校验，文件名跟随新 URL 末段）；
//  3. 上传记录锁定：安装包本体与文件衍生字段（file_name/url/sha/size）不可改，拒绝携带文件——
//     如需更换安装包请删除该版本后重新上传；
//  4. win 生效版本编辑后重写 latest.yml（版本名/URL/校验和/大小变更需同步给 electron-updater）。
func (s *Server) handleAdminAppVersionUpdate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	var v model.AppVersion
	if err := store.DB.First(&v, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "版本记录不存在")
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		adminFail(w, http.StatusBadRequest, "参数解析失败")
		return
	}
	if _, _, err := r.FormFile("file"); err == nil {
		adminFail(w, http.StatusBadRequest, "安装包文件不可在线更换，如需更换请删除该版本后重新上传")
		return
	}
	versionName := appVerSanitizeVersion(r.FormValue("version_name"))
	if versionName == "" || len(versionName) > 32 {
		adminFail(w, http.StatusBadRequest, "版本号不合法（字母数字点横线，≤32 字符）")
		return
	}
	versionCode, _ := strconv.Atoi(r.FormValue("version_code"))
	if v.Platform == "android" && versionCode <= 0 {
		adminFail(w, http.StatusBadRequest, "Android 版本须填写 versionCode（正整数）")
		return
	}
	if v.Platform == "win" && appVerSemverCompare(versionName, "0") <= 0 {
		adminFail(w, http.StatusBadRequest, "PC 版本号须为语义化格式（如 1.2.0）")
		return
	}
	force := r.FormValue("force") == "1"
	notes := strings.TrimSpace(r.FormValue("notes"))
	if len([]rune(notes)) > 2000 {
		notes = string([]rune(notes)[:2000])
	}
	v.VersionName = versionName
	v.VersionCode = versionCode
	v.Force = force
	v.Notes = notes
	if appVerIsExternal(&v) {
		// 外链记录：URL/校验和/大小可改，校验规则与登记一致（平台不变）
		extURL := strings.TrimSpace(r.FormValue("url"))
		if extURL == "" {
			adminFail(w, http.StatusBadRequest, "缺少外链 URL")
			return
		}
		u, err := url.Parse(extURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			adminFail(w, http.StatusBadRequest, "外链 URL 不合法（须为 http/https 完整地址）")
			return
		}
		ext := strings.ToLower(filepath.Ext(u.Path))
		if v.Platform == "android" && ext != ".apk" {
			adminFail(w, http.StatusBadRequest, "Android 外链须指向 .apk 文件")
			return
		}
		if v.Platform == "win" && ext != ".exe" {
			adminFail(w, http.StatusBadRequest, "PC 外链须指向 .exe 文件")
			return
		}
		sha256Hex := strings.ToLower(strings.TrimSpace(r.FormValue("sha256")))
		if sha256Hex != "" && !appVerSHA256Re.MatchString(sha256Hex) {
			adminFail(w, http.StatusBadRequest, "sha256 须为 64 位十六进制摘要")
			return
		}
		sha512B64 := strings.TrimSpace(r.FormValue("sha512_b64"))
		if sha512B64 != "" {
			if raw, derr := base64.StdEncoding.DecodeString(sha512B64); derr != nil || len(raw) != 64 {
				adminFail(w, http.StatusBadRequest, "sha512 须为 base64 编码的 64 字节摘要")
				return
			}
		}
		if v.Platform == "win" && sha512B64 == "" && sha256Hex == "" {
			adminFail(w, http.StatusBadRequest, "PC 外链须提供 sha512（base64）或 sha256（hex）校验和（electron-updater 下载校验硬约束）")
			return
		}
		var size int64
		if sv := strings.TrimSpace(r.FormValue("size")); sv != "" {
			size, err = strconv.ParseInt(sv, 10, 64)
			if err != nil || size < 0 {
				adminFail(w, http.StatusBadRequest, "文件大小须为非负整数（字节）")
				return
			}
		}
		v.URL = extURL
		v.SHA256 = sha256Hex
		v.SHA512Base64 = sha512B64
		v.Size = size
		// 文件名跟随新外链路径末段（净化；异常回退版本默认名）
		fileName := u.Path
		if i := strings.LastIndexByte(fileName, '/'); i >= 0 {
			fileName = fileName[i+1:]
		}
		fileName = appVerSanitizeVersion(fileName)
		if fileName == "" || fileName == "." {
			if v.Platform == "android" {
				fileName = fmt.Sprintf("imapp-%s-%d.apk", versionName, versionCode)
			} else {
				fileName = fmt.Sprintf("im-client-%s.exe", versionName)
			}
		}
		v.FileName = fileName
	}
	if err := store.DB.Save(&v).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "版本记录保存失败")
		return
	}
	if v.Platform == "win" && v.Enabled {
		s.writeWinLatestYml() // 生效版本的版本名/URL/校验和/大小变更同步 latest.yml
	}
	logger.Info("客户端版本已编辑: id=%d 平台=%s 版本=%s(%d) 操作人=%s", v.ID, v.Platform, v.VersionName, v.VersionCode, adminUserFromCtx(r))
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
