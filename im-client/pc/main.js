// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
// 阶段三十七（第三期）：desktopCapturer 静默抓屏 + Alt+A 全局快捷键（微信同款），截图不再弹系统共享选择框
// 阶段三十八：dialog（查看器另存为对话框）+ fs（保存图片写文件）
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, desktopCapturer, ipcMain, globalShortcut, screen, dialog } = require('electron');
const fs = require('fs');
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
    // 阶段三十七（第四期·增强）：悬停托盘弹出预览面板（QQ 同款），200ms 节流避免扫过托盘时频繁弹出
    tray.on('mouse-move', function () {
        if (panelShowTimer) return;
        panelShowTimer = setTimeout(function () {
            panelShowTimer = null;
            showTrayPanel();
        }, 200);
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

// ===== 阶段三十八：图片查看器窗口（QQ 同款：无边框自绘工具栏，置顶/翻页/缩略图/缩放/旋转/另存为） =====
var viewerWin = null; // 查看器窗口（单例复用：重复打开仅刷新内容）

function ensureViewerWindow() {
    if (viewerWin) return viewerWin;
    viewerWin = new BrowserWindow({
        width: 900,
        height: 640,
        minWidth: 480,
        minHeight: 360,
        show: false,
        frame: false,          // 无边框：工具栏自绘（置顶/翻页/缩放等），工具栏区域可拖动窗口
        backgroundColor: '#1e1e1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    viewerWin.loadURL(SERVER_URL + 'image-viewer.html');
    viewerWin.on('close', function (e) {
        // 关闭改为隐藏复用：保留窗口避免频繁重建（页面内 Esc/关闭按钮走同一隐藏逻辑）
        if (viewerWin.isVisible()) {
            e.preventDefault();
            viewerWin.hide();
        }
    });
    viewerWin.on('closed', function () { viewerWin = null; });
    return viewerWin;
}

// 打开图片查看器：渲染层推送 {url, list, index}（list 为当前会话全部图片 URL，支持翻页/缩略图）
ipcMain.on('image:open', function (event, data) {
    var win = ensureViewerWindow();
    var show = function () {
        win.webContents.send('viewer:load', data);
        win.show();
        win.focus();
    };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', show);
    } else {
        show();
    }
});

// 查看器置顶切换（工具栏图钉按钮）
ipcMain.on('image:set-always-on-top', function (event, on) {
    if (viewerWin) viewerWin.setAlwaysOnTop(!!on);
});

// 查看器隐藏（页面 Esc/关闭按钮，与 close 拦截同逻辑）
ipcMain.on('image:close', function () {
    if (viewerWin) viewerWin.hide();
});

// 查看器另存为：渲染层已把图片转 PNG dataURL，主进程弹原生保存对话框后写文件
ipcMain.handle('image:save', async function (event, data) {
    if (!data || !data.dataUrl) return false;
    var win = BrowserWindow.fromWebContents(event.sender);
    var r = await dialog.showSaveDialog(win, {
        defaultPath: data.name || 'img.png',
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (r.canceled || !r.filePath) return false;
    var base64 = data.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    await fs.promises.writeFile(r.filePath, Buffer.from(base64, 'base64'));
    return true;
});

// 查看器请求更早历史图片：转发主聊天窗口（chat.js 走 HISTORY 翻页拉取后回推）
ipcMain.on('image:need-more', function () {
    if (mainWindow) mainWindow.webContents.send('viewer:need-more');
});

// 主聊天窗口推送一批更早历史图片：转发查看器窗口（列表头部插入，联动翻页/缩略图）
ipcMain.on('image:more', function (event, urls) {
    if (viewerWin) viewerWin.webContents.send('viewer:more', urls);
});

// ===== 阶段三十七（第四期）：托盘未读提醒（微信同款：新消息闪动 + 悬停显示未读数 + 图标数字角标） =====
// 阶段三十七（第四期·增强）：悬停预览面板（QQ 同款：无边框自绘窗口，头像+摘要+未读数+可点击跳转会话）
var trayBadgeIcon = null; // 当前角标图标（渲染层 canvas 合成的 PNG dataURL），闪烁结束/未读清零时恢复
var flashTimer = null;    // 托盘闪动定时器（避免重复起闪）
var unreadData = { total: 0, detail: '', list: [] }; // 渲染层上报的最新未读数据缓存（面板数据源）
var panelWin = null;      // 悬停预览面板窗口（惰性创建，显隐复用）
var panelShowTimer = null;// 托盘悬停节流定时器
var currentTooltip = '即时通讯'; // 原生 tooltip 文本（面板显示期间临时置空避免与面板重叠）

// 未读数据上报：渲染层推送 {total, detail, icon, list}
ipcMain.on('tray:unread', function (event, data) {
    if (!tray || !data) return;
    var total = data.total || 0;
    trayBadgeIcon = data.icon || null;
    unreadData = data;
    // 悬停 tooltip：无未读显示应用名，有未读显示明细（渲染层生成，如"admin(2) 群聊(5)"）
    currentTooltip = total > 0 ? '即时通讯（' + (data.detail || total + ' 条未读') + '）' : '即时通讯';
    tray.setToolTip(currentTooltip);
    if (total > 0 && trayBadgeIcon) {
        tray.setImage(nativeImage.createFromDataURL(trayBadgeIcon));
    } else {
        tray.setImage(nativeImage.createFromPath(APP_ICON));
    }
    // 未读归零时同步隐藏预览面板（面板停留时数据已过期）
    if (total === 0) hideTrayPanel();
});

// ===== 托盘悬停预览面板：窗口管理 =====
function ensureTrayPanel() {
    if (panelWin) return panelWin;
    panelWin = new BrowserWindow({
        width: 320,
        height: 200,
        show: false,
        frame: false,          // 无边框自绘（圆角/阴影由面板页面 CSS 实现）
        resizable: false,
        alwaysOnTop: true,
        transparent: true,
        skipTaskbar: true,     // 面板不进任务栏
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    panelWin.loadURL(SERVER_URL + 'tray-panel.html');
    // 点击面板外任意处（面板失焦）自动隐藏
    panelWin.on('blur', function () { hideTrayPanel(); });
    panelWin.on('closed', function () { panelWin = null; });
    return panelWin;
}

function showTrayPanel() {
    if (!tray) return;
    // 无未读时不弹面板（用户反馈：没消息时悬停弹"暂无新消息"多余，有消息才显示）；
    // 此时保留原生 tooltip"即时通讯"即可
    // 原实现：无未读也弹面板并显示"暂无新消息"空态
    if (!(unreadData.list && unreadData.list.length)) return;
    var p = ensureTrayPanel();
    // 高度按未读条目数动态计算：标题 36px + 每条 64px + 上下留白
    var n = Math.min((unreadData.list || []).length, 5);
    var w = 320;
    var h = 36 + n * 64 + 8;
    // 定位：托盘图标水平居中，默认在图标上方（任务栏在顶部时放下方），越界校正到工作区内
    var b = tray.getBounds();
    var disp = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    var wa = disp.workArea;
    var x = Math.round(b.x + b.width / 2 - w / 2);
    var y = b.y > wa.y + wa.height / 2 ? Math.round(b.y - h - 8) : Math.round(b.y + b.height + 8);
    if (x < wa.x + 8) x = wa.x + 8;
    if (x + w > wa.x + wa.width - 8) x = wa.x + wa.width - w - 8;
    p.setBounds({ x: x, y: y, width: w, height: h });
    if (p.isVisible()) {
        p.webContents.send('tray:unread-push', unreadData); // 已显示：仅刷新数据
        return;
    }
    p.showInactive(); // 不抢焦点：不打断当前输入，任务栏闪动状态不被清除
    tray.setToolTip(''); // 面板显示期间隐藏原生 tooltip，避免与面板重叠
    p.webContents.send('tray:unread-push', unreadData); // 推送最新数据（页面未加载完时由 get-unread 兜底拉取）
}

function hideTrayPanel() {
    if (panelWin && panelWin.isVisible()) panelWin.hide();
    if (tray) tray.setToolTip(currentTooltip); // 恢复原生 tooltip 明细
}

// 面板数据拉取（面板加载完成时兜底拉取）
ipcMain.handle('tray:get-unread', function () {
    return unreadData;
});

// 面板请求隐藏（鼠标移出面板时补充隐藏，比 blur 更跟手）
ipcMain.on('tray:hide-panel', function () {
    hideTrayPanel();
});

// 面板条目点击：隐藏面板 → 恢复主窗口 → 转发渲染层跳转对应会话
ipcMain.on('tray:open-conv', function (event, target) {
    hideTrayPanel();
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('tray:open-conv', target);
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
