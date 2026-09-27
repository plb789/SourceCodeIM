package server

// 阶段一百六十一：登录排队器单测（纯内存逻辑，不依赖 MySQL/Redis）
// 覆盖：开关旁路 / 令牌直接放行 / FIFO 排队与 94 位置帧 / 放行顺序 / 队列满拒绝 / 超时拒绝 / 排队中断开清理
// 说明：admit 是"准入+排队等待"一体的阻塞调用，所有 admit 一律经协程发起

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"im-server/config"
	"im-server/protocol"
)

// newQueueTestConn 起 httptest WS 服务，返回服务端侧连接（挂到 Client 供 SendErrorAndClose 同步写）与客户端侧连接
func newQueueTestConn(t *testing.T) (srvConn *websocket.Conn, cliConn *websocket.Conn, cleanup func()) {
	t.Helper()
	up := websocket.Upgrader{}
	upgraded := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		srvConn = c
		close(upgraded)
		for { // 保活读循环：客户端关闭后自然退出
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	cli, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		srv.Close()
		t.Fatalf("ws dial: %v", err)
	}
	select {
	case <-upgraded:
	case <-time.After(3 * time.Second):
		t.Fatal("ws upgrade 超时")
	}
	return srvConn, cli, func() {
		cli.Close()
		srv.Close()
	}
}

// newQueueTestClient 构造仅内存可见的最小 Client：sendCh 即出站箱（测试直接读），conn 供同步写错误帧
func newQueueTestClient(name string, srvConn *websocket.Conn) *Client {
	return &Client{
		conn:     srvConn,
		username: name,
		sendCh:   make(chan []byte, 64),
	}
}

// readQueueFrame 从出站箱读一帧 94 位置帧并解析位次
func readQueueFrame(t *testing.T, c *Client) int {
	t.Helper()
	select {
	case data := <-c.sendCh:
		var m protocol.Message
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("出站帧解析失败: %v", err)
		}
		if m.MsgType != protocol.MsgTypeLoginQueue {
			t.Fatalf("帧类型 = %d, 期望 94", m.MsgType)
		}
		var info struct {
			Position int `json:"position"`
			Wait     int `json:"wait"`
		}
		if err := json.Unmarshal([]byte(m.Content), &info); err != nil {
			t.Fatalf("94 帧解析失败: %v", err)
		}
		return info.Position
	case <-time.After(4 * time.Second): // 周期帧 3s 一帧，读帧超时须覆盖一个周期
		t.Fatal("等待 94 位置帧超时")
	}
	return 0
}

// readErrorText 从客户端侧连接同步读服务端 SendErrorAndClose 下发的错误帧
func readErrorText(t *testing.T, cliConn *websocket.Conn) string {
	t.Helper()
	cliConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var m protocol.Message
	if err := cliConn.ReadJSON(&m); err != nil {
		t.Fatalf("读错误帧失败: %v", err)
	}
	if m.MsgType != protocol.MsgTypeError {
		t.Fatalf("帧类型 = %d, 期望 9(ERROR)", m.MsgType)
	}
	return m.Content
}

// U1：开关关闭完全旁路——admit 直接放行且零副作用
func TestLoginQueueDisabled(t *testing.T) {
	q := newLoginQueue(config.LoginQueueConfig{}) // Enabled 缺省 false
	if !q.admit(newQueueTestClient("u1", nil), "u1") {
		t.Fatal("开关关闭时应直接放行")
	}
	if len(q.queue) != 0 {
		t.Fatal("开关关闭时不应有入队行为")
	}
}

// U2：令牌直接放行（无 94 帧）+ FIFO 排队 + 首帧位次 + 放行顺序先到先得
func TestLoginQueueFIFO(t *testing.T) {
	srvConn, _, cleanup := newQueueTestConn(t)
	defer cleanup()
	q := newLoginQueue(config.LoginQueueConfig{Enabled: true, Rate: 2, MaxLen: 4, Timeout: 5})
	q.start()

	// 错峰发起 4 个准入：u1/u2 吃掉 2 个令牌直接放行，u3/u4 入队（basePos 1、2）
	clients := map[string]*Client{}
	type res struct {
		name string
		ok   bool
		at   time.Time
	}
	results := make(chan res, 4)
	for _, name := range []string{"u1", "u2", "u3", "u4"} {
		c := newQueueTestClient(name, srvConn)
		clients[name] = c
		go func(n string) {
			ok := q.admit(c, n)
			results <- res{n, ok, time.Now()}
		}(name)
		time.Sleep(60 * time.Millisecond)
	}
	// u3/u4 已入队：先断言首帧位次
	if p := readQueueFrame(t, clients["u3"]); p != 1 {
		t.Fatalf("u3 首帧位次 = %d, 期望 1", p)
	}
	if p := readQueueFrame(t, clients["u4"]); p != 2 {
		t.Fatalf("u4 首帧位次 = %d, 期望 2", p)
	}
	// 收齐 4 个准入结果（Rate=2 下排队者最迟 ~2s 放行）
	got := map[string]res{}
	deadline := time.After(5 * time.Second)
	for len(got) < 4 {
		select {
		case r := <-results:
			got[r.name] = r
		case <-deadline:
			t.Fatalf("准入未全部返回：已返回 %v", got)
		}
	}
	for _, name := range []string{"u1", "u2", "u3", "u4"} {
		if !got[name].ok {
			t.Fatalf("用户 %s 被拒绝（MaxLen=4 不应拒绝）", name)
		}
	}
	// FIFO：u3 放行时刻必须早于 u4（令牌按入队顺序从队首分发）
	if !got["u3"].at.Before(got["u4"].at) {
		t.Fatalf("FIFO 顺序破坏：u3 放行 %v 不早于 u4 放行 %v", got["u3"].at, got["u4"].at)
	}
}

// U3：队列满直接拒绝——3 放行（1 令牌 + 2 队列）+ 1 同步错误帧"当前登录人数较多"
func TestLoginQueueFull(t *testing.T) {
	srvConn, cliConn, cleanup := newQueueTestConn(t)
	defer cleanup()
	q := newLoginQueue(config.LoginQueueConfig{Enabled: true, Rate: 1, MaxLen: 2, Timeout: 10})
	q.start()

	// 错峰发起：u1 直接放行，u2/u3 入队，u4 队列满被拒（拒绝是同步的，错误帧写共享 srvConn）
	type res struct {
		name string
		ok   bool
	}
	results := make(chan res, 4)
	for _, name := range []string{"u1", "u2", "u3", "u4"} {
		go func(n string) {
			results <- res{n, q.admit(newQueueTestClient(n, srvConn), n)}
		}(name)
		time.Sleep(60 * time.Millisecond)
	}
	// u4 满拒后其错误帧已同步写 srvConn（先于排队者放行——Rate=1 放行要 1s，拒绝即时）
	if txt := readErrorText(t, cliConn); !strings.Contains(txt, "当前登录人数较多") {
		t.Fatalf("队列满错误文本 = %q, 期望包含\"当前登录人数较多\"", txt)
	}
	got := map[string]bool{}
	deadline := time.After(6 * time.Second)
	for len(got) < 4 {
		select {
		case r := <-results:
			got[r.name] = r.ok
		case <-deadline:
			t.Fatalf("准入未全部返回：已返回 %v", got)
		}
	}
	for _, name := range []string{"u1", "u2", "u3"} {
		if !got[name] {
			t.Fatalf("用户 %s 不应被拒绝", name)
		}
	}
	if got["u4"] {
		t.Fatal("队列满时 u4 应被拒绝")
	}
}

// U4：排队超时拒绝——同步错误帧"登录排队超时"，且不放行
func TestLoginQueueTimeout(t *testing.T) {
	srvConn, cliConn, cleanup := newQueueTestConn(t)
	defer cleanup()
	q := newLoginQueue(config.LoginQueueConfig{Enabled: true, Rate: 1, MaxLen: 8, Timeout: 1})
	q.timeout = 300 * time.Millisecond // 覆盖为 300ms 便于快测
	q.start()

	if !q.admit(newQueueTestClient("u1", srvConn), "u1") { // 吃唯一令牌直接放行
		t.Fatal("首用户应直接放行")
	}
	c2 := newQueueTestClient("u2", srvConn)
	done := make(chan bool, 1)
	go func() { done <- q.admit(c2, "u2") }()
	if p := readQueueFrame(t, c2); p != 1 {
		t.Fatalf("排队首帧位次 = %d, 期望 1", p)
	}
	select {
	case ok := <-done:
		if ok {
			t.Fatal("超时后应拒绝")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("超时拒绝未按时返回")
	}
	if txt := readErrorText(t, cliConn); !strings.Contains(txt, "登录排队超时") {
		t.Fatalf("错误文本 = %q, 期望包含\"登录排队超时\"", txt)
	}
	select { // 拒绝后不应再放出站帧
	case data := <-c2.sendCh:
		t.Fatalf("超时拒绝后仍残留出站帧: %s", data)
	default:
	}
}

// U5：位次推算正确性——放行一人后，剩余排队者周期帧位次应前移（O(1) 公式端到端验证）
// 本用例不启动放行泵（q.start 不调用），改手动 release 驱动，避免泵放行与周期帧竞争
func TestLoginQueuePositionShift(t *testing.T) {
	srvConn, _, cleanup := newQueueTestConn(t)
	defer cleanup()
	q := newLoginQueue(config.LoginQueueConfig{Enabled: true, Rate: 1, MaxLen: 8, Timeout: 10})

	if !q.admit(newQueueTestClient("u1", srvConn), "u1") {
		t.Fatal("首用户应直接放行")
	}
	cA := newQueueTestClient("uA", srvConn)
	cB := newQueueTestClient("uB", srvConn)
	chA := make(chan bool, 1)
	chB := make(chan bool, 1)
	go func() { chA <- q.admit(cA, "uA") }()
	time.Sleep(60 * time.Millisecond)
	go func() { chB <- q.admit(cB, "uB") }()
	if p := readQueueFrame(t, cA); p != 1 {
		t.Fatalf("uA 首帧位次 = %d, 期望 1", p)
	}
	if p := readQueueFrame(t, cB); p != 2 {
		t.Fatalf("uB 首帧位次 = %d, 期望 2", p)
	}
	// 手动投 1 令牌并触发放行：uA 出队放行
	q.mu.Lock()
	q.tokens = 1
	q.mu.Unlock()
	q.release(time.Now())
	if ok := <-chA; !ok {
		t.Fatal("uA 应被放行")
	}
	// uB 的 3s 周期帧位次应为 1（basePos 2 - processed 差 1；无泵不会自动放行 uB）
	waitPos(t, cB, 1, 3)
	// 再投 1 令牌放行 uB 收尾
	q.mu.Lock()
	q.tokens = 1
	q.mu.Unlock()
	q.release(time.Now())
	if ok := <-chB; !ok {
		t.Fatal("uB 应被放行")
	}
}

// waitPos 等待目标位次帧（周期帧每 3s 一帧，最多等 frames 帧）
func waitPos(t *testing.T, c *Client, want int, frames int) {
	t.Helper()
	for i := 0; i < frames; i++ {
		if p := readQueueFrame(t, c); p == want {
			return
		}
	}
	t.Fatalf("未等到位次 %d 的 94 帧", want)
}

// U6：排队中断开清理——连接关闭后 wait 短期退出；放行泵跳过已终止者不耗令牌
// 本用例不启动放行泵，断开检测由 wait 的 3s 周期帧触发（isClosed 检查）
func TestLoginQueueDisconnect(t *testing.T) {
	srvConn, _, cleanup := newQueueTestConn(t)
	defer cleanup()
	q := newLoginQueue(config.LoginQueueConfig{Enabled: true, Rate: 1, MaxLen: 8, Timeout: 30})

	if !q.admit(newQueueTestClient("u1", srvConn), "u1") {
		t.Fatal("首用户应直接放行")
	}
	cA := newQueueTestClient("uA", srvConn)
	done := make(chan bool, 1)
	go func() { done <- q.admit(cA, "uA") }()
	readQueueFrame(t, cA) // 确认入队
	// 模拟断开：置位关闭标记（与 writePump 写失败/SendErrorAndClose 同一置位点）
	cA.Close()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("断开后应终止排队")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("断开检测超时（3s 周期帧应发现 isClosed）")
	}
	// 断开者应被放行泵跳过且不耗令牌：投 1 令牌触发 release，令牌不应减少
	q.mu.Lock()
	q.tokens = 1
	q.mu.Unlock()
	q.release(time.Now())
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.tokens != 1 {
		t.Fatalf("跳过已断开者不应耗令牌，tokens = %v", q.tokens)
	}
}
