package server

// 阶段一百八十四：定时/巡检任务——按周期自动发起 Agent 任务，结果经既有完结链路
// （agentFinish 落库+未读+会话推送）回流，无需独立推送通道。调度语义两档：
// interval（每 N 分钟）/ daily（每天 HH:MM）；到期扫描 → 防重叠（上次任务仍在进行态
// 则跳过本次防堆积）→ agentStartTask 归口发起（与手动上行同链路）。
// 服务重启后 next_run_at 已过期的任务在启动首次扫描即补跑（巡检场景合理）。

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// agentCronTickEvery 调度扫描周期（巡检场景分钟级精度足够，30s 兼顾 daily 时刻准时性）
const agentCronTickEvery = 30 * time.Second

// agentCronNext 下次运行时间（纯函数，单测归口）：
// interval：from + N 分钟（N 限 1~1440）；daily：from 当天 HH:MM（已过含相等则顺延一天）
func agentCronNext(kind, value string, from time.Time) (time.Time, error) {
	switch kind {
	case "interval":
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 1 || n > 1440 {
			return time.Time{}, errors.New("间隔分钟数须为 1~1440 的整数")
		}
		return from.Add(time.Duration(n) * time.Minute), nil
	case "daily":
		t, err := time.ParseInLocation("15:04", strings.TrimSpace(value), from.Location())
		if err != nil {
			return time.Time{}, errors.New("每日时刻格式须为 HH:MM（如 08:30）")
		}
		next := time.Date(from.Year(), from.Month(), from.Day(), t.Hour(), t.Minute(), 0, 0, from.Location())
		if !next.After(from) {
			next = next.Add(24 * time.Hour)
		}
		return next, nil
	}
	return time.Time{}, errors.New("调度类型仅支持 interval（每 N 分钟）或 daily（每天 HH:MM）")
}

// agentCronDesc 调度中文描述（列表展示归口）
func agentCronDesc(kind, value string) string {
	switch kind {
	case "interval":
		return "每 " + value + " 分钟"
	case "daily":
		return "每天 " + value
	}
	return kind + ":" + value
}

// agentCronParseImages 发起参数快照解析：图片 URL JSON 数组（空/坏 JSON 回退 nil，不阻断发起）
func agentCronParseImages(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		logger.Warn("定时任务图片快照解析失败（按无附件处理）：%v", err)
		return nil
	}
	return arr
}

// agentCronParseCtxs 发起参数快照解析：@ 引用 JSON 数组（语义同图片，坏 JSON 回退 nil）
func agentCronParseCtxs(s string) []AgentCtxReq {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var arr []AgentCtxReq
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		logger.Warn("定时任务引用快照解析失败（按无引用处理）：%v", err)
		return nil
	}
	return arr
}

// StartAgentCron 启动定时任务调度循环（main.go 归口调用；循环内启动即先扫描一次，重启补跑）
func StartAgentCron(s *Server) {
	go s.agentCronLoop()
	logger.Info("Agent 定时任务调度循环已启动（扫描周期 %v）", agentCronTickEvery)
}

// agentCronLoop 调度循环：启动即扫描一次（重启补跑：next_run_at 过期即触发），此后按周期扫描
func (s *Server) agentCronLoop() {
	s.agentCronTick()
	ticker := time.NewTicker(agentCronTickEvery)
	defer ticker.Stop()
	for range ticker.C {
		s.agentCronTick()
	}
}

// agentCronTick 到期扫描：enabled 且 next_run_at<=now 的行逐个触发（单行失败不影响其它行）
func (s *Server) agentCronTick() {
	if !agentEnabled.Load() {
		return
	}
	var rows []model.AgentCronTask
	if err := store.DB.Where("enabled = ? AND next_run_at IS NOT NULL AND next_run_at <= ?", true, time.Now()).Find(&rows).Error; err != nil {
		logger.Error("定时任务到期扫描失败：%v", err)
		return
	}
	for i := range rows {
		s.agentCronFire(&rows[i])
	}
}

// agentCronFire 单行触发：上次任务状态回填 → 防重叠判定 → 归口发起 → 推进下次运行时间
func (s *Server) agentCronFire(row *model.AgentCronTask) {
	// 上次触发任务的真实终态回填（列表"上次结果"展示；查不到留原值）
	if row.LastTaskID != "" {
		var rec model.AgentTaskRecord
		if err := store.DB.Select("status").Where("task_id = ?", row.LastTaskID).First(&rec).Error; err == nil && rec.Status != "" {
			store.DB.Model(row).Update("last_status", rec.Status)
			row.LastStatus = rec.Status
		}
		// 防重叠：上次触发的任务仍在排队/执行中——跳过本次（巡检语义：等下个周期，不向队列堆积）
		if v, ok := agentTasks.Load(row.LastTaskID); ok {
			t := v.(*AgentTask)
			t.mu.Lock()
			st := t.Status
			t.mu.Unlock()
			if st == "running" || st == "queued" {
				logger.Info("定时任务 %d（用户 %s）上次任务 %s 仍在 %s，本次跳过防堆积", row.ID, row.Username, row.LastTaskID, st)
				s.agentCronAdvance(row, time.Now())
				return
			}
		}
	}
	taskID, err := s.agentCronLaunch(row)
	now := time.Now()
	if err != nil {
		// 发起失败不重试（巡检语义下个周期再来）：留痕后照常推进，防每 tick 空转报错
		logger.Warn("定时任务 %d（用户 %s）发起失败：%v", row.ID, row.Username, err)
		store.DB.Model(row).Updates(map[string]interface{}{"last_run_at": now, "last_status": "launch_failed"})
		row.LastStatus = "launch_failed"
	} else {
		store.DB.Model(row).Updates(map[string]interface{}{"last_run_at": now, "last_task_id": taskID, "last_status": "running"})
		row.LastStatus = "running"
		logger.Info("定时任务 %d（用户 %s）已自动发起任务 %s（%s %s）", row.ID, row.Username, taskID, row.Kind, row.Value)
	}
	s.agentCronAdvance(row, now)
}

// agentCronAdvance 推进下次运行时间（以本次触发的基准时刻计算，防逐次漂移）；
// 调度值被外部改坏时自动停用该行，防每 tick 报错空转
func (s *Server) agentCronAdvance(row *model.AgentCronTask, from time.Time) {
	next, err := agentCronNext(row.Kind, row.Value, from)
	if err != nil {
		logger.Error("定时任务 %d（用户 %s）调度值非法（%s %s），已自动停用：%v", row.ID, row.Username, row.Kind, row.Value, err)
		store.DB.Model(row).Update("enabled", false)
		return
	}
	store.DB.Model(row).Update("next_run_at", next)
}

// agentCronLaunch 定时任务发起归口：快照参数装载（图片/@ 引用）后复用 agentStartTask
// （与手动上行同链路：智能体校验/排队/落库/回显/事件推送全部一致，前端零感知）
func (s *Server) agentCronLaunch(row *model.AgentCronTask) (string, error) {
	if !agentEnabled.Load() {
		return "", errors.New("智能 Agent 功能未开启")
	}
	return s.agentStartTask(row.Username, agentRunMsg{
		Goal:      row.Goal,
		AgentName: row.AgentName,
		SessionID: row.SessionID,
		PlanMode:  row.PlanMode,
		SoloMode:  row.SoloMode,
		Images:    agentCronParseImages(row.Images),
		Contexts:  agentCronParseCtxs(row.Contexts),
	}, "cron")
}

// HandleAgentCronList GET /api/agent/cron/list：本人定时任务全量倒序（调度描述/下次运行时间随行下发）
func (s *Server) HandleAgentCronList(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var rows []model.AgentCronTask
	store.DB.Where("username = ?", username).Order("id DESC").Find(&rows)
	out := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		out = append(out, map[string]interface{}{
			"id": row.ID, "agent_name": row.AgentName, "goal": row.Goal,
			"session_id": row.SessionID, "plan_mode": row.PlanMode, "solo_mode": row.SoloMode,
			"images": row.Images, "contexts": row.Contexts,
			"kind": row.Kind, "value": row.Value, "desc": agentCronDesc(row.Kind, row.Value),
			"enabled": row.Enabled,
			"next_run_at": func() interface{} {
				if row.NextRunAt == nil {
					return nil
				}
				return row.NextRunAt.Unix()
			}(),
			"last_run_at": func() interface{} {
				if row.LastRunAt == nil {
					return nil
				}
				return row.LastRunAt.Unix()
			}(),
			"last_task_id": row.LastTaskID, "last_status": row.LastStatus,
		})
	}
	adminJSON(w, map[string]interface{}{"total": len(out), "crons": out})
}

// HandleAgentCronSave POST /api/agent/cron/save：新建/更新定时任务（body：id 可选=更新，其余为发起参数+调度）。
// goal/智能体/会话归属/调度值服务端全量校验（agentCronNext 试算归口），下次运行时间重算
func (s *Server) HandleAgentCronSave(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var body struct {
		ID        uint          `json:"id"`
		AgentName string        `json:"agent_name"`
		Goal      string        `json:"goal"`
		SessionID uint          `json:"session_id"`
		PlanMode  bool          `json:"plan_mode"`
		SoloMode  bool          `json:"solo_mode"`
		Images    []string      `json:"images"`   // 图片 URL 数组（快照 JSON 落库，语义与任务记录同源）
		Contexts  []AgentCtxReq `json:"contexts"` // @ 引用数组（同上）
		Kind      string        `json:"kind"`
		Value     string        `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	goal := strings.TrimSpace(body.Goal)
	if goal == "" {
		adminFail(w, http.StatusBadRequest, "任务目标不能为空")
		return
	}
	if len([]rune(goal)) > 4000 {
		adminFail(w, http.StatusBadRequest, "任务目标过长（上限 4000 字）")
		return
	}
	agentName := strings.TrimSpace(body.AgentName)
	agent := aiAgentForUser(agentName, username)
	if agent == nil {
		adminFail(w, http.StatusBadRequest, "智能体不存在或无权使用")
		return
	}
	if !aiSessionValidate(username, agent.Name, body.SessionID) {
		adminFail(w, http.StatusBadRequest, "会话不存在或已被删除")
		return
	}
	kind := strings.TrimSpace(body.Kind)
	value := strings.TrimSpace(body.Value)
	if _, err := agentCronNext(kind, value, time.Now()); err != nil {
		adminFail(w, http.StatusBadRequest, err.Error())
		return
	}
	imgSnap := []byte("")
	if len(body.Images) > 0 {
		imgSnap, _ = json.Marshal(body.Images)
	}
	ctxSnap := []byte("")
	if len(body.Contexts) > 0 {
		ctxSnap, _ = json.Marshal(body.Contexts)
	}
	now := time.Now()
	if body.ID != 0 {
		// 更新：归属校验归口（仅本人可改自己的定时任务）
		var row model.AgentCronTask
		if err := store.DB.Where("id = ? AND username = ?", body.ID, username).First(&row).Error; err != nil {
			adminFail(w, http.StatusNotFound, "定时任务不存在")
			return
		}
		next, _ := agentCronNext(kind, value, now)
		store.DB.Model(&row).Updates(map[string]interface{}{
			"agent_name": agent.Name, "goal": goal, "session_id": body.SessionID,
			"plan_mode": body.PlanMode, "solo_mode": body.SoloMode,
			"images": string(imgSnap), "contexts": string(ctxSnap),
			"kind": kind, "value": value, "next_run_at": next,
		})
		logger.Info("定时任务更新 %d（用户 %s，%s %s）", row.ID, username, kind, value)
		adminJSON(w, map[string]interface{}{"id": row.ID})
		return
	}
	next, _ := agentCronNext(kind, value, now)
	row := model.AgentCronTask{
		Username: username, AgentName: agent.Name, Goal: goal,
		SessionID: body.SessionID, PlanMode: body.PlanMode, SoloMode: body.SoloMode,
		Images: string(imgSnap), Contexts: string(ctxSnap),
		Kind: kind, Value: value, Enabled: true, NextRunAt: &next,
	}
	if err := store.DB.Create(&row).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "保存失败")
		return
	}
	logger.Info("定时任务新建 %d（用户 %s，agent=%s，%s %s，下次运行 %s）", row.ID, username, agent.Name, kind, value, next.Format("2006-01-02 15:04:05"))
	adminJSON(w, map[string]interface{}{"id": row.ID})
}

// HandleAgentCronToggle POST /api/agent/cron/toggle：启停（body：id + enabled；启用时若下次运行时间
// 已过期则重算为未来时刻，防启停瞬间立即触发一次）
func (s *Server) HandleAgentCronToggle(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var body struct {
		ID      uint `json:"id"`
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == 0 {
		adminFail(w, http.StatusBadRequest, "缺少 id")
		return
	}
	var row model.AgentCronTask
	if err := store.DB.Where("id = ? AND username = ?", body.ID, username).First(&row).Error; err != nil {
		adminFail(w, http.StatusNotFound, "定时任务不存在")
		return
	}
	updates := map[string]interface{}{"enabled": body.Enabled}
	if body.Enabled {
		// 启用/编辑后 next_run_at 已过期（长期停用期间错过触发）——重算未来时刻，避免启用瞬间立即补跑
		if row.NextRunAt == nil || !row.NextRunAt.After(time.Now()) {
			next, err := agentCronNext(row.Kind, row.Value, time.Now())
			if err != nil {
				adminFail(w, http.StatusBadRequest, err.Error())
				return
			}
			updates["next_run_at"] = next
		}
	}
	store.DB.Model(&row).Updates(updates)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// HandleAgentCronDel POST /api/agent/cron/delete：删除（归属校验归口，物理删除）
func (s *Server) HandleAgentCronDel(w http.ResponseWriter, r *http.Request) {
	username, ok := userKBUsername(w, r)
	if !ok {
		return
	}
	var body struct {
		ID uint `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == 0 {
		adminFail(w, http.StatusBadRequest, "缺少 id")
		return
	}
	res := store.DB.Where("id = ? AND username = ?", body.ID, username).Delete(&model.AgentCronTask{})
	if res.Error != nil || res.RowsAffected == 0 {
		adminFail(w, http.StatusNotFound, "定时任务不存在")
		return
	}
	logger.Info("定时任务删除 %d（用户 %s）", body.ID, username)
	adminJSON(w, map[string]interface{}{"ok": true})
}
