package server

// 阶段一百三十九：Agent 任务历史压缩方式后台设置（GET/PUT /admin/api/compress/settings）
// 归口 aicompresscfg.go（tokens 估算 / kb 字节双口径可选）；保存即生效 + 落库重启不丢，
// 刻意不回写 config.yaml（注释会丢）：yaml 启动值仅作 DB 无记录时的初始默认（与 AI 计费设置同策略）

import (
	"encoding/json"
	"im-server/logger"
	"net/http"
)

// compressSettingPut PUT /admin/api/compress/settings 请求体（指针=nil=不修改，部分更新）
type compressSettingPut struct {
	Mode   *string `json:"mode"`   // "tokens"=估算 token 口径 | "kb"=KB 字节口径（TRAE CN 同款）
	Tokens *int    `json:"tokens"` // tokens 口径触发阈值（估算 token）
	KB     *int    `json:"kb"`     // kb 口径触发阈值（KB）
}

// handleAdminCompressSettingsGet GET：当前生效压缩配置（mode / tokens / kb / source 来源标注）
func (s *Server) handleAdminCompressSettingsGet(w http.ResponseWriter, r *http.Request) {
	cfg := aiCompressCfgGet()
	adminJSON(w, map[string]interface{}{
		"mode":   cfg.Mode,
		"tokens": cfg.Tokens,
		"kb":     cfg.KB,
		"source": aiCompressCfgSource(), // override=后台设置（DB 真源）/ config=config.yaml 初始默认
	})
}

// handleAdminCompressSettingsSave PUT：保存压缩方式/阈值（部分更新；保存后返回生效快照，下一轮模型调用即热生效）
func (s *Server) handleAdminCompressSettingsSave(w http.ResponseWriter, r *http.Request) {
	var req compressSettingPut
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	// 当前生效值作基底（只传 mode 不改阈值 / 只改某一阈值不动另一口径）
	cur := aiCompressCfgGet()
	mode := cur.Mode
	if req.Mode != nil {
		mode = *req.Mode
	}
	tokens := cur.Tokens
	if req.Tokens != nil {
		tokens = *req.Tokens
	}
	kb := cur.KB
	if req.KB != nil {
		kb = *req.KB
	}
	if mode == "kb" && kb <= 0 {
		adminFail(w, http.StatusBadRequest, "KB 阈值必须大于 0")
		return
	}
	if mode == "tokens" && tokens <= 0 {
		adminFail(w, http.StatusBadRequest, "Token 阈值必须大于 0")
		return
	}
	cfg, err := aiCompressCfgSetOverride(mode, tokens, kb)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	logger.Info("后台管理：管理员 %s 修改历史压缩设置（口径 %s，tokens 阈值 %d，KB 阈值 %d）", adminUserFromCtx(r), cfg.Mode, cfg.Tokens, cfg.KB)
	adminJSON(w, map[string]interface{}{"ok": true, "mode": cfg.Mode, "tokens": cfg.Tokens, "kb": cfg.KB})
}
