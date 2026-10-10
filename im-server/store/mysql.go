package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
)

var DB *gorm.DB

// SlowQueryCount 慢查询累计（仪表盘观测）：gorm 执行 >500ms 计一次
// （与日志 SlowThreshold 同阈值；持续增长=索引劣化/锁等待信号）
var SlowQueryCount atomic.Int64

// slowQueryLogger gorm 日志包装：全部行为转发内置 logger，仅 Trace 中加慢查询计数
type slowQueryLogger struct{ gormlogger.Interface }

func (l slowQueryLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
	if err == nil && time.Since(begin) > 500*time.Millisecond {
		SlowQueryCount.Add(1)
	}
	l.Interface.Trace(ctx, begin, fc, err)
}

// InitMySQL 初始化 MySQL 连接池、自动创建数据库与数据表
func InitMySQL(cfg *config.Config) error {
	// 先连接不含数据库的 DSN，确保数据库存在
	if err := ensureDatabase(cfg.MySQLDSN); err != nil {
		return err
	}

	// GORM 日志降噪：RecordNotFound 是业务正常分支（挂载盘探测文件/用户是否存在等高频路径），
	// 默认配置会打红字误导排查（实测：资源管理器粘贴前 PROPFIND 探测不存在文件每次刷红字）。
	// 官方正规配置 IgnoreRecordNotFoundError=true——真正的 SQL 执行错误仍照常输出
	db, err := gorm.Open(mysql.Open(cfg.MySQLDSN), &gorm.Config{
		Logger: slowQueryLogger{gormlogger.New(log.New(os.Stdout, "\r\n", log.LstdFlags), gormlogger.Config{
			SlowThreshold:             500 * time.Millisecond,
			IgnoreRecordNotFoundError: true,
			LogLevel:                  gormlogger.Warn,
		})},
	})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}

	// 并发优化 E4：连接池参数配置化（原实现未设置——Go 默认 max_open=0 无上限、max_idle=2，
	// 风暴后空闲连接仅留 2 个，高峰重建握手开销大；现从配置读取，缺省兜底见 config.go 注释）
	if sqlDB, err := db.DB(); err == nil {
		maxOpen := cfg.DBMaxOpenConns
		if maxOpen <= 0 {
			maxOpen = 2000
		}
		maxIdle := cfg.DBMaxIdleConns
		if maxIdle <= 0 {
			maxIdle = 50
		}
		if maxIdle > maxOpen {
			maxIdle = maxOpen
		}
		sqlDB.SetMaxOpenConns(maxOpen)
		sqlDB.SetMaxIdleConns(maxIdle)
		// 连接最长存活期：配置 >0 用配置；0 兜底 240s（沿用原加固值——防复用临期死连接，
		// 兼容已删除的历史硬编码段语义）
		lifetime := cfg.DBConnMaxLifetime
		if lifetime <= 0 {
			lifetime = 240
		}
		sqlDB.SetConnMaxLifetime(time.Duration(lifetime) * time.Second)
		logger.Info("MySQL 连接池：max_open=%d max_idle=%d lifetime=%ds", maxOpen, maxIdle, lifetime)
	}

	// 自动创建数据表（首次启动）；阶段四十六追加文档编辑版本表 im_doc_edit
	// 阶段四十九：追加 AI 模型服务表 im_ai_provider 与 AI 智能体表 im_ai_agent（后台管理热更新数据源）
	// 阶段五十一：追加知识库表 im_kb 与知识文件表 im_kb_file（RAG 向量化数据源）
	// 阶段五十六：追加用户知识库勾选表 im_user_kb（用户端自选知识库，对所有智能体生效）
	// 阶段八十八：追加 MCP 服务器配置表 im_mcp_server（TRAE CN 同款 MCP 能力，服务端归口）
	// 原实现：迁移列表不含 im_user_kb
	//	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}); err != nil {
	// 阶段一百四十二：追加群聊三表 im_group / im_group_member / im_group_invite（微信同款多群聊一期）
	// 原实现：迁移列表不含群聊三表
	//	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}, &model.UserKB{}, &model.PointsLog{}, &model.MCPServer{}, &model.CallLog{}); err != nil {
	// 阶段一百四十五：追加工作台应用表 im_workbench_app（后台维护办公网站清单，客户端宫格导航）
	// 阶段一百五十四：追加积分红包两表 im_red_packet / im_red_packet_claim（微信同款红包，积分归口）
	// 阶段二百六十：追加客户端版本表 im_app_version（APP/PC 自动更新，服务端版本归口）
	// 阶段二百六十一：追加远程控制设备表 im_device（向日葵同款设备ID+验证码远程控制）
	// 阶段二百六十二：追加跨账号信任对表 im_remote_trust（静态密码成功连接免码直连）与
	// 自定义远程卡片表 im_remote_card（设备ID+备注，服务端存储三端同步）
	// 阶段二百八十：追加朋友圈四表 im_moment / im_moment_like / im_moment_comment / im_moment_unread
	// （微信同款朋友圈：动态+点赞+评论回复+互动红点归口）
	if err := db.AutoMigrate(&model.User{}, &model.Message{}, &model.FileRecord{}, &model.Friend{}, &model.FriendRequest{}, &model.Blacklist{}, &model.MessageDelete{}, &model.Conversation{}, &model.MessagePin{}, &model.DocEdit{}, &model.AIProvider{}, &model.AIAgent{}, &model.KB{}, &model.KBFile{}, &model.UserKB{}, &model.PointsLog{}, &model.MCPServer{}, &model.CallLog{}, &model.Group{}, &model.GroupMember{}, &model.GroupInvite{}, &model.Announcement{}, &model.AnnouncementAttachment{}, &model.AnnouncementRead{}, &model.WorkbenchApp{}, &model.RedPacket{}, &model.RedPacketClaim{}, &model.RemoteLog{}, &model.DriveFile{}, &model.DriveShare{}, &model.DriveUploadSession{}, &model.AppVersion{}, &model.Device{}, &model.RemoteTrust{}, &model.RemoteCard{}, &model.Moment{}, &model.MomentLike{}, &model.MomentComment{}, &model.MomentUnread{}); err != nil {
		return fmt.Errorf("自动建表失败: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	// 登录回归加固：部分环境 MySQL 会主动断开空闲连接（日志出现 wsarecv: connection aborted），
	// 池中死连接导致"空闲后首次查询"报 invalid connection（该英文底层错误修复前还会原样下发客户端）
	// 连接最长存活期/空闲滞留期 + 后台 Ping 保活：剔除失效连接并按需重建，保证连接池始终可用。
	// 并发优化 E4 修正：原硬编码 SetMaxOpenConns(100)/SetMaxIdleConns(10) 在配置化设置之后执行
	// 会覆盖配置值（仪表盘恒显 100 的根因），现删除硬编码，池上限以 E4 段配置为准
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

	// 去除数据库名，连接服务器本身（ensureDatabase 短连接仅建库，静默 not-found 噪音同上）
	cfg.DBName = ""
	db, err := gorm.Open(mysql.Open(cfg.FormatDSN()), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Silent),
	})
	if err != nil {
		return fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	if err := db.Exec(fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci", dbName)).Error; err != nil {
		return fmt.Errorf("创建数据库失败: %w", err)
	}
	return nil
}
