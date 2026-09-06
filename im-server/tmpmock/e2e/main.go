// e2e 阶段四十五 导出全链路测试：登录 → AI 生成表格回复（mock）→ /export/ai/excel + /export/ai/word
// → 校验响应 url、FILE_PERSISTED 推送、下载文件内容可解析（xlsx 单元格 / docx zip 结构）
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xuri/excelize/v2"
)

const wsURL = "ws://127.0.0.1:8888/ws"
const httpBase = "http://127.0.0.1:8888"

var passCnt, failCnt int

func check(name string, ok bool, detail string) {
	if ok {
		passCnt++
		fmt.Printf("[PASS] %s  %s\n", name, detail)
	} else {
		failCnt++
		fmt.Printf("[FAIL] %s  %s\n", name, detail)
	}
}

func main() {
	user, pass, agent := "e2eexport", "e2eexport123", "导出测试"

	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		fmt.Println("WS 连接失败:", err)
		os.Exit(1)
	}
	defer ws.Close()

	login, _ := json.Marshal(map[string]interface{}{"msg_type": 7, "from_user": user, "content": pass})
	ws.WriteMessage(websocket.TextMessage, login)

	agentsGot := false
	endContent := ""
	endMsgID := float64(0)
	persisted := make(chan map[string]interface{}, 8)

	go func() {
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]interface{}
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			t, _ := m["msg_type"].(float64)
			switch int(t) {
			case 8:
				req, _ := json.Marshal(map[string]interface{}{"msg_type": 42})
				ws.WriteMessage(websocket.TextMessage, req)
			case 42:
				agentsGot = true
			case 45: // AI_STREAM_END
				endContent, _ = m["content"].(string)
				endMsgID, _ = m["msg_id"].(float64)
			case 33: // FILE_PERSISTED（阶段四十五导出文件消息推送）
				persisted <- m
			default:
				if int(t) == 0 {
					continue
				}
				// 打印非通用类型辅助排查（首次运行校准 FILE_PERSISTED 常量）
				// fmt.Printf("  [type %d] %s\n", int(t), string(raw))
			}
		}
	}()

	dl := time.Now().Add(8 * time.Second)
	for !agentsGot && time.Now().Before(dl) {
		time.Sleep(100 * time.Millisecond)
	}
	check("登录+智能体列表", agentsGot, agent)

	ask, _ := json.Marshal(map[string]interface{}{"msg_type": 43, "to_user": agent, "content": "给我一个人员表格"})
	ws.WriteMessage(websocket.TextMessage, ask)

	dl = time.Now().Add(15 * time.Second)
	for (endContent == "" || endMsgID == 0) && time.Now().Before(dl) {
		time.Sleep(100 * time.Millisecond)
	}
	check("AI 表格回复到达（END 帧）", strings.Contains(endContent, "| 姓名 |") && endMsgID > 0, fmt.Sprintf("msg_id=%.0f len=%d", endMsgID, len(endContent)))

	exportOne := func(kind string) (string, int) {
		u := fmt.Sprintf("%s/export/ai/%s?msg_id=%.0f&username=%s", httpBase, kind, endMsgID, url.QueryEscape(user))
		resp, err := http.Post(u, "application/json", nil)
		if err != nil {
			return "", -1
		}
		defer resp.Body.Close()
		var r map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&r)
		u2, _ := r["url"].(string)
		return u2, resp.StatusCode
	}

	xlURL, xlCode := exportOne("excel")
	check("Excel 导出 200", xlCode == 200, xlURL)
	wdURL, wdCode := exportOne("word")
	check("Word 导出 200", wdCode == 200, wdURL)

	// FILE_PERSISTED 推送校验（两条）
	dl = time.Now().Add(5 * time.Second)
	gotPush := 0
	for time.Now().Before(dl) {
		select {
		case <-persisted:
			gotPush++
		default:
			time.Sleep(50 * time.Millisecond)
		}
		if gotPush >= 2 {
			break
		}
	}
	check("FILE_PERSISTED 推送 2 条", gotPush == 2, fmt.Sprintf("got=%d", gotPush))

	// 下载并解析 Excel
	resp, err := http.Get(httpBase + xlURL)
	if err == nil {
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		f, err := excelize.OpenReader(bytes.NewReader(data))
		if err != nil {
			check("Excel 可解析", false, err.Error())
		} else {
			v, _ := f.GetCellValue("表格1", "A2")
			v2, _ := f.GetCellValue("表格1", "C3")
			check("Excel 可解析", v == "张三" && v2 == "含|竖线", fmt.Sprintf("A2=%q C3=%q", v, v2))
		}
	} else {
		check("Excel 可解析", false, err.Error())
	}

	// 下载并解析 Word（zip 三件套 + 内容校验）
	resp2, err := http.Get(httpBase + wdURL)
	if err == nil {
		data, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			check("Word 可解析", false, err.Error())
		} else {
			ok := false
			var doc string
			for _, f := range zr.File {
				if f.Name == "word/document.xml" {
					rc, _ := f.Open()
					buf := new(bytes.Buffer)
					buf.ReadFrom(rc)
					rc.Close()
					doc = buf.String()
					ok = strings.Contains(doc, "张三") && strings.Contains(doc, "组长") && strings.Contains(doc, "<w:tbl>")
				}
			}
			check("Word 可解析（表格/加粗内容）", ok, fmt.Sprintf("len=%d", len(doc)))
		}
	} else {
		check("Word 可解析", false, err.Error())
	}

	// 越权校验：msg_id 伪造（改大）→ 404；他人回复不可导出
	badResp, _ := http.Post(fmt.Sprintf("%s/export/ai/excel?msg_id=99999999&username=%s", httpBase, url.QueryEscape(user)), "application/json", nil)
	if badResp != nil {
		badResp.Body.Close()
	}
	check("伪造 msg_id 被拒", badResp != nil && badResp.StatusCode == 404, fmt.Sprintf("status=%d", statusCodeOf(badResp)))

	// ===== 阶段四十五 D：文档问答链路（上传解析 → 文档信封提问 → mock 请求体断言） =====

	// 本地构造四种格式文档：docx（zip 手写正文）/ xlsx（excelize）/ csv / md
	docDir, _ := os.MkdirTemp("", "e2edoc")
	defer os.RemoveAll(docDir)

	docxXML := "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
		"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>" +
		"<w:p><w:r><w:t>季度报告正文</w:t></w:r></w:p>" +
		"<w:p><w:r><w:t>项目 A 收入 100 万</w:t></w:r></w:p>" +
		"</w:body></w:document>"
	docxPath := docDir + "/季度报告.docx"
	buildDocx(docxPath, docxXML)

	xlsxPath := docDir + "/数据表.xlsx"
	xf := excelize.NewFile()
	xf.SetCellValue(xf.GetSheetName(0), "A1", "指标")
	xf.SetCellValue(xf.GetSheetName(0), "B1", "数值")
	xf.SetCellValue(xf.GetSheetName(0), "A2", "DAU")
	xf.SetCellValue(xf.GetSheetName(0), "B2", "10000")
	xf.SaveAs(xlsxPath)

	csvPath := docDir + "/清单.csv"
	os.WriteFile(csvPath, []byte("物品,数量\n苹果,3\n香蕉,5\n"), 0644)

	mdPath := docDir + "/说明.md"
	os.WriteFile(mdPath, []byte("# 使用说明\n\n这是 markdown 文档正文。"), 0644)

	// 逐个上传 → 断言 url + 提取字符数 > 0
	uploadDoc := func(path string) map[string]interface{} {
		fp, err := os.Open(path)
		if err != nil {
			return map[string]interface{}{"_err": err.Error()}
		}
		defer fp.Close()
		body := &bytes.Buffer{}
		mw := multipart.NewWriter(body)
		fw, _ := mw.CreateFormFile("file", filepath.Base(path))
		io.Copy(fw, fp)
		mw.Close()
		u := fmt.Sprintf("%s/upload/ai/doc?username=%s&to_user=%s", httpBase, url.QueryEscape(user), url.QueryEscape(agent))
		resp, err := http.Post(u, mw.FormDataContentType(), body)
		if err != nil {
			return map[string]interface{}{"_err": err.Error()}
		}
		defer resp.Body.Close()
		var r map[string]interface{}
		if err := json.NewDecoder(resp.Body).Decode(&r); err != nil || r == nil {
			// 非法扩展名等场景服务端返回纯文本错误体：保留状态码供断言
			r = map[string]interface{}{}
		}
		r["_status"] = float64(resp.StatusCode) // json 数字为 float64 口径，统一类型便于断言
		return r
	}

	type docCase struct {
		name     string
		path     string
		contains string
	}
	cases := []docCase{
		{"季度报告.docx", docxPath, "季度报告正文"},
		{"数据表.xlsx", xlsxPath, "DAU"},
		{"清单.csv", csvPath, "苹果"},
		{"说明.md", mdPath, "markdown 文档正文"},
	}
	docURLs := make(map[string]string)
	for _, c := range cases {
		r := uploadDoc(c.path)
		st, _ := r["_status"].(float64)
		u, _ := r["url"].(string)
		chars, _ := r["chars"].(float64)
		ok := st == 200 && u != "" && chars > 0
		check("上传 "+c.name+"（解析 "+fmt.Sprintf("%.0f", chars)+" 字）", ok, fmt.Sprintf("status=%.0f url=%s", st, u))
		docURLs[c.name] = u
	}

	// 非白名单扩展名拒绝
	exePath := docDir + "/病毒.exe"
	os.WriteFile(exePath, []byte("MZfake"), 0644)
	r := uploadDoc(exePath)
	st, _ := r["_status"].(float64)
	check("非法扩展名拒绝", st == 400, fmt.Sprintf("status=%.0f", st))

	// 文档信封提问（无附言 → 服务端默认指令）→ 断言 mock 请求体含文档全文信封
	if docURLs["说明.md"] != "" {
		env, _ := json.Marshal(map[string]string{"doc": docURLs["说明.md"], "name": "说明.md", "text": ""})
		ask2, _ := json.Marshal(map[string]interface{}{"msg_type": 43, "to_user": agent, "content": string(env)})
		ws.WriteMessage(websocket.TextMessage, ask2)
		dl = time.Now().Add(15 * time.Second)
		endContent = ""
		endMsgID = 0
		for (endContent == "" || endMsgID == 0) && time.Now().Before(dl) {
			time.Sleep(100 * time.Millisecond)
		}
		check("文档提问 END 帧到达", endContent != "" && endMsgID > 0, fmt.Sprintf("len=%d", len(endContent)))

		// mock 记录的最近请求体应含：文档全文信封 + 默认指令（无附言时）
		reqStr := string(readLastRequest())
		check("文档全文进入模型提示词", strings.Contains(reqStr, "【用户上传文档：说明.md】") && strings.Contains(reqStr, "markdown 文档正文"),
			fmt.Sprintf("len=%d", len(reqStr)))
		check("无附言默认指令", strings.Contains(reqStr, "请总结这份文档的核心内容"), "")

		// 带附言提问 csv 文档 → 断言附言原文进入提示词
		if docURLs["清单.csv"] != "" {
			env3, _ := json.Marshal(map[string]string{"doc": docURLs["清单.csv"], "name": "清单.csv", "text": "一共有几件物品"})
			ask3, _ := json.Marshal(map[string]interface{}{"msg_type": 43, "to_user": agent, "content": string(env3)})
			ws.WriteMessage(websocket.TextMessage, ask3)
			dl = time.Now().Add(15 * time.Second)
			endContent = ""
			endMsgID = 0
			for (endContent == "" || endMsgID == 0) && time.Now().Before(dl) {
				time.Sleep(100 * time.Millisecond)
			}
			reqStr3 := string(readLastRequest())
			check("附言原文进入模型提示词", strings.Contains(reqStr3, "用户问题：一共有几件物品") && strings.Contains(reqStr3, "苹果 | 3"),
				fmt.Sprintf("len=%d", len(reqStr3)))
		}
	}

	fmt.Printf("\n===== 结果：%d 通过 / %d 失败 =====\n", passCnt, failCnt)
	if failCnt > 0 {
		os.Exit(1)
	}
}

// buildDocx e2e 临时构造 docx（zip 两件套：Content_Types + document.xml）
func buildDocx(path, document string) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, _ := zw.Create("[Content_Types].xml")
	fw.Write([]byte("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>"))
	fw, _ = zw.Create("word/document.xml")
	fw.Write([]byte(document))
	zw.Close()
	os.WriteFile(path, buf.Bytes(), 0644)
}

// readLastRequest 读取 mock 记录的最近请求体（mock 锚定其 exe 目录即 tmpmock 落盘；
// 本测试可能从 im-server 根目录或 tmpmock/e2e 目录启动，按候选路径兼容两种 cwd）
func readLastRequest() []byte {
	for _, p := range []string{"tmpmock/last_request.json", "../last_request.json", "last_request.json"} {
		if data, err := os.ReadFile(p); err == nil && len(data) > 0 {
			return data
		}
	}
	return nil
}

func statusCodeOf(r *http.Response) int {
	if r == nil {
		return -1
	}
	return r.StatusCode
}
