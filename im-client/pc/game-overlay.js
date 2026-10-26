// game-overlay.js - 游戏内 Overlay 悬浮窗（Steam 同款 Shift+Tab 好友/大厅面板，一期）
//
// 设计文档：docs/游戏内Overlay功能技术设计.md（评审通过版）
//
// 定位（一期·零注入）：
//   玩家从客户端启动游戏后，按 Shift+Tab 在游戏画面上方呼出置顶透明面板——好友列表/私聊/
//   房间镜像/邀请；再按（或 Esc/点遮罩/×）收起并归还焦点。不注入游戏进程、不触碰游戏内存。
//
// 硬性边界：
//   1. 热键生命周期绑定游戏运行态：runningGames/runningLocalGames 全空即注销（平时零占用，
//      不影响 Alt+A 截图 / 录屏等既有全局热键）；
//   2. 悬浮窗不开第二条 WebSocket（数据面经 gn:* 中继复用主窗口唯一 WS，main.js 归口）；
//   3. 独占全屏（Exclusive Fullscreen）游戏面板不可见为 Windows 机制限制（文档 §五.1），
//      本模块不猜不测独占态，引导文案由渲染层/游戏库承载；
//   4. 面板关闭仅 hide() 单例复用（同 gameStoreWin 模式），失焦自动收起防遮挡游戏。
//
// 焦点归还策略（文档 §4.1.4）：
//   主路径 = hide() 后 Windows 依 Z 序自动把焦点还给游戏；兜底 = 按游戏 PID 枚举顶层窗口
//   SetForegroundWindow（PowerShell user32，进程内一次性查询，失败静默）。

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require('electron');

// Win7（os.release 6.1.x）硬性禁用：win7 壳强制 disableHardwareAcceleration + Electron 22/Chromium 108，
// transparent 窗口在关 DWM/软渲染下是黑屏整块挡游戏（设计文档 §4.1.1/§五.9 降级策略取"整体禁用"）
var WIN7 = /^6\.1\./.test(os.release());

var serverUrl = '';      // init 注入（与 main.js SERVER_URL 同源）
var logger = null;       // 日志归口（main.js 注入 gnLogWrite；未注入则静默）
function log(msg) { try { if (logger) logger(msg); } catch (e) { } }

var overlayWin = null;          // 悬浮窗单例（close 仅 hide，app.isQuitting 才真销毁）
var notifyWin = null;           // 通知小窗单例（Steam 式游戏内消息/邀请 toast，设计文档 §十）
var settings = { enabled: true, notify: true, hotkey: 'Shift+Tab' }; // 持久化 userData/game-overlay.json
var hotkeyArmed = false;        // 游戏运行态（应注册热键）
var hotkeyRegistered = false;   // globalShortcut 实际处于注册态（重注册/注销的判据；与 hotkeyOk 区分）
var hotkeyOk = false;           // 最近一次注册成功与否（被占用时 false，仅告警一次）
var hotkeyWarned = false;       // 注册失败仅提示一次
var games = new Map();          // key → { pid }（game/local 启动登记；退出注销；取最新 pid 归还焦点）
var latestPid = 0;              // 最近启动的游戏 PID（焦点归还目标）
var openGuard = 0;              // 面板可交互时间戳（show 后 600ms 内 blur 不收起）

// ===== 设置持久化（userData/game-overlay.json，仿 game-launch.json 口径）=====
function settingsFile() { return path.join(app.getPath('userData'), 'game-overlay.json'); }
function settingsLoad() {
    try {
        var s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        if (s && typeof s === 'object') {
            if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
            if (typeof s.notify === 'boolean') settings.notify = s.notify;
            if (typeof s.hotkey === 'string' && s.hotkey.trim()) settings.hotkey = s.hotkey.trim();
        }
    } catch (e) { /* 首启无文件=默认值 */ }
}
function settingsSave() {
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8'); } catch (e) { log('[overlay] 设置落盘失败:' + e.message); }
}

// ===== 悬浮窗创建/复用（透明全屏遮罩 + 居中卡片，页面自绘）=====
function ensureOverlayWindow() {
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
    overlayWin = new BrowserWindow({
        width: 520,
        height: 680,                    // 卡片尺寸；显示期 setBounds 覆盖游戏所在显示器整屏
        show: false,
        frame: false,
        transparent: true,              // 全屏暗色遮罩 + 居中卡片（Steam overlay 观感）；页面禁硬编码纯黑
        hasShadow: false,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        title: '游戏内面板',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver'); // 盖过全屏游戏（先例：remoteBarWin）
    overlayWin.loadURL(serverUrl + 'overlay.html?v=1');
    overlayWin.on('close', function (e) {
        if (app.isQuitting) return; // 托盘退出流程：放行销毁
        e.preventDefault();
        hideOverlay(false);         // 关闭 = 收起（用户点 × 与 Esc 同口径）
    });
    // 失焦自动收起：Alt+Tab/Win 键切走后残留在游戏上方会遮挡画面；
    // openGuard 内（show+focus 落定期）不触发，防启动瞬间误收
    overlayWin.on('blur', function () {
        if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
        if (Date.now() - openGuard < 600) return;
        hideOverlay(false);
    });
    overlayWin.on('closed', function () { overlayWin = null; });
    if (typeof onWindowCreated === 'function') onWindowCreated(overlayWin); // main.js 注入：注册 gn 中继订阅
    return overlayWin;
}

// ===== 通知小窗（Steam 式游戏内消息/邀请 toast，设计文档 §十）=====
// 独立小窗而非复用面板窗：窗口本体即通知区域（remote-bar 同款先例），天然不挡游戏操作；
// focusable:false = toast 悬停/消失不夺游戏焦点，仅点击时经 notify:open 唤起面板夺焦
var notifyReady = false;   // 通知页监听器就绪（did-finish-load + 500ms 或首次 notify:visible）
var notifyBuf = [];        // 冷启动缓存：页面加载期间到达的镜像消息（游戏刚启动="开了吗"高发时刻，丢 toast 高发窗口）
var notifyFlushTimer = null;
function ensureNotifyWindow() {
    if (notifyWin && !notifyWin.isDestroyed()) return notifyWin;
    if (WIN7 || !settings.notify) return null; // WIN7 硬性禁用 / 设置关闭：不创建
    notifyWin = new BrowserWindow({
        width: 320,
        height: 660,                    // 堆叠区（内容锚定底部右对齐，最多 4 条 + 合并计数）
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,               // 不参与焦点竞争（点 toast 时由 showOverlay 夺焦）
        title: '游戏内通知',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    notifyWin.setAlwaysOnTop(true, 'screen-saver');
    notifyWin.loadURL(serverUrl + 'notify.html?v=1');
    notifyReady = false; // 新页面需重新就绪（销毁重建后不得沿用旧标记，否则冷启动缓存失效）
    notifyBuf = [];
    // 冷启动就绪标记：did-finish-load（页面脚本已跑完）+ 500ms 余量 → 补投缓存期消息
    notifyWin.webContents.on('did-finish-load', function () {
        setTimeout(function () {
            if (notifyReady) return;
            notifyReady = true;
            flushNotifyBuf();
        }, 500);
    });
    notifyWin.on('closed', function () { notifyWin = null; });
    if (typeof onWindowCreated === 'function') onWindowCreated(notifyWin); // 加入 gn 中继订阅（收 chat-in 镜像）
    return notifyWin;
}
// 镜像冷启动缓存（main.js gn:chat-mirror 处调用）：通知页监听器注册前到达的消息先入队，
// 页面就绪后按序补投（广播给未注册监听器的页面会被丢弃，缓存副本是唯一送达路径）
function bufferChatMirror(msg) {
    if (!notifyWin || notifyWin.isDestroyed() || notifyReady) return; // 无窗/已就绪：广播链路即正常送达
    notifyBuf.push(msg || {});
    if (notifyBuf.length > 20) notifyBuf.shift(); // 与 toast 堆叠上限同量级的防刷屏封顶
    if (!notifyFlushTimer) notifyFlushTimer = setInterval(flushNotifyBuf, 500); // 兜底轮询（did-finish-load 漏触发时自愈）
}
function flushNotifyBuf() {
    if (notifyBuf.length) {
        // 页面已就绪（did-finish-load+500ms 或首次 notify:visible）：按序补投
        for (var i = 0; i < notifyBuf.length; i++) {
            try { notifyWin.webContents.send('gn:chat-in', notifyBuf[i]); } catch (e) { }
        }
    }
    notifyBuf = [];
    if (notifyFlushTimer) { clearInterval(notifyFlushTimer); notifyFlushTimer = null; }
}
function destroyNotifyWindow() {
    if (notifyWin && !notifyWin.isDestroyed()) {
        try { notifyWin.destroy(); } catch (err) { try { notifyWin.hide(); } catch (e2) { } } // destroy 异常兜底 hide（webContents destroyed 前不出订阅表，窗口已隐藏无副作用）
    }
    notifyWin = null;
    notifyReady = false;
    notifyBuf = [];
    if (notifyFlushTimer) { clearInterval(notifyFlushTimer); notifyFlushTimer = null; }
}
// 右下角定位：游戏所在显示器 bounds 内缩 12px（复用面板窗的显示器解析结果，副屏自动跟随）
function positionNotifyWindow() {
    if (!notifyWin || notifyWin.isDestroyed() || !gameDisplay) return;
    try {
        var b = gameDisplay.bounds;
        notifyWin.setBounds({
            x: b.x + b.width - 320 - 12,
            y: b.y + b.height - 660 - 12,
            width: 320,
            height: 660
        });
    } catch (e) { /* 显示器热拔出等极端态：保持原位 */ }
}

// ===== 定位：游戏所在显示器整屏覆盖 =====
// 解析顺序：游戏 PID 窗口矩形（PowerShell，延迟重试）→ 启动瞬间光标所在显示器 → 主显示器
var gameDisplay = null;   // 最近一次解析结果（Display.bounds），null=未解析
function resolveGameDisplay() {
    var displays = screen.getAllDisplays();
    var primary = screen.getPrimaryDisplay();
    // 兜底链1：光标（点启动按钮的手，大概率就在游戏将出现的屏）
    var cur = screen.getCursorScreenPoint();
    var byCursor = null;
    for (var i = 0; i < displays.length; i++) {
        var b = displays[i].bounds;
        if (cur.x >= b.x && cur.x < b.x + b.width && cur.y >= b.y && cur.y < b.y + b.height) { byCursor = displays[i]; break; }
    }
    gameDisplay = byCursor || primary;
    if (!latestPid) return; // 无 PID：光标结果即终值
    // 兜底链2：按 PID 探测游戏窗口矩形（2s/6s 重试——游戏窗口创建有延迟），命中即覆盖
    var attempt = function (delay) {
        setTimeout(function () {
            if (!latestPid || (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible())) return; // 已收口/面板已开着不再改定位
            psGameRect(latestPid, function (rect) {
                if (!rect) return;
                var cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
                for (var j = 0; j < displays.length; j++) {
                    var bb = displays[j].bounds;
                    if (cx >= bb.x && cx < bb.x + bb.width && cy >= bb.y && cy < bb.y + bb.height) {
                        gameDisplay = displays[j];
                        if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
                            overlayWin.setBounds(gameDisplay.bounds); // 面板开着：就地重定位（罕见）
                        }
                        positionNotifyWindow(); // 通知窗跟随游戏显示器（设计文档 §10.3）
                        log('[overlay] 游戏窗口显示器解析: ' + JSON.stringify(gameDisplay.bounds));
                        break;
                    }
                }
            });
        }, delay);
    };
    attempt(2000);
    attempt(6000);
}

// ===== PowerShell user32 助手（窗口矩形探测 / 焦点归还）=====
// 项目已有 PowerShell spawn 先例（game:disk-list）；脚本进程级一次性编译，串行化防叠加
var psBusy = false;
function runPs(script, cb) {
    if (psBusy) { cb(null); return; } // 串行窗口期直接放弃（探测/归还均为尽力而为，不排队）
    psBusy = true;
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 5000, windowsHide: true },
        function (err, stdout) {
            psBusy = false;
            if (err) { cb(null); return; }
            cb(String(stdout || '').trim());
        });
}
// PID → 最大可见顶层窗口矩形 {x,y,w,h} | null（EnumWindows 按 PID 过滤取面积最大者）
function psGameRect(pid, cb) {
    var script = [
        'Add-Type -Namespace Win -Name U -MemberDefinition \'',
        '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
        '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
        '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
        'public delegate bool EnumProc(IntPtr h, IntPtr lp);',
        '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }\'',
        '$best = $null; $area = 0',
        '$cb = { param($h, $lp)',
        '  $p = 0; [Win.U]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null',
        '  if ($p -eq ' + Number(pid) + ' -and [Win.U]::IsWindowVisible($h)) {',
        '    $r = New-Object Win.U+RECT; [Win.U]::GetWindowRect($h, [ref]$r) | Out-Null',
        '    $a = ($r.R - $r.L) * ($r.B - $r.T)',
        '    if ($a -gt $area) { $area = $a; $best = "$($r.L),$($r.T),$($r.R - $r.L),$($r.B - $r.T)" }',
        '  }',
        '  return $true }',
        '[Win.U]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
        'if ($best) { Write-Output $best }'
    ].join('; ');
    runPs(script, function (out) {
        if (!out) { cb(null); return; }
        var m = out.split(',');
        if (m.length !== 4) { cb(null); return; }
        var r = { x: parseInt(m[0], 10), y: parseInt(m[1], 10), w: parseInt(m[2], 10), h: parseInt(m[3], 10) };
        cb((r.w > 0 && r.h > 0) ? r : null);
    });
}
// 焦点归还兜底：把 PID 的最大可见顶层窗口调到前台（失败静默——主路径 Z 序归还通常已生效）
function psForeground(pid) {
    if (!pid) return;
    var script = [
        'Add-Type -Namespace Win2 -Name U -MemberDefinition \'',
        '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
        '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
        '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
        'public delegate bool EnumProc(IntPtr h, IntPtr lp);\'',
        '$hit = [IntPtr]::Zero',
        '$cb = { param($h, $lp)',
        '  $p = 0; [Win2.U]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null',
        '  if ($p -eq ' + Number(pid) + ' -and [Win2.U]::IsWindowVisible($h)) { $script:hit = $h; return $false }',
        '  return $true }',
        '[Win2.U]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
        'if ($hit -ne [IntPtr]::Zero) { [Win2.U]::SetForegroundWindow($hit) | Out-Null }'
    ].join('; ');
    runPs(script, function () { });
}

// ===== 显隐状态机 =====
function broadcastState() {
    var payload = { open: !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()), enabled: settings.enabled, hotkey: settings.hotkey, hotkeyOk: hotkeyOk };
    var wins = BrowserWindow.getAllWindows();
    for (var i = 0; i < wins.length; i++) {
        if (!wins[i].isDestroyed()) wins[i].webContents.send('overlay:state', payload);
    }
}
function showOverlay() {
    if (!settings.enabled || WIN7) return; // WIN7 硬性禁用（透明窗黑屏挡游戏，见头部说明）
    var win = ensureOverlayWindow();
    if (!gameDisplay) resolveGameDisplay();
    var show = function () {
        if (!overlayWin || overlayWin.isDestroyed()) return;
        try { overlayWin.setBounds(gameDisplay.bounds); } catch (e) { /* 显示器热拔出等极端态兜底主屏 */ }
        overlayWin.show();
        overlayWin.focus(); // 呼出即夺焦点：游戏收不到输入（Steam overlay 同语义）
        openGuard = Date.now();
        broadcastState();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show);
    else show();
}
function hideOverlay(refocus) {
    if (!overlayWin || overlayWin.isDestroyed()) { broadcastState(); return; }
    if (overlayWin.isVisible()) overlayWin.hide();
    broadcastState();
    if (refocus && latestPid) {
        // 主路径（Z 序自动归还）通常已生效；延迟兜底幂等（已是前台时 SetForegroundWindow 无副作用）
        setTimeout(function () { psForeground(latestPid); }, 150);
    }
}
function toggleOverlay() {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) hideOverlay(true);
    else showOverlay();
}

// ===== 热键生命周期（绑定游戏运行态）=====
function registerHotkey() {
    if (hotkeyRegistered) { try { globalShortcut.unregister(settings.hotkey); } catch (e) { } hotkeyRegistered = false; }
    hotkeyOk = false;
    try { hotkeyOk = globalShortcut.register(settings.hotkey, toggleOverlay); } catch (e) { hotkeyOk = false; }
    if (!hotkeyOk && !hotkeyWarned) {
        hotkeyWarned = true;
        log('[overlay] 热键注册失败（被占用）: ' + settings.hotkey);
    }
    hotkeyRegistered = hotkeyOk;
}
function armHotkey() {
    if (WIN7 || !settings.enabled || hotkeyArmed) return; // WIN7 硬性禁用：热键不注册、悬浮窗不预热
    hotkeyArmed = true;
    registerHotkey();
    ensureOverlayWindow(); // 预热：首呼出零加载白窗
    ensureNotifyWindow();  // 通知小窗预热（Steam 式 toast，§十；notify 关闭/WIN7 时内部跳过）
    broadcastState();
}
function disarmHotkey(force) {
    if (games.size > 0 && !force) return; // 仅最后一款游戏退出才收口；force=设置里手动关闭（游戏运行中也要立即生效）
    hotkeyArmed = false;
    if (hotkeyRegistered) { try { globalShortcut.unregister(settings.hotkey); } catch (e) { } }
    hotkeyRegistered = false;
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) hideOverlay(false); // 游戏全退收面板
    if (notifyWin && !notifyWin.isDestroyed() && notifyWin.isVisible()) notifyWin.hide(); // 通知窗随游戏退出隐藏（保留页面状态）
    broadcastState();
}
// main.js 广播函数挂接口（info.pid 由 game/local launch 处附带）
function onGameStart(key, pid) {
    if (pid) latestPid = pid;
    games.set(key, { pid: pid || 0 });
    if (!gameDisplay || games.size === 1) resolveGameDisplay();
    armHotkey();
}
function onGameExit(key) {
    games.delete(key);
    if (!games.size) latestPid = 0;
    disarmHotkey();
}

// ===== IPC 注册（main.js init 时调用一次）=====
var onWindowCreated = null; // init 注入：悬浮窗创建回调（main.js 用来把窗口加入 gn 中继订阅表）
function init(opts) {
    opts = opts || {};
    serverUrl = opts.serverUrl || serverUrl;
    logger = opts.log || logger;
    onWindowCreated = opts.onWindowCreated || null;
    settingsLoad();

    ipcMain.on('overlay:toggle', function () { try { toggleOverlay(); } catch (e) { log('[overlay] toggle 异常: ' + e.message); } });
    ipcMain.on('overlay:hide', function () { try { hideOverlay(true); } catch (e) { log('[overlay] hide 异常: ' + e.message); } }); // 渲染层 Esc/×/点遮罩：收起+还焦点
    ipcMain.handle('overlay:settings-get', function () {
        // supported=false（WIN7）：设置页据此隐藏整个「游戏」分类（透明窗能力缺失，功能硬性禁用）
        return { enabled: WIN7 ? false : settings.enabled, notify: WIN7 ? false : settings.notify, hotkey: settings.hotkey, hotkeyOk: hotkeyOk, armed: hotkeyArmed, supported: !WIN7 };
    });
    ipcMain.on('overlay:settings-set', function (e, s) {
        try {
            s = s || {};
            if (WIN7) { broadcastState(); return; } // WIN7 硬性禁用：设置可存但功能保持关闭
            var notifyChanged = false;
            if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
            if (typeof s.notify === 'boolean' && s.notify !== settings.notify) { settings.notify = s.notify; notifyChanged = true; }
            if (typeof s.hotkey === 'string' && s.hotkey.trim()) settings.hotkey = s.hotkey.trim();
            settingsSave();
            // 通知窗动态生效（免重启）：关闭=真销毁（webContents destroyed 自动出 gnRelayWins 订阅表）；开启=游戏运行中立即创建
            if (notifyChanged) {
                if (settings.notify) { if (games.size) ensureNotifyWindow(); }
                else destroyNotifyWindow();
            }
            if (hotkeyArmed) {
                if (settings.enabled) registerHotkey(); // 游戏运行中改键位：旧键注销新键注册
                else disarmHotkey(true); // 游戏运行中手动关闭：跳过 games.size 守卫立即注销热键并收面板
            } else if (settings.enabled && games.size) {
                armHotkey(); // 运行中重新启用
            }
        } catch (err) { log('[overlay] settings-set 异常: ' + err.message); }
        broadcastState();
    });
    // ===== 通知小窗 IPC（设计文档 §10.4）=====
    ipcMain.on('notify:visible', function (e, on) {
        // 通知页栈空/非空的显隐请求；主进程只执行不猜内容。showInactive 不夺游戏焦点
        try {
            if (!notifyReady) { notifyReady = true; flushNotifyBuf(); } // 首次请求=页面监听器已注册：标记就绪并补投冷启动缓存
            if (!notifyWin || notifyWin.isDestroyed()) return;
            if (on) { positionNotifyWindow(); notifyWin.showInactive(); }
            else if (notifyWin.isVisible()) notifyWin.hide();
        } catch (err) { log('[overlay] notify:visible 异常: ' + err.message); }
    });
    ipcMain.on('notify:open', function (e, payload) {
        // 点击 toast：唤起面板（夺焦，与热键呼出同语义）+ 向面板页投递直达参数
        try {
            payload = payload || {};
            showOverlay();
            if (overlayWin && !overlayWin.isDestroyed()) {
                overlayWin.webContents.send(payload.username ? 'overlay:open-chat' : 'overlay:open-room', payload);
            }
        } catch (err) { log('[overlay] notify:open 异常: ' + err.message); }
    });
}

// 防御性导出包装：overlay 自身任何异常不得外溢——game:launch/local-game:launch 的启动链路
// 调用 onGameStart/onGameExit，异常外溢会把「启动成功」误报为失败（hotkeyRegistered 事故的同款风险面）
function safe(fn) {
    return function () {
        try { return fn.apply(null, arguments); } catch (e) { log('[overlay] ' + (fn.name || '匿名') + ' 异常: ' + e.message); }
    };
}

module.exports = {
    init: init,
    setLogger: function (fn) { logger = fn || null; },
    onGameStart: safe(onGameStart),
    onGameExit: safe(onGameExit),
    showOverlay: safe(showOverlay),
    hideOverlay: safe(hideOverlay),
    bufferChatMirror: safe(bufferChatMirror), // main.js gn:chat-mirror 处调用：通知窗冷启动镜像缓存（§十）
    isOpen: function () { return !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()); }
};
