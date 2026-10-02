/* ===== 阶段一百四十五：WEB 端（浏览器）通话桥 =====
   职责：纯浏览器环境（无 Electron preload）下以页内形态承载音视频通话，与 PC 端信令协议完全同构——
   1. 通话窗：同源 iframe 承载 call-window.html（复用 PC 端 WebRTC 引擎），postMessage 三段桥替代 IPC；
      尺寸/居中/信令缓冲对齐 PC 主进程（callSigQueue 同语义：iframe 就绪前的下行信令缓冲，就绪后按到达序回放）
   2. 响铃条：页内顶部弹条（微信同款），WebAudio 合成振铃音（零资源文件），铃声参数对齐 call-ring.js
   3. 能力注入：window.desktop 上仅填充通话相关方法（其余 PC 能力保持 undefined，截图/工具链等不受影响）
   激活条件：非 Electron（window.desktop 不存在）。
   阶段一百九十八：手机 APP 端（Capacitor）解除旁路——Android WebView 同源 iframe + WebRTC 可用，
   与浏览器同链路复用（platform 上报 'app'，服务端 hub.HasCall 已归口）；通话窗/响铃条按移动视口全屏适配。
   消息协议（父页 ↔ 通话窗 iframe，同源 postMessage）：
   父→iframe：{src:'web-call-bridge', t:'call:load'|'call:signal'|'call:window-close', ...}
   iframe→父：{src:'web-call-page',  t:'call:send'|'call:close'|'meet:invite-ask', ...} */
(function () {
    'use strict';
    // 激活判定：PC 端 preload 已注入 window.desktop（整脚本旁路）。
    // 原实现：Capacitor 手机端恒旁路（一期手机端不支持通话，按钮维持隐藏）；
    // 阶段一百九十八：手机端解除旁路（Android WebView WebView Chrome 内核完整支持 WebRTC，
    // 运行时权限由 Capacitor BridgeWebChromeClient 内建 onPermissionRequest 桥接弹窗授权）
    if (window.desktop) return;
    var isApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

    // ===== 阶段二百四十九：原生回前台转发（APP 端通话媒体自愈，微信同款） =====
    // MainActivity.onResume 原生广播 im-resume；Capacitor 原生桥只注入主文档，通话 iframe 内
    // 的 call-page.js 拿不到 App 插件的 appStateChange（vivo 断流自愈监听此前从未触发）——
    // 故自愈监听在主文档注册，收到广播后转发给通话窗 iframe 执行 healMediaOnResume
    window.addEventListener('im-resume', function () {
        if (callFrame && callFrame.contentWindow) {
            try {
                callFrame.contentWindow.postMessage({ src: 'web-call-bridge', t: 'call:resumed' }, location.origin);
            } catch (e) { }
        }
    });

    // ===== 回调登记（chat.js 经 window.desktop.onXxx 注册，语义与 PC preload 一致） =====
    var cbCallSend = null;       // 通话窗上行信令（chat.js 经 WS 发出）
    var cbRingAction = null;     // 响铃条按钮动作（accept/decline，chat.js 归口发信令/开窗）
    var cbClosed = null;         // 通话窗已关闭（chat.js 清本端通话态）
    var cbMeetInviteAsk = null;  // 会议窗邀请请求（chat.js 弹会议选人弹窗）

    // ===== 通话窗 iframe（单例，对齐 PC callWin） =====
    var callFrame = null;        // iframe DOM
    var frameReady = false;      // iframe onload 完成（call:load 已投递，信令可直接转发）
    var pendingLoad = null;      // 就绪前缓存的开窗任务
    var sigQueue = [];           // 就绪前缓冲的下行信令（对齐 PC callSigQueue：room_info 早于窗口就绪的竞态）

    // 通话窗尺寸按类型分形态（与 PC main.js callWindowSize 完全同款：语音竖版小窗/视频横版大窗/会议宫格）
    // 阶段一百九十八：手机 APP 端（Capacitor，屏幕窄）统一近全屏形态——微信手机版通话为全屏页，
    // iframe 满视口承载（内部页面 flex/absolute 布局天然自适应，会议窄屏另有 @media 收缩列宽）
    function frameSize(callType, isMeet) {
        if (isApp || window.innerWidth <= 500) {
            return { w: window.innerWidth, h: window.innerHeight };
        }
        // 阶段一百五十一：会议视频 1100×700 → 1366×860（腾讯会议同款共享主舞台需要大画面，原 1280×800），
        // 并按视口收敛（浏览器弹层不超出可视区，边距 40→24 再让一档给画面）；语音会议与 1v1 各形态不变
        if (isMeet) {
            if (callType !== 'video') return { w: 420, h: 620 };
            return { w: Math.min(1366, window.innerWidth - 24), h: Math.min(860, window.innerHeight - 24) };
        }
        return callType === 'video' ? { w: 860, h: 620 } : { w: 360, h: 560 };
    }

    // 注入样式（响铃条 + 通话窗弹层；类名 wcb- 前缀避免与主页面冲突）
    var css = document.createElement('style');
    css.textContent =
        /* 通话窗弹层：居中浮动卡片（浏览器无独立窗口，深色沉浸 + 圆角阴影同款观感） */
        '.wcb-frame{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
        'border:none;border-radius:12px;overflow:hidden;z-index:100000;background:#161819;' +
        'box-shadow:0 12px 48px rgba(0,0,0,0.5);max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);}' +
        /* 来电响铃条：页内顶部弹条（微信同款 372×100 深色条，滑入动画） */
        '.wcb-ring{position:fixed;top:14px;left:50%;transform:translateX(-50%);width:372px;max-width:calc(100vw - 24px);' +
        'height:100px;display:flex;align-items:center;gap:12px;padding:0 14px;box-sizing:border-box;' +
        'background:#222629;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.45);z-index:99999;' +
        'color:#fff;font-family:"Microsoft YaHei","PingFang SC",sans-serif;user-select:none;' +
        'animation:wcbSlideIn .25s ease-out;}@keyframes wcbSlideIn{from{opacity:0;transform:translate(-50%,-16px);}to{opacity:1;transform:translate(-50%,0);}}' +
        '.wcb-ring-ava{width:52px;height:52px;border-radius:50%;overflow:hidden;background:#3a4048;flex-shrink:0;}' +
        '.wcb-ring-ava img{width:100%;height:100%;object-fit:cover;}' +
        '.wcb-ring-ava-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:22px;color:#dfe3e8;background:#4a5568;}' +
        '.wcb-ring-info{flex:1;min-width:0;}' +
        '.wcb-ring-name{font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.wcb-ring-desc{margin-top:3px;font-size:12px;color:#9aa3ad;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.wcb-ring-btn{width:42px;height:42px;border-radius:50%;border:none;cursor:pointer;display:flex;' +
        'align-items:center;justify-content:center;color:#fff;outline:none;padding:0;flex-shrink:0;transition:filter .12s;}' +
        '.wcb-ring-btn:hover{filter:brightness(1.12);}' +
        '.wcb-ring-btn:active{filter:brightness(.92);}' +
        '.wcb-ring-decline{background:#fa5151;}.wcb-ring-decline:hover{background:#e64340;filter:none;}' +
        '.wcb-ring-accept{background:#07c160;}.wcb-ring-accept:hover{background:#06ad56;filter:none;}' +
        '.wcb-ring-btn.hidden{display:none;}' +
        /* 手机 APP 端全屏来电页（微信同款）：满屏深色沉浸，来电头像放大模糊暗化作背景，
           中部大圆头像 + 昵称 + 邀请文案，底部红/绿大圆钮（绿色接听带呼吸脉动） */
        '.wcb-ring-fs{position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;display:flex;' +
        'flex-direction:column;align-items:center;background:#101214;color:#fff;' +
        'font-family:"Microsoft YaHei","PingFang SC",sans-serif;user-select:none;-webkit-user-select:none;' +
        'animation:wcbFadeIn .25s ease-out;}@keyframes wcbFadeIn{from{opacity:0;}to{opacity:1;}}' +
        '.wcb-ringfs-bg{position:absolute;left:-40px;top:-40px;right:-40px;bottom:-40px;' +
        'background-size:cover;background-position:center;filter:blur(48px) brightness(.32) saturate(1.15);}' +
        '.wcb-ringfs-center{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;padding-bottom:10vh;width:100%;}' +
        '.wcb-ring-fs .wcb-ring-ava{width:92px;height:92px;box-shadow:0 6px 32px rgba(0,0,0,.45);}' +
        '.wcb-ring-fs .wcb-ring-ava-ph{font-size:34px;}' +
        '.wcb-ringfs-info{margin-top:22px;display:flex;flex-direction:column;align-items:center;min-width:0;}' +
        '.wcb-ring-fs .wcb-ring-name{max-width:78vw;font-size:24px;font-weight:500;text-align:center;}' +
        '.wcb-ring-fs .wcb-ring-desc{margin-top:10px;font-size:14px;color:rgba(255,255,255,.72);text-align:center;}' +
        '.wcb-ringfs-btns{position:relative;display:flex;justify-content:center;align-items:center;' +
        'gap:110px;padding-bottom:max(40px,env(safe-area-inset-bottom));width:100%;}' +
        '.wcb-ring-fs .wcb-ring-btn{width:66px;height:66px;}' +
        '.wcb-ring-fs .wcb-ring-btn svg{width:26px;height:26px;}' +
        '@keyframes wcbPulse{0%,100%{box-shadow:0 0 0 0 rgba(7,193,96,.45);}55%{box-shadow:0 0 0 14px rgba(7,193,96,0);}}' +
        '.wcb-ring-fs .wcb-ring-accept{animation:wcbPulse 1.6s ease-out infinite;}' +
        /* 阶段一百四十五：通话窗拖动把手（浏览器 iframe 吞鼠标事件，-webkit-app-region 失效，
           以父页透明条覆盖 iframe 顶部拖动区实现按住移动；对齐 PC 端拖顶部移动窗口的体验） */
        '.wcb-drag{position:fixed;height:36px;z-index:100001;cursor:move;user-select:none;-webkit-user-select:none;}' +
        /* 阶段二百四十七：通话悬浮小窗（微信同款）——122×218 竖条（9:16 对齐微信小窗比例）；
           定位全部走 inline（enterMini 设置右上角起点，拖动/吸附实时改写）——
           原 bug：类里 left:auto!important 压制 inline 定位，拖拽/吸附改 left 全部无效；
           .wcb-mini-click 为小窗覆盖层（iframe 吞触摸事件，拖动/轻点恢复全屏均在其上感知） */
        '.wcb-frame-mini{width:122px!important;height:218px!important;' +
        'border-radius:14px!important;box-shadow:0 8px 28px rgba(0,0,0,.5)!important;' +
        'max-width:none!important;max-height:none!important;transition:left .25s ease,top .25s ease;}' +
        /* 拖动中禁过渡（跟手），松手吸附/滑出恢复过渡（微信同款滑入滑出动效） */
        '.wcb-frame-mini.wcb-dragging{transition:none!important;}' +
        '.wcb-mini-click{position:fixed;z-index:100001;user-select:none;-webkit-user-select:none;}';
    document.head.appendChild(css);

    // ===== 通话窗承载 =====
    function applyFrameSize(s) {
        if (!callFrame) return;
        callFrame.style.width = s.w + 'px';
        callFrame.style.height = s.h + 'px';
        syncDragBar(); // 尺寸变化后拖动把手跟随（复用窗口切换形态场景）
    }

    // ===== 阶段一百四十五：通话窗拖动（把手覆盖 iframe 顶部 36px 拖动区） =====
    var dragBar = null; // 拖动把手 DOM（iframe 兄弟层，事件归父页处理）
    function ensureDragBar() {
        if (dragBar || !document.body) return;
        dragBar = document.createElement('div');
        dragBar.className = 'wcb-drag';
        dragBar.addEventListener('mousedown', function (e) {
            // 仅左键拖动；起点把 iframe 从"transform 居中"切到显式 left/top（此后自由定位）
            if (e.button !== 0 || !callFrame) return;
            e.preventDefault();
            var r = callFrame.getBoundingClientRect();
            // 原实现：.wcb-frame 以 left/top:50% + translate(-50%,-50%) 居中；拖动起手固定为像素定位
            callFrame.style.left = r.left + 'px';
            callFrame.style.top = r.top + 'px';
            callFrame.style.transform = 'none';
            var ox = e.clientX - r.left, oy = e.clientY - r.top;
            function onMove(ev) {
                if (!callFrame) return;
                var w = callFrame.offsetWidth, h = callFrame.offsetHeight;
                // 边界约束：水平至少留 48px 在视口内、顶边不越出（防拖丢找不回）
                var nl = Math.max(48 - w, Math.min(ev.clientX - ox, window.innerWidth - 48));
                var nt = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - 48));
                callFrame.style.left = nl + 'px';
                callFrame.style.top = nt + 'px';
                syncDragBar();
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        document.body.appendChild(dragBar);
        syncDragBar();
    }
    function syncDragBar() {
        if (!dragBar || !callFrame) return;
        var r = callFrame.getBoundingClientRect();
        dragBar.style.left = r.left + 'px';
        dragBar.style.top = r.top + 'px';
        // 阶段一百五十一补丁：右侧预留 56px 不铺把手——会议窗右上角全屏按钮位于顶部 36px 拖拽带内，
        // 把手是父页透明层会吞掉 iframe 内点击；让位后按钮可点（拖窗仍可用其余顶部区域）
        dragBar.style.width = Math.max(0, r.width - 56) + 'px';
        dragBar.style.height = '36px';
    }
    function removeDragBar() {
        if (dragBar && dragBar.parentNode) dragBar.parentNode.removeChild(dragBar);
        dragBar = null;
    }

    function postToFrame(msg) {
        if (callFrame && callFrame.contentWindow) {
            callFrame.contentWindow.postMessage(msg, location.origin);
        }
    }

    // call:load 投递（iframe onload 后 call-page.js 监听器必已注册：脚本同步先于 load 事件）
    function deliverLoad(data) {
        if (!data) return;
        postToFrame({ src: 'web-call-bridge', t: 'call:load', data: data });
    }

    function openCallFrame(data) {
        var s = frameSize(data.call_type === 'video', !!data.meet);
        curLoad = data; // 当前通话任务（悬浮小窗恢复全屏时按此重算正常尺寸）
        if (callFrame) {
            // 复用窗口切换形态（语音/视频互切场景，对齐 PC ensureCallWindow）；小窗态先复位全屏
            exitMini(true);
            applyFrameSize(s);
            deliverLoad(data);
            return;
        }
        frameReady = false;
        pendingLoad = data;
        callFrame = document.createElement('iframe');
        callFrame.className = 'wcb-frame';
        // 阶段一百九十八：手机端全屏形态去圆角阴影（微信手机版通话全屏页观感）；拖动把手无意义跳过
        if (isApp || window.innerWidth <= 500) {
            callFrame.style.borderRadius = '0';
            callFrame.style.boxShadow = 'none';
            callFrame.style.maxWidth = 'none';
            callFrame.style.maxHeight = 'none';
        }
        // iframe 权限策略：媒体设备 + 共享屏幕（同源默认 self，显式声明稳妥）
        // 阶段一百五十一：fullscreen 授权——会议窗全屏按钮（Fullscreen API 在 iframe 内需显式 allow）
        callFrame.allow = 'microphone; camera; display-capture; fullscreen';
        // 阶段一百五十一补丁：HTML 带版本号查询串防 HTTP 缓存（页面内 CSS/JS 改动浏览器端立即生效）
        callFrame.src = 'call-window.html?v=1533';
        // 任务投递采用握手制：等 iframe 内 call-page.js 就绪主动上报 page:ready（见 message 监听），
        // 不用 load 事件——动态 iframe 的 about:blank 阶段也可能触发一次 load，会误耗 pendingLoad 丢任务
        document.body.appendChild(callFrame);
        applyFrameSize(s);
        if (!isApp && window.innerWidth > 500) ensureDragBar(); // 通话窗拖动把手（阶段一百四十五；移动端跳过）
    }

    function closeCallFrame() {
        if (callFrame && callFrame.parentNode) callFrame.parentNode.removeChild(callFrame);
        callFrame = null;
        removeDragBar(); // 拖动把手随窗销毁
        exitMini(true);  // 悬浮小窗随通话销毁（静默：iframe 已不存在，不再发 mini:off）
        curLoad = null;
        frameReady = false;
        pendingLoad = null;
        sigQueue = [];
        if (cbClosed) cbClosed(); // chat.js 清本端通话态（callOpenId=''）
    }

    // ===== 阶段二百四十七：通话悬浮小窗（微信同款） =====
    // 小窗化：iframe 切 .wcb-frame-mini（122×218 竖条）+ 通知内核切 mode-mini（隐藏控制面）；
    // 交互覆盖层（.wcb-mini-click）接管触摸——按住拖动小窗、轻点（位移 < 8px）恢复全屏；
    // 贴边吸附（阶段二百四十八）：松手时距屏幕左/右缘 40px 内吸附半隐（露出 24px 边条），
    // 吸附态轻点滑出（贴边完整可见），再轻点恢复全屏；
    // 复位（silent）：挂断/互切时静默清理，不再给已销毁的 iframe 发消息
    var miniOn = false;      // 小窗态开关
    var miniClick = null;    // 小窗覆盖层（拖动 + 轻点恢复）
    var curLoad = null;      // 当前通话任务（恢复全屏时按此重算正常尺寸）
    var miniDock = null;     // 吸附边：'left' / 'right' / null

    function enterMini() {
        if (!callFrame || miniOn) return;
        miniOn = true;
        miniDock = null;
        // 定位全走 inline（类不参与定位，规避 !important 压制）：初始挂右上角避开状态栏
        callFrame.style.right = 'auto';
        callFrame.style.transform = 'none';
        callFrame.style.left = (window.innerWidth - 122 - 12) + 'px';
        callFrame.style.top = '72px';
        // 先禁过渡再切小窗类并强制回流——位置立即生效，覆盖层对位不取动画中间值
        //（原 bug：带过渡切类后 rect 取到动画起点，覆盖层错位导致点击/拖动/吸附全失效）
        callFrame.classList.add('wcb-dragging');
        callFrame.classList.add('wcb-frame-mini');
        void callFrame.offsetWidth;
        callFrame.classList.remove('wcb-dragging');
        postToFrame({ src: 'web-call-bridge', t: 'call:mini', on: true });
        removeDragBar(); // 拖动把手与小窗互斥（小窗自带拖动覆盖层）
        if (!miniClick) {
            miniClick = document.createElement('div');
            miniClick.className = 'wcb-mini-click';
            bindMiniDrag(miniClick);
            document.body.appendChild(miniClick);
        }
        syncMiniClick();
    }

    function exitMini(silent) {
        if (!miniOn) return;
        miniOn = false;
        miniDock = null;
        if (callFrame) {
            callFrame.classList.remove('wcb-frame-mini', 'wcb-dragging');
            callFrame.style.left = '';
            callFrame.style.top = '';
            callFrame.style.transform = '';
            callFrame.style.right = '';
            applyFrameSize(curLoad ? frameSize(curLoad.call_type === 'video', !!curLoad.meet) : { w: 360, h: 560 });
            postToFrame({ src: 'web-call-bridge', t: 'call:mini', on: false }); // iframe 存活即通知（互切复位小窗布局）
            if (!silent && !isApp && window.innerWidth > 500) ensureDragBar(); // 桌面浏览器恢复拖动把手
        }
        if (miniClick && miniClick.parentNode) miniClick.parentNode.removeChild(miniClick);
        miniClick = null;
    }

    // 松手贴边吸附：距左/右缘 40px 内吸附半隐（露出 24px 边条，微信同款贴边隐藏）；
    // 覆盖层直接按吸附后的可见区域对位（动画期间也命中，不依赖 rect 即时值）
    function dockMini() {
        if (!callFrame) return;
        var r = callFrame.getBoundingClientRect();
        var w = r.width;
        var edge = null;
        if (r.left < 40) edge = 'left';
        else if (r.left + w > window.innerWidth - 40) edge = 'right';
        if (!edge) { miniDock = null; return; }
        miniDock = edge;
        var target = edge === 'left' ? -(w - 24) : window.innerWidth - 24;
        callFrame.style.right = 'auto';
        callFrame.style.left = target + 'px';
        placeMiniClick(Math.max(0, target), r.top, w - Math.max(0, -target), r.height);
    }

    // 吸附态滑出：解除吸附并贴边完整可见（滑出动画经 .wcb-frame-mini transition），
    // 覆盖层直接按滑出后的完整位置对位
    function undockMini() {
        if (!callFrame || !miniDock) return;
        var edge = miniDock;
        miniDock = null;
        var w = callFrame.offsetWidth;
        var r = callFrame.getBoundingClientRect();
        var target = edge === 'left' ? 0 : window.innerWidth - w;
        callFrame.style.left = target + 'px';
        placeMiniClick(target, r.top, w, r.height);
    }

    // 覆盖层跟随小窗位置/尺寸（拖动后同步，保证触点始终命中覆盖层而非 iframe）
    function syncMiniClick() {
        if (!miniClick || !callFrame) return;
        var r = callFrame.getBoundingClientRect();
        placeMiniClick(r.left, r.top, r.width, r.height);
    }

    // 覆盖层直接对位（吸附/滑出动画期间目标位置已知，不取 rect 即时值防错位）
    function placeMiniClick(l, t, w, h) {
        if (!miniClick) return;
        miniClick.style.left = l + 'px';
        miniClick.style.top = t + 'px';
        miniClick.style.width = w + 'px';
        miniClick.style.height = h + 'px';
    }

    // 覆盖层手势：按住 > 8px 位移 = 拖动小窗（视口内收敛，松手贴边吸附）；
    // 吸附态轻点 = 滑出；小窗态轻点 = 恢复全屏（微信同款）
    function bindMiniDrag(el) {
        var sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;
        function start(x, y) {
            if (!callFrame) return;
            dragging = true; moved = false; sx = x; sy = y;
            callFrame.classList.add('wcb-dragging'); // 拖动中禁过渡（跟手）
            var r = callFrame.getBoundingClientRect();
            ox = r.left; oy = r.top;
        }
        function move(x, y) {
            if (!dragging || !callFrame) return;
            var dx = x - sx, dy = y - sy;
            if (!moved && Math.abs(dx) + Math.abs(dy) > 8) {
                moved = true;
                miniDock = null; // 拖动即解除吸附
                callFrame.style.right = 'auto'; // 拖动后改走 left/top 定位
                callFrame.style.left = ox + 'px';
                callFrame.style.top = oy + 'px';
            }
            if (moved) {
                var w = callFrame.offsetWidth, h = callFrame.offsetHeight;
                callFrame.style.left = Math.max(0, Math.min(x - sx + ox, window.innerWidth - w)) + 'px';
                callFrame.style.top = Math.max(0, Math.min(y - sy + oy, window.innerHeight - h)) + 'px';
                syncMiniClick();
            }
        }
        function end() {
            if (!dragging) return;
            dragging = false;
            if (callFrame) callFrame.classList.remove('wcb-dragging'); // 恢复过渡（吸附/滑出动效）
            if (moved) dockMini();           // 拖动结束：贴边吸附判定
            else if (miniDock) undockMini(); // 吸附态轻点：滑出
            else exitMini(false);            // 小窗态轻点：恢复全屏
        }
        el.addEventListener('touchstart', function (e) {
            var t = e.touches[0]; start(t.clientX, t.clientY);
        }, { passive: true });
        el.addEventListener('touchmove', function (e) {
            var t = e.touches[0]; move(t.clientX, t.clientY);
            if (moved) e.preventDefault();
        }, { passive: false });
        el.addEventListener('touchend', end);
        el.addEventListener('mousedown', function (e) {
            start(e.clientX, e.clientY);
            var mv = function (ev) { move(ev.clientX, ev.clientY); };
            var up = function () {
                document.removeEventListener('mousemove', mv);
                document.removeEventListener('mouseup', up);
                end();
            };
            document.addEventListener('mousemove', mv);
            document.addEventListener('mouseup', up);
        });
    }

    function postToSignal(frame) {
        postToFrame({ src: 'web-call-bridge', t: 'call:signal', frame: frame });
    }

    // ===== 响铃条（页内 DOM 承载，语义对齐 call-ring.js：停铃/60s 兜底/按钮上报） =====
    var ringEl = null;           // 响铃条 DOM
    var ringCur = null;          // 当前来电信息
    var ringTimeoutId = null;    // 60s 自兜底计时器（信令丢失场景，正常由服务端 timeout 归口）
    var ringActx = null, ringTimer = null;

    function ringStart() {
        ringStop();
        try {
            if (!ringActx) ringActx = new (window.AudioContext || window.webkitAudioContext)();
            if (ringActx.state === 'suspended') ringActx.resume();
            var beep = function () {
                var t0 = ringActx.currentTime;
                // 双音序列（与 call-ring.js 同参数）：880Hz 短脉冲 + 660Hz 长脉冲（音量包络防爆音）
                [[880, 0, 0.16], [660, 0.2, 0.42]].forEach(function (seg) {
                    var o = ringActx.createOscillator();
                    var g = ringActx.createGain();
                    o.frequency.value = seg[0];
                    g.gain.setValueAtTime(0.0001, t0 + seg[1]);
                    g.gain.exponentialRampToValueAtTime(0.16, t0 + seg[1] + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.0001, t0 + seg[1] + seg[2]);
                    o.connect(g); g.connect(ringActx.destination);
                    o.start(t0 + seg[1]);
                    o.stop(t0 + seg[1] + seg[2] + 0.02);
                });
            };
            beep();
            ringTimer = setInterval(beep, 2200);
        } catch (e) { }
    }
    function ringStop() {
        if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    }
    function ringArmTimeout() {
        if (ringTimeoutId) clearTimeout(ringTimeoutId);
        ringTimeoutId = setTimeout(function () {
            ringTimeoutId = null;
            hideRing(false); // 兜底自收口：仅停铃撤条，无信令（对齐 call-ring.js hideSelf）
        }, 60000);
    }

    // 构建响铃条 DOM（结构/样式对齐 call-ring.html；手机 APP/窄屏为微信同款全屏来电页）
    function buildRing(data) {
        var isFull = isApp || window.innerWidth <= 500; // 全屏来电页仅手机形态（桌面浏览器保持顶部小条）
        var bar = document.createElement('div');
        bar.className = isFull ? 'wcb-ring-fs' : 'wcb-ring';
        var ava = document.createElement('div');
        ava.className = 'wcb-ring-ava';
        var info = document.createElement('div');
        info.className = 'wcb-ring-info';
        var nm = document.createElement('div');
        nm.className = 'wcb-ring-name';
        var desc = document.createElement('div');
        desc.className = 'wcb-ring-desc';
        info.appendChild(nm); info.appendChild(desc);
        var btnDecline = document.createElement('button');
        btnDecline.className = 'wcb-ring-btn wcb-ring-decline';
        btnDecline.title = '拒绝';
        btnDecline.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';
        var btnAccept = document.createElement('button');
        btnAccept.className = 'wcb-ring-btn wcb-ring-accept';
        btnAccept.title = '接听';
        btnAccept.innerHTML = '<svg class="ico-audio" viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>' +
            '<svg class="ico-video hidden" viewBox="0 0 24 24" width="19" height="19"><path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z"/></svg>';
        if (isFull) {
            // 微信同款全屏来电页：来电头像放大模糊暗化作背景（破图降级纯深色），
            // 中部头像 + 昵称/文案居中，底部红/绿大圆钮
            info.className = 'wcb-ringfs-info'; // 全屏纵向布局（flex:1 拉伸语义不适用）
            var bg = document.createElement('div');
            bg.className = 'wcb-ringfs-bg';
            if (data.from_avatar) bg.style.backgroundImage = 'url("' + data.from_avatar + '")';
            var center = document.createElement('div');
            center.className = 'wcb-ringfs-center';
            center.appendChild(ava);
            center.appendChild(info);
            var btns = document.createElement('div');
            btns.className = 'wcb-ringfs-btns';
            btns.appendChild(btnDecline);
            btns.appendChild(btnAccept);
            bar.appendChild(bg);
            bar.appendChild(center);
            bar.appendChild(btns);
        } else {
            bar.appendChild(ava); bar.appendChild(info); bar.appendChild(btnDecline); bar.appendChild(btnAccept);
        }
        document.body.appendChild(bar);
        ringEl = bar;
        // 头像（图片优先，破图降级首字母占位——与 call-ring.js 同语义）
        var letterPh = function () {
            ava.innerHTML = '';
            var ph = document.createElement('div');
            ph.className = 'wcb-ring-ava-ph';
            ph.textContent = ((ringCur && (ringCur.from_name || ringCur.from)) || '?').charAt(0).toUpperCase();
            ava.appendChild(ph);
        };
        nm.textContent = data.from_name || data.from || '';
        // 会议来电：meet 标记显示会议文案，接听钮图标按类型切听筒/摄像头
        desc.textContent = data.meet
            ? (data.call_type === 'video' ? '邀请你加入视频会议' : '邀请你加入语音会议')
            : (data.call_type === 'video' ? '邀请你视频通话' : '邀请你语音通话');
        var icoAudio = btnAccept.querySelector('.ico-audio');
        var icoVideo = btnAccept.querySelector('.ico-video');
        icoAudio.classList.toggle('hidden', data.call_type === 'video');
        icoVideo.classList.toggle('hidden', data.call_type !== 'video');
        if (data.from_avatar) {
            var img = document.createElement('img');
            img.src = data.from_avatar;
            img.onerror = letterPh;
            ava.appendChild(img);
        } else {
            letterPh();
        }
        // 按钮动作上报（接受/拒绝语义由 chat.js 归口：发 reject 信令/开通话窗，本条只上报不直接发信令）
        btnAccept.addEventListener('click', function () {
            if (!ringCur) return;
            ringStop();
            if (ringTimeoutId) { clearTimeout(ringTimeoutId); ringTimeoutId = null; }
            var d = ringCur;
            ringCur = null;
            if (cbRingAction) cbRingAction({ action: 'accept', call_id: d.call_id });
        });
        btnDecline.addEventListener('click', function () {
            if (!ringCur) return;
            ringStop();
            if (ringTimeoutId) { clearTimeout(ringTimeoutId); ringTimeoutId = null; }
            var d = ringCur;
            ringCur = null;
            if (cbRingAction) cbRingAction({ action: 'decline', call_id: d.call_id });
        });
    }

    function showRing(data) {
        if (!data || !data.call_id) return;
        hideRing(false); // 单例：重复来电先撤旧条（服务端忙判已拦并发，防御兜底）
        ringCur = data;
        buildRing(data);
        ringStart();
        ringArmTimeout();
    }

    function hideRing(_fromServer) {
        ringStop();
        if (ringTimeoutId) { clearTimeout(ringTimeoutId); ringTimeoutId = null; }
        ringCur = null;
        if (ringEl && ringEl.parentNode) ringEl.parentNode.removeChild(ringEl);
        ringEl = null;
    }

    // ===== iframe 上行消息分发（校验来源标记防串扰；主页面浏览区另有同源 iframe，按 src 过滤） =====
    window.addEventListener('message', function (ev) {
        if (ev.origin !== location.origin) return;
        var m = ev.data;
        if (!m || m.src !== 'web-call-page') return;
        if (m.t === 'call:page-ready') {
            // 握手：通话窗页面脚本就绪 → 投递缓存任务 + 按到达序回放缓冲信令
            frameReady = true;
            deliverLoad(pendingLoad);
            pendingLoad = null;
            if (sigQueue.length) {
                var q = sigQueue;
                sigQueue = [];
                q.forEach(postToSignal);
            }
        } else if (m.t === 'call:send') {
            if (cbCallSend) cbCallSend(m.frame);
        } else if (m.t === 'call:close') {
            closeCallFrame();
        } else if (m.t === 'call:minimize') {
            enterMini(); // 通话页缩小钮上报：切悬浮小窗（微信同款）
        } else if (m.t === 'meet:invite-ask') {
            if (cbMeetInviteAsk) cbMeetInviteAsk(m.data);
        }
    });

    // ===== 能力注入（window.desktop 仅填通话方法；__webCallBridge 供登录 platform 上报区分 web/pc） =====
    window.__webCallBridge = true;
    window.desktop = {
        // —— 主窗口侧（chat.js 调用，语义与 PC preload 一致） ——
        callOpen: function (data) { openCallFrame(data); },
        callRing: function (data) { showRing(data); },
        callRingHide: function () { hideRing(false); },
        // 下行信令转发（主窗口 → 通话窗；就绪前缓冲，对齐 PC callSigQueue）
        callSignalIn: function (frame) {
            if (frameReady) postToSignal(frame);
            else sigQueue.push(frame);
        },
        onCallSend: function (cb) { cbCallSend = cb; },
        onCallRingAction: function (cb) { cbRingAction = cb; },
        onCallClosed: function (cb) { cbClosed = cb; },
        onMeetInviteAsk: function (cb) { cbMeetInviteAsk = cb; }
    };
})();
