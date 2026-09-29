package server

import (
	"encoding/json"
	"sync"
	"sync/atomic"
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
	// 阶段六十：登录设备类型（"pc"=Electron 桌面端，空=Web/手机）——Agent 本地执行器据此判定工具下发目标
	platform string
	// 阶段一百九十八：网盘 API 鉴权 token（登录签发，回执下发前端网盘请求头携带；连接断开即吊销）
	driveToken string
	// token 心跳续期节流时间戳（零值=从未续期，首次心跳立即续；仅内存比对，无锁——单连接读循环内串行访问）
	lastTokenTouch time.Time
	sendCh         chan []byte
	// 回归加固：连接写互斥锁——writePump（队列写）与 SendErrorAndClose（登录失败同步写）
	// 都可能写同一底层连接，gorilla/websocket 不允许并发写（会 panic 打崩进程），必须串行化
	writeMu sync.Mutex
	// 并发改造 C1 审计加固：连接关闭标记——读循环退出/主动关闭时置位，
	// 离线补发等长循环据此快速中止，避免对死连接逐条空等背压超时（大积压 × 3s/条的空转）
	closed atomic.Bool
	// 阶段二百二十一：连接建立时刻——未登录硬超时的锚点（readPump 中未登录连接的
	// ReadDeadline 恒定为 createdAt+pending_timeout，不随客户端发帧刷新，发帧不可续命）
	createdAt time.Time
}

// newClient 创建客户端连接对象
func newClient(s *Server, conn *websocket.Conn) *Client {
	// 原实现：sendCh: make(chan []byte, 256) 固定 256 缓冲，大文件分片与聊天消息混流时易溢出丢消息
	// 阶段三十一：缓冲大小改由配置 send_queue_size 下发（默认 1024）
	return &Client{
		server:    s,
		conn:      conn,
		sendCh:    make(chan []byte, s.cfg.SendQueueSize),
		createdAt: time.Now(),
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

// Close 关闭连接（置位 closed 标记 + 关底层连接）
func (c *Client) Close() {
	c.closed.Store(true)
	c.conn.Close()
}

// isClosed 连接是否已关闭（离线补发等长循环的中止判定）
func (c *Client) isClosed() bool {
	return c.closed.Load()
}

// SendErrorAndClose 同步发送错误消息后立即关闭连接：登录失败等需断开的场景使用
// 原实现：sendError 走 sendCh 队列异步写出 + Close 立即关闭连接，writePump 常来不及把错误消息写出
// 连接就已关闭，导致客户端登录失败时收不到任何提示（如"用户名或密码错误"），页面表现为无反应
// 此处绕过发送队列直接同步写连接，确保错误提示送达后再断开，与 HandleWS 连接数上限处的同步写错误模式保持一致；
// 写操作经 writeMu 与 writePump 串行化（异常客户端未登录先发非登录消息再发错误登录时，队列写与同步写可能并存）
func (c *Client) SendErrorAndClose(content string) {
	msg := protocol.Message{
		MsgType: protocol.MsgTypeError,
		Content: content,
		// 阶段二百二十一：断连型标记——前端收到 kick ERROR 立即终止自动重连。
		// 原实现仅靠前端 onclose 时 1 秒窗口判定（lastRejectAt），移动网络下连接关闭事件
		// 迟到超 1 秒即误判"网络断开"→ 3 秒自动重连 → 反踢新登录端 → 双方互踢循环
		Kick: true,
	}
	data, _ := json.Marshal(msg)
	c.writeMu.Lock()
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := c.conn.WriteMessage(websocket.TextMessage, data)
	c.writeMu.Unlock()
	if err != nil {
		logger.Warn("向客户端发送登录错误提示失败: %v", err)
	}
	c.Close()
}

// readPump 读循环：解析消息、处理心跳超时、分发
func (c *Client) readPump() {
	defer func() {
		// 阶段二百二十一：未登录连接计数递减（HandleWS 校验通过后 +1）
		c.server.pendingConns.Add(-1)
		c.server.unregister(c)
		c.Close()
	}()

	// 心跳超时：90s 未收到任何消息判定离线
	timeout := time.Duration(c.server.cfg.HeartbeatTimeout) * time.Second
	c.conn.SetReadLimit(4 << 20) // 单条消息最大 4MB（文件面板 readb 的 65 上行回传 base64 可达约 2.7MB，普通消息不受影响）

	for {
		// 阶段二百二十一：未登录连接硬超时——ReadDeadline 锚定连接建立时刻
		// （createdAt+pending_timeout 秒内必须完成登录），不随循环刷新；
		// 原实现每轮 SetReadDeadline(now+90s)，攻击者定时发垃圾帧即可给未登录连接
		// 无限续命长期占位（goroutine+内存），与重连风暴叠加放大资源耗尽
		if c.username == "" {
			c.conn.SetReadDeadline(c.createdAt.Add(time.Duration(c.server.cfg.PendingTimeout) * time.Second))
		} else {
			c.conn.SetReadDeadline(time.Now().Add(timeout))
		}
		var msg protocol.Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}

		// 未登录前只接受登录与注册消息（阶段一四五：注册收口独立注册页，
		// 注册页为未登录短连接，须放行 REGISTER 信令）
		// 原代码：if c.username == "" && msg.MsgType != protocol.MsgTypeLogin {
		if c.username == "" && msg.MsgType != protocol.MsgTypeLogin && msg.MsgType != protocol.MsgTypeRegister {
			c.server.sendError(c, "请先登录")
			continue
		}

		c.server.handleMessage(c, &msg)
	}
}

// writePump 写循环：将发送队列内容写回连接
// 回归加固：写操作经 writeMu 串行化，避免与 SendErrorAndClose 的同步写并发冲突
// packTextFrames 多帧拼接（RFC 6455 服务端帧：FIN=1、opcode=1(text)、服务端帧无掩码）
// 并发优化 E3：消息风暴下同一连接的积压帧合并为一次底层 Write——N 次写 syscall 合并为 1 次。
// TCP 字节流上连续完整帧与逐帧写在接收端语义完全一致（按帧边界流式解析）
func packTextFrames(frames [][]byte) []byte {
	total := 0
	for _, f := range frames {
		total += len(f) + 10 // 帧头最大 10 字节
	}
	buf := make([]byte, 0, total)
	for _, f := range frames {
		buf = append(buf, 0x81) // FIN=1 + opcode=1（text）
		n := len(f)
		switch {
		case n < 126:
			buf = append(buf, byte(n))
		case n <= 0xFFFF:
			buf = append(buf, 126, byte(n>>8), byte(n))
		default: // 消息为 KB 级，高 4 字节恒 0
			buf = append(buf, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
		}
		buf = append(buf, f...)
	}
	return buf
}

// wsSlowWrites 慢写累计计数（仪表盘观测，writePump >200ms 时 +1；持续增长=网卡/对端拥塞信号）
var wsSlowWrites atomic.Int64

func (c *Client) writePump() {
	for data := range c.sendCh {
		// 并发优化 E3：取首帧后非阻塞排干积压帧，多帧拼接一次底层 Write（N 次 syscall → 1 次）。
		// 单帧/空闲路径保持原 WriteMessage 不变，零额外开销；与 gorilla 默认 pong 回写（读协程
		// writeControl）的并发关系与原实现同级，本项目心跳为应用层 text 帧，WS 层 ping 场景实际不触发
		batch := append(make([][]byte, 0, 64), data)
	drain:
		for len(batch) < 64 {
			select {
			case d := <-c.sendCh:
				batch = append(batch, d)
			default:
				break drain
			}
		}
		wStart := time.Now()
		var err error
		c.writeMu.Lock()
		c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if len(batch) == 1 {
			err = c.conn.WriteMessage(websocket.TextMessage, batch[0])
		} else {
			_, err = c.conn.UnderlyingConn().Write(packTextFrames(batch))
		}
		c.writeMu.Unlock()
		if cost := time.Since(wStart); cost > 200*time.Millisecond {
			wsSlowWrites.Add(1) // 仪表盘观测：慢写累计（持续增长=网卡/对端拥塞信号）
			logger.Warn("慢写观测（用户 %s 写耗时 %v 合并 %d 帧）", c.username, cost, len(batch))
		}
		if err != nil {
			// 写失败即连接死亡：主动置位关闭标记并断开，加速读循环退出与离线补发等长循环中止
			c.Close()
			return
		}
	}
}
