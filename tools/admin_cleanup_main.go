// 临时清理脚本：实测后将测试管理员角色降级为普通用户（验证完可删除）
// 说明：config.yaml 白名单已还原，但 MarkAdminUsers 写入的 role=1 需此处归零
package main

import (
	"fmt"
	"os"

	"im-server/config"
	"im-server/store"
)

func main() {
	cfg := config.Load()
	if err := store.InitMySQL(cfg); err != nil {
		fmt.Println("数据库连接失败:", err)
		os.Exit(1)
	}
	if err := store.DB.Exec("UPDATE im_user SET role = 0 WHERE username = ?", "maxtest88").Error; err != nil {
		fmt.Println("角色降级失败:", err)
		os.Exit(1)
	}
	fmt.Println("maxtest88 已降级为普通用户")
}
