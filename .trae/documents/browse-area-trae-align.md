# 浏览区 AI 代码变更对齐 TRAE CN 实施计划

## 背景与目标

用户要求把 PC 端浏览区（内置浏览器面板的代码查看器）对照 TRAE CN 补齐并打磨：代码变动跟踪、悬停变更行显示"AI 修改说明 + 回滚"、代码 diff 对比等。范围**仅 PC 端**（Electron file-viewer 路径）；"修改说明"文本由**服务端工具定义增加 explanation 字段**产生（服务端统一数据归口）。

### 现状盘点（已具备的基础，本次在其上补齐）

| TRAE CN 功能 | 现状 | 位置 |
|---|---|---|
| gutter 变更标记（红/蓝/绿） | 已有：LCS 算法 + Monaco decorations | file-viewer.html L1427-1499，CSS L232-242 |
| diff 对比（并排/行内切换） | 已有：Monaco DiffEditor | file-viewer.html L1943-1983，`#fv-btn-diffmode` |
| 悬停代码说明 | 已有（但只有 LSP/静态语法说明，**无变更说明**） | file-viewer.html L1184-1299 |
| 变更文件列表 + 统计 + 全部保留/撤销 | 已有 | chat.js L9517-9632 |
| 文件级保留/撤销变更 | 已有（二次确认 armed 流程） | file-viewer.html L2145-2172，chat.js L8085 |
| **悬停变更行 → AI 修改说明 + 回滚浮层** | **缺失，本次新增** | — |

## 关键链路（勘察确认）

- **工具事件**：agentrun.go `agentEmit(t,"tool_start",{tool,params,...})` L3278 → 前端 `MSG.AGENT_EVENT`（chat.js L14458）→ `addAgentTool` L9740（L9765 按 `ev.params.path` 打角标）。`params` 全量透传 → explanation 加进 schema 即自然到达。
- **变更归口**：服务端 `t.changes`（agentrun.go L1981）+ DB `model.AgentChangeRecord`（model.go L344）；下发视图 `agentChangeView` L1989，出口 4 处（agentFinalizeChanges L2141/2173、agentChangesPush L2194/66 帧、任务列表/详情）。前端 done L14599 → `agentRenderChanges`；66 帧 L14989 → `agentDockSetChanges`。
- **viewer 基线**：PC 主进程 browser-manager.js `readFilePayload()` L578 查任务备份 → `payload.task_modified/baseline` → chat.js L8061 `onFileLoad` → `fileFramePush` → iframe `__wsFileLoad`（**在 chat.js L8063 注入 explanation 零改主进程**）。
- **PC 本地执行**：chat.js L15052 AGENT_EXEC_REQ 原样带 params → agent-executor.js writeFileSync/editFileSync/deleteFileSync → `pcReport()` L350 回传服务端 `agentRecordPCChanges` L2075。
- **回滚**：file-viewer L2146 armed → `viewerBridge().taskRevert(tab_id)` → chat.js L8085 → 主进程 `revertTaskChange` 读备份还原 → 重读盘重推 payload。

## 实施步骤

### 步骤 1：服务端（im-server）

**model/model.go** — `AgentChangeRecord`（L344）加字段：
`Explanation string \`gorm:"column:explanation;type:varchar(1024)" json:"explanation"\``（AutoMigrate 自动补列，存量空值前端降级）。

**server/agentrun.go**：
1. 工具 schema 加 `explanation`（非必填，string，中文描述修改意图）：
   - write_file（L583-590 properties）、edit_file（L597-603）、delete_file（L610-616，描述"本次删除的原因"）。均不加 required。
2. 系统提示词工具说明区（L2706-2734 附近）追加：调用三个文件工具时必须在 explanation 用一句中文说明修改意图。
3. `agentChangeRec`（L1981）、`agentPCChange`（L148）、`agentChangeView`（L1989）各加 `Explanation string`。
4. `agentRecordChange`（L2048）签名加 `explanation` 参数：
   - 新路径：内存 rec + `store.DB.Create` 带字段（截断 1024 字符）。
   - **dup 分支改造**：Kind/Backup 不动（撤销语义依赖），仅回写最新 explanation（锁内改 `r.Explanation`，锁外 `store.DB.Model(...).Where("task_id=? AND path=?").Updates(...)`）；空串不覆盖。
   - 4 个调用点传参：write_file L1618 / edit_file L1685 / delete_file L1749（单文件）与 L1739（目录共用一条说明）。
5. `agentRecordPCChanges`（L2075）：dup 回写与 Create 均带 explanation。
6. 下发出口补字段：`agentFinalizeChanges` L2141/2173、`agentChangesPush` L2194。任务列表/详情直出 model，JSON tag 自动透出。

### 步骤 2：PC 执行器（im-client/pc/agent-executor.js）

- `pcReport()` L350 加第 8 参 `explanation`，组装对象带 `explanation`。
- writeFileSync L439 / editFileSync L487 / deleteFileSync L542+L556：取 `String(params.explanation||'').slice(0,1024)` 传入（目录逐文件共用）。
- 旧版 exe 未升级兼容：回传无字段 → 服务端落空串 → 前端降级。

### 步骤 3：chat.js 说明归集与下发

1. 新增存储（紧邻 wsPanel 定义区）：`agentFileExpl`（key=`wsPanelNormalizeKey` 归一路径 toLowerCase）→ `{text, adds, dels, kind, ts}`；`agentExplSet`（覆盖式，多轮=最近一次）/`agentExplDrop`/`agentExplGet`。
2. 抽公共函数 `agentExplSyncFromChanges(changes)`：status≠reverted 且非 delete → Set；reverted/delete → Drop。三个喂入口复用：
   - `addAgentTool` L9765：tool_start 实时喂（write/edit）或 Drop（delete）；
   - done/error/cancel payload（L14599 `agentRenderChanges` 首行）；
   - 66 帧 handler（L14989）与重放卡 `d.changes`（L9490）——历史会话也有说明。
3. `onFileLoad`（L8061-8069）：`fileFramePush` 前按 `payload.path` 注入 `payload.explanation/adds/dels`（仅 `kind==='file' && mime==='text'`），并在 frame rec 上记 `rec.path`。
4. `__imViewerHost.taskKeep/taskRevert`（L8082-8087）：成功后按 rec.path `agentExplDrop`；66 帧 status==='kept' 分支同样 Drop。
5. 变更列表 `agentBuildChangesList`（L9537）：文件行加说明行 `.agent-changes-desc`（空不建节点；kept/reverted 置灰）。
6. diff 预览 `wsPanelGitOpenDiff`（L13023/13035）：meta 追加 `explanation/adds/dels`（实施时核对 browser-manager data 标签 payload 组装是否透传 meta，白名单则补字段）。

### 步骤 4：file-viewer.html 悬停变更浮层（核心新增）

1. **选型**：自绘绝对定位 DOM（非 Monaco overlayWidget）——触发区在 gutter 装饰区、含按钮交互、复用项目 `fvShowCtxMenu` 成熟模式、不受编辑器 overflow 裁剪。
2. DOM：`#fv-ai-pop`（kind 徽标 / `#fv-ai-pop-text` 说明 / `+N -M` 统计 / 回滚按钮 / 小箭头）。CSS 追加在 L275 后，全部走 `--fv-*` 主题变量（L59-100 双主题已备）；徽标三色与 gutter 一致（新增绿/修改蓝/删除红）。
3. 触发：`applyGutter` 后挂 `onMouseMove`，`MouseTargetType.GUTTER_LINE_DECORATIONS/GUTTER_GLYPH_MARGIN/GUTTER_LINE_NUMBERS` 命中 `taskChangeBlocks` 块 → 延时 150ms 显示（左键按下跳过）；`onMouseLeave` 隐藏；移入浮层不消失。**不选"悬停行内容"触发**：避免与既有 LSP/静态 hover provider 叠冲突，TRAE 同款即悬停行号旁色条。
4. 内容 `fvAiPopFill`：徽标按行号所属 added/modified/deleted 分类；说明空则降级"本次 AI 修改"；统计用服务端 adds/dels，无则就地按 marks 计算；附块行号范围。
5. 回滚：抽公共函数 `fvTaskRevertFlow()`（从 L2146-2172 搬出），btnRevert 与浮层按钮共用 armed 二次确认；仅 `task_modified && hasViewer() && !dirtyNow` 可用；成功后 payload 重推自动刷新。
6. 定位：跟随鼠标 +14px 偏移，边缘翻转（复用 fvShowCtxMenu flip 公式）。

### 步骤 5：观感打磨

1. gutter：色条收窄 2.5px + 圆角观感；浮层显示时命中块追加 `fv-tl-hover` 淡高亮装饰，关闭移除；三色保持 git 语义不随主题翻转。
2. diff 头部（`diffHeaderInfo` L1888-1908）：有 explanation 加 `.fv-diff-expl` 行（AI 徽标前缀）；有 adds/dels 加 `.fv-diff-stat` 徽标胶囊 `+X -Y`。
3. 变更列表（chat.js L9537 + style.css）：`.agent-changes-row` 改两行网格（上行文件名+统计+徽标，下行说明）；kind 徽标 A/M/D 颜色与 gutter 三色对齐。
4. viewer 顶栏 `#fv-status`（L281）：有说明时缩短为"AI 已修改"+ title 全文。
5. 规约：全自绘浮层（无系统弹窗）；浮层内说明超长用项目现有自绘悬浮滑块滚动条样式。

## 实施顺序

1 服务端 → 2 PC 执行器（独立可并行）→ 3 chat.js（依赖字段名）→ 4 file-viewer.html（浮层降级路径不依赖服务端，可与 3 并行）→ 5 style.css。

## 验证方案（实测，禁猜测）

- 构建：服务端 `go build` → `im-server/bin/im-server.exe`；**注意 PC 端渲染层加载远端 web 文件，chat.js/file-viewer.html/style.css 需部署到 PC 端 SERVER_URL 指向的静态目录**；改动 agent-executor.js 需重出 exe。
- 用例矩阵：
  1. AI 修改工作区文件 → tool_start 卡片 + 审查条出现文件 +N/-M 与说明
  2. 同文件连续两轮修改 → 说明取最近一次（last-wins），行数累计正确
  3. 浏览区打开文件 → gutter 三色标记、变更导航 1/N 自动定位
  4. 悬停变更行色条 → 浮层：徽标+说明（或降级文案）+ "+N -M" + 行号范围
  5. 浮层回滚（两次确认）→ 文件还原、gutter 消失、说明清除
  6. 浮层/顶栏保留变更 → 备份清除、66 帧多端同步
  7. PC 本地执行器场景重复 1-6 → explanation 全链路透传
  8. 点击变更文件 → diff 预览头部：文件名+AI 说明+统计徽标；并排/行内切换正常
  9. 旧任务重放（无 explanation）→ 降级显示，无报错
  10. 明/暗/跟随系统主题 → 浮层/列表/diff 头部配色全部跟随变量
  11. 大文件（>1200 行改动）→ 防抖体系不受扰，不卡顿
  12. 回归：LSP 悬停、右键菜单、编辑保存、变更导航、任务卡审批互不干扰
- 手段：web 端 DevTools（1/2/8/9/10/12）+ PC 真机（3-7）+ 服务端日志确认落库与 66 帧字段。

## 关键文件

- e:\SourceCodeIM\im-server\server\agentrun.go（schema L580-618、agentRecordChange L2048、agentRecordPCChanges L2075、agentFinalizeChanges、agentChangesPush）
- e:\SourceCodeIM\im-server\model\model.go（AgentChangeRecord L344）
- e:\SourceCodeIM\im-client\web\js\chat.js（说明存储、L9765/L14599/L14989 喂入口、L8061 注入、L9537 列表、L13023 diff meta）
- e:\SourceCodeIM\im-client\web\file-viewer.html（悬停浮层、fvTaskRevertFlow 抽取 L2146、gutter/diff 头部打磨）
- e:\SourceCodeIM\im-client\web\css\style.css（变更列表行样式）
- e:\SourceCodeIM\im-client\pc\agent-executor.js（pcReport L350 + 三处调用透传）
