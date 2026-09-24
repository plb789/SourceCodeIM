// ===== 网盘模块（百度网盘同款个人云盘，一期：目录浏览/上传/下载/重命名/删除/新建文件夹） =====
// 设计归口（服务端统一数据归口，客户端只展示）：
//  1. 数据源唯一归口 /api/drive/*（列表/建目录/重命名/删除/上传/下载），客户端零本地状态持久化
//  2. 页面形态：#drive-view 覆盖 .main-chat 右侧聊天区（公告流/设置页同款 absolute 覆盖，
//     DOM 常驻 body 由本模块移入主聊天区），左侧列表保持可见可点；切走 Tab / 返回聊天 / Esc 关闭
//  3. 交互约束（项目规则）：全部弹窗自绘（.modal-mask/.modal-box 复用，禁系统弹窗）；
//     滚动条用全局自绘悬浮滑块（chat.js _osbInit 注册，加载顺序在 chat.js 之后）
//  4. 传输面板（百度网盘同款）：右下角浮层 上传/下载双 tab 列表，逐项进度条+大小+速度+剩余时间+取消；
//     上传 XHR FormData 直传（服务端流式落 MinIO/本地），下载 fetch 流式归口（MinIO 走 302 预签名
//     直连已实测暴露 CORS+Content-Length，本地后端同源），均串行队列，完成自动刷新
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
    var mainChatEl = document.querySelector('.main-chat');
    // 左侧网盘面板（我的文件入口 + 容量概览）
    var driveEntry = document.getElementById('drive-entry-root');
    var usageEl = document.getElementById('drive-usage');
    var usageFill = document.getElementById('drive-usage-fill');
    var usageText = document.getElementById('drive-usage-text');
    // 分享模块（二期：分享弹窗/分享管理/分享详情 三自绘弹层）
    var dsManageBtn = document.getElementById('drive-share-manage-btn');
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
    var dsmMask = document.getElementById('dsm-mask');
    var dsmList = document.getElementById('dsm-list');
    var dsmEmpty = document.getElementById('dsm-empty');
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
    function rowHtml(it, showPath) {
        var kind = kindOf(it);
        var loc = it.path || T('我的文件');
        return '<div class="drive-row' + (it.is_dir ? ' is-dir' : '') + '" data-id="' + it.id + '">' +
            '  <div class="drive-cell-name">' +
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
        searchMode = false;
        searchInput.value = '';
        searchClearBtn.classList.add('hidden');
        clearTimeout(searchTimer);
    }
    // doSearch 全盘搜索（seq 序号守卫：仅采纳最新请求结果，防乱序覆盖）
    function doSearch(kw) {
        var seq = ++searchSeq;
        apiJSON('/api/drive/search?username=' + encodeURIComponent(u()) + '&keyword=' + encodeURIComponent(kw), null, function (err, data) {
            if (seq !== searchSeq) return;
            if (err) { toast(err.message); return; }
            searchMode = true;
            renderSearchList((data && data.items) || []);
        });
    }
    // 操作后刷新归口：搜索态重跑搜索（结果实时跟随改名/删除），目录态刷新当前目录
    function refreshAfterOp() {
        if (searchMode && searchInput.value.trim()) { doSearch(searchInput.value.trim()); return; }
        loadList();
    }

    function enterDir(id, name, isBack) {
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
            // 目录整行点击进入（文件夹/文件操作按钮事件独立冒泡）
            row.addEventListener('click', function (e) {
                if (e.target.closest('.drive-act')) return; // 动作按钮不触发进入
                if (it.is_dir) enterDir(it.id, it.name);
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
    function downloadItem(it) {
        // 下载归口页面内 fetch 流式（百度网盘同款传输列表：进度/速度/剩余时间可视）
        downQueue.push(makeTask({ name: it.name, size: it.size || 0, id: it.id, kind: 'down' }));
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
            T('确定删除 "{v}" 吗？', { v: it.name }) + (it.is_dir ? T('文件夹内全部内容将一并删除，') : '') + T('此操作不可恢复。'),
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
        drivePrompt(T('新建文件夹'), T('输入文件夹名称'), '', function (val) {
            apiPost('mkdir', { username: u(), parent_id: curParent, name: val }, function (err) {
                if (err) { toast(TR(err.message)); return; }
                toast(T('创建成功'));
                refreshAfterOp();
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
    function makeTask(o) {
        return {
            kind: o.kind || 'up', name: o.name || '', size: o.size || 0, id: o.id || 0,
            file: o.file || null, loaded: 0, pct: 0, speed: 0,
            state: 'wait', errMsg: '', xhr: null, abort: null, el: null
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
            // 取消：传输中点 × 中止（上传 abort XHR / 下载 abort fetch），取消按失败留痕"已取消"
            t.cancelEl.addEventListener('click', function (tt) {
                return function () {
                    if (tt.state !== 'run') return;
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
            t.stateEl.textContent = T(up ? '上传中 {v}' : '下载中 {v}', { v: t.size ? t.pct + '%' : sizeText });
            var remain = t.speed > 0 && t.size ? (t.size - t.loaded) / t.speed : Infinity;
            var extras = [];
            if (t.size) extras.push(sizeText);
            var sp = fmtSpeed(t.speed);
            if (sp) extras.push(sp);
            var rm = fmtRemain(remain);
            if (rm) extras.push(rm);
            t.extraEl.textContent = extras.join(' · ');
        } else if (t.state === 'ok') {
            t.stateEl.textContent = T(up ? '上传完成' : '下载完成');
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
    function uploadOne(t, done) {
        t.state = 'run';
        updateTaskUI(t);
        var fd = new FormData();
        fd.append('file', t.file, t.file.name);
        var xhr = new XMLHttpRequest();
        t.xhr = xhr;
        var sample = makeSampler();
        xhr.open('POST', '/api/drive/upload?username=' + encodeURIComponent(u()) + '&parent_id=' + curParent);
        xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable) return;
            t.loaded = e.loaded;
            t.size = e.total;
            t.pct = Math.round(e.loaded * 100 / e.total);
            t.speed = sample(e.loaded);
            updateTaskUI(t);
        };
        xhr.onload = function () {
            var errMsg = null;
            if (xhr.status >= 200 && xhr.status < 300) {
                t.state = 'ok'; t.pct = 100; t.loaded = t.size;
            } else {
                t.state = 'fail';
                try { errMsg = JSON.parse(xhr.responseText).error; } catch (e) { /* 纯文本错误兜底 */ }
                if (!errMsg) errMsg = 'HTTP ' + xhr.status;
            }
            t.errMsg = errMsg;
            updateTaskUI(t);
            renderTransfers();
            if (t.state === 'ok') { refreshAfterOp(); loadUsage(); }
            done();
        };
        xhr.onerror = function () {
            t.state = 'fail'; t.errMsg = '网络异常';
            updateTaskUI(t);
            renderTransfers();
            done();
        };
        xhr.onabort = function () {
            t.state = 'fail'; t.errMsg = '已取消';
            updateTaskUI(t);
            renderTransfers();
            done();
        };
        xhr.send(fd);
    }
    function downloadOne(t, done) {
        t.state = 'run';
        updateTaskUI(t);
        var ctrl = new AbortController();
        t.abort = ctrl;
        var sample = makeSampler();
        // 下载地址归口：默认本人网盘下载；分享详情下载经 t.url（share/download，凭分享码+提取码）
        fetch(t.url || ('/api/drive/download?username=' + encodeURIComponent(u()) + '&id=' + t.id), { signal: ctrl.signal })
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
            .catch(function (err) {
                if (err && err.name === 'AbortError') { t.state = 'fail'; t.errMsg = '已取消'; }
                else { t.state = 'fail'; t.errMsg = (err && err.message) || '网络异常'; }
                updateTaskUI(t);
                renderTransfers();
            })
            .then(function () { done(); }, function () { done(); });
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
    // 网盘弹层互斥显隐归口（分享弹窗/分享管理/分享详情；mask 点击与 Esc 统一走此收口）
    function closeDsMasks() {
        if (dsMask) dsMask.classList.add('hidden');
        if (dsmMask) dsmMask.classList.add('hidden');
        if (dsdMask) dsdMask.classList.add('hidden');
    }
    function anyDsMaskOpen() {
        return (dsMask && !dsMask.classList.contains('hidden')) ||
            (dsmMask && !dsmMask.classList.contains('hidden')) ||
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
    function openShareManage() {
        closeDsMasks();
        if (!dsmMask) return;
        dsmList.innerHTML = '<div class="dsm-empty">' + T('加载中…') + '</div>';
        dsmEmpty.classList.add('hidden');
        dsmMask.classList.remove('hidden');
        apiJSON('/api/drive/share/list?username=' + encodeURIComponent(u()), null, function (err, data) {
            if (err) { toast(TR(err.message)); dsmList.innerHTML = ''; dsmEmpty.textContent = TR(err.message); dsmEmpty.classList.remove('hidden'); return; }
            renderShareManage((data && data.items) || []);
        });
    }
    function renderShareManage(items) {
        dsmList.innerHTML = '';
        dsmEmpty.classList.toggle('hidden', items.length > 0);
        if (!items.length) { dsmEmpty.textContent = T('暂无分享记录'); return; }
        items.forEach(function (sh) {
            var row = document.createElement('div');
            row.className = 'dsm-row';
            var icon = document.createElement('span');
            icon.className = dsIconCls(sh);
            icon.innerHTML = ICONS[kindOf(sh)] || ICONS.file;
            var info = document.createElement('div');
            info.className = 'dsm-info';
            var nm = document.createElement('div');
            nm.className = 'dsm-name';
            nm.textContent = sh.file_name;
            nm.title = nm.textContent;
            var meta = document.createElement('div');
            meta.className = 'dsm-meta';
            var metaBits = [(sh.is_dir ? T('文件夹') : fmtSize(sh.size)), dsExpireText(sh.expire_at)];
            if (sh.has_extract) metaBits.push(T('提取码'));
            // 分享统计（服务端归口计数：浏览/下载/保存，词条与分享页共用）
            metaBits.push(T('{n} 次浏览', { n: sh.view_count || 0 }) + ' · ' + T('{n} 次下载', { n: sh.download_count || 0 }) + ' · ' + T('{n} 次保存', { n: sh.save_count || 0 }));
            meta.textContent = metaBits.join(' · ');
            info.appendChild(nm);
            info.appendChild(meta);
            var status = document.createElement('span');
            var ok = sh.status === 'valid';
            status.className = 'dsm-status ' + (ok ? 'ok' : 'bad');
            status.textContent = ok ? T('分享中') : (TR(sh.valid_msg) || T('已失效'));
            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'dsm-cancel';
            cancelBtn.textContent = T('取消分享');
            cancelBtn.addEventListener('click', function () {
                driveConfirm(T('取消分享'),
                    T('取消后链接与已发送的分享卡片将立即失效，确定取消分享“{v}”吗？', { v: sh.file_name }),
                    function () {
                        apiPost('share/cancel', { username: u(), id: sh.id }, function (err2) {
                            if (err2) { toast(TR(err2.message)); return; }
                            toast(T('分享已取消'));
                            openShareManage(); // 原位刷新状态
                        });
                    });
            });
            row.appendChild(icon);
            row.appendChild(info);
            row.appendChild(status);
            if (ok) row.appendChild(cancelBtn);
            dsmList.appendChild(row);
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
        downQueue.push(makeTask({
            kind: 'down', name: dsdInfo.file_name, size: dsdInfo.size || 0,
            url: '/api/drive/share/download?code=' + encodeURIComponent(dsCurCode) +
                '&extract=' + encodeURIComponent(dsdExtract.value.trim())
        }));
        renderTransfers();
        pumpDown();
        closeDsMasks();
    }

    // ===== 打开/关闭（Tab 切换联动归口，chat.js 调用） =====
    function init() {
        if (inited) return;
        inited = true;
        // DOM 移入主聊天区（公告流/设置页同款 absolute 覆盖，左侧列表保持可见）
        if (mainChatEl && view.parentElement !== mainChatEl) mainChatEl.appendChild(view);
        closeBtn.addEventListener('click', close);
        mkdirBtn.addEventListener('click', mkdir);
        uploadBtn.addEventListener('click', function () { fileInput.click(); });
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
            var kw = searchInput.value.trim();
            searchClearBtn.classList.toggle('hidden', !kw);
            clearTimeout(searchTimer);
            if (!kw) {
                // 清空即退出搜索态，恢复当前目录列表
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
            if (searchMode) { searchMode = false; searchSeq++; loadList(); }
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
        [dsMask, dsmMask, dsdMask].forEach(function (m) {
            if (!m) return;
            m.addEventListener('click', function (e) { if (e.target === m) closeDsMasks(); });
        });
        if (dsManageBtn) dsManageBtn.addEventListener('click', openShareManage);
        // 左侧"我的文件"入口：回根目录并刷新
        driveEntry.addEventListener('click', function () {
            if (searchMode) clearSearchUI();
            curParent = 0;
            crumbs = [{ id: 0, name: T('我的文件') }];
            loadList();
        });
        // 拖拽上传（百度网盘同款）：拖文件入网盘页面浮出遮罩，松手入队上传到当前目录；
        // 计数器法防子元素间 dragleave 抖动（dragenter++/dragleave--，归零收遮罩）
        var dragDepth = 0;
        if (dropMask) {
            view.addEventListener('dragenter', function (e) {
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
                e.preventDefault();
                dragDepth = 0;
                dropMask.classList.add('hidden');
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
        // 其次本页面自绘弹窗 → 退出搜索态 → 关页面
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (anyDsMaskOpen()) { closeDsMasks(); return; }
            if (!visible) return;
            if (maskEl && !maskEl.classList.contains('hidden')) { closeModal(); return; }
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
            if (dsmList) window._osbInit(dsmList);             // 分享管理列表
        }
    }
    function open() {
        init();
        if (!visible) {
            visible = true;
            view.classList.remove('hidden');
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
