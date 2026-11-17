package server

// ============================================================================
// sanitize.go 单元测试
//
// 覆盖范围：
//   safeURL              URL 安全校验（公告 + Game 共用）
//   gameDescContentClean Game 介绍消毒（正则法，白名单较大）
//   sanitizeReviewHTML   评测/回复/留言消毒（DOM 树法，核心安全函数）
//   cleanReviewStyle     style 属性白名单提取（辅助函数）
// ============================================================================

import (
	"strings"
	"testing"
)

// ----------------------------------------------------------------------------
// safeURL 测试
// ----------------------------------------------------------------------------

func TestSafeURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		// ✅ 合法 URL
		{"https 标准", "https://example.com", true},
		{"http 标准", "http://example.com/path?x=1", true},
		{"站内相对路径", "/api/game/list", true},
		{"相对路径", "./static/js/app.js", true},
		{"锚点", "#section-1", true},
		{"带空格 trim", "  https://example.com  ", true},
		{"反斜杠混淆 https", `https:\/\/example.com`, true},
		{"URL 带参数", "https://example.com?q=测试&sort=asc", true},
		{"IP 地址", "http://127.0.0.1:8080/api", true},

		// ❌ 危险协议
		{"javascript:", "javascript:alert(1)", false},
		{"JAVASCRIPT: 大写", "JAVASCRIPT:alert(1)", false},
		{"vbscript:", "vbscript:msgbox(1)", false},
		{"VBscript 混合", "VBscript:alert(1)", false},
		{"data: text/html", "data:text/html,<script>", false},
		{"file://", "file:///etc/passwd", false},
		{"\\j\\avascript 反斜杠混淆", `\j\avascript:alert(1)`, false},
		{"JaVaScRiPt 大小写混淆", "JaVaScRiPt:alert(1)", false},

		// ❌ 其他非法
		{"含 < 尖括号", "https://example.com/<script>", false},
		{"含 > 尖括号", "https://example.com/evil>", false},
		{"空字符串", "", false},
		{"纯空白", "   ", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := safeURL(tt.url)
			if got != tt.want {
				t.Errorf("safeURL(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// sanitizeReviewHTML — 白名单保留测试
// ----------------------------------------------------------------------------

func TestSanitizeReviewHTML_Whitelist(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		mustKeep []string // 输出中必须包含这些子串
	}{
		// 文本直接返回
		{"纯文本", "这是一段评测", []string{"这是一段评测"}},
		{"空字符串", "", nil},

		// 格式标签
		{"粗体", "<b>好游戏</b>", []string{"<b>好游戏</b>"}},
		{"strong 粗体", "<strong>推荐</strong>", []string{"<strong>推荐</strong>"}},
		{"斜体", "<i>隐藏剧情</i>", []string{"<i>隐藏剧情</i>"}},
		{"em 斜体", "<em>重点</em>", []string{"<em>重点</em>"}},
		{"下划线", "<u>强调</u>", []string{"<u>强调</u>"}},
		{"删除线", "<s>垃圾游戏</s>", []string{"<s>垃圾游戏</s>"}},
		{"strike", "<strike>过时</strike>", []string{"<strike>过时</strike>"}},
		{"del", "<del>删除内容</del>", []string{"<del>删除内容</del>"}},
		{"mark 高亮", "<mark>注意这里</mark>", []string{"<mark>注意这里</mark>"}},

		// 段落/容器
		{"p 段落", "<p>第一段</p>", []string{"<p>", "第一段"}},
		{"div 容器", "<div>内容</div>", []string{"<div>", "内容"}},
		{"br 换行", "第一行<br>第二行", []string{"第一行", "第二行"}},

		// 标题
		{"h1", "<h1>大标题</h1>", []string{"<h1>", "大标题"}},
		{"h3", "<h3>小标题</h3>", []string{"<h3>", "小标题"}},
		{"h4", "<h4>四级标题</h4>", []string{"<h4>", "四级标题"}},

		// 列表
		{"无序列表", "<ul><li>A</li><li>B</li></ul>", []string{"<ul>", "<li>", "A", "B"}},
		{"有序列表", "<ol><li>1</li><li>2</li></ol>", []string{"<ol>", "<li>", "1", "2"}},

		// 引用/代码/分隔线
		{"blockquote", "<blockquote>引用的话</blockquote>", []string{"<blockquote>", "引用的话"}},
		{"pre 预格式化", "<pre>代码块</pre>", []string{"<pre>", "代码块"}},
		{"code", "<code>inline code</code>", []string{"<code>", "inline code"}},
		{"hr", "前面<hr>后面", []string{"前面", "后面"}},

		// 链接
		{"https 链接", `<a href="https://example.com">官网</a>`, []string{`<a href="https://example.com"`}},
		{"http 链接", `<a href="http://example.com">HTTP</a>`, []string{`<a href="http://example.com"`}},
		{"mailto 链接", `<a href="mailto:a@b.com">发邮件</a>`, []string{`mailto:a@b.com`}},

		// font color（Chrome execCommand 产物）
		{"font #hex", `<font color="#ff0000">红色</font>`, []string{`<font color="#ff0000">红色</font>`}},
		{"font short hex", `<font color="#f00">红</font>`, []string{`<font color="#f00">红</font>`}},
		{"font 颜色名", `<font color="blue">蓝</font>`, []string{`<font color="blue">蓝</font>`}},

		// span + style（Firefox execCommand 产物）
		{"span color hex", `<span style="color:#ff0000">红</span>`, []string{`<span style="color:#ff0000">红</span>`}},
		{"span color rgb", `<span style="color:rgb(255,0,0)">红</span>`, []string{`color:rgb(255,0,0)`}},
		{"span bg-color", `<span style="background-color:#ffe">高亮</span>`, []string{`background-color:#ffe`}},
		{"span font-weight", `<span style="font-weight:bold">粗</span>`, []string{`font-weight:bold`}},
		{"span font-style italic", `<span style="font-style:italic">斜</span>`, []string{`font-style:italic`}},
		{"span text-decoration underline", `<span style="text-decoration:underline">下划</span>`, []string{`text-decoration:underline`}},
		{"span text-decoration-line", `<span style="text-decoration-line:line-through">删除</span>`, []string{`text-decoration-line:line-through`}},

		// 混合场景
		{"混合富文本", `<div><h3>评测标题</h3><p><b>画面</b>非常精美，<span style="color:#ff6600">橙色文字</span>。</p><ul><li>优点</li><li>缺点</li></ul><a href="https://example.com">官网</a></div>`, []string{"评测标题", "画面", "精美", "优点", "缺点", "https://example.com"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeReviewHTML(tt.input)
			for _, k := range tt.mustKeep {
				if !strings.Contains(result, k) {
					t.Errorf("FAIL — 未保留安全内容 %q\n  输入: %s\n  输出: %s", k, tt.input, result)
				}
			}
		})
	}
}

// ----------------------------------------------------------------------------
// sanitizeReviewHTML — 危险标签剥离测试
// ----------------------------------------------------------------------------

func TestSanitizeReviewHTML_DangerTagRemoval(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		mustLack []string // 输出中绝对不能包含
	}{
		// 脚本类（整棵删）
		{"script alert", `<script>alert(1)</script>`, []string{"<script", "alert(1)"}},
		{"script 多语句", `<script>alert(1);document.cookie</script>`, []string{"<script", "document.cookie"}},
		{"style CSS 注入", `<style>body{background:red}</style>`, []string{"<style"}},
		{"svg onload", `<svg onload=alert(1)></svg>`, []string{"<svg", "onload", "alert"}},
		{"svg 嵌套脚本", `<svg><script>alert(1)</script></svg>`, []string{"<svg", "<script"}},

		// 插件类（剥壳删内文）
		{"iframe", `<iframe src=evil.com></iframe>`, []string{"<iframe"}},
		{"object", `<object data=x></object>`, []string{"<object"}},
		{"embed", `<embed src=x>`, []string{"<embed"}},
		{"applet", `<applet code=x></applet>`, []string{"<applet"}},

		// 表单类（剥壳保留内文）
		{"button onclick", `<button onclick="alert(1)">点我</button>`, []string{"onclick"}},
		{"form", `<form action=/evil method=POST><input name=x></form>`, []string{"<form", "<input"}},
		{"select", `<select onchange=alert(1)><option>x</option></select>`, []string{"<select", "onchange"}},
		{"textarea", `<textarea onfocus=alert(1)></textarea>`, []string{"<textarea", "onfocus"}},

		// 资源加载类
		{"img onerror", `<img src=x onerror=alert(1)>`, []string{"<img", "onerror"}},
		{"video", `<video src=x onerror=alert(1)></video>`, []string{"<video"}},
		{"audio", `<audio src=x onerror=alert(1)></audio>`, []string{"<audio"}},
		{"canvas", `<canvas></canvas>`, []string{"<canvas"}},
		{"map area", `<map></map><area href=x>`, []string{"<map", "<area"}},
		{"noscript", `<noscript><script>alert(1)</script></noscript>`, []string{"<noscript"}},

		// 元数据类
		{"meta http-equiv refresh", `<meta http-equiv=refresh content="0;url=evil">`, []string{"<meta"}},
		{"base href", `<base href=http://evil.com>`, []string{"<base"}},
		{"link rel stylesheet", `<link rel=stylesheet href=evil.css>`, []string{"<link"}},
		{"template slot", `<template><script>alert(1)</script></template>`, []string{"<template"}},

		// 结构标签（html/head/body 保留——是 Parse 自动产的）
		// 不在这里测，因为它们不是用户提交的
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeReviewHTML(tt.input)
			for _, f := range tt.mustLack {
				if strings.Contains(result, f) {
					t.Errorf("FAIL — 含被禁止元素 %q\n  输入: %s\n  输出: %s", f, tt.input, result)
				}
			}
		})
	}
}

// ----------------------------------------------------------------------------
// sanitizeReviewHTML — 属性清洗测试
// ----------------------------------------------------------------------------

func TestSanitizeReviewHTML_AttributeCleaning(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		mustLack []string
		mustKeep []string
	}{
		// a 标签 href 校验
		{"javascript href 剥离", `<a href="javascript:alert(1)">x</a>`, []string{"javascript:", `<a `}, []string{"x"}},
		{"data href 剥离", `<a href="data:text/html,<script>">x</a>`, []string{"data:", `<a `}, []string{"x"}},
		{"vbscript href 剥离", `<a href="vbscript:msgbox(1)">x</a>`, []string{"vbscript:", `<a `}, []string{"x"}},
		{"合法 https href 保留", `<a href="https://safe.com">ok</a>`, []string{}, []string{`href="https://safe.com"`}},
		{"合法 http href 保留", `<a href="http://safe.com">ok</a>`, []string{}, []string{`href="http://safe.com"`}},
		{"合法 mailto 保留", `<a href="mailto:a@b.com">ok</a>`, []string{}, []string{`href="mailto:a@b.com"`}},
		{"锚点 href 保留", `<a href="#top">ok</a>`, []string{}, []string{`href="#top"`}},
		{"相对路径保留", `<a href="/about">ok</a>`, []string{}, []string{`href="/about"`}},

		// a 标签其他属性
		{"onclick 剥离", `<a href="https://x.com" onclick="alert(1)">x</a>`, []string{"onclick"}, []string{}},
		{"target 保留", `<a href="https://x.com" target="_blank">x</a>`, []string{}, []string{"target=\"_blank\""}},
		{"class 剥离", `<a href="https://x.com" class="evil">x</a>`, []string{"class="}, []string{}},
		{"id 剥离", `<a href="https://x.com" id="x">x</a>`, []string{"id="}, []string{}},

		// font color 校验
		{"font color 非法剥离", `<font color="expression(alert(1))">x</font>`, []string{"expression", "alert", "color="}, []string{"x"}},
		{"font color hex 保留", `<font color="#ff0000">x</font>`, []string{}, []string{`color="#ff0000"`}},
		{"font color 颜色名保留", `<font color="red">x</font>`, []string{}, []string{`color="red"`}},
		{"font size 剥离", `<font color="red" size="5">x</font>`, []string{"size="}, []string{}},
		{"font face 剥离", `<font color="red" face="Arial">x</font>`, []string{"face="}, []string{}},

		// span style 校验
		{"span style expression 剥离", `<span style="color:expression(alert(1))">x</span>`, []string{"expression", "alert"}, []string{}},
		{"span style url 剥离", `<span style="background:url(xss)">x</span>`, []string{"url("}, []string{}},
		{"span style javascript 剥离", `<span style="color:javascript:alert(1)">x</span>`, []string{"javascript:"}, []string{}},
		{"span style import 剥离", `<span style="@import evil.css">x</span>`, []string{"import"}, []string{}},
		{"span style color rgb 保留", `<span style="color:rgb(255,0,0)">x</span>`, []string{}, []string{`color:rgb(255,0,0)`}},
		{"span style color hex 保留", `<span style="color:#ff0000">x</span>`, []string{}, []string{`color:#ff0000`}},
		{"span style color hsl 保留", `<span style="color:hsl(0,100%,50%)">x</span>`, []string{}, []string{`color:hsl(0,100%,50%)`}},
		{"span style background-color 保留", `<span style="background-color:#ffe">x</span>`, []string{}, []string{`background-color:#ffe`}},
		{"span style font-weight 保留", `<span style="font-weight:bold">x</span>`, []string{}, []string{`font-weight:bold`}},
		{"span style font-style 保留", `<span style="font-style:italic">x</span>`, []string{}, []string{`font-style:italic`}},
		{"span style text-decoration 保留", `<span style="text-decoration:underline">x</span>`, []string{}, []string{`text-decoration:underline`}},
		{"span style text-decoration-line 保留", `<span style="text-decoration-line:line-through">x</span>`, []string{}, []string{`text-decoration-line:line-through`}},
		{"span style 其他属性剥离", `<span style="display:block">x</span>`, []string{"display"}, []string{}},
		{"span class 剥离", `<span class="evil">x</span>`, []string{"class="}, []string{}},
		{"span onclick 剥离", `<span onclick="alert(1)">x</span>`, []string{"onclick"}, []string{}},

		// div/p/blockquote 的 style 白名单校验（与 span 同规则）
		{"div style color 保留", `<div style="color:red">x</div>`, []string{}, []string{`style="color:red"`}},
		{"p style 非法剥离", `<p style="width:100%">x</p>`, []string{"width"}, []string{}},

		// 其他白名单标签属性全剥离
		{"b class 剥离", `<b class="x">x</b>`, []string{"class="}, []string{}},
		{"ul onclick 剥离", `<ul onclick="alert(1)"><li>x</li></ul>`, []string{"onclick"}, []string{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeReviewHTML(tt.input)
			for _, f := range tt.mustLack {
				if strings.Contains(result, f) {
					t.Errorf("FAIL — 含被禁止元素 %q\n  输入: %s\n  输出: %s", f, tt.input, result)
				}
			}
			for _, k := range tt.mustKeep {
				if !strings.Contains(result, k) {
					t.Errorf("FAIL — 未保留安全属性 %q\n  输入: %s\n  输出: %s", k, tt.input, result)
				}
			}
		})
	}
}

// ----------------------------------------------------------------------------
// sanitizeReviewHTML — 非白名单标签降级测试
// ----------------------------------------------------------------------------

func TestSanitizeReviewHTML_TagDowngrade(t *testing.T) {
	tests := []struct {
		name         string
		input        string
		mustLack     []string       // 输出中绝对不能包含
		mustKeepText []string       // 降级后应保留纯文本
	}{
		// 非白名单标签 → 保留内文
		{"address 降级", `<address>联系我们</address>`, []string{"<address"}, []string{"联系我们"}},
		{"article 降级", `<article>文章内容</article>`, []string{"<article"}, []string{"文章内容"}},
		{"section 降级", `<section>段落</section>`, []string{"<section"}, []string{"段落"}},
		{"nav 降级", `<nav>导航</nav>`, []string{"<nav"}, []string{"导航"}},
		{"figcaption 降级", `<figcaption>图片说明</figcaption>`, []string{"<figcaption"}, []string{"图片说明"}},
		{"main 降级", `<main>主要内容</main>`, []string{"<main"}, []string{"主要内容"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeReviewHTML(tt.input)
			for _, f := range tt.mustLack {
				if strings.Contains(result, f) {
					t.Errorf("FAIL — 非白名单标签未降级 %q\n  输入: %s\n  输出: %s", f, tt.input, result)
				}
			}
			for _, k := range tt.mustKeepText {
				if !strings.Contains(result, k) {
					t.Errorf("FAIL — 降级后文本丢失 %q\n  输入: %s\n  输出: %s", k, tt.input, result)
				}
			}
		})
	}
}

// ----------------------------------------------------------------------------
// sanitizeReviewHTML — 边界 & 鲁棒性测试
// ----------------------------------------------------------------------------

func TestSanitizeReviewHTML_EdgeCases(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"空字符串", ""},
		{"纯空白", "   \n\t  "},
		{"纯文本无 HTML", "这是一段纯文本评测，没有任何标签"},
		{"只有危险标签", "<script>alert(1)</script>"},
		{"危险标签嵌套", "<div><script>alert(1)<img src=x onerror=alert(1)></div>"},
		{"多层嵌套", "<div><ul><li><b>ok</b></li></ul></div>"},
		{"CRLF 换行", "第一行\r\n第二行\r\n第三行"},
		{"Unicode emoji", "👍🎉 ❤️ 这个游戏超赞！"},
		{"中文标点", "画面精美，剧情紧凑……"},
		{"长文本 1000 字长评测", strings.Repeat("这是一段很长的评测内容。", 50)},
		{"全是安全标签", "<div><h3>评测</h3><p><b>好</b>游戏。</p><ul><li>A</li><li>B</li></ul></div>"},
		{"HTML 注释", "<!-- 这是注释 -->正常文本"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// 不应 panic
			result := sanitizeReviewHTML(tt.input)
			// 不应包含明显危险字符串
			if strings.Contains(strings.ToLower(result), "alert(") {
				t.Errorf("FAIL — 结果含 alert(\n  输入: %s\n  输出: %s", tt.input, result)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// cleanReviewStyle — 辅助函数单测
// ----------------------------------------------------------------------------

func TestCleanReviewStyle(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		// 白名单属性保留
		{"color hex", "color:#ff0000", "color:#ff0000"},
		{"color rgb", "color:rgb(255,0,0)", "color:rgb(255,0,0)"},
		{"color rgba", "color:rgba(255,0,0,0.5)", "color:rgba(255,0,0,0.5)"},
		{"background-color", "background-color:#ffe", "background-color:#ffe"},
		{"font-weight", "font-weight:bold", "font-weight:bold"},
		{"font-style", "font-style:italic", "font-style:italic"},
		{"text-decoration", "text-decoration:underline", "text-decoration:underline"},
		{"text-decoration-line", "text-decoration-line:line-through", "text-decoration-line:line-through"},

		// 非白名单属性剥离
		{"display 剥离", "display:block", ""},
		{"width 剥离", "width:100px", ""},
		{"height 剥离", "height:50px", ""},
		{"font-size 剥离", "font-size:16px", ""},
		{"margin 剥离", "margin:0", ""},
		{"padding 剥离", "padding:0", ""},
		{"border 剥离", "border:1px solid red", ""},
		{"float 剥离", "float:left", ""},

		// 危险值剥离
		{"expression 剥离", "color:expression(alert(1))", ""},
		{"url 剥离", "background:url(evil.com/xss)", ""},
		{"javascript 剥离", "color:javascript:alert(1)", ""},
		{"import 剥离", "color:@import evil.css", ""},

		// 多个声明混合
		{"混合白+黑", "color:red;display:block;font-weight:bold;width:100px", "color:red;font-weight:bold"},
		{"全黑名单", "display:block;width:100px", ""},

		// 边界
		{"空字符串", "", ""},
		{"纯分号", ";;;", ""},
		{"无冒号声明", "colorred", ""},
		{"空格", " color : red ", "color:red"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanReviewStyle(tt.input)
			if got != tt.want {
				t.Errorf("cleanReviewStyle(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// ----------------------------------------------------------------------------
// gameDescContentClean — 正则法消毒（单独测试，白名单含 img/table）
// ----------------------------------------------------------------------------

func TestGameDescContentClean(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		mustKeep []string
		mustLack []string
	}{
		// img/table 白名单（评测里没有但 Game 介绍有）
		{"img src 保留", `<img src="https://example.com/pic.png">`, []string{`<img src="https://example.com/pic.png"`}, nil},
		{"table 保留", `<table><tr><td>A</td></tr></table>`, []string{"<table>", "<tr>", "<td>"}, nil},

		// script/style/svg 剥离
		{"script 剥离", `<script>alert(1)</script>`, nil, []string{"<script", "alert(1)"}},
		{"svg 剥离", `<svg onload=alert(1)></svg>`, nil, []string{"<svg", "onload"}},

		// img onerror 剥离
		{"img onerror 剥离", `<img src=x onerror=alert(1)>`, nil, []string{"onerror", "alert"}},

		// 非白名单标签降级
		{"div 降级保留内文", `<div>内容</div>`, []string{"内容"}, []string{"<div"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := gameDescContentClean(tt.input)
			for _, k := range tt.mustKeep {
				if !strings.Contains(result, k) {
					t.Errorf("FAIL — 未保留 %q\n  输入: %s\n  输出: %s", k, tt.input, result)
				}
			}
			for _, f := range tt.mustLack {
				if strings.Contains(result, f) {
					t.Errorf("FAIL — 含被禁止元素 %q\n  输入: %s\n  输出: %s", f, tt.input, result)
				}
			}
		})
	}
}
