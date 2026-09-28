package server

// 阶段一百七十三：按轮 Checkpoint 回滚单测（真实 MySQL：需本地 config.yaml 可连，无库自动跳过）。
// 覆盖：revert 携带 round 时仅撤销该轮及之后登记的 pending 变更（round>=N，首触登记轮次口径）、
// 更早轮次的变更不受影响、按轮回滚后行状态与文件落盘还原、缺省（无 round）全量撤销仍覆盖 round=0 旧行。

import (
	"os"
	"path/filepath"
	"testing"

	"im-server/config"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

func TestAgentChangesRevertByRound(t *testing.T) {
	agentWorkRoot = t.TempDir() // 隔离工作区
	kbDataDir = t.TempDir()     // 隔离备份目录
	s := NewServer(config.Load())
	user := "revround1"
	ws, err := agentWorkspaceDir(user)
	if err != nil {
		t.Fatal(err)
	}

	// 任务前预置 c.txt（modify 场景的还原基准）
	cPath := filepath.Join(ws, "c.txt")
	if err := os.WriteFile(cPath, []byte("C-v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	t1 := "revround" + user
	store.DB.Where("task_id = ?", t1).Delete(&model.AgentChangeRecord{})
	t.Cleanup(func() { store.DB.Where("task_id = ?", t1).Delete(&model.AgentChangeRecord{}) })

	// 备份文件：modify 行 revert 时读取还原
	backup := filepath.Join(kbDataDir, "agent_changes", t1, "1_c.txt")
	if err := os.MkdirAll(filepath.Dir(backup), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("C-v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 三条记录：round=1 create a.txt / round=2 modify c.txt / round=3 create b.txt
	rows := []model.AgentChangeRecord{
		{TaskID: t1, Username: user, Path: "a.txt", Kind: "create", Status: "pending", Round: 1},
		{TaskID: t1, Username: user, Path: "c.txt", Kind: "modify", Status: "pending", Round: 2, BackupFile: backup},
		{TaskID: t1, Username: user, Path: "b.txt", Kind: "create", Status: "pending", Round: 3},
	}
	for i := range rows {
		if err := store.DB.Create(&rows[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	// 工作区现状：任务已产生的文件
	if err := os.WriteFile(filepath.Join(ws, "a.txt"), []byte("A-task"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "b.txt"), []byte("B-task"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cPath, []byte("C-task-edited"), 0o644); err != nil {
		t.Fatal(err)
	}

	statusOf := func(path string) string {
		t.Helper()
		var r model.AgentChangeRecord
		if err := store.DB.Where("task_id = ? AND path = ?", t1, path).First(&r).Error; err != nil {
			t.Fatalf("查询 %s 失败：%v", path, err)
		}
		return r.Status
	}

	// 1. 回滚到第 2 轮起：c.txt 还原、b.txt 删除、a.txt（round=1）不受影响
	s.handleAgentChanges(&Client{username: user}, &protocol.Message{Content: `{"task_id":"` + t1 + `","action":"revert","round":2}`})
	if data, err := os.ReadFile(cPath); err != nil || string(data) != "C-v1" {
		t.Fatalf("round=2 revert 后 c.txt 未还原：%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(ws, "b.txt")); !os.IsNotExist(err) {
		t.Fatal("round=3 create b.txt 撤销后应删除")
	}
	if _, err := os.Stat(filepath.Join(ws, "a.txt")); err != nil {
		t.Fatal("round=1 的 a.txt 不应受 round=2 回滚影响")
	}
	if statusOf("a.txt") != "pending" || statusOf("c.txt") != "reverted" || statusOf("b.txt") != "reverted" {
		t.Fatalf("行状态流转不符：a=%s c=%s b=%s", statusOf("a.txt"), statusOf("c.txt"), statusOf("b.txt"))
	}

	// 2. 回滚到第 1 轮起：a.txt 删除（round>=1 覆盖剩余行）
	s.handleAgentChanges(&Client{username: user}, &protocol.Message{Content: `{"task_id":"` + t1 + `","action":"revert","round":1}`})
	if _, err := os.Stat(filepath.Join(ws, "a.txt")); !os.IsNotExist(err) {
		t.Fatal("round=1 revert 后 a.txt 应删除")
	}
	if statusOf("a.txt") != "reverted" {
		t.Fatalf("a.txt 应为 reverted：%s", statusOf("a.txt"))
	}

	// 3. 缺省（无 round）全量撤销仍覆盖 round=0 旧行（旧数据不参与按轮回滚但可全量撤销）
	old := model.AgentChangeRecord{TaskID: t1, Username: user, Path: "old.txt", Kind: "create", Status: "pending", Round: 0}
	if err := store.DB.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "old.txt"), []byte("OLD"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.handleAgentChanges(&Client{username: user}, &protocol.Message{Content: `{"task_id":"` + t1 + `","action":"revert"}`})
	if _, err := os.Stat(filepath.Join(ws, "old.txt")); !os.IsNotExist(err) {
		t.Fatal("无 round 全量撤销后 old.txt 应删除")
	}
	if statusOf("old.txt") != "reverted" {
		t.Fatalf("old.txt 应为 reverted：%s", statusOf("old.txt"))
	}

	// 4. 全部行离开 pending 后备份目录清理（孤儿容忍归口）
	if _, err := os.Stat(filepath.Join(kbDataDir, "agent_changes", t1)); !os.IsNotExist(err) {
		t.Fatal("全部撤销后备份目录应清理")
	}
}
