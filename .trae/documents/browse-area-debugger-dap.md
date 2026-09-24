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

## 阶段一百六十三实施记录：LSP 补全/诊断/跳转定义（2026-09-23 完成，TRAE CN 同款）

**架构分层**（复用悬停桥链路）：file-viewer（iframe 无 preload）→ `__imViewerHost`（chat.js）→ `window.desktop`（preload.js）→ IPC → main.js → browser-manager 按 tab 归口 → lsp-manager 子进程（gopls/clangd/pyright，stdio JSON-RPC）。独立查看窗口（viewer-preload）未加新桥，LSP 功能静默回落（克制）。

**lsp-manager.js（主进程）**：
- `prepare(req, timeoutMs, noDeadlineWait)` 通用管线：探测→实例→等就绪→syncDoc→ctx；hover/completion/definition 共用。**deadline 计入 waitReady 等待**（实测踩坑：冷启动等就绪 6.7s 不受 800ms 预算约束，前端弹陈旧补全）；requestLsp 过期预检不发废请求
- `touchDoc` 用 `prepare(req, 30000, true)`——等就绪不受请求预算约束（冷启动期 didOpen 仍发出，诊断推送异步到达）；编辑防抖 1200ms 由前端触发
- `completion`：归一 {items:[{label,kind(LSP 1-25 原值),detail,insertText,sortText,documentation}]}，上限 300；`definition`：归一 [{path,rel,line,column}]（1 基），上限 20；`normDiags`：LSP 零基→1 基、severity 1-4 保留
- 诊断 push 模式：publishDiagnostics → `inst.diags` 缓存 + `diagNotifyFn` → browser-manager `lspDiagNotify` 按 tab.filePath 归一匹配（分隔符/大小写不敏感）→ `lsp:diagnostics` → chat.js 按 tab_id 路由 viewer iframe `__wsLspDiags`
- **uriKey 归一（实测踩坑）**：`pathToFileURL('e:/x')` 保持小写盘符，gopls 回显统一大写 `E:`——docs/diags/getDiagnostics 缓存 key 不归一则推送写入与查询错位（推送回调正常触发但 getDiagnostics 返回 null）
- **rel 跨盘归空（实测踩坑）**：Windows `path.relative('e:\x','c:\y')` 返回绝对路径——GOROOT 定义跳转 rel 不以 `..` 开头漏过滤；归一条件加 `path.isAbsolute(rel)`
- 前端 provider 加 `fvLspRace` 竞速（completion 800ms / definition 1200ms）双保险：主进程预算含冷启动等就绪期，超时立即回落 Monaco 内置词补全

**file-viewer.html（v=144）**：
- registerCompletionProvider（go/c/cpp/python，triggerCharacters `['.',':','"','/','@','<']`）；LSP CompletionItemKind 1-25 与 Monaco 数值同源直传，无需映射表；snippet 文本（`$1/${1:..}`）标 InsertAsSnippet
- registerDefinitionProvider：取首个命中 → postMessage `__wsDefJump {path: rel, line}` → 宿主接管（同文件 `__fvReveal` 跳转+闪烁；跨文件 `browserOpenFile` 打开新标签走 reveal_line 注入链路）；前端防御 rel 空/`..`/盘符绝对路径
- `__wsLspDiags`：setModelMarkers（severity 1→Error/2→Warning/3→Info/4→Hint，MarkerSeverity 8/4/2/1），行列越界夹取，全量替换含清空
- onDidChangeModelContent 挂 1200ms 防抖 lspTouch；`__wsFileLoad` 尾部（Monaco 就绪 + file 标签）拉 `lspDiagnosticsGet` 恢复 markers（fvLoadSeq 过期防护）

**chat.js（v=3.89）/ main.js / preload.js**：__imViewerHost 四成员（lspComplete/lspDefinition/lspTouch/lspDiagnosticsGet）、onLspDiagnostics 转发、__wsDefJump 监听 + fvDefReveal 挂起注入（fileLoad 时配 payload.path 注入 reveal_line）；main.js 4 个 IPC handler + setNotifyFn 注入 + v=144

**模块级冒烟（真实 gopls v0.23.0，%TEMP% 免写盘 didOpen）ALL_OK 六项**：
- completion(math.) → Round kind=3 "func(x float64) float64" 含完整文档；工作区跳转 rel=server/redpacket.go L508；GOROOT（C:\GO\src\math\floor.go L83）跨盘 rel 置空；坏内容（虚拟 didChange 不写盘）`undefined: __undefinedSym999` sev=1 缓存命中；恢复后 Error 清零（hint 级风格提示 25 条属 gopls 正常输出）；hover 回归 209 字符
- **测试方法论踩坑**：Grep 行号（权威）与 Read offset 显示行号差 1，行号错位导致请求打在注释行——gopls 对注释位置返回作用域补全 8 项是正确行为，勿误判为缺陷；定位手段=脚本内 findIndex 动态定位
- 探测结果：gopls 可用（GOPATH 补探命中）；clangd/pyright 本机未装，C/C++/Python 静默回落（设计：LSP 是增强，静态表/内置补全是底线）
- 启动冒烟：客户端 5 进程 307MB 存活正常；产物：全部 .enc 12:23:53 + exe 12:24 + 快照含 fvRegisterLspProviders/__wsDefJump/v=144/v=3.89

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

**用户实测反馈修复：打开工作区文件内容区纯黑空白（2026-09-23，v=144 修复）**：
- 症状：LSP 上线后浏览区点击工作区文件——标签/面包屑/文件头按钮正常，**内容区纯黑**：无 .monaco-editor DOM、无"编辑器加载中…"、无静态预览
- **根因（Electron 探针决定性复现，console 直接报出）**：`Uncaught TypeError: monaco.languages.registerCompletionProvider is not a function`（file-viewer.html:1557）——**Monaco 正确 API 名为 `registerCompletionItemProvider`**（0.52 editor.main.js 实测存在前者缺失后者），provider 注册 IIFE 在 monacoBoot 内抛异常中断 → `monaco.editor.create` 永不执行 → monacoBox 空 div 黑屏；且 monacoBoot 开头已 `clearTimeout(monacoFailTimer)` 清掉 15 秒看门狗 → 无静态预览兜底 → 永久黑屏
- 排查弯路（记教训）：browser_use 报告 `globalDefine has already been declared` + "editor.main.js 两次请求（首次 CDN）"——实测均为其代理环境干扰（globalDefine 真身是 editor.main.js 内嵌 loader 的 const，本页单次执行不冲突；全项目 Grep 零 CDN），**结论须交叉验证**；HTML 结构/script 配对/git diff 均完好排除
- 探针方法论：BrowserWindow 直接 loadURL(file-viewer.html) + 注入 `window.imviewer = new Proxy({}, {get:()=>()=>{}})` 桩（viewerBridge 优先检测它）→ 注入 __wsFileLoad 真实 payload → 自动进编辑态触发 ensureMonaco → 12 秒后断言 `.monaco-editor` DOM + 收集 console-message 全量。webRequest 过滤可同时验证 Monaco 资源网络面
- **修复**：API 名改正 + LSP 注册 IIFE 整体 try/catch 兜底（`console.error('LSP provider 注册失败（不影响编辑器本体）')`）——provider 属增强功能，注册异常绝不能中断 monacoBoot（与 cssMode/tsMode defaults 的 try/catch 风格一致）
- 验证：探针复跑 monacoDOM=true、monacoBoxChildren=2、go.js/workerMain/codicon 全链加载、console 零报错；Grep 确认全文 5 处 register* API 名均正确（Hover×3/CompletionItem/Definition）
- **无需重打包**：file-viewer.html 走服务端实时 serve（web_dir 留空向上找源目录，`Cache-Control: no-cache` 协商缓存 + Last-Modified 已更新），用户重开文件标签即生效；版本号保持 v=144

**LSP 三件套真实客户端实测（2026-09-23，computer_use 子代理两轮 + 主进程日志）**：
- 测试环境：`E:\SourceCode2026\cheshi\lspdemo\`（自包含 Go 模块：go.mod + main.go 调 util.Add/math.Round/fmt.Println + util/util.go）；gopls v0.23.0（GOPATH `C:\Users\AW\go\bin`，PATH 补探命中）
- **实测结论：三件套全过**——黑屏修复后编辑器正常渲染；补全（fmt. → Println 弹出带签名）；诊断（undefinedSym999 → 红波浪线 → 撤销后消失）；跳转定义（F12 → 新标签 util.go 定位 func Add 行）；切标签诊断恢复正常
- **lsp-manager 六处修复生效确认**：首轮实测前重打包（uriKey/deadline/touchDoc 等修复仅在源文件冒烟过，未进 13:02 客户端进程）
- **首轮三项"失败"均为测试伪影（主进程 dbgLog 日志实锤）**：
  1. F12 首次报 "No definition found" = 子代理 Ctrl+F 定位失效，光标落在 `fmt.Println` 行（L13 C16）——gopls 对字面量返回 null 是正确行为；位置对时（L11 C17）definition 立即命中 util.go L4
  2. 补全"未弹出" = 子代理合成输入方式未触发 Monaco suggest（第二轮日志 [bm-lspComplete] 到达主进程证明链路通；首轮 UI 实测已 PASS）
  3. import "lspdemo/util" 红线 = 编辑会话中的快照期诊断截图——第二轮全程实测 didOpen 后 77ms 推 count=0，此后一直零诊断无红线；独立探针（复刻 initialize/didOpen/definition 全链）亦零诊断 + definition 命中
- **排查方法沉淀**：主进程 dbgLog 三段式（IPC 归口 browser-manager 入口 / lsp-manager prepare / publishDiagnostics 推送）+ 独立 node 探针复刻链路对照，一次定位"功能正常 vs 测试伪影"；子代理 UI 自动化结论必须与主进程日志交叉验证（输入方式、截图时机都会产生伪影）
- 测试文件 `lspdemo\` 保留在工作区供后续回归；临时探针 `gopls-probe.js` 与调试日志已清理；日志代码三处移除后重打包干净版

## 阶段一百六十四实施记录：TRAE CN 编辑体验补齐——条件/日志断点 + Watch/REPL + LSP 增强（2026-09-23 完成）

**背景**：对照 TRAE CN 浏览区/代码编辑器功能面盘点缺口，用户确认"第一+第二梯队"10 项全做。零基↔1 基行列转换、WorkspaceEdit 两形态兼容、禁系统弹窗（自绘浮层）、服务端/主进程数据归口四大原则贯穿。

**梯队一（编辑体验）**：
- **格式化 Shift+Alt+F**：`registerDocumentFormattingEditProvider`（go/c/cpp/python）→ lsp-manager `textDocument/formatting`（prepare 3000ms，options tabSize:4/insertSpaces:true）→ normTextEdit 归一 1 基；前端映射 Monaco TextEdit 数组，走内置 `editor.action.formatDocument`（diff 预览确认交互复用官方）；JS/TS 用 TS 服务内置 format
- **粘性滚动 stickyScroll**：`editor.create` options 加 `stickyScroll:{enabled:true, maxEditorLineCount:3}`（滚动时作用域头钉顶）
- **右侧滚动条错误色标**：overview ruler——阶段一百六十三诊断上线后 Monaco 默认 overviewRuler 已随 markers 自动标红（setModelMarkers 隐含落 ruler decoration），无需额外代码（实测确认）
- **快速修复 Ctrl+.**：`registerCodeActionProvider` + 内置 `editor.action.quickFix` 灯泡交互；diagnostics 从 context.markers 取（Monaco MarkerSeverity 8/4/2/1 → LSP 1/2/3/4 映射 SEV2LSP），1 基传主进程由 lsp-manager 回转零基；`only:['quickfix']`，只取携带 edit.changes 的项（command 型需 executeCommand 二次往返，丢弃），上限 20；**主进程 codeAction 补 uri→path/rel 归一**（与 rename 同构），前端按 rel 过滤只应用当前文件修复（standalone 无多文档实例，跨文件修复本版丢弃）
- **查找引用 Shift+F12**：LSP 语言（go/c/cpp/python）走 `textDocument/references`（includeDeclaration:true，上限 50）→ **自绘快速浮层列表**（standalone peek 跨文件 uri 无内容不可靠的既定决策）；非 LSP 语言回落内置 `editor.action.goToReferences`（TS 服务自带）；浮层点击 → `__wsDefJump` 宿主链路（同文件 reveal+闪烁/跨文件新标签）

**梯队二（导航+调试）**：
- **Peek 定义 Alt+F12**：LSP 语言拉 `lspDefinition`（复用跳转定义请求）→ 单一可靠定义直接跳（工作区外 rel 空/`..`/盘符绝对路径过滤同 definition provider 规则）→ 多命中浮层列表挑选；JS/TS 回落内置 `editor.action.peekDefinition`
- **重命名 F2**：`registerRenameProvider` → `textDocument/rename`（newName ≤200 校验；changes/documentChanges 两形态兼容，pyright 用后者）→ 本文件 edits 交给内置 rename 输入框（Monaco 自绘 widget，非系统弹窗）；跨文件计数 setStatus 提示（"重命名涉及另外 N 个文件"）；JS/TS 用 TS 服务内置重命名
- **文件内符号 Ctrl+Shift+O**：`registerDocumentSymbolProvider`（DocumentSymbol 树递归展平 children 前缀 A.B + SymbolInformation location 两形态兼容，depth<5 上限 300）→ 内置 `editor.action.quickOutline` 浮层；LSP 未命中/超时/无桥回落 `fvScanSymbols` 静态扫描（JS/TS 同源）
- **条件/日志断点（Shift+点击 + 双击断点列表行编辑）**：
  - 交互：Shift+点击 glyph 槽 → 自绘输入条（select 类型 + input + 确定/取消，编辑器行右侧定位）；行上无断点先创建（语义由确定时落定）；表达式留空还原普通断点；dbgRenderBpsPane 徽标 [条件]/[日志] + 双击编辑；dbgClosePanel 时收起输入条
  - 形态：普通=红圆、条件=红圆+白环（fv-bp-dot-cond）、日志点=红菱形 rotate 45deg（fv-bp-log）；glyphMarginHoverMessage tooltip 显表达式
  - 数据双轨兼容：前端 `dbg.bps`（number[]，全链路兼容）+ `dbg.bpMeta`（行号→{condition,logMessage}）分离；下发 `dbgPushBps` 组对象数组 [{line,condition?,logMessage?}]，verified 行号回推后清孤儿元数据；主进程 debug-manager 断点持久化改存对象数组（normBpLines 归一、500 字符截断、旧 number[] 兼容读取），DAP setBreakpoints 三路透传（未调试只持久化/Node condition 透传 logMessage 丢弃/**V8 Inspector 不支持 logMessage**（js-debug 上层实现）故前端对 .js 隐藏日志点选项/DAP condition+logMessage 全透传）；start 应答/breakpointsFor/state 均补 bps 对象数组 + breakpoints number[] 兼容双输出
  - `dbgMetaSync(list)` 统一恢复入口：对象数组→双轨（dbgStart/dbgOnPayload 的 debugBreakpointsGet/debugState 三处接入，r.bps 优先 r.lines 兜底）
- **Watch 监视 + REPL 调试控制台**：
  - 调试面板新增"监视"页签：dbg.watch 字符串数组（≤20），`dbgRenderWatch` 复用 dbgVarNode（evaluate context:'watch'，variablesReference 懒加载子树）；dbgPauseRefresh 尾部 dbgRefreshWatches；空态提示"下方输入后回车添加"
  - REPL：控制台 pane 底部 `> 输入行`（#fv-dbg-repl），回车 → evaluate context:'repl'（暂停时带 frameId 可访问局部变量）→ 输出回显控制台；主进程 evaluate 补 context 透传
  - 事件绑定：bpEditor Enter/Escape/确定/取消 + 类型切换换 placeholder、watchInput 回车、replInput 回车、监视页签切入时渲染

**桥链路（第五、六批 IPC）**：lsp-manager 新增 formatting/codeAction/references/rename/documentSymbol 五请求（module.exports 同步）→ browser-manager 五个归口函数（findFileTab(payload) → lspManager.xxx({filePath, text, ...})，与 lspComplete 同模式）→ main.js 5 个 ipcMain.handle（lsp:format/code-action/references/rename/document-symbol）→ preload.js 五成员 → chat.js __imViewerHost 五成员 → file-viewer providers/commands。evaluate context 透传（debug-manager 请求体直传）

**版本与构建**：file-viewer.html v=144 → v=145（chat.js iframe src 与 pc/main.js setViewerUrl 两处同步）；index.html chat.js?v=3.89 → 3.90；obfuscate.js 36 文件 658ms 通过 → electron-builder --dir 重打包 → bin\im-client.exe 15:23 部署 → 启动冒烟 5 进程存活正常

**实测验证与已知边界**：
- 六文件 node --check / esbuild transform / 内嵌 JS new Function 三重语法校验全过
- 已知边界（诚实标注）：①跨文件重命名/快速修复仅提示不自动应用（standalone 单文档实例，多文件编辑需逐文件重做）②Node 调试日志点不受支持（V8 Inspector 能力边界，UI 已隐藏选项）③clangd/pyright 未安装环境引用/Peek/格式化静默回落（静态扫描/内置服务兜底，LSP 是增强不是底线）
