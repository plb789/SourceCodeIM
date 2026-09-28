# 阶段一百九十三：多任务并行看板（对标 TRAE CN · A 类第 1 项）

## Context

当前 Agent 任务进度只能停留在发起会话内查看：切走会话后任务仍在跑，但没有任何全局视图能看到所有活跃任务（运行/排队/等待审批）。任务历史弹窗（阶段六十四）是静态列表——打开才拉数据、运行中任务需手动点刷新，不满足「多任务并行时统一实时看板」的 TRAE CN 同款体验。

**现状缺口实锤**：`agentTaskCards` 内存字典只含「建卡时正在查看的会话」的任务——[chat.js L16252](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L16252) `if (currentChatUser !== msg.from_user) return;` 在建卡（L16255）之前，跨会话任务的 AGENT_EVENT 不会建卡入内存。

**可复用现有资产**（不重复造轮子）：
- `GET /api/agent/tasks`（[agentrun.go L5150](file:///e:/SourceCodeIM/im-server/server/agentrun.go#L5150)）：本人任务分页列表，brief 字段完备（task_id/agent_name/goal/status/elapsed_ms/session_id/reply_msg_id/changes）；status 枚举 queued/running/waiting_approval/completed/failed/cancelled 全部落库（L207）
- 取消上行（[chat.js L3492](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L3492)）：`AGENT_RUN + {task_id, action:'cancel'}`
- 跳会话：`openConversation(user)`（[chat.js L18499](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L18499)）
- 自绘弹窗模式：任务历史弹窗 `taskhist-mask` + `hidden` 类 + 遮罩点击关闭（[chat.js L22372 区](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L22372)）
- 防闪烁重绘：签名比对模式（[agentDockSync dockSig L10438](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L10438)）
- 状态中文映射：`thStateLabel`（L22394）、时间格式 `thFormatTime`（L22399）

## 实施方案

### 1. 服务端（最小改动，~10 行）

[agentrun.go](file:///e:/SourceCodeIM/im-server/server/agentrun.go) `agentTaskListQuery`：status 参数新增 `active` 聚合值——展开为 `status IN (queued, running, waiting_approval)`（仿 L387 现有 IN 查询写法）。看板一次拉取即得全部活跃任务，不改既有 status 单值语义。

### 2. 前端数据源（chat.js）

新增 `agentBoardMap`（task_id → 轻量条目 {goal, agent, status, position, todoDone, todoTotal, createTime, sessionId}）：

- **快照**：看板打开时 `GET /api/agent/tasks?status=active&size=50`，与 agentBoardMap 合并（服务端权威覆盖）
- **实时镜像**：`IMSocket.on(MSG.AGENT_EVENT)`（L16216）分发处、**在 L16252「仅当前会话渲染」return 之前**插入纯内存镜像逻辑——queued/running/waiting_approval/todo 事件写/更新 agentBoardMap 条目；done/error/cancelled 完结事件移除条目。零干扰：只写 map + 触发看板重绘，不碰现有渲染分支
- 轮询兜底：看板打开期间每 5s 重拉快照（防 WS 瞬断漏帧），关闭即停

### 3. 看板 UI（index.html + style.css + chat.js）

- **弹窗**：新建 `board-mask` 自绘浮层（复用 taskhist-mask 同款遮罩/卡片/关闭模式），标题「任务看板」+ 活跃数
- **条目**：智能体名 + goal 摘要（100 字截断）+ 状态徽标（排队 N 位 / 等待审批 / 执行中+跳动点，复用 thStateLabel + ai-thinking-dots）+ 进度 x/y + 已耗时（前端每秒自刷）+ 操作按钮「跳转」「取消」
- **跳转**：`openConversation(agent)`；reply_msg_id/session_id 归口的任务卡重放链路已存在，无需新逻辑
- **取消**：AGENT_RUN cancel 上行（复用 L3492 口径）；cancelled 事件到达后条目自然移除
- **空态**：「暂无进行中的任务」（遵循用户偏好：无数据不显示「加载失败」）
- **入口**：AI 会话头部任务历史按钮旁新增看板按钮；**任何会话**下有活跃任务时也显示（按钮 + 活跃数徽标，由 agentBoardMap 计数驱动显隐）——跨会话可感知可直达
- 底部「查看全部历史」链接 → 关看板开任务历史弹窗

### 4. i18n + 版本

- i18n.js PACK_VER bump：zh/en 各 ~8 key（任务看板/暂无进行中的任务/跳转/取消/查看全部历史/排队中 第 N 位/等待审批/已耗时）
- index.html：style.css / chat.js 版本参数 bump

## 关键文件

| 文件 | 改动 |
|------|------|
| im-server/server/agentrun.go | agentTaskListQuery 支持 status=active（IN 三态） |
| im-client/web/js/chat.js | agentBoardMap + 事件镜像 + 看板弹窗逻辑 + 入口徽标 |
| im-client/web/index.html | 看板弹窗 DOM + 入口按钮 |
| im-client/web/css/style.css | 看板样式（复用弹窗/徽标/进度条变量） |
| im-client/web/js/i18n.js | 新 key 双语 |
| docs/开发文档.md | 新增 7.3.35 节（status=active 参数 + 看板说明） |

## 验证

1. `go build ./server/ .` 编译 + `go test ./server/ -run AgentTask` 相关单测；服务端替换重启
2. E2E（浏览器，alice）：会话 A 发 ping 长任务 → 打开看板见「执行中」条目实时进度 → 切到普通会话入口徽标仍显 → 会话 B 再发一任务 → 看板两条并存（含排队位次如有）→ 看板内取消其中一条 → 条目移除+任务卡「已取消」→ 另一条跑完自动移除
3. 回归：任务历史弹窗（status 单值筛选不受扰）、单会话任务卡渲染、停靠栏、发送按钮停止态（agentActiveTask 归口未动）
4. 防闪烁：看板打开期间事件高频重绘不闪烁（签名比对）
