package server

// 阶段七十七：文件变更审查链路集成测试（真实 MySQL：需本地 config.yaml 可连）。
// 覆盖：write_file 创建/改写快照归口、edit_file 改前备份、delete_file 删前备份、
// 先建后删净零剔除、agentFinalizeChanges 行数统计、handleAgentChanges 全部撤销（文件还原）与全部保留（备份清理）。

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"im-server/config"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

func TestMain(m *testing.M) {
	// 锚定 bin/config.yaml（与生产进程同源配置），失败则跳过（CI 无库环境）
	_ = os.Chdir("../bin")
	cfg := config.Load()
	if err := store.InitMySQL(cfg); err != nil {
		os.Exit(0) // 无库环境直接退出成功，不阻塞其他开发场景
	}
	// 生产由服务端启动 AutoMigrate 建表，测试进程需自行补齐
	if err := store.DB.AutoMigrate(&model.AgentChangeRecord{}); err != nil {
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func changeRows(t *testing.T, taskID string) []model.AgentChangeRecord {
	t.Helper()
	var rows []model.AgentChangeRecord
	if err := store.DB.Where("task_id = ?", taskID).Order("id ASC").Find(&rows).Error; err != nil {
		t.Fatalf("查询变更记录失败：%v", err)
	}
	return rows
}

func fileText(t *testing.T, path string) (string, bool) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func TestAgentChangesFlow(t *testing.T) {
	user := "chgtest1"
	agentWorkRoot = t.TempDir() // 隔离工作区（agentWorkspaceDir 按此根拼 username 子目录）
	kbDataDir = t.TempDir()     // 隔离备份目录
	s := NewServer(config.Load())

	ws := filepath.Join(agentWorkRoot, user)
	// 任务前预置两个已有文件（验证 modify/delete 的改前备份）
	if err := os.MkdirAll(filepath.Join(ws, "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(ws, "b", "mod.txt"), []byte("v1\nv2\nv3\n"), 0o644)
	os.WriteFile(filepath.Join(ws, "c.txt"), []byte("hello\nworld\n"), 0o644)

	t1 := &AgentTask{ID: "chgtestflow" + time.Now().Format("150405"), Username: user}
	// 防跨轮污染：先清同任务历史行（上轮失败可能遗留）
	store.DB.Where("task_id = ?", t1.ID).Delete(&model.AgentChangeRecord{})

	// 1. 创建新文件
	if out := agentToolWriteFile(t1, map[string]interface{}{"path": "a/create.txt", "content": "line1\nline2\nline3\nline4\n"}); !contains(out, "已创建") {
		t.Fatalf("创建文件结果异常：%s", out)
	}
	// 2. 同任务再次改写（首触保留 create 语义，不新增记录行）
	if out := agentToolWriteFile(t1, map[string]interface{}{"path": "a/create.txt", "content": "line1\nlineX\nline3\nline4\n"}); !contains(out, "已编辑") {
		t.Fatalf("改写文件结果异常：%s", out)
	}
	// 3. 编辑已有文件（modify + 备份）
	if out := agentToolEditFile(t1, map[string]interface{}{"path": "b/mod.txt", "old_string": "v2", "new_string": "v2-edited"}); !contains(out, "已编辑") {
		t.Fatalf("编辑文件结果异常：%s", out)
	}
	// 4. 删除已有文件（delete + 备份）
	if out := agentToolDeleteFile(t1, map[string]interface{}{"path": "c.txt"}); !contains(out, "已删除") {
		t.Fatalf("删除文件结果异常：%s", out)
	}
	// 5. 先建后删（净零：完结时从清单剔除）
	agentToolWriteFile(t1, map[string]interface{}{"path": "tmp.txt", "content": "tmp\n"})
	agentToolDeleteFile(t1, map[string]interface{}{"path": "tmp.txt"})

	rows := changeRows(t, t1.ID)
	if len(rows) != 4 {
		t.Fatalf("变更记录数=%d，期望 4（先建后删的行在完结统计时剔除）：%+v", len(rows), rows)
	}
	byPath := map[string]model.AgentChangeRecord{}
	for _, r := range rows {
		byPath[r.Path] = r
		if r.Status != "pending" {
			t.Fatalf("初始状态应为 pending：%+v", r)
		}
	}
	if r := byPath["a/create.txt"]; r.Kind != "create" || r.BackupFile != "" {
		t.Fatalf("create.txt 记录异常：%+v", r)
	}
	if r := byPath["b/mod.txt"]; r.Kind != "modify" || r.BackupFile == "" {
		t.Fatalf("mod.txt 记录异常：%+v", r)
	}
	if r := byPath["c.txt"]; r.Kind != "delete" || r.BackupFile == "" {
		t.Fatalf("c.txt 记录异常：%+v", r)
	}

	// 完结统计：行数回写 + 净零剔除（tmp.txt 行从 DB 剔除）
	views := s.agentFinalizeChanges(t1)
	if len(views) != 3 {
		t.Fatalf("完结视图数=%d，期望 3：%+v", len(views), views)
	}
	if n := len(changeRows(t, t1.ID)); n != 3 {
		t.Fatalf("完结后 DB 记录数=%d，期望 3（净零行应剔除）", n)
	}
	for _, v := range views {
		switch v.Path {
		case "a/create.txt": // before="" vs 4 行：+4 -0
			if v.Adds != 4 || v.Dels != 0 {
				t.Fatalf("create.txt 统计异常：%+v", v)
			}
		case "b/mod.txt": // v2→v2-edited：+1 -1
			if v.Adds != 1 || v.Dels != 1 {
				t.Fatalf("mod.txt 统计异常：%+v", v)
			}
		case "c.txt": // 文件已删：+0 -2
			if v.Adds != 0 || v.Dels != 2 {
				t.Fatalf("c.txt 统计异常：%+v", v)
			}
		}
	}

	// 全部撤销：create→删文件；modify/delete→还原任务前内容；状态 reverted；备份清理
	s.handleAgentChanges(&Client{username: user}, &protocol.Message{Content: `{"task_id":"` + t1.ID + `","action":"revert"}`})
	if _, ok := fileText(t, filepath.Join(ws, "a", "create.txt")); ok {
		t.Fatal("撤销后 create.txt 应被删除")
	}
	if txt, _ := fileText(t, filepath.Join(ws, "b", "mod.txt")); txt != "v1\nv2\nv3\n" {
		t.Fatalf("撤销后 mod.txt 未还原：%q", txt)
	}
	if txt, _ := fileText(t, filepath.Join(ws, "c.txt")); txt != "hello\nworld\n" {
		t.Fatalf("撤销后 c.txt 未还原：%q", txt)
	}
	for _, r := range changeRows(t, t1.ID) {
		if r.Status != "reverted" {
			t.Fatalf("撤销后状态异常：%+v", r)
		}
	}
	if _, err := os.Stat(filepath.Join(kbDataDir, "agent_changes", t1.ID)); !os.IsNotExist(err) {
		t.Fatal("全部撤销后备份目录应清理")
	}

	// ===== 保留链路：keep 弃备份 + 状态 kept =====
	t2 := &AgentTask{ID: "chgtestkeep" + time.Now().Format("150405"), Username: user}
	store.DB.Where("task_id = ?", t2.ID).Delete(&model.AgentChangeRecord{})
	os.WriteFile(filepath.Join(ws, "keep.txt"), []byte("old\n"), 0o644)
	agentToolEditFile(t2, map[string]interface{}{"path": "keep.txt", "old_string": "old", "new_string": "new"})
	s.agentFinalizeChanges(t2)
	s.handleAgentChanges(&Client{username: user}, &protocol.Message{Content: `{"task_id":"` + t2.ID + `","action":"keep"}`})
	if txt, _ := fileText(t, filepath.Join(ws, "keep.txt")); txt != "new\n" {
		t.Fatalf("保留后 keep.txt 应为 new：%q", txt)
	}
	for _, r := range changeRows(t, t2.ID) {
		if r.Status != "kept" {
			t.Fatalf("保留后状态异常：%+v", r)
		}
	}
	if _, err := os.Stat(filepath.Join(kbDataDir, "agent_changes", t2.ID)); !os.IsNotExist(err) {
		t.Fatal("全部保留后备份目录应清理")
	}

	// 清理测试数据（工作区由 t.TempDir 自动回收，DB 行手动清）
	store.DB.Where("task_id IN ?", []string{t1.ID, t2.ID}).Delete(&model.AgentChangeRecord{})
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
