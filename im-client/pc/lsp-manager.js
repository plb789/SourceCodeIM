// lsp-manager.js - 阶段一百三十：本地 LSP（Language Server Protocol）语言服务管理器
//
// 纯 Node 模块，不依赖 Electron API（与 agent-executor 同风格，可独立测试）。
// 由 browser-manager 按文件标签归口调用（tab_id → tab.filePath，页面不持有绝对路径）。
//
// 与 TRAE 同构的架构：检测本机 PATH 中已安装的语言服务器（gopls/clangd/pyright）→
// 按（语言种类 + 工作区根目录）懒启动子进程 → stdio JSON-RPC（Content-Length 分帧）→
// initialize 握手 → didOpen/didChange 同步编辑缓冲 → textDocument/hover 请求真实
// 类型推导与注释文档（Markdown）。悬停统一 800ms 竞速超时：命中返回 {markdown, range}，
// 超时/未安装/进程崩溃一律返回 null，由前端（file-viewer.html）回落内置静态文档表。
// LSP 是增强，静态表是底线——任一环节缺失都不弹错不打断。
//
// JS/TS 不走本管理器（Monaco 内置 TS 语言服务已在页面侧生效）。

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ===== 语言服务器定义 =====
// probe：探测用可执行名；args：启动参数；rootMarkers：工作区根标记文件（向上逐级查找）
const SERVER_DEFS = {
    go: {
        probe: 'gopls',
        args: ['serve'],
        rootMarkers: ['go.mod'],
        exts: ['go'],
        langIds: { go: 'go' }
    },
    cpp: {
        probe: 'clangd',
        args: [], // clangd 默认即 stdio 模式
        rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.git'],
        exts: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh'],
        langIds: { c: 'c', cpp: 'cpp' }
    },
    python: {
        probe: 'pyright-langserver',
        args: ['--stdio'],
        rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', '.git'],
        exts: ['py'],
        langIds: { python: 'python' }
    }
};

// 扩展名 → 语言服务器种类 + LSP languageId（'.h' 归 C 系，languageId 用 'c'）
const EXT_MAP = {};
Object.keys(SERVER_DEFS).forEach(function (kind) {
    const def = SERVER_DEFS[kind];
    def.exts.forEach(function (ext) {
        EXT_MAP[ext] = { kind: kind, langId: def.langIds[ext] || ext };
    });
});

// ===== 服务器可执行探测（结果缓存；进程存活期内无需重探） =====
let detectPromise = null;
function probePath(name) {
    return new Promise(function (resolve) {
        execFile('where', [name], { timeout: 5000, windowsHide: true }, function (err, stdout) {
            if (!err && stdout) {
                const first = String(stdout).split(/\r?\n/)[0].trim();
                resolve(first || null); // where 首行即 PATH 中首个命中
            } else {
                resolve(null);
            }
        });
    });
}
function detectServers() {
    if (detectPromise) return detectPromise;
    // gopls 特例：go install 装到 %GOPATH%\bin，该目录常不在 PATH → where 失败后补探
    detectPromise = new Promise(function (resolve) {
        const names = Object.keys(SERVER_DEFS).map(function (k) { return SERVER_DEFS[k].probe; });
        Promise.all(names.map(probePath)).then(function (hits) {
            const result = {};
            Object.keys(SERVER_DEFS).forEach(function (k, i) { result[k] = hits[i]; });
            if (!result.go) {
                execFile('go', ['env', 'GOPATH'], { timeout: 5000, windowsHide: true }, function (err, stdout) {
                    if (!err && stdout) {
                        const cand = path.join(String(stdout).trim(), 'bin', 'gopls.exe');
                        try { if (fs.existsSync(cand)) result.go = cand; } catch (e) {}
                    }
                    resolve(result);
                });
            } else {
                resolve(result);
            }
        });
    });
    return detectPromise;
}

// ===== JSON-RPC 分帧（LSP 规范：Content-Length 头 + UTF-8 正文） =====
function encodeFrame(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
}

// 轻量内容哈希（djb2）：didChange 去重（缓冲未变不重发，省带宽省 CPU）
function textHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return String(h) + ':' + s.length;
}

// ===== 语言服务器实例 =====
// instances：kind + '|' + root → 实例（同项目同实例，跨文件共享分析结果）
const instances = new Map();
const IDLE_KILL_MS = 5 * 60 * 1000; // 空闲 5 分钟回收（防多项目浏览积累进程）
let nextReqId = 1;

function killInstance(inst, why) {
    if (inst.dead) return;
    inst.dead = true;
    instances.delete(inst.key);
    if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }
    try { inst.child.kill(); } catch (e) {}
    // 在途请求全部以 null 收场（调用方回落静态表，不打断悬停）
    inst.pending.forEach(function (p) { p.resolve(null); });
    inst.pending.clear();
    if (why) console.log('LSP 服务器退出（' + inst.kind + '）：' + why);
}

function startInstance(kind, root, exe) {
    const def = SERVER_DEFS[kind];
    const key = kind + '|' + root;
    const inst = {
        key: key, kind: kind, root: root,
        child: null, dead: false, ready: false,
        buffer: Buffer.alloc(0),           // stdout 分帧缓冲
        pending: new Map(),                // id → {resolve}
        docs: new Map(),                   // uri → {version, hash}
        idleTimer: null, lastUsed: 0
    };
    try {
        // .cmd 垫片（pyright 的 npm 全局安装形态）须经 shell 启动，其余直启防注入
        inst.child = spawn(exe, def.args, {
            cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            shell: /\.cmd$/i.test(exe)
        });
    } catch (e) {
        inst.dead = true;
        return null;
    }
    inst.child.on('error', function (err) { killInstance(inst, err.message); });
    inst.child.on('exit', function (code) { killInstance(inst, '退出码 ' + code); });
    inst.child.stdout.on('data', function (chunk) { onServerData(inst, chunk); });
    inst.child.stderr.on('data', function () {}); // 语言服务器诊断日志静默丢弃（防管道塞死）

    // initialize 握手（rootUri 即工作区根；悬停能力声明 Markdown 优先）
    // 应答挂入 pending：resolve 时置 ready 并回 initialized 通知（LSP 握手规范）
    const initId = nextReqId++;
    inst.pending.set(initId, { resolve: function () { onReady(inst); } });
    sendTo(inst, {
        jsonrpc: '2.0', id: initId, method: 'initialize',
        params: {
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            capabilities: {
                textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } }
            }
        }
    });
    return inst;
}

function onServerData(inst, chunk) {
    inst.buffer = Buffer.concat([inst.buffer, chunk]);
    for (;;) {
        // 找头部结束标记 \r\n\r\n，解析 Content-Length 后按长度取正文
        const headEnd = inst.buffer.indexOf('\r\n\r\n');
        if (headEnd < 0) {
            if (inst.buffer.length > 65536) inst.buffer = Buffer.alloc(0); // 异常防护
            break;
        }
        const head = inst.buffer.slice(0, headEnd).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(head);
        if (!m) { inst.buffer = inst.buffer.slice(headEnd + 4); continue; }
        const len = parseInt(m[1], 10);
        if (inst.buffer.length < headEnd + 4 + len) break; // 正文未齐，等下一块
        const body = inst.buffer.slice(headEnd + 4, headEnd + 4 + len);
        inst.buffer = inst.buffer.slice(headEnd + 4 + len);
        let msg = null;
        try { msg = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
        handleServerMessage(inst, msg);
    }
}

function handleServerMessage(inst, msg) {
    if (msg.id == null) return; // 通知（window/logMessage 等）静默忽略
    if (msg.method) {
        // 服务端→客户端请求：统一回空结果（gopls 的 registerCapability/configuration 必须应答，
        // 否则其后续推送会挂起；空结果对悬停功能无影响）
        let result = null;
        if (msg.method === 'workspace/configuration' && msg.params && Array.isArray(msg.params.items)) {
            result = msg.params.items.map(function () { return null; });
        }
        sendTo(inst, { jsonrpc: '2.0', id: msg.id, result: result });
        return;
    }
    const p = inst.pending.get(msg.id);
    if (p) {
        inst.pending.delete(msg.id);
        p.resolve(msg.result == null ? null : msg.result);
    }
}

function sendTo(inst, obj) {
    if (inst.dead || !inst.child || !inst.child.stdin.writable) return;
    try { inst.child.stdin.write(encodeFrame(obj)); } catch (e) {}
}

// initialize 应答到达后发 initialized 通知并标记就绪（handleServerMessage 的 id 匹配不到
// pending 时即视为握手完成——initialize 是我们发出的首个请求，特判收尾）
// 简化实现：initialize 的应答在 request() 里不挂 pending，由 onReady 兜住
function onReady(inst) {
    if (inst.ready) return;
    inst.ready = true;
    sendTo(inst, { jsonrpc: '2.0', method: 'initialized', params: {} });
}

// ===== 工作区根定位：从文件所在目录向上逐级找项目标记（上限 12 级），兜底文件目录 =====
function findRoot(kind, filePath) {
    const markers = SERVER_DEFS[kind].rootMarkers;
    let dir = path.dirname(filePath);
    for (let i = 0; i < 12; i++) {
        for (let j = 0; j < markers.length; j++) {
            try { if (fs.existsSync(path.join(dir, markers[j]))) return dir; } catch (e) {}
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.dirname(filePath); // 单文件模式（无项目标记）
}

// ===== 文档同步：首次 didOpen，内容变化 didChange 全量（版本号递增） =====
function syncDoc(inst, filePath, text, langId) {
    let uri;
    try { uri = pathToFileURL(filePath).href; } catch (e) { return null; }
    const hash = textHash(text);
    const prev = inst.docs.get(uri);
    if (!prev) {
        inst.docs.set(uri, { version: 1, hash: hash });
        sendTo(inst, {
            jsonrpc: '2.0', method: 'textDocument/didOpen',
            params: { textDocument: { uri: uri, languageId: langId, version: 1, text: text } }
        });
    } else if (prev.hash !== hash) {
        prev.version += 1;
        prev.hash = hash;
        sendTo(inst, {
            jsonrpc: '2.0', method: 'textDocument/didChange',
            params: {
                textDocument: { uri: uri, version: prev.version },
                contentChanges: [{ text: text }]
            }
        });
    }
    return uri;
}

// ===== LSP Hover 结果归一化为 Markdown（MarkupContent / MarkedString / 数组三形态） =====
function formatHover(result) {
    if (!result || !result.contents) return null;
    let md = '';
    const c = result.contents;
    if (Array.isArray(c)) {
        md = c.map(function (part) {
            if (typeof part === 'string') return part;
            return (part && part.value) || '';
        }).join('\n\n');
    } else if (typeof c === 'string') {
        md = c;
    } else if (c.kind != null) {
        md = c.value || ''; // MarkupContent
    } else if (c.value != null) {
        md = c.value; // MarkedString 对象
    }
    md = String(md || '').trim();
    if (!md) return null;
    return { markdown: md, range: result.range || null };
}

// ===== 归一入口：browser-manager 按标签归口调用 =====
// req = {filePath, text, line, character}（行列均零基，LSP 坐标）
// 返回 Promise<{markdown, range} | null>；一切异常静默 null（前端回落静态表）
function hover(req) {
    const p = (req && typeof req === 'object') ? req : {};
    const filePath = String(p.filePath || '');
    if (!filePath) return Promise.resolve(null);
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const map = EXT_MAP[ext];
    if (!map) return Promise.resolve(null); // 非覆盖语言（JS/TS 等走 Monaco 内置）
    const line = parseInt(p.line, 10) || 0;
    const character = parseInt(p.character, 10) || 0;
    const text = String(p.text != null ? p.text : '');
    if (text.length > 512 * 1024) return Promise.resolve(null); // 与查看器 TEXT_MAX 对齐

    const deadline = Date.now() + 800; // 悬停竞速总时限（TRAE 同款即时反馈，超时回落静态表）
    return detectServers().then(function (found) {
        const exe = found[map.kind];
        if (!exe) return null; // 本机未安装该语言服务器 → 静态表兜底
        const root = findRoot(map.kind, filePath);
        const key = map.kind + '|' + root;
        let inst = instances.get(key);
        if (!inst) {
            inst = startInstance(map.kind, root, exe);
            if (!inst || inst.dead) return null;
            instances.set(key, inst);
        }
        if (inst.dead) return null;
        inst.lastUsed = Date.now();
        if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }

        // 等握手就绪后发悬停请求，统一受 800ms 竞速约束（冷启动期首次悬停自然回落静态表）
        const waitReady = inst.ready ? Promise.resolve() : new Promise(function (resolve) {
            const started = Date.now();
            const t = setInterval(function () {
                if (inst.ready || inst.dead || Date.now() - started > 30000) { clearInterval(t); resolve(); }
            }, 25);
        });
        return waitReady.then(function () {
            if (inst.dead || !inst.ready) return null; // 握手未完成（未装/启动失败/超时）→ 静态表兜底
            const uri = syncDoc(inst, filePath, text, map.langId);
            if (!uri) return null;
            return new Promise(function (resolve) {
                const id = nextReqId++;
                inst.pending.set(id, { resolve: resolve });
                sendTo(inst, {
                    jsonrpc: '2.0', id: id, method: 'textDocument/hover',
                    params: { textDocument: { uri: uri }, position: { line: line, character: character } }
                });
                setTimeout(function () { // 竞速超时：请求作废（晚到的结果被丢弃）
                    if (inst.pending.delete(id)) resolve(null);
                }, Math.max(50, deadline - Date.now()));
            }).then(formatHover);
        });
    }).catch(function () { return null; });
}

// 空闲实例回收（browser-manager init 时挂上；60 秒巡检一次）
function startReaper() {
    setInterval(function () {
        const now = Date.now();
        instances.forEach(function (inst) {
            if (now - inst.lastUsed > IDLE_KILL_MS) killInstance(inst, '空闲超时回收');
        });
    }, 60 * 1000);
}

// 应用退出全量回收（main.js will-quit 调用）
function shutdownAll() {
    instances.forEach(function (inst) { killInstance(inst, null); });
}

startReaper();

module.exports = { hover: hover, shutdownAll: shutdownAll, detectServers: detectServers };
