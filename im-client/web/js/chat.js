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

    // ===== 输入栏元素（微信风格工具栏） =====
    var emojiBtn = document.getElementById('emoji-btn');
    var imageBtn = document.getElementById('image-btn');
    var fileBtn = document.getElementById('file-btn');
    var screenshotBtn = document.getElementById('screenshot-btn');
    var clearBtn = document.getElementById('clear-btn');
    var emojiPanel = document.getElementById('emoji-panel');
    var imageInput = document.getElementById('image-input');
    var fileInput = document.getElementById('file-input');

    // ===== 自定义弹窗 / Toast 提示（禁止使用系统默认弹窗） =====
    var modalMask = document.getElementById('modal-mask');
    var modalTitle = document.getElementById('modal-title');
    var modalText = document.getElementById('modal-text');
    var modalInput = document.getElementById('modal-input');
    var modalOk = document.getElementById('modal-ok');
    var modalCancel = document.getElementById('modal-cancel');
    var toastEl = document.getElementById('toast');
    var toastTimer = null;
    var modalOkCallback = null; // 当前弹窗确定按钮回调

    // 关闭弹窗
    function closeModal() {
        modalMask.classList.add('hidden');
        modalOkCallback = null;
    }

    // 确认弹窗：title 标题、text 内容、onOk 确定回调、okText 确定按钮文字（默认"确定"）、cancelText 取消按钮文字（默认"取消"）
    function showConfirm(title, text, onOk, okText, cancelText) {
        modalTitle.textContent = title;
        modalText.textContent = text;
        modalText.classList.remove('hidden');
        modalInput.classList.add('hidden');
        modalOk.textContent = okText || '确定';
        modalCancel.textContent = cancelText || '取消';
        modalOkCallback = onOk;
        modalMask.classList.remove('hidden');
    }

    // 输入弹窗：title 标题、placeholder 输入框占位提示、onOk 确定回调（参数为输入值）
    function showPrompt(title, placeholder, onOk) {
        modalTitle.textContent = title;
        modalText.textContent = '';
        modalText.classList.add('hidden');
        modalInput.classList.remove('hidden');
        modalInput.value = '';
        modalInput.placeholder = placeholder || '';
        modalOk.textContent = '确定';
        modalOkCallback = function () {
            var val = modalInput.value.trim();
            if (val) onOk(val);
        };
        modalMask.classList.remove('hidden');
        setTimeout(function () { modalInput.focus(); }, 50);
    }

    modalOk.addEventListener('click', function () {
        var cb = modalOkCallback;
        closeModal();
        if (cb) cb();
    });
    modalCancel.addEventListener('click', closeModal);
    // 点击遮罩不关闭，避免误操作丢失确认；支持回车确认、Esc 取消
    modalInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); modalOk.click(); }
        if (e.key === 'Escape') closeModal();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modalMask.classList.contains('hidden')) closeModal();
    });

    // Toast 轻提示：2.5 秒后自动消失
    function showToast(text) {
        toastEl.textContent = text;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.add('hidden');
        }, 2500);
    }

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
              else if (data.error) showToast(data.error);
          }).catch(function () { showToast('头像上传失败'); });
        avatarFileEl.value = '';
    });

    // ===== 添加好友 =====
    addFriendBtn.addEventListener('click', function () {
        showPrompt('添加好友', '请输入对方用户名', function (name) {
            if (name === IMSocket.getUsername()) {
                showToast('不能添加自己为好友');
                return;
            }
            IMSocket.send({ msg_type: MSG.FRIEND_REQUEST, to_user: name, content: '请求添加你为好友' });
        });
    });

    // ===== 好友右键菜单：备注 / 拉黑 / 删除，均带自定义确认弹窗 =====
    friendMenu.querySelectorAll('.menu-item').forEach(function (item) {
        item.addEventListener('click', function () {
            var action = this.getAttribute('data-action');
            if (action === 'delete') {
                // 删除好友需二次确认，删除后双向解除好友关系
                showConfirm('删除好友', '确定删除好友 "' + menuTarget + '" 吗？删除后需重新添加。', function () {
                    IMSocket.send({ msg_type: MSG.FRIEND_DELETE, to_user: menuTarget });
                }, '删除');
            } else if (action === 'block') {
                // 拉黑需二次确认，拉黑后双向解除好友关系并禁止私聊
                showConfirm('拉黑好友', '确定将 "' + menuTarget + '" 加入黑名单吗？双方将解除好友关系且无法私聊。', function () {
                    IMSocket.send({ msg_type: MSG.BLACKLIST, to_user: menuTarget, content: 'block' });
                }, '拉黑');
            } else if (action === 'remark') {
                showPrompt('设置备注', '请输入好友备注名', function (remark) {
                    IMSocket.send({ msg_type: MSG.FRIEND_UPDATE, to_user: menuTarget, remark: remark });
                });
            }
            friendMenu.classList.add('hidden');
        });
    });
    document.addEventListener('click', function () {
        friendMenu.classList.add('hidden');
    });

    // ===== 消息右键菜单：撤回 / 删除 =====
    var msgMenu = document.getElementById('msg-menu');
    var msgTarget = null; // 当前右键的消息元素

    messageList.addEventListener('contextmenu', function (e) {
        var el = e.target.closest('.message');
        if (!el || !el.getAttribute('data-msg-id')) return;
        e.preventDefault();
        msgTarget = el;
        // 撤回仅对自己发送且 2 分钟内的消息可见
        var isMine = el.getAttribute('data-from') === IMSocket.getUsername();
        var within = Date.now() / 1000 - (parseInt(el.getAttribute('data-ts'), 10) || 0) < 110;
        var recallItem = msgMenu.querySelector('[data-action="recall"]');
        recallItem.style.display = (isMine && within) ? '' : 'none';
        msgMenu.style.top = e.clientY + 'px';
        msgMenu.style.left = e.clientX + 'px';
        msgMenu.classList.remove('hidden');
    });

    msgMenu.querySelectorAll('.menu-item').forEach(function (item) {
        item.addEventListener('click', function () {
            var action = this.getAttribute('data-action');
            if (msgTarget) {
                var msgId = parseInt(msgTarget.getAttribute('data-msg-id'), 10) || 0;
                if (action === 'recall' && msgId) {
                    // 撤回：服务端校验后通知双方，气泡替换为系统提示
                    IMSocket.send({ msg_type: MSG.RECALL, msg_id: msgId });
                } else if (action === 'del' && msgId) {
                    // 删除：仅从自己的聊天窗口移除，云端对对方仍可见
                    var el = msgTarget;
                    showConfirm('删除消息', '确定删除这条消息吗？仅从你的聊天窗口移除。', function () {
                        IMSocket.send({ msg_type: MSG.DELETE, msg_id: msgId });
                        el.remove();
                    }, '删除');
                }
            }
            msgMenu.classList.add('hidden');
            msgTarget = null;
        });
    });
    document.addEventListener('click', function () {
        msgMenu.classList.add('hidden');
    });

    // ===== 发送消息 =====
    function sendMessage() {
        var content = messageInput.value.trim();
        if (!content) return;
        var msg = { msg_type: currentChatUser === '' ? MSG.GROUP_CHAT : MSG.PRIVATE, content: content };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        if (IMSocket.send(msg)) {
            messageInput.value = '';
            messageInput.focus();
        }
    }
    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); sendMessage(); }
        else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); insertAtCursor('\n'); }
    });
    // 在光标处插入文本（表情、换行）
    function insertAtCursor(text) {
        var start = messageInput.selectionStart || 0;
        var end = messageInput.selectionEnd || 0;
        messageInput.value = messageInput.value.slice(0, start) + text + messageInput.value.slice(end);
        messageInput.selectionStart = messageInput.selectionEnd = start + text.length;
        messageInput.focus();
    }
    messageInput.addEventListener('input', function () {
        if (currentChatUser !== '') {
            IMSocket.send({ msg_type: MSG.TYPING, to_user: currentChatUser });
        }
    });

    // ===== 表情面板 =====
    var emojiList = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😎','😭','😡','😳','😅','😴','🥳',
        '👍','👎','👏','🙏','🤝','💪','👌','✌️','🤙','👋','🫶','❤️','💔','💯','🔥','🎉',
        '🌹','🌸','🍀','🌈','☀️','🌙','⭐','🎁','☕','🍚','🍺','🍉','⚽','🚗','✈️','🀄'];
    (function buildEmojiPanel() {
        emojiList.forEach(function (em) {
            var span = document.createElement('span');
            span.className = 'emoji-item';
            span.textContent = em;
            span.addEventListener('click', function () {
                insertAtCursor(em);
            });
            emojiPanel.appendChild(span);
        });
    })();
    emojiBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        emojiPanel.classList.toggle('hidden');
    });
    // 点击其他区域关闭表情面板
    document.addEventListener('click', function (e) {
        if (!emojiPanel.classList.contains('hidden') && !emojiPanel.contains(e.target)) {
            emojiPanel.classList.add('hidden');
        }
    });

    // ===== 图片 / 文件发送（基于分片协议 msg_type=3，仅私聊） =====
    var CHUNK_SIZE = 4 * 1024; // 与开发文档一致：4KB 分片
    var pendingUploads = [];   // 等待服务端回执 file_id 的上传任务队列
    var fileBuffers = {};      // 接收中的文件组装缓冲 file_id -> {name,size,total,chunks,count}

    imageBtn.addEventListener('click', function () {
        if (currentChatUser === '') { showToast('群聊暂不支持发送图片'); return; }
        imageInput.click();
    });
    fileBtn.addEventListener('click', function () {
        if (currentChatUser === '') { showToast('群聊暂不支持发送文件'); return; }
        fileInput.click();
    });
    imageInput.addEventListener('change', function () {
        if (imageInput.files[0]) sendFile(imageInput.files[0]);
        imageInput.value = '';
    });
    fileInput.addEventListener('change', function () {
        if (fileInput.files[0]) sendFile(fileInput.files[0]);
        fileInput.value = '';
    });

    function isImageName(name) {
        return /\.(jpe?g|png|gif|webp|bmp)$/i.test(name);
    }

    function formatSize(bytes) {
        if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'K';
        return bytes + 'B';
    }

    // 发起文件/图片传输：先发文件头（chunk_index=-1），等服务端回执 file_id 后再发分片
    function sendFile(file) {
        var total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        var toUser = currentChatUser;
        // 本地立即渲染（自己发送的消息）
        var url = URL.createObjectURL(file);
        if (isImageName(file.name)) {
            appendImageMsg(IMSocket.getUsername(), url, 'self');
        } else {
            appendFileMsg(IMSocket.getUsername(), file.name, formatSize(file.size), url, 'self');
        }
        pendingUploads.push({ file: file, total: total });
        IMSocket.send({
            msg_type: MSG.FILE, chunk_index: -1, to_user: toUser,
            file_name: file.name, file_size: file.size, total_chunks: total
        });
    }

    // 顺序发送分片：base64 编码后逐片上传
    function sendChunks(file, fileId, toUser, total) {
        var idx = 0;
        function next() {
            if (idx >= total) return;
            var start = idx * CHUNK_SIZE;
            var blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
            var reader = new FileReader();
            reader.onload = function () {
                IMSocket.send({
                    msg_type: MSG.FILE, to_user: toUser, file_id: fileId,
                    chunk_index: idx, total_chunks: total,
                    file_data: reader.result.split(',')[1] // 去掉 data: 前缀，仅保留 base64
                });
                idx++;
                next();
            };
            reader.readAsDataURL(blob);
        }
        next();
    }

    // 文件消息处理：自己收到的是文件头回执（开始上传），对方的是文件头/分片（接收组装）
    IMSocket.on(MSG.FILE, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        if (isMine) {
            // 服务端回执文件头：携带持久化 file_id，开始分片上传
            var task = pendingUploads.shift();
            if (task && msg.chunk_index === -1 && msg.file_id) {
                sendChunks(task.file, msg.file_id, msg.to_user, task.total);
            }
            return;
        }
        if (msg.chunk_index === -1) {
            // 对方发起的文件头：初始化接收缓冲
            fileBuffers[msg.file_id] = {
                name: msg.file_name, size: msg.file_size, total: msg.total_chunks,
                chunks: {}, count: 0, from: msg.from_user
            };
            return;
        }
        // 分片数据：记录进度，集齐后组装渲染
        var buf = fileBuffers[msg.file_id];
        if (!buf) return;
        if (!buf.chunks[msg.chunk_index]) {
            buf.chunks[msg.chunk_index] = msg.file_data;
            buf.count++;
        }
        if (buf.count >= buf.total) {
            var parts = [];
            for (var i = 0; i < buf.total; i++) {
                var b64 = buf.chunks[i];
                var bin = atob(b64);
                var bytes = new Uint8Array(bin.length);
                for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
                parts.push(bytes);
            }
            var blob = new Blob(parts);
            var url = URL.createObjectURL(blob);
            var visibleUser = currentChatUser === msg.from_user;
            if (isImageName(buf.name)) {
                if (visibleUser) appendImageMsg(msg.from_user, url, 'other');
            } else {
                if (visibleUser) appendFileMsg(msg.from_user, buf.name, formatSize(buf.size), url, 'other');
            }
            if (!visibleUser) {
                unreadCount[msg.from_user] = (unreadCount[msg.from_user] || 0) + 1;
                renderFriendList();
            }
            delete fileBuffers[msg.file_id];
        }
    });

    // ===== 截图发送：屏幕捕获 -> 画布截帧 -> 按图片发送 =====
    screenshotBtn.addEventListener('click', function () {
        if (currentChatUser === '') { showToast('群聊暂不支持发送截图'); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            showToast('当前环境不支持截图，请使用 PC 端');
            return;
        }
        navigator.mediaDevices.getDisplayMedia({ video: true }).then(function (stream) {
            var video = document.createElement('video');
            video.srcObject = stream;
            video.onloadedmetadata = function () {
                video.play();
                var canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                stream.getTracks().forEach(function (t) { t.stop(); });
                canvas.toBlob(function (blob) {
                    if (!blob) { showToast('截图失败'); return; }
                    sendFile(new File([blob], '截图_' + Date.now() + '.png', { type: 'image/png' }));
                }, 'image/png');
            };
        }).catch(function () {
            showToast('已取消截图');
        });
    });

    // ===== 清空当前聊天显示（保留云端记录） =====
    clearBtn.addEventListener('click', function () {
        var target = currentChatUser === '' ? '群聊' : currentChatUser;
        showConfirm('清空聊天', '确定清空与 "' + target + '" 的聊天显示吗？（云端记录保留）', function () {
            messageList.innerHTML = '';
        }, '清空');
    });

    // ===== 消息分发 =====
    IMSocket.on(MSG.LOGIN_RESP, function (msg) {
        if (msg.content === 'ok') {
            currentUserEl.textContent = IMSocket.getUsername();
            loginView.classList.add('hidden');
            chatView.classList.remove('hidden');
        } else {
            showToast('登录失败：' + msg.content);
        }
    });

    IMSocket.on(MSG.ERROR, function (msg) {
        showToast(msg.content);
    });

    // 好友列表同步
    IMSocket.on(MSG.FRIEND_LIST, function (msg) {
        try { friendList = JSON.parse(msg.content) || []; } catch (e) { friendList = []; }
        renderFriendList();
    });

    // ===== 黑名单列表同步与渲染 =====
    var blockedList = [];      // 黑名单用户 [{username, avatar}]
    var blacklistExpanded = false; // 黑名单分组展开状态

    IMSocket.on(MSG.BLACKLIST_LIST, function (msg) {
        try { blockedList = JSON.parse(msg.content) || []; } catch (e) { blockedList = []; }
        renderBlacklist();
    });

    // 渲染黑名单分组（位于好友列表下方，可展开/收起）
    function renderBlacklist() {
        var old = document.getElementById('blacklist-group');
        if (old) old.remove();

        var group = document.createElement('li');
        group.id = 'blacklist-group';
        var title = document.createElement('div');
        title.className = 'blacklist-title';
        title.textContent = '黑名单 (' + blockedList.length + ')';
        title.addEventListener('click', function () {
            blacklistExpanded = !blacklistExpanded;
            renderBlacklist();
        });
        group.appendChild(title);

        if (blacklistExpanded) {
            blockedList.forEach(function (b) {
                var item = document.createElement('div');
                item.className = 'blacklist-item';
                var name = document.createElement('span');
                name.className = 'blacklist-name';
                name.textContent = b.username;
                var unblockBtn = document.createElement('span');
                unblockBtn.className = 'unblock-btn';
                unblockBtn.textContent = '移出';
                unblockBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    showConfirm('移出黑名单', '确定将 "' + b.username + '" 移出黑名单吗？移出后可重新添加好友。', function () {
                        IMSocket.send({ msg_type: MSG.BLACKLIST, to_user: b.username, content: 'unblock' });
                    }, '移出');
                });
                item.appendChild(name);
                item.appendChild(unblockBtn);
                group.appendChild(item);
            });
            if (blockedList.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'blacklist-empty';
                empty.textContent = '暂无黑名单用户';
                group.appendChild(empty);
            }
        }
        userListEl.appendChild(group);
    }

    // 好友申请
    var processedRequests = {}; // 已处理的申请 ID，用于去重
    IMSocket.on(MSG.FRIEND_REQUEST, function (msg) {
        // 依据申请记录 ID 去重，避免重复弹窗
        if (msg.msg_id) {
            if (processedRequests[msg.msg_id]) return;
            processedRequests[msg.msg_id] = true;
        }
        // 自定义确认弹窗：同意 / 拒绝
        showConfirm('好友申请', msg.from_user + ' 请求添加你为好友，是否同意？', function () {
            IMSocket.send({
                msg_type: MSG.FRIEND_REQUEST_RESP,
                to_user: msg.from_user,
                content: 'agree'
            });
        }, '同意', '拒绝');
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
        appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id, msg.timestamp, false);
    });
    IMSocket.on(MSG.PRIVATE, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        var relevantUser = isMine ? msg.to_user : msg.from_user;
        if (currentChatUser === relevantUser) {
            appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id, msg.timestamp, true);
            // 正在查看会话时收到对方消息：自动发送已读回执
            if (!isMine && msg.msg_id) {
                IMSocket.send({ msg_type: MSG.READ, to_user: msg.from_user, content: String(msg.msg_id) });
            }
        } else if (!isMine) {
            unreadCount[relevantUser] = (unreadCount[relevantUser] || 0) + 1;
            renderFriendList();
        }
    });

    // ===== 已读回执：更新自己发送消息的已读状态 =====
    IMSocket.on(MSG.READ, function (msg) {
        if (msg.from_user !== currentChatUser) return;
        var lastID = parseInt(msg.content, 10) || 0;
        messageList.querySelectorAll('.msg-status').forEach(function (el) {
            var id = parseInt(el.getAttribute('data-msg-id'), 10) || 0;
            if (id && id <= lastID) {
                el.textContent = '已读';
                el.classList.add('read');
            }
        });
    });

    // ===== 消息撤回：将对应气泡替换为系统提示 =====
    IMSocket.on(MSG.RECALL, function (msg) {
        var tip = msg.from_user === IMSocket.getUsername() ? '你撤回了一条消息' : msg.from_user + ' 撤回了一条消息';
        var el = messageList.querySelector('.message[data-msg-id="' + msg.msg_id + '"]');
        if (el) {
            var tipEl = document.createElement('div');
            tipEl.className = 'system-tip';
            tipEl.textContent = tip;
            el.replaceWith(tipEl);
        } else {
            appendSystem(tip);
        }
    });

    // ===== 历史消息：切换会话时请求，分页加载最近 20 条 =====
    var historyTarget = ''; // 发起历史请求时的会话目标，用于校验响应归属

    function loadHistory() {
        historyTarget = currentChatUser;
        var msg = { msg_type: MSG.HISTORY, page: 1, page_size: 20 };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        IMSocket.send(msg);
    }

    IMSocket.on(MSG.HISTORY_RESP, function (msg) {
        // 响应与会话不匹配（期间用户已切换会话）则忽略
        var target = msg.to_user || '';
        if (target !== historyTarget || target !== currentChatUser) return;

        var records = [];
        try { records = JSON.parse(msg.content) || []; } catch (e) {}
        // 服务端按 ID 倒序返回，正序渲染
        records.reverse().forEach(function (r) { renderHistoryRecord(r); });

        // 加载历史后发送已读回执（对方消息的最大 ID）
        var maxId = 0;
        records.forEach(function (r) {
            if (r.from_user !== IMSocket.getUsername() && r.id > maxId) maxId = r.id;
        });
        if (maxId && currentChatUser !== '') {
            IMSocket.send({ msg_type: MSG.READ, to_user: currentChatUser, content: String(maxId) });
        }
    });

    // 渲染单条历史记录
    function renderHistoryRecord(r) {
        var isMine = r.from_user === IMSocket.getUsername();
        if (r.recalled) {
            appendSystem((isMine ? '你' : r.from_user) + ' 撤回了一条消息');
            return;
        }
        var ts = Math.floor(new Date(r.create_time).getTime() / 1000) || 0;
        // 私聊消息显示已读/未读状态，群聊不显示
        var isPrivate = !!r.to_user;
        appendMessage(r.from_user, r.content, isMine ? 'self' : 'other', r.id, ts, isPrivate, r.is_read);
    }

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
                // 切换会话：清空当前显示并加载历史消息
                messageList.innerHTML = '';
                loadHistory();
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

        // 好友列表重渲染后补渲染黑名单分组
        renderBlacklist();
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
    function appendMessage(fromUser, content, type, msgId, timestamp, showReadStatus, isRead) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        // 携带消息 ID / 发送者 / 时间戳，供撤回、删除、已读功能使用
        if (msgId) div.setAttribute('data-msg-id', msgId);
        div.setAttribute('data-from', fromUser);
        if (timestamp) div.setAttribute('data-ts', timestamp);
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = fromUser;
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = content;
        div.appendChild(nameEl);
        div.appendChild(bubble);
        // 自己发送的私聊消息显示已读/未读状态
        if (showReadStatus && type === 'self' && msgId) {
            var status = document.createElement('div');
            status.className = 'msg-status' + (isRead ? ' read' : '');
            status.setAttribute('data-msg-id', msgId);
            status.textContent = isRead ? '已读' : '未读';
            div.appendChild(status);
        }
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

    // 图片消息渲染
    function appendImageMsg(fromUser, url, type) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = fromUser;
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble bubble-image';
        var img = document.createElement('img');
        img.className = 'chat-image';
        img.src = url;
        img.addEventListener('click', function () {
            window.open(url, '_blank'); // 点击查看大图
        });
        bubble.appendChild(img);
        div.appendChild(nameEl);
        div.appendChild(bubble);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
    }

    // 文件消息渲染（文件卡片：图标 + 文件名 + 大小，点击下载）
    function appendFileMsg(fromUser, name, sizeText, url, type) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = fromUser;
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble bubble-file';
        var icon = document.createElement('div');
        icon.className = 'file-icon';
        icon.textContent = '📄';
        var info = document.createElement('div');
        info.className = 'file-info';
        var fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = name;
        var fileSize = document.createElement('div');
        fileSize.className = 'file-size';
        fileSize.textContent = sizeText;
        info.appendChild(fileName);
        info.appendChild(fileSize);
        bubble.appendChild(icon);
        bubble.appendChild(info);
        if (url) {
            bubble.style.cursor = 'pointer';
            bubble.addEventListener('click', function () {
                var a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
            });
        }
        div.appendChild(nameEl);
        div.appendChild(bubble);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
    }
})();
