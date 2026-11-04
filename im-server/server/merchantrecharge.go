package server

// ===== 商户独立后台·赞助充值统计（商户独立后台开发文档 §3.3，merchantGuard 鉴权） =====
//
// 口径（拍板 2）：仅成功单（im_recharge_order.status=1）计入；商户名下游戏（owner_username）
// 的成功订单积分总额 × 商户分成比例 = 应结金额（服务端计算，商户只读）；处理中/失败不计入。

import (
	"net/http"
	"strconv"
	"strings"

	"im-server/model"
	"im-server/store"
)

// merchantRechargeBase 商户统计前置归口：商户资料 + 名下游戏 ID 集合（无游戏返回 ok=false 已写响应）
func merchantRechargeBase(w http.ResponseWriter, me string) (*model.Merchant, []uint, bool) {
	var m model.Merchant
	if err := store.DB.Where("username = ?", me).First(&m).Error; err != nil {
		adminFail(w, http.StatusNotFound, "商户资料不存在")
		return nil, nil, false
	}
	var gids []uint
	store.DB.Model(&model.Game{}).Where("owner_username = ?", me).Pluck("id", &gids)
	return &m, gids, true
}

// handleMerchantRechargeSummary 赞助统计：总额/比例/应结 + 按游戏 + 按日聚合
func (s *Server) handleMerchantRechargeSummary(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	m, gids, ok := merchantRechargeBase(w, me)
	if !ok {
		return
	}
	if len(gids) == 0 {
		adminJSON(w, map[string]interface{}{
			"total_points": 0, "commission_rate": m.CommissionRate, "payable": 0,
			"by_game": []map[string]interface{}{}, "by_day": []map[string]interface{}{},
		})
		return
	}
	// 总额（成功单）
	var total float64
	store.DB.Model(&model.RechargeOrder{}).
		Select("COALESCE(SUM(points),0)").
		Where("game_id IN ? AND status = ?", gids, model.RechargeOrderStatusSuccess).
		Scan(&total)
	// 按游戏聚合（游戏名随行，含零单游戏展示完整资产面）
	type gameAgg struct {
		GameID   uint    `json:"game_id"`
		Name     string  `json:"name"`
		Points   float64 `json:"points"`
		OrderCnt int64   `json:"order_count"`
	}
	byGame := make([]gameAgg, 0, len(gids))
	var games []model.Game
	store.DB.Where("id IN ?", gids).Order("id ASC").Find(&games)
	for _, g := range games {
		var p float64
		var c int64
		store.DB.Model(&model.RechargeOrder{}).
			Select("COALESCE(SUM(points),0)").Where("game_id = ? AND status = ?", g.ID, model.RechargeOrderStatusSuccess).Scan(&p)
		store.DB.Model(&model.RechargeOrder{}).
			Where("game_id = ? AND status = ?", g.ID, model.RechargeOrderStatusSuccess).Count(&c)
		byGame = append(byGame, gameAgg{GameID: g.ID, Name: g.Name, Points: p, OrderCnt: c})
	}
	// 按日聚合（近 30 天，DATE(create_time) 东八区服务端时区口径与日限额一致）
	type dayAgg struct {
		Day    string  `json:"day"`
		Points float64 `json:"points"`
	}
	var rawDays []struct {
		Day    string
		Points float64
	}
	store.DB.Model(&model.RechargeOrder{}).
		Select("DATE(create_time) AS day, COALESCE(SUM(points),0) AS points").
		Where("game_id IN ? AND status = ? AND create_time >= NOW() - INTERVAL 30 DAY", gids, model.RechargeOrderStatusSuccess).
		Group("DATE(create_time)").Order("day DESC").Scan(&rawDays)
	byDay := make([]dayAgg, 0, len(rawDays))
	for _, d := range rawDays {
		byDay = append(byDay, dayAgg{Day: d.Day, Points: d.Points})
	}
	rate := m.CommissionRate
	if rate < 0 || rate > 100 {
		rate = 100 // 资料异常防御：按全额展示（实际以管理员修后的库值为准）
	}
	payable := total * rate / 100
	adminJSON(w, map[string]interface{}{
		"total_points": total, "commission_rate": rate, "payable": payable,
		"by_game": byGame, "by_day": byDay,
	})
}

// handleMerchantRechargeOrders 商户充值订单（自己名下游戏，只读分页，status 可选过滤）
func (s *Server) handleMerchantRechargeOrders(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	me := merchantUserFromCtx(r)
	_, gids, ok := merchantRechargeBase(w, me)
	if !ok {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size < 1 || size > 100 {
		size = 20
	}
	if len(gids) == 0 {
		adminJSON(w, map[string]interface{}{"list": []model.RechargeOrder{}, "total": 0, "page": page, "size": size})
		return
	}
	db := store.DB.Model(&model.RechargeOrder{}).Where("game_id IN ?", gids)
	if v, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("status"))); err == nil && v >= 0 && v <= 2 {
		db = db.Where("status = ?", v)
	}
	if kw := strings.TrimSpace(r.URL.Query().Get("keyword")); kw != "" {
		db = db.Where("username LIKE ?", "%"+kw+"%")
	}
	var total int64
	db.Count(&total)
	var orders []model.RechargeOrder
	db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&orders)
	// 游戏名随行（商户可能多游戏，map 一次取齐）
	names := map[uint]string{}
	if len(orders) > 0 {
		gset := map[uint]bool{}
		for _, o := range orders {
			gset[o.GameID] = true
		}
		ids := make([]uint, 0, len(gset))
		for gid := range gset {
			ids = append(ids, gid)
		}
		var rows []model.Game
		store.DB.Where("id IN ?", ids).Find(&rows)
		for _, g := range rows {
			names[g.ID] = g.Name
		}
	}
	list := make([]map[string]interface{}, 0, len(orders))
	for _, o := range orders {
		var done *string
		if o.DoneTime != nil {
			t := o.DoneTime.Format("2006-01-02 15:04:05")
			done = &t
		}
		list = append(list, map[string]interface{}{
			"id": o.ID, "username": o.Username, "game_id": o.GameID, "game_name": names[o.GameID],
			"points": o.Points, "amount": o.Amount, "gw": o.Gw, "status": o.Status,
			"fail_reason": o.FailReason, "create_time": o.CreateTime.Format("2006-01-02 15:04:05"),
			"done_time": done,
		})
	}
	adminJSON(w, map[string]interface{}{"list": list, "total": total, "page": page, "size": size})
}
