package server

// ============================================================================
// 统一 HTML 消毒模块 —— 存储型 XSS 第二道防线
//
// 设计原则：
//  1. 白名单思维：放行标签显式列出，其他一律剥离壳保留内文
//  2. RE2 兼容：所有正则不使用 \1 反向引用（Go regexp 引擎不支持）
//  3. 安全 URL 共用：safeURL 公告+Game 共用，一处修改全局生效
//  4. 占位符保护：放行标签先替换为 \x00 占位符，再统一剥离外壳，最后还原
//     （避免正则顺序依赖导致安全标签被误剥）
//
// 调用链：
//  公告正文 → gameNoticeContentClean （gameadmin.go 既有函数，复用 safeURL）
//  Game 介绍 → gameDescContentClean （本次新增，白名单更大）
// ============================================================================

import (
	"fmt"
	"regexp"
	"strings"
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
