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
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/gwproto"
	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
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
	rate := g.RechargeRate
	if rate <= 0 {
		rate = 1
	}
	amount := aiPointsRound3(pay * rate)
	gw := strings.ToLower(strings.TrimSpace(g.RechargeGw))
	order := model.RechargeOrder{Username: username, GameID: g.ID, Points: pay, Amount: amount, Status: model.RechargeOrderStatusPending, Gw: gw}
	// 事务归口：扣分与建单同事务（任一失败整体回滚，积分不悬空）；
	// 扣分 WHERE points>=pay 并发不透支（rowsAffected=0 即余额不足）。
	// 日限额复检在事务内且置于扣分 UPDATE 之后：该 UPDATE 持有用户行锁直至提交，同用户并发下单
	// 在此天然串行——后到者复检时先到者的订单已提交可见，超额即回滚（外层预检存在 check-then-act
	// 窗口，两并发单可同时通过预检，此处复检是真正的限额约束；读视图在扣分等待结束后建立，必见先到订单）
	errInsufficient := fmt.Errorf("积分不足")
	errDayLimit := fmt.Errorf("超出日限额")
	err := store.DB.Transaction(func(tx *gorm.DB) error {
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
		return tx.Create(&order).Error
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
	after, _ := userPoints(username)
	recordPointsLog(username, -pay, after, "game_recharge", "system", fmt.Sprintf("积分兑换充值: %s（订单 %d）", g.Name, order.ID))
	logger.Info("充值订单创建：用户 %s 游戏#%d 积分 %.3f 到账 %.3f 网关 %s 订单 %d", username, g.ID, pay, amount, gw, order.ID)
	balance, _ := userPoints(username)
	adminJSON(w, map[string]interface{}{"ok": true, "order_id": order.ID, "points": pay, "amount": amount, "balance": aiPointsRound3(balance)})
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
// 迁移成功才退积分——并发重复调用/重复回执绝不双重退分。返回是否本次调用完成退分
func rechargeRefund(o *model.RechargeOrder, reason string) bool {
	if len(reason) > 250 {
		reason = reason[:250]
	}
	now := time.Now()
	res := store.DB.Model(&model.RechargeOrder{}).
		Where("id = ? AND status = ?", o.ID, model.RechargeOrderStatusPending).
		Updates(map[string]interface{}{"status": model.RechargeOrderStatusFailed, "fail_reason": reason, "done_time": &now})
	if res.Error != nil {
		logger.Error("充值订单标失败失败（订单 %d）：%v", o.ID, res.Error)
		return false
	}
	if res.RowsAffected == 0 {
		return false // 已是终态（重复回执/并发扫描），幂等忽略
	}
	// 原值全额退分（ROUND 归一口径与扣分一致），流水 reason=game_recharge_refund
	res2 := store.DB.Model(&model.User{}).Where("username = ?", o.Username).
		Update("points", gorm.Expr("ROUND(points + ?, 3)", o.Points))
	if res2.Error != nil {
		// 标 failed 已生效但退分失败：人工对账归口（订单终态与积分不一致必须暴露）
		logger.Error("充值退分失败（订单 %d 用户 %s 应退 %.3f）：%v", o.ID, o.Username, o.Points, res2.Error)
		return true
	}
	after, _ := userPoints(o.Username)
	recordPointsLog(o.Username, o.Points, after, "game_recharge_refund", "system", fmt.Sprintf("充值失败退还（订单 %d）: %s", o.ID, reason))
	logger.Info("充值订单退分：订单 %d 用户 %s 退 %.3f（%s）", o.ID, o.Username, o.Points, reason)
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
