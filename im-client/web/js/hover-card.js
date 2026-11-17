/* 头像悬停资料卡（QQ/Steam 同款 popover）
   职责：鼠标悬停用户头像时，在头像旁弹出一个轻量资料预览卡片
   （大头像/昵称/在线状态/性别/等级/经验/游戏统计/签名 + 发消息/设置备注/查看资料三按钮），
   离开自动消失。与既有 tooltip.js（纯文本提示）、friend-card（点击全屏资料卡）互不干扰。

   数据来源：
   - 基础信息（在线/头像）：friendList 快照，由 chat.js 暴露 imFriendInfo() 接口
   - 详情（昵称/性别/签名/备注/等级/统计）：PROFILE_QUERY + PROFILE_RESP，30秒本地缓存

   依赖（均来自 chat.js）：
   - window.imFriendInfo(username)   → {username, remark, online, avatar} or null
   - window.imAvatarOf(username)     → 头像URL（含降级）
   - window.imDisplayName(username)  → 展示名（备注→昵称→账号）
   - window.IMSocket                 → WebSocket（PROFILE_QUERY 发送 / PROFILE_RESP 监听）

   引入位置：</body> 前，chat.js 之后（chat.js 需先暴露上述接口）
*/
(function () {
    'use strict';
    if (window.__imHoverCard) return; // 防重复引入
    window.__imHoverCard = true;

    // ===== 配置 =====
    var DELAY_SHOW = 280;   // 悬停多久后显示（防快速划过时闪烁）
    var DELAY_HIDE = 380;   // 离开后多久隐藏（给鼠标移过 gap 到卡片上留够缓冲）
    var CACHE_TTL = 30000;  // 资料缓存有效期 30s
    var MAX_CACHE_ENTRIES = 200; // 缓存上限（超出时淘汰最旧，防悬停陌生人膨胀）
    var LOADING_TIMEOUT = 10000; // PROFILE_QUERY 发出后 10 秒未响应 → 允许重试
    var GAP = 4;            // 卡片与列表栏/头像的间距（贴着边界）

    // ===== 状态 =====
    var cardEl = null;
    var showTimer = null;
    var hideTimer = null;
    var curTarget = null;
    var curUsername = '';
    var profileCache = {};
    var socketBound = false;

    // ===== 工具 =====
    function imSocket() { return window.IMSocket; }
    function msgConst() { return (imSocket() && imSocket().MSG) || {}; }

    function getFriendInfo(u) {
        if (typeof window.imFriendInfo === 'function') return window.imFriendInfo(u);
        return null;
    }
    function getAvatar(u) {
        if (typeof window.imAvatarOf === 'function') return window.imAvatarOf(u);
        var f = getFriendInfo(u);
        return f ? f.avatar : '';
    }
    function getDisplayName(u) {
        if (typeof window.imDisplayName === 'function') return window.imDisplayName(u);
        return u;
    }

    // 格式化小时数：<100 显示一位小数，>=100 取整
    function fmtHours(h) {
        if (!h || h <= 0) return '0';
        if (h >= 100) return Math.round(h) + '';
        return h.toFixed(1).replace(/\.0$/, '');
    }

    // ===== 游戏中心开关判断（后台「功能开关」归口 features.go） =====
    // 语义归口：显式 false 才隐藏，undefined/缺字段=显示（向后兼容旧缓存/旧客户端）
    // 数据来源：chat.js applyUiFeatures 挂的 window.__imUiFeatures；兜底 localStorage 缓存
    var GC_ENABLED_CACHED = null; // 模块级缓存，首次读一次后热更新靠 chat.js 切换
    function isGameCenterEnabled() {
        // 优先 window 上的实时值（chat.js fetch 完 /api/features 会更新）
        var f = window.__imUiFeatures;
        if (!f || typeof f !== 'object') {
            // 兜底：localStorage（chat.js initUiFeatures 存的）
            try { f = JSON.parse(localStorage.getItem('im_ui_features') || 'null'); } catch (e) { f = null; }
        }
        if (!f || typeof f !== 'object') return true; // 完全没数据 → 默认开（安全侧）
        return f.game_center !== false; // 显式 false 才关
    }

    // ===== 卡片 DOM 构建（QQ/Steam 同款宽卡） =====
    function ensureCard() {
        if (cardEl) return cardEl;

        cardEl = document.createElement('div');
        cardEl.className = 'hc-card';
        cardEl.setAttribute('role', 'dialog');
        cardEl.innerHTML =
            '<div class="hc-header">' +
                '<div class="hc-avatar-wrap">' +
                    '<img class="hc-avatar" alt="">' +
                    '<div class="hc-avatar-ph"></div>' +
                    '<span class="hc-online-dot" style="display:none;"></span>' +
                '</div>' +
                '<div class="hc-head-info">' +
                    '<div class="hc-name-row">' +
                        '<span class="hc-name"></span>' +
                        '<span class="hc-gender"></span>' +
                        '<span class="hc-online-badge" style="display:none;">在线</span>' +
                    '</div>' +
                    '<div class="hc-level-row">' +
                        '<span class="hc-level-badge">Lv.<span class="hc-level-num">1</span></span>' +
                        '<span class="hc-title"></span>' +
                    '</div>' +
                    '<div class="hc-playing" style="display:none;">' +
                        '<span class="hc-playing-dot"></span>' +
                        '<span class="hc-playing-label">正在玩</span>' +
                        '<span class="hc-playing-games"></span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="hc-sub-row">' +
                '<span class="hc-username"></span>' +
                '<span class="hc-region"></span>' +
            '</div>' +
            '<div class="hc-signature"></div>' +
            '<div class="hc-divider"></div>' +
            '<div class="hc-stats">' +
                '<div class="hc-stat-item">' +
                    '<span class="hc-stat-num" data-stat="games">0</span>' +
                    '<span class="hc-stat-label">游戏库</span>' +
                '</div>' +
                '<div class="hc-stat-item">' +
                    '<span class="hc-stat-num" data-stat="hours">0</span>' +
                    '<span class="hc-stat-label">游戏时长</span>' +
                '</div>' +
                '<div class="hc-stat-item">' +
                    '<span class="hc-stat-num" data-stat="achievements">0</span>' +
                    '<span class="hc-stat-label">成就</span>' +
                '</div>' +
                '<div class="hc-stat-item">' +
                    '<span class="hc-stat-num" data-stat="badges">0</span>' +
                    '<span class="hc-stat-label">徽章</span>' +
                '</div>' +
            '</div>' +
            '<div class="hc-divider"></div>' +
            '<div class="hc-actions">' +
                '<button class="hc-btn hc-btn-primary hc-btn-chat">发消息</button>' +
                '<div class="hc-sub-actions">' +
                    '<button class="hc-btn hc-btn-secondary hc-btn-remark">设置备注</button>' +
                    '<button class="hc-btn hc-btn-secondary hc-btn-game">查看游戏中心</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(cardEl);

        // 卡片自身 mouseenter/mouseleave —— 鼠标进入卡片清除 hideTimer
        cardEl.addEventListener('mouseenter', function () {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        });
        cardEl.addEventListener('mouseleave', function () {
            scheduleHide();
        });

        // 按钮事件（关键：先把 curUsername 存到局部变量，因为 hideImmediate 会把它清空成 ''！）
        cardEl.querySelector('.hc-btn-chat').addEventListener('click', function (e) {
            e.stopPropagation();
            var target = curUsername;
            if (!target) return;
            hideImmediate();
            if (typeof window.imOpenConversation === 'function') {
                window.imOpenConversation(target);
            }
        });
        cardEl.querySelector('.hc-btn-remark').addEventListener('click', function (e) {
            e.stopPropagation();
            var target = curUsername;
            if (!target) return;
            hideImmediate();
            // 复用 chat.js 的设置备注入口（showPrompt + FRIEND_UPDATE）
            if (typeof window.imShowPrompt === 'function') {
                window.imShowPrompt('设置备注', '请输入好友备注名', function (remark) {
                    var sock = imSocket();
                    if (sock && sock.send) {
                        sock.send({ msg_type: msgConst().FRIEND_UPDATE, to_user: target, remark: remark });
                    }
                });
            }
        });
        cardEl.querySelector('.hc-btn-game').addEventListener('click', function (e) {
            e.stopPropagation();
            // 阶段三百：防御性开关拦截（按钮因任何原因未隐藏时兜底）
            if (!isGameCenterEnabled()) {
                if (typeof window.imShowPrompt === 'function') window.imShowPrompt('游戏中心已被管理员禁用');
                return;
            }
            var target = curUsername;
            if (!target) return;
            hideImmediate();
            // 复用资料卡「查看完整资料」入口：唤醒游戏中心窗 + 投递 openProfile(target)
            if (window.desktop && window.desktop.gameOpenWindow) {
                window.desktop.gameOpenWindow({ profile: target });
            } else {
                window.open('game-store.html?openProfile=' + encodeURIComponent(target), '_blank');
            }
        });

        return cardEl;
    }

    // ===== 填充内容 =====
    function fillPlaceholder(username) {
        ensureCard();
        var f = getFriendInfo(username);
        var online = f ? !!f.online : false;
        // 先从 friendList 取（最可靠），不要先取 PROFILE_RESP 的
        var avatarUrl = getAvatar(username);
        var displayName = getDisplayName(username);
        var gender = 0;
        var signature = '';
        var level = 1;
        var exp = 0;
        var title = '';
        var region = '';
        var stats = null;
        var playingGames = null;
        var isFriend = !!(f && f.remark !== undefined); // friendList 里能看到就是好友

        // 从缓存读已有资料（备注/昵称/性别/签名/等级/统计/正在玩）
        var cached = profileCache[username];
        if (cached && cached.info) {
            var info = cached.info;
            var remark = info.remark || (f ? f.remark : '') || '';
            var nickname = info.nickname || '';
            displayName = remark || nickname || username;
            gender = Number(info.gender) || 0;
            signature = info.signature || '';
            region = info.region || '';
            level = Number(info.level) || 1;
            exp = Number(info.exp) || 0;
            title = info.title || '';
            stats = info.stats || null;
            playingGames = info.playing_games || null;
            if (typeof info.is_friend === 'boolean') isFriend = info.is_friend;
            // 头像：PROFILE_RESP 只在 friendList 没有 avatar 时才兜底用
            if (!avatarUrl && info.avatar) avatarUrl = info.avatar;
        }

        // 头像（img 与占位 div 同槽）
        var img = cardEl.querySelector('.hc-avatar');
        var ph = cardEl.querySelector('.hc-avatar-ph');
        var initial = (displayName || username).charAt(0).toUpperCase();
        var prevSrc = img.getAttribute('src') || '';
        var isImgHidden = img.style.display === 'none';

        if (avatarUrl) {
            if (prevSrc !== avatarUrl || isImgHidden) {
                img.onload = null;
                img.onerror = null;
                img.onerror = function () {
                    img.style.display = 'none';
                    ph.style.display = '';
                    ph.textContent = initial;
                };
                if (prevSrc === avatarUrl) { img.src = ''; }
                img.src = avatarUrl;
            }
            img.style.display = '';
            ph.style.display = 'none';
        } else {
            img.src = '';
            img.style.display = 'none';
            ph.style.display = '';
            ph.textContent = initial;
        }

        // 基础 IM 信息（无论游戏中心开关与否都显示）—— 在线、名称、性别、账号、地区、签名

        // 游戏中心开关：关闭时隐藏等级/正在玩/统计/游戏中心按钮（只保留纯 IM 信息）
        var gcOn = isGameCenterEnabled();

        // 在线状态
        var dot = cardEl.querySelector('.hc-online-dot');
        dot.style.display = online ? '' : 'none';
        var onlineBadge = cardEl.querySelector('.hc-online-badge');
        onlineBadge.style.display = online ? '' : 'none';

        // 名称
        cardEl.querySelector('.hc-name').textContent = displayName;
        var gEl = cardEl.querySelector('.hc-gender');
        gEl.textContent = '';
        gEl.className = 'hc-gender';
        if (gender === 1) { gEl.textContent = '♂'; gEl.classList.add('male'); }
        else if (gender === 2) { gEl.textContent = '♀'; gEl.classList.add('female'); }

        // 等级徽章 + 称号（游戏中心关闭则隐藏整行）
        var levelRow = cardEl.querySelector('.hc-level-row');
        if (!gcOn) {
            levelRow.style.display = 'none';
        } else {
            levelRow.style.display = '';
            cardEl.querySelector('.hc-level-num').textContent = level;
            var titleEl = cardEl.querySelector('.hc-title');
            if (title) {
                titleEl.textContent = title;
                titleEl.style.display = '';
            } else {
                titleEl.textContent = '';
                titleEl.style.display = 'none';
            }
        }

        // 正在玩（游戏中心关闭 / 空数据 都隐藏）
        var playingRow = cardEl.querySelector('.hc-playing');
        if (!gcOn) {
            playingRow.style.display = 'none';
        } else {
            var playingNamesEl = cardEl.querySelector('.hc-playing-games');
            if (playingGames && playingGames.length > 0) {
                var names = [];
                for (var pi = 0; pi < playingGames.length; pi++) {
                    if (playingGames[pi].name) names.push(playingGames[pi].name);
                }
                if (names.length > 0) {
                    var extra = '';
                    if (names.length > 1) {
                        extra = ' · 等' + names.length + '款';
                    }
                    playingNamesEl.textContent = names[0] + extra;
                    playingRow.style.display = '';
                } else {
                    playingRow.style.display = 'none';
                }
            } else {
                playingRow.style.display = 'none';
            }
        }

        // 账号 + 地区
        cardEl.querySelector('.hc-username').textContent = '账号：' + username;
        var regionEl = cardEl.querySelector('.hc-region');
        if (region) {
            regionEl.textContent = ' · ' + region;
            regionEl.style.display = '';
        } else {
            regionEl.textContent = '';
            regionEl.style.display = 'none';
        }

        // 签名（最多 2 行）
        var sigEl = cardEl.querySelector('.hc-signature');
        if (signature) {
            sigEl.textContent = signature;
            sigEl.classList.remove('empty');
        } else {
            sigEl.textContent = '这个人很懒，还没有签名';
            sigEl.classList.add('empty');
        }

        // 游戏统计 + 分隔线（游戏中心关闭则整块隐藏）
        var dividers = cardEl.querySelectorAll('.hc-divider');
        var statsEl = cardEl.querySelector('.hc-stats');
        if (!gcOn) {
            for (var di = 0; di < dividers.length; di++) dividers[di].style.display = 'none';
            statsEl.style.display = 'none';
        } else {
            for (var di2 = 0; di2 < dividers.length; di2++) dividers[di2].style.display = '';
            statsEl.style.display = '';
            var sGames = 0, sHours = 0, sAch = 0, sBadges = 0;
            if (stats) {
                sGames = Number(stats.total_games) || 0;
                sHours = Number(stats.total_play_hours) || 0;
                sAch = Number(stats.total_achievements) || 0;
                sBadges = Number(stats.total_badges) || 0;
            }
            cardEl.querySelector('[data-stat="games"]').textContent = sGames;
            cardEl.querySelector('[data-stat="hours"]').textContent = fmtHours(sHours) + 'h';
            cardEl.querySelector('[data-stat="achievements"]').textContent = sAch;
            cardEl.querySelector('[data-stat="badges"]').textContent = sBadges;
        }

        // 按钮：自己禁用 + 非好友隐藏发消息 + 游戏中心关闭隐藏「查看游戏中心」
        var isSelf = username === (imSocket() && imSocket().getUsername());
        var chatBtn = cardEl.querySelector('.hc-btn-chat');
        var remarkBtn = cardEl.querySelector('.hc-btn-remark');
        var gameBtn = cardEl.querySelector('.hc-btn-game');

        // 发消息：自己禁用
        chatBtn.disabled = isSelf;
        if (isSelf) chatBtn.textContent = '这是你自己';
        else chatBtn.textContent = '发消息';

        // 设置备注：只有好友才显示
        remarkBtn.style.display = (isFriend && !isSelf) ? '' : 'none';

        // 查看游戏中心：游戏中心关闭则隐藏；开启则始终显示（自己/好友/陌生人都可看公开资料）
        gameBtn.style.display = gcOn ? '' : 'none';

        // 若只有一个次按钮，让它独占宽度
        var subActions = cardEl.querySelector('.hc-sub-actions');
        var visibleSubs = subActions.querySelectorAll('.hc-btn-secondary:not([style*="display: none"])');
        subActions.classList.toggle('single', visibleSubs.length === 1);
    }

    // ===== 定位 =====
    // 策略：如果头像在左侧列表栏（#list-panel / #conv-list / #user-list）内，
    // 卡片贴着列表栏的右边界弹出（QQ/微信同款折叠面板边缘对齐）；
    // 如果头像在聊天区（消息气泡），则贴着头像本身。
    function placeNear(target) {
        ensureCard();

        var r = target.getBoundingClientRect();
        var cw = cardEl.scrollWidth;
        var ch = cardEl.scrollHeight;
        var vw = window.innerWidth;
        var vh = window.innerHeight;

        var left, top;

        // === 水平定位 ===
        var panel = target.closest && target.closest('#list-panel, #conv-list, #user-list');
        var anchorRight = null;
        var anchorLeft = null;

        if (panel) {
            var panelRect = panel.getBoundingClientRect();
            if (panelRect.width > 40) {
                anchorRight = panelRect.right;
                anchorLeft = panelRect.left;
            }
        }

        if (anchorRight != null && anchorRight + GAP + cw <= vw - 12) {
            left = anchorRight + GAP;
            cardEl.classList.remove('hc-left-side');
        } else if (anchorLeft != null && anchorLeft - GAP - cw >= 12) {
            left = anchorLeft - GAP - cw;
            cardEl.classList.add('hc-left-side');
        } else if (r.right + GAP + cw <= vw - 12) {
            left = r.right + GAP;
            cardEl.classList.remove('hc-left-side');
        } else if (r.left - GAP - cw >= 12) {
            left = r.left - GAP - cw;
            cardEl.classList.add('hc-left-side');
        } else {
            left = Math.max(12, Math.min(r.left, vw - cw - 12));
            cardEl.classList.remove('hc-left-side');
        }
        if (left < 12) left = 12;
        if (left + cw > vw - 12) left = vw - cw - 12;

        // === 垂直定位 ===
        top = r.top;
        if (top + ch > vh - 12) top = r.bottom - ch;
        if (top < 12) top = 12;
        if (top + ch > vh - 12) top = vh - ch - 12;

        cardEl.style.top = Math.round(top) + 'px';
        cardEl.style.left = Math.round(left) + 'px';
    }

    // ===== 显隐控制 =====
    function show(target, username) {
        curTarget = target;
        curUsername = username;
        fillPlaceholder(username);
        placeNear(target);
        cardEl.classList.add('show');
        ensureDetail(username);
    }

    function hideImmediate() {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        curTarget = null;
        curUsername = '';
        if (cardEl) cardEl.classList.remove('show');
    }

    function scheduleHide() {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (hideTimer) return;
        hideTimer = setTimeout(hideImmediate, DELAY_HIDE);
    }

    function scheduleShow(target, username) {
        if (curTarget === target && cardEl && cardEl.classList.contains('show')) return;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        showTimer = setTimeout(function () {
            showTimer = null;
            show(target, username);
        }, DELAY_SHOW);
    }

    // ===== 资料获取 =====
    function trimProfileCache() {
        var keys = Object.keys(profileCache);
        if (keys.length <= MAX_CACHE_ENTRIES) return;
        keys.sort(function (a, b) {
            return (profileCache[a].ts || 0) - (profileCache[b].ts || 0);
        });
        var drop = Math.floor(keys.length * 0.5);
        for (var i = 0; i < drop; i++) {
            delete profileCache[keys[i]];
        }
    }

    function ensureDetail(username) {
        var cached = profileCache[username];
        var now = Date.now();
        if (cached && cached.info && (now - cached.ts) < CACHE_TTL) {
            if (username === curUsername) {
                fillPlaceholder(username);
                if (curTarget) placeNear(curTarget);
            }
            return;
        }
        if (cached && cached.loading && (now - cached.ts) < LOADING_TIMEOUT) return;
        var sock = imSocket();
        var MSG = msgConst();
        if (!sock || !sock.isConnected || !sock.isConnected()) return;
        trimProfileCache();
        profileCache[username] = { ts: now, loading: true };
        sock.send({ msg_type: MSG.PROFILE_QUERY, to_user: username });
    }

    // ===== PROFILE_RESP 并行监听 =====
    function bindSocket() {
        if (socketBound) return;
        var sock = imSocket();
        var MSG = msgConst();
        if (!sock || typeof sock.on !== 'function' || !MSG.PROFILE_RESP) return;
        socketBound = true;
        sock.on(MSG.PROFILE_RESP, function (msg) {
            var info = null;
            try { info = JSON.parse(msg.content); } catch (e) { return; }
            if (!info || !info.username) return;
            trimProfileCache();
            profileCache[info.username] = { info: info, ts: Date.now(), loading: false };
            if (info.username === curUsername && cardEl && cardEl.classList.contains('show')) {
                fillPlaceholder(curUsername);
                if (curTarget) placeNear(curTarget);
            }
        });
    }

    // 等 socket 就绪
    if (imSocket()) { bindSocket(); }
    else {
        var waitSocket = setInterval(function () {
            if (imSocket()) { bindSocket(); clearInterval(waitSocket); }
        }, 100);
    }

    // ===== 事件绑定入口 =====
    function bindAvatar(avatarEl, username) {
        if (!avatarEl || !username) return;
        if (avatarEl.__hcBound) return;
        avatarEl.__hcBound = true;

        avatarEl.addEventListener('mouseenter', function () {
            scheduleShow(avatarEl, username);
        });
        avatarEl.addEventListener('mouseleave', function (e) {
            var rel = e.relatedTarget;
            if (rel && cardEl && (cardEl === rel || cardEl.contains(rel))) return;
            scheduleHide();
        });
    }

    // ===== 全局事件 =====
    document.addEventListener('mousedown', function (e) {
        if (!cardEl || !cardEl.classList.contains('show')) return;
        if (cardEl.contains(e.target)) return;
        if (curTarget && curTarget.contains(e.target)) return;
        hideImmediate();
    }, true);

    document.addEventListener('scroll', hideImmediate, true);
    window.addEventListener('blur', hideImmediate);
    window.addEventListener('resize', function () {
        if (cardEl && cardEl.classList.contains('show') && curTarget) {
            placeNear(curTarget);
        }
    });

    // ===== 暴露 =====
    window.imHoverCard = {
        bind: bindAvatar,
        hide: hideImmediate,
        reset: function () {
            hideImmediate();
            profileCache = {};
            curTarget = null;
            curUsername = '';
        }
    };

})();
