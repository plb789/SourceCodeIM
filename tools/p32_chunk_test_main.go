// 临时测试：阶段三十二超大文件分片直传验证（验证完可删除）
// 覆盖：
//  1. 分片直传全链路：逐片 POST /upload/chunk → 接收方 FILE_PROGRESS(40) 节流推送 → 收齐合并落库 → FILE_PERSISTED(33)
//  2. 合并完整性：下载合并文件与原始内容逐字节一致
//  3. 会话摘要联动：双方收到 CONV_LIST 摘要 [文件]
//  4. 历史消息包含分片直传文件消息(msg_type=5)
//  5. 超上限拒绝：file_size 超过 max_direct_size（2GB）首片即被拒
//  6. 危险文件拦截：file_name=evil.exe 被拒
//  7. 取消链路：上传中途 FILE_CANCEL(41) → 双方收到取消同步 → 后续分片被拒（410）
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
)

// Msg 测试用消息结构（与服务端 protocol.Message 字段对齐）
type Msg struct {
	MsgType   int    `json:"msg_type"`
	FromUser  string `json:"from_user"`
	ToUser    string `json:"to_user"`
	Content   string `json:"content"`
	FileName  string `json:"file_name"`
	FileSize  int64  `json:"file_size"`
	FileID    string `json:"file_id"`
	Timestamp int64  `json:"timestamp"`
	MsgID     uint   `json:"msg_id"`
	Page      int    `json:"page"`
	PageSize  int    `json:"page_size"`
}

// ConnWrapper 测试连接：后台读循环
type ConnWrapper struct {
	Name    string
	Conn    *websocket.Conn
	MC      chan Msg
	Pending []Msg // 非目标消息暂存队列（轮询等待时不丢弃其他类型消息，避免竞态丢消息）
}

func NewConn(name, user, pass string) *ConnWrapper {
	c := &ConnWrapper{Name: name, MC: make(chan Msg, 1024)}
	var err error
	c.Conn, _, err = websocket.DefaultDialer.Dial("ws://127.0.0.1:8888/ws", nil)
	if err != nil {
		panic(fmt.Sprintf("%s 连接失败: %v", name, err))
	}
	c.Conn.WriteJSON(Msg{MsgType: 7, FromUser: user, Content: pass})
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
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case m, ok := <-c.MC:
			if !ok {
				panic(name + " 连接关闭")
			}
			if m.MsgType == 8 {
				return c
			}
		case <-time.After(5 * time.Second):
			panic(name + " 登录超时")
		}
	}
	panic(name + " 登录超时")
}

// Send 发送消息
func (c *ConnWrapper) Send(m Msg) {
	c.Conn.WriteJSON(m)
}

// WaitTypes 等待指定类型消息（非目标消息暂存到 Pending 不丢弃）
func (c *ConnWrapper) WaitTypes(timeout time.Duration, types ...int) Msg {
	// 先查暂存队列
	for i, m := range c.Pending {
		for _, t := range types {
			if m.MsgType == t {
				c.Pending = append(c.Pending[:i], c.Pending[i+1:]...)
				return m
			}
		}
	}
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
			c.Pending = append(c.Pending, m) // 非目标消息暂存
		case <-time.After(time.Until(deadline)):
			panic(fmt.Sprintf("%s 等待消息类型 %v 超时", c.Name, types))
		}
	}
}

// WaitTypesOpt 非阻塞等待指定类型消息（到时返回 false；非目标消息暂存不丢弃）
func (c *ConnWrapper) WaitTypesOpt(timeout time.Duration, types ...int) (Msg, bool) {
	// 先查暂存队列
	for i, m := range c.Pending {
		for _, t := range types {
			if m.MsgType == t {
				c.Pending = append(c.Pending[:i], c.Pending[i+1:]...)
				return m, true
			}
		}
	}
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
			c.Pending = append(c.Pending, m) // 非目标消息暂存
		case <-time.After(50 * time.Millisecond):
		}
	}
	return Msg{}, false
}

// drain 清空连接积压消息与暂存队列（场景隔离）
func (c *ConnWrapper) drain() {
	c.Pending = nil
	for {
		select {
		case _, ok := <-c.MC:
			if !ok {
				return
			}
		case <-time.After(200 * time.Millisecond):
			return
		}
	}
}

// postChunk 上传单片（raw body），返回状态码与响应体
func postChunk(query string, body []byte) (int, map[string]interface{}) {
	req, _ := http.NewRequest("POST", "http://127.0.0.1:8888/upload/chunk"+query, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]interface{}{}
	json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]interface{}{"raw": string(raw)}
	}
	return resp.StatusCode, out
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
	const chunkSize = 4 << 20 // 4MB（与服务端 upload_chunk_size 一致）
	a := NewConn("A(p32a)", "p32a", "123456")
	defer a.Conn.Close()
	b := NewConn("B(p32b)", "p32b", "123456")
	defer b.Conn.Close()
	a.drain()
	b.drain()
	fmt.Println("== 双账号登录完成 ==")

	// ===== 场景1：分片直传全链路（12MB = 3 片）=====
	big := make([]byte, 12<<20)
	for i := range big {
		big[i] = byte(i % 251) // 确定性伪随机内容，供合并校验
	}
	nonce := "p32nonce1"
	uploadID := "up" + fmt.Sprint(time.Now().UnixNano())
	baseQ := fmt.Sprintf("?username=p32a&to_user=p32b&nonce=%s&upload_id=%s&total_chunks=3&file_name=p32big.bin&file_size=%d", nonce, uploadID, len(big))

	// 片间间隔 600ms：保证触发服务端 500ms 节流推送至少一条进度
	var lastResp map[string]interface{}
	allOK := true
	for seq := 0; seq < 3; seq++ {
		end := (seq + 1) * chunkSize
		if end > len(big) {
			end = len(big)
		}
		code, out := postChunk(baseQ+fmt.Sprintf("&seq=%d", seq), big[seq*chunkSize:end])
		if code != 200 {
			allOK = false
			fmt.Printf("  片%d 上传失败 status=%d out=%v\n", seq, code, out)
			break
		}
		lastResp = out
		if seq < 2 {
			time.Sleep(600 * time.Millisecond)
		}
	}
	check("分片直传-逐片上传成功", allOK, fmt.Sprintf("upload_id=%s", uploadID))
	check("分片直传-收齐响应携带msg_id", lastResp["msg_id"] != nil && lastResp["url"] != nil && lastResp["file_id"] != nil, fmt.Sprintf("%v", lastResp))
	time.Sleep(500 * time.Millisecond)
	// 统计接收方进度推送（非目标消息进 Pending，后续断言仍可取回）
	progressCount := 0
	for {
		_, ok := b.WaitTypesOpt(300*time.Millisecond, 40)
		if !ok {
			break
		}
		progressCount++
	}
	check("分片直传-接收方收到进度推送", progressCount >= 1, fmt.Sprintf("进度条数=%d", progressCount))

	// B 收到 FILE_PERSISTED（content 携带 nonce）
	bp := b.WaitTypes(5*time.Second, 33)
	var meta map[string]interface{}
	json.Unmarshal([]byte(bp.Content), &meta)
	check("分片直传-FILE_PERSISTED携带nonce", meta["nonce"] == nonce, fmt.Sprintf("msg_id=%d url=%v", bp.MsgID, meta["url"]))
	check("分片直传-FILE_PERSISTED归属B", bp.FromUser == "p32a" && bp.ToUser == "p32b", "")
	// A 收到 FILE_PERSISTED 回显（回填 msg_id）
	_, gotA := a.WaitTypesOpt(3*time.Second, 33)
	check("分片直传-发送方收到PERSISTED回显", gotA, "")

	// ===== 场景2：合并完整性（下载合并文件对比原始内容）=====
	url, _ := lastResp["url"].(string)
	resp, err := http.Get("http://127.0.0.1:8888" + url)
	if err == nil {
		downloaded, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		check("分片直传-合并文件大小一致", int64(len(downloaded)) == int64(len(big)), fmt.Sprintf("下载=%d 原始=%d", len(downloaded), len(big)))
		same := len(downloaded) == len(big)
		if same {
			for i := range big {
				if downloaded[i] != big[i] {
					same = false
					break
				}
			}
		}
		check("分片直传-合并文件内容一致", same, url)
	} else {
		check("分片直传-合并文件下载", false, err.Error())
	}

	// ===== 场景3：会话摘要 [文件] =====
	aConv := a.WaitTypes(5*time.Second, 18)
	check("分片直传-A会话摘要推送", aConv.MsgType == 18, "")
	bConv, gotBConv := b.WaitTypesOpt(3*time.Second, 18)
	check("分片直传-B会话摘要推送", gotBConv || bConv.MsgType == 18, "")

	// ===== 场景4：历史消息包含该文件消息 =====
	// 注：历史响应直接序列化 model.Message，主键 JSON 标签为 id（非 msg_id）
	a.Send(Msg{MsgType: 10, ToUser: "p32b", Page: 1, PageSize: 10})
	hr := a.WaitTypes(5*time.Second, 11)
	var records []map[string]interface{}
	json.Unmarshal([]byte(hr.Content), &records)
	hasFile := false
	for _, r := range records {
		t, _ := r["msg_type"].(float64)
		id, _ := r["id"].(float64)
		if int(t) == 5 && uint64(id) == uint64(bp.MsgID) {
			hasFile = true
			break
		}
	}
	check("分片直传-历史含文件消息(msg_type=5)", hasFile, fmt.Sprintf("历史%d条", len(records)))

	// ===== 场景5：超上限拒绝（file_size=3GB）=====
	code, _ := postChunk("?username=p32a&to_user=p32b&nonce=n2&upload_id=upXL&total_chunks=1&file_name=xl.bin&file_size=3221225472&seq=0", []byte("x"))
	check("分片直传-超上限拒绝", code == 400, fmt.Sprintf("status=%d", code))

	// ===== 场景6：危险文件拦截 =====
	code, _ = postChunk("?username=p32a&to_user=p32b&nonce=n3&upload_id=upEvil&total_chunks=1&file_name=evil.exe&file_size=10&seq=0", []byte("MZevil"))
	check("分片直传-危险文件拦截", code == 400, fmt.Sprintf("status=%d", code))

	// ===== 场景7：取消链路（上传 2 片后取消）=====
	a.drain()
	b.drain()
	nonce3 := "p32nonce3"
	uploadID3 := "up" + fmt.Sprint(time.Now().UnixNano())
	baseQ3 := fmt.Sprintf("?username=p32a&to_user=p32b&nonce=%s&upload_id=%s&total_chunks=5&file_name=p32cancel.bin&file_size=%d", nonce3, uploadID3, 5*chunkSize)
	for seq := 0; seq < 2; seq++ {
		code, out := postChunk(baseQ3+fmt.Sprintf("&seq=%d", seq), make([]byte, chunkSize))
		if code != 200 {
			fmt.Printf("  取消场景片%d异常 status=%d out=%v\n", seq, code, out)
		}
		time.Sleep(300 * time.Millisecond)
	}
	// 发送取消信令（file_id 复用携带 upload_id）
	a.Conn.WriteJSON(Msg{MsgType: 41, FromUser: "p32a", ToUser: "p32b", FileID: uploadID3})
	bCancel := b.WaitTypes(5*time.Second, 41)
	var cMeta map[string]interface{}
	json.Unmarshal([]byte(bCancel.Content), &cMeta)
	check("取消-接收方收到取消同步", bCancel.FromUser == "p32a" && cMeta["upload_id"] == uploadID3, "")
	_, gotACancel := a.WaitTypesOpt(3*time.Second, 41)
	check("取消-发送方多端同步", gotACancel, "")
	// 取消后继续上传剩余片：会话已清理应被拒绝（410）
	code, _ = postChunk(baseQ3+"&seq=2", make([]byte, chunkSize))
	check("取消-后续分片被拒绝", code == 410, fmt.Sprintf("status=%d", code))
	// 取消后无 FILE_PERSISTED
	_, leakedPersist := b.WaitTypesOpt(2*time.Second, 33)
	check("取消-无残留PERSISTED通知", !leakedPersist, "")
	// 临时分片目录已清理
	_, statErr := os.Stat(filepath.Join("..", "im-client", "web", "static", "upload", "tmp_chunks", uploadID3))
	check("取消-临时分片目录已清理", os.IsNotExist(statErr), "")

	fmt.Printf("\n==== 阶段三十二探针结果：通过 %d 项 / 失败 %d 项 ====\n", passCount, failCount)
	if failCount > 0 {
		os.Exit(1)
	}
}
