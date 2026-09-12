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
const { app, ipcMain, session, webContents } = require('electron');

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
function attachWebContents(tab, wc) {
    if (!tab || !wc || wc.isDestroyed()) return;
    if (tab.__hookedId === tab.wcId) return;
    tab.__hookedId = tab.wcId;
    // 页面 window.open / target=_blank：转应用内新标签页（http/https 才放行；deny 阻断弹窗本身）
    wc.setWindowOpenHandler(function (details) {
        if (urlAllowed(details.url)) createTab(details.url, true);
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
    wc.on('did-navigate', function (e, u) { tab.url = u; statePush(); });
    wc.on('did-navigate-in-page', function (e, u) { tab.url = u; statePush(); });
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

// destroyTab 关闭并销毁标签页（file/web 均无原生视图：仅清状态，渲染层经 statePush
// 移除对应 iframe/webview 元素，元素移除即销毁 guest）
function destroyTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
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
                ext: t.kind === 'file' && t.relPath ? path.extname(t.relPath).replace('.', '').toLowerCase() : '',
                data_kind: t.kind === 'file' ? (t.dataKind || '') : '',
                favicon: t.kind === 'web' ? (t.favicon || '') : '',
                dirty: !!t.dirty
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
    statePush();
    return true;
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
        if (!panelVisible) setPanel(true);
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
    if (!panelVisible) setPanel(true); // setPanel 内含状态推送
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
    tab.title = title;
    tab.lastPayload = build(tab.id);
    if (!panelVisible) setPanel(true);
    fileLoadPush(tab);
    statePush();
    return { ok: true, tab_id: tab.id };
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
    tab.dirty = false;
    // 同步最新内容进 lastPayload（刷新标签=重渲染已保存内容）
    if (tab.lastPayload) tab.lastPayload.content = content;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser:file-saved', { path: tab.relPath });
    }
    statePush();
    return { ok: true };
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
    const newTab = !!(params && params.new_tab);
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
    const file = path.join(dir, 'browser-' + Date.now() + '.png');
    try { fs.writeFileSync(file, image.toPNG()); } catch (e) {
        return { ok: false, output: '错误：截图保存失败——' + (e.message || e) };
    }
    return { ok: true, output: '截图已保存: ' + file + '（可在文件管理器打开查看；页面内容用户在浏览区实时可见）' };
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
    // viewer 页脏标记（编辑未保存）→ tab 栏圆点提示
    ipcMain.on('browser:viewer-dirty', function (event, payload) {
        const tab = tabs.find(function (t) { return t.id === String((payload && payload.tab_id) || '') && t.kind === 'file'; });
        if (tab) {
            tab.dirty = !!(payload && payload.dirty);
            statePush();
        }
    });
    win.webContents.on('did-finish-load', statePush);
}

// setPathGuard 注入路径校验函数（main.js 传入 agentExecutor.safePath——browser-manager 不可
// 反向 require agent-executor，会循环依赖：agent-executor 已 require 本模块）
function setPathGuard(fn) {
    pathGuard = typeof fn === 'function' ? fn : null;
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
    setViewerUrl: setViewerUrl,
    agentExecute: agentExecute,
    statePush: statePush
};
