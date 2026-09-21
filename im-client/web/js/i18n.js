/* 国际化核心模块（中/英双语，渐进式迁移）—— 阶段一百五十二补丁
 * 使用约定：
 *   1. key 即中文原文：I18N.t('发送') —— zh 模式零查表直返 key（性能无损）；
 *      en 模式查 en-US.json，缺失自动回退中文原文（渐进兜底，不会出现"键名裸奔"）。
 *   2. 带参数：I18N.t('已选 {n} 条', { n: 3 }) —— 占位符用 {参数名}。
 *   3. 语言包同步加载（本地小文件 <10ms）：保证任何可见文本首绘语言即正确，
 *      消除"先中文后英文"的切换闪烁（与 im_theme 首绘引导同思路）。
 *   4. 偏好持久化 localStorage('im_lang')：'zh' | 'en'，未设置时跟随浏览器语言。
 *   5. 多窗口同步：setLang 写 localStorage 触发 storage 事件，PC 端通话窗/截图窗/
 *      独立预览窗等同源页面自动跟随切换（同一 i18n.js 的页面均生效）。
 *   6. 静态文本替换：apply() 用"全等反查"——text/属性值恰好命中 zh-CN.json 的
 *      key 才替换为英文，用户消息内容绝不会误替换（动态内容必须代码里显式 t()）。
 *   7. 动态刷新：切换语言后派发 'im-lang-changed' 自定义事件，页面可监听做局部
 *      重刷（本次主界面静态文本 + 已迁移动态文本即时生效，未迁移处下次生成时生效）。
 * 引入方式：在 <head> 最前同步引入 <script src="js/i18n.js?v=1.0"></script>
 * （须先于任何含界面文本的内联脚本执行）。
 */
(function () {
    'use strict';
    var LANG_KEY = 'im_lang';                       // 偏好存储键（与 im_theme 同风格）
    var BASE = 'zh';                                // 基准语言（key 即中文原文，零查表）
    var PACK_VER = '1.3';                           // 语言包缓存版本（bump 强制刷新浏览器缓存的 JSON）
    var lang = BASE;                                // 当前语言
    var packs = { zh: {}, en: {} };                 // 语言包缓存（zh 包同时充当静态文本反查基准）

    // ---------- 偏好检测：已保存 > 浏览器语言（zh 开头中文，否则英文） ----------
    function detect() {
        var saved = '';
        try { saved = localStorage.getItem(LANG_KEY) || ''; } catch (e) { saved = ''; }
        if (saved === 'zh' || saved === 'en') return saved;
        var nav = '';
        try { nav = (navigator.language || navigator.userLanguage || 'zh') || 'zh'; } catch (e2) { nav = 'zh'; }
        nav = String(nav).toLowerCase();
        return nav.indexOf('zh') === 0 ? BASE : 'en';
    }

    // ---------- 同步加载语言包（本地静态文件，失败返回空包=回退中文） ----------
    function loadSync(file) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'i18n/' + file + '?v=' + PACK_VER, false);
            xhr.send(null);
            if ((xhr.status === 200 || xhr.status === 0) && xhr.responseText) {
                var obj = JSON.parse(xhr.responseText);
                return (obj && typeof obj === 'object') ? obj : {};
            }
        } catch (e) { /* 加载失败静默回退中文，不阻塞启动 */ }
        return {};
    }

    // ---------- 翻译核心（纯函数不依赖 this，可安全引用/解构） ----------
    function t(key, params) {
        if (key === null || key === undefined) return key;
        var s = String(key);
        if (lang !== BASE) {
            var pack = packs[lang] || {};
            // 英文包缺失时回退 zh 基准包（再缺失即 key 原文，三层兜底）
            if (pack[s] !== undefined) s = pack[s];
            else if (packs.zh && packs.zh[s] !== undefined) s = packs.zh[s];
        }
        if (params) {
            for (var k in params) {
                if (Object.prototype.hasOwnProperty.call(params, k)) {
                    s = s.split('{' + k + '}').join(String(params[k]));
                }
            }
        }
        return s;
    }

    // ---------- 静态文本反查替换（仅全等命中 zh 基准包 key 才替换，用户内容安全） ----------
    // 说明：apply 仅在页面启动阶段（DOMContentLoaded，消息区尚为空时）执行一次；
    // 语言切换采用"保存偏好后刷新页面"策略（reload 后同步语言包首绘即新语言，
    // app-booting 遮罩期间完成替换无闪烁），运行期不再全文档重扫，杜绝用户消息
    // 恰好命中词条被误替换的风险（如用户发送"图片"/"OK"等常用词）。
    var I18N_ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip'];
    function apply(root) {
        if (lang === BASE) return;                  // 中文模式：页面原文即中文，无需替换
        var zh = packs.zh || {};
        var en = packs[lang] || {};
        function lookup(text) {
            var tr = String(text).trim();
            if (!tr || zh[tr] === undefined) return null;   // 未归口文本一律不动
            return en[tr] !== undefined ? en[tr] : tr;      // 英文包缺失回退中文
        }
        root = root || document;
        // 1) 文本节点（只处理"整段文本"全等命中：不会拆散/误伤用户消息内容）
        var nodes = [];
        try {
            var walker = root.ownerDocument
                ? root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false)
                : document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
            var n;
            while ((n = walker.nextNode())) nodes.push(n);
        } catch (e) { nodes = []; }
        for (var i = 0; i < nodes.length; i++) {
            var raw = nodes[i].nodeValue;
            if (!raw || !raw.trim()) continue;
            var v = lookup(raw);
            if (v !== null && v !== raw) nodes[i].nodeValue = raw.replace(String(raw).trim(), v);
        }
        // 2) 属性文本（placeholder/title/aria-label/data-tip）
        if (root.querySelectorAll) {
            var sel = I18N_ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
            var els = root.querySelectorAll(sel);
            for (var j = 0; j < els.length; j++) {
                for (var m = 0; m < I18N_ATTRS.length; m++) {
                    var attr = I18N_ATTRS[m];
                    var rawA = els[j].getAttribute(attr);
                    if (!rawA) continue;
                    var vA = lookup(rawA);
                    if (vA !== null && vA !== rawA) els[j].setAttribute(attr, vA);
                }
            }
        }
        // 3) 页面标题
        var vT = lookup(document.title || '');
        if (vT !== null) document.title = vT;
    }

    // ---------- 服务端文本翻译（tr：服务端下发的提示文本统一在此翻译） ----------
    // 服务端 sendError 等下发的提示文本以"中文原文即 key"归口（服务端零改动），此处做与
    // apply() 同思路的全等反查：trim 后恰好命中 zh 基准包 key 才替换为英文包对应值；
    // 未命中（拼接句/含 %s 格式串/动态内容/用户消息）一律原样返回，杜绝误替换。
    // zh 模式零开销直返（页面原文即中文）。
    function tr(text) {
        if (text === null || text === undefined) return text;
        var s = String(text);
        if (lang === BASE) return s;
        var zh = packs.zh || {};
        var en = packs[lang] || {};
        var key = s.trim();
        if (!key || zh[key] === undefined) return s;
        return en[key] !== undefined ? en[key] : s;
    }

    // ---------- 语言切换（保存偏好后刷新页面；storage 广播其他同源窗口跟随刷新） ----------
    function fire() {
        document.documentElement.setAttribute('data-lang', lang);
        try { dispatchEvent(new CustomEvent('im-lang-changed', { detail: { lang: lang } })); } catch (e) {}
    }
    function setLang(code) {
        if (code !== 'zh' && code !== 'en') code = BASE;
        if (code === lang) return;
        try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
        lang = code;
        fire();
        // 刷新生效：同步语言包保证 reload 后首绘即新语言（app-booting 遮罩，无闪烁）
        try { location.reload(); } catch (e) {}
    }
    // 其他窗口切换跟随：本窗口只同步状态与事件（不强制 reload，避免通话/截图等
    // 场景被打断；文本在下次打开时按新语言首绘）
    window.addEventListener('storage', function (e) {
        if (e.key === LANG_KEY && (e.newValue === 'zh' || e.newValue === 'en') && e.newValue !== lang) {
            lang = e.newValue;
            fire();
        }
    });

    // ---------- 初始化：同步加载语言包（在 head 中最先执行，任何文本渲染前就绪） ----------
    lang = detect();
    packs.zh = loadSync('zh-CN.json');
    packs.en = loadSync('en-US.json');
    document.documentElement.setAttribute('data-lang', lang);
    // DOM 就绪后对静态文本做一次反查替换（英文模式；app-booting 揭幕前完成，无首绘闪烁）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { if (lang !== BASE) apply(document); });
    } else {
        if (lang !== BASE) apply(document);
    }

    // ---------- 导出 ----------
    window.I18N = {
        t: t,
        tr: tr,
        apply: apply,
        setLang: setLang,
        getLang: function () { return lang; },
        loaded: function () { return !!(packs.zh && Object.keys(packs.zh).length); }
    };
})();
