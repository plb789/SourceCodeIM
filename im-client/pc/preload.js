// preload.js - 预加载脚本：暴露桌面端原生能力给渲染进程
// 阶段三十七（第三期）：新增静默抓屏（desktopCapturer）与 Alt+A 全局快捷键结果订阅
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    // 后续可扩展桌面通知、快捷键等能力
    notify: function (title, body) {
        // 桌面通知由主进程处理，此处占位
        console.log('[desktop notify]', title, body);
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
    }
});
