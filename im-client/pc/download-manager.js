// ===== 阶段二百八十一：游戏中心下载管理器（Steam 同款游戏浏览/下载 P1 主进程部分） =====
// 职责归口：游戏文件多任务下载（同任务串行逐文件、跨任务并行上限 2 超出排队）、
//           断点续传（.part + Range 请求，服务端 200 时重头写）、SHA256/大小双校验（失败删文件重试 ≤2 次）、
//           暂停/恢复/取消（cancel 清 .part 与未完成文件，已完整落盘且校验过的正式文件保留）、
//           进度事件 500ms 节流（state:'done' 完成必发一条，error 亦必发）。
// 由 main.js 实例化并监听 progress/done：progress 转发全部窗口；done 探测安装目录唯一 .exe 写启动注册表。
// 任务不持久化：进程退出任务丢失可接受（页面按库状态重新 start，磁盘 .part 断点自动续传）。
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PARALLEL = 2;    // 跨任务并行下载上限，超出排队
const EMIT_INTERVAL = 500; // 进度节流窗口（ms），同时作为速度计算窗口
const MAX_FILE_RETRY = 2;  // 单文件校验失败重试上限（仍失败任务置 error）

class GameDownloadManager extends EventEmitter {
    constructor() {
        super();
        this.tasks = new Map(); // taskId → 任务对象（进程内表，不持久化）
    }

    // 注册并开始任务。payload={taskId, gameId, installDir, username, serverBase, files:[{id,rel_path,size,sha256,url}]}
    // 同 taskId 重复 start 幂等返回进行中状态；error/done 旧任务重置重下（磁盘 .part 保留即断点续传）
    start(payload) {
        const taskId = String((payload && payload.taskId) || '').trim();
        const files = (payload && Array.isArray(payload.files)) ? payload.files : null;
        if (!taskId || !files || !files.length || !(payload && payload.installDir)) return { ok: false, error: '参数缺失' };
        const exist = this.tasks.get(taskId);
        if (exist && exist.state !== 'error' && exist.state !== 'done') {
            return { ok: true, task: this._summary(exist) }; // 进行中（排队/下载/暂停）：幂等
        }
        // 防目录穿越：rel_path 解析后必须位于 installDir 内，越界条目丢弃
        const root = path.resolve(String(payload.installDir));
        const list = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i] || {};
            const rel = String(f.rel_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel) continue;
            const abs = path.resolve(root, rel);
            if (abs !== root && !abs.startsWith(root + path.sep)) continue;
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
            task.installDir = root;
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
                installDir: root,
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
            return self._safeUnlink(path.resolve(task.installDir, f.rel_path) + '.part');
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
        return new Promise(function (resolve, reject) {
            const abs = path.resolve(task.installDir, file.rel_path);
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
                            try { stream.destroy(); } catch (e) { }
                            if (task.state === 'paused') reject({ paused: true });
                            else reject(err);
                        };
                        res.on('data', function (chunk) {
                            task.received += chunk.length;
                            written += chunk.length;
                            hash.update(chunk);
                            self._tick(task); // 速度计算 + 500ms 节流推送
                        });
                        res.on('error', fail);
                        res.on('aborted', function () { fail({ message: '连接中断' }); });
                        stream.on('error', fail);
                        res.pipe(stream);
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
                const st = fs.statSync(path.resolve(task.installDir, task.files[task.fileIndex].rel_path) + '.part');
                if (st.isFile()) sum += st.size;
            } catch (e) { /* 无断点 */ }
        }
        task.received = sum;
        task._lastBytes = sum;
        task._lastTime = 0;
    }

    // 速度计算 + 进度节流推送（500ms 窗口字节差；数据回调高频触发，窗口内不 emit）
    _tick(task) {
        const now = Date.now();
        if (!task._lastTime) { task._lastTime = now; task._lastBytes = task.received; return; }
        const dt = now - task._lastTime;
        if (dt >= EMIT_INTERVAL) {
            task._speed = Math.max(0, Math.round((task.received - task._lastBytes) / (dt / 1000)));
            task._lastBytes = task.received;
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

    // 进度事件负载：{taskId, gameId, received, total, speed, state, fileRelPath, error}
    _evt(task, rel, error, stateOverride) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            received: task.received,
            total: task.total,
            speed: task._speed,
            state: stateOverride || task.state,
            fileRelPath: rel || task._currentRel || '',
            error: error || null
        };
    }

    // 任务完成：全部文件下载且校验通过（done 必发一条进度；main.js 监听 done 事件探测主程序写注册表）
    _finish(task) {
        task.state = 'done';
        task.received = task.total;
        task._speed = 0;
        task._lastEmit = Date.now();
        this.emit('progress', this._evt(task, ''));
        this.emit('done', { taskId: task.taskId, gameId: task.gameId, installDir: task.installDir, username: task.username });
        this._schedule(); // 释放并行槽位，调度排队任务
    }

    // 任务摘要（对外返回/status 数组条目）
    _summary(task) {
        return {
            taskId: task.taskId,
            gameId: task.gameId,
            installDir: task.installDir,
            username: task.username,
            state: task.state,
            received: task.received,
            total: task.total,
            fileIndex: task.fileIndex,
            filesCount: task.files.length,
            speed: task._speed,
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
