/* ===== 阶段一百四十一：通话窗逻辑（WebRTC 引擎 + 信令状态机，独立 BrowserWindow 承载） =====
   职责：媒体面归口——getUserMedia + RTCPeerConnection（P2P 直连，第一期不部署 STUN/TURN）。
   信令经 preload 桥（callSend/onCallSignal）与主窗口 WS 中继，本页不直接持有 socket；
   话单/状态归口服务端（im_call_log + im_message 通话信封），本页只负责媒体与 UI。
   状态机：idle → waiting（主叫响铃）→ connecting（媒体协商）→ active（通话中）→ ended
   阶段一百四十七：1v1 ICE restart 断网自动重连（主叫单点发起 + 服务端 30s 下线宽限）；
   阶段一百四十八：会议 Mesh 成员级断网恢复（每对连接沿用原 offer 方向，offerer 单点发起
   restart，answerer 幂等应答；成员级 30s 看门狗只移除断网成员，会议不整体收口） */
(function () {
    'use strict';
    // 桥归口：PC 端走 preload 注入（IPC 三段桥，独立 BrowserWindow 承载）；
    // 阶段一百四十五：WEB 端浏览器在同源 iframe 内（父页 web-call-bridge.js 承载）经 postMessage 桥通信，
    // 接口语义与 PC preload 完全一致（onCallLoad/onCallSignal/callSend/callClose/meetInviteAsk）
    var d = window.desktop || (window.parent !== window ? iframeBridge() : {});

    // ===== WEB 端浏览器 iframe 桥（父页对接，消息协议见 web-call-bridge.js 头注） =====
    function iframeBridge() {
        var post = function (msg) {
            msg.src = 'web-call-page';
            try { window.parent.postMessage(msg, location.origin); } catch (e) { }
        };
        var onLoad = null;     // 通话任务回调（call:load）
        var onMsg = null;      // 下行信令回调（call:signal）
        var onCloseReq = null; // 窗体关闭转挂断（浏览器场景保留通道）
        window.addEventListener('message', function (ev) {
            if (ev.origin !== location.origin) return;
            var m = ev.data;
            if (!m || m.src !== 'web-call-bridge') return;
            if (m.t === 'call:load' && onLoad) onLoad(m.data);
            else if (m.t === 'call:signal' && onMsg) onMsg(m.frame);
            else if (m.t === 'call:window-close' && onCloseReq) onCloseReq();
        });
        // 握手：脚本就绪即上报（父页收到后才投递通话任务/回放缓冲信令，防动态 iframe
        // about:blank 阶段 load 事件误触发导致的任务丢失）
        post({ t: 'call:page-ready' });
        return {
            onCallLoad: function (cb) { onLoad = cb; },
            onCallSignal: function (cb) { onMsg = cb; },
            onCallWindowClose: function (cb) { onCloseReq = cb; },
            callSend: function (frame) { post({ t: 'call:send', frame: frame }); },
            callClose: function () { post({ t: 'call:close' }); },
            meetInviteAsk: function (data) { post({ t: 'meet:invite-ask', data: data }); }
        };
    }

    // ===== 会话状态 =====
    var st = {
        role: '',            // caller（主叫）/ callee（被叫）
        callId: '',          // 本次通话唯一标识（服务端会话键）
        peer: '',            // 对方账号（信令投递目标；会议模式恒空，投递目标走各成员 target）
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
        micUnavailable: false, // 麦克风不可用（设备故障降级标记，通信不阻断）
        camUnavailable: false, // 摄像头不可用（设备故障降级标记，通信不阻断）
        ended: false,        // 收口标记（防重复收口）
        needRestart: false,  // 阶段一百四十七：ICE restart 意图标记（主叫断网置位，connected 恢复清除）
        // ===== 阶段一百四十七：restart 恢复期状态（connected 恢复/收口/重置全清） =====
        iceRestartActive: false, // restart 恢复期开关（主叫断网置位/被叫收 restart offer 置位）
        restartOffer: null,      // 主叫同轮 restart 复用的 offer（防每轮新 ufrag 致被叫反复重建）
        restartCands: [],        // restart 期本端新收集候选缓存（断线窗口丢失帧由重发兜底）
        lastRestartOffer: '',    // 被叫幂等：上一轮收到的 restart offer sdp（重复 offer 只重发既有 answer）
        lastRestartAnswer: null, // 被叫幂等：上轮 restart 的 answer（随重复 offer 重发）
        pendingCands: [],    // 远端描述未就绪前的 ICE 候选缓冲（乱序到达）
        iceServers: [],      // 服务端经信令下发的 stun/turn 配置（阶段一百四十二二期；未启用为空数组纯 P2P）
        // ===== 阶段一百四十四：多人会议（Mesh 全员互连） =====
        meet: false,         // 会议模式开关（true 时 1v1 单人视图逻辑不参与）
        stageUser: '',       // 阶段一百五十一：主舞台目标（'self'/成员账号；空=宫格模式，腾讯会议同款布局）
        groupId: 0,          // 发起群（会中邀请时回传主窗口定位群成员范围）
        meetTitle: '',       // 会议标题（群名，主窗口下发）
        // username -> {name, avatar, pc, stream, pendingCands, muted,
        //   asOfferer, needRestart, iceRestartActive, restartOffer, restartCands,
        //   lastRestartOffer, lastRestartAnswer, lost, restartTimer, restartFirstTimer, giveupTimer}
        // （Mesh 每成员一条连接；asOfferer/restart 系列为一百四十八成员级断网恢复状态，
        //   lost=连接中断 UI 标记，giveupTimer=60s 放弃阈值兜底）
        members: {}
    };
    var timerId = null;      // 通话时长计时器
    var watchdogId = null;   // 看门狗（协商超时/断网收口）
    // ===== 阶段一百四十七：ICE restart 断网自动重连（1v1） =====
    // 断网（connectionState=disconnected）后主叫单点发起 restart 重协商，被叫纯应答（role 仲裁防双端 offer 冲突）；
    // 重试循环每 3s 重发 restart offer：断网期间信令 WS 同断时帧丢失，socket.js 3s 自动重连重登后重试帧自然送达，
    // 无需宿主桥通知信令恢复；restart 也救不回时看门狗 15s 兜底收口，行为与既有逻辑一致
    var restartTimer = null;      // restart 重试循环句柄（3s 间隔重发 offer 直至恢复/收口）
    var restartFirstTimer = null; // 首次 restart 延迟句柄（2s 给短暂抖动自愈窗口）

    // ===== DOM =====
    var $ = function (id) { return document.getElementById(id); };
    var elName = $('cwName'), elStatus = $('cwStatus');
    var elVName = $('cwVName'), elVStatus = $('cwVStatus');
    var elAvatarWrap = $('cwAvatarWrap'), elMask = $('cwMask'), elMaskText = $('cwMaskText');
    var btnMute = $('btnMute'), btnCam = $('btnCam'), btnHangup = $('btnHangup');
    var btnRecord = $('btnRecord'); // 会议录制（腾讯会议同款本地录制；PC 端专属，会议模式亮出）

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
        if (st.meet) { setMeetStatus(fmtDur(s)); return; } // 会议模式时长显示在顶部信息条
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
    // target 阶段一百四十四：会议模式下媒体帧的定向接收方（content.target，服务端校验后转发）；
    // 会议帧 to_user 恒空（服务端按 target 归口，不信任帧级路由）
    function send(action, extra, target) {
        if (!d.callSend || !st.callId) return;
        if (!st.meet && !st.peer) return; // 1v1 必须有对端；会议模式 to_user 留空
        var o = { action: action, call_id: st.callId };
        if (st.meet && target) o.target = target;
        if (extra) for (var k in extra) o[k] = extra[k];
        d.callSend({ msg_type: 70, to_user: st.meet ? '' : st.peer, content: JSON.stringify(o) });
    }

    // ===== 媒体 =====
    // 设备降级探测（QQ/微信同款语义：设备不可用只降级不阻断通信）：
    // 按通话类型完整请求 → 失败则逐项降级（仅音频 / 仅视频）→ 全部不可用则无媒体加入（仅接收），
    // 失败项打 UI 标记（按钮置灰斜线 + 无视频占位），信令/建连/接收对端媒体一律照常
    // 原代码：直接 return navigator.mediaDevices.getUserMedia(cons);
    // 阶段一百四十五：非安全上下文（浏览器 http 非 localhost 访问）下 navigator.mediaDevices 为 undefined，
    // 同步抛 TypeError 会中断 getMediaDegrade 链路导致通话窗卡"等待"态；改为显式拒绝走既有降级路径
    function gumTry(cons) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return Promise.reject(new Error('insecure-context'));
        }
        return navigator.mediaDevices.getUserMedia(cons);
    }

    // 非安全上下文检测（getUserMedia 浏览器强约束：仅 HTTPS 或 localhost 可用）
    function mediaInsecure() {
        return !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
    function getMediaDegrade() {
        var wantVideo = st.callType === 'video';
        var vCons = { width: { ideal: 1280 }, height: { ideal: 720 } };
        var full = wantVideo ? { audio: true, video: vCons } : { audio: true, video: false };
        return gumTry(full).then(function (s) {
            return { stream: s, mic: true, cam: wantVideo };
        }, function () {
            if (!wantVideo) return { stream: null, mic: false, cam: false };
            // 视频通话完整失败：逐项探测可用设备（先音频后视频，各保一路）
            return gumTry({ audio: true, video: false }).then(function (s) {
                return { stream: s, mic: true, cam: false };
            }, function () {
                return gumTry({ audio: false, video: vCons }).then(function (s) {
                    return { stream: s, mic: false, cam: true };
                }, function () {
                    return { stream: null, mic: false, cam: false };
                });
            });
        });
    }

    // 设备不可用 UI 标记：按钮置灰 + 红斜线（dev-off），视频占位由 cam-dead body 类驱动
    function applyMediaMarks() {
        btnMute.classList.toggle('dev-off', st.micUnavailable);
        btnMute.disabled = st.micUnavailable;
        if (st.micUnavailable) btnMute.title = '麦克风不可用';
        btnCam.classList.toggle('dev-off', st.camUnavailable);
        btnCam.disabled = st.camUnavailable;
        if (st.camUnavailable) btnCam.title = '摄像头不可用';
        if (btnShare && !btnShare.classList.contains('hidden')) {
            // 原代码：btnShare.disabled = st.camUnavailable; title='摄像头不可用，无法共享屏幕'
            // 阶段一百四十九：无摄像头不再禁共享（video m 行 sendrecv 空轨占位，共享零重协商）
            btnShare.disabled = false;
            btnShare.title = '共享屏幕';
        }
        document.body.classList.toggle('cam-dead', st.camUnavailable);
    }

    // 本地轨道上 pc（幂等：同一 track 二次 addTrack 抛 InvalidAccessError，会打断门闩 flush 回调链，
    // 故先查已挂 sender 跳过）；transceiversIfNeeded=true 时缺哪类轨道（设备不可用/未获取）补 recvonly
    // 收发器，保证 offer 携带完整 m 行——否则对端媒体无通道可发（空 m 行 SDP 是 ICE 永远 new 的根因）
    function attachLocalMedia(pc, transceiversIfNeeded) {
        var hasAudio = false, hasVideo = false;
        var attached = {};
        pc.getSenders().forEach(function (sd) { if (sd.track) attached[sd.track.id] = true; });
        if (st.local) {
            st.local.getTracks().forEach(function (t) {
                if (attached[t.id]) {
                    if (t.kind === 'audio') hasAudio = true; else hasVideo = true;
                    return;
                }
                pc.addTrack(t, st.local);
                if (t.kind === 'audio') hasAudio = true; else hasVideo = true;
            });
        }
        if (transceiversIfNeeded) {
            if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
            // 原代码：if (st.callType === 'video' && !hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });
            // 阶段一百四十九：无摄像头建连改为 sendrecv 空轨占位——recvonly 方向下共享屏幕即使
            // replaceTrack 塞入轨道也发不出去（方向限制），改方向又要触发全房重协商；sendrecv 空轨
            // 的 m 行同样保证 SDP 完整（ICE 不受影响），共享时向该空发送器塞屏幕轨零重协商。
            // streams:[new MediaStream()] 预挂流：offer 生成 a=msid 行——否则共享塞轨后对端收到的
            // RTP 无 msid 关联，ontrack 事件 e.streams 为空被前端丢弃（共享画面丢失根因）
            if (st.callType === 'video' && !hasVideo) {
                pc._videoPlaceholder = pc.addTransceiver('video', { direction: 'sendrecv', streams: [new MediaStream()] }).sender;
            }
        }
    }

    function buildPC() {
        // ICE 配置：服务端经信令下发 iceServers（stun/turn）时走打洞+中继兜底；
        // 未下发（turn.enabled=false）为空配置纯 P2P 直连（同网段/公网直连场景）
        var conf = st.iceServers && st.iceServers.length ? { iceServers: st.iceServers } : null;
        var pc = new RTCPeerConnection(conf);
        attachLocalMedia(pc, true);
        pc.ontrack = function (e) {
            // 原代码：if (!e.streams || !e.streams.length) return;
            // 阶段一百四十九：空 msid 轨兜底（对端 RTP 无 msid 时 e.streams 为空，原直接丢画面）——
            // 复用已有 remote 流把轨加进去，避免 audio/video 各自兜底互相覆盖
            if (e.streams && e.streams.length) {
                st.remote = e.streams[0];
            } else {
                if (!st.remote) st.remote = new MediaStream();
                if (!st.remote.getTracks().some(function (t) { return t.id === e.track.id; })) st.remote.addTrack(e.track);
            }
            // 视频模式出画面（cwRemote），语音模式出声音（cwRemoteAudio）
            var el = st.callType === 'video' ? $('cwRemote') : $('cwRemoteAudio');
            el.srcObject = st.remote;
            var pr = el.play && el.play();
            if (pr && pr.catch) pr.catch(function () { });
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            // 阶段一百四十七：restart 期间新收集的候选进缓存——切网断线窗口内 candidate 帧会丢失，
            // WS 重连后由重试循环/被叫应答路径全量重发，保证 ICE 配对候选齐全
            var c = { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
            if (st.iceRestartActive) cacheRestartCand(c);
            send('candidate', { candidate: c });
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || !st.pc) return;
            var s = st.pc.connectionState;
            if (s === 'connected') {
                // 阶段一百四十七：断网自愈/restart 恢复清理——原实现 setActive 因 state 已是 active 直接 return，
                // 看门狗不清导致断网自愈后 15s 仍误收口"网络连接中断"；此处无条件清看门狗并停 restart 重试
                clearWatchdog();
                stopRestartLoop();
                clearRestartState(); // restart 恢复期状态全清（候选缓存/复用 offer/幂等标记）
                setActive();
            } else if (s === 'failed' || s === 'closed') {
                // 协商失败/连接关闭：通知对端并收口（对端有看门狗兜底）
                send('hangup', {});
                finish('连接已断开');
            } else if (s === 'disconnected') {
                // 阶段一百四十七：断网先走 ICE restart 自动重连（主叫单点发起）；
                // 看门狗 30s（与服务端下线宽限对齐）：网络抖动可能自愈/WS 闪断后重连恢复，未恢复再收口，不立即挂断
                st.needRestart = (st.role === 'caller' && !st.meet); // 会议 Mesh 多路 restart 复杂，本期仅 1v1
                if (st.needRestart) {
                    st.iceRestartActive = true; // 本端 restart 期新候选进缓存（重发兜底）
                    startRestartLoop();
                }
                armWatchdog(30000);
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

    // ===== 阶段一百四十七：ICE restart 断网自动重连（1v1，主叫单点发起） =====
    // 停重试循环（connected 恢复/收口/状态重置时调用）
    function stopRestartLoop() {
        if (restartTimer) { clearInterval(restartTimer); restartTimer = null; }
        if (restartFirstTimer) { clearTimeout(restartFirstTimer); restartFirstTimer = null; }
    }
    // restart 期候选缓存（按 candidate 串去重；重复 addIceCandidate 对端亦无害）
    function cacheRestartCand(c) {
        for (var i = 0; i < st.restartCands.length; i++) {
            if (st.restartCands[i].candidate === c.candidate) return;
        }
        st.restartCands.push(c);
    }
    // 全量重发 restart 期候选（主叫随每轮 offer 重发 / 被叫随 answer 重发；对端重复 add 静默忽略）
    function flushRestartCands() {
        st.restartCands.forEach(function (c) {
            send('candidate', { candidate: c });
        });
    }
    // 清干净 restart 恢复期状态（connected 恢复/收口/重置）
    function clearRestartState() {
        st.iceRestartActive = false;
        st.needRestart = false;
        st.restartOffer = null;
        st.restartCands = [];
        st.lastRestartOffer = '';
        st.lastRestartAnswer = null;
    }
    // 单轮 restart 重试：同轮复用同一 offer（restartIce 生成新 ufrag 只做一次，防被叫反复重建），
    // 每轮重发 offer + 已收集候选——断网期间 WS 同断丢帧，socket.js 3s 自动重连后重试帧自然送达
    function tryIceRestart() {
        if (st.ended || !st.pc || !st.needRestart) return;
        if (st.pc.connectionState === 'connected') { stopRestartLoop(); return; } // 已自愈
        if (st.restartOffer) {
            send('offer', { sdp: st.restartOffer }); // 同轮重发
            flushRestartCands();
            return;
        }
        try { st.pc.restartIce(); } catch (e) { return; }
        st.pc.createOffer({ iceRestart: true }).then(function (off) {
            return st.pc.setLocalDescription(off).then(function () {
                st.restartOffer = { type: off.type, sdp: off.sdp }; // 本轮定格，重试循环复用
                send('offer', { sdp: st.restartOffer });
                flushRestartCands();
            });
        }).catch(function () { }); // 单次失败静默，重试循环/看门狗兜底
    }
    // 启动重试循环：2s 首发短暂抖动自愈窗口，此后每 3s 重发（断网期间 WS 同断，重连后重试帧自然送达）
    function startRestartLoop() {
        stopRestartLoop();
        restartFirstTimer = setTimeout(tryIceRestart, 2000);
        restartTimer = setInterval(tryIceRestart, 3000);
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

    // ===== 链路类型采样（话单统计归口：挂断前 getStats 取最终选中候选对，p2p 直连 / relay 中继； =====
    // 超时/失败返回空串不阻塞挂断收口，服务端白名单归口，旧客户端未上报自然为空）
    function collectLinkType(cb) {
        var done = false;
        var fin = function (v) { if (!done) { done = true; cb(v || ''); } };
        var to = setTimeout(function () { fin(''); }, 500);
        try {
            if (!st.pc || !st.pc.getStats) { clearTimeout(to); return fin(''); }
            st.pc.getStats(null).then(function (stats) {
                var cands = {}, selPair = null;
                stats.forEach(function (r) {
                    if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r;
                    if (r.type === 'candidate-pair' && r.state === 'succeeded' &&
                        (r.selected || r.nominated) && !selPair) selPair = r;
                });
                if (!selPair) { clearTimeout(to); return fin(''); }
                var lc = cands[selPair.localCandidateId], rc = cands[selPair.remoteCandidateId];
                if (!lc || !rc) { clearTimeout(to); return fin(''); }
                clearTimeout(to);
                fin((lc.candidateType === 'relay' || rc.candidateType === 'relay') ? 'relay' : 'p2p');
            }).catch(function () { clearTimeout(to); fin(''); });
        } catch (e) { clearTimeout(to); fin(''); }
    }

    // ===== 收口（清资源 + 遮罩提示 + 延迟关窗；信令已在调用前发出） =====
    function finish(reason) {
        if (st.ended) return;
        st.ended = true;
        st.state = 'ended';
        stopMeetRecording(); // 会议录制随收口自动停并保存（写盘异步由主进程完成，关窗不丢数据）
        closeInvitePanel(); // 阶段一百五十三：会议收口同步关邀请面板（防面板滞留遮挡收口遮罩）
        toneStop();
        if (timerId) { clearInterval(timerId); timerId = null; }
        clearWatchdog();
        stopRestartLoop();   // 阶段一百四十七：收口停 restart 重试循环
        clearRestartState(); // 阶段一百四十七：收口清 restart 恢复期状态
        try { if (st.pc) st.pc.close(); } catch (e) { }
        st.pc = null;
        // 阶段一百四十四：会议收口清理（逐成员清恢复状态 + 关连接 + 停共享流）
        for (var mu in st.members) {
            clearMeetGiveup(mu);     // 阶段一百四十八：清成员级放弃阈值
            stopMeetRestartLoop(mu); // 阶段一百四十八：停成员级 restart 重试循环
            try { if (st.members[mu].pc) st.members[mu].pc.close(); } catch (e) { }
        }
        st.members = {};
        // 阶段一百五十一补丁：收口解除内容保护（共享中挂断未走 stopMeetShare 时防保护残留）
        if (window.desktop && window.desktop.setShareProtected) window.desktop.setShareProtected(false);
        sharing = false;
        if (screenStream) {
            try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
            screenStream = null;
        }
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
        if (st.meet) {
            // 会议：退房信令（服务端广播余员；最后一人离开时服务端解散落话单）
            send('hangup', {});
            finish('会议已结束');
            return;
        }
        // 响铃期取消（微信"已取消"话单语义）；接通后为挂断
        if (st.state === 'waiting') { send('cancel', {}); finish('通话已结束'); return; }
        // 话单链路类型归口：挂断前采样最终选中候选对（最长 500ms，不阻塞收口体验）随挂断信令上报
        collectLinkType(function (link) {
            if (st.ended) return; // 连点守卫：首次回调已收口则跳过
            send('hangup', { link_type: link });
            finish('通话已结束');
        });
    }

    // ===== 状态重置（窗口复用换场时清干净上一场资源） =====
    function resetState() {
        toneStop();
        if (timerId) { clearInterval(timerId); timerId = null; }
        clearWatchdog();
        stopRestartLoop();   // 阶段一百四十七：换场重置停 restart 重试循环
        clearRestartState(); // 阶段一百四十七：换场重置清 restart 恢复期状态
        try { if (st.pc) st.pc.close(); } catch (e) { }
        st.pc = null;
        // 阶段一百四十四：会议连接与共享状态清理（逐成员清恢复状态 + 关连接）
        for (var mu in st.members) {
            clearMeetGiveup(mu);     // 阶段一百四十八：清成员级放弃阈值
            stopMeetRestartLoop(mu); // 阶段一百四十八：停成员级 restart 重试循环
            try { if (st.members[mu].pc) st.members[mu].pc.close(); } catch (e) { }
        }
        st.members = {};
        // 阶段一百五十一补丁：换场解除内容保护（共享中未走 stopMeetShare 直接换场时防保护残留）
        if (window.desktop && window.desktop.setShareProtected) window.desktop.setShareProtected(false);
        sharing = false;
        if (screenStream) {
            try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
            screenStream = null;
        }
        btnShare.classList.remove('active');
        btnCam.disabled = false;
        stopMeetRecording(); // 换场兜底：上一场录制未停则停并保存（写盘异步由主进程完成）
        recRemote = {};      // 换场清他人录制状态表（徽标随下场 meet_record 广播重建）
        recBadgeRefresh();
        btnInvite.classList.add('hidden');
        btnShare.classList.add('hidden');
        if (btnRecord) { btnRecord.classList.add('hidden'); btnRecord.classList.remove('rec-on'); btnRecord.title = '开始录制'; }
        try { if (st.local) st.local.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
        st.local = null; st.remote = null;
        st.pendingCands = [];
        st.iceServers = [];
        st.state = 'idle';
        st.startedAt = 0;
        st.muted = false; st.camOff = false; st.ended = false;
        st.micUnavailable = false; st.camUnavailable = false;
        st.meet = false; st.groupId = 0; st.meetTitle = ''; st.selfName = ''; st.selfAvatar = '';
        btnMute.classList.remove('active'); btnCam.classList.remove('active');
        btnMute.classList.remove('dev-off'); btnCam.classList.remove('dev-off');
        btnMute.disabled = false; btnCam.disabled = false; btnShare.disabled = false;
        btnMute.title = '静音'; btnCam.title = '关闭摄像头'; btnShare.title = '共享屏幕';
        document.body.classList.remove('cam-off', 'cam-dead');
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
        // 阶段一百四十七：active 态收 offer = 主叫 ICE restart 恢复（首协商为 connecting）；
        // restart 期保持看门狗兜底（恢复失败 15s 收口），处理失败不误挂断交由看门狗/failed 兜底
        var isRestart = (st.state === 'active');
        // 被叫幂等：主叫重试循环会重发同一 offer（sdp 相同）——只重发既有 answer + 候选缓存，
        // 不重复 setRemote/createAnswer（防本地 ICE 反复重建导致永不稳定）
        if (isRestart && p.sdp && p.sdp.sdp === st.lastRestartOffer) {
            if (st.lastRestartAnswer) send('answer', { sdp: st.lastRestartAnswer });
            flushRestartCands();
            return;
        }
        if (!isRestart) clearWatchdog();
        var pc = st.pc;
        pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
            if (isRestart) {
                st.iceRestartActive = true;  // 本端 restart 期新候选进缓存（随 answer 重发兜底）
                st.lastRestartOffer = p.sdp.sdp; // 记录本轮 offer（重复帧幂等判定）
            }
            flushCands();
            return pc.createAnswer();
        }).then(function (ans) {
            return pc.setLocalDescription(ans).then(function () { return ans; });
        }).then(function (ans) {
            if (st.ended) return;
            var answerSdp = { type: ans.type, sdp: ans.sdp };
            send('answer', { sdp: answerSdp });
            if (isRestart) {
                st.lastRestartAnswer = answerSdp; // 留作重复 offer 的幂等重发
                flushRestartCands();
            }
        }).catch(function () {
            if (isRestart) return; // restart 乱序 offer 处理失败：静默，交由重试/看门狗兜底
            send('hangup', {});
            finish('建立连接失败');
        });
    }

    // ===== 阶段一百四十四：多人会议（Mesh 全员互连，与 1v1 共用窗口/信令通道/媒体面） =====
    // 建连方向规则（防 offer 冲突 glare）：已在会成员 → 新加入成员单向发 offer，新成员只应答；
    // 成员资料/房间状态归口服务端（room_info/meet_join 帧携带昵称头像），话单/信封消息服务端落库
    // 本地媒体就绪门闩：getUserMedia（摄像头枚举 1~3s）慢于建连信令时（对端秒接），
    // addTrack/createOffer/answer 一律延后——否则生成无 m 行的空 SDP，协商完成但 0 候选，ICE 永远 new
    var localReady = false;
    var localTasks = [];
    function onLocalReady(fn) {
        if (localReady) fn();
        else localTasks.push(fn);
    }

    function meetInit(data) {
        st.meet = true;
        st.role = data.role === 'callee' ? 'callee' : 'caller';
        st.callId = data.call_id;
        st.callType = data.call_type === 'video' ? 'video' : 'audio';
        st.groupId = data.group_id || 0;
        st.meetTitle = data.meet_title || '多人会议';
        st.meetNo = data.meet_no || ''; // 阶段一百五十二：会议号（服务端建房生成，顶部徽标展示，点击复制）
        st.selfName = data.self_name || '我';
        st.selfAvatar = data.self_avatar || '';
        if (Array.isArray(data.ice_servers) && data.ice_servers.length) st.iceServers = data.ice_servers;
        document.body.className = 'mode-meet ' + (st.callType === 'video' ? 'mode-video' : 'mode-audio');
        $('meetTitle').textContent = st.meetTitle;
        meetNoShow(); // 会议号徽标显隐（无号隐藏：旧房间/信令未到的瞬间）
        // 会议控制条显隐：视频会议显摄像头/共享屏幕，语音会议仅静音；邀请成员会议恒显（1v1 保持原样）
        if (st.callType === 'video') {
            btnCam.classList.remove('hidden');
            btnShare.classList.remove('hidden');
        }
        btnInvite.classList.remove('hidden');
        // 会议录制按钮（语音/视频会议均可录——语音=纯录音；仅 PC 端亮出，WEB 端 iframe 桥无写盘 IPC）
        if (btnRecord && window.desktop && window.desktop.recMeetStart) btnRecord.classList.remove('hidden');
        $('meetStatus').textContent = st.role === 'caller' ? '等待成员加入…' : '正在加入会议…';
        getMediaDegrade().then(function (r) {
            if (st.ended) {
                if (r.stream) { try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
                return;
            }
            st.local = r.stream;
            st.micUnavailable = !r.mic;
            st.camUnavailable = st.callType === 'video' && !r.cam;
            // 设备级静音自愈：muted=true（Windows 声音设置里麦克风设备被静音）时自动重取 2 次；
            // 重取成功需同时替换已建立连接的音频发送器（门闩放行早于重取完成，sender 持有旧静音轨，
            // 只换 st.local 会出现"录制有声但对端仍听静音"的不一致）；仍静音则明确提示用户检查系统，
            // 避免通话/录制无声问题静默发生（实测根因：Intel 智音阵列在系统设备层被静音）
            if (r.stream && r.stream.getAudioTracks().length && r.stream.getAudioTracks()[0].muted) {
                var micTries = 2;
                var micSwapSenders = function (nt) {
                    for (var mu in st.members) {
                        var mpc = st.members[mu] && st.members[mu].pc;
                        if (!mpc) continue;
                        mpc.getSenders().forEach(function (sd) {
                            if (sd.track && sd.track.kind === 'audio') { try { sd.replaceTrack(nt); } catch (e) { } }
                        });
                    }
                };
                var micRetry = function () {
                    var cur = st.local.getAudioTracks()[0];
                    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (ns) {
                        var nt = ns.getAudioTracks()[0];
                        var still = !nt || nt.muted;
                        if (cur) { try { cur.stop(); } catch (e) { } st.local.removeTrack(cur); }
                        if (nt) st.local.addTrack(nt);
                        if (!still) micSwapSenders(nt); // 录制混音由 recSyncAudio 1s 内自动重挂新轨
                        if (still && micTries-- > 0) setTimeout(micRetry, 600);
                        else if (still) setMeetStatus('麦克风被系统静音：请检查 Windows 声音设置（输入设备静音状态）');
                    }).catch(function () { if (micTries-- > 0) setTimeout(micRetry, 600); });
                };
                setTimeout(micRetry, 400);
            }
            applyMediaMarks();
            renderMeetStage(); // 无媒体也渲染（自己 tile 出"无视频可用"占位/语音 tile 出头像）；阶段一百五十一舞台布局归口
            // 阶段一百五十一补丁：媒体有效状态广播（麦克风/摄像头「可用且未关闭」全员可见；
            // 服务端落快照供中途入会者补发）——track 事件对接收端 enabled=false 不可靠（实测不触发），
            // 手动切换与设备可用性统一走显式信令归口
            if (st.meet) send('meet_media', { mic: !st.micUnavailable && !st.muted, cam: !st.camUnavailable && !st.camOff });
            // 门闩放行：无媒体也照常建连（offer 经 attachLocalMedia 补 recvonly 收发器），设备状态不阻断会议
            if (!localReady) {
                localReady = true;
                var tasks = localTasks.splice(0);
                tasks.forEach(function (fn) { fn(); });
            }
            if (st.role === 'caller') {
                st.state = 'waiting';
                // 阶段一百五十二：创建等待模式（meet_wait，不选人直进会等待）不播回铃音——
                // 回铃音是"正在呼叫"语义，会议房静默等待，加入提示靠顶部会议号徽标与邀请按钮
                if (!data.meet_wait) toneStart();
            } else {
                st.state = 'connecting'; // 被叫等 room_info 后与各成员协商
            }
            // 降级提示（一次性；后续状态/计时文案覆盖）
            if (st.micUnavailable && st.camUnavailable) setMeetStatus('麦克风/摄像头不可用，仅接收');
            else if (st.camUnavailable) setMeetStatus('摄像头不可用，以语音加入');
            else if (st.micUnavailable) setMeetStatus('麦克风不可用');
        });
    }

    function setMeetStatus(text) {
        $('meetStatus').textContent = text;
    }

    // ===== 阶段一百五十二：会议号徽标（顶部信息条；显隐归口 + 点击复制转发邀请） =====
    var meetNoFlashTimer = null;
    function meetNoShow() {
        var el = $('meetNo');
        if (!el) return;
        if (st.meetNo) {
            el.textContent = '会议号 ' + st.meetNo;
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }
    // 复制成功反馈：徽标文字临时切"已复制"（会议窗无 toast 体系，原位轻提示不打断会议）
    function flashMeetNoCopied() {
        var el = $('meetNo');
        if (!el || !st.meetNo) return;
        el.textContent = '已复制';
        if (meetNoFlashTimer) clearTimeout(meetNoFlashTimer);
        meetNoFlashTimer = setTimeout(function () {
            meetNoFlashTimer = null;
            meetNoShow();
        }, 1200);
    }
    function copyMeetNo() {
        if (!st.meetNo) return;
        var no = st.meetNo;
        // 回退方案：clipboard API 不可用时（file:// 等 secure context 缺失）走隐藏 textarea + execCommand
        function fallback() {
            try {
                var ta = document.createElement('textarea');
                ta.value = no;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                flashMeetNoCopied();
            } catch (e) { }
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(no).then(flashMeetNoCopied, fallback);
        } else {
            fallback();
        }
    }

    // ===== 会议录制（腾讯会议同款本地录制：文件只保存本地，服务端零媒体参与） =====
    // 链路：点录制 → desktop.recMeetStart 弹保存对话框定保存路径 → WebAudio 混音（本地+全员）
    // + canvas 画面合成（视频会议，15fps 复刻宫格/主舞台布局）→ MediaRecorder 1s 分片 →
    // desktop.recMeetWrite 实时写盘（异常退出不丢已录内容）→ 停止/挂断 desktop.recMeetEnd 收口。
    // 录制视角=本端所见（布局与混音），成员增减/共享切换自动跟随；录制状态经 meet_record
    // 信令归口广播（服务端落快照供中途入会者补发），全员「正在录制」知情提示。仅 PC 端
    // （渲染层需 preload 注入 recMeet* IPC，WEB 端 iframe 桥无此能力不亮按钮）
    var rec = {
        active: false,   // 录制进行中
        recorder: null,  // MediaRecorder 实例
        ctx: null,       // 混音 AudioContext（独立于提示音 actx，防提示音混入录制）
        dest: null,      // MediaStreamAudioDestinationNode（混音输出口；不连扬声器无回放无啸叫）
        sources: {},     // user → {src, trackId} 已接入混音的源表（1s 定时同步成员增减/流替换）
        syncTimer: null, // 混音源同步定时器
        canvas: null,    // 画面合成画布（视频会议 1280×720）
        drawTimer: null, // 画面绘制定时器（≈15fps）
        startedAt: 0     // 录制起始时刻（徽标计时）
    };
    var recRemote = {};  // 正在录制的其他成员表（username → true，meet_record 广播归口）
    var recBadgeTimer = null; // 徽标时长计时器

    // 混音源同步：本地流 + 各成员远端流（成员退出/断流自动摘除，迟到建连自动补挂）
    function recSyncAudio() {
        if (!rec.active || !rec.ctx || !rec.dest) return;
        // 兜底：AudioContext 意外挂起（窗口后台节流等）自动恢复，防混音静音
        if (rec.ctx.state !== 'running') { try { rec.ctx.resume(); } catch (e) { } }
        var want = {};
        if (st.local && st.local.getAudioTracks().length) want['self'] = st.local.getAudioTracks()[0];
        for (var u in st.members) {
            var s = st.members[u].stream;
            if (s && s.getAudioTracks().length) want[u] = s.getAudioTracks()[0];
        }
        for (var k in rec.sources) {
            var ent = rec.sources[k];
            if (!want[k] || want[k].id !== ent.trackId) {
                try { ent.src.disconnect(); } catch (e) { }
                delete rec.sources[k];
            }
        }
        for (var k2 in want) {
            if (!rec.sources[k2]) {
                try {
                    var src = rec.ctx.createMediaStreamSource(new MediaStream([want[k2]]));
                    src.connect(rec.dest);
                    rec.sources[k2] = { src: src, trackId: want[k2].id };
                } catch (e) { }
            }
        }
    }

    // cover 绘制（同 CSS object-fit:cover 语义：等比缩放居中裁剪铺满目标矩形）
    function recDrawCover(ctx, video, x, y, w, h) {
        try {
            var vw = video.videoWidth, vh = video.videoHeight;
            if (!vw || !vh) return;
            var s = Math.max(w / vw, h / vh), dw = vw * s, dh = vh * s;
            ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        } catch (e) { }
    }

    // tile 名字条（半透明底 + 白字，底部居左；与页面 mt-name 同语义）
    function recDrawName(ctx, name, x, y, w, h) {
        var th = 24;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x, y + h - th, w, th);
        ctx.fillStyle = '#ffffff';
        ctx.font = '13px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(name || '').slice(0, 24), x + 8, y + h - th / 2);
    }

    // 画面合成帧（视频会议）：无人共享=宫格（复刻 renderMeetGrid 行列公式）；共享中=
    // 共享屏幕内容全屏铺满（腾讯会议同款：只录共享内容，不录右侧成员缩略列避免遮挡）
    function recDrawFrame() {
        var cv = rec.canvas;
        if (!cv) return;
        var ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high'; // 高质量缩放（共享文字/小画面缩放更锐利）
        ctx.fillStyle = '#161819';
        ctx.fillRect(0, 0, cv.width, cv.height);
        var gap = 10;
        var sharers = [];
        if (sharing && screenStream) sharers.push('self');
        for (var u in st.members) { if (st.members[u].sharing) sharers.push(u); }
        if (sharers.length) {
            var stageTile = $('stageBox').querySelector('div.meet-tile');
            if (stageTile) {
                var sv = stageTile.querySelector('video');
                if (sv) recDrawCover(ctx, sv, 0, 0, cv.width, cv.height);
                var su = meetUserOf(st.stageUser);
                recDrawName(ctx, (su.name || '') + (st.stageUser === 'self' ? '（我）' : '') + '（共享屏幕）', 0, 0, cv.width, cv.height);
            }
            return;
        }
        // 宫格：tile 渲染序=自己+成员序（renderMeetGrid 同序），尺寸公式一致
        var tiles = $('meetGrid').querySelectorAll('div.meet-tile');
        var cnt = tiles.length;
        if (!cnt) return;
        var cols = Math.ceil(Math.sqrt(cnt));
        var w = (cv.width - (cols - 1) * gap) / cols;
        var rows = Math.ceil(cnt / cols);
        var h = (cv.height - (rows - 1) * gap) / rows;
        for (var j = 0; j < cnt; j++) {
            var x = (j % cols) * (w + gap), y = Math.floor(j / cols) * (h + gap);
            var v2 = tiles[j].querySelector('video');
            var u2 = tiles[j].getAttribute('data-user');
            var ui = meetUserOf(u2);
            if (v2) recDrawCover(ctx, v2, x, y, w, h);
            recDrawName(ctx, (ui.name || '') + (u2 === 'self' ? '（我）' : ''), x, y, w, h);
        }
    }

    // 录制徽标归口：本端录制优先（带时长），否则显示他人录制者名（meet_record 广播/快照补发）
    function recBadgeRefresh() {
        var el = $('recBadge');
        if (!el) return;
        var who = '';
        if (rec.active) {
            var s = Math.floor((Date.now() - rec.startedAt) / 1000);
            function p2(n) { return (n < 10 ? '0' : '') + n; }
            who = '录制中 ' + p2(Math.floor(s / 60)) + ':' + p2(s % 60);
        } else {
            for (var u in recRemote) {
                var m = st.members[u];
                who = (m ? (m.name || u) : u) + ' 录制中';
                break;
            }
        }
        if (who) {
            el.textContent = who;
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    // MediaRecorder 组流：视频会议=canvas 视频轨+混音轨；语音会议=纯混音轨（opus）。
    // 清晰度归口：1080p/30fps + 显式 8Mbps 视频码率（不设则 Chromium 默认低码率致画面糊），
    // 编码器 vp9 优先（同码率画质优于 vp8）不支持回退 vp8
    function recBuildStream() {
        var tracks = [];
        if (st.callType === 'video') {
            rec.canvas = document.createElement('canvas');
            rec.canvas.width = 1920;
            rec.canvas.height = 1080;
            tracks = tracks.concat(rec.canvas.captureStream(30).getVideoTracks());
        }
        var at = rec.dest ? rec.dest.stream.getAudioTracks() : [];
        if (at.length) tracks = tracks.concat(at);
        rec.stream = new MediaStream(tracks);
        var mime = 'audio/webm;codecs=opus';
        if (st.callType === 'video') {
            var cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
            for (var i = 0; i < cands.length; i++) {
                try { if (MediaRecorder.isTypeSupported(cands[i])) { mime = cands[i]; break; } } catch (e) { }
            }
        }
        var opts = { videoBitsPerSecond: 8000000, audioBitsPerSecond: 128000 };
        try { if (MediaRecorder.isTypeSupported(mime)) opts.mimeType = mime; } catch (e) { }
        rec.recorder = new MediaRecorder(rec.stream, opts);
        rec.recorder.ondataavailable = function (ev) {
            if (!ev.data || !ev.data.size) return;
            ev.data.arrayBuffer().then(function (buf) {
                if (window.desktop && window.desktop.recMeetWrite) window.desktop.recMeetWrite(new Uint8Array(buf));
            }).catch(function () { });
        };
        rec.recorder.onstop = recOnRecorderStop;
    }

    // 收口写流（onstop 触发；最后分片 arrayBuffer→IPC 异步在途，延迟 300ms 再关写流防尾帧截断）
    function recOnRecorderStop() {
        setTimeout(function () {
            if (window.desktop && window.desktop.recMeetEnd) {
                window.desktop.recMeetEnd().then(function (r) {
                    if (r && r.ok && r.path && !st.ended) setMeetStatus('录制已保存：' + r.path);
                });
            }
            try { if (rec.ctx) rec.ctx.close(); } catch (e) { }
            rec.ctx = null; rec.dest = null; rec.sources = {};
            rec.recorder = null; rec.stream = null; rec.canvas = null;
        }, 300);
    }

    async function startMeetRecording() {
        if (rec.active || st.ended || !st.meet) return;
        if (!window.desktop || !window.desktop.recMeetStart) return; // WEB 端无 IPC 不启用
        // 混音 AudioContext 在保存对话框前创建：native 弹窗会打断手势上下文（浏览器环境手势
        // 缺失会导致 AudioContext 挂起且 resume 失败），提前创建 + 失败路径复用，防御更稳
        if (!rec.ctx) {
            rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
            rec.dest = rec.ctx.createMediaStreamDestination();
        }
        if (rec.ctx.state === 'suspended') rec.ctx.resume();
        function p2(n) { return (n < 10 ? '0' : '') + n; }
        var d = new Date();
        var ts = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
        var r;
        try {
            r = await window.desktop.recMeetStart({ name: '会议录制_' + (st.meetTitle || st.meetNo || '会议') + '_' + ts + '.webm' });
        } catch (e) { return; }
        if (!r || !r.ok) return; // 用户取消保存对话框/写盘失败：不开始录制（ctx 留作下次点击复用）
        if (st.ended) { // 对话框停留期间会议已收口：不空跑起录，立即收掉刚建的写流防残留坏文件
            try { window.desktop.recMeetEnd(); } catch (e) { }
            return;
        }
        recBuildStream();
        rec.recorder.start(1000); // 1s 分片实时落盘
        rec.active = true;
        rec.startedAt = Date.now();
        recSyncAudio();
        rec.syncTimer = setInterval(recSyncAudio, 1000);
        if (st.callType === 'video') rec.drawTimer = setInterval(recDrawFrame, 33); // 30fps（与 captureStream 对齐）
        recBadgeTimer = setInterval(recBadgeRefresh, 1000);
        if (btnRecord) {
            btnRecord.classList.add('rec-on');
            btnRecord.title = '停止录制';
        }
        recBadgeRefresh();
        send('meet_record', { on: true }); // 全员广播（服务端落快照，中途入会者补发）
    }

    function stopMeetRecording() {
        if (!rec.active) return;
        rec.active = false;
        if (rec.syncTimer) { clearInterval(rec.syncTimer); rec.syncTimer = null; }
        if (rec.drawTimer) { clearInterval(rec.drawTimer); rec.drawTimer = null; }
        if (recBadgeTimer) { clearInterval(recBadgeTimer); recBadgeTimer = null; }
        if (btnRecord) {
            btnRecord.classList.remove('rec-on');
            btnRecord.title = '开始录制';
        }
        recBadgeRefresh();
        try { rec.recorder.stop(); } catch (e) { recOnRecorderStop(); } // onstop→延迟收口写流
        send('meet_record', { on: false });
    }


    // ===== 阶段一百五十三：会议窗内邀请成员面板（独立于主窗口选人弹窗，不再来回切窗） =====
    // 名单走 meet_members_ask 服务端归口（在线/设备/忙/已在会状态一并下发，前端只展示）；
    // 邀请动作复用 meet_invite 追加邀请链路（服务端 meetInviteMore 同校验，反馈走既有 meet_skipped）
    var inviteOpen = false;
    var inviteMembers = [];  // 服务端下发的全量名单
    var inviteSelected = {}; // username -> true 勾选集合
    function openInvitePanel() {
        if (st.ended || !st.meet) return;
        inviteOpen = true;
        inviteMembers = [];
        inviteSelected = {};
        $('inviteMask').classList.remove('hidden');
        var search = $('inviteSearch');
        search.value = '';
        search.disabled = true; // 名单未到前禁搜索（防误以为无成员）
        $('inviteCount').textContent = '已选 0 人';
        $('btnInviteConfirm').classList.add('disabled');
        $('inviteList').innerHTML = '<div class="invite-empty">正在获取成员列表…</div>';
        send('meet_members_ask', {}); // send 自带 call_id，服务端按房间归口回 meet_members_list
    }
    function closeInvitePanel() {
        inviteOpen = false;
        inviteMembers = [];
        inviteSelected = {};
        var mask = $('inviteMask');
        if (mask) mask.classList.add('hidden');
    }
    function renderInviteList() {
        var box = $('inviteList');
        var kw = $('inviteSearch').value.trim().toLowerCase();
        var rows = [];
        for (var i = 0; i < inviteMembers.length; i++) {
            var m = inviteMembers[i];
            if (kw && (m.name || '').toLowerCase().indexOf(kw) < 0 && (m.username || '').toLowerCase().indexOf(kw) < 0) continue;
            rows.push(m);
        }
        box.innerHTML = '';
        if (!rows.length) {
            // 查无数据显示"暂无"语义（区分搜索无结果与名单为空），不用"加载失败"
            box.innerHTML = '<div class="invite-empty">' + (inviteMembers.length ? '未找到匹配成员' : '暂无可邀请的成员') + '</div>';
            return;
        }
        rows.forEach(function (m) {
            var invitable = !!m.online && !!m.call_ok && !m.busy && !m.in_meeting;
            var row = document.createElement('div');
            row.className = 'invite-row' + (inviteSelected[m.username] ? ' sel' : '') + (invitable ? '' : ' disabled');
            // 头像：服务端下发的图片优先，空则降级昵称/账号首字符
            var av = document.createElement('div');
            av.className = 'invite-avatar';
            if (m.avatar) {
                var img = document.createElement('img');
                img.src = m.avatar;
                av.appendChild(img);
            } else {
                av.textContent = (m.name || m.username || '?').charAt(0);
            }
            var info = document.createElement('div');
            info.className = 'invite-info';
            var nm = document.createElement('div');
            nm.className = 'invite-name';
            nm.textContent = m.name || m.username;
            var stt = document.createElement('div');
            stt.className = 'invite-status' + (invitable ? ' ok' : '');
            stt.textContent = !m.online ? '离线' : (!m.call_ok ? '设备不支持' : (m.in_meeting ? '会议中' : (m.busy ? '通话中' : '可邀请')));
            info.appendChild(nm);
            info.appendChild(stt);
            var chk = document.createElement('span');
            chk.className = 'invite-check';
            row.appendChild(av);
            row.appendChild(info);
            row.appendChild(chk);
            if (invitable) {
                row.addEventListener('click', function () {
                    if (inviteSelected[m.username]) delete inviteSelected[m.username];
                    else inviteSelected[m.username] = true;
                    row.classList.toggle('sel', !!inviteSelected[m.username]);
                    updateInviteFoot();
                });
            }
            box.appendChild(row);
        });
    }
    function updateInviteFoot() {
        var n = 0;
        for (var k in inviteSelected) n++;
        $('inviteCount').textContent = '已选 ' + n + ' 人';
        $('btnInviteConfirm').classList.toggle('disabled', n === 0);
    }

    // 宫格渲染：自己 tile + 全员 tile（按人数自动分列；视频 tile=画面 / 语音 tile=头像）
    function renderMeetGrid() {
        var grid = $('meetGrid');
        grid.innerHTML = '';
        var users = [];
        for (var u in st.members) users.push(u);
        var n = users.length + 1;
        var cols = Math.ceil(Math.sqrt(n));
        var gap = 10;
        var w = 'calc((100% - ' + ((cols - 1) * gap) + 'px) / ' + cols + ')';
        var rows = Math.ceil(n / cols);
        var h = 'calc((100% - ' + ((Math.min(rows, cols) - 1) * gap) + 'px) / ' + Math.ceil(n / cols) + ')';
        // 自己 tile（本地预览 muted 防啸叫）；共享中预览切屏幕画面（原恒 st.local）
        grid.appendChild(buildMeetTile('self', st.selfName || '我', st.selfAvatar || '', (sharing && screenStream) ? screenStream : st.local, true, w, h));
        users.forEach(function (u) {
            var m = st.members[u];
            grid.appendChild(buildMeetTile(u, m.name, m.avatar, m.stream, false, w, h));
        });
    }

    // ===== 阶段一百五十一：腾讯会议同款舞台布局 =====
    // 双模式渲染入口：无人共享 → 宫格（renderMeetGrid 原样）；有人共享 → 主舞台大区域 + 右侧缩略图列。
    // 成员增减/媒体到达/静音/中断/共享开关等任何变化统一走本入口，保证舞台与宫格同步刷新
    function renderMeetStage() {
        var side = $('meetSide');
        var stageBox = $('stageBox');
        var sharers = [];
        if (sharing && screenStream) sharers.push('self');
        for (var u in st.members) {
            if (st.members[u].sharing) sharers.push(u);
        }
        if (!sharers.length) {
            // 宫格模式：舞台目标清空 + 缩略图列隐藏
            st.stageUser = '';
            side.style.display = 'none';
            side.innerHTML = '';
            stageBox.style.display = 'none';
            stageBox.innerHTML = '';
            $('meetGrid').style.display = 'flex';
            renderMeetGrid();
            return;
        }
        // 舞台目标失效（其共享已停止）：回退最新共享者；仍有效则保持（手动切换不被抢回）
        if (sharers.indexOf(st.stageUser) < 0) st.stageUser = sharers[sharers.length - 1];
        $('meetGrid').style.display = 'none';
        side.style.display = 'flex';
        stageBox.style.display = 'block';
        stageBox.innerHTML = '';
        var su = st.stageUser;
        var si = meetUserOf(su);
        var stageTile = buildMeetTile(su, si.name, si.avatar, stageStreamOf(su), su === 'self', '100%', '100%', false);
        stageTile.classList.add('meet-stage');
        stageBox.appendChild(stageTile);
        // 右侧缩略图：自己 + 全员（silent 静音防双重混音；点击切换主舞台）
        side.innerHTML = '';
        var thumbs = ['self'];
        for (var u2 in st.members) thumbs.push(u2);
        thumbs.forEach(function (tu) {
            var ti = meetUserOf(tu);
            var th = document.createElement('div');
            th.className = 'meet-thumb' + (tu === su ? ' active' : '');
            th.title = '点击切换主画面';
            th.appendChild(buildMeetTile(tu, ti.name, ti.avatar, stageStreamOf(tu), tu === 'self', '100%', '100%', true));
            th.onclick = function () {
                if (st.stageUser !== tu) {
                    st.stageUser = tu;
                    renderMeetStage();
                }
            };
            side.appendChild(th);
        });
    }

    // 成员显示信息归口（'self'=自己，其余查成员表）
    function meetUserOf(u) {
        if (u === 'self') return { name: st.selfName || '我', avatar: st.selfAvatar || '' };
        var m = st.members[u];
        return m ? { name: m.name || u, avatar: m.avatar || '' } : { name: u, avatar: '' };
    }

    // 成员当前媒体流归口（自己共享中预览屏幕画面；远端共享时其流即屏幕轨——replaceTrack 换轨同源）
    function stageStreamOf(u) {
        if (u === 'self') return (sharing && screenStream) ? screenStream : st.local;
        var m = st.members[u];
        return m ? m.stream : null;
    }

    // 全屏切换（腾讯会议同款：右上角按钮/双击画面，Esc 退出；WEB 端 iframe 需 allow fullscreen 授权）
    function toggleMeetFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(function () { });
        }
    }

    // silent：缩略图专用静音（阶段一百五十一舞台布局——同一成员流在主舞台已有一路发声，
    // 缩略图再挂非静音媒体元素会双重混音回声）
    function buildMeetTile(user, name, avatar, stream, isSelf, w, h, silent) {
        var tile = document.createElement('div');
        tile.className = 'meet-tile';
        tile.style.width = w;
        tile.style.height = h;
        tile.setAttribute('data-user', user);
        if (st.callType === 'video') {
            var v = document.createElement('video');
            v.autoplay = true;
            v.playsInline = true;
            if (isSelf || silent) v.muted = true; // 原：if (isSelf) v.muted = true
            if (stream) v.srcObject = stream;
            tile.appendChild(v);
            // 摄像头不可用：本地画面出"无视频可用"占位（通信不阻断，仅此一处标记）
            // 原代码：if (isSelf && st.camUnavailable)——共享中预览的是屏幕画面，占位不得残留盖住预览
            if (isSelf && st.camUnavailable && !(sharing && screenStream)) {
                var ph = document.createElement('div');
                ph.className = 'no-video-ph';
                ph.textContent = '无视频可用';
                tile.appendChild(ph);
            }
        } else {
            var au = document.createElement('div');
            au.className = 'mt-audio';
            var aw = document.createElement('div');
            aw.className = 'mt-ava';
            if (avatar) {
                var img = document.createElement('img');
                img.src = avatar;
                aw.appendChild(img);
            } else {
                aw.textContent = (name || '?').charAt(0).toUpperCase();
            }
            au.appendChild(aw);
            var an = document.createElement('div');
            an.style.fontSize = '14px';
            an.style.color = '#dfe3e8';
            an.textContent = name;
            au.appendChild(an);
            tile.appendChild(au);
            if (stream) {
                var a = document.createElement('audio');
                a.autoplay = true;
                if (silent) a.muted = true; // 缩略图静音（同视频分支，防双重混音）
                a.srcObject = stream;
                tile.appendChild(a);
            }
        }
        // 名字条 + 麦克风状态图标（远端静音由 track.muted 事件联动）
        var nm = document.createElement('div');
        nm.className = 'mt-name';
        nm.textContent = name + (isSelf ? '（我）' : '');
        // 阶段一百四十八：连接中断标记（成员级 lost=true 显示「连接中断」，恢复自动清除）
        if (user !== 'self' && st.members[user] && st.members[user].lost) {
            tile.classList.add('lost');
            nm.textContent += '（连接中断）';
        }
        tile.appendChild(nm);
        var mic = document.createElement('span');
        mic.className = 'mt-mic';
        mic.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
        // 阶段一百五十一补丁：设备可用性全员可见——远端由 meet_media 信令归口（micOk/camOk），
        // 麦克风不可用同款叉麦标记；摄像头不可用加叉摄标记（本端直接读 st 状态）
        var mm = st.members[user]; // self 无成员记录（mm=undefined），本端状态走 st 直接判断
        if (user !== 'self' && mm && (mm.muted || !mm.micOk)) tile.classList.add('muted');
        if (user === 'self' && (st.micUnavailable || st.muted)) tile.classList.add('muted'); // 叉麦：设备不可用或手动静音
        if (user === 'self' ? (st.camUnavailable || st.camOff) : !!(mm && (!mm.camOk || mm.camMuted))) tile.classList.add('cam-dead'); // 叉摄：设备不可用或手动关摄
        tile.appendChild(mic);
        var cami = document.createElement('span');
        cami.className = 'mt-cam';
        cami.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/></svg>';
        tile.appendChild(cami);
        return tile;
    }

    // 远端流到达后精准绑定到已存在 tile（避免整格重渲导致画面闪黑）
    function attachMeetStream(user, m) {
        var tile = $('meetGrid').querySelector('div.meet-tile[data-user="' + user + '"]');
        if (!tile || !m.stream) return;
        var el = tile.querySelector(st.callType === 'video' ? 'video' : 'audio');
        if (el) {
            el.srcObject = m.stream;
            var pr = el.play && el.play();
            if (pr && pr.catch) pr.catch(function () { });
        }
    }

    function markTileMuted(user, muted) {
        // 阶段一百五十一补丁：全量刷该成员所有 tile（宫格+缩略图+主舞台），设备不可用维持叉麦
        var mm = st.members[user];
        var off = !!muted || !!(mm && !mm.micOk);
        document.querySelectorAll('div.meet-tile[data-user="' + user + '"]').forEach(function (tile) {
            tile.classList.toggle('muted', off);
        });
    }

    // markTileCam 阶段一百五十一补丁：远端 tile 叉摄联动（camMuted=手动关摄 track 事件；camOk=设备可用性 meet_media）
    function markTileCam(user) {
        var mm = st.members[user];
        if (!mm) return;
        var off = !!mm.camMuted || !mm.camOk;
        document.querySelectorAll('div.meet-tile[data-user="' + user + '"]').forEach(function (tile) {
            tile.classList.toggle('cam-dead', off);
        });
    }

    // refreshSelfMarks 阶段一百五十一补丁：手动静音/关摄后同步自己 tile 标记（远端走 track 事件，本端直接读 st 状态）
    function refreshSelfMarks() {
        if (!st.meet) return;
        var micOff = st.micUnavailable || st.muted;
        var camOff = st.camUnavailable || st.camOff;
        document.querySelectorAll('div.meet-tile[data-user="self"]').forEach(function (tile) {
            tile.classList.toggle('muted', micOff);
            tile.classList.toggle('cam-dead', camOff);
        });
    }

    // 与成员建连（asOfferer=我方发 offer；false 时只建 pc 等对方 offer 应答）
    // addTrack/offer 经 onLocalReady 门闩：本地媒体未就绪先建 pc（保持信令路由有效），媒体延后
    function meetConnect(peer, asOfferer) {
        var m = st.members[peer];
        if (!m || m.pc) return;
        var conf = st.iceServers && st.iceServers.length ? { iceServers: st.iceServers } : null;
        var pc = new RTCPeerConnection(conf);
        m.pc = pc;
        // 阶段一百四十八：记录本 pair 的 offer 方向（建连方向规则：已在会成员→新成员单向发 offer；
        // 断网恢复沿用同方向——offerer 单点发起 restart，answerer 只应答，防双端 offer 冲突）
        m.asOfferer = !!asOfferer;
        pc.ontrack = function (e) {
            // 原代码：if (!e.streams || !e.streams.length) return;
            // 阶段一百四十九：空 msid 轨兜底（无摄像头共享占位场景对端 RTP 无 msid 时 e.streams
            // 为空，原直接丢画面）——复用成员已有流把轨加进去，避免多 track 各自兜底互相覆盖
            if (e.streams && e.streams.length) {
                m.stream = e.streams[0];
            } else {
                if (!m.stream) m.stream = new MediaStream();
                if (!m.stream.getTracks().some(function (t) { return t.id === e.track.id; })) m.stream.addTrack(e.track);
            }
            attachMeetStream(peer, m);
            // 远端麦克风状态联动（track muted 事件由接收端同步）
            var at = m.stream.getAudioTracks()[0];
            if (at) {
                var sync = function () { m.muted = !!at.muted; markTileMuted(peer, m.muted); };
                at.onmute = sync;
                at.onunmute = sync;
                sync();
            }
            // 阶段一百五十一补丁：远端摄像头状态联动（手动关摄 → 发送端 enabled=false → 接收端视频轨
            // mute 事件，与音轨同款机制；设备不可用走 meet_media 信令归口，两机制互补）
            var vt = m.stream.getVideoTracks()[0];
            if (vt) {
                var vsync = function () { m.camMuted = !!vt.muted; markTileCam(peer); };
                vt.onmute = vsync;
                vt.onunmute = vsync;
                vsync();
            }
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            // 阶段一百四十八：restart 期新收集候选进成员级缓存——断线窗口内 candidate 帧丢失，
            // WS 重连后由重试循环/应答路径全量重发，保证 ICE 配对候选齐全（与 1v1 同款）
            var cand = {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
            };
            if (m.iceRestartActive) cacheMeetRestartCand(peer, cand);
            send('candidate', { candidate: cand }, peer);
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || m.pc !== pc) return;
            var s = pc.connectionState;
            if (s === 'connected') {
                // 阶段一百四十八：断网自愈/restart 恢复清理（成员级状态全清）
                meetPairRecovered(peer);
            } else if (s === 'closed') {
                // closed 仅由本地主动 close 触发（drop/finish/换场），无需处理
            } else if (s === 'failed' || s === 'disconnected') {
                // 原代码：failed/closed → meetDropMember（媒体彻底失败即移除成员，2 人会议全员走光
                // 连带补发退房信令触发服务端解散，线上实测媒体断开 30s 即散会——可恢复的抖动变硬断开）。
                // 阶段一百四十八修正（成员移除归口服务端）：断网/失败立即标记 tile「连接中断」，
                // offerer 持续 restart 重试（WS 通则信令通，对端网络恢复即自动续上）；
                // 60s 放弃阈值兜底信令收口丢失场景（见 armMeetGiveup 注释）
                markMeetLost(peer, true);
                armMeetGiveup(peer);
                if (m.asOfferer) {
                    m.needRestart = true;
                    m.iceRestartActive = true; // 本端 restart 期新候选进缓存（重发兜底）
                    startMeetRestartLoop(peer);
                }
            }
        };
        onLocalReady(function () {
            if (st.ended || m.pc !== pc) return;
            if (asOfferer) {
                // offerer：轨道 + 收发器一次性补齐（缺媒体时 recvonly，保证 offer m 行完整）
                attachLocalMedia(pc, true);
                pc.createOffer().then(function (offer) {
                    return pc.setLocalDescription(offer).then(function () { return offer; });
                }).then(function (offer) {
                    if (!st.ended) send('offer', { sdp: { type: offer.type, sdp: offer.sdp } }, peer);
                }).catch(function () { meetDropMember(peer); });
            } else {
                // 应答方：轨道先挂上（幂等，远端 offer 到达后 m 行自动映射，answer 带上我的媒体）
                attachLocalMedia(pc, false);
            }
            // 阶段一百四十九：共享中途建连的新成员同步共享画面——attachLocalMedia 恒挂 st.local
            // 摄像头轨，而共享 replaceTrack 只作用于建连时已存在的成员连接；新成员入会/会中邀请/
            // 宽限踢出后被重新邀请建连时，不在此补挂则对方只能看到摄像头画面而非共享内容。
            // 原代码：内联 forEach 只认 sd.track 非空的 sender，漏掉无摄像头的空轨占位
            // （placeholder sender 无轨）——统一收口到 syncShareToPc（占位也作为替换目标）
            syncShareToPc(pc);
            renderMeetStage(); // 阶段一百五十一：舞台布局归口（原 renderMeetGrid 仅宫格）
        });
        renderMeetStage();
    }

    function flushMeetCands(peer) {
        var m = st.members[peer];
        if (!m || !m.pc) { if (m) m.pendingCands = []; return; }
        m.pendingCands.forEach(function (c) {
            try { m.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        });
        m.pendingCands = [];
    }

    // ===== 阶段一百四十八：会议 ICE restart 断网自动重连（Mesh 成员级，每对连接独立） =====
    // 仲裁：沿用 Mesh 建连方向规则——pair 内 offerer 单点发起 restart，answerer 纯应答（幂等），
    // 与 1v1「主叫单点发起」同构，天然防双端 offer 冲突；成员级状态全挂 st.members[peer]，
    // 与 1v1 全局 st.restart* 状态互不干扰（会议模式 1v1 状态恒空置）
    // 停该成员的 restart 重试循环（pair 连通恢复/成员移除/收口时调用）
    function stopMeetRestartLoop(peer) {
        var m = st.members[peer];
        if (!m) return;
        if (m.restartTimer) { clearInterval(m.restartTimer); m.restartTimer = null; }
        if (m.restartFirstTimer) { clearTimeout(m.restartFirstTimer); m.restartFirstTimer = null; }
    }
    // restart 期候选缓存（按 candidate 串去重；重复 addIceCandidate 对端亦无害）
    function cacheMeetRestartCand(peer, c) {
        var m = st.members[peer];
        if (!m) return;
        for (var i = 0; i < m.restartCands.length; i++) {
            if (m.restartCands[i].candidate === c.candidate) return;
        }
        m.restartCands.push(c);
    }
    // 全量重发该成员 restart 期候选（offerer 随每轮 offer 重发 / answerer 随 answer 重发）
    function flushMeetRestartCands(peer) {
        var m = st.members[peer];
        if (!m) return;
        m.restartCands.forEach(function (c) {
            send('candidate', { candidate: c }, peer);
        });
    }
    // 清干净该成员 restart 恢复期状态（pair 恢复/移除/收口时调用）
    function clearMeetRestartState(peer) {
        var m = st.members[peer];
        if (!m) return;
        m.iceRestartActive = false;
        m.needRestart = false;
        m.restartOffer = null;
        m.restartCands = [];
        m.lastRestartOffer = '';
        m.lastRestartAnswer = null;
    }
    // 单轮 restart 重试（对单个成员）：同轮复用同一 offer（restartIce 新 ufrag 只做一次，
    // 防对端反复重建），每轮重发 offer + 已收集候选——断网期间 WS 同断丢帧，socket.js 3s
    // 自动重连后重试帧自然送达（与 1v1 tryIceRestart 同构）
    function tryMeetIceRestart(peer) {
        var m = st.members[peer];
        if (st.ended || !m || !m.pc || !m.needRestart) { stopMeetRestartLoop(peer); return; }
        if (m.pc.connectionState === 'connected') { meetPairRecovered(peer); return; } // 已自愈
        if (m.restartOffer) {
            send('offer', { sdp: m.restartOffer }, peer); // 同轮重发
            flushMeetRestartCands(peer);
            return;
        }
        try { m.pc.restartIce(); } catch (e) { return; }
        m.pc.createOffer({ iceRestart: true }).then(function (off) {
            return m.pc.setLocalDescription(off).then(function () { return off; });
        }).then(function (off) {
            var mm = st.members[peer];
            if (st.ended || !mm || mm !== m) return; // 异步期间成员被移除：丢弃
            m.restartOffer = { type: off.type, sdp: off.sdp }; // 本轮定格，重试循环复用
            send('offer', { sdp: m.restartOffer }, peer);
            flushMeetRestartCands(peer);
        }).catch(function () { }); // 单次失败静默，重试循环/看门狗兜底
    }
    // 启动成员级重试循环：2s 首发短暂抖动自愈窗口，此后每 3s 重发（与 1v1 startRestartLoop 同构）
    function startMeetRestartLoop(peer) {
        stopMeetRestartLoop(peer);
        var m = st.members[peer];
        if (!m) return;
        m.restartFirstTimer = setTimeout(function () { tryMeetIceRestart(peer); }, 2000);
        m.restartTimer = setInterval(function () { tryMeetIceRestart(peer); }, 3000);
    }
    // 成员连接中断标记：tile 名字条显示「连接中断」，恢复连通自动清除。
    // 原代码：armMeetWatchdog 30s 看门狗超时 meetDropMember 移除成员（线上实测媒体断开即散会，
    // 可恢复抖动被误杀）——修正为 60s 放弃阈值（见 armMeetGiveup）
    function markMeetLost(peer, lost) {
        var m = st.members[peer];
        if (!m) return;
        var changed = m.lost !== !!lost;
        m.lost = !!lost;
        if (changed) renderMeetStage(); // 阶段一百五十一：舞台布局归口
    }
    function clearMeetLost(peer) {
        markMeetLost(peer, false);
    }
    // 阶段一百四十八兜底：成员级放弃阈值（60s，服务端 WS 宽限 30s 的 2 倍）。
    // 原代码：30s 即 drop（误解散）；纯「永不 drop」也不行——若对端挂断信令在 WS 断线窗口丢失，
    // 对端窗已关不会重发，本端媒体永久断但 WS 在会一直 restart 无果，房间滞留双方忙标记
    //（重新发起提示"忙碌中"）。现权衡：60s 内能恢复就恢复（网络抖动/切网场景全覆盖；
    // 对端 WS 断时服务端 30s 即踢出→本端收 hangup 帧走不到这里），60s 仍不通视为对端
    // 信令层已死/收口帧丢失，drop 该成员兜底（全走光时补发退房信令清忙）
    var meetRestartGiveupMs = 60000;
    function armMeetGiveup(peer) {
        var m = st.members[peer];
        if (!m) return;
        clearMeetGiveup(peer);
        m.giveupTimer = setTimeout(function () {
            if (st.ended) return;
            var mm = st.members[peer];
            if (!mm) return;
            if (mm.pc && mm.pc.connectionState === 'connected') return; // 已恢复
            meetDropMember(peer);
        }, meetRestartGiveupMs);
    }
    function clearMeetGiveup(peer) {
        var m = st.members[peer];
        if (m && m.giveupTimer) { clearTimeout(m.giveupTimer); m.giveupTimer = null; }
    }
    // pair 连通恢复：清中断标记 + 清放弃阈值 + 停重试 + 清 restart 状态 + 计时激活
    function meetPairRecovered(peer) {
        clearMeetGiveup(peer);
        clearMeetLost(peer);
        stopMeetRestartLoop(peer);
        clearMeetRestartState(peer);
        meetMaybeActive();
    }

    // 任一成员连通即进入 active 开始计时（会议语义：有人在会即计时，话单以服务端为准）
    function meetMaybeActive() {
        if (st.state === 'active' || st.ended) return;
        setActive();
    }

    // 成员离开：清成员级恢复状态 + 关连接 + 移 tile；全员走光则补退房信令后收口
    function meetDropMember(peer) {
        var m = st.members[peer];
        if (!m) return;
        clearMeetGiveup(peer);     // 阶段一百四十八：清成员级放弃阈值
        stopMeetRestartLoop(peer); // 阶段一百四十八：停成员级 restart 重试循环
        try { if (m.pc) m.pc.close(); } catch (e) { }
        delete st.members[peer];
        if (recRemote[peer]) { delete recRemote[peer]; recBadgeRefresh(); } // 退出清其录制状态（防徽标滞留「XX 录制中」）
        renderMeetStage(); // 阶段一百五十一：舞台布局归口（缩略图列同步移除该成员）
        var any = false;
        for (var k in st.members) { any = true; break; }
        if (!any) {
            // 原代码：直接 finish（不发退房信令）。
            // 阶段一百四十八：成员级看门狗/failed 触发全员走光时，服务端可能尚不知本端要退出
            //（对端 WS 仍在时服务端不会收口房间）——补发退房信令防房间滞留本端忙态；
            // hangup 帧对服务端 meetLeave 幂等无害（房间已解散时仅清忙标记）
            send('hangup', {});
            finish('会议已结束');
        }
    }

    // 会议信令处理（onSignal 顶部分流；frame.from_user 为对端账号，媒体帧按其路由到对应 pc）
    function meetOnSignal(p, frame) {
        var from = (frame && frame.from_user) || '';
        switch (p.action) {
            case 'room_info':
                // 新入会成员收：全员资料（服务端已排除自己），逐人建 pc 等 offer
                if (Array.isArray(p.ice) && p.ice.length) st.iceServers = p.ice;
                // 阶段一百五十二：凭会议号加入时 room_info 携带会议号（callOpen 已带则此处幂等跳过）
                if (p.meet_no && !st.meetNo) { st.meetNo = p.meet_no; meetNoShow(); }
                (p.members || []).forEach(function (mi) {
                    if (mi && mi.username && !st.members[mi.username]) {
                        st.members[mi.username] = {
                            name: mi.name || mi.username, avatar: mi.avatar || '', pc: null, stream: null, pendingCands: [], muted: false, micOk: true, camOk: true, camMuted: false,
                            // 阶段一百四十八：成员级断网恢复状态初始化（restart 系列缺省会导致缓存/幂等判空报错）
                            asOfferer: false, needRestart: false, iceRestartActive: false,
                            lost: false, restartCands: [], lastRestartOffer: '', lastRestartAnswer: null,
                            restartTimer: null, restartFirstTimer: null, giveupTimer: null,
                            sharing: false // 阶段一百五十一：该成员正在共享屏幕（meet_share 信令归口，主舞台布局依据）
                        };
                    }
                });
                st.state = 'connecting';
                toneStop();
                setMeetStatus('正在建立连接…');
                renderMeetStage(); // 阶段一百五十一：舞台布局归口
                // 修复：应答方也必须有 pc 才能处理 offer（此前漏建，offer 到达时被 !m.pc 丢弃，
                // 双方永久互等卡"等待成员加入"）；asOfferer=false 仅建 pc 不发 offer，幂等安全
                for (var ru in st.members) {
                    meetConnect(ru, false);
                }
                break;
            case 'meet_join':
                // 已在会成员收：新成员资料 + 由我发 offer（建连方向规则）；ICE 随帧注入（发起人唯一拿到配置的路径）
                if (Array.isArray(p.ice) && p.ice.length) st.iceServers = p.ice;
                var mi = p.member || {};
                if (!mi.username || st.members[mi.username]) break;
                st.members[mi.username] = {
                    name: mi.name || mi.username, avatar: mi.avatar || '', pc: null, stream: null, pendingCands: [], muted: false,
                    // 阶段一百四十八：成员级断网恢复状态初始化（同 room_info）
                    asOfferer: false, needRestart: false, iceRestartActive: false,
                    restartOffer: null, restartCands: [], lastRestartOffer: '', lastRestartAnswer: null,
                    lost: false, restartTimer: null, restartFirstTimer: null, giveupTimer: null,
                    sharing: false, // 阶段一百五十一：该成员正在共享屏幕（meet_share 信令归口，主舞台布局依据）
                    micOk: true, camOk: true, camMuted: false // 阶段一百五十一补丁：设备可用性（meet_media 信令归口；缺省视为可用防误显叉麦叉摄）
                };
                renderMeetStage(); // 阶段一百五十一：舞台布局归口
                meetConnect(mi.username, true);
                break;
            case 'offer': {
                var m = st.members[from];
                if (!m || !m.pc) break;
                // 阶段一百四十八：restart 幂等——offer 方重试循环重发同一 offer（sdp 相同）时
                // 只重发既有 answer + 候选缓存，不重复 setRemote/createAnswer（防本地 ICE 反复重建）
                if (m.lastRestartOffer && p.sdp && p.sdp.sdp === m.lastRestartOffer) {
                    if (m.lastRestartAnswer) send('answer', { sdp: m.lastRestartAnswer }, from);
                    flushMeetRestartCands(from);
                    break;
                }
                // 阶段一百四十八：已持有远端描述时再收 offer = 对端 ICE restart（首协商为首次到达）
                var isRestart = !!(m.pc.remoteDescription && m.pc.remoteDescription.type);
                var pcOffer = m.pc;
                pcOffer.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                    flushMeetCands(from);
                    if (isRestart) {
                        m.iceRestartActive = true;      // 本端 restart 期新候选进缓存（随 answer 重发兜底）
                        m.lastRestartOffer = p.sdp.sdp; // 记录本轮 offer（重复帧幂等判定）
                    }
                    // 应答也需本地轨道在 pc 上（getUserMedia 未就绪则延后），否则 answer 空 m 行
                    onLocalReady(function () {
                        if (st.ended || m.pc !== pcOffer) return;
                        attachLocalMedia(pcOffer, false); // 幂等挂轨（应答方不加收发器，m 行由 offer 映射）
                        // 阶段一百四十九：应答方无摄像头时按 offer SDP 的 m 行序补挂共享占位
                        // （transceiversIfNeeded=false 不走 addTransceiver 分支，_videoPlaceholder
                        // 此前从未挂上——共享时找不到替换目标，replaceTrack 静默未执行，对端看不到画面）
                        bindVideoShareTarget(pcOffer, p.sdp.sdp);
                        syncShareToPc(pcOffer); // 共享中则把屏幕轨补挂到该占位（新加入即见共享）
                        pcOffer.createAnswer().then(function (ans) {
                            return pcOffer.setLocalDescription(ans).then(function () { return ans; });
                        }).then(function (ans) {
                            if (st.ended) return;
                            var answerSdp = { type: ans.type, sdp: ans.sdp };
                            send('answer', { sdp: answerSdp }, from);
                            if (isRestart) {
                                m.lastRestartAnswer = answerSdp; // 留作重复 offer 的幂等重发
                                flushMeetRestartCands(from);
                            }
                        }).catch(function () { });
                    });
                }).catch(function () { });
                break;
            }
            case 'answer': {
                var m2 = st.members[from];
                if (!m2 || !m2.pc) break;
                // 阶段一百四十八：已连通且协商稳定时到达的迟到 answer 静默忽略
                //（restart 恢复后对端幂等重发/重试循环滞后帧，stable 态重复 setRemote 会报错）
                if (m2.pc.connectionState === 'connected' && m2.pc.signalingState === 'stable') break;
                m2.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                    flushMeetCands(from);
                }).catch(function () { });
                break;
            }
            case 'candidate': {
                var m3 = st.members[from];
                if (!m3 || !p.candidate) break;
                if (!m3.pc.remoteDescription || !m3.pc.remoteDescription.type) {
                    m3.pendingCands.push(p.candidate);
                } else {
                    try { m3.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
                }
                break;
            }
            case 'hangup':
                // 成员退出（服务端转发，frame.from_user=退出者）；全员走光由 meetDropMember 收口
                meetDropMember(from);
                break;
            case 'meet_declined':
                setMeetStatus((p.name || '成员') + ' 已拒绝加入');
                break;
            case 'meet_skipped':
                setMeetStatus('部分成员无法加入：' + (p.names || []).join('、'));
                break;
            case 'meet_share':
                // 阶段一百五十一：成员共享状态广播（frame.from_user=共享者，服务端转发其他成员）——
                // 主舞台布局归口：开启则抢占舞台，关闭则由 renderMeetStage 回退宫格/下一共享者
                var msu = st.members[from];
                if (!msu) break;
                msu.sharing = !!p.on;
                if (p.on) {
                    st.stageUser = from;
                    setMeetStatus((msu.name || from) + ' 正在共享屏幕');
                } else if (st.stageUser === from) {
                    st.stageUser = '';
                }
                renderMeetStage();
                break;
            case 'meet_media':
                // 阶段一百五十一补丁：成员设备可用性广播（frame.from_user=上报者）——
                // 麦克风/摄像头是否可用全员可见；服务端落快照供中途入会者补发。
                // 原代码：renderMeetStage() 整格重渲——视频元素销毁重建致远端画面闪黑；
                // 改为原位切换标记类（与本地 refreshSelfMarks 同款，媒体元素不动零闪烁）
                var mmu = st.members[from];
                if (!mmu) break;
                mmu.micOk = p.mic !== false;
                mmu.camOk = p.cam !== false;
                markTileMuted(from, !!mmu.muted);
                markTileCam(from);
                break;
            case 'meet_record':
                // 会议录制状态广播（frame.from_user=录制者）：全员「正在录制」知情提示（腾讯会议同款）；
                // 服务端落快照供中途入会者补发（on 快照/补发共用本入口）
                if (p.on) recRemote[from] = true;
                else delete recRemote[from];
                var rru = st.members[from];
                if (p.on && rru) setMeetStatus((rru.name || from) + ' 开始录制会议');
                recBadgeRefresh();
                break;
            case 'meet_members_list':
                // 阶段一百五十三：会议窗内邀请面板名单回包（面板开着才渲染；晚到/已关面板忽略）
                if (!inviteOpen) break;
                inviteMembers = Array.isArray(p.members) ? p.members : [];
                $('inviteSearch').disabled = false;
                renderInviteList();
                break;
            case 'meet_no':
                // 阶段一百五十二：创建人收服务端生成的会议号（建房后下发，窗口可能尚在加载——
                // 桥层信令缓冲兜底）——顶部徽标原位更新展示
                if (p.meet_no && st.meetNo !== p.meet_no) {
                    st.meetNo = p.meet_no;
                    meetNoShow();
                }
                break;
            case 'error':
                // 服务端归口错误帧（reason 为中文文案）：全员拒绝/60s 无人接听自动解散等场景收口会议窗
                // 原代码：无此分支——error 帧经会议分流进入本 switch 后被静默忽略，发起人会议窗滞留不关
                finish(p.reason || '会议已结束');
                break;
        }
    }

    // ===== 桌面共享（视频会议）：getDisplayMedia（主进程 setDisplayMediaRequestHandler 放行）
    // 共享画面经 replaceTrack 换掉摄像头轨道——同类型轨道替换无需重协商，全员无感知切换；
    // 语音会议无视频轨道不开放（避免 addTrack 触发全房重协商冲突）
    var sharing = false;
    var screenStream = null;
    // 阶段一百四十九：定位某成员 pc 的视频发送目标（共享轨替换处）——优先已有 video 轨的 sender
    //（摄像头/已共享），其次建连/应答时挂的空轨占位（无摄像头场景）
    function videoShareTargetOf(pc) {
        var target = null;
        pc.getSenders().forEach(function (sd) {
            if (!target && sd.track && sd.track.kind === 'video') target = sd;
        });
        return target || pc._videoPlaceholder || null;
    }
    // 阶段一百四十九：黑帧占位轨（全局单 canvas 惰性创建，captureStream(0) 手动 requestFrame
    // 仅出一帧——持续带宽≈0）。用途：被邀人（answerer）无摄像头时给 video 收发器塞占位，
    // 使 answer 的 m=video 变为 sendrecv+msid（对端协商期即建立流关联），共享时 replaceTrack
    // 换屏轨同 sender 零重协商、SSRC 连续切换
    var _phCanvas = null;
    function makePlaceholderVideoTrack() {
        try {
            if (!_phCanvas) {
                _phCanvas = document.createElement('canvas');
                _phCanvas.width = 2;
                _phCanvas.height = 2;
                _phCanvas.getContext('2d').fillStyle = '#000';
                _phCanvas.getContext('2d').fillRect(0, 0, 2, 2);
            }
            var t = _phCanvas.captureStream(0).getVideoTracks()[0];
            if (t.requestFrame) t.requestFrame();
            return t;
        } catch (e) { return null; }
    }
    // 阶段一百四十九：被邀人（answerer）无摄像头时挂共享占位——answer 的 m 行由 offer 映射，
    // 不经过 addTransceiver 路径（占位只在 offerer 建连时挂）；按 offer SDP 的 m 行序定位 video
    // 收发器，其 sender 即共享轨替换目标（getTransceivers 顺序与 SDP m 行顺序一致）。
    // 原代码：仅挂 sender 不动方向——实测 Chrome 对 setRemoteDescription(offer) 自动创建的
    // 收发器初始 direction=recvonly（本端此刻无发送轨），answer 为 recvonly 无 msid，事后
    // replaceTrack 塞屏轨方向不允许发送、对端也无流关联（被邀人共享对端看不到根因）
    function bindVideoShareTarget(pc, offerSdp) {
        if (!pc || pc._videoPlaceholder) return;
        if (pc.getSenders().some(function (sd) { return sd.track && sd.track.kind === 'video'; })) return;
        if (!offerSdp) return;
        var mLines = offerSdp.split('\r\n').filter(function (l) { return l.indexOf('m=') === 0; });
        for (var i = 0; i < mLines.length; i++) {
            if (mLines[i].indexOf('m=video') === 0 && pc.getTransceivers()[i]) {
                var tr = pc.getTransceivers()[i];
                tr.direction = 'sendrecv'; // 方向升级：recvonly 不允许发送（实测对照 W 场景失败）
                var phTrack = makePlaceholderVideoTrack(); // 占位轨：answer 即带 msid 建立对端流关联
                if (phTrack) {
                    try { tr.sender.replaceTrack(phTrack); } catch (e) { }
                }
                pc._videoPlaceholder = tr.sender;
                return;
            }
        }
    }
    // 阶段一百四十九：共享中向指定成员 pc 同步屏幕轨（新成员建连/被邀人占位挂好后补挂）
    function syncShareToPc(pc) {
        if (!sharing || !screenStream || !pc) return;
        var target = videoShareTargetOf(pc);
        if (!target) return;
        var sv = screenStream.getVideoTracks()[0];
        if (sv) {
            try { target.replaceTrack(sv); } catch (e) { }
        }
    }
    function meetReplaceVideoTrack(track) {
        for (var u in st.members) {
            var m = st.members[u];
            if (!m || !m.pc) continue;
            var target = videoShareTargetOf(m.pc);
            if (target) {
                try { target.replaceTrack(track); } catch (e) { }
            }
        }
    }
    function stopMeetShare() {
        if (!sharing) return;
        sharing = false;
        // 阶段一百五十一补丁：共享结束解除本窗内容保护（窗口恢复可被捕获/截图）
        if (window.desktop && window.desktop.setShareProtected) window.desktop.setShareProtected(false);
        var camTrack = st.local ? st.local.getVideoTracks()[0] : null;
        // 原代码：meetReplaceVideoTrack(camTrack || null)——无摄像头停止共享后对端画面定格
        // 在屏轨最后一帧；改塞回黑帧占位（对端回到明确的黑屏，与未共享时一致）
        meetReplaceVideoTrack(camTrack || makePlaceholderVideoTrack());
        if (screenStream) {
            try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
            screenStream = null;
        }
        btnShare.classList.remove('active');
        btnShare.title = '共享屏幕';
        btnCam.disabled = false;
        // 本地预览切回摄像头（原手动改 srcObject——占位元素残留盖住预览，统一重绘解决）
        // 阶段一百五十一：广播共享关闭（服务端转发其他成员撤主舞台）+ 舞台布局归口（原 renderMeetGrid 仅宫格）
        if (st.meet) send('meet_share', { on: false });
        renderMeetStage();
    }
    function toggleMeetShare() {
        // 原代码：if (st.ended || !st.local || !st.local.getVideoTracks().length) return;
        // 阶段一百四十九：无摄像头也可共享屏幕（video m 行 sendrecv 空轨占位，共享时塞屏轨
        // 零重协商）——前置只拦会议收口与语音会议（语音无 video m 行，共享需全房重协商不开放）
        if (st.ended || st.callType !== 'video') return;
        if (sharing) { stopMeetShare(); return; }
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (ss) {
            if (st.ended) {
                try { ss.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
                return;
            }
            screenStream = ss;
            sharing = true;
            // 阶段一百五十一补丁：共享期间本窗内容保护（防"窗口套窗口"递归画面；
            // WDA_EXCLUDEFROMCAPTURE——捕获画面不含会议窗但本地正常显示；仅 PC 端有此能力）
            if (window.desktop && window.desktop.setShareProtected) window.desktop.setShareProtected(true);
            var vt = ss.getVideoTracks()[0];
            meetReplaceVideoTrack(vt);
            vt.onended = function () { stopMeetShare(); }; // 用户点系统停止条自动收
            btnShare.classList.add('active');
            btnShare.title = '停止共享';
            btnCam.disabled = true; // 共享期间禁摄像头开关（同一视频轨道）
            // 本地预览切共享画面（原手动改 srcObject——无摄像头时"无视频可用"占位残留盖住预览，
            // 统一走重绘：self tile 流参数与占位显隐一次到位）
            // 阶段一百五十一：广播共享开启（全员一致视图，服务端转发其他成员）+ 自己抢占主舞台
            if (st.meet) send('meet_share', { on: true });
            st.stageUser = 'self';
            renderMeetStage();
        }).catch(function (e) {
            // 阶段一百四十九：失败可见化（原静默吞错——点击无反应用户无从判断）
            // 阶段一百五十一补丁：兜底文案附带错误名（PC 端排障定位）
            var msg = '屏幕共享不可用';
            if (e && e.name === 'NotAllowedError') msg = '屏幕共享未授权（浏览器拒绝或已取消）';
            else if (e && e.name === 'NotSupportedError') msg = '当前环境不支持屏幕共享';
            else if (e && (e.name || e.message)) msg = '屏幕共享不可用（' + (e.name || e.message) + '）';
            setMeetStatus(msg);
        });
    }

    // ===== 信令下行（帧为完整协议帧：{msg_type, from_user, to_user, content}） =====
    function onSignal(frame) {
        if (!frame || st.ended) return;
        var p;
        try { p = JSON.parse(frame.content); } catch (e) { return; }
        if (!p || p.call_id !== st.callId) return; // 按 call_id 过滤（窗口复用/残留帧防御）
        if (st.meet) { meetOnSignal(p, frame); return; } // 阶段一百四十四：会议分流（room_info/join/定向媒体帧）
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
                // 阶段一百四十七：active 态收 answer = ICE restart 恢复应答（首协商为 connecting）
                if (st.state !== 'connecting' && st.state !== 'active') return;
                st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                    flushCands();
                }).catch(function () { }); // restart 期间乱序 answer 静默忽略，重试循环/看门狗兜底
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

    // ===== 通话任务下发（data = {role, call_id, peer, peer_name, peer_avatar, call_type}
    //       会议模式 data = {role, call_id, call_type, meet:true, group_id, meet_title, self_name, self_avatar}） =====
    d.onCallLoad(function (data) {
        if (!data || !data.call_id) return;
        if (st.callId && st.callId !== data.call_id) resetState();
        if (data.meet) { meetInit(data); return; } // 阶段一百四十四：会议分流（宫格 + Mesh 建连）
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
        getMediaDegrade().then(function (r) {
            if (st.ended) {
                if (r.stream) { try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
                return;
            }
            st.local = r.stream;
            st.micUnavailable = !r.mic;
            st.camUnavailable = st.callType === 'video' && !r.cam;
            applyMediaMarks();
            if (st.callType === 'video' && r.stream) $('cwLocal').srcObject = r.stream; // 本地画中画（等待期即可预览）
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
            // 降级提示（一次性；后续状态/计时文案覆盖）
            // 阶段一百四十五：非安全上下文（http 非 localhost）时补充浏览器硬约束说明（getUserMedia 不可用的根因）
            if (st.micUnavailable && st.camUnavailable) setStatusText(mediaInsecure() ? '浏览器需 HTTPS 或 localhost 访问方可通话' : '麦克风/摄像头不可用');
            else if (st.camUnavailable) setStatusText('摄像头不可用');
            else if (st.micUnavailable) setStatusText(mediaInsecure() ? '浏览器需 HTTPS 或 localhost 访问方可通话' : '麦克风不可用');
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
        refreshSelfMarks(); // 自己 tile 同步叉麦标记
        // 阶段一百五十一补丁：静音/关摄状态走显式信令归口（接收端 track 事件对 enabled=false 不可靠）
        if (st.meet) send('meet_media', { mic: !st.micUnavailable && !st.muted, cam: !st.camUnavailable && !st.camOff });
    });
    btnCam.addEventListener('click', function () {
        if (st.ended || !st.local) return;
        st.camOff = !st.camOff;
        st.local.getVideoTracks().forEach(function (t) { t.enabled = !st.camOff; });
        btnCam.classList.toggle('active', st.camOff);
        btnCam.title = st.camOff ? '开启摄像头' : '关闭摄像头';
        document.body.classList.toggle('cam-off', st.camOff);
        refreshSelfMarks(); // 自己 tile 同步叉摄标记
        // 阶段一百五十一补丁：关摄/静音状态走显式信令归口（接收端 track 事件对 enabled=false 不可靠）
        if (st.meet) send('meet_media', { mic: !st.micUnavailable && !st.muted, cam: !st.camUnavailable && !st.camOff });
    });
    btnHangup.addEventListener('click', function () { doHangup(); });
    // 阶段一百四十四：会议控制（共享屏幕 / 会中邀请）
    btnShare.addEventListener('click', function () { toggleMeetShare(); });
    // 会议录制（腾讯会议同款本地录制）：开=弹保存对话框后起录，停=收口写盘；挂断自动停并保存
    if (btnRecord) btnRecord.addEventListener('click', function () {
        if (rec.active) stopMeetRecording();
        else startMeetRecording();
    });
    // 阶段一百五十一：腾讯会议同款全屏（右上角按钮 / 双击画面切换，Esc 退出）
    var btnMeetFs = $('btnMeetFs');
    if (btnMeetFs) btnMeetFs.addEventListener('click', toggleMeetFullscreen);
    $('meetWrap').addEventListener('dblclick', toggleMeetFullscreen);
    // 阶段一百五十一补丁：最小化按钮（仅 PC 端显示；HTML 默认 display:none，有 desktop 能力才亮出）
    var btnMeetMin = $('btnMeetMin');
    if (btnMeetMin && window.desktop && window.desktop.callMinimize) {
        btnMeetMin.style.display = '';
        btnMeetMin.addEventListener('click', function () { window.desktop.callMinimize(); });
    }
    // 阶段一百五十二：会议号徽标点击复制（clipboard API 优先，secure context 缺失回退 execCommand）
    var meetNoEl = $('meetNo');
    if (meetNoEl) meetNoEl.addEventListener('click', copyMeetNo);
    btnInvite.addEventListener('click', function () {
        // 阶段一百五十三：会议窗内直接弹邀请面板（原经主进程桥跳主窗口选人弹窗，
        // 弹窗被会议窗遮挡需来回切窗；现面板独立内嵌，名单/状态服务端归口）
        openInvitePanel();
    });
    // 阶段一百五十三：邀请面板交互（关闭钮/取消/遮罩点击/搜索过滤/Esc/确认邀请）
    var btnInviteCloseEl = $('btnInviteClose');
    if (btnInviteCloseEl) btnInviteCloseEl.addEventListener('click', closeInvitePanel);
    var btnInviteCancelEl = $('btnInviteCancel');
    if (btnInviteCancelEl) btnInviteCancelEl.addEventListener('click', closeInvitePanel);
    var inviteMaskEl = $('inviteMask');
    if (inviteMaskEl) inviteMaskEl.addEventListener('mousedown', function (e) {
        if (e.target === inviteMaskEl) closeInvitePanel(); // 点遮罩关闭（点面板本身不关）
    });
    var inviteSearchEl = $('inviteSearch');
    if (inviteSearchEl) inviteSearchEl.addEventListener('input', function () {
        if (inviteOpen) renderInviteList();
    });
    var btnInviteConfirmEl = $('btnInviteConfirm');
    if (btnInviteConfirmEl) btnInviteConfirmEl.addEventListener('click', function () {
        var picked = [];
        for (var u in inviteSelected) picked.push(u);
        if (st.ended || !picked.length) return;
        // 复用 meet_invite 追加邀请链路（服务端按 call_id 识别已有房间走 meetInviteMore，
        // send 自带 call_id；新成员 accept 后经 meet_join/room_info 增量建连，反馈走 meet_skipped）
        send('meet_invite', { call_type: st.callType, group_id: st.groupId, members: picked });
        closeInvitePanel();
        setMeetStatus('邀请已发送，等待成员加入…');
    });
    // Esc 关面板（会议窗无既有 keydown 监听，此处唯一入口；优先于其他 Esc 语义）
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && inviteOpen) closeInvitePanel();
    });
})();
