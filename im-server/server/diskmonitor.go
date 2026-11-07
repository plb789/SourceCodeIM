package server

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// ===== 磁盘水位监控（安全加固·磁盘耗尽防护） =====
// 聊天上传 / 游戏数据 / 网盘本地存储均为持续增长目录，磁盘写满会导致 MySQL/日志写失败、
// 整站异常。本模块把各目录所在卷的使用率挂入既有告警评估器（alerts.go 30s 周期）：
// 达到 warn_percent 触发 warn 告警、error_percent 升级 error（按目录分键，恢复自动清除），
// 管理后台仪表盘横幅自动展示；/admin/api/metrics system 节附带 disk 数组供后续 UI 消费。
// statfs 结果 60s TTL 缓存——告警评估（30s）与指标接口共用，避免高频 syscall。
// 设计文档：docs/商户上传安全加固方案.md §2

// adminDiskStat 单个监控目录的磁盘水位快照（metrics 下发结构）
type adminDiskStat struct {
	Dir        string  `json:"dir"`         // 监控目录（绝对路径）
	TotalBytes int64   `json:"total_bytes"` // 所在卷总容量
	FreeBytes  int64   `json:"free_bytes"`  // 所在卷剩余
	UsedPct    float64 `json:"used_pct"`    // 使用率（%）
}

var (
	diskStatsMu    sync.Mutex
	diskStatsCache []adminDiskStat // 最近一次扫描结果（metrics 只读缓存）
	diskStatsAt    time.Time       // 扫描时刻（TTL 判据）
	diskStatsDirs  []string        // 解析出的监控目录集合（只解析一次，保证告警键稳定）
	diskStatsOnce  sync.Once
	// diskAlertKeys 本模块当前处于告警态的键集合（处理遗留告警：目录运行中被删除后
	// diskStatsCached 不再产出该目录条目，循环内 alertClear 不会执行——须在此兜底清理，
	// 防告警横幅残留到重启）
	diskAlertKeys = map[string]bool{}
)

// diskMonitorDirs 解析监控目录集合：聊天上传目录 + 游戏数据根目录 + 网盘本地根目录
// （网盘仅本地磁盘后端才落本机盘；MinIO 后端文件不在本机盘上，跳过）。
// 按绝对路径去重（多目录同卷时各报一份，同卷重复告警语义一致，简化处理）。
func diskMonitorDirs(s *Server) []string {
	diskStatsOnce.Do(func() {
		if s == nil || s.cfg == nil {
			return
		}
		seen := map[string]bool{}
		add := func(dir string) {
			if dir == "" {
				return
			}
			abs, err := filepath.Abs(dir)
			if err != nil || seen[abs] {
				return
			}
			seen[abs] = true
			diskStatsDirs = append(diskStatsDirs, abs)
		}
		add(s.cfg.UploadDir)
		add(s.cfg.Game.LocalDir)
		if s.cfg.Drive.Storage != "minio" && s.cfg.Drive.Minio.Endpoint == "" {
			add(s.cfg.Drive.LocalDir)
		}
	})
	return diskStatsDirs
}

// diskStatsCached 带缓存的磁盘水位扫描（60s TTL；返回结果为共享切片，只读勿改）
func diskStatsCached(s *Server) []adminDiskStat {
	diskStatsMu.Lock()
	defer diskStatsMu.Unlock()
	if !diskStatsAt.IsZero() && time.Since(diskStatsAt) < 60*time.Second {
		return diskStatsCache
	}
	out := make([]adminDiskStat, 0, 4)
	for _, dir := range diskMonitorDirs(s) {
		if _, err := os.Stat(dir); err != nil {
			continue // 目录不存在（对应功能未启用/未产生数据）跳过
		}
		total, free, err := dirDiskUsage(dir)
		if err != nil || total <= 0 {
			continue
		}
		out = append(out, adminDiskStat{
			Dir: dir, TotalBytes: total, FreeBytes: free,
			UsedPct: float64(total-free) / float64(total) * 100,
		})
	}
	diskStatsCache = out
	diskStatsAt = time.Now()
	return diskStatsCache
}

// evaluateDiskAlerts 磁盘水位告警评估（evaluateAlerts 归口调用；按目录分键，恢复自动清除）
func evaluateDiskAlerts(s *Server) {
	if !s.cfg.DiskMonitor.Enabled {
		return
	}
	stats := diskStatsCached(s)
	present := make(map[string]bool, len(stats))
	for _, st := range stats {
		// 告警键锚定目录绝对路径：目录集合进程内只解析一次，键不漂移
		key := "disk_high_" + st.Dir
		present[key] = true
		freeMB := st.FreeBytes / (1 << 20)
		var level string
		switch {
		case st.UsedPct >= float64(s.cfg.DiskMonitor.ErrorPercent):
			level = "error"
			alertSet(key, level, "磁盘水位告警 "+st.Dir+" 已用 "+diskPct(st.UsedPct)+
				"（≥"+strconv.Itoa(s.cfg.DiskMonitor.ErrorPercent)+"%，剩余 "+strconv.FormatInt(freeMB, 10)+
				"MB，写满将导致 DB/日志写入失败）")
		case st.UsedPct >= float64(s.cfg.DiskMonitor.WarnPercent):
			level = "warn"
			alertSet(key, level, "磁盘水位预警 "+st.Dir+" 已用 "+diskPct(st.UsedPct)+
				"（≥"+strconv.Itoa(s.cfg.DiskMonitor.WarnPercent)+"%，剩余 "+strconv.FormatInt(freeMB, 10)+"MB）")
		default:
			alertClear(key)
		}
		// 告警态登记/注销（diskAlertKeys 仅本协程读写，加锁与下方清理路径一致防御）
		diskStatsMu.Lock()
		if level != "" {
			diskAlertKeys[key] = true
		} else {
			delete(diskAlertKeys, key)
		}
		diskStatsMu.Unlock()
	}
	// 遗留告警兜底：目录运行中被删除（对应功能清理/配置变更）后扫描不再产出该条目，
	// 上方循环不会走到其 alertClear——清理本模块登记的、本轮未出现的键（防横幅残留到重启）
	diskStatsMu.Lock()
	for key := range diskAlertKeys {
		if !present[key] {
			alertClear(key)
			delete(diskAlertKeys, key)
		}
	}
	diskStatsMu.Unlock()
}

// diskPct 使用率百分数保留 1 位小数的文案（告警拼接用）
func diskPct(v float64) string {
	return strconv.FormatFloat(v, 'f', 1, 64) + "%"
}
