// game-forward.js - 游戏端口透传转发（Electron 主进程，独立于联机房间隧道）
//
// 场景：上架网络游戏把服务器地址配置为本机 127.0.0.1:listen，客户端在游戏启动前开启本机监听，
//       将 TCP/UDP 流量原样透传到远端真实服务器 remote_host:remote_port（游戏退出自动关闭）。
//       与 game-tunnel.js（联机房间·WebRTC 数据面隧道）互补：本模块面向「游戏客户端 → 固定游戏服务器」
//       的直连代理，不经房间信令，规则由启动参数（管理端游戏配置/本地游戏属性）随 game:launch 下发。
//
// 为什么必须在主进程：OS 层 TCP 监听/UDP 套接字渲染进程（Chromium 沙箱）拿不到（同 game-tunnel 归口）。
//
// 无损语义：
//   TCP → net.Server 用户态对接 socket.pipe(socket)，内核保证可靠有序，转发不丢不乱序；
//   UDP → 按客户端地址维护「会话 socket」（NAT 式映射），数据报原样转发不缓存不重组，
//         转发器自身不引入额外丢包（收包即转，唯一丢弃场景=会话表超上限兜底）；数据报边界保持。
// 延迟：本机回环 + 用户态转发单包开销约 0.05~0.3ms（远低于感知阈值）；端到端延迟由网络链路决定。
//
// 安全归口：
//   1. 只绑 127.0.0.1：不向局域网/外网暴露监听（外部机器无法把本机当跳板代理）；
//   2. 规则白名单校验：协议/端口范围/远端主机字符集全部受控，渲染进程不能借道开任意代理；
//   3. 保留端口：3478（TURN/STUN）、2087（客户端本机服务端口）不监听（与 game-tunnel 同表）；
//   4. 资源上限：单规则 TCP 连接数 / UDP 会话数封顶，防表爆炸；stop 收口全部套接字。

const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');

var logger = null; // 日志归口（main.js 注入 gnLogWrite；未注入则静默）
function log(msg) { try { if (logger) logger(msg); } catch (e) { } }

const MIN_PORT = 1024;        // 本机监听端口下限（与 game-tunnel 同口径）
const MAX_PORT = 65535;
const RESERVED_PORTS = { 3478: true, 2087: true }; // 保留端口：不监听（防抢占既有链路）
const MAX_RULES = 16;                       // 单次启动规则数上限
const HOST_RE = /^[A-Za-z0-9._-]{1,253}$/;  // 远端主机：IPv4 / 域名字符集（禁空白/分隔符/协议前缀）
const TCP_MAX_CONN = 512;                   // 单条 TCP 规则并发连接上限
const UDP_MAX_SESSIONS = 1024;              // 单条 UDP 规则会话上限（每客户端地址一条）
const UDP_IDLE_MS = 120000;                 // UDP 会话空闲回收（无往返 2 分钟；游戏心跳远短于此）
const UDP_SWEEP_MS = 30000;                 // 会话清扫周期
const SOCK_BUF = 262144;                    // UDP 收发缓冲 256KB（收包即转，缓冲仅抗瞬时突发）

// ===== gateway 加密模式（远程 im-gateway 网关；协议 v1 见 gateway/main.go 头注释）=====
const GW_FIRST_FRAME_MS = 8000;   // 首帧/注册应答超时
const GW_TCP_TARGET_MS = 5000;    // 网关侧连接目标失败的上游等待窗（客户端 ok 等待上限）
const GW_UDP_KEEPALIVE_MS = 30000; // UDP 控制连接保活空行周期（网关 90s 无帧回收会话）
const GW_UDP_MTU = 1200;          // 单数据报载荷上限（超限丢弃，与公网直连 MTU 行为一致）
const GW_NONCE_C2G = 'C2G0';      // 客户端→网关方向 nonce 前缀 4B
const GW_NONCE_G2C = 'G2C0';      // 网关→客户端方向 nonce 前缀 4B

// fwMap: tag → { forwards: Map<ruleKey, forwarder>, rules: 原始规则数组 }
// forwarder(tcp/direct): { proto:'tcp', server, live:Set }
// forwarder(udp/direct): { proto:'udp', sock, sessions:Map, sweep }
// forwarder(tcp/gateway): { proto:'tcp', mode:'gateway', pending:Set<TLS连接>, closed }
// forwarder(udp/gateway): { proto:'udp', mode:'gateway', sock, ctl, k1, k2, sessId, tx, clientMap:Map, ka }
var fwMap = new Map();

// ----- 规则校验归口（启动前全量校验，任一非法整体拒绝——all-or-nothing） -----
// 返回 {ok:true, rules} | {ok:false, err}
// gwPack = {token, gateways:[{name,addr,fingerprint}]}（渲染层从库接口 gateway 字段透传）：
// 多网关部署下 gw 规则经 @网关名 查地址簿决定连哪台网关；缺省名取地址簿第一条
function validateRules(rules, gwPack) {
    if (!Array.isArray(rules)) return { ok: false, err: '转发规则格式错误' };
    if (rules.length === 0) return { ok: true, rules: [] };
    if (rules.length > MAX_RULES) return { ok: false, err: '转发规则过多（上限 ' + MAX_RULES + ' 条）' };
    // 网关模式规则须随启动下发网关配置（渲染层从库接口 gateway 字段透传）
    var needGw = rules.some(function (r) { return r && String(r.mode || '') === 'gateway'; });
    var pack = null;
    if (needGw) {
        pack = normalizeGwPack(gwPack);
        if (!pack) return { ok: false, err: '未配置加密网关（请在主界面重新登录后重试）' };
    }
    var out = [];
    var seen = {}; // 同批去重：proto+listen 不可重复（重复监听必失败）
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i] || {};
        var proto = String(r.proto || '').toLowerCase();
        var mode = String(r.mode || '').toLowerCase();
        var gwName = String(r.gw || '').toLowerCase();
        var listen = Number(r.listen) | 0;
        var rport = Number(r.remote_port) | 0;
        var rhost = String(r.remote_host || '').trim();
        if (proto !== 'tcp' && proto !== 'udp') return { ok: false, err: '转发协议非法（仅 tcp/udp）' };
        if (mode !== '' && mode !== 'gateway') return { ok: false, err: '转发模式非法（仅 直连/网关）' };
        if (mode === '' && gwName) return { ok: false, err: '直连规则不应携带网关名（@名 仅网关模式使用）' };
        if (!(listen >= MIN_PORT && listen <= MAX_PORT)) return { ok: false, err: '监听端口须在 ' + MIN_PORT + '~' + MAX_PORT };
        if (RESERVED_PORTS[listen]) return { ok: false, err: '监听端口 ' + listen + ' 为保留端口' };
        if (!(rport >= 1 && rport <= MAX_PORT)) return { ok: false, err: '远端端口非法' };
        if (mode === 'gateway') {
            rhost = ''; // 网关模式：远端=网关本机 127.0.0.1 端口（目标地址由网关承载）
            // @网关名 → 地址簿条目（缺省名=第一条）；未知网关名拒绝并提示
            r.gwConf = resolveGwConf(pack, gwName);
            if (!r.gwConf) {
                return { ok: false, err: '网关「' + gwName + '」未在服务端地址簿中配置（请检查服务端 game.gateways）' };
            }
        } else if (!HOST_RE.test(rhost) || rhost.indexOf('..') !== -1 || /^[.-]/.test(rhost) || /[.-]$/.test(rhost)) {
            return { ok: false, err: '远端地址非法（须为 IPv4 或域名）' };
        }
        var key = proto + ':' + listen;
        if (seen[key]) return { ok: false, err: '存在重复监听：' + key };
        seen[key] = true;
        out.push({ proto: proto, mode: mode, gw: gwName, gwConf: r.gwConf || null, listen: listen, remote_host: rhost, remote_port: rport });
    }
    return { ok: true, rules: out };
}

// 网关包归一：{token, gateways:[{name,addr,fingerprint[,token]}]}
// （token 为顶层共享 token；逐网关独立密钥部署下条目自带专属 token——优先用之，回退顶层共享，
//   两种下发形态均兼容。条目最终必须持有可用 token）
function normalizeGwPack(c) {
    c = c || {};
    var token = String(c.token || '').trim();
    if (token && (token.length > 512 || /[^\x21-\x7e.]/.test(token))) return null; // token 仅可见 ASCII+点
    if (!Array.isArray(c.gateways) || c.gateways.length === 0) return null;
    var list = [];
    for (var i = 0; i < c.gateways.length; i++) {
        var g = c.gateways[i] || {};
        var name = String(g.name || '').trim().toLowerCase();
        var m = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(String(g.addr || '').trim());
        var fp = String(g.fingerprint || '').trim().toLowerCase();
        if (!name || name.length > 32 || !/^[a-z0-9_-]+$/.test(name) || !m) continue;
        var port = Number(m[2]) | 0;
        if (!(port >= 1 && port <= MAX_PORT)) continue;
        if (!/^[0-9a-f]{64}$/.test(fp)) continue;
        var t = String(g.token || '').trim() || token; // 条目专属 token 优先，回退顶层共享 token
        if (!t || t.length > 512 || /[^\x21-\x7e.]/.test(t)) continue;
        list.push({ name: name, host: m[1], port: port, fingerprint: fp, token: t });
    }
    if (!list.length) return null;
    return { token: token, gateways: list };
}

// @网关名 → 单网关连接配置（缺省名=地址簿第一条）
function resolveGwConf(pack, name) {
    for (var i = 0; i < pack.gateways.length; i++) {
        if (pack.gateways[i].name === name) return pack.gateways[i];
    }
    if (!name) return pack.gateways[0]; // 规则未指定网关：取地址簿第一条（default）
    return null;
}

// TLS 连接工厂：跳过系统 CA 链（网关自签证书），握手完成后按证书 SHA256 指纹 pin 校验
// （Go 网关日志输出的 DER 指纹）。注意：rejectUnauthorized:false 时 Node 不调用 checkServerIdentity，
// 因此 pin 必须在 secureConnect 后手动校验——不匹配立即断开并报错，指纹不匹配的连接永不可用
function gwTlsConnect(gw, onReady, onFail) {
    var sock = tls.connect({
        host: gw.host,
        port: gw.port,
        rejectUnauthorized: false // 自签证书不走 CA 链；安全性由下方握手后指纹 pin 承担（强度等价且更直接）
    }, function () {
        var sha = crypto.createHash('sha256').update(sock.getPeerCertificate().raw).digest('hex');
        if (sha !== gw.fingerprint) {
            try { sock.destroy(); } catch (e) { }
            onFail(new Error('网关证书指纹不匹配（预期 ' + gw.fingerprint.slice(0, 16) + '…，实际 ' + sha.slice(0, 16) + '…）'));
            return;
        }
        onReady(sock);
    });
    sock.once('error', function (e) { onFail(e); });
    return sock;
}

// 读一行 JSON（限长限时）→ Promise<obj>
function gwReadJSON(sock, limitMs) {
    return new Promise(function (resolve, reject) {
        var buf = '';
        var timer = setTimeout(function () { cleanup(); reject(new Error('网关应答超时')); }, limitMs || GW_FIRST_FRAME_MS);
        function onData(d) {
            buf += d.toString();
            var i = buf.indexOf('\n');
            if (i < 0) {
                if (buf.length > 512) { cleanup(); reject(new Error('网关应答超长')); }
                return;
            }
            cleanup();
            try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(new Error('网关应答解析失败')); }
        }
        function onErr(e) { cleanup(); reject(e); }
        function cleanup() {
            clearTimeout(timer);
            sock.removeListener('data', onData);
            sock.removeListener('error', onErr);
        }
        sock.on('data', onData);
        sock.on('error', onErr);
    });
}

function bindErrText(e, proto, listen) {
    var code = e && e.code;
    if (code === 'EADDRINUSE') return (proto === 'tcp' ? 'TCP ' : 'UDP ') + listen + ' 端口被占用';
    if (code === 'EACCES') return (proto === 'tcp' ? 'TCP ' : 'UDP ') + listen + ' 无绑定权限';
    return (proto === 'tcp' ? 'TCP ' : 'UDP ') + listen + ' 监听失败' + (code ? ('（' + code + '）') : '');
}

// ----- TCP 透传：本机监听 → 每连接一条上游 socket，双向 pipe -----
function startTcp(rule) {
    return new Promise(function (resolve) {
        var server = net.createServer();
        var conns = 0;
        var closed = false;
        var resolved = false; // resolve 幂等标志（error 与 listen 竞态防双调）
        var live = new Set(); // 存量连接对（client/upstream 双向登记，stop 时统一销毁）
        server.on('connection', function (client) {
            if (closed) { try { client.destroy(); } catch (e) { } return; }
            if (conns >= TCP_MAX_CONN) { try { client.destroy(); } catch (e) { } return; } // 超上限兜底丢弃
            conns++;
            client.setNoDelay(true); // 禁 Nagle：小包（游戏心跳/输入）即发
            var upstream = net.connect({ host: rule.remote_host, port: rule.remote_port });
            upstream.setNoDelay(true);
            live.add(client); live.add(upstream);
            var done = false;
            var cleanup = function () {
                if (done) return;
                done = true;
                conns--;
                live.delete(client); live.delete(upstream);
                try { client.destroy(); } catch (e) { }
                try { upstream.destroy(); } catch (e) { }
            };
            client.once('close', cleanup);
            client.once('error', cleanup);
            upstream.once('close', cleanup);
            upstream.once('error', cleanup);
            // 连接建立前后都可 pipe（未连上前写入的数据由 socket 缓冲，连上即送达）
            client.pipe(upstream);
            upstream.pipe(client);
        });
        // error 用 on 而非 once：once 在监听成功后被消费，运行中再触发 error（如 EMFILE 句柄耗尽）
        // 会变成无 handler 的未捕获异常直接崩溃主进程；resolved 标志保证启动期只回一次结果
        server.on('error', function (e) {
            closed = true;
            try { server.close(); } catch (e2) { }
            if (!resolved) { resolved = true; resolve({ ok: false, err: bindErrText(e, 'tcp', rule.listen) }); }
            else log('[pf] TCP ' + rule.listen + ' 运行中错误: ' + ((e && e.code) || e));
        });
        server.listen(rule.listen, '127.0.0.1', function () {
            if (!resolved) { resolved = true; resolve({ ok: true, fw: { proto: 'tcp', server: server, live: live, count: function () { return conns; } } }); }
        });
    });
}

function stopTcp(fw) {
    try { fw.server.close(); } catch (e) { }
    // close 只停监听，存量连接须主动断（游戏已退出/应用收口，连接无继续存在的意义）
    var n = fw.live.size;
    if (n > 0) log('[pf] TCP 强制断开存量连接 ' + n + ' 端');
    fw.live.forEach(function (s) { try { s.destroy(); } catch (e) { } });
    fw.live.clear();
    fw.server.unref();
}

// ----- UDP 透传：本机监听 → 按客户端地址会话映射（NAT 式），回包按会话源地址回投 -----
function startUdp(rule) {
    return new Promise(function (resolve) {
        var sock = dgram.createSocket('udp4');
        var sessions = new Map(); // clientKey(ip:port) → {sock:上游, last:最后活跃时刻}
        var closed = false;
        var resolved = false; // resolve 幂等标志（error 与 bind 竞态防双调）
        sock.on('message', function (msg, rinfo) {
            if (closed) return;
            var key = rinfo.address + ':' + rinfo.port;
            var sess = sessions.get(key);
            if (!sess) {
                if (sessions.size >= UDP_MAX_SESSIONS) return; // 超上限兜底丢弃（防会话表爆炸）
                var up = dgram.createSocket('udp4');
                // 缓冲调优（非关键路径）：未绑定前的会话 socket 部分平台 set*BufferSize 抛 ENOTSOCK，静默降级
                try { up.setRecvBufferSize(SOCK_BUF); } catch (e) { }
                try { up.setSendBufferSize(SOCK_BUF); } catch (e) { }
                var sessKey = key;
                var sessInfo = rinfo; // 会话创建时的客户端地址即回包地址（闭包固化）
                up.on('message', function (buf) {
                    try { sock.send(buf, sessInfo.port, sessInfo.address); } catch (e) { }
                });
                up.on('error', function () {
                    sessions.delete(sessKey);
                    try { up.close(); } catch (e) { }
                });
                sess = { sock: up, last: Date.now() };
                sessions.set(key, sess);
            }
            sess.last = Date.now();
            try { sess.sock.send(msg, rule.remote_port, rule.remote_host); } catch (e) { }
        });
        // error 用 on 而非 once：once 在绑定成功后被消费，运行中再触发 error 会变成无 handler
        // 的未捕获异常直接崩溃主进程；resolved 标志保证启动期只回一次结果
        sock.on('error', function (e) {
            closed = true;
            try { sock.close(); } catch (e2) { }
            if (!resolved) { resolved = true; resolve({ ok: false, err: bindErrText(e, 'udp', rule.listen) }); }
            else log('[pf] UDP ' + rule.listen + ' 运行中错误: ' + ((e && e.code) || e));
        });
        sock.bind(rule.listen, '127.0.0.1', function () {
            // 已绑定的监听 socket 调缓冲接口理论安全，仍兜底防平台差异中断启动
            try { sock.setRecvBufferSize(SOCK_BUF); } catch (e) { }
            try { sock.setSendBufferSize(SOCK_BUF); } catch (e) { }
            // 会话清扫：空闲超时回收上游 socket（游戏退出后残留会话的兜底收口）
            var sweep = setInterval(function () {
                var now = Date.now();
                sessions.forEach(function (s, k) {
                    if (now - s.last > UDP_IDLE_MS) {
                        sessions.delete(k);
                        try { s.sock.close(); } catch (e) { }
                    }
                });
            }, UDP_SWEEP_MS);
            if (sweep.unref) sweep.unref();
            if (!resolved) { resolved = true; resolve({ ok: true, fw: { proto: 'udp', sock: sock, sessions: sessions, sweep: sweep } }); }
        });
    });
}

function stopUdp(fw) {
    try { if (fw.sweep) clearInterval(fw.sweep); } catch (e) { }
    fw.sessions.forEach(function (s) { try { s.sock.close(); } catch (e) { } });
    fw.sessions.clear();
    try { fw.sock.close(); } catch (e) { }
}

// ===== gateway 加密模式：TCP 数据面（每游戏连接一条 TLS；pin 指纹+首帧声明+透传） =====
function startTcpGw(rule, gw) {
    return new Promise(function (resolve) {
        var server = net.createServer();
        var conns = 0;
        var closed = false;
        var live = new Set(); // 游戏 client + 网关 TLS 成对登记，stop 时统一销毁
        server.on('connection', function (client) {
            if (closed) { try { client.destroy(); } catch (e) { } return; }
            if (conns >= TCP_MAX_CONN) { try { client.destroy(); } catch (e) { } return; }
            conns++;
            client.setNoDelay(true);
            live.add(client);
            var pairDone = false;
            var cleanupPair = function (tlsSock) {
                if (pairDone) return;
                pairDone = true;
                conns--;
                live.delete(client);
                if (tlsSock) live.delete(tlsSock);
                try { client.destroy(); } catch (e) { }
                if (tlsSock) { try { tlsSock.destroy(); } catch (e) { } }
            };
            client.once('close', function () { cleanupPair(fwCur); });
            client.once('error', function () { cleanupPair(fwCur); });
            var fwCur = null;
            // 网关 TLS：pin 指纹 → 首帧声明（token+目标端口）→ ok 后进入透传
            var tlsSock = gwTlsConnect(gw, function (ts) {
                if (closed) { cleanupPair(ts); return; }
                fwCur = ts;
                live.add(ts);
                ts.once('close', function () { cleanupPair(ts); });
                ts.once('error', function () { cleanupPair(ts); });
                ts.write(JSON.stringify({ token: gw.token, target: rule.remote_port }) + '\n');
                gwReadJSON(ts, GW_TCP_TARGET_MS).then(function (resp) {
                    if (!resp || resp.ok !== true) {
                        log('[pf] 网关拒绝 TCP 连接：' + ((resp && resp.err) || '未知') + '（目标 ' + rule.remote_port + '）');
                        cleanupPair(ts);
                        return;
                    }
                    // ok 后双向 pipe：TLS 保证可靠有序无损（游戏侧数据已被 TCP 缓冲，连上即送达）
                    client.pipe(ts);
                    ts.pipe(client);
                }).catch(function (e) {
                    log('[pf] 网关 TCP 首帧失败：' + ((e && e.message) || e));
                    cleanupPair(ts);
                });
            }, function (e) {
                log('[pf] 网关 TLS 连接失败：' + ((e && e.message) || e));
                cleanupPair(null);
            });
        });
        server.once('error', function (e) {
            closed = true;
            try { server.close(); } catch (e2) { }
            resolve({ ok: false, err: bindErrText(e, 'tcp', rule.listen) });
        });
        server.listen(rule.listen, '127.0.0.1', function () {
            resolve({ ok: true, fw: { proto: 'tcp', mode: 'gateway', server: server, live: live, isLive: true } });
        });
    });
}

function stopTcpGw(fw) {
    try { fw.server.close(); } catch (e) { }
    var n = fw.live.size;
    if (n > 0) log('[pf] TCP(网关) 强制断开存量连接 ' + n + ' 端');
    fw.live.forEach(function (s) { try { s.destroy(); } catch (e) { } });
    fw.live.clear();
    fw.server.unref();
}

// ===== gateway 加密模式：UDP 数据面（每游戏客户端地址一条独立网关会话；AEAD 逐包加密） =====
// 每客户端三件套：TLS 控制连接（注册+保活）+ 独立出站 socket（网关按源端口区分回包归属）+ 会话密钥
function startUdpGw(rule, gw) {
    return new Promise(function (resolve) {
        var sock = dgram.createSocket('udp4');
        var closed = false;
        var clients = new Map(); // 游戏客户端地址 → 会话三件套
        var sweep = setInterval(function () {
            var now = Date.now();
            clients.forEach(function (c, k) {
                if (now - c.last > UDP_IDLE_MS) {
                    clients.delete(k);
                    gwUdpClientTeardown(c);
                }
            });
        }, UDP_SWEEP_MS);
        if (sweep.unref) sweep.unref();
        sock.on('message', function (msg, rinfo) {
            if (closed) return;
            if (msg.length > GW_UDP_MTU) return; // 超限丢弃（与公网直连 MTU 行为一致）
            var key = rinfo.address + ':' + rinfo.port;
            var c = clients.get(key);
            if (!c) {
                if (clients.size >= UDP_MAX_SESSIONS) return; // 超上限兜底丢弃
                c = { ready: false, pending: [], tx: 0, last: Date.now(), sessId: 0, k1: null, k2: null, ctl: null, out: null, ka: null, client: { address: rinfo.address, port: rinfo.port } };
                clients.set(key, c);
                gwUdpClientSetup(gw, rule, c, key, clients, sock); // 异步注册（首包起 1~2 RTT；期间包缓冲）
            }
            c.last = Date.now();
            if (!c.ready) {
                if (c.pending.length < 64) c.pending.push(Buffer.from(msg));
                return;
            }
            gwUdpSend(c, msg, gw);
        });
        sock.once('error', function (e) {
            closed = true;
            try { sock.close(); } catch (e2) { }
            resolve({ ok: false, err: bindErrText(e, 'udp', rule.listen) });
        });
        sock.bind(rule.listen, '127.0.0.1', function () {
            try { sock.setRecvBufferSize(SOCK_BUF); } catch (e) { }
            try { sock.setSendBufferSize(SOCK_BUF); } catch (e) { }
            resolve({ ok: true, fw: { proto: 'udp', mode: 'gateway', sock: sock, clients: clients, sweep: sweep } });
        });
    });
}

// 单客户端会话建立：TLS 注册（token+目标）→ 领会话密钥 → 独立出站 socket → 就绪后 flush 缓冲
// sock=本机监听主 socket（回包经它回投游戏客户端——客户端只连这个端口）
function gwUdpClientSetup(gw, rule, c, key, clients, sock) {
    var fail = function (why) {
        log('[pf] UDP(网关) 会话建立失败 ' + key + '：' + why);
        c.ready = false;
        c.dead = true;
        if (c.ka) { clearInterval(c.ka); c.ka = null; }
        if (c.ctl) { try { c.ctl.destroy(); } catch (e) { } c.ctl = null; }
        clients.delete(key); // 就绪前失败：从表中移除，游戏后续包会重建会话
    };
    var ctl = gwTlsConnect(gw, function (ts) {
        if (c.dead) { try { ts.destroy(); } catch (e) { } return; }
        c.ctl = ts;
        ts.once('close', function () { c.ctl = null; });
        ts.write(JSON.stringify({ token: gw.token, target: rule.remote_port, udp: true }) + '\n');
        gwReadJSON(ts, GW_FIRST_FRAME_MS).then(function (resp) {
            if (c.dead) return;
            if (!resp || resp.ok !== true || !resp.session || !resp.k1 || !resp.k2) {
                fail('网关拒绝：' + ((resp && resp.err) || '应答不完整'));
                try { ts.destroy(); } catch (e) { }
                return;
            }
            c.sessId = parseInt(resp.session, 16) >>> 0;
            c.k1 = Buffer.from(resp.k1, 'base64');
            c.k2 = Buffer.from(resp.k2, 'base64');
            // 保活：30s 空行刷新网关侧 90s 会话存活（游戏静默期兜底）
            c.ka = setInterval(function () {
                try { if (c.ctl) c.ctl.write('\n'); } catch (e) { }
            }, GW_UDP_KEEPALIVE_MS);
            if (c.ka.unref) c.ka.unref();
            // 独立出站 socket：网关按源端口归属回包（多游戏客户端互不串线）
            var out = dgram.createSocket('udp4');
            if (out.setRecvBufferSize) { try { out.setRecvBufferSize(SOCK_BUF); } catch (e) { } }
            out.on('message', function (m) {
                if (c.dead || !c.ready || m.length < 28 || m.length > 12 + 16 + GW_UDP_MTU) return;
                try {
                    var head = m.slice(0, 12);
                    if (head.readUInt32BE(0) !== c.sessId) return; // 非本会话回包
                    var nonce = Buffer.concat([Buffer.from(GW_NONCE_G2C, 'ascii'), head.slice(4, 12)]);
                    var d = crypto.createDecipheriv('aes-256-gcm', c.k2, nonce);
                    d.setAAD(head);
                    var ct = m.slice(12, m.length - 16);
                    d.setAuthTag(m.slice(m.length - 16));
                    var plain = Buffer.concat([d.update(ct), d.final()]);
                    var cl = c.client;
                    try { sock.send(plain, cl.port, cl.address); } catch (e) { log('[pf] UDP(网关) 回投异常: ' + ((e && e.message) || e)); }
                } catch (e) { log('[pf] UDP(网关) 回包解密失败: ' + ((e && e.message) || e)); } // 网关可信端正常不发生，出现即记录
            });
            out.on('error', function () { /* 出站 socket 错误：静默，由空闲清扫/停止收口 */ });
            c.out = out;
            c.ready = true;
            log('[pf] UDP(网关) 会话就绪 ' + key + ' → 网关目标 ' + rule.remote_port + '（会话 ' + resp.session + '）');
            // flush 建立期间缓冲的游戏包（保持到达顺序逐包加密发送）
            var pend = c.pending;
            c.pending = [];
            pend.forEach(function (b) { gwUdpSend(c, b, gw); });
        }).catch(function (e) {
            fail((e && e.message) || '注册异常');
            try { ts.destroy(); } catch (e2) { }
        });
    }, function (e) {
        fail((e && e.message) || 'TLS 连接失败');
    });
}

// 会话密钥封包并经独立出站 socket 发往网关（客户端→网关方向 nonce = "C2G0"+counter）
function gwUdpSend(c, msg, gw) {
    try {
        c.tx++;
        var head = Buffer.alloc(12);
        head.writeUInt32BE(c.sessId >>> 0, 0);
        head.writeBigUInt64BE(BigInt(c.tx), 4);
        var nonce = Buffer.concat([Buffer.from(GW_NONCE_C2G, 'ascii'), head.slice(4, 12)]);
        var ci = crypto.createCipheriv('aes-256-gcm', c.k1, nonce);
        ci.setAAD(head);
        var sealed = Buffer.concat([ci.update(msg), ci.final(), ci.getAuthTag()]);
        c.out.send(Buffer.concat([head, sealed]), gw.port, gw.host, function (err) {
            if (err) log('[pf] UDP(网关) 发送失败: ' + err.message);
        });
    } catch (e) { log('[pf] UDP(网关) 封包异常: ' + ((e && e.message) || e)); }
}

// 停止单客户端会话（控制连接断开 → 网关侧会话同步回收）
function gwUdpClientTeardown(c) {
    c.ready = false;
    c.dead = true;
    if (c.ka) { clearInterval(c.ka); c.ka = null; }
    if (c.ctl) { try { c.ctl.destroy(); } catch (e) { } c.ctl = null; }
    if (c.out) { try { c.out.close(); } catch (e) { } c.out = null; }
}

function stopUdpGw(fw) {
    try { if (fw.sweep) clearInterval(fw.sweep); } catch (e) { }
    fw.clients.forEach(function (c) { gwUdpClientTeardown(c); });
    fw.clients.clear();
    try { fw.sock.close(); } catch (e) { }
}

// ----- start：tag 维度全量开启（all-or-nothing，任一失败回滚已开启项并返回首个错误） -----
// 规则来源（渲染层经 game:launch / local-game:launch payload 传入，主进程二次校验）：
//   上架游戏 = 管理端游戏配置 port_forwards；本地游戏 = 属性弹窗转发规则
function start(tag, rules, gwPack) {
    var v = validateRules(rules, gwPack);
    if (!v.ok) return Promise.resolve({ ok: false, err: v.err });
    if (v.rules.length === 0) return Promise.resolve({ ok: true, started: 0 });
    if (fwMap.has(tag)) stop(tag); // 幂等重启：同 tag 残留先收口（崩溃恢复/重复启动场景）
    var started = [];
    var jobs = v.rules.map(function (r) {
        // 按 mode 分发：空串=直连（现状语义）；gateway=经远程加密网关（TLS+AEAD），
        // 多网关部署下每规则按 @网关名 用各自的 gwConf（地址/指纹）建连
        var job;
        if (r.mode === 'gateway') {
            job = (r.proto === 'tcp') ? startTcpGw(r, r.gwConf) : startUdpGw(r, r.gwConf);
        } else {
            job = (r.proto === 'tcp') ? startTcp(r) : startUdp(r);
        }
        return job.then(function (res) {
            if (res.ok) started.push({ rule: r, fw: res.fw });
            return res;
        });
    });
    return Promise.all(jobs).then(function (results) {
        for (var i = 0; i < results.length; i++) {
            if (!results[i].ok) {
                // 回滚：已开启的先收口，不留半开状态
                started.forEach(function (s) { stopForwarder(s.fw); });
                log('[pf] ' + tag + ' 开启失败：' + results[i].err + '（已回滚 ' + started.length + ' 条）');
                return { ok: false, err: results[i].err };
            }
        }
        var forwards = new Map();
        started.forEach(function (s) {
            forwards.set(s.rule.proto + ':' + s.rule.listen, { rule: s.rule, fw: s.fw });
        });
        fwMap.set(tag, { forwards: forwards, rules: v.rules });
        var brief = v.rules.map(function (r) {
            var dst = (r.mode === 'gateway') ? ('网关' + (r.gw ? '@' + r.gw : '') + ':' + r.remote_port) : (r.remote_host + ':' + r.remote_port);
            return (r.mode === 'gateway' ? 'g' : '') + r.proto + ':' + r.listen + '→' + dst;
        }).join(' ');
        log('[pf] ' + tag + ' 开启 ' + v.rules.length + ' 条：' + brief);
        return { ok: true, started: v.rules.length };
    });
}

// forwarder 统一收口分发（direct/gateway 两模式资源形态不同）
function stopForwarder(fw) {
    if (fw.proto === 'tcp') {
        if (fw.mode === 'gateway') stopTcpGw(fw); else stopTcp(fw);
    } else {
        if (fw.mode === 'gateway') stopUdpGw(fw); else stopUdp(fw);
    }
}

// ----- stop：tag 维度收口（幂等；缺省 tag = 全部） -----
function stop(tag) {
    var entry = fwMap.get(tag);
    if (!entry) return 0;
    fwMap.delete(tag);
    var n = 0;
    entry.forwards.forEach(function (f) {
        n++;
        stopForwarder(f.fw);
    });
    log('[pf] ' + tag + ' 关闭 ' + n + ' 条转发');
    return n;
}

function stopAll() {
    var n = 0;
    var tags = [];
    fwMap.forEach(function (v, t) { tags.push(t); });
    tags.forEach(function (t) { n += stop(t); });
    return n;
}

// 运行态查询（调试/页面展示用）：[{tag, proto, listen, remote_host, remote_port}]
function list() {
    var out = [];
    fwMap.forEach(function (entry, tag) {
        entry.forwards.forEach(function (f) {
            out.push({
                tag: tag,
                proto: f.rule.proto,
                mode: f.rule.mode || 'direct',
                listen: f.rule.listen,
                remote_host: f.rule.remote_host,
                remote_port: f.rule.remote_port
            });
        });
    });
    return out;
}

function setLogger(fn) { logger = (typeof fn === 'function') ? fn : null; }

module.exports = { start: start, stop: stop, stopAll: stopAll, list: list, setLogger: setLogger, validateRules: validateRules };
