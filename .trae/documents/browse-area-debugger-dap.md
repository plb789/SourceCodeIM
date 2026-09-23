# 浏览区断点调试功能（TRAE CN 同款）实施计划

## Context

用户在浏览区（Monaco 只读预览）看到行号槽的断点红点（Monaco 内核默认交互），提出：**实现 TRAE CN 同款的真断点调试**——支持 Python / Node.js / C/C++，完整深度：断点增删 + 继续/单步/步出 + 暂停行高亮 + 悬停变量求值 + 变量/调用堆栈面板。

架构采用 VS Code 同款 **DAP（Debug Adapter Protocol）**：前端 Monaco 只做 UI，PC 主进程（Electron/Node）做 DAP 客户端与适配器进程管理，被调试进程跑在用户本地工作区。

## 总体架构

```
file-viewer.html (Monaco UI: 断点红圈/暂停行/悬停求值/调试面板)
   ↕ ipcRenderer ⇄ ipcMain (desktop API, 既有 contextBridge 模式)
debug-manager.js (PC 主进程, 新建: DAP 客户端 + 会话生命周期 + 语言适配器配置)
   ↕ DAP (JSON 消息: stdin/stdout 或 TCP)
Debug Adapter: debugpy(Python) / @vscode/js-debug-debugadapter(Node) / cdt-gdb-adapter(C++)
   ↕
被调试进程 (用户工作区文件, cwd=工作区)
```

## 关键设计

### 1. debug-manager.js（新建，PC 主进程）
- **精简 DAP 客户端**：initialize/launch/setBreakpoints/threads/stackTrace/scopes/variables/continue/next/stepIn/stepOut/evaluate/disconnect，~15 种消息覆盖完整调试闭环
- **会话管理**：单会话（同 TRAE 简化）；进程 spawn 复用 agent-executor.js L755-870 的 spawn 写法（cwd/env/隐藏窗口/强杀）
- **语言适配器配置表**（按文件扩展名路由）：
  - `.py` → `python -m debugpy --listen 127.0.0.1:<port> --wait-for-client <file>`（TCP 连 debugpy）
  - `.js` → npm 包 `@vscode/js-debug-debugadapter`（js-debug 独立 DAP server，stdio）
  - `.exe/.cpp 编译产物` → npm 包 `cdt-gdb-adapter` + 本机 gdb（MinGW）
- **断点持久化**：主进程 JSON 按文件绝对路径存断点行号（重启不丢）
- **事件推送**：stopped/output/terminated 经 `webContents.send('debug:event', ...)` 到渲染层（同 browser:state 推送模式）

### 2. IPC（main.js 注册，desktop API 暴露）
`debug:start(语言,文件,cwd,args)` / `debug:stop` / `debug:setBreakpoints(文件,行[])` / `debug:continue|next|stepIn|stepOut` / `debug:stackTrace` / `debug:variables(variablesReference)` / `debug:evaluate(frameId,expr)` + 渲染层 `window.desktop.debugXxx(...)`（Promise 模式同 browserOpenFile，chat.js L13585）

### 3. file-viewer.html UI
- **调试控制条**：顶栏新增（继续/单步/步出/重启/停止 + 调试状态灯），仅编辑态工作区文件显示，按扩展名检测语言；F5 快捷
- **断点交互**：Monaco `onMouseDown` 行号槽切换断点（红圈 decoration，复用现有 glyphMargin——AI 悬停浮层共用此区不冲突）；断点列表入调试面板
- **暂停行高亮**：顶层 decoration（黄箭头+行背景，VS Code 同款）
- **悬停变量求值**：Monaco hover provider → `debug:evaluate`，暂停时悬停表达式显示值
- **调试面板**：底部可折叠面板（变量树 + 调用堆栈 + 断点列表三栏，仿 TRAE 布局），DAP variablesReference 懒加载子节点
- **容器**：`#fv-monaco` 下方新增 `#fv-debug-panel`，与编辑器 flex 共存；diff 对比视图暂不支持调试（仅单文件编辑态）

### 4. 环境检测与引导（关键风险）
- 用户本机 `C:\Python27\python.exe` 为 Py2——**debugpy 需 Python 3**：`debug:start` 前按序探测 `py -3`/`python3`/`python`（校验版本≥3.7），未装 debugpy 时面板提示一键 `pip install debugpy`
- Node：Electron 主进程自带 node 运行时；C/C++：检测 gdb 不存在时面板引导（MinGW 安装说明）

## 分阶段实施

| 阶段 | 内容 | 交付 |
|---|---|---|
| A | debug-manager.js DAP 客户端 + IPC + Python(debugpy) 全链路：断点/单步/暂停行高亮/变量面板/控制条 | Python 调试闭环 |
| B | Node.js 适配（@vscode/js-debug-debugadapter，npm 安装进 pc/） | .js 调试闭环 |
| C | C/C++ 适配（cdt-gdb-adapter + gdb 检测/引导） | 编译产物调试 |
| D | 悬停变量求值 + 断点持久化 + 面板打磨 + F5 | 完整同款 |

## 涉及文件
- **新建** `im-client/pc/debug-manager.js`（DAP 客户端+会话）
- **改** `im-client/pc/main.js`（ipcMain 注册 + desktop 暴露 + debug-manager 挂载）
- **改** `im-client/web/file-viewer.html`（调试控制条/面板/断点装饰/hover provider；版本号 bump）
- **改** `im-client/pc/package.json`（B/C 阶段新增 npm 依赖）
- **改** `im-client/web/js/chat.js`（desktop 类型注释与状态透传，如需要）

## 验证
1. **阶段 A 验收**：工作区 hello.py 加 `for` 循环 → 浏览区打开 → 打断点 → 点调试 → 程序暂停在断点行（行高亮+面板显示局部变量 i/name）→ 单步观察变量变化 → 继续 → 输出面板见 print 结果
2. 阶段 B：main.js 脚本（纯 Node API）同流程
3. 阶段 C：hello.c 源文件自动编译（gcc -g -O0 → *_debug.exe）+ gdb 断点闭环（原定 port_relay 编译产物方案改为源文件直调，更符合浏览区"打开即调试"体验）
4. 重启客户端断点仍在；AI 悬停浮层/gutter 色条回归不受影响；性能：调试会话空闲时无轮询（DAP 事件驱动）

## 阶段 C 实施记录（2026-09-23 完成）

**方案**：`cdt-gdb-adapter@1.10.0`（stdio DAP）+ 内置工具链 gdb——实测 `~/.im-mcp/gcc/bin` 自带 gdb 17.2（gcc 16.2.0），**无需独立 gdb 安装引导**；gcc/gdb 缺失时经注入的 `toolchainManager.ensureGcc` 一键引导（bundled 本地 zip 优先，联网兜底）。

**关键实测结论（probe_c.js 探针 + harness_cpp.js 28 项）**：
- 序列：initialize → launch（不 await）→ **initialized 事件为推进信号** → setBreakpoints → configurationDone（内部触发 `-exec-run`，响应在 `^running` 后）→ running
- stopped 事件**不含行号**（仅 reason/threadId），行号照常经 stackTrace 栈帧定位（与 Python 路径同构）
- `exited-normally` → TerminatedEvent（无 exit code）；gdb 会话在 inferior 退出后常驻，terminated 后 900ms 自动 stopInternal 回收适配器+gdb（防孤儿进程，harness 实测零残留）
- serialport 依赖仅被 GDBTargetDebugSession（硬件目标适配器）引用，主 debugAdapter.js 不加载——npm install-scripts 被跳过也无影响
- **沙箱注意**：gdb `-exec-run` 在沙箱下子进程 spawn 被拦截会挂起——探针/harness 须非沙箱运行（真实客户端无沙箱，不受影响）
- debug-manager 新增：`DapClient.connectStdio`（stdio 帧传输复用 `_data` 解析，sock 仿真 write/destroy）、`resolveTool`（agentEnv PATH 扫描解析 gcc/gdb，不硬编码路径）、`startCpp/compileCpp/launchCppAdapter/resolveCppToolchain/bootstrapCpp`、`setToolchainFn` 注入；cmd() 通用 DAP 分支直接复用（栈帧/作用域/变量/求值/单步/continue）
- env 陷阱：`Object.assign({}, process.env)` 后原键为 `Path`，改 `env.PATH` 会双键并存——可执行文件解析按新 `PATH` 走，构造时必须 `env.PATH || process.env.PATH` 兜底（harness 踩坑实测）
- 打包：package.json `dependencies` 加 cdt-gdb-adapter；`asarUnpack` 加 node_modules/cdt-gdb-adapter + @vscode/debugadapter + @vscode/debugprotocol + async-mutex（外部 node 进程读不了 asar，`adapterEntryPath` 做 app.asar → app.asar.unpacked 路径替换）；打包态 electron-builder 可能触发 serialport 原生重建，若失败将 serialport 移出依赖树再验
- 前端：dbgLangOfExt 加 c/cpp/cc/cxx；`no_gcc_env` 结构化错误 → 引导条；dbgBootstrap 按 lang 分流 debugBootstrapCpp/Python
- 版本：v=139（main.js setViewerUrl + chat.js iframe src 同步）
- 回归：harness_node 24 项 / harness_py 全过 / 零孤儿进程（gdb/hello_debug/adapter 均 0）

**阶段C 打包记录（2026-09-23）**：
- debug-manager.js 纳入 obfuscate.js `MAIN_MODULES` 加密清单（第 10 个主进程模块，564.6KB 总量实测加密成功），package.json `files` 加 `!debug-manager.js` 排除明文——loader.js 解密钩子为通用机制（MODULE_NOT_FOUND → 同名 `.enc` → 内存编译），无需改 loader
- **serialport 原生重建失败 → `npmRebuild: false` 解决**（首打包实测：electron-builder `@electron/rebuild` 强制重建 `@serialport/bindings-cpp`，node-gyp 缺 Python 挂掉）。依据：运行时主链路（debugAdapter.js → GDBDebugSessionBase）不加载 serialport，重建与否无影响；当前依赖树唯一原生模块即它，全局禁用重建无副作用。若未来引入真需 Electron ABI 的原生模块，须改回并把 serialport 从依赖树剔除（npm overrides 不支持 false 排除，需换法）
- 打包产物验证点：`dist\win-unpacked\resources\app.asar.unpacked\node_modules\cdt-gdb-adapter\dist\debugAdapter.js` 存在 + `bin\im-client.exe` 产出

**阶段D 实施记录（2026-09-23 完成）**：
- 盘点结论：F5/F10/F11/Shift+F11 快捷键（阶段A已实现）、断点持久化（阶段A）、会话状态恢复、变量树懒加载/空态/失败态、断点 pane 删除/跳转、控制台输出 pane 均已完善——阶段D 唯一实质缺口为悬停求值
- **修复：悬停求值三语言全覆盖**——原实现仅注册 Monaco 语言 `python`，Node（javascript/typescript）与 C/C++（c/cpp）悬停无求值。改为 `['python','javascript','typescript','c','cpp'].forEach(registerHoverProvider)`（dbgHoverEval 内部无语言分支，未暂停返回 null 零开销，安全）。注意 dbgLangOfExt 返回的是调试路由名（python/node/cpp），与 Monaco 语言 id 无关
- 版本 v=139 → v=140（main.js setViewerUrl + chat.js iframe src 同步）
- 控制台 REPL 输入求值不在阶段D 计划内，未实现（当前为输出型：stdout/stderr/调试事件透传）
- 打包回归：main.js.enc / web-snapshot.enc 重出，bin\im-client.exe 刷新

**用户实测反馈修复：断点红圈点击失效（2026-09-23，v=141）**：
- 症状：浏览区 Monaco 编辑态点击行号左侧 glyph margin 无反应，断点红圈无法添加
- **根因（iframe 探针实测）**：Monaco 0.52 AMD 版运行时**未导出 `monaco.MouseTargetType` 枚举**（探针输出 `MouseTargetType=MISSING`）——断点点击处理器 `e.target.type !== monaco.MouseTargetType.GUTTER_GLYPH_MARGIN` 对 undefined 取属性抛 TypeError，被处理器自身 try-catch **静默吞掉**，点击永远无效。同模式引用还有 AI 变更浮层的 gutter 判定（三枚举），一并失效
- 探针排除法过程：glyphMargin 配置 ✓（glyph-margin=21px）、payload 字段 ✓（kind/mime/ext）、dbgBridge 同源 iframe 可达 ✓（`parent-desktop=yes ping=pong`）、dbgSupported=true（控制条显示）✓、装饰渲染链 ✓（stub 预置断点 [5,9] 红圈 2 个全部画出）——唯独点击链路断
- **修复**：新增 `mtt(name, fb)` 本地解析（运行时探测 MouseTargetType，缺省按 0.52 内部枚举值兜底 GLYPH=2/LINE_NUMBERS=3/LINE_DECORATIONS=4，editor.main.js 提取），替换两处引用；修复后探针点击第 13 行 → `debugSetBreakpoints lines=[5,9,13]` + `bp-dots=3` 全链路打通
- 澄清：iframe payload 的 tab_id 由 browser-manager `Object.assign(r.payload, {tab_id: tab.id})` 注入内层（L620/635/506），真实链路无缺失（探针手造 payload 才缺，非产品 bug）
- 复现探针固化：`C:\Users\AW\.cache\dbg_test\iframe_fv_probe\`（server.js 静态服务 + stub preload + host.html srcdoc 注入真实 file-viewer.html + 合成鼠标事件断言），`node server.js` + electron main.js 即可复跑
- 教训：**try-catch 包裹的 UI 处理器吞 TypeError 是这类"点击无反应"的典型形态**；Monaco 大版本升级后 API 面变化（0.52 移除 MouseTargetType 导出）须实测而非假设存在
- 版本 v=140 → v=141

**TRAE CN 同款断点悬停提示（2026-09-23，v=142）**：
- 交互：鼠标经过行号/行号左 glyph 槽 → 该行 glyph margin 显**空心红点**（可打断点提示）；已打断点的行不叠加（实心已示）；鼠标移开即消；行号悬停光标同步 pointer
- 实现：`onMouseMove` 判定 GUTTER_GLYPH_MARGIN/GUTTER_LINE_NUMBERS（经 mtt() 兜底）→ `dbgRenderHoverDot(line)` 单装饰列（dbg.hoverCol，行未变零重绘）；`dbgRenderBps` 尾部 force 刷新（断点增删后空心/实心即时交接）；CSS `.fv-bp-hover-dot::before`（实心圈同位 11px 空心变体）
- **探针方法论升级（重要教训）**：合成 DOM 事件（dispatchEvent）能进 Monaco 的 mousedown 管道，但 **mousemove 管道被 Monaco 0.52 拒收（isTrusted 过滤）**——合成 mousemove/pointermove 均不触发 editor.onMouseMove（DOM 捕获层能收到，证明事件已传播，是 Monaco 侧丢弃）。**改用 CDP `webContents.debugger` + `Input.dispatchMouseEvent`（浏览器真实输入管道，isTrusted=true）后全部驱动成功**——UI 交互自动化验证应以 CDP 输入事件为准
- CDP 探针全过：悬停显空心(n=1)/断点行不叠加(n=0)/移开消失(n=0)/点击加圈(n=3)/再点移除(n=2)；另发现 glyph 装饰 DOM 创建为异步渲染，断言等待需 ≥800ms（500ms 会偶发少计）
- 探针固化 `C:\Users\AW\.cache\dbg_test\iframe_fv_probe\`（main.js 为 CDP 驱动版；host.html 提供 payload 注入与 __q 断言入口）
**v=143 撤回（2026-09-23）**：行号区右侧细边线（TRAE CN 分隔线）实装后由用户手动撤回——决定不加此线，版本号已同步回 v=142 并重打包。悬停空心红点（v=142）保留。
