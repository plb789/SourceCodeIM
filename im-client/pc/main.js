// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

// 服务端地址（默认本地）
const SERVER_URL = 'http://localhost:8888/';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        title: '即时通讯',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(SERVER_URL);

    // 最小化到托盘而非退出
    mainWindow.on('close', function (event) {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function createTray() {
    // 无图标时使用空图标占位
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('即时通讯');
    const contextMenu = Menu.buildFromTemplate([
        { label: '显示主窗口', click: function () { mainWindow.show(); } },
        { label: '退出', click: function () { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('click', function () {
        mainWindow.show();
    });
}

// 桌面通知（供新消息提醒）
function showNotification(title, body) {
    if (Notification.isSupported()) {
        new Notification({ title: title, body: body }).show();
    }
}

app.whenReady().then(function () {
    createWindow();
    createTray();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 导出通知方法供 preload 调用
module.exports = { showNotification: showNotification };
