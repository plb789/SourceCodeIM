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
        pendingCands: [], // 远端描述就绪前缓冲的 ICE 候选（offer/answer 竞态兜底）
        // 阶段三百零四：GDI 帧抓屏兜底（提权进程 WGC 抓屏必失败 / getDisplayMedia 不可用环境）
        // 主进程 BitBlt 逐帧 JPEG → canvas 绘制 → captureStream 出视频轨，WebRTC 链路其余复用
        gdi: false,
        gdiDraw: null,        // 帧到达回调（画到 canvas；停止时置空，帧事件订阅常驻页面生命周期）
        gdiSubscribed: false  // rec:gdi-frame 订阅只挂一次（ipcRenderer.on 无解绑，重复挂会叠加回调）
    };
    var sendFn = null; // chat.js 注入：function(obj) → remoteSignalSend(对端, obj)
    var stopCb = null; // chat.js 注入：引擎停止回调（主动停共享/媒体自保时归口 disconnect 信令）

    function log() {
        try { console.log.apply(console, ['[remote-engine]'].concat([].slice.call(arguments))); } catch (e) { }
    }

    // 阶段三百零四：被控端排障日志——渲染层 console 在打包形态不可见，关键节点同步落 userData/main.log
    function log2() {
        try { log.apply(null, arguments); } catch (e) { }
        try {
            var parts = [].slice.call(arguments).map(function (x) {
                if (x === null || x === undefined) return '';
                if (typeof x === 'string') return x;
                try { return JSON.stringify(x); } catch (e) { return String(x); }
            });
            if (window.desktop && window.desktop.clientLog) window.desktop.clientLog('[remote-engine] ' + parts.join(' '));
        } catch (e) { }
    }

    // ===== 阶段三百零四：被控端抓屏双通道 =====
    // 抓屏失败会让悬浮条瞬开瞬关（catch→stop→disconnect），控制端只看到"对方已断开协助"，
    // 被控端也毫无提示——根源是 getDisplayMedia 走 Windows.Graphics.Capture，管理员提权进程
    // CreateForMonitor 恒返 E_ACCESSDENIED（与本项目录屏 2026-11-02 提权对照实验同根因）。
    // 故：提权直接走主进程 GDI 帧通道；非提权 getDisplayMedia 失败同样回退 GDI，保证能作为被控端。
    function stopGdi() {
        var wasGdi = st.gdi;
        st.gdiDraw = null;
        st.gdi = false;
        // 仅在本次会话确实占用 GDI 通道时才停主进程推帧循环（否则会误停同时进行的录屏 GDI 兜底）
        if (wasGdi) { try { if (window.desktop && window.desktop.recGdiStop) window.desktop.recGdiStop('remote'); } catch (e) { } }
    }

    function startGdiStream() {
        return new Promise(function (resolve, reject) {
            var d = window.desktop || {};
            if (!d.recGdiStart || !d.onRecGdiFrame) {
                reject(new Error(I18N.t('GDI 抓屏通道不可用（客户端版本过低或非 PC 端）')));
                return;
            }
            var dpr = window.devicePixelRatio || 1;
            // 主屏物理像素矩形（与录屏 GDI 通道同一坐标系：屏幕物理像素）
            var sw = Math.max(2, Math.round((window.screen.width || 1920) * dpr));
            var sh = Math.max(2, Math.round((window.screen.height || 1080) * dpr));
            // 编码侧收敛到 1080p 内：4K 全屏逐帧 JPEG + VP8 编码会打满 CPU，等比降采样后再送 WebRTC
            var scale = Math.min(1, 1920 / sw, 1080 / sh);
            var cw = Math.max(2, Math.round(sw * scale / 2) * 2); // 偶数宽高：VP8 编码器要求
            var ch = Math.max(2, Math.round(sh * scale / 2) * 2);
            var canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            var ctx = canvas.getContext('2d', { alpha: false });
            var gotFrame = false, decoding = false;
            st.gdi = true;
            st.gdiDraw = function (buf) {
                if (!st.gdi || decoding) return; // 背压：上一帧未画完直接丢帧（15fps 足够流畅）
                decoding = true;
                try {
                    var blob = new Blob([buf], { type: 'image/jpeg' });
                    createImageBitmap(blob).then(function (bmp) {
                        try {
                            if (st.gdi) { ctx.drawImage(bmp, 0, 0, cw, ch); gotFrame = true; }
                        } catch (e) { }
                        try { bmp.close(); } catch (e) { }
                        decoding = false;
                    }, function () { decoding = false; });
                } catch (e) { decoding = false; }
            };
            if (!st.gdiSubscribed) {
                st.gdiSubscribed = true;
                d.onRecGdiFrame(function (buf) { if (st.gdiDraw) st.gdiDraw(buf); });
            }
            var fail = function (msg) {
                stopGdi();
                reject(new Error(msg));
            };
            // owner='remote'：与录屏共用主进程单例抓屏循环（属主互斥，录屏占用时主进程返 'busy'）
            d.recGdiStart(0, 0, sw, sh, 'remote').then(function (ok) {
                if (ok !== true) {
                    fail(ok === 'busy' ? I18N.t('屏幕通道被占用（录屏进行中）') : I18N.t('GDI 抓屏启动失败'));
                    return;
                }
                var waited = 0;
                var iv = setInterval(function () {
                    if (!st.gdi) { clearInterval(iv); return; }
                    if (!gotFrame) {
                        if ((waited += 100) < 3000) return;
                        clearInterval(iv);
                        fail(I18N.t('GDI 抓屏无数据'));
                        return;
                    }
                    clearInterval(iv);
                    var stream = canvas.captureStream(15);
                    var vt = stream.getVideoTracks()[0];
                    if (!vt) {
                        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
                        fail(I18N.t('GDI 抓屏无视频轨'));
                        return;
                    }
                    log2('GDI 抓屏就绪', cw + 'x' + ch, '源', sw + 'x' + sh);
                    resolve(stream);
                }, 100);
            }).catch(function (err) { fail((err && err.message) || I18N.t('GDI 抓屏启动失败')); });
        });
    }

    // 抓屏归口：提权 → GDI；非提权 getDisplayMedia 失败 → GDI 兜底（都失败抛出可读原因）
    // 失败错误统一打 __capture 标记，供 startSharer 区分是抓屏失败还是建连失败（提示文案不同）
    function acquireScreen() {
        var d = window.desktop || {};
        var elevQ = (d.isElevated ? d.isElevated().catch(function () { return false; }) : Promise.resolve(false));
        return elevQ.then(function (isElev) {
            if (isElev) {
                log2('提权运行：跳过 getDisplayMedia，直走 GDI 抓屏');
                return startGdiStream();
            }
            var gp;
            try {
                gp = navigator.mediaDevices.getDisplayMedia({
                    video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } },
                    audio: false
                });
            } catch (e) {
                gp = Promise.reject(e);
            }
            return gp.then(function (stream) {
                log2('getDisplayMedia 抓屏成功');
                return stream;
            }, function (err) {
                var why = (err && (err.name || err.message)) || 'unknown';
                log2('getDisplayMedia 失败（' + why + '），回退 GDI 抓屏');
                return startGdiStream();
            });
        }).catch(function (err) {
            var e = err || new Error(I18N.t('抓屏失败'));
            try { e.__capture = true; } catch (x) { }
            throw e;
        });
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
        dc.onopen = function () { log(I18N.t('DataChannel 就绪')); };
        st.dc = dc;
        pc.onicecandidate = function (e) {
            if (!e.candidate) return;
            sendFn({
                action: 'candidate', session_id: st.sessionId,
                candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
            });
        };
        pc.onconnectionstatechange = function () {
            log2('连接状态：' + pc.connectionState);
            // 连接失败/对端关闭：收口（信令面由 chat.js disconnect 流程归口，此处仅媒体面自保）
            if (st.active && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
                stop('media');
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
        if (st.active) { log(I18N.t('已在共享中，忽略重复启动')); return; }
        if (!sendFn) { log(I18N.t('信令通道未注入，无法启动')); return; }
        st.sessionId = task.session_id;
        st.grant = task.grant === 'control' ? 'control' : 'view';
        st.ice = Array.isArray(task.ice) && task.ice.length ? task.ice : null; // 远程控制跨 NAT 中继配置
        st.rcMode = !!task.rc; // 阶段二百六十一：仅 rc 场景启用 answer 超时兜底（旧协助零改动）
        st.active = true;
        log2('被控端启动共享', 'session=' + st.sessionId, 'rc=' + st.rcMode);
        // 阶段三百零四：抓屏归口 acquireScreen——提权/抓屏失败自动 GDI 帧兜底（原 getDisplayMedia 单通道，
        // 提权客户端必然抓屏失败 → 悬浮条一闪即收 → 控制端"对方已断开协助"）
        acquireScreen().then(function (stream) {
            if (!st.active) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            st.stream = stream;
            var vt = stream.getVideoTracks()[0];
            if (!vt) {
                log2('抓屏未返回视频轨');
                stop('capture');
                return;
            }
            // 用户点浏览器式"停止共享"条：等价主动断开（信令面 chat.js 收 disconnect 后收口）
            vt.onended = function () { stop('user'); };
            var pc = buildPC();
            return pc.createOffer().then(function (off) {
                return pc.setLocalDescription(off).then(function () {
                    sendFn({ action: 'offer', session_id: st.sessionId, sdp: { type: off.type, sdp: off.sdp } });
                    log2('offer 已发送');
                    // 阶段二百六十一：answer 迟到兜底（仅 rc 场景）——控制端 rc_connect 20s 超时收口后
                    // 会话即悬挂，被控端悬浮条/抓屏不能无限等待：offer 后 30s 未收到 answer 自动收口
                    // （stop → onStop 发 disconnect 归口服务端结束会话，防隐私悬挂）；旧协助 rcMode=false 不启用
                    if (st.rcMode) {
                        if (st.answerTimer) clearTimeout(st.answerTimer);
                        st.answerTimer = setTimeout(function () {
                            st.answerTimer = null;
                            if (st.active && (!st.pc || !st.pc.remoteDescription)) {
                                log2('等待 answer 超时（控制端可能已超时收口），自动结束');
                                stop('timeout');
                            }
                        }, 30000);
                    }
                });
            });
        }).catch(function (err) {
            var detail = (err && (err.name || err.message)) || String(err);
            var tag = (err && err.__capture) ? 'capture' : 'media';
            log2('被控端起流失败（' + tag + '）：' + detail);
            stop(tag + ':' + detail); // 收口原因透传 chat.js（本地提示 + 控制端提示）
        });
    }

    // 信令喂入（chat.js 下行 offer/answer/candidate 时调用）
    function handleSignal(p) {
        if (!st.active) return;
        if (p.action === 'answer') {
            if (!st.pc) return;
            if (st.answerTimer) { clearTimeout(st.answerTimer); st.answerTimer = null; } // 阶段二百六十一：answer 到达解除超时兜底
            st.pc.setRemoteDescription(new RTCSessionDescription(p.sdp)).then(function () {
                log2('answer 已应用');
                flushCands();
            }).catch(function (e) { log2('answer 失败：' + ((e && (e.name || e.message)) || e)); });
        } else if (p.action === 'candidate') {
            if (!st.pc || !st.pc.remoteDescription) { st.pendingCands.push(p.candidate); return; }
            try { st.pc.addIceCandidate(new RTCIceCandidate(p.candidate)); } catch (e) { }
        }
    }

    // 停止共享（收口归口：停轨/关 pc/清状态；悬浮条与信令收口由 chat.js remoteEndLocal 归口）
    // wasActive 守卫：仅 active→stop 跳变时回调一次（remoteEndLocal 内二次 stop 不再触发，防递归）
    // 阶段三百零四：reason 透传收口原因（capture=抓屏失败 / timeout=等 answer 超时 / media=媒体断连），
    // 供 chat.js 本地提示被控端用户、并随 disconnect 告知控制端（原静默收口，两端都无从判断）
    function stop(reason) {
        var wasActive = st.active;
        st.active = false;
        stopGdi(); // GDI 帧通道先行停止（主进程推帧循环 + 帧回调置空）
        if (st.dc) { try { st.dc.close(); } catch (e) { } st.dc = null; }
        if (st.pc) { try { st.pc.close(); } catch (e) { } st.pc = null; }
        if (st.stream) { st.stream.getTracks().forEach(function (t) { t.stop(); }); st.stream = null; }
        st.pendingCands = [];
        st.sessionId = '';
        st.grant = '';
        st.ice = null;
        st.rcMode = false;
        if (st.answerTimer) { clearTimeout(st.answerTimer); st.answerTimer = null; }
        log2('共享已停止' + (reason ? '（' + reason + '）' : ''));
        if (wasActive && stopCb) { try { stopCb(reason ? String(reason) : ''); } catch (e) { } }
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
