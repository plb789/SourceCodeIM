package server

// 阶段一百八十二：任务模板一键重跑——发起参数快照序列化归口单测（纯函数，无需 DB）。
// 覆盖：nil/空切片落空串（列语义"空=无附件"）、图片 URL 数组与 @ 引用结构 JSON 往返一致。

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAgentTaskImgSnapshot(t *testing.T) {
	if got := agentTaskImgSnapshot(nil); got != "" {
		t.Fatalf("nil 图片快照应为空串，got %q", got)
	}
	if got := agentTaskImgSnapshot([]string{}); got != "" {
		t.Fatalf("空图片快照应为空串，got %q", got)
	}
	urls := []string{"/static/upload/a.png", "/static/upload/b.jpg"}
	got := agentTaskImgSnapshot(urls)
	var back []string
	if err := json.Unmarshal([]byte(got), &back); err != nil {
		t.Fatalf("图片快照应可反序列化: %v", err)
	}
	if !reflect.DeepEqual(back, urls) {
		t.Fatalf("图片快照往返不一致: got %v", back)
	}
}

func TestAgentTaskCtxSnapshot(t *testing.T) {
	if got := agentTaskCtxSnapshot(nil); got != "" {
		t.Fatalf("nil 引用快照应为空串，got %q", got)
	}
	ctxs := []AgentCtxReq{{Path: "docs/a.md", Dir: false}, {Path: "src", Dir: true}}
	got := agentTaskCtxSnapshot(ctxs)
	var back []AgentCtxReq
	if err := json.Unmarshal([]byte(got), &back); err != nil {
		t.Fatalf("引用快照应可反序列化: %v", err)
	}
	if !reflect.DeepEqual(back, ctxs) {
		t.Fatalf("引用快照往返不一致: got %v", back)
	}
}
