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
    // 阶段一百三十九：可选参数 hideMain——截图时是否隐藏主窗口画面（QQ 同款"隐藏当前窗口"
    // 开关，undefined 时主进程走自身状态，Alt+A 全局截图同源）
    captureScreen: function (hideMain) {
        return ipcRenderer.invoke('shot:capture', hideMain);
    },
    // 阶段一百三十九：渲染层同步"截图时隐藏主窗口画面"开关到主进程（截图按钮下拉菜单切换；
    // 同步后 Alt+A 全局截图行为一致，避免两入口状态分叉）
    setShotHideMain: function (on) {
        ipcRenderer.send('shot:hide-main-set', on);
    },
    // 阶段一百三十九：QQ 同款窗口识别——冻结截图悬停命中测试（x,y 传物理屏幕坐标，
    // 返回 {left,top,right,bottom} 窗口物理矩形或 null；主进程 PowerShell 子进程 Win32 查询）
    shotWindowAt: function (x, y) {
        return ipcRenderer.invoke('shot:window-at', x, y);
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
    // 阶段一百五十四：窗口最小化/隐藏状态订阅（主进程 minimize/restore/hide/show 与页面加载完成时推送）
    // Electron Windows 禁用原生遮挡计算后 document.hidden 恒为 false，页面消息提示音据此判定窗口不可见
    onWinState: function (callback) {
        ipcRenderer.on('pc:win-state', function (event, data) {
            callback(data);
        });
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
    // 阶段一百五十九：P2P 接收文件静默落盘（data = {username, msg_id, name, buf(ArrayBuffer)}，
    // 主进程写 %APPDATA%/<应用名>/received_files/<账号>/<消息ID>_<文件名>，返回 {ok, path}）
    saveP2PFile: function (data) {
        return ipcRenderer.invoke('p2pfile:save', data);
    },
    // 阶段一百五十九：读取 P2P 本地缓存文件（data = {username, msg_id, name}，返回 {ok, buf(Uint8Array), size, name}）
    readP2PFile: function (data) {
        return ipcRenderer.invoke('p2pfile:read', data);
    },
    // 阶段一百五十九补：清空 P2P 磁盘缓存目录（data = {username}，返回 {ok, count}）
    clearP2PFiles: function (data) {
        return ipcRenderer.invoke('p2pfile:clear', data);
    },
    // 阶段一百五十九补：查询落盘目录（data = {username}，返回 {ok, dir, custom}）
    getP2PDir: function (data) {
        return ipcRenderer.invoke('p2pfile:getDir', data);
    },
    // 阶段一百五十九补：设置自定义落盘目录（data = {dir, username}，dir 空串=恢复默认，返回 {ok, dir, custom, err?}）
    setP2PDir: function (data) {
        return ipcRenderer.invoke('p2pfile:setDir', data);
    },
    // 阶段一百五十九补：弹出原生目录选择对话框（返回 {ok, dir?}）
    pickP2PDir: function () {
        return ipcRenderer.invoke('p2pfile:pickDir');
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
    // ===== 阶段一百三十九：QQ 同款录屏（Ctrl+Alt+R / 截图菜单入口） =====
    // 录制启动主窗口退场：退全屏恢复原位（leave-full-screen 链路）+ 隐藏窗口，返回 Promise
    recBegin: function () {
        return ipcRenderer.invoke('rec:begin');
    },
    // 屏幕源 id（主进程 desktopCapturer 匹配主屏，渲染层 getUserMedia desktop 流用）
    recSource: function () {
        return ipcRenderer.invoke('rec:source');
    },
    // 录制结束主窗口归位（show + focus）
    recShow: function () {
        ipcRenderer.send('rec:show');
    },
    // 录制状态同步（主进程按此切换 Ctrl+Alt+R 的 开始/停止 语义）
    recActive: function (on) {
        ipcRenderer.send('rec:active', !!on);
    },
    // Ctrl+Alt+R 全局快捷键订阅（data = {action:'start'|'stop'}）
    onGlobalRecord: function (callback) {
        ipcRenderer.on('rec:global-ctrl', function (event, data) {
            callback(data);
        });
    },
    // 实际生效的录屏快捷键标签（Ctrl+Alt+R / 回退 Ctrl+Shift+R / 空串=无全局键），菜单与 toast 文案同步用
    recShortcut: function () {
        return ipcRenderer.invoke('rec:shortcut');
    },
    // ===== 阶段一百三十九：QQ 同款长截图（冻结选区 → 悬浮小工具条 → 滚动拼接） =====
    // 长截图启动：主窗口隐藏 + 独立无边框条窗显示工具条（缩条方案 overlay 按钮遮挡工具条，已弃用），selPx = 选区物理像素
    stitchBegin: function (selPx) {
        return ipcRenderer.invoke('stitch:begin', selPx);
    },
    // 长截图状态文本转发：主窗口渲染层 → 主进程 → 条窗显示（updateStitchStatus 内调用）
    stitchBarStatus: function (text) {
        ipcRenderer.send('stitch:bar-status', String(text || ''));
    },
    // 长截图条窗按钮动作订阅（主窗口渲染层）：act = 'complete' | 'cancel'
    onStitchBarAction: function (callback) {
        ipcRenderer.on('stitch:bar-action', function (event, act) {
            callback(act);
        });
    },
    // 条窗侧：接收主窗口转发的状态文本
    onBarStatus: function (callback) {
        ipcRenderer.on('stitch:bar-status', function (event, text) {
            callback(text);
        });
    },
    // 条窗侧：按钮动作上报（完成/取消/Esc），主进程转主窗口渲染层执行
    barAction: function (act) {
        ipcRenderer.send('stitch:bar-action', act === 'complete' ? 'complete' : 'cancel');
    },
    // 长截图结束：主窗口恢复普通聊天窗口（原位/最大化态/层级）
    stitchFinish: function () {
        ipcRenderer.send('stitch:finish');
    },
    // ===== 阶段一百四十：截图编辑器独立窗口（主窗口 + 编辑器窗口共用本 preload） =====
    // 主窗口侧：请求打开独立编辑器窗口（data = {dataUrl, mode:'freeze'|'open'|'record', callback}）
    openEditor: function (data) {
        ipcRenderer.send('editor:open', data);
    },
    // 主窗口侧：编辑器确认完成回传（data = {dataUrl, callback}，按 callback 分发待发送条/直接发送）
    onEditorDone: function (callback) {
        ipcRenderer.on('editor:done', function (event, data) {
            callback(data);
        });
    },
    // 主窗口侧：编辑器取消/关窗通知（清残留焦点等收尾）
    onEditorCancel: function (callback) {
        ipcRenderer.on('editor:cancel', function () {
            callback();
        });
    },
    // 主窗口侧：长截图移交（data = {sel, snapW, snapH}，选区为冻结底图物理像素）
    onEditorStitch: function (callback) {
        ipcRenderer.on('editor:stitch', function (event, data) {
            callback(data);
        });
    },
    // 主窗口侧：录屏选区启动（倒计时结束，data = {sel, snapW, snapH}）
    onEditorRecStart: function (callback) {
        ipcRenderer.on('editor:rec-start', function (event, data) {
            callback(data);
        });
    },
    // 编辑器窗口侧：接收编辑任务（data = {dataUrl, mode, callback}）
    onEditorLoad: function (callback) {
        ipcRenderer.on('editor:load', function (event, data) {
            callback(data);
        });
    },
    // 编辑器窗口侧：首帧就绪（主进程据此显示全屏冻结窗口，避免底色闪现）
    editorReady: function () {
        ipcRenderer.send('editor:ready');
    },
    // 编辑器窗口侧：确认完成（dataUrl 为选区裁剪结果）
    editorDone: function (dataUrl) {
        ipcRenderer.send('editor:done', { dataUrl: dataUrl });
    },
    // 编辑器窗口侧：取消/关闭（主进程恢复主窗口）
    editorCancel: function () {
        ipcRenderer.send('editor:cancel');
    },
    // 图片查看器侧：编辑并发送（查看器抓图转 dataURL 后请求打开 open 模式编辑器，确认直接发当前会话）
    viewerEdit: function (data) {
        ipcRenderer.send('viewer:edit', data);
    },
    // 编辑器窗口侧：长截图移交（sel 为冻结底图物理像素选区，snapW/snapH 为底图物理分辨率）
    editorStitch: function (sel, snapW, snapH) {
        ipcRenderer.send('editor:stitch', { sel: sel, snapW: snapW, snapH: snapH });
    },
    // 编辑器窗口侧：录屏倒计时结束（主进程隐藏编辑器并转主窗口启动录制）
    editorRecStart: function (sel, snapW, snapH) {
        ipcRenderer.send('editor:rec-start', { sel: sel, snapW: snapW, snapH: snapH });
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
    // ===== 阶段一百四十四三期：公告链接型独立窗体 =====
    // 主窗口调用：新建/复用独立 BrowserWindow 打开 http(s) 网址（单例复用，重复点击仅导航+聚焦）
    openAnnLink: function (url) {
        return ipcRenderer.invoke('ann:open-link', url);
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
    // ===== 阶段一百四十一：音视频通话（主窗口 / 通话窗 / 响铃条 三方共用本 preload） =====
    // —— 主窗口侧（chat.js）——
    // 打开/复用通话窗（data = {role:'caller'|'callee', call_id, peer, peer_name, peer_avatar, self_name, self_avatar, call_type}）
    callOpen: function (data) {
        ipcRenderer.send('call:open', data);
    },
    // 来电弹响铃条（data = {call_id, from, from_name, from_avatar, call_type}）
    callRing: function (data) {
        ipcRenderer.send('call:ring', data);
    },
    // 隐藏响铃条（接听/拒绝/超时/对端取消/其他设备已接）
    callRingHide: function () {
        ipcRenderer.send('call:ring-hide');
    },
    // 下行信令转发（主窗口 → 主进程 → 通话窗/响铃条，frame 为完整协议帧）
    callSignalIn: function (frame) {
        ipcRenderer.send('call:signal-in', frame);
    },
    // 主窗口订阅：通话窗/响铃条上行信令（chat.js 经 WS 发出）
    onCallSend: function (callback) {
        ipcRenderer.on('call:send', function (event, frame) {
            callback(frame);
        });
    },
    // 主窗口订阅：响铃条按钮动作（data = {action:'accept'|'decline', call_id}）
    onCallRingAction: function (callback) {
        ipcRenderer.on('call:ring-action', function (event, data) {
            callback(data);
        });
    },
    // 主窗口订阅：通话窗已关闭（清本端通话态）
    onCallClosed: function (callback) {
        ipcRenderer.on('call:closed', function () {
            callback();
        });
    },
    // —— 通话窗侧（call-page.js）——
    // 接收通话任务（data 同 callOpen）
    onCallLoad: function (callback) {
        ipcRenderer.on('call:load', function (event, data) {
            callback(data);
        });
    },
    // 接收下行信令（frame 为完整协议帧，页面按 call_id/action 自行过滤）
    onCallSignal: function (callback) {
        ipcRenderer.on('call:signal', function (event, frame) {
            callback(frame);
        });
    },
    // 窗体关闭转挂断语义（Alt+F4/点关闭 → 页面收口挂断信令后自行 callClose）
    onCallWindowClose: function (callback) {
        ipcRenderer.on('call:window-close', function () {
            callback();
        });
    },
    // 上行信令（frame 为完整协议帧，主进程转主窗口经 WS 发出）
    callSend: function (frame) {
        ipcRenderer.send('call:send', frame);
    },
    // 阶段一百五十一补丁：会议共享期间窗口内容保护开关（防"窗口套窗口"递归画面，
    // 走 Windows WDA_EXCLUDEFROMCAPTURE——捕获 API 看不到本窗口但本地正常显示）
    setShareProtected: function (on) {
        ipcRenderer.send('call:share-protect', !!on);
    },
    // 阶段一百五十一补丁：会议窗最小化到任务栏（无边框窗页面自绘按钮）
    callMinimize: function () {
        ipcRenderer.send('call:minimize');
    },
    // 页面收口完成：销毁通话窗（挂断信令已发出）
    callClose: function () {
        ipcRenderer.send('call:close');
    },
    // ===== 阶段一百五十五：远程协助（主窗口 / 观看窗 两方共用本 preload） =====
    // —— 主窗口侧（chat.js）——
    // 打开/复用观看窗（data = {session_id, peer, peer_name, grant, screen:{w,h}}）
    remoteOpen: function (data) {
        ipcRenderer.send('remote:open', data);
    },
    // 下行媒体信令转发（主窗口 → 主进程 → 观看窗，frame 为完整协议帧；加载期间主进程缓冲回放）
    remoteSignalIn: function (frame) {
        ipcRenderer.send('remote:signal-in', frame);
    },
    // 主窗口订阅：观看窗上行信令（chat.js 经 WS 发出）
    onRemoteSend: function (callback) {
        ipcRenderer.on('remote:send', function (event, frame) {
            callback(frame);
        });
    },
    // 主窗口订阅：观看窗已关闭（清本端协助态）
    onRemoteClosed: function (callback) {
        ipcRenderer.on('remote:closed', function () {
            callback();
        });
    },
    // —— 观看窗侧（remote-page.js）——
    // 接收协助任务（data 同 remoteOpen）
    onRemoteLoad: function (callback) {
        ipcRenderer.on('remote:load', function (event, data) {
            callback(data);
        });
    },
    // 接收下行信令（frame 为完整协议帧，页面按 session_id/action 自行过滤）
    onRemoteSignal: function (callback) {
        ipcRenderer.on('remote:signal', function (event, frame) {
            callback(frame);
        });
    },
    // 窗体关闭转断开语义（Alt+F4/点关闭 → 页面收口 disconnect 信令后自行 remoteClose）
    onRemoteClose: function (callback) {
        ipcRenderer.on('remote:window-close', function () {
            callback();
        });
    },
    // 上行信令（frame 为完整协议帧，主进程转主窗口经 WS 发出）
    remoteSend: function (frame) {
        ipcRenderer.send('remote:send', frame);
    },
    // 页面收口完成：销毁观看窗（disconnect 信令已发出）
    remoteClose: function () {
        ipcRenderer.send('remote:close');
    },
    // 被控端：输入注入事件上行（DataChannel 收到的鼠标/键盘事件 → 主进程 PowerShell SendInput；
    // grant=view 时 remote-engine.js 已丢弃，此处仅透传）
    remoteInputSend: function (evt) {
        ipcRenderer.send('remote:input', evt);
    },
    // —— 被控端悬浮条侧（remote-bar.html / 主窗口 chat.js 三方共用）——
    // 打开/复用悬浮条（data = {peer, peer_name, grant}）
    remoteBarOpen: function (data) {
        ipcRenderer.send('remote:bar-open', data);
    },
    // 关闭悬浮条（remoteEndLocal 收口归口）
    remoteBarClose: function () {
        ipcRenderer.send('remote:bar-close');
    },
    // 悬浮条侧：接收条数据（对方名 + 模式文案）
    onRemoteBarLoad: function (callback) {
        ipcRenderer.on('remote:bar-load', function (event, data) {
            callback(data);
        });
    },
    // 悬浮条断开按钮上行（主进程转主窗口）
    remoteBarDisconnect: function () {
        ipcRenderer.send('remote:bar-disconnect');
    },
    // 主窗口订阅：悬浮条按钮动作（data = {action:'disconnect'}）
    onRemoteBarAction: function (callback) {
        ipcRenderer.on('remote:bar-action', function (event, data) {
            callback(data);
        });
    },
    // ===== 阶段一百四十四：会议（会中邀请桥，主窗口/会议窗 两方共用） =====
    // 会议窗侧：请求主窗口弹选人弹窗（data = {call_id, call_type, group_id, members:[已在会账号]}）
    meetInviteAsk: function (data) {
        ipcRenderer.send('meet:invite-ask', data);
    },
    // 主窗口侧订阅：会议窗邀请请求（chat.js 弹会议选人弹窗，归口上行 meet_invite）
    onMeetInviteAsk: function (callback) {
        ipcRenderer.on('meet:invite-ask', function (event, data) {
            callback(data);
        });
    },
    // —— 响铃条侧（call-ring.js）——
    // 接收来电信息
    onRingShow: function (callback) {
        ipcRenderer.on('call:ring:show', function (event, data) {
            callback(data);
        });
    },
    // 按钮/超时动作上报（data = {action:'accept'|'decline', call_id}）
    callRingAction: function (data) {
        ipcRenderer.send('call:ring-action', data);
    },
    // 响铃条自隐藏（超时/对端取消/其他设备已接，无需主窗口发信令）
    callRingSelfHide: function () {
        ipcRenderer.send('call:ring-hide');
    },
    // 响铃停止通知（主进程隐藏响铃条时推送：窗口 hide 后渲染层无法自感知，页面据此停铃重置）
    onRingStop: function (callback) {
        ipcRenderer.on('call:ring:stop', function () {
            callback();
        });
    },
    // ===== 阶段一百三十：本地 LSP 悬停（gopls/clangd/pyright 真实类型推导，TRAE 同构） =====
    // req = {tab_id, text, line, character}（页面不持有绝对路径，主进程按 tab_id → tab.filePath 归口；
    // 行列零基 LSP 坐标）。返回 Promise<{markdown, range} | null>，超时/未装服务器返回 null 由 viewer 页回落静态表
    lspHover: function (req) {
        return ipcRenderer.invoke('lsp:hover', req || {});
    }
});
