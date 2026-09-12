# 文件查看归一内置浏览区（TRAE CN 化）实施计划

## Context

PC 端现有两套"文件查看"体系并存：阶段七十六「工作区文件面板 wsPanel」（chat.js 页面内 DOM 浮层：文件树/源码查看/docx·xlsx·pptx 预览/编辑保存/git diff/提交详情/审查报告）与阶段九十一「内置浏览区 browser-manager.js」（主进程 BrowserView 多标签网页浏览器）。用户在 Agent 打开工作区文件又点浏览器按钮时出现"两个浏览区"。用户要求：PC 端全部归一到内置浏览区标签（TRAE CN 风格一切皆浏览器标签），且浏览区标签内支持编辑保存；Web/手机端无 desktop 桥，保持 wsPanel 完全不变。

## 方案总览

- browser-manager.js 新增 `kind:'file'` 内部标签类型：加载新建的 `web/file-viewer.html`（同款本地库渲染），独享窄 preload（仅此类型；网页标签保持零 preload 不变）
- 两种打开模式：`browser:open-file`（传工作区相对路径，主进程读盘注入）与 `browser:open-data`（diff/审查报告/提交详情，渲染层直接传内容注入）
- chat.js 新增 `wsOpenFile()/wsOpenData()` helper：PC 能力检测改道浏览区，否则原路走 wsPanel；9 个 wsPanelOpen 调用点 + 3 个 git 特殊标签函数全部改道
- 保存闭环：viewer 页 → viewer-preload → `browser:file-save`（路径由主进程 tab.filePath 决定，页面只传内容）→ 写回 + 推 `browser:file-saved` → chat.js 刷新文件树/git 装饰

## 改动明细

### 1. e:\SourceCodeIM\im-client\pc\browser-manager.js

- `createTab(url, activate, kind)` 扩第三参（默认 'web'）；file 标签 webPreferences：`partition:'persist:agent-fileviewer'`（与网页分区隔离）、`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`preload:path.join(__dirname,'viewer-preload.js')`；挂 `will-navigate`（目标非 file-viewer.html 即 preventDefault）+ `setWindowOpenHandler` 一律 deny，保证带 preload 的分区永远只见本地 viewer 页
- 新增 `openFileTab(username, relPath)`：safePath 校验（resolve 后必须位于 userData/agent_workspace/<username>/ 内）→ 读文件：前 8KB 查 NUL + 扩展名清单（docx/docm/xlsx/xlsm/pptx/pptm/pdf/图片=binary，其余 text）判定文本/二进制；文本 ≤512KB（对齐 agent-executor.js:925 WS_FILE_READ_MAX，超限截断置 truncated）；二进制 base64 ≤2MB（对齐 fileReadB64Level:996）→ 建 file 标签 loadURL `file://…/web/file-viewer.html` → payload 存 `tab.pendingPayload`，`did-finish-load` 时 `executeJavaScript('window.__wsFileLoad(' + JSON.stringify(JSON.stringify(payload)) + ')')` 双重 stringify 注入（页内 JSON.parse，无注入面）
- 新增 `openDataTab(payload)`：direct 内容模式 `{kind:'diff'|'commit'|'md'|'text', title, content, meta?}`，同注入链路；`tab.filePath=null` 不可保存
- 新增 IPC（init 内注册）：`browser:open-file` {username,path}、`browser:open-data` payload、`browser:file-save` {tab_id,content}（只写 tab.filePath，safePath 复验，utf8 写回，对齐 fileSaveLevel:1014 语义）→ 成功后 `mainWindow.webContents.send('browser:file-saved',{path})`
- `setPathGuard(fn)` 注入口（main.js 注入 agentExecutor.safePath，避免 require 循环依赖：agent-executor:2018 已导出 safePath，但其 require 了 browser-manager）
- statePush 扩展：tabs 元素增 `{kind, fileName, dirty}`，顶层增 `kind`
- Agent 工具防护：toolSnapshot/toolClick/toolInput/toolEval（:351/:385/:404/:457）活动标签为 file 时返回「活动标签为本地文件查看页，不可交互，请先 browser_navigate」；toolNavigate 活动 file 标签时强制 newTab；browser_tabs list 输出 `[文件]` 前缀

### 2. e:\SourceCodeIM\im-client\pc\viewer-preload.js（新建）

contextBridge 仅暴露最小能力：`save(content)`（invoke browser:file-save，附 tab 标识）、`setDirty(on)`/`setEdit(on)`（经 title/信令回传主进程同步 tab 状态——doc.title 变化已有 page-title-updated 监听可复用）

### 3. e:\SourceCodeIM\im-client\web\file-viewer.html（新建，单文件内嵌 CSS/JS）

- 引用同款本地库（相对路径，index.html:760-768 同源）：`js/lib/highlight.min.js`、`js/lib/mammoth.browser.min.js`、`js/lib/xlsx.full.min.js`、`js/lib/jszip.min.js`、`js/lib/PptxViewJS.min.js`；CSP meta：`default-src 'self' file: data: blob:; script-src 'self' file: 'unsafe-inline' 'unsafe-eval'`（SheetJS/PPTXjs 需 eval）
- `window.__wsFileLoad(jsonStr)` 入口：JSON.parse 后按 payload 渲染——docx→mammoth；xlsx/xlsm/csv→SheetJS（sheet 切换条）；pptx→PPTXjs；md→自带精简 md 渲染（标题/列表/表格/fenced 代码块+hljs，不可用 chat.js 的 renderAIMarkdown）；png/jpg 等→Blob URL img；pdf→`<embed src=blobURL>`；文本/代码→hljs 高亮（语言推断复制 chat.js:5706 WS_LANG_MAP 精简版）
- 编辑态（text 且非 truncated）：编辑→textarea + 保存/取消（草稿存 viewer 内存，BrowserView 不销毁天然保留），样式对齐现有 wsPanel 按钮交互；顶部显示"只读/已修改"状态
- 样式全部用现有主题色系基调（viewer 独立页可硬编码与暗色面板一致的配色，无需跟随主程序主题切换）

### 4. e:\SourceCodeIM\im-client\pc\preload.js

增 `browserOpenFile({username, path})`、`browserOpenData(payload)`、`onFileSaved(cb)` 三个 API

### 5. e:\SourceCodeIM\im-client\web\js\chat.js

- 新增 helper：`wsOpenFile(path, forceReload)`（desktop.browserOpenFile 存在则改道，否则 wsPanelOpen 原路）；`wsOpenData(payload)`（desktop.browserOpenData 存在则改道 + `wsDataCache[key]` 缓存供 lastReviewKey 复开，否则原标签逻辑）
- 9 个 wsPanelOpen 调用点改道：4767（Agent 工具联动重载）→`wsOpenFile(c.path,true)`；7923（项目树）→`wsOpenFile(wsProjFsPath(p))`；8098→`wsOpenFile(selfPath)`；8173/9520（工具改盘/联动重载）→`wsOpenFile(key,true)`；8252（文件树右键打开）→`wsOpenFile(path)`；8991（read 完成消费）→分支前置改道，原逻辑保留为 Web fallback；5963（取消编辑）不改（PC 端 wsPanel 不再进编辑态）
- 3 个特殊标签改道：wsPanelGitOpenDiff(:7922)→`wsOpenData({kind:'diff',content:d.diff,meta:{path}})`；wsPanelGitOpenCommitFile(:7871)/wsPanelGitOpenCommit(:7896)→`{kind:'commit',content:d.diff,meta}`；wsPanelGitDoReview(:7526)/lastReviewKey 复开(:7479)→`{kind:'md',title:'审查报告',content}` + wsDataCache
- `browserApplyState`(:4082)/`browserRenderTabs`(:4052) 扩展：file 标签地址栏显示文件路径置灰只读、back/forward 恒禁、tab 按 kind 显示文件图标（精简 WS_ICON_MAP:5719）+ dirty 圆点；browser-tabs 容器补自实现横向细滚动条（禁止系统默认滚动条规则）
- `onFileSaved` 监听：刷新文件树 + 对应路径 git 装饰

### 6. e:\SourceCodeIM\im-client\pc\main.js

init(:778) 后注入：`browserManager.setPathGuard(agentExecutor.safePath)`

## 不改动

- wsPanel 全部代码保留（Web/手机端唯一路径；PC 端不再被文件入口唤起）
- 网页标签创建路径（webPreferences 零 preload）不动
- 服务端无任何改动（纯 PC 客户端 + web 前端）

## 实施顺序

1. 主进程：browser-manager.js（createTab 扩展/openFileTab/openDataTab/IPC/注入/防护/statePush）+ main.js 注入 PathGuard
2. viewer-preload.js 新建
3. file-viewer.html 新建
4. preload.js 三 API
5. chat.js helper + 入口改道 + 状态扩展 + file-saved 联动

## 验证清单

- `node --check` 全部改动 JS
- PC 端重新打包部署（electron-builder → rcedit → bin 替换），启动实测：
  - 文件树点击/右键打开 → 浏览区新标签预览（txt/代码/md/docx/xlsx/图片各一）
  - md 编辑→保存→文件树刷新+git 装饰更新；取消编辑不落盘
  - git diff/提交详情/审查报告 → 浏览区 direct 标签渲染正确
  - Agent 任务中让模型 read_file 后联动重载不报错；browser_snapshot 在 file 标签活动时返回防护提示；browser_navigate 正常开网页标签
  - 网页标签功能回归（导航/多标签/关闭收起）
- Web 端（浏览器打开，无 desktop 桥）：文件查看全流程与现状一致（wsPanel）
- 手机端不构建验证（无 desktop 桥自动旁路，逻辑与 Web 同）
