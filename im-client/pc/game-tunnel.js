// game-tunnel.js - 阶段二百九十二 M4：局域网游戏跨公网联机·PC 端本地端口隧道（Electron 主进程）
//
// 为什么必须在主进程：形态二「通用端口隧道」要在 OS 层持有 UDP/TCP 套接字；渲染进程（Chromium 沙箱）
// 拿不到裸 socket。因此主进程持套接字、渲染进程持 WebRTC DataChannel，两侧经受控 IPC 白名单方法对接
// （preload 只暴露 gnTunnelOpen/gnTunnelClose/gnTunnelDeliver + 两个事件订阅，渲染进程无法直接触达 socket）。
//
// 数据面（设计文档 §6.1 / §6.2）：
//   房主端 role=host：本机游戏进程在 <port> 监听 → 隧道从 <host_ip>:<port> 侧收发
//                    （DataChannel 来的字节投给游戏，游戏回包转回 DataChannel；星型拓扑下每个加入者一套）
//   加入者端 role=join：监听 0.0.0.0:<port>（与房主游戏端口同号，游戏看到的地址与"真的在局域网连房主"
//                    完全一致）→ 本机游戏发出的字节转发进 DataChannel，DataChannel 回包按来源地址投回游戏
//   通道（渲染进程侧建）：UDP → 不可靠无序 DataChannel（ordered=false + maxRetransmits=0，语义等价 UDP）
//                       TCP → 可靠有序 DataChannel（4 字节流标识前缀多路复用）
//                       控制/保活 → 独立 ctl 通道
//
// 安全归口：
//   1. 端口白名单：整型 1024~65535 且不在保留表内（3478 TURN/STUN、2087 客户端服务端口）；
//   2. 仅接受本机来源：join 监听端口若被局域网他人直连，字节会被塞进他人游戏的隧道 —— 一律丢弃；
//   3. 键名白名单：room_id / peer 仅允许无空白无分隔符的短串，防 IPC 键注入；
//   4. 渲染进程不持有 socket，仅能经白名单方法请求（无任意端口/任意目标能力）。
//
// 帧格式（与渲染进程 gn-net.js 对齐，均以 room_id + peer 归口；role/port 供 UI 提示与多窗口路由）：
//   主进程 → 渲染进程  'gn-tunnel:data'  {room_id, peer, proto, role, port, sid, kind:'data', buf}
//                      'gn-tunnel:event' {room_id, peer, proto, role, port, sid, kind, reason}
//                      kind: listen(本地监听就绪) / open / close / error / closed(隧道销毁) / idle
//   渲染进程 → 主进程  gn-tunnel-deliver   {room_id, peer, proto, sid, kind, buf}
//                      kind: data / open(host 侧按 sid 连本机游戏) / close(摘除该流)

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');

const MIN_PORT = 1024;
const MAX_PORT = 65535;
// 保留端口：3478（TURN/STUN）、2087（客户端本机服务端口），避免隧道抢占既有链路端口
const RESERVED_PORTS = { 3478: true, 2087: true };

const KEY_RE = /^[^\s|:]{1,64}$/;
const PROTOCOLS = { udp: true, tcp: true };
const ROLES = { host: true, join: true };

const FALLBACK_SPAN = 16;      // 端口顺延扫描跨度（原端口+1 起，如 6112 被占 → 6113~6128）
const PLAN_WAIT_MS = 3000;     // TCP 侧等待 UDP 侧端口裁决的兜底时长（两路 open 并发，正常毫秒级即裁决）

const LOCAL_CACHE_MS = 60000;   // 本机地址表缓存（网卡地址变动罕见，避免每次连接枚举）
const IDLE_SWEEP_MS = 30000;    // 空闲清扫周期
const IDLE_CLOSE_MS = 900000;   // 15 分钟双向零字节 → 收口（防孤儿隧道；正常联机由 110 ping 保活，此处仅兜底）

// ----- 本机地址归口（join 侧仅接受本机来源；host 侧 host_ip 必须是本机地址）-----
var localAddrsCache = null;
var localAddrsAt = 0;

function normalizeAddr(a) {
    a = String(a || '');
    if (!a) return '';
    if (a.indexOf('::ffff:') === 0) a = a.slice(7); // IPv4-mapped IPv6 → IPv4
    return a;
}

function localAddrs() {
    var t = Date.now();
    if (localAddrsCache && t - localAddrsAt < LOCAL_CACHE_MS) return localAddrsCache;
    var s = { '127.0.0.1': true, '0.0.0.0': true, '::1': true };
    var ifs = os.networkInterfaces();
    for (var k in ifs) {
        var arr = ifs[k] || [];
        for (var i = 0; i < arr.length; i++) {
            var a = normalizeAddr(arr[i] && arr[i].address);
            if (a) s[a] = true;
        }
    }
    localAddrsCache = s;
    localAddrsAt = t;
    return s;
}

function isLocalAddr(a) { return !!localAddrs()[normalizeAddr(a)]; }

// localPrimaryIP 本机首个非回环 IPv4（优先私网段）——host 侧发往本机游戏的包源地址归口。
// 透传反射（功能二期 L1 通用发现）要求：转发给本机真实游戏主机的搜索包，来源须为"局域网合法
// 地址"——部分游戏对来源 127.0.0.1 的 LAN 搜索应答异常（过滤回环来源），非回环本机 IP 全兼容。
function localPrimaryIP() {
    var ifs = os.networkInterfaces();
    var fallback = '';
    for (var k in ifs) {
        var arr = ifs[k] || [];
        for (var i = 0; i < arr.length; i++) {
            var a = normalizeAddr(arr[i] && arr[i].address);
            if (!a || a === '127.0.0.1' || a === '::1' || a.indexOf(':') !== -1) continue;
            if (arr[i].internal) continue;
            if (a.indexOf('169.254.') === 0) continue; // 链路本地不作为主机地址
            if (a.indexOf('192.168.') === 0 || a.indexOf('10.') === 0 || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) return a;
            if (!fallback) fallback = a;
        }
    }
    return fallback;
}

function validPort(p) {
    if (typeof p !== 'number' || !isFinite(p) || Math.floor(p) !== p) return false;
    return p >= MIN_PORT && p <= MAX_PORT && !RESERVED_PORTS[p];
}

// ----- join 数据端口方案归口 -----
// 同房间同对端的 UDP 数据口与 TCP 监听口必须同号（GameInfo 仅一个 GamePort 字段，游戏按它同时发起
// TCP 加入与 UDP 对战流量）；渲染层两路 open 并发到达（Promise.all），由 UDP 侧裁决：先试原端口，
// 被本机游戏先占则顺延扫描；TCP 侧等待裁决结果后按同端口监听。
// skip=true（war3 等独占端口游戏）：数据面从 reqPort+1 起扫，原端口永远留给本机游戏（war3 进局域网
// 页要独占绑定 6112，被占即报"不能连入网络"）；发现链路由广播代理直投注入承担，不依赖拦截
GameTunnel.prototype.joinPlan = function (roomId, peer, reqPort, skip) {
    var key = roomId + '|' + peer;
    var plan = this.joinPlans.get(key);
    if (plan) return plan;
    plan = { reqPort: reqPort, skip: !!skip, dataPort: 0, ready: false, waiters: [] };
    this.joinPlans.set(key, plan);
    plan.settle = function (port) {
        plan.dataPort = port | 0;
        if (plan.ready) return;
        plan.ready = true;
        var ws = plan.waiters;
        plan.waiters = [];
        for (var i = 0; i < ws.length; i++) { try { ws[i](plan.dataPort); } catch (e) { } }
    };
    plan.wait = function (fn) {
        if (plan.ready) { fn(plan.dataPort); return; }
        plan.waiters.push(fn);
        setTimeout(function () { plan.settle(plan.skip ? plan.reqPort + 1 : plan.reqPort); }, PLAN_WAIT_MS); // UDP 侧异常未裁决兜底
    };
    return plan;
};

// 房间加入侧隧道实际数据端口（顺延后 UDP/TCP 同号；0=无可用隧道——代理据此跳过 GamePort 补丁）
GameTunnel.prototype.dataPortOf = function (roomId) {
    var p = 0;
    this.tunnels.forEach(function (c) {
        if (!p && c.roomId === roomId && c.role === 'join' && (c.udp || c.tcpServer)) p = c.port;
    });
    return p;
};

// 备用端口顺序扫描（UDP/TCP 共用骨架）：逐个试独占绑定，成功即连同套接字交还（避免重绑竞态）；
// 全部失败回调 (0, null)。bindFn(p, cb) 由调用方按协议注入
function scanPort(from, span, bindFn, cb) {
    var p = from;
    var end = from + span;
    (function next() {
        if (p > end || p > MAX_PORT) { cb(0, null); return; }
        if (RESERVED_PORTS[p]) { p++; next(); return; }
        bindFn(p, function (ok, sk) {
            if (ok) { cb(p, sk); return; }
            p++;
            next();
        });
    })();
}

function scanUdp(from, span, cb) {
    scanPort(from, span, function (p, done) {
        var sk = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        var fired = false;
        sk.on('error', function () {
            if (fired) return;
            fired = true;
            try { sk.close(); } catch (e) { }
            done(false, null);
        });
        sk.bind(p, '0.0.0.0', function () {
            if (fired) { try { sk.close(); } catch (e) { } return; }
            fired = true;
            done(true, sk);
        });
    }, cb);
}

function scanTcp(from, span, cb) {
    scanPort(from, span, function (p, done) {
        var sk = net.createServer({ allowHalfOpen: false, pauseOnConnect: false });
        var fired = false;
        sk.on('error', function () {
            if (fired) return;
            fired = true;
            try { sk.close(); } catch (e) { }
            done(false, null);
        });
        sk.listen(p, '0.0.0.0', function () {
            if (fired) { try { sk.close(); } catch (e) { } return; }
            fired = true;
            done(true, sk);
        });
    }, cb);
}

function keyOf(roomId, peer, proto) { return roomId + '|' + peer + '|' + proto; }

function toBuf(b) {
    if (b == null) return null;
    if (Buffer.isBuffer(b)) return b;
    // 跨 IPC 到达的字节视图：ArrayBuffer.isView 与 toString 判定按内部槽识别（不受来源 realm 影响）
    if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset || 0, b.byteLength || 0);
    if (Object.prototype.toString.call(b) === '[object ArrayBuffer]') return Buffer.from(b);
    if (Array.isArray(b)) return Buffer.from(b);
    return null;
}

// ===== 隧道管理器 =====
function GameTunnel() {
    this.tunnels = new Map(); // key → ctx
    this.joinPlans = new Map(); // room|peer → {reqPort, dataPort, ready, waiters}（join 数据端口方案，UDP 侧裁决）
    this.emit = function () { };              // main.js 注入：主进程 → 渲染进程帧送出
    this.log = function (msg) { console.log('[game-tunnel] ' + msg); };
    this.sweepTimer = null;
    // 功能二期方案 B：广播发现代理钩子（game-broadcast.js 注入）——join 隧道收到本机游戏
    // SearchGame（0xF7 0x2F）时回调构造应答；返回 Buffer 数组即本地消费（不进隧道转发）
    this.broadcastHook = null;
}

GameTunnel.prototype.setEmitter = function (fn) { if (typeof fn === 'function') this.emit = fn; };
GameTunnel.prototype.setLogger = function (fn) { if (typeof fn === 'function') this.log = fn; };
GameTunnel.prototype.setBroadcastHook = function (fn) { if (typeof fn === 'function') this.broadcastHook = fn; };

// 打开（幂等：同 room+peer+proto 重复打开先收口旧隧道）
// args: {room_id, peer, proto:'udp'|'tcp', role:'host'|'join', port, host_ip?}
//   返回 Promise<{ok:true, port, host_ip} | {ok:false, err}>
GameTunnel.prototype.open = function (args) {
    var self = this;
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    var peer = typeof a.peer === 'string' ? a.peer.trim() : '';
    self.log('隧道开请求：room=' + roomId + ' peer=' + peer + ' proto=' + a.proto + ' role=' + a.role + ' port=' + a.port + (a.host_ip ? ' host_ip=' + a.host_ip : ''));
    if (!KEY_RE.test(roomId) || !KEY_RE.test(peer)) {
        self.log('隧道开拒绝：bad_key（键格式不符）');
        return Promise.resolve({ ok: false, err: 'bad_key' });
    }
    if (!PROTOCOLS[a.proto] || !ROLES[a.role]) {
        self.log('隧道开拒绝：bad_args（proto/role 非法）');
        return Promise.resolve({ ok: false, err: 'bad_args' });
    }
    if (!validPort(a.port)) {
        self.log('隧道开拒绝：bad_port（端口 ' + a.port + ' 越界/保留）');
        return Promise.resolve({ ok: false, err: 'bad_port' });
    }
    var hostIp = String(a.host_ip || '');
    if (a.role === 'host') {
        if (!hostIp) hostIp = localPrimaryIP() || '127.0.0.1'; // 缺省用本机局域网 IP（透传反射源地址兼容性，见 localPrimaryIP）
        if (!isLocalAddr(hostIp)) {
            self.log('隧道开拒绝：bad_host_ip（' + hostIp + ' 非本机地址）');
            return Promise.resolve({ ok: false, err: 'bad_host_ip' });
        }
    }

    // 幂等：同键重复打开先收口（静默，不向渲染进程回事件，防重复 ready）
    self.close({ room_id: roomId, peer: peer, proto: a.proto, role: a.role, quiet: true });

    var ctx = {
        roomId: roomId, peer: peer, proto: a.proto, role: a.role,
        port: a.port, reqPort: a.port, hostIp: a.role === 'host' ? hostIp : '',
        skipPort: a.role === 'join' && !!a.skip_port, // war3 等独占端口游戏：数据面永不占用游戏端口
        lastAct: Date.now(), closed: false, quiet: false,
        udp: null, tcpServer: null, streams: new Map(), sid: 1,
        lastSrc: null, localOnly: localAddrs()
    };
    var key = keyOf(roomId, peer, a.proto);
    self.tunnels.set(key, ctx);
    self.ensureSweep();

    return new Promise(function (resolve) {
        var settled = false;
        function ok() { if (!settled) { settled = true; resolve({ ok: true, port: ctx.port, host_ip: ctx.hostIp }); } }
        function bad(err) {
            if (settled) { self.emitEvent(ctx, 0, 'error', err); return; }
            settled = true;
            self.log('隧道开失败：' + err + '（room=' + roomId + ' proto=' + ctx.proto + ' role=' + ctx.role + '）');
            self.destroy(ctx);
            resolve({ ok: false, err: err });
        }
        ctx.fail = bad;

        try {
            if (ctx.proto === 'udp') {
                if (ctx.role === 'join') self.startUdpJoin(ctx, ok, bad);
                else self.startUdpHost(ctx, ok, bad);
            } else {
                if (ctx.role === 'join') self.startTcpJoin(ctx, ok, bad);
                else ok(); // host 侧无监听，按需 connect（惰性）
            }
        } catch (e) {
            bad('open_fail:' + ((e && e.message) || 'unknown'));
        }
    });
};

// 关闭：{room_id, peer?, proto?, role?, quiet?}（peer/proto/role 缺省=该房间全部对端/协议/角色）
GameTunnel.prototype.close = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    var peer = typeof a.peer === 'string' ? a.peer.trim() : '';
    var proto = typeof a.proto === 'string' ? a.proto.trim() : '';
    var role = typeof a.role === 'string' ? a.role.trim() : '';
    var n = 0;
    var keys = [];
    this.tunnels.forEach(function (ctx, k) {
        if (ctx.roomId !== roomId) return;
        if (peer && ctx.peer !== peer) return;
        if (proto && ctx.proto !== proto) return;
        if (role && ctx.role !== role) return;
        keys.push(k);
    });
    for (var i = 0; i < keys.length; i++) {
        var ctx = this.tunnels.get(keys[i]);
        if (!ctx) continue;
        ctx.quiet = !!a.quiet;
        this.destroy(ctx);
        n++;
    }
    return { ok: true, closed: n };
};

GameTunnel.prototype.closeAll = function () {
    var keys = [];
    this.tunnels.forEach(function (ctx, k) { keys.push(k); });
    for (var i = 0; i < keys.length; i++) {
        var ctx = this.tunnels.get(keys[i]);
        if (ctx) { ctx.quiet = true; this.destroy(ctx); }
    }
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    return { ok: true, closed: keys.length };
};

// 渲染进程投递（对端 DataChannel 收到的字节 → 本机套接字）
// frame: {room_id, peer, proto, sid, kind:'data'|'open'|'close', buf}
GameTunnel.prototype.deliver = function (frame) {
    var f = frame || {};
    var ctx = this.tunnels.get(keyOf(String(f.room_id || ''), String(f.peer || ''), String(f.proto || '')));
    if (!ctx || ctx.closed) return { ok: false, err: 'no_tunnel' };
    ctx.lastAct = Date.now();
    var sid = (typeof f.sid === 'number' && f.sid > 0) ? f.sid : 0;
    if (ctx.proto === 'udp') {
        // UDP 单流：本机游戏一套套接字（无 sid 概念）
        var buf = toBuf(f.buf);
        if (!buf) return { ok: false, err: 'bad_buf' };
        if (ctx.role === 'host') {
            if (!ctx.udp) return { ok: false, err: 'not_ready' };
            ctx.udp.send(buf, 0, buf.length, ctx.port, ctx.hostIp);
            return { ok: true };
        }
        if (!ctx.udp || !ctx.lastSrc) return { ok: true, dropped: true }; // join 侧尚无本机来源 → 丢弃（游戏未发过包）
        ctx.udp.send(buf, 0, buf.length, ctx.lastSrc.port, ctx.lastSrc.address);
        return { ok: true };
    }
    // TCP 多路复用
    if (!sid) return { ok: false, err: 'bad_sid' };
    if (f.kind === 'open') {
        if (ctx.role !== 'host') return { ok: true }; // join 侧流由本地 accept 建立，远端 open 帧无意义
        if (ctx.streams.has(sid)) return { ok: true };
        this.connectHostStream(ctx, sid);
        return { ok: true };
    }
    var st = ctx.streams.get(sid);
    if (!st) return { ok: true, dropped: true }; // 未知流（早到/已关闭）静默丢弃
    if (f.kind === 'close') {
        // 远端发起关闭：先摘除再销毁 —— 本地 'close' 回调据此不再回吐 close 帧（防双向 close 回声循环）
        ctx.streams.delete(sid);
        try { st.destroy(); } catch (e) { }
        return { ok: true };
    }
    var b2 = toBuf(f.buf);
    if (!b2) return { ok: false, err: 'bad_buf' };
    try { st.write(b2); } catch (e) { }
    return { ok: true };
};

// ----- UDP -----
// 加入方 UDP：先试原端口（与房主游戏同号——拦截模式下搜索帧钩子在此应答）；被本机游戏先占
// （先开游戏后加入——实测 War3 列表页即预占 6112 的 TCP+UDP，管理员权限下普通进程无法旁路绑定）
// 则数据面顺延扫备用端口，GameInfo 的 GamePort 字段由广播代理补丁为实际端口，游戏连接仍命中隧道
GameTunnel.prototype.startUdpJoin = function (ctx, ok, bad) {
    var self = this;
    var settled = false;
    var plan = this.joinPlan(ctx.roomId, ctx.peer, ctx.reqPort, ctx.skipPort);
    // 套接字接线归口（原端口与顺延端口共用）：本机游戏字节进隧道转发；搜索帧（0xF7 0x2F）交代理本地应答
    function wire(sk) {
        sk.on('error', function (e) {
            if (ctx.closed) return;
            self.log('UDP 套接字错误（房间 ' + ctx.roomId + '）：' + ((e && e.message) || 'udp_error'));
        });
        sk.on('message', function (msg, rinfo) {
            if (ctx.closed) return;
            if (!ctx.localOnly[normalizeAddr(rinfo.address)]) return; // 仅本机来源（他人直连本端口一律丢弃）
            ctx.lastAct = Date.now();
            ctx.lastSrc = { address: rinfo.address, port: rinfo.port };
            // 功能二期方案 B：广播发现代理——本机游戏的 SearchGame（0xF7 0x2F）帧由代理本地应答
            // （虚拟主机模型），不进隧道转发（转发会给房主游戏塞垃圾包）；无代理/非搜索帧照旧转发
            if (msg.length >= 4 && msg[0] === 0xF7 && msg[1] === 0x2F && self.broadcastHook) {
                var replies = null;
                try { replies = self.broadcastHook(ctx.roomId, msg, rinfo); } catch (e) { replies = null; }
                if (replies && replies.length) {
                    for (var i = 0; i < replies.length; i++) {
                        var rb = replies[i];
                        try { sk.send(rb, 0, rb.length, rinfo.port, rinfo.address); } catch (e) { }
                    }
                    return;
                }
            }
            self.emitData(ctx, 0, msg);
        });
    }
    function finish(sk, port) {
        ctx.udp = sk;
        ctx.port = port;
        plan.settle(port); // 端口方案归口：TCP 侧等此裁决（漏调曾致 TCP 每次固定等满 3s 兜底，挤占协商预算）
        self.log('UDP 监听就绪 0.0.0.0:' + port + '（房间 ' + ctx.roomId +
            (port !== plan.reqPort ? '，游戏端口已留给本机游戏' : '') + '）');
        self.emitEvent(ctx, 0, 'listen'); // 渲染层据此启动广播代理（拦截/直投两态由代理按 udpBindOk 自选）
        if (!settled) { settled = true; ctx.fail = null; ok(); }
    }
    // 顺延扫描归口（skip 模式直入 / 原端口被占错误路径共用）
    function scanFallback(fromPort, why) {
        self.log('UDP ' + why + '：顺延扫描备用端口（房间 ' + ctx.roomId + '）');
        scanUdp(fromPort, FALLBACK_SPAN, function (p, sk2) {
            if (ctx.closed) { if (sk2) { try { sk2.close(); } catch (e3) { } } return; }
            if (!p) { self.log('顺延扫描无可用端口（房间 ' + ctx.roomId + '）'); if (ctx.fail) ctx.fail('udp_bind:exhausted'); return; }
            wire(sk2);
            finish(sk2, p);
        });
    }
    if (ctx.skipPort) {
        // war3 等独占端口游戏：原端口永远留给本机游戏（其进局域网页要独占绑定，被占即报
        // "不能连入网络"），数据面直接顺延；发现链路由广播代理直投注入承担，不依赖 6112 拦截
        scanFallback(ctx.port + 1, '跳过游戏端口（留给本机游戏）');
        return;
    }
    var sk = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    wire(sk);
    sk.on('error', function (e) {
        if (ctx.closed || settled) return;
        var msg = (e && e.message) || 'udp_error';
        try { sk.close(); } catch (e2) { }
        if (ctx.udp) { if (ctx.fail) ctx.fail('udp_bind:' + msg); return; }
        // 原端口绑定失败 → 顺延扫描（数据面端口经 plan 与 TCP 侧保持同号）
        scanFallback(ctx.port + 1, '绑定失败（本机游戏先占，' + msg + '）');
    });
    sk.bind(ctx.port, '0.0.0.0', function () {
        if (ctx.closed) { try { sk.close(); } catch (e) { } return; }
        finish(sk, ctx.port);
    });
};

// 查询房间 join UDP 是否仍持有原端口（未顺延）——广播代理据此选择拦截模式（钩子应答）或直投模式
GameTunnel.prototype.udpBindOk = function (roomId) {
    var ok = false;
    this.tunnels.forEach(function (c) {
        if (!ok && c.roomId === roomId && c.role === 'join' && c.proto === 'udp' && c.udp && c.port === c.reqPort) ok = true;
    });
    return ok;
};

GameTunnel.prototype.startUdpHost = function (ctx, ok, bad) {
    var self = this;
    var sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    ctx.udp = sock;
    sock.on('error', function (e) {
        if (ctx.closed) return;
        if (ctx.fail) { ctx.fail('udp_bind:' + ((e && e.message) || '')); return; }
        self.emitEvent(ctx, 0, 'error', (e && e.message) || 'udp_error');
    });
    sock.on('message', function (msg, rinfo) {
        if (ctx.closed) return;
        if (!ctx.localOnly[normalizeAddr(rinfo.address)]) return; // 仅本机游戏来源
        ctx.lastAct = Date.now();
        self.emitData(ctx, 0, msg);
    });
    // 绑定全接口（源地址=本机出口 IP）：收本机游戏回包 + 向本机游戏端口单播发数据时
    // 源地址为局域网合法地址（非回环），透传反射下真实游戏对搜索的应答兼容性最佳
    sock.bind(0, function () {
        if (ctx.closed) return;
        self.log('UDP 房主隧道就绪 → ' + ctx.hostIp + ':' + ctx.port + '（房间 ' + ctx.roomId + '）');
        // 必发 listen：渲染层据此启动主机端探测代理（探测本机游戏真实 GameInfo 中继给加入方）。
        // 缺失此事件时主机端代理永不启动 → 加入方收不到 relayGI → 防幻影静默 → 列表永远为空（实测根因）
        self.emitEvent(ctx, 0, 'listen');
        ok();
    });
};

// ----- TCP -----
// 加入方 TCP：端口随 UDP 侧裁决（两路 open 并发——数据端口必须同号，GameInfo 仅一个 GamePort 字段）；
// 裁决端口监听失败（罕见竞态）→ 顺延扫描；扫描耗尽 → 会话失败（可见报错，不再无限重试同端口）
GameTunnel.prototype.startTcpJoin = function (ctx, ok, bad) {
    var self = this;
    var settled = false;
    var plan = this.joinPlan(ctx.roomId, ctx.peer, ctx.reqPort);
    plan.wait(function (dp) {
        if (ctx.closed) return;
        if (dp && dp !== ctx.port) {
            self.log('TCP 数据端口随 UDP 侧裁决 → ' + dp + '（房间 ' + ctx.roomId + '）');
            ctx.port = dp;
        }
        listen(ctx.port);
    });
    // 套接字接线归口（裁决端口与顺延端口共用）：本机游戏加入连接（TCP）进隧道转发
    function wire(server) {
        server.on('connection', function (sock) {
            if (ctx.closed) { try { sock.destroy(); } catch (e) { } return; }
            if (!ctx.localOnly[normalizeAddr(sock.remoteAddress)]) {
                self.log('TCP 拒绝非本机来源 ' + sock.remoteAddress + '（房间 ' + ctx.roomId + '）');
                try { sock.destroy(); } catch (e) { }
                return;
            }
            ctx.lastAct = Date.now();
            var sid = ctx.sid++;
            if (sid > 0x7fffffff) ctx.sid = 1;
            ctx.streams.set(sid, sock);
            try { sock.setNoDelay(true); } catch (e) { }
            sock.on('data', function (chunk) {
                if (ctx.closed) return;
                ctx.lastAct = Date.now();
                self.emitData(ctx, sid, chunk);
            });
            sock.on('close', function () {
                if (ctx.streams.get(sid) === sock) {
                    ctx.streams.delete(sid);
                    if (!ctx.closed) self.emitEvent(ctx, sid, 'close');
                }
            });
            sock.on('error', function () {
                try { sock.destroy(); } catch (e) { }
            });
            self.emitEvent(ctx, sid, 'open');
        });
    }
    function listen(port) {
        var sk = net.createServer({ allowHalfOpen: false, pauseOnConnect: false });
        sk.on('error', function (e) {
            if (ctx.closed) return;
            var msg = (e && e.message) || 'tcp_error';
            if (settled) { self.emitEvent(ctx, 0, 'error', msg); return; } // 运行期错误：报事件不失败
            try { sk.close(); } catch (e2) { }
            self.log('TCP ' + port + ' 监听失败：顺延扫描备用端口（房间 ' + ctx.roomId + '）');
            scanTcp(port + 1, FALLBACK_SPAN, function (p, sk2) {
                if (ctx.closed) { if (sk2) { try { sk2.close(); } catch (e3) { } } return; }
                if (!p) { self.log('顺延扫描无可用端口（房间 ' + ctx.roomId + '）'); if (ctx.fail) ctx.fail('tcp_listen:' + msg); return; }
                ctx.port = p; // 与 UDP 数据口失配（仅 GamePort 补丁取 UDP 侧时加入连接受限），日志可见
                wire(sk2);
                ready(sk2, p); // 扫描返回的 server 已在监听，直接进入就绪（不可重复 listen）
            });
        });
        wire(sk);
        sk.listen(port, '0.0.0.0', function () {
            if (ctx.closed) { try { sk.close(); } catch (e) { } return; }
            ready(sk, port);
        });
    }
    // 监听就绪归口（裁决端口与顺延端口共用）：登记 server + 发 listen + resolve open
    function ready(sk, port) {
        ctx.tcpServer = sk;
        self.log('TCP 监听就绪 0.0.0.0:' + port + '（房间 ' + ctx.roomId + '）');
        self.emitEvent(ctx, 0, 'listen'); // 渲染层据此更新链路态（广播代理仅由 UDP listen 启动）
        if (!settled) { settled = true; ctx.fail = null; ok(); }
    }
};

// host 侧按远端 open 帧连本机游戏（connect 失败即回 close，令对端游戏得到明确断链）
GameTunnel.prototype.connectHostStream = function (ctx, sid) {
    var self = this;
    var sock = net.connect({ host: ctx.hostIp, port: ctx.port });
    ctx.streams.set(sid, sock);
    ctx.lastAct = Date.now();
    try { sock.setNoDelay(true); } catch (e) { }
    sock.on('connect', function () {
        if (ctx.closed) return;
        self.emitEvent(ctx, sid, 'open');
    });
    sock.on('data', function (chunk) {
        if (ctx.closed) return;
        ctx.lastAct = Date.now();
        self.emitData(ctx, sid, chunk);
    });
    sock.on('close', function () {
        if (ctx.streams.get(sid) === sock) {
            ctx.streams.delete(sid);
            if (!ctx.closed) self.emitEvent(ctx, sid, 'close');
        }
    });
    sock.on('error', function (e) {
        if (ctx.streams.get(sid) === sock) {
            ctx.streams.delete(sid);
            if (!ctx.closed) self.emitEvent(ctx, sid, 'close', (e && e.message) || 'connect_fail');
        }
        try { sock.destroy(); } catch (e2) { }
    });
};

// ----- 帧送出 -----
GameTunnel.prototype.emitData = function (ctx, sid, buf) {
    this.emit('gn-tunnel:data', {
        room_id: ctx.roomId, peer: ctx.peer, proto: ctx.proto, role: ctx.role, port: ctx.port,
        sid: sid, kind: 'data', buf: buf // Buffer 经 Electron 结构化克隆到达渲染进程为 Uint8Array
    });
};

GameTunnel.prototype.emitEvent = function (ctx, sid, kind, reason) {
    if (ctx.quiet) return;
    this.emit('gn-tunnel:event', {
        room_id: ctx.roomId, peer: ctx.peer, proto: ctx.proto, role: ctx.role, port: ctx.port,
        sid: sid, kind: kind, reason: reason || ''
    });
};

// ----- 收口 -----
GameTunnel.prototype.destroy = function (ctx) {
    if (ctx.closed) return;
    ctx.closed = true;
    ctx.fail = null;
    this.tunnels.delete(keyOf(ctx.roomId, ctx.peer, ctx.proto));
    // join 端口方案清理：该房间该对端已无任何 join 隧道时摘除（下次加入重新裁决）
    if (ctx.role === 'join') {
        var alive = false;
        this.tunnels.forEach(function (c) {
            if (c.role === 'join' && c.roomId === ctx.roomId && c.peer === ctx.peer) alive = true;
        });
        if (!alive) this.joinPlans.delete(ctx.roomId + '|' + ctx.peer);
    }
    ctx.streams.forEach(function (sock) { try { sock.destroy(); } catch (e) { } });
    ctx.streams.clear();
    if (ctx.udp) { try { ctx.udp.close(); } catch (e) { } ctx.udp = null; }
    if (ctx.tcpServer) {
        try { ctx.tcpServer.close(); } catch (e) { }
        ctx.tcpServer = null;
    }
    this.emitEvent(ctx, 0, 'closed');
};

// 空闲兜底清扫（正常联机由 110 ping 保活 + 房间收口即时关闭，此处仅防孤儿）
GameTunnel.prototype.ensureSweep = function () {
    var self = this;
    if (self.sweepTimer) return;
    self.sweepTimer = setInterval(function () {
        if (self.tunnels.size === 0) {
            clearInterval(self.sweepTimer);
            self.sweepTimer = null;
            return;
        }
        var t = Date.now();
        var dead = [];
        self.tunnels.forEach(function (ctx) { if (t - ctx.lastAct > IDLE_CLOSE_MS) dead.push(ctx); });
        for (var i = 0; i < dead.length; i++) {
            self.log('空闲超时收口（房间 ' + dead[i].roomId + ' 对端 ' + dead[i].peer + ' ' + dead[i].proto + '）');
            dead[i].quiet = false;
            self.emitEvent(dead[i], 0, 'idle');
            self.destroy(dead[i]);
        }
    }, IDLE_SWEEP_MS);
    if (self.sweepTimer.unref) self.sweepTimer.unref();
};

// ----- 阶段二百九十二 M7：房主游戏端口自动探测（设计文档 §4.3 第 1 层） -----
// 形态二要求「房主端枚举本机监听套接字，按游戏进程过滤出游戏端口自动填入，失败回落手动指定」。
// 实现口径（免额外依赖）：netstat -ano 给 {协议, 本地地址:端口, PID}；tasklist 给 PID → 进程名，
// 二者均为系统自带命令（Node 无内建进程/套接字枚举能力）。仅 PC 端适用（一期约定）。
// 过滤：procs 为已登记游戏进程名列表（子串、大小写不敏感）——命中优先；零命中时前端回落全量候选，
// 不因「游戏未登记/未运行」让用户填不了端口。
var DETECT_TIMEOUT_MS = 5000;

function execOut(file, args) {
    return new Promise(function (resolve) {
        try {
            execFile(file, args, { windowsHide: true, timeout: DETECT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
                function (err, stdout) { resolve(stdout ? String(stdout) : ''); });
        } catch (e) { resolve(''); }
    });
}

// netstat -ano 解析：TCP 仅取 LISTENING（已建立连接的服务端口不重复计），UDP 取全部绑定
function parseNetstat(out) {
    var byPort = {};
    var lines = String(out || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var f = lines[i].trim().split(/\s+/);
        if (f.length < 4) continue;
        var proto = (f[0] || '').toLowerCase();
        if (proto === 'tcp') { if (f[3] !== 'LISTENING') continue; }
        else if (proto !== 'udp') continue;
        var m = /:(\d+)$/.exec(f[1] || '');
        if (!m) continue;
        var port = parseInt(m[1], 10);
        if (!isFinite(port) || port < MIN_PORT || port > MAX_PORT) continue; // 与隧道端口白名单同口径
        var pid = parseInt(f[f.length - 1], 10);
        if (!isFinite(pid)) pid = 0;
        var e = byPort[port];
        if (!e) { e = byPort[port] = { port: port, pid: pid, protos: {} }; }
        if (e.protos[proto]) continue;            // 同协议重复行（如 0.0.0.0 + 127.0.0.1）只留首条
        e.protos[proto] = true;
        if (pid > 0) e.pid = pid;
    }
    return byPort;
}

// tasklist /fo csv /nh 解析：每行 "进程名","PID",...（进程名可能含逗号，故按 "," 切分后取前两列）
function parseTasklist(out) {
    var byPid = {};
    var lines = String(out || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (s.charAt(0) !== '"') continue;
        var cols = s.split('","');
        if (cols.length < 2) continue;
        var name = cols[0].slice(1);
        var pid = parseInt(String(cols[1]).replace(/"/g, ''), 10);
        if (name && isFinite(pid)) byPid[pid] = name;
    }
    return byPid;
}

// → Promise<{ok, list:[{port, pid, proc, protos:['tcp','udp']}], filtered:boolean}>
// args.procs：已登记游戏进程名数组（可选）；命中即返回命中集，零命中返回全量并置 filtered=false
GameTunnel.prototype.detectPorts = function (args) {
    args = args || {};
    var procs = (Array.isArray(args.procs) ? args.procs : []).map(function (n) {
        return String(n || '').trim().toLowerCase();
    }).filter(function (n) { return !!n; });

    return Promise.all([execOut('netstat', ['-ano']), execOut('tasklist', ['/fo', 'csv', '/nh'])]).then(function (outs) {
        var byPort = parseNetstat(outs[0]);
        var byPid = parseTasklist(outs[1]);
        var all = [];
        Object.keys(byPort).forEach(function (k) {
            var e = byPort[k];
            var name = (e.pid && byPid[e.pid]) || '';
            all.push({ port: e.port, pid: e.pid, proc: name, protos: Object.keys(e.protos) });
        });
        var hit = all;
        if (procs.length) {
            hit = all.filter(function (it) {
                var n = String(it.proc || '').toLowerCase();
                if (!n) return false;
                for (var i = 0; i < procs.length; i++) { if (n.indexOf(procs[i]) >= 0) return true; }
                return false;
            });
        }
        var useFilter = procs.length > 0 && hit.length > 0;
        var list = (useFilter ? hit : all).sort(function (a, b) { return a.port - b.port; });
        return { ok: true, list: list, filtered: useFilter };
    });
};

module.exports = new GameTunnel();
module.exports.GameTunnel = GameTunnel;
