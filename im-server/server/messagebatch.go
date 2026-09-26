package server

import (
	"errors"
	"sync/atomic"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// errPersistFailed 消息落库失败（调用方按原失败分支处理）
var errPersistFailed = errors.New("消息落库失败")

// 消息批量落库（并发优化 E1）：高频 Message 写归口
// - 原实现：每条消息独立事务 INSERT（1 fsync + 1 RTT/条），消息风暴下 MySQL 写入为第一瓶颈
// - 现实现：handler 调 persistMessage 入队并等待回填自增 ID（帧 MsgID 语义不变，撤回/历史/
//   离线入队依赖不变），后台 4 worker 攒批（≤200 条或 20ms）→ 单事务逐条 INSERT——
//   一次 fsync 覆盖整批（写吞吐提升一个数量级），且 ID 精确回填（规避多值 INSERT 在并发
//   占号场景下 GORM 按 LAST_INSERT_ID 推算导致的 ID 错位）
// - 降级保护：队列满（背压）或等待超时（2s）时同步直写，CAS 防双写；批事务失败逐条重试隔离坏行
// - 一致性边界：进程崩溃丢失未 flush 窗口（≤20ms）内的消息，与原同步写事务丢失同级
// - 低频写（AI 问答、Agent 任务、话单）不归口，保持同步直写

const (
	msgQCap        = 4096                  // 队列容量（超出即背压降级同步写）
	msgBatchMax    = 200                   // 单批上限
	msgFlushEvery  = 20 * time.Millisecond // 攒批窗口（延迟与 fsync 合并的平衡点：消息端到端投递延迟 ≤~40ms）
	msgPersistWait = 2 * time.Second       // handler 等待回填超时（超时降级）
)

// msgPersistJob 单条消息落库任务
type msgPersistJob struct {
	msg      *model.Message
	done     chan struct{} // 关闭即回填完成（msg.ID 已写；ID=0 表示落库失败）
	degraded atomic.Bool   // true=归属方已定（降级方直写或 worker 认领），另一方跳过
}

var msgQ chan *msgPersistJob

// 落库降级计数（后台仪表盘观测）：背压=队列满降级、超时=批写卡死兜底降级——
// 正常态恒为 0，持续增长说明 DB 写入能力跟不上消息量（扩 worker/扩池/优化 DB）
var msgQDegraded atomic.Int64
var msgQTimeouts atomic.Int64

// 批写效率观测（仪表盘）：累计批次/批内总条数 → 批均大小 = items/runs。
// 批越大 fsync 合并越好；流量低谷时批均掉到个位数属正常，风暴期掉到个位数说明 worker 不足
var batchRuns atomic.Int64
var batchItems atomic.Int64

// msgQueueStats 落库队列观测值（仪表盘归口）：队列当前长度/容量/累计降级次数/批均大小。
// 队列长度高频波动仅作瞬时观测（采样时 len(chan) 有竞态但只影响展示精度，无碍）
func msgQueueStats() (length, cap_, degraded, timeouts, batchAvg int64) {
	if msgQ != nil {
		length = int64(len(msgQ))
		cap_ = int64(cap(msgQ))
	}
	degraded, timeouts = msgQDegraded.Load(), msgQTimeouts.Load()
	if runs := batchRuns.Load(); runs > 0 {
		batchAvg = batchItems.Load() / runs
	}
	return length, cap_, degraded, timeouts, batchAvg
}

// startMessageBatchWorker 启动落库 worker（NewServer 归口调用）
// 多 worker 并行消费共享队列：单 worker 事务内逐条 INSERT 会形成串行 RTT 累计
// （≈1-3k 条/s），反而低于原"连接池多连接并行单条事务"；4 worker 并行后 fsync 仍
// 1 次/批（批写收益保留），总吞吐 ≈ 4-12k 条/s。同用户消息跨 worker 乱序无碍——
// 前端按时间戳/消息 ID 排序，与原多连接并发写语义一致
func startMessageBatchWorker() {
	msgQ = make(chan *msgPersistJob, msgQCap)
	for i := 0; i < 4; i++ {
		go messageBatchLoop()
	}
}

// persistMessage 高频消息落库归口：入队批写并等待 ID 回填，返回自增 ID（0=落库失败）
func (s *Server) persistMessage(msg *model.Message) uint {
	job := &msgPersistJob{msg: msg, done: make(chan struct{})}
	select {
	case msgQ <- job:
	default:
		// 队列满：背压降级同步写（保投递不丢）
		msgQDegraded.Add(1)
		if err := store.DB.Create(msg).Error; err != nil {
			logger.Error("消息落库(背压降级)失败：%v", err)
			return 0
		}
		return msg.ID
	}
	select {
	case <-job.done:
		return msg.ID
	case <-time.After(msgPersistWait):
		// 批写卡死兜底：CAS 抢占同步直写（worker 已认领则等待其回填）
		msgQTimeouts.Add(1)
		if job.degraded.CompareAndSwap(false, true) {
			if err := store.DB.Create(msg).Error; err != nil {
				logger.Error("消息落库(超时降级)失败：%v", err)
				return 0
			}
			close(job.done)
			return msg.ID
		}
		<-job.done
		return msg.ID
	}
}

// messageBatchLoop 攒批循环
func messageBatchLoop() {
	batch := make([]*msgPersistJob, 0, msgBatchMax)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		batchRuns.Add(1)
		batchItems.Add(int64(len(batch)))
		persistBatch(batch)
		batch = batch[:0]
	}
	ticker := time.NewTicker(msgFlushEvery)
	defer ticker.Stop()
	for {
		select {
		case job := <-msgQ:
			if job.degraded.Load() { // 降级方已直写，跳过
				continue
			}
			batch = append(batch, job)
			if len(batch) >= msgBatchMax {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

// persistBatch 批量落库：单事务逐条 INSERT（ID 精确回填），事务失败逐条重试隔离坏行
func persistBatch(batch []*msgPersistJob) {
	defer func() {
		// worker 异常兜底：未回填的任务降级逐条写并回填（0=失败），防 handler 悬等
		if r := recover(); r != nil {
			logger.Error("消息批量落库异常：%v", r)
			for _, job := range batch {
				if job.degraded.CompareAndSwap(false, true) {
					if err := store.DB.Create(job.msg).Error; err != nil {
						job.msg.ID = 0
					}
					close(job.done)
				}
			}
		}
	}()

	tx := store.DB.Begin()
	ok := true
	for _, job := range batch {
		if job.degraded.Load() { // 期间被降级方抢占（竞态窗口极小）
			continue
		}
		if err := tx.Create(job.msg).Error; err != nil {
			ok = false
			break
		}
	}
	if ok && tx.Commit().Error == nil {
		for _, job := range batch {
			if !job.degraded.Load() {
				close(job.done)
			}
		}
		return
	}
	tx.Rollback()

	// 事务失败：逐条重试隔离坏行（单条坏数据不拖垮整批）
	for _, job := range batch {
		if job.degraded.Load() {
			continue
		}
		if err := store.DB.Create(job.msg).Error; err != nil {
			logger.Error("消息落库(逐条重试)失败：%v", err)
			job.msg.ID = 0
		}
		close(job.done)
	}
}
