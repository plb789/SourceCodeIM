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
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

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

// gwDbwriteEnqueue 入队归口（幂等 upsert）：候选游戏过滤"带网关规则 或 指定写库网关"后
// 派生启动密码入队，同账号同游戏仅一行、密码变化才更新；失败仅记日志——写库链路绝不阻塞
// 登录/心跳主链路。纯游戏（无网关规则且 dbwrite_gw 空）不入队
func gwDbwriteEnqueue(username, launchSecret string, gameIDs []uint) {
	if username == "" || launchSecret == "" || len(gameIDs) == 0 {
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
		// 密钥源归口：游戏专属密钥优先，空（未补种/异常）回退全局 launch_secret 兜底
		pw := gameLaunchPassword(gameLaunchSecretPick(&g, launchSecret), username, g.ID)
		var row model.GatewayDbwrite
		if err := store.DB.Where("username = ? AND game_id = ?", username, g.ID).First(&row).Error; err != nil {
			if err := store.DB.Create(&model.GatewayDbwrite{Username: username, GameID: g.ID, Password: pw}).Error; err != nil {
				logger.Error("网关写库入队失败（%s 游戏#%d）：%v", username, g.ID, err)
			}
		} else if row.Password != pw {
			// 启动密码派生密钥变更（launch_secret 轮换）场景：刷新队列，网关拉取后重写游戏库自愈
			store.DB.Model(&row).Update("password", pw)
		}
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
	if gwName != "" {
		if g, found := s.gwBookFindByName(gwName); found {
			if t := strings.TrimSpace(g.Secret); t != "" {
				sec = t
			}
		}
	}
	if err := gwproto.VerifyAuth(sec, r.Header.Get(gwproto.AuthHeader), r.Method, r.URL.RequestURI(), body, time.Now()); err != nil {
		// 原因仅落日志（含来源与自报网关名便于排查），响应统一 401 不回显细节
		logger.Warn("网关写库接口鉴权失败（%s %s gw=%s 来源=%s）：%v", r.Method, r.URL.RequestURI(), gwName, r.RemoteAddr, err)
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

// handleInternalGatewayDbwrite GET /internal/gateway/dbwrite?gw={name}
// 网关自报身份拉取待写条目（按网关过滤 + 已回执剔除），响应体 AES-256-GCM 加密下发
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
	// 该网关关联游戏集（全量游戏逐个解析 port_forwards；游戏量级=管理员上架数，一次内存解析零压力）。
	// 缺省规则（gw 空）仅在请求网关=地址簿第一条启用网关时归它：defaultGW 置为自身即命中 gw=="" 分支
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
	if len(gset) > 0 {
		ids := make([]uint, 0, len(gset))
		for id := range gset {
			ids = append(ids, id)
		}
		var rows []model.GatewayDbwrite
		store.DB.Where("game_id IN ?", ids).Order("id ASC").Find(&rows)
		// 已回执剔除（该网关维度；其他网关的回执互不影响）
		var acked []uint64
		store.DB.Model(&model.GatewayDbwriteAck{}).Where("gateway_name = ?", gwName).Pluck("dbwrite_id", &acked)
		aset := make(map[uint64]bool, len(acked))
		for _, a := range acked {
			aset[a] = true
		}
		for _, row := range rows {
			if aset[row.ID] {
				continue
			}
			items = append(items, map[string]interface{}{"id": row.ID, "username": row.Username, "password": row.Password})
		}
	}
	if len(items) > 0 {
		logger.Info("网关写库拉取：网关 %s 取待写条目 %d 条", gwName, len(items))
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
	n := 0
	for _, id := range req.IDs {
		if id == 0 {
			continue
		}
		if err := store.DB.Create(&model.GatewayDbwriteAck{DbwriteID: id, GatewayName: gwName}).Error; err == nil {
			n++
		} // 唯一索引冲突=重复回执，幂等忽略；其余异常静默（下次拉取重试写库无害）
	}
	logger.Info("网关写库回执：网关 %s 确认 %d 条（新落回执 %d）", gwName, len(req.IDs), n)
	adminJSON(w, map[string]interface{}{"ok": true, "acked": n})
}
