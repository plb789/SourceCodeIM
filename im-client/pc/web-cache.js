// web-cache.js - 阶段一百二十二：网页资源本地缓存管理器（PC 端页面提速归口）
// 背景：主窗口原直接 loadURL 服务端 http 地址，每个静态资源都回源校验（no-cache），页面打开/切换慢。
// 方案（同 origin http 拦截）：session.protocol.handle('http') 拦截发往服务端地址的请求——
//   静态资源读本地磁盘（缓存目录 → 内置快照 → 代理服务端三级回退），动态请求（/api/、/upload/、
//   /export/、/doc/、/agent/、用户数据 static/upload|avatar|_git_extract）经 net.fetch 透传服务端，
//   服务端保持资源归口；非服务端地址的 http 请求一律透传，行为不变。
// 关键收益：页面 origin 保持 http://127.0.0.1:8888 不变——localStorage（登录态 im_auth/主题偏好）、
//   WebSocket（socket.js 按 location 推导）、剪贴板 secure context、OnlyOffice 混合内容等全部与
//   原行为完全一致，无需任何前端适配与登录态迁移。
// 实测依据（阶段一百二十二）：本机 Electron 28 下自定义协议 app:// 的页面导航存在稳定性问题
//   （跨协议导航偶发 ERR_FAILED(-2)），同 origin http 拦截方案经最小实测（拦截/透传/origin 三项）通过。
// 快照随安装包内置（build.bat robocopy 生成，electron-builder extraResources 嵌入 resources/web-snapshot），
// 缓存目录只存增量差异（快照只读），首启无需全量下载即可秒开。启动时拉取 /api/web-manifest 清单增量更新。

const { app, net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// 增量同步总超时：超时即放行窗口加载（未完成的后台下载中止，缓存保持一致旧版，下次启动重试）
const SYNC_TIMEOUT_MS = 4000;
// 清单拉取超时（清单接口应当毫秒级返回，2s 足够）
const MANIFEST_TIMEOUT_MS = 2000;
// 差异文件并发下载数
const DOWNLOAD_CONCURRENCY = 4;

// 动态路径前缀：命中即透传服务端（不走本地缓存）
// 说明：/ws 为 WebSocket 升级，不经 protocol handler（浏览器 ws 连接不走路由），由 socket.js 直连服务端
const DYNAMIC_PREFIXES = [
    '/api/',
    '/admin/api/',
    '/upload/',
    '/export/',
    '/doc/',
    '/agent/',
    '/static/upload/',
    '/static/avatar/',
    '/static/_git_extract/'
];

let serverUrl = '';   // 服务端根地址（main.js 注入，如 http://127.0.0.1:8888/）
let serverHost = '';  // 服务端 host（含端口，拦截范围归口：仅该 host 的 http 请求走本地缓存逻辑）
let cacheDir = '';    // 增量缓存目录（userData/webcache，可写）
let snapshotDir = ''; // 内置快照目录（打包 resources/web-snapshot；dev 为 ../web，只读）

// MIME 表：本地文件按扩展名返回类型（net.fetch(file://) 行为不一致，自归口更稳）
const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
    '.pdf': 'application/pdf'
};

function mimeOf(filePath) {
    return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// init 注入服务端地址并解析缓存/快照目录（app ready 后、窗口加载前调用）
// cfg.snapshotDir 可选覆盖快照目录（首启同步实测等场景用；默认按运行形态自动归口）
function init(cfg) {
    serverUrl = String((cfg && cfg.serverUrl) || '');
    try { serverHost = new URL(serverUrl).host; } catch (e) { serverHost = ''; }
    cacheDir = path.join(app.getPath('userData'), 'webcache');
    // 快照目录：打包后取 resources/web-snapshot；dev（npm start）取仓库 web 目录
    snapshotDir = (cfg && cfg.snapshotDir) || (app.isPackaged
        ? path.join(process.resourcesPath, 'web-snapshot')
        : path.resolve(__dirname, '..', 'web'));
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { }
    console.log('[web-cache] 缓存目录:', cacheDir, '| 快照目录:', snapshotDir);
}

// installInterceptor app ready 后安装 http 拦截（main.js whenReady 调用，先于任何窗口加载）
// 仅拦默认会话（主窗口/查看器/托盘面板所在会话）；agent-browser 独立 partition 不受影响；
// 非服务端 host 的 http 请求原样透传（bypass 防递归），浏览区外部网页行为不变
function installInterceptor() {
    session.defaultSession.protocol.handle('http', function (req) {
        try {
            var u = new URL(req.url);
            if (serverHost && u.host === serverHost) {
                return handleRequest(req);
            }
        } catch (e) { /* URL 解析失败按透传处理 */ }
        return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });
    console.log('[web-cache] http 拦截已安装（host=' + serverHost + '）');
}

// isDynamicPath 判断是否动态路径（透传服务端，不读本地缓存）
function isDynamicPath(pathname) {
    return DYNAMIC_PREFIXES.some(function (pre) { return pathname === pre || pathname.indexOf(pre) === 0; });
}

// resolveLocal 按路径在缓存/快照目录解析本地文件（含目录索引与越界防护），未命中返回 null
function resolveLocal(pathname) {
    var rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html'; // 目录索引归口
    var roots = [cacheDir, snapshotDir];
    for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        if (!root) continue;
        var fp = path.normalize(path.join(root, rel));
        // 越界防护：解析结果必须仍位于根目录内（防 %2e%2e 穿越读任意文件）
        if (fp !== root && fp.indexOf(root + path.sep) !== 0) continue;
        try {
            var st = fs.statSync(fp);
            if (st.isFile()) return fp;
        } catch (e) { }
    }
    return null;
}

// serveFile 本地文件响应：手写 Range 支持（audio seek 等场景需要 206 分段）
function serveFile(filePath, req) {
    var st = fs.statSync(filePath);
    var baseHeaders = {
        'Content-Type': mimeOf(filePath),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache' // 与服务端静态服务语义一致：文件本身始终最新（本地磁盘读取同样零回源）
    };
    var range = req.headers.get('range') || '';
    var m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
        // 全量 200：流式响应（monaco 等大文件不占内存）
        var stream = fs.createReadStream(filePath);
        baseHeaders['Content-Length'] = String(st.size);
        return new Response(Readable.toWeb(stream), { status: 200, headers: baseHeaders });
    }
    // Range 解析：支持 bytes=start-end / bytes=start- / bytes=-suffix 三种形态
    var start = 0, end = st.size - 1;
    if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, st.size - parseInt(m[2], 10));
    } else {
        start = parseInt(m[1] || '0', 10);
        if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': 'bytes */' + st.size }
        });
    }
    var part = fs.createReadStream(filePath, { start: start, end: end });
    return new Response(Readable.toWeb(part), {
        status: 206,
        headers: {
            'Content-Type': mimeOf(filePath),
            'Content-Length': String(end - start + 1),
            'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        }
    });
}

// passthrough 原样透传请求到真实网络（bypass 防递归；方法/头/体流式透传，上传 POST 场景依赖）
function passthrough(req) {
    var init = { bypassCustomProtocolHandlers: true };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = req.body; // ReadableStream 直接透传（分片/大文件上传不落内存）
        init.duplex = 'half';
    }
    return net.fetch(req, init);
}

// handleRequest 服务端地址请求处理归口：动态前缀透传 → 本地缓存 → 内置快照 → 透传兜底
async function handleRequest(req) {
    try {
        var u = new URL(req.url);
        var pathname = u.pathname;
        if (isDynamicPath(pathname)) {
            return await passthrough(req);
        }
        var local = resolveLocal(pathname);
        if (local) {
            return serveFile(local, req);
        }
        // 兜底透传：缓存/快照均未命中（清单遗漏、工具链 zip 等大文件、dev 首启无缓存）——
        // 等价于旧行为（回源服务端），保证任何资源不会因本地化策略而 404
        return await passthrough(req);
    } catch (e) {
        console.warn('[web-cache] 请求处理失败:', (req && req.url) || '', e && e.message);
        return new Response('本地资源处理失败', { status: 500 });
    }
}

// readManifest 读取本地增量清单（不存在/损坏返回 null）
function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'));
    } catch (e) {
        return null;
    }
}

// readSnapshotManifest 读取内置快照源属性清单（阶段一百二十三：快照 js 经 obfuscate.js 混淆，
// 产物 size/mtime 与源文件不同，增量比对必须用清单记录的源属性才能与服务端清单对齐——
// 否则混淆 js 会被判为差异导致每次全量下载。清单缺失（dev 模式快照即源目录）回退实扫，行为不变）
function readSnapshotManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(snapshotDir, 'snapshot-manifest.json'), 'utf8'));
    } catch (e) {
        return null;
    }
}

// walkFiles 遍历目录收集 {相对路径: {s,t}}（排除 static 子树/隐藏目录/zip，与服务端清单规则一致）
function walkFiles(root) {
    var out = {};
    if (!root || !fs.existsSync(root)) return out;
    var stack = [''];
    while (stack.length) {
        var rel = stack.pop();
        var dir = rel ? path.join(root, rel) : root;
        var entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            var name = ent.name;
            var childRel = rel ? rel + '/' + name : name;
            if (ent.isDirectory()) {
                // 与服务端清单排除规则对齐：static 整段（用户数据+工具链 zip）与隐藏目录不入缓存
                if (name === 'static' || name.indexOf('.') === 0) continue;
                stack.push(childRel);
                continue;
            }
            if (name.indexOf('.') === 0) continue;
            try {
                var st = fs.statSync(path.join(root, childRel));
                // 取整毫秒：与服务端清单 UnixMilli 精度对齐，避免亚毫秒浮点导致伪差异（每次启动误下载）
                out[childRel] = { s: st.size, t: Math.floor(st.mtimeMs) };
            } catch (e) { }
        }
    }
    return out;
}

// downloadOne 下载单个文件到缓存（tmp+rename 原子替换，回写服务端 mtime 供下次比对）
async function downloadOne(relPath, info, signal) {
    var url = serverUrl.replace(/\/+$/, '') + '/' + relPath;
    var res = await net.fetch(url, { signal: signal, bypassCustomProtocolHandlers: true });
    if (!res.ok) throw new Error('下载 ' + relPath + ' 状态 ' + res.status);
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== info.s) throw new Error('下载 ' + relPath + ' 大小不符 ' + buf.length + '!=' + info.s);
    var fp = path.join(cacheDir, relPath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    var tmp = fp + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, fp);
    // 回写服务端修改时间：下次启动 size+mtime 比对才跨启动有效
    var mt = new Date(info.t);
    fs.utimesSync(fp, mt, mt);
}

// sync 启动增量同步：拉服务端清单 → 与本地（缓存清单+快照索引）比对 → 仅下载差异
// 总超时 SYNC_TIMEOUT_MS，超时中止未完成下载（缓存保持一致旧版，下次启动重试）；任何失败静默不阻塞启动
async function sync() {
    if (!serverUrl) return;
    var t0 = Date.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(new Error('同步总超时')); }, SYNC_TIMEOUT_MS);
    try {
        // 1. 拉取服务端清单
        var mCtrl = new AbortController();
        var mTimer = setTimeout(function () { mCtrl.abort(); }, MANIFEST_TIMEOUT_MS);
        var res;
        try {
            res = await net.fetch(serverUrl.replace(/\/+$/, '') + '/api/web-manifest', { signal: mCtrl.signal, bypassCustomProtocolHandlers: true });
        } finally {
            clearTimeout(mTimer);
        }
        if (!res.ok) throw new Error('清单响应状态 ' + res.status);
        var data = await res.json();
        var remote = {};
        (data.files || []).forEach(function (f) { remote[f.p] = { s: f.s, t: f.t }; });

        // 2. 本地索引 = 缓存清单 + 快照索引（优先源属性清单，混淆产物实扫属性不可比对；
        // 快照只读不入缓存，命中即视为"本地已有"）
        // 阶段一百三十二修复（用户实测：PC 端 index.html/file-viewer.html 长期陈旧导致浏览区
        // 打开文件抛错）：原实现直接信任缓存 manifest 记录的属性做差异比对，一旦 manifest 与
        // 磁盘实际内容脱节（如快照索引占位轮写过 manifest、或下载轮部分成功后清单被覆盖），
        // 同步会永远跳过这些文件，拦截器又优先读缓存目录，陈旧页面被永久服务——死锁无自愈。
        // 现改为对缓存目录逐文件 statSync 实测磁盘属性（mtime 取整毫秒对齐服务端精度），
        // 磁盘缺失或属性与远端不符即判定差异，缓存目录实际内容成为比对唯一事实来源。
        var cached = readManifest();
        var localIdx = {};
        if (cached && cached.files) {
            cached.files.forEach(function (f) {
                // 原实现（信任清单，磁盘脱节即死锁）：localIdx[f.p] = { s: f.s, t: f.t };
                try {
                    var st = fs.statSync(path.join(cacheDir, f.p));
                    localIdx[f.p] = { s: st.size, t: Math.floor(st.mtimeMs) };
                } catch (e) { /* 磁盘无此文件：不占位，交给快照命中或下载补齐 */ }
            });
        }
        var snapIdx = readSnapshotManifest() || walkFiles(snapshotDir);
        Object.keys(snapIdx).forEach(function (p) {
            if (!localIdx[p]) localIdx[p] = snapIdx[p];
        });

        // 3. 差异计算：远端有而本地无（或 size/mtime 不符）的才下载
        var todo = [];
        Object.keys(remote).forEach(function (p) {
            var l = localIdx[p];
            if (!l || l.s !== remote[p].s || l.t !== remote[p].t) todo.push(p);
        });
        // 服务端已删除的本地缓存文件同步清理（快照只读不动）
        var removed = 0;
        if (cached && cached.files) {
            cached.files.forEach(function (f) {
                if (!remote[f.p]) {
                    try { fs.unlinkSync(path.join(cacheDir, f.p)); removed++; } catch (e) { }
                }
            });
        }

        // 4. 并发下载（任何单个失败即中止本轮：缓存保持一致旧版，下次启动重试）
        var done = 0, failed = null;
        if (todo.length) {
            var queue = todo.slice();
            async function worker() {
                while (queue.length && !failed) {
                    var p = queue.shift();
                    try {
                        await downloadOne(p, remote[p], ctrl.signal);
                        done++;
                    } catch (e) {
                        if (!failed) failed = e;
                    }
                }
            }
            var workers = [];
            for (var i = 0; i < DOWNLOAD_CONCURRENCY; i++) workers.push(worker());
            await Promise.all(workers);
            if (failed) throw failed;
        }

        // 5. 写新清单（tmp+rename 原子）：记录全部远端条目，下次启动直接比对
        var manifest = { version: data.version, files: Object.keys(remote).map(function (p) { return { p: p, s: remote[p].s, t: remote[p].t }; }) };
        var mfp = path.join(cacheDir, 'manifest.json');
        var mtmp = mfp + '.tmp';
        fs.writeFileSync(mtmp, JSON.stringify(manifest));
        fs.renameSync(mtmp, mfp);

        console.log('[web-cache] 增量同步完成 version=' + data.version + ' 下载=' + done + ' 清理=' + removed + ' 耗时=' + (Date.now() - t0) + 'ms');
    } catch (e) {
        console.warn('[web-cache] 增量同步跳过（缺失文件运行期代理兜底，不影响启动）:', e && e.message);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    init: init,
    installInterceptor: installInterceptor,
    sync: sync
};
