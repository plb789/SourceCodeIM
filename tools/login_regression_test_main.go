// 临时测试：阶段三十四登录链路回归验证（验证完可删除）
// 覆盖：正常登录响应 / 错误密码提示送达 / 异常时序并发写加固（未登录先发非登录消息再发错误登录，服务端不崩溃）
//
//	/ 全新用户自动注册 / 空密码注册拒绝 / 多设备同账号同时在线 / 断线重连重新登录
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

// Msg 测试用消息结构
type Msg struct {
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
}

// ConnWrapper 包装连接：后台 goroutine 持续读取消息到 channel
type ConnWrapper struct {
	Name  string
	Conn  *websocket.Conn
	Ch    chan *Msg
	Debug []string // 调试：记录收到的每条消息概要（msg_type+content前50字符）
}

func dialRaw(name string) *ConnWrapper {
	u := url.URL{Scheme: "ws", Host: "127.0.0.1:8888", Path: "/ws"}
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		panic(fmt.Sprintf("%s 连接失败: %v", name, err))
	}
	w := &ConnWrapper{Name: name, Conn: c, Ch: make(chan *Msg, 300)}
	go func() {
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				close(w.Ch)
				return
			}
			var m Msg
			if err := json.Unmarshal(data, &m); err != nil {
				w.Debug = append(w.Debug, fmt.Sprintf("UNMARSHAL_ERR raw=%q", string(data[:min(len(data), 80)])))
			} else {
				head := m.Content
				if len(head) > 50 {
					head = head[:50]
				}
				w.Debug = append(w.Debug, fmt.Sprintf("type=%d from=%q content=%q", m.MsgType, m.FromUser, head))
			}
			w.Ch <- &m
		}
	}()
	return w
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// dialLogin 连接并使用指定账号密码登录，返回包装连接
func dialLogin(name, password string) *ConnWrapper {
	w := dialRaw(name)
	w.send(Msg{MsgType: 7, FromUser: name, Content: password})
	return w
}

// drain 在时限内等待匹配的消息，返回 nil 表示超时
func (w *ConnWrapper) drain(d time.Duration, match func(*Msg) bool) *Msg {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case m, ok := <-w.Ch:
			if !ok {
				return nil
			}
			if match == nil || match(m) {
				return m
			}
		case <-timer.C:
			return nil
		}
	}
}

// send 发送一条消息
func (w *ConnWrapper) send(m Msg) {
	data, _ := json.Marshal(m)
	w.Conn.WriteMessage(websocket.TextMessage, data)
}

// close 关闭底层连接（模拟断线）
func (w *ConnWrapper) close() {
	w.Conn.Close()
}

// passFail 断言输出
var failed int

// isLoginOk 判断 LOGIN_RESP 是否登录成功：content 为 JSON（result=ok + recall_window/profile/avatar 等配置）
// 原探针断言误写为 content=="ok" 纯字符串，与服务端 JSON 格式不符
func isLoginOk(resp *Msg) bool {
	if resp == nil {
		return false
	}
	if resp.Content == "ok" {
		return true // 兼容旧版服务端纯字符串格式
	}
	var info struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal([]byte(resp.Content), &info); err != nil {
		return false
	}
	return info.Result == "ok"
}

func passFail(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("✅ %s %s\n", name, detail)
	} else {
		failed++
		fmt.Printf("❌ %s %s\n", name, detail)
	}
}

// dumpDebug 调试输出连接收到的全部消息概要
func dumpDebug(tag string, w *ConnWrapper) {
	fmt.Printf("   [调试] %s 收到 %d 条消息:\n", tag, len(w.Debug))
	for _, d := range w.Debug {
		fmt.Printf("     - %s\n", d)
	}
}

func main() {
	stamp := time.Now().Unix()

	// ===== 1. 正常登录：新用户名+非空密码，LOGIN_RESP JSON result=ok =====
	u1 := fmt.Sprintf("loginreg%d", stamp)
	w := dialLogin(u1, "pass123")
	resp := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	okLogin := isLoginOk(resp)
	passFail("1.正常登录", okLogin, "LOGIN_RESP ok")
	if !okLogin {
		dumpDebug("第1项", w)
	}
	w.close()

	// 重新连接登录（供多设备验证使用）
	wa := dialLogin(u1, "pass123")
	respA := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("2.已注册账号重新登录", isLoginOk(respA), "LOGIN_RESP ok")
	if !isLoginOk(respA) {
		dumpDebug("第2项", wa)
	}

	// ===== 3. 错误密码：已存在账号+错误密码，ERROR 送达后连接被服务端关闭 =====
	wb := dialRaw(u1)
	wb.send(Msg{MsgType: 7, FromUser: u1, Content: "wrongpass"})
	errMsg := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	okErrText := errMsg != nil && errMsg.Content == "用户名或密码错误"
	passFail("3.错误密码提示送达", okErrText, fmt.Sprintf("收到 ERROR=%q", func() string {
		if errMsg != nil {
			return errMsg.Content
		}
		return "<超时未收到>"
	}()))
	// 错误提示后连接应被服务端关闭（channel close 表示读循环退出）
	closed := wb.drain(2*time.Second, nil) == nil
	passFail("4.错误密码后服务端关闭连接", closed, "连接已断开")

	// ===== 5. 异常时序并发写加固：未登录先发非登录消息（触发队列写"请先登录"），
	// 紧接着发错误密码登录（触发同步写错误+关连接），两路写并存服务端不得崩溃 =====
	wc := dialRaw(u1)
	wc.send(Msg{MsgType: 4, Content: "ping"})                    // 未登录心跳：服务端 sendError"请先登录"进队列
	wc.send(Msg{MsgType: 7, FromUser: u1, Content: "wrongpass"}) // 紧跟错误登录：同步写+关连接
	anyErr := wc.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	passFail("5.异常时序收到错误提示", anyErr != nil, "ERROR 送达（请先登录/用户名或密码错误任一）")
	wc.drain(1*time.Second, nil) // 等连接收尾

	// 异常时序后服务端必须仍健康：新连接登录成功
	wd := dialLogin(u1, "pass123")
	respD := wd.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("6.异常时序后服务端仍健康", isLoginOk(respD), "新连接 LOGIN_RESP ok")
	if !isLoginOk(respD) {
		dumpDebug("第6项", wd)
	}

	// ===== 7. 全新用户自动注册回归 =====
	u2 := fmt.Sprintf("loginregnew%d", stamp)
	we := dialLogin(u2, "pass123")
	respE := we.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("7.首次登录自动注册", isLoginOk(respE), "自动注册后 LOGIN_RESP ok")
	if !isLoginOk(respE) {
		dumpDebug("第7项", we)
	}

	// ===== 8. 空密码注册拒绝（服务端归口校验仍有效） =====
	wf := dialRaw(fmt.Sprintf("loginregempty%d", stamp))
	wf.send(Msg{MsgType: 7, FromUser: fmt.Sprintf("loginregempty%d", stamp), Content: ""})
	errMsg8 := wf.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	passFail("8.空密码注册拒绝", errMsg8 != nil && errMsg8.Content == "密码不能为空", fmt.Sprintf("收到 ERROR=%q", func() string {
		if errMsg8 != nil {
			return errMsg8.Content
		}
		return "<超时未收到>"
	}()))

	// ===== 9. 多设备同账号同时在线（不互踢）：第二个连接登录成功，双方均在线 =====
	wg := dialLogin(u1, "pass123")
	respG := wg.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("9.同账号第二设备登录", isLoginOk(respG), "多设备共存不踢号")
	// 第一设备发送私聊，第二设备应能收到（多端定向推送双份）
	wa.send(Msg{MsgType: 2, FromUser: u1, ToUser: u1, Content: "多端同步测试"})
	gotSelf := wg.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 2 && m.Content == "多端同步测试" })
	gotSelfA := wa.drain(1*time.Second, func(m *Msg) bool { return m.MsgType == 2 && m.Content == "多端同步测试" })
	passFail("10.同账号多端消息双份同步", gotSelf != nil && gotSelfA != nil, "两台设备均收到私聊")

	// ===== 11. 断线重连模拟：登录成功后关闭连接，重连携带同密码重新登录成功 =====
	wg.close()
	time.Sleep(300 * time.Millisecond)
	wh := dialLogin(u1, "pass123")
	respH := wh.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("11.断线后携带密码重连", isLoginOk(respH), "重新登录成功")

	// 收尾清理连接
	wa.close()
	wd.close()
	we.close()
	wh.close()

	fmt.Println("----------------------------------------")
	if failed > 0 {
		fmt.Printf("❌ 回归失败：%d 项未通过\n", failed)
		return
	}
	fmt.Println("✅ 全部回归通过")
}
