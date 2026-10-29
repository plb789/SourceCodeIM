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

const MAX_PARALLEL = 2;    // 跨任务并行下载上限，超出排队
const EMIT_INTERVAL = 500; // 进度节流窗口（ms），同时作为速度计算窗口
const MAX_FILE_RETRY = 2;  // 单文件校验失败重试上限（仍失败任务置 error）
const STAGING_DIRNAME = 'downloading'; // 同盘暂存目录名（正式目录 <root>/<slug>，暂存 <root>/downloading/<slug>）

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
        // 防目录穿越：rel_path 解析后必须位于暂存目录内，越界条目丢弃
        const list = [];
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
            task.root = root; // 安装根（对外摘要/库 install_path 口径，恢复/更新复用即此）
            task.username = String(payload.username || '');
            task.serverBase = String(payload.serverBase || '');
            task.files = list;
            task.total = this._calcTotal(list);
            task.fileIndex = 0;
            task.retries = 0;
            task.received = 0;
            task._speed = 0;
            task._currentRel = '';
        } else {
            task = {
                taskId: taskId,
                gameId: String(payload.gameId || ''),
                installDir: finalDir,   // 正式目录（done 事件对外即此，供主进程探测 .exe 登记启动）
                stagingDir: stagingDir, // 暂存目录（下载全程落此，完成后换入 installDir）
                root: root,             // 安装根（摘要 installDir 口径 / 库 install_path，恢复/更新复用即此）
                username: String(payload.username || ''),
                serverBase: String(payload.serverBase || ''),
                files: list,
                state: 'queued',
                received: 0,
                total: this._calcTotal(list),
                fileIndex: 0,
                startedAt: 0,
                retries: 0,
                _req: null,        // 进行中的 http 请求（暂停/取消中断用）
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
        if (task.state === 'downloading' || task.state === 'queued') {
            task._paused = true;
            task.state = 'paused';
            task._speed = 0;
            task._diskSpeed = 0;
            if (task._req) { try { task._req.destroy(); } catch (e) { } }
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
        if (task._req) { try { task._req.destroy(); } catch (e) { } }
        const self = this;
        const pend = task.files.map(function (f) {
            return self._safeUnlink(path.resolve(task.stagingDir, f.rel_path) + '.part');
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

    // 下载单个文件：.part 断点续传（Range）→ rename 正式名 → 大小/SHA256 流式校验。
    // reject 载荷：{paused:true} 暂停中断 / {verify:true} 校验类失败（可重试）/ {message} 其它错误
    _downloadFile(task, file) {
        const self = this;
        // 请求代数在入口同步递增（mkdir 回调是异步跳板，代数必须先于任何异步事件落定）：
        // 暂停后快速恢复时，旧请求的中止回调晚于新请求发起到达，gen 不符即整体忽略，防误判新下载失败
        const myGen = task._reqGen = (task._reqGen || 0) + 1;
        return new Promise(function (resolve, reject) {
            const abs = path.resolve(task.stagingDir, file.rel_path);
            const partAbs = abs + '.part';
            // 上次会话已完整落盘且校验过的文件（rename 前提即校验通过）直接跳过，秒级恢复
            try {
                const st0 = fs.statSync(abs);
                if (st0.isFile() && file.size > 0 && st0.size === file.size) { resolve(); return; }
            } catch (e) { /* 正式文件不存在，正常下载 */ }
            fs.mkdir(path.dirname(abs), { recursive: true }, function (mkErr) {
                if (mkErr) { reject({ message: '创建目录失败：' + mkErr.message }); return; }
                let base = 0;
                try {
                    const st = fs.statSync(partAbs);
                    if (st.isFile()) base = st.size;
                } catch (e) { /* 无断点文件，从头下载 */ }
                const url = self._buildUrl(task, file);
                if (!url) { reject({ message: '文件下载地址缺失' }); return; }
                const attempt = function (u, redirects) {
                    if (task.state !== 'downloading') { reject({ paused: true }); return; }
                    // 按协议选模块（服务端可能 http/https 任一）
                    const mod = u.indexOf('https:') === 0 ? https : http;
                    const opts = { headers: {} };
                    if (base > 0) opts.headers.Range = 'bytes=' + base + '-';
                    const req = mod.get(u, opts, function (res) {
                        // 重定向跟随（服务端/对象存储预签名地址可能 302，最多 3 跳）
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                            res.resume();
                            try { attempt(new URL(res.headers.location, u).toString(), redirects + 1); }
                            catch (e) { reject({ message: '重定向地址非法' }); }
                            return;
                        }
                        // 416 断点越界（.part 异常大于服务端文件等）：删 .part 走校验重试链路
                        if (res.statusCode === 416) {
                            res.resume();
                            self._safeUnlink(partAbs);
                            base = 0;
                            reject({ verify: true, message: '断点越界' });
                            return;
                        }
                        const append = res.statusCode === 206 && base > 0; // 206：断点续传追加
                        if (res.statusCode !== 200 && !append) {
                            res.resume();
                            reject({ message: '服务端返回 ' + res.statusCode });
                            return;
                        }
                        let written = append ? base : 0; // 最终文件字节数（含断点已有部分）
                        if (!append && base > 0) task.received -= base; // 200 重头写：扣除旧断点计数
                        const hash = crypto.createHash('sha256'); // 本次会话接收字节哈希（无断点时即全量）
                        const stream = fs.createWriteStream(partAbs, { flags: append ? 'a' : 'w' });
                        let settled = false;
                        const fail = function (err) {
                            if (settled) return;
                            settled = true;
                            self._lim.waiters.delete(gate); // 中断路径清理等待资格（end/close 不清：pend 可能仍有未写盘数据）
                            try { stream.destroy(); } catch (e) { }
                            if (myGen !== task._reqGen) { reject({ paused: true }); return; } // 过期请求回调：已被新请求取代，交由调度处理
                            if (task.state === 'paused') reject({ paused: true });
                            else reject(err);
                        };
                        // 请求级写入门控（限速 + 写盘背压统一走挂起队列）：原 res.pipe 会在写盘 drain 时
                        // 自动 resume 源流覆盖限速 pause（E2E 实测失效根因），故改为手动写盘。recv 收
                        // chunk 按令牌扣减入队，pump 按"令牌充足 + 写盘可写"节奏落盘；源流由 pause/resume 控制
                        const L = self._lim;
                        const gate = {
                            pend: [],        // 待写盘数据（限速挂起/背压回退，内存排队量级≈1 秒配额+往返缓冲）
                            paused: false,   // 源流暂停中（令牌不足）
                            drainWait: false,// 写盘背压等待中（write 返回 false）
                            pumping: false,  // pump 重入保护
                            ended: false,    // 源已结束（挂起数据写完后手动 end 流）
                            recv: function (chunk) {
                                if (L.down > 0) L.tokens -= chunk.length; // 令牌预扣（挂起数据已计费，放行不再扣）
                                this.pend.push(chunk);
                                // 令牌不足：先完成挂起登记（入等待集 + 暂停源流 + 武装补充定时器）再尝试写盘。
                                // 登记必须在 recv 内完成——pump 尾部 res.resume() 会同步触发 data 递归进 recv，
                                // 此时 pump 被 pumping 守卫挡掉，登记若依赖 pump 会丢失导致末尾 chunk 永久滞留（E2E 实测死锁根因）
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
                                        if (this.drainWait) break;                     // 写盘背压：等 drain
                                        if (L.down > 0 && L.tokens < 0) {              // 令牌不足：等补充定时器唤醒
                                            L.waiters.add(this);
                                            if (!this.paused) { this.paused = true; try { res.pause(); } catch (e) { } }
                                            self._armRefill();
                                            break;
                                        }
                                        const c = this.pend.shift();
                                        task._diskBytes += c.length; // 磁盘写入字节采集（落盘吞吐曲线数据源）
                                        if (!stream.write(c)) {                        // 写盘背压：剩余留队
                                            this.drainWait = true;
                                            // 背压时同步暂停源流（对齐原 pipe 自动背压行为）：不限速模式下若
                                            // 网络快于磁盘且不暂停，pend 会无界增长；drain 后由 pump 续写并放行
                                            if (!this.paused) { this.paused = true; try { res.pause(); } catch (e) { } }
                                            const g = this;
                                            stream.once('drain', function () {
                                                g.drainWait = false; // drain 回调先复位标志再续 pump（否则 pump 首行判 drainWait 死锁）
                                                g.pump();
                                            });
                                            break;
                                        }
                                    }
                                } finally { this.pumping = false; }
                                if (!this.pend.length && !this.drainWait) {
                                    if (this.paused) { this.paused = false; try { res.resume(); } catch (e) { } }
                                    // 仅在确认无挂起时才移除等待资格：resume 会同步触发 data 递归，recv 可能
                                    // 刚重新入队挂起并登记等待（此时不能删，否则补充定时器不再唤醒它——死锁）
                                    if (!this.pend.length) L.waiters.delete(this);
                                    this.settleEnd();
                                }
                            },
                            flush: function () { this.pump(); }, // setLimits(0)/补充定时器唤醒入口
                            settleEnd: function () {
                                if (this.ended && !this.pend.length && !this.drainWait) {
                                    try { stream.end(); } catch (e) { }
                                }
                            }
                        };
                        res.on('data', function (chunk) {
                            task.received += chunk.length;
                            written += chunk.length;
                            hash.update(chunk);
                            self._tick(task); // 速度计算 + 500ms 节流推送
                            gate.recv(chunk); // 限速/写盘门控：令牌不足挂起队列（不 pipe，防 drain 自动 resume）
                        });
                        // end/close 不移除等待资格：数据虽已全部送达（end 触发），pend 队列可能仍压着
                        // 未写盘数据，删除会让补充定时器不再唤醒该门控（E2E 实测收尾死锁根因）；
                        // 正常收尾由 pump 写空 pend 后自行移除并 end 流，错误路径由 fail 统一清理
                        res.on('end', function () { gate.ended = true; gate.settleEnd(); });
                        res.on('error', fail);
                        res.on('aborted', function () { fail({ message: '连接中断' }); });
                        stream.on('error', fail);
                        res.resume(); // 手动写盘模式（无 pipe）：data 监听已置 flowing，显式 resume 对齐语义
                        stream.on('finish', function () {
                            if (settled) return;
                            settled = true;
                            task._req = null;
                            // 大小校验：下载字节数须等于 file.size（元数据缺 size 时跳过该项）
                            if (file.size > 0 && written !== file.size) {
                                self._safeUnlink(partAbs);
                                reject({ verify: true, message: '文件大小不符' });
                                return;
                            }
                            // rename .part → 正式名，随后对正式文件整体流式 SHA256 校验
                            fs.rename(partAbs, abs, function (rnErr) {
                                if (rnErr) { reject({ message: '写入失败：' + rnErr.message }); return; }
                                self._emit(task, file.rel_path, null, true, 'verifying'); // 校验中状态（大文件读盘有耗时）
                                const h = crypto.createHash('sha256');
                                const rs = fs.createReadStream(abs);
                                rs.on('data', function (c) { h.update(c); });
                                rs.on('error', function () {
                                    self._safeUnlink(abs);
                                    reject({ verify: true, message: '校验读取失败' });
                                });
                                rs.on('end', function () {
                                    if (file.sha256 && h.digest('hex') !== file.sha256) {
                                        self._safeUnlink(abs); // 哈希不符：删坏文件交上层重试
                                        reject({ verify: true, message: 'SHA256 校验不符' });
                                    } else {
                                        resolve();
                                    }
                                });
                            });
                        });
                    });
                    task._req = req;
                    req.on('error', function (err) {
                        if (task.state === 'paused') { reject({ paused: true }); return; }
                        reject({ message: '网络错误：' + ((err && err.message) || '连接失败') });
                    });
                };
                attempt(url, 0);
            });
        });
    }

    // 拼完整下载地址：serverBase + file.url + username 参数（url 已是绝对地址/自带查询串时正确拼接）
    _buildUrl(task, file) {
        let u = String(file.url || '');
        if (!u) return '';
        if (/^https?:\/\//i.test(u)) {
            // 绝对地址仍统一补 username（服务端下载归口按账号鉴权）
            return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
        }
        const base = String(task.serverBase || '').replace(/\/+$/, '');
        if (!base) return '';
        u = base + (u.indexOf('/') === 0 ? u : '/' + u);
        return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(task.username || '');
    }

    // 重算任务已接收字节基线：已完成文件之和 + 当前文件断点 .part 大小
    _recalcReceived(task) {
        let sum = 0;
        for (let i = 0; i < task.fileIndex && i < task.files.length; i++) sum += task.files[i].size;
        if (task.fileIndex < task.files.length) {
            try {
                const st = fs.statSync(path.resolve(task.stagingDir, task.files[task.fileIndex].rel_path) + '.part');
                if (st.isFile()) sum += st.size;
            } catch (e) { /* 无断点 */ }
        }
        task.received = sum;
        task._lastBytes = sum;
        task._lastTime = 0;
        task._lastDiskBytes = task._diskBytes; // 磁盘写入窗口基准同步重置（暂停恢复/重试基线校准）
    }

    // 速度计算 + 进度节流推送（500ms 窗口字节差；数据回调高频触发，窗口内不 emit）
    _tick(task) {
        const now = Date.now();
        if (!task._lastTime) { task._lastTime = now; task._lastBytes = task.received; task._lastDiskBytes = task._diskBytes; return; }
        const dt = now - task._lastTime;
        if (dt >= EMIT_INTERVAL) {
            task._speed = Math.max(0, Math.round((task.received - task._lastBytes) / (dt / 1000)));
            task._diskSpeed = Math.max(0, Math.round((task._diskBytes - task._lastDiskBytes) / (dt / 1000))); // 落盘吞吐（写盘字节窗口差）
            task._lastBytes = task.received;
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

    // 进度事件负载：{taskId, gameId, received, total, speed, diskSpeed, state, fileRelPath, error}
    _evt(task, rel, error, stateOverride) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            received: task.received,
            total: task.total,
            speed: task._speed,
            diskSpeed: task._diskSpeed || 0, // 磁盘写入速率（落盘吞吐曲线）
            state: stateOverride || task.state,
            fileRelPath: rel || task._currentRel || '',
            error: error || null
        };
    }

    // 任务完成：全部文件下载且校验通过 → 暂存目录一次性换入正式目录（done 必发一条进度；
    // main.js 监听 done 事件探测主程序写注册表）
    _finish(task) {
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

    // 暂存目录 → 正式目录同盘一次性换入（Steam 同款）：旧版本先挪 .old-<ts> 腾位，rename 失败回滚；
    // 换入成功异步删除旧版本备份（大目录递归删除不阻塞主进程，残留可后续清理）；返回 {ok} 或 {ok:false,message}
    _commit(task) {
        const finalDir = task.installDir;
        const stagingDir = task.stagingDir;
        if (!stagingDir || !fs.existsSync(stagingDir)) return { ok: true }; // 无暂存内容（全部秒跳）：正式目录已就绪
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

    // 任务摘要（对外返回/status 数组条目）。installDir 报安装根（页面持久化 install_path 复用，
    // 与 BT 通道 installDir 口径差异由页面归一到根），实际落盘由 done 事件 installDir 承载
    _summary(task) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            installDir: task.root || task.installDir,
            username: task.username,
            state: task.state,
            received: task.received,
            total: task.total,
            fileIndex: task.fileIndex,
            filesCount: task.files.length,
            speed: task._speed,
            diskSpeed: task._diskSpeed || 0,
            startedAt: task.startedAt
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
