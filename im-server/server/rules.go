package server

// 阶段一百零四：TRAE CN 同款"规则"功能——AI 回答前先读规则并遵守
// 架构完全复用长期记忆（阶段五十八）模式：MySQL 权威归口 + 管理接口（鉴权水位一致）+ 双链路注入（问答+Agent 任务）
// 与记忆的差异：记忆=背景参考（向量召回，相关才注入，受用户开关控制）；规则=硬性约束（全量注入，每问必守，无总开关）

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"im-server/model"
	"im-server/store"
)

const (
	ruleMaxPerScope = 50  // 每用户每范围（全局/单智能体）最多条数（防上下文滥用）
	ruleMaxLen      = 512 // 单条规则最大字符数
	ruleCtxMaxAll   = 30  // 单次注入最多条数（防上下文爆炸；新者优先）
)

// InitRules 规则模块初始化：建表（幂等，与 InitMemory 同款 AutoMigrate 归口）
func InitRules() {
	if err := store.DB.AutoMigrate(&model.AIRule{}); err != nil {
		panic("规则表初始化失败: " + err.Error())
	}
}

// rulesList 拉取生效规则（用户级全局 + 该智能体级，enabled=true，新者优先）
func rulesList(agentID uint, username string) []model.AIRule {
	if username == "" {
		return nil
	}
	var rows []model.AIRule
	store.DB.Where("username = ? AND agent_id IN ? AND enabled = ?", username, []uint{0, agentID}, true).
		Order("agent_id ASC, id DESC").Limit(ruleCtxMaxAll).Find(&rows)
	return rows
}

// rulesContextForAgent 规则注入文本归口（问答与 Agent 任务共用；无生效规则返回空不注入）
func rulesContextForAgent(agent *AIRunAgent, username string) string {
	if agent == nil || agent.ID == 0 || username == "" {
		return ""
	}
	items := rulesList(agent.ID, username)
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("以下是用户自定义的必须遵守的规则（优先级高于你的默认习惯；回答/执行前逐条对照检查；若规则与本次任务目标冲突，先向用户说明再行动）：")
	for _, r := range items {
		if r.AgentID == 0 {
			b.WriteString("\n- [全局规则] ")
		} else {
			b.WriteString("\n- [智能体规则] ")
		}
		b.WriteString(r.Content)
	}
	return b.String()
}

// ruleOwned 规则行归属校验归口：规则须存在且属于该用户（防跨用户操作）
func ruleOwned(w http.ResponseWriter, rid uint, username string) (*model.AIRule, bool) {
	var r model.AIRule
	if err := store.DB.First(&r, rid).Error; err != nil || r.Username != username {
		adminFail(w, http.StatusNotFound, "规则不存在")
		return nil, false
	}
	return &r, true
}

// ===== 用户侧管理 API（鉴权水位与记忆管理一致：username 查询参数） =====

// HandleRuleGet 规则列表（该用户全部规则：全局 + 当前智能体级，含禁用项；前端按范围标签区分）
func (s *Server) HandleRuleGet(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	var rows []model.AIRule
	store.DB.Where("username = ?", username).Order("agent_id ASC, id DESC").Find(&rows)
	adminJSON(w, map[string]interface{}{
		"rules": rows,
		"limit": ruleMaxPerScope,
	})
}

// HandleRuleAdd 新增规则（scope=global 用户级全局 / agent 仅当前智能体）
func (s *Server) HandleRuleAdd(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
		Scope   string `json:"scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	content := strings.TrimSpace(body.Content)
	if content == "" {
		adminFail(w, http.StatusBadRequest, "规则内容不能为空")
		return
	}
	if len([]rune(content)) > ruleMaxLen {
		adminFail(w, http.StatusBadRequest, "规则过长（最多 "+strconv.Itoa(ruleMaxLen)+" 字）")
		return
	}
	agentID := id // 默认仅当前智能体
	if body.Scope == "global" {
		agentID = 0
	}
	var n int64
	store.DB.Model(&model.AIRule{}).Where("username = ? AND agent_id = ?", username, agentID).Count(&n)
	if n >= int64(ruleMaxPerScope) {
		adminFail(w, http.StatusBadRequest, "该范围规则已达上限（"+strconv.Itoa(ruleMaxPerScope)+" 条），请先清理")
		return
	}
	row := model.AIRule{Username: username, AgentID: agentID, Content: content, Enabled: true}
	if err := store.DB.Create(&row).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "规则保存失败")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true, "rule": row})
}

// HandleRuleEnabled 规则启用开关（禁用后不注入不删除，可随时恢复）
func (s *Server) HandleRuleEnabled(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	rid, ok := adminPathID(w, r)
	if !ok {
		return
	}
	row, ok := ruleOwned(w, rid, username)
	if !ok {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Enabled == nil {
		adminFail(w, http.StatusBadRequest, "参数缺失")
		return
	}
	store.DB.Model(row).Update("enabled", *body.Enabled)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleRuleDelete 删除单条规则
func (s *Server) HandleRuleDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	rid, ok := adminPathID(w, r)
	if !ok {
		return
	}
	row, ok := ruleOwned(w, rid, username)
	if !ok {
		return
	}
	store.DB.Delete(row)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleRuleClear 清空规则（scope=global 仅全局 / agent 仅当前智能体 / all 全部）
func (s *Server) HandleRuleClear(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	if _, ok := memAgentReadable(w, id, username); !ok {
		return
	}
	switch r.URL.Query().Get("scope") {
	case "global":
		store.DB.Where("username = ? AND agent_id = 0", username).Delete(&model.AIRule{})
	case "agent":
		store.DB.Where("username = ? AND agent_id = ?", username, id).Delete(&model.AIRule{})
	default:
		store.DB.Where("username = ?", username).Delete(&model.AIRule{})
	}
	adminJSON(w, map[string]interface{}{"ok": true})
}

// ruleDestroyAgent 智能体删除级联归口：清理该智能体的全部规则（全局规则不受影响）
func ruleDestroyAgent(agentID uint) {
	if agentID == 0 {
		return
	}
	store.DB.Where("agent_id = ?", agentID).Delete(&model.AIRule{})
}
