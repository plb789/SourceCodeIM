// ===== 网盘模块（百度网盘同款个人云盘，一期：目录浏览/上传/下载/重命名/删除/新建文件夹） =====
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 数据源唯一归口 /api/drive/*（列表/建目录/重命名/删除/上传/下载），客户端零本地状态持久化
//  2. 页面形态：#drive-view 覆盖 .main-chat 右侧聊天区（公告流/设置页同款 absolute 覆盖，
//     DOM 常驻 body 由本模块移入主聊天区），左侧列表保持可见可点；切走 Tab / 返回聊天 / Esc 关闭
//  3. 交互约束（项目规则）：全部弹窗自绘（.modal-mask/.modal-box 复用，禁系统弹窗）；
//     滚动条用全局自绘悬浮滑块（chat.js _osbInit 注册，加载顺序在 chat.js 之后）
//  4. 传输面板（百度网盘同款）：右下角浮层 上传/下载双 tab 列表，逐项进度条+大小+速度+剩余时间+取消；
//     上传统一走大文件链路（网盘二期）：本地 Web Worker 分块算 MD5 → init 秒传判定/断点续传
//     → 逐片 POST → complete 合并（秒传命中零传输，取消保留服务端会话下次自动续传）；
//     下载 fetch 流式归口（MinIO 走 302 预签名直连已实测暴露 CORS+Content-Length，本地后端同源），
//     均串行队列，完成自动刷新
//  5. 主题：全部颜色走 CSS 变量（--primary/--panel-bg/--border 等），跟随主题色变化

(function () {
    'use strict';

    // ===== DOM 引用 =====
    var view = document.getElementById('drive-view');
    if (!view) return; // 页面无网盘视图（异常裁剪）直接静默退出
    var listEl = document.getElementById('drive-file-list');
    var emptyEl = document.getElementById('drive-empty');
    var breadcrumbEl = document.getElementById('drive-breadcrumb');
    var mkdirBtn = document.getElementById('drive-mkdir-btn');
    var uploadBtn = document.getElementById('drive-upload-btn');
    var closeBtn = document.getElementById('drive-close');
    var storageTag = document.getElementById('drive-storage-tag');
    var uploadsEl = document.getElementById('drive-uploads');
    var uploadItemsEl = document.getElementById('drive-upload-items');
    var downItemsEl = document.getElementById('drive-down-items');
    var uploadsClearBtn = document.getElementById('drive-uploads-clear');
    var tabUpEl = document.getElementById('drive-tab-up-count');
    var tabDownEl = document.getElementById('drive-tab-down-count');
    var fileInput = document.getElementById('drive-file-input');
    var dropMask = document.getElementById('drive-drop-mask');
    var searchInput = document.getElementById('drive-search');
    var searchClearBtn = document.getElementById('drive-search-clear');
    // 批量操作（多选模式：工具栏入口 + 顶部批量操作条）
    var selectBtn = document.getElementById('drive-select-btn');
    var batchBar = document.getElementById('drive-batch-bar');
    var batchCountEl = document.getElementById('drive-batch-count');
    var batchSelAllBtn = document.getElementById('drive-batch-selall');
    var batchDownBtn = document.getElementById('drive-batch-download');
    var batchMoveBtn = document.getElementById('drive-batch-move');
    var batchCopyBtn = document.getElementById('drive-batch-copy');
    var batchDelBtn = document.getElementById('drive-batch-delete');
    var batchCancelBtn = document.getElementById('drive-batch-cancel');
    // 右键菜单（复用全站 .friend-menu 样式；打开时搬移 body 级防祖先 overflow 裁剪）
    var ctxMenu = document.getElementById('drive-menu');
    var ctxTarget = null; // 右键目标条目（null=空白处，粘贴目标=当前目录）
    var clip = null;      // 剪贴板 {mode:'copy'|'move', ids:[]}（右键复制/移动归口；移动粘贴后清空，复制粘贴后保留可多次粘贴）
    // 回收站（二期：回收站操作条 + 时间列表头；v2.21 入口上移左侧列表，工具栏按钮移除）
    var trashBar = document.getElementById('drive-trash-bar');
    var trashCountEl = document.getElementById('drive-trash-count');
    var trashClearBtn = document.getElementById('drive-trash-clear');
    var colTimeEl = document.getElementById('drive-col-time');
    var mainChatEl = document.querySelector('.main-chat');
    // 左侧网盘面板（我的文件/分享管理/回收站 三入口 + 容量概览；v2.21 分享管理/回收站入口上移至此）
    var driveEntry = document.getElementById('drive-entry-root');
    var shareEntry = document.getElementById('drive-entry-share');
    var trashEntry = document.getElementById('drive-entry-trash');
    var usageEl = document.getElementById('drive-usage');
    var usageFill = document.getElementById('drive-usage-fill');
    var usageText = document.getElementById('drive-usage-text');
    // 分享模块（二期：分享弹窗/分享详情 弹层；v2.21 分享管理弹窗 dsm 移除，改 shareMode 页面内显示）
    var dsMask = document.getElementById('ds-mask');
    var dsFileIcon = document.getElementById('ds-file-icon');
    var dsFileName = document.getElementById('ds-file-name');
    var dsFileMeta = document.getElementById('ds-file-meta');
    var dsTabChat = document.getElementById('ds-tab-chat');
    var dsTabLink = document.getElementById('ds-tab-link');
    var dsPaneChat = document.getElementById('ds-pane-chat');
    var dsPaneLink = document.getElementById('ds-pane-link');
    var dsContactSearch = document.getElementById('ds-contact-search');
    var dsContactList = document.getElementById('ds-contact-list');
    var dsPickCount = document.getElementById('ds-pick-count');
    var dsSendBtn = document.getElementById('ds-send-btn');
    var dsExpireGroup = document.getElementById('ds-expire-group');
    var dsWithCode = document.getElementById('ds-with-code');
    var dsGenBtn = document.getElementById('ds-gen-btn');
    var dsLinkResult = document.getElementById('ds-link-result');
    var dsLinkText = document.getElementById('ds-link-text');
    var dsLinkCode = document.getElementById('ds-link-code');
    var dsCodeRow = document.getElementById('ds-code-row');
    var dsCopyBtn = document.getElementById('ds-copy-btn');
    // v2.21 分享管理页面（shareMode）：操作条 refs（列表复用主列表区 listEl）
    var shareBar = document.getElementById('drive-share-bar');
    var shareCountEl = document.getElementById('drive-share-count');
    var shareBackBtn = document.getElementById('drive-share-back');
    var dsdMask = document.getElementById('dsd-mask');
    var dsdTitle = document.getElementById('dsd-title');
    var dsdIcon = document.getElementById('dsd-icon');
    var dsdName = document.getElementById('dsd-name');
    var dsdMeta = document.getElementById('dsd-meta');
    var dsdExtractRow = document.getElementById('dsd-extract-row');
    var dsdExtract = document.getElementById('dsd-extract');
    var dsdExtractOk = document.getElementById('dsd-extract-ok');
    var dsdInvalid = document.getElementById('dsd-invalid');
    var dsdCancelBtn = document.getElementById('dsd-cancel');
    var dsdDownBtn = document.getElementById('dsd-down-btn');
    var dsdSaveBtn = document.getElementById('dsd-save-btn');

    // ===== 状态 =====
    var inited = false;      // 一次性初始化标记（DOM 移入/事件绑定/滚动条注册）
    var visible = false;     // 页面显隐
    var curParent = 0;       // 当前目录 ID（0=根目录）
    var crumbs = [];         // 面包屑路径 [{id,name}]（进入时追加，面包屑点击回跳）
    var listLoaded = false;  // 是否已拉取过列表（首次进入加载，此后操作后刷新）
    var itemsCache = [];     // 当前列表缓存（服务端排序归口，渲染用）
    var searchMode = false;  // 搜索结果态（true=列表显示全盘搜索结果；进入目录/清空即退出）
    var searchTimer = 0;     // 输入防抖定时器
    var searchSeq = 0;       // 搜索请求序号（丢弃过期响应，防慢请求乱序覆盖）
    var selMode = false;     // 多选模式（批量下载/删除；进入目录/搜索/关闭页面退出）
    var selSet = {};         // 已选 id 集合（id→true）
    var trashMode = false;   // 回收站模式（列表显示回收站项；恢复/彻底删除/清空；互斥多选/搜索）
    var shareMode = false;   // v2.21 分享管理模式（右侧页面内显示我发出的分享；互斥回收站/多选/搜索）

    function u() { return (window.IMSocket && IMSocket.getUsername()) || ''; }
    // i18n 归口（key=中文原文渐进式迁移）：T=动态文案带参翻译，TR=服务端下发文本全等反查（未命中原样返回）
    function T(s, p) { return (window.I18N ? I18N.t(s, p) : s); }
    function TR(s) { return (window.I18N ? I18N.tr(s) : s); }

    // ===== 通用请求（JSON 归口：失败弹自绘提示，服务端 error 文本全等反查翻译，客户端兜底文案走 T） =====
    function apiJSON(url, opts, cb) {
        fetch(url, opts).then(function (res) {
            res.json().then(function (data) {
                if (!res.ok) cb(new Error(data.error ? TR(data.error) : T('请求失败({n})', { n: res.status })), data);
                else cb(null, data);
            }, function () {
                cb(new Error(T('请求失败({n})', { n: res.status })));
            });
        }, function () {
            cb(new Error(T('网络异常，请稍后重试')));
        });
    }
    function apiGet(cb) {
        apiJSON('/api/drive/list?username=' + encodeURIComponent(u()) + '&parent_id=' + curParent, null, cb);
    }
    function apiPost(path, body, cb) {
        apiJSON('/api/drive/' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }, cb);
    }

    // ===== Toast（复用全局 #toast 元素，2.5s 自灭） =====
    var toastEl = document.getElementById('toast');
    var toastTimer = 0;
    function toast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2500);
    }

    // ===== 自绘弹窗（.modal-mask/.modal-box 公共样式复用；confirm 输入双形态） =====
    var maskEl = null;
    function ensureModal() {
        if (maskEl) return;
        maskEl = document.createElement('div');
        maskEl.className = 'modal-mask hidden';
        maskEl.innerHTML =
            '<div class="modal-box drive-modal-box">' +
            '  <div class="modal-title" id="drive-modal-title"></div>' +
            '  <div class="modal-text hidden" id="drive-modal-text"></div>' +
            '  <input class="modal-input hidden" id="drive-modal-input" maxlength="255">' +
            '  <div class="modal-btns">' +
            '    <button class="modal-btn" id="drive-modal-cancel">' + T('取消') + '</button>' +
            '    <button class="modal-btn drive-modal-ok" id="drive-modal-ok">' + T('确定') + '</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(maskEl);
        maskEl.addEventListener('click', function (e) { if (e.target === maskEl) closeModal(); });
        document.getElementById('drive-modal-cancel').addEventListener('click', closeModal);
        document.getElementById('drive-modal-ok').addEventListener('click', function () {
            var cb = maskEl._okCb;
            closeModal();
            if (cb) cb();
        });
        document.getElementById('drive-modal-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); document.getElementById('drive-modal-ok').click(); }
        });
    }
    function closeModal() {
        if (!maskEl) return;
        maskEl.classList.add('hidden');
        maskEl._okCb = null;
    }
    // 输入弹窗：title 标题、placeholder 占位、prefill 预填、onOk(输入值)
    function drivePrompt(title, placeholder, prefill, onOk) {
        ensureModal();
        maskEl._okCb = function () {
            var val = document.getElementById('drive-modal-input').value.trim();
            if (val) onOk(val);
        };
        document.getElementById('drive-modal-title').textContent = title;
        var textEl = document.getElementById('drive-modal-text');
        textEl.classList.add('hidden');
        var inputEl = document.getElementById('drive-modal-input');
        inputEl.classList.remove('hidden');
        inputEl.value = prefill || '';
        inputEl.placeholder = placeholder || '';
        maskEl.classList.remove('hidden');
        setTimeout(function () { inputEl.focus(); }, 50);
    }
    // 确认弹窗：title/text、onOk 确认回调（删除等危险操作）
    function driveConfirm(title, text, onOk) {
        ensureModal();
        maskEl._okCb = onOk;
        document.getElementById('drive-modal-title').textContent = title;
        var textEl = document.getElementById('drive-modal-text');
        textEl.textContent = text;
        textEl.classList.remove('hidden');
        document.getElementById('drive-modal-input').classList.add('hidden');
        maskEl.classList.remove('hidden');
    }

    // ===== 工具函数 =====
    function fmtSize(n) {
        if (n == null) return '-';
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'], v = n, i = -1;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
    }
    function fmtTime(s) {
        if (!s) return '-';
        var d = new Date(s);
        if (isNaN(d.getTime())) return '-';
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    // 传输速度（字节/秒 → 可读文本）
    function fmtSpeed(bps) {
        if (!bps || bps <= 0) return '';
        return fmtSize(bps) + '/s';
    }
    // 剩余时间（秒 → 可读文本；超过一小时显示 >1h）
    function fmtRemain(sec) {
        if (!isFinite(sec) || sec <= 0) return '';
        if (sec > 3600) return T('>1小时');
        var m = Math.floor(sec / 60), s = Math.round(sec % 60);
        if (m > 0) return T('剩余 {m} 分 {s} 秒', { m: m, s: (s < 10 ? '0' : '') + s });
        return T('剩余 {s} 秒', { s: s });
    }
    // 文件类别归口（图标渲染：目录/图片/视频/音频/压缩包/文档/表格/PDF/通用）
    function kindOf(item) {
        if (item.is_dir) return 'dir';
        // 兼容分享记录（file_name）/网盘文件与卡片信封（name）两种字段归口
        var ext = ((item.name || item.file_name || '').split('.').pop() || '').toLowerCase();
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
    // 类别 SVG 图标（currentColor + 色板类：k-dir 黄 / k-img 绿 / k-video 蓝 / k-audio 紫 / 其余主题灰绿）
    var ICONS = {
        dir: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
        img: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
        video: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
        audio: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
        zip: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-4 9v2h-2v-2h2zm0-4v2h-2v-2h2zm-2-2V7h2v2h-2zm2 6h-2v-2h2v2z"/></svg>',
        doc: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
        sheet: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-2h2v2zm0-4H7v-2h2v2zm0-4H7V7h2v2zm4 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2zm4 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/></svg>',
        pdf: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7V7h3c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5H13V7h2c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-2V7h3.5v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/></svg>',
        txt: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
        file: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>'
    };
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ===== 渲染 =====
    function renderBreadcrumb() {
        var html = '';
        for (var i = 0; i < crumbs.length; i++) {
            var c = crumbs[i];
            if (i > 0) html += '<span class="drive-crumb-sep">/</span>';
            if (i === crumbs.length - 1) html += '<span class="drive-crumb-cur">' + esc(c.name) + '</span>';
            else html += '<span class="drive-crumb" data-id="' + c.id + '">' + esc(c.name) + '</span>';
        }
        breadcrumbEl.innerHTML = html;
        breadcrumbEl.querySelectorAll('.drive-crumb').forEach(function (el) {
            el.addEventListener('click', function () { enterDir(parseInt(el.getAttribute('data-id'), 10), null, true); });
        });
    }

    // 行模板归口（目录列表与搜索结果共用；showPath=true 时名称下方追加"所在位置"小字路径）
    // 多选模式行首带自绘勾选框（显隐由 .drive-view.selecting CSS 归口，选中态随 selSet）
    function rowHtml(it, showPath) {
        var kind = kindOf(it);
        var loc = it.path || T('我的文件');
        return '<div class="drive-row' + (it.is_dir ? ' is-dir' : '') + (selSet[it.id] ? ' selected' : '') + '" data-id="' + it.id + '">' +
            '  <div class="drive-cell-name">' +
            '    <span class="drive-check' + (selSet[it.id] ? ' checked' : '') + '"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>' +
            '    <span class="drive-icon k-' + kind + '">' + ICONS[kind] + '</span>' +
            '    <div class="drive-name-wrap">' +
            '      <span class="drive-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
            (showPath ? '      <span class="drive-row-path" title="' + esc(loc) + '">' + T('所在位置：{v}', { v: esc(loc) }) + '</span>' : '') +
            '    </div>' +
            '  </div>' +
            '  <div class="drive-cell-size">' + (it.is_dir ? '-' : fmtSize(it.size)) + '</div>' +
            '  <div class="drive-cell-time">' + fmtTime(it.update_time || it.create_time) + '</div>' +
            '  <div class="drive-cell-actions">' +
            '    <button class="drive-act" data-act="share" title="' + T('分享') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg></button>' +
            (it.is_dir ? '' : '    <button class="drive-act" data-act="download" title="' + T('下载') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>') +
            '    <button class="drive-act" data-act="rename" title="' + T('重命名') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>' +
            '    <button class="drive-act drive-act-danger" data-act="delete" title="' + T('删除') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>' +
            '  </div>' +
            '</div>';
    }
    // 重建行（原位重绘不闪屏：仅重建列表行，不动容器；emptyText 空态文案随态切换）
    function rebuildRows(rowsHtml, emptyText) {
        listEl.querySelectorAll('.drive-row').forEach(function (el) { el.remove(); });
        emptyEl.textContent = emptyText;
        emptyEl.classList.toggle('hidden', itemsCache.length > 0);
        if (itemsCache.length > 0) emptyEl.insertAdjacentHTML('beforebegin', rowsHtml);
    }

    function renderList(data) {
        itemsCache = (data && data.items) || [];
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += rowHtml(itemsCache[i], false);
        rebuildRows(rowsHtml, T('暂无文件'));
        bindRowEvents();
        renderBreadcrumb();
        renderUsage(data);
        if (data && data.storage) {
            storageTag.textContent = data.storage === 'minio' ? T('MinIO 存储') : (data.storage === 'local' ? T('本地存储') : '');
            storageTag.classList.remove('hidden');
        }
    }

    // 搜索结果渲染（全盘命中项含所在位置路径；行事件复用 bindRowEvents——目录点击 enterDir
    // 内部退出搜索态，下载/重命名/删除照常，操作后 refreshAfterOp 归口刷新）
    function renderSearchList(items) {
        itemsCache = items || [];
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += rowHtml(itemsCache[i], true);
        rebuildRows(rowsHtml, T('未找到匹配的文件'));
        bindRowEvents();
    }

    function renderUsage(data) {
        if (!data) return;
        var used = data.used_bytes || 0, quota = data.quota_bytes;
        usageEl.classList.remove('hidden');
        if (quota < 0) {
            usageFill.style.width = '0%';
            usageText.textContent = T('已用 {v}（不限容量）', { v: fmtSize(used) });
        } else {
            var pct = quota > 0 ? Math.min(100, Math.round(used * 100 / quota)) : 0;
            usageFill.style.width = pct + '%';
            usageFill.classList.toggle('drive-usage-warn', pct >= 80);
            usageText.textContent = T('已用 {v} / {v2}', { v: fmtSize(used), v2: fmtSize(quota) });
        }
    }

    // ===== 数据加载 =====
    function loadList() {
        apiGet(function (err, data) {
            if (err) { toast(err.message); return; }
            listLoaded = true;
            renderList(data);
        });
    }
    function loadUsage() {
        apiJSON('/api/drive/list?username=' + encodeURIComponent(u()) + '&parent_id=0', null, function (err, data) {
            if (err) return;
            renderUsage(data);
        });
    }

    // ===== 搜索（百度网盘同款：全盘文件名模糊匹配，输入防抖 300ms） =====
    // 清空搜索 UI（不触发列表刷新；刷新由调用方决定——进入目录自身 loadList）
    function clearSearchUI() {
        exitSelectMode(); // 搜索态退出连带退出多选（多选不跨视图保留）
        searchMode = false;
        searchInput.value = '';
        searchClearBtn.classList.add('hidden');
        clearTimeout(searchTimer);
    }
    // doSearch 全盘搜索（seq 序号守卫：仅采纳最新请求结果，防乱序覆盖）
    function doSearch(kw) {
        if (trashMode || shareMode) return; // 回收站/分享页态禁用搜索（搜索框已隐藏，函数口双保险）
        var seq = ++searchSeq;
        apiJSON('/api/drive/search?username=' + encodeURIComponent(u()) + '&keyword=' + encodeURIComponent(kw), null, function (err, data) {
            if (seq !== searchSeq) return;
            if (err) { toast(err.message); return; }
            searchMode = true;
            exitSelectMode(); // 搜索结果重渲染连带退出多选
            renderSearchList((data && data.items) || []);
        });
    }
    // 操作后刷新归口：搜索态重跑搜索（结果实时跟随改名/删除），目录态刷新当前目录
    function refreshAfterOp() {
        if (searchMode && searchInput.value.trim()) { doSearch(searchInput.value.trim()); return; }
        loadList();
    }

    function enterDir(id, name, isBack) {
        exitSelectMode(); // 切换目录退出多选（多选不跨目录保留）
        if (searchMode) clearSearchUI(); // 搜索结果点击目录 → 进入该目录并退出搜索态
        curParent = id;
        if (isBack) {
            // 面包屑回跳：截断到目标层级
            for (var i = 0; i < crumbs.length; i++) {
                if (crumbs[i].id === id) { crumbs = crumbs.slice(0, i + 1); break; }
            }
        } else {
            crumbs.push({ id: id, name: name });
        }
        loadList();
    }

    function bindRowEvents() {
        listEl.querySelectorAll('.drive-row').forEach(function (row) {
            var id = parseInt(row.getAttribute('data-id'), 10);
            var it = null;
            for (var i = 0; i < itemsCache.length; i++) if (itemsCache[i].id === id) { it = itemsCache[i]; break; }
            if (!it) return;
            // 多选模式：整行点击=切换选中（勾选框为纯展示，点击由行归口）；
            // 常规模式：目录整行点击进入，可预览文件整行点击在线预览（动作按钮事件独立冒泡）
            row.addEventListener('click', function (e) {
                if (e.target.closest('.drive-act')) return; // 动作按钮不触发进入
                if (selMode) { toggleSel(it.id, row); return; }
                if (it.is_dir) enterDir(it.id, it.name);
                else if (canPreviewName(it.name)) openDriveViewer(it);
            });
            row.querySelectorAll('.drive-act').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var act = btn.getAttribute('data-act');
                    if (act === 'download') downloadItem(it);
                    else if (act === 'rename') renameItem(it);
                    else if (act === 'delete') deleteItem(it);
                    else if (act === 'share') openShareDialog(it);
                });
            });
        });
    }

    // ===== 操作 =====
    function downloadItem(it, silent) {
        // 下载入队归口（silent=批量下载等无手势场景，跳过保存框直接内存 Blob 方式）
        enqueueDownload(makeTask({ name: it.name, size: it.size || 0, id: it.id, kind: 'down' }), silent);
    }
    // 下载入口归口：File System Access API（Chromium/Edge）可用且单文件点击时，先在用户手势内
    // 弹系统保存框选定位置，入队后流式写盘（边下边写，进度即真实写盘进度）；
    // 不支持/批量/用户取消 → 回退内存 Blob 方式（100% 后触发浏览器落盘，同款体验不变）
    function enqueueDownload(task, silent) {
        if (!silent && window.showSaveFilePicker) {
            window.showSaveFilePicker({ suggestedName: task.name }).then(function (handle) {
                task.handle = handle;
                downQueue.push(task);
                renderTransfers();
                pumpDown();
            }, function () { }); // 用户取消/环境拒绝（无手势等）：静默不下载
            return;
        }
        downQueue.push(task);
        renderTransfers();
        pumpDown();
    }
    function renameItem(it) {
        var tip = it.is_dir ? T('重命名文件夹') : T('重命名文件');
        drivePrompt(tip, T('输入新名称'), it.name, function (val) {
            apiPost('rename', { username: u(), id: it.id, name: val }, function (err) {
                if (err) { toast(TR(err.message)); return; }
                toast(T('重命名成功'));
                refreshAfterOp();
            });
        });
    }
    function deleteItem(it) {
        driveConfirm(it.is_dir ? T('删除文件夹') : T('删除文件'),
            T('确定删除 "{v}" 吗？', { v: it.name }) + (it.is_dir ? T('文件夹内全部内容将一并删除，') : '') + T('删除后可在回收站找回。'),
            function () {
                apiPost('delete', { username: u(), id: it.id }, function (err) {
                    if (err) { toast(TR(err.message)); return; }
                    toast(T('删除成功'));
                    refreshAfterOp();
                    loadUsage();
                });
            });
    }
    function mkdir() {
        if (trashMode || shareMode) return; // 回收站/分享页态禁用（按钮已隐藏，函数口双保险）
        drivePrompt(T('新建文件夹'), T('输入文件夹名称'), '', function (val) {
            apiPost('mkdir', { username: u(), parent_id: curParent, name: val }, function (err) {
                if (err) { toast(TR(err.message)); return; }
                toast(T('创建成功'));
                refreshAfterOp();
            });
        });
    }

    // ===== 批量操作（多选模式：勾选 → 批量下载/删除；操作后退出多选，微信风格） =====
    // 多选行重建（进入/退出多选原位重绘行：勾选框随 selMode 显隐，选中态随 selSet）
    function rerenderRows() {
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += rowHtml(itemsCache[i], searchMode);
        rebuildRows(rowsHtml, searchMode ? T('未找到匹配的文件') : T('暂无文件'));
        bindRowEvents();
    }
    function enterSelectMode() {
        selMode = true;
        selSet = {};
        view.classList.add('selecting');
        selectBtn.classList.add('active');
        batchBar.classList.remove('hidden');
        updateBatchBar();
        rerenderRows();
    }
    function exitSelectMode() {
        if (!selMode) return;
        selMode = false;
        selSet = {};
        view.classList.remove('selecting');
        selectBtn.classList.remove('active');
        batchBar.classList.add('hidden');
        rerenderRows();
    }
    // 行点击切换选中（行与勾选框同步；计数条实时刷新）
    function toggleSel(id, row) {
        var on = !selSet[id];
        if (on) selSet[id] = true; else delete selSet[id];
        row.classList.toggle('selected', on);
        var chk = row.querySelector('.drive-check');
        if (chk) chk.classList.toggle('checked', on);
        updateBatchBar();
    }
    // 批量操作条归口（计数 + 按钮可用态：0 选中时下载/移动/复制/删除置灰）
    function updateBatchBar() {
        var n = 0;
        for (var k in selSet) n++;
        batchCountEl.textContent = T('已选 {n} 项', { n: n });
        batchDownBtn.classList.toggle('disabled', n === 0);
        batchMoveBtn.classList.toggle('disabled', n === 0);
        batchCopyBtn.classList.toggle('disabled', n === 0);
        batchDelBtn.classList.toggle('disabled', n === 0);
    }
    // 全选/取消全选（再点一次取消；目录/文件均可选，目录不可下载仅可删除）
    function toggleSelectAll() {
        var all = itemsCache.length > 0;
        for (var i = 0; i < itemsCache.length; i++) if (!selSet[itemsCache[i].id]) { all = false; break; }
        selSet = {};
        if (!all) for (var j = 0; j < itemsCache.length; j++) selSet[itemsCache[j].id] = true;
        listEl.querySelectorAll('.drive-row').forEach(function (row) {
            var id = parseInt(row.getAttribute('data-id'), 10);
            row.classList.toggle('selected', !!selSet[id]);
            var chk = row.querySelector('.drive-check');
            if (chk) chk.classList.toggle('checked', !!selSet[id]);
        });
        updateBatchBar();
    }
    // 批量下载：选区内文件逐个入队（串行下载泵天然顺序执行），目录跳过
    function batchDownload() {
        var ids = selSet, n = 0;
        for (var i = 0; i < itemsCache.length; i++) {
            var it = itemsCache[i];
            if (!ids[it.id] || it.is_dir) continue;
            downloadItem(it, true); // silent：批量不逐个弹保存框，回退内存 Blob 方式
            n++;
        }
        if (n === 0) { toast(T('所选项目均不支持下载')); return; }
        toast(T('已开始下载 {n} 个文件', { n: n }));
        exitSelectMode();
    }
    // 批量删除：确认弹窗（含目录级联提示）→ delete_batch → 刷新+容量+退出多选
    function batchDelete() {
        var ids = [];
        for (var k in selSet) ids.push(parseInt(k, 10));
        if (!ids.length) return;
        var hasDir = false;
        for (var i = 0; i < itemsCache.length; i++) {
            if (selSet[itemsCache[i].id] && itemsCache[i].is_dir) { hasDir = true; break; }
        }
        driveConfirm(T('批量删除'),
            T('确定删除选中的 {n} 项吗？', { n: ids.length }) + (hasDir ? T('文件夹内全部内容将一并删除，') : '') + T('删除后可在回收站找回。'),
            function () {
                apiPost('delete_batch', { username: u(), ids: ids }, function (err) {
                    if (err) { toast(TR(err.message)); return; }
                    toast(T('已删除 {n} 项', { n: ids.length }));
                    exitSelectMode();
                    refreshAfterOp();
                    loadUsage();
                });
            });
    }

    // ===== 目录选择弹窗（移动/复制到；百度网盘同款：面包屑导航 + 仅目录列表 + 弹窗内新建文件夹） =====
    var pickMask = null;   // 弹窗壳（懒创建复用，样式与主弹窗同源自绘）
    var pickState = null;  // {mode:'move'|'copy', ids:[], cur:当前目录id, crumbs:[{id,name}]}
    function ensurePickModal() {
        if (pickMask) return;
        pickMask = document.createElement('div');
        pickMask.className = 'modal-mask hidden';
        pickMask.innerHTML =
            '<div class="modal-box drive-pick-box">' +
            '  <div class="modal-title" id="drive-pick-title"></div>' +
            '  <div class="drive-pick-crumbs" id="drive-pick-crumbs"></div>' +
            '  <div class="drive-pick-list" id="drive-pick-list"></div>' +
            '  <div class="drive-pick-foot">' +
            '    <button class="drive-tb-btn" id="drive-pick-mkdir">' + T('新建文件夹') + '</button>' +
            '    <span class="drive-pick-flex"></span>' +
            '    <button class="modal-btn" id="drive-pick-cancel">' + T('取消') + '</button>' +
            '    <button class="modal-btn drive-modal-ok" id="drive-pick-ok">' + T('确定') + '</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(pickMask);
        pickMask.addEventListener('click', function (e) { if (e.target === pickMask) closePickModal(); });
        document.getElementById('drive-pick-cancel').addEventListener('click', closePickModal);
        document.getElementById('drive-pick-ok').addEventListener('click', function () {
            if (!pickState) return;
            var mode = pickState.mode, ids = pickState.ids, target = pickState.cur;
            closePickModal();
            doMoveCopy(mode, ids, target);
        });
        document.getElementById('drive-pick-mkdir').addEventListener('click', function () {
            if (!pickState) return;
            drivePrompt(T('新建文件夹'), T('输入文件夹名称'), '', function (val) {
                if (!pickState) return;
                apiPost('mkdir', { username: u(), parent_id: pickState.cur, name: val }, function (err) {
                    if (err) { toast(TR(err.message)); return; }
                    toast(T('创建成功'));
                    pickLoadDir(pickState.cur, pickState.crumbs); // 弹窗内目录列表原位刷新
                });
            });
        });
        if (window._osbInit) window._osbInit(document.getElementById('drive-pick-list')); // 自绘悬浮滑块归口
    }
    function closePickModal() {
        if (!pickMask) return;
        pickMask.classList.add('hidden');
        pickState = null;
    }
    // 打开目录选择弹窗（mode='move'|'copy'；选中集合快照进弹窗，操作期间列表变化不受影响）
    function openPickModal(mode) {
        if (!selMode || trashMode || shareMode) return; // 函数口双保险（回收站/分享页态批量条已隐藏）
        var ids = [];
        for (var k in selSet) ids.push(parseInt(k, 10));
        if (!ids.length) { toast(T('请先选择文件')); return; }
        ensurePickModal();
        pickState = { mode: mode, ids: ids, cur: 0, crumbs: [{ id: 0, name: T('我的文件') }] };
        document.getElementById('drive-pick-title').textContent = mode === 'move' ? T('移动到') : T('复制到');
        pickMask.classList.remove('hidden');
        pickLoadDir(0, pickState.crumbs);
    }
    // 弹窗内目录装载归口（进目录/面包屑回跳/新建后刷新共用；仅列目录，文件不参与选择）
    function pickLoadDir(parentID, crumbs) {
        if (!pickState) return;
        pickState.cur = parentID;
        pickState.crumbs = crumbs;
        var plist = document.getElementById('drive-pick-list');
        var pcrumbs = document.getElementById('drive-pick-crumbs');
        // 面包屑（主列表同款样式：上级可点回跳）
        var html = '';
        for (var i = 0; i < crumbs.length; i++) {
            if (i > 0) html += '<span class="drive-crumb-sep">/</span>';
            if (i === crumbs.length - 1) html += '<span class="drive-crumb-cur">' + esc(crumbs[i].name) + '</span>';
            else html += '<span class="drive-crumb" data-idx="' + i + '">' + esc(crumbs[i].name) + '</span>';
        }
        pcrumbs.innerHTML = html;
        pcrumbs.querySelectorAll('.drive-crumb').forEach(function (el) {
            el.addEventListener('click', function () {
                var idx = parseInt(el.getAttribute('data-idx'), 10);
                pickLoadDir(crumbs[idx].id, crumbs.slice(0, idx + 1));
            });
        });
        plist.innerHTML = '<div class="drive-pick-empty">' + T('加载中...') + '</div>';
        apiJSON('/api/drive/list?username=' + encodeURIComponent(u()) + '&parent_id=' + parentID, null, function (err, data) {
            if (err || !pickState) { if (err && pickState) toast(TR(err.message)); return; }
            var dirs = [];
            var its = (data && data.items) || [];
            for (var i = 0; i < its.length; i++) if (its[i].is_dir) dirs.push(its[i]);
            var rows = '';
            for (var j = 0; j < dirs.length; j++) {
                rows += '<div class="drive-pick-row" data-id="' + dirs[j].id + '" data-name="' + esc(dirs[j].name) + '">' +
                    '<span class="drive-icon k-dir">' + ICONS.dir + '</span>' +
                    '<span class="drive-pick-name" title="' + esc(dirs[j].name) + '">' + esc(dirs[j].name) + '</span>' +
                    '<svg viewBox="0 0 24 24" width="14" height="14" class="drive-pick-arrow"><path fill="currentColor" d="M9.29 6.71a1 1 0 0 0 0 1.41L13.17 12l-3.88 3.88a1 1 0 1 0 1.41 1.41l4.59-4.59a1 1 0 0 0 0-1.41L10.7 6.7a1 1 0 0 0-1.41.01z"/></svg>' +
                    '</div>';
            }
            if (!dirs.length) rows = '<div class="drive-pick-empty">' + T('此文件夹为空') + '</div>';
            plist.innerHTML = rows; // MutationObserver 感知内容重建自绘滑块自刷新
            plist.querySelectorAll('.drive-pick-row').forEach(function (el) {
                el.addEventListener('click', function () {
                    var did = parseInt(el.getAttribute('data-id'), 10);
                    pickLoadDir(did, pickState.crumbs.concat([{ id: did, name: el.getAttribute('data-name') }]));
                });
            });
        });
    }
    // 移动/复制请求归口（目录选择弹窗确定后调用；成功退出多选并原位刷新列表，复制顺带刷容量条）
    function doMoveCopy(mode, ids, targetID) {
        apiPost(mode, { username: u(), ids: ids, target_id: targetID }, function (err, data) {
            if (err) { toast(TR(err.message)); return; }
            var n = (data && (mode === 'move' ? data.moved : data.copied)) || 0;
            toast(mode === 'move' ? T('已移动 {n} 项', { n: n }) : T('已复制 {n} 项', { n: n }));
            exitSelectMode();
            refreshAfterOp();
            if (mode === 'copy') loadUsage();
        });
    }

    // ===== 回收站（网盘二期：删除=移入回收站，可恢复/彻底删除/清空；数据归口服务端） =====
    // 模式互斥：回收站态下多选/搜索/新建/上传/拖拽上传禁用（UI 隐藏 + 函数口双保险）；
    // 行为只保留恢复/彻底删除，行不可进入/预览（对象仍存活，但归口回收站管理语义）
    function enterTrash() {
        clearSearchUI(); // 回收站态连带退出搜索/多选（多选不跨视图保留）
        if (shareMode) resetShareUI(); // v2.21 模式互斥：分享页 → 回收站
        trashMode = true;
        view.classList.add('trash-mode');
        trashEntry.classList.add('active');
        trashBar.classList.remove('hidden');
        // 面包屑切"回收站"当前位置（crumbs 保留原路径，退出回收站经 loadList 原位重建）
        breadcrumbEl.innerHTML = '<span class="drive-crumb-cur">' + T('回收站') + '</span>';
        loadTrash();
    }
    // 纯 UI 复位（不刷新列表，刷新归口由调用方决定：退出回列表 / 重开页面重置）
    function resetTrashUI() {
        trashMode = false;
        view.classList.remove('trash-mode');
        trashEntry.classList.remove('active');
        trashBar.classList.add('hidden');
        colTimeEl.textContent = T('修改时间');
    }
    function exitTrash() {
        if (!trashMode) return;
        resetTrashUI();
        loadList(); // 回当前目录（恢复/删除操作可能已变更数据）
    }
    function loadTrash() {
        apiJSON('/api/drive/trash/list?username=' + encodeURIComponent(u()), null, function (err, data) {
            if (err) { toast(err.message); return; }
            renderTrashList((data && data.items) || []);
        });
    }
    // 回收站行模板（复用 .drive-row 结构：名称+所在位置小字 / 大小 / 删除时间 / 恢复+彻底删除）
    function trashRowHtml(it) {
        var kind = kindOf(it);
        var loc = it.path || T('我的文件');
        return '<div class="drive-row' + (it.is_dir ? ' is-dir' : '') + '" data-id="' + it.id + '">' +
            '  <div class="drive-cell-name">' +
            '    <span class="drive-icon k-' + kind + '">' + ICONS[kind] + '</span>' +
            '    <div class="drive-name-wrap">' +
            '      <span class="drive-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
            '      <span class="drive-row-path" title="' + esc(loc) + '">' + T('所在位置：{v}', { v: esc(loc) }) + '</span>' +
            '    </div>' +
            '  </div>' +
            '  <div class="drive-cell-size">' + (it.is_dir ? '-' : fmtSize(it.size)) + '</div>' +
            '  <div class="drive-cell-time">' + fmtTime(it.deleted_at) + '</div>' +
            '  <div class="drive-cell-actions">' +
            '    <button class="drive-act drive-act-restore" data-act="restore" title="' + T('恢复') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M13 3c-4.97 0-9.01 4.03-9.01 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/></svg></button>' +
            '    <button class="drive-act drive-act-danger" data-act="purge" title="' + T('彻底删除') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>' +
            '  </div>' +
            '</div>';
    }
    function renderTrashList(items) {
        itemsCache = items;
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += trashRowHtml(itemsCache[i]);
        rebuildRows(rowsHtml, T('回收站为空'));
        bindTrashRowEvents();
        colTimeEl.textContent = T('删除时间');
        trashCountEl.textContent = T('共 {n} 项', { n: itemsCache.length });
    }
    // 回收站行事件（仅动作按钮；行本体不可进入/预览）
    function bindTrashRowEvents() {
        listEl.querySelectorAll('.drive-row').forEach(function (row) {
            var id = parseInt(row.getAttribute('data-id'), 10);
            var it = null;
            for (var i = 0; i < itemsCache.length; i++) if (itemsCache[i].id === id) { it = itemsCache[i]; break; }
            if (!it) return;
            row.querySelectorAll('.drive-act').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var act = btn.getAttribute('data-act');
                    if (act === 'restore') restoreItem(it);
                    else if (act === 'purge') purgeItem(it);
                });
            });
        });
    }
    function restoreItem(it) {
        apiPost('trash/restore', { username: u(), ids: [it.id] }, function (err) {
            if (err) { toast(TR(err.message)); return; }
            toast(T('已恢复'));
            loadTrash();
            loadUsage(); // 回收站项不占容量，恢复后重新计入
        });
    }
    function purgeItem(it) {
        driveConfirm(T('彻底删除'),
            T('确定彻底删除 "{v}" 吗？', { v: it.name }) + T('此操作不可恢复。'),
            function () {
                apiPost('trash/delete', { username: u(), ids: [it.id] }, function (err) {
                    if (err) { toast(TR(err.message)); return; }
                    toast(T('已永久删除'));
                    loadTrash();
                });
            });
    }
    function clearTrash() {
        driveConfirm(T('清空回收站'),
            T('确定清空回收站吗？回收站内全部内容将永久删除，') + T('此操作不可恢复。'),
            function () {
                apiPost('trash/clear', { username: u() }, function (err) {
                    if (err) { toast(TR(err.message)); return; }
                    toast(T('回收站已清空'));
                    loadTrash();
                });
            });
    }

    // ===== 传输面板（百度网盘同款：上传/下载双 tab 列表，逐项进度/速度/剩余时间/取消） =====
    var upQueue = [];        // 上传任务
    var downQueue = [];      // 下载任务
    var upRunning = false;
    var downRunning = false;
    var curTTab = 'up';      // 当前展示 tab：'up' | 'down'
    // 任务对象统一字段：kind('up'|'down') name size loaded pct speed state('wait'|'run'|'ok'|'fail') errMsg + xhr/abort
    // 上传扩展：phase('hash'校验|'up'传片) worker(md5 Worker) md5 instant(秒传) onCancel(取消归口)
    function makeTask(o) {
        return {
            kind: o.kind || 'up', name: o.name || '', size: o.size || 0, id: o.id || 0,
            file: o.file || null, loaded: 0, pct: 0, speed: 0,
            state: 'wait', errMsg: '', xhr: null, abort: null, el: null,
            phase: '', worker: null, md5: '', instant: false, onCancel: null
        };
    }
    // 面板显隐 + 双队列渲染 + tab 徽标归口
    function renderTransfers() {
        if (!upQueue.length && !downQueue.length) { uploadsEl.classList.add('hidden'); return; }
        uploadsEl.classList.remove('hidden');
        renderQueue(upQueue, uploadItemsEl);
        renderQueue(downQueue, downItemsEl);
        // tab 徽标：进行中（wait+run）数量，无进行中隐藏
        var upN = 0, downN = 0, i;
        for (i = 0; i < upQueue.length; i++) if (upQueue[i].state === 'wait' || upQueue[i].state === 'run') upN++;
        for (i = 0; i < downQueue.length; i++) if (downQueue[i].state === 'wait' || downQueue[i].state === 'run') downN++;
        tabUpEl.textContent = upN; tabUpEl.classList.toggle('hidden', !upN);
        tabDownEl.textContent = downN; tabDownEl.classList.toggle('hidden', !downN);
    }
    // 原位重绘：仅追加新任务行（已有行不动，避免进度条闪烁）
    function renderQueue(queue, container) {
        for (var i = 0; i < queue.length; i++) {
            var t = queue[i];
            if (t.el) continue;
            var row = document.createElement('div');
            row.className = 'drive-up-item';
            row.innerHTML =
                '<div class="drive-up-top">' +
                '  <span class="drive-up-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
                '  <button class="drive-up-cancel" title="' + T('取消') + '" hidden><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
                '</div>' +
                '<div class="drive-up-bar"><div class="drive-up-fill"></div></div>' +
                '<div class="drive-up-meta">' +
                '  <span class="drive-up-status"></span>' +
                '  <span class="drive-up-extra"></span>' +
                '</div>';
            t.el = row;
            t.fillEl = row.querySelector('.drive-up-fill');
            t.stateEl = row.querySelector('.drive-up-status');
            t.extraEl = row.querySelector('.drive-up-extra');
            t.cancelEl = row.querySelector('.drive-up-cancel');
            // 取消：传输中点 × 中止（上传经 onCancel 归口：校验阶段 terminate Worker / 传片阶段
            // abort XHR，取消按失败留痕"已取消"；服务端会话保留，下次同文件自动断点续传）
            t.cancelEl.addEventListener('click', function (tt) {
                return function () {
                    if (tt.state !== 'run') return;
                    if (tt.onCancel) { tt.onCancel(); return; }
                    if (tt.abort) tt.abort.abort();
                    if (tt.xhr) tt.xhr.abort();
                };
            }(t));
            container.appendChild(row);
            updateTaskUI(t); // 行创建即填充初始状态（等待上传/下载 + 大小），避免 wait 任务文案空白
        }
    }
    // 任务行 UI 归口（进度条宽度/状态文案/速度与剩余时间/取消按钮显隐）
    function updateTaskUI(t) {
        if (!t.el) return;
        t.el.classList.toggle('is-ok', t.state === 'ok');
        t.el.classList.toggle('is-fail', t.state === 'fail');
        t.fillEl.style.width = t.pct + '%';
        t.cancelEl.hidden = t.state !== 'run';
        var up = t.kind === 'up';
        var sizeText = fmtSize(t.loaded) + ' / ' + (t.size ? fmtSize(t.size) : T('未知大小'));
        if (t.state === 'wait') {
            t.stateEl.textContent = T(up ? '等待上传' : '等待下载');
            t.extraEl.textContent = t.size ? fmtSize(t.size) : '';
        } else if (t.state === 'run') {
            if (t.phase === 'hash') { // 大文件链路阶段一：本地 MD5 校验
                t.stateEl.textContent = T('校验中 {v}', { v: t.pct + '%' });
                t.extraEl.textContent = t.size ? (fmtSize(t.loaded) + ' / ' + fmtSize(t.size)) : '';
            } else {
                t.stateEl.textContent = T(up ? '上传中 {v}' : '下载中 {v}', { v: t.size ? t.pct + '%' : sizeText });
                var remain = t.speed > 0 && t.size ? (t.size - t.loaded) / t.speed : Infinity;
                var extras = [];
                if (t.size) extras.push(sizeText);
                var sp = fmtSpeed(t.speed);
                if (sp) extras.push(sp);
                var rm = fmtRemain(remain);
                if (rm) extras.push(rm);
                t.extraEl.textContent = extras.join(' · ');
            }
        } else if (t.state === 'ok') {
            t.stateEl.textContent = T(t.instant ? '秒传成功' : (up ? '上传完成' : '下载完成'));
            t.extraEl.textContent = t.size ? fmtSize(t.size) : '';
        } else {
            t.stateEl.textContent = T(up ? '上传失败：{v}' : '下载失败：{v}', { v: t.errMsg ? TR(t.errMsg) : T('未知错误') });
            t.extraEl.textContent = '';
        }
    }
    // 上传泵（串行）
    function pump() {
        if (upRunning) return;
        var next = null;
        for (var i = 0; i < upQueue.length; i++) if (upQueue[i].state === 'wait') { next = upQueue[i]; break; }
        if (!next) { upRunning = false; return; }
        upRunning = true;
        uploadOne(next, function () { upRunning = false; pump(); });
    }
    // 下载泵（串行：控制内存峰值，Blob 组装一次只跑一个）
    function pumpDown() {
        if (downRunning) return;
        var next = null;
        for (var i = 0; i < downQueue.length; i++) if (downQueue[i].state === 'wait') { next = downQueue[i]; break; }
        if (!next) { downRunning = false; return; }
        downRunning = true;
        downloadOne(next, function () { downRunning = false; pumpDown(); });
    }
    // 速度采样：150ms 最小窗口防抖 + EMA 平滑（inst = 窗口字节增量/秒）
    function makeSampler() {
        var lastT = 0, lastLoaded = 0, ema = 0;
        return function (loaded) {
            var now = Date.now();
            if (!lastT) { lastT = now; lastLoaded = loaded; return 0; }
            var dt = (now - lastT) / 1000;
            if (dt < 0.15) return ema;
            var inst = (loaded - lastLoaded) / dt;
            ema = ema ? ema * 0.6 + inst * 0.4 : inst;
            lastT = now; lastLoaded = loaded;
            return ema;
        };
    }
    // ===== 大文件链路（网盘二期）：本地 MD5 → init（秒传判定/断点续传）→ 逐片上传 → complete 合并 =====
    // MD5 在 Web Worker 分块计算（Worker 内 FileReaderSync 读块，主线程零卡顿），Worker 不可用
    // 自动回退主线程分块（setTimeout 让出事件循环）。秒传命中零传输直接完成；断点续传跳过服务端
    // 已收分片；取消仅中断传输、保留服务端会话（下次同文件自动续传），孤儿会话由服务端 72h TTL 清理
    // Worker 实现注意（实测教训）：blob Worker 内 importScripts 相对路径解析报 invalid URL，故经
    // fetch 把 md5.js 源码内联进 Worker blob；主线程 FileReader.readAsArrayBuffer 在部分环境缺失，
    // 统一优先 Blob.arrayBuffer() 读取；首消息 5s 无响应兜底回退主线程（Worker 静默失败场景）
    var MD5_WORKER_LOGIC =
        "self.onmessage = function (e) {" +
        "  var f = e.data.file, chunk = e.data.chunk;" +
        "  var md = MD5Stream.create(), off = 0;" +
        "  var sync = (typeof FileReaderSync !== 'undefined') ? new FileReaderSync() : null;" +
        "  var step = function () {" +
        "    if (off >= f.size) { self.postMessage({ hex: md.hex() }); return; }" +
        "    var end = Math.min(off + chunk, f.size);" +
        "    var fin = function (buf) { md.update(new Uint8Array(buf)); off = end; self.postMessage({ progress: off }); step(); };" +
        "    if (sync) { fin(sync.readAsArrayBuffer(f.slice(off, end))); }" +
        "    else { f.slice(off, end).arrayBuffer().then(fin, function () { self.postMessage({ error: 'read' }); }); }" +
        "  };" +
        "  step();" +
        "};";

    // md5.js 源码缓存：undefined=未拉取 ''=拉取失败（后续全走主线程回退）
    var md5Src;

    // 本地分块 MD5 计算（进度按已校验字节回报；返回 Worker 供取消 terminate，回退路径返回 null）
    function computeMD5(file, onProgress, cb) {
        if (md5Src === undefined) {
            fetch(location.origin + '/js/md5.js').then(function (r) {
                return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status));
            }).then(function (src) {
                md5Src = src;
                startWorkerMD5(file, onProgress, cb);
            }, function () {
                md5Src = '';
                mainThreadMD5(file, onProgress, cb);
            });
            return null;
        }
        if (md5Src === '') { mainThreadMD5(file, onProgress, cb); return null; }
        return startWorkerMD5(file, onProgress, cb);
    }
    // Worker 启动归口（md5.js 源码已就绪）：错误/静默均自动回退主线程，回调恰好一次由 finished 守卫
    function startWorkerMD5(file, onProgress, cb) {
        try {
            var w = new Worker(URL.createObjectURL(new Blob([md5Src + '\n' + MD5_WORKER_LOGIC], { type: 'text/javascript' })));
            var fell = false; // 已回退主线程标记（丢弃 Worker 残余消息，防双回调）
            var guard = setTimeout(function () { // 首消息 5s 无响应兜底
                if (fell) return;
                fell = true;
                w.terminate();
                mainThreadMD5(file, onProgress, cb);
            }, 5000);
            w.onerror = function () {
                if (fell) return;
                fell = true;
                clearTimeout(guard);
                w.terminate();
                mainThreadMD5(file, onProgress, cb);
            };
            w.onmessage = function (e) {
                if (fell) return;
                clearTimeout(guard); // 任意消息到达即证明 Worker 存活
                var d = e.data;
                if (d.error) { w.terminate(); cb(null, 'read'); return; }
                if (d.progress !== undefined) { onProgress(d.progress); return; }
                if (d.hex) { w.terminate(); cb(d.hex); }
            };
            w.postMessage({ file: file, chunk: 4 << 20 });
            return w;
        } catch (e) {
            mainThreadMD5(file, onProgress, cb);
            return null;
        }
    }
    // 读块归口：优先 Blob.arrayBuffer()（Promise 化），缺失时回退 FileReader.readAsArrayBuffer
    function readBuf(blob) {
        if (blob.arrayBuffer) return blob.arrayBuffer();
        return new Promise(function (res, rej) {
            try {
                var fr = new FileReader();
                fr.onload = function () { res(fr.result); };
                fr.onerror = function () { rej(new Error('read')); };
                fr.readAsArrayBuffer(blob);
            } catch (e) { rej(e); }
        });
    }
    // 主线程回退：分块读取 + setTimeout 让出事件循环（防大文件卡 UI）
    function mainThreadMD5(file, onProgress, cb) {
        if (!window.MD5Stream) { cb(null, 'no-md5'); return; }
        var md = MD5Stream.create(), off = 0, chunk = 4 << 20;
        (function step() {
            if (off >= file.size) { cb(md.hex()); return; }
            var end = Math.min(off + chunk, file.size);
            readBuf(file.slice(off, end)).then(function (buf) {
                md.update(new Uint8Array(buf));
                off = end;
                onProgress(off);
                setTimeout(step, 0);
            }, function () { cb(null, 'read'); });
        })();
    }

    function uploadOne(t, done) {
        t.state = 'run';
        t.phase = 'hash';
        updateTaskUI(t);
        var finished = false;
        // 终态归口：done 恰好调用一次（Worker/XHR/回调竞态统一在此收口），失败路径兜底回收 Worker
        function finish() {
            if (finished) return;
            finished = true;
            if (t.worker) { t.worker.terminate(); t.worker = null; }
            t.xhr = null;
            t.onCancel = null;
            updateTaskUI(t);
            renderTransfers();
            done();
        }
        function fail(msg) { t.state = 'fail'; t.errMsg = msg; finish(); }
        // 取消归口：校验阶段直接终态（Worker 由 finish 回收）；传片阶段 abort XHR（onabort 走 fail）
        t.onCancel = function () {
            if (finished) return;
            if (t.xhr) { t.xhr.abort(); return; }
            fail('已取消');
        };
        var sample = makeSampler();
        function setProgress(loaded) {
            t.loaded = Math.min(loaded, t.size);
            t.pct = t.size ? Math.round(t.loaded * 100 / t.size) : 100;
            t.speed = sample(t.loaded);
            updateTaskUI(t);
        }
        // 阶段一：本地分块 MD5（秒传判定与服务端 complete 复核共用指纹）
        t.worker = computeMD5(t.file, function (loaded) { if (!finished) setProgress(loaded); }, function (hex, err) {
            if (finished) return;
            if (err || !hex) { fail('文件校验失败'); return; }
            t.md5 = hex;
            t.phase = 'up';
            t.loaded = 0;
            updateTaskUI(t);
            // 阶段二：init——服务端秒传判定/断点会话复用（chunk_size 服务端下发，客户端零猜测）
            apiPost('upload/init?username=' + encodeURIComponent(u()), {
                name: t.file.name, size: t.file.size, md5: hex, parent_id: curParent
            }, function (err2, data) {
                if (finished) return;
                if (err2) { fail(err2.message); return; }
                if (data.instant) { // 秒传命中：零字节传输直接完成
                    t.state = 'ok';
                    t.instant = true;
                    t.pct = 100;
                    t.loaded = t.size;
                    // 黑名单隔离改名提示（服务端以 .im 名落库时随响应附带 message）
                    if (data.renamed && data.message) {
                        toast(T('为安全考虑，已自动改名为 {v} 保存', { v: (data.item && data.item.name) || t.file.name }));
                    }
                    finish();
                    refreshAfterOp();
                    loadUsage();
                    return;
                }
                sendChunks(t, data, finish, fail, setProgress);
            });
        });
        updateTaskUI(t);
    }
    // 阶段三/四：逐片串行上传（raw blob 直发省内存）+ complete 合并；跳过服务端已收分片（断点续传）
    function sendChunks(t, info, finish, fail, setProgress) {
        var skip = {}, i;
        for (i = 0; i < info.uploaded.length; i++) skip[info.uploaded[i]] = true;
        var idx = 0;
        function nextChunk() {
            while (idx < info.chunk_total && skip[idx]) idx++;
            if (idx >= info.chunk_total) { doComplete(); return; }
            var cur = idx++;
            var start = cur * info.chunk_size;
            var blob = t.file.slice(start, Math.min(start + info.chunk_size, t.file.size));
            var xhr = new XMLHttpRequest();
            t.xhr = xhr;
            xhr.open('POST', '/api/drive/upload/chunk?username=' + encodeURIComponent(u()) +
                '&session_id=' + encodeURIComponent(info.session_id) + '&index=' + cur);
            xhr.upload.onprogress = function (e) { setProgress(start + e.loaded); };
            xhr.onload = function () {
                t.xhr = null;
                if (xhr.status >= 200 && xhr.status < 300) { nextChunk(); return; }
                var msg = null;
                try { msg = JSON.parse(xhr.responseText).error; } catch (e) { /* 纯文本错误兜底 */ }
                fail(msg || ('HTTP ' + xhr.status));
            };
            xhr.onerror = function () { t.xhr = null; fail('网络异常'); };
            xhr.onabort = function () { t.xhr = null; fail('已取消'); };
            xhr.send(blob);
        }
        function doComplete() {
            setProgress(t.size);
            apiPost('upload/complete?username=' + encodeURIComponent(u()), {
                session_id: info.session_id, name: t.file.name, parent_id: curParent
            }, function (err, data) {
                if (err) { fail(err.message); return; }
                t.state = 'ok';
                t.pct = 100;
                t.loaded = t.size;
                // 黑名单隔离改名提示（服务端以 .im 名落库时随响应附带 message）
                if (data && data.renamed && data.message) {
                    toast(T('为安全考虑，已自动改名为 {v} 保存', { v: (data.item && data.item.name) || t.file.name }));
                }
                finish();
                refreshAfterOp();
                loadUsage();
            });
        }
        nextChunk();
    }
    function downloadOne(t, done) {
        t.state = 'run';
        updateTaskUI(t);
        var ctrl = new AbortController();
        t.abort = ctrl;
        var sample = makeSampler();
        // 下载地址归口：默认本人网盘下载；分享详情下载经 t.url（share/download，凭分享码+提取码）
        var url = t.url || ('/api/drive/download?username=' + encodeURIComponent(u()) + '&id=' + t.id);
        function fail(err) {
            if (err && err.name === 'AbortError') { t.state = 'fail'; t.errMsg = T('已取消'); }
            else { t.state = 'fail'; t.errMsg = (err && err.message) || T('网络异常'); }
            updateTaskUI(t);
            renderTransfers();
        }
        // File System Access API 分支（保存框已在前置弹窗选定位置）：流式写盘，边下边写真实进度；
        // 中断/失败 abort 清理临时文件不留半文件。进度即写盘进度，完成即文件就绪（无 100% 后才弹框）
        if (t.handle) {
            var wref = null;
            fetch(url, { signal: ctrl.signal }).then(function (res) {
                if (!res.ok) {
                    return res.json().catch(function () { return {}; }).then(function (d) {
                        throw new Error(d.error || ('HTTP ' + res.status));
                    });
                }
                var total = parseInt(res.headers.get('content-length'), 10) || t.size || 0;
                function tick(loaded) {
                    t.loaded = loaded;
                    if (total) t.pct = Math.min(100, Math.round(loaded * 100 / total));
                    t.speed = sample(loaded);
                    updateTaskUI(t);
                }
                return t.handle.createWritable().then(function (w) {
                    wref = w;
                    // res.body 极端环境缺失兜底：整体 blob 一次写入（无逐块进度）
                    if (!res.body) {
                        return res.blob().then(function (b) { t.size = b.size; return w.write(b); }).then(function () {
                            return w.close().then(function () {
                                t.state = 'ok'; t.pct = 100; t.loaded = t.size;
                                updateTaskUI(t);
                                renderTransfers();
                            });
                        });
                    }
                    var reader = res.body.getReader();
                    var received = 0;
                    function pump() {
                        return reader.read().then(function (r) {
                            if (r.done) {
                                return w.close().then(function () {
                                    t.state = 'ok'; t.pct = 100; t.loaded = total || received;
                                    updateTaskUI(t);
                                    renderTransfers();
                                });
                            }
                            received += r.value.length;
                            tick(received);
                            return w.write(r.value).then(pump);
                        });
                    }
                    return pump();
                });
            }).catch(function (err) {
                if (wref) { try { wref.abort(); } catch (e) { } } // 删除半写临时文件
                fail(err);
            }).then(function () { done(); }, function () { done(); });
            return;
        }
        // 回退分支：内存 Blob 方式（批量下载/旧浏览器；fetch 全量后 a.click() 落盘）
        fetch(url, { signal: ctrl.signal })
            .then(function (res) {
                if (!res.ok) {
                    // 服务端错误归口：解析 error 文本直显（404/401/配额等）
                    return res.json().catch(function () { return {}; }).then(function (d) {
                        throw new Error(d.error || ('HTTP ' + res.status));
                    });
                }
                // 总大小归口：Content-Length 优先（MinIO 跨域已实测暴露；本地后端同源必有），列表元数据兜底
                var total = parseInt(res.headers.get('content-length'), 10) || t.size || 0;
                var chunks = [], received = 0;
                var finish = function () {
                    // Blob 落盘（默认下载目录，无对话框）；ObjectURL 延时释放
                    var blob = new Blob(chunks, { type: 'application/octet-stream' });
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url;
                    a.download = t.name;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
                    chunks = null;
                    t.state = 'ok'; t.pct = 100; t.loaded = total;
                    updateTaskUI(t);
                    renderTransfers();
                };
                // res.body 不可用兜底（极端环境）：整体 blob 一次落盘，无进度
                if (!res.body) {
                    return res.blob().then(function (b) {
                        t.size = b.size;
                        var fake = { chunks: [b] };
                        chunks = fake.chunks;
                        finish();
                    });
                }
                var reader = res.body.getReader();
                function tick(loaded) {
                    t.loaded = loaded;
                    if (total) t.pct = Math.min(100, Math.round(loaded * 100 / total));
                    t.speed = sample(loaded);
                    updateTaskUI(t);
                }
                function pump() {
                    return reader.read().then(function (r) {
                        if (r.done) { finish(); return; }
                        chunks.push(r.value);
                        received += r.value.length;
                        tick(received);
                        return pump();
                    });
                }
                return pump();
            })
            .catch(fail)
            .then(function () { done(); }, function () { done(); });
    }

    // ===== 网盘内在线预览（分享页同款：preview=1 服务端 inline 下发，页面内自绘浮层渲染） =====
    // 浏览器原生可渲染的类型归口（avi/mkv/mov/flv/wmv 原生 <video> 不支持，不进入预览照常走下载）
    // Office 文档（docx/表格/pptx）归口 OfficePreview 共享渲染（聊天工作台同款三库，office-preview.js）
    function canPreviewName(name) {
        var ext = ((name || '').split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) >= 0) return 'img';
        if (['mp4', 'webm'].indexOf(ext) >= 0) return 'video';
        if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].indexOf(ext) >= 0) return 'audio';
        if (ext === 'pdf') return 'pdf';
        if (['txt', 'md', 'log', 'json'].indexOf(ext) >= 0) return 'txt';
        if (window.OfficePreview && OfficePreview.kindOf(name)) return 'office';
        return '';
    }
    // 文件下发 URL 归口（预览加 preview=1 → 服务端 Content-Disposition:inline；下载与预览共用鉴权）
    function driveFileUrl(it, preview) {
        return '/api/drive/download?username=' + encodeURIComponent(u()) + '&id=' + it.id + (preview ? '&preview=1' : '');
    }
    // 预览浮层（懒建一次；z-index 2000 与 modal-mask 同层，盖过网盘视图与传输面板 1650）
    var pvMask = null, pvTitle = null, pvBody = null;
    function ensureViewer() {
        if (pvMask) return;
        pvMask = document.createElement('div');
        pvMask.className = 'drive-viewer-mask hidden';
        pvMask.innerHTML =
            '<div class="drive-viewer-box">' +
            '  <div class="drive-viewer-head">' +
            '    <div class="drive-viewer-title"></div>' +
            '    <button class="drive-viewer-close" title="' + T('关闭') + '"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
            '  </div>' +
            '  <div class="drive-viewer-body"></div>' +
            '</div>';
        document.body.appendChild(pvMask);
        pvTitle = pvMask.querySelector('.drive-viewer-title');
        pvBody = pvMask.querySelector('.drive-viewer-body');
        pvMask.querySelector('.drive-viewer-close').addEventListener('click', closeViewer);
        pvMask.addEventListener('click', function (e) { if (e.target === pvMask) closeViewer(); });
    }
    function closeViewer() {
        if (!pvMask) return;
        pvMask.classList.add('hidden');
        pvBody.innerHTML = ''; // 清空内容区：视频/音频随之停止播放
    }
    function openDriveViewer(it) {
        ensureViewer();
        var name = it.name || '';
        var kind = canPreviewName(name);
        var url = driveFileUrl(it, true);
        pvTitle.textContent = name + ' · ' + T('在线预览');
        pvBody.innerHTML = '<div class="drive-viewer-loading">' + T('正在加载预览…') + '</div>';
        pvMask.classList.remove('hidden');
        if (kind === 'office') {
            // Office 文档（docx/xls/xlsx/csv/pptx）：归口 OfficePreview 共享渲染（缺库自动懒加载）
            OfficePreview.render(url, name, pvBody, T);
        } else if (kind === 'img' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
            // 原生标签内联渲染（img 自适应缩放 / pdf iframe 内建阅读器 / 视频/音频原生控件自动播放）
            pvBody.innerHTML = '';
            var tag = document.createElement(kind === 'img' ? 'img' : (kind === 'pdf' ? 'iframe' : kind));
            if (kind === 'img') tag.alt = name;
            if (kind === 'video' || kind === 'audio') { tag.controls = true; tag.autoplay = true; }
            tag.src = url;
            pvBody.appendChild(tag);
        } else {
            // 文本类：拉取后 <pre> 直显（2MB 截断提示，textContent 防 XSS；迟到响应丢弃防旧内容覆盖新开预览）
            fetch(url).then(function (res) {
                if (!res.ok) throw new Error(T('预览加载失败({n})', { n: res.status }));
                return res.text();
            }, function () { throw new Error(T('网络异常，请稍后重试')); }).then(function (text) {
                if (pvMask.classList.contains('hidden')) return;
                if (text.length > 2 * 1024 * 1024) text = text.slice(0, 2 * 1024 * 1024) + '\n\n…' + T('内容过大，仅预览前 2MB，请下载查看全文');
                pvBody.innerHTML = '';
                var pre = document.createElement('pre');
                pre.textContent = text;
                pvBody.appendChild(pre);
                if (window._osbInit) window._osbInit(pre); // 文本滚动区自绘悬浮滑块（禁系统滚动条归口）
            }, function (err) {
                if (pvMask.classList.contains('hidden')) return;
                pvBody.innerHTML = '<div class="drive-viewer-loading"></div>';
                pvBody.firstChild.textContent = err.message || T('预览加载失败');
            });
        }
    }

    // ===== 分享模块（二期：发给好友/群卡片 + 生成站内链接；状态归口服务端，客户端零计算） =====
    var dsCurItem = null;   // 分享弹窗当前条目
    var dsSelUsers = {};    // 已勾选好友 username -> true
    var dsSelGroups = {};   // 已勾选群 'g'+id -> true
    var dsExpireDays = 0;   // 链接有效期档位（0永久/1/7/30）
    var dsCurCode = '';     // 详情弹窗当前分享码
    var dsdInfo = null;     // 详情弹窗当前分享信息（服务端 info 归口返回）

    function dsIconCls(it) { return 'ds-file-icon drive-icon k-' + kindOf(it); }
    function dsExpireText(ts) {
        if (!ts) return T('永久有效');
        var d = new Date(ts * 1000);
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return T('有效期至 {d}', { d: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) });
    }
    // 网盘弹层互斥显隐归口（分享弹窗/分享详情；mask 点击与 Esc 统一走此收口）
    function closeDsMasks() {
        if (dsMask) dsMask.classList.add('hidden');
        if (dsdMask) dsdMask.classList.add('hidden');
    }
    function anyDsMaskOpen() {
        return (dsMask && !dsMask.classList.contains('hidden')) ||
            (dsdMask && !dsdMask.classList.contains('hidden'));
    }
    // 复制归口（clipboard API 失败回退 execCommand，Electron/HTTP 环境均可用）
    function dsCopyText(text, okTip) {
        var done = function () { toast(okTip || T('已复制')); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { dsCopyFallback(text, done); });
        } else {
            dsCopyFallback(text, done);
        }
    }
    function dsCopyFallback(text, done) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast(T('复制失败，请手动复制')); }
        ta.remove();
    }

    // ---- 分享弹窗（双 tab） ----
    function openShareDialog(it) {
        if (!dsMask) return;
        closeDsMasks();
        dsCurItem = it;
        dsSelUsers = {};
        dsSelGroups = {};
        dsExpireDays = 0;
        dsFileIcon.innerHTML = ICONS[kindOf(it)];
        dsFileIcon.className = dsIconCls(it);
        dsFileName.textContent = it.name;
        dsFileMeta.textContent = (it.is_dir ? T('文件夹') : fmtSize(it.size));
        dsContactSearch.value = '';
        dsLinkResult.classList.add('hidden');
        dsGenBtn.disabled = false;
        dsExpireGroup.querySelectorAll('.ds-expire').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-days') === '0');
        });
        dsWithCode.checked = false;
        dsShowTab('chat');
        dsRenderContacts();
        dsMask.classList.remove('hidden');
    }
    function dsShowTab(tab) {
        dsTabChat.classList.toggle('active', tab === 'chat');
        dsTabLink.classList.toggle('active', tab === 'link');
        dsPaneChat.classList.toggle('hidden', tab !== 'chat');
        dsPaneLink.classList.toggle('hidden', tab !== 'link');
    }
    // 联系人候选渲染（群聊/好友分区；数据源 chat.js 暴露的 IMContacts 只读归口，双源一致）
    function dsRenderContacts() {
        var kw = (dsContactSearch.value || '').trim().toLowerCase();
        dsContactList.innerHTML = '';
        var added = 0;
        var groups = window.IMContacts ? window.IMContacts.groups() : {};
        var gids = [];
        for (var gid in groups) gids.push(gid);
        gids.sort(function (a, b) {
            return String(groups[a].name || '').localeCompare(String(groups[b].name || ''), 'zh');
        });
        var sec = null;
        gids.forEach(function (gid) {
            var g = groups[gid] || {};
            var disp = g.name || (T('群聊') + gid);
            if (kw && disp.toLowerCase().indexOf(kw) < 0) return;
            if (!sec) { sec = dsSecTitle(T('群聊')); }
            dsContactList.appendChild(dsContactRow({
                type: 'g', key: 'g' + gid, disp: disp, avatar: g.avatar || '', count: g.member_count || 0
            }));
            added++;
        });
        sec = null;
        var friends = (window.IMContacts ? window.IMContacts.friends() : []) || [];
        var fs = [];
        friends.forEach(function (f) {
            var disp = (f.remark || '').trim() || f.username || '';
            if (kw && disp.toLowerCase().indexOf(kw) < 0 && String(f.username || '').toLowerCase().indexOf(kw) < 0) return;
            fs.push({ u: f.username, disp: disp, avatar: f.avatar || '', online: !!f.online });
        });
        fs.sort(function (a, b) { return a.disp.localeCompare(b.disp, 'zh'); });
        fs.forEach(function (f) {
            if (!sec) { sec = dsSecTitle(T('好友')); }
            dsContactList.appendChild(dsContactRow({ type: 'u', key: f.u, disp: f.disp, avatar: f.avatar }));
            added++;
        });
        if (!added) {
            dsContactList.innerHTML = '<div class="ds-contact-empty">' +
                (kw ? T('无匹配联系人') : T('暂无可分享的好友或群聊')) + '</div>';
        }
        dsUpdatePickCount();
    }
    function dsSecTitle(text) {
        var el = document.createElement('div');
        el.className = 'ds-sec-title';
        el.textContent = text;
        return el;
    }
    function dsContactRow(opt) {
        var picked = opt.type === 'g' ? !!dsSelGroups[opt.key] : !!dsSelUsers[opt.key];
        var el = document.createElement('div');
        el.className = 'grp-item' + (picked ? ' picked' : '');
        var chk = document.createElement('span');
        chk.className = 'grp-check';
        chk.textContent = '✓';
        el.appendChild(chk);
        if (opt.avatar) {
            var av = document.createElement('img');
            av.className = 'fwd-avatar';
            av.src = opt.avatar;
            el.appendChild(av);
        } else {
            var ph = document.createElement('span');
            ph.className = 'fwd-avatar-ph';
            ph.textContent = (opt.disp || '?').charAt(0).toUpperCase();
            el.appendChild(ph);
        }
        var nm = document.createElement('div');
        nm.className = 'fwd-name';
        nm.textContent = opt.disp;
        el.appendChild(nm);
        if (opt.type === 'g' && opt.count) {
            var ct = document.createElement('span');
            ct.className = 'ds-contact-count';
            ct.textContent = T('{v}人', { v: opt.count });
            el.appendChild(ct);
        }
        el.addEventListener('click', function () {
            var nowPicked;
            if (opt.type === 'g') {
                nowPicked = !dsSelGroups[opt.key];
                if (nowPicked) dsSelGroups[opt.key] = true; else delete dsSelGroups[opt.key];
            } else {
                nowPicked = !dsSelUsers[opt.key];
                if (nowPicked) dsSelUsers[opt.key] = true; else delete dsSelUsers[opt.key];
            }
            el.classList.toggle('picked', nowPicked);
            dsUpdatePickCount();
        });
        return el;
    }
    function dsUpdatePickCount() {
        var n = Object.keys(dsSelUsers).length + Object.keys(dsSelGroups).length;
        dsPickCount.textContent = n ? T('已选择 {n} 位联系人', { n: n }) : '';
        dsSendBtn.disabled = n === 0;
    }
    function dsSendToContacts() {
        if (!dsCurItem) return;
        dsSendBtn.disabled = true;
        apiPost('share/create', {
            username: u(), file_id: dsCurItem.id, expire_days: 0, with_code: false,
            to_users: Object.keys(dsSelUsers), to_groups: Object.keys(dsSelGroups)
        }, function (err, data) {
            dsSendBtn.disabled = false;
            if (err) { toast(TR(err.message)); return; }
            closeDsMasks();
            toast(T('已分享给 {n} 位联系人', { n: data.delivered || 0 }));
        });
    }
    function dsGenLink() {
        if (!dsCurItem) return;
        dsGenBtn.disabled = true;
        apiPost('share/create', {
            username: u(), file_id: dsCurItem.id, expire_days: dsExpireDays,
            with_code: dsWithCode.checked, to_users: [], to_groups: []
        }, function (err, data) {
            dsGenBtn.disabled = false;
            if (err) { toast(TR(err.message)); return; }
            dsLinkText.textContent = location.origin + (data.url || ('/s/' + (data.share && data.share.code)));
            var code = data.extract_code; // 服务端顶层回传（仅创建响应一次性可见，share 结构不含）
            dsLinkCode.textContent = code || '';
            dsCodeRow.classList.toggle('hidden', !code);
            dsLinkResult.classList.remove('hidden');
            toast(T('链接已创建'));
        });
    }

    // ---- 分享管理（我发出的） ----
    // ---- 分享管理（v2.21 页面化：入口上移左侧列表，列表在网盘页面内显示，不再弹窗） ----
    // 模式互斥同回收站：shareMode 下多选/搜索/新建/上传禁用（UI 隐藏 + 函数口双保险）；
    // 行为仅取消分享（取消后链接与卡片立即失效，服务端归口）
    function enterShare() {
        clearSearchUI(); // 分享页态连带退出搜索/多选
        if (trashMode) resetTrashUI(); // 模式互斥：回收站 → 分享页
        shareMode = true;
        view.classList.add('share-mode');
        shareEntry.classList.add('active');
        shareBar.classList.remove('hidden');
        breadcrumbEl.innerHTML = '<span class="drive-crumb-cur">' + T('分享管理') + '</span>';
        loadShareList();
    }
    // 纯 UI 复位（不刷新列表，刷新归口由调用方决定）
    function resetShareUI() {
        shareMode = false;
        view.classList.remove('share-mode');
        shareEntry.classList.remove('active');
        shareBar.classList.add('hidden');
        colTimeEl.textContent = T('修改时间');
    }
    function exitShare() {
        if (!shareMode) return;
        resetShareUI();
        loadList(); // 回当前目录
    }
    function loadShareList() {
        apiJSON('/api/drive/share/list?username=' + encodeURIComponent(u()), null, function (err, data) {
            if (err) { toast(TR(err.message)); return; }
            renderSharePage((data && data.items) || []);
        });
    }
    // 分享行模板（复用 .drive-row 四列结构对齐回收站行：名称+统计小字 / 大小 / 到期时间 / 取消分享）
    function shareRowHtml(sh) {
        var kind = kindOf(sh);
        var ok = sh.status === 'valid';
        var metaBits = [(sh.is_dir ? T('文件夹') : fmtSize(sh.size)), dsExpireText(sh.expire_at)];
        if (sh.has_extract) metaBits.push(T('提取码'));
        // 分享统计（服务端归口计数：浏览/下载/保存，词条与弹窗版共用）
        metaBits.push(T('{n} 次浏览', { n: sh.view_count || 0 }) + ' · ' + T('{n} 次下载', { n: sh.download_count || 0 }) + ' · ' + T('{n} 次保存', { n: sh.save_count || 0 }));
        var status = ok ? T('分享中') : (TR(sh.valid_msg) || T('已失效'));
        // 失效记录（已取消/已过期/文件已删除）均可手动删除留痕；分享中的须先取消（服务端归口同规则）
        var delBtn = ok ? '' : '    <button class="drive-act drive-act-danger" data-act="delshare" title="' + T('删除记录') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>';
        return '<div class="drive-row drive-share-row' + (sh.is_dir ? ' is-dir' : '') + '" data-id="' + sh.id + '">' +
            '  <div class="drive-cell-name">' +
            '    <span class="drive-icon k-' + kind + '">' + ICONS[kind] + '</span>' +
            '    <div class="drive-name-wrap">' +
            '      <span class="drive-name" title="' + esc(sh.file_name) + '">' + esc(sh.file_name) + '</span>' +
            '      <span class="drive-row-path" title="' + esc(metaBits.join(' · ')) + '">' + esc(metaBits.join(' · ')) + '</span>' +
            '    </div>' +
            '  </div>' +
            '  <div class="drive-cell-size">' + (sh.is_dir ? '-' : fmtSize(sh.size)) + '</div>' +
            '  <div class="drive-cell-time">' + fmtTime(sh.expire_at) + '</div>' +
            '  <div class="drive-cell-actions">' +
            '    <span class="dsm-status ' + (ok ? 'ok' : 'bad') + '">' + esc(status) + '</span>' +
            (ok ? '    <button class="drive-act drive-act-danger" data-act="unshare" title="' + T('取消分享') + '"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' : '') +
            delBtn +
            '  </div>' +
            '</div>';
    }
    function renderSharePage(items) {
        itemsCache = items;
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += shareRowHtml(itemsCache[i]);
        rebuildRows(rowsHtml, T('暂无分享记录'));
        bindShareRowEvents();
        colTimeEl.textContent = T('到期时间');
        shareCountEl.textContent = T('共 {n} 条分享', { n: itemsCache.length });
    }
    function bindShareRowEvents() {
        listEl.querySelectorAll('.drive-row').forEach(function (row) {
            var id = parseInt(row.getAttribute('data-id'), 10);
            var it = null;
            for (var i = 0; i < itemsCache.length; i++) if (itemsCache[i].id === id) { it = itemsCache[i]; break; }
            if (!it) return;
            row.querySelectorAll('.drive-act').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (btn.getAttribute('data-act') === 'unshare') cancelShare(it);
                    else if (btn.getAttribute('data-act') === 'delshare') deleteShareRecord(it);
                });
            });
        });
    }
    function cancelShare(it) {
        driveConfirm(T('取消分享'),
            T('取消后链接与已发送的分享卡片将立即失效，确定取消分享“{v}”吗？', { v: it.file_name }),
            function () {
                apiPost('share/cancel', { username: u(), id: it.id }, function (err2) {
                    if (err2) { toast(TR(err2.message)); return; }
                    toast(T('分享已取消'));
                    loadShareList(); // 原位刷新状态
                });
            });
    }
    // 删除失效分享的留痕记录（纯记录操作，文件本体与副本引用不受影响；服务端归口校验仅失效记录可删）
    function deleteShareRecord(it) {
        driveConfirm(T('删除分享记录'),
            T('将删除“{v}”的这条分享留痕记录，文件本身不受影响，确定删除吗？', { v: it.file_name }),
            function () {
                apiPost('share/delete', { username: u(), id: it.id }, function (err2) {
                    if (err2) { toast(TR(err2.message)); return; }
                    toast(T('记录已删除'));
                    loadShareList(); // 原位移除该行
                });
            });
    }

    // ---- 分享详情（卡片气泡/站内链接点击进入） ----
    // 卡片点击入口（chat.js 92 气泡归口调用）：card 为信封 share 对象（含提取码标记等快照）
    function showShareCard(card) {
        if (!dsdMask || !card || !card.code) return;
        init(); // 卡片直达可能早于网盘页打开（init 含按钮事件绑定，幂等）
        closeDsMasks();
        dsdMask.classList.remove('hidden');
        dsdTitle.textContent = T('文件分享');
        dsCurCode = card.code;
        dsdInfo = null;
        dsdIcon.innerHTML = ICONS[kindOf(card)] || ICONS.file;
        dsdIcon.className = dsIconCls(card);
        dsdName.textContent = card.name || T('未命名文件');
        dsdMeta.textContent = (card.is_dir ? T('文件夹') : fmtSize(card.size)) +
            ' · ' + T('{u} 分享', { u: card.from_name || card.from || '' }) + (card.has_extract ? ' · ' + T('需提取码') : '');
        dsdInvalid.classList.add('hidden');
        dsdSaveBtn.classList.add('hidden');
        dsdDownBtn.classList.add('hidden');
        dsdExtract.value = '';
        if (card.has_extract) {
            dsdExtractRow.classList.remove('hidden');
            setTimeout(function () { dsdExtract.focus(); }, 60);
        } else {
            dsdExtractRow.classList.add('hidden');
            dsFetchShareInfo();
        }
    }
    // 站内链接入口（/s/<code> 登录后归口调用）：仅知分享码，需提取码时服务端引导展示输入行
    function showShareLink(code) {
        if (!dsdMask || !code) return;
        init(); // 链接直达不经过网盘页 open()，须先补事件绑定（幂等）
        closeDsMasks();
        dsdMask.classList.remove('hidden');
        dsdTitle.textContent = T('文件分享');
        dsCurCode = code;
        dsdInfo = null;
        dsdIcon.innerHTML = ICONS.file;
        dsdIcon.className = 'ds-file-icon drive-icon';
        dsdName.textContent = T('正在获取分享信息…');
        dsdMeta.textContent = '';
        dsdInvalid.classList.add('hidden');
        dsdSaveBtn.classList.add('hidden');
        dsdDownBtn.classList.add('hidden');
        dsdExtractRow.classList.add('hidden');
        dsdExtract.value = '';
        dsFetchShareInfo();
    }
    function dsFetchShareInfo() {
        apiJSON('/api/drive/share/info?code=' + encodeURIComponent(dsCurCode) +
            '&extract=' + encodeURIComponent(dsdExtract.value.trim()), null, function (err, data) {
            if (err) {
                if (data && data.need_extract) {
                    // 需要提取码：展示输入行引导（错误文案由输入行上方名称区提示，服务端文本全等反查）
                    dsdExtractRow.classList.remove('hidden');
                    dsdInvalid.classList.add('hidden');
                    dsdName.textContent = err.message ? TR(err.message) : T('请输入提取码');
                    dsdMeta.textContent = '';
                    setTimeout(function () { dsdExtract.focus(); dsdExtract.select(); }, 60);
                } else {
                    dsdInvalid.textContent = err.message ? TR(err.message) : T('分享已失效');
                    dsdInvalid.classList.remove('hidden');
                }
                return;
            }
            var sh = data.share;
            dsdInfo = sh;
            dsdIcon.innerHTML = ICONS[kindOf(sh)] || ICONS.file;
            dsdIcon.className = dsIconCls(sh);
            dsdName.textContent = sh.file_name;
            dsdMeta.textContent = (sh.is_dir ? T('文件夹') : fmtSize(sh.size)) + ' · ' + dsExpireText(sh.expire_at) +
                (sh.has_extract ? ' · ' + T('需提取码') : '') +
                ' · ' + T('{n} 次浏览', { n: sh.view_count || 0 }) + ' · ' + T('{n} 次下载', { n: sh.download_count || 0 }); // 统计服务端归口
            dsdInvalid.classList.add('hidden');
            dsdSaveBtn.classList.remove('hidden');
            dsdDownBtn.classList.toggle('hidden', !!sh.is_dir);
        });
    }
    function dsSaveToMyDrive() {
        apiPost('share/save', {
            username: u(), code: dsCurCode, extract: dsdExtract.value.trim(), parent_id: 0
        }, function (err, data) {
            if (err) { toast(TR(err.message)); return; }
            toast(T('已保存到我的网盘（共 {n} 项）', { n: data.saved || 0 }));
            closeDsMasks();
            if (visible) refreshAfterOp(); // 网盘页打开时原位刷新列表
            loadUsage();
        });
    }
    function dsDownloadViaShare() {
        if (!dsdInfo) return;
        // 走下载入队归口：Chromium 手势内先弹保存框流式写盘，其余环境回退内存 Blob（与网盘内下载同款体验）
        enqueueDownload(makeTask({
            kind: 'down', name: dsdInfo.file_name, size: dsdInfo.size || 0,
            url: '/api/drive/share/download?code=' + encodeURIComponent(dsCurCode) +
                '&extract=' + encodeURIComponent(dsdExtract.value.trim())
        }), false);
        closeDsMasks();
    }

    // ===== 打开/关闭（Tab 切换联动归口，chat.js 调用） =====
    function init() {
        if (inited) return;
        inited = true;
        console.log('[网盘] 脚本 v2.23 已加载（下载先弹保存框流式写盘/批量静默；PDF+Office 文档在线预览）；若右键无菜单请按 Ctrl+F5 强刷后重试'); // 版本判定归口：用户 F12 一眼确认所跑版本
        // DOM 移入主聊天区（公告流/设置页同款 absolute 覆盖，左侧列表保持可见）
        if (mainChatEl && view.parentElement !== mainChatEl) mainChatEl.appendChild(view);
        closeBtn.addEventListener('click', close);
        mkdirBtn.addEventListener('click', mkdir);
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
        // ===== 批量操作事件绑定（多选模式） =====
        selectBtn.addEventListener('click', function () { selMode ? exitSelectMode() : enterSelectMode(); });
        batchSelAllBtn.addEventListener('click', toggleSelectAll);
        batchDownBtn.addEventListener('click', batchDownload);
        batchMoveBtn.addEventListener('click', function () { openPickModal('move'); });
        batchCopyBtn.addEventListener('click', function () { openPickModal('copy'); });
        batchDelBtn.addEventListener('click', batchDelete);
        batchCancelBtn.addEventListener('click', exitSelectMode);
        // ===== 右键菜单（微信/百度网盘同款语义：右键未选中行=选区收拢为该行单项操作；
        // 右键已选中行=保持现选区批量操作。回收站/搜索态禁用——回收站行已有恢复/彻底删除专属按钮，
        // 搜索结果跨目录混排单项语义易混淆） =====
        if (ctxMenu && ctxMenu.parentElement !== document.body) document.body.appendChild(ctxMenu); // body 级防 overflow 裁剪
        function hideCtxMenu() {
            if (ctxMenu) ctxMenu.classList.add('hidden');
            // 清除右键目标行高亮（v2.18：菜单关闭归口统一清除，含点击别处/滚动/Esc/菜单动作各关闭路径）
            listEl.querySelectorAll('.drive-row.ctx-target').forEach(function (r) { r.classList.remove('ctx-target'); });
        }
        // ===== 右键统一处理（强制弹出归口）：mousedown/contextmenu 双通道 + document 捕获三重冗余，
        // 任一通道被浏览器扩展（鼠标手势等）拦截仍能弹菜单；150ms 内同坐标视为同一次操作只弹一次
        var lastCtxKey = '';
        var lastCtxTime = 0;
        function ctxDebounce(e) { // 双通道去重：返回 true=重复触发（调用方已拦原生菜单，不再重复弹）
            var k = e.clientX + ':' + e.clientY;
            var now = Date.now();
            if (k === lastCtxKey && now - lastCtxTime < 150) { lastCtxTime = now; return true; }
            lastCtxKey = k; lastCtxTime = now;
            return false;
        }
        function handleDriveCtx(e) {
            if (trashMode || shareMode || searchMode || !ctxMenu) return; // ctxMenu 缺失（缓存错位）或回收站/分享页/搜索态放行系统菜单
            var row = e.target.closest('.drive-row');
            if (!row) {
                // 空白处右键：仅「文件列表容器内」的空白接管（弹目录级菜单：新建/上传/刷新/全选/粘贴）。
                // v2.20 收窄接管范围——此前接管整个网盘视图，导致搜索框右键粘贴文本变成文件粘贴、
                // 工具栏按钮上右键也弹菜单；搜索框/按钮/面板其余空白放行系统菜单（搜索框走 chat.js 输入框右键菜单）
                if (!e.target.closest || !e.target.closest('#drive-file-list')) return;
                e.preventDefault(); // 接管：拦原生菜单（幂等命中也须拦，防双通道第二次放行原生菜单）
                if (ctxDebounce(e)) return;
                showCtxMenu(null, e.clientX, e.clientY);
                return;
            }
            e.preventDefault(); // 拦截系统菜单归口自绘（幂等命中时同样只拦不重弹）
            if (ctxDebounce(e)) return;
            var id = parseInt(row.getAttribute('data-id'), 10);
            var it = null;
            for (var i = 0; i < itemsCache.length; i++) if (itemsCache[i].id === id) { it = itemsCache[i]; break; }
            if (!it) return;
            // 选区语义（v2.17）：右键不开启多选态——用户反馈：右键自动进勾选模式后左键无法进入文件夹。
            // - 非多选态：仅弹菜单，复制/移动/删除等动作作用于右键行本身（不勾选、不改页面状态）
            // - 多选态：右键已选行=保持选区（批量动作）；右键未选行=收拢为该行（资源管理器语义）
            if (selMode && !selSet[id]) {
                selSet = {};
                selSet[id] = true;
                listEl.querySelectorAll('.drive-row').forEach(function (r) {
                    var rid = parseInt(r.getAttribute('data-id'), 10);
                    var on = !!selSet[rid];
                    r.classList.toggle('selected', on);
                    var chk = r.querySelector('.drive-check');
                    if (chk) chk.classList.toggle('checked', on);
                });
                updateBatchBar();
            }
            showCtxMenu(it, e.clientX, e.clientY); // 内部先清旧高亮（换目标不残留）
            row.classList.add('ctx-target'); // v2.18：菜单弹出期间高亮目标行（动作作用行可视化，hideCtxMenu 统一清除）
        }
        listEl.addEventListener('contextmenu', handleDriveCtx); // 通道一：标准冒泡（保留防回归）
        // 通道二：右键按下（mousedown）立即弹——contextmenu 事件被扩展吞掉时的生命线，且观感同 Windows 桌面
        listEl.addEventListener('mousedown', function (e) {
            if (e.button !== 2) return;
            handleDriveCtx(e);
        }, true);
        // 通道三：document 捕获阶段 contextmenu——事件在冒泡链中途被 stopPropagation 时仍可达
        document.addEventListener('contextmenu', function (e) {
            if (!ctxMenu || !view || !view.contains(e.target)) return;
            handleDriveCtx(e);
        }, true);
        // 菜单显隐归口（it=null=空白处：仅粘贴，目标=当前目录；粘贴项仅剪贴板非空且目标为目录时显示）
        function showCtxMenu(it, x, y) {
            // 清除旧目标行高亮（换目标/切空白不残留；本行新高亮由调用方在弹菜单后 add）
            listEl.querySelectorAll('.drive-row.ctx-target').forEach(function (r) { r.classList.remove('ctx-target'); });
            ctxTarget = it;
            var n = 0;
            if (it) for (var k in selSet) n++;
            var multi = !!it && n > 1;          // 多选区仅保留复制/移动/粘贴/删除批量语义
            var hasClip = !!(clip && clip.ids.length);
            var vis = {
                mkdirnew: !it,        // 目录级菜单项：仅空白处右键显示
                uploadnew: !it,
                refreshlist: !it,
                selectall: true,      // 全选：文件行/空白菜单共用
                clipcut: !!it,
                clipcopy: !!it,
                clippaste: hasClip,   // 文件行也可粘贴（目标=所在目录）；空白处=当前目录
                delete: !!it,
                download: !!it && !it.is_dir && !multi,
                share: !!it && !multi
            };
            for (var act in vis) {
                var mi = ctxMenu.querySelector('[data-action="' + act + '"]');
                if (mi) mi.style.display = vis[act] ? '' : 'none'; // null 守卫：缓存错位（新 JS+旧 HTML 缺菜单项）时不崩、菜单仍可弹
            }
            ctxMenu.classList.remove('hidden');
            ctxMenu.style.top = y + 'px';
            ctxMenu.style.left = x + 'px';
        }
        // 菜单项动作归口（粘贴复用 doMoveCopy 归口：toast+退出多选+原位刷新+复制刷容量；delete 按选区规模分发单删/批删）
        ctxMenu.querySelectorAll('.menu-item').forEach(function (item) {
            item.addEventListener('click', function () {
                var act = item.getAttribute('data-action');
                var it = ctxTarget;
                hideCtxMenu();
                if (act === 'clippaste') {
                    // 粘贴：右键目录=粘贴进该目录；文件行/空白处=粘贴到当前目录
                    if (!clip || !clip.ids.length) return;
                    var target = (it && it.is_dir) ? it.id : curParent;
                    var mode = clip.mode;
                    var ids = clip.ids;
                    if (mode === 'move') clip = null; // 移动粘贴即失效（一次性质），复制保留可多次粘贴
                    doMoveCopy(mode, ids, target);
                    return;
                }
                // 全选：文件行/空白菜单共用（进入多选态并勾选当前列表全部行）
                if (act === 'selectall') {
                    if (!selMode) enterSelectMode();
                    itemsCache.forEach(function (x) { selSet[x.id] = true; });
                    listEl.querySelectorAll('.drive-row').forEach(function (r) {
                        var rid = parseInt(r.getAttribute('data-id'), 10);
                        if (selSet[rid]) {
                            r.classList.add('selected');
                            var chk = r.querySelector('.drive-check');
                            if (chk) chk.classList.add('checked');
                        }
                    });
                    updateBatchBar();
                    return;
                }
                // 目录级菜单动作（仅空白处右键显示）：新建文件夹/上传文件/刷新列表
                if (act === 'mkdirnew') { mkdir(); return; }
                if (act === 'uploadnew') { fileInput.click(); return; }
                if (act === 'refreshlist') { loadList(); return; }
                if (!it) return; // 空白处菜单仅粘贴语义
                var n = 0;
                for (var k in selSet) n++;
                if (act === 'clipcopy' || act === 'clipcut') {
                    // 复制/移动入剪贴板：多选态=作用于选区；非多选态=作用于右键行本身
                    var ids = [];
                    for (var k2 in selSet) ids.push(parseInt(k2, 10));
                    if (!ids.length && it) ids = [it.id];
                    if (!ids.length) return;
                    clip = { mode: act === 'clipcopy' ? 'copy' : 'move', ids: ids };
                    toast(act === 'clipcopy' ? T('已复制到剪贴板') : T('已移动到剪贴板'));
                } else if (act === 'share') {
                    openShareDialog(it);
                } else if (act === 'download') {
                    downloadItem(it);
                } else if (act === 'delete') {
                    if (n > 1) batchDelete(); else deleteItem(it);
                }
            });
        });
        document.addEventListener('click', hideCtxMenu); // 点击别处关闭（msg-menu 同款归口）
        listEl.addEventListener('scroll', hideCtxMenu, true); // 列表滚动关闭防菜单悬空
        // ===== 回收站/分享页事件绑定（v2.21：入口上移左侧列表，工具栏按钮移除） =====
        trashClearBtn.addEventListener('click', clearTrash);
        shareBackBtn.addEventListener('click', exitShare);
        fileInput.addEventListener('change', function () {
            for (var i = 0; i < fileInput.files.length; i++) {
                upQueue.push(makeTask({ kind: 'up', name: fileInput.files[i].name, size: fileInput.files[i].size, file: fileInput.files[i] }));
            }
            renderTransfers();
            pump();
            fileInput.value = ''; // 允许重复选择同一文件
        });
        // 传输面板 tab 切换（上传/下载列表互斥展示）
        view.querySelectorAll('.drive-up-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                curTTab = btn.getAttribute('data-ttab');
                view.querySelectorAll('.drive-up-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
                uploadItemsEl.classList.toggle('hidden', curTTab !== 'up');
                downItemsEl.classList.toggle('hidden', curTTab !== 'down');
            });
        });
        // 清空已完成：仅作用于当前 tab（wait/run 任务保留）
        uploadsClearBtn.addEventListener('click', function () {
            var q = curTTab === 'up' ? upQueue : downQueue;
            for (var i = q.length - 1; i >= 0; i--) {
                if (q[i].state !== 'wait' && q[i].state !== 'run') {
                    if (q[i].el) q[i].el.remove();
                    q.splice(i, 1);
                }
            }
            renderTransfers();
        });
        // 搜索框（百度网盘同款）：输入防抖 300ms 全盘搜索；清空按钮恢复当前目录列表
        searchInput.addEventListener('input', function () {
            if (trashMode || shareMode) return; // 回收站/分享页态搜索框已隐藏，键盘事件兜底拦截
            var kw = searchInput.value.trim();
            searchClearBtn.classList.toggle('hidden', !kw);
            clearTimeout(searchTimer);
            if (!kw) {
                // 清空即退出搜索态，恢复当前目录列表
                exitSelectMode();
                searchMode = false;
                searchSeq++; // 作废在途搜索响应
                loadList();
                return;
            }
            searchTimer = setTimeout(function () { doSearch(kw); }, 300);
        });
        searchClearBtn.addEventListener('click', function () {
            searchInput.value = '';
            searchClearBtn.classList.add('hidden');
            if (searchMode) { exitSelectMode(); searchMode = false; searchSeq++; loadList(); }
            searchInput.focus();
        });
        // ===== 分享模块事件绑定（二期） =====
        dsTabChat.addEventListener('click', function () { dsShowTab('chat'); });
        dsTabLink.addEventListener('click', function () { dsShowTab('link'); });
        dsContactSearch.addEventListener('input', dsRenderContacts);
        dsSendBtn.addEventListener('click', dsSendToContacts);
        dsExpireGroup.querySelectorAll('.ds-expire').forEach(function (b) {
            b.addEventListener('click', function () {
                dsExpireDays = parseInt(b.getAttribute('data-days'), 10) || 0;
                dsExpireGroup.querySelectorAll('.ds-expire').forEach(function (x) {
                    x.classList.toggle('active', x === b);
                });
            });
        });
        dsGenBtn.addEventListener('click', dsGenLink);
        dsCopyBtn.addEventListener('click', function () {
            var text = dsLinkText.textContent;
            var code = dsLinkCode.textContent;
            if (code && dsCodeRow && !dsCodeRow.classList.contains('hidden')) {
                text += ' ' + T('提取码:') + code; // 有提取码时一并复制（百度网盘同款文案合并）
            }
            dsCopyText(text, T('链接已复制'));
        });
        dsdExtractOk.addEventListener('click', dsFetchShareInfo);
        // 提取码输入自动转大写（所见即所发；服务端比对亦不区分大小写兜底）
        dsdExtract.addEventListener('input', function () {
            var v = dsdExtract.value.toUpperCase();
            if (v !== dsdExtract.value) dsdExtract.value = v;
        });
        dsdExtract.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); dsFetchShareInfo(); }
        });
        dsdSaveBtn.addEventListener('click', dsSaveToMyDrive);
        dsdDownBtn.addEventListener('click', dsDownloadViaShare);
        dsdCancelBtn.addEventListener('click', closeDsMasks);
        [dsMask, dsdMask].forEach(function (m) {
            if (!m) return;
            m.addEventListener('click', function (e) { if (e.target === m) closeDsMasks(); });
        });
        // 左侧"我的文件"入口：退出回收站/分享页回根目录并刷新
        driveEntry.addEventListener('click', function () {
            if (trashMode) resetTrashUI();
            if (shareMode) resetShareUI();
            if (searchMode) clearSearchUI();
            curParent = 0;
            crumbs = [{ id: 0, name: T('我的文件') }];
            loadList();
        });
        // 左侧"分享管理"入口（v2.21）：开页面进分享模式（互斥回收站）；页面未开则先开
        shareEntry.addEventListener('click', function () {
            if (!visible) open();
            enterShare();
        });
        // 左侧"回收站"入口（v2.21）：开页面进回收站模式（互斥分享页）；页面未开则先开
        trashEntry.addEventListener('click', function () {
            if (!visible) open();
            enterTrash();
        });
        // 拖拽上传（百度网盘同款）：拖文件入网盘页面浮出遮罩，松手入队上传到当前目录；
        // 计数器法防子元素间 dragleave 抖动（dragenter++/dragleave--，归零收遮罩）
        var dragDepth = 0;
        if (dropMask) {
            view.addEventListener('dragenter', function (e) {
                if (trashMode || shareMode) return; // 回收站/分享页态禁用拖拽上传
                e.preventDefault();
                dragDepth++;
                dropMask.classList.remove('hidden');
            });
            view.addEventListener('dragover', function (e) {
                e.preventDefault(); // 允许 drop（浏览器默认会打开文件，必须拦截）
            });
            view.addEventListener('dragleave', function (e) {
                e.preventDefault();
                dragDepth--;
                if (dragDepth <= 0) { dragDepth = 0; dropMask.classList.add('hidden'); }
            });
            view.addEventListener('drop', function (e) {
                e.preventDefault(); // 回收站态同样拦截默认行为（防浏览器打开拖入文件），仅不入队
                dragDepth = 0;
                dropMask.classList.add('hidden');
                if (trashMode || shareMode) return; // 回收站/分享页态禁用拖拽上传
                var files = e.dataTransfer && e.dataTransfer.files;
                if (!files || !files.length) return;
                for (var i = 0; i < files.length; i++) {
                    upQueue.push(makeTask({ kind: 'up', name: files[i].name, size: files[i].size, file: files[i] }));
                }
                renderTransfers();
                pump();
            });
        }
        // Esc 关闭：网盘分享弹层全局优先（分享详情可从聊天气泡打开，不依赖网盘页可见）；
        // 其次预览浮层 → 本页面自绘弹窗 → 退出搜索态 → 关页面
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (anyDsMaskOpen()) { closeDsMasks(); return; }
            if (pvMask && !pvMask.classList.contains('hidden')) { closeViewer(); return; }
            if (!visible) return;
            if (ctxMenu && !ctxMenu.classList.contains('hidden')) { hideCtxMenu(); return; } // Esc 逐级：右键菜单最先关（归口 hideCtxMenu 同步清目标行高亮）
            if (maskEl && !maskEl.classList.contains('hidden')) { closeModal(); return; }
            if (pickMask && !pickMask.classList.contains('hidden')) { closePickModal(); return; } // Esc 逐级：先关弹窗内输入弹窗，再关目录选择弹窗
            if (selMode) { exitSelectMode(); return; } // Esc 逐级退出：弹窗→多选→回收站→搜索→页面
            if (trashMode) { exitTrash(); return; }
            if (shareMode) { exitShare(); return; } // v2.21 Esc 逐级：分享页在回收站之后退出
            if (searchMode) { clearSearchUI(); searchSeq++; loadList(); return; }
            close();
        });
        // 自绘悬浮滚动条注册（chat.js 暴露的 _osbInit，加载顺序保证其可用）
        if (window._osbInit) {
            window._osbInit(listEl);
            window._osbInit(uploadItemsEl); // 上传列表限高滚动区同款悬浮滑块
            window._osbInit(downItemsEl);   // 下载列表同款
            // 网盘分享弹窗滚动区同款悬浮滑块（禁系统滚动条归口）
            if (dsContactList) window._osbInit(dsContactList); // 分享选人列表
        }
    }
    function open() {
        init();
        if (!visible) {
            visible = true;
            view.classList.remove('hidden');
            if (trashMode) resetTrashUI(); // 重开页面重置回收站态（纯 UI 复位，列表刷新归口下方 loadList）
            if (shareMode) resetShareUI(); // v2.21 重开页面重置分享页态
            exitSelectMode(); // 重开页面重置多选态
            clearSearchUI(); // 重开页面重置搜索态（与目录/面包屑一并归位）
            crumbs = [{ id: 0, name: T('我的文件') }];
            curParent = 0;
            loadList();
        }
    }
    function close() {
        visible = false;
        view.classList.add('hidden');
    }
    function isOpen() { return visible; }

    // 暴露给 chat.js：Tab 切换联动（open/close/isOpen）+ 分享详情归口（92 卡片气泡点击 / /s/<code> 链接登录后调用）
    window.IMDrive = {
        open: open, close: close, isOpen: isOpen,
        showShareCard: showShareCard, showShareLink: showShareLink
    };
})();
