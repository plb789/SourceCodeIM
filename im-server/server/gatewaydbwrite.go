package server

// ===== 端口透传·网关写库：队列 + 内部拉取/回执接口（网关开发文档 §3.1） =====
// 链路：登录成功/启动心跳 → im_gateway_dbwrite 队列（幂等）→ 网关 30s 周期拉取（HMAC 鉴权 +
// AES-GCM 响应加密）→ 网关参数化写游戏库 → 回执 ack。客户端零参与、零改动。
// 安全归口：
//   1. 鉴权协议实现在 im-server/gwproto（与网关共享单实现，body 纳入签名 + ±300s 防重放）；
//   2. 网关身份 = gw 自报 + 地址簿存在性校验（持钥才可签名，冒充无收益）；
//   3. 按网关过滤：游戏 port_forwards 里 mode=gateway 的 @网关名 决定条目归属，gw 空规则
//      缺省归地址簿第一条启用网关——游戏 A 的库不混入只玩游戏 B 的玩家；
//   4. 响应体强制 AES-256-GCM（X-GW-Enc），明文 2087 链路抓包不可见账号/启动密码。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm/clause"

	"im-server/gwproto"
	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// gwGameHasGatewayRule 游戏是否带网关模式转发规则（入队过滤归口：纯单机/直连游戏无写库意义）
func gwGameHasGatewayRule(pfJSON string) bool {
	if pfJSON == "" {
		return false
	}
	var rules []struct {
		Mode string `json:"mode"`
	}
	if json.Unmarshal([]byte(pfJSON), &rules) != nil {
		return false
	}
	for _, r := range rules {
		if r.Mode == "gateway" {
			return true
		}
	}
	return false
}

// gwGamesForGateway 按网关过滤归口（拉取侧动态计算，不落关联表）：
// 返回 name 网关关联的游戏 ID 集，两条命中路径取并集——
//
//	① 转发规则：mode=gateway 且 gw==name（gw 空串 = 缺省地址簿第一条启用网关 defaultGW）；
//	② 写库网关字段：game.dbwrite_gw==name（仅写库游戏——不配转发规则、显式声明写库归属）。
//
// defaultGW 为空（地址簿空）时缺省规则永不命中。
func gwGamesForGateway(games []model.Game, name, defaultGW string) map[uint]bool {
	set := map[uint]bool{}
	for _, g := range games {
		gwHit := false
		if g.PortForwards != "" {
			var rules []struct {
				Mode string `json:"mode"`
				Gw   string `json:"gw"`
			}
			if json.Unmarshal([]byte(g.PortForwards), &rules) == nil {
				for _, r := range rules {
					if r.Mode != "gateway" {
						continue
					}
					gw := strings.ToLower(strings.TrimSpace(r.Gw))
					if gw == name || (gw == "" && name == defaultGW) {
						gwHit = true
						break
					}
				}
			}
		}
		if !gwHit && strings.EqualFold(strings.TrimSpace(g.DbwriteGw), name) {
			gwHit = true // 仅写库游戏：显式声明写库归属（不配转发规则）
		}
		if gwHit {
			set[g.ID] = true
		}
	}
	return set
}

// gwDbwriteEnqueue 入队归口（幂等 upsert + 密码变化才清回执）：候选游戏过滤"带网关规则 或 指定写库网关"后
// 派生启动密码入队，同账号同游戏仅一行、密码变化才更新。
// 回执清除策略：
//   - 新建条目：Create 后清回执 → 网关立即可见（新账号注册首次入队）
//   - 已存在条目：**只有密码变化才清回执**——心跳每 60s 也会走这个函数（game.go action=start），
//     如果每次都清会导致回执表抖动 + 网关每 30s 重拉一次但被 last map 跳过白忙活；自愈路径靠
//     管理端「重置同步」按钮 + 网关 last map 的 5 分钟 TTL（过 TTL 强制重写），足够覆盖"商户清档"场景
//
// 写库模板是幂等的（insert/upsert 重复执行无副作用），重拉无害。失败仅记日志——写库链路绝不阻塞
// 登录/心跳主链路。纯游戏（无网关规则且 dbwrite_gw 空）不入队。
func gwDbwriteEnqueue(username, launchSecret string, gameIDs []uint) {
	if username == "" || len(gameIDs) == 0 {
		return
	}
	var games []model.Game
	if err := store.DB.Select("id, port_forwards, game_secret, dbwrite_gw").Where("id IN ?", gameIDs).Find(&games).Error; err != nil {
		logger.Error("网关写库入队查询失败（%s）：%v", username, err)
		return
	}
	for _, g := range games {
		// 入队条件（二选一）：带网关模式转发规则（归属按 @网关名）或 显式指定写库网关（仅写库游戏）
		if !gwGameHasGatewayRule(g.PortForwards) && strings.TrimSpace(g.DbwriteGw) == "" {
			continue
		}
		// 密钥源归口：游戏专属密钥优先，空（未补种/异常）回退全局 launch_secret 兜底；
		// 两者皆空（派生无材料，空密钥 HMAC 密码等同无防护）跳过该游戏并记日志
		sec := gameLaunchSecretPick(&g, launchSecret)
		if strings.TrimSpace(sec) == "" {
			logger.Error("网关写库入队跳过（%s 游戏#%d）：启动密码派生密钥缺失（游戏专属与全局兜底均空）", username, g.ID)
			continue
		}
		pw := gameLaunchPassword(sec, username, g.ID)
		var row model.GatewayDbwrite
		if err := store.DB.Where("username = ? AND game_id = ?", username, g.ID).First(&row).Error; err != nil {
			// 新建条目：Create 后取回填的 row.ID（AutoMigrate 主键自增会回填），清回执让网关立即可见
			if err := store.DB.Create(&model.GatewayDbwrite{Username: username, GameID: g.ID, Password: pw}).Error; err != nil {
				logger.Error("网关写库入队失败（%s 游戏#%d）：%v", username, g.ID, err)
				continue
			}
			store.DB.Where("username = ? AND game_id = ?", username, g.ID).First(&row) // 回填 row.ID
			store.DB.Where("dbwrite_id = ?", row.ID).Delete(&model.GatewayDbwriteAck{})
		} else if row.Password != pw {
			// 密码变化：更新 + 清回执 → 网关立即重写新密码（密钥轮换自愈场景）
			store.DB.Model(&row).Update("password", pw)
			store.DB.Where("dbwrite_id = ?", row.ID).Delete(&model.GatewayDbwriteAck{})
		}
		// else: 已存在且密码未变，不清回执，避免心跳每 60s 触发无效抖动
	}
}

// GwDbwriteEnqueueForUser 登录成功触发点（finishLogin 异步调用归口）：玩家库内全部游戏入队
// （不含网关规则的游戏在 gwDbwriteEnqueue 内过滤），不阻塞登录链路
func (s *Server) GwDbwriteEnqueueForUser(username string) {
	if !s.cfg.Game.Enabled || strings.TrimSpace(username) == "" {
		return
	}
	var ids []uint
	if err := store.DB.Model(&model.GameLibrary{}).Where("username = ?", username).Pluck("game_id", &ids).Error; err != nil {
		logger.Error("网关写库入队（%s）库查询失败：%v", username, err)
		return
	}
	gwDbwriteEnqueue(username, s.cfg.Game.LaunchSecret, ids)
}

// gwBookFindByName 地址簿条目查询（enabled；按 @网关名）
func (s *Server) gwBookFindByName(name string) (model.GatewayBook, bool) {
	var g model.GatewayBook
	if err := store.DB.Where("name = ? AND enabled = ?", name, true).First(&g).Error; err != nil {
		return g, false
	}
	return g, true
}

// gwDbwriteAuth 内部接口鉴权归口（逐网关独立密钥）：先按 gw 名定位地址簿条目选验签密钥
// ——条目配置了专属 secret（非空）则用它验签，**签名通过即密码学证明该网关身份**（不再仅自报家门）；
// 条目未配置/不存在回退共享 gateway_token_secret（兼容存量，存在性校验由调用方另行把关）。
// HMAC 验签含 body 纳签 + ±300s 防重放；返回实际用于验签的 sec（拉取响应用同密钥加密，两端必须一致）
func (s *Server) gwDbwriteAuth(w http.ResponseWriter, r *http.Request, body []byte, gwName string) (string, bool) {
	shared := s.gameGatewaySecret()
	if shared == "" {
		adminFail(w, http.StatusForbidden, "网关写库未配置")
		return "", false
	}
	sec := shared
	secSource := "共享密钥(gateway_token_secret)"
	if gwName != "" {
		if g, found := s.gwBookFindByName(gwName); found {
			if t := strings.TrimSpace(g.Secret); t != "" {
				sec = t
				secSource = fmt.Sprintf("地址簿专属密钥(DB.im_gateway_book.name=%s)", gwName)
			} else {
				secSource = "地址簿条目存在但 secret 为空→回退共享密钥"
			}
		} else {
			secSource = "地址簿无此名→回退共享密钥"
		}
	}
	// === 调试日志：验签参数全量打印（密钥只打前后各8位，防日志泄漏 ===
	authHeader := r.Header.Get(gwproto.AuthHeader)
	bodyHash := ""
	if body == nil {
		bodyHash = "(nil→空串)"
	} else {
		sum := sha256.Sum256(body)
		bodyHash = hex.EncodeToString(sum[:8])
	}
	secFmt := func(s string) string {
		if len(s) >= 16 {
			return s[:8] + "..." + s[len(s)-8:]
		}
		return "len=" + strconv.Itoa(len(s))
	}
	logger.Info("[DEBUG-鉴权] 方法=%s URI=%s 来源=%s gwName=%s 密钥来源=%s 密钥片段=%s authHeader=%s bodyHash=%s",
		r.Method, r.URL.RequestURI(), r.RemoteAddr, gwName, secSource, secFmt(sec), authHeader, bodyHash)
	// === 调试日志结束 ===
	if err := gwproto.VerifyAuth(sec, authHeader, r.Method, r.URL.RequestURI(), body, time.Now()); err != nil {
		// 原因仅落日志（含来源与自报网关名便于排查），响应统一 401 不回显细节
		logger.Warn("网关写库接口鉴权失败（%s %s gw=%s 来源=%s 密钥来源=%s 密钥片段=%s）：%v",
			r.Method, r.URL.RequestURI(), gwName, r.RemoteAddr, secSource, secFmt(sec), err)
		adminFail(w, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return sec, true
}

// gwDbwriteGatewayChecked gw 名地址簿校验归口：返回 (是地址簿成员, 是否地址簿第一条启用网关)
func (s *Server) gwDbwriteGatewayChecked(gwName string) (bool, bool) {
	list := s.gameGatewayList()
	for i, g := range list {
		if g["name"] == gwName {
			return true, i == 0
		}
	}
	return false, false
}

// handleInternalGatewayDbwrite GET /internal/gateway/dbwrite?gw={name}&limit=N&after_id=M
// 网关自报身份拉取待写条目（按网关过滤 + 已回执剔除 + 游标分页），响应体 AES-256-GCM 加密下发。
// - limit 默认/上限 500；after_id 为上一批最后条目的 ID（首次拉取不传=0）
// - SQL 层 NOT IN 子查询过滤已回执 + LIMIT limit+1（多取 1 条判 has_more），避免全量拉取 acked 集合
// - has_more=true 时网关用 next_after（=本批最后一条 ID）继续翻页；否则下轮 poll 从 0 重新拉
func (s *Server) handleInternalGatewayDbwrite(w http.ResponseWriter, r *http.Request) {
	gwName := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("gw")))
	// 鉴权密钥按自报名定位条目专属密钥（验签通过=身份证明）；响应加密用同一密钥（网关解密一致）
	sec, ok := s.gwDbwriteAuth(w, r, nil, gwName)
	if !ok {
		return
	}
	if gwName == "" {
		adminFail(w, http.StatusBadRequest, "缺少 gw 参数")
		return
	}
	member, isDefault := s.gwDbwriteGatewayChecked(gwName)
	if !member {
		adminFail(w, http.StatusForbidden, "网关不在地址簿")
		return
	}
	// LIMIT 分页：默认 500，上限 500（防滥用），下限 1
	limit := 500
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 500 {
			limit = n
		}
	}
	// 游标：上一批最后条目的 ID（首次不传或 ≤0 即从头开始）
	afterID := uint64(0)
	if v := strings.TrimSpace(r.URL.Query().Get("after_id")); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			afterID = n
		}
	}
	// 该网关关联游戏集（缺省规则 gw=="" 仅在地址簿第一条启用网关时归自己）
	var games []model.Game
	if err := store.DB.Select("id, port_forwards, dbwrite_gw").Find(&games).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询游戏失败")
		return
	}
	defaultGW := ""
	if isDefault {
		defaultGW = gwName
	}
	gset := gwGamesForGateway(games, gwName, defaultGW)

	items := []map[string]interface{}{}
	hasMore := false
	nextAfter := uint64(0)
	if len(gset) > 0 {
		ids := make([]uint, 0, len(gset))
		for id := range gset {
			ids = append(ids, id)
		}
		// SQL 层过滤：game_id IN 归属集 AND (id > afterID OR afterID=0) AND id NOT IN 已回执 ——
		// 避免 Go 内存全量拉 acked 再全量拉 rows 的双重全表扫描（之前每轮 poll 扫两次 acked 表）
		q := store.DB.Where("game_id IN ?", ids)
		if afterID > 0 {
			q = q.Where("id > ?", afterID)
		}
		q = q.Where("id NOT IN (SELECT dbwrite_id FROM im_gateway_dbwrite_ack WHERE gateway_name = ?)", gwName)
		// LIMIT limit+1：多取 1 条判 has_more（比额外 COUNT 查询高效）
		var rows []model.GatewayDbwrite
		if err := q.Order("id ASC").Limit(limit + 1).Find(&rows).Error; err != nil {
			logger.Error("网关写库拉取 SQL 失败（网关 %s）：%v", gwName, err)
			adminFail(w, http.StatusInternalServerError, "拉取待写条目失败")
			return
		}
		for i, row := range rows {
			if i >= limit {
				hasMore = true
				break
			}
			items = append(items, map[string]interface{}{"id": row.ID, "username": row.Username, "password": row.Password})
			nextAfter = row.ID // 最后一条的 ID 作为下一批游标
		}
	}
	if len(items) > 0 && hasMore {
		logger.Info("网关写库拉取：网关 %s 取待写条目 %d 条（has_more=true，next_after=%d）", gwName, len(items), nextAfter)
	}
	// has_more=false 时静默（避免心跳每 30s 重复打相同日志）
	plain, _ := json.Marshal(map[string]interface{}{"items": items, "has_more": hasMore, "next_after": nextAfter})
	enc, err := gwproto.SealResp(sec, plain)
	if err != nil {
		adminFail(w, http.StatusInternalServerError, "响应加密失败")
		return
	}
	w.Header().Set(gwproto.RespEncHeader, gwproto.RespEncVer)
	_, _ = w.Write([]byte(enc))
}

// handleInternalGatewayDbwriteAck POST /internal/gateway/dbwrite/ack
// 网关回执已写入条目（body 纳入签名，中间人篡改 ids 即验签失败；验签密钥按 body 内 gw 定位
// 条目专属密钥——签名通过即身份证明）；唯一索引幂等，重复回执忽略
func (s *Server) handleInternalGatewayDbwriteAck(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		adminFail(w, http.StatusBadRequest, "读取请求体失败")
		return
	}
	// 先从 body 解析自报 gw 名（用于选验签密钥；body 参与签名，验签前解析仅为选钥不构成信任）
	var probe struct {
		GW string `json:"gw"`
	}
	_ = json.Unmarshal(body, &probe)
	if _, ok := s.gwDbwriteAuth(w, r, body, strings.ToLower(strings.TrimSpace(probe.GW))); !ok {
		return
	}
	var req struct {
		GW  string   `json:"gw"`
		IDs []uint64 `json:"ids"`
	}
	if err := json.Unmarshal(body, &req); err != nil || len(req.IDs) == 0 {
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
	// 批量 INSERT IGNORE：一次 SQL 写入，唯一索引冲突（重复回执）自动忽略。
	// GORM OnConflict DoNothing 跨 MySQL/SQLite 生效，CreateInBatches 每 100 条一批避免超长 SQL
	ackRows := make([]model.GatewayDbwriteAck, 0, len(req.IDs))
	for _, id := range req.IDs {
		if id == 0 {
			continue
		}
		ackRows = append(ackRows, model.GatewayDbwriteAck{DbwriteID: id, GatewayName: gwName})
	}
	n := int64(0)
	if len(ackRows) > 0 {
		res := store.DB.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(ackRows, 100)
		if res.Error != nil {
			logger.Warn("网关写库回执批量写入失败（%s）：%v", gwName, res.Error)
		} else {
			n = res.RowsAffected
		}
	}
	// Info 仅在有新回执落库时打，否则静默（心跳清 ack 后网关每 30s 回执 → 0 行受影响 = 幂等重复，不打日志）
	if n > 0 {
		logger.Info("网关写库回执：网关 %s 新增 %d 条回执（总上报 %d）", gwName, n, len(ackRows))
	}
	adminJSON(w, map[string]interface{}{"ok": true, "acked": n})
}
