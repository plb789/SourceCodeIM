// 临时测试：阶段六十五 Agent 执行轨迹留痕验证（验证完可删除）
// 流程：登录 → 发起任务（todo_write 免审 + write_file 需审批，测试自动批准）→ 等 done →
//
//	验证用户端 steps API（条数/序号递增/审批标记/环境标记）、越权拒绝、管理端未登录拦截
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

type stepRec struct {
	Seq      int    `json:"seq"`
	Tool     string `json:"tool"`
	Params   string `json:"params"`
	Result   string `json:"result"`
	OK       bool   `json:"ok"`
	Env      string `json:"env"`
	Approval string `json:"approval"`
	DurMS    int64  `json:"duration_ms"`
}

func main() {
	stamp := time.Now().Unix()
	user := "trc" + strconv.FormatInt(stamp%100000, 10)

	// ===== 1. 登录并发起任务 =====
	w := dialRaw()
	w.send(Msg{MsgType: 7, FromUser: user, Content: "pass123"})
	login := w.drain(3*time.Second, func(m *Msg) bool { return m.MsgType == 8 })
	passFail("1.登录", login != nil, "用户="+user)

	// 任务目标：触发 todo_write（免审）+ run_command whoami（非白名单→强制审批，测试自动批准）+ write_file（免审）
	goal := "用任务清单规划三步并逐步执行：1.运行命令 whoami 查询当前用户名；2.创建 trace_test.txt 文件内容为：执行轨迹留痕验证；3.完成后总结"
	runJSON, _ := json.Marshal(map[string]interface{}{"goal": goal, "agent_name": "AI助手"})
	w.send(Msg{MsgType: 46, FromUser: user, Content: string(runJSON)})

	// ===== 2. 事件循环：审批请求自动批准 + 等 done =====
	var taskID string
	done := false
	approvedCnt := 0
	deadline := time.Now().Add(240 * time.Second)
	for time.Now().Before(deadline) {
		m := w.drain(8*time.Second, func(x *Msg) bool {
			return x.MsgType == 47 || x.MsgType == 48
		})
		if m == nil {
			continue
		}
		if m.MsgType == 48 { // 审批请求：原样回传 task_id+step，自动批准
			var req struct {
				TaskID string `json:"task_id"`
				Step   string `json:"step"`
				Tool   string `json:"tool"`
			}
			if json.Unmarshal([]byte(m.Content), &req) == nil && req.TaskID != "" {
				taskID = req.TaskID
				ack, _ := json.Marshal(map[string]string{"task_id": req.TaskID, "step": req.Step, "action": "approve"})
				w.send(Msg{MsgType: 49, FromUser: user, Content: string(ack)})
				approvedCnt++
			}
			continue
		}
		var ev struct {
			TaskID string `json:"task_id"`
			Type   string `json:"type"`
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
	passFail("3.审批请求收到并批准", approvedCnt > 0, fmt.Sprintf("批准 %d 次（whoami 非白名单强制审批）", approvedCnt))

	// ===== 4. 用户端执行轨迹 API =====
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
	var steps struct {
		OK   bool `json:"ok"`
		Data struct {
			TaskID string    `json:"task_id"`
			Total  int       `json:"total"`
			Steps  []stepRec `json:"steps"`
		} `json:"data"`
	}
	if b := get("/api/agent/task/" + url.QueryEscape(taskID) + "/steps?username=" + url.QueryEscape(user)); b == nil || json.Unmarshal(b, &steps) != nil || !steps.OK {
		passFail("4.执行轨迹API", false, "接口异常")
	} else {
		ss := steps.Data.Steps
		// 条数：todo_write + write_file 至少两步留痕
		passFail("4a.轨迹条数", steps.Data.Total >= 2 && len(ss) == steps.Data.Total, fmt.Sprintf("共 %d 步留痕", steps.Data.Total))
		// 序号从 1 连续递增
		seqOK := true
		for i, s := range ss {
			if s.Seq != i+1 {
				seqOK = false
			}
		}
		passFail("4b.序号连续递增", seqOK && len(ss) > 0, "")
		// 字段合法性：工具名非空、env/approval 在枚举内、结果非空
		valid := true
		hasNone, hasApproved := false, false
		for _, s := range ss {
			if s.Tool == "" || s.Result == "" {
				valid = false
			}
			if s.Env != "server" && s.Env != "pc" {
				valid = false
			}
			switch s.Approval {
			case "none", "approved", "rejected", "cancelled", "timeout":
			default:
				valid = false
			}
			if s.Approval == "none" {
				hasNone = true
			}
			if s.Approval == "approved" {
				hasApproved = true
			}
		}
		passFail("4c.字段合法性", valid, "工具/环境/审批标记均在枚举内")
		passFail("4d.免审+审批双路径留痕", hasNone && hasApproved, "todo_write/write_file=none，run_command=approved")
		// run_command 步骤参数应含 command 键（留痕记录的是改参后最终参数）
		parameterOK := false
		for _, s := range ss {
			if s.Tool == "run_command" && s.Params != "" {
				var pm map[string]interface{}
				if json.Unmarshal([]byte(s.Params), &pm) == nil {
					if _, ok := pm["command"]; ok {
						parameterOK = true
					}
				}
			}
		}
		passFail("4e.参数JSON留痕", parameterOK, "run_command 步骤参数含 command 键")
		// 摘要样例
		if len(ss) > 0 {
			last := ss[len(ss)-1]
			fmt.Printf("  样例步骤#%d 工具=%s 审批=%s 耗时=%dms 结果=%s\n", last.Seq, last.Tool, last.Approval, last.DurMS, truncate(last.Result, 50))
		}
	}

	// ===== 5. 越权校验（他人任务轨迹不可见） =====
	if b := get("/api/agent/task/" + url.QueryEscape(taskID) + "/steps?username=nobody_else"); b != nil {
		var deny struct {
			OK bool `json:"ok"`
		}
		json.Unmarshal(b, &deny)
		passFail("5.越权拒绝", !deny.OK, "他人任务轨迹返回 404")
	} else {
		passFail("5.越权拒绝", false, "请求失败")
	}

	// ===== 6. 管理端轨迹接口（未登录应被 adminGuard 拦截） =====
	resp, err := http.Get(base + "/admin/api/agent/task/" + url.QueryEscape(taskID) + "/steps")
	if err != nil {
		passFail("6.管理端鉴权", false, "请求失败")
	} else {
		resp.Body.Close()
		passFail("6.管理端鉴权", resp.StatusCode == http.StatusUnauthorized, "未登录返回 401")
	}

	w.Conn.Close()
	if failed > 0 {
		fmt.Printf("共 %d 项失败\n", failed)
	} else {
		fmt.Println("全部通过：执行轨迹留痕闭环生效")
	}
}
