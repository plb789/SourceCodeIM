// chat.js - 消息收发、好友管理、渲染、主题、头像
(function () {
    var MSG = IMSocket.MSG;
    var currentChatUser = ''; // 空字符串表示群聊
    var friendList = []; // 好友列表 [{username, remark, group, online, avatar}]
    // 原实现：var unreadCount = {}; 本地未读计数，与服务端 cv.unread 双源不一致，多端已读后角标不同步
    // 阶段十一：未读数服务端归口，统一使用服务端 CONV_LIST 推送的 unread 渲染，删除本地 unreadCount
    var readWatermark = {}; // 对方用户名 -> 已读水位（对方已读到的我方最大消息 ID），跨会话保留供历史渲染即时应用
    var convList = []; // 最近会话列表 [{target, last_msg, last_time, unread, pinned}]（服务端归口）

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
    var convListEl = document.getElementById('conv-list');
    var friendsPanel = document.getElementById('friends-panel');

    // ===== 置顶消息条元素（服务端归口，双方同步） =====
    var pinBar = document.getElementById('pin-bar');
    var pinBarUser = document.getElementById('pin-bar-user');
    var pinBarText = document.getElementById('pin-bar-text');
    var pinBarClose = document.getElementById('pin-bar-close');

    // ===== 会话内搜索元素 =====
    var convSearchBtn = document.getElementById('conv-search-btn');
    var convSearch = document.getElementById('conv-search');
    var convSearchInput = document.getElementById('conv-search-input');
    var convSearchClose = document.getElementById('conv-search-close');
    var convSearchResults = document.getElementById('conv-search-results');

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
        var msgId = parseInt(el.getAttribute('data-msg-id'), 10) || 0;
        // 撤回仅对自己发送且窗口时间内的消息可见（窗口值由登录响应从服务端下发，预留 10 秒余量防边界超时）
        // 原实现：固定 110 秒硬编码
        // var within = Date.now() / 1000 - (parseInt(el.getAttribute('data-ts'), 10) || 0) < 110;
        var win = (IMSocket.getRecallWindow ? IMSocket.getRecallWindow() : 120) - 10;
        var isMine = el.getAttribute('data-from') === IMSocket.getUsername();
        var within = Date.now() / 1000 - (parseInt(el.getAttribute('data-ts'), 10) || 0) < win;
        var recallItem = msgMenu.querySelector('[data-action="recall"]');
        recallItem.style.display = (isMine && within) ? '' : 'none';
        // 置顶项：当前消息已被置顶时显示"取消置顶"
        var pinItem = msgMenu.querySelector('[data-action="pin"]');
        var p = pinInfo[currentChatUser];
        pinItem.textContent = (p && p.msg_id && p.msg_id === msgId) ? '取消置顶' : '置顶';
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
                } else if (action === 'pin' && msgId) {
                    // 置顶/取消置顶：服务端归口并同步双方，每个会话仅一条置顶
                    var p = pinInfo[currentChatUser];
                    var isPinned = !!(p && p.msg_id === msgId);
                    IMSocket.send({
                        msg_type: MSG.MSG_PIN,
                        to_user: currentChatUser,
                        msg_id: msgId,
                        content: isPinned ? 'unpin' : 'pin'
                    });
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
                // 原实现：unreadCount[msg.from_user] = (unreadCount[msg.from_user] || 0) + 1; renderFriendList();
                // 未读数服务端归口：文件消息不入 im_message 表，服务端未读统计不覆盖文件消息，
                // 此处仅在本地会话列表乐观 +1（好友角标同源渲染），服务端 CONV_LIST 推送到达时以服务端数据归口覆盖
                var fconv = null;
                for (var fi = 0; fi < convList.length; fi++) {
                    if (convList[fi].target === msg.from_user) { fconv = convList[fi]; break; }
                }
                if (fconv) {
                    fconv.unread = (fconv.unread || 0) + 1;
                    renderConvList();
                    renderFriendList();
                }
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
        // 原实现：仅支持纯字符串 "ok"，服务端下发撤回窗口参数后 content 改为 JSON，导致登录被误判为失败
        // if (msg.content === 'ok') {
        var ok = msg.content === 'ok'; // 兼容旧版服务端纯字符串响应
        if (!ok) {
            // 新格式：content 为 JSON（result + recall_window 等服务端配置参数）
            try { ok = JSON.parse(msg.content).result === 'ok'; } catch (e) {}
        }
        if (ok) {
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

    // ===== 侧栏 Tab 切换：聊天（会话列表）/ 好友 =====
    document.querySelectorAll('.sidebar-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.sidebar-tab').forEach(function (t) { t.classList.remove('active'); });
            this.classList.add('active');
            var isChat = this.getAttribute('data-tab') === 'chat';
            convListEl.classList.toggle('hidden', !isChat);
            friendsPanel.classList.toggle('hidden', isChat);
        });
    });

    // ===== 最近会话列表（服务端归口：最后消息/未读数/置顶） =====
    // 原实现：var convList = []; 声明于此，阶段十一提前至文件顶部（好友列表角标同源读取服务端未读数）
    var convTarget = ''; // 当前右键的会话目标

    IMSocket.on(MSG.CONV_LIST, function (msg) {
        try { convList = JSON.parse(msg.content) || []; } catch (e) { convList = []; }
        renderConvList();
        // 原实现：仅渲染会话列表，好友列表角标依赖本地 unreadCount，多端已读后不同步
        // 未读数服务端归口：好友列表角标与 会话列表角标 同源渲染服务端未读数
        renderFriendList();
    });

    function renderConvList() {
        convListEl.innerHTML = '';
        if (convList.length === 0) {
            var empty = document.createElement('li');
            empty.className = 'conv-empty';
            empty.textContent = '暂无会话，去好友页添加好友开始聊天吧';
            convListEl.appendChild(empty);
            return;
        }
        convList.forEach(function (cv) {
            var isGroup = cv.target === '';
            var convName = isGroup ? '群聊' : cv.target;
            var li = document.createElement('li');
            li.className = 'conv-item' + (cv.pinned ? ' pinned' : '');
            if (currentChatUser === cv.target) li.classList.add('active');
            li.setAttribute('data-user', cv.target);

            var avatar = document.createElement('div');
            avatar.className = 'conv-avatar';
            avatar.textContent = convName.charAt(0).toUpperCase();

            var main = document.createElement('div');
            main.className = 'conv-main';
            var headRow = document.createElement('div');
            headRow.className = 'conv-head';
            var nameEl = document.createElement('span');
            nameEl.className = 'conv-name';
            nameEl.textContent = convName;
            var timeEl = document.createElement('span');
            timeEl.className = 'conv-time';
            timeEl.textContent = formatTime(cv.last_time * 1000);
            headRow.appendChild(nameEl);
            headRow.appendChild(timeEl);
            var msgRow = document.createElement('div');
            msgRow.className = 'conv-msg';
            msgRow.textContent = cv.last_msg;
            main.appendChild(headRow);
            main.appendChild(msgRow);

            var badge = document.createElement('span');
            badge.className = 'conv-badge' + (cv.unread > 0 ? '' : ' hidden');
            badge.textContent = cv.unread > 99 ? '99+' : cv.unread;

            var pinMark = document.createElement('span');
            pinMark.className = 'conv-pin-mark' + (cv.pinned ? '' : ' hidden');
            pinMark.textContent = '📌';

            li.appendChild(avatar);
            li.appendChild(main);
            li.appendChild(pinMark);
            li.appendChild(badge);

            li.addEventListener('click', function () {
                openConversation(cv.target);
            });
            // 会话右键菜单：置顶/取消置顶
            li.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                convTarget = cv.target;
                var pinItem = convMenu.querySelector('[data-action="pin"]');
                pinItem.textContent = cv.pinned ? '取消置顶' : '置顶聊天';
                convMenu.style.top = e.clientY + 'px';
                convMenu.style.left = e.clientX + 'px';
                convMenu.classList.remove('hidden');
            });
            convListEl.appendChild(li);
        });
    }

    // 会话右键菜单：置顶/清空/删除
    var convMenu = document.getElementById('conv-menu');
    convMenu.querySelector('[data-action="pin"]').addEventListener('click', function () {
        var pin = this.textContent === '置顶聊天';
        IMSocket.send({
            msg_type: MSG.CONV_PIN,
            to_user: convTarget,
            content: pin ? 'pin' : 'unpin'
        });
        convMenu.classList.add('hidden');
    });
    // 清空聊天记录：服务端将消息标记为当前用户已删除（云端记录保留），本地同步清空当前视图
    convMenu.querySelector('[data-action="clear"]').addEventListener('click', function () {
        convMenu.classList.add('hidden');
        var name = convTarget === '' ? '群聊' : convTarget;
        showConfirm('清空聊天记录', '确定清空与 ' + name + ' 的全部聊天记录吗？', function () {
            IMSocket.send({ msg_type: MSG.CONV_CLEAR, to_user: convTarget });
            // 当前正在查看该会话时，同步清空聊天窗口显示
            if (convTarget === currentChatUser) {
                messageList.innerHTML = '';
                appendSystem('聊天记录已清空');
            }
        });
    });
    // 删除会话：从列表移除（云端记录保留），若正在查看则切回群聊
    convMenu.querySelector('[data-action="delete"]').addEventListener('click', function () {
        convMenu.classList.add('hidden');
        var name = convTarget === '' ? '群聊' : convTarget;
        showConfirm('删除会话', '确定删除与 ' + name + ' 的会话吗？聊天记录将保留在云端。', function () {
            var isCurrent = convTarget === currentChatUser;
            IMSocket.send({ msg_type: MSG.CONV_DELETE, to_user: convTarget });
            // 正在查看被删除的会话时，切回群聊
            if (isCurrent) {
                openConversation('');
            }
        });
    });
    document.addEventListener('click', function () {
        convMenu.classList.add('hidden');
    });

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
            // 正在查看会话时收到对方消息：自动发送已读回执（客户端水位去重）
            if (!isMine && msg.msg_id) {
                // 原实现：IMSocket.send({ msg_type: MSG.READ, to_user: msg.from_user, content: String(msg.msg_id) });
                sendReadReceipt(msg.from_user, msg.msg_id);
            }
        }
        // 原实现：else if (!isMine) { unreadCount[relevantUser] = (unreadCount[relevantUser] || 0) + 1; renderFriendList(); }
        // 未读数服务端归口：服务端收到私聊会 notifyConvUpdate 推送 CONV_LIST（含未读数）到本端全部连接，
        // 前端 CONV_LIST 处理中统一渲染会话列表与好友列表角标，本地不再自计数
    });

    // ===== 已读回执：更新自己发送消息的已读状态 =====
    var sentReadId = {}; // 已发送的已读回执水位：目标用户 -> 已发送的最大消息 ID（客户端去重，服务端仍有会话行水位兜底）

    // 发送已读回执：仅水位前进才发送，避免多端/重复打开会话产生回执风暴
    function sendReadReceipt(target, maxId) {
        maxId = parseInt(maxId, 10) || 0;
        if (!target || !maxId) return;
        // 原实现：每次直接 IMSocket.send 回执，无客户端水位去重
        if (maxId <= (sentReadId[target] || 0)) return;
        sentReadId[target] = maxId;
        IMSocket.send({ msg_type: MSG.READ, to_user: target, content: String(maxId) });
    }

    // 原实现：仅当回执来自当前会话才处理，未打开会话时收到的回执被丢弃，
    // 重新打开会话需等服务端 is_read 才能显示已读；现始终记录水位，供历史渲染即时应用
    IMSocket.on(MSG.READ, function (msg) {
        var lastID = parseInt(msg.content, 10) || 0;
        if (!lastID) return;
        // 记录对方已读水位（任一连接收到的回执都记录，跨会话保留）
        if (lastID > (readWatermark[msg.from_user] || 0)) {
            readWatermark[msg.from_user] = lastID;
        }
        if (msg.from_user !== currentChatUser) return;
        messageList.querySelectorAll('.msg-status').forEach(function (el) {
            var id = parseInt(el.getAttribute('data-msg-id'), 10) || 0;
            if (id && id <= lastID) {
                el.textContent = '已读';
                el.classList.add('read');
            }
        });
    });

    // ===== 消息撤回：将对应气泡替换为系统提示 =====
    // 阶段十二增强：撤回通知携带原始消息接收方 to_user（群聊为空），
    // 前端先做会话归属校验再渲染，杜绝跨会话串窗（撤回提示误渲染进当前打开的无关会话）；
    // 并按 msg_id 去重，防服务端重复通知导致追加重复系统提示
    var processedRecalls = {}; // 已处理的撤回通知：msg_id -> true（服务端已做撤回幂等，此处前端兜底去重）

    IMSocket.on(MSG.RECALL, function (msg) {
        // 原实现：无去重、无归属校验，重复通知会追加重复提示，跨会话撤回提示会串入当前窗口
        if (msg.msg_id && processedRecalls[msg.msg_id]) return;
        if (msg.msg_id) processedRecalls[msg.msg_id] = true;

        // 会话归属校验：私聊撤回归属对端会话（自己撤回则为接收方，否则为发送方），群聊撤回归属群聊（to_user 为空）
        var owner = '';
        if (msg.to_user) {
            owner = (msg.from_user === IMSocket.getUsername()) ? msg.to_user : msg.from_user;
        }
        if (owner !== currentChatUser) return; // 非当前查看会话的撤回：仅服务端落库与 CONV_LIST 同步，本地不渲染
        var tip = msg.from_user === IMSocket.getUsername() ? '你撤回了一条消息' : msg.from_user + ' 撤回了一条消息';
        var el = messageList.querySelector('.message[data-msg-id="' + msg.msg_id + '"]');
        if (el) {
            var tipEl = document.createElement('div');
            tipEl.className = 'system-tip';
            tipEl.textContent = tip;
            el.replaceWith(tipEl);
        } else {
            // 归属当前会话但元素不在窗口（消息超出已加载历史等）：保留原兜底提示
            appendSystem(tip);
        }
    });

    // ===== 历史消息：切换会话时请求，分页加载最近 20 条 =====
    var historyTarget = ''; // 发起历史请求时的会话目标，用于校验响应归属
    var pinInfo = {};       // 置顶消息表：target -> {msg_id, from_user, content, create_time, pin_user}
    var locateState = { active: false, msgId: 0, page: 1, maxPage: 50 }; // 会话内搜索定位翻页状态

    // 切换会话：设置目标、清空显示、加载历史
    function openConversation(user) {
        currentChatUser = user;
        // 原实现：if (currentChatUser !== '') unreadCount[currentChatUser] = 0; 本地计数清零
        // 未读数服务端归口：本地乐观清零会话列表未读角标，服务端处理已读回执后推送 CONV_LIST 归口确认
        if (currentChatUser !== '') {
            var conv = null;
            for (var ci = 0; ci < convList.length; ci++) {
                if (convList[ci].target === currentChatUser) { conv = convList[ci]; break; }
            }
            if (conv && conv.unread > 0) {
                conv.unread = 0;
                renderConvList();
                renderFriendList();
            }
        }
        updateChatTitle();
        renderFriendList();
        // 切换会话：重置定位状态、关闭搜索浮层、刷新置顶条
        locateState.active = false;
        closeConvSearch();
        messageList.innerHTML = '';
        renderPinBar();
        loadHistory();
    }

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

        // 定位模式：向前翻页加载更早的消息（prepend 渲染），找到目标后高亮
        if (locateState.active) {
            handleLocatePage(records);
            return;
        }

        // 服务端按 ID 倒序返回，正序渲染
        records.reverse().forEach(function (r) { renderHistoryRecord(r); });

        // 加载历史后发送已读回执（对方消息的最大 ID，客户端水位去重）
        var maxId = 0;
        records.forEach(function (r) {
            if (r.from_user !== IMSocket.getUsername() && r.id > maxId) maxId = r.id;
        });
        if (maxId && currentChatUser !== '') {
            // 原实现：IMSocket.send({ msg_type: MSG.READ, to_user: currentChatUser, content: String(maxId) });
            sendReadReceipt(currentChatUser, maxId);
        }
    });

    // 渲染单条历史记录（beforeEl 传入时插入到该元素之前，用于向前翻页 prepend）
    function renderHistoryRecord(r, beforeEl) {
        var isMine = r.from_user === IMSocket.getUsername();
        if (r.recalled) {
            var tip = document.createElement('div');
            tip.className = 'system-tip';
            tip.textContent = (isMine ? '你' : r.from_user) + ' 撤回了一条消息';
            if (beforeEl) {
                messageList.insertBefore(tip, beforeEl);
            } else {
                messageList.appendChild(tip);
                messageList.scrollTop = messageList.scrollHeight;
            }
            return;
        }
        var ts = Math.floor(new Date(r.create_time).getTime() / 1000) || 0;
        // 私聊消息显示已读/未读状态，群聊不显示
        var isPrivate = !!r.to_user;
        // 原实现：仅按服务端 is_read 渲染；对方已读回执可能先于会话打开到达（当时未在会话内被丢弃），
        // 现叠加本地已读水位即时应用：自己发送的私聊消息若已被读到更大 ID 则直接显示"已读"
        var wm = (isMine && isPrivate) ? (readWatermark[r.to_user] || 0) : 0;
        var isRead = r.is_read || (wm >= r.id);
        var div = createMessageEl(r.from_user, r.content, isMine ? 'self' : 'other', r.id, ts, isPrivate, isRead);
        if (beforeEl) {
            messageList.insertBefore(div, beforeEl);
        } else {
            messageList.appendChild(div);
            messageList.scrollTop = messageList.scrollHeight;
        }
    }

    // ===== 会话内搜索定位：向前翻页加载直到找到目标消息 =====
    function handleLocatePage(records) {
        if (!locateState.active) return;
        // 无更多历史仍未找到：停止定位
        if (!records.length) {
            locateState.active = false;
            showToast('未找到该消息');
            return;
        }
        // prepend 渲染：按返回顺序（新→旧）依次插入到当前最前，保持时间正序
        records.forEach(function (r) {
            renderHistoryRecord(r, messageList.firstChild);
        });
        // 已加载出目标消息则定位高亮
        var el = messageList.querySelector('.message[data-msg-id="' + locateState.msgId + '"]');
        if (el) {
            locateState.active = false;
            highlightMessage(el);
            return;
        }
        loadNextLocatePage();
    }

    function loadNextLocatePage() {
        locateState.page++;
        if (locateState.page > locateState.maxPage) {
            locateState.active = false;
            showToast('未找到该消息（超出可加载范围）');
            return;
        }
        var msg = { msg_type: MSG.HISTORY, page: locateState.page, page_size: 20 };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        IMSocket.send(msg);
    }

    // 定位高亮：滚动到消息位置并渐隐高亮 2 秒
    function highlightMessage(el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.remove('msg-highlight');
        // 强制重启动画
        void el.offsetWidth;
        el.classList.add('msg-highlight');
        setTimeout(function () { el.classList.remove('msg-highlight'); }, 2000);
    }

    // ===== 会话内搜索浮层：搜索当前会话消息，点击结果定位并高亮 =====
    var convSearching = ''; // 发起搜索时的会话目标，用于校验响应归属

    convSearchBtn.addEventListener('click', function () {
        // 再次点击可关闭浮层
        if (!convSearch.classList.contains('hidden')) {
            closeConvSearch();
            return;
        }
        convSearch.classList.remove('hidden');
        convSearchInput.focus();
    });

    // 关闭搜索浮层：清空输入与结果，避免切换会话后残留上一次内容
    function closeConvSearch() {
        convSearch.classList.add('hidden');
        convSearchResults.classList.add('hidden');
        convSearchResults.innerHTML = '';
        convSearchInput.value = '';
    }

    convSearchClose.addEventListener('click', closeConvSearch);

    // Esc 快捷关闭搜索浮层
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !convSearch.classList.contains('hidden')) closeConvSearch();
    });

    // 回车发起搜索：携带当前会话目标（群聊为空），服务端按会话范围检索
    convSearchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var keyword = convSearchInput.value.trim();
        if (!keyword) return;
        convSearching = currentChatUser;
        var msg = { msg_type: MSG.CONV_SEARCH, content: keyword };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        IMSocket.send(msg);
    });

    IMSocket.on(MSG.CONV_SEARCH_RESP, function (msg) {
        // 响应归属校验：期间已切换会话则丢弃本次结果
        var target = msg.to_user || '';
        if (target !== convSearching || target !== currentChatUser) return;

        var records = [];
        try { records = JSON.parse(msg.content) || []; } catch (e) {}
        convSearchResults.innerHTML = '';

        // 结果数量提示 / 空结果提示（复用空态样式）
        var tip = document.createElement('div');
        tip.className = 'conv-result-empty';
        tip.textContent = records.length ? ('搜索结果（' + records.length + ' 条）') : '暂无匹配的聊天记录';
        convSearchResults.appendChild(tip);

        // 服务端按 ID 倒序返回，界面按时间正序展示
        records.slice().reverse().forEach(function (r) {
            var isMine = r.from_user === IMSocket.getUsername();
            var item = document.createElement('div');
            item.className = 'conv-result-item';
            var head = document.createElement('div');
            head.className = 'conv-result-head';
            var who = document.createElement('span');
            who.textContent = isMine ? '我' : r.from_user;
            var when = document.createElement('span');
            when.textContent = formatTime(new Date(r.create_time).getTime());
            head.appendChild(who);
            head.appendChild(when);
            var body = document.createElement('div');
            body.className = 'conv-result-body';
            body.textContent = r.content;
            item.appendChild(head);
            item.appendChild(body);
            item.addEventListener('click', function () {
                var el = messageList.querySelector('.message[data-msg-id="' + r.id + '"]');
                if (el) {
                    // 消息已在窗口中：直接定位高亮
                    highlightMessage(el);
                } else {
                    // 消息尚未加载：从第 2 页起向前翻页查找（第 1 页已渲染）
                    locateState.active = true;
                    locateState.msgId = r.id;
                    locateState.page = 1;
                    loadNextLocatePage();
                }
                convSearch.classList.add('hidden');
            });
            convSearchResults.appendChild(item);
        });

        convSearchResults.classList.remove('hidden');
    });

    // ===== 置顶消息条：服务端归口同步，每个会话仅一条置顶消息 =====
    IMSocket.on(MSG.MSG_PIN_SYNC, function (msg) {
        var info = null;
        try { info = JSON.parse(msg.content); } catch (e) {}
        if (!info) return;
        var target = info.target || '';
        // 阶段十三增强：同步内容与现有状态一致时跳过（服务端置顶幂等的兜底去重），
        // 防止重复同步引起置顶条重渲染闪烁
        // 原实现：每次同步都更新并重渲染
        var prev = pinInfo[target];
        if (info.msg_id) {
            if (prev && prev.msg_id === info.msg_id && prev.pin_user === info.pin_user) return;
            pinInfo[target] = info;
        } else {
            if (!prev) return;
            delete pinInfo[target];
        }
        // 当前正在查看该会话时立即刷新置顶条
        if (target === currentChatUser) renderPinBar();
    });

    function renderPinBar() {
        var info = pinInfo[currentChatUser];
        if (info && info.msg_id) {
            pinBarUser.textContent = info.from_user + '：';
            pinBarText.textContent = info.content;
            pinBar.classList.remove('hidden');
        } else {
            pinBar.classList.add('hidden');
        }
    }

    // 点击 × 取消置顶（发送取消请求，服务端同步双方）
    pinBarClose.addEventListener('click', function () {
        IMSocket.send({
            msg_type: MSG.MSG_PIN,
            to_user: currentChatUser,
            msg_id: 0,
            content: 'unpin'
        });
    });

    // ===== 关键词搜索：回车搜索，结果面板展示，点击跳转会话 =====
    var searchInput = document.getElementById('search-input');
    var searchClearBtn = document.getElementById('search-clear-btn');
    var searchPanel = document.getElementById('search-panel');

    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            var keyword = searchInput.value.trim();
            if (!keyword) return;
            IMSocket.send({ msg_type: MSG.SEARCH, content: keyword });
        }
    });

    searchClearBtn.addEventListener('click', function () {
        searchPanel.classList.add('hidden');
        searchClearBtn.classList.add('hidden');
        searchInput.value = '';
    });

    IMSocket.on(MSG.SEARCH_RESP, function (msg) {
        var records = [];
        try { records = JSON.parse(msg.content) || []; } catch (err) {}
        searchPanel.innerHTML = '';

        var title = document.createElement('div');
        title.className = 'search-title';
        title.textContent = '搜索结果 (' + records.length + ')';
        searchPanel.appendChild(title);

        if (records.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'search-empty';
            empty.textContent = '暂无匹配的聊天记录';
            searchPanel.appendChild(empty);
        }

        records.forEach(function (r) {
            var isGroup = !r.to_user;
            // 私聊会话对象：自己发送则是收件人，否则是发件人
            var partner = isGroup ? '' : (r.from_user === IMSocket.getUsername() ? r.to_user : r.from_user);
            var convName = isGroup ? '群聊' : partner;
            var item = document.createElement('div');
            item.className = 'search-item';
            var head = document.createElement('div');
            head.className = 'search-item-head';
            head.textContent = convName + ' · ' + r.from_user;
            var body = document.createElement('div');
            body.className = 'search-item-body';
            body.textContent = r.content;
            var time = document.createElement('div');
            time.className = 'search-item-time';
            time.textContent = formatTime(r.create_time);
            item.appendChild(head);
            item.appendChild(body);
            item.appendChild(time);
            item.addEventListener('click', function () {
                openConversation(partner);
                searchPanel.classList.add('hidden');
                searchClearBtn.classList.add('hidden');
            });
            searchPanel.appendChild(item);
        });

        searchPanel.classList.remove('hidden');
        searchClearBtn.classList.remove('hidden');
    });

    // 格式化时间显示（月-日 时:分）
    function formatTime(t) {
        var d = new Date(t);
        if (isNaN(d.getTime())) return '';
        function pad(n) { return n < 10 ? '0' + n : n; }
        return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
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
            // 原实现：var badge = unreadCount[f.username] ? ... 本地计数，与服务端会话角标双源不一致
            // 未读数服务端归口：好友列表角标从服务端推送的会话列表读取未读数（与会话列表角标同源）
            var funread = 0;
            for (var ui = 0; ui < convList.length; ui++) {
                if (convList[ui].target === f.username) { funread = convList[ui].unread || 0; break; }
            }
            var badge = funread > 0
                ? '<span class="unread-badge">' + (funread > 99 ? '99+' : funread) + '</span>'
                : '';
            var dot = f.online ? '<span class="online-dot"></span>' : '';
            html += '<li class="user-item' + (currentChatUser === f.username ? ' active' : '') + '" data-user="' + f.username + '">'
                + avatarHtml + '<span class="user-name">' + displayName + '</span>' + dot + badge + '</li>';
        });
        userListEl.innerHTML = html;

        userListEl.querySelectorAll('.user-item').forEach(function (item) {
            item.addEventListener('click', function () {
                openConversation(this.getAttribute('data-user'));
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
    // 构建消息元素（返回 DOM 节点，不插入列表）：供实时消息与历史消息渲染复用
    function createMessageEl(fromUser, content, type, msgId, timestamp, showReadStatus, isRead) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        // 携带消息 ID / 发送者 / 时间戳，供撤回、删除、已读、置顶定位功能使用
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
        return div;
    }

    // 实时消息：构建元素后追加到列表末尾并滚动到底部
    function appendMessage(fromUser, content, type, msgId, timestamp, showReadStatus, isRead) {
        // 原实现：构建与插入耦合在 appendMessage 内，历史消息无法复用，现拆分为 createMessageEl
        // var div = document.createElement('div');
        // div.className = 'message ' + type;
        // // 携带消息 ID / 发送者 / 时间戳，供撤回、删除、已读功能使用
        // if (msgId) div.setAttribute('data-msg-id', msgId);
        // div.setAttribute('data-from', fromUser);
        // if (timestamp) div.setAttribute('data-ts', timestamp);
        // var nameEl = document.createElement('div');
        // nameEl.className = 'message-name';
        // nameEl.textContent = fromUser;
        // var bubble = document.createElement('div');
        // bubble.className = 'message-bubble';
        // bubble.textContent = content;
        // div.appendChild(nameEl);
        // div.appendChild(bubble);
        // // 自己发送的私聊消息显示已读/未读状态
        // if (showReadStatus && type === 'self' && msgId) {
        //     var status = document.createElement('div');
        //     status.className = 'msg-status' + (isRead ? ' read' : '');
        //     status.setAttribute('data-msg-id', msgId);
        //     status.textContent = isRead ? '已读' : '未读';
        //     div.appendChild(status);
        // }
        // messageList.appendChild(div);
        // messageList.scrollTop = messageList.scrollHeight;
        var div = createMessageEl(fromUser, content, type, msgId, timestamp, showReadStatus, isRead);
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
