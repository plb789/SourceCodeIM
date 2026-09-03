package server

import (
	"sync"
)

// Hub 连接管理中心，维护在线客户端列表
type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client // username -> Client
}

// NewHub 创建连接管理中心
func NewHub() *Hub {
	return &Hub{
		clients: make(map[string]*Client),
	}
}

// Add 加入在线列表（重复登录时踢掉旧连接）
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old, ok := h.clients[c.username]; ok {
		old.Close()
	}
	h.clients[c.username] = c
}

// Remove 从在线列表移除
func (h *Hub) Remove(username string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, username)
}

// Get 获取指定用户的连接
func (h *Hub) Get(username string) (*Client, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.clients[username]
	return c, ok
}

// Usernames 返回所有在线用户名
func (h *Hub) Usernames() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	names := make([]string, 0, len(h.clients))
	for name := range h.clients {
		names = append(names, name)
	}
	return names
}

// Broadcast 向所有在线客户端广播消息
func (h *Hub) Broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		c.send(data)
	}
}

// BroadcastExcept 向除指定用户外的所有在线客户端广播消息
func (h *Hub) BroadcastExcept(except string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for name, c := range h.clients {
		if name != except {
			c.send(data)
		}
	}
}
