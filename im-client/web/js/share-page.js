// ===== 网盘分享独立页逻辑（/s/<code> 落地页，123 云盘同款：内容列表+勾选批量） =====
// 设计归口（服务端统一数据归口，本页只展示）：
//  1. 查看/下载/浏览列表免登录：凭 分享码+提取码 访问 /api/drive/share/info|children|download
//  2. 保存到我的网盘需登录：服务端 driveCheckUser 以 WS 在线水位校验 → 本页复用 socket.js
//     同一套 LOGIN 协议建立会话（与主应用共享 localStorage['im_auth'] 凭据）
//  3. 失效文案（已取消/已过期/文件已删除/不存在）全部服务端返回，本页零判断
//  4. 全部弹层自绘（禁系统弹窗），主题变量归口 css/style.css（data-theme 跟随主程序设置）
//  5. 文案 i18n 归口 js/i18n.js（key 即中文原文）：静态文本由 apply() 首绘反查替换，
//     动态文本统一 T()（带参占位），服务端下发文本统一 TR() 全等反查，未归口回退中文

(function () {
    'use strict';

    // ===== 分享码解析（与主应用 chat.js 同款正则） =====
    var m = (location.pathname || '').match(/^\/s\/([A-Za-z0-9]{6,40})$/);
    var code = m ? m[1] : '';

    // ===== 文案翻译归口（i18n.js 未加载时优雅回退原文；T=动态文本/带参，TR=服务端文本反查） =====
    function T(key, params) { return window.I18N ? I18N.t(key, params) : key; }
    function TR(text) { return window.I18N ? I18N.tr(text) : text; }

    // ===== DOM 引用 =====
    function $(id) { return document.getElementById(id); }
    var loginEntry = $('sp-login-entry'), userNameEl = $('sp-user-name'), logoutBtn = $('sp-logout');
    var nameEl = $('sp-name'), metaEl = $('sp-meta'); // 卡片名/元信息仅提取锁定态使用
    var extractRow = $('sp-extract-row'), extractInput = $('sp-extract-input'),
        extractBtn = $('sp-extract-btn'), extractErr = $('sp-extract-err');
    var btnRow = $('sp-btn-row'), downloadBtn = $('sp-download-btn'), saveBtn = $('sp-save-btn'),
        previewBtn = $('sp-preview-btn');
    // 内容区（hero 信息条 + 面包屑/批量条 + 可勾选列表）
    var wrapEl = $('sp-wrap'), heroIcon = $('sp-hero-icon'), heroName = $('sp-hero-name'),
        heroMeta = $('sp-hero-meta'), heroStats = $('sp-hero-stats');
    var crumbEl = $('sp-crumb'), batchBar = $('sp-batchbar'), batchCount = $('sp-batch-count'),
        batchSaveBtn = $('sp-batch-save'), batchDlBtn = $('sp-batch-dl'), batchCancelBtn = $('sp-batch-cancel');
    var checkAllEl = $('sp-check-all'), listEl = $('sp-list'), emptyEl = $('sp-empty');
    var viewerMask = $('sp-viewer-mask'), viewerTitle = $('sp-viewer-title'),
        viewerBody = $('sp-viewer-body'), viewerClose = $('sp-viewer-close');
    var invalidEl = $('sp-invalid'), invalidText = $('sp-invalid-text');
    var loginMask = $('sp-login-mask'), loginClose = $('sp-login-close'),
        loginUser = $('sp-login-username'), loginPass = $('sp-login-password'),
        loginErr = $('sp-login-err'), loginOkBtn = $('sp-login-ok');
    var toastEl = $('sp-toast');

    // ===== 状态 =====
    var shareInfo = null;     // info 接口返回的 share 对象（提取通过后填充）
    var extract = '';         // 已通过的提取码（下载/保存/列表共用）
    var ticket = '';          // 下载票据（download URL 凭 ?t= 访问，不内嵌提取码，防复制直链）
    var ticketAt = 0;         // 票据签发时刻（超过 60 秒视为陈旧，再次动作前主动重签；
                              // 服务端 15 分钟滑动续期，正在播放的预览不中断）
    var authed = false;       // WS 登录成功（服务端在线水位达成）
    var pendingSave = false;  // 登录成功后自动补发保存
    var autoConnFailSilent = false; // 自动连接失败静默（仅回退顶栏，不弹错误）
    var lastRejectText = '';        // 最近一次 ERROR 帧文案（服务端拒绝判定：ERROR+close 连发）
    var toastTimer = 0;
    // 列表导航状态（123 云盘同款文件夹浏览）
    var crumbs = [];          // 面包屑栈 [{id,name}]，id=0 为分享根
    var curFid = 0;           // 当前目录 fid（0=分享根）
    var listSeq = 0;          // children 响应乱序守卫（快速进出目录时旧响应丢弃）
    var selSet = {};          // 当前目录勾选集合（不跨目录，进目录即清）
    var curItems = [];        // 当前目录条目缓存（勾选/批量动作取数）
    var batchBusy = false;    // 批量下载进行中（防重入）

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
                if (!res.ok) cb(new Error(data.error || T('请求失败({n})', { n: res.status })), data);
                else cb(null, data);
            }, function () {
                cb(new Error(T('请求失败({n})', { n: res.status })));
            });
        }, function () {
            cb(new Error(T('网络异常，请稍后重试')));
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
    // HTML 转义（列表行/面包屑由 innerHTML 拼接，文件名必须过此归口防 XSS）
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    // RFC3339 时间 → 'YYYY-MM-DD HH:mm'（列表时间列展示）
    function fmtTime(v) {
        if (!v) return '-';
        var d = new Date(v);
        if (isNaN(d.getTime())) return '-';
        var pad = function (x) { return x < 10 ? '0' + x : '' + x; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function expireText(ts) {
        if (!ts) return T('永久有效');
        var d = new Date(ts * 1000);
        var pad = function (x) { return x < 10 ? '0' + x : '' + x; };
        return T('有效期至 {d}', { d: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) });
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

    // ===== 自绘悬浮滑块（分享页精简版，主程序 chat.js 同款视觉与交互） =====
    // 本页不加载 chat.js，而 Office 预览滚动归口 office-preview.js 统一调 window._osbInit/_osbInitH
    // 注册滑块——故本页内嵌精简实现挂同款全局入口（共享模块零改动即生效）；
    // 样式复用 style.css 的 .osb-thumb/.osb-h/.sb-show/.osb-drag（share.html 已引入主样式）
    // 竖/横双轴同构：滚动 rAF 同步、悬停浮现（180ms 延迟防容器↔滑块间闪烁）、比例拖拽
    (function () {
        function make(el, horiz) {
            if (el[horiz ? '_osbH' : '_osb']) return; // 防重复初始化（与主程序同标记）
            el[horiz ? '_osbH' : '_osb'] = true;
            var thumb = document.createElement('div');
            thumb.className = 'osb-thumb' + (horiz ? ' osb-h' : '');
            document.body.appendChild(thumb);
            if (horiz) { el._osbThumbH = thumb; if (!el._osbThumb) el._osbThumb = thumb; }
            else el._osbThumb = thumb;
            // 按滚动比例刷新滑块位置与长度；fixed 定位基于容器可视区实时矩形
            function update() {
                var total = horiz ? el.scrollWidth : el.scrollHeight;
                var view = horiz ? el.clientWidth : el.clientHeight;
                var pos = horiz ? el.scrollLeft : el.scrollTop;
                if (total <= view + 1 || view === 0) { thumb.style.display = 'none'; return; }
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) { thumb.style.display = 'none'; return; }
                thumb.style.display = 'block';
                var len = Math.max(30, Math.round(view * view / total)); // 滑块最小 30px，内容越多越短
                var maxPos = view - len - 2; // 边距 2px
                var viewPos = 2 + Math.round(pos / Math.max(1, total - view) * (maxPos - 2));
                if (horiz) {
                    thumb.style.width = len + 'px';
                    thumb.style.left = Math.round(rect.left + viewPos) + 'px';
                    thumb.style.top = Math.round(rect.bottom - 8) + 'px'; // 底部 2px 边距（高 6px）
                } else {
                    thumb.style.height = len + 'px';
                    thumb.style.top = Math.round(rect.top + viewPos) + 'px';
                    thumb.style.left = Math.round(rect.right - 8) + 'px'; // 右侧 2px 边距（宽 6px）
                }
            }
            el.addEventListener('scroll', function () { requestAnimationFrame(update); }, { passive: true });
            if (window.ResizeObserver) new ResizeObserver(update).observe(el); // 尺寸变化同步（窗口缩放等）
            if (window.MutationObserver) new MutationObserver(update).observe(el, { childList: true, subtree: true });
            el.addEventListener('click', update, true); // 折叠/切换类点击后布局收敛复查
            // 悬停显隐：移出延迟 180ms，容器与滑块任一悬停则保持（拖拽可稳定抓住，同主程序口径）
            function show(on) {
                clearTimeout(el._osbHideT);
                if (on) {
                    el.classList.add('sb-hover');
                    if (el._osbThumb) el._osbThumb.classList.add('sb-show');
                    if (el._osbThumbH) el._osbThumbH.classList.add('sb-show');
                    update(); // 浮现时强制重定位，杜绝残留旧位置
                } else {
                    el._osbHideT = setTimeout(function () {
                        var hover = el.matches(':hover') ||
                            (el._osbThumb && el._osbThumb.matches(':hover')) ||
                            (el._osbThumbH && el._osbThumbH.matches(':hover'));
                        if (hover) return;
                        el.classList.remove('sb-hover');
                        if (el._osbThumb) el._osbThumb.classList.remove('sb-show');
                        if (el._osbThumbH) el._osbThumbH.classList.remove('sb-show');
                    }, 180);
                }
            }
            el.addEventListener('mouseenter', function () { show(true); });
            el.addEventListener('mouseleave', function () { show(false); });
            thumb.addEventListener('mouseenter', function () { clearTimeout(el._osbHideT); });
            thumb.addEventListener('mouseleave', function () { show(false); });
            // 滑块拖拽：按下后按位移比例映射回滚动位置（比例与 update 一致）
            thumb.addEventListener('mousedown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                thumb.classList.add('osb-drag');
                var startPos = horiz ? e.clientX : e.clientY;
                var startScroll = horiz ? el.scrollLeft : el.scrollTop;
                function onMove(ev) {
                    var view = horiz ? el.clientWidth : el.clientHeight;
                    var total = horiz ? el.scrollWidth : el.scrollHeight;
                    var len = (horiz ? thumb.offsetWidth : thumb.offsetHeight) || 30;
                    var d = (horiz ? ev.clientX : ev.clientY) - startPos;
                    var target = startScroll + d * (total - view) / Math.max(1, view - len - 2 - 2);
                    if (horiz) el.scrollLeft = target; else el.scrollTop = target;
                }
                function onUp() {
                    thumb.classList.remove('osb-drag');
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            update();
        }
        window._osbInit = function (el) { make(el, false); }; // 纵向（office-preview 归口按需调用）
        window._osbInitH = function (el) { make(el, true); }; // 横向（宽表双轴并存）
    })();

    // ===== 视图切换 =====
    function showInvalid(text) {
        $('sp-card').classList.add('hidden');
        wrapEl.classList.add('hidden');
        invalidText.textContent = text || T('分享不存在或已失效');
        invalidEl.classList.remove('hidden');
    }
    // 提取通过渲染：卡片收起，内容区（hero 信息条 + 面包屑 + 列表）显示
    function renderShare(sh) {
        invalidEl.classList.add('hidden');
        $('sp-card').classList.add('hidden');
        var kind = kindOf(sh);
        heroIcon.className = 'sp-icon k-' + kind;
        heroIcon.innerHTML = ICONS[kind] || ICONS.file;
        heroName.textContent = sh.file_name || T('未命名文件');
        heroName.title = sh.file_name || '';
        heroMeta.textContent = (sh.is_dir ? T('文件夹') : fmtSize(sh.size)) +
            ' · ' + T('{u} 分享', { u: sh.from || '' }) + ' · ' + expireText(sh.expire_at);
        // 分享统计（服务端归口计数，本行只展示；响应即含本次浏览）
        heroStats.textContent = T('{n} 次浏览', { n: sh.view_count || 0 }) + ' · ' +
            T('{n} 次下载', { n: sh.download_count || 0 }) + ' · ' + T('{n} 次保存', { n: sh.save_count || 0 });
        extractRow.classList.add('hidden');
        btnRow.classList.remove('hidden');
        // 文件夹分享 hero 无下载/无预览（整树无下载语义；预览走文件行点击，123 云盘同款）
        downloadBtn.classList.toggle('hidden', !!sh.is_dir);
        previewBtn.classList.toggle('hidden', !!sh.is_dir || !canPreviewName(sh.file_name || ''));
        // 内容区显示（主体顶部对齐：列表高时垂直居中会裁顶）
        wrapEl.classList.remove('hidden');
        document.querySelector('.sp-main').classList.add('sp-top');
        // 面包屑归位 + 首屏列表（列表容器挂自绘悬浮滑块，_osb 幂等标记防重复初始化）
        crumbs = [{ id: 0, name: sh.file_name || T('未命名文件') }];
        curFid = 0;
        if (!listEl._osb && window._osbInit) window._osbInit(listEl);
        loadChildren(0);
    }

    // ===== 在线预览（百度网盘分享页同款：凭 分享码+提取码 inline 下发，本页内联渲染） =====
    // 浏览器原生可渲染的类型归口（avi/mkv/mov/flv/wmv 等原生 <video> 不支持，不显示预览按钮）
    function canPreviewName(name) {
        var ext = ((name || '').split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) >= 0) return true;   // 图片
        if (['mp4', 'webm'].indexOf(ext) >= 0) return true;                                        // 视频（原生可播）
        if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].indexOf(ext) >= 0) return true;                   // 音频
        if (ext === 'pdf') return true;                                                            // PDF（iframe 内建阅读器）
        if (['txt', 'md', 'log', 'json'].indexOf(ext) >= 0) return true;                           // 文本
        if (window.OfficePreview && OfficePreview.kindOf(name)) return true;                       // Office（docx/表格/pptx 归口共享渲染）
        return false;
    }
    // ===== 下载票据（防复制直链：download URL 凭短时效票据访问，不内嵌提取码） =====
    // ticket 接口复用提取码校验（错码 429 锁定同款生效）；缓存 60 秒内复用（批量串行复用
    // 同一张票），超时/强制（401 重试）重签——服务端重启等票据作废场景自愈
    function ensureTicket(force, cb) {
        if (!force && ticket && Date.now() - ticketAt < 60 * 1000) { cb(null); return; }
        apiJSON('/api/drive/share/ticket?code=' + encodeURIComponent(code) +
            '&extract=' + encodeURIComponent(extract), null, function (err, data) {
            if (err) { cb(err); return; }
            ticket = data.ticket || '';
            ticketAt = Date.now();
            cb(null);
        });
    }
    // 分享文件下发 URL 归口（下载与预览共用；preview=1 服务端改 inline 下发；
    // 凭票据 ?t= 访问（不含提取码）；fid 空/0=分享根（hero 按钮语义不变），
    // 子文件传 fid 走服务端子树校验链路）
    function shareFileUrl(preview, fid) {
        return '/api/drive/share/download?code=' + encodeURIComponent(code) +
            '&t=' + encodeURIComponent(ticket) + (preview ? '&preview=1' : '') +
            (fid ? '&fid=' + fid : '');
    }
    // 预览泛化：item 空=分享根（hero 按钮），item=children 列表行（勾选行外的行点击预览）
    // 先取票据再渲染（票据失效自动重签）；媒体加载 401 一次性强刷自愈
    function openViewer(item) {
        var info = item || shareInfo;
        if (!info) return;
        ensureTicket(false, function (err) {
            if (err) { toast(TR(err.message) || T('预览加载失败')); return; }
            renderViewer(item);
        });
    }
    function renderViewer(item) {
            var info = item || shareInfo;
            var name = info.name || info.file_name || '';
            var kind = kindOf(info);
            var url = shareFileUrl(true, item ? item.id : 0);
            viewerTitle.textContent = name + ' · ' + T('在线预览');
            viewerBody.innerHTML = '<div class="sp-viewer-loading">' + T('正在加载预览…') + '</div>';
            viewerMask.classList.remove('hidden');
            if (window.OfficePreview && OfficePreview.kindOf(name)) {
                // Office 文档（docx/xls/xlsx/csv/pptx）：归口 OfficePreview 共享渲染（缺库自动懒加载）
                OfficePreview.render(url, name, viewerBody, T);
            } else if (kind === 'img') {
                viewerBody.innerHTML = '';
                var img = document.createElement('img');
                img.alt = name;
                mediaRetry(img, function () { return shareFileUrl(true, item ? item.id : 0); });
                img.src = url;
                viewerBody.appendChild(img);
            } else if (kind === 'pdf') {
                viewerBody.innerHTML = '';
                var frame = document.createElement('iframe');
                frame.src = url;
                viewerBody.appendChild(frame);
            } else if (kind === 'video') {
                viewerBody.innerHTML = '';
                var video = document.createElement('video');
                video.controls = true;
                video.autoplay = true;
                mediaRetry(video, function () { return shareFileUrl(true, item ? item.id : 0); });
                video.src = url;
                viewerBody.appendChild(video);
            } else if (kind === 'audio') {
                viewerBody.innerHTML = '';
                var audio = document.createElement('audio');
                audio.controls = true;
                audio.autoplay = true;
                mediaRetry(audio, function () { return shareFileUrl(true, item ? item.id : 0); });
                audio.src = url;
                viewerBody.appendChild(audio);
            } else {
                // 文本类：拉取后 <pre> 直显（2MB 截断提示，防超大文本卡渲染）；401 票据失效强刷重试一次
                fetchTextWithRetry(url, function () { return shareFileUrl(true, item ? item.id : 0); },
                    function (err, text) {
                        if (err) {
                            viewerBody.innerHTML = '<div class="sp-viewer-loading"></div>';
                            viewerBody.firstChild.textContent = err.message || T('预览加载失败');
                            return;
                        }
                        if (text.length > 2 * 1024 * 1024) text = text.slice(0, 2 * 1024 * 1024) + '\n\n…' + T('内容过大，仅预览前 2MB，请下载查看全文');
                        var pre = document.createElement('pre');
                        pre.textContent = text; // textContent 防 XSS
                        viewerBody.innerHTML = '';
                        viewerBody.appendChild(pre);
                        if (window._osbInit) window._osbInit(pre); // 文本滚动区自绘悬浮滑块（禁系统滚动条归口）
                    });
            }
    }
    // 媒体元素（img/video/audio）票据失效自愈：onerror 后强刷票据重设 src 一次
    // （文件真损坏时重试仍 onerror，标记保证不再循环）
    function mediaRetry(el, makeUrl) {
        var retried = false;
        el.onerror = function () {
            if (retried) return;
            retried = true;
            ensureTicket(true, function () { el.src = makeUrl(); });
        };
    }
    // 文本预览拉取（401 票据失效强刷重试一次；其余错误/成功经 cb 归口）
    function fetchTextWithRetry(url, makeUrl, cb) {
        fetch(url).then(function (res) {
            if (res.status === 401) {
                return new Promise(function (resolve, reject) {
                    ensureTicket(true, function (terr) {
                        if (terr) reject(terr); else resolve(null);
                    });
                }).then(function () { return fetch(makeUrl()); });
            }
            return res;
        }).then(function (res) {
            if (!res.ok) throw new Error(T('预览加载失败({n})', { n: res.status }));
            return res.text();
        }, function () { throw new Error(T('网络异常，请稍后重试')); }).then(function (text) {
            cb(null, text);
        }, function (err) {
            cb(err);
        });
    }
    function closeViewer() {
        viewerMask.classList.add('hidden');
        viewerBody.innerHTML = ''; // 清空内容区：视频/音频随之停止播放
    }
    previewBtn.addEventListener('click', function () { openViewer(); }); // hero 语义=item 空取分享根；直绑会把 event 误当条目致 Office 判型失败乱码
    viewerClose.addEventListener('click', closeViewer);
    viewerMask.addEventListener('click', function (e) { if (e.target === viewerMask) closeViewer(); });
    document.addEventListener('keydown', function (e) {
        // Esc 仅在预览层打开时接管（不影响提取码输入等场景）
        if (e.key === 'Escape' && !viewerMask.classList.contains('hidden')) closeViewer();
    });

    // ===== 分享内容列表（123 云盘同款：children 逐级浏览 + 勾选批量保存/下载） =====
    // 浏览免登录：children 每次请求全量走 分享码+提取码 校验（禁止缓存/绕过，
    // 提取码锁定计数器天然覆盖）；勾选不跨目录，进目录即清
    // 列表行骨架（children 加载期间占位：勾选方块+图标块+名条+大小/时间条，与真实行结构对齐；
    // 响应到达 renderList/error 分支 innerHTML 覆盖即天然移除，无需额外状态）
    function spSkelRows() {
        var row = '<div class="sp-skel-srow">' +
            '<span class="sp-skel-check"></span><span class="sp-skel-ficon"></span>' +
            '<span class="sp-skel-fname"></span><span class="sp-skel-fsize"></span><span class="sp-skel-ftime"></span></div>';
        var html = '';
        for (var i = 0; i < 4; i++) html += row;
        return html;
    }
    function loadChildren(fid) {
        var seq = ++listSeq;
        emptyEl.classList.add('hidden');
        listEl.innerHTML = spSkelRows();
        apiJSON('/api/drive/share/children?code=' + encodeURIComponent(code) +
            '&extract=' + encodeURIComponent(extract) + '&fid=' + (fid || 0), null, function (err, data) {
            if (seq !== listSeq) return; // 乱序丢弃（快速切换目录时旧响应不落榜）
            if (err) {
                listEl.innerHTML = '';
                toast(TR(err.message) || T('加载失败'));
                return;
            }
            curItems = data.items || [];
            selSet = {}; // 勾选不跨目录
            renderCrumbs();
            renderList();
            updateBatchBar();
        });
    }
    function findItem(id) {
        for (var i = 0; i < curItems.length; i++) if (curItems[i].id === id) return curItems[i];
        return null;
    }
    function renderCrumbs() {
        var html = '';
        for (var i = 0; i < crumbs.length; i++) {
            if (i > 0) html += '<span class="drive-crumb-sep">/</span>';
            if (i === crumbs.length - 1) html += '<span class="drive-crumb-cur">' + esc(crumbs[i].name) + '</span>';
            else html += '<span class="drive-crumb" data-idx="' + i + '">' + esc(crumbs[i].name) + '</span>';
        }
        crumbEl.innerHTML = html;
        crumbEl.querySelectorAll('.drive-crumb').forEach(function (el) {
            el.addEventListener('click', function () {
                var idx = +el.getAttribute('data-idx');
                crumbs = crumbs.slice(0, idx + 1); // 回跳即裁掉后方层级
                curFid = crumbs[idx].id;
                loadChildren(curFid);
            });
        });
    }
    // 行 HTML（复用主程序 .drive-check/.drive-icon 视觉；文件名过 esc 防 XSS）
    function spRowHtml(it) {
        var kind = kindOf(it);
        return '<div class="sp-row" data-id="' + it.id + '">' +
            '<span class="drive-check' + (selSet[it.id] ? ' checked' : '') + '"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>' +
            '<span class="sp-cell-name"><span class="drive-icon k-' + kind + '">' + (ICONS[kind] || ICONS.file) + '</span><span class="sp-fname" title="' + esc(it.name) + '">' + esc(it.name) + '</span></span>' +
            '<span class="sp-cell-size">' + (it.is_dir ? '-' : fmtSize(it.size)) + '</span>' +
            '<span class="sp-cell-time">' + fmtTime(it.update_time) + '</span>' +
            '</div>';
    }
    function renderList() {
        var html = '';
        for (var i = 0; i < curItems.length; i++) html += spRowHtml(curItems[i]);
        listEl.innerHTML = html;
        emptyEl.classList.toggle('hidden', curItems.length > 0);
        syncCheckAll();
    }
    function updateRowCheck(id) {
        var row = listEl.querySelector('.sp-row[data-id="' + id + '"]');
        if (row) row.querySelector('.drive-check').classList.toggle('checked', !!selSet[id]);
    }
    function syncCheckAll() {
        var all = curItems.length > 0;
        for (var i = 0; i < curItems.length; i++) {
            if (!selSet[curItems[i].id]) { all = false; break; }
        }
        checkAllEl.classList.toggle('checked', all);
    }
    function updateBatchBar() {
        var n = 0, k;
        for (k in selSet) if (selSet.hasOwnProperty(k)) n++;
        var hasFile = false;
        for (var i = 0; i < curItems.length; i++) {
            if (selSet[curItems[i].id] && !curItems[i].is_dir) { hasFile = true; break; }
        }
        var selecting = n > 0;
        batchBar.classList.toggle('hidden', !selecting);
        crumbEl.classList.toggle('hidden', selecting); // 批量条替代面包屑行（123 云盘同款）
        if (selecting) {
            batchCount.textContent = T('已选 {n} 项', { n: n });
            batchDlBtn.disabled = !hasFile; // 只勾了文件夹：无可下载文件，下载置灰
        }
    }
    function clearSelection() {
        selSet = {};
        listEl.querySelectorAll('.sp-row .drive-check.checked').forEach(function (el) {
            el.classList.remove('checked');
        });
        syncCheckAll();
        updateBatchBar();
    }
    function toggleSel(id) {
        if (selSet[id]) delete selSet[id]; else selSet[id] = true;
        updateRowCheck(id);
        syncCheckAll();
        updateBatchBar();
    }
    // 列表事件委托（行点击=进目录/预览；勾选列点击=勾选不触发行动作）
    listEl.addEventListener('click', function (e) {
        var row = e.target.closest ? e.target.closest('.sp-row') : null;
        if (!row) return;
        var id = +row.getAttribute('data-id');
        var it = findItem(id);
        if (!it) return;
        var chk = row.querySelector('.drive-check');
        if (chk && (e.target === chk || chk.contains(e.target))) { toggleSel(id); return; }
        if (it.is_dir) {
            crumbs.push({ id: it.id, name: it.name });
            curFid = it.id;
            loadChildren(curFid);
            return;
        }
        if (canPreviewName(it.name)) openViewer(it);
        else toast(T('该文件不支持在线预览，请下载查看'));
    });
    // 表头主勾选框（两态 toggle：全选/全不选，仅作用于当前目录）
    checkAllEl.addEventListener('click', function () {
        var all = curItems.length > 0;
        for (var i = 0; i < curItems.length; i++) {
            if (!selSet[curItems[i].id]) { all = false; break; }
        }
        for (var j = 0; j < curItems.length; j++) {
            if (all) delete selSet[curItems[j].id]; else selSet[curItems[j].id] = true;
        }
        renderList(); // 全量刷新勾选态最简
        updateBatchBar();
    });
    batchCancelBtn.addEventListener('click', clearSelection);
    batchSaveBtn.addEventListener('click', requestSave); // 与 hero 保存同链路（登录引导/自动补发共用）
    // 批量下载（页内串行队列：fetch→blob→a[download]，与主程序 drive.js 同款；
    // 免登录可发起——download 接口凭 分享码+票据 访问（批量前取一次票串行复用，
    // 中途失效自动强刷重试一次）；仅下载文件，文件夹跳过）
    function batchDownload() {
        if (batchBusy) return;
        var files = [];
        for (var i = 0; i < curItems.length; i++) {
            if (selSet[curItems[i].id] && !curItems[i].is_dir) files.push(curItems[i]);
        }
        if (!files.length) { toast(T('所选项目均不支持下载')); return; }
        ensureTicket(false, function (err) {
            if (err) { toast(TR(err.message) || T('下载失败')); return; }
            batchBusy = true;
            batchDlBtn.disabled = true;
            var idx = 0;
            (function next() {
                if (idx >= files.length) {
                    batchBusy = false;
                    batchDlBtn.disabled = false;
                    toast(T('下载完成'));
                    return;
                }
                var it = files[idx++];
                var retried = false;
                toast(T('正在下载 {i}/{n}…', { i: idx, n: files.length }));
                (function attempt() {
                    fetch(shareFileUrl(false, it.id)).then(function (res) {
                        if (res.status === 401 && !retried) { // 票据失效（批量中途过期）：强刷重试本文件一次
                            retried = true;
                            ensureTicket(true, function (terr) {
                                if (terr) { fail(); return; }
                                attempt();
                            });
                            return;
                        }
                        if (!res.ok) throw new Error(res.status);
                        return res.blob();
                    }).then(function (blob) {
                        if (!blob) return; // 401 重试分支（无 blob，下一轮 attempt 接力）
                        var a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = it.name;
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
                        next();
                    }, fail);
                })();
                function fail() {
                    batchBusy = false;
                    batchDlBtn.disabled = false;
                    toast(T('下载失败'));
                }
            })();
        });
    }
    batchDlBtn.addEventListener('click', batchDownload);

    // ===== 分享信息获取（info 免登录归口；need_extract 引导提取码行） =====
    function fetchInfo(ex) {
        apiJSON('/api/drive/share/info?code=' + encodeURIComponent(code) +
            '&extract=' + encodeURIComponent(ex || ''), null, function (err, data) {
            $('sp-card').classList.add('loaded'); // 数据到达：移除首屏骨架（三态出口统一归口此一行）
            if (err) {
                if (data && data.need_extract) {
                    // 需要提取码：显示输入行（错误文案如"提取码错误"显示在输入行下方）
                    $('sp-card').classList.remove('hidden');
                    invalidEl.classList.add('hidden');
                    nameEl.textContent = T('加密分享');
                    metaEl.textContent = T('输入提取码后查看和下载文件');
                    extractRow.classList.remove('hidden');
                    if (ex) showError(extractErr, TR(err.message) || T('提取码错误'));
                    setTimeout(function () { extractInput.focus(); extractInput.select(); }, 60);
                } else {
                    showInvalid(TR(err.message));
                }
                return;
            }
            shareInfo = data.share;
            extract = ex || '';
            renderShare(shareInfo);
        });
    }

    // ===== 下载（免登录：浏览器原生下载，本地流式/MinIO 302 均带 attachment） =====
    // 先取下载票据（凭提取码签发，URL 不内嵌提取码，防复制直链绕过分享页）
    downloadBtn.addEventListener('click', function () {
        if (!code) return;
        ensureTicket(false, function (err) {
            if (err) { toast(TR(err.message) || T('下载失败')); return; }
            toast(T('开始下载…'));
            location.href = shareFileUrl(false, 0);
        });
    });

    // ===== 保存到我的网盘（需登录 = WS 在线水位） =====
    // 有勾选=批量保存选中项（服务端 items 逐项子树校验），无勾选=整树保存（旧语义不变）
    function doSave() {
        var u = (window.IMSocket && IMSocket.getUsername()) || (getAuth() || {}).u || '';
        if (!u) { openLoginPanel(true); return; }
        saveBtn.disabled = true;
        batchSaveBtn.disabled = true;
        var items = [];
        for (var k in selSet) if (selSet.hasOwnProperty(k)) items.push(+k);
        var selMode = items.length > 0;
        apiJSON('/api/drive/share/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, code: code, extract: extract, parent_id: 0, items: items })
        }, function (err, data) {
            saveBtn.disabled = false;
            batchSaveBtn.disabled = false;
            if (err) {
                var raw = err.message || '';
                if (raw.indexOf('未在线') >= 0) { // 在线水位判定用未翻译原文（翻译后关键词失效）
                    // 在线水位失效（密码被改/被踢下线）：引导重新登录后自动补发
                    authed = false;
                    openLoginPanel(true);
                    return;
                }
                toast(TR(raw) || T('保存失败'));
                return;
            }
            if (selMode) {
                toast(T('已保存选中 {n} 项', { n: data && data.saved || 0 }));
                clearSelection();
            } else {
                toast(T('已保存到我的网盘（共 {n} 项）', { n: data && data.saved || 0 }));
            }
        });
    }
    // 保存入口归一（hero 保存按钮与批量条"保存"共用：登录引导/自动补发同一链路）
    function requestSave() {
        if (!code) return;
        if (authed) { doSave(); return; }
        var saved = getAuth();
        if (saved && saved.u && saved.p) {
            // 已有凭据：连接中，登录成功后自动补发保存
            pendingSave = true;
            saveBtn.disabled = true;
            toast(T('正在连接，登录成功后自动保存…'));
            connectWS(saved.u, saved.p, false);
        } else {
            openLoginPanel(true);
        }
    }
    saveBtn.addEventListener('click', requestSave);

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
        if (!u || !p) { showError(loginErr, T('请输入账号和密码')); return; }
        loginOkBtn.disabled = true;
        showError(loginErr, T('正在登录…'));
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
        if (!window.IMSocket) { onLoginFail(fromPanel, T('连接组件加载失败')); return; }
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
            showError(loginErr, TR(text) || T('登录失败，请检查账号密码'));
        } else {
            toast(TR(text) || T('登录状态已失效'));
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
            if (!loginMask.classList.contains('hidden')) showError(loginErr, TR(lastRejectText) || T('登录失败，请检查账号密码'));
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
                toast(T('账号已在其他设备登录，本页已下线'));
                return;
            }
            // 服务端拒绝判定与 socket.js 同款：ERROR 帧后紧连 close（1 秒窗口）= 凭据问题清凭据；纯网络失败保留
            var rejected = !!lastRejectText;
            onLoginFail(!loginMask.classList.contains('hidden'), lastRejectText || T('连接失败，请稍后重试'), !rejected);
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
        if (!v) { showError(extractErr, T('请输入提取码')); return; }
        fetchInfo(v);
    });

    // ===== 启动 =====
    (function boot() {
        if (!code) { showInvalid(T('链接无效')); return; }
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
