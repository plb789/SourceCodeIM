package server

import (
	"time"

	"github.com/gorilla/websocket"

	"im-server/logger"
	"im-server/protocol"
)

// Client 单个客户端连接
type Client struct {
	server    *Server
	conn      *websocket.Conn
	username  string
	loginTime time.Time // 本次登录时间，用于好友申请去重
	sendCh    chan []byte
}

// newClient 创建客户端连接对象
func newClient(s *Server, conn *websocket.Conn) *Client {
	// 原实现：sendCh: make(chan []byte, 256) 固定 256 缓冲，大文件分片与聊天消息混流时易溢出丢消息
	// 阶段三十一：缓冲大小改由配置 send_queue_size 下发（默认 1024）
	return &Client{
		server: s,
		conn:   conn,
		sendCh: make(chan []byte, s.cfg.SendQueueSize),
	}
}

// send 非阻塞写入发送队列
// 原实现：队列满直接丢弃消息并告警，对文件分片等不可丢消息会造成接收方永远收不齐文件
// 阶段三十一：普通消息保持非阻塞丢弃语义（宁可丢一条聊天不可阻塞广播），文件分片改用 sendBlock
func (c *Client) send(data []byte) {
	select {
	case c.sendCh <- data:
	default:
		logger.Warn("客户端 %s 发送队列已满，丢弃消息", c.username)
	}
}

// sendBlock 阻塞写入发送队列（带超时）：文件分片中转等不可丢弃消息使用
// 阻塞语义天然形成背压：接收方消费不及时节流发送方读循环，超时返回 false 由调用方通知发送失败
func (c *Client) sendBlock(data []byte, timeout time.Duration) bool {
	select {
	case c.sendCh <- data:
		return true
	case <-time.After(timeout):
		logger.Warn("客户端 %s 发送队列已满且等待超时，丢弃文件分片", c.username)
		return false
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
