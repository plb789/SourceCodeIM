package server

// ============= 阶段二百九十三：服务号消息推送核心（P3 完整实现） =============
//
// 本文件归口：MsgType 117 服务号消息推送完整链路
//   单推 / 多推 / 群发 / 模板渲染 / Worker Pool / 离线入队 / touchConversation
//
// 核心模式：collect task queue first + bounded worker pool via channel（experience ref 2159869）
//   批量/群发任务先入队（Redis List LPUSH），由固定 worker 数（config batch_workers）并发消费
//   异常 worker 内部 recover 记录，不覆盖外层主事务错误
//
// 入口函数：
//   SendOfficialMsg(...)       —— 单用户推送（同步直接调用 sendOfficialOne）
//   SendOfficialBatchMsg(...)  —— 多用户异步批量（入 Redis List，worker 消费）
//   SendOfficialBroadcast(...) —— 群发所有订阅者（分片 fan-out，每片入批量队列）
//   sendOfficialOne(...)       —— 单发核心（落库 + 推在线 / 离线入队 + touchConversation）
//   officialWorkerPool()       —— goroutine pool（懒启动，once 保护）
//   renderOfficialTemplate(...) —— 模板 {{key}} 变量替换 + HTML 转义防 XSS

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ============= 发送核心入口 =============

// OfficialSendReq 推送请求（API / 后台 / 审核通过 统一入口）
type OfficialSendReq struct {
	AccountID   uint
	AppID       string
	Recipients  []string // 单推/多推时的用户列表；空=群发
	Title       string
	ContentType string // text/image/news/template
	Content     string
	URL         string
	LinkBtn     string
	TriggerType string // api / manual / menu / event
	NeedAudit   bool
	MessageID   uint   // 关联 official_message 记录（发送成功后回填）
}

// officialTask 入队推送任务（Redis List 存储，worker pool 消费）
type officialTask struct {
	AccountID   uint   `json:"account_id"`
	AppID       string `json:"app_id"`
	Recipient   string `json:"recipient"`
	Title       string `json:"title"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
	URL         string `json:"url"`
	LinkBtn     string `json:"link_btn"`
	TriggerType string `json:"trigger_type"`
	MessageID   uint   `json:"message_id"`
}

// officialPool 状态（once 懒启动 + 原子计数器）
var (
	officialPoolOnce sync.Once
	officialPoolOK   atomic.Bool
	officialPoolSeq  atomic.Uint64 // worker 命名序号
)

// SendOfficialMsg 单用户推送（同步，直接落库+转发）
// 审核通过后由 official_audit.go 调用本入口
func (s *Server) SendOfficialMsg(req OfficialSendReq, recipient string) error {
	recipient = strings.TrimSpace(recipient)
	if recipient == "" {
		return nil
	}
	if !userIsSubscribed(recipient, req.AppID) {
		logger.Warn("服务号 %s 推送给 %s 失败：未订阅", req.AppID, recipient)
		return nil
	}
	return s.sendOfficialOne(req, recipient)
}

// SendOfficialBatchMsg 多用户异步批量推送（入 Redis List，worker pool 消费）
// Redis key: im:official:queue:<appid>  (List)
// 每入队一批触发一次 worker pool（once 保证首次启动）
func (s *Server) SendOfficialBatchMsg(req OfficialSendReq, recipients []string) {
	cfg := s.cfg.Official
	ctx := context.Background()
	queueKey := "im:official:queue:" + req.AppID
	var enqueued int
	for _, u := range recipients {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		if blocked, _ := s.officialUserLimitCheck(ctx, u); blocked {
			continue
		}
		task := officialTask{
			AccountID:   req.AccountID,
			AppID:       req.AppID,
			Recipient:   u,
			Title:       req.Title,
			ContentType: req.ContentType,
			Content:     req.Content,
			URL:         req.URL,
			LinkBtn:     req.LinkBtn,
			TriggerType: req.TriggerType,
			MessageID:   req.MessageID,
		}
		payload, err := json.Marshal(task)
		if err != nil {
			logger.Error("服务号批量入队 JSON 序列化失败 err=%s", err.Error())
			continue
		}
		if err := store.RDB.RPush(ctx, queueKey, string(payload)).Err(); err != nil {
			logger.Error("服务号批量入队 Redis 失败 app=%s err=%s", req.AppID, err.Error())
			continue
		}
		enqueued++
	}
	if enqueued > 0 {
		officialPoolOK.Store(true)
		s.officialWorkerPool()
	}
	logger.Info("服务号批量入队 app=%s enqueued=%d total_batch=%d", req.AppID, enqueued, len(recipients))
	_ = cfg
}

// SendOfficialBroadcast 群发所有订阅者（分片 fan-out → 每片走 SendOfficialBatchMsg）
func (s *Server) SendOfficialBroadcast(req OfficialSendReq) {
	cfg := s.cfg.Official
	limit := cfg.BatchSizeVal()
	offset := 0
	for {
		var subs []model.OfficialSubscribe
		if err := store.DB.Where("app_id = ? AND unsubscribed = false", req.AppID).
			Offset(offset).Limit(limit).Find(&subs).Error; err != nil {
			logger.Error("群发订阅者查询失败 app=%s err=%s", req.AppID, err.Error())
			break
		}
		if len(subs) == 0 {
			break
		}
		batch := make([]string, 0, len(subs))
		for _, sub := range subs {
			batch = append(batch, sub.Username)
		}
		s.SendOfficialBatchMsg(req, batch)
		logger.Info("服务号群发片 app=%s offset=%d count=%d", req.AppID, offset, len(batch))
		if len(subs) < limit {
			break
		}
		offset += limit
	}
}

// ============= 单发核心 =============

// sendOfficialOne 单发一个用户：构造信封 → 落库 → 推在线 → 离线入队 → touchConversation
// 异常时仅记录日志（旁路隔离），不回传 error 覆盖上层主事务
func (s *Server) sendOfficialOne(req OfficialSendReq, recipient string) error {
	// 1. 构造信封 JSON
	envelope, _ := json.Marshal(map[string]interface{}{
		"official": map[string]interface{}{
			"app_id":      req.AppID,
			"msg_type":    req.ContentType,
			"title":       req.Title,
			"content":     req.Content,
			"url":         req.URL,
			"link_btn":    req.LinkBtn,
		},
	})
	chatMsg := protocol.Message{
		MsgType:   protocol.MsgTypeOfficialMsg,
		FromUser:  "o_" + req.AppID,
		FromName:  req.Title,
		ToUser:    recipient,
		Content:   string(envelope),
		Timestamp: time.Now().Unix(),
	}
	record := model.Message{
		MsgType:  int8(protocol.MsgTypeOfficialMsg),
		FromUser: chatMsg.FromUser,
		ToUser:   chatMsg.ToUser,
		Content:  chatMsg.Content,
	}
	record.ID = s.persistMessage(&record)
	if record.ID == 0 {
		logger.Error("服务号消息落库失败 app_id=%s recipient=%s", req.AppID, recipient)
		return fmt.Errorf("落库失败")
	}
	chatMsg.MsgID = record.ID

	data, _ := json.Marshal(chatMsg)

	// 2. 会话摘要（title 优先；否则 content 前 50 rune）
	summary := req.Title
	if strings.TrimSpace(summary) == "" {
		rs := []rune(req.Content)
		if len(rs) > 50 {
			summary = string(rs[:50]) + "..."
		} else {
			summary = req.Content
		}
	}

	// 3. 在线推送 or 离线入队（旁路动作，错误不影响主流程）
	if s.isOnlineFast(recipient) {
		s.sendToUser(recipient, data)
	} else {
		s.queueOffline(recipient, &chatMsg)
	}

	// 4. touchConversation + 会话刷新（未读角标自动 +1）
	s.touchConversationDebounced(recipient, "o_"+req.AppID, summary, record.ID)
	s.notifyConvUpdate(recipient)

	logger.Info("服务号推送：%s → %s（msg_id=%d）", req.AppID, recipient, record.ID)
	return nil
}

// ============= Worker Pool（核心） =============

// officialWorkerPool 异步 worker pool（once 懒启动，goroutine 数 = config batch_workers）
// 消费 Redis List（BLPOP 阻塞等待），取到 payload → json decode → sendOfficialOne
// 独立通道 per app queue，所有 app 共享同一个 pool（worker 从多 key 中轮询取任务）
func (s *Server) officialWorkerPool() {
	cfg := s.cfg.Official
	officialPoolOnce.Do(func() {
		n := cfg.BatchWorkersVal()
		logger.Info("服务号 Worker Pool 启动 workers=%d", n)
		// 每个 worker 独立循环：从官方队列 Redis List 轮询（最多扫描 100 个活跃 appid）
		// 简化实现：用一个共享 channel 收集所有待消费 payload（LPUSH → channel 扇出到 worker）
		// 真实 fan-out 见官方实现注释（每 app 一个 list，worker 用 BRPOP 多 key 阻塞）

		// 用 channel 扇出：从 Redis LPUSH 的 payload 统一汇总到 pushCh
		pushCh := make(chan officialTask, cfg.BatchSizeVal()*2) // 有界缓冲，峰值积压 ≤ 2 * per-batch

		// 扇出协程（独立于 worker，保证 Redis → channel 持续填充）
		go func() {
			defer func() {
				if r := recover(); r != nil {
					logger.Error("服务号 pushCh 扇出 panic recover=%v", r)
				}
			}()
			// 扫描模式：每 200ms 用 KEYS im:official:queue:* 取出所有活跃队列
			// 生产环境建议改用 SCAN + PubSub 触发；扫描实现简单满足规模
			ticker := time.NewTicker(200 * time.Millisecond)
			defer ticker.Stop()
			for range ticker.C {
				if !officialPoolOK.Load() {
					continue
				}
				ctx := context.Background()
				// SCAN 0 MATCH im:official:queue:* COUNT 50
				var cursor uint64
				for {
					keys, next, err := store.RDB.Scan(ctx, cursor, "im:official:queue:*", 50).Result()
					if err != nil {
						break
					}
					cursor = next
					for _, k := range keys {
						// 非阻塞 LPOP 最多每次 100 条
						for i := 0; i < 100; i++ {
							raw, err := store.RDB.LPop(ctx, k).Result()
							if err != nil || raw == "" {
								break
							}
							var t officialTask
							if err := json.Unmarshal([]byte(raw), &t); err != nil {
								logger.Error("服务号入队 payload 解析失败 err=%s payload=%s", err.Error(), raw)
								continue
							}
							select {
							case pushCh <- t:
							default:
								// channel 已满，回推 Redis（防止丢任务）
								store.RDB.RPush(ctx, k, raw)
								continue // 当前 app 队列暂时停止消费，下一轮再扫
							}
						}
					}
					if cursor == 0 {
						break
					}
				}
			}
		}()

		// N 个 worker 并发消费（从 pushCh 读取 → sendOfficialOne）
		var wg sync.WaitGroup
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(workerID int) {
				defer wg.Done()
				defer func() {
					if r := recover(); r != nil {
						logger.Error("服务号 worker-%d panic recover=%v", workerID, r)
					}
				}()
				for t := range pushCh {
					req := OfficialSendReq{
						AccountID:   t.AccountID,
						AppID:       t.AppID,
						Title:       t.Title,
						ContentType: t.ContentType,
						Content:     t.Content,
						URL:         t.URL,
						LinkBtn:     t.LinkBtn,
						TriggerType: t.TriggerType,
						MessageID:   t.MessageID,
					}
					if err := s.sendOfficialOne(req, t.Recipient); err != nil {
						// 旁路错误：不中断 worker，仅记录（与主事务隔离，experience ref 2159869）
						logger.Warn("服务号 worker-%d 推送失败 app=%s → %s err=%s",
							workerID, t.AppID, t.Recipient, err.Error())
						continue
					}
				}
			}(i)
		}
		logger.Info("服务号 Worker Pool 就绪 workers=%d", n)
	})
}

// ============= 频率限制（P4 预留，当前返回 false 直通） =============

// officialUserLimitCheck 单用户接收频率限制（防骚扰）
// 设计：key=im:official:userlimit:<username>, INCR + EXPIRE 1h；当前实现直通，P4 接入 Redis INCR
func (s *Server) officialUserLimitCheck(ctx context.Context, username string) (bool, error) {
	return false, nil
}

// officialDailyLimitCheck 单服务号日推送量校验
// 设计：key=im:official:daily:<appid>，Redis INCR + 每日 23:59:59 过期；当前直通
func (s *Server) officialDailyLimitCheck(ctx context.Context, accountID uint, appID string) bool {
	return true
}

// ============= 模板渲染 =============

// renderOfficialTemplate 模板渲染：{{key}} → data[key] 变量替换 + HTML 转义防 XSS
// 规则：
//   1. 正则匹配 {{xxx}} 占位符
//   2. 变量缺失 → 替换为空字符串（不抛错，符合模板容错）
//   3. 替换前对 value 做 htmlEscape（<,>,&,",' 转义）
func renderOfficialTemplate(tplContent string, data map[string]string) string {
	if tplContent == "" {
		return ""
	}
	// 简单 strings.ReplaceAll 循环（占位符数量有限，性能可接受）
	// 用双层括号 {{...}} 替换，模板开发者写 {{order_no}} 渲染为实际值
	result := tplContent
	// 收集所有 {{xxx}} 占位符（简单循环 + strings.IndexAll 不够直观，用正则）
	var placeholders []string
	buf := result
	for {
		start := strings.Index(buf, "{{")
		if start < 0 {
			break
		}
		end := strings.Index(buf[start:], "}}")
		if end < 0 {
			break
		}
		ph := buf[start : start+end+2]
		placeholders = append(placeholders, ph)
		buf = buf[start+end+2:]
	}
	for _, ph := range placeholders {
		key := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(ph, "{{"), "}}"))
		val := ""
		if v, ok := data[key]; ok {
			val = htmlEscape(v)
		}
		result = strings.ReplaceAll(result, ph, val)
	}
	return result
}

// htmlEscape 防 XSS：替换 <,>,&,",'
func htmlEscape(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 4)
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&#39;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ============= 审核 → 发送 桥接（P5 预留，骨架已完整可读） =============

// sendOfficialAfterAudit 审核通过后由 official_audit.go 调用
// 根据 official_message 记录重建 OfficialSendReq 并进入发送队列
func (s *Server) sendOfficialAfterAudit(msg model.OfficialMessage) {
	// TODO: P5 实现
	// 1. 更新 send_status='sending'
	// 2. 重建 OfficialSendReq（Title/Content/ContentType/Recipient/MessageID）
	// 3. Recipient 空 → SendOfficialBroadcast；非空逗号分隔 → SendOfficialBatchMsg；单条 → SendOfficialMsg
	// 4. 推送完成后 send_status='sent'，回填 sent_count/fail_count
}
