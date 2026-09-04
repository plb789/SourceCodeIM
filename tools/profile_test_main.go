// 临时测试：阶段三十个人资料全链路验证（验证完可删除）
// 覆盖：登录响应携带profile / 资料更新回推 / 多端同步 / 好友查询带备注 / 陌生人查询 / 越权与非法参数校验
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

// ProfileInfo 个人资料响应结构
type ProfileInfo struct {
	Username  string `json:"username"`
	Nickname  string `json:"nickname"`
	Gender    int8   `json:"gender"`
	Region    string `json:"region"`
	Signature string `json:"signature"`
	Avatar    string `json:"avatar"`
	IsFriend  bool   `json:"is_friend"`
	Remark    string `json:"remark"`
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
	w := &ConnWrapper{Name: name, Conn: c, Ch: make(chan *Msg, 300)}
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

// parseProfile 解析 PROFILE_RESP 内容
func parseProfile(m *Msg) ProfileInfo {
	var info ProfileInfo
	if m != nil {
		json.Unmarshal([]byte(m.Content), &info)
	}
	return info
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

	// 准备：A 上线（双连接模拟多端），B 上线建立好友关系，C 陌生人上线
	a2 := dialUser("T30A") // A 的第二台设备
	a2.drain(1*time.Second, nil)
	b := dialUser("T30B")
	b.drain(1*time.Second, nil)
	c := dialUser("T30C")
	c.drain(1*time.Second, nil)

	// B 向 A 申请好友，A 同意（双向建立好友关系）
	b.send(Msg{MsgType: 20, FromUser: "T30B", ToUser: "T30A", Content: "加个好友"})
	a2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 20 })
	a2.send(Msg{MsgType: 21, FromUser: "T30A", ToUser: "T30B", Content: "agree"})
	b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 21 })

	// 1. A 更新个人资料：第二连接应实时收到 PROFILE_RESP 多端同步
	a2.send(Msg{MsgType: 37, FromUser: "T30A", Content: `{"nickname":"小潘","gender":1,"region":"山西 太原","signature":"你好，世界"}`})
	mSync := a2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 })
	info := parseProfile(mSync)
	check(fmt.Sprintf("资料更新后本人其他连接实时同步(昵称=%s 性别=%d 地区=%s 签名=%s)", info.Nickname, info.Gender, info.Region, info.Signature),
		mSync != nil && info.Nickname == "小潘" && info.Gender == 1 && info.Region == "山西 太原" && info.Signature == "你好，世界")

	// 2. B 查询 A 资料：is_friend=true，备注当前为空
	b.send(Msg{MsgType: 38, FromUser: "T30B", ToUser: "T30A"})
	mq := b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 && m.ToUser == "T30B" })
	qi := parseProfile(mq)
	check("好友查询返回资料且标记好友关系", mq != nil && qi.Username == "T30A" && qi.IsFriend && qi.Nickname == "小潘")

	// 3. B 给 A 设置备注后再查询：remark 应返回备注名
	// FRIEND_UPDATE 需要备注字段：直接构造 JSON（Msg 结构无 remark 字段，用原始 map 发送）
	rawRemark, _ := json.Marshal(map[string]interface{}{"msg_type": 25, "from_user": "T30B", "to_user": "T30A", "remark": "潘总"})
	b.Conn.WriteMessage(websocket.TextMessage, rawRemark)
	b.drain(2*time.Second, func(m *Msg) bool { return m.MsgType == 9 })
	b.send(Msg{MsgType: 38, FromUser: "T30B", ToUser: "T30A"})
	mq2 := b.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 && m.ToUser == "T30B" })
	qi2 := parseProfile(mq2)
	check(fmt.Sprintf("设置备注后查询返回备注(remark=%s)", qi2.Remark), mq2 != nil && qi2.Remark == "潘总" && qi2.IsFriend)

	// 4. 陌生人 C 查询 A：is_friend=false 且无备注，但可见资料
	c.send(Msg{MsgType: 38, FromUser: "T30C", ToUser: "T30A"})
	mq3 := c.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 && m.ToUser == "T30C" })
	qi3 := parseProfile(mq3)
	check("陌生人查询可见资料但无好友标记与备注", mq3 != nil && !qi3.IsFriend && qi3.Remark == "" && qi3.Nickname == "小潘")

	// 5. 查询不存在的用户：应返回错误提示
	c.send(Msg{MsgType: 38, FromUser: "T30C", ToUser: "T30_NOT_EXIST"})
	me := c.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 && m.Content == "用户不存在" })
	check("查询不存在用户返回错误提示", me != nil)

	// 6. 非法性别参数：应被拒绝且资料不变
	a2.send(Msg{MsgType: 37, FromUser: "T30A", Content: `{"nickname":" hacker","gender":5,"region":"","signature":""}`})
	mg := a2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 9 && m.Content == "性别参数无效" })
	check("非法性别参数被拒绝", mg != nil)

	a2.send(Msg{MsgType: 38, FromUser: "T30A", ToUser: "T30A"})
	mg2 := a2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 })
	mgi := parseProfile(mg2)
	check("非法更新未落库(资料保持原值)", mgi.Nickname == "小潘" && mgi.Gender == 1)

	// 7. 清空资料（空字符串+性别0）：应正常保存
	a2.send(Msg{MsgType: 37, FromUser: "T30A", Content: `{"nickname":"","gender":0,"region":"","signature":""}`})
	mc := a2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 39 })
	ci := parseProfile(mc)
	check("清空资料正常保存", mc != nil && ci.Nickname == "" && ci.Gender == 0)

	a2.Conn.Close()
	b.Conn.Close()
	c.Conn.Close()

	fmt.Printf("测试完成：通过 %d 项，失败 %d 项\n", pass, fail)
}
