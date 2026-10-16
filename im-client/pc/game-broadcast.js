// game-broadcast.js - 功能二期方案 B（形态 A）：PC 客户端内置广播发现代理（主进程）
//
// 目标（设计文档 docs/联机原生SDK设计.md §11）：玩家加入房间后，本机游戏的「局域网游戏」列表
// 直接出现好友房间——全程不输 IP。原理（虚拟主机应答模型，经典 W3GS LAN 协议）：
//   1. 本机游戏（加入方）在 LAN 列表页周期向 255.255.255.255:6112 发 SearchGame（0xF7 0x2F）；
//   2. 本客户端 join 隧道恰已 bind 0.0.0.0:<host_port>（与游戏端口同号）→ 收到搜索帧；
//   3. 代理以「虚拟主机」身份单播应答 GameInfo（0xF7 0x30，房间名/人数来自 109 房间态）
//      → 游戏列表出现「[IM] xx」条目，地址=本机（应答源地址即本机）；
//   4. 周期发 RefreshGame（0xF7 0x33）广播刷新条目，防列表超时消失；
//   5. 玩家点加入 → 游戏 TCP 连 本机:6112 → 命中既有 join 隧道 → 字节经 DataChannel 到房主游戏。
//   （真实主机侧零改动：房主本机游戏自建主机，成员侧隧道透明转发，与现状一致。）
//
// 职责边界：
//   - 本模块只做「策略与包体构造」，不持任何 socket——收发复用 game-tunnel.js 的 join 隧道套接字
//     （源端口与游戏看到的主机端口一致，条目地址天然命中隧道监听），经 setTunnel 注入协作；
//   - 仅加入方（role=join）使用；房主侧不广播（本机游戏自建主机，局域网玩家直接可见）。
//
// 字节格式口径（重要）：构造函数集中在本文件 buildWar3GameInfo/buildWar3Refresh，
// 字段顺序按开源 w3gsdump 实测 dump（Product/HostCounter/EntryKey/GameName/GameSettings/
// SlotsTotal/GameFlags/SlotsUsed/SlotsAvailable/UptimeSec/GamePort）+ 1.32 版结构分析交叉印证；
// **个别字段宽度尚未经真实 1.24e/1.26 抓包校准（M2-H1）**——已内置 hex dump 校准日志：
// 每会话首次应答/首次刷新都会把发出的包 dump 到主进程控制台，与本机真实魔兽主机的广播包
// 对照即可校准（改 build 函数常量即可，不动机制层）。

const W3GS_SEARCH_GAME = 0x2F;  // C>S 搜索 LAN 游戏（列表页周期广播）
const W3GS_GAME_INFO = 0x30;    // S>C 游戏信息（对搜索者单播应答）
const W3GS_REFRESH_GAME = 0x33; // S>C 刷新列表条目（主机周期广播）

const REFRESH_MS = 5000;        // 刷新周期（同真实主机口径）
const NAME_MAX = 31;            // 游戏名截断（列表显示宽度约束，超长部分丢弃）
const HOST_MAX = 15;            // 建主玩家名截断
const MAP_PATH = 'Maps/(2)ConcealedHill.w3x'; // 占位地图名（仅列表显示；加入后地图由真实主机经隧道协商）
const PRODUCT = [0x57, 0x33, 0x58, 0x50];     // "W3XP"（冰封王座）
const VERSION_BYTE = 26;                       // 版本指纹（经典 1.26；待校准）

function GameBroadcast() {
    this.rooms = new Map();     // room_id → 会话 {hostCounter, entryKey, uptime0, slotsUsed, slotsTotal, timer, port}
    this.tunnel = null;         // game-tunnel 实例（main.js 注入）
    this.log = function (msg) { console.log('[game-broadcast] ' + msg); };
}

GameBroadcast.prototype.setLogger = function (fn) { if (typeof fn === 'function') this.log = fn; };

// 注入隧道引擎：注册 SearchGame 应答钩子（game-tunnel 在 join 隧道收到本机游戏搜索帧时回调）
GameBroadcast.prototype.setTunnel = function (t) {
    this.tunnel = t;
    if (!t || typeof t.setBroadcastHook !== 'function') return;
    var self = this;
    t.setBroadcastHook(function (roomId, msg, rinfo) { return self.onSearch(roomId, msg, rinfo); });
};

// 启动（幂等）：同房间重入时**仅更新字段**（名称/人数），保留条目指纹（HostCounter/EntryKey/
// 计时器）——渲染层在房间成员变化时会重发 start，重建指纹会导致游戏列表条目闪断重列
// args = {room_id, game, port, game_name, host_name, slots_total, slots_used}
GameBroadcast.prototype.start = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    if (a.game !== 'war3') return { ok: false, err: 'unsupported_game' }; // 首个适配：魔兽 III（模板扩展点）
    var used = Math.max(1, a.slots_used | 0);
    var total = Math.max(used, a.slots_total | 0);
    var old = this.rooms.get(roomId);
    if (old && old.port === (a.port | 0)) {
        // 重入更新：刷新显示字段，条目指纹不变（列表平滑刷新人数，不闪断）
        old.gameName = asciiSafe(a.game_name).slice(0, NAME_MAX);
        old.hostName = asciiSafe(a.host_name).slice(0, HOST_MAX);
        old.slotsUsed = used;
        old.slotsTotal = total;
        return { ok: true, updated: true };
    }
    this.stop({ room_id: roomId });

    var sess = {
        port: a.port | 0,
        gameName: asciiSafe(a.game_name).slice(0, NAME_MAX),
        hostName: asciiSafe(a.host_name).slice(0, HOST_MAX),
        slotsUsed: used,
        slotsTotal: total,
        hostCounter: (Math.random() * 0xFFFFFFFE + 1) | 0,
        entryKey: (Math.random() * 0xFFFFFFFE + 1) | 0,
        uptime0: Date.now(),
        dumped: { info: false, refresh: false }
    };
    var self = this;
    sess.timer = setInterval(function () { self.refresh(roomId); }, REFRESH_MS);
    this.rooms.set(roomId, sess);
    this.log('广播代理已启动：房间 ' + roomId + '（' + sess.gameName + '，端口 ' + sess.port + '，' + used + '/' + total + '）');
    return { ok: true };
};

GameBroadcast.prototype.stop = function (args) {
    var a = args || {};
    var roomId = typeof a.room_id === 'string' ? a.room_id.trim() : '';
    if (!roomId) return { ok: false, err: 'bad_key' };
    var sess = this.rooms.get(roomId);
    if (!sess) return { ok: true, stopped: 0 };
    if (sess.timer) { clearInterval(sess.timer); sess.timer = null; }
    this.rooms.delete(roomId);
    this.log('广播代理已停止：房间 ' + roomId);
    return { ok: true, stopped: 1 };
};

GameBroadcast.prototype.stopAll = function () {
    var self = this;
    var keys = [];
    this.rooms.forEach(function (s, k) { keys.push(k); });
    for (var i = 0; i < keys.length; i++) self.stop({ room_id: keys[i] });
    return { ok: true, stopped: keys.length };
};

// game-tunnel 回调：本机游戏的搜索帧（join 隧道 6112 收到 0xF7 0x2F）→ 应答 GameInfo 单播
// 返回应答 Buffer 数组（空/null=不处理，帧照旧进隧道）
GameBroadcast.prototype.onSearch = function (roomId, msg, rinfo) {
    var sess = this.rooms.get(roomId);
    if (!sess) return null;
    if (msg.length < 4 || msg[0] !== 0xF7 || msg[1] !== W3GS_SEARCH_GAME) return null;
    var buf = this.buildWar3GameInfo(sess);
    if (!sess.dumped.info) {
        sess.dumped.info = true;
        this.log('首次应答 SearchGame（校准样本 hex，' + buf.length + 'B）：' + buf.toString('hex'));
    }
    this.log('应答游戏搜索：' + rinfo.address + ':' + rinfo.port + '（房间 ' + roomId + '，' + sess.gameName + '）');
    return [buf];
};

// 周期刷新列表条目（RefreshGame 广播，经 join 隧道套接字发出，源端口=游戏端口）
GameBroadcast.prototype.refresh = function (roomId) {
    var sess = this.rooms.get(roomId);
    if (!sess || !this.tunnel || typeof this.tunnel.broadcastSend !== 'function') return;
    var buf = this.buildWar3Refresh(sess);
    if (!sess.dumped.refresh) {
        sess.dumped.refresh = true;
        this.log('首次 RefreshGame（校准样本 hex，' + buf.length + 'B）：' + buf.toString('hex'));
    }
    var r = this.tunnel.broadcastSend(roomId, buf);
    if (!r || !r.ok) this.log('刷新发送失败：' + ((r && r.err) || 'no_tunnel'));
};

// ----- 包体构造（模板归口：M2-H1 抓包校准只改这两个函数）-----

// GameInfo 0x30（对搜索者单播；字段顺序按 w3gsdump 实测，个别宽度待真实抓包校准）
GameBroadcast.prototype.buildWar3GameInfo = function (sess) {
    var b = [];
    Array.prototype.push.apply(b, PRODUCT);          // 产品 "W3XP"
    b.push(VERSION_BYTE);                            // 版本指纹
    pushDword(b, sess.hostCounter >>> 0);
    pushDword(b, sess.entryKey >>> 0);
    pushZ(b, sess.gameName);                         // 列表显示名（[IM] 前缀）
    // GameSettings 段
    pushWord(b, 0x0000);                             // GameSettingFlags（默认；待校准）
    pushWord(b, 180);                                // MapWidth
    pushWord(b, 180);                                // MapHeight
    pushDword(b, 0);                                 // MapXoro（地图校验）
    pushZ(b, MAP_PATH);                              // 地图路径（占位）
    pushZ(b, sess.hostName);                         // 建主玩家名
    for (var i = 0; i < 20; i++) b.push(0);          // MapSha1（占位；加入后地图由真实主机经隧道协商）
    pushDword(b, sess.slotsTotal >>> 0);             // SlotsTotal
    pushDword(b, 0);                                 // GameFlags（custom）
    pushWord(b, sess.slotsUsed & 0xFFFF);
    pushWord(b, Math.max(0, sess.slotsTotal - sess.slotsUsed) & 0xFFFF);
    pushDword(b, ((Date.now() - sess.uptime0) / 1000) | 0); // UptimeSec
    pushWord(b, sess.port & 0xFFFF);                 // GamePort
    return withHeader(W3GS_GAME_INFO, b);
};

// RefreshGame 0x33（周期广播；结构简单置信度高：HostCounter + SlotsUsed + SlotsAvailable）
GameBroadcast.prototype.buildWar3Refresh = function (sess) {
    var b = [];
    pushDword(b, sess.hostCounter >>> 0);
    pushWord(b, sess.slotsUsed & 0xFFFF);
    pushWord(b, Math.max(0, sess.slotsTotal - sess.slotsUsed) & 0xFFFF);
    return withHeader(W3GS_REFRESH_GAME, b);
};

// ----- 工具 -----
// 经典魔兽 LAN 名单按本地 ANSI（简中 GBK）显示；Node 无内置 GBK 编码，非 ASCII 字符
// 首发降级为 '_'（列表可见、名字可辨识性让位于不引第三方依赖），校准阶段评估 iconv-lite
function asciiSafe(s) {
    s = String(s || '');
    var out = '';
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        out += (c >= 32 && c < 127) ? s[i] : '_';
    }
    return out.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}
function pushWord(b, v) { b.push(v & 0xFF, (v >>> 8) & 0xFF); }
function pushDword(b, v) { b.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
function pushZ(b, s) {
    s = String(s || '');
    for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xFF);
    b.push(0);
}
function withHeader(cmd, body) {
    var len = body.length + 4;
    return Buffer.concat([Buffer.from([0xF7, cmd, len & 0xFF, (len >> 8) & 0xFF]), Buffer.from(body)]);
}

module.exports = new GameBroadcast();
