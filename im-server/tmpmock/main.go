// mockdoc 阶段四十五 E2E 临时工具：本地模拟文本模型 SSE 服务，回复固定 Markdown（含表格）
// 阶段四十五 D：记录最近一次请求体到 last_request.json（E2E 断言文档信封全文进入模型提示词）
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

const reply = "## 人员表\n\n| 姓名 | 年龄 | 备注 |\n|:-----|-----:|------|\n| 张三 | 25 | **组长** |\n| 李四 | 30 | 含\\|竖线 |\n\n以上就是表格内容。"

// lastReqPath 锚定 mock 可执行文件所在目录（tmpmock），与启动时的工作目录无关
func lastReqPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "last_request.json"
	}
	return filepath.Join(filepath.Dir(exe), "last_request.json")
}

func main() {
	http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		// 记录最近一次请求体（文档问答 E2E 断言用）
		if body, err := io.ReadAll(r.Body); err == nil {
			os.WriteFile(lastReqPath(), body, 0644)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		f := w.(http.Flusher)
		runes := []rune(reply)
		step := 5
		for i := 0; i < len(runes); i += step {
			end := i + step
			if end > len(runes) {
				end = len(runes)
			}
			chunk, _ := json.Marshal(map[string]interface{}{
				"choices": []map[string]interface{}{{"delta": map[string]string{"content": string(runes[i:end])}}},
			})
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			f.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		f.Flush()
	})
	log.Fatal(http.ListenAndServe("127.0.0.1:19128", nil))
}
