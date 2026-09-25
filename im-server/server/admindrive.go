package server

// 阶段一百六十六：网盘上传扩展名黑名单后台设置（GET/PUT /admin/api/drive/blockexts）
// 黑名单归口 drive.go（driveBlockExts，网盘 API 上传与挂载盘 WebDAV 写入共用）；
// 保存即热生效 + 落库重启不丢，刻意不回写 config.yaml（注释会丢）：
// yaml 启动值仅作 DB 无记录时的初始默认（与历史压缩设置同策略）

import (
	"encoding/json"
	"im-server/logger"
	"net/http"
	"strings"
)

// handleAdminDriveBlockExtsGet GET：当前生效黑名单（原始串/是否默认/内置默认值/来源标注）
// + ELF 检测开关 + 处置模式（rename=自动加 .im 隔离保存 / deny=直接拦截 403）
func (s *Server) handleAdminDriveBlockExtsGet(w http.ResponseWriter, r *http.Request) {
	raw, source := s.driveBlockExtsSnapshot()
	mode := "deny"
	if s.driveBlockRename() {
		mode = "rename"
	}
	adminJSON(w, map[string]interface{}{
		"exts":       raw,
		"is_default": raw == "",
		"default":    strings.Join(driveDefaultBlockExts, ","),
		"source":     source, // override=后台设置（DB 真源）/ config=config.yaml 初始默认
		"elf":        s.driveBlockElf(),
		"mode":       mode,
	})
}

// handleAdminDriveBlockExtsSave PUT：保存黑名单（空串=恢复内置默认；非空逐项校验后归一存储）与
// ELF 魔数检测开关、处置模式（均 nil=不修改）。保存即热生效返回生效值。
// 请求体 {"exts": ".exe,.msi", "elf": true, "mode": "rename"}
func (s *Server) handleAdminDriveBlockExtsSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ext  string  `json:"exts"`
		Elf  *bool   `json:"elf"`  // nil=不修改 ELF 检测开关（部分更新语义）
		Mode *string `json:"mode"` // "rename"=隔离改名 / "deny"=拦截；nil=不修改
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.Mode != nil && *req.Mode != "rename" && *req.Mode != "deny" {
		adminFail(w, http.StatusBadRequest, "处置模式取值错误")
		return
	}
	raw := strings.TrimSpace(req.Ext)
	parts := make([]string, 0, 8)
	if raw != "" {
		for _, e := range strings.Split(raw, ",") {
			e = strings.ToLower(strings.TrimSpace(e))
			e = strings.TrimPrefix(e, ".")
			// 逐项校验：1-10 位字母数字（.exe/.msi/.ps1 形态），防止写入空项/超长/特殊字符
			if e == "" || len(e) > 10 {
				adminFail(w, http.StatusBadRequest, "扩展名格式错误: "+e)
				return
			}
			for _, c := range e {
				if !('a' <= c && c <= 'z' || '0' <= c && c <= '9') {
					adminFail(w, http.StatusBadRequest, "扩展名仅支持字母数字: "+e)
					return
				}
			}
			parts = append(parts, "."+e)
		}
	}
	norm := strings.Join(parts, ",")
	if err := s.driveSetBlockExts(norm); err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
		return
	}
	elfNow := s.driveBlockElf()
	if req.Elf != nil && *req.Elf != elfNow {
		if err := s.driveSetBlockElf(*req.Elf); err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
			return
		}
		elfNow = *req.Elf
	}
	modeNow := s.driveBlockRename()
	if req.Mode != nil && (*req.Mode == "rename") != modeNow {
		if err := s.driveSetBlockMode(*req.Mode == "rename"); err != nil {
			adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
			return
		}
		modeNow = *req.Mode == "rename"
	}
	shown := norm
	if shown == "" {
		shown = "内置默认"
	}
	modeName := "deny"
	if modeNow {
		modeName = "rename"
	}
	logger.Info("后台管理：管理员 %s 修改网盘上传黑名单（%s，ELF检测 %v，处置 %s）", adminUserFromCtx(r), shown, elfNow, modeName)
	adminJSON(w, map[string]interface{}{"ok": true, "exts": norm, "elf": elfNow, "mode": modeName})
}
