package server

// ===== 阶段二百九十五 B2：成就定义·管理端 CRUD =====
// 设计归口：
//   1. 成就定义是运营数据（不是系统配置），走 DB + Admin API 动态维护；
//      启动时的 seed 仅首次填充通用模板，后续全由管理员在后台维护。
//   2. 路由前缀 /admin/api/game/achievement/*（复用 gameadmin.go 子域 + adminGuard 鉴权）
//   3. 响应统一 JSON：{"ok":true,"data":...} / {"ok":false,"msg":"..."}（adminJSON/adminFail 归口）
//   4. 唯一键保护：idx_game_code(game_id, code) → 后端 Upsert 或 DoNothing 幂等

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm/clause"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== 稀有度常量（与 model.go 口径一致） =====
// 0 Common / 1 Uncommon / 2 Rare / 3 Epic / 4 Legendary

// achRarityExp 默认经验值映射（与 store/mysql.go seed 一致）
var achRarityExp = map[int8]int{0: 10, 1: 25, 2: 50, 3: 100, 4: 200}

// achRarityLabel 前端展示用中文标签
var achRarityLabel = map[int8]string{
	0: "常见", 1: "罕见", 2: "稀有", 3: "史诗", 4: "传说",
}

// achExpFromRarity 若 exp_reward 未传或为 0，按稀有度自动推导
func achExpFromRarity(rarity int8) int {
	if v, ok := achRarityExp[rarity]; ok {
		return v
	}
	return 10
}

// ===== 路由注册（由 registerGameAdminRoutes 调用） =====

func registerAchievementAdminRoutes(s *Server) {
	// 成就定义 CRUD
	http.HandleFunc("GET /admin/api/game/achievement/list", s.adminGuard(s.handleAdminAchievementList))
	http.HandleFunc("GET /admin/api/game/achievement/{id}", s.adminGuard(s.handleAdminAchievementDetail))
	http.HandleFunc("POST /admin/api/game/achievement", s.adminGuard(s.handleAdminAchievementCreate))
	http.HandleFunc("PUT /admin/api/game/achievement/{id}", s.adminGuard(s.handleAdminAchievementUpdate))
	http.HandleFunc("DELETE /admin/api/game/achievement/{id}", s.adminGuard(s.handleAdminAchievementDelete))
	// 批量操作
	http.HandleFunc("POST /admin/api/game/achievement/batch", s.adminGuard(s.handleAdminAchievementBatch))
	// 导入：将 mysql.go seed 逻辑的通用池/专属模板应用到指定游戏（一键补齐）
	http.HandleFunc("POST /admin/api/game/achievement/seed", s.adminGuard(s.handleAdminAchievementSeed))
	// 重置：清空指定游戏的全部成就定义（谨慎操作）
	http.HandleFunc("DELETE /admin/api/game/achievement/clear", s.adminGuard(s.handleAdminAchievementClear))
	// 稀有度枚举（下拉框数据源）
	http.HandleFunc("GET /admin/api/game/achievement/rarities", s.adminGuard(s.handleAdminAchievementRarities))
}

// ===== Handler 实现 =====

// handleAdminAchievementList GET /admin/api/game/achievement/list
// 分页 + 筛选：game_id 必填；code/name 模糊；rarity 可空
func (s *Server) handleAdminAchievementList(w http.ResponseWriter, r *http.Request) {
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 32)
	if gameID == 0 {
		adminFail(w, http.StatusBadRequest, "game_id 必填")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	q := store.DB.Model(&model.GameAchievement{}).Where("game_id = ?", uint(gameID))
	if keyword != "" {
		q = q.Where("name LIKE ? OR code LIKE ?", "%"+keyword+"%", "%"+keyword+"%")
	}
	// 注意：strconv.Atoi("") 返回 0（不是 error），必须先检查 key 是否存在
	if rarityStr := r.URL.Query().Get("rarity"); rarityStr != "" {
		if rInt, err := strconv.Atoi(rarityStr); err == nil && rInt >= 0 && rInt <= 4 {
			q = q.Where("rarity = ?", int8(rInt))
		}
	}

	var total int64
	q.Count(&total)

	var list []model.GameAchievement
	q.Order("rarity DESC, id ASC").Offset((page - 1) * size).Limit(size).Find(&list)

	type row struct {
		model.GameAchievement
		RarityLabel string `json:"rarity_label"`
	}
	rows := make([]row, 0, len(list))
	for _, a := range list {
		rows = append(rows, row{GameAchievement: a, RarityLabel: achRarityLabel[a.Rarity]})
	}

	adminJSON(w, map[string]interface{}{
		"total": total, "page": page, "size": size, "list": rows,
		"game_id": gameID, "game_name": func() string {
			var g model.Game
			_ = store.DB.Select("name").First(&g, gameID).Error
			return g.Name
		}(),
	})
}

// handleAdminAchievementDetail GET /admin/api/game/achievement/{id}
func (s *Server) handleAdminAchievementDetail(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "ID 无效")
		return
	}
	var a model.GameAchievement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "成就不存在")
		return
	}
	type detail struct {
		model.GameAchievement
		RarityLabel string `json:"rarity_label"`
		GameSlug    string `json:"game_slug"`
		GameName    string `json:"game_name"`
	}
	d := detail{GameAchievement: a, RarityLabel: achRarityLabel[a.Rarity]}
	var g model.Game
	if store.DB.Select("slug, name").First(&g, a.GameID).Error == nil {
		d.GameSlug = g.Slug
		d.GameName = g.Name
	}
	adminJSON(w, d)
}

// handleAdminAchievementCreate POST /admin/api/game/achievement
// 新增一条成就定义；code 同 game_id 下唯一，冲突则拒绝
func (s *Server) handleAdminAchievementCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GameID    uint   `json:"game_id"`
		Code      string `json:"code"`
		Name      string `json:"name"`
		Desc      string `json:"desc"`
		Icon      string `json:"icon"`
		Rarity    int8   `json:"rarity"`
		ExpReward int    `json:"exp_reward"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if body.GameID == 0 {
		adminFail(w, http.StatusBadRequest, "game_id 必填")
		return
	}
	if body.Code == "" || len(body.Code) > 64 {
		adminFail(w, http.StatusBadRequest, "code 必填且 ≤64 字符")
		return
	}
	if body.Name == "" || len(body.Name) > 128 {
		adminFail(w, http.StatusBadRequest, "name 必填且 ≤128 字符")
		return
	}
	if body.Rarity < 0 || body.Rarity > 4 {
		adminFail(w, http.StatusBadRequest, "rarity 必须在 0-4 之间")
		return
	}
	if body.ExpReward <= 0 {
		body.ExpReward = achExpFromRarity(body.Rarity)
	}
	// 查重
	var cnt int64
	store.DB.Model(&model.GameAchievement{}).
		Where("game_id = ? AND code = ?", body.GameID, body.Code).Count(&cnt)
	if cnt > 0 {
		adminFail(w, http.StatusBadRequest, "同一游戏下 code 已存在，请换一个")
		return
	}
	a := model.GameAchievement{
		GameID: body.GameID, Code: body.Code, Name: body.Name,
		Desc: body.Desc, Icon: body.Icon, Rarity: body.Rarity, ExpReward: body.ExpReward,
	}
	if err := store.DB.Create(&a).Error; err != nil {
		logger.Error("管理员新增成就失败 game=%d code=%s: %v", body.GameID, body.Code, err)
		adminFail(w, http.StatusBadRequest, "保存失败")
		return
	}
	logger.Info("管理员新增成就: game=%d code=%s name=%s", body.GameID, body.Code, body.Name)
	adminJSON(w, a)
}

// handleAdminAchievementUpdate PUT /admin/api/game/achievement/{id}
// 更新成就定义；code 不可跨 game_id 变更（安全防唯一键冲突）
func (s *Server) handleAdminAchievementUpdate(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "ID 无效")
		return
	}
	var body struct {
		Code      *string `json:"code"`
		Name      *string `json:"name"`
		Desc      *string `json:"desc"`
		Icon      *string `json:"icon"`
		Rarity    *int8   `json:"rarity"`
		ExpReward *int    `json:"exp_reward"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	var a model.GameAchievement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "成就不存在")
		return
	}
	updates := map[string]interface{}{}
	if body.Code != nil {
		if *body.Code == "" || len(*body.Code) > 64 {
			adminFail(w, http.StatusBadRequest, "code 非法")
			return
		}
		// 查重（同 game_id 下其他成就是否已用此 code）
		var cnt int64
		store.DB.Model(&model.GameAchievement{}).
			Where("game_id = ? AND code = ? AND id != ?", a.GameID, *body.Code, id).Count(&cnt)
		if cnt > 0 {
			adminFail(w, http.StatusBadRequest, "同一游戏下 code 已存在")
			return
		}
		updates["code"] = *body.Code
	}
	if body.Name != nil {
		if *body.Name == "" || len(*body.Name) > 128 {
			adminFail(w, http.StatusBadRequest, "name 非法")
			return
		}
		updates["name"] = *body.Name
	}
	if body.Desc != nil {
		updates["desc"] = *body.Desc
	}
	if body.Icon != nil {
		updates["icon"] = *body.Icon
	}
	if body.Rarity != nil {
		if *body.Rarity < 0 || *body.Rarity > 4 {
			adminFail(w, http.StatusBadRequest, "rarity 必须在 0-4 之间")
			return
		}
		updates["rarity"] = *body.Rarity
		// 改稀有度时若 exp_reward 仍未显式设置 → 自动推导
		if body.ExpReward == nil {
			updates["exp_reward"] = achExpFromRarity(*body.Rarity)
		}
	}
	if body.ExpReward != nil {
		if *body.ExpReward <= 0 {
			*body.ExpReward = achExpFromRarity(a.Rarity)
		}
		updates["exp_reward"] = *body.ExpReward
	}
	if len(updates) == 0 {
		adminFail(w, http.StatusBadRequest, "没有有效字段")
		return
	}
	if err := store.DB.Model(&a).Updates(updates).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "更新失败")
		return
	}
	logger.Info("管理员更新成就: id=%d", id)
	adminJSON(w, map[string]interface{}{"updated": true})
}

// handleAdminAchievementDelete DELETE /admin/api/game/achievement/{id}
// 删除单条成就定义（已解锁的成就记录 im_user_achievement 保留不级联，仅定义移除）
func (s *Server) handleAdminAchievementDelete(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, _ := strconv.ParseUint(idStr, 10, 64)
	if id == 0 {
		adminFail(w, http.StatusBadRequest, "ID 无效")
		return
	}
	var a model.GameAchievement
	if err := store.DB.First(&a, id).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "成就不存在")
		return
	}
	if err := store.DB.Delete(&a).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "删除失败")
		return
	}
	logger.Info("管理员删除成就: id=%d game=%d code=%s", id, a.GameID, a.Code)
	adminJSON(w, map[string]interface{}{"deleted": true})
}

// handleAdminAchievementBatch POST /admin/api/game/achievement/batch
// 批量：items=[{code,name,desc,rarity,exp_reward}] → Upsert（code 已存在则更新 name/desc/rarity/exp_reward；不存在则插入）
// 这是管理员"批量导入/一键补齐"的核心入口——前端可以把 seed 里的模板或外部 JSON 贴进来
func (s *Server) handleAdminAchievementBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GameID uint `json:"game_id"`
		Items  []struct {
			Code      string `json:"code"`
			Name      string `json:"name"`
			Desc      string `json:"desc"`
			Icon      string `json:"icon"`
			Rarity    int8   `json:"rarity"`
			ExpReward int    `json:"exp_reward"`
		} `json:"items"`
		Upsert bool `json:"upsert"` // true=存在则更新 false=只插入忽略冲突
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return
	}
	if body.GameID == 0 || len(body.Items) == 0 {
		adminFail(w, http.StatusBadRequest, "game_id + items 必填")
		return
	}
	if len(body.Items) > 200 {
		adminFail(w, http.StatusBadRequest, "单次最多 200 条")
		return
	}

	inserted, updated, skipped := 0, 0, 0
	tx := store.DB.Begin()
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	for _, it := range body.Items {
		if it.Code == "" || it.Name == "" || it.Rarity < 0 || it.Rarity > 4 {
			skipped++
			continue
		}
		if len(it.Code) > 64 || len(it.Name) > 128 {
			skipped++
			continue
		}
		if it.ExpReward <= 0 {
			it.ExpReward = achExpFromRarity(it.Rarity)
		}
		ach := model.GameAchievement{
			GameID: body.GameID, Code: it.Code, Name: it.Name,
			Desc: it.Desc, Icon: it.Icon, Rarity: it.Rarity, ExpReward: it.ExpReward,
		}
		if body.Upsert {
			// 先查是否已存在 → 区分 inserted vs updated
			var existing model.GameAchievement
			exists := tx.Where("game_id = ? AND code = ?", body.GameID, it.Code).First(&existing).Error == nil
			res := tx.Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "game_id"}, {Name: "code"}},
				DoUpdates: clause.AssignmentColumns([]string{"name", "desc", "icon", "rarity", "exp_reward"}),
			}).Create(&ach)
			if res.Error != nil {
				tx.Rollback()
				logger.Error("批量导入失败 upsert game=%d code=%s: %v", body.GameID, it.Code, res.Error)
				adminFail(w, http.StatusBadRequest, "批量保存失败")
				return
			}
			if exists {
				updated++
			} else if res.RowsAffected > 0 {
				inserted++
			} else {
				skipped++
			}
		} else {
			res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ach)
			if res.Error != nil {
				tx.Rollback()
				logger.Error("批量导入失败 create game=%d code=%s: %v", body.GameID, it.Code, res.Error)
				adminFail(w, http.StatusBadRequest, "批量保存失败")
				return
			}
			if res.RowsAffected > 0 {
				inserted++
			} else {
				skipped++
			}
		}
	}
	if err := tx.Commit().Error; err != nil {
		tx.Rollback()
		logger.Error("批量导入 Commit 失败 game=%d: %v", body.GameID, err)
		adminFail(w, http.StatusBadRequest, "批量保存失败")
		return
	}
	logger.Info("管理员批量导入成就: game=%d upsert=%v inserted=%d updated=%d skipped=%d", body.GameID, body.Upsert, inserted, updated, skipped)
	adminJSON(w, map[string]interface{}{
		"inserted": inserted, "updated": updated, "skipped": skipped, "upsert": body.Upsert,
	})
}

// handleAdminAchievementSeed POST /admin/api/game/achievement/seed
// 一键应用 seed 模板到指定游戏（复用 mysql.go 的通用池 + 专属模板逻辑）
// 请求体：{ "game_id": 1 } 或 { "game_ids": [1,2,3] } 或 { "all": true }
func (s *Server) handleAdminAchievementSeed(w http.ResponseWriter, r *http.Request) {
	var body struct {
		GameID  *uint  `json:"game_id"`
		GameIDs []uint `json:"game_ids"`
		All     bool   `json:"all"`
	}
	json.NewDecoder(r.Body).Decode(&body)

	var targetIDs []uint
	switch {
	case body.All:
		var games []model.Game
		if err := store.DB.Select("id").Find(&games).Error; err != nil {
			adminFail(w, http.StatusBadRequest, "查询游戏失败")
			return
		}
		for _, g := range games {
			targetIDs = append(targetIDs, g.ID)
		}
	case len(body.GameIDs) > 0:
		targetIDs = body.GameIDs
	case body.GameID != nil && *body.GameID > 0:
		targetIDs = []uint{*body.GameID}
	default:
		adminFail(w, http.StatusBadRequest, "请指定 game_id / game_ids 或 all=true")
		return
	}
	if len(targetIDs) > 30 {
		adminFail(w, http.StatusBadRequest, "单次最多处理 30 款游戏")
		return
	}

	// 复用 store/mysql.go 里的模板（运行时从 DB 查 slug → 内存 map）
	// 先把游戏 slug 查出来（专属模板匹配用）
	var games []model.Game
	if err := store.DB.Select("id, slug, name").Where("id IN ?", targetIDs).Find(&games).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "查询游戏失败")
		return
	}

	type tpl struct {
		Code   string
		Name   string
		Desc   string
		Rarity int8
	}
	generic := []tpl{
		{"first_play", "初入江湖", "第一次启动该游戏", 0},
		{"play_1h", "初尝滋味", "累计游玩 1 小时", 0},
		{"play_5h", "渐入佳境", "累计游玩 5 小时", 0},
		{"play_10h", "小有成就", "累计游玩 10 小时", 0},
		{"play_10_times", "常客", "累计启动 10 次", 0},
		{"first_screenshot", "留影纪念", "在该游戏中截取第一张截图", 0},
		{"play_25h", "沉浸其中", "累计游玩 25 小时", 1},
		{"play_30_times", "回头客", "累计启动 30 次", 1},
		{"early_bird", "早起的鸟儿", "在清晨 6:00-9:00 之间游玩", 1},
		{"play_50h", "深度玩家", "累计游玩 50 小时", 2},
		{"play_night_owl", "夜猫子", "在深夜 23:00-3:00 之间累计游玩 10 小时", 2},
		{"play_100h", "资深玩家", "累计游玩 100 小时", 3},
		{"play_200h", "传奇玩家", "累计游玩 200 小时", 4},
	}

	// 专属模板映射（与 store/mysql.go achBySlug 完全一致，双文件必须同步维护）
	// 当前 30 个热门游戏专属模板，共约 150+ 条特色成就
	slugMap := map[string][]tpl{
		// ===== FPS / 射击类 =====
		"counter-strike-2": {
			{"first_blood", "初战告捷", "在对战中取得第一次击杀", 0},
			{"ace", "ACE", "一回合内击杀对方全部 5 人", 3},
			{"defuse_ace", "拆弹 ACE", "残局 1v5 成功拆除炸弹", 4},
			{"headshot_master", "爆头大师", "累计完成 1000 次爆头", 2},
			{"deagle_only", "沙鹰专家", "使用 Desert Eagle 完成 50 次击杀", 2},
			{"clutch_1v5", "残局大师", "在 1v5 残局中成功翻盘", 4},
		},
		"valorant": {
			{"first_blood", "首杀", "获得第一次击杀", 0},
			{"ace_round", "王牌回合", "一回合内击杀所有敌人", 3},
			{"operator_main", "狙击手", "使用 Operator 完成 100 次击杀", 2},
			{"flawless_victory", "完美胜利", "在竞技模式中以 13:0 获胜", 4},
		},
		"overwatch-2": {
			{"first_elimination", "首杀", "获得第一次消灭", 0},
			{"teammate_rescue", "救命恩人", "一次对局中复活队友 5 次", 1},
			{"payload_hero", "推车英雄", "在推车模式中累计推车上限 50 次", 2},
			{"potg", "全场最佳", "获得一次全场最佳（Play of the Game）", 3},
		},
		"rainbow-six-siege": {
			{"first_blood", "首杀", "取得第一次击杀", 0},
			{"one_vs_five", "孤胆英雄", "1v5 残局成功获胜", 4},
			{"drone_master", "侦查大师", "一局中用无人机标记敌人 20 次", 1},
		},

		// ===== MOBA 类 =====
		"dota-2": {
			{"first_blood", "一血", "送出或拿到一血", 0},
			{"rampage", "暴走", "连续击杀对方 5 人且自己未死", 4},
			{"triple_kill", "三杀", "一次团战中连续击杀 3 人", 2},
			{"ward_master", "视野大师", "累计放置 500 个守卫", 1},
			{"comeback_king", "翻盘之王", "落后 1 万经济差的情况下获胜", 4},
		},
		"league-of-legends": {
			{"first_blood", "一血", "在对局中取得第一次击杀", 0},
			{"penta_kill", "五杀", "一次团战中连续击杀对方 5 人", 4},
			{"triple_kill", "三杀", "一次团战中连续击杀 3 人", 2},
			{"dragon_slayer", "屠龙勇士", "累计击杀 50 条小龙", 1},
			{"baron_steal", "抢龙", "从对方手中抢到纳什男爵", 4},
		},
		"smite": {
			{"first_blood", "首杀", "获得第一次击杀", 0},
			{"pentakill", "五杀", "一次团战中连续击杀 5 人", 4},
			{"fire_giant", "火焰巨人杀手", "累计击杀 20 次火焰巨人", 2},
		},

		// ===== 沙盒 / 生存类 =====
		"minecraft": {
			{"first_craft", "工匠学徒", "完成第一次合成", 0},
			{"first_mine", "矿工", "挖到第一块矿石", 0},
			{"diamond_hunter", "钻石猎人", "挖到第一颗钻石", 1},
			{"ender_dragon", "龙之杀手", "击败末影龙", 3},
			{"nether_portal", "下界之门", "点亮下界传送门", 1},
			{"full_armor", "铁甲战士", "集齐一整套钻石护甲", 2},
			{"wither_killer", "凋灵猎人", "击败凋灵 Boss", 3},
			{"elytra", "翱翔天际", "获得鞘翅并飞行 1000 格", 4},
		},
		"rust": {
			{"first_survive", "活下来", "存活超过 24 小时（游戏内时间）", 0},
			{"first_kill", "生存本能", "在 PVP 中取得第一次击杀", 0},
			{"base_builder", "建筑师", "建造超过 100 个建筑部件", 1},
			{"raider", "掠夺者", "成功突袭并掠夺他人基地 5 次", 3},
		},
		"don_t_starve": {
			{"first_survive", "活下去", "存活 10 天", 0},
			{"winter_survivor", "过冬达人", "成功度过第一个冬天", 1},
			{"ancient_guardian", "远古守护者", "击败远古守卫者", 3},
		},

		// ===== RPG / 动作类 =====
		"elden-ring": {
			{"first_boss", "褪色者的第一步", "击败第一个 Boss", 0},
			{"margit", "恶兆已除", "击败恶兆玛尔基特", 2},
			{"godrick", "黄金树种子", "击败接肢葛德文", 2},
			{"malenia", "米凯拉之刃", "击败米凯拉之刃·玛莲妮亚", 4},
			{"radahn", "碎星之战", "在碎星之战中击败拉塔恩", 3},
			{"rune_bearer", "大卢恩持有者", "装备第一个大卢恩", 1},
			{"all_bosses", "艾尔登之王", "击败所有主线 Boss", 4},
		},
		"cyberpunk-2077": {
			{"first_kill", "街头佣兵", "取得第一次击杀", 0},
			{"ripperdoc", "赛博改造", "安装第一个义体", 0},
			{"main_story_end", "夜之城传奇", "通关主线剧情", 3},
			{"all_romances", "情场浪子", "与所有可攻略对象达成亲密关系", 3},
			{"legendary_hunter", "传说收藏家", "收集 10 件传说级装备", 2},
		},
		"gta-5": {
			{"first_heist", "江洋大盗", "完成第一次抢劫", 1},
			{"story_complete", "洛圣都之王", "通关所有主线任务", 3},
			{"first_million", "百万富翁", "累计资产达到 100 万", 2},
			{"wanted_5min", "五星通缉", "在五星通缉下存活 5 分钟", 2},
			{"all_stunts", "特技大师", "完成全部 50 个特技跳跃", 3},
		},
		"witcher-3": {
			{"first_sign", "法印学徒", "第一次使用法印", 0},
			{"griffin", "狮鹫已除", "击败皇家狮鹫", 1},
			{"story_complete", "猎魔人传奇", "通关主线剧情", 3},
			{"all_gwent", "昆特牌大师", "收集所有昆特牌", 3},
			{"blood_and_wine", "陶森特守护者", "完成血与酒 DLC 主线", 3},
		},

		// ===== 体育 / 竞速类 =====
		"fifa-24": {
			{"first_match", "初登场", "完成第一场比赛", 0},
			{"first_goal", "破门得分", "打进第一个进球", 0},
			{"hat_trick", "帽子戏法", "一场比赛中打进 3 球", 2},
			{"champion", "联赛冠军", "带领球队夺得联赛冠军", 3},
		},
		"nba-2k24": {
			{"first_match", "首秀", "完成第一场比赛", 0},
			{"first_3pointer", "三分出手", "投进第一个三分球", 0},
			{"triple_double", "三双机器", "一场比赛中取得三双数据", 3},
			{"champion", "总冠军", "夺得 NBA 总冠军", 3},
		},
		"forza_horizon-5": {
			{"first_race", "竞速新秀", "完成第一场比赛", 0},
			{"first_win", "初次夺冠", "赢得第一场比赛", 0},
			{"all_cars", "车库大师", "收集 100 辆不同的车辆", 2},
			{"s1_classic", "S1 经典赛冠军", "赢得 S1 赛季经典赛", 3},
		},

		// ===== 策略 / 模拟类 =====
		"civilization-6": {
			{"first_city", "建国之父", "建立第一座城市", 0},
			{"first_tech", "科技之光", "研究第一项科技", 0},
			{"science_victory", "科学胜利", "以科学胜利方式通关", 4},
			{"domination_victory", "统治胜利", "以统治胜利方式通关", 4},
			{"20_cities", "超级大国", "同时拥有 20 座城市", 3},
		},
		"stellaris": {
			{"first_contact", "第一次接触", "与外星文明第一次接触", 1},
			{"wonders", "奇观建造者", "建造 5 个不同的奇观", 2},
			{"galactic_conqueror", "银河征服者", "控制银河系 50% 的领土", 4},
		},
		"europa_universalis_4": {
			{"first_royal_marriage", "王室联姻", "完成第一次王室联姻", 0},
			{"first_war", "第一次战争", "赢得第一场战争", 0},
			{"puella_magna", "普鲁士的崛起", "成立普鲁士", 3},
		},

		// ===== 平台 / 冒险类 =====
		"hollow_knight": {
			{"first_charm", "护符收藏家", "收集第一个护符", 0},
			{"first_boss", "小骑士", "击败第一个 Boss", 0},
			{"all_bosses", "空洞骑士", "击败所有 Boss（含寻神者）", 4},
			{"steel_soul", "钢魂通关", "在钢魂模式下通关", 4},
		},
		"celeste": {
			{"first_chapter", "启程", "完成第一章", 0},
			{"all_chapters", "登顶", "完成所有章节", 3},
			{"b_sides", "B 面通关", "完成所有 B 面关卡", 3},
			{"c_sides", "C 面通关", "完成所有 C 面关卡", 4},
		},

		// ===== 多人合作 / 生存类 =====
		"left_4_dead_2": {
			{"first_helped", "救命恩人", "拉起倒下的队友 5 次", 0},
			{"no_incap", "毫发无损", "一个战役中不被击倒", 2},
			{"realism_survivor", "绝境求生", "在写实模式下通关一个战役", 3},
		},
		"warframe": {
			{"first_warframe", "战甲收集家", "获得第一个战甲", 0},
			{"first_sortie", "出击", "完成第一次每日出击", 1},
			{"mr20", "精通 20 级", "达到精通等级 20", 4},
		},
		"destiny-2": {
			{"first_strike", "打击完成", "完成第一个打击任务", 0},
			{"first_raid", "初次突袭", "完成第一次突袭", 2},
			{"lfg_titan", "泰坦征服者", "在《希望的火花》突袭中通关", 4},
		},
	}

	totalInserted := 0
	for _, g := range games {
		var templates []tpl
		templates = append(templates, generic...)
		if extra, ok := slugMap[g.Slug]; ok {
			templates = append(templates, extra...)
		}
		// 先收集同游戏全部成就，再一次 CreateInBatches + DoNothing 幂等
		// 避免双层循环内 N×M 次 round-trip（之前 30 游戏 × 15~20 条 = 450~600 次单独 Create）
		batch := make([]model.GameAchievement, 0, len(templates))
		for _, t := range templates {
			exp := achExpFromRarity(t.Rarity)
			batch = append(batch, model.GameAchievement{
				GameID: g.ID, Code: t.Code, Name: t.Name,
				Desc: t.Desc, Rarity: t.Rarity, ExpReward: exp,
			})
		}
		res := store.DB.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(batch, 20)
		inserted := 0
		if res.Error == nil {
			inserted = int(res.RowsAffected) // DoNothing 下 RowsAffected = 实际新增条数
		} else {
			logger.Error("成就 seed 应用到 game_id=%d slug=%s 失败: %v", g.ID, g.Slug, res.Error)
		}
		totalInserted += inserted
		logger.Info("成就 seed 应用到 game_id=%d slug=%s 模板=%d 新增=%d", g.ID, g.Slug, len(templates), inserted)
	}

	adminJSON(w, map[string]interface{}{
		"games": len(games), "inserted": totalInserted,
	})
}

// handleAdminAchievementClear DELETE /admin/api/game/achievement/clear
// 清空指定游戏的全部成就定义（谨慎操作；已解锁记录 im_user_achievement 不级联）
func (s *Server) handleAdminAchievementClear(w http.ResponseWriter, r *http.Request) {
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 32)
	if gameID == 0 {
		adminFail(w, http.StatusBadRequest, "game_id 必填")
		return
	}
	var g model.Game
	if err := store.DB.First(&g, gameID).Error; err != nil {
		adminFail(w, http.StatusBadRequest, "游戏不存在")
		return
	}
	res := store.DB.Where("game_id = ?", gameID).Delete(&model.GameAchievement{})
	logger.Info("管理员清空成就定义: game=%d slug=%s deleted=%d", gameID, g.Slug, res.RowsAffected)
	adminJSON(w, map[string]interface{}{"deleted": res.RowsAffected})
}

// handleAdminAchievementRarities GET /admin/api/game/achievement/rarities
// 稀有度枚举（前端下拉框数据源）
func (s *Server) handleAdminAchievementRarities(w http.ResponseWriter, r *http.Request) {
	type item struct {
		Value   int8   `json:"value"`
		Label   string `json:"label"`
		Exp     int    `json:"exp"`
		Color   string `json:"color"`
	}
	items := []item{
		{0, "常见", 10, "#b0b0b0"},
		{1, "罕见", 25, "#1e90ff"},
		{2, "稀有", 50, "#9b59b6"},
		{3, "史诗", 100, "#e67e22"},
		{4, "传说", 200, "#f1c40f"},
	}
	adminJSON(w, items)
}

// ===== admin 响应辅助（admin.go 里 adminJSON/adminFail 已存在） =====
// 但为避免跨文件隐式依赖，这里再提供一份兜底

// adminJSON / adminFail 实际在 admin.go 已定义；此处通过编译期验证引用关系确保不遗漏

// ===== 阶段二百九十五 B3：玩家端成就查询接口 =====
// GET /api/game/achievement/list?game_id=X — 一次性成就列表（含解锁状态 + 进度）
// GET /api/game/achievement/daily?game_id=X — 每日成就列表（含今日解锁状态 + Redis 进度）

// achievementItem 玩家端成就展示项（一次性 + 每日 共用结构）
type achievementItem struct {
	ID              uint    `json:"id"`
	Code            string  `json:"code"`
	Name            string  `json:"name"`
	Desc            string  `json:"desc"`
	Icon            string  `json:"icon"`
	Rarity          int8    `json:"rarity"`
	RarityLabel     string  `json:"rarity_label"`
	ExpReward       int     `json:"exp_reward"`
	Unlocked        bool    `json:"unlocked"`
	UnlockTime      *string `json:"unlock_time,omitempty"`
	ProgressCurrent float64 `json:"progress_current"` // 0 表示无进度概念（布尔型成就）
	ProgressTarget  float64 `json:"progress_target"`  // 0 表示无进度概念
	ProgressPct     int     `json:"progress_pct"`     // 0-100
}

// achievementListResp GET /api/game/achievement/list 响应顶层
type achievementListResp struct {
	GameID   uint              `json:"game_id"`
	GameName string            `json:"game_name"`
	Total    int               `json:"total"`
	Unlocked int               `json:"unlocked"`
	Items    []achievementItem `json:"items"`
}

// achievementDailyResp GET /api/game/achievement/daily 响应顶层
type achievementDailyResp struct {
	GameID   uint              `json:"game_id"`
	GameName string            `json:"game_name"`
	DateKey  string            `json:"date_key"` // YYYY-MM-DD 自然日
	Total    int               `json:"total"`
	Unlocked int               `json:"unlocked"`
	Items    []achievementItem `json:"items"`
}

// HandleGameAchievementList GET /api/game/achievement/list?game_id=X
// 玩家端查询指定游戏的一次性成就列表（含自己的解锁状态 + 实时进度）
// 鉴权：gameAuthToken（X-Drive-Token header 或 dt query 参数）
func (s *Server) HandleGameAchievementList(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	if gameID == 0 {
		profileFail(w, "game_id 必填")
		return
	}

	// ① 查游戏（顺带校验存在性 + 取 game_name）
	var game model.Game
	if err := store.DB.First(&game, gameID).Error; err != nil {
		profileFail(w, "游戏不存在")
		return
	}

	// ② 查成就定义列表（复用引擎缓存）
	defs := achEngineDefsOf(uint(gameID))
	if len(defs) == 0 {
		profileOK(w, achievementListResp{GameID: uint(gameID), GameName: game.Name})
		return
	}

	// ③ 查已解锁集合
	var unlockedRows []model.UserAchievement
	store.DB.Where("username = ? AND game_id = ?", username, gameID).Find(&unlockedRows)
	unlockedMap := make(map[uint]time.Time, len(unlockedRows))
	for _, u := range unlockedRows {
		unlockedMap[u.AchievementID] = u.UnlockTime
	}

	// ④ 查用户游戏库累计数据（play_seconds / play_count）
	var lib model.GameLibrary
	hasLib := store.DB.Where("username = ? AND game_id = ?", username, gameID).First(&lib).Error == nil

	// ⑤ 查累计充值积分（充值成就进度用）
	totalPaid := achUserTotalPointsPaid(username, uint(gameID))

	// ⑥ 组装 items
	now := time.Now()
	items := make([]achievementItem, 0, len(defs))
	unlockedCount := 0
	for _, def := range defs {
		item := achievementItem{
			ID:          def.ID,
			Code:        def.Code,
			Name:        def.Name,
			Desc:        def.Desc,
			Icon:        def.Icon,
			Rarity:      def.Rarity,
			RarityLabel: achRarityLabel[def.Rarity],
			ExpReward:   def.ExpReward,
		}

		unlockTime, isUnlocked := unlockedMap[def.ID]
		if isUnlocked {
			unlockedCount++
			item.Unlocked = true
			t := unlockTime.Format(time.RFC3339)
			item.UnlockTime = &t
			item.ProgressCurrent = item.ProgressTarget
			item.ProgressPct = 100
		} else {
			// 计算进度（未解锁才算；已解锁直接 100%）
			cur, tgt := achCalcProgress(def.Code, lib.PlaySeconds, lib.PlayCount, totalPaid, now, hasLib)
			item.ProgressCurrent = cur
			item.ProgressTarget = tgt
			if tgt > 0 {
				item.ProgressPct = int(math.Min(100, math.Round(cur/tgt*100)))
			}
		}
		items = append(items, item)
	}

	profileOK(w, achievementListResp{
		GameID:   uint(gameID),
		GameName: game.Name,
		Total:    len(defs),
		Unlocked: unlockedCount,
		Items:    items,
	})
}

// HandleGameAchievementDaily GET /api/game/achievement/daily?game_id=X
// 玩家端查询指定游戏的每日成就列表（含今日解锁状态 + Redis 实时进度）
// 鉴权：gameAuthToken（X-Drive-Token header 或 dt query 参数）
func (s *Server) HandleGameAchievementDaily(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	if gameID == 0 {
		profileFail(w, "game_id 必填")
		return
	}

	// ① 查游戏
	var game model.Game
	if err := store.DB.First(&game, gameID).Error; err != nil {
		profileFail(w, "游戏不存在")
		return
	}

	// ② 查每日成就定义列表（复用引擎缓存）
	defs := achDailyDefsOf(uint(gameID))
	if len(defs) == 0 {
		profileOK(w, achievementDailyResp{GameID: uint(gameID), GameName: game.Name, DateKey: achDailyTodayKey()})
		return
	}

	// ③ 查今日已解锁集合
	dateKey := achDailyTodayKey()
	var unlockedRows []model.UserDailyAchievement
	store.DB.Where("username = ? AND game_id = ? AND date_key = ?", username, gameID, dateKey).Find(&unlockedRows)
	unlockedMap := make(map[uint]time.Time, len(unlockedRows))
	for _, u := range unlockedRows {
		unlockedMap[u.DailyAchievementID] = u.UnlockTime
	}

	// ④ Redis 今日游玩秒数（daily_play_30m 进度用）
	var todayPlaySecs int64
	if store.RDB != nil {
		key := achDailyRedisKeyPlaySecs(username, uint(gameID), dateKey)
		if v, err := store.RDB.Get(context.Background(), key).Int64(); err == nil {
			todayPlaySecs = v
		}
	}

	// ⑤ 组装 items
	items := make([]achievementItem, 0, len(defs))
	unlockedCount := 0
	for _, def := range defs {
		item := achievementItem{
			ID:          def.ID,
			Code:        def.Code,
			Name:        def.Name,
			Desc:        def.Desc,
			Icon:        def.Icon,
			Rarity:      def.Rarity,
			RarityLabel: achRarityLabel[def.Rarity],
			ExpReward:   def.ExpReward,
		}

		unlockTime, isUnlocked := unlockedMap[def.ID]
		if isUnlocked {
			unlockedCount++
			item.Unlocked = true
			t := unlockTime.Format(time.RFC3339)
			item.UnlockTime = &t
			item.ProgressCurrent = item.ProgressTarget
			item.ProgressPct = 100
		} else {
			// 每日成就进度：daily_play_30m 走 Redis，其余用 0/1 布尔型
			switch def.Code {
			case "daily_play_30m":
				item.ProgressCurrent = float64(todayPlaySecs)
				item.ProgressTarget = float64(achDailyPlay30mThreshold)
				if item.ProgressTarget > 0 {
					item.ProgressPct = int(math.Min(100, math.Round(item.ProgressCurrent/item.ProgressTarget*100)))
				}
			default:
				// 其他每日成就：0/1 布尔型（已解锁=100%，未解锁=0%）
				// 这里统一返回 0/1，解锁后上面 isUnlocked 分支会设 100%
				item.ProgressCurrent = 0
				item.ProgressTarget = 1
				item.ProgressPct = 0
			}
		}
		items = append(items, item)
	}

	profileOK(w, achievementDailyResp{
		GameID:   uint(gameID),
		GameName: game.Name,
		DateKey:  dateKey,
		Total:    len(defs),
		Unlocked: unlockedCount,
		Items:    items,
	})
}

// achCalcProgress 计算一条一次性成就的进度（current / target）
// 返回 0,0 表示该成就无进度概念（布尔型：解锁即 100%，未解锁即 0%）
func achCalcProgress(code string, playSeconds, playCount int64, totalPaid float64, now time.Time, hasLib bool) (float64, float64) {
	// 时长型：play_Xh
	if m := achRuleHoursRe.FindStringSubmatch(code); m != nil {
		hours, _ := strconv.ParseFloat(m[1], 10)
		target := hours * 3600
		if !hasLib {
			return 0, target
		}
		return math.Min(float64(playSeconds), target), target
	}
	// 次数型：play_X_times
	if m := achRuleTimesRe.FindStringSubmatch(code); m != nil {
		times, _ := strconv.ParseFloat(m[1], 10)
		if !hasLib {
			return 0, times
		}
		return math.Min(float64(playCount), times), times
	}
	// 首次游玩：first_play
	if achRuleFirstPlay.MatchString(code) {
		if !hasLib {
			return 0, 1
		}
		if playCount < 1 {
			return 0, 1
		}
		return 1, 1
	}
	// 累计充值：pay_X
	if m := achRulePayRe.FindStringSubmatch(code); m != nil {
		target, _ := strconv.ParseFloat(m[1], 10)
		return math.Min(totalPaid, target), target
	}
	// 首次充值：first_pay
	if code == "first_pay" {
		if totalPaid <= 0 {
			return 0, 1
		}
		return 1, 1
	}
	// 时段型（early_bird / play_night_owl）：无进度概念
	// 其他成就（游戏专属等）：无进度概念
	return 0, 0
}

// ===== P1：每日成就手动解锁 + 成就统计 =====

// HandleGameDailyAchievementUnlock POST /api/game/achievement/daily/unlock
// 客户端主动上报解锁某条每日成就（与一次性成就 unlock 平行）
// 鉴权：gameAuthToken（X-Drive-Token header 或 dt query 参数）
// 幂等：同一自然日同一成就重复解锁静默返回 already=true
// 防刷：复用 achCheckReplayAndRateLimit + HMAC 签名校验
func (s *Server) HandleGameDailyAchievementUnlock(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}

	var req struct {
		GameID   uint   `json:"game_id"`
		Code     string `json:"achievement_code"`
		ClientTs int64  `json:"client_ts"`
		Nonce    string `json:"nonce"`
	}
	bodyBytes, _ := io.ReadAll(r.Body)
	if len(bodyBytes) == 0 {
		profileFail(w, "参数不完整")
		return
	}
	if err := json.Unmarshal(bodyBytes, &req); err != nil || req.GameID == 0 || req.Code == "" {
		profileFail(w, "参数不完整")
		return
	}
	if len(req.Code) > 64 {
		profileFail(w, "成就标识过长")
		return
	}
	if len(req.Nonce) > 128 {
		profileFail(w, "nonce 过长")
		return
	}

	// ① 查每日成就定义
	var dach model.GameDailyAchievement
	if err := store.DB.Where("game_id = ? AND code = ?", req.GameID, req.Code).First(&dach).Error; err != nil {
		profileFail(w, "每日成就不存在")
		return
	}

	// ② 防重放 + 频率限制 + 签名校验（复用一次性成就口径）
	if req.Nonce != "" {
		if ok, reason := achCheckReplayAndRateLimit(username, req.Nonce, req.ClientTs, 300, 60, 10); !ok {
			profileFail(w, reason)
			return
		}
	}
	if !achVerifySignature(username, req.GameID, req.ClientTs, req.Nonce, bodyBytes, r.Header.Get("X-Game-Signature")) {
		profileFail(w, "签名校验失败")
		return
	}

	// ③ 游戏在库校验
	if !achIsGameInLibrary(username, req.GameID) {
		profileFail(w, "该游戏尚未加入您的游戏库")
		return
	}

	// ④ 解锁（调用 achDailyUnlockCore，已内置幂等 + 经验值 + 等级 + 徽章）
	dateKey := achDailyTodayKey()
	already, expGain, newLevel, levelUp, err := achDailyUnlockCore(username, dach, dateKey)
	if err != nil {
		profileFail(w, "保存失败")
		return
	}
	if already {
		profileOK(w, map[string]interface{}{"unlocked": true, "already": true})
		return
	}

	// ⑤ WS 推送（复用 pushAchievementUnlocked 构造临时 GameAchievement）
	pushAch := model.GameAchievement{
		GameID: dach.GameID, Code: dach.Code, Name: dach.Name, Desc: dach.Desc,
		Icon: dach.Icon, Rarity: dach.Rarity, ExpReward: expGain,
	}
	s.pushAchievementUnlocked(username, pushAch, expGain, levelUp, newLevel)

	profileOK(w, map[string]interface{}{
		"unlocked": true, "exp_gain": expGain,
		"level_up": levelUp, "new_level": newLevel,
		"daily":    true,
		"achievement": map[string]interface{}{
			"game_id": dach.GameID, "code": dach.Code, "name": dach.Name,
			"desc": dach.Desc, "icon": dach.Icon, "rarity": dach.Rarity,
		},
	})
}

// HandleGameAchievementStats GET /api/game/achievement/stats?game_id=X
// 返回该游戏成就统计数据：总成就数、已解锁数、完成率、每日今日已解锁数等
// 鉴权：gameAuthToken
func (s *Server) HandleGameAchievementStats(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	if gameID == 0 {
		profileFail(w, "game_id 必填")
		return
	}

	// 一次性成就统计
	var totalCount int64
	store.DB.Model(&model.GameAchievement{}).Where("game_id = ?", gameID).Count(&totalCount)
	var unlockedCount int64
	store.DB.Model(&model.UserAchievement{}).
		Where("username = ? AND game_id = ?", username, gameID).Count(&unlockedCount)

	// 每日成就统计
	var dailyTotalCount int64
	store.DB.Model(&model.GameDailyAchievement{}).Where("game_id = ?", gameID).Count(&dailyTotalCount)
	dateKey := achDailyTodayKey()
	var dailyUnlockedCount int64
	store.DB.Model(&model.UserDailyAchievement{}).
		Where("username = ? AND game_id = ? AND date_key = ?", username, gameID, dateKey).
		Count(&dailyUnlockedCount)

	completionRate := 0.0
	if totalCount > 0 {
		completionRate = math.Round(float64(unlockedCount)/float64(totalCount)*1000) / 10
	}
	dailyRate := 0.0
	if dailyTotalCount > 0 {
		dailyRate = math.Round(float64(dailyUnlockedCount)/float64(dailyTotalCount)*1000) / 10
	}

	profileOK(w, map[string]interface{}{
		"game_id":           uint(gameID),
		"total":             totalCount,
		"unlocked":          unlockedCount,
		"completion_rate":   completionRate,
		"daily_date_key":    dateKey,
		"daily_total":       dailyTotalCount,
		"daily_unlocked":    dailyUnlockedCount,
		"daily_completion":  dailyRate,
	})
}
