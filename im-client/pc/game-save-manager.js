// ===== 阶段二百八十九：游戏云存档管理器（Steam 同款云存档 P1 单设备闭环 主进程部分） =====
// 职责归口：存档路径解析（用户覆盖 > 管理端默认 > 内置兜底）、glob 匹配与目录遍历（自实现，不引三方依赖）、
//           逐文件流式 SHA256 扫描、退出上传（push）/ 启动下载（pull）、进度事件 500ms 节流广播。
// 由 main.js 实例化并监听 progress：progress 转发全部窗口（game-save:progress）。
// 安全约束：解析后的绝对路径必须位于允许根集合（installDir ∪ 系统白名单目录）内，越界一律拒绝（防任意文件读写）。
// 逻辑 rel_path 形如「0/save01.sav」：前半=存档模式序号（生效路径列表下标），后半=相对 baseDir 的相对路径（正斜杠）。
// 与 download-manager.js 同构：纯 Node（http/https/fs/crypto），不依赖 Electron，便于单测与 node --check。
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EMIT_INTERVAL = 500;                      // 进度节流窗口（ms）
const MAX_FILE_SIZE = 50 * 1024 * 1024;         // 单文件上限（镜像服务端 game.save.max_file_size 默认 50MB；超限标记 skipped 不阻断整体）
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;       // 单游戏存档总上限（镜像服务端 game.save.max_total_size 默认 200MB）
const MAX_SCAN_FILES = 20000;                   // 扫描文件数上限（防误配超大 glob 拖死主进程）
const WALK_VISIT_LIMIT = MAX_SCAN_FILES * 6;    // 目录遍历访问上限
const REQUEST_TIMEOUT = 20000;                  // HTTP 无活动超时（ms）：防连接卡死长期阻塞（尤其启动前 pull 阻塞启动）
const BUILTIN_PATTERN = 'save/**';             // 内置兜底缺省值（相对 installDir）；正常走 _builtinPattern(installDir, slug) 自适应（installDir 已是游戏目录→save/**，否则→<slug>/save/**）

// 系统白名单根（变量展开目标，同时作为安全允许根）：用户主目录 + AppData + 文档 + ProgramData
function systemRoots() {
    var home = os.homedir();
    var arr = [];
    if (home) arr.push(home);
    var appdata = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
    var local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
    var docs = home ? path.join(home, 'Documents') : '';
    var pd = process.env.ProgramData || 'C:\\ProgramData';
    [appdata, local, docs, pd].forEach(function (x) { if (x) arr.push(x); });
    return arr;
}

// 变量展开（Windows）：%USERPROFILE% %APPDATA% %LOCALAPPDATA% %DOCUMENTS% %ProgramData%，其余原样
function expandVars(s) {
    var home = os.homedir();
    var map = {
        userprofile: home,
        appdata: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        localappdata: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        documents: path.join(home, 'Documents'),
        programdata: process.env.ProgramData || 'C:\\ProgramData'
    };
    return String(s).replace(/%([^%]+)%/g, function (m, name) {
        var key = String(name).trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        return m;
    });
}

// 单段 glob（仅含 * ?）→ 正则（Windows 路径不区分大小写）
function segToRegExp(p) {
    var re = '';
    for (var i = 0; i < p.length; i++) {
        var ch = p.charAt(i);
        if (ch === '*') re += '[^\\\\/]*';
        else if (ch === '?') re += '[^\\\\/]';
        else if (/[.*+?^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
        else re += ch;
    }
    return new RegExp('^' + re + '$', 'i');
}
function matchOne(pat, seg) { return segToRegExp(pat).test(seg); }

// 通配段数组匹配：pats 为 glob 段数组（可含 **），segs 为实际路径段数组。
// **：匹配零到多段（跨目录递归）；* / ?：单段内匹配
function matchSegs(pats, segs) {
    if (!pats.length) return !segs.length;
    if (pats[0] === '**') {
        var rest = pats.slice(1);
        for (var k = 0; k <= segs.length; k++) {
            if (matchSegs(rest, segs.slice(k))) return true;
        }
        return false;
    }
    if (!segs.length) return false;
    if (!matchOne(pats[0], segs[0])) return false;
    return matchSegs(pats.slice(1), segs.slice(1));
}

// 段数组/路径工具（同 download-manager 口径）：绝对/相对路径 → 段数组
function segsOf(p) {
    return String(p).split(/[\\/]+/).filter(function (s) { return s.length > 0; });
}

// Map → 普通对象（基线持久化为 JSON 用）
function mapToObj(m) {
    var o = {};
    m.forEach(function (v, k) { o[k] = v; });
    return o;
}

// 拼请求地址：serverBase + 逻辑路径 + 查询参数（跳过 null/undefined；均做 URL 编码）
function buildUrl(serverBase, urlPath, params) {
    var base = String(serverBase || '').replace(/\/+$/, '');
    var p = String(urlPath || '');
    if (p.charAt(0) !== '/') p = '/' + p;
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null) return;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return base + p + (qs.length ? ('?' + qs.join('&')) : '');
}

class GameSaveManager extends EventEmitter {
    constructor() {
        super();
        this._lastEmit = 0; // 进度节流基准时间
    }

    // —— 路径解析：优先级 用户覆盖 > 管理端默认 > 内置兜底；产出生效模式列表（含来源与 baseDir） ——
    // opts={installDir, slug, adminPaths, adminExclude, userPaths, userExclude}（slug 用于内置兜底锚定本游戏目录）
    resolveSavePaths(opts) {
        opts = opts || {};
        var installDirRaw = String(opts.installDir || '').trim();
        var installDir = installDirRaw ? path.resolve(installDirRaw) : '';
        // 允许根集合：installDir ∪ 系统白名单目录
        var roots = [];
        if (installDir) roots.push(installDir);
        systemRoots().forEach(function (r) { if (r) roots.push(path.resolve(r)); });
        var norm = this._normList;
        var userPaths = norm(opts.userPaths);
        var adminPaths = norm(opts.adminPaths);
        var userExclude = norm(opts.userExclude);
        var adminExclude = norm(opts.adminExclude);
        var source = 'builtin', patterns = [this._builtinPattern(installDirRaw, opts.slug)];
        if (userPaths.length) { source = 'user'; patterns = userPaths; }
        else if (adminPaths.length) { source = 'admin'; patterns = adminPaths; }
        // 排除：用户覆盖优先，否则管理端默认（内置兜底无排除）
        var excludes = userExclude.length ? userExclude : adminExclude;
        var modes = [];
        for (var i = 0; i < patterns.length; i++) {
            var m = this._buildMode(patterns[i], i, source, installDir, roots);
            if (m) modes.push(m);
        }
        return { installDir: installDir, source: source, patterns: patterns, excludes: excludes, modes: modes, roots: roots };
    }

    // 供 UI 展示生效路径明细（含来源/生效目录/是否存在）
    resolvePathsPreview(opts) {
        var r = this.resolveSavePaths(opts);
        return r.modes.map(function (m) {
            return {
                index: m.index,
                source: m.source,
                pattern: m.pattern,
                baseDir: m.baseDir,
                exists: !!m.exists,
                rejected: !!m.rejected
            };
        });
    }

    // 扫描（对外简版）：resolveSavePaths 生效模式 → 逐文件 {relPath, absPath, size, mtimeMs, sha256}
    async scan(opts) {
        var r = await this._scanInternal(opts);
        return r.files;
    }

    // 扫描（完整版，供主进程/UI 取生效模式与跳过项）
    async scanResolved(opts) {
        return await this._scanInternal(opts);
    }

    // —— push（退出上传 / 手动上传）：本地扫描 → 冲突判定 → 差异文件上传 → finalize（清理云端多余并 revision+1） ——
    // payload={gameId,username,installDir,adminPaths,adminExclude,userPaths,userExclude,slot,serverBase,baseline,force}
    //   baseline：上次同步基线 {revision, files:{rel_path:sha}}（主进程 state 文件维护）；用于「本地与云端自上次同步后都变过」的冲突判定
    //   force：true=跳过冲突判定（用户手动「立即上传」/冲突解决=显式以本地为准）
    // 返回：{ok,uploaded,skipped,revision,baseline} 或 {ok:false,conflict:true,local,cloud}
    async push(payload) {
        var self = this;
        payload = payload || {};
        var gameId = String(payload.gameId || '').trim();
        if (!gameId) return { ok: false, error: '参数缺失' };
        var serverBase = String(payload.serverBase || '');
        var username = String(payload.username || '');
        var slot = String(payload.slot || '');
        var scanRes = await this._scanInternal(payload);
        // 本地无存档时不 finalize（避免误清云端）
        if (!scanRes.files.length) {
            return { ok: true, uploaded: 0, skipped: scanRes.skipped.length, revision: null, note: '本地无存档，跳过上传' };
        }
        var localMap = this._fileMap(scanRes.files);
        var man = await this._getManifest({ serverBase: serverBase, gameId: gameId, username: username, slot: slot });
        var cloudMap = this._fileMap((man && man.files) || []);
        if (!payload.force) {
            var conflict = this._conflictOf(localMap, cloudMap, man, scanRes, payload.baseline);
            if (conflict) return conflict;
        }
        var changed = scanRes.files.filter(function (f) {
            var cs = cloudMap.get(f.relPath);
            return !cs || cs !== f.sha256; // 云端缺失或哈希不同即需上传
        });
        // 双端完全一致：不上传也不定稿（避免产生空修订，仅回落当前版本作为基线）
        if (!changed.length && this._sameMap(localMap, cloudMap)) {
            var sameRev = (man && man.revision) || 0;
            this._progress({ gameId: gameId, mode: 'push', phase: 'done', fileIndex: 0, filesCount: 0, fileRelPath: '', bytesDone: 0, bytesTotal: 0, percent: 100, final: true });
            return { ok: true, uploaded: 0, skipped: scanRes.skipped.length, revision: sameRev, baseline: { revision: sameRev, files: mapToObj(localMap), at: Date.now() }, note: '云端与本地一致' };
        }
        var bytesTotal = 0;
        changed.forEach(function (f) { bytesTotal += Number(f.size) || 0; });
        var bytesDone = 0, uploaded = 0;
        this._progress({ gameId: gameId, mode: 'push', phase: 'upload', fileIndex: 0, filesCount: changed.length, fileRelPath: '', bytesDone: 0, bytesTotal: bytesTotal, percent: 0, final: true });
        for (var i = 0; i < changed.length; i++) {
            var f = changed[i];
            var baseBytes = bytesDone;
            this._progress({ gameId: gameId, mode: 'push', phase: 'upload', fileIndex: i, filesCount: changed.length, fileRelPath: f.relPath, bytesDone: bytesDone, bytesTotal: bytesTotal, percent: bytesTotal ? Math.round(bytesDone / bytesTotal * 100) : 0, final: true });
            await this._uploadFile({ serverBase: serverBase, gameId: gameId, username: username, slot: slot, file: f }, function (sent) {
                self._progress({ gameId: gameId, mode: 'push', phase: 'upload', fileIndex: i, filesCount: changed.length, fileRelPath: f.relPath, bytesDone: baseBytes + sent, bytesTotal: bytesTotal, percent: bytesTotal ? Math.round((baseBytes + sent) / bytesTotal * 100) : 100 });
            });
            bytesDone += Number(f.size) || 0;
            uploaded++;
        }
        var revision = await this._finalize({ serverBase: serverBase, gameId: gameId, username: username, slot: slot, relPaths: scanRes.files.map(function (x) { return x.relPath; }) });
        this._progress({ gameId: gameId, mode: 'push', phase: 'done', fileIndex: changed.length, filesCount: changed.length, fileRelPath: '', bytesDone: bytesTotal, bytesTotal: bytesTotal, percent: 100, final: true });
        return { ok: true, uploaded: uploaded, skipped: scanRes.skipped.length, revision: revision, baseline: { revision: revision, files: mapToObj(localMap), at: Date.now() } };
    }

    // —— pull（启动下载 / 手动下载）：增量下载（缺失或哈希不同者），冲突判定，可选镜像清理与本地备份 ——
    // payload 同 push，另：mirror=清理本地不在云端的存档文件（显式以云端为准）；backupDir=冲突「保留双份」本地备份根
    // 返回：{ok,downloaded,removed?,skipped,revision,baseline,note?} 或 {ok:false,conflict:true,local,cloud}
    async pull(payload) {
        var self = this;
        payload = payload || {};
        var gameId = String(payload.gameId || '').trim();
        if (!gameId) return { ok: false, error: '参数缺失' };
        var serverBase = String(payload.serverBase || '');
        var username = String(payload.username || '');
        var slot = String(payload.slot || '');
        var scanRes = await this._scanInternal(payload);
        var localMap = this._fileMap(scanRes.files);
        var man = await this._getManifest({ serverBase: serverBase, gameId: gameId, username: username, slot: slot });
        if (!man || !man.exists) return { ok: true, downloaded: 0, skipped: 0, revision: null, note: '云端无存档' };
        var cloudFiles = Array.isArray(man.files) ? man.files : [];
        var cloudMap = this._fileMap(cloudFiles);
        var resultBaseline = { revision: (man && man.revision) || 0, files: mapToObj(cloudMap), at: Date.now() };
        if (!payload.force) {
            var baseFiles = (payload.baseline && payload.baseline.files) || null;
            if (baseFiles) {
                var localDirty = !this._sameMap(localMap, baseFiles);
                var cloudDirty = !this._sameMap(cloudMap, baseFiles);
                if (localDirty && cloudDirty) return this._conflictPayload(localMap, cloudMap, man, scanRes);
                // 双端均未变才跳过；仅本地变（如误删存档）仍需继续增量拉取以恢复本地
                if (!localDirty && !cloudDirty) return { ok: true, downloaded: 0, skipped: 0, revision: resultBaseline.revision, baseline: resultBaseline, note: '云端无更新' };
            } else if (localMap.size > 0 && !this._sameMap(localMap, cloudMap)) {
                // 无基线（首次同步/旧客户端遗留）：云端与本地都有且不一致 → 交由用户裁决
                return this._conflictPayload(localMap, cloudMap, man, scanRes);
            }
        }
        // 冲突「保留双份」或镜像前：先把本地存档备份到独立目录（覆盖/清理前，失败不阻断）
        if (payload.backupDir && scanRes.files.length) {
            try { await this._backupLocal(payload.backupDir, gameId, scanRes.files); } catch (e) { /* 备份失败仅影响本次留档 */ }
        }
        var byIndex = new Map();
        scanRes.modes.forEach(function (m) { if (!m.rejected) byIndex.set(String(m.index), m); });
        // 仅下载差异文件（本地缺失或哈希不同）
        var todo = cloudFiles.filter(function (cf) {
            var cs = localMap.get(String(cf.rel_path || ''));
            return !cs || cs !== String(cf.sha256 || '').toLowerCase();
        });
        var bytesTotal = 0;
        todo.forEach(function (f) { var idx = String(f.rel_path || '').split('/')[0]; if (byIndex.get(idx)) bytesTotal += Number(f.size) || 0; });
        var bytesDone = 0, downloaded = 0, skipped = 0;
        this._progress({ gameId: gameId, mode: 'pull', phase: 'download', fileIndex: 0, filesCount: todo.length, fileRelPath: '', bytesDone: 0, bytesTotal: bytesTotal, percent: 0, final: true });
        for (var i = 0; i < todo.length; i++) {
            var cf = todo[i];
            var parts = String(cf.rel_path || '').split('/');
            var idx = parts.shift();
            var mode = byIndex.get(idx);
            if (!mode || !mode.baseDir) { skipped++; continue; }
            // 防目录穿越：目标必须位于该模式 baseDir 内
            var destAbs = path.resolve(mode.baseDir, parts.join('/'));
            if (destAbs !== mode.baseDir && !destAbs.startsWith(mode.baseDir + path.sep)) { skipped++; continue; }
            var url = buildUrl(serverBase, '/api/game/save/download/' + encodeURIComponent(cf.id), { username: username });
            var baseBytes = bytesDone;
            this._progress({ gameId: gameId, mode: 'pull', phase: 'download', fileIndex: i, filesCount: todo.length, fileRelPath: cf.rel_path, bytesDone: bytesDone, bytesTotal: bytesTotal, percent: bytesTotal ? Math.round(bytesDone / bytesTotal * 100) : 0, final: true });
            await this._downloadFile(url, destAbs, function (sent) {
                self._progress({ gameId: gameId, mode: 'pull', phase: 'download', fileIndex: i, filesCount: todo.length, fileRelPath: cf.rel_path, bytesDone: baseBytes + sent, bytesTotal: bytesTotal, percent: bytesTotal ? Math.round((baseBytes + sent) / bytesTotal * 100) : 100 });
            });
            bytesDone += Number(cf.size) || 0;
            downloaded++;
        }
        // mirror：清理本地「不在云端」的存档文件（仅显式以云端为准时；备份已完成故可安全清理）
        var removed = 0;
        if (payload.mirror) {
            for (var li = 0; li < scanRes.files.length; li++) {
                var lf = scanRes.files[li];
                if (!cloudMap.has(lf.relPath)) {
                    try { await fs.promises.unlink(lf.absPath); removed++; } catch (e) { /* 删除失败忽略 */ }
                }
            }
        }
        this._progress({ gameId: gameId, mode: 'pull', phase: 'done', fileIndex: todo.length, filesCount: todo.length, fileRelPath: '', bytesDone: bytesTotal, bytesTotal: bytesTotal, percent: 100, final: true });
        return { ok: true, downloaded: downloaded, removed: removed, skipped: skipped, revision: resultBaseline.revision, baseline: resultBaseline };
    }

    // 统一入口（主进程 game:save-sync 归口）：pull | push | auto（auto=本地空且云端有则下载，否则上传）
    async sync(payload) {
        var mode = String((payload && payload.mode) || 'push');
        if (mode === 'pull') return await this.pull(payload);
        if (mode === 'push') return await this.push(payload);
        var scanRes = await this._scanInternal(payload);
        if (!scanRes.files.length) {
            var gameId = String((payload && payload.gameId) || '').trim();
            var man = await this._getManifest({ serverBase: String((payload && payload.serverBase) || ''), gameId: gameId, username: String((payload && payload.username) || ''), slot: String((payload && payload.slot) || '') });
            if (man && man.exists) return await this.pull(payload);
            return { ok: true, uploaded: 0, downloaded: 0, note: '无本地/云端存档' };
        }
        return await this.push(payload);
    }

    // 云端版本历史（P2）：{ok,exists,slot,current_revision,revisions:[{revision,total_size,file_count,create_time,current}]}
    async history(payload) {
        payload = payload || {};
        var url = buildUrl(String(payload.serverBase || ''), '/api/game/save/history/' + encodeURIComponent(String(payload.gameId || '')), { username: payload.username, slot: payload.slot });
        return await this._json('GET', url);
    }

    // 版本回滚（P2）：payload.revision=目标修订 → {ok,revision,restored_from}
    async rollback(payload) {
        payload = payload || {};
        var url = buildUrl(String(payload.serverBase || ''), '/api/game/save/rollback/' + encodeURIComponent(String(payload.gameId || '')), { username: payload.username, slot: payload.slot });
        return await this._json('POST', url, { revision: Number(payload.revision) || 0 });
    }

    // 槽位列表（P3）：{ok,slots:[{slot,revision,total_size,file_count,update_time}]}
    async slots(payload) {
        payload = payload || {};
        var url = buildUrl(String(payload.serverBase || ''), '/api/game/save/slots/' + encodeURIComponent(String(payload.gameId || '')), { username: payload.username });
        return await this._json('GET', url);
    }

    // 删除某槽位云端存档（P3）：{ok}
    async deleteSlot(payload) {
        payload = payload || {};
        var url = buildUrl(String(payload.serverBase || ''), '/api/game/save/data/' + encodeURIComponent(String(payload.gameId || '')), { username: payload.username, slot: payload.slot });
        return await this._json('DELETE', url);
    }

    // —— 以下为内部实现 ——

    // 列表归一：数组 / JSON 数组串 / 换行分隔串 → 去空去重前修剪的字符串数组
    _normList(v) {
        if (Array.isArray(v)) return v.map(String).map(function (s) { return s.trim(); }).filter(Boolean);
        if (typeof v === 'string') {
            var t = v.trim();
            if (t.charAt(0) === '[') {
                try {
                    var a = JSON.parse(t);
                    if (Array.isArray(a)) return a.map(String).map(function (s) { return s.trim(); }).filter(Boolean);
                } catch (e) { /* 非 JSON：按行切分 */ }
            }
            return t.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
        return [];
    }

    // 内置兜底模式（实测库 install_path 有两种形态，需自适应，避免多一层/少一层目录）：
    //   ① install_path = 安装根（如 H:\CdonlgameApp）      → 游戏实际落盘 <installDir>/<slug>，取 <slug>/save/**
    //   ② install_path = 游戏目录（如 H:\CdonlgameApp\War3）→ 该层已含游戏目录，再追加 slug 会变成 \War3\war3 双层，故取 save/**
    // 判据：installDir 末级目录名（忽略大小写）等于 slug 即视为形态②。两形态均不跨游戏，无串档。
    _builtinPattern(installDir, slug) {
        var s = String(slug || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
        if (!s || s === '.' || s === '..') return BUILTIN_PATTERN;
        var leaf = '';
        try { leaf = path.basename(String(installDir || '').replace(/[\\/]+$/, '')); } catch (e) { leaf = ''; }
        if (leaf && leaf.toLowerCase() === s.toLowerCase()) return BUILTIN_PATTERN;
        return s + '/save/**';
    }

    // 单个模式 → 生效模式对象：变量展开 → 相对锚定 installDir → 取第一个通配符前固定目录为 baseDir
    _buildMode(pattern, index, source, installDir, roots) {
        var raw = String(pattern || '');
        var expanded = expandVars(raw).trim();
        if (!expanded) return null;
        var abs = path.isAbsolute(expanded) ? expanded : (installDir ? path.join(installDir, expanded) : expanded);
        abs = path.normalize(abs);
        var w = abs.indexOf('*'), q = abs.indexOf('?');
        var firstWild = w < 0 ? q : (q < 0 ? w : Math.min(w, q));
        var baseDirRaw, globPart;
        if (firstWild < 0) {
            // 无通配符：视为精确文件（baseDir=其父目录，glob=文件名）
            baseDirRaw = path.dirname(abs);
            globPart = path.basename(abs) || '*';
        } else {
            var before = abs.substring(0, firstWild);
            var slash = Math.max(before.lastIndexOf('\\'), before.lastIndexOf('/'));
            baseDirRaw = slash >= 0 ? abs.substring(0, slash) : '.';
            globPart = abs.substring(slash + 1);
        }
        var baseDir = path.normalize(baseDirRaw);
        var globSegs = globPart.split(/[\\/]+/).filter(function (s) { return s.length > 0; });
        if (!globSegs.length) globSegs = ['**'];
        var mode = { index: index, source: source, pattern: raw, baseDir: baseDir, globSegs: globSegs, exists: false, rejected: false };
        // 安全：baseDir 必须位于允许根内，否则拒绝该模式
        if (!this._withinRoots(baseDir, roots)) { mode.rejected = true; return mode; }
        try { mode.exists = fs.statSync(baseDir).isDirectory(); } catch (e) { mode.exists = false; }
        // 无通配符精确路径指向实际存在的目录 → 整目录递归采集（管理员填目录名的直觉语义，
        // 如 %USERPROFILE%\Saved Games\Game\mod\TCP；原实现按"精确文件"处理导致目录内容采不到）。
        // baseDir 改为该目录本身，rel_path 自目录内起算；指向文件/不存在时保持精确文件语义不变。
        // abs 在 baseDir 之下，baseDir 已过根校验则 abs 必在根内（前缀关系），无越界面
        if (firstWild < 0 && mode.exists) {
            try { if (fs.statSync(abs).isDirectory()) { mode.baseDir = baseDir = abs; mode.globSegs = ['**']; } } catch (e) { /* 文件或竞态删除：保持精确文件 */ }
        }
        return mode;
    }

    // 路径是否位于任一允许根内（Windows 大小写不敏感）
    _withinRoots(abs, roots) {
        if (!abs) return false;
        var low = String(abs).toLowerCase().replace(/[\\/]+$/, '');
        for (var i = 0; i < roots.length; i++) {
            var r = String(roots[i] || '').toLowerCase().replace(/[\\/]+$/, '');
            if (!r) continue;
            if (low === r || low.indexOf(r + '\\') === 0 || low.indexOf(r + '/') === 0) return true;
        }
        return false;
    }

    // 完整扫描：解析模式 → 遍历匹配 → 排除/越界/大小过滤 → 流式 SHA256
    async _scanInternal(opts) {
        var resolved = this.resolveSavePaths(opts);
        var seen = new Set();
        var files = [], skipped = [];
        var totalBytes = 0;
        for (var mi = 0; mi < resolved.modes.length; mi++) {
            var mode = resolved.modes[mi];
            if (!mode.exists || mode.rejected) continue;
            var collector = { count: 0, hits: [] };
            await this._walkDir(mode.baseDir, [], mode, collector, resolved.excludes);
            for (var hi = 0; hi < collector.hits.length; hi++) {
                var hit = collector.hits[hi];
                var relFromBase = hit.relSegs.join('/');
                var logicRel = mode.index + '/' + relFromBase;
                if (seen.has(logicRel)) continue; // 同 rel_path 去重（先出现者胜）
                seen.add(logicRel);
                if (this._isExcluded(resolved.excludes, hit.absPath, relFromBase, logicRel)) continue;
                if (!this._withinRoots(hit.absPath, resolved.roots)) continue; // 越界拒绝
                var st;
                try { st = await fs.promises.stat(hit.absPath); } catch (e) { continue; }
                if (!st.isFile()) continue;
                var size = st.size;
                if (size > MAX_FILE_SIZE) { skipped.push({ relPath: logicRel, reason: '超过单文件上限' }); continue; }
                if (totalBytes + size > MAX_TOTAL_SIZE) { skipped.push({ relPath: logicRel, reason: '超过总大小上限' }); continue; }
                var sha = await this._hashFile(hit.absPath);
                totalBytes += size;
                files.push({ relPath: logicRel, absPath: hit.absPath, size: size, mtimeMs: st.mtimeMs, sha256: sha });
            }
        }
        if (skipped.length) console.warn('[game-save] 跳过 ' + skipped.length + ' 个超限存档文件（未阻断整体）');
        return { files: files, skipped: skipped, modes: resolved.modes, total: totalBytes, source: resolved.source };
    }

    // 目录递归遍历：收集匹配 globSegs 的文件；含 ** 时下钻，否则按模式段数限深
    async _walkDir(dir, relSegs, mode, collector, excludes) {
        var entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (var i = 0; i < entries.length; i++) {
            if (collector.count > WALK_VISIT_LIMIT) return;
            var ent = entries[i];
            var relSegs2 = relSegs.concat([ent.name]);
            var full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (this._canDescend(mode.globSegs, relSegs2)) await this._walkDir(full, relSegs2, mode, collector, excludes);
            } else if (ent.isFile()) {
                collector.count++;
                if (matchSegs(mode.globSegs, relSegs2)) collector.hits.push({ relSegs: relSegs2, absPath: full });
            }
        }
    }

    // 是否需继续下钻：glob 含 **（可跨层）恒下钻；否则未达模式最大层数前下钻
    _canDescend(globSegs, relSegs) {
        if (globSegs.indexOf('**') >= 0) return true;
        return relSegs.length < globSegs.length;
    }

    // exclude 过滤：绝对模式比对绝对路径；含 '/' 的相对模式比对 baseDir 相对路径与逻辑路径；裸模式比对文件名
    _isExcluded(excludes, absPath, relFromBase, logicRel) {
        if (!excludes || !excludes.length) return false;
        for (var i = 0; i < excludes.length; i++) {
            var ep = expandVars(String(excludes[i] || '')).trim();
            if (!ep) continue;
            if (path.isAbsolute(ep)) {
                if (matchSegs(segsOf(path.normalize(ep)), segsOf(absPath))) return true;
                continue;
            }
            var segs = ep.split(/[\\/]+/).filter(function (s) { return s.length > 0; });
            if (segs.length > 1) {
                if (matchSegs(segs, relFromBase.split('/').filter(Boolean))) return true;
                if (matchSegs(segs, logicRel.split('/').filter(Boolean))) return true;
                continue;
            }
            if (matchOne(segs[0] || '', path.basename(absPath))) return true;
        }
        return false;
    }

    // 流式 SHA256
    _hashFile(abs) {
        return new Promise(function (resolve, reject) {
            var h = crypto.createHash('sha256');
            var rs = fs.createReadStream(abs);
            rs.on('data', function (c) { h.update(c); });
            rs.on('error', reject);
            rs.on('end', function () { resolve(h.digest('hex')); });
        });
    }

    // 云端清单摘要（供 UI 展示云端存档状态）
    async manifest(payload) {
        payload = payload || {};
        var gameId = String(payload.gameId || '').trim();
        if (!gameId) return { ok: false, error: '参数缺失' };
        var man = await this._getManifest({
            serverBase: String(payload.serverBase || ''),
            gameId: gameId,
            username: String(payload.username || ''),
            slot: String(payload.slot || '')
        });
        return {
            ok: true,
            exists: !!(man && man.exists),
            revision: (man && man.revision) || 0,
            total_size: (man && man.total_size) || 0,
            max_total_size: (man && man.max_total_size) || 0, // 该用户对该游戏的总量配额（供 UI 展示已用百分比）
            file_count: (man && man.file_count) || 0,
            update_time: (man && man.update_time) || 0
        };
    }

    async _getManifest(p) {
        var url = buildUrl(p.serverBase, '/api/game/save/manifest/' + encodeURIComponent(p.gameId), { username: p.username, slot: p.slot });
        return await this._json('GET', url);
    }

    async _finalize(p) {
        var url = buildUrl(p.serverBase, '/api/game/save/finalize/' + encodeURIComponent(p.gameId), { username: p.username, slot: p.slot });
        var res = await this._json('POST', url, { rel_paths: p.relPaths || [] });
        return res ? res.revision : null;
    }

    // 上传单个文件：POST 原始字节，Content-Length=文件大小（流式写，onBytes 回调累计字节）
    _uploadFile(p, onBytes) {
        var f = p.file;
        return new Promise(function (resolve, reject) {
            var url = buildUrl(p.serverBase, '/api/game/save/file/' + encodeURIComponent(p.gameId), { username: p.username, slot: p.slot, rel_path: f.relPath, sha256: f.sha256, size: f.size });
            var u;
            try { u = new URL(url); } catch (e) { reject(new Error('地址非法')); return; }
            var mod = u.protocol === 'https:' ? https : http;
            var settled = false;
            var req = mod.request({
                method: 'POST',
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size) }
            }, function (res) {
                var body = '';
                res.on('data', function (c) { body += c; });
                res.on('error', function (err) { if (!settled) { settled = true; reject(err); } });
                res.on('end', function () {
                    if (settled) return;
                    settled = true;
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
                    else reject(new Error('HTTP ' + res.statusCode + ' ' + String(body).slice(0, 200)));
                });
            });
            req.on('error', function (err) { if (!settled) { settled = true; reject(err); } });
            req.setTimeout(REQUEST_TIMEOUT, function () { if (!settled) { settled = true; reject(new Error('上传超时')); } try { req.destroy(); } catch (e) { } });
            var rs = fs.createReadStream(f.absPath);
            rs.on('data', function (c) { if (onBytes) onBytes(c.length); });
            rs.on('error', function (err) { if (!settled) { settled = true; } try { req.destroy(); } catch (e) { } reject(err); });
            rs.pipe(req);
        });
    }

    // 下载单个文件：GET 文件流 → 目标路径（自动建父目录；onBytes 回调累计字节）
    _downloadFile(url, destAbs, onBytes) {
        return new Promise(function (resolve, reject) {
            fs.mkdir(path.dirname(destAbs), { recursive: true }, function (mkErr) {
                if (mkErr) { reject(mkErr); return; }
                var u;
                try { u = new URL(url); } catch (e) { reject(new Error('地址非法')); return; }
                var mod = u.protocol === 'https:' ? https : http;
                var settled = false;
                var req = mod.get({
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname + u.search
                }, function (res) {
                    if (res.statusCode !== 200) { res.resume(); if (!settled) { settled = true; reject(new Error('HTTP ' + res.statusCode)); } return; }
                    var ws = fs.createWriteStream(destAbs);
                    res.on('data', function (c) { if (onBytes) onBytes(c.length); });
                    res.on('error', function (err) { if (!settled) { settled = true; } ws.destroy(); reject(err); });
                    ws.on('error', function (err) { if (!settled) { settled = true; } reject(err); });
                    ws.on('finish', function () { if (!settled) { settled = true; resolve(); } });
                    res.pipe(ws);
                });
                req.on('error', function (err) { if (!settled) { settled = true; reject(err); } });
                req.setTimeout(REQUEST_TIMEOUT, function () { if (!settled) { settled = true; reject(new Error('下载超时')); } try { req.destroy(); } catch (e) { } });
            });
        });
    }

    // —— 冲突判定与基线比对（阶段二百九十：云存档 P2 增量同步 + 冲突弹窗） ——

    // 文件清单 → Map(rel_path → sha256 小写)；兼容云端 {rel_path,sha256} 与本地 {relPath,sha256}
    _fileMap(files) {
        var m = new Map();
        (files || []).forEach(function (f) {
            if (!f) return;
            var rp = String(f.rel_path !== undefined ? f.rel_path : f.relPath || '');
            var sh = String(f.sha256 || '').toLowerCase();
            if (rp) m.set(rp, sh);
        });
        return m;
    }

    // 任意（Map/普通对象）→ Map（基线比对两侧归一）
    _toMap(v) {
        if (v instanceof Map) return v;
        var m = new Map();
        var o = v || {};
        Object.keys(o).forEach(function (k) { m.set(k, o[k]); });
        return m;
    }

    // 两清单是否完全一致（rel_path 集合与内容指纹均相同）
    _sameMap(a, b) {
        var ma = this._toMap(a), mb = this._toMap(b);
        if (ma.size !== mb.size) return false;
        var same = true;
        ma.forEach(function (v, k) { if (mb.get(k) !== v) same = false; });
        return same;
    }

    // 冲突结果负载（本地/云端两侧摘要，供自绘弹窗展示）
    _conflictPayload(localMap, cloudMap, man, scanRes) {
        var localBytes = 0;
        (scanRes.files || []).forEach(function (f) { localBytes += Number(f.size) || 0; });
        return {
            ok: false,
            conflict: true,
            local: { file_count: localMap.size, total_size: localBytes },
            cloud: {
                exists: !!(man && man.exists),
                file_count: (man && man.file_count) || 0,
                total_size: (man && man.total_size) || 0,
                update_time: (man && man.update_time) || '',
                revision: (man && man.revision) || 0
            }
        };
    }

    // 冲突判定（非 force）：本地与云端「自上次同步基线以来都变过」→ 冲突负载，否则 null
    // 无基线（首次/旧客户端）：云端与本地都有且不一致 → 冲突（交由用户裁决）
    _conflictOf(localMap, cloudMap, man, scanRes, baseline) {
        var baseFiles = (baseline && baseline.files) || null;
        if (baseFiles) {
            var localDirty = !this._sameMap(localMap, baseFiles);
            var cloudDirty = !this._sameMap(cloudMap, baseFiles);
            if (!localDirty && !cloudDirty) return null;       // 双端均未变：无需动作
            if (localDirty && cloudDirty) return this._conflictPayload(localMap, cloudMap, man, scanRes); // 双改：冲突
            // 仅云端变、本地未变：上传会用旧版本覆盖云端新版本 → 视为冲突交由用户裁决（禁止静默覆盖）
            if (!localDirty && cloudDirty) return this._conflictPayload(localMap, cloudMap, man, scanRes);
            return null;                                       // 仅本地变：正常上传
        }
        if (localMap.size > 0 && cloudMap.size > 0 && !this._sameMap(localMap, cloudMap)) {
            return this._conflictPayload(localMap, cloudMap, man, scanRes);
        }
        return null;
    }

    // 本地存档备份（冲突「保留双份」）：按 rel_path 原样复制到 <backupRoot>/<gameId>/<时间戳>/，
    // 并写 backup-manifest.json 记录清单，便于用户手工恢复
    async _backupLocal(backupRoot, gameId, files) {
        var ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        var dest = path.join(String(backupRoot), String(gameId), ts);
        await fs.promises.mkdir(dest, { recursive: true });
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var dp = path.join(dest, String(f.relPath).split('/').join(path.sep));
            await fs.promises.mkdir(path.dirname(dp), { recursive: true });
            await fs.promises.copyFile(f.absPath, dp);
        }
        var meta = files.map(function (f) { return { rel_path: f.relPath, size: f.size, sha256: f.sha256 }; });
        await fs.promises.writeFile(path.join(dest, 'backup-manifest.json'),
            JSON.stringify({ gameId: String(gameId), at: Date.now(), files: meta }, null, 2), 'utf8');
        return { dir: dest, count: files.length };
    }

    // JSON 请求（GET/POST/PUT/DELETE）：body 为对象 → JSON 序列化
    _json(method, url, body) {
        return new Promise(function (resolve, reject) {
            var u;
            try { u = new URL(url); } catch (e) { reject(new Error('地址非法')); return; }
            var mod = u.protocol === 'https:' ? https : http;
            var data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
            var opts = {
                method: method,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                headers: { 'Accept': 'application/json' }
            };
            if (data) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = data.length; }
            var req = mod.request(opts, function (res) {
                var buf = '';
                res.setEncoding('utf8');
                res.on('data', function (c) { buf += c; });
                res.on('error', reject);
                res.on('end', function () {
                    var obj;
                    try { obj = JSON.parse(buf || '{}'); } catch (e) { reject(new Error('响应解析失败')); return; }
                    // 服务端归口 adminJSON 包络 {ok:true,data:{...}} / adminFail {ok:false,msg}：统一解包，调用方只见 data
                    if (obj && obj.ok === true && obj.data !== undefined) { resolve(obj.data); return; }
                    if (obj && obj.ok === false) { reject(new Error(obj.msg || ('HTTP ' + res.statusCode))); return; }
                    if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode + ' ' + buf.slice(0, 200))); return; }
                    resolve(obj);
                });
            });
            req.on('error', reject);
            req.setTimeout(REQUEST_TIMEOUT, function () { try { req.destroy(new Error('请求超时')); } catch (e) { } });
            if (data) req.write(data);
            req.end();
        });
    }

    // 进度推送：force（final=true）必发，其余按 500ms 窗口节流（事件负载见 _progress 入参）
    _progress(evt) {
        var now = Date.now();
        if (!evt || !evt.final) {
            if (now - this._lastEmit < EMIT_INTERVAL) return;
            this._lastEmit = now;
        } else {
            this._lastEmit = now;
        }
        this.emit('progress', evt);
    }
}

module.exports = GameSaveManager; // 由 main.js 实例化（var gameSaves = new GameSaveManager()）
