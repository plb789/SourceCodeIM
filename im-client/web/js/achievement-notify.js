// achievement-notify.js - 桌面成就通知窗渲染层（方案 §14.3.4 补充：与页内 toast 视觉同源的
// 独立桌面弹窗，不复用好友消息的系统通知）
//
// 数据面：desktop.onAchNotifyShow（主窗口 achievement-toast.js 经 desktop.achNotify 转发主进程）
// 交互：卡片点击 → desktop.achNotifyOpen（主进程聚焦主窗口）；悬停暂停 / 4s 自动消失
// 显窗：栈空 → achNotifyVisible(false)，非空 → (true)——窗口本体即通知区域，不夺焦点不挡操作
// 样式：卡片经 AchievementToast.buildCard 构建（与游戏中心/主窗口页内 toast 同一 CSS/DOM，
//       主题色随 style.css 变量自动切换；本窗禁止硬编码颜色）

(function () {
    'use strict';

    var MAX_TOASTS = 4;   // 堆叠上限（超出丢最旧）
    var TTL = 4000;       // 自动消失计时（悬停暂停，与页内 toast 停留时长一致）
    var TICK = 250;       // 过期检查周期

    var desktop = window.desktop || {};

    // ===== 运行时状态 =====
    var toasts = []; // {key, payload, deadline, paused, el}
    var seq = 0;

    function cardKey(p) { return (p && p.code) ? ('c:' + p.code) : ('s:' + (++seq)); }

    function pushCard(p) {
        if (!p) return;
        var key = cardKey(p);
        for (var i = 0; i < toasts.length; i++) {
            if (toasts[i].key === key) {
                // 同成就合并（链路 B 重试/多帧竞态）：计时重置即可（成就内容不变）
                toasts[i].deadline = Date.now() + TTL;
                return;
            }
        }
        var el = window.AchievementToast.buildCard(p); // 与页内 toast 同源视觉
        el.addEventListener('mouseenter', function () { t.paused = true; });
        el.addEventListener('mouseleave', function () { t.paused = false; t.deadline = Date.now() + TTL; });
        // 点击：移除卡片并聚焦主窗口（用户查看成就详情/资料页入口）
        el.addEventListener('click', function () {
            removeCard(t);
            if (typeof desktop.achNotifyOpen === 'function') desktop.achNotifyOpen();
        });
        var t = { key: key, payload: p, deadline: Date.now() + TTL, paused: false, el: el };
        toasts.push(t);
        if (toasts.length > MAX_TOASTS) {
            var oldest = toasts.shift();
            if (oldest.el && oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
        }
        document.getElementById('ach-stack').appendChild(el); // 挂载到堆叠区（缺此步卡片只在数组里不进 DOM）
        render();
    }

    function removeCard(t) {
        toasts = toasts.filter(function (x) { return x !== t; });
        if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
        render();
    }

    function render() {
        var box = document.getElementById('ach-stack');
        if (!box) return;
        // 移除已过期卡片（render 由过期轮询与增删共同驱动）
        toasts = toasts.filter(function (t) {
            if (t.paused || t.deadline > Date.now()) return true;
            if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
            return false;
        });
        // 显窗归口：栈空隐藏（不挡桌面操作）/ 非空显示（showInactive 不夺焦点）+ 上报动态高度
        // （卡片 71px + 间距 8px + 上下内边距 24px，主进程据此调整窗口高度）
        if (typeof desktop.achNotifyVisible === 'function') {
            desktop.achNotifyVisible(toasts.length > 0, toasts.length * 79 + 24);
        }
    }

    function boot() {
        // 主题跟随（主窗口切主题 storage 事件跨窗触达，notify.html 同款）
        window.addEventListener('storage', function (e) {
            if (e.key === 'im_theme' && e.newValue) {
                try { document.documentElement.setAttribute('data-theme', e.newValue); } catch (err) { }
            }
        });
        // 过期轮询（仅栈非空时有工作量；有卡片到期才重渲染，防每 250ms 重复显窗请求）
        setInterval(function () {
            if (!toasts.length) return;
            var now = Date.now();
            var expired = toasts.filter(function (t) {
                if (t.paused || t.deadline > now) return false;
                if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
                return true;
            });
            if (expired.length) {
                toasts = toasts.filter(function (t) { return expired.indexOf(t) < 0; });
                render();
            }
        }, TICK);
        // 主进程下行：主窗口转发来的成就 payload
        if (typeof desktop.onAchNotifyShow === 'function') {
            desktop.onAchNotifyShow(function (p) { pushCard(p); });
        }
        render(); // 初始空栈 → achNotifyVisible(false)（窗口保持隐藏）
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
