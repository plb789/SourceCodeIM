/* ===== 阶段一百四十五：WEB 端（浏览器）通话桥 =====
   职责：纯浏览器环境（无 Electron preload）下以页内形态承载音视频通话，与 PC 端信令协议完全同构——
   1. 通话窗：同源 iframe 承载 call-window.html（复用 PC 端 WebRTC 引擎），postMessage 三段桥替代 IPC；
      尺寸/居中/信令缓冲对齐 PC 主进程（callSigQueue 同语义：iframe 就绪前的下行信令缓冲，就绪后按到达序回放）
   2. 响铃条：页内顶部弹条（微信同款），WebAudio 合成振铃音（零资源文件），铃声参数对齐 call-ring.js
   3. 能力注入：window.desktop 上仅填充通话相关方法（其余 PC 能力保持 undefined，截图/工具链等不受影响）
   激活条件：非 Electron（window.desktop 不存在）且非 Capacitor 手机端（手机端一期不支持通话，恒旁路）
   消息协议（父页 ↔ 通话窗 iframe，同源 postMessage）：
   父→iframe：{src:'web-call-bridge', t:'call:load'|'call:signal'|'call:window-close', ...}
   iframe→父：{src:'web-call-page',  t:'call:send'|'call:close'|'meet:invite-ask', ...} */
(function () {
    'use strict';
    // 激活判定：PC 端 preload 已注入 window.desktop（整脚本旁路）；手机端 Capacitor 恒旁路（通话按钮维持隐藏）
    if (window.desktop) return;
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;

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
    function frameSize(callType, isMeet) {
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
        /* 阶段一百四十五：通话窗拖动把手（浏览器 iframe 吞鼠标事件，-webkit-app-region 失效，
           以父页透明条覆盖 iframe 顶部拖动区实现按住移动；对齐 PC 端拖顶部移动窗口的体验） */
        '.wcb-drag{position:fixed;height:36px;z-index:100001;cursor:move;user-select:none;-webkit-user-select:none;}';
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
        if (callFrame) {
            // 复用窗口切换形态（语音/视频互切场景，对齐 PC ensureCallWindow）
            applyFrameSize(s);
            deliverLoad(data);
            return;
        }
        frameReady = false;
        pendingLoad = data;
        callFrame = document.createElement('iframe');
        callFrame.className = 'wcb-frame';
        // iframe 权限策略：媒体设备 + 共享屏幕（同源默认 self，显式声明稳妥）
        // 阶段一百五十一：fullscreen 授权——会议窗全屏按钮（Fullscreen API 在 iframe 内需显式 allow）
        callFrame.allow = 'microphone; camera; display-capture; fullscreen';
        // 阶段一百五十一补丁：HTML 带版本号查询串防 HTTP 缓存（页面内 CSS/JS 改动浏览器端立即生效）
        callFrame.src = 'call-window.html?v=1523';
        // 任务投递采用握手制：等 iframe 内 call-page.js 就绪主动上报 page:ready（见 message 监听），
        // 不用 load 事件——动态 iframe 的 about:blank 阶段也可能触发一次 load，会误耗 pendingLoad 丢任务
        document.body.appendChild(callFrame);
        applyFrameSize(s);
        ensureDragBar(); // 通话窗拖动把手（阶段一百四十五）
    }

    function closeCallFrame() {
        if (callFrame && callFrame.parentNode) callFrame.parentNode.removeChild(callFrame);
        callFrame = null;
        removeDragBar(); // 拖动把手随窗销毁
        frameReady = false;
        pendingLoad = null;
        sigQueue = [];
        if (cbClosed) cbClosed(); // chat.js 清本端通话态（callOpenId=''）
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

    // 构建响铃条 DOM（结构/样式对齐 call-ring.html）
    function buildRing(data) {
        var bar = document.createElement('div');
        bar.className = 'wcb-ring';
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
        bar.appendChild(ava); bar.appendChild(info); bar.appendChild(btnDecline); bar.appendChild(btnAccept);
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
