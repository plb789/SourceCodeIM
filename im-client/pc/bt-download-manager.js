// ===== 阶段二百八十二：游戏中心 BT/P2SP 下载管理器（方案 A：x86 sidecar 宿主 + DLBT 引擎） =====
// 职责归口：BT 种子下载任务（DHT/UPnP/局域网发现 + 服务器 HTTP 直链源 P2SP 互补），接口与
//           download-manager.js 的 GameDownloadManager 镜像（start/pause/resume/cancel/status +
//           progress/done 事件），页面层无感切换。
// 引擎承载：DLBT.dll 为 x86 商业引擎，Electron x64 无法直接加载，由 dlbt-host.exe（x86 sidecar）
//           经 stdio JSON 行协议承载（协议见 dlbt-host/main.cpp 头注）；本模块管理 sidecar 生命周期。
// 落盘布局：种子 info.name=slug（服务端生成锚定），落盘 <installDir>/<slug>/<rel_path>，
//           故 BT 任务安装根 = installDir + slug（done 事件 installDir 即此根，主进程 exe 探测/
//           启动注册表与 HTTP 流程归一）。
// 完整性：BT 协议逐分片 SHA1 校验（引擎内置），HTTP 直链源字节同样按分片哈希核验，无需客户端
//         复算 manifest SHA256（大游戏全量复算双倍 IO，得不偿失）。
// 断点续传：引擎 status 文件（status/<taskId>/<taskId>.dat）跨宿主重启续传；taskId 页面按
//           每次尝试唯一生成（g<gid>-<ts>），不存在跨版本状态文件串扰。
// 任务不持久化：主进程退出任务表丢失可接受（页面按库状态重新 start，引擎按 status 文件续传）。
const { EventEmitter } = require('events');
const { app } = require('electron');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const HOST_READY_TIMEOUT = 15000; // sidecar 启动超时（含 DLBT 内核初始化/DHT bootstrap）
const EMIT_INTERVAL = 500;        // 进度节流窗口（ms），与 HTTP 管理器一致
const QUIT_GRACE = 2000;          // shutdown 时等待引擎优雅退出宽限（超时强杀）
const ESC_PREFIX = '__x__';       // 种子内转义文件名前缀（与服务端 gametorrent.go torrentEscPrefix 同规）
const SEED_MAX_MS = 12 * 3600 * 1000; // 做种上限：下载完成后引擎任务保留供种，最长 12h 自动释放；
                                      // 进程退出即停（引擎 PreShutdown 通知 Tracker Stop），重启不恢复

// 转义名映射（与服务端 gametorrent.go torrentEscName 同规）：rel 含非 ASCII →
// "__x__"+sha1(utf8(rel)) 前 16 hex。DLBT 引擎落盘时把种子内文件名字节按系统 ANSI 代码页
// （中文系统=GBK）解释而非 UTF-8（实测：UTF-8"快捷方式"落盘成"蹇嵎鏂瑰紡"，且无编码设置口），
// 故种子内含非 ASCII 的文件一律用纯 ASCII 安全名，下载完成后按清单重命名回真实 rel_path。
function torrentEscName(rel) {
    let esc = false;
    for (let i = 0; i < rel.length; i++) {
        if (rel.charCodeAt(i) > 127) { esc = true; break; }
    }
    if (!esc) return '';
    return ESC_PREFIX + crypto.createHash('sha1').update(Buffer.from(rel, 'utf8')).digest('hex').slice(0, 16);
}

// 引擎状态 → 页面任务状态映射（finished/seeding/error 由 done/error 事件沿检测转达，不在此映射）
function mapEngineState(s) {
    switch (s) {
        case 'downloading': return 'downloading';
        case 'paused': return 'paused';
        case 'checking': return 'verifying'; // 引擎启动时校验已有文件（续传场景）
        default: return null;                // queued/metainfo/allocating 等中间态不刷页面态
    }
}

class BtDownloadManager extends EventEmitter {
    constructor() {
        super();
        this.tasks = new Map();   // taskId → 任务对象（进程内表，不持久化）
        this._proc = null;        // sidecar 子进程（单实例承载全部 BT 任务）
        this._ready = false;
        this._buf = '';           // stdout 行缓冲
        this._readyWaiters = [];  // _ensureHost 等待 ready 的 resolve 队列
        this._readyTimer = null;
        this._ignoreClosed = new Set(); // 内部 release（done 后释放句柄/重置前清理）期间忽略 closed 回执
        this._quitting = false;
        this._limits = { down: 0, up: 0 };      // 全局限速（B/s，0=不限速）：ready 前暂存，就绪/重启后补发
        this._limitsApplied = false;            // 主进程是否显式下发过限速（未下发时保持宿主内置 2MB/s 上传默认）
    }

    // 全局下载/上传限速（字节/秒，0=不限速）：引擎级共享配额（全部任务+做种上传统一受限），
    // 设置页变更即时下发；宿主未就绪/异常重启时暂存，ready 后补发（见 _dispatch ready 分支）
    setLimits(downBps, upBps) {
        this._limits = {
            down: Math.min(2147483647, Math.max(0, Math.floor(Number(downBps) || 0))),
            up: Math.min(2147483647, Math.max(0, Math.floor(Number(upBps) || 0)))
        };
        this._limitsApplied = true;
        this._send({ cmd: 'limit', down: this._limits.down, up: this._limits.up });
    }

    // 注册并开始任务。payload={taskId, gameId, installDir, username, serverBase, slug, torrentUrl,
    // files:[{id,rel_path,size,sha256,url}], p2sp 可选}（via:'bt' 由主进程路由，页面只管带齐字段）。
    // p2sp=false 为下载方式 2（管理员上传种子）：纯 BT——不叠加服务器 HTTP 直链源，文件清单可为空
    // （种子内容不下发清单，完整性由 BT 分片校验承担，安装锚点信息在清单 slug 字段）。
    // 同 taskId 重复 start 幂等返回进行中状态；error/done 旧任务重置重下（引擎旧句柄先释放保数据）。
    start(payload) {
        const taskId = String((payload && payload.taskId) || '').trim();
        const slug = String((payload && payload.slug) || '').trim();
        const installDir = (payload && payload.installDir) ? path.resolve(String(payload.installDir)) : '';
        // finalDir 直传（更新/重装）：库 install_path 已是游戏根（含 slug 层），直传沿用原目录不再叠 slug
        // （此前更新下载把游戏根当安装根再拼 slug → 双层 slug 目录的根因）；引擎落盘目录取其父目录
        const directRoot = (payload && payload.finalDir) ? path.resolve(String(payload.finalDir)) : '';
        const p2sp = !(payload && payload.p2sp === false); // 缺省 true（方式 1 及历史行为不变）
        const files = (payload && Array.isArray(payload.files)) ? payload.files : [];
        if (!taskId || (!installDir && !directRoot) || !slug) return { ok: false, error: '参数缺失' };
        if (p2sp && !files.length) return { ok: false, error: '参数缺失' };
        const torrentUrl = String((payload && payload.torrentUrl) || '');
        if (!torrentUrl) return { ok: false, error: '种子地址缺失' };
        // 阶段二百九十六：Tracker 自报 IP（服务端登录回执核实的真实外网地址，socket.js → game-store
        // 透传）。仅收合法 IPv4（防域名/IPv6/非法串喂引擎），非法或空=跳过自报走引擎默认来源记录
        const reportIpRaw = String((payload && payload.reportIp) || '').trim();
        const reportIp = (/^(\d{1,3}\.){3}\d{1,3}$/.test(reportIpRaw) &&
            reportIpRaw.split('.').every(function (n) { return Number(n) <= 255; })) ? reportIpRaw : '';
        const exist = this.tasks.get(taskId);
        if (exist && exist.state !== 'error' && exist.state !== 'done') {
            return { ok: true, task: this._summary(exist) }; // 进行中（下载/暂停）：幂等
        }
        const root = directRoot || path.join(installDir, slug); // BT 安装根（游戏根口径：done 事件/exe 探测/库 install_path）
        const engineOut = directRoot ? path.dirname(directRoot) : installDir; // 引擎落盘目录（安装根，内部路径含 info.name 根）
        // 防目录穿越：rel_path 解析后必须位于安装根内，越界条目丢弃（与 HTTP 管理器同水位）
        const list = [];
        let total = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i] || {};
            const rel = String(f.rel_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel) continue;
            const abs = path.resolve(root, rel);
            if (abs !== root && !abs.startsWith(root + path.sep)) continue;
            list.push({ rel_path: rel, size: Number(f.size) || 0, sha256: String(f.sha256 || '') });
            total += Number(f.size) || 0;
        }
        if (p2sp && !list.length) return { ok: false, error: '文件清单为空或全部非法' };
        // P2SP HTTP 直链源：单一目录型 base URL（路径式鉴权——引擎把追加路径 <info.name>/<rel>
        // 拼在 base 之后且落在 query 之后，query 传参必坏，E2E 实测；服务端按路径段归口鉴权）。
        // 引擎对逐文件 URL 会当作目录 base 二次追加致全 404（E2E 实测），故绝不传文件列表。
        // p2sp=false（上传种子模式）：不下发任何 HTTP 源，纯靠种子内 tracker + DHT 找 peer。
        const manifestVersion = String((payload && payload.manifestVersion) || '').trim();
        if (p2sp && !manifestVersion) return { ok: false, error: '版本号缺失' };
        const serverBase = String(payload.serverBase || '').replace(/\/+$/, '');
        if (!serverBase) return { ok: false, error: '服务地址缺失' };
        const username = encodeURIComponent(String(payload.username || ''));
        const httpUrls = p2sp
            ? [serverBase + '/api/game/p2sp/' + username + '/' + String(payload.gameId || '') + '/' + encodeURIComponent(manifestVersion)]
            : [];
        let task;
        if (exist) {
            // 旧任务重置（error 恢复/重复完成重下）：引擎侧旧句柄先释放（保数据，closed 回执忽略），
            // 元数据一并刷新；引擎按 status 文件续传。做种中旧任务先撤做种定时器再释放
            if (exist._seedTimer) { clearTimeout(exist._seedTimer); exist._seedTimer = null; }
            this._ignoreClosed.add(taskId);
            this._send({ cmd: 'cancel', id: taskId, del: 0 });
            task = exist;
            task.reportIp = reportIp; // Tracker 自报 IP（重置重下场景刷新，可能已重新登录变更）
            task.installDir = engineOut; // 引擎落盘目录（out 透传值）
            task.root = root;
            task.username = String(payload.username || '');
            task.serverBase = String(payload.serverBase || '');
            task.torrentUrl = torrentUrl;
            task.files = list;
            task.httpUrls = httpUrls;
            task.total = total;
            task.received = 0;
            task._speed = 0;
            task._upSpeed = 0;
            task._torReady = false;
            task._torPath = this._torPathOf(taskId);
            task._statusDir = this._statusDirOf(taskId);
        } else {
            task = {
                taskId: taskId,
                gameId: String(payload.gameId || ''),
                slug: slug,
                reportIp: reportIp, // Tracker 自报 IP（合法 IPv4，空=跳过自报）
                installDir: engineOut, // 引擎落盘目录（out 透传值）
                root: root,
                username: String(payload.username || ''),
                serverBase: String(payload.serverBase || ''),
                torrentUrl: torrentUrl,
                files: list,
                httpUrls: httpUrls,
                total: total,
                received: 0,
                state: 'queued',
                _speed: 0,
                _upSpeed: 0,
                _lastEmit: 0,
                _torReady: false,
                _torPath: this._torPathOf(taskId),
                _statusDir: this._statusDirOf(taskId)
            };
            this.tasks.set(taskId, task);
        }
        this._ensureHost();
        this._runTask(task);
        return { ok: true, task: this._summary(task) };
    }

    pause(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.state === 'downloading' || task.state === 'queued') {
            task.state = 'paused';
            task._speed = 0;
            task._upSpeed = 0;
            this._send({ cmd: 'pause', id: task.taskId });
            this._emit(task, true); // 暂停终态必发一条
        }
        return { ok: true, task: this._summary(task) };
    }

    resume(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.state === 'paused') {
            task.state = 'downloading';
            task._speed = 0;
            task._upSpeed = 0;
            this._emit(task, true);
            if (task._torReady) {
                this._send({ cmd: 'resume', id: task.taskId }); // 引擎侧错误态自动走 ResumeInError
            } else {
                this._runTask(task); // 种子尚未就绪（暂停发生在取种阶段）：重跑取种链
            }
        }
        return { ok: true, task: this._summary(task) };
    }

    // 取消：引擎侧删全部已下数据与 status 文件（del=1），任务移出任务表；
    // 已完整落盘文件由引擎按种子分片记录删除，与 HTTP 取消（删 .part）语义对齐
    cancel(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        if (task._seedTimer) { clearTimeout(task._seedTimer); task._seedTimer = null; }
        task.state = 'cancelled';
        task._speed = 0;
        this._send({ cmd: 'cancel', id: task.taskId, del: 1 });
        this.tasks.delete(task.taskId);
        this._emit(task, true, null, 'cancel'); // 取消终态必发一条（页面清理 UI）
        this._safeUnlink(task._torPath);        // 本地种子缓存一并清理
        return { ok: true };
    }

    status() {
        const out = [];
        const self = this;
        this.tasks.forEach(function (t) { out.push(self._summary(t)); });
        return out;
    }

    // 任务归属判定（主进程 game:download 归口按 taskId 路由：页面 pause/resume/cancel 不带 via）
    owns(taskId) { return this.tasks.has(String(taskId || '')); }

    // 主进程退出前归口（before-quit）：通知引擎优雅退出（Release(WAIT) 逐任务保文件完整），
    // 宽限超时强杀，不阻塞退出
    shutdown() {
        this._quitting = true;
        if (!this._proc) return;
        try { this._send({ cmd: 'quit' }); } catch (e) { /* 管道已断，直接杀 */ }
        const proc = this._proc;
        setTimeout(function () {
            try { if (proc.exitCode === null && !proc.killed) proc.kill(); } catch (e) { }
        }, QUIT_GRACE);
    }

    // —— 以下为内部实现 ——

    // 任务执行链：确保 sidecar 就绪 → 下载种子到本地 → 下发 start（种子路径+输出目录+状态目录+HTTP 源）
    _runTask(task) {
        const self = this;
        task.state = 'downloading';
        this._emit(task, true);
        this._ensureHost().then(function () {
            if (task.state !== 'downloading') return; // 暂停/取消后停止推进
            return self._downloadTorrent(task).then(function () {
                task._torReady = true;
                if (task.state !== 'downloading') return;
                self._send({
                    cmd: 'start', id: task.taskId,
                    torrent: task._torPath, out: task.installDir,
                    status: task._statusDir, http: task.httpUrls,
                    report_ip: task.reportIp || '' // 引擎 DLBT_SetReportIP（空=不设置）
                });
            });
        }).catch(function (err) {
            if (task.state !== 'downloading') return; // 取消/暂停竞态
            task.state = 'error';
            task._speed = 0;
            task._upSpeed = 0;
            self._emit(task, true, (err && err.message) || 'BT 任务启动失败'); // error 必发
        });
    }

    // sidecar 生命周期：单实例，ready 前命令入队；异常退出时全部进行中任务置 error
    _ensureHost() {
        const self = this;
        if (this._ready) return Promise.resolve();
        if (this._proc) {
            return new Promise(function (resolve, reject) { self._readyWaiters.push({ resolve: resolve, reject: reject }); });
        }
        return new Promise(function (resolve, reject) {
            const exe = self._hostExePath();
            if (!fs.existsSync(exe)) { reject(new Error('BT 下载引擎缺失（dlbt-host.exe）')); return; }
            self._readyWaiters.push({ resolve: resolve, reject: reject });
            let proc;
            try {
                proc = child_process.spawn(exe, [], {
                    cwd: path.dirname(exe), // DLL 搜索锚点：DLBT.dll 与宿主 exe 同目录
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) { reject(new Error('BT 引擎启动失败：' + e.message)); return; }
            self._proc = proc;
            proc.stdout.on('data', function (chunk) { self._onStdout(chunk); });
            proc.stderr.on('data', function (chunk) {
                const s = String(chunk || '').trim();
                if (s) console.log('[dlbt-host]', s); // 引擎日志走 stderr，开发期控制台可见
            });
            proc.on('error', function (err) {
                console.error('[dlbt-host] spawn error:', err && err.message);
            });
            proc.on('exit', function (code) {
                const wasReady = self._ready;
                self._proc = null;
                self._ready = false;
                if (self._readyTimer) { clearTimeout(self._readyTimer); self._readyTimer = null; }
                const waiters = self._readyWaiters.splice(0);
                if (!self._quitting) {
                    // 异常退出：就绪等待者拒绝 + 进行中任务全部置 error（页面可重试重挂）
                    for (let i = 0; i < waiters.length; i++) waiters[i].reject(new Error('BT 引擎异常退出（code ' + code + '）'));
                    if (wasReady) {
                        self.tasks.forEach(function (t) {
                            if (t.state === 'downloading' || t.state === 'queued' || t.state === 'verifying') {
                                t.state = 'error';
                                t._speed = 0;
                                t._upSpeed = 0;
                                self._emit(t, true, 'BT 引擎异常退出');
                            }
                        });
                    }
                }
            });
            // ready 超时保护：引擎卡死（授权/端口占用等）不悬挂页面任务
            self._readyTimer = setTimeout(function () {
                if (self._ready) return;
                try { proc.kill(); } catch (e) { }
            }, HOST_READY_TIMEOUT);
        });
    }

    _onStdout(chunk) {
        this._buf += chunk.toString('utf8');
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, idx).replace(/\r$/, '');
            this._buf = this._buf.slice(idx + 1);
            if (line) this._dispatch(line);
        }
    }

    // 协议事件分发（一行一 JSON，协议见 dlbt-host/main.cpp 头注）
    _dispatch(line) {
        let m = null;
        try { m = JSON.parse(line); } catch (e) { return; }
        if (!m || !m.evt) return;
        const id = String(m.id || '');
        if (m.evt === 'ready') {
            this._ready = true;
            if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
            console.log('[dlbt-host] ready, listen port', m.port);
            // 限速补发：宿主首次就绪/异常重启后，把主进程显式下发过的限速设置同步给引擎
            // （从未配置过限速则保持宿主内置 2MB/s 上传默认值，不无谓覆盖）
            if (this._limitsApplied) this._send({ cmd: 'limit', down: this._limits.down, up: this._limits.up });
            const waiters = this._readyWaiters.splice(0);
            for (let i = 0; i < waiters.length; i++) waiters[i].resolve();
            return;
        }
        if (m.evt === 'fatal') {
            // 引擎内核启动失败：杀掉自身触发 exit 链路（waiters 拒绝 + 任务 error）
            console.error('[dlbt-host] fatal:', m.error);
            if (this._proc) { try { this._proc.kill(); } catch (e) { } }
            return;
        }
        const task = this.tasks.get(id);
        if (!task) return; // 已取消/内部 release 的任务回执：忽略
        if (m.evt === 'progress') {
            if (task.state === 'done') {
                // 做种中：完成终态不再刷下载进度，上传速度仍转发（页面"做种中"实时展示供速）
                const upSeed = Number(m.up) || 0;
                if (upSeed !== task._upSpeed) { task._upSpeed = upSeed; this._emit(task, false); }
                return;
            }
            const received = Number(m.received) || 0;
            const total = Number(m.total) || task.total;
            task.received = received;
            task.total = total;
            task._speed = Number(m.down) || 0;
            task._upSpeed = Number(m.up) || 0; // BT 上传速率（给 peer 供速），页面与下载速率分示
            const mapped = mapEngineState(String(m.state || ''));
            if (mapped && task.state !== 'done' && task.state !== 'error') {
                if (task.state !== mapped) { task.state = mapped; this._emit(task, true); return; }
            }
            this._emit(task, false);
        } else if (m.evt === 'done') {
            if (task.state === 'done' || task.state === 'cancelled') return;
            this._renameEscaped(task); // 转义名回真实名（先于完成事件，页面入库时布局已就绪）
            task.state = 'done';
            task.received = task.total;
            task._speed = 0;
            this._emit(task, true);
            this.emit('done', {
                taskId: task.taskId, gameId: task.gameId,
                installDir: task.root, // BT 安装根（installDir+slug），主进程 exe 探测/注册表归一
                username: task.username
            });
            // 完成即转做种：引擎句柄保留（不再立即 cancel），任务在 BTDS_SEEDING 态对外供种，
            // 引擎按种子内 tracker + DHT 周期 announce 让其他 peer 发现本机；SEED_MAX_MS 到期
            // 或进程退出（引擎 PreShutdown 通知 Tracker Stop）即停，重启不恢复做种（需求口径）。
            // 种子文件已加载进引擎内存，磁盘缓存照删；status 文件无保留价值（不跨重启续做种），
            // 引擎持有句柄时删除失败仅残留（taskId 每次尝试唯一，无复用风险）
            this._safeUnlink(task._torPath);
            this._safeUnlink(path.join(task._statusDir, task.taskId + '.dat'));
            this._armSeedTimer(task);
        } else if (m.evt === 'error') {
            if (task.state === 'done' || task.state === 'cancelled' || task.state === 'error') return;
            task.state = 'error';
            task._speed = 0;
            task._upSpeed = 0;
            this._emit(task, true, String(m.error || 'BT 下载失败')); // error 必发
        } else if (m.evt === 'closed') {
            if (this._ignoreClosed.delete(id)) return; // 内部 release 的回执
            // 取消链路回执：任务已从表移除，此处无状态可刷（引擎删数据为异步过程，无需等待）
        } else if (m.evt === 'start_fail') {
            if (task.state === 'done' || task.state === 'cancelled') return;
            task.state = 'error';
            task._speed = 0;
            task._upSpeed = 0;
            this._emit(task, true, 'BT 任务挂载失败（' + String(m.error || '未知错误') + '）');
        }
    }

    // 做种定时：完成后挂 SEED_MAX_MS 到期收口（进程退出定时器不阻止退出）；收口时释放引擎
    // 句柄（del=0 保数据），任务移出任务表（closed 回执由 _ignoreClosed 挡掉）
    _armSeedTimer(task) {
        const self = this;
        if (task._seedTimer) clearTimeout(task._seedTimer);
        task._seedTimer = setTimeout(function () { self._releaseSeed(task); }, SEED_MAX_MS);
        if (task._seedTimer && task._seedTimer.unref) task._seedTimer.unref();
    }

    _releaseSeed(task) {
        if (task._seedTimer) { clearTimeout(task._seedTimer); task._seedTimer = null; }
        if (task.state !== 'done') return; // 仅完成做种态走此收口（取消/重下有各自清理链）
        this.tasks.delete(task.taskId);
        this._ignoreClosed.add(task.taskId);
        this._send({ cmd: 'cancel', id: task.taskId, del: 0 });
    }

    // 转义名回真实名：种子内非 ASCII 文件以 __x__<sha1 前 16 hex> 落盘（见 torrentEscName 注释），
    // 完成后按清单映射逐个重命名回真实 rel_path（多级目录按需创建）。单个失败不阻塞完成——
    // 文件内容已过 BT 分片校验，重命名异常留待库内修复入口处理
    _renameEscaped(task) {
        const map = {};
        for (let i = 0; i < task.files.length; i++) {
            const e = torrentEscName(task.files[i].rel_path);
            if (e) map[e] = task.files[i].rel_path;
        }
        if (!Object.keys(map).length) return;
        const root = task.root;
        const walk = (dir) => {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const ent of entries) {
                const abs = path.join(dir, ent.name);
                if (ent.isDirectory()) { walk(abs); continue; }
                const target = map[ent.name];
                if (!target) continue;
                const dest = path.join(root, target);
                try {
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.renameSync(abs, dest);
                } catch (e) {
                    console.error('[bt] 转义名回 rename 失败:', ent.name, '→', target, e && e.message);
                }
            }
        };
        walk(root);
    }

    _send(obj) {
        if (!this._proc || this._proc.exitCode !== null) return; // 未就绪/已退出：静默丢弃（引擎退出链路已置任务 error）
        try {
            this._proc.stdin.write(JSON.stringify(obj) + '\n');
        } catch (e) { /* 管道断裂：exit 事件统一收口 */ }
    }

    // 下载种子文件到本地缓存（userData/game-torrents/<taskId>.torrent）：
    // 服务端种子接口与文件下载同水位鉴权（username 参数），重定向跟随 ≤3 跳
    _downloadTorrent(task) {
        const self = this;
        return new Promise(function (resolve, reject) {
            const url = self._buildUrl(task, task.torrentUrl);
            if (!url) { reject(new Error('种子地址非法')); return; }
            const attempt = function (u, redirects) {
                if (task.state !== 'downloading') { reject({ paused: true }); return; }
                const mod = u.indexOf('https:') === 0 ? https : http;
                const req = mod.get(u, function (res) {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                        res.resume();
                        try { attempt(new URL(res.headers.location, u).toString(), redirects + 1); }
                        catch (e) { reject(new Error('种子重定向地址非法')); }
                        return;
                    }
                    if (res.statusCode !== 200) { res.resume(); reject(new Error('种子下载失败（服务端返回 ' + res.statusCode + '）')); return; }
                    const chunks = [];
                    let size = 0;
                    res.on('data', function (c) { chunks.push(c); size += c.length; if (size > 16 * 1024 * 1024) { req.destroy(); reject(new Error('种子文件异常超大')); } });
                    res.on('error', function () { reject(new Error('种子下载连接中断')); });
                    res.on('end', function () {
                        const body = Buffer.concat(chunks);
                        // bencode 种子必以 'd' 开头（字典），轻校验防把错误页当种子喂引擎
                        if (!body.length || body[0] !== 0x64) { reject(new Error('种子内容非法')); return; }
                        fs.mkdir(path.dirname(task._torPath), { recursive: true }, function (mkErr) {
                            if (mkErr) { reject(new Error('种子缓存目录创建失败：' + mkErr.message)); return; }
                            fs.writeFile(task._torPath, body, function (wErr) {
                                if (wErr) reject(new Error('种子落盘失败：' + wErr.message));
                                else resolve();
                            });
                        });
                    });
                });
                req.on('error', function (err) {
                    if (task.state !== 'downloading') return;
                    reject(new Error('种子下载网络错误：' + ((err && err.message) || '连接失败')));
                });
            };
            attempt(url, 0);
        });
    }

    // 拼完整地址（与 HTTP 管理器 _buildUrl 同规）：相对地址拼 serverBase，统一补 username 参数
    _buildUrl(task, u) {
        u = String(u || '');
        if (!u) return '';
        if (/^https?:\/\//i.test(u)) {
            return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
        }
        const base = String(task.serverBase || '').replace(/\/+$/, '');
        if (!base) return '';
        u = base + (u.indexOf('/') === 0 ? u : '/' + u);
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
    }

    // 本地路径归口：种子缓存 / status 状态目录 / 宿主 exe（打包后取 resources/dlbt-host）
    _torPathOf(taskId) { return path.join(this._torDir(), taskId + '.torrent'); }
    _statusDirOf(taskId) { return path.join(this._torDir(), 'status', taskId); }
    _torDir() {
        try { return path.join(app.getPath('userData'), 'game-torrents'); } catch (e) { return path.join(__dirname, 'game-torrents'); }
    }
    _hostExePath() {
        const name = 'dlbt-host.exe';
        if (app && app.isPackaged) return path.join(process.resourcesPath, 'dlbt-host', name);
        return path.join(__dirname, 'dlbt-host', name);
    }

    // 速度/节流推送：引擎 1s 一条进度，此处仅做统一出口（节流窗口与 HTTP 管理器一致）
    _emit(task, force, error, stateOverride) {
        const now = Date.now();
        if (!force && now - task._lastEmit < EMIT_INTERVAL) return;
        task._lastEmit = now;
        this.emit('progress', {
            taskId: task.taskId,
            gameId: task.gameId,
            received: task.received,
            total: task.total,
            speed: task._speed,
            diskSpeed: task._speed, // BT 引擎内部直写磁盘，落盘吞吐≈下载速率（口径与 HTTP 通道对齐）
            upSpeed: task._upSpeed || 0, // BT 上传速率（HTTP 通道无此字段，页面按 via 区分展示）
            state: stateOverride || task.state,
            fileRelPath: '', // BT 通道引擎不回报单文件粒度，页面展示整体进度
            error: error || null
        });
    }

    _summary(task) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            installDir: task.root, // 摘要口径与 done 事件一致（BT 安装根）
            username: task.username,
            state: task.state,
            received: task.received,
            total: task.total,
            filesCount: task.files.length,
            speed: task._speed,
            diskSpeed: task._speed,
            upSpeed: task._upSpeed || 0,
            via: 'bt'
        };
    }

    _safeUnlink(p) {
        if (!p) return;
        try { fs.unlink(p, function () { }); } catch (e) { }
    }
}

module.exports = BtDownloadManager; // 由 main.js 实例化（var btDownloads = new BtDownloadManager()）
