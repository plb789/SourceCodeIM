// 临时测试：阶段三十一大文件传输链路改造验证（验证完可删除）
// 覆盖：
//  1. 小文件分片链路回归（64KB 分片：文件头 → 分片中转 → 接收方集齐 → HTTP 持久化 → FILE_PERSISTED 双端同步）
//  2. 持久化幂等（重复 POST /upload/file 返回同一 msg_id）
//  3. 大文件 HTTP 直传链路（无 file_id，带 to_user/nonce：流式落盘 → 建档 → 落库 → FILE_PERSISTED 携带 content）
//  4. 历史消息包含图片(4)/文件(5)消息
//  5. 文字私聊回归（分片/直传改造不影响普通消息）
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

// Msg 测试用消息结构（与服务端 protocol.Message 字段对齐）
type Msg struct {
	MsgType     int    `json:"msg_type"`
	FromUser    string `json:"from_user"`
	ToUser      string `json:"to_user"`
	Content     string `json:"content"`
	FileName    string `json:"file_name"`
	FileSize    int64  `json:"file_size"`
	FileData    []byte `json:"file_data"`
	ChunkIndex  int    `json:"chunk_index"`
	Timestamp   int64  `json:"timestamp"`
	FileID      string `json:"file_id"`
	TotalChunks int    `json:"total_chunks"`
	MsgID       uint   `json:"msg_id"`
	Page        int    `json:"page"`
	PageSize    int    `json:"page_size"`
}

// ConnWrapper 测试连接：后台读循环 + 超时取消息
type ConnWrapper struct {
	Name string
	Conn *websocket.Conn
	MC   chan Msg
}

func NewConn(name, user, pass string) *ConnWrapper {
	c := &ConnWrapper{Name: name, MC: make(chan Msg, 512)}
	var err error
	c.Conn, _, err = websocket.DefaultDialer.Dial("ws://127.0.0.1:8888/ws", nil)
	if err != nil {
		panic(fmt.Sprintf("%s 连接失败: %v", name, err))
	}
	c.Send(Msg{MsgType: 7, FromUser: user, Content: pass}) // 登录
	go func() {
		for {
			var m Msg
			if err := c.Conn.ReadJSON(&m); err != nil {
				close(c.MC)
				return
			}
			c.MC <- m
		}
	}()
	// 等登录响应
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case m := <-c.MC:
			if m.MsgType == 8 {
				return c
			}
		case <-time.After(5 * time.Second):
			panic(name + " 登录超时")
		}
	}
	return c
}

func (c *ConnWrapper) Send(m Msg) {
	c.Conn.WriteJSON(m)
}

// WaitTypes 等待指定类型消息（跳过无关类型），超时报错
func (c *ConnWrapper) WaitTypes(timeout time.Duration, types ...int) Msg {
	deadline := time.Now().Add(timeout)
	for {
		select {
		case m, ok := <-c.MC:
			if !ok {
				panic(c.Name + " 连接已关闭")
			}
			for _, t := range types {
				if m.MsgType == t {
					return m
				}
			}
		case <-time.After(timeout):
			panic(fmt.Sprintf("%s 等待消息类型 %v 超时", c.Name, types))
		}
		if time.Now().After(deadline) {
			panic(fmt.Sprintf("%s 等待消息类型 %v 超时", c.Name, types))
		}
	}
}

func (c *ConnWrapper) WaitTypesOpt(timeout time.Duration, types ...int) (Msg, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case m, ok := <-c.MC:
			if !ok {
				return Msg{}, false
			}
			for _, t := range types {
				if m.MsgType == t {
					return m, true
				}
			}
		case <-time.After(50 * time.Millisecond):
		}
	}
	return Msg{}, false
}

// uploadFile 通过 HTTP 上传文件，返回响应 JSON
func uploadFile(query string, path string) map[string]interface{} {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", path)
	io.Copy(fw, f)
	w.Close()
	req, _ := http.NewRequest("POST", "http://127.0.0.1:8888/upload/file"+query, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var out map[string]interface{}
	if resp.StatusCode != 200 {
		panic(fmt.Sprintf("上传失败 status=%d body=%s", resp.StatusCode, string(body)))
	}
	json.Unmarshal(body, &out)
	return out
}

var passCount, failCount int

func check(name string, ok bool, detail string) {
	if ok {
		passCount++
		fmt.Printf("[通过] %s %s\n", name, detail)
	} else {
		failCount++
		fmt.Printf("[失败] %s %s\n", name, detail)
	}
}

func main() {
	// 建立双账号连接
	a := NewConn("A(p31a)", "p31a", "123456")
	defer a.Conn.Close()
	b := NewConn("B(p31b)", "p31b", "123456")
	defer b.Conn.Close()
	fmt.Println("== 双账号登录完成 ==")

	// 场景1：小文件分片链路（800KB / 64KB = 13 片）
	small, _ := os.ReadFile(`C:\Users\AW\AppData\Local\Temp\p31test\small.bmp`)
	const chunkSize = 65536
	total := (len(small) + chunkSize - 1) / chunkSize
	a.Send(Msg{MsgType: 3, ChunkIndex: -1, ToUser: "p31b", FileName: "small.bmp", FileSize: int64(len(small)), TotalChunks: total})
	// A 收到文件头回执（带 file_id），B 收到文件头
	aHead := a.WaitTypes(5*time.Second, 3)
	bHead := b.WaitTypes(5*time.Second, 3)
	check("分片-文件头回执", aHead.FileID != "" && aHead.ChunkIndex == -1, "fileID="+aHead.FileID)
	check("分片-接收方文件头", bHead.FileID == aHead.FileID && bHead.FileName == "small.bmp", "")

	// A 逐片发送，B 逐片接收
	got := make(map[int][]byte)
	sentDone := make(chan bool)
	go func() {
		for i := 0; i < total; i++ {
			end := (i + 1) * chunkSize
			if end > len(small) {
				end = len(small)
			}
			a.Send(Msg{MsgType: 3, ToUser: "p31b", FileID: aHead.FileID, ChunkIndex: i, TotalChunks: total, FileData: small[i*chunkSize : end]})
		}
		sentDone <- true
	}()
	bDeadline := time.After(10 * time.Second)
	for len(got) < total {
		select {
		case m := <-b.MC:
			if m.MsgType == 3 && m.FileID == aHead.FileID && m.ChunkIndex >= 0 {
				got[m.ChunkIndex] = m.FileData
			}
		case <-bDeadline:
			panic("分片接收超时")
		}
	}
	<-sentDone
	match := true
	for i := 0; i < total; i++ {
		if !bytes.Equal(got[i], small[i*chunkSize:func() int {
			e := (i + 1) * chunkSize
			if e > len(small) {
				e = len(small)
			}
			return e
		}()]) {
			match = false
		}
	}
	check("分片-数据完整性", match, fmt.Sprintf("共 %d 片全部一致", total))

	// 场景2：分片完成后的 HTTP 持久化 + 幂等
	res1 := uploadFile("?file_id="+aHead.FileID+"&username=p31a", `C:\Users\AW\AppData\Local\Temp\p31test\small.bmp`)
	fpA, _ := a.WaitTypesOpt(5*time.Second, 33)
	fpB, _ := b.WaitTypesOpt(5*time.Second, 33)
	msgID := int(res1["msg_id"].(float64))
	check("分片-持久化响应", res1["url"] != nil && msgID > 0, fmt.Sprintf("msg_id=%v url=%v", res1["msg_id"], res1["url"]))
	check("分片-FILE_PERSISTED 双端", fpA.MsgID == uint(msgID) && fpB.MsgID == uint(msgID) && fpA.FileID == aHead.FileID && fpB.FileID == aHead.FileID, "")
	// 幂等：重复上传返回同一 msg_id
	res2 := uploadFile("?file_id="+aHead.FileID+"&username=p31a", `C:\Users\AW\AppData\Local\Temp\p31test\small.bmp`)
	check("分片-持久化幂等", int(res2["msg_id"].(float64)) == msgID, fmt.Sprintf("重复请求 msg_id=%v", res2["msg_id"]))

	// 场景3：大文件 HTTP 直传（7.3MB，无 file_id，带 to_user/nonce）
	res3 := uploadFile("?username=p31a&to_user=p31b&nonce=p31nonce1", `C:\Users\AW\AppData\Local\Temp\p31test\large.bmp`)
	dpA, okA := a.WaitTypesOpt(8*time.Second, 33)
	dpB, okB := b.WaitTypesOpt(8*time.Second, 33)
	largeMsgID := int(res3["msg_id"].(float64))
	check("直传-HTTP 响应", res3["url"] != nil && largeMsgID > 0, fmt.Sprintf("msg_id=%v url=%v size=%.1fMB", res3["msg_id"], res3["url"], float64(7680054)/1048576))
	var metaA, metaB map[string]interface{}
	json.Unmarshal([]byte(dpA.Content), &metaA)
	json.Unmarshal([]byte(dpB.Content), &metaB)
	check("直传-FILE_PERSISTED 携带 content", okA && okB && metaA["url"] != nil && metaB["url"] != nil, fmt.Sprintf("A.nonce=%v B.name=%v", metaA["nonce"], metaB["name"]))
	check("直传-发送端 nonce 回显", metaA["nonce"] == "p31nonce1", "")
	check("直传-接收端 content 一致", metaB["name"] == "large.bmp" && metaB["size"].(float64) == 7680054, fmt.Sprintf("name=%v size=%v", metaB["name"], metaB["size"]))
	// 落库 URL 文件确实可访问
	urlStr, _ := res3["url"].(string)
	resp, err := http.Get("http://127.0.0.1:8888" + urlStr)
	if err == nil {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		check("直传-静态 URL 可访问", resp.StatusCode == 200 && len(body) == 7680054, fmt.Sprintf("status=%d bytes=%d", resp.StatusCode, len(body)))
	} else {
		check("直传-静态 URL 可访问", false, err.Error())
	}

	// 场景4：历史消息包含图片/文件消息
	a.Send(Msg{MsgType: 10, Page: 1, PageSize: 20, ToUser: "p31b"})
	hr := a.WaitTypes(5*time.Second, 11)
	var records []map[string]interface{}
	json.Unmarshal([]byte(hr.Content), &records)
	hasSmall, hasLarge := false, false
	for _, r := range records {
		id := int(r["id"].(float64))
		mt := int(r["msg_type"].(float64))
		if id == msgID && (mt == 4 || mt == 5) {
			hasSmall = true
		}
		if id == largeMsgID && (mt == 4 || mt == 5) {
			hasLarge = true
		}
	}
	check("历史-小文件消息在列", hasSmall, fmt.Sprintf("msg_id=%d", msgID))
	check("历史-大文件消息在列", hasLarge, fmt.Sprintf("msg_id=%d", largeMsgID))

	// 场景5：文字私聊回归
	a.Send(Msg{MsgType: 2, ToUser: "p31b", Content: "阶段三十一回归消息"})
	pm := b.WaitTypes(5*time.Second, 2)
	check("文字私聊回归", pm.Content == "阶段三十一回归消息" && pm.MsgID > 0, fmt.Sprintf("msg_id=%d", pm.MsgID))

	fmt.Printf("\n== 结果：通过 %d / 失败 %d ==\n", passCount, failCount)
	if failCount > 0 {
		os.Exit(1)
	}
}
