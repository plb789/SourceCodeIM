// gn-net.js - 阶段二百九十二 M4：局域网游戏跨公网联机·渲染进程引擎（信令面 + DataChannel 数据面）
// 设计文档：docs/局域网公网联机开发文档.md（§5 信令 / §6 数据面 / 16 部署）
//
// 职责划分：
//   1. 信令面：110 帧 probe/accept/offer/answer/candidate/relay/ping/abort 收发（socket.js 分流入口 onSignal）
//   2. 数据面：一条 RTCPeerConnection 开三条 DataChannel（ctl 控制保活 / udp 不可靠无序 / tcp 可靠有序），
//      与主进程本地端口隧道（game-tunnel.js，仅 PC 端）经受控 IPC 桥对接 —— 字节流不经服务端
//   3. 拓扑：一期星型（房主 hub）——房主与每个加入者各一条连接；房主端隧道每对端一套
//   4. 兜底：协商超时（服务端下发 negotiate_timeout）、看门狗（0 信令判死）、通道断开、隧道收口
//
// 数据面口径（§6.1）：
//   UDP → ordered=false + maxRetransmits=0（语义等价 UDP，过载即丢包）
//   TCP → ordered 可靠有序 + 4 字节流标识前缀多路复用（流开/关走 JSON 控制帧）
//   控制/保活 → 独立 ctl 通道（与数据通道互不阻塞）
//
// 对外接口（UI 由 M5 接入；本引擎不碰 DOM）：
//   GameNet.available()                    本端是否具备隧道能力（仅 PC 端 Electron + 引擎可用）
//   GameNet.config(cfg)                     服务端归口参数注入（socket.js 登录响应解析后调用）
//   GameNet.hostStart(roomId, hostPort, o)  房主登记（o={host_ip?}；隧道按对端惰性开启）
//   GameNet.hostStop(roomId)                房主收口（房间关闭/退出时调用）
//   GameNet.connect(roomId, hostUser, hp,o) 加入者发起 → Promise<{ok:true}|{ok:false, reason}>
//   GameNet.disconnect(roomId)              加入者断开（撤销隧道 + abort 信令）
//   GameNet.onSignal(msg)                   110 帧入口（socket.js dispatch 分发）
//   GameNet.onEvent = function(ev){}        UI 事件（probe/accepted/ready/listen/relay/abort/error/data）
//   GameNet.stateOf(roomId) / activeCount() UI 查询（联机态与资源自检）
(function () {
    'use strict';

    // 决策参数（服务端归口，登录响应 game_net_* 注入覆盖；兜底默认值与服务端 config.yaml 一致）
    var cfg = {
        enabled: true,          // 服务端总开关
        mode: 'both',           // lane=原生 SDK / tunnel=通用端口隧道（一期主线）/ both
        negotiateTimeout: 10,   // 协商超时秒（probe 起到 ctl 通道打通）
        relayOnly: false,       // 强制中继（企业网/调试；只用 relay 候选）
        maxMembers: 6,
        pingEvery: 15000,       // 联机保活间隔（服务端 30s idle 阈值，2 次容错，同 file_p2p 惯例）
        watchdog: 40000,        // 双向零信令判死（服务端 30s 先收口，本端兜底稍宽）
        preopenQueue: 512       // 通道未就绪时本地数据排队上限（超限丢最旧，UDP 语义）
    };

    var CTL_LABEL = 'gn-ctl';
    var UDP_LABEL = 'gn-udp';
    var TCP_LABEL = 'gn-tcp';
    var HIGH_WATER = 4 * 1024 * 1024;  // 发送缓冲高水位（超限排队；不可靠通道超限即丢包）
    var LOW_WATER = 512 * 1024;

    var sessions = {};      // conn_id → 会话（房主/加入者同表，conn_id 全局唯一）
    var joinByRoom = {};    // room_id → conn_id（加入者：一房间一条连接）
    var hostRooms = {};     // room_id → {hostPort, hostIp, peers:{peer → conn_id}}（房主：星型扇出）

    // ----- 环境能力 -----
    function tunnelCapable() {
        return !!(window.desktop && typeof window.desktop.gnTunnelOpen === 'function' &&
            typeof window.desktop.gnTunnelClose === 'function' && !window.__webCallBridge);
    }
    function available() {
        return !!(cfg.enabled && tunnelCapable() && typeof RTCPeerConnection !== 'undefined' && cfg.mode !== 'lane');
    }
    function genId() { return 'g' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
    function now() { return Date.now(); }
    function normPort(p) {
        p = parseInt(p, 10);
        if (!isFinite(p) || p < 1024 || p > 65535) return 0;
        return p;
    }
    function toU8(x) {
        if (x == null) return null;
        if (x instanceof Uint8Array) return x;
        // 跨 IPC / 跨窗口到达的字节视图：按内部槽识别（不受来源 realm 影响）
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength || 0);
        if (Object.prototype.toString.call(x) === '[object ArrayBuffer]') return new Uint8Array(x);
        if (Array.isArray(x)) return new Uint8Array(x);
        return null;
    }
    function emit(ev) {
        if (typeof window.GameNet.onEvent === 'function') {
            try { window.GameNet.onEvent(ev); } catch (e) { /* UI 回调异常不影响联机 */ }
        }
    }

    // ----- 信令（msg_type=110；from_user 由服务端以连接登录名归口，客户端不伪造）-----
    // 阶段二百九十二 M8：引擎迁入游戏中心窗（无 WS 独立窗），收发统一走 GNSignal 中继口
    // （gn-signal.js：游戏中心窗经 IPC 复用主窗口唯一 WS；主窗口环境自动回落 IMSocket 直发）
    function sig(to, payload) {
        if (!window.GNSignal || !GNSignal.isConnected()) return false;
        return GNSignal.send({ msg_type: 110, to_user: to, content: JSON.stringify(payload) });
    }
    // ICE 配置：服务端经信令注入 ice 键（TURN 启用时下发，复用通话链路 callInjectICE 口径；
    // relay_only 时附加 iceTransportPolicy=relay 强制走中继）
    function pcConfOf(sess) {
        var conf = {};
        if (sess && sess.conf && Array.isArray(sess.conf.iceServers) && sess.conf.iceServers.length) {
            conf.iceServers = sess.conf.iceServers;
        }
        if (cfg.relayOnly) conf.iceTransportPolicy = 'relay';
        return conf;
    }
    function iceConfOf(p) {
        if (p && Array.isArray(p.ice) && p.ice.length) return { iceServers: p.ice };
        return null;
    }
    function labelProto(label) {
        if (label === UDP_LABEL) return 'udp';
        if (label === TCP_LABEL) return 'tcp';
        return 'ctl';
    }

    // ----- 数据面：DataChannel 发送器（背压归口；不可靠通道过载丢包，可靠通道排队不丢）-----
    function makeSender(proto, dc) {
        var unreliable = (proto === 'udp');
        var q = [], qBytes = 0;
        try { dc.bufferedAmountLowThreshold = LOW_WATER; } catch (e) { }
        function drain() {
            while (q.length && dc.readyState === 'open' && dc.bufferedAmount < HIGH_WATER) {
                var b = q[0];
                try { dc.send(b); } catch (e) { return; }
                q.shift(); qBytes -= b.length;
            }
        }
        dc.onbufferedamountlow = function () { drain(); };
        return function (u8) {
            if (!u8 || dc.readyState !== 'open') return false;
            if (!q.length && dc.bufferedAmount < HIGH_WATER) {
                try { dc.send(u8); return true; } catch (e) { return false; }
            }
            if (unreliable && qBytes + u8.length > HIGH_WATER) return false; // UDP 语义：过载即丢
            q.push(u8); qBytes += u8.length; drain();
            return true;
        };
    }

    // ----- 会话生命周期 -----
    function newSess(o) {
        return {
            id: o.id, role: o.role, room: o.room, peer: o.peer,
            hostPort: o.hostPort || 0, hostIp: o.hostIp || '',
            state: o.state || 'probing', lastAct: now(), dead: false,
            conf: null, pc: null, remoteSet: false, candQueue: [],
            chans: {}, senders: {}, opened: {}, queue: {},
            tunnelReady: false, tunnelPending: false,
            rx: 0, tx: 0, resolve: o.resolve || null,
            timers: { negotiate: null, watch: null, ping: null }
        };
    }

    function clearTimers(sess) {
        if (!sess.timers) return;
        if (sess.timers.negotiate) { clearTimeout(sess.timers.negotiate); sess.timers.negotiate = null; }
        if (sess.timers.watch) { clearInterval(sess.timers.watch); sess.timers.watch = null; }
        if (sess.timers.ping) { clearInterval(sess.timers.ping); sess.timers.ping = null; }
    }

    function startTimers(sess) {
        if (!sess.timers.watch) {
            sess.timers.watch = setInterval(function () {
                if (sess.state === 'failed' || sess.state === 'aborted' || sess.dead) return;
                if (now() - sess.lastAct > cfg.watchdog) fail(sess, 'watchdog');
            }, 5000);
        }
        if (!sess.timers.ping) {
            sess.timers.ping = setInterval(function () {
                if (sess.state === 'probing' || sess.state === 'accepted' || sess.state === 'linked') {
                    sig(sess.peer, { action: 'ping', conn_id: sess.id }); // 刷新服务端会话活跃 + 续期房间 TTL
                }
            }, cfg.pingEvery);
        }
    }

    function teardown(sess, closeTunnel) {
        if (!sess || sess.dead) return;
        sess.dead = true;
        if (sess.state !== 'failed') sess.state = 'aborted';
        clearTimers(sess);
        if (sess.pc) { try { sess.pc.close(); } catch (e) { } sess.pc = null; }
        sess.chans = {}; sess.senders = {}; sess.opened = {}; sess.queue = {};
        if (joinByRoom[sess.room] === sess.id) delete joinByRoom[sess.room];
        delete sessions[sess.id];
        var room = hostRooms[sess.room];
        if (room && room.peers[sess.peer] === sess.id) delete room.peers[sess.peer];
        sess.tunnelReady = false;
        // 先摘除会话再关隧道：主进程回吐的 'closed' 事件因查不到会话而被忽略（防自杀式 abort 回声）
        if (closeTunnel !== false && window.desktop && window.desktop.gnTunnelClose) {
            try { window.desktop.gnTunnelClose({ room_id: sess.room, peer: sess.peer, role: sess.role, quiet: true }); } catch (e) { }
        }
    }

    function fail(sess, reason) {
        if (!sess || sess.state === 'failed' || sess.state === 'aborted' || sess.dead) return;
        sess.state = 'failed';
        sig(sess.peer, { action: 'abort', conn_id: sess.id, reason: reason });
        var r = sess.resolve; sess.resolve = null;
        var info = { type: 'abort', room_id: sess.room, peer: sess.peer, conn_id: sess.id, reason: reason };
        teardown(sess, true);
        if (r) r({ ok: false, reason: reason });
        emit(info);
    }
    function touch(sess) { if (sess) sess.lastAct = now(); }

    // ----- 通道装配 -----
    function attachChannel(sess, dc, proto) {
        dc.binaryType = 'arraybuffer';
        sess.chans[proto] = dc;
        sess.senders[proto] = makeSender(proto, dc);
        dc.onopen = function () { onChanOpen(sess, proto); };
        dc.onclose = function () { onChanDown(sess, proto); };
        dc.onerror = function () { onChanDown(sess, proto); };
        if (proto === 'udp') {
            dc.onmessage = function (e) { onUdpIn(sess, e.data); };
        } else if (proto === 'tcp') {
            dc.onmessage = function (e) { onTcpIn(sess, e.data); };
        } else {
            dc.onmessage = function () { touch(sess); }; // ctl 保活帧：仅刷新活跃
        }
    }

    function onChanOpen(sess, proto) {
        if (sess.dead) return;
        sess.opened[proto] = true;
        touch(sess);
        if (proto !== 'ctl') { flushQueue(sess); return; }
        // ctl 打通 = 端到端链路就绪：撤销协商超时、开隧道、放行排队数据
        if (sess.timers.negotiate) { clearTimeout(sess.timers.negotiate); sess.timers.negotiate = null; }
        sess.state = 'linked';
        if (sess.role === 'host') ensureHostTunnel(sess);
        var r = sess.resolve; sess.resolve = null;
        emit({ type: 'ready', room_id: sess.room, peer: sess.peer, conn_id: sess.id, role: sess.role });
        if (r) r({ ok: true, room_id: sess.room, peer: sess.peer });
    }

    function onChanDown(sess, proto) {
        if (sess.dead) return;
        if (sess.state === 'linked' || sess.state === 'accepted' || sess.state === 'probing') {
            if (proto === 'ctl') fail(sess, 'channel_lost');
        }
    }

    // ----- 本地（本机游戏）→ 对端 -----
    function sessionOf(roomId, peer) {
        var jid = joinByRoom[roomId];
        if (jid && sessions[jid] && sessions[jid].peer === peer) return sessions[jid];
        var room = hostRooms[roomId];
        if (room && room.peers[peer]) {
            var s = sessions[room.peers[peer]];
            if (s) return s;
        }
        return null;
    }

    function queueLocal(sess, proto, e) {
        var q = sess.queue[proto] || (sess.queue[proto] = []);
        if (q.length >= cfg.preopenQueue) {
            if (proto === 'udp') q.shift();            // 不可靠通道：丢最旧（UDP 语义）
            else return;                               // 可靠通道：极端堆积时丢新帧（仅通道未就绪的短暂窗口）
        }
        q.push(e);
    }

    function wireFrame(proto, kind, sid, buf) {
        if (proto === 'udp') return buf ? toU8(buf) : null;
        if (kind === 'data') {
            var b = toU8(buf); if (!b) return null;
            var w = new Uint8Array(4 + b.length);
            w[0] = (sid >>> 24) & 0xff; w[1] = (sid >>> 16) & 0xff; w[2] = (sid >>> 8) & 0xff; w[3] = sid & 0xff;
            w.set(b, 4);
            return w;
        }
        if (kind === 'open') return JSON.stringify({ t: 'open', sid: sid });
        if (kind === 'close') return JSON.stringify({ t: 'close', sid: sid });
        return null;
    }

    function pushLocal(sess, proto, kind, sid, buf) {
        var sender = sess.senders[proto];
        if (!sender || !sess.opened[proto]) { queueLocal(sess, proto, { kind: kind, sid: sid, buf: buf }); return; }
        var w = wireFrame(proto, kind, sid, buf);
        if (w == null) return;
        if (sender(w)) sess.tx += (w.length || 0);
    }

    function flushQueue(sess) {
        for (var proto in sess.queue) {
            var q = sess.queue[proto];
            if (!sess.opened[proto] || !sess.senders[proto]) continue;
            sess.queue[proto] = [];
            for (var i = 0; i < q.length; i++) {
                var w = wireFrame(proto, q[i].kind, q[i].sid, q[i].buf);
                if (w == null) continue;
                sess.senders[proto](w);
                sess.tx += (w.length || 0);
            }
        }
    }

    // ----- 对端 → 本地（主进程套接字）-----
    function deliver(sess, proto, sid, kind, buf) {
        if (!window.desktop || !window.desktop.gnTunnelDeliver) return;
        try {
            window.desktop.gnTunnelDeliver({ room_id: sess.room, peer: sess.peer, proto: proto, sid: sid, kind: kind, buf: buf || null });
        } catch (e) { }
    }

    function onUdpIn(sess, data) {
        var b = toU8(data);
        if (!b) return;
        touch(sess);
        sess.rx += b.length;
        deliver(sess, 'udp', 0, 'data', b);
    }

    function onTcpIn(sess, data) {
        touch(sess);
        if (typeof data === 'string') {
            var m = null;
            try { m = JSON.parse(data); } catch (e) { return; }
            if (!m || typeof m.sid !== 'number') return;
            if (m.t === 'open') deliver(sess, 'tcp', m.sid, 'open', null);
            else if (m.t === 'close') deliver(sess, 'tcp', m.sid, 'close', null);
            return;
        }
        var u8 = toU8(data);
        if (!u8 || u8.length < 4) return;
        sess.rx += u8.length;
        var sid = ((u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3]) >>> 0;
        deliver(sess, 'tcp', sid, 'data', u8.slice(4));
    }

    // IPC：本机套接字 → 渲染进程（data：游戏字节；event：流开/关/监听/收口）
    function onLocalData(f) {
        var sess = sessionOf(f.room_id, f.peer);
        if (!sess) return;
        touch(sess);
        pushLocal(sess, f.proto, 'data', f.sid || 0, f.buf);
    }

    function onTunnelEvent(f) {
        var sess = sessionOf(f.room_id, f.peer);
        if (!sess) return;
        touch(sess);
        if (f.kind === 'listen') {
            emit({ type: 'listen', room_id: f.room_id, peer: f.peer, proto: f.proto, role: sess.role });
            return;
        }
        if (f.kind === 'open') { pushLocal(sess, 'tcp', 'open', f.sid, null); return; }
        if (f.kind === 'close') { pushLocal(sess, 'tcp', 'close', f.sid, null); return; }
        if (f.kind === 'error') {
            emit({ type: 'error', room_id: f.room_id, peer: f.peer, proto: f.proto, reason: f.reason || '' });
            return;
        }
        if (f.kind === 'closed' || f.kind === 'idle') {
            sess.tunnelReady = false;
            if (sess.state === 'linked' || sess.state === 'accepted') {
                fail(sess, f.kind === 'idle' ? 'tunnel_idle' : 'tunnel_closed');
            }
        }
    }

    if (window.desktop && typeof window.desktop.onGnTunnelData === 'function') {
        window.desktop.onGnTunnelData(onLocalData);
        window.desktop.onGnTunnelEvent(onTunnelEvent);
    }

    // ----- 隧道开启 -----
    function openTunnel(sess, role, port, hostIp) {
        if (!window.desktop || !window.desktop.gnTunnelOpen) return Promise.resolve({ ok: false, err: 'unsupported' });
        var base = { room_id: sess.room, peer: sess.peer, role: role, port: port };
        if (hostIp) base.host_ip = hostIp;
        var p1 = { room_id: base.room_id, peer: base.peer, proto: 'udp', role: role, port: port };
        var p2 = { room_id: base.room_id, peer: base.peer, proto: 'tcp', role: role, port: port };
        if (hostIp) { p1.host_ip = hostIp; p2.host_ip = hostIp; }
        return Promise.all([window.desktop.gnTunnelOpen(p1), window.desktop.gnTunnelOpen(p2)]).then(function (rs) {
            var e1 = rs[0] && rs[0].ok ? '' : ((rs[0] && rs[0].err) || 'udp');
            var e2 = rs[1] && rs[1].ok ? '' : ((rs[1] && rs[1].err) || 'tcp');
            if (e1 || e2) return { ok: false, err: (e1 ? 'udp:' + e1 : '') + (e2 ? ' tcp:' + e2 : '') };
            return { ok: true, port: port };
        }, function (e) { return { ok: false, err: (e && e.message) || 'ipc_fail' }; });
    }

    // 房主端隧道：按对端惰性开启（星型：每个加入者一套，ctl 通道打通后开）
    function ensureHostTunnel(sess) {
        if (sess.role !== 'host' || sess.tunnelReady || sess.tunnelPending || sess.dead) return;
        sess.tunnelPending = true;
        openTunnel(sess, 'host', sess.hostPort, sess.hostIp).then(function (r) {
            sess.tunnelPending = false;
            if (sess.dead) return;
            if (!r.ok) {
                emit({ type: 'error', room_id: sess.room, peer: sess.peer, reason: 'host_tunnel:' + r.err });
                fail(sess, 'host_tunnel_fail');
                return;
            }
            sess.tunnelReady = true;
            flushQueue(sess);
        });
    }

    // ----- 加入者入口 -----
    function connect(roomId, hostUser, hostPort, opts) {
        return new Promise(function (resolve) {
            if (!available()) { resolve({ ok: false, reason: 'unsupported' }); return; }
            if (!window.IMSocket || !IMSocket.isConnected()) { resolve({ ok: false, reason: 'offline' }); return; }
            var port = normPort(hostPort);
            if (!port) { resolve({ ok: false, reason: 'bad_port' }); return; }
            if (!hostUser) { resolve({ ok: false, reason: 'forbidden' }); return; }
            if (joinByRoom[roomId]) disconnect(roomId); // 幂等重建
            var id = genId();
            var sess = newSess({ id: id, role: 'join', room: roomId, peer: hostUser, hostPort: port, state: 'probing', resolve: resolve });
            sessions[id] = sess;
            joinByRoom[roomId] = id;
            startTimers(sess);
            // 协商超时兜底（服务端下发 negotiate_timeout；probe_fail 由信令即时回退，不产生等待）
            sess.timers.negotiate = setTimeout(function () {
                if (sess.state === 'probing' || sess.state === 'accepted') fail(sess, 'timeout');
            }, Math.max(3, cfg.negotiateTimeout) * 1000);
            // 先开本地监听再 probe：端口被占（游戏端口冲突）立即收口，不白等房主 accept
            openTunnel(sess, 'join', port, (opts && opts.host_ip) || '').then(function (r) {
                if (sess.dead) return;
                if (!r.ok) { fail(sess, 'local_tunnel:' + r.err); return; }
                sess.tunnelReady = true;
                sig(hostUser, { action: 'probe', conn_id: id, room_id: roomId });
            });
        });
    }

    // ----- 房主入口 -----
    function hostStart(roomId, hostPort, opts) {
        if (!available()) return { ok: false, reason: 'unsupported' };
        var port = normPort(hostPort);
        if (!port) return { ok: false, reason: 'bad_port' };
        var room = hostRooms[roomId];
        if (!room) room = hostRooms[roomId] = { roomId: roomId, peers: {}, hostPort: port, hostIp: '' };
        room.hostPort = port;
        room.hostIp = (opts && opts.host_ip) || '';
        return { ok: true, room_id: roomId, host_port: port };
    }

    function hostStop(roomId) {
        var room = hostRooms[roomId];
        if (!room) return { ok: true, stopped: 0 };
        var n = 0;
        for (var peer in room.peers) {
            var s = sessions[room.peers[peer]];
            if (s) { teardown(s, true); n++; }
        }
        delete hostRooms[roomId];
        return { ok: true, stopped: n };
    }

    function disconnect(roomId) {
        var jid = joinByRoom[roomId];
        if (!jid) return { ok: true };
        var sess = sessions[jid];
        if (!sess) { delete joinByRoom[roomId]; return { ok: true }; }
        if (sess.state === 'probing' || sess.state === 'accepted' || sess.state === 'linked') {
            sig(sess.peer, { action: 'abort', conn_id: sess.id, reason: 'left' });
        }
        var info = { type: 'abort', room_id: sess.room, peer: sess.peer, conn_id: sess.id, reason: 'left' };
        teardown(sess, true);
        emit(info);
        return { ok: true };
    }

    function disconnectAll() {
        var ids = [];
        for (var k in sessions) ids.push(k);
        for (var i = 0; i < ids.length; i++) {
            var s = sessions[ids[i]];
            if (!s) continue;
            if (s.role === 'join' && s.state !== 'failed' && s.state !== 'aborted') {
                sig(s.peer, { action: 'abort', conn_id: s.id, reason: 'left' });
            }
            teardown(s, true);
        }
        for (var r in hostRooms) delete hostRooms[r];
        return { ok: true };
    }

    // ----- 建连（加入者为 offerer / 房主为 answerer，同 file_p2p 口径）-----
    function basePC(sess) {
        var pc;
        try { pc = new RTCPeerConnection(pcConfOf(sess)); } catch (e) { fail(sess, 'pc_error'); return null; }
        sess.pc = pc;
        pc.onicecandidate = function (e) {
            if (e.candidate) sig(sess.peer, { action: 'candidate', conn_id: sess.id, candidate: e.candidate.toJSON() });
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                if (sess.state === 'accepted' || sess.state === 'linked') fail(sess, 'channel_lost');
            }
        };
        return pc;
    }

    function buildOfferer(sess) {
        var pc = basePC(sess);
        if (!pc) return;
        attachChannel(sess, pc.createDataChannel(CTL_LABEL, { ordered: true }), 'ctl');
        attachChannel(sess, pc.createDataChannel(UDP_LABEL, { ordered: false, maxRetransmits: 0 }), 'udp');
        attachChannel(sess, pc.createDataChannel(TCP_LABEL, { ordered: true }), 'tcp');
        pc.createOffer().then(function (offer) {
            return pc.setLocalDescription(offer);
        }).then(function () {
            sig(sess.peer, { action: 'offer', conn_id: sess.id, sdp: pc.localDescription.sdp });
        }).catch(function () { fail(sess, 'pc_error'); });
    }

    function flushCands(sess) {
        if (!sess.candQueue || !sess.candQueue.length) return;
        var q = sess.candQueue; sess.candQueue = [];
        for (var i = 0; i < q.length; i++) {
            try { sess.pc.addIceCandidate(q[i]).catch(function () { }); } catch (e) { }
        }
    }

    // ----- 信令入口（socket.js dispatch 分发全部 110 帧）-----
    function onSignal(msg) {
        var p = {};
        try { p = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!p.action || !p.conn_id) return;
        var sess = sessions[p.conn_id];

        switch (p.action) {
            case 'probe': {
                // 房主端：只认本端已登记的房主房间（服务端已校验发起端为 PC/成员/房主在线；
                // 本端未登记（如 WEB 端/未开房）→ 静默忽略，由发起方协商超时收口）
                var room = hostRooms[p.room_id];
                if (!room || !available()) return;
                var peer = msg.from_user;
                if (!peer) return;
                var oldId = room.peers[peer];
                if (oldId) {
                    // 重复 probe（同 conn_id）去重：重发 accept 会被服务端判 already_accepted 反杀本端
                    if (oldId === p.conn_id) return;
                    var old = sessions[oldId];
                    if (old) teardown(old, true); // 同对端新 conn_id（上次失败重试）→ 先收口旧连接
                }
                var hs = newSess({ id: p.conn_id, role: 'host', room: p.room_id, peer: peer, hostPort: room.hostPort, hostIp: room.hostIp, state: 'accepted' });
                sessions[hs.id] = hs;
                room.peers[peer] = hs.id;
                startTimers(hs);
                // 自动 accept（先到先得由服务端归口唯一赢家；多端在线全部 accept，落败端收 already_accepted）
                sig(peer, { action: 'accept', conn_id: hs.id, platform: 'pc' });
                emit({ type: 'probe', room_id: hs.room, peer: peer, conn_id: hs.id, role: 'host' });
                break;
            }
            case 'accept': {
                // 加入者：房主已 accept → 建连（conf 取 accept 帧注入的 ice）
                if (!sess || sess.role !== 'join' || sess.state !== 'probing') return;
                if (msg.from_user && msg.from_user !== sess.peer) return;
                sess.conf = iceConfOf(p);
                sess.state = 'accepted';
                touch(sess);
                emit({ type: 'accepted', room_id: sess.room, peer: sess.peer, conn_id: sess.id, platform: p.platform || '' });
                buildOfferer(sess);
                break;
            }
            case 'offer': {
                // 房主端：应答建连（conf 取 offer 帧注入的 ice）
                if (!sess || sess.role !== 'host' || sess.pc) return;
                if (msg.from_user && msg.from_user !== sess.peer) return;
                sess.conf = iceConfOf(p);
                var pc = basePC(sess);
                if (!pc) return;
                pc.ondatachannel = function (ev) { attachChannel(sess, ev.channel, labelProto(ev.channel.label)); };
                pc.setRemoteDescription({ type: 'offer', sdp: p.sdp }).then(function () {
                    sess.remoteSet = true;
                    return pc.createAnswer();
                }).then(function (ans) {
                    return pc.setLocalDescription(ans);
                }).then(function () {
                    sig(sess.peer, { action: 'answer', conn_id: sess.id, sdp: pc.localDescription.sdp });
                    flushCands(sess);
                }).catch(function () { fail(sess, 'pc_error'); });
                break;
            }
            case 'answer': {
                // 加入者：远端应答就绪
                if (!sess || sess.role !== 'join' || !sess.pc || sess.remoteSet) return;
                if (msg.from_user && msg.from_user !== sess.peer) return;
                sess.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).then(function () {
                    sess.remoteSet = true;
                    flushCands(sess);
                }).catch(function () { fail(sess, 'pc_error'); });
                break;
            }
            case 'candidate': {
                if (!sess || !sess.pc) return;
                if (msg.from_user && msg.from_user !== sess.peer) return;
                if (!p.candidate || !p.candidate.candidate) return; // 端尾候选忽略
                if (!sess.remoteSet) sess.candQueue.push(p.candidate); // 远端描述未就绪先排队
                else sess.pc.addIceCandidate(p.candidate).catch(function () { });
                touch(sess);
                break;
            }
            case 'relay': {
                // 「已降级走中继」通知帧：仅 UI 提示（链路本身由 ICE 自动降级，无需客户端动作）
                if (!sess) return;
                touch(sess);
                emit({ type: 'relay', room_id: sess.room, peer: sess.peer, conn_id: sess.id, role: sess.role });
                break;
            }
            case 'ping': {
                if (sess) touch(sess); // 保活帧：刷新本端看门狗
                break;
            }
            case 'abort': {
                // 对端/服务端中止（reason: timeout/already_accepted/kicked/left/host_left/room_closed...）
                if (!sess) return;
                var rr = sess.resolve; sess.resolve = null;
                var inf = { type: 'abort', room_id: sess.room, peer: sess.peer, conn_id: sess.id, reason: p.reason || 'peer_abort' };
                if (sess.state !== 'failed') sess.state = 'failed';
                teardown(sess, true);
                if (rr) rr({ ok: false, reason: p.reason || 'peer_abort' });
                emit(inf);
                break;
            }
            case 'probe_fail': {
                // 服务端归口拒绝（unsupported/offline/forbidden/room_closed/busy）：立即回退，无等待
                if (!sess) return;
                fail(sess, p.reason || 'probe_fail');
                break;
            }
            default:
                break;
        }
    }

    // ----- 对外接口 -----
    window.GameNet = {
        available: available,
        tunnelCapable: tunnelCapable,
        config: function (c) {
            if (!c || typeof c !== 'object') return;
            if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
            if (typeof c.mode === 'string' && c.mode) cfg.mode = c.mode;
            if (c.negotiateTimeout > 0) cfg.negotiateTimeout = c.negotiateTimeout;
            if (typeof c.relayOnly === 'boolean') cfg.relayOnly = c.relayOnly;
            if (c.maxMembers > 0) cfg.maxMembers = c.maxMembers;
        },
        hostStart: hostStart,
        hostStop: hostStop,
        connect: connect,
        disconnect: disconnect,
        disconnectAll: disconnectAll,
        onSignal: onSignal,
        onEvent: null,               // UI 注入（M5）：function(ev)
        // UI 查询：房间联机态（无则 null）
        stateOf: function (roomId) {
            var jid = joinByRoom[roomId];
            if (jid && sessions[jid]) {
                var s = sessions[jid];
                return { role: 'join', state: s.state, room_id: s.room, peer: s.peer, host_port: s.hostPort, tunnel: s.tunnelReady, rx: s.rx, tx: s.tx };
            }
            var room = hostRooms[roomId];
            if (room) {
                var peers = [];
                for (var peer in room.peers) {
                    var hs = sessions[room.peers[peer]];
                    peers.push({ peer: peer, state: hs ? hs.state : 'gone', tunnel: hs ? hs.tunnelReady : false, rx: hs ? hs.rx : 0, tx: hs ? hs.tx : 0 });
                }
                return { role: 'host', state: peers.length ? 'linked' : 'waiting', room_id: roomId, host_port: room.hostPort, host_ip: room.hostIp, peers: peers };
            }
            return null;
        },
        // 房间人数上限（服务端归口值；房间层据此限制「混战」人数选项范围）
        maxMembers: function () { return cfg.maxMembers; },
        // 资源自检：当前存活会话数与隧道数（内存/句柄水位观察用）
        activeCount: function () {
            var n = 0;
            for (var k in sessions) if (sessions[k] && !sessions[k].dead) n++;
            return { sessions: n, joins: Object.keys(joinByRoom).length, hostRooms: Object.keys(hostRooms).length };
        }
    };

    // 阶段二百九十二 M8：服务端归口参数跨窗同步（引擎在游戏中心窗，登录响应在主窗口）
    // 主窗口 socket.js 登录响应处经 desktop.gnNetConfig 上报 → 主进程缓存 → 本窗口订阅 + 首开拉取
    if (window.desktop) {
        var applyCfg = function (c) { if (window.GameNet && window.GameNet.config) window.GameNet.config(c); };
        if (typeof window.desktop.onGnNetConfig === 'function') window.desktop.onGnNetConfig(function (c) { applyCfg(c); });
        if (typeof window.desktop.gnNetConfigGet === 'function') {
            try { window.desktop.gnNetConfigGet().then(function (c) { applyCfg(c); }); } catch (e) { /* 拉取失败用兜底默认 */ }
        }
    }
})();
