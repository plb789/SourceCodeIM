// ===== 网盘分享独立页逻辑（/s/<code> 落地页，百度网盘同款） =====
// 设计归口（服务端统一数据归口，本页只展示）：
//  1. 查看/下载免登录：凭 分享码+提取码 访问 /api/drive/share/info|download（无需任何登录态）
//  2. 保存到我的网盘需登录：服务端 driveCheckUser 以 WS 在线水位校验 → 本页复用 socket.js
//     同一套 LOGIN 协议建立会话（与主应用共享 localStorage['im_auth'] 凭据）
//  3. 失效文案（已取消/已过期/文件已删除/不存在）全部服务端返回，本页零判断
//  4. 全部弹层自绘（禁系统弹窗），主题变量归口 css/style.css（data-theme 跟随主程序设置）

(function () {
    'use strict';

    // ===== 分享码解析（与主应用 chat.js 同款正则） =====
    var m = (location.pathname || '').match(/^\/s\/([A-Za-z0-9]{6,40})$/);
    var code = m ? m[1] : '';

    // ===== DOM 引用 =====
    function $(id) { return document.getElementById(id); }
    var loginEntry = $('sp-login-entry'), userNameEl = $('sp-user-name'), logoutBtn = $('sp-logout');
    var iconEl = $('sp-icon'), nameEl = $('sp-name'), metaEl = $('sp-meta');
    var extractRow = $('sp-extract-row'), extractInput = $('sp-extract-input'),
        extractBtn = $('sp-extract-btn'), extractErr = $('sp-extract-err');
    var btnRow = $('sp-btn-row'), downloadBtn = $('sp-download-btn'), saveBtn = $('sp-save-btn');
    var invalidEl = $('sp-invalid'), invalidText = $('sp-invalid-text');
    var loginMask = $('sp-login-mask'), loginClose = $('sp-login-close'),
        loginUser = $('sp-login-username'), loginPass = $('sp-login-password'),
        loginErr = $('sp-login-err'), loginOkBtn = $('sp-login-ok');
    var toastEl = $('sp-toast');

    // ===== 状态 =====
    var shareInfo = null;     // info 接口返回的 share 对象（提取通过后填充）
    var extract = '';         // 已通过的提取码（下载/保存共用）
    var authed = false;       // WS 登录成功（服务端在线水位达成）
    var pendingSave = false;  // 登录成功后自动补发保存
    var autoConnFailSilent = false; // 自动连接失败静默（仅回退顶栏，不弹错误）
    var lastRejectText = '';        // 最近一次 ERROR 帧文案（服务端拒绝判定：ERROR+close 连发）
    var toastTimer = 0;

    // ===== 类别 SVG 图标（与 drive.js ICONS 同一套 path，独立内嵌避免引主应用模块） =====
    var ICONS = {
        dir: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
        img: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
        video: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
        audio: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
        zip: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-4 9v2h-2v-2h2zm0-4v2h-2v-2h2zm-2-2V7h2v2h-2zm2 6h-2v-2h2v2z"/></svg>',
        doc: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
        sheet: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-2h2v2zm0-4H7v-2h2v2zm0-4H7V7h2v2zm4 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2zm4 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/></svg>',
        pdf: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7V7h3c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5H13V7h2c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-2V7h3.5v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/></svg>',
        txt: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
        file: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>'
    };
    // 类别判定（与 drive.js kindOf 同语义同扩展名表）
    function kindOf(it) {
        if (!it) return 'file';
        if (it.is_dir) return 'dir';
        var ext = ((it.file_name || it.name || '').split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) >= 0) return 'img';
        if (['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv'].indexOf(ext) >= 0) return 'video';
        if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].indexOf(ext) >= 0) return 'audio';
        if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(ext) >= 0) return 'zip';
        if (['doc', 'docx'].indexOf(ext) >= 0) return 'doc';
        if (['xls', 'xlsx', 'csv'].indexOf(ext) >= 0) return 'sheet';
        if (ext === 'pdf') return 'pdf';
        if (['txt', 'md', 'log', 'json'].indexOf(ext) >= 0) return 'txt';
        return 'file';
    }

    // ===== 登录凭据（与 chat.js saveAuth/getSavedAuth 同款格式，同域共享） =====
    function getAuth() {
        try { return JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || null; } catch (e) { return null; }
    }
    function saveAuth(u, p) {
        try { localStorage.setItem('im_auth', btoa(encodeURIComponent(JSON.stringify({ u: u, p: p })))); } catch (e) {}
    }
    function clearAuth() {
        try { localStorage.removeItem('im_auth'); } catch (e) {}
    }

    // ===== 通用请求（JSON 归口，服务端 error 文本直显） =====
    function apiJSON(url, opts, cb) {
        fetch(url, opts).then(function (res) {
            res.json().then(function (data) {
                if (!res.ok) cb(new Error(data.error || ('请求失败(' + res.status + ')')), data);
                else cb(null, data);
            }, function () {
                cb(new Error('请求失败(' + res.status + ')'));
            });
        }, function () {
            cb(new Error('网络异常，请稍后重试'));
        });
    }

    // ===== 工具 =====
    function fmtSize(n) {
        if (n == null) return '-';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }
    function expireText(ts) {
        if (!ts) return '永久有效';
        var d = new Date(ts * 1000);
        var pad = function (x) { return x < 10 ? '0' + x : '' + x; };
        return '有效期至 ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function toast(text) {
        toastEl.textContent = text;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2500);
    }
    function showError(el, text) {
        el.textContent = text;
        el.classList.remove('hidden');
    }

    // ===== 视图切换 =====
    function showInvalid(text) {
        $('sp-card').classList.add('hidden');
        invalidText.textContent = text || '分享不存在或已失效';
        invalidEl.classList.remove('hidden');
    }
    function renderShare(sh) {
        invalidEl.classList.add('hidden');
        iconEl.className = 'sp-icon k-' + kindOf(sh);
        iconEl.innerHTML = ICONS[kindOf(sh)] || ICONS.file;
        nameEl.textContent = sh.file_name || '未命名文件';
        nameEl.title = sh.file_name || '';
        metaEl.textContent = (sh.is_dir ? '文件夹' : fmtSize(sh.size)) +
            ' · ' + (sh.from || '') + ' 分享 · ' + expireText(sh.expire_at) +
            (sh.has_extract ? '' : '');
        extractRow.classList.add('hidden');
        btnRow.classList.remove('hidden');
        downloadBtn.classList.toggle('hidden', !!sh.is_dir); // 文件夹不支持下载（服务端同款限制）
    }

    // ===== 分享信息获取（info 免登录归口；need_extract 引导提取码行） =====
    function fetchInfo(ex) {
        apiJSON('/api/drive/share/info?code=' + encodeURIComponent(code) +
            '&extract=' + encodeURIComponent(ex || ''), null, function (err, data) {
            if (err) {
                if (data && data.need_extract) {
                    // 需要提取码：显示输入行（错误文案如"提取码错误"显示在输入行下方）
                    $('sp-card').classList.remove('hidden');
                    invalidEl.classList.add('hidden');
                    nameEl.textContent = '加密分享';
                    metaEl.textContent = '输入提取码后查看和下载文件';
                    extractRow.classList.remove('hidden');
                    if (ex) showError(extractErr, err.message || '提取码错误');
                    setTimeout(function () { extractInput.focus(); extractInput.select(); }, 60);
                } else {
                    showInvalid(err.message);
                }
                return;
            }
            shareInfo = data.share;
            extract = ex || '';
            renderShare(shareInfo);
        });
    }

    // ===== 下载（免登录：浏览器原生下载，本地流式/MinIO 302 均带 attachment） =====
    downloadBtn.addEventListener('click', function () {
        if (!code) return;
        toast('开始下载…');
        location.href = '/api/drive/share/download?code=' + encodeURIComponent(code) +
            '&extract=' + encodeURIComponent(extract);
    });

    // ===== 保存到我的网盘（需登录 = WS 在线水位） =====
    function doSave() {
        var u = (window.IMSocket && IMSocket.getUsername()) || (getAuth() || {}).u || '';
        if (!u) { openLoginPanel(true); return; }
        saveBtn.disabled = true;
        apiJSON('/api/drive/share/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, code: code, extract: extract, parent_id: 0 })
        }, function (err, data) {
            saveBtn.disabled = false;
            if (err) {
                var msg = err.message || '保存失败';
                if (msg.indexOf('未在线') >= 0) {
                    // 在线水位失效（密码被改/被踢下线）：引导重新登录后自动补发
                    authed = false;
                    openLoginPanel(true);
                    return;
                }
                toast(msg);
                return;
            }
            toast('已保存到我的网盘（共 ' + (data && data.saved || 0) + ' 项）');
        });
    }
    saveBtn.addEventListener('click', function () {
        if (!code) return;
        if (authed) { doSave(); return; }
        var saved = getAuth();
        if (saved && saved.u && saved.p) {
            // 已有凭据：连接中，登录成功后自动补发保存
            pendingSave = true;
            saveBtn.disabled = true;
            toast('正在连接，登录成功后自动保存…');
            connectWS(saved.u, saved.p, false);
        } else {
            openLoginPanel(true);
        }
    });

    // ===== 登录面板（自绘浮层） =====
    function openLoginPanel(autoSave) {
        pendingSave = !!autoSave || pendingSave;
        loginErr.classList.add('hidden');
        loginUser.value = (getAuth() || {}).u || '';
        loginPass.value = '';
        loginMask.classList.remove('hidden');
        setTimeout(function () { (loginUser.value ? loginPass : loginUser).focus(); }, 60);
    }
    function closeLoginPanel() {
        loginMask.classList.add('hidden');
        pendingSave = false; // 用户主动关闭 = 放弃本次保存引导
        saveBtn.disabled = false;
    }
    loginClose.addEventListener('click', closeLoginPanel);
    loginMask.addEventListener('click', function (e) { if (e.target === loginMask) closeLoginPanel(); });
    function submitLogin() {
        var u = loginUser.value.trim(), p = loginPass.value;
        if (!u || !p) { showError(loginErr, '请输入账号和密码'); return; }
        loginOkBtn.disabled = true;
        showError(loginErr, '正在登录…');
        loginErr.classList.remove('hidden');
        connectWS(u, p, true);
    }
    loginOkBtn.addEventListener('click', submitLogin);
    loginPass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
    });
    loginUser.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); loginPass.focus(); }
    });

    // ===== 顶栏用户区 =====
    function renderUser(u) {
        if (u) {
            userNameEl.textContent = u;
            userNameEl.classList.remove('hidden');
            logoutBtn.classList.remove('hidden');
            loginEntry.classList.add('hidden');
        } else {
            userNameEl.textContent = '';
            userNameEl.classList.add('hidden');
            logoutBtn.classList.add('hidden');
            loginEntry.classList.remove('hidden');
        }
    }
    logoutBtn.addEventListener('click', function () {
        clearAuth();
        location.reload(); // socket.js 无登出 API，重载断开 WS 最干净（服务端在线水位随之移除）
    });
    loginEntry.addEventListener('click', function () { openLoginPanel(false); });

    // ===== WebSocket 登录归口（复用 socket.js 协议；保存动作依赖服务端 WS 在线水位） =====
    function connectWS(u, p, fromPanel) {
        autoConnFailSilent = !fromPanel;
        if (!window.IMSocket) { onLoginFail(fromPanel, '连接组件加载失败'); return; }
        IMSocket.connect(u, p);
    }
    function onLoginOk(u, p) {
        authed = true;
        saveAuth(u, p); // 与主应用共享凭据（下次打开主应用自动登录同款）
        renderUser(u);
        loginMask.classList.add('hidden');
        loginOkBtn.disabled = false;
        if (pendingSave) {
            pendingSave = false;
            doSave(); // 登录成功自动补发保存（百度网盘同款闭环）
        }
    }
    function onLoginFail(fromPanel, text, keepAuth) {
        authed = false;
        loginOkBtn.disabled = false;
        if (!keepAuth) clearAuth(); // 仅服务端拒绝（密码被改/账号异常）清凭据；网络失败保留待重试
        renderUser('');
        saveBtn.disabled = false;
        if (fromPanel || !loginMask.classList.contains('hidden')) {
            showError(loginErr, text || '登录失败，请检查账号密码');
        } else {
            toast(text || '登录状态已失效');
        }
    }

    // WS 事件注册（LOGIN_RESP=8 成功 / ERROR=9 拒绝 / im_connect_failed 网络失败）
    if (window.IMSocket) {
        IMSocket.on(IMSocket.MSG.LOGIN_RESP, function (msg) {
            var ok = false;
            if (msg.content === 'ok') ok = true; // 旧格式兼容（socket.js 同款判定）
            try {
                var info = JSON.parse(msg.content);
                if (info && info.result === 'ok') ok = true;
            } catch (e) {}
            if (!ok) return;
            var u = msg.from_user || (getAuth() || {}).u || loginUser.value.trim();
            var p = (getAuth() || {}).p || loginPass.value;
            onLoginOk(u, p);
        });
        IMSocket.on(IMSocket.MSG.ERROR, function (msg) {
            lastRejectText = (msg && msg.content) || '';
            if (!loginMask.classList.contains('hidden')) showError(loginErr, lastRejectText || '登录失败，请检查账号密码');
        });
        window.addEventListener('im_connect_failed', function () {
            // 同端互踢识别（hub.go 归口文案"您的账号已在其他XX设备上登录，本设备已下线"）：
            // 被踢=别处登录了同账号，本页凭据仍有效——只回退顶栏不 clearAuth（原实现误判凭据失效
            // 清掉 im_auth，导致用户主应用登录态连带丢失）
            if (lastRejectText.indexOf('已在其他') >= 0 && lastRejectText.indexOf('下线') >= 0) {
                authed = false;
                lastRejectText = '';
                saveBtn.disabled = false;
                renderUser('');
                toast('账号已在其他设备登录，本页已下线');
                return;
            }
            // 服务端拒绝判定与 socket.js 同款：ERROR 帧后紧连 close（1 秒窗口）= 凭据问题清凭据；纯网络失败保留
            var rejected = !!lastRejectText;
            onLoginFail(!loginMask.classList.contains('hidden'), lastRejectText || '连接失败，请稍后重试', !rejected);
            lastRejectText = '';
        });
    }

    // ===== 提取码输入（自动转大写，与服务端不区分大小写校验双保险） =====
    extractInput.addEventListener('input', function () {
        var v = extractInput.value.toUpperCase();
        if (v !== extractInput.value) extractInput.value = v;
        extractErr.classList.add('hidden');
    });
    extractInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); extractBtn.click(); }
    });
    extractBtn.addEventListener('click', function () {
        var v = extractInput.value.trim();
        if (!v) { showError(extractErr, '请输入提取码'); return; }
        fetchInfo(v);
    });

    // ===== 启动 =====
    (function boot() {
        if (!code) { showInvalid('链接无效'); return; }
        fetchInfo('');
        var saved = getAuth();
        if (saved && saved.u && saved.p) {
            renderUser(saved.u); // 乐观显示（连接失败回退），与主应用同款体验
            connectWS(saved.u, saved.p, false);
        } else {
            renderUser('');
        }
    })();
})();
