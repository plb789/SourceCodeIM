// preload.js - 预加载脚本：暴露桌面端原生能力给渲染进程
// 阶段三十七（第三期）：新增静默抓屏（desktopCapturer）与 Alt+A 全局快捷键结果订阅
const { contextBridge, ipcRenderer } = require('electron');

// 阶段一百二十二：服务端地址注入已移除（原 app:// 方案经 additionalArguments 传 serverOrigin 供
// socket.js 拼 ws 地址；同 origin http 拦截方案下 origin 不变，socket.js 按 location 推导即可）

contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    // 阶段六十六：系统桌面通知（Agent 任务完结提醒等场景），转发主进程弹系统通知
    notify: function (title, body) {
        ipcRenderer.send('notify', { title: title, body: body });
    },
    // 阶段三十七（第三期）：静默抓屏（无系统共享弹窗），返回 PNG dataURL（Promise）
    captureScreen: function () {
        return ipcRenderer.invoke('shot:capture');
    },
    // 阶段三十七（第三期）：Alt+A 全局快捷键抓屏结果订阅（主进程推送 PNG dataURL）
    onGlobalShot: function (callback) {
        ipcRenderer.on('shot:global-result', function (event, dataUrl) {
            callback(dataUrl);
        });
    },
    // 阶段三十七（第四期）：托盘未读提醒——渲染层上报未读汇总 {total, detail, icon}（icon 为合成角标图 dataURL）
    setUnread: function (data) {
        ipcRenderer.send('tray:unread', data);
    },
    // 阶段三十七（第四期）：新消息到达请求托盘闪动（主进程控制约 3 秒闪烁 + 任务栏橙色闪动）
    flashTray: function () {
        ipcRenderer.send('tray:flash');
    },
    // ===== 阶段三十七（第四期·增强）：托盘悬停预览面板（面板页与主窗口共用本 preload） =====
    // 面板页拉取当前未读明细（兜底，正常由主进程显示前推送）
    getTrayUnread: function () {
        return ipcRenderer.invoke('tray:get-unread');
    },
    // 面板页订阅主进程推送的最新未读明细
    onTrayUnreadPush: function (callback) {
        ipcRenderer.on('tray:unread-push', function (event, data) {
            callback(data);
        });
    },
    // 面板条目点击：请求主进程恢复主窗口并跳转对应会话
    openConv: function (target) {
        ipcRenderer.send('tray:open-conv', target);
    },
    // 面板请求隐藏（鼠标移出面板时）
    hidePanel: function () {
        ipcRenderer.send('tray:hide-panel');
    },
    // 主聊天窗口订阅：托盘面板点击跳转会话（主进程转发 target）
    onOpenConv: function (callback) {
        ipcRenderer.on('tray:open-conv', function (event, target) {
            callback(target);
        });
    },
    // ===== 阶段三十八：图片查看器窗口（查看器页与主窗口共用本 preload） =====
    // 请求打开查看器：data = {url, list, index}（list 为当前会话全部图片 URL，支持翻页/缩略图）
    openImageViewer: function (data) {
        ipcRenderer.send('image:open', data);
    },
    // 查看器页订阅主进程推送的图片数据
    onViewerLoad: function (callback) {
        ipcRenderer.on('viewer:load', function (event, data) {
            callback(data);
        });
    },
    // 查看器置顶切换
    setViewerAlwaysOnTop: function (on) {
        ipcRenderer.send('image:set-always-on-top', on);
    },
    // 查看器隐藏（Esc/关闭按钮，窗口复用不销毁）
    closeViewer: function () {
        ipcRenderer.send('image:close');
    },
    // 另存为：data = {dataUrl, name}，主进程弹原生保存对话框后写文件
    saveViewerImage: function (data) {
        return ipcRenderer.invoke('image:save', data);
    },
    // 查看器请求更早历史图片（查看器 → 主窗口拉取 → 主进程回推 viewer:more）
    viewerNeedMore: function () {
        ipcRenderer.send('image:need-more');
    },
    // 主聊天窗口订阅：查看器的更早图片请求（主进程转发）
    onViewerNeedMore: function (callback) {
        ipcRenderer.on('viewer:need-more', function () {
            callback();
        });
    },
    // 主聊天窗口推送一批更早历史图片给查看器
    pushViewerImages: function (urls) {
        ipcRenderer.send('image:more', urls);
    },
    // 查看器订阅：主窗口推送的更早历史图片列表
    onViewerMore: function (callback) {
        ipcRenderer.on('viewer:more', function (event, urls) {
            callback(urls);
        });
    },
    // 退出全屏冻结态（截图编辑完成/取消后调用，主进程恢复普通窗口与层级）
    exitFreeze: function () {
        ipcRenderer.send('shot:exit-freeze');
    },
    // 主进程抓屏完成推送（窗口仍透明期间，渲染层预加载冻结编辑器）
    onShotPrepare: function (callback) {
        ipcRenderer.on('shot:prepare', function (event, dataUrl) {
            callback(dataUrl);
        });
    },
    // 冻结编辑器首帧就绪通知（主进程收到后揭幕：透明度归位，用户看到的第一帧即冻结画面）
    shotReady: function () {
        ipcRenderer.send('shot:ready');
    },
    // ===== 阶段六十：Agent 本地执行器 =====
    // 渲染进程桥接：服务端下发的本地执行请求转发主进程执行（req = {username, tool, params}）
    // 返回 Promise<{ok, output}>，结果由渲染进程经 WS 回传服务端
    agentExec: function (req) {
        return ipcRenderer.invoke('agent:exec', req);
    },
    // ===== 阶段七十五：本地命令输出流（run_command 实时控制台） =====
    // 主进程推送输出帧 {chunk,total_bytes,over,final,exit_code,duration_ms}，渲染层盖 task_id/step 戳后经 WS 上行服务端
    onAgentOutput: function (callback) {
        ipcRenderer.on('agent:output', function (event, frame) {
            callback(frame);
        });
    },
    // 长命令"转后台"请求（服务端下行 msg 61 桥接至执行器，命中后命令立即返回、进程继续）
    agentBg: function (username) {
        ipcRenderer.send('agent:bg', { username: username });
    },
    // ===== 阶段七十六：工作区文件面板操作（web 右侧文件树/预览/编辑） =====
    // 渲染进程桥接：服务端下发的文件操作转发主进程执行（req = {username, op, path, content, req_id}）
    // 返回 Promise<{ok, error?, root?, entries?/content?, binary?, truncated?}>，结果由渲染进程经 WS 回传服务端
    workspaceOp: function (req) {
        return ipcRenderer.invoke('agent:fileop', req);
    },
    // 克隆进度多帧（proj_clone 专用）：主进程推送 {req_id,pct,stage,speed,sent}，渲染层转发 65 progress 帧到服务端
    onWorkspaceProgress: function (callback) {
        ipcRenderer.on('agent:fileop-progress', function (event, frame) {
            callback(frame);
        });
    },
    // ===== 阶段七十八：克隆 Token 记忆（safeStorage 按 host 加密存本机，渲染层经 WS 面板请求场景调用） =====
    tokenGet: function (host) {
        return ipcRenderer.invoke('agent:token-get', { host: host });
    },
    tokenSet: function (host, token) {
        return ipcRenderer.invoke('agent:token-set', { host: host, token: token });
    },
    // ===== 阶段八十一：SSH 快连簿（PC 本地存 host/port/user，无密码） =====
    sshList: function () {
        return ipcRenderer.invoke('agent:ssh-list');
    },
    sshSave: function (req) {
        return ipcRenderer.invoke('agent:ssh-save', req);
    },
    sshDel: function (req) {
        return ipcRenderer.invoke('agent:ssh-del', req);
    },
    // ===== 阶段七十七：控制台本地终端（Trae CN 同款多标签） =====
    // 手敲命令本地执行（纯本地环路不经服务端）：req={username, action:'open'|'input'|'stop'|'close', term_id, cmd?}
    // 返回同步受理结果 Promise<{ok, error?, cwd?}>；输出/退出帧经 onTermEvent 推送
    // {term_id, type:'out'|'exit', chunk?, total_bytes?, over?, exit_code?, duration_ms?, cwd?}
    termOp: function (req) {
        return ipcRenderer.invoke('agent:term', req);
    },
    onTermEvent: function (callback) {
        ipcRenderer.on('agent:term-event', function (event, frame) {
            callback(frame);
        });
    },
    // ===== 阶段六十一：用户自选工作区/沙箱白名单 =====
    // 原生目录选择对话框（返回所选目录绝对路径，取消返回空串）
    sandboxChoose: function (title) {
        return ipcRenderer.invoke('sandbox:choose', title);
    },
    // 拉取当前用户沙箱配置（Promise<{primary, dirs}>）
    sandboxGet: function (username) {
        return ipcRenderer.invoke('sandbox:get', username);
    },
    // 保存沙箱配置（payload = {username, primary, dirs}，返回 Promise<{ok, cfg}>）
    sandboxSave: function (payload) {
        return ipcRenderer.invoke('sandbox:save', payload);
    },
    // ===== 阶段九十：用户自定义 MCP 服务器（本机 stdio，配置与凭据仅存本机） =====
    // 拉取当前用户的 MCP 服务器配置（Promise<{servers:[{name,command,args,env,enabled}]}>）
    mcpGet: function (username) {
        return ipcRenderer.invoke('mcp:get', username);
    },
    // 保存配置（payload = {username, servers}，返回 Promise<{ok, servers?}>；保存即重建本机会话）
    mcpSave: function (payload) {
        return ipcRenderer.invoke('mcp:save', payload);
    },
    // 删除单个服务器（payload = {username, name}，返回 Promise<{ok}>）
    mcpDel: function (payload) {
        return ipcRenderer.invoke('mcp:del', payload);
    },
    // 测试连接（cfg = {name, command, args, env}，返回 Promise<{ok, tools?, elapsed_ms?, server_name?, msg?}>）
    mcpTest: function (cfg) {
        return ipcRenderer.invoke('mcp:test', cfg);
    },
    // 会话状态+工具清单快照（Promise<{tools:[{server,tool,description,input_schema}], status:[{name,status,status_msg,tool_count}]}>）
    mcpSyncState: function (username) {
        return ipcRenderer.invoke('mcp:sync-state', username);
    },
    // ===== 阶段一百一十三：uv 工具链自动安装（Python 系插件依赖；状态查询/触发安装） =====
    mcpUvStatus: function () {
        return ipcRenderer.invoke('mcp:uv-status');
    },
    mcpUvInstall: function () {
        return ipcRenderer.invoke('mcp:uv-install');
    },
    // ===== 阶段一百二十一：工具链市场（[工具链] 页签一键安装/状态查询；复用 toolchain-manager 三通道下载） =====
    toolchainInstall: function (payload) {
        return ipcRenderer.invoke('toolchain:install', payload);
    },
    toolchainStatus: function (payload) {
        return ipcRenderer.invoke('toolchain:status', payload || {});
    },
    // ===== 阶段一百一十四：内置 Computer Use 开关（payload = {enabled}，返回 Promise<{ok, enabled}>） =====
    mcpBuiltinToggle: function (payload) {
        return ipcRenderer.invoke('mcp:builtin-toggle', payload);
    },
    mcpProjectStatus: function (payload) {
        return ipcRenderer.invoke('mcp:project-status', payload); // 阶段一百一十六：项目级 MCP 状态（含自动创建 .im/agent_mcp.json）
    },
    mcpProjectToggle: function (payload) {
        return ipcRenderer.invoke('mcp:project-toggle', payload); // 阶段一百一十六：项目级 MCP 开关切换
    },
    // ===== 阶段七十七：自定义标题栏（Electron titleBarOverlay）=====
    // 主题切换时同步原生窗口按钮配色（浅色 #f5f5f5/#333333，深色 #1a1a1a/#e0e0e0，与 style.css --titlebar-* 同值）
    // 阶段一百三十四：新增第三参 bg——窗口背景填充色（最大化/还原重绘空窗期 DWM 填充用，深色 #111111/浅色 #f5f5f5，
    // 与 style.css --bg 同值），主进程据此 setBackgroundColor 消除深色主题闪白（原实现：仅传按钮配色两参）
    // setTitlebarColors: function (color, symbolColor) {
    //     return ipcRenderer.invoke('titlebar:overlay', { color: color, symbolColor: symbolColor });
    // },
    setTitlebarColors: function (color, symbolColor, bg) {
        return ipcRenderer.invoke('titlebar:overlay', { color: color, symbolColor: symbolColor, bg: bg });
    },

    // ===== 阶段一百三十四：主题持久化（主进程可读，深色启动底色根治）=====
    // 主题变更上报主进程落盘（userData/im_theme.json），下次启动 createWindow 直接按主题深浅设置
    // 窗口背景/按钮初值，消除深色主题下启动早期短暂浅色底（浏览器/手机 APP 无 desktop 桥自动旁路）
    syncTheme: function (theme) {
        return ipcRenderer.send('theme:sync', theme);
    },

    // ===== 阶段九十一：内置浏览器（TRAE CN 同款浏览区）=====
    // 面板显隐（agent 工具链路在主进程侧自动展开；渲染层按钮显式开关走这里）
    browserPanel: function (visible) {
        return ipcRenderer.invoke('browser:panel', visible);
    },
    // ===== 阶段一百三十四：独立文档查看器窗口 =====
    // 主窗口调用：打开/复用文档查看器窗口并载入 {url, name}（相对 URL 由主进程归一化）
    openDocViewer: function (payload) {
        ipcRenderer.send('doc:open', payload);
    },
    // 以下四个仅供 doc-viewer.html 页内使用
    onDocLoad: function (callback) {
        ipcRenderer.on('doc:load', function (event, data) {
            callback(data);
        });
    },
    docSetTop: function (on) {
        ipcRenderer.send('doc:set-always-on-top', !!on);
    },
    docClose: function () {
        ipcRenderer.send('doc:close');
    },
    docSave: function (payload) {
        return ipcRenderer.invoke('doc:save', payload);
    },
    // 导航操作（action: back/forward/reload/stop/goto；goto 时带 url）
    browserNav: function (action, url) {
        return ipcRenderer.invoke('browser:nav', { action: action, url: url });
    },
    // 标签页切换/关闭
    browserSelect: function (tabId) {
        return ipcRenderer.invoke('browser:select', tabId);
    },
    browserCloseTab: function (tabId) {
        return ipcRenderer.invoke('browser:closetab', tabId);
    },
    // 阶段九十四：标签右键菜单批量操作（关闭其他/右侧/全部、移动、固定切换、系统浏览器打开）
    browserTabsOp: function (op, tabId, arg) {
        return ipcRenderer.invoke('browser:tabs-op', { op: String(op || ''), tab_id: String(tabId || ''), url: String(arg || '') });
    },
    // CDP 远程调试端口（Chrome DevTools Protocol）读写（0=关闭；改动需重启客户端生效）
    browserCdpGet: function () {
        return ipcRenderer.invoke('browser:cdp-get');
    },
    browserCdpSet: function (port) {
        return ipcRenderer.invoke('browser:cdp-set', port);
    },
    // 浏览区状态推送（主进程 → 渲染层：tab 列表/活动页/加载态/导航可用性/cdp_port）
    onBrowserState: function (callback) {
        ipcRenderer.on('browser:state', function (event, state) {
            callback(state);
        });
    },
    // ===== 阶段九十二：文件查看归口（工作区文件/diff/审查报告统一进浏览区标签，TRAE CN 化） =====
    // 打开工作区文件查看标签：req = {username, path}（工作区相对路径，主进程 safePath 校验后读盘注入）
    browserOpenFile: function (req) {
        return ipcRenderer.invoke('browser:open-file', req);
    },
    // 打开直传内容标签（git diff/提交详情/审查报告等不经磁盘内容）：
    // payload = {kind:'diff'|'commit'|'md'|'text', title, content, meta?}
    browserOpenData: function (payload) {
        return ipcRenderer.invoke('browser:open-data', payload);
    },
    // ===== 阶段九十二（DOM 化 viewer）：file 标签由主页面同源 iframe 承载（不再走原生视图），
    // 主页面作为宿主负责建框/显隐/转发 payload，并提供保存/脏标记桥接 =====
    // 宿主代 viewer 页保存（主进程路径校验归口不变）
    browserFileSave: function (tabId, content) {
        return ipcRenderer.invoke('browser:file-save', { tab_id: String(tabId || ''), content: String(content != null ? content : '') });
    },
    // 宿主代 viewer 页上报脏标记（编辑未保存）
    browserViewerDirty: function (tabId, dirty) {
        ipcRenderer.send('browser:viewer-dirty', { tab_id: String(tabId || ''), dirty: !!dirty });
    },
    // 阶段一百三十八：file iframe 就绪补拉 payload（页面刷新/重登后 iframe 重建，
    // 主进程按 tab_id 重推 lastPayload，修复活动文件标签空白须重开文件的问题）
    browserFileReload: function (tabId) {
        return ipcRenderer.invoke('browser:file-reload', { tab_id: String(tabId || '') });
    },
    // ===== 阶段一百：任务变更保留/撤销（viewer 页"任务已修改"条按钮桥接——此前缺失导致按钮点击无反应） =====
    // 保留变更：接受当前磁盘内容（主进程删备份+清索引）
    browserTaskKeep: function (tabId) {
        return ipcRenderer.invoke('browser:task-keep', { tab_id: String(tabId || '') });
    },
    // 撤销变更：还原任务前字节（主进程读备份回写+重读盘刷新页面）
    browserTaskRevert: function (tabId) {
        return ipcRenderer.invoke('browser:task-revert', { tab_id: String(tabId || '') });
    },
    // 订阅 file 标签 payload 推送（主进程 → 渲染层：{tab_id, payload}，iframe 分发）
    onFileLoad: function (callback) {
        ipcRenderer.on('browser:file-load', function (event, data) {
            callback(data);
        });
    },
    // 阶段九十三：分栏拖拽已无需主进程配合（web 标签同样由 DOM webview 承载，
    // 拖拽期以 CSS pointer-events 屏蔽 guest 鼠标，见 style.css browser-resizing）
    // ===== 阶段九十三：web 标签 <webview> 就绪上报 =====
    // 渲染层按 state 建 webview 后 dom-ready 上报宿主 webContents id
    // （主进程经 webContents.fromId 挂事件/执行导航与 Agent 工具）
    browserWvReady: function (tabId, wcId) {
        ipcRenderer.send('browser:wv-ready', { tab_id: String(tabId || ''), wc_id: parseInt(wcId, 10) || 0 });
    },
    // viewer 页保存成功通知（主进程 → 渲染层：{path}，用于刷新文件树与 git 装饰）
    onFileSaved: function (callback) {
        ipcRenderer.on('browser:file-saved', function (event, info) {
            callback(info);
        });
    },
    // ===== 阶段一百三十：本地 LSP 悬停（gopls/clangd/pyright 真实类型推导，TRAE 同构） =====
    // req = {tab_id, text, line, character}（页面不持有绝对路径，主进程按 tab_id → tab.filePath 归口；
    // 行列零基 LSP 坐标）。返回 Promise<{markdown, range} | null>，超时/未装服务器返回 null 由 viewer 页回落静态表
    lspHover: function (req) {
        return ipcRenderer.invoke('lsp:hover', req || {});
    }
});
