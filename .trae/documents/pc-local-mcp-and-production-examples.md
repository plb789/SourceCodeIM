# 计划：PC 端用户自定义 MCP（方案A）+ MCP 生产示例补充

## Context

MCP 服务端归口（管理员公共服务器）已在阶段八十八/八十九落地。本轮实现两项：
1. **生产可用实例补充**：config.yaml 生产级示例、管理页"常用模板"一键填充、开发文档 MCP 章节（当前文档 0 命中 MCP）。
2. **PC 端用户自定义 MCP（方案A，TRAE 同款）**：用户在 PC 客户端设置面板管理自己的 MCP 服务器（仅 stdio，本地拉起进程），工具清单上报服务端注入 Agent Loop，调用时下放 PC 本地执行器执行。远程 sse/http 仍走管理端服务端通道（保持本地性、不扩攻击面）。

复用基础（已核实）：PC 沙箱白名单全套先例（userData JSON 存储 / msg 52 上报 / 提示词注入 / agent-ws-mask 面板 / preload IPC）、agentWaitLocalExec（msg 50/51）本地执行通道、mcpToolKey 命名空间算法。

## 阶段A：PC 端 MCP 管理器 + 设置 UI

1. **新建 `im-client/pc/mcp-manager.js`**：Node JSON-RPC over stdio NDJSON 客户端（initialize → tools/list → tools/call），按 `(username, serverName)` 常驻管理子进程；API：`start/stop/call/listTools/disposeAll`；`app.on('before-quit')` 全部回收。协议实现已由 mcp_test.go 真实 stdio E2E 验证过（NDJSON JSON-RPC）。
2. **`im-client/pc/main.js`**：仿 sandboxStore（L429-495）新增 `agent_mcp.json`（userData，按用户名隔离）+ `mcpNormalize`（名称/命令校验、servers ≤ 10、args/env 长度限制）+ IPC handler：`mcp:get/mcp:save/mcp:del/mcp:test`（test=临时建连验证，返回工具清单+耗时）。
3. **`im-client/pc/preload.js`**：desktop 暴露 `mcpGet/mcpSave/mcpDel/mcpTest`（仿 sandboxGet/Save/Choose L171-181）。
4. **`im-client/web/index.html`**：Agent 工具栏（agentWsBtn 同级，L101 附近）加 `agent-mcp-btn`（PC-only 条件显示）；L654 后加 `agent-mcp-mask` 弹窗（骨架对齐 agent-ws-mask，自绘弹窗/滚动条）。
5. **`im-client/web/js/chat.js`**：仿工作区面板段（L3677-3786）实现：服务器卡片列表（状态/工具数）、新增/编辑表单（name/command/args/env）、测试连接、删除；保存成功后触发 msg 67 上报；PC 登录成功回调（L2778 附近）同步上报。
6. **`im-client/web/css/style.css`**：`.agent-mcp-*` 样式，全部引用现有主题 CSS 变量。
7. **`im-client/pc/agent-executor.js`**：execTool（L843 switch）加 `mcp_pc_` 前缀分支 → 解析 server/tool → `mcpManager.callTool(username, ...)`，未配置/超时返回明确错误文案。

## 阶段B：协议 + 服务端注入与执行路由

1. **`im-server/protocol/message.go`**：`MsgTypeAgentPcTools = 67`（双向：上行 `{tools:[{server,tool,description,input_schema}]}`，服务端校验后回下行 `{ok:true,count:N}` 确认帧，仿 msg 61 双向先例）。
2. **`im-server/server/agentrun.go`**：
   - `agentPcTools sync.Map`（username → []PcMcpToolDef）+ `handleAgentPcTools`（仿 handleAgentSandbox L1191：仅 platform=pc、按 c.username、清洗/去重/上限）。
   - `agentToolDefinitions()` → `agentToolDefinitions(username string)`；内部合并 `agentPcToolDefinitions(username)`（前缀 `mcp_pc_<server>_<tool>`，规整复用 mcpToolKey 算法）。调用点 L2720 传 `t.Username`；grep 全部调用点一次性同步（生产仅 L2720，测试文件另查）。
   - `agentToolServerOnly`（L879）：`mcp_pc_` 返回 false。
   - `agentToolExecDispatch` 回退分支（L922-927）：`mcp_pc_` 特判——返回"错误：该工具仅 PC 客户端可用（本机 MCP 服务器离线或未响应）"，**禁止回退服务端执行**（唯一高危点）；`agentToolExec` 的 `mcp_` 分支同步排除 `mcp_pc_` 防串路由。
   - `agentNeedsApproval`：`mcp_pc_` 一律逐次审批，reason："调用本机 MCP 服务器「X」的工具 Y（在您的电脑上执行），请确认"。chat.js 审批卡对 `mcp_` 前缀隐藏加白按钮的逻辑自动覆盖 `mcp_pc_`。
   - `agentToolLabel`（L902）：`mcp_pc_` → `"MCP · X / Y（本机）"`。
3. **`im-server/server/server.go`**：L200 后加 `case protocol.MsgTypeAgentPcTools`；PC 最后一个连接断开时 `agentPcTools.Delete(username)`（unregister L86 附近；若 hub 无现成 HasPC 判断则按现有连接注册表等价实现；agentSandboxes 现状不清理，勿动）。

PC 存储 `agent_mcp.json` 结构：`{"<username>":{"servers":[{name,transport:"stdio",command,args,env,enabled,tools:[{name,description,input_schema}]}]}}`。tools 清单不含 env/command，凭据仅存本机。

## 阶段C：生产示例 + 文档

1. **`im-server/bin/config.yaml`** mcp.servers 补生产示例（注释形态）：`@modelcontextprotocol/server-filesystem`（args 带 root 目录）、`server-fetch`、`server-memory`、`server-everything`、远程 http 示例（headers 带 Authorization）。注明 servers 仅首启导入、stdio 需将 node/npx 加入 stdio_whitelist。
2. **`im-client/web/js/admin.js`** openMCPServerModal（L2257-2339）append 区加"常用模板"按钮组（文件系统/网页抓取/记忆/Everything/远程 HTTP），点击一键填充 fields；导入弹窗不动。
3. **`docs/开发文档.md`**："四、核心功能详细设计"末尾新增 `## 4.x MCP 服务器集成`：架构、生产示例、msg 67 PC 自建协议、安全边界（审批/凭据本地化/白名单闸门）。

## 阶段D：编译 + 单测 + 实测

1. go 单测新增：`mcp_pc_` key 规整/冲突、handleAgentPcTools 非 pc 拒绝/清洗、注入合并（前缀与 serverOnly=false）、审批文案、PC 离线回退错误文案。
2. 全量回归：`go build ./... && go test ./...`；前端 `node --check`。
3. 实测（禁猜测）：
   - 管理页模板按钮填充 + 测试连接（浏览器实测，admin/admin123）。
   - PC 实测：`npm start` → 我的 MCP 面板添加 server-filesystem（或本地 echo 脚本）→ 测试连接出工具清单 → Agent 任务调用本机工具 → 审批卡"本机"文案 → 文件真实落在用户磁盘 → 杀 PC 进程重发任务验证"仅 PC 可用"错误 → PC 断线验证工具清单清除。
4. 构建：`go build -ldflags "-s -w" -o bin/im-server.exe main.go`；PC `npm run pack`（产出 im-client/bin/im-client.exe）；webbin 同步。

## 风险与兼容

- 老 PC 不上报 msg 67 → 不注入，零影响；Web/手机端天然无本机工具。
- `agentToolDefinitions` 改签名：调用点少（生产 1 处），grep 同步。
- 回退误执行是唯一高危点：dispatch 特判 + agentToolExec 兜底拒绝 + E2E 实测离线场景三重防护。
- 版本号 bump：style.css / chat.js / index.html、admin.js。
