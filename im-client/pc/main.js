// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
// 阶段三十七（第三期）：desktopCapturer 静默抓屏 + Alt+A 全局快捷键（微信同款），截图不再弹系统共享选择框
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, desktopCapturer, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;

// 服务端地址（默认本地）
const SERVER_URL = 'http://localhost:8888/';

// 应用图标路径（可配置）：托盘图标使用，更换新图标只需改这一处，支持 ico/png 任意文件名与完整路径；
// 注意与 build.bat 的 APP_ICON 变量（exe 图标）同步修改保持一致
// 原实现：createTray 内直接写死 64.ico 文件名
const APP_ICON = path.join(__dirname, '64.ico');

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

    // 窗口聚焦后停止任务栏橙色闪动（托盘图标角标保持，由未读归零时清除）
    mainWindow.on('focus', function () {
        mainWindow.flashFrame(false);
    });
}

function createTray() {
    // 托盘图标使用 APP_ICON 常量（顶部可配置，原实现：空图标占位，Windows 托盘区看不到任何图标）
    // Tray(nativeImage.createEmpty());
    // tray = new Tray(path.join(__dirname, '64.ico'));
    tray = new Tray(APP_ICON);
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

// ===== 阶段三十七（第三期）：静默抓屏 =====
// 抓取主屏全分辨率画面并转为 PNG dataURL（desktopCapturer 无系统共享弹窗，替代浏览器 getDisplayMedia 的 PC 端方案）
function captureScreen() {
    var display = screen.getPrimaryDisplay();
    // 抓屏分辨率必须传入物理像素（逻辑分辨率 * 缩放比），否则高 DPI 屏幕会抓出模糊的低分辨率缩略图
    var size = {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
    };
    return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size }).then(function (sources) {
        // 多显示器环境优先匹配主屏 display_id，匹配不到时退回首个屏幕
        var src = null;
        for (var i = 0; i < sources.length; i++) {
            if (sources[i].display_id === String(display.id)) { src = sources[i]; break; }
        }
        if (!src && sources.length) src = sources[0];
        if (!src) return '';
        return src.thumbnail.toDataURL();
    });
}

// 渲染进程主动抓屏（截图按钮入口）：invoke('shot:capture') → 返回 PNG dataURL
ipcMain.handle('shot:capture', function () {
    return captureScreen();
});

// ===== 阶段三十七（第四期）：托盘未读提醒（微信同款：新消息闪动 + 悬停显示未读数 + 图标数字角标） =====
var trayBadgeIcon = null; // 当前角标图标（渲染层 canvas 合成的 PNG dataURL），闪烁结束/未读清零时恢复
var flashTimer = null;    // 托盘闪动定时器（避免重复起闪）

// 未读数据上报：渲染层推送 {total, detail, icon}
ipcMain.on('tray:unread', function (event, data) {
    if (!tray || !data) return;
    var total = data.total || 0;
    trayBadgeIcon = data.icon || null;
    // 悬停 tooltip：无未读显示应用名，有未读显示明细（渲染层生成，如"admin(2) 群聊(5)"）
    tray.setToolTip(total > 0 ? '即时通讯（' + (data.detail || total + ' 条未读') + '）' : '即时通讯');
    if (total > 0 && trayBadgeIcon) {
        tray.setImage(nativeImage.createFromDataURL(trayBadgeIcon));
    } else {
        tray.setImage(nativeImage.createFromPath(APP_ICON));
    }
});

// 新消息闪动：托盘图标交替隐/显约 3 秒后停止（微信同款节奏），任务栏按钮同步橙色闪动
ipcMain.on('tray:flash', function () {
    if (!tray) return;
    if (mainWindow) mainWindow.flashFrame(true);
    if (flashTimer) return; // 已在闪烁中：任务栏闪动状态保持即可，不重复起定时器
    var shown = true;
    var flashCount = 0;
    flashTimer = setInterval(function () {
        if (!tray) { clearInterval(flashTimer); flashTimer = null; return; }
        shown = !shown;
        tray.setImage(shown ? nativeImage.createFromPath(APP_ICON) : nativeImage.createEmpty());
        flashCount++;
        if (flashCount >= 10) { // 10 次 × 300ms ≈ 3 秒后停止，恢复角标图标
            clearInterval(flashTimer);
            flashTimer = null;
            if (trayBadgeIcon) {
                tray.setImage(nativeImage.createFromDataURL(trayBadgeIcon));
            } else {
                tray.setImage(nativeImage.createFromPath(APP_ICON));
            }
        }
    }, 300);
});

app.whenReady().then(function () {
    // 隐藏 Electron 默认应用菜单：File/Edit/View/Window/Help 为开发调试用途（含刷新/DevTools），正式客户端不展示
    // 原实现：未设置应用菜单，Windows 上自动显示 Electron 默认英文菜单
    // Menu.setApplicationMenu(Menu.buildFromTemplate([]));
    Menu.setApplicationMenu(null);

    createWindow();
    createTray();

    // Alt+A 全局快捷键：任意界面静默抓屏并推送渲染层进入截图编辑器（微信同款快捷键）
    var shortcutOk = globalShortcut.register('Alt+A', function () {
        captureScreen().then(function (dataUrl) {
            if (!dataUrl || !mainWindow) return;
            // 托盘驻留（窗口隐藏）时先恢复窗口，否则编辑器对用户不可见
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.webContents.send('shot:global-result', dataUrl);
        }).catch(function (err) {
            console.warn('Alt+A 全局截图抓屏失败:', err);
        });
    });
    if (!shortcutOk) console.warn('Alt+A 全局快捷键注册失败（可能被其他应用占用）');

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 退出前释放全部全局快捷键（避免残留占用）
app.on('will-quit', function () {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 导出通知方法供 preload 调用
module.exports = { showNotification: showNotification };
