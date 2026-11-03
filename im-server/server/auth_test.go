package server

// 注册赠送积分单测（真实 MySQL，TestMain 已锚定 bin/config.yaml，无库环境自动退出）：
// config.yaml register_gift_points 归口验证——写多少就是多少（写 0=不赠送且不写流水）+ 可配面值到账 + 流水

import (
	"testing"

	"im-server/model"
	"im-server/store"
)

func TestRegisterGiftPoints(t *testing.T) {
	if err := store.DB.AutoMigrate(&model.User{}, &model.PointsLog{}); err != nil {
		t.Fatalf("测试表迁移失败：%v", err)
	}
	t.Cleanup(func() {
		store.DB.Where("username LIKE ?", "gifttest_%").Delete(&model.User{})
		store.DB.Where("username LIKE ?", "gifttest_%").Delete(&model.PointsLog{})
	})

	// ① 可配面值 50：到账 50 + register_grant 流水 1 条
	u, err := registerUser("gifttest_50", "pw123456", 50)
	if err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	if u.Points != 50 {
		t.Fatalf("配置 50 应到账 50，实得 %v", u.Points)
	}
	var cnt int64
	store.DB.Model(&model.PointsLog{}).Where("username = ? AND reason = ?", "gifttest_50", "register_grant").Count(&cnt)
	if cnt != 1 {
		t.Fatalf("register_grant 流水应 1 条，实得 %d", cnt)
	}

	// ② 写 0 = 不赠送：到账 0（GORM default:100 零值陷阱下仍须真落库为 0）且无 register_grant 流水
	if _, err = registerUser("gifttest_0", "pw123456", 0); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	var dbPts float64
	store.DB.Model(&model.User{}).Where("username = ?", "gifttest_0").Select("points").Scan(&dbPts)
	if dbPts != 0 {
		t.Fatalf("写 0 应不赠送（库中 0），实得 %v", dbPts)
	}
	store.DB.Model(&model.PointsLog{}).Where("username = ? AND reason = ?", "gifttest_0", "register_grant").Count(&cnt)
	if cnt != 0 {
		t.Fatalf("0 赠送不应写 register_grant 流水，实得 %d 条", cnt)
	}

	// ③ 负数防御归一为 0
	u3, err := registerUser("gifttest_neg", "pw123456", -10)
	if err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	if u3.Points != 0 {
		t.Fatalf("负数应归一 0，实得 %v", u3.Points)
	}
}
