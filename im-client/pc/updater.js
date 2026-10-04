// updater.js —— 阶段二百六十：PC 客户端自动更新（electron-updater 全自动链路）
// 职责：
//  1. 启动静默检查：generic feed 指向服务端 <SERVER_URL>/static/download/win/（latest.yml 由
//     admin 后台"客户端更新"上传 Setup exe 并启用时服务端动态生成，sha512/size 随包校验）；
//  2. 发现新版 → 自绘更新窗（update.html，禁用系统弹窗；主题跟随设置页深浅）展示版本号/说明，
//     用户点"立即更新"后台下载（进度事件推页面进度条），下载完成"重启安装"quitAndInstall 全自动覆盖；
//  3. 强制更新：服务端 force 标记（latest.yml 无该字段，经 /api/app/version?platform=win 附带下发，
//     检查时同步拉取；接口不可达按可选处理），更新窗不可关闭不可跳过；
//  4. 托盘菜单"检查更新"手动触发（explicit）：无新版提示已是最新；有新版弹同一更新窗；
//  5. dev/未打包形态整体静默跳过（autoUpdater 依赖 NSIS 安装器元数据，--dir 形态不可用）。
'use strict';

const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');

let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) { /* electron-updater 未安装：更新能力静默降级，不影响运行 */ }

let SERVER_URL = '';
let getThemeDark = function () { return false; };
let updateWin = null;
let curInfo = null;   // {version, notes, force, size}
let curState = { phase: 'idle', percent: 0, msg: '' };
let explicitCheck = false; // 手动检查标记（无更新时提示）
let installedOnce = false; // IPC 归口注册一次
let ipcCheckRegistered = false; // updater:check IPC 注册一次（不受打包门禁）

// feed 地址：generic provider，url 为目录（electron-updater 自动拼 latest.yml）
function feedUrl() {
    return SERVER_URL.replace(/\/+$/, '') + '/static/download/win/';
}

// fetchForce 拉取服务端强制标记与更新说明（latest.yml 无自定义字段，经版本检查接口补齐；
// 失败静默按默认值，不阻塞更新主流程）
function fetchForce(versionName) {
    return fetch(SERVER_URL + 'api/app/version?platform=win&name=' + encodeURIComponent(app.getVersion()))
        .then(function (r) { return r.json(); })
        .then(function (j) {
            var d = (j && j.data) || {};
            return {
                force: !!d.force,
                notes: d.notes || '',
                size: d.size || 0
            };
        })
        .catch(function () { return { force: false, notes: '', size: 0 }; });
}

function showUpdateWindow() {
    if (updateWin && !updateWin.isDestroyed()) {
        updateWin.show();
        updateWin.focus();
        return;
    }
    var dark = getThemeDark();
    updateWin = new BrowserWindow({
        width: 430,
        height: 340,
        frame: false,
        resizable: false,
        movable: true,
        center: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        show: false,
        backgroundColor: dark ? '#1a1a1a' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    // 强制更新：拦截关闭（用户必须更新；非强制允许关窗=以后再说）
    updateWin.on('close', function (e) {
        if (curInfo && curInfo.force && curState.phase !== 'installing') {
            e.preventDefault();
        }
    });
    updateWin.on('closed', function () { updateWin = null; });
    var u = SERVER_URL + 'update.html?theme=' + (dark ? 'dark' : 'light');
    updateWin.loadURL(u).catch(function () { /* 加载失败由页面错误态呈现 */ });
    updateWin.once('ready-to-show', function () {
        if (updateWin && !updateWin.isDestroyed()) updateWin.show();
    });
}

function pushState() {
    if (updateWin && !updateWin.isDestroyed()) {
        updateWin.webContents.send('updater:state', curState);
    }
}

function pushInfo() {
    if (updateWin && !updateWin.isDestroyed()) {
        updateWin.webContents.send('updater:info', curInfo);
    }
}

function registerIpc() {
    if (installedOnce) return;
    installedOnce = true;
    ipcMain.handle('updater:info', function () { return { info: curInfo, state: curState }; });
    ipcMain.on('updater:download', function () {
        if (curState.phase === 'downloading' || curState.phase === 'downloaded' || curState.phase === 'installing') return;
        curState = { phase: 'downloading', percent: 0, msg: '' };
        pushState();
        autoUpdater.downloadUpdate().catch(function (e) {
            curState = { phase: 'error', percent: 0, msg: (e && e.message) || '下载失败' };
            pushState();
        });
    });
    ipcMain.on('updater:install', function () {
        curState.phase = 'installing';
        pushState();
        // isSilent=false 走 NSIS 默认（oneClick 安装器本身即静默覆盖），forceRunAfter 重启应用
        setTimeout(function () {
            try { autoUpdater.quitAndInstall(false, true); } catch (e) {
                curState = { phase: 'error', percent: 0, msg: (e && e.message) || '安装启动失败' };
                pushState();
            }
        }, 300); // 让渲染层先落"正在安装"态再退进程
    });
    ipcMain.on('updater:dismiss', function () {
        if (curInfo && curInfo.force) return; // 强制更新不可跳过
        if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    });
}

// check 启动检查/托盘手动检查归口；explicit=true 时无论有无更新均给出反馈
function check(explicit) {
    if (!autoUpdater || !app.isPackaged) {
        if (explicit) notifyUser('检查更新', '开发/未打包形态不支持自动更新');
        return;
    }
    explicitCheck = !!explicit;
    try {
        autoUpdater.checkForUpdates().then(function (task) {
            if (!task || !task.updateInfo) return;
            var u = task.updateInfo;
            var version = u.version || '';
            fetchForce(version).then(function (extra) {
                curInfo = {
                    version: version,
                    notes: extra.notes,
                    force: extra.force,
                    size: extra.size || 0,
                    current: app.getVersion()
                };
                curState = { phase: 'available', percent: 0, msg: '' };
                pushInfo();
                showUpdateWindow();
                pushInfo();
                pushState();
            });
        }).catch(function (e) {
            if (explicitCheck) notifyUser('检查更新', '检查失败：' + ((e && e.message) || '网络异常'));
            explicitCheck = false;
        });
    } catch (e) {
        if (explicit) notifyUser('检查更新', '检查失败：' + ((e && e.message) || '未知错误'));
    }
}

function notifyUser(title, body) {
    try {
        if (Notification.isSupported()) new Notification({ title: title, body: body }).show();
    } catch (e) { /* 通知不可用静默 */ }
}

// init main.js 归口入口：注入服务端地址与主题判定，绑定 electron-updater 事件
function init(opts) {
    SERVER_URL = opts.serverUrl || '';
    getThemeDark = opts.getThemeDark || getThemeDark;
    // 阶段二百六十补：设置页"检查更新"入口 IPC 恒注册（未打包形态 check(true) 自会提示不支持）
    if (!ipcCheckRegistered) {
        ipcCheckRegistered = true;
        ipcMain.on('updater:check', function () { check(true); });
    }
    if (!autoUpdater || !app.isPackaged) return;
    registerIpc();
    autoUpdater.autoDownload = false;      // 用户确认后再下载（流量友好）
    autoUpdater.autoStashAppData = false;
    autoUpdater.disableWebInstaller = true; // 仅 NSIS 本地安装，禁用 Windows 内置安装器
    autoUpdater.allowDowngrade = false;
    try {
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() });
    } catch (e) { return; }

    autoUpdater.on('error', function (e) {
        curState = { phase: 'error', percent: curState.percent, msg: (e && e.message) || '更新失败' };
        pushState();
        if (explicitCheck) { notifyUser('检查更新', '检查失败：' + ((e && e.message) || '未知错误')); explicitCheck = false; }
    });
    autoUpdater.on('update-available', function () { /* 信息聚合在 checkForUpdates 回调统一处理 */ });
    autoUpdater.on('update-not-available', function () {
        if (explicitCheck) { notifyUser('检查更新', '已是最新版本 v' + app.getVersion()); explicitCheck = false; }
    });
    autoUpdater.on('download-progress', function (p) {
        curState = { phase: 'downloading', percent: Math.round(p.percent || 0), msg: '' };
        pushState();
    });
    autoUpdater.on('update-downloaded', function (u) {
        curState = { phase: 'downloaded', percent: 100, msg: '' };
        curInfo = curInfo || { version: u.version, notes: '', force: false };
        pushInfo();
        pushState();
        showUpdateWindow();
    });

    // 启动延迟检查（主窗口渲染完成后，避免与登录加载抢资源）
    setTimeout(function () { check(false); }, 8000);
}

module.exports = { init: init, check: check };
