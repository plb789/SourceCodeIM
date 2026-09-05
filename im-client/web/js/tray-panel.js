// tray-panel.js - 托盘悬停预览面板逻辑（阶段三十七·第四期·增强）
// 面板为独立轻量页面：无 WebSocket / 无登录逻辑，数据由主进程推送（主进程缓存渲染层上报的未读明细）
// 交互：点击条目 → IPC 通知主进程 → 主窗口恢复并跳转对应会话；鼠标移出面板 → 主进程隐藏面板
(function () {
    // 主题跟随：读取主界面存储的主题偏好（面板与主页面同源，localStorage 共享）
    try {
        var t = localStorage.getItem('im_theme');
        if (t) document.documentElement.setAttribute('data-theme', t);
    } catch (e) {}

    var listEl = document.getElementById('tp-list');
    var emptyEl = document.getElementById('tp-empty');

    function render(data) {
        var list = (data && data.list) || [];
        listEl.innerHTML = '';
        if (!list.length) {
            emptyEl.classList.remove('hidden');
            return;
        }
        emptyEl.classList.add('hidden');
        list.forEach(function (it) {
            var li = document.createElement('div');
            li.className = 'tp-item';
            // 头像显示优先级与主界面一致：服务端头像图片优先，缺失回退首字母占位
            if (it.avatar) {
                var av = document.createElement('img');
                av.className = 'tp-avatar';
                av.src = it.avatar;
                li.appendChild(av);
            } else {
                var ph = document.createElement('div');
                ph.className = 'tp-avatar tp-avatar-ph';
                ph.textContent = (it.name || '?').charAt(0).toUpperCase();
                li.appendChild(ph);
            }
            var mid = document.createElement('div');
            mid.className = 'tp-mid';
            var nm = document.createElement('div');
            nm.className = 'tp-name';
            nm.textContent = it.name || '';
            var last = document.createElement('div');
            last.className = 'tp-last';
            last.textContent = it.last || '';
            mid.appendChild(nm);
            mid.appendChild(last);
            li.appendChild(mid);
            var badge = document.createElement('span');
            badge.className = 'tp-badge';
            badge.textContent = it.unread > 99 ? '99+' : it.unread;
            li.appendChild(badge);
            li.addEventListener('click', function () {
                if (window.desktop && window.desktop.openConv) window.desktop.openConv(it.target);
            });
            listEl.appendChild(li);
        });
    }

    // 主进程在每次显示面板前推送最新未读明细
    if (window.desktop && window.desktop.onTrayUnreadPush) {
        window.desktop.onTrayUnreadPush(render);
    }
    // 兜底：面板加载完成时主动拉取一次（showInactive 先于推送到达的时序保护）
    if (window.desktop && window.desktop.getTrayUnread) {
        window.desktop.getTrayUnread().then(render).catch(function () {});
    }

    // 鼠标移出面板：通知主进程隐藏（补充主进程 blur 隐藏机制，悬停离开更跟手）
    document.addEventListener('mouseleave', function () {
        if (window.desktop && window.desktop.hidePanel) window.desktop.hidePanel();
    });
})();
