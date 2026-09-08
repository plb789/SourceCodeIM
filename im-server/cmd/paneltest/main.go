// 临时测试客户端 B：模拟 PC 端验证 62→64→65→63 转发闭环（测完删除）
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"

	"im-server/protocol"
)

func main() {
	conn, _, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:8888/ws", nil)
	if err != nil {
		log.Fatal("连接失败:", err)
	}
	defer conn.Close()

	// platform=pc 登录（模拟 PC 端）
	sendMsg(conn, protocol.Message{MsgType: protocol.MsgTypeLogin, FromUser: "paneltest02", Content: "test123456", Platform: "pc"})
	var loginResp protocol.Message
	if !readMsg(conn, protocol.MsgTypeLoginResp, &loginResp, 5) {
		log.Fatal("未收到登录响应")
	}
	fmt.Println("PC 登录成功")

	// 发文件面板 tree 请求（服务端应识别 PC 在线 → 转发 64 到本连接）
	reqID := fmt.Sprintf("t%d", time.Now().UnixNano())
	sendMsg(conn, protocol.Message{MsgType: protocol.MsgTypeWsFileReq, FromUser: "paneltest02",
		Content: fmt.Sprintf(`{"op":"tree","req_id":"%s","path":""}`, reqID)})

	// 收帧：收到 64 立即回 65（模拟 electron 本地执行），然后等 63
	conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	for {
		var m protocol.Message
		if err := conn.ReadJSON(&m); err != nil {
			continue
		}
		switch m.MsgType {
		case protocol.MsgTypePcFileReq:
			var ev map[string]interface{}
			json.Unmarshal([]byte(m.Content), &ev)
			fmt.Println("收到 64 转发:", m.Content)
			// 回 65：模拟本地目录有条目
			resp := fmt.Sprintf(`{"op":"tree","req_id":"%s","ok":true,"root":"E:\\Bin\\测试文件","entries":[{"name":"hello.txt","dir":false,"size":12}]}`, ev["req_id"])
			sendMsg(conn, protocol.Message{MsgType: protocol.MsgTypePcFileResp, FromUser: "paneltest02", Content: resp})
		case protocol.MsgTypeWsFileResp:
			fmt.Println("收到 63 响应:", m.Content)
			var r map[string]interface{}
			json.Unmarshal([]byte(m.Content), &r)
			if r["ok"] == true && r["root"] == "E:\\Bin\\测试文件" {
				fmt.Println("闭环验证通过：62→64→65→63 全链路 OK，PC 结果正确投递")
			} else {
				fmt.Println("闭环异常：63 内容与 PC 回传不一致")
			}
			return
		}
	}
	log.Fatal("20 秒内未完成闭环")
}

func sendMsg(conn *websocket.Conn, m protocol.Message) {
	m.Timestamp = time.Now().Unix()
	if err := conn.WriteJSON(m); err != nil {
		log.Fatal("写帧失败:", err)
	}
}

func readMsg(conn *websocket.Conn, wantType int, out *protocol.Message, sec time.Duration) bool {
	conn.SetReadDeadline(time.Now().Add(sec * time.Second))
	for {
		var m protocol.Message
		if err := conn.ReadJSON(&m); err != nil {
			return false
		}
		if int(m.MsgType) == wantType {
			*out = m
			return true
		}
	}
}
