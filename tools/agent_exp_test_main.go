// 临时测试：阶段六十三 Agent 经验记忆闭环验证（验证完可删除）
// 流程：登录 → 拉智能体列表 → 发起 Agent 任务（写文件）→ 等 done → 等经验提取 →
//
//	HTTP 查记忆列表验证出现 source=agent 记录 → 再发同类任务验证经验注入不报错
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	Timestamp int64  `json:"timestamp"`
}

type ConnWrapper struct {
	Name string
	Conn *websocket.Conn
	Ch   chan *Msg
}

// close 关闭底层连接
func (w *ConnWrapper) close() {
	w.Conn.Close()
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

func main() {
	stamp := time.Now().Unix()
	user := "expu" + strconv.FormatInt(stamp%100000, 10)

	// ===== 1. 登录（自动注册） =====
	w := dialRaw(user)
	w.send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})
	login := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	loginOK := false
	if login != nil {
		var info struct {
			Result string `json:"result"`
		}
		if json.Unmarshal([]byte(login.Content), &info) == nil && info.Result == "ok" {
			loginOK = true
		} else if login.Content == "ok" {
			loginOK = true
		}
	}
	passFail("1.登录", loginOK, "用户="+user)
	if !loginOK {
		return
	}

	// ===== 2. 拉智能体列表（42） =====
	w.send(Msg{MsgType: 42, FromUser: user})
	agentsMsg := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 42 })
	if agentsMsg == nil {
		passFail("2.智能体列表", false, "超时未收到")
		return
	}
	var agents []struct {
		ID    uint   `json:"id"`
		Name  string `json:"name"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal([]byte(agentsMsg.Content), &agents); err != nil || len(agents) == 0 {
		passFail("2.智能体列表", false, "解析失败或为空: "+agentsMsg.Content)
		return
	}
	passFail("2.智能体列表", true, fmt.Sprintf("共 %d 个，取第一个 name=%s id=%d model=%s", len(agents), agents[0].Name, agents[0].ID, agents[0].Model))
	agent := agents[0]

	// ===== 3. 发起 Agent 任务（创建程序+执行命令+回写结果，产生可沉淀的真实经验） =====
	goal := "在工作区创建 hello.go 文件（main 函数打印 Hello Agent Exp 一行），然后用 run_command 执行 go run hello.go 运行它，最后把命令的执行结果写入 result.txt。全部完成后汇报各步骤结果。"
	runJSON, _ := json.Marshal(map[string]interface{}{"goal": goal, "agent_name": agent.Name})
	w.send(Msg{MsgType: 46, FromUser: user, Content: string(runJSON)})

	// 监听事件流（统计工具事件，等待 done/error）
	toolEvents := 0
	var doneText string
	done := false
	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(5*time.Second, func(x *Msg) bool { return x.MsgType == 47 || x.MsgType == 9 })
		if m == nil {
			continue
		}
		if m.MsgType == 9 {
			passFail("3.Agent任务", false, "服务端错误: "+m.Content)
			w.close()
			return
		}
		var ev struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
			Status string `json:"status"`
			Result string `json:"result"`
			Text   string `json:"text"`
			Tool   string `json:"tool"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "tool_start", "tool_result":
			toolEvents++
		case "done":
			done, doneText = true, ev.Result
		case "error":
			passFail("3.Agent任务", false, "任务失败: "+ev.Text)
			w.close()
			return
		}
		if done {
			break
		}
	}
	passFail("3.Agent任务完成", done, fmt.Sprintf("工具事件 %d 次，总结前60字: %q", toolEvents, truncate(doneText, 60)))
	w.close()

	// ===== 4. 等待经验异步提取完成（提取模型调用 + 落库） =====
	fmt.Println("4.等待 12 秒让经验提取异步完成…")
	time.Sleep(12 * time.Second)

	// ===== 5. HTTP 查记忆列表，验证 source=agent 记录 =====
	apiURL := fmt.Sprintf("http://127.0.0.1:8888/api/agents/%d/memory?username=%s", agent.ID, url.QueryEscape(user))
	resp, err := http.Get(apiURL)
	if err != nil {
		passFail("5.记忆查询", false, "HTTP 失败: "+err.Error())
	} else {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var res struct {
			OK   bool `json:"ok"`
			Data struct {
				Memories []struct {
					ID     uint   `json:"id"`
					Source string `json:"source"`
					Text   string `json:"content"`
				} `json:"memories"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &res); err != nil || !res.OK {
			passFail("5.记忆查询", false, "接口异常: "+truncate(string(body), 120))
		} else {
			hasAgent := false
			for _, mem := range res.Data.Memories {
				if mem.Source == "agent" {
					hasAgent = true
					fmt.Printf("   发现任务经验（source=agent）: %q\n", truncate(mem.Text, 80))
				}
			}
			passFail("5.任务经验沉淀入库", hasAgent, fmt.Sprintf("记忆共 %d 条", len(res.Data.Memories)))
		}
	}

	// ===== 6. 再发同类任务验证经验注入链路（有历史经验后任务仍正常执行） =====
	w2 := dialRaw(user + "b")
	w2.send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})
	w2.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	goal2 := "请在你的工作区创建 exp_demo2.txt 文件，内容为一行文字：经验复用验证。"
	run2, _ := json.Marshal(map[string]interface{}{"goal": goal2, "agent_name": agent.Name})
	w2.send(Msg{MsgType: 46, FromUser: user, Content: string(run2)})
	done2 := false
	deadline2 := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline2) {
		m := w2.drain(5*time.Second, func(x *Msg) bool { return x.MsgType == 47 || x.MsgType == 9 })
		if m == nil {
			continue
		}
		if m.MsgType == 9 {
			passFail("6.经验复用任务", false, "服务端错误: "+m.Content)
			break
		}
		var ev struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		if ev.Type == "done" {
			done2 = true
			break
		}
		if ev.Type == "error" {
			passFail("6.经验复用任务", false, "任务失败: "+ev.Text)
			break
		}
	}
	passFail("6.经验复用任务完成", done2, "带经验注入的第二轮任务正常结束")
	w2.Conn.Close()

	if failed > 0 {
		fmt.Printf("共 %d 项失败\n", failed)
	} else {
		fmt.Println("全部通过：经验沉淀与复用闭环生效")
	}
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
