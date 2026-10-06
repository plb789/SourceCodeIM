// ===== 阶段九十：PC 端用户自定义 MCP 服务器管理器（TRAE 同款本地 stdio 执行） =====
// 职责：按用户管理本地 MCP stdio 子进程（initialize 握手 → tools/list 缓存 → tools/call 执行）。
// 配置与凭据仅存本机 userData/agent_mcp.json（main.js 归口读写），本模块只负责运行时：
//   1. 常驻会话：setConfig 后按用户名+服务器名拉起启用的 stdio 服务器，断线自动重启（有限退避）
//   2. 工具缓存：listTools(username) 返回上报服务端的工具清单（不含 env/command，凭据不出本机）
//   3. 工具调用：callTool(username, toolKey, params) 按 mcp_pc_<服务器>_<工具> 命名空间路由
//   4. 测试连接：testServer(cfg) 临时会话验证（不常驻），返回服务名/版本/工具清单/耗时
// 约束：仅支持 stdio（远程 sse/http 统一走管理端服务端通道）；结果文本 8000 字符封顶（与服务端命令输出同值）
'use strict';

// cross-spawn（TRAE CN integrations 扩展内嵌同款库，v7.0.6）：替代 child_process.spawn——
// Windows 下自动识别 .cmd/.bat 与裸 npx/npm 命令，经 cmd /d /s /c 中转并精细转义参数
// （% ^ & 等 cmd 元字符防护，posix 平台直通无影响）
const spawn = require('cross-spawn');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 阶段一百一十三：PC 端自动安装的 uv 工具链目录（~/.im-mcp/bin，main.js 归口下载安装；
// spawn 时前置到 PATH 首位，fetch/sqlite 等 Python 系插件不依赖系统 PATH 即可拉起）
const TOOLCHAIN_BIN = path.join(os.homedir(), '.im-mcp', 'bin');

// 阶段一百一十八：便携 Node 运行时目录（~/.im-mcp/node，node-runtime.js 归口下载安装）。
// npx/npm 等 Node 系命令解析到系统 PATH 或本目录（便携 node.exe/npx.cmd 均在根），
// spawn 时同样前置到 PATH——系统未装 Node 的电脑上 npx 系插件零依赖可用（TRAE CN 同款）
const NODE_RUNTIME_DIR = path.join(os.homedir(), '.im-mcp', 'node');

// 阶段一百二十：内置 gcc 编译环境目录（~/.im-mcp/gcc/bin，toolchain-manager.js 归口懒加载安装）。
// 仅前置 PATH（MCP 子进程如需调用 gcc/g++ 时可解析；INCLUDE/LIB 等编译环境变量不注入——MCP 插件无编译场景）
// 阶段一百二十一：自动扫描 ~/.im-mcp 全部工具链 bin（与 agent-executor buildAgentEnv 同构，后台新增 zip 工具链零代码可用）
// 阶段一百二十一：按声明定位——工具链 bin 归口 toolchain-manager.allToolchainBins（服务端 ExePaths 声明优先 +
//   默认探测兜底 + 外部目录探测），MCP 子进程与 Agent 任务环境严格同构，此处不再重复实现
const compilerManager = require('./toolchain-manager.js');

// buildEnv 构造子进程环境：process.env + 服务器 env + 工具链目录与便携 Node 目录 PATH 前置（系统 PATH 保留在后）
function buildEnv(extra) {
    const base = Object.assign({}, process.env, extra || {});
    base.PATH = TOOLCHAIN_BIN + path.delimiter + NODE_RUNTIME_DIR + path.delimiter + compilerManager.allToolchainBins().join(path.delimiter) + path.delimiter + (base.PATH || process.env.PATH || '');
    return base;
}

// ===== 阶段一百一十八：Node 系命令自动安装钩子（main.js 注入 node-runtime.ensureRuntime） =====
// 系统与便携运行时均无 node 时 spawn npx 必失败（ENOENT 或 cmd 内"不是内部或外部命令"），
// 捕获后触发安装器，成功原样重启会话——用户无感知（并发多会话共享同一安装 Promise）
let nodeInstaller = null; // () => Promise<{ok, msg}>

function setNodeRuntimeInstaller(fn) {
    nodeInstaller = typeof fn === 'function' ? fn : null;
}

// isNodeFamily 判断是否 Node 系命令（实体为 .cmd 批处理，Windows 需 cmd 中转且依赖 node 运行时）
function isNodeFamily(command) {
    const base = path.basename(String(command || '').trim()).toLowerCase();
    return ['npx', 'npm', 'pnpm', 'yarn'].indexOf(base) !== -1;
}

// ===== 阶段一百一十九：uv 工具链自动安装钩子（main.js 注入 uvEnsureRuntime） =====
// uvx/uv 系（Python 系 MCP 插件 fetch/sqlite 等）spawn 前预检 PATH 解析不到时触发安装器，
// 成功原样重启会话——与 Node 系钩子（setNodeRuntimeInstaller）同构，并发多会话共享 main.js 内同一安装 Promise
let uvToolchainInstaller = null; // () => Promise<{ok, msg}>

function setUvToolchainInstaller(fn) {
    uvToolchainInstaller = typeof fn === 'function' ? fn : null;
}

// isUvFamily 判断是否 uv 系命令（uvx 运行 Python 系 MCP 服务器插件，uv 为其基础工具）
function isUvFamily(command) {
    const base = path.basename(String(command || '').trim()).toLowerCase();
    return ['uvx', 'uv', 'uvx.exe', 'uv.exe'].indexOf(base) !== -1;
}

// nodeCmdResolved：检测 Node 系命令在当前 PATH（含便携运行时目录）下能否解析到可执行文件。
// 原实现：依赖子进程 stderr 出现"不是内部或外部命令"后判装缺失——实测 stderr 异步刷盘晚于 exit
// 事件，判定时拿不到特征文本，且握手拒绝抢先置 error 产生竞态；改为 spawn 前同步预检，确定性触发
function nodeCmdResolved(command) {
    const dirs = String(buildEnv(null).PATH || '').split(path.delimiter);
    const base = path.basename(String(command || '').trim()).toLowerCase();
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
    for (let i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        for (let j = 0; j < exts.length; j++) {
            try { if (fs.existsSync(path.join(dirs[i], base + exts[j]))) return true; } catch (e) { }
        }
    }
    return false;
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'im-pc-client', version: '1.0.0' };
const TOOL_OUT_MAX_CHARS = 8000;          // 与 agent-executor 命令输出限额一致
const CALL_TIMEOUT_MS = 90 * 1000;        // 单工具调用超时（服务端挂起等待=服务端工具超时+15s，需小于其值）
const INIT_TIMEOUT_MS = 15 * 1000;        // 握手超时
const UV_INIT_TIMEOUT_MS = 120 * 1000;    // 阶段一百一十九：uv 系握手超时（uvx 首次拉起插件需联网下载 Python 包+创建临时环境，远超 15s）
const RUNTIME_INSTALL_WAIT_MS = 180 * 1000; // 便携 Node 自动安装等待上限（下载 35MB + 解压，3 分钟兜底）
const RESTART_DELAY_MS = 3 * 1000;        // 崩溃重启退避
const RESTART_MAX = 3;                    // 连续崩溃重启上限（超过置 error 等用户手动重连）
const MAX_SERVERS_PER_USER = 10;

// ===== 阶段一百一十四：内置 Computer Use 服务器（TRAE Built-in 同款：随客户端分发，不占用户配置额） =====
// 本地 stdio MCP Server（mcp-computer-use.js），让 AI 通过截图+键鼠操作桌面 GUI；可整体启停，不入 agent_mcp.json
// 运行时用 Electron 自身（process.execPath + ELECTRON_RUN_AS_NODE=1，打包后等效纯 Node）——
// 不依赖系统 node 命令（打包环境 node 不在 PATH，spawn ENOENT 是内置服务器连接错误的根因）
const BUILTIN_SERVERS = [
    {
        name: 'computer-use',
        title: 'Computer Use（内置）',
        description: '让 AI 操作桌面 GUI：截屏查看画面、点击/滚动/拖拽/键入/发送按键、列出与启动应用',
        command: process.execPath,
        args: [path.join(__dirname, 'mcp-computer-use.js')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: true,
        builtin: true
    }
];
let builtinEnabled = true; // 内置服务器总开关（main.js 经 setBuiltinEnabled 归口，存 mcp store 的 __builtin 键）

function setBuiltinEnabled(v) {
    builtinEnabled = !!v;
    return builtinEnabled;
}

function builtinConfigs() {
    return builtinEnabled ? BUILTIN_SERVERS.map(function (c) { return Object.assign({}, c); }) : [];
}

// ===== 阶段一百一十六：项目级 MCP（TRAE 同款）——自动从项目根目录 .im/agent_mcp.json 加载 =====
// loader 由 main.js 注入（读 <userRoot(username)>/.im/agent_mcp.json 解析归一化）；开关状态存 mcp store __projMcp 键
let projectEnabled = false;
let projectLoader = null;
const lastServersByUsername = {}; // 各用户最近一次 setConfig 的用户配置（项目开关切换时按此重建会话）

function setProjectMcp(enabled, loader) {
    projectEnabled = !!enabled;
    if (loader) projectLoader = loader;
    // 全部在线用户重建会话（setConfig 内部自动合并项目级配置）
    Object.keys(lastServersByUsername).forEach(function (uname) {
        setConfig(uname, lastServersByUsername[uname]);
    });
}

function projectConfigs(username) {
    if (!projectEnabled || !projectLoader) return [];
    try {
        const list = projectLoader(username) || [];
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return []; // 项目文件解析失败静默跳过（status IPC 会给出错误文本供面板显示）
    }
}

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

// needsCmdWrap 已移除：原手写 cmd.exe 中转判定升级为 cross-spawn 库（TRAE CN 同款，见文件头说明）——
// 库内部自动检测 .cmd/.bat/裸命令并中转，参数转义更完备（实测两者生成的 cmd 开关 /d /s /c 完全一致）
// 原实现：仅按命令字符串后缀 .cmd/.bat 判定——裸命令 npx/npm/pnpm/yarn 不匹配，走直接 spawn，
// 而这些工具在 Windows 上是 .cmd 批处理文件（无 .exe），CreateProcess 只认 .exe → 必然 ENOENT，
// 且 Node ≥20 对无 shell 直接 spawn .cmd 返回 EINVAL（安全策略），即使写全路径也跑不起来（两者均已实测复现）

// autoInstallNode：Node 系命令启动失败（系统与便携运行时均无 node）时触发便携 Node 自动安装，
// 成功后原样重启会话——用户无感知；仅尝试一次（nodeInstallTried 标记）防失败循环
// 返回 true 表示已接管（调用方不再置 error），false 表示无安装器或已尝试过（走原友好报错）
function autoInstallNode(username, session) {
    if (session.nodeInstallTried || !nodeInstaller) return false;
    session.nodeInstallTried = true;
    session.status = 'connecting';
    session.waitRuntimeInstall = true; // testServer 据此动态放宽等待上限（下载 35MB 远超常规握手 15s）
    session.statusMsg = '未检测到 Node.js，正在自动安装便携运行时（约 35MB，视网速需 1-2 分钟）…';
    nodeInstaller().then(function (r) {
        if (session.dead) return;
        if (r && r.ok) {
            session.statusMsg = 'Node 运行时安装完成，正在连接…';
            launch(username, session); // 安装成功原样重启：buildEnv 已前置便携目录，npx 可用
        } else {
            session.waitRuntimeInstall = false;
            session.status = 'error';
            session.statusMsg = 'Node 运行时自动安装失败：' + ((r && r.msg) || '未知原因') + '（可手动安装 Node.js 后重试）';
        }
    });
    return true;
}

// autoInstallUv：uv 系命令启动失败（系统与工具链目录均无 uvx）时触发 uv 工具链自动安装，
// 成功后原样重启会话——用户无感知；仅尝试一次（uvInstallTried 标记）防失败循环
// 返回 true 表示已接管（调用方不再置 error），false 表示无安装器或已尝试过（走原友好报错）
function autoInstallUv(username, session) {
    if (session.uvInstallTried || !uvToolchainInstaller) return false;
    session.uvInstallTried = true;
    session.status = 'connecting';
    session.waitRuntimeInstall = true; // testServer 据此动态放宽等待上限（下载 uv zip 远超常规握手 15s）
    session.statusMsg = '未检测到 uv 工具链，正在自动安装 uv（fetch/sqlite 等 Python 系插件的运行环境，下载视网速需 1-2 分钟）…';
    uvToolchainInstaller().then(function (r) {
        if (session.dead) return;
        if (r && r.ok) {
            session.statusMsg = 'uv 工具链安装完成，正在连接…';
            launch(username, session); // 安装成功原样重启：buildEnv 已前置 ~/.im-mcp/bin，uvx 可用
        } else {
            session.waitRuntimeInstall = false;
            session.status = 'error';
            session.statusMsg = 'uv 工具链自动安装失败：' + ((r && r.msg) || '未知原因') + '（可手动安装 uv 后重试）';
        }
    });
    return true;
}

function launch(username, session) {
    const cfg = session.cfg;
    // Node 系命令且 PATH 上解析不到（系统未装 + 便携运行时未装）：先自动安装便携运行时再启动。
    // spawn 前同步预检（确定性），成功后 autoInstallNode 内部会原样重启本会话
    if (isNodeFamily(cfg.command) && !nodeCmdResolved(cfg.command) && autoInstallNode(username, session)) return;
    // uv 系命令同理：PATH（含 ~/.im-mcp/bin 工具链目录）解析不到 uvx/uv 时先自动安装 uv 工具链再启动
    // （nodeCmdResolved 为通用 PATH 解析预检：按命令名在 buildEnv 的 PATH 目录序列中查找可执行文件）
    if (isUvFamily(cfg.command) && !nodeCmdResolved(cfg.command) && autoInstallUv(username, session)) return;
    // uv 系冷启动提示：uvx 第一次拉起插件时需联网下载 Python 包并创建临时虚拟环境，
    // 耗时可能远超常规握手（包名写错等异常 uvx 会秒退报错，不受此长等待影响）
    if (isUvFamily(cfg.command)) session.statusMsg = '正在启动 uvx（首次运行需准备 Python 包环境，可能需 1-2 分钟）…';
    let child;
    try {
        // cross-spawn 自动中转（.cmd/.bat/裸 npx 经 cmd /d /s /c，stdio 管道对孙进程同样生效）
        // cwd 固定用户主目录：否则子进程继承主进程工作目录（打包部署后的 bin），异常退出残留时
        // 会把 bin 目录锁死导致打包脚本无法清理（实测：目录被当作工作目录时无法删除，哪怕为空）
        child = spawn(cfg.command, cfg.args || [], {
            cwd: os.homedir(), // 原实现：未设置 cwd，子进程继承主进程工作目录
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
        // errTail 独立留存：statusMsg 会被退出处理器覆盖，初始化失败提示需要单独取服务器输出尾部
        session.errTail = ((session.errTail || '') + String(chunk)).slice(-800);
        const s = session.statusMsg = (session.statusMsg + String(chunk)).slice(-2000);
        void s;
    });
    child.on('error', function (e) {
        if (session.dead) return;
        // Node 系命令 ENOENT（系统与便携运行时均无 node）：先尝试自动安装便携运行时
        if (e && e.code === 'ENOENT' && isNodeFamily(cfg.command) && autoInstallNode(username, session)) return;
        // uv 系命令 ENOENT（系统与工具链目录均无 uvx）：先尝试自动安装 uv 工具链
        if (e && e.code === 'ENOENT' && isUvFamily(cfg.command) && autoInstallUv(username, session)) return;
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
            // cmd 中转场景下命令不存在（如未装 Node）：错误在 stderr（"不是内部或外部命令"）——
            // Node 系命令先尝试自动安装便携运行时（npx.cmd 在 cmd 内找不到 node 时以此形态报错）
            if (/不是内部或外部命令|is not recognized/i.test(session.statusMsg)) {
                if (isNodeFamily(cfg.command) && autoInstallNode(username, session)) return;
                session.statusMsg = mcpFriendlySpawnError(cfg.command, { code: 'ENOENT' });
            } else {
                session.statusMsg = '进程已退出（code=' + code + '）' + (session.restarts >= RESTART_MAX ? '，已达重启上限' : '');
            }
        }
    });

    // 握手：initialize → initialized 通知 → tools/list
    // 阶段一百一十九：uv 系用放宽的握手超时（uvx 首次运行需下载 Python 包，见 UV_INIT_TIMEOUT_MS）
    const initTimeoutMs = isUvFamily(cfg.command) ? UV_INIT_TIMEOUT_MS : INIT_TIMEOUT_MS;
    rpc(session, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
    }, initTimeoutMs).then(function (result) {
        session.serverInfo = (result && result.serverInfo) || {};
        session.protocolVersion = (result && result.protocolVersion) || '';
        notify(session, 'notifications/initialized', {});
        return rpc(session, 'tools/list', {}, initTimeoutMs);
    }).then(function (result) {
        session.tools = normalizeTools(result && result.tools);
        session.status = 'connected';
        session.statusMsg = '';
        session.restarts = 0;
    }).catch(function (e) {
        session.status = 'error';
        let msg = '初始化失败：' + (e.message || e);
        if (/进程已退出/.test(String(msg))) {
            // 第三方包常静默崩溃（实测如 mysql 类插件数据库认证失败时 stderr 为空）——给出排查方向
            const tail = String(session.errTail || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean)[0];
            msg += tail
                ? '——服务器输出：' + tail.slice(0, 200)
                : '（无错误输出。常见原因：npm 包名不存在、数据库等外部服务认证失败、端口被占用；可将"启动命令+参数"在终端单独运行查看真实报错）';
        }
        session.statusMsg = msg;
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
// 阶段一百一十四：内置 Computer Use 不入用户配置文件，在此合并（用户配置删改不影响内置服务器）
function setConfig(username, servers) {
    lastServersByUsername[username] = servers || []; // 阶段一百一十六：留存以便项目开关切换时重建
    const want = {};
    builtinConfigs().forEach(function (cfg) { want[cfg.name] = cfg; });
    // 阶段一百一十六：项目级配置次优先合并（用户配置后写覆盖同名，与 TRAE 项目级语义一致）
    projectConfigs(username).forEach(function (cfg) {
        if (!cfg || !cfg.name) return;
        want[cfg.name] = cfg;
    });
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

// 状态快照（设置面板刷新用）：[{name, status, statusMsg, toolCount, builtin}]
function status(username) {
    const out = [];
    Object.keys(sessions).forEach(function (k) {
        const s = sessions[k];
        if (s.username !== username) return;
        out.push({
            name: s.cfg.name,
            status: s.status,
            status_msg: s.statusMsg,
            tool_count: s.tools.length,
            builtin: s.cfg.builtin === true,
            project: s.cfg.project === true // 阶段一百一十六：项目级来源标记（列表行显示「项目」标签）
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
        let cfg = cfgGetter ? cfgGetter(username, serverGuess) : null;
        if (!cfg && serverGuess === 'computer-use') {
            cfg = builtinConfigs().filter(function (c) { return c.name === 'computer-use'; })[0] || null; // 内置服务器不在用户配置，单独兜底
        }
        if (!cfg) {
            // 阶段一百一十六：项目级服务器兜底建连（与内置同思路，按需重读项目文件）
            projectConfigs(username).forEach(function (c) {
                if (!cfg && c.name === serverGuess) cfg = c;
            });
        }
        if (cfg && (cfg.enabled || cfg.builtin)) {
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
            // 阶段一百一十四：ImageContent（Computer Use 截图）转为内联标记——服务端在截断前抽出并注入多模态消息
            if (c && c.type === 'image' && c.data) {
                parts.push('[[MCP_IMAGE:data:' + (c.mimeType || 'image/png') + ';base64,' + c.data + ']]');
            }
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
            return '未找到 uvx 命令：uv 工具链自动安装未成功（未注入安装器或已尝试失败），请检查网络后重试，或手动安装 uv（PowerShell 执行 irm https://astral.sh/uv/install.ps1 | iex ，或 winget install astral-sh.uv）后重启本客户端';
        }
        if (cmd === 'python' || cmd === 'python3' || cmd === 'py') {
            return '未找到 python 命令：请先安装 Python（勾选加入 PATH）后重启本客户端';
        }
        if (cmd === 'npx' || cmd === 'node' || cmd === 'npm') {
            return '未找到 node 命令：便携 Node 运行时自动安装未成功（未注入安装器或已尝试失败），请检查网络后重试，或手动安装 Node.js 后重启本客户端';
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
    // 阶段一百一十九：uv 系等待上限同步放宽（与握手超时同值，覆盖首次运行下载 Python 包的冷启动）
    const initWaitMs = isUvFamily(cfg.command) ? UV_INIT_TIMEOUT_MS : INIT_TIMEOUT_MS;
    return new Promise(function (resolve) {
        let deadline = Date.now() + initWaitMs;
        (function wait() {
            const s = sessions[key(username, cfg.name)];
            const elapsed = Date.now() - started;
            // 便携 Node 自动安装期间动态放宽等待上限（下载 35MB 远超常规握手 15s，原实现会误报超时）
            if (s && s.waitRuntimeInstall && deadline - Date.now() < INIT_TIMEOUT_MS) {
                deadline = Date.now() + RUNTIME_INSTALL_WAIT_MS;
            }
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
                resolve({ ok: false, msg: '连接超时（' + Math.round(initWaitMs / 1000) + 's）' });
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

module.exports = { setConfig: setConfig, listTools: listTools, callTool: callTool, status: status, testServer: testServer, disposeAll: disposeAll, pcToolKey: pcToolKey, setBuiltinEnabled: setBuiltinEnabled, builtinConfigs: builtinConfigs, setProjectMcp: setProjectMcp, setNodeRuntimeInstaller: setNodeRuntimeInstaller, setUvToolchainInstaller: setUvToolchainInstaller };
