package server

// ===== 阶段七十八：AI 积分（TRAE CN 同款问答积分）=====
// 规则归口（服务端统一计算，客户端仅展示下发余额）：
//   1. 按 Token 消耗折算扣除：1000 tokens = 1 积分，双精度保留 3 位小数（tokens/1000，
//      如 4506 tokens = 4.506 积分，精度与 TRAE 一致）；模型未返回 usage 时按 1 积分兜底（一次问答最低消费）
//   2. 仅问答成功完成时扣分（失败/用户停止不扣，天然满足"失败自动退还"语义）
//   3. 扣除原子且钳制非负（并发问答时余额最多扣到 0，不出现负数）
//   4. 余额 <= 0 时拦截 AI 提问（handleAIChatMsg 入口校验），聊天其余功能不受影响
// 双精度说明：余额/流水列均为 double；折算值四舍五入到 3 位小数后再入库，避免浮点累积误差

import (
	"fmt"
	"math"

	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"gorm.io/gorm"
)

// aiPointsPerUnit 每 1000 tokens 折算 1 积分
const aiPointsPerUnit = 1000

// aiPointsCost 按 Token 消耗计算积分消耗（tokens/1000 保留 3 位小数；tokens<=0 时按 1 积分兜底）
func aiPointsCost(totalTokens int) float64 {
	if totalTokens <= 0 {
		return 1
	}
	return math.Round(float64(totalTokens)/float64(aiPointsPerUnit)*1000) / 1000
}

// userPoints 查询用户当前积分余额（用户不存在返回错误）
func userPoints(username string) (float64, error) {
	var user model.User
	if err := store.DB.Select("points").Where("username = ?", username).First(&user).Error; err != nil {
		return 0, err
	}
	return user.Points, nil
}

// userPointsDeduct 扣除积分并返回扣后余额：
// 原子 UPDATE 钳制非负（points-cost 与 0 取大），余额不足时扣到 0 为止；
// 影响行数为 0 视为用户不存在
func userPointsDeduct(username string, cost float64) (float64, error) {
	if cost < 0 {
		cost = 0
	}
	res := store.DB.Model(&model.User{}).
		Where("username = ?", username).
		Update("points", gorm.Expr("GREATEST(points - ?, 0)", cost))
	if res.Error != nil {
		return 0, res.Error
	}
	if res.RowsAffected == 0 {
		return 0, fmt.Errorf("用户不存在: %s", username)
	}
	return userPoints(username)
}

// recordPointsLog 阶段七十八：积分流水落库（AI 扣分/管理员调整/注册赠送统一审计入口）。
// 写失败不影响主流程（余额变更已生效），仅记错误日志便于发现审计缺口
func recordPointsLog(username string, change, balanceAfter float64, reason, operator, detail string) {
	entry := &model.PointsLog{
		Username:     username,
		Change:       change,
		BalanceAfter: balanceAfter,
		Reason:       reason,
		Operator:     operator,
		Detail:       detail,
	}
	if err := store.DB.Create(entry).Error; err != nil {
		logger.Error("积分流水记录失败（用户 %s，变动 %.3f，原因 %s）：%v", username, change, reason, err)
	}
}
