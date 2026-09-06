/**
 * mobile.js —— 微信手机版移动端适配层（一套代码三端自适应）
 *
 * 设计原则：不侵入 chat.js 现有逻辑（避免破坏 PC/WEB 端已有功能），仅做三件事：
 *   1. 视口状态机：html.m 类标记移动布局（Capacitor 原生环境恒为移动；浏览器按宽度 ≤768px 响应式切换），
 *      移动布局的呈现全部由 style.css 的 html.m 规则块实现；
 *   2. 交互桥接：触屏长按合成 contextmenu 事件（复用 chat.js 现有三个右键菜单，零改动）、
 *      列表/聊天全屏视图互切（含 Android 物理返回键，history pushState/popstate 桥接）、
 *      图片查看器 window.open 改为同窗跳转（Capacitor 环境弹窗体验差）；
 *   3. 触屏细节：输入框聚焦后消息区贴近底部时跟随滚底，避免键盘顶起后看不到最新消息。
 *
 * PC/WEB 宽窗口下本文件全部逻辑自动旁路，行为与改造前完全一致。
 */
(function () {
    'use strict';

    var root = document.documentElement;
    // Capacitor 原生环境检测（app-shell.js 同款判定，浏览器访问恒为 false）
    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

    /* ---------- 1. 视口状态机：html.m 标记移动布局 ---------- */
    var MOBILE_BREAKPOINT = 768;

    function isMobileView() {
        // 原生 APP 恒为移动布局（含横屏）；浏览器窗口按宽度响应式
        return isNative || window.innerWidth <= MOBILE_BREAKPOINT;
    }

    function applyViewport() {
        root.classList.toggle('m', isMobileView());
    }
    window.addEventListener('resize', applyViewport);
    applyViewport();

    function inMobile() {
        return root.classList.contains('m');
    }

    /* ---------- 2. 列表/聊天全屏视图互切 ---------- */
    // 进入聊天视图：点击会话项/好友项/AI 项/搜索结果项（事件委托，chat.js 的打开聊天逻辑零改动）
    // 关键：必须注册在 capture 阶段——chat.js 打开聊天后会重建列表，冒泡阶段执行时
    // 原 li 已脱离 DOM，e.target.closest() 会返回 null 导致视图不切换（表现为"点击没反应"）
    document.addEventListener('click', function (e) {
        if (!inMobile()) return;
        if (document.body.classList.contains('in-chat')) return;
        var item = e.target.closest(
            '#conv-list li, #user-list li.user-item, #ai-agent-list li, #search-panel li, #search-panel .search-item'
        );
        // 排除"新的朋友"等非聊天入口（div 结构天然不匹配上面的 li 选择器）
        if (!item) return;
        enterChat();
    }, true);

    function enterChat() {
        if (document.body.classList.contains('in-chat')) return;
        document.body.classList.add('in-chat');
        // 物理返回键桥接：推入一条历史记录，Android 返回键触发 popstate 时退回列表视图
        try {
            if (isNative && !history.state) history.pushState({ im_chat: true }, '');
        } catch (err) { /* 历史操作失败不影响视图切换 */ }
    }

    function exitChat() {
        document.body.classList.remove('in-chat');
        // 退回列表时收起聊天页内浮层（表情面板/会话内搜索），避免状态残留
        var ep = document.getElementById('emoji-panel');
        if (ep) ep.classList.add('hidden');
        var cs = document.getElementById('conv-search');
        if (cs) cs.classList.add('hidden');
    }

    // 顶部返回按钮（HTML 常驻，PC 端由 CSS 隐藏）
    var backBtn = document.getElementById('mobile-back');
    if (backBtn) {
        backBtn.addEventListener('click', function () {
            if (isNative && history.state) {
                history.back(); // 统一走 popstate 清理历史栈
            } else {
                exitChat();
            }
        });
    }

    // Android 物理返回键：Capacitor 桥接为 WebView history 后退 → popstate
    window.addEventListener('popstate', function () {
        if (!inMobile()) return;
        if (document.body.classList.contains('in-chat')) exitChat();
    });

    // "新的朋友"浮层位于聊天视图（main-chat）内，而入口在通讯录面板（列表视图）：
    // 移动端点击入口需先切入聊天视图使浮层可见；关闭浮层后退回列表视图
    // 同样注册在 capture 阶段（与进入聊天委托同理，避免动态重建 DOM 后 closest 失效）
    document.addEventListener('click', function (e) {
        if (!inMobile()) return;
        if (e.target.closest('#new-friends-entry')) {
            enterChat();
        } else if (e.target.closest('#new-friends-close')) {
            // 延迟到 chat.js 关闭逻辑执行完再退视图
            setTimeout(exitChat, 0);
        }
    }, true);

    // 退出登录时清理聊天视图状态，避免重新登录后直接停留在聊天页
    document.addEventListener('click', function (e) {
        if (!inMobile()) return;
        if (e.target.closest('#logout-btn')) exitChat();
    }, true);

    /* ---------- 3. 触屏长按 → 合成 contextmenu（复用现有右键菜单） ---------- */
    var LONG_PRESS_MS = 500;   // 微信同款长按时长
    var MOVE_CANCEL_PX = 10;   // 位移超过该值视为滚动，取消长按
    var MENU_EST_W = 150;      // 菜单宽度估算值（用于长按点防屏幕溢出）
    var lpTimer = null;
    var suppressClick = false; // 长按触发后抑制随之而来的 click（防误触图片查看等）

    function clearLongPress() {
        if (lpTimer) {
            clearTimeout(lpTimer);
            lpTimer = null;
        }
    }

    if ('ontouchstart' in window) {
        document.addEventListener('touchstart', function (e) {
            if (!inMobile()) return;
            if (e.touches.length !== 1) return;
            var t = e.target.closest(
                '.message, #conv-list li, #user-list li.user-item, #ai-agent-list li'
            );
            if (!t) return;
            var touch = e.touches[0];
            var sx = touch.clientX;
            var sy = touch.clientY;
            clearLongPress();
            lpTimer = setTimeout(function () {
                lpTimer = null;
                suppressClick = true;
                setTimeout(function () { suppressClick = false; }, 400);
                // 长按点防溢出：菜单以合成坐标为锚，限制在屏幕安全范围内
                var cx = Math.min(Math.max(sx, MENU_EST_W / 2 + 8), window.innerWidth - MENU_EST_W / 2 - 8);
                var cy = Math.min(Math.max(sy, 40), window.innerHeight - 80);
                var ev = new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy
                });
                t.dispatchEvent(ev);
            }, LONG_PRESS_MS);

            function onCancel() {
                clearLongPress();
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onCancel);
            }
            function onMove(e2) {
                var t2 = e2.touches[0];
                if (Math.abs(t2.clientX - sx) > MOVE_CANCEL_PX || Math.abs(t2.clientY - sy) > MOVE_CANCEL_PX) {
                    onCancel();
                }
            }
            function onEnd() { onCancel(); }
            document.addEventListener('touchmove', onMove, { passive: true });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onCancel);
        }, { passive: true });

        // 长按后的 click 抑制（capture 阶段拦截，避免打开图片查看器等误触）
        document.addEventListener('click', function (e) {
            if (suppressClick) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    /* ---------- 4. Capacitor 环境：window.open 改同窗跳转 ---------- */
    // 图片查看器（image-viewer.html）等独立页面在手机 WebView 中弹新窗口体验差，
    // 同窗跳转后可用系统返回手势/返回键回聊天页；PC/WEB 端不受影响
    if (isNative) {
        window.open = function (u) {
            if (u) window.location.href = u;
            return null;
        };
    }

    /* ---------- 5. 输入框聚焦跟随滚底 ---------- */
    // 键盘弹出（Android adjustResize）后消息区变矮，若原本贴近底部则跟随滚到最新消息
    var focusScrollTimer = null;
    document.addEventListener('focusin', function (e) {
        if (!inMobile()) return;
        if (e.target && e.target.id !== 'message-input') return;
        if (focusScrollTimer) clearTimeout(focusScrollTimer);
        focusScrollTimer = setTimeout(function () {
            focusScrollTimer = null;
            var list = document.getElementById('message-list');
            if (!list) return;
            var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
            if (nearBottom) list.scrollTop = list.scrollHeight;
        }, 350); // 等待键盘动画与 WebView resize 完成
    });
})();
