// game-store.js - 游戏中心（Steam 同款 P1·商店页）窗口逻辑
// 双环境运行：
//   1) Electron PC 独立窗口：window.desktop 桥存在（desktop.gameOpenWindow 可甄别），
//      支持下载（开始/暂停/继续/取消）、启动游戏、选择安装目录与主程序 exe；
//   2) 普通浏览器（Web 端）：只读浏览商店与详情，不出现下载/启动按钮，提示"请在 PC 客户端中下载安装"。
// 主题跟随主界面（localStorage im_theme：dark/light，默认 dark，由页面 head 内联脚本先行设置），
// 全部颜色引用 style.css 现有主题变量；滚动条复用全站自绘悬浮滑块（.osb-thumb），全页无系统默认滚动条；
// 确认/提示一律走自绘弹窗与 Toast，禁止 alert/confirm/prompt。
(function () {
    'use strict';

    // ==================== 环境与登录信息 ====================
    var DESKTOP = window.desktop || null;                    // Electron 桥（浏览器环境为 null → 只读模式）
    var IN_ELECTRON = !!(DESKTOP && DESKTOP.gameOpenWindow); // gameOpenWindow 存在即代表在 Electron 中

    // im_auth 与 chat.js 同款编码：btoa(encodeURIComponent(JSON.stringify({u,p})))，此处反向解码
    function getAuth() {
        try { return JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || null; }
        catch (e) { return null; }
    }
    var username = (function () { var a = getAuth(); return (a && a.u) || ''; })();

    // ==================== 常量 ====================
    var PAGE_SIZE = 24;                                                              // 商店分页大小
    var LIB_STATE_TEXT = { 0: '未安装', 1: '下载中', 2: '已暂停', 3: '已安装', 4: '待更新' }; // 库状态文案
    var BADGE_TEXT = { 0: '已入库', 1: '下载中', 2: '已暂停', 3: '已安装', 4: '待更新' };     // 商店卡片徽标文案
    var TASK_STATE_TEXT = { downloading: '下载中', paused: '已暂停', verifying: '校验中', done: '已完成', error: '出错' };

    // ==================== 运行时状态 ====================
    var state = {
        tab: 'store',      // 当前页签：store | library | downloads（详情视图不占页签，归属商店）
        detailId: 0,       // 当前详情游戏 id（0=非详情视图）
        cfg: { layout: 'steam', sections: { carousel: true, featured: true, tagbar: true }, featured_games: [] },
        // ^ 商店布局配置（GET /api/game/config 下发；初始值=Steam 布局默认，拉取成功后覆盖）
        store: { list: [], page: 0, total: 0, keyword: '', tag: '', loading: false },
        allTags: [], // 首页全量标签缓存（筛选态下标签条仍用全量渲染）
        games: {},         // gameId → 游戏数据（商店列表项/详情数据归口，徽标渲染取 in_library）
        lib: {},           // gameId → { lib:{state,installed_version,install_path,play_seconds,...}, game:{...} }
        tasks: {},         // taskId → 下载任务 {taskId,gameId,name,version,installDir,prevInstalled,received,total,speed,state,fileRelPath,error}
        taskByGame: {},    // gameId → 进行中的 taskId（详情/库按钮态联动）
        sessions: {},      // gameId → 本次启动时间戳（onGameExit 结算游玩时长）
        running: {},       // gameId → 运行中（Steam 同款）：进程已启动未退出，侧栏行/启动按钮显示"运行中"
        saveSync: {},      // gameId → 'push'|'pull' 云存档同步中（Steam 同款）：侧栏行显示"存档中/读档中"
        badgeEls: {},      // gameId → 商店卡片徽标元素（进度事件原地刷新徽标，避免整格重绘闪烁）
        balance: null,     // 当前用户积分余额（GET /api/game/points；获取/退库随响应实时刷新）
        libSel: 0,         // 库页签当前选中游戏 id（0=未选中，右侧显示最近游戏横排）
        libFeed: {},       // gameId → 库内页动态数据（公告+版本，详情接口懒加载缓存）
        reviews: { gid: 0, list: [], page: 0, has_more: false, total: 0, positive: 0,
            summary: '', type: 'all', mine: null, // 详情页评测区状态（Steam 同款，每页 10 条）
            recent: [], recent_gid: 0 } // 右栏"最近发布"小卡流（sort=latest 一次性加载，不随筛选/分页变）
    };

    // ==================== 基础工具 ====================
    function $(id) { return document.getElementById(id); }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    // 价格内容统一填充：数字价前加 ⚡ 积分图标（与主界面顶栏 GC 余额图标同源，Steam 价格符号同位），
    // 免费走原文案不带图标；box 为价格容器（按钮/胶囊/价格行均可），样式类由调用方决定
    function fillPrice(box, g, freeTxt) {
        if ((Number(g.price) || 0) > 0) {
            box.appendChild(el('span', 'gs-price-ico', '⚡'));
            box.appendChild(el('span', '', fmtPoints(g.price)));
        } else {
            box.appendChild(el('span', '', freeTxt));
        }
        return box;
    }

    // 静态资源地址归一：相对路径补同源 origin（Electron/浏览器双环境可用）
    function assetUrl(p) {
        if (!p) return '';
        if (/^(https?:|data:|blob:)/i.test(p)) return p;
        return location.origin + (p.charAt(0) === '/' ? '' : '/') + p;
    }

    // API 封装：同源 + username 查询参数鉴权；响应 {ok:true,data}/{ok:false,msg}
    function api(method, path, body) {
        var sep = path.indexOf('?') >= 0 ? '&' : '?';
        var url = location.origin + path + sep + 'username=' + encodeURIComponent(username);
        var opts = { method: method || 'GET' };
        if (body !== undefined) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(body);
        }
        return fetch(url, opts)
            .then(function (r) { return r.json(); })
            .catch(function () { return { ok: false, msg: '网络异常，请稍后重试' }; });
    }

    // ===== 人性化格式化 =====
    function p2(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtSize(n) {
        if (!n || n <= 0) return '—';
        if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return Math.max(1, Math.round(n / 1024)) + ' KB';
    }

    function fmtSpeed(n) { return n > 0 ? fmtSize(n) + '/s' : '—'; }

    function fmtEta(sec) {
        if (!isFinite(sec) || sec <= 0) return '—';
        if (sec >= 3600) return Math.floor(sec / 3600) + '时' + Math.round(sec % 3600 / 60) + '分';
        if (sec >= 60) return Math.ceil(sec / 60) + '分钟';
        return Math.ceil(sec) + '秒';
    }

    function fmtPlay(sec) {
        if (!sec || sec <= 0) return '—';
        var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
        if (h) return h + '小时' + m + '分钟';
        if (m) return m + '分钟';
        return '不足1分钟';
    }

    function fmtDate(t) {
        if (!t) return '—';
        var ms = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(t);
        if (isNaN(ms)) return String(t);
        var d = new Date(ms);
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    }

    function fmtCount(n) {
        if (!n || n <= 0) return '0';
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return String(n);
    }

    // 积分显示归一：3 位小数去尾零（30.000→30、0.500→0.5），与 AI 积分精度一致
    function fmtPoints(v) {
        var s = Number(v || 0).toFixed(3);
        if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s || '0';
    }

    // 头像缺省首字母（评测卡用）
    function initialOf(name) { return String(name || '用').charAt(0).toUpperCase(); }

    // 评测"总时数"文案：服务端 play_hours 是评测撰写/编辑时刻的时长快照（秒→小时保留 2 位）；
    // ≥1 小时显示 1 位小数，不足 1 小时（含评测时还没玩过的 0）统一显示"不足 1 小时"——任何评测都带时长行
    function fmtRevHours(h) {
        var v = Number(h) || 0;
        if (v < 1) return '不足 1 小时';
        return v.toFixed(1) + ' 小时';
    }

    // 游戏名散列出 0-359 色相：无封面占位色块 hue-rotate 变色（底色仍取主题色变量）
    function hashHue(name) {
        var h = 0, s = String(name || '?');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return h % 360;
    }

    function buildPh(name) {
        var ph = el('div', 'gs-cover-ph');
        ph.style.filter = 'hue-rotate(' + hashHue(name) + 'deg)';
        ph.appendChild(el('b', '', String(name || '?').charAt(0).toUpperCase()));
        return ph;
    }

    // ==================== 自绘 Toast / 确认弹窗 ====================
    var toastEl = $('gsToast');
    var toastTimer = null;

    function toast(text) {
        toastEl.textContent = text;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 2500);
    }

    var modalMask = $('gsModalMask');
    var modalOkCb = null;

    // 自绘确认弹窗：title/text/okText/onOk；danger=true 时确定按钮描边强调（主题变量内实现，无系统弹窗）
    function showConfirm(title, text, okText, onOk, danger) {
        $('gsModalTitle').textContent = title;
        $('gsModalText').textContent = text;
        var ok = $('gsModalOk');
        ok.textContent = okText || '确定';
        ok.classList.toggle('danger', !!danger);
        ok.classList.toggle('primary', !danger);
        modalOkCb = onOk;
        modalMask.classList.remove('hidden');
    }

    function closeModal() {
        modalMask.classList.add('hidden');
        modalOkCb = null;
    }

    $('gsModalOk').addEventListener('click', function () {
        var cb = modalOkCb;
        closeModal();
        if (cb) cb();
    });
    $('gsModalCancel').addEventListener('click', closeModal);
    // 点击遮罩不关闭（与主窗口一致，防误触丢失确认）

    // ==================== 自绘悬浮滚动条（复用 style.css .osb-thumb 样式，仿主窗口 initOsb 精简版） ====================
    // 滑块挂 body 上（position:fixed 浮层），悬停宿主容器浮现、可拖拽；原生滚动条已被 style.css 全局归零
    function bindOsbCommon(el, thumb, update, startDrag) {
        el._osbUpdate = update; // 供浮现/渲染后强制重定位
        el.addEventListener('scroll', function () {
            if (!el._osbRaf) {
                el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; update(); });
            }
        }, { passive: true });
        if (window.ResizeObserver) new ResizeObserver(function () { update(); }).observe(el);
        el.addEventListener('click', function () { update(); }, true);
        // 捕获阶段监听内部图片加载完成（高度变化影响滚动范围）
        el.addEventListener('load', function () { update(); }, true);
        thumb.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            startDrag(e);
        });
        update();
    }

    function osbInit(el) { // 纵向
        if (el._osb) return;
        el._osb = true;
        var thumb = document.createElement('div');
        thumb.className = 'osb-thumb';
        document.body.appendChild(thumb);
        thumb._osbHost = el;
        el._osbThumb = thumb;

        function update() {
            var sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop;
            if (sh <= ch + 1 || ch === 0) { thumb.style.display = 'none'; return; }
            var rect = el.getBoundingClientRect();
            if (rect.height === 0) { thumb.style.display = 'none'; return; }
            thumb.style.display = 'block';
            var h = Math.max(30, Math.round(ch * ch / sh)); // 滑块最小 30px，内容越多越短
            if (h > ch - 4) h = Math.max(12, ch - 4);
            var maxTop = ch - h - 2; // 上下各留 2px 边距
            var top = 2 + Math.round(st / Math.max(1, sh - ch) * (maxTop - 2));
            thumb.style.height = h + 'px';
            thumb.style.top = Math.round(rect.top + top) + 'px';
            thumb.style.left = Math.round(rect.right - 8) + 'px'; // 右侧 2px 边距（宽 6px）
        }

        bindOsbCommon(el, thumb, update, function (e) {
            e.preventDefault();
            thumb.classList.add('osb-drag');
            var startY = e.clientY, startTop = el.scrollTop;
            function move(ev) {
                var maxTop = el.clientHeight - thumb.offsetHeight - 2;
                el.scrollTop = startTop + (ev.clientY - startY) * (el.scrollHeight - el.clientHeight) / Math.max(1, maxTop - 2);
            }
            function up() {
                thumb.classList.remove('osb-drag');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            }
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            update();
        });
    }

    function osbInitH(el) { // 横向（截图横滚条用）：滑块贴容器底边
        if (el._osbH) return;
        el._osbH = true;
        el._osb = true;
        var thumb = document.createElement('div');
        thumb.className = 'osb-thumb osb-h';
        document.body.appendChild(thumb);
        thumb._osbHost = el;
        el._osbThumbH = thumb;
        if (!el._osbThumb) el._osbThumb = thumb;

        function update() {
            var sw = el.scrollWidth, cw = el.clientWidth, sl = el.scrollLeft;
            if (sw <= cw + 1 || cw === 0) { thumb.style.display = 'none'; return; }
            var rect = el.getBoundingClientRect();
            if (rect.width === 0) { thumb.style.display = 'none'; return; }
            thumb.style.display = 'block';
            var w = Math.max(30, Math.round(cw * cw / sw));
            var maxLeft = cw - w - 2;
            var left = 2 + Math.round(sl / Math.max(1, sw - cw) * (maxLeft - 2));
            thumb.style.width = w + 'px';
            thumb.style.left = Math.round(rect.left + left) + 'px';
            thumb.style.top = Math.round(rect.bottom - 8) + 'px'; // 底部 2px 边距（高 6px）
        }

        bindOsbCommon(el, thumb, update, function (e) {
            e.preventDefault();
            thumb.classList.add('osb-drag');
            var startX = e.clientX, startLeft = el.scrollLeft;
            function move(ev) {
                var maxLeft = el.clientWidth - thumb.offsetWidth - 2;
                el.scrollLeft = startLeft + (ev.clientX - startX) * (el.scrollWidth - el.clientWidth) / Math.max(1, maxLeft - 2);
            }
            function up() {
                thumb.classList.remove('osb-drag');
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            }
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            update();
        });
    }

    // 渲染后刷新滑块（内容增删/图片加载布局收敛期间多帧复查）
    function osbTick(el, ms) {
        if (!el || !(el._osbUpdate)) return;
        if (el._osbTicking) return;
        el._osbTicking = true;
        var t0 = Date.now(), n = 0;
        (function tick() {
            n++;
            if (el._osbUpdate) el._osbUpdate();
            if (el._osbUpdateH) el._osbUpdateH();
            if (Date.now() - t0 < (ms || 600) && n < 90) requestAnimationFrame(tick);
            else el._osbTicking = false;
        })();
    }

    // 重渲染前销毁旧滑块（滑块挂 body，容器 innerHTML 重建后会变孤儿）
    function destroyOsb(el) {
        if (!el) return;
        if (el._osbThumb) { el._osbThumb.remove(); el._osbThumb = null; }
        if (el._osbThumbH) { el._osbThumbH.remove(); el._osbThumbH = null; }
        el._osb = false;
        el._osbH = false;
        el._osbUpdate = null;
    }

    // ==================== Steam 同款骨架屏 + 无限滚动/分批渲染归口 ====================
    // 骨架块工厂：sk(cls, w, h)——cls 为变体类（.sk 基类自带 shimmer 扫光动画）
    function sk(cls, w, h) {
        var d = el('div', 'sk' + (cls ? ' ' + cls : ''));
        if (w) d.style.width = w;
        if (h) d.style.height = h;
        return d;
    }

    // 无限滚动 IO 归口：观察 box 元素，进入视口（root=scrollEl，400px 预加载余量）触发 onHit；
    // onHit 内自行防重入（loading 标记）与终止判断（has_more），返回句柄 detach() 供容器重建前解绑
    function attachInf(scrollEl, box, onHit) {
        if (box._infIO) box._infIO.disconnect();
        var io = new IntersectionObserver(function (ents) {
            for (var i = 0; i < ents.length; i++) {
                if (ents[i].isIntersecting) { onHit(); break; }
            }
        }, { root: scrollEl, rootMargin: '400px 0px' });
        io.observe(box);
        box._infIO = io;
        return function () { io.disconnect(); box._infIO = null; };
    }

    // 无限滚动底部容器内容：loading=true 显示主题绿 spinner 加载圈，否则显示灰字提示
    function fillInfBox(box, loading, text) {
        if (!box) return;
        box.innerHTML = '';
        box.classList.toggle('hidden', !loading && !text);
        if (loading) {
            box.appendChild(el('div', 'sk-spin'));
            box.appendChild(el('span', '', text || '加载中…'));
        } else if (text) {
            box.appendChild(el('span', '', text));
        }
    }

    // 分批渲染归口（万级列表防卡顿核心）：items 全量持有（本地搜索过滤不受影响），
    // DOM 每批 batch 条经 rAF 让出主线程构建，批间由 IO 驱动——sentinel 挂容器末尾，
    // 滚动接近底部（root=scrollEl，400px 预载）自动续批，填满视口即停不白耗；
    // 容器 innerHTML 重建后必须调 reset() 重挂 sentinel
    function mkPager(container, scrollEl, buildFn, batch) {
        var p = { items: [], cursor: 0, io: null, sentinel: null };
        function stop() {
            if (p.io) { p.io.disconnect(); p.io = null; }
            if (p.sentinel) { p.sentinel.remove(); p.sentinel = null; }
        }
        function step() {
            if (p.cursor >= p.items.length || !container.isConnected) { stop(); return; }
            var end = Math.min(p.cursor + batch, p.items.length);
            var frag = document.createDocumentFragment();
            for (var i = p.cursor; i < end; i++) frag.appendChild(buildFn(p.items[i]));
            p.cursor = end;
            container.insertBefore(frag, p.sentinel);
            osbTick(scrollEl);
        }
        p.reset = function (items) {
            stop();
            p.items = items || [];
            p.cursor = 0;
            if (!p.items.length) return;
            p.sentinel = document.createElement('div');
            p.sentinel.style.height = '1px';
            container.appendChild(p.sentinel);
            p.io = new IntersectionObserver(function (ents) {
                for (var i = 0; i < ents.length; i++) {
                    if (ents[i].isIntersecting && p.cursor < p.items.length) requestAnimationFrame(step);
                }
            }, { root: scrollEl, rootMargin: '400px 0px' });
            p.io.observe(p.sentinel);
            requestAnimationFrame(step); // 首批立即渲染
        };
        return p;
    }

    // 悬停显隐联动：事件委托找最近 .gs-scroll 宿主，滑块随宿主悬停浮现（延迟 180ms 防闪烁）
    var sbLast = null;
    function sbFind(t) { return t && t.closest ? t.closest('.gs-scroll') : null; }
    function sbShow(el) {
        el.classList.add('sb-hover');
        if (el._osbThumb) el._osbThumb.classList.add('sb-show');
        if (el._osbThumbH) el._osbThumbH.classList.add('sb-show');
        if (el._osbUpdate) el._osbUpdate();
        if (el._osbUpdateH) el._osbUpdateH();
    }
    function sbHideLater(el) {
        clearTimeout(el._osbHideT);
        el._osbHideT = setTimeout(function () {
            if (!el.matches(':hover') && !(el._osbThumb && el._osbThumb.matches(':hover'))) {
                el.classList.remove('sb-hover');
                if (el._osbThumb) el._osbThumb.classList.remove('sb-show');
                if (el._osbThumbH) el._osbThumbH.classList.remove('sb-show');
            }
        }, 180);
    }
    document.addEventListener('mouseover', function (e) {
        var host = sbFind(e.target);
        if (host === sbLast) { if (host) clearTimeout(host._osbHideT); return; }
        if (sbLast) sbHideLater(sbLast);
        sbLast = host;
        if (sbLast) { clearTimeout(sbLast._osbHideT); sbShow(sbLast); }
    });
    document.addEventListener('mouseout', function (e) {
        if (!sbLast) return;
        if (!sbLast.contains(e.relatedTarget) && !(e.relatedTarget && e.relatedTarget._osbHost === sbLast)) {
            sbHideLater(sbLast);
        }
    });
    document.addEventListener('mousemove', function () {
        if (!sbLast || !sbLast._osbThumb || !sbLast._osbThumb.classList.contains('sb-show')) return;
        if (sbLast._osbUpdate) sbLast._osbUpdate();
        if (sbLast._osbUpdateH) sbLast._osbUpdateH();
    }, { passive: true });

    // ==================== 视图切换 ====================
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function showView(name) {
        ['store', 'library', 'downloads', 'detail'].forEach(function (v) {
            $('gsView' + cap(v)).classList.toggle('hidden', v !== name);
        });
        // 导航高亮：详情归属商店页签
        var tab = name === 'detail' ? 'store' : name;
        ['store', 'library', 'downloads'].forEach(function (t) {
            $('gsNav' + cap(t)).classList.toggle('active', t === tab);
        });
        state.tab = tab;
        // 离开详情视图时暂停页面内视频（display:none 不会自动暂停，防后台续播出声）
        if (name !== 'detail') {
            var sv = $('gsDetailScroll').querySelectorAll('video');
            for (var k = 0; k < sv.length; k++) { try { sv[k].pause(); } catch (e) { /* 忽略 */ } }
        }
        // 切换后刷新对应滚动容器的悬浮滑块（视图显隐导致尺寸变化）
        var scrollId = name === 'detail' ? 'gsDetailScroll'
            : (name === 'store' ? 'gsStoreScroll'
                : (name === 'library' ? 'gsLibMain' : 'gsDlList'));
        osbTick($(scrollId), 400);
        // 库页吸顶条/返回顶部：离开库视图即隐藏；进入时显隐校准（display 后滚动状态可能已变）
        if (name === 'library') {
            setTimeout(function () { if (typeof libBarUpdate === 'function') libBarUpdate(); }, 60);
        } else {
            libBarHide();
        }
    }

    function closeDetail() {
        if (!state.detailId) return;
        state.detailId = 0;
        showView(state.tab);
    }

    // ==================== 商店页签 ====================
    // 商店首屏骨架（Steam 同款灰块扫光）：首次进入网格尚空时渲染 12 张卡骨架，
    // 数据到达 renderStore 全量重建覆盖；追加页不重放骨架
    function renderStoreSkeleton() {
        var grid = $('gsStoreGrid');
        grid.innerHTML = '';
        for (var i = 0; i < 12; i++) {
            var c = el('div', 'gs-card gs-card-skel');
            c.appendChild(sk('sk-pic'));
            c.appendChild(sk('sk-line'));
            c.appendChild(sk('sk-line sm'));
            grid.appendChild(c);
        }
    }

    function loadStore(reset) {
        if (state.store.loading) return;
        state.store.loading = true;
        if (reset) {
            state.store.rendered = 0;
            if (!$('gsStoreGrid').children.length) renderStoreSkeleton(); // 首屏骨架（数据到达即覆盖）
        }
        updateStoreInf();
        var page = reset ? 1 : state.store.page + 1;
        var path = '/api/game/list?page=' + page + '&size=' + PAGE_SIZE +
            (state.store.keyword ? '&keyword=' + encodeURIComponent(state.store.keyword) : '') +
            (state.store.tag ? '&tag=' + encodeURIComponent(state.store.tag) : '');
        api('GET', path).then(function (res) {
            state.store.loading = false;
            if (!res.ok) { toast(res.msg || '商店加载失败'); renderStore(); return; }
            var d = res.data || {};
            var list = d.list || [];
            if (reset) state.store.list = [];
            list.forEach(function (g) {
                if (!g) return;
                state.games[g.id] = g;
                state.store.list.push(g);
            });
            state.store.page = d.page || page;
            state.store.total = d.total || 0;
            if (reset) renderStoreChrome(); // 首页数据到位后按配置重渲染 Steam 动态区（筛选态自动隐藏）
            if (reset) {
                renderStore(); // reset：全量重建（rendered 游标归位到新列表长度）
            } else {
                appendStoreCards(); // 追加页增量渲染：只 append 新卡片，已渲染卡片原地不动防闪烁
            }
            updateStoreInf();
        });
    }

    // 增量追加渲染：把 rendered 游标之后的新卡片 append 到网格尾（已渲染卡不重绘，封面不闪）
    function appendStoreCards() {
        var grid = $('gsStoreGrid');
        var st = state.store;
        for (var i = st.rendered; i < st.list.length; i++) {
            grid.appendChild(buildCard(st.list[i]));
        }
        st.rendered = st.list.length;
        osbTick($('gsStoreScroll'));
    }

    // 商店无限滚动底部容器状态归口：加载中=spinner 圈 / 还有更多=spinner 待命（IO 接近视口即拉下一页）/
    // 已加载全部=灰字提示；空列表 hidden（由 gsStoreEmpty 兜底展示）
    function updateStoreInf() {
        var st = state.store;
        var inf = $('gsStoreInf');
        if (!st.list.length) { inf.classList.add('hidden'); inf.innerHTML = ''; return; }
        if (st.loading) { fillInfBox(inf, true, '加载中…'); return; }
        if (st.total > 0 && st.list.length >= st.total) { fillInfBox(inf, false, '已加载全部 ' + st.total + ' 款'); return; }
        fillInfBox(inf, true, ''); // 还有更多：spinner 待命态（IO 触发下一页）
    }

    function buildCover(imgUrl, name, cls) {
        var wrap = el('div', cls);
        if (imgUrl) {
            var img = document.createElement('img');
            img.src = assetUrl(imgUrl);
            img.loading = 'lazy';
            img.draggable = false;
            img.onerror = function () { wrap.innerHTML = ''; wrap.appendChild(buildPh(name)); };
            wrap.appendChild(img);
        } else {
            wrap.appendChild(buildPh(name));
        }
        return wrap;
    }

    // 好友正在玩列表（服务端 friends_playing：仅"在线且正在玩本游戏"的好友；离线/心跳过期的已被服务端剔除）
    function friendsPlaying(g) {
        return (g && g.friends_playing && g.friends_playing.length) ? g.friends_playing : null;
    }

    // 好友头像填充（图/首字母占位）：有头像用图，加载失败回退主题色首字母块（与气泡"好友拥有"同款）
    function fillFriendAvatar(box, f, phCls) {
        var name = (f && (f.nickname || f.username)) || '?';
        var ch = String(name).charAt(0).toUpperCase();
        if (f && f.avatar) {
            var img = document.createElement('img');
            img.src = assetUrl(f.avatar);
            img.loading = 'lazy';
            img.alt = name;
            img.onerror = function () {
                box.innerHTML = '';
                var ph = el('div', phCls);
                ph.style.filter = 'hue-rotate(' + hashHue(name) + 'deg)';
                ph.appendChild(el('b', '', ch));
                box.appendChild(ph);
            };
            box.appendChild(img);
        } else {
            var ph2 = el('div', phCls);
            ph2.style.filter = 'hue-rotate(' + hashHue(name) + 'deg)';
            ph2.appendChild(el('b', '', ch));
            box.appendChild(ph2);
        }
    }

    // 封面右下角"好友正在玩"头像堆叠标记（Steam 同款）：最多 3 张（绿环压边），超出补 "+N"；
    // 与悬停气泡"N 名好友正在玩"同源数据（服务端随行下发，零额外请求）
    function buildFriendsPlaying(g) {
        var list = friendsPlaying(g);
        if (!list) return null;
        var box = el('div', 'gs-fplay');
        list.slice(0, 3).forEach(function (f) {
            var av = el('div', 'gs-fplay-av');
            fillFriendAvatar(av, f, 'gs-fplay-ph');
            box.appendChild(av);
        });
        if (list.length > 3) box.appendChild(el('span', 'gs-fplay-more', '+' + (list.length - 3)));
        return box;
    }

    function buildCard(g) {
        var card = el('div', 'gs-card');
        card.addEventListener('click', function () { hideHover(); openDetail(g.id); });
        // 悬停气泡卡（Steam 同款）：进卡片 150ms 后浮出，移出即隐
        card.addEventListener('mouseenter', function () { showHover(g, card); });
        card.addEventListener('mouseleave', hideHover);
        var cover = buildCover(g.cover, g.name, 'gs-cover');
        // 好友正在玩标记（封面右下角头像堆叠，Steam 同款）：与悬停气泡"N 名好友正在玩"同源
        var fplay = buildFriendsPlaying(g);
        if (fplay) cover.appendChild(fplay);
        // 入库徽标（in_library 0-4；undefined=未入库不显示）
        if (g.in_library !== undefined && g.in_library !== null) {
            var badge = el('div', 'gs-badge' + (g.in_library === 1 || g.in_library === 4 ? ' hot' : ''),
                BADGE_TEXT[g.in_library] || '已入库');
            cover.appendChild(badge);
            state.badgeEls[g.id] = badge;
        }
        card.appendChild(cover);
        var body = el('div', 'gs-card-body');
        body.appendChild(el('div', 'gs-card-name', g.name || ('游戏 #' + g.id)));
        body.appendChild(el('div', 'gs-card-desc', g.short_desc || ''));
        var meta = el('div', 'gs-card-meta');
        meta.appendChild(el('span', '', fmtSize(g.size_bytes)));
        meta.appendChild(el('span', '', g.developer || ''));
        body.appendChild(meta);
        card.appendChild(body);
        return card;
    }

    // ==================== 商店卡片悬停气泡卡（Steam 同款） ====================
    // 单例挂 body + fixed 定位逃出滚动容器裁剪；pointer-events:none 纯展示；
    // 数据全部来自列表项（服务端已随行下发评测聚合），零额外请求
    var hovEl = null, hovTimer = null;
    // 气泡媒体轮播（库"最近游戏"卡悬停，Steam 同款预览）：当前媒体盒/轮播定时器/延迟卸载定时器/构建代号
    // 媒体表与下标下沉到 buildHoverMedia 闭包内（原为共享变量，会被上一条气泡的在途定时器改写）
    var hovMediaBox = null, hovMediaTimer = null, hovVideoStopTimer = null, hovMediaGen = 0;

    // RFC3339 → 中文日期（发行于行）
    function fmtCnDate(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    function ensureHover() {
        if (hovEl) return;
        hovEl = el('div', 'gs-hover');
        document.body.appendChild(hovEl);
        // 滚动/缩放/失焦时卡片位置已失效，立即隐藏防气泡飘空
        window.addEventListener('resize', hideHover);
        window.addEventListener('blur', hideHover);
        var store = $('gsStoreScroll');
        if (store) store.addEventListener('scroll', hideHover, { passive: true });
        var lib = $('gsLibMain'); // 库页主区滚动（"最近游戏"卡所在容器）
        if (lib) lib.addEventListener('scroll', hideHover, { passive: true });
    }

    function buildHoverContent(g, opts) {
        // 重建气泡即释放上一条气泡的媒体 video（同刻作废其待卸载定时器）：否则快速来回悬停时，
        // 上一条气泡 180ms 的延迟卸载会扫到 hovEl 里"刚建好的本条新视频"并清掉 src → 媒体区空白
        stopHoverMedia(true);
        hovEl.innerHTML = '';
        hovEl.appendChild(el('div', 'gs-hover-title', g.name || ('游戏 #' + g.id)));
        // 好友正在玩（Steam 同款：标题下方第一块，绿色圆点 + "N 名好友正在玩" + 头像横排）
        var fpl = friendsPlaying(g);
        if (fpl) {
            var fp = el('div', 'gs-hover-fplay');
            var fpLabel = el('div', 'gs-hover-fplay-label');
            fpLabel.appendChild(el('span', 'gs-hover-dot'));
            fpLabel.appendChild(el('span', '', fpl.length + ' 名好友正在玩'));
            fp.appendChild(fpLabel);
            var fpRow = el('div', 'gs-hover-own-avatars');
            fpl.slice(0, 6).forEach(function (f) {
                var av = el('div', 'gs-hover-own-av');
                fillFriendAvatar(av, f, 'gs-hover-own-ph');
                fpRow.appendChild(av);
            });
            if (fpl.length > 6) fpRow.appendChild(el('span', 'gs-hover-own-more', '+' + (fpl.length - 6)));
            fp.appendChild(fpRow);
            hovEl.appendChild(fp);
        }
        // 媒体轮播区（仅库"最近游戏"卡请求：Steam 同款预览，截图/视频混排轮换）
        if (opts && opts.media) {
            var media = buildHoverMedia(g);
            if (media) hovEl.appendChild(media);
        }
        var date = fmtCnDate(g.create_time);
        if (date) hovEl.appendChild(el('div', 'gs-hover-date', '发行于: ' + date));
        if (g.short_desc) hovEl.appendChild(el('div', 'gs-hover-desc', g.short_desc));
        if (g.review_summary) {
            var rev = el('div', 'gs-hover-rev');
            rev.appendChild(el('div', 'gs-hover-rev-label', '玩家评测:'));
            var line = el('span', '');
            line.appendChild(el('span', 'gs-hover-rev-summary', g.review_summary));
            line.appendChild(el('span', 'gs-hover-rev-count', ' (' + fmtCount(g.review_total || 0) + ' 篇评测)'));
            rev.appendChild(line);
            hovEl.appendChild(rev);
        }
        if (g.tags && g.tags.length) {
            hovEl.appendChild(el('div', 'gs-hover-label', '用户标签:'));
            var tw = el('div', 'gs-hover-tags');
            g.tags.slice(0, 6).forEach(function (t) { tw.appendChild(el('span', 'gs-tag', t)); });
            hovEl.appendChild(tw);
        }
        // 好友拥有（Steam 同款）：仅查看者自己的好友，圆角方形头像半叠加横排（≤6 张 + "+N"）
        if (g.friends_own && g.friends_own.length) {
            var own = el('div', 'gs-hover-own');
            own.appendChild(el('div', 'gs-hover-own-label', g.friends_own.length + ' 位好友拥有此游戏:'));
            var row = el('div', 'gs-hover-own-avatars');
            g.friends_own.slice(0, 6).forEach(function (f) {
                var name = f.nickname || f.username || '?';
                var ch = String(name).charAt(0).toUpperCase();
                var av = el('div', 'gs-hover-own-av');
                if (f.avatar) {
                    var img = document.createElement('img');
                    img.src = assetUrl(f.avatar);
                    img.loading = 'lazy';
                    img.onerror = function () { av.innerHTML = ''; av.appendChild(ownPh(ch, name)); };
                    av.appendChild(img);
                } else {
                    av.appendChild(ownPh(ch, name));
                }
                row.appendChild(av);
            });
            if (g.friends_own.length > 6) {
                row.appendChild(el('span', 'gs-hover-own-more', '+' + (g.friends_own.length - 6)));
            }
            own.appendChild(row);
            hovEl.appendChild(own);
        }
        // 库场景附加：游戏时间（我自己对该游戏的总时数/最近游玩，Steam 气泡底部同款位置）
        if (opts && opts.lib) {
            hovEl.appendChild(el('div', 'gs-hover-label', '游戏时间'));
            var lb = el('div', 'gs-hover-lib');
            lb.appendChild(el('div', 'gs-hover-litime', '总数 ' + fmtPlay(opts.lib.play_seconds)));
            if (opts.lib.last_play_at) lb.appendChild(el('div', 'gs-hover-litime', '最近游玩 ' + opts.lib.last_play_at));
            hovEl.appendChild(lb);
        }
    }

    // 气泡媒体轮播区（Steam 同款预览）：视频在前截图在后，一次只挂一张（换页整块重画，
    // 上一张的 video 随 DOM 丢弃同步停播）；静图 3.5s、视频 6s 后切下一张，仅 1 条时不轮播
    function buildHoverMedia(g) {
        var list = [];
        (g.videos || []).forEach(function (u) { if (u) list.push({ kind: 'v', url: u }); });
        (g.screenshots || []).forEach(function (u) { if (u) list.push({ kind: 'i', url: u }); });
        if (!list.length) return null;
        // 媒体表与下标下沉到本闭包（随气泡共存亡）：上一条气泡的在途定时器即便漏跑也只影响自己的闭包，
        // 不会改写本条气泡的状态；gen 与本条 box 句柄共同保证过期回调不再触碰任何共享资源
        var idx = 0, gen = ++hovMediaGen;
        var box = el('div', 'gs-hover-media');
        hovMediaBox = box;
        function paint() {
            box.innerHTML = '';
            var m = list[idx];
            if (!m) return;
            if (m.kind === 'v') {
                var v = document.createElement('video');
                v.src = assetUrl(m.url);
                v.muted = true;
                v.loop = true;
                v.autoplay = true;
                v.setAttribute('playsinline', '');
                v.setAttribute('preload', 'metadata');
                box.appendChild(v);
            } else {
                var im = document.createElement('img');
                im.src = assetUrl(m.url);
                im.alt = g.name || '';
                // 悬停即预览：不懒加载（loading='lazy' 在快速切换时首帧可能未解码，表现为图片空白）
                box.appendChild(im);
            }
        }
        function schedule() {
            if (list.length < 2) return;
            var m = list[idx];
            hovMediaTimer = setTimeout(function () {
                if (gen !== hovMediaGen) return; // 本气泡已被替换/隐藏：过期链作废，不触碰共享定时器句柄
                hovMediaTimer = null;
                idx = (idx + 1) % list.length;
                paint();
                schedule();
            }, (m && m.kind === 'v') ? 6000 : 3500);
        }
        paint();
        schedule();
        return box;
    }

    // 轮播停表 + 卸载本条气泡的 video（先让气泡淡出，再 pause/清 src/load 停解码，避免背景空播占用资源）
    // immediate=true（重建气泡/切换卡片时）：同步卸载；否则延后 180ms 等淡出完成再卸载。
    // 关键：只卸载"本次捕获的 hovMediaBox"，绝不遍历 hovEl 当前 DOM —— 否则快速来回悬停时，
    // 上一条气泡的延迟卸载会误杀本条新气泡刚建好的 video/img（媒体区空白的根因）
    function stopHoverMedia(immediate) {
        hovMediaGen++; // 代号自增：作废本条气泡所有在途轮播链
        clearTimeout(hovMediaTimer);
        hovMediaTimer = null;
        clearTimeout(hovVideoStopTimer);
        hovVideoStopTimer = null;
        var box = hovMediaBox;
        hovMediaBox = null;
        if (!box) return;
        if (immediate) {
            unloadVideos(box);
            return;
        }
        hovVideoStopTimer = setTimeout(function () {
            hovVideoStopTimer = null;
            unloadVideos(box);
        }, 180);
    }

    // 卸载指定媒体盒内的 video（pause + 清 src + load 停解码）。传入的是已捕获的盒引用，
    // 与当前 DOM 是否已换新气泡无关——过期盒即便不在文档中，释放其解码资源同样安全。
    function unloadVideos(box) {
        if (!box) return;
        var vids = box.querySelectorAll('video');
        for (var i = 0; i < vids.length; i++) {
            try {
                vids[i].pause();
                vids[i].removeAttribute('src');
                vids[i].load();
            } catch (e) { /* 卸载异常忽略：气泡已隐藏，不影响功能 */ }
        }
    }

    // 好友头像回退块（无头像/加载失败）：主题色底 + 首字母，与封面占位 buildPh 同款色相偏移
    function ownPh(ch, name) {
        var ph = el('div', 'gs-hover-own-ph');
        ph.style.filter = 'hue-rotate(' + hashHue(name) + 'deg)';
        ph.appendChild(el('b', '', ch));
        return ph;
    }

    // opts.media=库卡请求媒体轮播预览；opts.lib=库条目（气泡底部显示我的游戏时间）
    function showHover(g, card, opts) {
        ensureHover();
        clearTimeout(hovTimer);
        hovTimer = setTimeout(function () {
            buildHoverContent(g, opts);
            hovEl.classList.add('show'); // 先显示再测量（display 未隐藏时 offsetHeight 即时有效）
            var r = card.getBoundingClientRect();
            var W = 318, M = 12; // 300 宽 + 2px 边框
            var h = hovEl.offsetHeight;
            var left = r.right + M, flip = false;
            if (left + W > window.innerWidth - 8) { // 右侧放不下翻到卡片左侧
                left = r.left - W - M;
                flip = true;
            }
            if (left < 8) left = 8;
            var top = r.top + r.height / 2 - h / 2; // 垂直居中于卡片，钳制在视口内
            top = Math.max(54, Math.min(top, window.innerHeight - h - 10));
            hovEl.style.left = Math.round(left) + 'px';
            hovEl.style.top = Math.round(top) + 'px';
            hovEl.classList.toggle('flip', flip);
        }, 150);
    }

    function hideHover() {
        clearTimeout(hovTimer);
        if (hovEl) hovEl.classList.remove('show');
        stopHoverMedia(); // 轮播停表 + 延后 180ms 卸载本条 video（先淡出再停解码，隐藏后不再空播）
    }

    function renderStore() {
        var grid = $('gsStoreGrid');
        grid.innerHTML = '';
        state.badgeEls = {};
        state.store.list.forEach(function (g) { grid.appendChild(buildCard(g)); });
        state.store.rendered = state.store.list.length;
        $('gsStoreEmpty').classList.toggle('hidden', state.store.list.length > 0);
        osbTick($('gsStoreScroll'));
    }

    // 进度事件原地刷新商店卡片徽标（不整格重绘，避免封面图闪烁）
    function updateBadges() {
        for (var gid in state.badgeEls) {
            var badge = state.badgeEls[gid];
            var g = state.games[gid] || {};
            var lib = state.lib[gid] && state.lib[gid].lib;
            var st = lib ? lib.state : g.in_library;
            if (st === undefined || st === null) {
                badge.remove();
                delete state.badgeEls[gid];
                continue;
            }
            badge.textContent = BADGE_TEXT[st] || '';
            badge.classList.toggle('hot', st === 1 || st === 4);
        }
    }

    // ==================== 商店 Steam 布局动态区（轮播/精选流/标签条，按管理端配置渲染） ====================
    // 设计归口：layout=grid（经典网格）或搜索/标签筛选态时不渲染任何 Steam 区块，仅保留全部游戏网格；
    // 轮播数据取管理端配置的置顶推荐（featured_games，服务端已保序且仅含上架游戏），无配置时回退为
    // 首页下载量 Top5；轮播自动轮换 5s/张、悬停暂停；精选流取首页剔除轮播后的前 12 款横向卡片流；
    // 标签条聚合首页游戏标签胶囊（点击筛选再点取消，"全部"清除）
    var gsTimers = [];     // 轮播定时器登记表（顶部轮播/capsule/promo 区块各自持有，重渲染统一销毁）
    var carouselData = []; // 顶部特色轮播数据（置顶推荐或下载量 Top5）

    function steamLayout() {
        return !!(state.cfg && state.cfg.layout === 'steam');
    }

    function renderStoreChrome() {
        var host = $('gsStoreChrome');
        // 旧横向滚动条滑块销毁（滑块挂 body，innerHTML 重建后会变孤儿）
        var olds = host.querySelectorAll('.gs-frow');
        for (var i = 0; i < olds.length; i++) destroyOsb(olds[i]);
        host.innerHTML = '';
        // 所有轮播定时器统一销毁（顶部轮播与 capsule/promo 区块各自持有定时器）
        gsTimers.forEach(function (t) { clearInterval(t); });
        gsTimers = [];
        if (!steamLayout()) return;
        var c = state.cfg;
        var sec = (c && c.sections) || {};
        var list = state.store.list;
        // 筛选态（搜索/标签）：轮播与精选隐藏，仅保留标签条——供切换标签或点"全部"取消筛选，
        // 标签数据用首页全量缓存（state.allTags），避免用筛选后的子集聚合导致标签残缺
        if (state.store.keyword || state.store.tag) {
            var barF = buildTagbar(state.allTags || aggregateTags(list));
            if (barF) host.appendChild(barF);
            return;
        }
        if (!list.length) return;
        // 轮播数据：置顶推荐优先，回退首页下载量 Top5
        carouselData = (c.featured_games && c.featured_games.length) ?
            c.featured_games.slice(0, 5) :
            list.slice().sort(function (a, b) { return (b.down_count || 0) - (a.down_count || 0); }).slice(0, 5);
        if (sec.carousel !== false && carouselData.length) {
            host.appendChild(buildCarousel());
        } else {
            carouselData = [];
        }
        // 自定义推荐区块（Steam 首页多区块同款：管理端配置标题+样式+游戏，
        // 按配置顺序渲染在顶部轮播之后、热门精选之前；服务端已剔除无游戏区块）
        (c.store_sections || []).forEach(function (sec) {
            var node = buildStoreSection(sec);
            if (node) host.appendChild(node);
        });
        var carIds = {};
        carouselData.forEach(function (g) { carIds[g.id] = true; });
        if (sec.featured !== false) {
            var feat = list.filter(function (g) { return !carIds[g.id]; }).slice(0, 12);
            if (feat.length) host.appendChild(buildFeaturedRow(feat));
        }
        if (sec.tagbar !== false) {
            state.allTags = aggregateTags(list); // 缓存首页全量标签（筛选态下标签条仍可渲染）
            var tagbar = buildTagbar(state.allTags);
            if (tagbar) host.appendChild(tagbar);
        }
        host.appendChild(el('div', 'gs-grid-title', '全部游戏'));
    }

    // 特色推荐轮播核心（Steam"精选和推荐"主图区同款）：左侧大图（底部渐隐一句话简介）+
    // 右侧信息面板（游戏名 + 评测摘要 + 2×2 截图网格 + 标签胶囊 + 免费开玩/积分价按钮）+
    // 底部圆点指示器；顶部特色轮播与 capsule 自定义区块共用本核心（games 数据源独立、
    // 定时器登记 gsTimers 统一销毁），多游戏时自动轮换 5s/张、悬停暂停
    function buildCarouselCore(games, autoplay) {
        // 外层容器（纵向：横向行 + 底部圆点）：圆点必须落在主图/面板之下居中，
        // 不可挂进横向 flex 行（否则成为第三个 flex 子项被挤到最右侧顶对齐——实测 bug）
        var wrap = el('div', 'gs-carousel-wrap');
        var row = el('div', 'gs-carousel');
        var main = el('div', 'gs-car-main');
        var info = el('div', 'gs-car-info');
        var descEl = el('div', 'gs-car-desc', ''); // 主图渐隐条一句话简介（名称移至右面板，Steam 同款）
        info.appendChild(descEl);
        main.appendChild(info);
        var idx = 0;
        main.addEventListener('click', function () {
            var g = games[idx];
            if (g) openDetail(g.id);
        });
        row.appendChild(main);

        // 右侧信息面板
        var panel = el('div', 'gs-car-panel');
        var pTitle = el('div', 'gs-car-title');
        var pReview = el('div', 'gs-car-review');
        var pShots = el('div', 'gs-car-shots');
        var pTags = el('div', 'gs-car-tags');
        var pAction = el('div', 'gs-car-action');
        panel.appendChild(pTitle);
        panel.appendChild(pReview);
        panel.appendChild(pShots);
        panel.appendChild(pTags);
        panel.appendChild(pAction);
        row.appendChild(panel);
        wrap.appendChild(row);

        // 当前游戏主图源与名称（闭包记录：截图悬停预览移出后恢复主图用）
        var curPic = '';
        var curName = '';

        // 主图绘制归口：换页与截图悬停预览共用（移除现有主图/占位块后重画，
        // pic 为空画主题色占位块；加载失败回退占位块）
        function setMainPic(pic) {
            var old = main.querySelector('img, .gs-cover-ph');
            if (old) old.remove();
            if (pic) {
                var im = document.createElement('img');
                im.src = pic;
                im.draggable = false;
                im.onerror = function () { im.remove(); main.insertBefore(buildPh(curName), info); };
                main.insertBefore(im, info);
            } else {
                main.insertBefore(buildPh(curName), info);
            }
        }

        // 截图悬停预览恢复：鼠标离开整个截图网格时清除预览描边并恢复当前游戏主图
        // （挂 pShots 归口而非单格，小图间滑动不闪恢复封面）
        pShots.addEventListener('mouseleave', function () {
            pShots.querySelectorAll('.gs-car-shot.previewing').forEach(function (c) {
                c.classList.remove('previewing');
            });
            setMainPic(curPic ? assetUrl(curPic) : '');
        });

        // ===== 大图悬停动态预览（Steam 同款，与精选卡 attachHoverPreview 同构） =====
        // 悬停大图 400ms 后原地播放管理端宣传视频（静音循环自动播）；无视频且截图≥2 则
        // 1.2s 轮播截图。状态按轮播实例私有（顶部轮播与 capsule 区块可同时存在，全局
        // 状态会互踩）；移出大图/换页/圆点切换即停并恢复封面，预览层靠 DOM 顺序
        // （insertBefore info）落在封面之上、底部渐隐条之下——悬停播放时简介文字仍悬浮
        var chprev = { timer: null, cyc: null, el: null };

        function stopCarPreview() {
            clearTimeout(chprev.timer);
            clearInterval(chprev.cyc);
            chprev.cyc = null;
            if (chprev.el) {
                if (chprev.el.tagName === 'VIDEO') chprev.el.pause();
                chprev.el.remove();
                chprev.el = null;
            }
        }

        main.addEventListener('mouseenter', function () {
            clearTimeout(chprev.timer);
            var g = games[idx];
            if (!g) return;
            var vids = g.videos || [], shots = g.screenshots || [];
            if (!vids.length && shots.length < 2) return; // 无动态内容不预览
            chprev.timer = setTimeout(function () {
                stopCarPreview();
                if (!main.isConnected) return; // 等待期间轮播已重建（切筛选/重渲染）
                if (vids.length) {
                    var v = document.createElement('video');
                    v.className = 'gs-hprev';
                    v.muted = true; // 静音自动播（浏览器自动播放策略要求，Steam 悬停预览同为静音）
                    v.loop = true;
                    v.autoplay = true;
                    v.playsInline = true;
                    v.setAttribute('playsinline', '');
                    v.src = assetUrl(vids[0]);
                    v.addEventListener('error', function () { if (chprev.el === v) stopCarPreview(); }); // 源失效回退封面
                    // 起播淡入：首帧渲染前保持透明露出封面，防加载期黑块闪现
                    v.addEventListener('playing', function () { v.classList.add('ready'); });
                    main.insertBefore(v, info);
                    chprev.el = v;
                    v.play().catch(function () {});
                } else {
                    var img = document.createElement('img');
                    img.className = 'gs-hprev';
                    img.alt = '';
                    img.draggable = false;
                    img.src = assetUrl(shots[0]);
                    // 图片解码完成才淡入，防半加载闪现
                    img.addEventListener('load', function () { img.classList.add('ready'); });
                    main.insertBefore(img, info);
                    chprev.el = img;
                    var i = 0;
                    chprev.cyc = setInterval(function () {
                        if (!chprev.el || !chprev.el.isConnected) { clearInterval(chprev.cyc); chprev.cyc = null; return; }
                        i = (i + 1) % shots.length;
                        chprev.el.src = assetUrl(shots[i]);
                    }, 1200);
                }
            }, 400);
        });
        main.addEventListener('mouseleave', stopCarPreview);

        // 底部圆点指示器（Steam 同款：点击跳转、当前点亮；单游戏无切换价值不渲染）
        var dotEls = [];
        if (games.length > 1) {
            var dots = el('div', 'gs-car-dots');
            games.forEach(function (g, i) {
                var d = el('button', 'gs-car-dot');
                d.addEventListener('click', function () { carShow(i); });
                dots.appendChild(d);
                dotEls.push(d);
            });
            wrap.appendChild(dots);
        }

        function paintShots(g) {
            pShots.innerHTML = '';
            var shots = (g.screenshots || []).slice(0, 4);
            if (!shots.length) {
                pShots.appendChild(el('div', 'gs-car-shot-ph', '暂无截图'));
                return;
            }
            shots.forEach(function (s) {
                var cell = el('div', 'gs-car-shot');
                var im = document.createElement('img');
                im.src = assetUrl(s);
                im.loading = 'lazy';
                im.draggable = false;
                im.onerror = function () { im.remove(); cell.classList.add('bad'); };
                cell.appendChild(im);
                cell.addEventListener('click', function () { openDetail(g.id); });
                // 悬停预览（Steam 同款）：移入小图把主图临时切换为该截图并加预览描边，
                // 恢复由 pShots 的 mouseleave 归口处理（移出整个网格才恢复封面）
                cell.addEventListener('mouseenter', function () {
                    pShots.querySelectorAll('.gs-car-shot.previewing').forEach(function (c) {
                        c.classList.remove('previewing');
                    });
                    cell.classList.add('previewing');
                    setMainPic(assetUrl(s));
                });
                pShots.appendChild(cell);
            });
        }

        function carShow(i) {
            stopCarPreview(); // 换页/圆点切换先停大图悬停预览，防旧预览残留到新游戏画面上
            idx = (i + games.length) % games.length;
            var g = games[idx];
            // 主图取封面，缺封面回退第一张截图，再缺省回退主题色占位块
            curPic = g.cover || (g.screenshots && g.screenshots[0]) || '';
            curName = g.name || '';
            setMainPic(curPic ? assetUrl(curPic) : '');
            // 一句话简介（渐隐条）：无简介时隐藏占位行
            descEl.textContent = g.short_desc || '';
            descEl.style.display = g.short_desc ? '' : 'none';
            pTitle.textContent = g.name || ('游戏 #' + g.id);
            // 评测摘要（Steam 同款"特别好评 (N 篇评测)"；分级文案服务端归口下发，无评测留空）
            pReview.textContent = g.review_summary ?
                (g.review_summary + ' (' + fmtCount(g.review_total) + ' 篇评测)') : '暂无评测，快来抢沙发';
            paintShots(g);
            pTags.innerHTML = '';
            (g.tags || []).slice(0, 3).forEach(function (t) {
                pTags.appendChild(el('span', 'gs-car-tag', t));
            });
            pAction.innerHTML = '';
            var play = el('button', 'gs-car-play' + ((Number(g.price) || 0) > 0 ? '' : ' free'), '');
            fillPrice(play, g, '免费开玩');
            play.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openDetail(g.id);
            });
            pAction.appendChild(play);
            dotEls.forEach(function (d, j) { d.classList.toggle('active', j === idx); });
        }
        carShow(0);
        if (autoplay !== false && games.length > 1) {
            gsTimers.push(setInterval(function () {
                try { if (wrap.matches(':hover')) return; } catch (e) { /* 匹配失败不暂停 */ }
                carShow(idx + 1);
            }, 5000));
        }
        return wrap;
    }

    // 顶部特色轮播（数据源 carouselData：置顶推荐或下载量 Top5）
    function buildCarousel() {
        return buildCarouselCore(carouselData, true);
    }

    // ==================== 自定义推荐区块（Steam 首页多区块同款，管理端配置） ====================
    // 渲染归口：按区块 style 分支选择构建器（未知样式跳过不渲染）；games 为服务端已解析的
    // 上架游戏摘要（保序去重），空列表不会到达此处（服务端已剔除）
    function buildStoreSection(sec) {
        var games = (sec.games || []).slice(0, 12);
        if (!games.length) return null;
        var title = sec.title || '推荐游戏';
        switch (sec.style) {
            case 'promo': return buildPromoSection(title, games);
            case 'capsule': return buildCapsuleSection(title, games);
            case 'row': return buildFeaturedRow(games, title);
            case 'grid': return buildGridSection(title, games);
            case 'list': return buildListSection(title, games);
        }
        return null;
    }

    // capsule 区块：主图信息面板轮播（与顶部特色轮播同构），带区块标题
    function buildCapsuleSection(title, games) {
        var block = el('div', 'gs-fblock');
        block.appendChild(el('div', 'gs-fblock-title', title));
        block.appendChild(buildCarouselCore(games, true));
        return block;
    }

    // 网格卡片区块：复用全部游戏网格卡片样式（gs-card，含入库徽标/简介/厂商元信息）
    function buildGridSection(title, games) {
        var block = el('div', 'gs-fblock');
        block.appendChild(el('div', 'gs-fblock-title', title));
        var grid = el('div', 'gs-sec-grid');
        games.forEach(function (g) { grid.appendChild(buildCard(g)); });
        block.appendChild(grid);
        return block;
    }

    // 活动大图区块（Steam"折扣与活动"同款）：每页 = 左 1 张大卡（底部渐隐名称+一句话介绍）+
    // 右侧竖排最多 2 张小卡（底部名称条 + 价格角标）；左右箭头 + 底部圆点翻页、6s 自动轮换悬停暂停
    function buildPromoSection(title, games) {
        var block = el('div', 'gs-fblock');
        block.appendChild(el('div', 'gs-fblock-title', title));
        var stage = el('div', 'gs-promo');
        var pageEl = el('div', 'gs-promo-page');
        stage.appendChild(pageEl);
        block.appendChild(stage);
        // 每 3 款一页（1 大 + 2 小），尾页不足按实际数量渲染（仅 1 款时大卡独占整行）
        var pages = [];
        for (var i = 0; i < games.length; i += 3) pages.push(games.slice(i, i + 3));
        var idx = 0;
        function promoCard(g, big) {
            var c = el('div', 'gs-promo-card' + (big ? ' big' : ''));
            c.addEventListener('click', function () { openDetail(g.id); });
            var pic = g.cover || (g.screenshots && g.screenshots[0]) || '';
            if (pic) {
                var im = document.createElement('img');
                im.src = assetUrl(pic);
                im.loading = 'lazy';
                im.draggable = false;
                im.onerror = function () { im.remove(); c.insertBefore(buildPh(g.name), fade); };
                c.appendChild(im);
            } else {
                c.appendChild(buildPh(g.name));
            }
            var fade = el('div', 'gs-promo-fade');
            fade.appendChild(el('div', 'gs-promo-name', g.name || ('游戏 #' + g.id)));
            // 大卡底部渐隐条带一句话介绍（小卡仅名称，Steam 同款）
            if (big && g.short_desc) fade.appendChild(el('div', 'gs-promo-desc', g.short_desc));
            c.appendChild(fade);
            // 价格角标（右下深色胶囊：免费走主题绿高亮，积分价白字）
            var pb = el('div', 'gs-promo-price' + ((Number(g.price) || 0) > 0 ? '' : ' free'));
            fillPrice(pb, g, '免费');
            c.appendChild(pb);
            return c;
        }
        function show(p) {
            idx = (p + pages.length) % pages.length;
            pageEl.innerHTML = '';
            var list = pages[idx];
            pageEl.appendChild(promoCard(list[0], true));
            if (list.length > 1) {
                var side = el('div', 'gs-promo-side');
                list.slice(1).forEach(function (g) { side.appendChild(promoCard(g, false)); });
                pageEl.appendChild(side);
            }
            dotEls.forEach(function (d, j) { d.classList.toggle('active', j === idx); });
        }
        // 圆点与左右箭头（多页才渲染）
        var dotEls = [];
        if (pages.length > 1) {
            var dots = el('div', 'gs-car-dots');
            pages.forEach(function (_, j) {
                var d = el('button', 'gs-car-dot');
                d.addEventListener('click', function () { show(j); });
                dots.appendChild(d);
                dotEls.push(d);
            });
            block.appendChild(dots);
            var prev = el('button', 'gs-promo-arrow left', '‹');
            var next = el('button', 'gs-promo-arrow right', '›');
            prev.addEventListener('click', function () { show(idx - 1); });
            next.addEventListener('click', function () { show(idx + 1); });
            stage.appendChild(prev);
            stage.appendChild(next);
            gsTimers.push(setInterval(function () {
                try { if (stage.matches(':hover')) return; } catch (e) { /* 匹配失败不暂停 */ }
                show(idx + 1);
            }, 6000));
        }
        show(0);
        return block;
    }

    // 榜单区块媒体堆栈公共构建（悬停面板/单游戏横向大卡共用）：视频占首位自动播（静音+循环，
    // ⑭/⑯ 同款约定，onerror 回退首截图），余量填 screenshots，上限 max 块，全无则首字母占位块
    function lpvMediaEl(g, max) {
        var media = el('div', 'gs-lpv-media');
        var tiles = 0;
        function addImg(src) {
            if (tiles >= max || !src) return;
            var t = el('div', 'gs-lpv-tile');
            var im = document.createElement('img');
            im.src = assetUrl(src);
            im.loading = 'lazy';
            im.draggable = false;
            im.onerror = function () { im.remove(); };
            t.appendChild(im);
            media.appendChild(t);
            tiles++;
        }
        if ((g.videos || []).length) {
            var vt = el('div', 'gs-lpv-tile');
            var v = document.createElement('video');
            v.src = assetUrl(g.videos[0]);
            v.muted = true;
            v.loop = true;
            v.autoplay = true;
            v.setAttribute('playsinline', '');
            v.onerror = function () { vt.remove(); tiles--; addImg(g.screenshots && g.screenshots[0]); };
            vt.appendChild(v);
            media.appendChild(vt);
            tiles++;
        }
        (g.screenshots || []).forEach(function (s) { addImg(s); });
        if (!tiles) {
            var ph = el('div', 'gs-lpv-tile');
            ph.appendChild(buildPh(g.name));
            media.appendChild(ph);
        }
        return media;
    }

    // 单游戏横向大卡（Steam 精选胶囊同款）：仅 1 款游戏时榜单双栏左侧会大面积留空，
    // 改为整行宽横向卡——左侧信息区（名称/评测/介绍/标签/价格按钮）+ 右侧 2×2 媒体网格，
    // 整卡可点击进详情；多游戏仍走双栏行榜单 + 悬停预览
    function buildListHero(g) {
        var wrap = el('div', 'gs-lrows');
        var hero = el('div', 'gs-lpv-hero');
        hero.addEventListener('click', function () { openDetail(g.id); });
        var info = el('div', 'gs-lpv-info');
        info.appendChild(el('div', 'gs-lpv-name', g.name || ('游戏 #' + g.id)));
        if (g.review_summary) {
            var rev = el('div', 'gs-lpv-rev');
            rev.appendChild(document.createTextNode('玩家评测: '));
            rev.appendChild(el('b', '', g.review_summary));
            rev.appendChild(document.createTextNode(' · ' + fmtCount(g.review_total) + ' 篇'));
            info.appendChild(rev);
        }
        if (g.short_desc) info.appendChild(el('div', 'gs-lpv-desc', g.short_desc));
        if ((g.tags || []).length) {
            var tg = el('div', 'gs-lpv-tags');
            g.tags.slice(0, 5).forEach(function (t) { tg.appendChild(el('span', 'gs-car-tag', t)); });
            info.appendChild(tg);
        }
        var hPrice = el('div', 'gs-lrow-price' + ((Number(g.price) || 0) > 0 ? '' : ' free'));
        fillPrice(hPrice, g, '免费开玩');
        info.appendChild(hPrice);
        hero.appendChild(info);
        hero.appendChild(lpvMediaEl(g, 4));
        wrap.appendChild(hero);
        return wrap;
    }

    // 榜单列表区块（Steam"热门新品"同款）：左侧行式榜单（缩略图+名称/一句话介绍+标签+价格），
    // 右侧悬停预览面板（标题/玩家评测/介绍/标签+媒体堆栈：视频自动播+截图，悬停行即时切换，
    // 移出列表保持最后游戏；数据全部来自列表接口既有字段，服务端零改动）；仅 1 款游戏时
    // 降级为横向大卡（左侧行榜单会大面积留空，用户反馈感官不适）
    function buildListSection(title, games) {
        var list = games.slice(0, 8);
        if (!list.length) return null;
        var block = el('div', 'gs-fblock');
        block.appendChild(el('div', 'gs-fblock-title', title));
        if (list.length === 1) {
            block.appendChild(buildListHero(list[0]));
            return block;
        }
        var wrap = el('div', 'gs-lrows');
        var rows = el('div', 'gs-lrows-list');
        // 右侧预览面板：悬停行重建内容（innerHTML 清空即中止旧媒体下载/播放，⑯ 同源约定）
        var pv = el('div', 'gs-lpv');
        pv.__gid = 0;
        function lpvRender(g) {
            if (pv.__gid === g.id) return; // 同游戏重复悬停不重建（防视频重载闪烁）
            pv.__gid = g.id;
            pv.innerHTML = '';
            pv.appendChild(el('div', 'gs-lpv-name', g.name || ('游戏 #' + g.id)));
            if (g.review_summary) {
                var rev = el('div', 'gs-lpv-rev');
                rev.appendChild(document.createTextNode('玩家评测: '));
                rev.appendChild(el('b', '', g.review_summary));
                rev.appendChild(document.createTextNode(' · ' + fmtCount(g.review_total) + ' 篇'));
                pv.appendChild(rev);
            }
            if (g.short_desc) pv.appendChild(el('div', 'gs-lpv-desc', g.short_desc));
            if ((g.tags || []).length) {
                var tg = el('div', 'gs-lpv-tags');
                g.tags.slice(0, 5).forEach(function (t) { tg.appendChild(el('span', 'gs-car-tag', t)); });
                pv.appendChild(tg);
            }
            pv.appendChild(lpvMediaEl(g, 4));
        }
        lpvRender(list[0]); // 默认展示首款（Steam 同款进场即有预览）
        list.forEach(function (g) {
            var r = el('div', 'gs-lrow');
            r.addEventListener('click', function () { openDetail(g.id); });
            // 悬停即切右侧预览（Steam 同款无延迟即时跟随）
            r.addEventListener('mouseenter', function () { lpvRender(g); });
            var th = el('div', 'gs-lrow-thumb');
            var pic = g.cover || (g.screenshots && g.screenshots[0]) || '';
            if (pic) {
                var im = document.createElement('img');
                im.src = assetUrl(pic);
                im.loading = 'lazy';
                im.draggable = false;
                im.onerror = function () { im.remove(); th.appendChild(buildPh(g.name)); };
                th.appendChild(im);
            } else {
                th.appendChild(buildPh(g.name));
            }
            r.appendChild(th);
            var mid = el('div', 'gs-lrow-mid');
            mid.appendChild(el('div', 'gs-lrow-name', g.name || ('游戏 #' + g.id)));
            mid.appendChild(el('div', 'gs-lrow-desc', g.short_desc || ''));
            r.appendChild(mid);
            var tg = el('div', 'gs-lrow-tags');
            (g.tags || []).slice(0, 3).forEach(function (t) { tg.appendChild(el('span', 'gs-car-tag', t)); });
            r.appendChild(tg);
            var rPrice = el('div', 'gs-lrow-price' + ((Number(g.price) || 0) > 0 ? '' : ' free'));
            fillPrice(rPrice, g, '免费开玩');
            r.appendChild(rPrice);
            rows.appendChild(r);
        });
        wrap.appendChild(rows);
        wrap.appendChild(pv);
        block.appendChild(wrap);
        return block;
    }

    // 热门精选：横向卡片流（横向自绘悬浮滑块）；row 样式自定义区块复用（自定义标题）
    function buildFeaturedRow(list, title) {
        var block = el('div', 'gs-fblock');
        block.appendChild(el('div', 'gs-fblock-title', title || '热门精选'));
        var row = el('div', 'gs-frow gs-scroll');
        list.forEach(function (g) {
            var card = el('div', 'gs-fcard');
            card.addEventListener('click', function () { stopHoverPreview(); openDetail(g.id); });
            var cover = buildCover(g.cover, g.name, 'gs-cover');
            card.appendChild(cover);
            attachHoverPreview(card, cover, g);
            var body = el('div', 'gs-fcard-body');
            body.appendChild(el('div', 'gs-fcard-name', g.name || ('游戏 #' + g.id)));
            body.appendChild(el('div', 'gs-fcard-meta', fmtSize(g.size_bytes) + ' · ' + fmtCount(g.down_count) + ' 次下载'));
            card.appendChild(body);
            row.appendChild(card);
        });
        block.appendChild(row);
        // 横向滚动时卡片位移，预览立即停止防"飘"在错误的卡上
        row.addEventListener('scroll', stopHoverPreview, { passive: true });
        osbInitH(row);
        return block;
    }

    // ==================== 精选卡悬停动态预览（Steam 同款） ====================
    // 悬停 400ms 后缩略图原地播放管理端宣传视频（静音循环自动播）；无视频则 1.2s 轮播截图
    // （GIF 截图 <img> 原生动）。视频懒加载：hover 时才设 src，防整行卡片批量预载浪费流量
    var hprev = { timer: null, cyc: null, el: null };

    function stopHoverPreview() {
        clearTimeout(hprev.timer);
        clearInterval(hprev.cyc);
        hprev.cyc = null;
        if (hprev.el) {
            if (hprev.el.tagName === 'VIDEO') hprev.el.pause();
            hprev.el.remove();
            hprev.el = null;
        }
    }

    function attachHoverPreview(card, cover, g) {
        var vids = g.videos || [], shots = g.screenshots || [];
        if (!vids.length && shots.length < 2) return; // 无视频且截图不足 2 张（单张静止图轮播无意义）
        card.addEventListener('mouseenter', function () {
            clearTimeout(hprev.timer);
            hprev.timer = setTimeout(function () {
                stopHoverPreview();
                if (!card.isConnected) return; // 等待期间行已重建（切筛选/翻页）
                if (vids.length) {
                    var v = document.createElement('video');
                    v.className = 'gs-hprev';
                    v.muted = true; // 静音自动播（浏览器自动播放策略要求，Steam 悬停预览同为静音）
                    v.loop = true;
                    v.autoplay = true;
                    v.playsInline = true;
                    v.setAttribute('playsinline', '');
                    v.src = assetUrl(vids[0]);
                    v.addEventListener('error', function () { if (hprev.el === v) stopHoverPreview(); }); // 源失效回退封面
                    // 起播淡入：首帧渲染前保持透明露出封面，防加载期黑块闪现
                    v.addEventListener('playing', function () { v.classList.add('ready'); });
                    cover.appendChild(v);
                    hprev.el = v;
                    v.play().catch(function () {});
                } else {
                    var img = document.createElement('img');
                    img.className = 'gs-hprev';
                    img.alt = '';
                    img.draggable = false;
                    img.src = assetUrl(shots[0]);
                    // 图片解码完成才淡入，防半加载闪现
                    img.addEventListener('load', function () { img.classList.add('ready'); });
                    cover.appendChild(img);
                    hprev.el = img;
                    var i = 0;
                    hprev.cyc = setInterval(function () {
                        if (!hprev.el || !hprev.el.isConnected) { clearInterval(hprev.cyc); hprev.cyc = null; return; }
                        i = (i + 1) % shots.length;
                        hprev.el.src = assetUrl(shots[i]);
                    }, 1200);
                }
            }, 400);
        });
        card.addEventListener('mouseleave', stopHoverPreview);
    }

    // 标签聚合：统计出现次数按次数降序取前 14 个（首页全量结果由 renderStoreChrome 缓存到 state.allTags）
    function aggregateTags(list) {
        var counts = {};
        list.forEach(function (g) {
            (g.tags || []).forEach(function (t) {
                t = String(t || '').trim();
                if (t) counts[t] = (counts[t] || 0) + 1;
            });
        });
        return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 14);
    }

    // 标签胶囊筛选条（当前筛选态高亮；筛选态下用 state.allTags 全量缓存渲染，保证可切换/取消筛选）
    function buildTagbar(names) {
        if (!names.length) return null;
        var bar = el('div', 'gs-tagbar');
        var all = el('button', 'gs-pill' + (state.store.tag ? '' : ' active'), '全部');
        all.addEventListener('click', function () {
            if (!state.store.tag) return;
            state.store.tag = '';
            loadStore(true);
        });
        bar.appendChild(all);
        names.forEach(function (t) {
            var p = el('button', 'gs-pill' + (state.store.tag === t ? ' active' : ''), t);
            p.addEventListener('click', function () {
                state.store.tag = (state.store.tag === t) ? '' : t;
                loadStore(true);
            });
            bar.appendChild(p);
        });
        return bar;
    }

    // ==================== 我的游戏库页签 ====================
    // 拉取期间侧栏骨架行（Steam 同款灰块扫光）：数据到达 renderLibrary 分批渲染覆盖
    function renderLibSkeleton() {
        var sideRows = $('gsLibSideRows');
        sideRows.innerHTML = '';
        for (var i = 0; i < 8; i++) {
            var r = el('div', 'gs-lib-skel-row');
            r.appendChild(sk('sk-sq'));
            r.appendChild(sk('sk-bar'));
            sideRows.appendChild(r);
        }
        $('gsLibSideTitle').textContent = '库';
    }

    function loadLibrary() {
        if (!username) { renderLibrary(); return; }
        renderLibSkeleton();
        api('GET', '/api/game/library').then(function (res) {
            if (!res.ok) { toast(res.msg || '游戏库加载失败'); return; }
            state.lib = {};
            ((res.data && res.data.list) || []).forEach(function (item) {
                var gid = item.lib && item.lib.game_id;
                if (!gid) return;
                state.lib[gid] = item;
                if (item.game) state.games[gid] = item.game;
            });
            renderLibrary();
            updateBadges();
            if (state.detailId) updateInstallBox();
        });
    }

    // 库条目收集与排序（最近游玩倒序）：renderLibrary 与侧栏搜索过滤共用
    function libItemsSorted() {
        var items = [];
        for (var gid in state.lib) items.push(state.lib[gid]);
        items.sort(function (a, b) {
            var la = (a.lib && a.lib.last_play_at) || '', lb = (b.lib && b.lib.last_play_at) || '';
            return String(lb).localeCompare(String(la));
        });
        return items;
    }

    // 云存档同步中的侧栏文案（Steam 同款）：push=存档中（上传到云端） pull=读档中（从云端下载）；无则空串
    function saveSyncLabel(gid) {
        var m = state.saveSync[gid];
        return m === 'push' ? '存档中' : (m === 'pull' ? '读档中' : '');
    }

    // 侧栏行构建（分批器回调）：缩略图 + 名称 + 安装中环形进度 + 状态，_gid 供选中态行级切换
    function buildLibRow(item) {
        var lib = item.lib || {};
        var g = item.game || state.games[lib.game_id] || {};
        var running = !!state.running[lib.game_id];
        var sync = saveSyncLabel(lib.game_id);
        var row = el('div', 'gs-lib-srow' + (state.libSel === lib.game_id ? ' active' : '') + (running ? ' running' : '') + (sync ? ' cloudsync' : ''));
        row._gid = lib.game_id;
        row.appendChild(buildCover(g.cover, g.name, 'gs-lib-sthumb'));
        row.appendChild(el('div', 'gs-lib-sname', g.name || ('游戏 #' + lib.game_id)));
        // 云存档同步中（读档中/存档中）优先于运行中优先于安装态文案（Steam 库列表同款）
        row.appendChild(el('div', 'gs-lib-sstate', sync || (running ? '运行中' : (LIB_STATE_TEXT[lib.state] || '未安装'))));
        applyRowRing(row); // 有下载任务时才在名称与状态之间插入环形进度（构建即初始化）
        row.addEventListener('click', function () { state.libSel = lib.game_id; renderLibrary(); });
        // 右键菜单（自绘，禁系统菜单）：启动 / 属性（自定义启动参数+主程序）/ 移出库
        row.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation();
            openLibCtxMenu(lib.game_id, e.clientX, e.clientY);
        });
        return row;
    }

    // 侧栏安装中环形进度（自绘 SVG，遵守"禁用系统默认控件"）：底轨 + 主题色进度弧 + 居中百分比
    var RING_R = 10, RING_C = 2 * Math.PI * RING_R;
    function buildSideRing() {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'gs-lib-sprog');
        svg.setAttribute('viewBox', '0 0 26 26');
        svg.setAttribute('width', '26');
        svg.setAttribute('height', '26');
        ['gs-lib-sprog-track', 'gs-lib-sprog-fill'].forEach(function (cls) {
            var circle = document.createElementNS(NS, 'circle');
            circle.setAttribute('class', cls);
            circle.setAttribute('cx', '13');
            circle.setAttribute('cy', '13');
            circle.setAttribute('r', String(RING_R));
            circle.setAttribute('transform', 'rotate(-90 13 13)'); // 进度起点旋到正上方
            if (cls === 'gs-lib-sprog-fill') { // 进度弧：dasharray=周长，dashoffset 由剩余比例推算
                circle.setAttribute('stroke-dasharray', String(RING_C));
                circle.setAttribute('stroke-dashoffset', String(RING_C));
                svg._fill = circle;
            }
            svg.appendChild(circle);
        });
        var txt = document.createElementNS(NS, 'text');
        txt.setAttribute('class', 'gs-lib-sprog-text');
        txt.setAttribute('x', '13');
        txt.setAttribute('y', '13');
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'central');
        txt.setAttribute('font-size', '8');
        svg.appendChild(txt);
        svg._text = txt;
        return svg;
    }

    // 按当前下载任务刷新单行环：终态（完成/出错/取消）移除环，其余（queued/downloading/verifying/paused）
    // 一律视为"安装进行中"保留环——主进程每下完一个文件都会先发 state:'verifying' 再回到 'downloading'
    // （download-manager.js 逐文件校验），若只在 downloading/paused 显示，环会被反复移除+重建，
    // 左侧行高在 29px↔34px 间跳动，正是用户反馈的"按钮/元素颤抖"
    var RING_TERMINAL = { done: 1, error: 1, cancel: 1 };
    function applyRowRing(row) {
        var svg = row.querySelector('.gs-lib-sprog');
        var tid = state.taskByGame[row._gid];
        var t = tid !== undefined && tid !== null ? state.tasks[tid] : null;
        if (!t || RING_TERMINAL[t.state]) { if (svg) svg.remove(); return; }
        if (!svg) { // 首次出现进度：插到名称与状态文字之间（名称 flex:1 占据剩余空间）
            svg = buildSideRing();
            var st = row.querySelector('.gs-lib-sstate');
            if (st) row.insertBefore(svg, st); else row.appendChild(svg);
        }
        var pct = t.total > 0 ? Math.min(100, Math.max(0, (t.received || 0) / t.total * 100)) : 0;
        svg._fill.setAttribute('stroke-dashoffset', String(RING_C * (1 - pct / 100)));
        svg._text.textContent = Math.floor(pct) + '%';
    }

    // 侧栏所有行环原地同步（进度帧高频调用，仅改 SVG 属性不重建 DOM）
    function syncLibSideProgress() {
        var rows = $('gsLibSideRows').querySelectorAll('.gs-lib-srow');
        for (var i = 0; i < rows.length; i++) applyRowRing(rows[i]);
    }

    // 库侧栏行分批渲染器（万级入库防卡顿核心）：数据仍全量拉取（侧栏本地搜索过滤不受影响），
    // DOM 每批 80 条经 rAF 构建，滚动接近侧栏底部自动续批（IO root=gsLibSide，400px 预载）
    var libPager = mkPager($('gsLibSideRows'), $('gsLibSide'), buildLibRow, 80);

    // 同数据源判定（逐项引用比较，万项约 1ms 远低于重建 DOM 成本）+ 选中态行级切换：
    // 点击选中/取消选中只切 active 类，不触发整列重批（防闪烁与滚动位置丢失）
    libPager.sameAs = function (items) {
        if (this.items.length !== items.length) return false;
        for (var i = 0; i < items.length; i++) {
            if (this.items[i] !== items[i]) return false;
        }
        return this.items.length > 0;
    };

    libPager.refreshActive = function (sel) {
        var rows = $('gsLibSideRows').querySelectorAll('.gs-lib-srow');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('active', Number(rows[i]._gid) === Number(sel));
        }
    };

    // 侧栏行渲染（带关键词过滤）：搜索框输入时重置分批重绘行区（右侧详情/最近游戏保持不动），
    // 关键词按游戏名不区分大小写包含匹配；有关键词且无匹配时行区显示提示
    function renderLibRows(items) {
        var sideRows = $('gsLibSideRows');
        sideRows.innerHTML = '';
        var kw = ($('gsLibSearch').value || '').trim().toLowerCase();
        var shown = items.filter(function (item) {
            if (!kw) return true;
            var lib = item.lib || {};
            var g = item.game || state.games[lib.game_id] || {};
            return String(g.name || '').toLowerCase().indexOf(kw) >= 0;
        });
        if (kw && !shown.length) {
            sideRows.appendChild(el('div', 'gs-lib-empty', '无匹配游戏'));
            libPager.reset([]);
            osbTick($('gsLibSide'));
            return;
        }
        libPager.reset(shown);
    }

    // 库页签渲染：Steam 同款双栏——左侧游戏侧栏（搜索框 + 缩略图+名称+状态，选中高亮），
    // 右侧未选中时显示最近游戏横排，选中后显示 hero 大图 + 操作按钮 + 状态行 + 简介
    function renderLibrary() {
        var main = $('gsLibMain');
        main.innerHTML = '';
        var items = libItemsSorted();
        if (!username) {
            $('gsLibSideTitle').textContent = '库';
            renderLibRows(items);
            main.appendChild(el('div', 'gs-empty', '请先在主界面登录后再使用游戏中心'));
            return;
        }
        if (state.libSel && !state.lib[state.libSel]) state.libSel = 0; // 选中项已被移出库：回退
        $('gsLibSideTitle').textContent = '库（' + items.length + '）';
        if (libPager.sameAs(items)) {
            libPager.refreshActive(state.libSel); // 同数据源仅选中态变化：行级高亮切换不重建
        } else {
            renderLibRows(items);
        }
        if (!items.length) {
            main.appendChild(el('div', 'gs-empty', '游戏库还是空的'));
            var go = el('div', 'gs-lib-go');
            go.appendChild(mkBtn('前往商店', 'primary', function () {
                showView('store');
                if (!state.store.list.length) loadStore(true);
            }));
            main.appendChild(go);
            return;
        }
        if (!state.libSel) {
            main.appendChild(el('div', 'gs-lib-main-title', '最近游戏'));
            var recentRow = el('div', 'gs-lib-recent');
            var recent = items.filter(function (it) { return it.lib && it.lib.last_play_at; });
            (recent.length ? recent : items).slice(0, 8).forEach(function (it) {
                var lib = it.lib || {};
                var g = it.game || state.games[lib.game_id] || {};
                var card = el('div', 'gs-lib-rcard');
                var thumb = buildCover(g.cover, g.name, 'gs-lib-rthumb');
                var rfp = buildFriendsPlaying(g); // 好友正在玩标记（缩略图右下角，与商店卡同款）
                if (rfp) thumb.appendChild(rfp);
                card.appendChild(thumb);
                var bd = el('div', 'gs-lib-rbody');
                bd.appendChild(el('div', 'gs-lib-rname', g.name || ('游戏 #' + lib.game_id)));
                bd.appendChild(el('div', 'gs-lib-rmeta', lib.last_play_at ? '最近游玩 ' + fmtDate(lib.last_play_at) : '尚未游玩'));
                card.appendChild(bd);
                card.addEventListener('click', function () { state.libSel = lib.game_id; renderLibrary(); });
                // 悬停气泡（Steam 同款）：媒体轮播预览 + 游戏时间；移出即隐（与商店卡同口径 150ms 延迟）
                card.addEventListener('mouseenter', function () { showHover(g, card, { media: true, lib: lib }); });
                card.addEventListener('mouseleave', hideHover);
                recentRow.appendChild(card);
            });
            main.appendChild(recentRow);
        } else {
            main.appendChild(buildLibGamePage(state.libSel));
        }
        osbTick($('gsLibMain')); // 侧栏滚动条已在 renderLibRows 内刷新
    }

    // 库页轻刷新（状态迁移帧）：侧栏状态文案 + 选中游戏页的按钮行/元信息/安装目录原地更新，
    // 不重建主区 DOM——hero 模糊背景与公告图片 DOM 保留，安装/暂停/完成时不再整页可见闪烁
    // （原实现每次 refreshViews 都 renderLibrary 全量重建，图片重新解码绘制 + 滚动位置丢失）；
    // 仅当条目集合或选中项失效（首次入库/移出库/侧栏过滤）时才回退 renderLibrary 全量重建
    function syncLibrary() {
        var sel = state.libSel;
        // 未选中游戏（最近游戏列表）或选中项已移出库：主区整页重建；但侧栏行常被复用
        // （renderLibrary 的同数据源分支不重建行），故重建后必须显式同步侧栏状态文字与环形进度
        if (!sel || !state.lib[sel]) { renderLibrary(); syncLibSideState(); return; }
        var items = libItemsSorted();
        if (!libPager.sameAs(items)) { renderLibrary(); return; } // 侧栏行集合变化：需重建行 DOM（重建时自行初始化）
        libPager.refreshActive(sel);
        syncLibSideState();
        if (!syncLibGamePage(sel)) renderLibrary(); // 主区结构未就绪（未渲染过）时兜底全量重建
    }

    // 侧栏行状态文案原地更新（下载中/已暂停/已安装等），行 DOM 不重建
    function syncLibSideState() {
        var rows = $('gsLibSideRows').querySelectorAll('.gs-lib-srow');
        for (var i = 0; i < rows.length; i++) {
            var item = state.lib[rows[i]._gid];
            var running = !!state.running[rows[i]._gid];
            var sync = saveSyncLabel(rows[i]._gid);
            // 运行中/云存档同步类切换：状态字着色（CSS 归口），与文案同步原地更新不重建行 DOM
            if (rows[i].classList) {
                rows[i].classList.toggle('running', running);
                rows[i].classList.toggle('cloudsync', !!sync);
            }
            var st = rows[i].querySelector('.gs-lib-sstate');
            if (st) {
                // 文案未变则不写 textContent：下载中↔校验交替帧 lib.state 恒为 1（文案同为"下载中"），
                // 跳过相同的写入可避免无谓的文本节点替换与布局失效
                var txt = sync || (running ? '运行中' : (LIB_STATE_TEXT[item && item.lib ? item.lib.state : 0] || '未安装'));
                if (st.textContent !== txt) st.textContent = txt;
            }
        }
        syncLibSideProgress(); // 状态迁移帧同步环形进度显隐与取值
    }

    // 选中游戏页原地同步：操作按钮行 + 元信息 + 安装目录行 + 吸顶条主操作；
    // 主区尚无游戏页 DOM（未渲染过）时返回 false 由调用方回退全量重建
    function syncLibGamePage(gid) {
        var page = $('gsLibMain').querySelector('.gs-lib-game');
        var btns = page && page.querySelector('.gs-lib-actions-row');
        if (!btns) return false;
        var item = state.lib[gid] || {};
        var lib = item.lib || {};
        var g = item.game || state.games[gid] || {};
        var acts = gameActions(gid, true);
        // 按钮行签名守卫（任务ID + 文案 + 样式）：下载中↔校验 逐文件切换任务态都会走到这里，
        // 若每次都清空重建按钮行，按钮会重新绘制并在重建瞬间塌陷，出现用户反馈的"按钮尺寸闪烁/颤抖"；
        // 签名相同（同一任务、同为"暂停/取消"）则跳过重建；任务更换（taskId 变）时强制重建以刷新事件闭包
        var sig = libBtnSig(gid, acts);
        if (btns._sig !== sig) {
            btns.innerHTML = '';
            acts.forEach(function (a) { btns.appendChild(mkBtn(a.text, a.cls, a.fn)); });
            btns._sig = sig;
        }
        var meta = page.querySelector('.gs-lib-meta');
        if (meta) { meta.innerHTML = ''; buildLibMeta(meta, g, lib); }
        // 安装目录行：首装后出现/更新，无记录时移除（与整页构建时同构）
        var pathEl = page.querySelector('.gs-lib-path');
        var toprow = page.querySelector('.gs-lib-toprow');
        if (lib.install_path) {
            if (!pathEl && toprow) {
                pathEl = el('div', 'gs-lib-path', '');
                toprow.insertAdjacentElement('afterend', pathEl);
            }
            if (pathEl) pathEl.textContent = '安装目录：' + lib.install_path;
        } else if (pathEl) {
            pathEl.remove();
        }
        var act = acts[0] || null;
        if (libBar.gid !== gid || !libBar.act || !act || libBar.act.text !== act.text) libBarFill(gid, g, act);
        return true;
    }

    // 库页吸顶操作条 + 返回顶部胶囊（Steam 库页滚动同款）：全局单例（fixed 悬浮，不占内容流），
    // hero 滚出视口后吸顶条滑入（主操作按钮 + 游戏图标名），滚过一屏后底部中央浮现返回顶部
    var libBar = { inited: false, gid: 0, heroH: 300, act: null, bar: null, top: null, shown: null, topShown: null };

    function initLibBar() {
        if (libBar.inited) return;
        libBar.inited = true;
        var main = $('gsLibMain');
        // 吸顶条：磨砂玻璃底（主题变量），显示时按 gsLibMain 视口矩形对位（left/width 动态计算）
        var bar = el('div', 'gs-lib-sticky');
        bar.innerHTML = '';
        libBar.bar = bar;
        document.body.appendChild(bar);
        // 返回顶部胶囊：底部中央，点击平滑滚回（gsLibMain 的 scroll 事件驱动自绘滑块同步）
        var top = el('button', 'gs-lib-topbtn', '↑ 滚动到顶部');
        top.type = 'button';
        top.addEventListener('click', function () {
            try { main.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { main.scrollTop = 0; }
        });
        libBar.top = top;
        document.body.appendChild(top);
        main.addEventListener('scroll', libBarUpdate, { passive: true });
        window.addEventListener('resize', function () {
            if (libBar.shown || libBar.topShown) libBarLocate();
        });
    }

    // libBarLocate 吸顶条/返回顶部按 gsLibMain 当前视口矩形对位（内容区在窗口中的位置随布局变化）
    function libBarLocate() {
        var rect = $('gsLibMain').getBoundingClientRect();
        if (!rect.width) return;
        libBar.bar.style.left = rect.left + 'px';
        libBar.bar.style.width = rect.width + 'px';
        libBar.top.style.left = (rect.left + rect.width / 2) + 'px';
    }

    // libBarFill 主区每次重建（选游戏/状态刷新）时同步吸顶条内容与 hero 高度阈值
    function libBarFill(gid, g, act) {
        libBar.gid = gid;
        libBar.act = act || null;
        // 与 CSS clamp(190px, 24vw, 300px) 等价计算，免测量（构建时 hero 尚未入 DOM）
        libBar.heroH = Math.min(Math.max(190, window.innerWidth * 0.24), 300);
        var bar = libBar.bar;
        bar.innerHTML = '';
        if (act) bar.appendChild(mkBtn(act.text, act.cls, act.fn));
        if (g.cover) {
            var ic = el('img', 'gs-lib-sticky-ic');
            ic.src = assetUrl(g.cover);
            ic.draggable = false;
            bar.appendChild(ic);
        }
        bar.appendChild(el('span', 'gs-lib-sticky-name', g.name || ('游戏 #' + gid)));
    }

    // libBarUpdate 滚动归口：hero 完全滚出后显示吸顶条，滚过一屏显示返回顶部
    function libBarUpdate() {
        // 未进过库内游戏页时吸顶条实例尚未创建（bar/top 为 null），直接返回
        if (!libBar.inited) return;
        var main = $('gsLibMain');
        var libView = $('gsViewLibrary');
        if (!main || !libView || libView.classList.contains('hidden')) { libBarHide(); return; }
        var st = main.scrollTop || 0;
        var wantBar = st > libBar.heroH + 16;
        var wantTop = st > 360;
        if (wantBar !== libBar.shown) {
            libBar.shown = wantBar;
            if (wantBar) libBarLocate();
            libBar.bar.classList.toggle('show', wantBar);
        }
        if (wantTop !== libBar.topShown) {
            libBar.topShown = wantTop;
            if (wantTop) libBarLocate();
            libBar.top.classList.toggle('show', wantTop);
        }
    }

    function libBarHide() {
        if (libBar.shown) { libBar.shown = null; libBar.bar.classList.remove('show'); }
        if (libBar.topShown) { libBar.topShown = null; libBar.top.classList.remove('show'); }
    }

    // 库内游戏页右侧元信息（需要的空间/最后运行日期/游戏时间/版本）：整页构建与原地同步共用
    function buildLibMeta(meta, g, lib) {
        lib = lib || {};
        [
            ['需要的空间', fmtSize(g.size_bytes)],
            ['最后运行日期', lib.last_play_at ? fmtDate(lib.last_play_at) : '—'],
            ['游戏时间', lib.play_seconds > 0 ? fmtPlay(lib.play_seconds) : '—'],
            ['版本', lib.installed_version || LIB_STATE_TEXT[lib.state] || '未安装']
        ].forEach(function (m) {
            var cell = el('div', 'gs-lib-meta-item');
            cell.appendChild(el('div', 'gs-lib-meta-label', m[0]));
            cell.appendChild(el('div', 'gs-lib-meta-val', m[1]));
            meta.appendChild(cell);
        });
    }

    // 库内游戏页（Steam 库选中游戏同款）：hero 横幅（后台可配 banner，空回退封面）+
    // 操作按钮行 + 右侧元信息（需要的空间/最后运行/游戏时间/版本）+
    // 页签条（动态/商店页面/评测）+ 动态区（左栏公告卡 / 右栏更新历史）
    function buildLibGamePage(gid) {
        var item = state.lib[gid] || {};
        var lib = item.lib || {};
        var g = item.game || state.games[gid] || {};
        var wrap = el('div', 'gs-lib-game');
        // hero 横幅：banner（后台配置）优先，回退封面；Steam 同款模糊背景填充+底部渐隐名称
        var pic = g.banner || g.cover;
        if (pic) {
            // Steam 库页同款页面级模糊背景：同图放大深模糊铺在内容区顶端，向下渐隐
            var pbg = el('div', 'gs-lib-pagebg');
            pbg.style.backgroundImage = 'url("' + assetUrl(pic) + '")';
            wrap.appendChild(pbg);
        }
        var hero = el('div', 'gs-lib-hero');
        if (pic) {
            var hbg = el('div', 'gs-lib-hero-bg');
            hbg.style.backgroundImage = 'url("' + assetUrl(pic) + '")';
            hero.appendChild(hbg);
        }
        hero.appendChild(buildCover(pic, g.name, 'gs-lib-hero-img'));
        hero.appendChild(el('div', 'gs-lib-hero-name', g.name || ('游戏 #' + gid)));
        wrap.appendChild(hero);
        // 操作按钮行 + 右侧元信息（Steam 库顶部信息行同构）
        var acts = gameActions(gid, true);
        initLibBar();
        // 吸顶条内容同步（主操作=第一项），滚动过 hero 后浮现（内容随主区重建即时刷新）
        libBarFill(gid, g, acts[0] || null);
        var toprow = el('div', 'gs-lib-toprow');
        var btns = el('div', 'gs-lib-actions-row');
        acts.forEach(function (a) { btns.appendChild(mkBtn(a.text, a.cls, a.fn)); });
        btns._sig = libBtnSig(gid, acts); // 记录构建签名，避免首次 syncLibGamePage 无谓重建
        toprow.appendChild(btns);
        var meta = el('div', 'gs-lib-meta');
        buildLibMeta(meta, g, lib);
        toprow.appendChild(meta);
        wrap.appendChild(toprow);
        if (lib.install_path) wrap.appendChild(el('div', 'gs-lib-path', '安装目录：' + lib.install_path));
        // 页签条（Steam 同款横排）：动态为页内内容区；商店页面/评测跳详情视图（评测带锚点定位）
        var tabs = el('div', 'gs-lib-tabs');
        [['动态', null], ['商店页面', undefined], ['评测', 'reviews']].forEach(function (t) {
            var tb = el('button', 'gs-lib-tab' + (t[1] ? '' : ' active'), t[0]);
            if (t[0] !== '动态') {
                tb.addEventListener('click', function () { openDetail(gid, t[1]); });
            }
            tabs.appendChild(tb);
        });
        wrap.appendChild(tabs);
        // 动态区：懒加载详情接口（公告+版本），按游戏缓存；拉取期间显示骨架（公告卡×3 + 更新行×2）
        var feedBody = el('div', 'gs-lib-feed gs-lib-feed-skel');
        var skelCols = el('div', 'gs-lib-feed-cols');
        var skLeft = el('div', 'gs-lib-feed-col');
        for (var sn = 0; sn < 3; sn++) {
            var skb = el('div', 'gs-notice-skel');
            skb.appendChild(sk('sk-pic'));
            var sc = el('div', 'sk-col');
            sc.appendChild(sk('sk-bar w60'));
            sc.appendChild(sk('sk-bar w80'));
            sc.appendChild(sk('sk-bar'));
            skb.appendChild(sc);
            skLeft.appendChild(skb);
        }
        var skRight = el('div', 'gs-lib-feed-col side');
        for (var sv = 0; sv < 2; sv++) {
            var skr = el('div', 'gs-lib-skel-row');
            skr.appendChild(sk('sk-bar w60'));
            skRight.appendChild(skr);
        }
        skelCols.appendChild(skLeft);
        skelCols.appendChild(skRight);
        feedBody.appendChild(skelCols);
        wrap.appendChild(feedBody);
        loadLibFeed(gid, feedBody);
        return wrap;
    }

    // 动态数据懒加载：GET /api/game/{id}（含 notices+versions），按游戏缓存避免重复请求
    function loadLibFeed(gid, body) {
        var cached = state.libFeed[gid];
        if (cached) { renderLibFeed(gid, cached, body); return; }
        api('GET', '/api/game/' + gid).then(function (res) {
            if (!res.ok) { if (body.isConnected) body.textContent = res.msg || '动态加载失败'; return; }
            var d = res.data || {};
            state.games[gid] = d; // 全量详情同步进缓存（库摘要 → 全量）
            var feed = { notices: d.notices || [], versions: d.versions || [] };
            state.libFeed[gid] = feed;
            if (body.isConnected) renderLibFeed(gid, feed, body); // 响应回来已切走：丢弃
        }).catch(function () { if (body.isConnected) body.textContent = '网络异常'; });
    }

    // 动态渲染（Steam 库"动态"同款分栏）：左栏公告卡流（Steam 新闻卡左图右文）+
    // 右栏更新历史（版本号/日期/更新日志/大小·文件数），各自空态独立提示
    function renderLibFeed(gid, feed, body) {
        var g = state.games[gid] || {};
        body.className = 'gs-lib-feed';
        body.innerHTML = '';
        var cols = el('div', 'gs-lib-feed-cols');
        var left = el('div', 'gs-lib-feed-col');
        var right = el('div', 'gs-lib-feed-col side');
        var notices = feed.notices || [];
        left.appendChild(el('div', 'gs-lib-feed-head', '公告' + (notices.length ? '（' + notices.length + '）' : '')));
        if (!notices.length) {
            left.appendChild(el('div', 'gs-lib-feed-empty', '暂无公告'));
        } else {
            // 公告卡分批渲染（万级公告防卡顿）：每批 60 张 rAF 构建，滚动接近主区底部自动续批
            var np = mkPager(left, $('gsLibMain'), function (n) { return buildNoticeCard(g, n); }, 60);
            np.reset(notices);
        }
        var versions = feed.versions || [];
        right.appendChild(el('div', 'gs-lib-feed-head', '更新历史' + (versions.length ? '（' + versions.length + '）' : '')));
        if (!versions.length) {
            right.appendChild(el('div', 'gs-lib-feed-empty', '暂无更新'));
        } else {
            versions.forEach(function (v) {
                var row = el('div', 'gs-lib-update');
                var top = el('div', 'gs-lib-update-top');
                top.appendChild(el('div', 'gs-lib-update-ver', v.version || ''));
                top.appendChild(el('div', 'gs-lib-update-date', fmtDate(v.create_time || '')));
                row.appendChild(top);
                if (v.changelog) row.appendChild(el('div', 'gs-lib-update-log', v.changelog));
                row.appendChild(el('div', 'gs-lib-update-meta', [fmtSize(v.size_bytes), (v.file_count || 0) + ' 个文件'].join(' · ')));
                right.appendChild(row);
            });
        }
        cols.appendChild(left);
        cols.appendChild(right);
        body.appendChild(cols);
        osbTick($('gsLibMain'), 50); // 异步填充后刷新主区自绘滚动条
    }

    // 公告卡（多布局，管理端发布时自选样式）：
    // thumb=横向缩略图（左图右文，Steam 库动态紧凑卡）；
    // grid=图片网格（Steam 事件卡同款纵向流：1 图全宽 / 2 图两列 / ≥3 图三列最多 6 张尾张 +N）；
    // banner=通栏大图（首图全宽 cover 图上文下，余图缩略网格续排）；
    // 空/未知 layout 回退 thumb（旧数据零变化）；GIF 动图原生活动，坏图移除占位；
    // 纯图片公告（标题正文全空）thumb 自动转 grid（单图全宽更好看）；长正文 4 行截断点击展开
    function buildNoticeCard(g, n) {
        var imgs = Array.isArray(n.images) ? n.images : [];
        var layout = (n.layout === 'grid' || n.layout === 'banner') ? n.layout : 'thumb';
        // 纯图公告 thumb 转网格：无文字时左图右文右侧空荡，网格单图全宽更饱满
        if (layout === 'thumb' && !n.title && !n.content && imgs.length) layout = 'grid';
        var card = el('div', 'gs-notice-card' + (layout === 'thumb' ? ' row' : ''));
        var top = el('div', 'gs-notice-card-top');
        top.appendChild(el('div', 'gs-notice-card-tag', '公告'));
        top.appendChild(el('div', 'gs-notice-card-date', fmtDate(n.create_time || '')));
        // 头图地址归口（thumb 左图 / banner 大图共用；公告图空回退游戏 banner→cover）
        var headUrl = imgs[0] || n.cover || g.banner || g.cover || '';
        if (layout === 'thumb') {
            // 横向缩略图：左侧首图 200x112，右侧标签/日期/标题/摘要
            var pic = el('div', 'gs-notice-card-pic');
            if (headUrl) {
                var im = document.createElement('img');
                im.src = assetUrl(headUrl);
                im.loading = 'lazy';
                im.draggable = false;
                im.onerror = function () { pic.innerHTML = ''; pic.appendChild(buildPh(g.name || '公告')); };
                pic.appendChild(im);
            } else {
                pic.appendChild(buildPh(g.name || '公告'));
            }
            card.appendChild(pic);
            var main = el('div', 'gs-notice-card-main');
            main.appendChild(top);
            if (n.title) main.appendChild(el('div', 'gs-notice-card-title', n.title));
            if (n.content) main.appendChild(el('div', 'gs-notice-card-text', n.content));
            if (imgs.length > 1) main.appendChild(el('div', 'gs-notice-card-hint', '共 ' + imgs.length + ' 张图片'));
            card.appendChild(main);
        } else {
            card.appendChild(top);
            if (layout === 'banner') {
                // 通栏大图：首图全宽 cover（高封顶），标题/正文接图下，余图缩略网格续排
                if (headUrl) {
                    var bi = document.createElement('img');
                    bi.src = assetUrl(headUrl);
                    bi.loading = 'lazy';
                    bi.draggable = false;
                    bi.alt = '';
                    bi.className = 'gs-notice-card-banner';
                    bi.onerror = function () { if (bi.parentNode) bi.parentNode.removeChild(bi); };
                    card.appendChild(bi);
                }
                if (n.title) card.appendChild(el('div', 'gs-notice-card-title', n.title));
                if (n.content) card.appendChild(el('div', 'gs-notice-card-text', n.content));
                var rest = imgs.length > 1 ? imgs.slice(1) : [];
                if (rest.length) card.appendChild(buildNoticeGrid(rest));
            } else {
                // 图片网格：标题/正文在上，全部图片横排网格在下
                if (n.title) card.appendChild(el('div', 'gs-notice-card-title', n.title));
                if (n.content) card.appendChild(el('div', 'gs-notice-card-text', n.content));
                var shown = imgs.length ? imgs : (headUrl ? [headUrl] : []);
                if (shown.length) card.appendChild(buildNoticeGrid(shown));
            }
        }
        if (n.content) {
            card.style.cursor = 'pointer'; // 长正文可点击展开（纯图/短文卡无此交互）
            card.addEventListener('click', function () { card.classList.toggle('expanded'); });
        }
        return card;
    }

    // buildNoticeGrid 公告图片网格（grid/banner 布局共用）：1 图全宽 / 2 图两列 / ≥3 图三列，
    // 最多 6 张（尾张叠 +N 余图角标），GIF 原生播放，坏图整格移除
    function buildNoticeGrid(list) {
        var grid = el('div', 'gs-notice-card-grid n' + Math.min(list.length, 3));
        var cap = Math.min(list.length, 6);
        list.slice(0, cap).forEach(function (u, i) {
            var cell = el('div', 'gs-notice-card-cell');
            var im = document.createElement('img');
            im.src = assetUrl(u);
            im.loading = 'lazy';
            im.draggable = false;
            im.alt = '';
            im.onerror = function () { if (cell.parentNode) cell.parentNode.removeChild(cell); };
            cell.appendChild(im);
            if (i === 5 && list.length > 6) {
                cell.appendChild(el('div', 'gs-notice-card-more', '+' + (list.length - 6)));
            }
            grid.appendChild(cell);
        });
        return grid;
    }

    // ==================== 下载管理页签 ====================
    // 任务名称兜底解析：任务自带 → 商店/详情缓存 → 库缓存 → id 兜底
    function taskName(t) {
        if (t.name) return t.name;
        var g = state.games[t.gameId];
        if (g && g.name) return g.name;
        var lib = state.lib[t.gameId];
        if (lib && lib.game && lib.game.name) return lib.game.name;
        return '游戏 #' + (t.gameId || '?');
    }

    function buildTaskRow(t) {
        var row = el('div', 'gs-task');
        var head = el('div', 'gs-task-head');
        head.appendChild(el('div', 'gs-task-name', taskName(t)));
        if (t.via === 'bt') head.appendChild(el('div', 'gs-task-via', 'BT')); // 下载通道标识
        var stText = TASK_STATE_TEXT[t.state] || t.state || '—';
        head.appendChild(el('div', 'gs-task-state' + (t.state === 'done' || t.state === 'error' ? ' gray' : ''), stText));
        row.appendChild(head);
        if (t.fileRelPath) row.appendChild(el('div', 'gs-task-file', t.fileRelPath));

        var pct = t.total > 0 ? Math.min(100, (t.received || 0) / t.total * 100) : 0;
        var track = el('div', 'gs-progress');
        var fill = el('div', 'gs-progress-fill');
        fill.style.width = pct.toFixed(1) + '%';
        track.appendChild(fill);
        row.appendChild(track);

        var meta = el('div', 'gs-task-meta');
        meta.appendChild(el('span', '', pct.toFixed(1) + '%'));
        meta.appendChild(el('span', '', fmtSize(t.received) + ' / ' + fmtSize(t.total)));
        meta.appendChild(el('span', '', '速度 ' + fmtSpeed(t.speed)));
        meta.appendChild(el('span', '', '剩余 ' + (t.speed > 0 && t.total > 0 ? fmtEta((t.total - t.received) / t.speed) : '—')));
        if (t.state === 'error' && t.error) meta.appendChild(el('span', '', '原因：' + t.error));
        row.appendChild(meta);

        if (IN_ELECTRON && t.state !== 'done' && t.state !== 'verifying') {
            var acts = el('div', 'gs-task-actions');
            if (t.state === 'downloading') {
                acts.appendChild(mkBtn('暂停', '', function () { taskAction(t.taskId, 'pause'); }));
            } else { // paused / error → 继续
                acts.appendChild(mkBtn('继续', 'primary', function () { taskAction(t.taskId, 'resume'); }));
            }
            acts.appendChild(mkBtn('取消', '', function () { taskAction(t.taskId, 'cancel'); }));
            row.appendChild(acts);
        }
        return row;
    }

    function renderDownloads() {
        var rows = $('gsDlRows');
        rows.innerHTML = '';
        var empty = $('gsDlEmpty');
        var hint = $('gsDlHint');
        var ids = Object.keys(state.tasks);
        if (!IN_ELECTRON) {
            // 浏览器只读：下载由 PC 客户端主进程负责
            hint.textContent = '请在 PC 客户端中查看下载管理';
            hint.classList.remove('hidden');
            empty.classList.add('hidden');
        } else if (!ids.length) {
            hint.classList.add('hidden');
            empty.classList.remove('hidden');
        } else {
            hint.classList.add('hidden');
            empty.classList.add('hidden');
            ids.forEach(function (id) { rows.appendChild(buildTaskRow(state.tasks[id])); });
        }
        osbTick($('gsDlList'));
    }

    // 进入页签/启动时从主进程拉全量任务（页面刷新后恢复下载列表）
    function pullStatus() {
        if (!DESKTOP || !DESKTOP.gameDownload) return;
        Promise.resolve(DESKTOP.gameDownload({ action: 'status' })).then(function (r) {
            var list = Array.isArray(r) ? r : (r && (r.tasks || r.list)) || [];
            if (!Array.isArray(list)) list = [];
            list.forEach(function (raw) {
                var taskId = raw && (raw.taskId || raw.task_id || raw.id);
                if (!taskId) return;
                var t = state.tasks[taskId];
                if (!t) {
                    t = state.tasks[taskId] = {
                        taskId: taskId,
                        gameId: raw.gameId !== undefined ? raw.gameId : raw.game_id,
                        installDir: raw.installDir || raw.install_path || '',
                        version: raw.version || ''
                    };
                    if (t.gameId !== undefined && t.gameId !== null) state.taskByGame[t.gameId] = taskId;
                }
                ['name', 'version', 'received', 'total', 'speed', 'state', 'fileRelPath', 'error', 'installDir', 'via'].forEach(function (k) {
                    if (raw[k] !== undefined && raw[k] !== null) t[k] = raw[k];
                });
            });
            refreshViews();
        }).catch(function () { /* 主进程无任务时可能 reject：静默 */ });
    }

    // 页面加载/刷新/新开窗口时从主进程拉"正在运行的游戏"（恢复运行中态；与 pullStatus 同口径）
    function pullRunning() {
        if (!DESKTOP || !DESKTOP.gameRunningList) return;
        Promise.resolve(DESKTOP.gameRunningList()).then(function (list) {
            if (!Array.isArray(list)) return;
            state.running = {};
            list.forEach(function (x) {
                if (!x || x.gameId === undefined || x.gameId === null) return;
                state.running[x.gameId] = x.startedAt || Date.now();
                // 重启/刷新后重新申明"正在玩"（客户端断开时服务端已摘除 presence，此处补登记）
                api('POST', '/api/game/play/' + x.gameId, { action: 'start' });
            });
            if (list.length) ensurePlayHeartbeat();
            refreshViews();
        }).catch(function () { /* 查询失败静默：下次启动/退出事件仍会校正 */ });
    }

    // 任务操作：暂停/继续/取消（乐观更新本地态并同步服务端库状态；进度事件随后校正）
    function taskAction(taskId, action) {
        var t = state.tasks[taskId];
        if (!t) return;
        if (action === 'pause' || action === 'resume') {
            t.state = action === 'pause' ? 'paused' : 'downloading';
            if (t.gameId !== undefined) {
                putLibState(t.gameId, {
                    state: action === 'pause' ? 2 : 1,
                    installed_version: t.prevInstalled || '',
                    install_path: t.installDir || ''
                });
            }
        }
        DESKTOP.gameDownload({ action: action, taskId: taskId, gameId: t.gameId, username: username });
        if (action === 'cancel') {
            if (t.gameId !== undefined) {
                putLibState(t.gameId, {
                    state: 0,
                    installed_version: t.prevInstalled || '',
                    install_path: t.installDir || ''
                });
                if (state.taskByGame[t.gameId] === taskId) delete state.taskByGame[t.gameId];
            }
            delete state.tasks[taskId];
            toast('已取消下载');
        }
        refreshViews();
    }

    // ==================== 游戏操作（安装/启动/移出库） ====================
    function mkBtn(text, cls, fn) {
        var b = el('button', 'gs-btn' + (cls ? ' ' + cls : ''), text);
        b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
        return b;
    }

    // 按钮行签名（任务ID + 文案 + 样式）：供 syncLibGamePage 判断按钮行是否需要重建。
    // 下载中↔校验交替时签名不变（两态都产出"暂停/取消"）→ 跳过重建，消除按钮重绘/尺寸闪烁；
    // 任务更换（taskId 变化）时签名变化 → 强制重建，确保按钮事件闭包绑定到当前任务对象
    function libBtnSig(gid, acts) {
        var tid = state.taskByGame[gid];
        var t = tid !== undefined && tid !== null ? state.tasks[tid] : null;
        var parts = [t ? String(t.taskId) : ''];
        for (var i = 0; i < acts.length; i++) parts.push(acts[i].text + '|' + (acts[i].cls || ''));
        return parts.join(';');
    }

    // 依据游戏当前状态生成操作按钮定义（详情栏与库列表共用）
    // libState：null=未入库；0 未安装 1 下载中 2 暂停 3 已安装 4 待更新
    function gameActions(gid, includeRemove) {
        var g = state.games[gid] || {};
        var lib = state.lib[gid] && state.lib[gid].lib;
        var libState = lib ? lib.state :
            (g.in_library !== undefined && g.in_library !== null ? g.in_library : null);
        var task = state.taskByGame[gid] ? state.tasks[state.taskByGame[gid]] : null;
        var acts = [];
        if (!IN_ELECTRON) {
            // 浏览器只读：无下载/启动入口，仅保留移出库（API 可用，桌面侧取消自动旁路）
            if (includeRemove && lib) acts.push({ text: '移出库', cls: '', fn: function () { removeFromLib(gid); } });
            return acts;
        }
        if (task && task.state !== 'done') {
            // 有进行中任务：按钮跟随任务态（下载中/校验 → 暂停；暂停/出错 → 继续）
            if (task.state === 'downloading' || task.state === 'verifying') {
                acts.push({ text: '暂停', cls: '', fn: function () { taskAction(task.taskId, 'pause'); } });
            } else {
                acts.push({ text: '继续', cls: 'primary', fn: function () { taskAction(task.taskId, 'resume'); } });
            }
            acts.push({ text: '取消', cls: '', fn: function () { taskAction(task.taskId, 'cancel'); } });
        } else if (state.running[gid]) {
            // 运行中（Steam 同款）：启动入口原地显示为"运行中"，不再可点启动（进程退出自动回落）
            acts.push({ text: '运行中', cls: 'running', fn: function () { toast('游戏正在运行中'); } });
        } else {
            switch (libState) {
                case 3:
                    acts.push({ text: '启动', cls: 'primary', fn: function () { launchGame(gid); } });
                    break;
                case 4:
                    acts.push({ text: '更新', cls: 'primary', fn: function () { startInstall(g, true); } });
                    break;
                case 1:
                case 2:
                    // 服务端有下载态但本地无任务（页面刷新且主进程无任务）：提供重新下载
                    acts.push({ text: '重新下载', cls: 'primary', fn: function () { startInstall(g, true); } });
                    break;
                default:
                    acts.push({ text: '安装', cls: 'primary', fn: function () { startInstall(g, !!lib); } });
                    break;
            }
        }
        if (includeRemove && lib) acts.push({ text: '移出库', cls: '', fn: function () { removeFromLib(gid); } });
        return acts;
    }

    // 同步服务端库状态（PUT /api/game/library/{id}/state），成功后归并本地缓存供徽标/按钮即时联动
    function putLibState(gid, body) {
        if (!username) return;
        api('PUT', '/api/game/library/' + gid + '/state', body).then(function (res) {
            if (!res.ok) return;
            if (!state.lib[gid]) state.lib[gid] = { lib: {}, game: state.games[gid] || {} };
            var lib = state.lib[gid].lib;
            for (var k in body) lib[k] = body[k];
            if (state.games[gid]) state.games[gid].in_library = body.state;
            // 服务端合并后全量重绘兜底：进度帧已轻量化（不重建库主区），下载完成等迁移态
            // 的 PUT 响应晚于迁移帧到达时由这里补一次刷新，避免库页按钮/状态滞留旧值
            scheduleRefresh();
        });
    }

    // 安装/更新流程：选安装目录（已有路径复用） → POST 加入库取清单 → 主进程开始下载 → PUT 下载中。
    // 下载方式按管理端配置路由：download_method=1 走 BT/P2SP 混合（种子 + 服务器直链源），forceHttp
    // 为 BT 失败自动回退标记（同一游戏重走 HTTP 清单直连）
    function startInstall(g, reuseDir, forceHttp) {
        if (!username) { toast('请先在主界面登录后再使用游戏中心'); return; }
        if (!DESKTOP || !DESKTOP.gameDownload) { toast('请在 PC 客户端中下载安装'); return; }
        var gid = g.id;
        var libEntry = state.lib[gid];
        var dir = (libEntry && libEntry.lib && libEntry.lib.install_path) || '';
        var prevInstalled = (libEntry && libEntry.lib && libEntry.lib.installed_version) || '';

        var go = function (installDir) {
            api('POST', '/api/game/library/' + gid).then(function (res) {
                if (!res.ok) { toast(res.msg || '加入游戏库失败'); return; }
                var d = res.data || {};
                var manifest = d.manifest || {};
                var slug = manifest.slug || g.slug || '';
                // 下载方式路由：1=BT·服务端生成种子（P2SP 混合）2=BT·上传种子（纯 BT，不叠加直链源）
                var dlMethod = Number(g.download_method) || 0;
                var viaBt = !forceHttp && (dlMethod === 1 || dlMethod === 2) && !!slug; // BT 需种子锚点 slug
                var taskId = 'g' + gid + '-' + Date.now();
                state.tasks[taskId] = {
                    taskId: taskId,
                    gameId: gid,
                    name: g.name || '',
                    version: manifest.version || '',
                    installDir: installDir,
                    prevInstalled: prevInstalled,
                    received: 0,
                    total: manifest.size_bytes || 0,
                    speed: 0,
                    state: 'downloading',
                    fileRelPath: '',
                    via: viaBt ? 'bt' : 'http'
                };
                state.taskByGame[gid] = taskId;
                if (viaBt) {
                    // BT/P2SP：主进程下载种子（服务端 /api/game/torrent/{id} 与文件接口同水位鉴权）
                    // 后挂引擎；落盘 <installDir>/<slug>/<rel_path>（安装根多一层 slug，done 事件已归一）
                    DESKTOP.gameDownload({
                        action: 'start',
                        via: 'bt',
                        taskId: taskId,
                        gameId: gid,
                        installDir: installDir,
                        username: username,
                        serverBase: location.origin,
                        slug: slug,
                        torrentUrl: '/api/game/torrent/' + gid + '?version=' + encodeURIComponent(manifest.version || ''),
                        manifestVersion: manifest.version || '', // P2SP 直链源 base URL 构成（路径式鉴权）
                        p2sp: dlMethod === 1, // 仅服务端生成种子方式叠加 P2SP 直链源；上传种子为纯 BT
                        files: manifest.files || []
                    });
                    toast((dlMethod === 2 ? '开始 BT 下载（上传种子）：' : '开始 BT 下载：') + (g.name || ('游戏 #' + gid)));
                } else {
                    // 大文件下载交给主进程下载器（支持 Range 断点续传），页面只订阅进度
                    // 落盘 <installDir>/<slug>/<rel_path>（主进程同盘暂存后一次性换入，与 BT 通道归一）
                    DESKTOP.gameDownload({
                        action: 'start',
                        taskId: taskId,
                        gameId: gid,
                        installDir: installDir,
                        slug: slug || ('g' + gid),
                        username: username,
                        serverBase: location.origin,
                        files: manifest.files || []
                    });
                    toast('开始下载：' + (g.name || ('游戏 #' + gid)));
                }
                putLibState(gid, { state: 1, installed_version: prevInstalled, install_path: installDir });
                refreshViews();
            });
        };

        if (reuseDir && dir) { go(dir); return; }
        // 首次安装：Steam 同款自绘选盘弹窗（游戏信息行 + 磁盘容量条 + 剩余空间），选盘后主进程预创建 <盘>/CdonlgameApp
        openDiskPicker(Number(g.size_bytes) || 0, function (finalDir) { go(finalDir); }, g);
    }

    // ==================== Steam 同款选盘安装（自绘磁盘选择弹窗替代系统目录选择器） ====================
    var GS_INSTALL_DIRNAME = 'CdonlgameApp'; // 展示文案用；实际目录由主进程归口创建
    var diskPickSel = '';    // 弹窗内当前选中的盘根（'D:\'）
    var diskPickOkCb = null; // 选定回调（接收主进程预创建好的最终安装根）

    function fmtGb(bytes) {
        var gb = (Number(bytes) || 0) / (1024 * 1024 * 1024);
        return String(gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10);
    }

    // 打开选盘弹窗：sizeBytes 为待装游戏大小（所选盘剩余不足给警示），onOk 接收最终安装目录；
    // game 存在时为安装流程——顶部展示 Steam 同款游戏信息行（缩略图/名称/大小），设置流程传空则隐藏
    function openDiskPicker(sizeBytes, onOk, game) {
        diskPickOkCb = onOk || null;
        diskPickSel = '';
        var gbox = $('gsDiskGame');
        if (gbox) {
            gbox.innerHTML = '';
            if (game) {
                gbox.appendChild(buildCover(game.cover, game.name, 'gs-disk-gthumb'));
                gbox.appendChild(el('div', 'gs-disk-gname', game.name || ('游戏 #' + game.id)));
                gbox.appendChild(el('div', 'gs-disk-gsize', fmtSize(game.size_bytes)));
                gbox.classList.remove('hidden');
            } else {
                gbox.classList.add('hidden');
            }
        }
        var list = $('gsDiskList');
        list.innerHTML = '<div class="gs-disk-loading">正在读取磁盘信息…</div>';
        $('gsDiskMask').classList.remove('hidden');
        osbInit(list); // 磁盘列表挂自绘悬浮滑块（原生滚动条已被归零）
        osbTick(list, 100);
        var remembered = '';
        try { remembered = localStorage.getItem('gs_install_disk') || ''; } catch (e) { /* 忽略 */ }
        Promise.resolve(DESKTOP && DESKTOP.gameDiskList ? DESKTOP.gameDiskList() : []).then(function (disks) {
            list = $('gsDiskList');
            if (!list) return;
            list.innerHTML = '';
            if (!disks || !disks.length) {
                list.innerHTML = '<div class="gs-disk-loading">未读取到本地磁盘，请重试</div>';
                return;
            }
            // 上次选盘置顶并默认选中（Steam 同款记忆），其余按盘符排序
            disks = disks.slice().sort(function (a, b) {
                var ra = a.disk === remembered ? 0 : 1, rb = b.disk === remembered ? 0 : 1;
                return (ra - rb) || (a.disk < b.disk ? -1 : 1);
            });
            disks.forEach(function (d) {
                var lack = sizeBytes > 0 && d.free < sizeBytes;
                if (!diskPickSel && d.disk === remembered) diskPickSel = d.disk;
                var row = el('button', 'gs-disk-item' + (d.disk === diskPickSel ? ' sel' : ''));
                row.appendChild(el('span', 'gs-disk-letter', d.disk));
                var mid = el('div', 'gs-disk-mid');
                var cap = el('div', 'gs-disk-cap');
                var usedBar = el('i');
                usedBar.style.width = Math.min(100, Math.round((d.used / d.total) * 100)) + '%';
                if (lack) usedBar.classList.add('lack');
                cap.appendChild(usedBar);
                var meta = el('div', 'gs-disk-meta');
                meta.appendChild(el('span', 'gs-disk-free' + (lack ? ' lack' : ''),
                    '剩余 ' + fmtGb(d.free) + ' GB' + (lack ? '（空间不足）' : '')));
                meta.appendChild(el('span', '', '已用 ' + fmtGb(d.used) + ' GB'));
                meta.appendChild(el('span', '', '共 ' + fmtGb(d.total) + ' GB'));
                mid.appendChild(cap);
                mid.appendChild(meta);
                row.appendChild(mid);
                row.addEventListener('click', function () {
                    diskPickSel = d.disk;
                    var rows = list.querySelectorAll('.gs-disk-item');
                    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', rows[i] === row);
                });
                list.appendChild(row);
            });
            osbTick(list, 60); // 渲染完成后刷新滑块位置
        }).catch(function () {
            var l = $('gsDiskList');
            if (l) l.innerHTML = '<div class="gs-disk-loading">磁盘信息读取失败，请重试</div>';
        });
    }

    // 确定选盘：主进程预创建 <盘>/CdonlgameApp 后回调（记忆本次选盘，下次默认选中）
    $('gsDiskOk').addEventListener('click', function () {
        if (!diskPickSel) { toast('请先选择安装磁盘'); return; }
        var cb = diskPickOkCb;
        var done = function (dir) {
            try { localStorage.setItem('gs_install_disk', diskPickSel); } catch (e) { /* 忽略 */ }
            $('gsDiskMask').classList.add('hidden');
            diskPickOkCb = null;
            if (cb) cb(dir);
        };
        if (!DESKTOP || !DESKTOP.gamePrepareInstallDir) { done(diskPickSel + GS_INSTALL_DIRNAME); return; }
        DESKTOP.gamePrepareInstallDir(diskPickSel).then(function (r) {
            if (!r || !r.ok) { toast((r && r.error) || '创建安装目录失败'); return; }
            done(r.dir);
        }).catch(function () { toast('创建安装目录失败'); });
    });
    $('gsDiskCancel').addEventListener('click', function () {
        $('gsDiskMask').classList.add('hidden');
        diskPickOkCb = null;
    });

    // ==================== 游戏中心设置（一期：下载目录查看/更改；其余项二期扩展） ====================
    // 当前下载目录展示口径：已有安装记录取其 install_path，否则取上次选盘记忆推导
    function gsInstallRootText() {
        for (var gid in state.lib) {
            var lib = state.lib[gid] && state.lib[gid].lib;
            if (lib && lib.install_path) return lib.install_path;
        }
        var d = '';
        try { d = localStorage.getItem('gs_install_disk') || ''; } catch (e) { /* 忽略 */ }
        return d ? d + GS_INSTALL_DIRNAME : '';
    }

    function openGsSettings() {
        var dirText = gsInstallRootText();
        $('gsSetDir').textContent = dirText || '尚未选择（首次安装时选择安装位置）';
        $('gsSetMask').classList.remove('hidden');
    }

    $('gsSetChange').addEventListener('click', function () {
        if (!DESKTOP || !DESKTOP.gameDiskList) { toast('请在 PC 客户端中更改下载目录'); return; }
        $('gsSetMask').classList.add('hidden');
        // 更改仅重设默认安装盘（下次选盘默认选中），已装游戏不受影响
        openDiskPicker(0, function (finalDir) {
            toast('默认安装位置已设为 ' + finalDir);
        });
    });
    $('gsSetClose').addEventListener('click', function () {
        $('gsSetMask').classList.add('hidden');
    });

    // ==================== 头像悬停资料卡（主题色气泡：延时出现、鼠标可移入操作） ====================
    (function () {
        var userEl = $('gsUser'), card = $('gsUserCard');
        if (!userEl || !card || !username) return;
        var showTimer = null, hideTimer = null;
        var pwVal = '', pwShown = false;
        var renderPw = function () {
            var el1 = $('gsCardPw');
            if (!pwVal) { el1.textContent = '—'; return; }
            el1.textContent = pwShown ? pwVal : new Array(pwVal.length + 1).join('•');
            $('gsCardPwToggle').textContent = pwShown ? '隐藏' : '显示';
        };
        var fill = function () {
            var nameEl = $('gsUserName'), avEl = $('gsUserAv');
            $('gsCardName').textContent = (nameEl && nameEl.textContent) || username;
            $('gsCardAv').innerHTML = avEl ? avEl.innerHTML : ''; // 复用首字母块或头像 img
            // 账号ID + 当前游戏凭据（账号+游戏级派生；无游戏上下文时不显示凭据）
            $('gsCardUid').textContent = username || '—';
            var gid = currentGameId();
            var meta = gid ? gameLaunchMeta(gid) : null;
            var g = gid ? (state.games[gid] || (state.lib[gid] && state.lib[gid].game) || {}) : {};
            pwVal = (meta && meta.password) || '';
            pwShown = false;
            if (pwVal) {
                $('gsCardPwToggle').classList.remove('hidden');
                $('gsCardPwCopy').classList.remove('hidden');
                $('gsCardPwHint').textContent = '当前游戏：' + (g.name || ('游戏 #' + gid));
            } else {
                $('gsCardPwToggle').classList.add('hidden');
                $('gsCardPwCopy').classList.add('hidden');
                $('gsCardPwHint').textContent = gid ? '该游戏凭据加载中，可进入详情页查看' : '进入游戏详情/库页面可查看该游戏凭据';
            }
            renderPw();
        };
        var show = function () {
            fill();
            var r = userEl.getBoundingClientRect();
            card.style.top = Math.round(r.bottom + 8) + 'px';
            card.style.right = Math.max(Math.round(window.innerWidth - r.right), 8) + 'px';
            card.classList.remove('hidden');
        };
        var hide = function () { card.classList.add('hidden'); };
        userEl.addEventListener('mouseenter', function () {
            clearTimeout(hideTimer);
            clearTimeout(showTimer);
            showTimer = setTimeout(show, 300);
        });
        userEl.addEventListener('mouseleave', function () {
            clearTimeout(showTimer);
            hideTimer = setTimeout(hide, 180); // 留出移入气泡的间隙时间
        });
        card.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
        card.addEventListener('mouseleave', function () {
            hideTimer = setTimeout(hide, 180);
        });
        document.addEventListener('mousedown', function (e) {
            if (!card.classList.contains('hidden') && !card.contains(e.target) && !userEl.contains(e.target)) hide();
        });
        $('gsCardProfile').addEventListener('click', function () {
            hide();
            toast('个人资料页即将开放，可先在主界面查看');
        });
        $('gsCardSettings').addEventListener('click', function () {
            hide();
            openGsSettings();
        });
        // 凭据掩码切换 / 复制（默认掩码，降低截屏与旁人瞥见的暴露面）
        $('gsCardPwToggle').addEventListener('click', function (e) { e.stopPropagation(); pwShown = !pwShown; renderPw(); });
        $('gsCardPwCopy').addEventListener('click', function (e) { e.stopPropagation(); copyText(pwVal); });
    })();

    // 运行期间"正在玩"心跳：60s 一次复用 action=start（服务端据此刻入/续期 presence，
    // 好友侧"N 名好友正在玩"据此保持；客户端崩溃/异常退出时服务端 3 个周期后自动收敛）
    var playHbTimer = null;
    function ensurePlayHeartbeat() {
        if (playHbTimer) return;
        playHbTimer = setInterval(function () {
            var any = false;
            for (var gid in state.running) {
                any = true;
                api('POST', '/api/game/play/' + gid, { action: 'start' });
            }
            if (!any) { clearInterval(playHbTimer); playHbTimer = null; }
        }, 60000);
    }

    function onLaunched(gid, startedAt) {
        state.sessions[gid] = startedAt || Date.now();
        state.running[gid] = startedAt || Date.now(); // 侧栏行/启动按钮切"运行中"（game-start 广播兜底同口径）
        toast('已启动');
        api('POST', '/api/game/play/' + gid, { action: 'start' });
        ensurePlayHeartbeat(); // 运行期间保活"正在玩"（好友侧可见）
        refreshViews();
    }

    // ==================== 启动参数与凭据（Steam 同款"设置启动选项"） ====================
    // 当前"游戏上下文"id：详情页优先，其次库页选中（悬停卡凭据与启动参数归口同一上下文）
    function currentGameId() {
        if (state.detailId && state.games[state.detailId]) return state.detailId;
        if (state.libSel) return state.libSel;
        return 0;
    }

    // 取游戏启动元数据：管理端默认（相对主程序 exe/参数模板）+ 本账号对该游戏派生的专属密码
    function gameLaunchMeta(gid) {
        var g = state.games[gid] || {};
        var lib = state.lib[gid] && state.lib[gid].lib;
        if (!g.launch_args && lib && lib.game) g = lib.game; // 详情未加载时退化用库内快照
        return {
            exe: g.launch_exe || '',
            // 启动程序名称：管理端「启动程序路径」留空时，按 <名称>.exe 在安装根匹配同名主程序
            // （如 名称=War3 → War3.exe），使只填名称也能启动（匹配归口在主进程 gameResolveLaunchExe）
            name: g.launch_name || '',
            args: g.launch_args || '',
            password: g.launch_password || (lib && lib.launch_password) || ''
        };
    }

    // 参数分词：空白分隔 + 单/双引号分组（引号内保留空白），返回字符串数组
    function splitLaunchArgs(s) {
        var res = [], cur = '', q = '', started = false;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (q) {
                if (c === q) q = ''; else cur += c;
                continue;
            }
            if (c === '"' || c === "'") { q = c; started = true; continue; }
            if (/\s/.test(c)) { if (started || cur !== '') { res.push(cur); cur = ''; started = false; } continue; }
            cur += c;
        }
        if (started || cur !== '') res.push(cur);
        return res;
    }

    // 参数模板 → 参数数组：替换 {0}=登录账号、{1}=账号专属密码（spawn 直传数组，无需再转义引号）
    function buildLaunchArgs(tpl, gid) {
        tpl = String(tpl || '').trim();
        if (!tpl) return [];
        var meta = gameLaunchMeta(gid);
        var parts = splitLaunchArgs(tpl);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            out.push(parts[i].replace(/\{0\}/g, String(username || '')).replace(/\{1\}/g, String(meta.password || '')));
        }
        return out;
    }

    // 复制到剪贴板（优先 Clipboard API；不可用时回退临时 textarea + execCommand）
    function copyText(text) {
        text = String(text || '');
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, function () { fallbackCopy(text); });
            return;
        }
        fallbackCopy(text);
    }
    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            toast('已复制');
        } catch (e) { toast('复制失败'); }
    }

    // ==================== 库左侧列表右键菜单（自绘，禁系统菜单） ====================
    var ctxOpen = false;
    function closeCtxMenu() { $('gsCtxMenu').classList.add('hidden'); ctxOpen = false; }
    function openCtxMenu(x, y, items) {
        var m = $('gsCtxMenu');
        m.innerHTML = '';
        for (var i = 0; i < items.length; i++) {
            (function (it) {
                var row = el('div', 'gs-ctxmenu-item' + (it.danger ? ' danger' : ''), it.label);
                row.addEventListener('click', function (ev) {
                    ev.stopPropagation(); closeCtxMenu();
                    if (it.onClick) it.onClick();
                });
                m.appendChild(row);
            })(items[i]);
        }
        m.classList.remove('hidden');
        var w = m.offsetWidth, h = m.offsetHeight;
        m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
        m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
        ctxOpen = true;
    }
    document.addEventListener('mousedown', function (e) {
        if (ctxOpen && !$('gsCtxMenu').contains(e.target)) closeCtxMenu();
    });
    window.addEventListener('blur', function () { if (ctxOpen) closeCtxMenu(); });
    document.addEventListener('scroll', function () { if (ctxOpen) closeCtxMenu(); }, true);

    function openLibCtxMenu(gid, x, y) {
        var lib = state.lib[gid] && state.lib[gid].lib;
        var libState = lib ? Number(lib.state) : null;
        var items = [];
        // 启动入口仅已安装（3）可见：与库卡片按钮态一致（0未安装=安装 / 1下载中·2暂停=暂停·继续 / 4待更新=更新）
        if (state.running[gid]) items.push({ label: '运行中', onClick: function () { toast('游戏正在运行中'); } });
        else if (libState === 3) items.push({ label: '启动游戏', onClick: function () { launchGame(gid); } });
        items.push({ label: '属性', onClick: function () { openPropModal(gid); } });
        items.push({ label: '移出游戏库', danger: true, onClick: function () { removeFromLib(gid); } });
        openCtxMenu(x, y, items);
    }

    // ==================== 游戏属性弹窗（自定义启动参数 + 主程序路径覆盖） ====================
    var propGid = 0, propExe = '';
    function refreshPropExe() {
        var g = state.games[propGid] || {};
        if (propExe) $('gsPropExe').textContent = propExe;
        else if (g.launch_exe) $('gsPropExe').textContent = '游戏默认：' + g.launch_exe;
        else if (g.launch_name) $('gsPropExe').textContent = '按名称匹配：' + g.launch_name + '.exe';
        else $('gsPropExe').textContent = '自动探测（未自定义）';
    }
    function openPropModal(gid) {
        if (!gid) return;
        var g = state.games[gid] || (state.lib[gid] && state.lib[gid].game) || {};
        var lib = state.lib[gid] && state.lib[gid].lib;
        propGid = gid; propExe = '';
        $('gsPropTitle').textContent = (g.name || ('游戏 #' + gid)) + ' · 属性';
        $('gsPropDir').textContent = (lib && lib.install_path) || '未安装';
        $('gsPropArgs').value = '';
        refreshPropExe();
        initSaveSection(gid); // 云存档分栏（仅 PC 端显示；WEB 端隐藏该分栏按钮）
        $('gsPropMask').classList.remove('hidden');
        showPropPane('general'); // 每次打开归位到「通用」分栏
        if (DESKTOP && DESKTOP.gameGetLaunchOptions) {
            DESKTOP.gameGetLaunchOptions(gid).then(function (opts) {
                if (!opts || !opts.ok || propGid !== gid) return; // 期间切了游戏：丢弃过期响应
                if (opts.args) $('gsPropArgs').value = opts.args;
                if (opts.exe) { propExe = opts.exe; refreshPropExe(); }
            }).catch(function () {});
        }
    }
    // 属性弹窗左侧分栏导航（Steam 同款）：点左侧按钮切换右侧内容区，并刷新自绘悬浮滑块
    function showPropPane(name) {
        var items = $('gsPropNav').querySelectorAll('.gs-prop-navitem');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', items[i].getAttribute('data-pane') === name);
        }
        ['general', 'launch', 'cloud'].forEach(function (p) {
            $('gsPropPane' + cap(p)).classList.toggle('hidden', p !== name);
        });
        $('gsPropPanes').scrollTop = 0; // 切分栏回到顶部（分栏内容各自独立阅读）
        osbTick($('gsPropPanes'), 300);
    }
    (function () {
        var items = $('gsPropNav').querySelectorAll('.gs-prop-navitem');
        for (var i = 0; i < items.length; i++) {
            items[i].addEventListener('click', function () {
                showPropPane(this.getAttribute('data-pane'));
            });
        }
    })();
    $('gsPropArgs').addEventListener('keydown', function (e) { e.stopPropagation(); }); // 防输入被全局快捷键吞
    $('gsPropPickExe').addEventListener('click', function () {
        if (!DESKTOP || !DESKTOP.gameChooseGameExe) { toast('请在 PC 客户端中操作'); return; }
        DESKTOP.gameChooseGameExe().then(function (rr) {
            if (!rr || rr.canceled || !rr.filePath) return;
            propExe = rr.filePath; refreshPropExe();
        });
    });
    $('gsPropClearExe').addEventListener('click', function () { propExe = ''; refreshPropExe(); });
    $('gsPropCancel').addEventListener('click', function () { $('gsPropMask').classList.add('hidden'); });
    $('gsPropSave').addEventListener('click', function () {
        if (!propGid) return;
        if (!DESKTOP || !DESKTOP.gameSetLaunchOptions) { toast('请在 PC 客户端中操作'); return; }
        var args = $('gsPropArgs').value.trim();
        DESKTOP.gameSetLaunchOptions(propGid, propExe || '', args).then(function (r) {
            if (r && r.ok) { toast('已保存启动设置'); $('gsPropMask').classList.add('hidden'); }
            else toast((r && r.error) || '保存失败');
        }).catch(function () { toast('保存失败'); });
    });

    // ==================== 云存档区块（PC 端属性弹窗；Steam 同款云存档 P1） ====================
    function saveSectionAvailable() { return !!(DESKTOP && DESKTOP.gameSaveSync); }

    // 路径字段 → 数组（兼容 JSON 数组串 / 数组 / 换行串）
    function parseJsonArr(v) {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        try { var a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
    }
    function linesToArr(s) { return String(s || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }

    // 当前存档槽位（P3）：按游戏记录于内存（默认 default）；切换后启动/退出自动沿用同一槽位
    var saveSlots = {};
    function curSlot(gid) { return saveSlots[gid] || 'default'; }

    // 组装同步 payload（管理端默认来自游戏数据 save_paths/save_exclude；用户覆盖由主进程读 game-save.json）
    // extra：并入附加字段（如 resolve=冲突裁决 / force / mirror）
    function saveSyncPayload(gid, mode, extra) {
        var g = state.games[gid] || (state.lib[gid] && state.lib[gid].game) || {};
        var libDir = (state.lib[gid] && state.lib[gid].lib && state.lib[gid].lib.install_path) || '';
        var p = {
            gameId: gid, username: username, installDir: libDir,
            slug: String(g.slug || ''), // 内置兜底自适应：install_path 为安装根时锚定 <slug>/save，为游戏目录时用 save/**
            adminPaths: parseJsonArr(g.save_paths), adminExclude: parseJsonArr(g.save_exclude),
            mode: mode, slot: curSlot(gid)
        };
        if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k]; } }
        return p;
    }

    var SAVE_SRC_TEXT = { user: '我的覆盖', admin: '管理端默认', builtin: '内置兜底' };

    // 生效路径明细渲染（来源标签 + 生效目录 + 是否存在/越界）；列表内不滚动，超 8 条折叠计数
    function renderSavePreview(modes) {
        var box = $('gsPropSavePreview');
        if (!box) return;
        box.innerHTML = '';
        if (!modes || !modes.length) {
            box.appendChild(el('div', 'gs-save-prev-none', '未解析到生效路径（安装目录为空或路径不存在）'));
            return;
        }
        var limit = 8;
        for (var i = 0; i < modes.length && i < limit; i++) {
            var m = modes[i];
            var row = el('div', 'gs-save-prev-item');
            row.appendChild(el('span', 'gs-save-src', '[' + (SAVE_SRC_TEXT[m.source] || m.source) + '] '));
            row.appendChild(document.createTextNode((m.exists ? '✓ ' : '✗ ') + (m.baseDir || m.pattern)));
            if (m.rejected) row.appendChild(document.createTextNode('（越界已拒绝）'));
            box.appendChild(row);
        }
        if (modes.length > limit) box.appendChild(el('div', 'gs-save-prev-none', '共 ' + modes.length + ' 条生效路径（其余略）'));
    }

    function refreshSavePreview() {
        if (!saveSectionAvailable() || !propGid) return;
        var p = saveSyncPayload(propGid, '');
        DESKTOP.gameSavePathsPreview({ gameId: propGid, installDir: p.installDir, slug: p.slug, adminPaths: p.adminPaths, adminExclude: p.adminExclude })
            .then(function (r) { if (r && r.ok) renderSavePreview(r.modes); })
            .catch(function () {});
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function fmtTime(t) {
        t = Number(t) || 0;
        if (!t) return '—';
        var ms = t < 1e12 ? t * 1000 : t; // 秒/毫秒自适应
        var d = new Date(ms);
        if (isNaN(d.getTime())) return '—';
        var pad = function (x) { return (x < 10 ? '0' : '') + x; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function refreshSaveCloud() {
        if (!saveSectionAvailable() || !propGid) return;
        var gid = propGid;
        var cloudEl = $('gsPropSaveCloud');
        cloudEl.textContent = '查询中…';
        setSaveQuota(0, 0);
        DESKTOP.gameSaveManifest({ gameId: gid, username: username, slot: curSlot(gid) }).then(function (r) {
            if (propGid !== gid) return; // 期间切了游戏：丢弃过期响应
            if (!r || !r.ok) { cloudEl.textContent = '云端状态不可用'; setSaveBadge('err'); setSaveQuota(0, 0); return; }
            if (!r.exists) { cloudEl.textContent = '云端暂无存档'; setSaveBadge('idle'); setSaveQuota(0, r.max_total_size); return; }
            cloudEl.textContent = '云端 ' + (r.file_count || 0) + ' 个文件 · ' + fmtBytes(r.total_size) + ' · ' + fmtTime(r.update_time);
            setSaveBadge('ok');
            setSaveQuota(r.total_size, r.max_total_size);
        }).catch(function () { if (propGid === gid) { cloudEl.textContent = '云端状态不可用'; setSaveBadge('err'); setSaveQuota(0, 0); } });
    }

    // 同步状态图标（P3）：悬浮云图标随同步态切换（idle/ok/err/sync/conflict）
    var SAVE_BADGE_ICON = { idle: '☁', ok: '✓', err: '!', sync: '↻', conflict: '⚠' };
    function setSaveBadge(st) {
        var b = $('gsSaveBadge');
        if (!b) return;
        b.className = 'gs-save-badge ' + st;
        b.textContent = SAVE_BADGE_ICON[st] || '☁';
    }

    function setSaveProgress(txt, pct) {
        var prog = $('gsPropSaveProg'), bar = $('gsPropSaveBar'), t = $('gsPropSaveProgTxt');
        if (!prog) return;
        prog.classList.remove('hidden');
        if (t) t.textContent = txt;
        if (bar) bar.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%';
    }
    function clearSaveProgress() { var prog = $('gsPropSaveProg'); if (prog) prog.classList.add('hidden'); }

    // 云存档空间用量（每游戏配额）：已用/总量 + 已用百分比；缺配额（total<=0）时仅显示已用；≥90% 转警示色
    function setSaveQuota(used, total) {
        var txt = $('gsPropSaveQuotaTxt'), bar = $('gsPropSaveQuotaBar');
        if (!txt || !bar) return;
        used = Number(used) || 0;
        total = Number(total) || 0;
        if (total <= 0) {
            txt.textContent = used > 0 ? ('已用 ' + fmtBytes(used)) : '—';
            txt.classList.remove('warn');
            bar.style.width = '0%';
            bar.classList.remove('warn');
            return;
        }
        var pct = Math.min(100, used / total * 100);
        var warn = pct >= 90;
        var pctTxt = (pct > 0 && pct < 1) ? pct.toFixed(1) : String(Math.round(pct));
        txt.textContent = '空间 ' + fmtBytes(used) + ' / ' + fmtBytes(total) + '（已用 ' + pctTxt + '%）';
        txt.classList.toggle('warn', warn);
        bar.style.width = pct + '%';
        bar.classList.toggle('warn', warn);
    }

    // 当前槽位按钮文案（P3）
    function syncSlotBtn(gid) {
        var b = $('gsPropSaveSlotBtn');
        if (!b || !gid || !b.firstChild) return;
        b.firstChild.nodeValue = curSlot(gid) + ' ';
    }

    // 属性弹窗打开时初始化云存档区块：PC 端显示并载入用户覆盖 + 生效路径预览 + 云端状态
    function initSaveSection(gid) {
        var sec = $('gsPropSaveSec');
        if (!sec) return;
        var navCloud = $('gsPropNavCloud');
        if (!saveSectionAvailable()) {
            // WEB 端：隐藏云存档分栏（左侧按钮 + 右侧内容）
            sec.classList.add('hidden');
            navCloud.classList.add('hidden');
            return;
        }
        sec.classList.remove('hidden');
        navCloud.classList.remove('hidden');
        clearSaveProgress();
        setSaveBadge('idle');
        syncSlotBtn(gid);
        $('gsPropSavePaths').value = '';
        $('gsPropSaveExclude').value = '';
        $('gsPropSaveCloud').textContent = '查询中…';
        setSaveQuota(0, 0);
        renderSavePreview([]);
        var seq = gid;
        DESKTOP.gameSaveConfigGet(gid).then(function (r) {
            if (propGid !== seq || !r || !r.ok) return;
            $('gsPropSavePaths').value = (r.paths || []).join('\n');
            $('gsPropSaveExclude').value = (r.exclude || []).join('\n');
            refreshSavePreview();
        }).catch(function () {});
        refreshSaveCloud();
    }

    // 冲突裁决（P2）：弹出自绘三选一 → 按选择重发同步；返回最终同步结果（"稍后处理"→null）
    function handleSaveConflict(gid, cf, mode) {
        return promptSaveConflict(gid, cf).then(function (choice) {
            if (!choice) return null;
            setSaveBadge('sync');
            setSaveProgress('同步中…', 0);
            return DESKTOP.gameSaveSync(saveSyncPayload(gid, mode, { resolve: choice }));
        });
    }

    // 手动同步（push/pull）：进度经 onGameSaveProgress 订阅刷新；冲突弹窗裁决；完成后 toast 并刷新云端状态
    function runSaveSync(mode) {
        if (!saveSectionAvailable() || !propGid) return;
        var gid = propGid;
        setSaveBadge('sync');
        setSaveProgress('同步中…', 0);
        DESKTOP.gameSaveSync(saveSyncPayload(gid, mode)).then(function (r) {
            if (r && r.conflict) return handleSaveConflict(gid, r, mode);
            return r;
        }).then(function (r) {
            if (propGid === gid) { clearSaveProgress(); refreshSaveCloud(); refreshSavePreview(); }
            if (!r) return; // 冲突弹窗选择"稍后处理"：不做变更
            if (!r.ok) { setSaveBadge('err'); toast((r && r.error) || '云存档同步失败'); return; }
            var msg = (mode === 'push')
                ? ('已上传 ' + (r.uploaded || 0) + ' 个文件' + (r.note ? '（' + r.note + '）' : ''))
                : ('已下载 ' + (r.downloaded || 0) + ' 个文件' + (r.note ? '（' + r.note + '）' : ''));
            toast(msg);
        }).catch(function () { if (propGid === gid) clearSaveProgress(); setSaveBadge('err'); toast('云存档同步失败'); });
    }

    // ==================== 冲突弹窗（P2 自绘） ====================
    var confResolve = null;
    // 展示本地/云端两侧摘要并等待用户裁决；返回 Promise<'cloud'|'local'|'both'|null>
    function promptSaveConflict(gid, cf) {
        var local = (cf && cf.local) || {}, cloud = (cf && cf.cloud) || {};
        var lEl = $('gsConfLocal'), cEl = $('gsConfCloud');
        if (lEl) lEl.textContent = (local.file_count || 0) + ' 个文件 · ' + fmtBytes(local.total_size);
        if (cEl) {
            cEl.innerHTML = cloud.exists
                ? ((cloud.file_count || 0) + ' 个文件 · ' + fmtBytes(cloud.total_size) + '<br>版本 ' + (cloud.revision || 0) + (cloud.update_time ? (' · ' + fmtTime(cloud.update_time)) : ''))
                : '云端暂无存档';
        }
        setSaveBadge('conflict');
        $('gsConfMask').classList.remove('hidden');
        return new Promise(function (resolve) {
            confResolve = function (choice) {
                confResolve = null;
                $('gsConfMask').classList.add('hidden');
                resolve(choice);
            };
        });
    }
    $('gsConfCloudBtn').addEventListener('click', function () { if (confResolve) confResolve('cloud'); });
    $('gsConfLocalBtn').addEventListener('click', function () { if (confResolve) confResolve('local'); });
    $('gsConfBothBtn').addEventListener('click', function () { if (confResolve) confResolve('both'); });
    $('gsConfCancel').addEventListener('click', function () { if (confResolve) confResolve(null); });

    // ==================== 槽位管理弹窗（P3 自绘） ====================
    var slotGid = 0;
    function openSlotModal(gid) {
        if (!saveSectionAvailable() || !gid) return;
        slotGid = gid;
        $('gsSlotNewName').value = '';
        refreshSlotList();
        $('gsSlotMask').classList.remove('hidden');
        osbInit($('gsSlotList')); osbTick($('gsSlotList'), 60);
    }
    function refreshSlotList() {
        var list = $('gsSlotList');
        if (!list || !slotGid) return;
        var gid = slotGid;
        list.innerHTML = '';
        list.appendChild(el('div', 'gs-slot-empty', '加载中…'));
        DESKTOP.gameSaveSlots({ gameId: gid, username: username }).then(function (r) {
            if (slotGid !== gid) return;
            if (r && r.error) { list.innerHTML = ''; list.appendChild(el('div', 'gs-slot-empty', '槽位加载失败')); return; }
            renderSlotList((r && r.slots) || []);
        }).catch(function () { if (slotGid === gid) { list.innerHTML = ''; list.appendChild(el('div', 'gs-slot-empty', '槽位加载失败')); } });
    }
    function renderSlotList(slots) {
        var list = $('gsSlotList');
        var gid = slotGid;
        list.innerHTML = '';
        if (!slots.length) list.appendChild(el('div', 'gs-slot-empty', '暂无云端槽位，先上传一次存档即可创建'));
        slots.forEach(function (s) {
            var cur = s.slot === curSlot(gid);
            var row = el('div', 'gs-slot-item' + (cur ? ' cur' : ''));
            var main = el('div', 'gs-slot-main');
            var nm = el('div', 'gs-slot-name', s.slot);
            if (cur) nm.appendChild(el('span', 'gs-slot-cur', '当前'));
            main.appendChild(nm);
            main.appendChild(el('div', 'gs-slot-meta', (s.file_count || 0) + ' 个文件 · ' + fmtBytes(s.total_size) + ' · 版本 ' + (s.revision || 0) + (s.update_time ? (' · ' + s.update_time) : '')));
            row.appendChild(main);
            if (!cur) {
                var useBtn = el('button', 'gs-slot-mini', '切换');
                useBtn.type = 'button';
                useBtn.addEventListener('click', function () { switchSlot(gid, s.slot); });
                row.appendChild(useBtn);
            }
            var delBtn = el('button', 'gs-slot-mini danger', '删除');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                showConfirm('删除槽位', '删除云端槽位「' + s.slot + '」的全部存档与版本历史？此操作不可恢复。', '删除', function () {
                    DESKTOP.gameSaveSlotDelete({ gameId: gid, username: username, slot: s.slot }).then(function () {
                        if (curSlot(gid) === s.slot || saveSlots[gid] === s.slot) { saveSlots[gid] = 'default'; syncSlotBtn(gid); }
                        toast('已删除槽位 ' + s.slot);
                        refreshSlotList();
                        if (propGid === gid) refreshSaveCloud();
                    }).catch(function () { toast('删除失败'); });
                }, true);
            });
            row.appendChild(delBtn);
            list.appendChild(row);
        });
        osbTick(list, 60);
    }
    function switchSlot(gid, slot) {
        saveSlots[gid] = slot;
        syncSlotBtn(gid);
        toast('已切换到槽位 ' + slot);
        refreshSlotList();
        if (propGid === gid) refreshSaveCloud();
    }
    $('gsPropSaveSlotBtn').addEventListener('click', function () { if (propGid) openSlotModal(propGid); });
    $('gsSlotClose').addEventListener('click', function () { $('gsSlotMask').classList.add('hidden'); });
    $('gsSlotCreate').addEventListener('click', function () {
        var gid = slotGid;
        if (!gid) return;
        var name = String($('gsSlotNewName').value || '').trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { toast('槽位名称仅字母/数字/下划线/中划线，且不超过 32 位'); return; }
        if (name === curSlot(gid)) { toast('已处于该槽位'); return; }
        saveSlots[gid] = name; // 切到新空槽位：首次上传时云端按此 slot 创建
        $('gsSlotNewName').value = '';
        syncSlotBtn(gid);
        toast('已新建并切换到槽位 ' + name + '（上传一次后生效）');
        refreshSlotList();
        if (propGid === gid) refreshSaveCloud();
    });

    // ==================== 版本历史弹窗（P2 版本保留 + 回滚，自绘） ====================
    function openHistModal(gid) {
        if (!saveSectionAvailable() || !gid) return;
        $('gsHistHint').textContent = '槽位 ' + curSlot(gid) + ' · 仅显示保留窗口内的历史版本';
        refreshHistList(gid);
        $('gsHistMask').classList.remove('hidden');
        osbInit($('gsHistList')); osbTick($('gsHistList'), 60);
    }
    function refreshHistList(gid) {
        var list = $('gsHistList');
        if (!list) return;
        list.innerHTML = '';
        list.appendChild(el('div', 'gs-hist-empty', '加载中…'));
        DESKTOP.gameSaveHistory({ gameId: gid, username: username, slot: curSlot(gid) }).then(function (r) {
            if (!$('gsHistMask') || $('gsHistMask').classList.contains('hidden')) return; // 已关闭：丢弃
            if (r && r.error) { list.innerHTML = ''; list.appendChild(el('div', 'gs-hist-empty', '历史加载失败')); return; }
            var revs = (r && r.revisions) || [];
            list.innerHTML = '';
            if (!revs.length) { list.appendChild(el('div', 'gs-hist-empty', '暂无历史版本')); osbTick(list, 60); return; }
            revs.forEach(function (rv) {
                var row = el('div', 'gs-hist-item' + (rv.current ? ' cur' : ''));
                var main = el('div', 'gs-hist-main');
                var t = el('div', 'gs-hist-rev', '版本 ' + rv.revision);
                if (rv.current) t.appendChild(el('span', 'gs-hist-cur', '当前'));
                main.appendChild(t);
                main.appendChild(el('div', 'gs-hist-meta', (rv.file_count || 0) + ' 个文件 · ' + fmtBytes(rv.total_size) + (rv.create_time ? (' · ' + rv.create_time) : '')));
                row.appendChild(main);
                if (!rv.current) {
                    var btn = el('button', 'gs-slot-mini', '回滚');
                    btn.type = 'button';
                    btn.addEventListener('click', function () {
                        showConfirm('回滚版本', '将云端存档回滚到版本 ' + rv.revision + '？回滚会生成一个新版本，原版本仍保留在历史中。', '回滚', function () {
                            DESKTOP.gameSaveRollback({ gameId: gid, username: username, slot: curSlot(gid), revision: rv.revision }).then(function () {
                                toast('已回滚到版本 ' + rv.revision);
                                refreshHistList(gid);
                                if (propGid === gid) refreshSaveCloud();
                            }).catch(function (e) { toast((e && e.message) || '回滚失败'); });
                        });
                    });
                    row.appendChild(btn);
                }
                list.appendChild(row);
            });
            osbTick(list, 60);
        }).catch(function () { list.innerHTML = ''; list.appendChild(el('div', 'gs-hist-empty', '历史加载失败')); });
    }
    $('gsPropSaveHistory').addEventListener('click', function () { if (propGid) openHistModal(propGid); });
    $('gsHistClose').addEventListener('click', function () { $('gsHistMask').classList.add('hidden'); });

    // 打开本地存档目录（P3 手动管理入口）
    $('gsPropSaveOpenDir').addEventListener('click', function () {
        if (!propGid) return;
        if (!saveSectionAvailable() || !DESKTOP.gameSaveOpenDir) { toast('请在 PC 客户端中操作'); return; }
        var p = saveSyncPayload(propGid, '');
        DESKTOP.gameSaveOpenDir({ gameId: propGid, installDir: p.installDir, slug: p.slug, adminPaths: p.adminPaths, adminExclude: p.adminExclude }).then(function (r) {
            if (!r || !r.ok) toast((r && r.error) || '未找到可打开的存档目录');
        }).catch(function () { toast('打开目录失败'); });
    });

    $('gsPropSaveApply').addEventListener('click', function () {
        if (!propGid) return;
        if (!saveSectionAvailable()) { toast('请在 PC 客户端中操作'); return; }
        var paths = linesToArr($('gsPropSavePaths').value);
        var exclude = linesToArr($('gsPropSaveExclude').value);
        DESKTOP.gameSaveConfigSet(propGid, { paths: paths, exclude: exclude }).then(function (r) {
            if (!r || !r.ok) { toast((r && r.error) || '保存失败'); return; }
            toast('已保存云存档路径设置');
            refreshSavePreview();
        }).catch(function () { toast('保存失败'); });
    });
    $('gsPropSaveRestore').addEventListener('click', function () {
        if (!propGid) return;
        if (!saveSectionAvailable()) { toast('请在 PC 客户端中操作'); return; }
        $('gsPropSavePaths').value = '';
        $('gsPropSaveExclude').value = '';
        DESKTOP.gameSaveConfigSet(propGid, { paths: [], exclude: [] }).then(function () {
            toast('已恢复默认存档路径');
            refreshSavePreview();
        }).catch(function () {});
    });
    $('gsPropSaveUpload').addEventListener('click', function () { runSaveSync('push'); });
    $('gsPropSaveDownload').addEventListener('click', function () { runSaveSync('pull'); });

    // 云存档同步进度订阅：侧栏行全局显示"读档中/存档中"（Steam 同款），属性弹窗（当前游戏）显示进度条，终态收起
    if (DESKTOP && DESKTOP.onGameSaveProgress) {
        DESKTOP.onGameSaveProgress(function (evt) {
            if (!evt || !evt.gameId) return;
            // 侧栏行"读档中/存档中"（Steam 同款）：与属性弹窗无关，全局原地更新；终态立即回落
            if (evt.phase === 'done') {
                if (state.saveSync[evt.gameId]) { delete state.saveSync[evt.gameId]; syncLibSideState(); }
            } else {
                var m = (evt.mode === 'pull') ? 'pull' : 'push';
                if (state.saveSync[evt.gameId] !== m) { state.saveSync[evt.gameId] = m; syncLibSideState(); }
            }
            // 属性弹窗进度条：仅当前打开的游戏
            if (evt.gameId !== propGid) return;
            var phaseTxt = (evt.phase === 'done') ? '完成' : (evt.mode === 'push' ? '上传中' : '下载中');
            var cnt = evt.filesCount ? (' ' + Math.min((evt.fileIndex || 0) + 1, evt.filesCount) + '/' + evt.filesCount) : '';
            var name = evt.fileRelPath ? (' · ' + evt.fileRelPath) : '';
            setSaveProgress(phaseTxt + cnt + name, evt.percent || 0);
            if (evt.phase === 'done') { setTimeout(function () { clearSaveProgress(); refreshSaveCloud(); }, 800); }
            else setSaveBadge('sync');
        });
    }

    // 启动流程：读取用户启动覆盖（属性）→ 组装参数（{0}/{1} 替换）→ gameLaunch → needExe 降级手动选
    function launchGame(gid, exePath) {
        if (!username) { toast('请先在主界面登录后再使用游戏中心'); return; }
        if (!DESKTOP || !DESKTOP.gameLaunch) { toast('请在 PC 客户端中启动游戏'); return; }
        var meta = gameLaunchMeta(gid);
        var libDir = (state.lib[gid] && state.lib[gid].lib && state.lib[gid].lib.install_path) || '';
        // 启动前拉取云端存档（P1：仅本地无存档且云端有才下载；P2：两侧都改过则弹冲突裁决后再启动；失败不阻断启动）
        var pullP = (DESKTOP.gameSaveSync && libDir)
            ? DESKTOP.gameSaveSync(saveSyncPayload(gid, 'pull')).catch(function () { return null; })
            : Promise.resolve(null);
        pullP.then(function (sv) {
            if (sv && sv.conflict) return handleSaveConflict(gid, sv, 'pull'); // 等待用户裁决后再启动
            return sv;
        }).then(function (sv) {
            if (sv && sv.downloaded) toast('已从云端同步存档（' + sv.downloaded + ' 个文件）');
            else if (sv && sv.error) toast('云存档下载失败：' + sv.error);
            var optsP = DESKTOP.gameGetLaunchOptions ? DESKTOP.gameGetLaunchOptions(gid) : Promise.resolve(null);
            return optsP.then(function (opts) {
                var tpl = (opts && opts.args) ? opts.args : meta.args; // 用户自定义覆盖 > 管理端默认
                var payload = {
                    gameId: gid, username: username, installDir: libDir,
                    launchExe: meta.exe, launchName: meta.name, args: buildLaunchArgs(tpl, gid)
                };
                if (exePath) payload.exePath = exePath;
                return DESKTOP.gameLaunch(payload);
            });
        }).then(function (r) {
            if (r && r.ok) { onLaunched(gid, r.startedAt); return; }
            if (r && r.needExe) {
                showConfirm('选择游戏主程序', '未能找到游戏主程序（exe），请手动选择，选择后将开始游戏。', '选择文件', function () {
                    DESKTOP.gameChooseGameExe().then(function (rr) {
                        if (!rr || rr.canceled || !rr.filePath) return;
                        launchGame(gid, rr.filePath); // 带 exePath 重试
                    });
                });
                return;
            }
            toast((r && r.error) || '启动失败');
        }).catch(function () { toast('启动失败'); });
    }

    // 加入库/获取（Steam 同款购买流）：免费直接入库；收费弹自绘确认后扣积分（服务端严格扣减，
    // 余额不足 400 提示），响应实时刷新余额；成功后按钮态机自动切到已入库
    function joinLibrary(g) {
        var gid = g.id;
        var price = Number(g.price) || 0;
        var name = g.name || ('游戏 #' + gid);
        var doJoin = function () {
            api('POST', '/api/game/library/' + gid).then(function (res) {
                if (!res.ok) { toast(res.msg || '获取失败'); return; }
                var d = res.data || {};
                if (d.balance !== undefined && d.balance !== null) state.balance = d.balance;
                if (state.games[gid]) state.games[gid].in_library = 0;
                if (!state.lib[gid]) state.lib[gid] = { lib: { game_id: gid, state: 0 }, game: state.games[gid] || g };
                else state.lib[gid].lib.state = 0;
                toast(price > 0 ? '已获取「' + name + '」，扣除 ' + fmtPoints(price) + ' 积分' : '已加入游戏库');
                refreshViews();
                if (state.detailId === gid) { updateInstallBox(); refreshReviewBtn(); }
            });
        };
        if (price <= 0) { doJoin(); return; }
        var balTxt = state.balance === null ? '' : '，当前余额 ' + fmtPoints(state.balance) + ' 积分';
        if (state.balance !== null && state.balance < price) {
            showConfirm('积分不足', '获取「' + name + '」需要 ' + fmtPoints(price) + ' 积分，当前余额 ' + fmtPoints(state.balance) + '，请联系管理员发放。', '知道了', null);
            return;
        }
        showConfirm('用积分获取', '将扣除 ' + fmtPoints(price) + ' 积分获取「' + name + '」' + balTxt + '。', '确认获取', doJoin);
    }

    // 移出库：自绘确认 → 取消进行中下载 → DELETE（实付积分全额退还，服务端归口）；已安装文件保留在磁盘
    function removeFromLib(gid) {
        var g = state.games[gid] || {};
        var name = g.name || (state.lib[gid] && state.lib[gid].game && state.lib[gid].game.name) || ('游戏 #' + gid);
        showConfirm('移出游戏库', '确定将「' + name + '」移出游戏库？进行中的下载将被取消，已安装文件不会被删除，获取时支付的积分将全额退还。', '移出', function () {
            var taskId = state.taskByGame[gid];
            if (taskId && DESKTOP && DESKTOP.gameDownload) {
                DESKTOP.gameDownload({ action: 'cancel', taskId: taskId, gameId: gid, username: username });
                delete state.tasks[taskId];
                delete state.taskByGame[gid];
            }
            api('DELETE', '/api/game/library/' + gid).then(function (res) {
                if (!res.ok) { toast(res.msg || '移出失败'); return; }
                if (res.data && res.data.balance !== undefined && res.data.balance !== null) state.balance = res.data.balance;
                delete state.lib[gid];
                if (state.games[gid]) { state.games[gid].in_library = undefined; }
                toast('已移出游戏库，积分已退还');
                refreshViews();
                if (state.detailId === gid) openDetail(gid); // 详情正开着：重载详情数据
            });
        }, true);
    }

    // ==================== 详情视图 ====================
    var detailSeq = 0; // 详情请求序号：快速切换详情时丢弃过期响应

    function openDetail(id, anchor) {
        var seq = ++detailSeq;
        state.detailId = id;
        showView('detail');
        $('gsDetailTitle').textContent = '加载中…';
        var scroll = $('gsDetailScroll');
        destroyOsb(scroll);
        scroll.innerHTML = '';
        scroll.appendChild(el('div', 'gs-empty', '加载中…'));
        api('GET', '/api/game/' + id).then(function (res) {
            if (seq !== detailSeq) return; // 用户已切走：丢弃过期响应
            if (!res.ok) {
                scroll.innerHTML = '';
                scroll.appendChild(el('div', 'gs-empty', res.msg || '详情加载失败'));
                $('gsDetailTitle').textContent = '';
                return;
            }
            var d = res.data || {};
            state.games[id] = d;
            if (d.lib) state.lib[id] = { lib: d.lib, game: d };
            renderDetail(d);
            // 锚点定位（游戏库页签"评测"跳转用）：评测区滚动到视口顶部
            if (anchor === 'reviews') {
                var sec = scroll.querySelector('#gsRevSec');
                if (sec) { osbTick(scroll, 50); sec.scrollIntoView({ block: 'start' }); }
            }
        });
    }

    // 媒体项归一：视频在前（Steam 同款预告片置顶）+ 封面/截图图片去重混排
    function mediaItems(d) {
        var items = [];
        (d.videos || []).forEach(function (v) {
            var u = typeof v === 'string' ? v : (v && v.url);
            if (u) items.push({ type: 'video', url: assetUrl(u) });
        });
        var seen = {};
        var pushImg = function (u) {
            if (!u || seen[u]) return;
            seen[u] = true;
            items.push({ type: 'image', url: u });
        };
        if (d.cover) pushImg(assetUrl(d.cover));
        (d.screenshots || []).forEach(function (s) {
            pushImg(assetUrl(typeof s === 'string' ? s : (s && s.url) || ''));
        });
        return items;
    }

    // 媒体轮播：主舞台（图片/视频混排，视频内联播放）+ 缩略图横条（横向自绘悬浮滑块）；
    // 单项时隐藏箭头/指示/缩略图条；视频项缩略图带播放角标，切走时暂停并释放资源
    function buildMediaCarousel(items) {
        var box = el('div');
        var stage = el('div', 'gs-stage');
        var stageImg = document.createElement('img');
        stageImg.draggable = false;
        stage.appendChild(stageImg);
        var stageVideo = null; // 惰性创建：仅视频项激活时挂载（切走即释放，防后台续播/占用解码器）
        var idxEl = el('div', 'gs-stage-idx');
        var prev = el('button', 'gs-stage-nav prev');
        prev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M14.5 6l-6 6 6 6"/></svg>';
        var next = el('button', 'gs-stage-nav next');
        next.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9.5 6l6 6-6 6"/></svg>';
        prev.addEventListener('click', function (e) { e.stopPropagation(); show(cur - 1); });
        next.addEventListener('click', function (e) { e.stopPropagation(); show(cur + 1); });
        stage.appendChild(prev);
        stage.appendChild(next);
        stage.appendChild(idxEl);
        box.appendChild(stage);

        var multi = items.length > 1;
        var cur = 0;
        var thumbEls = [];
        var thumbs = null;
        if (multi) {
            thumbs = el('div', 'gs-thumbs gs-scroll');
            items.forEach(function (m, i) {
                var t = el('button', 'gs-thumb');
                if (m.type === 'video') {
                    var vd = document.createElement('video');
                    // #t=0.1 媒体片段：Chromium 在 preload="metadata" 下只取元数据不渲染画面（缩略图全黑），
                    // 带时间片段会 seek 到 0.1s 并渲染该帧，缩略图即首帧画面（Steam 同款）
                    vd.src = m.url + '#t=0.1';
                    vd.preload = 'metadata'; // 缩略图仅取首帧，不预加载完整视频
                    vd.muted = true;
                    t.appendChild(vd);
                    var badge = el('span', 'gs-thumb-play');
                    badge.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
                    t.appendChild(badge);
                } else {
                    var im = document.createElement('img');
                    im.src = m.url;
                    im.loading = 'lazy';
                    im.draggable = false;
                    t.appendChild(im);
                }
                t.addEventListener('click', function () { show(i); });
                thumbs.appendChild(t);
                thumbEls.push(t);
            });
            box.appendChild(thumbs);
            osbInitH(thumbs);
        } else {
            prev.style.display = 'none';
            next.style.display = 'none';
            idxEl.style.display = 'none';
        }

        function show(i) {
            cur = (i + items.length) % items.length;
            var m = items[cur];
            if (stageVideo) { // 旧视频释放
                stageVideo.pause();
                stageVideo.removeAttribute('src');
                stageVideo.load();
                stageVideo.remove();
                stageVideo = null;
            }
            if (m.type === 'video') {
                stageImg.style.display = 'none';
                stageVideo = document.createElement('video');
                stageVideo.src = m.url;
                stageVideo.controls = true;
                stageVideo.autoplay = true;
                stageVideo.className = 'gs-stage-video';
                stage.insertBefore(stageVideo, prev);
            } else {
                stageImg.style.display = 'block';
                stageImg.src = m.url;
            }
            idxEl.textContent = (cur + 1) + ' / ' + items.length;
            thumbEls.forEach(function (n, j) { n.classList.toggle('active', j === cur); });
            // 缩略图居中滚入可视区
            var t = thumbEls[cur];
            if (t && thumbs && thumbs.scrollWidth > thumbs.clientWidth) {
                thumbs.scrollLeft = Math.max(0, t.offsetLeft - (thumbs.clientWidth - t.offsetWidth) / 2);
            }
        }
        show(0);
        return box;
    }

    // 信息框行（label 左 / 值 右）
    function addSideRow(rows, label, val) {
        var row = el('div', 'gs-side-row');
        row.appendChild(el('span', '', label));
        row.appendChild(el('span', '', String(val)));
        rows.appendChild(row);
    }

    // ===== 游戏简介图文混排渲染：[img]图片URL 独立成行渲染为配图块（GIF 动图原生播放），
    // 其余行按原文显示；不含 [img] 标记的旧数据走原纯文本路径零变化
    function buildDetailDesc(text) {
        var raw = String(text || '');
        var frag = document.createDocumentFragment();
        if (raw.indexOf('[img]') === -1) {
            frag.appendChild(document.createTextNode(raw));
            return frag;
        }
        var lines = raw.split('\n');
        var buf = [];
        var flush = function () {
            if (!buf.length) return;
            frag.appendChild(el('p', 'gs-desc-p', buf.join('\n'))); // 连续文本行聚为段落（空行分段）
            buf = [];
        };
        for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^\s*\[img\]\s*(\S+)\s*$/);
            if (m) {
                flush();
                var img = document.createElement('img');
                img.className = 'gs-desc-img';
                img.src = assetUrl(m[1]);
                img.loading = 'lazy';
                img.draggable = false;
                img.alt = '';
                img.onload = function () { osbTick($('gsDetailScroll')); }; // 图片异步撑高后刷新自绘滚动条
                img.onerror = function () { this.classList.add('gm-broken'); osbTick($('gsDetailScroll')); };
                frag.appendChild(img);
            } else if (lines[i].trim() === '') {
                flush();
            } else {
                buf.push(lines[i]);
            }
        }
        flush();
        return frag;
    }

    function renderDetail(d) {
        var scroll = $('gsDetailScroll');
        destroyOsb(scroll);
        var olds = scroll.querySelectorAll('.gs-thumbs');
        for (var i = 0; i < olds.length; i++) destroyOsb(olds[i]);
        scroll.innerHTML = '';
        $('gsDetailTitle').textContent = d.name || ('游戏 #' + d.id);

        var wrap = el('div', 'gs-detail-wrap');
        var main = el('div', 'gs-detail-main');

        // ===== 左列·媒体轮播（Steam 同款：预告片视频在前 + 封面/截图混排） =====
        var media = mediaItems(d);
        if (media.length) main.appendChild(buildMediaCarousel(media));
        else {
            // 无视频无封面无截图：显示主题色占位舞台（保持两栏布局观感，不留空白）
            var stgPh = el('div', 'gs-stage');
            stgPh.appendChild(buildPh(d.name || ''));
            main.appendChild(stgPh);
        }

        // ===== 左列·游戏简介（图文混排：[img] 行渲染配图块，其余行纯文本） =====
        var descSec = el('div', 'gs-section');
        descSec.appendChild(el('div', 'gs-section-title', '游戏简介'));
        var descBox = el('div', 'gs-desc');
        descBox.appendChild(buildDetailDesc(d.description || d.short_desc || '暂无介绍'));
        descSec.appendChild(descBox);
        main.appendChild(descSec);

        // 版本历史已迁至游戏库页签的库内游戏页"动态"区（Steam 同款，公告+版本更新混排）
        wrap.appendChild(main);

        // ===== 右列·信息框 =====
        var side = el('div', 'gs-side');
        var infoBox = el('div', 'gs-side-box');
        infoBox.appendChild(buildCover(d.cover, d.name, 'gs-side-cover'));
        var rows = el('div', 'gs-side-rows');
        addSideRow(rows, '开发商', d.developer || '—');
        addSideRow(rows, '发行商', d.publisher || '—');
        addSideRow(rows, '最新版本', d.latest_version || '—');
        addSideRow(rows, '游戏大小', fmtSize(d.size_bytes));
        addSideRow(rows, '下载次数', fmtCount(d.down_count) + ' 次');
        infoBox.appendChild(rows);
        if (d.tags && d.tags.length) {
            var tags = el('div', 'gs-side-tags');
            d.tags.forEach(function (t) { tags.appendChild(el('span', 'gs-tag', String(t))); });
            infoBox.appendChild(tags);
        }
        side.appendChild(infoBox);

        // ===== 右列·安装框（状态行+按钮，进度事件原地刷新） =====
        var installBox = el('div', 'gs-side-box');
        installBox.id = 'gsInstallBox';
        side.appendChild(installBox);

        wrap.appendChild(side);

        // ===== 评测区（Steam 专区页同款：全宽汇总/筛选 + 左主列表 + 右"最近发布"双栏） =====
        // id 归口锚点：游戏库页签"评测"页签跳转后定位到此
        var revSec = buildReviewSection(d);
        revSec.id = 'gsRevSec';
        wrap.appendChild(revSec);
        loadReviews(d.id, true);
        loadRecentReviews(d.id);

        scroll.appendChild(wrap);

        updateInstallBox(d);
        osbInit(scroll);
        osbTick(scroll, 900);
    }

    // 安装框渲染：库状态行 + 已装信息 + 操作按钮（库状态/任务态联动；浏览器只读给提示）
    function updateInstallBox(d) {
        var box = $('gsInstallBox');
        if (!box || !state.detailId) return;
        var gid = state.detailId;
        var g = d || state.games[gid];
        if (!g) return;
        var lib = state.lib[gid] && state.lib[gid].lib;
        var libState = lib ? lib.state :
            (g.in_library !== undefined && g.in_library !== null ? g.in_library : null);
        box.innerHTML = '';
        // 未入库：Steam 同款购买块（价格行 + 余额 + 获取按钮；已入库才出现安装/启动按钮组）
        if (libState === null || libState === undefined) {
            box.appendChild(el('div', 'gs-install-state', '获取游戏'));
            var priceRow = el('div', 'gs-price-row');
            if ((Number(g.price) || 0) > 0) {
                priceRow.appendChild(el('span', 'gs-price-ico', '⚡'));
                priceRow.appendChild(el('span', 'gs-price', fmtPoints(g.price)));
                priceRow.appendChild(el('span', 'gs-price-unit', '积分'));
            } else {
                priceRow.appendChild(el('span', 'gs-price free', '免费'));
            }
            box.appendChild(priceRow);
            if (username && state.balance !== null) {
                box.appendChild(el('div', 'gs-install-sub', '当前余额：' + fmtPoints(state.balance) + ' 积分'));
            }
            if (!username) {
                box.appendChild(el('div', 'gs-bar-hint', '请先在主界面登录后再使用游戏中心'));
                return;
            }
            var buyActs = el('div', 'gs-install-actions');
            buyActs.appendChild(mkBtn((Number(g.price) || 0) > 0 ? '用积分获取' : '加入库', 'primary', function () { joinLibrary(g); }));
            box.appendChild(buyActs);
            if (!IN_ELECTRON) box.appendChild(el('div', 'gs-bar-hint', '下载与启动请在 PC 客户端中进行'));
            return;
        }
        box.appendChild(el('div', 'gs-install-state', LIB_STATE_TEXT[libState] || '未入库'));
        var sub = el('div', 'gs-install-sub');
        if (lib && lib.installed_version) sub.appendChild(el('div', '', '已安装版本：' + lib.installed_version));
        if (lib && lib.install_path) sub.appendChild(el('div', '', '安装目录：' + lib.install_path));
        sub.appendChild(el('div', '', '最新版本：' + (g.latest_version || '—')));
        sub.appendChild(el('div', '', '游戏大小：' + fmtSize(g.size_bytes)));
        box.appendChild(sub);
        var acts = el('div', 'gs-install-actions');
        gameActions(gid, false).forEach(function (a) {
            acts.appendChild(mkBtn(a.text, a.cls, a.fn));
        });
        box.appendChild(acts);
        if (!IN_ELECTRON) box.appendChild(el('div', 'gs-bar-hint', '下载与启动请在 PC 客户端中进行'));
    }

    // ==================== 用户评测区（Steam 同款：汇总胶囊/筛选/评测卡/写评测弹窗） ====================
    var REV_UP_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2 10h4v11H2zM22 11c0-1.1-.9-2-2-2h-5.2l.9-4.3c.1-.5-.1-1-.5-1.3L14 2 7.6 9.2c-.4.4-.6.9-.6 1.4V19c0 1.1.9 2 2 2h8c.8 0 1.5-.5 1.8-1.2l3-7c.1-.2.2-.5.2-.8v-1z"/></svg>';
    var REV_DOWN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M22 3h-4v11h4zM2 13c0 1.1.9 2 2 2h5.2l-.9 4.3c-.1.5.1 1 .5 1.3L10 22l6.4-7.2c.4-.4.6-.9.6-1.4V5c0-1.1-.9-2-2-2H7c-.8 0-1.5.5-1.8 1.2l-3 7-.2.8v1z"/></svg>';
    var REV_BUBBLE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5-.2 1-.7 2.3-1.7 3.3 0 0 2.6-.2 4.6-1.5 1.1.3 2.4.5 3.7.5 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>';
    var REV_TRUNCATE = 200; // 长文截断阈值（超出显示"阅读全文"原地展开，Steam 同款）
    var revPick = 1;   // 评测弹窗当前推荐选择（1=推荐 0=不推荐）
    var revTarget = 0; // 评测弹窗目标游戏 id

    // 评测区骨架（Steam 专区页同款）：全宽标题行 + 全宽汇总/筛选容器 + 左右双栏
    // （左"最有价值的评测"主列表单列大卡 + 右 300px"最近发布"小卡流带左分隔线）
    function buildReviewSection(d) {
        var sec = el('div', 'gs-section gs-review-section');
        var head = el('div', 'gs-review-head');
        head.appendChild(el('div', 'gs-section-title', '用户评测'));
        var lib = state.lib[d.id] && state.lib[d.id].lib;
        if (username && lib) { // Steam 同款：拥有才可评（服务端二次校验）
            var wb = mkBtn(state.reviews.mine ? '编辑我的评测' : '写评测', '', function () { openReviewModal(d.id); });
            sec._revBtn = wb; // 评测加载后回写文案（首渲染时 mine 尚未知）
            head.appendChild(wb);
        }
        sec._revHead = head; // 供购买入库后就地补挂写评测按钮
        sec.appendChild(head);
        // 全宽顶部容器：汇总条 + 筛选行（renderReviews 填充；双栏化后从卡流中移出，避免瀑布跨列 hack）
        var top = el('div', 'gs-review-top');
        top.id = 'gsReviewTop';
        sec.appendChild(top);
        // 左右双栏
        var cols = el('div', 'gs-review-cols');
        var main = el('div', 'gs-review-main');
        main.appendChild(el('div', 'gs-rev-col-title', '最有价值的评测'));
        var body = el('div', 'gs-review-body');
        body.id = 'gsReviewBody';
        // 评测卡骨架×2（Steam 同款灰块扫光）：数据到达 renderReviews 全量重建覆盖
        for (var si = 0; si < 2; si++) {
            var skb = el('div', 'gs-rev-skel');
            var sh = el('div', 'sk-head');
            sh.appendChild(sk('sk-av'));
            sh.appendChild(sk('sk-bar'));
            skb.appendChild(sh);
            skb.appendChild(sk('sk-line'));
            skb.appendChild(sk('sk-line w70'));
            body.appendChild(skb);
        }
        main.appendChild(body);
        cols.appendChild(main);
        var aside = el('div', 'gs-review-aside');
        aside.appendChild(el('div', 'gs-rev-col-title', '最近发布'));
        var rbody = el('div', 'gs-review-recent');
        rbody.id = 'gsRecentBody';
        aside.appendChild(rbody);
        cols.appendChild(aside);
        sec.appendChild(cols);
        return sec;
    }

    // 评测区根元素归口（gsReviewBody 双栏化后父级是 gs-review-main，向上遍历找评测区根）
    function reviewSectionOf(body) {
        var node = body.parentElement;
        while (node && !node.classList.contains('gs-review-section')) node = node.parentElement;
        return node;
    }

    // 购买入库后就地补挂"写评测"按钮（打开详情早于购买的场景；Steam 同款购买后即可评，无需重开详情）
    function refreshReviewBtn() {
        var body = $('gsReviewBody');
        if (!body) return;
        var sec = reviewSectionOf(body);
        if (!sec || sec._revBtn || !state.detailId || !username) return;
        if (!(state.lib[state.detailId] && state.lib[state.detailId].lib)) return;
        var wb = mkBtn(state.reviews.mine ? '编辑我的评测' : '写评测', '', function () { openReviewModal(state.detailId); });
        sec._revBtn = wb;
        sec._revHead.appendChild(wb);
    }

    // 右栏"最近发布"加载（page=1&size=5&sort=latest 一次性；切游戏刷新，不随筛选/分页变；
    // latest 按 create_time 排序，避免编辑评测刷 update_time 造成小卡浮上来）
    function loadRecentReviews(gid) {
        state.reviews.recent_gid = gid;
        state.reviews.recent = [];
        api('GET', '/api/game/reviews/' + gid + '?page=1&size=5&sort=latest&type=all').then(function (res) {
            if (!res.ok || state.reviews.recent_gid !== gid || state.detailId !== gid) return; // 已切走：丢弃过期响应
            state.reviews.recent = (res.data && res.data.list) || [];
            renderRecentReviews();
        });
    }

    // 评测列表加载（每页 10，type=all/1/0；汇总始终全量口径随每页下发）
    function loadReviews(gid, reset) {
        var rv = state.reviews;
        if (reset) {
            // mine 与筛选无关（自己的评测恒存在），仅切换游戏时才清空；
            // 否则筛"推荐/不推荐"（响应不含自己的评测）会把按钮文案错置回"写评测"
            var fresh = rv.gid !== gid;
            rv.gid = gid; rv.list = []; rv.page = 0; rv.has_more = false;
            rv.total = 0; rv.positive = 0; rv.summary = '';
            rv.rendered = 0; // 渲染游标归位（renderReviews 走全量重建覆盖骨架/旧列表）
            if (fresh) rv.mine = null;
        }
        if (rv.loadingRev) return; // 无限滚动防重入（IO 可能在加载中反复触发）
        rv.loadingRev = true;
        var page = rv.page + 1;
        api('GET', '/api/game/reviews/' + gid + '?page=' + page + '&type=' + rv.type).then(function (res) {
            rv.loadingRev = false;
            if (!res.ok) {
                var bd = $('gsReviewBody');
                if (bd && state.detailId === gid) {
                    bd.innerHTML = '';
                    bd.appendChild(el('div', 'gs-review-empty', res.msg || '评测加载失败'));
                }
                return;
            }
            if (state.reviews.gid !== gid || state.detailId !== gid) return; // 已切走：丢弃过期响应
            var d = res.data || {};
            rv.page = d.page || page;
            rv.total = d.total || 0;
            rv.positive = d.positive || 0;
            rv.summary = d.summary_text || '';
            rv.has_more = !!d.has_more;
            if (reset) rv.list = [];
            (d.list || []).forEach(function (it) {
                if (rv.type === 'all' && username && it.username === username) rv.mine = it;
                rv.list.push(it);
            });
            renderReviews();
        });
    }

    // 主列表渲染（Steam 专区页同款）：汇总条/筛选渲染到全宽 gsReviewTop，卡片流渲染到左栏 gsReviewBody；
    // 卡片流增量渲染——reset 时清空重建（覆盖骨架/旧列表），追加页只 append 新卡防几千条全量重绘卡顿，
    // "加载更多"按钮由底部 infbox + IO（root=gsDetailScroll，400px 预载）替代为滚动自动加载
    function renderReviews() {
        var body = $('gsReviewBody');
        if (!body) return;
        var rv = state.reviews;
        // 写评测按钮文案随 mine 刷新（首渲染时 mine 尚未知）
        var sec = reviewSectionOf(body);
        if (sec && sec._revBtn) sec._revBtn.textContent = rv.mine ? '编辑我的评测' : '写评测';
        // 全宽顶部：汇总行（好评率胶囊 + 总评数 + 正负比例条）+ 筛选行
        var top = $('gsReviewTop');
        if (top) {
            top.innerHTML = '';
            if (rv.total > 0) {
                var pct = Math.round(rv.positive / rv.total * 100);
                var sum = el('div', 'gs-rev-sum');
                sum.appendChild(el('span', 'gs-rev-cap', rv.summary));
                sum.appendChild(el('span', 'gs-rev-total', '(' + fmtCount(rv.total) + ' 篇评测)'));
                var bar = el('div', 'gs-rev-bar');
                var pos = el('div', 'gs-rev-bar-pos');
                pos.style.width = pct + '%';
                bar.appendChild(pos);
                sum.appendChild(bar);
                sum.appendChild(el('span', 'gs-rev-pct', pct + '% 好评'));
                top.appendChild(sum);
            }
            var filters = el('div', 'gs-rev-filters');
            [['all', '全部'], ['1', '推荐'], ['0', '不推荐']].forEach(function (p) {
                var b = el('button', 'gs-pill' + (rv.type === p[0] ? ' active' : ''), p[1]);
                b.addEventListener('click', function () {
                    if (rv.type === p[0]) return;
                    rv.type = p[0];
                    loadReviews(rv.gid, true);
                });
                filters.appendChild(b);
            });
            top.appendChild(filters);
        }
        // 左栏主列表卡片流（单列，增量）：游标 0=需清空重建（含首屏骨架覆盖），否则只追加新卡
        var rendered = rv.rendered || 0;
        if (!rendered) {
            if (body._infBox && body._infBox._infIO) { body._infBox._infIO.disconnect(); body._infBox._infIO = null; }
            body._infBox = null;
            body.innerHTML = '';
        }
        if (!rv.list.length) {
            body.appendChild(el('div', 'gs-review-empty', rv.total > 0 ? '该筛选下暂无评测' : '暂无数据'));
            rv.rendered = 0;
        } else {
            for (var i = rendered; i < rv.list.length; i++) body.appendChild(buildReviewCard(rv.list[i]));
            rv.rendered = rv.list.length;
            // 底部无限滚动容器（每页重建，旧 IO 已在上文断开）
            var inf = el('div', 'gs-infbox');
            body.appendChild(inf);
            body._infBox = inf;
            if (rv.has_more) {
                fillInfBox(inf, true, '');
                attachInf($('gsDetailScroll'), inf, function () {
                    var cur = state.reviews;
                    if (!cur.loadingRev && cur.has_more && cur.gid === state.detailId) loadReviews(cur.gid, false);
                });
            } else {
                fillInfBox(inf, false, '已加载全部 ' + fmtCount(rv.total) + ' 篇评测');
            }
        }
        osbTick($('gsDetailScroll'));
    }

    // 右栏"最近发布"小卡流渲染（Steam 专区页同款；无评论区）
    function renderRecentReviews() {
        var body = $('gsRecentBody');
        if (!body) return;
        var recent = state.reviews.recent;
        body.innerHTML = '';
        if (!recent.length) {
            body.appendChild(el('div', 'gs-review-empty', '暂无数据'));
        } else {
            recent.forEach(function (it) { body.appendChild(buildReviewMini(it)); });
        }
        osbTick($('gsDetailScroll'));
    }

    // 右栏小卡（Steam 同款）：头部行（头像+用户名+右侧日期/时长）→ 正文截断 → 有帮助行
    function buildReviewMini(it) {
        var card = el('div', 'gs-rev-mini');
        var head = el('div', 'gs-rev-mini-head');
        var av = el('div', 'gs-rev-avatar sm');
        if (it.avatar) {
            var im = document.createElement('img');
            im.src = assetUrl(it.avatar);
            im.onerror = function () { av.innerHTML = ''; av.textContent = initialOf(it.username); };
            av.appendChild(im);
        } else {
            av.textContent = initialOf(it.username);
        }
        head.appendChild(av);
        head.appendChild(el('div', 'gs-rev-mini-name', it.username || '用户'));
        var meta = el('div', 'gs-rev-mini-meta');
        meta.appendChild(el('span', '', fmtDate(it.create_time)));
        meta.appendChild(el('span', '', '总时数 ' + fmtRevHours(it.play_hours)));
        head.appendChild(meta);
        card.appendChild(head);
        card.appendChild(buildRevContent(it.content || '', true));
        // 有帮助行（他人评测；自己的评测不显示——主列表同款口径）
        if (username && it.username !== username) {
            var help = el('button', 'gs-rev-help' + (it.liked ? ' liked' : ''));
            help.innerHTML = REV_UP_SVG + '<i>有帮助 ' + fmtCount(it.helpful) + '</i>';
            help.addEventListener('click', function () {
                api('POST', '/api/game/review/helpful', { review_id: it.id }).then(function (res) {
                    if (!res.ok) { toast(res.msg || '操作失败'); return; }
                    var d2 = res.data || {};
                    it.liked = !!d2.liked;
                    it.helpful = d2.helpful || 0;
                    help.classList.toggle('liked', it.liked); // 原地更新态，不整卡重绘
                    var sp = help.querySelector('i');
                    if (sp) sp.textContent = '有帮助 ' + fmtCount(it.helpful);
                });
            });
            card.appendChild(help);
        }
        return card;
    }

    // 评测正文长文展开：超阈值截断 + "阅读全文"原地展开/收起（主列表大卡与右栏小卡通用；
    // compact=右栏小卡走 4 行 CSS 截断样式）
    function buildRevContent(text, compact) {
        var box = el('div', compact ? 'gs-rev-content mini' : 'gs-rev-content');
        var txt = String(text || '');
        if (txt.length <= REV_TRUNCATE) {
            box.textContent = txt;
            return box;
        }
        var full = false;
        var btn = el('button', 'gs-rev-expand', '阅读全文');
        btn.addEventListener('click', function () { full = !full; paint(); });
        function paint() {
            box.textContent = full ? txt : (txt.slice(0, REV_TRUNCATE) + '…');
            if (compact) box.classList.toggle('expanded', full); // 右栏小卡展开态解除 4 行 CSS 截断
            box.appendChild(btn);
            btn.textContent = full ? '收起' : '阅读全文';
        }
        paint();
        return box;
    }

    // 评测卡（Steam 同款卡内分栏）：左用户栏（头像+用户名+我的评测徽标）+
    // 右内容栏（推荐/不推荐横条+游玩时长 → 正文 → 有帮助；自己的评测不显示有帮助）
    function buildReviewCard(it) {
        var card = el('div', 'gs-rev-card');
        // 左栏：头像 + 用户名（+ 我的评测徽标）
        var user = el('div', 'gs-rev-user');
        var av = el('div', 'gs-rev-avatar');
        if (it.avatar) {
            var im = document.createElement('img');
            im.src = assetUrl(it.avatar);
            im.onerror = function () { av.innerHTML = ''; av.textContent = initialOf(it.username); };
            av.appendChild(im);
        } else {
            av.textContent = initialOf(it.username);
        }
        user.appendChild(av);
        var uinfo = el('div', 'gs-rev-uinfo');
        uinfo.appendChild(el('div', 'gs-rev-uname', it.username || '用户'));
        if (username && it.username === username) uinfo.appendChild(el('div', 'gs-rev-mine-tag', '我的评测'));
        user.appendChild(uinfo);
        card.appendChild(user);
        // 右栏：推荐横条（+游玩时长）→ 正文 → 有帮助
        var main2 = el('div', 'gs-rev-main2');
        var topline = el('div', 'gs-rev-topline');
        var rec = el('span', 'gs-rev-rec ' + (it.recommended === 1 ? 'up' : 'down'));
        rec.innerHTML = (it.recommended === 1 ? REV_UP_SVG : REV_DOWN_SVG) + '<i>' + (it.recommended === 1 ? '推荐' : '不推荐') + '</i>';
        topline.appendChild(rec);
        topline.appendChild(el('div', 'gs-rev-hours', '总时数 ' + fmtRevHours(it.play_hours)));
        main2.appendChild(topline);
        main2.appendChild(buildRevContent(it.content || '', false));
        if (username && it.username !== username) {
            var help = el('button', 'gs-rev-help' + (it.liked ? ' liked' : ''));
            help.innerHTML = REV_UP_SVG + '<i>有帮助 ' + fmtCount(it.helpful) + '</i>';
            help.addEventListener('click', function () {
                api('POST', '/api/game/review/helpful', { review_id: it.id }).then(function (res) {
                    if (!res.ok) { toast(res.msg || '操作失败'); return; }
                    var d2 = res.data || {};
                    it.liked = !!d2.liked;
                    it.helpful = d2.helpful || 0;
                    help.classList.toggle('liked', it.liked); // 原地更新态，不整卡重绘
                    var sp = help.querySelector('i');
                    if (sp) sp.textContent = '有帮助 ' + fmtCount(it.helpful);
                });
            });
            main2.appendChild(help);
        }
        // 评论区入口（Steam 同款气泡+计数，点开内嵌展开；自己的评测也有评论区）
        var replyBtn = el('button', 'gs-rev-reply-btn');
        var replyBox = el('div', 'gs-rev-replies hidden');
        function repaintReplyBtn() {
            replyBtn.innerHTML = REV_BUBBLE_SVG + '<i>' + ((it.reply_count > 0) ? '评论 ' + fmtCount(it.reply_count) : '评论') + '</i>';
        }
        replyBtn.addEventListener('click', function () {
            var show = replyBox.classList.contains('hidden');
            replyBox.classList.toggle('hidden', !show);
            if (show && !replyBox._loaded) {
                replyBox._loaded = true;
                buildReplyArea(it, replyBox, repaintReplyBtn);
            }
        });
        repaintReplyBtn();
        main2.appendChild(replyBtn);
        main2.appendChild(replyBox);
        card.appendChild(main2);
        return card;
    }

    // 评论区构建（Steam 同款内嵌展开；朋友圈 MomentComment 同款楼中楼平铺"张三回复李四"）：
    // 楼层列表（正序）+ 输入行（登录才显示，未登录只读浏览）；回复指定人带前置标签可取消；
    // 删除无确认弹窗（微信删除评论同款）；计数随发布/删除与按钮文案原地联动
    function buildReplyArea(it, box, repaintBtn) {
        box.innerHTML = '';
        var listEl = el('div', 'gs-rev-reply-list');
        box.appendChild(listEl);
        var replyTo = 0, replyToUser = '';
        var inputEl = null, replyTag = null, tagX = null;
        if (username) {
            var inputRow = el('div', 'gs-rev-reply-inputrow');
            replyTag = el('span', 'gs-rev-reply-tag hidden');
            tagX = el('span', 'gs-rev-reply-tagx', '×');
            tagX.addEventListener('click', function () { setReplyTo(0, ''); });
            inputEl = document.createElement('input');
            inputEl.className = 'gs-rev-reply-input';
            inputEl.placeholder = '发表你的评论…';
            inputEl.maxLength = 500;
            var sendBtn = el('button', 'gs-rev-reply-send', '发送');
            sendBtn.addEventListener('click', sendReply);
            inputEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') sendReply(); });
            inputRow.appendChild(replyTag);
            inputRow.appendChild(inputEl);
            inputRow.appendChild(sendBtn);
            box.appendChild(inputRow);
        }
        function setReplyTo(id, name) {
            replyTo = id;
            replyToUser = name;
            if (replyTag) {
                replyTag.textContent = name ? ('回复 @' + name + ' ') : '';
                if (name) replyTag.appendChild(tagX);
                replyTag.classList.toggle('hidden', !name);
            }
            if (name && inputEl) inputEl.focus();
        }
        function sendReply() {
            var content = inputEl.value.trim();
            if (!content) { toast('回复内容不能为空'); return; }
            var rid = replyTo, rname = replyToUser; // 异步前快照（发送途中切换回复目标不影响本条归属）
            api('POST', '/api/game/review/reply', { review_id: it.id, content: content, reply_to: rid }).then(function (res) {
                if (!res.ok) { toast(res.msg || '回复失败'); return; }
                inputEl.value = '';
                setReplyTo(0, '');
                it.reply_count = (it.reply_count || 0) + 1;
                repaintBtn();
                var empty = listEl.querySelector('.gs-rev-reply-empty');
                if (empty) empty.remove();
                listEl.appendChild(buildReplyRow({ id: res.data.id, username: username, reply_to: rid, reply_to_user: rname, content: content, create_time: new Date().toISOString() }));
            });
        }
        function buildReplyRow(rp) {
            var row = el('div', 'gs-rev-reply');
            var txt = el('span', 'gs-rev-reply-txt');
            txt.appendChild(el('span', 'gs-rev-reply-name', rp.username || '用户'));
            if (rp.reply_to && rp.reply_to_user) {
                txt.appendChild(el('span', 'gs-rev-reply-mid', '回复'));
                txt.appendChild(el('span', 'gs-rev-reply-name', rp.reply_to_user));
            }
            txt.appendChild(document.createTextNode('：' + (rp.content || '')));
            row.appendChild(txt);
            row.appendChild(el('span', 'gs-rev-reply-time', fmtDate(rp.create_time)));
            if (username) {
                var act = el('span', 'gs-rev-reply-act', '回复');
                act.addEventListener('click', function () { setReplyTo(rp.id, rp.username); });
                row.appendChild(act);
            }
            // 删除口径：回复人或评测主人（服务端二次校验）
            if (username && (rp.username === username || it.username === username)) {
                var del = el('span', 'gs-rev-reply-del', '删除');
                del.addEventListener('click', function () {
                    api('DELETE', '/api/game/review/reply/' + rp.id).then(function (res) {
                        if (!res.ok) { toast(res.msg || '删除失败'); return; }
                        it.reply_count = Math.max((it.reply_count || 0) - 1, 0);
                        repaintBtn();
                        row.remove();
                        if (!listEl.querySelector('.gs-rev-reply')) listEl.appendChild(el('div', 'gs-rev-reply-empty', '还没有评论'));
                    });
                });
                row.appendChild(del);
            }
            return row;
        }
        // 楼层加载（正序；登录/未登录均可看）
        listEl.appendChild(el('div', 'gs-review-empty', '加载中…'));
        api('GET', '/api/game/review/replies?review_id=' + it.id).then(function (res) {
            listEl.innerHTML = '';
            if (!res.ok) {
                listEl.appendChild(el('div', 'gs-review-empty', res.msg || '评论加载失败'));
                return;
            }
            var arr = (res.data && res.data.list) || [];
            if (!arr.length) {
                listEl.appendChild(el('div', 'gs-rev-reply-empty', '还没有评论'));
            } else {
                arr.forEach(function (rp) { listEl.appendChild(buildReplyRow(rp)); });
            }
        });
    }

    // 写评测/编辑评测弹窗（自绘；服务端 upsert 一人一评）
    function openReviewModal(gid) {
        revTarget = gid;
        var mine = state.reviews.mine;
        revPick = mine ? (mine.recommended === 1 ? 1 : 0) : 1;
        $('gsRevTitle').textContent = mine ? '编辑我的评测' : '写评测';
        $('gsRevText').value = mine ? (mine.content || '') : '';
        updateRevCount();
        paintRevPick();
        $('gsRevMask').classList.remove('hidden');
    }

    function paintRevPick() {
        $('gsRevUp').classList.toggle('active', revPick === 1);
        $('gsRevDown').classList.toggle('active', revPick === 0);
    }

    function updateRevCount() {
        $('gsRevCount').textContent = $('gsRevText').value.length + ' / 2000';
    }

    // 评测弹窗事件（元素为页面静态节点，此处一次绑定）
    $('gsRevUp').addEventListener('click', function () { revPick = 1; paintRevPick(); });
    $('gsRevDown').addEventListener('click', function () { revPick = 0; paintRevPick(); });
    $('gsRevText').addEventListener('input', updateRevCount);
    $('gsRevCancel').addEventListener('click', function () { $('gsRevMask').classList.add('hidden'); });
    $('gsRevSubmit').addEventListener('click', function () {
        var content = $('gsRevText').value.trim();
        if (!content) { toast('评测内容不能为空'); return; }
        api('POST', '/api/game/review/' + revTarget, { recommended: revPick, content: content }).then(function (res) {
            if (!res.ok) { toast(res.msg || '评测提交失败'); return; }
            $('gsRevMask').classList.add('hidden');
            toast('评测已发布');
            loadReviews(revTarget, true);
            loadRecentReviews(revTarget); // 自己的评测也进右栏"最近发布"，提交后同步刷新
        });
    });

    // ==================== 进度事件订阅与全局刷新 ====================
    var refreshPending = false;
    var progressPending = false;

    function scheduleRefresh() { // 状态迁移帧：rAF 合帧全量刷新
        if (refreshPending) return;
        refreshPending = true;
        requestAnimationFrame(function () {
            refreshPending = false;
            refreshViews();
        });
    }

    function refreshViews() {
        updateBadges();
        syncLibrary(); // 轻刷新：状态迁移不再整页重建（防闪烁）；结构变化时内部回退全量渲染
        renderDownloads();
        if (state.detailId) updateInstallBox();
    }

    // 进度帧轻刷新（仅 received/speed 推进，无状态迁移）：库主区不重建——buildLibGamePage 含
    // hero 模糊背景/公告卡图等大块图片 DOM，下载期间 500ms 一推的全量重建会让整页可见闪烁
    // （用户反馈"像快速刷新"）；进度可视区（下载管理行/商店安装框/导航角标）原地更新，
    // 任务态迁移与库数据合并（putLibState）仍走 scheduleRefresh 全量重绘
    function scheduleProgressRefresh() {
        if (progressPending) return;
        progressPending = true;
        requestAnimationFrame(function () {
            progressPending = false;
            updateBadges();
            syncLibSideProgress(); // 侧栏环形进度跟进度帧原地走
            renderDownloads();
            if (state.detailId) updateInstallBox();
        });
    }

    if (DESKTOP && DESKTOP.onGameDownload) {
        DESKTOP.onGameDownload(function (p) {
            if (!p || !p.taskId) return;
            var t = state.tasks[p.taskId];
            if (!t) {
                t = state.tasks[p.taskId] = { taskId: p.taskId, gameId: p.gameId };
                if (p.gameId !== undefined && p.gameId !== null) state.taskByGame[p.gameId] = p.taskId;
            }
            if (p.gameId !== undefined && p.gameId !== null && t.gameId === undefined) t.gameId = p.gameId;
            var prev = t.state;
            ['received', 'total', 'speed', 'state', 'fileRelPath', 'error'].forEach(function (k) {
                if (p[k] !== undefined && p[k] !== null) t[k] = p[k];
            });
            // 状态迁移时同步服务端库状态（仅切换帧 PUT，避免每个进度帧打请求）
            if (t.gameId !== undefined && prev !== t.state) {
                if (t.state === 'done') {
                    putLibState(t.gameId, {
                        state: 3,
                        installed_version: t.version || '',
                        install_path: t.installDir || ''
                    });
                    if (state.taskByGame[t.gameId] === p.taskId) delete state.taskByGame[t.gameId];
                    toast('下载完成：' + taskName(t));
                } else if (t.state === 'paused') {
                    putLibState(t.gameId, {
                        state: 2,
                        installed_version: t.prevInstalled || '',
                        install_path: t.installDir || ''
                    });
                } else if (t.state === 'downloading' && prev === 'paused') {
                    putLibState(t.gameId, {
                        state: 1,
                        installed_version: t.prevInstalled || '',
                        install_path: t.installDir || ''
                    });
                } else if (t.state === 'error') {
                    toast('下载出错：' + taskName(t) + (t.error ? '（' + t.error + '）' : ''));
                    // BT 通道失败保底：自动切换 HTTP 清单直连（复用原安装目录重下，仅回退一次防循环）
                    if (t.via === 'bt' && !t.fallbackDone) {
                        t.fallbackDone = true;
                        var fg = state.games[t.gameId] || (state.lib[t.gameId] && state.lib[t.gameId].game);
                        if (fg) {
                            delete state.tasks[p.taskId];
                            if (state.taskByGame[t.gameId] === p.taskId) delete state.taskByGame[t.gameId];
                            toast('BT 通道失败，已自动切换 HTTP 直连下载');
                            startInstall(fg, true, true);
                        }
                    }
                }
            }
            // 状态迁移帧全量重绘（按钮/角标随任务态切换）；纯进度帧轻刷新防整页闪烁
            (prev !== t.state ? scheduleRefresh : scheduleProgressRefresh)();
        });
    }

    // 游戏进程启动：多窗口同步"运行中"（启动窗口自身走 onLaunched，事件重复置位无副作用）
    if (DESKTOP && DESKTOP.onGameStart) {
        DESKTOP.onGameStart(function (info) {
            var gid = info && info.gameId;
            if (gid === undefined || gid === null) return;
            state.running[gid] = (info && info.startedAt) || Date.now();
            if (state.sessions[gid] === undefined) state.sessions[gid] = state.running[gid];
            ensurePlayHeartbeat(); // 多窗口启动的窗口自身也保活"正在玩"presence
            scheduleRefresh();
        });
    }

    // 游戏进程退出：结算本次游玩时长并上报（play end）
    if (DESKTOP && DESKTOP.onGameExit) {
        DESKTOP.onGameExit(function (info) {
            var gid = info && info.gameId;
            if (gid === undefined || gid === null) return;
            delete state.running[gid]; // 运行中回落：侧栏行/启动按钮恢复"启动"
            var startedAt = state.sessions[gid];
            delete state.sessions[gid];
            var seconds = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : ((info && info.seconds) || 0);
            api('POST', '/api/game/play/' + gid, { action: 'end', seconds: seconds });
            // 退出后上传云端存档（P1 单设备闭环；P2 冲突弹窗裁决）；非阻塞，失败仅提示
            if (DESKTOP && DESKTOP.gameSaveSync) {
                DESKTOP.gameSaveSync(saveSyncPayload(gid, 'push')).then(function (sv) {
                    if (sv && sv.conflict) return handleSaveConflict(gid, sv, 'push');
                    return sv;
                }).then(function (sv) {
                    if (!sv || !sv.ok) { if (sv && sv.error) toast('云存档上传失败：' + sv.error); return; }
                    if (sv.uploaded) toast('已上传存档到云端（' + sv.uploaded + ' 个文件）');
                }).catch(function () {});
            }
            if (state.lib[gid] && state.lib[gid].lib) {
                state.lib[gid].lib.play_seconds = (state.lib[gid].lib.play_seconds || 0) + seconds;
            }
            refreshViews();
        });
    }

    // ==================== 顶部工具栏 / 导航 / 快捷键 ====================
    // 关闭：Electron 独立窗口无专用关闭 IPC，window.close() 兜底；浏览器返回来源页
    function closePage() {
        if (IN_ELECTRON) {
            try { window.close(); } catch (e) { /* 忽略 */ }
        } else if (window.history && window.history.length > 1) {
            window.history.back();
        } else {
            try { window.close(); } catch (e) { /* 忽略 */ }
        }
    }

    $('gsBtnClose').addEventListener('click', closePage);
    $('gsBtnBack').addEventListener('click', closeDetail);

    // 标题栏账号区：拉当前用户资料（GET /api/game/me）填充头像+名称（昵称优先回退账号）；
    // 头像加载失败回退首字母块（主题色底，CSS 归口）
    (function () {
        var avEl = $('gsUserAv'), nameEl = $('gsUserName');
        if (!avEl || !nameEl || !username) return;
        api('GET', '/api/game/me').then(function (res) {
            if (!res.ok || !res.data) return;
            nameEl.textContent = res.data.nickname || res.data.username;
            var ch = String(res.data.nickname || res.data.username || '?').charAt(0).toUpperCase();
            if (res.data.avatar) {
                var img = document.createElement('img');
                img.src = assetUrl(res.data.avatar);
                img.onerror = function () { avEl.innerHTML = ''; avEl.appendChild(el('b', '', ch)); };
                avEl.appendChild(img);
            } else {
                avEl.appendChild(el('b', '', ch));
            }
        });
    })();

    // 窗口控制（仅 Electron 显示）：最小化复用通用 call:minimize（sender 窗口归口）；
    // 最大化/还原切换经 game:win-toggle-maximize，图标随状态切换（推送 + invoke 返回双路同步）
    if (IN_ELECTRON) {
        document.body.classList.add('gs-electron');
        var maxSvg = '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
        var unmaxSvg = '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="4.5" y="7.5" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 5.5h8.5a2 2 0 0 1 2 2V16" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
        var btnMax = $('gsBtnMax');
        var setMaxIcon = function (on) {
            btnMax.innerHTML = on ? unmaxSvg : maxSvg;
            // 提示文案走 data-tip-text（tooltip.js 摘存专用属性）：title 一经摘存即被移除，
            // 回设 title 会复活系统原生气泡且自绘气泡永读旧缓存（双泡同现）；状态切换时同步刷新
            btnMax.removeAttribute('title');
            btnMax.setAttribute('data-tip-text', on ? '还原' : '最大化');
        };
        $('gsBtnMin').addEventListener('click', function () {
            // 最小化：与最大化同构 invoke 通道（主进程内含 IsIconic 实判 + ShowWindow 兜底）
            DESKTOP.gameWinMinimize();
        });
        btnMax.addEventListener('click', function () {
            Promise.resolve(DESKTOP.gameWinToggleMaximize()).then(function (on) { setMaxIcon(!!on); });
        });
        if (DESKTOP.onGameWinMaximize) DESKTOP.onGameWinMaximize(setMaxIcon);
    }

    // Esc：确认弹窗 > 评测弹窗 > 详情返回 > 关闭页面（与图片查看器同策略）
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!modalMask.classList.contains('hidden')) { closeModal(); return; }
        var revMask = $('gsRevMask');
        if (revMask && !revMask.classList.contains('hidden')) { revMask.classList.add('hidden'); return; }
        if (state.detailId) { closeDetail(); return; }
        closePage();
    });

    // 搜索：回车触发（清标签筛选、重置分页并回到商店页签）
    var searchInput = $('gsSearch');
    searchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        state.store.keyword = searchInput.value.trim();
        state.store.tag = '';
        closeDetail();
        showView('store');
        loadStore(true);
    });
    // 搜索框清空即自动恢复完整列表（无需再按回车；仅在已有生效关键词时触发）
    searchInput.addEventListener('input', function () {
        if (searchInput.value.trim() || !state.store.keyword) return;
        state.store.keyword = '';
        loadStore(true);
    });

    // 库侧栏搜索：输入即时过滤侧栏行（只重绘行区，右侧详情/最近游戏保持不动）；
    // Esc 清空过滤并 stopPropagation（防冒泡触发全局 Esc 关闭页面）
    var libSearch = $('gsLibSearch');
    libSearch.addEventListener('input', function () {
        renderLibRows(libItemsSorted());
    });
    libSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            libSearch.value = '';
            renderLibRows(libItemsSorted());
        } else if (e.key === 'Enter') {
            e.preventDefault(); // 搜索即时生效，回车无其他语义（防意外提交/换行）
        }
    });

    // 页签切换：库/下载每次进入重新拉取（保持最新状态）
    $('gsNavStore').addEventListener('click', function () {
        showView('store');
        if (!state.store.list.length) loadStore(true);
        else renderStore();
    });
    $('gsNavLibrary').addEventListener('click', function () {
        showView('library');
        if (username) loadLibrary();
        else renderLibrary();
    });
    $('gsNavDownloads').addEventListener('click', function () {
        showView('downloads');
        pullStatus();
        renderDownloads();
    });

    // 商店无限滚动（Steam 同款）：滚动接近底部（root=gsStoreScroll，400px 预载余量）自动拉下一页，
    // "加载更多"按钮已由 #gsStoreInf 底部容器替代（spinner/已加载全部，状态归口 updateStoreInf）
    attachInf($('gsStoreScroll'), $('gsStoreInf'), function () {
        var st = state.store;
        if (!st.loading && st.list.length && (!st.total || st.list.length < st.total)) loadStore(false);
    });

    // ==================== 初始化 ====================
    // 滚动容器挂自绘悬浮滑块（原生滚动条已被 style.css 全局归零）；库页签 v4 双栏：侧栏 + 主区
    osbInit($('gsStoreScroll'));
    osbInit($('gsLibSide'));
    osbInit($('gsLibMain'));
    osbInit($('gsDlList'));
    osbInit($('gsDetailScroll'));
    osbInit($('gsSlotList'));
    osbInit($('gsHistList'));
    osbInit($('gsPropPanes')); // 属性弹窗右侧分栏内容区（超高时内部滚动）

    showView('store');
    // 先拉商店布局配置（管理端改后用户下次打开即热生效），再加载商店列表渲染
    api('GET', '/api/game/config').then(function (res) {
        if (res.ok && res.data) {
            state.cfg = res.data;
            if (!state.cfg.sections) state.cfg.sections = { carousel: true, featured: true, tagbar: true };
            if (!Array.isArray(state.cfg.featured_games)) state.cfg.featured_games = [];
        }
        loadStore(true);
    });
    if (username) {
        loadLibrary(); // 页面加载即恢复库状态（徽标/下载任务名/详情按钮依赖）
        api('GET', '/api/game/points').then(function (res) { // 积分余额（购买块/确认弹窗显示）
            if (res.ok && res.data) state.balance = res.data.balance;
        });
    }
    if (IN_ELECTRON) {
        pullStatus();  // 恢复主进程侧下载任务（页面刷新场景）
        pullRunning(); // 恢复主进程侧"正在运行的游戏"（页面刷新/新开窗口场景）
    }
})();
