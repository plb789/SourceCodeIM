package server

// ===== 阶段一百零六：Git 助手提示词后台管理（admin 可配置、保存即热更新） =====
// 职责分离：
//   1. 本文件内硬编码提示词降级为「默认值」——后台保存过自定义内容时 DB 值优先（后台调整属最新意图，重启不丢）；
//   2. 保存即更新内存缓存（下一次 AI 生成/审查立即按新提示词执行，无需重启服务端）；
//   3. 动态部分仍由代码归口注入：{files}=多文件硬性要求（commitmsg）、{target}=目标分支（review）。
//      模板含占位符则替换；模板不含时兜底追加（防管理员自改模板丢失纠偏/目标分支语义）。
// 存储：im_sys_prompt 通用系统提示词表（Key 唯一定位，后续其它提示词后台化复用本表归口）。

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// 提示词 Key（im_sys_prompt 唯一标识）
const (
	gitPromptKeyCommitmsg = "git_commitmsg" // 源代码管理「AI 生成提交信息」
	gitPromptKeyReview    = "git_review"    // 源代码管理「AI 审查报告」
)

// 默认提示词（原 agentfiles.go 硬编码文本原样迁移；后台无自定义值时使用）
const gitCommitmsgPromptDefault = "你是提交信息生成助手。根据 git diff 生成符合 Conventional Commits 规范的中文提交信息。" +
	"格式：第一行为标题：type(scope): 描述（type 从 feat/fix/refactor/style/docs/test/chore/perf 中选择，scope 可省略），一句话概括本次变更核心，不超过 50 字；" +
	"随后空一行，正文用「- 」列表简述变更，要求简单明了、一看就懂：" +
	"每个文件（或逻辑分组）一条、每条一行一句话说清改了什么即可，禁止缩进续行与长篇解释；" +
	"文件很多时按逻辑分组归并，正文总条数不超过 6 条、单条不超过 40 字；" +
	"仅当只改动 1 个文件且改动极小（如仅改错别字、调整一个数值）时才允许省略正文只留标题。" +
	"只输出提交信息本身，不要解释、引号或代码块标记。"

const gitReviewPromptDefault = "你是资深代码审查员。审查给出的分支变更 diff（相对目标分支 {target} 的三点差异），" +
	"输出 Markdown 审查报告，结构：## 变更总结（3-6 条要点，逐条概述改了什么、为什么）、" +
	"## 潜在问题（按严重程度列出，含位置与原因；确无问题则写\"未发现明显问题\"）、" +
	"## 改进建议（可执行的具体建议）。全中文，简洁专业。"

// 内存缓存（写锁保护；空串=后台无自定义，使用默认）
var (
	gitPromptMu        sync.RWMutex
	gitPromptCommitmsg = "" // 提交信息提示词后台自定义值
	gitPromptReview    = "" // 审查报告提示词后台自定义值
)

// gitFilesHint 多文件硬性要求注入文本（与原硬编码逻辑一致；{files} 占位符即注入本段）
func gitFilesHint(nFiles int) string {
	if nFiles < 2 {
		return ""
	}
	return "本次变更涉及 " + strconv.Itoa(nFiles) + " 个文件（diff 可能被截断，实际数量只会更多），每个文件或其逻辑分组都需在正文中有对应条目。"
}

// gitCommitmsgSys 提交信息系统提示词归口：自定义优先于默认，多文件硬性要求经 {files} 占位符或兜底追加
func gitCommitmsgSys(nFiles int) string {
	gitPromptMu.RLock()
	tpl := gitPromptCommitmsg
	gitPromptMu.RUnlock()
	if strings.TrimSpace(tpl) == "" {
		tpl = gitCommitmsgPromptDefault
	}
	if strings.Contains(tpl, "{files}") {
		tpl = strings.ReplaceAll(tpl, "{files}", gitFilesHint(nFiles))
	} else if nFiles >= 2 {
		// 模板未写 {files} 占位符但本次为多文件变更：兜底追加，保证纠偏基线不因模板自改而丢失
		tpl += gitFilesHint(nFiles)
	}
	return tpl
}

// gitReviewSys 审查报告系统提示词归口：{target} 占位符替换目标分支；模板未含占位符则兜底句尾补充
func gitReviewSys(target string) string {
	gitPromptMu.RLock()
	tpl := gitPromptReview
	gitPromptMu.RUnlock()
	if strings.TrimSpace(tpl) == "" {
		tpl = gitReviewPromptDefault
	}
	if !strings.Contains(tpl, "{target}") {
		tpl += "（相对目标分支 " + target + " 的三点差异）"
	}
	return strings.ReplaceAll(tpl, "{target}", target)
}

// initGitPrompts 表迁移 + 启动加载（initAgentRuntime 归口调用；DB 值优先于默认，重启不丢）
func initGitPrompts() {
	if err := store.DB.AutoMigrate(&model.SysPrompt{}); err != nil {
		logger.Error("系统提示词表迁移失败: %v", err)
		return
	}
	var rows []model.SysPrompt
	store.DB.Where("key_name IN ?", []string{gitPromptKeyCommitmsg, gitPromptKeyReview}).Find(&rows)
	gitPromptMu.Lock()
	for _, r := range rows {
		if strings.TrimSpace(r.Content) == "" {
			continue // 空内容视为未配置，保持默认
		}
		switch r.Key {
		case gitPromptKeyCommitmsg:
			gitPromptCommitmsg = r.Content
		case gitPromptKeyReview:
			gitPromptReview = r.Content
		}
	}
	gitPromptMu.Unlock()
	logger.Info("Git 助手提示词加载完成：提交信息 %s、审查报告 %s", gitPromptSource(gitPromptCommitmsg), gitPromptSource(gitPromptReview))
}

// gitPromptSource 来源描述（日志/管理页共用口径）
func gitPromptSource(v string) string {
	if strings.TrimSpace(v) == "" {
		return "默认"
	}
	return "自定义"
}

// handleAdminGitPromptGet 返回当前生效提示词（供管理页回填：有自定义回自定义，否则回默认全文）与来源标记
func (s *Server) handleAdminGitPromptGet(w http.ResponseWriter, r *http.Request) {
	gitPromptMu.RLock()
	cm, rv := gitPromptCommitmsg, gitPromptReview
	gitPromptMu.RUnlock()
	if strings.TrimSpace(cm) == "" {
		cm = gitCommitmsgPromptDefault
	}
	if strings.TrimSpace(rv) == "" {
		rv = gitReviewPromptDefault
	}
	adminJSON(w, map[string]interface{}{
		"commitmsg":        cm,
		"review":           rv,
		"commitmsg_custom": strings.TrimSpace(gitPromptCommitmsg) != "",
		"review_custom":    strings.TrimSpace(gitPromptReview) != "",
	})
}

// handleAdminGitPromptSave 保存提示词（内存热更新 + 落库持久化，部分更新：字段缺省=不改）：
// 置空串=恢复内置默认（删除 DB 记录并清内存覆盖）；非空=更新（超 5000 字截断防误粘超长文本灌库）
func (s *Server) handleAdminGitPromptSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Commitmsg *string `json:"commitmsg"`
		Review    *string `json:"review"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	apply := func(key string, p *string, cur *string) {
		if p == nil {
			return
		}
		v := strings.TrimSpace(*p)
		if v == "" { // 恢复默认：删行 + 清内存覆盖
			store.DB.Where("key_name = ?", key).Delete(&model.SysPrompt{})
			*cur = ""
			return
		}
		if rr := []rune(v); len(rr) > 5000 { // 防误粘超长文本灌库（提示词常规几百字内）
			v = string(rr[:5000])
		}
		var row model.SysPrompt
		if err := store.DB.Where("key_name = ?", key).First(&row).Error; err == nil {
			store.DB.Model(&row).Updates(map[string]interface{}{"content": v})
		} else {
			store.DB.Create(&model.SysPrompt{Key: key, Content: v})
		}
		*cur = v
	}
	gitPromptMu.Lock()
	apply(gitPromptKeyCommitmsg, req.Commitmsg, &gitPromptCommitmsg)
	apply(gitPromptKeyReview, req.Review, &gitPromptReview)
	cm, rv := gitPromptCommitmsg, gitPromptReview
	gitPromptMu.Unlock()
	logger.Info("Git 助手提示词后台热更新完成：提交信息 %s、审查报告 %s", gitPromptSource(cm), gitPromptSource(rv))
	adminJSON(w, map[string]interface{}{
		"ok":               true,
		"commitmsg_custom": strings.TrimSpace(cm) != "",
		"review_custom":    strings.TrimSpace(rv) != "",
	})
}
