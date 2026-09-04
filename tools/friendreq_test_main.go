// 临时测试：阶段二十八好友申请全链路验证（验证完可删除）
// 覆盖：在线实时推送 / 申请列表归口(pending数量) / 同意后申请方收到同步 / 登录补发
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// Msg 测试用消息结构
type Msg struct {
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
	MsgID    uint   `json:"msg_id"`
}

// ConnWrapper 包装连接：后台 goroutine 持续读取消息到 channel
type ConnWrapper struct {
	Name string
	Conn *websocket.Conn
	Ch   chan *Msg
}

func dialUser(name string) *ConnWrapper {
	u := url.URL{Scheme: "ws", Host: "127.0.0.1:8888", Path: "/ws"}
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		panic(fmt.Sprintf("%s 连接失败: %v", name, err))
	}
	w := &ConnWrapper{Name: name, Conn: c, Ch: make(chan *Msg, 200)}
	go func() {
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				close(w.Ch)
				return
			}
			var m Msg
			json.Unmarshal(data, &m)
			w.Ch <- &m
		}
	}()
	login := Msg{MsgType: 7, FromUser: name, Content: "pass123"}
	data, _ := json.Marshal(login)
	c.WriteMessage(websocket.TextMessage, data)
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

func main() {
	var pass, fail int
	check := func(name string, ok bool) {
		if ok {
			pass++
			fmt.Println("[通过] " + name)
		} else {
			fail++
			fmt.Println("[失败] " + name)
		}
	}

	// 准备：接收方 T28B 先上线清掉积压推送
	b := dialUser("T28B")
	b.drain(1*time.Second, nil)
	a := dialUser("T28A")
	a.drain(1*time.Second, nil)

	// 1. 双方在线：实时推送
	a.send(Msg{MsgType: 20, FromUser: "T28A", ToUser: "T28B", Content: "测试申请1"})
	m := b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 20 && m.FromUser == "T28A" })
	check("在线实时收到好友申请推送", m != nil)

	// 2. 接收方拉取申请列表：应含待处理申请且 pending>=1
	b.send(Msg{MsgType: 35, FromUser: "T28B"})
	ml := b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 36 })
	ok := false
	pending := 0
	if ml != nil {
		var resp struct {
			List    []map[string]interface{} `json:"list"`
			Pending int                      `json:"pending"`
		}
		if err := json.Unmarshal([]byte(ml.Content), &resp); err == nil {
			pending = resp.Pending
			for _, it := range resp.List {
				if it["from_user"] == "T28A" && int(it["status"].(float64)) == 0 {
					ok = true
				}
			}
		}
	}
	check(fmt.Sprintf("申请列表归口返回待处理记录(pending=%d)", pending), ok && pending >= 1)

	// 3. 接收方同意：申请方应收到 FRIEND_REQUEST_RESP 同步提示
	b.send(Msg{MsgType: 21, FromUser: "T28B", ToUser: "T28A", Content: "agree"})
	mr := a.drain(3*time.Second, func(m *Msg) bool {
		return m.MsgType == 21 && m.FromUser == "T28B" && m.Content == "agree"
	})
	check("同意后申请方实时收到同意同步", mr != nil)

	// 4. 同意后列表 pending 应减少
	b.send(Msg{MsgType: 35, FromUser: "T28B"})
	ml2 := b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 36 })
	pending2 := -1
	if ml2 != nil {
		var resp struct {
			Pending int `json:"pending"`
		}
		json.Unmarshal([]byte(ml2.Content), &resp)
		pending2 = resp.Pending
	}
	check(fmt.Sprintf("同意后待处理数量递减(pending=%d)", pending2), pending2 == pending-1)

	// 5. 离线补发：使用独立新账号对（避免与步骤3已结为好友的账号冲突被 isFriend 拦截）
	// T28D 先上线后离线，T28C 发申请，T28D 重登应补发
	d := dialUser("T28D")
	d.drain(1*time.Second, nil)
	d.Conn.Close()
	time.Sleep(400 * time.Millisecond)
	c2 := dialUser("T28C")
	c2.drain(1*time.Second, nil)
	c2.send(Msg{MsgType: 20, FromUser: "T28C", ToUser: "T28D", Content: "离线申请"})
	time.Sleep(400 * time.Millisecond)
	d2 := dialUser("T28D")
	m3 := d2.drain(3*time.Second, func(m *Msg) bool {
		return m.MsgType == 20 && m.FromUser == "T28C" && strings.Contains(m.Content, "离线申请")
	})
	check("离线申请登录补发", m3 != nil)
	d2.Conn.Close()
	c2.Conn.Close()

	fmt.Printf("测试完成：通过 %d 项，失败 %d 项\n", pass, fail)
}
