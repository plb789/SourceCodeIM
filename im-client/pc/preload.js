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
    }
});
