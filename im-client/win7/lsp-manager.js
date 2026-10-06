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
const { pathToFileURL, fileURLToPath } = require('url');

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

// 文档 uri 归一 key：Windows 盘符大小写陷阱——pathToFileURL('e:/x') 保持小写 'file:///e:/x'，
// 而 gopls 回显诊断的 uri 统一大写盘符 'file:///E:/x'；缓存 key 不归一则推送写入与查询错位
//（实测踩坑：推送回调正常触发但 getDiagnostics 返回 null）。docs/diags/getDiagnostics 三处统一走此归一。
function uriKey(p) {
    try {
        const s = String(p || '');
        return (s.indexOf('file:') === 0 ? s : pathToFileURL(s).href).toLowerCase();
    } catch (e) { return null; }
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
        diags: new Map(),                  // uri → 归一诊断数组（publishDiagnostics 缓存，tab 切回恢复 markers）
        idleTimer: null, lastUsed: 0
    };
    try {
        // .cmd 垫片（pyright 的 npm 全局安装形态）须经 shell 启动，其余直启防注入
        inst.child = spawn(exe, def.args, {
            cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            shell: /\.cmd$/i.test(exe)
        });
        console.log('[LSP] 启动 ' + kind + ' pid=' + inst.child.pid + ' root=' + root + ' exe=' + exe);
    } catch (e) {
        console.log('[LSP] 启动失败 ' + kind + ': ' + e.message);
        inst.dead = true;
        return null;
    }
    inst.child.on('error', function (err) { killInstance(inst, err.message); });
    inst.child.on('exit', function (code) { killInstance(inst, '退出码 ' + code); });
    // 阶段一百六十四：流错误防护——语言服务器先死后对已关闭管道写入，异步 emit 的 EPIPE error
    // 事件无人监听即顶穿主进程（uncaughtException 反复弹模态错误框、阻塞事件循环，实测浏览区
    // IPC 超时降级"编辑器加载失败"、LSP 功能集体失效）。sendTo 的 try/catch 只能拦同步异常，
    // 三条流须各自挂 error 监听静默吞掉；实例死亡归口 child 'exit' → killInstance 统一收尾，
    // 在途请求以 null 收场由前端回落静态表，行为闭环不变
    inst.child.stdin.on('error', function () { });
    inst.child.stdout.on('error', function () { });
    inst.child.stderr.on('error', function () { });
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
    if (msg.id == null) {
        // 服务端→客户端通知：诊断推送归一缓存并转发（编辑体验闭环——编辑 didChange 后
        // gopls/clangd/pyright 均主动推 publishDiagnostics，此处是前端波浪线数据源）
        if (msg.method === 'textDocument/publishDiagnostics' && msg.params && msg.params.uri) {
            const norm = normDiags(msg.params.diagnostics);
            inst.diags.set(uriKey(String(msg.params.uri)), norm);
            console.log('[LSP] 诊断推送 ' + msg.params.uri + ' 条数=' + norm.length);
            if (diagNotifyFn) {
                try {
                    diagNotifyFn({ filePath: fileURLToPath(String(msg.params.uri)), diags: norm });
                } catch (e) { /* uri 非本地文件/解析失败丢弃 */ }
            }
        }
        return; // 其余通知（window/logMessage 等）静默忽略
    }
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
    console.log('[LSP] 握手就绪 ' + inst.key);
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
    const key = uriKey(uri); // 缓存 key 归一（LSP 消息仍发原样 uri，服务器自行归一）
    const hash = textHash(text);
    const prev = inst.docs.get(key);
    if (!prev) {
        inst.docs.set(key, { version: 1, hash: hash });
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

// ===== 阶段一百六十三：通用实例准备管线（探测→实例→就绪→文档同步）=====
// hover/completion/definition/touchDoc 四能力共用；req = {filePath, text, line, character}（行列零基）。
// 返回 Promise<ctx|null>，ctx = {inst, uri, root, line, character, deadline}；一切异常静默 null。
// noDeadlineWait（touchDoc 专用）：等就绪不受请求预算约束（didOpen 触发分析后即回，诊断异步推送）
function prepare(req, timeoutMs, noDeadlineWait) {
    const p = (req && typeof req === 'object') ? req : {};
    const filePath = String(p.filePath || '');
    if (!filePath) return Promise.resolve(null);
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const map = EXT_MAP[ext];
    if (!map) return Promise.resolve(null); // 非覆盖语言（JS/TS 等走 Monaco 内置）
    const text = String(p.text != null ? p.text : '');
    if (text.length > 512 * 1024) return Promise.resolve(null); // 与查看器 TEXT_MAX 对齐
    const line = parseInt(p.line, 10) || 0;
    const character = parseInt(p.character, 10) || 0;
    const deadline = Date.now() + timeoutMs;
    return detectServers().then(function (found) {
        const exe = found[map.kind];
        if (!exe) return null; // 本机未安装该语言服务器 → 前端兜底
        const root = findRoot(map.kind, filePath);
        const key = map.kind + '|' + root;
        let inst = instances.get(key);
        if (!inst) {
            inst = startInstance(map.kind, root, exe);
            if (!inst || inst.dead) return null;
            instances.set(key, inst);
        }
        if (inst.dead) { console.log('[LSP] prepare 失败(实例已死) ' + key); return null; }
        inst.lastUsed = Date.now();
        if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }

        // 等握手就绪后同步文档（didOpen/didChange）；deadline 一并计入等待（冷启动期
        // 请求型调用在预算耗尽即返回 null，不会拖到 ready 后再发废请求——实测首击 6.7s 才回 null 的根因）
        const waitReady = inst.ready ? Promise.resolve() : new Promise(function (resolve) {
            const t = setInterval(function () {
                if (inst.ready || inst.dead || (!noDeadlineWait && Date.now() >= deadline)) { clearInterval(t); resolve(); }
            }, 25);
        });
        return waitReady.then(function () {
            if (inst.dead || !inst.ready) { console.log('[LSP] prepare 失败(未就绪) ' + key + ' dead=' + inst.dead); return null; }
            if (!noDeadlineWait && Date.now() >= deadline) { console.log('[LSP] prepare 失败(预算耗尽 ' + timeoutMs + 'ms) ' + filePath); return null; }
            const uri = syncDoc(inst, filePath, text, map.langId);
            if (!uri) { console.log('[LSP] prepare 失败(文档同步失败) ' + filePath); return null; }
            return { inst: inst, uri: uri, root: root, filePath: filePath, line: line, character: character, deadline: deadline };
        });
    }).catch(function () { return null; });
}

// ===== 阶段一百六十三：通用 LSP 请求（竞速超时：超时后请求作废，晚到结果丢弃）=====
function requestLsp(ctx, method, params) {
    return new Promise(function (resolve) {
        const inst = ctx.inst;
        if (Date.now() >= ctx.deadline) { console.log('[LSP] 请求未发(预算已尽) ' + method + ' @' + ctx.filePath + ':' + ctx.line + ':' + ctx.character); resolve(null); return; } // prepare 已耗尽预算：不再发废请求
        const id = nextReqId++;
        inst.pending.set(id, { resolve: resolve });
        sendTo(inst, { jsonrpc: '2.0', id: id, method: method, params: params });
        setTimeout(function () {
            if (inst.pending.delete(id)) { console.log('[LSP] 请求超时 ' + method + ' @' + ctx.filePath + ':' + ctx.line + ':' + ctx.character); resolve(null); }
        }, Math.max(50, ctx.deadline - Date.now()));
    });
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

// hover 悬停（阶段一百三十）：800ms 竞速，命中返回 {markdown, range}，否则 null
function hover(req) {
    return prepare(req, 800).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/hover', {
            textDocument: { uri: ctx.uri },
            position: { line: ctx.line, character: ctx.character }
        }).then(formatHover);
    }).catch(function () { return null; });
}

// ===== 阶段一百六十三：补全（textDocument/completion）=====
// 返回 {items: [{label, kind(LSP 1-25), detail, insertText, sortText, documentation}]} | null；
// kind 保持 LSP 原值由前端映射 Monaco CompletionKind（主进程不依赖 Monaco）
function completion(req) {
    return prepare(req, 800).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/completion', {
            textDocument: { uri: ctx.uri },
            position: { line: ctx.line, character: ctx.character }
        }).then(function (result) {
            const raw = result ? (Array.isArray(result) ? result : (result.items || [])) : [];
            if (!raw.length) { console.log('[LSP] completion gopls 答空 @' + ctx.filePath + ':' + ctx.line + ':' + ctx.character); return null; }
            const items = [];
            for (let i = 0; i < raw.length && items.length < 300; i++) { // 上限 300：防超大成员列表卡 UI
                const it = raw[i] || {};
                const label = String(it.label || '').trim();
                if (!label) continue;
                items.push({
                    label: label,
                    kind: parseInt(it.kind, 10) || 0,
                    detail: String(it.detail || ''),
                    insertText: String(it.insertText || it.label || label),
                    sortText: String(it.sortText || ''),
                    documentation: it.documentation
                        ? (typeof it.documentation === 'string' ? it.documentation : String((it.documentation && it.documentation.value) || ''))
                        : ''
                });
            }
            return items.length ? { items: items } : null;
        });
    }).catch(function () { return null; });
}

// ===== 阶段一百六十三：跳转定义（textDocument/definition）=====
// 归一为 [{path(绝对), rel(相对工作区根；跨盘/外部路径为空串), line, column}(1 基行列)] | null；
// rel 供渲染层归口打开（browserOpenFile 收工作区相对路径），跨盘场景 rel 为空由前端忽略
function definition(req) {
    return prepare(req, 2000).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/definition', {
            textDocument: { uri: ctx.uri },
            position: { line: ctx.line, character: ctx.character }
        }).then(function (result) {
            if (!result) { console.log('[LSP] definition gopls 答空 @' + ctx.filePath + ':' + ctx.line + ':' + ctx.character); return null; }
            const locs = Array.isArray(result) ? result : [result];
            const out = [];
            for (let i = 0; i < locs.length && out.length < 20; i++) {
                const loc = locs[i];
                if (!loc || !loc.uri || !loc.range) continue;
                let abs = '';
                try { abs = fileURLToPath(String(loc.uri)); } catch (e) { continue; }
                let rel = '';
                try {
                    rel = path.relative(ctx.root, abs).replace(/\\/g, '/');
                    // 工作区外两类形态都归空：'..' 开头（上层目录）与跨盘结果仍是绝对路径
                    //（Windows path.relative('e:\x','c:\y') 返回绝对路径 'c:\y'——实测踩坑：GOROOT 跳转漏过滤）
                    if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) rel = '';
                } catch (e) { rel = ''; }
                const s = loc.range.start || {};
                out.push({ path: abs, rel: rel, line: (parseInt(s.line, 10) || 0) + 1, column: (parseInt(s.character, 10) || 0) + 1 });
            }
            return out.length ? out : null;
        });
    }).catch(function () { return null; });
}

// ===== 阶段一百六十四：格式化/快速修复/查找引用/重命名/文档符号（TRAE 同款 LSP 增强五件套）=====

// TextEdit 归一（LSP 零基行列 → 1 基；前端直接转 Monaco Range 应用）
function normTextEdit(t) {
    if (!t || !t.range) return null;
    const s = t.range.start || {}, e = t.range.end || s;
    return {
        line: (parseInt(s.line, 10) || 0) + 1,
        character: (parseInt(s.character, 10) || 0) + 1,
        endLine: (parseInt(e.line, 10) || 0) + 1,
        endCharacter: (parseInt(e.character, 10) || 0) + 1,
        newText: String(t.newText || '')
    };
}

// Location 归一（与 definition 同构：绝对路径 + 工作区相对路径；跨盘/上层目录 rel 归空）
function normLoc(root, loc) {
    if (!loc || !loc.uri || !loc.range) return null;
    let abs = '';
    try { abs = fileURLToPath(String(loc.uri)); } catch (e) { return null; }
    let rel = '';
    try {
        rel = path.relative(root, abs).replace(/\\/g, '/');
        // 工作区外两类形态都归空：'..' 开头（上层目录）与跨盘结果仍是绝对路径（Windows 踩坑同 definition）
        if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) rel = '';
    } catch (e) { rel = ''; }
    const s = loc.range.start || {};
    return { path: abs, rel: rel, line: (parseInt(s.line, 10) || 0) + 1, column: (parseInt(s.character, 10) || 0) + 1 };
}

// 格式化（Shift+Alt+F）：gopls/clangd/pyright 全支持；返回 [{line,character,endLine,endCharacter,newText}]
function formatting(req) {
    return prepare(req, 3000).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/formatting', {
            textDocument: { uri: ctx.uri },
            options: { tabSize: 4, insertSpaces: true }
        }).then(function (result) {
            if (!Array.isArray(result)) return null;
            const out = [];
            for (let i = 0; i < result.length && out.length < 2000; i++) {
                const t = normTextEdit(result[i]);
                if (t && t.newText) out.push(t);
            }
            return out.length ? out : null;
        });
    }).catch(function () { return null; });
}

// 快速修复（Ctrl+. 灯泡）：只取携带 WorkspaceEdit 的项（gopls organize imports 等 command 型
// 需 executeCommand 二次往返，未实现故丢弃）；跨文件 edits 由前端过滤；上下限 20
function codeAction(req) {
    const p = (req && typeof req === 'object') ? req : {};
    const range = p.range || {};
    const context = {
        // 前端传 1 基诊断（markers 同源），LSP 上下文要求零基——此处回转
        diagnostics: (Array.isArray(p.diagnostics) ? p.diagnostics : []).slice(0, 50).map(function (d) {
            const ln = (parseInt(d.line, 10) || 1) - 1, col = (parseInt(d.character, 10) || 1) - 1;
            return {
                range: {
                    start: { line: ln, character: col },
                    end: { line: (parseInt(d.endLine, 10) || ln + 1) - 1, character: (parseInt(d.endCharacter, 10) || col + 1) - 1 }
                },
                message: String(d.message || ''),
                severity: parseInt(d.severity, 10) || 1
            };
        }),
        only: ['quickfix']
    };
    return prepare(req, 1500).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/codeAction', {
            textDocument: { uri: ctx.uri },
            range: {
                start: { line: (parseInt(range.startLine, 10) || 1) - 1, character: (parseInt(range.startColumn, 10) || 1) - 1 },
                end: { line: (parseInt(range.endLine, 10) || 1) - 1, character: (parseInt(range.endColumn, 10) || 1) - 1 }
            },
            context: context
        }).then(function (result) {
            if (!Array.isArray(result)) return null;
            const out = [];
            for (let i = 0; i < result.length && out.length < 20; i++) {
                const a = result[i] || {};
                const changes = (a.edit && a.edit.changes) || {};
                const edits = [];
                Object.keys(changes).forEach(function (k) {
                    const arr = changes[k] || [];
                    // 阶段一百六十四补：uri → path/rel 归一（与 rename 同构），前端按 rel 过滤跨文件修复
                    let abs = '', rel = '';
                    try {
                        abs = fileURLToPath(String(k));
                        rel = path.relative(ctx.root, abs).replace(/\\/g, '/');
                        if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) rel = '';
                    } catch (e) { return; }
                    for (let j = 0; j < arr.length; j++) {
                        const t = normTextEdit(arr[j]);
                        if (t) { t.path = abs; t.rel = rel; edits.push(t); }
                    }
                });
                const title = String(a.title || '').trim();
                if (!title || !edits.length) continue;
                out.push({ title: title, kind: String(a.kind || 'quickfix'), edits: edits });
            }
            return out.length ? out : null;
        });
    }).catch(function () { return null; });
}

// 查找引用（Shift+F12）：含声明本身；上限 50（超大引用集截断，前端列表展示）
function references(req) {
    return prepare(req, 2000).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/references', {
            textDocument: { uri: ctx.uri },
            position: { line: ctx.line, character: ctx.character },
            context: { includeDeclaration: true }
        }).then(function (result) {
            if (!Array.isArray(result)) return null;
            const out = [];
            for (let i = 0; i < result.length && out.length < 50; i++) {
                const n = normLoc(ctx.root, result[i]);
                if (n) out.push(n);
            }
            return out.length ? out : null;
        });
    }).catch(function () { return null; });
}

// 重命名符号（F2）：WorkspaceEdit changes / documentChanges 两形态兼容（pyright 用后者）；
// 归一为 {edits:[{path, rel, line, character, endLine, endCharacter, newText}]}，上限 500
function rename(req) {
    const p = (req && typeof req === 'object') ? req : {};
    const newName = String(p.newName || '').trim();
    if (!newName || newName.length > 200) return Promise.resolve(null);
    return prepare(p, 2500).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/rename', {
            textDocument: { uri: ctx.uri },
            position: { line: ctx.line, character: ctx.character },
            newName: newName
        }).then(function (result) {
            if (!result) return null;
            const raw = [];
            const changes = result.changes || {};
            Object.keys(changes).forEach(function (uri) {
                const arr = changes[uri] || [];
                for (let j = 0; j < arr.length; j++) raw.push({ uri: uri, t: arr[j] });
            });
            if (Array.isArray(result.documentChanges)) {
                result.documentChanges.forEach(function (dc) {
                    if (!dc || !dc.textDocument || !Array.isArray(dc.edits)) return;
                    dc.edits.forEach(function (t) { raw.push({ uri: dc.textDocument.uri, t: t }); });
                });
            }
            const out = [];
            for (let i = 0; i < raw.length && out.length < 500; i++) {
                let abs = '';
                try { abs = fileURLToPath(String(raw[i].uri)); } catch (e) { continue; }
                const t = normTextEdit(raw[i].t);
                if (!t) continue;
                let rel = '';
                try {
                    rel = path.relative(ctx.root, abs).replace(/\\/g, '/');
                    if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) rel = '';
                } catch (e) { rel = ''; }
                t.path = abs; t.rel = rel;
                out.push(t);
            }
            return out.length ? { edits: out } : null;
        });
    }).catch(function () { return null; });
}

// 文件内符号（Ctrl+Shift+O 快速跳转）：DocumentSymbol 树递归展平（children 前缀拼接 A.B）
// 与 SymbolInformation（location 字段）两形态兼容；上限 300
function documentSymbol(req) {
    return prepare(req, 1500).then(function (ctx) {
        if (!ctx) return null;
        return requestLsp(ctx, 'textDocument/documentSymbol', {
            textDocument: { uri: ctx.uri }
        }).then(function (result) {
            if (!Array.isArray(result)) return null;
            const out = [];
            const walk = function (list, prefix, depth) {
                for (let i = 0; i < list.length && out.length < 300; i++) {
                    const s = list[i] || {};
                    if (!s.name) continue;
                    let line = 0, endLine = 0;
                    if (s.location && s.location.range) { // SymbolInformation
                        line = (parseInt(s.location.range.start.line, 10) || 0) + 1;
                        endLine = (parseInt(s.location.range.end.line, 10) || 0) + 1;
                    } else if (s.range) { // DocumentSymbol
                        line = (parseInt(s.range.start.line, 10) || 0) + 1;
                        endLine = (parseInt(s.range.end.line, 10) || 0) + 1;
                    } else continue;
                    const nm = String(s.name);
                    out.push({
                        name: nm,
                        kind: parseInt(s.kind, 10) || 0,
                        line: line,
                        column: (parseInt((s.location && s.location.range ? s.location.range.start : s.range.start).character, 10) || 0) + 1,
                        endLine: endLine,
                        container: prefix
                    });
                    if (Array.isArray(s.children) && s.children.length && depth < 5) {
                        walk(s.children, prefix ? (prefix + '.' + nm) : nm, depth + 1);
                    }
                }
            };
            walk(result, '', 0);
            return out.length ? out : null;
        });
    }).catch(function () { return null; });
}

// ===== 阶段一百六十三：诊断（publishDiagnostics 推送监听 + 缓存查询）=====
// 诊断归一（LSP 零基行列 → 1 基；severity 1=Error 2=Warning 3=Info 4=Hint）
function normDiags(issues) {
    return (issues || []).map(function (d) {
        const r = d.range || {};
        const s = r.start || {};
        const e = r.end || s;
        return {
            severity: parseInt(d.severity, 10) || 3,
            message: String(d.message || ''),
            line: (parseInt(s.line, 10) || 0) + 1,
            character: (parseInt(s.character, 10) || 0) + 1,
            endLine: (parseInt(e.line, 10) || 0) + 1,
            endCharacter: (parseInt(e.character, 10) || 0) + 1,
            source: String(d.source || ''),
            code: d.code != null ? String(d.code) : ''
        };
    });
}

// 诊断推送回调注入（main.js 启动时注入 → browser-manager 按 tab 归口转发渲染层）
let diagNotifyFn = null;
function setNotifyFn(fn) { diagNotifyFn = (typeof fn === 'function') ? fn : null; }

// 诊断缓存查询（filePath 为本地绝对路径；未同步过/无缓存返回 null——
// 调用场景为 tab 切回恢复 markers，正常链路靠推送实时更新）
function getDiagnostics(filePath) {
    const uri = uriKey(filePath); // 归一 key 与写入侧一致（Windows 盘符大小写）
    if (!uri) return null;
    let found = null;
    instances.forEach(function (inst) {
        if (found || !inst.diags) return;
        if (inst.docs.has(uri) && inst.diags.has(uri)) found = inst.diags.get(uri);
    });
    return found;
}

// touchDoc 文档同步钩子（不发请求）：编辑防抖后调用——didChange 到达后 gopls/clangd/pyright
// 自动推 publishDiagnostics，经通知链路实时更新前端波浪线；也承担 didOpen 首分析触发。
// 30s + 不受请求预算约束：冷启动期等就绪后 didOpen 仍会发出（诊断推送异步到达）
function touchDoc(req) {
    return prepare(req, 30000, true).then(function (ctx) { return ctx ? { ok: true } : { ok: false }; });
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

module.exports = {
    hover: hover,
    completion: completion,       // 阶段一百六十三：LSP 补全
    definition: definition,       // 阶段一百六十三：跳转定义
    formatting: formatting,       // 阶段一百六十四：格式化
    codeAction: codeAction,       // 阶段一百六十四：快速修复
    references: references,       // 阶段一百六十四：查找引用
    rename: rename,               // 阶段一百六十四：重命名符号
    documentSymbol: documentSymbol, // 阶段一百六十四：文件内符号
    touchDoc: touchDoc,           // 阶段一百六十三：文档同步钩子（触发诊断推送）
    getDiagnostics: getDiagnostics, // 阶段一百六十三：诊断缓存查询
    setNotifyFn: setNotifyFn,     // 阶段一百六十三：诊断推送回调注入
    shutdownAll: shutdownAll,
    detectServers: detectServers
};
