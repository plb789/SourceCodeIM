// win7-compat.js - Electron 22 运行时兼容层（仅 Win7 专用构建，由 patch-main.js 打补丁注入使用）
// 背景：主工程按 Electron 44 编写，以下 API 在 Electron 22（Node 16.17 主进程）实测不存在：
//   session.protocol.handle(25+)、全局 fetch/Request/Response/Headers(23+ 经 Node 18)、
//   net.fetch(实测 22 不可用)、Readable.toWeb(Node 17+)。
// 另实测：Electron 22 的 protocol 拦截下 net.request 的 bypassCustomProtocolHandlers 无效
//   （透传同 scheme 会无限递归），故所有网络直连改用 Node http/https 模块天然绕过拦截。
// 本模块提供：最小 Headers/Response 实现 + nodeFetch（拦截透传/下载双用，带 session cookie 注入）
//   + installInterceptor22（protocol.handle 等价实现，基于 interceptStreamProtocol）。
// 注意：nodeFetch 强制 accept-encoding: identity（Node 不解压，若透传压缩字节，
//   arrayBuffer/缓存落盘会拿到压缩数据导致内容损坏）；响应过滤 transfer-encoding 头。

const electron = require('electron');
const https = require('https');
const http = require('http');

// ===== 最小 Headers 实现 =====
function Headers(init) {
    this._o = {};
    if (init instanceof Headers) {
        for (var k in init._o) this._o[k] = init._o[k];
    } else if (init && typeof init === 'object') {
        for (var k2 in init) this._o[String(k2).toLowerCase()] = String(init[k2]);
    }
}
Headers.prototype.get = function (name) {
    var v = this._o[String(name).toLowerCase()];
    return v === undefined ? null : v;
};
Headers.prototype.set = function (name, value) {
    this._o[String(name).toLowerCase()] = String(value);
};
Headers.prototype.has = function (name) {
    return Object.prototype.hasOwnProperty.call(this._o, String(name).toLowerCase());
};
Headers.prototype.toPlain = function () {
    return Object.assign({}, this._o);
};

// ===== 最小 Response 实现 =====
// body 支持：null / string / Buffer / Node Readable（唯一消费方是 installInterceptor22 的
// 回调转换与 arrayBuffer()，无需实现 web streams）
function Response(body, init) {
    init = init || {};
    this.status = init.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers || {});
    this._body = body === undefined ? null : body;
}
Response.prototype.arrayBuffer = function () {
    var b = this._body;
    return new Promise(function (resolve, reject) {
        if (b === null || b === undefined) return resolve(new ArrayBuffer(0));
        if (typeof b === 'string') b = Buffer.from(b, 'utf8');
        if (Buffer.isBuffer(b)) {
            return resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        }
        // Node Readable 收集
        var chunks = [];
        b.on('data', function (c) { chunks.push(c); });
        b.on('end', function () {
            var buf = Buffer.concat(chunks);
            resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        });
        b.on('error', reject);
    });
};
Response.prototype.text = function () {
    return this.arrayBuffer().then(function (ab) { return Buffer.from(ab).toString('utf8'); });
};
Response.prototype.json = function () {
    return this.text().then(function (t) { return JSON.parse(t); });
};

// ===== 拦截器入参适配：interceptStreamProtocol 请求 → fetch 风格 reqLike =====
function makeReq(req22) {
    var h = new Headers(req22.headers || {});
    var body = null;
    if (req22.method !== 'GET' && req22.method !== 'HEAD' && req22.uploadData && req22.uploadData.length) {
        // uploadData 结构跨版本有差异，defensive 提取（bytes/data/filePath），流式上传场景退化为缓冲
        var parts = [];
        for (var i = 0; i < req22.uploadData.length; i++) {
            var u = req22.uploadData[i];
            try {
                if (u && Buffer.isBuffer(u.bytes)) parts.push(u.bytes);
                else if (u && typeof u.data === 'string') parts.push(Buffer.from(u.data, 'utf8'));
                else if (u && typeof u.data === 'object' && Buffer.isBuffer(u.data)) parts.push(u.data);
                else if (u && u.filePath) parts.push(require('fs').readFileSync(u.filePath));
            } catch (e) { /* 单段失败忽略 */ }
        }
        if (parts.length === 1) body = parts[0];
        else if (parts.length) body = Buffer.concat(parts);
    }
    return {
        _isW7Req: true,
        url: req22.url,
        method: req22.method,
        headers: h,
        _body: body,
        get: function (name) { return h.get(name); }
    };
}

// ===== Node http/https 直连（绕过 Chromium protocol 拦截；22 无 bypass 选项，防递归归口） =====
// input: string URL（下载场景）或 makeReq 产物（拦截透传场景）；opts: {signal, headers}
// 返回 Promise<Response>（本地实现，body 为 Node Readable 流式）
// 阶段二百九十三：补「302 跟随 + 跨域 Referer」——Node http 原生不跟随重定向，而服务端网盘下载/预览
//   （serveDriveFile）对 MinIO 后端下发 302 到文件域名预签名直连；该文件域名挂 DCDN Referer 防盗链
//   （白名单=IM 站点域名），跟随跳转时须带 Referer 才放行。实测此前表现：不跟随 → status=302 ok=false
//   → 文档查看器另存直接抛 'HTTP 302'；即便跟随但无 Referer → 被防盗链拒 → 再 302 到错误页域名。
//   语义对齐浏览器：跨域跳转 Referer 归到 origin（strict-origin-when-cross-origin）。
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

function netFetch(input, opts) {
    opts = opts || {};
    var isReq = input && input._isW7Req;
    var headers = {};
    if (isReq) {
        // 透传：请求头原样带回（cookie/UA/content-type 等保持页面语义），host 由 Node 生成
        var plain = input.headers.toPlain();
        for (var k in plain) { if (k !== 'host') headers[k] = plain[k]; }
    }
    if (opts.headers) {
        for (var k2 in opts.headers) headers[String(k2).toLowerCase()] = String(opts.headers[k2]);
    }
    return hopFetch({
        url: isReq ? input.url : String(input),
        method: isReq ? input.method : (opts.method || 'GET'),
        headers: headers,
        body: isReq ? input._body : opts.body,
        signal: opts.signal
    }, 0);
}

// hopFetch 单跳请求 + 重定向跟随（h: {url, method, headers(明文对象), body, signal}）
// 跨域跟随按 origin 补 Referer（命中文件域名防盗链白名单）；同域沿用完整上一跳 URL
function hopFetch(h, hop) {
    var url = h.url;
    var u = new URL(url);
    var mod = u.protocol === 'https:' ? https : http;
    var method = h.method || 'GET';
    var sendHeaders = {};
    for (var k in h.headers) sendHeaders[k] = h.headers[k];
    // 强制不压缩：Node 不解压响应体，压缩字节透传会破坏 arrayBuffer/缓存落盘语义
    sendHeaders['accept-encoding'] = 'identity';
    // 同源 cookie 注入（session cookie jar → 查看器下载/secure-file 等鉴权场景）
    if (!sendHeaders['cookie']) {
        try {
            var cookies = electron.session.defaultSession.cookies.get({ url: url });
            var cs = cookies.map(function (c) { return c.name + '=' + c.value; }).join('; ');
            if (cs) sendHeaders['cookie'] = cs;
        } catch (e) { /* cookie 读取失败：无凭证直连 */ }
    }

    return new Promise(function (resolve, reject) {
        var rq = mod.request(u, { method: method, headers: sendHeaders }, function (rs) {
            var st = rs.statusCode;
            var loc = rs.headers.location;
            var nextUrl = '';
            if (loc && hop < MAX_REDIRECTS && REDIRECT_CODES.indexOf(st) >= 0) {
                try { nextUrl = new URL(loc, u).toString(); } catch (e) { nextUrl = ''; }
            }
            if (nextUrl) {
                rs.resume(); // 跳转响应体丢弃（不消费会占住连接）
                // 303 与 301/302 的非 GET/HEAD 一律降为 GET（浏览器语义）；307/308 保持方法与体
                var nextMethod = (st === 303 || ((st === 301 || st === 302) && method !== 'GET' && method !== 'HEAD')) ? 'GET' : method;
                var nextHeaders = {};
                for (var k2 in sendHeaders) {
                    if (k2 === 'cookie') continue; // 跳转后按新 URL 重新从 cookie jar 取
                    if (nextMethod === 'GET' && (k2 === 'content-length' || k2 === 'content-type')) continue; // 无体请求不得带长度/类型
                    nextHeaders[k2] = sendHeaders[k2];
                }
                var nu = new URL(nextUrl);
                // 跨域按 origin 补 Referer（与浏览器 referrer policy 同构），同域沿用完整上一跳 URL
                nextHeaders['referer'] = (nu.host === u.host) ? u.toString() : (u.origin + '/');
                resolve(hopFetch({ url: nextUrl, method: nextMethod, headers: nextHeaders,
                    body: nextMethod === 'GET' ? null : h.body, signal: h.signal }, hop + 1));
                return;
            }
            var rh = {};
            for (var k3 in rs.headers) {
                if (k3 === 'transfer-encoding') continue; // 流式回调自带分块，双重分块会坏
                rh[k3] = rs.headers[k3];
            }
            resolve(new Response(rs, { status: st, headers: rh }));
        });
        rq.on('error', function (e) { reject(e); });
        if (h.signal) {
            try {
                if (h.signal.aborted) rq.destroy(new Error('aborted'));
                else h.signal.addEventListener('abort', function () { rq.destroy(new Error('aborted')); });
            } catch (e) { /* signal 异常忽略 */ }
        }
        var body = h.body;
        if (body && method !== 'GET' && method !== 'HEAD') rq.write(body);
        rq.end();
    });
}

// ===== Electron 22 拦截方案结论（实测 proto4 穷举验证）=====
// interceptStreamProtocol 对 http/https 标准 scheme 完全失效：handler 命中但响应无法送达
// （ERR_FAILED -2，且首次失败后网络栈对后续请求不再进入 handler）。这正是 Electron 25 引入
// protocol.handle 的原因。故 Win7 构建放弃拦截，页面按原始行为直连网络加载（阶段122 前的
// 正式形态，功能完整，仅失去本地缓存/快照加速）；netFetch（Node 直连）仍用于查看器下载等场景。
function installInterceptor22(session, handler) {
    console.log('[win7-compat] Electron 22 不拦截 http/https（标准 scheme 拦截失效，实测 ERR_FAILED），页面走直连网络模式');
}

module.exports = {
    Headers: Headers,
    Response: Response,
    netFetch: netFetch,
    installInterceptor22: installInterceptor22
};
