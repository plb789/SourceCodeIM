/**
 * app-download.js —— 阶段二百八十二：PC/WEB 手机版下载二维码气泡（微信同款悬停交互）
 *
 * 归口与复用：
 *   1. 入口：左侧栏 nav-bottom 手机图标按钮 #app-download-btn（html.m 下 nav-bottom 整组隐藏，
 *      手机端天然不出现本入口），悬停右侧弹出二维码气泡，移入气泡内保持显示，移开约 300ms 收起；
 *   2. 数据：GET /api/app/version?platform=android 公开只读接口取最新生效版本，首次悬停请求并
 *      缓存；失败/无生效版本不缓存（下次悬停重试），兜底显示"暂未提供手机版下载"不渲染空码；
 *   3. 二维码：复用 qrcode-generator（window.qrcode，qr.js 名片同款渲染口径），内容为
 *      /download.html 落地页完整地址（location.origin 拼接，不硬编码域名/IP——公网/局域网
 *      部署自动匹配 PC 实际连接的服务器地址），落地页再归口 APK 直链，
 *      规避微信等内置浏览器对 APK 直链的拦截；
 *   4. 样式：im-dlqr- 前缀运行时注入（app-update.js 同款做法），颜色全走主题 CSS 变量跟随深浅；
 *   5. 不与全局 tooltip 叠泡：按钮用 aria-label 不用 title（tooltip.js 只接管 title）。
 * 依赖：qrcode.min.js / i18n.js 先于本脚本加载（index.html 引入顺序归口）。
 */
(function () {
    'use strict';

    var btn = document.getElementById('app-download-btn');
    if (!btn) return;

    var pop = null;        // 气泡根节点（惰性创建）
    var qrBox = null;      // 二维码容器（空态/加载态/二维码三态复用）
    var metaEl = null;     // 版本信息行
    var hideTimer = null;  // 移出延迟收起计时
    var info = null;       // 版本信息缓存 {version_name, size, url}（null=未取到，可重试）
    var fetching = false;  // 请求进行中（防悬停连击并发）

    var HIDE_DELAY = 300;  // 移出后延迟收起（ms），期间移入气泡则取消收起

    /* ---------- 1. 样式（运行时注入，变量缺失回退浅色兜底） ---------- */
    function ensureStyle() {
        if (document.getElementById('im-dlqr-style')) return;
        var css = [
            '.im-dlqr-pop{position:fixed;z-index:3400;background:var(--panel-bg,#fff);',
            'border:1px solid var(--border,#e0e0e0);border-radius:12px;padding:14px 16px 12px;',
            'box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;align-items:center;gap:8px;',
            'opacity:0;transform:translateX(-6px);transition:opacity .16s ease,transform .16s ease;',
            'pointer-events:none;user-select:none;}',
            '.im-dlqr-pop.show{opacity:1;transform:translateX(0);pointer-events:auto;}',
            /* 二维码底强制白底：深色主题下微信同款白码块，保证扫码对比度 */
            '.im-dlqr-qr{width:172px;height:172px;background:#fff;border-radius:8px;',
            'display:flex;align-items:center;justify-content:center;overflow:hidden;}',
            '.im-dlqr-qr img{display:block;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;}',
            '.im-dlqr-loading,.im-dlqr-empty{width:160px;height:160px;display:flex;align-items:center;',
            'justify-content:center;text-align:center;padding:0 10px;font-size:12px;line-height:1.6;',
            'color:var(--text-secondary,#999);background:var(--hover,#d9d9d9);border-radius:8px;}',
            '.im-dlqr-meta{font-size:12px;color:var(--text,#333);}',
            '.im-dlqr-tip{font-size:12px;color:var(--text-secondary,#999);}'
        ].join('\n');
        var st = document.createElement('style');
        st.id = 'im-dlqr-style';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function fmtSize(n) {
        n = +n || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }

    /* ---------- 2. 气泡 DOM（惰性创建一次） ---------- */
    function buildPop() {
        if (pop) return;
        ensureStyle();
        pop = document.createElement('div');
        pop.className = 'im-dlqr-pop';
        pop.innerHTML =
            '<div class="im-dlqr-qr"></div>' +
            '<div class="im-dlqr-meta"></div>' +
            '<div class="im-dlqr-tip">' + esc(I18N.t('手机浏览器扫码，下载手机版')) + '</div>';
        document.body.appendChild(pop);
        qrBox = pop.querySelector('.im-dlqr-qr');
        metaEl = pop.querySelector('.im-dlqr-meta');
        // 悬停进入气泡内不收起（用户对准扫码期间保持显示），移出才走延迟收起
        pop.addEventListener('mouseenter', cancelHide);
        pop.addEventListener('mouseleave', scheduleHide);
    }

    /* ---------- 3. 内容三态 ---------- */
    // 已显示状态下重渲染内容后须重新定位：版本行有/无文字会改变气泡高度，
    // 首悬停"先定位后取数"存在竞态（不重定位会向下越出视口）
    function rerender(fn) {
        fn();
        if (pop && pop.classList.contains('show')) place();
    }

    function renderLoading() {
        qrBox.innerHTML = '<div class="im-dlqr-loading">' + esc(I18N.t('正在获取…')) + '</div>';
        metaEl.textContent = '';
    }

    function renderEmpty() {
        qrBox.innerHTML = '<div class="im-dlqr-empty">' + esc(I18N.t('暂未提供手机版下载')) + '</div>';
        metaEl.textContent = '';
    }

    function renderInfo() {
        if (!info) return;
        qrBox.innerHTML = '';
        if (typeof window.qrcode === 'function') {
            var qr = window.qrcode(0, 'M');
            qr.addData(location.origin + '/download.html');
            qr.make();
            // createImgTag 返回 HTML 字符串（qr.js 同款口径）；尺寸由 CSS 收口到码框内
            qrBox.innerHTML = qr.createImgTag(5, 2);
        }
        metaEl.textContent = 'v' + info.version_name + (info.size ? ' · ' + fmtSize(info.size) : '');
    }

    /* ---------- 4. 版本数据（首悬停请求，成功缓存失败可重试） ---------- */
    function loadInfo() {
        if (info || fetching) return;
        fetching = true;
        renderLoading();
        fetch('/api/app/version?platform=android&code=0&name=', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                fetching = false;
                // 响应经 adminJSON 包装为 {ok, data:{...}}（与 /api/share/client-dl 同款结构），
                // 兼容旧版/未来平铺返回取 data 兜底；生效版本存在时 data 始终带 version_name/url
                var d = j && (j.data || j);
                if (d && d.version_name && d.url) {
                    info = d;
                    rerender(renderInfo);
                } else {
                    rerender(renderEmpty);
                }
            })
            .catch(function () {
                fetching = false;
                rerender(renderEmpty);
            });
    }

    /* ---------- 5. 显隐与定位（按钮右侧弹出，放不下翻左侧，越界夹回视口） ---------- */
    function place() {
        var r = btn.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        pop.classList.add('show'); // 先展开再量尺寸，display 不切换避免过渡丢失
        var pw = pop.offsetWidth, ph = pop.offsetHeight;
        var vw = window.innerWidth, vh = window.innerHeight;
        var left = r.right + 10;
        if (left + pw > vw - 8) left = r.left - 10 - pw;
        var top = Math.round(r.top + r.height / 2 - ph / 2);
        top = Math.max(8, Math.min(top, vh - ph - 8));
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = top + 'px';
        pop.style.visibility = '';
    }

    function showPop() {
        cancelHide();
        buildPop();
        if (!info) loadInfo();          // 首次/上次失败：发起请求（回调内按当前显示态渲染）
        else if (!qrBox.querySelector('img')) renderInfo(); // 缓存命中且码未画：补画
        place();
    }

    function cancelHide() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function scheduleHide() {
        cancelHide();
        hideTimer = setTimeout(hidePop, HIDE_DELAY);
    }

    function hidePop() {
        cancelHide();
        if (pop) pop.classList.remove('show');
    }

    /* ---------- 6. 事件接线 ---------- */
    btn.addEventListener('mouseenter', showPop);
    btn.addEventListener('mouseleave', scheduleHide);
    // 气泡显示期间点击外部区域立即收起（捕获阶段，先于全局 tooltip/其他 mousedown 消费）
    document.addEventListener('mousedown', function (e) {
        if (!pop || !pop.classList.contains('show')) return;
        if (pop.contains(e.target) || btn.contains(e.target)) return;
        hidePop();
    }, true);
    window.addEventListener('resize', hidePop); // 定位基准失效直接收起，最简且不闪错位
})();
