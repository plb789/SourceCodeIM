package server

import (
	"sort"
	"strconv"
	"sync"
	"time"

	"im-server/logger"
)

// ===== 并发优化观测扩展：内置监控告警 =====
// 独立评估 goroutine（30s 周期）对仪表盘指标逐条评估阈值规则，触发即入活跃告警表，
// 恢复自动清除（无状态外溢，重启归零）；管理页 /admin/metrics 随响应下发，仪表盘顶部横幅展示。
// 设计约束：评估复用指标采集函数（collectSystemMetrics/collectDBMetrics），
// 不引入 Prometheus 等外部依赖；增量型规则以上次评估快照做差。

// adminAlert 单条活跃告警
type adminAlert struct {
	Key     string `json:"key"`     // 规则键（前端去重）
	Level   string `json:"level"`   // warn | error
	Message string `json:"message"` // 人读描述（含当前值）
	Since   int64  `json:"since"`   // 首次触发时间戳
}

var (
	alertsMu     sync.Mutex
	activeAlerts = make(map[string]adminAlert)
	// 增量型规则的上次评估快照
	alertPrev = make(map[string]int64)
)

// alertSet 触发/更新告警；alertClear 恢复清除。均为评估协程内调用，仍加锁防与读取端竞态
func alertSet(key, level, msg string) {
	alertsMu.Lock()
	if cur, ok := activeAlerts[key]; !ok {
		logger.Warn("告警触发 [%s] %s", key, msg)
		activeAlerts[key] = adminAlert{Key: key, Level: level, Message: msg, Since: time.Now().Unix()}
	} else {
		cur.Message = msg // 值持续越限：刷新描述保留首次触发时间
		activeAlerts[key] = cur
	}
	alertsMu.Unlock()
}

func alertClear(key string) {
	alertsMu.Lock()
	if _, ok := activeAlerts[key]; ok {
		logger.Info("告警恢复 [%s]", key)
		delete(activeAlerts, key)
	}
	alertsMu.Unlock()
}

// alertDelta 增量型指标差值（本窗 - 上窗），并写入新快照
func alertDelta(key string, cur int64) int64 {
	prev := alertPrev[key]
	alertPrev[key] = cur
	return cur - prev
}

// currentAlerts 活跃告警列表（error 优先，同级按触发时间正序）
func currentAlerts() []adminAlert {
	alertsMu.Lock()
	defer alertsMu.Unlock()
	list := make([]adminAlert, 0, len(activeAlerts))
	for _, a := range activeAlerts {
		list = append(list, a)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Level != list[j].Level {
			return list[i].Level == "error"
		}
		return list[i].Since < list[j].Since
	})
	return list
}

// startAlertEvaluator 启动告警评估协程（NewServer 归口调用；30s 周期）
func startAlertEvaluator(s *Server) {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			evaluateAlerts(s)
		}
	}()
}

// evaluateAlerts 逐条评估阈值规则（阈值依据各指标的异常信号语义，与仪表盘悬浮提示同口径）
func evaluateAlerts(s *Server) {
	sys := collectSystemMetrics()
	db := collectDBMetrics()

	// 1. 落库队列水位：>80% 容量持续 = DB 写入能力不足（E1 背压前兆）
	if db.MsgQCap > 0 && db.MsgQLen > db.MsgQCap*8/10 {
		alertSet("msgq_high", "error", "落库队列积压 "+i64s(db.MsgQLen)+"/"+i64s(db.MsgQCap)+"，DB 写入能力不足")
	} else {
		alertClear("msgq_high")
	}
	// 2. 落库背压/批写超时：任何增量即异常（正常态恒为 0）
	if d := alertDelta("degraded", db.MsgQDegraded); d > 0 {
		alertSet("msgq_degraded", "error", "落库背压降级 30s 内新增 "+i64s(d)+" 次（队列满直写）")
	} else {
		alertClear("msgq_degraded")
	}
	if d := alertDelta("timeouts", db.MsgQTimeouts); d > 0 {
		alertSet("msgq_timeout", "error", "落库批写超时 30s 内新增 "+i64s(d)+" 次（DB 卡死信号）")
	} else {
		alertClear("msgq_timeout")
	}
	// 3. WS 发送积压连接 >0 持续
	if sys.WSBackpressured > 0 {
		alertSet("ws_backpressure", "warn", i64s(int64(sys.WSBackpressured))+" 个连接发送队列超半载")
	} else {
		alertClear("ws_backpressure")
	}
	// 4. WS 慢写：单窗增量 ≥10 次
	if d := alertDelta("slow_writes", sys.WSSlowWrites); d >= 10 {
		alertSet("slow_writes", "warn", "WS 慢写 30s 内新增 "+i64s(d)+" 次（网卡/对端拥塞）")
	} else {
		alertClear("slow_writes")
	}
	// 5. 会话推送退避升档持续（≥1.2s = 第二档以上，推送风暴中）
	if sys.ConvBackoffMS >= 1200 {
		alertSet("conv_backoff", "warn", "会话推送退避已升档至 "+i64s(sys.ConvBackoffMS)+"ms（推送风暴）")
	} else {
		alertClear("conv_backoff")
	}
	// 6. MySQL 慢查询：单窗增量 ≥50 次
	if d := alertDelta("slow_queries", db.SlowQueries); d >= 50 {
		alertSet("slow_queries", "warn", "MySQL 慢查询 30s 内新增 "+i64s(d)+" 次（索引劣化/锁等待）")
	} else {
		alertClear("slow_queries")
	}
	// 7. Redis 健康
	if d := alertDelta("redis_timeouts", db.RedisPoolTimeouts); d > 0 {
		alertSet("redis_timeout", "error", "Redis 连接池等待超时 30s 内新增 "+i64s(d)+" 次（池吃紧）")
	} else {
		alertClear("redis_timeout")
	}
	if !db.RedisOK {
		alertSet("redis_down", "error", "Redis Ping 失败（离线补发/缓存不可用）")
	} else {
		alertClear("redis_down")
	}
	// 8. 集群总线（单实例 pub_q_cap=0 自动跳过）
	if db.PubQCap > 0 {
		if db.PubQLen > db.PubQCap*8/10 {
			alertSet("busq_high", "error", "总线发布队列积压 "+i64s(db.PubQLen)+"/"+i64s(db.PubQCap))
		} else {
			alertClear("busq_high")
		}
		if d := alertDelta("pub_degraded", db.PubQDegraded); d > 0 {
			alertSet("bus_degraded", "error", "总线队列满降级 30s 内新增 "+i64s(d)+" 次")
		} else {
			alertClear("bus_degraded")
		}
	}
	// 9. 连接数逼近上限（max_connections 的 90%，预警提前扩容/重启窗口）
	if s.cfg.MaxConnections > 0 {
		conns := int64(s.hub.TotalConns())
		threshold := int64(float64(s.cfg.MaxConnections) * 0.9)
		if conns >= threshold {
			alertSet("conn_high", "warn", "在线连接 "+i64s(conns)+"/"+i64s(int64(s.cfg.MaxConnections))+"（≥90% 上限）")
		} else {
			alertClear("conn_high")
		}
	}
}

// i64s int64 转字符串（告警文案拼接用）
func i64s(v int64) string {
	return strconv.FormatInt(v, 10)
}
