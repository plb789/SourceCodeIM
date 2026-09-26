package server

// ===== 阶段五十：后台管理·性能仪表盘 =====
// GET /admin/api/metrics（adminGuard 鉴权）归口输出三类指标：
//   1. system：堆内存/GC/goroutine/运行时长（runtime.MemStats 即时采集，微秒级开销）
//   2. business：在线用户/连接数（Hub 现成方法）、注册用户/消息总量/今日消息及按小时分布（SQL count）、
//      上传文件数与磁盘占用（后台定时扫描缓存）、AI 配置规模
//   3. db：MySQL 连接池 stats + Redis Ping 延迟
// 高并发归口：上传目录扫描由后台 goroutine 定时刷新（管理员轮询只读缓存，杜绝每次请求 walk 目录）；
// 仪表盘为管理员专属低频接口（前端 5 秒轮询单管理员），SQL count 直查可接受

import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// 服务启动时刻（运行时长统计锚点，包级初始化即启动时刻）
var adminBootTime = time.Now()

// 上传目录扫描缓存（atomic 保护，后台 goroutine 写，指标接口读）
var (
	adminUploadFiles  atomic.Int64
	adminUploadBytes  atomic.Int64
	adminUploadScanAt atomic.Int64 // 最近扫描 Unix 时间戳
)

// StartAdminUploadScanner 启动上传目录后台扫描（main.go 调用一次）：
// 异步首扫 + 每 5 分钟定时刷新；目录为空（配置异常）时静默跳过
func StartAdminUploadScanner(uploadDir string) {
	if uploadDir == "" {
		logger.Warn("上传目录未配置，文件占用指标不可用")
		return
	}
	go func() {
		scanAdminUploadStats(uploadDir)
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			scanAdminUploadStats(uploadDir)
		}
	}()
}

// scanAdminUploadStats 递归遍历上传目录统计文件数与总字节数（写缓存）
func scanAdminUploadStats(dir string) {
	var files, bytes int64
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil // 单个条目失败不中断整体扫描
		}
		if entry.IsDir() {
			return nil
		}
		if info, infoErr := entry.Info(); infoErr == nil {
			files++
			bytes += info.Size()
		}
		return nil
	})
	if err != nil {
		logger.Warn("上传目录扫描失败 %s: %v", dir, err)
		return
	}
	adminUploadFiles.Store(files)
	adminUploadBytes.Store(bytes)
	adminUploadScanAt.Store(time.Now().Unix())
}

// ===== 指标结构 =====

type adminMetricsSystem struct {
	HeapAllocMB  float64 `json:"heap_alloc_mb"`   // 堆在用内存
	HeapSysMB    float64 `json:"heap_sys_mb"`     // 堆向系统申请内存
	HeapObjects  uint64  `json:"heap_objects"`    // 堆对象数
	Goroutines   int     `json:"goroutines"`      // goroutine 数
	GCCount      uint32  `json:"gc_count"`        // GC 累计次数
	GCLastAgoSec float64 `json:"gc_last_ago_sec"` // 距上次 GC 秒数
	UptimeSec    float64 `json:"uptime_sec"`      // 服务运行时长
	NumCPU       int     `json:"num_cpu"`         // CPU 核数
	GoVersion    string  `json:"go_version"`
}

type adminMetricsBusiness struct {
	OnlineUsers  int             `json:"online_users"`   // 在线用户数（去重）
	OnlineConns  int             `json:"online_conns"`   // 在线连接数（多端合计）
	TotalUsers   int64           `json:"total_users"`    // 注册用户总数
	TotalMsgs    int64           `json:"total_msgs"`     // 消息总量
	TodayMsgs    int64           `json:"today_msgs"`     // 今日消息量
	HourlyToday  []adminHourStat `json:"hourly_today"`   // 今日按小时分布（补齐 0-23 点）
	UploadFiles  int64           `json:"upload_files"`   // 上传文件数（缓存）
	UploadSizeMB float64         `json:"upload_size_mb"` // 上传占用 MB（缓存）
	UploadScanAt int64           `json:"upload_scan_at"` // 最近扫描时间戳
	// 阶段一百六十八：网盘存储总占用（正常文件口径，与「文件存储管理」总览一致，60 秒缓存）
	DriveTotalSize int64 `json:"drive_total_size"` // 网盘文件总字节（不含回收站）
	DriveFileCount int64 `json:"drive_file_count"` // 网盘文件数（不含目录/回收站）
	// 阶段一百六十八：积分总量（全站用户积分余额实时聚合；仪表盘为管理员低频接口，SQL 直查同 total_users 口径。
	// 积分为双精度 3 位小数存储（aipoints.go 归口），SUM 结果同为浮点，前端按 fmtPts 口径格式化）
	PointsTotal float64 `json:"points_total"` // 积分余额总和
	AIProviders int64   `json:"ai_providers"` // 模型服务数
	AIAgents    int64   `json:"ai_agents"`    // 启用中智能体数
	// 阶段一百四十七：通话链路统计（话单服务端归口，管理员仪表盘直读）
	TotalCalls    int64 `json:"total_calls"`    // 话单总数（含未接通）
	TodayCalls    int64 `json:"today_calls"`    // 今日话单数
	CallCompleted int64 `json:"call_completed"` // 已接通话单数
	CallP2P       int64 `json:"call_p2p"`       // P2P 直连话单数（已接通中客户端上报 link_type=p2p）
	CallRelay     int64 `json:"call_relay"`     // TURN 中继话单数（已接通中客户端上报 link_type=relay）
}

type adminHourStat struct {
	Hour  int   `json:"hour"`
	Count int64 `json:"count"`
}

type adminMetricsDB struct {
	MySQLMaxOpen   int     `json:"mysql_max_open"`   // 最大打开连接数
	MySQLInUse     int     `json:"mysql_in_use"`     // 使用中连接
	MySQLIdle      int     `json:"mysql_idle"`       // 空闲连接
	MySQLWaitCount int64   `json:"mysql_wait_count"` // 累计等待次数（高并发压力信号）
	RedisOK        bool    `json:"redis_ok"`         // Redis 可用性
	RedisPingMS    float64 `json:"redis_ping_ms"`    // Ping 往返毫秒
}

type adminMetricsResp struct {
	System   adminMetricsSystem   `json:"system"`
	Business adminMetricsBusiness `json:"business"`
	DB       adminMetricsDB       `json:"db"`
}

// handleAdminMetrics 性能仪表盘指标接口（管理员鉴权）
func (s *Server) handleAdminMetrics(w http.ResponseWriter, r *http.Request) {
	resp := adminMetricsResp{
		System:   collectSystemMetrics(),
		Business: s.collectBusinessMetrics(),
		DB:       collectDBMetrics(),
	}
	adminJSON(w, resp)
}

// collectSystemMetrics 系统运行指标（runtime 即时采集）
func collectSystemMetrics() adminMetricsSystem {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return adminMetricsSystem{
		HeapAllocMB:  float64(ms.HeapAlloc) / 1024 / 1024,
		HeapSysMB:    float64(ms.HeapSys) / 1024 / 1024,
		HeapObjects:  ms.HeapObjects,
		Goroutines:   runtime.NumGoroutine(),
		GCCount:      ms.NumGC,
		GCLastAgoSec: time.Since(time.Unix(0, int64(ms.LastGC))).Seconds(),
		UptimeSec:    time.Since(adminBootTime).Seconds(),
		NumCPU:       runtime.NumCPU(),
		GoVersion:    runtime.Version(),
	}
}

// collectBusinessMetrics 业务指标（Hub 即时 + SQL count + 上传缓存）
func (s *Server) collectBusinessMetrics() adminMetricsBusiness {
	var b adminMetricsBusiness

	// 在线情况（Hub 现成方法，读锁内统计）
	b.OnlineUsers = len(s.hub.Usernames())
	b.OnlineConns = s.hub.TotalConns()

	// 注册用户与消息统计（阶段一百三十五：排除已注销账号，总数口径=有效账号）
	store.DB.Model(&model.User{}).Where("status <> ?", model.UserStatusDeleted).Count(&b.TotalUsers)
	store.DB.Model(&model.Message{}).Count(&b.TotalMsgs)
	todayStart := time.Now().Truncate(24 * time.Hour)
	store.DB.Model(&model.Message{}).Where("create_time >= ?", todayStart).Count(&b.TodayMsgs)

	// 今日按小时分布（一次性查出后补齐 0-23 点，前端免补零逻辑）
	var rows []adminHourStat
	store.DB.Model(&model.Message{}).
		Select("HOUR(create_time) AS hour, COUNT(*) AS count").
		Where("create_time >= ?", todayStart).
		Group("HOUR(create_time)").Scan(&rows)
	hourMap := make(map[int]int64, len(rows))
	for _, row := range rows {
		hourMap[row.Hour] = row.Count
	}
	b.HourlyToday = make([]adminHourStat, 0, 24)
	for h := 0; h < 24; h++ {
		b.HourlyToday = append(b.HourlyToday, adminHourStat{Hour: h, Count: hourMap[h]})
	}

	// 上传占用（后台扫描缓存）
	b.UploadFiles = adminUploadFiles.Load()
	b.UploadSizeMB = float64(adminUploadBytes.Load()) / 1024 / 1024
	b.UploadScanAt = adminUploadScanAt.Load()

	// 阶段一百六十八：网盘存储总占用（正常文件口径 = 文件存储管理「总占用」同源；
	// 仪表盘轮询频率高于网盘数据变化频率，60 秒缓存避免每次轮询全表聚合）
	if size, count, ok := adminDriveStatsCached(); ok {
		b.DriveTotalSize = size
		b.DriveFileCount = count
	}

	// 阶段一百六十八：积分总量（全站 SUM，COALESCE 兜底空表 0）
	store.DB.Model(&model.User{}).Select("COALESCE(SUM(points),0)").Scan(&b.PointsTotal)

	// AI 配置规模
	store.DB.Model(&model.AIProvider{}).Count(&b.AIProviders)
	store.DB.Model(&model.AIAgent{}).Where("enabled = ?", true).Count(&b.AIAgents)

	// 阶段一百四十七：通话链路统计（管理员仪表盘直读，低频接口 SQL count 可接受；
	// 链路未知数前端按 已接通 - p2p - relay 自算，服务端不下发冗余字段）
	store.DB.Model(&model.CallLog{}).Count(&b.TotalCalls)
	store.DB.Model(&model.CallLog{}).Where("create_time >= ?", todayStart).Count(&b.TodayCalls)
	store.DB.Model(&model.CallLog{}).Where("status = ?", "completed").Count(&b.CallCompleted)
	store.DB.Model(&model.CallLog{}).Where("status = ? AND link_type = ?", "completed", "p2p").Count(&b.CallP2P)
	store.DB.Model(&model.CallLog{}).Where("status = ? AND link_type = ?", "completed", "relay").Count(&b.CallRelay)

	return b
}

// collectDBMetrics 数据库健康指标
func collectDBMetrics() adminMetricsDB {
	var d adminMetricsDB
	if sqlDB, err := store.DB.DB(); err == nil {
		st := sqlDB.Stats()
		d.MySQLMaxOpen = st.MaxOpenConnections
		d.MySQLInUse = st.InUse
		d.MySQLIdle = st.Idle
		d.MySQLWaitCount = st.WaitCount
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if err := store.RDB.Ping(ctx).Err(); err == nil {
		d.RedisOK = true
		d.RedisPingMS = float64(time.Since(start).Microseconds()) / 1000
	}
	return d
}

// adminDriveStatsCache 网盘总占用缓存（60 秒 TTL；仪表盘轮询高节流，与文件存储管理口径同源）
var adminDriveStatsCache struct {
	sync.Mutex
	at    time.Time
	size  int64
	count int64
}

// adminDriveStatsCached 正常文件（不含目录/回收站）总字节与数量，60 秒缓存；查询失败返回 ok=false（前端保持上次值）
func adminDriveStatsCached() (size int64, count int64, ok bool) {
	adminDriveStatsCache.Lock()
	defer adminDriveStatsCache.Unlock()
	if !adminDriveStatsCache.at.IsZero() && time.Since(adminDriveStatsCache.at) < 60*time.Second {
		return adminDriveStatsCache.size, adminDriveStatsCache.count, true
	}
	row := store.DB.Model(&model.DriveFile{}).
		Select("COALESCE(SUM(size),0) AS s, COUNT(*) AS c").
		Where("is_dir = ? AND deleted_at IS NULL", false).
		Row()
	if err := row.Scan(&size, &count); err != nil {
		return 0, 0, false
	}
	adminDriveStatsCache.size = size
	adminDriveStatsCache.count = count
	adminDriveStatsCache.at = time.Now()
	return size, count, true
}
