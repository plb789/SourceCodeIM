// game-mdns.js - 星际争霸重制版（SC:R）LAN 发现适配：mDNS 反射器（主进程）
//
// 校准依据：docs/星际争霸重制版LAN发现协议校准.md（2026-10-17 双机 pktmon 实测）
//
// SC:R 的 LAN 发现/房间通告走 DNS-SD/mDNS（224.0.0.251:5353）：房主端 SC:R 自行应答浏览查询
// （PTR/_blizzard 66号记录/TXT/SRV/A，内容含原始房间名/人数/guid，protobuf 属性块）。
// 本代理做「反射器」：
//   房主端：捕获本机 SC:R 的 _blizzard 应答帧 → 原样 hex 经既有中继链
//           （gn-broadcast-gi → 渲染层 → ctl 通道）发加入方。
//           跨网生命线——探测激发：跨网后加入端浏览查询到不了本机游戏，而游戏仅建房时主动通告
//           数秒后静默（Bonjour 语义，实测），纯被动监听永远无帧可中继；故在观测到本机游戏应答
//           （建房完成，避开公布窗口）后周期发 PTR 查询激发应答（30s 无应答自停）。
//           ⚠ 探测若在建房公布窗口内运行会干扰公布致「无法公布此游戏[错误5:9]」（实测）——
//           全程禁止发布前探测
//   加入方：同网/跨网自适应，以「原生通告是否可达」这一实测事实为准（不依赖登记 IP——
//           多网卡机器的登记口常非联机口，子网判定曾致误判）：
//     原生在场（观测到含本会话 guid、来源非本机的原生应答）：全程静默——原生直连。
//       注入记录与原生记录同实例不同 rdata，SC:R 判冲突拒加入（实测根因）；
//     原生缺席（首包中继后宽限 6s 仍未观测到）：注入补丁记录（组播）+ 应答本机查询，引导本机
//       游戏连隧道。应答/注入统一延后到宽限期满（宽限期内只听不说，杜绝同网污染）。
// 投递机制实测（Windows 2026-10-18 本机微测）：组播=组内成员套接字各得副本（唯一能送达游戏的通道）；
//   单播/回环单播在 SO_REUSEADDR 多绑定下由「先绑定者」独收——反射器先于游戏绑定 5353，
//   单播永远被本代理自收、游戏收不到——旧「回环投递」方案失效（房间列表消失）的实证根因。
// 记录内容与原生局域网逐字节一致（仅 6 字节地址/端口不同）——不合成任何 protobuf，
// 原始房间名/人数/guid 全保留（合成属性块曾致 SC:R 解析崩溃，实测）。
//
// 数据面：SC:R 房间协商/对局为 UDP 6112 protobuf 直连（帧内无地址，地址无关性已静态验证），
// 加入方 SC:R 按 SRV/A 连接 127.0.0.1:<隧道端口> → 命中现有隧道 → DataChannel → 房主 SC:R:6112。

const udp = require('dgram');
const os = require('os');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const BLIZZARD_MARK = Buffer.from([0x09, 0x5f, 0x62, 0x6c, 0x69, 0x7a, 0x7a, 0x61, 0x72, 0x64]); // 线格式标签：09"_blizzard"（DNS 名有长度字节，连续域名文本不存在于线上）
const SEL_STARE = '_stare9._sub._blizzard._udp.local';  // SC:R 浏览选择器（探测激发查询目标）
const REANNOUNCE_MS = 5000;                             // 加入方缓存重通告周期
// A/AAAA 记录的注入目标：127.0.0.2（Windows 127/8 全段回环，数据包同样到达 0.0.0.0:6113 隧道）。
// 不能用 127.0.0.1 或本机网卡 IP——SC:R 点加入时做自连检查（目标 IP ∈ 本机地址即拒绝，
// 防止加入自己的房间，实测 03:22/03:31/03:48/04:07 四轮零数据包失败），127.0.0.2 不在
// 常规本机地址列表内可绕开检查；此前曾用本机出口 IP（源一致性）亦被该检查拦截
const LOOPBACK_ALIAS = '127.0.0.2';
const NATIVE_GRACE_MS = 6000;                           // 原生通告观测宽限：首包中继后等这么久仍无原生应答，才开始本地注入
// 房主端探测激发（跨网生命线）：加入端浏览查询跨网到不了本机游戏，游戏仅建房时主动通告数秒后
// 归于静默（Bonjour 语义，实测）——纯被动监听跨网永远无帧可中继（实测跨网列表空）。
// 观测到本机游戏应答（=建房已完成，避开公布窗口：探测若在公布期运行会干扰致[错误5:9]，实测）
// 后才启动周期探测激发应答；30s 无应答自动停止（房间已关，探测不跨越下一次建房公布窗口）
const PROBE_MS = 4000;
const PROBE_IDLE_MS = 30000;
const MEMB_REFRESH_MS = 30000;                          // 组播成员刷新周期（接口/网络切换自愈，如以太网→热点）

function MdnsReflector() {
    this.rooms = new Map();   // room_id → 会话
    this.tunnel = null;       // game-tunnel 注入（取数据面实际端口）
    this.sock = null;         // 5353 套接字（懒绑定，多房间共用；房主/加入方角色复用）
    this.log = function (msg) { console.log('[game-mdns] ' + msg); };
}

MdnsReflector.prototype.setLogger = function (fn) { if (typeof fn === 'function') this.log = fn; };
MdnsReflector.prototype.setTunnel = function (t) { this.tunnel = t; };

// 数据面端口：隧道实际绑定端口（顺延后），兜底用房间声明端口
MdnsReflector.prototype.dataPort = function (roomId, fallback) {
    try {
        if (this.tunnel && typeof this.tunnel.dataPortOf === 'function') {
            var p = this.tunnel.dataPortOf(roomId) | 0;
            if (p) return p;
        }
    } catch (e) { }
    return fallback | 0;
};

// ---------- DNS 轻量遍历（压缩感知）：逐记录回调，支持原地补丁 ----------
// 区分 question（名+类型+类别，无 ttl/rdlen）与 answer 记录——真实通告会回显问题区，
// 混合解析会走位 derail 导致补丁失效（实测修正）
// 畸形/截断尾部：边界防护直接终止遍历（已遍历的记录补丁仍然生效）
function forEachRecord(pkt, cb) {
    const qd = pkt.readUInt16BE(4), an = pkt.readUInt16BE(6), ns = pkt.readUInt16BE(8), ar = pkt.readUInt16BE(10);
    let o = 12;
    function skipName(p) {
        let guard = 0;
        while (p < pkt.length && guard++ < 40) {
            const len = pkt[p];
            if (len === 0) return p + 1;
            if ((len & 0xC0) === 0xC0) { if (p + 2 > pkt.length) return pkt.length; return p + 2; }
            p += 1 + len;
        }
        return p;
    }
    const sections = [[qd, false], [an, true], [ns, true], [ar, true]];
    for (const [n, isAns] of sections) {
        for (let i = 0; i < n; i++) {
            if (o + 4 > pkt.length) return;
            const nameStart = o; // 记录所有者名起始偏移（实例名提取用）
            const nameEnd = skipName(o);
            if (nameEnd + 4 > pkt.length) return;
            const t = pkt.readUInt16BE(nameEnd);
            const cls = pkt.readUInt16BE(nameEnd + 2);
            o = nameEnd + 4; // type(2)+class(2)
            if (!isAns) continue; // question 区：仅名+类型+类别
            o += 4; // ttl(4)
            const rl = pkt.readUInt16BE(o); o += 2;
            if (o + rl > pkt.length) return;
            const rd = pkt.slice(o, o + rl);
            if (cb) cb(t, cls, rd, o, nameStart);
            o += rl;
        }
    }
}

// 加入方补丁：66 号记录 lobby_info 端点端口 → 隧道端口（原地同长度改写）+ SRV/A 兜底。
// 被通告端口从**包内**读取（"0.0.0.0:<端口>"），不依赖房间登记端口——开局实测回填会让
// 房间 host_port 漂移到 SC:R 动态口（实测 6112→56159），按登记端口查找会失配失效
MdnsReflector.prototype.patchPacket = function (roomId, pkt) {
    const port = this.dataPort(roomId, 0);
    if (!port) return null;
    const out = Buffer.from(pkt);
    const portStr = String(port);
    const sess = this.rooms.get(roomId); // 方法作用域取会话（回调内 this 非本实例——曾致补丁抛异常房间消失）
    const hv = sess && sess.hostIPv4;
    try {
        forEachRecord(out, function (t, cls, rd, rdOff) {
            if (t === 33 && rd.length >= 6) {           // SRV：端口 → 隧道数据端口
                out[rdOff + 4] = (port >> 8) & 0xFF;
                out[rdOff + 5] = port & 0xFF;
            } else if (t === 28 && rd.length === 16) {  // AAAA → IPv4-mapped 房主真实 IPv4：
                // 房主通告携带其真实 IPv6（公网+链路本地），游戏优先 IPv6 → 跨网连接房主 IPv6
                // 瞬时失败（无路由，一个包都发不出）→「无法加入」（实测 03:58 抓包：6113 零流量）。
                // 原地改写为 ::ffff:<房主IPv4>（16 字节等长）：非本机地址可过游戏自连检查（防止
                // 加入自己房间的本机地址校验，127.0.0.1/本机 IP 均被静默拒绝——实测多轮），
                // 双栈游戏映射回 IPv4；跨网配合本机路由（hostIP→127.0.0.1）落入隧道，同网直连房主
                if (hv && /^\d+\.\d+\.\d+\.\d+$/.test(hv)) {
                    const parts = hv.split('.');
                    for (let i = 0; i < 10; i++) out[rdOff + i] = 0;
                    out[rdOff + 10] = 0xFF; out[rdOff + 11] = 0xFF;
                    for (let i = 0; i < 4; i++) out[rdOff + 12 + i] = parseInt(parts[i], 10) & 0xFF;
                }
            } else if (t === 66) {                      // 66：lobby_info 端点（"0.0.0.0:6112" 或
                // "192.168.1.15:57623" 等格式——实测 03:58 抓包后者，端口为房主游戏动态口）：
                // 端口统一改写为隧道端口（右对齐补零同长改写："57623"→"06113" 数值解析不变、
                // "6112"→"6113"）——按 "0.0.0.0:" 前缀匹配会漏补真实 IP 格式，游戏连动态口
                // 跨网不可达致加入失败
                for (let ci = rd.indexOf(0x3A); ci !== -1; ci = rd.indexOf(0x3A, ci + 1)) { // ':'
                    let s = ci + 1, e = s;
                    while (e < rd.length && rd[e] >= 0x30 && rd[e] <= 0x39) e++;
                    const dlen = e - s;
                    if (dlen === 0 || dlen > 5 || portStr.length > dlen) continue;
                    const pstr = portStr.length < dlen ? (new Array(dlen - portStr.length + 1).join('0') + portStr) : portStr;
                    if (rd.slice(s, e).toString('ascii') !== pstr) {
                        Buffer.from(pstr, 'ascii').copy(rd, s); // rd 是 out 的视图，写穿
                    }
                }
            }
        });
    } catch (e) {
        this.log('补丁异常：' + ((e && e.stack) || e));
        return null;
    }
    return out;
};

// ---------- 套接字 ----------
MdnsReflector.prototype.ensureSocket = function () {
    if (this.sock) return true;
    const self = this;
    try {
        this.sock = udp.createSocket({ type: 'udp4', reuseAddr: true });
        this.sock.on('error', function (e) {
            self.log('mDNS 套接字错误：' + ((e && e.message) || ''));
            try { self.sock.close(); } catch (e2) { }
            self.sock = null;
        });
        this.sock.on('message', function (msg, rinfo) { self.onMessage(msg, rinfo); });
        this.sock.bind(MDNS_PORT, function () {
            try { self.sock.setMulticastTTL(255); } catch (e) { }
            self.refreshMemberships(true);
            // 接口/网络切换自愈（网线插拔、以太网→热点）：周期重加组播成员（幂等）
            if (!self.membTimer) {
                self.membTimer = setInterval(function () { self.refreshMemberships(false); }, MEMB_REFRESH_MS);
            }
            self.log('mDNS 套接字就绪（5353 已在全部 IPv4 接口加入组播）');
        });
        return true;
    } catch (e) {
        this.log('mDNS 套接字创建失败：' + ((e && e.message) || ''));
        this.sock = null;
        return false;
    }
};

// 组播成员按全部 IPv4 接口加入——缺省只加「绑定时刻的默认接口」，此后接口切换（如以太网→手机
// 热点）成员关系随旧接口失效，本机游戏经新接口发的通告/查询全部收不到（实测跨网测试根因）。
// 同套接字对多接口重复加组合法且幂等（IP_ADD_MEMBERSHIP 按接口生效）
MdnsReflector.prototype.refreshMemberships = function (forceLog) {
    if (!this.sock) return 0;
    let count = 0;
    try {
        const ifs = os.networkInterfaces();
        for (const k in ifs) {
            const arr = ifs[k] || [];
            for (let i = 0; i < arr.length; i++) {
                const a = arr[i];
                if (!a || a.family !== 'IPv4' || !a.address || a.internal) continue;
                try { this.sock.addMembership(MDNS_GROUP, a.address); count++; } catch (e) { }
            }
        }
    } catch (e) { }
    if (count && (forceLog || count !== this.lastMembCount)) {
        this.lastMembCount = count;
        this.log('组播成员：' + count + ' 个 IPv4 接口已加入 ' + MDNS_GROUP);
    }
    return count;
};

MdnsReflector.prototype.send = function (buf) {
    if (!this.sock) return;
    try { this.sock.send(buf, MDNS_PORT, MDNS_GROUP); } catch (e) { }
};

// ---------- 收包分流 ----------
// 解析报文首条 question（名 + 类型）：SC:R 的 SRV/A 解析查询识别用
function parseQuestion(msg) {
    try {
        if (msg.length < 13) return null;
        const qd = msg.readUInt16BE(4);
        if (qd < 1) return null;
        let o = 12;
        const labels = [];
        const qs = o; // 问题名起始偏移（线格式字节对比用）
        for (;;) {
            const len = msg[o];
            if (len === 0) { o++; break; }
            if ((len & 0xC0) === 0xC0) { o += 2; break; } // 压缩指针（查询报文罕见，容错）
            if (o + 1 + len > msg.length) return null;
            labels.push(msg.slice(o + 1, o + 1 + len).toString('ascii'));
            o += 1 + len;
        }
        const qe = o; // 问题名结束偏移（含终止 0 或指针）
        if (o + 4 > msg.length) return null;
        const qtype = msg.readUInt16BE(o);
        return { name: labels.join('.'), qtype, srvOrA: qtype === 33 || qtype === 1, qs, qe };
    } catch (e) { return null; }
}
// 合成 SRV/A 应答：SRV → port（隧道数据面），A → 127.0.0.2
// owner 名直通查询报文中的原始线格式字节——经 ascii 字符串中转会丢失高位字节（中文角色名
// UTF-8），应答名与查询名不一致会被游戏忽略（实测 03:22:33 SRV 应答被弃、03:23:59 换名重试）。
// opts：{id, question, legacy}——遗留查询（OS 解析器等，源端口非 5353）须回显事务 ID 与问题区、
// 单播回源、TTL≤10s（RFC 6762 §6.7）；组播 id=0 应答会被解析器丢弃（实测点加入窗体无响应数秒
// 后「无法加入」= 解析器阻塞超时）
function buildSrvAResp(nameWire, port, qtype, opts) {
    opts = opts || {};
    const ttl = opts.legacy ? 10 : 120;
    const nameBuf = nameWire;
    const tgtBuf = dnsNameWire('im-scr.local');
    const h = Buffer.alloc(12);
    h.writeUInt16BE(opts.id || 0, 0);
    h.writeUInt16BE(0x8400, 2);
    h.writeUInt16BE(opts.question ? 1 : 0, 4);
    const recs = [];
    if (!opts.nodata) {
        if (qtype === 33) { // SRV
            const rd = Buffer.alloc(6);
            rd.writeUInt16BE(0, 0); rd.writeUInt16BE(0, 2); rd.writeUInt16BE(port, 4);
            recs.push({ name: nameBuf, type: 33, rdata: Buffer.concat([rd, tgtBuf]), flush: true, ttl: ttl });
        }
        // A → 房主真实 IPv4（非本机地址，过游戏自连检查；跨网配合本机路由进隧道）
        let aRec = [127, 0, 0, 2];
        if (opts.hostIPv4 && /^\d+\.\d+\.\d+\.\d+$/.test(opts.hostIPv4)) {
            const p = opts.hostIPv4.split('.');
            aRec = [+p[0], +p[1], +p[2], +p[3]];
        }
        recs.push({ name: tgtBuf, type: 1, rdata: Buffer.from(aRec), flush: true, ttl: ttl });
    }
    h.writeUInt16BE(recs.length, 6); // ancount
    const parts = [h];
    for (const r of recs) {
        const rdlen = Buffer.alloc(2); rdlen.writeUInt16BE(r.rdata.length, 0);
        const ttl = Buffer.alloc(4); ttl.writeUInt32BE(r.ttl, 0);
        const cls = Buffer.alloc(2); cls.writeUInt16BE(r.flush ? 0x8001 : 0x0001, 0);
        const type = Buffer.alloc(2); type.writeUInt16BE(r.type, 0);
        parts.push(r.name, type, cls, ttl, rdlen, r.rdata);
    }
    return Buffer.concat(parts);
}
function dnsNameWire(name) {
    const out = [];
    for (const label of String(name).split('.')) {
        if (!label) continue;
        const b = Buffer.from(label, 'ascii');
        out.push(b.length, ...b);
    }
    out.push(0);
    return Buffer.from(out);
}
// PTR 浏览查询包（房主端探测激发用）：与游戏列表浏览查询同格式（标准 question，非响应）。
// 实测本机游戏对该查询正常应答（51B/173B，源 :5353），同机来源不拒绝
function buildProbeQuery() {
    const h = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    return Buffer.concat([h, dnsNameWire(SEL_STARE), Buffer.from([0, 12, 0, 1])]);
}

// 房主端探测激发管理：观测到本机游戏应答 → 启动周期探测（激发后续应答供持续中继/状态更新）；
// 30s 无应答 → 自动停止（房间应已关闭，探测不跨越下一次建房公布窗口，规避[错误5:9]）
MdnsReflector.prototype.noteGameResp = function (roomId) {
    this.lastRespAt = Date.now();
    if (this.probeTimer) return;
    const self = this;
    const q = buildProbeQuery();
    this.probeTimer = setInterval(function () {
        if (!self.sock || Date.now() - (self.lastRespAt || 0) > PROBE_IDLE_MS) {
            clearInterval(self.probeTimer); self.probeTimer = null;
            self.log('发现探测已停止（' + (PROBE_IDLE_MS / 1000) + 's 无本机游戏应答，房间应已关闭）');
            return;
        }
        try { self.sock.send(q, MDNS_PORT, MDNS_GROUP); } catch (e) { }
    }, PROBE_MS);
    this.log('发现探测已启用（' + (PROBE_MS / 1000) + 's 周期 PTR 查询激发本机游戏应答）：房间 ' + roomId);
};

MdnsReflector.prototype.onMessage = function (msg, rinfo) {
    if (msg.length < 12) return;
    const flags = msg.readUInt16BE(2);
    const isResp = !!(flags & 0x8000);
    for (const [roomId, sess] of this.rooms) {
        if (sess.role === 'host') {
            // 房主端：捕获本机 SC:R 的 _blizzard 应答帧 → 中继给加入方
            if (isResp && msg.indexOf(BLIZZARD_MARK) !== -1) {
                this.noteGameResp(roomId); // 应答观测：房间存活证据 + 探测激发启停归口
                const hex = msg.toString('hex');
                if (hex !== sess.lastRelayHex) {
                    sess.lastRelayHex = hex;
                    if (this.relayHandler) { try { this.relayHandler(roomId, hex); } catch (e) { } } // 反射器实例的 handler（会话对象上不存在——曾致中继静默跳过）
                    if (!sess.logged) { sess.logged = true; this.log('已捕获房主 SC:R 通告（' + msg.length + 'B）并中继：房间 ' + roomId); }
                }
            }
        } else {
            // 本机游戏自身实例登记（防自名冲突污染判据）：仅注入启动前的本地来源 _blizzard
            // 应答帧——注入启动后本地应答与注入回环副本不可区分，停止登记
            if (isResp && !sess.injectArmedAt && !sess.ownInstWire && isLocalSource(rinfo.address) && msg.indexOf(BLIZZARD_MARK) !== -1) {
                const own = extractInstanceName(msg);
                if (own) sess.ownInstWire = own.wire;
            }
            // 原生通告观测（同网/跨网自适应判据，以实测事实为准，不依赖登记 IP）：
            // 房主游戏的原生 mDNS 应答（含本会话 guid、来源非本机）= 原生直连路径可达。
            // 一旦观测到即全程静默：注入记录与原生记录同实例不同 rdata，SC:R 判冲突拒加入（实测根因）；
            // 早前已注入的少量记录由原生重通告（约 4s 周期，cache-flush）自然覆盖清除。
            // 自源过滤：注入包的组播回环副本源=本机 IP，不得计为「原生通告」
            if (isResp && !sess.nativeSeen && sess.guidBuf && !isLocalSource(rinfo.address) && msg.indexOf(sess.guidBuf) !== -1) {
                sess.nativeSeen = Date.now();
                this.log('检测到房主原生通告（来源 ' + rinfo.address + '）：原生直连模式，发现引导静默（房间 ' + roomId + '）');
            }
            if (!isResp && sess.cache && !sess.nativeSeen) {
                const q = parseQuestion(msg);
                // 本机查询观测（联机排障）：每种 qtype+name 首次出现记一条，看加入点击时客户端实际发了什么查询
                if (q) {
                    if (!sess.qlog) sess.qlog = {};
                    const qk = q.qtype + '|' + q.name;
                    if (!sess.qlog[qk]) {
                        sess.qlog[qk] = 1;
                        this.log('本机查询 qtype=' + q.qtype + ' name=' + q.name + '（房间 ' + roomId + '）');
                    }
                }
                // 应答/注入统一延后到观测宽限期满：宽限期内只听不说——原生在场则零注入零应答，
                // 杜绝同网场景下补丁记录污染原生记录（含对房主探测查询的应答回灌）
                if (!sess.injectArmedAt || Date.now() - sess.injectArmedAt < NATIVE_GRACE_MS) return;
                const isBrowseQ = q && q.qtype === 12 && msg.indexOf(BLIZZARD_MARK) !== -1;
                // 实例级查询应答门控（排除自身语义）：游戏只对它见过的实例发解析查询，非本机
                // 游戏自身实例即目标实例（房主）。此前按缓存实例名精确匹配（字符串/线格式字节
                // 两条路径）——实例名含非 ASCII 字节（中文角色名 UTF-8），两条路径都曾实测失配
                // （02:47:40 ANY 查询既未应答也未触发诊断），改为「排除自身」语义彻底绕开
                const qlower = q ? String(q.name || '').toLowerCase() : '';
                // 实例查询识别：pnm: 前缀 + _udp.local 后缀（放宽到不含 _blizzard 标签的变体——
                // 实测 03:23:59 重试查询名为 PNM:e8eblizzard._udp.local，标签结构与常规形式不同）
                const isPnmQ = qlower.indexOf('pnm:') === 0 && qlower.indexOf('_udp.local') !== -1;
                const isOwnQ = !!(isPnmQ && sess.ownInstWire && q && q.qs != null &&
                    q.qe - q.qs === sess.ownInstWire.length && wireNameEq(msg.slice(q.qs, q.qe), sess.ownInstWire));
                if (isOwnQ && !sess.ownLogged) {
                    sess.ownLogged = true;
                    this.log('自身实例查询（qtype=' + q.qtype + '），跳过应答（防自名冲突污染）');
                }
                // 实例解析任意类型（255/33/66/16…）：66 为暴雪私有记录专项查询（实测加入路径出现），
                // 无应答会让游戏多等一个重试周期——统一用缓存应答（含全量记录，附加记录合法）
                const isInstQ = isPnmQ && !isOwnQ;
                // A/AAAA 查询门控：本代理合成目标 im-scr.local + 缓存内 SRV 目标主机名（房主机
                // Bonjour 主机名，实测 03:08:47/03:22:33 DESKTOP-CHJBE0U.local）——都指向 127.0.0.2
                const isAQ = !!(q && (q.qtype === 1 || q.qtype === 28) && (
                    /^im-scr\.local$/i.test(q.name) ||
                    (sess.srvTargets.length && q.qs != null && sess.srvTargets.some(function (t) {
                        return q.qe - q.qs === t.wire.length && wireNameEq(msg.slice(q.qs, q.qe), t.wire);
                    }))));
                // 遗留查询识别（源端口非 5353 = OS 解析器等）：应答必须单播回源 + 回显事务 ID 与
                // 问题区 + TTL≤10s（RFC 6762 §6.7）——组播 id=0 应答会被解析器丢弃。实测游戏点加入
                // 走阻塞式解析（窗体无响应数秒 = 解析器超时）查询 SRV 目标主机名，此为加入关键路径
                const legacyQ = rinfo.port !== MDNS_PORT;
                const legacyOpts = legacyQ ? {
                    id: msg.readUInt16BE(0),
                    question: (q && q.qs != null) ? msg.slice(12, q.qe + 4) : null,
                    legacy: true
                } : {};
                if (isBrowseQ || isInstQ) {
                    // 选择器 PTR 浏览查询 / 实例解析查询（任意类型，实测 255/66）
                    // → 缓存通告（A/SRV/66 端点均已补丁）——仅组播口径（遗留查询走下方合成路径）
                    if (!legacyQ) { try { this.sock.send(sess.cache, MDNS_PORT, MDNS_GROUP); } catch (e) { } }
                }
                if (isInstQ || isAQ) {
                    // 补充合成 SRV/A：指向房主真实 IPv4（非本机地址过自连检查）。遗留查询：单播回源
                    // + ID/问题区回显；AAAA 查询回 NODATA（引导解析器采用 A 记录）。跨网时配合本机
                    // 路由（hostIP→127.0.0.1）把发往房主 IP 的包落进隧道；同网直接原生直连
                    const port = this.tunnel && typeof this.tunnel.dataPortOf === 'function' ? (this.tunnel.dataPortOf(roomId) | 0) : 0;
                    if (legacyQ) {
                        const nameWire = inlineNameWire(msg, q.qs, q.qe) || dnsNameWire(q.name);
                        const isAAAAQ = q.qtype === 28;
                        const resp = buildSrvAResp(nameWire, port || 6113, isAAAAQ ? 1 : q.qtype,
                            Object.assign({ nodata: isAAAAQ, hostIPv4: sess.hostIPv4 }, legacyOpts));
                        try { this.sock.send(resp, rinfo.port, rinfo.address); } catch (e) { }
                        if (!sess.srvLogged) {
                            sess.srvLogged = true;
                            this.log('已应答本机实例解析（遗留单播 ' + q.name + ' type=' + q.qtype + ' → ' + (sess.hostIPv4 || '127.0.0.2') + ':' + (port || 6113) + (isAAAAQ ? ' NODATA' : '') + '）：房间 ' + roomId);
                        }
                    } else if (port) {
                        const nameWire = inlineNameWire(msg, q.qs, q.qe) || dnsNameWire(q.name);
                        const resp = buildSrvAResp(nameWire, port, 33, { hostIPv4: sess.hostIPv4 });
                        try { this.sock.send(resp, MDNS_PORT, MDNS_GROUP); } catch (e) { }
                        if (!sess.srvLogged) { sess.srvLogged = true; this.log('已应答本机实例解析（' + q.name + ' → ' + (sess.hostIPv4 || '127.0.0.2') + ':' + port + '）：房间 ' + roomId); }
                    }
                }
                // 其余类型查询不应答——原生在场时真实主机应答直达，不得抢先/干扰
            }
        }
    }
};

// ---------- 生命周期 ----------
// args = {room_id, game:'scr', port, role, game_name, host_name, slots_used, slots_total}
// game_name/host_name/人数：仅日志参考——记录内容全部来自房主端原始应答（反射，不合成）
MdnsReflector.prototype.start = function (args) {
    const a = args || {};
    const roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    const role = a.role === 'host' ? 'host' : 'join';
    const old = this.rooms.get(roomId);
    const sess = {
        roomId, role,
        port: a.port | 0,
        gameName: String(a.game_name || ''),
        cache: null, cacheAt: 0, ownInstWire: null, srvTargets: [], hostIPv4: '',
        nativeSeen: 0, injectArmedAt: 0,
        probeTimer: null, reannTimer: null,
        relayHandler: null, lastRelayHex: '', logged: false
    };
    this.rooms.set(roomId, sess);
    this.log('SC:R 发现反射器已启动（' + (old ? '重启' : '新会话') + '）：房间 ' + roomId + ' 角色 ' + role);
    if (!this.ensureSocket()) return { ok: false, err: 'socket_fail' };

    const self = this;
    if (role === 'host') {
        // 房主端：纯被动监听——建主后的 SC:R 周期性（约 4s）主动组播通告（实测 214B/465B，
        // 含端点 "0.0.0.0:6112"），onMessage 捕获并中继即可。
        // 不发探测查询：探测帧会在游戏公布（创建游戏）时干扰其 mDNS 栈，实测致
        // 「无法公布此游戏…[错误 5:9]」（公布失败）——查询激发方案废弃
    } else {
        // 加入方：同网/跨网自适应（判据=原生通告实测可达性，不依赖登记 IP：多网卡机器的登记口
        // 常非联机口，子网判定曾致误判）。首包中继后先宽限观测；观测到原生 → 全程静默（原生直连，
        // 注入会与原生记录同实例冲突，实测拒加入）；未观测到 → 本地注入引导连隧道
        if (a.host_ip) this.log('发现引导（加入方）：房主登记 IP=' + a.host_ip + '（仅诊断参考，不作判定依据）');
        sess.reannTimer = setInterval(function () {
            if (!sess.cache || sess.nativeSeen) return; // 原生在场：静默（原生直连）
            if (!sess.injectArmedAt || Date.now() - sess.injectArmedAt < NATIVE_GRACE_MS) return; // 观测宽限期内不注入
            try { self.sock.send(sess.cache, MDNS_PORT, MDNS_GROUP); } catch (e) { }
            if (!sess.injLogged) { sess.injLogged = true; self.log('原生通告未观测到：开始本地注入（组播，仅本机网段可见）——房间 ' + roomId); }
        }, REANNOUNCE_MS);
    }
    return { ok: true };
};

// 房主端中继出口注入（main：→ gn-broadcast-gi → 渲染层 → ctl 通道 → 加入方）
MdnsReflector.prototype.setRelayHandler = function (fn) { if (typeof fn === 'function') this.relayHandler = fn; };
// 房间路由判定：该房间是否为 SC:R 反射会话（main 据此分流中继帧）
MdnsReflector.prototype.has = function (roomId) { return this.rooms.has(String(roomId || '').trim()); };

// 加入端接收房主端中继的原始 mDNS 应答包（hex）→ 提取判据 → 补丁缓存 →（原生缺席时）组播注入
MdnsReflector.prototype.relayPacket = function (roomId, hex) {
    const sess = this.rooms.get(roomId);
    if (!sess || sess.role !== 'join' || !hex) return { ok: false, err: 'no_sess' };
    const pkt = Buffer.from(hex, 'hex');
    if (pkt.length < 12) return { ok: false, err: 'bad_pkt' };
    if (!sess.guidBuf) {
        const g = extractGuid(pkt); // 实例 guid（会话级稳定）：原生通告观测判据
        if (g) sess.guidBuf = g;
    }
    // 房主真实 IPv4 登记（通告内 A 记录原值）：A 记录不再改写（保留房主真实 IP——非本机地址
    // 可过游戏自连检查），AAAA 映射与合成应答都以它为目标
    if (!sess.hostIPv4) {
        forEachRecord(pkt, function (t, cls, rd) {
            if (!sess.hostIPv4 && t === 1 && rd.length === 4) {
                sess.hostIPv4 = rd[0] + '.' + rd[1] + '.' + rd[2] + '.' + rd[3];
            }
        });
    }
    // SRV 目标主机名登记（加入路径 A 查询应答依据）：房主部分通告帧含 SRV（目标=房主机
    // Bonjour 主机名，端口已补丁），游戏点加入后查询该主机名的 A 记录（实测 03:08:47
    // DESKTOP-CHJBE0U.local），未应答则游戏拿不到连接 IP 加入失败
    if (sess.srvTargets.length < 4) extractSrvTargets(pkt, sess.srvTargets);
    // 原生在场：全程静默——原生直连可达，注入记录会与原生记录同实例不同 rdata（实测判冲突拒加入）
    if (sess.nativeSeen) return { ok: true, silent: true };
    if (!sess.injectArmedAt) {
        sess.injectArmedAt = Date.now();
        this.log('发现引导待观测：等待原生通告 ' + (NATIVE_GRACE_MS / 1000) + 's（房间 ' + roomId + '）');
    }
    // 纯反射（不做任何补丁）：字节级原样透传房主原始记录（真实 IPv4/IPv6/端口全保留）。
    // 补丁路线（A/AAAA/SRV/端点改写为本机目标）已被实测全数否决：SC:R 点加入时做自连检查
    // （目标 IP ∈ 本机地址即静默拒绝，127.0.0.1/127.0.0.2/本机网卡 IP/回环绑定 IP 均命中——
    // 实测 4 轮零数据包），且非本机 IP 在 Windows 上无法投递进本机隧道（on-link 路由实测不达）。
    // 游戏数据路径回归原生：同网 IPv4/跨网 IPv6（加入方需有 IPv6，热点普遍支持）直连房主，
    // 反射器只承担发现职责
    const patched = pkt;
    sess.cache = patched;
    sess.cacheAt = Date.now();
    // 观测宽限期内只缓存不注入：给原生通告留观测窗（原生健康则零注入、零冲突）
    if (Date.now() - sess.injectArmedAt < NATIVE_GRACE_MS) return { ok: true, deferred: true };
    try { this.sock.send(patched, MDNS_PORT, MDNS_GROUP); } catch (e) { } // 组播注入（实测唯一能送达游戏的通道）
    return { ok: true };
};

// 从 66 号记录 protobuf 属性块提取 guid 值：定位 'guid' 字段名 → 0x12 <len> <value>
function extractGuid(pkt) {
    try {
        const mark = Buffer.from('guid', 'ascii');
        let i = pkt.indexOf(mark);
        while (i !== -1) {
            let j = i + 4;
            while (j < pkt.length && pkt[j] !== 0x12) j++;
            if (j + 2 <= pkt.length) {
                const len = pkt[j + 1];
                if (len > 0 && len < 64 && j + 2 + len <= pkt.length) return pkt.slice(j + 2, j + 2 + len);
            }
            i = pkt.indexOf(mark, i + 4);
        }
    } catch (e) { }
    return null;
}

// ---------- 本机地址集（自源过滤）：注入包的组播回环副本源=本机 IP，不得计为「原生通告」 ----------
var localIpSet = null, localIpAt = 0;
function isLocalSource(ip) {
    var t = Date.now();
    if (!localIpSet || t - localIpAt > 60000) {
        var s = { '127.0.0.1': true };
        try {
            var ifs = os.networkInterfaces();
            for (var k in ifs) {
                var arr = ifs[k] || [];
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i] && arr[i].family === 'IPv4' && arr[i].address) s[arr[i].address] = true;
                }
            }
        } catch (e) { }
        localIpSet = s; localIpAt = t;
    }
    return !!localIpSet[ip];
}

// DNS 名解码（支持压缩指针）：返回点分小写 ascii 串 + 未压缩线格式字节。
// 线格式字节用于实例名精确对比——实例名含非 ASCII 字节（中文角色名 UTF-8），ascii 截断后的
// 字符串对比曾实测失配，字节层对比绕开一切编码问题
function wireNameAt(pkt, off) {
    const labels = [];
    const wire = [];
    let p = off, guard = 0;
    while (p < pkt.length && guard++ < 60) {
        const len = pkt[p];
        if (len === 0) { wire.push(0); break; }
        if ((len & 0xC0) === 0xC0) {
            if (p + 2 > pkt.length) return null;
            const ptr = ((len & 0x3F) << 8) | pkt[p + 1];
            if (ptr >= pkt.length) return null;
            p = ptr; continue;
        }
        if (p + 1 + len > pkt.length) return null;
        labels.push(pkt.slice(p + 1, p + 1 + len).toString('ascii'));
        wire.push(len);
        for (let i = 0; i < len; i++) wire.push(pkt[p + 1 + i]);
        p += 1 + len;
    }
    return { str: labels.join('.').toLowerCase(), wire: Buffer.from(wire) };
}

// 校验并取出查询报文中内联（未压缩）的名字线格式字节：应答 owner 名直通用
function inlineNameWire(msg, qs, qe) {
    if (qs == null || qe == null || qe - qs < 2) return null;
    if (msg[qe - 1] !== 0) return null; // 名字必须以内联 0 结尾（指针形式不适用）
    let p = qs;
    while (p < qe - 1) {
        const len = msg[p];
        if (len === 0 || (len & 0xC0) !== 0) return null;
        if (p + 1 + len > qe - 1) return null;
        p += 1 + len;
    }
    return msg.slice(qs, qe);
}

// 线格式名字节对比（大小写不敏感：DNS 名不区分大小写）
function wireNameEq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        let x = a[i], y = b[i];
        if (x >= 65 && x <= 90) x += 32;
        if (y >= 65 && y <= 90) y += 32;
        if (x !== y) return false;
    }
    return true;
}

// 从通告包提取 SRV 目标主机名（去重，上限 4 个）：rdata = priority(2)+weight(2)+port(2)+target 名。
// 仅收 .local 单标签主机名（排除本代理合成目标 im-scr.local）
function extractSrvTargets(pkt, out) {
    try {
        forEachRecord(pkt, function (t, cls, rd, rdOff) {
            if (t !== 33 || rd.length < 7 || out.length >= 4) return;
            const tgt = wireNameAt(pkt, rdOff + 6);
            if (tgt && tgt.str && /\.local$/.test(tgt.str) && tgt.str !== 'im-scr.local') {
                for (let i = 0; i < out.length; i++) { if (out[i].str === tgt.str) return; }
                out.push(tgt);
            }
        });
    } catch (e) { }
}

// 从通告包提取实例名（pnm:<toon>._blizzard._udp.local）→ { str, wire }：
// 优先取记录所有者名（66/TXT/SRV/A 等记录的 name 就是实例名，任何应答帧都有），
// 兜底 PTR rdata 指向（PTR 仅浏览应答帧携带——建房初始通告帧可能无 PTR，曾致实例名
// 提取为空 → 加入时 SRV 查询永不应答 → 游戏无连接目标加入失败，实测 02:16:45）。
// 调用方逐包重试直到提取成功
function extractInstanceName(pkt) {
    try {
        let found = null;
        forEachRecord(pkt, function (t, cls, rd, rdOff, nameStart) {
            if (found) return;
            let chk = null;
            if (nameStart != null && nameStart < pkt.length) chk = wireNameAt(pkt, nameStart);
            if (!chk && t === 12 && rdOff < pkt.length) chk = wireNameAt(pkt, rdOff);
            if (chk && chk.str && chk.str.indexOf('pnm:') === 0 && chk.str.indexOf('_blizzard._udp.local') !== -1) found = chk;
        });
        return found;
    } catch (e) { return null; }
}

MdnsReflector.prototype.stop = function (args) {
    const a = args || {};
    const roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    const sess = this.rooms.get(roomId);
    if (!sess) return { ok: true, stopped: 0 };
    if (sess.probeTimer) { clearInterval(sess.probeTimer); sess.probeTimer = null; }
    if (sess.reannTimer) { clearInterval(sess.reannTimer); sess.reannTimer = null; }
    this.rooms.delete(roomId);
    // 实例级定时器：末个会话收口时一并清掉（组播成员刷新/房主探测激发）
    if (this.rooms.size === 0) {
        if (this.membTimer) { clearInterval(this.membTimer); this.membTimer = null; }
        if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null; }
        this.lastRespAt = 0;
    }
    this.log('SC:R 发现反射器已停止：房间 ' + roomId + '（角色 ' + sess.role + '）');
    return { ok: true, stopped: 1 };
};

module.exports = new MdnsReflector();
