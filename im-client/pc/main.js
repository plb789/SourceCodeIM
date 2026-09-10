// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
// 阶段三十七（第三期）：desktopCapturer 静默抓屏 + Alt+A 全局快捷键（微信同款），截图不再弹系统共享选择框
// 阶段三十八：dialog（查看器另存为对话框）+ fs（保存图片写文件）
// 阶段六十：Agent 本地执行器——服务端下发的文件/命令工具在用户电脑本地执行（agent-executor.js 核心 + agent:exec IPC）
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, desktopCapturer, ipcMain, globalShortcut, screen, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const agentExecutor = require('./agent-executor.js');

let mainWindow = null;
let tray = null;

// 阶段四十五：禁用 Windows Fluent/Overlay 悬浮滚动条特性——新 Chromium 在滚轮滚动时会浮现原生悬浮滚动条，
// 且该特性无视页面 ::-webkit-scrollbar 自定义样式，与自绘悬浮滑块叠加出现"同一条轨道两条滚动条"。
// 禁用后原生滚动条完全由页面 CSS 控制（宽度归零），仅保留自绘滑块
app.commandLine.appendSwitch('disable-features', 'FluentOverlayScrollbar,FluentScrollbar,OverlayScrollbar,OverlayScrollbars');

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

// 阶段六十六：渲染层系统通知转发（Agent 任务完结提醒等场景）
ipcMain.on('notify', function (event, payload) {
    showNotification(String((payload && payload.title) || '即时通讯'), String((payload && payload.body) || ''));
});

// ===== 阶段三十七（第三期）：静默抓屏 =====
// 抓取主屏全分辨率画面并转为 dataURL（desktopCapturer 无系统共享弹窗，替代浏览器 getDisplayMedia 的 PC 端方案）
// useJpeg=true 时编码 JPEG（质量 90，编码比 PNG 快数倍，冻结截图预览画质足够）；默认 PNG
function captureScreen(useJpeg) {
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
        // toJPEG 返回 Buffer（二进制），需转 base64 dataURL 字符串——直接传 Buffer 渲染层无法按 dataURL 解析
        // 原实现：useJpeg ? src.thumbnail.toJPEG(90) : src.thumbnail.toDataURL()（Buffer 被当 dataURL 用导致"截图失败"且全屏卡住）
        return useJpeg
            ? 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(90).toString('base64')
            : src.thumbnail.toDataURL();
    });
}

// 渲染进程主动抓屏（截图按钮入口）：invoke('shot:capture') → 返回 PNG dataURL
// 阶段三十八：QQ 同款全屏冻结截图——先让主窗口从画面上消失（不挡要截的内容）→ 抓屏 → 全屏+置顶展示冻结画面
// 优化1：setOpacity(0) 代替 hide——即时生效无动画且不引起任务栏闪动
// 优化2（就绪后揭幕）：抓屏完成时窗口仍保持全透明，先把快照推给渲染层加载冻结编辑器（此时用户看的仍是桌面），
//       编辑器首帧绘制就绪（shot:ready）后再透明度归位——揭幕即冻结画面，消除"聊天界面闪现"，桌面暴露期大幅缩短
async function captureWithHide() {
    var wasVisible = mainWindow && mainWindow.isVisible();
    if (mainWindow && !wasVisible) {
        // 托盘驻留（窗口隐藏）：维持隐藏，抓屏后由 show 带出
    } else if (mainWindow) {
        mainWindow.setOpacity(0); // 即时全透明（窗口仍占位，无 hide/show 动画与任务栏闪动）
    }
    // Windows 合成器输出"无本窗口"新帧需要一小段时间，抓早了仍可能拍到本窗口（150ms 为实测安全值）
    await new Promise(function (r) { setTimeout(r, 150); });
    var dataUrl = null;
    try {
        // JPEG 质量 90：比 PNG 编码快数倍（1080p 省 50~200ms），预览/编辑画质足够；
        // 最终发送的是编辑器选区裁剪后重新编码的图，不受底图格式影响
        dataUrl = await captureScreen(true);
    } catch (err) {
        console.warn('抓屏失败:', err);
    }
    if (!dataUrl) {
        // 抓屏失败：立即恢复正常窗口（编辑器打不开，退回聊天界面）
        if (mainWindow) {
            if (!wasVisible) mainWindow.show();
            mainWindow.setOpacity(1);
            mainWindow.focus();
        }
        return null;
    }
    // 先切全屏+置顶（窗口仍全透明，用户无感知），渲染层视口即为全屏尺寸，编辑器按全屏铺满
    mainWindow.setFullScreen(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (!wasVisible) mainWindow.show();
    // 推送渲染层预备冻结编辑器（解码+画布绘制在窗口透明期间后台完成）
    var readyPromise = new Promise(function (resolve) {
        var settled = false;
        // 超时保护：渲染层异常（解码失败/脚本错误）时 1.2s 后强制揭幕，避免窗口永远透明卡死
        shotReadyWaiter = function () {
            if (settled) return;
            settled = true;
            resolve();
        };
        setTimeout(function () { shotReadyWaiter && shotReadyWaiter(); }, 1200);
    });
    mainWindow.webContents.send('shot:prepare', dataUrl);
    await readyPromise;
    // 编辑器就绪（或超时兜底）：揭幕——用户看到的第一帧就是全屏冻结画面
    mainWindow.setOpacity(1);
    mainWindow.focus();
    return dataUrl;
    // 原实现：mainWindow.hide() + 300ms 延时（用户反馈屏幕空窗闪烁明显，且 hide/show 引起任务栏闪动）
    // 第二版：抓屏成功立即 setOpacity(1)（揭幕时窗口内容还是聊天界面，编辑器稍后才盖上——双重闪烁）
}

// 冻结编辑器就绪信号（渲染层首帧绘制完成回调，消费 shotReadyWaiter 解除揭幕等待）
let shotReadyWaiter = null;
ipcMain.on('shot:ready', function () {
    if (shotReadyWaiter) {
        var w = shotReadyWaiter;
        shotReadyWaiter = null;
        w();
    }
});

// 退出全屏冻结态（渲染层编辑器关闭/发送完成后调用，恢复普通窗口与层级）
ipcMain.on('shot:exit-freeze', function () {
    if (!mainWindow) return;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
});

ipcMain.handle('shot:capture', function () {
    return captureWithHide();
    // 原实现：直接抓屏（主窗口未隐藏，聊天窗口会挡住想要截取的屏幕内容）
    // return captureScreen();
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

// ===== 阶段六十：Agent 本地执行器 =====
// 服务端 Agent 状态机经 WS → 渲染进程（chat.js 桥接）→ 本 IPC → 本地执行文件/命令 → 结果原路回传服务端。
// 工作区：userData/agent_workspace/<用户名>/（与微信文件同级的用户数据目录，按用户名隔离）；
// 路径安全/限额/超时全部归口 agent-executor.js（与服务端同款语义），审批归口仍在服务端
agentExecutor.setRoot(path.join(app.getPath('userData'), 'agent_workspace'));
// 阶段八十：本地变更审查备份根目录（写/改/删首触备份原文件字节；撤销/保留经执行器下行清理）
agentExecutor.setBackupRoot(path.join(app.getPath('userData'), 'agent_change_backups'));
ipcMain.handle('agent:exec', function (event, req) {
    return new Promise(function (resolve) {
        // 阶段六十一：执行前按请求用户名注入该用户的沙箱白名单（主工作区/授权目录，未配置=默认工作区语义）
        agentExecutor.setSandbox(req && req.username, sandboxStore[String((req && req.username) || '')] || null);
        // 阶段七十五：run_command 输出帧实时推渲染层（渲染层盖 task_id/step 戳后经 WS 上行服务端转控制台事件）
        req.onFrame = function (frame) {
            if (!event.sender.isDestroyed()) event.sender.send('agent:output', frame);
        };
        agentExecutor.execTool(req, function (result) {
            resolve(result);
        });
    });
});

// 阶段七十五：长命令"转后台"请求（渲染层 ← 服务端下行 msg 61 桥接）——命中运行中命令立即返回不阻塞模型
ipcMain.on('agent:bg', function (event, req) {
    agentExecutor.requestBg(String((req && req.username) || ''));
});

// 阶段七十六：工作区文件面板操作（web 右侧文件树/预览/编辑 ← 服务端下行 msg 64 桥接）——
// 与 agent:exec 同款：执行前按请求用户名注入沙箱白名单，路径校验/限额归口 agent-executor.js
ipcMain.handle('agent:fileop', function (event, req) {
    agentExecutor.setSandbox(String((req && req.username) || ''), sandboxStore[String((req && req.username) || '')] || null);
    return agentExecutor.fileOp(String((req && req.username) || ''), req || {});
});

// ===== 阶段七十七：控制台本地终端（Trae CN 同款多标签）=====
// 渲染层控制台手敲命令 → 本 IPC → 执行器逐命令本地执行；输出/退出帧经 'agent:term-event' 推回渲染层
// （纯本地环路不经服务端，任意命令不进服务端面）；执行前按用户名注入沙箱白名单与文件面板同款
ipcMain.handle('agent:term', function (event, req) {
    agentExecutor.setSandbox(String((req && req.username) || ''), sandboxStore[String((req && req.username) || '')] || null);
    return agentExecutor.termOp(req || {}, function (frame) {
        if (!event.sender.isDestroyed()) event.sender.send('agent:term-event', frame);
    });
});

// ===== 阶段六十一：用户自选工作区/沙箱白名单 =====
// 用户在渲染层工作区面板自选任意文件夹作为主工作区并维护授权目录白名单（原生目录选择对话框），
// 配置持久化在本机 userData/agent_sandbox.json（按用户名隔离，本地磁盘路径机器相关，不上服务端数据库）；
// 每次本地执行前按请求用户名注入执行器（setSandbox），白名单变更由渲染层经 WS 上报服务端（msg 52）注入提示词
const sandboxFile = path.join(app.getPath('userData'), 'agent_sandbox.json');
const sandboxStore = (function () {
    try {
        const v = JSON.parse(fs.readFileSync(sandboxFile, 'utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) {}
    return {};
})();

function sandboxSaveStore() {
    try {
        fs.writeFileSync(sandboxFile, JSON.stringify(sandboxStore, null, 2), 'utf8');
    } catch (e) {}
}

// 每目录数量/路径长度上限（与执行器/服务端语义一致，防滥用）
const SANDBOX_MAX_DIRS = 10;
const SANDBOX_MAX_PATH_LEN = 512;

function sandboxNormalize(cfg) {
    const dirs = [];
    const seen = {};
    (cfg && cfg.dirs || []).forEach(function (d) {
        d = String(d || '').trim();
        if (!d || d.length > SANDBOX_MAX_PATH_LEN || seen[d]) return;
        seen[d] = true;
        dirs.push(d);
    });
    if (dirs.length > SANDBOX_MAX_DIRS) dirs.length = SANDBOX_MAX_DIRS;
    let primary = String((cfg && cfg.primary) || '').trim();
    if (primary.length > SANDBOX_MAX_PATH_LEN || (primary && seen[primary] === undefined)) primary = dirs[0] || '';
    return { primary: primary, dirs: dirs };
}

// 渲染层拉取当前用户沙箱配置
ipcMain.handle('sandbox:get', function (event, username) {
    return sandboxStore[String(username || '')] || { primary: '', dirs: [] };
});

// 渲染层保存沙箱配置（校验裁剪后持久化 + 返回归一化结果；上报服务端由渲染层归口）
ipcMain.handle('sandbox:save', function (event, payload) {
    const username = String((payload && payload.username) || '');
    if (!username) return { ok: false, msg: '缺少用户名' };
    const cfg = sandboxNormalize(payload);
    if (cfg.dirs.length) {
        sandboxStore[username] = cfg;
    } else {
        delete sandboxStore[username]; // 空白名单=清除，回默认工作区语义
    }
    sandboxSaveStore();
    return { ok: true, cfg: cfg };
});

// 原生目录选择对话框（用户自选主工作区/授权目录入口）
ipcMain.handle('sandbox:choose', async function (event, title) {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const r = await dialog.showOpenDialog(win, {
        title: String(title || '选择工作区文件夹'),
        properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return '';
    return r.filePaths[0];
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
    // 阶段三十八：改走 captureWithHide——先让主窗口消失再抓屏（QQ 同款），可截到被自己窗口挡住的内容；
    // 快照经 shot:prepare 推送渲染层预加载冻结编辑器，就绪后揭幕（此处不再单独推送，避免重复打开）
    var shortcutOk = globalShortcut.register('Alt+A', function () {
        captureWithHide().catch(function (err) {
            console.warn('Alt+A 全局截图失败:', err);
        });
        // 原实现：抓屏后 send('shot:global-result') 推送渲染层打开编辑器（与 prepare 链路重复）
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
