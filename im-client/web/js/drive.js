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

    // ===== 通用请求（JSON 归口：失败弹自绘提示，服务端 error 文本直显） =====
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
            '    <button class="modal-btn" id="drive-modal-cancel">取消</button>' +
            '    <button class="modal-btn drive-modal-ok" id="drive-modal-ok">确定</button>' +
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
        if (sec > 3600) return '>1小时';
        var m = Math.floor(sec / 60), s = Math.round(sec % 60);
        if (m > 0) return '剩余 ' + m + ' 分 ' + (s < 10 ? '0' : '') + s + ' 秒';
        return '剩余 ' + s + ' 秒';
    }
    // 文件类别归口（图标渲染：目录/图片/视频/音频/压缩包/文档/表格/PDF/通用）
    function kindOf(item) {
        if (item.is_dir) return 'dir';
        var ext = (item.name.split('.').pop() || '').toLowerCase();
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
        var loc = it.path || '我的文件';
        return '<div class="drive-row' + (it.is_dir ? ' is-dir' : '') + '" data-id="' + it.id + '">' +
            '  <div class="drive-cell-name">' +
            '    <span class="drive-icon k-' + kind + '">' + ICONS[kind] + '</span>' +
            '    <div class="drive-name-wrap">' +
            '      <span class="drive-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
            (showPath ? '      <span class="drive-row-path" title="' + esc(loc) + '">所在位置：' + esc(loc) + '</span>' : '') +
            '    </div>' +
            '  </div>' +
            '  <div class="drive-cell-size">' + (it.is_dir ? '-' : fmtSize(it.size)) + '</div>' +
            '  <div class="drive-cell-time">' + fmtTime(it.update_time || it.create_time) + '</div>' +
            '  <div class="drive-cell-actions">' +
            (it.is_dir ? '' : '    <button class="drive-act" data-act="download" title="下载"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>') +
            '    <button class="drive-act" data-act="rename" title="重命名"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>' +
            '    <button class="drive-act drive-act-danger" data-act="delete" title="删除"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>' +
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
        rebuildRows(rowsHtml, '暂无文件');
        bindRowEvents();
        renderBreadcrumb();
        renderUsage(data);
        if (data && data.storage) {
            storageTag.textContent = data.storage === 'minio' ? 'MinIO 存储' : (data.storage === 'local' ? '本地存储' : '');
            storageTag.classList.remove('hidden');
        }
    }

    // 搜索结果渲染（全盘命中项含所在位置路径；行事件复用 bindRowEvents——目录点击 enterDir
    // 内部退出搜索态，下载/重命名/删除照常，操作后 refreshAfterOp 归口刷新）
    function renderSearchList(items) {
        itemsCache = items || [];
        var rowsHtml = '';
        for (var i = 0; i < itemsCache.length; i++) rowsHtml += rowHtml(itemsCache[i], true);
        rebuildRows(rowsHtml, '未找到匹配的文件');
        bindRowEvents();
    }

    function renderUsage(data) {
        if (!data) return;
        var used = data.used_bytes || 0, quota = data.quota_bytes;
        usageEl.classList.remove('hidden');
        if (quota < 0) {
            usageFill.style.width = '0%';
            usageText.textContent = '已用 ' + fmtSize(used) + '（不限容量）';
        } else {
            var pct = quota > 0 ? Math.min(100, Math.round(used * 100 / quota)) : 0;
            usageFill.style.width = pct + '%';
            usageFill.classList.toggle('drive-usage-warn', pct >= 80);
            usageText.textContent = '已用 ' + fmtSize(used) + ' / ' + fmtSize(quota);
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
        var tip = it.is_dir ? '重命名文件夹' : '重命名文件';
        drivePrompt(tip, '输入新名称', it.name, function (val) {
            apiPost('rename', { username: u(), id: it.id, name: val }, function (err) {
                if (err) { toast(err.message); return; }
                toast('重命名成功');
                refreshAfterOp();
            });
        });
    }
    function deleteItem(it) {
        driveConfirm('删除' + (it.is_dir ? '文件夹' : '文件'),
            '确定删除 "' + it.name + '" 吗？' + (it.is_dir ? '文件夹内全部内容将一并删除，' : '') + '此操作不可恢复。',
            function () {
                apiPost('delete', { username: u(), id: it.id }, function (err) {
                    if (err) { toast(err.message); return; }
                    toast('删除成功');
                    refreshAfterOp();
                    loadUsage();
                });
            });
    }
    function mkdir() {
        drivePrompt('新建文件夹', '输入文件夹名称', '', function (val) {
            apiPost('mkdir', { username: u(), parent_id: curParent, name: val }, function (err) {
                if (err) { toast(err.message); return; }
                toast('创建成功');
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
                '  <button class="drive-up-cancel" title="取消" hidden><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
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
        var verb = t.kind === 'up' ? '上传' : '下载';
        var sizeText = fmtSize(t.loaded) + ' / ' + (t.size ? fmtSize(t.size) : '未知大小');
        if (t.state === 'wait') {
            t.stateEl.textContent = '等待' + verb;
            t.extraEl.textContent = t.size ? fmtSize(t.size) : '';
        } else if (t.state === 'run') {
            t.stateEl.textContent = verb + '中 ' + (t.size ? t.pct + '%' : sizeText);
            var remain = t.speed > 0 && t.size ? (t.size - t.loaded) / t.speed : Infinity;
            var extras = [];
            if (t.size) extras.push(sizeText);
            var sp = fmtSpeed(t.speed);
            if (sp) extras.push(sp);
            var rm = fmtRemain(remain);
            if (rm) extras.push(rm);
            t.extraEl.textContent = extras.join(' · ');
        } else if (t.state === 'ok') {
            t.stateEl.textContent = verb + '完成';
            t.extraEl.textContent = t.size ? fmtSize(t.size) : '';
        } else {
            t.stateEl.textContent = verb + '失败：' + (t.errMsg || '未知错误');
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
        fetch('/api/drive/download?username=' + encodeURIComponent(u()) + '&id=' + t.id, { signal: ctrl.signal })
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
        // 左侧"我的文件"入口：回根目录并刷新
        driveEntry.addEventListener('click', function () {
            if (searchMode) clearSearchUI();
            curParent = 0;
            crumbs = [{ id: 0, name: '我的文件' }];
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
        // Esc 关闭（仅本页面可见时；自绘弹窗打开时优先关弹窗，其次退出搜索态，最后关页面）
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' || !visible) return;
            if (maskEl && !maskEl.classList.contains('hidden')) { closeModal(); return; }
            if (searchMode) { clearSearchUI(); searchSeq++; loadList(); return; }
            close();
        });
        // 自绘悬浮滚动条注册（chat.js 暴露的 _osbInit，加载顺序保证其可用）
        if (window._osbInit) {
            window._osbInit(listEl);
            window._osbInit(uploadItemsEl); // 上传列表限高滚动区同款悬浮滑块
            window._osbInit(downItemsEl);   // 下载列表同款
        }
    }
    function open() {
        init();
        if (!visible) {
            visible = true;
            view.classList.remove('hidden');
            clearSearchUI(); // 重开页面重置搜索态（与目录/面包屑一并归位）
            crumbs = [{ id: 0, name: '我的文件' }];
            curParent = 0;
            loadList();
        }
    }
    function close() {
        visible = false;
        view.classList.add('hidden');
    }
    function isOpen() { return visible; }

    // 暴露给 chat.js Tab 切换联动（网盘 Tab 进入时 open，切走时 close）
    window.IMDrive = { open: open, close: close, isOpen: isOpen };
})();
