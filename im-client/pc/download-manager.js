// ===== 阶段二百八十一：游戏中心下载管理器（Steam 同款游戏浏览/下载 P1 主进程部分） =====
// 职责归口：游戏文件多任务下载（同任务串行逐文件、跨任务并行上限 2 超出排队）、
//           断点续传（.part + Range 请求，服务端 200 时重头写）、SHA256/大小双校验（失败删文件重试 ≤2 次）、
//           暂停/恢复/取消（cancel 清 .part 与未完成文件，已完整落盘且校验过的正式文件保留）、
//           进度事件 500ms 节流（state:'done' 完成必发一条，error 亦必发）。
// 由 main.js 实例化并监听 progress/done：progress 转发全部窗口；done 探测安装目录唯一 .exe 写启动注册表。
// 任务不持久化：进程退出任务丢失可接受（页面按库状态重新 start，磁盘 .part 断点自动续传）。
// 落盘布局（Steam 同款，阶段二百八十三）：每游戏正式目录 <installDir>/<slug>，下载全程先落同盘暂存目录
//           <installDir>/downloading/<slug>，全部文件校验通过后同盘 rename 一次性换入正式目录（旧版本
//           先挪 .old-<ts> 腾位，换入失败回滚，成功后异步清理备份）；done 事件 installDir 即正式目录。
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process'); // ZIP 打包版本解压阶段（7z 子进程，spawn 不经 shell）
const { app } = require('electron'); // 打包态 resources 路径锚点（7z 组件定位，与 BT 引擎同构）

const MAX_PARALLEL = 2;    // 跨任务并行下载上限，超出排队
const EMIT_INTERVAL = 500; // 进度节流窗口（ms），同时作为速度计算窗口
const MAX_FILE_RETRY = 2;  // 单文件校验失败重试上限（仍失败任务置 error）
const STAGING_DIRNAME = 'downloading'; // 同盘暂存目录名（正式目录 <root>/<slug>，暂存 <root>/downloading/<slug>）
// —— 多线程分块下载常量 ——
const MAX_CHUNKS = 8;          // 单文件最大并发分块数（对标 BT 引擎 SetMaxSessionPerHttp=8）
const MIN_TOTAL_FOR_CHUNK = 16 * 1024 * 1024; // 文件小于此阈值时不启用分块（多连接开销 > 收益）
const CHUNK_RESUME_INTERVAL = 2000;           // 分块状态文件 flush 间隔（ms，防崩溃丢失进度过多）

class GameDownloadManager extends EventEmitter {
    constructor() {
        super();
        this.tasks = new Map(); // taskId → 任务对象（进程内表，不持久化）
        // 全局下载限速（令牌桶，跨任务共享配额）：down=B/s（0=不限），桶容量=1 秒配额防长暂停后爆发。
        // 注意不能用 res.pipe + res.pause 实现节流：pipe 会在写盘 drain 时自动 resume 源流覆盖 pause，
        // 故下载改为手动写盘 + 请求级挂起队列（见 _downloadFile 门控），令牌恢复由补充定时器放行
        this._lim = { down: 0, tokens: 0, last: 0, timer: null, waiters: new Set() };
    }

    // 全局下载限速（字节/秒，0=不限速）：设置页变更即时生效——清限速时放行全部挂起数据并停补充定时器
    // （HTTP 通道无上传概念，上传限速仅 BT 引擎侧生效）
    setLimits(downBps) {
        const L = this._lim;
        L.down = Math.min(2147483647, Math.max(0, Math.floor(Number(downBps) || 0)));
        if (L.down <= 0) {
            if (L.timer) { clearInterval(L.timer); L.timer = null; }
            const ws = Array.from(L.waiters);
            L.waiters.clear();
            L.tokens = 0;
            ws.forEach(function (w) { w.flush(); }); // 全速放行（down=0 时 pump 不再判令牌）
        }
    }

    // 补充定时器（100ms 粒度）：令牌恢复至非负后唤醒全部限速挂起的请求写入门控
    _armRefill() {
        const L = this._lim;
        if (L.timer) return;
        L.last = Date.now();
        L.timer = setInterval(function () {
            const now = Date.now();
            L.tokens += L.down * (now - L.last) / 1000; // 按实际间隔补充（防定时器漂移超发）
            L.last = now;
            if (L.tokens > L.down) L.tokens = L.down;   // 桶容量上限=1 秒配额
            if (L.tokens >= 0) {
                const ws = Array.from(L.waiters);
                ws.forEach(function (w) { w.pump(); });
                if (!L.waiters.size) { clearInterval(L.timer); L.timer = null; } // 全部放行后停表（防常驻）
            }
        }, 100);
        if (L.timer.unref) L.timer.unref(); // 不阻止主进程退出
    }

    // 注册并开始任务。payload={taskId, gameId, installDir, slug, username, serverBase, files:[{id,rel_path,size,sha256,url}]}
    // installDir 为安装根（<盘>/CdonlgameApp），实际落盘 <installDir>/<slug>（暂存 <installDir>/downloading/<slug>）
    // finalDir 直传（更新/重装）：库记录的 install_path 已是游戏根（含 slug 层），直传沿用原目录不再叠 slug
    // （此前更新下载把游戏根当安装根再拼 slug → 双层 slug 目录的根因）；同 taskId 重复 start 幂等返回进行中状态；
    // error/done 旧任务重置重下（磁盘 .part 保留即断点续传）
    start(payload) {
        const taskId = String((payload && payload.taskId) || '').trim();
        const files = (payload && Array.isArray(payload.files)) ? payload.files : null;
        const directRoot = (payload && payload.finalDir) ? path.resolve(String(payload.finalDir)) : '';
        if (!taskId || !files || !files.length || !(directRoot || (payload && payload.installDir))) return { ok: false, error: '参数缺失' };
        const exist = this.tasks.get(taskId);
        if (exist && exist.state !== 'error' && exist.state !== 'done') {
            return { ok: true, task: this._summary(exist) }; // 进行中（排队/下载/暂停）：幂等
        }
        // 每游戏子目录：正式 <installDir>/<slug>，暂存 <installDir>/downloading/<slug>（同盘 rename 一次性换入）；
        // finalDir 直传时安装根取游戏根父目录（暂存同盘不跨盘）
        const root = directRoot ? path.dirname(directRoot) : path.resolve(String(payload.installDir));
        const slug = String((payload && payload.slug) || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
        if (!slug || slug === '.' || slug === '..') return { ok: false, error: '缺少游戏标识 slug' };
        const finalDir = directRoot || path.join(root, slug);
        const stagingDir = path.join(root, STAGING_DIRNAME, slug);
        // 安全校验（致命防呆）：finalDir（游戏根）必须是 root（安装根）的子目录且末级目录名等于 slug。
        // 历史 bug：库 install_path 误存安装根被当作 finalDir 直传，导致 root=盘根、finalDir=安装根，
        // _commit 把整个安装根 rename 清空。末级目录名校验可精准区分安装根与游戏根。
        try {
            const fNorm = path.resolve(finalDir);
            const rNorm = path.resolve(root);
            const rel = path.relative(rNorm, fNorm);
            const leaf = path.basename(fNorm);
            if (fNorm === rNorm || rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ||
                leaf.toLowerCase() !== slug.toLowerCase()) {
                return { ok: false, error: '安装目录参数异常：游戏根不是安装根的子目录或与 slug 不匹配，已拒绝执行以防数据丢失' };
            }
        } catch (e) {
            return { ok: false, error: '安装目录校验失败：' + e.message };
        }
        // 防目录穿越：rel_path 解析后必须位于暂存目录内，越界条目丢弃
        const list = [];
        // ZIP 打包版本（新增通道）：0=散文件现状 1=单 ZIP（下载后自动解压） 2=分卷 ZIP（7z 分卷解压）。
        // 3=补丁包（服务端已解包合成完整散文件清单，客户端按散文件语义走——dedup 硬链接天然增量，
        // _commit 整目录换入使删除文件自动生效），归一为 0 防误入解压阶段
        const pt = Number((payload && payload.packType) || 0);
        const packType = (pt === 1 || pt === 2) ? pt : 0;
        const packSize = Math.max(0, Number((payload && payload.packSize) || 0));
        for (let i = 0; i < files.length; i++) {
            const f = files[i] || {};
            const rel = String(f.rel_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel) continue;
            const abs = path.resolve(stagingDir, rel);
            if (abs !== stagingDir && !abs.startsWith(stagingDir + path.sep)) continue;
            list.push({
                id: f.id,
                rel_path: rel,
                size: Number(f.size) || 0,
                sha256: String(f.sha256 || '').toLowerCase(),
                url: String(f.url || '')
            });
        }
        if (!list.length) return { ok: false, error: '文件清单为空或全部非法' };
        let task;
        if (exist) {
            // 旧任务重置（error 恢复/重复完成重下）：换目录/账号等元数据一并刷新
            task = exist;
            task.installDir = finalDir;
            task.stagingDir = stagingDir;
            task.root = root; // 安装根（暂存目录父级；摘要/done 对外报 installDir=游戏根）
            task.slug = slug; // 游戏标识（_commit 末级目录名校验用）
            task.username = String(payload.username || '');
            task.serverBase = String(payload.serverBase || '');
            task.direct = Number(payload.download_method) === 3; // 直连模式（商户自带文件服务器）：错误文案分流 + https 强制
            task.files = list;
            task.packType = packType; // ZIP 打包方式（重试重下时一并刷新，解压标记复位）
            task.packSize = packSize;
            task._extracted = false;
            task._phase = 'download';
            task._extractProc = null;
            task.total = this._calcTotal(list);
            task.fileIndex = 0;
            task.retries = 0;
            task.received = 0;          // 总处理字节（下载+去重复用，用于整体进度条）
            task.netReceived = 0;       // 实际网络下载字节（速度/净下载量统计）
            task.dedupedCount = 0;      // 去重复用文件数
            task.dedupedBytes = 0;      // 去重复用总字节
            task._speed = 0;
            task._currentRel = '';
        } else {
            task = {
                taskId: taskId,
                gameId: String(payload.gameId || ''),
                installDir: finalDir,   // 正式目录（done 事件对外即此，供主进程探测 .exe 登记启动）
                stagingDir: stagingDir, // 暂存目录（下载全程落此，完成后换入 installDir）
                root: root,             // 安装根（暂存目录父级；摘要/done 对外报 installDir=游戏根）
                slug: slug,             // 游戏标识（_commit 末级目录名校验用）
                username: String(payload.username || ''),
                serverBase: String(payload.serverBase || ''),
                direct: Number(payload.download_method) === 3, // 直连模式（商户自带文件服务器）
                files: list,
                packType: packType,     // ZIP 打包方式（0=散文件 1=单 ZIP 2=分卷 ZIP；>0 下载后走解压阶段）
                packSize: packSize,     // 解压后总大小（磁盘余量预检 + 解压进度条总量换算；0=未知）
                state: 'queued',
                received: 0,          // 总处理字节（下载+去重复用，用于整体进度条）
                netReceived: 0,       // 实际网络下载字节（速度/净下载量统计）
                dedupedCount: 0,      // 去重复用文件数
                dedupedBytes: 0,      // 去重复用总字节
                total: this._calcTotal(list),
                fileIndex: 0,
                startedAt: 0,
                retries: 0,
                _reqs: null,       // 当前文件活跃 http 请求集合（Set，暂停/取消遍历 destroy）
                _speed: 0,         // 500ms 窗口速度（B/s）
                _diskBytes: 0,     // 磁盘写入字节累计（落盘吞吐采集）
                _diskSpeed: 0,     // 500ms 窗口磁盘写入速度（B/s）
                _lastDiskBytes: 0, // 磁盘写入窗口基准字节
                _lastEmit: 0,      // 上次进度推送时间（节流）
                _lastBytes: 0,     // 速度窗口基准字节
                _lastTime: 0,      // 速度窗口基准时间
                _currentRel: ''    // 当前下载文件相对路径（事件负载 fileRelPath）
            };
            this.tasks.set(taskId, task);
        }
        task.state = 'queued';
        this._schedule();
        return { ok: true, task: this._summary(task) };
    }

    // 暂停：销毁当前连接保留 .part（断点），排队中任务同样允许暂停
    pause(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.state === 'downloading' && task._phase === 'extract') {
            return { ok: false, error: '解压阶段不支持暂停（可取消，已下载的压缩包会保留）' };
        }
        if (task.state === 'downloading' || task.state === 'queued') {
            task._paused = true;
            task.state = 'paused';
            task._speed = 0;
            task._diskSpeed = 0;
            // 销毁所有活跃请求（单连接/多分块统一归口）
            if (task._reqs) {
                task._reqs.forEach(function (r) { try { r.destroy(); } catch (e) { } });
                task._reqs.clear();
            }
            this._emit(task, task._currentRel, null, true); // 暂停终态必发一条
        }
        return { ok: true, task: this._summary(task) };
    }

    // 恢复：回到排队队列由调度器按并行上限启动（.part 断点自动续传）
    resume(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        if (task.state === 'paused') {
            task._paused = false;
            task.state = 'queued';
            task._speed = 0;
            task._lastTime = 0; // 重置速度窗口，避免恢复瞬间速度虚高
            this._schedule();
        }
        return { ok: true, task: this._summary(task) };
    }

    // 取消：中断请求 + 删除 .part 与未完成文件（已完整落盘且校验过的正式文件保留），任务移出任务表
    cancel(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        const wasActive = task.state === 'downloading';
        task.state = 'cancelled'; // 中断标记：进行中的下载 Promise 按外部中断处理
        if (task._reqs) {
            task._reqs.forEach(function (r) { try { r.destroy(); } catch (e) { } });
            task._reqs.clear();
        }
        if (task._extractProc) { try { task._extractProc.kill(); } catch (e) { } } // 解压阶段：杀 7z（压缩包保留，重试免重下）
        const self = this;
        const pend = [];
        task.files.forEach(function (f) {
            const base = path.resolve(task.stagingDir, f.rel_path);
            pend.push(self._safeUnlink(base + '.part'));
            pend.push(self._safeUnlink(base + '.part-chunks')); // 分块断点状态文件一并清理
        });
        const fin = function () {
            self._emit(task, '', null, true, 'cancel'); // 取消终态必发一条（页面清理 UI），随后任务从表移除
            self.tasks.delete(task.taskId);
            if (wasActive) self._schedule();
        };
        if (pend.length) Promise.all(pend).then(fin, fin);
        else fin();
        return { ok: true };
    }

    // 当前全部任务摘要数组（status 轮询用）
    status() {
        const out = [];
        const self = this;
        this.tasks.forEach(function (t) { out.push(self._summary(t)); });
        return out;
    }

    // 任务归属判定（主进程 game:download 归口按 taskId 路由：页面 pause/resume/cancel 不带 via）
    owns(taskId) { return this.tasks.has(String(taskId || '')); }

    // —— 以下为内部实现 ——

    // 并行调度：统计 downloading 数，依次启动 queued 任务至上限（任务结束/暂停/出错后均重调度）
    _schedule() {
        const self = this;
        let active = 0;
        this.tasks.forEach(function (t) { if (t.state === 'downloading') active++; });
        this.tasks.forEach(function (t) {
            if (active >= MAX_PARALLEL) return;
            if (t.state === 'queued') {
                t.state = 'downloading';
                active++;
                self._runTask(t);
            }
        });
    }

    // 任务执行循环：逐文件串行下载；校验类失败删坏文件重试 ≤MAX_FILE_RETRY 次，仍失败任务置 error
    _runTask(task) {
        const self = this;
        if (!task.startedAt) task.startedAt = Date.now();
        const next = function () {
            if (task.state !== 'downloading') return; // 暂停/取消/出错后停止推进
            if (task.fileIndex >= task.files.length) { self._finish(task); return; }
            const file = task.files[task.fileIndex];
            task._currentRel = file.rel_path;
            task.retries = task.retries || 0;
            self._recalcReceived(task); // 基线校准（断点续传/重试/恢复后 received 精确）
            self._emit(task, file.rel_path, null, true); // 切文件立即推一条（fileRelPath 变化）
            self._downloadFile(task, file).then(function () {
                task.retries = 0;
                task.fileIndex++;
                next();
            }).catch(function (err) {
                if (err && err.paused) { self._schedule(); return; } // 暂停中断：状态已置 paused，仅调度其它任务
                if (task.state !== 'downloading') { self._schedule(); return; } // 取消等外部中断
                if (err && err.verify && task.retries < MAX_FILE_RETRY) {
                    task.retries++; // 校验失败（大小/哈希/断点越界）：坏文件已删，重试同一文件
                    next();
                    return;
                }
                task.state = 'error';
                task._speed = 0;
                task._diskSpeed = 0;
                self._emit(task, file.rel_path, (err && err.message) || '下载失败', true); // error 必发
                self._schedule();
            });
        };
        next();
    }

    // 下载单个文件：多线程分块（Range 并发 + 偏移写入 + 块级断点续传）/ 单连接断点续传（.part + Range）
    // 自动降级：文件太小/不支持 Range → 回退单连接。rename 正式名 → 大小/SHA256 流式校验。
    // reject 载荷：{paused:true} 暂停中断 / {verify:true} 校验类失败（可重试）/ {message} 其它错误
    _downloadFile(task, file) {
        const self = this;
        // 请求代数在入口同步递增（mkdir 回调是异步跳板，代数必须先于任何异步事件落定）：
        // 暂停后快速恢复时，旧请求的中止回调晚于新请求发起到达，gen 不符即整体忽略，防误判新下载失败
        const myGen = task._reqGen = (task._reqGen || 0) + 1;
        return new Promise(function (resolve, reject) {
            const abs = path.resolve(task.stagingDir, file.rel_path);
            const partAbs = abs + '.part';
            const chunksAbs = abs + '.part-chunks'; // 分块断点状态文件（块级续传用）
            // 上次会话已完整落盘且校验过的文件（rename 前提即校验通过）直接跳过，秒级恢复。
            // 重启恢复时 netReceived 已归零，需补计已落盘字节，避免进度条与 "X MB / total" 文本脱节。
            try {
                const st0 = fs.statSync(abs);
                if (st0.isFile() && file.size > 0 && st0.size === file.size) {
                    task.netReceived += file.size;
                    resolve();
                    return;
                }
            } catch (e) { /* 正式文件不存在，正常下载 */ }
            // 增量去重：已安装目录下同路径同大小同 SHA 文件直接硬链接/复制到暂存目录，跳过下载。
            // 补丁更新核心——只下载变更文件，未变更文件从本地复用；_commit 全量替换时暂存目录已
            // 含全部文件（变更的下载 + 未变更的复用），不会丢文件。
            const localAbs = path.resolve(task.installDir, file.rel_path);
            let dedupTried = false;
            try {
                const lst = fs.statSync(localAbs);
                if (lst.isFile() && file.size > 0 && lst.size === file.size) {
                    dedupTried = true;
                    const lh = crypto.createHash('sha256');
                    const lrs = fs.createReadStream(localAbs);
                    lrs.on('data', function (c) { lh.update(c); });
                    lrs.on('error', function () { go(); });
                    lrs.on('end', function () {
                        const localSha = lh.digest('hex');
                        if (file.sha256 && localSha === file.sha256) {
                            // 内容一致：硬链接优先（同盘 O(1) 不占额外空间），失败回退复制
                            task.dedupedCount++;
                            task.dedupedBytes += file.size;
                            fs.mkdir(path.dirname(abs), { recursive: true }, function (mkErr2) {
                                if (mkErr2) { go(); return; }
                                try { fs.unlinkSync(abs); } catch (e) { /* 不存在忽略 */ }
                                fs.link(localAbs, abs, function (lkErr) {
                                    if (!lkErr) { resolve(); return; }
                                    const cin = fs.createReadStream(localAbs);
                                    const cout = fs.createWriteStream(abs);
                                    cin.pipe(cout);
                                    cout.on('finish', function () { resolve(); });
                                    cout.on('error', function () { go(); });
                                    cin.on('error', function () { go(); });
                                });
                            });
                        } else { go(); }
                    });
                }
            } catch (e) { /* 本地不存在或异常，走下载 */ }
            if (!dedupTried) go();

            function go() {
                fs.mkdir(path.dirname(abs), { recursive: true }, function (mkErr) {
                    if (mkErr) { reject({ message: '创建目录失败：' + mkErr.message }); return; }
                    const url = self._buildUrl(task, file);
                    if (!url) { reject({ message: task.direct ? '清单缺少直连地址（rel_path: ' + file.rel_path + '）' : '文件下载地址缺失' }); return; }
                    // 直连模式（商户自带文件服务器）：强制 https（防中间人篡改；清单 SHA256 是第二道校验）
                    if (task.direct && url.indexOf('https:') !== 0) {
                        reject({ message: '直连下载已中止：文件服务器地址必须为 https（来源：' + url.split('/').slice(0, 3).join('/') + '）' });
                        return;
                    }
                    const hasChunksState = fs.existsSync(chunksAbs);
                    // 多线程分块启用条件：有断点状态文件（续传）或 文件足够大（头探测 Range 支持）
                    if (hasChunksState) { goChunked(url, true); }
                    else if (file.size >= MIN_TOTAL_FOR_CHUNK) { probeRange(url); }
                    else { goSingle(url, 0); }
                });
            }

            // HEAD 探测服务端 Range 支持 → 支持则分块下载，否则回退单连接
            function probeRange(url) {
                if (task.state !== 'downloading') { reject({ paused: true }); return; }
                const mod = url.indexOf('https:') === 0 ? https : http;
                const req = mod.request({ method: 'HEAD', url: url, headers: {} }, function (res) {
                    res.resume();
                    const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase();
                    // 302 跟随（预签名 URL 常见）
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        try { probeRange(new URL(res.headers.location, url).toString()); }
                        catch (e) { goSingle(url, 0); }
                        return;
                    }
                    if (res.statusCode === 200 && acceptRanges.indexOf('bytes') >= 0) {
                        goChunked(url, false);
                    } else {
                        goSingle(url, 0);
                    }
                });
                req.on('error', function () { goSingle(url, 0); }); // HEAD 失败不阻塞，回退单连接
                req.end();
            }

            // —— 多线程分块下载核心 ——
            // 架构：按 MAX_CHUNKS 均分文件为 N 段，每段独立 Range 请求 + fs.write(fd, buf, 0, len, position) 偏移写入。
            // 断点续传：.part-chunks 记录每段已下载字节；恢复时从 start+downloaded 续拉该段 Range。
            // 限速：每段各自挂全局令牌桶（与单连接同 limiter）。进度/速度由全局 tick 统一推送。
            function goChunked(finalUrl, isResume) {
                if (task.state !== 'downloading') { reject({ paused: true }); return; }
                task._reqs = new Set();
                // 构造块列表
                let chunks;
                if (isResume) {
                    try {
                        const raw = fs.readFileSync(chunksAbs, 'utf8');
                        const saved = JSON.parse(raw);
                        if (saved && saved.totalSize === file.size && Array.isArray(saved.chunks)) {
                            chunks = saved.chunks.map(function (c) {
                                return { start: c.start, end: c.end, downloaded: c.downloaded || 0 };
                            });
                        }
                    } catch (e) { /* 状态文件损坏 → 全量重来 */ }
                }
                if (!chunks) {
                    // 均分：每块 ≈ file.size / MAX_CHUNKS，最后一块含余量
                    const n = Math.min(MAX_CHUNKS, Math.max(1, Math.floor(file.size / (4 * 1024 * 1024)))); // 至少 4MB/块
                    chunks = [];
                    const chunkSize = Math.floor(file.size / n);
                    for (let i = 0; i < n; i++) {
                        const start = i * chunkSize;
                        const end = (i === n - 1) ? (file.size - 1) : (start + chunkSize - 1);
                        chunks.push({ start: start, end: end, downloaded: 0 });
                    }
                }
                // 打开 .part 文件：续传用 'r+'（保留已有内容），全新用 'w+'（创建/截断）
                const flags = isResume ? 'r+' : 'w+';
                fs.open(partAbs, flags, function (fdErr, fd) {
                    if (fdErr) { reject({ message: '打开下载文件失败：' + fdErr.message }); return; }
                    let settled = false;
                    let chunksDone = 0;
                    let chunksFailed = false;
                    let resumeFlushTimer = null;
                    let lastResumeFlush = Date.now();
                    // 定期 flush 分块状态文件（防崩溃丢失过多进度）
                    const scheduleFlush = function () {
                        if (resumeFlushTimer) return;
                        const now = Date.now();
                        if (now - lastResumeFlush < CHUNK_RESUME_INTERVAL) {
                            resumeFlushTimer = setTimeout(function () {
                                resumeFlushTimer = null;
                                flushChunks();
                            }, CHUNK_RESUME_INTERVAL - (now - lastResumeFlush));
                        } else {
                            flushChunks();
                        }
                    };
                    const flushChunks = function () {
                        lastResumeFlush = Date.now();
                        const state = { totalSize: file.size, chunks: chunks.map(function (c) {
                            return { start: c.start, end: c.end, downloaded: c.downloaded };
                        })};
                        try { fs.writeFileSync(chunksAbs, JSON.stringify(state)); } catch (e) { }
                    };
                    const failAll = function (err) {
                        if (settled) return;
                        settled = true;
                        if (resumeFlushTimer) { clearTimeout(resumeFlushTimer); resumeFlushTimer = null; }
                        try { fs.closeSync(fd); } catch (e) { }
                        task._reqs = null;
                        if (myGen !== task._reqGen) { reject({ paused: true }); return; }
                        if (task.state === 'paused') reject({ paused: true });
                        else reject(err);
                    };
                    const chunkDone = function () {
                        chunksDone++;
                        if (chunksDone >= chunks.length && !chunksFailed) {
                            flushChunks(); // 完成前最后一次状态落盘（其实用不到了，但保持一致）
                            try { fs.closeSync(fd); } catch (e) { }
                            task._reqs = null;
                            // 大小校验
                            let totalWritten = 0;
                            for (let i = 0; i < chunks.length; i++) totalWritten += chunks[i].downloaded;
                            if (file.size > 0 && totalWritten !== file.size) {
                                self._safeUnlink(partAbs);
                                self._safeUnlink(chunksAbs);
                                reject({ verify: true, message: '文件大小不符' });
                                return;
                            }
                            // 删除分块状态文件，rename 正式名，SHA256 校验
                            self._safeUnlink(chunksAbs).then(function () {
                                fs.rename(partAbs, abs, function (rnErr) {
                                    if (rnErr) { reject({ message: '写入失败：' + rnErr.message }); return; }
                                    self._emit(task, file.rel_path, null, true, 'verifying');
                                    const h = crypto.createHash('sha256');
                                    const rs = fs.createReadStream(abs);
                                    rs.on('data', function (c) { h.update(c); });
                                    rs.on('error', function () {
                                        self._safeUnlink(abs);
                                        reject({ verify: true, message: '校验读取失败' });
                                    });
                                    rs.on('end', function () {
                                        if (file.sha256 && h.digest('hex') !== file.sha256) {
                                            self._safeUnlink(abs);
                                            reject({ verify: true, message: 'SHA256 校验不符' });
                                        } else {
                                            resolve();
                                        }
                                    });
                                });
                            });
                        }
                    };
                    // 逐块启动下载（全部并发）
                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        if (chunk.downloaded > 0 && chunk.downloaded >= (chunk.end - chunk.start + 1)) {
                            chunksDone++; // 续传时该块已完成
                            continue;
                        }
                        startChunk(chunk, fd);
                    }
                    if (chunksDone >= chunks.length) {
                        // 续传时所有块已完成
                        try { fs.closeSync(fd); } catch (e) { }
                        task._reqs = null;
                        self._safeUnlink(chunksAbs).then(function () {
                            fs.rename(partAbs, abs, function (rnErr) {
                                if (rnErr) { reject({ message: '写入失败：' + rnErr.message }); return; }
                                self._emit(task, file.rel_path, null, true, 'verifying');
                                const h = crypto.createHash('sha256');
                                const rs = fs.createReadStream(abs);
                                rs.on('data', function (c) { h.update(c); });
                                rs.on('error', function () {
                                    self._safeUnlink(abs);
                                    reject({ verify: true, message: '校验读取失败' });
                                });
                                rs.on('end', function () {
                                    if (file.sha256 && h.digest('hex') !== file.sha256) {
                                        self._safeUnlink(abs);
                                        reject({ verify: true, message: 'SHA256 校验不符' });
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        });
                    }
                    function startChunk(chunk, fd) {
                        // 内部 helper：处理重定向（最多 3 跳），最终进入实际下载逻辑
                        const doRequest = function (url, redirects) {
                            if (task.state !== 'downloading') return;
                            if (myGen !== task._reqGen) return;
                            const mod = url.indexOf('https:') === 0 ? https : http;
                            const startByte = chunk.start + chunk.downloaded;
                            const range = 'bytes=' + startByte + '-' + chunk.end;
                            const req = mod.get(url, { headers: { Range: range } }, function (res) {
                                if (task.state !== 'downloading') { try { res.resume(); } catch (e) { } return; }
                                if (myGen !== task._reqGen) { try { res.resume(); } catch (e) { } return; }
                                // 重定向跟随（预签名 URL 跨主机可能 302，最多 3 跳）
                                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                                    res.resume();
                                    try {
                                        const newUrl = new URL(res.headers.location, url).toString();
                                        task._reqs.delete(req);
                                        doRequest(newUrl, redirects + 1);
                                    } catch (e) { failAll({ message: '重定向地址非法' }); }
                                    return;
                                }
                                if (res.statusCode !== 206) {
                                    res.resume();
                                    if (res.statusCode === 416) {
                                        chunk.downloaded = chunk.end - chunk.start + 1;
                                        scheduleFlush();
                                        chunksDone++;
                                        chunkDone();
                                    } else if (res.statusCode === 200 && startByte === chunk.start) {
                                        // 服务端忽略了 Range → 放弃分块，回退单连接
                                        settled = true;
                                        chunksFailed = true;
                                        if (resumeFlushTimer) { clearTimeout(resumeFlushTimer); resumeFlushTimer = null; }
                                        task._reqs.forEach(function (r) { try { r.destroy(); } catch (e) { } });
                                        task._reqs.clear();
                                        try { fs.closeSync(fd); } catch (e) { }
                                        self._safeUnlink(partAbs);
                                        self._safeUnlink(chunksAbs);
                                        goSingle(finalUrl, 0);
                                    } else {
                                        failAll({ message: '服务端返回 ' + res.statusCode });
                                    }
                                    return;
                                }
                                // —— 块级下载循环 ——
                                let position = startByte;
                                let pendingWrites = 0;
                                let httpEnded = false;
                                let chunkPaused = false;
                                const maxPending = 16;
                                const L = self._lim;
                                const gate = {
                                    tryResume: function () {
                                        if (chunkPaused && pendingWrites < maxPending && (!L.down || L.tokens >= 0)) {
                                            chunkPaused = false;
                                            try { res.resume(); } catch (e) { }
                                        }
                                    },
                                    check: function () {
                                        if (L.down > 0 && L.tokens < 0) {
                                            L.waiters.add(this);
                                            if (!chunkPaused) { chunkPaused = true; try { res.pause(); } catch (e) { } }
                                            self._armRefill();
                                        } else if (pendingWrites >= maxPending) {
                                            if (!chunkPaused) { chunkPaused = true; try { res.pause(); } catch (e) { } }
                                        } else {
                                            gate.tryResume();
                                        }
                                    },
                                    flush: function () { this.tryResume(); }
                                };
                                L.waiters.add(gate);
                                res.on('data', function (buf) {
                                    if (task.state !== 'downloading') { try { res.destroy(); } catch (e) { } return; }
                                    if (L.down > 0) L.tokens -= buf.length;
                                    pendingWrites++;
                                    task.received += buf.length;
                                    task.netReceived += buf.length;
                                    chunk.downloaded += buf.length;
                                    self._tick(task);
                                    fs.write(fd, buf, 0, buf.length, position, function (err) {
                                        pendingWrites--;
                                        if (err) {
                                            if (!settled) failAll({ message: '写入失败：' + err.message });
                                            return;
                                        }
                                        task._diskBytes += buf.length;
                                        position += buf.length;
                                        if (pendingWrites < maxPending / 2 && chunkPaused) gate.tryResume();
                                        if (httpEnded && pendingWrites === 0) {
                                            L.waiters.delete(gate);
                                            chunksDone++;
                                            scheduleFlush();
                                            chunkDone();
                                        }
                                    });
                                    gate.check();
                                });
                                res.on('end', function () {
                                    httpEnded = true;
                                    if (pendingWrites === 0 && !settled) {
                                        L.waiters.delete(gate);
                                        chunksDone++;
                                        scheduleFlush();
                                        chunkDone();
                                    }
                                });
                                res.on('error', function (err) {
                                    if (!settled) failAll({ message: '网络错误：' + ((err && err.message) || '连接失败') });
                                });
                                res.on('aborted', function () {
                                    if (!settled) failAll({ message: '连接中断' });
                                });
                                res.resume();
                            });
                            task._reqs.add(req);
                            req.on('error', function (err) {
                                if (!settled) failAll({ message: '网络错误：' + ((err && err.message) || '连接失败') });
                            });
                        };
                        // 启动该块的首次请求
                        doRequest(finalUrl, 0);
                    }
                });
            }

            // —— 单连接断点续传（原有逻辑，被 goChunked 回退/文件太小/无 Range 支持 时调用）——
            function goSingle(finalUrl, base) {
                task._reqs = new Set();
                // base 由 go 内读取 .part 文件大小得出（原逻辑保留）
                if (!base) {
                    try {
                        const st = fs.statSync(partAbs);
                        if (st.isFile()) base = st.size;
                    } catch (e) { /* 无断点文件，从头下载 */ }
                }
                const em = function (m) { return task.direct ? '来源服务器：' + m : m; };
                const attempt = function (u, redirects) {
                    if (task.state !== 'downloading') { reject({ paused: true }); return; }
                    if (myGen !== task._reqGen) { reject({ paused: true }); return; }
                    const mod = u.indexOf('https:') === 0 ? https : http;
                    const opts = { headers: {} };
                    if (base > 0) opts.headers.Range = 'bytes=' + base + '-';
                    const req = mod.get(u, opts, function (res) {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                            res.resume();
                            try { attempt(new URL(res.headers.location, u).toString(), redirects + 1); }
                            catch (e) { reject({ message: '重定向地址非法' }); }
                            return;
                        }
                        if (res.statusCode === 416) {
                            res.resume();
                            self._safeUnlink(partAbs);
                            base = 0;
                            reject({ verify: true, message: '断点越界' });
                            return;
                        }
                        const append = res.statusCode === 206 && base > 0;
                        if (res.statusCode !== 200 && !append) {
                            res.resume();
                            reject({ message: em('服务端返回 ' + res.statusCode) });
                            return;
                        }
                        let written = append ? base : 0;
                        if (!append && base > 0) { task.received -= base; task.netReceived -= base; }
                        const stream = fs.createWriteStream(partAbs, { flags: append ? 'a' : 'w' });
                        let settled = false;
                        const fail = function (err) {
                            if (settled) return;
                            settled = true;
                            self._lim.waiters.delete(gate);
                            try { stream.destroy(); } catch (e) { }
                            task._reqs = null;
                            if (myGen !== task._reqGen) { reject({ paused: true }); return; }
                            if (task.state === 'paused') reject({ paused: true });
                            else reject(err);
                        };
                        const L = self._lim;
                        const gate = {
                            pend: [],
                            paused: false,
                            drainWait: false,
                            pumping: false,
                            ended: false,
                            recv: function (chunk) {
                                if (L.down > 0) L.tokens -= chunk.length;
                                this.pend.push(chunk);
                                if (L.down > 0 && L.tokens < 0) {
                                    L.waiters.add(this);
                                    if (!this.paused) { this.paused = true; try { res.pause(); } catch (e) { } }
                                    self._armRefill();
                                }
                                if (!this.pumping) this.pump();
                            },
                            pump: function () {
                                if (this.pumping) return;
                                this.pumping = true;
                                try {
                                    while (this.pend.length) {
                                        if (this.drainWait) break;
                                        if (L.down > 0 && L.tokens < 0) {
                                            L.waiters.add(this);
                                            if (!this.paused) { this.paused = true; try { res.pause(); } catch (e) { } }
                                            self._armRefill();
                                            break;
                                        }
                                        const c = this.pend.shift();
                                        task._diskBytes += c.length;
                                        if (!stream.write(c)) {
                                            this.drainWait = true;
                                            if (!this.paused) { this.paused = true; try { res.pause(); } catch (e) { } }
                                            const g = this;
                                            stream.once('drain', function () {
                                                g.drainWait = false;
                                                g.pump();
                                            });
                                            break;
                                        }
                                    }
                                } finally { this.pumping = false; }
                                if (!this.pend.length && !this.drainWait) {
                                    if (this.paused) { this.paused = false; try { res.resume(); } catch (e) { } }
                                    if (!this.pend.length) L.waiters.delete(this);
                                    this.settleEnd();
                                }
                            },
                            flush: function () { this.pump(); },
                            settleEnd: function () {
                                if (this.ended && !this.pend.length && !this.drainWait) {
                                    try { stream.end(); } catch (e) { }
                                }
                            }
                        };
                        res.on('data', function (chunk) {
                            task.received += chunk.length;
                            task.netReceived += chunk.length;
                            written += chunk.length;
                            self._tick(task);
                            gate.recv(chunk);
                        });
                        res.on('end', function () { gate.ended = true; gate.settleEnd(); });
                        res.on('error', fail);
                        res.on('aborted', function () { fail({ message: '连接中断' }); });
                        stream.on('error', fail);
                        res.resume();
                        stream.on('finish', function () {
                            if (settled) return;
                            settled = true;
                            try { task._reqs.delete(req); } catch (e) { }
                            task._reqs = null;
                            if (file.size > 0 && written !== file.size) {
                                self._safeUnlink(partAbs);
                                reject({ verify: true, message: '文件大小不符' });
                                return;
                            }
                            fs.rename(partAbs, abs, function (rnErr) {
                                if (rnErr) { reject({ message: '写入失败：' + rnErr.message }); return; }
                                self._emit(task, file.rel_path, null, true, 'verifying');
                                const h = crypto.createHash('sha256');
                                const rs = fs.createReadStream(abs);
                                rs.on('data', function (c) { h.update(c); });
                                rs.on('error', function () {
                                    self._safeUnlink(abs);
                                    reject({ verify: true, message: '校验读取失败' });
                                });
                                rs.on('end', function () {
                                    if (file.sha256 && h.digest('hex') !== file.sha256) {
                                        self._safeUnlink(abs);
                                        reject({ verify: true, message: 'SHA256 校验不符' });
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        });
                    });
                    task._reqs.add(req);
                    req.on('error', function (err) {
                        if (task.state === 'paused') { reject({ paused: true }); return; }
                        reject({ message: em('网络错误：' + ((err && err.message) || '连接失败')) });
                    });
                };
                attempt(finalUrl, 0);
            }
        });
    }

    // 拼完整下载地址：serverBase + file.url + username 参数（url 已是绝对地址/自带查询串时正确拼接）。
    // 直连模式（download_method=3，安全加固）：manifest 的 file.url 必须是商户服务器绝对地址——
    // 原样使用且不追加 username（不向第三方服务器泄露平台账号名；完整性由 SHA256 清单校验兜底）；
    // 直连下相对地址一律返回空（防意外回拼到平台服务器造成口径混乱，由调用方给出明确错误）
    _buildUrl(task, file) {
        let u = String(file.url || '');
        if (!u) return '';
        if (/^https?:\/\//i.test(u)) {
            if (task.direct) return u; // 直连：商户地址原样使用，不带平台账号参数
            // 绝对地址仍统一补 username（服务端下载归口按账号鉴权）
            return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
        }
        if (task.direct) return ''; // 直连拒绝相对地址（服务端 dm=3 必然下发绝对 url，出现即异常）
        const base = String(task.serverBase || '').replace(/\/+$/, '');
        if (!base) return '';
        u = base + (u.indexOf('/') === 0 ? u : '/' + u);
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
    }

    // 重算任务已接收字节基线：已完成文件之和 + 当前文件断点大小
    // 分块断点续传优先读 .part-chunks 状态（避免稀疏文件 stat.size 不准），回退 .part stat.size
    _recalcReceived(task) {
        let sum = 0;
        for (let i = 0; i < task.fileIndex && i < task.files.length; i++) sum += task.files[i].size;
        if (task.fileIndex < task.files.length) {
            const curFile = task.files[task.fileIndex];
            const base = path.resolve(task.stagingDir, curFile.rel_path);
            const chunksPath = base + '.part-chunks';
            const partPath = base + '.part';
            let got = false;
            try {
                if (fs.existsSync(chunksPath)) {
                    const raw = fs.readFileSync(chunksPath, 'utf8');
                    const saved = JSON.parse(raw);
                    if (saved && Array.isArray(saved.chunks)) {
                        for (let c = 0; c < saved.chunks.length; c++) sum += (saved.chunks[c].downloaded || 0);
                        got = true;
                    }
                }
            } catch (e) { /* 状态文件损坏 → 回退 stat.size */ }
            if (!got) {
                try {
                    const st = fs.statSync(partPath);
                    if (st.isFile()) sum += st.size;
                } catch (e) { /* 无断点 */ }
            }
        }
        task.received = sum;
        task._lastBytes = sum;
        task._lastNetBytes = task.netReceived;
        task._lastTime = 0;
        task._lastDiskBytes = task._diskBytes; // 磁盘写入窗口基准同步重置（暂停恢复/重试基线校准）
    }

    // 速度计算 + 进度节流推送（500ms 窗口字节差；数据回调高频触发，窗口内不 emit）
    _tick(task) {
        const now = Date.now();
        if (!task._lastTime) { task._lastTime = now; task._lastBytes = task.received; task._lastNetBytes = task.netReceived; task._lastDiskBytes = task._diskBytes; return; }
        const dt = now - task._lastTime;
        if (dt >= EMIT_INTERVAL) {
            // 速度按实际网络下载字节计算（去重复用文件不产生网络流量，不计入速度）
            task._speed = Math.max(0, Math.round((task.netReceived - (task._lastNetBytes || 0)) / (dt / 1000)));
            task._diskSpeed = Math.max(0, Math.round((task._diskBytes - task._lastDiskBytes) / (dt / 1000))); // 落盘吞吐（写盘字节窗口差）
            task._lastBytes = task.received;
            task._lastNetBytes = task.netReceived;
            task._lastDiskBytes = task._diskBytes;
            task._lastTime = now;
            task._lastEmit = now;
            this.emit('progress', this._evt(task, task._currentRel));
        }
    }

    // 节流进度推送（force=true 终态/状态切换必发；stateOverride 用于 verifying/cancel 覆盖展示态）
    _emit(task, rel, error, force, stateOverride) {
        const now = Date.now();
        if (!force && now - task._lastEmit < EMIT_INTERVAL) return;
        task._lastEmit = now;
        this.emit('progress', this._evt(task, rel, error, stateOverride));
    }

    // 进度事件负载：{taskId, gameId, received, total, speed, diskSpeed, state, fileRelPath, error, phase}
    _evt(task, rel, error, stateOverride) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            received: task.received,        // 总处理字节（下载+去重复用；解压阶段=已解压估算字节）
            netReceived: task.netReceived,  // 实际网络下载字节
            total: task.total,
            speed: task._speed,             // 网络下载速度（基于 netReceived）
            diskSpeed: task._diskSpeed || 0, // 磁盘写入速率（落盘吞吐曲线）
            dedupedCount: task.dedupedCount || 0,
            dedupedBytes: task.dedupedBytes || 0,
            state: stateOverride || task.state,
            fileRelPath: rel || task._currentRel || '',
            phase: task._phase || 'download', // 任务阶段（download=现有默认 extract=ZIP 解压中；页面据此切文案）
            error: error || null
        };
    }

    // 任务完成：全部文件下载且校验通过 →（ZIP 打包版本先走解压阶段）→ 暂存目录一次性换入正式目录
    // （done 必发一条进度；main.js 监听 done 事件探测主程序写注册表）
    _finish(task) {
        const self = this;
        // ZIP 打包版本（packType>0）：全部卷下载校验通过后进入解压阶段（phase='extract'，
        // total 换算为解压后大小，页面状态文案切"解压中"）。解压失败任务置 error——压缩包
        // 保留在暂存目录，重试时下载引擎对已校验卷秒跳，直接重进解压。
        if (task.packType > 0 && !task._extracted) {
            task._phase = 'extract';
            task._currentRel = '';
            task._speed = 0;
            task._diskSpeed = 0;
            if (task.packSize > 0) {
                task.total = task.packSize; // 进度总量换算：解压阶段按解压后字节推进
            }
            task.received = 0;
            task._lastBytes = 0;
            task._lastTime = 0;
            this._emit(task, '', null, true); // 阶段切换必发一条（页面切"解压中"）
            this._extract(task, function (err) {
                if (task.state !== 'downloading') { self._schedule(); return; } // 取消等外部中断：状态已定，不覆盖
                if (err) {
                    task.state = 'error';
                    task._phase = 'download';
                    task._speed = 0;
                    task._diskSpeed = 0;
                    task.total = self._calcTotal(task.files); // 重试重下口径复位（总量还原为压缩包大小）
                    self._emit(task, '', (err && err.message) || '解压失败', true); // error 必发
                    self._schedule();
                    return;
                }
                task._extracted = true;
                task._phase = 'download';
                self._finishCommit(task);
            });
            return;
        }
        this._finishCommit(task);
    }

    // 解压后提交：原 _finish 的完成路径（rename 换入正式目录 + done 事件）
    _finishCommit(task) {
        task.state = 'done';
        task.received = task.total;
        task._speed = 0;
        task._diskSpeed = 0;
        task._lastEmit = Date.now();
        const cm = this._commit(task);
        if (cm && cm.ok === false) {
            task.state = 'error'; // 换入失败（暂存保留，可重试下载恢复）
            task._speed = 0;
            this._emit(task, '', cm.message || '安装目录换入失败', true);
            this._schedule();
            return;
        }
        this.emit('progress', this._evt(task, ''));
        this.emit('done', { taskId: task.taskId, gameId: task.gameId, installDir: task.installDir, username: task.username });
        this._schedule(); // 释放并行槽位，调度排队任务
    }

    // —— ZIP 打包版本解压阶段（packType=1 单 ZIP / 2 分卷 ZIP，内置 7z 通吃）——

    // 7z 组件路径（与 dlbt-host 同构：打包态 resources/7z/，开发态 __dirname/7z/）
    _7zPath() {
        if (app && app.isPackaged) {
            return path.join(process.resourcesPath, '7z', '7z.exe');
        }
        return path.join(__dirname, '7z', '7z.exe');
    }

    // 解压前置：清残留 → 磁盘余量预检 → Zip Slip 条目预检 → spawn 7z x（stdout 百分比 → 解压进度）
    _extract(task, cb) {
        const self = this;
        const exe = this._7zPath();
        if (!fs.existsSync(exe)) { cb(new Error('解压组件缺失（7z.exe），请重新安装客户端')); return; }
        const staging = task.stagingDir;
        const keepMap = {};
        task.files.forEach(function (f) {
            keepMap[path.resolve(staging, f.rel_path).toLowerCase()] = true; // 分卷本体保留（重试免重下）
        });
        // 1) 清残留：上次解压中断可能留下半解压文件，全部清除防脏数据混入正式目录（保留压缩包本体）
        try {
            self._cleanStagingExcept(staging, keepMap);
        } catch (e) { /* 清理失败不阻断：7z -y 覆盖写 + _commit 全量换入兜底 */ }
        // 2) 磁盘余量预检（statfs 不可用/未知大小则跳过，由 7z 写盘失败兜底）
        if (task.packSize > 0) {
            try {
                const st = fs.statfsSync(staging);
                const free = Number(st.bavail) * Number(st.bsize);
                if (free > 0 && free < task.packSize) {
                    cb(new Error('磁盘空间不足：解压需约 ' + Math.ceil(task.packSize / 1073741824) +
                        'GB，当前剩余 ' + Math.floor(free / 1073741824) + 'GB（已下载的压缩包已保留）'));
                    return;
                }
            } catch (e) { /* 预检不可用：跳过 */ }
        }
        // 3) Zip Slip 预检：7z 列表逐条目校验路径（绝对路径/盘符/UNC/父目录引用一律拒绝），
        //    恶意包在写盘前拦截（服务端登记时同规则已拦一道，双保险）
        const firstVol = path.resolve(staging, task.files[0].rel_path);
        this._7zEntryCheck(exe, firstVol, staging, function (slipErr) {
            if (slipErr) { cb(slipErr); return; }
            // 4) 解压：单 ZIP 直接 x；分卷给首卷 7z 自动发现同前缀 .zip.001…（.z01 旧式同样支持）
            let child;
            try {
                child = spawn(exe, ['x', '-y', '-bso0', '-bsp1', '-o' + staging, firstVol], {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (e) { cb(new Error('解压进程启动失败：' + e.message)); return; }
            task._extractProc = child;
            let buf = '';
            child.stdout.on('data', function (chunk) {
                buf += chunk.toString('utf8');
                // -bsp1 进度行形如 " 42% 128 - file"，取行内最大百分数换算解压字节
                const ms = buf.match(/(\d{1,3})%/g);
                if (ms && ms.length) {
                    let pct = 0;
                    for (let i = 0; i < ms.length; i++) pct = Math.max(pct, parseInt(ms[i], 10) || 0);
                    if (pct > 100) pct = 100;
                    if (task.packSize > 0) task.received = Math.round(task.packSize * pct / 100);
                    else task.received = pct;
                    self._tick(task);
                }
                if (buf.length > 4096) buf = buf.slice(-1024); // 环形截断防长文件名堆积
            });
            child.stderr.on('data', function () { /* 7z 告警走 stderr，退出码裁决 */ });
            child.on('error', function (err2) {
                if (task._extractProc === child) task._extractProc = null;
                cb(new Error('解压进程异常：' + err2.message));
            });
            child.on('exit', function (code) {
                if (task._extractProc === child) task._extractProc = null;
                if (task.state !== 'downloading') { cb(null); return; } // 取消中断：外层按状态收口
                if (code !== 0) {
                    const why = code === null ? '进程被终止' : ('7z 退出码 ' + code);
                    cb(new Error('压缩包解压失败（' + why + '，包可能损坏或密码保护）'));
                    return;
                }
                task.received = task.total; // 解压完成：进度拉满
                // 5) 清压缩包本体释放空间（失败忽略——_commit rename 不受影响，仅暂存多占盘）
                const dels = task.files.map(function (f) {
                    return self._safeUnlink(path.resolve(staging, f.rel_path));
                });
                Promise.all(dels).then(function () { cb(null); }, function () { cb(null); });
            });
        });
    }

    // 7z 条目路径安检：l -slt -ba 列表解析 "Path = " 行，逐条校验不逃逸暂存目录
    _7zEntryCheck(exe, vol, stagingDir, cb) {
        let child;
        try {
            child = spawn(exe, ['l', '-slt', '-ba', vol], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) { cb(new Error('解压组件异常：' + e.message)); return; }
        let out = '';
        let settled = false;
        child.stdout.on('data', function (c) { out += c.toString('utf8'); });
        child.on('error', function (e) {
            if (settled) return;
            settled = true;
            cb(new Error('解压组件异常：' + e.message));
        });
        child.on('exit', function (code) {
            if (settled) return;
            settled = true;
            if (code !== 0) { cb(new Error('压缩包无法识别（7z 退出码 ' + code + '，包可能损坏）')); return; }
            const root = path.resolve(stagingDir);
            const lines = out.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const m = /^Path = (.+)$/.exec(lines[i]);
                if (!m) continue;
                const name = m[1].trim();
                // 与服务端 zipEntryUnsafe 同规则：绝对路径/盘符/UNC/.. 段一律拒绝
                const norm = name.replace(/\\/g, '/');
                let bad = norm.charAt(0) === '/' || norm.indexOf(':') >= 0;
                if (!bad) {
                    const segs = norm.split('/');
                    for (let s = 0; s < segs.length; s++) {
                        if (segs[s] === '..') { bad = true; break; }
                    }
                }
                if (!bad) {
                    // 兜底：解析后必须仍位于暂存目录内（防符号链接等绕过）
                    try {
                        const abs = path.resolve(stagingDir, name);
                        if (abs !== root && abs.indexOf(root + path.sep) !== 0) bad = true;
                    } catch (e) { bad = true; }
                }
                if (bad) { cb(new Error('压缩包内含非法路径条目：' + name)); return; }
            }
            cb(null);
        });
    }

    // 清空暂存目录但保留 keepMap 内的路径（分卷本体）：目录树后序删除
    _cleanStagingExcept(dir, keepMap) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (let i = 0; i < entries.length; i++) {
            const full = path.join(dir, entries[i].name);
            if (keepMap[full.toLowerCase()]) continue;
            if (entries[i].isDirectory()) {
                this._cleanStagingExcept(full, keepMap);
                try { fs.rmdirSync(full); } catch (e) { /* 非空（保留文件所在目录）忽略 */ }
            } else {
                try { fs.unlinkSync(full); } catch (e) { /* 占用忽略 */ }
            }
        }
    }

    // 暂存目录 → 正式目录同盘一次性换入（Steam 同款）：旧版本先挪 .old-<ts> 腾位，rename 失败回滚；
    // 换入成功异步删除旧版本备份（大目录递归删除不阻塞主进程，残留可后续清理）；返回 {ok} 或 {ok:false,message}
    _commit(task) {
        const finalDir = task.installDir;
        const stagingDir = task.stagingDir;
        const root = task.root;
        if (!stagingDir || !fs.existsSync(stagingDir)) return { ok: true }; // 无暂存内容（全部秒跳）：正式目录已就绪
        // 安全校验（致命防呆）：finalDir 必须是 root 的子目录且末级目录名等于 slug。
        // 历史 bug：库记录 install_path 误存安装根（H:\CdonlgameApp）被当作 finalDir 直传，
        // 导致 renameSync 把整个安装根挪走、所有游戏丢失。此处若校验失败直接拒绝。
        try {
            const fNorm = path.resolve(finalDir);
            const rNorm = path.resolve(root);
            const rel = path.relative(rNorm, fNorm);
            const leaf = path.basename(fNorm);
            const slug = String(task.slug || '');
            // slug 必须非空（start 已校验），为空说明 task 元数据异常，宁拒勿放行
            if (!slug || fNorm === rNorm || rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ||
                leaf.toLowerCase() !== slug.toLowerCase()) {
                return { ok: false, message: '安装目录参数异常：finalDir 不是安装根的子目录或与 slug 不匹配，已拒绝执行以防数据丢失' };
            }
        } catch (e) {
            return { ok: false, message: '安装目录校验失败：' + e.message };
        }
        let bak = '';
        try {
            if (fs.existsSync(finalDir)) {
                bak = finalDir + '.old-' + Date.now();
                fs.renameSync(finalDir, bak); // 同盘 rename，O(1)
            }
        } catch (e) {
            return { ok: false, message: '旧版本目录腾位失败：' + e.message };
        }
        try {
            fs.renameSync(stagingDir, finalDir);
        } catch (e) {
            if (bak) { try { fs.renameSync(bak, finalDir); } catch (e2) { /* 回滚失败：备份仍在，交用户手动处理 */ } }
            return { ok: false, message: '安装目录换入失败：' + e.message };
        }
        if (bak) fs.rm(bak, { recursive: true, force: true }, function () { /* 备份清理失败忽略（残留 .old-*） */ });
        this._pruneStagingParent(stagingDir);
        return { ok: true };
    }

    // 清理空的暂存父目录 <root>/downloading（非空/不存在/失败一律忽略）
    _pruneStagingParent(stagingDir) {
        try {
            const parent = path.dirname(stagingDir);
            if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
        } catch (e) { /* 目录非空或不存在，忽略 */ }
    }

    // 任务摘要（对外返回/status 数组条目）。installDir 报游戏根（与 BT 通道/done 事件同口径），
    // 页面持久化 install_path 即此值；root 仅作为内部安装根（暂存目录父级）不对外暴露
    _summary(task) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            installDir: task.installDir,
            username: task.username,
            state: task.state,
            received: task.received,
            netReceived: task.netReceived || 0,
            total: task.total,
            fileIndex: task.fileIndex,
            filesCount: task.files.length,
            speed: task._speed,
            diskSpeed: task._diskSpeed || 0,
            dedupedCount: task.dedupedCount || 0,
            dedupedBytes: task.dedupedBytes || 0,
            startedAt: task.startedAt,
            phase: task._phase || 'download', // 任务阶段（ZIP 打包版本解压中为 extract）
            via: 'http' // 通道标识（与 BT 摘要同口径；页面去重采纳/徽标展示按此区分）
        };
    }

    _calcTotal(files) {
        let t = 0;
        for (let i = 0; i < files.length; i++) t += Number(files[i].size) || 0;
        return t;
    }

    // 静默删除（文件不存在/占用等一律忽略，返回 Promise 便于串行收口）
    _safeUnlink(p) {
        return new Promise(function (res) {
            fs.unlink(p, function () { res(); });
        });
    }
}

module.exports = GameDownloadManager; // 由 main.js 实例化（var gameDownloads = new GameDownloadManager()）
