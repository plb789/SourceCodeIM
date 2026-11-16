/**
 * ImGameSDK — PC 客户端成就桥接 SDK（方案 §14.4 链路 B，仅 PC 端，APP 端不做）
 *
 * 宿主：PC 客户端 Web 层（game-store.html 加载；自研游戏/网页游戏 WebView 可由主进程
 * executeJavaScript 注入本文件后直接调用）。游戏侧无需知道服务端地址与密钥派生方式。
 *
 * 对外 API（window.ImGameSDK）：
 *   setSession(gameId, signKey)            宿主喂会话签名密钥（库/详情接口 session_sign_key）
 *   unlockAchievement(code, gameId?)       上报单条成就解锁 → Promise<{ok, already?, exp_gain?}>
 *   getUnlockedAchievements(gameId?)       已解锁列表（内存缓存 + 服务端同步）→ Promise<items[]>
 *
 * 上报协议：POST /api/game/achievement/unlock（登录态 X-Drive-Token + 会话签名 X-Game-Signature）
 *   canonicalMessage = client_ts + "\n" + nonce + "\n" + sha256(bodyBytes)_hex   （与服务端口径冻结一致）
 *   signature        = hex(hmac_sha256(session_sign_key, canonicalMessage))
 *
 * 失败策略（方案 §14.4.3）：
 *   - 网络失败 / 限流 → 本地队列退避重试 5s/30s/120s，最多 3 次，仍失败静默丢弃；
 *   - 「成就不存在」→ 静默丢弃（游戏版本与服务端定义不一致时不打扰用户）；
 *   - already: true → 静默成功（幂等，不重复弹 toast）；
 *   - 首次解锁成功 → 本窗 AchievementToast.show（主窗口 toast 由服务端 WS 122 帧归口，双端去重）。
 */
(function () {
    'use strict';

    var RETRY_DELAYS = [5000, 30000, 120000];
    var sessions = {};       // gameId → signKey（内存态，随窗口生命周期）
    var activeGid = null;    // 最近一次喂入的游戏（游戏侧不传 gameId 时的上下文兜底）
    var unlockedCache = {};  // gameId → items[]（getUnlockedAchievements 内存缓存）
    var pending = {};        // gameId:code → 1（防同条成就重复入队/重复请求）

    function t(s) {
        try { if (window.I18N && I18N.t) return I18N.t(s); } catch (e) { /* 无 I18N 环境兜底原文 */ }
        return s;
    }

    function userName() {
        try { return localStorage.getItem('username') || ''; } catch (e) { return ''; }
    }

    function driveToken() {
        try { return localStorage.getItem('drive_token') || ''; } catch (e) { return ''; }
    }

    function resolveGid(gameId) {
        var gid = parseInt(gameId, 10) || activeGid || 0;
        return (gid > 0 && sessions[gid]) ? gid : 0;
    }

    function randHex(n) {
        var out = '';
        for (var i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
        return out;
    }

    function strBytes(s) {
        if (window.TextEncoder) return new TextEncoder().encode(s);
        // 兜底：仅覆盖 ASCII（成就 code/数字字段均为 ASCII，中文不出现在上报体）
        var b = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
        return b;
    }

    // ===== HMAC-SHA256（基于项目内 SHA256Stream 流式实现，sha256.js 须先加载） =====
    function sha256Hex(bytes) {
        var h = window.SHA256Stream.create();
        h.update(bytes);
        return h.final();
    }

    function hmacSha256Hex(keyHex, msgBytes) {
        var key = [];
        for (var i = 0; i < keyHex.length; i += 2) key.push(parseInt(keyHex.substr(i, 2), 16));
        if (key.length > 64) key = hexToBytes(sha256Hex(new Uint8Array(key)));
        var ipad = new Uint8Array(64 + msgBytes.length);
        var opad = new Uint8Array(64 + 32);
        for (var j = 0; j < 64; j++) {
            var kb = j < key.length ? key[j] : 0;
            ipad[j] = kb ^ 0x36;
            opad[j] = kb ^ 0x5c;
        }
        ipad.set(msgBytes, 64);
        var inner = hexToBytes(sha256Hex(ipad));
        opad.set(inner, 64);
        return sha256Hex(opad);
    }

    function hexToBytes(hex) {
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    // ===== 上报执行（单次尝试） =====
    function attempt(gid, code) {
        var signKey = sessions[gid];
        if (!signKey) return Promise.resolve({ ok: false, retry: false, reason: 'no_session' });

        var bodyObj = {
            game_id: gid,
            achievement_code: code,
            client_ts: Math.floor(Date.now() / 1000),
            nonce: randHex(24)
        };
        var bodyStr = JSON.stringify(bodyObj);
        var bodyBytes = strBytes(bodyStr);
        var canonical = bodyObj.client_ts + '\n' + bodyObj.nonce + '\n' + sha256Hex(bodyBytes);
        var sig;
        try { sig = hmacSha256Hex(signKey, strBytes(canonical)); } catch (e) {
            return Promise.resolve({ ok: false, retry: false, reason: 'sign_error' });
        }

        var qs = '';
        var un = userName();
        if (un) qs = '?username=' + encodeURIComponent(un);
        var headers = { 'Content-Type': 'application/json', 'X-Game-Signature': sig };
        var tk = driveToken();
        if (tk) headers['X-Drive-Token'] = tk;

        return fetch(location.origin + '/api/game/achievement/unlock' + qs, {
            method: 'POST', headers: headers, body: bodyStr
        }).then(function (r) { return r.json(); }).then(function (res) {
            if (res && res.ok && res.data) {
                return { ok: true, already: !!res.data.already, data: res.data };
            }
            var msg = (res && (res.msg || res.err)) || '';
            var drop = /成就不存在|尚未加入|请先登录|签名校验失败|成就标识过长|参数不完整/.test(msg);
            return { ok: false, retry: !drop, reason: msg };
        }).catch(function () {
            return { ok: false, retry: true, reason: t('网络异常') };
        });
    }

    function finishUnlock(gid, code, result) {
        delete pending[gid + ':' + code];
        if (!result.ok) {
            console.warn('[ImGameSDK] 成就上报失败（已放弃重试）', gid, code, result.reason);
            return;
        }
        if (result.already) return; // 幂等静默成功，不重复弹 toast
        // 本窗直接弹 toast（主窗口由服务端 WS 122 帧归口；同 code 6s 窗口互斥去重）
        var d = result.data || {};
        if (window.AchievementToast) {
            var ach = d.achievement || {};
            window.AchievementToast.show({
                game_id: gid, code: code,
                name: ach.name || code, desc: ach.desc || '',
                icon: ach.icon || '', rarity: ach.rarity || 0,
                exp_reward: d.exp_gain || 0,
                level_up: !!d.level_up, new_level: d.new_level || 0
            });
        }
        if (unlockedCache[gid]) unlockedCache[gid] = null; // 失效缓存，下次查询回源
    }

    function submit(gid, code, attemptNo) {
        attempt(gid, code).then(function (result) {
            if (result.ok || !result.retry) { finishUnlock(gid, code, result); return; }
            // 退避重试：网络失败/限流 → 5s/30s/120s，最多 3 次（方案 §14.4.3）
            if (attemptNo >= RETRY_DELAYS.length) { finishUnlock(gid, code, result); return; }
            setTimeout(function () {
                if (!sessions[gid]) { finishUnlock(gid, code, { ok: false, retry: false, reason: 'session_expired' }); return; }
                submit(gid, code, attemptNo + 1);
            }, RETRY_DELAYS[attemptNo]);
        });
    }

    window.ImGameSDK = {
        /** 宿主喂会话签名密钥（game-store.js 在库/详情响应到达时调用；key 空=清除该游戏会话） */
        setSession: function (gameId, signKey) {
            var gid = parseInt(gameId, 10);
            if (!(gid > 0)) return;
            activeGid = gid;
            if (signKey) sessions[gid] = String(signKey);
            else delete sessions[gid];
        },
        /** 上报单条成就解锁（gameId 缺省用最近一次喂入的会话游戏） */
        unlockAchievement: function (code, gameId) {
            if (!code) return Promise.resolve({ ok: false, reason: 'bad_code' });
            var gid = resolveGid(gameId);
            if (!gid) {
                console.warn('[ImGameSDK] 无可用会话（未喂 session_sign_key 或游戏未入库）', gameId, code);
                return Promise.resolve({ ok: false, reason: 'no_session' });
            }
            var pkey = gid + ':' + code;
            if (pending[pkey]) return Promise.resolve({ ok: false, reason: 'pending' }); // 同条成就在途：静默合并
            pending[pkey] = 1;
            submit(gid, String(code), 0);
            return Promise.resolve({ ok: true, queued: true }); // 结果经 finishUnlock 异步归口（toast/日志）
        },
        /** 已解锁成就列表（内存缓存 + 服务端同步；返回 items[]，每项含 code/name/unlocked 等） */
        getUnlockedAchievements: function (gameId) {
            var gid = parseInt(gameId, 10) || activeGid || 0;
            if (!(gid > 0)) return Promise.resolve([]);
            var qs = '?username=' + encodeURIComponent(userName()) + '&game_id=' + gid;
            var headers = {};
            var tk = driveToken();
            if (tk) headers['X-Drive-Token'] = tk;
            return fetch(location.origin + '/api/profile/achievements' + qs, { headers: headers })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    var groups = (res && res.ok && res.data && res.data.groups) || [];
                    var items = [];
                    groups.forEach(function (g) { (g.items || []).forEach(function (it) { items.push(it); }); });
                    unlockedCache[gid] = items;
                    return items;
                })
                .catch(function () { return unlockedCache[gid] || []; });
        }
    };
})();
