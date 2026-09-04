package server

import (
	"sync"

	"im-server/logger"
)

// Hub 连接管理中心：同一用户名支持多设备同时在线（用户名 -> 连接集合）
// 多端架构下：任一连接在线即用户在线；定向推送遍历该用户全部连接；最后一个连接断开才判定离线
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]bool // username -> 连接集合
}

// NewHub 创建连接管理中心
func NewHub() *Hub {
	return &Hub{
		clients: make(map[string]map[*Client]bool),
	}
}

// Add 新连接加入在线列表（多端共存，不踢旧连接）
// 原实现：重复登录时踢掉旧连接（单设备在线），现改为连接集合支持多设备
//
//	if old, ok := h.clients[c.username]; ok {
//		old.Close()
//	}
//
// h.clients[c.username] = c
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.clients[c.username]
	if !ok {
		set = make(map[*Client]bool)
		h.clients[c.username] = set
	}
	set[c] = true
	if len(set) > 1 {
		logger.Info("用户 %s 新设备接入，当前在线连接数 %d", c.username, len(set))
	}
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
	delete(set, c)
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

// Usernames 返回所有在线用户名（去重，任一连接在线即在线）
func (h *Hub) Usernames() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	names := make([]string, 0, h.connTotal())
	for name := range h.clients {
		names = append(names, name)
	}
	return names
}

// TotalConns 返回当前全部在线连接总数（阶段三十一：max_connections 上限校验使用）
// 原实现：config 的 MaxConnections 配置项从未被执行校验
func (h *Hub) TotalConns() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connTotal()
}

// connTotal 统计连接总数（调用方须已持有读锁）
func (h *Hub) connTotal() int {
	total := 0
	for _, set := range h.clients {
		total += len(set)
	}
	return total
}

// Broadcast 向所有在线客户端的全部连接广播消息
func (h *Hub) Broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, set := range h.clients {
		for c := range set {
			c.send(data)
		}
	}
}

// BroadcastExcept 向除指定用户外的所有在线客户端广播消息（该用户的全部设备均不接收）
func (h *Hub) BroadcastExcept(except string, data []byte) {
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
