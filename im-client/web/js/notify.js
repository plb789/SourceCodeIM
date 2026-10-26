// notify.js - 游戏内通知小窗渲染层（Steam 式消息/邀请 toast，docs/游戏内Overlay功能技术设计.md §十）
//
// 数据面：desktop.onGnChatIn 镜像（2 私聊 / 111 邀请 / 93 在线增量，复用主窗口唯一 WS 零新增）
//         + gnContactsGet 好友快照（头像/昵称映射）+ overlay:state 订阅（面板打开抑制）
// 交互：toast 点击 → desktop.notifyOpen（主进程唤起面板并投递直达参数）；悬停暂停 / 6s 自动消失
// 显窗：栈空 → notifyVisible(false)，非空 → (true)——窗口本体即通知区域，不占游戏画面不挡操作
// 抑制：面板打开时清空堆叠（消息面板内可见，避免重复打扰）；Win7 随 overlay 硬性禁用（主进程不创建本窗）

(function () {
    'use strict';

    var MSG_PRIVATE = 2;      // 私聊文本
    var MSG_INVITE = 111;     // 联机邀请
    var MSG_USER_DELTA = 93;  // 在线名单增量（头像更新）
    var MAX_TOASTS = 4;       // 堆叠上限（超出丢最旧）
    var TTL = 6000;           // 自动消失计时（悬停暂停）
    var TICK = 250;           // 过期检查周期

    var desktop = window.desktop || {};
    function $(id) { return document.getElementById(id); }
    function T(s, p) {
        if (window.I18N) return I18N.t(s, p);
        if (!p) return s;
        var out = String(s);
        for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out = out.split('{' + k + '}').join(String(p[k])); }
        return out;
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ===== 运行时状态 =====
    var toasts = [];       // {key, username, invite, fromName, text, count, deadline, paused}
    var friends = {};      // username → {name, avatar}（gnContactsGet 快照 + 93 头像增量）
    var panelOpen = false; // 面板打开抑制（overlay:state 广播）
    var seq = 0;           // 同帧渲染锚

    // ===== 好友快照 =====
    function loadFriends() {
        if (typeof desktop.gnContactsGet !== 'function') return;
        Promise.resolve(desktop.gnContactsGet()).then(function (list) {
            (list || []).forEach(function (f) {
                if (f && f.username) friends[f.username] = { name: f.name || f.username, avatar: f.avatar || '' };
            });
            render(); // 快照晚到：已显示 toast 的头像昵称补齐
        }).catch(function () { });
    }
    function friendInfo(u) {
        return friends[u] || { name: u || '', avatar: '' };
    }

    // ===== 头像（项目统一降级模式：破图隐藏显首字母；DOM 构建避免内联转义坑）=====
    function fillAvatar(slot, url, name) {
        var ch = (name || '?').charAt(0).toUpperCase();
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.addEventListener('error', function () {
                img.remove();
                slot.textContent = ch;
            });
            slot.appendChild(img);
        } else {
            slot.textContent = ch;
        }
    }

    // ===== toast 堆叠 =====
    function toastKey(t) {
        return t.invite ? ('invite:' + (t.invite.room_id || '')) : ('u:' + (t.username || ''));
    }
    function pushToast(t) {
        var key = toastKey(t);
        for (var i = 0; i < toasts.length; i++) {
            if (toastKey(toasts[i]) === key) {
                // 同会话合并：×N 计数 + 最新内容 + 计时重置
                toasts[i].text = t.text;
                toasts[i].count = (toasts[i].count || 1) + 1;
                toasts[i].deadline = Date.now() + TTL;
                render();
                return;
            }
        }
        t.count = 1;
        t.deadline = Date.now() + TTL;
        t.paused = false;
        toasts.push(t);
        if (toasts.length > MAX_TOASTS) toasts.shift(); // 超出丢最旧（未读仍累计于面板徽标）
        render();
    }

    function render() {
        var box = $('nt-stack');
        var now = Date.now();
        toasts = toasts.filter(function (t) { return t.paused || t.deadline > now; });

        var html = '';
        toasts.forEach(function (t, idx) {
            var info = t.invite ? { name: t.fromName || '', avatar: '' } : friendInfo(t.username);
            var title = t.invite ? T('邀请') : (info.name || t.username || '?');
            var sub = t.invite
                ? T('{n} 邀请你加入房间 {id}', { n: t.fromName || t.username || '', id: t.invite.room_id })
                : t.text;
            html += '<div class="nt-toast" data-idx="' + idx + '" data-key="' + esc(toastKey(t)) + '">'
                + '<div class="nt-avatar"></div>'
                + '<div class="nt-body">'
                + '<div class="nt-head"><span class="nt-name">' + esc(title) + '</span>'
                + (t.count > 1 ? '<span class="nt-count">×' + t.count + '</span>' : '')
                + '</div>'
                + '<div class="nt-text">' + esc(sub) + '</div>'
                + '</div></div>';
        });
        box.innerHTML = html;

        // 头像填充（data 序号回查 toasts，闭包安全）
        var slots = box.querySelectorAll('.nt-toast');
        for (var i = 0; i < slots.length; i++) {
            (function (el) {
                var t = toasts[Number(el.getAttribute('data-idx'))];
                if (!t) return;
                var info = t.invite ? { name: t.fromName || '?', avatar: '' } : friendInfo(t.username);
                fillAvatar(el.querySelector('.nt-avatar'), info.avatar, info.name);
                // 悬停暂停 / 移出恢复
                el.addEventListener('mouseenter', function () { t.paused = true; });
                el.addEventListener('mouseleave', function () { t.paused = false; t.deadline = Date.now() + TTL; });
                // 点击：唤起面板并直达（私聊=该好友会话；邀请=房间页签的邀请条）
                el.addEventListener('click', function () {
                    removeToast(t);
                    if (typeof desktop.notifyOpen === 'function') {
                        desktop.notifyOpen(t.invite ? { invite: true } : { username: t.username });
                    }
                });
            })(slots[i]);
        }
        // 显窗归口：栈空隐藏（不占游戏画面）/ 非空显示（showInactive 不夺焦）
        if (typeof desktop.notifyVisible === 'function') desktop.notifyVisible(toasts.length > 0);
    }
    function removeToast(t) {
        toasts = toasts.filter(function (x) { return x !== t; });
        render();
    }

    // ===== 镜像下行 =====
    function onChatMirror(msg) {
        if (!msg || !msg.msg_type) return;
        if (panelOpen) return; // 面板打开抑制：消息面板内可见（未读徽标联动）
        if (msg.msg_type === MSG_PRIVATE) {
            var me = getUsername();
            var peer = msg.from_user === me ? (msg.to_user || '') : (msg.from_user || '');
            if (!peer || peer === me) return;
            var text = String(msg.content || '');
            if (!text) return;
            if (text.length > 60) text = text.slice(0, 60) + '…'; // 预览两行截断（CSS line-clamp 兜底）
            pushToast({ username: peer, text: text });
            return;
        }
        if (msg.msg_type === MSG_INVITE) {
            var env = null;
            try { env = JSON.parse(msg.content || '{}'); } catch (e) { env = null; }
            if (env && env.invite && env.invite.room_id) {
                pushToast({ invite: env.invite, username: msg.from_user || '', fromName: msg.from_user || '' });
            }
            return;
        }
        if (msg.msg_type === MSG_USER_DELTA) {
            // 93 增量：仅刷新头像缓存（在线态不显示于 toast）
            try {
                var d = JSON.parse(msg.content || '{}');
                (d.online || []).forEach(function (u) {
                    if (u && u.username && u.avatar && friends[u.username]) friends[u.username].avatar = u.avatar;
                });
            } catch (e) { }
        }
    }
    function getUsername() {
        if (window.IMSocket && IMSocket.getUsername) return IMSocket.getUsername() || '';
        try { return (JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || {}).u || ''; } catch (e) { return ''; }
    }

    // ===== 初始化 =====
    function boot() {
        // 面板状态订阅：面板打开 → 清空堆叠并隐藏（消息面板内可见）
        if (typeof desktop.onOverlayState === 'function') {
            desktop.onOverlayState(function (st) {
                var open = !!(st && st.open);
                if (open && !panelOpen && toasts.length) { toasts = []; render(); }
                panelOpen = open;
            });
        }
        // 主题跟随（主窗口切主题 storage 事件跨窗触达，面板同款）
        window.addEventListener('storage', function (e) {
            if (e.key === 'im_theme' && e.newValue) {
                try { document.documentElement.setAttribute('data-theme', e.newValue); } catch (err) { }
            }
        });
        // 过期检查（仅栈非空时轮询空转成本可忽略）
        setInterval(function () {
            if (!toasts.length) return;
            var now = Date.now();
            var before = toasts.length;
            toasts = toasts.filter(function (t) { return t.paused || t.deadline > now; });
            if (toasts.length !== before) render();
        }, TICK);
        if (typeof desktop.onGnChatIn === 'function') desktop.onGnChatIn(onChatMirror);
        loadFriends();
        render(); // 初始空栈 → notifyVisible(false)（窗口保持隐藏）
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
