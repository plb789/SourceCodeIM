package server

// ===== 客户端功能开关后台统一归口（阶段二百九十五扩展） =====
// 客户端界面入口（游戏中心/工作台等）显隐归后台可配：管理员关闭后各端入口隐藏。
// 通用 kv 设计（kind=ui_features，value=JSON {开关名:bool}）：新增开关仅需 admin 页加控件 +
// 客户端加应用点，服务端结构零改动；缺字段=true（默认显示，向后兼容旧缓存/旧客户端）。
// DB 归口：AgentWhitelist 全局 kv 行，与 branding/share_client_dl 同款；保存即热生效 + 落库重启不丢。
// 公开读取接口供客户端页面加载时拉取（无登录态，仅入口显隐布尔无敏感信息）；
// 客户端 localStorage 缓存兜底（接口不可达沿用上次值，首次失败=全部显示，安全侧）。

import (
	"encoding/json"
	"net/http"
	"sync"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

const uiFeaturesKind = "ui_features"

var (
	uiFeaturesMu      sync.Mutex
	uiFeaturesVals    map[string]bool
	uiFeaturesInited  bool
)

// featurePayload 开关快照（GET 响应与保存回执共用归口）。
// 新增开关：在此补字段 + 默认 true 即可（kv 全量覆盖存储，无需迁移）
func featurePayload() map[string]interface{} {
	return map[string]interface{}{
		"game_center": uiFeatureOn("game_center"),
		"workbench":   uiFeatureOn("workbench"),
	}
}

// uiFeatureOn 开关读取：缺字段/未初始化=true（默认显示；显式 false 才隐藏）
func uiFeatureOn(name string) bool {
	if uiFeaturesVals == nil {
		return true
	}
	v, ok := uiFeaturesVals[name]
	return !ok || v
}

// uiFeaturesInit 惰性初始化（持锁调用）：内存默认全开打底 → DB 后台覆盖值优先。
// 无 yaml 项（纯运营配置，首次启动即全开）
func uiFeaturesInit() {
	if uiFeaturesInited {
		return
	}
	uiFeaturesInited = true
	uiFeaturesVals = map[string]bool{}
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", uiFeaturesKind, "").First(&row).Error; err == nil {
		var ov map[string]bool
		if json.Unmarshal([]byte(row.Value), &ov) == nil && ov != nil {
			uiFeaturesVals = ov
		}
	}
}

// handleFeaturesPublicGet 公开读取（客户端页面加载时拉取）：GET /api/features
func handleFeaturesPublicGet(w http.ResponseWriter, r *http.Request) {
	uiFeaturesMu.Lock()
	uiFeaturesInit()
	payload := featurePayload()
	uiFeaturesMu.Unlock()
	adminJSON(w, payload)
}

// handleAdminFeaturesGet 管理端读取：GET /admin/api/features
func (s *Server) handleAdminFeaturesGet(w http.ResponseWriter, r *http.Request) {
	uiFeaturesMu.Lock()
	uiFeaturesInit()
	payload := featurePayload()
	source := "default"
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", uiFeaturesKind, "").First(&row).Error; err == nil {
		source = "override"
	}
	uiFeaturesMu.Unlock()
	payload["source"] = source
	adminJSON(w, payload)
}

// handleAdminFeaturesSave 管理端保存：PUT /admin/api/features
// 请求体 {"game_center":true,"workbench":false}（全量 bool 集合）；保存即生效 + 落库重启不丢
func (s *Server) handleAdminFeaturesSave(w http.ResponseWriter, r *http.Request) {
	var req map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "请求格式错误"})
		return
	}
	// 已知开关逐项归一（非 bool 值拒绝，防误传字符串"false"翻转语义）
	known := map[string]bool{"game_center": true, "workbench": true}
	vals := map[string]bool{}
	for k := range known {
		raw, ok := req[k]
		if !ok {
			continue // 字段缺省=保持现值
		}
		b, isBool := raw.(bool)
		if !isBool {
			adminJSON(w, map[string]interface{}{"ok": false, "msg": "开关 " + k + " 须为布尔值"})
			return
		}
		vals[k] = b
	}
	uiFeaturesMu.Lock()
	uiFeaturesInit()
	for k, v := range vals {
		uiFeaturesVals[k] = v
	}
	val, _ := json.Marshal(uiFeaturesVals)
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", uiFeaturesKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", string(val)).Error; err != nil {
			uiFeaturesMu.Unlock()
			adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
			return
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: uiFeaturesKind, Value: string(val)}).Error; err != nil {
		uiFeaturesMu.Unlock()
		adminJSON(w, map[string]interface{}{"ok": false, "msg": "保存失败：" + err.Error()})
		return
	}
	payload := featurePayload()
	uiFeaturesMu.Unlock()
	logger.Info("客户端功能开关更新: %v", vals)
	adminJSON(w, map[string]interface{}{"ok": true, "features": payload})
}
