/* ===== 阶段一百四十一：通话窗逻辑（WebRTC 引擎 + 信令状态机，独立 BrowserWindow 承载） =====
   职责：媒体面归口——getUserMedia + RTCPeerConnection（P2P 直连，第一期不部署 STUN/TURN）。
   信令经 preload 桥（callSend/onCallSignal）与主窗口 WS 中继，本页不直接持有 socket；
   话单/状态归口服务端（im_call_log + im_message 通话信封），本页只负责媒体与 UI。
   状态机：idle → waiting（主叫响铃）→ connecting（媒体协商）→ active（通话中）→ ended */
(function () {
    'use strict';
    var d = window.desktop || {};

    // ===== 会话状态 =====
    var st = {
        role: '',            // caller（主叫）/ callee（被叫）
        callId: '',          // 本次通话唯一标识（服务端会话键）
        peer: '',            // 对方账号（信令投递目标）
        peerName: '',        // 对方展示名（备注→昵称→账号）
        peerAvatar: '',      // 对方头像 URL（空则首字母占位）
        callType: 'audio',   // audio / video
        pc: null,            // RTCPeerConnection
        local: null,         // 本地 MediaStream
        remote: null,        // 远端 MediaStream
        state: 'idle',       // idle / waiting / connecting / active / ended
        startedAt: 0,        // 接通时刻（本端计时长 UI 用，话单时长以服务端为准）
        muted: false,        // 麦克风静音
        camOff: false,       // 摄像头关闭（视频模式）
        ended: false,        // 收口标记（防重复收口）
        pendingCands: [],    // 远端描述未就绪前的 ICE 候选缓冲（乱序到达）
        iceServers: []       // 服务端经信令下发的 stun/turn 配置（阶段一百四十二二期；未启用为空数组纯 P2P）
    };
    var timerId = null;      // 通话时长计时器
    var watchdogId = null;   // 看门狗（协商超时/断网收口）

    // ===== DOM =====
    var $ = function (id) { return document.getElementById(id); };
    var elName = $('cwName'), elStatus = $('cwStatus');
    var elVName = $('cwVName'), elVStatus = $('cwVStatus');
    var elAvatarWrap = $('cwAvatarWrap'), elMask = $('cwMask'), elMaskText = $('cwMaskText');
    var btnMute = $('btnMute'), btnCam = $('btnCam'), btnHangup = $('btnHangup');

    // ===== 提示音（WebAudio 合成，零资源文件：450Hz 回铃音，响 1s 停 2s 循环） =====
    var actx = null, toneOsc = null, toneTimer = null;
    function toneStart() {
        try {
            if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
            if (actx.state === 'suspended') actx.resume();
            toneStop();
            var on = true;
            var tick = function () {
                if (on) {
                    toneOsc = actx.createOscillator();
                    var g = actx.createGain();
                    toneOsc.frequency.value = 450;
                    g.gain.value = 0.06;
                    toneOsc.connect(g); g.connect(actx.destination);
                    toneOsc.start();
                } else if (toneOsc) {
                    try { toneOsc.stop(); } catch (e) { }
                    toneOsc = null;
                }
                on = !on;
                toneTimer = setTimeout(tick, on ? 2000 : 1000);
            };
            tick();
        } catch (e) { }
    }
    function toneStop() {
        if (toneTimer) { clearTimeout(toneTimer); toneTimer = null; }
        if (toneOsc) { try { toneOsc.stop(); } catch (e) { } toneOsc = null; }
    }

    // ===== UI 辅助 =====
    function setStatusText(text, ended) {
        // 语音模式状态行 + 视频模式顶部信息条双写（同一语义两处展示）
        elStatus.textContent = text;
        elVStatus.textContent = text;
        elStatus.classList.toggle('ended', !!ended);
        elVStatus.parentElement.classList.toggle('ended', !!ended);
    }
    function letterAvatar() {
        // 头像为空/加载失败：首字母占位（与聊天页头像规则一致）
        elAvatarWrap.innerHTML = '';
        var ph = document.createElement('div');
        ph.className = 'cw-avatar-ph';
        ph.textContent = (st.peerName || st.peer || '?').charAt(0).toUpperCase();
        elAvatarWrap.appendChild(ph);
    }
    function fillProfile() {
        elName.textContent = st.peerName;
        elVName.textContent = st.peerName;
        if (st.peerAvatar) {
            elAvatarWrap.innerHTML = '';
            var img = document.createElement('img');
            img.className = 'cw-avatar';
            img.src = st.peerAvatar;
            img.onerror = letterAvatar;
            elAvatarWrap.appendChild(img);
        } else {
            letterAvatar();
        }
    }
    function fmtDur(sec) {
        var mm = Math.floor(sec / 60), ss = sec % 60;
        return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    }
    function updateDuration() {
        var s = Math.floor((Date.now() - st.startedAt) / 1000);
        setStatusText(fmtDur(s));
    }

    // ===== 看门狗（服务端 60s 只兜底响铃期；协商/断网期间本页自收口防对端卡死） =====
    function clearWatchdog() {
        if (watchdogId) { clearTimeout(watchdogId); watchdogId = null; }
    }
    function armWatchdog(ms) {
        clearWatchdog();
        watchdogId = setTimeout(function () {
            if (st.ended || (st.state !== 'connecting' && st.state !== 'active')) return;
            send('hangup', {});
            finish(st.state === 'active' ? '网络连接中断' : '连接超时，请稍后再试');
        }, ms);
    }

    // ===== 信令上行（msg_type=70 + content JSON，经主进程桥 → 主窗口 WS） =====
    function send(action, extra) {
        if (!d.callSend || !st.peer || !st.callId) return;
        var o = { action: action, call_id: st.callId };
        if (extra) for (var k in extra) o[k] = extra[k];
        d.callSend({ msg_type: 70, to_user: st.peer, content: JSON.stringify(o) });
    }

    // ===== 媒体 =====
    function getMedia() {
        var cons = st.callType === 'video'
            ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }
            : { audio: true, video: false };
        return navigator.mediaDevices.getUserMedia(cons);
    }

    function buildPC() {
        // ICE 配置：服务端经信令下发 iceServers（stun/turn）时走打洞+中继兜底；
        // 未下发（turn.enabled=false）为空配置纯 P2P 直连（同网段/公网直连场景）
        var conf = st.iceServers && st.iceServers.length ? { iceServers: st.iceServers } : null;
        var pc = new RTCPeerConnection(conf);
        st.local.getTracks().forEach(function (t) { pc.addTrack(t, st.local); });
        pc.ontrack = function (e) {
            if (!e.streams || !e.streams.length) return;
            st.remote = e.streams[0];
            // 视频模式出画面（cwRemote），语音模式出声音（cwRemoteAudio）
            var el = st.callType === 'video' ? $('cwRemote') : $('cwRemoteAudio');
            el.srcObject = st.remote;
            var pr = el.play && el.play();
            if (pr && pr.catch) pr.catch(function () { });
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            send('candidate', {
                candidate: {
                    candidate: e.candidate.candidate,
                    sdpMid: e.candidate.sdpMid,
                    sdpMLineIndex: e.candidate.sdpMLineIndex
                }
            });
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || !st.pc) return;
            var s = st.pc.connectionState;
            if (s === 'connected') {
                setActive();
            } else if (s === 'failed' || s === 'closed') {
                // 协商失败/连接关闭：通知对端并收口（对端有看门狗兜底）
                send('hangup', {});
                finish('连接已断开');
            } else if (s === 'disconnected') {
                // 网络抖动可能自愈：15s 未恢复再收口，不立即挂断
                armWatchdog(15000);
            }
        };
        st.pc = pc;
        return pc;
    }

    function flushCands() {
        // 远端描述就绪后回放缓冲的 ICE 候选
        if (!st.pc) { st.pendingCands = []; return; }
        st.pendingCands.forEach(function (c) {
            try { st.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        });
        st.pendingCands = [];
    }

    function setActive() {
        if (st.state === 'active' || st.ended) return;
        st.state = 'active';
        clearWatchdog();
        toneStop();
        st.startedAt = Date.now();
        updateDuration();
        if (timerId) clearInterval(timerId);
        timerId = setInterval(updateDuration, 1000);
        logSelectedPair();
    }

    // ===== 媒体链路归口日志（排障：打印最终选中候选对的类型——host/srflx/relay，一眼判断是否走 TURN 中继） =====
    function logSelectedPair() {
        if (!st.pc || !st.pc.getStats) return;
        st.pc.getStats(null).then(function (stats) {
            var cands = {};
            var selPair = null;
            stats.forEach(function (r) {
                if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
                if (r.type === 'candidate-pair' && r.state === 'succeeded' &&
                    (r.selected || r.nominated) && !selPair) selPair = r;
            });
            if (!selPair) return;
            var lc = cands[selPair.localCandidateId], rc = cands[selPair.remoteCandidateId];
            if (!lc || !rc) return;
            var relayed = lc.candidateType === 'relay' || rc.candidateType === 'relay';
            console.log('[通话] 媒体链路: 本端 ' + lc.candidateType + ' ↔ 对端 ' + rc.candidateType +
                (relayed ? '（TURN 中继）' : '（P2P 直连）'));
        }).catch(function () { });
    }

    // ===== 收口（清资源 + 遮罩提示 + 延迟关窗；信令已在调用前发出） =====
    function finish(reason) {
        if (st.ended) return;
        st.ended = true;
        st.state = 'ended';
        toneStop();
        if (timerId) { clearInterval(timerId); timerId = null; }
        clearWatchdog();
        try { if (st.pc) st.pc.close(); } catch (e) { }
        st.pc = null;
        try { if (st.local) st.local.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
        st.local = null;
        setStatusText(reason, true);
        elMaskText.textContent = reason;
        elMask.classList.add('visible');
        // 延迟关窗让用户看到结束原因；callClose 会通知主窗口清通话态并销毁窗口
        setTimeout(function () { d.callClose && d.callClose(); }, 1800);
    }

    function doHangup() {
        if (st.ended) return;
        // 响铃期取消（微信"已取消"话单语义）；接通后为挂断
        if (st.state === 'waiting') send('cancel', {});
        else send('hangup', {});
        finish('通话已结束');
    }

    // ===== 状态重置（窗口复用换场时清干净上一场资源） =====
    function resetState() {
        toneStop();
        if (timerId) { clearInterval(timerId); timerId = null; }
        clearWatchdog();
        try { if (st.pc) st.pc.close(); } catch (e) { }
        st.pc = null;
        try { if (st.local) st.local.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
        st.local = null; st.remote = null;
        st.pendingCands = [];
        st.iceServers = [];
        st.state = 'idle';
        st.startedAt = 0;
        st.muted = false; st.camOff = false; st.ended = false;
        btnMute.classList.remove('active'); btnCam.classList.remove('active');
        btnMute.title = '静音'; btnCam.title = '关闭摄像头';
        document.body.classList.remove('cam-off');
        elMask.classList.remove('visible');
    }

    // ===== 媒体协商（主叫/被叫两条流水线） =====
    function callerStartOffer() {
        // 主叫：收到 accept → 建连并发 offer
        var pc = st.pc;
        pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer).then(function () { return offer; });
        }).then(function (offer) {
            if (st.ended) return;
            send('offer', { sdp: { type: offer.type, sdp: offer.sdp } });
            armWatchdog(20000); // offer 后 20s 未连通自收口（ICE 全挂时 connectionState 亦会兜底）
        }).catch(function () {
            send('hangup', {});
            finish('建立连接失败');
        });
    }
    function calleeAnswerOffer(p) {
        // 被叫：收到 offer → setRemote → answer
        clearWatchdog();
        var pc = st.pc;
        pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
            flushCands();
            return pc.createAnswer();
        }).then(function (ans) {
            return pc.setLocalDescription(ans).then(function () { return ans; });
        }).then(function (ans) {
            if (st.ended) return;
            send('answer', { sdp: { type: ans.type, sdp: ans.sdp } });
        }).catch(function () {
            send('hangup', {});
            finish('建立连接失败');
        });
    }

    // ===== 信令下行（帧为完整协议帧：{msg_type, from_user, to_user, content}） =====
    function onSignal(frame) {
        if (!frame || st.ended) return;
        var p;
        try { p = JSON.parse(frame.content); } catch (e) { return; }
        if (!p || p.call_id !== st.callId) return; // 按 call_id 过滤（窗口复用/残留帧防御）
        switch (p.action) {
            case 'accept':
                // 主叫：被叫已接受，停回铃进入协商
                if (st.role !== 'caller' || st.state !== 'waiting') return;
                // 服务端在 accept 帧注入的 ICE 配置（buildPC 前生效，二期 TURN 接入主叫路径）
                if (Array.isArray(p.ice) && p.ice.length) st.iceServers = p.ice;
                toneStop();
                st.state = 'connecting';
                setStatusText('正在建立连接…');
                buildPC();
                callerStartOffer();
                break;
            case 'offer':
                if (st.role !== 'callee' || !st.pc) return;
                if (st.state !== 'connecting' && st.state !== 'active') return;
                calleeAnswerOffer(p);
                break;
            case 'answer':
                if (st.role !== 'caller' || !st.pc) return;
                if (st.state !== 'connecting') return;
                st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                    flushCands();
                }).catch(function () { });
                break;
            case 'candidate':
                if (!p.candidate || !st.pc) return;
                if (!st.pc.remoteDescription || !st.pc.remoteDescription.type) {
                    st.pendingCands.push(p.candidate); // 远端描述未就绪，缓冲
                } else {
                    try { st.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
                }
                break;
            case 'reject':
                finish('对方已拒绝');
                break;
            case 'cancel':
                finish('对方已取消');
                break;
            case 'hangup':
                finish('通话已结束');
                break;
            case 'timeout':
                finish(st.role === 'caller' ? '无人接听' : '未接听');
                break;
            case 'error':
                // 服务端归口错误帧（reason 为中文文案：对方不在线/黑名单/对方忙等）
                finish(p.reason || '通话失败');
                break;
            default:
                break;
        }
    }

    // ===== 通话任务下发（data = {role, call_id, peer, peer_name, peer_avatar, call_type}） =====
    d.onCallLoad(function (data) {
        if (!data || !data.call_id) return;
        if (st.callId && st.callId !== data.call_id) resetState();
        st.role = data.role === 'callee' ? 'callee' : 'caller';
        st.callId = data.call_id;
        st.peer = data.peer || '';
        st.peerName = data.peer_name || st.peer;
        st.peerAvatar = data.peer_avatar || '';
        st.callType = data.call_type === 'video' ? 'video' : 'audio';
        // 被叫路径：invite 帧注入的 ICE 配置经响铃条/主窗口随 payload 透传（服务端归口下发）
        if (Array.isArray(data.ice_servers) && data.ice_servers.length) st.iceServers = data.ice_servers;
        document.body.className = st.callType === 'video' ? 'mode-video' : 'mode-audio';
        fillProfile();
        setStatusText(st.role === 'caller' ? '等待对方接受邀请…' : '正在接听…');
        getMedia().then(function (stream) {
            if (st.ended) {
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
                return;
            }
            st.local = stream;
            if (st.callType === 'video') $('cwLocal').srcObject = stream; // 本地画中画（等待期即可预览）
            if (st.role === 'caller') {
                st.state = 'waiting';
                toneStart(); // 主叫回铃音（被叫侧振铃音在响铃条）
            } else {
                // 被叫：先建 PC 发 accept（主叫收到后才发 offer，保证 offer 不早于媒体就绪）
                st.state = 'connecting';
                buildPC();
                send('accept', {});
                armWatchdog(10000); // 接听看门狗：对端已取消等竞态下迟迟无 offer 自收口
            }
        }).catch(function () {
            // 媒体获取失败：被叫须回 reject 立即释放主叫（否则主叫空等 60s 超时）
            if (st.role === 'callee' && !st.ended) send('reject', { reason: 'declined' });
            finish('无法访问麦克风/摄像头');
        });
    });

    d.onCallSignal(onSignal);
    d.onCallWindowClose(function () { doHangup(); }); // Alt+F4 转挂断信令，收口后自行关窗

    // ===== 控制条 =====
    btnMute.addEventListener('click', function () {
        if (st.ended || !st.local) return;
        st.muted = !st.muted;
        st.local.getAudioTracks().forEach(function (t) { t.enabled = !st.muted; });
        btnMute.classList.toggle('active', st.muted);
        btnMute.title = st.muted ? '取消静音' : '静音';
    });
    btnCam.addEventListener('click', function () {
        if (st.ended || !st.local) return;
        st.camOff = !st.camOff;
        st.local.getVideoTracks().forEach(function (t) { t.enabled = !st.camOff; });
        btnCam.classList.toggle('active', st.camOff);
        btnCam.title = st.camOff ? '开启摄像头' : '关闭摄像头';
        document.body.classList.toggle('cam-off', st.camOff);
    });
    btnHangup.addEventListener('click', function () { doHangup(); });
})();
