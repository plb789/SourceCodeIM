/* 阶段七十八：全局自绘 tooltip——接管全站原生 title 属性提示（含 JS 动态生成的元素）。
   原理：事件委托监听 mouseover，找到悬停目标上最近的 [title]（或历史记录 data-tip-text），
   首次悬停即把 title 文案摘存到 data-tip-text 并移除 title 属性——浏览器原生气泡约 1-2s 延迟渲染，
   摘除后从根源上永远无法出现；自绘气泡悬停约 250ms 后在目标下方（下方放不下自动翻转到上方）
   淡入展开：圆角 + 指向三角 + 主题反色（--text 做底/--panel-bg 做字，深浅主题自动跟随）。
   引入方式：页面 </body> 前加 <script src="js/tooltip.js?v=1.0"></script>，零依赖、无配套 CSS
   （样式运行时注入，变量缺失时回退固定深色），主端/后台/图片查看器页均已引入 */
(function () {
    'use strict';
    if (window.__imTooltip) return; // 防重复引入
    window.__imTooltip = true;

    var DELAY_SHOW = 250; // 悬停延时 ms：接近原生手感，快速划过不闪泡
    var GAP = 8;          // 气泡与目标间距
    var EDGE = 8;         // 气泡距视口边缘最小留白

    var tipEl = null, arrowEl = null, textEl = null;
    var pendingTimer = null, curTarget = null;

    function ensureEl() {
        if (tipEl) return;
        tipEl = document.createElement('div');
        tipEl.className = 'global-tip';
        tipEl.setAttribute('role', 'tooltip');
        arrowEl = document.createElement('i');
        arrowEl.className = 'global-tip-arrow';
        textEl = document.createElement('span');
        tipEl.appendChild(arrowEl);
        tipEl.appendChild(textEl);
        document.body.appendChild(tipEl);
        // 样式运行时注入：三角用与气泡同色的旋转方块（下半融进气泡、上半露出形成指向），
        // 无 z-index 负值技巧（transform 父级会创建堆叠上下文导致负 z 子级被底色盖住）
        var st = document.createElement('style');
        st.textContent =
            '.global-tip{position:fixed;z-index:99999;max-width:320px;padding:6px 10px;border-radius:8px;' +
            'background:var(--text,#333);color:var(--panel-bg,#fff);font-size:11px;line-height:1.5;' +
            'white-space:pre-line;word-break:break-all;box-shadow:0 4px 14px rgba(0,0,0,.18);' +
            'opacity:0;transform:translateY(-3px);transition:opacity .16s ease,transform .16s ease;' +
            'pointer-events:none;user-select:none;}' +
            '.global-tip.show{opacity:1;transform:translateY(0);}' +
            '.global-tip-arrow{position:absolute;width:8px;height:8px;background:inherit;' +
            'transform:rotate(45deg);}' +
            '.global-tip:not(.above) .global-tip-arrow{top:-4px;}' + // 气泡在下方：三角朝上
            '.global-tip.above .global-tip-arrow{top:auto;bottom:-4px;}'; // 气泡在上方：三角朝下
        document.head.appendChild(st);
    }

    // 向上找最近的提示目标（title 或已摘存的数据属性），跨子元素冒泡不丢目标
    function findTarget(el) {
        while (el && el.nodeType === 1 && el !== document.documentElement) {
            if (el.hasAttribute('title') || el.hasAttribute('data-tip-text')) return el;
            el = el.parentElement;
        }
        return null;
    }

    // 取文案并把 title 摘存为 data-tip-text（永不还原，防原生气泡叠出）
    function takeText(el) {
        var t = el.getAttribute('data-tip-text');
        if (t != null) return t;
        t = el.getAttribute('title');
        if (t == null) return '';
        el.removeAttribute('title');
        if (!t.trim()) return '';
        el.setAttribute('data-tip-text', t);
        return t;
    }

    function place(target) {
        var r = target.getBoundingClientRect();
        var tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
        var vh = window.innerHeight, vw = window.innerWidth;
        var below = r.bottom + GAP + th + EDGE <= vh; // 下方放不下整泡则翻转到上方
        var top = below ? r.bottom + GAP : r.top - GAP - th;
        var left = r.left + r.width / 2 - tw / 2;
        left = Math.max(EDGE, Math.min(left, vw - tw - EDGE));
        tipEl.classList.toggle('above', !below);
        tipEl.style.top = Math.round(top) + 'px';
        tipEl.style.left = Math.round(left) + 'px';
        // 三角水平对准目标中心（夹在气泡内避开圆角穿帮）
        var cx = r.left + r.width / 2 - left;
        cx = Math.max(14, Math.min(cx, tw - 14));
        arrowEl.style.left = Math.round(cx - 4) + 'px';
    }

    function show(target) {
        var t = takeText(target);
        if (!t) return;
        ensureEl();
        textEl.textContent = t;
        place(target); // 先定位再显示，避免气泡从 0,0 闪入
        tipEl.classList.add('show');
    }

    function hide() {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        curTarget = null;
        if (tipEl) tipEl.classList.remove('show');
    }

    document.addEventListener('mouseover', function (e) {
        var el = findTarget(e.target);
        if (el === curTarget) return; // 同一目标内子元素间移动不重置计时
        hide();
        if (!el) return;
        curTarget = el;
        pendingTimer = setTimeout(function () { show(el); }, DELAY_SHOW);
    });

    document.addEventListener('mouseout', function (e) {
        if (!curTarget) return;
        var rel = e.relatedTarget;
        if (rel && curTarget.contains(rel)) return; // 仍在本目标的子元素内
        hide();
    });

    // 点击/滚动/窗口失焦即收起（定位已失真或操作已发生，继续展示没有意义）
    document.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
})();
