package server

// 阶段一百七十五：项目规则文件注入（TRAE CN 同款"工作区规则文件"）
// 工作区内放置 AGENTS.md 与 .trae/rules/*.md（两层发现：工作区根 + 当前项目子目录），
// Agent 任务启动时自动发现并注入系统提示——规则随仓库携带（git 提交即团队共享），与
// 阶段一百零四 UI 管理规则（AIRule 表）并存、效力等同。
// 读取通道归口文件面板分派（wsFileDispatch）：PC 在线读用户本地主工作区，离线回退服务端
// 工作区，与 Agent 文件工具的执行环境语义完全一致（一套代码覆盖两种场景）。

import (
	"fmt"
	"im-server/logger"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	agentRulesMaxFiles      = 10               // 单任务注入规则文件数量上限（防上下文滥用）
	agentRulesPerDirMax     = 8                // 单个 .trae/rules 目录最多采纳的 md 文件数
	agentRulesFileMaxRunes  = 8000             // 单文件注入字符上限（超出截断，尾部注明）
	agentRulesTotalMaxRunes = 30000            // 全部规则文件注入总字符上限
	agentRulesCacheTTL      = 60 * time.Second // 扫描结果缓存（连续任务免重复跨端扫描；低频变更可接受）
)

// agentRuleFile 单个规则文件（来源展示名 + 截断后内容）
type agentRuleFile struct {
	Source  string
	Content string
}

// agentRulesCache username → 缓存条目（扫描结果 60s 复用；切换当前项目时失效）
type agentRulesCacheEntry struct {
	block string
	files []string
	at    time.Time
}

var agentRulesCache sync.Map

// agentRulesInvalidate 规则文件缓存失效（切换当前项目/克隆后调用，下个任务立即重扫）
func agentRulesInvalidate(username string) {
	if username != "" {
		agentRulesCache.Delete(username)
	}
}

// agentRulesReqID 文件面板通道请求标识（独立前缀，与前端面板请求天然区分、日志可辨识）
func agentRulesReqID() string {
	return "rules-" + strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
}

// agentRulesJoinRel 拼接工作区相对路径（root 空=工作区根；seg 逐段拼接）
func agentRulesJoinRel(root string, segs ...string) string {
	parts := make([]string, 0, len(segs)+1)
	if root != "" {
		parts = append(parts, root)
	}
	parts = append(parts, segs...)
	return strings.Join(parts, "/")
}

// agentRulesReadFile 经文件面板通道读单个规则文件（相对路径自动落主工作区/服务端工作区）。
// 不存在/二进制/空内容均视为无规则静默跳过（工作区大多没有规则文件，异常不打扰任务）
func (s *Server) agentRulesReadFile(username, rel string) (agentRuleFile, bool) {
	res := s.wsFileDispatch(username, agentRulesReqID(), "read", rel, "")
	if res == nil || !res.OK || res.Binary || strings.TrimSpace(res.Content) == "" {
		return agentRuleFile{}, false
	}
	runes := []rune(res.Content)
	if len(runes) > agentRulesFileMaxRunes {
		return agentRuleFile{Source: rel, Content: string(runes[:agentRulesFileMaxRunes]) + "\n…（超长截断）"}, true
	}
	return agentRuleFile{Source: rel, Content: strings.TrimRight(res.Content, "\r\n")}, true
}

// agentRulesListRulesDir 列 .trae/rules 下的 md 文件（经文件面板 tree 通道；目录不存在=无规则）
func (s *Server) agentRulesListRulesDir(username, dir string) []string {
	res := s.wsFileDispatch(username, agentRulesReqID(), "tree", dir, "")
	if res == nil || !res.OK {
		return nil
	}
	names := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		if e.Dir || !strings.HasSuffix(strings.ToLower(e.Name), ".md") {
			continue // 只要 md 文件；子目录与其余文件名跳过
		}
		names = append(names, e.Name)
		if len(names) >= agentRulesPerDirMax {
			break
		}
	}
	sort.Strings(names)
	return names
}

// agentRulesCollect 发现并读取规则文件（roots 为工作区相对目录列表，""=工作区根）。
// 每层固定候选 AGENTS.md + .trae/rules/*.md；总量受 文件数/总字符 双上限收敛
func (s *Server) agentRulesCollect(username string, roots []string) []agentRuleFile {
	out := make([]agentRuleFile, 0, 4)
	total := 0
	appendFile := func(f agentRuleFile) bool {
		if len(out) >= agentRulesMaxFiles || total >= agentRulesTotalMaxRunes {
			return false // 达上限：后续层/文件不再采纳
		}
		out = append(out, f)
		total += len([]rune(f.Content))
		return true
	}
	for _, root := range roots {
		// 固定候选：AGENTS.md（广泛事实标准）
		if f, ok := s.agentRulesReadFile(username, agentRulesJoinRel(root, "AGENTS.md")); ok {
			if !appendFile(f) {
				break
			}
		}
		// 目录通配：.trae/rules/*.md（TRAE CN 工作区规则目录，文件名任意）
		for _, name := range s.agentRulesListRulesDir(username, agentRulesJoinRel(root, ".trae", "rules")) {
			if f, ok := s.agentRulesReadFile(username, agentRulesJoinRel(root, ".trae", "rules", name)); ok {
				if !appendFile(f) {
					break
				}
			}
		}
		if len(out) >= agentRulesMaxFiles || total >= agentRulesTotalMaxRunes {
			break
		}
	}
	return out
}

// agentRulesBlock 把规则文件组装为系统提示区块（无文件返回空）
func agentRulesBlock(files []agentRuleFile) string {
	if len(files) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("【项目规则文件】以下规则来自工作区内的规则文件（AGENTS.md / .trae/rules，随项目携带），与用户自定义规则同等效力，执行前逐条对照检查：")
	for _, f := range files {
		fmt.Fprintf(&b, "\n\n[来源: %s]\n%s", f.Source, f.Content)
	}
	return b.String()
}

// agentRulesFilesBlock 任务启动入口：发现+组装（带 60s 缓存），无规则返回空不注入
func (s *Server) agentRulesFilesBlock(username string) (string, []string) {
	if strings.TrimSpace(username) == "" {
		return "", nil
	}
	if v, ok := agentRulesCache.Load(username); ok {
		if e, ok := v.(*agentRulesCacheEntry); ok && time.Since(e.at) < agentRulesCacheTTL {
			return e.block, e.files
		}
	}
	// 两层发现：工作区根 + 当前项目子目录（.im_proj.json 的 cur，与系统提示"当前项目"同源）
	roots := []string{""}
	if cur := strings.TrimSpace(strings.Trim(wsProjMetaLoad(username).Cur, "/\\")); cur != "" {
		roots = append(roots, cur)
	}
	files := s.agentRulesCollect(username, roots)
	block := agentRulesBlock(files)
	srcs := make([]string, len(files))
	for i, f := range files {
		srcs[i] = f.Source
	}
	agentRulesCache.Store(username, &agentRulesCacheEntry{block: block, files: srcs, at: time.Now()})
	if len(files) > 0 {
		logger.Info("Agent 注入项目规则文件（用户 %s，来源 %d 个：%s）", username, len(files), strings.Join(srcs, "、"))
	}
	return block, srcs
}
