package server

import (
	"time"

	"github.com/gorilla/websocket"

	"im-server/logger"
	"im-server/protocol"
)

// Client 单个客户端连接
type Client struct {
	server   *Server
	conn     *websocket.Conn
	username string
	sendCh   chan []byte
}

// newClient 创建客户端连接对象
func newClient(s *Server, conn *websocket.Conn) *Client {
	return &Client{
		server: s,
		conn:   conn,
		sendCh: make(chan []byte, 256),
	}
}

// send 非阻塞写入发送队列
func (c *Client) send(data []byte) {
	select {
	case c.sendCh <- data:
	default:
		logger.Warn("客户端 %s 发送队列已满，丢弃消息", c.username)
	}
}

// Close 关闭连接
func (c *Client) Close() {
	c.conn.Close()
}

// readPump 读循环：解析消息、处理心跳超时、分发
func (c *Client) readPump() {
	defer func() {
		c.server.unregister(c)
		c.conn.Close()
	}()

	// 心跳超时：90s 未收到任何消息判定离线
	timeout := time.Duration(c.server.cfg.HeartbeatTimeout) * time.Second
	c.conn.SetReadLimit(1 << 20) // 单条消息最大 1MB

	for {
		c.conn.SetReadDeadline(time.Now().Add(timeout))
		var msg protocol.Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}

		// 未登录前只接受登录消息
		if c.username == "" && msg.MsgType != protocol.MsgTypeLogin {
			c.server.sendError(c, "请先登录")
			continue
		}

		c.server.handleMessage(c, &msg)
	}
}

// writePump 写循环：将发送队列内容写回连接
func (c *Client) writePump() {
	for data := range c.sendCh {
		c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return
		}
	}
}
