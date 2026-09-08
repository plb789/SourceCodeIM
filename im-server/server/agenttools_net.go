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
	"time"

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

// 运行时配置（InitAgent 从 config.yaml ai.agent 节点加载）
var (
	agentHttpEnabled      = false // http_request 工具开关（nil 配置=默认开启，InitAgent 归口）
	agentHttpAllowPrivate = true  // 是否允许访问内网/回环地址（内网信任部署默认允许）
	agentSearchEnabled    = false // web_search 工具开关（默认关闭，须显式开启）
	agentSearchProvider   = ""    // tavily / bocha / searxng / duckduckgo
	agentSearchAPIKey     = ""    // tavily/bocha API Key
	agentSearchEndpoint   = ""    // searxng 自建实例地址
)

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
	if agentHttpAllowPrivate {
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
	timeout := agentToolTimeout
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
	if !agentSearchEnabled {
		return "错误：联网搜索未开启（服务端 config.yaml ai.agent.web_search 配置 enabled=true 并选择 provider）"
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
	switch agentSearchProvider {
	case "tavily":
		return agentSearchTavily(query, count)
	case "bocha":
		return agentSearchBocha(query, count)
	case "searxng":
		return agentSearchSearXNG(query, count)
	case "duckduckgo":
		return agentSearchDuckDuckGo(query, count)
	}
	return "错误：未知的搜索服务商 provider=" + agentSearchProvider + "（支持 tavily/bocha/searxng/duckduckgo）"
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
	if agentSearchAPIKey == "" {
		return "错误：搜索服务商 tavily 需要 API Key（config.yaml ai.agent.web_search.api_key）"
	}
	body := fmt.Sprintf(`{"api_key":%q,"query":%q,"max_results":%d,"search_depth":"basic"}`, agentSearchAPIKey, query, count)
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
	if agentSearchAPIKey == "" {
		return "错误：搜索服务商 bocha 需要 API Key（config.yaml ai.agent.web_search.api_key）"
	}
	body := fmt.Sprintf(`{"query":%q,"count":%d,"summary":true}`, query, count)
	data, err := agentSearchPost("https://api.bochaai.com/v1/web-search",
		map[string]string{"Authorization": "Bearer " + agentSearchAPIKey}, body)
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
	if agentSearchEndpoint == "" {
		return "错误：搜索服务商 searxng 需要配置实例地址（config.yaml ai.agent.web_search.endpoint，如 http://127.0.0.1:8889）"
	}
	api := strings.TrimRight(agentSearchEndpoint, "/") + "/search?q=" + url.QueryEscape(query) + "&format=json"
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
