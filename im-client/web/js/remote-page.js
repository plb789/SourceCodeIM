// remote-page.js - 阶段一百五十五：QQ 同款远程协助——控制端观看窗脚本（remote-window.html 专用，仅 PC 端）
// 职责：WebRTC 应答建连（收被控端 offer → 回 answer，屏幕轨随 offer P2P 直达）→ #rwRemote 渲染
//      → DataChannel('remote-input') 输入事件捕获上行（归一化坐标 + 50ms 节流；grant=view 不启用）
// 非职责：信令收发（经 preload 桥 remoteSend/onRemoteSignal 与主窗口 WS 中继，本页不直接持有 socket）、
//        授权/话单/状态归口（服务端 im_remote_log + 主窗口 chat.js 远程协助模块）
// 坐标：本端按视频实际绘制区归一化（object-fit:contain letterbox 越界钳到 0~1），
//      DPI/多屏差异由被控端主进程按其屏幕尺寸换算，两端互不感知对方分辨率
(function () {
    'use strict';
    var d = window.desktop || {};
    var MSG_REMOTE = 90; // 与 im-server protocol.MsgTypeRemoteSignal 对齐（观看窗不加载 socket.js，本地常量）

    // ===== 会话状态 =====
    var st = {
        sessionId: '',     // 本次协助唯一标识（服务端会话键）
        peer: '',          // 被控端账号（信令投递目标）
        peerName: '',      // 被控端展示名
        grant: 'view',     // control=对方允许本端操作 / view=仅观看
        pc: null,          // RTCPeerConnection（应答方）
        dc: null,          // 被控端创建的 'remote-input' 控制通道（上行注入事件）
        pendingCands: [],  // 远端描述未就绪前的 ICE 候选缓冲（offer/candidate 竞态兜底）
        connected: false,  // 媒体面接通标记
        ended: false,      // 收口标记（防重复收口）
        watchdog: null,    // disconnected 看门狗（30s 未自愈收口）
        inputOn: false,    // 输入捕获开关（grant=control 且 dc 就绪且已接通）
        pendMove: null,    // 最新一次 move 待发（50ms 间隔合并发送）
        moveTimer: null,   // move 节流发送句柄
        connectTimer: null // 连接超时兜底（offer 永不到达/对方起流失败：90s 收口防窗白开+状态残留）
    };

    // ===== DOM =====
    var $ = function (id) { return document.getElementById(id); };
    var elVideo = $('rwRemote'), elName = $('rwName'), elMode = $('rwMode'), elScreen = $('rwScreen');
    var elMask = $('rwMask'), elMaskText = $('rwMaskText'), elConfirm = $('rwConfirm');
    var btnFull = $('btnFull'), btnHangup = $('btnHangup');
    var rwCanc = $('rwCanc'), rwOk = $('rwOk');

    function log() {
        try { console.log.apply(console, ['[remote-page]'].concat([].slice.call(arguments))); } catch (e) { }
    }
    function setMode(text) { elMode.textContent = text; }
    function showMask(text) { elMaskText.textContent = text; elMask.classList.add('visible'); }

    // ===== 上行信令（完整协议帧包装，主进程转主窗口 chat.js 经 WS 发出） =====
    function send(action, body) {
        if (!d.remoteSend || st.ended) return;
        var obj = { action: action, session_id: st.sessionId };
        if (body) for (var k in body) obj[k] = body[k];
        d.remoteSend({ msg_type: MSG_REMOTE, to_user: st.peer, content: JSON.stringify(obj) });
    }

    // ===== 收口：发 disconnect（notify=true）→ 停媒体 → 遮罩提示 → 关窗 =====
    function finish(text, notify) {
        if (st.ended) return;
        st.ended = true;
        if (notify) send('disconnect', { reason: 'controller-close' });
        stopInput();
        if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
        if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        st.dc = null;
        document.body.classList.remove('grant-control');
        setMode('已断开');
        if (text) showMask(text);
        var sid = st.sessionId; // 收口时锁定会话：延迟窗内若复用窗口开了新会话，不再关新窗
        setTimeout(function () { if (d.remoteClose && st.sessionId === sid && st.ended) d.remoteClose(); }, 800);
    }

    function flushCands() {
        // 远端描述就绪后回放缓冲的 ICE 候选
        if (!st.pc) { st.pendingCands = []; return; }
        st.pendingCands.forEach(function (c) {
            try { st.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        });
        st.pendingCands = [];
    }

    // ===== 建连（应答方：无本地轨，收被控端屏幕流 + 接管 DataChannel） =====
    function buildPC() {
        // 一期纯 P2P 直连（无 STUN/TURN，与通话一期同水位）
        var pc = new RTCPeerConnection(null);
        pc.ontrack = function (e) {
            // 空 msid 轨兜底（对端 RTP 无 msid 时 e.streams 为空）：复用已有流塞轨防画面丢失
            var stream = (e.streams && e.streams.length) ? e.streams[0] : null;
            if (!stream) {
                stream = elVideo.srcObject || new MediaStream();
                if (!stream.getTracks().some(function (t) { return t.id === e.track.id; })) stream.addTrack(e.track);
            }
            elVideo.srcObject = stream;
            var pr = elVideo.play && elVideo.play();
            if (pr && pr.catch) pr.catch(function () { });
            // 实际流分辨率刷新信息条（accept 报的是被控端主屏物理分辨率，此处以流为准）
            elVideo.onloadedmetadata = function () {
                if (elVideo.videoWidth) elScreen.textContent = elVideo.videoWidth + '×' + elVideo.videoHeight;
            };
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            send('candidate', {
                candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
            });
        };
        pc.ondatachannel = function (e) {
            st.dc = e.channel; // 被控端 'remote-input' 控制通道
            st.dc.onopen = function () { startInput(); };
            st.dc.onclose = function () { st.dc = null; st.inputOn = false; };
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || !st.pc) return;
            var s = st.pc.connectionState;
            if (s === 'connected') {
                st.connected = true;
                if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
                if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; } // 已接通：连接超时兜底解除
                setMode(st.grant === 'control' ? '已连接 · 控制中' : '已连接 · 观看中');
                startInput();
            } else if (s === 'failed' || s === 'closed') {
                // 协商失败/对端关闭：发 disconnect 收口（对端有服务端下线宽限兜底）
                finish('连接已断开', true);
            } else if (s === 'disconnected') {
                // 网络抖动可能自愈：30s 看门狗兜底（与通话看门狗同水位），不立即收口
                setMode('网络不稳定…');
                if (st.watchdog) clearTimeout(st.watchdog);
                st.watchdog = setTimeout(function () { finish('网络连接中断', true); }, 30000);
            }
        };
        st.pc = pc;
        return pc;
    }

    // ===== 下行信令分发（frame 为完整协议帧，按 session_id 过滤） =====
    function handleSignal(frame) {
        var p;
        try { p = JSON.parse(frame.content); } catch (e) { return; }
        if (!p || !p.action || p.session_id !== st.sessionId || st.ended) return;
        if (p.action === 'offer') {
            if (!st.pc) buildPC();
            st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                flushCands();
                return st.pc.createAnswer();
            }).then(function (ans) {
                return st.pc.setLocalDescription(ans).then(function () {
                    send('answer', { sdp: { type: ans.type, sdp: ans.sdp } });
                    log('answer 已发送');
                });
            }).catch(function (e) {
                log('answer 失败：', e);
                finish('连接失败', true);
            });
        } else if (p.action === 'candidate') {
            if (!st.pc || !st.pc.remoteDescription) { st.pendingCands.push(p.candidate); return; }
            try { st.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
        } else if (p.action === 'disconnect') {
            // 对端主动断开（主窗口通常先行关窗，此处兜底）
            finish('对方已断开协助', false);
        }
    }

    // ===== 输入捕获（grant=control）：归一化坐标 + 节流上行 =====
    // object-fit:contain letterbox 换算：实际绘制区居中，黑边区点击钳到边界
    function normPos(e) {
        var vw = elVideo.videoWidth, vh = elVideo.videoHeight;
        if (!vw || !vh) return null;
        var r = elVideo.getBoundingClientRect();
        var scale = Math.min(r.width / vw, r.height / vh);
        var dw = vw * scale, dh = vh * scale;
        var ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
        var nx = (e.clientX - r.left - ox) / dw;
        var ny = (e.clientY - r.top - oy) / dh;
        if (nx < 0) nx = 0; else if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; else if (ny > 1) ny = 1;
        return { x: nx, y: ny };
    }
    function sendInput(obj) {
        if (!st.inputOn || !st.dc || st.dc.readyState !== 'open') return;
        try { st.dc.send(JSON.stringify(obj)); } catch (e) { }
    }
    function flushMove() {
        if (!st.pendMove) return;
        sendInput(st.pendMove);
        st.pendMove = null;
    }
    function startInput() {
        st.inputOn = st.grant === 'control' && st.connected && !!st.dc && st.dc.readyState === 'open';
        if (!st.inputOn || st.moveTimer) return;
        st.moveTimer = setInterval(flushMove, 50); // move 合并发送：高频鼠标事件不过载 DataChannel
    }
    function stopInput() {
        st.inputOn = false;
        if (st.moveTimer) { clearInterval(st.moveTimer); st.moveTimer = null; }
        st.pendMove = null;
    }

    // 鼠标（按下/抬起前 flush 最新坐标，防"按下点≠移动点"漂移）
    elVideo.addEventListener('mousemove', function (e) {
        if (!st.inputOn) return;
        var n = normPos(e);
        if (n) st.pendMove = { t: 'm', act: 'move', x: n.x, y: n.y };
    });
    elVideo.addEventListener('mousedown', function (e) {
        if (!st.inputOn) return;
        flushMove();
        sendInput({ t: 'm', act: 'down', btn: e.button });
        e.preventDefault();
    });
    elVideo.addEventListener('mouseup', function (e) {
        if (!st.inputOn) return;
        flushMove();
        sendInput({ t: 'm', act: 'up', btn: e.button });
        e.preventDefault();
    });
    elVideo.addEventListener('wheel', function (e) {
        if (!st.inputOn) return;
        flushMove();
        sendInput({ t: 'm', act: 'wheel', dy: e.deltaY });
        e.preventDefault();
    }, { passive: false });
    elVideo.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 键盘：Esc 本地消费（断开确认）；F11/F12 本地保留（全屏/调试）；其余转发被控端做 VK 映射
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { if (!st.ended) openConfirm(); return; }
        if (!st.inputOn || e.key === 'F11' || e.key === 'F12') return;
        sendInput({ t: 'k', act: 'down', code: e.code, key: e.key });
        e.preventDefault();
    });
    document.addEventListener('keyup', function (e) {
        if (!st.inputOn || e.key === 'F11' || e.key === 'F12') return;
        sendInput({ t: 'k', act: 'up', code: e.code, key: e.key });
        e.preventDefault();
    });

    // ===== 按钮 / 弹窗 =====
    function openConfirm() { elConfirm.classList.add('visible'); }
    function closeConfirm() { elConfirm.classList.remove('visible'); }
    rwCanc.addEventListener('click', closeConfirm);
    rwOk.addEventListener('click', function () { closeConfirm(); finish('已断开远程协助', true); });
    btnHangup.addEventListener('click', openConfirm);
    btnFull.addEventListener('click', function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(function () { });
    });

    // ===== 桥对接（PC preload；无桥环境仅提示不参与流程） =====
    if (d.onRemoteLoad) d.onRemoteLoad(function (task) {
        if (!task || !task.session_id) return;
        // 会话状态全量复位（窗体复用场景：上一场 800ms 收口延迟内立即重开，防残留 ended 态锁死新会话）
        stopInput();
        if (st.watchdog) { clearTimeout(st.watchdog); st.watchdog = null; }
        if (st.connectTimer) { clearTimeout(st.connectTimer); st.connectTimer = null; }
        // 连接超时兜底（90s：留足被控端 getDisplayMedia 选屏耗时；offer 丢失/起流失败则收口，
        // 服务端 disconnect 帧与页内收口任一先到均可，防窗白开 + remoteOpenId 残留锁死下次发起）
        st.connectTimer = setTimeout(function () {
            if (!st.connected) finish('连接超时，对方未响应', true);
        }, 90000);
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        st.dc = null;
        st.connected = false;
        st.ended = false;
        st.pendingCands = [];
        elMask.classList.remove('visible');
        elConfirm.classList.remove('visible');
        elVideo.srcObject = null;
        elScreen.textContent = '';
        st.sessionId = task.session_id;
        st.peer = task.peer || '';
        st.peerName = task.peer_name || task.peer || '对方';
        st.grant = task.grant === 'control' ? 'control' : 'view';
        elName.textContent = st.peerName;
        document.body.classList.toggle('grant-control', st.grant === 'control');
        elMode.textContent = '连接中';
        if (task.screen && task.screen.w) elScreen.textContent = task.screen.w + '×' + task.screen.h;
    });
    if (d.onRemoteSignal) d.onRemoteSignal(handleSignal);
    // Alt+F4/点关闭转断开语义：发 disconnect 收口后自行关窗（直接销毁会让被控端等下线宽限期）
    if (d.onRemoteClose) d.onRemoteClose(function () { finish('已断开远程协助', true); });
    if (!d.onRemoteLoad) {
        setMode('仅 PC 端支持');
        showMask('请在 PC 客户端中使用远程协助');
    }
})();
