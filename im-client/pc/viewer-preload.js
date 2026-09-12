// viewer-preload.js — 阶段九十二：内部文件查看页窄桥（仅挂 file kind 标签）
//
// 安全边界：本 preload 只会注入到 browser-manager 创建的 file 标签——页面恒为应用自配套的
// file-viewer.html（服务端同源静态文件，will-navigate 锁死导航，外部网页进不了本分区）。
// 能力面收敛到两个最小操作：保存（路径由主进程 tab.filePath 归口，页面只传内容）与脏标记。
// 网页标签（persist:agent-browser 分区）依旧零 preload，能力面不变。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('imviewer', {
    // 保存当前标签内容（tabId 来自注入 payload 的 tab_id；主进程按 tab.filePath 写回）
    save: function (tabId, content) {
        return ipcRenderer.invoke('browser:file-save', { tab_id: String(tabId || ''), content: String(content != null ? content : '') });
    },
    // 编辑未保存脏标记（tab 栏圆点提示；开/关随编辑态变化上报）
    setDirty: function (tabId, dirty) {
        ipcRenderer.send('browser:viewer-dirty', { tab_id: String(tabId || ''), dirty: !!dirty });
    }
});
