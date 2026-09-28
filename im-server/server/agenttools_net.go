package server

// 阶段六十八：Agent 工具扩展（HTTP 请求 + 联网搜索）
// http_request：服务端代理 HTTP 接口调用（调接口/查数据/抓取网页），GET/HEAD 只读自动放行，
// POST/PUT/DELETE/PATCH 非只读方法走审批；响应体截断回传防撑爆模型上下文。
// web_search：多服务商联网搜索（tavily/bocha/searxng/duckduckgo），config.yaml ai.agent.web_search 配置归口，
// 只读操作自动放行。
// 两工具均为纯网络操作，始终服务端执行（与 todo_write 同列 server-only，不下放 PC 本地执行器）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	// 阶段一百六十九：别名防与标准库 html（UnescapeString）冲突
	xhtml "golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// 体积与次数上限
const (
	agentHttpOutMaxChars = 20000   // http_request 响应体回传字符上限（防超长输出撑爆模型上下文）
	agentHttpBodyMax     = 1 << 20 // http_request 响应体读取上限（1MB，超长不再读取）
	agentSearchMaxCount  = 10      // web_search 单次结果条数上限
	agentSearchTimeout   = 20 * time.Second
	agentHttpDialTimeout = 10 * time.Second
)

// 运行时配置（InitAgent 从 config.yaml ai.agent 节点加载）。
// 阶段八十二：后台管理可热改（atomic），落库 im_agent_whitelist 重启不丢
var (
	agentHttpEnabled      atomic.Bool // http_request 工具开关（nil 配置=默认开启，InitAgent 归口）
	agentHttpAllowPrivate atomic.Bool // 是否允许访问内网/回环地址（内网信任部署默认允许）
	agentSearchEnabled    atomic.Bool // web_search 工具开关（默认关闭，须显式开启）
)

// agentSearchCfg web_search 服务商配置快照（provider/key/endpoint 三元组整体替换防撕裂）
type agentSearchCfg struct {
	Provider string // tavily / bocha / searxng / duckduckgo
	APIKey   string // tavily/bocha API Key
	Endpoint string // searxng 自建实例地址
}

var agentSearchConf atomic.Value // *agentSearchCfg

// agentSearchConfig 读取当前搜索配置快照（未初始化时返回零值结构）
func agentSearchConfig() *agentSearchCfg {
	if v, ok := agentSearchConf.Load().(*agentSearchCfg); ok && v != nil {
		return v
	}
	return &agentSearchCfg{}
}

// agentSearchConfigStore 整体替换搜索配置快照（InitAgent 启动加载与后台保存归口）
func agentSearchConfigStore(provider, apiKey, endpoint string) {
	agentSearchConf.Store(&agentSearchCfg{
		Provider: strings.ToLower(strings.TrimSpace(provider)),
		APIKey:   strings.TrimSpace(apiKey),
		Endpoint: strings.TrimSpace(endpoint),
	})
}

// agentHTTPMethods http_request 允许的 HTTP 方法（白名单外方法直接报错）
var agentHTTPMethods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "DELETE": true, "PATCH": true,
}

// agentIsPrivateIP 私网地址判定归口（回环/私网/链路本地/未指定地址）
func agentIsPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// agentHTTPTransport HTTP 客户端传输层归口：http_allow_private=false 时在拨号层（Control 前置的
// DialContext 地址解析回调）拦截私网/回环地址——回调拿到的是 DNS 解析后的真实 IP，域名解析绕不过
func agentHTTPTransport() *http.Transport {
	t := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if agentHttpAllowPrivate.Load() {
		return t
	}
	dialer := &net.Dialer{Timeout: agentHttpDialTimeout}
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if host, _, err := net.SplitHostPort(addr); err == nil {
			if ip := net.ParseIP(host); ip != nil && agentIsPrivateIP(ip) {
				return nil, errors.New("已禁止访问内网/回环地址（http_allow_private=false）")
			}
		}
		return dialer.DialContext(ctx, network, addr)
	}
	return t
}

// agentToolHttpRequest http_request 工具执行：服务端代理 HTTP 请求并回传
// 状态码 + Content-Type + 响应体（截断）。HTTP >= 400 以"错误："前缀返回（前端标红 + 模型据此自纠），
// 响应体照常带回供模型分析接口报错内容
func agentToolHttpRequest(params map[string]interface{}) string {
	method := strings.ToUpper(strings.TrimSpace(agentParamString(params["method"])))
	if method == "" {
		method = "GET"
	}
	if !agentHTTPMethods[method] {
		return "错误：method 仅支持 GET/HEAD/POST/PUT/DELETE/PATCH"
	}
	rawURL := strings.TrimSpace(agentParamString(params["url"]))
	if rawURL == "" {
		return "错误：url 不能为空"
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "错误：url 无效（仅支持 http/https 完整地址）"
	}
	timeout := time.Duration(agentToolTimeout.Load()) * time.Second
	if v, ok := params["timeout"].(float64); ok && v > 0 {
		if v > agentCmdTimeoutMax {
			v = agentCmdTimeoutMax
		}
		timeout = time.Duration(v) * time.Second
	}
	// 自定义请求头（模型传键值对；空键过滤）
	headers := make(map[string]string)
	if hm, ok := params["headers"].(map[string]interface{}); ok {
		for k, v := range hm {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			headers[http.CanonicalHeaderKey(k)] = agentParamString(v)
		}
	}
	body := agentParamString(params["body"])
	if body != "" && method != "GET" && method != "HEAD" {
		if _, ok := headers["Content-Type"]; !ok {
			headers["Content-Type"] = "application/json" // 调接口场景默认 JSON，模型可经 headers 覆盖
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(body))
	if err != nil {
		return "错误：请求构建失败 " + err.Error()
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: timeout, Transport: agentHTTPTransport()}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Sprintf("错误：请求超时（%v），已中止", timeout)
		}
		return "错误：请求失败 " + err.Error()
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, agentHttpBodyMax))
	text := string(data)
	// GBK 编码兜底：中文站点常见 GBK 响应，UTF-8 解码出现替换符时尝试转码（与 read_file 同款策略）
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, gerr := simplifiedchinese.GBK.NewDecoder().Bytes(data); gerr == nil {
			text = string(gbk)
		}
	}
	runes := []rune(text)
	if len(runes) > agentHttpOutMaxChars {
		text = string(runes[:agentHttpOutMaxChars]) + fmt.Sprintf("\n…（响应体过长已截断，共 %d 字符）", len(runes))
	}

	var b strings.Builder
	if resp.StatusCode >= 400 {
		fmt.Fprintf(&b, "错误：HTTP %d %s\n", resp.StatusCode, resp.Status)
	} else {
		fmt.Fprintf(&b, "HTTP %d %s\n", resp.StatusCode, resp.Status)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		b.WriteString("Content-Type: " + ct + "\n")
	}
	if body == "" && method != "HEAD" && strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		b.WriteString("（网页 HTML 内容，可结合摘要定位关键信息）\n")
	}
	b.WriteString("\n响应体：\n")
	b.WriteString(text)
	if method == "HEAD" || len(runes) == 0 {
		b.WriteString("（无响应体）")
	}
	return b.String()
}

// ===== fetch_page 网页阅读（阶段一百六十九） =====
// 抓取网页 → HTML 转 Markdown 正文（去脚本/样式/导航/交互控件噪音，标题/链接/列表/代码/表格
// 结构化保留）→ 截断回传。TRAE CN fetch 工具同语义：给模型直接可读的结构化正文，
// 替代 http_request 抓网页时的整页 HTML 标签噪音（省 token、提高阅读准确率）。
// 只读 GET，始终服务端执行，与 http_request 共用内网拦截/超时/编码解码归口。

const (
	agentFetchOutMaxChars = 20000                                                                                                             // fetch_page 正文回传字符上限（与 http_request 同量级）
	agentFetchUA          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" // 浏览器 UA 防简单反爬（http_request 保持无 UA 语义不变）
)

// agentMDSkipTags 转 Markdown 时整体跳过的噪音标签——脚本样式/元信息/交互控件/媒体/
// 版头版尾导航（正文优先；title 单独提取不作正文）
var agentMDSkipTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true, "iframe": true,
	"svg": true, "canvas": true, "object": true, "embed": true,
	"meta": true, "link": true, "title": true, "head": true,
	"input": true, "button": true, "select": true, "option": true, "textarea": true, "form": true, "label": true,
	"img": true, "picture": true, "video": true, "audio": true, "source": true, "track": true,
	"nav": true, "header": true, "footer": true, "aside": true, "dialog": true,
}

// agentMDInlineTags 行内标签（不影响块级空行边界，透明渲染）
var agentMDInlineTags = map[string]bool{
	"a": true, "code": true, "b": true, "strong": true, "i": true, "em": true,
	"span": true, "small": true, "sub": true, "sup": true, "u": true, "s": true, "mark": true, "abbr": true,
}

// agentMDWriter HTML→Markdown 转换状态
type agentMDWriter struct {
	b        strings.Builder
	base     *url.URL // 相对链接绝对化基准（页面 URL）
	inPre    int      // >0 表示处于 <pre> 内（空白原样保留）
	linkHref string   // 处于 <a> 内时的目标地址（空=非链接上下文）
	linkText strings.Builder
	listTag  []string // 列表类型栈（ul/ol）
	olIdx    []int    // 有序列表各层计数器
	tableRow int      // 表格当前行号（首行后补分隔线）
	tableCol int      // 首行列数（分隔线复用）
}

// agentMDCollapse 折叠连续空白为单空格（pre 外文本归一化）
func agentMDCollapse(s string) string {
	var b strings.Builder
	sp := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			sp = true
			continue
		}
		if sp && b.Len() > 0 {
			b.WriteByte(' ')
		}
		sp = false
		b.WriteRune(r)
	}
	return b.String()
}

// needSpace 尾字符是否允许补词间空格（防 <b>x</b> <i>y</i> 词间空格被折叠丢弃后粘连）
func (w *agentMDWriter) needSpace() bool {
	s := w.b.String()
	if s == "" {
		return false
	}
	r, _ := utf8.DecodeLastRuneInString(s)
	return r != ' ' && r != '\n' && r != '\t'
}

// text 文本节点输出：链接内文本归集到 linkText（退出 <a> 时整体成 [text](href)），
// pre 内原样，其余折叠空白（全空白时若词间需要则补单空格）
func (w *agentMDWriter) text(s string) {
	if w.linkHref != "" {
		w.linkText.WriteString(s)
		return
	}
	if w.inPre > 0 {
		w.b.WriteString(s)
		return
	}
	out := agentMDCollapse(s)
	if out == "" {
		if strings.ContainsAny(s, " \t\n\r") && w.needSpace() {
			w.b.WriteString(" ")
		}
		return
	}
	w.b.WriteString(out)
}

// agentMDAttr 取元素属性值（无则空串）
func agentMDAttr(n *xhtml.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// render 递归渲染节点为 Markdown
func (w *agentMDWriter) render(n *xhtml.Node) {
	if n.Type == xhtml.TextNode {
		w.text(n.Data)
		return
	}
	if n.Type != xhtml.ElementNode {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			w.render(c)
		}
		return
	}
	tag := n.Data
	if agentMDSkipTags[tag] {
		return
	}
	children := func() {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			w.render(c)
		}
	}
	switch tag {
	case "br":
		if w.inPre == 0 {
			w.b.WriteString("\n")
		}
		return
	case "hr":
		w.b.WriteString("\n\n---\n\n")
		return
	case "a":
		href := strings.TrimSpace(agentMDAttr(n, "href"))
		if href == "" || strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "#") {
			children() // 锚点/脚本链接无阅读价值：只渲染文本
			return
		}
		full := href
		if ref, err := url.Parse(href); err == nil && w.base != nil {
			full = w.base.ResolveReference(ref).String()
		}
		prev := w.linkHref
		w.linkHref = full
		children()
		txt := strings.TrimSpace(w.linkText.String())
		w.linkText.Reset()
		w.linkHref = prev
		if txt != "" {
			w.b.WriteString("[" + txt + "](" + full + ")")
		}
		return
	case "pre":
		w.inPre++
		w.b.WriteString("\n\n```\n")
		children()
		w.b.WriteString("\n```\n\n")
		w.inPre--
		return
	case "code":
		if w.inPre > 0 {
			children()
			return
		}
		w.b.WriteString("`")
		children()
		w.b.WriteString("`")
		return
	case "b", "strong":
		w.b.WriteString("**")
		children()
		w.b.WriteString("**")
		return
	case "i", "em":
		w.b.WriteString("*")
		children()
		w.b.WriteString("*")
		return
	case "h1", "h2", "h3", "h4", "h5", "h6":
		w.b.WriteString("\n\n" + strings.Repeat("#", int(tag[1]-'0')) + " ")
		children()
		w.b.WriteString("\n\n")
		return
	case "li":
		marker := "- "
		if len(w.listTag) > 0 && w.listTag[len(w.listTag)-1] == "ol" {
			w.olIdx[len(w.olIdx)-1]++
			marker = fmt.Sprintf("%d. ", w.olIdx[len(w.olIdx)-1])
		}
		w.b.WriteString("\n" + marker)
		children() // close 不补换行：下一 li 的 open 换行 + 列表收尾自带边界（防列表项间空行）
		return
	case "ul", "ol":
		w.listTag = append(w.listTag, tag)
		w.olIdx = append(w.olIdx, 0)
		w.b.WriteString("\n")
		children()
		w.listTag = w.listTag[:len(w.listTag)-1]
		w.olIdx = w.olIdx[:len(w.olIdx)-1]
		w.b.WriteString("\n")
		return
	case "tr":
		w.tableRow++
		if w.tableRow == 2 && w.tableCol > 0 { // 首行后补表头分隔线
			w.b.WriteString(strings.Repeat("---|", w.tableCol) + "\n")
		}
		w.b.WriteString("|")
		children()
		w.b.WriteString("\n")
		return
	case "td", "th":
		if w.tableRow == 1 {
			w.tableCol++
		}
		w.b.WriteString(" ")
		children()
		w.b.WriteString(" |")
		return
	}
	if agentMDInlineTags[tag] {
		children()
		return
	}
	// 其余标签默认块级：前后空行边界（多余空行由 normalize 压缩）
	w.b.WriteString("\n\n")
	children()
	w.b.WriteString("\n\n")
}

// agentMDNormalize 压缩连续空行 + 去行尾空白 + 整体裁剪
func agentMDNormalize(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t\r")
		if ln == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// agentHTMLToMarkdown HTML 正文转 Markdown，返回 (markdown, 页面标题)
func agentHTMLToMarkdown(body, baseURL string) (string, string) {
	doc, err := xhtml.Parse(strings.NewReader(body))
	if err != nil {
		return "", ""
	}
	// 页面标题提取（<title> 文本）
	var title string
	var findTitle func(n *xhtml.Node)
	findTitle = func(n *xhtml.Node) {
		if title != "" || n.Type != xhtml.ElementNode || n.Data != "title" {
			if title == "" {
				for c := n.FirstChild; c != nil && title == ""; c = c.NextSibling {
					findTitle(c)
				}
			}
			return
		}
		if n.FirstChild != nil && n.FirstChild.Type == xhtml.TextNode {
			title = strings.TrimSpace(n.FirstChild.Data)
		}
	}
	findTitle(doc)
	base, _ := url.Parse(baseURL)
	w := &agentMDWriter{base: base}
	w.render(doc)
	return agentMDNormalize(w.b.String()), title
}

// agentDecodeHTMLBody 响应体解码归口：Content-Type 显式 GB 系字符集或 UTF-8 出现替换符时按 GBK 转码
// （与 read_file/http_request 同款策略，覆盖中文站点常见 GBK 页面）
func agentDecodeHTMLBody(data []byte, contentType string) string {
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "charset=gb") || strings.Contains(ct, "charset=gbk") || strings.Contains(ct, "charset=gb2312") {
		if gbk, err := simplifiedchinese.GBK.NewDecoder().Bytes(data); err == nil {
			return string(gbk)
		}
	}
	text := string(data)
	if strings.ContainsRune(text, 0xFFFD) {
		if gbk, err := simplifiedchinese.GBK.NewDecoder().Bytes(data); err == nil {
			return string(gbk)
		}
	}
	return text
}

// agentToolFetchPage fetch_page 工具执行：GET 抓取网页 → HTML 转 Markdown → 截断回传
func agentToolFetchPage(params map[string]interface{}) string {
	rawURL := strings.TrimSpace(agentParamString(params["url"]))
	if rawURL == "" {
		return "错误：url 不能为空"
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "错误：url 无效（仅支持 http/https 完整地址）"
	}
	timeout := time.Duration(agentToolTimeout.Load()) * time.Second
	if v, ok := params["timeout"].(float64); ok && v > 0 {
		if v > agentCmdTimeoutMax {
			v = agentCmdTimeoutMax
		}
		timeout = time.Duration(v) * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "错误：请求构建失败 " + err.Error()
	}
	req.Header.Set("User-Agent", agentFetchUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	client := &http.Client{Timeout: timeout, Transport: agentHTTPTransport()}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Sprintf("错误：请求超时（%v），已中止", timeout)
		}
		return "错误：请求失败 " + err.Error()
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, agentHttpBodyMax))
	if resp.StatusCode >= 400 {
		return fmt.Sprintf("错误：HTTP %d %s", resp.StatusCode, resp.Status)
	}
	var b strings.Builder
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "html") && !strings.Contains(ct, "xml") && ct != "" {
		// 非网页内容（json/纯文本/图片等）：fetch_page 语义不匹配，指引模型换工具
		return fmt.Sprintf("提示：该地址 Content-Type 为 %s，非网页内容，请改用 http_request 获取原始响应体。", ct)
	}
	text := agentDecodeHTMLBody(data, ct)
	md, title := agentHTMLToMarkdown(text, u.String())
	if md == "" {
		return "提示：页面无可提取正文（可能为纯脚本渲染页面），请改用内置浏览器工具打开后再读取。"
	}
	runes := []rune(md)
	if len(runes) > agentFetchOutMaxChars {
		md = string(runes[:agentFetchOutMaxChars]) + fmt.Sprintf("\n…（正文过长已截断，共 %d 字符）", len(runes))
	}
	b.WriteString(fmt.Sprintf("HTTP %d %s\n", resp.StatusCode, resp.Status))
	if title != "" {
		b.WriteString("标题: " + title + "\n")
	}
	b.WriteString("\n" + md)
	return b.String()
}

// ===== web_search 联网搜索 =====

// agentSearchResult 单条搜索结果
type agentSearchResult struct {
	Title   string
	URL     string
	Snippet string
}

// agentParamString 模型参数取字符串归口（数字/布尔等标量统一转字符串，空值返回空串）
func agentParamString(v interface{}) string {
	switch s := v.(type) {
	case string:
		return s
	case float64:
		return fmt.Sprintf("%v", s)
	case bool:
		return fmt.Sprintf("%v", s)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", s)
	}
}

// agentToolWebSearch web_search 工具执行归口：按配置服务商分发，统一格式化回传
func agentToolWebSearch(params map[string]interface{}) string {
	if !agentSearchEnabled.Load() {
		return "错误：联网搜索未开启（后台管理 Agent 设置或 config.yaml ai.agent.web_search 配置 enabled=true 并选择 provider）"
	}
	query := strings.TrimSpace(agentParamString(params["query"]))
	if query == "" {
		return "错误：query 不能为空"
	}
	count := 5
	if v, ok := params["count"].(float64); ok && v > 0 {
		count = int(v)
		if count > agentSearchMaxCount {
			count = agentSearchMaxCount
		}
	}
	scfg := agentSearchConfig()
	switch scfg.Provider {
	case "tavily":
		return agentSearchTavily(query, count)
	case "bocha":
		return agentSearchBocha(query, count)
	case "searxng":
		return agentSearchSearXNG(query, count)
	case "duckduckgo":
		return agentSearchDuckDuckGo(query, count)
	}
	return "错误：未知的搜索服务商 provider=" + scfg.Provider + "（支持 tavily/bocha/searxng/duckduckgo）"
}

// agentSearchFormat 搜索结果统一格式化归口
func agentSearchFormat(results []agentSearchResult) string {
	if len(results) == 0 {
		return "未搜索到相关结果"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "共 %d 条结果：", len(results))
	for i, r := range results {
		fmt.Fprintf(&b, "\n\n%d. %s\n   链接：%s", i+1, r.Title, r.URL)
		if r.Snippet != "" {
			fmt.Fprintf(&b, "\n   摘要：%s", r.Snippet)
		}
	}
	return b.String()
}

// agentSearchPost 服务商 POST 请求归口（JSON 收发，20 秒超时，响应体 1MB 上限）
func agentSearchPost(apiURL string, headers map[string]string, body string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), agentSearchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: agentSearchTimeout, Transport: agentHTTPTransport()}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, agentHttpBodyMax))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d：%s", resp.StatusCode, truncateRunes(string(data), 300))
	}
	return data, nil
}

// agentSearchTavily Tavily 搜索（AI 检索 API，https://api.tavily.com）
func agentSearchTavily(query string, count int) string {
	key := agentSearchConfig().APIKey
	if key == "" {
		return "错误：搜索服务商 tavily 需要 API Key（后台管理 Agent 设置或 config.yaml ai.agent.web_search.api_key）"
	}
	body := fmt.Sprintf(`{"api_key":%q,"query":%q,"max_results":%d,"search_depth":"basic"}`, key, query, count)
	data, err := agentSearchPost("https://api.tavily.com/search", nil, body)
	if err != nil {
		return "错误：搜索请求失败 " + err.Error()
	}
	var resp struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return "错误：搜索响应解析失败 " + err.Error()
	}
	results := make([]agentSearchResult, 0, len(resp.Results))
	for _, r := range resp.Results {
		results = append(results, agentSearchResult{Title: r.Title, URL: r.URL, Snippet: truncateRunes(r.Content, 300)})
	}
	return agentSearchFormat(results)
}

// agentSearchBocha 博查搜索（国内服务商，https://api.bochaai.com/v1/web-search）
func agentSearchBocha(query string, count int) string {
	key := agentSearchConfig().APIKey
	if key == "" {
		return "错误：搜索服务商 bocha 需要 API Key（后台管理 Agent 设置或 config.yaml ai.agent.web_search.api_key）"
	}
	body := fmt.Sprintf(`{"query":%q,"count":%d,"summary":true}`, query, count)
	data, err := agentSearchPost("https://api.bochaai.com/v1/web-search",
		map[string]string{"Authorization": "Bearer " + key}, body)
	if err != nil {
		return "错误：搜索请求失败 " + err.Error()
	}
	var resp struct {
		Code int `json:"code"`
		Data struct {
			WebPages struct {
				Value []struct {
					Name    string `json:"name"`
					URL     string `json:"url"`
					Snippet string `json:"snippet"`
					Summary string `json:"summary"`
				} `json:"value"`
			} `json:"webPages"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return "错误：搜索响应解析失败 " + err.Error()
	}
	if resp.Code != 0 && resp.Code != 200 {
		return fmt.Sprintf("错误：博查搜索返回异常 code=%d", resp.Code)
	}
	results := make([]agentSearchResult, 0, len(resp.Data.WebPages.Value))
	for _, r := range resp.Data.WebPages.Value {
		snippet := r.Summary
		if snippet == "" {
			snippet = r.Snippet
		}
		results = append(results, agentSearchResult{Title: r.Name, URL: r.URL, Snippet: truncateRunes(snippet, 300)})
	}
	return agentSearchFormat(results)
}

// agentSearchSearXNG SearXNG 自建实例搜索（JSON 输出格式，需实例开启 format=json）
func agentSearchSearXNG(query string, count int) string {
	endpoint := agentSearchConfig().Endpoint
	if endpoint == "" {
		return "错误：搜索服务商 searxng 需要配置实例地址（后台管理 Agent 设置或 config.yaml ai.agent.web_search.endpoint，如 http://127.0.0.1:8889）"
	}
	api := strings.TrimRight(endpoint, "/") + "/search?q=" + url.QueryEscape(query) + "&format=json"
	ctx, cancel := context.WithTimeout(context.Background(), agentSearchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err != nil {
		return "错误：搜索请求构建失败 " + err.Error()
	}
	client := &http.Client{Timeout: agentSearchTimeout, Transport: agentHTTPTransport()}
	resp, err := client.Do(req)
	if err != nil {
		return "错误：搜索请求失败 " + err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Sprintf("错误：searxng 实例返回 HTTP %d（请确认实例已开启 JSON 输出 format=json 且地址正确）", resp.StatusCode)
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, agentHttpBodyMax))
	var parsed struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return "错误：搜索响应解析失败（请确认实例开启 format=json）" + err.Error()
	}
	results := make([]agentSearchResult, 0, len(parsed.Results))
	for _, r := range parsed.Results {
		if len(results) >= count {
			break
		}
		results = append(results, agentSearchResult{Title: r.Title, URL: r.URL, Snippet: truncateRunes(r.Content, 300)})
	}
	return agentSearchFormat(results)
}

// agentDDGTagRe HTML 标签剥离归口（结果标题/摘要清洗）
var agentDDGTagRe = regexp.MustCompile(`<[^>]*>`)

// agentHTMLToText HTML 片段转纯文本（去标签 + 实体解码，搜索摘要清洗归口）
func agentHTMLToText(s string) string {
	return strings.TrimSpace(html.UnescapeString(agentDDGTagRe.ReplaceAllString(s, "")))
}

// agentDDGResultRe / agentDDGSnippetRe DuckDuckGo HTML 结果解析（result__a 链接行 + result__snippet 摘要行）
var (
	agentDDGResultRe  = regexp.MustCompile(`(?s)<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	agentDDGSnippetRe = regexp.MustCompile(`(?s)<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>`)
)

// agentDDGRealURL DuckDuckGo 跳转链接还原（uddg 参数解包；同源相对协议补 https）
func agentDDGRealURL(href string) string {
	if i := strings.Index(href, "uddg="); i >= 0 {
		q := href[i+len("uddg="):]
		if j := strings.Index(q, "&"); j >= 0 {
			q = q[:j]
		}
		if dec, err := url.QueryUnescape(q); err == nil {
			return dec
		}
	}
	if strings.HasPrefix(href, "//") {
		return "https:" + href
	}
	return href
}

// agentSearchDuckDuckGo DuckDuckGo 搜索（免 Key，HTML 结果页解析；国内网络环境可能不可达，建议 tavily/bocha）
func agentSearchDuckDuckGo(query string, count int) string {
	ctx, cancel := context.WithTimeout(context.Background(), agentSearchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://html.duckduckgo.com/html/",
		strings.NewReader(url.Values{"q": {query}}.Encode()))
	if err != nil {
		return "错误：搜索请求构建失败 " + err.Error()
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: agentSearchTimeout, Transport: agentHTTPTransport()}
	resp, err := client.Do(req)
	if err != nil {
		return "错误：搜索请求失败 " + err.Error() + "（duckduckgo 可能不可达，建议改用 tavily/bocha/searxng）"
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, agentHttpBodyMax))
	page := string(data)

	type ddgItem struct{ href, title string }
	var items []ddgItem
	for _, m := range agentDDGResultRe.FindAllStringSubmatch(page, count*3) {
		title := agentHTMLToText(m[2])
		if title == "" {
			continue
		}
		items = append(items, ddgItem{href: agentDDGRealURL(m[1]), title: title})
		if len(items) >= count {
			break
		}
	}
	if len(items) == 0 {
		if strings.Contains(page, "challenge") || strings.Contains(page, "anomaly") {
			return "错误：duckduckgo 返回人机校验页，建议改用 tavily/bocha/searxng"
		}
		return "未搜索到相关结果"
	}
	snippets := agentDDGSnippetRe.FindAllStringSubmatch(page, len(items))
	results := make([]agentSearchResult, 0, len(items))
	for i, it := range items {
		snippet := ""
		if i < len(snippets) {
			snippet = truncateRunes(agentHTMLToText(snippets[i][1]), 300)
		}
		results = append(results, agentSearchResult{Title: it.title, URL: it.href, Snippet: snippet})
	}
	return agentSearchFormat(results)
}
