'use strict';
// ===== 阶段一百一十八：便携 Node 运行时自动安装（npx/npm/pnpm/yarn 等 Node 系 MCP 插件零依赖） =====
// TRAE CN 同款机制（实测其安装包捆绑 node-v24.14.0-win-x64.zip 随包分发）：系统未装 Node 时，
// 自动准备便携版 Node 解压到 ~/.im-mcp/node（无需管理员权限、不改系统 PATH），mcp-manager spawn 时
// 将该目录前置到 PATH——npx.cmd/npm.cmd 随包自带即装即用。
// 双通道取源（TRAE 同款优先级）：1) 本地 zip（打包内嵌 resources\node-runtime.zip / 开发态 pc\bundled\
// 构建缓存）直接解压，离线可用；2) 本地缺失才联网下载（国内镜像优先、官方源兜底、失败自动换源）。
// 归口：main.js（IPC 手动安装入口）与 mcp-manager（spawn 时自动触发）均经本模块读写运行时状态。

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NODE_VERSION = 'v24.14.0'; // 与 TRAE CN 捆绑版本一致（2026-09-15 实测两大源均可用，34.5MB）
const NODE_BIN_DIR = path.join(os.homedir(), '.im-mcp', 'node');
const NODE_EXE = path.join(NODE_BIN_DIR, 'node.exe');
// 下载源：国内镜像优先（npmmirror 二进制镜像），官方源兜底（下载失败自动换源重试）
const NODE_ZIP_URLS = [
    'https://registry.npmmirror.com/-/binary/node/' + NODE_VERSION + '/node-' + NODE_VERSION + '-win-x64.zip',
    'https://nodejs.org/dist/' + NODE_VERSION + '/node-' + NODE_VERSION + '-win-x64.zip'
];

let installing = false;
let installPromise = null; // 并发会话共享同一次安装（多插件同时触发只下载一次）

function isInstalled() { return fs.existsSync(NODE_EXE); }

// findLocalZip：按序查找本地已有的便携 Node zip（找到即离线解压，不联网）：
//   1) 开发态构建缓存 <客户端目录>\bundled\node-vXX-win-x64.zip（build.bat 首次自动下载缓存）
//   2) 打包内嵌 <resources>\node-runtime.zip（electron-builder extraResources 固定名，随安装包分发）
// 注意 process.resourcesPath 仅 Electron 运行态存在，纯 Node 调试（测试脚本）下自动跳过
function findLocalZip() {
    const candidates = [
        path.join(__dirname, 'bundled', 'node-' + NODE_VERSION + '-win-x64.zip'),
    ];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'node-runtime.zip'));
    for (let i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { }
    }
    return null;
}

function status() {
    return { installed: isInstalled(), dir: NODE_BIN_DIR, installing: installing, version: NODE_VERSION, localZip: findLocalZip() };
}

// ensureRuntime：确保便携 Node 就绪（已装直接返回；并发调用共享同一安装 Promise）。
// 取源优先级：本地 zip 直接解压（TRAE 同款离线通道）→ 本地缺失才联网下载
function ensureRuntime() {
    if (isInstalled()) return Promise.resolve({ ok: true, installed: true, msg: 'Node 运行时已就绪' });
    if (installPromise) return installPromise;
    installing = true;
    const local = findLocalZip();
    const job = local
        ? new Promise(function (resolve) { unzip(local, resolve, false); }) // 本地 zip 保留复用，解压后不删除
        : downloadInstall(); // 联网下载到临时文件，解压后清理临时 zip
    installPromise = job.then(function (r) {
        installing = false;
        installPromise = null;
        return r;
    }, function (e) {
        installing = false;
        installPromise = null;
        return { ok: false, msg: (e && e.message) || '安装失败' };
    });
    return installPromise;
}

// 下载（跟随重定向，单源失败自动换下一源）→ PowerShell 解压归位 → 校验 node.exe
function downloadInstall() {
    return new Promise(function (resolve) {
        const tmpZip = path.join(os.tmpdir(), 'im-node-runtime.zip');
        let urlIdx = 0;
        const tryNext = function () {
            if (urlIdx >= NODE_ZIP_URLS.length) {
                resolve({ ok: false, msg: '下载失败：所有源均不可达（网络受限时可手动安装 Node.js 后重启客户端）' });
                return;
            }
            doGet(NODE_ZIP_URLS[urlIdx++], 5);
        };
        const doGet = function (url, redirectLeft) {
            if (redirectLeft < 0) { resolve({ ok: false, msg: '下载失败：重定向次数过多' }); return; }
            const req = https.get(url, { headers: { 'User-Agent': 'im-pc-client' }, timeout: 120000 }, function (resp) {
                if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
                    resp.resume();
                    doGet(resp.headers.location, redirectLeft - 1);
                    return;
                }
                if (resp.statusCode !== 200) { resp.resume(); tryNext(); return; } // 非正常响应换下一个源
                const out = fs.createWriteStream(tmpZip);
                out.on('finish', function () { out.close(function () { unzip(tmpZip, resolve, true); }); }); // 临时 zip 解压后清理（delZip=true）；本地 bundled zip 走 ensureRuntime 的 false 分支保留复用
                out.on('error', function () { tryNext(); });
                resp.pipe(out);
            });
            req.on('timeout', function () { req.destroy(new Error('下载超时（120 秒无数据）')); });
            req.on('error', function () { tryNext(); });
        };
        tryNext();
    });
}

function unzip(zipPath, resolve, delZip) {
    try { fs.mkdirSync(NODE_BIN_DIR, { recursive: true }); } catch (e) { }
    // 解压用系统 PowerShell（Windows 内置 Expand-Archive，无第三方依赖）
    // zip 内层带版本目录（node-vXX-win-x64/），归位：解压后若根目录无 node.exe 则把内层目录内容上提
    // cwd 固定用户主目录：避免继承主进程工作目录（打包部署后的 bin），残留时锁死打包部署目录
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        '$ErrorActionPreference="Stop";' +
        'Expand-Archive -Force -LiteralPath "' + zipPath + '" -DestinationPath "' + NODE_BIN_DIR + '";' +
        'if (-not (Test-Path "' + NODE_EXE + '")) {' +
        '$d = Get-ChildItem -LiteralPath "' + NODE_BIN_DIR + '" -Directory | Select-Object -First 1;' +
        'if ($d) { Move-Item -Force -Path (Join-Path $d.FullName "*") -Destination "' + NODE_BIN_DIR + '"; Remove-Item -Force -Recurse -LiteralPath $d.FullName }' +
        '}'],
        { cwd: os.homedir(), windowsHide: true }); // 原实现：未设置 cwd，子进程继承主进程工作目录
    let errOut = '';
    ps.stderr.on('data', function (d) { errOut += d; });
    ps.on('close', function (code) {
        if (delZip) { try { fs.unlinkSync(zipPath); } catch (e) { } } // 仅联网下载的临时 zip 清理；本地 bundled zip 保留复用
        if (code === 0 && isInstalled()) resolve({ ok: true, msg: 'Node 运行时安装完成（' + NODE_VERSION + (delZip ? '，在线下载' : '，本地 zip 解压') + '）' });
        else resolve({ ok: false, msg: '解压失败：' + ((errOut.trim().split('\n')[0]) || ('退出码 ' + code)) });
    });
    ps.on('error', function (e) { resolve({ ok: false, msg: '解压启动失败：' + e.message }); });
}

module.exports = { ensureRuntime: ensureRuntime, status: status, isInstalled: isInstalled, BIN_DIR: NODE_BIN_DIR, EXE: NODE_EXE };
