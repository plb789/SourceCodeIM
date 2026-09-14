// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
// 阶段三十七（第三期）：desktopCapturer 静默抓屏 + Alt+A 全局快捷键（微信同款），截图不再弹系统共享选择框
// 阶段三十八：dialog（查看器另存为对话框）+ fs（保存图片写文件）
// 阶段六十：Agent 本地执行器——服务端下发的文件/命令工具在用户电脑本地执行（agent-executor.js 核心 + agent:exec IPC）
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, desktopCapturer, ipcMain, globalShortcut, screen, dialog, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const agentExecutor = require('./agent-executor.js');
// 阶段九十：PC 端用户自定义 MCP 服务器管理器（本地 stdio 常驻会话/工具发现/调用，执行器经 require 直接调用）
const mcpManager = require('./mcp-manager.js');
// 阶段九十一：内置浏览器管理器（TRAE CN 同款浏览区——多标签页/Agent 工具直调/CDP 端口开关）
const browserManager = require('./browser-manager.js');

let mainWindow = null;
let tray = null;

// 阶段四十五：禁用 Windows Fluent/Overlay 悬浮滚动条特性——新 Chromium 在滚轮滚动时会浮现原生悬浮滚动条，
// 且该特性无视页面 ::-webkit-scrollbar 自定义样式，与自绘悬浮滑块叠加出现"同一条轨道两条滚动条"。
// 禁用后原生滚动条完全由页面 CSS 控制（宽度归零），仅保留自绘滑块
app.commandLine.appendSwitch('disable-features', 'FluentOverlayScrollbar,FluentScrollbar,OverlayScrollbar,OverlayScrollbars');

// 阶段九十一：CDP 远程调试端口开关（Chrome DevTools Protocol，OpenClaw/TraeClaw 控制 Trae 同款）——
// 必须在 app ready 前注入启动参数（Chromium 仅启动时读取）。userData/agent_browser.json 配置
// {cdp_port: 9222} 开启（默认关闭）；开启后任何本机 CDP 客户端可附加窗口读页/执行 JS，
// 等同本机进程完全控制客户端，仅建议开发调试场景开启
browserManager.setCdpSwitch();

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
        // 阶段七十七：自定义标题栏——隐藏系统标题栏，由网页自绘顶栏（整条可拖动窗口/双击最大化还原），
        // 最小化/最大化/关闭仍用原生 overlay 按钮（保留分屏布局悬停/窗口阴影/边缘缩放），
        // 按钮底色/符号色随主题经 titlebar:overlay IPC 动态更新（初始浅色，与渲染层首次同步前一致）
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#f5f5f5', symbolColor: '#333333', height: 34 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // 阶段九十三：浏览区网页标签改用 <webview> 承载（真 Chromium 内核但是 DOM 元素，
            // 与 file 标签 iframe 同层级）——工具提示/弹窗遮罩/分隔线等页面 DOM 不再被原生层遮挡
            webviewTag: true
        }
    });

    mainWindow.loadURL(SERVER_URL);

    // 阶段九十二：主窗口固定 100% 缩放——页面缩放（Ctrl+滚轮）会让 CSS px 与 BrowserView
    // bounds（DIP）刻度错位（原生视图盖住分隔线/相邻 UI），且 Chromium 可能在会话配置里
    // 持久化过非 1 缩放（如 0.9），启动归一；配合渲染层禁用缩放入口（chat.js wheel/keydown）
    mainWindow.webContents.setZoomFactor(1);

    // 阶段九十三：主窗口刷新快捷键——Menu.setApplicationMenu(null) 后默认刷新键全部失效，
    // 页面（css/js）发版后只能重启客户端才能拿到新版（实例：列表折叠按钮定位修复后 PC 端
    // 始终加载旧样式，用户误以为修复无效）。注册：Ctrl+R / F5 = reload（回源校验，配合
    // 服务端静态资源 no-cache 拿最新）；Ctrl+Shift+R = reloadIgnoringCache（绕过一切缓存强刷）
    mainWindow.webContents.on('before-input-event', function (event, input) {
        if (input.type !== 'keyDown') return;
        var key = (input.key || '').toLowerCase();
        var ctrl = input.control || input.meta;
        if (ctrl && key === 'r') {
            event.preventDefault();
            if (input.shift) mainWindow.webContents.reloadIgnoringCache();
            else mainWindow.webContents.reload();
        } else if (key === 'f5') {
            event.preventDefault();
            mainWindow.webContents.reload();
        }
    });

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

// 阶段七十七：渲染层主题切换时同步原生窗口按钮（titleBarOverlay）配色，浅色/深色跟随主题；
// 非 Windows 平台无 overlay 支持时 setTitleBarOverlay 会抛错，静默失败即可（按钮本就不存在）
ipcMain.handle('titlebar:overlay', function (event, colors) {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !colors || !colors.color) return false;
    try {
        win.setTitleBarOverlay({
            color: String(colors.color),
            symbolColor: String(colors.symbolColor || '#333333')
        });
        return true;
    } catch (e) {
        return false;
    }
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

// 阶段一百三十：本地 LSP 悬停（gopls/clangd/pyright 真实类型推导）——渲染层 viewer 页经
// desktop.lspHover 桥接至此，路径按 tab_id → tab.filePath 归口（页面不持有绝对路径），
// 未装语言服务器/超时/异常一律返回 null，viewer 页回落内置静态文档表
ipcMain.handle('lsp:hover', function (event, req) {
    return browserManager.lspHover(req || {});
});

// 阶段七十六：工作区文件面板操作（web 右侧文件树/预览/编辑 ← 服务端下行 msg 64 桥接）——
// 与 agent:exec 同款：执行前按请求用户名注入沙箱白名单，路径校验/限额归口 agent-executor.js；
// 克隆进度多帧：执行器 onProgress 回调 → 'agent:fileop-progress' IPC 推回渲染层（渲染层补 req_id 转发 65 帧到服务端）
ipcMain.handle('agent:fileop', function (event, req) {
    const uname = String((req && req.username) || '');
    agentExecutor.setSandbox(uname, sandboxStore[uname] || null);
    const reqId = String((req && req.req_id) || '');
    return agentExecutor.fileOp(uname, req || {}, function (p) {
        if (event.sender.isDestroyed()) return;
        event.sender.send('agent:fileop-progress', Object.assign({ req_id: reqId }, p || {}));
    });
});

// ===== 阶段七十八：克隆 Token 记忆（PC safeStorage 按 host 加密存本机）=====
// 私有仓库 PAT 记忆归口：safeStorage 用 OS 级凭据加密（Windows DPAPI），密文落 userData/agent_tokens.json；
// 按 host 一条（github.com / gitlab.example.com…），空 token = 删除该 host 记录；浏览器端无 safeStorage 天然不提供
const tokenFile = path.join(app.getPath('userData'), 'agent_tokens.json');

function tokenStoreLoad() {
    try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')) || {}; } catch (e) { return {}; }
}

function tokenStoreSave(store) {
    try { fs.writeFileSync(tokenFile, JSON.stringify(store)); } catch (e) {}
}

ipcMain.handle('agent:token-get', function (event, req) {
    const host = String((req && req.host) || '').toLowerCase().trim();
    if (!host || !safeStorage.isEncryptionAvailable()) return { token: '' };
    const store = tokenStoreLoad();
    const enc = store[host];
    if (!enc) return { token: '' };
    try {
        return { token: safeStorage.decryptString(Buffer.from(enc, 'base64')) };
    } catch (e) {
        delete store[host]; // 解密失败（换机/凭据变更）即清除脏数据
        tokenStoreSave(store);
        return { token: '' };
    }
});

ipcMain.handle('agent:token-set', function (event, req) {
    const host = String((req && req.host) || '').toLowerCase().trim();
    const token = String((req && req.token) || '');
    if (!host) return { ok: false };
    const store = tokenStoreLoad();
    if (!token) {
        delete store[host]; // 取消记住 = 删除该 host 记录
    } else {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统不支持凭据加密' };
        store[host] = safeStorage.encryptString(token).toString('base64');
    }
    tokenStoreSave(store);
    return { ok: true };
});

// ===== 阶段八十一：SSH 快连簿（PC 本地 userData/agent_ssh.json）=====
// 仅存 host/port/user/备注（无密码——密码/密钥认证由 ssh 自己的机制处理），按 host|port|user 去重置顶，上限 10 条
const sshBookFile = path.join(app.getPath('userData'), 'agent_ssh.json');

function sshBookLoad() {
    try { const l = JSON.parse(fs.readFileSync(sshBookFile, 'utf8')); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}

function sshBookSave(list) {
    try { fs.writeFileSync(sshBookFile, JSON.stringify(list)); } catch (e) {}
}

ipcMain.handle('agent:ssh-list', function () {
    return { list: sshBookLoad() };
});

ipcMain.handle('agent:ssh-save', function (event, req) {
    const host = String((req && req.host) || '').trim().toLowerCase();
    const user = String((req && req.user) || '').trim();
    const port = parseInt(req && req.port, 10) || 22;
    const name = String((req && req.name) || '').trim();
    if (!host) return { ok: false, error: '主机不能为空' };
    const list = sshBookLoad().filter(function (it) {
        return !(it.host === host && it.user === user && (it.port || 22) === port);
    });
    list.unshift({ host: host, user: user, port: port, name: name, ts: Date.now() });
    sshBookSave(list.slice(0, 10));
    return { ok: true };
});

ipcMain.handle('agent:ssh-del', function (event, req) {
    const host = String((req && req.host) || '').trim().toLowerCase();
    const user = String((req && req.user) || '').trim();
    const port = parseInt(req && req.port, 10) || 22;
    sshBookSave(sshBookLoad().filter(function (it) {
        return !(it.host === host && it.user === user && (it.port || 22) === port);
    }));
    return { ok: true };
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

// ===== 阶段九十：用户自定义 MCP 服务器（TRAE 同款本地 stdio） =====
// 配置持久化在本机 userData/agent_mcp.json（按用户名隔离，env 里的 API Key 等凭据不出本机）；
// 运行时归口 mcp-manager.js（常驻会话/工具发现/调用），工具清单由渲染层经 WS 上报服务端（msg 67）注入模型
const mcpFile = path.join(app.getPath('userData'), 'agent_mcp.json');

function mcpStoreLoad() {
    try {
        const v = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) {}
    return {};
}

function mcpStoreSave(store) {
    try { fs.writeFileSync(mcpFile, JSON.stringify(store, null, 2), 'utf8'); } catch (e) {}
}

const MCP_MAX_SERVERS = 10;
const MCP_NAME_RE = /^[0-9A-Za-z_\-\u4e00-\u9fa5]{1,64}$/;

// 配置归一化裁剪（与执行器/管理器语义一致，防滥用）：stdio 专属；名称唯一、命令必填、args/env 限额
function mcpNormalize(servers) {
    const out = [];
    const seen = {};
    (Array.isArray(servers) ? servers : []).forEach(function (sv) {
        if (!sv || typeof sv !== 'object' || out.length >= MCP_MAX_SERVERS) return;
        const name = String(sv.name || '').trim();
        const command = String(sv.command || '').trim();
        if (!name || !MCP_NAME_RE.test(name) || seen[name] || !command || command.length > 512) return;
        seen[name] = true;
        const args = [];
        (Array.isArray(sv.args) ? sv.args : []).forEach(function (a) {
            const s = String(a || '');
            if (args.length < 32 && s.length <= 1024) args.push(s);
        });
        const env = {};
        const keys = Object.keys(sv.env && typeof sv.env === 'object' ? sv.env : {});
        keys.forEach(function (k) {
            if (Object.keys(env).length >= 16 || !k || k.length > 128) return;
            const v = String(sv.env[k] || '');
            if (v.length <= 2048) env[k] = v;
        });
        out.push({
            name: name,
            transport: 'stdio',
            command: command,
            args: args,
            env: env,
            enabled: sv.enabled !== false
        });
    });
    return out;
}

// 按用户名+服务器名查配置（执行器兜底建连时反查）
function mcpCfgGetter(username, serverName) {
    const store = mcpStoreLoad();
    const list = store[String(username || '')] && store[String(username || '')].servers || [];
    for (let i = 0; i < list.length; i++) {
        if (list[i].name === serverName) return list[i];
    }
    return null;
}
agentExecutor.setMcpCfgGetter(mcpCfgGetter);

// 内置 Computer Use 服务器开关（mcp store 的 __builtin 键归口；默认启用，随客户端启动自动拉起）
function mcpBuiltinEnabledLoad() {
    const store = mcpStoreLoad();
    return !(store.__builtin && store.__builtin.enabled === false);
}
mcpManager.setBuiltinEnabled(mcpBuiltinEnabledLoad());

// 切换内置服务器开关（保存 + 重建全部用户会话；内置在 setConfig 内部合并）
ipcMain.handle('mcp:builtin-toggle', function (event, payload) {
    const enabled = !!(payload && payload.enabled);
    const store = mcpStoreLoad();
    store.__builtin = { enabled: enabled };
    mcpStoreSave(store);
    mcpManager.setBuiltinEnabled(enabled);
    // 已登录用户全部重建（登录后首连由 mcp:sync-state 兜底，这里处理在线用户）
    Object.keys(store).forEach(function (uname) {
        if (uname === '__builtin') return;
        const rec = store[uname];
        if (rec && rec.servers) mcpManager.setConfig(uname, rec.servers);
    });
    return { ok: true, enabled: enabled };
});

// ===== 阶段一百一十六：项目级 MCP（TRAE 同款）——自动从项目根目录 .im/agent_mcp.json 加载 =====

// 项目级 MCP 配置文件路径归口：<工作区根>/.im/agent_mcp.json（工作区根 = 用户自选工作区，未配置回退默认）
function projectMcpFile(username) {
    return path.join(agentExecutor.userRoot(String(username || '')), '.im', 'agent_mcp.json');
}

// 自动创建：加载项目（MCP 面板打开/开关查询）时确保 .im 目录与模板文件存在（UTF-8 无 BOM）
function ensureProjectMcpFile(username) {
    const file = projectMcpFile(username);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 4), 'utf8');
        }
    } catch (e) { void e; }
    return file;
}

// 读取并归一化项目级服务器：支持 {"mcpServers":{"名称":{command,args,env,enabled}}} 标准写法（args 字符串也兼容，空格分词）
function readProjectServers(username) {
    const file = projectMcpFile(username);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { const err = new Error('JSON 解析失败：' + (e.message || e)); err.projectParseError = true; throw err; }
    const map = (data && data.mcpServers) || {};
    const out = [];
    Object.keys(map).forEach(function (name) {
        const c = map[name] || {};
        let args = c.args || [];
        if (typeof args === 'string') args = args.trim() ? args.trim().split(/\s+/) : [];
        if (!c.command) return; // 缺 command 视为占位条目，跳过
        out.push({
            name: String(name).slice(0, 64),
            command: String(c.command),
            args: args.map(String),
            env: (c.env && typeof c.env === 'object') ? c.env : {},
            enabled: c.enabled !== false,
            project: true
        });
        if (out.length >= 10) return; // 与用户配置服务器数上限一致
    });
    return out;
}

const projectMcpLoader = function (username) {
    return readProjectServers(username); // 解析失败经 projectConfigs 静默（错误文本由 status IPC 给面板）
};
mcpManager.setProjectMcp(projectMcpEnabledLoad(), projectMcpLoader);

// ===== 阶段一百一十八：便携 Node 运行时（npx/npm 系插件零依赖，TRAE CN 同款 bundled 运行时机制） =====
// 系统未装 Node 时 mcp-manager spawn npx 失败 → 注入安装器自动下载便携 Node 到 ~/.im-mcp/node → 重试；
// 本模块归口下载安装（国内镜像优先、官方源兜底），IPC 提供面板手动安装入口（与 uv 工具链同构）
const nodeRuntime = require('./node-runtime.js');
mcpManager.setNodeRuntimeInstaller(nodeRuntime.ensureRuntime);

ipcMain.handle('mcp:node-status', function () {
    return nodeRuntime.status();
});

ipcMain.handle('mcp:node-install', function () {
    return nodeRuntime.ensureRuntime();
});

function projectMcpEnabledLoad() {
    const store = mcpStoreLoad();
    return !(store.__projMcp && store.__projMcp.enabled === false);
}

// 项目级 MCP 状态（面板打开即自动创建 .im/agent_mcp.json 并回显解析结果/错误）
ipcMain.handle('mcp:project-status', function (event, payload) {
    const username = String((payload && payload.username) || '');
    if (!username) return { ok: false, msg: '缺少用户名' };
    const file = ensureProjectMcpFile(username);
    let servers = [];
    let error = '';
    try {
        servers = readProjectServers(username);
    } catch (e) {
        error = (e && e.projectParseError) ? (e.message || String(e)) : '读取失败：' + ((e && e.message) || e);
    }
    return { ok: true, enabled: projectMcpEnabledLoad(), file: file, servers: servers, count: servers.length, error: error };
});

// 项目级开关切换（存 __projMcp + 重建会话；重建在 setProjectMcp 内部按 lastServersByUsername 归口）
ipcMain.handle('mcp:project-toggle', function (event, payload) {
    const enabled = !!(payload && payload.enabled);
    const username = String((payload && payload.username) || '');
    const store = mcpStoreLoad();
    store.__projMcp = { enabled: enabled };
    mcpStoreSave(store);
    mcpManager.setProjectMcp(enabled, projectMcpLoader);
    if (username) ensureProjectMcpFile(username); // 关闭再打开也保证模板存在
    return { ok: true, enabled: enabled };
});

// 拉取该用户的 MCP 服务器配置（设置面板回显）；builtinEnabled 供列表渲染内置行
ipcMain.handle('mcp:get', function (event, username) {
    const store = mcpStoreLoad();
    const rec = store[String(username || '')];
    return { servers: (rec && rec.servers) || [], builtinEnabled: mcpBuiltinEnabledLoad() };
});

// 保存配置（归一化落盘 + 重建常驻会话；工具清单上报由渲染层在会话就绪后经 msg 67 归口）
ipcMain.handle('mcp:save', function (event, payload) {
    const username = String((payload && payload.username) || '');
    if (!username) return { ok: false, msg: '缺少用户名' };
    const servers = mcpNormalize(payload && payload.servers);
    const store = mcpStoreLoad();
    if (servers.length) {
        store[username] = { servers: servers };
    } else {
        delete store[username]; // 空配置=清除
    }
    mcpStoreSave(store);
    mcpManager.setConfig(username, servers);
    return { ok: true, servers: servers };
});

// 删除单个服务器（保存即断连回收）
ipcMain.handle('mcp:del', function (event, payload) {
    const username = String((payload && payload.username) || '');
    const name = String((payload && payload.name) || '');
    const store = mcpStoreLoad();
    const rec = store[username];
    if (!rec || !name) return { ok: false, msg: '配置不存在' };
    rec.servers = (rec.servers || []).filter(function (sv) { return sv.name !== name; });
    if (rec.servers.length) store[username] = rec; else delete store[username];
    mcpStoreSave(store);
    mcpManager.setConfig(username, rec.servers || []);
    return { ok: true };
});

// 测试连接（临时会话验证，不常驻；返回服务信息/工具清单/耗时）
ipcMain.handle('mcp:test', function (event, cfg) {
    return mcpManager.testServer({
        name: String((cfg && cfg.name) || 'test'),
        command: String((cfg && cfg.command) || ''),
        args: (cfg && cfg.args) || [],
        env: (cfg && cfg.env) || {},
        enabled: true
    });
});

// 会话状态+工具清单快照（渲染层轮询：登录后/保存后等会话就绪即上报 msg 67）；
// 首次同步按本机存储自动拉起常驻会话（登录场景无需显式 start，流程不变）
const mcpSyncSeeded = {};
ipcMain.handle('mcp:sync-state', function (event, username) {
    const uname = String(username || '');
    if (uname && !mcpSyncSeeded[uname]) {
        mcpSyncSeeded[uname] = true;
        const rec = mcpStoreLoad()[uname];
        mcpManager.setConfig(uname, (rec && rec.servers) || []);
    }
    return { tools: mcpManager.listTools(uname), status: mcpManager.status(uname) };
});

// ===== 阶段一百一十三：uv 工具链自动安装（fetch/sqlite 等 Python 系插件依赖） =====
// 安装到用户目录 ~/.im-mcp/bin（无需管理员权限、不改系统 PATH），mcp-manager spawn 时
// 将该目录前置到 PATH 首位；zip 直接取 uv 官方 release（uvx.exe 位于压缩包根目录）
const UV_BIN_DIR = path.join(os.homedir(), '.im-mcp', 'bin');
const UV_X_EXE = path.join(UV_BIN_DIR, 'uvx.exe');
const UV_ZIP_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
let uvInstalling = false; // 防并发安装（mcp:uv-status 状态回显用）
let uvInstallPromise = null; // 阶段一百一十九：并发共享同一次安装（spawn 自动触发与面板手动安装共用，只下载一次）

// findLocalUvZip：按序查找本地已有的 uv 工具链 zip（找到即离线解压，不联网）：
//   1) 开发态构建缓存 <客户端目录>\bundled\uv-runtime.zip（build.bat 首次自动下载缓存）
//   2) 打包内嵌 <resources>\uv-runtime.zip（build.bat 打包后直拷，随安装包分发）
// 注意 process.resourcesPath 仅 Electron 运行态存在，纯 Node 调试（测试脚本）下自动跳过
function findLocalUvZip() {
    const candidates = [
        path.join(__dirname, 'bundled', 'uv-runtime.zip'),
    ];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'uv-runtime.zip'));
    for (let i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) { }
    }
    return null;
}

// uvEnsureRuntime：确保 uv 工具链就绪（已装直接返回；并发调用共享同一安装 Promise）。
// 双通道取源（与 node-runtime 同款优先级）：本地 zip 直接解压（离线可用）→ 本地缺失才联网下载。
// 除面板手动安装（mcp:uv-install）外，同时注入 mcp-manager——uvx 系插件 spawn 预检
// 解析不到 uvx 时自动触发本函数（与 node-runtime.ensureRuntime 同构），成功后原样重启会话
function uvEnsureRuntime() {
    if (fs.existsSync(UV_X_EXE)) return Promise.resolve({ ok: true, installed: true, msg: 'uv 工具链已就绪' });
    if (uvInstallPromise) return uvInstallPromise;
    uvInstalling = true;
    const local = findLocalUvZip();
    const job = local
        ? new Promise(function (resolve) { unzipUv(local, resolve, true); }) // 本地 zip 保留复用，解压后不删除
        : uvDownloadInstall(); // 联网下载到临时文件，解压后清理临时 zip
    uvInstallPromise = job.then(function (r) {
        uvInstalling = false;
        uvInstallPromise = null;
        return r;
    }, function (e) {
        uvInstalling = false;
        uvInstallPromise = null;
        return { ok: false, msg: (e && e.message) || '安装失败' };
    });
    return uvInstallPromise;
}

ipcMain.handle('mcp:uv-status', function () {
    return { installed: fs.existsSync(UV_X_EXE), dir: UV_BIN_DIR, installing: uvInstalling };
});

ipcMain.handle('mcp:uv-install', function () {
    // 原实现：安装中重复调用直接拒绝（uvInstalling 标记各自为政）——现手动/自动安装共用同一 Promise，等待中调用直接复用结果
    // if (fs.existsSync(UV_X_EXE)) return Promise.resolve({ ok: true, installed: true, msg: 'uv 工具链已安装' });
    // if (uvInstalling) return Promise.resolve({ ok: false, msg: '正在安装中，请稍候' });
    // uvInstalling = true;
    // return uvDownloadInstall().then(function (r) { uvInstalling = false; return r; },
    //     function (e) { uvInstalling = false; return { ok: false, msg: (e && e.message) || '安装失败' }; });
    return uvEnsureRuntime();
});

// 阶段一百一十九：注入 mcp-manager——uvx 系插件 spawn 预检失败时自动安装 uv 工具链（与 Node 运行时注入同构）
mcpManager.setUvToolchainInstaller(uvEnsureRuntime);

// 下载（跟随 302 重定向：GitHub release latest 跳对象存储）→ PowerShell Expand-Archive 解压 → 校验 uvx.exe
function uvDownloadInstall() {
    return new Promise(function (resolve) {
        const tmpZip = path.join(os.tmpdir(), 'im-uv-toolchain.zip');
        const doGet = function (url, redirectLeft) {
            if (redirectLeft < 0) { resolve({ ok: false, msg: '下载失败：重定向次数过多' }); return; }
            const req = https.get(url, { headers: { 'User-Agent': 'im-pc-client' }, timeout: 60000 }, function (resp) {
                if (resp.statusCode >= 301 && resp.statusCode <= 308 && resp.headers.location) {
                    resp.resume();
                    doGet(resp.headers.location, redirectLeft - 1);
                    return;
                }
                if (resp.statusCode !== 200) {
                    resp.resume();
                    resolve({ ok: false, msg: '下载失败：HTTP ' + resp.statusCode + '（网络受限时可手动安装 uv 后重启客户端）' });
                    return;
                }
                const out = fs.createWriteStream(tmpZip);
                out.on('finish', function () { out.close(function () { unzipUv(tmpZip, resolve); }); });
                out.on('error', function (e) { resolve({ ok: false, msg: '写入临时文件失败：' + e.message }); });
                resp.pipe(out);
            });
            req.on('timeout', function () { req.destroy(new Error('下载超时（60 秒无数据），请检查网络')); });
            req.on('error', function (e) { resolve({ ok: false, msg: '下载失败：' + e.message }); });
        };
        doGet(UV_ZIP_URL, 5);
    });
}

function unzipUv(zipPath, resolve, keepZip) {
    try { fs.mkdirSync(UV_BIN_DIR, { recursive: true }); } catch (e) { }
    // 解压用系统 PowerShell（Windows 内置 Expand-Archive，无第三方依赖）
    // cwd 固定用户主目录：避免继承主进程工作目录（bin），残留时锁死打包部署目录
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        'Expand-Archive -Force -LiteralPath "' + zipPath + '" -DestinationPath "' + UV_BIN_DIR + '"'],
        { cwd: os.homedir(), windowsHide: true }); // 原实现：未设置 cwd，子进程继承主进程工作目录
    let errOut = '';
    ps.stderr.on('data', function (d) { errOut += d; });
    ps.on('close', function (code) {
        // keepZip=true 为内嵌本地 zip 通道（bundled\ / resources\），解压后保留复用不删除；
        // 下载通道（临时 zip）解压后清理
        // if (true) { try { fs.unlinkSync(zipPath); } catch (e) { } } // 原实现：无条件删除 zip，本地内嵌 zip 会被误删
        if (!keepZip) { try { fs.unlinkSync(zipPath); } catch (e) { } }
        if (code === 0 && fs.existsSync(UV_X_EXE)) resolve({ ok: true, msg: 'uv 工具链安装完成' });
        else resolve({ ok: false, msg: '解压失败：' + ((errOut.trim().split('\n')[0]) || ('退出码 ' + code)) });
    });
    ps.on('error', function (e) { resolve({ ok: false, msg: '解压启动失败：' + e.message }); });
}

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

    // 阶段九十一：内置浏览器管理器初始化（渲染层 IPC 入口注册 + 主窗口引用注入；
    // 需在 createWindow 之后——mainWindow 引用就绪后 agent 工具与面板控制才可用）
    browserManager.init(mainWindow);
    // 阶段九十二：文件查看标签依赖注入——路径校验复用 agentExecutor.safePath（防循环依赖改注入），
    // viewer 页地址随服务端 web 目录同源分发（SERVER_URL + file-viewer.html）
    browserManager.setPathGuard(agentExecutor.safePath);
    // 阶段一百零九：viewer 页加版本参数防 iframe HTTP 缓存命中旧版（页面逻辑更新后改此版本号即可）
    browserManager.setViewerUrl(SERVER_URL + 'file-viewer.html?v=129'); // v=129：LSP 悬停优先层（阶段一百三十）
    // 阶段九十七：任务备份查询/保留/撤销注入（browser-manager 不可反向 require agent-executor，防循环依赖）
    browserManager.setTaskBackupApi({
        get: agentExecutor.getTaskBackup,
        keep: agentExecutor.keepTaskChange,
        revert: agentExecutor.revertTaskChange
    });

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

// 退出前释放全部全局快捷键（避免残留占用），并回收全部 MCP 子进程树
app.on('will-quit', function () {
    globalShortcut.unregisterAll();
    try { mcpManager.disposeAll(); } catch (e) {} // 阶段九十：本机 MCP 服务器进程随应用退出全量回收
    try { browserManager.lspShutdown(); } catch (e) {} // 阶段一百三十：LSP 语言服务器子进程随应用退出全量回收
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 导出通知方法供 preload 调用
module.exports = { showNotification: showNotification };
