package server

// 阶段八十一：wsProjClone 真实克隆链路测试（gitee 小仓库，3 秒内完成）
// 验证：clone 成功、进度回调多次触发、取消路径清理半成品

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cloneTestDir(t *testing.T, u, name string) string {
	t.Helper()
	ws, err := agentWorkspaceDir(u)
	if err != nil {
		t.Fatalf("工作区目录获取失败: %v", err)
	}
	return filepath.Join(ws, name)
}

func TestWsProjCloneReal(t *testing.T) {
	u := "clonetest_real"
	name := "wsclonetestrepo"
	dest := cloneTestDir(t, u, name)
	_ = os.RemoveAll(dest)

	var pushes int
	var lastPct int
	push := func(pct int, stage, speed string, sent int64) {
		pushes++
		lastPct = pct
	}

	done := make(chan *wsFileResult, 1)
	go func() {
		done <- wsProjClone(u, "testreq1",
			`{"url":"https://gitee.com/mirrors/giscus.git","name":"`+name+`"}`, push)
	}()

	select {
	case res := <-done:
		if !res.OK {
			t.Fatalf("clone 失败: %s", res.Error)
		}
		t.Logf("clone 成功，进度回调 %d 次，最终 pct=%d", pushes, lastPct)
		if pushes < 1 {
			t.Errorf("进度回调未触发（pushes=%d）", pushes)
		}
		_ = os.RemoveAll(dest)
	case <-time.After(60 * time.Second):
		t.Fatal("clone 超时 60s（疑似卡死）")
	}
}

func TestWsProjCloneCancelReal(t *testing.T) {
	u := "clonetest_real"
	name := "wsclonetestcancel"
	dest := cloneTestDir(t, u, name)
	_ = os.RemoveAll(dest)

	// 大仓库（gitee go 镜像，匿名可访问）必能撑过取消窗口。
	// 勿用需认证的仓库（如 gitee linux.git 匿名 401）：克隆进程被 GCM 弹窗/认证失败提前终结，测不到真实传输窗口
	done := make(chan *wsFileResult, 1)
	go func() {
		done <- wsProjClone(u, "testreq2",
			`{"url":"https://gitee.com/mirrors/go.git","name":"`+name+`"}`, nil)
	}()

	time.Sleep(2 * time.Second)
	cancelRes := wsProjCloneCancel(u, `{"target":"testreq2"}`)
	if !cancelRes.OK {
		t.Fatalf("取消请求失败: %s", cancelRes.Error)
	}

	select {
	case res := <-done:
		if res.OK {
			t.Fatal("取消后克隆不应成功")
		}
		if !strings.Contains(res.Error, "取消") {
			t.Errorf("取消错误文案不符: %q", res.Error)
		}
		if _, err := os.Stat(dest); err == nil {
			t.Error("半成品目录未清理")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("取消后克隆未终止（疑似 kill 失败）")
	}
}

// TestWsProjCloneAuthFailFast 需认证的匿名仓库应秒级失败（禁用 GCM 交互弹窗后不挂进程）。
// gitee linux.git 匿名 401：未禁弹窗时会卡在 Git Credential Manager 对话框直至超时
func TestWsProjCloneAuthFailFast(t *testing.T) {
	u := "clonetest_real"
	name := "wsclonetestauth"
	dest := cloneTestDir(t, u, name)
	_ = os.RemoveAll(dest)

	done := make(chan *wsFileResult, 1)
	go func() {
		done <- wsProjClone(u, "testreq3",
			`{"url":"https://gitee.com/mirrors/linux.git","name":"`+name+`"}`, nil)
	}()

	select {
	case res := <-done:
		if res.OK {
			t.Fatal("匿名访问需认证仓库不应成功")
		}
		t.Logf("快速失败（预期）：%.120s", res.Error)
		if !strings.Contains(res.Error, "Token") && !strings.Contains(res.Error, "Authentication") && !strings.Contains(res.Error, "401") {
			t.Errorf("错误文案未体现认证问题: %q", res.Error)
		}
		if _, err := os.Stat(dest); err == nil {
			t.Error("失败后目录未清理")
		}
	case <-time.After(45 * time.Second):
		t.Fatal("认证失败未在 45s 内返回（疑似仍卡 GCM 交互弹窗）")
	}
}
