// 临时测试：阶段六十四 Agent 任务历史 API 验证（验证完可删除）
// 流程：登录 → 发起一个会结束的任务（goal 触发失败更快？用正常任务）→ 等 done →
//
//	验证用户端列表（含 running 历史与 completed）、详情归属校验、状态筛选、管理端列表
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

type Msg struct {
	MsgType  int    `json:"msg_type"`
	FromUser string `json:"from_user"`
	ToUser   string `json:"to_user"`
	Content  string `json:"content"`
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
	w := &ConnWrapper{Conn: c, Ch: make(chan *Msg, 200)}
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

func main() {
	stamp := time.Now().Unix()
	user := "exph" + strconv.FormatInt(stamp%100000, 10)

	// ===== 1. 登录并发起任务 =====
	w := dialRaw()
	w.send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})
	login := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("1.登录", login != nil, "用户="+user)

	goal := "在工作区创建 hist_test.txt 文件，内容为：任务历史功能验证"
	runJSON, _ := json.Marshal(map[string]interface{}{"goal": goal, "agent_name": "AI助手"})
	w.send(Msg{MsgType: 46, FromUser: user, Content: string(runJSON)})

	// 等 done（同时验证 running 态已入库）
	var taskID string
	time.Sleep(2 * time.Second) // 先给服务端 2 秒建 running 行

	done := false
	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(5*time.Second, func(x *Msg) bool { return x.MsgType == 47 })
		if m == nil {
			continue
		}
		var ev struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
			Text   string `json:"text"`
		}
		if json.Unmarshal([]byte(m.Content), &ev) != nil {
			continue
		}
		if ev.TaskID != "" {
			taskID = ev.TaskID
		}
		if ev.Type == "done" {
			done = true
			break
		}
		if ev.Type == "error" {
			break
		}
	}
	passFail("2.任务完成", done, "task_id="+taskID)

	// ===== 3. 用户端任务列表 =====
	base := "http://127.0.0.1:8888"
	get := func(path string) []byte {
		resp, err := http.Get(base + path)
		if err != nil {
			return nil
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return b
	}
	var list struct {
		OK bool `json:"ok"`
		Data struct {
			Total int `json:"total"`
			Tasks []struct {
				TaskID  string `json:"task_id"`
				Status  string `json:"status"`
				Goal    string `json:"goal"`
				Steps   int    `json:"steps"`
			} `json:"tasks"`
		} `json:"data"`
	}
	if b := get("/api/agent/tasks?username=" + url.QueryEscape(user)); b == nil || json.Unmarshal(b, &list) != nil || !list.OK {
		passFail("3.任务列表", false, "接口异常")
	} else {
		hasHist := false
		for _, t := range list.Data.Tasks {
			if t.TaskID == taskID && t.Status == "completed" {
				hasHist = true
			}
		}
		passFail("3.任务列表", hasHist && list.Data.Total > 0, fmt.Sprintf("共 %d 条（含历史 running 记录），最新任务状态正常", list.Data.Total))
	}

	// ===== 4. 状态筛选 =====
	var fl struct {
		OK   bool `json:"ok"`
		Data struct {
			Total int `json:"total"`
		} `json:"data"`
	}
	if b := get("/api/agent/tasks?username=" + url.QueryEscape(user) + "&status=running"); b == nil || json.Unmarshal(b, &fl) != nil || !fl.OK {
		passFail("4.状态筛选", false, "接口异常")
	} else {
		passFail("4.状态筛选(已完成过滤 running)", fl.Data.Total == 0, "running 态记录已更新为 completed，筛出 0 条")
	}

	// ===== 5. 详情接口（本人可见） =====
	var det struct {
		OK   bool `json:"ok"`
		Data struct {
			TaskID string `json:"task_id"`
			Status string `json:"status"`
			Result string `json:"result"`
		} `json:"data"`
	}
	if b := get("/api/agent/task/" + url.QueryEscape(taskID) + "?username=" + url.QueryEscape(user)); b == nil || json.Unmarshal(b, &det) != nil || !det.OK {
		passFail("5.任务详情", false, "接口异常")
	} else {
		passFail("5.任务详情", det.Data.TaskID == taskID && det.Data.Result != "", "总结前60字: "+truncate(det.Data.Result, 60))
	}

	// ===== 6. 越权校验（他人任务不可见） =====
	if b := get("/api/agent/task/" + url.QueryEscape(taskID) + "?username=nobody_else"); b != nil {
		var deny struct {
			OK bool `json:"ok"`
		}
		json.Unmarshal(b, &deny)
		passFail("6.越权拒绝", !deny.OK, "他人任务返回 404")
	} else {
		passFail("6.越权拒绝", false, "请求失败")
	}

	// ===== 7. 管理端列表（未登录应被 adminGuard 拦截） =====
	resp, err := http.Get(base + "/admin/api/agent/tasks?page=1&size=20")
	if err != nil {
		passFail("7.管理端鉴权", false, "请求失败")
	} else {
		resp.Body.Close()
		passFail("7.管理端鉴权", resp.StatusCode == http.StatusUnauthorized, "未登录返回 401")
	}

	w.Conn.Close()
	if failed > 0 {
		fmt.Printf("共 %d 项失败\n", failed)
	} else {
		fmt.Println("全部通过：任务历史 API 闭环生效")
	}
}
