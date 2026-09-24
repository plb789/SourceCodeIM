// debug-manager.js — 阶段一百六十一：浏览区断点调试（TRAE CN 同款，Python DAP + Node V8 Inspector 直连 + C/C++ GDB）
//
// 架构（VS Code 同构）：file-viewer.html（Monaco UI）→ ipcRenderer ⇄ ipcMain（main.js 注册）
// → 本模块（调试客户端 + 会话生命周期 + 语言路由）→ 被调试进程。
// Python：DAP 协议（Content-Length JSON 帧）→ debugpy --listen（TCP）。
// Node.js：V8 Inspector 直连（CDP over WebSocket，spawn --inspect-brk 自持目标进程，零适配器进程；
//          实测 js-debug 1.117 独立服务对 Node 24 --inspect-brk attach 死锁——现代 Node 已不再自动
//          发 "Break on start"，须由调试端发 Runtime.runIfWaitingForDebugger，js-debug 该路径未发，
//          故弃用适配器直连 Inspector，见 startNode）。
// C/C++：cdt-gdb-adapter（stdio DAP，探针 probe_c.js 实测语义）→ 本机 gdb（内置工具链
//          ~/.im-mcp/gcc/bin 自带 gdb 17.2；源文件先 gcc -g -O0 编译为 *_debug.exe 再调试，
//          编译输出实时透传输出面板；configurationDone 触发 -exec-run，exited-normally → terminated）。
//
// 安全边界：调试目标路径只认 {tab_id + relPath}——tab 信息由 browser-manager.findFileTabInfo
// 归口，绝对路径经注入的 pathGuard（agentExecutor.safePath）解析，渲染层全程不持有绝对路径。
// 单会话（同 TRAE 简化）：再次 start 自动停掉旧会话。事件经注入的 onEvent 推送渲染层
// （webContents.send('debug:event')，同 browser:state 推送模式），DAP 事件驱动无轮询。

const { app } = require('electron');
const net = require('net');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn, execFile } = require('child_process');

let pathGuard = null;   // main.js 注入 agentExecutor.safePath：{full, ws} | {err}
let agentEnv = null;    // main.js 注入 agentExecutor.buildAgentEnv（PATH 前置工具链：uv/node/gcc）
let onEventFn = null;   // main.js 注入：(payload) => mainWindow.webContents.send('debug:event', payload)
let toolchainFn = null; // main.js 注入 toolchainManager.ensureGcc（gcc/gdb 缺失时一键引导内置工具链）

function setPathGuard(fn) { pathGuard = typeof fn === 'function' ? fn : null; }
function setAgentEnvFn(fn) { agentEnv = typeof fn === 'function' ? fn : null; }
function setEventSink(fn) { onEventFn = typeof fn === 'function' ? fn : null; }
function setToolchainFn(fn) { toolchainFn = typeof fn === 'function' ? fn : null; }
function pushEvent(payload) {
    if (onEventFn) { try { onEventFn(payload); } catch (e) { /* 渲染层未就绪忽略 */ } }
}

// ===== 会话状态（单会话） =====
// status: '' | 'starting' | 'running' | 'paused' | 'ended'
let session = null;

function isActive() { return !!session && session.status !== 'ended'; }

// ===== 断点持久化（userData/debug_breakpoints.json：absPath(小写) → [{line, condition?, logMessage?}]） =====
// 阶段一百六十四：支持条件断点/日志点——持久化存对象数组；旧版 number[] 读取时兼容归一
function bpFile() {
    try { return path.join(app.getPath('userData'), 'debug_breakpoints.json'); } catch (e) { return null; }
}
function bpLoadAll() {
    const f = bpFile();
    if (!f) return {};
    try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}
function bpSaveAll(store) {
    const f = bpFile();
    if (!f) return;
    try { fs.writeFileSync(f, JSON.stringify(store)); } catch (e) { /* 只读盘静默 */ }
}
// 输入归一：number 行号或 {line, condition?, logMessage?} 对象 → 干净对象数组（行号去零去重）
function normBpLines(lines) {
    const seen = {};
    const out = [];
    (lines || []).forEach(function (it) {
        const obj = (it && typeof it === 'object') ? it : { line: it };
        const l = parseInt(obj.line, 10) || 0;
        if (l <= 0 || seen[l]) return;
        seen[l] = 1;
        const rec = { line: l };
        const cond = String(obj.condition || '').trim();
        const log = String(obj.logMessage || '').trim();
        if (cond) rec.condition = cond.substring(0, 500);
        if (log) rec.logMessage = log.substring(0, 500);
        out.push(rec);
    });
    return out;
}
function bpSet(abs, bps) {
    const store = bpLoadAll();
    const key = String(abs || '').toLowerCase();
    if (!key) return;
    const clean = normBpLines(bps);
    if (clean.length) store[key] = clean;
    else delete store[key];
    bpSaveAll(store);
}
function bpGet(abs) {
    const store = bpLoadAll();
    // 旧格式（number[]）读取兼容归一为对象数组
    return normBpLines(store[String(abs || '').toLowerCase()] || []);
}
// 持久化对象数组 → DAP setBreakpoints 参数（condition/logMessage 透传；无则省略字段）
function toDapBps(bps) {
    return (bps || []).map(function (bp) {
        const d = { line: bp.line };
        if (bp.condition) d.condition = bp.condition;
        if (bp.logMessage) d.logMessage = bp.logMessage;
        return d;
    });
}
// verified 行号校准：适配器回推真实行号后按行号回填元数据（condition/logMessage 不丢；
// 无一命中时维持原数组，防误清）
function reverifyBps(bps, verifiedLines) {
    const set = {};
    (verifiedLines || []).forEach(function (l) { set[parseInt(l, 10)] = 1; });
    const kept = (bps || []).filter(function (bp) { return set[bp.line]; });
    return kept.length ? kept : bps;
}
function bpLineNums(bps) { return (bps || []).map(function (bp) { return bp.line; }); }

// ===== DAP 客户端（精简实现，覆盖调试闭环所需 ~15 种消息） =====
function DapClient() {
    this.seq = 1;               // 请求序号
    this.pending = new Map();   // request_seq → {resolve, reject, timer}
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.onEvent = null;        // (event, body) => void
    this.onClose = null;        // () => void
}
DapClient.prototype.connect = function (port, host) {
    const self = this;
    return new Promise(function (resolve, reject) {
        const sock = net.connect(port, host || '127.0.0.1', function () {
            resolve();
        });
        sock.setNoDelay(true);
        sock.on('data', function (d) { self._data(d); });
        sock.on('error', function (e) { self._close(); reject(e); });
        sock.on('close', function () { self._close(); });
        self.sock = sock;
    });
};
DapClient.prototype.connectStdio = function (child) {
    // stdio 传输（C/C++ cdt-gdb-adapter）：帧协议与 TCP 同构，读写直接挂在子进程管道上
    const self = this;
    try { child.stdin.on('error', function () { /* 适配器先死：EPIPE 由 request() 的 try/catch 兜底 */ }); } catch (e) {}
    child.stdout.on('data', function (d) { self._data(d); });
    child.on('error', function () { self._close(); });
    child.on('exit', function () { self._close(); });
    self.proc = child;
    // sock 仿真：request() 统一走 sock.write，stopInternal 统一走 sock.destroy
    self.sock = {
        write: function (frame) { child.stdin.write(frame); },
        destroy: function () {
            try { child.stdin.end(); } catch (e) { /* 已关闭 */ }
            killTree(child.pid); // taskkill /T 连带 gdb 子进程一起回收，防孤儿
        }
    };
    return Promise.resolve();
};
DapClient.prototype._close = function () {
    const self = this;
    if (!self.sock) return;
    self.sock = null;
    self.pending.forEach(function (p) { try { p.reject(new Error('DAP 连接已断开')); } catch (e) {} });
    self.pending.clear();
    if (self.onClose) { try { self.onClose(); } catch (e) {} }
};
DapClient.prototype._data = function (d) {
    const self = this;
    self.buf = self.buf.length ? Buffer.concat([self.buf, d]) : d;
    for (;;) {
        const headEnd = self.buf.indexOf('\r\n\r\n');
        if (headEnd < 0) return;
        const head = self.buf.slice(0, headEnd).toString('utf8');
        const m = /Content-Length:\s*(\d+)/i.exec(head);
        if (!m) { self.buf = Buffer.alloc(0); return; }
        const len = parseInt(m[1], 10);
        if (self.buf.length < headEnd + 4 + len) return;
        const body = self.buf.slice(headEnd + 4, headEnd + 4 + len).toString('utf8');
        self.buf = self.buf.slice(headEnd + 4 + len);
        let msg = null;
        try { msg = JSON.parse(body); } catch (e) { continue; }
        if (msg.type === 'response') {
            const p = self.pending.get(msg.request_seq);
            if (p) {
                self.pending.delete(msg.request_seq);
                clearTimeout(p.timer);
                if (msg.success) p.resolve(msg.body || {});
                else p.reject(new Error(msg.message || ('请求失败：' + msg.command)));
            }
        } else if (msg.type === 'event') {
            if (self.onEvent) { try { self.onEvent(msg.event, msg.body || {}); } catch (e) {} }
        }
        // request（适配器反呼，如 runInTerminal）阶段内未启用，忽略
    }
};
DapClient.prototype.request = function (command, args, timeoutMs) {
    const self = this;
    if (!self.sock) return Promise.reject(new Error('DAP 未连接'));
    const seq = self.seq++;
    const frame = JSON.stringify({ seq: seq, type: 'request', command: command, arguments: args || {} });
    const head = 'Content-Length: ' + Buffer.byteLength(frame, 'utf8') + '\r\n\r\n';
    return new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
            self.pending.delete(seq);
            reject(new Error('DAP 请求超时：' + command));
        }, timeoutMs || 10000);
        self.pending.set(seq, { resolve: resolve, reject: reject, timer: timer });
        try { self.sock.write(head + frame); } catch (e) {
            clearTimeout(timer);
            self.pending.delete(seq);
            reject(e);
        }
    });
};
DapClient.prototype.destroy = function () {
    if (this.sock) { try { this.sock.destroy(); } catch (e) {} }
    this._close();
};

// ===== 工具 =====
function pickPort() {
    return new Promise(function (resolve, reject) {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', function () {
            const port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
        srv.on('error', reject);
    });
}
function killTree(pid) {
    if (!pid) return;
    try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { /* 进程可能已退出 */ }
}
function runProbe(cmd, args, timeoutMs) {
    // 探测/引导命令执行：捕获 stdout+stderr，限时强杀（防 Store 占位符 python 挂起）
    return new Promise(function (resolve) {
        let out = '';
        let child = null;
        try {
            child = spawn(cmd, args, {
                cwd: (agentEnv ? agentEnv().INIT_CWD : undefined) || undefined,
                env: agentEnv ? agentEnv() : process.env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (e) { resolve({ ok: false, output: String(e.message || e) }); return; }
        const timer = setTimeout(function () { try { killTree(child.pid); } catch (e) {} }, timeoutMs || 8000);
        const feed = function (d) { out += d.toString('utf8'); };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', function (e) {
            clearTimeout(timer);
            resolve({ ok: false, output: out + String(e.message || e) });
        });
        child.on('close', function (code) {
            clearTimeout(timer);
            resolve({ ok: code === 0, code: code, output: out });
        });
    });
}

// ===== Python 解析与引导（用户本机常见 Py2/Store 占位符，须逐级校验真实 Py3+debugpy） =====
// 优先级：调试专用 venv → 系统探测（py -3/python3/python）→ bootstrap（venv/pip）生成专用 venv
function venvPython() {
    try { return path.join(app.getPath('userData'), 'debug_venv', 'Scripts', 'python.exe'); } catch (e) { return ''; }
}
function probePy(cmd, args) {
    // 版本 ≥3.7 且 import debugpy 成功才算可用；返回 {ok, python, err}
    return runProbe(cmd, args.concat(['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])']), 8000)
        .then(function (r) {
            if (!r.ok) return { ok: false, err: '不可用' };
            const v = (r.output || '').trim().split('\n').pop().trim();
            const mj = parseInt(v.split('.')[0], 10), mn = parseInt((v.split('.')[1] || '0'), 10);
            if (!(mj > 3 || (mj === 3 && mn >= 7))) return { ok: false, err: '版本过低（' + v + '，需 Python 3.7+）' };
            return runProbe(cmd, args.concat(['-c', 'import debugpy;print(debugpy.__version__)']), 8000)
                .then(function (r2) {
                    if (!r2.ok) return { ok: false, err: '未安装 debugpy', version: v };
                    return { ok: true, python: cmd, args: args, version: v, debugpy: (r2.output || '').trim().split('\n').pop().trim() };
                });
        });
}
function resolvePython() {
    // 1) 专用 venv（bootstrap 产物，最可靠）
    const vp = venvPython();
    if (vp && fs.existsSync(vp)) {
        return probePy(vp, []).then(function (r) {
            if (r.ok) return r;
            return resolveSystemPython();
        });
    }
    return resolveSystemPython();
}
function resolveSystemPython() {
    const cands = [
        { cmd: 'py', args: ['-3'] },
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] }
    ];
    let chain = Promise.resolve(null);
    let lastNoDebugpy = null;
    cands.forEach(function (c) {
        chain = chain.then(function (found) {
            if (found) return found;
            return probePy(c.cmd, c.args).then(function (r) {
                if (r.ok) return r;
                if (r.version && !r.debugpy) lastNoDebugpy = { cmd: c.cmd, args: c.args, version: r.version };
                return null;
            });
        });
    });
    return chain.then(function (found) {
        if (found) return found;
        // uv 托管 Python 兜底（.im-mcp/bin/uv.exe 随客户端分发）：找已装的 3.8+，有则校验 debugpy
        return runProbe('uv', ['python', 'find'], 8000).then(function (r) {
            const p = (r.output || '').trim().split('\n').pop().trim();
            if (r.ok && p && p.toLowerCase().indexOf('python') >= 0 && fs.existsSync(p)) {
                return probePy(p, []).then(function (r2) {
                    if (r2.ok) return r2;
                    if (r2.version && !r2.debugpy) lastNoDebugpy = { cmd: p, args: [], version: r2.version };
                    return { ok: false, noDebugpy: lastNoDebugpy, err: '未安装 debugpy' };
                });
            }
            return { ok: false, noDebugpy: lastNoDebugpy, err: '未找到可用的 Python 3' };
        });
    });
}

// bootstrap 一键引导（UI 按钮触发）：生成专用 venv 并装 debugpy。
// 有真实 Py3 → venv + pip；只有 uv → uv venv（自动下载 Python 3.12）+ uv pip。
// 进度经 pushEvent 推控制台，前端实时可见（用户要求长命令必须有实时反馈）
function bootstrapPython(evTabId) {
    const tabId = String(evTabId || ''); // 进度事件归口到发起页签（chat.js/独立窗口按 tab_id 转发渲染）
    const vp = venvPython();
    if (!vp) return Promise.resolve({ ok: false, error: '无法确定用户数据目录' });
    if (fs.existsSync(vp)) { // 已存在：直接校验，缺 debugpy 则补装
        return ensureDebugpyInVenv(tabId);
    }
    const venvRoot = path.dirname(path.dirname(vp));
    const say = function (t) { pushEvent({ tab_id: tabId, type: 'output', category: 'stderr', text: t }); };
    // 优先系统 Py3（干净不下载）；无系统 Py3 再用 uv 托管下载（约 30MB，进度走 uv 输出）
    return probePy('py', ['-3']).then(function (r) { return r.ok ? r : probePy('python3', []).then(function (r2) { return r2.ok ? r2 : probePy('python', []).then(function (r3) { return r3.ok ? r3 : null; }); }); })
        .then(function (sys) {
            if (sys) {
                say('正在创建调试环境（' + sys.cmd + ' venv）…\n');
                return runProbe(sys.cmd, sys.args.concat(['-m', 'venv', venvRoot]), 120000).then(function (r) {
                    if (!r.ok) { say('venv 创建失败：' + r.output + '\n'); return { ok: false, error: 'venv 创建失败' }; }
                    return ensureDebugpyInVenv(tabId);
                });
            }
            say('未检测到 Python 3，正在通过 uv 安装托管 Python 3.12（约 30MB，视网速 1-2 分钟）…\n');
            return runProbe('uv', ['venv', venvRoot, '--python', '3.12'], 300000).then(function (r) {
                if (!r.ok) { say('uv venv 失败：' + r.output + '\n'); return { ok: false, error: 'uv venv 失败：' + (r.output || '').slice(-200) }; }
                return ensureDebugpyInVenv(tabId);
            });
        });
}
function ensureDebugpyInVenv(evTabId) {
    const vp = venvPython();
    if (!vp || !fs.existsSync(vp)) return Promise.resolve({ ok: false, error: '调试环境未就绪' });
    const say = function (t) { pushEvent({ tab_id: String(evTabId || ''), type: 'output', category: 'stderr', text: t }); };
    // 装 debugpy：venv 自带 pip 则 pip 装；uv venv 创建的环境不带 pip，回退 uv pip --python（uv 随客户端分发，走 agentEnv PATH）
    function installDebugpy() {
        return runProbe(vp, ['-m', 'pip', 'install', 'debugpy'], 300000).then(function (r2) {
            if (r2.ok) return { ok: true };
            return runProbe('uv', ['pip', 'install', '--python', vp, 'debugpy'], 300000).then(function (r3) {
                if (r3.ok) return { ok: true };
                say('默认源安装失败，尝试清华镜像重试…\n');
                return runProbe('uv', ['pip', 'install', '--python', vp, 'debugpy',
                    '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple'], 300000).then(function (r4) {
                    if (r4.ok) return { ok: true };
                    return { ok: false, output: (r4.output || r3.output || r2.output || '').slice(-400) };
                });
            });
        });
    }
    return probePy(vp, []).then(function (r) {
        if (r.ok) { say('调试环境已就绪（Python ' + r.version + ' + debugpy ' + r.debugpy + '）\n'); return { ok: true }; }
        if (r.version) { // venv 在但缺 debugpy：补装
            say('正在安装 debugpy（首次约 10MB）…\n');
            return installDebugpy().then(function (ir) {
                if (!ir.ok) { say('debugpy 安装失败：' + (ir.output || '') + '\n'); return { ok: false, error: 'debugpy 安装失败' }; }
                say('debugpy 安装完成\n');
                return { ok: true };
            });
        }
        return { ok: false, error: r.err || '调试环境不可用' };
    });
}

// ===== 语言路由（按扩展名；Python→debugpy，Node→V8 Inspector 直连，C/C++→cdt-gdb-adapter，Go→dlv dap） =====
function langOfExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'py' || e === 'pyw') return 'python';
    // .ts 依赖 Node 22.6+ 原生类型剥离（本机 Node 24 可直接跑，低版本 Node 会报错并显示在输出面板）
    if (e === 'js' || e === 'mjs' || e === 'cjs' || e === 'ts') return 'node';
    // C/C++：源文件先编译（gcc -g）再调试；h/hpp 头文件无独立编译语义不支持
    if (e === 'c' || e === 'cpp' || e === 'cc' || e === 'cxx') return 'cpp';
    // Go：dlv dap（stdio DAP），delve 自管编译（program 所在包，go.mod 定位）
    if (e === 'go') return 'go';
    return '';
}

// ===== 启动会话 =====
// req = {tab_id, username, relPath}（main.js 归口传入：tab 信息 + pathGuard 解析后的绝对路径不在渲染层出现）
function start(req) {
    const tabId = String((req && req.tab_id) || '');
    const username = String((req && req.username) || '');
    const relPath = String((req && req.relPath) || '');
    if (!tabId || !username || !relPath) return Promise.resolve({ ok: false, error: '参数缺失' });
    if (!pathGuard) return Promise.resolve({ ok: false, error: '路径校验未就绪' });
    const g = pathGuard(username, relPath);
    if (g.err) return Promise.resolve({ ok: false, error: '路径被拒绝：' + g.err });
    const abs = g.full;
    const cwd = g.ws;
    const ext = path.extname(abs).replace('.', '');
    const lang = langOfExt(ext);
    if (!lang) return Promise.resolve({ ok: false, error: '暂不支持调试 .' + ext + ' 文件（当前支持 .py / .js / .ts / .mjs / .cjs / .c / .cpp / .cc / .cxx / .go）' });
    if (!fs.existsSync(abs)) return Promise.resolve({ ok: false, error: '文件不存在，请先保存' });

    if (session) { try { stopInternal(session); } catch (e) {} session = null; }

    const sess = {
        tab_id: tabId, username: username, relPath: relPath, abs: abs, cwd: cwd, lang: lang,
        status: 'starting', threadId: 0, frameId: 0,
        dap: null, child: null, port: 0,
        // Node Inspector 会话态（lang==='node' 时启用）
        insp: false, ws: null, msgSeq: 0, msgWait: new Map(),
        scripts: new Map(),          // scriptId → url（栈帧文件名归口）
        varReg: new Map(), varSeq: 1,// 悬停/变量树 objectId 注册表（每次暂停重置，objectId 随恢复失效）
        nodeBps: new Map(),          // breakpointId → {line}（当前会话已下发断点）
        paused: null, entryResumed: false, sawComplete: false, wsTail: '',
        bpLines: bpGet(abs), // 启动即带持久化断点
        output: ''           // 控制台累计（前端重开可补拉，暂不做，预留）
    };
    session = sess;
    const say = function (text, category) { pushEvent({ tab_id: tabId, type: 'output', category: category || 'stdout', text: String(text) }); };
    const setStatus = function (st) { sess.status = st; pushEvent({ tab_id: tabId, type: 'status', status: st }); };

    const begin = (lang === 'python') ? startPython(sess, say, setStatus)
        : (lang === 'node') ? startNode(sess, say, setStatus)
        : (lang === 'cpp') ? startCpp(sess, say, setStatus)
        : (lang === 'go') ? startGo(sess, say, setStatus)
        : Promise.resolve({ ok: false, error: '适配器未配置' });
    return begin.then(function (r) {
        if (!r || !r.ok) {
            if (session === sess) { stopInternal(sess); session = null; }
            return r || { ok: false, error: '启动失败' };
        }
        return { ok: true, lang: lang, breakpoints: bpLineNums(sess.bpLines), bps: sess.bpLines };
    }, function (e) {
        if (session === sess) { try { stopInternal(sess); } catch (e2) {} session = null; }
        return { ok: false, error: (e && e.message) || '启动失败' };
    });
}

function startPython(sess, say, setStatus) {
    return resolvePython().then(function (py) {
        if (!py || !py.ok) {
            const e = new Error('python_resolve');
            e.resolveFail = py || {};
            throw e;
        }
        if (session !== sess) return { ok: false }; // 启动期间被新会话顶掉
        say('调试环境：Python ' + py.version + '（debugpy ' + py.debugpy + '）\n');
        return pickPort().then(function (port) {
            if (session !== sess) return { ok: false };
            sess.port = port;
            const pyCmd = py.python, pyArgs = py.args || [];
            const args = pyArgs.concat(['-m', 'debugpy', '--listen', '127.0.0.1:' + port, '--wait-for-client', sess.abs]);
            say('$ ' + pyCmd + (pyArgs.length ? ' ' + pyArgs.join(' ') : '') + ' -m debugpy --listen 127.0.0.1:' + port + ' --wait-for-client ' + sess.relPath + '\n');
            const dbgEnv = Object.assign({}, agentEnv ? agentEnv() : process.env, { PYDEVD_DISABLE_FILE_VALIDATION: '1' });
            let child;
            try {
                child = spawn(pyCmd, args, {
                    cwd: sess.cwd,
                    env: dbgEnv,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (e) { return { ok: false, error: '启动 debugpy 失败：' + (e.message || e) }; }
            sess.child = child;
            // 目标程序 stdout 管道透传（debugpy CLI 模式下目标 print 直写管道，不经 DAP output 事件——实测 hello.py 全录无 stdout 类 output 事件）
            child.stdout.on('data', function (d) {
                if (session === sess) pushEvent({ tab_id: sess.tab_id, type: 'output', category: 'stdout', text: d.toString('utf8') });
            });
            let stderrBuf = '';
            child.stderr.on('data', function (d) {
                // 连接前 debugpy 自身报错（如模块缺失）直接透传控制台；连接后目标程序 stderr 走 DAP output 事件
                if (!sess.dap) {
                    stderrBuf += d.toString('utf8');
                    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
                }
            });
            child.on('close', function (code) {
                if (session === sess && sess.status !== 'ended') {
                    if (!sess.dap && code !== 0 && stderrBuf) say(stderrBuf, 'stderr'); // 启动失败原因可见
                    setStatus('ended');
                    pushEvent({ tab_id: sess.tab_id, type: 'terminated', exit_code: code });
                }
                sess.child = null;
            });
            // 连接重试（debugpy 监听就绪需要片刻）。实测结论：
            // ① attach 必须带非空 arguments——adapter 转发时空 {} 会整个省略 arguments，pydevd 侧必填报错
            // ② attach 的响应要等 configurationDone 之后才回，绝不能 await 它再发后续请求（死锁/超时）；
            //    推进信号是 initialized 事件，经 attachDapHandlers 里的 sess.onInitialized 桥接
            // ③ 已连上后的协议错误不再重连——重试会 destroy 旧连接触发 killTree 杀掉目标进程，再连死端口无意义
            const tryConnect = function (left) {
                if (session !== sess) return Promise.resolve({ ok: false });
                const dap = new DapClient();
                return dap.connect(port, '127.0.0.1').then(function () {
                    if (session !== sess) { dap.destroy(); return { ok: false }; }
                    sess.dap = dap;
                    attachDapHandlers(sess, say, setStatus);
                    const attached = new Promise(function (resolve) {
                        sess.onInitialized = function () { resolve(true); };
                    });
                    return dap.request('initialize', {
                        adapterID: 'debugpy', clientID: 'im-client',
                        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
                        supportsVariableType: true, supportsVariableHovering: true,
                        supportsEvaluateForHovers: true, locale: 'zh-cn'
                    }).then(function () {
                        // CLI 模式（--listen --wait-for-client file.py）目标已在命令行指定，DAP 侧发 attach 接管等待中的进程
                        let attachErr = null;
                        dap.request('attach', { justMyCode: false }).catch(function (e) { attachErr = e; });
                        return Promise.race([
                            attached,
                            new Promise(function (res) { setTimeout(function () { res(false); }, 10000); })
                        ]).then(function (ok) {
                            if (!ok) throw (attachErr || new Error('等待调试器初始化超时'));
                        });
                    }).then(function () {
                        if (session !== sess) return { ok: false };
                        // initialized 事件后按 DAP 规约下发断点 + configurationDone，程序开跑
                        return dap.request('setBreakpoints', {
                            source: { path: sess.abs, name: path.basename(sess.abs) },
                            breakpoints: toDapBps(sess.bpLines),
                            sourceModified: false
                        }).then(function (rb) {
                            const verified = ((rb && rb.breakpoints) || []).map(function (b) { return b.line; });
                            sess.bpLines = reverifyBps(sess.bpLines, verified);
                            pushEvent({ tab_id: sess.tab_id, type: 'breakpoints', lines: bpLineNums(sess.bpLines) });
                            return dap.request('configurationDone', {});
                        }).then(function () {
                            setStatus('running');
                            say('调试会话已启动（程序运行中）\n');
                            return { ok: true };
                        });
                    }).catch(function (e) {
                        // 协议层失败（已连上）：销毁会话并杀目标进程，不重试
                        dap.destroy();
                        if (session !== sess) return { ok: false };
                        return { ok: false, error: '调试会话启动失败：' + ((e && e.message) || e) };
                    });
                }).catch(function (e) {
                    // 连接失败（debugpy 未就绪）：目标进程还活着，延迟后重试
                    try { dap.destroy(); } catch (e2) { /* 未连接过 */ }
                    if (session !== sess) return { ok: false };
                    if (left <= 0) {
                        return { ok: false, error: '连接 debugpy 失败：' + ((e && e.message) || e) };
                    }
                    return new Promise(function (res) {
                        setTimeout(function () { res(); }, 400);
                    }).then(function () { return tryConnect(left - 1); });
                });
            };
            return tryConnect(30); // 30 次 × 400ms ≈ 12s
        });
    }).catch(function (e) {
        if (e && e.message === 'python_resolve') {
            const info = e.resolveFail || {};
            // 缺 debugpy / 缺 Py3 均返回结构化错误，前端弹一键引导条
            return { ok: false, code: 'no_python_env', detail: info.err || '未找到可用的 Python 3 + debugpy' };
        }
        return { ok: false, error: (e && e.message) || '启动失败' };
    });
}

// ===== Go：dlv dap（TCP DAP，delve 原生 DAP 服务器——headless TCP，无 stdio 模式） =====
// dlv 探测：PATH → %GOPATH%\bin\dlv.exe（go install 装到 GOPATH\bin，该目录常不在 PATH——同 gopls 特例）
function resolveDlv() {
    return new Promise(function (resolve) {
        execFile('where', ['dlv'], { timeout: 5000, windowsHide: true }, function (err, stdout) {
            if (!err && stdout) {
                const first = String(stdout).split(/\r?\n/)[0].trim();
                if (first) return resolve({ ok: true, exe: first });
            }
            execFile('go', ['env', 'GOPATH'], { timeout: 5000, windowsHide: true }, function (err2, stdout2) {
                if (!err2 && stdout2) {
                    const cand = path.join(String(stdout2).trim(), 'bin', 'dlv.exe');
                    try { if (fs.existsSync(cand)) return resolve({ ok: true, exe: cand }); } catch (e) {}
                }
                resolve({ ok: false, err: '未检测到 dlv（delve）。请安装：go install github.com/go-delve/delve/cmd/dlv@latest' });
            });
        });
    });
}

function startGo(sess, say, setStatus) {
    return resolveDlv().then(function (d) {
        if (!d.ok) {
            const e = new Error('go_resolve');
            e.resolveFail = d;
            throw e;
        }
        if (session !== sess) return { ok: false }; // 启动期间被新会话顶掉
        say('调试环境：delve（' + d.exe + '）\n');
        // dlv dap 是 headless TCP 服务器（实测 --help：无 stdio 模式，与 cdt-gdb-adapter 不同）——
        // 选空闲端口 spawn `dlv dap --listen`，重试连接后 initialize/launch（同 startPython 模板结构）
        return pickPort().then(function (port) {
            if (session !== sess) return { ok: false };
            sess.port = port;
            say('$ dlv dap --listen 127.0.0.1:' + port + '\n');
            let child;
            try {
                child = spawn(d.exe, ['dap', '--listen', '127.0.0.1:' + port], {
                    cwd: path.dirname(sess.abs), // 文件所在目录（go.mod 所在包根），dlv 编译定位（program 相对路径按此解析）
                    env: Object.assign({}, agentEnv ? agentEnv() : process.env),
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (e) { return { ok: false, error: '启动 dlv 失败：' + (e.message || e) }; }
            sess.child = child;
            let stderrBuf = '';
            child.stderr.on('data', function (d2) {
                stderrBuf += d2.toString('utf8');
                if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
            });
            child.on('close', function (code) {
                if (session === sess && sess.status !== 'ended') {
                    if (!sess.dap && code !== 0 && stderrBuf) say(stderrBuf, 'stderr'); // 启动失败原因可见
                    setStatus('ended');
                    pushEvent({ tab_id: sess.tab_id, type: 'terminated', exit_code: code });
                }
                sess.child = null;
            });
            // 连接重试（dlv 监听就绪需要片刻）。DAP 规约：launch 在 initialize 应答后、initialized
            // 事件前发出；delve 收到 launch 才编译并启动目标进程（首次编译耗时，竞速超时放宽 30s）。
            // launch 应答时序不定（可能晚于 initialized），绝不 await 它再发后续请求——同 startPython 的 attach 模式
            const tryConnect = function (left) {
                if (session !== sess) return Promise.resolve({ ok: false });
                const dap = new DapClient();
                return dap.connect(port, '127.0.0.1').then(function () {
                    if (session !== sess) { dap.destroy(); return { ok: false }; }
                    sess.dap = dap;
                    attachDapHandlers(sess, say, setStatus);
                    const launched = new Promise(function (resolve) {
                        sess.onInitialized = function () { resolve(true); };
                    });
                    return dap.request('initialize', {
                        adapterID: 'go', clientID: 'im-client',
                        linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
                        supportsVariableType: true, supportsVariableHovering: true,
                        supportsEvaluateForHovers: true, locale: 'zh-cn'
                    }).then(function () {
                        let launchErr = null;
                        dap.request('launch', {
                            request: 'launch', type: 'go', name: 'debug',
                            mode: 'debug',
                            program: sess.abs, // 单文件：delve 取其所在包目录编译
                            cwd: path.dirname(sess.abs)
                        }).catch(function (e) { launchErr = e; });
                        return Promise.race([
                            launched,
                            new Promise(function (res) { setTimeout(function () { res(false); }, 30000); })
                        ]).then(function (ok) {
                            if (!ok) throw (launchErr || new Error('等待 dlv 初始化超时（30s）'));
                        });
                    }).then(function () {
                        if (session !== sess) return { ok: false };
                        // initialized 事件后按 DAP 规约下发断点 + configurationDone，程序开跑
                        return dap.request('setBreakpoints', {
                            source: { path: sess.abs, name: path.basename(sess.abs) },
                            breakpoints: toDapBps(sess.bpLines),
                            sourceModified: false
                        }).then(function (rb) {
                            const verified = ((rb && rb.breakpoints) || []).map(function (b) { return b.line; });
                            sess.bpLines = reverifyBps(sess.bpLines, verified);
                            pushEvent({ tab_id: sess.tab_id, type: 'breakpoints', lines: bpLineNums(sess.bpLines) });
                            return dap.request('configurationDone', {});
                        }).then(function () {
                            setStatus('running');
                            say('调试会话已启动（程序运行中）\n');
                            return { ok: true };
                        });
                    }).catch(function (e) {
                        // 协议层失败（已连上）：销毁会话并杀 dlv（连带目标进程），不重试
                        dap.destroy();
                        if (session !== sess) return { ok: false };
                        return { ok: false, error: '调试会话启动失败：' + ((e && e.message) || e) };
                    });
                }).catch(function (e) {
                    // 连接失败（dlv 未就绪）：目标进程还活着，延迟后重试
                    try { dap.destroy(); } catch (e2) { /* 未连接过 */ }
                    if (session !== sess) return { ok: false };
                    if (left <= 0) {
                        return { ok: false, error: '连接 dlv 失败：' + ((e && e.message) || e) };
                    }
                    return new Promise(function (res) {
                        setTimeout(function () { res(); }, 400);
                    }).then(function () { return tryConnect(left - 1); });
                });
            };
            return tryConnect(30); // 30 次 × 400ms ≈ 12s
        });
    }).catch(function (e) {
        if (e && e.message === 'go_resolve') {
            const info = e.resolveFail || {};
            const detail = info.err || '未检测到 dlv（delve）';
            // 结构化 code 供前端引导条；error 兜底保证旧前端也能显示原因
            return { ok: false, code: 'no_go_env', detail: detail, error: detail };
        }
        return { ok: false, error: (e && e.message) || '启动失败' };
    });
}

// ===== C/C++：cdt-gdb-adapter（stdio DAP）+ 内置工具链 gcc/gdb =====
// 流程：工具链解析 → gcc -g -O0 编译同目录 *_debug.exe → spawn 适配器 → initialize → launch
// → initialized 事件（推进信号）→ setBreakpoints → configurationDone（内部 -exec-run）→ running。
// 探针实测（probe_c.js）：stopped 事件不含行号（前端照常经 stackTrace 定位）；exited-normally →
// terminated 事件（无 exit code）；断点/单步/求值/变量与 Python DAP 路径同构，cmd() 通用分支直接复用。
function resolveTool(name) {
    // 在 agentEnv PATH（前置工具链目录 + 系统 PATH）中解析命令绝对路径；debug-manager 不感知工具链具体位置
    const env = agentEnv ? agentEnv() : process.env;
    const dirs = String((env && env.PATH) || '').split(path.delimiter);
    for (let i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        const full = path.join(dirs[i], name + '.exe');
        try { if (fs.existsSync(full)) return full; } catch (e) { /* 跳过不可读目录 */ }
    }
    return '';
}
function adapterEntryPath() {
    try {
        const p = require.resolve('cdt-gdb-adapter/dist/debugAdapter.js');
        // 打包态：node_modules 在 asar 内，外部 node 进程读不到——改指 electron-builder asarUnpack 的实体目录
        return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    } catch (e) { return ''; }
}
function resolveCppToolchain(sess, say) {
    const gcc = resolveTool('gcc');
    const gdb = resolveTool('gdb');
    if (gcc && gdb) return Promise.resolve({ ok: true, gcc: gcc, gdb: gdb });
    // 缺 gcc/gdb：引导内置工具链（bundled/resources 本地 zip 优先，联网下载兜底），就绪后重解析
    if (!toolchainFn) return Promise.resolve({ ok: false, code: 'no_gcc_env', detail: '未找到 gcc/gdb（PATH 与内置工具链均未命中）' });
    say('未检测到 gcc/gdb，正在准备内置编译工具链（首次约需数分钟，视网速而定）…\n');
    return Promise.resolve().then(function () { return toolchainFn(); }).then(function (r) {
        if (r && r.ok) say('内置编译工具链已就绪\n');
        const g2 = resolveTool('gcc'), d2 = resolveTool('gdb');
        if (g2 && d2) return { ok: true, gcc: g2, gdb: d2 };
        return { ok: false, code: 'no_gcc_env', detail: (r && !r.ok && r.msg ? '工具链准备失败：' + r.msg : '工具链就绪但未解析到 gcc/gdb') };
    }, function (e) {
        return { ok: false, code: 'no_gcc_env', detail: '工具链准备失败：' + ((e && e.message) || '未知原因') };
    });
}
function compileCpp(sess, gccExe, say) {
    // 源文件 → 同目录 <name>_debug.exe（-g 调试符号 + -O0 关优化，行号/变量与源码一一对应）
    const outExe = path.join(path.dirname(sess.abs), path.basename(sess.abs).replace(/\.(c|cpp|cc|cxx)$/i, '') + '_debug.exe');
    return new Promise(function (resolve) {
        say('$ gcc -g -O0 -o ' + path.basename(outExe) + ' ' + sess.relPath + '\n');
        let child;
        try {
            child = spawn(gccExe, ['-g', '-O0', '-o', outExe, sess.abs], {
                cwd: sess.cwd,
                env: agentEnv ? agentEnv() : process.env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (e) { resolve({ ok: false, error: '启动 gcc 失败：' + (e.message || e) }); return; }
        child.stdout.on('data', function (d) { if (session === sess) say(d.toString('utf8')); });
        child.stderr.on('data', function (d) { if (session === sess) say(d.toString('utf8'), 'stderr'); }); // 编译告警/错误实时透传
        child.on('error', function (e) { resolve({ ok: false, error: '启动 gcc 失败：' + (e.message || e) }); });
        child.on('close', function (code) {
            if (session !== sess) { resolve({ ok: false }); return; }
            if (code !== 0) { resolve({ ok: false, error: '编译失败（gcc exit ' + code + '，详情见输出面板）' }); return; }
            resolve({ ok: true, exe: outExe });
        });
    });
}
function startCpp(sess, say, setStatus) {
    return resolveCppToolchain(sess, say).then(function (tools) {
        if (!tools.ok) return tools;
        if (session !== sess) return { ok: false };
        say('调试环境：gcc ' + tools.gcc + '\n', 'dbg');
        return compileCpp(sess, tools.gcc, say).then(function (cr) {
            if (!cr.ok) return cr;
            if (session !== sess) return { ok: false };
            return launchCppAdapter(sess, say, setStatus, cr.exe, tools.gdb);
        });
    });
}
function launchCppAdapter(sess, say, setStatus, exePath, gdbPath) {
    return new Promise(function (resolve) {
        const entry = adapterEntryPath();
        if (!entry) { resolve({ ok: false, error: '调试适配器缺失（cdt-gdb-adapter 未安装）' }); return; }
        let child;
        try {
            child = spawn('node', [entry], {
                env: agentEnv ? agentEnv() : process.env, // PATH 前置工具链，gdb 由 launch 显式指定路径
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) { resolve({ ok: false, error: '启动调试适配器失败：' + (e.message || e) }); return; }
        const failOnce = function (msg) {
            if (sess.startDone) return;
            resolve({ ok: false, error: msg });
        };
        child.on('error', function (e) {
            failOnce('启动调试适配器失败：' + (e.code === 'ENOENT' ? '未找到 Node.js（node 命令不可用）' : (e.message || e)));
        });
        sess.child = child;
        let adTail = '';
        child.stderr.on('data', function (d) {
            if (session !== sess) return;
            if (!sess.dap) { // 连接前适配器 stderr = 启动失败线索（模块缺失等）
                adTail += d.toString('utf8');
                if (adTail.length > 4000) adTail = adTail.slice(-4000);
            }
        });
        const dap = new DapClient();
        sess.dap = dap;
        dap.connectStdio(child);
        attachDapHandlers(sess, say, setStatus);
        const initialized = new Promise(function (res) { sess.onInitialized = function () { res(true); }; });
        let launchErr = null;
        dap.request('initialize', {
            adapterID: 'gdb', clientID: 'im-client',
            linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
            supportsVariableType: true, supportsVariableHovering: true,
            supportsEvaluateForHovers: true, locale: 'zh-cn'
        }).then(function () {
            // launch 不 await（探针实测响应与 initialized 事件都会到，但推进信号以 initialized 为准）
            dap.request('launch', {
                type: 'gdb', request: 'launch',
                program: exePath, cwd: sess.cwd, gdb: gdbPath,
                verbose: false
            }).catch(function (e) { launchErr = e; });
            return Promise.race([
                initialized,
                new Promise(function (res) { setTimeout(function () { res(false); }, 15000); })
            ]).then(function (ok) {
                if (!ok) throw (launchErr || new Error('等待调试器初始化超时' + (adTail ? '：' + adTail.slice(-200) : '')));
            });
        }).then(function () {
            if (session !== sess) return { ok: false };
            // initialized 后按 DAP 规约下发断点 + configurationDone（内部触发 -exec-run，程序开跑）
            return dap.request('setBreakpoints', {
                source: { path: sess.abs, name: path.basename(sess.abs) },
                breakpoints: toDapBps(sess.bpLines),
                sourceModified: false
            }).then(function (rb) {
                const verified = ((rb && rb.breakpoints) || []).map(function (b) { return b.line; });
                sess.bpLines = reverifyBps(sess.bpLines, verified);
                pushEvent({ tab_id: sess.tab_id, type: 'breakpoints', lines: bpLineNums(sess.bpLines) });
                return dap.request('configurationDone', {});
            });
        }).then(function () {
            if (session !== sess) return;
            if (sess.startDone) return;
            sess.startDone = true;
            // configurationDone 已触发 -exec-run；断点在入口即命中时 stopped 事件已置 paused——不覆盖
            if (!sess.paused) {
                setStatus('running');
                say('调试会话已启动（程序运行中）\n');
            } else {
                say('调试会话已启动（已命中断点）\n');
            }
            resolve({ ok: true });
        }).catch(function (e) {
            if (session !== sess) { resolve({ ok: false }); return; }
            failOnce('调试会话启动失败：' + ((e && e.message) || e));
        });
    });
}
// bootstrapCpp：gcc/gdb 缺失时的一键引导（前端引导条按钮触发；同 bootstrapPython 模式，进度推输出面板）
function bootstrapCpp(evTabId) {
    const tabId = String(evTabId || '');
    const say = function (t) { pushEvent({ tab_id: tabId, type: 'output', category: 'stderr', text: t }); };
    const gcc = resolveTool('gcc'), gdb = resolveTool('gdb');
    if (gcc && gdb) { say('编译调试环境已就绪（gcc/gdb 均已可用）\n'); return Promise.resolve({ ok: true }); }
    if (!toolchainFn) return Promise.resolve({ ok: false, error: '工具链引导未就绪，请安装 MinGW-w64（含 gcc 与 gdb）后重试' });
    say('正在准备 C/C++ 调试环境（内置 gcc 工具链，含 gdb；首次约需数分钟，视网速而定）…\n');
    return Promise.resolve().then(function () { return toolchainFn(); }).then(function (r) {
        if (r && r.ok) { say('内置编译工具链已就绪\n'); return { ok: true }; }
        say('工具链准备失败：' + ((r && r.msg) || '未知原因') + '\n');
        return { ok: false, error: (r && r.msg) || '工具链准备失败' };
    }, function (e) {
        say('工具链准备失败：' + ((e && e.message) || '未知原因') + '\n');
        return { ok: false, error: (e && e.message) || '工具链准备失败' };
    });
}

// ===== Node.js：V8 Inspector 直连（无适配器进程） =====
// 实测结论（Node 24 / --inspect-brk，探针 cdp_probe/cdp3/cdp4）：
// ① --inspect-brk 后调试端必须发 Runtime.runIfWaitingForDebugger 才会触发入口暂停
//    （旧版自动 "Break on start" 事件已不存在，js-debug 1.117 即因死等该事件而挂起）；
// ② Debugger.setBreakpointByUrl 的 url 必须是 file:/// 形式（pathToFileURL），裸盘符路径不匹配；
//    脚本未解析时 locations 为空，脚本解析后断点自动绑定（V8 可能重定位到最近可执行行，实际暂停行以
//    paused 事件 location 为准——前端箭头按栈帧行号显示，不受影响）；
// ③ 程序正常跑完后 Node 打印 "Waiting for the debugger to disconnect..." 并挂住进程——
//    必须主动 close WebSocket 让其退出（退出码 0）；
// ④ console.* 与 stdout 天然重复（inspector 事件 + 管道各一份），故只走管道转发（同 Python 路径），
//    未注册 consoleAPICalled；异常同样由 stderr 管道承载。
function startNode(sess, say, setStatus) {
    return new Promise(function (resolve) {
        if (typeof WebSocket !== 'function') {
            resolve({ ok: false, error: '当前运行环境缺少 WebSocket（需 Electron 22+）' });
            return;
        }
        pickPort().then(function (port) {
            if (session !== sess) { resolve({ ok: false }); return; }
            sess.port = port;
            let fileUrl = '';
            try { fileUrl = url.pathToFileURL(sess.abs).href; } catch (e) { /* 罕见：非法路径 */ }
            const args = ['--inspect-brk=127.0.0.1:' + port, sess.abs];
            say('$ node --inspect-brk=127.0.0.1:' + port + ' ' + sess.relPath + '\n');
            let child;
            try {
                child = spawn('node', args, {
                    cwd: sess.cwd,
                    env: agentEnv ? agentEnv() : process.env,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (e) { resolve({ ok: false, error: '启动 node 失败：' + (e.message || e) }); return; }
            sess.child = child;
            sess.insp = true;

            const failOnce = function (msg) {
                if (sess.startDone) return;
                sess.startDone = true;
                resolve({ ok: false, error: msg });
            };

            child.on('error', function (e) {
                // ENOENT：本机无 node
                failOnce('未找到 Node.js（node 命令不可用），请安装 Node.js 18+ 后重试' + (e.code === 'ENOENT' ? '' : '：' + (e.message || e)));
            });
            child.on('close', function (code) {
                if (session === sess && sess.status !== 'ended') {
                    if (!sess.ws && code !== 0 && sess.wsTail) say(sess.wsTail, 'stderr'); // 连接前崩溃（语法错误等）原因可见
                    setStatus('ended');
                    pushEvent({ tab_id: sess.tab_id, type: 'terminated', exit_code: code });
                }
                sess.child = null;
            });
            child.stdout.on('data', function (d) { // 目标程序 stdout → 输出面板
                if (session === sess) pushEvent({ tab_id: sess.tab_id, type: 'output', category: 'stdout', text: d.toString('utf8') });
            });
            child.stderr.on('data', function (d) {
                if (session !== sess) return;
                const s = d.toString('utf8');
                // 正常完成信号：关闭 ws 让进程退出（见注释③）
                if (/Waiting for the debugger to disconnect/i.test(s)) {
                    sess.sawComplete = true;
                    try { if (sess.ws && sess.ws.readyState === 1) sess.ws.close(); } catch (e) { /* 已关闭 */ }
                    return;
                }
                const wm = /Debugger listening on (ws:\/\/\S+)/.exec(s); // 调试端口就绪
                if (wm) { sess.wsUrl = wm[1]; return; }
                if (/^Debugger attached/im.test(s)) return;              // inspector 自身提示不透传
                if (!sess.ws) { // 连接前 stderr = 启动失败原因（语法错误等）
                    sess.wsTail += s;
                    if (sess.wsTail.length > 4000) sess.wsTail = sess.wsTail.slice(-4000);
                } else {
                    pushEvent({ tab_id: sess.tab_id, type: 'output', category: 'stderr', text: s });
                }
            });

            // 等 "Debugger listening on ws://..."（15s 超时）
            const wsUrlWait = new Promise(function (res, rej) {
                const started = Date.now();
                const t = setInterval(function () {
                    if (session !== sess) { clearInterval(t); rej(new Error('会话已取消')); return; }
                    if (sess.child === null) { clearInterval(t); rej(new Error('目标进程已退出')); return; }
                    if (sess.wsUrl) { clearInterval(t); res(sess.wsUrl); return; }
                    if (Date.now() - started > 15000) { clearInterval(t); rej(new Error('等待 Node 调试端口超时')); }
                }, 80);
            });

            wsUrlWait.then(function (wsUrl) {
                if (session !== sess) return null;
                const ws = new WebSocket(wsUrl);
                sess.ws = ws;
                // WHATWG WebSocket：CONNECTING 状态不可 send，先等 open 再握手
                const openWait = new Promise(function (res, rej) {
                    ws.onopen = function () { res(); };
                    ws.onerror = function () { rej(new Error('WebSocket 连接失败')); };
                });
                ws.onmessage = function (ev) {
                    try { inspectorMessage(sess, typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { /* 单条消息异常不断链 */ }
                };
                ws.onclose = function () {
                    sess.ws = null;
                    if (session === sess && sess.status !== 'ended' && !sess.sawComplete) {
                        // 异常断连（目标崩溃/被杀）：收尾
                        setStatus('ended');
                        pushEvent({ tab_id: sess.tab_id, type: 'terminated' });
                    }
                };
                // 握手：enable 域 → 下发持久化断点 → 释放入口暂停（open 后才可调用，ws 须已 OPEN）
                const handshake = function () {
                    const entryWait = new Promise(function (res) { sess.entryWaitFn = res; });
                    return inspectorSend(sess, 'Runtime.enable', {}, 8000)
                        .then(function () { return inspectorSend(sess, 'Debugger.enable', { maxScriptsCacheSize: 1e7 }, 8000); })
                        .then(function () {
                            if (session !== sess || !fileUrl) return;
                            return Promise.all(sess.bpLines.map(function (bp) {
                                return inspectorSend(sess, 'Debugger.setBreakpointByUrl', {
                                    lineNumber: bp.line - 1, url: fileUrl, columnNumber: 0, condition: bp.condition || ''
                                }, 8000).then(function (r) {
                                    if (r && r.breakpointId) sess.nodeBps.set(r.breakpointId, { line: bp.line });
                                }).catch(function () { /* 单个断点失败不影响会话 */ });
                            }));
                        })
                        .then(function () { return inspectorSend(sess, 'Runtime.runIfWaitingForDebugger', {}, 8000); })
                        .then(function () {
                            // 入口暂停由 paused 事件驱动自动放行（onInspectorPaused），等它放行完
                            return Promise.race([
                                entryWait,
                                new Promise(function (res) { setTimeout(res, 6000); })
                            ]);
                        });

                };

                return openWait.then(function () { return handshake(); }).then(function () {
                    if (session !== sess) return null;
                    if (sess.startDone) return null;
                    sess.startDone = true;
                    // 入口放行后若立刻命中断点（如首行断点），paused 已置位——不覆盖 paused 状态
                    if (!sess.paused) {
                        setStatus('running');
                        say('调试会话已启动（程序运行中）\n');
                    } else {
                        say('调试会话已启动（已命中断点）\n');
                    }
                    resolve({ ok: true });
                    return null;
                }).catch(function (e) {
                    failOnce('调试会话启动失败：' + ((e && e.message) || e));
                    return null;
                });
            }).catch(function (e) {
                failOnce((e && e.message) || '连接 Node 调试端口失败');
            });
        });
    });
}

// Inspector 消息路由（事件驱动，无轮询）
function inspectorMessage(sess, txt) {
    let m = null;
    try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m) return;
    if (m.id) { // 响应
        const w = sess.msgWait.get(m.id);
        if (w) {
            sess.msgWait.delete(m.id);
            clearTimeout(w.timer);
            if (m.error) w.reject(new Error((m.error.message || 'Inspector 错误') + (m.error.data ? ' ' + String(m.error.data).slice(0, 200) : '')));
            else w.resolve(m.result || {});
        }
        return;
    }
    const p = m.params || {};
    switch (m.method) {
        case 'Debugger.scriptParsed':
            if (p.scriptId) sess.scripts.set(p.scriptId, p.url || '');
            break;
        case 'Debugger.paused':
            onInspectorPaused(sess, p);
            break;
        case 'Debugger.resumed':
            if (session === sess && sess.status !== 'ended') {
                sess.status = 'running';
                sess.paused = null;
                sess.frameId = '';
                sess.varReg.clear(); // objectId 随恢复全部失效
                pushEvent({ tab_id: sess.tab_id, type: 'continued', threadId: 1 });
            }
            break;
        case 'Inspector.detached':
        case 'Runtime.executionContextDestroyed':
        case 'Runtime.executionContextsCleared':
            // 目标结束/上下文销毁：交给 ws close 与 child close 统一收尾
            break;
        default:
            break;
    }
}

function onInspectorPaused(sess, p) {
    if (session !== sess) return;
    const callFrames = p.callFrames || [];
    // 入口暂停（--inspect-brk）：不打扰用户，自动放行（首行断点会在放行后立即重新命中并走正常暂停）
    if (p.reason === 'Break on start' && !sess.entryResumed) {
        sess.entryResumed = true;
        inspectorSend(sess, 'Debugger.resume', {}, 8000).catch(function () { /* 进程退出时忽略 */ });
        if (sess.entryWaitFn) { const f = sess.entryWaitFn; sess.entryWaitFn = null; try { f(); } catch (e) {} }
        return;
    }
    sess.paused = p;
    sess.varReg.clear();
    sess.frameId = (callFrames[0] && callFrames[0].callFrameId) || '';
    sess.status = 'paused';
    sess.threadId = 1;
    // 原因映射（前端按 DAP reason 展示）：断点 / 单步 / 异常 / 手动暂停
    let reason = 'pause';
    if ((p.hitBreakpoints || []).length) reason = 'breakpoint';
    else if (p.reason === 'step') reason = 'step';
    else if (p.reason === 'debugCommand') reason = 'pause';
    else if (p.reason === 'exception' || p.reason === 'promiseRejection') reason = 'exception';
    const f0 = callFrames[0];
    pushEvent({
        tab_id: sess.tab_id, type: 'stopped', reason: reason, threadId: 1,
        line: f0 && f0.location ? (f0.location.lineNumber || 0) + 1 : 0,
        description: p.reason && p.reason !== 'other' ? p.reason : ''
    });
}

// Inspector 单命令发送（Promise + 超时）
function inspectorSend(sess, method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
        const ws = sess.ws;
        if (!ws || ws.readyState !== 1) { reject(new Error('Inspector 未连接')); return; }
        const id = ++sess.msgSeq;
        const timer = setTimeout(function () {
            sess.msgWait.delete(id);
            reject(new Error('Inspector 超时：' + method));
        }, timeoutMs || 8000);
        sess.msgWait.set(id, { resolve: resolve, reject: reject, timer: timer });
        try { ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); } catch (e) {
            clearTimeout(timer);
            sess.msgWait.delete(id);
            reject(e);
        }
    });
}

// CDP RemoteObject → 面板文本（字符串带引号、对象用 description，超长截断）
function remoteValueText(o) {
    if (!o) return 'undefined';
    let t;
    if (o.type === 'string') t = JSON.stringify(o.value);
    else if (o.type === 'undefined') t = 'undefined';
    else if (o.subtype === 'null') t = 'null';
    else if (o.type === 'function') t = o.description || ('ƒ ' + (o.className || ''));
    else if (o.objectId) t = o.description || (o.className || o.type || 'Object');
    else t = String(o.value !== undefined ? o.value : (o.description !== undefined ? o.description : o.type));
    if (t.length > 160) t = t.slice(0, 160) + '…';
    return t;
}

function nodeScopeName(type) {
    switch (type) {
        case 'local': return '局部';
        case 'closure': return '闭包';
        case 'script': return '脚本';
        case 'global': return '全局';
        case 'module': return '模块';
        case 'block': return '块级';
        default: return type || '作用域';
    }
}

function regInspectorObject(sess, objectId) {
    const id = sess.varSeq++;
    sess.varReg.set(id, objectId);
    return id;
}

// Node 会话调试控制（与 DAP 路径同一套 op 面，前端无感知）
function cmdNode(sess, op, arg) {
    switch (String(op || '')) {
        case 'continue':
        case 'next':
        case 'stepIn':
        case 'stepOut':
        case 'pause': {
            if (op !== 'pause' && !sess.paused) return Promise.resolve({ ok: false, error: '程序未暂停' });
            const method = { continue: 'Debugger.resume', next: 'Debugger.stepOver', stepIn: 'Debugger.stepInto', stepOut: 'Debugger.stepOut', pause: 'Debugger.pause' }[op];
            return inspectorSend(sess, method, {}).then(function () { return { ok: true }; }).catch(function (e) {
                return { ok: false, error: (e && e.message) || '操作失败' };
            });
        }
        case 'threads':
            return Promise.resolve({ ok: true, threads: [{ id: 1, name: '主线程' }] });
        case 'stackTrace': {
            if (!sess.paused) return Promise.resolve({ ok: true, frames: [] });
            const frames = (sess.paused.callFrames || []).slice(0, 20).map(function (cf) {
                const rawUrl = (cf.location && sess.scripts.get(cf.location.scriptId)) || '';
                let file = '';
                try { file = rawUrl.indexOf('file://') === 0 ? url.fileURLToPath(rawUrl) : ''; } catch (e) { file = ''; }
                return {
                    id: cf.callFrameId,
                    name: cf.functionName || '(顶层)',
                    line: ((cf.location && cf.location.lineNumber) || 0) + 1,
                    column: ((cf.location && cf.location.columnNumber) || 0) + 1,
                    file: file,
                    name2: file ? path.basename(file) : (rawUrl ? rawUrl.split('/').pop() : '')
                };
            });
            return Promise.resolve({ ok: true, frames: frames });
        }
        case 'scopes': {
            if (!sess.paused) return Promise.resolve({ ok: false, error: '程序未暂停' });
            const fid = String(arg || sess.frameId || '');
            const cf = (sess.paused.callFrames || []).find(function (c) { return c.callFrameId === fid; }) || (sess.paused.callFrames || [])[0];
            if (!cf) return Promise.resolve({ ok: false, error: '无可用栈帧' });
            const scopes = (cf.scopeChain || []).filter(function (s) { return s.object && s.object.objectId; }).map(function (s) {
                return { name: nodeScopeName(s.type), variablesReference: regInspectorObject(sess, s.object.objectId), expensive: false };
            });
            return Promise.resolve({ ok: true, scopes: scopes });
        }
        case 'variables': {
            const ref = parseInt(arg, 10) || 0;
            const objectId = sess.varReg.get(ref);
            if (!objectId) return Promise.resolve({ ok: false, error: '变量引用已失效（程序已恢复运行？）' });
            return inspectorSend(sess, 'Runtime.getProperties', { objectId: objectId, generatePreview: true }).then(function (r) {
                return {
                    ok: true,
                    variables: (r.result || []).map(function (v) {
                        const val = v.value || {};
                        return {
                            name: v.name,
                            value: remoteValueText(val),
                            type: val.className || (val.subtype && val.subtype !== 'null' ? val.subtype : '') || (val.type || ''),
                            ref: val.objectId ? regInspectorObject(sess, val.objectId) : 0
                        };
                    })
                };
            }).catch(function (e) {
                return { ok: false, error: (e && e.message) || '取变量失败' };
            });
        }
        case 'evaluate': {
            arg = arg || {};
            if (!sess.paused) return Promise.resolve({ ok: false, error: '需在暂停状态求值' });
            return inspectorSend(sess, 'Debugger.evaluateOnCallFrame', {
                callFrameId: String(arg.frameId || sess.frameId || ''),
                expression: String(arg.expr || ''),
                generatePreview: true,
                includeCommandLineAPI: false
            }).then(function (r) {
                const res = r.result || {};
                return { ok: true, result: remoteValueText(res), type: res.className || res.subtype || res.type || '', ref: res.objectId ? regInspectorObject(sess, res.objectId) : 0 };
            }).catch(function (e) {
                return { ok: false, error: (e && e.message) || '求值失败' };
            });
        }
        case 'restart': // 重启=旧会话停掉重新 start（断点持久化自动带回）
            return Promise.resolve().then(function () {
                const req = { tab_id: sess.tab_id, username: sess.username, relPath: sess.relPath };
                stop();
                return start(req);
            });
        default:
            return Promise.resolve({ ok: false, error: '未知调试操作：' + op });
    }
}

function attachDapHandlers(sess, say, setStatus) {
    const dap = sess.dap;
    dap.onEvent = function (ev, body) {
        if (session !== sess) return;
        switch (ev) {
            case 'initialized':
                // 启动序列推进信号（tryConnect 的 attached Promise 桥接）
                if (sess.onInitialized) { const f = sess.onInitialized; sess.onInitialized = null; try { f(); } catch (e) {} }
                break;
            case 'stopped':
                sess.status = 'paused';
                sess.threadId = body.threadId || 0;
                sess.frameId = 0; // 每次暂停帧 id 会变，旧值作废（stackTrace 后重解析）
                pushEvent({
                    tab_id: sess.tab_id, type: 'stopped', reason: body.reason || '',
                    threadId: sess.threadId, description: body.description || body.text || ''
                });
                break;
            case 'continued':
                sess.status = 'running';
                sess.frameId = 0;
                pushEvent({ tab_id: sess.tab_id, type: 'continued', threadId: body.threadId || 0 });
                break;
            case 'output':
                pushEvent({ tab_id: sess.tab_id, type: 'output', category: body.category || 'stdout', text: body.output || '' });
                break;
            case 'terminated':
                setStatus('ended');
                // debugpy CLI 模式下目标 stdout 管道尾数据晚于 DAP terminated 到达（实测），延迟发送避免输出面板"先结束、后输出"顺序颠倒
                setTimeout(function () {
                    if (session === sess) pushEvent({ tab_id: sess.tab_id, type: 'terminated' });
                }, 500);
                if (sess.lang === 'cpp') {
                    // gdb 会话在 inferior 退出后常驻（适配器与 gdb 进程不自动退出），及时回收防孤儿进程
                    setTimeout(function () {
                        if (session === sess && sess.status === 'ended') stopInternal(sess);
                    }, 900);
                }
                break;
            case 'exited':
                pushEvent({ tab_id: sess.tab_id, type: 'output', category: 'stdout', text: '\n进程已退出（exit code ' + body.exitCode + '）\n' });
                break;
            case 'thread':
                // 线程启停：不逐条透传（前端无线程面板），保留主线程号兜底
                if (body.reason === 'started' && !sess.threadId) sess.threadId = body.threadId || 0;
                break;
            case 'breakpoint':
                // 适配器校准断点已随 setBreakpoints 响应回传（全量列表），逐条事件忽略避免半量覆盖
                break;
            case 'process':
                say('系统进程 ID: ' + (body.systemProcessId || body.name || '') + '\n');
                break;
            default:
                break;
        }
    };
    dap.onClose = function () {
        if (session === sess && sess.status !== 'ended') {
            sess.status = 'ended';
            pushEvent({ tab_id: sess.tab_id, type: 'terminated' });
        }
        if (sess.child) killTree(sess.child.pid);
    };
}

// ===== 停止/回收 =====
function stopInternal(sess) {
    if (!sess) return;
    sess.status = 'ended';
    const ws = sess.ws; // Node Inspector：先关 ws（V8 "waiting for disconnect" 释放），再强杀兜底
    if (ws) {
        sess.ws = null;
        try { if (ws.readyState === 1) ws.close(); } catch (e) {}
        setTimeout(function () { try { if (ws.readyState === 1) ws.close(); } catch (e) {} }, 300);
    }
    sess.msgWait.forEach(function (p) { try { clearTimeout(p.timer); p.reject(new Error('会话已停止')); } catch (e) {} });
    sess.msgWait.clear();
    const dap = sess.dap;
    if (dap) {
        try { dap.request('disconnect', { terminateDebuggee: true }, 1500).catch(function () {}); } catch (e) {}
        setTimeout(function () { try { dap.destroy(); } catch (e) {} }, 400);
        sess.dap = null;
    }
    if (sess.child) killTree(sess.child.pid);
    sess.child = null;
}
function stop() {
    if (!session) return { ok: true };
    const sess = session;
    stopInternal(sess);
    session = null;
    pushEvent({ tab_id: sess.tab_id, type: 'terminated', stopped_by_user: true });
    return { ok: true };
}

// ===== 调试控制（op 分发：continue/next/stepIn/stepOut/pause/stackTrace/variables/evaluate/threads/restart） =====
function cmd(op, arg) {
    if (!session) return Promise.resolve({ ok: false, error: '无活动调试会话' });
    const sess = session;
    if (sess.insp) return cmdNode(sess, op, arg); // Node：V8 Inspector 直连路径
    const dap = sess.dap;
    if (!dap) return Promise.resolve({ ok: false, error: '无活动调试会话' });
    const needThread = function () {
        if (sess.threadId) return Promise.resolve(sess.threadId);
        return dap.request('threads', {}).then(function (r) {
            const t = (r && r.threads && r.threads[0]) || null;
            sess.threadId = t ? t.id : 0;
            return sess.threadId;
        });
    };
    switch (String(op || '')) {
        case 'continue': return needThread().then(function (tid) { return dap.request('continue', { threadId: tid }); }).then(function () { return { ok: true }; });
        case 'next': return needThread().then(function (tid) { return dap.request('next', { threadId: tid }); }).then(function () { return { ok: true }; });
        case 'stepIn': return needThread().then(function (tid) { return dap.request('stepIn', { threadId: tid }); }).then(function () { return { ok: true }; });
        case 'stepOut': return needThread().then(function (tid) { return dap.request('stepOut', { threadId: tid }); }).then(function () { return { ok: true }; });
        case 'pause': return needThread().then(function (tid) { return dap.request('pause', { threadId: tid }); }).then(function () { return { ok: true }; });
        case 'threads': return dap.request('threads', {}).then(function (r) { return { ok: true, threads: (r && r.threads) || [] }; });
        case 'stackTrace':
            return needThread().then(function (tid) {
                return dap.request('stackTrace', { threadId: tid, startFrame: 0, levels: 20 });
            }).then(function (r) {
                const frames = (r && r.stackFrames) || [];
                if (frames.length && !sess.frameId) sess.frameId = frames[0].id;
                return {
                    ok: true,
                    frames: frames.map(function (f) {
                        return {
                            id: f.id, name: f.name, line: f.line, column: f.column,
                            file: (f.source && f.source.path) || '', name2: (f.source && f.source.name) || ''
                        };
                    })
                };
            });
        case 'scopes':
            return dap.request('scopes', { frameId: parseInt(arg, 10) || sess.frameId }).then(function (r) {
                return {
                    ok: true,
                    scopes: ((r && r.scopes) || []).map(function (s) {
                        return { name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive };
                    })
                };
            });
        case 'variables':
            return dap.request('variables', { variablesReference: parseInt(arg, 10) || 0 }).then(function (r) {
                return {
                    ok: true,
                    variables: ((r && r.variables) || []).map(function (v) {
                        return {
                            name: v.name, value: v.value, type: v.type || '',
                            ref: v.variablesReference || 0
                        };
                    })
                };
            });
        case 'evaluate':
            arg = arg || {};
            return dap.request('evaluate', {
                expression: String(arg.expr || ''), frameId: parseInt(arg.frameId, 10) || sess.frameId,
                context: arg.context || 'repl'
            }).then(function (r) {
                return { ok: true, result: (r && r.result) || '', type: (r && r.type) || '', ref: (r && r.variablesReference) || 0 };
            });
        case 'restart':
            return Promise.resolve({ ok: true }).then(function () { // 重启=旧会话停掉重新 start（断点持久化自动带回）
                const req = { tab_id: sess.tab_id, username: sess.username, relPath: sess.relPath };
                stop();
                return start(req);
            });
        default:
            return Promise.resolve({ ok: false, error: '未知调试操作：' + op });
    }
}

// ===== 断点设置（UI 行号槽点击；未调试时只写持久化，调试中同步适配器） =====
// req = {abs 已由 main 归口解析, lines}；lines 兼容 number[] 与 [{line, condition?, logMessage?}]
// （阶段一百六十四：条件断点/日志点——DAP 路 condition/logMessage 透传；Node V8 Inspector 仅
// 支持 condition（logMessage 为 VS Code 上层实现，此处丢弃）；verified 行号回推保持 number[] 兼容）
function setBreakpoints(abs, lines) {
    const clean = normBpLines(lines);
    bpSet(abs, clean);
    if (session && session.abs && String(session.abs).toLowerCase() === String(abs).toLowerCase()) {
        const sess = session;
        if (sess.insp && sess.ws) { // Node：Debugger.setBreakpointByUrl（file:/// 形式）
            let fileUrl = '';
            try { fileUrl = url.pathToFileURL(sess.abs).href; } catch (e) { /* 忽略，下方报错 */ }
            if (!fileUrl) return Promise.resolve({ ok: false, error: '路径无法转为 file URL' });
            const removes = [];
            sess.nodeBps.forEach(function (rec, bpId) {
                removes.push(inspectorSend(sess, 'Debugger.removeBreakpoint', { breakpointId: bpId }).catch(function () {}));
            });
            return Promise.all(removes).then(function () {
                sess.nodeBps = new Map();
                return Promise.all(clean.map(function (bp) {
                    return inspectorSend(sess, 'Debugger.setBreakpointByUrl', {
                        lineNumber: bp.line - 1, url: fileUrl, columnNumber: 0, condition: bp.condition || ''
                    }).then(function (r) {
                        if (r && r.breakpointId) sess.nodeBps.set(r.breakpointId, { line: bp.line });
                        return bp.line;
                    }).catch(function () { return bp.line; });
                }));
            }).then(function (kept) {
                return { ok: true, lines: kept };
            }).catch(function (e) {
                return { ok: false, error: (e && e.message) || '断点下发失败' };
            });
        }
        if (sess.dap) {
            return sess.dap.request('setBreakpoints', {
                source: { path: session.abs, name: path.basename(session.abs) },
                breakpoints: clean.map(function (bp) {
                    const d = { line: bp.line };
                    if (bp.condition) d.condition = bp.condition;
                    if (bp.logMessage) d.logMessage = bp.logMessage;
                    return d;
                }),
                sourceModified: false
            }).then(function (rb) {
                const verified = ((rb && rb.breakpoints) || []).map(function (b) { return b.line; });
                pushEvent({ tab_id: session.tab_id, type: 'breakpoints', lines: verified });
                return { ok: true, lines: verified };
            }).catch(function (e) {
                return { ok: false, error: (e && e.message) || '断点下发失败' };
            });
        }
    }
    return Promise.resolve({ ok: true, lines: clean.map(function (bp) { return bp.line; }) });
}

// ===== 查询（前端打开文件/刷新时同步状态与断点） =====
// lines 保持 number[] 兼容旧前端；bps 为对象数组（含条件/日志点元数据，阶段一百六十四）
function state(tabId) {
    const bps = !session ? [] : bpGet(session.abs);
    if (!session || String(session.tab_id) !== String(tabId || '')) {
        return { ok: true, active: false, status: '', breakpoints: [], bps: [] };
    }
    return {
        ok: true, active: true, status: session.status,
        breakpoints: bps.map(function (b) { return b.line; }), bps: bps
    };
}
function breakpointsFor(abs) {
    const bps = bpGet(abs);
    return { ok: true, lines: bps.map(function (b) { return b.line; }), bps: bps };
}

function shutdown() {
    try { stop(); } catch (e) {}
}

// onTabClosed 被调试文件标签关闭 → 联动停会话（main.js 经 browserManager.setTabCloseHook 挂入）
function onTabClosed(tabId) {
    if (session && String(session.tab_id) === String(tabId || '')) {
        try { stop(); } catch (e) {}
    }
}

module.exports = {
    setPathGuard: setPathGuard,
    setAgentEnvFn: setAgentEnvFn,
    setEventSink: setEventSink,
    setToolchainFn: setToolchainFn,
    start: start,
    stop: stop,
    cmd: cmd,
    setBreakpoints: setBreakpoints,
    state: state,
    breakpointsFor: breakpointsFor,
    bootstrapPython: bootstrapPython,
    bootstrapCpp: bootstrapCpp,
    isActive: isActive,
    onTabClosed: onTabClosed,
    shutdown: shutdown
};
