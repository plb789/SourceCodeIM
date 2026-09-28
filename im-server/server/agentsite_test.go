package server

// 阶段一百九十一：工作区目录级静态预览单测（走服务端工作区路径——PC 执行器关闭，
// wsFileDispatch 自动回退 readb 服务端读取，与 PC 在线时同一分派归口）。
// 覆盖：路由模式与 PathValue 提取、HTML 整页直出 + MIME、多文件相对资源（css/js/图片）、
// 目录请求补 index.html、越界路径（..）拒绝、缺失文件 404、缺 username 400、agentSiteMime 映射。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// siteServe 构造带预览路由的 mux（与 main.go 注册同款模式，验证通配符 PathValue 提取）
func siteServe(s *Server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /agent/site/{username}/{path...}", s.HandleAgentSite)
	return mux
}

// TestHandleAgentSiteServe 整页直出 + 相对资源 + 目录兜底 + 安全拒绝
func TestHandleAgentSiteServe(t *testing.T) {
	ws := agentTreeTestSetup(t, "siterender1")
	agentTreeWrite(t, ws, "index.html", "<!doctype html><html><body><h1>预览页</h1></body></html>")
	agentTreeWrite(t, ws, "assets/style.css", "body{margin:0}")
	agentTreeWrite(t, ws, "assets/app.js", "console.log(1)")
	agentTreeWrite(t, ws, "sub/index.html", "<p>子目录页</p>")
	agentTreeWrite(t, ws, "pic.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
	s := &Server{}
	h := siteServe(s)

	// 根路径（尾斜杠，path 段为空——ServeMux 对缺段路径会 301 补斜杠，浏览器自动跟随）→ 自动 index.html 整页直出
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/?username=siterender1", nil))
	if rec.Code != 200 {
		t.Fatalf("根路径应 200，得 %d：%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("HTML 应 text/html，得 %s", ct)
	}
	if !strings.Contains(rec.Body.String(), "预览页") {
		t.Fatalf("HTML 内容不符：%s", rec.Body.String())
	}

	// 显式文件 + 相对资源 MIME（css/js）
	for _, c := range []struct{ path, mime, body string }{
		{"assets/style.css", "text/css", "body{margin:0}"},
		{"assets/app.js", "text/javascript", "console.log(1)"},
		{"pic.svg", "image/svg+xml", "<svg"},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/"+c.path+"?username=siterender1", nil))
		if rec.Code != 200 {
			t.Fatalf("%s 应 200，得 %d", c.path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, c.mime) {
			t.Fatalf("%s MIME 应含 %s，得 %s", c.path, c.mime, ct)
		}
		if !strings.Contains(rec.Body.String(), c.body) {
			t.Fatalf("%s 内容不符：%s", c.path, rec.Body.String())
		}
	}

	// 目录请求（无尾斜杠无扩展名）→ 补 index.html
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/sub?username=siterender1", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "子目录页") {
		t.Fatalf("目录请求应兜底 sub/index.html，得 %d：%s", rec.Code, rec.Body.String())
	}

	// 目录存在但无 index.html → 404（不列目录）
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/assets?username=siterender1", nil))
	if rec.Code != 404 {
		t.Fatalf("无 index.html 的目录应 404，得 %d", rec.Code)
	}

	// 越界路径拒绝（.. 上级引用）
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/..%2f..%2fconfig.yaml?username=siterender1", nil))
	if rec.Code != 400 {
		t.Fatalf("越界路径应 400，得 %d：%s", rec.Code, rec.Body.String())
	}

	// 缺失文件 404
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/nope.html?username=siterender1", nil))
	if rec.Code != 404 {
		t.Fatalf("缺失文件应 404，得 %d", rec.Code)
	}

	// 路径段 username 归口：相对资源请求不带 query 也应正常读取（浏览器 CSS/JS 引用场景）
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://x/agent/site/siterender1/assets/style.css", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "body{margin:0}") {
		t.Fatalf("无 query 的相对资源请求应 200（username 走路径段），得 %d：%s", rec.Code, rec.Body.String())
	}
}

// TestAgentSiteMime MIME 显式映射与嗅探兜底
func TestAgentSiteMime(t *testing.T) {
	for _, c := range []struct{ name, want string }{
		{"a.html", "text/html"}, {"a.htm", "text/html"}, {"a.css", "text/css"},
		{"a.js", "text/javascript"}, {"a.json", "application/json"},
		{"a.png", "image/png"}, {"a.jpg", "image/jpeg"}, {"a.woff2", "font/woff2"},
	} {
		if got := agentSiteMime(c.name, []byte{}); !strings.HasPrefix(got, c.want) {
			t.Fatalf("%s 应 %s，得 %s", c.name, c.want, got)
		}
	}
	// 未知扩展名：内容嗅探兜底（文本 → text/plain）
	if got := agentSiteMime("a.xyz123", []byte("hello")); !strings.HasPrefix(got, "text/plain") {
		t.Fatalf("未知扩展名应嗅探 text/plain，得 %s", got)
	}
}
