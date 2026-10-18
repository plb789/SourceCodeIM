// adminvipip.go —— 阶段虚拟 IP 池后台管理（设计文档 docs/虚拟IP池设计方案.md §8）
// GET /admin/api/vipip      池统计（总/占用/空闲/预留）+ 全局 supernode 候选 + 占用明细
// 数据源为 vippool 内存态（纯内存读取无 DB 查询）；未启用时 403 语义（前端页签隐藏）
package server

import (
	"net/http"
	"strings"
	"time"
)

// handleAdminVipIP GET /admin/api/vipip?q=
// 明细按分配时间倒序（最新在前）；q 按 IP/账号模糊过滤（服务端过滤）
func (s *Server) handleAdminVipIP(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.VipPool.Enabled {
		adminFail(w, http.StatusForbidden, "虚拟IP池未启用")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	qLower := strings.ToLower(q)
	st := s.vippool.Stats()
	list := s.vippool.Snapshot()
	filtered := make([]map[string]interface{}, 0, len(list))
	for _, e := range list {
		if q != "" && !strings.Contains(e.IP, q) && !strings.Contains(strings.ToLower(e.Username), qLower) {
			continue
		}
		filtered = append(filtered, map[string]interface{}{
			"ip":         e.IP,
			"username":   e.Username,
			"alloc_time": time.Unix(e.AllocAt, 0).Format("2006-01-02 15:04:05"),
		})
	}
	adminJSON(w, map[string]interface{}{
		"total":      st.Total,
		"used":       st.Used,
		"free":       st.Free,
		"reserved":   st.Reserved,
		"supernodes": s.vippool.Supernodes(), // 全局候选（admin 游戏表单多选项数据源）
		"list":       filtered,
	})
}
