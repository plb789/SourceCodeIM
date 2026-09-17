// ===== 长截图悬浮小条窗口逻辑（独立无边框 BrowserWindow，web/bar.html 专属） =====
// 承载方式：主窗口隐藏（缩条方案 overlay 系统按钮遮挡完成/取消，用户实测反馈），本条窗落位显示；
// 状态文本由主窗口渲染层 updateStitchStatus 经主进程转发（stitch:bar-status），
// 完成/取消/Esc 点击经主进程转主窗口渲染层执行 completeStitch/cancelStitch（stitch:bar-action）
(function () {
    'use strict';
    // 主题跟随：与主窗口同 origin 共享 localStorage（chat.js getTheme 键 im_theme：light/dark/system），
    // system 模式跟随系统深浅（媒体查询与 chat.js titlebarIsDark 同源逻辑）
    try {
        var t = localStorage.getItem('im_theme') || 'light';
        var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (!dark) document.documentElement.classList.add('light');
    } catch (err) { /* localStorage 不可用时保持默认深色 */ }
    // 「跟随系统」模式下系统深浅切换实时同步（条窗生命周期短，监听兜底）
    var schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var themeHandler = function () {
        try {
            var t2 = localStorage.getItem('im_theme') || 'light';
            if (t2 === 'system') document.documentElement.classList.toggle('light', !schemeQuery.matches);
        } catch (err) { /* 忽略 */ }
    };
    if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', themeHandler);

    var statusEl = document.querySelector('.status');
    var okBtn = document.querySelector('.btn.primary');
    var noBtn = document.querySelector('.btn:not(.primary)');

    // 接收主窗口转发的状态文本（准备中…/已捕获 Npx/生成中…等）
    if (window.desktop && window.desktop.onBarStatus) {
        window.desktop.onBarStatus(function (text) {
            if (statusEl) statusEl.textContent = String(text || '');
        });
    }
    // 完成/取消 → 主进程 → 主窗口渲染层执行（completeStitch/cancelStitch）
    if (okBtn) okBtn.addEventListener('click', function () {
        if (window.desktop && window.desktop.barAction) window.desktop.barAction('complete');
    });
    if (noBtn) noBtn.addEventListener('click', function () {
        if (window.desktop && window.desktop.barAction) window.desktop.barAction('cancel');
    });
    // Esc 快捷取消（与主窗口内工具条 Esc 语义一致）
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && window.desktop && window.desktop.barAction) window.desktop.barAction('cancel');
    });
})();
