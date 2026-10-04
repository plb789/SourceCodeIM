// remote-engine.js - 阶段一百五十五：QQ 同款远程协助——被控端屏幕共享引擎（仅 PC 端主窗口加载）
// 职责：getDisplayMedia 静默抓屏（主进程 setDisplayMediaRequestHandler 注入主屏，无系统弹窗）
//      → RTCPeerConnection 视频轨 P2P 直连（被控端为 offer 方）→ DataChannel('remote-input')
//      收控制端鼠标/键盘注入事件 → desktop.remoteInputSend 桥接主进程 PowerShell SendInput
// 非职责：信令收发（chat.js 远程协助模块归口，经 init 注入 send 回调）、UI（悬浮条 remote-bar.html）
// 安全：grant=view 时收到注入事件直接丢弃（前端双保险，服务端话单归口授权模式）
(function () {
    var st = {
        active: false,
        sessionId: '',
        grant: '',
        ice: null, // 阶段二百六十一：服务端随 rc_ready 下发的 STUN/TURN 配置（向日葵远程控制跨 NAT 穿透；旧协助流程恒 null 纯 P2P 零改动）
        pc: null,
        stream: null,
        dc: null,
        rcMode: false,     // 阶段二百六十一：rc 远程控制场景标记（answer 超时兜底仅 rc 启用，旧协助零改动）
        answerTimer: null, // 阶段二百六十一：offer 后等待 answer 超时兜底（rc 控制端超时收口防被控端悬挂）
        pendingCands: [] // 远端描述就绪前缓冲的 ICE 候选（offer/answer 竞态兜底）
    };
    var sendFn = null; // chat.js 注入：function(obj) → remoteSignalSend(对端, obj)
    var stopCb = null; // chat.js 注入：引擎停止回调（主动停共享/媒体自保时归口 disconnect 信令）

    function log() {
        try { console.log.apply(console, ['[remote-engine]'].concat([].slice.call(arguments))); } catch (e) { }
    }

    // 建连（被控端为 offer 方：屏幕轨随 offer SDP 发出，控制端应答即收流）
    function buildPC() {
        // 一期纯 P2P 直连（无 STUN/TURN，与通话一期同水位；同网段/公网直连场景）
        // 阶段二百六十一：远程控制（rc）场景服务端随 rc_ready 下发 ice（STUN/TURN 中继），
        // 跨 NAT 穿透；旧协助流程 task 无 ice 字段恒 null，行为与一期完全一致零改动
        var pc = new RTCPeerConnection(st.ice ? { iceServers: st.ice } : null);
        // 屏幕视频轨：constraints 限制 1080p/15fps（WebRTC 带宽自适应兜底，局域网可满帧）
        if (st.stream) {
            st.stream.getVideoTracks().forEach(function (t) { pc.addTrack(t, st.stream); });
        }
        // 控制事件通道：被控端创建，控制端 ondatachannel 接管
        var dc = pc.createDataChannel('remote-input', { ordered: true });
        dc.onmessage = function (e) {
            if (st.grant !== 'control') return; // 仅观看模式：注入事件直接丢弃（双保险）
            var evt;
            try { evt = JSON.parse(e.data); } catch (err) { return; }
            if (window.desktop && window.desktop.remoteInputSend) window.desktop.remoteInputSend(evt);
        };
        dc.onopen = function () { log('DataChannel 就绪'); };
        st.dc = dc;
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            sendFn({
                action: 'candidate', session_id: st.sessionId,
                candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
            });
        };
        pc.onconnectionstatechange = function () {
            log('连接状态：', pc.connectionState);
            // 连接失败/对端关闭：收口（信令面由 chat.js disconnect 流程归口，此处仅媒体面自保）
            if (st.active && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
                stop();
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

    // 启动共享（chat.js remoteAcceptInvite 调用）：抓屏 → 建连 → offer
    function startSharer(task) {
        if (st.active) { log('已在共享中，忽略重复启动'); return; }
        if (!sendFn) { log('信令通道未注入，无法启动'); return; }
        st.sessionId = task.session_id;
        st.grant = task.grant === 'control' ? 'control' : 'view';
        st.ice = Array.isArray(task.ice) && task.ice.length ? task.ice : null; // 远程控制跨 NAT 中继配置
        st.rcMode = !!task.rc; // 阶段二百六十一：仅 rc 场景启用 answer 超时兜底（旧协助零改动）
        st.active = true;
        // 主屏静默抓屏：主进程 setDisplayMediaRequestHandler 注入 sources[0]，无系统共享弹窗；
        // 一期仅共享主屏（多屏选择归二期）
        var constraints = {
            video: {
                width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 }
            }, audio: false
        };
        navigator.mediaDevices.getDisplayMedia(constraints).then(function (stream) {
            if (!st.active) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            st.stream = stream;
            // 用户点浏览器式"停止共享"条：等价主动断开（信令面 chat.js 收 disconnect 后收口）
            stream.getVideoTracks()[0].onended = function () { stop(); };
            var pc = buildPC();
            return pc.createOffer().then(function (off) {
                return pc.setLocalDescription(off).then(function () {
                    sendFn({ action: 'offer', session_id: st.sessionId, sdp: { type: off.type, sdp: off.sdp } });
                    log('offer 已发送');
                    // 阶段二百六十一：answer 迟到兜底（仅 rc 场景）——控制端 rc_connect 20s 超时收口后
                    // 会话即悬挂，被控端悬浮条/抓屏不能无限等待：offer 后 30s 未收到 answer 自动收口
                    // （stop → onStop 发 disconnect 归口服务端结束会话，防隐私悬挂）；旧协助 rcMode=false 不启用
                    if (st.rcMode) {
                        if (st.answerTimer) clearTimeout(st.answerTimer);
                        st.answerTimer = setTimeout(function () {
                            st.answerTimer = null;
                            if (st.active && (!st.pc || !st.pc.remoteDescription)) {
                                log('等待 answer 超时（控制端可能已超时收口），自动结束');
                                stop();
                            }
                        }, 30000);
                    }
                });
            });
        }).catch(function (err) {
            log('抓屏失败：', err && err.name, err && err.message);
            stop();
        });
    }

    // 信令喂入（chat.js 下行 offer/answer/candidate 时调用）
    function handleSignal(p) {
        if (!st.active) return;
        if (p.action === 'answer') {
            if (!st.pc) return;
            if (st.answerTimer) { clearTimeout(st.answerTimer); st.answerTimer = null; } // 阶段二百六十一：answer 到达解除超时兜底
            st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                flushCands();
            }).catch(function (e) { log('answer 失败：', e); });
        } else if (p.action === 'candidate') {
            if (!st.pc || !st.pc.remoteDescription) { st.pendingCands.push(p.candidate); return; }
            try { st.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
        }
    }

    // 停止共享（收口归口：停轨/关 pc/清状态；悬浮条与信令收口由 chat.js remoteEndLocal 归口）
    // wasActive 守卫：仅 active→stop 跳变时回调一次（remoteEndLocal 内二次 stop 不再触发，防递归）
    function stop() {
        var wasActive = st.active;
        st.active = false;
        if (st.dc) { try { st.dc.close(); } catch (e) { } st.dc = null; }
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        if (st.stream) { st.stream.getTracks().forEach(function (t) { t.stop(); }); st.stream = null; }
        st.pendingCands = [];
        st.sessionId = '';
        st.grant = '';
        st.ice = null;
        st.rcMode = false;
        if (st.answerTimer) { clearTimeout(st.answerTimer); st.answerTimer = null; }
        if (wasActive && stopCb) { try { stopCb(); } catch (e) { } }
        log('共享已停止');
    }

    // chat.js 初始化注入信令上行回调（避免跨文件直连 chat.js 内部函数）
    function init(opts) {
        sendFn = opts && typeof opts.send === 'function' ? opts.send : null;
        stopCb = opts && typeof opts.onStop === 'function' ? opts.onStop : null;
    }

    window.RemoteEngine = {
        init: init,
        startSharer: startSharer,
        handleSignal: handleSignal,
        stop: stop,
        isActive: function () { return st.active; }
    };
})();
