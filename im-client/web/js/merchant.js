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
    function showLogin() {
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
        if (v === 'games') loadGames();
        if (v === 'stats') loadStats();
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
    var AUDIT_TEXT = { 0: ['off', '官方'], 1: ['pending', '待审核'], 2: ['ok', '已通过'], 3: ['rej', '已驳回'] };
    var STATUS_BADGE = { 0: ['on', '上架中'], 1: ['offshelf', '已下架'] };

    function loadGames() {
        var box = $('m-game-list');
        box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/games?page=1&size=100').then(function (res) {
            var d = unwrap(res);
            games = d.list || [];
            renderGames();
        }).catch(function () {
            box.innerHTML = '<div class="m-empty">加载失败</div>';
        });
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
        try { ssList = JSON.parse(full.screenshots || '[]') || []; } catch (eSs) { ssList = []; }
        refreshSsTip();
    }
    function refreshCoverPrev() {
        var v = $('m-f-cover').value.trim();
        var img = $('m-f-cover-prev');
        if (v) { img.src = v; img.classList.remove('hidden'); }
        else img.classList.add('hidden');
    }

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
            recharge_gw: $('m-f-rgw-gw').value.trim()
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
    var verUploading = false, verCancelFlag = false, verStartedIds = [];
    function openVersion(g) {
        verGame = g;
        verFiles = [];
        verCancelFlag = false;
        $('m-ver-game').textContent = g.name;
        $('m-ver-version').value = '';
        $('m-ver-log').value = '';
        renderVerList();
        $('m-ver-progress').classList.add('hidden');
        $('m-ver-bar').style.width = '0';
        $('m-ver-ok').disabled = false;
        $('m-ver-ok').textContent = '开始上传并登记版本';
        $('m-ver-mask').classList.remove('hidden');
        loadVersions();
        osbInit($('m-ver-mask').querySelector('.m-modal'));
    }
    function loadVersions() {
        var box = $('m-ver-existing');
        box.innerHTML = '<div class="m-empty">加载中…</div>';
        api('GET', '/api/merchant/games/' + verGame.id + '/versions').then(function (res) {
            var d = unwrap(res);
            var list = d.versions || [];
            if (!list.length) { box.innerHTML = '<div class="m-empty">暂无版本，上传第一个版本后游戏即可安装</div>'; return; }
            var html = '<table class="m-table"><tr><th>版本</th><th>大小</th><th>文件数</th><th>时间</th><th></th></tr>';
            list.forEach(function (v) {
                html += '<tr><td>' + esc(v.version) + (v.version === d.latest_version ? ' <span class="m-badge ok">最新</span>' : '') +
                    '</td><td>' + fmtSize(v.size_bytes) + '</td><td>' + v.file_count + '</td><td>' + esc(v.create_time) +
                    '</td><td><button class="admin-btn small m-ver-del" data-vid="' + v.id + '" data-ver="' + esc(v.version) + '">删除</button></td></tr>';
            });
            box.innerHTML = html + '</table>';
            var dels = box.querySelectorAll('.m-ver-del');
            for (var i = 0; i < dels.length; i++) {
                dels[i].addEventListener('click', function () {
                    var vid = this.getAttribute('data-vid'), ver = this.getAttribute('data-ver');
                    showConfirm('删除版本', '删除 v' + ver + '？文件与清单将一并清理，不可恢复', function () {
                        api('DELETE', '/api/merchant/version/' + vid).then(function (res) {
                            unwrap(res);
                            toast('已删除 v' + ver);
                            loadVersions();
                        }).catch(function () { /* toast 已提示 */ });
                    }, true);
                });
            }
        }).catch(function () { box.innerHTML = '<div class="m-empty">加载失败</div>'; });
    }
    function collectFiles(input, useRelPath) {
        var fs = Array.prototype.slice.call(input.files);
        input.value = '';
        fs.forEach(function (f) {
            if (f.size <= 0) return; // 空文件服务端跳过
            var rel = useRelPath ? (f.webkitRelativePath || f.name) : f.name;
            verFiles.push({ file: f, rel_path: rel, size: f.size, state: 0 });
        });
        renderVerList();
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
    $('m-ver-cancel').addEventListener('click', function () {
        if (verUploading) { verCancelFlag = true; return; }
        $('m-ver-mask').classList.add('hidden');
        loadGames();
    });
    $('m-ver-ok').addEventListener('click', runVersionPublish);
    function verSleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    async function verUploadOne(f) {
        if (!window.crypto || !crypto.subtle) throw new Error('需安全上下文（https/localhost 或客户端内置窗口）才能计算 SHA-256');
        verSetState(f, 1);
        var buf = await f.file.arrayBuffer();
        var digest = await crypto.subtle.digest('SHA-256', buf);
        buf = null;
        var sha = '';
        var bytes = new Uint8Array(digest);
        for (var i = 0; i < bytes.length; i++) sha += ('0' + bytes[i].toString(16)).slice(-2);
        var uploadId = 'mf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        verStartedIds.push(uploadId);
        var total = Math.ceil(f.size / CHUNK);
        for (var seq = 0; seq < total; seq++) {
            if (verCancelFlag) { var xe = new Error('已取消'); xe.cancelled = true; throw xe; }
            verSetState(f, 2);
            var start = seq * CHUNK;
            var chunk = await f.file.slice(start, Math.min(start + CHUNK, f.size)).arrayBuffer();
            for (var attempt = 0; ; attempt++) {
                try {
                    var resp = await fetch('/api/merchant/upload/chunk?upload_id=' + encodeURIComponent(uploadId) +
                        '&seq=' + seq + '&total=' + total + '&size=' + f.size, {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/octet-stream' },
                        body: chunk
                    });
                    var r = await resp.json().catch(function () { return { ok: false, msg: '响应解析失败' }; });
                    if (!r.ok) throw new Error(r.msg || ('HTTP ' + resp.status));
                    break;
                } catch (e) {
                    if (verCancelFlag) { var ce = new Error('已取消'); ce.cancelled = true; throw ce; }
                    if (attempt >= 2) throw e;
                    await verSleep(600 * (attempt + 1));
                }
            }
            if (f._bar) f._bar.style.width = Math.round(((seq + 1) / total) * 100) + '%';
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
        var version = $('m-ver-version').value.trim();
        if (!version) { toast('请填写版本号'); return; }
        if (!verFiles.length) { toast('请先选择游戏目录或文件'); return; }
        verUploading = true;
        verCancelFlag = false;
        verStartedIds = [];
        $('m-ver-ok').textContent = '上传中…（再次点击取消）';
        $('m-ver-progress').classList.remove('hidden');
        var okFiles = [], failMsg = '', cancelled = false;
        for (var i = 0; i < verFiles.length; i++) {
            if (verCancelFlag) {
                for (var j = i; j < verFiles.length; j++) verSetState(verFiles[j], 5);
                cancelled = true;
                break;
            }
            try {
                okFiles.push(await verUploadOne(verFiles[i]));
                verSetState(verFiles[i], 3);
            } catch (e) {
                if (e && e.cancelled) {
                    for (var k = i; k < verFiles.length; k++) verSetState(verFiles[k], 5);
                    cancelled = true;
                } else {
                    failMsg = (verFiles[i].rel_path || '') + '：' + (e && e.message ? e.message : '上传失败');
                    verSetState(verFiles[i], 4);
                    for (var m = i + 1; m < verFiles.length; m++) verSetState(verFiles[m], 5);
                }
                break;
            }
            $('m-ver-bar').style.width = Math.round(((i + 1) / verFiles.length) * 100) + '%';
        }
        verUploading = false;
        if (cancelled) {
            await verCancelStarted();
            $('m-ver-ok').textContent = '开始上传并登记版本';
            toast('已取消上传');
            return;
        }
        if (failMsg) {
            await verCancelStarted();
            $('m-ver-ok').textContent = '开始上传并登记版本';
            toast('上传失败：' + failMsg);
            return;
        }
        var res = await api('POST', '/api/merchant/games/' + verGame.id + '/version', {
            version: version, changelog: $('m-ver-log').value, files: okFiles
        });
        $('m-ver-ok').textContent = '开始上传并登记版本';
        try {
            unwrap(res);
            toast('版本 v' + version + ' 登记成功，玩家端即时生效');
            verFiles = [];
            renderVerList();
            $('m-ver-progress').classList.add('hidden');
            loadVersions();
        } catch (e) { /* toast 已提示 */ }
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
    $('m-gw-dl').addEventListener('click', function () {
        var tip = $('m-gw-tip');
        tip.textContent = '下载中…';
        fetch('/api/merchant/gateway/package', { headers: { 'Authorization': 'Bearer ' + getToken() } })
            .then(function (r) {
                if (r.status === 401) { clearToken(); showLogin(); throw new Error('请重新登录'); }
                if (!r.ok) return r.json().then(function (j) { throw new Error(j.msg || ('HTTP ' + r.status)); });
                var cd = r.headers.get('Content-Disposition') || '';
                var m = /filename="?([^";]+)"?/.exec(cd);
                return r.blob().then(function (b) { return { blob: b, name: (m && m[1]) || 'im-gateway-2008r2.zip' }; });
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
