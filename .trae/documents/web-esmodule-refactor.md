# 前端 ES Module 架构重构（bundle 单文件 + 彻底去全局化）

## 一、目标与范围

把 im-client 前端从「多 script 标签 + 隐式全局变量」架构重构成 ES Module（import/export）+ esbuild bundle 架构（TRAE CN 同款形态），重构代码全部放在新目录 `E:\SourceCodeIM\im-client\ESModule\`，**现有 `im-client\web\` 与 `im-client\pc\` 代码一律不动**；实测通过后同步切换 PC 打包链路（build.bat 快照源指向 ESModule 构建产物）。

用户已确认的三项决策：
1. **加载形态**：esbuild bundle 单文件（每页面一个 bundle，iife 格式经典 script 引入）
2. **兼容策略**：彻底去全局化——所有 window 全局出口（IMSocket/ScreenshotEditor/_lastPassword/_osb*/__imageViewerBridge/__imageViewerList/__imViewerHost）与 6 处 html 内联脚本全部模块化，跨窗口/跨 iframe 桥改用 BroadcastChannel 消息协议
3. **交付方式**：web_dir 临时指向 dist 端到端实测 → 实测通过后切换 build.bat 打包链路

## 二、现状勘察结论（已实测核对）

### 2.1 自研 js 与内联脚本分布

| 载体 | 位置与规模 | 性质 |
|---|---|---|
| chat.js | web\js\chat.js，15463 行/898KB，IIFE | 聊天核心；挂 window：`_lastPassword`(读)、`_osbInit/_osbInitH/_osbHosts`(自绘滚动条注册器，仅本文件消费)、`__imViewerHost`(L5530)、`__imageViewerBridge`(L14593)、`__imageViewerList`(L14370/L14408) |
| socket.js | 265 行，IIFE | 挂 `window.IMSocket`(L272) 与 `window._lastPassword`(L100/L214，重连与 chat.js L3276 saveAuth 消费) |
| screenshot.js | 562 行 | 挂 `window.ScreenshotEditor`(L600)，须先于 chat.js |
| admin.js | 2763 行 | 独立后台页，依赖 lib 全局 echarts |
| image-viewer.js | 301 行，IIFE | 消费 `window.desktop`（PC）/ `window.opener.__imageViewerBridge.requestOlder` + `window.opener.__imageViewerList`（Web） |
| file-viewer.html | 内联 L301-2197（约 1890 行）+ head 内联 L20-29（主题预挂载） | 消费 monaco(lib) 与 `window.parent.__imViewerHost`（save/setDirty/taskKeep/taskRevert/reportSymbols/reportLoaded/lspHover 七方法）；monaco AMD loader 外链 L300 |
| doc-preview.html | 内联 L47-109（约 60 行） | 依赖 lib（jszip/docx-preview/xlsx） |
| pptx-preview.html | 内联 L48-85（约 35 行） | 依赖 lib（jquery/d3/pptxjs 等 9 个） |
| admin.html | 内联 L8-13（主题预挂载） | echarts 外链 L602 → admin.js L603 → tooltip.js L605 |
| index.html | 内联 L13-21（pc-titlebar 挂类 + app-booting 2.5s 兜底） | head 外链 app-shell(L8)/mobile(L10)；body 末尾 L1100-1115：socket→screenshot→5 个 lib→chat→tooltip |
| tray-panel.html | 无内联 | 仅 tray-panel.js(L105) |
| image-viewer.html | 无内联 | image-viewer.js(L212) + tooltip.js(L214) |
| tooltip.js | 110 行 | index/admin/image-viewer 三页共用 |

### 2.2 关键约束
- 服务端静态根目录可配置：[config.go](file:///e:/SourceCodeIM/im-server/config/config.go) `web_dir` 配置项（`resolveWebDir` 配置优先、缺省自动找 im-client/web）→ 测试零服务端代码改动
- `window.desktop`（preload contextBridge）与 `window.Capacitor` 是平台桥，**不属于去全局化范围**，保留原样
- 第三方 lib（highlight/pptxgen/mammoth/jszip/xlsx/echarts/monaco/d3/pptxjs 等共 101 个文件）保持经典脚本原样，不进 bundle、不模块化
- BroadcastChannel 为同源跨窗口/iframe 标准通道，Electron 28(Chromium 120) 与 Capacitor WebView 均原生支持
- web-cache.js 增量同步以服务端 /api/web-manifest 清单为准：dist 不含旧自研 js，服务端清单仍含 → 需要排除清单机制，否则 PC 会把 6MB 废旧 js 下载回缓存
- 所有新文件 UTF-8 无 BOM；注释/日志全中文

## 三、目标目录结构

```
E:\SourceCodeIM\im-client\ESModule\
├── src\                              # ESM 源码（从 web 复制改造，主体逻辑零改动）
│   ├── bridge\
│   │   └── viewer-host.js            # BroadcastChannel 桥封装（宿主侧 + viewer 侧，reqId+超时）
│   ├── core\
│   │   ├── socket.js                 # export IMSocket、getLastPassword（去 window 挂载）
│   │   ├── screenshot.js             # export ScreenshotEditor
│   │   ├── tooltip.js                # export / 自执行初始化
│   │   ├── mobile.js                 # Capacitor 适配层（读 window.Capacitor 平台全局）
│   │   └── app-shell.js              # APP 壳引导
│   ├── boot\
│   │   ├── index-boot.js             # 原 index.html L13-21：pc-titlebar + app-booting 兜底
│   │   └── page-boot.js              # 通用主题预挂载（原 admin.html L8-13 / file-viewer.html L20-29，
│   │                                 #   两者差异用参数区分：file-viewer 版多深色背景设置）
│   ├── chat\
│   │   └── chat.js                   # 聊天核心 15463 行：IIFE→模块，主体零改动，window 桥→BroadcastChannel
│   └── pages\
│       ├── admin.js                  # 后台管理模块化
│       ├── image-viewer.js           # 图片查看器（opener 桥→BroadcastChannel）
│       ├── tray-panel.js             # 托盘面板
│       ├── file-viewer.js            # ★ 新建：file-viewer.html L301-2197 内联整块抽出（约 1890 行）
│       ├── doc-preview.js            # ★ 新建：doc-preview.html 内联抽出
│       └── pptx-preview.js           # ★ 新建：pptx-preview.html 内联抽出
├── entries\                          # 每页面 bundle 入口（仅 import 排序，控制模块执行顺序）
│   ├── boot-index.js                 # import index-boot → app-shell → mobile（head bundle）
│   ├── index-main.js                 # import socket → screenshot → chat → tooltip（body 末尾 bundle）
│   ├── boot-admin.js                 # import page-boot(基础参数)（head bundle）
│   ├── admin-main.js                 # import admin → tooltip
│   ├── boot-file-viewer.js           # import page-boot(带背景参数)（head bundle）
│   ├── file-viewer-main.js           # import file-viewer（monaco loader 之后）
│   ├── image-viewer-main.js          # import image-viewer → tooltip
│   ├── tray-panel-main.js            # import tray-panel
│   ├── doc-preview-main.js           # import doc-preview
│   └── pptx-preview-main.js          # import pptx-preview
├── html-template\                    # 7 个改造后的 html（从 web 复制 + script 引用改写，作为源码维护）
├── build.mjs                         # 构建脚本：esbuild 多入口 bundle + web 镜像复制 + 清单生成 → dist\
└── dist\                             # 构建产物：全量自包含 web 镜像（web_dir 可直接指向实测；build.bat 快照源）
```

## 四、核心技术设计

### 4.1 bundle 划分与执行时序（与现状逐点对齐）

| bundle（entryPoints） | 引入位置 | 对齐的现有时序 |
|---|---|---|
| bundle-boot-index | index.html head（原 app-shell/mobile 外链位置） | app-shell 跳转、pc-titlebar 挂类、防闪揭幕——均在首帧前 |
| bundle-index-main | index.html body 末尾 5 个 lib 之后 | socket→screenshot→chat→tooltip 拓扑序 |
| bundle-boot-admin | admin.html head 原 L8-13 内联位置 | data-theme 预挂载先于 CSS 渲染 |
| bundle-admin-main | admin.html body 末尾 echarts 之后 | admin→tooltip |
| bundle-boot-file-viewer | file-viewer.html head 原 L20-29 内联位置 | 主题+背景预挂载 |
| bundle-file-viewer-main | file-viewer.html monaco loader 之后 | viewer 逻辑 |
| bundle-image-viewer-main | image-viewer.html 原 L212/L214 位置 | image-viewer→tooltip |
| bundle-tray-panel-main | tray-panel.html 原 L105 位置 | tray-panel |
| bundle-doc-preview-main | doc-preview.html lib 之后 | 预览逻辑 |
| bundle-pptx-preview-main | pptx-preview.html lib 之后 | 预览逻辑 |

esbuild 参数：`bundle: true, minify: true, charset: 'utf8', legalComments: 'none', format: 'iife', target: ['chrome120'], entryNames: 'bundle-[name]'`（Electron 28 ≈ Chromium 120；浏览器端同源现代内核均满足）。iife 格式用经典 `<script src>` 引入，html 无需 type=module，lib 加载顺序天然先于 bundle。

### 4.2 BroadcastChannel 桥协议（bridge/viewer-host.js）

单频道 `im-viewer-bridge`，消息结构 `{ type, reqId, payload }`；有返回值的调用走 reqId 匹配 + 超时兜底（getList 3s、lspHover/save/taskKeep/taskRevert/requestOlder 15s），通知类（setDirty/reportSymbols/reportLoaded）火后不管。

宿主侧（chat bundle 启动即注册，单应答者；多标签多宿主时按「首个应答生效、后到丢弃」幂等）：
```js
// serve 注册的处理器（对应原 window 桥方法，逻辑原样搬入）：
//   getList({url})            → {list, index}      原 __imageViewerList 同步读改请求-应答
//   requestOlder()            → urls[]             原 __imageViewerBridge.requestOlder（viewerWebCallback 链路不变）
//   save({tabId, content})    → 结果               原 __imViewerHost.save → desktop.browserFileSave
//   setDirty({tabId, dirty})  → void               原 __imViewerHost.setDirty → desktop.browserViewerDirty
//   taskKeep({tabId})         → 结果               原 __imViewerHost.taskKeep
//   taskRevert({tabId})       → 结果               原 __imViewerHost.taskRevert
//   reportSymbols({tabId, symbols}) → void         原 __imViewerHost.reportSymbols（存 frame 记录+面包屑刷新）
//   reportLoaded({tabId})     → void               原 __imViewerHost.reportLoaded（进度条收条）
//   lspHover({req})           → hover|null         原 __imViewerHost.lspHover → desktop.lspHover
```

viewer 侧（image-viewer.js / file-viewer.js 统一走此封装）：
```js
// ViewerBridge.call('getList', {url})   → Promise<{list,index}>，超时降级空列表（对齐原"无桥接能力"分支）
// ViewerBridge.call('requestOlder')     → Promise<urls>
// ViewerBridge.call('save', {...}) / taskKeep / taskRevert / lspHover → Promise
// ViewerBridge.notify('setDirty'/'reportSymbols'/'reportLoaded', {...})
```

file-viewer 原「独立窗口 viewer-preload → 宿主 __imViewerHost（iframe 场景）→ desktop 兜底」三级回退简化为：有 `window.desktop` 直连（独立窗口场景不变）→ 否则 BroadcastChannel（iframe 场景，同源通吃，不再需要 window.parent 探测）。

### 4.3 各文件改造点（主体逻辑零改动原则）

| 文件 | 改造内容 |
|---|---|
| socket.js | IIFE→模块；`window.IMSocket = {...}` → `export const IMSocket`；`window._lastPassword` → 模块内变量 `lastPassword` + `export function getLastPassword()`（L214 重连用内部变量） |
| screenshot.js | IIFE→模块；`window.ScreenshotEditor = {...}` → `export const ScreenshotEditor` |
| tooltip.js | 按原形态模块化（自执行初始化保持） |
| mobile.js / app-shell.js | IIFE→模块（读 window.Capacitor/localStorage 不变） |
| chat.js | ①IIFE 壳去掉（模块作用域等价）②头部 `import { IMSocket, getLastPassword }` + `import { ScreenshotEditor }` ③L3275-3276 `window._lastPassword` → `getLastPassword()` ④L16114-16115 `window._osbInit/_osbInitH` → 模块内直接引用（grep 证实仅本文件消费，挂 window 的行删除）⑤L5530 `__imViewerHost`、L14593 `__imageViewerBridge`、L14370/L14408 `__imageViewerList` → ViewerHostBridge.serve 处理器（方法体原样搬入） |
| image-viewer.js | IIFE→模块；L87-88 opener 桥 → `ViewerBridge.call('requestOlder')`；L262-267 opener 列表 → `ViewerBridge.call('getList', {url})`；desktop 分支全部保留 |
| file-viewer.js（新抽） | 内联 L301-2197 整块搬运进模块（零改写），仅替换 `window.parent.__imViewerHost.*` 调用点 → desktop 直连 / ViewerBridge.call/notify；monaco require 与 lib 全局引用不变 |
| doc-preview.js / pptx-preview.js（新抽） | 内联整块搬运进模块（零改写） |
| admin.js | IIFE→模块；echarts 经 `const echarts = window.echarts` 显式引用（lib 全局，不属于去全局化范围） |
| 7 个 html | 复制到 html-template\ 后改写：内联块→boot bundle script；原自研外链/内联→main bundle script；lib 外链原样保留；注释标明 ESModule 重构版 |

### 4.4 build.mjs 构建脚本流程

1. 清空 `dist\`
2. 复制 `..\web\` → `dist\`（**排除** `js\` 下 9 个旧自研 js 与 7 个旧 html；lib/css/static 结构原样）
3. 复制 `html-template\*.html` → `dist\`（覆盖为改写版）
4. esbuild build API：10 个入口 → `dist\js\bundle-*.js`（参数见 4.1）
5. 生成 `dist\snapshot-manifest.json`（全部产物 `{rel: {s:size, t:Math.floor(mtimeMs)}}`，与现有 obfuscate.js 清单格式一致，web-cache.js 直接兼容）
6. 生成 `dist\manifest-exclude.json`：9 个旧自研 js 相对路径清单（供 web-cache 增量同步剔除）
7. 中文控制台输出统计（入口数/产物大小/文件总数）

### 4.5 web-cache.js 配套修改（打包链路切换后才生效）

`sync()` 差异计算处：读快照根 `manifest-exclude.json`，从服务端 /api/web-manifest 清单剔除这些路径后再比对 → PC 不会把已被 bundle 替代的旧 js 下载回 webcache。原逻辑注释保留。

### 4.6 build.bat 切换（实测通过后执行，GBK+CRLF 规则不变）

- [5/8] `node obfuscate.js` → `node "%~dp0..\ESModule\build.mjs"`（原命令注释保留）
- [6/8] robocopy 源 `"%~dp0bundled\web-obfuscated"` → `"%~dp0..\ESModule\dist"`
- obfuscate.js 文件保留不删

## 五、实施顺序（每阶段完成即自检）

1. **骨架**：ESModule 目录 + bridge/viewer-host.js（协议与超时）+ build.mjs 雏形
2. **核心模块**：socket/screenshot/tooltip/mobile/app-shell 转换（最小、可独立验证 import/export 正确性）
3. **chat.js 模块化**：IIFE 去壳 + import + 6 处 window 点替换（15463 行主体零改动）
4. **viewer 系**：image-viewer/tray-panel 模块化 + 桥 viewer 侧接入
5. **内联抽取**：file-viewer（1890 行，最大风险点，整块搬运仅改桥调用点）/ doc-preview / pptx-preview
6. **admin**：模块化
7. **html-template + build.mjs 完整**：7 个 html 改写 + 镜像构建 + 双清单生成，产出 dist
8. **web_dir 实测**：bin/config.yaml 的 web_dir 临时指向 dist（先确认 upload_dir 是否显式配置，避免上传目录漂移到 dist/static/upload），服务端不改代码重启后按下方清单逐项实测；实测完还原 config.yaml
9. **打包链路切换**：web-cache.js 排除清单 + build.bat 两处修改 + build.bat 全流程打包 + 全新 userData 首启「下载=0」验证 + 打包版功能抽查
10. **收尾**：全量文件 UTF-8 无 BOM 校验、临时文件清理、项目记忆更新

### 实测清单（阶段八）
- 登录/登出、文本/图片/文件消息收发、撤回、历史翻页
- 图片查看器（PC desktop 分支 + 浏览器 BroadcastChannel 分支：翻页联动 requestOlder、缩略图列表）
- 截图编辑器（open 模式）打开/编辑/确认发送
- 文件查看器：iframe 场景 monaco 打开/编辑/保存/脏标记/任务保留撤销/LSP 悬停/渲染回执进度条
- doc-preview / pptx-preview 打开预览
- admin 页：登录/仪表盘/主题切换/toast
- 托盘面板未读推送
- 主题切换联动（boot 预挂载不闪错主题）
- 手机 APP 与浏览器访问旧 web 目录不受影响（未动）

### 实测清单（阶段九，打包版）
- build.bat 全流程成功（含新 [5/8] build.mjs）
- 全新临时 userData + dist 快照：首启增量下载 = 0（排除清单生效，旧 js 不回灌）
- 打包版抽查：登录、收发消息、文件查看器桥、图片查看器

## 六、风险与兜底

| 风险 | 兜底 |
|---|---|
| file-viewer 1890 行抽取引入笔误 | 整块搬运零改写策略 + 非桥调用点逐行 diff 校验 |
| chat.js 15463 行模块化回归 | 主体零改动（仅 6 处 window 点），IIFE→模块作用域等价 |
| bundle 执行顺序变化 | 拆 boot/main 双 bundle 精确对齐 head/body 时序；esbuild 依赖图拓扑保序 |
| BroadcastChannel 多宿主重复应答 | 首个应答生效、后到丢弃（幂等），行为对齐旧 opener 唯一桥 |
| web_dir 指向 dist 后 UploadDir 漂移 | 实测前确认 bin/config.yaml 的 upload_dir 显式配置；否则临时补显式配置 |
| web-cache 回灌废旧 js | manifest-exclude.json 剔除机制（4.5） |
| Capacitor APP 兼容 | 本次不动：APP 仍用原 web 目录；BroadcastChannel 在现代 WebView 原生支持，后续切换无障碍 |

## 七、验收标准

1. ESModule 目录内全部为 ESM 源码（import/export），html 零内联脚本，跨文件零 window 全局依赖（平台桥 desktop/Capacitor 与 lib 全局除外）
2. dist 构建 reproducible：build.mjs 一键产出，双清单齐备
3. web_dir 实测清单（阶段八）全项通过
4. build.bat 全流程打包成功 + 首启下载=0 + 打包版抽查通过
5. 原 web\ 与 pc\ 既有源码零改动（build.bat/web-cache.js 的切换修改在实测通过后按计划执行，属计划内变更）
