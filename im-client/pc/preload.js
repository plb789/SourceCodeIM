// preload.js - 预加载脚本：暴露桌面端原生能力给渲染进程
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    platform: process.platform,
    // 后续可扩展桌面通知、快捷键等能力
    notify: function (title, body) {
        // 桌面通知由主进程处理，此处占位
        console.log('[desktop notify]', title, body);
    }
});
