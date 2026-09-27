package server

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/protocol"
)

// 阶段一百六十一：登录排队系统
// 原实现问题：服务重启后集中重连风暴（如 5 万在线瞬时重登）下，登录链路（密码验证 DB 查询 +
// 登录后 10 项并行推送 + 名单快照单发）瞬时过载；max_connections 超限只能硬拒绝后来者，
// 用户体验为"登录失败请重试"且重试继续加剧风暴。现引入令牌桶准入 + FIFO 等待队列：
// 按可配置速率平滑放行（软排队），排队者经 94 号帧定期推送排队位置，排到队首正常走登录链路；
// 队列上限与等待超时双保险防资源被拖垮，排队期间连接心跳照常（服务端读循环此时阻塞在
// 排队等待上不设读超时，客户端 30s 心跳缓冲在 TCP 窗，登录完成后统一补处理，连接不会被判超时）
//
// 位置计算 O(1) 说明：等待者入队时记录 basePos（当时队内位次）与 baseProcessed（当时全局已处理数），
// 之后其真实位次 = basePos - (processed - baseProcessed)。放行泵每从队首处理一人（放行或跳过）
// processed +1，全体等待者位次同步前移，无需遍历队列（2 万人排队下 O(n) 扫描不可接受）。
// 超时/断开的等待者惰性清除：仅打标记留在队内，放行泵到队首时跳过（processed 照常 +1，
// 其余等待者位次前移），避免队列中部删除导致位次重算。

// loginWaiter 单个排队等待者
type loginWaiter struct {
	client   *Client   // 所属连接（放行前最终断开检查，防死连接放行产生幽灵登录）
	user     string    // 排队用户名（取自登录帧 from_user，仅日志用）
	enqueued time.Time // 入队时间（排队时长日志用）
	// ch 放行信号（缓冲 1）：放行泵从队首摘除后写入；与等待协程的超时定时器存在
	// 理论竞态（恰好在超时边界放行），两者任一先到，另一侧结果被忽略，最坏浪费一个名额
	ch chan int
	// basePos/baseProcessed 入队时刻的位次与全局已处理数快照（O(1) 位次推算依据）
	basePos       int
	baseProcessed int64
	done          bool // 已终止标记（超时拒绝/连接断开）：放行泵到队首时跳过
}

// loginQueue 登录排队器：令牌桶准入 + FIFO 等待队列
type loginQueue struct {
	mu      sync.Mutex
	enabled bool
	rate    int           // 每秒放行登录数（令牌填充速率）
	maxLen  int           // 等待队列上限
	timeout time.Duration // 排队等待超时

	tokens float64   // 当前令牌数（突发上限 = rate，即 1 秒额度）
	last   time.Time // 上次令牌补充时间
	queue  []*loginWaiter
	// processed 放行泵累计处理数（放行 + 跳过），全体等待者位次推算基准
	processed int64
}

// newLoginQueue 创建排队器（参数兜底已由 config.Load 完成）
// 令牌初始为满桶（1 秒额度）：保证服务启动/重启初期登录立即可放行，不因攒令牌白排队
func newLoginQueue(cfg config.LoginQueueConfig) *loginQueue {
	return &loginQueue{
		enabled: cfg.Enabled,
		rate:    cfg.Rate,
		maxLen:  cfg.MaxLen,
		timeout: time.Duration(cfg.Timeout) * time.Second,
		tokens:  float64(cfg.Rate),
		last:    time.Now(),
	}
}

// start 启动放行泵（100ms 粒度补充令牌并从队首放行；未启用时空转不启动）
func (q *loginQueue) start() {
	if !q.enabled {
		return
	}
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for now := range tick.C {
			q.release(now)
		}
	}()
	logger.Info("登录排队系统已启用：放行速率 %d/秒，队列上限 %d，排队超时 %v", q.rate, q.maxLen, q.timeout)
}

// refillLocked 按流逝时间补充令牌（调用方须持有 q.mu）
// 突发上限为 1 秒额度：长时间空闲不累积超额突发，风暴到来首秒最多放行 rate 人
func (q *loginQueue) refillLocked(now time.Time) {
	elapsed := now.Sub(q.last).Seconds()
	if elapsed <= 0 {
		return
	}
	q.last = now
	q.tokens += elapsed * float64(q.rate)
	if cap := float64(q.rate); q.tokens > cap {
		q.tokens = cap
	}
}

// release 放行泵：从队首按令牌余量放行（调用方为 start 内 100ms tick 协程）
// 跳过已终止（超时/断开）的队首等待者：processed 照常 +1（其余等待者位次前移）但不耗令牌
func (q *loginQueue) release(now time.Time) {
	q.mu.Lock()
	q.refillLocked(now)
	for len(q.queue) > 0 && q.tokens >= 1 {
		w := q.queue[0]
		q.queue = q.queue[1:]
		q.processed++
		// 终止者（超时标记/连接已断开）跳过不耗令牌：processed 照常 +1 让其余等待者位次前移。
		// 断开检查必须在本处兜底——wait 的 3s 周期检测晚于放行间隔时（rate 高频放行），
		// 死连接若被放行会走完整登录链路产生幽灵在线（hub 注册死连接后靠读循环退出自愈）
		if w.done || w.client.isClosed() {
			continue
		}
		q.tokens--
		w.ch <- 1
		logger.Info("登录排队：放行用户 %s（排队 %v，队尾剩余 %d 人）",
			w.user, now.Sub(w.enqueued).Truncate(time.Second), len(q.queue))
	}
	q.mu.Unlock()
}

// admit 登录准入：返回 true 放行（直接或排队后），false 拒绝（调用方终止登录；
// 超时/队列满场景本函数已向客户端下发 ERROR 回执并关闭连接）
func (q *loginQueue) admit(c *Client, username string) bool {
	if !q.enabled {
		return true
	}
	now := time.Now()
	q.mu.Lock()
	q.refillLocked(now)
	// FIFO 公平：队列非空时新登录一律入队（不与队首抢令牌），先到先得
	if len(q.queue) == 0 && q.tokens >= 1 {
		q.tokens--
		q.mu.Unlock()
		return true
	}
	if len(q.queue) >= q.maxLen {
		q.mu.Unlock()
		c.SendErrorAndClose("当前登录人数较多，请稍后重试")
		logger.Warn("登录排队：队列已满（上限 %d），拒绝用户 %s", q.maxLen, username)
		return false
	}
	w := &loginWaiter{
		client:        c,
		user:          username,
		enqueued:      now,
		ch:            make(chan int, 1),
		basePos:       len(q.queue) + 1,
		baseProcessed: q.processed,
	}
	q.queue = append(q.queue, w)
	q.mu.Unlock()
	logger.Info("登录排队：用户 %s 进入队列第 %d 位（限流 %d/秒）", username, w.basePos, q.rate)
	// 首帧位置即时推送（后续每 3s 周期推送，见 wait）
	pushQueuePos(c, w.basePos, q.rate)
	return q.wait(c, w)
}

// wait 排队等待：放行返回 true；超时拒绝/连接断开返回 false（调用方终止登录）
// 超时拒绝经 SendErrorAndClose 同步送达提示后断开（与登录失败同模式，防竞态提示丢失）
func (q *loginQueue) wait(c *Client, w *loginWaiter) bool {
	pos := time.NewTicker(3 * time.Second) // 位置周期推送
	defer pos.Stop()
	timer := time.NewTimer(q.timeout)
	defer timer.Stop()
	for {
		select {
		case <-w.ch:
			return true
		case <-timer.C:
			q.mu.Lock()
			w.done = true
			q.mu.Unlock()
			c.SendErrorAndClose("登录排队超时，请稍后重试")
			logger.Warn("登录排队：用户 %s 等待超时（%v）被拒绝", w.user, q.timeout)
			return false
		case <-pos.C:
			if c.isClosed() {
				// 连接已断开（写泵写失败置位）：静默终止排队，客户端不在了无需提示
				q.mu.Lock()
				w.done = true
				q.mu.Unlock()
				logger.Info("登录排队：用户 %s 排队期间连接断开，退出队列", w.user)
				return false
			}
			q.mu.Lock()
			p := w.basePos - int(q.processed-w.baseProcessed)
			q.mu.Unlock()
			if p < 1 {
				p = 1
			}
			pushQueuePos(c, p, q.rate)
		}
	}
}

// pushQueuePos 下行 94 排队位置帧（content 为 JSON：{position 当前第 N 位, wait 预计等待秒}）
// 预计等待 = 位置 ÷ 放行速率 向上取整
func pushQueuePos(c *Client, pos, rate int) {
	data, _ := json.Marshal(&protocol.Message{
		MsgType: protocol.MsgTypeLoginQueue,
		Content: `{"position":` + strconv.Itoa(pos) + `,"wait":` + strconv.Itoa((pos+rate-1)/rate) + `}`,
	})
	c.send(data)
}
