// merchant.js - 商户后台（游戏入驻运营控制台）
// 运行环境：普通浏览器（同源 /api/merchant/*，Bearer 会话 im_merchant_token）。
// 主题跟随主界面（localStorage im_theme），全部颜色引用 style.css 现有主题变量；
// 滚动条复用全站自绘悬浮滑块（.osb-thumb）；确认/提示一律自绘弹窗与 Toast，禁止 alert/confirm/prompt。
// 版本上传：整文件 SHA-256（crypto.subtle，须 https/localhost 安全上下文）→ 8MB 分片顺序直传
// → 版本登记（服务端合并复算校验；会话归属绑定登录身份）。
(function () {
    'use strict';

    var TOKEN_KEY = 'im_merchant_token';
    var CHUNK = 8 << 20; // 8MB 分片（与服务端默认一致）

    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }
    function esc(s) { // HTML 转义（商户可控文本入 innerHTML 前统一转义，防自注入 XSS）
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtPts(v) {
        var s = Number(v || 0).toFixed(3);
        if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s || '0';
    }
    function fmtSize(n) {
        if (!n || n <= 0) return '—';
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        return Math.max(1, Math.round(n / 1024)) + ' KB';
    }

    // ==================== API 归口（Bearer；401 统一回登录） ====================
    function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
    function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ } }

    function api(method, path, body) {
        var opts = { method: method || 'GET', headers: { 'Authorization': 'Bearer ' + getToken() } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        return fetch(path, opts).then(function (r) {
            if (r.status === 401) { clearToken(); showLogin(); }
            return r.json().catch(function () { return { ok: false, msg: '网络异常' }; }).then(function (result) {
                // adminJSON 统一返回 {"ok":true, "data":{业务字段}}；把 data 平铺到顶层，
                // 这样 result.list / result.account / result.app_secret 都能直接取，
                // 避免每个调用点都写 result.data.xxx（与 official_admin.js 保持一致）
                if (result && result.ok && result.data && typeof result.data === 'object') {
                    var flat = {};
                    for (var k in result.data) {
                        if (Object.prototype.hasOwnProperty.call(result.data, k)) flat[k] = result.data[k];
                    }
                    flat.ok = true;
                    if (result.msg) flat.msg = result.msg;
                    return flat;
                }
                return result;
            });
        }).catch(function () { return { ok: false, msg: '网络异常，请稍后重试' }; });
    }
    function unwrap(res) {
        // api() 已将 adminJSON 的 data 层平铺到顶层，成功时 res 即业务字段 + ok:true
        if (res && res.ok) return res;
        toast((res && res.msg) || '操作失败');
        throw new Error((res && res.msg) || 'failed');
    }

    // ==================== Toast / 确认弹窗（自绘，无系统弹窗） ====================
    var toastTimer = null;
    function toast(text) {
        var t = $('m-toast');
        t.textContent = text;
        t.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
    }
    var confirmCb = null;
    function showConfirm(title, text, onOk, danger) {
        $('m-modal-title').textContent = title;
        $('m-modal-text').textContent = text;
        var ok = $('m-modal-ok');
        ok.textContent = '确定';
        ok.classList.toggle('primary', !danger);
        confirmCb = onOk;
        $('m-modal-mask').classList.remove('hidden');
    }
    $('m-modal-ok').addEventListener('click', function () {
        var cb = confirmCb;
        $('m-modal-mask').classList.add('hidden');
        confirmCb = null;
        if (cb) cb();
    });
    $('m-modal-cancel').addEventListener('click', function () {
        $('m-modal-mask').classList.add('hidden');
        confirmCb = null;
    });

    // ==================== 自绘悬浮滚动条（.osb-thumb 精简版，纵向） ====================
    function osbInit(el) {
        if (el._osb) return;
        el._osb = true;
        var thumb = document.createElement('div');
        thumb.className = 'osb-thumb';
        document.body.appendChild(thumb);

        function update() {
            var sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop;
            if (sh <= ch + 1 || ch === 0) { thumb.style.display = 'none'; return; }
            var rect = el.getBoundingClientRect();
            if (rect.height === 0) { thumb.style.display = 'none'; return; }
            thumb.style.display = 'block';
            var h = Math.max(30, Math.round(ch * ch / sh));
            if (h > ch - 4) h = Math.max(12, ch - 4);
            var maxTop = ch - h - 2;
            var top = 2 + Math.round(st / Math.max(1, sh - ch) * (maxTop - 2));
            thumb.style.height = h + 'px';
            thumb.style.top = Math.round(rect.top + top) + 'px';
            thumb.style.left = Math.round(rect.right - 8) + 'px';
        }
        el._osbUpdate = update;
        el.addEventListener('scroll', function () {
            if (!el._osbRaf) el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; update(); });
        }, { passive: true });
        if (window.ResizeObserver) new ResizeObserver(update).observe(el);
        thumb.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var startY = e.clientY, startTop = el.scrollTop;
            function move(ev) {
                var maxTop = el.clientHeight - thumb.offsetHeight - 2;
                el.scrollTop = startTop + (ev.clientY - startY) * (el.scrollHeight - el.clientHeight) / Math.max(1, maxTop - 2);
            }
            function up() {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            }
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
        update();
    }

    // ==================== 视图切换 / 启动 ====================
    var profile = null;
    var maxFilesLimit = 5000; // 单版本文件清单条数上限，默认 5000，loadQuota 从服务端 profile 接口拉取动态值（-1=不限）
    var gamesRefreshTimer = null;
    var GAMES_REFRESH_MS = 10000; // "我的游戏"列表定时刷新（兜底轮询：WS 没接时每 10s 自动拉取最新审核状态）
    function startGamesRefresh() {
        stopGamesRefresh();
        gamesRefreshTimer = setInterval(function () { loadGames(true); }, GAMES_REFRESH_MS);
    }
    function stopGamesRefresh() {
        if (gamesRefreshTimer) {
            clearInterval(gamesRefreshTimer);
            gamesRefreshTimer = null;
        }
    }
    function showLogin() {
        stopGamesRefresh();
        $('m-boot').classList.add('hidden'); // 启动骨架层归口隐藏（boot 无 token 分支直接 return，若不在此处隐藏会永久盖住登录页）
        $('m-main').classList.add('hidden');
        $('m-login').classList.remove('hidden');
    }
    function showMain() {
        $('m-boot').classList.add('hidden');
        $('m-login').classList.add('hidden');
        $('m-main').classList.remove('hidden');
        $('m-who').textContent = (profile && (profile.name || profile.username)) || '—';
        switchView('games');
        osbInit($('m-scroll'));
    }
    function switchView(v) {
        var names = ['games', 'stats', 'official', 'gateway'];
        names.forEach(function (n) {
            $('m-view-' + n).classList.toggle('hidden', n !== v);
        });
        var items = $('m-nav').querySelectorAll('.m-nav-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', items[i].getAttribute('data-view') === v);
        }
        if (v === 'games') {
            loadGames();
            startGamesRefresh();
        } else {
            stopGamesRefresh();
            if (v === 'stats') loadStats();
            else if (v === 'official') loadMoffList();
        }
    }
    $('m-nav').addEventListener('click', function (e) {
        var btn = e.target.closest('.m-nav-item');
        if (btn) switchView(btn.getAttribute('data-view'));
    });

    // ==================== 登录 / 登出 ====================
    $('m-login-btn').addEventListener('click', doLogin);
    $('m-login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    function doLogin() {
        var u = $('m-login-username').value.trim();
        var p = $('m-login-password').value;
        if (!u || !p) { toast('请输入账号与密码'); return; }
        fetch('/api/merchant/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        }).then(function (r) { return r.json(); }).then(function (r) {
            if (!r.ok) { toast(r.msg || '登录失败'); return; }
            try { localStorage.setItem(TOKEN_KEY, r.data.token); } catch (eSet) { /* 忽略 */ }
            profile = { username: r.data.username, name: r.data.merchant_name || r.data.nickname };
            $('m-login-password').value = '';
            showMain();
        }).catch(function () { toast('网络异常，请稍后重试'); });
    }
    $('m-logout').addEventListener('click', function () {
        api('POST', '/api/merchant/logout').catch(function () { /* 忽略 */ });
        clearToken();
        showLogin();
    });

    // ==================== 我的游戏 ====================
    var games = [];
    var AUDIT_TEXT = { 0: ['off', '官方'], 1: ['pending', '待审核'], 2: ['ok', '已通过'], 3: ['rej', '已驳回'], 4: ['rej', '隔离中（病毒扫描检出）'] };
    var STATUS_BADGE = { 0: ['on', '上架中'], 1: ['offshelf', '已下架'] };

    var _gamesLoading = false;
    function loadGames(silent) {
        if (_gamesLoading) return; // 上一轮还没返回 → 跳过（防慢网并发积压）
        _gamesLoading = true;
        var box = $('m-game-list');
        if (!silent) box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/games?page=1&size=100').then(function (res) {
            _gamesLoading = false;
            var d = unwrap(res);
            games = d.list || [];
            renderGames();
        }).catch(function () {
            _gamesLoading = false;
            if (!silent) box.innerHTML = '<div class="m-empty">加载失败</div>';
        });
        loadQuota();
    }

    // 存储配额（安全加固）：已用/总量/占比进度条；不限量（quota=-1）显示"不限量"无占比；
    // 占比 ≥80% 进度条转警示色，提示商户先删旧版本腾额度再上架
    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n >= 1099511627776) return (n / 1099511627776).toFixed(2) + 'TB';
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
        if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
        return n + 'B';
    }
    function loadQuota() {
        api('GET', '/api/merchant/profile').then(function (res) {
            var d = unwrap(res);
            // 顺便获取文件清单条数上限（管理员可后台调整，实时生效）
            if (typeof d.max_files_per_version === 'number') maxFilesLimit = d.max_files_per_version;
            var txt = $('m-quota-txt'), fill = $('m-quota-fill');
            // 同步更新文件清单上限提示行
            var filesHint = $('m-files-hint');
            if (filesHint) {
                filesHint.textContent = '单版本文件清单上限：' + (maxFilesLimit === -1 ? '不限' : maxFilesLimit + ' 项');
            }
            if (!txt || !fill) return;
            var used = d.storage_used_bytes || 0, quota = d.storage_quota_bytes;
            if (quota === -1 || quota === undefined || quota === null || quota <= 0) {
                txt.textContent = '已用 ' + fmtBytes(used) + ' / 不限量';
                fill.style.width = '0%';
                fill.classList.remove('warn');
                return;
            }
            var pct = used / quota * 100;
            txt.textContent = '已用 ' + fmtBytes(used) + ' / ' + fmtBytes(quota) + '（' + pct.toFixed(1) + '%）';
            fill.style.width = Math.min(100, pct) + '%';
            fill.classList.toggle('warn', pct >= 80);
        }).catch(function () { /* 静默：配额条保持占位 */ });
    }
    function auditBadge(a) {
        var def = AUDIT_TEXT[a] || ['pending', '待审核'];
        return '<span class="m-badge ' + def[0] + '">' + esc(def[1]) + '</span>';
    }
    function renderGames() {
        var box = $('m-game-list');
        if (!games.length) {
            box.innerHTML = '<div class="m-empty">还没有游戏，点击右上角「+ 新增游戏」开始入驻</div>';
            return;
        }
        box.innerHTML = '';
        games.forEach(function (g) {
            var card = el('div', 'm-game-card');
            var cover;
            if (g.cover) {
                cover = el('img', 'm-game-cover');
                cover.src = g.cover;
                cover.alt = '';
            } else {
                cover = el('div', 'm-game-cover-ph', (g.name || '?').charAt(0));
            }
            card.appendChild(cover);
            var body = el('div', 'm-game-body');
            var nameRow = el('div', 'm-game-name');
            nameRow.appendChild(el('span', '', g.name));
            nameRow.appendChild(document.createElement('span')).outerHTML = auditBadge(g.audit_status);
            body.appendChild(nameRow);
            body.appendChild(el('div', 'm-game-slug', '#' + g.id + ' · ' + g.slug));
            var stDef = STATUS_BADGE[g.status] || STATUS_BADGE[1];
            var meta = el('div', 'm-game-meta');
            meta.appendChild(document.createElement('span')).outerHTML = '<span class="m-badge ' + stDef[0] + '">' + stDef[1] + '</span>';
            meta.appendChild(el('span', '', '　版本 ' + (g.latest_version || '无') + ' · ' + fmtSize(g.size_bytes) +
                (g.recharge_enabled ? ' · 赞助开放（汇率 ' + fmtPts(g.recharge_rate) + '）' : ' · 赞助未开放')));
            body.appendChild(meta);
            if (g.audit_status === 3 && g.audit_remark) {
                body.appendChild(el('div', 'm-badge-remark', '驳回理由：' + g.audit_remark));
            }
            var acts = el('div', 'm-game-acts');
            var bEdit = el('button', 'admin-btn small', g.audit_status === 1 || g.audit_status === 3 ? '继续编辑' : '编辑');
            bEdit.addEventListener('click', function () { openGameEditor(g); });
            var bVer = el('button', 'admin-btn small', '版本管理');
            bVer.addEventListener('click', function () { openVersion(g); });
            var bNo = el('button', 'admin-btn small', '公告');
            bNo.addEventListener('click', function () { openNotice(g); });
            var bSt = el('button', 'admin-btn small ' + (g.status === 0 ? '' : 'primary'), g.status === 0 ? '下架' : '申请上架');
            bSt.addEventListener('click', function () { toggleStatus(g); });
            acts.appendChild(bEdit);
            acts.appendChild(bVer);
            acts.appendChild(bNo);
            acts.appendChild(bSt);
            body.appendChild(acts);
            card.appendChild(body);
            box.appendChild(card);
        });
    }
    function toggleStatus(g) {
        var target = g.status === 0 ? 1 : 0;
        var tip = target === 1 ? '下架后玩家端立即不可发现（已入库玩家保留）' : '上架需游戏已通过审核';
        showConfirm(g.status === 0 ? '下架游戏' : '上架游戏', '「' + g.name + '」' + tip, function () {
            api('POST', '/api/merchant/games/' + g.id + '/status', { status: target }).then(function (res) {
                unwrap(res);
                toast(target === 1 ? '已下架' : '已上架');
                loadGames();
            }).catch(function () { /* toast 已提示 */ });
        }, target === 1);
    }

    // ==================== 新增/编辑游戏 ====================
    var editingGame = null; // null=新增
    var ssList = []; // 截图 URL 列表
    $('m-game-add').addEventListener('click', function () { openGameEditor(null); });
    function openGameEditor(g) {
        editingGame = g || null;
        ssList = [];
        $('m-game-title').textContent = g ? '编辑游戏 — ' + g.name : '新增游戏';
        $('m-f-name').value = g ? g.name : '';
        $('m-f-slug').value = g ? g.slug : '';
        $('m-f-slug').disabled = !!g;
        $('m-f-short').value = g ? (g.short_desc || '') : '';
        $('m-f-desc').value = '';
        $('m-f-tags').value = '';
        $('m-f-dev').value = '';
        $('m-f-pub').value = '';
        $('m-f-price').value = g ? (g.price || 0) : 0;
        $('m-f-exe').value = '';
        $('m-f-exename').value = '';
        $('m-f-exeargs').value = '';
        $('m-f-rgw').checked = g ? !!g.recharge_enabled : false;
        $('m-f-rgw-rate').value = g && g.recharge_rate ? g.recharge_rate : 1;
        $('m-f-rgw-daily').value = 0;
        $('m-f-rgw-tiers').value = '';
        $('m-f-rgw-gw').value = '';
        // 下载方式回填（商户直连·安全加固）：0=平台分发 / 3=直连 HTTP；联动地址行显隐
        var dm = g ? (Number(g.download_method) || 0) : 0;
        setFormDM(dm === 3 ? '3' : '0', g ? (g.direct_base_url || '') : '');
        // 编辑态：列表接口按全量口径下发（服务端归口），直接从缓存取本行回填
        if (g) {
            var full = null;
            for (var i = 0; i < games.length; i++) if (games[i].id === g.id) full = games[i];
            if (full) fillEditorFromCache(full);
        }
        $('m-f-cover').value = g ? (g.cover || '') : '';
        refreshCoverPrev();
        refreshSsTip();
        $('m-game-tip').textContent = g && g.audit_status === 2
            ? '保存后将回到待审核，审核通过前玩家继续看到现有内容'
            : '提交后进入待审核，管理员审核通过后玩家可见';
        $('m-game-mask').classList.remove('hidden');
        osbInit($('m-game-mask').querySelector('.m-modal'));
    }
    function fillEditorFromCache(full) {
        $('m-f-desc').value = full.description || '';
        $('m-f-tags').value = full.tags || '';
        $('m-f-dev').value = full.developer || '';
        $('m-f-pub').value = full.publisher || '';
        $('m-f-exe').value = full.launch_exe || '';
        $('m-f-exename').value = full.launch_name || '';
        $('m-f-exeargs').value = full.launch_args || '';
        $('m-f-rgw-rate').value = full.recharge_rate || 1;
        $('m-f-rgw-daily').value = full.recharge_daily_max || 0;
        $('m-f-rgw-tiers').value = full.recharge_tiers_raw || '';
        $('m-f-rgw-gw').value = full.recharge_gw || '';
        setFormDM(Number(full.download_method) === 3 ? '3' : '0', full.direct_base_url || '');
        try { ssList = JSON.parse(full.screenshots || '[]') || []; } catch (eSs) { ssList = []; }
        refreshSsTip();
    }
    function refreshCoverPrev() {
        var v = $('m-f-cover').value.trim();
        var img = $('m-f-cover-prev');
        if (v) { img.src = v; img.classList.remove('hidden'); }
        else img.classList.add('hidden');
    }

    // 下载方式表单联动（商户直连·安全加固）：radio 显隐地址行
    function setFormDM(v, baseURL) {
        var radios = document.querySelectorAll('input[name="m-f-dm"]');
        for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === v;
        $('m-f-direct-row').classList.toggle('hidden', v !== '3');
        $('m-f-direct-url').value = baseURL || '';
    }
    (function () {
        var radios = document.querySelectorAll('input[name="m-f-dm"]');
        for (var i = 0; i < radios.length; i++) {
            radios[i].addEventListener('change', function () {
                setFormDM(this.value, $('m-f-direct-url').value);
            });
        }
        // 直连模式使用说明（与 gametool-help.html 同模式：新开说明页，商户照步骤操作）
        var dh = document.getElementById('m-f-direct-help');
        if (dh) dh.addEventListener('click', function () { window.open('/merchant-direct-help.html', '_blank'); });
    })();

    // 图片上传归口（封面/截图/公告图共用 /api/merchant/upload/image）
    function uploadImage(file) {
        var fd = new FormData();
        fd.append('file', file);
        return fetch('/api/merchant/upload/image', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd
        }).then(function (r) { return r.json(); }).then(function (r) {
            if (!r.ok) throw new Error(r.msg || '上传失败');
            return r.data.url;
        });
    }
    $('m-f-cover-pick').addEventListener('click', function () { $('m-f-cover-file').click(); });
    $('m-f-cover-file').addEventListener('change', function () {
        var f = this.files[0];
        this.value = '';
        if (!f) return;
        toast('封面上传中…');
        uploadImage(f).then(function (url) {
            $('m-f-cover').value = url;
            refreshCoverPrev();
            toast('封面上传完成');
        }).catch(function (e) { toast(e.message || '封面上传失败'); });
    });
    $('m-f-ss-pick').addEventListener('click', function () { $('m-f-ss-file').click(); });
    $('m-f-ss-file').addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files);
        this.value = '';
        if (!files.length) return;
        if (ssList.length + files.length > 12) { toast('截图最多 12 张'); return; }
        var done = 0;
        toast('截图上传中…');
        files.forEach(function (f) {
            uploadImage(f).then(function (url) {
                ssList.push(url);
                done++;
                if (done === files.length) { refreshSsTip(); toast('截图上传完成'); }
            }).catch(function (e) {
                done++;
                refreshSsTip();
                toast(e.message || '截图上传失败');
            });
        });
    });
    function refreshSsTip() {
        $('m-f-ss').value = JSON.stringify(ssList);
        $('m-f-ss-tip').textContent = ssList.length ? '已上传 ' + ssList.length + ' 张' : '未上传';
    }

    $('m-game-cancel').addEventListener('click', function () { $('m-game-mask').classList.add('hidden'); });
    $('m-game-ok').addEventListener('click', function () {
        var payload = {
            name: $('m-f-name').value.trim(),
            slug: $('m-f-slug').value.trim(),
            short_desc: $('m-f-short').value.trim(),
            description: $('m-f-desc').value,
            tags: $('m-f-tags').value.trim(),
            developer: $('m-f-dev').value.trim(),
            publisher: $('m-f-pub').value.trim(),
            price: Number($('m-f-price').value) || 0,
            cover: $('m-f-cover').value.trim(),
            screenshots: JSON.stringify(ssList),
            launch_exe: $('m-f-exe').value.trim(),
            launch_name: $('m-f-exename').value.trim(),
            launch_args: $('m-f-exeargs').value,
            recharge_enabled: $('m-f-rgw').checked,
            recharge_rate: Number($('m-f-rgw-rate').value) || 0,
            recharge_daily_max: Number($('m-f-rgw-daily').value) || 0,
            recharge_tiers: $('m-f-rgw-tiers').value.trim(),
            recharge_gw: $('m-f-rgw-gw').value.trim(),
            // 下载方式（商户直连·安全加固）：0=平台分发 3=直连 HTTP（base_url 必填校验归服务端）
            download_method: (function () {
                var radios = document.querySelectorAll('input[name="m-f-dm"]');
                for (var i = 0; i < radios.length; i++) if (radios[i].checked) return Number(radios[i].value) || 0;
                return 0;
            })(),
            direct_base_url: $('m-f-direct-url').value.trim()
        };
        if (!payload.name) { toast('请填写游戏名称'); return; }
        if (!editingGame && !payload.slug) { toast('请填写 slug'); return; }
        var btn = $('m-game-ok');
        btn.disabled = true;
        var p = editingGame
            ? api('PUT', '/api/merchant/games/' + editingGame.id, payload)
            : api('POST', '/api/merchant/games', payload);
        p.then(function (res) {
            btn.disabled = false;
            unwrap(res);
            $('m-game-mask').classList.add('hidden');
            toast(editingGame ? '已保存，游戏回到待审核' : '已提交，等待管理员审核');
            loadGames();
        }).catch(function () { btn.disabled = false; });
    });

    // ==================== 版本管理（分片上传） ====================
    var verGame = null;
    var verFiles = []; // {file, rel_path, size, state}
    var verUploading = false, verCancelFlag = false, verStartedIds = [], verAbort = null;
    var verBaseDir = ''; // 最新版文件首段公共目录名（如 War3），单文件上传时自动前缀
    // 上传方式（ZIP 打包新增通道）：0=散文件逐个下载（现状） 1=单 ZIP（下载后自动解压）
    // 2=分卷 ZIP 3=补丁包（GamePatchTool 产出 patch.zip + base_version，服务端解包合成完整清单）
    var verPackType = 0;
    var verVersionRows = []; // loadVersions 缓存（基底版本下拉/导出清单按钮数据源）
    var VER_PACK_TIPS = [
        // 0 散文件 / 3 补丁包 = 逐文件版大类（可补丁增量）；1 单 ZIP / 2 分卷 ZIP = ZIP 完整包大类（不可补丁）
        '完整版·逐文件上传：选整个游戏目录（或多选文件），玩家端逐个下载。此方式的版本可作为后续补丁升级的基底，推荐首发使用。',
        '完整版·整包上传：选 1 个 .zip 上传，玩家端整包下载后自动解压安装。<span class="m-warn-text">⚠ 此方式不支持后续补丁升级（服务端无逐文件清单），后续更新须重新上传完整包或改用散文件方式</span>',
        '完整版·分卷上传：选 game.zip.001 / .002…（7-Zip/WinRAR 标准分卷），玩家端自动分卷解压；需填写解压后总大小。<span class="m-warn-text">⚠ 此方式不支持后续补丁升级，后续更新须重新上传完整分卷或改用散文件方式</span>',
        '增量更新·只传变更：先用下方"导出清单"下载基底版本清单 → 本地用 gametool 生成 patch.zip → 上传；老玩家只下载变更文件（基底须为散文件版或补丁版）'
    ];
    function verSetPack(t) {
        // 直连模式锁定散文件清单（dm=3 一期仅 pack_type=0，服务端同规则兜底）
        if (t !== 0 && verGameDirect()) { toast('直连模式仅支持「散文件目录」方式：版本更新请在商户服务器替换文件后登记新版本完整清单'); return; }
        verPackType = t;
        // 大类联动（0/3=逐文件版，1/2=ZIP 完整包）：大类按钮 active + 子按钮组显隐
        var cat = (t === 1 || t === 2) ? 'zip' : 'file';
        var cats = $('m-ver-catseg').querySelectorAll('.m-cat-btn');
        for (var i = 0; i < cats.length; i++) {
            cats[i].classList.toggle('active', cats[i].getAttribute('data-cat') === cat);
        }
        $('m-ver-pack-file').classList.toggle('hidden', cat !== 'file');
        $('m-ver-pack-zip').classList.toggle('hidden', cat !== 'zip');
        var btns = $('m-ver-packseg').querySelectorAll('.m-packseg-btn');
        for (var j = 0; j < btns.length; j++) {
            btns[j].classList.toggle('active', Number(btns[j].getAttribute('data-pack')) === t);
        }
        $('m-ver-packtip').innerHTML = VER_PACK_TIPS[t] || VER_PACK_TIPS[0];
        $('m-ver-packsize-row').classList.toggle('hidden', t !== 2);
        $('m-ver-base-row').classList.toggle('hidden', t !== 3);
        $('m-ver-tooldown-row').classList.toggle('hidden', t !== 3);
        if (t === 3) verFillBase();
        // ZIP 打包方式清空已选文件（清单语义完全不同：散文件目录树 vs 包本体）
        verFiles = [];
        renderVerList();
    }
    // 大类切换：切到对应组并自动选中该组默认方式（逐文件版→散文件，ZIP 包→单 ZIP）
    function verSetCat(cat) {
        verSetPack(cat === 'zip' ? 1 : 0);
    }
    verSetPack(0); // 初始态归位：填充默认说明与按钮状态（实际入口 openVersion 亦会重置）
    (function () {
        var cats = $('m-ver-catseg').querySelectorAll('.m-cat-btn');
        for (var i = 0; i < cats.length; i++) {
            cats[i].addEventListener('click', function () { verSetCat(this.getAttribute('data-cat')); });
        }
        var btns = $('m-ver-packseg').querySelectorAll('.m-packseg-btn');
        for (var j = 0; j < btns.length; j++) {
            btns[j].addEventListener('click', function () { verSetPack(Number(this.getAttribute('data-pack'))); });
        }
    })();
    // 基底版本下拉填充：仅散文件（0）与补丁版（3）可作基底（ZIP 整包/分卷版无逐文件清单）
    function verFillBase() {
        var sel = $('m-ver-base');
        var cur = sel.value;
        sel.innerHTML = '';
        var opts = 0;
        (verVersionRows || []).forEach(function (v) {
            var pk = Number(v.pack_type) || 0;
            if (pk !== 0 && pk !== 3) return;
            var o = document.createElement('option');
            o.value = v.version;
            o.textContent = 'v' + v.version + (pk === 3 ? '（补丁版）' : '') + ' · ' + fmtSize(v.size_bytes);
            sel.appendChild(o);
            opts++;
        });
        if (!opts) {
            var o = document.createElement('option');
            o.value = '';
            o.textContent = '暂无可用基底版本（请先上传散文件版本）';
            sel.appendChild(o);
        }
        if (cur) sel.value = cur;
    }
    // 分卷命名解析：`前缀.zip.NNN`（3 位数字）→ {prefix, seq}，非法返回 null
    function verSplitVolParse(name) {
        var m = /^(.+)\.zip\.(\d{3})$/i.exec(name);
        return m ? { prefix: m[1].toLowerCase(), seq: Number(m[2]) } : null;
    }
    function openVersion(g) {
        verGame = g;
        verFiles = [];
        verBaseDir = '';
        verCancelFlag = false;
        verSetPack(0); // 直连游戏在 verSetPack 内锁定散文件清单（dm=3 拦截其他方式）
        $('m-ver-packsize').value = '';
        $('m-ver-game').textContent = g.name + (verGameDirect() ? '（直连模式 · 文件不上传）' : '');
        $('m-ver-version').value = '';
        $('m-ver-log').value = '';
        renderVerList();
        $('m-ver-progress').classList.add('hidden');
        $('m-ver-bar').style.width = '0';
        $('m-ver-ok').disabled = false;
        $('m-ver-ok').textContent = verGameDirect() ? '开始登记清单（文件不上传）' : '开始上传并登记版本';
        $('m-ver-mask').classList.remove('hidden');
        loadVersions();
        osbInit($('m-ver-mask').querySelector('.m-modal'));
    }
    function loadVersions() {
        var box = $('m-ver-existing');
        box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/games/' + verGame.id + '/versions').then(function (res) {
            var d = unwrap(res);
            verBaseDir = String(d.base_dir || '').trim();
            var list = d.versions || [];
            verVersionRows = list; // 基底下拉/导出按钮数据源缓存
            if (!list.length) { box.innerHTML = '<div class="m-empty">暂无版本，上传第一个版本后游戏即可安装</div>'; return; }
            var html = '<table class="m-table"><tr><th>版本</th><th>方式</th><th>大小</th><th>文件数</th><th>时间</th><th></th></tr>';
            list.forEach(function (v) {
                var pk = Number(v.pack_type) || 0;
                var pkText = pk === 1 ? '单ZIP' : pk === 2 ? '分卷ZIP' : pk === 3 ? '补丁⇢v' + (v.base_version || '?') : '散文件';
                var pkBadge = pk === 1 ? ' <span class="m-badge ok">ZIP</span>' : pk === 2 ? ' <span class="m-badge ok">分卷ZIP</span>'
                    : pk === 3 ? ' <span class="m-badge ok">补丁</span>' : '';
                // 两阶段版本登记状态徽标（register_state: 0=就绪 1=登记中 2=失败）
                var rs = Number(v.register_state) || 0;
                var rsBadge = '';
                if (rs === 1) {
                    rsBadge = ' <span class="m-badge warn">登记中…</span>';
                } else if (rs === 2) {
                    var errTip = esc(v.register_error || '登记失败');
                    rsBadge = ' <span class="m-badge bad" title="' + errTip + '">失败</span>';
                }
                // 登记中/失败版本禁用导出/删除按钮（导出清单要 GameFile 行，删除登记中版本需等 goroutine 结束）
                var btnsDisabled = rs !== 0 ? ' disabled title="版本未就绪，不可操作"' : '';
                html += '<tr><td>' + esc(v.version) + (v.version === d.latest_version ? ' <span class="m-badge ok">最新</span>' : '') + pkBadge + rsBadge +
                    '</td><td>' + pkText +
                    '</td><td>' + fmtSize(v.size_bytes) + '</td><td>' + v.file_count + '</td><td>' + esc(v.create_time) +
                    '</td><td><button class="admin-btn small m-ver-fl" data-ver="' + esc(v.version) + '"' + btnsDisabled + '>导出清单</button>' +
                    ' <button class="admin-btn small m-ver-del" data-vid="' + v.id + '" data-ver="' + esc(v.version) + '"' + btnsDisabled + '>删除</button></td></tr>';
            });
            box.innerHTML = html + '</table>';
            var fls = box.querySelectorAll('.m-ver-fl');
            for (var j = 0; j < fls.length; j++) {
                fls[j].addEventListener('click', function () {
                    verExportFilelist(this.getAttribute('data-ver'));
                });
            }
            var dels = box.querySelectorAll('.m-ver-del');
            for (var i = 0; i < dels.length; i++) {
                dels[i].addEventListener('click', function () {
                    var vid = this.getAttribute('data-vid'), ver = this.getAttribute('data-ver');
                    showConfirm('删除版本', '删除 v' + ver + '？文件与清单将一并清理，不可恢复', function () {
                        api('DELETE', '/api/merchant/version/' + vid).then(function (res) {
                            unwrap(res);
                            toast('已删除 v' + ver);
                            loadVersions();
                            loadQuota(); // 删除释放配额，进度条即时回退
                        }).catch(function () { /* toast 已提示 */ });
                    }, true);
                });
            }
        }).catch(function () { box.innerHTML = '<div class="m-empty">加载失败</div>'; });
    }
    // 版本清单导出（GamePatchTool -base-list 基准）：fetch 带 Authorization → blob 触发下载
    function verExportFilelist(ver) {
        fetch('/api/merchant/games/' + verGame.id + '/versions/' + encodeURIComponent(ver) + '/filelist', {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
        }).then(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'filelist-' + ver + '.txt';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
            toast('清单已导出：filelist-' + ver + '.txt');
        }).catch(function (e) {
            toast('导出失败：' + (e && e.message ? e.message : '网络异常'));
        });
    }
    // 补丁工具下载（服务端托管 gametool.zip，内含 gametool.exe；与 im-server 同目录）与教程页
    $('m-ver-tooldown').addEventListener('click', function () {
        fetch('/api/merchant/gametool', { headers: { 'Authorization': 'Bearer ' + getToken() } }).then(function (r) {
            if (!r.ok) return r.json().then(function (j) { throw new Error(j.msg || ('HTTP ' + r.status)); });
            return r.blob();
        }).then(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'gametool.zip';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
            toast('补丁工具已开始下载：gametool.zip（解压后使用 gametool.exe）');
        }).catch(function (e) {
            toast('下载失败：' + (e && e.message ? e.message : '网络异常'));
        });
    });
    $('m-ver-toolhelp').addEventListener('click', function () {
        window.open('/gametool-help.html', '_blank');
    });
    function collectFiles(input, useRelPath) {
        var fs = Array.prototype.slice.call(input.files);
        input.value = '';
        if (verPackType > 0) {
            // ZIP 打包方式：清单语义=包本体（非目录树），每次选择整体替换并即时校验命名
            var next = [];
            for (var i = 0; i < fs.length; i++) {
                var f0 = fs[i];
                if (f0.size <= 0) continue;
                next.push({ file: f0, rel_path: f0.name, size: f0.size, state: 0 });
            }
            var err = verPackValidate(next);
            if (err) { toast(err); return; }
            verFiles = next;
            renderVerList();
            return;
        }
        fs.forEach(function (f) {
            if (f.size <= 0) return; // 空文件服务端跳过
            var rel = useRelPath ? (f.webkitRelativePath || f.name) : f.name;
            // 单文件上传（非目录）时，自动前缀最新版的 base_dir，使更新文件落在与原版相同的客户端目录下。
            // 例：原版文件全在 War3/ 下 → base_dir=War3 → 单文件 rel_path 变为 War3/filename
            if (!useRelPath && verBaseDir) rel = verBaseDir + '/' + rel;
            verFiles.push({ file: f, rel_path: rel, size: f.size, state: 0 });
        });
        // 文件清单条数上限预检（管理员可后台调整，maxFilesLimit=-1 不限）
        if (maxFilesLimit !== -1 && verFiles.length > maxFilesLimit) {
            toast('文件清单已达 ' + maxFilesLimit + ' 项上限（当前 ' + verFiles.length + ' 项），多余文件已跳过');
            verFiles = verFiles.slice(0, maxFilesLimit);
        }
        renderVerList();
    }
    // ZIP 打包清单前端预校验（服务端 gameVersionCreateCore 还有同名规则兜底）
    function verPackValidate(list) {
        if (verPackType === 0) return ''; // 散文件：无 ZIP 语义校验（runVersionPublish 无条件调用本函数，须短路防误入分卷命名校验）
        if (verPackType === 1 || verPackType === 3) {
            if (list.length !== 1 || !/\.zip$/i.test(list[0].rel_path)) {
                return verPackType === 3 ? '补丁包方式只能选择 1 个 GamePatchTool 生成的 patch.zip' : '单 ZIP 方式只能选择 1 个 .zip 压缩包';
            }
            return '';
        }
        // 分卷：同前缀、.zip.001 起连续
        if (!list.length) return '请先选择分卷文件';
        var prefix = null, prev = 0;
        for (var i = 0; i < list.length; i++) {
            var v = verSplitVolParse(list[i].rel_path);
            if (!v) return '分卷命名非法：' + list[i].rel_path + '（须为 前缀.zip.001 形式）';
            if (prefix === null) {
                if (v.seq !== 1) return '分卷必须从 .zip.001 开始';
                prefix = v.prefix; prev = 1;
            } else if (v.prefix !== prefix) {
                return '分卷前缀不一致：' + list[i].rel_path;
            } else if (v.seq !== prev + 1) {
                return '分卷序号不连续（缺 ' + ('00' + (prev + 1)).slice(-3) + ' 卷）';
            } else {
                prev = v.seq;
            }
        }
        return '';
    }
    $('m-ver-pick-dir').addEventListener('click', function () { $('m-ver-dir').click(); });
    $('m-ver-pick-files').addEventListener('click', function () { $('m-ver-files').click(); });
    $('m-ver-dir').addEventListener('change', function () { collectFiles(this, true); });
    $('m-ver-files').addEventListener('change', function () { collectFiles(this, false); });
    $('m-ver-clear').addEventListener('click', function () { verFiles = []; renderVerList(); });
    var VER_ST = ['等待', '校验中…', '上传中', '已完成', '失败', '已取消'];
    function renderVerList() {
        var box = $('m-ver-list');
        if (!verFiles.length) { box.innerHTML = '<div class="m-empty">未选择文件</div>'; return; }
        box.innerHTML = '';
        verFiles.forEach(function (f, i) {
            var row = el('div', 'm-ver-item');
            row.appendChild(el('span', 'rel', f.rel_path));
            row.appendChild(el('span', '', fmtSize(f.size)));
            var bar = el('div', 'm-ver-bar-wrap');
            var fill = el('div', 'm-ver-bar-fill');
            bar.appendChild(fill);
            row.appendChild(bar);
            var st = el('span', 'st' + (f.state === 3 ? ' ok' : f.state === 4 ? ' err' : ''), VER_ST[f.state]);
            row.appendChild(st);
            f._bar = fill; f._st = st; f._idx = i;
            box.appendChild(row);
        });
    }
    function verSetState(f, s, cls) {
        f.state = s;
        if (f._st) {
            f._st.textContent = VER_ST[s];
            f._st.className = 'st' + (cls ? ' ' + cls : '');
        }
    }
    // 阶段三百零一：上传日志面板（持久化显示，商户可查看具体哪个文件、什么错误）
    function verLogInit() {
        var wrap = $('m-ver-log-wrap'), body = $('m-ver-log-body'), title = $('m-ver-log-title'), toggle = $('m-ver-log-toggle');
        wrap.classList.remove('hidden', 'open');
        body.classList.add('hidden');
        body.innerHTML = '';
        title.textContent = '上传日志';
        toggle.textContent = '▼';
    }
    function verLogAdd(text, cls) {
        var wrap = $('m-ver-log-wrap'), body = $('m-ver-log-body'), title = $('m-ver-log-title');
        wrap.classList.remove('hidden');
        // 累计计数
        var errCount = (title.getAttribute('data-err') | 0) + (cls === 'err' ? 1 : 0);
        var warnCount = (title.getAttribute('data-warn') | 0) + (cls === 'warn' ? 1 : 0);
        title.setAttribute('data-err', errCount);
        title.setAttribute('data-warn', warnCount);
        var total = errCount + warnCount;
        if (total > 0) title.textContent = '上传日志（' + errCount + ' 失败' + (warnCount > 0 ? ' / ' + warnCount + ' 警告' : '') + '）';
        else title.textContent = '上传日志';
        // 追加行（时间戳 + 内容）
        var row = document.createElement('div');
        row.className = 'm-ver-log-line' + (cls ? ' ' + cls : '');
        var ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        row.textContent = '[' + ts + '] ' + text;
        body.appendChild(row);
        // 自动展开并滚到底
        wrap.classList.add('open');
        body.classList.remove('hidden');
        body.scrollTop = body.scrollHeight;
    }
    // 日志面板折叠/展开
    $('m-ver-log-head').addEventListener('click', function () {
        var wrap = $('m-ver-log-wrap'), body = $('m-ver-log-body'), toggle = $('m-ver-log-toggle');
        if (body.classList.contains('hidden')) {
            body.classList.remove('hidden');
            wrap.classList.add('open');
            toggle.textContent = '▲';
        } else {
            body.classList.add('hidden');
            wrap.classList.remove('open');
            toggle.textContent = '▼';
        }
    });
    $('m-ver-cancel').addEventListener('click', function () {
        if (verUploading) {
            verCancelFlag = true;
            if (verAbort) { try { verAbort.abort(); } catch (e) { /* 忽略 */ } } // 即时断开当前分片
            return;
        }
        $('m-ver-mask').classList.add('hidden');
        loadGames();
    });
    $('m-ver-ok').addEventListener('click', runVersionPublish);
    function verSleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    // 直连模式判定（商户直连·安全加固）：dm=3 时仅登记清单（本地算 SHA256），文件不上传
    function verGameDirect() { return !!(verGame && Number(verGame.download_method) === 3); }
    // 流式 SHA256：分块读取文件喂入 SHA256Stream（js/sha256.js），
    // 避免 f.file.arrayBuffer() 将整文件（GB 级 .dat）一次性压入内存导致 OOM/卡死
    var HASH_CHUNK = 4 << 20; // 4MB 一块
    async function verHashFile(f, onProgress) {
        if (!window.SHA256Stream) throw new Error('SHA256 库未加载');
        var hasher = window.SHA256Stream.create();
        var offset = 0;
        var fileSize = f.size;
        while (offset < fileSize) {
            var end = Math.min(offset + HASH_CHUNK, fileSize);
            var chunk = f.file.slice(offset, end);
            var buf = await chunk.arrayBuffer();
            hasher.update(buf);
            buf = null;
            offset = end;
            if (onProgress) onProgress(offset, fileSize);
            // 每块让出事件循环，避免长任务阻塞 UI
            await new Promise(function (r) { setTimeout(r, 0); });
            if (verCancelFlag) { var xe = new Error('已取消'); xe.cancelled = true; throw xe; }
        }
        var sha = hasher.final();
        console.log('[verHashFile]', f.rel_path, 'size=', f.size, 'sha256=', sha);
        // 如果浏览器支持 crypto.subtle (localhost/https)，同时算一遍对照
        if (window.crypto && window.crypto.subtle && fileSize <= 200 * 1024 * 1024) {
            try {
                var ab = await f.file.arrayBuffer();
                var subtleBuf = await crypto.subtle.digest('SHA-256', ab);
                var hex = Array.from(new Uint8Array(subtleBuf)).map(function (b) {
                    return ('0' + b.toString(16)).slice(-2);
                }).join('');
                console.log('[verHashFile.crypto.subtle]', f.rel_path, 'sha256=', hex, 'match=', hex === sha);
            } catch (e) { /* 忽略 */ }
        }
        return sha;
    }
    // 直连登记单文件：本地流式算 SHA256（不读服务端、不产生 upload_id）
    async function verDirectOne(f) {
        verSetState(f, 1);
        var sha = await verHashFile(f);
        return { rel_path: f.rel_path, size: f.size, sha256: sha };
    }
    async function verUploadOne(f) {
        verSetState(f, 1);
        // 流式 hash（带进度回调，避免大 .dat 文件无反馈像卡死）
        var sha = await verHashFile(f, function (done, total) {
            if (f._bar) f._bar.style.width = Math.round((done / total) * 50) + '%';
        });
        var uploadId = 'mf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        verStartedIds.push(uploadId);
        var total = Math.ceil(f.size / CHUNK);
        for (var seq = 0; seq < total; seq++) {
            if (verCancelFlag) { var xe = new Error('已取消'); xe.cancelled = true; throw xe; }
            verSetState(f, 2);
            var start = seq * CHUNK;
            var chunk = await f.file.slice(start, Math.min(start + CHUNK, f.size)).arrayBuffer();
            for (var attempt = 0; ; attempt++) {
                verAbort = new AbortController();
                var timer = setTimeout(function () { try { verAbort.abort(); } catch (e) { /* 忽略 */ } }, 60000);
                try {
                    var resp = await fetch('/api/merchant/upload/chunk?upload_id=' + encodeURIComponent(uploadId) +
                        '&seq=' + seq + '&total=' + total + '&size=' + f.size, {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/octet-stream' },
                        body: chunk,
                        signal: verAbort.signal
                    });
                    var r = await resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; });
                    if (!r.ok) throw new Error(r.msg || ('HTTP ' + resp.status));
                    break;
                } catch (e) {
                    clearTimeout(timer);
                    verAbort = null;
                    if (e && e.name === 'AbortError') {
                        if (verCancelFlag) { var ce = new Error('已取消'); ce.cancelled = true; throw ce; }
                        e = new Error('上传超时（60s 无响应）');
                    }
                    if (verCancelFlag) { var ce = new Error('已取消'); ce.cancelled = true; throw ce; }
                    if (attempt >= 2) throw e;
                    await verSleep(600 * (attempt + 1));
                }
            }
            clearTimeout(timer);
            verAbort = null;
            if (f._bar) f._bar.style.width = 50 + Math.round(((seq + 1) / total) * 50) + '%';
        }
        return { rel_path: f.rel_path, size: f.size, sha256: sha, upload_id: uploadId };
    }
    async function verCancelStarted() {
        var ids = verStartedIds;
        verStartedIds = [];
        for (var i = 0; i < ids.length; i++) {
            try { await api('POST', '/api/merchant/upload/cancel', { upload_id: ids[i] }); } catch (e) { /* 忽略 */ }
        }
    }
    async function runVersionPublish() {
        if (verUploading) return;
        var isDirect = verGameDirect();
        var version = $('m-ver-version').value.trim();
        if (!version) { toast('请填写版本号'); return; }
        if (!verFiles.length) { toast('请先选择游戏目录或文件'); return; }
        // ZIP 打包方式发布前校验（与清单预校验同规则；分卷需填解压后总大小）
        var packErr = verPackValidate(verFiles);
        if (packErr) { toast(packErr); return; }
        var packSizeBytes = 0;
        if (verPackType === 2) {
            var gb = Number($('m-ver-packsize').value);
            if (!(gb > 0)) { toast('请填写压缩包解压后的总大小（GB）'); return; }
            packSizeBytes = Math.round(gb * 1073741824);
        }
        var baseVer = '';
        if (verPackType === 3) {
            baseVer = $('m-ver-base').value;
            if (!baseVer) { toast('请选择基底版本（无可用基底请先上传散文件版本）'); return; }
        }
        verUploading = true;
        verCancelFlag = false;
        verStartedIds = [];
        verAbort = null;
        verLogInit();
        verLogAdd((isDirect ? '清单计算模式' : '分片上传模式') + '，共 ' + verFiles.length + ' 个文件，版本 v' + version);
        $('m-ver-ok').textContent = isDirect ? '登记中…（仅计算清单，文件不上传）' : '上传中…（再次点击取消）';
        $('m-ver-progress').classList.remove('hidden');
        var okFiles = [], failedList = [], cancelled = false;
        for (var i = 0; i < verFiles.length; i++) {
            if (verCancelFlag) {
                for (var j = i; j < verFiles.length; j++) verSetState(verFiles[j], 5);
                cancelled = true;
                break;
            }
            try {
                okFiles.push(await (isDirect ? verDirectOne(verFiles[i]) : verUploadOne(verFiles[i])));
                verSetState(verFiles[i], 3);
                verLogAdd('[OK] ' + (verFiles[i].rel_path || verFiles[i].name) + ' (' + fmtSize(verFiles[i].size) + ')', 'ok');
            } catch (e) {
                if (e && e.cancelled) {
                    for (var k = i; k < verFiles.length; k++) verSetState(verFiles[k], 5);
                    cancelled = true;
                } else {
                    var errMsg = (verFiles[i].rel_path || verFiles[i].name) + '：' + (e && e.message ? e.message : (isDirect ? '清单计算失败' : '上传失败'));
                    failedList.push(errMsg);
                    verSetState(verFiles[i], 4);
                    verLogAdd('[FAIL] ' + errMsg, 'err');
                }
            }
            $('m-ver-bar').style.width = Math.round(((i + 1) / verFiles.length) * 100) + '%';
        }
        verUploading = false;
        if (cancelled) {
            if (!isDirect) await verCancelStarted();
            verLogAdd('用户取消，已清理 ' + verStartedIds.length + ' 个未完成分片会话', 'warn');
            $('m-ver-ok').textContent = isDirect ? '开始登记清单（文件不上传）' : '开始上传并登记版本';
            toast('已取消');
            return;
        }
        if (failedList.length > 0) {
            if (!isDirect) await verCancelStarted();
            verLogAdd('处理完成：成功 ' + okFiles.length + ' 个，失败 ' + failedList.length + ' 个。已清理所有分片会话，请查看上方日志', 'warn');
            $('m-ver-ok').textContent = isDirect ? '开始登记清单（文件不上传）' : '开始上传并登记版本';
            toast('有 ' + failedList.length + ' 个文件失败（详见上传日志面板）');
            return;
        }
        verLogAdd('全部成功，正在登记版本…', 'ok');
        var res = await api('POST', '/api/merchant/games/' + verGame.id + '/version', {
            version: version, changelog: $('m-ver-log').value, files: okFiles,
            pack_type: verPackType, pack_size: packSizeBytes, base_version: baseVer
        });
        $('m-ver-ok').textContent = isDirect ? '开始登记清单（文件不上传）' : '开始上传并登记版本';
        try {
            var data = unwrap(res);
            var regState = data && data.register_state;
            if (regState === 1) {
                // Phase 1 快速返回：后台 goroutine 正在分片合并 + 清单写入，完成后 WS 通知
                verLogAdd('✓ 版本 v' + version + ' 登记请求已接收，后台处理中（可关闭此窗口）', 'ok');
                verLogAdd('  完成后会收到在线通知；若长时间未处理请检查后台日志', '');
                toast('版本 v' + version + ' 已提交，后台处理中');
            } else {
                // 旧同步路径（兼容）
                verLogAdd('✓ 版本 v' + version + ' 登记成功', 'ok');
                toast('版本 v' + version + ' 登记成功');
            }
            verFiles = [];
            renderVerList();
            $('m-ver-progress').classList.add('hidden');
            loadVersions();
            loadQuota();
        } catch (e) {
            verLogAdd('✗ 版本登记失败：' + (e && e.message ? e.message : '服务端返回错误'), 'err');
        }
    }

    // ==================== 公告管理 ====================
    var noticeGame = null, noticeImgs = [], editingNoticeId = 0;
    function openNotice(g) {
        noticeGame = g;
        editingNoticeId = 0;
        noticeImgs = [];
        $('m-notice-game').textContent = g.name;
        $('m-no-title').value = '';
        $('m-no-content').value = '';
        refreshNoImgs();
        $('m-notice-mask').classList.remove('hidden');
        loadNotices();
        osbInit($('m-notice-mask').querySelector('.m-modal'));
    }
    function loadNotices() {
        var box = $('m-no-list');
        box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/notices?game_id=' + noticeGame.id + '&page=1&size=50').then(function (res) {
            var d = unwrap(res);
            var list = d.list || [];
            if (!list.length) { box.innerHTML = '<div class="m-empty">暂无公告</div>'; return; }
            var html = '<table class="m-table"><tr><th>标题</th><th>内容摘要</th><th>时间</th><th></th></tr>';
            list.forEach(function (n) {
                html += '<tr><td>' + esc(n.title || '（无标题）') + '</td><td>' + esc(String(n.content || '').slice(0, 40)) +
                    '</td><td>' + esc(String(n.create_time || '').slice(0, 16)) +
                    '</td><td><button class="admin-btn small m-no-edit" data-id="' + n.id + '">编辑</button> ' +
                    '<button class="admin-btn small m-no-del" data-id="' + n.id + '">删除</button></td></tr>';
            });
            box.innerHTML = html + '</table>';
            var eds = box.querySelectorAll('.m-no-edit');
            for (var i = 0; i < eds.length; i++) {
                eds[i].addEventListener('click', function () {
                    var id = Number(this.getAttribute('data-id'));
                    for (var j = 0; j < list.length; j++) {
                        if (list[j].id === id) {
                            editingNoticeId = id;
                            $('m-no-title').value = list[j].title || '';
                            $('m-no-content').value = list[j].content || '';
                            try { noticeImgs = JSON.parse(list[j].images || '[]') || []; } catch (eP) { noticeImgs = []; }
                            refreshNoImgs();
                            toast('已载入公告，编辑后点击「发布公告」保存');
                        }
                    }
                });
            }
            var dels = box.querySelectorAll('.m-no-del');
            for (var k = 0; k < dels.length; k++) {
                dels[k].addEventListener('click', function () {
                    var id = Number(this.getAttribute('data-id'));
                    showConfirm('删除公告', '删除后玩家端动态区立即移除，不可恢复', function () {
                        api('DELETE', '/api/merchant/notices/' + id).then(function (res) {
                            unwrap(res);
                            toast('已删除');
                            loadNotices();
                        }).catch(function () { /* toast 已提示 */ });
                    }, true);
                });
            }
        }).catch(function () { box.innerHTML = '<div class="m-empty">加载失败</div>'; });
    }
    $('m-no-pick').addEventListener('click', function () { $('m-no-file').click(); });
    $('m-no-file').addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files);
        this.value = '';
        if (!files.length) return;
        if (noticeImgs.length + files.length > 9) { toast('公告图片最多 9 张'); return; }
        var done = 0;
        toast('图片上传中…');
        files.forEach(function (f) {
            uploadImage(f).then(function (url) {
                noticeImgs.push(url);
                done++;
                if (done === files.length) { refreshNoImgs(); toast('图片上传完成'); }
            }).catch(function (e) {
                done++;
                refreshNoImgs();
                toast(e.message || '图片上传失败');
            });
        });
    });
    function refreshNoImgs() {
        $('m-no-images').value = JSON.stringify(noticeImgs);
        $('m-no-tip').textContent = noticeImgs.length ? '已上传 ' + noticeImgs.length + ' 张' : '未上传';
        var box = $('m-no-imgs');
        box.innerHTML = '';
        noticeImgs.forEach(function (u, i) {
            var img = el('img');
            img.src = u;
            img.title = '点击移除';
            img.addEventListener('click', function () {
                noticeImgs.splice(i, 1);
                refreshNoImgs();
            });
            box.appendChild(img);
        });
    }
    $('m-notice-cancel').addEventListener('click', function () { $('m-notice-mask').classList.add('hidden'); });
    $('m-notice-ok').addEventListener('click', function () {
        var payload = {
            game_id: noticeGame.id,
            title: $('m-no-title').value.trim(),
            content: $('m-no-content').value.trim(),
            images: JSON.stringify(noticeImgs)
        };
        if (!payload.title && !payload.content && !noticeImgs.length) { toast('标题、内容、图片至少填写一项'); return; }
        var p = editingNoticeId
            ? api('PUT', '/api/merchant/notices/' + editingNoticeId, {
                title: payload.title, content: payload.content, images: payload.images
            })
            : api('POST', '/api/merchant/notices', payload);
        p.then(function (res) {
            unwrap(res);
            toast(editingNoticeId ? '公告已保存' : '公告已发布');
            editingNoticeId = 0;
            $('m-no-title').value = '';
            $('m-no-content').value = '';
            noticeImgs = [];
            refreshNoImgs();
            loadNotices();
        }).catch(function () { /* toast 已提示 */ });
    });

    // ==================== 赞助统计 ====================
    var ordPage = 1;
    function loadStats() {
        api('GET', '/api/merchant/profile').then(function (res) {
            profile = unwrap(res);
            $('m-who').textContent = profile.name || profile.username;
        }).catch(function () { /* 忽略 */ });
        api('GET', '/api/merchant/recharge/summary').then(function (res) {
            var d = unwrap(res);
            $('m-st-total').textContent = fmtPts(d.total_points);
            $('m-st-rate').textContent = fmtPts(d.commission_rate) + '%';
            $('m-st-payable').textContent = fmtPts(d.payable);
            // 按游戏
            var bg = d.by_game || [];
            $('m-st-bygame').innerHTML = bg.length
                ? '<table class="m-table"><tr><th>游戏</th><th>成功订单</th><th>赞助积分</th></tr>' +
                  bg.map(function (g) { return '<tr><td>' + esc(g.name) + '</td><td>' + g.order_count + '</td><td>' + fmtPts(g.points) + '</td></tr>'; }).join('') + '</table>'
                : '<div class="m-empty">暂无数据</div>';
            // 按日
            var bd = d.by_day || [];
            $('m-st-byday').innerHTML = bd.length
                ? '<table class="m-table"><tr><th>日期</th><th>赞助积分</th></tr>' +
                  bd.map(function (x) { return '<tr><td>' + esc(x.day) + '</td><td>' + fmtPts(x.points) + '</td></tr>'; }).join('') + '</table>'
                : '<div class="m-empty">近 30 天暂无成功订单</div>';
        }).catch(function () { /* toast 已提示 */ });
        ordPage = 1;
        loadOrders();
    }
    function loadOrders() {
        var box = $('m-st-orders');
        box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/recharge/orders?page=' + ordPage + '&size=15').then(function (res) {
            var d = unwrap(res);
            var list = d.list || [];
            var ST = { 0: ['pending', '处理中'], 1: ['ok', '成功'], 2: ['rej', '失败已退分'] };
            if (!list.length) { box.innerHTML = '<div class="m-empty">暂无订单</div>'; }
            else {
                var html = '<table class="m-table"><tr><th>订单</th><th>玩家</th><th>游戏</th><th>积分</th><th>游戏币</th><th>状态</th><th>时间</th></tr>';
                list.forEach(function (o) {
                    var sd = ST[o.status] || ST[0];
                    html += '<tr><td>#' + o.id + '</td><td>' + esc(o.username) + '</td><td>' + esc(o.game_name || o.game_id) +
                        '</td><td>' + fmtPts(o.points) + '</td><td>' + fmtPts(o.amount) +
                        '</td><td><span class="m-badge ' + sd[0] + '">' + sd[1] + '</span></td><td>' + esc(o.create_time) + '</td></tr>';
                });
                box.innerHTML = html + '</table>';
            }
            var totalPage = Math.max(1, Math.ceil((d.total || 0) / (d.size || 15)));
            $('m-ord-page').textContent = '第 ' + ordPage + ' / ' + totalPage + ' 页（共 ' + (d.total || 0) + ' 条）';
            $('m-ord-prev').disabled = ordPage <= 1;
            $('m-ord-next').disabled = ordPage >= totalPage;
        }).catch(function () { box.innerHTML = '<div class="m-empty">加载失败</div>'; });
    }
    $('m-ord-prev').addEventListener('click', function () { ordPage--; loadOrders(); });
    $('m-ord-next').addEventListener('click', function () { ordPage++; loadOrders(); });

    // ==================== 网关部署包下载（Blob 下载，带鉴权） ====================
    // 使用说明（与 gametool-help / merchant-direct-help 同模式：新开说明页，商户照步骤部署）。
    // null 守卫：浏览器缓存旧版 merchant.html 时新节点不存在，跳过绑定避免 TypeError 中断后续 boot()
    (function () {
        var gh = document.getElementById('m-gw-help');
        if (gh) gh.addEventListener('click', function () { window.open('/gateway-help.html', '_blank'); });
    })();
    $('m-gw-dl').addEventListener('click', function () {
        var tip = $('m-gw-tip');
        tip.textContent = '下载中…';
        fetch('/api/merchant/gateway/package', { headers: { 'Authorization': 'Bearer ' + getToken() } })
            .then(function (r) {
                if (r.status === 401) { clearToken(); showLogin(); throw new Error('请重新登录'); }
                if (!r.ok) return r.json().then(function (j) { throw new Error(j.msg || ('HTTP ' + r.status)); });
                var cd = r.headers.get('Content-Disposition') || '';
                var m = /filename="?([^";]+)"?/.exec(cd);
                return r.blob().then(function (b) { return { blob: b, name: (m && m[1]) || 'im-gateway.zip' }; });
            })
            .then(function (p) {
                var a = document.createElement('a');
                a.href = URL.createObjectURL(p.blob);
                a.download = p.name;
                document.body.appendChild(a);
                a.click();
                setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                tip.textContent = '';
                toast('已开始下载 ' + p.name);
            })
            .catch(function (e) {
                tip.textContent = '';
                toast(e.message || '下载失败');
            });
    });

    // ==================== 商户服务号管理 ====================
    // 对应后端路由组：/api/merchant/official/*（official_merchant.go，merchantGuard 鉴权）

    var moffEditingId = 0;
    var moffCurrentAccount = 0;
    var moffTplEditingId = 0;
    var moffKwAccount = 0;
    var moffAuditAccount = 0;
    var moffBound = false;

    function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function loadMoffList() {
        var kw = $('m-off-kw').value.trim();
        var q = '?page=1&size=100';
        if (kw) q += '&keyword=' + encodeURIComponent(kw);
        api('GET', '/api/merchant/official/accounts' + q).then(function (result) {
            if (!result || !result.ok) { renderMoffList({ list: [] }); return; }
            renderMoffList(result);
            bindMoffEvents();
        });
    }

    function fmtMoffTime(t) { if (!t) return '-'; try { return new Date(t).toLocaleString(); } catch (e) { return String(t); } }

    // 当前商户账号列表缓存（给 API 文档弹窗等使用）
    var _moffAccounts = [];

    function renderMoffList(result) {
        var tbody = $('m-off-tbody');
        var list = result.list || [];
        _moffAccounts = list.slice();
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="m-empty">暂无服务号，点击右上角「+ 创建服务号」开始</td></tr>';
            return;
        }
        var rows = '';
        list.forEach(function (a) {
            var statusHtml = a.status === 0 ? '<span style="color:#2ecc71">● 正常</span>' :
                             a.status === 1 ? '<span style="color:#e74c3c">● 已停用</span>' :
                             '<span style="color:#f39c12">● 审核中</span>';
            var auditHtml = a.need_audit ? '<span style="color:#f39c12">需审核</span>' : '<span style="color:var(--admin-field-hint)">直通</span>';
            rows += '<tr>' +
                '<td>' + a.id + '</td>' +
                '<td><strong>' + escHtml(a.display_name || '') + '</strong><div style="font-size:12px;color:var(--admin-field-hint);margin-top:2px">' + escHtml(a.description || '') + '</div></td>' +
                '<td><code>' + escHtml(a.app_id || '') + '</code></td>' +
                '<td>' + statusHtml + '</td>' +
                '<td>' + auditHtml + '</td>' +
                '<td>' + (a.subscribe_count || 0) + '</td>' +
                '<td style="font-size:12px">' + (a.today_sent || 0) + ' / ' + (a.max_per_day || '∞') + '</td>' +
                '<td style="font-size:12px">' + fmtMoffTime(a.create_time) + '</td>' +
                '<td>' +
                '<button class="admin-btn small" data-moff-op="menu" data-id="' + a.id + '">菜单</button> ' +
                '<button class="admin-btn small" data-moff-op="kw" data-id="' + a.id + '">关键词</button> ' +
                '<button class="admin-btn small" data-moff-op="tpl" data-id="' + a.id + '">模板</button> ' +
                '<button class="admin-btn small primary" data-moff-op="send" data-id="' + a.id + '">📤 推送</button> ' +
                '<button class="admin-btn small" data-moff-op="qr" data-id="' + a.id + '">📱 二维码</button> ' +
                '<button class="admin-btn small" data-moff-op="history" data-id="' + a.id + '">📜 历史</button> ' +
                '<button class="admin-btn small" data-moff-op="audit" data-id="' + a.id + '">审核</button> ' +
                '<button class="admin-btn small" data-moff-op="secret" data-id="' + a.id + '">密钥</button> ' +
                '<button class="admin-btn small" data-moff-op="api" data-id="' + a.id + '">🔑 API</button> ' +
                '<button class="admin-btn small" data-moff-op="edit" data-id="' + a.id + '">编辑</button> ' +
                '<button class="admin-btn small danger" data-moff-op="del" data-id="' + a.id + '">删除</button>' +
                '</td>' +
                '</tr>';
        });
        tbody.innerHTML = rows;
        tbody.querySelectorAll('[data-moff-op]').forEach(function (el) {
            el.addEventListener('click', function () {
                var op = el.getAttribute('data-moff-op');
                var id = Number(el.getAttribute('data-id'));
                handleMoffRowOp(op, id);
            });
        });
    }

    function handleMoffRowOp(op, id) {
        if (op === 'edit') return openMoffEdit(id);
        if (op === 'del') return confirmDeleteMoff(id);
        if (op === 'menu') return openMoffMenu(id);
        if (op === 'kw') return openMoffKwList(id);
        if (op === 'tpl') return openMoffTplList(id);
        if (op === 'send') return openMoffSend(id);
        if (op === 'secret') return resetMoffSecret(id);
        if (op === 'audit') return openMoffAudit(id);
        if (op === 'api') return openMoffApiDocs(id);
        if (op === 'history') return openMoffHistory(id);
        if (op === 'qr') return openMoffQR(id);
    }

    function bindMoffEvents() {
        if (moffBound) return;
        moffBound = true;
        $('m-off-refresh').addEventListener('click', loadMoffList);
        $('m-off-new').addEventListener('click', function () { openMoffEdit(0); });
        $('m-off-kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadMoffList(); });

        $('m-off-edit-close').addEventListener('click', function () { $('m-off-edit-mask').classList.add('hidden'); });
        $('m-off-edit-ok').addEventListener('click', saveMoffEdit);

        $('m-off-menu-close').addEventListener('click', function () { $('m-off-menu-mask').classList.add('hidden'); });
        $('m-off-menu-ok').addEventListener('click', saveMoffMenu);
        $('m-off-menu-fill').addEventListener('click', function () {
            $('m-off-menu-json').value = MOFF_MENU_EXAMPLE;
            toast('已填入示例，修改后点保存');
        });

        $('m-off-tpl-close').addEventListener('click', function () { $('m-off-tpl-mask').classList.add('hidden'); });
        $('m-off-tpl-add').addEventListener('click', function () { openMoffTplEdit(0); });
        $('m-off-te-close').addEventListener('click', function () { $('m-off-tpl-edit-mask').classList.add('hidden'); });
        $('m-off-te-ok').addEventListener('click', saveMoffTplEdit);
        $('m-off-te-type').addEventListener('change', renderMoffTplEditTypeUI);

        $('m-off-kw-close').addEventListener('click', function () { $('m-off-kw-mask').classList.add('hidden'); });
        $('m-off-kw-new-btn').addEventListener('click', saveMoffKw);

        $('m-off-secret-close').addEventListener('click', function () { $('m-off-secret-mask').classList.add('hidden'); });

        $('m-off-audit-close').addEventListener('click', function () { $('m-off-audit-mask').classList.add('hidden'); });

        // 手动推送弹窗
        $('m-off-send-close').addEventListener('click', function () { $('m-off-send-mask').classList.add('hidden'); });
        $('m-off-send-type').addEventListener('change', updateMoffSendTypeUI);
        $('m-off-send-btn').addEventListener('click', doMoffSend);
    }

    // ==================== 编辑 / 创建 ====================
    function openMoffEdit(id) {
        moffEditingId = id;
        $('m-off-edit-title').textContent = id ? '编辑服务号 #' + id : '创建服务号';
        $('m-off-e-name').value = '';
        $('m-off-e-avatar').value = '';
        $('m-off-e-desc').value = '';
        $('m-off-e-max').value = '0';
        $('m-off-e-audit').checked = true;
        if (id) {
            api('GET', '/api/merchant/official/accounts/' + id).then(function (result) {
                if (!result.account) return toast('加载失败');
                var a = result.account;
                $('m-off-e-name').value = a.display_name || '';
                $('m-off-e-avatar').value = a.avatar || '';
                $('m-off-e-desc').value = a.description || '';
                $('m-off-e-max').value = a.max_per_day || 0;
                $('m-off-e-audit').checked = !!a.need_audit;
            });
        }
        $('m-off-edit-mask').classList.remove('hidden');
    }

    function saveMoffEdit() {
        var body = {
            display_name: $('m-off-e-name').value.trim(),
            avatar: $('m-off-e-avatar').value.trim(),
            description: $('m-off-e-desc').value.trim(),
            need_audit: $('m-off-e-audit').checked,
            max_per_day: Number($('m-off-e-max').value) || 0
        };
        if (!body.display_name) return toast('展示名不能为空');
        var p;
        if (moffEditingId === 0) {
            p = api('POST', '/api/merchant/official/accounts', body);
        } else {
            p = api('PUT', '/api/merchant/official/accounts/' + moffEditingId, body);
        }
        p.then(function (result) {
            if (result.app_secret) {
                toast('创建成功！请立即复制 AppSecret（仅显示一次）');
                setTimeout(function () {
                    if (window.prompt) window.prompt('新服务号凭证（请立即复制保存）：',
                        'AppID: ' + result.app_id + '\nAppSecret: ' + result.app_secret);
                }, 200);
            } else if (!result.ok) {
                return toast(result.msg || '保存失败');
            } else {
                toast('保存成功');
            }
            $('m-off-edit-mask').classList.add('hidden');
            loadMoffList();
        });
    }

    function confirmDeleteMoff(id) {
        if (!window.confirm('确定删除该服务号？\n· 菜单、模板、订阅关系、推送记录、审核记录将一并删除\n· 此操作不可撤销')) return;
        api('DELETE', '/api/merchant/official/accounts/' + id).then(function (result) {
            if (!result.ok) return toast(result.msg || '删除失败');
            toast('已删除');
            loadMoffList();
        });
    }

    function resetMoffSecret(id) {
        if (!window.confirm('重置后旧密钥立即失效，企业系统需要更新调用凭证。确定继续？')) return;
        api('PUT', '/api/merchant/official/accounts/' + id + '/secret').then(function (result) {
            if (!result.app_secret) return toast(result.msg || '重置失败');
            $('m-off-secret-val').textContent = 'AppID: ' + result.app_id + '\nAppSecret: ' + result.app_secret;
            $('m-off-secret-mask').classList.remove('hidden');
        });
    }

    // ==================== 菜单管理 ====================
    // 菜单完整示例（顶级数组，保存时 JS 自动包 {"menus": 数组} 发给后端）
    var MOFF_MENU_EXAMPLE = JSON.stringify([
        {
            name: '浏览',
            action: 'click',
            value: 'browse_root',
            children: [
                { name: '🔥 最新活动', action: 'view', value: 'https://example.com/activity' },
                { name: '🛍 产品列表', action: 'view', value: 'https://example.com/products' },
                { name: '📝 我的订单', action: 'click', value: 'my_orders' }
            ]
        },
        { name: '💬 在线客服', action: 'click', value: 'contact_service' },
        { name: '👤 个人中心', action: 'view', value: 'https://example.com/profile' }
    ], null, 2);

    function openMoffMenu(id) {
        moffCurrentAccount = id;
        $('m-off-menu-json').value = '';
        api('GET', '/api/merchant/official/accounts/' + id).then(function (res) {
            if (res.account) $('m-off-menu-title').textContent = res.account.display_name;
        });
        api('GET', '/api/merchant/official/accounts/' + id + '/menu').then(function (res) {
            var convert = function (nodes) {
                return (nodes || []).map(function (n) {
                    var o = { name: n.name, action: n.action, value: n.value };
                    if (n.children && n.children.length > 0) o.children = convert(n.children);
                    return o;
                });
            };
            var arr = convert(res.menus);
            // 从未设置过菜单 → 自动填入示例，让商户直接复制改
            $('m-off-menu-json').value = arr.length === 0 ? MOFF_MENU_EXAMPLE : JSON.stringify(arr, null, 2);
        });
        $('m-off-menu-mask').classList.remove('hidden');
    }

    function saveMoffMenu() {
        var txt = $('m-off-menu-json').value.trim() || '[]';
        var menus;
        try { menus = JSON.parse(txt); } catch (e) { return toast('JSON 格式错误：' + e.message); }
        if (!Array.isArray(menus)) return toast('必须为数组');
        api('POST', '/api/merchant/official/accounts/' + moffCurrentAccount + '/menu', { menus: menus }).then(function (res) {
            if (!res.ok) return toast(res.msg || '保存失败');
            toast('菜单已保存');
            $('m-off-menu-mask').classList.add('hidden');
        });
    }

    // ==================== 模板管理 ====================
    function openMoffTplList(id) {
        moffCurrentAccount = id;
        api('GET', '/api/merchant/official/accounts/' + id).then(function (res) {
            if (res.account) $('m-off-tpl-title').textContent = res.account.display_name;
        });
        loadMoffTplList();
        $('m-off-tpl-mask').classList.remove('hidden');
    }

    // content_type 展示名映射
    var MOFF_TPL_TYPE_NAME = { text: '纯文本', notify: '通知卡片', news: '图文卡片', news_list: '多图文', miniapp: '小程序' };
    var MOFF_TPL_TYPE_COLOR = { text: '#888', notify: '#f39c12', news: '#3498db', news_list: '#9b59b6', miniapp: '#27ae60' };

    function loadMoffTplList() {
        api('GET', '/api/merchant/official/accounts/' + moffCurrentAccount + '/templates').then(function (list) {
            _moffTplCache = list || [];
            var tbody = $('m-off-tpl-tbody');
            if (!list || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="m-empty">暂无模板，点击上方「+ 新增模板」开始</td></tr>';
                return;
            }
            var html = '';
            list.forEach(function (t) {
                var ct = t.content_type || 'text';
                var typeName = MOFF_TPL_TYPE_NAME[ct] || ct;
                var typeColor = MOFF_TPL_TYPE_COLOR[ct] || '#888';
                html += '<tr>' +
                    '<td><code>' + escHtml(t.template_id || '') + '</code></td>' +
                    '<td>' + escHtml(t.name || '') + '</td>' +
                    '<td><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;background:' + typeColor + '22;color:' + typeColor + '">' + typeName + '</span></td>' +
                    '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(t.content || '') + '">' + escHtml(t.content || '') + '</td>' +
                    '<td>' +
                    '<button class="admin-btn small" data-moff-tpl-op="edit" data-id="' + t.id + '">编辑</button> ' +
                    '<button class="admin-btn small danger" data-moff-tpl-op="del" data-id="' + t.id + '">删除</button>' +
                    '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = html;
            tbody.querySelectorAll('[data-moff-tpl-op]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var op = el.getAttribute('data-moff-tpl-op');
                    var id = Number(el.getAttribute('data-id'));
                    if (op === 'edit') openMoffTplEdit(id);
                    else confirmDeleteMoffTpl(id);
                });
            });
        });
    }

    // 缓存当前模板列表（编辑时复用，避免单独 GET 详情）
    var _moffTplCache = [];

    // 模板编辑器：notify 字段列表 / news_list 图文项 状态
    var _moffTplNFields = [];   // notify [{label, value}]
    var _moffTplNItems = [];    // news_list [{image, title, summary, url}]
    window._moffTplAddNField = function () { _moffTplNFields.push({ label: '', value: '' }); renderMoffTplNFields(); };
    window._moffTplDelNField = function (i) { _moffTplNFields.splice(i, 1); renderMoffTplNFields(); };
    window._moffTplAddNItem = function () { _moffTplNItems.push({ image: '', title: '', summary: '', url: '' }); renderMoffTplNItems(); };
    window._moffTplDelNItem = function (i) { _moffTplNItems.splice(i, 1); renderMoffTplNItems(); };

    function renderMoffTplEditTypeUI() {
        var ct = $('m-off-te-type').value;
        $('m-off-te-text-wrap').style.display       = (ct === 'text')      ? '' : 'none';
        $('m-off-te-notify-wrap').style.display     = (ct === 'notify')    ? '' : 'none';
        $('m-off-te-news-wrap').style.display       = (ct === 'news')      ? '' : 'none';
        $('m-off-te-nlist-wrap').style.display      = (ct === 'news_list') ? '' : 'none';
        $('m-off-te-mini-wrap').style.display       = (ct === 'miniapp')   ? '' : 'none';
    }

    function renderMoffTplNFields() {
        var box = $('m-off-te-n-fields');
        box.innerHTML = '';
        _moffTplNFields.forEach(function (f, i) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
            row.innerHTML =
                '<input class="admin-input" placeholder="字段名（如 订单号）" value="' + escHtml(f.label) + '" style="flex:1">' +
                '<input class="admin-input" placeholder="字段值（如 {{order_no}}）" value="' + escHtml(f.value) + '" style="flex:2">' +
                '<button type="button" class="admin-btn small danger" onclick="window._moffTplDelNField(' + i + ')">✕</button>';
            var inputs = row.querySelectorAll('input');
            inputs[0].addEventListener('input', function () { _moffTplNFields[i].label = inputs[0].value; });
            inputs[1].addEventListener('input', function () { _moffTplNFields[i].value = inputs[1].value; });
            box.appendChild(row);
        });
    }

    function renderMoffTplNItems() {
        var box = $('m-off-te-nl-items');
        box.innerHTML = '';
        _moffTplNItems.forEach(function (it, i) {
            var row = document.createElement('div');
            row.style.cssText = 'border:1px solid var(--admin-field-hint);border-radius:6px;padding:8px;margin-bottom:8px;background:rgba(0,0,0,0.02)';
            row.innerHTML =
                '<div style="display:flex;gap:6px;margin-bottom:4px"><input class="admin-input" placeholder="封面图 URL" value="' + escHtml(it.image) + '" style="flex:3"></div>' +
                '<div style="display:flex;gap:6px;margin-bottom:4px"><input class="admin-input" placeholder="标题" value="' + escHtml(it.title) + '" style="flex:2"><input class="admin-input" placeholder="跳转 URL" value="' + escHtml(it.url) + '" style="flex:2"></div>' +
                '<div style="display:flex;gap:6px;align-items:center"><input class="admin-input" placeholder="摘要" value="' + escHtml(it.summary) + '" style="flex:4"><button type="button" class="admin-btn small danger" onclick="window._moffTplDelNItem(' + i + ')">删除</button></div>';
            var inputs = row.querySelectorAll('input');
            inputs[0].addEventListener('input', function () { _moffTplNItems[i].image = inputs[0].value; });
            inputs[1].addEventListener('input', function () { _moffTplNItems[i].title = inputs[1].value; });
            inputs[2].addEventListener('input', function () { _moffTplNItems[i].url = inputs[2].value; });
            inputs[3].addEventListener('input', function () { _moffTplNItems[i].summary = inputs[3].value; });
            box.appendChild(row);
        });
    }

    // 从结构化表单收集数据 → 序列化为 content 字段
    function collectMoffTplContent(ct) {
        if (ct === 'text') {
            return $('m-off-te-content').value.trim();
        }
        var obj = {};
        if (ct === 'notify') {
            obj.title       = $('m-off-te-n-title').value.trim();
            obj.content     = $('m-off-te-n-content').value.trim();
            obj.status      = $('m-off-te-n-status').value.trim();
            obj.badge_color = $('m-off-te-n-badge').value;
            obj.fields      = _moffTplNFields.filter(function (f) { return f.label || f.value; });
            obj.url         = $('m-off-te-n-url').value.trim();
            obj.link_btn    = $('m-off-te-n-link').value.trim();
        } else if (ct === 'news') {
            obj.title    = $('m-off-te-ne-title').value.trim();
            obj.image    = $('m-off-te-ne-image').value.trim();
            obj.content  = $('m-off-te-ne-content').value.trim();
            obj.url      = $('m-off-te-ne-url').value.trim();
            obj.link_btn = $('m-off-te-ne-link').value.trim();
        } else if (ct === 'news_list') {
            obj.title = $('m-off-te-nl-title').value.trim();
            obj.items = _moffTplNItems.map(function (it) {
                return { image: it.image.trim(), title: it.title.trim(), summary: it.summary.trim(), url: it.url.trim() };
            }).filter(function (it) { return it.image || it.title; });
        } else if (ct === 'miniapp') {
            obj.title    = $('m-off-te-mi-title').value.trim();
            obj.icon     = $('m-off-te-mi-icon').value.trim();
            obj.subtitle = $('m-off-te-mi-subtitle').value.trim();
            obj.url      = $('m-off-te-mi-url').value.trim();
            obj.link_btn = $('m-off-te-mi-link').value.trim();
        }
        return JSON.stringify(obj);
    }

    // 反序列化 content → 填入结构化表单（编辑时回显）
    function populateMoffTplForm(ct, rawContent) {
        // 先清空所有表单
        $('m-off-te-n-title').value = '';
        $('m-off-te-n-content').value = '';
        $('m-off-te-n-status').value = '';
        $('m-off-te-n-badge').value = 'blue';
        $('m-off-te-n-url').value = '';
        $('m-off-te-n-link').value = '';
        _moffTplNFields = [];
        $('m-off-te-ne-title').value = '';
        $('m-off-te-ne-image').value = '';
        $('m-off-te-ne-content').value = '';
        $('m-off-te-ne-url').value = '';
        $('m-off-te-ne-link').value = '';
        $('m-off-te-nl-title').value = '';
        _moffTplNItems = [];
        $('m-off-te-mi-title').value = '';
        $('m-off-te-mi-icon').value = '';
        $('m-off-te-mi-subtitle').value = '';
        $('m-off-te-mi-url').value = '';
        $('m-off-te-mi-link').value = '';

        if (ct === 'text') {
            $('m-off-te-content').value = rawContent || '';
            return;
        }

        var obj;
        try { obj = JSON.parse(rawContent || '{}'); } catch (e) { obj = {}; }

        if (ct === 'notify') {
            $('m-off-te-n-title').value    = obj.title || '';
            $('m-off-te-n-content').value  = obj.content || '';
            $('m-off-te-n-status').value   = obj.status || '';
            $('m-off-te-n-badge').value    = obj.badge_color || 'blue';
            $('m-off-te-n-url').value      = obj.url || '';
            $('m-off-te-n-link').value     = obj.link_btn || '';
            _moffTplNFields = Array.isArray(obj.fields) ? obj.fields.slice() : [];
            renderMoffTplNFields();
        } else if (ct === 'news') {
            $('m-off-te-ne-title').value   = obj.title || '';
            $('m-off-te-ne-image').value   = obj.image || '';
            $('m-off-te-ne-content').value = obj.content || '';
            $('m-off-te-ne-url').value     = obj.url || '';
            $('m-off-te-ne-link').value    = obj.link_btn || '';
        } else if (ct === 'news_list') {
            $('m-off-te-nl-title').value = obj.title || '';
            _moffTplNItems = Array.isArray(obj.items) ? obj.items.slice() : [];
            renderMoffTplNItems();
        } else if (ct === 'miniapp') {
            $('m-off-te-mi-title').value    = obj.title || '';
            $('m-off-te-mi-icon').value     = obj.icon || '';
            $('m-off-te-mi-subtitle').value = obj.subtitle || '';
            $('m-off-te-mi-url').value      = obj.url || '';
            $('m-off-te-mi-link').value     = obj.link_btn || '';
        }
    }

    function openMoffTplEdit(id) {
        moffTplEditingId = id;
        $('m-off-te-id').value = '';
        $('m-off-te-name').value = '';
        $('m-off-te-type').value = 'text';
        $('m-off-te-example').value = '';
        $('m-off-te-content').value = '';
        _moffTplNFields = [];
        _moffTplNItems = [];
        $('m-off-tpl-edit-title').textContent = id ? '编辑模板 #' + id : '新增模板';

        var ct = 'text', rawContent = '';
        if (id) {
            var t = null;
            for (var i = 0; i < _moffTplCache.length; i++) {
                if (_moffTplCache[i].id === id) { t = _moffTplCache[i]; break; }
            }
            if (t) {
                $('m-off-te-id').value = t.template_id || '';
                $('m-off-te-name').value = t.name || '';
                $('m-off-te-example').value = t.example || '';
                ct = t.content_type || 'text';
                rawContent = t.content || '';
            }
        }

        $('m-off-te-type').value = ct;
        renderMoffTplEditTypeUI();
        populateMoffTplForm(ct, rawContent);
        $('m-off-tpl-edit-mask').classList.remove('hidden');
    }

    function saveMoffTplEdit() {
        var name = $('m-off-te-name').value.trim();
        if (!name) return toast('模板名称不能为空');
        var ct = $('m-off-te-type').value;
        var content = collectMoffTplContent(ct);
        if (!content) return toast('模板内容不能为空（请至少填写一项字段）');
        // text 类型校验更严格（必须是非空文本）
        if (ct === 'text' && !content.trim()) return toast('模板正文不能为空');

        var body = {
            template_id: $('m-off-te-id').value.trim(),
            name: name,
            content_type: ct,
            content: content,
            example: $('m-off-te-example').value.trim()
        };
        var p;
        if (moffTplEditingId === 0) {
            p = api('POST', '/api/merchant/official/accounts/' + moffCurrentAccount + '/templates', body);
        } else {
            var patch = {};
            if (body.name) patch.name = body.name;
            patch.content_type = body.content_type;
            patch.content = body.content;
            if (body.example) patch.example = body.example;
            p = api('PUT', '/api/merchant/official/templates/' + moffTplEditingId, patch);
        }
        p.then(function (res) {
            if (!res.ok) return toast(res.msg || '保存失败');
            toast('模板已保存');
            $('m-off-tpl-edit-mask').classList.add('hidden');
            loadMoffTplList();
        });
    }

    function confirmDeleteMoffTpl(id) {
        if (!window.confirm('确定删除该模板？')) return;
        api('DELETE', '/api/merchant/official/templates/' + id).then(function (res) {
            if (!res.ok) return toast(res.msg || '删除失败');
            toast('已删除');
            loadMoffTplList();
        });
    }

    // ==================== 关键词管理 ====================
    function openMoffKwList(id) {
        moffKwAccount = id;
        $('m-off-kw-mask').classList.remove('hidden');
        loadMoffKwList();
    }

    function loadMoffKwList() {
        api('GET', '/api/merchant/official/accounts/' + moffKwAccount + '/keywords').then(function (list) {
            var tbody = $('m-off-kw-tbody');
            if (!list || !list.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="m-empty">暂无关键词，在上方输入触发词和回复内容后点 + 新增</td></tr>';
                return;
            }
            var rows = '';
            list.forEach(function (kw) {
                var mtLabel = kw.match_type === 'exact' ? '精确' : '包含';
                rows += '<tr>' +
                    '<td>' + kw.id + '</td>' +
                    '<td>' + mtLabel + '</td>' +
                    '<td>' + escHtml(kw.keyword || '') + '</td>' +
                    '<td>' + escHtml((kw.reply_text || '').slice(0, 80)) + '</td>' +
                    '<td>' + (kw.enabled ? '✓' : '✗') + '</td>' +
                    '<td>' +
                    '<button class="admin-btn small" data-moff-kw-op="toggle" data-id="' + kw.id + '" data-en="' + (kw.enabled ? '0' : '1') + '">' +
                    (kw.enabled ? '禁用' : '启用') + '</button> ' +
                    '<button class="admin-btn small danger" data-moff-kw-op="del" data-id="' + kw.id + '">删除</button>' +
                    '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = rows;
            tbody.querySelectorAll('[data-moff-kw-op]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var op = el.getAttribute('data-moff-kw-op');
                    var kid = Number(el.getAttribute('data-id'));
                    if (op === 'del') confirmDeleteMoffKw(kid);
                    else if (op === 'toggle') toggleMoffKw(kid, el.getAttribute('data-en') === '1');
                });
            });
        });
    }

    function saveMoffKw() {
        var keyword = $('m-off-kw-new-keyword').value.trim();
        var reply = $('m-off-kw-new-reply').value.trim();
        var match = $('m-off-kw-new-match').value;
        if (!keyword || !reply) return toast('触发词和回复内容不能为空');
        api('POST', '/api/merchant/official/accounts/' + moffKwAccount + '/keywords', {
            keyword: keyword, reply_text: reply, match_type: match, enabled: true, sort_order: 0
        }).then(function (res) {
            if (!res.ok) return toast(res.msg || '保存失败');
            toast('已添加');
            $('m-off-kw-new-keyword').value = '';
            $('m-off-kw-new-reply').value = '';
            loadMoffKwList();
        });
    }

    function toggleMoffKw(id, enable) {
        api('PUT', '/api/merchant/official/keywords/' + id, { enabled: enable }).then(function (res) {
            if (!res.ok) return toast(res.msg || '操作失败');
            toast(enable ? '已启用' : '已禁用');
            loadMoffKwList();
        });
    }

    function confirmDeleteMoffKw(id) {
        if (!window.confirm('确定删除该关键词？')) return;
        api('DELETE', '/api/merchant/official/keywords/' + id).then(function (res) {
            if (!res.ok) return toast(res.msg || '删除失败');
            toast('已删除');
            loadMoffKwList();
        });
    }

    // ==================== 审核队列 ====================
    function openMoffAudit(id) {
        moffAuditAccount = id;
        api('GET', '/api/merchant/official/accounts/' + id).then(function (res) {
            if (res.account) {
                $('m-off-audit-mask').querySelector('.m-modal-title').textContent = '待审核消息 — ' + res.account.display_name;
            }
        });
        loadMoffAuditList();
        $('m-off-audit-mask').classList.remove('hidden');
    }

    function loadMoffAuditList() {
        api('GET', '/api/merchant/official/audit/pending').then(function (result) {
            var list = (result && result.list) || [];
            // 后端可能返回全部 pending，需要按 account_id 过滤
            var filtered = moffAuditAccount ? list.filter(function (a) { return a.account_id === moffAuditAccount; }) : list;
            var tbody = $('m-off-audit-tbody');
            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="m-empty">暂无待审核消息</td></tr>';
                return;
            }
            var rows = '';
            filtered.forEach(function (a) {
                var typeLabel = a.send_type === 1 ? '单推' : a.send_type === 2 ? '批量' : a.send_type === 3 ? '群发' : '-';
                var count = a.recipient_count || 0;
                // broadcast 时 count 可能无意义
                var countStr = a.send_type === 3 ? '全部订阅者' : count + ' 人';
                rows += '<tr>' +
                    '<td>' + a.id + '</td>' +
                    '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(a.title || a.content || '') + '">' + escHtml(a.title || '(无标题)') + '</td>' +
                    '<td>' + typeLabel + '</td>' +
                    '<td>' + countStr + '</td>' +
                    '<td style="font-size:12px">' + fmtMoffTime(a.create_time) + '</td>' +
                    '<td>' +
                    '<button class="admin-btn small" data-moff-audit-op="approve" data-id="' + a.id + '">通过</button> ' +
                    '<button class="admin-btn small danger" data-moff-audit-op="reject" data-id="' + a.id + '">驳回</button>' +
                    '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = rows;
            tbody.querySelectorAll('[data-moff-audit-op]').forEach(function (el) {
                el.addEventListener('click', function () {
                    var op = el.getAttribute('data-moff-audit-op');
                    var id = Number(el.getAttribute('data-id'));
                    if (op === 'approve') approveMoffAudit(id);
                    else rejectMoffAudit(id);
                });
            });
        });
    }

    function approveMoffAudit(id) {
        if (!window.confirm('确定通过该消息审核？通过后立即发送')) return;
        api('POST', '/api/merchant/official/audit/' + id + '/approve').then(function (res) {
            if (!res.ok) return toast(res.msg || '操作失败');
            toast('已通过');
            loadMoffAuditList();
        });
    }

    function rejectMoffAudit(id) {
        var remark = window.prompt('请填写驳回原因：', '内容需要修改');
        if (!remark) return;
        api('POST', '/api/merchant/official/audit/' + id + '/reject', { remark: remark }).then(function (res) {
            if (!res.ok) return toast(res.msg || '操作失败');
            toast('已驳回');
            loadMoffAuditList();
        });
    }

    // ==================== 手动推送 ====================

    var moffSendAccount = 0;

    function openMoffSend(id) {
        moffSendAccount = id;
        // 标题显示服务号名
        api('GET', '/api/merchant/official/accounts/' + id).then(function (res) {
            if (res.account) {
                $('m-off-send-title').textContent = '推送消息 — ' + res.account.display_name;
                $('m-off-send-audit-tip').textContent = res.account.need_audit
                    ? '💡 该服务号开启了推送审核，消息发送后需审批'
                    : '💡 该服务号直通模式，消息将立即发送';
            }
        });
        // 加载模板下拉
        api('GET', '/api/merchant/official/accounts/' + id + '/templates').then(function (list) {
            var sel = $('m-off-send-tpl');
            sel.innerHTML = '<option value="">不使用模板，手动填写内容</option>';
            (list || []).forEach(function (t) {
                var opt = document.createElement('option');
                opt.value = t.template_id;
                opt.textContent = t.name + ' (' + t.template_id + ')';
                sel.appendChild(opt);
            });
        });
        // 重置表单
        $('m-off-send-type').value = 'single';
        $('m-off-send-ctype').value = 'text';
        $('m-off-send-to').value = '';
        $('m-off-send-title-input').value = '';
        $('m-off-send-content').value = '';
        $('m-off-send-url').value = '';
        // P2 notify 字段重置
        $('m-off-send-status').value = '';
        $('m-off-send-badge').value = 'blue';
        moffSendFields = [];
        renderMoffSendFields();
        $('m-off-send-btn').textContent = '📤 发送';
        // 切换显示逻辑
        updateMoffSendTypeUI();
        updateMoffSendCardUI(); // P2：按 content_type 显示/隐藏 notify 字段
        $('m-off-send-mask').classList.remove('hidden');
    }

    // P2：服务号推送 notify 字段列表状态
    var moffSendFields = []; // [{label, value}]

    // P2：content_type 切换 → 显示/隐藏 notify 专属字段
    function updateMoffSendCardUI() {
        var ctype = $('m-off-send-ctype').value;
        var notifyWrap = $('m-off-send-notify-wrap');
        if (notifyWrap) {
            notifyWrap.style.display = (ctype === 'notify') ? '' : 'none';
        }
    }

    // P2：渲染 notify 字段列表（动态增删）
    function renderMoffSendFields() {
        var box = $('m-off-send-fields');
        box.innerHTML = '';
        moffSendFields.forEach(function (f, i) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
            row.innerHTML =
                '<input class="m-form-input" placeholder="字段名（如 订单号）" value="' + escHtml(f.label) + '" style="flex:1">' +
                '<input class="m-form-input" placeholder="字段值（如 SF123456）" value="' + escHtml(f.value) + '" style="flex:2">' +
                '<button type="button" style="padding:4px 10px;border:1px solid var(--border);background:#fff;border-radius:4px;cursor:pointer;color:#dc2626" onclick="window._moffDelField(' + i + ')">✕</button>';
            var inputs = row.querySelectorAll('input');
            inputs[0].addEventListener('input', function () { moffSendFields[i].label = inputs[0].value; });
            inputs[1].addEventListener('input', function () { moffSendFields[i].value = inputs[1].value; });
            box.appendChild(row);
        });
    }
    window._moffDelField = function (i) {
        moffSendFields.splice(i, 1);
        renderMoffSendFields();
    };
    window._moffAddField = function () {
        moffSendFields.push({ label: '', value: '' });
        renderMoffSendFields();
    };

    function updateMoffSendTypeUI() {
        var type = $('m-off-send-type').value;
        var toWrap = $('m-off-send-to-wrap');
        if (type === 'broadcast') {
            toWrap.style.display = 'none';
        } else {
            toWrap.style.display = '';
            $('m-off-send-to').placeholder = type === 'batch'
                ? '多个用户名用换行或逗号分隔（最多 1000）'
                : '单个用户名，如 user1';
        }
    }

    function doMoffSend() {
        var type = $('m-off-send-type').value;
        var recipients = [];
        if (type !== 'broadcast') {
            var raw = $('m-off-send-to').value;
            recipients = raw.split(/[\s,，\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            if (recipients.length === 0) return toast('请填写接收人');
            if (type === 'single' && recipients.length !== 1) return toast('单推模式只能填 1 个用户');
            if (type === 'batch' && recipients.length > 1000) return toast('批量最多 1000 用户');
        }
        var body = {
            account_id: moffSendAccount,
            type: type,
            recipients: recipients,
            content_type: $('m-off-send-ctype').value || 'text',
            title: $('m-off-send-title-input').value.trim(),
            content: $('m-off-send-content').value.trim(),
            url: $('m-off-send-url').value.trim(),
        };
        var tplId = $('m-off-send-tpl').value;
        if (tplId) body.template_id = tplId;
        // P2：notify 卡片专属字段
        if (body.content_type === 'notify') {
            body.status = $('m-off-send-status').value.trim();
            body.badge_color = $('m-off-send-badge').value;
            body.fields = moffSendFields.filter(function (f) { return f.label; });
        }
        if (!body.content && !body.template_id) return toast('请填写消息内容或选择模板');

        $('m-off-send-btn').textContent = '发送中…';
        $('m-off-send-btn').disabled = true;

        api('POST', '/api/merchant/official/send', body).then(function (res) {
            $('m-off-send-btn').textContent = '📤 发送';
            $('m-off-send-btn').disabled = false;
            if (!res.ok) return toast(res.msg || '发送失败');
            if (res.audit_status === 'pending') {
                toast('已进入审核队列（消息 ID #' + res.message_id + '）');
            } else {
                toast('发送成功！消息 ID #' + res.message_id);
            }
            $('m-off-send-mask').classList.add('hidden');
        });
    }

    // ==================== 启动 ====================
    (function boot() {
        if (!getToken()) { showLogin(); return; }
        api('GET', '/api/merchant/profile').then(function (res) {
            if (!res.ok) { showLogin(); return; } // 401 已由 api 归口跳登录
            profile = res.data;
            showMain();
        }).catch(function () { showLogin(); });
        $('m-boot').classList.add('hidden');
    })();


    // ==================== API 文档弹窗 ====================

    // 各 API 端点定义：method / url / 标题 / 请求体 / 说明
    // 字段名必须与后端 official_api.go 里的 json tag 完全一致
    var NO_BODY = '（GET 请求，无请求体）';
    var MOFF_API_DEFS = {
        auth: {
            method: 'POST', url: '/api/official/token',
            title: '🔐 获取 AccessToken',
            desc: '先用 AppID + AppSecret 换取 2 小时有效的 AccessToken，所有后续接口都要在 Header 里带 Bearer Token。也支持 HMAC-SHA256 签名模式。',
            body: '{ "app_id": "{APP_ID}", "app_secret": "{APP_SECRET}" }',
            resp: '{ "ok": true, "data": { "access_token": "xxx.xxx.xxx", "expires_in": 7200 } }'
        },
        notify: {
            method: 'POST', url: '/api/official/notify',
            title: '📤 发送消息（单发/批量/广播三合一）',
            desc: '一个接口搞定三种推送模式：type=single 单发 / batch 批量 / broadcast 全员广播。\n必填：type。single/batch 需传 recipients 数组。\ncontent_type 可选：text / notify / news / news_list / miniapp。notify 卡片支持 status 状态徽章、badge_color、fields 键值对列表、url + link_btn 跳转。\n也可以传 template_id 用模板发送，配合 template_data 做占位符替换。',
            body: JSON.stringify({
                type: 'single',
                recipients: ['user_123'],
                content_type: 'notify',
                title: '您的订单 {{order_no}} 已发货',
                content: '快递员：张三，电话：13800138000',
                status: '已发货',
                badge_color: 'green',
                fields: [
                    { label: '订单号', value: '{{order_no}}' },
                    { label: '物流公司', value: '顺丰速运' }
                ],
                url: 'https://example.com/order/detail',
                link_btn: '查看物流',
                template_data: { order_no: 'SF1234567890' }
            }, null, 2),
            resp: '{ "ok": true, "data": { "message_id": 12345, "sent": 1 } }'
        },
        batch: {
            method: 'POST', url: '/api/official/batch-notify',
            title: '📥 批量发送消息（专用接口）',
            desc: '一次最多发送给 1000 个用户。与 notify type=batch 等价，但返回结果更详细。\n必填：recipients 数组、content（或 template_id）。',
            body: JSON.stringify({
                recipients: ['user_1', 'user_2', 'user_3'],
                content_type: 'text',
                content: '本周活动通知：您有一张满 100 减 20 优惠券待领取',
                template_data: {}
            }, null, 2),
            resp: '{ "ok": true, "data": { "sent": 3, "failed": 0, "failed_reasons": [] } }'
        },
        menu: {
            method: 'POST', url: '/api/official/menu/set',
            title: '📋 设置 / 获取自定义菜单',
            desc: '【设置菜单】POST /api/official/menu/set — 设置后立即生效。最多 3 个一级菜单，每个一级菜单最多 5 个二级菜单。\n字段说明：action=click 点击触发事件（value 存事件 key）；action=view 点击打开 URL（value 存网址）。\n【获取菜单】GET /api/official/menu/get — 无参数，返回当前菜单树。',
            body: JSON.stringify({
                menus: [
                    {
                        name: '📖 浏览',
                        action: 'click',
                        value: 'browse_root',
                        children: [
                            { name: '🔥 最新活动', action: 'view', value: 'https://example.com/activity' },
                            { name: '🛍 产品列表', action: 'view', value: 'https://example.com/products' },
                            { name: '📝 我的订单', action: 'click', value: 'my_orders' }
                        ]
                    },
                    {
                        name: '💬 在线客服',
                        action: 'click',
                        value: 'contact_service'
                    },
                    {
                        name: '👤 个人中心',
                        action: 'view',
                        value: 'https://example.com/profile'
                    }
                ]
            }, null, 2),
            resp: '{ "ok": true }\n\n// GET /api/official/menu/get 响应示例:\n{ "ok": true, "data": { "menus": [ { "name": "📖 浏览", "children": [...] } ] } }'
        },
        template: {
            method: 'GET', url: '/api/official/template/list',
            title: '📑 模板列表 + 🎨 模板渲染',
            desc: '【获取模板列表】GET /api/official/template/list — 无参数。返回当前服务号所有模板。\n【渲染模板】POST /api/official/template/render — 手动把模板里的 {{key}} 替换成真实值，预览最终内容。',
            body: NO_BODY,
            resp: '{ "ok": true, "data": { "list": [ { "id": 1, "template_id": "tpl_abc123", "name": "订单发货通知", "content_type": "notify" } ], "total": 1 } }\n\n// POST /api/official/template/render 请求体:\n// { "template_id": "tpl_abc123", "template_data": { "order_no": "SF123456", "courier": "张三" } }'
        },
        stats: {
            method: 'GET', url: '/api/official/stats',
            title: '📊 数据统计',
            desc: '无参数 GET。返回订阅数、今日/本月推送数、取消订阅数、消息历史概览等运营数据。',
            body: NO_BODY,
            resp: '{ "ok": true, "data": { "subscribe_count": 128, "today_sent": 12, "month_sent": 356, "unsubscribe_count": 3 } }'
        }
    };

    var _hasBody = function (def) { return def.body && def.body !== NO_BODY; };

    var MOFF_CODE_TEMPLATES = {
        curl: {
            auth: function (host, def) {
                return '# 1. 获取 AccessToken\ncurl -X POST "' + host + def.url + '"\n' +
                    '  -H "Content-Type: application/json"\n' +
                    '  -d \'{"app_id": "{APP_ID}", "app_secret": "{APP_SECRET}"}\'\n\n' +
                    '# 返回: {"ok":true,"data":{"access_token":"xxx.xxx.xxx"}}\n' +
                    '# 2. 后续接口都带这个 Header:\n' +
                    '# Authorization: Bearer <access_token>';
            },
            _default: function (host, def) {
                var h = _hasBody(def) ? '  -H "Content-Type: application/json"' : '';
                var body = _hasBody(def) ? '\n  -d \'' + def.body + '\'' : '';
                return 'curl -X ' + def.method + ' "' + host + def.url + '"\n' +
                    (_hasBody(def) ? '  -H "Authorization: Bearer <access_token>"\n' : '  -H "Authorization: Bearer <access_token>"\n') +
                    h + body;
            }
        },
        python: {
            auth: function (host, def) {
                return 'import requests\n\n' +
                    'HOST = "' + host + '"\n' +
                    'APP_ID = "{APP_ID}"\n' +
                    'APP_SECRET = "{APP_SECRET}"\n\n' +
                    '# 1. 获取 Token\n' +
                    'r = requests.post(HOST + "' + def.url + '", json={"app_id": APP_ID, "app_secret": APP_SECRET})\n' +
                    'token = r.json()["data"]["access_token"]\n' +
                    'print("token:", token)\n\n' +
                    '# 2. 后续调用\n' +
                    'headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}';
            },
            _default: function (host, def) {
                var body = _hasBody(def) ? '\nbody = ' + def.body.replace(/"/g, "'") + '\n' : '';
                var method = def.method.toLowerCase();
                return 'import requests\n\n' +
                    'HOST = "' + host + '"\n' +
                    'TOKEN = "<从上一步获取的 access_token>"\n\n' +
                    'headers = {"Authorization": f"Bearer {TOKEN}"' + (_hasBody(def) ? ', "Content-Type": "application/json"' : '') + '}' + body + '\n' +
                    'r = requests.' + method + '(HOST + "' + def.url + '", headers=headers' + (_hasBody(def) ? ', json=body' : '') + ')\n' +
                    'print(r.json())';
            }
        },
        node: {
            auth: function (host, def) {
                return '// Node.js (axios)\nconst axios = require("axios");\n\n' +
                    'const HOST = "' + host + '";\n' +
                    'const APP_ID = "{APP_ID}";\n' +
                    'const APP_SECRET = "{APP_SECRET}";\n\n' +
                    'async function main() {\n' +
                    '  // 1. 获取 Token\n' +
                    '  const { data: r } = await axios.post(HOST + "' + def.url + '", {\n' +
                    '    app_id: APP_ID, app_secret: APP_SECRET\n' +
                    '  });\n' +
                    '  const token = r.data.access_token;\n' +
                    '  console.log("token:", token);\n' +
                    '}\nmain();';
            },
            _default: function (host, def) {
                var bodyCode = _hasBody(def) ? '  const body = ' + def.body + ';\n' : '';
                var method = def.method.toLowerCase();
                return '// Node.js (axios)\nconst axios = require("axios");\n\n' +
                    'axios.defaults.baseURL = "' + host + '";\n' +
                    'axios.defaults.headers.common["Authorization"] = "Bearer <access_token>";\n' + bodyCode +
                    'axios.' + method + '("' + def.url + '"' + (_hasBody(def) ? ', body' : '') + ')\n' +
                    '  .then(r => console.log(r.data))\n' +
                    '  .catch(e => console.error(e.response?.data));';
            }
        },
        java: {
            auth: function (host, def) {
                return '// Java (OkHttp)\nimport okhttp3.*;\nimport org.json.*;\n\n' +
                    'public class OfficialApiDemo {\n' +
                    '    private static final String HOST = "' + host + '";\n' +
                    '    private static final String APP_ID = "{APP_ID}";\n' +
                    '    private static final String APP_SECRET = "{APP_SECRET}";\n\n' +
                    '    public static void main(String[] args) throws Exception {\n' +
                    '        OkHttpClient client = new OkHttpClient();\n' +
                    '        JSONObject creds = new JSONObject();\n' +
                    '        creds.put("app_id", APP_ID).put("app_secret", APP_SECRET);\n' +
                    '        RequestBody rb = RequestBody.create(creds.toString(), MediaType.parse("application/json"));\n' +
                    '        Request req = new Request.Builder().url(HOST + "' + def.url + '").post(rb).build();\n' +
                    '        try (Response r = client.newCall(req).execute()) {\n' +
                    '            JSONObject root = new JSONObject(r.body().string());\n' +
                    '            String token = root.getJSONObject("data").getString("access_token");\n' +
                    '            System.out.println("token: " + token);\n' +
                    '        }\n' +
                    '    }\n}';
            },
            _default: function (host, def) {
                var bodyCode = '';
                if (_hasBody(def)) {
                    var javaBodyStr = def.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    bodyCode = '        JSONObject body = new JSONObject(\n' +
                        '            "' + javaBodyStr + '"\n' +
                        '        );\n        RequestBody rb = RequestBody.create(body.toString(), MediaType.parse("application/json"));\n';
                }
                var reqBuilder = !_hasBody(def) || def.method === 'GET' ?
                    '        Request req = new Request.Builder().url(HOST + "' + def.url + '").get()' :
                    '        Request req = new Request.Builder().url(HOST + "' + def.url + '").post(rb)';
                return '// Java (OkHttp)\nimport okhttp3.*;\nimport org.json.*;\n\n' +
                    'public class Demo {\n' +
                    '    public static void main(String[] args) throws Exception {\n' +
                    '        final String HOST = "' + host + '";\n' +
                    '        final String TOKEN = "<access_token>";\n' +
                    '        OkHttpClient client = new OkHttpClient();\n' + bodyCode +
                    reqBuilder + '\n' +
                    '            .addHeader("Authorization", "Bearer " + TOKEN)\n' +
                    '            .addHeader("Content-Type", "application/json")\n' +
                    '            .build();\n' +
                    '        try (Response r = client.newCall(req).execute()) {\n' +
                    '            System.out.println(r.body().string());\n' +
                    '        }\n' +
                    '    }\n}';
            }
        },
        go: {
            auth: function (host, def) {
                return '// Go (net/http)\npackage main\n\nimport (\n    "bytes"\n    "encoding/json"\n    "fmt"\n    "io"\n    "net/http"\n)\n\nconst (\n    Host      = "' + host + '"\n    AppID     = "{APP_ID}"\n    AppSecret = "{APP_SECRET}"\n)\n\nfunc main() {\n    body := map[string]string{"app_id": AppID, "app_secret": AppSecret}\n    b, _ := json.Marshal(body)\n    req, _ := http.NewRequest("POST", Host+"' + def.url + '", bytes.NewReader(b))\n    req.Header.Set("Content-Type", "application/json")\n    resp, _ := http.DefaultClient.Do(req)\n    defer resp.Body.Close()\n    raw, _ := io.ReadAll(resp.Body)\n    fmt.Println(string(raw))\n}';
            },
            _default: function (host, def) {
                var bodyCode = _hasBody(def) ?
                    '    body := map[string]interface{}{}\n    _ = json.Unmarshal([]byte(`' + def.body + '`), &body)\n    b, _ := json.Marshal(body)\n' :
                    '    var b []byte\n';
                var newReq = !_hasBody(def) || def.method === 'GET' ?
                    '    req, _ := http.NewRequest("GET", Host+"' + def.url + '", nil)' :
                    '    req, _ := http.NewRequest("' + def.method + '", Host+"' + def.url + '", bytes.NewReader(b))';
                return '// Go (net/http)\npackage main\n\nimport (\n    "bytes"\n    "encoding/json"\n    "fmt"\n    "io"\n    "net/http"\n)\n\nconst (\n    Host  = "' + host + '"\n    Token = "<access_token>"\n)\n\nfunc main() {\n' + bodyCode + newReq + '\n' +
                    '    req.Header.Set("Authorization", "Bearer "+Token)\n' +
                    '    req.Header.Set("Content-Type", "application/json")\n' +
                    '    resp, _ := http.DefaultClient.Do(req)\n' +
                    '    defer resp.Body.Close()\n' +
                    '    raw, _ := io.ReadAll(resp.Body)\n' +
                    '    fmt.Println(string(raw))\n}';
            }
        }
    };

    var _moffApiTab = 'auth';
    var _moffApiLang = 'curl';

    function openMoffApiDocs(id) {
        var acc = null;
        for (var i = 0; i < _moffAccounts.length; i++) {
            if (_moffAccounts[i].id === id) { acc = _moffAccounts[i]; break; }
        }
        if (!acc) return toast('服务号信息加载中，请刷新列表重试');

        var host = window.location.origin;
        var secret = acc.app_secret || '（请点击列表"密钥"按钮查看）';

        $('m-off-api-name').textContent = acc.display_name || acc.name || '—';
        $('m-off-api-appid').textContent = acc.app_id || '—';
        $('m-off-api-secret').textContent = secret;
        $('m-off-api-host').textContent = host;

        _moffApiTab = 'auth';
        _moffApiLang = 'curl';
        renderMoffApiBody();
        document.querySelectorAll('.m-api-tab').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-apitab') === 'auth');
        });
        document.querySelectorAll('.m-lang-tab').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-lang') === 'curl');
        });
        $('m-off-api-mask').classList.remove('hidden');
    }

    function renderMoffApiBody() {
        var body = $('m-off-api-body');
        var host = $('m-off-api-host').textContent;
        var appId = $('m-off-api-appid').textContent;
        var appSecret = $('m-off-api-secret').textContent;

        var def = MOFF_API_DEFS[_moffApiTab];
        var tpl = MOFF_CODE_TEMPLATES[_moffApiLang];
        var code = tpl[_moffApiTab] ? tpl[_moffApiTab](host, def) : tpl._default(host, def);
        code = code.replace(/\{APP_ID\}/g, appId).replace(/\{APP_SECRET\}/g, appSecret);

        body.innerHTML =
            '<div style="padding:14px 16px 6px;font-size:14px;color:#7cdcfc;font-family:Consolas,Menlo,monospace">' + escHtml(def.title) + '</div>' +
            '<div style="padding:0 16px 8px;font-size:12px;color:#9cdcfc">' + escHtml(def.desc) + '</div>' +
            '<div style="padding:0 16px 8px"><span style="background:#0e639c;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;margin-right:6px;font-family:Consolas,Menlo,monospace">' + def.method + '</span><code style="color:#ffb86c;font-size:12px;font-family:Consolas,Menlo,monospace">' + escHtml(def.url) + '</code></div>' +
            '<pre style="margin:0;padding:16px;overflow:auto;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:1.6;color:#d4d4d4;white-space:pre">' + escHtml(code) + '</pre>' +
            (def.resp ?
                '<div style="padding:8px 16px 2px;font-size:12px;color:#7cdcfc">✅ 响应示例：</div>' +
                '<pre style="margin:0;padding:8px 16px 16px;overflow:auto;font-family:Consolas,Menlo,monospace;font-size:12px;color:#8dc78e">' + escHtml(def.resp) + '</pre>' : '');
    }

    function copyCurrentCode() {
        var body = $('m-off-api-body');
        var pres = body.querySelectorAll('pre');
        if (pres.length === 0) return toast('没有可复制的内容');
        var text = pres[0].textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { toast('✅ 代码已复制到剪贴板'); });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast('✅ 代码已复制'); } catch (e) { toast('复制失败，请手动选择复制'); }
            document.body.removeChild(ta);
        }
    }

    function bindMoffApiEvents() {
        var apiMask = $('m-off-api-mask');
        if (!apiMask) return;
        $('m-off-api-close').addEventListener('click', function () { apiMask.classList.add('hidden'); });
        $('m-off-api-ok').addEventListener('click', function () { apiMask.classList.add('hidden'); });
        $('m-off-api-copy').addEventListener('click', copyCurrentCode);
        document.querySelectorAll('.m-api-tab').forEach(function (b) {
            b.addEventListener('click', function () {
                _moffApiTab = b.getAttribute('data-apitab');
                document.querySelectorAll('.m-api-tab').forEach(function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                renderMoffApiBody();
            });
        });
        document.querySelectorAll('.m-lang-tab').forEach(function (b) {
            b.addEventListener('click', function () {
                _moffApiLang = b.getAttribute('data-lang');
                document.querySelectorAll('.m-lang-tab').forEach(function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                renderMoffApiBody();
            });
        });
    }
    bindMoffApiEvents();

    // ===== 推送历史弹窗 =====
    var _moffHistoryAccountId = 0;
    function openMoffHistory(accountId) {
        _moffHistoryAccountId = accountId;
        var acc = (_moffAccounts || []).find(function (a) { return a.id === accountId; });
        var name = acc ? (acc.display_name || '') : ('#' + accountId);
        document.getElementById('m-off-history-title').textContent = '📜 推送历史 — ' + name;
        document.getElementById('m-off-history-status').value = '';
        document.getElementById('m-off-history-mask').classList.remove('hidden');
        loadMoffHistory();
    }
    function loadMoffHistory() {
        var status = document.getElementById('m-off-history-status').value;
        var path = '/api/merchant/official/messages?account_id=' + _moffHistoryAccountId + '&size=50';
        if (status) path += '&send_status=' + status;
        api('GET', path).then(function (result) {
            if (!result || !result.ok) {
                toast((result && result.msg) || '查询失败');
                return;
            }
            var list = result.list || [];
            var tbody = document.getElementById('m-off-history-tbody');
            if (!list.length) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light);padding:30px">暂无推送记录</td></tr>';
                document.getElementById('m-off-history-summary').textContent = '';
                return;
            }
            document.getElementById('m-off-history-summary').textContent = '共 ' + (result.total || list.length) + ' 条';
            var fmtType = function (t) {
                var m = { text: '📄 文本', notify: '📢 通知', news: '🖼️ 图文', news_list: '📑 多图文', miniapp: '💎 小程序' };
                return m[t] || t || '-';
            };
            var fmtStatus = function (s) {
                var m = {
                    pending:  '<span style="color:#ff9800">⏳ 待发送</span>',
                    sending:  '<span style="color:#2196f3">📤 发送中</span>',
                    sent:     '<span style="color:#4caf50">✅ 已发送</span>',
                    failed:   '<span style="color:#f44336">❌ 失败</span>',
                    recalled: '<span style="color:#9e9e9e">↩️ 已撤回</span>'
                };
                return m[s] || (s || '-');
            };
            var esc = function (s) {
                if (!s) return '';
                return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; });
            };
            var rows = list.map(function (r) {
                var content = r.title || '';
                if (!content && r.content) {
                    var plain = String(r.content).replace(/<[^>]+>/g, '');
                    content = plain.length > 60 ? plain.slice(0, 60) + '...' : plain;
                }
                var canRecall = r.send_status === 'sent' && r.recipient && String(r.recipient).length > 0 && String(r.recipient).indexOf(',') === -1;
                var recallBtn = canRecall
                    ? '<button class="admin-btn small danger" data-recall="' + r.id + '">↩️ 撤回</button>'
                    : '<span style="color:var(--text-light);font-size:12px">-</span>';
                return '<tr>' +
                    '<td>#' + r.id + '</td>' +
                    '<td>' + fmtType(r.content_type) + '</td>' +
                    '<td>' + (r.recipient ? esc(r.recipient) : '<span style="color:#ff9800">👥 群发</span>') + '</td>' +
                    '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(content) + '">' + esc(content || '-') + '</td>' +
                    '<td>' + fmtStatus(r.send_status) + '</td>' +
                    '<td>' + recallBtn + '</td>' +
                    '</tr>';
            }).join('');
            tbody.innerHTML = rows;
            tbody.querySelectorAll('[data-recall]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var mid = parseInt(b.getAttribute('data-recall'), 10);
                    if (!mid) return;
                    if (!window.confirm('确定撤回这条消息吗？撤回后订阅用户将看不到这条消息。')) return;
                    api('POST', '/api/merchant/official/messages/' + mid + '/recall').then(function (res) {
                        if (res && res.ok) {
                            toast(res.msg || '撤回成功');
                            loadMoffHistory();
                        } else {
                            toast((res && res.msg) || '撤回失败');
                        }
                    });
                });
            });
        });
    }
    document.getElementById('m-off-history-close').addEventListener('click', function () {
        document.getElementById('m-off-history-mask').classList.add('hidden');
    });
    document.getElementById('m-off-history-mask').addEventListener('click', function (e) {
        if (e.target === this) this.classList.add('hidden');
    });
    document.getElementById('m-off-history-refresh').addEventListener('click', loadMoffHistory);
    document.getElementById('m-off-history-status').addEventListener('change', loadMoffHistory);
    // esc 关闭
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !document.getElementById('m-off-history-mask').classList.contains('hidden')) {
            document.getElementById('m-off-history-mask').classList.add('hidden');
        }
    });

    // ========== 服务号二维码弹窗 ==========
    function openMoffQR(accountId) {
        var acc = (_moffAccounts || []).find(function (a) { return a.id === accountId; });
        if (!acc) { toast('服务号不存在'); return; }
        var appId = acc.app_id || '';
        if (!appId) { toast('服务号 app_id 无效'); return; }
        var modal = document.getElementById('m-off-qr-mask');
        if (!modal) return;
        // 填充信息
        document.getElementById('m-off-qr-name').textContent = acc.display_name || '';
        document.getElementById('m-off-qr-appid').textContent = appId;
        document.getElementById('m-off-qr-desc').textContent = acc.description || '扫码即可关注此服务号';
        // 构造订阅 URL 并生成二维码
        var subUrl = window.location.origin + '/subscribe.html?app_id=' + encodeURIComponent(appId);
        document.getElementById('m-off-qr-url').textContent = subUrl;
        var box = document.getElementById('m-off-qr-box');
        box.innerHTML = '';
        if (typeof window.qrcode === 'function') {
            var qr = window.qrcode(0, 'M');
            qr.addData(subUrl);
            qr.make();
            box.innerHTML = qr.createImgTag(6, 8);
            // 深色主题下强制白底（二维码需要）
            var img = box.querySelector('img');
            if (img) { img.style.background = '#fff'; img.style.padding = '8px'; img.style.borderRadius = '6px'; }
        } else {
            box.innerHTML = '<div style="color:var(--danger);padding:20px">二维码库未加载</div>';
        }
        modal.classList.remove('hidden');
    }
    document.getElementById('m-off-qr-close').addEventListener('click', function () {
        document.getElementById('m-off-qr-mask').classList.add('hidden');
    });
    document.getElementById('m-off-qr-mask').addEventListener('click', function (e) {
        if (e.target === this) this.classList.add('hidden');
    });

})();
