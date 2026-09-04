// 临时测试：阶段三十四登录修复全功能冒烟回归（验证完可删除）
// 覆盖：在线状态广播 / 用户列表同步 / 群聊广播 / 私聊msg_id回填 / 已读回执 / 输入状态 /
//
//	撤回双端同步 / 撤回幂等 / 越权撤回拒绝 / 会话列表联动 / 消息搜索
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

// Msg 测试用消息结构（对应 protocol.Message 子集）
type Msg struct {
	MsgType   int    `json:"msg_type"`
	FromUser  string `json:"from_user"`
	ToUser    string `json:"to_user"`
	Content   string `json:"content"`
	MsgID     uint   `json:"msg_id"`
	Page      int    `json:"page"`
	PageSize  int    `json:"page_size"`
	Timestamp int64  `json:"timestamp"`
}

// ConnWrapper 包装连接：后台 goroutine 持续读取消息到 channel
type ConnWrapper struct {
	Name  string
	Conn  *websocket.Conn
	Ch    chan *Msg
	Debug []string
}

func dialRaw(name string) *ConnWrapper {
	u := url.URL{Scheme: "ws", Host: "127.0.0.1:8888", Path: "/ws"}
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		panic(fmt.Sprintf("%s 连接失败: %v", name, err))
	}
	w := &ConnWrapper{Name: name, Conn: c, Ch: make(chan *Msg, 500)}
	go func() {
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				close(w.Ch)
				return
			}
			var m Msg
			if err := json.Unmarshal(data, &m); err == nil {
				head := m.Content
				if len(head) > 40 {
					head = head[:40]
				}
				w.Debug = append(w.Debug, fmt.Sprintf("type=%d from=%q to=%q msgID=%d content=%q", m.MsgType, m.FromUser, m.ToUser, m.MsgID, head))
			}
			w.Ch <- &m
		}
	}()
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

func (w *ConnWrapper) close() {
	w.Conn.Close()
}

var failed int

func passFail(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("✅ %s %s\n", name, detail)
	} else {
		failed++
		fmt.Printf("❌ %s %s\n", name, detail)
	}
}

func main() {
	stamp := time.Now().Unix()
	ua, ub, uc := fmt.Sprintf("smokea%d", stamp), fmt.Sprintf("smokeb%d", stamp), fmt.Sprintf("smokec%d", stamp)

	// ===== A 先登录 =====
	wa := dialRaw(ua)
	wa.send(Msg{MsgType: 7, FromUser: ua, Content: "pass123"})
	loginA := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	var okLogin bool
	if loginA != nil && loginA.Content == "ok" {
		okLogin = true
	} else if loginA != nil {
		var info struct {
			Result string `json:"result"`
		}
		if json.Unmarshal([]byte(loginA.Content), &info) == nil && info.Result == "ok" {
			okLogin = true
		}
	}
	passFail("1.A登录", okLogin, "LOGIN_RESP ok")
	// 登录成功后应收到用户列表同步（type=6）
	gotUserList := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 6 })
	passFail("2.登录后用户列表同步", gotUserList != nil, "USER_LIST 推送")

	// ===== B 登录：A 应收到 B 的上线通知（type=5） =====
	wb := dialRaw(ub)
	wb.send(Msg{MsgType: 7, FromUser: ub, Content: "pass123"})
	loginB := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	okLoginB := loginB != nil && (loginB.Content == "ok" || func() bool {
		var info struct {
			Result string `json:"result"`
		}
		return json.Unmarshal([]byte(loginB.Content), &info) == nil && info.Result == "ok"
	}())
	passFail("3.B登录", okLoginB, "LOGIN_RESP ok")
	onlineA := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 5 && m.FromUser == ub })
	passFail("4.上线状态实时广播", onlineA != nil, fmt.Sprintf("A 收到 %s 上线通知", ub))

	// ===== C 登录（供群聊验证） =====
	wc := dialRaw(uc)
	wc.send(Msg{MsgType: 7, FromUser: uc, Content: "pass123"})
	wc.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })

	// ===== 私聊：A→B，双端消息 MsgID 一致（服务端持久化回填） =====
	wa.send(Msg{MsgType: 2, FromUser: ua, ToUser: ub, Content: "冒烟私聊消息", Timestamp: time.Now().Unix()})
	pa := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 2 && m.Content == "冒烟私聊消息" })
	pb := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 2 && m.Content == "冒烟私聊消息" })
	okPrivate := pa != nil && pb != nil && pa.MsgID != 0 && pa.MsgID == pb.MsgID
	passFail("5.私聊双端送达且MsgID回填一致", okPrivate, fmt.Sprintf("发送端MsgID=%d 接收端MsgID=%d", func() uint {
		if pa != nil {
			return pa.MsgID
		}
		return 0
	}(), func() uint {
		if pb != nil {
			return pb.MsgID
		}
		return 0
	}()))
	msgID := uint(0)
	if pb != nil {
		msgID = pb.MsgID
	}

	// ===== 已读回执：B→A（type=13，content 为已读到的最大消息 ID 字符串，服务端归口） =====
	wb.send(Msg{MsgType: 13, FromUser: ub, ToUser: ua, Content: strconv.FormatUint(uint64(msgID), 10)})
	readA := wa.drain(3*time.Second, func(m *Msg) bool {
		return m.MsgType == 13 && m.Content == strconv.FormatUint(uint64(msgID), 10)
	})
	passFail("6.已读回执送达", readA != nil, fmt.Sprintf("A 收到已读水位=%s", strconv.FormatUint(uint64(msgID), 10)))

	// ===== 输入状态：A→B（type=12） =====
	wa.send(Msg{MsgType: 12, FromUser: ua, ToUser: ub, Content: "typing"})
	typingB := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 12 && m.FromUser == ua })
	passFail("7.输入状态提示送达", typingB != nil, "B 收到 A 正在输入")

	// ===== 群聊广播：A 发群消息，B 与 C 都应收到（type=1，to_user 为空） =====
	wa.send(Msg{MsgType: 1, FromUser: ua, Content: "冒烟群聊广播", Timestamp: time.Now().Unix()})
	gb := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 1 && m.Content == "冒烟群聊广播" })
	gc := wc.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 1 && m.Content == "冒烟群聊广播" })
	passFail("8.群聊广播全员送达", gb != nil && gc != nil, fmt.Sprintf("B收=%v C收=%v", gb != nil, gc != nil))

	// ===== 消息搜索：A 搜索关键词（type=16→17） =====
	wa.send(Msg{MsgType: 16, FromUser: ua, Content: "冒烟私聊"})
	searchA := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 17 })
	passFail("9.消息搜索响应", searchA != nil, "SEARCH_RESP 送达")

	// ===== 越权撤回拒绝：B 试图撤回 A 的消息 =====
	wb.send(Msg{MsgType: 14, FromUser: ub, MsgID: msgID})
	denyB := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	okDeny := denyB != nil && denyB.Content == "只能撤回自己发送的消息"
	passFail("10.越权撤回拒绝", okDeny, fmt.Sprintf("ERROR=%q", func() string {
		if denyB != nil {
			return denyB.Content
		}
		return "<超时未收到>"
	}()))

	// ===== 正常撤回：A 撤回自己的私聊消息，双端同步 + 会话列表联动 =====
	// 撤回时服务端先推 CONV_LIST(18) 再推撤回通知(14)，drain 途中同步捕获 18 防止被丢弃
	wa.send(Msg{MsgType: 14, FromUser: ua, MsgID: msgID})
	sawConvA := false
	sawConvB := false
	recallB := wb.drain(3*time.Second, func(m *Msg) bool {
		if m.MsgType == 18 {
			sawConvB = true
			return false
		}
		return m.MsgType == 14 && m.MsgID == msgID
	})
	recallA := wa.drain(3*time.Second, func(m *Msg) bool {
		if m.MsgType == 18 {
			sawConvA = true
			return false
		}
		return m.MsgType == 14 && m.MsgID == msgID
	})
	passFail("11.撤回双端同步", recallB != nil && recallA != nil, fmt.Sprintf("B收=%v A回显=%v", recallB != nil, recallA != nil))
	passFail("12.撤回后会话列表联动", sawConvA && sawConvB, "双方收到 CONV_LIST 同步")

	// ===== 撤回幂等：A 再次撤回同一消息被拒绝 =====
	wa.send(Msg{MsgType: 14, FromUser: ua, MsgID: msgID})
	dupA := wa.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	okDup := dupA != nil && dupA.Content == "该消息已撤回，请勿重复操作"
	passFail("13.撤回幂等拒绝", okDup, fmt.Sprintf("ERROR=%q", func() string {
		if dupA != nil {
			return dupA.Content
		}
		return "<超时未收到>"
	}()))

	// ===== 历史记录：B 请求与 A 的历史（type=10→11），撤回消息仍在列表 =====
	wb.send(Msg{MsgType: 10, FromUser: ub, ToUser: ua, Page: 1, PageSize: 20})
	histB := wb.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 11 })
	okHist := histB != nil && func() bool {
		var items []struct {
			ID       uint   `json:"id"`
			Content  string `json:"content"`
			Recalled bool   `json:"recalled"`
		}
		if err := json.Unmarshal([]byte(histB.Content), &items); err != nil {
			return false
		}
		for _, it := range items {
			if it.ID == msgID && it.Recalled {
				return true
			}
		}
		return false
	}()
	passFail("14.历史记录含已撤回标记", okHist, "撤回消息保留且 recalled=true")

	// 收尾
	wa.close()
	wb.close()
	wc.close()

	fmt.Println("----------------------------------------")
	if failed > 0 {
		fmt.Printf("❌ 冒烟回归失败：%d 项未通过\n", failed)
		return
	}
	fmt.Println("✅ 全部冒烟回归通过")
}
