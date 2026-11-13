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
const { spawn } = require('child_process');

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
function downloadFile(url, destPath, expectedSize, onProgress) {
    return fetch(url).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        // 确保 parent dir 存在
        const parent = path.dirname(destPath);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

        return new Promise(function (resolve, reject) {
            const file = fs.createWriteStream(destPath + '.tmp');
            const reader = resp.body.getReader();
            let received = 0;
            const total = expectedSize || parseInt(resp.headers.get('content-length') || '0', 10);

            function pump() {
                reader.read().then(function (res) {
                    if (res.done) {
                        file.end(function () {
                            // rename atomically
                            fs.rename(destPath + '.tmp', destPath, function (err) {
                                if (err) { reject(err); return; }
                                resolve({ size: received });
                            });
                        });
                        return;
                    }
                    file.write(res.value);
                    received += res.value.length;
                    if (onProgress && total > 0) {
                        onProgress(Math.round(received / total * 100));
                    }
                    pump();
                }).catch(reject);
            }
            pump();
            file.on('error', reject);
        });
    });
}

// ---- sha512File 流式计算文件 SHA-512 ----
function sha512File(filePath) {
    return new Promise(function (resolve, reject) {
        const hash = crypto.createHash('sha512');
        const stream = fs.createReadStream(filePath);
        stream.on('data', function (chunk) { hash.update(chunk); });
        stream.on('end', function () { resolve('sha512:' + hash.digest('hex')); });
        stream.on('error', reject);
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

    // 清旧缓存
    const asarDest = path.join(cache, 'app.asar');
    if (fs.existsSync(asarDest)) try { fs.unlinkSync(asarDest); } catch (e) {}

    curState = { phase: 'downloading', percent: 0, msg: '' };
    pushState();

    // 下载 app.asar
    await downloadFile(info.asarUrl, asarDest, info.asarSize, function (p) {
        curState = { phase: 'downloading', percent: Math.round(p * 0.9), msg: '下载 asar...' };
        pushState();
    });

    // 校验 asar SHA-512
    curState = { phase: 'downloading', percent: 92, msg: '校验 asar...' };
    pushState();
    const asarActual = await sha512File(asarDest);
    if (ciCompare(info.asarHash, asarActual)) {
        // 格式 mismatch（服务端可能漏了 sha512: 前缀）
        if (ciCompare(info.asarHash.replace(/^sha512:/i, ''), asarActual.replace(/^sha512:/i, ''))) {
            // ok
        } else {
            try { fs.unlinkSync(asarDest + '.tmp'); } catch (e) {}
            try { fs.unlinkSync(asarDest); } catch (e) {}
            throw new Error('asar SHA-512 校验失败');
        }
    }

    // 下载 + 解压 unpacked（如有）
    if (info.hasUnpacked && info.unpackedUrl) {
        const zipDest = path.join(cache, 'unpacked.zip');
        if (fs.existsSync(zipDest)) try { fs.unlinkSync(zipDest); } catch (e) {}

        await downloadFile(info.unpackedUrl, zipDest, info.unpackedSize, function (p) {
            curState = { phase: 'downloading', percent: Math.round(92 + p * 0.07), msg: '下载 unpacked...' };
            pushState();
        });

        // 校验 unpacked SHA-512
        if (info.unpackedHash) {
            curState = { phase: 'downloading', percent: 98, msg: '校验 unpacked...' };
            pushState();
            const upActual = await sha512File(zipDest);
            const cleanHash = (info.unpackedHash || '').replace(/^sha512:/i, '');
            const cleanActual = upActual.replace(/^sha512:/i, '');
            if (cleanHash && cleanHash !== cleanActual) {
                try { fs.unlinkSync(zipDest); } catch (e) {}
                throw new Error('unpacked.zip SHA-512 校验失败');
            }
        }

        // 解压 unpacked.zip -> cache/unpacked/ 目录
        curState = { phase: 'downloading', percent: 99, msg: '解压 unpacked...' };
        pushState();
        const unpackedDir = path.join(cache, 'unpacked');
        if (fs.existsSync(unpackedDir)) { try { fs.rmSync(unpackedDir, { recursive: true }); } catch (e) {} }
        fs.mkdirSync(unpackedDir, { recursive: true });
        await sevenZipExtract(zipDest, unpackedDir);
        try { fs.unlinkSync(zipDest); } catch (e) {}
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
