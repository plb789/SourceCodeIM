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
    // 图片查看归口（与聊天图片一致：Electron 桥优先，浏览器回退独立窗口查看器）
    function openImage(url, list, index) {
        if (window.desktop && window.desktop.openImageViewer) {
            window.desktop.openImageViewer({ url: url, list: list, index: index || 0 });
            return;
        }
        window.open('/image-viewer.html?v=5&url=' + encodeURIComponent(url), '_blank');
    }

    // ---------- 红点归口（导航图标 / 手机个人页行 / 手机底栏头像） ----------
    function setBadge(count) {
        var text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
        var nav = document.getElementById('nav-moments-badge');
        if (nav) {
            nav.textContent = text;
            nav.classList.toggle('hidden', !text);
        }
        var mpa = document.getElementById('mpa-moments-badge');
        if (mpa) mpa.classList.toggle('hidden', !text);
        // 手机底栏头像角标（微信"我"页红点同款：动态创建，幂等）
        var navTop = document.querySelector('.nav-top');
        if (navTop) {
            var dot = document.getElementById('nav-top-moments-badge');
            if (!dot) {
                dot = document.createElement('span');
                dot.id = 'nav-top-moments-badge';
                dot.className = 'moments-av-badge hidden';
                navTop.appendChild(dot);
            }
            dot.classList.toggle('hidden', !text);
        }
    }
    function refreshUnread() {
        api('/api/moments/unread').then(function (j) {
            if (j && j.ok) setBadge(j.count || 0);
        }).catch(function () {});
    }
    function markRead() {
        api('/api/moments/unread/read', { method: 'POST' }).then(function () {
            setBadge(0);
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
                html += '<img class="moment-img" src="' + esc(m.images[i]) + '" data-imgi="' + i + '" loading="lazy" alt="">';
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
            if (m && m.images) openImage(img.getAttribute('src'), m.images, +img.getAttribute('data-imgi'));
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
    var pubImages = [];      // 已上传图片 URL（发布归口）
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
            if (pubImages.length >= 9) { showToast(T('最多上传 9 张图片')); return; }
            fileInput.click();
        });
        fileInput.addEventListener('change', function () {
            var files = Array.prototype.slice.call(fileInput.files || []);
            fileInput.value = '';
            files.forEach(function (f) {
                if (pubImages.length >= 9) return;
                uploadMomentImage(f);
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
        // Esc 逐级：可见范围浮层 → 发布页
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (!visPanel.classList.contains('hidden')) { hideVisPanel(); return; }
            if (!pubView.classList.contains('hidden')) { closePublish(); return; }
        });
        if (window._osbInit) window._osbInit(document.getElementById('moments-vis-friend-list'));
    }
    function uploadMomentImage(file) {
        if (!/^image\//.test(file.type)) { showToast(T('朋友圈仅支持图片文件')); return; }
        pubUploading++;
        updateSendState();
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/moment/image?username=' + encodeURIComponent(myUsername), { method: 'POST', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                pubUploading--;
                if (j && j.url) { pubImages.push(j.url); renderPubGrid(); }
                else showToast(T('图片上传失败'));
                updateSendState();
            })
            .catch(function () {
                pubUploading--;
                showToast(T('图片上传失败'));
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
            thumb.innerHTML = '<img src="' + esc(url) + '" alt="">' +
                '<button class="pub-thumb-del" data-i="' + i + '"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>';
            grid.insertBefore(thumb, addBtn);
        });
        grid.querySelectorAll('.pub-thumb-del').forEach(function (btn) {
            btn.addEventListener('click', function () {
                pubImages.splice(+btn.getAttribute('data-i'), 1);
                renderPubGrid();
            });
        });
        addBtn.style.display = pubImages.length >= 9 ? 'none' : '';
    }
    function updateSendState() {
        document.getElementById('moments-pub-send').disabled = pubUploading > 0;
    }
    function publish() {
        var textEl = document.getElementById('moments-pub-text');
        var content = textEl.value.trim();
        if (!content && !pubImages.length) { showToast(T('内容不能为空')); return; }
        if (pubUploading > 0) { showToast(T('图片上传中，请稍候')); return; }
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
