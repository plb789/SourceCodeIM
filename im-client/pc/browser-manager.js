// browser-manager.js — 阶段九十三：内置浏览器管理器（TRAE CN 同款浏览区，webview DOM 承载）
//
// 职责：
//   1. 浏览区面板：渲染层自绘面板（标签栏/地址栏/内容区），主进程归口标签状态并推送（browser:state）
//   2. 多标签页：file 标签由主页面同源 iframe 承载（阶段九十二）；web 标签由主页面 <webview> 承载
//      （阶段九十三，真 Chromium 内核但是 DOM 元素，与 file iframe 同层级）——工具提示/弹窗遮罩/
//      分隔线/控制台等页面 DOM 恢复最高层级，不再被原生 BrowserView 层遮挡
//   3. Agent 工具直调（与 agent-executor.js 同在主进程，免二次 IPC）：browser_navigate/snapshot/
//      click/input/screenshot/eval/tabs/close——服务端注入 schema、审批分级，经 msg 50/51 链路下发；
//      webview 宿主 webContents 经 webContents.fromId(tab.wcId) 直达（渲染层 dom-ready 上报）
//   4. CDP 远程调试端口开关（Chrome DevTools Protocol，OpenClaw/TraeClaw 控制-trae 同款）：
//      默认关闭；agent_browser.json 配置 cdp_port 后任何本机 CDP 客户端可附加窗口读页/执行 JS
//
// 安全边界：
//   - URL 仅放行 http/https（file/javascript/data 等协议拒绝；服务端注入前亦快检一道）
//   - 页面 window.open 一律转应用内新标签页（webview 挂 allowpopups 后经 setWindowOpenHandler
//     deny 弹窗并归口建标签）；权限请求（定位/通知/摄像头等）默认拒绝；webview 以 partition+
//     webpreferences 属性锁定（contextIsolation+sandbox，无 node 能力）
//   - UA 去除 Electron 标记（降低站点反爬误拦截）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, ipcMain, session, webContents, shell } = require('electron');
const lspManager = require('./lsp-manager.js'); // 阶段一百三十：本地 LSP 悬停（gopls/clangd/pyright 真实类型推导）

// ===== 模块状态 =====
let mainWindow = null;       // 主窗口引用（init 时注入）
let panelVisible = false;    // 浏览区面板显隐
let activeId = null;         // 活动标签页 id
let seq = 0;                 // tab_id 序号
let cdpPort = 0;             // CDP 调试端口（0=关闭；仅配置文件读取，运行中改配置需重启生效）
// 标签页：[{id, wcId, queuedNav, title, url, loading, kind:'web'|'file', relPath, filePath,
//          username, dirty, lastPayload, favicon, dataKind, dataKey}]
// wcId：web 标签 webview 宿主 webContents id（渲染层 dom-ready 上报，0=未就绪）
// queuedNav：webview 未就绪时暂存的 goto 地址（wv-ready 后补发）
const tabs = [];

// 快照参数：可交互元素采集上限与回传字符上限（防超长页面撑爆模型上下文）
const SNAPSHOT_MAX_ELEMENTS = 120;
const SNAPSHOT_MAX_CHARS = 12000;

// ===== 阶段九十二：内部文件查看标签（file kind） =====
// 工作区文件/diff/审查报告统一在浏览区标签打开（TRAE CN 归一）。file 标签加载服务端同源
// viewer 页（SERVER_URL + file-viewer.html），由主页面 iframe 承载；文本读取上限对齐
// agent-executor WS_FILE_READ_MAX(512KB)，二进制上限对齐 fileReadB64Level(2MB)
const TEXT_MAX = 512 * 1024;
const BIN_MAX = 2 * 1024 * 1024;
// 二进制扩展名清单（命中即走 base64 通道；未命中再查 NUL 字节兜底）
const BINARY_EXTS = ['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'class', 'jar', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'wav', 'flac', 'mp4', 'avi', 'mov', 'mkv', 'psd', 'ai', 'sketch', 'apk'];
let pathGuard = null;  // main.js 注入 agentExecutor.safePath（browser-manager 不可反向 require，防循环依赖）
let taskBackupApi = null; // 阶段九十七：main.js 注入任务备份查询/保留/撤销（agentExecutor.getTaskBackup 等）
let viewerUrl = '';    // main.js 注入 SERVER_URL + 'file-viewer.html'

// 配置文件：userData/agent_browser.json（{cdp_port: 0}；0=关闭 CDP 端口）
const cfgFile = () => path.join(app.getPath('userData'), 'agent_browser.json');

function cfgRead() {
    try {
        const v = JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) { /* 首次无配置 */ }
    return {};
}

function cfgSave(cfg) {
    try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* 只读盘等异常静默 */ }
}

// ===== 阶段一百三十八：浏览区状态持久化（2026-09-17 用户反馈"浏览区开着且有文件预览，
// 退出客户端重新登录后浏览区消失，必须手动重开"） =====
// 根因：panelVisible/tabs 均为主进程内存态，进程退出即丢，重启后内存默认收起且标签清空。
// 现结构化状态随每次 statePush 落盘 userData/browser-panel.json，窗口首帧加载完成后恢复：
//   - 面板显隐：按落盘值还原
//   - web 标签：按 URL 重建（网页重新加载，登录态由 persist:agent-browser 持久分区保留）
//   - 磁盘文件标签：按 用户名+相对路径 走 openFileTab 既有链路重读盘最新内容
//   - diff/审查报告等直传数据标签（dataKey）：内容为内存派生态无法忠实重建，不恢复（重开即可）
//   - 未保存的编辑（dirty）随重启丢弃，恢复为磁盘最新内容（宁丢编辑不写脏数据）
const stateFile = () => path.join(app.getPath('userData'), 'browser-panel.json');
let restoring = false;        // 恢复期标记：openFileTab 跳过 setPanel(true) 强制开面板（显隐以落盘值为准）+ persistState 暂停落盘（防中间态覆盖）
let stateRestored = false;    // 是否已完成过落盘状态恢复（幂等守卫：did-finish-load 与沙箱就绪通知双入口）
let restorePending = [];      // 恢复失败的 file 标签键（多为沙箱未注入导致路径解析失败）——登录后沙箱就绪时重试，落盘时并入防丢

// tabRestoreKey 标签的可恢复身份键（落盘与恢复匹配共用）：web=URL；磁盘文件=用户名+相对路径；
// 空白页/直传数据标签返回空（不落盘不恢复）
function tabRestoreKey(t) {
    if (!t) return '';
    if (t.kind === 'web') return (t.url && t.url !== 'about:blank') ? ('web|' + t.url) : '';
    if (t.kind === 'file' && t.username && t.relPath && !t.dataKey) return 'file|' + t.username + '|' + t.relPath;
    return '';
}

// persistState 浏览区结构化状态落盘（statePush 尾部调用，数据量小：每标签一条短键）
function persistState() {
    if (restoring) return; // 阶段一百三十八修复：恢复期不落盘——实测 2026-09-17 恢复失败时（空标签+兜底空白页）
                           // statePush 会把空态写回覆盖原完整落盘，标签数据彻底丢失（浏览区在、标签没了）
    const list = tabs.map(tabRestoreKey).filter(function (k) { return !!k; });
    // 待重试项并入落盘：恢复失败的标签不因落盘刷新而丢失（沙箱就绪后重试，见 notifySandboxReady）
    restorePending.forEach(function (k) { if (list.indexOf(k) < 0) list.push(k); });
    const act = tabs.find(function (t) { return t.id === activeId; });
    try {
        fs.writeFileSync(stateFile(), JSON.stringify({
            visible: panelVisible,
            active_key: tabRestoreKey(act),
            tabs: list
        }), 'utf8');
    } catch (e) { /* 只读盘等异常静默（不影响浏览区功能） */ }
}

// restoreSavedState 恢复落盘状态（init 的 did-finish-load 首次触发时调用，幂等）。
// web 标签直接建标签（statePush 后渲染层按 URL 建 webview）；文件标签逐个 openFileTab 重读盘
// （payload 未就绪时渲染层 pending 暂存，既有链路无缝衔接）；最后按 active_key 纠正活动标签
// （openFileTab 逐个激活会停在最后一个，须回置为退出时的活动页）。
// 阶段一百三十八修复：此时尚未登录，用户自选工作区（沙箱 primary）未注入执行器，相对路径
// 被解析到默认工作区导致 file 恢复失败——失败项记入 restorePending 待重试（登录后沙箱就绪
// 时由 notifySandboxReady 重试），不再静默丢失
function restoreSavedState() {
    if (stateRestored) return; // 幂等：did-finish-load 与沙箱就绪通知双入口，只恢复一次
    stateRestored = true;
    let saved = null;
    try {
        const v = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        if (v && typeof v === 'object' && Array.isArray(v.tabs)) saved = v;
    } catch (e) { /* 首次无持久化文件或损坏：按无状态处理 */ }
    if (!saved) return;
    panelVisible = !!saved.visible;
    restoring = true;
    try {
        saved.tabs.forEach(function (key) {
            if (typeof key !== 'string' || !key) return;
            if (key.indexOf('web|') === 0) {
                const u = key.slice(4);
                if (urlAllowed(u)) createTab(u, false);
            } else if (key.indexOf('file|') === 0) {
                const rest = key.slice(5);
                const sep = rest.indexOf('|');
                if (sep > 0) {
                    const r = openFileTab(rest.slice(0, sep), rest.slice(sep + 1)); // 重读盘最新内容
                    if (!r || !r.ok) restorePending.push(key); // 失败（沙箱未注入/文件缺失）：待重试不丢标签
                }
            }
        });
        if (typeof saved.active_key === 'string' && saved.active_key) {
            const act = tabs.find(function (t) { return tabRestoreKey(t) === saved.active_key; });
            if (act) activeId = act.id;
        }
    } finally {
        restoring = false;
    }
    // 面板按落盘值是开的但没有任何可显示标签（既无恢复成功的标签也无待重试项）：
    // 视为面板收起——原实现补一张空白页占位，实测 2026-09-17 用户反馈"聊天区变窄右边空一半"
    // （about:blank 白页撑住右侧半屏，观感即空白）。收起后聊天区恢复全宽，下次用户打开
    // 浏览区时由 setPanel(true) 常规补空白页（空白页不入落盘清单，状态自洽）
    if (panelVisible && tabs.length === 0 && restorePending.length === 0) panelVisible = false;
    statePush(); // 恢复完成统一推送一次（此时 restoring 已复位，persistState 随尾部落盘含待重试项）
}

// notifySandboxReady 沙箱就绪通知（main.js 在渲染层登录后首次 sandbox:get 时调用）：
// 重试 restorePending 里恢复失败的 file 标签——此时该用户自选工作区已注入执行器，
// 相对路径可正确解析到原工作区，标签得以恢复；仍失败（文件被删等）保留待下次
function notifySandboxReady(username) {
    if (!stateRestored) { restoreSavedState(); return; } // 页面尚未走完恢复（理论不达）：先全量恢复
    if (!restorePending.length) return;
    const retry = restorePending.slice();
    restorePending = [];
    restoring = true; // 重试同属恢复期：不强制开面板、不中途落盘
    try {
        retry.forEach(function (key) {
            if (typeof key !== 'string' || key.indexOf('file|') !== 0) return;
            const rest = key.slice(5);
            const sep = rest.indexOf('|');
            const u = sep > 0 ? rest.slice(0, sep) : '';
            if (!u || (username && u !== String(username))) { restorePending.push(key); return; } // 非当前登录用户：沙箱未注入，留待其后
            const r = openFileTab(u, sep > 0 ? rest.slice(sep + 1) : '');
            if (!r || !r.ok) restorePending.push(key); // 仍失败：保留待重试（落盘时并入，不丢标签）
        });
    } finally {
        restoring = false;
    }
    statePush(); // 推送恢复结果（persistState 随尾部落盘，待重试项并入）
}

// setCdpSwitch 阶段九十一：CDP 远程调试端口启动参数（必须在 app ready 前调用——
// Chromium 仅在启动时读取 remote-debugging-port）。端口绑 127.0.0.1（Chromium 默认行为），
// 开启后等同任何本机进程可完全控制客户端，配置注释需提示风险
function setCdpSwitch() {
    const port = parseInt((cfgRead() || {}).cdp_port, 10);
    if (port > 0 && port < 65536) {
        cdpPort = port;
        app.commandLine.appendSwitch('remote-debugging-port', String(port));
    }
}

// ===== 标签页管理 =====

// browserSession 标签页共用会话（持久分区：登录态/Cookie 跨会话保留，与主窗口会话隔离——
// 浏览区里的站点无法触碰客户端自身的登录凭据）。init 时调用一次挂 UA/权限钩子（幂等），
// webview 以 partition 属性复用同一分区会话
function browserSession() {
    const ses = session.fromPartition('persist:agent-browser');
    // UA 去 Electron 标记（一次性设置；重复调用幂等）
    const ua = ses.getUserAgent();
    if (/Electron\/[\d.]+/i.test(ua)) {
        ses.setUserAgent(ua.replace(/\s*Electron\/[\d.]+/i, ''));
    }
    // 权限请求默认拒绝（定位/通知/摄像头/麦克风/剪贴板读等——浏览网页不需要授权这些敏感能力）
    if (!ses.__permHooked) {
        ses.setPermissionRequestHandler(function (wc, permission, callback) {
            callback(false);
        });
        ses.__permHooked = true;
    }
    return ses;
}

// urlAllowed 协议白名单（与 服务端 agentBrowserURLAllowed 同口径；javascript: 可绕过
// 地址栏直达页面脚本执行，必须双重拦截）
function urlAllowed(raw) {
    const u = String(raw || '').trim().toLowerCase();
    return u.indexOf('http://') === 0 || u.indexOf('https://') === 0;
}

// createTab 新建标签页（url 可空=空白页 about:blank；kind 'web'|'file'）。
// 阶段九十三（全 DOM 化）：主进程不再创建任何原生视图——file 标签由主页面 iframe 承载，
// web 标签由主页面 <webview> 承载（渲染层按 state 建/删/显隐）；主进程只归口状态并经
// wcId（dom-ready 上报）直达 webview 宿主 webContents 执行导航与 Agent 工具
function createTab(url, activate, kind) {
    const isFile = kind === 'file';
    const tab = {
        id: 't' + (++seq),
        wcId: 0, queuedNav: '',
        title: isFile ? '文件预览' : '新标签页',
        url: isFile ? '' : (url || 'about:blank'),
        loading: false,
        kind: isFile ? 'file' : 'web',
        relPath: '', filePath: '', username: '', dirty: false, lastPayload: null,
        favicon: '', dataKind: '', dataKey: '' // favicon（web）；dataKind/dataKey（file 直传内容标签）
    };
    tabs.push(tab);
    if (activate !== false) activeId = tab.id;
    return tab;
}

// wcOf 取 web 标签的宿主 webContents（webview 未就绪/已销毁返回 null；file 标签恒 null）
function wcOf(tab) {
    if (!tab || tab.kind !== 'web' || !tab.wcId) return null;
    try { return webContents.fromId(tab.wcId); } catch (e) { return null; }
}

// wcFor 等待 web 标签 webview 就绪（渲染层建框→dom-ready→上报 wcId；轮询 wcId 直到可取）
function wcFor(tab, timeoutMs) {
    return new Promise(function (resolve) {
        const wc = wcOf(tab);
        if (wc && !wc.isDestroyed()) { resolve(wc); return; }
        const t0 = Date.now();
        const timer = setInterval(function () {
            const w = wcOf(tab);
            if (w && !w.isDestroyed()) {
                clearInterval(timer);
                resolve(w);
            } else if (Date.now() - t0 > (timeoutMs || 10000)) {
                clearInterval(timer);
                resolve(null);
            }
        }, 100);
    });
}

// attachWebContents 挂接 webview 宿主 webContents 事件（wv-ready 时调用；幂等——同一
// wcId 重复上报只挂一次；guest 崩溃重建产生新 id 时重新挂接）。事件归口 → statePush 驱动
// 渲染层标签栏/地址栏刷新（与旧 BrowserView 时代同一套监听，仅载体改为 fromId 直达）
// GUEST_SCROLLBAR_CSS 浏览区 guest 页面注入的主题化滚动条样式——第三方网站默认白条与应用暗色
// 主题冲突（应用 UI 滚动条已自绘，网页内容区由内核渲染）；8px 圆角半透明与主界面滑块同风格。
// insertCSS 属 DevTools 级 API 不受站点 CSP 限制；样式仅对当前文档有效，导航后需重新注入
const GUEST_SCROLLBAR_CSS =
    '::-webkit-scrollbar { width: 8px; height: 8px; }' +
    '::-webkit-scrollbar-track { background: transparent; }' +
    '::-webkit-scrollbar-thumb { background: rgba(138,138,138,0.45); border-radius: 4px; }' +
    '::-webkit-scrollbar-thumb:hover { background: rgba(138,138,138,0.7); }' +
    '::-webkit-scrollbar-corner { background: transparent; }';

// injectGuestScrollbarCss 向 guest 主框架注入滚动条样式（user origin 高于网站作者样式，稳定覆盖）
function injectGuestScrollbarCss(wc) {
    if (!wc || wc.isDestroyed()) return;
    wc.insertCSS(GUEST_SCROLLBAR_CSS, { cssOrigin: 'user' }).catch(function () { /* 页面销毁竞态静默 */ });
}

function attachWebContents(tab, wc) {
    if (!tab || !wc || wc.isDestroyed()) return;
    if (tab.__hookedId === tab.wcId) return;
    tab.__hookedId = tab.wcId;
    // 页面 window.open / target=_blank：转应用内新标签页（http/https 才放行；deny 阻断弹窗本身）
    wc.setWindowOpenHandler(function (details) {
        if (urlAllowed(details.url)) {
            createTab(details.url, true); // 前台激活：点链接直接看新页（TRAE 同款）
            statePush(); // 立即推送——createTab 只改主进程状态不推送，缺此步渲染层无感知（点链接"无反应"，点任意标签后才刷出新标签）
        }
        return { action: 'deny' };
    });
    wc.on('page-title-updated', function (e, title) {
        tab.title = String(title || tab.title);
        statePush();
    });
    wc.on('did-start-loading', function () { tab.loading = true; statePush(); });
    wc.on('did-stop-loading', function () {
        tab.loading = false;
        if (!wc.isDestroyed()) {
            tab.url = wc.getURL();
            tab.title = wc.getTitle() || tab.title;
        }
        statePush();
    });
    wc.on('did-navigate', function (e, u) { tab.url = u; statePush(); injectGuestScrollbarCss(wc); }); // 导航后样式失效需重注
    wc.on('did-navigate-in-page', function (e, u) { tab.url = u; statePush(); });
    wc.on('dom-ready', function () { injectGuestScrollbarCss(wc); }); // 首次就绪注入
    // web 标签采集站点 favicon（TRAE 同款标签图标；file 标签用扩展名徽标不走这里）
    wc.on('page-favicon-updated', function (e, icons) {
        const fav = (icons && icons.length) ? String(icons[0] || '') : '';
        if (fav !== tab.favicon) { tab.favicon = fav; statePush(); }
    });
}

// fileLoadPush 把 file 标签 payload 推给渲染层（DOM viewer iframe 首载/刷新内容；
// iframe 未就绪时渲染层暂存 pending，load 后补投）
function fileLoadPush(tab) {
    if (!mainWindow || mainWindow.isDestroyed() || !tab || tab.kind !== 'file' || !tab.lastPayload) return;
    mainWindow.webContents.send('browser:file-load', { tab_id: tab.id, payload: tab.lastPayload });
}

// setTabCloseHook 注入 file 标签关闭钩子（main.js 传入 debug-manager 联动；防循环依赖不直接 require）
let tabCloseHook = null;
function setTabCloseHook(fn) { tabCloseHook = typeof fn === 'function' ? fn : null; }

// destroyTab 关闭并销毁标签页（file/web 均无原生视图：仅清状态，渲染层经 statePush
// 移除对应 iframe/webview 元素，元素移除即销毁 guest）
function destroyTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
    // 阶段一百五十九：file 标签关闭钩子（main.js 注入）——被调试文件标签关闭时联动停止调试会话
    if (tab.kind === 'file' && tabCloseHook) {
        try { tabCloseHook(tab.id); } catch (e) { /* 钩子异常不阻断关标签 */ }
    }
}

// activeTab 当前活动标签页
function activeTab() {
    for (const t of tabs) if (t.id === activeId) return t;
    return tabs[tabs.length - 1] || null;
}

// statePush 推送浏览区状态到渲染层（tab 栏/地址栏/导航态归口渲染；渲染层按状态建/删/显隐
// iframe 与 webview 元素，尺寸完全由 CSS 布局驱动，主进程不再管理 bounds）
function statePush() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const tab = activeTab();
    const isFileTab = !!(tab && tab.kind === 'file');
    let canBack = false, canForward = false;
    const wc = wcOf(tab);
    if (wc && !wc.isDestroyed()) {
        try { canBack = wc.canGoBack(); canForward = wc.canGoForward(); } catch (e) { /* 已销毁 */ }
    }
    mainWindow.webContents.send('browser:state', {
        visible: panelVisible,
        tabs: tabs.map(function (t) {
            return {
                id: t.id, title: t.title, url: t.url, loading: t.loading,
                kind: t.kind || 'web',
                file_name: t.kind === 'file' ? (t.relPath || t.title) : '',
                file_path: t.kind === 'file' ? (t.filePath || '') : '', // 阶段九十四：绝对路径（悬停 tooltip + 打开所在目录）
                ext: t.kind === 'file' && t.relPath ? path.extname(t.relPath).replace('.', '').toLowerCase() : '',
                data_kind: t.kind === 'file' ? (t.dataKind || '') : '',
                data_key: t.kind === 'file' ? (t.dataKey || '') : '', // 直传标签键（diff:<path> 等）：渲染层按键识别已开标签（放弃修改后原位刷新工作树 diff）
                favicon: t.kind === 'web' ? (t.favicon || '') : '',
                dirty: !!t.dirty,
                pinned: !!t.pinned
            };
        }),
        active_id: tab ? tab.id : null,
        // file 标签地址栏显示工作区相对路径（只读），网页标签显示 URL
        url: tab ? (isFileTab ? (tab.relPath || tab.title) : tab.url) : '',
        title: tab ? tab.title : '',
        loading: tab ? tab.loading : false,
        kind: tab ? (tab.kind || 'web') : 'web',
        can_back: canBack,
        can_forward: canForward,
        cdp_port: cdpPort
    });
    persistState(); // 阶段一百三十八：状态变更即落盘（statePush 是所有状态变更的统一出口）
}

// ===== 面板显隐与用户操作（渲染层 IPC 入口在 init 注册） =====

function setPanel(visible) {
    panelVisible = !!visible;
    if (panelVisible && tabs.length === 0) createTab('about:blank', true);
    statePush(); // 渲染层按状态显隐面板并同步 iframe/webview 元素（显隐即布局，无需主进程排版）
}

// selectTab 切换活动标签页（渲染层点击 tab / Agent browser_tabs select 共用）
function selectTab(tabId) {
    const tab = tabs.find(function (t) { return t.id === String(tabId || ''); });
    if (!tab) return false;
    activeId = tab.id;
    refreshFileTab(tab); // 阶段一百六十二：切回 file 标签时感知外部变更（AI 任务/命令改盘），变了即原位重推
    statePush();
    return true;
}

// ===== 阶段一百六十二：文件外部变更感知刷新（TRAE CN 同款语义） =====
// AI 任务期间文件可能经编辑工具或 shell 命令（git checkout 等）被改动磁盘——已打开的 file 标签
// 内容仍停在打开时刻。归口此处读盘比对，变了则原位重推（viewer 同 tab_id 静默重绘，滚动/悬停保持）。
// 有未保存编辑（dirty）的标签不覆盖（不动用户工作区）；直传标签（diff/md/text）无磁盘文件跳过
function refreshFileTab(t, info) {
    if (!t || t.kind !== 'file' || !t.username || !t.relPath || t.dataKey || t.dirty) return false;
    const r = readFilePayload(t.username, t.relPath);
    if (!r.ok) return false;
    const fresh = Object.assign(r.payload, { tab_id: t.id });
    const old = t.lastPayload || {};
    if (fresh.content === old.content && (fresh.b64 || '') === (old.b64 || '')) return false; // 磁盘未变
    t.title = fresh.name;
    t.filePath = r.abs;
    t.lastPayload = fresh;
    // 阶段一百六十二：活动标签 + AI 写盘钩子带行号 → 推送副本携带跳转定位（TRAE CN 同款：编辑完成即跳改动行
    // + 闪烁高亮）。reveal_line 只进推送副本不进 lastPayload——防持久化/恢复重放时残留重复跳转
    const line = info && parseInt(info.line, 10) > 0 ? parseInt(info.line, 10) : 0;
    if (line > 0 && t.id === activeId) {
        fileLoadPush({ id: t.id, kind: 'file', lastPayload: Object.assign({}, fresh, { reveal_line: line }) });
    } else {
        fileLoadPush(t); // 后台标签静默刷新（切回时 gutter 红蓝绿色条已就位，不抢滚动位置）
    }
    return true;
}
// refreshFileTabByPath 按磁盘绝对路径刷新匹配的已打开标签（agent-executor 写盘钩子归口；
// 路径归一同备份索引：分隔符/大小写不敏感，Windows NTFS 不区分）
function refreshFileTabByPath(fullPath, info) {
    const key = String(fullPath || '').replace(/\\/g, '/').toLowerCase();
    let n = 0;
    tabs.forEach(function (t) {
        if (t.kind === 'file' && String(t.filePath || '').replace(/\\/g, '/').toLowerCase() === key) {
            if (refreshFileTab(t, info)) n++;
        }
    });
    if (n) statePush();
    // 阶段一百六十二闭环：通知渲染层刷新已开的工作树 diff 页签（diff 内容由渲染层生成，file 标签已由
    // 上方直刷不重复）。path=工作区根相对路径（agent 写盘处自带 rel），用户手动保存（file-save 归口）
    // 同事件同口径——diff 页签跟随磁盘实际，AI 改码/手动编辑实时跟手
    const rel = info && String(info.rel || '');
    if (rel && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:file-saved', { path: rel });
    }
    return { ok: true, refreshed: n };
}
function refreshOpenFileTabs() {
    let n = 0;
    tabs.forEach(function (t) { if (refreshFileTab(t)) n++; });
    if (n) statePush();
    return { ok: true, refreshed: n };
}

// ===== 阶段九十四：标签右键菜单操作（关闭其他/右侧/全部、移动、固定切换、系统浏览器打开） =====
// 归口主进程：标签数组唯一权威在主进程，批量关闭/排序/固定在此变更后统一 statePush；
// 固定（pinned）标签防误关——不参与 close-others/close-right/close-all 批量关闭
function tabsOp(op, tabId, arg) {
    const tab = tabId ? tabs.find(function (t) { return t.id === String(tabId); }) : null;
    switch (String(op || '')) {
        case 'close-others': {
            if (!tab) return false;
            const keep = [tab.id];
            tabs.forEach(function (t) { if (t.pinned) keep.push(t.id); });
            tabs.slice().forEach(function (t) { if (keep.indexOf(t.id) < 0) destroyTab(t); });
            activeId = tab.id; // 活动页若被波及则落到保留的目标上
            statePush();
            return true;
        }
        case 'close-right': {
            if (!tab) return false;
            const i = tabs.indexOf(tab);
            tabs.slice(i + 1).forEach(function (t) { if (!t.pinned) destroyTab(t); });
            if (!activeTab()) activeId = tab.id;
            statePush();
            return true;
        }
        case 'close-all': {
            tabs.slice().forEach(function (t) { if (!t.pinned) destroyTab(t); });
            if (tabs.length === 0) { activeId = null; setPanel(false); return true; }
            if (!activeTab()) activeId = tabs[0].id;
            statePush();
            return true;
        }
        case 'move': { // arg: 'left' | 'right'，与相邻标签交换（固定标签不参与，前端禁用入口）
            if (!tab) return false;
            const i = tabs.indexOf(tab);
            const j = i + (String(arg) === 'left' ? -1 : 1);
            if (j < 0 || j >= tabs.length) return false;
            tabs.splice(i, 1);
            tabs.splice(j, 0, tab);
            statePush();
            return true;
        }
        case 'pin': { // 切换固定态（前端按当前态显示"固定/取消固定"）
            if (!tab) return false;
            tab.pinned = !tab.pinned;
            statePush();
            return true;
        }
        case 'show-in-folder': { // 阶段九十四：在文件资源管理器中显示（TRAE"打开所在目录"同款）
            if (!tab || tab.kind !== 'file' || !tab.filePath) return false;
            shell.showItemInFolder(tab.filePath);
            return true;
        }
        case 'open-external': { // 仅放行 http(s)，交给系统默认浏览器
            const u = String(arg || '');
            console.log('[browser-manager] open-external 收到地址:', JSON.stringify(u)); // 阶段九十四诊断：无反应问题实测
            if (!/^https?:\/\//i.test(u)) { console.log('[browser-manager] open-external 拒绝：非 http(s)'); return false; }
            shell.openExternal(u).catch(function (e) { console.error('[browser-manager] openExternal 失败:', e && e.message); }); // 拒绝时留痕（默认 unhandled rejection 静默）
            return true;
        }
    }
    return false;
}

// closeTab 关闭标签页（不传 id=关活动页；全部关闭自动收起面板）
function closeTab(tabId) {
    const tab = tabId ? tabs.find(function (t) { return t.id === String(tabId); }) : activeTab();
    if (!tab) return false;
    destroyTab(tab);
    if (tabs.length === 0) {
        activeId = null;
        setPanel(false);
        return true;
    }
    if (activeId === tab.id || !activeTab()) {
        activeId = tabs[tabs.length - 1].id;
    }
    statePush();
    return true;
}

// navAction 渲染层导航操作（后退/前进/刷新/停止/新建标签/地址栏回车）。
// web 标签经 wcId 直达 webContents；webview 未就绪时 goto 暂存 queuedNav（wv-ready 后补发）
function navAction(action, url) {
    const tab = activeTab();
    switch (String(action || '')) {
        case 'newtab': {
            createTab('about:blank', true);
            if (!panelVisible) setPanel(true); // 面板未展开时顺带展开（setPanel 内含状态推送）
            else statePush();
            return true;
        }
    }
    if (!tab) return false;
    if (tab.kind !== 'web') {
        // file 标签（DOM viewer）：刷新=重读磁盘最新内容重新推送渲染层
        if (String(action) === 'reload') {
            if (tab.username && tab.relPath) {
                const fresh = readFilePayload(tab.username, tab.relPath);
                if (fresh.ok) tab.lastPayload = Object.assign(fresh.payload, { tab_id: tab.id });
            }
            fileLoadPush(tab);
            return true;
        }
        return false; // 后退/前进/停止/ goto 对只读文件页无意义
    }
    const wc = wcOf(tab);
    switch (String(action || '')) {
        case 'back': if (wc && wc.canGoBack()) wc.goBack(); return true;
        case 'forward': if (wc && wc.canGoForward()) wc.goForward(); return true;
        case 'reload':
            if (wc) wc.reload();
            return true;
        case 'stop': if (wc && wc.isLoading()) wc.stop(); return true;
        case 'goto':
            if (!urlAllowed(url)) return false;
            url = String(url).trim();
            if (wc) wc.loadURL(url).catch(function () { /* 失败由 did-fail-load 状态呈现 */ });
            else tab.queuedNav = url; // webview 未就绪：暂存，wv-ready 后补发
            return true;
    }
    return false;
}

// ===== 阶段九十二：文件/内容标签打开归口（渲染层 wsOpenFile/wsOpenData 入口） =====

// hasNul 前 8KB 探 NUL 字节（扩展名未命中时的二进制兜底判定）
function hasNul(abs) {
    let fd;
    try {
        fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.slice(0, n).indexOf(0) >= 0;
    } catch (e) {
        return false;
    } finally {
        try { if (fd !== undefined) fs.closeSync(fd); } catch (e) { /* 已关闭 */ }
    }
}

// readFilePayload 读工作区文件构造 viewer payload（openFileTab 与 file 标签刷新共用）。
// 返回 {ok, payload|error}
function readFilePayload(username, relPath) {
    if (!pathGuard) return { ok: false, error: '路径校验未就绪' };
    const g = pathGuard(username, relPath); // {full, ws} | {err}
    if (g.err) return { ok: false, error: g.err };
    const abs = g.full;
    let stat;
    try { stat = fs.statSync(abs); } catch (e) {
        return { ok: false, error: '文件不存在或不可读：' + (e.message || e) };
    }
    if (!stat.isFile()) return { ok: false, error: '目标不是文件' };
    const name = path.basename(abs);
    const m = name.match(/\.([A-Za-z0-9]+)$/);
    const ext = (m ? m[1] : '').toLowerCase();
    const isBin = BINARY_EXTS.indexOf(ext) >= 0 || hasNul(abs);
    const payload = {
        v: 1, kind: 'file', path: relPath, name: name, ext: ext,
        truncated: false, editable: false
    };
    if (isBin) {
        if (stat.size > BIN_MAX) return { ok: false, error: '文件过大（超过 2MB），暂不支持预览' };
        try { payload.b64 = fs.readFileSync(abs).toString('base64'); } catch (e) {
            return { ok: false, error: '读取失败：' + (e.message || e) };
        }
        payload.mime = 'binary';
    } else {
        const truncated = stat.size > TEXT_MAX;
        let buf;
        try { buf = fs.readFileSync(abs).slice(0, TEXT_MAX); } catch (e) {
            return { ok: false, error: '读取失败：' + (e.message || e) };
        }
        // 去 BOM 后 utf8 解码；截断按字节截（多字节字符尾部截断由页面容错渲染）
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
        payload.content = buf.toString('utf8');
        payload.mime = 'text';
        payload.truncated = truncated;
        payload.editable = !truncated;
        // 阶段九十七：任务修改探测——存在任务前备份且与当前内容不同 → 携带 baseline 供红蓝 gutter/保留撤销
        if (!truncated && taskBackupApi && typeof taskBackupApi.get === 'function') {
            const tb = taskBackupApi.get(abs);
            if (tb && tb.backup) {
                let bbuf = null;
                try { bbuf = fs.readFileSync(tb.backup); } catch (e) { bbuf = null; }
                if (bbuf && bbuf.length > 0 && bbuf.length <= TEXT_MAX) {
                    if (bbuf.length >= 3 && bbuf[0] === 0xef && bbuf[1] === 0xbb && bbuf[2] === 0xbf) bbuf = bbuf.slice(3);
                    const baseline = bbuf.toString('utf8');
                    if (baseline !== payload.content) { // 内容相同（幂等写）不标记
                        payload.task_modified = true;
                        payload.baseline = baseline;
                    }
                }
            }
        }
    }
    return { ok: true, payload: payload, abs: abs };
}

// openFileTab 打开工作区文件查看标签（渲染层 browser:open-file 归口）。
// 同一文件复用既有标签：更新 payload 后刷新重注入（重开即读盘最新，与 wsPanel 行为对齐）
function openFileTab(username, relPath) {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
    if (!viewerUrl) return { ok: false, error: 'viewer 页地址未配置' };
    const u = String(username || '').trim();
    const rel = String(relPath || '').trim();
    if (!u || !rel) return { ok: false, error: '参数缺失（username/path）' };
    const r = readFilePayload(u, rel);
    if (!r.ok) return { ok: false, error: r.error };
    const existing = tabs.find(function (t) { return t.kind === 'file' && t.username === u && t.relPath === rel; });
    if (existing) {
        existing.title = r.payload.name;
        existing.filePath = r.abs;
        existing.lastPayload = Object.assign(r.payload, { tab_id: existing.id });
        activeId = existing.id;
        // 原实现：if (!panelVisible) setPanel(true); 阶段一百三十八恢复期不强制开面板（显隐以落盘值为准）
        if (!panelVisible && !restoring) setPanel(true);
        fileLoadPush(existing); // 重开即刷新：重读的最新内容重新推送 DOM viewer
        statePush();
        return { ok: true, tab_id: existing.id };
    }
    // 一个文件一个标签：不同文件各开各的标签页（同用户同相对路径复用原标签刷新内容）
    const tab = createTab(null, true, 'file');
    tab.username = u;
    tab.relPath = rel;
    tab.filePath = r.abs;
    tab.dirty = false;
    tab.title = r.payload.name;
    tab.lastPayload = Object.assign(r.payload, { tab_id: tab.id });
    // 原实现：if (!panelVisible) setPanel(true); // setPanel 内含状态推送
    // 阶段一百三十八恢复期不强制开面板（显隐以落盘值为准，恢复尾统一 statePush）
    if (!panelVisible && !restoring) setPanel(true);
    fileLoadPush(tab); // payload 推给渲染层 iframe（未就绪时渲染层暂存）
    statePush();
    return { ok: true, tab_id: tab.id };
}

// openDataTab 打开直传内容标签（git diff/提交详情/审查报告等不经磁盘的内容）。
// payload.key 相同的复用既有标签刷新（重开即刷新，对齐 wsPanel 同键行为）
function openDataTab(payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
    if (!viewerUrl) return { ok: false, error: 'viewer 页地址未配置' };
    const p = (payload && typeof payload === 'object') ? payload : {};
    const kind = ['diff', 'commit', 'md', 'text'].indexOf(p.kind) >= 0 ? p.kind : 'text';
    const title = String(p.title || '查看').slice(0, 100);
    const content = String(p.content != null ? p.content : '');
    if (content.length > BIN_MAX) return { ok: false, error: '内容过大（超过 2MB），暂不支持查看' };
    const dataKey = String(p.key || '');
    const build = function (tabId) {
        return { v: 1, kind: kind, tab_id: tabId, title: title, content: content, meta: p.meta || null, mime: 'text', editable: false, name: title };
    };
    if (dataKey) {
        const exist = tabs.find(function (t) { return t.kind === 'file' && t.dataKey === dataKey; });
        if (exist) {
            exist.title = title;
            exist.dataKind = kind;
            // diff 标签补 relPath：地址栏面包屑按真实路径分段（port_relay › 文件名），与文件浏览同款
            if (kind === 'diff' && p.meta && p.meta.path) exist.relPath = String(p.meta.path);
            exist.lastPayload = build(exist.id);
            activeId = exist.id;
            if (!panelVisible) setPanel(true);
            fileLoadPush(exist); // 重开即刷新：最新内容重新推送 DOM viewer
            statePush();
            return { ok: true, tab_id: exist.id };
        }
    }
    // 一个内容一个标签（key 相同的复用既有标签刷新，对齐 wsPanel 同键行为）
    const tab = createTab(null, true, 'file');
    tab.dataKey = dataKey;
    tab.dataKind = kind; // 渲染层标签图标用（diff/commit/md/text）
    // diff 标签补 relPath：地址栏面包屑按真实路径分段（port_relay › 文件名），与文件浏览同款
    if (kind === 'diff' && p.meta && p.meta.path) tab.relPath = String(p.meta.path);
    tab.title = title;
    tab.lastPayload = build(tab.id);
    if (!panelVisible) setPanel(true);
    fileLoadPush(tab);
    statePush();
    return { ok: true, tab_id: tab.id };
}

// findFileTabInfo 按 tab_id 归口 file 标签信息（阶段一百五十九：debug:start/set-breakpoints
// 目标解析入口——渲染层只持有 tab_id+relPath，username/绝对路径由本模块与 pathGuard 归口）
function findFileTabInfo(tabId) {
    const tab = tabs.find(function (t) { return t.id === String(tabId || '') && t.kind === 'file'; });
    if (!tab) return { ok: false, error: '标签不存在或已关闭' };
    if (!tab.username || !tab.relPath) return { ok: false, error: '该标签不是工作区文件' };
    return { ok: true, username: tab.username, relPath: tab.relPath };
}

// viewerSave viewer 页保存归口：路径只认 tab.filePath（页面仅传内容，杜绝任意路径写），
// safePath 复验（防工作区切换后残留标签写穿旧路径）
function viewerSave(payload) {
    const tabId = String((payload && payload.tab_id) || '');
    const content = String(payload && payload.content != null ? payload.content : '');
    const tab = tabs.find(function (t) { return t.id === tabId && t.kind === 'file'; });
    if (!tab) return { ok: false, error: '标签不存在或已关闭' };
    if (!tab.filePath || !tab.username || !tab.relPath) return { ok: false, error: '该页内容不可保存' };
    if (!pathGuard) return { ok: false, error: '路径校验未就绪' };
    const g = pathGuard(tab.username, tab.relPath);
    if (g.err) return { ok: false, error: '保存被拒绝：' + g.err };
    try { fs.writeFileSync(tab.filePath, content, 'utf8'); } catch (e) {
        return { ok: false, error: '写入失败：' + (e.message || e) };
    }
    // 阶段九十七：手工保存=接受当前内容（含 AI 改动）→ 任务备份按"保留"语义清理
    if (taskBackupApi && typeof taskBackupApi.keep === 'function') {
        try { taskBackupApi.keep(tab.filePath); } catch (e) {}
    }
    tab.dirty = false;
    // 同步最新内容进 lastPayload（刷新标签=重渲染已保存内容）
    if (tab.lastPayload) tab.lastPayload.content = content;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:file-saved', { path: tab.relPath });
    }
    statePush();
    return { ok: true };
}

// taskChangeOp 任务变更保留/撤销归口（阶段九十七）：路径只认 tab.filePath（页面仅传 tab_id）。
// keep=接受当前磁盘内容（删备份）；revert=还原任务前字节并重读盘刷新 payload（页面全量重渲染）
function taskChangeOp(payload, op) {
    const tabId = String((payload && payload.tab_id) || '');
    const tab = tabs.find(function (t) { return t.id === tabId && t.kind === 'file'; });
    if (!tab) return { ok: false, error: '标签不存在或已关闭' };
    if (!tab.filePath) return { ok: false, error: '该页无本地文件' };
    if (!taskBackupApi || typeof taskBackupApi[op] !== 'function') return { ok: false, error: '任务备份能力未就绪' };
    const r = taskBackupApi[op](tab.filePath);
    if (r && r.ok && tab.lastPayload) {
        if (op === 'revert') { // 撤销：重读盘刷新（内容回任务前，标记随备份删除自然消失）
            const rr = readFilePayload(tab.username, tab.relPath);
            if (rr.ok) tab.lastPayload = Object.assign(rr.payload, { tab_id: tab.id });
        } else { // 保留：清标记，baseline 对齐当前内容（gutter 随之清空）
            delete tab.lastPayload.task_modified;
            delete tab.lastPayload.baseline;
        }
        fileLoadPush(tab); // 重注入 payload → 页面 __wsFileLoad 全量刷新
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser:file-saved', { path: tab.relPath });
        }
        statePush();
    }
    return r;
}

// lspHover 阶段一百三十：LSP 悬停归口（tab_id → tab.filePath，页面不持有绝对路径，安全边界同 viewerSave）。
// 仅 file 标签（真实磁盘文件）走 LSP 真实类型推导；diff/commit/报告等数据标签无本地文件，
// 由前端静态文档表兜底（file-viewer.html 五级命中）。req = {tab_id, text, line, character}
function lspHover(payload) {
    const tabId = String((payload && payload.tab_id) || '');
    const tab = tabs.find(function (t) { return String(t.id) === tabId && t.kind === 'file'; });
    if (!tab || !tab.filePath) return Promise.resolve(null);
    return lspManager.hover({
        filePath: tab.filePath,
        text: String(payload && payload.text != null ? payload.text : ''),
        line: parseInt(payload && payload.line, 10) || 0,
        character: parseInt(payload && payload.character, 10) || 0
    });
}

// ===== Agent 工具实现（agent-executor.js 归口调用，与主进程同上下文） =====

// waitLoaded 等待当前加载结束（timeoutMs 兜底返回，不视为失败——部分站点长连接导致
// isLoading 常态 true；工具语义是"页面已可读"而非"所有资源加载完"）
function waitLoaded(tab, timeoutMs, wc) {
    return new Promise(function (resolve) {
        if (!wc || wc.isDestroyed()) { resolve(true); return; }
        if (!wc.isLoading()) { resolve(true); return; }
        let done = false;
        const finish = function (ok) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            wc.removeListener('did-stop-loading', onStop);
            wc.removeListener('did-fail-load', onFail);
            resolve(ok);
        };
        const onStop = function () { finish(true); };
        const onFail = function (e, code, desc, isMain) { if (isMain) finish(false); };
        const timer = setTimeout(function () { finish(true); }, timeoutMs || 30000);
        wc.on('did-stop-loading', onStop);
        wc.on('did-fail-load', onFail);
    });
}

// settleAfterLoad 页面加载完成后留出 SPA 首帧渲染时间，再读标题（值不值得等：标题对模型定位页面很关键）
function settleAfterLoad(tab, ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 400); }).then(function () {
        const wc = wcOf(tab);
        if (wc && !wc.isDestroyed()) {
            tab.url = wc.getURL();
            tab.title = wc.getTitle() || tab.title;
        }
        statePush();
        return tab;
    });
}

// fileTabBlockMsg Agent 网页交互工具的文件页防护提示（活动标签为 file kind 时快照/点击/输入/eval 无意义）
function fileTabBlockMsg() {
    const tab = activeTab();
    if (tab && tab.kind === 'file') {
        return { ok: false, output: '错误：活动标签是本地文件查看页（' + (tab.relPath || tab.title) + '），不可执行网页交互；如需操作网页请先 browser_navigate 打开网页' };
    }
    return null;
}

// toolNavigate browser_navigate：打开 URL（自动展示浏览区，用户实时可见页面内容）。
// 新标签：webview 由渲染层按 src 建框自动首载；既有标签：wcId 直达 loadURL（未就绪则
// 由渲染层按最新 tab.url 建框，无需补发）
async function toolNavigate(params) {
    const url = String((params && params.url) || '').trim();
    if (!urlAllowed(url)) {
        return { ok: false, output: '错误：仅支持 http/https 网址' };
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false, output: '错误：主窗口未就绪' };
    }
    let newTab = !!(params && params.new_tab); // 阶段九十四修复：file 活动标签强制新开时需重新赋值，声明成 const 会抛 "Assignment to constant variable"
    let tab = activeTab();
    if (tab && tab.kind === 'file') newTab = true; // 活动为文件查看页：强制新开网页标签，不覆盖文件视图
    if (newTab || !tab) {
        tab = createTab(url, true);
        setPanel(true); // 自动展开浏览区（幂等；状态推送驱动渲染层建 webview 并以 src 首载）
    } else {
        activeId = tab.id;
        tab.url = url;
        setPanel(true);
        const wcLive = wcOf(tab);
        if (wcLive) wcLive.loadURL(url).catch(function () { /* 失败由 did-fail-load 呈现 */ });
        // webview 未就绪（面板首开中）：渲染层按 tab.url 建框即加载，无需补发
    }
    const wc = await wcFor(tab, 20000);
    if (!wc) {
        return { ok: true, output: '已发起打开 ' + url + '（页面视图就绪中，浏览区暂未展示内容，请稍后用 browser_snapshot 确认或重试）' };
    }
    const fail = !(await waitLoaded(tab, 30000, wc));
    await settleAfterLoad(tab, 400);
    const head = '已打开页面「' + (wc.getTitle() || tab.title) + '」（' + wc.getURL() + '）';
    if (fail) {
        return { ok: true, output: head + '。注意：页面主资源加载失败或被拦截（可能是网络/证书问题），可用 browser_snapshot 确认实际内容' };
    }
    return { ok: true, output: head + '。可调用 browser_snapshot 获取可交互元素清单（带 ref），再 browser_click/browser_input 操作' };
}

// 快照采集脚本：可交互元素带 ref 编号（写入 data-agent-ref 供 click/input 反查）+ 页面文本概要。
// 引号内不拼外部数据，纯静态脚本字符串，避免注入风险
const SNAPSHOT_SCRIPT = "(function () {\n" +
    "  var els = Array.prototype.slice.call(document.querySelectorAll('a[href], button, input, textarea, select, [role=\"button\"], [role=\"link\"], [role=\"tab\"], [role=\"checkbox\"], [role=\"radio\"], [role=\"combobox\"], [contenteditable=\"true\"], [onclick]'));\n" +
    "  var lines = [];\n" +
    "  var i = 0;\n" +
    "  els.forEach(function (el) {\n" +
    "    if (i >= " + SNAPSHOT_MAX_ELEMENTS + ") return;\n" +
    "    var r = el.getBoundingClientRect();\n" +
    "    if (r.width < 2 || r.height < 2) return;\n" +
    "    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return;\n" +
    "    var text = String(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('href') || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);\n" +
    "    var tag = el.tagName.toLowerCase();\n" +
    "    var kind = tag;\n" +
    "    if (tag === 'input') kind = 'input' + (el.getAttribute('type') ? '[' + el.getAttribute('type') + ']' : '');\n" +
    "    if (el.getAttribute('role')) kind = el.getAttribute('role');\n" +
    "    var ref = 'e' + (++i);\n" +
    "    el.setAttribute('data-agent-ref', ref);\n" +
    "    lines.push(ref + ' ' + kind + ': ' + (text || '(无文本)'));\n" +
    "  });\n" +
    "  var body = String((document.body && document.body.innerText) || '').replace(/[ \\t]{2,}/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 1500);\n" +
    "  return JSON.stringify({ url: location.href, title: document.title, elements: lines, text: body });\n" +
    "})()";

// toolSnapshot browser_snapshot：页面可交互元素清单 + 文本概要
async function toolSnapshot() {
    const blocked = fileTabBlockMsg();
    if (blocked) return blocked;
    const tab = activeTab();
    if (!tab) {
        return { ok: false, output: '错误：当前没有打开的页面，请先 browser_navigate' };
    }
    const wc = wcOf(tab);
    if (!wc) return { ok: false, output: '错误：页面视图未就绪，请先 browser_navigate 重新打开' };
    let raw;
    try {
        raw = await wc.executeJavaScript(SNAPSHOT_SCRIPT, true);
    } catch (e) {
        return { ok: false, output: '错误：页面脚本执行失败——' + (e.message || e) };
    }
    let snap;
    try { snap = JSON.parse(raw); } catch (e) { snap = null; }
    if (!snap) return { ok: false, output: '错误：快照解析失败（页面可能仍在加载），请稍后重试' };
    let out = '页面: ' + (snap.title || '(无标题)') + '\n地址: ' + snap.url + '\n可交互元素（ref: 类型: 文本）:\n';
    out += (snap.elements && snap.elements.length ? snap.elements.join('\n') : '(未发现可交互元素)');
    out += '\n页面文本概要:\n' + (snap.text || '(空)');
    if (out.length > SNAPSHOT_MAX_CHARS) {
        out = out.slice(0, SNAPSHOT_MAX_CHARS) + '\n…（快照过长已截断，可用 browser_eval 精确读取目标区域）';
    }
    return { ok: true, output: out };
}

// refScript 按 ref 定位元素并执行动作的公共前置（scrollIntoView + 存在性校验）
function refLookupScript(ref, actionJs) {
    return "(function () {\n" +
        "  var el = document.querySelector('[data-agent-ref=\"" + String(ref).replace(/"/g, '') + "\"]');\n" +
        "  if (!el) return JSON.stringify({ ok: false, msg: 'ref 不存在或页面已变化，请重新 browser_snapshot' });\n" +
        "  el.scrollIntoView({ block: 'center' });\n" +
        actionJs + "\n" +
        "})()";
}

// toolClick browser_click：按 ref 点击元素
async function toolClick(params) {
    const blocked = fileTabBlockMsg();
    if (blocked) return blocked;
    const ref = String((params && params.ref) || '').trim();
    if (!ref) return { ok: false, output: '错误：缺少 ref 参数（先 browser_snapshot 获取）' };
    const tab = activeTab();
    if (!tab) return { ok: false, output: '错误：当前没有打开的页面，请先 browser_navigate' };
    const wc = wcOf(tab);
    if (!wc) return { ok: false, output: '错误：页面视图未就绪，请先 browser_navigate 重新打开' };
    const script = refLookupScript(ref,
        "  el.click();\n" +
        "  return JSON.stringify({ ok: true, msg: '已点击 ' + el.tagName.toLowerCase() });");
    let raw;
    try { raw = await wc.executeJavaScript(script, true); } catch (e) {
        return { ok: false, output: '错误：页面脚本执行失败——' + (e.message || e) };
    }
    let r = {};
    try { r = JSON.parse(raw); } catch (e) { /* 保底 */ }
    if (!r.ok) return { ok: false, output: '错误：' + (r.msg || '点击失败') };
    return { ok: true, output: '已点击元素 ' + ref + '。页面若跳转/出现弹层，请重新 browser_snapshot 获取新 ref' };
}

// toolInput browser_input：按 ref 填写输入框（React 等框架用原生 setter 触发受控组件更新）
async function toolInput(params) {
    const blocked = fileTabBlockMsg();
    if (blocked) return blocked;
    const ref = String((params && params.ref) || '').trim();
    const text = String((params && params.text) != null ? params.text : '');
    const clear = !(params && params.clear === false);
    if (!ref) return { ok: false, output: '错误：缺少 ref 参数（先 browser_snapshot 获取）' };
    const tab = activeTab();
    if (!tab) return { ok: false, output: '错误：当前没有打开的页面，请先 browser_navigate' };
    const wc = wcOf(tab);
    if (!wc) return { ok: false, output: '错误：页面视图未就绪，请先 browser_navigate 重新打开' };
    // 最终值在 Node 侧决定：clear=true 直接填 text；clear=false 在原值后追加（框架兼容用原生 setter）
    const valueExpr = clear ? JSON.stringify(text) : "(el.value || '') + " + JSON.stringify(text);
    const script = refLookupScript(ref,
        "  var isCE = el.isContentEditable;\n" +
        "  var isField = /^(input|textarea)$/i.test(el.tagName) || el.getAttribute('role') === 'combobox';\n" +
        "  if (!isCE && !isField) return JSON.stringify({ ok: false, msg: '该元素不支持文本输入（可 browser_snapshot 确认输入框 ref）' });\n" +
        "  el.focus();\n" +
        "  if (isCE) {\n" +
        "    el.textContent = " + (clear ? JSON.stringify(text) : "el.textContent + " + JSON.stringify(text)) + ";\n" +
        "  } else {\n" +
        "    var proto = el.tagName.toUpperCase() === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;\n" +
        "    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;\n" +
        "    setter.call(el, " + valueExpr + ");\n" +
        "  }\n" +
        "  el.dispatchEvent(new Event('input', { bubbles: true }));\n" +
        "  el.dispatchEvent(new Event('change', { bubbles: true }));\n" +
        "  return JSON.stringify({ ok: true, msg: '已填写' });");
    let raw;
    try { raw = await wc.executeJavaScript(script, true); } catch (e) {
        return { ok: false, output: '错误：页面脚本执行失败——' + (e.message || e) };
    }
    let r = {};
    try { r = JSON.parse(raw); } catch (e) { /* 保底 */ }
    if (!r.ok) return { ok: false, output: '错误：' + (r.msg || '填写失败') };
    return { ok: true, output: '已在 ' + ref + ' 填写内容。如需提交请先 browser_snapshot 找到提交按钮再 browser_click' };
}

// toolScreenshot browser_screenshot：当前页可见区截图，存 userData/browser-shots/
async function toolScreenshot() {
    const tab = activeTab();
    if (!tab) return { ok: false, output: '错误：当前没有打开的页面，请先 browser_navigate' };
    const wc = wcOf(tab);
    if (!wc) return { ok: false, output: '错误：页面视图未就绪，请先 browser_navigate 重新打开' };
    let image;
    try { image = await wc.capturePage(); } catch (e) {
        return { ok: false, output: '错误：截图失败——' + (e.message || e) };
    }
    if (!image || image.isEmpty()) return { ok: false, output: '错误：截图内容为空（页面可能未渲染完成）' };
    const dir = path.join(app.getPath('userData'), 'browser-shots');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录可能已存在 */ }
    // 阶段九十四：落盘健壮化——目录级降级。实测火绒等 HIPS 会拦截"新编译未签名 exe 写用户目录"
    // （23:24 旧 exe 写入成功、重编译后被拦，连 .tmp 都 EPERM 且重试无效），故主目录失败后
    // 降级系统 TEMP 目录保功能可用；临时文件+原子改名+瞬时锁重试仍保留（防杀软扫描锁）
    const png = image.toPNG();
    const dirs = [dir, path.join(os.tmpdir(), 'im-client-shots')];
    let lastErr = null;
    for (let d = 0; d < dirs.length; d++) {
        try { fs.mkdirSync(dirs[d], { recursive: true }); } catch (e) { /* 目录可能已存在 */ }
        for (let i = 0; i < 3; i++) {
            const file = path.join(dirs[d], 'browser-' + Date.now() + '-' + i + '.png');
            const tmp = file + '.tmp';
            try {
                fs.writeFileSync(tmp, png);
                fs.renameSync(tmp, file);
                return { ok: true, output: '截图已保存: ' + file + '（可在文件管理器打开查看；页面内容用户在浏览区实时可见）' };
            } catch (e) {
                lastErr = e;
                try { fs.unlinkSync(tmp); } catch (e2) { /* tmp 可能未创建 */ }
                const code = e && e.code;
                if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break; // 非锁类错误（如 ENOSPC）重试无意义
                try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); } catch (e2) { /* 同步等待 120ms 再试 */ }
            }
        }
    }
    return { ok: false, output: '错误：截图保存失败——' + ((lastErr && lastErr.message) || lastErr) + '。多次出现时请在安全软件（如火绒）中将 im-client.exe 加入信任区' };
}

// toolEval browser_eval：页面内执行任意 JS（服务端已强制审批）
async function toolEval(params) {
    const blocked = fileTabBlockMsg();
    if (blocked) return blocked;
    const expression = String((params && params.expression) || '').trim();
    if (!expression) return { ok: false, output: '错误：缺少 expression 参数' };
    const tab = activeTab();
    if (!tab) return { ok: false, output: '错误：当前没有打开的页面，请先 browser_navigate' };
    const wc = wcOf(tab);
    if (!wc) return { ok: false, output: '错误：页面视图未就绪，请先 browser_navigate 重新打开' };
    let result;
    try { result = await wc.executeJavaScript(expression, true); } catch (e) {
        return { ok: false, output: '错误：脚本执行失败——' + (e.message || e) };
    }
    let out;
    if (typeof result === 'string') {
        out = result;
    } else if (result === undefined) {
        out = 'undefined';
    } else {
        try { out = JSON.stringify(result, null, 2); } catch (e) { out = String(result); }
    }
    if (out && out.length > SNAPSHOT_MAX_CHARS) out = out.slice(0, SNAPSHOT_MAX_CHARS) + '\n…（结果过长已截断）';
    return { ok: true, output: out || '（脚本执行成功，无返回值）' };
}

// toolTabs browser_tabs：list / select / close
function toolTabs(params) {
    const action = String((params && params.action) || 'list').toLowerCase();
    if (action === 'list') {
        if (tabs.length === 0) return { ok: true, output: '当前无标签页' };
        const lines = tabs.map(function (t) {
            const prefix = t.kind === 'file' ? '[文件] ' : '';
            return prefix + t.id + (t.id === activeId ? ' [活动]' : '') + ' ' + (t.title || '(无标题)') + ' — ' + (t.kind === 'file' ? (t.relPath || t.title) : t.url) + (t.loading ? '（加载中）' : '');
        });
        return { ok: true, output: lines.join('\n') };
    }
    const tabId = String((params && params.tab_id) || '');
    if (action === 'select') {
        if (!tabId) return { ok: false, output: '错误：select 需要 tab_id（先 browser_tabs list 获取）' };
        if (!selectTab(tabId)) return { ok: false, output: '错误：标签页 ' + tabId + ' 不存在' };
        const tab = activeTab();
        return { ok: true, output: '已切换到 ' + tab.id + '「' + tab.title + '」（' + tab.url + '）' };
    }
    if (action === 'close') {
        if (!tabId) return { ok: false, output: '错误：close 需要 tab_id（关闭当前页请用 browser_close）' };
        if (!closeTab(tabId)) return { ok: false, output: '错误：标签页 ' + tabId + ' 不存在' };
        return { ok: true, output: '已关闭 ' + tabId + (tabs.length === 0 ? '。全部标签页已关闭，浏览区已收起' : '。剩余 ' + tabs.length + ' 个标签页') };
    }
    return { ok: false, output: '错误：action 仅支持 list/select/close' };
}

// toolClose browser_close：关闭当前标签页（全部关完自动收起面板）
function toolClose() {
    const tab = activeTab();
    if (!tab) return { ok: true, output: '当前无打开的页面' };
    const title = tab.title;
    closeTab(); // 不传 id=关活动页
    return { ok: true, output: '已关闭「' + title + '」' + (tabs.length === 0 ? '。全部标签页已关闭，浏览区已收起' : '。剩余 ' + tabs.length + ' 个标签页') };
}

// agentExecute Agent 工具执行归口（agent-executor.js 按 tool 名分派到这里；Promise<{ok,output}>）
async function agentExecute(tool, params) {
    try {
        switch (String(tool || '')) {
            case 'browser_navigate': return await toolNavigate(params);
            case 'browser_snapshot': return await toolSnapshot(params);
            case 'browser_click': return await toolClick(params);
            case 'browser_input': return await toolInput(params);
            case 'browser_screenshot': return await toolScreenshot(params);
            case 'browser_eval': return await toolEval(params);
            case 'browser_tabs': return toolTabs(params);
            case 'browser_close': return toolClose();
        }
        return { ok: false, output: '错误：未知工具 ' + tool };
    } catch (e) {
        return { ok: false, output: '错误：内置浏览器工具执行异常——' + (e.message || e) };
    }
}

// ===== 初始化与渲染层 IPC =====

// init 模块初始化（main.js 在主窗口创建后调用）：注册渲染层 IPC 入口
function init(win) {
    mainWindow = win;
    browserSession(); // 分区会话钩子（UA 去 Electron 标记 + 权限默认拒绝），webview 复用同分区
    // 面板显隐（渲染层工具栏按钮）
    ipcMain.handle('browser:panel', function (event, visible) {
        setPanel(!!visible);
        return { ok: true };
    });
    // 导航操作（后退/前进/刷新/停止/地址栏回车）
    ipcMain.handle('browser:nav', function (event, payload) {
        return { ok: navAction(payload && payload.action, payload && payload.url) };
    });
    // 阶段九十三：webview 就绪上报——渲染层建 <webview> 后 dom-ready 上报宿主 webContents id，
    // 主进程挂接事件（标题/加载/导航/favicon/window.open 归口）并补发 queuedNav
    ipcMain.on('browser:wv-ready', function (event, payload) {
        const tab = tabs.find(function (t) { return t.id === String((payload && payload.tab_id) || '') && t.kind === 'web'; });
        const id = parseInt((payload && payload.wc_id), 10);
        if (!tab || !id) return;
        tab.wcId = id;
        const wc = wcOf(tab);
        if (wc && !wc.isDestroyed()) {
            attachWebContents(tab, wc);
            if (tab.queuedNav) {
                const u = tab.queuedNav;
                tab.queuedNav = '';
                if (urlAllowed(u)) wc.loadURL(u).catch(function () { /* 失败由状态呈现 */ });
            }
        }
        statePush();
    });
    // 标签页切换/关闭（渲染层 tab 栏）
    ipcMain.handle('browser:select', function (event, tabId) {
        return { ok: selectTab(tabId) };
    });
    ipcMain.handle('browser:closetab', function (event, tabId) {
        closeTab(tabId);
        return { ok: true };
    });
    // 阶段九十四：标签右键菜单批量操作（关闭其他/右侧/全部、移动、固定切换、系统浏览器打开）
    ipcMain.handle('browser:tabs-op', function (event, payload) {
        return { ok: tabsOp(payload && payload.op, payload && payload.tab_id, payload && payload.url) };
    });
    // CDP 端口设置（渲染层设置入口；写配置 + 提示重启生效——启动参数仅进程启动时读取）
    ipcMain.handle('browser:cdp-set', function (event, port) {
        const n = parseInt(port, 10);
        const cfg = cfgRead();
        cfg.cdp_port = (n > 0 && n < 65536) ? n : 0;
        cfgSave(cfg);
        return { ok: true, port: cfg.cdp_port, need_restart: cfg.cdp_port !== cdpPort };
    });
    ipcMain.handle('browser:cdp-get', function () {
        return { port: cdpPort };
    });
    // ===== 阶段九十二：文件/内容标签（渲染层 wsOpenFile/wsOpenData 入口 + viewer 保存窄通道） =====
    ipcMain.handle('browser:open-file', function (event, payload) {
        return openFileTab(payload && payload.username, payload && payload.path);
    });
    ipcMain.handle('browser:open-data', function (event, payload) {
        return openDataTab(payload);
    });
    ipcMain.handle('browser:file-save', function (event, payload) {
        return viewerSave(payload);
    });
    // 阶段九十七：任务变更保留/撤销（viewer 页"任务已修改"条按钮，路径归口 tab.filePath）
    ipcMain.handle('browser:task-keep', function (event, payload) {
        return taskChangeOp(payload, 'keep');
    });
    ipcMain.handle('browser:task-revert', function (event, payload) {
        return taskChangeOp(payload, 'revert');
    });
    // 阶段一百六十二：外部变更感知刷新——渲染层任务完结钩子调用，已打开 file 标签读盘比对静默更新
    ipcMain.handle('browser:refresh-file-tabs', function () {
        return refreshOpenFileTabs();
    });
    // viewer 页脏标记（编辑未保存）→ tab 栏圆点提示
    ipcMain.on('browser:viewer-dirty', function (event, payload) {
        const tab = tabs.find(function (t) { return t.id === String((payload && payload.tab_id) || '') && t.kind === 'file'; });
        if (tab) {
            tab.dirty = !!(payload && payload.dirty);
            statePush();
        }
    });
    // 阶段一百三十八：渲染层 file iframe 就绪补拉 payload——页面刷新/退出重登后 iframe 重建，
    // 主进程 lastPayload 仍在但不再主动推送，原实现活动文件标签空白须重开文件；就绪即补拉重投
    ipcMain.handle('browser:file-reload', function (event, payload) {
        const id = String((payload && payload.tab_id) || payload || '');
        const tab = tabs.find(function (t) { return t.id === id && t.kind === 'file'; });
        fileLoadPush(tab || null); // 标签已关/无 payload 时内部静默返回
        return { ok: true };
    });
    // 原实现：win.webContents.on('did-finish-load', statePush);
    // 阶段一百三十八：首次页面加载完成后先恢复落盘的浏览区状态（面板显隐+标签重建）再推送——
    // 重启后内存默认收起且标签清空，直接 statePush 推的是空态，浏览区永远消失；后续每次页面
    // 加载（退出登录刷新等）维持原行为仅重推状态（内存态还在，iframe 由渲染层按状态重建）。
    // 幂等守卫在 restoreSavedState 内部（沙箱就绪通知入口共用，见 notifySandboxReady）
    win.webContents.on('did-finish-load', function () {
        if (!stateRestored) {
            restoreSavedState();
        } else {
            statePush();
        }
    });
}

// setPathGuard 注入路径校验函数（main.js 传入 agentExecutor.safePath——browser-manager 不可
// 反向 require agent-executor，会循环依赖：agent-executor 已 require 本模块）
function setPathGuard(fn) {
    pathGuard = typeof fn === 'function' ? fn : null;
}

// setTaskBackupApi 注入任务备份查询/保留/撤销（阶段九十七，main.js 传入 agentExecutor 三个 helper——
// browser-manager 不可反向 require agent-executor，会循环依赖）
function setTaskBackupApi(api) {
    taskBackupApi = (api && typeof api === 'object') ? api : null;
}

// setViewerUrl 注入 viewer 页地址（main.js 传 SERVER_URL + 'file-viewer.html'，PC 壳页面
// 由服务端提供，file-viewer.html 随 web 目录同源分发）
function setViewerUrl(url) {
    viewerUrl = String(url || '');
}

module.exports = {
    init: init,
    setCdpSwitch: setCdpSwitch,
    setPathGuard: setPathGuard,
    setTaskBackupApi: setTaskBackupApi, // 阶段九十七：任务备份查询/保留/撤销注入
    refreshFileTabByPath: refreshFileTabByPath, // 阶段一百六十二：AI 写盘钩子按路径刷新已打开标签（实时更新+跳转改动行）
    setViewerUrl: setViewerUrl,
    findFileTabInfo: findFileTabInfo, // 阶段一百五十九：file 标签信息归口（debug IPC 目标解析）
    setTabCloseHook: setTabCloseHook, // 阶段一百五十九：file 标签关闭联动钩子（调试会话随关停）
    agentExecute: agentExecute,
    statePush: statePush,
    notifySandboxReady: notifySandboxReady, // 阶段一百三十八：沙箱就绪通知（main.js 登录后 sandbox:get 时调）——重试待恢复文件标签
    lspHover: lspHover,         // 阶段一百三十：LSP 悬停归口（main.js ipcMain 'lsp:hover' 调用）
    lspShutdown: function () { try { lspManager.shutdownAll(); } catch (e) {} } // 阶段一百三十：应用退出全量回收语言服务器子进程
};
