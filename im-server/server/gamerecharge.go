package server

// ===== 积分兑换网关充值：订单 + 用户 API + 网关内部拉取/回执 + 超时退分（docs/积分兑换网关充值功能开发文档 §3.1） =====
//
// 链路：玩家档位式下单（Steam"添加资金"同款）→ 事务内原子扣积分+建订单（pending）→
// 网关周期拉取 GET /internal/gateway/recharge?gw={名}（复用 gwDbwriteAuth：HMAC 签名 + AES-GCM
// 强制密文响应）→ 按游戏配置的 SQL 模板参数化写游戏库 → 成功 ack → 订单 success；
// 失败不 ack=天然重试；下发后 30 分钟未终态 → 定时任务标 failed 并自动全额退分（流水可查）。
//
// 安全归口：
//   1. 档位白名单：points 必须与 game.recharge_tiers 某档完全一致，杜绝任意数值（377/负数/篡改小数）；
//   2. 扣分与建单同事务，扣分 WHERE points>=pay 并发不透支；日限额统计含 pending 占额防并发绕过；
//   3. 状态机单向迁移：终态更新一律带 status=pending 条件，重复回执/并发扫描不重复退分；
//   4. 拉取响应绝不下发 points 与用户敏感字段（仅 id/username/game_id/amount）；
//   5. 汇率/限额全在 im-server，网关只见数值 amount——业务数据不下放网关。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/config"
	"im-server/gwproto"
	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// rechargeTimeout 订单下发后未终态的退分时限（网关离线/长期执行失败时玩家积分不被悬空占用）
const rechargeTimeout = 30 * time.Minute

// rechargeTiersMax 档位数量上限（管理端录入容错；Steam 档位页同量级）
const rechargeTiersMax = 32

// rechargeTiersParse 档位 JSON 串解析归口：非法/空返回 nil（充值不可用）；
// 逐项 3 位小数归一 + 正数校验 + 去重 + 升序（客户端渲染与下单白名单同源此口径）
func rechargeTiersParse(raw string) []float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var tiers []float64
	if err := json.Unmarshal([]byte(raw), &tiers); err != nil {
		return nil
	}
	seen := map[float64]bool{}
	out := make([]float64, 0, len(tiers))
	for _, t := range tiers {
		v := aiPointsRound3(t)
		if v <= 0 || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil
	}
	for i := 0; i < len(out); i++ { // 升序（数量 ≤32，插入排序足够）
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// rechargeTiersHit 档位白名单命中校验：points 与某档完全一致（3 位小数口径）才算合法档位
func rechargeTiersHit(tiers []float64, points float64) bool {
	for _, t := range tiers {
		if t == points {
			return true
		}
	}
	return false
}

// rechargeGameReady 游戏充值可用性归口：开关 + 归属网关 + 档位三者齐备才对玩家开放
func rechargeGameReady(g *model.Game) ([]float64, bool) {
	if !g.RechargeEnabled || strings.TrimSpace(g.RechargeGw) == "" {
		return nil, false
	}
	tiers := rechargeTiersParse(g.RechargeTiers)
	if len(tiers) == 0 {
		return nil, false
	}
	return tiers, true
}

// rechargeTodayUsed 单用户单游戏当日累计积分（status IN(0,1)：pending 占额防并发绕过日限额；
// failed 已退分不占额）。查询失败按 0 兜底并记日志（宁可放行勿误伤主链路，日限额非安全边界）。
// 日界归口：本地自然日零点（time.Truncate(24h) 是按 UTC 纪元截断，东八区会变成当天 08:00——实测陷阱）
func rechargeTodayUsed(username string, gameID uint) float64 {
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var used float64
	err := store.DB.Model(&model.RechargeOrder{}).
		Where("username = ? AND game_id = ? AND status IN ? AND create_time >= ?", username, gameID,
			[]int8{model.RechargeOrderStatusPending, model.RechargeOrderStatusSuccess}, dayStart).
		Select("COALESCE(SUM(points), 0)").Scan(&used).Error
	if err != nil {
		logger.Error("充值日限额统计失败（%s 游戏#%d）：%v", username, gameID, err)
	}
	return aiPointsRound3(used)
}

// rechargeTiersNormalize 管理端档位录入归一：兼容 JSON 数组串与逗号分隔（中英文逗号）两种录入，
// 统一归一为升序去重 JSON 数组串（3 位小数口径）；空串返回空串（=未配置，充值不可用）；
// 超过 rechargeTiersMax 档或存在非正数/非法片段返回错误（管理端保存即拦，脏数据不入库）
func rechargeTiersNormalize(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	var tiers []float64
	if err := json.Unmarshal([]byte(raw), &tiers); err != nil {
		// 非 JSON：按逗号分隔重试（管理端手填友好）
		segs := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '，' || r == '、' })
		tiers = tiers[:0]
		for _, seg := range segs {
			v, perr := strconv.ParseFloat(strings.TrimSpace(seg), 64)
			if perr != nil {
				return "", fmt.Errorf("充值档位含非法数值: %q", strings.TrimSpace(seg))
			}
			tiers = append(tiers, v)
		}
	}
	if len(tiers) == 0 {
		return "", nil
	}
	if len(tiers) > rechargeTiersMax {
		return "", fmt.Errorf("充值档位最多 %d 个", rechargeTiersMax)
	}
	clean := rechargeTiersParse(string(mustJSON(tiers)))
	if len(clean) != len(tiers) {
		return "", fmt.Errorf("充值档位须为正数且不重复")
	}
	b, _ := json.Marshal(clean)
	return string(b), nil
}

// rechargeGameCfgClean Game 充值配置清洗归口（管理端创建/更新共用，保存即拦）：
// 网关名小写格式校验、汇率/日限额负数钳零、档位归一（非法整串拒绝）
func rechargeGameCfgClean(g *model.Game) error {
	g.RechargeGw = strings.ToLower(strings.TrimSpace(g.RechargeGw))
	if g.RechargeGw != "" && !gwBookNameRe.MatchString(g.RechargeGw) {
		return fmt.Errorf("充值网关名须为 1~64 位小写字母/数字/_/-（留空=不开放充值）")
	}
	if g.RechargeRate < 0 {
		g.RechargeRate = 0 // 运行期 rate<=0 按 1 兜底；负数录入钳零
	}
	if g.RechargeDailyMax < 0 {
		g.RechargeDailyMax = 0
	}
	tiers, err := rechargeTiersNormalize(g.RechargeTiers)
	if err != nil {
		return err
	}
	g.RechargeTiers = tiers
	return nil
}

// HandleAdminGameRechargeOrders GET /admin/api/game/recharge/orders 充值订单审计页（管理端只读）：
// username/game_id/status 可选过滤 + 分页倒序；与用户侧记录接口同映射（多返回 gw 归属）
func (s *Server) HandleAdminGameRechargeOrders(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	db := store.DB.Model(&model.RechargeOrder{})
	if kw := strings.TrimSpace(q.Get("username")); kw != "" {
		db = db.Where("username LIKE ?", "%"+kw+"%")
	}
	if gid, _ := strconv.Atoi(q.Get("game_id")); gid > 0 {
		db = db.Where("game_id = ?", gid)
	}
	if st := strings.TrimSpace(q.Get("status")); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 2 {
			db = db.Where("status = ?", v)
		}
	}
	var total int64
	db.Count(&total)
	var orders []model.RechargeOrder
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&orders).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询充值订单失败")
		return
	}
	gids := make([]uint, 0, len(orders))
	for _, o := range orders {
		gids = append(gids, o.GameID)
	}
	names := map[uint]string{}
	if len(gids) > 0 {
		var games []model.Game
		store.DB.Select("id, name").Where("id IN ?", gids).Find(&games)
		for _, g := range games {
			names[g.ID] = g.Name
		}
	}
	items := make([]map[string]interface{}, 0, len(orders))
	for _, o := range orders {
		items = append(items, map[string]interface{}{
			"id": o.ID, "username": o.Username, "game_id": o.GameID, "game_name": names[o.GameID],
			"points": o.Points, "amount": o.Amount, "status": o.Status, "gw": o.Gw,
			"fail_reason": o.FailReason, "create_time": o.CreateTime, "done_time": o.DoneTime,
		})
	}
	adminJSON(w, map[string]interface{}{"ok": true, "total": total, "items": items})
}

// guardRecharge 充值接口鉴权归口（资金类强校验，仿 guardDrive 但**无兼容回退**——充值功能全新、
// 无存量客户端负担）：自报 username 必须与登录签发的 X-Drive-Token 归属一致（Redis 会话、
// 连接断开即吊销），否则 401。背景：游戏中心 HTTP API 族历史为"username 查询参数自报身份"模型，
// 无 token 时任何人可冒名消耗他人积分——充值属资金操作，按网盘/远程控制同款范式收口（审计修复）
func (s *Server) guardRecharge(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		tu, ok := DriveTokenVerify(r.Header.Get("X-Drive-Token"))
		if !ok || tu != username {
			logger.Warn("充值接口鉴权失败：tokenUser=%q queryUser=%q ip=%s", tu, username, r.RemoteAddr)
			adminFail(w, http.StatusUnauthorized, "身份校验失败，请重新登录")
			return
		}
		h(w, r)
	}
}

// HandleGameRecharge POST /api/game/recharge 提交兑换（档位式）：body {game_id, points}。
// 校验链：游戏上架且充值可用 → points 命中档位白名单 → 日限额 → 余额 → 事务内原子扣分+建单
func (s *Server) HandleGameRecharge(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	var req struct {
		GameID uint    `json:"game_id"`
		Points float64 `json:"points"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, req.GameID).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	if g.Status != 0 {
		adminFail(w, http.StatusForbidden, "游戏已下架")
		return
	}
	tiers, ready := rechargeGameReady(&g)
	if !ready {
		adminFail(w, http.StatusForbidden, "该游戏未开放积分充值")
		return
	}
	pay := aiPointsRound3(req.Points)
	if !rechargeTiersHit(tiers, pay) {
		adminFail(w, http.StatusBadRequest, "充值数量不在档位内（须为配置的固定档位之一）")
		return
	}
	// 日限额预检（pending 占额口径，见 rechargeTodayUsed）：仅作友好快速失败——
	// 真正的限额约束在下方事务内复检（防并发绕过，见事务注释）
	if g.RechargeDailyMax > 0 {
		used := rechargeTodayUsed(username, g.ID)
		if used+pay > aiPointsRound3(g.RechargeDailyMax)+1e-9 {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("超出今日充值限额（今日已兑 %.3f / 上限 %.3f 积分）", used, g.RechargeDailyMax))
			return
		}
	}
	errInsufficient := fmt.Errorf("积分不足")
	errDayLimit := fmt.Errorf("超出日限额")
	rate := g.RechargeRate
	if rate <= 0 {
		rate = 1
	}
	amount := aiPointsRound3(pay * rate)
	gw := strings.ToLower(strings.TrimSpace(g.RechargeGw))
	order := model.RechargeOrder{Username: username, GameID: g.ID, Points: pay, Amount: amount, Status: model.RechargeOrderStatusPending, Gw: gw}
	// 事务归口：扣分 + 建单 + 流水同事务（任一失败整体回滚，积分不悬空）；
	var after float64
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		// 同用户并发下单串行化（隐式 UPDATE User 持有行锁直至事务提交）
		res := tx.Model(&model.User{}).
			Where("username = ? AND points >= ?", username, pay).
			Update("points", gorm.Expr("ROUND(points - ?, 3)", pay))
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errInsufficient
		}
		if g.RechargeDailyMax > 0 {
			var used float64
			now := time.Now()
			dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
			if err := tx.Model(&model.RechargeOrder{}).
				Where("username = ? AND game_id = ? AND status IN ? AND create_time >= ?", username, g.ID,
					[]int8{model.RechargeOrderStatusPending, model.RechargeOrderStatusSuccess}, dayStart).
				Select("COALESCE(SUM(points), 0)").Scan(&used).Error; err != nil {
				return err
			}
			if aiPointsRound3(used)+pay > aiPointsRound3(g.RechargeDailyMax)+1e-9 {
				return errDayLimit
			}
		}
		if err := tx.Create(&order).Error; err != nil {
			return err
		}
		// 事务内读真实扣后余额（MVCC 视图保证看见上面的 UPDATE），供流水 BalanceAfter 使用
		if err := tx.Model(&model.User{}).Select("points").Where("username = ?", username).Scan(&after).Error; err != nil {
			return err
		}
		// 流水也在事务内——与扣分 + 建单原子提交，杜绝"扣分成功但流水没写"的审计缺口
		return tx.Create(&model.PointsLog{
			Username: username, Change: -pay, BalanceAfter: after,
			Reason: "game_recharge", Operator: "system",
			Detail: fmt.Sprintf("积分兑换充值: %s（订单 %d）", g.Name, order.ID),
		}).Error
	})
	if err != nil {
		if err == errInsufficient {
			adminFail(w, http.StatusBadRequest, "积分不足，请联系管理员发放")
			return
		}
		if err == errDayLimit {
			adminFail(w, http.StatusBadRequest, fmt.Sprintf("超出今日充值限额（上限 %.3f 积分）", g.RechargeDailyMax))
			return
		}
		adminFail(w, http.StatusInternalServerError, "下单失败")
		return
	}
	logger.Info("充值订单创建：用户 %s 游戏#%d 积分 %.3f 到账 %.3f 网关 %s 订单 %d", username, g.ID, pay, amount, gw, order.ID)
	// 直接用事务内回填的 after（tx SELECT 必走主库），替代事务外 userPoints（会被读写分离中间件路由到从库导致旧值）
	adminJSON(w, map[string]interface{}{"ok": true, "order_id": order.ID, "points": pay, "amount": amount, "balance": aiPointsRound3(after)})
}

// HandleGameRechargeOrders GET /api/game/recharge/orders 本人兑换记录（倒序分页；game_id 可选过滤；
// 提交后状态轮询复用本接口）。仅返回本人订单，绝无越权面
func (s *Server) HandleGameRechargeOrders(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 50 {
		size = 20
	}
	db := store.DB.Model(&model.RechargeOrder{}).Where("username = ?", username)
	if gid, _ := strconv.Atoi(q.Get("game_id")); gid > 0 {
		db = db.Where("game_id = ?", gid)
	}
	var total int64
	db.Count(&total)
	var orders []model.RechargeOrder
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&orders).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询兑换记录失败")
		return
	}
	// 游戏名随行补齐（订单量小，内存映射免 JOIN）
	gids := make([]uint, 0, len(orders))
	for _, o := range orders {
		gids = append(gids, o.GameID)
	}
	names := map[uint]string{}
	if len(gids) > 0 {
		var games []model.Game
		store.DB.Select("id, name").Where("id IN ?", gids).Find(&games)
		for _, g := range games {
			names[g.ID] = g.Name
		}
	}
	items := make([]map[string]interface{}, 0, len(orders))
	for _, o := range orders {
		items = append(items, map[string]interface{}{
			"id": o.ID, "game_id": o.GameID, "game_name": names[o.GameID],
			"points": o.Points, "amount": o.Amount, "status": o.Status,
			"fail_reason": o.FailReason, "create_time": o.CreateTime, "done_time": o.DoneTime,
		})
	}
	adminJSON(w, map[string]interface{}{"ok": true, "total": total, "items": items})
}

// HandleGameRechargeConfig GET /api/game/recharge/config?username=&game_id=
// 充值弹窗配置回显（汇率/档位/日限额），详情页据此渲染档位卡片与预校验提示。
// 定价信息（enabled/rate/tiers/daily_max）公开；**个人数据（balance/today_used）按 token 门控**
// ——与 /api/game/points 收口同水位，防冒名 username 枚举他人余额与兑换行为（审计修复）
func (s *Server) HandleGameRechargeConfig(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	gid, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	var g model.Game
	if err := store.DB.First(&g, gid).Error; err != nil {
		adminFail(w, http.StatusNotFound, "游戏不存在")
		return
	}
	resp := map[string]interface{}{"enabled": false, "rate": 0, "tiers": []float64{}, "daily_max": 0}
	if g.Status != 0 {
		adminJSON(w, resp)
		return
	}
	tiers, ready := rechargeGameReady(&g)
	if !ready {
		adminJSON(w, resp)
		return
	}
	resp["enabled"] = true
	resp["rate"] = func() float64 {
		v := g.RechargeRate
		if v <= 0 {
			return 1
		}
		return v
	}()
	resp["tiers"] = tiers
	resp["daily_max"] = g.RechargeDailyMax
	// 个人字段仅对 token 校验通过的本人请求下发（客户端无 token 时弹窗缺余额展示，
	// 服务端下单仍全量校验兜底——前端预校验仅作提示不影响资金安全）
	if tu, tok := gameAuthToken(r); tok && tu == username {
		balance, _ := userPoints(username)
		resp["today_used"] = rechargeTodayUsed(username, g.ID)
		resp["balance"] = aiPointsRound3(balance)
	}
	adminJSON(w, resp)
}

// handleInternalGatewayRecharge GET /internal/gateway/recharge?gw={名}
// 网关拉取待执行充值订单：鉴权复用 gwDbwriteAuth（条目专属密钥优先，签名通过即身份证明）；
// 按 game.recharge_gw==gw 严格过滤（充值不走转发规则并集，只认显式归属）；响应 AES-256-GCM 强制密文，
// 条目仅含 {id, username, game_id, amount}——绝不下发 points（汇率属服务端业务数据）
func (s *Server) handleInternalGatewayRecharge(w http.ResponseWriter, r *http.Request) {
	gwName := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("gw")))
	sec, ok := s.gwDbwriteAuth(w, r, nil, gwName)
	if !ok {
		return
	}
	if gwName == "" {
		adminFail(w, http.StatusBadRequest, "缺少 gw 参数")
		return
	}
	if member, _ := s.gwDbwriteGatewayChecked(gwName); !member {
		adminFail(w, http.StatusForbidden, "网关不在地址簿")
		return
	}
	// 该网关承接充值的游戏集（显式 recharge_gw 声明；一次全量扫描，游戏量级=管理员上架数）
	var games []model.Game
	if err := store.DB.Select("id, recharge_enabled, recharge_gw").Find(&games).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询游戏失败")
		return
	}
	gids := make([]uint, 0, 8)
	for _, g := range games {
		if g.RechargeEnabled && strings.EqualFold(strings.TrimSpace(g.RechargeGw), gwName) {
			gids = append(gids, g.ID)
		}
	}
	items := []map[string]interface{}{}
	if len(gids) > 0 {
		var orders []model.RechargeOrder
		store.DB.Where("game_id IN ? AND status = ? AND gw = ?", gids, model.RechargeOrderStatusPending, gwName).
			Order("id ASC").Limit(500).Find(&orders)
		for _, o := range orders {
			items = append(items, map[string]interface{}{"id": o.ID, "username": o.Username, "game_id": o.GameID, "amount": o.Amount})
		}
	}
	if len(items) > 0 {
		logger.Info("充值订单拉取：网关 %s 取待执行订单 %d 条", gwName, len(items))
	}
	plain, _ := json.Marshal(map[string]interface{}{"items": items})
	enc, err := gwproto.SealResp(sec, plain)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "响应加密失败")
		return
	}
	w.Header().Set(gwproto.RespEncHeader, gwproto.RespEncVer)
	_, _ = w.Write([]byte(enc))
}

// rechargeAckFailedItem ack 请求中的失败条目（网关明确报失败：立即标 failed 退分，不等超时）
type rechargeAckFailedItem struct {
	ID     uint64 `json:"id"`
	Reason string `json:"reason"`
}

// handleInternalGatewayRechargeAck POST /internal/gateway/recharge/ack
// 网关回执：success 列表落终态（status 条件更新，重复回执幂等）；failed 列表标 failed 并全额退分。
// body 纳入 HMAC 签名（篡改 ids/failed 即验签失败）；仅受理本网关（gw 快照匹配）的订单
func (s *Server) handleInternalGatewayRechargeAck(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "读取请求体失败")
		return
	}
	var probe struct {
		GW string `json:"gw"`
	}
	_ = json.Unmarshal(body, &probe)
	if _, ok := s.gwDbwriteAuth(w, r, body, strings.ToLower(strings.TrimSpace(probe.GW))); !ok {
		return
	}
	var req struct {
		GW     string                  `json:"gw"`
		OK     []uint64                `json:"ok"`
		Failed []rechargeAckFailedItem `json:"failed"`
	}
	if err := json.Unmarshal(body, &req); err != nil || (len(req.OK) == 0 && len(req.Failed) == 0) {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	gwName := strings.ToLower(strings.TrimSpace(req.GW))
	if gwName == "" {
		adminFail(w, http.StatusBadRequest, "缺少 gw")
		return
	}
	if member, _ := s.gwDbwriteGatewayChecked(gwName); !member {
		adminFail(w, http.StatusForbidden, "网关不在地址簿")
		return
	}
	okN, failN := 0, 0
	if len(req.OK) > 0 {
		now := time.Now()
		res := store.DB.Model(&model.RechargeOrder{}).
			Where("id IN ? AND status = ? AND gw = ?", req.OK, model.RechargeOrderStatusPending, gwName).
			Updates(map[string]interface{}{"status": model.RechargeOrderStatusSuccess, "done_time": &now})
		okN = int(res.RowsAffected)
		// 迟到回执可见性：success ack 未命中 pending（订单已超时退分）——极小概率出现
		// "网关已写库但 ack 丢失跨过 30 分钟超时"的双得到账，需人工核对（幂等落盘/存储过程可把概率压到趋零但无法归零）
		if okN < len(req.OK) {
			logger.Warn("充值回执部分未命中 pending（疑似网关迟到回执，订单已超时退分但游戏库可能已到账，请人工核对）：网关 %s 请求 %d 命中 %d", gwName, len(req.OK), okN)
		}
		// 充值成就触发 + 赞助充值商家分账：本次新落 success 的订单逐条处理
		if okN > 0 {
			var newlyOK []model.RechargeOrder
			if err := store.DB.Where("id IN ? AND status = ? AND gw = ?", req.OK, model.RechargeOrderStatusSuccess, gwName).
				Select("id, username, game_id, points").Find(&newlyOK).Error; err == nil {
				seen := map[string]bool{}
				for _, o := range newlyOK {
					// 成就：按 (username, game_id) 去重异步触发
					key := o.Username + "|" + strconv.FormatUint(uint64(o.GameID), 10)
					if !seen[key] {
						seen[key] = true
						go s.achEngineEvaluatePay(o.Username, o.GameID)
					}
					// 商家赞助充值分账（type=5）——和成就触发同级异步，不阻塞 ack HTTP 响应
					go sponsorRechargeSettle(s.cfg, &o)
				}
			}
		}
	}
	for _, f := range req.Failed {
		if f.ID == 0 {
			continue
		}
		var o model.RechargeOrder
		if err := store.DB.Where("id = ? AND gw = ?", f.ID, gwName).First(&o).Error; err != nil {
			continue // 非本网关订单/不存在，静默忽略
		}
		reason := strings.TrimSpace(f.Reason)
		if reason == "" {
			reason = "网关执行失败"
		}
		if rechargeRefund(&o, "网关执行失败: "+reason) {
			failN++
		}
	}
	logger.Info("充值订单回执：网关 %s 成功 %d 条（新落 %d）、失败 %d 条", gwName, len(req.OK), okN, failN)
	adminJSON(w, map[string]interface{}{"ok": true, "acked": okN, "refunded": failN})
}

// rechargeRefund 退分归口（网关明确失败 / 超时扫描共用）：
// 状态机 pending→failed 单向迁移（WHERE status=pending 条件更新，RowsAffected=1 唯一赢家），
// 迁移成功才退积分——并发重复调用/重复回执绝不双重退分。
// 重要：积分退回 + 流水 + 商家分账扣回 全部在同一 DB 事务内原子完成——杜绝"标 failed 成功
// 但退积分失败"或"退积分成功但商家没扣回"的半生效态
func rechargeRefund(o *model.RechargeOrder, reason string) bool {
	if len(reason) > 250 {
		reason = reason[:250]
	}
	// 状态机 CAS + 积分退回 + 流水 + 商家扣回 同事务原子提交
	// 关键：status=failed 必须和积分退回原子可见——如果 CAS 放在事务外，
	// 存在竞态窗口：CAS 先提交（测试/其他查询看到 status=failed）但积分退回事务还没 commit。
	var sponsorDeducted bool
	var userGone bool
	var didRefund bool
	errTx := store.DB.Transaction(func(tx *gorm.DB) error {
		// ① 状态机 CAS（在事务内：pending→failed；已终态则 RowsAffected=0 → 幂等跳过）
		now := time.Now()
		res := tx.Model(&model.RechargeOrder{}).
			Where("id = ? AND status = ?", o.ID, model.RechargeOrderStatusPending).
			Updates(map[string]interface{}{"status": model.RechargeOrderStatusFailed, "fail_reason": reason, "done_time": &now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil // 已是终态（重复回执/并发扫描），幂等忽略，整个事务空提交
		}
		didRefund = true
		// ② 积分退回：FOR UPDATE 锁 User 行
		var lockedUser model.User
		if uerr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", o.Username).First(&lockedUser).Error; uerr != nil {
			if errors.Is(uerr, gorm.ErrRecordNotFound) {
				// 用户已注销/清理（管理员后台删用户但充值订单未同步删）——
				// 积分无处可退 → 归入 platform_pool（系统孤儿积分暂存池）
				userGone = true
				logger.Warn("充值退分用户已不存在：订单 %d 用户 %s 积分 %.3f 转入 platform_pool（账号已清理），将继续执行商家扣回",
					o.ID, o.Username, o.Points)
				// FOR UPDATE 锁 platform_pool 行（锁顺序：同其他 User 行）
				var pp model.User
				if perr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("username = ?", model.StorePlatformPool).First(&pp).Error; perr != nil {
					// 极端情况：platform_pool 被删了？那真没办法，只记日志
					logger.Error("⚡platform_pool 账户也查不到！订单 %d 用户 %s 积分 %.3f 彻底丢失，请人工对账⚡",
						o.ID, o.Username, o.Points)
				} else {
					if uerr2 := tx.Model(&model.User{}).Where("username = ?", model.StorePlatformPool).
						Update("points", gorm.Expr("ROUND(points + ?, 3)", o.Points)).Error; uerr2 != nil {
						return uerr2
					}
					var after float64
					tx.Model(&model.User{}).Select("points").Where("username = ?", model.StorePlatformPool).Scan(&after)
					if lerr := tx.Create(&model.PointsLog{
						Username: model.StorePlatformPool, Change: o.Points, BalanceAfter: after,
						Reason: "game_recharge_refund_orphan", Operator: "system",
						Detail: fmt.Sprintf("充值失败但用户 %s 已注销（订单 %d），积分 %.3f 归入暂存池", o.Username, o.ID, o.Points),
					}).Error; lerr != nil {
						return lerr
					}
				}
				// 不 return——继续往下走商家扣回
			} else {
				return fmt.Errorf("锁定用户失败: %w", uerr)
			}
		}
		if !userGone {
			// 用户存在：正常加分 + 写流水
			if uerr := tx.Model(&model.User{}).Where("username = ?", o.Username).
				Update("points", gorm.Expr("ROUND(points + ?, 3)", o.Points)).Error; uerr != nil {
				return uerr
			}
			var after float64
			tx.Model(&model.User{}).Select("points").Where("username = ?", o.Username).Scan(&after)
			if lerr := tx.Create(&model.PointsLog{
				Username: o.Username, Change: o.Points, BalanceAfter: after,
				Reason: "game_recharge_refund", Operator: "system",
				Detail: fmt.Sprintf("充值失败退还（订单 %d）: %s", o.ID, reason),
			}).Error; lerr != nil {
				return lerr
			}
		}
		// ③ 商家赞助充值扣回（无论用户存在与否都执行）
		var purchaseLog model.MerchantIncomeLog
		if cerr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("purchase_id = ? AND type = 5 AND status != 3", o.ID).
			Order("id DESC").First(&purchaseLog).Error; cerr != nil {
			sponsorDeducted = false
			return nil
		}
		sponsorDeducted = true
		var merchant model.Merchant
		if merr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", purchaseLog.Merchant).First(&merchant).Error; merr != nil {
			return merr
		}
		merchantEarn := purchaseLog.MerchantEarn
		var deductPending, deductBalance float64
		if merchant.PendingPoints >= merchantEarn {
			deductPending = merchantEarn
			deductBalance = 0
		} else {
			deductPending = merchant.PendingPoints
			deductBalance = aiPointsRound3(merchantEarn - merchant.PendingPoints)
		}
		if uerr := tx.Model(&model.Merchant{}).Where("username = ?", merchant.Username).Updates(map[string]interface{}{
			"pending_points": gorm.Expr("ROUND(GREATEST(pending_points - ?, 0), 3)", deductPending),
			"balance_points":  gorm.Expr("ROUND(GREATEST(balance_points - ?, 0), 3)", deductBalance),
			"total_refunded":  gorm.Expr("ROUND(total_refunded + ?, 3)", merchantEarn),
		}).Error; uerr != nil {
			return uerr
		}
		if uerr := tx.Model(&purchaseLog).Where("id = ? AND status != 3", purchaseLog.ID).Update("status", 3).Error; uerr != nil {
			return uerr
		}
		return tx.Create(&model.MerchantIncomeLog{
			Merchant: merchant.Username, GameID: purchaseLog.GameID,
			Username: o.Username, PurchaseID: uint(o.ID),
			UserPay: -o.Points, Commission: purchaseLog.Commission,
			MerchantEarn: -merchantEarn, Type: 6, Status: 3,
		}).Error
	})
	if errTx != nil {
		logger.Error("⚡充值退回事务失败（订单 %d 用户 %s）：%v", o.ID, o.Username, errTx)
		return true
	}
	if !didRefund {
		// 幂等跳过：订单已是终态（重复回执/并发扫描的第二个赢家）
		return false
	}
	orphanTag := ""
	if userGone {
		orphanTag = "（孤儿：用户已注销）"
	}
	logger.Info("充值订单退分：订单 %d 用户 %s 退 %.3f（%s），商家扣回=%v%s", o.ID, o.Username, o.Points, reason, sponsorDeducted, orphanTag)
	return true
}

// rechargeTimeoutSweep 单轮超时扫描归口（loop 每轮调用；单测直接调用验证）：返回本轮退分单数
func rechargeTimeoutSweep() int {
	var orders []model.RechargeOrder
	if err := store.DB.Where("status = ? AND create_time < ?", model.RechargeOrderStatusPending, time.Now().Add(-rechargeTimeout)).
		Order("id ASC").Limit(200).Find(&orders).Error; err != nil {
		logger.Error("充值超时扫描查询失败：%v", err)
		return 0
	}
	n := 0
	for i := range orders {
		if rechargeRefund(&orders[i], "处理超时自动退分（网关未在时限内完成充值）") {
			n++
		}
	}
	return n
}

// rechargeRefundLoop 超时退分定时任务（InitGame 启动，60s 周期）：
// 扫描下发后超时仍 pending 的订单逐单退分——网关离线/订单丢失时玩家积分不悬空；
// 条件更新状态机保证并发/重复扫描幂等
func rechargeRefundLoop() {
	for {
		time.Sleep(time.Minute)
		func() {
			defer func() {
				if e := recover(); e != nil {
					logger.Error("充值超时扫描异常（下轮继续）：%v", e)
				}
			}()
			rechargeTimeoutSweep()
		}()
	}
}

// sponsorRechargeSettle 赞助充值商家分账（type=5）：订单 success 后查游戏 owner 的 Merchant，
// 按 commission_rate 给商家加分账（pending_points 锁定期）。
//
// 三重保险防丢账：
//  ① 幂等前置查 purchase_id=订单ID AND type=5 的 income_log，有就直接 return（防 goroutine 重试重复加分账）
//  ② 事务内 FOR UPDATE 锁 merchant + income_log，并发 sweep/refund 串行不互踩
//  ③ 3 次指数退避重试（100ms→200ms→400ms），全失败落 Error 日志供管理员 grep 补账
//
// purchase_id = RechargeOrder.ID（赞助充值没有 GameLibrary.ID，用订单 ID 关联）
func sponsorRechargeSettle(cfg *config.Config, o *model.RechargeOrder) {
	if o == nil || o.Points <= 0 {
		return
	}
	if !cfg.Game.MerchantRevenueEnabled {
		return
	}
	// ===== 幂等前置：查是否已分过账（重试防重、补偿任务重复触发都靠这里兜底） =====
	var existCount int64
	if err := store.DB.Model(&model.MerchantIncomeLog{}).
		Where("purchase_id = ? AND type = 5", uint(o.ID)).
		Count(&existCount).Error; err == nil && existCount > 0 {
		logger.Info("赞助充值分账幂等跳过：订单 %d 已有 type=5 分账记录", o.ID)
		return
	}

	var g model.Game
	if err := store.DB.Select("id, owner_username").Where("id = ?", o.GameID).First(&g).Error; err != nil || g.OwnerUsername == "" {
		if err != nil {
			// INFO 而不是 WARN：游戏已下架或被删除是正常业务场景，不是系统异常；
			// 更不会导致资金不一致——没有 owner 的游戏本来就不会产生商家分账
			logger.Info("赞助充值分账跳过：游戏#%d 已下架或不存在（无 owner，无需分账）", o.GameID)
		}
		return // 无 owner=官方游戏，不分账
	}
	var merchant model.Merchant
	if err := store.DB.Where("username = ?", g.OwnerUsername).First(&merchant).Error; err != nil || merchant.Status != 0 {
		// 同理 INFO：商家被删除/停用后其名下未分账的订单自然不需要再补分账
		logger.Info("赞助充值分账跳过：游戏#%d owner=%s 商户不存在或已停用", o.GameID, g.OwnerUsername)
		return
	}
	commission := merchant.CommissionRate / 100.0
	if commission < 0 {
		commission = 0
	}
	if commission > 1 {
		commission = 1
	}
	merchantEarn := aiPointsRound3(o.Points * commission)
	if merchantEarn <= 0 {
		return
	}
	lockDays := cfg.Game.RefundDays
	if lockDays <= 0 {
		lockDays = 7
	}
	// 补偿场景：订单可能在 merchant_revenue_enabled=false 时漏分账，后来被补偿扫到。
	// 如果订单创建时间 + lockDays 已过期，直接进 balance_points 并标记已解锁；否则正常进 pending_points
	orderSettleTime := o.CreateTime.AddDate(0, 0, lockDays)
	now := time.Now()
	isExpired := !orderSettleTime.After(now) // 锁定期已过
	var settleTime time.Time
	var logStatus int8 = 1 // 默认锁定中
	if isExpired {
		settleTime = orderSettleTime // 用实际应解锁时间，追溯准确
		logStatus = 2                 // 直接已解锁
	} else {
		settleTime = orderSettleTime
		logStatus = 1
	}

	// ===== 指数退避重试（3 次）：防瞬时 DB 抖动 / FOR UPDATE 锁超时 =====
	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		errTx := store.DB.Transaction(func(tx *gorm.DB) error {
			// 事务内再查一次幂等（防并发两个 sponsorRechargeSettle 同时跑进这个 for 循环）
			var innerCount int64
			if cerr := tx.Model(&model.MerchantIncomeLog{}).
				Where("purchase_id = ? AND type = 5", uint(o.ID)).
				Count(&innerCount).Error; cerr == nil && innerCount > 0 {
				return nil // 已被其他 goroutine 分过了，事务直接空提交
			}
			// FOR UPDATE 锁 merchant 行，和 sweep/refund/admin adjust 互斥串行
			var lockedMerchant model.Merchant
			if merr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("username = ?", merchant.Username).First(&lockedMerchant).Error; merr != nil {
				return merr
			}
			if isExpired {
				// 已过期：直接加到 balance_points（可提现）
				res := tx.Model(&lockedMerchant).Updates(map[string]interface{}{
					"balance_points": gorm.Expr("ROUND(balance_points + ?, 3)", merchantEarn),
					"total_earned":   gorm.Expr("ROUND(total_earned + ?, 3)", merchantEarn),
				})
				if res.Error != nil {
					return res.Error
				}
			} else {
				// 未过期：加到 pending_points（锁定期中）
				res := tx.Model(&lockedMerchant).Updates(map[string]interface{}{
					"pending_points": gorm.Expr("ROUND(pending_points + ?, 3)", merchantEarn),
					"total_earned":   gorm.Expr("ROUND(total_earned + ?, 3)", merchantEarn),
				})
				if res.Error != nil {
					return res.Error
				}
			}
			logEntry := &model.MerchantIncomeLog{
				Merchant:     merchant.Username,
				GameID:       o.GameID,
				Username:     o.Username,
				PurchaseID:   uint(o.ID),
				UserPay:      o.Points,
				Commission:   commission,
				MerchantEarn: merchantEarn,
				Type:         5,
				Status:       logStatus,
				SettleTime:   &settleTime,
			}
			if err := tx.Create(logEntry).Error; err != nil {
				return err
			}
			return nil
		})
		if errTx == nil {
			if isExpired {
				logger.Info("赞助充值分账（已过期直接解锁）：订单 %d 用户 %s 游戏#%d 付 %.3f → 商户 %s 应得 %.3f（commission=%.2f, 已过 %d 天锁定期, attempt=%d）",
					o.ID, o.Username, o.GameID, o.Points, merchant.Username, merchantEarn, commission, lockDays, attempt)
			} else {
				logger.Info("赞助充值分账：订单 %d 用户 %s 游戏#%d 付 %.3f → 商户 %s 应得 %.3f（commission=%.2f, attempt=%d）",
					o.ID, o.Username, o.GameID, o.Points, merchant.Username, merchantEarn, commission, attempt)
			}
			return // ✅ 成功退出
		}
		lastErr = errTx
		if attempt < maxAttempts {
			backoff := time.Duration(100<<uint(attempt-1)) * time.Millisecond // 100ms, 200ms
			logger.Warn("赞助充值分账失败（订单 %d），%d/%d 次重试：%v", o.ID, attempt, maxAttempts, errTx)
			time.Sleep(backoff)
		}
	}
	// 全部重试失败 → 落 Error 日志 + 管理员 grep sponsor_settle_failed 补账
	logger.Error("⚡赞助充值分账全部重试失败⚡：订单 %d 用户 %s 游戏#%d 商户 %s 应得 %.3f，最后错误：%v —— 请人工补账：UPDATE merchant SET pending_points += %.3f WHERE username='%s'；INSERT income_log (type=5) 或调用 /admin/api/merchant/revenue/adjust",
		o.ID, o.Username, o.GameID, merchant.Username, merchantEarn, lastErr, merchantEarn, merchant.Username)
}

// sponsorRechargeCompensateSweep 赞助充值分账补偿单轮（包级，供 InitGame 定时任务 + 单测直接调用）：
// 扫 success 但没有产生 type=5 分账流水的订单（进程 OOM kill / sponsorRechargeSettle goroutine 还没跑到就被回收 /
// sponsorRechargeSettle 在 MerchantRevenueEnabled=false 时跳过等场景），
// 逐单调 sponsorRechargeSettle（幂等前置 COUNT 保证安全，不会重复加分账）。
//
// 扫描窗口 = max(RefundDays * 2, 24h)：默认约 14 天（RefundDays=7×2），
// 语义上至少覆盖完整锁定期的两倍，适配配置短暂关闭再打开的场景；
// 同时有 LIMIT 50 限制单轮行数，配合 (status, create_time) 索引保证性能。
// 更早的漏单（窗口外）属于极端场景，可通过 admin 后台手动补账接口处理
func sponsorRechargeCompensateSweep(cfg *config.Config) int {
	if cfg == nil || !cfg.Game.MerchantRevenueEnabled {
		return 0
	}
	refundDays := cfg.Game.RefundDays
	if refundDays <= 0 {
		refundDays = 7
	}
	// 窗口 = max(RefundDays*2, 1) — 至少 1 天（24h），跟配置联动
	windowDays := refundDays * 2
	if windowDays < 1 {
		windowDays = 1
	}
	// LEFT JOIN 找 success 但没有 type=5 分账的订单（GORM 原生写法避免子查询）；
	// 额外 LEFT JOIN im_game 过滤掉已下架/无 owner 的游戏——它们本来就不会产生商家分账，
	// 留在这里只会每轮扫到、每轮刷一遍"游戏不存在"日志，造成日志污染且浪费 DB 查询
	var missed []model.RechargeOrder
	if err := store.DB.Raw(`
		SELECT ro.* FROM im_recharge_order ro
		LEFT JOIN im_merchant_income_log mil
			ON mil.purchase_id = ro.id AND mil.type = 5
		INNER JOIN im_game g ON g.id = ro.game_id
		WHERE ro.status = 1 AND mil.id IS NULL
		  AND ro.create_time > NOW() - INTERVAL ? DAY
		  AND g.owner_username != ''
		ORDER BY ro.id ASC LIMIT 50
	`, windowDays).Scan(&missed).Error; err != nil {
		logger.Warn("赞助充值补偿查询失败：%v", err)
		return 0
	}
	n := 0
	for i := range missed {
		sponsorRechargeSettle(cfg, &missed[i]) // 幂等前置保证安全，已经分过账的直接 return
		n++
	}
	if n > 0 {
		logger.Info("赞助充值补偿本轮扫描：%d 条 success 但未分账的订单，补调 sponsorRechargeSettle", n)
	}
	return n
}

// sponsorRechargeCompensateLoop 赞助充值分账补偿定时任务（InitGame 启动，60s 周期；可通过配置关闭）：
// 兜底 sponsorRechargeSettle 因进程异常/重试耗尽而未执行的分账。
// 正常情况下 sponsorRechargeSettle 本身 3 次重试已够，本任务应对最极端的"goroutine 还没跑到就 OOM kill"
func sponsorRechargeCompensateLoop(cfg *config.Config) {
	for {
		time.Sleep(time.Minute)
		func() {
			defer func() {
				if e := recover(); e != nil {
					logger.Error("赞助充值补偿扫描异常（下轮继续）：%v", e)
				}
			}()
			sponsorRechargeCompensateSweep(cfg)
		}()
	}
}
