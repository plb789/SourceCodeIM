package server

// 阶段一百九十：多模型切换/协同单测——aiOverrideAgent（A·会话内一键切换：空名原样/同名短路/
// 未知名报错/换绑浅拷贝且图片能力随新源继承）与 aiLightAgent（B·轻模型协同：未配置回退/
// 配置后换绑）纯函数归口（直接操纵包级索引变量，仿 agentlint_test.go 惯例无需 DB）

import (
	"strings"
	"testing"

	"im-server/config"
)

// aiModelTestAgents 测试夹具：两个启用源 + 一个绑定 m1 的智能体，返回清理函数（恢复包级状态）
func aiModelTestAgents(t *testing.T) (*AIRunAgent, *config.AIProviderConfig, *config.AIProviderConfig) {
	t.Helper()
	m1 := &config.AIProviderConfig{Name: "测试源一", APIURL: "http://a", APIKey: "k1", Model: "model-a", SupportsImage: true}
	m2 := &config.AIProviderConfig{Name: "测试源二", APIURL: "http://b", APIKey: "k2", Model: "model-b"}
	agent := &AIRunAgent{ID: 7, Name: "AI编程助手", Provider: m1, SupportsImage: true}
	aiMu.Lock()
	prevList, prevLightName, prevLight := aiProviders, aiLightProviderName, aiLightProvider
	aiProviders = []*config.AIProviderConfig{m1, m2}
	aiMu.Unlock()
	t.Cleanup(func() {
		aiMu.Lock()
		aiProviders, aiLightProviderName, aiLightProvider = prevList, prevLightName, prevLight
		aiMu.Unlock()
	})
	return agent, m1, m2
}

func TestAIOverrideAgent(t *testing.T) {
	agent, m1, m2 := aiModelTestAgents(t)

	// 空名：原样返回（跟随智能体绑定），指针不变
	got, err := aiOverrideAgent(agent, "")
	if err != nil || got != agent {
		t.Fatalf("空名应原样返回（got=%v err=%v）", got, err)
	}
	// 与当前绑定同名：短路返回原指针，不产生无谓拷贝
	got, err = aiOverrideAgent(agent, "测试源一")
	if err != nil || got != agent {
		t.Fatalf("同名应短路返回（got=%v err=%v）", got, err)
	}
	// 换绑：浅拷贝新指针，Provider/SupportsImage 随新源继承，其余字段保留
	got, err = aiOverrideAgent(agent, "测试源二")
	if err != nil {
		t.Fatalf("换绑不应报错：%v", err)
	}
	if got == agent {
		t.Fatal("换绑应返回新指针")
	}
	if got.Provider != m2 {
		t.Errorf("Provider 应换绑为测试源二，实际 %v", got.Provider)
	}
	if got.SupportsImage {
		t.Error("SupportsImage 应随新源继承（测试源二不支持图片）")
	}
	if got.Name != agent.Name || got.ID != agent.ID || got.SystemPrompt != agent.SystemPrompt {
		t.Error("换绑后名称/ID/提示词应保留")
	}
	// 未知名：报错且提示含服务名（协议直发兜底）
	if _, err = aiOverrideAgent(agent, "不存在的源"); err == nil || !strings.Contains(err.Error(), "不存在的源") {
		t.Errorf("未知名应报错并含服务名，实际 %v", err)
	}
	// 未绑定模型的智能体 + 显式选模型：允许（未绑定智能体+选模型也可用，与问答/任务口径一致）
	bare := &AIRunAgent{Name: "裸智能体"}
	got, err = aiOverrideAgent(bare, "测试源一")
	if err != nil || got.Provider != m1 || !got.SupportsImage {
		t.Fatalf("未绑定智能体+选模型应生效（got=%v err=%v）", got, err)
	}
}

func TestAILightAgent(t *testing.T) {
	agent, _, m2 := aiModelTestAgents(t)

	// 未配置轻模型：原样返回（辅助调用跟随绑定模型，维持现状）
	if got := aiLightAgent(agent); got != agent {
		t.Fatal("未配置轻模型应原样返回")
	}
	// 配置轻模型：换绑轻模型，图片能力随轻模型继承
	aiMu.Lock()
	aiLightProvider = m2
	aiMu.Unlock()
	got := aiLightAgent(agent)
	if got == agent || got.Provider != m2 {
		t.Fatalf("应换绑轻模型（got=%v）", got)
	}
	if got.SupportsImage {
		t.Error("SupportsImage 应随轻模型继承")
	}
	if got.Name != agent.Name {
		t.Error("轻模型换绑应保留智能体名（事件流/日志可读性）")
	}
	// nil 智能体：安全返回 nil
	if got := aiLightAgent(nil); got != nil {
		t.Fatal("nil 智能体应返回 nil")
	}
	// 未绑定模型的智能体：换绑轻模型（辅助调用获得真实模型，优于 Mock 空转）
	bare := &AIRunAgent{Name: "裸智能体"}
	if got := aiLightAgent(bare); got.Provider != m2 {
		t.Fatal("未绑定智能体也应换绑轻模型")
	}
}
