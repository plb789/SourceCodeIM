package store

import (
	"database/sql"
	"fmt"
	"time"

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

	// 自动创建数据表（首次启动）；阶段四十六追加文档编辑版本表 im_doc_edit
	// 阶段四十九：追加 AI 模型服务表 im_ai_provider 与 AI 智能体表 im_ai_agent（后台管理热更新数据源）
	// 阶段五十一：追加知识库表 im_kb 与知识文件表 im_kb_file（RAG 向量化数据源）
	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}); err != nil {
		return fmt.Errorf("自动建表失败: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	sqlDB.SetMaxOpenConns(100)
	sqlDB.SetMaxIdleConns(10)
	// 登录回归加固：部分环境 MySQL 会主动断开空闲连接（日志出现 wsarecv: connection aborted），
	// 池中死连接导致"空闲后首次查询"报 invalid connection（该英文底层错误修复前还会原样下发客户端）
	// 原代码：仅设置 MaxOpen/MaxIdle，无连接寿命限制与保活
	sqlDB.SetConnMaxLifetime(4 * time.Minute) // 连接最长存活期，防复用临期连接
	sqlDB.SetConnMaxIdleTime(1 * time.Minute) // 空闲连接最长滞留期，超时回收防死连接驻留
	go keepMySQLAlive(sqlDB)                  // 后台定时 Ping 保活：剔除失效连接并按需重建，保证连接池始终可用

	DB = db
	logger.Info("MySQL 连接成功，数据表已就绪")
	return nil
}

// keepMySQLAlive 后台保活：定时 Ping 数据库，剔除池中被服务端断开的死连接并按需重建
func keepMySQLAlive(sqlDB *sql.DB) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := sqlDB.Ping(); err != nil {
			logger.Warn("MySQL 保活 Ping 失败: %v", err)
		}
	}
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
