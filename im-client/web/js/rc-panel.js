// rc-panel.js - 阶段二百六十一：向日葵同款远程控制面板（设备ID+验证码直连）
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 数据源唯一归口 /api/rc/*（设备注册/我的设备/静态密码/刷新动态码/控制记录），
//     鉴权头复用网盘 X-Drive-Token（登录回执持久化，水位同 drive.js）
//  2. 页面形态：#rc-view 覆盖 .main-chat 右侧聊天区（网盘/公告流同款 absolute 覆盖，
//     DOM 常驻由本模块移入主聊天区），左侧列表保持可见可点；三视图=我的电脑/连接远端/控制记录
//  3. 交互约束（项目规则）：全部反馈自绘（页内状态条/toast，禁系统弹窗）；
//     滚动条用全局自绘悬浮滑块（chat.js _osbInit 注册，加载顺序在 chat.js 之后）
//  4. 连接发起归口 window.rcConnect（chat.js：rc_connect 信令 + rc_ok/error 回执 + 20s 超时兜底）
//  5. 被控端语义仅 PC（Electron 抓屏/注入）；手机/Web 端"我的电脑"列表展示本账号 PC 设备
//     识别码并可一键预填连接页（向日葵手机连自家 PC 同款体验）
//  6. 主题：全部颜色走 CSS 变量（--primary/--panel-bg/--border 等），跟随主题色变化
(function () {
    'use strict';

    var view = document.getElementById('rc-view');
    if (!view) return; // 页面无远程控制视图（异常裁剪）静默退出

    var mainChatEl = document.querySelector('.main-chat');
    var titleEl = document.getElementById('rc-title');
    var refreshBtn = document.getElementById('rc-refresh-btn');
    var closeBtn = document.getElementById('rc-close');
    var pageMine = document.getElementById('rc-page-mine');
    var pageConnect = document.getElementById('rc-page-connect');
    var pageRecords = document.getElementById('rc-page-records');
    var mineWrap = document.getElementById('rc-mine-wrap');
    var mineEmpty = document.getElementById('rc-mine-empty');
    var mineEmptyText = document.getElementById('rc-mine-empty-text');
    var inDevice = document.getElementById('rc-in-device');
    var inCode = document.getElementById('rc-in-code');
    var connectBtn = document.getElementById('rc-connect-btn');
    var connectStatus = document.getElementById('rc-connect-status');
    var recordsList = document.getElementById('rc-records-list');
    var recordsEmpty = document.getElementById('rc-records-empty');
    // 手机端远程控制首页（设备卡片优先）：仅 html.m 使用，PC 端仍走侧栏三入口 + 视图一~三
    var pageHome = document.getElementById('rc-page-home');
    var homeDevices = document.getElementById('rc-home-devices');
    var homeEmpty = document.getElementById('rc-home-empty');
    var homeEmptyText = document.getElementById('rc-home-empty-text');

    var visible = false;
    var curPage = '';        // home / mine / connect / records
    var codeTimer = 0;       // 动态码倒计时定时器（页面关闭/刷新即清）
    var connecting = false;  // 连接发起中（防重复点击）

    function isMobile() { return document.documentElement.classList.contains('m'); }

    function u() { return (window.IMSocket && IMSocket.getUsername()) || ''; }
    function T(s, p) { return (window.I18N ? I18N.t(s, p) : s); }
    function TR(s) { return (window.I18N ? I18N.tr(s) : s); }
    function isPC() { return !!(window.desktop && window.desktop.rcGetInstallInfo); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== Toast（复用全局 #toast，2.5s 自灭，网盘同款） =====
    var toastEl = document.getElementById('toast');
    var toastTimer = 0;
    function toast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.remove('hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2500);
    }

    // ===== 通用请求（JSON 归口，鉴权头/错误文案处理同 drive.js） =====
    function apiJSON(url, opts, cb) {
        opts = opts || {};
        opts.headers = opts.headers || {};
        try {
            var dt = localStorage.getItem('drive_token');
            if (dt) opts.headers['X-Drive-Token'] = dt;
        } catch (e) { }
        fetch(url, opts).then(function (res) {
            res.json().then(function (data) {
                if (!res.ok) cb(new Error(data.error ? TR(data.error) : (res.status === 401 ? T('登录已过期，请重新登录') : T('请求失败({n})', { n: res.status }))), data);
                else cb(null, data);
            }, function () {
                cb(new Error(res.status === 401 ? T('登录已过期，请重新登录') : T('请求失败({n})', { n: res.status })));
            });
        }, function () {
            cb(new Error(T('网络异常，请稍后重试')));
        });
    }
    function apiGet(path, cb) {
        apiJSON('/api/rc/' + path + '?username=' + encodeURIComponent(u()), null, cb);
    }
    function apiPost(path, body, cb) {
        apiJSON('/api/rc/' + path + '?username=' + encodeURIComponent(u()), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }, cb);
    }

    // ===== 视图切换 =====
    function showPage(name) {
        curPage = name;
        if (pageHome) pageHome.classList.toggle('hidden', name !== 'home');
        pageMine.classList.toggle('hidden', name !== 'mine');
        pageConnect.classList.toggle('hidden', name !== 'connect');
        pageRecords.classList.toggle('hidden', name !== 'records');
        titleEl.textContent = { mine: T('我的电脑'), records: T('控制记录'), home: T('远程控制'), connect: T('连接其他电脑') }[name] || T('远程控制');
        refreshBtn.classList.toggle('hidden', name === 'connect' || name === 'home');
        // 倒计时仅 mine/home 两态需要（都渲染设备码）；离开即清
        if (name !== 'mine' && name !== 'home' && codeTimer) { clearInterval(codeTimer); codeTimer = 0; }
        if (name === 'mine') loadMine();
        else if (name === 'home') loadHome();
        else if (name === 'records') loadRecords();
    }

    // ===== 我的电脑（PC：先注册本机再列全部；非 PC：仅列表） =====
    function loadMine() {
        if (!u()) return;
        if (isPC()) {
            window.desktop.rcGetInstallInfo().then(function (info) {
                if (!info || !info.install_uuid) { renderMine(null, T('本机标识获取失败')); return; }
                apiPost('device/register', { install_uuid: info.install_uuid, device_name: info.device_name || '' }, function (err) {
                    fetchMy(err ? null : info.install_uuid);
                });
            }, function () { fetchMy(null); });
        } else {
            fetchMy(null);
        }
    }
    function fetchMy(myInstallUuid) {
        apiGet('device/my', function (err, data) {
            if (err) { renderMine(null, err.message); return; }
            renderMine((data && data.items) || [], '', myInstallUuid);
        });
    }

    // 动态码倒计时文本（剩余 mm:ss；归零自动静默刷新列表换新码）
    function fmtLeft(sec) {
        if (sec < 0) sec = 0;
        var m = Math.floor(sec / 60), s = sec % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function renderMine(items, errMsg, myInstallUuid) {
        if (codeTimer) { clearInterval(codeTimer); codeTimer = 0; }
        mineWrap.innerHTML = '';
        if (errMsg) {
            mineEmptyText.textContent = errMsg;
            mineEmpty.classList.remove('hidden');
            if (!items || !items.length) return;
        } else {
            mineEmpty.classList.add('hidden');
        }
        if (!items || !items.length) {
            mineEmptyText.textContent = isPC() ? T('暂无已注册设备') : T('本账号还没有已注册的电脑设备');
            mineEmpty.classList.remove('hidden');
            return;
        }
        mineEmpty.classList.add('hidden');
        var now = Math.floor(Date.now() / 1000);
        items.forEach(function (d) {
            var card = document.createElement('div');
            card.className = 'rc-device-card';
            var left = d.dyn_code ? (d.dyn_expire - now) : 0;
            var onlineTxt = d.online ? T('在线') : T('离线');
            card.innerHTML =
                '<div class="rc-dev-head">' +
                '<span class="rc-dev-name">' + esc(d.device_name || T('未命名设备')) + '</span>' +
                '<span class="rc-dev-dot ' + (d.online ? 'on' : '') + '"></span><span class="rc-dev-online">' + onlineTxt + '</span>' +
                '</div>' +
                '<div class="rc-dev-row"><span class="rc-dev-label">' + T('设备ID') + '</span>' +
                '<span class="rc-dev-id" data-copy="' + esc(d.device_id) + '">' + esc(d.device_id) + '<span class="rc-copy-ico" title="' + T('复制') + '">⧉</span></span></div>' +
                '<div class="rc-dev-row"><span class="rc-dev-label">' + T('验证码') + '</span>' +
                '<span class="rc-dev-code">' + esc(d.dyn_code || '—') +
                (d.dyn_code ? ' <span class="rc-code-left" data-expire="' + d.dyn_expire + '">' + T('剩余') + ' ' + fmtLeft(left) + '</span>' : '') +
                '</span></div>' +
                '<div class="rc-dev-actions">' +
                '<button class="rc-tb-btn rc-btn-connect" data-id="' + esc(d.device_id) + '">' + T('连接此设备') + '</button>' +
                (d.online ? '<button class="rc-tb-btn rc-btn-refresh">' + T('刷新验证码') + '</button>' : '') +
                '<button class="rc-tb-btn rc-btn-pw" data-enabled="' + (d.static_pw_enabled ? '1' : '') + '">' + (d.static_pw_enabled ? T('修改访问密码') : T('设置访问密码')) + '</button>' +
                '</div>' +
                '<div class="rc-pw-form hidden">' +
                '<input class="rc-input rc-pw-input" type="text" maxlength="32" placeholder="' + T('6-32 位字母或数字，留空=清除') + '">' +
                '<span class="rc-pw-btns"><button class="rc-tb-btn rc-pw-save">' + T('保存') + '</button>' +
                '<button class="rc-tb-btn rc-pw-cancel">' + T('取消') + '</button></span>' +
                '</div>';
            mineWrap.appendChild(card);
        });
        // 非 PC 端"我的电脑"仅展示 + 连接预填（刷新码/静态密码需 install_uuid，仅本机 PC 可操作）
        if (!isPC()) {
            mineWrap.querySelectorAll('.rc-btn-refresh,.rc-btn-pw,.rc-pw-form').forEach(function (el) { el.remove(); });
        }
        // 倒计时归零静默刷新（换新码）
        codeTimer = setInterval(function () {
            var n = Math.floor(Date.now() / 1000);
            var expired = false;
            mineWrap.querySelectorAll('.rc-code-left').forEach(function (el) {
                var l = parseInt(el.getAttribute('data-expire'), 10) - n;
                if (l <= 0) { expired = true; return; }
                el.textContent = T('剩余') + ' ' + fmtLeft(l);
            });
            if (expired && curPage === 'mine') fetchMy(myInstallUuid);
        }, 1000);
        bindMineEvents(myInstallUuid);
    }

    function bindMineEvents(myInstallUuid) {
        mineWrap.querySelectorAll('.rc-dev-id').forEach(function (el) {
            el.addEventListener('click', function () {
                var id = el.getAttribute('data-copy');
                try {
                    (navigator.clipboard ? navigator.clipboard.writeText(id) : Promise.reject()).then(function () {
                        toast(T('设备ID已复制'));
                    }, function () { toast(id); });
                } catch (e) { toast(id); }
            });
        });
        mineWrap.querySelectorAll('.rc-btn-connect').forEach(function (btn) {
            btn.addEventListener('click', function () {
                showPage('connect');
                inDevice.value = btn.getAttribute('data-id');
                inCode.value = '';
                inCode.focus();
            });
        });
        mineWrap.querySelectorAll('.rc-device-card').forEach(function (card) {
            var rf = card.querySelector('.rc-btn-refresh');
            if (rf) rf.addEventListener('click', function () {
                if (!isPC()) return;
                window.desktop.rcGetInstallInfo().then(function (info) {
                    apiPost('device/refresh_code', { install_uuid: info.install_uuid }, function (err, data) {
                        if (err) { toast(err.message); return; }
                        toast(T('验证码已刷新'));
                        fetchMy(info.install_uuid);
                    });
                });
            });
            var pw = card.querySelector('.rc-btn-pw');
            var form = card.querySelector('.rc-pw-form');
            if (pw && form) {
                pw.addEventListener('click', function () { form.classList.toggle('hidden'); });
                var save = form.querySelector('.rc-pw-save');
                var cancel = form.querySelector('.rc-pw-cancel');
                var input = form.querySelector('.rc-pw-input');
                cancel.addEventListener('click', function () { form.classList.add('hidden'); input.value = ''; });
                save.addEventListener('click', function () {
                    if (!isPC()) return;
                    window.desktop.rcGetInstallInfo().then(function (info) {
                        apiPost('device/static_pw', { install_uuid: info.install_uuid, password: input.value.trim() }, function (err, data) {
                            if (err) { toast(err.message); return; }
                            toast(data && data.static_pw_enabled ? T('访问密码已设置') : T('访问密码已清除'));
                            form.classList.add('hidden'); input.value = '';
                            fetchMy(info.install_uuid);
                        });
                    });
                });
            }
        });
    }

    // ===== 手机端远程控制首页（设备卡片优先 + 一键直连） =====
    function loadHome() {
        if (!u()) return;
        apiGet('device/my', function (err, data) {
            if (err) { renderHome(null, err.message); return; }
            renderHome((data && data.items) || [], '');
        });
    }
    function renderHome(items, errMsg) {
        if (codeTimer) { clearInterval(codeTimer); codeTimer = 0; }
        if (!homeDevices) return;
        homeDevices.innerHTML = '';
        if (errMsg) {
            homeEmptyText.textContent = errMsg;
            homeEmpty.classList.remove('hidden');
            if (!items || !items.length) return;
        }
        if (!items || !items.length) {
            homeEmptyText.textContent = T('还没有可控制的电脑');
            homeEmpty.classList.remove('hidden');
            bindHomeCountdown();
            return;
        }
        homeEmpty.classList.add('hidden');
        var now = Math.floor(Date.now() / 1000);
        items.forEach(function (d) {
            var left = d.dyn_code ? (d.dyn_expire - now) : 0;
            var onlineTxt = d.online ? T('在线') : T('离线');
            var card = document.createElement('div');
            card.className = 'rc-home-card' + (d.online ? ' online' : '');
            card.innerHTML =
                '<div class="rc-home-card-head">' +
                '<span class="rc-home-dev-ico"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h7v2H8v2h8v-2h-3v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg></span>' +
                '<span class="rc-home-dev-name">' + esc(d.device_name || T('未命名设备')) + '</span>' +
                '<span class="rc-dev-dot ' + (d.online ? 'on' : '') + '"></span><span class="rc-home-dev-online">' + onlineTxt + '</span>' +
                '</div>' +
                '<div class="rc-home-dev-id" data-copy="' + esc(d.device_id) + '">' + T('设备ID') + ' ' + esc(d.device_id) + '</div>' +
                '<button class="rc-home-connect-btn" data-id="' + esc(d.device_id) + '" data-code="' + esc(d.dyn_code || '') + '" data-expire="' + (d.dyn_expire || 0) + '"' + (d.online ? '' : ' disabled') + '>' +
                (d.online ? T('远程控制') : T('设备离线')) + '</button>';
            homeDevices.appendChild(card);
        });
        bindHomeCountdown();
    }
    // 首页设备码倒计时归零静默刷新（换新码；与 PC mine 页同口径，仅 curPage=home 时触发）
    function bindHomeCountdown() {
        codeTimer = setInterval(function () {
            if (curPage !== 'home') return;
            var n = Math.floor(Date.now() / 1000);
            var expired = false;
            homeDevices.querySelectorAll('.rc-home-connect-btn').forEach(function (b) {
                var exp = parseInt(b.getAttribute('data-expire'), 10) || 0;
                if (exp && exp - n <= 0) expired = true;
            });
            if (expired) loadHome();
        }, 1000);
    }
    function bindHomeEvents() {
        var cConnect = document.getElementById('rc-home-connect');
        var cRecords = document.getElementById('rc-home-records');
        if (cConnect) cConnect.addEventListener('click', function () { showPage('connect'); });
        if (cRecords) cRecords.addEventListener('click', function () { showPage('records'); });
        if (!homeDevices) return;
        homeDevices.addEventListener('click', function (e) {
            var idEl = e.target.closest('.rc-home-dev-id');
            if (idEl) {
                var id = idEl.getAttribute('data-copy');
                try {
                    (navigator.clipboard ? navigator.clipboard.writeText(id) : Promise.reject()).then(function () { toast(T('设备ID已复制')); }, function () { toast(id); });
                } catch (err) { toast(id); }
                return;
            }
            var btn = e.target.closest('.rc-home-connect-btn');
            if (btn && !btn.disabled) homeQuickConnect(btn);
        });
    }
    // 一键直连：ID + 动态码免手输（码缺失/剩余<10s/离线 → 跳连接页预填 ID 手输）
    function homeQuickConnect(btn) {
        if (connecting) return;
        var id = btn.getAttribute('data-id') || '';
        var code = btn.getAttribute('data-code') || '';
        var exp = parseInt(btn.getAttribute('data-expire'), 10) || 0;
        var left = exp ? (exp - Math.floor(Date.now() / 1000)) : 0;
        if (!code || left < 10) {
            showPage('connect');
            inDevice.value = id; inCode.value = ''; inCode.focus();
            setStatus(T('验证码即将过期，请重新获取或手输'), '');
            return;
        }
        connecting = true;
        btn.disabled = true;
        var oldTxt = btn.textContent;
        btn.textContent = T('连接中…');
        window.rcConnect(id, code, function (ok, reason) {
            connecting = false;
            btn.disabled = false;
            btn.textContent = oldTxt;
            if (ok) toast(T('已接通，正在建立屏幕通道…'));
            else toast(TR(reason || T('连接失败')));
        });
    }

    // ===== 连接远端 =====
    function setStatus(text, kind) {
        if (!text) { connectStatus.classList.add('hidden'); return; }
        connectStatus.textContent = text;
        connectStatus.classList.remove('hidden');
        connectStatus.classList.toggle('err', kind === 'err');
        connectStatus.classList.toggle('ok', kind === 'ok');
    }
    function doConnect() {
        if (connecting) return;
        var id = (inDevice.value || '').trim();
        var code = (inCode.value || '').trim();
        if (!/^[0-9]{9,10}$/.test(id)) { setStatus(T('设备ID格式无效（9-10 位数字）'), 'err'); return; }
        if (!code) { setStatus(T('请输入验证码'), 'err'); return; }
        connecting = true;
        connectBtn.disabled = true;
        setStatus(T('正在连接，请稍候…'), '');
        window.rcConnect(id, code, function (ok, reason) {
            connecting = false;
            connectBtn.disabled = false;
            if (ok) {
                setStatus(T('已接通，正在建立屏幕通道…'), 'ok');
                setTimeout(function () { if (curPage === 'connect') setStatus(''); }, 4000);
            } else {
                setStatus(TR(reason || T('连接失败')), 'err');
            }
        });
    }

    // ===== 控制记录 =====
    var RC_STATUS = { connected: '已接通', missed: '未接通', rejected: '已拒绝', canceled: '已取消' };
    function fmtDur(sec) {
        sec = Math.max(0, sec | 0);
        var m = Math.floor(sec / 60), s = sec % 60;
        if (m >= 60) { var h = Math.floor(m / 60); return h + T('小时') + (m % 60) + T('分'); }
        return m + T('分') + s + T('秒');
    }
    function fmtTime(unix) {
        var d = new Date(unix * 1000);
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function loadRecords() {
        recordsList.innerHTML = '';
        apiGet('records', function (err, data) {
            if (err) { recordsEmpty.textContent = err.message; recordsEmpty.classList.remove('hidden'); return; }
            var items = (data && data.items) || [];
            if (!items.length) { recordsEmpty.textContent = T('暂无数据'); recordsEmpty.classList.remove('hidden'); return; }
            recordsEmpty.classList.add('hidden');
            items.forEach(function (r) {
                var row = document.createElement('div');
                row.className = 'rc-record-row';
                var role = r.requester === u() ? T('我控制') : T('对方控制');
                var who = r.requester === u() ? (r.device_id || r.peer) : r.requester;
                row.innerHTML =
                    '<span class="rc-record-time">' + fmtTime(r.create_time) + '</span>' +
                    '<span class="rc-record-main">' + role + ' ' + esc(who) + '</span>' +
                    '<span class="rc-record-dur">' + fmtDur(r.duration) + '</span>' +
                    '<span class="rc-record-status st-' + esc(r.status) + '">' + TR(RC_STATUS[r.status] || r.status) + '</span>';
                recordsList.appendChild(row);
            });
        });
    }

    // ===== 打开 / 关闭 =====
    function open() {
        if (mainChatEl && view.parentElement !== mainChatEl) mainChatEl.appendChild(view);
        visible = true;
        view.classList.remove('hidden');
        connecting = false;
        connectBtn.disabled = false;
        setStatus('');
        // 手机端：设备卡片优先首页；PC：默认看本机识别码；Web 无桥：默认连接页
        showPage(isMobile() ? 'home' : (isPC() ? 'mine' : 'connect'));
    }
    function close() {
        visible = false;
        if (codeTimer) { clearInterval(codeTimer); codeTimer = 0; }
        if (document.documentElement.classList.contains('m')) {
            setTimeout(function () { if (!visible) view.classList.add('hidden'); }, 260);
        } else {
            view.classList.add('hidden');
        }
    }
    function isOpen() { return visible; }

    // 返回分级（手机端）：子页（connect/records/mine）→ 回首页；首页 → 关页交 mobile.js exitChat。
    // PC 端：直接关页回聊天（行为不变）。返回 true 表示已回到 home（视图仍开着），false 表示已关页。
    function goBack() {
        if (isMobile() && curPage !== 'home') { showPage('home'); return true; }
        close();
        return false;
    }

    // ===== 事件绑定 =====
    var entries = [
        ['rc-entry-mine', 'mine'],
        ['rc-entry-connect', 'connect'],
        ['rc-entry-records', 'records']
    ];
    entries.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el) el.addEventListener('click', function () { showPage(pair[1]); });
    });
    bindHomeEvents();
    closeBtn.addEventListener('click', function () {
        // 手机端子页返回只回首页，不关页；关页时交给 mobile.js 的 #rc-close 委托 exitChat
        if (goBack()) return;
        if (!isMobile()) {
            var chatTab = document.querySelector('.nav-icon[data-tab="chat"]');
            if (chatTab) chatTab.click();
        }
    });
    refreshBtn.addEventListener('click', function () {
        if (curPage === 'mine') loadMine();
        else if (curPage === 'records') loadRecords();
    });
    connectBtn.addEventListener('click', doConnect);
    [inDevice, inCode].forEach(function (inp) {
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConnect(); });
    });

    window.IMRC = { open: open, close: close, isOpen: isOpen };
})();
