package server

import (
	"testing"
	"time"

	"im-server/config"
)

// TestEvaluateDiskAlertsLifecycle 磁盘水位告警生命周期：触发 → 恢复 → 遗留键清理
// （直接注入缓存绕过真盘/once 依赖，覆盖 diskmonitor.go 的三段判定与 diskAlertKeys 兜底）
func TestEvaluateDiskAlertsLifecycle(t *testing.T) {
	const dir = `X:\fake-monitored-dir`
	key := "disk_high_" + dir
	s := &Server{cfg: &config.Config{}}
	s.cfg.DiskMonitor = config.DiskMonitorConfig{Enabled: true, WarnPercent: 80, ErrorPercent: 90}

	// 测试卫生：本用例直写包级全局（缓存/告警登记表/活跃告警表），结束前全部还原，
	// 杜绝向同包其他用例泄漏假目录条目与活跃告警
	origCache, origAt := diskStatsCache, diskStatsAt
	t.Cleanup(func() {
		diskStatsMu.Lock()
		diskStatsCache, diskStatsAt = origCache, origAt
		delete(diskAlertKeys, key)
		diskStatsMu.Unlock()
		alertsMu.Lock()
		delete(activeAlerts, key)
		alertsMu.Unlock()
	})

	inject := func(st adminDiskStat) {
		diskStatsMu.Lock()
		diskStatsCache = []adminDiskStat{st}
		diskStatsAt = time.Now()
		diskStatsMu.Unlock()
	}
	alertLevel := func() (string, bool) {
		for _, a := range currentAlerts() {
			if a.Key == key {
				return a.Level, true
			}
		}
		return "", false
	}

	// 1) error 水位触发
	inject(adminDiskStat{Dir: dir, TotalBytes: 100, FreeBytes: 5, UsedPct: 95})
	evaluateDiskAlerts(s)
	if lv, ok := alertLevel(); !ok || lv != "error" {
		t.Fatalf("95%% 应触发 error 告警, 实得 ok=%v level=%q", ok, lv)
	}

	// 2) 降回 warn 水位：告警仍活跃（alertSet 既有语义——已存在键保留首次级别只刷新文案，
	//    与 alerts.go 全模块规则一致；降级提示随文案刷新，级别锁存直至恢复清除）
	inject(adminDiskStat{Dir: dir, TotalBytes: 100, FreeBytes: 15, UsedPct: 85})
	evaluateDiskAlerts(s)
	if lv, ok := alertLevel(); !ok || lv != "error" {
		t.Fatalf("85%% 告警应保持活跃且级别锁存为 error（既有 alertSet 语义）, 实得 ok=%v level=%q", ok, lv)
	}

	// 3) 回到水位下：告警恢复清除
	inject(adminDiskStat{Dir: dir, TotalBytes: 100, FreeBytes: 50, UsedPct: 50})
	evaluateDiskAlerts(s)
	if _, ok := alertLevel(); ok {
		t.Fatalf("50%% 应恢复清除告警")
	}
	// 再次冲高到 warn，为第 4 步遗留清理做铺垫
	inject(adminDiskStat{Dir: dir, TotalBytes: 100, FreeBytes: 15, UsedPct: 85})
	evaluateDiskAlerts(s)
	if _, ok := alertLevel(); !ok {
		t.Fatalf("85%% 应再次触发告警（铺垫遗留清理用例）")
	}

	// 4) 目录运行中被删除（扫描不再产出该条目）：遗留告警必须被兜底清理，防横幅残留到重启
	inject2 := func() {
		diskStatsMu.Lock()
		diskStatsCache = nil
		diskStatsAt = time.Now()
		diskStatsMu.Unlock()
	}
	inject2()
	evaluateDiskAlerts(s)
	if _, ok := alertLevel(); ok {
		t.Fatalf("目录消失后遗留告警应被自动清理")
	}

	// 5) 总开关关闭：完全旁路（不新增告警）
	s.cfg.DiskMonitor.Enabled = false
	inject(adminDiskStat{Dir: dir, TotalBytes: 100, FreeBytes: 0, UsedPct: 100})
	evaluateDiskAlerts(s)
	if _, ok := alertLevel(); ok {
		t.Fatalf("disk_monitor.enabled=false 应完全旁路")
	}
}

// TestDiskPct 文案格式（1 位小数 + 百分号）
func TestDiskPct(t *testing.T) {
	if got := diskPct(87.46); got != "87.5%" {
		t.Fatalf("diskPct(87.46) = %q, 期望 87.5%%", got)
	}
}
