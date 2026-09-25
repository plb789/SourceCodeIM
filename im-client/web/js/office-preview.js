// ===== Office 文档在线预览归口（网盘浮层 / 分享页共用；渲染核心与聊天工作台同款三库） =====
// docx=mammoth / 表格(xls/xlsx/csv)=SheetJS / pptx=PptxViewJS——index.html 已全局引入，
// 分享页缺库时按需懒加载（首次预览才拉取，不拖首屏）；渲染失败/组件缺失均友好降级提示
// 全程 fetch arrayBuffer + Blob 装载（禁 FileReader——PptxViewJS 对 window.FileReader 全局污染规避归口）
// 护栏：单文件 >50MB 拒解析提示下载；表格 sheetRows 截断 2000 行防超大表卡顿（附截断提示条）
(function () {
    'use strict';
    var MAX_BYTES = 50 * 1024 * 1024;
    var SHEET_ROWS = 2000;
    var seq = 0; // 迟到响应序号：每次 render 递增，回调校验丢弃（快速关闭/切换预览防旧内容覆盖新开预览）

    // 库地址表（与 index.html 全局引入同源同版本；分享页按需懒加载归口）
    var LIBS = {
        jszip: '/js/lib/jszip.min.js?v=3.10',
        mammoth: '/js/lib/mammoth.browser.min.js?v=1.0',
        pptx: '/js/lib/PptxViewJS.min.js?v=1.0',
        xlsx: '/js/lib/xlsx.full.min.js?v=0.20'
    };
    var libState = {}; // url -> 1 加载中 / 2 完成 / 0 失败
    var libCbs = {};   // url -> [cb...]（加载中合并回调，防重复注入 script）

    function loadScript(url, cb) {
        if (libState[url] === 2) return cb();
        (libCbs[url] = libCbs[url] || []).push(cb);
        if (libState[url] === 1) return;
        libState[url] = 1;
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { libState[url] = 2; flush(url); };
        s.onerror = function () { libState[url] = 0; flush(url); };
        document.head.appendChild(s);
    }
    function flush(url) { var cbs = libCbs[url] || []; delete libCbs[url]; cbs.forEach(function (c) { c(); }); }
    // 按渲染种类确保依赖库就绪（全部成功走 ok，任一失败走 fail）
    function ensureLibs(kind, ok, fail) {
        var need = kind === 'docx' ? [LIBS.mammoth]
            : kind === 'sheet' ? [LIBS.xlsx]
                : [LIBS.jszip, LIBS.pptx];
        var n = need.length, bad = false;
        if (!n) return ok();
        need.forEach(function (u) {
            loadScript(u, function () {
                if (libState[u] !== 2) bad = true;
                if (--n === 0) (bad ? fail : ok)();
            });
        });
    }

    // 扩展名归口：返回 office 渲染种类 docx/sheet/pptx，非 office 返回 ''
    // （img/pdf/音视频/文本为浏览器原生可渲染类型，各页自判；doc/xls 老二进制格式不支持照常走下载）
    function kindOf(name) {
        var ext = ((name || '').split('.').pop() || '').toLowerCase();
        if (ext === 'docx') return 'docx';
        if (['xls', 'xlsx', 'csv'].indexOf(ext) >= 0) return 'sheet';
        if (ext === 'pptx') return 'pptx';
        return '';
    }

    function hint(box, text) {
        box.innerHTML = '';
        var d = document.createElement('div');
        d.className = 'office-view-hint';
        d.textContent = text;
        box.appendChild(d);
    }

    // 拉取并渲染进 body（body 为各页预览浮层内容区；T 为页内 i18n 函数；关闭清场由调用方负责）
    function render(url, name, body, T) {
        var my = ++seq;
        body._officeSeq = my;
        fetch(url).then(function (res) {
            if (!res.ok) throw new Error(T('预览加载失败({n})', { n: res.status }));
            return res.arrayBuffer();
        }, function () { throw new Error(T('网络异常，请稍后重试')); }).then(function (buf) {
            if (body._officeSeq !== my) return; // 已关闭或已切换新预览：丢弃迟到渲染
            if (buf.byteLength > MAX_BYTES) throw new Error(T('文件过大（超过 50MB），请下载查看'));
            var kind = kindOf(name);
            body.innerHTML = '';
            var box = document.createElement('div');
            box.className = 'office-view-scroll';
            body.appendChild(box);
            ensureLibs(kind, function () {
                if (body._officeSeq !== my) return;
                if (kind === 'docx') renderDocx(buf, box, T);
                else if (kind === 'sheet') renderSheet(buf, box, T);
                else renderPptx(buf, box, T);
            }, function () {
                if (body._officeSeq !== my) return;
                hint(box, T('Office 组件加载失败，请刷新页面重试'));
            });
        }, function (err) {
            if (body._officeSeq !== my) return;
            hint(body, err.message || T('预览加载失败'));
        });
    }

    // Word 文档：mammoth 转 HTML（复用 ws-view-docx 文档页排版样式，只读）
    function renderDocx(buf, box, T) {
        if (typeof mammoth === 'undefined') { hint(box, T('文档组件未加载，无法预览')); return; }
        mammoth.convertToHtml({ arrayBuffer: buf }).then(function (r) {
            box.innerHTML = '';
            var doc = document.createElement('div');
            doc.className = 'ws-view-md ai-md ws-view-docx';
            doc.innerHTML = (r && r.value) || '<p>' + T('（空文档）') + '</p>';
            box.appendChild(doc);
            if (window._osbInit) window._osbInit(box); // 预览滚动区自绘悬浮滑块归口
        }, function (e) {
            hint(box, T('解析失败：') + ((e && e.message) || e));
        });
    }

    // 表格：SheetJS 解析（多 sheet 标签条切换；sheetRows 截断附提示条；sheet_to_html 只读直显）
    function renderSheet(buf, box, T) {
        if (typeof XLSX === 'undefined') { hint(box, T('表格组件未加载，无法预览')); return; }
        var wb;
        try { wb = XLSX.read(buf, { type: 'array', sheetRows: SHEET_ROWS }); }
        catch (e) { hint(box, T('解析失败：') + ((e && e.message) || e)); return; }
        var names = wb.SheetNames || [];
        if (!names.length) { hint(box, T('（空工作簿）')); return; }
        var cur = 0;
        var tabEl = null;
        function draw() {
            var tab = document.createElement('div');
            tab.className = 'ws-view-md ai-md ws-xlsx-body';
            try {
                tab.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[names[cur]], { header: '', footer: '' }) || '<p>' + T('（空表）') + '</p>';
            } catch (e2) {
                tab.innerHTML = '<p>' + T('渲染失败：') + ((e2 && e2.message) || e2) + '</p>';
            }
            // 截断提示（sheetRows 截断后 !ref 末行正好压线）
            var ref = (wb.Sheets[names[cur]] || {})['!ref'] || '';
            var endRow = parseInt(String(ref).split(':').pop().replace(/[^\d]/g, ''), 10) || 0;
            if (endRow >= SHEET_ROWS) {
                var tip = document.createElement('div');
                tip.className = 'drive-viewer-loading';
                tip.textContent = T('仅预览前 {n} 行，请下载查看全部', { n: SHEET_ROWS });
                tab.insertBefore(tip, tab.firstChild);
            }
            if (tabEl) box.replaceChild(tab, tabEl); else box.appendChild(tab);
            tabEl = tab;
            if (window._osbInit) window._osbInit(box);
        }
        if (names.length > 1) {
            var bar = document.createElement('div');
            bar.className = 'ws-xlsx-tabs';
            names.forEach(function (nm, si) {
                var chip = document.createElement('span');
                chip.className = 'ws-xlsx-chip' + (si === 0 ? ' active' : '');
                chip.textContent = nm;
                chip.addEventListener('click', function () {
                    cur = si;
                    for (var i = 0; i < bar.children.length; i++) bar.children[i].classList.toggle('active', i === si);
                    draw();
                });
                bar.appendChild(chip);
            });
            box.appendChild(bar);
        }
        draw();
    }

    // PPT：PptxViewJS Canvas 渲染（翻页工具条；Blob 装载不碰 FileReader）
    function renderPptx(buf, box, T) {
        if (typeof PptxViewJS === 'undefined' || typeof JSZip === 'undefined') {
            hint(box, T('幻灯片组件未加载，无法预览'));
            return;
        }
        var ppt = document.createElement('div');
        ppt.className = 'ws-pptx';
        var bar = document.createElement('div');
        bar.className = 'ws-pptx-bar';
        var prev = document.createElement('button');
        prev.className = 'ws-pptx-btn';
        prev.textContent = T('‹ 上一页');
        var idx = document.createElement('span');
        idx.className = 'ws-pptx-idx';
        idx.textContent = T('加载中…');
        var next = document.createElement('button');
        next.className = 'ws-pptx-btn';
        next.textContent = T('下一页 ›');
        bar.appendChild(prev);
        bar.appendChild(idx);
        bar.appendChild(next);
        var canvas = document.createElement('canvas');
        canvas.className = 'ws-pptx-canvas';
        ppt.appendChild(bar);
        ppt.appendChild(canvas);
        box.appendChild(ppt);
        try {
            var viewer = new PptxViewJS.PPTXViewer({ canvas: canvas });
            var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
            var sync = function () {
                var total = 0, cur = 0;
                try { total = viewer.getSlideCount(); cur = viewer.getCurrentSlideIndex() + 1; } catch (e) { }
                idx.textContent = total ? (cur + ' / ' + total) : '—';
            };
            viewer.on('slideChanged', sync);
            viewer.on('renderComplete', sync);
            viewer.loadFile(blob).then(function () { sync(); return viewer.render(); }).then(sync).catch(function (e) {
                idx.textContent = T('解析失败：') + ((e && e.message) || e);
            });
            prev.addEventListener('click', function () { viewer.previousSlide().then(sync).catch(function () { }); });
            next.addEventListener('click', function () { viewer.nextSlide().then(sync).catch(function () { }); });
        } catch (e) {
            idx.textContent = T('加载失败：') + ((e && e.message) || e);
        }
        if (window._osbInit) window._osbInit(box);
    }

    window.OfficePreview = { kindOf: kindOf, render: render };
})();
