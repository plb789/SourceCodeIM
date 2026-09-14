// ===== 阶段九十：PC 端用户自定义 MCP 服务器管理器（TRAE 同款本地 stdio 执行） =====
// 职责：按用户管理本地 MCP stdio 子进程（initialize 握手 → tools/list 缓存 → tools/call 执行）。
// 配置与凭据仅存本机 userData/agent_mcp.json（main.js 归口读写），本模块只负责运行时：
//   1. 常驻会话：setConfig 后按用户名+服务器名拉起启用的 stdio 服务器，断线自动重启（有限退避）
//   2. 工具缓存：listTools(username) 返回上报服务端的工具清单（不含 env/command，凭据不出本机）
//   3. 工具调用：callTool(username, toolKey, params) 按 mcp_pc_<服务器>_<工具> 命名空间路由
//   4. 测试连接：testServer(cfg) 临时会话验证（不常驻），返回服务名/版本/工具清单/耗时
// 约束：仅支持 stdio（远程 sse/http 统一走管理端服务端通道）；结果文本 8000 字符封顶（与服务端命令输出同值）
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// 阶段一百一十三：PC 端自动安装的 uv 工具链目录（~/.im-mcp/bin，main.js 归口下载安装；
// spawn 时前置到 PATH 首位，fetch/sqlite 等 Python 系插件不依赖系统 PATH 即可拉起）
const TOOLCHAIN_BIN = path.join(os.homedir(), '.im-mcp', 'bin');

// buildEnv 构造子进程环境：process.env + 服务器 env + 工具链目录 PATH 前置（系统 PATH 保留在后）
function buildEnv(extra) {
    const base = Object.assign({}, process.env, extra || {});
    base.PATH = TOOLCHAIN_BIN + path.delimiter + (base.PATH || process.env.PATH || '');
    return base;
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'im-pc-client', version: '1.0.0' };
const TOOL_OUT_MAX_CHARS = 8000;          // 与 agent-executor 命令输出限额一致
const CALL_TIMEOUT_MS = 90 * 1000;        // 单工具调用超时（服务端挂起等待=服务端工具超时+15s，需小于其值）
const INIT_TIMEOUT_MS = 15 * 1000;        // 握手超时
const RESTART_DELAY_MS = 3 * 1000;        // 崩溃重启退避
const RESTART_MAX = 3;                    // 连续崩溃重启上限（超过置 error 等用户手动重连）
const MAX_SERVERS_PER_USER = 10;

// 会话表：key = username + '\u0000' + serverName → session
const sessions = {};

function key(username, serverName) {
    return String(username || '') + '\u0000' + String(serverName || '');
}

// ===== 会话生命周期 =====

// 创建会话（拉起子进程并完成握手+工具发现）
function createSession(username, cfg) {
    const session = {
        username: username,
        cfg: cfg,
        status: 'connecting',       // connecting / connected / error
        statusMsg: '',
        child: null,
        tools: [],                  // [{name, description, input_schema}]
        serverInfo: {},
        restarts: 0,
        pending: {},                // id → {resolve, reject, timer}
        buf: '',
        nextId: 1,
        dead: false
    };
    sessions[key(username, cfg.name)] = session;
    launch(username, session);
    return session;
}

function launch(username, session) {
    const cfg = session.cfg;
    let child;
    try {
        // Windows 下 .cmd/.bat 无法直接 spawn（EINVAL），经 cmd /C 转发（stdio 管道对孙进程同样生效）
        const isScript = /\.(cmd|bat)$/i.test(String(cfg.command || '').trim());
        child = isScript
            ? spawn('cmd.exe', ['/C', cfg.command].concat(cfg.args || []), {
                env: buildEnv(cfg.env),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            })
            : spawn(cfg.command, cfg.args || [], {
                env: buildEnv(cfg.env),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
    } catch (e) {
        session.status = 'error';
        session.statusMsg = '启动失败：' + (e.message || e);
        return;
    }
    session.child = child;
    session.buf = '';

    child.stdout.on('data', function (chunk) { onStdout(session, chunk); });
    child.stderr.on('data', function (chunk) {
        // stderr 仅截取尾部用于错误提示（服务器日志，不参与协议）
        const s = session.statusMsg = (session.statusMsg + String(chunk)).slice(-2000);
        void s;
    });
    child.on('error', function (e) {
        if (session.dead) return;
        session.status = 'error';
        session.statusMsg = mcpFriendlySpawnError(cfg.command, e);
    });
    child.on('exit', function (code) {
        if (session.dead) return;
        session.child = null;
        rejectAllPending(session, 'MCP 服务器进程已退出');
        if (session.status === 'connected' && session.restarts < RESTART_MAX) {
            // 运行中意外退出：有限次数自动重启
            session.restarts++;
            setTimeout(function () {
                if (!session.dead && sessions[key(username, cfg.name)] === session) {
                    launch(username, session);
                }
            }, RESTART_DELAY_MS);
        } else {
            session.status = 'error';
            session.statusMsg = '进程已退出（code=' + code + '）' + (session.restarts >= RESTART_MAX ? '，已达重启上限' : '');
        }
    });

    // 握手：initialize → initialized 通知 → tools/list
    rpc(session, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
    }, INIT_TIMEOUT_MS).then(function (result) {
        session.serverInfo = (result && result.serverInfo) || {};
        session.protocolVersion = (result && result.protocolVersion) || '';
        notify(session, 'notifications/initialized', {});
        return rpc(session, 'tools/list', {}, INIT_TIMEOUT_MS);
    }).then(function (result) {
        session.tools = normalizeTools(result && result.tools);
        session.status = 'connected';
        session.statusMsg = '';
        session.restarts = 0;
    }).catch(function (e) {
        session.status = 'error';
        session.statusMsg = '初始化失败：' + (e.message || e);
        killTree(session);
    });
}

// 结束会话（杀进程树 + 置 dead）
function disposeSession(session) {
    session.dead = true;
    rejectAllPending(session, 'MCP 服务器已停止');
    killTree(session);
    delete sessions[key(session.username, session.cfg.name)];
}

function killTree(session) {
    const child = session.child;
    if (!child) return;
    session.child = null;
    try {
        if (process.platform === 'win32') {
            // 杀整棵进程树（cmd /C 场景孙进程不会随父进程退出）
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
            child.kill('SIGTERM');
        }
    } catch (e) { /* 进程已退出则忽略 */ }
}

function rejectAllPending(session, msg) {
    Object.keys(session.pending).forEach(function (id) {
        clearTimeout(session.pending[id].timer);
        session.pending[id].reject(new Error(msg));
        delete session.pending[id];
    });
}

// ===== JSON-RPC over stdio（NDJSON） =====

function onStdout(session, chunk) {
    session.buf += String(chunk);
    for (;;) {
        const idx = session.buf.indexOf('\n');
        if (idx < 0) break;
        const line = session.buf.slice(0, idx).trim();
        session.buf = session.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.id === undefined || msg.id === null) continue; // 通知帧忽略
        const p = session.pending[msg.id];
        if (!p) continue;
        clearTimeout(p.timer);
        delete session.pending[msg.id];
        if (msg.error) p.reject(new Error(msg.error.message || ('code ' + msg.error.code)));
        else p.resolve(msg.result);
    }
}

function rpc(session, method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
        if (!session.child || session.dead) {
            reject(new Error('MCP 服务器未运行'));
            return;
        }
        const id = session.nextId++;
        const frame = { jsonrpc: '2.0', id: id, method: method };
        if (params !== undefined) frame.params = params;
        const timer = setTimeout(function () {
            delete session.pending[id];
            reject(new Error(method + ' 超时（' + Math.round(timeoutMs / 1000) + 's）'));
        }, timeoutMs);
        session.pending[id] = { resolve: resolve, reject: reject, timer: timer };
        try {
            session.child.stdin.write(JSON.stringify(frame) + '\n');
        } catch (e) {
            clearTimeout(timer);
            delete session.pending[id];
            reject(new Error('写入失败：' + (e.message || e)));
        }
    });
}

function notify(session, method, params) {
    try {
        session.child.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', method: method }, params ? { params: params } : {})) + '\n');
    } catch (e) { /* 忽略通知失败 */ }
}

// ===== 工具清单归一化 =====

function normalizeTools(raw) {
    const list = [];
    (raw || []).forEach(function (t) {
        if (!t || typeof t.name !== 'string' || !t.name) return;
        list.push({
            name: t.name,
            description: String(t.description || ''),
            input_schema: t.inputSchema || { type: 'object', properties: {} }
        });
        if (list.length >= 64) return; // 单服务器工具数上限（防清单爆炸）
    });
    return list;
}

// ===== 对外 API =====

// setConfig：main.js 在用户保存配置后调用，重建该用户的会话表（停用/删除的立即回收，新增/变更的重建）
function setConfig(username, servers) {
    const want = {};
    (servers || []).forEach(function (cfg) {
        if (!cfg || !cfg.name || !cfg.enabled) return;
        want[cfg.name] = cfg;
    });
    // 停掉不再需要/配置变更的会话
    Object.keys(sessions).forEach(function (k) {
        const s = sessions[k];
        if (s.username !== username) return;
        const w = want[s.cfg.name];
        if (!w || JSON.stringify([w.command, w.args, w.env]) !== JSON.stringify([s.cfg.command, s.cfg.args, s.cfg.env])) {
            disposeSession(s);
        } else {
            delete want[s.cfg.name]; // 已在跑且配置未变
        }
    });
    // 拉起新会话
    Object.keys(want).forEach(function (name) {
        if (Object.keys(sessions).filter(function (k) { return sessions[k].username === username; }).length >= MAX_SERVERS_PER_USER) return;
        createSession(username, want[name]);
    });
}

// 会话不存在时按需拉起（服务端任务调用到达但 PC 刚登录尚未 setConfig 的兜底）
function ensureSession(username, cfg) {
    let s = sessions[key(username, cfg.name)];
    if (!s) s = createSession(username, cfg);
    return s;
}

// listTools：上报服务端的工具清单（仅 name/description/input_schema，凭据不出本机）
function listTools(username) {
    const out = [];
    Object.keys(sessions).forEach(function (k) {
        const s = sessions[k];
        if (s.username !== username || s.status !== 'connected') return;
        s.tools.forEach(function (t) {
            out.push({
                server: s.cfg.name,
                tool: t.name,
                description: t.description,
                input_schema: t.input_schema
            });
        });
    });
    return out;
}

// 状态快照（设置面板刷新用）：[{name, status, statusMsg, toolCount}]
function status(username) {
    const out = [];
    Object.keys(sessions).forEach(function (k) {
        const s = sessions[k];
        if (s.username !== username) return;
        out.push({
            name: s.cfg.name,
            status: s.status,
            status_msg: s.statusMsg,
            tool_count: s.tools.length
        });
    });
    return out;
}

// callTool：按工具 key（mcp_pc_<服务器>_<工具>）调用；cfgGetter 由调用方注入配置查询（按需拉起兜底）
// 返回 Promise<{ok, output}>（output 以"错误："前缀表示工具级失败，与服务端执行器约定一致）
function callTool(username, toolKey, params, cfgGetter) {
    const rest = String(toolKey || '').slice('mcp_pc_'.length);
    const idx = rest.indexOf('_');
    if (idx <= 0) {
        return Promise.resolve({ ok: false, output: '错误：非法的本机 MCP 工具标识 ' + toolKey });
    }
    // 命名空间规整可能改写名称（哈希后缀），直接按会话内工具表反查服务器与真实工具名
    let hit = null;
    Object.keys(sessions).forEach(function (k) {
        const s = sessions[k];
        if (s.username !== username || hit) return;
        s.tools.forEach(function (t) {
            if (toolKey === pcToolKey(s.cfg.name, t.name)) hit = { session: s, tool: t.name };
        });
    });
    if (!hit) {
        // 会话未连上：按服务器名兜底建连后重查（规整算法一致，能查到）
        const serverGuess = rest.slice(0, idx);
        const cfg = cfgGetter ? cfgGetter(username, serverGuess) : null;
        if (cfg && cfg.enabled) {
            const s = ensureSession(username, cfg);
            if (s.status === 'connected') {
                s.tools.forEach(function (t) {
                    if (!hit && toolKey === pcToolKey(s.cfg.name, t.name)) hit = { session: s, tool: t.name };
                });
            }
        }
    }
    if (!hit) {
        return Promise.resolve({ ok: false, output: '错误：本机 MCP 服务器未连接或工具不存在（' + toolKey + '）' });
    }
    const s = hit.session;
    if (s.status !== 'connected' || !s.child) {
        return Promise.resolve({ ok: false, output: '错误：本机 MCP 服务器「' + s.cfg.name + '」未就绪（' + (s.statusMsg || s.status) + '）' });
    }
    return rpc(s, 'tools/call', { name: hit.tool, arguments: params || {} }, CALL_TIMEOUT_MS).then(function (result) {
        const parts = [];
        ((result && result.content) || []).forEach(function (c) {
            if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        });
        let output = parts.join('\n');
        if (output.length > TOOL_OUT_MAX_CHARS) output = output.slice(0, TOOL_OUT_MAX_CHARS) + '\n…（输出过长已截断）';
        if (result && result.isError) return { ok: false, output: '错误：' + (output || '工具执行失败') };
        return { ok: true, output: output || '（工具无文本输出）' };
    }).catch(function (e) {
        return { ok: false, output: '错误：本机 MCP 调用失败——' + (e.message || e) };
    });
}

// pcToolKey：与服务端 mcpToolKey 完全一致的命名空间算法（mcp_pc_<服务器>_<工具>）。
// 规整：保留 [A-Za-z0-9_-]，其余（含中文/点号，按码点）转下划线；未变更且 ≤55 直接返回；
// 否则截断 55 位后追加 FNV-1a(UTF-8 字节) 前 8 位十六进制后缀——双端算法不一致会导致
// 服务端注入的 key 与本机会话内工具表反查失败，改动任一侧必须同步另一侧
function mcpNormalizeRaw(raw) {
    let out = '';
    let changed = false;
    for (const ch of String(raw || '')) {
        const c = ch.codePointAt(0);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45) {
            out += ch;
        } else {
            out += '_';
            changed = true;
        }
    }
    return { name: out, changed: changed };
}
// 阶段一百一十二：spawn 失败友好提示——ENOENT = 命令不在系统 PATH，按命令类型给出安装指引
// （原文案仅回显 "spawn uvx ENOENT"，用户不知道该装什么；其余错误仍原样透传）
function mcpFriendlySpawnError(command, e) {
    if (e && e.code === 'ENOENT') {
        const cmd = String(command || '').trim().toLowerCase();
        if (cmd === 'uvx' || cmd === 'uv' || cmd === 'uvx.exe' || cmd === 'uv.exe') {
            return '未找到 uvx 命令：fetch/sqlite 等 Python 系插件需先安装 uv 工具链（PowerShell 执行 irm https://astral.sh/uv/install.ps1 | iex ，或 winget install astral-sh.uv），安装后重启本客户端';
        }
        if (cmd === 'python' || cmd === 'python3' || cmd === 'py') {
            return '未找到 python 命令：请先安装 Python（勾选加入 PATH）后重启本客户端';
        }
        if (cmd === 'npx' || cmd === 'node' || cmd === 'npm') {
            return '未找到 node 命令：请先安装 Node.js 后重启本客户端';
        }
        return '未找到命令「' + command + '」：请确认已安装并加入系统 PATH，或改用完整路径';
    }
    return '进程异常：' + ((e && e.message) || e);
}
function mcpFnv1aHex8(s) {
    const buf = Buffer.from(String(s || ''), 'utf8');
    let h = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
}
function pcToolKey(serverName, toolName) {
    const raw = 'mcp_pc_' + String(serverName || '') + '_' + String(toolName || '');
    const n = mcpNormalizeRaw(raw);
    const MAX_LEN = 55; // 与服务端一致：64 - 8（hash 后缀） - 1（连接符）
    if (!n.changed && n.name.length <= MAX_LEN) return n.name;
    let name = n.name;
    if (name.length > MAX_LEN) name = name.slice(0, MAX_LEN);
    return name + '_' + mcpFnv1aHex8(raw);
}

// testServer：临时会话验证（不常驻），返回 {ok, tools, elapsed_ms, server_name, server_version, protocol_version}
function testServer(cfg) {
    const started = Date.now();
    const username = '\u0000test\u0000' + mcpFnv1aHex8(JSON.stringify(cfg) + ':' + started);
    const session = createSession(username, cfg);
    return new Promise(function (resolve) {
        const deadline = Date.now() + INIT_TIMEOUT_MS;
        (function wait() {
            const s = sessions[key(username, cfg.name)];
            const elapsed = Date.now() - started;
            if (!s) { resolve({ ok: false, msg: '测试会话丢失' }); return; }
            if (s.status === 'connected') {
                const tools = s.tools.map(function (t) { return { name: t.name, description: t.description }; });
                disposeSession(s);
                resolve({
                    ok: true,
                    elapsed_ms: elapsed,
                    server_name: (s.serverInfo && s.serverInfo.name) || cfg.name,
                    server_version: (s.serverInfo && s.serverInfo.version) || '',
                    protocol_version: s.protocolVersion || '',
                    tools: tools
                });
                return;
            }
            if (s.status === 'error') {
                const msg = s.statusMsg || '连接失败';
                disposeSession(s);
                resolve({ ok: false, msg: msg });
                return;
            }
            if (Date.now() > deadline) {
                disposeSession(s);
                resolve({ ok: false, msg: '连接超时（' + Math.round(INIT_TIMEOUT_MS / 1000) + 's）' });
                return;
            }
            setTimeout(wait, 120);
        })();
    });
}

// disposeAll：应用退出全量回收（main.js before-quit 调用）
function disposeAll() {
    Object.keys(sessions).forEach(function (k) { disposeSession(sessions[k]); });
}

module.exports = { setConfig: setConfig, listTools: listTools, callTool: callTool, status: status, testServer: testServer, disposeAll: disposeAll, pcToolKey: pcToolKey };
