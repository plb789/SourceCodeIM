// game-broadcast.js - 功能二期方案 B（形态 A）：PC 客户端内置广播发现代理（主进程）
//
// 目标（设计文档 docs/联机原生SDK设计.md §11）：玩家加入房间后，本机游戏的「局域网游戏」列表
// 直接出现好友房间——全程不输 IP。原理（搜索应答模型，W3GS LAN 协议·1.24 实测校准版）：
//   1. 本机游戏进入「局域网游戏」列表页后，从【临时端口】周期广播搜索帧
//      （0x2F：F7 2F 10 00 + 产品"PX3W" + 版本 0x18 + 0——1.24 实测抓包，客户端不绑 6112）；
//   2. 本客户端 join 隧道 bind 0.0.0.0:<host_port> 恰好收到该搜索帧（目的地就是 6112）；
//   3. 代理以虚拟主机身份向搜索来源（临时端口）单播应答 GameInfo（0x30，156~ 字节，含游戏名）
//      ——1.24 列表条目名称只能来自 0x30 应答（主机推送帧不含名称），应答即建条目；
//   4. 玩家点加入 → 游戏 TCP 连条目地址（=本机:<host_port>，GamePort 字段已修补）→ 命中
//      既有 join 隧道 TCP 监听 → 字节经 DataChannel 到房主游戏。
//   （真实主机侧零改动：房主本机游戏自建主机，成员侧隧道透明转发，与现状一致。）
//
// 1.24 校准口径（M2-H1 已完成，2026-10-16 pktmon 内核抓包实测——含双机原生会话完整握手）：
//   - 搜索帧：F7 2F 10 00 + 产品 + 版本 + 0（客户端临时端口发出；主机同款亦为广播，16B）
//   - GameInfo 0x30：应答单播到搜索来源端口；结构 = 头(4) + 产品(4) + 版本(4) + HC(4) + EC(4)
//     + 游戏名(变长，UTF-8 + 0x0000) + 编码地图设置块(81B 模板逐字节保真)
//     + 槽位总数(4) + 0x00000009(4，语义未知保真) + 已用槽位(4)
//     + uptime 秒(4) + 游戏端口(2B LE)；总长 = 125 + 名称字节数（31 字节名 = 156B）
//   - 心跳 0x32：F7 32 10 00 + [HC=1][EC=1][当前玩家数]（仅直投模式使用）
//   - 版本适配点：VERSION_DWORD（0x18=1.24；1.26=0x1A、1.27=0x1B 类推，换版本改此处）
//
// 双模（按隧道 UDP 绑定结果自动选择）：
//   拦截模式（先加入后开游戏）：隧道持有 UDP 6112 → 拦截本机游戏搜索帧按来源端口应答，零额外流量；
//   直投模式（先开游戏后加入）：隧道 UDP 被本机游戏先占（1.24 绑定失败直接哑、软降级仅 TCP）
//   → 代理自有临时端口套接字周期直投 0x30（单播游戏端口）+ 0x32/伴随帧广播补位发现链路。
//
// 职责边界：
//   - 拦截模式零自持 socket（应答由隧道完成）；直投模式持有自有临时端口 UDP 套接字；
//   - 仅加入方（role=join）使用；房主侧不广播（本机游戏自建主机，局域网玩家直接可见）。

const dgram = require('dgram');
const os = require('os');

const W3GS_SEARCH_GAME = 0x2F;  // 搜索帧（客户端临时端口 → 广播 6112）
const W3GS_GAME_INFO = 0x30;    // 应答帧（主机 6112 → 客户端临时端口，单播）
const W3GS_ANNOUNCE_31 = 0x31;  // 低频伴随帧（产品+版本+1）
const W3GS_HEARTBEAT_32 = 0x32; // ~1s 心跳（HC/EC/当前玩家数）
const W3GS_REFRESH_GAME = 0x33; // 低频伴随帧（单 DWORD）
const HEARTBEAT_MS = 1000;      // 直投模式节拍
const BURST_MS = 12000;         // 直投模式低频伴随周期
const PROBE_MS = 2000;          // 主机端探测周期（真实 GameInfo 轮询）
const PROBE_GONE_MS = 7000;     // 主机游戏消失判定（~3.5 个探测周期无应答）
const NAME_MAX = 34;            // 游戏名上限（字节；1.24 实测可见 34 字节名，UTF-8 按字符边界截断）
const PRODUCT_LE = [0x50, 0x58, 0x33, 0x57];   // "PX3W"（= "W3XP" 反序存储，1.24 实测口径）
const VERSION_DWORD = [0x18, 0x00, 0x00, 0x00]; // 1.24（0x18=24；其他版本改此处）

// 编码地图设置块（81B，1.24 主机真实应答逐字节抓包，逐字节保真不重组——
// 列表展示仅取名称/人数；真实地图与槽位协商在加入后经隧道由主机游戏完成）
const GI_BLOCK = '0103490701016901e969019d5525e34d8b6171735d2935299d4d6567656f65739d2f77336d017161a96f6d6963696f6763b7a9c9f7b5a9012901db090571c90b95658bed857b8531614125efa5f7cf9700';
const GI_FIX_04 = 0x00000004;   // 实测 04——语义未知 DWORD：保真（非槽位总数，2 人图亦为 04）
const GI_FIX_09 = 0x00000009;   // 实测 09——语义未知 DWORD：保真

function GameBroadcast() {
    this.rooms = new Map();     // room_id → 会话（join：拦截/直投双模；host：探测中继）
    this.tunnel = null;         // game-tunnel 实例（main.js 注入）
    this.relayHandler = null;   // 主机端真实 GameInfo 中继回调（main.js 注入 → 渲染层 ctl 通道）
    this.log = function (msg) { console.log('[game-broadcast] ' + msg); };
}

GameBroadcast.prototype.setLogger = function (fn) { if (typeof fn === 'function') this.log = fn; };

// 注入真实 GameInfo 中继回调（main.js：收到后经 'gn-broadcast-gi' IPC 推给渲染层）
GameBroadcast.prototype.setRelayHandler = function (fn) { if (typeof fn === 'function') this.relayHandler = fn; };

// 加入端接收主机中继（hex 非空=真实 GameInfo 缓存；空=主机游戏已消失——撤下条目）
// 幂等：消失期间主机每拍重发同一信令，仅在状态翻转时记日志/生效，防日志刷屏
GameBroadcast.prototype.setRelayGI = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    var sess = this.rooms.get(roomId);
    if (!sess) return { ok: false, err: 'no_sess' };
    var hex = String(a.hex || '').toLowerCase();
    if (hex && hex.slice(0, 4) === 'f730') {
        var wasGone = !!sess.gameGone;
        sess.relayGI = hex;
        sess.gameGone = false;
        if (wasGone) this.log('主机游戏已恢复：恢复条目注入（房间 ' + roomId + '）');
        return { ok: true, state: 'alive' };
    }
    // 主机游戏已消失（主机关闭游戏/未建主）：清缓存并标记——停止一切注入与应答，
    // 加入方列表条目随 war3 自身条目超时自然消失（不喂假数据防幻影房间）
    if (sess.gameGone) return { ok: true, state: 'gone' }; // 幂等：重复消失信令不再记日志
    sess.relayGI = null;
    sess.gameGone = true;
    this.log('主机游戏已消失信令：停止条目注入（房间 ' + roomId + '）');
    return { ok: true, state: 'gone' };
};

// 注入隧道引擎：注册搜索帧应答钩子（game-tunnel 在 join 隧道收到本机游戏搜索帧时回调）
GameBroadcast.prototype.setTunnel = function (t) {
    this.tunnel = t;
    if (!t || typeof t.setBroadcastHook !== 'function') return;
    var self = this;
    t.setBroadcastHook(function (roomId, msg, rinfo) { return self.onSearch(roomId, msg, rinfo); });
};

// 启动（幂等）：同房间重入时仅更新字段（名称/人数），保留条目指纹（EC）——列表平滑刷新不闪断
// args = {room_id, game, port, role:'host'|'join', game_name, host_name, slots_total, slots_used}
GameBroadcast.prototype.start = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    if (a.game !== 'war3') return { ok: false, err: 'unsupported_game' }; // 首个适配：魔兽 III（模板扩展点）
    var used = Math.max(1, a.slots_used | 0);
    var total = Math.max(used, a.slots_total | 0);
    var old = this.rooms.get(roomId);
    if (old) {
        old.gameName = utf8Safe(a.game_name, NAME_MAX);
        old.hostName = utf8Safe(a.host_name, 15);
        old.slotsUsed = used;
        old.slotsTotal = total;
        // 模式切换（重绑恢复）：隧道 UDP 重绑成功（用户关闭了先占端口的游戏）→ 直投模式切回拦截
        if (old.udp && this.tunnel && typeof this.tunnel.udpBindOk === 'function' && this.tunnel.udpBindOk(roomId)) {
            if (old.hbTimer) { clearInterval(old.hbTimer); old.hbTimer = null; }
            if (old.burstTimer) { clearInterval(old.burstTimer); old.burstTimer = null; }
            try { old.udp.close(); } catch (e) { }
            old.udp = null;
            this.log('隧道 UDP 已重绑成功：直投模式切回拦截模式（房间 ' + roomId + '）');
        }
        return { ok: true, updated: true };
    }
    var self = this;
    // 主机端探测模式：本机游戏是真实主机（自带全部真实数据——名称/人数/槽位/地图），代理周期
    // 向 127.0.0.1:6112 发搜索帧，收到 0x30 真实应答即经 relayHandler 中继给加入方（ctl 通道）
    if (a.role === 'host') {
        var probe = dgram.createSocket('udp4');
        var sessH = { probe: probe, probeTimer: null, room: roomId,
            lastReplyAt: 0, goneSent: true };   // 初始即视为「无游戏」：首次探测成功前不中继任何数据
        probe.on('error', function (e) { self.log('主机探测套接字错误：' + ((e && e.message) || '')); });
        probe.on('message', function (msg) {
            if (msg.length < 4 || msg[0] !== 0xF7 || msg[1] !== W3GS_GAME_INFO) return;
            sessH.lastReplyAt = Date.now();
            // 游戏存在：中继真实 GameInfo（每次成功探测都中继，保证加入方数据新鲜）
            sessH.goneSent = false;
            if (self.relayHandler) {
                try { self.relayHandler(roomId, msg.toString('hex')); } catch (e) { }
            }
        });
        probe.bind(0, function () {
            self.log('主机探测模式已启动：房间 ' + roomId + '（周期探测本机游戏 127.0.0.1:6112 的真实 GameInfo）');
        });
        sessH.probeTimer = setInterval(function () {
            // 游戏消失检测：连续多个探测周期无应答 → 中继「已消失」信令（空 hex），
            // 加入方收到后停止注入/应答，其列表条目随 war3 自身超时自然消失。
            // 消失期间信令每拍重发（自愈：单次信令若遇对端重连窗口会丢，重发保证最终一致）；
            // 且探测帧必须继续发——房主重新建主后由应答自动恢复（漏发探测会永久卡死在消失态）
            if (sessH.lastReplyAt && Date.now() - sessH.lastReplyAt > PROBE_GONE_MS) {
                if (!sessH.goneSent) {
                    sessH.goneSent = true;
                    self.log('主机游戏已消失（' + (PROBE_GONE_MS / 1000) + 's 无应答）：通知加入方撤下条目（房间 ' + roomId + '）');
                }
                if (self.relayHandler) {
                    try { self.relayHandler(roomId, ''); } catch (e) { }
                }
            } else if (sessH.goneSent) {
                sessH.goneSent = false; // 已恢复（应答重新到达）
            }
            try {
                probe.send(Buffer.from([0xF7, 0x2F, 0x10, 0x00, 0x50, 0x58, 0x33, 0x57, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 6112, '127.0.0.1');
            } catch (e) { }
        }, PROBE_MS);
        this.rooms.set(roomId, sessH);
        return { ok: true };
    }
    // 加入端：双模（拦截/直投）+ 真实数据中继缓存（relayGI 优先于模板构造）
    var sess = {
        port: a.port | 0,
        gameName: utf8Safe(a.game_name, NAME_MAX),
        hostName: utf8Safe(a.host_name, 15),
        slotsUsed: used,
        slotsTotal: total,
        ec: (Math.random() * 0xFFFFFFFE + 1) | 0,   // EntryCounter（真实主机为随机值，会话内恒定）
        uptime0: Date.now(),
        udp: null,                                   // 直投模式自有套接字（按需创建）
        dumped: false, dumpedDirect: false
    };
    var self = this;
    // 双模：隧道持有 UDP 6112（先加入后开游戏）→ 拦截搜索应答即可，零额外流量；
    // 隧道 UDP 被本机游戏先占（先开游戏后加入，软降级）→ 自有套接字周期直投补位发现链路
    if (!(this.tunnel && typeof this.tunnel.udpBindOk === 'function' && this.tunnel.udpBindOk(roomId))) {
        var udp = dgram.createSocket('udp4');
        sess.udp = udp;
        udp.on('error', function (e) { self.log('直投套接字错误：' + ((e && e.message) || '')); });
        udp.bind(0, function () {
            try { udp.setBroadcast(true); } catch (e) { }
            self.log('直投模式：隧道 UDP 已被本机游戏先占，0x30/0x32 改由自有套接字直投（房间 ' + roomId + '）');
        });
        sess.hbTimer = setInterval(function () { self.heartbeat(roomId); }, HEARTBEAT_MS);
        sess.burstTimer = setInterval(function () { self.burst(roomId); }, BURST_MS);
    }
    this.rooms.set(roomId, sess);
    this.log('广播代理已启动（1.24 校准版·' + (sess.udp ? '直投' : '拦截') + '模式）：房间 ' + roomId + '（端口 ' + sess.port + '，' + used + '/' + total + '）');
    return { ok: true };
};

GameBroadcast.prototype.stop = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    var sess = this.rooms.get(roomId);
    if (!sess) return { ok: true, stopped: 0 };
    if (sess.hbTimer) { clearInterval(sess.hbTimer); sess.hbTimer = null; }
    if (sess.burstTimer) { clearInterval(sess.burstTimer); sess.burstTimer = null; }
    if (sess.probeTimer) { clearInterval(sess.probeTimer); sess.probeTimer = null; }
    if (sess.udp) { try { sess.udp.close(); } catch (e) { } sess.udp = null; }
    if (sess.probe) { try { sess.probe.close(); } catch (e) { } sess.probe = null; }
    this.rooms.delete(roomId);
    this.log('广播代理已停止：房间 ' + roomId);
    return { ok: true, stopped: 1 };
};

GameBroadcast.prototype.stopAll = function () {
    var keys = [];
    this.rooms.forEach(function (s, k) { keys.push(k); });
    for (var i = 0; i < keys.length; i++) this.stop({ room_id: keys[i] });
    return { ok: true, stopped: keys.length };
};

// game-tunnel 回调：搜索帧应答钩子（拦截模式——隧道持有 UDP 6112 时由本钩子按来源端口应答）
// 条目可见性由主机中继驱动：仅当主机真实 GameInfo 在手时才应答——主机游戏不存在时保持静默
// （原模板兜底会制造幻影房间：主机关闭游戏后加入方仍能看到假条目，实测反馈）
GameBroadcast.prototype.onSearch = function (roomId, msg, rinfo) {
    var sess = this.rooms.get(roomId);
    if (!sess) return null;
    if (!sess.relayGI) return null;   // 无主机真实数据（未建主/已消失）：静默，不出条目
    if (msg.length < 12 || msg[0] !== 0xF7 || msg[1] !== W3GS_SEARCH_GAME) return null;
    var buf = this.patchGI(roomId, Buffer.from(sess.relayGI, 'hex'));
    if (!sess.dumped) {
        sess.dumped = true;
        this.log('首次应答搜索（主机中继真实数据，' + buf.length + 'B，条目名已补丁）：' + buf.toString('hex'));
    }
    this.log('应答游戏搜索：' + rinfo.address + ':' + rinfo.port + '（房间 ' + roomId + '，主机真实数据）');
    return [buf];
};

// ~1s 直投节拍（仅直投模式）：0x32 广播 + 0x30 单播直投本机游戏发现端口
// 条目可见性由主机中继驱动：仅当主机真实 GameInfo 在手时才注入——主机游戏不存在时静默
GameBroadcast.prototype.heartbeat = function (roomId) {
    var sess = this.rooms.get(roomId);
    if (!sess || !sess.udp) return;
    if (!sess.relayGI) return;   // 主机游戏不存在/已消失：不注入（防幻影房间）
    var hb = this.buildHeartbeat32(sess);
    var gi = this.patchGI(roomId, Buffer.from(sess.relayGI, 'hex'));
    if (!sess.dumpedDirect) {
        sess.dumpedDirect = true;
        this.log('直投 0x32（' + hb.length + 'B）：' + hb.toString('hex'));
        this.log('直投 0x30（' + gi.length + 'B，条目名已补丁）：' + gi.toString('hex'));
    }
    // 广播心跳（255.255.255.255 本机回环实测可达）+ GameInfo 单播直投（仅 127.0.0.1 单目标——
    // 多目标会被 war3 按来源地址建成多个同名条目，实测双份即此因）
    try { sess.udp.send(hb, 6112, '255.255.255.255'); } catch (e) { }
    try { sess.udp.send(gi, sess.port, '127.0.0.1'); } catch (e) { }
};

// ~12s 低频伴随（仅直投模式）：0x2F/0x31/0x33（产品+版本指纹，客户端过滤口径）
GameBroadcast.prototype.burst = function (roomId) {
    var sess = this.rooms.get(roomId);
    if (!sess || !sess.udp) return;
    var frames = [
        withHeader(W3GS_SEARCH_GAME, [].concat(PRODUCT_LE, VERSION_DWORD, [0x00, 0x00, 0x00, 0x00])),
        withHeader(W3GS_ANNOUNCE_31, [].concat(PRODUCT_LE, VERSION_DWORD, [0x01, 0x00, 0x00, 0x00])),
        withHeader(W3GS_REFRESH_GAME, [0x01, 0x00, 0x00, 0x00])
    ];
    for (var j = 0; j < frames.length; j++) {
        try { sess.udp.send(frames[j], 6112, '255.255.255.255'); } catch (e) { }
    }
};

// ----- 包体构造（1.24 校准归口）-----

// GamePort 补丁：中继的真实 GameInfo 携带房主游戏端口（6112），而本机游戏点击加入时连接的是
// "条目地址:GamePort"——原端口被本机游戏先占时隧道已顺延（dataPortOf），不补丁则加入连进本机
// 游戏自身（TCP 6112 被 War3 自己持有）。仅改帧尾 2B LE 端口字段，不改缓存原件（1.24 口径：帧尾=端口）
GameBroadcast.prototype.patchPort = function (roomId, buf) {
    var dp = (this.tunnel && typeof this.tunnel.dataPortOf === 'function') ? (this.tunnel.dataPortOf(roomId) | 0) : 0;
    if (!dp || buf.length < 8) return buf;
    if (buf.readUInt16LE(buf.length - 2) === (dp & 0xFFFF)) return buf;
    var out = Buffer.from(buf);
    out.writeUInt16LE(dp & 0xFFFF, out.length - 2);
    return out;
};

// 条目可视补丁：在端口补丁之上把列表条目名称改为 IM 房间名（sess.gameName = "[IM] 房主名的房间"），
// 其余字节（HC/EC 指纹、地图设置块、槽位、uptime）逐位保真——条目去重与游戏内解析不受影响。
// 名称区为变长区（偏移 20 起，UTF-8 + 00 00 终止）：改名即重组帧体并重写帧长字段（帧长=总长，实测口径）
GameBroadcast.prototype.patchGI = function (roomId, buf) {
    var out = this.patchPort(roomId, buf);
    var sess = this.rooms.get(roomId);
    if (!sess || !sess.gameName || out.length < 130) return out;
    var nb = Buffer.from(utf8Safe(sess.gameName, NAME_MAX), 'utf8');
    if (!nb.length) return out;
    var start = 20, i = start, end = -1;                     // 头4+产品4+版本4+HC4+EC4=20：名称区起点
    while (i + 1 < out.length) {
        if (out[i] === 0x00 && out[i + 1] === 0x00) { end = i; break; } // 名称终止 00 00（实测口径）
        i++;
    }
    if (end < 0 || end === start) return out;                // 结构异常：放弃改名（保真原帧）
    var rebuilt = Buffer.concat([out.slice(0, start), nb, Buffer.from([0x00, 0x00]), out.slice(end + 2)]);
    rebuilt.writeUInt16LE(rebuilt.length & 0xFFFF, 2);       // 帧长字段=总长（含 4B 头）
    return rebuilt;
};

// GameInfo 0x30：变长名称拼接（真实主机即变长；总长 = 125 + 名称字节数）
GameBroadcast.prototype.buildGameInfo = function (sess) {
    var b = [];
    var i;
    for (i = 0; i < 4; i++) b.push(PRODUCT_LE[i]);              // 产品 "PX3W"
    for (i = 0; i < 4; i++) b.push(VERSION_DWORD[i]);           // 版本指纹（1.24=0x18）
    pushDword(b, 1);                                            // HostCounter（实测恒 1）
    pushDword(b, sess.ec >>> 0);                                // EntryCounter（会话随机恒定）
    var name = Buffer.from(sess.gameName, 'utf8');              // 游戏名（UTF-8，≤31B，utf8Safe 已截断）
    for (i = 0; i < name.length; i++) b.push(name[i]);
    b.push(0x00, 0x00);                                         // 名终止 + 结构分隔（实测口径）
    pushHex(b, GI_BLOCK);                                       // 编码地图设置块（81B 保真）
    pushDword(b, GI_FIX_04);                                    // 实测 04——语义未知，保真（非槽位总数）
    pushDword(b, GI_FIX_09);                                    // 实测 09——语义未知，保真
    pushDword(b, sess.slotsUsed >>> 0);                         // 已用槽位（列表「x/y」的已用数，随房间成员数刷新）
    pushDword(b, sess.slotsTotal >>> 0);                        // 槽位总数（列表「x/y」的总数，实测口径）
    pushDword(b, ((Date.now() - sess.uptime0) / 1000) | 0);     // uptime 秒
    pushWord(b, sess.port & 0xFFFF);                            // 游戏端口（=本机隧道 TCP 监听端口）
    return withHeader(W3GS_GAME_INFO, b);
};

// 心跳 0x32：F7 32 10 00 + [HC=1][EC=1][当前玩家数]（1.24 实测口径，仅直投模式使用）
GameBroadcast.prototype.buildHeartbeat32 = function (sess) {
    var b = [];
    pushDword(b, 1);                          // HostCounter（与 GameInfo 模板一致）
    pushDword(b, 1);                          // EC（实测恒 1）
    pushDword(b, sess.slotsUsed >>> 0);       // 当前玩家数（实测随玩家加入递增）
    return withHeader(W3GS_HEARTBEAT_32, b);
};

// ----- 工具 -----
// 1.24 中文版游戏名以 UTF-8 传输（实测默认名即为 UTF-8 字节）；按字符边界截断到 max 字节内
function utf8Safe(s, max) {
    s = String(s || '');
    var out = '';
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7F) c = 0x20;             // 控制字符降级空格
        var n = c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);       // 基本面字符 UTF-8 长度
        if (bytes + n > max) break;
        out += s[i];
        bytes += n;
    }
    return out.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}
function pushWord(b, v) { b.push(v & 0xFF, (v >>> 8) & 0xFF); }
function pushDword(b, v) { b.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
function pushHex(b, hex) {
    for (var i = 0; i + 1 < hex.length; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
}
function withHeader(cmd, body) {
    var len = body.length + 4;
    return Buffer.concat([Buffer.from([0xF7, cmd, len & 0xFF, (len >> 8) & 0xFF]), Buffer.from(body)]);
}

module.exports = new GameBroadcast();
