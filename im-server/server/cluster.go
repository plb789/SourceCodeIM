package server

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/protocol"
	"im-server/store"
)

// ===== 集群总线（并发改造 C 系列：多实例水平扩展）=====
// 设计：基于 Redis pub/sub 的单总线频道 + 类型化信封，将单实例内的内存投递扩展为跨实例投递。
// 投递原则：发送方"先本地投递、再上总线"；订阅方跳过本实例发出的信封（From==self 防回环重复）。
// 默认关闭（cluster_enabled=false）：总线不启动、信封不发布，全部投递走本地内存，
// 行为与单实例完全一致（开关保证零回归）。
//
// 信封类型：
//
//	k=d 定向投递  t=[目标用户]     d=帧数据：各实例对本实例内目标用户连接投递（私聊/群成员/文件通知）
//	k=b 全员广播  e=排除用户       d=帧数据：各实例本地全员广播（上线/下线/群消息/USER_LIST/公告等）
//	k=c 会话刷新  t=[目标用户]     各实例对本实例内目标用户连接执行本地会话推送去抖（未读角标多端同步）
//	k=i 缓存失效  iv=失效类别      黑名单/注册用户名单等进程内缓存跨实例失效
//	k=p 在场事件  t=[目标用户]     用户最后连接断开时发布，其他实例本地仍有连接则抢注全局在线名单
//
// 已知边界（单实例行为为准，多实例下不保证）：
//   - 同端互踢仅同实例生效（跨实例同端多连接允许共存，多端语义扩展）
//   - sendToUserBlock 跨实例段为尽力而为（总线 fire-and-forget），仅本地段可阻塞确认
//   - 通话/会议/远程协助的离线宽限收口状态为进程内存态，跨实例重连不触发收口取消
const (
	busKindDirect     = "d"
	busKindBroadcast  = "b"
	busKindConvUpdate = "c"
	busKindInvalidate = "i"
	busKindPresence   = "p"

	// 全局在线名单：HASH im:ulist（field=用户名，value=最近心跳 Unix 秒）
	// 由登录/心跳续期、最后连接断开删除；读取侧按新鲜度过滤，定时任务清理僵尸条目
	// （实例崩溃后其用户条目停更，60s 内自然失效，防 HASH 无限膨胀）
	KeyUserList    = "im:ulist"
	onlineFreshS   = 60  // 名单条目新鲜度阈值（秒）：超过视为离线
	onlineCleanupS = 300 // 僵尸条目清理周期（秒）
)

// busEnvelope 总线信封（Data 为已序列化的 protocol.Message JSON，encoding/json 自动 base64）
type busEnvelope struct {
	Kind    string   `json:"k"`
	From    string   `json:"f"`
	Targets []string `json:"t,omitempty"`
	Except  string   `json:"e,omitempty"`
	Data    []byte   `json:"d,omitempty"`
	InvKind string   `json:"iv,omitempty"`
}

// clusterBus 集群总线：发布端 + 订阅消费端
type clusterBus struct {
	enabled bool
	selfID  string
	channel string
	pubQ    chan string // 发布攒批队列（并发优化 E2：Pipeline 一次网络往返覆盖整批）
	mu      sync.RWMutex
}

// 总线发布攒批参数：信封最长延迟 ≤8ms（与消息批量落库窗口同级），单批 ≤64 信封
const (
	busPubQCap  = 4096
	busPubBatch = 64
	busPubEvery = 8 * time.Millisecond
)

var bus = &clusterBus{selfID: newInstanceID(), channel: "im:bus"}

// newInstanceID 实例标识：hostname+pid+启动纳秒，进程内唯一（回环过滤依据）
func newInstanceID() string {
	host, _ := os.Hostname()
	return host + ":" + strconv.Itoa(os.Getpid()) + ":" + strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
}

// startClusterBus 按配置启动总线订阅消费端（cluster_enabled=false 时不启动，全部本地投递）
func (s *Server) startClusterBus(cfg *config.Config) {
	if !cfg.ClusterEnabled {
		logger.Info("集群总线未启用（单实例模式）")
		return
	}
	if cfg.ClusterChannel != "" {
		bus.channel = cfg.ClusterChannel
	}
	bus.enabled = true
	// 总线注入 hub：Broadcast/BroadcastExcept 内部自动"本地+总线"，调用方零改动
	s.hub.bus = bus
	bus.startBusPublisher()
	go bus.consume(s)
	logger.Info("集群总线已启动（实例 %s，频道 %s）", bus.selfID, bus.channel)
}

// startBusPublisher 发布攒批 writer：信封入队，满批或 8ms 窗口一次 Pipeline 发布——
// 消息风暴下 N 次 PUBLISH 的 N 个 RTT 合并为 ⌈N/64⌉ 个 RTT（Redis pub/sub 原子发布无序，
// 攒批不改变事件语义）；进程崩溃丢失未 flush 窗口（≤8ms）信封，与消息批写风险同级。
// 订阅端按信封独立处理，与批量发布顺序无关
func (b *clusterBus) startBusPublisher() {
	b.pubQ = make(chan string, busPubQCap)
	go func() {
		ctx := context.Background()
		batch := make([]string, 0, busPubBatch)
		flush := func() {
			if len(batch) == 0 {
				return
			}
			pipe := store.RDB.Pipeline()
			for _, d := range batch {
				pipe.Publish(ctx, b.channel, d)
			}
			if _, err := pipe.Exec(ctx); err != nil {
				logger.Error("集群总线批量发布失败: %v", err)
			}
			batch = batch[:0]
		}
		ticker := time.NewTicker(busPubEvery)
		defer ticker.Stop()
		for {
			select {
			case d := <-b.pubQ:
				batch = append(batch, d)
				if len(batch) >= busPubBatch {
					flush()
				}
			case <-ticker.C:
				flush()
			}
		}
	}()
}

// publish 发布信封到总线（开关关闭时为 no-op；投递为尽力而为——入队攒批发布，
// 队列满时降级同步发布防丢）
func (b *clusterBus) publish(env *busEnvelope) {
	if !b.enabled {
		return
	}
	env.From = b.selfID
	data, err := json.Marshal(env)
	if err != nil {
		logger.Error("集群总线信封序列化失败: %v", err)
		return
	}
	select {
	case b.pubQ <- string(data):
	default:
		// 队列满降级同步发布（仪表盘观测：持续增长=总线 RTT 成为瓶颈）
		busPubQDegraded.Add(1)
		if err := store.RDB.Publish(context.Background(), b.channel, data).Err(); err != nil {
			logger.Error("集群总线发布失败: %v", err)
		}
	}
}

// busPubQDegraded 总线发布队列满降级累计（仪表盘观测；单实例模式恒为 0）
var busPubQDegraded atomic.Int64

// busQueueStats 总线发布队列观测值（仪表盘归口；单实例 bus=nil 时返回零值）
func busQueueStats() (length, cap_, degraded int64) {
	if s := defaultServer(); s != nil && s.hub != nil && s.hub.bus != nil {
		length = int64(len(s.hub.bus.pubQ))
		cap_ = int64(cap(s.hub.bus.pubQ))
		degraded = busPubQDegraded.Load()
	}
	return length, cap_, degraded
}

// publishConvUpdate 批量会话刷新事件：各实例对本实例内目标用户连接执行本地去抖推送
func (b *clusterBus) publishConvUpdate(users []string) {
	if len(users) == 0 {
		return
	}
	b.publish(&busEnvelope{Kind: busKindConvUpdate, Targets: users})
}

// publishPresenceOff 用户最后连接断开事件：其他实例本地仍有该用户连接则抢注全局在线名单
func (b *clusterBus) publishPresenceOff(username string) {
	b.publish(&busEnvelope{Kind: busKindPresence, Targets: []string{username}})
}

// consume 订阅消费循环：解码信封 → 本地投递（跳过本实例发出的，防回环重复）
func (b *clusterBus) consume(s *Server) {
	ctx := context.Background()
	pubsub := store.RDB.Subscribe(ctx, b.channel)
	defer pubsub.Close()
	for msg := range pubsub.Channel() {
		var env busEnvelope
		if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
			logger.Error("集群总线信封解析失败: %v", err)
			continue
		}
		if env.From == b.selfID {
			continue
		}
		switch env.Kind {
		case busKindDirect:
			for _, t := range env.Targets {
				s.deliverLocal(t, env.Data)
			}
		case busKindBroadcast:
			if env.Except != "" {
				s.hub.broadcastLocalExcept(env.Except, env.Data)
			} else {
				s.hub.broadcastLocal(env.Data)
			}
		case busKindConvUpdate:
			for _, u := range env.Targets {
				s.notifyConvUpdateLocal(u)
			}
		case busKindInvalidate:
			switch env.InvKind {
			case invBlacklist:
				blacklistInvalidate()
			case invUsers:
				usersCacheInvalidate()
			case invNick:
				// 昵称缓存失效：改昵称方实例已本地失效，其他实例按 Targets 携带的用户名失效
				//（nickCache 无 TTL，不失效则其他实例群聊帧/历史帧永远携带旧昵称）
				if len(env.Targets) > 0 {
					nickCache.Delete(env.Targets[0])
				}
			case invAgents:
				// AI 智能体列表变更：各实例重建运行时索引并按本实例在线用户视角重新广播
				//（BroadcastUser 为逐用户生成内容，无法随单一总线信封携带）
				reloadAIAgents()
				s.aiChangeBroadcastLocal()
			}
		case busKindPresence:
			// 在场抢注：本实例仍有该用户连接则重新写入全局在线名单（多端跨实例下线竞态自愈），
			// 并补发 online 纠偏帧（offline 广播已先行到达各实例客户端，纠正跨实例多端的误下线展示）
			if len(env.Targets) > 0 && s.hub.Count(env.Targets[0]) > 0 {
				store.RDB.HSet(ctx, KeyUserList, env.Targets[0], strconv.FormatInt(time.Now().Unix(), 10))
				invalidateGlobalListCache()
				onlineMsg := protocol.Message{
					MsgType:   protocol.MsgTypeOnline,
					FromUser:  env.Targets[0],
					Content:   "online",
					Timestamp: time.Now().Unix(),
				}
				if data, err := json.Marshal(onlineMsg); err == nil {
					s.hub.BroadcastExcept(env.Targets[0], data) // 本地 + 总线（与登录上线通知同口径，本人除外）
				}
			}
		}
	}
}

// invalidate kinds（进程内缓存跨实例失效类别）
const (
	invBlacklist = "blacklist"
	invUsers     = "users"
	invNick      = "nick"
	invAgents    = "agents"
)

// invalidateNickname 昵称缓存失效归口（本人改资料/后台改账号资料共用）：
// 本实例立即失效 + 集群模式总线广播（其他实例的 nickCache 为无 TTL 进程缓存，必须显式失效）
func (s *Server) invalidateNickname(username string) {
	nickCache.Delete(username)
	if s.hub.bus != nil {
		s.hub.bus.publish(&busEnvelope{Kind: busKindInvalidate, InvKind: invNick, Targets: []string{username}})
	}
}

// globalOnlineNames 全局在线名单：HASH 条目按心跳新鲜度过滤（本实例 hub 优先，零 Redis 往返）
// 2s 进程内缓存削峰：全局群每条消息都需要名单，万人 HASH（HGETALL ~百 KB）不能逐条消息拉取
var (
	globalListMu    sync.Mutex
	globalListCache []string
	globalListAt    time.Time
)

func (s *Server) globalOnlineNames() []string {
	globalListMu.Lock()
	if globalListCache != nil && time.Since(globalListAt) < 2*time.Second {
		list := globalListCache
		globalListMu.Unlock()
		return list
	}
	globalListMu.Unlock()

	m, err := store.RDB.HGetAll(context.Background(), KeyUserList).Result()
	if err != nil {
		return s.hub.Usernames() // Redis 异常降级本实例名单（行为退回单实例语义）
	}
	cutoff := time.Now().Add(-onlineFreshS * time.Second).Unix()
	local := s.hub.Usernames()
	localSet := make(map[string]struct{}, len(local))
	for _, n := range local {
		localSet[n] = struct{}{}
	}
	names := make([]string, 0, len(m)+len(local))
	seen := make(map[string]struct{}, len(m)+len(local))
	for name, tsStr := range m {
		ts, _ := strconv.ParseInt(tsStr, 10, 64)
		if ts < cutoff {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	// 本实例 hub 是权威实时源（心跳/注册写 HASH 有延迟窗口），并集保真
	for _, n := range local {
		if _, dup := seen[n]; !dup {
			names = append(names, n)
		}
	}

	globalListMu.Lock()
	globalListCache = names
	globalListAt = time.Now()
	globalListMu.Unlock()
	return names
}

// invalidateGlobalListCache 全局在线名单进程内缓存失效（登录/下线/抢注后立即生效）
func invalidateGlobalListCache() {
	globalListMu.Lock()
	globalListCache = nil
	globalListMu.Unlock()
}

// cleanupUserListStale 定时清理全局在线名单僵尸条目（实例崩溃后停更的条目，防 HASH 无限膨胀）
func cleanupUserListStale() {
	ctx := context.Background()
	m, err := store.RDB.HGetAll(ctx, KeyUserList).Result()
	if err != nil || len(m) == 0 {
		return
	}
	cutoff := time.Now().Add(-onlineCleanupS * time.Second).Unix()
	stale := make([]string, 0, 16)
	for name, tsStr := range m {
		ts, _ := strconv.ParseInt(tsStr, 10, 64)
		if ts < cutoff {
			stale = append(stale, name)
		}
	}
	if len(stale) > 0 {
		store.RDB.HDel(ctx, KeyUserList, stale...)
	}
}

// startUserListCleanup 启动僵尸条目定时清理（仅总线开启时运行，单实例名单不写 HASH 无需清理）
func startUserListCleanup() {
	go func() {
		t := time.NewTicker(onlineCleanupS * time.Second)
		defer t.Stop()
		for range t.C {
			cleanupUserListStale()
		}
	}()
}

// ===== 注册用户名单缓存（并发改造 C2：全局群离线入队免全表 Pluck）=====
// 内存缓存全注册用户名单（5 分钟 TTL），注册/注销成功时主动失效 + 集群失效事件广播。
// 全局群每条消息原实现全表 Pluck（万人 = 万人名单/条），缓存后零 DB 查询。
var (
	usersCacheMu    sync.RWMutex
	usersCacheNames []string
	usersCacheAt    time.Time
)

const usersCacheTTL = 5 * time.Minute

// registeredUsernames 取全注册用户名单（缓存命中返回 nil 表示无数据需回源）
func registeredUsernames() []string {
	usersCacheMu.RLock()
	defer usersCacheMu.RUnlock()
	if usersCacheNames != nil && time.Since(usersCacheAt) < usersCacheTTL {
		return usersCacheNames
	}
	return nil
}

// usersCacheStore 回源后写缓存
func usersCacheStore(names []string) {
	usersCacheMu.Lock()
	usersCacheNames = names
	usersCacheAt = time.Now()
	usersCacheMu.Unlock()
}

// usersCacheInvalidate 名单缓存失效（注册/注销/管理端删号后调用；集群模式同步广播）
func usersCacheInvalidate() {
	usersCacheMu.Lock()
	usersCacheNames = nil
	usersCacheMu.Unlock()
}
