// image-viewer.js - 图片查看器窗口逻辑（阶段三十八·第一期）
// 功能：置顶 / 上一张下一张 / 缩略图列表 / 放大缩小 / 1:1 与适应窗口切换 / 旋转 / 另存为
// 数据来源：PC 端由主进程 viewer:load 推送；Web 浏览器端通过 window.opener 拉取（同源）
(function () {
    var img = document.getElementById('viewerImg');
    var stage = document.getElementById('stage');
    var thumbsEl = document.getElementById('thumbs');
    var infoEl = document.getElementById('ivInfo');

    var list = [];        // 当前会话图片 URL 列表（翻页/缩略图）
    var index = 0;        // 当前显示索引
    var scale = 1;        // 缩放倍率（fit 模式下为相对适应尺寸的倍率）
    var rotation = 0;     // 旋转角度（90° 步进）
    var fit = true;       // true=适应窗口，false=1:1 基准
    var baseFit = 1;      // 适应窗口时图片的自然缩放基准（图片相对容器的适配比例）
    var offsetX = 0, offsetY = 0; // 平移偏移（像素）
    var pinned = false;   // 窗口置顶状态

    function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

    // 应用变换：适应基准 × 缩放 × 平移 × 旋转
    function apply() {
        var s = (fit ? baseFit : 1) * scale;
        img.style.transform = 'translate(' + offsetX + 'px,' + offsetY + 'px) rotate(' + rotation + 'deg) scale(' + s + ')';
    }

    // 计算适应窗口基准：图片自然尺寸与容器可用区域的适配比例
    function calcBaseFit() {
        var availW = stage.clientWidth - 24;
        var availH = stage.clientHeight - 24;
        var w = img.naturalWidth || 1;
        var h = img.naturalHeight || 1;
        // 旋转 90°/270° 时宽高互换再适配
        if (rotation % 180 === 90) { var t = w; w = h; h = t; }
        baseFit = Math.min(availW / w, availH / h, 1);
    }

    function updateInfo() {
        infoEl.textContent = (index + 1) + ' / ' + list.length;
        var ts = thumbsEl.querySelectorAll('.iv-thumb');
        for (var i = 0; i < ts.length; i++) {
            ts[i].className = 'iv-thumb' + (i === index ? ' active' : '');
        }
    }

    function show(i) {
        if (!list.length) return;
        index = (i + list.length) % list.length;
        img.src = list[index];
        scale = 1;
        rotation = 0;
        offsetX = 0;
        offsetY = 0;
        fit = true;
        updateInfo();
    }

    // ===== 阶段三十八：向主窗口请求更早历史图片（翻到列表头部时触发，联动翻页/缩略图） =====
    // PC 端走 desktop IPC（查看器→主进程→主窗口 HISTORY 翻页→主进程回推）；Web 端走 opener 桥直调
    var noMoreOlder = false;  // 已到最早记录（服务端空批后置位，不再重复请求）
    var fetchingOlder = false; // 防重入
    var moreCallback = null;   // 本轮请求的回调槽位（监听器只注册一次，避免累积）

    function fetchOlder() {
        if (fetchingOlder || noMoreOlder) return;
        fetchingOlder = true;
        moreCallback = function (urls) {
            fetchingOlder = false;
            if (!urls || !urls.length) { noMoreOlder = true; return; }
            // 新图片按时间序插到列表头部（去重），当前显示不变（索引右移）
            var added = 0;
            urls.forEach(function (u) {
                if (list.indexOf(u) === -1) {
                    list.unshift(u);
                    added++;
                }
            });
            if (added) {
                index += added;
                renderThumbs();
            } else {
                noMoreOlder = true; // 本批全是已加载过的，视为已到头
            }
        };
        if (window.desktop && window.desktop.viewerNeedMore) {
            window.desktop.viewerNeedMore();
        } else if (window.opener && window.opener.__imageViewerBridge) {
            window.opener.__imageViewerBridge.requestOlder(moreCallback);
        } else {
            moreCallback = null;
            fetchingOlder = false;
            noMoreOlder = true; // 无桥接能力（直接打开的页面）：不联动
        }
    }

    // PC 端：主窗口推送的更早图片批（监听器仅注册一次，经 moreCallback 槽位分发本轮回调）
    if (window.desktop && window.desktop.onViewerMore) {
        window.desktop.onViewerMore(function (urls) {
            if (moreCallback) {
                var cb = moreCallback;
                moreCallback = null;
                cb(urls);
            }
        });
    }

    // 图片加载完成后按当前模式适配（fit=true 重算基准并复位偏移）
    img.addEventListener('load', function () {
        calcBaseFit();
        if (fit) { offsetX = 0; offsetY = 0; }
        apply();
        renderThumbs();
    });

    function renderThumbs() {
        thumbsEl.innerHTML = '';
        list.forEach(function (u, i) {
            var t = document.createElement('img');
            t.className = 'iv-thumb' + (i === index ? ' active' : '');
            t.src = u;
            t.addEventListener('click', function () { show(i); });
            thumbsEl.appendChild(t);
        });
        updateInfo();
    }

    // 缩放：以窗口中心为基准，范围 0.1 ~ 8
    function zoomBy(f) {
        fit = false;
        scale = clamp(scale * f, 0.1, 8);
        apply();
    }

    // ===== 工具栏事件 =====
    document.getElementById('btnPrev').addEventListener('click', function () {
        if (index <= 0) fetchOlder(); // 已到列表头部：向主窗口请求更早历史图片（加载后继续翻）
        show(index - 1);
    });
    document.getElementById('btnNext').addEventListener('click', function () { show(index + 1); });
    document.getElementById('btnZoomIn').addEventListener('click', function () { zoomBy(1.25); });
    document.getElementById('btnZoomOut').addEventListener('click', function () { zoomBy(0.8); });
    document.getElementById('btnRotate').addEventListener('click', function () {
        rotation = (rotation + 90) % 360;
        calcBaseFit();
        apply();
    });
    document.getElementById('btnFit').addEventListener('click', function () {
        fit = true;
        scale = 1;
        offsetX = 0;
        offsetY = 0;
        calcBaseFit();
        apply();
    });
    document.getElementById('btnThumbs').addEventListener('click', function () {
        this.classList.toggle('active');
        thumbsEl.classList.toggle('visible');
    });
    document.getElementById('btnPin').addEventListener('click', function () {
        pinned = !pinned;
        this.classList.toggle('active', pinned);
        // Web 浏览器端无桌面置顶能力，静默忽略（按钮状态仅本地切换）
        if (window.desktop && window.desktop.setViewerAlwaysOnTop) {
            window.desktop.setViewerAlwaysOnTop(pinned);
        }
    });
    document.getElementById('btnSave').addEventListener('click', saveImage);
    document.getElementById('btnClose').addEventListener('click', function () {
        if (window.desktop && window.desktop.closeViewer) {
            window.desktop.closeViewer(); // PC 端隐藏复用窗口
        } else {
            window.close(); // Web 端关闭标签页
        }
    });

    // 另存为：渲染层抓取图片转 dataURL，PC 端由主进程弹原生保存对话框写文件（Web 端走 a[download] 下载）
    function saveImage() {
        if (!img.src) return;
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var dataUrl = canvas.toDataURL('image/png');
        var name = 'img_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png';
        if (window.desktop && window.desktop.saveViewerImage) {
            window.desktop.saveViewerImage({ dataUrl: dataUrl, name: name });
        } else {
            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = name;
            a.click();
        }
    }

    // ===== 阶段一百四十：编辑并发送（复用独立截图编辑器 open 模式，确认后经主窗口既有链路发到当前会话） =====
    // 链路：查看器 fetch 当前图 → blob → 分块 btoa 转 dataURL（禁 FileReader——PptxViewJS 全局污染规避）
    // → desktop.viewerEdit → 主进程复用编辑器窗口（callback=sendFile）；旋转/缩放仅为查看变换，编辑取原图
    // GIF 动图编辑基于 canvas 会丢动画，禁用入口；Web 浏览器端无独立编辑器窗口，按钮隐藏
    var btnEdit = document.getElementById('btnEdit');
    if (!(window.desktop && window.desktop.viewerEdit)) {
        btnEdit.style.display = 'none';
    } else {
        var editBusy = false; // 抓图转码在途防重入
        btnEdit.addEventListener('click', function () {
            if (editBusy || !img.src || !img.naturalWidth) return;
            editBusy = true;
            fetch(list[index], { cache: 'no-store' }).then(function (r) { return r.blob(); }).then(function (blob) {
                if (blob.type === 'image/gif') { editBusy = false; btnEdit.title = 'GIF 动图暂不支持编辑'; return; }
                return blob.arrayBuffer().then(function (buf) {
                    var bytes = new Uint8Array(buf);
                    var bin = '';
                    var CH = 0x8000;
                    for (var i = 0; i < bytes.length; i += CH) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
                    }
                    window.desktop.viewerEdit({ dataUrl: 'data:' + blob.type + ';base64,' + btoa(bin) });
                    editBusy = false;
                });
            }).catch(function () { editBusy = false; });
        });
    }

    // ===== 画布交互：滚轮缩放 / 拖拽平移 / 双击切换适应与 1:1 =====
    stage.addEventListener('wheel', function (e) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    var dragging = false, lastX = 0, lastY = 0;
    stage.addEventListener('mousedown', function (e) {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        stage.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        fit = false; // 平移即脱离适应模式（保留视觉尺寸）
        offsetX += e.clientX - lastX;
        offsetY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        apply();
    });
    window.addEventListener('mouseup', function () {
        dragging = false;
        stage.classList.remove('dragging');
    });
    img.addEventListener('dblclick', function () {
        fit = !fit;
        scale = 1;
        offsetX = 0;
        offsetY = 0;
        if (fit) calcBaseFit();
        apply();
    });

    // ===== 键盘快捷键 =====
    window.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') {
            if (index <= 0) fetchOlder(); // 键盘翻页同款联动
            show(index - 1);
        }
        else if (e.key === 'ArrowRight') show(index + 1);
        else if (e.key === 'Escape') {
            if (window.desktop && window.desktop.closeViewer) window.desktop.closeViewer();
            else window.close();
        }
        else if (e.key === '+' || e.key === '=') zoomBy(1.25);
        else if (e.key === '-') zoomBy(0.8);
        else if (e.key === 'r' || e.key === 'R') { rotation = (rotation + 90) % 360; calcBaseFit(); apply(); }
        else if (e.key === '0') { fit = true; scale = 1; offsetX = 0; offsetY = 0; calcBaseFit(); apply(); }
        else if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveImage(); }
    });

    // ===== 数据加载：PC 端主进程推送 / Web 端 opener 拉取 =====
    function loadData(data) {
        list = (data && data.list && data.list.length) ? data.list : [data.url];
        index = clamp(data.index || 0, 0, list.length - 1);
        // 确保 url 在列表中：不在则插入当前位置（URL 参数与列表收集时序差异兜底）
        if (list.indexOf(data.url) === -1) {
            list.splice(index, 0, data.url);
        }
        show(index);
    }

    if (window.desktop && window.desktop.onViewerLoad) {
        window.desktop.onViewerLoad(loadData);
    } else if (window.opener && window.opener.__imageViewerList) {
        // Web 浏览器端：主页面渲染层收集列表挂到 opener 全局
        var openerList = window.opener.__imageViewerList || [];
        var url = decodeURIComponent((location.search.match(/[?&]url=([^&]+)/) || [])[1] || '');
        var idx = openerList.indexOf(url);
        loadData({ url: url, list: openerList, index: idx });
    }
    // ===== 阶段四十五：缩略图条自绘悬浮滚动条（横向，不占布局空间，无空隙） =====
    // 原生滚动条已隐藏（见 image-viewer.html 阶段四十五样式），此处生成滑块浮层：
    // 悬停浮现（CSS :hover，真实元素无伪元素滞留问题）、随滚动同步、可拖拽
    (function () {
        if (!thumbsEl) return;
        var thumb = document.createElement('div');
        thumb.className = 'osb-thumb';
        thumbsEl.appendChild(thumb);
        // 按横向滚动比例刷新滑块位置与长度（与主窗口纵向滑块逻辑一致）
        function osbUpdate() {
            var sw = thumbsEl.scrollWidth, cw = thumbsEl.clientWidth, sl = thumbsEl.scrollLeft;
            if (sw <= cw + 1) { thumb.style.display = 'none'; return; }
            thumb.style.display = 'block';
            var w = Math.max(30, Math.round(cw * cw / sw)); // 滑块最小 30px，缩略图越多越短
            var maxLeft = cw - w - 2; // 两端各留 2px 边距
            var viewLeft = 2 + Math.round(sl / Math.max(1, sw - cw) * (maxLeft - 2));
            // 关键：滚动容器内绝对定位基于内容坐标系（随内容滚动），必须加上 scrollLeft 才能固定在可视区
            thumb.style.width = w + 'px';
            thumb.style.left = (sl + viewLeft) + 'px';
        }
        thumbsEl.addEventListener('scroll', osbUpdate, { passive: true });
        thumbsEl.addEventListener('load', osbUpdate, true); // 捕获阶段监听缩略图加载完成（宽度变化影响滚动范围）
        if (window.ResizeObserver) new ResizeObserver(osbUpdate).observe(thumbsEl);
        // renderThumbs 重建 innerHTML 会移除滑块节点：监听子节点变化自动补回并刷新
        if (window.MutationObserver) {
            new MutationObserver(function () {
                if (!thumbsEl.contains(thumb)) thumbsEl.appendChild(thumb);
                osbUpdate();
            }).observe(thumbsEl, { childList: true });
        }
        // 滑块拖拽：按位移比例映射回 scrollLeft（比例与 osbUpdate 一致）
        thumb.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var startX = e.clientX, startLeft = thumbsEl.scrollLeft;
            thumb.classList.add('osb-drag');
            function osbMove(ev) {
                var maxLeft = thumbsEl.clientWidth - thumb.offsetWidth - 2;
                var dx = ev.clientX - startX;
                thumbsEl.scrollLeft = startLeft + dx * (thumbsEl.scrollWidth - thumbsEl.clientWidth) / Math.max(1, maxLeft - 2);
            }
            function osbUp() {
                thumb.classList.remove('osb-drag');
                document.removeEventListener('mousemove', osbMove);
                document.removeEventListener('mouseup', osbUp);
            }
            document.addEventListener('mousemove', osbMove);
            document.addEventListener('mouseup', osbUp);
        });
        osbUpdate();
    })();
})();
