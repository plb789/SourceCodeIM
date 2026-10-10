/* ===== 阶段二百八十：朋友圈（微信同款） =====
 * 页面形态：网盘/远程控制同款 main-chat 覆盖层；左侧列表两入口（朋友圈/我的相册），
 * 发布页与可见范围选择为独立覆盖浮层；数据归口 /api/moments*，实时归口 108 帧。
 * 依赖（加载顺序在 chat.js 之后保证）：window._osbInit 自绘悬浮滑块 / window.IMContacts
 * 好友数据源 / IMSocket username 与 MOMENT_SYNC 帧 / I18N 多语言。
 * 手机端：入口归口个人资料页"朋友圈"条目（mobile.js 转发 data-target-tab="moments"），
 * 底栏头像红点提醒 + 打开页面整单已读（微信"我"页同款链路）。
 */
(function () {
    'use strict';

    // ---------- DOM 归口 ----------
    var view, pubView, listEl, loadingEl, emptyEl, visMask, visPanel;
    var meNameEl, meAvatarEl;
    var inited = false;
    var visible = false;          // 时间线/相册覆盖页可见
    var mode = 'feed';            // feed 好友时间线 / mine 我的相册
    var loadedFeed = false;       // 首开拉取标记（此后进入静默刷新）
    var cache = [];               // 当前列表数据（id -> item）
    var oldestId = 0;             // 游标分页：当前列表最旧一条 ID
    var noMore = false;           // 底部到底标记
    var loadingMore = false;      // 触底加载防重入
    var myUsername = '';
    var myNickname = '';          // 自身昵称（资料面板已有值时取用，缺失回退账号）
    var myAvatar = '';            // 自身头像（顶栏 current-avatar 归口）

    // ---------- 工具 ----------
    function T(s) { return (window.I18N && I18N.t) ? I18N.t(s) : s; }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function api(path, opts) {
        opts = opts || {};
        opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        return fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'username=' + encodeURIComponent(myUsername), opts)
            .then(function (r) { return r.json(); });
    }
    // 相对时间（微信同款口径：刚刚/N分钟前/N小时前/昨天/M月D日/YYYY年M月D日）
    function fmtTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var diff = (now.getTime() - d.getTime()) / 1000;
        if (diff < 60) return T('刚刚');
        if (diff < 3600) return Math.floor(diff / 60) + ' ' + T('分钟前');
        if (diff < 86400) return Math.floor(diff / 3600) + ' ' + T('小时前');
        var yd = new Date(now.getTime() - 86400 * 1000);
        if (d.getFullYear() === yd.getFullYear() && d.getMonth() === yd.getMonth() && d.getDate() === yd.getDate()) return T('昨天');
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + T('月') + d.getDate() + T('日');
        return d.getFullYear() + T('年') + (d.getMonth() + 1) + T('月') + d.getDate() + T('日');
    }
    // 头像渲染归口（同主界面口径：头像 URL 优先，缺失回退首字母占位，占位色按用户名哈希取色）
    var AV_COLORS = ['#576b95', '#07c160', '#c87d42', '#8f6ec7', '#4a90d9', '#c9584f', '#3aa0a8', '#9a7b4f'];
    function avatarHTML(brief, cls) {
        var name = (brief && (brief.nickname || brief.username)) || '?';
        var url = (brief && brief.avatar) || '';
        var ch = name.trim().charAt(0).toUpperCase();
        var color = AV_COLORS[Math.abs(hashCode(brief ? brief.username || name : '?')) % AV_COLORS.length];
        if (url) {
            return '<span class="' + cls + '" style="background-image:url(\'' + esc(url) + '\')"></span>';
        }
        return '<span class="' + cls + '" style="background-color:' + color + '">' + esc(ch) + '</span>';
    }
    function hashCode(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
        return h;
    }
    function showToast(msg) {
        if (typeof window.showToast === 'function') { window.showToast(msg); return; }
        // 兜底：主界面 toast 未就绪时静默降级为控制台（朋友圈操作失败主链路已有 HTTP 错误提示）
        console.warn('[moments]', msg);
    }
    // 图片查看归口（PC：Electron 桥优先；手机：页内 IMImgLayer 全屏层；桌面浏览器：独立查看器页）
    function openImage(url, list, index) {
        if (window.desktop && window.desktop.openImageViewer) {
            window.desktop.openImageViewer({ url: url, list: list, index: index || 0 });
            return;
        }
        // 手机端（APP/移动布局）走页内查看层（微信同款：下滑/右上角/系统返回键关闭）——
        // 禁止跳独立查看器页：APP 上 window.open 被 mobile.js 归口为同窗跳转，而查看器页的
        // window.close() 对非脚本打开的窗口无效，会卡死在查看器页只能杀进程（真机实测问题）
        if (document.documentElement.classList.contains('m') && window.IMImgLayer &&
            typeof window.IMImgLayer.openList === 'function') {
            window.IMImgLayer.openList(list && list.length ? list.slice() : [url], index || 0);
            return;
        }
        var vList = list && list.length ? list : [url];
        // opener 全局（chat.js 同款，新开标签可达）
        try { window.__imageViewerList = vList; } catch (err) { /* 无害 */ }
        // localStorage 快照（跨标签同源共享，任意打开方式均可达；from=moments 标记防止
        // 聊天查看器同窗跳转场景误读本列表）；fragment 作第三道冗余
        try {
            localStorage.setItem('im_viewer_list', JSON.stringify(vList));
            localStorage.setItem('im_viewer_index', String(index || 0));
        } catch (err) { /* 存储受限：仍有 opener/fragment/单图兜底 */ }
        var frag = '#L=' + encodeURIComponent(JSON.stringify(vList)) + '&I=' + (index || 0);
        window.open('/image-viewer.html?v=7&from=moments&url=' + encodeURIComponent(url) + frag, '_blank');
    }
    // 视频扩展名归口（与服务端 isVideoExt 白名单一致；mov/m4v 浏览器尽力播放）
    function isVideoURL(url) {
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(url || ''));
    }
    function isImageURL(url) {
        return /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(String(url || ''));
    }

    // ---------- 入口提醒（微信发现页朋友圈行头像叠加同款） ----------
    // 服务端 /api/moments/unread 按人聚合返回 actors=[{username,nickname,avatar,count}]（最新在前），
    // 覆盖两类未读：好友发新动态(publish) + 我方动态收到点赞/评论互动(like/comment)。
    // 叠加封顶 3 个防溢出边界，第 3 个带「+N」剩余计数角标
    var ACTOR_MAX = 3;
    function renderActorStack(el, actors) {
        if (!el) return;
        if (!actors || !actors.length) {
            el.innerHTML = '';
            el.classList.add('hidden');
            return;
        }
        var shown = actors.slice(0, ACTOR_MAX);
        var extra = actors.length - shown.length;
        var html = '';
        for (var i = 0; i < shown.length; i++) {
            var a = shown[i];
            var isLast = i === shown.length - 1;
            var tip = a.nickname || a.username;
            if (isLast && extra > 0) tip += ' 等 ' + actors.length + ' 位好友有新动态';
            html += '<span class="mas-item">'
                + avatarHTML(a, 'mas-av')
                + (isLast && extra > 0 ? '<i class="mas-plus">+' + extra + '</i>' : '<i class="mas-dot"></i>')
                + '</span>';
        }
        el.innerHTML = html;
        el.classList.remove('hidden');
    }
    function setBadge(count, actors) {
        // 手机底栏头像角标保持单红点（自己头像上不宜叠加他人头像）
        var navTop = document.querySelector('.nav-top');
        if (navTop) {
            var dot = document.getElementById('nav-top-moments-badge');
            if (!dot) {
                dot = document.createElement('span');
                dot.id = 'nav-top-moments-badge';
                dot.className = 'moments-av-badge hidden';
                navTop.appendChild(dot);
            }
            dot.classList.toggle('hidden', !(count > 0));
        }
        // PC 左栏朋友圈图标 + 手机个人页朋友圈行：好友头像叠加组
        renderActorStack(document.getElementById('nav-moments-actors'), actors);
        renderActorStack(document.getElementById('mpa-moments-actors'), actors);
    }
    function refreshUnread() {
        api('/api/moments/unread').then(function (j) {
            if (j && j.ok) setBadge(j.count || 0, j.actors || []);
        }).catch(function () {});
    }
    function markRead() {
        api('/api/moments/unread/read', { method: 'POST' }).then(function () {
            setBadge(0, []);
        }).catch(function () {});
    }

    // ---------- 列表渲染 ----------
    function renderList(items, append) {
        if (!append) {
            listEl.innerHTML = '';
            cache = [];
        }
        items.forEach(function (m) {
            cache[m.id] = m;
            listEl.appendChild(renderCard(m));
        });
        var has = listEl.children.length > 0;
        emptyEl.classList.toggle('hidden', has);
        emptyEl.textContent = T('还没有动态，快发布第一条吧');
        loadingEl.classList.add('hidden');
        if (window._osbUpdate) window._osbUpdate(view);
    }
    // 单卡片原位重绘（点赞/评论/删除后仅替换该卡片节点，滚动位置/悬停态零扰动）
    function refreshCard(id) {
        var m = cache[id];
        if (!m) return;
        var old = listEl.querySelector('.moment-card[data-mid="' + id + '"]');
        if (old) old.replaceWith(renderCard(m));
    }
    function renderCard(m) {
        var card = document.createElement('div');
        card.className = 'moment-card';
        card.setAttribute('data-mid', m.id);
        var html = avatarHTML(m, 'moment-avatar');
        html += '<div class="moment-main">';
        html += '<span class="moment-nick" data-act="nick">' + esc(m.nickname || m.username) + '</span>';
        if (m.content) html += '<div class="moment-content">' + esc(m.content) + '</div>';
        if (m.images && m.images.length) {
            var n = Math.min(m.images.length, 9);
            html += '<div class="moment-grid mg-' + n + '">';
            for (var i = 0; i < n; i++) {
                // 阶段二百八十一：视频格子（首帧预览 + 播放角标，点击走自绘播放浮层；微信同款）
                if (isVideoURL(m.images[i])) {
                    html += '<span class="moment-img moment-video" data-imgi="' + i + '">' +
                        '<video src="' + esc(m.images[i]) + '" preload="metadata" muted playsinline></video>' +
                        '<i class="mv-play"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l7 4.5-7 4.5z"/></svg></i>' +
                        '</span>';
                } else {
                    html += '<img class="moment-img" src="' + esc(m.images[i]) + '" data-imgi="' + i + '" loading="lazy" alt="">';
                }
            }
            html += '</div>';
        }
        html += '<div class="moment-meta">';
        html += '<span class="moment-time">' + esc(fmtTime(m.create_time)) + '</span>';
        if (m.visibility === 1) html += '<span class="moment-vis-tag">' + T('私密') + '</span>';
        else if (m.visibility === 2) html += '<span class="moment-vis-tag">' + T('部分可见') + '</span>';
        else if (m.visibility === 3) html += '<span class="moment-vis-tag">' + T('不给谁看') + '</span>';
        if (m.is_owner) html += '<button class="moment-del" data-act="del">' + T('删除') + '</button>';
        html += '<span class="moment-flex"></span>';
        html += '<button class="moment-toggle" data-act="toggle" title="' + T('赞 / 评论') + '"><i></i><i></i></button>';
        html += '</div>';
        // 赞/评论 操作条（两圆点弹出，默认收起）
        html += '<div class="moment-act-bar hidden">';
        html += '<button class="moment-act-like" data-act="like">' + (m.liked ? T('取消') : T('赞')) + '</button>';
        html += '<span class="act-div"></span>';
        html += '<button class="moment-act-comment" data-act="comment">' + T('评论') + '</button>';
        html += '</div>';
        // 互动区：点赞名单 + 评论楼（微信同款灰底）
        html += '<div class="moment-interact">' + interactHTML(m) + '</div>';
        // 评论输入行（评论/回复时展开）
        html += '<div class="moment-cinput hidden">' +
            '<input type="text" maxlength="500" placeholder="' + T('评论') + '">' +
            '<button data-act="csend">' + T('发送') + '</button>' +
            '<button class="mc-cancel" data-act="ccancel">' + T('收起') + '</button>' +
            '</div>';
        html += '</div>';
        card.innerHTML = html;
        card.setAttribute('data-replyto', '0');
        card.setAttribute('data-replyname', '');
        return card;
    }
    function interactHTML(m) {
        var html = '';
        if (m.likes && m.likes.length) {
            var names = m.likes.map(function (l) {
                return '<span class="mc-name" data-user="' + esc(l.username) + '">' + esc(l.nickname || l.username) + '</span>';
            }).join('，');
            html += '<div class="moment-like-row">' +
                '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#576b95" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' +
                '<span>' + names + '</span></div>';
        }
        if (m.comments && m.comments.length) {
            if (html) html += '<hr class="moment-like-div">';
            m.comments.forEach(function (c) {
                html += '<div class="moment-comment-item" data-cid="' + c.id + '" data-user="' + esc(c.username) + '">';
                html += '<span class="mc-name">' + esc(c.nickname || c.username) + '</span>';
                if (c.reply_to_name) html += '<span class="mc-text">' + T('回复') + '</span><span class="mc-reply">' + esc(c.reply_to_name) + '</span>';
                html += '<span class="mc-text">：' + esc(c.content) + '</span>';
                if (c.username === myUsername || m.is_owner) {
                    html += '<button class="mc-del" data-act="cdel" data-cid="' + c.id + '">' + T('删除') + '</button>';
                }
                html += '</div>';
            });
        }
        return html;
    }

    // ---------- 数据加载 ----------
    function loadFeed(append) {
        if (loadingMore) return Promise.resolve();
        loadingMore = true;
        var q = '/api/moments' + (mode === 'mine' ? '/mine' : '') +
            (append && oldestId ? '?before_id=' + oldestId : '');
        loadingEl.classList.remove('hidden');
        return api(q).then(function (j) {
            loadingMore = false;
            if (!j || !j.ok) {
                loadingEl.classList.add('hidden');
                showToast(T('朋友圈加载失败'));
                return;
            }
            var items = j.list || [];
            noMore = items.length < 20;
            if (items.length) oldestId = items[items.length - 1].id;
            renderList(items, append);
            if (!append) loadedFeed = true;
        }).catch(function () {
            loadingMore = false;
            loadingEl.classList.add('hidden');
            showToast(T('朋友圈加载失败'));
        });
    }

    // ---------- 打开/关闭（chat.js Tab 联动归口） ----------
    function fillMe() {
        meNameEl.textContent = myNickname || myUsername;
        var img = document.getElementById('current-avatar');
        var ph = document.getElementById('current-avatar-ph');
        if (img && img.style.display !== 'none' && img.getAttribute('src')) {
            meAvatarEl.style.backgroundImage = 'url(\'' + img.getAttribute('src') + '\')';
            meAvatarEl.textContent = '';
        } else if (ph && ph.textContent) {
            meAvatarEl.style.backgroundImage = '';
            meAvatarEl.style.backgroundColor = getComputedStyle(ph).backgroundColor;
            meAvatarEl.textContent = ph.textContent;
        } else {
            meAvatarEl.style.backgroundImage = '';
            meAvatarEl.textContent = (myNickname || myUsername || '?').charAt(0).toUpperCase();
        }
    }
    function open(nextMode) {
        ensureInit();
        mode = (!nextMode || nextMode === 'feed') ? 'feed' : 'mine';
        view.classList.remove('hidden');
        visible = true;
        fillMe();
        loadCover(); // 朋友圈封面（首次拉取，本地缓存后不再重复请求）
        markRead(); // 打开朋友圈整单已读（微信"我"页红点同款链路）
        if (!loadedFeed || !cache.length) {
            oldestId = 0; noMore = false;
            loadFeed(false);
        } else {
            loadFeed(false); // 每次进入静默刷新（原位重绘，工作台/公告同款）
        }
        if (window._osbInit) window._osbInit(view);
    }
    function close() {
        visible = false;
        hideActBars();
        // 退出朋友圈时回收拍摄流与播放浮层（防摄像头/声音后台驻留）
        if (camViewEl && !camViewEl.classList.contains('hidden')) closeCam();
        if (vpViewEl && !vpViewEl.classList.contains('hidden')) closeVideoPlayer();
        // 封面收合归位（微信同款：下次打开从常规高度起，避免残留展开态）
        var cover = document.getElementById('moments-cover');
        if (cover) {
            cover.classList.remove('cover-expanded');
            document.getElementById('moments-cover-menu').classList.add('hidden');
        }
        // 手机端延迟隐藏（滑出动画期间防露底，网盘同款）
        if (document.documentElement.classList.contains('m')) {
            setTimeout(function () { if (!visible) view.classList.add('hidden'); }, 260);
        } else {
            view.classList.add('hidden');
        }
    }
    function isOpen() { return visible; }
    function ensureInit() {
        if (inited) return;
        inited = true;
        // DOM 移入 main-chat（公告流/设置页同款 absolute 覆盖归位）
        var mainChat = document.querySelector('.main-chat');
        if (mainChat && view.parentElement !== mainChat) mainChat.appendChild(view);
        if (mainChat && pubView.parentElement !== mainChat) mainChat.appendChild(pubView);
        // 自身信息归口
        try { myUsername = window.IMSocket.getUsername() || ''; } catch (e) { myUsername = ''; }
        var nickInput = document.getElementById('profile-nickname');
        if (nickInput && nickInput.value) myNickname = nickInput.value;
        // 左侧列表入口（朋友圈 / 我的相册）
        document.getElementById('moments-entry-feed').addEventListener('click', function () { open('feed'); });
        document.getElementById('moments-entry-mine').addEventListener('click', function () { open('mine'); });
        // 封面头像/昵称点按：我的相册 ↔ 好友时间线互切（微信同款点自己头像进相册；
        // 手机端左栏入口不可见，这两个点按是"我的相册"唯一入口）
        var coverToggle = function () { open(mode === 'mine' ? 'feed' : 'mine'); };
        meAvatarEl.addEventListener('click', coverToggle);
        meNameEl.addEventListener('click', coverToggle);
        document.getElementById('moments-back').addEventListener('click', function () {
            // 返回聊天：切回聊天 Tab（微信同款；PC/手机共用）
            var chatTab = document.querySelector('.sidebar-tab[data-tab="chat"]');
            if (chatTab) chatTab.click();
        });
        document.getElementById('moments-camera').addEventListener('click', openPublish);
        // 触底加载（游标分页）
        view.addEventListener('scroll', function () {
            if (!visible || noMore || loadingMore) return;
            if (view.scrollTop + view.clientHeight >= view.scrollHeight - 120) loadFeed(true);
        });
        // 列表事件委托（点赞/评论/回复/删除/图片查看/展开操作条）
        listEl.addEventListener('click', onListClick);
        // 发布页
        initPublish();
        // 封面更换（微信同款右下角相机入口）
        initCover();
        // 实时同步：红点 + 已打开页面原位刷新（不轮询）
        if (window.IMSocket && IMSocket.on) {
            IMSocket.on(IMSocket.MSG.MOMENT_SYNC, onMomentSync);
        }
        // 资料保存后同步自身昵称（fillMe 口径）
        var saveBtn = document.getElementById('profile-save');
        if (saveBtn) saveBtn.addEventListener('click', function () {
            setTimeout(function () {
                if (nickInput && nickInput.value) myNickname = nickInput.value;
                fillMe();
            }, 600);
        });
        refreshUnread();
    }
    function hideActBars() {
        listEl.querySelectorAll('.moment-act-bar').forEach(function (b) { b.classList.add('hidden'); });
        listEl.querySelectorAll('.moment-cinput').forEach(function (c) { c.classList.add('hidden'); });
    }

    // ---------- 列表交互 ----------
    function onListClick(e) {
        var img = e.target.closest('.moment-img');
        if (img) {
            var card = img.closest('.moment-card');
            var m = cache[+card.getAttribute('data-mid')];
            if (m && m.images) {
                // 阶段二百八十一：视频格子走自绘播放浮层（不进图片查看器）
                if (img.classList.contains('moment-video')) {
                    var vi = +img.getAttribute('data-imgi') || 0;
                    openVideoPlayer(m.images[vi]);
                } else {
                    openImage(img.getAttribute('src'), m.images, +img.getAttribute('data-imgi'));
                }
            }
            return;
        }
        var actEl = e.target.closest('[data-act]');
        if (!actEl) {
            // 点评论者昵称：回复该条评论（楼中楼，微信同款；仅评论楼内昵称生效，
            // 点赞名单内昵称不触发）
            var nameEl = e.target.closest('.moment-comment-item .mc-name');
            if (nameEl) {
                var rCard = nameEl.closest('.moment-card');
                var rItem = nameEl.closest('.moment-comment-item');
                if (rCard && rItem) {
                    openCommentInput(rCard, +rItem.getAttribute('data-cid'),
                        (rItem.querySelector('.mc-name') || {}).textContent || '');
                }
                return;
            }
            // 点空白收起已展开的操作条（微信同款）
            if (!e.target.closest('.moment-cinput')) hideActBars();
            return;
        }
        var act = actEl.getAttribute('data-act');
        var card = actEl.closest('.moment-card');
        if (!card) return;
        var id = +card.getAttribute('data-mid');
        var m = cache[id];
        if (!m) return;
        if (act === 'toggle') {
            var bar = card.querySelector('.moment-act-bar');
            bar.classList.toggle('hidden');
        } else if (act === 'like') {
            doLike(m, card);
        } else if (act === 'comment') {
            openCommentInput(card, 0, '');
        } else if (act === 'del') {
            confirmMomentDelete(m);
        } else if (act === 'cdel') {
            e.stopPropagation();
            doCommentDelete(m, +actEl.getAttribute('data-cid'), card);
        } else if (act === 'csend') {
            sendComment(m, card);
        } else if (act === 'ccancel') {
            card.querySelector('.moment-cinput').classList.add('hidden');
        }
    }
    function doLike(m, card) {
        var method = m.liked ? 'DELETE' : 'POST';
        api('/api/moments/' + m.id + '/like', { method: method }).then(function (j) {
            if (!j || !j.ok) { showToast(T('操作失败')); return; }
            if (m.liked) {
                m.likes = (m.likes || []).filter(function (l) { return l.username !== myUsername; });
                m.liked = false;
            } else {
                m.likes = (m.likes || []).concat([{ username: myUsername, nickname: myNickname || myUsername, avatar: myAvatar }]);
                m.liked = true;
            }
            refreshCard(m.id);
        }).catch(function () { showToast(T('操作失败')); });
    }
    function openCommentInput(card, replyTo, replyName) {
        hideActBars();
        var wrap = card.querySelector('.moment-cinput');
        var input = wrap.querySelector('input');
        card.setAttribute('data-replyto', String(replyTo));
        card.setAttribute('data-replyname', replyName || '');
        input.placeholder = replyName ? (T('回复') + replyName) : T('评论');
        wrap.classList.remove('hidden');
        setTimeout(function () { input.focus(); }, 60);
    }
    function sendComment(m, card) {
        var wrap = card.querySelector('.moment-cinput');
        var input = wrap.querySelector('input');
        var content = input.value.trim();
        if (!content) return;
        var replyTo = +card.getAttribute('data-replyto') || 0;
        var replyName = card.getAttribute('data-replyname') || '';
        api('/api/moments/' + m.id + '/comments', {
            method: 'POST',
            body: JSON.stringify({ content: content, reply_to: replyTo })
        }).then(function (j) {
            if (!j || !j.ok) { showToast((j && j.error) ? j.error : T('评论失败')); return; }
            m.comments = (m.comments || []).concat([{
                id: j.id, username: myUsername, nickname: myNickname || myUsername,
                avatar: myAvatar, reply_to: replyTo, reply_to_user: replyTo ? (replyToNameOf(m, replyTo) || replyName) : '',
                reply_to_name: replyTo ? (replyToNameOf(m, replyTo) || replyName) : '', content: content
            }]);
            input.value = '';
            card.querySelector('.moment-cinput').classList.add('hidden');
            refreshCard(m.id);
        }).catch(function () { showToast(T('评论失败')); });
    }
    function replyToNameOf(m, cid) {
        var c = (m.comments || []).filter(function (x) { return x.id === cid; })[0];
        return c ? (c.nickname || c.username) : '';
    }
    function doCommentDelete(m, cid, card) {
        api('/api/moments/' + m.id + '/comment/' + cid, { method: 'DELETE' }).then(function (j) {
            if (!j || !j.ok) { showToast(T('删除失败')); return; }
            m.comments = (m.comments || []).filter(function (c) { return c.id !== cid; });
            refreshCard(m.id);
        }).catch(function () { showToast(T('删除失败')); });
    }
    // 自绘确认弹窗（禁用系统默认弹窗，项目规则）
    function confirmMomentDelete(m) {
        var mask = document.createElement('div');
        mask.className = 'moments-vis-mask';
        var box = document.createElement('div');
        box.className = 'moments-vis-panel';
        box.style.width = '300px';
        box.innerHTML = '<div class="moments-vis-head" style="justify-content:center;border-bottom:1px solid var(--divider)">' +
            '<span class="moments-vis-title" style="font-weight:400">' + T('删除该朋友圈？') + '</span></div>' +
            '<div style="display:flex;border-top:1px solid var(--divider)">' +
            '<button class="moments-vis-cancel" style="flex:1;padding:12px 0;border-right:1px solid var(--divider);color:var(--text)">' + T('取消') + '</button>' +
            '<button class="moments-vis-ok" style="flex:1;padding:12px 0;color:#fa5151">' + T('删除') + '</button></div>';
        mask.appendChild(box);
        document.body.appendChild(mask);
        mask.querySelector('.moments-vis-cancel').addEventListener('click', function () { document.body.removeChild(mask); });
        mask.querySelector('.moments-vis-ok').addEventListener('click', function () {
            document.body.removeChild(mask);
            api('/api/moments/' + m.id, { method: 'DELETE' }).then(function (j) {
                if (!j || !j.ok) { showToast(T('删除失败')); return; }
                delete cache[m.id];
                var node = listEl.querySelector('.moment-card[data-mid="' + m.id + '"]');
                if (node) node.remove();
                if (!listEl.children.length) {
                    emptyEl.classList.remove('hidden');
                    emptyEl.textContent = T('还没有动态，快发布第一条吧');
                }
            }).catch(function () { showToast(T('删除失败')); });
        });
        mask.addEventListener('click', function (e) { if (e.target === mask) document.body.removeChild(mask); });
    }

    // ---------- 实时同步（108 帧） ----------
    function onMomentSync(msg) {
        var data = null;
        try { data = JSON.parse(msg.content); } catch (e) { return; }
        if (!data) return;
        refreshUnread(); // 红点归口：所有互动都影响"我的动态"未读（服务端已按目标过滤）
        if (!visible || !loadedFeed) return;
        // 已打开页面：静默刷新原位重绘（发布/点赞/评论实时可见，微信同款）；
        // 评论输入中跳过（防输入被打断，重新打开时自动拉取）
        if (listEl.querySelector('.moment-cinput:not(.hidden)')) return;
        oldestId = 0; noMore = false;
        loadFeed(false);
    }

    // ---------- 发布页 ----------
    var pubImages = [];      // 已上传媒体 URL（图片+视频；单视频独占，微信同款）
    var pubUploading = 0;    // 上传中计数（发表按钮守卫）
    var pubVis = 0;          // 0公开 1私密 2部分可见 3不给谁看
    var pubVisUsers = [];    // 部分/不给谁看名单
    var VIS_NAMES = {};
    function openPublish() {
        pubView.classList.remove('hidden');
        document.getElementById('moments-pub-text').focus();
    }
    function closePublish() {
        pubView.classList.add('hidden');
        // 微信同款：取消时保留草稿不清空（切换主题等不丢内容）；发表成功才清空
        hideVisPanel();
    }
    function initPublish() {
        pubView = document.getElementById('moments-publish-view');
        var fileInput = document.getElementById('moments-pub-file');
        VIS_NAMES = { 0: T('公开'), 1: T('私密'), 2: T('部分可见'), 3: T('不给谁看') };
        document.getElementById('moments-pub-cancel').addEventListener('click', closePublish);
        document.getElementById('moments-pub-add').addEventListener('click', function () {
            if (hasPubVideo()) { showToast(T('视频动态仅支持单个视频')); return; }
            if (pubImages.length >= 9) { showToast(T('最多上传 9 张图片')); return; }
            fileInput.click();
        });
        document.getElementById('moments-pub-shot').addEventListener('click', function () {
            if (pubImages.length && !hasPubVideo() && pubImages.length >= 9) { showToast(T('最多上传 9 张图片')); return; }
            openCam('publish');
        });
        fileInput.addEventListener('change', function () {
            var files = Array.prototype.slice.call(fileInput.files || []);
            fileInput.value = '';
            files.forEach(function (f) {
                if (/^video\//.test(f.type)) {
                    // 微信同款：视频独占——已在九宫格时忽略多余选择
                    if (hasPubVideo()) return;
                    uploadMomentMedia(f);
                } else {
                    if (hasPubVideo()) return; // 已选视频时忽略图片（提示在 uploadMomentMedia 内）
                    if (pubImages.length >= 9) return;
                    uploadMomentMedia(f);
                }
            });
        });
        document.getElementById('moments-pub-send').addEventListener('click', publish);
        document.getElementById('moments-pub-vis').addEventListener('click', showVisPanel);
        document.getElementById('moments-vis-cancel').addEventListener('click', hideVisPanel);
        document.getElementById('moments-vis-ok').addEventListener('click', applyVis);
        visMask = document.getElementById('moments-vis-mask');
        visPanel = document.getElementById('moments-vis-panel');
        visMask.addEventListener('click', hideVisPanel);
        document.querySelectorAll('.moments-vis-opt').forEach(function (opt) {
            opt.addEventListener('click', function () {
                var v = +opt.getAttribute('data-vis');
                document.querySelectorAll('.moments-vis-opt').forEach(function (o) { o.classList.toggle('selected', o === opt); });
                var friendBox = document.getElementById('moments-vis-friends');
                if (v === 2 || v === 3) {
                    friendBox.classList.remove('hidden');
                    renderVisFriends('');
                } else {
                    friendBox.classList.add('hidden');
                }
            });
        });
        document.getElementById('moments-vis-search').addEventListener('input', function () {
            renderVisFriends(this.value.trim());
        });
        // Esc 逐级：页内图片层（窄窗口浏览器 html.m 场景，与 mobile.js 返回键同优先级）
        // → 拍摄浮层 → 视频浮层 → 可见范围浮层 → 发布页
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (window.IMImgLayer && IMImgLayer.isOpen()) { IMImgLayer.close(); return; }
            if (!camViewEl.classList.contains('hidden')) { closeCam(); return; }
            if (!vpViewEl.classList.contains('hidden')) { closeVideoPlayer(); return; }
            if (!visPanel.classList.contains('hidden')) { hideVisPanel(); return; }
            if (!pubView.classList.contains('hidden')) { closePublish(); return; }
        });
        if (window._osbInit) window._osbInit(document.getElementById('moments-vis-friend-list'));
        initCam();
        initVideoPlayer();
    }
    function hasPubVideo() {
        return pubImages.some(isVideoURL);
    }
    function uploadMomentMedia(file) {
        var isVideo = /^video\//.test(file.type) || isVideoURL(file.name);
        if (!isVideo && !/^image\//.test(file.type)) { showToast(T('朋友圈仅支持图片/视频文件')); return; }
        // 微信同款：单视频独占，视频与图片互斥
        if (isVideo) {
            if (hasPubVideo()) { showToast(T('视频动态仅支持单个视频')); return; }
            if (pubImages.length) { showToast(T('视频不能与图片同时发布')); return; }
        } else if (hasPubVideo()) {
            showToast(T('视频不能与图片同时发布'));
            return;
        }
        pubUploading++;
        updateSendState();
        var fd = new FormData();
        fd.append('file', file);
        fetch((isVideo ? '/upload/moment/video' : '/upload/moment/image') + '?username=' + encodeURIComponent(myUsername), { method: 'POST', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                pubUploading--;
                if (j && j.url) { pubImages.push(j.url); renderPubGrid(); }
                else showToast(isVideo ? T('视频上传失败') : T('图片上传失败'));
                updateSendState();
            })
            .catch(function () {
                pubUploading--;
                showToast(isVideo ? T('视频上传失败') : T('图片上传失败'));
                updateSendState();
            });
    }
    function renderPubGrid() {
        var grid = document.getElementById('moments-pub-grid');
        var addBtn = document.getElementById('moments-pub-add');
        grid.querySelectorAll('.moments-pub-thumb').forEach(function (t) { t.remove(); });
        pubImages.forEach(function (url, i) {
            var thumb = document.createElement('div');
            thumb.className = 'moments-pub-thumb';
            if (isVideoURL(url)) {
                thumb.innerHTML = '<video src="' + esc(url) + '" preload="metadata" muted playsinline></video>' +
                    '<i class="pub-thumb-play"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l7 4.5-7 4.5z"/></svg></i>';
            } else {
                thumb.innerHTML = '<img src="' + esc(url) + '" alt="">';
            }
            thumb.innerHTML += '<button class="pub-thumb-del" data-i="' + i + '"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>';
            grid.insertBefore(thumb, addBtn);
        });
        grid.querySelectorAll('.pub-thumb-del').forEach(function (btn) {
            btn.addEventListener('click', function () {
                pubImages.splice(+btn.getAttribute('data-i'), 1);
                renderPubGrid();
            });
        });
        // 视频独占时隐藏加号与拍摄格（微信同款单格视频）
        var hasV = hasPubVideo();
        addBtn.style.display = (pubImages.length >= 9 || hasV) ? 'none' : '';
        document.getElementById('moments-pub-shot').style.display = hasV ? 'none' : '';
    }
    function updateSendState() {
        document.getElementById('moments-pub-send').disabled = pubUploading > 0;
    }
    function publish() {
        var textEl = document.getElementById('moments-pub-text');
        var content = textEl.value.trim();
        if (!content && !pubImages.length) { showToast(T('内容不能为空')); return; }
        if (pubUploading > 0) { showToast(T('图片上传中，请稍候')); return; }
        if (hasPubVideo() && pubImages.length > 1) { showToast(T('视频动态仅支持单个视频')); return; }
        var body = {
            content: content,
            images: pubImages,
            visibility: pubVis,
            visible_users: (pubVis === 2 || pubVis === 3) ? pubVisUsers : []
        };
        if ((pubVis === 2 || pubVis === 3) && !pubVisUsers.length) { showToast(T('请选择可见范围好友')); return; }
        var sendBtn = document.getElementById('moments-pub-send');
        sendBtn.disabled = true;
        api('/api/moments', { method: 'POST', body: JSON.stringify(body) }).then(function (j) {
            sendBtn.disabled = false;
            if (!j || !j.ok) { showToast((j && j.error) ? j.error : T('发布失败')); return; }
            textEl.value = '';
            pubImages = [];
            renderPubGrid();
            pubVis = 0; pubVisUsers = [];
            document.getElementById('moments-pub-vis-text').textContent = VIS_NAMES[0];
            closePublish();
            oldestId = 0; noMore = false;
            loadFeed(false); // 发布成功回列表并置顶（微信同款）
        }).catch(function () {
            sendBtn.disabled = false;
            showToast(T('发布失败'));
        });
    }

    // ---------- 拍摄浮层（微信同款：getUserMedia 预览，轻触拍照/按住录像 15 秒上限） ----------
    // target 归口：'publish' 拍完进发布页九宫格；'cover' 拍完直接设为朋友圈封面
    var camViewEl, camVideoEl, camStream = null, camFacing = 'user', camTarget = 'publish';
    var camRecording = false, camRecorder = null, camChunks = [], camTimer = null;
    var camPressTimer = null, camPressAt = 0, camRingTimer = null, camRecordStart = 0;
    var CAM_MAX_MS = 15000; // 微信同款 15 秒上限
    function initCam() {
        camViewEl = document.getElementById('moments-cam-view');
        // 封面拍摄入口在时间线页（发布页可能未开）：浮层 DOM 移入 main-chat 保证独立可见
        var mainChat = document.querySelector('.main-chat');
        if (mainChat && camViewEl.parentElement !== mainChat) mainChat.appendChild(camViewEl);
        camVideoEl = document.getElementById('moments-cam-video');
        document.getElementById('moments-cam-close').addEventListener('click', closeCam);
        document.getElementById('moments-cam-flip').addEventListener('click', flipCam);
        var shutter = document.getElementById('moments-cam-shutter');
        // 指针统一处理（鼠标/触摸）：按下 300ms 后自动进入录像，松开时按住时长判定拍照/停录
        shutter.addEventListener('pointerdown', function (e) {
            if (camRecording) return;
            e.preventDefault();
            camPressAt = Date.now();
            camPressTimer = setTimeout(startCamRecord, 300);
        });
        shutter.addEventListener('pointerup', function () {
            clearTimeout(camPressTimer);
            if (camRecording) {
                stopCamRecord();
            } else if (Date.now() - camPressAt < 300) {
                shootCamPhoto();
            }
        });
        shutter.addEventListener('pointerleave', function () {
            if (camRecording) stopCamRecord();
        });
    }
    function openCam(target) {
        camTarget = target || 'publish';
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast(T('当前环境不支持摄像头'));
            return;
        }
        camViewEl.classList.remove('hidden');
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
            audio: true
        }).then(function (stream) {
            camStream = stream;
            camVideoEl.srcObject = stream;
        }).catch(function () {
            closeCam();
            showToast(T('无法访问摄像头，请检查权限'));
        });
    }
    function closeCam() {
        if (camRecording) { try { camRecorder.state !== 'inactive' && camRecorder.stop(); } catch (e) {} camRecording = false; }
        clearTimeout(camPressTimer);
        clearInterval(camRingTimer);
        if (camStream) {
            camStream.getTracks().forEach(function (t) { t.stop(); });
            camStream = null;
        }
        camVideoEl.srcObject = null;
        camViewEl.classList.add('hidden');
        resetCamRing();
        document.getElementById('moments-cam-hint').textContent = T('轻触拍照，按住摄像');
    }
    function flipCam() {
        camFacing = camFacing === 'user' ? 'environment' : 'user';
        if (!camStream) return;
        // 重新取流（前后摄切换；PC 单摄时 facingMode 约束不满足则保持原流）
        if (camStream) camStream.getTracks().forEach(function (t) { t.stop(); });
        navigator.mediaDevices.getUserMedia({
            video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
            audio: true
        }).then(function (stream) {
            camStream = stream;
            camVideoEl.srcObject = stream;
        }).catch(function () {
            camFacing = camFacing === 'user' ? 'environment' : 'user';
            showToast(T('摄像头切换失败'));
        });
    }
    function shootCamPhoto() {
        if (!camStream || !camVideoEl.videoWidth) { showToast(T('摄像头未就绪')); return; }
        var canvas = document.createElement('canvas');
        canvas.width = camVideoEl.videoWidth;
        canvas.height = camVideoEl.videoHeight;
        var ctx = canvas.getContext('2d');
        // 前摄镜像与预览一致（微信同款自拍体验）
        if (camFacing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(camVideoEl, 0, 0);
        canvas.toBlob(function (blob) {
            if (!blob) { showToast(T('拍照失败')); return; }
            closeCam();
            var file = new File([blob], 'cam_' + Date.now() + '.jpg', { type: 'image/jpeg' });
            if (camTarget === 'cover') uploadCoverFile(file);
            else uploadMomentMedia(file);
        }, 'image/jpeg', 0.92);
    }
    function startCamRecord() {
        if (!camStream || camRecording) return;
        var mimes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
        var mime = '';
        for (var i = 0; i < mimes.length; i++) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported(mimes[i])) { mime = mimes[i]; break; }
        }
        if (!window.MediaRecorder) { showToast(T('当前环境不支持录像')); return; }
        try {
            camRecorder = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined);
        } catch (e) {
            showToast(T('当前环境不支持录像'));
            return;
        }
        camChunks = [];
        camRecorder.ondataavailable = function (e) { if (e.data && e.data.size) camChunks.push(e.data); };
        camRecorder.onstop = function () {
            camRecording = false;
            clearInterval(camRingTimer);
            resetCamRing();
            var type = (camRecorder.mimeType || 'video/webm').indexOf('mp4') >= 0 ? 'video/mp4' : 'video/webm';
            var ext = type === 'video/mp4' ? '.mp4' : '.webm';
            var blob = new Blob(camChunks, { type: type });
            document.getElementById('moments-cam-hint').textContent = T('轻触拍照，按住摄像');
            if (!blob.size) return;
            closeCam();
            var file = new File([blob], 'cam_' + Date.now() + ext, { type: type });
            if (camTarget === 'cover') uploadCoverFile(file);
            else uploadMomentMedia(file);
        };
        camRecorder.start(250);
        camRecording = true;
        camRecordStart = Date.now();
        document.getElementById('moments-cam-hint').textContent = T('松开结束，最长 15 秒');
        // 环形进度（15 秒走满一圈）
        var fg = document.getElementById('moments-cam-ring-fg');
        var circumference = 2 * Math.PI * 39;
        camRingTimer = setInterval(function () {
            var p = Math.min((Date.now() - camRecordStart) / CAM_MAX_MS, 1);
            fg.style.strokeDashoffset = String(circumference * (1 - p));
        }, 100);
        camTimer = setTimeout(function () { if (camRecording) stopCamRecord(); }, CAM_MAX_MS);
    }
    function stopCamRecord() {
        clearTimeout(camTimer);
        if (camRecording && camRecorder && camRecorder.state !== 'inactive') camRecorder.stop();
    }
    function resetCamRing() {
        var fg = document.getElementById('moments-cam-ring-fg');
        if (fg) fg.style.strokeDashoffset = String(2 * Math.PI * 39);
    }

    // ---------- 视频播放浮层（自绘控制条，禁用原生控件） ----------
    var vpViewEl, vpVideoEl, vpBarDrag = false;
    function initVideoPlayer() {
        vpViewEl = document.getElementById('moments-video-view');
        // 播放浮层独立于发布页/时间线（video-view DOM 挪入 main-chat 同 cam-view 归口）
        var mainChat = document.querySelector('.main-chat');
        if (mainChat && vpViewEl.parentElement !== mainChat) mainChat.appendChild(vpViewEl);
        vpVideoEl = document.getElementById('moments-vp-video');
        document.getElementById('moments-vp-close').addEventListener('click', closeVideoPlayer);
        document.getElementById('moments-vp-play').addEventListener('click', function () {
            if (vpVideoEl.paused) vpVideoEl.play(); else vpVideoEl.pause();
        });
        document.getElementById('moments-vp-mute').addEventListener('click', function () {
            vpVideoEl.muted = !vpVideoEl.muted;
            this.classList.toggle('muted', vpVideoEl.muted);
        });
        vpVideoEl.addEventListener('play', vpSyncPlayIco);
        vpVideoEl.addEventListener('pause', vpSyncPlayIco);
        vpVideoEl.addEventListener('timeupdate', vpSyncBar);
        vpVideoEl.addEventListener('loadedmetadata', function () {
            document.getElementById('moments-vp-dur').textContent = vpFmtTime(vpVideoEl.duration);
        });
        // 进度条：点击跳转 + 拖动跟手
        var bar = document.getElementById('moments-vp-bar');
        bar.addEventListener('pointerdown', function (e) {
            vpBarDrag = true;
            bar.setPointerCapture(e.pointerId);
            vpSeek(e);
        });
        bar.addEventListener('pointermove', function (e) { if (vpBarDrag) vpSeek(e); });
        bar.addEventListener('pointerup', function () { vpBarDrag = false; });
    }
    function openVideoPlayer(url) {
        vpViewEl.classList.remove('hidden');
        vpVideoEl.muted = false;
        document.getElementById('moments-vp-mute').classList.remove('muted');
        vpVideoEl.src = url;
        vpVideoEl.play().catch(function () { /* 自动播失败保持暂停态，用户点播放键 */ });
    }
    function closeVideoPlayer() {
        vpVideoEl.pause();
        vpVideoEl.removeAttribute('src');
        vpVideoEl.load();
        vpViewEl.classList.add('hidden');
    }
    function vpSyncPlayIco() {
        document.getElementById('moments-vp-play-ico').setAttribute('d',
            vpVideoEl.paused ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
    }
    function vpSyncBar() {
        if (vpBarDrag) return;
        var dur = vpVideoEl.duration || 0;
        var p = dur ? vpVideoEl.currentTime / dur : 0;
        document.getElementById('moments-vp-bar-fill').style.width = (p * 100) + '%';
        document.getElementById('moments-vp-bar-dot').style.left = (p * 100) + '%';
        document.getElementById('moments-vp-cur').textContent = vpFmtTime(vpVideoEl.currentTime);
    }
    function vpSeek(e) {
        var rect = e.currentTarget.getBoundingClientRect();
        var p = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        if (vpVideoEl.duration) {
            vpVideoEl.currentTime = p * vpVideoEl.duration;
            vpSyncBar();
        }
    }
    function vpFmtTime(s) {
        if (!isFinite(s)) return '00:00';
        s = Math.floor(s);
        var m = Math.floor(s / 60), sec = s % 60;
        return (m < 10 ? '0' + m : m) + ':' + (sec < 10 ? '0' + sec : sec);
    }

    // ---------- 朋友圈封面（微信同款"更换相册封面"：图片/GIF/短视频，免裁剪直接铺满） ----------
    var coverLoaded = false;
    function loadCover() {
        if (coverLoaded) return;
        coverLoaded = true;
        api('/api/moments/cover').then(function (j) {
            if (j && j.ok) applyCover(j.cover || '');
        }).catch(function () { coverLoaded = false; });
    }
    function applyCover(url) {
        var box = document.getElementById('moments-cover-media');
        if (!url) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }
        box.classList.remove('hidden');
        if (isVideoURL(url)) {
            // 视频封面：静音循环自动播放（微信同款动态封面体验）
            box.innerHTML = '<video src="' + esc(url) + '" autoplay muted loop playsinline></video>';
        } else {
            box.innerHTML = '<img src="' + esc(url) + '" alt="">';
        }
    }
    function uploadCoverFile(file) {
        var isVideo = /^video\//.test(file.type) || isVideoURL(file.name);
        if (!isVideo && !/^image\//.test(file.type)) { showToast(T('封面仅支持图片/视频文件')); return; }
        showToast(T('封面上传中…'));
        var fd = new FormData();
        fd.append('file', file);
        fetch((isVideo ? '/upload/moment/video' : '/upload/moment/image') + '?username=' + encodeURIComponent(myUsername), { method: 'POST', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (!j || !j.url) { showToast(T('封面上传失败')); return; }
                return api('/api/moments/cover', { method: 'POST', body: JSON.stringify({ url: j.url }) });
            })
            .then(function (j) {
                if (j && j.ok) { applyCover(j.cover); showToast(T('封面已更新')); }
                else if (j) showToast((j && j.error) ? j.error : T('封面上传失败'));
            })
            .catch(function () { showToast(T('封面上传失败')); });
    }
    function initCover() {
        var cover = document.getElementById('moments-cover');
        var menu = document.getElementById('moments-cover-menu');
        var fileInput = document.getElementById('moments-cover-file');
        // 微信同款：点封面图拉伸展开/收起，展开后才浮现「换封面」按钮（按钮/菜单点击不参与切换）
        cover.addEventListener('click', function (e) {
            if (e.target.closest('#moments-cover-change') || e.target.closest('#moments-cover-menu')) return;
            var expanded = cover.classList.toggle('cover-expanded');
            if (!expanded) menu.classList.add('hidden');
        });
        document.getElementById('moments-cover-change').addEventListener('click', function (e) {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });
        document.getElementById('moments-cover-pick').addEventListener('click', function () {
            menu.classList.add('hidden');
            fileInput.click();
        });
        document.getElementById('moments-cover-shot').addEventListener('click', function () {
            menu.classList.add('hidden');
            openCam('cover');
        });
        document.getElementById('moments-cover-reset').addEventListener('click', function () {
            menu.classList.add('hidden');
            api('/api/moments/cover', { method: 'DELETE' }).then(function (j) {
                if (j && j.ok) { applyCover(''); showToast(T('已恢复默认封面')); }
            }).catch(function () { showToast(T('操作失败')); });
        });
        fileInput.addEventListener('change', function () {
            var f = (fileInput.files || [])[0];
            fileInput.value = '';
            if (f) uploadCoverFile(f);
        });
        // 点封面以外区域：收起封面菜单并收合展开态
        document.addEventListener('click', function (e) {
            if (!e.target.closest('#moments-cover')) {
                menu.classList.add('hidden');
                cover.classList.remove('cover-expanded');
            }
        });
    }

    // ---------- 可见范围选择 ----------
    var visTemp = 0;        // 浮层内暂存（完成才回写发布态）
    var visTempUsers = [];
    function showVisPanel() {
        visTemp = pubVis;
        visTempUsers = pubVisUsers.slice();
        document.querySelectorAll('.moments-vis-opt').forEach(function (o) {
            o.classList.toggle('selected', +o.getAttribute('data-vis') === pubVis);
        });
        var friendBox = document.getElementById('moments-vis-friends');
        if (pubVis === 2 || pubVis === 3) {
            friendBox.classList.remove('hidden');
            renderVisFriends('');
        } else {
            friendBox.classList.add('hidden');
        }
        visMask.classList.remove('hidden');
        visPanel.classList.remove('hidden');
    }
    function hideVisPanel() {
        visMask.classList.add('hidden');
        visPanel.classList.add('hidden');
    }
    function applyVis() {
        var selected = document.querySelector('.moments-vis-opt.selected');
        var v = selected ? +selected.getAttribute('data-vis') : pubVis;
        if ((v === 2 || v === 3) && !visTempUsers.length) { showToast(T('请选择好友')); return; }
        pubVis = v;
        pubVisUsers = visTempUsers;
        document.getElementById('moments-pub-vis-text').textContent = VIS_NAMES[v];
        hideVisPanel();
    }
    // 好友多选列表（数据源 window.IMContacts 归口，与主界面零双源）
    function renderVisFriends(kw) {
        var box = document.getElementById('moments-vis-friend-list');
        var friends = [];
        try { friends = (window.IMContacts && IMContacts.friends()) || []; } catch (e) {}
        var html = '';
        friends.forEach(function (f) {
            var name = f.remark || f.nickname || f.username;
            if (kw && name.toLowerCase().indexOf(kw.toLowerCase()) < 0 && f.username.toLowerCase().indexOf(kw.toLowerCase()) < 0) return;
            var sel = visTempUsers.indexOf(f.username) >= 0 ? ' selected' : '';
            html += '<button class="moments-vis-friend' + sel + '" data-u="' + esc(f.username) + '">' +
                avatarHTML({ username: f.username, nickname: name, avatar: f.avatar }, 'vf-avatar') +
                '<span>' + esc(name) + '</span><span class="vf-check"></span></button>';
        });
        if (!html) html = '<div class="moment-empty">' + T('暂无好友') + '</div>';
        box.innerHTML = html;
        box.querySelectorAll('.moments-vis-friend').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var u = btn.getAttribute('data-u');
                var idx = visTempUsers.indexOf(u);
                if (idx >= 0) visTempUsers.splice(idx, 1);
                else visTempUsers.push(u);
                btn.classList.toggle('selected');
            });
        });
        if (window._osbUpdate) window._osbUpdate(box);
    }

    // ---------- 启动 ----------
    function boot() {
        view = document.getElementById('moments-view');
        pubView = document.getElementById('moments-publish-view');
        listEl = document.getElementById('moments-list');
        loadingEl = document.getElementById('moments-loading');
        emptyEl = document.getElementById('moments-empty');
        meNameEl = document.getElementById('moments-me-name');
        meAvatarEl = document.getElementById('moments-me-avatar');
        if (!view || !pubView) return;
        // 懒初始化：首个 open() 触发（chat.js Tab 切换 / mobile.js 个人页转发 / 左侧入口）
        window.IMMoments = { open: open, close: close, isOpen: isOpen };
        watchLogin();
    }
    // ---------- 登录后红点预取 ----------
    // 红点必须在登录后即可见（无需先打开朋友圈）：轮询等 IMSocket 就绪拿到账号即拉未读，
    // 覆盖"登录时已有新互动"与"登出后换号重登"两种场景；拿不到（未登录）2 分钟后停止
    function watchLogin() {
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            var u = '';
            try { u = (window.IMSocket && IMSocket.getUsername) ? (IMSocket.getUsername() || '') : ''; } catch (e) {}
            if (u && u !== myUsername) {
                myUsername = u;
                refreshUnread();
            }
            if (u || tries > 60) clearInterval(timer);
        }, 2000);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
