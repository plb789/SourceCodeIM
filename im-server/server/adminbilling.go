package server

// 阶段一百三十八：AI 计费模式后台设置（GET/PUT /admin/api/billing/settings）
// 归口 aibilling.go（usage 按量 / percall 按次 TRAE CN 同款）；保存即生效 + 落库重启不丢，
// 刻意不回写 config.yaml（注释会丢）：yaml 值仅作 DB 无记录时的初始默认（与 Agent 参数同策略）

import (
	"encoding/json"
	"im-server/logger"
	"net/http"
)

// billingSettingPut PUT /admin/api/billing/settings 请求体（指针=nil=不修改，部分更新）
type billingSettingPut struct {
	Mode        *string  `json:"mode"`         // "usage"=按量 | "percall"=按次（TRAE CN 同款）
	PercallCost *float64 `json:"percall_cost"` // 按次单价（积分；仅 percall 模式实际扣费时使用）
}

// handleAdminBillingSettingsGet GET：当前生效计费配置（mode / percall_cost / source 来源标注）
func (s *Server) handleAdminBillingSettingsGet(w http.ResponseWriter, r *http.Request) {
	cfg := aiBillingGet()
	adminJSON(w, map[string]interface{}{
		"mode":         cfg.Mode,
		"percall_cost": cfg.PercallCost,
		"source":       aiBillingSource(), // override=后台设置（DB 真源）/ config=config.yaml 初始默认
	})
}

// handleAdminBillingSettingsSave PUT：保存计费模式/单价（部分更新；保存后返回生效快照）
func (s *Server) handleAdminBillingSettingsSave(w http.ResponseWriter, r *http.Request) {
	var req billingSettingPut
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 当前生效值作基底（只传 mode 不改单价 / 只传单价不改模式）
	cur := aiBillingGet()
	mode := cur.Mode
	if req.Mode != nil {
		mode = *req.Mode
	}
	cost := cur.PercallCost
	if req.PercallCost != nil {
		cost = *req.PercallCost
	}
	cfg, err := aiBillingSetOverride(mode, cost)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	logger.Info("后台管理：管理员 %s 修改 AI 计费设置（模式 %s，按次单价 %.3f 积分）", adminUserFromCtx(r), cfg.Mode, cfg.PercallCost)
	adminJSON(w, map[string]interface{}{"ok": true, "mode": cfg.Mode, "percall_cost": cfg.PercallCost})
}
