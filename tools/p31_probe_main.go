// 临时探针：查询 p31a↔p31b 历史消息明细（定位未知消息 357，验证完可删除）
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

type Msg struct {
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
	To       string `json:"to_user,omitempty"`
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
}

type Record struct {
	ID         uint   `json:"id"`
	MsgType    int8   `json:"msg_type"`
	FromUser   string `json:"from_user"`
	ToUser     string `json:"to_user"`
	Content    string `json:"content"`
	Recalled   bool   `json:"recalled"`
	CreateTime string `json:"create_time"`
}

func main() {
	conn, _, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:8888/ws", nil)
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	conn.WriteJSON(map[string]interface{}{"msg_type": 7, "from_user": "p31a", "content": "123456"})
	deadline := time.Now().Add(10 * time.Second)
	var records []Record
	for time.Now().Before(deadline) {
		var m map[string]interface{}
		if err := conn.ReadJSON(&m); err != nil {
			break
		}
		if int(m["msg_type"].(float64)) == 8 {
			conn.WriteJSON(map[string]interface{}{"msg_type": 10, "page": 1, "page_size": 20, "to_user": "p31b"})
		}
		if int(m["msg_type"].(float64)) == 11 {
			raw, _ := json.Marshal(m["content"])
			var inner string
			json.Unmarshal(raw, &inner)
			json.Unmarshal([]byte(inner), &records)
			break
		}
	}
	for _, r := range records {
		fmt.Printf("id=%d type=%d from=%s to=%s recalled=%v time=%s content=%.90s\n", r.ID, r.MsgType, r.FromUser, r.ToUser, r.Recalled, r.CreateTime, r.Content)
	}
}
