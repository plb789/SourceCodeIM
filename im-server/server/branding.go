package server

// ===== 品牌信息后台统一归口（阶段二百七十六扩展） =====
// 单位名称归后台可配置：登录页「安全接入」、登录/注册页版权行、设置页「关于-单位」
// 等展示位统一从本归口拉取，管理员后台改一处全端生效。
// 默认值=历史硬编码文案（客户端静态兜底同口径，接口不可达时页面原样显示不受影响）。
// DB 归口：AgentWhitelist 全局 kv 行（kind=branding，value=JSON），与 share_client_dl 同款；
// 公开读取接口供登录/注册页访客动态拉取（无登录态，仅一个单位名称字符串无敏感信息）。

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

const brandingKind = "branding"

// 单位名称默认值（与客户端 HTML 静态兜底文案一致；清空=恢复默认）
const brandingCompanyDefault = "山西梗阳新能源有限公司"

// 单位名称长度上限（UTF-8 字符数，防误填超长文本破坏页面排版）
const brandingCompanyMax = 60

var (
	brandingMu      sync.Mutex
	brandingCompany string
	brandingInited  bool
)

// brandingInit 设置惰性初始化（持锁调用）：内存默认打底 → DB 后台覆盖值优先。
// 无 yaml 项（纯运营配置，首次启动即默认文案）
func brandingInit() {
	if brandingInited {
		return
	}
	brandingInited = true
	brandingCompany = brandingCompanyDefault
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", brandingKind, "").First(&row).Error; err == nil {
		var ov struct {
			Company string `json:"company"`
		}
		if json.Unmarshal([]byte(row.Value), &ov) == nil {
			brandingCompany = normalizeBrandingCompany(ov.Company)
		}
	}
}

// normalizeBrandingCompany 单位名称归一：空=回默认；仅剔除首尾空白与换行
// （页面单行展示位，含换行必破坏排版），客户端以 textContent 渲染无注入面
func normalizeBrandingCompany(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.ReplaceAll(raw, "\r", " ")
	raw = strings.ReplaceAll(raw, "\n", " ")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return brandingCompanyDefault
	}
	return raw
}

// isBrandingAllowed 原始输入是否受支持（管理端精确报错用；区分"清空恢复默认"与"填了非法值"）
func isBrandingAllowed(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true
	}
	if utf8.RuneCountInString(raw) > brandingCompanyMax {
		return false
	}
	return !strings.ContainsAny(raw, "\r\n")
}

// handleBrandingPublicGet 公开读取（登录/注册页加载时动态拉取）：GET /api/branding
func handleBrandingPublicGet(w http.ResponseWriter, r *http.Request) {
	brandingMu.Lock()
	brandingInit()
	company := brandingCompany
	brandingMu.Unlock()
	adminJSON(w, map[string]interface{}{"company": company})
}

// handleAdminBrandingGet 管理端读取：GET /admin/api/branding
func (s *Server) handleAdminBrandingGet(w http.ResponseWriter, r *http.Request) {
	brandingMu.Lock()
	brandingInit()
	company := brandingCompany
	brandingMu.Unlock()
	source := "default"
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", brandingKind, "").First(&row).Error; err == nil {
		source = "override"
	}
	adminJSON(w, map[string]interface{}{"company": company, "source": source})
}

// handleAdminBrandingSave 管理端保存：PUT /admin/api/branding
// 请求体 {"company":"..."}；空串=恢复默认文案；保存即生效 + 落库重启不丢
func (s *Server) handleAdminBrandingSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Company string `json:"company"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "请求格式错误"})
		return
	}
	if !isBrandingAllowed(req.Company) {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "单位名称无效：不能含换行且不超过 " + strconv.Itoa(brandingCompanyMax) + " 个字符，留空=恢复默认"})
		return
	}
	company := normalizeBrandingCompany(req.Company)
	val, _ := json.Marshal(map[string]string{"company": company})
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", brandingKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", string(val)).Error; err != nil {
			adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
			return
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: brandingKind, Value: string(val)}).Error; err != nil {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
		return
	}
	brandingMu.Lock()
	brandingCompany = company
	brandingMu.Unlock()
	logger.Info("品牌信息更新: 单位=%s", company)
	adminJSON(w, map[string]interface{}{"ok": true, "company": company})
}
