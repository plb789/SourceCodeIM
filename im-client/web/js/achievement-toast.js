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

    // 122 帧统一处理（主窗 WS 直收 / 游戏中心窗 GNSignal 中继共用）
    function achFrameHandler(msg) {
        var p = null;
        try { p = JSON.parse(msg.content); } catch (e) { return; }
        console.debug('[ach-toast] 收到成就推送帧', msg.msg_type, msg.content);
        if (!p) return;
        window.AchievementToast.show(p);
        // 桌面系统通知（好友新消息同款，Electron Notification 弹屏幕右下角/进通知中心）：
        // 仅主窗口触发（有 WS + 有 desktop 桥），且本窗口未持有焦点（被其他窗口/游戏遮挡、
        // 最小化、失焦）时才发——用户正看着本窗口时页内 toast 已足够，避免双重打扰；
        // 游戏中心窗经中继弹页内 toast，系统通知由主窗口归口单发。
        // 独立成就卡片弹窗优先（desktop.achNotify → 主进程不夺焦通知窗，样式与页内 toast 同源）；
        // 旧主进程无该 API 时回退系统通知（desktop.notify）
        if (window.IMSocket && window.desktop && !document.hasFocus()) {
            var payloadOut = {
                game_id: p.game_id || 0, code: p.code || '',
                name: p.name || '', desc: p.desc || '', icon: p.icon || '', rarity: p.rarity || 0,
                exp_reward: parseInt(p.exp_reward, 10) || 0,
                level_up: !!p.level_up, new_level: p.new_level || 0
            };
            if (typeof window.desktop.achNotify === 'function') {
                console.debug('[ach-toast] 桌面卡片通知已转发主进程');
                try { window.desktop.achNotify(payloadOut); } catch (eAn) { /* 弹窗失败不影响页内 toast */ }
            } else if (typeof window.desktop.notify === 'function') {
                var icon = /^(https?:|data:)/i.test(p.icon || '') ? p.icon
                    : (p.icon ? location.origin + (p.icon.charAt(0) === '/' ? '' : '/') + p.icon : '');
                var title = p.name || t('成就解锁');
                var body = (p.desc ? p.desc + '　' : '') + '+' + payloadOut.exp_reward + ' EXP'
                    + (p.level_up ? '　' + t('升级') + ' Lv ' + (p.new_level || '') : '');
                try { window.desktop.notify(title, body, icon); } catch (eNf) { /* 通知失败不影响页内 toast */ }
            }
        }
    }

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
        // 滑入动画仅在窗口持焦点时播放；后台/被遮挡/失焦窗口下 CSS transition 会被冻结在起点
        // （实测 opacity 卡 0、transform 卡滑出位，且自愈定时器本身也被节流拖慢）——直接内联
        // 置为可见态，保证任何窗口状态创建即见
        if (document.hasFocus() && document.visibilityState === 'visible') {
            void node.offsetWidth;
            node.classList.add('ach-in');
            // 150ms 自检兜底：动画中途窗口失焦/被遮挡导致过渡冻结 → 内联直置可见
            setTimeout(function () {
                var cs = getComputedStyle(node);
                var tx = 0;
                var m = cs.transform.match(/matrix\(([^)]+)\)/);
                if (m) {
                    var parts = m[1].split(',');
                    if (parts.length >= 6) tx = parseFloat(parts[4]) || 0;
                }
                if (parseFloat(cs.opacity) < 0.5 || tx > 50) {
                    node.style.transition = 'none';
                    node.style.opacity = '1';
                    node.style.transform = 'none';
                }
            }, 150);
        } else {
            node.style.transition = 'none';
            node.style.opacity = '1';
            node.style.transform = 'none';
        }
        setTimeout(function () {
            // 清除内联样式恢复 class 过渡（正常窗口滑出生效；冻结窗口 opacity 即时归零不可见）
            node.style.transition = '';
            node.style.opacity = '';
            node.style.transform = '';
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
            console.debug('[ach-toast] show:', payload && payload.code, 'queue=', queue.length);
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
        },
        // 卡片构建器（桌面成就通知窗 achievement-notify.html 复用，与页内 toast 视觉完全同源：
        // 同一 CSS 注入 + 同一 DOM 结构，改样式只改此处一处）
        buildCard: function (payload) {
            injectStyle();
            return buildNode(payload);
        }
    };

    // WS 推送自动接入（链路 A）：主窗口（index.html）持有 WS，socket.js 在本文件之前加载；
    // 游戏中心窗无 WS：socket.js 将 122 帧经主进程中继（desktop.onGnSignalIn → GNSignal），
    // gn-signal.js 在本文件之后加载，故 GNSignal 绑定走就绪重试
    var socketBound = false;
    var gnBound = false;

    function bindSocket() {
        if (socketBound) return true;
        if (!window.IMSocket || !IMSocket.on || !IMSocket.MSG) return false;
        IMSocket.on(IMSocket.MSG.ACHIEVEMENT_UNLOCK, achFrameHandler);
        console.debug('[ach-toast] WS 122 处理器已注册');
        socketBound = true;
        return true;
    }

    function bindGnSignal() {
        if (gnBound) return true;
        if (!window.GNSignal || typeof GNSignal.on !== 'function') return false;
        GNSignal.on(122, achFrameHandler); // 与 socket.js MSG.ACHIEVEMENT_UNLOCK 同帧号（中继保真）
        console.debug('[ach-toast] GNSignal 122 处理器已注册（游戏中心窗中继）');
        gnBound = true;
        return true;
    }

    function bindAll() {
        var a = bindSocket();
        var b = bindGnSignal();
        return a && b; // 两端各自只需其一成功（主窗=IMSocket，游戏中心窗=GNSignal）
    }

    if (!bindAll()) {
        // 脚本顺序兜底（socket.js / gn-signal.js 尚未就绪）：等待就绪后注册
        var waited = 0;
        var timer = setInterval(function () {
            waited += 200;
            if (bindAll() || waited >= 15000) clearInterval(timer);
        }, 200);
    }
})();
