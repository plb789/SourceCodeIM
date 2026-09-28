// aiidlewatch_test.go 阶段一百九十五：AI 响应空闲看护单测——
// 验证 aiIdleWatch 在数据块间空闲超过阈值时中断请求、正常流式/禁用看护不受扰。
package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestAIIdleWatchStalls 断流场景：响应头立即返回后 body 挂起不输出，空闲阈值触发中断，
// attempt 侧读到错误且 context.Cause 为看护原因（含 "idle timeout"，aiIsTimeoutErr 可命中）
func TestAIIdleWatchStalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select { // 建连后断流：不再输出任何数据，模拟 deepseek 挂死
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
	}))
	defer srv.Close()

	// 缩短阈值加速测试（直接改包内变量，InitAI 未跑时为默认 90s）
	old := aiStreamIdleTimeout
	aiStreamIdleTimeout = 300 * time.Millisecond
	defer func() { aiStreamIdleTimeout = old }()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL, nil)
	watchCtx, bodyWrap, stopWatch := aiIdleWatch(ctx, aiStreamIdleTimeout)
	defer stopWatch()
	// 请求必须挂在 watchCtx 上（cancel 才能中断阻塞读）——复刻 attempt 侧调用序
	req = req.WithContext(watchCtx)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败（预期拿到响应头）：%v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 512)
	done := make(chan error, 1)
	go func() {
		for {
			if _, err := bodyWrap(resp).Read(buf); err != nil {
				done <- err
				return
			}
		}
	}()
	select {
	case err := <-done:
		if cause := context.Cause(watchCtx); cause == nil || !strings.Contains(cause.Error(), "idle timeout") {
			t.Fatalf("读错误非看护触发：err=%v cause=%v", err, cause)
		}
		if !aiIsTimeoutErr(err) && !aiIsTimeoutErr(context.Cause(watchCtx)) {
			t.Fatalf("看护错误应被 aiIsTimeoutErr 归为超时类：err=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("空闲看护未触发（5 秒内读未返回错误）")
	}
}

// TestAIIdleWatchDisabled 禁用看护（timeout<=0）：透传原始 ctx 与 body，读挂起由外层超时兜底
func TestAIIdleWatchDisabled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	watchCtx, bodyWrap, stopWatch := aiIdleWatch(ctx, 0)
	defer stopWatch()
	if watchCtx != ctx {
		t.Fatal("禁用看护时 watchCtx 应原样透传")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()           // 立即发出响应头（Disable 用例验证的是 body 读挂起由外层 ctx 兜底）
		time.Sleep(500 * time.Millisecond) // 无数据输出
	}))
	defer srv.Close()
	req, _ := http.NewRequestWithContext(watchCtx, http.MethodPost, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	_, err = bodyWrap(resp).Read(make([]byte, 16))
	if err == nil {
		t.Fatal("禁用看护时应由外层 ctx 超时兜底返回错误")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("预期外层超时错误，得到：%v", err)
	}
}

// TestAIIdleWatchNormalStream 正常流式：数据块间隔小于阈值时读完整响应不被误中断
func TestAIIdleWatchNormalStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 5; i++ {
			w.Write([]byte("data: {\"chunk\":" + string(rune('0'+i)) + "}\n\n"))
			w.(http.Flusher).Flush()
			time.Sleep(50 * time.Millisecond) // 块间隔远小于阈值
		}
	}))
	defer srv.Close()
	old := aiStreamIdleTimeout
	aiStreamIdleTimeout = 2 * time.Second
	defer func() { aiStreamIdleTimeout = old }()

	watchCtx, bodyWrap, stopWatch := aiIdleWatch(context.Background(), aiStreamIdleTimeout)
	defer stopWatch()
	req, _ := http.NewRequestWithContext(watchCtx, http.MethodPost, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer resp.Body.Close()
	rd := bodyWrap(resp)
	buf := make([]byte, 1024)
	total := 0
	for {
		n, err := rd.Read(buf)
		total += n
		if err != nil {
			break
		}
	}
	if total < 50 {
		t.Fatalf("正常流式被误中断：仅读到 %d 字节", total)
	}
	if cause := context.Cause(watchCtx); cause != nil {
		t.Fatalf("正常流式不应触发看护：cause=%v", cause)
	}
}
