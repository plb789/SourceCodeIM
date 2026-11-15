// ============================================================================
// game-common.js — Game 模块共享前端安全渲染（Game 商店页 + 管理后台 + 商户后台共用）
//  安全原则：双层防护
//    1. DOM API 节点树构建（不用 innerHTML 写 HTML，浏览器自动转义）
//    2. 白名单标签 + 安全 URL 校验（与服务端 gameDescContentClean 同口径）
// ============================================================================

(function () {
    if (window.__descSanitize) return; // 避免重复注入

    // 安全 URL 校验（与服务端 safeURL 同规则）
    function safeURL(url) {
        url = String(url || '').trim();
        if (!url) return '';
        var low = url.toLowerCase().replace(/\\/g, '/');
        if (/^(https?:|\/|\.\/|#)/i.test(low) && !/javascript:|vbscript:|data:|file:|<|>/i.test(low)) {
            return url;
        }
        return '';
    }

    // 白名单标签（与服务端 gameDescContentClean 放行标签完全一致）
    var allowedTags = {
        p: 1, br: 1, hr: 1,
        h1: 1, h2: 1, h3: 1,
        b: 1, strong: 1, i: 1, em: 1,
        u: 1, s: 1, del: 1, mark: 1, small: 1,
        ul: 1, ol: 1, li: 1,
        a: 1, img: 1,
        code: 1, pre: 1, blockquote: 1,
        table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1
    };

    // 核心：把 HTML 片段转成安全节点树（零 innerHTML 风险）
    function sanitizeAndBuildHTML(html, parent, opt) {
        opt = opt || {};
        var onImgLoad = opt.onImgLoad || function () {};
        var onImgError = opt.onImgError || function () {};
        var holder = document.createElement('div');
        holder.innerHTML = html; // 临时挂载，浏览器解析器处理非法标签
        var walker = document.createTreeWalker(holder, NodeFilter.SHOW_ALL, null, false);
        var node;
        var ctx = { inPre: 0 }; // 跟踪是否在 <pre>/<code> 内（这些标签里 \n 要原样保留）
        while ((node = walker.nextNode())) {
            appendSafeNode(parent, node, opt, ctx);
        }
    }

    function appendSafeNode(parent, node, opt, ctx) {
        opt = opt || {};
        ctx = ctx || { inPre: 0 };
        var type = node.nodeType;
        if (type === 1) {
            var tag = node.tagName.toLowerCase();
            // 进入白名单结构标签 → 增加嵌套计数
            if (tag === 'pre' || tag === 'code') ctx.inPre++;
            if (!allowedTags[tag]) {
                // 不在白名单 → 剥离壳，递归保留内文
                for (var i = 0; i < node.childNodes.length; i++) {
                    appendSafeNode(parent, node.childNodes[i], opt, ctx);
                }
                if (tag === 'pre' || tag === 'code') ctx.inPre--;
                return;
            }
            var el = document.createElement(tag);
            if (tag === 'a') {
                var href = safeURL(node.getAttribute('href'));
                if (!href) { if (tag === 'pre' || tag === 'code') ctx.inPre--; return; }
                el.setAttribute('href', href);
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            } else if (tag === 'img') {
                var src = safeURL(node.getAttribute('src'));
                if (!src) { if (tag === 'pre' || tag === 'code') ctx.inPre--; return; }
                el.setAttribute('src', src);
                el.setAttribute('alt', node.getAttribute('alt') || '');
                el.setAttribute('loading', 'lazy');
                el.draggable = false;
                if (opt.imgClass) el.className = opt.imgClass;
                el.onload = opt.onImgLoad || null;
                el.onerror = opt.onImgError || null;
            }
            // 递归子节点
            for (var j = 0; j < node.childNodes.length; j++) {
                appendSafeNode(el, node.childNodes[j], opt, ctx);
            }
            if (tag === 'pre' || tag === 'code') ctx.inPre--;
            parent.appendChild(el);
        } else if (type === 3) {
            // 文本节点：非 <pre>/<code> 里的 \n 转为 <br>（浏览器 HTML 解析器会把 \n 折叠成空格）
            var text = node.nodeValue;
            if (ctx.inPre > 0 || text.indexOf('\n') === -1) {
                parent.appendChild(node.cloneNode());
            } else {
                var lines = text.split('\n');
                for (var k = 0; k < lines.length; k++) {
                    if (k > 0) parent.appendChild(document.createElement('br'));
                    if (lines[k]) parent.appendChild(document.createTextNode(lines[k]));
                }
            }
        }
        // CDATA/Comment/EntityReference 等一律丢弃
    }

    // [img]URL 旧语法 → <img> 标签（兼容已入库的旧数据）
    function normalizeOldImgSyntax(text, opt) {
        opt = opt || {};
        var assetFn = opt.assetUrl || function (u) { return u; };
        return String(text || '').replace(/^\s*\[img\]\s*(\S+)\s*$/gm, function (_, url) {
            return '<img src="' + String(assetFn(url)).replace(/"/g, '&quot;') + '" loading="lazy">';
        });
    }

    // 把安全 HTML 片段渲染到目标元素（admin.js/merchant.js 编辑器预览用）
    function renderInto(html, targetEl, opt) {
        targetEl.innerHTML = '';
        var frag = document.createDocumentFragment();
        sanitizeAndBuildHTML(html, frag, opt);
        targetEl.appendChild(frag);
    }

    // 实时安全扫描（前端镜像，与服务端 gameDescContentClean 同规则）
    function scanSecurity(text) {
        var warnings = [];
        if (!text) return warnings;
        var lines = text.split('\n');
        var tagRe = /<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g;
        var onAttrRe = /\son[a-z]+\s*=/gi;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var ln = i + 1;

            // 1) 事件属性
            if (onAttrRe.test(line)) {
                warnings.push({
                    level: 'error', line: ln,
                    message: '发现事件属性（如 onclick/onerror/onmouseover 等）',
                    reason: '所有 on* 属性会被服务端剥离',
                    suggestion: '移除所有 onXXX="..." 属性',
                    fixable: true,
                    fix: function (ta) { ta.value = ta.value.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|' + "'" + '[^' + "'" + ']*' + "'" + '|[^\s>]+)/gi, ''); }
                });
                onAttrRe.lastIndex = 0;
            }

            // 2) 标签逐个检查
            var tagMatch; tagRe.lastIndex = 0;
            while ((tagMatch = tagRe.exec(line)) !== null) {
                var tagName = tagMatch[1].toLowerCase();
                if (!allowedTags[tagName]) {
                    warnings.push({
                        level: 'warning', line: ln,
                        message: '不在白名单的标签：<' + tagName + '>',
                        reason: '服务端会剥离该标签外壳，保留内部文本',
                        suggestion: '改用 p/h1-h3/b/strong/i/em/u/s/a/img/code/pre/blockquote/table 等白名单标签',
                        fixable: false
                    });
                }
            }

            // 3) <a href="..."> 安全检查
            var aRe = /<a\s+href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
            var aMatch;
            while ((aMatch = aRe.exec(line)) !== null) {
                var aHref = (aMatch[1] || aMatch[2] || '').trim();
                if (aHref && !safeURL(aHref)) {
                    warnings.push({
                        level: 'error', line: ln,
                        message: '不安全的链接协议：href="' + aHref + '"',
                        reason: 'javascript:/data:/vbscript: 等协议会被服务端剥离',
                        suggestion: '改用 http:// 或 https:// 开头的合法 URL',
                        fixable: false
                    });
                }
            }

            // 4) <img src="..."> 安全检查
            var imgRe = /<img\s+[^>]*?src\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
            var imgMatch;
            while ((imgMatch = imgRe.exec(line)) !== null) {
                var imgSrc = (imgMatch[1] || imgMatch[2] || '').trim();
                if (imgSrc && !safeURL(imgSrc)) {
                    warnings.push({
                        level: 'error', line: ln,
                        message: '不安全的图片 src：src="' + imgSrc + '"',
                        reason: '非法协议图片会被服务端整块移除',
                        suggestion: '改用 http:// 或 https:// 开头的合法图片 URL',
                        fixable: false
                    });
                }
                if (!/<img[^>]*\salt\s*=/i.test(line)) {
                    warnings.push({
                        level: 'info', line: ln,
                        message: '图片缺少 alt 属性',
                        reason: '建议加上 alt 描述提升可访问性',
                        suggestion: '<img src="..." alt="截图描述">',
                        fixable: false
                    });
                }
            }
        }

        // 5) 危险标签整块检测
        var dangerousRe = /<\s*(script|style|iframe|object|embed|form|input|button|link|meta|base|svg|math|template)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi;
        var dMatch;
        while ((dMatch = dangerousRe.exec(text)) !== null) {
            var tag = dMatch[1].toLowerCase();
            warnings.push({
                level: 'error',
                message: '发现危险标签：<' + tag + '>...</' + tag + '>',
                reason: '服务端会整块剥离该标签及所有内容',
                suggestion: '删除该标签，或改用安全白名单标签实现相同效果',
                fixable: true,
                fix: function (ta) { ta.value = ta.value.replace(dangerousRe, '$2'); }
            });
        }

        // 去重
        var seen = {};
        return warnings.filter(function (w) {
            var key = w.line + '|' + w.level + '|' + w.message;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    // -----------------------------------------------------------------------
    // renderNoticeText — 公告专用 content 渲染（与 game-store.js 里的 renderNoticeText 同逻辑）
    //  支持：<a href="安全URL">文字</a> 链接 + 换行 \n 转 <br> + 其他 HTML 标签转义
    // -----------------------------------------------------------------------
    function renderNoticeText(text) {
        var safeUrl = safeURL; // 共用上面的安全 URL 校验
        var frag = document.createDocumentFragment();
        if (!text) return frag;
        var aRe = /<a\s+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        var lastIdx = 0;
        var match;
        var parts = [];
        while ((match = aRe.exec(text)) !== null) {
            var before = text.substring(lastIdx, match.index);
            if (before) parts.push({ type: 'text', data: before });
            var href = safeUrl(match[1].trim());
            if (href) {
                parts.push({ type: 'link', href: href, label: match[2].trim() });
            } else {
                parts.push({ type: 'text', data: match[0] });
            }
            lastIdx = match.index + match[0].length;
        }
        var tail = text.substring(lastIdx);
        if (tail) parts.push({ type: 'text', data: tail });
        parts.forEach(function (p) {
            if (p.type === 'link') {
                var a = document.createElement('a');
                a.href = p.href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = p.label;
                frag.appendChild(a);
            } else {
                // 文本：转义后 \n → <br>
                var lines = document.createTextNode(p.data).nodeValue.split('\n');
                for (var i = 0; i < lines.length; i++) {
                    if (i > 0) frag.appendChild(document.createElement('br'));
                    if (lines[i]) frag.appendChild(document.createTextNode(lines[i]));
                }
            }
        });
        return frag;
    }

    // -----------------------------------------------------------------------
    // renderNoticeImgs — 公告图片网格预览（简化版，后台编辑器用）
    //  urls: 图片 URL 数组 | layout: thumb/grid/banner | onImgClick: 点击回调（可选）
    // -----------------------------------------------------------------------
    function renderNoticeImgs(urls, layout, opt) {
        opt = opt || {};
        layout = layout || 'thumb';
        var grid = document.createElement('div');
        grid.className = 'gs-notice-card-grid n' + Math.min(urls.length, 3);
        var cap = Math.min(urls.length, 6);
        urls.slice(0, cap).forEach(function (u, i) {
            var cell = document.createElement('div');
            cell.className = 'gs-notice-card-cell';
            cell.style.cursor = 'zoom-in';
            var im = document.createElement('img');
            im.src = u;
            im.loading = 'lazy';
            im.draggable = false;
            im.alt = '';
            im.onerror = function () { if (cell.parentNode) cell.parentNode.removeChild(cell); };
            cell.appendChild(im);
            if (i === 5 && urls.length > 6) {
                var more = document.createElement('div');
                more.className = 'gs-notice-card-more';
                more.textContent = '+' + (urls.length - 6);
                more.style.cursor = 'zoom-in';
                cell.appendChild(more);
            }
            if (opt.onImgClick) {
                cell.addEventListener('click', function (e) {
                    e.stopPropagation();
                    opt.onImgClick(u, i);
                });
            }
            grid.appendChild(cell);
        });
        return grid;
    }

    // 全局暴露
    window.__descSanitize = {
        safeURL: safeURL,
        allowedTags: allowedTags,
        sanitizeAndBuildHTML: sanitizeAndBuildHTML,
        normalizeOldImgSyntax: normalizeOldImgSyntax,
        renderInto: renderInto,
        scanSecurity: scanSecurity,
        renderNoticeText: renderNoticeText,
        renderNoticeImgs: renderNoticeImgs
    };
})();
