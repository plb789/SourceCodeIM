package server

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ==================== P3：卡片合成徽章 + 积分商店 ====================

// cardDrawCost 单次抽卡消耗积分（Steam 同款集换式卡牌开包）
const cardDrawCost = 50.0

// rarityWeights 稀有度掉落权重（0普通→4传说），权重越低越稀有
var rarityWeights = map[int8]int{
	0: 60, // 普通 60%
	1: 25, // 罕见 25%
	2: 10, // 稀有 10%
	3: 4,  // 史诗 4%
	4: 1,  // 传说 1%
}

// foilChance 闪卡掉落概率（在已抽到的卡基础上再判定）
const foilChance = 0.05

// shopItemPrices 积分商店物品价格表（P3）
var shopItemPrices = map[string]float64{
	"avatar_frame":           200, // 头像框
	"golden_name":            500, // 金色昵称
	"showcase_theme_dark":    300, // 展示柜主题：暗夜深空
	"showcase_theme_ocean":   400, // 展示柜主题：深海蔚蓝
	"showcase_theme_forest":  500, // 展示柜主题：森林秘境
	"showcase_theme_sunset":  600, // 展示柜主题：落日余晖
}

// HandlePointsShopBuy POST /api/points/shop/buy
// 请求体：{ "item_id": "avatar_frame" }
// 校验积分余额 → 扣分 → 写入 im_user_shop_item → 返回剩余积分。幂等（已拥有直接返回）。
// 事务内 FOR UPDATE 锁 User 行消除 TOCTOU 竞态。
func (s *Server) HandlePointsShopBuy(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	var req struct {
		ItemID string `json:"item_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		profileFail(w, "JSON 格式错误")
		return
	}
	price, exist := shopItemPrices[req.ItemID]
	if !exist {
		profileFail(w, "物品不存在")
		return
	}

	// 幂等：已拥有
	var owned model.UserShopItem
	if err := store.DB.Where("username = ? AND item_id = ?", username, req.ItemID).First(&owned).Error; err == nil {
		// 查当前余额返回
		var u model.User
		if err := store.DB.Select("points").Where("username = ?", username).First(&u).Error; err != nil {
			profileOK(w, map[string]interface{}{"already": true, "points_left": 0})
			return
		}
		profileOK(w, map[string]interface{}{"already": true, "points_left": u.Points})
		return
	}

	var finalPoints float64
	var dupErr error // 捕获唯一索引冲突（并发幂等）
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		var user model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&user).Error; err != nil {
			return err
		}
		if user.Points < price {
			return errors.New("__insufficient__")
		}
		finalPoints = user.Points - price
		if err := tx.Model(&model.User{}).Where("username = ?", username).
			Update("points", finalPoints).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.UserShopItem{Username: username, ItemID: req.ItemID}).Error; err != nil {
			// 并发幂等：唯一索引冲突 → 积分扣除和 PointsLog 会随事务一起回滚
			if isDuplicateKey(err) { dupErr = err; return nil }
			return err
		}
		return tx.Create(&model.PointsLog{
			Username: username, Change: -price,
			BalanceAfter: finalPoints, Reason: "shop_buy", Operator: "system",
			Detail: "购买积分商店物品 " + req.ItemID,
		}).Error
	})
	if err != nil {
		if err.Error() == "__insufficient__" {
			profileFail(w, "积分不足，需要 "+strconv.FormatFloat(price, 'f', 0, 64)+" 积分")
			return
		}
		profileFail(w, "购买失败："+err.Error())
		return
	}
	// 并发幂等处理：唯一索引冲突（dupErr != nil）时事务已回滚积分扣除，
	// 重新查一次 UserShopItem，物品应该已被前一个请求持有，返回 already:true
	if dupErr != nil {
		var u model.User
		if err := store.DB.Select("points").Where("username = ?", username).First(&u).Error; err != nil {
			profileOK(w, map[string]interface{}{"already": true, "points_left": 0})
			return
		}
		profileOK(w, map[string]interface{}{"already": true, "points_left": u.Points})
		return
	}
	profileOK(w, map[string]interface{}{"points_left": finalPoints})
}

// isDuplicateKey 判断是否数据库唯一索引冲突（MySQL 1062 / SQLite UNIQUE constraint）
func isDuplicateKey(err error) bool {
	if err == nil { return false }
	msg := err.Error()
	return strings.Contains(msg, "1062") || strings.Contains(msg, "Duplicate entry") ||
		strings.Contains(msg, "UNIQUE constraint") || strings.Contains(msg, "idx_user_shop")
}

// HandleCardsGet GET /api/cards?game_id=xxx
// 返回指定游戏的全部卡片定义（含稀有度、卡组、闪卡标识）；用于合成工坊展示与抽卡卡池
func (s *Server) HandleCardsGet(w http.ResponseWriter, r *http.Request) {
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	if gameID == 0 {
		profileFail(w, "game_id 必填")
		return
	}
	var list []model.Card
	if err := store.DB.Where("game_id = ?", gameID).Order("card_set ASC, rarity ASC, id ASC").Find(&list).Error; err != nil {
		profileFail(w, "读取卡片列表失败")
		return
	}
	profileOK(w, map[string]interface{}{"list": list})
}

// HandleCardDraw POST /api/card/draw
// 请求体：{ "game_id": 1 }
// 消耗 cardDrawCost 积分，从该游戏卡池按稀有度权重随机抽一张卡（含闪卡判定），
// 写入 im_user_card（同卡堆叠 count）。事务保证扣积分+发卡原子性，积分变动写 PointsLog。
// 事务内 FOR UPDATE 锁 User 行消除 TOCTOU 竞态，crypto/rand 保证抽卡不可预测。
func (s *Server) HandleCardDraw(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	var req struct {
		GameID uint `json:"game_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		profileFail(w, "JSON 格式错误")
		return
	}
	if req.GameID == 0 {
		profileFail(w, "game_id 必填")
		return
	}

	// 1. 读取该游戏卡池（只做路由有效性校验，不涉及积分状态）
	var pool []model.Card
	if err := store.DB.Where("game_id = ?", req.GameID).Find(&pool).Error; err != nil || len(pool) == 0 {
		profileFail(w, "该游戏暂无可抽取的卡片")
		return
	}

	// 2. 按稀有度权重随机选卡（crypto/rand 不可预测）
	totalWeight := 0
	for _, c := range pool {
		totalWeight += rarityWeights[c.Rarity]
	}
	if totalWeight == 0 {
		profileFail(w, "卡池配置异常")
		return
	}
	rollBig, _ := rand.Int(rand.Reader, big.NewInt(int64(totalWeight)))
	roll := int(rollBig.Int64())
	var picked model.Card
	for _, c := range pool {
		roll -= rarityWeights[c.Rarity]
		if roll < 0 {
			picked = c
			break
		}
	}

	// 3. 闪卡判定（crypto/rand）
	foilBig, _ := rand.Int(rand.Reader, big.NewInt(100))
	isFoil := foilBig.Int64() < int64(foilChance*100)

	// 4. 事务：FOR UPDATE 锁 User 行 → 重校验余额 → 扣积分 + 写 UserCard + PointsLog
	var finalPoints float64
	txErr := store.DB.Transaction(func(tx *gorm.DB) error {
		var user model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&user).Error; err != nil {
			return err
		}
		if user.Points < cardDrawCost {
			return gorm.ErrRecordNotFound // 触发事务回滚，外层转为"积分不足"
		}
		finalPoints = user.Points - cardDrawCost
		if err := tx.Model(&model.User{}).Where("username = ?", username).
			Update("points", finalPoints).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.PointsLog{
			Username: username, Change: -cardDrawCost,
			BalanceAfter: finalPoints, Reason: "card_draw", Operator: "system",
			Detail: "抽取游戏 " + strconv.FormatUint(uint64(req.GameID), 10) + " 卡片",
		}).Error; err != nil {
			return err
		}
		var uc model.UserCard
		err := tx.Where("username = ? AND card_id = ?", username, picked.ID).First(&uc).Error
		if err != nil {
			uc = model.UserCard{Username: username, CardID: picked.ID, Count: 1}
			if isFoil {
				uc.FoilCount = 1
			}
			return tx.Create(&uc).Error
		}
		updates := map[string]interface{}{"count": uc.Count + 1}
		if isFoil {
			updates["foil_count"] = uc.FoilCount + 1
		}
		return tx.Model(&uc).Updates(updates).Error
	})
	if txErr != nil {
		if finalPoints == 0 { // 事务内校验积分不足的信号
			profileFail(w, "积分不足，抽卡需要 "+strconv.FormatFloat(cardDrawCost, 'f', 0, 64)+" 积分")
			return
		}
		profileFail(w, "抽卡失败："+txErr.Error())
		return
	}

	profileOK(w, map[string]interface{}{
		"card":        picked,
		"foil":        isFoil,
		"cost":        cardDrawCost,
		"points_left": finalPoints,
	})
}

// HandleProfileCardsGet GET /api/profile/cards?username=xxx
// 返回用户卡片背包：每张卡的定义 + 持有数量（含闪卡数），按游戏分组
func (s *Server) HandleProfileCardsGet(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("username")
	if target == "" {
		profileFail(w, "username 必填")
		return
	}
	var u model.User
	if err := store.DB.Where("username = ?", target).First(&u).Error; err != nil {
		profileFail(w, "用户不存在")
		return
	}
	// 隐私过滤
	viewer, _ := gameAuthToken(r)
	isSelf := viewer != "" && viewer == target
	if !isSelf {
		isFriend := false
		if viewer != "" {
			var f model.Friend
			if err := store.DB.Where("user_id = ? AND friend_id = ?", viewer, target).First(&f).Error; err == nil {
				isFriend = true
			}
		}
		if u.ProfileVisibility == 0 || (u.ProfileVisibility == 1 && !isFriend) {
			profileOK(w, map[string]interface{}{"groups": []interface{}{}})
			return
		}
	}

	var ucs []model.UserCard
	if err := store.DB.Where("username = ?", target).Find(&ucs).Error; err != nil {
		profileOK(w, map[string]interface{}{"groups": []interface{}{}})
		return
	}
	if len(ucs) == 0 {
		profileOK(w, map[string]interface{}{"groups": []interface{}{}})
		return
	}
	idSet := map[uint]bool{}
	for _, uc := range ucs {
		idSet[uc.CardID] = true
	}
	ids := make([]uint, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	var cards []model.Card
	if err := store.DB.Where("id IN ?", ids).Find(&cards).Error; err != nil {
		profileOK(w, map[string]interface{}{"groups": []interface{}{}})
		return
	}
	cardMap := map[uint]model.Card{}
	for _, c := range cards {
		cardMap[c.ID] = c
	}
	type cardItem struct {
		Card      model.Card `json:"card"`
		Count     int        `json:"count"`
		FoilCount int        `json:"foil_count"`
	}
	groupMap := map[uint][]cardItem{}
	for _, uc := range ucs {
		c, ok := cardMap[uc.CardID]
		if !ok {
			continue
		}
		groupMap[c.GameID] = append(groupMap[c.GameID], cardItem{Card: c, Count: uc.Count, FoilCount: uc.FoilCount})
	}
	type group struct {
		GameID   uint       `json:"game_id"`
		GameName string     `json:"game_name"`
		Items    []cardItem `json:"items"`
	}
	groups := make([]group, 0, len(groupMap))
	for gid, items := range groupMap {
		var g model.Game
		name := ""
		if err := store.DB.Select("name").Where("id = ?", gid).First(&g).Error; err == nil {
			name = g.Name
		}
		groups = append(groups, group{GameID: gid, GameName: name, Items: items})
	}
	profileOK(w, map[string]interface{}{"groups": groups})
}

// HandleBadgeTemplatesGet GET /api/badge/templates?game_id=xxx
// 返回徽章合成模板列表（含所需卡组、奖励经验/积分）
func (s *Server) HandleBadgeTemplatesGet(w http.ResponseWriter, r *http.Request) {
	gameID, _ := strconv.ParseUint(r.URL.Query().Get("game_id"), 10, 64)
	q := store.DB.Model(&model.BadgeTemplate{})
	if gameID > 0 {
		q = q.Where("game_id = ?", gameID)
	}
	var list []model.BadgeTemplate
	if err := q.Find(&list).Error; err != nil {
		profileFail(w, "读取徽章模板失败")
		return
	}
	profileOK(w, map[string]interface{}{"list": list})
}

// HandleBadgeCraft POST /api/badge/craft
// 请求体：{ "card_set": "warface_set1" }
// 校验用户是否集齐该 card_set 全部卡片（各至少1张），扣除卡片，发放 UserBadge + ExpReward + PointsReward。
func (s *Server) HandleBadgeCraft(w http.ResponseWriter, r *http.Request) {
	username, ok := gameAuthToken(r)
	if !ok || username == "" {
		profileFail(w, "请先登录")
		return
	}
	var req struct {
		CardSet string `json:"card_set"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		profileFail(w, "JSON 格式错误")
		return
	}
	if req.CardSet == "" {
		profileFail(w, "card_set 必填")
		return
	}

	// 1. 查徽章模板
	var tpl model.BadgeTemplate
	if err := store.DB.Where("card_set = ?", req.CardSet).First(&tpl).Error; err != nil {
		profileFail(w, "徽章模板不存在")
		return
	}

	// 2. 查该卡组全部卡片定义
	var cards []model.Card
	if err := store.DB.Where("card_set = ?", req.CardSet).Find(&cards).Error; err != nil || len(cards) == 0 {
		profileFail(w, "该卡组无卡片定义")
		return
	}

	// 3. 交叉校验：模板 GameID 必须与卡组 GameID 一致（防御脏数据）
	for _, c := range cards {
		if c.GameID != tpl.GameID {
			profileFail(w, "数据异常：卡组卡片与模板游戏不匹配")
			return
		}
	}

	// 4. 查用户持有情况，校验是否集齐
	var ucs []model.UserCard
	if err := store.DB.Where("username = ?", username).Find(&ucs).Error; err != nil {
		profileFail(w, "读取卡片背包失败")
		return
	}
	hold := map[uint]model.UserCard{}
	for _, uc := range ucs {
		hold[uc.CardID] = uc
	}
	for _, c := range cards {
		uc, ok := hold[c.ID]
		if !ok || uc.Count < 1 {
			profileFail(w, "卡片未集齐：缺少 "+c.Name)
			return
		}
	}

	// 5. 幂等：已合成过该徽章不再重复
	var exist model.UserBadge
	if err := store.DB.Where("username = ? AND type = ? AND code = ?", username, "card_set", tpl.CardSet).First(&exist).Error; err == nil {
		profileFail(w, "已合成过该徽章")
		return
	}

	// 6. 事务：FOR UPDATE 锁 User 行 → 扣卡 + 发徽章 + 经验/积分
	var finalUser model.User
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("username = ?", username).First(&finalUser).Error; err != nil {
			return err
		}
		newExp := finalUser.Exp + int64(tpl.ExpReward)
		newLevel := calcLevelFromExp(int(newExp))
		levelUp := newLevel > finalUser.Level
		newPoints := finalUser.Points + tpl.PointsReward

		for _, c := range cards {
			uc := hold[c.ID]
			if uc.Count <= 1 {
				if err := tx.Delete(&uc).Error; err != nil {
					return err
				}
			} else {
				if err := tx.Model(&uc).Update("count", uc.Count-1).Error; err != nil {
					return err
				}
			}
		}
		if err := tx.Create(&model.UserBadge{
			Username: username, Type: "card_set", Code: tpl.CardSet,
			Name: tpl.Name, Icon: tpl.Icon, Desc: tpl.Desc, ExpReward: tpl.ExpReward,
		}).Error; err != nil {
			return err
		}
		upd := map[string]interface{}{"exp": newExp}
		if levelUp {
			upd["level"] = newLevel
		}
		if tpl.PointsReward > 0 {
			upd["points"] = newPoints
		}
		if err := tx.Model(&model.User{}).Where("username = ?", username).Updates(upd).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProfileExpLog{
			Username: username, Change: tpl.ExpReward, Reason: "badge",
			Detail: "合成徽章 " + tpl.Name,
		}).Error; err != nil {
			return err
		}
		if tpl.PointsReward > 0 {
			if err := tx.Create(&model.PointsLog{
				Username: username, Change: tpl.PointsReward,
				BalanceAfter: newPoints, Reason: "badge_craft",
				Operator: "system", Detail: "合成徽章 " + tpl.Name + " 奖励积分",
			}).Error; err != nil {
				return err
			}
		}
		if levelUp {
			if err := tx.Create(&model.UserBadge{
				Username: username, Type: "level",
				Code:     "lv" + strconv.Itoa(newLevel),
				Name:     "等级 " + strconv.Itoa(newLevel),
				Desc:     "Steam 同款个人等级徽章",
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		profileFail(w, "合成失败："+err.Error())
		return
	}

	profileOK(w, map[string]interface{}{
		"crafted":     true,
		"badge":       tpl,
		"exp_gain":    tpl.ExpReward,
		"points_gain": tpl.PointsReward,
		"new_exp":     finalUser.Exp + int64(tpl.ExpReward),
		"level_up":    calcLevelFromExp(int(finalUser.Exp)+tpl.ExpReward) > finalUser.Level,
		"new_level":   calcLevelFromExp(int(finalUser.Exp) + tpl.ExpReward),
	})
}
