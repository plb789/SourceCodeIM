package server

// 阶段一百八十四：定时/巡检任务——调度计算与快照解析纯函数单测（无需 DB）。
// 覆盖：agentCronNext（interval 正常/边界 1 与 1440/非法值；daily 当天未来/已过/相等顺延/非法格式；
// 未知 kind 拒绝）、agentCronDesc 中文描述归口、agentCronParseImages/Ctxs（空/坏 JSON/合法往返）。
// DB 路径（到期扫描/防重叠/启停）经编译校验 + 服务运行 HTTP 实测覆盖（与阶段一百八十二同惯例）。

import (
	"reflect"
	"testing"
	"time"
)

func TestAgentCronNextInterval(t *testing.T) {
	from := time.Date(2026, 9, 28, 10, 0, 0, 0, time.Local)
	cases := []struct {
		value string
		want  time.Time
		ok    bool
	}{
		{"30", from.Add(30 * time.Minute), true},
		{"1", from.Add(1 * time.Minute), true},       // 下边界
		{"1440", from.Add(1440 * time.Minute), true}, // 上边界（1 天）
		{"0", time.Time{}, false},
		{"-5", time.Time{}, false},
		{"1441", time.Time{}, false},
		{"abc", time.Time{}, false},
		{"", time.Time{}, false},
		{" 15 ", from.Add(15 * time.Minute), true}, // 前后空白容忍
	}
	for _, c := range cases {
		got, err := agentCronNext("interval", c.value, from)
		if c.ok && (err != nil || !got.Equal(c.want)) {
			t.Fatalf("interval %q 应为 %v，got %v err=%v", c.value, c.want, got, err)
		}
		if !c.ok && err == nil {
			t.Fatalf("interval %q 应报错", c.value)
		}
	}
}

func TestAgentCronNextDaily(t *testing.T) {
	loc := time.Local
	// 当天时刻未到：落当天 08:30
	got, err := agentCronNext("daily", "08:30", time.Date(2026, 9, 28, 7, 0, 0, 0, loc))
	if err != nil || !got.Equal(time.Date(2026, 9, 28, 8, 30, 0, 0, loc)) {
		t.Fatalf("未到时刻应落当天：got %v err=%v", got, err)
	}
	// 当天时刻已过：顺延明天 08:30
	got, err = agentCronNext("daily", "08:30", time.Date(2026, 9, 28, 10, 0, 0, 0, loc))
	if err != nil || !got.Equal(time.Date(2026, 9, 29, 8, 30, 0, 0, loc)) {
		t.Fatalf("已过时刻应顺延明天：got %v err=%v", got, err)
	}
	// 恰好相等（含秒内）：不算未来，顺延明天（防同一时刻重复触发）
	got, err = agentCronNext("daily", "08:30", time.Date(2026, 9, 28, 8, 30, 0, 0, loc))
	if err != nil || !got.Equal(time.Date(2026, 9, 29, 8, 30, 0, 0, loc)) {
		t.Fatalf("相等时刻应顺延明天：got %v err=%v", got, err)
	}
	got, err = agentCronNext("daily", "08:30", time.Date(2026, 9, 28, 8, 30, 30, 0, loc))
	if err != nil || !got.Equal(time.Date(2026, 9, 29, 8, 30, 0, 0, loc)) {
		t.Fatalf("秒级已过应顺延明天：got %v err=%v", got, err)
	}
	// 跨月边界：9 月 30 日 23:00 的次日 08:30 落 10 月 1 日
	got, err = agentCronNext("daily", "08:30", time.Date(2026, 9, 30, 23, 0, 0, 0, loc))
	if err != nil || !got.Equal(time.Date(2026, 10, 1, 8, 30, 0, 0, loc)) {
		t.Fatalf("跨月应正确：got %v err=%v", got, err)
	}
	// 非法格式
	for _, bad := range []string{"", "ab:cd", "25:00", "08:70", "0830"} {
		if _, err := agentCronNext("daily", bad, time.Now()); err == nil {
			t.Fatalf("daily %q 应报错", bad)
		}
	}
	// 未知调度类型拒绝
	if _, err := agentCronNext("weekly", "1", time.Now()); err == nil {
		t.Fatalf("未知 kind 应报错")
	}
}

func TestAgentCronDesc(t *testing.T) {
	if got := agentCronDesc("interval", "30"); got != "每 30 分钟" {
		t.Fatalf("interval 描述不符：%q", got)
	}
	if got := agentCronDesc("daily", "08:30"); got != "每天 08:30" {
		t.Fatalf("daily 描述不符：%q", got)
	}
	if got := agentCronDesc("weekly", "1"); got != "weekly:1" {
		t.Fatalf("未知类型应原样回退：%q", got)
	}
}

func TestAgentCronParseSnapshot(t *testing.T) {
	// 图片快照：空/坏 JSON 回退 nil，合法往返一致
	if got := agentCronParseImages(""); got != nil {
		t.Fatalf("空图片快照应回 nil，got %v", got)
	}
	if got := agentCronParseImages("not json"); got != nil {
		t.Fatalf("坏 JSON 应回 nil，got %v", got)
	}
	urls := []string{"/static/upload/a.png", "/static/upload/b.jpg"}
	if got := agentCronParseImages(`["/static/upload/a.png","/static/upload/b.jpg"]`); !reflect.DeepEqual(got, urls) {
		t.Fatalf("图片快照解析不符：%v", got)
	}
	// 引用快照：语义同上，含 dir 标记往返
	if got := agentCronParseCtxs(""); got != nil {
		t.Fatalf("空引用快照应回 nil，got %v", got)
	}
	if got := agentCronParseCtxs("[bad"); got != nil {
		t.Fatalf("坏 JSON 应回 nil，got %v", got)
	}
	ctxs := []AgentCtxReq{{Path: "docs/a.md"}, {Path: "src", Dir: true}}
	if got := agentCronParseCtxs(`[{"path":"docs/a.md"},{"path":"src","dir":true}]`); !reflect.DeepEqual(got, ctxs) {
		t.Fatalf("引用快照解析不符：%+v", got)
	}
}
