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
// 原实现：快照经 build.bat robocopy 生成 + extraResources 嵌入 resources/web-snapshot（阶段一百三十六起
// 该步骤已移除——加密快照改由 obfuscate.js 生成 web-snapshot.enc 打入 asar），缓存目录只存增量差异
// （快照只读），首启无需全量下载即可秒开。启动时拉取 /api/web-manifest 清单增量更新。
// ===== 阶段一百三十六：前端资源全链路加密（PC 端磁盘零明文归口） =====
// 密文通道：服务端 /api/secure-file 下发密文容器（IMEF1 魔数 + IV12 + AES-256-GCM 密文+tag16，
// 定长开销 33 字节），本地只落 <rel>.enc 密文，拦截器内存解密后响应页面——安装目录（内置加密快照
// blob web-snapshot.enc，随 app.asar 打包）、userData（.enc 缓存）、网络抓包三条通道均无明文。
// 快照 blob 格式：IMSB1 魔数(5B) + 索引长度(u32LE 4B) + 索引 JSON（相对路径 → {o,l,s,t}：
// o/l 为密文区内偏移与长度，s/t 为源文件 size/mtime 供增量比对）+ 密文区。
// 加密链路开关归口 main.js（cfg.secureKey）：生产取构建期 secure-key.js 掩码注入的密钥，
// dev 回退服务端 config.yaml 的 secure_file_key；IM_SECURE=0 强制关闭回退明文（行为与旧版一致）。
// 解密自愈：密钥轮换等场景旧密文解密失败时顺延下一级（blob/透传），页面永不因缓存解密失败 500。

const { app, net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// ===== 阶段一百三十六：加密链路常量（与服务端 securefile.go / 构建期 obfuscate.js 三方一致） =====
const SECURE_MAGIC = Buffer.from('IMEF1', 'ascii'); // 密文容器魔数
const SECURE_HEADER_LEN = 17;                       // 容器头：魔数 5 + IV 12
const SECURE_OVERHEAD = 33;                         // 容器定长开销：5 + 12 + tag 16
const BLOB_MAGIC = Buffer.from('IMSB1', 'ascii');   // 内置加密快照 blob 魔数
const BLOB_HEADER_LEN = 9;                          // blob 头：魔数 5 + 索引长度 u32LE 4

let serverUrl = '';   // 服务端根地址（main.js 注入，如 http://127.0.0.1:8888/）
let serverHost = '';  // 服务端 host（含端口，拦截范围归口：仅该 host 的 http 请求走本地缓存逻辑）
let cacheDir = '';    // 增量缓存目录（userData/webcache，可写）
let snapshotDir = ''; // 内置明文快照目录（仅明文回退链路使用：dev 为 ../web；打包版自阶段一百三十六起不再内置明文快照，目录不存在时回退全量下载）
// 阶段一百三十六：加密链路状态
let secureKey = null;  // 密钥字节（32B）；非空即加密链路启用（磁盘只落密文、内存解密、blob 参与回退）
let blobFile = '';     // 内置加密快照 blob 路径（pc 根目录 web-snapshot.enc，打包后位于 app.asar 内）
// 阶段一百四十：同步失败自愈重试——全量差异下载"单文件失败即整轮作废"（防半新半旧），原先失败
// 只能等下次重启：部署后 cacheDir 旧副本（命中优先于内置新快照）持续遮蔽新版页面，"时好时坏"根因。
// 失败后定时重跑 sync，成功即止；间隔指数退避 30s→5min 封顶；变更轮经 onSyncedCb 通知 main.js 刷主窗
var onSyncedCb = null;     // 同步成功且变更回调（init 注入）
var retryTimer = null;     // 重试延迟器（防叠）
var retryDelay = 30000;    // 当前重试间隔（指数退避）
var RETRY_MAX_MS = 300000; // 重试间隔封顶 5 分钟
let blobState = 0;     // blob 加载状态：0=未探测 1=可用 2=不可用（惰性探测，首次访问才加载）
let blobIndex = null;  // blob 索引 {相对路径: {o,l,s,t}}（o/l 相对密文区，s/t 源属性）
let blobIdxLen = 0;    // blob 索引区字节长度（密文区起始偏移 = BLOB_HEADER_LEN + blobIdxLen）
let blobFd = null;     // blob 文件句柄（惰性打开常驻，按区间读取不占整块内存）
let blobHitLogged = false; // blob 首命中诊断日志标记（每次运行仅记一条，防逐请求刷屏）

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
// cfg.onSynced 可选回调 function(result)——每轮同步成功且发生变更时触发（启动轮/重试轮共用，
// main.js 据此刷新主窗口，保证更新轮页面即用最新版）
function init(cfg) {
    serverUrl = String((cfg && cfg.serverUrl) || '');
    try { serverHost = new URL(serverUrl).host; } catch (e) { serverHost = ''; }
    cacheDir = path.join(app.getPath('userData'), 'webcache');
    // 快照目录：打包后取 resources/web-snapshot；dev（npm start）取仓库 web 目录
    snapshotDir = (cfg && cfg.snapshotDir) || (app.isPackaged
        ? path.join(process.resourcesPath, 'web-snapshot')
        : path.resolve(__dirname, '..', 'web'));
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { }
    // 阶段一百三十六：加密链路开关（cfg.secureKey 为 64 位 hex；解析归口 main.js）。
    // 启用后：磁盘只落 <rel>.enc 密文与加密 blob，拦截器内存解密；未启用：行为与旧版明文一致
    if (cfg && cfg.secureKey && /^[0-9a-fA-F]{64}$/.test(String(cfg.secureKey))) {
        secureKey = Buffer.from(String(cfg.secureKey), 'hex');
    } else {
        secureKey = null;
    }
    // 阶段一百四十：同步成功变更回调注入（重试轮自愈后同样触发，main.js reload 主窗口换新页面）
    if (typeof (cfg && cfg.onSynced) === 'function') onSyncedCb = cfg.onSynced;
    blobFile = path.join(__dirname, 'web-snapshot.enc'); // 构建期产物（obfuscate.js 生成），随 app.asar 打包
    blobState = 0; // 重置 blob 探测状态（init 理论上仅调用一次，防御性归零）
    console.log('[web-cache] 缓存目录:', cacheDir, '| 快照目录:', snapshotDir,
        '| 加密链路:', secureKey ? '启用（磁盘零明文）' : '关闭（明文回退）');
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

// ===== 阶段一百三十六：加密链路核心（密文容器解密 / 加密快照 blob / 内存响应） =====

// secureDecrypt 解密密文容器（IMEF1 + IV12 + GCM sealed），认证失败/格式不符抛异常
function secureDecrypt(buf) {
    if (!buf || buf.length <= SECURE_OVERHEAD || !buf.subarray(0, 5).equals(SECURE_MAGIC)) {
        throw new Error('密文容器格式不符');
    }
    var sealed = buf.subarray(SECURE_HEADER_LEN);
    var d = crypto.createDecipheriv('aes-256-gcm', secureKey, buf.subarray(5, SECURE_HEADER_LEN));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

// secureDecryptRaw 解密 blob 密文条目（IV12 + GCM sealed，无魔数头——魔数由 blob 头统一承载，
// 实测修正：条目直接走 secureDecrypt 会因缺 IMEF1 头误判"容器格式不符"而整体回落透传）
function secureDecryptRaw(buf) {
    if (!buf || buf.length <= 28) { // 条目定长开销：IV 12 + tag 16
        throw new Error('blob 密文条目过短');
    }
    var sealed = buf.subarray(12);
    var d = crypto.createDecipheriv('aes-256-gcm', secureKey, buf.subarray(0, 12));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

// ensureBlob 惰性加载内置加密快照（读取失败标记不可用并降级缓存/透传，不再重复探测）
// 打包形态 blob 位于 app.asar 内，Electron 主进程 fs 可按句柄读取；按区间读取不占整块内存
function ensureBlob() {
    if (blobState !== 0) return blobState === 1;
    blobState = 2;
    try {
        var fd = fs.openSync(blobFile, 'r');
        var head = Buffer.alloc(BLOB_HEADER_LEN);
        if (fs.readSync(fd, head, 0, BLOB_HEADER_LEN, 0) !== BLOB_HEADER_LEN) throw new Error('blob 头不完整');
        if (!head.subarray(0, 5).equals(BLOB_MAGIC)) throw new Error('blob 魔数不符');
        var idxLen = head.readUInt32LE(5);
        var idxBuf = Buffer.alloc(idxLen);
        if (fs.readSync(fd, idxBuf, 0, idxLen, BLOB_HEADER_LEN) !== idxLen) throw new Error('blob 索引不完整');
        var idx = JSON.parse(idxBuf.toString('utf8')).files || {};
        blobIndex = idx;
        blobIdxLen = idxLen;
        blobFd = fd;
        blobState = 1;
        console.log('[web-cache] 内置加密快照已加载: ' + Object.keys(idx).length + ' 个文件');
    } catch (e) {
        console.log('[web-cache] 内置加密快照不可用（' + (e && e.message) + '），走加密缓存/透传');
        if (blobFd !== null) { try { fs.closeSync(blobFd); } catch (e2) { } blobFd = null; }
        blobIndex = null;
    }
    return blobState === 1;
}

// serveBuffer 内存明文响应：与 serveFile 同款语义（Range/206、no-cache），数据源为解密后的 Buffer
function serveBuffer(plain, mimeType, req) {
    var baseHeaders = {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache' // 与服务端静态服务语义一致：本地解密同样零回源
    };
    var range = req.headers.get('range') || '';
    var m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
        baseHeaders['Content-Length'] = String(plain.length);
        return new Response(plain, { status: 200, headers: baseHeaders });
    }
    // Range 解析：与 serveFile 同款三形态（bytes=start-end / start- / -suffix）
    var start = 0, end = plain.length - 1;
    if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, plain.length - parseInt(m[2], 10));
    } else {
        start = parseInt(m[1] || '0', 10);
        if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= plain.length) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': 'bytes */' + plain.length }
        });
    }
    return new Response(plain.subarray(start, end + 1), {
        status: 206,
        headers: {
            'Content-Type': mimeType,
            'Content-Length': String(end - start + 1),
            'Content-Range': 'bytes ' + start + '-' + end + '/' + plain.length,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
        }
    });
}

// resolveLocalEnc 加密缓存解析：仅缓存目录，路径追加 .enc 后缀（磁盘零明文归口），越界防护同 resolveLocal
function resolveLocalEnc(pathname) {
    var rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
    if (rel === '/' || rel === '') rel = '/index.html'; // 目录索引归口
    var fp = path.normalize(path.join(cacheDir, rel + '.enc'));
    // 越界防护：解析结果必须仍位于缓存目录内（防 %2e%2e 穿越读任意密文文件）
    if (fp !== cacheDir && fp.indexOf(cacheDir + path.sep) !== 0) return null;
    try {
        var st = fs.statSync(fp);
        if (st.isFile()) return fp;
    } catch (e) { }
    return null;
}

// tryServeEncrypted 读取加密缓存并内存解密响应；解密失败返回 null（调用方顺延 blob/透传——
// 密钥轮换等场景旧缓存自动降级自愈，页面永不因缓存解密失败 500）
function tryServeEncrypted(encPath, mimeType, req) {
    try {
        var plain = secureDecrypt(fs.readFileSync(encPath));
        return serveBuffer(plain, mimeType, req);
    } catch (e) {
        console.warn('[web-cache] 密文缓存解密失败，顺延快照/透传:', path.basename(encPath), e && e.message);
        return null;
    }
}

// tryServeBlob 从内置加密快照按区间读取并内存解密响应；未命中/不可用/解密失败返回 null
// 密文区起始 = blob 头 9B + 索引区；条目偏移 o 相对密文区起点（构建期 obfuscate.js 写入）。
// 注意 blob 索引键为不带前导斜杠的相对路径（与清单/源属性归口一致），查询前需归一
function tryServeBlob(pathname, req) {
    if (!ensureBlob()) return null;
    var rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
    rel = (rel === '/' || rel === '') ? 'index.html' : rel.replace(/^\/+/, ''); // 目录索引归口 + 去前导斜杠
    var ent = blobIndex[rel];
    if (!ent || !ent.l) return null;
    try {
        var enc = Buffer.alloc(ent.l);
        var read = fs.readSync(blobFd, enc, 0, ent.l, BLOB_HEADER_LEN + blobIdxLen + ent.o);
        if (read !== ent.l) throw new Error('blob 读取不完整 ' + read + '/' + ent.l);
        var plain = secureDecryptRaw(enc);
        if (!blobHitLogged) {
            blobHitLogged = true;
            console.log('[web-cache] 命中内置加密快照（首次）: ' + rel + '（后续命中不再记录）');
        }
        return serveBuffer(plain, mimeOf(rel), req);
    } catch (e) {
        console.warn('[web-cache] blob 条目解密失败:', rel, e && e.message);
        return null;
    }
}

// passthrough 原样透传请求到真实网络（bypass 防递归；方法/头/体流式透传，上传 POST 场景依赖）
function passthrough(req) {
    var init = { bypassCustomProtocolHandlers: true };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = req.body; // ReadableStream 直接透传（分片/大文件上传不落内存）
        init.duplex = 'half';
    }
    // 阶段一百三十四复盘：此前排查"查看器图片黑屏/下载损坏"时加过透传状态码诊断日志，已定性为
    // 双实例并发写同一 userData 的存储冲突（非本模块缺陷），诊断代码按惯例注释保留并还原原实现
    // 诊断版（已注释）：
    // return net.fetch(req, init).then(function (res) {
    //     var fs = require('fs'); var path = require('path');
    //     var diagDir = path.join(app.getPath('userData'), 'webcache');
    //     fs.mkdirSync(diagDir, { recursive: true });
    //     fs.appendFileSync(path.join(diagDir, 'diag.log'), new Date().toISOString() + ' ' + req.method + ' ' + req.url +
    //         ' -> ' + res.status + ' | inm=' + (req.headers.get('if-none-match') || '-') +
    //         ' | ims=' + (req.headers.get('if-modified-since') || '-') + '\n');
    //     return res;
    // });
    return net.fetch(req, init);
}

// handleRequest 服务端地址请求处理归口：动态前缀透传 → 加密链路（缓存.enc → blob 快照 → 透传兜底）
//   / 明文链路（缓存 → 快照 → 透传兜底，原实现）
async function handleRequest(req) {
    try {
        var u = new URL(req.url);
        var pathname = u.pathname;
        // 目录索引归口须在 mime 推导前完成：'/' 经 path.extname 为空 → octet-stream，
        // 根文档会被 Chromium 按下载处理（导航被放弃、旧文档滞留 + 弹"另存为"保存框）。
        // resolveLocalEnc/tryServeBlob 内部各自归一，唯 mimeOf(pathname) 被遗漏（实测根文档
        // 从加密缓存命中时 content-type=application/octet-stream）
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        if (isDynamicPath(pathname)) {
            return await passthrough(req);
        }
        // 阶段一百三十六：加密链路——磁盘零明文，内存解密响应
        if (secureKey) {
            var encPath = resolveLocalEnc(pathname);
            if (encPath) {
                var encResp = tryServeEncrypted(encPath, mimeOf(pathname), req);
                if (encResp) return encResp; // 解密失败（密钥轮换等）顺延 blob/透传，自愈不 500
            }
            var blobResp = tryServeBlob(pathname, req);
            if (blobResp) return blobResp;
            // 兜底透传：加密缓存与 blob 均未命中（清单遗漏、工具链 zip 等大文件）——等价旧行为，任何资源不 404
            return await passthrough(req);
        }
        // 原实现（明文三级回退：缓存目录 → 内置快照 → 透传；IM_SECURE=0 / 密钥未配置时保持不变）
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

// downloadEncOne 阶段一百三十六：下载单个文件的密文容器到缓存（/api/secure-file；tmp+rename
// 原子替换，回写服务端 mtime 供下次比对）。下载即解密验签（GCM 认证失败判失败，坏包不入缓存），
// 返回密文长度（写清单 es 供下次磁盘属性比对）
async function downloadEncOne(relPath, info, signal) {
    var url = serverUrl.replace(/\/+$/, '') + '/api/secure-file?path=' + encodeURIComponent(relPath);
    var res = await net.fetch(url, { signal: signal, bypassCustomProtocolHandlers: true });
    if (!res.ok) throw new Error('下载 ' + relPath + ' 状态 ' + res.status);
    var buf = Buffer.from(await res.arrayBuffer());
    // 长度校验：容器定长开销 33 字节（魔数5+IV12+tag16），不符即坏包
    if (buf.length !== SECURE_OVERHEAD + info.s) {
        throw new Error('密文长度不符 ' + relPath + ' ' + buf.length + '!=' + (SECURE_OVERHEAD + info.s));
    }
    secureDecrypt(buf); // 下载即验签：GCM 认证失败立即中止本轮（缓存保持一致旧版，下次启动重试）
    var fp = path.join(cacheDir, relPath + '.enc');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    var tmp = fp + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, fp);
    // 回写服务端修改时间：下次启动 mtime 比对才跨启动有效（密文长度 es 另记清单）
    var mt = new Date(info.t);
    fs.utimesSync(fp, mt, mt);
    return buf.length;
}

// cleanLegacyPlaintext 阶段一百三十六：遍历缓存目录删除非 .enc 文件（加密链路升级自旧明文
// 缓存版本的一次性清理；manifest.json 保留），保证 userData 磁盘零明文
function cleanLegacyPlaintext() {
    var removed = 0;
    var stack = [''];
    while (stack.length) {
        var rel = stack.pop();
        var dir = rel ? path.join(cacheDir, rel) : cacheDir;
        var entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            var childRel = rel ? rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) { stack.push(childRel); continue; }
            if (ent.name === 'manifest.json' || /\.enc$/i.test(ent.name)) continue;
            try { fs.unlinkSync(path.join(cacheDir, childRel)); removed++; } catch (e) { }
        }
    }
    if (removed) console.log('[web-cache] 已清理旧版明文缓存 ' + removed + ' 个文件（加密链路一次性升级清理）');
}

// sync 启动增量同步：拉服务端清单 → 与本地（缓存清单+快照索引）比对 → 仅下载差异
// 总超时 SYNC_TIMEOUT_MS，超时中止未完成下载（缓存保持一致旧版，下次启动重试）；任何失败静默不阻塞启动
async function sync() {
    if (!serverUrl) return;
    var t0 = Date.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(new Error('同步总超时')); }, SYNC_TIMEOUT_MS);
    try {
        // 0. 阶段一百三十六：加密链路一次性清理——升级前旧版本可能残留明文缓存文件，统一删除
        // （仅保留 .enc 密文与 manifest.json），保证 userData 磁盘零明文
        if (secureKey) cleanLegacyPlaintext();
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

        // 2. 本地索引 = 缓存清单实测磁盘属性 + 快照索引（快照只读不入缓存，命中即视为"本地已有"）
        // 阶段一百三十二修复（用户实测：PC 端 index.html/file-viewer.html 长期陈旧导致浏览区
        // 打开文件抛错）：原实现直接信任缓存 manifest 记录的属性做差异比对，一旦 manifest 与
        // 磁盘实际内容脱节（如快照索引占位轮写过 manifest、或下载轮部分成功后清单被覆盖），
        // 同步会永远跳过这些文件，拦截器又优先读缓存目录，陈旧页面被永久服务——死锁无自愈。
        // 现改为实测磁盘属性（磁盘缺失或属性与远端不符即判定差异，缓存目录实际内容成为比对唯一事实来源）。
        // 阶段一百三十六：加密链路下缓存文件为 <rel>.enc 密文容器（明文大小不可从磁盘直接得知），
        // 磁盘实测基于清单记录的"密文长度 es + 下载时回写的服务端 mtime"双比对，脱节/损坏即判差异，
        // 语义与明文形态等价（唯一事实来源仍是缓存目录实际内容）。
        var cached = readManifest();
        var oldEs = {}; // 旧清单记录的密文长度（本轮未重下载的条目沿用，供新清单写入）
        var localIdx = {};
        if (cached && cached.files) {
            cached.files.forEach(function (f) {
                if (f.es) oldEs[f.p] = f.es;
                if (secureKey) {
                    // 加密链路：实测 <rel>.enc（密文长度与回写 mtime 双比对）
                    try {
                        var st = fs.statSync(path.join(cacheDir, f.p + '.enc'));
                        if (st.size === f.es && Math.floor(st.mtimeMs) === f.t) {
                            localIdx[f.p] = { s: f.s, t: f.t };
                        }
                    } catch (e) { /* 磁盘无此密文文件：不占位，交给快照命中或下载补齐 */ }
                } else {
                    // 原实现（明文链路磁盘实测，阶段一百三十二）
                    try {
                        var st = fs.statSync(path.join(cacheDir, f.p));
                        localIdx[f.p] = { s: st.size, t: Math.floor(st.mtimeMs) };
                    } catch (e) { /* 磁盘无此文件：不占位，交给快照命中或下载补齐 */ }
                }
            });
        }
        // 快照索引：加密链路取内置 blob 索引（构建期记录源属性 s/t）；明文链路取快照源属性
        // 清单/实扫（原实现）。blob 不可用时快照索引为空，全部差异走密文下载补齐（自愈）
        var snapIdx = secureKey
            ? (ensureBlob() ? blobIndex : {})
            : (readSnapshotManifest() || walkFiles(snapshotDir));
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
                    try {
                        // 阶段一百三十六：加密链路清理 <rel>.enc；原实现（明文）：path.join(cacheDir, f.p)
                        fs.unlinkSync(path.join(cacheDir, f.p + (secureKey ? '.enc' : '')));
                        removed++;
                    } catch (e) { }
                }
            });
        }

        // 4. 并发下载（任何单个失败即中止本轮：缓存保持一致旧版，下次启动重试）
        var done = 0, failed = null;
        var esMap = {}; // 加密链路：本轮下载实得的密文长度（写清单 es 供下次磁盘属性比对）
        if (todo.length) {
            var queue = todo.slice();
            async function worker() {
                while (queue.length && !failed) {
                    var p = queue.shift();
                    try {
                        if (secureKey) {
                            esMap[p] = await downloadEncOne(p, remote[p], ctrl.signal);
                        } else {
                            await downloadOne(p, remote[p], ctrl.signal); // 原实现（明文直存）
                        }
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

        // 5. 写新清单（tmp+rename 原子）：记录全部远端条目，下次启动直接比对；
        // 加密链路附加密文长度 es（本轮下载实得 / 旧清单沿用），供下次磁盘属性双比对
        // 原实现：files 仅含 {p,s,t}
        var manifest = { version: data.version, files: Object.keys(remote).map(function (p) {
            return secureKey
                ? { p: p, s: remote[p].s, t: remote[p].t, es: (esMap[p] !== undefined ? esMap[p] : (oldEs[p] || 0)) }
                : { p: p, s: remote[p].s, t: remote[p].t };
        }) };
        var mfp = path.join(cacheDir, 'manifest.json');
        var mtmp = mfp + '.tmp';
        fs.writeFileSync(mtmp, JSON.stringify(manifest));
        fs.renameSync(mtmp, mfp);

        console.log('[web-cache] 增量同步完成 version=' + data.version + ' 下载=' + done + ' 清理=' + removed + ' 耗时=' + (Date.now() - t0) + 'ms');
        retryDelay = 30000; // 成功复位退避（下轮失败从 30s 重新起步）
        // 阶段一百三十五：向调用方回报本轮变更量；阶段一百四十：经回调归口通知 main.js 刷主窗
        //（启动轮与重试轮共用同一出口，重试自愈后页面同样自动换新）
        var result = { downloaded: done, removed: removed };
        if (typeof onSyncedCb === 'function' && (done > 0 || removed > 0)) {
            try { onSyncedCb(result); } catch (e) { console.warn('[web-cache] onSynced 回调失败:', e && e.message); }
        }
        return result;
    } catch (e) {
        console.warn('[web-cache] 增量同步跳过（缺失文件运行期代理兜底，不影响启动）:', e && e.message);
        scheduleSyncRetry(e && e.message);
        return null; // 同步失败：不回报变更，主进程不刷新（运行期代理兜底 + 定时重试自愈）
    } finally {
        clearTimeout(timer);
    }
}

// scheduleSyncRetry 失败重试调度（阶段一百四十）：指数退避 30s→5min，成功即止；防叠（timer 在途不重排）
function scheduleSyncRetry(reason) {
    if (!serverUrl || retryTimer) return;
    retryTimer = setTimeout(function () {
        retryTimer = null;
        sync().then(function (r) {
            if (!r) scheduleSyncRetry('重试轮仍未成功'); // r=null：catch 内已再调度；此处兜底防御
        });
    }, retryDelay);
    console.log('[web-cache] ' + Math.round(retryDelay / 1000) + 's 后重试增量同步（' + reason + '）');
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
}

module.exports = {
    init: init,
    installInterceptor: installInterceptor,
    sync: sync
};
