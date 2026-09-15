// toolchain-manager.js - 阶段一百二十：Agent C/C++ 编译环境管理器（纯 Node 模块，不依赖 Electron API，可独立测试）
// 职责：为 Agent 任务的 C/C++ 编译需求归口准备本地编译环境，四级探测优先级（系统已有编译器零下载最优先）：
//   ① 系统编译器：MSVC（vswhere 定位 VS + vcvarsall 提取环境变量并缓存）/ 系统 gcc / clang（where 探测）
//   ② 内置裁剪版 gcc：~/.im-mcp/gcc（w64devkit 裁剪包，gcc/g++/make/gdb/ccache，64 位，解压约 358MB）
//   ③ 本地 zip：bundled\gcc-toolchain.zip（开发态构建缓存）/ resources\gcc-toolchain.zip（随安装包分发）
//   ④ 在线下载：服务端静态托管 <SERVER_BASE>static/gcc-toolchain.zip（SHA256 校验后解压）
// 设计约束（与 node-runtime.js/uv 双通道供给同构）：
//   1. 探测结果缓存 ~/.im-mcp/compiler-detect.json（24h 过期），避免每次任务重复扫描系统
//   2. 并发调用共享同一次安装 Promise（多任务同时触发编译只下载一次）
//   3. 所有子进程 cwd 固定用户主目录（防 CWD 锁死打包部署目录）；无管理员权限、不改系统 PATH

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');

// 阶段一百二十一：模块级 logger（此前 runInstallerScript 沙箱的 ctx.logger/console.log 引用未定义的 logger——
//   存量 rust 脚本未触雷纯属巧合（脚本内未打印日志），admin 自定义脚本一旦调用即 ReferenceError。
//   归口 console 输出，Electron 主进程控制台/终端可见；纯 Node 独立测试亦可跑）
const logger = {
    info: function () { console.log('[toolchain]', Array.prototype.join.call(arguments, ' ')); },
    warn: function () { console.warn('[toolchain]', Array.prototype.join.call(arguments, ' ')); },
    error: function () { console.error('[toolchain]', Array.prototype.join.call(arguments, ' ')); }
};

// ===== 目录与下载归口 =====
const IM_MCP_DIR = path.join(os.homedir(), '.im-mcp');
const GCC_DIR = path.join(IM_MCP_DIR, 'gcc');                    // 内置 gcc 工具链根目录
const GCC_BIN_DIR = path.join(GCC_DIR, 'bin');                   // PATH 前置用
const GCC_EXE = path.join(GCC_BIN_DIR, 'gcc.exe');
const DETECT_CACHE_FILE = path.join(IM_MCP_DIR, 'compiler-detect.json');   // 系统编译器探测缓存
const MSVC_ENV_CACHE_FILE = path.join(IM_MCP_DIR, 'compiler-msvc-env.json'); // vcvarsall 环境变量快照缓存

// 服务端基地址（main.js 启动时注入其 SERVER_URL，与登录服务器同源——静态托管路径 cfg.WebDir 之下）
// 缺省与 main.js 的 SERVER_URL 同默认值；注入后 URL = base + 'static/gcc-toolchain.zip'
let serverBase = 'http://localhost:8888/';
function setServerBase(url) {
    const u = String(url || '').trim();
    if (u) serverBase = u.endsWith('/') ? u : u + '/';
}

// 内置裁剪版 gcc zip 的 SHA256（打包分发与在线下载同源同包；工具链重裁时同步更新此值）
const GCC_ZIP_SHA256 = '24D791013B375E02D7B4725BC2566AB91ED0F877570CB69BC2F57F847BBD271A';
// 下载超时：裁剪包约 89MB，按 512KB/s 最低网速兜底放宽（node/uv 的 120s 级别远不够）
const GCC_DOWNLOAD_TIMEOUT_MS = 600 * 1000;
const GCC_DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000; // 单次 read 空闲超时（60 秒无数据判定卡死换源/失败）

// ===== 探测结果缓存（24h 过期） =====
const DETECT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function detectCacheRead() {
    try {
        const raw = JSON.parse(fs.readFileSync(DETECT_CACHE_FILE, 'utf8'));
        if (raw && raw.ts && (Date.now() - raw.ts) < DETECT_CACHE_TTL_MS) return raw.result || null;
    } catch (e) { }
    return null;
}

function detectCacheWrite(result) {
    try {
        fs.mkdirSync(IM_MCP_DIR, { recursive: true });
        fs.writeFileSync(DETECT_CACHE_FILE, JSON.stringify({ ts: Date.now(), result: result }, null, 2));
    } catch (e) { }
}

// ===== 阶段一百二十一：服务端 ExePaths 声明缓存（"按声明定位"——服务端下发优先，默认探测兜底） =====
// serverBase 注入后 main.js 调 toolchainRefreshExePaths 后台拉 /api/toolchains 刷新本缓存；
// 磁盘缓存 24h TTL，主进程启动即同步可用（离线/拉取失败用上次缓存，完全无缓存时回退 DEFAULT_EXE_PATHS 注册表）
const EXE_PATHS_CACHE_FILE = path.join(IM_MCP_DIR, 'toolchain-exepaths.json');
let serverExePaths = null; // { install_dir: [exePath...] } 服务端声明的 exe 路径表（内存镜像）

function exePathsCacheRead() {
    if (serverExePaths) return serverExePaths;
    serverExePaths = {};
    try {
        const raw = JSON.parse(fs.readFileSync(EXE_PATHS_CACHE_FILE, 'utf8'));
        if (raw && raw.ts && (Date.now() - raw.ts) < DETECT_CACHE_TTL_MS && raw.map) serverExePaths = raw.map;
    } catch (e) { }
    return serverExePaths;
}

function exePathsCacheWrite(map) {
    serverExePaths = map || {};
    try {
        fs.mkdirSync(IM_MCP_DIR, { recursive: true });
        fs.writeFileSync(EXE_PATHS_CACHE_FILE, JSON.stringify({ ts: Date.now(), map: serverExePaths }));
    } catch (e) { }
}

// setToolchainExePaths：服务端工具链清单注入（toolchainRefreshExePaths 拉取后调用）。
// 以 install_dir（缺省 name，即 ~/.im-mcp/<install_dir> 磁盘目录名）为键，exe_paths 须为非空 JSON 数组
function setToolchainExePaths(list) {
    const map = {};
    (list || []).forEach(function (tc) {
        const nm = String((tc && tc.name) || '').trim();
        if (!nm) return;
        let arr = null;
        try { arr = JSON.parse((tc && tc.exe_paths) || 'null'); } catch (e) { }
        if (!Array.isArray(arr) || !arr.length) return;
        const dir = String((tc && tc.install_dir) || '').trim() || nm;
        // 同 install_dir 多条目（如 clang/zig 复用 gcc 的 zip 与目录）合并声明，而非互相覆盖
        map[dir] = (map[dir] || []).concat(arr.map(function (x) { return String(x); }));
    });
    exePathsCacheWrite(map);
    return map;
}

// toolchainRefreshExePaths：后台从服务端拉公开清单刷新声明缓存（main.js 启动后调用；失败静默）
function toolchainRefreshExePaths() {
    return new Promise(function (resolve) {
        const url = serverBase + 'api/toolchains';
        const mod = url.startsWith('https:') ? https : require('http');
        const req = mod.get(url, { headers: { 'User-Agent': 'im-pc-client' }, timeout: 30000 }, function (resp) {
            if (resp.statusCode !== 200) { resp.resume(); resolve({ ok: false, msg: 'HTTP ' + resp.statusCode }); return; }
            let body = '';
            resp.on('data', function (c) { body += c; });
            resp.on('end', function () {
                try {
                    const j = JSON.parse(body);
                    const list = (j && j.data && j.data.toolchains) || j.toolchains || [];
                    setToolchainExePaths(list);
                    resolve({ ok: true });
                } catch (e) { resolve({ ok: false, msg: String((e && e.message) || e) }); }
            });
        });
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ ok: false, msg: String((e && e.message) || e) }); });
    });
}

// ===== MSVC 环境变量快照缓存（键=vcvarsall 路径，跨任务复用免重跑 bat；文件丢失/超时重提取） =====
function msvcEnvCacheRead(vcvarsPath) {
    try {
        const raw = JSON.parse(fs.readFileSync(MSVC_ENV_CACHE_FILE, 'utf8'));
        const rec = raw && raw[vcvarsPath];
        if (rec && rec.ts && (Date.now() - rec.ts) < DETECT_CACHE_TTL_MS && rec.env) return rec.env;
    } catch (e) { }
    return null;
}

function msvcEnvCacheWrite(vcvarsPath, env) {
    try {
        fs.mkdirSync(IM_MCP_DIR, { recursive: true });
        let all = {};
        try { all = JSON.parse(fs.readFileSync(MSVC_ENV_CACHE_FILE, 'utf8')) || {}; } catch (e) { }
        all[vcvarsPath] = { ts: Date.now(), env: env };
        fs.writeFileSync(MSVC_ENV_CACHE_FILE, JSON.stringify(all, null, 2));
    } catch (e) { }
}

// ===== 子进程执行辅助（execFile Promise 化，超时强杀） =====
function execFileP(file, args, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        execFile(file, args, {
            cwd: os.homedir(), // cwd 固定主目录：防继承主进程工作目录锁死打包部署目录
            windowsHide: true,
            timeout: opts.timeout || 15000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'utf8'
        }, function (err, stdout, stderr) {
            resolve({ err: err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

// ===== ① MSVC 探测（vswhere 系统固定安装器路径，仅探测带 C++ 工具集的最新安装） =====
const VSWHERE_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const MSVC_COMPONENT = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';

async function detectMsvc() {
    if (!fs.existsSync(VSWHERE_PATH)) return null;
    // -latest 取最新安装；-products * 含 Build Tools（无 IDE 也认）；-property 只输出安装路径
    const r = await execFileP(VSWHERE_PATH, ['-latest', '-products', '*',
        '-requires', MSVC_COMPONENT, '-property', 'installationPath'], { timeout: 15000 });
    const vsPath = (r.stdout || '').trim().split(/\r?\n/)[0];
    if (!vsPath || !fs.existsSync(vsPath)) return null;
    // cl.exe 按 MSVC 工具集版本号取最大（VC\Tools\MSVC\14.xx.xxxxx\bin\Hostx64\x64\cl.exe）
    const msvcRoot = path.join(vsPath, 'VC', 'Tools', 'MSVC');
    let clDir = null;
    try {
        const vers = fs.readdirSync(msvcRoot).filter(function (d) {
            return fs.existsSync(path.join(msvcRoot, d, 'bin', 'Hostx64', 'x64', 'cl.exe'));
        }).sort().reverse(); // 字典序对 14.xx 版本号即数值序
        if (vers.length) clDir = path.join(msvcRoot, vers[0], 'bin', 'Hostx64', 'x64');
    } catch (e) { }
    if (!clDir) return null;
    const vcvars = path.join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
    // clVersion = MSVC 工具集版本目录名（clDir 上三级：x64→Hostx64→bin→14.xx.xxxxx）
    return { vsPath: vsPath, clDir: clDir, vcvarsPath: fs.existsSync(vcvars) ? vcvars : '', clVersion: path.basename(path.dirname(path.dirname(path.dirname(clDir)))) };
}

// vcvarsall x64 环境提取：跑一次 bat 后 set 快照，与当前 process.env 对比取编译相关增量键。
// 结果缓存跨任务复用（cl 直跑必需 INCLUDE/LIB/LIBPATH，PATH 注入 cl 目录即可，完整 PATH 快照过大不注入）
const MSVC_ENV_KEYS = ['INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSdkVersion', 'UCRTVersion', 'UniversalCRTSdkDir'];
const MSVC_PATH_KEYS = ['DevCmdDir'];

async function extractMsvcEnv(msvc) {
    if (!msvc.vcvarsPath) return null;
    const cached = msvcEnvCacheRead(msvc.vcvarsPath);
    if (cached) return cached;
    // 经临时 bat 执行：vcvarsall 路径带空格，cmd /s 嵌套引号会被剥离导致路径断裂（实测坑），
    // bat 文件内引号语义清晰无歧义；输出 UTF-8（chcp 65001），set 列出注入后的全部环境变量
    const probeBat = path.join(os.tmpdir(), 'im-vcvars-probe.bat');
    const batContent = '@echo off\r\nchcp 65001>nul\r\ncall "' + msvc.vcvarsPath + '" x64>nul 2>&1\r\nset\r\n';
    try { fs.writeFileSync(probeBat, batContent, { encoding: 'utf8' }); } catch (e) { return null; }
    const out = await new Promise(function (resolve) {
        // cwd 固定主目录（防 CWD 锁死部署目录）；bat 由 cmd /c 直调（无嵌套引号问题）
        const ps = spawn('cmd', ['/d', '/c', probeBat], { cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        ps.stdout.on('data', function (d) { buf += d.toString('utf8'); });
        ps.on('close', function () { resolve(buf); });
        ps.on('error', function () { resolve(''); });
    });
    if (!out) return null;
    const env = {};
    const lines = out.split(/\r?\n/);
    const pathHits = [];
    for (let i = 0; i < lines.length; i++) {
        const eq = lines[i].indexOf('=');
        if (eq <= 0) continue;
        const key = lines[i].slice(0, eq).toUpperCase(); // 环境变量名大小写不敏感，统一大写匹配
        const val = lines[i].slice(eq + 1);
        if (MSVC_ENV_KEYS.indexOf(key) !== -1) env[key] = val;
        else if (key === 'PATH') { /* PATH 单独处理：仅提取 cl/MSVC 相关目录段 */ }
        else if (MSVC_PATH_KEYS.indexOf(key) !== -1) env[key] = val;
    }
    // PATH 提取：仅保留与编译相关目录（clDir、WindowsSdk、UCRT、MSBuild 等），避免快照整条系统 PATH；
    // Windows 环境变量名大小写不敏感（set 输出实际为 Path=），统一小写前缀匹配
    const pathLine = lines.filter(function (l) { return l.toLowerCase().startsWith('path='); })[0] || '';
    if (pathLine) {
        const segs = pathLine.slice(5).split(';');
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (!s) continue;
            if (s.toLowerCase().indexOf(msvc.vsPath.toLowerCase()) !== -1 ||
                /windows kits|msbuild|ucrt/i.test(s)) pathHits.push(s);
        }
    }
    env.__PATH_EXTRAS = pathHits.join(path.delimiter);
    if (!env.INCLUDE || !env.LIB) return null; // 关键变量缺失=环境异常，不入缓存
    msvcEnvCacheWrite(msvc.vcvarsPath, env);
    return env;
}

// ===== ① 系统 gcc / clang 探测（where 命令，命中即说明系统 PATH 可直接解析） =====
async function whereExe(name) {
    const r = await execFileP('where', [name], { timeout: 10000 });
    const first = (r.stdout || '').trim().split(/\r?\n/)[0];
    return (r.err || !first) ? null : first;
}

// ===== ②③④ 内置裁剪版 gcc 供给（与 node-runtime 同构：已装→本地 zip→在线下载） =====
let gccInstalling = false;
let gccInstallPromise = null;
// 阶段一百二十一：按工具名隔离的安装状态表（installFromMarket 用，防并发串扰）
const installState = {};

function isGccInstalled() { return fs.existsSync(GCC_EXE); }

// 本地 zip 查找：bundled（开发态构建缓存）→ resources（electron-builder extraResources 随安装包）。
// process.resourcesPath 仅 Electron 运行态存在，纯 Node 调试自动跳过
// 阶段一百二十一：按工具名找本地 zip（bundled/<name>-toolchain.zip），go→go-toolchain.zip / git→git-toolchain.zip
function findToolLocalZip(name) {
    const bare = String(name || '').trim().toLowerCase();
    const zipName = bare + '-toolchain.zip';
    const candidates = [path.join(__dirname, 'bundled', zipName)];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, zipName));
    for (let i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { }
    }
    return null;
}
function findGccLocalZip() { return findToolLocalZip('gcc'); }

// 阶段一百二十一：EXE/安装器本地兜底（与 findToolLocalZip 同构）——按下载 URL 的文件名在 bundled/ 与 resources/
//   下找同名安装器（如 rustup-init.exe），命中即本地复制跳过网络：离线机器静默安装照常，且服务端安装脚本零改动
//   只取 URL basename 精确匹配（去 query/fragment）；未命中则照常走网络下载（联网机始终用官方源，永远最新）
function findLocalInstaller(url) {
    try {
        let base = String(url || '').split('#')[0].split('?')[0]; // 去 fragment 与 query 串
        base = path.basename(base);
        if (!base || base === '.' || base === '..') return null;
        const candidates = [path.join(__dirname, 'bundled', base)];
        if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, base));
        for (let i = 0; i < candidates.length; i++) {
            try { if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isFile()) return candidates[i]; } catch (e) { }
        }
    } catch (e) { }
    return null;
}

// 下载（跟随重定向）→ SHA256 校验（https 源按条目声明值校验，未配置则跳过并告警——TLS + zip 内建 CRC32 兜底完整性；
//   http 本地源一律跳过，无中间人风险）→ PowerShell Expand-Archive 解压 → isInstalledFn 校验。
// 单次 read 空闲 60s 超时（大文件下载活性检测，区别于总时长）。
// zipURL/sha256/destDir/isInstalledFn 全参数化：市场条目与 ensureGcc 内置兜底同通道；name 用于隔离临时 zip 名（防并发安装互踩）
// 阶段一百二十一修复：SHA256 仅以本条目的声明值为准——历史上 https 源缺 sha256 时回退 gcc 包哈希常量，
//   导致任何非 gcc 工具配 https 源 + 空 sha256 校验必败
function gccDownloadInstallFrom(zipURL, sha256, destDir, isInstalledFn, name) {
    return new Promise(function (resolve) {
        const tmpZip = path.join(os.tmpdir(), 'im-tc-' + String(name || 'gcc').replace(/[^\w.-]/g, '_') + '.zip');
        const url = zipURL || (serverBase + 'static/gcc-toolchain.zip');
        // 阶段一百二十一：按 URL 协议选 http/https 模块（服务端 localhost http 源也支持，rustup 外置 https 源也支持）
        const isHttps = /^https:/i.test(url);
        const expectSha = isHttps ? (sha256 || '').trim().toUpperCase() : ''; // http 本地源跳过 SHA256（无中间人风险）
        if (isHttps && !expectSha) {
            logger.error('[' + (name || 'gcc') + '] 外源 https zip 未配置 SHA256，跳过强校验（建议服务端工具链条目补配 sha256 防篡改）');
        }
        const httpMod = isHttps ? require('https') : require('http');
        let redirectLeft = 5;
        const doGet = function (url) {
            if (redirectLeft-- < 0) { resolve({ ok: false, msg: '下载失败：重定向次数过多' }); return; }
            const curIsHttps = /^https:/i.test(url);
            const mod = curIsHttps ? require('https') : require('http');
            const req = mod.get(url, { headers: { 'User-Agent': 'im-pc-client' } }, function (resp) {
                if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
                    resp.resume(); doGet(resp.headers.location); return;
                }
                if (resp.statusCode !== 200) { resp.resume(); resolve({ ok: false, msg: '下载失败：HTTP ' + resp.statusCode + '（' + url + '）' }); return; }
                const out = fs.createWriteStream(tmpZip);
                let size = 0;
                const idleTimer = setInterval(function () {
                    if (Date.now() - lastData > GCC_DOWNLOAD_IDLE_TIMEOUT_MS) {
                        req.destroy(new Error('下载超时（60 秒无数据）'));
                    }
                }, 5000);
                let lastData = Date.now();
                resp.on('data', function () { lastData = Date.now(); size += 1; });
                out.on('finish', function () {
                    out.close(function () {
                        clearInterval(idleTimer);
                        // SHA256 校验（仅 https 外源；http 本地源跳过——无中间人风险，且本地重打包无需同步常量）
                        if (!expectSha) { unzipGcc(tmpZip, resolve, true, destDir, isInstalledFn); return; }
                        const { createHash } = require('crypto');
                        const hash = createHash('sha256');
                        const rs = fs.createReadStream(tmpZip);
                        rs.on('data', function (d) { hash.update(d); });
                        rs.on('end', function () {
                            const digest = hash.digest('hex').toUpperCase();
                            if (digest !== expectSha) {
                                try { fs.unlinkSync(tmpZip); } catch (e) { }
                                resolve({ ok: false, msg: '下载校验失败（SHA256 不匹配），已清理临时文件' });
                                return;
                            }
                            unzipGcc(tmpZip, resolve, true, destDir, isInstalledFn); // 临时 zip 解压后清理
                        });
                        rs.on('error', function () { resolve({ ok: false, msg: '校验读取失败' }); });
                    });
                });
                out.on('error', function () { clearInterval(idleTimer); resolve({ ok: false, msg: '下载写盘失败' }); });
                resp.pipe(out);
            });
            req.setTimeout(GCC_DOWNLOAD_IDLE_TIMEOUT_MS, function () { req.destroy(new Error('下载超时（60 秒无数据）')); });
            req.on('error', function (e) { resolve({ ok: false, msg: '下载失败：' + (e.message || e) + '（' + url + '）' }); });
        };
        doGet(url);
    });
}

// 解压（PowerShell Expand-Archive，Windows 内置无第三方依赖）→ 校验 bin\gcc.exe。
// zip 根即工具链内容（bin/include/lib/...），归位 ~/.im-mcp/gcc 下；cwd 固定主目录防锁部署目录
// 阶段一百二十一：按工具名映射安装目标目录（多工具链市场归口）
// gcc → ~/.im-mcp/gcc；zig → ~/.im-mcp/zig；go → ~/.im-mcp/go；git → ~/.im-mcp/git；java → ~/.im-mcp/java
// 阶段一百二十一：zig 已上架真 zip（原复用 gcc 目录的轻量实现废弃），独立 install_dir
function installDirFor(name) {
    const bare = String(name || '').trim().toLowerCase();
    if (bare === 'go') return path.join(IM_MCP_DIR, 'go');
    if (bare === 'git') return path.join(IM_MCP_DIR, 'git');
    if (bare === 'java' || bare === 'javac') return path.join(IM_MCP_DIR, 'java');
    if (bare === 'zig') return path.join(IM_MCP_DIR, 'zig');
    return GCC_DIR; // gcc 及未知工具默认 gcc 目录（rust 实际走 rustup 不经过此函数）
}

// allToolchainBins：返回 ~/.im-mcp 全部工具链的 PATH 前置目录数组
// 阶段一百二十一：优先按 ExePaths 声明定位（服务端下发，相对 install_dir 或 "~/" 前缀绝对路径）；
//   声明缺失时回退默认探测（bin/<name>.exe、bin/、cmd/ 目录盲扫），确保后台新增 zip 工具链零代码可用
function allToolchainBins() {
    const bins = new Set();
    const home = os.homedir();
    // 默认工具链 exe 路径注册表（ExePaths 未声明时回退用；admin 可在服务端 Toolchain.ExePaths 覆盖扩展）
    // 支持三种形式：相对 install_dir（"bin/go.exe"）、用户目录 "~/" 前缀（"~/.cargo/bin/rustc.exe"）、绝对路径（"C:/tools/bin/x.exe"）
    const DEFAULT_EXE_PATHS = {
        gcc:    ['bin/gcc.exe', 'bin/g++.exe'],
        clang:  ['bin/clang.exe'],
        // 阶段一百二十一：zig 真 zip（官方包解压含一层版本目录 zig-x86_64-windows-*/）；声明优先，此为兜底
        zig:    ['zig-x86_64-windows-0.16.0/zig.exe', 'zig.exe', 'bin/zig.exe'],
        go:     ['bin/go.exe'],
        git:    ['bin/git.exe', 'cmd/git.exe'],
        rust:   ['~/.cargo/bin/rustc.exe', '~/.cargo/bin/cargo.exe'],
        java:   ['bin/javac.exe', 'bin/java.exe'],
    };
    try {
        const declared = exePathsCacheRead(); // 服务端 ExePaths 声明（install_dir 为键），优先于内置注册表
        const dirs = fs.readdirSync(IM_MCP_DIR, { withFileTypes: true });
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const toolDir = path.join(IM_MCP_DIR, d.name);
            // 三级候选：服务端声明 → 内置注册表 → 通用兜底（bin/<name>.exe、bin/、cmd/ 盲扫）。
            // 高优先级候选全部未命中时降级继续探测——防声明与实际解压结构不符导致该工具整体漏配 PATH
            const candidates = [];
            if (declared[d.name] && declared[d.name].length) candidates.push(declared[d.name]);
            if (DEFAULT_EXE_PATHS[d.name]) candidates.push(DEFAULT_EXE_PATHS[d.name]);
            candidates.push(['bin/' + d.name + '.exe', 'bin/', 'cmd/']);
            let hit = false;
            for (const exePaths of candidates) {
                for (const p of exePaths) {
                    // 三种路径解析："~/" 前缀 → 用户目录；绝对路径（盘符开头）→ 原样；其余 → 相对 install_dir
                    let full;
                    if (p.startsWith('~/')) full = path.join(home, p.slice(2));
                    else if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) full = p;
                    else full = path.join(toolDir, p);
                    if (fs.existsSync(full)) {
                        bins.add(fs.statSync(full).isDirectory() ? full : path.dirname(full));
                        hit = true;
                    }
                }
                if (hit) break; // 本优先级已有命中，不再降级（保持"按声明定位"语义）
            }
        }
        // 阶段一百二十一：外部工具目录探测（rustup 装到 ~/.cargo 而非 ~/.im-mcp；其他外部安装工具同理扩展）
        const EXTERNAL_BINS = ['~/.cargo/bin', '~/.rustup/toolchains'];
        for (const ext of EXTERNAL_BINS) {
            const full = ext.startsWith('~/') ? path.join(home, ext.slice(2)) : ext;
            if (fs.existsSync(full) && fs.statSync(full).isDirectory()) bins.add(full);
        }
    } catch (e) { }
    return Array.from(bins);
}

// unzipGcc 参数化：zipPath 解压到 destDir，安装后校验 isInstalledFn（如 isGccInstalled / go.exe 存在）
function unzipGcc(zipPath, resolve, delZip, destDir, isInstalledFn) {
    const dest = destDir || GCC_DIR;
    try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { }
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        '$ErrorActionPreference="Stop";' +
        'Expand-Archive -Force -LiteralPath "' + zipPath + '" -DestinationPath "' + dest + '";'],
        { cwd: os.homedir(), windowsHide: true });
    let errOut = '';
    ps.stderr.on('data', function (d) { errOut += d; });
    ps.on('close', function (code) {
        if (delZip) { try { fs.unlinkSync(zipPath); } catch (e) { } }
        const installed = isInstalledFn ? isInstalledFn() : isGccInstalled();
        if (code === 0 && installed) resolve({ ok: true, msg: '工具链安装完成' + (delZip ? '（在线下载）' : '（本地 zip 解压）') });
        else resolve({ ok: false, msg: '解压失败：' + ((errOut.trim().split('\n')[0]) || ('退出码 ' + code)) });
    });
    ps.on('error', function (e) { resolve({ ok: false, msg: '解压启动失败：' + e.message }); });
}

// resolveZipURL 归口：服务端工具链条目的 zip_url 归一为可下载 URL。
//   完整 http/https → 原样返回（外置 CDN/镜像）；其余视为相对路径拼服务端 base（静态托管归口，零硬编码）。
//   zip_url 留空时默认 <base>static/<name>-toolchain.zip（服务端播种条目约定俗成 static/<name>-toolchain.zip）
function resolveZipURL(zipURL, name) {
    const u = String(zipURL || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (!u) return serverBase + 'static/' + encodeURIComponent(name || 'gcc') + '-toolchain.zip';
    return u.startsWith('/') ? serverBase + u.slice(1) : serverBase + u;
}

// rustupInstallFrom：Rust 专用安装通道——下载 rustup-init.exe → 静默执行（-y 默认装到 ~/.cargo）
// 阶段一百二十一：【已迁移脚本化】installFromMarket 检测到 installer_script 时走 runInstallerScript 沙箱，
//   本函数保留作参考实现（与 admintoolchain.go 播种的 Rust InstallerScript 逻辑一致），不再被调用
function rustupInstallFrom(url) {
    return new Promise(function (resolve) {
        const tmpExe = path.join(os.tmpdir(), 'im-rustup-init.exe');
        const isHttps = /^https:/i.test(url);
        const mod = isHttps ? require('https') : require('http');
        let redirectLeft = 5;
        const doGet = function (u) {
            if (redirectLeft-- < 0) { resolve({ ok: false, msg: '下载失败：重定向次数过多' }); return; }
            const curIsHttps = /^https:/i.test(u);
            const curMod = curIsHttps ? require('https') : require('http');
            const req = curMod.get(u, { headers: { 'User-Agent': 'im-pc-client' } }, function (resp) {
                if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
                    resp.resume(); doGet(resp.headers.location); return;
                }
                if (resp.statusCode !== 200) { resp.resume(); resolve({ ok: false, msg: '下载失败：HTTP ' + resp.statusCode + '（' + u + '）' }); return; }
                const out = fs.createWriteStream(tmpExe);
                resp.pipe(out);
                out.on('finish', function () {
                    out.close(function () {
                        // 静默执行 rustup-init.exe：-y 默认选项、--default-toolchain stable、--profile minimal
                        const ps = spawn(tmpExe, ['-y', '--default-toolchain', 'stable', '--profile', 'minimal'], { cwd: os.homedir(), windowsHide: false });
                        let errOut = '';
                        ps.stderr.on('data', function (d) { errOut += d; });
                        ps.on('close', function (code) {
                            try { fs.unlinkSync(tmpExe); } catch (e) { } // 清理临时安装器
                            if (code === 0 && isToolInstalled('rust')) {
                                resolve({ ok: true, msg: 'Rust 编译工具链安装完成（rustup 已装到 ~/.cargo）' });
                            } else {
                                resolve({ ok: false, msg: 'rustup 安装失败（退出码 ' + code + '）：' + (errOut.trim().split('\n')[0] || '未知错误') + '；请检查网络或访问 rustup.rs 手动安装' });
                            }
                        });
                        ps.on('error', function (e) { resolve({ ok: false, msg: 'rustup 启动失败：' + e.message }); });
                    });
                });
                out.on('error', function () { resolve({ ok: false, msg: '下载写盘失败' }); });
            });
            req.setTimeout(GCC_DOWNLOAD_IDLE_TIMEOUT_MS, function () { req.destroy(new Error('下载超时（60 秒无数据）')); });
            req.on('error', function (e) { resolve({ ok: false, msg: '下载失败：' + (e.message || e) + '（' + u + '）' }); });
        };
        doGet(url);
    });
}

// runInstallerScript：JS 沙箱安装脚本引擎（阶段一百二十一：admin 零代码发布安装逻辑，服务端下发脚本）
// scriptSrc: module.exports = async function(ctx) {...}；ctx 注入受限 API（无 process.env 全量/child_process.exec）
// 超时 10 分钟防死循环；错误结构化返回 {ok:false, msg} 供模型/用户自纠
function runInstallerScript(name, scriptSrc, ctx) {
    return new Promise(function (resolve) {
        const vm = require('vm');
        const path = require('path');
        const fs = require('fs');
        const os = require('os');
        const { spawn } = require('child_process');
        // 白名单 require：仅允许 fs/path/os/http/https/crypto/child_process（不暴露 process.env 全量、exec、fork 等高危）
        const whitelistedRequire = function (mod) {
            if (['fs', 'path', 'os', 'http', 'https', 'crypto', 'child_process'].indexOf(mod) === -1) {
                throw new Error('require("' + mod + '") 被沙箱禁止');
            }
            return require(mod);
        };
        const sandbox = {
            module: { exports: {} },
            require: whitelistedRequire,
            console: { log: function () { logger.info('[' + name + ']', Array.prototype.join.call(arguments, ' ')); } },
            setTimeout: setTimeout,
            clearTimeout: clearTimeout,
            __ctx: ctx || {}
        };
        vm.createContext(sandbox);
        try {
            vm.runInContext(scriptSrc, sandbox, { timeout: 600000 }); // 10 分钟编译超时
        } catch (e) {
            resolve({ ok: false, msg: '安装脚本编译失败：' + e.message });
            return;
        }
        const fn = sandbox.module.exports;
        if (typeof fn !== 'function') {
            resolve({ ok: false, msg: '安装脚本必须导出 async function(ctx)' });
            return;
        }
        // 构建受限 ctx：提供 http/https/fs/path/os/spawn/download，不暴露 process.env 全量、exec、fork 等高危
        const restrictedCtx = {
            url: ctx.url,
            destDir: ctx.destDir,
            sha256: ctx.sha256,
            fs: { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, unlinkSync: fs.unlinkSync, createWriteStream: fs.createWriteStream, createReadStream: fs.createReadStream },
            path: path,
            os: os,
            http: require('http'),
            https: require('https'),
            crypto: { createHash: require('crypto').createHash },
            spawn: function (cmd, args, opts) {
                // 返回 Promise：resolve {code, stdout, stderr}（await 即等进程结束，脚本无需手动监听事件）
                return new Promise(function (res, rej) {
                    const ps = spawn(cmd, args, Object.assign({ cwd: os.homedir(), windowsHide: true }, opts || {}));
                    let stdout = '', stderr = '';
                    ps.stdout.on('data', function (d) { stdout += d; });
                    ps.stderr.on('data', function (d) { stderr += d; });
                    ps.on('close', function (code) { res({ code: code, stdout: stdout, stderr: stderr }); });
                    ps.on('error', rej);
                });
            },
            download: function (url, destPath) {
                // 阶段一百二十一：本地安装器兜底优先——bundled/resources 存在与 URL 同名文件时直接本地复制（离线模式），
                //   未命中则走 http/https 网络下载；命中时记日志便于区分离线/在线安装路径
                const localInstaller = findLocalInstaller(url);
                if (localInstaller) {
                    logger.info('[' + name + '] 命中本地安装器 ' + localInstaller + '（离线模式，跳过网络下载）');
                    return new Promise(function (res, rej) {
                        fs.copyFile(localInstaller, destPath, function (err) {
                            if (err) rej(new Error('本地安装器复制失败：' + (err.message || err)));
                            else res();
                        });
                    });
                }
                return new Promise(function (res, rej) {
                    const isHttps = /^https:/i.test(url);
                    const mod = isHttps ? require('https') : require('http');
                    const out = fs.createWriteStream(destPath);
                    mod.get(url, { headers: { 'User-Agent': 'im-pc-client' } }, function (resp) {
                        if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
                            resp.resume(); res(restrictedCtx.download(resp.headers.location, destPath)); return;
                        }
                        if (resp.statusCode !== 200) { resp.resume(); rej(new Error('HTTP ' + resp.statusCode)); return; }
                        resp.pipe(out);
                        out.on('finish', function () { out.close(res); });
                        out.on('error', rej);
                    }).on('error', rej);
                });
            },
            logger: { info: function (m) { logger.info('[' + name + ']', m); }, error: function (m) { logger.error('[' + name + ']', m); } }
        };
        Promise.resolve()
            .then(function () { return fn(restrictedCtx); })
            .then(function (r) {
                resolve(r && typeof r === 'object' ? r : { ok: true, msg: name + ' 安装完成' });
            })
            .catch(function (e) {
                resolve({ ok: false, msg: '安装脚本执行失败：' + (e && e.message || e) });
            });
    });
}

// 阶段一百二十一：从工具链市场安装入口（PC 端 [工具链] 页签一键安装，IPC desktop.toolchainInstall 调用）。
// 与 ensureGcc 三通道的区别：市场条目带服务端下发 zip_url + sha256（admin 可改，支持外置 CDN），
// 来源以服务端清单为准；安装目标仍归位 ~/.im-mcp/gcc（install_dir 字段当前仅 gcc 通道）。
// 返回 {ok, msg}：ok=true 且 gcc.exe 就绪即安装成功；ok=false 时 msg 带自纠指引（模型/用户据此处理）
function installFromMarket(name, zipURL, sha256, installerScript) {
    const bare = String(name || 'gcc').trim().toLowerCase();
    if (isToolInstalled(bare)) {
        return Promise.resolve({ ok: true, msg: bare + ' 已安装' });
    }
    // 按工具名隔离安装状态（防 gcc 安装中阻塞 go 安装）
    if (!installState[bare]) installState[bare] = { installing: false, promise: null };
    const st = installState[bare];
    if (st.promise) return st.promise;
    st.installing = true;
    const url = resolveZipURL(zipURL, bare);
    const destDir = installDirFor(bare);
    const script = String(installerScript || '').trim();
    let job;
    if (script) {
        // 阶段一百二十一：JS 沙箱安装脚本（服务端下发，admin 零代码发布安装逻辑）
        job = runInstallerScript(bare, script, { url: url, destDir: destDir, sha256: sha256 });
    } else {
        // 优先本地 zip（bundled/resources 随包分发的同源裁剪包，免下载零流量）；本地缺失才联网（以服务端清单 URL 为准）
        const local = findToolLocalZip(bare);
        job = local
            ? new Promise(function (resolve) { unzipGcc(local, resolve, false, destDir, function () { return isToolInstalled(bare); }); })
            // 阶段一百二十一：name 传 bare——临时 zip 名按工具隔离（防并发安装互踩同一临时文件），SHA256 告警归口到具体工具
            : gccDownloadInstallFrom(url, sha256, destDir, function () { return isToolInstalled(bare); }, bare);
    }
    st.promise = job.then(function (r) {
        st.installing = false;
        st.promise = null;
        return r;
    }, function (e) {
        st.installing = false;
        st.promise = null;
        return { ok: false, msg: (e && e.message) || '安装失败' };
    });
    return st.promise;
}

// 阶段一百二十一：工具链市场安装状态查询（IPC desktop.toolchainStatus 调用）——
// C 命令（gcc/clang/zig）走 isToolInstalled 同步检测（便携版 gcc.exe）；非 C 命令走 ensureTool（系统 PATH 探测 + 便携版）
// 已装返回对应版本号（卡片展示"已安装 vX.Y.Z"），未装返回 installed:false
function toolchainStatus(name) {
    const bare = String(name || 'gcc').trim().toLowerCase();
    const st = installState[bare] || { installing: false };
    // 阶段一百二十一：同步检测组——gcc（gcc.exe）、zig（声明解析 zig.exe）、rust（~/.cargo/bin/rustc.exe）。
    //   rust 并入原因：ensureTool 只认 rustc/cargo，rust 卡片名需直查（修复安装后仍显示"未安装"的存量 bug）；
    //   clang 移出原因：gcc zip 不含 clang.exe，随 gcc 误报已装；改走异步分支（whereExe 系统探测 + ensureTool 引导）
    const SYNC_CMDS = ['gcc', 'zig', 'rust'];
    let check;
    if (SYNC_CMDS.indexOf(bare) !== -1) {
        check = Promise.resolve(isToolInstalled(bare) ? { ok: true } : { ok: false });
    } else {
        // 阶段一百二十一：未知/新增工具先按 allToolchainBins 的 PATH 前置目录解析（服务端 ExePaths 声明命中的
        //   后台新增 zip 工具链零代码回显"已安装"）；解析不到再走 ensureTool 归口（系统 PATH 探测 + 引导安装提示）
        check = resolveInPath(bare, allToolchainBins().join(path.delimiter))
            ? Promise.resolve({ ok: true })
            : ensureTool(bare);
    }
    return check.then(function (r) {
        if (!r || !r.ok) return { installed: false, installing: st.installing };
        return toolVersion(bare).then(function (v) {
            return { installed: true, version: v, installing: st.installing };
        });
    });
}

// 阶段一百二十一：按工具名判断是否已装（多工具链市场归口，替代硬编码 isGccInstalled）
// name: gcc（查 ~/.im-mcp/gcc/bin/gcc.exe）、zig（按声明/默认探测解析 zig.exe，真 zip 独立目录）、
//   clang（诚实检测：gcc zip 不含 clang.exe，仅在 PATH 前置目录真实解析到时报告已装）、
//   go（查 ~/.im-mcp/go/bin/go.exe）、git（bin/cmd）、rust（~/.cargo/bin）、java（系统 JAVA_HOME 优先）
function isToolInstalled(name) {
    const bare = String(name || '').trim().toLowerCase();
    if (bare === 'gcc') return isGccInstalled();
    // 阶段一百二十一：zig 真 zip 独立 install_dir，经 PATH 前置目录解析（原挂靠 gcc 的检测已废弃）
    if (bare === 'zig') return resolveInPath('zig', allToolchainBins().join(path.delimiter));
    // 阶段一百二十一：clang 诚实检测——不再随 gcc 误报已装；系统 clang 存在与否由 ensureTool 的 whereExe 归口
    if (bare === 'clang') return resolveInPath('clang', allToolchainBins().join(path.delimiter));
    if (bare === 'go') return fs.existsSync(path.join(IM_MCP_DIR, 'go', 'bin', 'go.exe'));
    if (bare === 'git') return fs.existsSync(path.join(IM_MCP_DIR, 'git', 'bin', 'git.exe')) || fs.existsSync(path.join(IM_MCP_DIR, 'git', 'cmd', 'git.exe'));
    if (bare === 'rust' || bare === 'rustc' || bare === 'cargo') return fs.existsSync(path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe'));
    if (bare === 'java' || bare === 'javac') return !!process.env.JAVA_HOME || fs.existsSync(path.join(IM_MCP_DIR, 'java', 'bin', 'javac.exe'));
    return false;
}

// findToolExe：在工具链 PATH 前置目录中解析命令的完整路径（zig/clang 等声明驱动工具的便携版定位；找不到返回 null）
function findToolExe(name) {
    const base = String(name || '').trim().toLowerCase().replace(/\.(exe|bat|cmd)$/i, '');
    const names = [base, base + '.exe', base + '.bat', base + '.cmd'];
    const dirs = allToolchainBins();
    for (let i = 0; i < dirs.length; i++) {
        for (let j = 0; j < names.length; j++) {
            const full = path.join(dirs[i], names[j]);
            try { if (fs.existsSync(full)) return full; } catch (e) { }
        }
    }
    return null;
}

// 阶段一百二十一：按工具名取版本号（已装时展示用；未装返回空串）
// 系统 PATH 优先（与 ensureTool 同归口），便携版兜底
function toolVersion(name) {
    const bare = String(name || '').trim().toLowerCase();
    return new Promise(function (resolve) {
        // 先查系统 PATH（where 探测，零下载优先）
        whereExe(bare).then(function (sysExe) {
            if (sysExe) { runVersion(sysExe); return; }
            // 便携版兜底
            let exe = null;
            if (bare === 'gcc') { exe = GCC_EXE; }
            else if (bare === 'go') { exe = path.join(IM_MCP_DIR, 'go', 'bin', 'go.exe'); }
            else if (bare === 'git') {
                exe = [path.join(IM_MCP_DIR, 'git', 'bin', 'git.exe'), path.join(IM_MCP_DIR, 'git', 'cmd', 'git.exe')].find(function (p) { return fs.existsSync(p); });
            }
            else if (bare === 'rust' || bare === 'rustc' || bare === 'cargo') { exe = path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe'); }
            // 阶段一百二十一：zig/clang 等声明驱动工具按 PATH 前置目录解析便携版（不再挂靠 GCC_EXE 回显 gcc 版本）
            else { exe = findToolExe(bare); }
            if (!exe || !fs.existsSync(exe)) { resolve(''); return; }
            runVersion(exe);
        });
        function runVersion(exe) {
            // zig 是子命令式 CLI：zig version（无横线）；clang 系用 --version（-dumpfullversion 是 gcc 专属参数，clang 不认）
            const args = (bare === 'go' || bare === 'zig') ? ['version']
                : (bare === 'git' || bare === 'rust' || bare === 'rustc' || bare === 'cargo' || bare === 'clang' || bare === 'clang++') ? ['--version']
                : ['-dumpfullversion'];
            execFile(exe, args, { cwd: os.homedir(), windowsHide: true, timeout: 10000 }, function (err, stdout) {
                if (err) { resolve(''); return; }
                const out = String(stdout || '').trim();
                const m = out.match(/(\d+\.\d+\.\d+)/);
                resolve(m ? m[1] : out.split(/\s+/).pop() || '');
            });
        }
    });
}

// ensureGcc：确保内置 gcc 就绪（委托 installFromMarket 统一状态管理，并发共享同一安装 Promise）
// 阶段一百二十一：显式传 gcc 包 SHA256——下载通道的 SHA256 仅以本条目的声明值为准（删除了 gcc 常量全局兜底），
//   Agent 任务懒加载路径（不走服务端清单）靠这里保证 https 源的强校验
function ensureGcc() {
    if (isGccInstalled()) return Promise.resolve({ ok: true, type: 'gcc-portable', msg: '内置 gcc 编译环境已就绪' });
    return installFromMarket('gcc', '', GCC_ZIP_SHA256).then(function (r) {
        return r.ok ? { ok: true, type: 'gcc-portable', msg: r.msg } : r;
    });
}

// ===== 归口入口 ensureCompiler：四级探测 → 编译环境就绪结果 =====
// 返回 {ok, type, msg, env?}：
//   type=msvc        → env=vcvarsall 增量（INCLUDE/LIB/...，__PATH_EXTRAS 附加编译目录），模型应使用 cl 语法
//   type=gcc/clang   → 系统已有，PATH 可解析，无需注入（env 不发）
//   type=gcc-portable→ 内置 gcc 已就绪，调用方把 GCC_BIN_DIR 前置 PATH（env 不发）
//   ok=false         → 全部通道失败（msg 说明原因，模型据此提示用户）
async function ensureCompiler() {
    // 缓存命中（24h）：MSVC 缓存含 env 引用（actual env 在 msvc-env 缓存文件），直接复用判定
    const cached = detectCacheRead();
    if (cached && cached.type) {
        if (cached.type === 'msvc') {
            const env = msvcEnvCacheRead(cached.vcvarsPath || '');
            if (env && fs.existsSync(cached.clDir || '')) {
                return { ok: true, type: 'msvc', msg: '系统已安装 MSVC（VS ' + (cached.clVersion || '') + '），请使用 cl 编译语法', env: env };
            }
        } else if (cached.type === 'gcc' || cached.type === 'clang') {
            if (await whereExe(cached.type)) return { ok: true, type: cached.type, msg: '系统已安装 ' + cached.type + ' 编译器' };
        } else if (cached.type === 'gcc-portable') {
            if (isGccInstalled()) return { ok: true, type: 'gcc-portable', msg: '内置 gcc 编译环境已就绪' };
        }
    }
    // ① MSVC（系统编译器最优先，零下载）
    const msvc = await detectMsvc();
    if (msvc) {
        const env = await extractMsvcEnv(msvc);
        if (env) {
            const result = { ok: true, type: 'msvc', msg: '系统已安装 MSVC（cl ' + (msvc.clVersion || '') + '），请使用 cl 编译语法（注意 MSVC 参数风格：/Fe 输出、/I 头文件目录）', env: env };
            detectCacheWrite({ type: 'msvc', clDir: msvc.clDir, clVersion: msvc.clVersion, vcvarsPath: msvc.vcvarsPath });
            return result;
        }
    }
    // ② 系统 gcc / clang
    const sysGcc = await whereExe('gcc');
    if (sysGcc) {
        detectCacheWrite({ type: 'gcc' });
        return { ok: true, type: 'gcc', msg: '系统已安装 gcc（' + sysGcc + '）' };
    }
    const sysClang = await whereExe('clang');
    if (sysClang) {
        detectCacheWrite({ type: 'clang' });
        return { ok: true, type: 'clang', msg: '系统已安装 clang（' + sysClang + '）' };
    }
    // ③④ 内置裁剪版 gcc（本地 zip → 在线下载）
    const gcc = await ensureGcc();
    if (gcc.ok) {
        detectCacheWrite({ type: 'gcc-portable' });
        return { ok: true, type: 'gcc-portable', msg: gcc.msg };
    }
    return { ok: false, msg: '编译环境准备失败：' + (gcc.msg || '所有通道均不可用') };
}

// ensureTool 按工具名归口环境就绪检查（阶段一百二十一：多工具链市场命令预检）
// name: zig/go/git/rustc/cargo/javac/java 等；返回 {ok, msg}：
//   ok=true  → 系统 PATH 已解析到（where 命中）或对应便携版已装，可直接执行
//   ok=false → 未装，msg 提示对应安装方式（模型据此引导用户到工具链市场或系统安装）
async function ensureTool(name) {
    const bare = String(name || '').trim().toLowerCase().replace(/\.(exe|bat|cmd)$/i, '');
    // 系统 PATH 直接解析到（where 探测，零下载优先）
    if (await whereExe(bare)) return { ok: true, msg: '系统已安装 ' + bare };
    // zig → 便携版 zip 已装？（真 zip 声明解析；原"路由到 gcc"轻量实现已废弃，执行 zig cc 需真身）
    if (bare === 'zig') {
        if (resolveInPath('zig', allToolchainBins().join(path.delimiter))) return { ok: true, msg: '便携版 Zig 已安装' };
        return { ok: false, msg: 'Zig 未安装：请前往 设置 → 工具链 安装 Zig 便携版（官方包约 93MB），或从 ziglang.org 下载' };
    }
    // clang → 系统 LLVM/VS 工具集优先（gcc zip 不含 clang.exe，不做假身路由）
    if (bare === 'clang' || bare === 'clang++') {
        return { ok: false, msg: 'clang 未安装：请安装 LLVM（releases.llvm.org）或 Visual Studio（含 clang 工具集）；也可直接用内置 gcc 编译（命令参数高度兼容）' };
    }
    // go → 便携版 zip 已装？（~/.im-mcp/go/bin/go.exe）
    if (bare === 'go') {
        const goExe = path.join(IM_MCP_DIR, 'go', 'bin', 'go.exe');
        if (fs.existsSync(goExe)) return { ok: true, msg: '便携版 Go 已安装' };
        return { ok: false, msg: 'Go 未安装：请前往设置 → 工具链 安装 Go 便携版，或安装系统 Go（go.dev）' };
    }
    // git → 便携版 zip 已装？（~/.im-mcp/git/bin/git.exe 或 cmd/git.exe）
    if (bare === 'git') {
        const gitExe = [path.join(IM_MCP_DIR, 'git', 'bin', 'git.exe'), path.join(IM_MCP_DIR, 'git', 'cmd', 'git.exe')].find(function (p) { return fs.existsSync(p); });
        if (gitExe) return { ok: true, msg: '便携版 Git 已安装' };
        return { ok: false, msg: 'Git 未安装：请前往设置 → 工具链 安装 Git 便携版，或安装系统 Git（git-scm.com）' };
    }
    // rustc/cargo → rustup 在线引导器（检测 ~/.cargo/bin 是否已装）
    if (bare === 'rustc' || bare === 'cargo') {
        const cargoExe = path.join(os.homedir(), '.cargo', 'bin', bare + '.exe');
        if (fs.existsSync(cargoExe)) return { ok: true, msg: 'rustup 已安装 ' + bare };
        return { ok: false, msg: bare + ' 未安装：请前往设置 → 工具链 安装 Rust（rustup 在线引导器，需联网），或访问 rustup.rs' };
    }
    // javac/java → 系统 JDK 优先
    if (bare === 'javac' || bare === 'java') {
        return { ok: false, msg: bare + ' 未在 PATH 找到：请安装系统 JDK（java.oracle.com），或到工具链市场查看后续上架的便携版' };
    }
    return { ok: false, msg: '未识别的工具链命令：' + bare };
}

// ===== Agent 环境注入辅助（agent-executor.buildAgentEnv 调用） =====
// cachedMsvcEnv：命中 MSVC 缓存时返回编译增量环境（不含 PATH；调用方把 __PATH_EXTRAS 与 clDir 前置 PATH）
function cachedMsvcEnv() {
    const cached = detectCacheRead();
    if (!cached || cached.type !== 'msvc') return null;
    const env = msvcEnvCacheRead(cached.vcvarsPath || '');
    if (!env) return null;
    const out = Object.assign({}, env);
    delete out.__PATH_EXTRAS;
    return out;
}

// cachedMsvcPathExtras：MSVC 编译相关 PATH 附加段（cl/MSBuild/Windows SDK 目录），叠加内置 gcc 目录前置
function cachedMsvcPathExtras() {
    const cached = detectCacheRead();
    if (!cached || cached.type !== 'msvc') return '';
    const env = msvcEnvCacheRead(cached.vcvarsPath || '');
    return (env && env.__PATH_EXTRAS) || '';
}

// MSVC 前置目录归口：cl.exe 所在目录 + vcvars 提取的编译相关目录
function cachedMsvcClDirs() {
    const cached = detectCacheRead();
    if (!cached || cached.type !== 'msvc' || !cached.clDir) return [];
    const dirs = [cached.clDir];
    const extras = (cachedMsvcPathExtras() || '').split(path.delimiter);
    for (let i = 0; i < extras.length; i++) if (extras[i]) dirs.push(extras[i]);
    return dirs;
}

// ===== 编译命令族判定与 PATH 预检（agent-executor run_command 预检触发懒加载用） =====
// 编译命令族：C/C++ 编译/构建/调试核心命令（首词命中即需要编译环境）
const COMPILER_CMDS = ['gcc', 'g++', 'cc', 'c++', 'cpp', 'make', 'gdb', 'ar', 'ld', 'as', 'cl', 'clang', 'clang++', 'ccache', 'mingw32-make',
    // 阶段一百二十一：多工具链命令识别扩展（工具链市场 clang/zig/java/rust/go/git 的 run_command 预检触发懒加载）
    'zig', 'go', 'git', 'rustc', 'cargo', 'javac', 'java'];

function isCompilerCommand(head) {
    const base = path.basename(String(head || '').trim().toLowerCase());
    const bare = base.replace(/\.(exe|bat|cmd)$/i, '');
    return COMPILER_CMDS.indexOf(bare) !== -1;
}

// resolveInPath：命令首词在给定 PATH 序列下能否解析到可执行文件（仿 mcp-manager.nodeCmdResolved 确定性预检）
function resolveInPath(head, pathStr) {
    const base = String(head || '').trim().toLowerCase();
    const names = [base, base + '.exe', base + '.bat', base + '.cmd'];
    const dirs = String(pathStr || '').split(path.delimiter);
    for (let i = 0; i < dirs.length; i++) {
        if (!dirs[i]) continue;
        for (let j = 0; j < names.length; j++) {
            try { if (fs.existsSync(path.join(dirs[i], names[j]))) return true; } catch (e) { }
        }
    }
    return false;
}

function status() {
    return { gccDir: GCC_DIR, installed: isGccInstalled(), installing: gccInstalling, localZip: findGccLocalZip(), serverBase: serverBase };
}

module.exports = {
    setServerBase: setServerBase,
    ensureCompiler: ensureCompiler,
    ensureTool: ensureTool, // 阶段一百二十一：多工具链命令就绪检查（zig/go/git/rustc/java 等非 C/C++ 命令预检）
    ensureGcc: ensureGcc,
    installFromMarket: installFromMarket, // 阶段一百二十一：工具链市场一键安装入口（IPC desktop.toolchainInstall）
    toolchainStatus: toolchainStatus,     // 阶段一百二十一：安装状态查询（IPC desktop.toolchainStatus）
    isToolInstalled: isToolInstalled,     // 阶段一百二十一：按工具名判断是否已装
    installState: installState,           // 阶段一百二十一：按工具名隔离的安装状态表
    cachedMsvcEnv: cachedMsvcEnv,
    cachedMsvcClDirs: cachedMsvcClDirs,
    isCompilerCommand: isCompilerCommand,
    resolveInPath: resolveInPath,
    isGccInstalled: isGccInstalled,
    status: status,
    allToolchainBins: allToolchainBins,   // 阶段一百二十一：自动扫描 ~/.im-mcp 全部工具链 bin（PATH 前置）
    setToolchainExePaths: setToolchainExePaths,       // 阶段一百二十一：服务端 ExePaths 声明注入（按声明定位）
    toolchainRefreshExePaths: toolchainRefreshExePaths, // 阶段一百二十一：后台拉 /api/toolchains 刷新声明缓存
    GCC_BIN_DIR: GCC_BIN_DIR,
    GCC_DIR: GCC_DIR
};
