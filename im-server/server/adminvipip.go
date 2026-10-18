// adminvipip.go —— 虚拟 IP 池后台管理（设计文档 docs/虚拟IP池设计方案.md §8/§8.4）
// GET  /admin/api/vipip        池统计（总/占用/空闲/预留）+ 全局 supernode 候选 + 占用/绑定明细
// PUT  /admin/api/vipip/bind   静态绑定用户（独占：该 IP 不参与动态分配，登录优先分配）
// PUT  /admin/api/vipip/unbind 解绑（IP 回池可被动态分配；在线占用者下线后回池）
// 统计/明细数据源为 vippool 内存态（纯内存读取无 DB 查询）；绑定/解绑走 Check→DB→Apply 两阶段
// （内存与 DB 一致性，见 server/vipip.go 区块注释）；未启用时 403 语义（前端提示未启用）
package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

// handleAdminVipIP GET /admin/api/vipip?q=
// 明细 = 静态绑定（含"已绑定未在线"）+ 动态占用 合并去重；q 按 IP/账号模糊过滤（服务端过滤）
func (s *Server) handleAdminVipIP(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.VipPool.Enabled {
		adminFail(w, http.StatusForbidden, "虚拟IP池未启用")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	qLower := strings.ToLower(q)
	st := s.vippool.Stats()

	// 合并组装：绑定行打底（bound=true，含未在线），动态占用行叠加（补 alloc_time）
	rowOf := map[string]map[string]interface{}{}
	for _, b := range s.vippool.Bindings() {
		rowOf[b.IP] = map[string]interface{}{
			"ip": b.IP, "username": b.Username, "alloc_time": "",
			"bound": true, "online": b.Online,
		}
	}
	for _, e := range s.vippool.Snapshot() {
		if row, ok := rowOf[e.IP]; ok {
			row["alloc_time"] = time.Unix(e.AllocAt, 0).Format("2006-01-02 15:04:05")
			row["online"] = true
			continue
		}
		rowOf[e.IP] = map[string]interface{}{
			"ip": e.IP, "username": e.Username,
			"alloc_time": time.Unix(e.AllocAt, 0).Format("2006-01-02 15:04:05"),
			"bound":      false, "online": true,
		}
	}
	// 过滤 + 排序：绑定行优先（组内 IP 升序），动态占用行按分配时间倒序
	// （sort.SliceStable：万级在线时明细 O(N²) 插入排序会卡死轮询，归口标准库稳定排序）
	filtered := make([]map[string]interface{}, 0, len(rowOf))
	for _, row := range rowOf {
		if q != "" {
			ip, _ := row["ip"].(string)
			u, _ := row["username"].(string)
			if !strings.Contains(ip, q) && !strings.Contains(strings.ToLower(u), qLower) {
				continue
			}
		}
		filtered = append(filtered, row)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		ab, _ := a["bound"].(bool)
		bb, _ := b["bound"].(bool)
		if ab != bb {
			return ab // 绑定行优先
		}
		at, _ := a["alloc_time"].(string)
		bt, _ := b["alloc_time"].(string)
		if at != bt {
			return at > bt // 同类按分配时间倒序（绑定行空时间沉到绑定组内）
		}
		aip, _ := a["ip"].(string)
		bip, _ := b["ip"].(string)
		return aip < bip // 同时间（绑定行空时间组）IP 升序稳定呈现
	})
	adminJSON(w, map[string]interface{}{
		"total":      st.Total,
		"used":       st.Used,
		"free":       st.Free,
		"reserved":   st.Reserved,
		"supernodes": s.vippool.Supernodes(), // 全局候选（admin 游戏表单多选项数据源）
		"list":       filtered,
	})
}

// handleAdminVipIPSupernodesSave PUT /admin/api/vipip/supernodes  {"list":"host:port\nhost:port"}
// 全局 supernode 候选热更（比照链接白名单模式：DB KV 落库持久化 + 内存直更热生效，无需重启）。
// 生效面：登录回执 vip_supernodes（下次登录）+ admin 游戏表单候选（打开即拉）+ 游戏未配置时的兜底
func (s *Server) handleAdminVipIPSupernodesSave(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.VipPool.Enabled {
		adminFail(w, http.StatusForbidden, "虚拟IP池未启用")
		return
	}
	var req struct {
		List string `json:"list"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	norm, err := vipSupValidate(req.List)
	if err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := vipSupSet(norm); err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败，请重试")
		return
	}
	logger.Info("后台管理：管理员 %s 修改 supernode 候选（%s）", adminUserFromCtx(r), func() string {
		if norm == "" {
			return "清空（游戏联机回退既有隧道链路）"
		}
		return norm
	}())
	adminJSON(w, map[string]interface{}{"ok": true, "list": norm})
}

// handleAdminVipIPBind PUT /admin/api/vipip/bind  {"ip":"10.28.1.5","username":"alice"}
// 静态绑定：Check（池内/无冲突/取旧绑定）→ DB 事务（新行 status=1+username、旧行清理）→ Apply 内存生效。
// 账号存在性服务端校验（防绑到未注册账号）；两阶段失败任一步均无半生效态
func (s *Server) handleAdminVipIPBind(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.VipPool.Enabled {
		adminFail(w, http.StatusForbidden, "虚拟IP池未启用")
		return
	}
	var req struct {
		IP       string `json:"ip"`
		Username string `json:"username"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	req.IP = strings.TrimSpace(req.IP)
	req.Username = strings.TrimSpace(req.Username)
	if req.IP == "" || req.Username == "" {
		adminFail(w, http.StatusBadRequest, "IP 与账号不能为空")
		return
	}
	// 账号存在性校验（绑到未注册账号无意义）
	var u model.User
	if err := store.DB.Select("username").Where("username = ?", req.Username).First(&u).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "账号不存在（须为已注册用户）")
		return
	}
	// 阶段一：内存冲突校验（取旧绑定）
	oldIP, err := s.vippool.CheckBind(req.IP, req.Username)
	if err != nil {
		adminFail(w, http.StatusConflict, err.Error())
		return
	}
	// 阶段二：DB 落库（事务：新行绑定 + 旧绑定行清理；先清旧防同用户双行）
	if err := store.DB.Transaction(func(tx *gorm.DB) error {
		if oldIP != "" && oldIP != req.IP {
			if err := tx.Model(&model.VipIP{}).Where("ip = ?", oldIP).
				Updates(map[string]interface{}{"status": 0, "username": ""}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&model.VipIP{}).Where("ip = ?", req.IP).
			Updates(map[string]interface{}{"status": 1, "username": req.Username}).Error
	}); err != nil {
		adminFail(w, http.StatusInternalServerError, "绑定落库失败")
		return
	}
	// 阶段三：内存生效
	s.vippool.ApplyBind(req.IP, req.Username, oldIP)
	logger.Info("虚拟IP静态绑定: %s → %s（旧绑定 %s）操作人=%s", req.IP, req.Username, oldIP, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminVipIPUnbind PUT /admin/api/vipip/unbind  {"ip":"10.28.1.5"}
// 解绑：Check（须为绑定 IP）→ DB 行清预留与用户名 → Apply 内存生效（无在线占用即回池）
func (s *Server) handleAdminVipIPUnbind(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.VipPool.Enabled {
		adminFail(w, http.StatusForbidden, "虚拟IP池未启用")
		return
	}
	var req struct {
		IP string `json:"ip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.IP) == "" {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	req.IP = strings.TrimSpace(req.IP)
	username, err := s.vippool.CheckUnbind(req.IP)
	if err != nil {
		adminFail(w, http.StatusConflict, err.Error())
		return
	}
	if err := store.DB.Model(&model.VipIP{}).Where("ip = ?", req.IP).
		Updates(map[string]interface{}{"status": 0, "username": ""}).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "解绑落库失败")
		return
	}
	s.vippool.ApplyUnbind(req.IP)
	logger.Info("虚拟IP解绑: %s（原绑定 %s）操作人=%s", req.IP, username, adminUserFromCtx(r))
	adminJSON(w, map[string]interface{}{"ok": true, "username": username})
}
