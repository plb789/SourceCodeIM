package server

// ============================================================================
// 统一 HTML 消毒模块 —— 存储型 XSS 第二道防线
//
// 设计原则：
//  1. 白名单思维：放行标签显式列出，其他一律剥离壳保留内文
//  2. RE2 兼容：所有正则不使用 \1 反向引用（Go regexp 引擎不支持）
//  3. 安全 URL 共用：safeURL 公告+Game 共用，一处修改全局生效
//
// 调用链：
//  公告正文   → gameNoticeContentClean    （正则法，白名单较小）
//  Game 介绍  → gameDescContentClean      （正则法，白名单含 img/table）
//  评测/回复  → sanitizeReviewHTML        （DOM 树法，支持 span+style+font）
//  资料页留言 → sanitizeReviewHTML        （同上）
// ============================================================================

import (
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// safeURL 统一 URL 安全校验（公告 + Game 共用）
// 允许：http/https 完整链接、站内相对路径 /xxx、相对 ./xxx、锚点 #xxx
// 禁止：javascript:/vbscript:/data: 等危险协议；含反斜杠混淆
func safeURL(url string) bool {
	url = strings.TrimSpace(url)
	// 反斜杠统一替换为正斜杠后再校验（防 \h\ttp 这类混淆）
	low := strings.ToLower(strings.ReplaceAll(url, "\\", "/"))
	if strings.Contains(low, "javascript:") ||
		strings.Contains(low, "vbscript:") ||
		strings.Contains(low, "data:") ||
		strings.Contains(low, "file:") ||
		strings.Contains(low, "<") ||
		strings.Contains(low, ">") {
		return false
	}
	return strings.HasPrefix(low, "http://") ||
		strings.HasPrefix(low, "https://") ||
		strings.HasPrefix(url, "/") ||
		strings.HasPrefix(url, "./") ||
		strings.HasPrefix(url, "#")
}

// ----------------------------------------------------------------------------
// gameDescContentClean Game 详细介绍消毒（本次新增，白名单比公告大）
//
// 放行标签（纯标签名，不含属性白名单）：
//  段落结构：p  br  hr
//  标题：    h1  h2  h3
//  强调：    b  strong  i  em  u  s  del  mark  small
//  列表：    ul  ol  li
//  链接：    a（只放行 href，强制加 target=_blank rel=noopener）
//  图片：    img（只放行 src/alt，src 过安全校验，强制加 loading=lazy）
//  代码：    code  pre  blockquote
//  表格：    table  thead  tbody  tr  th  td
//  注释：    <!-- -->（保留，注释不执行）
//
// 剥离规则：
//  - 所有 on* 事件属性（onclick/onerror/onmouseover 等）一律剥离
//  - <a href="javascript:..."> URL 不安全 → 只保留链接文字
//  - <img src="..." src 不安全 → 移除 img 整个元素
//  - 其他不在白名单的标签（script/style/iframe/div/span/font/center/input/form...）
//    → 标签壳剥离，保留内文
func gameDescContentClean(content string) string {
	if strings.TrimSpace(content) == "" {
		return ""
	}

	// 危险标签整块吞掉（前置预处理，在白名单剥壳逻辑之前）：
	// 这些标签本身就是代码/执行容器，内文不能保留——
	// <script>alert(1)</script> → 整块删掉（不能只剥壳留 alert(1)）
	// <style>...css...</style>、<iframe>、<svg>、<object>、<embed>、<form> 同理
	// Go RE2 不支持 \1 反向引用，必须显式列出每一对开始/结束标签
	dangerousBlockRe := regexp.MustCompile(`(?is)` +
		`<\s*script\b[^>]*>.*?<\s*/\s*script\s*>|<\s*script\b[^>]*/\s*>` +
		`|<\s*style\b[^>]*>.*?<\s*/\s*style\s*>|<\s*style\b[^>]*/\s*>` +
		`|<\s*iframe\b[^>]*>.*?<\s*/\s*iframe\s*>|<\s*iframe\b[^>]*/\s*>` +
		`|<\s*svg\b[^>]*>.*?<\s*/\s*svg\s*>|<\s*svg\b[^>]*/\s*>` +
		`|<\s*object\b[^>]*>.*?<\s*/\s*object\s*>|<\s*object\b[^>]*/\s*>` +
		`|<\s*embed\b[^>]*>.*?<\s*/\s*embed\s*>|<\s*embed\b[^>]*/\s*>` +
		`|<\s*form\b[^>]*>.*?<\s*/\s*form\s*>|<\s*form\b[^>]*/\s*>` +
		`|<\s*input\b[^>]*/?\s*>` +
		`|<\s*textarea\b[^>]*>.*?<\s*/\s*textarea\s*>|<\s*textarea\b[^>]*/\s*>` +
		`|<\s*button\b[^>]*>.*?<\s*/\s*button\s*>|<\s*button\b[^>]*/\s*>` +
		`|<\s*link\b[^>]*/?\s*>` +
		`|<\s*meta\b[^>]*/?\s*>`)
	content = dangerousBlockRe.ReplaceAllString(content, "")

	// 白名单标签名集合（小写）
	allowedTags := map[string]bool{
		"p": true, "br": true, "hr": true,
		"h1": true, "h2": true, "h3": true,
		"b": true, "strong": true, "i": true, "em": true,
		"u": true, "s": true, "del": true, "mark": true, "small": true,
		"ul": true, "ol": true, "li": true,
		"a": true, "img": true,
		"code": true, "pre": true, "blockquote": true,
		"table": true, "thead": true, "tbody": true, "tr": true, "th": true, "td": true,
	}

	// 正则：匹配单个开始标签或结束标签
	// 捕获组：group1 = 标签名小写；group2 = 完整属性串（含空格前缀）；group3 = 是否自闭合（/>）
	tagRe := regexp.MustCompile(`(?is)<\s*(/)?([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*?)?(/)?\s*>`)

	const phPrefix = "\x00T_"
	const phSuffix = "_E\x00"
	type protectedTag struct {
		raw    string // 原始代码片段（调试用）
		normal string // 规范化后的安全代码
	}
	var protected []protectedTag
	idx := 0

	result := tagRe.ReplaceAllStringFunc(content, func(m string) string {
		parts := tagRe.FindStringSubmatch(m)
		if parts == nil {
			return ""
		}
		isClosing := parts[1] == "/"
		tagName := strings.ToLower(parts[2])
		attrs := parts[3] // 含前置空格的属性串，可能为空
		selfClose := parts[4] == "/"

		// 不在白名单 → 标签壳剥离（返回空串，内文保留）
		if !allowedTags[tagName] {
			return ""
		}

		if isClosing {
			// 白名单闭合标签 → 原样保留（但要保护起来防后续剥壳）
			ph := fmt.Sprintf("%s%d%s", phPrefix, idx, phSuffix)
			protected = append(protected, protectedTag{normal: "</" + tagName + ">"})
			idx++
			return ph
		}

		// 开放标签 → 处理属性后保护
		// 1) 剥离所有 on* 事件属性
		attrs = stripOnAttrs(attrs)

		switch tagName {
		case "a":
			// 只放行 href，其他属性全剥
			href := extractAttr(attrs, "href")
			if href == "" || !safeURL(href) {
				// href 不安全 → 整个 <a> 标签丢弃（内文会被自然保留）
				return ""
			}
			normalized := fmt.Sprintf(`<a href="%s" target="_blank" rel="noopener noreferrer">`,
				strings.ReplaceAll(href, `"`, `&quot;`))
			ph := fmt.Sprintf("%s%d%s", phPrefix, idx, phSuffix)
			protected = append(protected, protectedTag{raw: m, normal: normalized})
			idx++
			return ph

		case "img":
			src := extractAttr(attrs, "src")
			if src == "" || !safeURL(src) {
				// src 不安全 → 整个 img 元素丢弃
				return ""
			}
			alt := extractAttr(attrs, "alt")
			normalized := fmt.Sprintf(`<img src="%s" alt="%s" loading="lazy">`,
				strings.ReplaceAll(src, `"`, `&quot;`),
				strings.ReplaceAll(alt, `"`, `&quot;`))
			ph := fmt.Sprintf("%s%d%s", phPrefix, idx, phSuffix)
			protected = append(protected, protectedTag{raw: m, normal: normalized})
			idx++
			return ph

		default:
			// 其他白名单标签 → 只保留标签名，属性全剥
			normalized := "<" + tagName
			if selfClose {
				normalized += " />"
			} else {
				normalized += ">"
			}
			ph := fmt.Sprintf("%s%d%s", phPrefix, idx, phSuffix)
			protected = append(protected, protectedTag{raw: m, normal: normalized})
			idx++
			return ph
		}
	})

	// 还剩非白名单的闭合标签（</div> 这类，没被 tagRe 捕捉到是因为 tagRe 先处理了）
	// → 再跑一次把剩下的标签外壳剥掉
	var leftoverTagRe = regexp.MustCompile(`(?is)<\s*[^>]+\s*>`)
	result = leftoverTagRe.ReplaceAllString(result, "")

	// 还原占位符为规范化标签
	for i, p := range protected {
		ph := fmt.Sprintf("%s%d%s", phPrefix, i, phSuffix)
		result = strings.ReplaceAll(result, ph, p.normal)
	}

	return strings.TrimSpace(result)
}

// ----------------------------------------------------------------------------
// 辅助函数

// stripOnAttrs 剥离属性串里的所有 on* 事件属性
// 输入：原始属性串（如 ` onclick="alert(1)" href="http://x.com" title="..." `）
// 输出：剥离后（如 ` href="http://x.com" title="..." `）
func stripOnAttrs(attrs string) string {
	if attrs == "" {
		return attrs
	}
	// 匹配 onXXX="..." 或 onXXX='...' 或 onXXX=value（无引号）
	onAttrRe := regexp.MustCompile(`(?i)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`)
	return onAttrRe.ReplaceAllString(attrs, "")
}

// extractAttr 从属性串里提取指定属性的值
// 输入 attrs: ` href="http://x.com" target="_blank" `
// 输入 name: "href"
// 输出: "http://x.com"（去引号后的值）
func extractAttr(attrs, name string) string {
	if attrs == "" || name == "" {
		return ""
	}
	re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(name) + `\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	m := re.FindStringSubmatch(attrs)
	if m == nil {
		return ""
	}
	// m[1] = 双引号里的值；m[2] = 单引号里的值；m[3] = 无引号的值
	for i := 1; i <= 3; i++ {
		if m[i] != "" {
			return strings.TrimSpace(m[i])
		}
	}
	return ""
}

// ----------------------------------------------------------------------------
// 兼容旧语法：[img]URL → <img src="URL">（在客户端 buildDetailDesc 里做，服务端不需要）

// ----------------------------------------------------------------------------
// sanitizeReviewHTML 评测/回复/资料页留言 HTML 消毒（DOM 树法）
//
// 与 gameDescContentClean 的区别：
//   - 白名单含 span + font（execCommand foreColor 在 Firefox 里产 <span style="...">，
//     在 Chrome 里产 <font color="...">，两种都必须保留）
//   - 允许有限 style 属性（color/background-color/font-weight/font-style/text-decoration）
//   - 不含 img/table（评测不支持贴图和表格渲染）
//
// 与前端 sanitizeRevHtml 同策略，后端强制兜底（绕过前端直接 curl API 也安全）。
//
// 调用链：
//   game.go   HandleGameReviewUpsert       → sanitizeReviewHTML  （评测提交）
//   game.go   HandleGameReviewReplyUpsert  → sanitizeReviewHTML  （评测回复提交）
//   profile.go HandleProfileCommentsPost    → sanitizeReviewHTML  （资料页留言提交）

var reviewAllowedTags = map[string]bool{
	"b": true, "strong": true, "i": true, "em": true,
	"u": true, "s": true, "strike": true, "del": true, "mark": true,
	"p": true, "br": true, "div": true, "blockquote": true,
	"pre": true, "code": true, "hr": true,
	"ul": true, "ol": true, "li": true,
	"h1": true, "h2": true, "h3": true, "h4": true,
	"a": true, "font": true, "span": true,
}

var reviewDangerTags = map[string]bool{
	"script": true, "iframe": true, "object": true, "embed": true,
	"applet": true, "form": true, "input": true, "textarea": true,
	"button": true, "select": true, "style": true, "link": true,
	"meta": true, "base": true, "body": true, "head": true,
	"html": true, "svg": true, "math": true, "template": true,
	"slot": true, "img": true, "video": true, "audio": true,
	"canvas": true, "map": true, "area": true, "noscript": true,
}

// reviewAllowedStyleProps — span/style 中允许的 CSS 属性
var reviewAllowedStyleProps = map[string]bool{
	"color":                true,
	"background-color":     true,
	"font-weight":          true,
	"font-style":           true,
	"text-decoration":      true,
	"text-decoration-line": true,
}

// sanitizeReviewHTML 清洗评测内容 HTML：后端强制兜底，与前端同策略。
// 纯文本直接返回（性能最优路径），有 HTML 标签则走白名单递归清洗。
func sanitizeReviewHTML(input string) string {
	if input == "" {
		return input
	}
	hasHTML := strings.Contains(input, "<")
	if !hasHTML {
		return input
	}

	doc, err := html.Parse(strings.NewReader(input))
	if err != nil {
		return input
	}

	// 后序遍历清洗
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			walk(c)
			c = next
		}
		if n.Type != html.ElementNode {
			return
		}
		tag := strings.ToLower(n.Data)
		// html/head/body 是 html.Parse 自动产生的结构标签，跳过白名单/黑名单检查
		if tag == "html" || tag == "head" || tag == "body" {
			return
		}
		if reviewDangerTags[tag] {
			if tag == "script" || tag == "style" || tag == "svg" {
				if n.Parent != nil {
					n.Parent.RemoveChild(n)
				}
				return
			}
			if n.Parent != nil {
				parent := n.Parent
				var children []*html.Node
				for c := n.FirstChild; c != nil; {
					next := c.NextSibling
					children = append(children, c)
					c = next
				}
				parent.RemoveChild(n)
				for _, child := range children {
					if child.Parent != nil {
						child.Parent.RemoveChild(child)
					}
					parent.AppendChild(child)
				}
			}
			return
		}
		if !reviewAllowedTags[tag] {
			if n.Parent != nil {
				parent := n.Parent
				var children []*html.Node
				for c := n.FirstChild; c != nil; {
					next := c.NextSibling
					children = append(children, c)
					c = next
				}
				parent.RemoveChild(n)
				for _, child := range children {
					if child.Parent != nil {
						child.Parent.RemoveChild(child)
					}
					parent.AppendChild(child)
				}
			}
			return
		}
		newAttrs := make([]html.Attribute, 0, len(n.Attr))
		for _, attr := range n.Attr {
			name := strings.ToLower(attr.Key)
			val := attr.Val
			switch tag {
			case "a":
				if name == "href" {
					lowVal := strings.ToLower(strings.TrimSpace(val))
					if strings.HasPrefix(lowVal, "javascript:") ||
						strings.HasPrefix(lowVal, "data:") ||
						strings.HasPrefix(lowVal, "vbscript:") {
						continue
					}
					if !strings.HasPrefix(lowVal, "http://") &&
						!strings.HasPrefix(lowVal, "https://") &&
						!strings.HasPrefix(lowVal, "mailto:") &&
						!strings.HasPrefix(lowVal, "/") &&
						!strings.HasPrefix(lowVal, "#") {
						continue
					}
					newAttrs = append(newAttrs, attr)
				} else if name == "target" {
					newAttrs = append(newAttrs, attr)
				}
			case "font":
				if name == "color" {
					matched, _ := regexp.MatchString(`^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|[a-zA-Z]+)$`, val)
					if matched {
						newAttrs = append(newAttrs, attr)
					}
				}
			case "span", "div", "p", "blockquote":
				if name == "style" {
					safe := cleanReviewStyle(val)
					if safe != "" {
						newAttrs = append(newAttrs, html.Attribute{Key: "style", Val: safe})
					}
				}
			}
		}
		n.Attr = newAttrs
	}
	walk(doc)

	var buf strings.Builder
	body := findBody(doc)
	if body != nil {
		for c := body.FirstChild; c != nil; c = c.NextSibling {
			_ = html.Render(&buf, c)
		}
	}

	// 清洗后为空（全是危险标签被剥离）→ 返回空字符串让上游非空校验拦截
	return strings.TrimSpace(buf.String())
}

func findBody(n *html.Node) *html.Node {
	if n.Type == html.ElementNode && strings.EqualFold(n.Data, "body") {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if found := findBody(c); found != nil {
			return found
		}
	}
	return nil
}

// cleanReviewStyle 从 style 字符串中提取允许的 CSS 属性
func cleanReviewStyle(style string) string {
	allowed := strings.Builder{}
	decls := strings.Split(style, ";")
	for _, decl := range decls {
		parts := strings.SplitN(strings.TrimSpace(decl), ":", 2)
		if len(parts) != 2 {
			continue
		}
		prop := strings.ToLower(strings.TrimSpace(parts[0]))
		val := strings.TrimSpace(parts[1])
		if !reviewAllowedStyleProps[prop] {
			continue
		}
		lowVal := strings.ToLower(val)
		if strings.Contains(lowVal, "url(") ||
			strings.Contains(lowVal, "expression(") ||
			strings.Contains(lowVal, "javascript:") ||
			strings.Contains(lowVal, "import ") {
			continue
		}
		if prop == "color" || prop == "background-color" {
			matched, _ := regexp.MatchString(`^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})|rgb(a)?\s*\([^)]+\)|hsl(a)?\s*\([^)]+\)|[a-zA-Z]+)$`, val)
			if !matched {
				continue
			}
		}
		if allowed.Len() > 0 {
			allowed.WriteString(";")
		}
		allowed.WriteString(prop)
		allowed.WriteString(":")
		allowed.WriteString(val)
	}
	return allowed.String()
}
