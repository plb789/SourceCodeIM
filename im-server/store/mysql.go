package store

import (
	"fmt"

	mysqldriver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
)

var DB *gorm.DB

// InitMySQL 初始化 MySQL 连接池、自动创建数据库与数据表
func InitMySQL(cfg *config.Config) error {
	// 先连接不含数据库的 DSN，确保数据库存在
	if err := ensureDatabase(cfg.MySQLDSN); err != nil {
		return err
	}

	db, err := gorm.Open(mysql.Open(cfg.MySQLDSN), &gorm.Config{})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}

	// 自动创建数据表（首次启动）
	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}); err != nil {
		return fmt.Errorf("自动建表失败: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetMaxIdleConns(10)

	DB = db
	logger.Info("MySQL 连接成功，数据表已就绪")
	return nil
}

// ensureDatabase 自动创建 im 数据库（不存在时）
func ensureDatabase(dsn string) error {
	cfg, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return fmt.Errorf("解析 MySQL DSN 失败: %w", err)
	}
	dbName := cfg.DBName
	if dbName == "" {
		return nil
	}

	// 去除数据库名，连接服务器本身
	cfg.DBName = ""
	db, err := gorm.Open(mysql.Open(cfg.FormatDSN()), &gorm.Config{})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	if err := db.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci", dbName)).Error; err != nil {
		return fmt.Errorf("创建数据库失败: %w", err)
	}
	return nil
}
