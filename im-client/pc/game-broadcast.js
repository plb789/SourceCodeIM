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
//     + 游戏名(变长，UTF-8，≤31 字节 + 0x0000) + 编码地图设置块(81B 模板逐字节保真)
//     + 槽位总数(4) + 0x00000009(4，语义未知保真) + 已用槽位(4) + 0x00000002(4，保真)
//     + uptime 秒(4) + 游戏端口(2B LE)；总长 = 125 + 名称字节数（31 字节名 = 156B）
//   - 版本适配点：VERSION_DWORD（0x18=1.24；1.26=0x1A、1.27=0x1B 类推，换版本改此处）
//
// 职责边界：
//   - 本模块只做「策略与包体构造」，不持任何 socket——收发复用 game-tunnel.js 的 join 隧道套接字
//     （搜索拦截 + 按来源端口应答均由隧道完成），经 setTunnel 注入协作；
//   - 仅加入方（role=join）使用；房主侧不广播（本机游戏自建主机，局域网玩家直接可见）。

const W3GS_SEARCH_GAME = 0x2F;  // 搜索帧（客户端临时端口 → 广播 6112）
const W3GS_GAME_INFO = 0x30;    // 应答帧（主机 6112 → 客户端临时端口，单播）
const NAME_MAX = 34;            // 游戏名上限（字节；1.24 实测可见 34 字节名，UTF-8 按字符边界截断）
const PRODUCT_LE = [0x50, 0x58, 0x33, 0x57];   // "PX3W"（= "W3XP" 反序存储，1.24 实测口径）
const VERSION_DWORD = [0x18, 0x00, 0x00, 0x00]; // 1.24（0x18=24；其他版本改此处）

// 编码地图设置块（81B，1.24 主机真实应答逐字节抓包，逐字节保真不重组——
// 列表展示仅取名称/人数；真实地图与槽位协商在加入后经隧道由主机游戏完成）
const GI_BLOCK = '0103490701016901e969019d5525e34d8b6171735d2935299d4d6567656f65739d2f77336d017161a96f6d6963696f6763b7a9c9f7b5a9012901db090571c90b95658bed857b8531614125efa5f7cf9700';
const GI_FIX_09 = 0x00000009;   // 语义未知 DWORD：保真
const GI_FIX_02 = 0x00000002;   // 语义未知 DWORD：保真

function GameBroadcast() {
    this.rooms = new Map();     // room_id → 会话 {port, gameName, hostName, slotsUsed, slotsTotal, ec, uptime0}
    this.tunnel = null;         // game-tunnel 实例（main.js 注入）
    this.log = function (msg) { console.log('[game-broadcast] ' + msg); };
}

GameBroadcast.prototype.setLogger = function (fn) { if (typeof fn === 'function') this.log = fn; };

// 注入隧道引擎：注册搜索帧应答钩子（game-tunnel 在 join 隧道收到本机游戏搜索帧时回调）
GameBroadcast.prototype.setTunnel = function (t) {
    this.tunnel = t;
    if (!t || typeof t.setBroadcastHook !== 'function') return;
    var self = this;
    t.setBroadcastHook(function (roomId, msg, rinfo) { return self.onSearch(roomId, msg, rinfo); });
};

// 启动（幂等）：同房间重入时仅更新字段（名称/人数），保留条目指纹（EC）——列表平滑刷新不闪断
// args = {room_id, game, port, game_name, host_name, slots_total, slots_used}
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
        return { ok: true, updated: true };
    }
    var sess = {
        port: a.port | 0,
        gameName: utf8Safe(a.game_name, NAME_MAX),
        hostName: utf8Safe(a.host_name, 15),
        slotsUsed: used,
        slotsTotal: total,
        ec: (Math.random() * 0xFFFFFFFE + 1) | 0,   // EntryCounter（真实主机为随机值，会话内恒定）
        uptime0: Date.now(),
        dumped: false
    };
    this.rooms.set(roomId, sess);
    this.log('广播代理已启动（1.24 校准版·搜索应答模型）：房间 ' + roomId + '（端口 ' + sess.port + '，' + used + '/' + total + '）');
    return { ok: true };
};

GameBroadcast.prototype.stop = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    var gone = this.rooms.delete(roomId);
    if (gone) this.log('广播代理已停止：房间 ' + roomId);
    return { ok: true, stopped: gone ? 1 : 0 };
};

GameBroadcast.prototype.stopAll = function () {
    var keys = [];
    this.rooms.forEach(function (s, k) { keys.push(k); });
    for (var i = 0; i < keys.length; i++) this.stop({ room_id: keys[i] });
    return { ok: true, stopped: keys.length };
};

// game-tunnel 回调：本机游戏的搜索帧（join 隧道 6112 收到 0x2F）→ 应答 GameInfo 单播到搜索来源
// 返回应答 Buffer 数组（空/null=不处理，帧照旧进隧道）
GameBroadcast.prototype.onSearch = function (roomId, msg, rinfo) {
    var sess = this.rooms.get(roomId);
    if (!sess) return null;
    if (msg.length < 12 || msg[0] !== 0xF7 || msg[1] !== W3GS_SEARCH_GAME) return null;
    var buf = this.buildGameInfo(sess);
    if (!sess.dumped) {
        sess.dumped = true;
        this.log('首次应答搜索（1.24 校准模板，' + buf.length + 'B）：' + buf.toString('hex'));
    }
    this.log('应答游戏搜索：' + rinfo.address + ':' + rinfo.port + '（房间 ' + roomId + '，' + sess.gameName + '）');
    return [buf];
};

// ----- 包体构造（1.24 校准归口）-----

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
    pushDword(b, sess.slotsTotal >>> 0);                        // 槽位总数
    pushDword(b, GI_FIX_09);                                    // 语义未知段保真
    pushDword(b, sess.slotsUsed >>> 0);                         // 已用槽位
    pushDword(b, GI_FIX_02);                                    // 语义未知段保真
    pushDword(b, ((Date.now() - sess.uptime0) / 1000) | 0);     // uptime 秒
    pushWord(b, sess.port & 0xFFFF);                            // 游戏端口（=本机隧道 TCP 监听端口）
    return withHeader(W3GS_GAME_INFO, b);
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
