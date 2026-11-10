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
            return r.json().catch(function () { return { ok: false, msg: '网络异常' }; });
        }).catch(function () { return { ok: false, msg: '网络异常，请稍后重试' }; });
    }
    function unwrap(res) {
        if (res && res.ok) return res.data || {};
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
        var names = ['games', 'stats', 'gateway'];
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
    // 补丁工具下载（服务端托管 gametool.exe，与 im-server.exe 同目录）与教程页
    $('m-ver-tooldown').addEventListener('click', function () {
        fetch('/api/merchant/gametool', { headers: { 'Authorization': 'Bearer ' + getToken() } }).then(function (r) {
            if (!r.ok) return r.json().then(function (j) { throw new Error(j.msg || ('HTTP ' + r.status)); });
            return r.blob();
        }).then(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'gametool.exe';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
            toast('补丁工具已开始下载：gametool.exe');
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
})();
