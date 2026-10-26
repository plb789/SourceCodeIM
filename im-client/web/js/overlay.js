// overlay.js - 游戏内 Overlay 悬浮窗渲染层（一期：好友在线列表 / 私聊 / 房间镜像 / 大厅）
//
// 设计文档：docs/游戏内Overlay功能技术设计.md（§4.2 渲染层）
//
// 数据面（全部复用主窗口唯一 WebSocket，本窗无 WS）：
//   上行：GNSignal.send（gn-signal.js → desktop.gnSignalSend → 主进程 → 主窗口 IMSocket.send）
//   下行：信令 9/109/110/112 走 GNSignal（desktop.onGnSignalIn）；私聊 2 / 邀请 111 / 在线增量 93
//         走镜像 desktop.onGnChatIn（主窗口 socket.js gnChatMirror 转发）
//   好友快照：desktop.gnContactsGet（主窗口 IMContacts 归口应答，含 online 在线态）
//
// 职责边界（防脑裂，§4.5）：
//   房间只做镜像渲染 + 轻操作（邀请 111 / 准备 / 退房 / 房内聊天）；创建/加入转交游戏中心窗
//   后台执行（desktop.gameNetOpenLobby silent）；隧道引擎（GameNet）不在此窗运行。
//   服务端私聊回显发送方全连接（server.go L924-926），悬浮窗消息以回显为准（不做乐观渲染）。

(function () {
    'use strict';

    // ===== 常量（与 socket.js MSG 表 / gn-room.js 归口一致） =====
    var MSG_PRIVATE = 2;      // 私聊文本（上行与回显同型）
    var MSG_READ = 13;        // 已读回执
    var MSG_ERR = 9;          // 通用错误帧
    var MSG_ROOM = 109;       // 房间信令
    var MSG_INVITE = 111;     // 联机邀请
    var MSG_LOBBY = 112;      // 大厅（不落库）
    var MSG_USER_DELTA = 93;  // 在线名单增量 {online:[{username,avatar}],offline:[name]}

    var LOBBY_PING = 20000;   // 大厅在场心跳（与 gn-room.js 同周期）

    // ===== 工具 =====
    var desktop = window.desktop || {};
    function $(id) { return document.getElementById(id); }
    // 本端账号：主窗口环境走 IMSocket；悬浮窗无 WS，从 localStorage im_auth 解出（gn-room.js 同款编码）
    function u() {
        if (window.IMSocket && IMSocket.getUsername) return IMSocket.getUsername() || '';
        try { return (JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || {}).u || ''; } catch (e) { return ''; }
    }
    // 翻译归口：I18N 缺失时本地兜底占位符替换（gn-room.js T() 同款）
    function T(s, p) {
        if (window.I18N) return I18N.t(s, p);
        if (!p) return s;
        var out = String(s);
        for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out = out.split('{' + k + '}').join(String(p[k])); }
        return out;
    }
    function hhmm(ts) {
        try {
            var d = new Date((ts || 0) * 1000);
            return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        } catch (e) { return ''; }
    }
    var toastTimer = null;
    function toast(text) {
        var el = $('ov-toast');
        el.textContent = text;
        el.classList.remove('hidden');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2500);
    }
    // 头像：img 失效即隐藏并显示首字母占位（项目统一降级模式）；DOM 构建避免内联转义坑
    function avatarEl(name, avatarUrl) {
        var box = document.createElement('div');
        box.className = 'ov-avatar';
        var ch = (name || '?').charAt(0).toUpperCase();
        if (avatarUrl) {
            var img = document.createElement('img');
            img.src = avatarUrl;
            img.addEventListener('error', function () {
                img.remove();
                box.textContent = ch; // 破图降级：首字母占位（不留破图）
            });
            box.appendChild(img);
        } else {
            box.textContent = ch;
        }
        return box;
    }
    // HTML 转义归口（textContent 不可用处的 innerHTML 兜底；与 gn-room.js esc 同口径）
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // 模板内头像占位填充：data-av="u:<username>"（好友表查头像）| data-av="n:<名称>"（无账号名场景）
    function fillAvatars(root) {
        var slots = root.querySelectorAll('.ov-avatar[data-av]');
        for (var i = 0; i < slots.length; i++) {
            var slot = slots[i];
            var key = slot.getAttribute('data-av') || '';
            var f = key.indexOf('u:') === 0 ? friendOf(key.slice(2)) : null;
            var el = avatarEl(f ? f.name : key.slice(2), f ? f.avatar : '');
            el.removeAttribute('data-av');
            slot.parentNode.replaceChild(el, slot);
        }
    }
    function avatarSlotU(username) { return '<div class="ov-avatar" data-av="u:' + esc(username) + '"></div>'; }
    function avatarSlotN(name) { return '<div class="ov-avatar" data-av="n:' + esc(name) + '"></div>'; }

    // ===== 运行时状态 =====
    var me = u();
    var friends = [];              // [{username,name,avatar,online}]（gnContactsGet 快照 + 93 增量维护）
    var friendIdx = {};            // username → friends 下标
    var unread = {};               // username → 未读数（会话未打开时累计）
    var chatMsgs = {};             // username → [{from,text,ts}]（仅本次呼出后的镜像流，不落库）
    var activeChat = '';           // 当前私聊对象
    var myRoom = null;             // 我的房间镜像：{room_id,name,host,host_port,game_id,game_name,status,members[]}
    var rooms = [];                // 房间列表镜像（list 信封）
    var roomMsgs = [];             // 房内聊天镜像
    var lobbyUsers = [];           // 大厅在场玩家
    var lobbyMsgs = [];            // 大厅聊天（不落库）
    var lobbyActive = false;       // 大厅页签激活中（enter/ping/leave 归口）
    var lobbyTimer = null;
    var invited = {};              // 房间邀请标记 {username:true}（本房间会话内）
    var connected = false;         // 主窗口 WS 连接态（gn:socket-state 镜像）
    var invites = [];              // 收到的邀请卡 [{from,invite}]（未在房时房间列表顶部渲染）

    // ===== 自绘悬浮滚动条（style.css .osb-thumb 同款，game-store.js osbInit 精简版） =====
    function osbInit(el) {
        if (!el || el._osb) return;
        el._osb = true;
        var thumb = document.createElement('div');
        thumb.className = 'osb-thumb';
        thumb._osbHost = el; // osbTick 强制重定位的宿主反查
        document.body.appendChild(thumb);
        function update() {
            var sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop;
            if (sh <= ch + 1 || ch === 0) { thumb.style.display = 'none'; return; }
            var rect = el.getBoundingClientRect();
            if (rect.height === 0) { thumb.style.display = 'none'; return; }
            thumb.style.display = 'block';
            var h = Math.max(30, Math.round(ch * ch / sh));
            if (h > ch - 4) h = Math.max(12, ch - 4);
            var maxTop = ch - h - 2;
            var top = 2 + Math.round(st / Math.max(1, sh - ch) * (maxTop - 2));
            thumb.style.height = h + 'px';
            thumb.style.top = Math.round(rect.top + top) + 'px';
            thumb.style.left = Math.round(rect.right - 8) + 'px';
        }
        el._osbUpdate = update;
        el.addEventListener('scroll', function () {
            if (!el._osbRaf) el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; update(); });
        }, { passive: true });
        if (window.ResizeObserver) new ResizeObserver(function () { update(); }).observe(el);
        thumb.addEventListener('mousedown', function (e) {
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
        });
        update();
    }
    function osbTick() { // 重绘后强制重定位所有滑块
        var thumbs = document.querySelectorAll('.osb-thumb');
        for (var i = 0; i < thumbs.length; i++) {
            var host = thumbs[i]._osbHost || null;
            if (host && host._osbUpdate) host._osbUpdate();
        }
    }

    // ===== 好友快照与在线态 =====
    function loadFriends() {
        if (typeof desktop.gnContactsGet !== 'function') return;
        Promise.resolve(desktop.gnContactsGet()).then(function (list) {
            friends = (list || []).map(function (f) {
                return { username: f.username || '', name: f.name || f.username || '', avatar: f.avatar || '', online: !!f.online };
            });
            rebuildIdx();
            renderFriendList();
        }).catch(function () { friends = []; renderFriendList(); });
    }
    function rebuildIdx() {
        friendIdx = {};
        for (var i = 0; i < friends.length; i++) friendIdx[friends[i].username] = i;
    }
    function friendOf(username) {
        var i = friendIdx[username];
        return i >= 0 ? friends[i] : null;
    }
    function applyUserDelta(d) {
        var changed = false;
        (d.online || []).forEach(function (uu) {
            if (!uu || !uu.username) return;
            var f = friendOf(uu.username);
            if (f && !f.online) { f.online = true; changed = true; }
        });
        (d.offline || []).forEach(function (name) {
            var f = friendOf(name);
            if (f && f.online) { f.online = false; changed = true; }
        });
        if (changed) renderFriendList();
    }

    // ===== 页签切换 =====
    function showTab(name) {
        var tabs = document.querySelectorAll('.ov-tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
        $('ov-friends').classList.toggle('active', name === 'friends');
        $('ov-room').classList.toggle('active', name === 'room');
        $('ov-lobby').classList.toggle('active', name === 'lobby');
        if (name === 'room') {
            requestRoomList();
            queryMyRoom(); // 镜像冷启动补全（建房先于面板加载的场景）
            renderRoom();
        }
        lobbyActiveSet(name === 'lobby');
        osbTick();
    }
    function lobbyActiveSet(on) {
        if (on === lobbyActive) return;
        lobbyActive = on;
        if (on) {
            sendLobby({ action: 'enter' });
            lobbyTimer = setInterval(function () { if (lobbyActive) sendLobby({ action: 'ping' }); }, LOBBY_PING);
        } else {
            if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
            sendLobby({ action: 'leave' });
            lobbyUsers = [];
            lobbyMsgs = [];
            renderLobby();
        }
    }

    // ===== 好友页签渲染 =====
    function renderFriendList() {
        var box = $('ov-friend-list');
        var online = friends.filter(function (f) { return f.online; });
        var offline = friends.filter(function (f) { return !f.online; });
        var rows = online.concat(offline);
        if (!rows.length) {
            box.innerHTML = '<div class="ov-empty">' + T('暂无好友') + '</div>';
            osbTick();
            return;
        }
        var html = '';
        rows.forEach(function (f) {
            var n = unread[f.username] || 0;
            html += '<div class="ov-friend' + (activeChat === f.username ? ' active' : '') + '" data-u="' + esc(f.username) + '">'
                + avatarSlotU(f.username)
                + '<div class="ov-friend-info"><div class="ov-friend-name">' + esc(f.name) + '</div>'
                + '<div class="ov-friend-sub">' + (f.online ? T('在线') : T('离线')) + '</div></div>'
                + '<span class="ov-dot' + (f.online ? ' on' : '') + '"></span>'
                + (n ? '<span class="ov-unread">' + (n > 99 ? '99+' : n) + '</span>' : '')
                + '</div>';
        });
        box.innerHTML = html;
        fillAvatars(box);
        var items = box.querySelectorAll('.ov-friend');
        for (var i = 0; i < items.length; i++) {
            (function (el) {
                el.addEventListener('click', function () { openChat(el.getAttribute('data-u')); });
            })(items[i]);
        }
        osbTick();
    }

    // ===== 私聊 =====
    function openChat(username) {
        // 好友表未命中（通知小窗直达的非好友会话等）兜底：用账号名构造临时条目，消息仍按镜像流渲染
        var f = friendOf(username) || { username: username, name: username, avatar: '', online: false };
        if (!f.username) return;
        activeChat = username;
        $('ov-friend-list').classList.add('hidden'); // 窄面板：进入会话整幅显示（微信手机版同款层级）
        $('ov-chat').classList.remove('hidden');
        $('ov-chat-name').textContent = f.name;
        $('ov-chat-status').textContent = f.online ? T('在线') : T('离线');
        unread[username] = 0;
        renderChat();
        sendRead(username);
    }
    function closeChat() {
        activeChat = '';
        $('ov-chat').classList.add('hidden');
        $('ov-friend-list').classList.remove('hidden');
        renderFriendList();
    }
    function peerOf(msg) {
        return msg.from_user === me ? (msg.to_user || '') : (msg.from_user || '');
    }
    function renderChat() {
        if (!activeChat) return;
        var box = $('ov-chat-msgs');
        var list = chatMsgs[activeChat] || [];
        var html = '';
        list.forEach(function (m) {
            if (m.sys) {
                html += '<div class="ov-msg sys"><div class="ov-msg-text">' + esc(m.text) + '</div></div>';
                return;
            }
            var mine = m.from === me;
            html += '<div class="ov-msg' + (mine ? ' mine' : '') + '">'
                + (mine ? avatarSlotN(T('我')) : avatarSlotU(m.from))
                + '<div class="ov-msg-body"><div class="ov-msg-text">' + esc(m.text) + '</div>'
                + '<div class="ov-msg-time">' + esc(hhmm(m.ts)) + '</div></div></div>';
        });
        if (!list.length) html = '<div class="ov-empty">' + T('暂无消息，发条消息打个招呼吧') + '</div>';
        box.innerHTML = html;
        fillAvatars(box);
        box.scrollTop = box.scrollHeight;
        osbTick();
    }
    // 已读回执：清服务端未读（主窗口徽标联动消除，§五.7）
    function sendRead(username) {
        var list = chatMsgs[username] || [];
        var maxId = 0;
        for (var i = list.length - 1; i >= 0; i--) { if (list[i].msgId > maxId) maxId = list[i].msgId; }
        if (maxId > 0) sendRaw({ msg_type: MSG_READ, to_user: username, content: String(maxId) });
    }
    function sendChatText() {
        var el = $('ov-chat-input');
        var t = el.value.replace(/^\s+|\s+$/g, '');
        if (!t || !activeChat) return;
        if (t.length > 2000) { toast(T('消息过长')); return; }
        if (sendRaw({ msg_type: MSG_PRIVATE, to_user: activeChat, content: t })) {
            el.value = '';
            // 不做乐观渲染：服务端回显（含发送者）到达后统一呈现（防重复消息）
        } else {
            toast(T('发送失败：连接已断开'));
        }
    }

    // ===== 镜像下行（2 私聊 / 111 邀请 / 93 在线增量） =====
    function onChatMirror(msg) {
        if (!msg || !msg.msg_type) return;
        if (msg.msg_type === MSG_PRIVATE) {
            var peer = peerOf(msg);
            if (!peer || peer === me) return;
            var text = String(msg.content || '');
            if (!text) return;
            (chatMsgs[peer] = chatMsgs[peer] || []).push({
                from: msg.from_user || '', text: text,
                ts: msg.timestamp || (Date.now() / 1000), msgId: msg.msg_id || 0
            });
            if (chatMsgs[peer].length > 200) chatMsgs[peer] = chatMsgs[peer].slice(-200);
            if (activeChat === peer) {
                renderChat();
                sendRead(peer); // 会话打开即读：清服务端未读
            } else {
                unread[peer] = (unread[peer] || 0) + 1;
                renderFriendList();
            }
            return;
        }
        if (msg.msg_type === MSG_INVITE) {
            // 邀请卡：content = {invite:{room_id,room_name,host,host_name,host_port,status,count}}（服务端富化）
            var env = null;
            try { env = JSON.parse(msg.content || '{}'); } catch (e) { env = null; }
            if (env && env.invite && env.invite.room_id) {
                invites.push({ from: msg.from_user || '', invite: env.invite });
                if (invites.length > 10) invites = invites.slice(-10);
                toast(T('{n} 邀请你加入房间 {id}', { n: msg.from_user || '', id: env.invite.room_id }));
                renderInvites(); // 邀请条两种状态共享（在房时收到的其他房间邀请也可见可接受）
            }
            return;
        }
        if (msg.msg_type === MSG_USER_DELTA) {
            var d = null;
            try { d = JSON.parse(msg.content || '{}'); } catch (e) { d = {}; }
            applyUserDelta(d);
        }
    }

    // ===== 房间页签（镜像渲染 + 轻操作） =====
    // 房间镜像冷启动补全（§4.5 补强）：面板页后加载，建房/加入时的 109 广播已错过——
    // 向游戏中心窗（房间态唯一持有者）查快照；快照后的状态变化仍走 109 广播实时跟随。
    // 无房回 null（静默保持房间列表视图）；3s 节流防切页签连查
    function queryMyRoom() {
        if (myRoom || typeof desktop.overlayRoomGet !== 'function') return;
        var now = Date.now();
        if (queryMyRoom._at && now - queryMyRoom._at < 3000) return;
        queryMyRoom._at = now;
        Promise.resolve(desktop.overlayRoomGet()).then(function (snap) {
            if (!snap || !snap.room_id || myRoom) return;
            myRoom = normRoomLite(snap);
            renderRoom();
        }).catch(function () { });
    }
    function requestRoomList() {
        if (!connected) return;
        var now = Date.now();
        if (requestRoomList._at && now - requestRoomList._at < 1200) return;
        requestRoomList._at = now;
        send({ action: 'list' });
    }
    function normRoomLite(env) {
        return {
            room_id: env.room_id || '',
            name: env.name || (myRoom && myRoom.room_id === env.room_id && myRoom.name) || '',
            host: env.host || '',
            host_port: env.host_port || 0,
            game_id: env.game_id || 0,
            game_name: env.game_name || '',
            status: env.status || 'waiting',
            members: env.members || []
        };
    }
    function isSelfMember() {
        if (!myRoom) return false;
        for (var i = 0; i < (myRoom.members || []).length; i++) {
            if (myRoom.members[i].username === me) return true;
        }
        return false;
    }
    function onRoomSignal(msg) {
        var env = null;
        try { env = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!env || !env.action) return;
        switch (env.action) {
            case 'created':
            case 'state': {
                // 镜像归口：created 仅房主收；state 成员全收。本端成员身份以信封 members 含自己为准
                // （过滤他人房间广播——109 state 只发房内成员，此处再校验防串房）
                var inRoom = false;
                var members = env.members || [];
                for (var i = 0; i < members.length; i++) { if (members[i].username === me) { inRoom = true; break; } }
                if (!inRoom) break;
                if (myRoom && env.room_id !== myRoom.room_id) break;
                myRoom = normRoomLite(env);
                renderRoom();
                break;
            }
            case 'list': {
                rooms = env.rooms || [];
                renderRoom();
                break;
            }
            case 'chat': {
                if (!myRoom || env.room_id !== myRoom.room_id) break;
                roomMsgs.push({ from: env.from || '', name: env.from_name || env.from || '', text: env.text || '', ts: env.ts || (Date.now() / 1000) });
                if (roomMsgs.length > 200) roomMsgs = roomMsgs.slice(-200);
                renderRoomChat();
                break;
            }
            case 'closed': {
                if (myRoom && env.room_id === myRoom.room_id) {
                    var r = env.reason || '';
                    myRoom = null;
                    roomMsgs = [];
                    invited = {};
                    toast(r === 'kicked' ? T('你已被移出房间') : r === 'host_left' ? T('房主已解散房间') : T('房间已关闭'));
                    renderRoom();
                }
                break;
            }
            default: break;
        }
    }
    function renderRoom() {
        var mine = $('ov-room-mine');
        var none = $('ov-room-none');
        if (myRoom && isSelfMember()) {
            mine.classList.remove('hidden');
            none.classList.add('hidden');
            var statusText = myRoom.status === 'playing' ? T('游戏中') : T('等待中');
            $('ov-room-name').textContent = myRoom.name ? (myRoom.name + '（' + myRoom.room_id + '）') : (T('房间') + ' ' + myRoom.room_id);
            $('ov-room-status').textContent = statusText;
            var parts = [];
            if (myRoom.game_name) parts.push(myRoom.game_name);
            parts.push(T('{n} 人', { n: (myRoom.members || []).length }));
            if (myRoom.host) {
                var hf = friendOf(myRoom.host);
                parts.push(T('房主') + ' ' + ((hf && hf.name) || myRoom.host));
            }
            $('ov-room-line2').textContent = parts.join(' · ');
            // 准备按钮文案随自身就绪态
            var selfReady = false;
            (myRoom.members || []).forEach(function (m) { if (m.username === me) selfReady = !!m.ready; });
            $('ov-room-ready').textContent = selfReady ? T('取消准备') : T('准备');
            renderRoomMembers();
            renderRoomChat();
        } else {
            mine.classList.add('hidden');
            none.classList.remove('hidden');
            renderRoomList();
        }
        renderInvites(); // 邀请条状态跟随（两种视图共享，空则隐藏）
        osbTick();
    }
    function renderRoomMembers() {
        var box = $('ov-room-members');
        var html = '';
        (myRoom.members || []).forEach(function (m) {
            var f = friendOf(m.username);
            var nm = (f && f.name) || m.name || m.username || '';
            html += '<div class="ov-member">'
                + avatarSlotU(m.username)
                + '<div class="ov-member-name">' + esc(nm) + '</div>'
                + (m.host ? '<span class="ov-tag host">' + T('房主') + '</span>' : '')
                + (m.ready ? '<span class="ov-tag ready">' + T('已准备') + '</span>' : '')
                + (m.online === false ? '<span class="ov-tag">' + T('离线') + '</span>' : '')
                + '</div>';
        });
        if (!html) html = '<div class="ov-empty">' + T('暂无成员') + '</div>';
        box.innerHTML = html;
        fillAvatars(box);
    }
    function renderRoomChat() {
        var box = $('ov-room-msgs');
        var html = '';
        roomMsgs.forEach(function (m) {
            var mine = m.from === me;
            html += '<div class="ov-msg' + (mine ? ' mine' : '') + '">'
                + '<div class="ov-msg-body"><div class="ov-msg-text">' + esc((m.name ? m.name + '：' : '') + m.text) + '</div>'
                + '<div class="ov-msg-time">' + esc(hhmm(m.ts)) + '</div></div></div>';
        });
        if (!roomMsgs.length) html = '<div class="ov-empty">' + T('房间内暂无消息') + '</div>';
        box.innerHTML = html;
        box.scrollTop = box.scrollHeight;
    }
    // 邀请条（#ov-invites，两种房间状态共享）：接受并加入 = 转交游戏中心窗后台执行，不抢焦点
    function renderInvites() {
        var box = $('ov-invites');
        if (!invites.length) { box.classList.add('hidden'); box.innerHTML = ''; osbTick(); return; }
        var html = '';
        invites.forEach(function (iv, idx) {
            var inv = iv.invite || {};
            html += '<div class="ov-room-row" data-inv="' + idx + '">'
                + '<div class="ov-room-row-info"><div class="ov-room-row-name">' + T('邀请') + '：' + esc(inv.room_name || (T('房间') + ' ' + inv.room_id)) + '</div>'
                + '<div class="ov-room-row-sub">' + T('房主') + ' ' + esc(inv.host_name || inv.host || '') + ' · ' + (inv.status === 'playing' ? T('游戏中') : T('等待中')) + '</div></div>'
                + '<button class="ov-join-btn">' + T('接受并加入') + '</button></div>';
        });
        box.innerHTML = html;
        var rows = box.querySelectorAll('.ov-room-row');
        for (var i = 0; i < rows.length; i++) {
            (function (el) {
                var btn = el.querySelector('.ov-join-btn');
                if (!btn) return;
                btn.addEventListener('click', function () {
                    var idx = el.getAttribute('data-inv');
                    if (idx === null) return;
                    var inv = (invites[Number(idx)] || {}).invite || {};
                    joinViaGameCenter(inv.room_id);
                });
            })(rows[i]);
        }
        box.classList.remove('hidden');
        osbTick();
    }
    function renderRoomList() {
        var box = $('ov-room-list');
        var html = '';
        rooms.forEach(function (r, idx) {
            var sub = [];
            if (r.game_name) sub.push(r.game_name);
            sub.push((r.count || 0) + '/' + (r.max_players || '?'));
            sub.push(r.status === 'playing' ? T('游戏中') : T('等待中'));
            html += '<div class="ov-room-row" data-room="' + idx + '">'
                + '<div class="ov-room-row-info"><div class="ov-room-row-name">' + esc(r.name || (T('房间') + ' ' + r.room_id)) + '</div>'
                + '<div class="ov-room-row-sub">' + esc(sub.join(' · ')) + '</div></div>'
                + '<button class="ov-join-btn">' + T('加入') + '</button></div>';
        });
        if (!rooms.length) html = '<div class="ov-empty">' + T('暂无房间，可创建一间或等待好友邀请') + '</div>';
        box.innerHTML = html;
        var joins = box.querySelectorAll('.ov-room-row');
        for (var i = 0; i < joins.length; i++) {
            (function (el) {
                var btn = el.querySelector('.ov-join-btn');
                if (!btn) return;
                btn.addEventListener('click', function () {
                    var roomIdx = el.getAttribute('data-room');
                    if (roomIdx === null) return;
                    var r = rooms[Number(roomIdx)] || {};
                    joinViaGameCenter(r.room_id);
                });
            })(joins[i]);
        }
        osbTick();
    }
    // 加入/接受邀请：转交游戏中心窗后台执行（隧道引擎归口，silent 不抢焦点，设计文档 §4.4）
    function joinViaGameCenter(roomId) {
        var id = String(roomId || '').replace(/[^0-9]/g, '');
        if (!id) { toast(T('房间号无效')); return; }
        if (typeof desktop.gameNetOpenLobby !== 'function') { toast(T('当前环境不支持联机')); return; }
        desktop.gameNetOpenLobby({ room_id: id, join: true, silent: true });
        toast(T('已转交游戏中心窗加入房间 {id}', { id: id }));
    }

    // ===== 大厅页签 =====
    function onLobbySignal(msg) {
        var env = null;
        try { env = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!env || !env.action) return;
        if (env.action === 'users') {
            lobbyUsers = env.users || [];
            renderLobby();
        } else if (env.action === 'msg') {
            lobbyMsgs.push({ from: env.from || '', name: env.from_name || env.from || '', text: env.text || '', ts: env.ts || (Date.now() / 1000) });
            if (lobbyMsgs.length > 200) lobbyMsgs = lobbyMsgs.slice(-200);
            renderLobby();
        } else if (env.action === 'sys') {
            lobbyMsgs.push({ sys: true, text: env.text || '' });
            if (lobbyMsgs.length > 200) lobbyMsgs = lobbyMsgs.slice(-200);
            renderLobby();
        } else if (env.action === 'rooms_changed') {
            if ($('ov-room').classList.contains('active')) requestRoomList();
        }
    }
    function renderLobby() {
        var ubox = $('ov-lobby-users');
        var uhtml = '';
        lobbyUsers.forEach(function (uu) {
            var f = friendOf(uu.username || uu);
            var nm = (f && f.name) || (uu.name || uu.username || uu || '');
            uhtml += '<span class="ov-lobby-user">' + esc(nm) + '</span>';
        });
        ubox.innerHTML = uhtml || '<span class="ov-empty" style="padding:0">' + T('大厅暂无其他玩家') + '</span>';
        var mbox = $('ov-lobby-msgs');
        var html = '';
        lobbyMsgs.forEach(function (m) {
            if (m.sys) {
                html += '<div class="ov-msg sys"><div class="ov-msg-text">' + esc(m.text) + '</div></div>';
                return;
            }
            var mine = m.from === me;
            html += '<div class="ov-msg' + (mine ? ' mine' : '') + '">'
                + '<div class="ov-msg-body"><div class="ov-msg-text">' + esc((m.name ? m.name + '：' : '') + m.text) + '</div>'
                + '<div class="ov-msg-time">' + esc(hhmm(m.ts)) + '</div></div></div>';
        });
        if (!lobbyMsgs.length) html = '<div class="ov-empty">' + T('大厅暂无消息') + '</div>';
        mbox.innerHTML = html;
        mbox.scrollTop = mbox.scrollHeight;
        osbTick();
    }
    function sendLobbyText() {
        var el = $('ov-lobby-input');
        var t = el.value.replace(/^\s+|\s+$/g, '');
        if (!t) return;
        if (sendLobby({ action: 'msg', text: t.slice(0, 200) })) { el.value = ''; markBusy(); }
        else toast(T('发送失败：连接已断开'));
    }

    // ===== 邀请好友弹层 =====
    function openInvite() {
        if (!myRoom) return;
        var box = $('ov-invite-list');
        var inRoom = {};
        (myRoom.members || []).forEach(function (m) { inRoom[m.username] = true; });
        var online = friends.filter(function (f) { return f.online && !inRoom[f.username]; });
        var html = '';
        online.forEach(function (f) {
            var done = !!invited[f.username];
            html += '<div class="ov-invite-row" data-u="' + esc(f.username) + '">'
                + avatarSlotU(f.username)
                + '<div class="ov-friend-info"><div class="ov-friend-name">' + esc(f.name) + '</div></div>'
                + '<button class="ov-invite-btn' + (done ? ' off' : '') + '"' + (done ? ' disabled' : '') + '>' + (done ? T('已邀请') : T('邀请')) + '</button></div>';
        });
        if (!online.length) html = '<div class="ov-empty">' + T('暂无在线好友可邀请') + '</div>';
        box.innerHTML = html;
        fillAvatars(box);
        var rows = box.querySelectorAll('.ov-invite-row');
        for (var i = 0; i < rows.length; i++) {
            (function (el) {
                var btn = el.querySelector('.ov-invite-btn');
                if (!btn || btn.disabled) return;
                btn.addEventListener('click', function () {
                    var target = el.getAttribute('data-u');
                    // 111 邀请上行（gn-room.js 同款信封：服务端富化房间态后转卡）
                    if (sendRaw({ msg_type: MSG_INVITE, to_user: target, content: JSON.stringify({ invite: { room_id: myRoom.room_id } }) })) {
                        markBusy(); // 邀请被服务端拒绝时经 9 帧提示（在途门控内）
                        invited[target] = true;
                        btn.textContent = T('已邀请');
                        btn.classList.add('off');
                        btn.disabled = true;
                        toast(T('已邀请'));
                    } else {
                        toast(T('发送失败：连接已断开'));
                    }
                });
            })(rows[i]);
        }
        $('ov-invite-mask').classList.remove('hidden');
        osbTick();
    }
    function closeInvite() { $('ov-invite-mask').classList.add('hidden'); }

    // ===== 收发归口（gn-signal.js：本窗无 WS → desktop.gnSignalSend → 主窗口 IMSocket.send） =====
    var busyUntil = 0;   // 本窗轻操作在途窗口（Date.now()+6s）：9 帧呈现门控（gn-room.js busy 口径同源）
    function markBusy() { busyUntil = Date.now() + 6000; }
    // 房间动作归口：109 信封包装（gn-room.js send() 同款——GNSignal.send 强制要求 msg_type，
    // 裸 action 对象会被静默拒绝：ready/leave/chat/list 必须走此口）
    function send(obj) {
        if (!window.GNSignal) return false;
        return GNSignal.send({ msg_type: MSG_ROOM, content: JSON.stringify(obj) });
    }
    // 直发归口：载荷自带 msg_type（2 私聊 / 13 已读 / 111 邀请），不得再包 109 信封
    function sendRaw(payload) {
        if (!window.GNSignal) return false;
        return GNSignal.send(payload);
    }
    function sendLobby(obj) {
        if (!window.GNSignal) return false;
        return GNSignal.send({ msg_type: MSG_LOBBY, content: JSON.stringify(obj) });
    }
    function onErr(msg) {
        // 9 通用错误帧：仅本窗轻操作（准备/退房/房聊/大厅/邀请）在途期呈现——109 信令广播到所有订阅窗，
        // 游戏中心窗操作触发的服务端拒绝（如"你已加入的房间过多"）也会到达，非本窗在途期不得重复提示
        // （gn-room.js 既有口径：仅本端请求在途时呈现，busy 超时 6s 同源）
        if (Date.now() > busyUntil) return;
        try {
            var t = String(msg.content || '');
            if (t) toast(t);
        } catch (e) { }
    }

    // ===== 关闭面板（焦点归还游戏由主进程 hide 归口） =====
    function hidePanel() {
        lobbyActiveSet(false); // 大厅在场随面板收起退出（防面板隐藏后仍挂 ping）
        if (typeof desktop.overlayHide === 'function') desktop.overlayHide();
    }

    // ===== 初始化 =====
    function boot() {
        me = u();
        // 页签
        var tabs = document.querySelectorAll('.ov-tab');
        for (var i = 0; i < tabs.length; i++) {
            (function (el) {
                el.addEventListener('click', function () { showTab(el.getAttribute('data-tab')); });
            })(tabs[i]);
        }
        // 关闭（×/遮罩/Esc）
        $('ov-close').addEventListener('click', hidePanel);
        $('ov-mask').addEventListener('click', hidePanel);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (!$('ov-invite-mask').classList.contains('hidden')) { closeInvite(); return; }
                if (activeChat) { closeChat(); return; } // 会话层级先退（微信同款），再收面板
                hidePanel();
            }
        });
        $('ov-invite-close').addEventListener('click', closeInvite);
        $('ov-invite-mask').addEventListener('click', function (e) { if (e.target === $('ov-invite-mask')) closeInvite(); });
        // 私聊
        $('ov-chat-back').addEventListener('click', closeChat);
        $('ov-chat-send').addEventListener('click', sendChatText);
        $('ov-chat-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatText(); }
        });
        // 房间
        $('ov-room-invite').addEventListener('click', openInvite);
        $('ov-room-ready').addEventListener('click', function () {
            if (!myRoom) return;
            if (send({ action: 'ready', room_id: myRoom.room_id })) markBusy();
            else toast(T('发送失败：连接已断开'));
        });
        $('ov-room-leave').addEventListener('click', function () {
            if (!myRoom) return;
            if (!send({ action: 'leave', room_id: myRoom.room_id })) { toast(T('发送失败：连接已断开')); return; }
            markBusy();
            myRoom = null;
            roomMsgs = [];
            invited = {};
            toast(T('已退出房间'));
            renderRoom();
        });
        $('ov-room-send').addEventListener('click', function () {
            var el = $('ov-room-input');
            var t = el.value.replace(/^\s+|\s+$/g, '');
            if (!t || !myRoom) return;
            if (send({ action: 'chat', room_id: myRoom.room_id, text: t.slice(0, 200) })) { el.value = ''; markBusy(); }
            else toast(T('发送失败：连接已断开'));
        });
        $('ov-room-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); $('ov-room-send').click(); }
        });
        $('ov-room-create').addEventListener('click', function () {
            // 创建房间需选游戏：唤起游戏中心窗联机大厅页（前台）
            if (typeof desktop.gameNetOpenLobby === 'function') desktop.gameNetOpenLobby({});
            else toast(T('当前环境不支持联机'));
        });
        // 大厅
        $('ov-lobby-send').addEventListener('click', sendLobbyText);
        $('ov-lobby-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); sendLobbyText(); }
        });
        // 自绘悬浮滚动条挂载
        osbInit($('ov-friend-list'));
        osbInit($('ov-chat-msgs'));
        osbInit($('ov-invites'));
        osbInit($('ov-room-members'));
        osbInit($('ov-room-msgs'));
        osbInit($('ov-room-list'));
        osbInit($('ov-lobby-users'));
        osbInit($('ov-lobby-msgs'));
        osbInit($('ov-invite-list'));
        // 数据面订阅
        if (window.GNSignal) {
            GNSignal.on(MSG_ROOM, onRoomSignal);
            GNSignal.on(MSG_LOBBY, onLobbySignal);
            GNSignal.on(MSG_ERR, onErr);
            GNSignal.onState(function (on) {
                connected = !!on;
                $('ov-conn').classList.toggle('hidden', connected);
                if (connected) {
                    requestRoomList();
                    if (lobbyActive) sendLobby({ action: 'enter' }); // 重连后大厅页签开着：补报在场（遗漏 B）
                }
            });
        }
        if (typeof desktop.onGnChatIn === 'function') desktop.onGnChatIn(onChatMirror);
        // 通知小窗点击直达（设计文档 §10.4）：私聊 toast → 好友页签直达会话；邀请 toast → 房间页签（邀请条可见可接受）
        if (typeof desktop.onOverlayOpenChat === 'function') {
            desktop.onOverlayOpenChat(function (payload) {
                showTab('friends');
                openChat((payload && payload.username) || '');
            });
        }
        if (typeof desktop.onOverlayOpenRoom === 'function') {
            desktop.onOverlayOpenRoom(function () { showTab('room'); });
        }
        if (typeof desktop.onGnSocketState === 'function') {
            desktop.onGnSocketState(function (on) {
                connected = !!on;
                $('ov-conn').classList.toggle('hidden', connected);
                if (connected && lobbyActive) sendLobby({ action: 'enter' }); // 重连补报在场
            });
        }
        if (typeof desktop.gnSocketStateGet === 'function') {
            Promise.resolve(desktop.gnSocketStateGet()).then(function (on) {
                connected = !!on;
                $('ov-conn').classList.toggle('hidden', connected);
            }).catch(function () { });
        }
        // 热键显示（主进程下发实际键位）
        if (typeof desktop.overlaySettingsGet === 'function') {
            Promise.resolve(desktop.overlaySettingsGet()).then(function (s) {
                if (s && s.hotkey) $('ov-hotkey').textContent = s.hotkey;
            }).catch(function () { });
        }
        // 主题跟随：主窗口切换主题写 localStorage('im_theme')，storage 事件跨窗触达本窗（遗漏 C——
        // 原 data-theme 仅页面加载时读一次，面板开着时切主题不跟随）
        window.addEventListener('storage', function (e) {
            if (e.key === 'im_theme' && e.newValue) {
                try { document.documentElement.setAttribute('data-theme', e.newValue); } catch (err) { }
            }
        });
        loadFriends();
        renderFriendList();
        renderRoom();
        renderLobby();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
