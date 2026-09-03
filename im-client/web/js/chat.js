// chat.js - 消息收发、渲染、用户列表管理、头像上传
(function () {
    var MSG = IMSocket.MSG;
    var currentChatUser = ''; // 空字符串表示群聊
    var onlineUsers = []; // [{username, avatar}]
    var unreadCount = {}; // username -> 未读数量

    var loginView = document.getElementById('login-view');
    var chatView = document.getElementById('chat-view');
    var loginBtn = document.getElementById('login-btn');
    var loginUsername = document.getElementById('login-username');
    var loginPassword = document.getElementById('login-password');
    var logoutBtn = document.getElementById('logout-btn');
    var themeBtn = document.getElementById('theme-btn');
    var currentUserEl = document.getElementById('current-user');
    var currentAvatarEl = document.getElementById('current-avatar');
    var avatarFileEl = document.getElementById('avatar-file');
    var userListEl = document.getElementById('user-list');
    var chatTitle = document.getElementById('chat-title');
    var chatStatus = document.getElementById('chat-status');
    var messageList = document.getElementById('message-list');
    var messageInput = document.getElementById('message-input');
    var sendBtn = document.getElementById('send-btn');

    // 登录
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

    // 退出
    logoutBtn.addEventListener('click', function () {
        location.reload();
    });

    // 主题切换（浅色 -> 深色 -> 跟随系统 循环）
    var themes = ['light', 'dark', 'system'];
    var themeNames = { light: '浅色', dark: '深色', system: '跟随系统' };

    function getTheme() {
        return localStorage.getItem('im_theme') || 'light';
    }
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('im_theme', theme);
    }

    // 初始化主题
    applyTheme(getTheme());

    themeBtn.addEventListener('click', function () {
        var current = getTheme();
        var idx = themes.indexOf(current);
        var next = themes[(idx + 1) % themes.length];
        applyTheme(next);
        themeBtn.textContent = '主题·' + themeNames[next];
    });
    themeBtn.textContent = '主题·' + themeNames[getTheme()];

    // 头像上传入口
    currentAvatarEl.addEventListener('click', function () {
        avatarFileEl.click();
    });
    avatarFileEl.addEventListener('change', function () {
        var file = avatarFileEl.files[0];
        if (!file) return;
        var formData = new FormData();
        formData.append('avatar', file);
        fetch('/upload/avatar?username=' + encodeURIComponent(IMSocket.getUsername()), {
            method: 'POST',
            body: formData
        }).then(function (r) { return r.json(); })
          .then(function (data) {
              if (data.avatar) {
                  currentAvatarEl.src = data.avatar;
              } else if (data.error) {
                  alert(data.error);
              }
          }).catch(function () {
              alert('头像上传失败');
          });
        avatarFileEl.value = '';
    });

    // 发送消息
    function sendMessage() {
        var content = messageInput.value.trim();
        if (!content) return;
        var msg = {
            msg_type: currentChatUser === '' ? MSG.GROUP_CHAT : MSG.PRIVATE,
            content: content
        };
        if (currentChatUser !== '') {
            msg.to_user = currentChatUser;
        }
        if (IMSocket.send(msg)) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    // 私聊输入时发送"正在输入"状态
    messageInput.addEventListener('input', function () {
        if (currentChatUser !== '') {
            IMSocket.send({ msg_type: MSG.TYPING, to_user: currentChatUser });
        }
    });

    // 消息分发处理
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

    // 用户列表同步（JSON 数组：username + avatar）
    IMSocket.on(MSG.USER_LIST, function (msg) {
        var users = [];
        try {
            users = JSON.parse(msg.content) || [];
        } catch (e) {
            users = [];
        }
        onlineUsers = users;
        // 更新自己的头像
        var me = users.find(function (u) { return u.username === IMSocket.getUsername(); });
        if (me && me.avatar) {
            currentAvatarEl.src = me.avatar;
        }
        renderUserList();
    });

    // 上下线通知
    IMSocket.on(MSG.ONLINE, function (msg) {
        if (msg.content === 'online') {
            if (!onlineUsers.find(function (u) { return u.username === msg.from_user; })) {
                onlineUsers.push({ username: msg.from_user, avatar: '' });
            }
            appendSystem(msg.from_user + ' 上线了');
        } else {
            onlineUsers = onlineUsers.filter(function (u) { return u.username !== msg.from_user; });
            appendSystem(msg.from_user + ' 下线了');
        }
        renderUserList();
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
            // 非当前会话的私聊消息，未读计数 +1
            unreadCount[relevantUser] = (unreadCount[relevantUser] || 0) + 1;
            renderUserList();
        }
    });

    // 输入状态提示
    IMSocket.on(MSG.TYPING, function (msg) {
        if (msg.from_user === currentChatUser) {
            chatStatus.textContent = '对方正在输入...';
            clearTimeout(window._typingTimer);
            window._typingTimer = setTimeout(function () {
                updateChatTitle();
            }, 2000);
        }
    });

    // 渲染用户列表
    function renderUserList() {
        var html = '<li class="user-item group-item' + (currentChatUser === '' ? ' active' : '') + '" data-user="">群聊</li>';
        onlineUsers.forEach(function (u) {
            if (u.username === IMSocket.getUsername()) return; // 不显示自己
            var avatarHtml = u.avatar
                ? '<img class="avatar" src="' + u.avatar + '" alt="">'
                : '<div class="avatar placeholder"></div>';
            var badge = unreadCount[u.username]
                ? '<span class="unread-badge">' + unreadCount[u.username] + '</span>'
                : '';
            html += '<li class="user-item' + (currentChatUser === u.username ? ' active' : '') + '" data-user="' + u.username + '">'
                + avatarHtml + '<span class="user-name">' + u.username + '</span>' + badge + '</li>';
        });
        userListEl.innerHTML = html;

        userListEl.querySelectorAll('.user-item').forEach(function (item) {
            item.addEventListener('click', function () {
                currentChatUser = this.getAttribute('data-user');
                if (currentChatUser !== '') {
                    unreadCount[currentChatUser] = 0; // 点击会话清零未读
                }
                updateChatTitle();
                renderUserList();
            });
        });
    }

    function updateChatTitle() {
        if (currentChatUser === '') {
            chatTitle.textContent = '群聊';
            chatStatus.textContent = '';
        } else {
            chatTitle.textContent = currentChatUser;
            chatStatus.textContent = onlineUsers.find(function (u) { return u.username === currentChatUser; }) ? '在线' : '离线';
        }
    }

    // 追加消息气泡
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

    // 系统提示
    function appendSystem(text) {
        var div = document.createElement('div');
        div.className = 'system-tip';
        div.textContent = text;
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
    }
})();
