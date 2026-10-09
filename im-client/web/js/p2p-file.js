// p2p-file.js - 阶段一百五十六：好友文件 P2P 直传引擎（WebRTC DataChannel，服务端仅信令中继）
// 职责（与 chat.js 解耦，详见 docs/P2P文件传输详细设计.md §4/§5）：
//   1. 信令面：probe/accept/offer/answer/candidate/ping/done/abort 收发（msg_type=91 经 socket.js 分流入口 onSignal）
//   2. 数据面：DataChannel ordered+reliable 直传——头帧→ready→chunk(seq)→累计 ack→eof{sha256}→complete
//   3. 流控：bufferedAmount 高水位暂停读盘 / 低水位恢复；SHA-256 边传边算（纯 JS 增量实现，WebCrypto 无流式接口）
//   4. 兜底：协商超时（服务端下发 negotiate_timeout）、看门狗（30s 无任何数据）、通道断开——
//      任何失败 resolve({fallback:true, reason})，由 chat.js 接管回退现有 HTTP 链路（送达率 100%）
// 对外接口：
//   P2PFile.send(file, toUser, nonce)                 发起传输 → Promise resolve({ok:true}) | ({fallback:true, reason})
//   P2PFile.onSignal(msg)                             信令入口（socket.js dispatch 分发 91 帧）
//   P2PFile.onProgress(info)                          进度回调（chat.js 注入：{nonce, transfer_id, role, phase, percent, speed}）
//   P2PFile.cancelByNonce(nonce)                      用户取消（发送方）→ abort 信令 + 清理
//   P2PFile.receivedURL(nonce)                        接收完成文件的内存 blob 地址（无则空串）
//   P2PFile.config(cfg)                               服务端归口决策参数注入（socket.js 登录响应解析后调用）
//   P2PFile.localEnabled() / P2PFile.available()      本端开关（设置页）与环境能力
(function () {
    'use strict';

    // 决策参数（服务端归口，登录响应 file_p2p_* 注入覆盖；兜底默认值与服务端 config.yaml 一致）
    var cfg = {
        enabled: true,          // 服务端总开关
        threshold: 1048576,     // 大于该字节数且私聊才尝试 P2P
        negotiateTimeout: 10,   // 协商超时秒（probe 起到通道打通）
        chunkSize: 16384,       // DataChannel 分片字节
        highWater: 8388608,     // 发送缓冲高水位（暂停读文件）
        lowWater: 1048576,      // 发送缓冲低水位（恢复读文件）
        archive: false          // 归档开关（一期仅透传，发送方不自动归档）
    };

    // 本端开关（设置页"好友文件直传"，localStorage 持久化；关闭后本端不发起、入站 probe 忽略）
    function localEnabled() {
        try { return localStorage.getItem('im_file_p2p') !== '0'; } catch (e) { return true; }
    }
    function available() { return typeof RTCPeerConnection !== 'undefined'; }
    function platform() { return window.desktop ? (window.__webCallBridge ? 'web' : 'pc') : ''; }
    function genId() { return 'p' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
    // 接收端落地文件名风控（设计 §8.5：清洗路径穿越与非法字符）
    function safeName(name) {
        return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || 'file';
    }

    // ===== 增量 SHA-256（WebCrypto 无流式摘要接口，边传边算用纯 JS 实现；实测对齐 crypto.subtle） =====
    var SHA_K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    function Sha256() {
        this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.buf = new Uint8Array(64);
        this.bl = 0;   // 缓冲内字节数
        this.len = 0;  // 累计字节数
        this.w = new Int32Array(64);
    }
    Sha256.prototype.block = function (p, off) {
        var w = this.w, i, t, a, b, s0, s1;
        for (i = 0; i < 16; i++) {
            w[i] = (p[off + 4 * i] << 24) | (p[off + 4 * i + 1] << 16) | (p[off + 4 * i + 2] << 8) | p[off + 4 * i + 3];
        }
        for (t = 16; t < 64; t++) {
            a = w[t - 15]; b = w[t - 2];
            s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        var h = this.h;
        var v0 = h[0], v1 = h[1], v2 = h[2], v3 = h[3], v4 = h[4], v5 = h[5], v6 = h[6], v7 = h[7];
        for (t = 0; t < 64; t++) {
            var S1 = ((v4 >>> 6) | (v4 << 26)) ^ ((v4 >>> 11) | (v4 << 21)) ^ ((v4 >>> 25) | (v4 << 7));
            var ch = (v4 & v5) ^ (~v4 & v6);
            var t1 = (v7 + S1 + ch + SHA_K[t] + w[t]) | 0;
            var S0 = ((v0 >>> 2) | (v0 << 30)) ^ ((v0 >>> 13) | (v0 << 19)) ^ ((v0 >>> 22) | (v0 << 10));
            var maj = (v0 & v1) ^ (v0 & v2) ^ (v1 & v2);
            var t2 = (S0 + maj) | 0;
            v7 = v6; v6 = v5; v5 = v4; v4 = (v3 + t1) | 0; v3 = v2; v2 = v1; v1 = v0; v0 = (t1 + t2) | 0;
        }
        h[0] = (h[0] + v0) | 0; h[1] = (h[1] + v1) | 0; h[2] = (h[2] + v2) | 0; h[3] = (h[3] + v3) | 0;
        h[4] = (h[4] + v4) | 0; h[5] = (h[5] + v5) | 0; h[6] = (h[6] + v6) | 0; h[7] = (h[7] + v7) | 0;
    };
    Sha256.prototype.update = function (u8) {
        this.len += u8.length;
        var off = 0, i, j;
        if (this.bl > 0) {
            var need = 64 - this.bl;
            var take = u8.length < need ? u8.length : need;
            for (i = 0; i < take; i++) this.buf[this.bl + i] = u8[i];
            this.bl += take; off = take;
            if (this.bl === 64) { this.block(this.buf, 0); this.bl = 0; }
        }
        while (off + 64 <= u8.length) { this.block(u8, off); off += 64; }
        if (off < u8.length) {
            for (j = off; j < u8.length; j++) this.buf[this.bl++] = u8[j];
        }
    };
    Sha256.prototype.hex = function () {
        // 填充规则：消息尾补 0x80 与 0x00 至 56 mod 64，再补 64 位大端比特长度
        var padLen = this.bl < 56 ? 56 - this.bl : 120 - this.bl;
        var fin = new Uint8Array(this.bl + padLen + 8);
        fin.set(this.buf.subarray(0, this.bl), 0);
        fin[this.bl] = 0x80;
        var bits = this.len * 8;                          // len < 2^50 内精确
        var hi = Math.floor(bits / 4294967296);
        var lo = bits >>> 0;                              // ToUint32 取模得低 32 位（超 4GB 仍正确）
        fin[fin.length - 8] = (hi >>> 24) & 255;
        fin[fin.length - 7] = (hi >>> 16) & 255;
        fin[fin.length - 6] = (hi >>> 8) & 255;
        fin[fin.length - 5] = hi & 255;
        fin[fin.length - 4] = (lo >>> 24) & 255;
        fin[fin.length - 3] = (lo >>> 16) & 255;
        fin[fin.length - 2] = (lo >>> 8) & 255;
        fin[fin.length - 1] = lo & 255;
        var off = 0;
        while (off + 64 <= fin.length) { this.block(fin, off); off += 64; }
        var out = '';
        for (var i = 0; i < 8; i++) {
            var s = (this.h[i] >>> 0).toString(16);
            out += ('00000000' + s).slice(-8);
        }
        return out;
    };

    // ===== 会话表与进度回调 =====
    var sessions = {};   // transfer_id -> 会话
    var nonceIndex = {}; // nonce -> transfer_id（发送方取消按钮 / 接收方气泡定位）
    var recvFiles = {};  // nonce -> {url, name, blob, mime, size}（接收完成的内存 blob，供卡片点击复用+缓存写入）

    // ===== 阶段一百五十九：接收文件缓存层（IndexedDB，WEB/PC 通吃，刷新后历史卡片可回填 data-url） =====
    // 库名 im_p2p_cache / 仓 file_cache / key=msg_id / value={blob, name, mime, size, ts}
    // LRU：总大小超 500MB 时按 ts 升序删除最旧记录直到回到上限以下
    var P2P_DB_NAME = 'im_p2p_cache';
    var P2P_STORE = 'file_cache';
    var P2P_DB_MAX = 500 * 1024 * 1024; // 500MB LRU 上限
    function dbOpen() {
        return new Promise(function (resolve) {
            try {
                var req = indexedDB.open(P2P_DB_NAME, 1);
                req.onupgradeneeded = function (e) {
                    var db = e.target.result;
                    if (!db.objectStoreNames.contains(P2P_STORE)) {
                        var st = db.createObjectStore(P2P_STORE, { keyPath: 'msg_id' });
                        st.createIndex('ts', 'ts', { unique: false });
                    }
                };
                req.onsuccess = function (e) { resolve(e.target.result); };
                req.onerror = function () { resolve(null); };
            } catch (e) { resolve(null); }
        });
    }
    function dbPut(msgId, blob, name, mime, size) {
        return dbOpen().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(P2P_STORE, 'readwrite');
                    var st = tx.objectStore(P2P_STORE);
                    st.put({ msg_id: msgId, blob: blob, name: name, mime: mime, size: size, ts: Date.now() });
                    tx.oncomplete = function () { dbEvict(db).then(function () { resolve(true); }); };
                    tx.onerror = function () { resolve(false); };
                } catch (e) { resolve(false); }
            });
        });
    }
    function dbEvict(db) {
        return new Promise(function (resolve) {
            try {
                var tx = db.transaction(P2P_STORE, 'readonly');
                var st = tx.objectStore(P2P_STORE);
                var all = [];
                var cur = st.openCursor();
                cur.onsuccess = function (e) {
                    var c = e.target.result;
                    if (c) { all.push(c.value); c.continue(); }
                    else { checkEvict(db, all, resolve); }
                };
                cur.onerror = function () { resolve(); };
            } catch (e) { resolve(); }
        });
    }
    function checkEvict(db, all, resolve) {
        var total = 0;
        for (var i = 0; i < all.length; i++) total += (all[i].size || 0);
        if (total <= P2P_DB_MAX) { resolve(); return; }
        all.sort(function (a, b) { return a.ts - b.ts; });
        var tx = db.transaction(P2P_STORE, 'readwrite');
        var st = tx.objectStore(P2P_STORE);
        var idx = 0;
        while (total > P2P_DB_MAX && idx < all.length) {
            st.delete(all[idx].msg_id);
            total -= (all[idx].size || 0);
            idx++;
        }
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
    }
    function dbGet(msgId) {
        return dbOpen().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(P2P_STORE, 'readonly');
                    var st = tx.objectStore(P2P_STORE);
                    var req = st.get(msgId);
                    req.onsuccess = function (e) {
                        var rec = e.target.result;
                        if (!rec) { resolve(null); return; }
                        // 命中即更新 ts（LRU 活跃）
                        try {
                            var tx2 = db.transaction(P2P_STORE, 'readwrite');
                            tx2.objectStore(P2P_STORE).put(Object.assign({}, rec, { ts: Date.now() }));
                        } catch (e2) {}
                        resolve(rec);
                    };
                    req.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    function sessByNonce(nonce) {
        var tid = nonceIndex[nonce];
        return tid ? sessions[tid] : null;
    }
    // 进度上报（chat.js 注入 P2PFile.onProgress；节流 ~120ms 防刷屏，终态立即上报）
    var lastEmit = {};
    function emit(sess, phase, percent, speed) {
        var api = window.P2PFile;
        if (!api || typeof api.onProgress !== 'function') return;
        var now = Date.now();
        if (phase !== 'sent' && phase !== 'saved' && lastEmit[sess.id] && now - lastEmit[sess.id] < 120) return;
        lastEmit[sess.id] = now;
        var info = { nonce: sess.nonce, transfer_id: sess.id, role: sess.role, phase: phase, percent: percent, speed: speed || 0 };
        // saved 阶段附带接收完成的内存 blob 地址（chat.js 回填气泡 data-url 供点击复用）
        if (phase === 'saved' && recvFiles[sess.nonce]) info.url = recvFiles[sess.nonce].url;
        try {
            api.onProgress(info);
        } catch (e) { /* UI 回调异常不影响传输 */ }
    }

    // 信令发送（msg_type=91，from_user 由服务端以连接登录名归口，客户端不伪造）
    function sig(to, payload) {
        if (!window.IMSocket || !IMSocket.send || !IMSocket.isConnected()) return false;
        return IMSocket.send({ msg_type: 91, to_user: to, content: JSON.stringify(payload) });
    }
    // ICE 配置：服务端经信令注入 ice 键（TURN 启用时下发，复用通话链路 callInjectICE 口径）
    function iceConfOf(p) {
        if (p && Array.isArray(p.ice) && p.ice.length) return { iceServers: p.ice };
        return null;
    }

    // 会话清理（关连接、停定时器、摘除索引；recvFiles 保留供卡片点击复用）
    function cleanup(sess) {
        if (sess.timers) {
            if (sess.timers.negotiate) { clearTimeout(sess.timers.negotiate); sess.timers.negotiate = null; }
            if (sess.timers.watch) { clearInterval(sess.timers.watch); sess.timers.watch = null; }
            if (sess.timers.keep) { clearInterval(sess.timers.keep); sess.timers.keep = null; }
        }
        if (sess.pc) { try { sess.pc.close(); } catch (e) {} sess.pc = null; }
        sess.dc = null;
        if (sessions[sess.id] === sess) delete sessions[sess.id];
        if (nonceIndex[sess.nonce] === sess.id) delete nonceIndex[sess.nonce];
    }

    // 失败收口（设计 §7 回退矩阵）：发送方 abort 信令 + resolve(fallback) 由 chat.js 回退 HTTP 链路；
    // 接收方 abort 信令通知对方回退重传；reason=canceled 为用户主动取消（对端气泡同步移除）
    function fail(sess, reason) {
        if (sess.state === 'done' || sess.state === 'failed') return;
        sess.state = 'failed';
        sig(sess.peer, { action: 'abort', transfer_id: sess.id, reason: reason });
        if (sess.role === 'send' && sess.resolve) {
            var r = sess.resolve; sess.resolve = null;
            r({ fallback: true, reason: reason });
        }
        cleanup(sess);
    }
    function touch(sess) { sess.lastAct = Date.now(); }

    // ===== 发送方入口 =====
    function send(file, toUser, nonce) {
        return new Promise(function (resolve) {
            if (!available()) { resolve({ fallback: true, reason: 'unsupported' }); return; }
            if (!IMSocket.isConnected()) { resolve({ fallback: true, reason: 'offline' }); return; }
            var id = genId();
            var sess = {
                id: id, role: 'send', peer: toUser, nonce: nonce, file: file,
                state: 'negotiating', lastAct: Date.now(),
                conf: null, pc: null, dc: null, resolve: resolve,
                hasher: new Sha256(), sent: 0, acked: 0, speed: 0, lastAckAt: Date.now(), lastAckBytes: 0,
                timers: { negotiate: null, watch: null, keep: null }
            };
            sessions[id] = sess;
            nonceIndex[nonce] = id;
            // 协商超时兜底（服务端下发 negotiate_timeout；probe_fail 由信令即时回退不产生等待）
            sess.timers.negotiate = setTimeout(function () {
                if (sess.state === 'negotiating') fail(sess, 'timeout');
            }, Math.max(3, cfg.negotiateTimeout) * 1000);
            // 看门狗：30s 无任何数据/信令判死回退（设计 §7"假死"行）
            sess.timers.watch = setInterval(function () {
                if (Date.now() - sess.lastAct > 30000) fail(sess, 'watchdog');
            }, 5000);
            // 服务端会话保活：长传输期间每 15s ping（服务端刷新 LastActive 防懒清扫误杀，同帧转发对端喂看门狗）
            sess.timers.keep = setInterval(function () {
                if (sess.state === 'negotiating' || sess.state === 'sending' || sess.state === 'eof') {
                    sig(sess.peer, { action: 'ping', transfer_id: sess.id });
                }
            }, 15000);
            sig(toUser, {
                action: 'probe', transfer_id: id, name: file.name, size: file.size,
                mime: file.type || '', sha256: '', nonce: nonce
            });
        });
    }

    // 发送方 RTCPeerConnection（发送方为 offerer：accept 到达后建连发 offer）
    function buildSenderPC(sess) {
        var pc;
        try { pc = new RTCPeerConnection(sess.conf || {}); } catch (e) { fail(sess, 'pc_error'); return null; }
        sess.pc = pc;
        var dc = pc.createDataChannel('file-p2p', { ordered: true }); // reliable 默认（不设 maxRetransmits，零丢失）
        wireSenderDC(sess, dc);
        pc.onicecandidate = function (e) {
            if (e.candidate) sig(sess.peer, { action: 'candidate', transfer_id: sess.id, candidate: e.candidate.toJSON() });
        };
        pc.onconnectionstatechange = function () {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                if (sess.state === 'negotiating' || sess.state === 'sending' || sess.state === 'eof') fail(sess, 'channel_lost');
            }
        };
        return pc;
    }

    // 发送方数据面：dc open → 头帧 → ready → 分片泵（背压）→ eof → complete
    function wireSenderDC(sess, dc) {
        dc.binaryType = 'arraybuffer';
        sess.dc = dc;
        dc.onopen = function () {
            touch(sess);
            if (sess.timers.negotiate) { clearTimeout(sess.timers.negotiate); sess.timers.negotiate = null; }
            sess.state = 'sending';
            sess.total = Math.max(1, Math.ceil(sess.file.size / cfg.chunkSize));
            dc.send(JSON.stringify({
                t: 'head', transfer_id: sess.id, name: sess.file.name, size: sess.file.size,
                mime: sess.file.type || '', total: sess.total, chunk_size: cfg.chunkSize
            }));
            emit(sess, 'sending', 0, 0);
        };
        dc.onmessage = function (e) {
            touch(sess);
            var m = null;
            try { m = JSON.parse(e.data); } catch (err) { return; }
            if (!m) return;
            if (m.t === 'ready') { startPump(sess); }
            else if (m.t === 'ack') { onAck(sess, m); }
            else if (m.t === 'complete') { finishSender(sess); }
        };
        dc.onclose = function () {
            if (sess.state === 'sending' || sess.state === 'eof') fail(sess, 'channel_lost');
        };
        dc.onerror = function () {
            if (sess.state === 'sending' || sess.state === 'eof') fail(sess, 'channel_lost');
        };
    }

    // ack 推进（累计确认）：校正进度并按速率估算速度（EMA 平滑）
    function onAck(sess, m) {
        var next = m.next_seq || 0;
        if (next <= sess.acked) return;
        sess.acked = next;
        var now = Date.now();
        var dt = now - sess.lastAckAt;
        if (dt > 300) {
            var bps = ((next * cfg.chunkSize) - sess.lastAckBytes) / (dt / 1000);
            sess.speed = sess.speed ? Math.round(sess.speed * 0.6 + bps * 0.4) : Math.round(bps);
            sess.lastAckAt = now;
            sess.lastAckBytes = next * cfg.chunkSize;
        }
        emit(sess, 'sending', Math.min(99, (sess.sent / sess.file.size) * 100), sess.speed);
    }

    // 分片泵：读盘 → SHA-256 增量 → 入通道；bufferedAmount 超高水位暂停，低水位回调恢复
    function startPump(sess) {
        var dc = sess.dc;
        if (!dc || sess.state !== 'sending') return;
        var seq = 0, paused = false;
        dc.bufferedAmountLowThreshold = cfg.lowWater;
        dc.addEventListener('bufferedamountlow', function () {
            if (paused) { paused = false; pump(); }
        });
        function pump() {
            if (!sess.dc || sess.state !== 'sending') return;
            if (seq >= sess.total) { finishEof(sess); return; }
            if (dc.bufferedAmount >= cfg.highWater) { paused = true; return; } // 等 bufferedamountlow 恢复
            var start = seq * cfg.chunkSize;
            sess.file.slice(start, Math.min(start + cfg.chunkSize, sess.file.size)).arrayBuffer().then(function (buf) {
                if (!sess.dc || sess.state !== 'sending') return;
                sess.hasher.update(new Uint8Array(buf));
                try { dc.send(buf); } catch (e) { fail(sess, 'channel_lost'); return; }
                seq++;
                sess.sent = Math.min(sess.file.size, seq * cfg.chunkSize);
                emit(sess, 'sending', Math.min(99, (sess.sent / sess.file.size) * 100), sess.speed);
                pump();
            }).catch(function () { fail(sess, 'read_error'); });
        }
        pump();
    }

    // 全部分片入通道：eof 帧（携带边传边算的整文件哈希），等接收方终验 complete
    function finishEof(sess) {
        if (sess.state !== 'sending') return;
        sess.state = 'eof';
        try { sess.dc.send(JSON.stringify({ t: 'eof', sha256: sess.hasher.hex() })); } catch (e) { fail(sess, 'channel_lost'); return; }
        emit(sess, 'sent', 100, 0);
    }

    // 接收方终验通过：双方上报 done → 服务端归口落库 → done_ack 回填气泡（chat.js 处理）
    function finishSender(sess) {
        if (sess.state !== 'eof') return;
        sess.state = 'done';
        sig(sess.peer, { action: 'done', transfer_id: sess.id, sha256: sess.hasher.hex() });
        if (sess.resolve) { var r = sess.resolve; sess.resolve = null; r({ ok: true }); }
        cleanup(sess);
    }

    // ===== 接收方数据面：头帧 → ready → chunk（增量哈希 + 累计 ack）→ eof 终验 → complete =====
    function wireRecvDC(sess, dc) {
        dc.binaryType = 'arraybuffer'; // 必须显式设置：默认 blob 类型无法按序增量哈希
        sess.dc = dc;
        dc.onopen = function () { touch(sess); };
        dc.onmessage = function (e) {
            touch(sess);
            if (typeof e.data === 'string') {
                var m = null;
                try { m = JSON.parse(e.data); } catch (err) { return; }
                if (!m) return;
                if (m.t === 'head') onRecvHead(sess, dc, m);
                else if (m.t === 'eof') onRecvEof(sess, dc, m);
                return;
            }
            onRecvChunk(sess, dc, e.data);
        };
        dc.onclose = function () {
            if (sess.state === 'receiving') fail(sess, 'channel_lost'); // 通知发送方回退重传
        };
    }
    function onRecvHead(sess, dc, m) {
        if (m.transfer_id !== sess.id) return;
        sess.size = m.size || 0;
        sess.total = m.total || 1;
        sess.chunkSize = m.chunk_size || cfg.chunkSize;
        sess.mime = m.mime || '';
        try { dc.send(JSON.stringify({ t: 'ready' })); } catch (e) { fail(sess, 'channel_lost'); return; }
        sess.state = 'receiving';
        emit(sess, 'receiving', 0, 0);
    }
    function onRecvChunk(sess, dc, buf) {
        if (sess.state !== 'receiving') return;
        var u8 = new Uint8Array(buf);
        // 阶段一百五十八修复：分片必须推入 chunks 数组供 eof 后 blob 组装——原实现漏推入，
        // new Blob(空数组) 恒 0 字节（SHA-256 校验通过只证明传输面数据正确，内容并未留存，
        // 另存为落盘即空文件）
        sess.chunks.push(u8);
        sess.hasher.update(u8);
        sess.received += u8.length;
        sess.count++;
        // 累计 ACK：每 64 片回一帧（简化滑窗，发送方据此推进与判速）
        if (sess.count % 64 === 0) {
            try { dc.send(JSON.stringify({ t: 'ack', next_seq: sess.count })); } catch (e) {}
        }
        var now = Date.now();
        var dt = now - (sess.lastSpdAt || 0);
        if (dt > 500) {
            var bps = (sess.received - (sess.lastSpdBytes || 0)) / (dt / 1000);
            sess.speed = sess.speed ? Math.round(sess.speed * 0.6 + bps * 0.4) : Math.round(bps);
            sess.lastSpdAt = now;
            sess.lastSpdBytes = sess.received;
        }
        if (sess.size > 0) emit(sess, 'receiving', Math.min(99, (sess.received / sess.size) * 100), sess.speed);
    }
    function onRecvEof(sess, dc, m) {
        if (sess.state !== 'receiving') return;
        sess.state = 'verifying';
        try { dc.send(JSON.stringify({ t: 'ack', next_seq: sess.count })); } catch (e) {} // 最后一片补 ack
        var local = sess.hasher.hex();
        if (m.sha256 && m.sha256 !== local) {
            fail(sess, 'sha_mismatch'); // 终验失败：通知发送方 abort 回退 HTTP 全量重传（设计 §7）
            return;
        }
        try { dc.send(JSON.stringify({ t: 'complete' })); } catch (e) {}
        sig(sess.peer, { action: 'done', transfer_id: sess.id, sha256: local });
        sess.state = 'done';
        emit(sess, 'sent', 100, 0);
        // 组装 blob（异步大文件可能耗时），完成后内存留存（阶段一百五十八：不再自动触发下载）
        var blob = new Blob(sess.chunks, { type: sess.mime || 'application/octet-stream' });
        sess.chunks = null; // 释放分片数组引用（Blob 由浏览器接管，大文件自动落盘托管）
        var url = '';
        try { url = URL.createObjectURL(blob); } catch (e2) {}
        recvFiles[sess.nonce] = { url: url, name: safeName(sess.metaName), blob: blob, mime: sess.mime || '', size: sess.size };
        emit(sess, 'saved', 100, 0);
        // 原代码：接收完成立即自动创建 <a download> 触发下载（弹出系统保存框）——用户反馈不符合
        // 微信逻辑（对方还在传输中无任何提示就直接弹系统框）；现改为内存 blob 留存 + 聊天框
        // 微信同款文件卡片，接收方点击卡片"另存为"按钮才弹保存框（chat.js addP2PSaveBtn 归口）
        // if (url) {
        //     var a = document.createElement('a');
        //     a.href = url;
        //     a.download = recvFiles[sess.nonce].name;
        //     a.click();
        // }
        cleanup(sess);
    }

    // ===== 信令入口（socket.js dispatch 分发全部 91 帧） =====
    function onSignal(msg) {
        var p = {};
        try { p = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!p.action || !p.transfer_id) return;
        var sess = sessions[p.transfer_id];

        switch (p.action) {
            case 'probe':
                // 接收方：本端开关关闭 → 忽略（不 accept 也不 abort——abort 会在服务端删除会话，
                // 误杀本账号其他已 accept 端的传输；由发送方协商超时/服务端懒清扫兜底回退）
                if (!localEnabled() || !available()) return;
                if (sessions[p.transfer_id]) return; // 重复 probe 去重
                var rs = {
                    id: p.transfer_id, role: 'recv', peer: msg.from_user, nonce: p.nonce || '',
                    metaName: p.name || '', state: 'accepted', lastAct: Date.now(),
                    conf: iceConfOf(p), pc: null, dc: null,
                    hasher: new Sha256(), chunks: [], received: 0, count: 0, speed: 0,
                    size: p.size || 0, total: 0, chunkSize: cfg.chunkSize, mime: p.mime || '',
                    timers: { negotiate: null, watch: null, keep: null }
                };
                sessions[rs.id] = rs;
                nonceIndex[rs.nonce] = rs.id;
                rs.timers.watch = setInterval(function () {
                    if (Date.now() - rs.lastAct > 30000) fail(rs, 'watchdog');
                }, 5000);
                // 自动 accept（微信同款"在线即收"，先到先得由服务端归口唯一赢家）
                // 阶段一百五十六补丁：accept 必须回带 nonce（probe 携带的发送端气泡标识），
                // 服务端原样中继后发送方 UI 归口按 p2pPending[nonce] 建进度气泡——
                // 实测教训：缺 nonce 时发送方 accept 分支查不到条目，传输成功但发送端全程无 UI
                sig(msg.from_user, { action: 'accept', transfer_id: rs.id, platform: platform(), nonce: rs.nonce });
                break;
            case 'accept':
                // 发送方：锁定接收端 → 建连发 offer（conf 取 accept 帧注入的 ice）
                if (!sess || sess.role !== 'send' || sess.state !== 'negotiating') return;
                sess.state = 'accepted';
                sess.conf = iceConfOf(p);
                var pc = buildSenderPC(sess);
                if (!pc) return;
                emit(sess, 'negotiating', 0, 0); // 气泡显示"直传连接中"（accept 已到，SDP/ICE 协商期）
                pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
                    sig(sess.peer, { action: 'offer', transfer_id: sess.id, sdp: pc.localDescription.sdp });
                }).catch(function () { fail(sess, 'pc_error'); });
                break;
            case 'offer':
                // 接收方：建连应答（conf 取 offer 帧注入的 ice）
                if (!sess || sess.role !== 'recv' || sess.pc) return;
                var rpc;
                try { rpc = new RTCPeerConnection(sess.conf || {}); } catch (e2) { fail(sess, 'pc_error'); return; }
                sess.pc = rpc;
                rpc.ondatachannel = function (ev) { wireRecvDC(sess, ev.channel); };
                rpc.onicecandidate = function (e3) {
                    if (e3.candidate) sig(sess.peer, { action: 'candidate', transfer_id: sess.id, candidate: e3.candidate.toJSON() });
                };
                rpc.onconnectionstatechange = function () {
                    if (rpc.connectionState === 'failed' || rpc.connectionState === 'closed') {
                        if (sess.state === 'accepted' || sess.state === 'receiving') fail(sess, 'channel_lost');
                    }
                };
                rpc.setRemoteDescription({ type: 'offer', sdp: p.sdp }).then(function () {
                    sess.remoteSet = true;
                    return rpc.createAnswer();
                }).then(function (ans) { return rpc.setLocalDescription(ans); }).then(function () {
                    sig(sess.peer, { action: 'answer', transfer_id: sess.id, sdp: rpc.localDescription.sdp });
                    flushCands(sess);
                }).catch(function () { fail(sess, 'pc_error'); });
                break;
            case 'answer':
                if (!sess || sess.role !== 'send' || !sess.pc || sess.remoteSet) return;
                sess.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).then(function () {
                    sess.remoteSet = true;
                    flushCands(sess);
                }).catch(function () { fail(sess, 'pc_error'); });
                break;
            case 'candidate':
                if (!sess || !sess.pc) return;
                if (!p.candidate || !p.candidate.candidate) return; // 端尾候选忽略
                if (!sess.remoteSet) {
                    sess.candQueue = sess.candQueue || [];
                    sess.candQueue.push(p.candidate); // 远端描述未就绪先排队（避免 ICE 候选早到丢失）
                } else {
                    sess.pc.addIceCandidate(p.candidate).catch(function () {});
                }
                touch(sess);
                break;
            case 'ping':
                // 保活帧：刷新本端看门狗（服务端同时刷新会话活跃防懒清扫误杀）
                if (sess) touch(sess);
                break;
            case 'abort':
                // 对端/服务端中止：本地静默清理（气泡移除与提示由 chat.js 的 91 UI 归口处理）
                if (sess) {
                    if (sess.role === 'send' && sess.resolve) {
                        var r2 = sess.resolve; sess.resolve = null;
                        sess.state = 'failed';
                        r2({ fallback: true, reason: p.reason || 'peer_abort' });
                    }
                    cleanup(sess);
                }
                break;
            case 'probe_fail':
                // 服务端归口拒绝（disabled/toobig/busy/offline/forbidden）：立即回退，无等待
                if (sess && sess.role === 'send') {
                    if (sess.resolve) {
                        var r3 = sess.resolve; sess.resolve = null;
                        sess.state = 'failed';
                        r3({ fallback: true, reason: p.reason || 'probe_fail' });
                    }
                    cleanup(sess);
                }
                break;
            // done / done_ack：引擎不处理（done 由数据面完成时上报；done_ack 气泡回填由 chat.js 归口）
        }
    }

    // 排队的 ICE 候选补投（远端描述就绪后）
    function flushCands(sess) {
        var q = sess.candQueue || [];
        sess.candQueue = [];
        for (var i = 0; i < q.length; i++) {
            try { sess.pc.addIceCandidate(q[i]).catch(function () {}); } catch (e) {}
        }
    }

    // ===== 阶段一百五十九：缓存归口（done_ack msg_id 回填时写入 / 历史渲染时读回），设置-网络页双开关归口 =====
    // 用户反馈默认值：自动落盘默认开（im_p2p_disk_save !== '0'）、本地缓存默认关（im_p2p_idb_cache === '1' 才开）
    function cacheOn(key) {
        try {
            var v = localStorage.getItem(key);
            return key === 'im_p2p_idb_cache' ? v === '1' : v !== '0';
        } catch (e) { return key !== 'im_p2p_idb_cache'; }
    }
    function myUsername() {
        try { return (window.IMSocket && window.IMSocket.getUsername && window.IMSocket.getUsername()) || ''; } catch (e) { return ''; }
    }
    // 接收端缓存写入：chat.js done_ack（msg_id 已知）调用；发送端无接收 blob 引擎内部判空跳过
    function cacheReceived(nonce, msgId) {
        var f = recvFiles[nonce];
        if (!f || !f.blob || !msgId) return;
        // IndexedDB 缓存（开关 im_p2p_idb_cache，默认开）
        if (cacheOn('im_p2p_idb_cache')) {
            dbPut(msgId, f.blob, f.name, f.mime, f.size).catch(function () {});
        }
        // PC 端磁盘静默落盘（开关 im_p2p_disk_save，默认开；%APPDATA%/<应用名>/received_files/<账号>/）
        if (cacheOn('im_p2p_disk_save') && window.desktop && window.desktop.saveP2PFile) {
            f.blob.arrayBuffer().then(function (buf) {
                return window.desktop.saveP2PFile({ username: myUsername(), msg_id: msgId, name: f.name, buf: buf });
            }).then(function (r) {
                if (r && r.ok) console.log('P2P 接收文件已落盘: ' + r.path);
            }).catch(function () {});
        }
    }
    // 历史渲染回填：IndexedDB 命中 → 内存 blob url；未命中且 PC 端 → 磁盘读回 blob url
    // 返回 Promise<{url, name} | null>，chat.js 命中后回填 data-url 恢复"另存为"/预览
    function cacheGet(msgId, name) {
        if (!cacheOn('im_p2p_idb_cache')) return diskGet(msgId, name);
        return dbGet(msgId).then(function (rec) {
            if (rec && rec.blob) {
                try {
                    return {
                        url: URL.createObjectURL(rec.blob),
                        name: rec.name || name || 'file',
                        blob: rec.blob,              // 阶段二百二十一：携带本体（保存到设备免二次 fetch）
                        mime: rec.mime || ''
                    };
                } catch (e) {}
            }
            return diskGet(msgId, name);
        });
    }
    function diskGet(msgId, name) {
        if (!cacheOn('im_p2p_disk_save') || !window.desktop || !window.desktop.readP2PFile) {
            return Promise.resolve(null);
        }
        return window.desktop.readP2PFile({ username: myUsername(), msg_id: msgId, name: name || '' }).then(function (r) {
            if (r && r.ok && r.buf) {
                try {
                    var blob = new Blob([r.buf]);
                    return { url: URL.createObjectURL(blob), name: r.name || name || 'file', blob: blob, mime: '' };
                } catch (e) {}
            }
            return null;
        }).catch(function () { return null; });
    }
    // 阶段一百五十九补：手动清理（设置-网络"缓存清理"按钮）——清空 IndexedDB 全部缓存 +
    // PC 端磁盘缓存目录（web 端无桥仅清 IDB，disk 返回 null）；清理后历史卡片回填失效回到原提示
    // 阶段二百八十一：追加清空 APP 下载缓存目录（imfile/，微信同款"清理缓存"语义）
    function cacheClear() {
        var idbDone = dbOpen().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(P2P_STORE, 'readwrite');
                    tx.objectStore(P2P_STORE).clear();
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { resolve(false); };
                } catch (e) { resolve(false); }
            });
        });
        var diskDone = null;
        if (window.desktop && window.desktop.clearP2PFiles) {
            diskDone = window.desktop.clearP2PFiles({ username: myUsername() }).then(function (r) {
                return !!(r && r.ok);
            }).catch(function () { return false; });
        }
        // APP 下载缓存目录（不存在的目录 rmdir 抛错 → 视为已清空 true）
        var Pc = window.Capacitor && window.Capacitor.Plugins;
        var appCacheDone = null;
        if (Pc && Pc.Filesystem) {
            appCacheDone = Pc.Filesystem.rmdir({ path: DL_CACHE_DIR, directory: 'CACHE', recursive: true })
                .then(function () { return true; })
                .catch(function () { return true; });
        }
        return Promise.all([idbDone, diskDone, appCacheDone]).then(function (rs) {
            return { idb: rs[0] === true, disk: rs[1] === null ? null : rs[1], appCache: rs[2] === null ? null : rs[2] === true };
        });
    }

    // ===== 对外 API =====
    // ===== 阶段二百二十一：APP 端「点击即下载到设备并系统打开」（微信文件同款体验） =====
    // 链路：blob → base64 → Capacitor Filesystem 写入应用 Documents 目录 → FileOpener 调起
    // 系统应用按 mime 打开（pdf→PDF 查看器、docx→Office、zip→解压工具……）。
    // 仅 Capacitor 原生环境生效；PC/WEB 端自动旁路（走既有预览/另存为链路）。
    function extMime(name) {
        var n = (name || '').toLowerCase();
        var map = {
            '.pdf': 'application/pdf', '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.ppt': 'application/vnd.ms-powerpoint',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
            '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
            '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
            '.apk': 'application/vnd.android.package-archive'
        };
        var i = n.lastIndexOf('.');
        return (i >= 0 && map[n.substring(i)]) || 'application/octet-stream';
    }
    // 分块转 base64（FileReader 已被 PPTXjs 污染不可用；大文件 String.fromCharCode 分块防爆栈）
    function blobToB64(blob) {
        return new Response(blob).arrayBuffer().then(function (buf) {
            var bytes = new Uint8Array(buf);
            var CHUNK = 0x8000;
            var bin = '';
            for (var i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return btoa(bin);
        });
    }
    function saveOpen(blob, name, mime) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        if (!P || !P.Filesystem || !P.FileOpener) return Promise.resolve(false);
        return writeDevice(blob, name).then(function (res) {
            return P.FileOpener.open({
                filePath: res.uri,
                mimeType: mime || extMime(name)
            });
        }).then(function () {
            if (window.__imToast) window.__imToast(I18N_COMPAT('已保存，正在打开…'));
            return true;
        }).catch(function (e) {
            if (window.__imToast) window.__imToast(I18N_COMPAT('无法打开该文件类型'));
            return false;
        });
    }
    // 仅保存不打开（文件卡片"保存到设备"图标归口）
    // ===== 阶段二百八十：分块落盘（OOM 闪退修复） =====
    // 原实现整文件 blobToB64 一次写入：arrayBuffer + latin1 串 + base64 串三份驻留 ≈ 体积×3.3，
    // 161.9MB 文件叠加 Blob 本体冲爆 WebView 堆上限（用户实测下载完成瞬间 APP 闪退）。
    // 改为 4MB 分片逐块 append 写入：内存恒定 = 单分片 ≈13MB，任意大小文件安全。
    var WRITE_CHUNK = 4 * 1024 * 1024;
    function writeDevice(blob, name) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        if (!P || !P.Filesystem) return Promise.reject(new Error('no-plugin'));
        var FS = P.Filesystem;
        return FS.writeFile({ path: name, data: '', directory: 'DOCUMENTS', recursive: true }).then(function (first) {
            var uri = first && first.uri;
            var off = 0;
            function step() {
                if (off >= blob.size) return uri;
                var end = Math.min(blob.size, off + WRITE_CHUNK);
                return blobToB64(blob.slice(off, end)).then(function (b64) {
                    return FS.writeFile({ path: name, data: b64, directory: 'DOCUMENTS', recursive: true, append: true });
                }).then(function (w) {
                    if (w && w.uri) uri = w.uri;
                    off = end;
                    return step();
                });
            }
            return step();
        });
    }
    // I18N 兼容（p2p-file.js 不依赖 I18N，缺省直返）
    function I18N_COMPAT(s) { return (window.I18N && window.I18N.t) ? window.I18N.t(s) : s; }
    // 缓存取本体（saveAndOpen/saveOnly 共用）：IDB/磁盘命中 → {blob|url, name, mime}
    function cacheBlob(msgId, name) {
        return cacheGet(msgId, name).then(function (hit) {
            return (hit && (hit.blob || hit.url)) ? hit : null;
        });
    }
    // 内存 blob url（在线接收回填）→ fetch → 保存并系统打开
    function saveOpenUrl(url, name) {
        return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
            return saveOpen(b, name, b.type);
        }).catch(function () {
            if (window.__imToast) window.__imToast(I18N_COMPAT('无法打开该文件类型'));
            return false;
        });
    }
    // 内存 blob url → fetch → 仅写设备（图标保存归口内部步骤）
    function saveBlobUrlWrite(url, name) {
        return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
            return writeDevice(b, name);
        });
    }

    // ===== 阶段二百八十一：下载文件本地缓存（微信同款"点开即看"） =====
    // 缓存键=服务端文件 URL（上传文件名含纳秒时间戳+随机数全局唯一、内容不可变，转发副本
    // 同 URL 自动复用同一缓存，微信同款去重）。存 Directory.Cache（系统磁盘紧张可自动回收，
    // 丢失即重新下载，无一致性风险）；file_paths.xml 已声明 cache-path，FileOpener 可直接
    // 授权打开。"缓存清理"按钮经 cacheClear 一并清空。
    var DL_CACHE_DIR = 'imfile';
    function dlCachePath(url, name) {
        // 扩展名从 URL 尾段取（转发改名不影响命中），回退 name 后缀
        var m = (url || '').match(/\.([A-Za-z0-9]{1,8})(?:$|\?)/);
        var ext = m ? m[1].toLowerCase() : (function () {
            var n = (name || '').match(/\.([A-Za-z0-9]{1,8})$/);
            return n ? n[1].toLowerCase() : '';
        })();
        return DL_CACHE_DIR + '/' + encodeURIComponent(url || '') + (ext ? '.' + ext : '');
    }
    function dlCacheGet(url, name) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        if (!P || !P.Filesystem || !url) return Promise.resolve(null);
        var FS = P.Filesystem;
        var path = dlCachePath(url, name);
        return FS.stat({ path: path, directory: 'CACHE', recursive: true }).then(function () {
            return FS.getUri({ path: path, directory: 'CACHE' }).then(function (u) {
                return (u && u.uri) ? { uri: u.uri, path: path } : null;
            });
        }).catch(function () { return null; }); // 系统回收/未下载 → null 走下载
    }
    // 缓存命中直接系统打开（微信同款秒开，零下载）；未命中返回 false 由调用方走流式下载
    function openCached(url, name) {
        return dlCacheGet(url, name).then(function (c) {
            if (!c || !c.uri || dlWriting[c.path]) return false; // 写入中的半成品视为未命中
            var P = window.Capacitor && window.Capacitor.Plugins;
            if (!P || !P.FileOpener) return false;
            return P.FileOpener.open({ filePath: c.uri, mimeType: extMime(name || 'file') }).then(function () {
                if (window.__imToast) window.__imToast(I18N_COMPAT('已从缓存打开'));
                return true;
            }).catch(function () {
                if (window.__imToast) window.__imToast(I18N_COMPAT('已从缓存打开（无应用可打开该文件类型）'));
                return true; // 文件已在本地，打开失败仅提示类型问题，不重复下载
            });
        }).catch(function () { return false; });
    }

    // ===== 阶段二百八十三：预览页缓存读/写归口（在线预览与"下载"按钮共用同一份本地缓存） =====
    // 读：readFile（base64）→ 分块 atob 转 Blob。分块转换避免整文件 binary 串中间态
    //（峰值 = base64 串 + 输出 bytes + 单块 ~3MB 串，而非三者整文件叠加冲爆堆——OOM 前车之鉴）。
    // 写：4MB 分片 append（与 downloadFromUrl 缓存落盘同格式同键，openCached/dlCacheGet 直接命中）。
    // 供 pptx-preview.html / doc-preview.html 预览前查缓存（微信同款：第二次打开零下载秒开），
    // 预览下载完成后回写，预览页右上"下载"按钮经 openCached 同键秒开。blob:/data: 不缓存。
    // dlWriting：按目标路径的写入锁——半成品文件对 cacheRead/openCached 不可见（视为未缓存），
    // 并发 downloadFromUrl/cacheWrite 同键直接拒绝，杜绝"读到/写出损坏的半截缓存"
    var dlWriting = {};
    function cacheRead(url, name, maxBytes) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        if (!P || !P.Filesystem || !url ||
            url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return Promise.resolve(null);
        var FS = P.Filesystem;
        var path = dlCachePath(url, name);
        if (dlWriting[path]) return Promise.resolve(null); // 写入中（半成品）→ 视为未缓存走下载
        return FS.stat({ path: path, directory: 'CACHE', recursive: true }).then(function (s) {
            var size = (s && s.size) || 0;
            // 阶段二百八十三：超大缓存文件拒绝整文件读回——Filesystem.readFile 的 Java 侧
            // byte[] + Base64 字符串双份驻留 ≈ 体积×3.7，161.9MB 即 ~600MB 直接 OOM 闪退
            //（用户实测"已从本地缓存读取"后闪退）。返回 tooBig 由调用方走系统打开（微信同款：
            // 大文件不在线解析，交本地应用）。maxBytes 不传则不限制。
            if (maxBytes && size > maxBytes) {
                return FS.getUri({ path: path, directory: 'CACHE' }).then(function (u) {
                    return { tooBig: true, size: size, uri: (u && u.uri) || '' };
                });
            }
            return FS.readFile({ path: path, directory: 'CACHE' }).then(function (r) {
                var b64 = (r && r.data) || '';
                if (!b64) return null;
                var out = new Uint8Array(Math.max(0, Math.floor(b64.length * 3 / 4)));
                var CH = 4 * 1024 * 1024, pos = 0, i, bin, j; // CH 为 4 的倍数：块边界不截断 base64 编码单元
                for (i = 0; i < b64.length; i += CH) {
                    bin = atob(b64.substr(i, CH));
                    for (j = 0; j < bin.length; j++) out[pos + j] = bin.charCodeAt(j);
                    pos += bin.length;
                }
                return out.subarray(0, pos); // 返回 Uint8Array（不包 Blob：省一份整文件拷贝，调用方按需取 buffer）
            });
        }).catch(function () { return null; }); // 未缓存/系统已回收 → null 走下载
    }
    function cacheWrite(url, name, blob) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        if (!P || !P.Filesystem || !url || !blob ||
            url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return Promise.resolve(false);
        var FS = P.Filesystem;
        var path = dlCachePath(url, name);
        if (dlWriting[path]) return Promise.resolve(false); // 同键已在写入（流式下载/回写中）：拒绝并发写
        dlWriting[path] = true;
        return FS.writeFile({ path: path, data: '', directory: 'CACHE', recursive: true }).then(function () {
            var off = 0;
            function step() {
                if (off >= blob.size) return true;
                var end = Math.min(blob.size, off + WRITE_CHUNK);
                return blobToB64(blob.slice(off, end)).then(function (b64) {
                    return FS.writeFile({ path: path, data: b64, directory: 'CACHE', recursive: true, append: true });
                }).then(function () { off = end; return step(); });
            }
            return step();
        }).catch(function () {
            // 失败清理半成品：损坏缓存比无缓存更糟（下次命中会解析出错），宁缺勿错
            FS.deleteFile({ path: path, directory: 'CACHE', recursive: true }).catch(function () {});
            return false;
        }).then(function (ok) {
            delete dlWriting[path];
            return ok;
        });
    }

    // ===== 阶段二百八十：流式下载直写磁盘（微信同款大文件安全路径，OOM 修复核心） =====
    // fetch 流式读取 → 2MB 聚合缓冲 → base64 → Filesystem append 落盘，循环至完成。
    // 全程不组装整文件 Blob / arrayBuffer / 巨型 base64（内存恒定 ≈ 单缓冲 5MB）——
    // 原链路整文件 blob 化 + blobToB64 三份驻留 ≈ 体积×4.3，161.9MB 文件下载完成瞬间
    // OOM 闪退（用户实测）。onProgress(loaded, total) 驱动进度浮层；open=true 完成后
    // FileOpener 系统打开（微信同款），open=false 仅保存。返回 { promise, abort() }：
    // 中止/失败 best-effort 清理半成品文件。
    // 阶段二百八十一：open 模式写入应用缓存目录（微信同款——下次点开命中缓存秒开零下载）；
    // save 模式（"保存到设备"图标）仍写 Documents 供用户直接取用。
    var DL_BUF = 2 * 1024 * 1024;
    function downloadFromUrl(url, name, onProgress, open) {
        var P = window.Capacitor && window.Capacitor.Plugins;
        var fname = name || 'file';
        var destPath = (open === false) ? fname : dlCachePath(url, name);
        var destDir = (open === false) ? 'DOCUMENTS' : 'CACHE';
        var handle = { promise: null, aborted: false, abort: function () { handle.aborted = true; } };
        if (!P || !P.Filesystem || !url) {
            handle.promise = Promise.reject(new Error('no-plugin'));
            return handle;
        }
        var FS = P.Filesystem;
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        handle.abort = function () { handle.aborted = true; if (ctrl) ctrl.abort(); };
        // 阶段二百八十三：同目标路径已在写入（预览回写/重复下载）→ 拒绝，防止并发写损坏
        if (dlWriting[destPath]) {
            handle.promise = Promise.reject(new Error('busy'));
            return handle;
        }
        dlWriting[destPath] = true;
        function safeProg(l, t) { if (onProgress) { try { onProgress(l, t); } catch (_) {} } }
        handle.promise = fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
            return FS.writeFile({ path: destPath, data: '', directory: destDir, recursive: true }).then(function (first) {
                var uri = first && first.uri;
                var pend = [], pendSize = 0, loaded = 0;
                function flush() {
                    if (!pend.length) return Promise.resolve();
                    var blob = new Blob(pend); // 仅 ~2MB 聚合片，恒定内存
                    pend = []; pendSize = 0;
                    return blobToB64(blob).then(function (b64) {
                        return FS.writeFile({ path: destPath, data: b64, directory: destDir, recursive: true, append: true });
                    }).then(function (w) { if (w && w.uri) uri = w.uri; });
                }
                function pump() {
                    if (!res.body) { // 无流式能力降级：整取（小文件/老环境，writeDevice 分块兜底）
                        return res.blob().then(function (b) { pend = [b]; loaded = b.size; safeProg(loaded, total); return flush(); });
                    }
                    var reader = res.body.getReader();
                    function read() {
                        return reader.read().then(function (r) {
                            if (r.done) return flush();
                            pend.push(r.value);
                            loaded += r.value.length;
                            pendSize += r.value.length;
                            safeProg(loaded, total);
                            if (pendSize >= DL_BUF) return flush().then(read);
                            return read();
                        });
                    }
                    return read();
                }
                return pump().then(function () {
                    if (uri) return { uri: uri };
                    return FS.getUri({ path: destPath, directory: destDir }).catch(function () { return { uri: '' }; });
                }).then(function (u) {
                    if (open !== false && P.FileOpener && u && u.uri) {
                        return P.FileOpener.open({ filePath: u.uri, mimeType: extMime(fname) }).then(function () {
                            if (window.__imToast) window.__imToast(I18N_COMPAT('已下载，正在打开…'));
                            return { uri: u.uri, bytes: loaded };
                        }).catch(function () {
                            if (window.__imToast) window.__imToast(I18N_COMPAT('已下载（无应用可打开该文件类型）'));
                            return { uri: u.uri, bytes: loaded };
                        });
                    }
                    if (window.__imToast) window.__imToast(I18N_COMPAT('已保存到设备 Documents'));
                    return { uri: u && u.uri, bytes: loaded };
                });
            });
        }).catch(function (err) {
            // 中止/失败：清理半成品（best-effort；首次建文件后才可能残留）
            FS.deleteFile({ path: destPath, directory: destDir, recursive: true }).catch(function () {});
            throw err;
        });
        // 阶段二百八十三：成功/失败双分支释放写入锁（半成品已在上方清理，锁随链路结束失效）
        handle.promise = handle.promise.then(
            function (r) { delete dlWriting[destPath]; return r; },
            function (e) { delete dlWriting[destPath]; throw e; }
        );
        return handle;
    }

    window.P2PFile = {
        send: send,
        onSignal: onSignal,
        onProgress: null, // chat.js 注入（function(info)）
        config: function (c) {
            if (!c || typeof c !== 'object') return;
            if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
            if (c.threshold > 0) cfg.threshold = c.threshold;
            if (c.negotiateTimeout > 0) cfg.negotiateTimeout = c.negotiateTimeout;
            if (c.chunkSize > 0) cfg.chunkSize = c.chunkSize;
            if (c.highWater > 0) cfg.highWater = c.highWater;
            if (c.lowWater > 0) cfg.lowWater = c.lowWater;
            if (typeof c.archive === 'boolean') cfg.archive = c.archive;
        },
        cancelByNonce: function (nonce) {
            var sess = sessByNonce(nonce);
            if (sess) fail(sess, 'canceled');
        },
        receivedURL: function (nonce) {
            var f = recvFiles[nonce];
            return f ? (f.url || '') : '';
        },
        // 阶段一百五十九：接收文件缓存归口（chat.js done_ack 写入 / 历史渲染读回）
        cacheReceived: cacheReceived,
        cacheGet: cacheGet,
        // 阶段二百二十一：APP 端本地生成内容（聊天记录 txt 导出等）保存到设备并打开
        saveBlob: function (blob, name, mime) {
            return saveOpen(blob, name, mime);
        },
        // 阶段二百二十一：APP 端点击直传卡片 → 本机缓存 blob → 保存到设备并系统打开
        // （cacheGet 返回 blob 本体或 blob url，两者均归口）
        saveAndOpen: function (msgId, name) {
            return cacheBlob(msgId, name).then(function (p) {
                if (!p) {
                    if (window.__imToast) window.__imToast(I18N_COMPAT('文件不在本机，请对方重新发送'));
                    return false;
                }
                return p.blob ? saveOpen(p.blob, p.name, p.mime) : saveOpenUrl(p.url, p.name);
            });
        },
        // 阶段二百二十一：仅保存到设备不打开（文件卡片"保存到设备"图标归口）
        saveOnly: function (msgId, name) {
            return cacheBlob(msgId, name).then(function (p) {
                if (!p) {
                    if (window.__imToast) window.__imToast(I18N_COMPAT('文件不在本机，请对方重新发送'));
                    return false;
                }
                var w = p.blob ? writeDevice(p.blob, p.name) : saveBlobUrlWrite(p.url, p.name);
                return w.then(function () {
                    if (window.__imToast) window.__imToast(I18N_COMPAT('已保存到设备 Documents'));
                    return true;
                }).catch(function () {
                    if (window.__imToast) window.__imToast(I18N_COMPAT('保存失败'));
                    return false;
                });
            });
        },
        // 阶段二百二十一：APP 端下载分支归口（服务器文件 fetch → 保存 → 系统打开）
        // open=false 时仅保存不打开（文件卡片"保存到设备"图标归口）
        openFromUrl: function (url, name, open) {
            if (!url) return Promise.resolve(false);
            return fetch(url).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.blob();
            }).then(function (b) {
                if (open === false) {
                    return writeDevice(b, name || 'file').then(function () {
                        if (window.__imToast) window.__imToast(I18N_COMPAT('已保存到设备 Documents'));
                        return true;
                    }).catch(function () {
                        if (window.__imToast) window.__imToast(I18N_COMPAT('保存失败'));
                        return false;
                    });
                }
                return saveOpen(b, name || 'file', b.type);
            }).catch(function () {
                if (window.__imToast) window.__imToast(I18N_COMPAT('文件下载失败'));
                return false;
            });
        },
        // 阶段二百七十九：APP 端带进度下载的落盘归口（chat.js 进度浮层完成后调用）
        // openBlob = 保存并系统打开（微信同款"下载完成即打开"）；writeBlob = 仅保存不打开（"保存到设备"图标归口）
        openBlob: function (blob, name) {
            return saveOpen(blob, name || 'file', blob && blob.type);
        },
        writeBlob: function (blob, name) {
            return writeDevice(blob, name || 'file').then(function () {
                if (window.__imToast) window.__imToast(I18N_COMPAT('已保存到设备 Documents'));
                return true;
            }).catch(function () {
                if (window.__imToast) window.__imToast(I18N_COMPAT('保存失败'));
                return false;
            });
        },
        // 阶段二百八十：流式下载直写磁盘（大文件恒定内存，chat.js 进度浮层驱动）
        downloadFromUrl: downloadFromUrl,
        // 阶段二百八十一：下载缓存（微信同款"点开即看"）——命中返回 uri 并系统打开，未命中 false
        openCached: openCached,
        dlCacheGet: dlCacheGet,
        // 阶段二百八十三：预览页缓存读/写归口（pptx-preview.html / doc-preview.html 接入）
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        // 阶段一百五十九补：手动清理（设置-网络"缓存清理"按钮）
        cacheClear: cacheClear,
        localEnabled: localEnabled,
        available: available,
        getChunkSize: function () { return cfg.chunkSize; }
    };
})();
