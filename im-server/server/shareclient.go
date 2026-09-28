package server

// ===== 分享页客户端下载链接后台维护（阶段一百九十八扩展） =====
// 分享页（/s/<code>）顶栏「客户端下载」浮层的双端安装包链接归后台可配置：
// 默认走服务端静态托管 /static/download/（web/static/download 目录，FileServer 原生下发），
// 管理员可改为完整 http(s) 外链（外置 CDN/对象存储直链），保存即生效 + DB 落库重启不丢。
// DB 归口：AgentWhitelist 全局 kv 行（kind=share_client_dl，value=JSON），与 drive_edge_auth 同款；
// 公开读取接口供分享页访客动态拉取（无登录态，仅两个 URL 字符串无敏感信息）。

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

const shareClientDlKind = "share_client_dl"

// 默认链接（与管理端/分享页 HTML 静态兜底同口径：静态托管归口 web/static/download/）
const (
	shareClientPcDefault  = "/static/download/im-client.exe"
	shareClientApkDefault = "/static/download/im-client.apk"
)

var (
	shareClientMu     sync.Mutex
	shareClientPcURL  string // Windows 安装包链接（相对根路径或 http(s) 完整外链）
	shareClientApkURL string // Android 安装包链接
	shareClientInited bool
)

// shareClientDlInit 设置惰性初始化（持锁调用）：内存默认打底 → DB 后台覆盖值优先。
// 无 yaml 项（纯运营配置，首次启动即默认静态托管路径）
func shareClientDlInit() {
	if shareClientInited {
		return
	}
	shareClientInited = true
	shareClientPcURL, shareClientApkURL = shareClientPcDefault, shareClientApkDefault
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", shareClientDlKind, "").First(&row).Error; err == nil {
		var ov struct {
			PcURL  string `json:"pc_url"`
			ApkURL string `json:"apk_url"`
		}
		if json.Unmarshal([]byte(row.Value), &ov) == nil {
			if v := normalizeShareDlURL(ov.PcURL, shareClientPcDefault); v != "" {
				shareClientPcURL = v
			}
			if v := normalizeShareDlURL(ov.ApkURL, shareClientApkDefault); v != "" {
				shareClientApkURL = v
			}
		}
	}
}

// normalizeShareDlURL 链接归一：空=回默认；仅放行相对根路径（/ 开头）与 http(s) 完整外链，
// 其余（javascript:/data: 等危险协议）拒收回默认——分享页 href 注入防线
func normalizeShareDlURL(raw, def string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def
	}
	low := strings.ToLower(raw)
	if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") || strings.HasPrefix(raw, "/") {
		if len(raw) <= 500 {
			return raw
		}
	}
	return def
}

// handleShareClientDlGet 公开读取（分享页加载时动态拉取）：GET /api/share/client-dl
func handleShareClientDlGet(w http.ResponseWriter, r *http.Request) {
	shareClientMu.Lock()
	shareClientDlInit()
	pc, apk := shareClientPcURL, shareClientApkURL
	shareClientMu.Unlock()
	adminJSON(w, map[string]interface{}{"pc_url": pc, "apk_url": apk})
}

// handleAdminShareClientDlGet 管理端读取：GET /admin/api/share/clientdl
func (s *Server) handleAdminShareClientDlGet(w http.ResponseWriter, r *http.Request) {
	shareClientMu.Lock()
	shareClientDlInit()
	pc, apk := shareClientPcURL, shareClientApkURL
	shareClientMu.Unlock()
	source := "default"
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", shareClientDlKind, "").First(&row).Error; err == nil {
		source = "override"
	}
	adminJSON(w, map[string]interface{}{"pc_url": pc, "apk_url": apk, "source": source})
}

// handleAdminShareClientDlSave 管理端保存：PUT /admin/api/share/clientdl
// 请求体 {"pc_url":"...","apk_url":"..."}；空串=恢复默认静态托管路径；保存即生效 + 落库重启不丢
func (s *Server) handleAdminShareClientDlSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PcURL  string `json:"pc_url"`
		ApkURL string `json:"apk_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "请求格式错误"})
		return
	}
	// 非空输入先精确校验（区分"清空恢复默认"与"填了非法值"），归一兜底再走一次
	if !isShareDlAllowed(req.PcURL) {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "Windows 链接无效：须为 / 开头相对路径或 http(s):// 完整外链，留空=恢复默认"})
		return
	}
	if !isShareDlAllowed(req.ApkURL) {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "Android 链接无效：须为 / 开头相对路径或 http(s):// 完整外链，留空=恢复默认"})
		return
	}
	pc := normalizeShareDlURL(req.PcURL, shareClientPcDefault)
	apk := normalizeShareDlURL(req.ApkURL, shareClientApkDefault)
	val, _ := json.Marshal(map[string]string{"pc_url": pc, "apk_url": apk})
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", shareClientDlKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", string(val)).Error; err != nil {
			adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
			return
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: shareClientDlKind, Value: string(val)}).Error; err != nil {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
		return
	}
	shareClientMu.Lock()
	shareClientPcURL, shareClientApkURL = pc, apk
	shareClientMu.Unlock()
	logger.Info("分享页客户端下载链接更新: pc=%s apk=%s", pc, apk)
	adminJSON(w, map[string]interface{}{"ok": true, "pc_url": pc, "apk_url": apk})
}

// isShareDlAllowed 原始输入是否为受支持的链接形态（管理端精确报错用；归一失败时区分"填了非法值"与"清空恢复默认"）
func isShareDlAllowed(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true
	}
	low := strings.ToLower(raw)
	if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") || strings.HasPrefix(raw, "/") {
		return len(raw) <= 500
	}
	return false
}
