/**
 * image-layer.js —— 移动端页内全屏图片查看层（微信同款：点图不跳页，黑层内查看）
 *
 * 背景：image-viewer.html 是为 PC 无边框窗口设计的独立页面；APP 改为 Capacitor 直启
 * 远程域后，window.open('_blank') 在 WebView 多窗口语义下产生空白窗（表现为点图白屏）。
 * 微信的点图查看本就是页内全屏黑层，而非跳转新页——移动端改为本层实现，彻底绕开跳页。
 *
 * 能力：多图左右滑动翻页（聊天区图片自动收集，顺序=DOM 顺序即时间顺序）、
 *       双击 1:1↔适应、单指拖动平移、双指捏合缩放、下滑关闭、右上角关闭、
 *       Android 返回键/侧滑关闭（mobile.js backButton 首位分支归口）。
 *
 * 隔离：委托仅在 html.m（移动布局）下激活，且在 capture 阶段拦下图片点击
 * （chat.js 的 window.open 跳页 handler 收不到事件）；PC/WEB 端行为零影响。
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var layer, imgEl, infoEl;
    /* 列表与当前索引（查看期间锁定，翻页实时更新 DOM 里的 img.src） */
    var list = [];
    var idx = 0;

    /* ---------- 变换状态：scale/tx/ty 与触摸手势缓存 ---------- */
    var scale = 1, tx = 0, ty = 0;
    var t1 = null, t2 = null;          // 触点缓存（1 指/2 指）
    var startDist = 0, startScale = 1; // 捏合基准
    var mode = '';                     // 'pan' | 'pinch' | 'swipe' | 'close'
    var sx = 0, sy = 0, stx = 0, sty = 0; // 起始触点与起始位移
    var lastTap = 0;                   // 双击判定
    var SWIPE_TURN_PX = 60;            // 横向翻页触发阈值
    var CLOSE_DRAG_PX = 110;           // 下滑关闭触发阈值

    function inMobile() { return root.classList.contains('m'); }

    function ensureDom() {
        if (layer) return;
        layer = document.getElementById('img-layer');
        if (!layer) return;
        imgEl = document.getElementById('img-layer-img');
        infoEl = document.getElementById('img-layer-info');
        bindGestures();
    }

    function applyTransform(anim) {
        imgEl.style.transition = anim ? 'transform 0.2s ease-out' : 'none';
        imgEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }

    function resetView() {
        scale = 1; tx = 0; ty = 0;
        applyTransform(true);
    }

    /* ---------- 打开/关闭 ---------- */
    function open(startUrl) {
        ensureDom();
        if (!layer) return;
        // 图片列表收集：以点击图所在容器为范围（合并转发详情等弹窗内的图只收集弹窗内列表，
        // 聊天图收集消息区列表；顺序=DOM 顺序即时间顺序，与 chat.js openImageViewer 同策略）
        var scope = startUrl.el.closest('.modal-mask') || document.getElementById('message-list') || document;
        list = [];
        var startIdx = 0;
        scope.querySelectorAll('img.chat-image').forEach(function (im) {
            var u = im.getAttribute('src') || '';
            if (!u) return;
            if (im === startUrl.el) startIdx = list.length;
            list.push(u);
        });
        if (!list.length) list = [startUrl.el.getAttribute('src')];
        idx = startIdx;
        show();
    }

    function show() {
        resetView();
        imgEl.src = list[idx];
        infoEl.textContent = list.length > 1 ? (idx + 1) + ' / ' + list.length : '';
        layer.classList.remove('hidden');
        // 图片装载后若为横向大图则适应宽度（CSS max 已兜底，无需额外处理）
    }

    function turn(d) {
        var n = idx + d;
        if (n < 0 || n >= list.length) return;
        idx = n;
        show();
    }

    function isOpen() { return layer && !layer.classList.contains('hidden'); }

    /* 显式列表打开归口（朋友圈九宫格等非聊天 DOM 场景）：列表由调用方给全（该条动态的
     * 全部图片），不走聊天区 DOM 收集——朋友圈卡片散布整个列表，按 document 收集会把
     * 他人动态的图混进翻页序列（微信同款语义=单条动态内翻页） */
    function openList(listArr, startIdx) {
        ensureDom();
        if (!layer || !listArr || !listArr.length) return;
        list = listArr.slice();
        idx = Math.min(Math.max(0, startIdx || 0), list.length - 1);
        show();
    }

    function close() {
        if (!layer) return;
        layer.classList.add('hidden');
        imgEl.src = '';
        resetView();
    }

    /* ---------- 手势绑定 ---------- */
    function bindGestures() {
        // 关闭按钮
        document.getElementById('img-layer-close').addEventListener('click', function (e) {
            e.stopPropagation();
            close();
        });
        imgEl.addEventListener('load', function () { /* 预留：装载后过渡 */ });
        imgEl.addEventListener('dragstart', function (e) { e.preventDefault(); });

        imgEl.addEventListener('touchstart', function (e) {
            if (e.touches.length === 2) {
                t1 = e.touches[0]; t2 = e.touches[1];
                startDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
                startScale = scale;
                mode = 'pinch';
            } else if (e.touches.length === 1) {
                var now = Date.now();
                var t = e.touches[0];
                // 双击（<300ms 二次触点）：1:1 ↔ 适应
                if (now - lastTap < 300) {
                    lastTap = 0;
                    if (scale > 1) { resetView(); }
                    else { scale = 2.5; tx = 0; ty = 0; applyTransform(true); }
                    mode = '';
                    return;
                }
                lastTap = now;
                t1 = t; t2 = null;
                mode = 'swipe';
                sx = t.clientX; sy = t.clientY;
                stx = tx; sty = ty;
            }
        }, { passive: true });

        imgEl.addEventListener('touchmove', function (e) {
            if (mode === 'pinch' && e.touches.length === 2) {
                t1 = e.touches[0]; t2 = e.touches[1];
                var d = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
                scale = Math.min(5, Math.max(0.5, startScale * (d / (startDist || 1))));
                applyTransform(false);
            } else if (mode === 'swipe' && e.touches.length === 1) {
                var t = e.touches[0];
                var dx = t.clientX - sx, dy = t.clientY - sy;
                if (scale > 1.05) {
                    // 放大态：单指平移图片
                    tx = stx + dx; ty = sty + dy;
                    applyTransform(false);
                } else {
                    // 适应态：横向预览翻页 / 纵向预览下滑关闭
                    if (Math.abs(dx) > Math.abs(dy)) {
                        tx = dx; ty = 0;
                    } else if (dy > 0) {
                        tx = 0; ty = dy;
                    } else { tx = 0; ty = 0; }
                    applyTransform(false);
                }
            }
        }, { passive: true });

        imgEl.addEventListener('touchend', function (e) {
            if (mode === 'pinch') {
                if (e.touches.length < 2) { mode = ''; }
                return;
            }
            if (mode === 'swipe' && e.touches.length === 0) {
                var dx = tx - stx, dy = ty - sty;
                if (scale > 1.05) {
                    // 放大态松手：回弹约束（简化：越界回 0）
                    if (Math.abs(tx) < 40) tx = 0;
                    if (Math.abs(ty) < 40) ty = 0;
                    applyTransform(true);
                } else if (Math.abs(dx) > SWIPE_TURN_PX && Math.abs(dx) > Math.abs(dy)) {
                    turn(dx < 0 ? 1 : -1);   // 横向滑=翻页
                } else if (dy > CLOSE_DRAG_PX && Math.abs(dx) < Math.abs(dy)) {
                    close();                  // 下滑=关闭
                } else {
                    resetView();              // 未达阈值回弹
                }
            }
            mode = '';
            t1 = null; t2 = null;
        }, { passive: true });
    }

    /* ---------- 入口委托：capture 阶段拦下移动端图片点击（chat.js 跳页 handler 收不到） ---------- */
    document.addEventListener('click', function (e) {
        if (!inMobile()) return;
        var im = e.target.closest('img.chat-image');
        if (!im) return;
        e.preventDefault();
        e.stopPropagation();
        open({ el: im });
    }, true);

    window.IMImgLayer = { isOpen: isOpen, close: close, openList: openList };
})();