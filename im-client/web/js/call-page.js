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
        pendingCands: [],    // 远端描述未就绪前的 ICE 候选缓冲（乱序到达）
        iceServers: [],      // 服务端经信令下发的 stun/turn 配置（阶段一百四十二二期；未启用为空数组纯 P2P）
        // ===== 阶段一百四十四：多人会议（Mesh 全员互连） =====
        meet: false,         // 会议模式开关（true 时 1v1 单人视图逻辑不参与）
        groupId: 0,          // 发起群（会中邀请时回传主窗口定位群成员范围）
        meetTitle: '',       // 会议标题（群名，主窗口下发）
        members: {}          // username -> {name, avatar, pc, stream, pendingCands, muted}（Mesh 每成员一条连接）
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
    function gumTry(cons) {
        return navigator.mediaDevices.getUserMedia(cons);
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
            btnShare.disabled = st.camUnavailable; // 共享屏幕依赖视频轨道发送
            if (st.camUnavailable) btnShare.title = '摄像头不可用，无法共享屏幕';
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
            if (st.callType === 'video' && !hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });
        }
    }

    function buildPC() {
        // ICE 配置：服务端经信令下发 iceServers（stun/turn）时走打洞+中继兜底；
        // 未下发（turn.enabled=false）为空配置纯 P2P 直连（同网段/公网直连场景）
        var conf = st.iceServers && st.iceServers.length ? { iceServers: st.iceServers } : null;
        var pc = new RTCPeerConnection(conf);
        attachLocalMedia(pc, true);
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
        // 阶段一百四十四：会议收口清理（逐成员关连接 + 停共享流）
        for (var mu in st.members) {
            try { if (st.members[mu].pc) st.members[mu].pc.close(); } catch (e) { }
        }
        st.members = {};
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
        // 阶段一百四十四：会议连接与共享状态清理
        for (var mu in st.members) {
            try { if (st.members[mu].pc) st.members[mu].pc.close(); } catch (e) { }
        }
        st.members = {};
        sharing = false;
        if (screenStream) {
            try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
            screenStream = null;
        }
        btnShare.classList.remove('active');
        btnCam.disabled = false;
        btnInvite.classList.add('hidden');
        btnShare.classList.add('hidden');
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
        st.selfName = data.self_name || '我';
        st.selfAvatar = data.self_avatar || '';
        if (Array.isArray(data.ice_servers) && data.ice_servers.length) st.iceServers = data.ice_servers;
        document.body.className = 'mode-meet ' + (st.callType === 'video' ? 'mode-video' : 'mode-audio');
        $('meetTitle').textContent = st.meetTitle;
        // 会议控制条显隐：视频会议显摄像头/共享屏幕，语音会议仅静音；邀请成员会议恒显（1v1 保持原样）
        if (st.callType === 'video') {
            btnCam.classList.remove('hidden');
            btnShare.classList.remove('hidden');
        }
        btnInvite.classList.remove('hidden');
        $('meetStatus').textContent = st.role === 'caller' ? '等待成员加入…' : '正在加入会议…';
        getMediaDegrade().then(function (r) {
            if (st.ended) {
                if (r.stream) { try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
                return;
            }
            st.local = r.stream;
            st.micUnavailable = !r.mic;
            st.camUnavailable = st.callType === 'video' && !r.cam;
            applyMediaMarks();
            renderMeetGrid(); // 无媒体也渲染（自己 tile 出"无视频可用"占位/语音 tile 出头像）
            // 门闩放行：无媒体也照常建连（offer 经 attachLocalMedia 补 recvonly 收发器），设备状态不阻断会议
            if (!localReady) {
                localReady = true;
                var tasks = localTasks.splice(0);
                tasks.forEach(function (fn) { fn(); });
            }
            if (st.role === 'caller') {
                st.state = 'waiting';
                toneStart(); // 主叫回铃音（等待成员加入）
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
        // 自己 tile（本地预览 muted 防啸叫）
        grid.appendChild(buildMeetTile('self', st.selfName || '我', st.selfAvatar || '', st.local, true, w, h));
        users.forEach(function (u) {
            var m = st.members[u];
            grid.appendChild(buildMeetTile(u, m.name, m.avatar, m.stream, false, w, h));
        });
    }

    function buildMeetTile(user, name, avatar, stream, isSelf, w, h) {
        var tile = document.createElement('div');
        tile.className = 'meet-tile';
        tile.style.width = w;
        tile.style.height = h;
        tile.setAttribute('data-user', user);
        if (st.callType === 'video') {
            var v = document.createElement('video');
            v.autoplay = true;
            v.playsInline = true;
            if (isSelf) v.muted = true;
            if (stream) v.srcObject = stream;
            tile.appendChild(v);
            // 摄像头不可用：本地画面出"无视频可用"占位（通信不阻断，仅此一处标记）
            if (isSelf && st.camUnavailable) {
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
                a.srcObject = stream;
                tile.appendChild(a);
            }
        }
        // 名字条 + 麦克风状态图标（远端静音由 track.muted 事件联动）
        var nm = document.createElement('div');
        nm.className = 'mt-name';
        nm.textContent = name + (isSelf ? '（我）' : '');
        tile.appendChild(nm);
        var mic = document.createElement('span');
        mic.className = 'mt-mic';
        mic.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>';
        if (user !== 'self' && st.members[user] && st.members[user].muted) tile.classList.add('muted');
        if (user === 'self' && st.micUnavailable) tile.classList.add('muted'); // 麦克风不可用同款叉麦标记
        tile.appendChild(mic);
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
        var tile = $('meetGrid').querySelector('div.meet-tile[data-user="' + user + '"]');
        if (tile) tile.classList.toggle('muted', !!muted);
    }

    // 与成员建连（asOfferer=我方发 offer；false 时只建 pc 等对方 offer 应答）
    // addTrack/offer 经 onLocalReady 门闩：本地媒体未就绪先建 pc（保持信令路由有效），媒体延后
    function meetConnect(peer, asOfferer) {
        var m = st.members[peer];
        if (!m || m.pc) return;
        var conf = st.iceServers && st.iceServers.length ? { iceServers: st.iceServers } : null;
        var pc = new RTCPeerConnection(conf);
        m.pc = pc;
        pc.ontrack = function (e) {
            if (!e.streams || !e.streams.length) return;
            m.stream = e.streams[0];
            attachMeetStream(peer, m);
            // 远端麦克风状态联动（track muted 事件由接收端同步）
            var at = e.streams[0].getAudioTracks()[0];
            if (at) {
                var sync = function () { m.muted = !!at.muted; markTileMuted(peer, m.muted); };
                at.onmute = sync;
                at.onunmute = sync;
                sync();
            }
        };
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            send('candidate', {
                candidate: {
                    candidate: e.candidate.candidate,
                    sdpMid: e.candidate.sdpMid,
                    sdpMLineIndex: e.candidate.sdpMLineIndex
                }
            }, peer);
        };
        pc.onconnectionstatechange = function () {
            if (st.ended || m.pc !== pc) return;
            var s = pc.connectionState;
            if (s === 'connected') meetMaybeActive();
            else if (s === 'failed' || s === 'closed') meetDropMember(peer);
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
            renderMeetGrid();
        });
        renderMeetGrid();
    }

    function flushMeetCands(peer) {
        var m = st.members[peer];
        if (!m || !m.pc) { if (m) m.pendingCands = []; return; }
        m.pendingCands.forEach(function (c) {
            try { m.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        });
        m.pendingCands = [];
    }

    // 任一成员连通即进入 active 开始计时（会议语义：有人在会即计时，话单以服务端为准）
    function meetMaybeActive() {
        if (st.state === 'active' || st.ended) return;
        setActive();
    }

    // 成员离开：关连接 + 移 tile；全员走光则收口
    function meetDropMember(peer) {
        var m = st.members[peer];
        if (!m) return;
        try { if (m.pc) m.pc.close(); } catch (e) { }
        delete st.members[peer];
        renderMeetGrid();
        var any = false;
        for (var k in st.members) { any = true; break; }
        if (!any) finish('会议已结束');
    }

    // 会议信令处理（onSignal 顶部分流；frame.from_user 为对端账号，媒体帧按其路由到对应 pc）
    function meetOnSignal(p, frame) {
        var from = (frame && frame.from_user) || '';
        switch (p.action) {
            case 'room_info':
                // 新入会成员收：全员资料（服务端已排除自己），逐人建 pc 等 offer
                if (Array.isArray(p.ice) && p.ice.length) st.iceServers = p.ice;
                (p.members || []).forEach(function (mi) {
                    if (mi && mi.username && !st.members[mi.username]) {
                        st.members[mi.username] = { name: mi.name || mi.username, avatar: mi.avatar || '', pc: null, stream: null, pendingCands: [], muted: false };
                    }
                });
                st.state = 'connecting';
                toneStop();
                setMeetStatus('正在建立连接…');
                renderMeetGrid();
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
                st.members[mi.username] = { name: mi.name || mi.username, avatar: mi.avatar || '', pc: null, stream: null, pendingCands: [], muted: false };
                renderMeetGrid();
                meetConnect(mi.username, true);
                break;
            case 'offer': {
                var m = st.members[from];
                if (!m || !m.pc) break;
                var pcOffer = m.pc;
                pcOffer.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                    flushMeetCands(from);
                    // 应答也需本地轨道在 pc 上（getUserMedia 未就绪则延后），否则 answer 空 m 行
                    onLocalReady(function () {
                        if (st.ended || m.pc !== pcOffer) return;
                        attachLocalMedia(pcOffer, false); // 幂等挂轨（应答方不加收发器，m 行由 offer 映射）
                        pcOffer.createAnswer().then(function (ans) {
                            return pcOffer.setLocalDescription(ans).then(function () { return ans; });
                        }).then(function (ans) {
                            if (!st.ended) send('answer', { sdp: { type: ans.type, sdp: ans.sdp } }, from);
                        }).catch(function () { });
                    });
                }).catch(function () { });
                break;
            }
            case 'answer': {
                var m2 = st.members[from];
                if (!m2 || !m2.pc) break;
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
        }
    }

    // ===== 桌面共享（视频会议）：getDisplayMedia（主进程 setDisplayMediaRequestHandler 放行）
    // 共享画面经 replaceTrack 换掉摄像头轨道——同类型轨道替换无需重协商，全员无感知切换；
    // 语音会议无视频轨道不开放（避免 addTrack 触发全房重协商冲突）
    var sharing = false;
    var screenStream = null;
    function meetReplaceVideoTrack(track) {
        for (var u in st.members) {
            var m = st.members[u];
            if (!m || !m.pc) continue;
            m.pc.getSenders().forEach(function (sd) {
                if (sd.track && sd.track.kind === 'video') {
                    try { sd.replaceTrack(track); } catch (e) { }
                }
            });
        }
    }
    function stopMeetShare() {
        if (!sharing) return;
        sharing = false;
        var camTrack = st.local ? st.local.getVideoTracks()[0] : null;
        meetReplaceVideoTrack(camTrack || null);
        if (screenStream) {
            try { screenStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
            screenStream = null;
        }
        btnShare.classList.remove('active');
        btnShare.title = '共享屏幕';
        btnCam.disabled = false;
        // 本地预览切回摄像头
        var tile = $('meetGrid').querySelector('div.meet-tile[data-user="self"] video');
        if (tile && st.local) tile.srcObject = st.local;
    }
    function toggleMeetShare() {
        // 共享屏幕依赖视频轨道发送（replaceTrack 换轨）；摄像头不可用/无视频轨时不可共享
        if (st.ended || !st.local || !st.local.getVideoTracks().length) return;
        if (sharing) { stopMeetShare(); return; }
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (ss) {
            if (st.ended) {
                try { ss.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
                return;
            }
            screenStream = ss;
            sharing = true;
            var vt = ss.getVideoTracks()[0];
            meetReplaceVideoTrack(vt);
            vt.onended = function () { stopMeetShare(); }; // 用户点系统停止条自动收
            btnShare.classList.add('active');
            btnShare.title = '停止共享';
            btnCam.disabled = true; // 共享期间禁摄像头开关（同一视频轨道）
            var tile = $('meetGrid').querySelector('div.meet-tile[data-user="self"] video');
            if (tile) tile.srcObject = ss; // 本地预览切共享画面
        }).catch(function () { });
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
            if (st.micUnavailable && st.camUnavailable) setStatusText('麦克风/摄像头不可用');
            else if (st.camUnavailable) setStatusText('摄像头不可用');
            else if (st.micUnavailable) setStatusText('麦克风不可用');
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
    // 阶段一百四十四：会议控制（共享屏幕 / 会中邀请）
    btnShare.addEventListener('click', function () { toggleMeetShare(); });
    btnInvite.addEventListener('click', function () {
        // 请求主窗口弹群成员选择弹窗（已在会成员一并回传供过滤，重复邀请由服务端归口跳过）
        if (st.ended || !st.meet) return;
        var names = [];
        for (var u in st.members) names.push(u);
        if (d.meetInviteAsk) {
            d.meetInviteAsk({
                call_id: st.callId, call_type: st.callType,
                group_id: st.groupId, members: names
            });
        }
    });
})();
