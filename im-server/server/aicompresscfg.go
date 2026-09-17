package server

// 阶段一百三十九：Agent 任务历史压缩方式后台设置归口——双口径可选（TRAE CN 同款 KB 可切）
//
//	tokens = 估算 token 口径（阶段八十四原判据）：CJK≈1 字符 1 token、其余≈4 字符 1 token 粗估
//	kb     = KB 字节口径（TRAE CN 状态栏同款）：上下文累计 UTF-8 字节数达阈值触发
//
// 配置来源优先级（与 AI 计费设置 aibilling.go 同款架构）：
//  1. 后台管理设置（DB 落库 admin_settings 归口，保存即生效 + 重启不丢）——后台保存后为唯一真源
//  2. config.yaml ai 段启动加载值（compress_threshold_tokens / compress_threshold_kb）作初始默认
//
// 判据消费归口 agentCompressTaskHistory（agentrun.go，每轮模型调用前）；AI 问答压缩不走此配置
// （仍由 aiCompressThreshold token 判据归口）。切换只改配置，下一轮模型调用即按新口径压缩。

import (
	"errors"
	"im-server/model"
	"im-server/store"
	"strconv"
	"sync"
)

// errCompressCfgMode 后台保存时压缩方式非法错误（仅支持 tokens / kb）
var errCompressCfgMode = errors.New("压缩方式非法（仅支持 tokens/kb）")

// aiCompressCfg 压缩方式配置快照（aiCompressCfgMu 保护）
type aiCompressCfg struct {
	Mode   string // "tokens"=估算 token 判据 | "kb"=KB 字节判据（非法值兜底 kb）
	Tokens int    // tokens 模式触发阈值（估算 token，>0）
	KB     int    // kb 模式触发阈值（KB，>0）
}

var (
	aiCompressCfgMu     sync.Mutex
	aiCompressCfgCache  aiCompressCfg // 初始默认（首次访问时快照 config.yaml 启动加载值，见 aiCompressCfgGet）
	aiCompressCfgInited bool          // 初始默认是否已快照（loadAIConfig 启动先行，故懒快照可取到 yaml 值）

	// 后台管理覆盖值（DB 落库归口；Known=后台设置过，优先于 config.yaml 初始默认）
	aiCompressCfgOv     aiCompressCfg
	aiCompressCfgOvDone bool
	aiCompressCfgOvKnow bool
)

// 后台设置在 DB 中的 kind（复用 AgentWhitelist 全局 kv 行，username=""，前缀避免与其它参数冲突）
const (
	aiCompressCfgKindMode   = "compress_mode"
	aiCompressCfgKindTokens = "compress_tokens"
	aiCompressCfgKindKB     = "compress_kb"
)

// aiCompressCfgSanitize 字段合法性兜底（mode 非法兜底 kb；阈值 <=0 时回退启动默认）
func aiCompressCfgSanitize(c aiCompressCfg) aiCompressCfg {
	if c.Mode != "tokens" && c.Mode != "kb" {
		c.Mode = "kb"
	}
	if c.Tokens <= 0 {
		c.Tokens = aiCompressThreshold
	}
	if c.KB <= 0 {
		c.KB = aiCompressThresholdKB
	}
	return c
}

// aiCompressCfgLoadOverride 首次调用时从 DB 加载后台覆盖值（懒加载一次；DB 异常静默走初始默认）
func aiCompressCfgLoadOverride() {
	if aiCompressCfgOvDone {
		return
	}
	aiCompressCfgOvDone = true
	var rows []model.AgentWhitelist
	if err := store.DB.Where("kind IN ? AND username = ?", []string{
		aiCompressCfgKindMode, aiCompressCfgKindTokens, aiCompressCfgKindKB}, "").Find(&rows).Error; err != nil {
		return
	}
	ov := aiCompressCfgCache
	for _, r := range rows {
		switch r.Kind {
		case aiCompressCfgKindMode:
			if r.Value == "tokens" || r.Value == "kb" {
				ov.Mode = r.Value
				aiCompressCfgOvKnow = true
			}
		case aiCompressCfgKindTokens:
			if v, err := strconv.Atoi(r.Value); err == nil && v > 0 {
				ov.Tokens = v
				aiCompressCfgOvKnow = true
			}
		case aiCompressCfgKindKB:
			if v, err := strconv.Atoi(r.Value); err == nil && v > 0 {
				ov.KB = v
				aiCompressCfgOvKnow = true
			}
		}
	}
	aiCompressCfgOv = aiCompressCfgSanitize(ov)
}

// aiCompressCfgGet 获取当前生效压缩配置：后台覆盖优先，其次 config.yaml 启动加载值初始默认
func aiCompressCfgGet() aiCompressCfg {
	aiCompressCfgMu.Lock()
	defer aiCompressCfgMu.Unlock()
	// 首次访问快照初始默认（loadAIConfig 启动先行，此时 yaml 的 compress_* 已加载到全局变量）
	if !aiCompressCfgInited {
		aiCompressCfgInited = true
		aiCompressCfgCache = aiCompressCfgSanitize(aiCompressCfg{Mode: "kb", Tokens: aiCompressThreshold, KB: aiCompressThresholdKB})
	}
	aiCompressCfgLoadOverride()
	if aiCompressCfgOvKnow { // 后台设置过 → DB 值为唯一真源（config.yaml 变化不再影响）
		return aiCompressCfgOv
	}
	return aiCompressCfgCache
}

// aiCompressCfgSetOverride 后台保存归口：DB upsert + 内存直更（保存即生效，无需重启）。
// 返回生效快照；DB 写失败返回错误（内存不更，避免重启后回退造成"看似保存成功"）
func aiCompressCfgSetOverride(mode string, tokens, kb int) (aiCompressCfg, error) {
	if mode != "tokens" && mode != "kb" {
		return aiCompressCfg{}, errCompressCfgMode
	}
	aiCompressCfgMu.Lock()
	defer aiCompressCfgMu.Unlock()
	if !aiCompressCfgInited { // 保证未快照时兜底值可用（阈值 <=0 回退启动默认）
		aiCompressCfgInited = true
		aiCompressCfgCache = aiCompressCfgSanitize(aiCompressCfg{Mode: "kb", Tokens: aiCompressThreshold, KB: aiCompressThresholdKB})
	}
	cur := aiCompressCfgCache
	if aiCompressCfgOvKnow {
		cur = aiCompressCfgOv
	}
	if tokens <= 0 {
		tokens = cur.Tokens // 部分更新语义：未传/非法的阈值维持原值
	}
	if kb <= 0 {
		kb = cur.KB
	}
	// DB 落库（重启不丢）——复用全局 kv 行归口（username=""）
	agentSettingRowUpsert(aiCompressCfgKindMode, mode)
	agentSettingRowUpsert(aiCompressCfgKindTokens, strconv.Itoa(tokens))
	agentSettingRowUpsert(aiCompressCfgKindKB, strconv.Itoa(kb))
	ov := aiCompressCfgSanitize(aiCompressCfg{Mode: mode, Tokens: tokens, KB: kb})
	aiCompressCfgOv = ov
	aiCompressCfgOvKnow = true
	aiCompressCfgOvDone = true
	return ov, nil
}

// aiCompressCfgSource 当前生效值的来源（"override"=后台设置（DB 真源）/ "config"=config.yaml 初始默认）——后台展示用
func aiCompressCfgSource() string {
	aiCompressCfgMu.Lock()
	defer aiCompressCfgMu.Unlock()
	if !aiCompressCfgInited {
		aiCompressCfgInited = true
		aiCompressCfgCache = aiCompressCfgSanitize(aiCompressCfg{Mode: "kb", Tokens: aiCompressThreshold, KB: aiCompressThresholdKB})
	}
	aiCompressCfgLoadOverride()
	if aiCompressCfgOvKnow {
		return "override"
	}
	return "config"
}
