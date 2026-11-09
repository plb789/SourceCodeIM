package main

import (
	"fmt"
	"os"

	"im-server/config"
	"im-server/store"
)

func main() {
	cfg := config.Load()
	if cfg == nil {
		fmt.Println("[FAIL] 加载配置失败")
		os.Exit(1)
	}
	if err := store.InitMySQL(cfg); err != nil {
		fmt.Println("[FAIL] 数据库初始化失败:", err)
		os.Exit(1)
	}
	db := store.DB

	// 先确认这个列真的存在
	type colInfo struct {
		ColName string `gorm:"column:column_name"`
	}
	var c colInfo
	err := db.Raw("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'im_official_account' AND column_name = '-'").Scan(&c).Error
	if err != nil {
		fmt.Println("[FAIL] 查询列信息失败:", err)
		os.Exit(1)
	}
	if c.ColName == "" {
		fmt.Println("[SKIP] im_official_account 里没有 '-' 列，无需清理")
		return
	}
	fmt.Println("[OK] 发现遗留列 '-' (longtext)，正在删除...")

	// MySQL 里 `-` 不是保留字但作为列名要反引号
	if err := db.Exec("ALTER TABLE im_official_account DROP COLUMN `-`").Error; err != nil {
		fmt.Println("[FAIL] ALTER 失败:", err)
		os.Exit(1)
	}
	fmt.Println("[OK] 已删除 im_official_account.`-`")

	// 验证：重新查一次
	var stillThere colInfo
	db.Raw("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'im_official_account' AND column_name = '-'").Scan(&stillThere)
	if stillThere.ColName == "" {
		fmt.Println("[✅] 确认：遗留列已清理干净")
	} else {
		fmt.Println("[⚠️] 警告：列仍存在")
	}
}
