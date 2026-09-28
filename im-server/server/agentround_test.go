package server

// 阶段一百七十二：逐轮 Checkpoint 时间线单测——轮次归属记录（Round 列贯穿步骤轨迹与变更登记）。
// 覆盖：agentTaskCurRound 当前轮读取（steps 轮末自增口径）、agentStepTrace 落库带轮次、
// agentRecordChange / agentRecordPCChanges 首触登记轮次（内存+DB 双归口）。
// 真实 MySQL：需本地 config.yaml 可连，无库环境 TestMain 直接退出成功。

import (
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/store"
)

func TestAgentTaskCurRound(t *testing.T) {
	tk := parallelTestTask("roundtest0")
	if got := agentTaskCurRound(tk); got != 1 {
		t.Fatalf("初始轮次=%d，期望 1", got)
	}
	tk.mu.Lock()
	tk.steps = 4
	tk.mu.Unlock()
	if got := agentTaskCurRound(tk); got != 5 {
		t.Fatalf("steps=4 时当前轮次=%d，期望 5（steps 轮末自增，+1 为进行中轮）", got)
	}
}

func TestAgentStepTraceRound(t *testing.T) {
	s := NewServer(config.Load())
	tk := parallelTestTask("roundtest1")
	// 留痕表由本测试自行补齐建表（TestMain 仅迁移变更记录表）；前置清理防残留污染
	_ = store.DB.AutoMigrate(&model.AgentStepRecord{})
	store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{})
	t.Cleanup(func() { store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentStepRecord{}) })

	tk.mu.Lock()
	tk.steps = 2 // 模拟第 3 轮执行中（steps 已完成 2 轮）
	tk.mu.Unlock()
	s.agentStepTrace(tk, "read_file", map[string]interface{}{"path": "round-a.txt"}, "ok", true, "server", "none", 10)

	var row model.AgentStepRecord
	if err := store.DB.Where("task_id = ?", tk.ID).First(&row).Error; err != nil {
		t.Fatalf("留痕查询失败：%v", err)
	}
	if row.Round != 3 {
		t.Fatalf("留痕轮次=%d，期望 3", row.Round)
	}
}

func TestAgentRecordChangeRound(t *testing.T) {
	agentWorkRoot = t.TempDir() // 隔离工作区
	kbDataDir = t.TempDir()     // 隔离备份目录
	s := NewServer(config.Load())

	// 服务端路径：首触登记轮次（内存 rec 与 DB 行同轮次）
	tk := parallelTestTask("roundtest2")
	tk.mu.Lock()
	tk.steps = 0 // 第 1 轮执行中
	tk.mu.Unlock()
	agentRecordChange(tk, "round-a.txt", "create", "", "")
	if len(tk.changes) != 1 || tk.changes[0].Round != 1 {
		t.Fatalf("内存登记轮次不符：%+v", tk.changes)
	}
	var row model.AgentChangeRecord
	if err := store.DB.Where("task_id = ? AND path = ?", tk.ID, "round-a.txt").First(&row).Error; err != nil {
		t.Fatalf("变更查询失败：%v", err)
	}
	if row.Round != 1 {
		t.Fatalf("DB 登记轮次=%d，期望 1", row.Round)
	}
	t.Cleanup(func() { store.DB.Where("task_id = ?", tk.ID).Delete(&model.AgentChangeRecord{}) })

	// PC 本地路径：同口径（第 2 轮首触，steps=1 → Round=2）
	tk2 := parallelTestTask("roundtest3")
	tk2.mu.Lock()
	tk2.steps = 1
	tk2.mu.Unlock()
	s.agentRecordPCChanges(tk2, []agentPCChange{{
		Path: "round-b.txt", Local: "E:\\nonexist\\round-b.txt", Kind: "create", Adds: 1, Dels: 0,
	}})
	if len(tk2.changes) != 1 || tk2.changes[0].Round != 2 {
		t.Fatalf("PC 内存登记轮次不符：%+v", tk2.changes)
	}
	var row2 model.AgentChangeRecord
	if err := store.DB.Where("task_id = ? AND path = ?", tk2.ID, "round-b.txt").First(&row2).Error; err != nil {
		t.Fatalf("PC 变更查询失败：%v", err)
	}
	if row2.Round != 2 || row2.Env != "pc" {
		t.Fatalf("PC DB 登记不符：round=%d env=%s，期望 round=2 env=pc", row2.Round, row2.Env)
	}
	t.Cleanup(func() { store.DB.Where("task_id = ?", tk2.ID).Delete(&model.AgentChangeRecord{}) })
}
