# 阶段一百九十四：审批等待提醒 + 问答上下文水位条（A 类收官两项）

## Context

用户点单「任务完成提醒 + 上下文状态栏」两项。探索结论（三 agent + 细读实证）：

- **任务完成/失败提醒已存在**（阶段六十六）：[chat.js:16487](e:/SourceCodeIM/im-client/web/js/chat.js#L16487) `agentTaskNotify`——窗口隐藏或已切走会话时 PC 端 `window.desktop.notify` 弹系统桌面通知（[preload.js:11](e:/SourceCodeIM/im-client/pc/preload.js#L11) → [main.js:436](e:/SourceCodeIM/im-client/pc/main.js#L436) Electron Notification），Web 端 Toast 兜底；会话角标由服务端完结消息 CONV_LIST 联动。
- **任务卡上下文占用环已存在**（阶段一百三十九）：[chat.js:10557](e:/SourceCodeIM/im-client/web/js/chat.js#L10557) SVG 环，`step_tokens` 帧的 context_used/max/mode 每轮驱动，橙/红分档。
- **真缺口三个**：
  1. **等待审批无提醒**：`AGENT_APPROVE_REQ`（chat.js:16500）手动模式下用户切走会话时静默挂起，任务可能等审批数小时无人知（done/error 才有 notify）；
  2. **提醒不可点击**：Web Toast 无跳转、PC 桌面通知点击无行为；
  3. **普通 AI 问答无水位**：END 帧（[ai.go:1893](e:/SourceCodeIM/im-server/server/ai.go#L1893)）无 context_used/max，任务侧有环、问答侧空白。

用户决策：问答水位展示=**输入区上方常驻条**（TRAE CN 同款）；提醒补强=**审批提醒 + Toast 可点击直达**。

## 功能一：审批等待提醒 + 提醒可点击直达

### chat.js
1. **AGENT_APPROVE_REQ 手动分支补提醒**（L16500 处理器，进入人工审批分支即 `approveMode` 非 full/非 auto 免审路径时）：若 `document.hidden || currentChatUser !== msg.from_user` 则调 `agentTaskNotify(msg, st, I18N.t('等待审批'))`——st 可能为 undefined（切走会话未建卡），`agentTaskNotify` 已有 `(st && st.goal)` 判空兜底，直接复用；服务端零改动（status=waiting_approval 阶段一百九十三已落库）。
2. **agentTaskNotify 升级可点击**：
   - Web 分支：`showToast(body, onClick)` 传回调——`openConversation(msg.from_user)` 切到任务会话（193 看板跳转同函数）。
   - PC 分支：`window.desktop.notify(title, body, agentName)` 增第三参，模块级 `agentNotifyTarget = agentName` 记录最近通知目标；新挂 `window.desktop.onNotifyClick(function(){ if (agentNotifyTarget) openConversation(agentNotifyTarget); })`。
3. **showToast 升级**（L280）：签名 `showToast(text, onClick)`——有 onClick 时加 `toast-clickable` 类（pointer 光标+hover 反馈）与一次性 click 监听（点击后清除），无参行为不变（全站既有调用零影响）。

### pc/main.js + pc/preload.js（Electron 桥）
- main.js L436：`new Notification({...})` 加 `notification.on('click', ...)` → `win.show(); win.focus(); win.webContents.send('desktop-notify-click')`。
- preload.js：暴露 `onNotifyClick(cb)`（ipcRenderer.on('desktop-notify-click')）。

### style.css / i18n
- `.toast-clickable` hover 态（背景加深+光标）；i18n zh/en 补「等待审批」「点击查看」等词条。

## 功能二：输入区上方常驻上下文水位条（普通问答）

### 服务端 ai.go（3 处小改）
1. **protocol.Message 加字段**：`ContextUsed *int \`json:"context_used,omitempty"\`` / `ContextMax *int` / `ContextMode string \`json:"context_mode,omitempty"\``。
2. **问答 handler**：msgs 组装完成、LLM 请求发送前 `ctxUsed := aiMsgsEstimateTokens(msgs)`（[ai.go:1421](e:/SourceCodeIM/im-server/server/ai.go#L1421) 阶段八十四现成纯函数）；endMsg 组装处（L1893）`aiCompressThreshold > 0` 时填 `ContextUsed/ContextMax(=aiCompressThreshold)/ContextMode("tokens")`——阈值口径与压缩触发一致（达 100% 即将压缩），语义准确。
3. aiCompressThreshold<=0（未启用压缩）不下发，前端条自然隐藏。

### 前端
1. **index.html**：输入区容器内（审批面板 agent-approve-panel 同级上方）加 `#ai-ctx-bar`（默认 hidden）：迷你 SVG 环（复用任务环视觉语言 36 viewBox）+ `<span>` 百分比 + title 提示。
2. **chat.js**：
   - AI_STREAM_END handler（L7704 附近）：`msg.context_used != null` 时按 `aiViewSession[msg.from_user]` 会话归属校验后存 `aiCtxWater[msg.from_user] = {used, max, sid}` 并调 `aiCtxBarUpdate(msg.from_user)`。
   - `aiCtxBarUpdate(agent)`：当前查看会话匹配则更新环/百分比/显隐，不匹配隐藏（切会话经既有入口钩子重查缓存值——挂 193 的 `agentBoardSyncEntry` 同点 `agentBoardSyncEntry()` 旁加 `aiCtxBarRefresh()`）。
   - 环更新逻辑复制 `agentCtxRingUpdate` 的分档（≥80% 橙 ≥95% 红），不复用任务卡实例（独立 DOM）。
3. **style.css**：`.ai-ctx-bar`（输入区上方细条，flex 右对齐，环 16px + 文本 12px 中性色，主题变量跟随）；`.ai-ctx-bar .ctx-fg/.ctx-bg/.ctx-warn/.ctx-danger` 复用任务环样式类（若类名耦合任务卡则复制一份 `.ai-ctx-*`）。
4. **i18n**：上下文占用/口径词条复用 + 新增。

## 版本 bump
- index.html：style.css v2.96→2.97、chat.js v3.131→3.132；i18n PACK_VER 3.19→3.20。
- 服务端 `go build -o bin\im-server.exe .`（根包，禁 ./...）+ 重启。
- **PC 端重打包 im-client.exe**（本轮动 preload/main + 192/193 的 chat.js 也需入包——顺带清掉「PC 端未同步 192/193」欠账）。

## 验证
1. 服务端：编译 + `go test ./server/ -run "AI|Compress" -count=1` + 重启。
2. E2E（浏览器，alice）：
   - **水位条**：AI 会话连发 2-3 轮问答 → END 帧带 context_used → 输入区上方常驻条浮现，百分比逐轮增长；切普通会话条隐藏、切回恢复；未启用压缩配置时条不出现。
   - **审批提醒**：任务转后台等待审批（人工模式）→ PC/Toast 通知「等待审批」→ 点击 Toast 直达任务会话 → 同意后任务继续执行。
   - **完成提醒回归**：转后台任务完成 → 通知照旧（阶段六十六行为不回归）。
   - **showToast 回归**：普通 Toast（无 onClick）表现不变。
3. PC 端：重打包后桌面通知点击聚焦窗口并跳转会话。

## 回归风险点
- showToast 加参不破坏既有调用（可变参可选）；AGENT_APPROVE_REQ 提醒只在人工分支+非当前会话触发（自动/完全访问模式与盯着会话零打扰）；任务卡占用环/step_tokens 链路不动；END 帧新增字段对旧前端无害（多余 JSON 键忽略）。
