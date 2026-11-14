// code-updater.js —— 阶段三百：PC 增量热更新主进程模块
// 职责：
//  1. 启动后异步检查服务器代码构建号（独立于产品版本号，独立于 electron-updater 全量更新）
//  2. 发现新版 -> 弹自绘更新窗 -> 用户确认 -> 下载 app.asar + unpacked.zip（~40MB）
//  3. SHA-512 校验 -> 解压 unpacked.zip -> spawn updater.exe（纯 C /MT 守护进程）
//  4. 退出主进程 -> updater.exe 继承管理员令牌替换 asar -> 启动 elevator.exe -> 新版生效
//  5. 回滚：替换失败时 main.js 启动检查 app.asar.bak 自动恢复
// 依赖：Node.js 内置 fetch/crypto/child_process/fs（零额外 npm 依赖）
//       7z.exe（extraResources，已随包）用于解压 unpacked.zip
//       updater.exe（extraResources，本次新增）用于替换 asar + 重启
'use strict';

const { app, BrowserWindow, ipcMain, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const LOG = '[code-updater]';

let SERVER_URL = '';
let getThemeDark = function () { return false; };
let curInfo = null;     // { buildId, buildTime, asarUrl, asarSize, asarHash, hasUnpacked, unpackedUrl, unpackedSize, unpackedHash, notes, force, isExternal }
let curState = { phase: 'idle', percent: 0, msg: '' };
let updateWin = null;
let initialized = false;

// ---- currentBuildInfo 从 asar 内 code-build.json 读取当前代码构建号 + 产品版本 ----
function currentBuildInfo() {
    try {
        const p = path.join(__dirname, 'code-build.json');
        if (!fs.existsSync(p)) return { buildId: 'unknown', productVersion: '' };
        const raw = fs.readFileSync(p, 'utf-8');
        const j = JSON.parse(raw);
        return { buildId: j.buildId || 'unknown', productVersion: j.productVersion || '' };
    } catch (e) { return { buildId: 'unknown', productVersion: '' }; }
}

// ---- resolveUrl 双模式：外链直用，相对路径拼 SERVER_URL ----
function resolveUrl(relOrAbs) {
    if (!relOrAbs) return '';
    if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
    return SERVER_URL.replace(/\/+$/, '') + relOrAbs;
}

// ---- cacheDir ----
function cacheDir() {
    return path.join(app.getPath('userData'), 'CodeUpdate');
}

// ---- resources 目录（updater.exe 在这里）----
function resourcesPath() {
    return process.resourcesPath;
}

// ---- downloadFile 带进度的流式下载 ----
// returns Promise<{size}>，期间触发 onProgress(percent)
// 带重试的文件删除（处理 Windows EBUSY/EPERM）
function rmForceSync(filePath) {
    if (!fs.existsSync(filePath)) return true;
    const max = 10;
    for (let i = 0; i < max; i++) {
        try { fs.unlinkSync(filePath); return true; } catch (e) {
            if ((e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') && i < max - 1) {
                try { require('child_process').execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'ignore' }); } catch (_) {}
                continue;
            }
            return false;
        }
    }
    return false;
}

// 原子替换：把 src（通常是 .tmp）变成 dest。
// 策略：先删 dest → rename src→dest；如果 rename 还撞锁，回退到 PowerShell 原生命令。
function replaceFileAtomicSync(src, dest) {
    // 先确保 dest 目录存在
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

    // --- 策略 1：先删 dest，再 rename（最快路径） ---
    rmForceSync(dest);
    try { fs.renameSync(src, dest); return true; } catch (e) {}

    // --- 策略 2：copyFile 覆盖 + 删 src（Node.js API） ---
    try {
        rmForceSync(dest);
        fs.copyFileSync(src, dest);
        try { fs.unlinkSync(src); } catch (_) {}
        return true;
    } catch (e) {}

    // --- 策略 3：PowerShell Move-Item -Force（调用 Windows 原生 MoveFileEx + COPY_FILE_ALLOW_DECRYPTED_DESTINATION） ---
    try {
        const ps = `Move-Item -Force -LiteralPath '${src.replace(/'/g, "''")}' -Destination '${dest.replace(/'/g, "''")}'`;
        const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
            windowsHide: true, stdio: 'ignore', timeout: 15000
        });
        if (r.status === 0 && fs.existsSync(dest)) {
            try { fs.unlinkSync(src); } catch (_) {}
            return true;
        }
    } catch (e) {}

    // --- 策略 4：PowerShell Copy-Item -Force + Remove-Item -Force ---
    try {
        const ps2 = `Copy-Item -Force -LiteralPath '${src.replace(/'/g, "''")}' -Destination '${dest.replace(/'/g, "''")}'; Remove-Item -Force '${src.replace(/'/g, "''")}'`;
        const r2 = spawnSync('powershell', ['-NoProfile', '-Command', ps2], {
            windowsHide: true, stdio: 'ignore', timeout: 15000
        });
        if (r2.status === 0 && fs.existsSync(dest)) return true;
    } catch (e) {}

    // 全部失败
    return false;
}

function downloadFile(url, destPath, expectedSize, onProgress) {
    return fetch(url).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const parent = path.dirname(destPath);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

        // 清理上一次残留的 .tmp（忽略失败，会被新的覆盖）
        rmForceSync(destPath + '.tmp');

        return new Promise(function (resolve, reject) {
            const file = fs.createWriteStream(destPath + '.tmp');
            const reader = resp.body.getReader();
            let received = 0;
            let streamError = null;
            const total = expectedSize || parseInt(resp.headers.get('content-length') || '0', 10);

            function pump() {
                reader.read().then(function (res) {
                    if (streamError) return;
                    if (res.done) {
                        file.end(function () {
                            if (streamError) return;
                            // 原子替换：.tmp → destPath（带 4 种策略逐级回退）
                            const ok = replaceFileAtomicSync(destPath + '.tmp', destPath);
                            if (!ok || !fs.existsSync(destPath)) {
                                reject(new Error('写入目标失败: 无法替换 ' + path.basename(destPath) + '（可能被其他进程占用）'));
                                return;
                            }
                            resolve({ size: received });
                        });
                        return;
                    }
                    const ok = file.write(res.value);
                    received += res.value.length;
                    if (onProgress && total > 0) {
                        onProgress(Math.round(received / total * 100));
                    }
                    // 缓冲满时等 drain
                    if (!ok) { file.once('drain', pump); } else { pump(); }
                }).catch(function (e) { streamError = e; reject(e); });
            }
            pump();
            file.on('error', function (e) { streamError = e; reject(e); });
        });
    });
}

// ---- sha512File 流式计算文件 SHA-512 ----
// 重要：不能用 fs.createReadStream 读 .asar 后缀文件——Electron 的 asar 感知 fs 会拦截，
// 把它当作归档内部路径读取导致 ENOENT。用 certutil 完全绕开 Electron fs 补丁。
function sha512File(filePath) {
    return new Promise(function (resolve, reject) {
        try {
            if (!fs.existsSync(filePath)) { reject(new Error('文件不存在: ' + filePath)); return; }
            const out = spawnSync('certutil', ['-hashfile', filePath, 'SHA512'], {
                encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024
            });
            if (out.status !== 0) { reject(new Error('certutil exit ' + out.status + ': ' + (out.stderr || out.stdout || '').slice(0, 200))); return; }
            // certutil 输出格式（中文 Windows，两行标题 + 多行 hash）：
            // SHA512 哈希文件 文件名:
            // 文件名:          ← 有时候有第二行重复标题
            // <128 个 hex 字符可能跨行>
            //
            // CertUtil: -hashfile 命令成功完成。
            const hash = (out.stdout || '').split(/\r?\n/)
                .map(function (l) { return l.trim(); })
                .filter(function (l) {
                    // 只保留纯 hex 行（128 字符全小写/大写 hex）
                    return l.length >= 64 && /^[0-9a-fA-F]+$/.test(l);
                })
                .join('').toLowerCase();
            if (!hash || hash.length !== 128) { reject(new Error('certutil 输出解析失败: 期望 128 hex，得到 ' + (hash ? hash.length : 0))); return; }
            resolve('sha512:' + hash);
        } catch (e) { reject(e); }
    });
}

// ---- 7zExtract 用 extraResources 的 7z.exe 解压 ----
// 7z.exe 在 resources/7z/7z.exe（extraResources 已打包）
function sevenZipExtract(zipPath, targetDir) {
    return new Promise(function (resolve, reject) {
        const sevenZip = path.join(resourcesPath(), '7z', '7z.exe');
        if (!fs.existsSync(sevenZip)) { reject(new Error('7z.exe not found at ' + sevenZip)); return; }
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        // 7z x 解压到指定目录，-y 覆盖不提示
        const proc = spawn(sevenZip, ['x', '-y', '-o' + targetDir, zipPath], { windowsHide: true });
        let err = '';
        proc.stderr.on('data', function (d) { err += d.toString(); });
        proc.on('error', reject);
        proc.on('close', function (code) {
            if (code === 0) resolve();
            else reject(new Error('7z exit ' + code + ': ' + err));
        });
    });
}

// ---- spawnUpdater 启动更新守护进程并退出 ----
// updater.exe 和 elevator.exe / im-client.exe 同级（bin/ 根目录，不走 resources/）
// 路径：process.resourcesPath = <bin>/resources/，dirname 后就是 bin/
function spawnUpdater() {
    const installDir = path.dirname(process.resourcesPath); // bin/（elevator.exe / im-client.exe / updater.exe 都在这里）
    const updaterExe = path.join(installDir, 'updater.exe');
    if (!fs.existsSync(updaterExe)) {
        // updater.exe 不存在，降级：提示手动更新
        curState = { phase: 'error', percent: 0, msg: 'updater.exe 未找到，请重新安装客户端' };
        pushState();
        return;
    }
    const cache = cacheDir();
    const args = ['-InstallDir', installDir, '-CacheDir', cache];

    // detached + stdio:ignore + unref -> 让 updater.exe 独立于主进程
    const u = spawn(updaterExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    u.unref();

    // 给 updater.exe 留 300ms 让它启动就绪，然后退出主进程
    setTimeout(function () { app.exit(0); }, 300);
}

// ===== UI 层（自绘更新窗，复用 updater.js 模式）=====

function showWindow() {
    if (updateWin && !updateWin.isDestroyed()) { updateWin.show(); updateWin.focus(); return; }
    var dark = getThemeDark();
    updateWin = new BrowserWindow({
        width: 440,
        height: 380,
        frame: false, resizable: false, movable: true,
        center: true, alwaysOnTop: true,
        skipTaskbar: false, show: false,
        backgroundColor: dark ? '#1a1a1a' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false
        }
    });
    updateWin.on('close', function (e) {
        // 强制更新不可关
        if (curInfo && curInfo.force && curState.phase !== 'installing') e.preventDefault();
    });
    updateWin.on('closed', function () { updateWin = null; });
    updateWin.loadURL(SERVER_URL + 'code-update.html?theme=' + (dark ? 'dark' : 'light'))
        .catch(function () { /* 页面加载失败由页面自身呈现错误态 */ });
    updateWin.once('ready-to-show', function () { if (updateWin && !updateWin.isDestroyed()) updateWin.show(); });
}

function pushState() {
    if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('code-updater:state', curState);
}
function pushInfo() {
    if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('code-updater:info', curInfo);
}

function notify(title, body) {
    try {
        if (Notification.isSupported()) {
            const opts = { title: title, body: body };
            try {
                const icon = nativeImage.createFromPath(path.join(__dirname, '64.ico'));
                if (icon && !icon.isEmpty()) opts.icon = icon;
            } catch (e) {}
            new Notification(opts).show();
        }
    } catch (e) {}
}

// ===== 核心检查 + 下载流程 =====

function ciCompare(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

function check() {
    if (!app.isPackaged) return; // 开发形态跳过
    if (SERVER_URL && SERVER_URL.indexOf('http') !== 0) return; // 无有效地址跳过

    const cur = currentBuildInfo();
    const url = SERVER_URL.replace(/\/+$/, '') + '/api/app/code-update'
        + '?platform=pc&build=' + encodeURIComponent(cur.buildId);

    fetch(url).then(function (r) { return r.json(); })
        .then(function (j) {
            if (!j || !j.data || !j.data.available) return; // 已是最新
            curInfo = {
                buildId: j.data.buildId || '',
                buildTime: j.data.buildTime || '',
                asarUrl: resolveUrl(j.data.asarUrl),
                asarSize: j.data.asarSize || 0,
                asarHash: j.data.asarHash || '',
                hasUnpacked: !!j.data.hasUnpacked,
                unpackedUrl: resolveUrl(j.data.unpackedUrl || ''),
                unpackedSize: j.data.unpackedSize || 0,
                unpackedHash: j.data.unpackedHash || '',
                notes: j.data.notes || '',
                force: !!j.data.force,
                isExternal: !!j.data.isExternal,
                productVersion: cur.productVersion,
                current: cur.buildId
            };
            curState = { phase: 'available', percent: 0, msg: '' };
            pushInfo();
            showWindow();
            pushState();
        })
        .catch(function () { /* 静默失败，不影响主流程 */ });
}

// verifyDownload 下载并校验 asar + unpacked
async function verifyDownload(info) {
    const cache = cacheDir();
    if (!fs.existsSync(cache)) fs.mkdirSync(cache, { recursive: true });

    // 清旧缓存（rmForceSync 自带重试，吞掉 EBUSY/EPERM 静默失败）
    const asarDest = path.join(cache, 'app.asar');
    rmForceSync(asarDest);
    rmForceSync(asarDest + '.tmp');

    curState = { phase: 'downloading', percent: 0, msg: '' };
    pushState();

    // 下载 app.asar
    try {
        await downloadFile(info.asarUrl, asarDest, info.asarSize, function (p) {
            curState = { phase: 'downloading', percent: Math.round(p * 0.9), msg: '下载 asar...' };
            pushState();
        });
    } catch (e) {
        var msg = '[下载 asar 失败] ' + ((e && e.message) || String(e));
        if (e && e.code) msg += ' (' + e.code + ')';
        if (e && e.path) msg += ' path=' + e.path;
        console.error('[code-updater] downloadFile asar failed:', msg);
        curState = { phase: 'error', percent: 0, msg: msg };
        pushState();
        return;
    }

    // 校验 asar SHA-512
    curState = { phase: 'downloading', percent: 92, msg: '校验 asar...' };
    pushState();
    try {
        if (!fs.existsSync(asarDest)) {
            throw new Error('asar 文件不存在（' + asarDest + '）');
        }
        const asarActual = await sha512File(asarDest);
        if (ciCompare(info.asarHash, asarActual)) {
            if (!ciCompare(info.asarHash.replace(/^sha512:/i, ''), asarActual.replace(/^sha512:/i, ''))) {
                rmForceSync(asarDest + '.tmp');
                rmForceSync(asarDest);
                throw new Error('asar SHA-512 校验失败');
            }
        }
    } catch (e) {
        var msg = '[校验 asar 失败] ' + ((e && e.message) || e);
        if (e && e.code) msg += ' (' + e.code + ')';
        if (e && e.path) msg += ' path=' + e.path;
        console.error('[code-updater] verify asar failed:', msg);
        curState = { phase: 'error', percent: 92, msg: msg };
        pushState();
        return;
    }

    // 下载 + 解压 unpacked（如有）
    if (info.hasUnpacked && info.unpackedUrl) {
        const zipDest = path.join(cache, 'unpacked.zip');
        rmForceSync(zipDest);
        rmForceSync(zipDest + '.tmp');

        try {
            await downloadFile(info.unpackedUrl, zipDest, info.unpackedSize, function (p) {
                curState = { phase: 'downloading', percent: Math.round(92 + p * 0.07), msg: '下载 unpacked...' };
                pushState();
            });
        } catch (e) {
            var msg = '[下载 unpacked 失败] ' + ((e && e.message) || e);
            if (e && e.code) msg += ' (' + e.code + ')';
            console.error('[code-updater] downloadFile unpacked failed:', msg);
            curState = { phase: 'error', percent: 92, msg: msg };
            pushState();
            return;
        }

        // 校验 unpacked SHA-512
        if (info.unpackedHash) {
            curState = { phase: 'downloading', percent: 98, msg: '校验 unpacked...' };
            pushState();
            try {
                const upActual = await sha512File(zipDest);
                const cleanHash = (info.unpackedHash || '').replace(/^sha512:/i, '');
                const cleanActual = upActual.replace(/^sha512:/i, '');
                if (cleanHash && cleanHash !== cleanActual) {
                    rmForceSync(zipDest);
                    throw new Error('unpacked.zip SHA-512 校验失败');
                }
            } catch (e) {
                var msg = '[校验 unpacked 失败] ' + ((e && e.message) || e);
                if (e && e.code) msg += ' (' + e.code + ')';
                console.error('[code-updater] verify unpacked failed:', msg);
                curState = { phase: 'error', percent: 98, msg: msg };
                pushState();
                return;
            }
        }

        // 解压 unpacked.zip -> cache/unpacked/ 目录
        curState = { phase: 'downloading', percent: 99, msg: '解压 unpacked...' };
        pushState();
        const unpackedDir = path.join(cache, 'unpacked');
        if (fs.existsSync(unpackedDir)) { try { fs.rmSync(unpackedDir, { recursive: true, force: true }); } catch (e) {} }
        fs.mkdirSync(unpackedDir, { recursive: true });
        try {
            await sevenZipExtract(zipDest, unpackedDir);
        } catch (e) {
            var msg = '[解压 unpacked 失败] ' + ((e && e.message) || e);
            console.error('[code-updater] extract unpacked failed:', msg);
            curState = { phase: 'error', percent: 99, msg: msg };
            pushState();
            return;
        }
        rmForceSync(zipDest);
    }

    curState = { phase: 'downloaded', percent: 100, msg: '' };
    pushState();
}

// ===== IPC 注册 =====
let ipcRegistered = false;
function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle('code-updater:info', function () { return { info: curInfo, state: curState }; });

    ipcMain.on('code-updater:download', function () {
        if (!curInfo) return;
        if (curState.phase === 'downloading' || curState.phase === 'downloaded' || curState.phase === 'installing') return;
        verifyDownload(curInfo).catch(function (e) {
            curState = { phase: 'error', percent: curState.percent, msg: (e && e.message) || '下载失败' };
            pushState();
        });
    });

    ipcMain.on('code-updater:install', function () {
        if (curState.phase !== 'downloaded') return;
        curState = { phase: 'installing', percent: 100, msg: '正在重启应用...' };
        pushState();
        spawnUpdater();
    });

    ipcMain.on('code-updater:dismiss', function () {
        if (curInfo && curInfo.force) return;
        if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    });

    // 托盘/设置页手动检查入口
    ipcMain.on('code-updater:check', function () { check(); });
}

// ===== main.js 归口入口 =====
function init(opts) {
    SERVER_URL = opts.serverUrl || '';
    getThemeDark = opts.getThemeDark || getThemeDark;
    if (!app.isPackaged) return; // 开发形态整体跳过
    registerIpc();
    // 启动后异步检查（比全量 updater 晚触发，不抢启动资源）
    setTimeout(function () { check(); }, 10000);
}

module.exports = { init: init, check: check };
