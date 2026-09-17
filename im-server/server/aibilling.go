package server

// 阶段一百三十八：AI 计费模式归口——双模式切换（TRAE CN 同款按次计费可选）
//
//	usage   = 按量计费（原模式）：1000 tokens = 1 积分，按当次实际消耗折算
//	percall = 按次计费（TRAE CN 同款）：每次模型调用扣固定积分，与该次 token 数无关（上下文膨胀平台吸收）
//
// 配置来源优先级（与 Agent 运行参数同款架构）：
//  1. 后台管理设置（DB 落库 admin_settings 归口，保存即生效 + 重启不丢）——后台保存后为唯一真源
//  2. config.yaml ai_billing 段（mode / percall_cost，mtime 热更检测）——后台未设置时的兜底
//
// 扣费统一走 aiChargeCost 归口（普通问答 ai.go / Agent 每轮 agentrun.go），切换只改配置全端生效；
// 服务端归口，客户端零计算只展示下发值

import (
	"errors"
	"im-server/model"
	"im-server/store"
	"os"
	"strconv"
	"sync"

	"gopkg.in/yaml.v3"
)

// errBillingMode 后台保存时模式非法错误（仅支持 usage / percall）
var errBillingMode = errors.New("计费模式非法（仅支持 usage/percall）")

// aiBillingCfg ai_billing 配置段内存快照（aiBillingMu 保护）
type aiBillingCfg struct {
	Mode        string  `yaml:"mode"`         // usage=按量 | percall=按次（非法值兜底 usage）
	PercallCost float64 `yaml:"percall_cost"` // 按次计费单次扣费（积分，<=0 兜底默认）
}

var (
	aiBillingMu    sync.Mutex
	aiBillingCache = aiBillingCfg{Mode: "usage", PercallCost: 0.01} // 配置缺失时的兜底：按量计费，单次 0.01 积分
	aiBillingMtime int64                                            // 上次加载时配置文件的修改时间（纳秒；0=尚未加载过）

	// 阶段一百三十八：后台管理覆盖值（DB 落库归口；非空/非零=后台设置过，优先于 config.yaml）
	aiBillingOvMode  string  // "usage" | "percall"；""=后台未设置
	aiBillingOvCost  float64 // 后台设置的按次单价；0=后台未设置
	aiBillingOvDone  bool    // 是否已尝试从 DB 加载过覆盖值（懒加载一次，之后后台保存时内存直更）
	aiBillingOvKnown bool    // 后台是否设置过（决定 yaml 变化是否还能影响生效值）
)

// 后台设置在 DB 中的 kind（复用 AgentWhitelist 全局 kv 行，username=""，加前缀避免与 Agent 参数冲突）
const (
	aiBillingKindMode = "billing_mode"
	aiBillingKindCost = "billing_percall_cost"
)

// aiBillingDefaultPercallCost 按次计费默认单价（配置未填时兜底；定价基准与按量模式的单次问答均价对齐）
const aiBillingDefaultPercallCost = 0.01

// aiBillingPath 定位配置文件（与 config.Load 同款候选路径：工作目录 / bin 目录，不硬编码绝对路径）
func aiBillingPath() string {
	for _, p := range []string{"config.yaml", "bin/config.yaml"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// aiBillingLoadYaml 解析 config.yaml 的 ai_billing 段（调用方持有 aiBillingMu）；
// 解析失败或字段非法时保留上次值/兜底值，不影响扣费链路
func aiBillingLoadYaml(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var root struct {
		AIBilling aiBillingCfg `yaml:"ai_billing"`
	}
	if err := yaml.Unmarshal(data, &root); err != nil {
		return
	}
	c := root.AIBilling
	if c.Mode != "usage" && c.Mode != "percall" {
		c.Mode = "usage"
	}
	if c.PercallCost <= 0 {
		c.PercallCost = aiBillingDefaultPercallCost
	}
	aiBillingCache = c
}

// aiBillingLoadOverride 首次调用时从 DB 加载后台覆盖值（懒加载一次；DB 异常静默走 yaml 兜底）
func aiBillingLoadOverride() {
	if aiBillingOvDone {
		return
	}
	aiBillingOvDone = true
	var rows []model.AgentWhitelist
	if err := store.DB.Where("kind IN ? AND username = ?", []string{aiBillingKindMode, aiBillingKindCost}, "").Find(&rows).Error; err != nil {
		return
	}
	for _, r := range rows {
		switch r.Kind {
		case aiBillingKindMode:
			if r.Value == "usage" || r.Value == "percall" {
				aiBillingOvMode = r.Value
				aiBillingOvKnown = true
			}
		case aiBillingKindCost:
			if v, err := strconv.ParseFloat(r.Value, 64); err == nil && v > 0 {
				aiBillingOvCost = v
				aiBillingOvKnown = true
			}
		}
	}
}

// aiBillingGet 获取当前生效计费配置：后台覆盖优先，其次 config.yaml（mtime 热更检测）
func aiBillingGet() aiBillingCfg {
	aiBillingMu.Lock()
	defer aiBillingMu.Unlock()
	aiBillingLoadOverride()
	// 阶段一百三十八：后台设置过 → DB 值为唯一真源（config.yaml 变化不再影响，后台改回来才生效）
	if aiBillingOvKnown {
		c := aiBillingCache // 以 yaml 值为基底保证字段完整
		if aiBillingOvMode != "" {
			c.Mode = aiBillingOvMode
		}
		if aiBillingOvCost > 0 {
			c.PercallCost = aiBillingOvCost
		}
		return c
	}
	if path := aiBillingPath(); path != "" {
		if fi, err := os.Stat(path); err == nil {
			mt := fi.ModTime().UnixNano()
			if mt != aiBillingMtime {
				aiBillingMtime = mt
				aiBillingLoadYaml(path)
			}
		}
	}
	return aiBillingCache
}

// aiBillingSetOverride 后台保存归口：DB upsert + 内存直更（保存即生效，无需重启）
// 返回生效快照；DB 写失败返回错误（内存不更，避免重启后回退造成"看似保存成功"）
func aiBillingSetOverride(mode string, percallCost float64) (aiBillingCfg, error) {
	aiBillingMu.Lock()
	defer aiBillingMu.Unlock()
	if mode != "usage" && mode != "percall" {
		return aiBillingCfg{}, errBillingMode
	}
	if percallCost <= 0 {
		percallCost = aiBillingDefaultPercallCost
	}
	// DB 落库（重启不丢）——复用全局 kv 行归口（username=""）
	agentSettingRowUpsert(aiBillingKindMode, mode)
	agentSettingRowUpsert(aiBillingKindCost, strconv.FormatFloat(percallCost, 'f', -1, 64))
	aiBillingOvMode = mode
	aiBillingOvCost = percallCost
	aiBillingOvKnown = true
	aiBillingOvDone = true
	c := aiBillingCache
	c.Mode = mode
	c.PercallCost = percallCost
	return c, nil
}

// aiBillingMode 当前计费模式（"usage" | "percall"）
func aiBillingMode() string { return aiBillingGet().Mode }

// aiBillingSource 当前生效值的来源（"override"=后台设置（DB 真源） / "config"=config.yaml 初始默认）——后台展示用
func aiBillingSource() string {
	aiBillingMu.Lock()
	defer aiBillingMu.Unlock()
	aiBillingLoadOverride()
	if aiBillingOvKnown {
		return "override"
	}
	return "config"
}

// aiChargeCost 计费归口：按当前模式折算本次模型调用应扣积分——
// 两处扣费点（普通问答 ai.go / Agent 每轮 agentrun.go）统一走此函数，模式切换只改配置
func aiChargeCost(totalTokens int) float64 {
	cfg := aiBillingGet()
	if cfg.Mode == "percall" {
		return cfg.PercallCost
	}
	return aiPointsCost(totalTokens)
}
