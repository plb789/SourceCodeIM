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
const os = require('os'); // pending-updates.json 非 Electron 环境 fallback 路径
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
        // pending-updates.json 内存缓存（构造时懒加载，增删改同步落盘）
        // 用内存缓存彻底消除 readFileSync → 修改 → writeFileSync 的多步竞态：
        // 两次独立的 _pendingAdd 调用如果中间没有让出控制权（Node.js 单线程），内存数组是同一个引用，
        // 直接 push + 单次 writeFileSync，不会出现 "A 写了 B 的旧版本被 B 覆盖" 的丢失更新。
        // 即使未来有人把 _pendingAdd 放到 async 回调里也安全——内存数组是原子的，落盘用 writeFileSync 串行。
        this._pendingCache = null;
    }

    // ===== 待提交更新持久化（pending-updates.json） =====
    // 场景：下载完成但旧游戏目录被运行中进程占用无法 commit → 暂存目录保留，
    //       写入 pending-updates.json，下次 IM 启动时（无游戏运行）自动 commit。
    //       解决 Windows 上 rename 被占用的 OS 级限制。

    // pending-updates.json 路径：app userData 目录下（非 Electron 环境 fallback 到系统 tmpdir，方便单元测试）
    _pendingFilePath() {
        try {
            if (app && typeof app.getPath === 'function') {
                return path.join(app.getPath('userData'), 'pending-updates.json');
            }
        } catch (e) { /* app 未 ready 或非 Electron 环境，走 fallback */ }
        try {
            return path.join(os.tmpdir(), 'im-pending-updates.json');
        } catch (e2) { return null; }
    }

    // 读取待提交列表（内存缓存优先，首次调用或缓存被 _pendingSave 清空后从磁盘懒加载）
    _pendingLoad() {
        if (this._pendingCache !== null) return this._pendingCache;
        const p = this._pendingFilePath();
        if (!p || !fs.existsSync(p)) { this._pendingCache = []; return this._pendingCache; }
        try {
            const raw = fs.readFileSync(p, 'utf8');
            const arr = JSON.parse(raw);
            this._pendingCache = Array.isArray(arr) ? arr : [];
        } catch (e) {
            // 文件损坏，清掉——宁丢勿误提交
            try { fs.unlinkSync(p); } catch (e2) { }
            this._pendingCache = [];
        }
        return this._pendingCache;
    }

    // 保存并更新缓存（所有写操作的唯一出口——内存修改后一次性 writeFileSync）
    _pendingSave(list) {
        this._pendingCache = list;
        const p = this._pendingFilePath();
        if (!p) return;
        try {
            fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf8');
        } catch (e) {
            console.error('[download-manager] pending-updates.json 写入失败:', e && e.message);
        }
    }

    // 添加一条待提交（按 gameId 去重，同游戏只保留最新）
    _pendingAdd(entry) {
        const list = this._pendingLoad();
        const filtered = list.filter(function (x) { return x.gameId !== entry.gameId; });
        filtered.push(entry);
        this._pendingSave(filtered);
    }

    // 移除已提交的 gameId
    _pendingRemove(gameId) {
        const list = this._pendingLoad();
        const filtered = list.filter(function (x) { return x.gameId !== gameId; });
        this._pendingSave(filtered);
    }

    // 公开方法：启动时自动 commit 所有待提交更新（main.js 在 createWindow 前调用）
    // 文件级 replace（复用 Steam 同款逻辑），IM 刚启动时没有游戏在运行，锁定文件应该能全部替换
    // 返回 {ok:number, failed:number, pendingLocked:number, failedDetails:[{gameId, error}]}
    _pendingCommitAll() {
        const self = this;
        const list = this._pendingLoad();
        if (!list.length) return { ok: 0, failed: 0, pendingLocked: 0, failedDetails: [] };
        const result = { ok: 0, failed: 0, pendingLocked: 0, failedDetails: [] };
        const remaining = []; // 本次仍有 locked 文件 → 留在 pending 里，下次启动再试
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            // 校验暂存目录还在
            if (!e.stagingDir || !fs.existsSync(e.stagingDir)) {
                result.failed++;
                result.failedDetails.push({ gameId: e.gameId, error: '暂存目录已不存在：' + e.stagingDir });
                continue;
            }
            // 安全校验（复用新方法）
            const v = this._validateInstallDir(e.finalDir, e.root, e.slug);
            if (!v.ok) {
                result.failed++;
                result.failedDetails.push({ gameId: e.gameId, error: v.message });
                continue;
            }
            // 文件级 replace（同步，和新 _commit 同逻辑）
            const stagingFiles = this._listFilesRecursive(e.stagingDir);
            if (!stagingFiles.length) {
                // staging 空目录 → 无内容要提交，直接删除 staging 并标记成功
                try { fs.rmSync(e.stagingDir, { recursive: true, force: true }); } catch (err) { }
                result.ok++;
                continue;
            }
            let diskError = null;
            const locked = [];
            for (let j = 0; j < stagingFiles.length; j++) {
                const rel = stagingFiles[j];
                const src = path.join(e.stagingDir, rel);
                const dst = path.join(e.finalDir, rel);
                try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (mderr) { }
                try {
                    fs.renameSync(src, dst);
                } catch (err1) {
                    const code = err1 && err1.code;
                    const isEperm = code === 'EPERM' || code === 'EACCES' || (err1 && /not permitted|permission|denied/i.test(err1.message || ''));
                    if (code === 'ENOSPC') { diskError = '磁盘空间不足'; break; }
                    if (isEperm) { locked.push(rel); continue; }
                    if (code === 'EEXIST' || code === 'ENOENT') {
                        try {
                            if (fs.existsSync(dst)) fs.unlinkSync(dst);
                            fs.renameSync(src, dst);
                        } catch (err2) {
                            const isEperm2 = err2 && (err2.code === 'EPERM' || err2.code === 'EACCES');
                            if (isEperm2) { locked.push(rel); continue; }
                            diskError = '文件替换失败：' + rel; break;
                        }
                    } else if (code === 'EXDEV') {
                        try { fs.copyFileSync(src, dst); fs.unlinkSync(src); } catch (err3) {
                            if (err3 && (err3.code === 'EPERM' || err3.code === 'EACCES')) { locked.push(rel); continue; }
                            diskError = '跨盘复制失败：' + rel; break;
                        }
                    } else {
                        diskError = '文件替换失败：' + rel; break;
                    }
                }
            }
            if (diskError) {
                result.failed++;
                result.failedDetails.push({ gameId: e.gameId, error: diskError });
                continue;
            }
            // 清理旧残留（staging 没有、finalDir 有的文件）
            if (!locked.length) {
                // 全部成功 → 清理 stagingDir + 旧残留 + 空目录
                try { fs.rmSync(e.stagingDir, { recursive: true, force: true }); } catch (err) { }
                self._pruneStagingParent(e.stagingDir);
                result.ok++;
            } else {
                // 仍有 locked 文件 → 保留 stagingDir，更新 pending 记录（更新时间）
                e.queuedAt = Date.now();
                e.lockedFiles = locked;
                remaining.push(e);
                result.pendingLocked++;
                result.failedDetails.push({ gameId: e.gameId, error: '仍有 ' + locked.length + ' 个文件被锁定（可能游戏还在运行）' });
            }
        }
        this._pendingSave(remaining);
        return result;
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
        // 进度总量（散文件通道）：页面按服务端 delta_size_bytes 传增量更新实际字节；
        // 0=未提供走文件清单累加。ZIP 通道不适用（总量按压缩包/解压后大小推进）
        const totalBytes = Math.max(0, Number((payload && payload.totalBytes) || 0));
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
        // 下载总量口径（Steam 模式）：
        //   - 散文件通道 + 服务端给了 delta_size_bytes：只用 delta（本次变化/新增的文件字节）
        //     —— 本地缺失/损坏的未变更文件不在此阶段计入，由后续"验证补齐"阶段统一处理
        //   - 其他情况（首次安装/无 from/BT/ZIP）：按清单全量
        // 不再做 stat 预扫——避免机械盘上 5 万文件同步 stat 阻塞主进程，进度条在下载阶段
        // 以 delta 为基准，下载完进入验证补齐阶段后推进到 100%
        const incremental = !!(payload && payload.incremental);
        const incrementalUpdate = packType === 0 && incremental && totalBytes > 0;
        const totalNeeded = incrementalUpdate ? totalBytes : 0;
        const fullTotal = this._calcTotal(list);
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
            task.total = totalNeeded > 0 ? totalNeeded : fullTotal;
            task.fileIndex = 0;
            task.retries = 0;
            task.received = 0;          // 总处理字节（下载+去重复用，用于整体进度条）
            task.netReceived = 0;       // 实际网络下载字节（速度/净下载量统计）
            task.dedupedCount = 0;      // 去重复用文件数
            task.dedupedBytes = 0;      // 去重复用总字节
            task._speed = 0;
            task._currentRel = '';
            task.incremental = incrementalUpdate; // Steam 增量更新标记（下载完进入验证补齐阶段）
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
                total: totalNeeded > 0 ? totalNeeded : fullTotal,
                fileIndex: 0,
                startedAt: 0,
                retries: 0,
                _reqs: null,       // 当前文件活跃 http 请求集合（Set，暂停/取消遍历 destroy）
                incremental: incrementalUpdate, // Steam 增量更新标记（下载完进入验证补齐阶段）
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
    // 特别处理 pending_restart 状态：commit 已完成但有 locked 文件保留着 stagingDir + pending-updates.json 记录，
    // 用户取消后必须一并清理——否则下次启动 _pendingCommitAll 会自动 commit 被取消的更新（孤儿更新）
    cancel(taskId) {
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return { ok: false, error: '任务不存在' };
        const wasActive = task.state === 'downloading';
        const wasPendingRestart = task.state === 'pending_restart';
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
        // pending_restart 状态额外清理：删 stagingDir + 从 pending-updates.json 移除（防下次启动孤儿自动 commit）
        if (wasPendingRestart) {
            pend.push(new Promise(function (resolve) {
                try {
                    // stagingDir 里可能已经被 replace 走了一部分文件（非 locked 的），rm -rf 全清最干净
                    if (task.stagingDir && fs.existsSync(task.stagingDir)) fs.rmSync(task.stagingDir, { recursive: true, force: true });
                    self._pruneStagingParent(task.stagingDir);
                } catch (e) { /* stagingDir 不存在或权限问题，忽略 */ }
                // 从 pending-updates.json 移除对应 gameId
                if (task.gameId) {
                    self._pendingRemove(task.gameId);
                }
                resolve();
            }));
        }
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

    // 验证补齐阶段（Steam 模式）：对已安装目录内的所有清单文件做 stat+hash 校验，
    // 找出缺失/大小不符/sha 不符的文件并就地下载补齐。补齐文件直接写 finalDir（已安装根）
    // 的同路径——用临时文件写后 rename，避免写一半断电损坏。
    // 进度口径：task.total 保持下载阶段的 delta 总量，补齐的网络字节累加到 netReceived，
    // 进度条从"delta"继续推进。total 最终不变（Steam 模式验证阶段不额外算百分比，
    // 进度条走完 delta 即认为完成——补齐字节体现在 netReceived > total 上）。
    _verifyAndPatch(task, done) {
        const self = this;
        task._phase = 'verify';
        task._speed = 0;
        task._diskSpeed = 0;
        task._currentRel = '';
        this._emit(task, '', null, true); // 阶段切换必发一条（页面切"验证中"）

        const finalDir = task.installDir;
        if (!fs.existsSync(finalDir)) {
            // 目录不存在：全量清单都要补齐
            self._runPatchDownloads(task, task.files.slice(), done);
            return;
        }

        // 逐文件校验
        const needsPatch = [];
        for (const f of task.files) {
            const target = path.resolve(finalDir, f.rel_path);
            let ok = false;
            try {
                const st = fs.statSync(target);
                if (st.isFile() && st.size === f.size) {
                    // 大小匹配 → 做 hash 校验（仅对 sha256 非空的文件）
                    if (f.sha256) {
                        const h = self._hashFileSync(target);
                        if (h && h.toLowerCase() === f.sha256.toLowerCase()) ok = true;
                    } else {
                        ok = true; // 无 sha256 只按大小判
                    }
                }
            } catch (e) { /* stat 失败 = 缺失 */ }
            if (!ok) needsPatch.push(f);
        }
        if (!needsPatch.length) {
            // 全部通过，零补齐
            self._emit(task, '', null, true);
            done(null);
            return;
        }
        self._runPatchDownloads(task, needsPatch, done);
    }

    // 把补齐队列的文件就地下载到 finalDir：直接写临时文件再 rename 到目标路径，
    // 不经过 stagingDir（避免二次换入）。progress/received 口径与下载阶段一致。
    _runPatchDownloads(task, queue, done) {
        const self = this;
        if (!queue.length) { done(null); return; }
        // 保持 downloading 状态，进度条继续推进
        const processOne = function () {
            if (task.state !== 'downloading') { done(null); return; }
            const f = queue.shift();
            if (!f) { done(null); return; }
            const target = path.resolve(task.installDir, f.rel_path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            // 用 _downloadFile 复用下载逻辑——但它默认写 stagingDir 的 target 路径。
            // 我们换个做法：直接复用 HTTP 下载 + 临时文件 + rename
            self._patchOneFile(task, f, target).then(function () {
                processOne();
            }).catch(function (err) {
                done(err);
            });
        };
        processOne();
    }

    // 单文件补齐下载：临时文件 + rename 覆盖（单连接，不走分块/续传，简化逻辑）
    _patchOneFile(task, file, finalPath) {
        const self = this;
        return new Promise(function (resolve, reject) {
            if (task.state !== 'downloading') { resolve(); return; }
            const url = self._buildUrl(task, file);
            if (!url) { reject(new Error('补齐: 缺少下载地址 ' + file.rel_path)); return; }
            if (task.direct && url.indexOf('https:') !== 0) {
                reject(new Error('补齐: 直连必须 https ' + url.split('/').slice(0, 3).join('/')));
                return;
            }
            const tmp = finalPath + '.part';
            const dir = path.dirname(finalPath);
            fs.mkdirSync(dir, { recursive: true });
            const mod = url.indexOf('https:') === 0 ? https : http;
            const req = mod.request({ method: 'GET', url: url, headers: {} }, function (res) {
                // 302 跟随一次（预签名 URL 常见）
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const nextUrl = new URL(res.headers.location, url).toString();
                    res.resume();
                    self._patchOneFile(task, { rel_path: file.rel_path, url: nextUrl, size: file.size, sha256: file.sha256 }, finalPath)
                        .then(resolve).catch(reject);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    self._safeUnlink(tmp);
                    reject(new Error('补齐: HTTP ' + res.statusCode + ' ' + file.rel_path));
                    return;
                }
                let got = 0;
                const writeStream = fs.createWriteStream(tmp);
                res.pipe(writeStream);
                res.on('data', function (chunk) {
                    got += chunk.length;
                    task.netReceived += chunk.length;
                    task.received += chunk.length;
                    self._emit(task, file.rel_path, null, false);
                });
                res.on('end', function () {
                    writeStream.end(function () {
                        try {
                            self._safeUnlink(finalPath);
                            fs.renameSync(tmp, finalPath);
                            if (file.sha256) {
                                const h = self._hashFileSync(finalPath);
                                if (!h || h.toLowerCase() !== file.sha256.toLowerCase()) {
                                    self._safeUnlink(finalPath);
                                    reject(new Error('补齐: hash mismatch ' + file.rel_path));
                                    return;
                                }
                            }
                            resolve();
                        } catch (e) { reject(e); }
                    });
                });
                res.on('error', function (err) { writeStream.end(); self._safeUnlink(tmp); reject(err); });
            });
            req.on('error', function (err) { self._safeUnlink(tmp); reject(err); });
            try { req.end(); } catch (e) { reject(e); }
        });
    }

    // 文件同步哈希（sha256）：分块读取，避免 readFileSync 一次性加载大文件导致 OOM。
    // CHUNK_SIZE=1MB，4GB 文件仅常驻 1MB 缓冲。保持同步签名，调用方无需改 async 链路。
    _hashFileSync(target) {
        try {
            const fd = fs.openSync(target, 'r');
            try {
                const h = crypto.createHash('sha256');
                const chunk = Buffer.allocUnsafe(1024 * 1024); // 1MB
                let pos = 0;
                let bytesRead;
                while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, pos)) > 0) {
                    h.update(bytesRead === chunk.length ? chunk : chunk.slice(0, bytesRead));
                    pos += bytesRead;
                }
                return h.digest('hex');
            } finally {
                fs.closeSync(fd);
            }
        } catch (e) { return ''; }
    }

    _safeUnlink(p) {
        try { fs.unlinkSync(p); } catch (e) {}
    }

    // 任务完成：全部文件下载且校验通过 →（ZIP 打包版本先走解压阶段）→ （增量散文件版本走验证补齐阶段）
    // → 暂存目录一次性换入正式目录（done 必发一条进度；main.js 监听 done 事件探测主程序写注册表）
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
        // 散文件增量更新（Steam 模式）：下载完 delta 文件后，对已安装目录内所有清单文件做逐文件
        // stat+hash 校验，把本地缺失/损坏的未变更文件补齐。phase='verify' 页面显示"验证中"。
        // 首次安装/无 incremental 标记/非散文件通道：跳过验证阶段，直接提交。
        if (task.packType === 0 && task.incremental && task.state === 'downloading') {
            this._verifyAndPatch(task, function (err) {
                if (err) {
                    task.state = 'error';
                    task._phase = 'download';
                    task._emit(task, '', (err && err.message) || '验证补齐失败', true);
                    self._schedule();
                    return;
                }
                self._finishCommit(task);
            });
            return;
        }
        this._finishCommit(task);
    }

    // 解压后提交：Steam 文件级 replace 换入 + done 事件
    // 新 _commit 是同步 for 循环（纯 sync rename 操作），不需要 Promise 收口
    _finishCommit(task) {
        const self = this;
        task.state = 'done';
        task.received = task.total;
        task._speed = 0;
        task._diskSpeed = 0;
        task._lastEmit = Date.now();

        try {
            const cm = self._commit(task);
            if (cm && cm.ok === false) {
                task.state = 'error';
                self._emit(task, '', cm.message || '文件安装失败', true);
                self._schedule();
                return;
            }
            // pendingRestart: true → 部分文件被锁定，已写 pending-updates.json，暂存目录保留
            if (cm && cm.ok === true && cm.pendingRestart) {
                task.state = 'pending_restart';
                const lockedList = (cm.sampleLocked || []).join(', ');
                self._emit(task, '',
                    '下载完成，但有 ' + cm.lockedCount + ' 个文件被占用（' + lockedList + '）。' +
                    '安装将在下次启动时自动生效', true);
                self._schedule(); // 释放并行槽位
                return;
            }
            // 全部成功
            self.emit('progress', self._evt(task, ''));
            self.emit('done', { taskId: task.taskId, gameId: task.gameId, installDir: task.installDir, username: task.username });
            self._schedule();
        } catch (e) {
            task.state = 'error';
            self._emit(task, '', '安装异常：' + ((e && e.message) || e), true);
            self._schedule();
        }
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

    // ===== Steam 同款文件级 replace 提交 =====
    // 核心思路：遍历 stagingDir 里的每个文件，直接 deleteSync(finalFile) + renameSync(stagingFile, finalFile)。
    // 单文件失败（EPERM=被游戏进程独占锁定 / EACCES=权限不足）→ 记录到 locked 列表，继续处理下一个。
    // 全部文件处理完：
    //   - 无 locked 文件 → 清理 stagingDir + 清理 finalDir 里 staging 没有的旧残留 → resolve({ok:true})
    //   - 有 locked 文件 → 保留 stagingDir + 写 pending-updates.json → resolve({ok:true, pendingRestart:true})
    // 为什么 Explorer 打开目录不阻塞？因为 Windows 目录句柄只阻塞目录本身的 rename，
    // 不阻塞目录内部文件的 delete/rename。Explorer 内部用 ReadDirectoryChangesW 实时感知文件变化。
    // 为什么游戏运行中的 .exe 会阻塞？因为游戏进程持有 .exe 的独占读句柄，OS 禁止 deleteSync。
    // 本方案彻底根除：目录 rename EPERM 问题、等待轮询复杂度、进程检测误判。

    // 安全校验（同 _commit 和 _pendingCommitAll 共用）：
    // 返回 {ok:true} 或 {ok:false,message}
    _validateInstallDir(finalDir, root, slug) {
        try {
            const fNorm = path.resolve(finalDir);
            const rNorm = path.resolve(root);
            const rel = path.relative(rNorm, fNorm);
            const leaf = path.basename(fNorm);
            slug = String(slug || '');
            if (!slug || fNorm === rNorm || rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ||
                leaf.toLowerCase() !== slug.toLowerCase()) {
                return { ok: false, message: '安装目录参数异常：finalDir 不是安装根的子目录或与 slug 不匹配，已拒绝执行以防数据丢失' };
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, message: '安装目录校验失败：' + e.message };
        }
    }

    // 递归列出目录下所有文件（相对路径列表，用 forward slashes 归一化）
    _listFilesRecursive(dir) {
        const result = [];
        if (!fs.existsSync(dir)) return result;
        const walk = function (d) {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
            for (let i = 0; i < entries.length; i++) {
                const full = path.join(d, entries[i].name);
                if (entries[i].isDirectory()) walk(full);
                else if (entries[i].isFile()) {
                    const rel = path.relative(dir, full).replace(/\\/g, '/');
                    result.push(rel);
                }
            }
        };
        walk(dir);
        return result;
    }

    // 暂存目录 → 正式目录（Steam 文件级 replace）
    _commit(task) {
        const self = this;
        const finalDir = task.installDir;
        const stagingDir = task.stagingDir;
        const root = task.root;

        // 安全校验（致命防呆）
        const ok = this._validateInstallDir(finalDir, root, task.slug);
        if (!ok.ok) return ok;

        // 无暂存内容 → 直接成功（首次安装跳过了文件下载？不可能，保留作为边界兜底）
        if (!stagingDir || !fs.existsSync(stagingDir)) return { ok: true };

        // 遍历 staging 下所有文件，逐文件 replace
        const stagingFiles = this._listFilesRecursive(stagingDir);
        if (!stagingFiles.length) return { ok: true };

        const total = stagingFiles.length;
        let idx = 0;
        const locked = [];   // EPERM 被锁定的文件列表（rel path）
        let diskError = null; // 非 EPERM 致命错误（磁盘损坏等）

        for (let i = 0; i < stagingFiles.length; i++) {
            // 取消守卫：防御性检查。注意：Node.js 单线程模型下，cancel() 必须等当前同步 for 循环完全执行完
            // （或让出控制权）才能运行——所以在 for 循环中间 cancel 是"不可能"的。守卫保留是因为：
            //   1) cancel 被调用时（无论何时），state 变成 'cancelled' 是终态，后续逻辑不应再继续
            //   2) 如果未来 _commit 加了 await/setTimeout 变成异步（回到旧方案），守卫立即生效
            // 当前纯同步场景下此分支永不触发，属于良性防御代码。
            if (task.state === 'cancelled' || task.state === 'error') {
                return { ok: false, message: '下载已取消' };
            }
            const rel = stagingFiles[i];
            const src = path.join(stagingDir, rel);
            const dst = path.join(finalDir, rel);
            // 进度事件（节流由 _emit 内部处理，force=false）
            idx++;
            task._currentRel = rel;
            task._phase = 'commit';
            self._emit(task, rel, null, false);
            // 确保目标目录存在（staging 里可能有新目录结构）
            try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch (e) { /* 目录已存在忽略 */ }
            // Steam 同款 replace 策略：
            //   1. 先尝试 renameSync（同盘 O(1)，最理想路径）
            //   2. rename 失败 EPERM → 被锁定，跳过记录
            //   3. rename 失败 ENOENT 目标文件不存在 → 纯 create 直接 rename
            //   4. rename 失败 EXDEV → 跨盘 fallback（不同盘时先 unlinkSync 再 copyFileSync 最后 unlink 源）
            //   5. rename 失败 EEXIST → 目标已存在，先 unlinkSync(dst) 再 renameSync(src, dst)
            //   6. 其他错误（ENOSPC=磁盘满等）→ 放弃整个 commit
            try {
                fs.renameSync(src, dst);
            } catch (e1) {
                const code = e1 && e1.code;
                const isEperm = code === 'EPERM' || code === 'EACCES' || (e1 && /not permitted|permission|denied/i.test(e1.message || ''));
                const isEexist = code === 'EEXIST';
                const isEnospc = code === 'ENOSPC';
                const isExdev = code === 'EXDEV';
                if (isEnospc) {
                    diskError = '磁盘空间不足，无法完成文件写入';
                    break;
                }
                if (isEperm) {
                    // 被锁定（游戏运行中 .exe / .dll 独占；或资源管理器打开文件） → 记录跳过
                    locked.push(rel);
                    continue;
                }
                if (isEexist || code === 'ENOENT') {
                    // 目标存在/不存在：先 unlink 再 rename
                    try {
                        if (fs.existsSync(dst)) fs.unlinkSync(dst);
                        fs.renameSync(src, dst);
                    } catch (e2) {
                        const code2 = e2 && e2.code;
                        const isEperm2 = code2 === 'EPERM' || code2 === 'EACCES' || (e2 && /not permitted|permission|denied/i.test(e2.message || ''));
                        if (isEperm2) { locked.push(rel); continue; }
                        diskError = '文件替换失败：' + rel + ' — ' + (e2.message || String(e2));
                        break;
                    }
                } else if (isExdev) {
                    // 跨盘 fallback（同盘 renameSync 理论上不会触发，这里兜底）
                    try {
                        fs.copyFileSync(src, dst);
                        fs.unlinkSync(src);
                    } catch (e3) {
                        const isEperm3 = e3 && (e3.code === 'EPERM' || e3.code === 'EACCES');
                        if (isEperm3) { locked.push(rel); continue; }
                        diskError = '跨盘复制失败：' + rel + ' — ' + (e3.message || String(e3));
                        break;
                    }
                } else {
                    // 其他未知错误（IO 错误、磁盘坏道等）
                    diskError = '文件替换失败：' + rel + ' — ' + (e1.message || String(e1));
                    break;
                }
            }
        }

        // 有磁盘致命错误 → 失败
        // ⚠️ 混合态风险说明：如果 for 循环中途 break（磁盘满/IO 错误），前面几个文件可能已经被 rename
        // 到 finalDir 了，此时 finalDir 处于"前几个新版 + 其余旧版"的混合态，stagingDir 里也丢了前几个。
        // Steam 也有这个问题，靠 per-file SHA256 校验自愈——下次启动时发现 finalDir 里的哈希不匹配就重下。
        // 不改成 copy-then-unlink（避免双倍磁盘占用 + 速度减半），靠校验自愈足够。
        if (diskError) {
            return { ok: false, message: diskError };
        }

        // 清理 finalDir 中 stagingDir 里不存在的旧残留（旧版本特有的文件）
        // 同时清理空目录（自底向上）
        // 注意：如果有 locked 文件（stagingDir 还保留），我们先比对 staging 里的文件 → 再反向扫 finalDir
        // 但 locked 列表里的文件我们不清理（它们还在 staging 里保留，下次启动会 retry replace）
        const stagingSet = {};
        for (let i = 0; i < stagingFiles.length; i++) stagingSet[stagingFiles[i]] = true;
        const finalFiles = this._listFilesRecursive(finalDir);
        for (let j = 0; j < finalFiles.length; j++) {
            const rel = finalFiles[j];
            if (stagingSet[rel]) continue; // staging 里有同名文件（新版本覆盖过了），保留
            if (locked.indexOf(rel) !== -1) continue; // 被锁定的文件也不动（下次启动再 replace）
            // 这个文件在 finalDir 里存在但 stagingDir 里没有 → 旧版本残留 → 删除
            try { fs.unlinkSync(path.join(finalDir, rel)); } catch (e) { /* 被锁定忽略 */ }
        }
        // 清理 finalDir 里的空目录（自底向上，先深后浅）
        this._cleanEmptyDirs(finalDir);

        if (locked.length === 0) {
            // 全部成功 → 清理 stagingDir
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { }
            self._pruneStagingParent(stagingDir);
            return { ok: true };
        }

        // 有 locked 文件 → 保留 stagingDir，写 pending-updates.json
        // stagingDir 保留是关键：下次启动时 _pendingCommitAll 从 stagingDir 再走一遍 replace
        self._pendingAdd({
            gameId: task.gameId,
            slug: task.slug,
            finalDir: finalDir,
            stagingDir: stagingDir,
            root: root,
            lockedFiles: locked,        // 诊断信息：哪些文件被锁定
            queuedAt: Date.now()
        });
        return {
            ok: true,
            pendingRestart: true,
            lockedCount: locked.length,
            totalCount: total,
            sampleLocked: locked.slice(0, 5) // 前端显示最多 5 个示例
        };
    }

    // 清理目录下的空子目录（自底向上，先深后浅；有文件的目录不动）
    _cleanEmptyDirs(dir) {
        const clean = function (d) {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].isDirectory()) clean(path.join(d, entries[i].name));
            }
            // 子目录都处理完了，再看自己是否空（根目录不删）
            if (d !== dir) {
                try {
                    const remaining = fs.readdirSync(d);
                    if (!remaining.length) fs.rmdirSync(d);
                } catch (e) { /* 有文件或权限问题，忽略 */ }
            }
        };
        clean(dir);
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
