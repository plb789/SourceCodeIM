# Agent 任务文件变更审查条（TRAE-CN 同款）

## Context（背景）

用户希望：AI Agent 修改文件后，聊天里出现类似 TRAE CN 的"文件变更审查条"——汇总"N 个文件已更改 +X -Y"、逐文件列出（文件名+相对路径+增删行数）、支持 全部撤销 / 全部保留（含逐文件撤销）。当前 Agent 的 write_file/edit_file/delete_file 落盘后只在工具结果里有一行 "+N -M" 文本，无变更归口、无法回滚。**结论：可行**——工具执行已有统一归口（`agentToolExec`），完结事件（`done`）与任务重放链路已具备，只需新增"改前快照 + 变更记录表 + 审查条 UI"。

**MVP 范围（明确不做）**：
- 仅服务端工作区变更（PC 本地执行路径天然不经过 agentToolExec，v2 再议）；卡片注明"仅统计服务端工作区变更"
- run_command 间接改动不纳入（无法精确归因）
- 撤销语义同 git discard：直接恢复任务前内容（若用户事后手动改过会被覆盖）

## 设计要点

1. **快照归口**：write/edit/delete 执行前备份"改前内容"到 `<kbDataDir>/agent_changes/<taskID>/<seq>_<basename>`（kbDataDir 即 `cfg.AI.KB.DataDir`，kb.go:54，与 files/、vectors/ 平级，零新增配置）。首触保留最早 before 状态（同文件多次编辑累积到一次任务级 diff）。
2. **统计归口**：任务 done/error/cancelled 时统一算 diff（复用 `agentLineDiffStat` agentrun.go:1395），写回记录表，随事件/详情接口下发。
3. **撤销归口**：服务端按 Kind 恢复（modify/delete → 还原备份；create → 删除文件），状态落库，下行刷新帧同步多端。
4. **前端**：任务卡 done 时渲染审查条（折叠汇总头 + 逐文件行 + 待审查底栏按钮）；点文件行打开现有预览 tab；重放卡详情同样渲染（历史任务 pending 可操作）。

## 实施步骤

### 服务端（im-server）

1. **model/model.go**：新增 `AgentChangeRecord` 结构体（AutoMigrate 模式，与 AgentTaskRecord 同区挂载）：
   - 字段：ID / TaskID / Username / Path / Kind(create|modify|delete) / Adds / Dels / BackupFile / Status(pending|kept|reverted) / CreateTime / UpdateTime
   - `TableName() = "im_agent_change"`；索引：task_id 普通索引
2. **server/agentrun.go**：
   - `AgentTask` 增 `changes map[string]*AgentChangeRec`（t.mu 保护，首触保留最早 before）
   - `agentToolWriteFile/EditFile/DeleteFile` 签名加 `t *AgentTask`（现为纯 username 函数，:1046/:1107/:1160）：
     - write/edit：写盘前 `agentSnapshotBefore(t, path)` 读原文件字节备份（原不存在记 create；append 同样在写前快照）
     - delete：目录递归删除前遍历**逐文件**记录 kind=delete（每文件一行，恢复即逐文件还原；上限 200 行截断）
     - 成功后 `agentRecordChange`：锁内写 map，锁外落库（im_agent_change，status=pending）
     - 备份写失败则不记录该文件（不阻断任务）
   - `agentFinalizeChanges(t)`：done（:1961）/error（:1992）/cancelled（:1990）emit 前调用——锁内仅复制 map 即解锁，锁外逐文件 IO：当前内容 vs before 用 `agentLineDiffStat` 统计（delete 时 dels=before 行数；create 后又被删 → 剔除该行净零；含 NUL 二进制 adds=dels=0），回写 DB，返回 changes 数组并入事件 payload `"changes":[{path,kind,adds,dels,status}]`
   - 新增 `handleAgentChanges`：处理上行 66
3. **protocol/message.go**：`MsgTypeAgentChanges int = 66`（当前最大 65）
4. **server/server.go**（入站分发 switch，:193 一带）：case 66 → `handleAgentChanges`
5. **handleAgentChanges 逻辑**：
   - 校验 `msg.FromUser == 记录 Username`（同 HandleAgentTaskDetail 归属校验模式）
   - `keep`：删备份文件、status=kept；`revert`：按 Kind 恢复/删除文件、status=reverted（path 缺省=全部 pending）
   - 处理后从 **DB 读全量**（不依赖内存 t，天然支持多端/重连/重启）构造下行 66 帧：`{task_id, changes:[...], total_adds, total_dels}`
   - 任务全部行离开 pending 后清理备份目录 `<DataDir>/agent_changes/<taskID>/`（孤儿容忍）
6. **HandleAgentTaskDetail**（HTTP /api/agent/task/{task_id}）：返回体附 `changes`（含 status），供重放卡渲染

### Web 前端（im-client/web，PC Electron/手机 Capacitor 同源自动生效）

7. **js/socket.js**：MSG 加 `AGENT_CHANGES: 66`（:91 后）
8. **js/chat.js**：
   - 新函数 `agentRenderChanges(st, changes)`（放 createAgentTaskCard :3016 附近）：
     - 折叠头：`N 个文件已更改  +X -Y`（展开/收起箭头，TRAE 同款默认收起）
     - 逐文件行：图标 + 文件名 + 灰色相对路径 + 右侧 `+a` 绿 ` -d` 红；点击行 → 复用现有打开预览 tab 的函数（wsPanel 打开工作区文件预览，以实际函数名为准）
     - 底栏（仅存在 pending 时）：`N 个文件待审查` + [全部撤销] [全部保留]（样式复用 `.agent-event.approve` / `.agent-approve-actions`，style.css:6018-6090）；逐文件行尾加小"撤销"操作
   - `agentHandleEvent` case 'done'/'error'（chat.js:6643-6697）：`ev.changes` 存在时调 `agentRenderChanges`
   - 下行 66 帧：按 task_id 找到任务卡 st 全量刷新区块（状态徽标：待审查/已保留/已撤销）；操作成功后刷新工作区文件树
   - 注明文案："仅统计服务端工作区变更"
   - 重放卡 `agentBuildReplayCard`（:3339）详情：detail 响应含 changes 时同样渲染（pending 可操作，kept/reverted 只读标记）
9. **css/style.css**：审查条样式（头部/文件行/底栏按钮/状态徽标），对齐现有 agent 卡片暗色风格与主题色变量

## 边界情况

| 场景 | 处理 |
|---|---|
| 同文件多次编辑 | 首触 before 快照，done 一次任务级 diff |
| write append 模式 | 统一"写前快照"；原不存在记 create |
| 二进制文件（含 NUL） | 记录变更但 adds=dels=0，预览走现有 binary 分支 |
| 任务中先建后删 | 净零，从清单剔除 |
| 递归删目录 | 删前遍历逐文件记录（上限 200，超出截断注明）；空目录不还原（可容忍） |
| 撤销时用户已手动改过 | 直接覆盖恢复（git discard 同语义，MVP 不弹确认） |
| 断线重连/重启后 | 记录与状态全在 DB，重放卡/详情接口可查可操作 |
| 多端同时在线 | 下行 66 全量刷新帧，所有端一致 |

## 验证（实测）

1. 编译并运行 im-server，web 端注册测试号登录
2. Agent 模式发起任务：创建新文件、编辑已有文件、append、删除文件、递归删目录、写 png
3. 核对：done 后任务卡出现审查条，汇总 +X -Y 与文件行数正确；展开逐行核对；点文件行打开预览
4. 逐文件撤销：资源管理器确认该文件还原；全部撤销：全部还原、审查条状态变已撤销、工作区树刷新
5. 全部保留：重进会话 → 重放卡显示变更（只读已保留）；管理侧确认备份目录已清理
6. 第二浏览器登录同号：操作一个端，另一端审查条同步刷新
7. 任务中途取消：审查条仍出现（脏改可撤销）
8. PC Electron 与手机 APP 打开验证同源生效

## 关键文件

- e:\SourceCodeIM\im-server\server\agentrun.go（快照/统计/上行处理）
- e:\SourceCodeIM\im-server\model\model.go（新表）
- e:\SourceCodeIM\im-server\protocol\message.go（消息类型 66）
- e:\SourceCodeIM\im-server\server\server.go（入站分发 case）
- e:\SourceCodeIM\im-client\web\js\socket.js（MSG 66）
- e:\SourceCodeIM\im-client\web\js\chat.js（审查条 UI + 事件/重放接入）
- e:\SourceCodeIM\im-client\web\css\style.css（审查条样式）

工作量预估：服务端 ~280 行、前端 ~220 行、样式 ~60 行。
