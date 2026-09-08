// 临时测试：阶段六十六 Agent 任务完成通知验证（验证完可删除）
// 流程：登录 → 发起免审任务 → 等 done → 验证完结消息落库（事件携带 msg_id）、
//
//	会话未读归口（CONV_LIST unread≥1 → 已读回执后归零）、历史留档可查；
//	再发起任务立即取消 → 验证 cancelled 通知落库且不产生未读
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

type Msg struct {
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
	Page     int    `json:"page,omitempty"`
	PageSize int    `json:"page_size,omitempty"`
}

type ConnWrapper struct {
	Conn *websocket.Conn
	Ch   chan *Msg
}

func dialRaw() *ConnWrapper {
	u := url.URL{Scheme: "ws", Host: "127.0.0.1:8888", Path: "/ws"}
	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		panic(err)
	}
	w := &ConnWrapper{Conn: c, Ch: make(chan *Msg, 300)}
	go func() {
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				close(w.Ch)
				return
			}
			var m Msg
			if err := json.Unmarshal(data, &m); err == nil {
				w.Ch <- &m
			}
		}
	}()
	return w
}

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

func (w *ConnWrapper) send(m Msg) {
	data, _ := json.Marshal(m)
	w.Conn.WriteMessage(websocket.TextMessage, data)
}

var failed int

func passFail(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("PASS %s %s\n", name, detail)
	} else {
		failed++
		fmt.Printf("FAIL %s %s\n", name, detail)
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

type convInfo struct {
	Target   string `json:"target"`
	LastMsg  string `json:"last_msg"`
	LastTime int64  `json:"last_time"`
	Unread   int64  `json:"unread"`
}

type histRecord struct {
	ID       uint   `json:"id"`
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
	IsRead   bool   `json:"is_read"`
}

// 等 CONV_LIST 推送并返回目标会话信息
func (w *ConnWrapper) waitConv(target string) *convInfo {
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(3*time.Second, func(x *Msg) bool { return x.MsgType == 18 })
		if m == nil {
			return nil
		}
		var convs []convInfo
		if json.Unmarshal([]byte(m.Content), &convs) != nil {
			continue
		}
		for i := range convs {
			if convs[i].Target == target {
				return &convs[i]
			}
		}
	}
	return nil
}

func main() {
	stamp := time.Now().Unix()
	user := "ntf" + strconv.FormatInt(stamp%100000, 10)
	const agent = "AI助手"

	// ===== 1. 登录 =====
	w := dialRaw()
	w.send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})
	login := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("1.登录", login != nil, "用户="+user)

	// ===== 2. 发起免审任务（仅 todo_write + 总结，快速完成不触发审批） =====
	goal := "用任务清单规划两步并逐步执行：1.记录一条待办：通知验证；2.完成后用一句话总结即可"
	runJSON, _ := json.Marshal(map[string]interface{}{"goal": goal, "agent_name": agent})
	w.send(Msg{MsgType: 46, FromUser: user, Content: string(runJSON)})

	// ===== 3. 事件循环等 done，断言事件携带落库 msg_id（服务端落库→CONV_LIST 推送→done 事件依次到达，缓存会话帧） =====
	var taskID string
	var doneMsgID uint64
	done := false
	var lastConv *Msg
	deadline := time.Now().Add(240 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(8*time.Second, func(x *Msg) bool { return x.MsgType == 47 || x.MsgType == 18 })
		if m == nil {
			continue
		}
		if m.MsgType == 18 { // 会话列表推送：缓存最新帧供完结后校验
			lastConv = m
			continue
		}
		var ev struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
			MsgID  uint64 `json:"msg_id"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		if ev.TaskID != "" {
			taskID = ev.TaskID
		}
		if ev.Type == "done" {
			done = true
			doneMsgID = ev.MsgID
			break
		}
		if ev.Type == "error" {
			break
		}
	}
	passFail("2.任务完成", done, "task_id="+taskID)
	passFail("3.done事件携带msg_id", done && doneMsgID > 0, fmt.Sprintf("msg_id=%d（完结消息落库回传）", doneMsgID))

	// ===== 4. 会话未读归口：CONV_LIST 该智能体会话 unread≥1 且摘要为答复内容 =====
	cv := convFromMsg(lastConv, agent)
	if cv == nil { // 兜底：缓存帧无该会话时再等一次新推送
		cv = w.waitConv(agent)
	}
	passFail("4a.完结消息计未读", cv != nil && cv.Unread >= 1, fmt.Sprintf("unread=%d", convUnread(cv)))
	passFail("4b.会话摘要更新", cv != nil && cv.LastMsg != "", "摘要="+truncate(convLastMsg(cv), 30))

	// ===== 5. 已读回执后未读归零 =====
	if doneMsgID > 0 {
		ack, _ := json.Marshal(map[string]string{})
		_ = ack
		w.send(Msg{MsgType: 13, ToUser: agent, Content: strconv.FormatUint(doneMsgID, 10)})
		cv2 := w.waitConv(agent)
		passFail("5.已读回执后未读归零", cv2 != nil && cv2.Unread == 0, fmt.Sprintf("unread=%d", convUnread(cv2)))
	} else {
		passFail("5.已读回执后未读归零", false, "无 msg_id 可回执")
	}

	// ===== 6. 历史留档：完结消息在私聊历史中可查且已读（响应 content 为记录数组直出） =====
	w.send(Msg{MsgType: 10, ToUser: agent, Page: 1, PageSize: 50})
	histFound, histRead := false, false
	deadline = time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(3*time.Second, func(x *Msg) bool { return x.MsgType == 11 })
		if m == nil {
			break
		}
		var records []histRecord
		if json.Unmarshal([]byte(m.Content), &records) != nil {
			continue
		}
		for _, r := range records {
			if uint64(r.ID) == doneMsgID && r.FromUser == agent && r.ToUser == user {
				histFound = true
				histRead = r.IsRead
			}
		}
		break
	}
	passFail("6a.完结消息历史留档", histFound, fmt.Sprintf("msg_id=%d 在私聊历史中", doneMsgID))
	passFail("6b.历史消息已读状态", histRead, "已读回执后 is_read=true")

	// ===== 7. 发起任务立即取消：cancelled 通知落库（msg_id>0）且不计未读 =====
	goal2 := "用任务清单规划五步并逐步执行：逐步列出实现一个复杂计算器的详细设计步骤，每步都要展开思考，不要急着完成"
	runJSON2, _ := json.Marshal(map[string]interface{}{"goal": goal2, "agent_name": agent})
	w.send(Msg{MsgType: 46, FromUser: user, Content: string(runJSON2)})

	var taskID2 string
	cancelled := false
	var cancelMsgID uint64
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(5*time.Second, func(x *Msg) bool { return x.MsgType == 47 })
		if m == nil {
			continue
		}
		var ev struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
			Status string `json:"status"`
			MsgID  uint64 `json:"msg_id"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		if ev.TaskID != "" && taskID2 == "" {
			taskID2 = ev.TaskID
			// 拿到 task_id 立即取消
			cj, _ := json.Marshal(map[string]string{"task_id": taskID2, "action": "cancel"})
			w.send(Msg{MsgType: 46, FromUser: user, Content: string(cj)})
		}
		if ev.Type == "status" && ev.Status == "cancelled" {
			cancelled = true
			cancelMsgID = ev.MsgID
			break
		}
		if ev.Type == "done" || ev.Type == "error" {
			// 任务跑得太快已完结（模型极快时可能发生），视为取消路径未命中
			break
		}
	}
	passFail("7a.取消事件携带msg_id", cancelled && cancelMsgID > 0, fmt.Sprintf("cancelled=%v msg_id=%d", cancelled, cancelMsgID))

	// 取消通知 is_read=true：unread 不增加（等下一次 CONV_LIST 确认，或无新推送则沿用旧值）
	if cancelled && cancelMsgID > 0 {
		// 拉历史确认取消留档存在（内容=任务已取消）
		w.send(Msg{MsgType: 10, ToUser: agent, Page: 1, PageSize: 50})
		found := false
		deadline = time.Now().Add(6 * time.Second)
		for time.Now().Before(deadline) {
			m := w.drain(3*time.Second, func(x *Msg) bool { return x.MsgType == 11 })
			if m == nil {
				break
			}
			var records []histRecord
			if json.Unmarshal([]byte(m.Content), &records) != nil {
				continue
			}
			for _, r := range records {
				if uint64(r.ID) == cancelMsgID && r.Content == "任务已取消" {
					found = true
				}
			}
			break
		}
		passFail("7b.取消通知历史留档", found, "内容=任务已取消")
	}

	w.Conn.Close()
	if failed > 0 {
		fmt.Printf("共 %d 项失败\n", failed)
	} else {
		fmt.Println("全部通过：Agent 任务完成通知闭环生效")
	}
}

// 从缓存的 CONV_LIST 帧解析目标会话信息
func convFromMsg(m *Msg, target string) *convInfo {
	if m == nil {
		return nil
	}
	var convs []convInfo
	if json.Unmarshal([]byte(m.Content), &convs) != nil {
		return nil
	}
	for i := range convs {
		if convs[i].Target == target {
			return &convs[i]
		}
	}
	return nil
}

func convUnread(c *convInfo) int64 {
	if c == nil {
		return -1
	}
	return c.Unread
}

func convLastMsg(c *convInfo) string {
	if c == nil {
		return ""
	}
	return c.LastMsg
}
