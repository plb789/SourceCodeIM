// 临时测试：阶段六十三经验复用验证（已有经验的账号发起同类任务，服务端日志应出现注入记录）
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

type Msg struct {
	MsgType int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
}

func main() {
	u := url.URL{Scheme: "ws", Host: "127.0.0.1:8888", Path: "/ws"}
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		panic(err)
	}
	// 复用此前已沉淀经验的测试账号（经验已持久化在 MySQL/向量库，重启不丢）
	user := "expu23881"
	send := func(m Msg) { d, _ := json.Marshal(m); c.WriteMessage(websocket.TextMessage, d) }
	send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})

	// 收到 42 后发起同类任务（与已沉淀经验主题相近：运行 Go 程序）
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		var m Msg
		if json.Unmarshal(data, &m) == nil && m.MsgType == 8 {
			break
		}
	}
	goal := "请运行工作区里的 hello.go 程序，把输出写入 run_again.txt"
	run, _ := json.Marshal(map[string]interface{}{"goal": goal, "agent_name": "AI助手"})
	send(Msg{MsgType: 46, FromUser: user, Content: string(run)})

	for {
		c.SetReadDeadline(time.Now().Add(180 * time.Second))
		_, data, err := c.ReadMessage()
		if err != nil {
			fmt.Println("read err:", err)
			return
		}
		var m Msg
		if json.Unmarshal(data, &m) != nil || m.MsgType != 47 {
			continue
		}
		var ev struct {
			Type   string `json:"type"`
			Status string `json:"status"`
			Text   string `json:"text"`
			Result string `json:"result"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		if ev.Type == "done" {
			fmt.Println("DONE 任务完成（结果前100字）:", truncateRunes(ev.Result, 100))
			break
		}
		if ev.Type == "error" {
			fmt.Println("ERROR:", ev.Text)
			break
		}
	}
	c.Close()
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
