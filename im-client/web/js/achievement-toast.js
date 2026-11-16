/**
 * 成就解锁 Toast（Steam 同款，方案 §14.3.4）
 * 独立组件，PC 主窗口（index.html，经 WS 推送触发）与游戏中心窗（game-store.html，
 * 链路 B 桥接上报回调触发）共用；统一入口 window.AchievementToast.show(payload)。
 *
 * payload：{game_id, code, name, desc, icon, rarity, exp_reward, level_up, new_level}
 *  - icon 为空时用稀有度色块 + 名称首字兜底；稀有度描边与展示柜/卡牌色板一致；
 *  - 动画：右下角滑入 → 停留 4s → 滑出；多条排队依次弹出；
 *  - 主题色跟随现有 CSS 变量（--panel-bg/--primary 等，随 data-theme 自动切换）；
 *  - 同一成就 6s 窗口去重：链路 B 回调与服务端 WS 推送竞态下只弹一次；
 *  - 自绘样式，无系统默认弹窗/滚动条。
 */
(function () {
    'use strict';

    var V = '1.0';
    var STAY_MS = 4000;      // 停留时长
    var ANIM_MS = 320;       // 单段滑入/滑出动画时长
    var DEDUP_MS = 6000;     // 同一成就去重窗口
    var MAX_VISIBLE = 1;     // 同屏单条弹出（排队依次展示）

    var RARITY_COLORS = {
        0: '#9ca3af', // Common  常见（灰）
        1: '#22c55e', // Uncommon 罕见（绿）
        2: '#3b82f6', // Rare    稀有（蓝）
        3: '#a855f7', // Epic    史诗（紫）
        4: '#f59e0b'  // Legendary 传说（琥珀）
    };

    var styleInjected = false;
    var container = null;
    var queue = [];
    var showing = false;
    var recent = {}; // code → ts（去重窗口）

    function t(s) {
        try { if (window.I18N && I18N.t) return I18N.t(s); } catch (e) { /* 无 I18N 环境兜底原文 */ }
        return s;
    }

    function injectStyle() {
        if (styleInjected) return;
        styleInjected = true;
        var css = ''
            + '.ach-toast-wrap{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;}'
            + '.ach-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;min-width:260px;max-width:340px;'
            + 'padding:10px 14px 10px 10px;border-radius:10px;background:var(--panel-bg,#fff);color:var(--text,#333);'
            + 'border:1px solid var(--border,#e0e0e0);border-left:4px solid #9ca3af;box-shadow:var(--shadow-pop,0 4px 16px rgba(0,0,0,.12));'
            + 'transform:translateX(calc(100% + 24px));transition:transform ' + ANIM_MS + 'ms cubic-bezier(.22,.9,.36,1),opacity ' + ANIM_MS + 'ms ease;opacity:0;cursor:default;}'
            + '.ach-toast.ach-in{transform:translateX(0);opacity:1;}'
            + '.ach-toast.ach-out{transform:translateX(calc(100% + 24px));opacity:0;}'
            + '.ach-toast-icon{width:44px;height:44px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;'
            + 'font-weight:600;font-size:18px;color:#fff;background:#9ca3af;overflow:hidden;}'
            + '.ach-toast-icon img{width:100%;height:100%;object-fit:cover;display:block;}'
            + '.ach-toast-body{flex:1;min-width:0;}'
            + '.ach-toast-title{font-size:11px;font-weight:600;color:var(--primary,#07c160);letter-spacing:.5px;}'
            + '.ach-toast-name{font-size:13px;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
            + '.ach-toast-desc{font-size:11px;color:var(--text-secondary,#999);margin-top:2px;'
            + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}'
            + '.ach-toast-exp{flex:none;font-size:12px;font-weight:700;color:var(--primary,#07c160);white-space:nowrap;}'
            + '.ach-toast-lv{flex:none;font-size:10px;font-weight:600;color:#fff;background:var(--primary,#07c160);'
            + 'border-radius:8px;padding:2px 7px;white-space:nowrap;}';
        var st = document.createElement('style');
        st.type = 'text/css';
        st.id = 'ach-toast-style-' + V;
        st.textContent = css;
        document.head.appendChild(st);
    }

    function ensureContainer() {
        injectStyle(); // 首次弹出前注入组件样式（幂等，styleInjected 去重）
        if (container && document.body.contains(container)) return container;
        container = document.createElement('div');
        container.className = 'ach-toast-wrap';
        document.body.appendChild(container);
        return container;
    }

    function buildNode(p) {
        var rarity = Math.max(0, Math.min(4, parseInt(p.rarity, 10) || 0));
        var color = RARITY_COLORS[rarity];
        var node = document.createElement('div');
        node.className = 'ach-toast';
        node.style.borderLeftColor = color;

        var icon = document.createElement('div');
        icon.className = 'ach-toast-icon';
        if (p.icon) {
            var img = document.createElement('img');
            img.src = /^(https?:|data:|blob:)/i.test(p.icon) ? p.icon
                : location.origin + (p.icon.charAt(0) === '/' ? '' : '/') + p.icon;
            img.alt = '';
            img.onerror = function () { img.remove(); icon.textContent = (p.name || '?').charAt(0); };
            icon.appendChild(img);
        } else {
            icon.style.background = color;
            icon.textContent = (p.name || '?').charAt(0);
        }
        node.appendChild(icon);

        var body = document.createElement('div');
        body.className = 'ach-toast-body';
        var title = document.createElement('div');
        title.className = 'ach-toast-title';
        title.textContent = t('成就解锁');
        var name = document.createElement('div');
        name.className = 'ach-toast-name';
        name.textContent = p.name || '';
        name.title = p.name || '';
        var desc = document.createElement('div');
        desc.className = 'ach-toast-desc';
        desc.textContent = p.desc || '';
        body.appendChild(title); body.appendChild(name); body.appendChild(desc);
        node.appendChild(body);

        if (p.level_up) {
            var lv = document.createElement('div');
            lv.className = 'ach-toast-lv';
            lv.textContent = t('升级') + ' Lv ' + (p.new_level || '');
            node.appendChild(lv);
        }
        var exp = document.createElement('div');
        exp.className = 'ach-toast-exp';
        exp.textContent = '+' + (parseInt(p.exp_reward, 10) || 0) + ' EXP';
        node.appendChild(exp);
        return node;
    }

    function playNext() {
        if (showing || !queue.length) return;
        showing = true;
        var p = queue.shift();
        var wrap = ensureContainer();
        var node = buildNode(p);
        wrap.appendChild(node);
        // 强制回流后滑入
        void node.offsetWidth;
        node.classList.add('ach-in');
        setTimeout(function () {
            node.classList.remove('ach-in');
            node.classList.add('ach-out');
            setTimeout(function () {
                if (node.parentNode) node.parentNode.removeChild(node);
                showing = false;
                playNext();
            }, ANIM_MS);
        }, STAY_MS);
    }

    // 对外统一入口（方案 §14.3.4 触发源三处共用）：WS 推送 / 链路 B 桥接回调 / 未来运营活动
    window.AchievementToast = {
        show: function (payload) {
            if (!payload || !payload.code) return;
            var now = Date.now();
            if (recent[payload.code] && now - recent[payload.code] < DEDUP_MS) return; // 竞态去重
            recent[payload.code] = now;
            // 清理过期去重键（防长期运行 map 膨胀）
            for (var k in recent) {
                if (Object.prototype.hasOwnProperty.call(recent, k) && now - recent[k] >= DEDUP_MS) delete recent[k];
            }
            queue.push(payload);
            if (queue.length > 10) queue = queue.slice(-10); // 队列上限保护
            playNext();
        }
    };

    // WS 推送自动接入（链路 A）：主窗口（index.html）持有 WS，socket.js 在本文件之前加载；
    // 游戏中心窗无 WS，注册为空操作（该窗经 show() 直接触发）
    function bindSocket() {
        if (!window.IMSocket || !IMSocket.on || !IMSocket.MSG) return false;
        IMSocket.on(IMSocket.MSG.ACHIEVEMENT_UNLOCK, function (msg) {
            var p = null;
            try { p = JSON.parse(msg.content); } catch (e) { return; }
            if (p) window.AchievementToast.show(p);
        });
        return true;
    }

    if (!bindSocket()) {
        // socket.js 尚未加载完（脚本顺序兜底）：等待就绪后注册
        var waited = 0;
        var timer = setInterval(function () {
            waited += 200;
            if (bindSocket() || waited >= 15000) clearInterval(timer);
        }, 200);
    }
})();
