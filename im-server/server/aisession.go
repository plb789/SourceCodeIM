package server

// 阶段七十一：AI 多会话（Trae CN 同款"新建会话"）——用户+智能体 多会话归口。
// 消息归属采用消息级盖戳：AI 提问/回复、Agent 任务回显与答复落库时写入 im_message.ai_session_id
// （任务记录同步盖戳 session_id），上下文组装（aiBuildContext）、历史查询（handleHistory）与
// 任务卡重放均按列过滤。任意历史会话可随时续聊（首版区间方案受消息 id 单调限制无法回写旧会话，已废弃）。
// ai_session_id=0 为"默认会话"：存量历史与未区分消息归口（老用户无感，行为不变）。

import (
	"encoding/json"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// initAISessionTable 会话表迁移 + 存量区间数据一次性迁移（由 InitAgent 调用）
func initAISessionTable() {
	if err := store.DB.AutoMigrate(&model.AISession{}); err != nil {
		logger.Error("AI 会话表迁移失败: %v", err)
		return
	}
	// 阶段七十一修复：移除区间法时期遗留的联合唯一索引（username+agent_name 唯一导致
	// 每用户+智能体仅能建一行会话，第二次"新建会话"必撞唯一约束静默失败），
	// 改为普通联合索引支持多会话（AutoMigrate 不会删既有索引，需显式迁移；重复执行幂等）
	if err := store.DB.Exec("ALTER TABLE im_ai_session DROP INDEX idx_aisess_user_agent_id").Error; err == nil {
		logger.Info("已移除 im_ai_session 遗留联合唯一索引 idx_aisess_user_agent_id（原索引导致多会话新建失败）")
	}
	store.DB.Exec("ALTER TABLE im_ai_session ADD INDEX idx_aisess_user_agent (username, agent_name)")
	backfillAISessionStamps()
}

// backfillAISessionStamps 存量区间法数据一次性迁移：首版方案按 first_msg_id 区间切分会话，
// 升级盖戳方案后按区间将消息批量回填 ai_session_id（幂等：无 first>0 行即跳过）。
// first=0 的遗留行（"默认会话"/"新建待开"）不承载盖戳数据，直接删除——
// 其覆盖的未盖戳消息天然归入虚拟默认会话（ai_session_id=0），历史不丢
func backfillAISessionStamps() {
	var rows []model.AISession
	store.DB.Where("first_msg_id > 0").Order("id ASC").Find(&rows)
	for _, r := range rows {
		// 上界 = 同 用户+智能体 中大于本会话起点的最小 first（含头不含尾；无则无上界）
		var next model.AISession
		q := store.DB.Model(&model.Message{}).Where(
			"ai_session_id = 0 AND msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) AND id >= ?",
			[]int{2, 4, 5}, r.Username, r.AgentName, r.AgentName, r.Username, r.FirstMsgID)
		if err := store.DB.Where("username = ? AND agent_name = ? AND first_msg_id > ?",
			r.Username, r.AgentName, r.FirstMsgID).Order("first_msg_id ASC").First(&next).Error; err == nil {
			q = q.Where("id < ?", next.FirstMsgID)
		}
		q.Update("ai_session_id", r.ID)
	}
	if len(rows) > 0 {
		// 迁移完成后清理遗留行并把区间边界归零（幂等标记）
		store.DB.Where("first_msg_id = 0").Delete(&model.AISession{})
		store.DB.Model(&model.AISession{}).Where("first_msg_id > 0").Update("first_msg_id", 0)
		logger.Info("AI 多会话存量区间数据迁移完成（会话 %d 条）", len(rows))
	}
}

// aiSessionValidate 校验会话归属（sid=0 默认会话恒通过；sid>0 必须存在本人会话行，
// 防协议直发把消息盖到他人/不存在的会话）
func aiSessionValidate(username, agentName string, sid uint) bool {
	if sid == 0 {
		return true
	}
	var cnt int64
	store.DB.Model(&model.AISession{}).
		Where("id = ? AND username = ? AND agent_name = ?", sid, username, agentName).
		Count(&cnt)
	return cnt > 0
}

// aiSessionAutoTitle 会话标题生成归口：首条用户消息（提问/任务目标）落库后，
// 占位标题"新会话"以首问截取生成（默认会话 sid=0 不命名，已命名会话不覆盖）
func aiSessionAutoTitle(username, agentName string, sid uint, question string) {
	if sid == 0 {
		return
	}
	title := strings.TrimSpace(question)
	if title == "" {
		return
	}
	var row model.AISession
	if err := store.DB.Where("id = ? AND username = ? AND agent_name = ?", sid, username, agentName).
		First(&row).Error; err != nil {
		return
	}
	if row.Title != "" && row.Title != "新会话" {
		return
	}
	if r := []rune(title); len(r) > 24 {
		title = string(r[:24]) + "…"
	}
	store.DB.Model(&row).Update("title", title)
}

// aiSessionItem 会话列表条目（服务端归口下发）
type aiSessionItem struct {
	ID         uint   `json:"id"`
	Title      string `json:"title"`
	CreateTime int64  `json:"create_time"`
}

// handleAISessionList 会话列表查询（上行 to_user=智能体名；下发全部会话 + 当前生效会话 id）。
// 恒定首个条目为虚拟默认会话（id=0，存量历史与未区分消息归口），保证老用户可回看全量历史
func (s *Server) handleAISessionList(c *Client, msg *protocol.Message) {
	agent := aiAgentForUser(strings.TrimSpace(msg.ToUser), c.username)
	if agent == nil {
		s.sendError(c, "AI 助手不存在或已被移除")
		return
	}
	var rows []model.AISession
	store.DB.Where("username = ? AND agent_name = ?", c.username, agent.Name).Order("id ASC").Find(&rows)
	items := []aiSessionItem{{ID: 0, Title: "默认会话"}}
	var currentID uint
	for _, r := range rows {
		items = append(items, aiSessionItem{ID: r.ID, Title: r.Title, CreateTime: r.CreateTime.Unix()})
		currentID = r.ID // 最新一条即当前生效会话
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"agent":      agent.Name,
		"current_id": currentID,
		"sessions":   items,
	})
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeAISessionList,
		FromUser:  c.username,
		ToUser:    agent.Name,
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(resp)
	c.send(out)
}

// aiSessionEmpty 会话是否从未使用（无消息盖戳且无任务记录）——新建时清理防面板堆积空会话
func aiSessionEmpty(username, agentName string, sid uint) bool {
	var msgCnt, taskCnt int64
	store.DB.Model(&model.Message{}).Where(
		"ai_session_id = ? AND msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		sid, []int{2, 4, 5}, username, agentName, agentName, username).Count(&msgCnt)
	store.DB.Model(&model.AgentTaskRecord{}).
		Where("username = ? AND agent_name = ? AND session_id = ?", username, agentName, sid).Count(&taskCnt)
	return msgCnt == 0 && taskCnt == 0
}

// handleAISessionNew 新建会话：先清理从未使用的空会话行（无消息盖戳且无任务记录，
// 含重复点击产生的堆积）再创建新行；标题默认"新会话"，首条消息落库时经 aiSessionAutoTitle 生成
func (s *Server) handleAISessionNew(c *Client, msg *protocol.Message) {
	agent := aiAgentForUser(strings.TrimSpace(msg.ToUser), c.username)
	if agent == nil {
		s.sendError(c, "AI 助手不存在或已被移除")
		return
	}
	var rows []model.AISession
	store.DB.Where("username = ? AND agent_name = ?", c.username, agent.Name).Find(&rows)
	for _, r := range rows {
		if aiSessionEmpty(c.username, agent.Name, r.ID) {
			store.DB.Delete(&r)
		}
	}
	row := model.AISession{Username: c.username, AgentName: agent.Name, Title: "新会话"}
	if err := store.DB.Create(&row).Error; err != nil {
		s.sendError(c, "新建会话失败，请稍后重试")
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"agent":      agent.Name,
		"session_id": row.ID,
		"title":      row.Title,
	})
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeAISessionNew,
		FromUser:  c.username,
		ToUser:    agent.Name,
		Content:   string(payload),
		Timestamp: time.Now().Unix(),
	}
	out, _ := json.Marshal(resp)
	c.send(out)
}

// handleAISessionDel 删除会话（session_id 指定；默认会话 sid=0 不可删）：
// 会话内消息与任务记录归并默认会话（盖戳改 0，历史不丢），随后回传最新会话列表
func (s *Server) handleAISessionDel(c *Client, msg *protocol.Message) {
	agent := aiAgentForUser(strings.TrimSpace(msg.ToUser), c.username)
	if agent == nil {
		s.sendError(c, "AI 助手不存在或已被移除")
		return
	}
	if msg.SessionID == 0 {
		s.sendError(c, "默认会话不可删除")
		return
	}
	var row model.AISession
	if err := store.DB.Where("id = ? AND username = ? AND agent_name = ?", msg.SessionID, c.username, agent.Name).
		First(&row).Error; err != nil {
		s.sendError(c, "会话不存在或已被删除")
		return
	}
	store.DB.Model(&model.Message{}).Where("ai_session_id = ?", row.ID).Update("ai_session_id", 0)
	store.DB.Model(&model.AgentTaskRecord{}).
		Where("username = ? AND agent_name = ? AND session_id = ?", c.username, agent.Name, row.ID).
		Update("session_id", 0)
	store.DB.Delete(&row)
	// 删除后回传最新会话列表（客户端直接刷新面板与当前会话）
	s.handleAISessionList(c, msg)
}
