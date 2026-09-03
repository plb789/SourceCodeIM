// chat.js - 消息收发、好友管理、渲染、主题、头像
(function () {
    var MSG = IMSocket.MSG;
    var currentChatUser = ''; // 空字符串表示群聊
    var friendList = []; // 好友列表 [{username, remark, group, online, avatar}]
    var unreadCount = {}; // username -> 未读数量

    var loginView = document.getElementById('login-view');
    var chatView = document.getElementById('chat-view');
    var loginBtn = document.getElementById('login-btn');
    var loginUsername = document.getElementById('login-username');
    var loginPassword = document.getElementById('login-password');
    var logoutBtn = document.getElementById('logout-btn');
    var themeBtn = document.getElementById('theme-btn');
    var addFriendBtn = document.getElementById('add-friend-btn');
    var currentUserEl = document.getElementById('current-user');
    var currentAvatarEl = document.getElementById('current-avatar');
    var avatarFileEl = document.getElementById('avatar-file');
    var userListEl = document.getElementById('user-list');
    var chatTitle = document.getElementById('chat-title');
    var chatStatus = document.getElementById('chat-status');
    var messageList = document.getElementById('message-list');
    var messageInput = document.getElementById('message-input');
    var sendBtn = document.getElementById('send-btn');
    var friendMenu = document.getElementById('friend-menu');
    var menuTarget = '';

    // ===== 登录 =====
    loginBtn.addEventListener('click', doLogin);
    loginPassword.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
    });
    function doLogin() {
        var username = loginUsername.value.trim();
        var password = loginPassword.value;
        if (!username) { alert('请输入用户名'); return; }
        IMSocket.connect(username, password);
    }

    // ===== 退出 =====
    logoutBtn.addEventListener('click', function () { location.reload(); });

    // ===== 主题切换 =====
    var themes = ['light', 'dark', 'system'];
    var themeNames = { light: '浅色', dark: '深色', system: '跟随系统' };
    function getTheme() { return localStorage.getItem('im_theme') || 'light'; }
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('im_theme', theme);
    }
    applyTheme(getTheme());
    themeBtn.addEventListener('click', function () {
        var idx = themes.indexOf(getTheme());
        var next = themes[(idx + 1) % themes.length];
        applyTheme(next);
        themeBtn.textContent = '主题·' + themeNames[next];
    });
    themeBtn.textContent = '主题·' + themeNames[getTheme()];

    // ===== 头像上传 =====
    currentAvatarEl.addEventListener('click', function () { avatarFileEl.click(); });
    avatarFileEl.addEventListener('change', function () {
        var file = avatarFileEl.files[0];
        if (!file) return;
        var formData = new FormData();
        formData.append('avatar', file);
        fetch('/upload/avatar?username=' + encodeURIComponent(IMSocket.getUsername()), {
            method: 'POST', body: formData
        }).then(function (r) { return r.json(); })
          .then(function (data) {
              if (data.avatar) currentAvatarEl.src = data.avatar;
              else if (data.error) alert(data.error);
          }).catch(function () { alert('头像上传失败'); });
        avatarFileEl.value = '';
    });

    // ===== 添加好友 =====
    addFriendBtn.addEventListener('click', function () {
        var name = prompt('请输入要添加的好友用户名：');
        if (name && name !== IMSocket.getUsername()) {
            IMSocket.send({ msg_type: MSG.FRIEND_REQUEST, to_user: name, content: '请求添加你为好友' });
        }
    });

    // ===== 好友右键菜单 =====
    friendMenu.querySelectorAll('.menu-item').forEach(function (item) {
        item.addEventListener('click', function () {
            var action = this.getAttribute('data-action');
            if (action === 'delete') {
                IMSocket.send({ msg_type: MSG.FRIEND_DELETE, to_user: menuTarget });
            } else if (action === 'block') {
                IMSocket.send({ msg_type: MSG.BLACKLIST, to_user: menuTarget, content: 'block' });
            } else if (action === 'remark') {
                var remark = prompt('设置备注名：');
                if (remark) {
                    IMSocket.send({ msg_type: MSG.FRIEND_UPDATE, to_user: menuTarget, remark: remark });
                }
            }
            friendMenu.classList.add('hidden');
        });
    });
    document.addEventListener('click', function () {
        friendMenu.classList.add('hidden');
    });

    // ===== 发送消息 =====
    function sendMessage() {
        var content = messageInput.value.trim();
        if (!content) return;
        var msg = { msg_type: currentChatUser === '' ? MSG.GROUP_CHAT : MSG.PRIVATE, content: content };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        if (IMSocket.send(msg)) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }
    }
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    messageInput.addEventListener('input', function () {
        if (currentChatUser !== '') {
            IMSocket.send({ msg_type: MSG.TYPING, to_user: currentChatUser });
        }
    });

    // ===== 消息分发 =====
    IMSocket.on(MSG.LOGIN_RESP, function (msg) {
        if (msg.content === 'ok') {
            currentUserEl.textContent = IMSocket.getUsername();
            loginView.classList.add('hidden');
            chatView.classList.remove('hidden');
        } else {
            alert('登录失败：' + msg.content);
        }
    });

    IMSocket.on(MSG.ERROR, function (msg) {
        alert(msg.content);
    });

    // 好友列表同步
    IMSocket.on(MSG.FRIEND_LIST, function (msg) {
        try { friendList = JSON.parse(msg.content) || []; } catch (e) { friendList = []; }
        renderFriendList();
    });

    // 好友申请
    IMSocket.on(MSG.FRIEND_REQUEST, function (msg) {
        var agree = confirm(msg.from_user + ' 请求添加你为好友，是否同意？');
        IMSocket.send({
            msg_type: MSG.FRIEND_REQUEST_RESP,
            to_user: msg.from_user,
            content: agree ? 'agree' : 'reject'
        });
    });

    // 上下线通知：更新好友在线状态
    IMSocket.on(MSG.ONLINE, function (msg) {
        var f = friendList.find(function (x) { return x.username === msg.from_user; });
        if (f) {
            f.online = (msg.content === 'online');
            renderFriendList();
        }
        appendSystem(msg.from_user + (msg.content === 'online' ? ' 上线了' : ' 下线了'));
    });

    // 群聊/私聊消息
    IMSocket.on(MSG.GROUP_CHAT, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id);
    });
    IMSocket.on(MSG.PRIVATE, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        var relevantUser = isMine ? msg.to_user : msg.from_user;
        if (currentChatUser === relevantUser) {
            appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id);
        } else if (!isMine) {
            unreadCount[relevantUser] = (unreadCount[relevantUser] || 0) + 1;
            renderFriendList();
        }
    });

    // 输入状态提示
    IMSocket.on(MSG.TYPING, function (msg) {
        if (msg.from_user === currentChatUser) {
            chatStatus.textContent = '对方正在输入...';
            clearTimeout(window._typingTimer);
            window._typingTimer = setTimeout(updateChatTitle, 2000);
        }
    });

    // ===== 好友列表渲染 =====
    function renderFriendList() {
        var html = '<li class="user-item group-item' + (currentChatUser === '' ? ' active' : '') + '" data-user="">群聊</li>';

        // 在线好友在前，离线在后
        var sorted = friendList.slice().sort(function (a, b) {
            return (b.online ? 1 : 0) - (a.online ? 1 : 0);
        });
        sorted.forEach(function (f) {
            var displayName = f.remark || f.username;
            var avatarHtml = f.avatar
                ? '<img class="avatar" src="' + f.avatar + '" alt="">'
                : '<div class="avatar placeholder"></div>';
            var badge = unreadCount[f.username]
                ? '<span class="unread-badge">' + unreadCount[f.username] + '</span>'
                : '';
            var dot = f.online ? '<span class="online-dot"></span>' : '';
            html += '<li class="user-item' + (currentChatUser === f.username ? ' active' : '') + '" data-user="' + f.username + '">'
                + avatarHtml + '<span class="user-name">' + displayName + '</span>' + dot + badge + '</li>';
        });
        userListEl.innerHTML = html;

        userListEl.querySelectorAll('.user-item').forEach(function (item) {
            item.addEventListener('click', function () {
                currentChatUser = this.getAttribute('data-user');
                if (currentChatUser !== '') unreadCount[currentChatUser] = 0;
                updateChatTitle();
                renderFriendList();
            });
            // 好友右键菜单（群聊不显示）
            if (item.getAttribute('data-user') !== '') {
                item.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    menuTarget = this.getAttribute('data-user');
                    friendMenu.style.top = e.clientY + 'px';
                    friendMenu.style.left = e.clientX + 'px';
                    friendMenu.classList.remove('hidden');
                });
            }
        });
    }

    function updateChatTitle() {
        if (currentChatUser === '') {
            chatTitle.textContent = '群聊';
            chatStatus.textContent = '';
        } else {
            var f = friendList.find(function (x) { return x.username === currentChatUser; });
            chatTitle.textContent = (f && f.remark) ? f.remark + '(' + currentChatUser + ')' : currentChatUser;
            chatStatus.textContent = f && f.online ? '在线' : '离线';
        }
    }

    // ===== 消息渲染 =====
    function appendMessage(fromUser, content, type, msgId) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = fromUser;
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = content;
        div.appendChild(nameEl);
        div.appendChild(bubble);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
    }

    function appendSystem(text) {
        var div = document.createElement('div');
        div.className = 'system-tip';
        div.textContent = text;
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
    }
})();
