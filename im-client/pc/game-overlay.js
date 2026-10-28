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
const net = require('net'); // 二期 M1：Named Pipe 服务端（DLL 注入式 Overlay 下行通道）
const { execFile } = require('child_process');
const { app, BrowserWindow, globalShortcut, screen, ipcMain, nativeImage } = require('electron');

// Win7（os.release 6.1.x）硬性禁用：win7 壳强制 disableHardwareAcceleration + Electron 22/Chromium 108，
// transparent 窗口在关 DWM/软渲染下是黑屏整块挡游戏（设计文档 §4.1.1/§五.9 降级策略取"整体禁用"）
var WIN7 = /^6\.1\./.test(os.release());

var serverUrl = '';      // init 注入（与 main.js SERVER_URL 同源）
var logger = null;       // 日志归口（main.js 注入 gnLogWrite；未注入则静默）
function log(msg) { try { if (logger) logger(msg); } catch (e) { } }

var overlayWin = null;          // 悬浮窗单例（close 仅 hide，app.isQuitting 才真销毁）
var notifyWin = null;           // 通知小窗单例（Steam 式游戏内消息/邀请 toast，设计文档 §十）
var settings = { enabled: true, notify: true, native: false, hotkey: 'Shift+Tab' }; // 持久化 userData/game-overlay.json
// native（二期 M2）：游戏帧内渲染开关（默认关）。开启后游戏启动经 injector --launch 包装注入
// overlay_hook.dll（CREATE_SUSPENDED → 注入 → resume）；关闭=一期悬浮窗口径（零注入）。
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
            if (typeof s.native === 'boolean') settings.native = s.native;
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
    msg = msg || {};
    pipeForwardMirror(msg); // 二期 M1：注入式 Overlay pipe 转发（私聊文本帧 / 93 触发快照刷新），先于冷启动缓存早退
    if (!notifyWin || notifyWin.isDestroyed() || notifyReady) return; // 无窗/已就绪：广播链路即正常送达
    notifyBuf.push(msg);
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

// ===== 二期注入式 Overlay：Named Pipe 服务端（docs/游戏内Overlay二期注入式设计.md M1）=====
// 每个游戏实例一条 pipe（\\.\pipe\im-overlay-<pid>）：DLL 注入后主动连接（断线 3s 重连由 DLL 侧负责）。
// 协议 = NDJSON（每行一帧）：
//   下行（主进程→DLL）：{t:'hello-ack'} / {t:'friends',list:[{u,n,on}]} / {t:'msg',from,name,text}
//   上行（DLL→主进程）：{t:'hello',pid}（M1 仅日志登记；面板事件上行属 M2）
// DLL 零业务逻辑：好友/消息全部由主进程推帧，DLL 只画。数据源口径与一期悬浮窗一致
// （好友快照 = 主窗口 IMContacts 唯一归口；消息 = gn:chat-in 镜像流语义复用）。
var pipes = new Map();        // pid → { server, sock }（游戏运行期存活；退出即关，DLL 看门狗据此感知卸载）
var ovContactsPending = {};   // 好友快照在途表（'oc' 前缀与 main.js gn:contacts-get 的 'c' 前缀隔离）
var contactsCache = [];       // 最近一次好友快照 [{username,name,online}]（连接建立/变化时推送）
var contactsReqTimer = null;  // 快照刷新节流（93 在线增量可能连发，1.5s 合并一次）
var selfUname = '';           // 本端账号（contacts 应答顺带捎回；DLL 回显消息 self 判定用）
var getGameStoreWin = null;   // init 注入：游戏中心窗引用（M2 房间快照查询，房间态唯一持有者）
var ovRoomPending = {};       // 房间快照在途表（'or' 前缀，与 main.js overlay:room-get 的 'r' 隔离）
var roomReqTimer = null;      // 房间快照刷新节流（109 信令连发合并，1s 一次）
var nativePanelOpen = false;  // M4：DLL 注入式面板呼出中（上行 panel 帧）——面板期悬浮窗热键让位防叠加
var nativePanelActive = false; // M4：帧内渲染生效（DLL 已连接）——Shift+Tab 全权归 DLL（globalShortcut 系统级
                               // 先于游戏窗口 WndProc 拦截按键，若不注销，DLL 永远收不到热键、面板永远弹不出）
// 热键归属切换：DLL 连上=让位（注销全局热键）；DLL 断开/初始化失败（nopanel）=收回（重注册，悬浮窗兜底恢复）
function setNativePanelActive(v) {
    if (nativePanelActive === v) return;
    nativePanelActive = v;
    if (v) {
        if (hotkeyRegistered) { try { globalShortcut.unregister(settings.hotkey); } catch (e) { } hotkeyRegistered = false; }
        // M5.5：帧内渲染生效期通知改由 DLL 帧内 toast 承接，屏外通知窗立即隐藏（避免跑游戏窗口外被任务栏遮挡）
        if (notifyWin && !notifyWin.isDestroyed() && notifyWin.isVisible()) notifyWin.hide();
        log('[overlay] 帧内渲染生效：Shift+Tab 归 DLL 面板（全局热键已注销）');
    } else {
        if (hotkeyArmed) registerHotkey();
        log('[overlay] 帧内渲染失效：Shift+Tab 还给悬浮窗（全局热键已恢复）');
    }
}

function pipeName(pid) { return '\\\\.\\pipe\\im-overlay-' + pid; }

// M5.7：设置热键下发 DLL（帧内热键跟随设置；Electron 加速器 → VK 码）
function hotkeyToVk(acc) {
    var parts = String(acc || 'Shift+Tab').split('+');
    var main = parts.pop() || 'Tab';
    var vk = 0;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(main)) vk = 0x70 + (parseInt(main.slice(1), 10) - 1);
    else if (main === 'Tab') vk = 0x09;
    else if (main === 'Space') vk = 0x20;
    else if (main === 'Insert') vk = 0x2D;
    else if (main === 'Delete') vk = 0x2E;
    else if (main === 'Home') vk = 0x24;
    else if (main === 'End') vk = 0x23;
    else if (main === 'PageUp') vk = 0x21;
    else if (main === 'PageDown') vk = 0x22;
    else if (main === 'Up') vk = 0x26;
    else if (main === 'Down') vk = 0x28;
    else if (main === 'Left') vk = 0x25;
    else if (main === 'Right') vk = 0x27;
    else if (main.length === 1) vk = main.toUpperCase().charCodeAt(0);
    return { vk: vk, ctrl: parts.indexOf('Ctrl') >= 0 ? 1 : 0, shift: parts.indexOf('Shift') >= 0 ? 1 : 0, alt: parts.indexOf('Alt') >= 0 ? 1 : 0 };
}
function pipePushHotkey(sock) {
    var h = hotkeyToVk(settings.hotkey);
    pipeSend(sock, { t: 'hotkey', vk: h.vk, ctrl: h.ctrl, shift: h.shift, alt: h.alt });
}

// M5.8：好友头像位图下发（nativeImage 缩 48x48 → toBitmap BGRA → base64；DLL 建 D3D9 纹理帧内绘制）
var avatarCache = {};   // username → { w, h, b64 }（__self__ = 自己头像）
var avatarBusy = {};    // username → 下载中
var avatarSent = {};    // username → 本 DLL 连接已发送（防每轮联系人刷新重发 ~174KB 突发挤压 msg 帧=toast 延迟，实测根因）
var selfAvatarUrl = ''; // M5.9：自己头像 URL（gnContactsReply 捎回的登录态）
function deliverAvatarsToPipes(sockFilter) {
    // M5.9：自己头像（selfUname 键；AvatarDraw self 行已按 selfUname 取纹理）
    if (selfAvatarUrl && selfUname) {
        var sendSelf = function (frame) {
            avatarSent['__self__'] = true;
            if (sockFilter) pipeSend(sockFilter, frame);
            else pipeBroadcast(frame);
        };
        if (avatarCache['__self__']) { sendSelf(Object.assign({ t: 'avatar', u: selfUname }, avatarCache['__self__'])); }
        else if (!avatarBusy['__self__']) {
            avatarBusy['__self__'] = true;
            resolveAvatar(selfAvatarUrl).then(function (img) {
                avatarBusy['__self__'] = false;
                if (!img || img.isEmpty()) return;
                var r = img.resize({ width: 48, height: 48 });
                var sz = r.getSize();
                if (!sz.width || !sz.height) return;
                avatarCache['__self__'] = { w: sz.width, h: sz.height, b64: r.toBitmap().toString('base64') };
                sendSelf(Object.assign({ t: 'avatar', u: selfUname }, avatarCache['__self__']));
            }).catch(function () { avatarBusy['__self__'] = false; });
        }
    }
    contactsCache.forEach(function (c) {
        if (!c.avatar || !c.username) return;
        var send = function (frame) {
            avatarSent[c.username] = true; // 已发标记（本连接内不重发）
            if (sockFilter) pipeSend(sockFilter, frame);
            else pipeBroadcast(frame);
        };
        if (avatarSent[c.username]) return; // 本连接已发：跳过（热键/消息等小帧不被头像突发挤压）
        if (avatarCache[c.username]) { send(Object.assign({ t: 'avatar', u: c.username }, avatarCache[c.username])); return; }
        if (avatarBusy[c.username]) return;
        avatarBusy[c.username] = true;
        resolveAvatar(c.avatar).then(function (img) {
            avatarBusy[c.username] = false;
            if (!img || img.isEmpty()) return;
            var r = img.resize({ width: 48, height: 48 });
            var sz = r.getSize();
            if (!sz.width || !sz.height) return;
            avatarCache[c.username] = { w: sz.width, h: sz.height, b64: r.toBitmap().toString('base64') };
            send(Object.assign({ t: 'avatar', u: c.username }, avatarCache[c.username]));
        }).catch(function () { avatarBusy[c.username] = false; });
    });
}
function resolveAvatar(url) {
    return new Promise(function (resolve) {
        try {
            var u = String(url || '');
            if (!u) return resolve(null);
            if (u.indexOf('//') === -1 || u.charAt(0) === '/') { // 相对路径 → 补主窗口源
                var mw = getMainWindow ? getMainWindow() : null;
                var origin = '';
                try { origin = new URL(mw && !mw.isDestroyed() ? mw.webContents.getURL() : 'about:blank').origin; } catch (eO) { }
                if (!origin || origin === 'null') return resolve(null);
                u = origin + (u.charAt(0) === '/' ? '' : '/') + u;
            }
            var mod = u.indexOf('https:') === 0 ? require('https') : require('http');
            mod.get(u, function (res) {
                var chunks = [];
                res.on('data', function (c) { chunks.push(c); });
                res.on('end', function () { try { resolve(nativeImage.createFromBuffer(Buffer.concat(chunks))); } catch (eD) { resolve(null); } });
            }).on('error', function () { resolve(null); });
        } catch (e) { resolve(null); }
    });
}
function pipeSend(sock, frame) {
    if (!sock) return;
    try { sock.write(JSON.stringify(frame) + '\n'); } catch (e) { log('[overlay] pipe 写帧失败: ' + e.message); }
}
function pipeBroadcast(frame) {
    pipes.forEach(function (p) { if (p && p.sock) pipeSend(p.sock, frame); });
}
function friendsFrameList() {
    return contactsCache.slice(0, 50).map(function (c) {
        return { u: String(c.username || ''), n: String(c.name || c.username || ''), on: !!c.online };
    });
}
// 好友快照请求（模式同 main.js gn:contacts-get：主窗口 IMContacts 应答；在途表 + 3s 超时自愈）
function askContacts() {
    var mw = getMainWindow ? getMainWindow() : null;
    if (!mw || mw.isDestroyed()) return;
    var id = 'oc' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    ovContactsPending[id] = true;
    setTimeout(function () { delete ovContactsPending[id]; }, 3000);
    try { mw.webContents.send('gn:contacts-need', id); } catch (e) { }
}
function askContactsThrottled() {
    if (contactsReqTimer) return;
    contactsReqTimer = setTimeout(function () { contactsReqTimer = null; askContacts(); }, 1500);
}
// main.js gn:contacts-reply 处调用（与 gn:contacts-get 共用一条应答通道，按 id 分流）；
// u = 主窗口顺带捎回的本端账号（socket.js gnContactsReply 第三参，IMSocket.getUsername 兜底 im_auth）
function onContactsReply(id, list, u, ma) {
    if (!ovContactsPending[id]) return;
    delete ovContactsPending[id];
    contactsCache = (Array.isArray(list) ? list : []).slice(0, 200).map(function (c) {
        c = c || {};
        return { username: String(c.username || ''), name: String(c.name || ''), online: !!c.online, avatar: String(c.avatar || '') };
    });
    var newU = String(u || '');
    var meChanged = newU && newU !== selfUname;
    if (meChanged) selfUname = newU;
    if (String(ma || '')) selfAvatarUrl = String(ma); // M5.9：自己头像 URL（登录态，chat.js 经 socket.js 捎回）
    log('[overlay] 好友快照更新: ' + contactsCache.length + ' 人' + (meChanged ? '（me=' + selfUname + '）' : ''));
    pipeBroadcast({ t: 'friends', list: friendsFrameList() });
    if (meChanged) pipeBroadcast({ t: 'me', u: selfUname }); // DLL 回显消息 self 判定
    deliverAvatarsToPipes(); // M5.8：好友头像位图下发（缓存命中直发，未下载的异步取；含自己头像）
}
// ===== M2 上行帧路由（DLL 面板事件 → 与一期悬浮窗同口径：gn:signal-out 经主窗口 WS 上行）=====
// 白名单收敛：只放行私聊文本与房间三动作，防被攻陷的游戏进程借 pipe 注入任意信令
function sendUplink(payload) {
    var mw = getMainWindow ? getMainWindow() : null;
    if (!mw || mw.isDestroyed()) return;
    try { mw.webContents.send('gn:signal-out', payload); } catch (e) { log('[overlay] 上行转发异常: ' + e.message); }
}
function onPipeFrame(pid, line) {
    var f = null;
    try { f = JSON.parse(line); } catch (e) { return; }
    if (!f || typeof f !== 'object') return;
    if (f.t === 'chat-send') {
        var payload = { msg_type: 2, to_user: String(f.to || '').slice(0, 64), content: String(f.text || '').slice(0, 2000) };
        if (!payload.to_user || !payload.content) return;
        log('[overlay] 上行私聊 → ' + payload.to_user);
        sendUplink(payload);
    } else if (f.t === 'room-act') {
        var act = String(f.action || '').slice(0, 16);
        if (act !== 'ready' && act !== 'leave' && act !== 'chat') return;
        // M5.9：room_id 必须字符串——服务端 gnRoomSignal.RoomID 是 string，数字会让 JSON 解析报错静默丢帧（实测房间聊天发不出根因）
        var content = { action: act, room_id: String(Number(f.room_id) || 0) };
        if (act === 'chat') content.text = String(f.text || '').slice(0, 500);
        log('[overlay] 上行房间动作: ' + act + ' #' + content.room_id);
        sendUplink({ msg_type: 109, content: JSON.stringify(content) }); // 109 信封包装（一期 overlay.js send() 同款）
    } else if (f.t === 'hello') {
        log('[overlay] DLL 登记pid=' + f.pid); // M1 仅日志；看门狗/卸载语义属 M3
    } else if (f.t === 'panel') {
        // M4：DLL 面板呼出/收起上报——nativePanelOpen=true 时悬浮窗让位防叠加（热键归属另由 panel-ready 帧管理）
        nativePanelOpen = !!f.on;
        log('[overlay] DLL 面板' + (nativePanelOpen ? '呼出（悬浮窗让位）' : '收起（悬浮窗恢复）'));
    } else if (f.t === 'nopanel') {
        // M4：DLL 面板初始化失败（imgui 起不来）——Shift+Tab 若继续归 DLL 就是死键，立即收回给悬浮窗
        setNativePanelActive(false);
    } else if (f.t === 'panel-ready') {
        // M4.1（审计修复）：DLL WndProc 钩装好（ImGui 初始化成功）——Shift+Tab 从此刻起归 DLL，
        // 让位全局热键（连接就让位会让无 D3D 的启动器进程全程死键）
        setNativePanelActive(true);
    } else if (f.t === 'child') {
        // M4 方案 A：启动器拉起游戏子进程（跟随注入成功）→ 为子进程建 pipe（好友/房间推流闭环）。
        // 游戏 DLL 3s 重连循环会连上；子 pipe 随客户端进程退出回收（运行期残留一条空转 server 可接受）
        var cpid = Number(f.pid) || 0;
        if (cpid && !pipes.has(cpid)) {
            log('[overlay] 启动器拉起游戏子进程 pid=' + cpid + ' → 建 pipe');
            startPipeServer(cpid);
        }
    } else if (f.t === 'avatars-need') {
        // M5.8：DLL 设备重绑后要重发头像（清已发标记 → 全量重发）
        avatarSent = {};
        deliverAvatarsToPipes();
    }
}
// ===== M2 房间快照（模式同 M1 askContacts：向唯一持有者 gameStoreWin 查询，3s 超时兜底 null）=====
function roomFrameFromSnap(snap) {
    if (!snap || !snap.room_id) return null;
    return {
        room_id: Number(snap.room_id) || 0,
        name: String(snap.name || ''),
        game_name: String(snap.game_name || ''),
        status: String(snap.status || ''),
        members: (Array.isArray(snap.members) ? snap.members : []).slice(0, 8).map(function (m) {
            m = m || {};
            return { u: String(m.username || ''), n: String(m.name || m.username || ''), r: !!m.ready, h: !!m.host };
        }),
        chats: (Array.isArray(snap.chats) ? snap.chats : []).slice(-20).map(function (c) {
            c = c || {};
            // M5.9f 审计：截断保帧体积（20 条中文最坏 ~10KB，DLL obj 16384 覆盖）
            return { n: String(c.n || '').slice(0, 24), x: String(c.x || '').slice(0, 120), u: String(c.u || '').slice(0, 32), s: c.s ? 1 : 0 };
        })
    };
}
function queryRoomSnapshot(cb) {
    var gw = getGameStoreWin ? getGameStoreWin() : null;
    if (!gw || gw.isDestroyed()) { cb(null); return; }
    var id = 'or' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    ovRoomPending[id] = cb;
    setTimeout(function () {
        if (ovRoomPending[id]) { delete ovRoomPending[id]; cb(null); }
    }, 3000);
    try { gw.webContents.send('overlay:room-need', id); } catch (e) { delete ovRoomPending[id]; cb(null); }
}
// main.js overlay:room-reply 处调用（与悬浮窗 overlay:room-get 共用应答通道，按 id 前缀 'or' 分流）
function onRoomReply(id, snap) {
    var cb = ovRoomPending[id];
    if (!cb) return;
    delete ovRoomPending[id];
    var room = roomFrameFromSnap(snap);
    pipeBroadcast({ t: 'room', room: room }); // null = 未在房（DLL 据此清空镜像）
}
// main.js gn:signal-recv 处调用：109 房间信令 → 节流刷新房间快照推帧（不解析信令内容，只做触发器）
function onGnSignal(msg) {
    msg = msg || {};
    if (msg.msg_type !== 109 || !pipes.size) return;
    var isChat = false;
    try {
        var env = JSON.parse(msg.content || '{}');
        if (env.action === 'chat') {
            // M5.9：房内聊天广播 → DLL 房间页聊天区（快照刷新走下方节流通道，两者互补）；self 供左右分栏
            pipeBroadcast({
                t: 'roomchat', name: String(env.from_name || env.from || '').slice(0, 48),
                text: String(env.text || '').slice(0, 160), u: String(env.from || ''),
                self: env.from && env.from === selfUname ? 1 : 0
            });
            isChat = true;
        }
    } catch (e) { }
    // M5.10d 审计：聊天信号不触发快照——快照整体替换聊天区，滞后快照会抹掉刚显示的实时消息（显示回退=延迟感）；
    // 仅房间状态变化（进出/准备/状态）才刷新快照
    if (isChat) return;
    if (roomReqTimer) return;
    roomReqTimer = setTimeout(function () {
        roomReqTimer = null;
        queryRoomSnapshot(onRoomReply);
    }, 1000);
}
// 镜像转发（bufferChatMirror 入口内调用，M1 口径）：
//   2=私聊文本 → {t:'msg'} 帧（名字按 from_user 查快照，缺省用 username；正文截 60 字防长帧）
//   93=在线名单增量 → 节流刷新好友快照（在线点变化推新 friends 帧）
function pipeForwardMirror(msg) {
    if (!pipes.size) return;
    var t = msg.msg_type;
    if (t === 2) {
        var text = String(msg.content || '');
        // M5.10c：通话信令/话单（{"type":"call",...}）以 type=2 下发，不是聊天文本——转发 DLL 会弹 JSON 原文 toast（实测挂断时弹话单 JSON）
        if (text.charAt(0) === '{') {
            try { if (JSON.parse(text).type === 'call') return; } catch (e) { }
        }
        var from = String(msg.from_user || '');
        var name = from;
        for (var i = 0; i < contactsCache.length; i++) {
            if (contactsCache[i].username === from) { name = contactsCache[i].name || from; break; }
        }
        // to=接收方（回显消息 from=我 → DLL 据 to 路由进对方会话；服务端回显发送方全连接）
        pipeBroadcast({ t: 'msg', from: from, to: String(msg.to_user || ''), name: name, text: text.slice(0, 60) });
    } else if (t === 93) {
        askContactsThrottled();
    }
}
function startPipeServer(pid) {
    if (!pid || WIN7 || pipes.has(pid)) return; // WIN7 硬性禁用口径一致（DLL 注入本身属 M2 且 WIN7 不注入）
    var p = { server: null, sock: null };
    var server;
    try {
        server = net.createServer(function (sock) {
            // 单连接语义：DLL 重连竞态时旧连接挤掉；服务端已收口则拒连
            if (!pipes.has(pid)) { try { sock.destroy(); } catch (e) { } return; }
            if (p.sock) { try { p.sock.destroy(); } catch (e) { } }
            p.sock = sock;
            log('[overlay] DLL 已连接: ' + pipeName(pid));
            // 热键让位不在这里（审计修复）：连接≠面板可用——启动器型进程无 D3D 设备永远到不了初始化，
            // 连接就让位会让启动器阶段 Shift+Tab 全程死键。等 DLL 'panel-ready' 帧（WndProc 钩装好）才让位
            var buf = '';
            sock.on('data', function (chunk) {
                buf += chunk;
                var idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                    var line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (line) {
                        try { onPipeFrame(pid, line); } catch (e) { log('[overlay] 上行帧处理异常: ' + e.message); }
                        try { log('[overlay] DLL 帧(pid=' + pid + '): ' + line.slice(0, 120)); } catch (e) { }
                    }
                }
                if (buf.length > 262144) { try { sock.destroy(); } catch (e) { } } // 单行超限=协议错，断开等 DLL 重连（M5.8 头像帧 ~12KB 放宽）
            });
            var gone = function () {
                if (p.sock !== sock) return; // 已被重连的新连接顶替：热键归属归新连接管，不得误收回
                p.sock = null;
                log('[overlay] DLL 断开: ' + pipeName(pid));
                nativePanelOpen = false; // 二轮审计修复：DLL 崩溃时若面板开着，让位标记必须复位（否则悬浮窗被 showOverlay 让位守卫挡住打不开）
                setNativePanelActive(false); // 审计修复：断开即收回热键（DLL 崩溃/看门狗卸载后 Shift+Tab 不能死键；
                // 活着的 DLL 3s 重连 → panel-ready 重发 → 热键再让回）
            };
            sock.on('close', gone);
            sock.on('error', gone);
            // 连接即推：握手确认 + 本端账号（回显 self 判定）+ 系统欢迎消息 + 好友快照 + 房间快照 + 兼容名单（子进程跟随）+ 热键
            pipeSend(sock, { t: 'hello-ack' });
            if (selfUname) pipeSend(sock, { t: 'me', u: selfUname });
            pipeSend(sock, { t: 'msg', from: '', name: '系统', text: '游戏内 Overlay 已连接' });
            pipeSend(sock, { t: 'friends', list: friendsFrameList() });
            pipePushHotkey(sock); // M5.7：帧内热键跟随设置
            avatarSent = {}; // M5.8：新 DLL 连接=全新实例，头像全量重发
            deliverAvatarsToPipes(sock); // M5.8：缓存头像直发（未下载的由联系人快照触发）
            var ng = nativeGamesLoad();
            pipeSend(sock, { t: 'follow', mode: ng.mode, list: ng.list });
            queryRoomSnapshot(function (snap) {
                if (p.sock === sock) pipeSend(sock, { t: 'room', room: roomFrameFromSnap(snap) });
            });
        });
    } catch (e) { log('[overlay] pipe 服务端创建失败(pid=' + pid + '): ' + e.message); return; }
    server.on('error', function (err) {
        log('[overlay] pipe 服务端异常(pid=' + pid + '): ' + err.message);
        if (pipes.get(pid) === p) pipes.delete(pid);
        try { server.close(); } catch (e2) { }
    });
    server.listen(pipeName(pid), function () {
        log('[overlay] pipe 就绪: ' + pipeName(pid));
        askContacts(); // 预热快照：DLL 连接时即有数据可推
    });
    p.server = server;
    pipes.set(pid, p);
}
function stopPipeServer(pid) {
    var p = pipes.get(pid);
    if (!p) return;
    pipes.delete(pid);
    nativePanelOpen = false; // 面板随 pipe 断开重置（悬浮窗热键恢复）
    setNativePanelActive(false); // 热键收回：悬浮窗兜底重新可用（DLL 死亡/看门狗卸载/游戏退出）
    if (p.sock) { try { p.sock.destroy(); } catch (e) { } }
    try { p.server.close(); } catch (e) { }
    log('[overlay] pipe 关闭: ' + pipeName(pid));
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
    if (nativePanelOpen) return; // M4：DLL 注入式面板呼出中——悬浮窗让位防叠加（Shift+Tab 此时由 DLL 接管）
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
    if (nativePanelActive) return; // 审计修复：DLL 面板就绪期热键已让位——设置改键位/重挂等路径不得抢回（等 DLL 断开时 setNativePanelActive(false) 再按新键位注册）
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
    startPipeServer(pid); // 二期 M1：注入式 Overlay 下行通道（每实例一条 pipe，游戏退出即关）
    armHotkey();
}
function onGameExit(key) {
    var g = games.get(key);
    games.delete(key);
    if (g && g.pid) stopPipeServer(g.pid); // pipe 断连 → DLL 看门狗感知自卸载
    if (!games.size) latestPid = 0;
    disarmHotkey();
}
// M2 注入链：包装器（injector --launch）回读真实游戏 pid 后校正（helper pid → 游戏 pid；
// pipe 名依赖真实 pid。游戏已退出/重复校正/无效 pid 均幂等跳过）
function onGamePid(key, pid) {
    var g = games.get(key);
    if (!g || !pid || g.pid === pid) return;
    stopPipeServer(g.pid);
    g.pid = pid;
    latestPid = pid;
    startPipeServer(pid);
    log('[overlay] 游戏 pid 校正: ' + key + ' → ' + pid);
}
// M2 注入链判据（main.js spawn 处调用）：native 开关 + WIN7 门禁 + 兼容名单（M4）。
// 兼容等级 = 本地名单起步（设计 §3.3，服务端零改动）：名单内游戏走注入链（游戏帧内渲染），
// 名单外走一期悬浮窗；用户可编辑名单文件把 mode 改为 "all" 全量注入（未知游戏兼容风险自担——
// 注入失败自动回退一期悬浮窗，不会拖死游戏）。
// 二进制定位：打包态 extraResources 分发于 resources/overlay-native/bin（惯例同 dlbt-host），
// 开发态为源码目录；名单文件用户可编辑副本在 userData/overlay-native-games.json（优先），
// 否则读分发模板（asar 内/extraResources 均只读可读）。
var nativeBinDirCache = null;
function nativeBinDir() {
    if (nativeBinDirCache) return nativeBinDirCache;
    var dev = path.join(__dirname, 'overlay-native', 'bin');
    if (app.isPackaged && process.resourcesPath) {
        var p = path.join(process.resourcesPath, 'overlay-native', 'bin');
        nativeBinDirCache = fs.existsSync(p) ? p : dev; // 打包产物缺资源时回退开发路径（便于本地直跑排查）
    } else {
        nativeBinDirCache = dev;
    }
    return nativeBinDirCache;
}
var nativeGames = null;      // 名单缓存 {mode:'list'|'all', list:[exeName]}；null=未加载
var NATIVE_GAMES_LIST_TMPL = 'overlay-native' + path.sep + 'native-games.json'; // 分发模板相对路径
function nativeGamesUserFile() { return path.join(app.getPath('userData'), 'overlay-native-games.json'); }
function nativeGamesParse(s) {
    if (!s || typeof s !== 'object') return { mode: 'list', list: [] };
    return {
        mode: s.mode === 'all' ? 'all' : 'list',
        list: Array.isArray(s.list) ? s.list.map(function (x) { return String(x || '').toLowerCase(); }) : []
    };
}
function nativeGamesLoad() {
    if (nativeGames) return nativeGames;
    // 读序：userData 用户可编辑副本（打包后 resources 只读）→ 分发模板（extraResources / 开发态源文件 / asar 内均 fs 可读）
    try {
        nativeGames = nativeGamesParse(JSON.parse(fs.readFileSync(nativeGamesUserFile(), 'utf8')));
    } catch (e1) {
        try {
            nativeGames = nativeGamesParse(JSON.parse(fs.readFileSync(path.join(__dirname, NATIVE_GAMES_LIST_TMPL), 'utf8')));
        } catch (e2) {
            try {
                if (app.isPackaged && process.resourcesPath) {
                    nativeGames = nativeGamesParse(JSON.parse(fs.readFileSync(path.join(process.resourcesPath, NATIVE_GAMES_LIST_TMPL.replace(/\\/g, '/')), 'utf8')));
                } else nativeGames = { mode: 'list', list: [] };
            } catch (e3) {
                nativeGames = { mode: 'list', list: [] }; // 名单缺失/损坏：保守全走悬浮窗
            }
        }
    }
    return nativeGames;
}
function isNativeActive(exe) {
    if (WIN7 || settings.native !== true) return false;
    if (!exe) return true; // 无 exe 上下文：仅门禁判定（旧调用口径）
    var ng = nativeGamesLoad();
    if (ng.mode === 'all') return true;
    var name = String(path.basename(exe) || '').toLowerCase();
    return ng.list.indexOf(name) >= 0;
}

// ===== IPC 注册（main.js init 时调用一次）=====
var onWindowCreated = null; // init 注入：悬浮窗创建回调（main.js 用来把窗口加入 gn 中继订阅表）
function init(opts) {
    opts = opts || {};
    serverUrl = opts.serverUrl || serverUrl;
    logger = opts.log || logger;
    onWindowCreated = opts.onWindowCreated || null;
    getMainWindow = opts.getMainWindow || null; // 二期 M1：askContacts 需向主窗口发 gn:contacts-need
    getGameStoreWin = opts.getGameStoreWin || null; // 二期 M2：房间快照查询（房间态唯一持有者）
    settingsLoad();

    ipcMain.on('overlay:toggle', function () { try { toggleOverlay(); } catch (e) { log('[overlay] toggle 异常: ' + e.message); } });
    ipcMain.on('overlay:hide', function () { try { hideOverlay(true); } catch (e) { log('[overlay] hide 异常: ' + e.message); } }); // 渲染层 Esc/×/点遮罩：收起+还焦点
    ipcMain.handle('overlay:settings-get', function () {
        // supported=false（WIN7）：设置页据此隐藏整个「游戏」分类（透明窗能力缺失，功能硬性禁用）
        return { enabled: WIN7 ? false : settings.enabled, notify: WIN7 ? false : settings.notify, native: WIN7 ? false : settings.native, hotkey: settings.hotkey, hotkeyOk: hotkeyOk, armed: hotkeyArmed, supported: !WIN7 };
    });
    ipcMain.on('overlay:settings-set', function (e, s) {
        try {
            s = s || {};
            if (WIN7) { broadcastState(); return; } // WIN7 硬性禁用：设置可存但功能保持关闭
            var notifyChanged = false;
            if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
            if (typeof s.notify === 'boolean' && s.notify !== settings.notify) { settings.notify = s.notify; notifyChanged = true; }
            if (typeof s.native === 'boolean') settings.native = s.native; // 注入链读取时机在启动处，无需动态生效
            if (typeof s.hotkey === 'string' && s.hotkey.trim()) settings.hotkey = s.hotkey.trim();
            settingsSave();
            pipeBroadcast(Object.assign({ t: 'hotkey' }, hotkeyToVk(settings.hotkey))); // M5.7：帧内热键实时跟随
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
            if (nativePanelActive) return; // M5.5：帧内渲染生效期通知由 DLL 帧内 toast 承接，屏外通知窗停用
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
    bufferChatMirror: safe(bufferChatMirror), // main.js gn:chat-mirror 处调用：通知窗冷启动镜像缓存（§十）+ M1 pipe 转发
    onContactsReply: safe(onContactsReply),   // main.js gn:contacts-reply 处调用：好友快照应答（M2 增 u=本端账号）
    onRoomReply: safe(onRoomReply),           // main.js overlay:room-reply 处调用：M2 房间快照应答（'or' 前缀分流）
    onGnSignal: safe(onGnSignal),             // main.js gn:signal-recv 处调用：109 → M2 房间快照节流刷新
    onGamePid: safe(onGamePid),               // main.js 注入链回读真实 pid 后校正（helper pid → 游戏 pid）
    isNativeActive: isNativeActive,           // main.js spawn 处判据：二期注入链是否启用（WIN7/native/兼容名单三重门禁）
    nativeBinDir: nativeBinDir,               // main.js 注入链二进制目录（打包态 resources，开发态源码目录）
    isOpen: function () { return !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()); }
};
