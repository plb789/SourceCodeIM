package server

import (
	"sync"
	"sync/atomic"

	"im-server/logger"
)

// Hub 连接管理中心：同一用户名支持多设备同时在线（用户名 -> 连接集合）
// 多端架构下：任一连接在线即用户在线；定向推送遍历该用户全部连接；最后一个连接断开才判定离线
// 集群模式（cluster_enabled=true）：Broadcast/BroadcastExcept 内部自动"本地投递+总线发布"，
// 跨实例广播对调用方透明；集群关闭时 bus 为 nil，纯本地投递（单实例行为不变）
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]bool // username -> 连接集合
	bus     *clusterBus                 // 集群总线（startClusterBus 注入；nil=单实例模式）
	// 并发改造 D1：连接总数原子计数（原 TotalConns 遍历全 map O(N)，每次新连接接入
	// 都要在 HandleWS 里全量统计一遍，万级在线时每次接入遍历万级 map）——Add/Remove 增减，读取 O(1)
	total atomic.Int64
}

// NewHub 创建连接管理中心
func NewHub() *Hub {
	return &Hub{
		clients: make(map[string]map[*Client]bool),
	}
}

// Add 新连接加入在线列表，返回是否为该用户的首设备上线
// 原实现：连接集合多端共存不踢旧连接——同账号同端（PC 对 PC）重复登录产生多连接并存，
// 违背"同端单实例"预期（跨端多开 PC+WEB 才是多端共存的正确语义）
// 阶段一百四十五：同端互踢——同账号同 platform（PC↔PC / WEB↔WEB / 手机↔手机）仅保留最新连接，
// 跨端（PC+WEB+手机）继续多端共存；被踢旧连接下发提示后关闭（客户端弹窗回登录页，不自动重连，
// 复用封禁踢出同款链路 SendErrorAndClose），网络抖动重连/页面刷新场景新连接自然接管旧半死连接
// 5万容量改造（E9）：返回值语义=加入前连接集合为空（用户此前完全不在线）。同端替换登录
// （互踢后 Count 同样为 1）与跨端新增（用户本就在线）均返回 false——调用方据此判定是否
// 广播上线通知/名单增量，修复替换登录被误判首设备导致的重复广播（存量 bug，原全量快照
// 广播幂等掩盖，E9 增量语义下由探针 T6 暴露）
func (h *Hub) Add(c *Client) bool {
	h.mu.Lock()
	set, ok := h.clients[c.username]
	if !ok {
		set = make(map[*Client]bool)
		h.clients[c.username] = set
	}
	firstDevice := len(set) == 0 // 踢人前判定：集合为空=用户此前无任何在线连接
	// 同端互踢：锁内收集同 platform 旧连接并移出集合，锁外发提示并关闭（SendErrorAndClose
	// 同步写后触发 readPump 退出 → unregister → Remove 再取锁，持锁调用会死锁，必须锁外执行）
	var kicked []*Client
	for old := range set {
		if old != c && old.platform == c.platform {
			kicked = append(kicked, old)
			delete(set, old)
		}
	}
	set[c] = true
	total := len(set)
	// 并发改造 D1：净增 1（新连接）- len(kicked)（同端互踢移除的旧连接）
	h.total.Add(int64(1 - len(kicked)))
	h.mu.Unlock()
	// 被踢提示（platformName 归口端型中文命名，日志与提示语一致）
	for _, old := range kicked {
		logger.Info("同端互踢：用户 %s 的 %s 端旧连接被新登录替换", c.username, platformName(c.platform))
		old.SendErrorAndClose("您的账号已在其他" + platformName(c.platform) + "设备上登录，本设备已下线")
	}
	if total > 1 {
		logger.Info("用户 %s 新设备接入，当前在线连接数 %d", c.username, total)
	}
	return firstDevice
}

// platformName 端型中文名（互踢提示与日志归口；未知值原样返回便于排查）
// 独立分享页阶段：'share'=网盘分享页（socket.js /s/ 路径上报，与主应用各端跨端共存不互踢）
func platformName(p string) string {
	switch p {
	case "pc":
		return "PC"
	case "web":
		return "WEB"
	case "":
		return "手机"
	case "share":
		return "分享页"
	}
	return p
}

// Remove 移除指定连接（按连接移除，避免误删同用户其他设备），返回该用户剩余连接数
// 原实现：Remove(username) 直接按用户名删除，存在旧连接断开误删新连接的竞态
func (h *Hub) Remove(c *Client) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.clients[c.username]
	if !ok {
		return 0
	}
	if _, existed := set[c]; !existed {
		// 并发改造 D1：连接已被 Add 的同端互踢移除，非集合成员，不重复递减计数
		// （原实现 no-op delete 后同样返回剩余数，行为不变，仅补计数保护）
		return len(set)
	}
	delete(set, c)
	h.total.Add(-1)
	if len(set) == 0 {
		delete(h.clients, c.username)
		return 0
	}
	return len(set)
}

// Count 返回该用户当前在线连接数
func (h *Hub) Count(username string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[username])
}

// GetAll 返回该用户全部在线连接（定向推送遍历使用）
func (h *Hub) GetAll(username string) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	set := h.clients[username]
	list := make([]*Client, 0, len(set))
	for c := range set {
		list = append(list, c)
	}
	return list
}

// Get 获取指定用户的任一在线连接（兼容保留：文件等点对点场景）
func (h *Hub) Get(username string) (*Client, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients[username] {
		return c, true
	}
	return nil, false
}

// HasPC 阶段六十：该用户是否存在 PC 端（Electron）在线连接——Agent 本地执行器下发判定依据。
// 多端同账号在线时任一 PC 连接在线即视为可下发（执行结果经 WS 回传，与具体连接无关）
func (h *Hub) HasPC(username string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients[username] {
		if c.platform == "pc" {
			return true
		}
	}
	return false
}

// HasCall 阶段一百四十五：该用户是否存在支持音视频通话的端在线连接——通话/会议被叫能力归口判定。
// WEB 端（浏览器，platform="web"）通话功能上线后与 PC 端（platform="pc"）同具 WebRTC 通话能力；
// 手机端（platform 空）暂不支持。多端同账号在线时任一可通话连接在线即视为可呼叫
func (h *Hub) HasCall(username string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients[username] {
		if c.platform == "pc" || c.platform == "web" {
			return true
		}
	}
	return false
}

// Usernames 返回所有在线用户名（去重，任一连接在线即在线）
func (h *Hub) Usernames() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	names := make([]string, 0, h.total.Load())
	for name := range h.clients {
		names = append(names, name)
	}
	return names
}

// Users 在线用户数（多端合并后账号数；仪表盘采样用，非热路径）
func (h *Hub) Users() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// AllConns 枚举全部连接（仪表盘发送队列水位采样用，非热路径；调用方不得修改连接）
func (h *Hub) AllConns() []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	all := make([]*Client, 0, h.total.Load())
	for _, set := range h.clients {
		for c := range set {
			all = append(all, c)
		}
	}
	return all
}

// TotalConns 返回当前全部在线连接总数（阶段三十一：max_connections 上限校验使用）
// 并发改造 D1：原遍历全 map O(N)，现原子计数 O(1)
func (h *Hub) TotalConns() int {
	return int(h.total.Load())
}

// Broadcast 向所有在线客户端的全部连接广播消息
// 集群模式：本地投递 + 总线全员广播（各实例本地投递，From==self 回环跳过防重复）
func (h *Hub) Broadcast(data []byte) {
	if h.bus != nil {
		h.bus.publish(&busEnvelope{Kind: busKindBroadcast, Data: data})
	}
	h.broadcastLocal(data)
}

// broadcastLocal 纯本地全员广播（总线订阅回调回环投递归口，不再上总线）
func (h *Hub) broadcastLocal(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, set := range h.clients {
		for c := range set {
			c.send(data)
		}
	}
}

// BroadcastExcept 向除指定用户外的所有在线客户端广播消息（该用户的全部设备均不接收）
// 集群模式：本地投递 + 总线广播（各实例按 except 本地排除）
func (h *Hub) BroadcastExcept(except string, data []byte) {
	if h.bus != nil {
		h.bus.publish(&busEnvelope{Kind: busKindBroadcast, Except: except, Data: data})
	}
	h.broadcastLocalExcept(except, data)
}

// broadcastLocalExcept 纯本地排除广播（总线订阅回调回环投递归口）
func (h *Hub) broadcastLocalExcept(except string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for name, set := range h.clients {
		if name == except {
			continue
		}
		for c := range set {
			c.send(data)
		}
	}
}

// BroadcastUser 阶段五十七：按用户视角广播——每个在线用户按其用户名生成各自内容下发
// （AI 智能体列表因人而异：公共智能体 + 该用户自建的个人智能体；同一用户的全部设备收到相同内容）
func (h *Hub) BroadcastUser(generate func(username string) []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for name, set := range h.clients {
		data := generate(name)
		for c := range set {
			c.send(data)
		}
	}
}
