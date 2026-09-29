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
        var was = root.classList.contains('m');
        root.classList.toggle('m', isMobileView());
        // 阶段一百九十七：退出移动布局时收起移动专属浮层（浏览器窗口从窄拉宽的场景）
        if (was && !root.classList.contains('m')) {
            var pp = document.getElementById('mobile-plus-panel');
            if (pp) pp.classList.add('hidden');
            // 阶段一百九十九：首页加号下拉菜单同款收纳
            var mpm = document.getElementById('m-plus-menu');
            if (mpm) mpm.classList.add('hidden');
        }
    }
    window.addEventListener('resize', applyViewport);
    // 阶段二百零四：页面恢复/切后台回来时重校准视口态（防 WebView 恢复时序或
    // 异常脚本移除 html.m 后卡在 PC 布局；APP 真机切前台场景同样受益）
    window.addEventListener('pageshow', applyViewport);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) applyViewport();
    });
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
            '#conv-list li, #user-list li.user-item, #ai-agent-list li, #search-panel li, #search-panel .search-item, .ann-cat-entry'
        );
        // .ann-cat-entry（阶段二百零八）：公告/动态/红头文件分类卡牌——公告流显示在
        // main-chat 内，移动布局下须切入聊天视图才能看见（否则点击"无反应"）
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
        // 退回列表时收起聊天页内浮层（表情面板/会话内搜索/移动端「+」面板），避免状态残留
        var ep = document.getElementById('emoji-panel');
        if (ep) ep.classList.add('hidden');
        var cs = document.getElementById('conv-search');
        if (cs) cs.classList.add('hidden');
        var pp = document.getElementById('mobile-plus-panel');
        if (pp) pp.classList.add('hidden');
        // 阶段一百九十九：首页顶栏加号下拉菜单同款收纳
        var mpm = document.getElementById('m-plus-menu');
        if (mpm) mpm.classList.add('hidden');
        // 阶段二百：聊天页头部···菜单同款收纳
        var cmm = document.getElementById('chat-more-menu');
        if (cmm) cmm.classList.add('hidden');
    }

    // 顶部返回按钮绑定见 initMobileHome（阶段二百修复：head 同步加载时 body 未解析，
    // 顶层 getElementById 恒为 null，原顶层绑定从未生效）

    // Android 物理返回键：Capacitor 桥接为 WebView history 后退 → popstate
    window.addEventListener('popstate', function () {
        if (!inMobile()) return;
        if (document.body.classList.contains('in-chat')) exitChat();
    });

    /* ---------- 2.5 Android 返回手势/返回键：逐级返回（微信同款） ---------- */
    // 系统侧滑返回手势与返回键经 Capacitor App 插件派发 backButton（监听后系统不再
    // 自动 history.back / 退后台），由这里按"最上层优先"逐级归口——全部委托既有
    // 按钮 click 链路（零逻辑复制）。无可返回层级时最小化到后台（微信同款），
    // 不再出现"子页面侧滑直接退到后台"
    if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        var sysApp = window.Capacitor.Plugins.App;
        sysApp.addListener('backButton', function () {
            if (!inMobile()) { sysApp.exitApp(); return; }
            // 1) 扫码视图
            var scanMask = document.getElementById('qr-scan-mask');
            if (scanMask && !scanMask.classList.contains('hidden')) {
                var sc = document.getElementById('qr-scan-cancel');
                if (sc) sc.click();
                return;
            }
            // 2) 二维码名片
            var qcm = document.getElementById('qr-card-mask');
            if (qcm && !qcm.classList.contains('hidden')) {
                var qc = document.getElementById('qr-card-close');
                if (qc) qc.click();
                return;
            }
            // 3) 发起群聊/邀请成员（chat.js push 关闭归口，侧滑带滑出动画）
            var gm = document.getElementById('grp-mask');
            if (gm && !gm.classList.contains('hidden')) {
                var gc = document.getElementById('grp-cancel');
                if (gc) gc.click();
                return;
            }
            // 4) 添加好友（同上 push 关闭归口）
            var afm = document.getElementById('add-friend-mask');
            if (afm && !afm.classList.contains('hidden')) {
                var ac = document.getElementById('add-friend-cancel');
                if (ac) ac.click();
                return;
            }
            // 5) 聊天页浮层（表情面板/会话内搜索/移动加号面板/首页加号菜单/更多菜单）
            var floatIds = ['emoji-panel', 'conv-search', 'mobile-plus-panel', 'm-plus-menu', 'chat-more-menu'];
            for (var fi = 0; fi < floatIds.length; fi++) {
                var fel = document.getElementById(floatIds[fi]);
                if (fel && !fel.classList.contains('hidden')) {
                    fel.classList.add('hidden');
                    return;
                }
            }
            // 6) 新的朋友（chat.js 关闭归口 + mobile.js 既有委托退视图）
            var nfp = document.getElementById('new-friends-panel');
            if (nfp && !nfp.classList.contains('hidden')) {
                var nc = document.getElementById('new-friends-close');
                if (nc) nc.click();
                return;
            }
            // 7) 网盘页打开态：委托 drive.js 返回分级（子目录→上级/搜索态→回前/根→关页）；
            //    关页后由 mobile.js 既有 #drive-close 委托联动 exitChat
            if (window.IMDrive && IMDrive.isOpen()) {
                var dc = document.getElementById('drive-close');
                if (dc) dc.click();
                return;
            }
            // 8) 公告流打开 → 返回公告分类列表（mobile.js 既有委托联动 exitChat）
            var asc = document.getElementById('ann-stream-close');
            if (asc && getComputedStyle(asc).display !== 'none') {
                asc.click();
                return;
            }
            // 9) 聊天视图 → 列表（并清 enterChat 推入的历史，保持栈平衡）
            if (document.body.classList.contains('in-chat')) {
                exitChat();
                try { if (history.state) history.back(); } catch (err) { /* 栈操作失败不影响视图 */ }
                return;
            }
            // 10) 首页列表视图 → 最小化到后台（微信同款，不杀进程）
            sysApp.minimizeApp();
        });
    }

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

    /* ---------- 2.6 系统状态栏跟随主题（微信同款：状态栏与顶栏同色无缝） ---------- */
    // Android WebView 默认状态栏走系统色（vivo 等显示灰色），与 APP 深色顶栏割裂。
    // @capacitor/status-bar（原生层已随 APK 编译）读首页顶栏实际背景色动态染色，
    // 图标深浅按背景亮度自适应；html[data-theme] 切换时实时跟随。
    // 浏览器/插件缺省时整体旁路（PC/WEB 端无系统状态栏概念，零影响）。
    function syncStatusBar() {
        if (!isNative) return;
        var cap = window.Capacitor && window.Capacitor.Plugins;
        var SB = cap && cap.StatusBar;
        if (!SB || !SB.setBackgroundColor) return;
        var topbar = document.querySelector('.m-home-topbar');
        if (!topbar || !inMobile()) return;
        var rgb = getComputedStyle(topbar).backgroundColor; // "rgb(r, g, b)"
        var m = rgb && rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return;
        var r = +m[1], g = +m[2], b = +m[3];
        try {
            SB.setBackgroundColor({ color: '#' + [r, g, b].map(function (c) {
                return ('0' + c.toString(16)).slice(-2);
            }).join('') });
            // 感知亮度决定状态栏图标深浅：浅色背景配黑图标（LIGHT），深色背景配白图标（DARK）
            var lum = 0.299 * r + 0.587 * g + 0.114 * b;
            SB.setStyle({ style: lum > 140 ? 'LIGHT' : 'DARK' });
        } catch (err) { /* 状态栏染色失败不影响功能 */ }
    }
    // 主题/布局变化实时跟随：html data-theme 属性切换（chat.js applyTheme 归口）
    new MutationObserver(syncStatusBar).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('DOMContentLoaded', syncStatusBar);
    // 首页顶栏随移动布局类开合（浏览器窄窗切换 html.m 的场景）
    new MutationObserver(syncStatusBar).observe(root, { attributes: true, attributeFilter: ['class'] });

    // 阶段二百零七：网盘页视图桥接——drive-view（文件区/上传工具栏）是挂在 main-chat 内的
    // absolute 全屏浮层，移动布局下 main-chat 平移到视口外，直接切网盘 tab 只能看到
    // side-bar 里的目录列表，文件区永远在屏幕外（表现为"没有上传入口"）。
    // 方案：点网盘目录条目（我的文件/共享文件夹/群文件/回收站）时滑入聊天视图（in-chat），
    // 网盘页随之全屏盖住消息区；返回键关闭页面时退出视图回到目录列表。
    // 阶段二百零八：注册在 bubble 阶段——drive.js 的返回键分级 handler（target 层）先执行，
    // 这里用 IMDrive.isOpen() 判断是否真的关页：关页立即 exitChat（main-chat 带着仍显示的
    // 网盘页整体滑出，不闪现底下消息区；hidden 由 drive.js 延迟 260ms 归口）；
    // 子目录/搜索态返回未关页则不动视图
    document.addEventListener('click', function (e) {
        if (!inMobile()) return;
        if (e.target.closest('#drive-panel .new-friends-entry')) {
            enterChat();
        } else if (e.target.closest('#drive-close')) {
            if (window.IMDrive && !window.IMDrive.isOpen()) exitChat();
        } else if (e.target.closest('#ann-stream-close')) {
            // 公告流"返回"（阶段二百零八）：关流由 chat.js 归口，这里补退回列表视图——
            // 移动端一击直达公告分类列表，不停留在空聊天页；PC 端"返回聊天"语义不变
            exitChat();
        }
    });

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

    /* ---------- 6. 阶段一百九十七：微信手机版一行式输入行接线 ---------- */
    // 语音气泡切换"按住 说话"条 / 「+」面板开合与条目转发 / 发送-加号随输入内容互换。
    // 原则：业务逻辑零复制——面板条目仅转发点击到既有工具按钮，会话类型分流仍归口 chat.js。
    // 注意：本脚本在 <head> 加载（DOM 未解析），元素获取与绑定须等 DOMContentLoaded
    function initMobileInputRow() {
        var inputBar = document.getElementById('input-bar');
        var voiceToggleBtn = document.getElementById('voice-toggle-btn');
        var holdToTalk = document.getElementById('hold-to-talk');
        var mobilePlusBtn = document.getElementById('mobile-plus-btn');
        var mobilePlusPanel = document.getElementById('mobile-plus-panel');

        if (!inputBar || !voiceToggleBtn || !mobilePlusBtn || !mobilePlusPanel) return;

        function hideMobilePlusPanel() {
            mobilePlusPanel.classList.add('hidden');
        }

        // 6.1 语音模式切换（录音链路阶段一百九十八接线，本处只负责视图态与互斥）
        voiceToggleBtn.addEventListener('click', function () {
            var on = inputBar.classList.toggle('voice-mode');
            voiceToggleBtn.classList.toggle('active', on);
            // 阶段二百零二修复：同步"按住 说话"条显隐——.hidden 带 !important，
            // 仅靠 voice-mode 的 CSS display:flex 规则无法显示（表现为中间空缺）
            if (holdToTalk) holdToTalk.classList.toggle('hidden', !on);
            hideMobilePlusPanel();
            var ep = document.getElementById('emoji-panel');
            if (ep) ep.classList.add('hidden');
        });

        // 6.2 「+」面板开合（与表情面板互斥；点击面板外自动收起）
        mobilePlusBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var willShow = mobilePlusPanel.classList.contains('hidden');
            mobilePlusPanel.classList.toggle('hidden', !willShow);
            if (willShow) {
                var ep2 = document.getElementById('emoji-panel');
                if (ep2) ep2.classList.add('hidden');
            }
        });
        // 阶段二百零一修复：反向互斥——表情面板与「+」面板均为流式占位布局，
        // 同开会纵向叠加挤压消息区，点表情按钮时须收起「+」面板（此前只做了单向）
        var emojiBtn = document.getElementById('emoji-btn');
        if (emojiBtn) {
            emojiBtn.addEventListener('click', function () {
                hideMobilePlusPanel();
            });
        }
        document.addEventListener('click', function (e) {
            if (mobilePlusPanel.classList.contains('hidden')) return;
            if (e.target.closest('#mobile-plus-panel') || e.target.closest('#mobile-plus-btn')) return;
            hideMobilePlusPanel();
        });

        // 6.3 条目点击 → 转发到既有工具按钮（业务归口 chat.js，零逻辑复制）
        mobilePlusPanel.addEventListener('click', function (e) {
            var item = e.target.closest('.mp-item');
            if (!item) return;
            var target = document.getElementById(item.getAttribute('data-target'));
            hideMobilePlusPanel();
            if (target) target.click();
        });

        // 6.4 条目显隐镜像：MutationObserver 跟随既有按钮 hidden 态
        //    （chat.js 按会话类型切 hidden 时手机面板自动跟随，通话/会议放开后此处零改动）
        var mpItems = mobilePlusPanel.querySelectorAll('.mp-item[data-target]');
        Array.prototype.forEach.call(mpItems, function (item) {
            var btn = document.getElementById(item.getAttribute('data-target'));
            if (!btn) {
                item.classList.add('hidden');
                return;
            }
            var mirror = function () {
                item.classList.toggle('hidden', btn.classList.contains('hidden'));
            };
            mirror();
            try {
                new MutationObserver(mirror).observe(btn, { attributes: true, attributeFilter: ['class'] });
            } catch (err) { /* 观察失败仅影响镜像跟随，转发链路不受影响 */ }
        });

        // 6.5 发送/加号互换（微信同款）：输入非空显示发送、隐藏加号；AI 停止态不受影响
        var msgInput = document.getElementById('message-input');
        function syncHasText() {
            inputBar.classList.toggle('has-text', !!(msgInput && msgInput.value));
            // 阶段二百：输入内容变化同步输入框高度（微信式自动长高，函数由 initMobileHome 挂载）
            if (window.__imMobileInputGrow) window.__imMobileInputGrow();
        }
        if (msgInput) {
            msgInput.addEventListener('input', syncHasText);
            // 程序化赋值（发送清空/会话切换草稿等）同样触发同步：实例级 value 存取器包装
            try {
                var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                if (desc && desc.set) {
                    Object.defineProperty(msgInput, 'value', {
                        get: function () { return desc.get.call(this); },
                        set: function (v) { desc.set.call(this, v); syncHasText(); },
                        configurable: true
                    });
                }
            } catch (err) { /* 包装失败仅影响按钮互换时机，不影响收发功能 */ }
            syncHasText();
        }

        // 6.6 阶段一百九十八：按住说话录音手势（微信同款：按下即录、松开发送、上滑取消、60s 上限）
        // 录音手势/浮层归口本文件，发送归口 chat.js（window.__imSendVoice），零逻辑复制
        if (holdToTalk) {
            var REC_MAX_MS = 60000;   // 60s 上限自动发送（微信同款）
            var REC_CANCEL_PX = 80;   // 上滑取消阈值
            var recState = { recorder: null, stream: null, chunks: [], mime: '', startTs: 0, timer: null, cancelled: false, startY: 0, active: false };
            var recTip = document.getElementById('voice-rec-tip');

            function mToast(text) {
                if (window.__imToast) window.__imToast(text);
            }

            // 浮层文案切换（普通发送态 / 上滑取消态，自绘浮层禁系统弹窗）
            function recTipSet(cancelMode) {
                if (!recTip) return;
                recTip.classList.toggle('cancel', !!cancelMode);
                var t = recTip.querySelector('.vrt-text');
                if (t) t.textContent = I18N.t(cancelMode ? '松开手指 取消发送' : '松开发送');
            }
            function recTipShow() {
                if (!recTip) return;
                recTip.classList.remove('hidden');
                recTip.classList.remove('cancel');
                recTipSet(false);
            }
            function recTipHide() {
                if (recTip) recTip.classList.add('hidden');
            }

            // 收口：停流、清定时器、复原按压态与浮层（每条路径出口统一走此函数防状态残留）
            function recCleanup() {
                if (recState.timer) { clearTimeout(recState.timer); recState.timer = null; }
                if (recState.stream) {
                    try { recState.stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) { }
                    recState.stream = null;
                }
                recState.recorder = null;
                recState.chunks = [];
                recState.active = false;
                recState.cancelled = false;
                holdToTalk.classList.remove('pressing');
                recTipHide();
            }

            // 结束录音：send=true 且未取消且时长≥1s → 组装 blob 交 chat.js 发送，否则丢弃
            function recFinish(send) {
                var rec = recState.recorder;
                if (!rec) { recCleanup(); return; }
                var dur = Math.max(1, Math.round((Date.now() - recState.startTs) / 1000));
                if (!send || recState.cancelled || !recState.startTs) {
                    rec.onstop = null; // 丢弃场景不组装 blob，onstop 摘除防误发送
                    try { rec.stop(); } catch (e) { }
                    recCleanup();
                    return;
                }
                if ((Date.now() - recState.startTs) < 1000) {
                    rec.onstop = null;
                    try { rec.stop(); } catch (e) { }
                    recCleanup();
                    mToast(I18N.t('说话时间太短'));
                    return;
                }
                rec.onstop = function () {
                    var blob = new Blob(recState.chunks, { type: recState.mime || 'audio/webm' });
                    recCleanup();
                    if (blob.size > 0 && window.__imSendVoice) window.__imSendVoice(blob, dur);
                };
                try { rec.stop(); } catch (e) { recCleanup(); }
            }

            holdToTalk.addEventListener('pointerdown', function (e) {
                e.preventDefault(); // 防长按系统菜单/文本选择
                if (recState.active) return;
                if (!window.__imSendVoice) return; // chat.js 未就绪（异常场景）不进入录音
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
                    mToast(I18N.t('当前环境不支持录音'));
                    return;
                }
                recState.active = true;
                recState.cancelled = false;
                recState.startY = e.clientY;
                recState.chunks = [];
                recState.startTs = 0;
                recTipShow();
                holdToTalk.classList.add('pressing');
                // 指针捕获：手指移出按钮（上滑取消）后 move/up 事件仍派发本元素
                try { if (holdToTalk.setPointerCapture) holdToTalk.setPointerCapture(e.pointerId); } catch (err) { }
                navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
                    if (!recState.active) { // 手指已松开（极短按压）：直接释放不录
                        try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (er) { }
                        return;
                    }
                    recState.stream = stream;
                    // mime 优先级：Android Chromium → webm/opus（接收端同为 Chromium 内核全兼容）
                    var mime = '';
                    var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
                    for (var i = 0; i < cands.length; i++) {
                        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) { mime = cands[i]; break; }
                    }
                    var rec;
                    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
                    catch (err) {
                        recCleanup();
                        mToast(I18N.t('无法访问麦克风'));
                        return;
                    }
                    recState.recorder = rec;
                    recState.mime = mime ? mime.split(';')[0] : '';
                    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) recState.chunks.push(ev.data); };
                    rec.onerror = function () {
                        recFinish(false);
                        mToast(I18N.t('录音失败，请重试'));
                    };
                    rec.start(200); // 200ms 分片：松开瞬间已有数据在手，短语音不丢尾
                    recState.startTs = Date.now();
                    // 60s 上限自动发送（微信同款）
                    recState.timer = setTimeout(function () { recFinish(true); }, REC_MAX_MS);
                }).catch(function () {
                    var wasActive = recState.active;
                    recCleanup();
                    if (wasActive) mToast(I18N.t('无法访问麦克风'));
                });
            });
            // 上滑取消判定：起始 Y 上移超过阈值 → 浮层切取消态（实时跟随手指回正）
            holdToTalk.addEventListener('pointermove', function (e) {
                if (!recState.active) return;
                var dy = recState.startY - e.clientY;
                var willCancel = dy > REC_CANCEL_PX;
                recState.cancelled = willCancel;
                recTipSet(willCancel);
            });
            holdToTalk.addEventListener('pointerup', function () {
                if (!recState.active) { holdToTalk.classList.remove('pressing'); return; }
                recFinish(!recState.cancelled);
            });
            holdToTalk.addEventListener('pointercancel', function () {
                // 系统打断（来电/手势冲突）：视为取消丢弃，不误发送半截录音
                if (recState.active) recFinish(false);
                holdToTalk.classList.remove('pressing');
            });
        }
    }

    /* ---------- 7. 阶段一百九十九：微信式首页顶栏与个人页收纳接线 ---------- */
    // 顶栏搜索展开既有搜索框 / 加号下拉菜单开合与条目转发 / 个人页入口块转发。
    // 原则同第 6 段：仅转发点击到既有按钮/tab，业务归口 chat.js 零复制
    function initMobileHome() {
        var searchBar = document.querySelector('.search-bar');
        var searchInput = document.getElementById('search-input');
        var plusMenu = document.getElementById('m-plus-menu');
        var plusBtn = document.getElementById('m-home-plus');
        var searchBtn = document.getElementById('m-home-search');

        // 7.0 阶段二百：输入框微信式自动长高（40px 一行起步，最多 120px 约 5 行）。
        //     接管 PC 端 resizer 写入的 inline 高度；非移动布局恢复清空交还 PC 逻辑。
        //     触发归口 syncHasText（input 事件 + value 存取器包装都经过它），此处仅挂载实现。
        //     注意先压回一行再读 scrollHeight：textarea 受 rows 属性影响，height:auto 时
        //     scrollHeight 反映默认行数而非真实内容（会虚高成 3 行 76px）
        window.__imMobileInputGrow = function () {
            var mi = document.getElementById('message-input');
            if (!mi) return;
            if (!root.classList.contains('m')) {
                if (mi.style.height) mi.style.height = '';
                return;
            }
            mi.style.height = '40px';
            var h = Math.min(Math.max(mi.scrollHeight, 40), 120);
            mi.style.height = h + 'px';
        };
        window.__imMobileInputGrow();

        // 7.0c 阶段二百：聊天页返回按钮（原顶层绑定因 head 加载时 DOM 未解析而失效，
        //      挪至 DOMContentLoaded 后；原生环境走 popstate 统一清理历史栈）
        var backBtn2 = document.getElementById('mobile-back');
        if (backBtn2) {
            backBtn2.addEventListener('click', function () {
                if (isNative && history.state) {
                    history.back();
                } else {
                    exitChat();
                }
            });
        }

        // 7.0b 阶段二百：聊天页头部 ··· 菜单（镜像 header-actions 可用功能，点击转发）
        var moreBtn = document.getElementById('chat-more-btn');
        var moreMenu = document.getElementById('chat-more-menu');
        if (moreBtn && moreMenu) {
            var hideMoreMenu = function () { moreMenu.classList.add('hidden'); };
            // 打开时动态镜像：枚举无 hidden 类的头部按钮生成条目（图标+title），
            // chat.js 按会话类型切 hidden（邀请/记忆/看板等），每次打开重新枚举即跟随
            moreBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var willShow = moreMenu.classList.contains('hidden');
                if (willShow) {
                    moreMenu.innerHTML = '';
                    var btns = document.querySelectorAll('.chat-header .header-actions > button:not(#chat-more-btn)');
                    Array.prototype.forEach.call(btns, function (btn) {
                        if (btn.classList.contains('hidden')) return;
                        var item = document.createElement('button');
                        item.className = 'chat-more-item';
                        var label = btn.getAttribute('title') || '功能';
                        item.setAttribute('data-target', btn.id);
                        item.innerHTML = btn.querySelector('svg') ? btn.querySelector('svg').outerHTML : '';
                        var txt = document.createElement('span');
                        txt.textContent = label;
                        item.appendChild(txt);
                        moreMenu.appendChild(item);
                    });
                }
                moreMenu.classList.toggle('hidden', !willShow);
                if (willShow) hidePlusMenu();
            });
            moreMenu.addEventListener('click', function (e) {
                var item = e.target.closest('.chat-more-item');
                if (!item) return;
                var target = document.getElementById(item.getAttribute('data-target'));
                hideMoreMenu();
                if (target) target.click();
            });
            document.addEventListener('click', function (e) {
                if (moreMenu.classList.contains('hidden')) return;
                if (e.target.closest('#chat-more-menu') || e.target.closest('#chat-more-btn')) return;
                hideMoreMenu();
            });
        }

        if (!searchBtn || !plusBtn || !plusMenu) return; // 页面未含顶栏（旧缓存等）直接旁路

        function hidePlusMenu() {
            plusMenu.classList.add('hidden');
        }

        // 7.1 顶栏搜索：展开/收起既有搜索框并聚焦（微信同款进入搜索的动作）
        if (searchBar) {
            searchBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                hidePlusMenu();
                var open = searchBar.classList.toggle('search-open');
                if (open && searchInput) searchInput.focus();
            });
        }

        // 7.2 加号下拉菜单开合（点击外部关闭，自绘浮层不用系统弹窗）
        plusBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            plusMenu.classList.toggle('hidden');
        });
        document.addEventListener('click', function (e) {
            if (plusMenu.classList.contains('hidden')) return;
            if (e.target.closest('#m-plus-menu') || e.target.closest('#m-home-plus')) return;
            hidePlusMenu();
        });

        // 7.3 加号菜单条目转发：目标入口在好友面板（通讯录 tab）内时先切 tab 再转发
        //    （面板 hidden 时直接 click 不生效）；添加好友按钮在 nav-bottom，click 转发恒有效
        plusMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.m-plus-item');
            if (!item) return;
            var target = document.getElementById(item.getAttribute('data-target'));
            hidePlusMenu();
            if (!target) return;
            var panel = target.closest('.friends-panel');
            if (panel && panel.classList.contains('hidden')) {
                var friendsTab = document.querySelector('.nav-icon[data-tab="friends"]');
                if (friendsTab) friendsTab.click();
            }
            target.click();
        });

        // 7.4 个人页入口块转发：data-target-tab 先关个人页再切侧栏 tab（公告/网盘），
        //     data-target 直接转发既有按钮（主题切换/退出登录）
        //     阶段二百零六修正：容器类已改为 .mpc-actions（分组卡片），选择器须同步，
        //     否则 querySelector 落空导致公告/网盘/主题/退出四条目全部无反应
        document.querySelectorAll('.mpc-actions').forEach(function (actions) {
            actions.addEventListener('click', function (e) {
                var item = e.target.closest('.mpa-item');
                if (!item) return;
                var tabName = item.getAttribute('data-target-tab');
                var targetId = item.getAttribute('data-target');
                if (tabName) {
                    var closeBtn = document.getElementById('profile-close');
                    if (closeBtn) closeBtn.click(); // 关闭个人页
                    // 阶段二百零七修正：个人页是聊天视图内的浮层，关闭≠退视图；
                    // 不退回列表视图的话 main-chat 仍滑入占据屏幕，而公告/网盘面板
                    // 在滑出视口的 side-bar 里，用户只看到空聊天页（误以为打开了好友界面）
                    exitChat();
                    var tabBtn = document.querySelector('.nav-icon[data-tab="' + tabName + '"]');
                    if (tabBtn) tabBtn.click();
                } else if (targetId) {
                    var btn = document.getElementById(targetId);
                    if (btn) btn.click();
                }
            });
        });
    }

    function initAll() {
        initMobileInputRow();
        initMobileHome();
        initNavLabels();
        initHomeTitle();
    }

    /* ---------- 8. 阶段二百零五：底栏文字标签改真实 DOM ----------
       ::after content(attr) 伪元素在 WebView/GPU 合成层动画后存在渲染丢失
       （tab 切换几次后部分标签不重绘消失，computed 样式却正常），
       改为注入真实 span 彻底根治；PC 端该 span 由 CSS 恒隐藏 */
    function initNavLabels() {
        document.querySelectorAll('.nav-icons .nav-icon').forEach(function (n) {
            if (n.querySelector('.nav-label')) return;
            var t = n.getAttribute('title');
            if (!t) return;
            var s = document.createElement('span');
            s.className = 'nav-label';
            s.textContent = t;
            n.appendChild(s);
        });
        var navTop = document.querySelector('.nav-rail .nav-top');
        if (navTop && !navTop.querySelector('.nav-label')) {
            var me = document.createElement('span');
            me.className = 'nav-label';
            me.textContent = '我';
            navTop.appendChild(me);
        }
    }

    /* ---------- 9. 阶段二百零九：首页顶栏标题随 tab 联动（微信同款） ----------
       状态驱动：MutationObserver 监听 tab active 类变化即同步标题——
       任何来源的切换（底栏点击/功能卡转发/chat.js 内部切换）都覆盖，
       不依赖 click 冒泡（APP WebView 事件流与浏览器存在差异，委托会漏） */
    function initHomeTitle() {
        var homeTitle = document.querySelector('.m-home-title');
        if (!homeTitle) return;
        var TAB_NAMES = { chat: '聊天', friends: '通讯录', ai: 'AI助手', workbench: '工作台', announcement: '公告', drive: '网盘' };
        function syncTitle() {
            var a = document.querySelector('.sidebar-tab.active');
            if (a) {
                var n = TAB_NAMES[a.getAttribute('data-tab')];
                if (n) homeTitle.textContent = n;
            }
        }
        var mo = new MutationObserver(syncTitle);
        document.querySelectorAll('.sidebar-tab').forEach(function (t) {
            mo.observe(t, { attributes: true, attributeFilter: ['class'] });
        });
        syncTitle();
        // 个人页（头像，无 active 类机制）保留点击委托
        document.addEventListener('click', function (e) {
            if (!inMobile()) return;
            if (e.target.closest('.nav-top')) homeTitle.textContent = '我';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }
})();
