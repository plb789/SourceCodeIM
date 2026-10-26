// preload.js - 预加载脚本：暴露桌面端原生能力给渲染进程
// 阶段三十七（第三期）：新增静默抓屏（desktopCapturer）与 Alt+A 全局快捷键结果订阅
const { contextBridge, ipcRenderer } = require('electron');

// 阶段一百二十二：服务端地址注入已移除（原 app:// 方案经 additionalArguments 传 serverOrigin 供
// socket.js 拼 ws 地址；同 origin http 拦截方案下 origin 不变，socket.js 按 location 推导即可）

contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    // 阶段六十六：系统桌面通知（Agent 任务完结提醒等场景），转发主进程弹系统通知
    // avatar：好友头像地址（/static/upload/xxx 或绝对 URL），主进程下载作通知大图，缺失回退应用图标
    notify: function (title, body, avatar) {
        ipcRenderer.send('notify', { title: title, body: body, avatar: avatar || '' });
    },
    // 阶段一百九十四：桌面通知点击订阅（主进程点击转发 → 渲染层直达任务归属会话；无回调则忽略）
    onNotifyClick: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('desktop-notify-click', function () { cb(); });
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
    // ===== 阶段一百六十五：网盘挂载（WinFsp+rclone 盘符映射，阿里云盘挂载盘同原理；仅 PC 端生效）=====
    // 状态查询（返回 {ok, winfsp, engineReady, msiReady, mounted, letter, enabled, username, letters:{used,free}}）
    getDavStatus: function () {
        return ipcRenderer.invoke('dav:status');
    },
    // 挂载为本地盘符（data = {username, dav_password, letter}，返回 {ok, letter?} 或 {ok:false, err}）
    davMount: function (data) {
        return ipcRenderer.invoke('dav:mount', data);
    },
    // 卸载盘符（返回 {ok}）
    davUnmount: function () {
        return ipcRenderer.invoke('dav:unmount');
    },
    // WinFsp 组件静默安装（UAC 提权由用户确认，返回 {ok} 或 {ok:false, err}）
    davWinfspInstall: function () {
        return ipcRenderer.invoke('dav:winfsp-install');
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
    // ===== 会议录制本地写盘（腾讯会议同款本地录制：文件只保存本地） =====
    // 开始录制：主进程弹保存对话框（data = {name: 默认文件名}），返回 {ok, path?, canceled?, err?}
    recMeetStart: function (data) {
        return ipcRenderer.invoke('rec:meet-start', data);
    },
    // 分片落盘（chunk: Uint8Array，MediaRecorder 1s 一片实时写，异常退出不丢已录内容）
    recMeetWrite: function (chunk) {
        return ipcRenderer.invoke('rec:meet-write', chunk);
    },
    // 收口录制：关写流，返回 {ok, path}
    recMeetEnd: function () {
        return ipcRenderer.invoke('rec:meet-end');
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
    // ===== 阶段二百九十三：内置浏览器工具开关（payload = {enabled}，返回 Promise<{ok, enabled}>） =====
    mcpBrowserToggle: function (payload) {
        return ipcRenderer.invoke('mcp:browser-toggle', payload);
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

    // ===== 禁用硬件加速开关（设置-外观-性能；Win10 老显卡驱动黑屏假死自救）=====
    // 状态持久化主进程 userData/im_hwaccel.json，主进程 app ready 前读取生效——切换后重启客户端生效
    // hwAccelGet 返回 { disabled: 本次启动是否已禁用 }（浏览器/手机 APP 无 desktop 桥自动旁路）
    hwAccelGet: function () {
        return ipcRenderer.invoke('hwaccel:get');
    },
    hwAccelSet: function (disabled) {
        ipcRenderer.send('hwaccel:set', !!disabled);
    },

    // ===== TAP 虚拟网卡驱动（设置-网络-虚拟网络；tapinstall 静默装/卸，UAC 由用户确认）=====
    // tapGet 返回 { installed, available }（真实驱动状态归口，页面开关回显以此为准）
    // tapInstall/tapRemove 返回 { ok, installed, err? }（提权执行后复查实际状态）
    // onTapPrompt：主进程启动检测到未安装时推送安装引导（页面弹自定义确认弹窗）
    tapGet: function () {
        return ipcRenderer.invoke('tap:get');
    },
    tapInstall: function () {
        return ipcRenderer.invoke('tap:install');
    },
    tapRemove: function () {
        return ipcRenderer.invoke('tap:remove');
    },
    onTapPrompt: function (callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('tap:prompt', function (event, data) { callback(data || {}); });
        }
    },

    // ===== p2p-host 启动器（联机虚拟网卡路线；生命周期归口 main.js p2pHost 块）=====
    // p2pHostStart 参数 {vip_ip, vip_mac, comm, comm_key, supernodes:[...]}——收集自登录回执（localStorage）
    // 与房间信令（comm/comm_key/supernodes）；onP2pHostStatus 全窗状态推送（启动/停止/异常退出）
    p2pHostStart: function (params) {
        return ipcRenderer.invoke('p2p-host:start', params);
    },
    p2pHostStop: function (reason) {
        return ipcRenderer.invoke('p2p-host:stop', reason);
    },
    p2pHostStatus: function () {
        return ipcRenderer.invoke('p2p-host:status');
    },
    onP2pHostStatus: function (callback) {
        if (typeof callback === 'function') {
            ipcRenderer.on('p2p-host:status', function (event, data) { callback(data || {}); });
        }
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
    // ===== 阶段二百八十四：文档磁盘缓存（微信 PC 同款——大文件打开一次落盘，二次秒开零下载）=====
    // get：data = {url, name, maxBytes}，命中且未超 maxBytes 返回 {found:true, buf(Uint8Array), size, path}；
    // 命中但超过 maxBytes 返回 {found:true, tooBig:true, size, path}；未命中返回 {found:false}
    docCacheGet: function (data) {
        return ipcRenderer.invoke('doc-cache:get', data || {});
    },
    // put：data = {url, name, buf(Uint8Array), append}，append=true 追加写分片；写后非追加触发超限清扫
    docCachePut: function (data) {
        return ipcRenderer.invoke('doc-cache:put', data || {});
    },
    // open：data = {url, name}，缓存命中调 shell.openPath 用系统默认应用打开；
    // 返回 {opened:boolean, error?, found:boolean, path?}
    docCacheOpen: function (data) {
        return ipcRenderer.invoke('doc-cache:open', data || {});
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
    // 阶段一百六十二：外部变更感知刷新（任务完结钩子调用）——已打开 file 标签读盘比对静默更新
    browserRefreshFileTabs: function () {
        return ipcRenderer.invoke('browser:refresh-file-tabs');
    },
    // ===== 阶段一百六十三：LSP 补全/跳转定义/文档同步/诊断（与 lspHover 同窄桥口径）=====
    lspComplete: function (req) {
        return ipcRenderer.invoke('lsp:complete', req || {});
    },
    lspDefinition: function (req) {
        return ipcRenderer.invoke('lsp:definition', req || {});
    },
    lspTouch: function (tabId, text) {
        return ipcRenderer.invoke('lsp:touch', { tab_id: String(tabId || ''), text: String(text || '') });
    },
    lspDiagnostics: function (tabId) {
        return ipcRenderer.invoke('lsp:diagnostics-get', { tab_id: String(tabId || '') });
    },
    // ===== 阶段一百六十四：格式化/快速修复/引用/重命名/文档符号（与 lspComplete 同窄桥口径）=====
    lspFormat: function (req) {
        return ipcRenderer.invoke('lsp:format', req || {});
    },
    lspCodeAction: function (req) {
        return ipcRenderer.invoke('lsp:code-action', req || {});
    },
    lspReferences: function (req) {
        return ipcRenderer.invoke('lsp:references', req || {});
    },
    lspRename: function (req) {
        return ipcRenderer.invoke('lsp:rename', req || {});
    },
    lspDocumentSymbol: function (req) {
        return ipcRenderer.invoke('lsp:document-symbol', req || {});
    },
    onLspDiagnostics: function (callback) {
        ipcRenderer.on('lsp:diagnostics', function (event, data) {
            callback(data);
        });
    },
    // 订阅 file 标签 payload 推送（主进程 → 渲染层：{tab_id, payload}，iframe 分发）
    onFileLoad: function (callback) {
        ipcRenderer.on('browser:file-load', function (event, data) {
            callback(data);
        });
    },
    // ===== 阶段一百五十九：浏览区断点调试（TRAE CN 同款；主进程 debug-manager DAP 客户端归口） =====
    // 目标文件只认 {tab_id + path(工作区相对路径)}，绝对路径由主进程 pathGuard 归口，页面不持有
    debugStart: function (tabId, path) {
        return ipcRenderer.invoke('debug:start', { tab_id: String(tabId || ''), path: String(path || '') });
    },
    debugStop: function () {
        return ipcRenderer.invoke('debug:stop');
    },
    // 调试控制/查询：op = continue|next|stepIn|stepOut|pause|threads|stackTrace|scopes|variables|evaluate|restart
    debugCmd: function (op, arg) {
        return ipcRenderer.invoke('debug:cmd', { op: String(op || ''), arg: arg });
    },
    debugSetBreakpoints: function (tabId, path, lines) {
        return ipcRenderer.invoke('debug:set-breakpoints', { tab_id: String(tabId || ''), path: String(path || ''), lines: lines || [] });
    },
    debugBreakpointsGet: function (tabId, path) {
        return ipcRenderer.invoke('debug:breakpoints-get', { tab_id: String(tabId || ''), path: String(path || '') });
    },
    debugState: function (tabId) {
        return ipcRenderer.invoke('debug:state', { tab_id: String(tabId || '') });
    },
    // 一键引导：创建调试专用 venv 并安装 debugpy（缺 Python3 时经 uv 自动下载托管 Python）；tab_id 用于进度事件归口转发
    debugBootstrapPython: function (tabId) {
        return ipcRenderer.invoke('debug:bootstrap-python', { tab_id: String(tabId || '') });
    },
    // 一键引导（C/C++）：gcc/gdb 缺失时经内置工具链 ensureGcc 安装（bundled zip 优先，联网兜底）
    debugBootstrapCpp: function (tabId) {
        return ipcRenderer.invoke('debug:bootstrap-cpp', { tab_id: String(tabId || '') });
    },
    // 调试事件推送（主进程 → 渲染层：{tab_id, type: status|stopped|continued|output|terminated|breakpoints}）
    onDebugEvent: function (callback) {
        ipcRenderer.on('debug:event', function (event, data) {
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
    // 观看窗最小化（标题栏自绘按钮）
    remoteMinimize: function () {
        ipcRenderer.send('remote:minimize');
    },
    // 置顶状态查询 / 切换（回调回传 boolean 新状态）
    remotePinGet: function (callback) {
        ipcRenderer.invoke('remote:pin-get').then(function (r) { if (callback) callback(!!r); }, function () { if (callback) callback(false); });
    },
    remotePinToggle: function (callback) {
        ipcRenderer.invoke('remote:pin-toggle').then(function (r) { if (callback) callback(!!r); }, function () { if (callback) callback(false); });
    },
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
    // ===== 阶段二百六十一：向日葵同款远程控制——本机安装标识（设备ID注册键，仅 PC 端） =====
    // 返回 {install_uuid, device_name}（主进程 userData/im_install.json 持久化 + os.hostname()）
    rcGetInstallInfo: function () {
        return ipcRenderer.invoke('rc:install-info');
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
    },
    // ===== 阶段二百六十：自动更新窗（update.html 专用桥）=====
    // 设置页"检查更新"入口触发手动检查（主进程 updater.check(true)，与托盘菜单同源）
    updaterCheck: function () {
        ipcRenderer.send('updater:check');
    },
    updaterGetInfo: function () {
        return ipcRenderer.invoke('updater:info');
    },
    updaterDownload: function () {
        ipcRenderer.send('updater:download');
    },
    updaterInstall: function () {
        ipcRenderer.send('updater:install');
    },
    updaterDismiss: function () {
        ipcRenderer.send('updater:dismiss');
    },
    onUpdaterInfo: function (callback) {
        ipcRenderer.on('updater:info', function (event, data) {
            callback(data);
        });
    },
    onUpdaterState: function (callback) {
        ipcRenderer.on('updater:state', function (event, data) {
            callback(data);
        });
    },
    // ===== 阶段二百八十一：游戏中心（Steam 同款游戏浏览/下载）桥接 API =====
    // 打开/复用游戏中心独立窗口（主进程单例，close 隐藏复用，下载进行中隐藏不中断任务）
    gameOpenWindow: function () {
        ipcRenderer.send('game:openWindow');
    },
    // 下载控制：payload={action:'start'|'pause'|'resume'|'cancel'|'status', taskId, gameId, installDir,
    // username, serverBase, files:[{id,rel_path,size,sha256,url}]} → Promise<{ok, tasks?/error?}>
    gameDownload: function (payload) {
        return ipcRenderer.invoke('game:download', payload);
    },
    // 订阅下载进度（主进程 500ms 节流推送；任务完成必发一条 state:'done'，error/cancel 同样必发）
    // 负载：{taskId, gameId, received, total, speed, state:'downloading'|'paused'|'done'|'error'|'verifying'|'cancel', fileRelPath, error}
    onGameDownload: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('game-download:progress', function (event, data) {
            cb(data);
        });
    },
    // 选择游戏安装目录 → Promise<{canceled, filePath}>
    gameChooseInstallDir: function () {
        return ipcRenderer.invoke('game:choose-install-dir');
    },
    // Steam 同款选盘：本地固定磁盘列表 → Promise<{disk:'C:',total,free,used}[]>（字节，渲染层换算 GB）
    gameDiskList: function () {
        return ipcRenderer.invoke('game:disk-list');
    },
    // 选盘后预创建安装根目录（<盘根>/CdonlgameApp，不存在即创建）→ Promise<{ok, dir?/error?}>
    gamePrepareInstallDir: function (diskRoot) {
        return ipcRenderer.invoke('game:prepare-install-dir', diskRoot);
    },
    // 选择游戏主程序 exe → Promise<{canceled, filePath}>
    gameChooseGameExe: function () {
        return ipcRenderer.invoke('game:choose-game-exe');
    },
    // ===== 本地游戏（用户手动添加的非商店游戏，存储在渲染层 localStorage）=====
    // 启动本地游戏：{id, exe, args?} → Promise<{ok, startedAt?/error?}>
    localGameLaunch: function (payload) {
        return ipcRenderer.invoke('local-game:launch', payload);
    },
    // 读取本地游戏 exe 图标 → Promise<{ok, dataUrl?/error?}>（app.getFileIcon 48x48 PNG dataURL）
    localGameGetIcon: function (exe) {
        return ipcRenderer.invoke('local-game:get-icon', { exe: exe });
    },
    // 本地游戏运行态查询 → Promise<[{id, startedAt}]>
    localGameRunningList: function () {
        return ipcRenderer.invoke('local-game:running-list');
    },
    // 订阅本地游戏进程启动（全窗口广播 {id, startedAt}）
    onLocalGameStart: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('local-game-start', function (event, data) {
            cb(data);
        });
    },
    // 订阅本地游戏进程退出（全窗口广播 {id, startedAt}）
    onLocalGameExit: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('local-game-exit', function (event, data) {
            cb(data);
        });
    },
    // 订阅本地游戏启动异步失败（spawn 成功但进程报 error）→ {id, message}（无声失败修复，同 game-launch-error 口径）
    onLocalGameLaunchError: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('local-game-launch-error', function (event, data) {
            cb(data);
        });
    },
    // 启动游戏（主进程读启动注册表归口）→ Promise<{ok, startedAt}> / {ok:false, needExe:true}
    gameLaunch: function (payload) {
        return ipcRenderer.invoke('game:launch', payload);
    },
    // 订阅游戏进程启动（主进程启动成功后广播全窗口；页面即时切"运行中"）
    onGameStart: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('game-start', function (event, data) {
            cb(data);
        });
    },
    // 查询当前正在运行的游戏列表（页面加载/刷新后恢复"运行中"态）→ Promise<[{gameId, startedAt}]>
    gameRunningList: function () {
        return ipcRenderer.invoke('game:running-list');
    },
    // 订阅游戏进程退出（主窗口收 {gameId, startedAt}，页面统计游玩时长）
    onGameExit: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('game-exit', function (event, data) {
            cb(data);
        });
    },
    // 订阅游戏启动异步失败（spawn 成功但进程报 error：exe 损坏/依赖缺失/权限等）→ {gameId, message}
    // 此前无声失败：页面已切"运行中"但游戏未起，用户只见"点了没反应"
    onGameLaunchError: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('game-launch-error', function (event, data) {
            cb(data);
        });
    },
    // 登记游戏主程序到启动注册表（needExe 分支选完 exe 后调用）→ Promise<{ok, error?}>
    gameRegisterExe: function (gameId, exePath) {
        return ipcRenderer.invoke('game:register-exe', { gameId: gameId, exePath: exePath });
    },
    // 库右键“属性”：读取用户启动覆盖 {exe, args}（args 为原始模板，占位符未替换）
    gameGetLaunchOptions: function (gameId) {
        return ipcRenderer.invoke('game:get-launch-options', { gameId: gameId });
    },
    // 库右键“属性”保存：exe 空串=清除用户指定主程序；args 空串=清除自定义参数
    gameSetLaunchOptions: function (gameId, exe, args) {
        return ipcRenderer.invoke('game:set-launch-options', { gameId: gameId, exe: exe, args: args });
    },
    // 游戏中心窗最大化/还原切换（无边框窗自绘标题栏按钮，sender 窗口归口）→ Promise<boolean> 切换后是否最大化
    gameWinToggleMaximize: function () {
        return ipcRenderer.invoke('game:win-toggle-maximize');
    },
    // 游戏中心窗最小化（与最大化同构 invoke 通道）→ Promise<boolean> 调用后是否最小化
    gameWinMinimize: function () {
        return ipcRenderer.invoke('game:win-minimize');
    },
    // 订阅游戏中心窗最大化状态（maximize/unmaximize 系统级变化与页面加载完成时推送 boolean）
    onGameWinMaximize: function (cb) {
        if (typeof cb === 'function') ipcRenderer.on('game-win:maximized', function (event, on) {
            cb(!!on);
        });
    },
    // ===== 阶段二百八十九：游戏云存档（Steam 同款云存档 P1）桥接 API =====
    // 读取用户存档路径覆盖（userData/game-save.json）→ Promise<{ok, paths:[], exclude:[]}>
    gameSaveConfigGet: function (gameId) {
        return ipcRenderer.invoke('game:save-config-get', { gameId: gameId });
    },
    // 保存用户存档路径覆盖 cfg={paths:[], exclude:[]}（均空=清除覆盖）→ Promise<{ok, error?}>
    gameSaveConfigSet: function (gameId, cfg) {
        return ipcRenderer.invoke('game:save-config-set', {
            gameId: gameId,
            paths: (cfg && cfg.paths) || [],
            exclude: (cfg && cfg.exclude) || []
        });
    },
    // 生效存档路径预览（含来源 user/admin/builtin）payload={gameId, installDir, slug, adminPaths, adminExclude}
    gameSavePathsPreview: function (payload) {
        return ipcRenderer.invoke('game:save-paths-preview', payload);
    },
    // 执行云存档同步 payload={gameId,username,installDir,slug,adminPaths,adminExclude,mode:'push'|'pull'|'auto'}（slug 供内置兜底锚定本游戏目录）
    // → Promise<{ok, uploaded?, downloaded?, skipped?, revision?, note?, error?}>
    gameSaveSync: function (payload) {
        return ipcRenderer.invoke('game:save-sync', payload);
    },
    // 云端存档清单摘要 payload={gameId,username} → Promise<{ok, exists, file_count, total_size, max_total_size, update_time, revision}>
    gameSaveManifest: function (payload) {
        return ipcRenderer.invoke('game:save-manifest', payload);
    },
    // 订阅云存档同步进度（主进程 500ms 节流；文件切换与终态必发）
    // 负载：{gameId,mode,phase,fileRelPath,fileIndex,filesCount,bytesDone,bytesTotal,percent}
    onGameSaveProgress: function (cb) {
        if (typeof cb !== 'function') return function () { };
        var handler = function (event, data) { cb(data); };
        ipcRenderer.on('game-save:progress', handler);
        // 返回取消订阅函数：重复调用不再叠加监听（避免同一回调被多次触发）
        return function () { ipcRenderer.removeListener('game-save:progress', handler); };
    },
    // 云端版本历史（P2）payload={gameId,username,slot} → Promise<{ok,exists,current_revision,revisions:[...]}>
    gameSaveHistory: function (payload) {
        return ipcRenderer.invoke('game:save-history', payload);
    },
    // 版本回滚（P2）payload={gameId,username,slot,revision} → Promise<{ok,revision,restored_from}>
    gameSaveRollback: function (payload) {
        return ipcRenderer.invoke('game:save-rollback', payload);
    },
    // 云端槽位列表（P3）payload={gameId,username} → Promise<{ok,slots:[...]}>
    gameSaveSlots: function (payload) {
        return ipcRenderer.invoke('game:save-slots', payload);
    },
    // 删除云端槽位（P3）payload={gameId,username,slot} → Promise<{ok}>
    gameSaveSlotDelete: function (payload) {
        return ipcRenderer.invoke('game:save-slot-delete', payload);
    },
    // 打开本地存档目录（P3）payload={gameId,installDir,slug,adminPaths,adminExclude} → Promise<{ok,dir}>
    gameSaveOpenDir: function (payload) {
        return ipcRenderer.invoke('game:save-open-dir', payload);
    },
    // ===== 阶段二百九十二 M4：局域网游戏跨公网联机·本地端口隧道（仅 PC 端，形态二）======
    // 主进程持 UDP/TCP 套接字，渲染进程（gn-net.js）持 WebRTC DataChannel，经以下受控方法对接：
    // 渲染进程拿不到裸 socket（无任意端口/任意目标能力；端口白名单与角色校验在主进程归口）。
    // open：args={room_id, peer, proto:'udp'|'tcp', role:'host'|'join', port, host_ip?} → Promise<{ok, port?, err?}>
    gnTunnelOpen: function (args) {
        return ipcRenderer.invoke('gn:tunnel-open', args || {});
    },
    // close：args={room_id, peer?, proto?, role?, quiet?}（缺省 peer/proto/role = 该房间全部）→ Promise<{ok, closed}>
    gnTunnelClose: function (args) {
        return ipcRenderer.invoke('gn:tunnel-close', args || {});
    },
    // deliver：对端 DataChannel 收到的字节/流控制帧 → 主进程套接字（数据面高频，fire-and-forget）
    // frame={room_id, peer, proto, sid, kind:'data'|'open'|'close', buf?}
    gnTunnelDeliver: function (frame) {
        ipcRenderer.send('gn:tunnel-deliver', frame || {});
    },
    // 功能二期方案 B：广播发现代理（PC 客户端内置虚拟主机应答）
    // start：加入方 join 隧道就绪后启动（args={room_id, game, port, game_name, host_name, slots_total, slots_used}）
    // stop：房间收口/断链即停（幂等，args={room_id}）
    gnBroadcastStart: function (args) {
        return ipcRenderer.invoke('gn:broadcast-start', args || {});
    },
    gnBroadcastStop: function (args) {
        return ipcRenderer.invoke('gn:broadcast-stop', args || {});
    },
    // 功能二期：加入端接收主机中继的真实 GameInfo（hex）→ 代理缓存（应答/直投优先真实数据）
    gnBroadcastRelay: function (args) {
        return ipcRenderer.invoke('gn:broadcast-relay', args || {});
    },
    // 功能二期：主机端探测到的真实 GameInfo 推送（main → 渲染层，经渲染层 ctl 通道中继给加入方）
    onGnBroadcastGameInfo: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn-broadcast-gi', function (event, payload) { cb(payload || {}); });
    },
    // 联机排障诊断日志桥：渲染层关键分支落盘主进程 gn-tunnel.log（只进不出，无敏感数据）
    gnDebugLog: function (line) {
        try { ipcRenderer.invoke('gn:debug-log', String(line == null ? '' : line)); } catch (e) { }
    },
    // 联机保活时钟：主进程 15s 一拍（渲染层被游戏全屏遮挡时定时器节流，保活改由 IPC 唤醒）
    onGnKeepaliveTick: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:keepalive-tick', function () { try { cb(); } catch (e) { } });
    },
    // 阶段二百九十二 M7：房主游戏端口自动探测（设计文档 §4.3 第 1 层）
    // args={procs?:string[]}（已登记游戏进程名，供过滤）→ Promise<{ok, list:[{port,pid,proc,protos}], filtered}>
    // 仅读取本机监听端口清单（netstat -ano + tasklist），不触碰游戏字节
    gnDetectPort: function (args) {
        return ipcRenderer.invoke('gn:detect-port', args || {});
    },
    // 本机套接字 → 渲染进程（data 帧：本机游戏发出的字节/流控制帧，待转发进 DataChannel）
    onGnTunnelData: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn-tunnel:data', function (event, frame) { cb(frame); });
    },
    // 隧道事件（listen/open/close/error/closed/idle）——供 UI 提示与流生命周期同步
    onGnTunnelEvent: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn-tunnel:event', function (event, frame) { cb(frame); });
    },
    // ===== 阶段二百九十二 M5/M8：联机大厅跨窗桥接 =====
    // 主窗口（邀请卡片「加入房间」/ 游戏详情「联机」）→ 主进程 → 唤醒游戏中心窗并联机大厅页
    // payload={name?,port?,room_id?,join?,procs?}
    gameNetOpenLobby: function (payload) {
        ipcRenderer.send('game:net-open', payload || {});
    },
    // 游戏中心窗订阅：切联机大厅页 + 预填/（join 时）直接加入（payload 同上，可缺省）
    onGameNetOpen: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('game:net-open', function (event, payload) { cb(payload || {}); });
    },
    // ===== 阶段二百九十二 M8：联机信令跨窗中继（房间层/引擎已迁入游戏中心窗，复用主窗口唯一 WS）=====
    // 上行（游戏中心窗 → 主进程 → 主窗口）：payload={msg_type,to_user?,content}
    gnSignalSend: function (payload) {
        ipcRenderer.send('gn:signal-send', payload || {});
    },
    // 主窗口订阅上行信令：收到后调用 IMSocket.send（本端是唯一 WS 持有者）
    onGnSignalOut: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:signal-out', function (event, payload) { cb(payload || {}); });
    },
    // 下行（主窗口 → 主进程 → 游戏中心窗）：msg={msg_type,from_user,content}
    gnSignalForward: function (msg) {
        ipcRenderer.send('gn:signal-recv', msg || {});
    },
    // 游戏中心窗订阅下行信令（分发到 GNSignal.on 注册的处理口）
    onGnSignalIn: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:signal-in', function (event, msg) { cb(msg || {}); });
    },
    // WS 连接态：主窗口上报（变化才发）→ 主进程缓存 → 游戏中心窗订阅 + 首开主动拉取
    gnSocketState: function (on) {
        ipcRenderer.send('gn:socket-state', !!on);
    },
    onGnSocketState: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:socket-state', function (event, on) { cb(!!on); });
    },
    gnSocketStateGet: function () {
        return ipcRenderer.invoke('gn:socket-state-get');
    },
    // 服务端归口参数（登录响应 game_net_*）：主窗口上报 → 主进程缓存 → 游戏中心窗订阅/首开拉取
    gnNetConfig: function (cfg) {
        ipcRenderer.send('gn:net-config', cfg || {});
    },
    onGnNetConfig: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:net-config', function (event, cfg) { cb(cfg || {}); });
    },
    gnNetConfigGet: function () {
        return ipcRenderer.invoke('gn:net-config-get');
    },
    // 好友通讯录快照（游戏中心窗「邀请好友」选人数据源；主窗口 IMContacts 为唯一归口）→ Promise<[{username,name,avatar}]>
    gnContactsGet: function () {
        return ipcRenderer.invoke('gn:contacts-get');
    },
    onGnContactsNeed: function (cb) {
        if (typeof cb !== 'function') return;
        ipcRenderer.on('gn:contacts-need', function (event, id) { cb(id); });
    },
    gnContactsReply: function (id, list) {
        ipcRenderer.send('gn:contacts-reply', id, list || []);
    },
    // ===== 联机二期 §9.4-5：同机并发活动态跨窗归口（降级提示只落在联机侧）=====
    // 通话窗/远程窗上报自身活跃态变化（kind='call'|'remote'，变化才发；主进程缓存并做窗口销毁兜底复位）
    actOtherReport: function (kind, on) {
        if (kind !== 'call' && kind !== 'remote') return;
        ipcRenderer.send('act:other-report', kind, !!on);
    },
    // 游戏中心窗在建立联机时反查本机是否另有通话/会议/远程协助在跑 → Promise<{call,remote}>
    actOtherGet: function () {
        return ipcRenderer.invoke('act:other-get');
    }
});
