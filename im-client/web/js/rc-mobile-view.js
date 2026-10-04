// rc-mobile-view.js - 阶段二百六十一：手机/WEB 控制端页内全屏观看层（向日葵手机控电脑同款体验）
// 职责：无 Electron 桥环境（手机 APP/浏览器）下作为远程控制"控制端"——收被控端 offer →
//      WebRTC 应答建连（iceServers 由 chat.js rc_ok 注入）→ 本页渲染屏幕流 →
//      触摸手势映射为鼠标/键盘事件经 DataChannel('remote-input') 上行（与 PC 观看窗同协议，
//      被控端 remote-input.js PowerShell SendInput 归口消费，被控端零改动）
// 非职责：信令收发（chat.js 归口：rc_ok 开层、offer/candidate 喂入、disconnect 收口）、
//        设备注册/验证码管理（rc-panel.js）、被控能力（仅 PC，本层不参与）
// 手势映射（向日葵手机版同款语义）：
//   单指拖动 = 移动光标；轻点 = 左键单击（先 move 后 down/up）；长按 600ms 未动 = 右键；
//   双指纵向拖动 = 滚轮；"键盘"按钮弹软键盘输入（逐键 down/up，可打印字符 UNICODE 注入）
// 坐标：与 PC 观看窗同归一化算法（object-fit:contain letterbox 钳 0~1），被控端按自身屏幕换算
(function () {
    'use strict';

    var st = {
        sessionId: '', peer: '', peerName: '',
        pc: null, dc: null, ice: null,
        pendingCands: [], connected: false, ended: true,
        inputOn: false, sendFn: null,
        moveTimer: null, pendMove: null,
        watchdog: null, connectTimer: null, graceTimer: null,
        onEnded: null, // 收口回调（chat.js open 注入；finish 本端收口时清 chat 会话态，once 防重复）
        onEndedCalled: false,
        curBtn: 0, // 当前点击键位（0=左 1=右）：浮动工具栏切换，轻点/长按语义共用
        touch: null, // 单指手势状态 {id, sx, sy, moved, holdTimer, rightSent}
        landscape: false, // 当前是否横屏（matchMedia 维护；APP 端横屏自动沉浸依赖此标记）
        immersiveOn: false, // APP 原生沉浸已开启（退出/收口时成对关闭）
        fs: false // 全屏态（Web=Fullscreen API；APP=原生沉浸）——head 转浮层，画面铺满含状态栏区
    };
    var root = null, elVideo, elName, elMode, elMask, elMaskText, elKbInput, kbVisible = false;

    // APP（Capacitor）环境判定：有原生 BackgroundIM.setImmersive 桥即可用无手势限制的全屏
    function isApp() {
        return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundIM
            && window.Capacitor.Plugins.BackgroundIM.setImmersive);
    }

    function log() {
        try { console.log.apply(console, ['[rc-mobile-view]'].concat([].slice.call(arguments))); } catch (e) { }
    }
    function T(s) { return (window.I18N ? I18N.t(s) : s); }

    // ===== DOM（动态创建，body 级全屏覆盖，z-index 高于全部页内层） =====
    function ensureDom() {
        if (root) return true;
        root = document.createElement('div');
        root.id = 'rc-mv-root';
        root.className = 'rc-mv-root hidden';
        root.innerHTML =
            '<div class="rc-mv-head">' +
            '<button id="rcMvBack" class="rc-mv-btn" title="' + T('断开') + '">' +
            '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>' +
            '<span class="rc-mv-name" id="rcMvName"></span>' +
            '<span class="rc-mv-mode" id="rcMvMode"></span>' +
            '<button id="rcMvKb" class="rc-mv-btn" title="' + T('键盘') + '">' +
            '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2zm0 6h2v2h-2v-2zm-3 0h2v2h-2v-2zM5 17h2v-2H5v2z"/></svg></button>' +
            '<button id="rcMvFs" class="rc-mv-btn" title="' + T('全屏') + '">' +
            '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>' +
            '<button id="rcMvHangup" class="rc-mv-btn rc-mv-danger">' + T('断开') + '</button>' +
            '</div>' +
            '<div class="rc-mv-stage"><video id="rcMvVideo" autoplay playsinline muted></video>' +
            '<div class="rc-mv-mask" id="rcMvMask"><span id="rcMvMaskText"></span></div>' +
            '<div class="rc-mv-tools" id="rcMvTools">' +
            '<button id="rcMvHandle" class="rc-mv-handle" title="' + T('工具') + '">' +
            '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M22 9v6h-4V9h4zm0-9v6h-8V0h8zM6 0v9H2V0h4zm0 18v6H2v-6h4zM14 9v15h-4V9h4z"/></svg></button>' +
            '<div class="rc-mv-tools-bar hidden" id="rcMvToolsBar">' +
            '<button id="rcMvBtnL" class="rc-mv-tool active" title="' + T('左键') + '">' + T('左') + '</button>' +
            '<button id="rcMvBtnR" class="rc-mv-tool" title="' + T('右键') + '">' + T('右') + '</button>' +
            '<button id="rcMvWheelU" class="rc-mv-tool" title="' + T('滚轮上') + '">' + T('滚↑') + '</button>' +
            '<button id="rcMvWheelD" class="rc-mv-tool" title="' + T('滚轮下') + '">' + T('滚↓') + '</button>' +
            '<button id="rcMvCombo" class="rc-mv-tool" title="' + T('组合键') + '">' + T('组合') + '</button>' +
            '</div>' +
            '<div class="rc-mv-combo hidden" id="rcMvComboPanel"></div>' +
            '</div>' +
            '</div>' +
            '<input id="rcMvKbInput" class="rc-mv-kb hidden" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="' + T('点击输入，发送到对方电脑') + '">' +
            '<div class="rc-mv-confirm hidden" id="rcMvConfirm">' +
            '<div class="rc-mv-confirm-box"><div class="rc-mv-confirm-text">' + T('确定断开远程控制吗？') + '</div>' +
            '<div class="rc-mv-confirm-btns"><button id="rcMvCanc" class="rc-mv-btn">' + T('取消') + '</button>' +
            '<button id="rcMvOk" class="rc-mv-btn rc-mv-danger">' + T('断开') + '</button></div></div></div>';
        document.body.appendChild(root);
        elVideo = document.getElementById('rcMvVideo');
        elName = document.getElementById('rcMvName');
        elMode = document.getElementById('rcMvMode');
        elMask = document.getElementById('rcMvMask');
        elMaskText = document.getElementById('rcMvMaskText');
        elKbInput = document.getElementById('rcMvKbInput');
        document.getElementById('rcMvBack').addEventListener('click', askClose);
        document.getElementById('rcMvHangup').addEventListener('click', askClose);
        document.getElementById('rcMvCanc').addEventListener('click', function () { document.getElementById('rcMvConfirm').classList.add('hidden'); });
        document.getElementById('rcMvOk').addEventListener('click', function () {
            document.getElementById('rcMvConfirm').classList.add('hidden');
            finish(T('已断开远程控制'), true);
        });
        document.getElementById('rcMvKb').addEventListener('click', toggleKeyboard);
        bindInput();
        bindTouch();
        bindTools();
        bindFs();
        return true;
    }

    function setMode(text) { if (elMode) elMode.textContent = text; }
    function showMask(text) { elMaskText.textContent = text; elMask.classList.add('visible'); }
    function hideMask() { elMask.classList.remove('visible'); }

    // ===== 收口 =====
    function askClose() {
        if (st.ended) { close(); return; }
        document.getElementById('rcMvConfirm').classList.remove('hidden');
    }
    function finish(text, notify) {
        if (st.ended) return;
        st.ended = true;
        if (notify && st.sendFn) { try { st.sendFn({ action: 'disconnect', session_id: st.sessionId, reason: 'controller-close' }); } catch (e) { } }
        stopInput();
        hideKeyboard();
        if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
        if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        st.dc = null;
        // 阶段二百六十三：流终止后 video 会重新渲染默认占位图标，同款隐藏（遮罩下露纯黑底）
        elVideo.classList.add('rc-mv-nostream');
        setMode(T('已断开'));
        if (text) showMask(text);
        // 遮罩宽限期 1.2s：finish 后由计时器统一收起（外部 remoteEndLocal 的 close()
        // 在宽限期内只隐藏无遮罩的层，保证"对方已断开"提示可见）
        if (st.graceTimer) clearTimeout(st.graceTimer);
        st.graceTimer = setTimeout(function () { st.graceTimer = null; if (st.ended) close(); }, 1200);
        // 阶段二百六十三：本端收口必须同步清 chat.js 会话态（remoteOpenId 等）——控制端自己发的
        // disconnect 服务端不会回显给自己，90s 连接超时/用户挂断若不回调，remoteOpenId 永久残留，
        // 重连恒报"正在远程会话中，请先断开"。放在宽限期设置之后触发：remoteEndLocal 的
        // RCMobileView.close() 走 graceTimer 守卫分支，"已断开"遮罩提示不丢失
        if (st.onEnded && !st.onEndedCalled) { st.onEndedCalled = true; try { st.onEnded(); } catch (e) { } }
    }
    function close() {
        if (!root) return;
        if (st.graceTimer) return; // 遮罩提示期不收起，等宽限计时器归位
        exitFs(); // 阶段二百六十四：收起观看层同步退出全屏（APP 还原状态栏/导航栏，Web 退 Fullscreen）
        root.classList.add('hidden');
    }

    // ===== 建连（应答方，逻辑同 PC 观看窗 remote-page.js） =====
    function buildPC() {
        var pc = new RTCPeerConnection(st.ice ? { iceServers: st.ice } : null);
        pc.ontrack = function (e) {
            var stream = (e.streams && e.streams.length) ? e.streams[0] : null;
            if (!stream) {
                stream = elVideo.srcObject || new MediaStream();
                if (!stream.getTracks().some(function (t) { return t.id === e.track.id; })) stream.addTrack(e.track);
            }
            elVideo.srcObject = stream;
            // 阶段二百六十三：首帧流到达才显影——无流期间 video 会渲染 Chromium 默认占位
            // 播放图标（半透明遮罩下透出，观感如"默认播放器"），nostream 类将其隐藏露纯黑底
            elVideo.classList.remove('rc-mv-nostream');
            var pr = elVideo.play && elVideo.play();
            if (pr && pr.catch) pr.catch(function () { });
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate || !st.sendFn) return;
            st.sendFn({
                action: 'candidate', session_id: st.sessionId,
                candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
            });
        };
        pc.ondatachannel = function (e) {
            st.dc = e.channel;
            st.dc.onopen = function () { startInput(); };
            st.dc.onclose = function () { st.dc = null; st.inputOn = false; };
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || !st.pc) return;
            var s = st.pc.connectionState;
            if (s === 'connected') {
                st.connected = true;
                if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
                if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
                hideMask();
                setMode(T('已连接 · 控制中'));
                startInput();
            } else if (s === 'failed' || s === 'closed') {
                finish(T('连接已断开'), true);
            } else if (s === 'disconnected') {
                setMode(T('网络不稳定…'));
                if (st.watchdog) clearTimeout(st.watchdog);
                st.watchdog = setTimeout(function () { finish(T('网络连接中断'), true); }, 30000);
            }
        };
        st.pc = pc;
        return pc;
    }
    function flushCands() {
        if (!st.pc) { st.pendingCands = []; return; }
        st.pendingCands.forEach(function (c) {
            try { st.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        });
        st.pendingCands = [];
    }

    // ===== 下行信令（chat.js controller 分支喂入，session 匹配校验归本层） =====
    function handleSignal(p) {
        if (!p || !p.action || p.session_id !== st.sessionId || st.ended) return;
        if (p.action === 'offer') {
            if (!st.pc) buildPC();
            st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                flushCands();
                return st.pc.createAnswer();
            }).then(function (ans) {
                return st.pc.setLocalDescription(ans).then(function () {
                    if (st.sendFn) st.sendFn({ action: 'answer', session_id: st.sessionId, sdp: { type: ans.type, sdp: ans.sdp } });
                    log('answer 已发送');
                });
            }).catch(function (e) {
                log('answer 失败：', e);
                finish(T('连接失败'), true);
            });
        } else if (p.action === 'candidate') {
            if (!st.pc || !st.pc.remoteDescription) { st.pendingCands.push(p.candidate); return; }
            try { st.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
        } else if (p.action === 'disconnect') {
            finish(T('对方已断开'), false);
        } else if (p.action === 'ended' || p.action === 'timeout') {
            finish(p.reason || T('连接已结束'), false);
        }
    }

    // ===== 输入上行（事件格式与 PC 观看窗/被控端 remote-input.js 完全一致） =====
    function sendInput(obj) {
        if (!st.inputOn || !st.dc || st.dc.readyState !== 'open') return;
        try { st.dc.send(JSON.stringify(obj)); } catch (e) { }
    }
    function normPos(clientX, clientY) {
        var vw = elVideo.videoWidth, vh = elVideo.videoHeight;
        if (!vw || !vh) return null;
        var r = elVideo.getBoundingClientRect();
        var scale = Math.min(r.width / vw, r.height / vh);
        var dw = vw * scale, dh = vh * scale;
        var ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
        var nx = (clientX - r.left - ox) / dw;
        var ny = (clientY - r.top - oy) / dh;
        if (nx < 0) nx = 0; else if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; else if (ny > 1) ny = 1;
        return { x: nx, y: ny };
    }
    function flushMove() {
        if (!st.pendMove) return;
        sendInput(st.pendMove);
        st.pendMove = null;
    }
    function startInput() {
        st.inputOn = st.connected && !!st.dc && st.dc.readyState === 'open';
        if (!st.inputOn || st.moveTimer) return;
        st.moveTimer = setInterval(flushMove, 50);
    }
    function stopInput() {
        st.inputOn = false;
        if (st.moveTimer) { clearInterval(st.moveTimer); st.moveTimer = null; }
        st.pendMove = null;
        if (st.touch && st.touch.holdTimer) { clearTimeout(st.touch.holdTimer); st.touch.holdTimer = null; }
        st.touch = null;
    }

    // ===== 触摸手势（向日葵手机版同款） =====
    function bindTouch() {
        elVideo.addEventListener('touchstart', onTouchStart, { passive: false });
        elVideo.addEventListener('touchmove', onTouchMove, { passive: false });
        elVideo.addEventListener('touchend', onTouchEnd, { passive: false });
        elVideo.addEventListener('touchcancel', onTouchEnd, { passive: false });
        elVideo.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
    function onTouchStart(e) {
        if (!st.inputOn) return;
        e.preventDefault();
        if (e.touches.length >= 2) { // 双指：进入滚轮模式
            if (st.touch) cancelTouch();
            st.touch = { mode: 'wheel', lastY: e.touches[0].clientY };
            return;
        }
        var t = e.touches[0];
        var n = normPos(t.clientX, t.clientY);
        st.touch = { mode: 'mouse', id: t.identifier, sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, moved: false, pos: n, rightSent: false };
        // 长按 600ms 未移动 = 右键
        st.touch.holdTimer = setTimeout(function () {
            if (st.touch && st.touch.mode === 'mouse' && !st.touch.moved && st.touch.pos) {
                st.touch.rightSent = true;
                sendInput({ t: 'm', act: 'move', x: st.touch.pos.x, y: st.touch.pos.y });
                sendInput({ t: 'm', act: 'down', btn: 2 });
                sendInput({ t: 'm', act: 'up', btn: 2 });
            }
        }, 600);
        if (n) st.pendMove = { t: 'm', act: 'move', x: n.x, y: n.y }; // 拖动前先落位（松手轻点也先 move）
    }
    function onTouchMove(e) {
        if (!st.inputOn || !st.touch) return;
        e.preventDefault();
        if (st.touch.mode === 'wheel') {
            if (e.touches.length >= 2) {
                var y = e.touches[0].clientY;
                var dy = (st.touch.lastY - y) * 3; // 手指上滑=页面向下滚（与触屏直觉一致，增益调参）
                st.touch.lastY = y;
                sendInput({ t: 'm', act: 'wheel', dy: dy });
            }
            return;
        }
        var t = null;
        for (var i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === st.touch.id) { t = e.touches[i]; break; }
        if (!t) return;
        if (Math.abs(t.clientX - st.touch.sx) > 8 || Math.abs(t.clientY - st.touch.sy) > 8) {
            st.touch.moved = true;
            if (st.touch.holdTimer) { clearTimeout(st.touch.holdTimer); st.touch.holdTimer = null; }
        }
        st.touch.lx = t.clientX; st.touch.ly = t.clientY;
        var n = normPos(t.clientX, t.clientY);
        if (n) { st.touch.pos = n; st.pendMove = { t: 'm', act: 'move', x: n.x, y: n.y }; }
    }
    function onTouchEnd(e) {
        if (!st.inputOn || !st.touch) return;
        e.preventDefault();
        if (st.touch.mode === 'wheel') { st.touch = null; return; }
        if (st.touch.holdTimer) { clearTimeout(st.touch.holdTimer); st.touch.holdTimer = null; }
        if (!st.touch.moved && !st.touch.rightSent && st.touch.pos) {
            // 轻点 = 当前键位单击（工具栏"左/右"切换 st.curBtn；默认左键）
            flushMove();
            sendInput({ t: 'm', act: 'down', btn: st.curBtn });
            sendInput({ t: 'm', act: 'up', btn: st.curBtn });
        }
        st.touch = null;
    }
    function cancelTouch() {
        if (st.touch && st.touch.holdTimer) clearTimeout(st.touch.holdTimer);
        st.touch = null;
    }

    // ===== 浮动工具栏（右侧把手展开：左/右键模式、滚轮、组合键、键盘入口） =====
    // 组合键全部走 {t:'k',act,code} VK 注入协议（被控端 remote-input.js VK_BY_CODE 归口，
    // 字母键 VK 映射为阶段二百六十二新增）；Ctrl+Alt+Del 属系统安全桌面，SendInput 不可注入，不提供
    var COMBOS = [
        { label: 'Esc', seq: [{ act: 'down', code: 'Escape' }, { act: 'up', code: 'Escape' }] },
        { label: 'Alt+Tab', seq: [{ act: 'down', code: 'AltLeft' }, { act: 'down', code: 'Tab' }, { act: 'up', code: 'Tab' }, { act: 'up', code: 'AltLeft' }] },
        { label: 'Win', seq: [{ act: 'down', code: 'MetaLeft' }, { act: 'up', code: 'MetaLeft' }] },
        { label: 'Win+D', seq: [{ act: 'down', code: 'MetaLeft' }, { act: 'down', code: 'KeyD' }, { act: 'up', code: 'KeyD' }, { act: 'up', code: 'MetaLeft' }] },
        { label: 'Win+E', seq: [{ act: 'down', code: 'MetaLeft' }, { act: 'down', code: 'KeyE' }, { act: 'up', code: 'KeyE' }, { act: 'up', code: 'MetaLeft' }] },
        { label: 'PrtSc', seq: [{ act: 'down', code: 'PrintScreen' }, { act: 'up', code: 'PrintScreen' }] }
    ];
    function bindTools() {
        var handle = document.getElementById('rcMvHandle');
        var bar = document.getElementById('rcMvToolsBar');
        var comboPanel = document.getElementById('rcMvComboPanel');
        var btnL = document.getElementById('rcMvBtnL');
        var btnR = document.getElementById('rcMvBtnR');
        // 组合键面板一次性渲染
        comboPanel.innerHTML = COMBOS.map(function (c, i) {
            return '<button class="rc-mv-combo-btn" data-i="' + i + '">' + c.label + '</button>';
        }).join('');
        handle.addEventListener('click', function () {
            bar.classList.toggle('hidden');
            if (!bar.classList.contains('hidden')) comboPanel.classList.add('hidden');
        });
        function setBtnMode(n) {
            st.curBtn = n;
            btnL.classList.toggle('active', n === 0);
            btnR.classList.toggle('active', n === 1);
        }
        btnL.addEventListener('click', function () { setBtnMode(0); });
        btnR.addEventListener('click', function () { setBtnMode(1); });
        document.getElementById('rcMvWheelU').addEventListener('click', function () { sendInput({ t: 'm', act: 'wheel', dy: -400 }); });
        document.getElementById('rcMvWheelD').addEventListener('click', function () { sendInput({ t: 'm', act: 'wheel', dy: 400 }); });
        document.getElementById('rcMvCombo').addEventListener('click', function () { comboPanel.classList.toggle('hidden'); });
        comboPanel.addEventListener('click', function (e) {
            var b = e.target.closest('.rc-mv-combo-btn');
            if (!b) return;
            var c = COMBOS[parseInt(b.getAttribute('data-i'), 10)];
            if (!c) return;
            c.seq.forEach(function (k) { sendInput({ t: 'k', act: k.act, code: k.code, key: '' }); });
            comboPanel.classList.add('hidden');
        });
    }
    function resetTools() {
        st.curBtn = 0;
        var bar = document.getElementById('rcMvToolsBar');
        var comboPanel = document.getElementById('rcMvComboPanel');
        var btnL = document.getElementById('rcMvBtnL');
        var btnR = document.getElementById('rcMvBtnR');
        if (bar) bar.classList.add('hidden');
        if (comboPanel) comboPanel.classList.add('hidden');
        if (btnL) btnL.classList.add('active');
        if (btnR) btnR.classList.remove('active');
    }

    // ===== 全屏（阶段二百六十四：画面铺满含状态栏区，head 转浮层，横屏看 PC 桌面更大） =====
    // Web：requestFullscreen 必须用户手势触发（旋转非手势，无法自动全屏），点按钮手动进入；
    // APP：BackgroundIM.setImmersive 无手势限制（原生 WindowInsetsController 隐藏状态栏/导航栏 +
    //      扩展进刘海），横屏自动进入沉浸，竖屏/退出自动还原。两端 head 都切浮层覆盖，画面占满整屏。
    function applyFs(on) {
        st.fs = on;
        if (root) root.classList.toggle('rc-mv-fs', on);
        var b = document.getElementById('rcMvFs');
        if (b) b.title = T(on ? '退出全屏' : '全屏');
    }
    function enterWebFs() {
        var el = document.documentElement;
        var fn = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!fn) return;
        try { var p = fn.call(el); if (p && p.catch) p.catch(function () { }); } catch (e) { }
    }
    function exitWebFs() {
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                var fn = document.exitFullscreen || document.webkitExitFullscreen;
                if (fn) { var p = fn.call(document); if (p && p.catch) p.catch(function () { }); }
            }
        } catch (e) { }
    }
    function setAppImmersive(on) {
        try {
            var bgp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundIM;
            if (bgp && bgp.setImmersive) bgp.setImmersive({ on: !!on });
        } catch (e) { }
        st.immersiveOn = !!on;
    }
    // 手动全屏按钮：点击即切换布局类（画面铺满、head 转浮层）；再叠加平台全屏机制——
    // Web 尽力调 Fullscreen API 隐藏浏览器工具栏（可能被拒绝，不影响布局类），APP 走原生沉浸
    function toggleFs() {
        var target = !st.fs;
        if (isApp()) { setAppImmersive(target); applyFs(target); return; }
        applyFs(target);
        if (target) enterWebFs(); else exitWebFs();
    }
    // 横屏自动沉浸（仅 APP）：旋转到横屏自动进全屏铺满状态栏区，转回竖屏还原
    function updateAutoFs() {
        var land = !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches);
        st.landscape = land;
        if (!isApp()) return; // Web 端旋转非手势不可自动全屏，仅按钮手动
        if (land && !st.fs) { setAppImmersive(true); applyFs(true); }
        else if (!land && st.fs) { setAppImmersive(false); applyFs(false); }
    }
    function exitFs() {
        if (st.fs) {
            if (isApp()) setAppImmersive(false); else exitWebFs();
            applyFs(false);
        }
    }
    function bindFs() {
        document.getElementById('rcMvFs').addEventListener('click', toggleFs);
        // Web 全屏态由系统手势/Esc 退出时同步（fullscreenchange 覆盖 requestFullscreen 与手动退出）
        var fsEvt = function () {
            if (isApp()) return;
            var active = !!(document.fullscreenElement || document.webkitFullscreenElement);
            applyFs(active);
        };
        document.addEventListener('fullscreenchange', fsEvt);
        document.addEventListener('webkitfullscreenchange', fsEvt);
        if (window.matchMedia) {
            var mq = window.matchMedia('(orientation: landscape)');
            if (mq.addEventListener) mq.addEventListener('change', updateAutoFs);
            else if (mq.addListener) mq.addListener(updateAutoFs);
        }
        window.addEventListener('resize', updateAutoFs);
    }

    // ===== 软键盘（"键盘"按钮聚焦隐藏输入框，逐键 down/up 上行） =====
    function toggleKeyboard() {
        if (kbVisible) { hideKeyboard(); return; }
        kbVisible = true;
        elKbInput.classList.remove('hidden');
        elKbInput.value = '';
        setTimeout(function () { elKbInput.focus(); }, 50);
    }
    function hideKeyboard() {
        kbVisible = false;
        if (elKbInput) { elKbInput.blur(); elKbInput.classList.add('hidden'); }
    }
    function bindInput() {
        elKbInput.addEventListener('keydown', function (e) {
            if (!st.inputOn) return;
            if (e.key === 'Enter') {
                sendInput({ t: 'k', act: 'down', code: 'Enter', key: 'Enter' });
                sendInput({ t: 'k', act: 'up', code: 'Enter', key: 'Enter' });
                elKbInput.value = '';
                e.preventDefault();
                return;
            }
            if (e.key && e.key.length === 1) { // 可打印字符：UNICODE 注入（down+up 成对）
                sendInput({ t: 'k', act: 'down', code: '', key: e.key });
                sendInput({ t: 'k', act: 'up', code: '', key: e.key });
                e.preventDefault();
                setTimeout(function () { elKbInput.value = ''; }, 0);
            }
        });
        // 软键盘不保证逐键 keydown（部分输入法组合上屏）：input 事件兜底发送新增字符
        elKbInput.addEventListener('input', function () {
            if (!st.inputOn) { elKbInput.value = ''; return; }
            var v = elKbInput.value;
            for (var i = 0; i < v.length; i++) {
                var ch = v[i];
                if (ch === '\n') { sendInput({ t: 'k', act: 'down', code: 'Enter', key: 'Enter' }); sendInput({ t: 'k', act: 'up', code: 'Enter', key: 'Enter' }); continue; }
                sendInput({ t: 'k', act: 'down', code: '', key: ch });
                sendInput({ t: 'k', act: 'up', code: '', key: ch });
            }
            elKbInput.value = '';
        });
    }

    // ===== 打开（chat.js rc_ok 无 Electron 桥分支调用；task 含 send 回调） =====
    function open(task) {
        if (!ensureDom()) return;
        stopInput();
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        st.sessionId = task.session_id;
        st.peer = task.peer || '';
        st.peerName = task.peer_name || task.peer || '';
        st.ice = Array.isArray(task.ice) && task.ice.length ? task.ice : null;
        st.sendFn = typeof task.send === 'function' ? task.send : null;
        st.onEnded = typeof task.onEnded === 'function' ? task.onEnded : null;
        st.onEndedCalled = false;
        st.dc = null;
        st.pendingCands = [];
        st.connected = false;
        st.ended = false;
        if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
        if (st.graceTimer) { clearTimeout(st.graceTimer); st.graceTimer = null; }
        elVideo.srcObject = null;
        // 阶段二百六十三：连接期无流——先隐藏 video 防默认占位播放图标透出遮罩（ontrack 首帧到达显影）
        elVideo.classList.add('rc-mv-nostream');
        elName.textContent = st.peerName;
        setMode(T('连接中'));
        showMask(T('正在建立屏幕通道…'));
        document.getElementById('rcMvConfirm').classList.add('hidden');
        hideKeyboard();
        resetTools();
        // 阶段二百六十四：复位全屏态（防上次会话残留），APP 若已横屏进入即自动沉浸
        exitFs();
        updateAutoFs();
        root.classList.remove('hidden');
        // 连接超时兜底（90s 同 PC 观看窗：offer 永不到达/被控端起流失败收口防层卡死）
        if (st.connectTimer) clearTimeout(st.connectTimer);
        st.connectTimer = setTimeout(function () {
            if (!st.connected && !st.ended) finish(T('连接超时，对方未响应'), true);
        }, 90000);
    }

    window.RCMobileView = {
        open: open,
        close: function () { if (!st.ended) { st.ended = true; stopInput(); if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; } if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; } } close(); },
        handleSignal: handleSignal,
        isOpen: function () { return !!root && !root.classList.contains('hidden') && !st.ended; }
    };
})();
