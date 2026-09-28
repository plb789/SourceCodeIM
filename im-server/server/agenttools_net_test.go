package server

// 阶段一百六十九：fetch_page 网页阅读工具单测——HTML→Markdown 转换器 + 工具执行链路（httptest 回环）

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// TestAgentHTMLToMarkdown 转换器主链路：标题/加粗/链接绝对化/列表/代码块/表格结构化保留，
// 脚本/样式/导航噪音剔除，相对链接基于页面 URL 绝对化
func TestAgentHTMLToMarkdown(t *testing.T) {
	const page = `<!DOCTYPE html><html><head><title>测试页面</title>
<style>body{color:red}</style></head><body>
<nav>菜单跳过项</nav>
<h1>标题一</h1>
<p>第一段，含<strong>加粗</strong>和<a href="/doc/guide">链接文本</a>，以及<b>另一粗体</b>。</p>
<ul><li>甲项</li><li>乙项</li></ul>
<ol><li>有序一</li><li>有序二</li></ol>
<pre><code>func main() {
    fmt.Println("hi")
}</code></pre>
<table><tr><th>名称</th><th>取值</th></tr><tr><td>alpha</td><td>beta</td></tr></table>
<img src="/logo.png" alt="logo">
<script>var x=1;</script>
<p>尾段文字</p>
</body></html>`
	md, title := agentHTMLToMarkdown(page, "http://127.0.0.1:8888/post/1")
	if title != "测试页面" {
		t.Fatalf("标题提取不符: %q", title)
	}
	checks := []struct {
		name string
		cond bool
	}{
		{"h1 前缀", strings.Contains(md, "# 标题一")},
		{"strong 加粗", strings.Contains(md, "**加粗**")},
		{"b 加粗", strings.Contains(md, "**另一粗体**")},
		{"链接绝对化", strings.Contains(md, "[链接文本](http://127.0.0.1:8888/doc/guide)")},
		{"无序列表", strings.Contains(md, "\n- 甲项\n- 乙项")},
		{"有序列表", strings.Contains(md, "\n1. 有序一\n2. 有序二")},
		{"代码块围栏", strings.Contains(md, "```\nfunc main() {")},
		{"代码缩进原样", strings.Contains(md, "    fmt.Println(\"hi\")")},
		{"表格表头", strings.Contains(md, "| 名称 | 取值 |")},
		{"表格分隔线", strings.Contains(md, "---|---|")},
		{"表格数据行", strings.Contains(md, "| alpha | beta |")},
		{"尾段正文", strings.Contains(md, "尾段文字")},
		{"无 HTML 标签残留", !strings.Contains(md, "<p>") && !strings.Contains(md, "<table")},
		{"nav 噪音剔除", !strings.Contains(md, "菜单跳过项")},
		{"style 噪音剔除", !strings.Contains(md, "color:red")},
		{"script 噪音剔除", !strings.Contains(md, "var x=1")},
		{"img 剔除", !strings.Contains(md, "logo")},
	}
	for _, ck := range checks {
		if !ck.cond {
			t.Errorf("断言失败[%s]，输出：\n%s", ck.name, md)
		}
	}
}

// TestAgentMDNormalize 连续空行压缩与行尾空白清理
func TestAgentMDNormalize(t *testing.T) {
	got := agentMDNormalize("a  \n\n\n\n\nb\n\n")
	if got != "a\n\nb" {
		t.Fatalf("归一化不符: %q", got)
	}
}

// TestAgentDecodeHTMLBody GBK 显式字符集与替换符兜底两条解码路径
func TestAgentDecodeHTMLBody(t *testing.T) {
	gbkBytes, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("中文内容测试"))
	if err != nil {
		t.Fatalf("GBK 编码失败: %v", err)
	}
	if got := agentDecodeHTMLBody(gbkBytes, "text/html; charset=gb2312"); got != "中文内容测试" {
		t.Fatalf("显式 GBK 解码不符: %q", got)
	}
	if got := agentDecodeHTMLBody(gbkBytes, "text/html"); !strings.Contains(got, "中文内容测试") {
		t.Fatalf("替换符兜底解码不符: %q", got)
	}
	if got := agentDecodeHTMLBody([]byte("plain text"), "text/html; charset=utf-8"); got != "plain text" {
		t.Fatalf("UTF-8 原样不符: %q", got)
	}
}

// TestAgentToolFetchPage 工具执行链路（httptest 回环）：正常转换/非网页 CT 指引/404 报错
func TestAgentToolFetchPage(t *testing.T) {
	// 回环地址默认被内网拦截：测试期放行 + 收尾恢复；工具超时未初始化（单测环境无 InitAgent）补设
	agentHttpAllowPrivate.Store(true)
	agentToolTimeout.Store(30)
	t.Cleanup(func() {
		agentHttpAllowPrivate.Store(false)
		agentToolTimeout.Store(60)
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><head><title>HTTP测试页</title></head><body><h2>章节</h2><p>正文内容XYZ</p></body></html>`))
	})
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	got := agentToolFetchPage(map[string]interface{}{"url": srv.URL + "/page"})
	for _, want := range []string{"HTTP 200", "HTTP测试页", "# 章节", "正文内容XYZ"} {
		if !strings.Contains(got, want) {
			t.Errorf("结果缺 %q，实际：\n%s", want, got)
		}
	}
	if strings.Contains(got, "<p>") {
		t.Errorf("HTML 标签未转换，实际：\n%s", got)
	}

	got = agentToolFetchPage(map[string]interface{}{"url": srv.URL + "/api"})
	if !strings.Contains(got, "非网页内容") || !strings.Contains(got, "http_request") {
		t.Errorf("非网页 CT 未指引换工具，实际：%s", got)
	}

	got = agentToolFetchPage(map[string]interface{}{"url": srv.URL + "/missing"})
	if !strings.Contains(got, "错误：HTTP 404") {
		t.Errorf("404 未按错误返回，实际：%s", got)
	}

	got = agentToolFetchPage(map[string]interface{}{"url": "ftp://x.com/a"})
	if !strings.Contains(got, "url 无效") {
		t.Errorf("非法协议未拦截，实际：%s", got)
	}
}
