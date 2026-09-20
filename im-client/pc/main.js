// main.js - Electron 主进程：窗口创建、桌面通知、托盘驻留
// 阶段三十七（第三期）：desktopCapturer 静默抓屏 + Alt+A 全局快捷键（微信同款），截图不再弹系统共享选择框
// 阶段三十八：dialog（查看器另存为对话框）+ fs（保存图片写文件）
// 阶段六十：Agent 本地执行器——服务端下发的文件/命令工具在用户电脑本地执行（agent-executor.js 核心 + agent:exec IPC）
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, desktopCapturer, ipcMain, globalShortcut, screen, dialog, safeStorage, net, session, shell } = require('electron');
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
// 阶段一百二十二：网页资源本地缓存管理器（app:// 协议三级回退 + 启动增量同步 + 旧登录态迁移）
const webCache = require('./web-cache.js');

let mainWindow = null;
let tray = null;

// 阶段一百四十一：--user-data-dir 启动参数支持（双开实测/多账号并行场景）——必须在单实例锁请求前
// 重定向 Electron userData（localStorage/IndexedDB/HTTP 缓存全量隔离）。原实现仅传 Chromium 开关，
// Electron 层 userData 仍指向默认目录，双开并发写同一 LevelDB 实测导致后写进程崩溃退出
(function () {
    var a = process.argv.find(function (x) { return x.indexOf('--user-data-dir=') === 0; });
    if (!a) return;
    var p = a.substring('--user-data-dir='.length).trim();
    if (!p) return;
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { }
    app.setPath('userData', p);
})();

// 阶段一百三十四：单实例锁——实测双开（dev 与打包版并存测试）会并发写同一 userData 的
// HTTP 缓存 LevelDB，锁冲突导致图片响应流中断（查看器黑屏、下载文件损坏，2026-09-16 实测）。
// 非首实例立即退出；首实例经 second-instance 唤起主窗口（复刻微信"再次启动回到已开窗口"行为）
// 阶段一百三十四补充：app.quit() 是异步的——第二实例 quit 后 whenReady 仍会触发 createWindow
// 造成"窗口闪现后消失"（实测 2026-09-16），故用锁标志在 whenReady 回调开头二次守卫
// 原实现：if (!app.requestSingleInstanceLock()) { app.quit(); } else { ... }
var singleInstanceAllowed = app.requestSingleInstanceLock();
if (!singleInstanceAllowed) {
    app.quit();
} else {
    app.on('second-instance', function () {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// 阶段一百二十二：同 origin http 拦截方案下无需自定义协议注册
// 原实现（app://local 自定义协议方案）：webCache.registerSchemes() 必须在 app ready 前调用，
// secure 保住 navigator.clipboard 等 secure context 能力——实测跨协议导航存在 ERR_FAILED(-2)
// 稳定性问题后整体改为 session.protocol.handle('http') 拦截（origin 不变，无需协议特权）

// 阶段四十五：禁用 Windows Fluent/Overlay 悬浮滚动条特性——新 Chromium 在滚轮滚动时会浮现原生悬浮滚动条，
// 且该特性无视页面 ::-webkit-scrollbar 自定义样式，与自绘悬浮滑块叠加出现"同一条轨道两条滚动条"。
// 禁用后原生滚动条完全由页面 CSS 控制（宽度归零），仅保留自绘滑块
app.commandLine.appendSwitch('disable-features', 'FluentOverlayScrollbar,FluentScrollbar,OverlayScrollbar,OverlayScrollbars');

// 阶段九十一：CDP 远程调试端口开关（Chrome DevTools Protocol，OpenClaw/TraeClaw 控制 Trae 同款）——
// 必须在 app ready 前注入启动参数（Chromium 仅启动时读取）。userData/agent_browser.json 配置
// {cdp_port: 9222} 开启（默认关闭）；开启后任何本机 CDP 客户端可附加窗口读页/执行 JS，
// 等同本机进程完全控制客户端，仅建议开发调试场景开启
browserManager.setCdpSwitch();

// 阶段一百二十一：显式声明 AppUserModelID（必须在 app ready 之前调用）——
// Windows 任务管理器"应用"分组名与跳转列表归口按 AUMID 解析；不显式声明时 Electron 默认标识
// 导致任务管理器分组名显示为 "Electron"（即便 exe 元数据 FileDescription 已是产品名）。
// 值与 package.json appId 保持一致
app.setAppUserModelId('com.im.client');
// 注册 AUMID 显示名：系统按 AUMID 解析应用名时优先查注册表 DisplayName；未注册则回退 exe 文件名
// （任务栏/任务管理器显示 "im-client.exe"）。HKCU 无需管理员权限，失败静默（名称回退不影响运行）
try {
    require('child_process').execFile('reg', ['add', 'HKCU\\Software\\Classes\\AppUserModelId\\com.im.client', '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'im-client', '/f']);
} catch (e) { }

// 服务端地址（默认本地）
const SERVER_URL = 'https://im.sxgyxny.com/';

// ===== 阶段一百四十五：非安全上下文媒体能力兜底（公网/局域网 IP 部署场景） =====
// SERVER_URL 配置为 http://非localhost（公网/局域网 IP 直连部署）时，Chromium 安全策略对 Electron
// 同样生效——该 origin 下 navigator.mediaDevices 为 undefined（getUserMedia 仅 HTTPS/localhost 可用），
// 通话窗会降级提示"浏览器需 HTTPS 或 localhost 访问方可通话"。此处将该 origin 显式注册为受信任
// 安全上下文（Chromium 官方开关 chrome://flags 同款，必须在 app ready 前注入），PC 端媒体能力与
// localhost 部署完全对齐；服务端升级 HTTPS 后此开关自动失效（仅 http 且非本地地址才注册）
// 原代码：无此兜底，非 localhost 的 http 部署时 PC 端通话不可用
(function () {
    try {
        var su = new URL(SERVER_URL);
        if (su.protocol === 'http:' && su.hostname !== 'localhost' && su.hostname !== '127.0.0.1' && su.hostname !== '[::1]') {
            app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', su.origin);
        }
    } catch (e) { /* SERVER_URL 解析失败：维持默认行为 */ }
})();

// ===== 阶段一百三十六：前端资源加密密钥解析归口 =====
// 密钥来源优先级：1) 构建期生成的 secure-key.js（obfuscate.js 产出，密钥经随机掩码异或扰乱
// 后嵌入，随 app.asar 打包——源码/产物中均无明文密钥可 grep）；2) dev 未打包时回退读取服务端
// config.yaml 的 secure_file_key（与 /api/secure-file 同源，dev 全链路实测用）。
// IM_SECURE=0 环境变量强制关闭加密链路（回退旧版明文行为，排查问题用）。
function resolveSecureKey() {
    if (process.env.IM_SECURE === '0') return '';
    try {
        var m = require('./secure-key.js');
        var mask = Buffer.from(m.m, 'hex');
        var scr = Buffer.from(m.k, 'hex');
        var key = Buffer.alloc(scr.length);
        for (var i = 0; i < scr.length; i++) key[i] = scr[i] ^ mask[i % mask.length];
        if (key.length === 32) return key.toString('hex');
    } catch (e) { /* secure-key.js 未生成（未跑构建混淆）：继续 dev 回退 */ }
    if (!app.isPackaged) {
        try {
            // dev 回退：服务端配置同源密钥（路径锚定仓库结构相对推导，不硬编码绝对路径）
            var cfgPath = path.resolve(__dirname, '..', '..', 'im-server', 'bin', 'config.yaml');
            var txt = fs.readFileSync(cfgPath, 'utf8');
            var mm = /secure_file_key:\s*"?([0-9a-fA-F]{64})"?/.exec(txt);
            if (mm) return mm[1].toLowerCase();
        } catch (e) { /* 服务端配置不可读：加密链路关闭，明文回退 */ }
    }
    return '';
}

// 应用图标路径（可配置）：托盘图标使用，更换新图标只需改这一处，支持 ico/png 任意文件名与完整路径；
// 注意与 build.bat 的 APP_ICON 变量（exe 图标）同步修改保持一致
// 原实现：createTray 内直接写死 64.ico 文件名
const APP_ICON = path.join(__dirname, '64.ico');

// ===== 阶段一百三十四：主题持久化（主进程可读，深色启动底色根治）=====
// 渲染层主题变更时经 theme:sync 上报落盘（userData/im_theme.json），createWindow 创建窗口时读取
// 初值直接按主题深浅设置 titleBarOverlay/backgroundColor，消除深色主题下启动早期短暂浅色底；
// 仅存主题枚举（light/dark/system），system 的深浅运行期由渲染层媒体查询 + titlebar:overlay 联动
const themeFile = path.join(app.getPath('userData'), 'im_theme.json');

function themeStoreLoad() {
    try {
        const t = String((JSON.parse(fs.readFileSync(themeFile, 'utf8')) || {}).theme || '');
        return (t === 'light' || t === 'dark' || t === 'system') ? t : '';
    } catch (e) { return ''; } // 首启/文件损坏回退空值（窗口按浅色初值创建，渲染层同步后即正确）
}

function themeStoreSave(theme) {
    try { fs.writeFileSync(themeFile, JSON.stringify({ theme: theme })); } catch (e) {}
}

// 渲染层主题变更上报持久化（fire-and-forget；chat.js applyTheme 归口调用，浏览器/手机 APP 自动旁路）
ipcMain.on('theme:sync', function (event, theme) {
    var t = String(theme || '');
    if (t === 'light' || t === 'dark' || t === 'system') themeStoreSave(t);
});

function createWindow() {
    // 阶段一百三十四：启动初值按持久化主题解析深浅（原实现：固定浅色初值，深色主题下启动早期
    // 按钮底色/窗口背景短暂浅色，渲染层 applyTheme 同步后才切深色）；system 模式主进程按
    // nativeTheme.shouldUseDarkColors 判定，与渲染层媒体查询同源
    var bootDark = (function () {
        var t = themeStoreLoad();
        // 阶段一百五十一补丁：无持久化偏好（首启/文件缺失）原实现恒浅色初值——改为跟随系统深浅
        //（与渲染层首绘引导、chat.js getTheme 默认 system 三方一致，深色系统首启窗口底不再浅色）
        if (t === '') t = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
    })();
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        title: '即时通讯',
        // 阶段七十七：自定义标题栏——隐藏系统标题栏，由网页自绘顶栏（整条可拖动窗口/双击最大化还原），
        // 最小化/最大化/关闭仍用原生 overlay 按钮（保留分屏布局悬停/窗口阴影/边缘缩放），
        // 按钮底色/符号色随主题经 titlebar:overlay IPC 动态更新（初值按持久化主题解析，与渲染层首次同步前一致）
        titleBarStyle: 'hidden',
        // 原实现：titleBarOverlay: { color: '#f5f5f5', symbolColor: '#333333', height: 34 },（固定浅色初值，深色主题启动早期按钮短暂浅色）
        titleBarOverlay: bootDark
            ? { color: '#1a1a1a', symbolColor: '#e0e0e0', height: 34 }  // 与 chat.js TITLEBAR_COLORS.dark 同值
            : { color: '#f5f5f5', symbolColor: '#333333', height: 34 }, // 与 chat.js TITLEBAR_COLORS.light 同值
        // 阶段一百三十四：最大化/还原白屏修复——补设窗口背景填充色。机制：最大化/还原为尺寸突变，
        // Chromium 丢弃旧帧按新尺寸重绘（整页 re-layout），新帧 present 前 DWM 用窗口 backgroundColor
        // 填充空窗期；原实现未设置，Electron Windows 默认填充白色，深色主题页底 #111111 下闪白刺眼
        // （浅色 #f5f5f5 与白接近难察觉，故此前只深色明显）。填充色=页面底色则闪了也看不见（TRAE CN 同款）；
        // 深浅初值按持久化主题解析（bootDark），运行期经 titlebar:overlay IPC 随按钮配色同步
        // 原实现（本阶段首次修复）：backgroundColor: '#f5f5f5',（固定浅色，深色主题启动早期短暂浅底）
        backgroundColor: bootDark ? '#111111' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // 阶段九十三：浏览区网页标签改用 <webview> 承载（真 Chromium 内核但是 DOM 元素，
            // 与 file 标签 iframe 同层级）——工具提示/弹窗遮罩/分隔线等页面 DOM 不再被原生层遮挡
            webviewTag: true,
            // 阶段一百三十四：启用内置 PDFium 插件——file 标签（file-viewer.html，主窗口同源 iframe）
            // 的 PDF 预览依赖 <embed type="application/pdf">，Electron 默认不启用导致客户端预览空白；
            // iframe 继承宿主窗口插件状态，故必须开在主窗口（浏览区 webview 已另行加 plugins=yes）
            // 原实现：无 plugins 配置
            plugins: true,
            // 阶段一百四十：禁后台节流——录屏链路 rec:begin 会 hide 主窗口（露屏录制），隐藏窗口
            // 默认节流会停掉 requestAnimationFrame，裁剪绘制循环（rAF 驱动 canvas→captureStream）
            // 随之零帧，录出的 webm 只有文件头（size 非空）无法播放（实测：预览浮层黑屏点播放无反应）；
            // 禁用后隐藏窗口 rAF 照跑录制正常。副作用仅主窗口隐藏期间定时器/渲染不节流，聊天页常驻可接受
            backgroundThrottling: false
            // 阶段一百二十二：同 origin http 拦截方案下以下两项已移除（原 app:// 方案所需）——
            // additionalArguments 传服务端地址（页面 origin 不再变化，socket.js 按 location 推导即可）；
            // allowRunningInsecureContent 放开混合内容（http origin 加载 http 外域内容本就不受限）
        }
    });

    // 阶段一百二十二：页面地址恢复为服务端 http 地址（origin 与旧行为完全一致）——
    // 静态资源由 session.protocol.handle('http') 拦截读本地磁盘（缓存→快照→服务端三级回退），
    // 页面秒开且零回源；动态请求透传服务端，资源归口不变。
    // 原实现：mainWindow.loadURL(webCache.pageUrl('/'))（app:// 方案，实测导航稳定性问题后回退）
    // 更早原实现：mainWindow.loadURL(SERVER_URL)（每个静态资源都经服务端 no-cache 回源校验，页面打开慢）
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

    // 阶段一百三十九：退出全屏完成后恢复"移出屏幕隐藏"的窗口原位——leave-full-screen 在 Electron
    // 内部退全屏 bounds 还原之后触发（实测 exit-freeze handler 里立即/延时恢复都会被还原动作覆盖：
    // 150ms~1.8s 内多次 setBounds 均失效，窗口滞留移出态）；延迟 50ms 双保险躲开还原收尾
    mainWindow.on('leave-full-screen', function () {
        // 阶段一百三十九：长截图模式——条窗方案下主窗口不参与落位（原 landStitchToolbar 缩条已停用），
        // 且 stitch:begin 已不在隐藏中退全屏（Windows 隐藏窗口 setFullScreen(false) 会强制显示窗口=黑窗露出，
        // 用户实测），此处仅吞掉事件防止误走聊天原位恢复
        if (stitchToolbarBounds) {
            return;
        }
        if (!shotSavedBounds) return;
        setTimeout(function () { restoreShotHiddenWindow(true); }, 50);
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
        // 阶段一百三十四：最大化/还原白屏修复——主题切换时同步窗口背景填充色与页面底色（--bg）一致，
        // 深色 #111111/浅色 #f5f5f5（与 chat.js TITLEBAR_COLORS.bg 同值）；未传 bg（旧调用方）跳过不影响按钮配色
        if (colors.bg) win.setBackgroundColor(String(colors.bg));
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
// 阶段一百三十九：隐藏主窗口画面改为可选（QQ 同款"隐藏当前窗口"开关，用户需求）——
//       截图按钮下拉菜单切换，经 shot:hide-main-set 同步到本变量；Alt+A 全局截图无参走本变量，
//       按钮截图显式传参。默认 true 保持既有行为（阶段三十八上线即为隐藏）；false 时窗口画面
//       保留在快照中（QQ 未勾选"隐藏当前窗口"的观感）
var shotHideMain = true;
// 阶段一百三十九：隐藏窗口截图的原窗口位置记录（移出屏幕方案，exitFreeze 时恢复原位）
var shotSavedBounds = null;
var shotSavedMaximized = false;
var shotRestoreTries = 0; // 恢复重试计数（setFullScreen(false) 状态转换异步，isFullScreen 滞后返回 true 需重试）
// 恢复隐藏窗口截图前的窗口原位（抓屏失败路径立即恢复；exit-freeze 路径 force 先恢复再退全屏）
// force=true：跳过全屏检查立即 setBounds——exit-freeze 中必须先恢复再 setFullScreen(false)，
// 因为 Electron 退出全屏会自动还原"进入全屏前"的 bounds（=移出屏幕态），若先退全屏后恢复，
// 还原动作与恢复动作竞态（实测还原后执行，窗口滞留屏幕外）；先恢复则全屏退出还原的即原位
// keepHidden=true：仅恢复边界不重新最大化——隐藏态 maximize 会强制带出窗口（Electron 行为），
// 录制期间主窗口必须保持隐藏，录屏归位（recShow）按恢复的原位边界显示即可
function restoreShotHiddenWindow(force, keepHidden) {
    if (!shotSavedBounds || !mainWindow) return;
    if (!force && mainWindow.isFullScreen()) {
        // setFullScreen(false) 状态转换异步（isFullScreen 短暂滞后 true），150ms 轮询重试（上限 20 次）
        if (shotRestoreTries++ < 20) setTimeout(function () { restoreShotHiddenWindow(false, keepHidden); }, 150);
        return;
    }
    shotRestoreTries = 0;
    var b = shotSavedBounds;
    var wasMax = shotSavedMaximized;
    shotSavedBounds = null;
    shotSavedMaximized = false;
    mainWindow.setBounds(b);
    if (wasMax && !keepHidden) {
        // 最大化原态：等全屏退出完成后恢复最大化（全屏未退出时 maximize 无效）
        var tries = 0;
        (function doMax() {
            if (mainWindow.isFullScreen()) { if (tries++ < 20) setTimeout(doMax, 150); return; }
            mainWindow.maximize();
        })();
    }
}
async function captureWithHide(hideMain) {
    var needHide = (hideMain === undefined) ? shotHideMain : !!hideMain;
    // 编辑器窗口打开中直接拒绝（防 Alt+A 连按覆盖 shotSavedBounds 原位记录——编辑器打开期间主窗口
    // 已处于"移出屏幕+原位已记录"态，再走一遍隐藏逻辑会把屏幕外坐标当原位存下来，编辑器关闭后窗口找不回）
    if (editorWin && !editorWin.isDestroyed() && editorWin.isVisible()) return null;
    var wasVisible = mainWindow && mainWindow.isVisible();
    if (needHide) {
        if (mainWindow && !wasVisible) {
            // 托盘驻留（窗口隐藏）：维持隐藏，抓屏后由 show 带出
        } else if (mainWindow) {
            // 原实现：mainWindow.setOpacity(0); // 即时全透明（Electron 44 实测失效：Win32 探针确认
            // WS_EX_LAYERED 未生效、GetLayeredWindowAttributes=false，GDI/DXGI 抓屏均仍拍到主窗口，
            // "截图时隐藏当前窗口"开关形同虚设）——改移出屏幕方案：setBounds 瞬时无动画、任务栏无
            // 闪动、抓屏画面不含本窗口；原位由抓屏失败分支或 exit-freeze（编辑器关闭）恢复
            shotSavedMaximized = mainWindow.isMaximized();
            shotSavedBounds = mainWindow.getBounds();
            mainWindow.unmaximize(); // 最大化态下 setBounds 不生效，先还原再移出
            mainWindow.setBounds({ x: -(shotSavedBounds.width + 400), y: shotSavedBounds.y, width: shotSavedBounds.width, height: shotSavedBounds.height });
        }
        // Windows 合成器输出"无本窗口"新帧需要一小段时间，抓早了仍可能拍到本窗口（150ms 为实测安全值）
        await new Promise(function (r) { setTimeout(r, 150); });
    }
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
            restoreShotHiddenWindow(); // 原实现：mainWindow.setOpacity(1);（随 setOpacity 方案废弃，改恢复移出屏幕前的原位）
            mainWindow.focus();
        }
        return null;
    }
    // 阶段一百四十：编辑器独立窗口化——抓屏成功后主窗口保持隐藏（移出屏幕态），由渲染层经 editor:open
    // 打开独立编辑器窗口全屏展示冻结画面；主窗口恢复延迟到编辑器完成/取消（hideEditorAndRestore，
    // hide-main 模式走 shotSavedBounds 原位恢复）
    // 原实现：主窗口 setFullScreen(true)+screen-saver 置顶 → shot:prepare 推渲染层预加载主窗体内
    //         冻结编辑器 → shot:ready 就绪后 setOpacity(1) 揭幕（编辑器嵌在主窗体内，已随独立窗口化废弃）
    return dataUrl;
}

// 冻结编辑器就绪信号（渲染层首帧绘制完成回调，消费 shotReadyWaiter 解除揭幕等待）
// 阶段一百四十：编辑器独立窗口化后主窗体内冻结编辑器已废弃，shot:prepare/shot:ready 不再收发，
// 处理器保留兜底（渲染层旧缓存页面在 sync 更新前仍可能上报，幂等无副作用）
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
    // 阶段一百三十九：窗口原位恢复改由 leave-full-screen 事件完成（时序安全）——此处只发起退全屏；
    // 原实现：handler 内立即/重试恢复（实测均被 Electron 退全屏的延迟 bounds 还原覆盖，窗口滞留屏幕外）
    mainWindow.setFullScreen(false);
    shotPickerScheduleStop(); // 窗口识别服务延迟回收（30s 内再次截图复用进程，不反复起停）
});

// 阶段一百三十九：渲染层同步"截图时隐藏主窗口画面"开关（截图按钮下拉菜单切换；
// Alt+A 全局截图路径无显式参数，统一读本变量）
ipcMain.on('shot:hide-main-set', function (e, on) {
    shotHideMain = !!on;
});

// ===== 阶段一百三十九：QQ 同款录屏（Ctrl+Alt+R 全局快捷键 / 截图按钮菜单入口） =====
// 录制链路：冻结选区（复用截图选区交互）→ 3-2-1 倒计时 → rec:begin 主窗口退场（退全屏恢复原位+hide，
// 屏幕完全露出）→ 渲染层 getUserMedia 拿屏幕流（rec:source 给源 id）→ canvas 实时裁剪选区 → MediaRecorder
// 录 webm → Ctrl+Alt+R 停止 → rec:show 窗口归位 → 预览浮层确认发送（走既有文件消息链路，服务端零改动）
var recActive = false; // 录制进行中标志（全局快捷键据此切换 开始/停止 语义）

// 录制启动：主窗口退场。先退全屏（leave-full-screen 事件自动恢复截图隐藏期的原位），等全屏态
// 结束后 hide——desktopCapturer 屏幕流不含已隐藏窗口，录制画面干净；系统通知告知停止方式
// （主窗口已隐藏，屏幕上无自绘 UI 可承载"录制中"提示）
ipcMain.handle('rec:begin', async function () {
    if (!mainWindow) return false;
    recActive = true;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setFullScreen(false);
    var tries = 0;
    while (mainWindow.isFullScreen() && tries++ < 20) {
        await new Promise(function (r) { setTimeout(r, 100); });
    }
    mainWindow.hide();
    showNotification('录屏已开始', '按 Ctrl+Alt+R 停止录屏');
    return true;
});

// 屏幕源 id（渲染层 getUserMedia 的 chromeMediaSourceId；只取 id 用 1x1 缩略图加速）
ipcMain.handle('rec:source', function () {
    var display = screen.getPrimaryDisplay();
    return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).then(function (sources) {
        var src = null;
        for (var i = 0; i < sources.length; i++) {
            if (sources[i].display_id === String(display.id)) { src = sources[i]; break; }
        }
        if (!src && sources.length) src = sources[0];
        return src ? src.id : '';
    });
});

// 录制结束：主窗口归位（show 自动带出隐藏期窗口；全屏已在 rec:begin 退出，恢复普通窗口）
ipcMain.on('rec:show', function () {
    recActive = false;
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
});

// 录制状态同步（渲染层 MediaRecorder 实际 start/stop 时上报，与 rec:begin/rec:show 解耦防竞态）
ipcMain.on('rec:active', function (e, on) {
    recActive = !!on;
});

// ===== 阶段一百三十九：QQ 同款长截图（冻结选区 → 主窗口缩为悬浮小工具条 → 滚动采样拼接 → 完成回编辑器） =====
// 链路：冻结截图选区后点工具栏"长截图"→ stitch:begin 退全屏并把窗口收缩为选区下方悬浮小条
// （保留 screen-saver 置顶，悬浮于目标应用之上，露出滚动内容）→ 渲染层 getUserMedia 屏幕流采样对齐
// 拼接 → 点"完成"→ stitch:finish 恢复普通窗口（原位/最大化态/层级），长图进既有编辑器标注发送（服务端零改动）
var stitchToolbarBounds = null; // 悬浮小条目标 bounds（DIP；leave-full-screen 时落地，时序对齐截图原位恢复方案）
var stitchRestore = null;       // 长截图完成后的主窗口恢复信息 {bounds, maximized, minSize}（接管 shotSavedBounds 职责）

// 落悬浮小条（带还原竞态防御）：Electron 退全屏会异步还原"进全屏前缓存"的 bounds——若进全屏前
// 窗口是最大化态，还原后仍是最大化，而 setBounds 对最大化窗口不生效（实测），小条永远落不下去
// 表现为"看不到悬浮条"。轮询确认落地，未落地（maximized/fullScreen）先 unmaximize/退全屏再
// setBounds，150ms×20 与 restoreShotHiddenWindow 同款重试模式
// 【已停用】改用独立无边框条窗承载工具条（见 stitch:begin），函数保留备查：
// 缩条方案实测新问题——Windows titleBarOverlay 的最小化/最大化/关闭按钮绘制在窗口右上角
// 非客户区，缩条 300×54 后按钮挡住工具条"完成/取消"（用户实测反馈），且 Electron Windows
// 无运行时隐藏 overlay 按钮的 API（setWindowButtonVisibility 仅 macOS）
function landStitchToolbar(tries) {
    if (!stitchToolbarBounds || !mainWindow) return;
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    mainWindow.setBounds(stitchToolbarBounds);
    var b = mainWindow.getBounds(), t = stitchToolbarBounds;
    var landed = Math.abs(b.x - t.x) < 2 && Math.abs(b.y - t.y) < 2 && Math.abs(b.width - t.width) < 2 && Math.abs(b.height - t.height) < 2;
    if (!landed && tries < 20) setTimeout(function () { landStitchToolbar(tries + 1); }, 150);
}

// ===== 阶段一百三十九：长截图悬浮小条窗口（QQ 同款承载） =====
// 无边框（frame:false 无任何系统按钮，修复主窗口缩条后 overlay 按钮遮挡完成/取消）、
// skipTaskbar 不占任务栏、screen-saver 级置顶悬浮于目标应用之上；加载 web/bar.html
//（状态文本 + 完成 + 取消，跟随主题），经 stitch:bar-status / stitch:bar-action 双向桥接主窗口
var stitchBarWin = null;

function stitchBarDark() {
    var t = themeStoreLoad();
    return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
}

function createStitchBar() {
    closeStitchBar(); // 残留防御：二次进入先关旧条窗
    var b = stitchToolbarBounds;
    stitchBarWin = new BrowserWindow({
        width: b.width,
        height: b.height,
        x: b.x,
        y: b.y,
        frame: false, // 无边框=无系统按钮（本次修复核心）
        resizable: false,
        skipTaskbar: false, // 任务栏显示"长截图"独立图标（新窗体存在证据；主窗口 hide 后任务栏仅剩此图标）
        show: false,
        backgroundColor: stitchBarDark() ? '#1a1a1a' : '#f5f5f5',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    stitchBarWin.setAlwaysOnTop(true, 'screen-saver');
    stitchBarWin.loadURL(SERVER_URL + 'bar.html');
    stitchBarWin.once('ready-to-show', function () {
        if (stitchBarWin && !stitchBarWin.isDestroyed()) stitchBarWin.show();
    });
    stitchBarWin.on('closed', function () { stitchBarWin = null; });
}

function closeStitchBar() {
    if (stitchBarWin && !stitchBarWin.isDestroyed()) stitchBarWin.destroy();
    stitchBarWin = null;
}

// 长截图启动：主窗口隐藏 + 独立无边框条窗显示工具条。选区传冻结底图物理像素（=屏幕物理坐标），
// 按 scaleFactor 换 DIP；小条定位于选区下方 12px（越界翻转上方），横向居中选区并夹紧工作区
ipcMain.handle('stitch:begin', function (e, selPx) {
    if (!mainWindow || !selPx) return false;
    var display = screen.getPrimaryDisplay();
    var sf = display.scaleFactor || 1;
    var wa = display.workArea;
    var w = 300, h = 54; // 与渲染层 .shot-live-toolbar 尺寸一致
    var sx = selPx.x / sf, sy = selPx.y / sf, sw = selPx.w / sf, sh = selPx.h / sf;
    var x = Math.round(sx + sw / 2 - w / 2);
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
    var y = Math.round(sy + sh + 12);
    if (y + h > wa.y + wa.height - 8) y = Math.round(sy - h - 12); // 选区下方放不下：翻转上方
    stitchToolbarBounds = { x: x, y: y, width: w, height: h };
    // 原实现：主窗口 landStitchToolbar 缩条为 300×54（stitchRestore 记录恢复态 + setMinimumSize(0,0) 解除
    // 最小尺寸钳制 + Promise 轮询落地）——三态（全屏/最大化/普通）恢复复杂且 overlay 按钮遮挡工具条
    // （用户实测反馈，见 landStitchToolbar 注释）；改 QQ 同款承载：
    // 原：hide 后在隐藏中 setFullScreen(false)——实测 Windows 上对隐藏的全屏窗口退全屏会强制显示
    // 窗口（Electron 行为）：主窗口以全黑 shot-live 态露出（用户截图实证：黑色大窗+右上 overlay
    // 按钮+条窗并存，用户误认为工具条仍在主窗体内）。改：全屏态直接 hide（SW_HIDE 不触发退全屏
    // 行为），全屏态保留至 stitch:finish 时统一退出
    mainWindow.hide();
    // 注意：不得清空 shotSavedBounds/shotSavedMaximized——hide-main 模式（"截图时隐藏主窗口"开关）
    // 下 Alt+A 已把主窗口移出屏幕（captureWithHide 记录原位），完成后必须靠它恢复原位；
    // 此前在此清空导致恢复链断裂：完成时退全屏还原出屏幕外坐标，show 后窗口留在屏幕外
    // （任务栏有图标但看不到窗口，用户实测）
    createStitchBar();
    return true;
});

// 长截图结束：关条窗 → 恢复主窗口（完成/取消共用；渲染层随后回编辑器或聊天界面）。
// 原实现：stitchRestore 恢复 bounds/maximized/minSize（缩条方案）；新方案窗口 hide 前后未动，
// show 即复原（最大化态由 Electron 记忆），仅退全屏兜底 + 退出置顶
ipcMain.on('stitch:finish', function () {
    stitchToolbarBounds = null;
    closeStitchBar();
    if (!mainWindow) return;
    // 退全屏+show：渲染层已先移除 shot-live（聊天界面恢复显示），即使 Windows 上隐藏窗口退全屏
    // 强制显示窗口，露出的也是正常聊天界面而非黑窗（stitch:begin 已不在 live 开始时退全屏）
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    mainWindow.setAlwaysOnTop(false);
    if (shotSavedBounds) {
        // hide-main 模式：Alt+A 时窗口被移出屏幕（shotSavedBounds 记录原位），退全屏后 bounds 仍
        // 在屏幕外，必须恢复原位再显示，否则"任务栏有图标但看不到窗口"（用户实测）；
        // 与 exit-freeze 同款 force 恢复（wasMax 内部异步 maximize），重复调用幂等
        restoreShotHiddenWindow(true);
        if (!mainWindow.isVisible()) mainWindow.show();
    } else if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    mainWindow.focus();
});

// 长截图状态文本转发：主窗口渲染层 updateStitchStatus → 条窗显示
ipcMain.on('stitch:bar-status', function (e, text) {
    if (e.sender !== mainWindow.webContents) return; // 只接受主窗口来源
    if (stitchBarWin && !stitchBarWin.isDestroyed()) stitchBarWin.webContents.send('stitch:bar-status', String(text || ''));
});

// 长截图条窗按钮动作：条窗（完成/取消/Esc）→ 主窗口渲染层执行 completeStitch/cancelStitch
ipcMain.on('stitch:bar-action', function (e, act) {
    if (!stitchBarWin || e.sender !== stitchBarWin.webContents) return; // 只接受条窗来源
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stitch:bar-action', act === 'complete' ? 'complete' : 'cancel');
});

// ===== 阶段一百三十九：QQ 同款窗口识别（冻结截图悬停高亮窗口 + 单击选窗 + 双击截窗） =====
// 命中测试用 PowerShell 常驻子进程做 Win32 调用（WindowFromPoint+GA_ROOT+GetWindowRect）——
// 零 npm 原生依赖：esbuild bundle 与 electron-builder 打包链路不引入 .node 模块（koffi 类方案
// 打包配置风险高）。按行协议：输入 "x,y"（物理屏幕坐标）→ 输出 "l,t,r,b"（窗口物理矩形）或
// "none"；stdin 断开子进程自动退出（父进程崩溃不残留）。本应用自身窗口按 pid 排除——Electron
// 全部窗口同 pid，冻结编辑器全屏置顶时悬停不会命中自己。逻辑详见 shot-window-picker.ps1
// （ps1 刻意保持纯 ASCII：Windows PowerShell 5.1 对无 BOM 的 UTF-8 中文注释按 ANSI 解析会乱码）
var shotPickerProc = null;       // PowerShell 命中服务子进程（懒启动，截图期间存活）
var shotPickerReady = false;     // 子进程就绪标记（Add-Type 编译约 0.5~1s，就绪前查询直接放弃）
var shotPickerWaiter = null;     // 在途查询回调（单飞：mousemove 高频，丢帧无感，防响应错位）
function shotPickerEnsure() {
    if (shotPickerProc) return;
    try {
        var path = require('path');
        // 打包态 ps1 在 asar 内子进程读不到，asarUnpack 后取 app.asar.unpacked 同名文件（开发态无 asar 不替换）
        var ps1 = path.join(__dirname, 'shot-window-picker.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        shotPickerProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        shotPickerReady = false;
        var buf = '';
        shotPickerProc.stdout.on('data', function (d) {
            buf += d.toString();
            var idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                var line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                if (line === 'ready') { shotPickerReady = true; continue; }
                if (shotPickerWaiter) {
                    var w = shotPickerWaiter;
                    shotPickerWaiter = null;
                    w(line);
                }
            }
        });
        shotPickerProc.on('exit', function () {
            shotPickerProc = null;
            shotPickerReady = false;
            shotPickerWaiter = null;
        });
    } catch (err) {
        console.warn('窗口识别服务启动失败:', err);
        shotPickerProc = null;
    }
}
function shotPickerStop() {
    if (!shotPickerProc) return;
    try { shotPickerProc.stdin.end(); } catch (err) { /* stdin 已断开视为退出中 */ }
    var p = shotPickerProc;
    setTimeout(function () { try { p.kill(); } catch (err) { /* 已退出 */ } }, 500); // 兜底强杀（正常 stdin 断开自退）
    shotPickerProc = null;
    shotPickerReady = false;
    shotPickerWaiter = null;
}
var shotPickerIdleTimer = null; // 编辑器关闭后延迟回收（频繁截图不反复起停 PowerShell）
function shotPickerScheduleStop() {
    if (shotPickerIdleTimer) clearTimeout(shotPickerIdleTimer);
    shotPickerIdleTimer = setTimeout(function () {
        shotPickerIdleTimer = null;
        shotPickerStop();
    }, 30000);
}
function shotPickerQuery(x, y) {
    return new Promise(function (resolve) {
        if (!shotPickerProc) shotPickerEnsure();
        // 未就绪 / 上一查询在途：直接放弃本次（渲染层 mousemove 节流后自然重查）
        if (!shotPickerProc || !shotPickerReady || shotPickerWaiter) { resolve(null); return; }
        var done = false;
        shotPickerWaiter = function (line) {
            shotPickerWaiter = null;
            if (done) return;
            done = true;
            if (!line || line === 'none') { resolve(null); return; }
            var n = line.split(',').map(Number);
            if (n.length !== 4 || n.some(isNaN)) { resolve(null); return; }
            resolve({ left: n[0], top: n[1], right: n[2], bottom: n[3] });
        };
        try { shotPickerProc.stdin.write(x + ',' + y + '\n'); } catch (err) {
            shotPickerWaiter = null;
            resolve(null);
            return;
        }
        setTimeout(function () {
            if (done) return;
            done = true;
            shotPickerWaiter = null;
            resolve(null); // 响应超时（子进程异常），渲染层按无窗口处理
        }, 400);
    });
}

ipcMain.handle('shot:window-at', function (e, x, y) {
    return shotPickerQuery(Math.round(x), Math.round(y));
});

ipcMain.handle('shot:capture', function (e, hideMain) {
    shotPickerEnsure(); // 抓屏即预热命中服务（Add-Type 编译耗时，提前到用户悬停前完成）
    if (shotPickerIdleTimer) { clearTimeout(shotPickerIdleTimer); shotPickerIdleTimer = null; } // 取消延迟回收
    return captureWithHide(hideMain);
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
            // 阶段一百二十二：additionalArguments/allowRunningInsecureContent 已随 app:// 方案移除（origin 不变无需传参）
        }
    });
    // 阶段一百二十二：图片查看器地址恢复服务端 http（静态资源经 http 拦截读本地，原 app:// 方案已回退）
    // 更早原实现：viewerWin.loadURL(SERVER_URL + 'image-viewer.html')
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

// ===== 阶段一百四十：截图编辑器独立窗口（用户需求：编辑器不再嵌在主窗体内，与图片查看器/长截图条窗同款独立承载） =====
// 独立 BrowserWindow 单例复用：freeze/record 模式全屏+screen-saver 置顶展示冻结画面（主窗口保持隐藏，
// 编辑器关闭时恢复），open 模式 900×640 居中窗口式编辑；页面 editor.html + editor-page.js 桥接
// ScreenshotEditor（screenshot.js 零改动复用），完成/取消/长截图移交/录屏启动经 IPC 回主窗口分发
var editorWin = null;        // 编辑器窗口（单例复用：重复打开仅换内容）
var editorReadyTimer = null; // 首帧就绪显示兜底定时器（页面异常时 1.5s 强制显示，避免永久黑屏）
var editorPending = null;    // 当前编辑任务 {mode, callback}（完成回传时确定分发类型）

function editorWinDark() {
    var t = themeStoreLoad();
    return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors);
}

function ensureEditorWindow() {
    if (editorWin) return editorWin;
    editorWin = new BrowserWindow({
        width: 900,
        height: 640,
        minWidth: 480,
        minHeight: 360,
        show: false,
        frame: false, // 无边框：freeze/record 画面铺满整窗无系统按钮（全屏冻结态同 QQ 截图）；open 模式编辑器画布居中
        backgroundColor: editorWinDark() ? '#111111' : '#f5f5f5',
        title: '截图编辑',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    editorWin.loadURL(SERVER_URL + 'editor.html');
    editorWin.on('close', function (e) {
        if (app.isQuitting) return; // 托盘退出流程：放行销毁
        // 关闭按钮/Alt+F4 转取消语义：freeze 期间主窗口隐藏，仅藏编辑器会让聊天窗口找不回
        // （直接关窗=放弃本次截图，与 Esc/取消同路径恢复主窗口）
        e.preventDefault();
        if (editorWin.isVisible()) hideEditorAndRestore(true);
    });
    editorWin.on('closed', function () { editorWin = null; });
    return editorWin;
}

// 编辑器收尾（完成/取消/关窗共用）：藏编辑器 → 恢复主窗口 → 回收窗口识别服务
// notifyCancel=true 时通知主窗口渲染层清残留焦点（确认完成路径由 editor:done 分发，不重复通知）
function hideEditorAndRestore(notifyCancel) {
    if (editorReadyTimer) { clearTimeout(editorReadyTimer); editorReadyTimer = null; }
    if (editorWin && !editorWin.isDestroyed()) {
        editorWin.setAlwaysOnTop(false);
        editorWin.hide();
    }
    editorPending = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (shotSavedBounds) {
            // hide-main 模式：抓屏时主窗口被移出屏幕（shotSavedBounds 记录原位），恢复原位再显示
            //（与 stitch:finish 同款 force 恢复；wasMax 的 maximize 在内部异步完成）
            restoreShotHiddenWindow(true);
            if (!mainWindow.isVisible()) mainWindow.show();
        } else if (!mainWindow.isVisible()) {
            // 托盘驻留（窗口原隐藏）抓屏路径：编辑器关闭带出主窗口
            mainWindow.show();
        }
        mainWindow.focus();
    }
    shotPickerScheduleStop();
    if (notifyCancel && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('editor:cancel');
    }
}

// 启动编辑任务（editor:open 与 viewer:edit 共用主体；sender 校验在各 ipcMain.on 入口归口）
// data = {dataUrl, mode:'freeze'|'open'|'record', callback:'pending'|'sendFile'}
function startEditorTask(data) {
    if (!data || !data.dataUrl) return;
    var mode = data.mode || 'freeze';
    editorPending = { mode: mode, callback: data.callback || 'pending' };
    var win = ensureEditorWindow();
    var freezeLike = (mode === 'freeze' || mode === 'record');
    // 形态切换（复用窗口可能上次是另一模式）：freeze/record 全屏+置顶盖满屏幕，open 普通居中窗
    if (freezeLike) {
        if (!win.isFullScreen()) win.setFullScreen(true);
        win.setAlwaysOnTop(true, 'screen-saver');
    } else {
        win.setAlwaysOnTop(false);
        if (win.isFullScreen()) win.setFullScreen(false);
        var wa = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: Math.round(wa.x + (wa.width - 900) / 2), y: Math.round(wa.y + (wa.height - 640) / 2), width: 900, height: 640 });
    }
    var send = function () {
        if (!editorWin || editorWin.isDestroyed()) return;
        editorWin.webContents.send('editor:load', { dataUrl: data.dataUrl, mode: mode, callback: editorPending ? editorPending.callback : 'pending' });
    };
    var reveal = function () {
        if (editorWin && !editorWin.isDestroyed() && !editorWin.isVisible()) { editorWin.show(); editorWin.focus(); }
    };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', function () { send(); if (!freezeLike) reveal(); });
    } else {
        send();
        if (!freezeLike) reveal();
    }
    if (freezeLike) {
        // freeze/record 等编辑器首帧就绪（editor:ready）再显示——揭幕即冻结画面；先见底色再出图的
        // 闪屏在全屏冻结观感上格外刺眼，1.5s 超时兜底（页面异常时强制显示，不至于永久黑屏）
        if (editorReadyTimer) clearTimeout(editorReadyTimer);
        editorReadyTimer = setTimeout(function () { editorReadyTimer = null; reveal(); }, 1500);
    }
}

ipcMain.on('editor:open', function (e, data) {
    if (!mainWindow || e.sender !== mainWindow.webContents) return; // 只接受主窗口来源
    startEditorTask(data);
});

// 阶段一百四十：图片查看器"编辑并发送"入口——查看器抓取当前图转 dataURL 后经此打开 open 模式编辑器
//（callback=sendFile：确认即经主窗口 sendScreenshotFile 发到当前会话；sender 校验只认查看器窗口）
ipcMain.on('viewer:edit', function (e, data) {
    if (!viewerWin || e.sender !== viewerWin.webContents) return;
    if (editorWin && !editorWin.isDestroyed() && editorWin.isVisible()) return; // 编辑器已打开防重入
    startEditorTask({ dataUrl: data.dataUrl, mode: 'open', callback: 'sendFile' });
});

// 编辑器首帧就绪（editor-page.js 冻结画面绘制完成回调）：显示全屏窗口（清超时兜底）
ipcMain.on('editor:ready', function (e) {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    if (editorReadyTimer) { clearTimeout(editorReadyTimer); editorReadyTimer = null; }
    if (!editorWin.isVisible()) { editorWin.show(); editorWin.focus(); }
});

// 编辑器确认完成：藏编辑器恢复主窗口 → 按任务记录的 callback 类型回传主窗口分发
//（pending=裁剪图进待发送条；sendFile=直接走发送链路）
ipcMain.on('editor:done', function (e, payload) {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    var cbType = editorPending ? editorPending.callback : (payload && payload.callback) || 'pending';
    hideEditorAndRestore(false);
    // 无条件转发（dataUrl 为空串也转发）：渲染层回调入口先清 busy 再校验数据，
    // 丢转发会让 editorWinBusy 永久置真、后续截图入口全被拦（实测踩坑）
    if (mainWindow && !mainWindow.isDestroyed() && payload) {
        mainWindow.webContents.send('editor:done', { dataUrl: (payload && payload.dataUrl) || '', callback: cbType });
    }
});

// 编辑器取消/关窗：恢复主窗口 + 通知渲染层清残留焦点
ipcMain.on('editor:cancel', function (e) {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    hideEditorAndRestore(true);
});

// 编辑器长截图移交：藏编辑器（主窗口保持隐藏，条窗与抓流拼接状态机接管）→ 选区转主窗口长截图状态机；
// 完成/取消由长截图既有链路收尾（stitch:finish 恢复主窗口，含 hide-main 的 shotSavedBounds 原位恢复）
ipcMain.on('editor:stitch', function (e, data) {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    if (editorReadyTimer) { clearTimeout(editorReadyTimer); editorReadyTimer = null; }
    if (editorWin && !editorWin.isDestroyed()) { editorWin.setAlwaysOnTop(false); editorWin.hide(); }
    editorPending = null;
    if (mainWindow && !mainWindow.isDestroyed() && data && data.sel) {
        mainWindow.webContents.send('editor:stitch', data);
    }
});

// 编辑器录屏选区启动（3-2-1 倒计时结束）：藏编辑器 → 恢复主窗口原位（不显示）→ 转主窗口录屏链路。
// 原位必须恢复：录制期间主窗口保持隐藏，不移回原位则 recShow 归位时窗口仍在屏幕外
//（"任务栏有图标但看不到窗口"）；keepHidden 跳过 maximize（隐藏态 maximize 会强制带出窗口）
ipcMain.on('editor:rec-start', function (e, data) {
    if (!editorWin || e.sender !== editorWin.webContents) return;
    if (editorReadyTimer) { clearTimeout(editorReadyTimer); editorReadyTimer = null; }
    if (editorWin && !editorWin.isDestroyed()) { editorWin.setAlwaysOnTop(false); editorWin.hide(); }
    editorPending = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
        restoreShotHiddenWindow(true, true);
        mainWindow.webContents.send('editor:rec-start', data);
    }
});

// ===== 阶段一百三十四：独立文档查看器窗口（用户需求：聊天内文档预览不再窗体弹窗遮挡聊天页，与图片查看器同款新窗口打开） =====
var docViewerWin = null; // 文档查看器窗口（单例复用：重复打开仅换内容）

function ensureDocViewerWindow() {
    if (docViewerWin) return docViewerWin;
    docViewerWin = new BrowserWindow({
        width: 960,
        height: 680,
        minWidth: 520,
        minHeight: 400,
        show: false,
        frame: false,          // 无边框：顶栏自绘（拖动/置顶/下载/关闭），风格与图片查看器统一
        backgroundColor: '#1e1e1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    docViewerWin.loadURL(SERVER_URL + 'doc-viewer.html');
    docViewerWin.on('close', function (e) {
        // 关闭改为隐藏复用：保留窗口避免频繁重建（页面内 Esc/关闭按钮走同一隐藏逻辑）
        if (docViewerWin.isVisible()) {
            e.preventDefault();
            docViewerWin.hide();
        }
    });
    docViewerWin.on('closed', function () { docViewerWin = null; });
    return docViewerWin;
}

// 打开文档查看器：渲染层推送 {url, name}；相对 URL 归一化为服务端绝对地址（单一归口在主进程，
// doc-viewer 页内 absUrl 仅对 http/blob 直通兜底）
ipcMain.on('doc:open', function (event, data) {
    var win = ensureDocViewerWindow();
    var u = data && data.url ? String(data.url) : '';
    if (u && !/^(https?:|blob:|data:)/.test(u)) {
        u = SERVER_URL + u.replace(/^\//, '');
    }
    var payload = { url: u, name: (data && data.name) || '文档' };
    var show = function () {
        win.webContents.send('doc:load', payload);
        win.show();
        win.focus();
    };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', show);
    } else {
        show();
    }
});

// 查看器置顶切换（顶栏图钉按钮）
ipcMain.on('doc:set-always-on-top', function (event, on) {
    if (docViewerWin) docViewerWin.setAlwaysOnTop(!!on);
});

// 查看器隐藏（页面 Esc/关闭按钮，与 close 拦截同逻辑）
ipcMain.on('doc:close', function () {
    if (docViewerWin) docViewerWin.hide();
});

// ===== 阶段一百四十四三期：公告链接型独立窗体（用户需求：链接型公告在新独立窗体打开网站，不经浏览区分栏） =====
// 单例复用：重复点击仅导航换址 + 聚焦，不堆窗口；仅放行 http/https（服务端归口已校验，此处兜底）
var annLinkWin = null;

ipcMain.handle('ann:open-link', function (event, url) {
    var u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    if (!annLinkWin || annLinkWin.isDestroyed()) {
        annLinkWin = new BrowserWindow({
            width: 1200,
            height: 820,
            minWidth: 520,
            minHeight: 400,
            show: false,
            autoHideMenuBar: true, // 网页窗体隐藏菜单栏（Alt 唤出），观感干净
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        annLinkWin.on('closed', function () { annLinkWin = null; });
        // 页面 window.open/target=_blank 一律转系统默认浏览器（独立窗体内不养子标签）
        annLinkWin.webContents.setWindowOpenHandler(function (details) {
            if (/^https?:\/\//i.test(details.url || '')) shell.openExternal(details.url);
            return { action: 'deny' };
        });
    }
    annLinkWin.loadURL(u).catch(function () { /* 加载失败由窗口错误页呈现 */ });
    annLinkWin.once('ready-to-show', function () {
        if (annLinkWin && !annLinkWin.isDestroyed()) {
            annLinkWin.show();
            annLinkWin.focus();
        }
    });
    return true;
});

// 查看器下载：主进程 net.fetch 拉流（走 Chromium 网络栈，与页面同源同 cookie）+ 原生保存对话框写盘
// 仅支持 http(s)/data:——blob: 是主聊天页面的对象地址，另一进程上下文无法访问（前端归口已拦截不送独立窗口）
ipcMain.handle('doc:save', async function (event, data) {
    if (!data || !data.url) return false;
    var u = String(data.url);
    if (!/^(https?:|data:)/.test(u)) {
        u = SERVER_URL + u.replace(/^\//, '');
    }
    var win = BrowserWindow.fromWebContents(event.sender);
    var r = await dialog.showSaveDialog(win, {
        defaultPath: data.name || '文档'
    });
    if (r.canceled || !r.filePath) return false;
    try {
        var resp = await net.fetch(u);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var buf = Buffer.from(await resp.arrayBuffer());
        await fs.promises.writeFile(r.filePath, buf);
        return true;
    } catch (e) {
        console.warn('文档查看器下载失败:', e && e.message);
        dialog.showErrorBox('保存失败', '文件下载失败：' + (e && e.message ? e.message : '未知错误'));
        return false;
    }
});

// ===== 阶段一百四十一：音视频通话（第一期 PC↔PC 1v1，微信同款交互） =====
// 两个独立 BrowserWindow（禁止主窗体内嵌弹层，与图片查看器/截图编辑器同方案）：
//   1. 通话窗 callWin：主/被叫共用，承载 WebRTC 媒体面（getUserMedia + RTCPeerConnection P2P 直连），
//      语音 360×560 / 视频 860×620 两种形态，挂断信令收口后自行 callClose
//   2. 响铃条 ringWin：被叫来电顶部小条（微信同款），接受/拒绝/超时收口
// 信令桥：主窗口 chat.js 持有 WS，信令经 IPC 三段桥接（chat.js ↔ 主进程 ↔ 通话窗/响铃条），
// 媒体协商帧原样中继不解析；话单/状态归口服务端（im_call_log + im_message 通话信封）
var callWin = null;       // 通话窗（单例：同一时刻仅一场通话）
var ringWin = null;       // 响铃条（单例：同时刻仅一场来电，服务端忙判已拦截并发呼叫）
var ringPending = null;   // 当前来电信息 {call_id, from, from_name, from_avatar, call_type}
var callWindowCloseArmed = false; // 关窗放行标记（页面挂断信令收口后 callClose 才真正销毁）

// 通话窗尺寸按类型分形态：语音竖版小窗（微信同款），视频横版大窗（远端画面铺满）；
// 会议形态（阶段一百四十四）：视频会议舞台大窗 / 语音会议 420×620 竖版窗。
// 阶段一百五十一：视频会议 1100×700 → 1280×800（腾讯会议同款共享主舞台需要大画面，原尺寸共享内容看不清）
function callWindowSize(callType, isMeet) {
    // 阶段一百五十一补丁：会议视频默认 1366×860（原 1280×800），主舞台更宽；ensureCallWindow 仍按工作区收敛
    if (isMeet) return callType === 'video' ? { width: 1366, height: 860 } : { width: 420, height: 620 };
    return callType === 'video' ? { width: 860, height: 620 } : { width: 360, height: 560 };
}

function ensureCallWindow(callType, isMeet) {
    var size = callWindowSize(callType, isMeet);
    // 阶段一百五十一：尺寸按屏幕工作区收敛（小屏笔记本防溢出）
    var wa0 = screen.getPrimaryDisplay().workArea;
    var w0 = Math.min(size.width, wa0.width), h0 = Math.min(size.height, wa0.height);
    if (callWin && !callWin.isDestroyed()) {
        // 复用窗口切换形态（语音/视频互切场景）
        // 阶段一百五十一：会议窗可拉伸/最大化（腾讯会议同款），1v1 保持微信同款固定窗
        callWin.setResizable(!!isMeet);
        callWin.setMaximizable(!!isMeet);
        var b = callWin.getBounds();
        if (b.width !== w0 || b.height !== h0) {
            var wa = screen.getPrimaryDisplay().workArea;
            callWin.setBounds({ x: Math.round(wa.x + (wa.width - w0) / 2), y: Math.round(wa.y + (wa.height - h0) / 2), width: w0, height: h0 });
        }
        return callWin;
    }
    callWin = new BrowserWindow({
        width: w0,
        height: h0,
        show: false,
        frame: false,          // 无边框自绘（微信通话界面同款：深色沉浸 + 自绘控制条）
        resizable: !!isMeet,   // 原代码：resizable: false——阶段一百五十一会议窗可拉伸（1v1 仍固定）
        maximizable: !!isMeet, // 原代码：maximizable: false——会议窗支持最大化
        // 阶段一百五十一补丁：fullscreenable 原为 false——会禁用页面 Fullscreen API 请求
        //（全屏按钮/双击全屏点击无效的根因），会议窗放开，1v1 保持不可全屏
        fullscreenable: !!isMeet,
        backgroundColor: '#161819',
        title: '通话',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    callWin.setAlwaysOnTop(true, 'floating'); // 通话期间悬浮（微信同款，可手动失焦继续通话）
    // 阶段一百五十一补丁：加载带版本号查询串防 HTTP 缓存（会议窗页面从服务器加载，
    // 无参数时 Chromium 可能命中旧缓存导致新布局不生效；与 WEB 端 web-call-bridge.js 保持一致）
    callWin.loadURL(SERVER_URL + 'call-window.html?v=1523');
    callWin.on('close', function (e) {
        if (app.isQuitting || callWindowCloseArmed) return; // 托盘退出/页面已收口：放行销毁
        // 点窗体关闭（Alt+F4 等）转挂断语义：通知页面走挂断信令收口后自行 callClose，
        // 直接销毁会让对端一直等待（信令不发对端 UI 卡"通话中"）
        e.preventDefault();
        if (callWin && !callWin.isDestroyed()) callWin.webContents.send('call:window-close');
    });
    callWin.on('closed', function () { callWin = null; });
    return callWin;
}

// 打开通话窗（主窗口渲染层 chat.js 发起/被叫接听共用入口）
ipcMain.on('call:open', function (e, data) {
    if (!mainWindow || e.sender !== mainWindow.webContents) return; // 只接受主窗口来源
    if (!data || !data.call_id) return;
    callWindowCloseArmed = false;
    var win = ensureCallWindow(data.call_type, !!data.meet); // meet 标记会议形态（宫格大窗/竖版窗）
    var show = function () {
        if (!callWin || callWin.isDestroyed()) return;
        callWin.webContents.send('call:load', data);
        callWin.show();
        callWin.focus();
        // 窗口就绪回放缓冲信令（call:load 之后 flush：监听器/任务数据均已就绪，按到达序回放）
        if (callSigQueue.length) {
            var q = callSigQueue;
            callSigQueue = [];
            q.forEach(function (f) {
                if (callWin && !callWin.isDestroyed()) callWin.webContents.send('call:signal', f);
            });
        }
    };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', show);
    } else {
        show();
    }
});

// 通话窗关闭收口（页面挂断信令已发出后调用）：销毁窗口并通知主窗口清通话态
ipcMain.on('call:close', function (e) {
    if (!callWin || e.sender !== callWin.webContents) return;
    callWindowCloseArmed = true;
    callSigQueue = []; // 通话收口清缓冲（防残留帧串场）
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('call:closed');
    }
    if (!callWin.isDestroyed()) callWin.destroy();
    callWin = null;
});

// ===== 响铃条（被叫来电顶部小条，微信同款） =====
function ensureRingWindow() {
    if (ringWin && !ringWin.isDestroyed()) return ringWin;
    ringWin = new BrowserWindow({
        width: 372,
        height: 100,
        show: false,
        frame: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: '#222629',
        title: '来电提醒',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    // 顶部右侧贴边（微信来电弹条位置）：主屏工作区右上角内缩 16px
    ringWin.loadURL(SERVER_URL + 'call-ring.html');
    ringWin.setPositionAtRight = function () {
        var wa = screen.getPrimaryDisplay().workArea;
        ringWin.setPosition(wa.x + wa.width - 372 - 16, wa.y + 16);
    };
    ringWin.on('close', function (e) {
        if (app.isQuitting) return;
        // 关闭转隐藏：来电继续响铃（服务端 60s 超时归口收尾），不自动替用户拒接
        e.preventDefault();
        ringWin.hide();
    });
    ringWin.on('closed', function () { ringWin = null; });
    return ringWin;
}

// 来电响铃（主窗口渲染层收到 invite 后转发）
ipcMain.on('call:ring', function (e, data) {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    if (!data || !data.call_id) return;
    ringPending = data;
    var win = ensureRingWindow();
    var show = function () {
        if (!ringWin || ringWin.isDestroyed()) return;
        ringWin.webContents.send('call:ring:show', data);
        ringWin.setPositionAtRight();
        // showInactive：弹条不抢主窗口焦点（微信同款，正在打字不被打断）
        ringWin.showInactive();
    };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', show);
    } else {
        show();
    }
});

// 隐藏响铃条（接听/拒绝/超时/对端取消/其他设备已接；主窗口渲染层与响铃条页面均可触发）
ipcMain.on('call:ring-hide', function (e) {
    var fromMain = mainWindow && e.sender === mainWindow.webContents;
    var fromRing = ringWin && e.sender === ringWin.webContents;
    if (!fromMain && !fromRing) return;
    ringPending = null;
    if (ringWin && !ringWin.isDestroyed()) {
        // 停铃通知先于 hide（窗口隐藏后渲染层无法自感知，合成铃声会继续循环）
        ringWin.webContents.send('call:ring:stop');
        ringWin.hide();
    }
});

// 响铃条按钮动作（accept/decline）→ 主窗口渲染层（chat.js 归口发 reject 信令/开通话窗）
ipcMain.on('call:ring-action', function (e, data) {
    if (!ringWin || e.sender !== ringWin.webContents) return;
    if (ringWin && !ringWin.isDestroyed()) ringWin.hide();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('call:ring-action', data);
    }
});

// 信令桥（主窗口 → 通话窗/响铃条）：chat.js 收到 70 帧后原样转发，各窗口按 call_id 自行过滤。
// 阶段一百四十四修复：会议 room_info 由被叫上行 meet_accept 后服务端秒回，早于通话窗加载完成
//（直发即丢，随后 offer 因对端成员表为空也被丢，双方永久互等）——窗口加载期间帧入队，
// call:open 就绪回放（call:load 之后 flush 保序：room_info 先于 offer/answer/candidate 语义不变）
var callSigQueue = [];
ipcMain.on('call:signal-in', function (e, frame) {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    if (callWin && !callWin.isDestroyed()) {
        if (callWin.webContents.isLoading()) {
            callSigQueue.push(frame); // 窗口加载中：缓冲待就绪回放
        } else {
            callWin.webContents.send('call:signal', frame);
        }
    }
    if (ringWin && !ringWin.isDestroyed() && ringWin.isVisible()) ringWin.webContents.send('call:signal', frame);
});

// 信令桥（通话窗/响铃条 → 主窗口）：上行信令由 chat.js 经 WS 发出（frame 为完整协议帧）
ipcMain.on('call:send', function (e, frame) {
    var fromCall = callWin && e.sender === callWin.webContents;
    var fromRing = ringWin && e.sender === ringWin.webContents;
    if (!fromCall && !fromRing) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('call:send', frame);
    }
});

// ===== 阶段一百五十一补丁：会议共享期间窗口内容保护（防"窗口套窗口"递归画面） =====
// 共享源为整个主屏时，悬浮其上的会议窗会进入共享画面形成递归；setContentProtection(true)
// 走 Windows WDA_EXCLUDEFROMCAPTURE——捕获类 API（getDisplayMedia/desktopCapturer/系统截图）
// 看不到本窗口，窗口本地正常显示（腾讯会议同款）。共享结束或窗口销毁自动恢复
ipcMain.on('call:share-protect', function (e, on) {
    var w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.setContentProtection(!!on);
});

// 阶段一百五十一补丁：会议窗最小化（Electron 无边框窗无系统按钮，页面自绘按钮经此最小化到任务栏）
ipcMain.on('call:minimize', function (e) {
    var w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.minimize();
});

// ===== 阶段一百四十四：会议桌面共享（getDisplayMedia 放行） =====
// Electron 下渲染层 getDisplayMedia 默认被拒，须注册 display-media 请求处理器静默放行主屏
//（一期共享整屏不弹选择器，微信同款一键共享；sources 顺序首项即主屏）
// 注意：session.defaultSession 仅在 app ready 后可访问（顶层访问抛
// "Session can only be received when app is ready" 且主进程启动即崩），故注册归口 whenReady 回调
function registerDisplayMediaHandler() {
    // 阶段一百五十一补丁：权限显式归口放行——display-capture 权限请求/检查无 handler 时
    // 新版 Electron 可能走默认拒绝路径（WEB 端浏览器正常而 PC 报「屏幕共享不可用」的嫌疑之一）；
    // 其余权限维持既有默认放行行为不变
    session.defaultSession.setPermissionRequestHandler(function (wc, permission, callback) {
        callback(true); // 原行为：无 handler 时默认放行——显式归口保持一致
    });
    session.defaultSession.setPermissionCheckHandler(function (wc, permission) {
        return true; // 原行为：无 handler 时默认放行——显式归口保持一致
    });
    session.defaultSession.setDisplayMediaRequestHandler(function (options, callback) {
        desktopCapturer.getSources({ types: ['screen'] }).then(function (sources) {
            if (!sources.length) { callback({}); return; }
            // 阶段一百五十一补丁：callback 键名改为官方文档形态 video（原 callback({ source })
            // 在新版 Electron 中为无效载荷，getDisplayMedia 被拒报「屏幕共享不可用」）
            callback({ video: sources[0] }); // 原代码：callback({ source: sources[0] })
        }).catch(function () { callback({}); });
    });
}

// 会中邀请桥（阶段一百四十四）：会议窗"邀请成员"→ 主窗口弹选人弹窗
//（chat.js 归口上行 meet_invite；主窗口最小化/托盘时唤起聚焦，保证用户看到弹窗）
ipcMain.on('meet:invite-ask', function (e, data) {
    if (!callWin || e.sender !== callWin.webContents) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('meet:invite-ask', data);
    }
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
    const uname = String(username || '');
    // 阶段一百三十八：登录后首个沙箱查询即注入执行器（幂等，agent:exec 每次也会再注入），
    // 并通知浏览区重试待恢复的文件标签——页面首帧加载时的恢复早于登录，自选工作区
    // （沙箱 primary）未注入导致相对路径解析失败、标签恢复失败（实测 2026-09-17）
    agentExecutor.setSandbox(uname, sandboxStore[uname] || null);
    browserManager.notifySandboxReady(uname);
    return sandboxStore[uname] || { primary: '', dirs: [] };
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

// ===== 阶段一百二十：Agent C/C++ 编译环境管理器（toolchain-manager.js 归口） =====
// 注入服务端基地址（与登录服务器同源，zip 静态托管于 <WebDir>/static/gcc-toolchain.zip）；
// Agent 任务 run_command 预检到编译命令时经 toolchain-manager.ensureCompiler 自动准备编译环境
const compilerManager = require('./toolchain-manager.js');
compilerManager.setServerBase(SERVER_URL);
// 阶段一百二十一：后台刷新服务端 ExePaths 声明缓存（按声明定位；失败静默，磁盘缓存/内置注册表兜底）
compilerManager.toolchainRefreshExePaths();

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

// ===== 阶段一百二十一：工具链市场 IPC（[工具链] 页签一键安装/状态查询，复用 toolchain-manager.js 归口） =====
ipcMain.handle('toolchain:install', function (event, payload) {
    const p = payload || {};
    return compilerManager.installFromMarket(String(p.name || 'gcc'), String(p.zip_url || ''), String(p.sha256 || ''), String(p.installer_script || ''));
});
ipcMain.handle('toolchain:status', function (event, payload) {
    const p = payload || {};
    return compilerManager.toolchainStatus(String(p.name || 'gcc'));
});

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
            // 阶段一百二十二：additionalArguments/allowRunningInsecureContent 已随 app:// 方案移除（origin 不变无需传参）
        }
    });
    // 阶段一百二十二：托盘面板地址恢复服务端 http（静态资源经 http 拦截读本地，原 app:// 方案已回退）
    // 更早原实现：panelWin.loadURL(SERVER_URL + 'tray-panel.html')
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

app.whenReady().then(async function () {
    // 阶段一百三十四：单实例锁二次守卫——非首实例 app.quit() 异步执行期间 whenReady 仍会触发，
    // 不建窗口直接返回（否则第二实例闪现一个窗口后被 quit 杀掉，实测 2026-09-16）
    // 原实现：无此守卫（窗口闪现根因）
    if (!singleInstanceAllowed) return;
    // 隐藏 Electron 默认应用菜单：File/Edit/View/Window/Help 为开发调试用途（含刷新/DevTools），正式客户端不展示
    // 原实现：未设置应用菜单，Windows 上自动显示 Electron 默认英文菜单
    // Menu.setApplicationMenu(Menu.buildFromTemplate([]));
    Menu.setApplicationMenu(null);

    // 阶段一百二十二：本地缓存初始化 → http 拦截安装 → 窗口创建（内含页面加载）→ 启动增量同步
    // 拦截必须先于页面加载安装（静态资源命中本地秒开）；sync 内部自带 4s 总超时与全静默兜底，
    // 服务端离线/超时不阻塞启动（缺失文件运行期透传兜底）。同 origin 方案无需登录态迁移
    // （原 app:// 方案需 migrateLegacyStorage，实测跨协议导航稳定性问题后整体回退）
    // 阶段一百三十六：注入加密密钥（resolveSecureKey 归口）——启用后磁盘只落密文、内存解密
    registerDisplayMediaHandler(); // 阶段一百四十四：会议桌面共享放行（session 须 ready 后注册）
    webCache.init({
        serverUrl: SERVER_URL,
        secureKey: resolveSecureKey(),
        // 阶段一百四十：同步变更刷新主窗口（启动轮/失败重试轮共用出口——重试自愈成功后页面同样自动换新）
        onSynced: function (r) {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
        }
    });
    webCache.installInterceptor();
    createWindow();
    // 阶段一百四十：同步失败不再死等下次重启（原先 cacheDir 旧副本遮蔽内置新快照、页面时好时坏根因）
    // ——失败后 web-cache 内部定时重试（30s 起指数退避封顶 5 分钟），自愈成功经 onSynced 刷新主窗口
    var syncResult = await webCache.sync();
    createTray();

    // 阶段九十一：内置浏览器管理器初始化（渲染层 IPC 入口注册 + 主窗口引用注入；
    // 需在 createWindow 之后——mainWindow 引用就绪后 agent 工具与面板控制才可用）
    browserManager.init(mainWindow);
    // 阶段九十二：文件查看标签依赖注入——路径校验复用 agentExecutor.safePath（防循环依赖改注入），
    // viewer 页地址随服务端 web 目录同源分发（SERVER_URL + file-viewer.html）
    browserManager.setPathGuard(agentExecutor.safePath);
    // 阶段一百零九：viewer 页加版本参数防 iframe HTTP 缓存命中旧版（页面逻辑更新后改此版本号即可）
    // 阶段一百二十二：viewer 地址恢复服务端 http（同 origin 下 chat.js 相对路径 iframe 自动命中 http 拦截）
    browserManager.setViewerUrl(SERVER_URL + 'file-viewer.html?v=131'); // v=131：同步渲染改 render 返回即回执（防 rAF 绘制冻结丢回执，与 chat.js iframe src 同步）
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

    // 阶段一百三十九：录屏全局快捷键（QQ 同款二段语义）——未录制时触发录屏流程，录制中再按=停止；
    // Ctrl+Alt+R 被占用时自动回退 Ctrl+Shift+R（实测本机 Ctrl+Alt+R 被其他程序长期占用，注册恒失败）；
    // 两个都失败仅告警（截图按钮下拉菜单"录屏"项仍可用），实际生效键位经 rec:shortcut 供菜单文案同步
    var recShortcutLabel = 'Ctrl+Alt+R';
    var recHotkeyHandler = function () {
        if (!mainWindow) return;
        mainWindow.webContents.send('rec:global-ctrl', { action: recActive ? 'stop' : 'start' });
    };
    var recShortcutOk = globalShortcut.register('Control+Alt+R', recHotkeyHandler);
    if (!recShortcutOk) {
        recShortcutLabel = 'Ctrl+Shift+R';
        recShortcutOk = globalShortcut.register('Control+Shift+R', recHotkeyHandler);
    }
    if (!recShortcutOk) {
        recShortcutLabel = '';
        console.warn('录屏全局快捷键注册失败（Ctrl+Alt+R 与 Ctrl+Shift+R 均被占用，仅菜单入口可用）');
    }

    // 阶段一百三十九：实际生效的录屏快捷键标签（空串=无全局键，仅菜单入口），菜单/toast 文案同步用
    ipcMain.handle('rec:shortcut', function () { return recShortcutLabel; });

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// 退出前释放全部全局快捷键（避免残留占用），并回收全部 MCP 子进程树
app.on('will-quit', function () {
    globalShortcut.unregisterAll();
    try { mcpManager.disposeAll(); } catch (e) {} // 阶段九十：本机 MCP 服务器进程随应用退出全量回收
    try { browserManager.lspShutdown(); } catch (e) {} // 阶段一百三十：LSP 语言服务器子进程随应用退出全量回收
    shotPickerStop(); // 阶段一百三十九：窗口识别命中服务随应用退出回收（stdin 断开子进程自退，此为主动清理）
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 导出通知方法供 preload 调用
module.exports = { showNotification: showNotification };
