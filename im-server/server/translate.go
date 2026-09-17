package server

// translate.go - 阶段一百三十九：截图"屏幕翻译"服务端归口
// 链路：客户端截图选区 → 本地系统 OCR（PC 壳 PowerShell 子进程 WinRT）→ 本接口 AI 翻译 → 浮层展示
// 设计：翻译文本走服务端统一处理（数据归口原则），复用已配置智能体的 AI 上游链路（含多源故障转移）

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// HandleTranslate 截图 OCR 文本翻译
// POST /api/translate?username=xxx  {"text":"...","target":""}
// 响应：{"ok":true,"data":{"translated":"..."}} / {"ok":false,"msg":"..."}
// target 为空时自动判向：文本中文字符过半 → 翻英文，否则 → 翻中文（QQ 同款默认行为）
func (s *Server) HandleTranslate(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return
	}
	var req struct {
		Text   string `json:"text"`
		Target string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		adminFail(w, http.StatusBadRequest, "缺少待翻译文本")
		return
	}
	// 长度上限保护（截图 OCR 场景足够，防上游 Token 浪费）；按 rune 截断避免切半个字符
	runes := []rune(text)
	if len(runes) > 5000 {
		text = string(runes[:5000])
	}
	// 翻译引擎取已配置智能体：优先公共智能体（全员语义一致），无公共再兜底第一个
	agents := aiAgentList()
	var agent *AIRunAgent
	for _, a := range agents {
		if a.Owner == "" {
			agent = a
			break
		}
	}
	if agent == nil && len(agents) > 0 {
		agent = agents[0]
	}
	if agent == nil {
		adminFail(w, http.StatusServiceUnavailable, "服务端未配置AI智能体，无法翻译")
		return
	}
	target := strings.TrimSpace(req.Target)
	if target == "" {
		// 自动判向：中文字符（CJK 基本区）占比过半视为中文文本 → 翻英文
		han := 0
		for _, ch := range text {
			if ch >= 0x4E00 && ch <= 0x9FFF {
				han++
			}
		}
		if han*2 > len(runes) {
			target = "英文"
		} else {
			target = "中文"
		}
	}
	sys := "你是翻译引擎。把用户发来的文本完整翻译成" + target + "，只输出译文本身，"
	sys += "保留原有换行与段落结构，不解释、不加注释、不输出任何多余内容。"
	msgs := []aiChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: text},
	}
	// 非流式收集（onDelta 丢弃），60s 上游超时；复用 aiStreamChat 的多源故障转移
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	translated, _, err := aiStreamChat(ctx, agent, msgs, func(string) {})
	if err != nil {
		adminFail(w, http.StatusBadGateway, "翻译失败: "+err.Error())
		return
	}
	adminJSON(w, map[string]interface{}{"translated": strings.TrimSpace(translated)})
}

// HandleScreenOCR 截图选区文字识别（视觉模型 OCR，服务端归口）
// 原实现：PC 壳本地 Windows 系统 OCR（PowerShell WinRT 子进程）——实测本机 PS 5.1 的 WinRT 投影
// 退化为裸 System.__ComObject（Status/GetResults 均不可访问），系统 OCR 通道不可用，改走视觉模型；
// 顺带收益：零本地依赖、WEB 端同样可用、任意语言识别能力一致
// POST /api/ocr?username=xxx  {"image":"data:image/png;base64,..."}
// 响应：{"ok":true,"data":{"lines":["行1","行2"]}}（模型按行输出，服务端 split 归口）
func (s *Server) HandleScreenOCR(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.URL.Query().Get("username"))
	if username == "" {
		adminFail(w, http.StatusBadRequest, "缺少 username 参数")
		return
	}
	// 选区截图 base64 体积上限 12MB（超高分辨率长截图兜底）
	var req struct {
		Image string `json:"image"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求体解析失败（图片过大或格式错误）")
		return
	}
	img := strings.TrimSpace(req.Image)
	if !strings.HasPrefix(img, "data:image/") {
		adminFail(w, http.StatusBadRequest, "缺少有效的图片数据")
		return
	}
	// 视觉智能体选取：第一个已绑定模型且支持图片识别的智能体（公共优先，与翻译同思路）
	agents := aiAgentList()
	var agent *AIRunAgent
	for _, a := range agents {
		if a.Owner == "" && a.Provider != nil && a.SupportsImage {
			agent = a
			break
		}
	}
	if agent == nil {
		for _, a := range agents {
			if a.Provider != nil && a.SupportsImage {
				agent = a
				break
			}
		}
	}
	if agent == nil {
		adminFail(w, http.StatusServiceUnavailable, "服务端未配置视觉模型（supports_image），无法提取文字")
		return
	}
	sys := "你是OCR文字识别引擎。提取图片中出现的全部文字，按图片中的原始行结构逐行输出，"
	sys += "只输出识别出的文字内容本身：不要任何说明、序号、Markdown 代码块或多余符号；"
	sys += "图片中没有文字时输出空内容。"
	msgs := []aiChatMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: []aiContentPart{
			{Type: "text", Text: "提取这张图片中的全部文字"},
			{Type: "image_url", ImageURL: &aiImageURLField{URL: img}},
		}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	text, _, err := aiStreamChat(ctx, agent, msgs, func(string) {})
	if err != nil {
		adminFail(w, http.StatusBadGateway, "文字识别失败: "+err.Error())
		return
	}
	// 行结构归口：按换行切分，剔除空行与 Markdown 代码围栏（防模型输出 ```包裹）
	raw := strings.Split(strings.TrimSpace(text), "\n")
	lines := make([]string, 0, len(raw))
	for _, ln := range raw {
		ln = strings.TrimSpace(ln)
		if ln == "" || ln == "```" {
			continue
		}
		lines = append(lines, ln)
	}
	adminJSON(w, map[string]interface{}{"lines": lines})
}
