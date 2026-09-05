// chat.js - 消息收发、好友管理、渲染、主题、头像
(function () {
    var MSG = IMSocket.MSG;
    var currentChatUser = ''; // 空字符串表示群聊
    var friendList = []; // 好友列表 [{username, remark, group, online, avatar}]
    // 头像缺失修复：登录用户自己头像（服务端 LOGIN_RESP 下发，上传成功后同步更新），供消息气泡头像渲染
    var myAvatar = '';
    // 头像缺失修复：在线用户头像表（服务端 USER_LIST 推送，username -> avatar），
    // 群聊发送者可能不在好友列表（无法从 friendList 取头像），从在线用户列表兜底获取
    var userAvatars = {};
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
    // 头像降级修复：左上角首字母占位元素（无头像/图片加载失败时显示，原 img 空 src 渲染为破图）
    var navAvatarPhEl = document.getElementById('current-avatar-ph');
    var avatarFileEl = document.getElementById('avatar-file');

    // ===== 阶段三十：个人资料面板元素（微信式右侧滑出，点击自己头像打开） =====
    var profileMask = document.getElementById('profile-mask');
    var profilePanel = document.getElementById('profile-panel');
    var profileClose = document.getElementById('profile-close');
    var profileAvatarWrap = document.getElementById('profile-avatar-wrap');
    var profileAvatarEl = document.getElementById('profile-avatar');
    // 头像降级修复：资料面板大头像首字母占位元素（无头像/图片加载失败时显示）
    var profileAvatarPhEl = document.getElementById('profile-avatar-ph');
    var profileUsernameEl = document.getElementById('profile-username');
    var profileNicknameEl = document.getElementById('profile-nickname');
    var profileGenderEl = document.getElementById('profile-gender');
    var profileRegionEl = document.getElementById('profile-region');
    var profileSignatureEl = document.getElementById('profile-signature');
    var profileSaveBtn = document.getElementById('profile-save');

    // ===== 阶段三十：好友资料卡元素（微信式居中卡片，点击好友头像弹出） =====
    var friendCardMask = document.getElementById('friend-card-mask');
    var friendCardClose = document.getElementById('friend-card-close');
    var friendCardAvatar = document.getElementById('friend-card-avatar');
    var friendCardName = document.getElementById('friend-card-name');
    var friendCardGender = document.getElementById('friend-card-gender');
    var friendCardUsername = document.getElementById('friend-card-username');
    var friendCardRegion = document.getElementById('friend-card-region');
    var friendCardSignature = document.getElementById('friend-card-signature');
    var friendCardChatBtn = document.getElementById('friend-card-chat');
    var friendCardRemarkBtn = document.getElementById('friend-card-remark');

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
    var pinBarMain = document.getElementById('pin-bar-main'); // 阶段十五：置顶条内容区，点击定位原消息

    // ===== 会话内搜索元素 =====
    var convSearchBtn = document.getElementById('conv-search-btn');
    var convSearch = document.getElementById('conv-search');
    var convSearchInput = document.getElementById('conv-search-input');
    var convSearchClose = document.getElementById('conv-search-close');
    var convSearchResults = document.getElementById('conv-search-results');

    // ===== 阶段二十九：新的朋友元素（微信式好友申请归口） =====
    var newFriendsEntry = document.getElementById('new-friends-entry');
    var newFriendsBadge = document.getElementById('new-friends-badge');
    var navFriendsBadge = document.getElementById('nav-friends-badge'); // 通讯录导航图标红点（微信同款，无需切Tab即可见）
    var newFriendsPanel = document.getElementById('new-friends-panel');
    var newFriendsClose = document.getElementById('new-friends-close');
    var newFriendsListEl = document.getElementById('new-friends-list');
    var friendReqListTimer = null; // 申请列表刷新防抖定时器（登录补发多条申请时仅触发一次拉取）

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
        // 阶段三十：Esc 依次关闭资料卡/个人资料面板（后打开的优先关闭）
        if (e.key === 'Escape' && !friendCardMask.classList.contains('hidden')) closeFriendCard();
        else if (e.key === 'Escape' && !profilePanel.classList.contains('hidden')) closeProfilePanel();
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
        // UI 规范修复：原代码 alert('请输入用户名') 为系统默认弹窗，违反"禁止使用系统默认弹窗"规则，改用页面内 Toast
        if (!username) { showToast('请输入用户名'); return; }
        if (!password) { showToast('请输入密码'); return; }
        IMSocket.connect(username, password);
    }

    // ===== 退出 =====
    // 登录持久化：退出登录时清除已保存凭据，刷新后回到登录界面（否则自动登录会直接再次进入）
    // 原实现：logoutBtn.addEventListener('click', function () { location.reload(); });
    logoutBtn.addEventListener('click', function () {
        clearAuth();
        location.reload();
    });

    // ===== 登录持久化：刷新页面后保持登录状态 =====
    // 原实现：登录状态仅存于 JS 内存变量，刷新后全部丢失，必须重新输入账号密码登录
    // 方案：登录成功后将凭据存入 localStorage（base64 轻度混淆），页面加载时自动重连登录；
    //       退出登录或登录失败（如密码已被修改）时清除凭据，回退到手动登录
    function saveAuth(u, p) {
        try { localStorage.setItem('im_auth', btoa(encodeURIComponent(JSON.stringify({ u: u, p: p })))); } catch (e) {}
    }
    function clearAuth() {
        try { localStorage.removeItem('im_auth'); } catch (e) {}
    }
    function getSavedAuth() {
        try { return JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || null; } catch (e) { return null; }
    }
    // 页面加载时存在已保存凭据则自动登录（预填登录框便于用户感知当前账号）
    // 乐观显示：立即切换到聊天界面再后台连接，避免等待服务端登录响应期间闪现登录窗口；
    // 连接失败或登录失败时再回退到登录界面（见 LOGIN_RESP 失败分支与 im_connect_failed 监听）
    (function autoLogin() {
        var saved = getSavedAuth();
        if (saved && saved.u && saved.p) {
            loginUsername.value = saved.u;
            loginPassword.value = saved.p;
            loginView.classList.add('hidden');
            chatView.classList.remove('hidden');
            IMSocket.connect(saved.u, saved.p);
        }
    })();
    // 登录持久化：自动登录期间连接失败（服务端未启动/登录被拒后断开），
    // 从乐观显示的聊天界面回退到登录界面（socket.js onclose 且未登录成功时派发该事件）
    window.addEventListener('im_connect_failed', function () {
        loginView.classList.remove('hidden');
        chatView.classList.add('hidden');
    });

    // ===== 主题切换 =====
    var themes = ['light', 'dark', 'system'];
    var themeNames = { light: '浅色', dark: '深色', system: '跟随系统' };
    // 主题按钮改为图标显示（与聊天/通讯录图标同风格 SVG，跟随主题色）：
    // 浅色=太阳图标 深色=月亮图标 跟随系统=显示器图标，主题名称通过 title 悬停提示展示
    // 原实现：themeBtn.textContent = '主题·' + themeNames[next] 文字按钮，已注释保留备用
    // themeBtn.textContent = '主题·' + themeNames[next];
    var themeIcons = {
        light: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>',
        dark: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 12 3z"/></svg>',
        system: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/></svg>'
    };
    function getTheme() { return localStorage.getItem('im_theme') || 'light'; }
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('im_theme', theme);
    }
    // 按当前主题刷新按钮图标与悬停提示
    function renderThemeBtn(theme) {
        themeBtn.innerHTML = themeIcons[theme];
        themeBtn.title = '主题·' + themeNames[theme];
    }
    applyTheme(getTheme());
    themeBtn.addEventListener('click', function () {
        var idx = themes.indexOf(getTheme());
        var next = themes[(idx + 1) % themes.length];
        applyTheme(next);
        renderThemeBtn(next);
    });
    renderThemeBtn(getTheme());

    // ===== 头像降级修复：导航栏左上角头像统一入口 =====
    // 原实现：各处直接 currentAvatarEl.src 赋值，新注册账号 avatar 为空时 img 空 src 被浏览器渲染为破图（碎图标）
    var navAvatarFailedUrl = ''; // 记录加载失败的头像地址，避免重复设置同一失效 URL（缓存错误结果）导致空白
    // 有头像显示图片，无头像显示账号首字母占位（跟随主题色）
    function setNavAvatar(url) {
        if (url && url !== navAvatarFailedUrl) {
            currentAvatarEl.src = url;
            currentAvatarEl.style.display = '';
            navAvatarPhEl.style.display = 'none';
        } else {
            // 关键：空 src 会被浏览器渲染为破图，必须移除 src 并隐藏 img，改显首字母占位
            currentAvatarEl.removeAttribute('src');
            currentAvatarEl.style.display = 'none';
            navAvatarPhEl.textContent = (IMSocket.getUsername() || '?').charAt(0).toUpperCase();
            navAvatarPhEl.style.display = 'flex';
        }
    }
    // 头像文件失效（文件被清理/路径变更）时降级为首字母占位，避免破图
    currentAvatarEl.addEventListener('error', function () {
        navAvatarFailedUrl = currentAvatarEl.getAttribute('src') || '';
        setNavAvatar('');
    });
    // 占位头像与图片头像点击行为一致：打开个人资料面板
    navAvatarPhEl.addEventListener('click', openProfilePanel);

    // ===== 头像降级修复：资料面板大头像统一入口 =====
    function setProfileAvatar(url) {
        if (url) {
            profileAvatarEl.src = url;
            profileAvatarEl.style.display = '';
            profileAvatarPhEl.style.display = 'none';
        } else {
            profileAvatarEl.removeAttribute('src');
            profileAvatarEl.style.display = 'none';
            profileAvatarPhEl.textContent = (IMSocket.getUsername() || '?').charAt(0).toUpperCase();
            profileAvatarPhEl.style.display = 'flex';
        }
    }
    // 头像文件失效时降级为首字母占位，避免破图
    profileAvatarEl.addEventListener('error', function () {
        setProfileAvatar('');
    });

    // ===== 头像上传 =====
    // 阶段三十：点击导航栏头像改为打开微信式"个人资料"面板（面板内点击大头像更换头像）
    // 原代码：currentAvatarEl.addEventListener('click', function () { avatarFileEl.click(); }); 点击直接弹文件选择
    currentAvatarEl.addEventListener('click', openProfilePanel);
    avatarFileEl.addEventListener('change', function () {
        var file = avatarFileEl.files[0];
        if (!file) return;
        var formData = new FormData();
        formData.append('avatar', file);
        fetch('/upload/avatar?username=' + encodeURIComponent(IMSocket.getUsername()), {
            method: 'POST', body: formData
        }).then(function (r) { return r.json(); })
          .then(function (data) {
              if (data.avatar) {
                  setNavAvatar(data.avatar);
                  // 头像缺失修复：上传成功同步更新消息气泡头像数据源，后续发送的消息立即使用新头像
                  // 原代码：仅更新导航栏 currentAvatarEl.src
                  myAvatar = data.avatar;
                  userAvatars[IMSocket.getUsername()] = data.avatar;
                  // 阶段三十：资料面板内大头像同步更新（面板打开时换图即时可见）
                  setProfileAvatar(data.avatar);
              }
              else if (data.error) showToast(data.error);
          }).catch(function () { showToast('头像上传失败'); });
        avatarFileEl.value = '';
    });

    // ===== 阶段三十：个人资料（微信式"我的个人资料"面板，服务端归口多端同步） =====
    // 登录响应 LOGIN_RESP / 更新回推 PROFILE_RESP 均填充此状态
    var myProfile = { nickname: '', gender: 0, region: '', signature: '' };
    var friendCardTarget = ''; // 当前资料卡展示的目标用户名

    // 打开个人资料面板：以当前资料状态填充表单
    function openProfilePanel() {
        profileUsernameEl.textContent = IMSocket.getUsername();
        setProfileAvatar(myAvatar || '');
        profileNicknameEl.value = myProfile.nickname || '';
        profileRegionEl.value = myProfile.region || '';
        profileSignatureEl.value = myProfile.signature || '';
        applyGenderSelect(myProfile.gender || 0);
        profileMask.classList.remove('hidden');
        profilePanel.classList.remove('hidden');
    }

    function closeProfilePanel() {
        profileMask.classList.add('hidden');
        profilePanel.classList.add('hidden');
    }

    // 性别分段选择：高亮选中项
    function applyGenderSelect(val) {
        profileGenderEl.querySelectorAll('.gender-opt').forEach(function (opt) {
            opt.classList.toggle('active', Number(opt.getAttribute('data-gender')) === Number(val));
        });
    }
    profileGenderEl.addEventListener('click', function (e) {
        var opt = e.target.closest('.gender-opt');
        if (opt) applyGenderSelect(opt.getAttribute('data-gender'));
    });

    profileClose.addEventListener('click', closeProfilePanel);
    profileMask.addEventListener('click', closeProfilePanel);
    // 面板内点击大头像更换头像（复用现有 avatar-file 上传通道）
    profileAvatarWrap.addEventListener('click', function () { avatarFileEl.click(); });

    // 保存资料：前端轻校验后发送 PROFILE_UPDATE，服务端归口校验并回推多端同步
    profileSaveBtn.addEventListener('click', function () {
        var nickname = profileNicknameEl.value.trim();
        var region = profileRegionEl.value.trim();
        var signature = profileSignatureEl.value.trim();
        var gender = 0;
        var activeOpt = profileGenderEl.querySelector('.gender-opt.active');
        if (activeOpt) gender = Number(activeOpt.getAttribute('data-gender'));
        IMSocket.send({
            msg_type: MSG.PROFILE_UPDATE,
            content: JSON.stringify({ nickname: nickname, gender: gender, region: region, signature: signature })
        });
    });

    // 个人资料响应/同步：自己（更新本地状态与面板/导航栏）；他人（填充好友资料卡）
    IMSocket.on(MSG.PROFILE_RESP, function (msg) {
        var info = null;
        try { info = JSON.parse(msg.content); } catch (e) { return; }
        if (!info || !info.username) return;
        if (info.username === IMSocket.getUsername()) {
            // 自己：更新资料状态与面板显示（多端同步：其他设备修改后本端面板即时刷新）
            myProfile = {
                nickname: info.nickname || '',
                gender: info.gender || 0,
                region: info.region || '',
                signature: info.signature || ''
            };
            profileNicknameEl.value = myProfile.nickname;
            profileRegionEl.value = myProfile.region;
            profileSignatureEl.value = myProfile.signature;
            applyGenderSelect(myProfile.gender);
            if (info.avatar) {
                myAvatar = info.avatar;
                setNavAvatar(info.avatar);
                setProfileAvatar(info.avatar);
                userAvatars[info.username] = info.avatar;
            }
        } else if (info.username === friendCardTarget) {
            fillFriendCard(info);
        }
    });

    // ===== 阶段三十：好友资料卡（微信式，点击好友头像弹出） =====
    // 打开资料卡：先弹卡占位，PROFILE_QUERY 响应回来后填充（服务端归口：资料+好友关系+备注）
    function openFriendCard(username) {
        if (!username || username === IMSocket.getUsername()) {
            // 点自己头像打开自己的资料面板（微信同款行为）
            openProfilePanel();
            return;
        }
        friendCardTarget = username;
        friendCardAvatar.src = getAvatarUrl(username) || '';
        friendCardName.textContent = '加载中...';
        friendCardGender.textContent = '';
        friendCardGender.className = 'friend-card-gender';
        friendCardUsername.textContent = username;
        friendCardRegion.textContent = '';
        friendCardSignature.textContent = '';
        friendCardRemarkBtn.classList.add('hidden');
        friendCardMask.classList.remove('hidden');
        IMSocket.send({ msg_type: MSG.PROFILE_QUERY, to_user: username });
    }

    // 填充资料卡内容（PROFILE_RESP 响应，好友显示备注与性别图标）
    function fillFriendCard(info) {
        var remark = info.remark || '';
        var nickname = info.nickname || '';
        // 微信式主名称：备注优先，其次昵称，最后用户名；括号内补充真实名称
        var mainName = remark || nickname || info.username;
        friendCardName.textContent = info.username === mainName ? mainName : mainName + '(' + info.username + ')';
        // 性别图标：微信同款 ♂蓝 / ♀粉
        var g = Number(info.gender) || 0;
        if (g === 1) {
            friendCardGender.textContent = '♂';
            friendCardGender.className = 'friend-card-gender male';
        } else if (g === 2) {
            friendCardGender.textContent = '♀';
            friendCardGender.className = 'friend-card-gender female';
        } else {
            friendCardGender.textContent = '';
            friendCardGender.className = 'friend-card-gender';
        }
        friendCardAvatar.src = info.avatar || '';
        friendCardRegion.textContent = info.region || '暂无';
        friendCardSignature.textContent = info.signature || '暂无';
        // 仅好友可设置备注（非好友隐藏按钮，服务端同样归口校验）
        friendCardRemarkBtn.classList.toggle('hidden', !info.is_friend);
    }

    function closeFriendCard() {
        friendCardMask.classList.add('hidden');
        friendCardTarget = '';
    }
    friendCardClose.addEventListener('click', closeFriendCard);
    // 点击遮罩关闭（资料卡为只读展示，无误操作风险）
    friendCardMask.addEventListener('click', function (e) {
        if (e.target === friendCardMask) closeFriendCard();
    });

    // 资料卡：发消息 = 切换到该会话并关卡
    friendCardChatBtn.addEventListener('click', function () {
        var target = friendCardTarget;
        closeFriendCard();
        if (target) openConversation(target);
    });

    // 资料卡：设置备注（复用自定义输入弹窗 + FRIEND_UPDATE，与右键菜单同通道）
    friendCardRemarkBtn.addEventListener('click', function () {
        var target = friendCardTarget;
        if (!target) return;
        showPrompt('设置备注', '请输入好友备注名', function (remark) {
            IMSocket.send({ msg_type: MSG.FRIEND_UPDATE, to_user: target, remark: remark });
        });
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

    // ===== 微信风格：按住输入区上缘拖拽条上下拖动，调整输入框高度，消息区自适应 =====
    var inputResizer = document.getElementById('input-resizer');
    var INPUT_H_MIN = 60; // 最小高度：保证工具栏/一行输入/底部行完整可见
    var INPUT_H_MAX = 480; // 最大高度上限（拖拽时还会按消息区剩余高度动态收紧）

    // 表情面板为固定 bottom 定位，输入框高度变化后同步贴输入框上缘（原 CSS 固定 bottom:180px）
    // 偏移量 = 工具栏 38px + 底部行约 46px + 输入框下边距 10px + 缝隙 6px
    function syncEmojiPanelBottom() {
        var h = messageInput.getBoundingClientRect().height;
        emojiPanel.style.bottom = (h + 100) + 'px';
    }

    // 恢复上次拖拽高度（localStorage 持久化，刷新后保持）；无记录时默认取最小高度 60px
    // 原实现：textarea rows=3 默认约 87px（高于最小高度），用户要求初始即为最小高度
    (function restoreInputHeight() {
        var savedH = 0;
        try { savedH = parseInt(localStorage.getItem('im_input_height'), 10) || 0; } catch (e) {}
        if (savedH >= INPUT_H_MIN && savedH <= INPUT_H_MAX) {
            messageInput.style.height = savedH + 'px';
        } else {
            messageInput.style.height = INPUT_H_MIN + 'px';
        }
        syncEmojiPanelBottom();
    })();

    inputResizer.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startY = e.clientY;
        var startH = messageInput.getBoundingClientRect().height;
        inputResizer.classList.add('dragging');
        document.body.style.userSelect = 'none'; // 拖拽期间禁用文本选择，避免干扰
        function onMove(ev) {
            var delta = startY - ev.clientY; // 上拖增高、下拖减高（微信同向）
            // 消息区至少保留 150px 可视高度，防止输入框挤占全部聊天区
            var maxH = Math.max(INPUT_H_MIN, messageList.getBoundingClientRect().height + startH - 150);
            var newH = Math.min(Math.max(startH + delta, INPUT_H_MIN), Math.min(INPUT_H_MAX, maxH));
            messageInput.style.height = newH + 'px';
            syncEmojiPanelBottom();
        }
        function onUp() {
            inputResizer.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            try { localStorage.setItem('im_input_height', String(messageInput.getBoundingClientRect().height)); } catch (err) {}
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // ===== 图片 / 文件发送（基于分片协议 msg_type=3，仅私聊） =====
    // 阶段二十六：群聊图片改走 HTTP 上传链路（sendGroupImage，服务端广播），分片协议仍为私聊专属
    // 阶段三十一：分片大小不再硬编码，登录响应下发 chunk_size 后覆盖（服务端归口）；默认值仅兜底旧版服务端
    var CHUNK_SIZE = 4 * 1024;
    var pendingUploads = [];   // 等待服务端回执 file_id 的上传任务队列
    var fileBuffers = {};      // 接收中的文件组装缓冲 file_id -> {name,size,total,chunks,count}

    imageBtn.addEventListener('click', function () {
        // 原实现：群聊视图拦截提示"群聊暂不支持发送图片"，阶段二十六放开——群聊图片走 HTTP 上传链路
        // if (currentChatUser === '') { showToast('群聊暂不支持发送图片'); return; }
        imageInput.click();
    });
    fileBtn.addEventListener('click', function () {
        if (currentChatUser === '') { showToast('群聊暂不支持发送文件'); return; }
        fileInput.click();
    });
    imageInput.addEventListener('change', function () {
        if (imageInput.files[0]) {
            // 阶段二十六：群聊视图走 HTTP 上传链路（sendGroupImage），私聊仍走分片协议（sendFile）
            // 原实现：if (imageInput.files[0]) sendFile(imageInput.files[0]);
            if (currentChatUser === '') sendGroupImage(imageInput.files[0]);
            else sendFile(imageInput.files[0]);
        }
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
    // 阶段三十一：大文件（超过服务端下发阈值 upload_threshold）分流至 HTTP 直传（sendFileDirect），
    // WebSocket 仅传信令，避免海量分片占满连接队列、挤掉普通聊天消息
    function sendFile(file) {
        var threshold = (IMSocket.getUploadThreshold && IMSocket.getUploadThreshold()) || 1048576;
        // 阶段三十二：三层分流——超过分片直传上限直接拒绝；超过单请求直传上限走分片直传（进度回显可取消）；
        // 超过 WS 分片阈值走单请求 HTTP 直传；小文件仍走 WS 分片协议（协议不变）
        var maxDirect = (IMSocket.getMaxDirectSize && IMSocket.getMaxDirectSize()) || 2147483648;
        var maxFile = (IMSocket.getMaxFileSize && IMSocket.getMaxFileSize()) || 20971520;
        if (file.size > maxDirect) {
            showToast('文件超过大小上限（' + formatSize(maxDirect) + '），无法发送');
            return;
        }
        if (file.size > maxFile) {
            sendFileChunked(file);
            return;
        }
        if (file.size > threshold) {
            sendFileDirect(file);
            return;
        }
        // 原实现：所有文件一律走分片协议
        var total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        var toUser = currentChatUser;
        // 本地立即渲染（自己发送的消息）
        var url = URL.createObjectURL(file);
        if (isImageName(file.name)) {
            appendImageMsg(IMSocket.getUsername(), url, 'self', currentChatUser !== '');
        } else {
            appendFileMsg(IMSocket.getUsername(), file.name, formatSize(file.size), url, 'self', currentChatUser !== '');
        }
        pendingUploads.push({ file: file, total: total });
        IMSocket.send({
            msg_type: MSG.FILE, chunk_index: -1, to_user: toUser,
            file_name: file.name, file_size: file.size, total_chunks: total
        });
    }

    // 阶段三十一：大文件 HTTP 直传（对齐群聊图片 sendGroupImage 模式）
    // 流程：本地立即渲染（blob 预览 + nonce 标识）→ POST /upload/file（无 file_id，服务端直传建档落库）
    // → 服务端推送 FILE_PERSISTED（携带 content: url/name/size/nonce）→ 发送端按 nonce 回填 msg_id，
    //   接收端按 content 直接渲染 URL，不走分片链路
    function sendFileDirect(file) {
        var toUser = currentChatUser;
        var nonce = Date.now() + '_' + Math.random().toString(36).slice(2);
        var url = URL.createObjectURL(file);
        var bubble;
        if (isImageName(file.name)) {
            bubble = appendImageMsg(IMSocket.getUsername(), url, 'self', true);
        } else {
            bubble = appendFileMsg(IMSocket.getUsername(), file.name, formatSize(file.size), url, 'self', true);
        }
        bubble.setAttribute('data-nonce', nonce);
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/file?username=' + encodeURIComponent(IMSocket.getUsername()) +
              '&to_user=' + encodeURIComponent(toUser) +
              '&nonce=' + encodeURIComponent(nonce), {
            method: 'POST',
            body: fd
        }).then(function (res) {
            // 异常加固：HTTP 4xx/5xx（文件过大/未在线/被拉黑等）统一告警，本地 blob 预览保留
            if (!res.ok) console.warn('大文件直传被拒绝:', res.status);
        }).catch(function (e) {
            // 上传失败仅告警：本地 blob 预览保留，刷新后该消息消失（未落库）属预期降级；不自动重试（服务端无幂等锚点）
            console.warn('大文件直传失败:', e);
        });
    }

    // 阶段三十二：分片直传活动表（uploadId → 状态），取消时据此中止在途 XHR
    var activeChunkUploads = {};

    // 阶段三十二：超大文件分片直传（>单请求直传上限，至 max_direct_size）
    // 流程：本地立即渲染进度气泡（可取消）→ XHR 逐片 POST /upload/chunk（raw body，upload.onprogress 回显整体进度）
    // → 服务端按片落盘并节流推送 FILE_PROGRESS（接收方"发送中 xx%"）→ 收齐合并落库推送 FILE_PERSISTED 回填 msg_id
    // 原实现：fetch 单请求直传无进度事件，超大文件发送方无进度、接收方无感知、失败需整文件重传
    function sendFileChunked(file) {
        var chunkSize = (IMSocket.getUploadChunkSize && IMSocket.getUploadChunkSize()) || 4194304;
        var total = Math.max(1, Math.ceil(file.size / chunkSize));
        var toUser = currentChatUser;
        var nonce = Date.now() + '_' + Math.random().toString(36).slice(2);
        var uploadId = 'u' + Date.now() + '_' + Math.random().toString(36).slice(2);
        // 本地立即渲染进度气泡（发送方带取消按钮；blob URL 供发送完成前点击预览，落库后由 FILE_PERSISTED 归口）
        var bubble = appendProgressBubble(IMSocket.getUsername(), file.name, formatSize(file.size), 'self', toUser !== '', uploadId, nonce, true);
        var state = { xhr: null, cancelled: false };
        activeChunkUploads[uploadId] = state;
        // 进度回显：已完成片数 + 当前片 XHR 进度 → 整体百分比
        function setProgress(ratio) {
            var pct = Math.floor(ratio * 100);
            var bar = bubble.querySelector('.file-progress-inner');
            var txt = bubble.querySelector('.file-progress-text');
            if (bar) bar.style.width = pct + '%';
            if (txt) txt.textContent = '上传中 ' + pct + '%';
        }
        function failUpload(errText) {
            bubble.classList.add('upload-failed');
            var txt = bubble.querySelector('.file-progress-text');
            if (txt) txt.textContent = '上传失败';
            delete activeChunkUploads[uploadId];
            showToast(errText);
        }
        function sendSeq(idx) {
            if (state.cancelled) return;
            var start = idx * chunkSize;
            var blob = file.slice(start, Math.min(start + chunkSize, file.size));
            var xhr = new XMLHttpRequest();
            state.xhr = xhr;
            xhr.open('POST', '/upload/chunk?username=' + encodeURIComponent(IMSocket.getUsername()) +
                  '&to_user=' + encodeURIComponent(toUser) +
                  '&nonce=' + encodeURIComponent(nonce) +
                  '&upload_id=' + encodeURIComponent(uploadId) +
                  '&seq=' + idx + '&total_chunks=' + total +
                  '&file_name=' + encodeURIComponent(file.name) +
                  '&file_size=' + file.size, true);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            // 单片上传进度叠加已完成片数换算整体进度（e.total 为当前片字节数）
            xhr.upload.onprogress = function (e) {
                if (e.lengthComputable) setProgress((idx + e.loaded / e.total) / total);
            };
            xhr.onload = function () {
                if (state.cancelled) return;
                if (xhr.status === 200) {
                    setProgress((idx + 1) / total);
                    if (idx + 1 < total) { sendSeq(idx + 1); return; }
                    // 全部分片上传完成：终态（msg_id 回填）由 FILE_PERSISTED 服务端归口通知
                    var bar = bubble.querySelector('.file-progress-inner');
                    var txt = bubble.querySelector('.file-progress-text');
                    if (bar) bar.style.width = '100%';
                    if (txt) txt.textContent = '已发送';
                    delete activeChunkUploads[uploadId];
                } else {
                    // 上传被服务端拒绝（超限/拉黑/未在线/取消等）：进度条置失败态，本地气泡保留供确认
                    failUpload('文件上传失败：' + (xhr.responseText || ('HTTP ' + xhr.status)));
                }
            };
            xhr.onerror = function () {
                if (state.cancelled) return;
                failUpload('文件上传失败：网络错误');
            };
            xhr.send(blob);
        }
        // 取消按钮：中止在途 XHR → WS 通知服务端清理会话并同步双方移除进度气泡
        var cancelBtn = bubble.querySelector('.file-progress-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function () {
                if (state.cancelled) return;
                state.cancelled = true;
                if (state.xhr) state.xhr.abort();
                delete activeChunkUploads[uploadId];
                bubble.remove();
                IMSocket.send({ msg_type: MSG.FILE_CANCEL, file_id: uploadId });
            });
        }
        sendSeq(0);
    }

    // 阶段三十二：进度气泡构建（文件卡片 + 进度条 + 百分比文本，样式跟随主题色）
    // 双端共用：发送方"上传中 xx%"带取消按钮，接收方"接收中 xx%"只读（微信同款）
    function appendProgressBubble(fromUser, name, sizeText, type, isPrivate, uploadId, nonce, showCancel) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        // 撤回/回填锚点：data-from/data-ts 与文件气泡一致；data-upload-id 供进度/取消信令精确定位
        div.setAttribute('data-from', fromUser);
        div.setAttribute('data-ts', Math.floor(Date.now() / 1000));
        div.setAttribute('data-upload-id', uploadId);
        if (nonce) div.setAttribute('data-nonce', nonce);
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
        // 进度条 + 百分比文本
        var progress = document.createElement('div');
        progress.className = 'file-progress';
        var bar = document.createElement('div');
        bar.className = 'file-progress-inner';
        bar.style.width = '0%';
        progress.appendChild(bar);
        var txt = document.createElement('div');
        txt.className = 'file-progress-text';
        txt.textContent = '上传中 0%';
        info.appendChild(progress);
        info.appendChild(txt);
        bubble.appendChild(icon);
        bubble.appendChild(info);
        if (showCancel) {
            var cancel = document.createElement('div');
            cancel.className = 'file-progress-cancel';
            cancel.textContent = '×';
            cancel.title = '取消发送';
            bubble.appendChild(cancel);
        }
        // 头像 + 内容列微信风格结构（与 appendFileMsg 一致）
        var body = document.createElement('div');
        body.className = 'message-body';
        if (!isPrivate) body.appendChild(nameEl);
        body.appendChild(bubble);
        div.appendChild(getAvatarEl(fromUser));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
        return div;
    }

    // 顺序发送分片：base64 编码后逐片上传
    // 阶段三十一：发送前检查底层 WebSocket 缓冲积压（bufferedAmount），超过 8 个分片量级时等待 10ms 重试——
    // 原实现：FileReader 全速递归发送无任何节流，弱网时分片在浏览器/服务端队列堆积，挤掉普通聊天消息
    function sendChunks(file, fileId, toUser, total) {
        var idx = 0;
        function next() {
            if (idx >= total) {
                // 阶段二十四：分片全部发送完成后，回传原文件持久化（服务端按 file_id 幂等落库，历史可重现）
                persistUploadedFile(file, fileId);
                return;
            }
            // 背压限速：底层积压超阈值（约 8 个分片）暂停发送，等待浏览器消化后再继续
            if (IMSocket.getBufferedAmount && IMSocket.getBufferedAmount() > CHUNK_SIZE * 8) {
                setTimeout(next, 10);
                return;
            }
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

    // 阶段二十四：回传原文件给服务端持久化（POST /upload/file，服务端按 file_id 幂等落库）
    // 上传失败仅告警不影响实时显示（blob 渲染照常），刷新后该消息从历史中消失属预期降级
    function persistUploadedFile(file, fileId) {
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/file?file_id=' + encodeURIComponent(fileId) + '&username=' + encodeURIComponent(IMSocket.getUsername()), {
            method: 'POST',
            body: fd
        }).then(function (r) { return r.json(); }).then(function (res) {
            // msg_id 回填统一由 FILE_PERSISTED 服务端通知处理（服务端归口，双方一致，按 file_id 精确匹配）
            // 原实现：HTTP 响应后取"最后一条无 msg_id 的 self 气泡"回填，仅发送方生效且并发发送时可能错位
            // if (res && res.msg_id) {
            //     var bubbles = messageList.querySelectorAll('.message.self:not([data-msg-id])');
            //     var last = bubbles[bubbles.length - 1];
            //     if (last) last.setAttribute('data-msg-id', res.msg_id);
            // }
        }).catch(function (e) {
            console.warn('文件持久化上传失败（不影响实时显示）:', e);
        });
    }

    // 持久化完成同步：双方实时气泡按 file_id 精确回填 msg_id
    // （撤回/删除/置顶能力前提；对方撤回图片/文件时本端提示才能替换原气泡而非残留）
    // 阶段三十一：扩展直传模式（content 携带 url/name/size/nonce）——
    // 分片路径通知无 content，仅回填 msg_id（原逻辑不变）；直传路径接收端按 content 直接渲染，
    // 发送端按 nonce 回填本地气泡（对齐群聊图片 GROUP_IMAGE 的归口思路）
    IMSocket.on(MSG.FILE_PERSISTED, function (msg) {
        if (!msg.file_id || !msg.msg_id) return;
        // 分片路径：气泡已存在（file_id 随文件头回执记录），仅回填 msg_id
        var el = messageList.querySelector('.message[data-file-id="' + msg.file_id + '"]');
        if (el) {
            el.setAttribute('data-msg-id', msg.msg_id);
            return;
        }
        // 直传路径：content 为空说明是旧版分片通知且气泡缺失，无需渲染
        var meta = {};
        try { meta = JSON.parse(msg.content || '{}'); } catch (e) {}
        if (!meta.url) return;
        // msg_id 去重（并发加固）：历史已渲染该消息、多端重复通知等场景防止重复气泡
        if (messageList.querySelector('.message[data-msg-id="' + msg.msg_id + '"]')) return;
        var isMine = msg.from_user === IMSocket.getUsername();
        // 发送端：按 nonce 精确匹配本地气泡回填 msg_id（本地 blob 预览已在发送时渲染，不重复渲染）
        if (isMine && meta.nonce) {
            var mineEl = messageList.querySelector('.message.self[data-nonce="' + meta.nonce + '"]');
            if (mineEl) {
                mineEl.setAttribute('data-msg-id', msg.msg_id);
                mineEl.setAttribute('data-file-id', msg.file_id);
                // 阶段三十二：分片直传气泡为进度形态，回填后移除进度条/百分比/取消按钮（转为终态文件卡片）
                var prog = mineEl.querySelector('.file-progress');
                if (prog) prog.remove();
                var ptxt = mineEl.querySelector('.file-progress-text');
                if (ptxt) ptxt.remove();
                var pcancel = mineEl.querySelector('.file-progress-cancel');
                if (pcancel) pcancel.remove();
                mineEl.classList.remove('upload-failed');
                return;
            }
        }
        // 阶段三十二：接收端移除同 nonce 的"接收中"进度气泡（分片直传路径），随后渲染正式卡片
        // 原实现：无进度气泡通道，接收方对传输过程无感知
        if (meta.nonce) {
            var progEl = messageList.querySelector('.message[data-upload-id][data-nonce="' + meta.nonce + '"]');
            if (progEl) progEl.remove();
        }
        // 归属校验（与 GROUP_IMAGE 口径一致）：私聊仅在对应会话视图渲染，不在窗口时依赖会话摘要/历史归口
        var peer = isMine ? msg.to_user : msg.from_user;
        if (currentChatUser !== peer) return;
        var mediaEl;
        if (isImageName(meta.name || '')) {
            mediaEl = appendImageMsg(msg.from_user, meta.url, isMine ? 'self' : 'other', true);
        } else {
            mediaEl = appendFileMsg(msg.from_user, meta.name || '未命名文件', formatSize(meta.size || 0), meta.url, isMine ? 'self' : 'other', true);
        }
        mediaEl.setAttribute('data-msg-id', msg.msg_id);
        mediaEl.setAttribute('data-file-id', msg.file_id);
        if (msg.timestamp) mediaEl.setAttribute('data-ts', msg.timestamp);
    });

    // ===== 阶段三十二：超大文件分片直传进度同步 =====
    // 接收方"发送中 xx%"进度气泡：服务端节流推送（单会话最快 500ms 一条），终态由 FILE_PERSISTED 归口替换
    // 原实现：无进度通道，接收方对超大文件传输过程无感知，只能干等
    IMSocket.on(MSG.FILE_PROGRESS, function (msg) {
        var meta = {};
        try { meta = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!meta.upload_id) return;
        // 归属校验：私聊仅对应会话视图渲染；群聊（to_user 为空）仅群聊视图渲染
        // 进度为临时态，不在窗口时不补渲染（终态卡片/会话摘要由 FILE_PERSISTED/CONV_LIST 归口）
        var peer = msg.to_user || '';
        if (currentChatUser !== peer) return;
        var isMine = msg.from_user === IMSocket.getUsername();
        // 已有进度气泡：仅更新百分比与文本（优先 upload_id 精确匹配，nonce 兜底）
        var el = messageList.querySelector('.message[data-upload-id="' + meta.upload_id + '"]');
        if (!el && meta.nonce) {
            el = messageList.querySelector('.message[data-nonce="' + meta.nonce + '"]');
        }
        if (!el) {
            // 首次进度：创建接收方进度气泡（无取消按钮）
            el = appendProgressBubble(msg.from_user, meta.file_name || '文件', formatSize(meta.file_size || 0), isMine ? 'self' : 'other', peer !== '', meta.upload_id, meta.nonce || '', false);
        }
        var ratio = meta.total > 0 ? Math.min(1, meta.received / meta.total) : 0;
        var pct = Math.floor(ratio * 100);
        var bar = el.querySelector('.file-progress-inner');
        if (bar) bar.style.width = pct + '%';
        var txt = el.querySelector('.file-progress-text');
        if (txt) txt.textContent = (el.classList.contains('self') ? '上传中 ' : '接收中 ') + pct + '%';
    });

    // 阶段三十二：上传取消同步——双方移除进度气泡，接收方 Toast 提示（发送方多端静默移除）
    IMSocket.on(MSG.FILE_CANCEL, function (msg) {
        var meta = {};
        try { meta = JSON.parse(msg.content || '{}'); } catch (e) { meta = {}; }
        var el = null;
        if (meta.upload_id) {
            el = messageList.querySelector('.message[data-upload-id="' + meta.upload_id + '"]');
        }
        if (!el && meta.nonce) {
            el = messageList.querySelector('.message[data-nonce="' + meta.nonce + '"]');
        }
        if (el) el.remove();
        if (msg.from_user !== IMSocket.getUsername()) {
            showToast('对方取消了文件发送');
        }
    });

    // ===== 阶段二十六：群聊图片发送（HTTP 上传 + 服务端广播，不走点对点分片协议） =====
    // 流程：本地立即渲染（blob 预览 + nonce 标识）→ POST /upload/group/image → 服务端落库
    // → 服务端广播 MSG.GROUP_IMAGE（含 msg_id）→ 发送端按 nonce 精确回填 msg_id，其余用户实时渲染
    function sendGroupImage(file) {
        if (!isImageName(file.name)) { showToast('群聊仅支持发送图片'); return; }
        // nonce：本地气泡唯一标识，广播回填 msg_id 时精确匹配（对齐 FILE_PERSISTED 按 file_id 匹配的归口思路，并发发送不错位）
        var nonce = Date.now() + '_' + Math.random().toString(36).slice(2);
        var url = URL.createObjectURL(file);
        var bubble = appendImageMsg(IMSocket.getUsername(), url, 'self', false); // 群聊图片：显示发送者昵称
        bubble.setAttribute('data-nonce', nonce);
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/group/image?username=' + encodeURIComponent(IMSocket.getUsername()) +
              '&nonce=' + encodeURIComponent(nonce), {
            method: 'POST',
            body: fd
        }).then(function (res) {
            // 异常加固：HTTP 4xx/5xx（文件过大/非图片/未在线等）原被静默吞掉，仅网络错误触发 catch，此处统一告警
            if (!res.ok) console.warn('群聊图片上传被拒绝:', res.status);
        }).catch(function (e) {
            // 上传失败仅告警：本地 blob 预览保留，刷新后该消息消失（未落库）属预期降级
            console.warn('群聊图片上传失败（不影响本地预览）:', e);
        });
    }

    // 群聊图片广播：发送端本地气泡按 nonce 回填 msg_id（撤回/删除/置顶能力前提），其余用户实时渲染
    IMSocket.on(MSG.GROUP_IMAGE, function (msg) {
        if (currentChatUser !== '') return; // 不在群聊视图：不渲染（会话摘要已由服务端 CONV_LIST 归口推送）
        // msg_id 去重（并发加固）：多端重复广播、离线补发与广播重叠、
        // 发送端切会话后返回群聊（历史已渲染该图）等场景，防止重复气泡
        // 原实现：无去重，重复投递会渲染重复图片气泡
        if (msg.msg_id && messageList.querySelector('.message[data-msg-id="' + msg.msg_id + '"]')) return;
        var meta = {};
        try { meta = JSON.parse(msg.content); } catch (e) {}
        var isMine = msg.from_user === IMSocket.getUsername();
        if (isMine && meta.nonce) {
            // 发送端：按 nonce 精确匹配本地气泡回填 msg_id（本地 blob 预览已在发送时渲染，不重复渲染）
            // 多端场景：其他设备无带 nonce 的本地气泡，走下方通用渲染分支
            var mineEl = messageList.querySelector('.message.self[data-nonce="' + meta.nonce + '"]');
            if (mineEl) {
                if (msg.msg_id) mineEl.setAttribute('data-msg-id', msg.msg_id);
                if (msg.timestamp) mineEl.setAttribute('data-ts', msg.timestamp);
                return;
            }
        }
        var el = appendImageMsg(msg.from_user, meta.url || '', isMine ? 'self' : 'other', false); // 群聊图片广播：显示发送者昵称
        if (msg.msg_id) el.setAttribute('data-msg-id', msg.msg_id);
        if (msg.timestamp) el.setAttribute('data-ts', msg.timestamp);
    });

    // 文件消息处理：自己收到的是文件头回执（开始上传），对方的是文件头/分片（接收组装）
    IMSocket.on(MSG.FILE, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        if (isMine) {
            // 服务端回执文件头：携带持久化 file_id，开始分片上传
            var task = pendingUploads.shift();
            if (task && msg.chunk_index === -1 && msg.file_id) {
                // 气泡记录 file_id：持久化完成通知按 file_id 精确回填 msg_id（并发发送多文件不错位）
                // 原实现：气泡不记录 file_id，回填依赖"最后一条无 msg_id 的气泡"推测，并发时可能错位
                var mineBubbles = messageList.querySelectorAll('.message.self:not([data-file-id])');
                var mineLast = mineBubbles[mineBubbles.length - 1];
                if (mineLast) mineLast.setAttribute('data-file-id', msg.file_id);
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
            var mediaEl = null;
            if (isImageName(buf.name)) {
                if (visibleUser) mediaEl = appendImageMsg(msg.from_user, url, 'other', true); // 点对点文件传输：私聊不显示昵称
            } else {
                if (visibleUser) mediaEl = appendFileMsg(msg.from_user, buf.name, formatSize(buf.size), url, 'other', true); // 点对点文件传输：私聊不显示昵称
            }
            if (mediaEl) mediaEl.setAttribute('data-file-id', msg.file_id); // 气泡记录 file_id，持久化通知回填 msg_id 用
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
    // dataURL 转 Blob（Electron 静默抓屏结果为 PNG dataURL，编辑器与上传链路均收 Blob/File）
    function dataUrlToBlob(dataUrl) {
        try {
            var arr = dataUrl.split(',');
            var mime = arr[0].match(/:(.*?);/)[1];
            var bin = atob(arr[1]);
            var buf = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            return new Blob([buf], { type: mime });
        } catch (e) {
            return null;
        }
    }

    // 抓屏结果统一进入截图编辑器（编辑器模式，默认全图选区）
    function openShotEditor(blob) {
        if (!blob) { showToast('截图失败'); return; }
        ScreenshotEditor.open(blob, sendScreenshotFile);
    }

    screenshotBtn.addEventListener('click', function () {
        // 原实现：群聊视图拦截提示"群聊暂不支持发送截图"，阶段二十六放开——截图即图片，走群聊 HTTP 上传链路
        // if (currentChatUser === '') { showToast('群聊暂不支持发送截图'); return; }
        // 阶段三十七（第三期）：PC 端 Electron 走主进程静默抓屏（desktopCapturer，不弹系统共享选择框）
        if (window.desktop && window.desktop.captureScreen) {
            window.desktop.captureScreen().then(function (dataUrl) {
                openShotEditor(dataUrlToBlob(dataUrl));
            }).catch(function () {
                showToast('截图失败');
            });
            return;
        }
        // 原实现：浏览器 getDisplayMedia 抓屏（需系统共享弹窗人工选择；PC 端已被静默抓屏替代，此为浏览器回退路径）
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
                // 原实现：截帧后整屏直接发送，无选区与标注能力
                // canvas.toBlob(function (blob) {
                //     if (!blob) { showToast('截图失败'); return; }
                //     var shot = new File([blob], '截图_' + Date.now() + '.png', { type: 'image/png' });
                //     // 阶段二十六：群聊视图截图走 HTTP 上传链路（截图即图片），私聊仍走分片协议
                //     if (currentChatUser === '') sendGroupImage(shot);
                //     else sendFile(shot);
                // }, 'image/png');
                // 阶段三十五·第一期：截帧后进入截图编辑器（选区/矩形/椭圆/箭头/画笔/文字/马赛克/撤销），确认后再发送
                // 原实现：ScreenshotEditor.open(blob, sendScreenshotFile);（编辑器模式，默认全图选区、图像居中缩放）
                // 阶段三十五·第二期：改走伪冻结遮罩（freeze）——画面铺满视口、全屏压暗、拖拽框选后工具栏出现，贴近微信 Alt+A 体验
                // 阶段三十五·第二期（实测反馈调整）：截图按钮改回 open 编辑器模式（窗口式居中缩放，默认全图选区）；
                // freeze 伪冻结遮罩保留为备选入口（window.ScreenshotEditor.freeze 接口不变，需要时换回即可）
                // ScreenshotEditor.freeze(blob, sendScreenshotFile);
                canvas.toBlob(function (blob) {
                    if (!blob) { showToast('截图失败'); return; }
                    ScreenshotEditor.open(blob, sendScreenshotFile);
                }, 'image/png');
            };
        }).catch(function () {
            showToast('已取消截图');
        });
    });

    // ===== 阶段三十五：截图编辑器确认后的统一发送入口（群聊走 HTTP 上传链路，私聊走分片/直传分流） =====
    function sendScreenshotFile(blob) {
        var shot = new File([blob], '截图_' + Date.now() + '.png', { type: 'image/png' });
        if (currentChatUser === '') sendGroupImage(shot);
        else sendFile(shot);
    }

    // ===== 阶段三十四：Ctrl+V 粘贴剪贴板截图（微信式：截图后直接粘贴发送） =====
    // 仅拦截剪贴板中的图片项（文本粘贴不受影响），进入截图编辑器可标注或直接发送
    document.addEventListener('paste', function (e) {
        if (!IMSocket.isConnected()) return; // 未登录不拦截
        if (chatView.classList.contains('hidden')) return; // 登录页不拦截
        if (window.ScreenshotEditor && ScreenshotEditor.isOpen()) return; // 编辑器已打开不重复进入
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf('image/') === 0) {
                var file = items[i].getAsFile();
                if (!file) return;
                e.preventDefault(); // 阻止图片按默认行为插入输入框
                ScreenshotEditor.open(file, sendScreenshotFile);
                return;
            }
        }
    });

    // ===== 阶段三十七（第三期）：Alt+A 全局快捷键抓屏结果（Electron 主进程 globalShortcut 推送） =====
    // 微信同款：任意界面按 Alt+A 静默抓屏进入截图编辑器；未登录丢弃、编辑器已开不重复进入
    if (window.desktop && window.desktop.onGlobalShot) {
        window.desktop.onGlobalShot(function (dataUrl) {
            if (!IMSocket.isConnected()) return; // 未登录不响应
            if (window.ScreenshotEditor && ScreenshotEditor.isOpen()) return; // 编辑器已打开不重复进入
            openShotEditor(dataUrlToBlob(dataUrl));
        });
    }

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
            // 登录持久化：登录成功保存凭据，刷新页面时自动重登保持登录状态
            // window._lastPassword 为本次连接使用的密码（socket.js connect 时记录）
            saveAuth(IMSocket.getUsername(), window._lastPassword || '');
            currentUserEl.textContent = IMSocket.getUsername();
            // 头像缺失修复：从登录响应 JSON 中读取服务端下发的自己头像（服务端归口），
            // 同步更新导航栏头像与消息气泡头像数据源
            // 原代码：无 avatar 解析，导航栏头像登录后为空，消息气泡无头像可用
            try {
                var loginInfo = JSON.parse(msg.content);
                if (loginInfo && loginInfo.avatar) {
                    myAvatar = loginInfo.avatar;
                }
                // 头像降级修复：登录成功后统一刷新左上角头像（新注册账号无头像时显示账号首字母占位）
                // 原实现：仅在有头像时赋值 currentAvatarEl.src，无头像时占位元素未刷新
                setNavAvatar(myAvatar);
                // 阶段三十：登录响应携带完整个人资料，填充"我的个人资料"面板状态（服务端归口）
                if (loginInfo && loginInfo.profile) {
                    myProfile = {
                        nickname: loginInfo.profile.nickname || '',
                        gender: loginInfo.profile.gender || 0,
                        region: loginInfo.profile.region || '',
                        signature: loginInfo.profile.signature || ''
                    };
                }
                // 阶段三十一：同步服务端下发的分片大小（服务端归口，覆盖前端兜底默认值）
                // 原实现：CHUNK_SIZE 恒为前端硬编码 4KB，与服务端 chunk_size 配置脱节
                if (loginInfo && loginInfo.chunk_size > 0) {
                    CHUNK_SIZE = loginInfo.chunk_size;
                }
            } catch (e) {}
            loginView.classList.add('hidden');
            chatView.classList.remove('hidden');
            // 登录持久化联动：自动恢复上次选中的会话（含群聊），并自动加载其聊天记录，
            // 解决刷新后聊天内容为空、必须重新点击聊天对象才能显示的问题
            // 原实现：登录成功后停留在默认空界面
            try {
                var lastChat = localStorage.getItem('im_last_chat_' + IMSocket.getUsername());
                if (lastChat !== null) openConversation(lastChat || '');
            } catch (e) {}
        } else {
            // 登录持久化：登录失败（如密码已被修改）清除已保存凭据，避免刷新后反复自动登录失败，
            // 并从乐观显示的聊天界面回退到登录界面
            clearAuth();
            loginView.classList.remove('hidden');
            chatView.classList.add('hidden');
            showToast('登录失败：' + msg.content);
        }
    });

    // 头像缺失修复：在线用户列表推送（登录/上下线时服务端广播），
    // 记录全部在线用户头像（含自己），群聊发送者不在好友列表时从此处兜底取头像
    IMSocket.on(MSG.USER_LIST, function (msg) {
        var infos = [];
        try { infos = JSON.parse(msg.content) || []; } catch (e) { infos = []; }
        infos.forEach(function (u) {
            if (u && u.username) userAvatars[u.username] = u.avatar || '';
            // 自己头像以 LOGIN_RESP/上传结果为最高优先级，USER_LIST 仅在缺失时兜底
            if (u.username === IMSocket.getUsername()) {
                if (!myAvatar && u.avatar) {
                    myAvatar = u.avatar;
                    setNavAvatar(myAvatar);
                }
            }
        });
    });

    IMSocket.on(MSG.ERROR, function (msg) {
        showToast(msg.content);
    });

    // 好友列表同步
    IMSocket.on(MSG.FRIEND_LIST, function (msg) {
        try { friendList = JSON.parse(msg.content) || []; } catch (e) { friendList = []; }
        renderFriendList();
        // 备注联动：好友列表（含备注）到达后同步刷新会话列表，保证通讯录改备注后会话列表名称即时同步
        renderConvList();
        // 登录持久化联动：好友列表到达后刷新当前会话标题（刷新恢复会话时 FRIEND_LIST 晚于 LOGIN_RESP，
        // 标题先显示账号名，备注名/在线状态就绪后在此同步刷新）
        updateChatTitle();
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
            // 阶段二十三：切换Tab时清空搜索状态（收起结果面板、清空输入与清除按钮），避免残留干扰
            closeSidebarSearch();
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
        // 阶段三十七（第四期）：PC 端托盘未读角标/悬停明细/新消息闪动（数据同源服务端归口未读数）
        updateTrayBadge();
    });

    // ===== 阶段三十七（第四期）：PC 端托盘未读提醒（微信同款：新消息闪动 + 悬停未读数 + 图标数字角标） =====
    var trayBaseIcon = null;  // 托盘底图（懒加载，与 PC 端托盘/exe 同源图标，由 web/img/64.ico 静态提供）
    var lastTrayTotal = -1;   // 上次上报的未读总数（-1 表示从未上报，首次必上报以初始化托盘状态）
    var windowFocused = true; // 窗口聚焦状态（Electron 窗口失焦但可见时 document.hidden 仍为 false，需 focus/blur 辅助判断）

    window.addEventListener('focus', function () { windowFocused = true; });
    window.addEventListener('blur', function () { windowFocused = false; });

    // 懒加载托盘底图（加载完成后补一次上报，确保角标立即可用；Web 浏览器端无桌面能力直接跳过）
    if (window.desktop && window.desktop.setUnread) {
        var trayIconImg = new Image();
        trayIconImg.onload = function () {
            trayBaseIcon = trayIconImg;
            updateTrayBadge();
        };
        trayIconImg.src = '/img/64.ico';
    }

    // 合成托盘角标图标：底图 + 右下角红色圆点数字（>99 显示 99+），微信同款视觉
    function buildTrayIconDataUrl(total) {
        if (!trayBaseIcon) return '';
        var cv = document.createElement('canvas');
        cv.width = 64;
        cv.height = 64;
        var ctx = cv.getContext('2d');
        ctx.drawImage(trayBaseIcon, 0, 0, 64, 64);
        if (total > 0) {
            var label = total > 99 ? '99+' : String(total);
            ctx.fillStyle = '#fa5151';
            ctx.beginPath();
            ctx.arc(50, 50, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold ' + (total > 99 ? 11 : 15) + 'px Microsoft YaHei';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, 50, 51);
        }
        return cv.toDataURL('image/png');
    }

    // 上报未读汇总到主进程（托盘角标 + 悬停明细 + 预览面板列表），总数增加时按需触发闪动；返回当前总数
    function updateTrayBadge() {
        if (!(window.desktop && window.desktop.setUnread)) return 0;
        var total = 0;
        var parts = [];
        var list = [];
        convList.forEach(function (cv) {
            if (cv.unread <= 0) return;
            total += cv.unread;
            // 会话名与列表同口径：群聊/好友备注优先，无备注回退用户名
            var name = cv.target === '' ? '群聊' : cv.target;
            if (cv.target !== '') {
                var convFriend = friendList.find(function (x) { return x.username === cv.target; });
                if (convFriend && convFriend.remark) name = convFriend.remark;
            }
            if (parts.length < 3) parts.push(name + '(' + cv.unread + ')');
            // 预览面板明细（最多 5 条）：名称/最后消息摘要/未读数/头像（服务端头像优先，缺失面板内回退首字母）
            if (list.length < 5) {
                list.push({
                    target: cv.target,
                    name: name,
                    last: cv.last_msg || '',
                    unread: cv.unread,
                    avatar: cv.target !== '' ? (userAvatars[cv.target] || '') : ''
                });
            }
        });
        if (parts.length > 3) parts.push('…');
        var increased = total > lastTrayTotal && lastTrayTotal >= 0; // 总数增加=收到新消息（聚焦+当前会话时服务端已读归零，不会误闪）
        lastTrayTotal = total;
        window.desktop.setUnread({
            total: total,
            detail: parts.join(' '),
            icon: buildTrayIconDataUrl(total),
            list: list
        });
        // 新消息且窗口未聚焦/被隐藏 → 托盘闪动；聚焦状态下仅更新角标，不打扰
        if (increased && (document.hidden || !windowFocused)) {
            window.desktop.flashTray();
        }
        return total;
    }

    // 托盘预览面板条目点击跳转（主进程转发 target）：恢复窗口并打开对应会话
    if (window.desktop && window.desktop.onOpenConv) {
        window.desktop.onOpenConv(function (target) {
            openConversation(target);
        });
    }


    function renderConvList() {
        // 阶段二十三：微信风格导航栏聊天图标未读角标（服务端归口，与会话列表同源汇总）
        var navBadge = document.getElementById('nav-chat-badge');
        if (navBadge) {
            var navTotal = 0;
            convList.forEach(function (cv) { navTotal += (cv.unread > 0 ? cv.unread : 0); });
            if (navTotal > 0) {
                navBadge.textContent = navTotal > 99 ? '99+' : navTotal;
                navBadge.classList.remove('hidden');
            } else {
                navBadge.classList.add('hidden');
                navBadge.textContent = ''; // 归零时同步清空文本，避免隐藏态残留旧数字
            }
        }
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
            // 原实现：var convName = isGroup ? '群聊' : cv.target; 会话列表只显示用户名，通讯录修改备注后不同步
            // 修复：与通讯录/聊天标题同口径——好友备注优先显示，无备注回退用户名
            var convName = isGroup ? '群聊' : cv.target;
            if (!isGroup) {
                var convFriend = friendList.find(function (x) { return x.username === cv.target; });
                if (convFriend && convFriend.remark) convName = convFriend.remark;
            }
            var li = document.createElement('li');
            li.className = 'conv-item' + (cv.pinned ? ' pinned' : '');
            if (currentChatUser === cv.target) li.classList.add('active');
            li.setAttribute('data-user', cv.target);

            // 会话头像：有头像显示图片（失效降级首字母），无头像显示首字母占位，群聊显示"群"字
            // 原实现：avatar.textContent = convName.charAt(0).toUpperCase(); 会话头像一律首字母占位，从不显示真实头像
            // avatar.textContent = convName.charAt(0).toUpperCase();
            var avatarUrl = isGroup ? '' : getAvatarUrl(cv.target);
            var avatar = document.createElement('div');
            avatar.className = 'conv-avatar';
            if (avatarUrl) {
                var avatarImg = document.createElement('img');
                avatarImg.src = avatarUrl;
                avatarImg.alt = '';
                // 头像文件失效（文件被清理/路径变更）时降级为首字母占位，避免破图
                avatarImg.addEventListener('error', function () {
                    avatarImg.remove();
                    avatar.textContent = convName.charAt(0).toUpperCase();
                });
                avatar.appendChild(avatarImg);
            } else {
                avatar.textContent = convName.charAt(0).toUpperCase();
            }

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
                // 设置备注项仅好友可见（群聊/陌生人无备注概念），右键时动态显隐
                var remarkItem = convMenu.querySelector('[data-action="remark"]');
                var convIsFriend = friendList.some(function (x) { return x.username === cv.target; });
                remarkItem.classList.toggle('hidden', !convIsFriend);
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
    // 设置备注：复用 FRIEND_UPDATE 通道（与通讯录右键菜单/资料卡同口径），仅好友可用（右键时已动态显隐，此处兜底校验）
    convMenu.querySelector('[data-action="remark"]').addEventListener('click', function () {
        convMenu.classList.add('hidden');
        var isFriend = friendList.some(function (x) { return x.username === convTarget; });
        if (!isFriend) {
            showToast('仅好友可设置备注');
            return;
        }
        showPrompt('设置备注', '请输入好友备注名', function (remark) {
            IMSocket.send({ msg_type: MSG.FRIEND_UPDATE, to_user: convTarget, remark: remark });
        });
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

    // ===== 好友申请（阶段二十九：微信式"新的朋友"归口） =====
    var processedRequests = {}; // 已处理的申请 ID，用于去重
    // 原实现：收到申请直接弹 showConfirm 确认弹窗（同意/拒绝），
    // 缺陷：弹窗可被随手关闭或被后续申请覆盖，关闭后申请无处可寻，导致对方以为申请丢失
    // IMSocket.on(MSG.FRIEND_REQUEST, function (msg) {
    //     if (msg.msg_id) {
    //         if (processedRequests[msg.msg_id]) return;
    //         processedRequests[msg.msg_id] = true;
    //     }
    //     showConfirm('好友申请', msg.from_user + ' 请求添加你为好友，是否同意？', function () {
    //         IMSocket.send({
    //             msg_type: MSG.FRIEND_REQUEST_RESP,
    //             to_user: msg.from_user,
    //             content: 'agree'
    //         });
    //     }, '同意', '拒绝');
    // });
    IMSocket.on(MSG.FRIEND_REQUEST, function (msg) {
        // 依据申请记录 ID 去重（实时推送与登录补发可能重复）
        if (msg.msg_id) {
            if (processedRequests[msg.msg_id]) return;
            processedRequests[msg.msg_id] = true;
        }
        // 微信式轻提醒：Toast 提示 + "新的朋友"红点角标，申请进入列表随时可处理，不再弹确认框
        showToast(msg.from_user + ' 请求添加你为好友');
        refreshFriendReqList();
    });

    // 拉取好友申请列表（服务端归口：角标=待处理数量，列表=全部申请记录），300ms 防抖合并登录补发的连续多条
    function refreshFriendReqList() {
        clearTimeout(friendReqListTimer);
        friendReqListTimer = setTimeout(function () {
            IMSocket.send({ msg_type: MSG.FRIEND_REQ_LIST });
        }, 300);
    }

    // 申请列表响应：更新角标，面板打开时同步渲染列表
    IMSocket.on(MSG.FRIEND_REQ_LIST_RESP, function (msg) {
        var data;
        try { data = JSON.parse(msg.content); } catch (e) { data = null; }
        if (!data) return;
        var pending = data.pending || 0;
        // 双角标同步：通讯录导航图标（微信同款）与好友面板"新的朋友"入口条
        var badgeText = pending > 0 ? (pending > 99 ? '99+' : String(pending)) : '';
        [newFriendsBadge, navFriendsBadge].forEach(function (el) {
            if (!el) return;
            if (badgeText) {
                el.textContent = badgeText;
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
                el.textContent = '';
            }
        });
        if (newFriendsPanel.classList.contains('hidden')) return; // 面板未打开时仅更新角标
        renderFriendReqList(data.list || []);
    });

    // 渲染"新的朋友"申请列表（头像/用户名/验证消息/时间/状态或同意拒绝按钮）
    function renderFriendReqList(list) {
        if (!list.length) {
            newFriendsListEl.innerHTML = '<div class="new-friends-empty">暂无好友申请</div>';
            return;
        }
        var html = '';
        list.forEach(function (r) {
            // 头像降级统一：无头像显示首字母占位（原为空白方块）
            // 原实现：'<div class="avatar placeholder"></div>'
            var avatarHtml = r.avatar
                ? '<img class="avatar" src="' + r.avatar + '" alt="">'
                : '<div class="avatar placeholder">' + (r.from_user || '?').charAt(0).toUpperCase() + '</div>';
            var right = '';
            if (r.status === 0) {
                right = '<button class="req-btn primary" data-req-from="' + r.from_user + '" data-req-act="agree">同意</button>'
                      + '<button class="req-btn" data-req-from="' + r.from_user + '" data-req-act="reject">拒绝</button>';
            } else if (r.status === 1) {
                right = '<span class="req-status">已同意</span>';
            } else {
                right = '<span class="req-status">已拒绝</span>';
            }
            var timeStr = r.create_time ? new Date(r.create_time * 1000).toLocaleString() : '';
            html += '<div class="req-item">' + avatarHtml
                + '<div class="req-info"><div class="req-name">' + r.from_user + '</div>'
                + '<div class="req-msg">' + (r.message || '请求添加你为好友') + (timeStr ? ' · ' + timeStr : '') + '</div></div>'
                + '<div class="req-actions">' + right + '</div></div>';
        });
        newFriendsListEl.innerHTML = html;
        newFriendsListEl.querySelectorAll('.req-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                IMSocket.send({
                    msg_type: MSG.FRIEND_REQUEST_RESP,
                    to_user: this.getAttribute('data-req-from'),
                    content: this.getAttribute('data-req-act') === 'agree' ? 'agree' : 'reject'
                });
                // 处理后刷新自身申请列表与角标（服务端归口，pending 递减、行内状态更新）
                refreshFriendReqList();
            });
        });
    }

    // 入口点击：复用好友 Tab 切换逻辑后打开申请面板并拉取最新列表
    newFriendsEntry.addEventListener('click', function () {
        var friendsTab = document.querySelector('.sidebar-tab[data-tab="friends"]');
        if (friendsTab && !friendsTab.classList.contains('active')) friendsTab.click();
        newFriendsPanel.classList.remove('hidden');
        newFriendsListEl.innerHTML = '<div class="new-friends-empty">加载中...</div>';
        IMSocket.send({ msg_type: MSG.FRIEND_REQ_LIST });
    });
    newFriendsClose.addEventListener('click', function () {
        newFriendsPanel.classList.add('hidden');
    });

    // 申请方收到处理结果同步：微信式"对方已同意/拒绝你的好友申请"提示（多端同步由服务端归口推送）
    IMSocket.on(MSG.FRIEND_REQUEST_RESP, function (msg) {
        if (msg.from_user === IMSocket.getUsername()) return; // 过滤本端回显
        showToast(msg.from_user + (msg.content === 'agree' ? ' 已同意你的好友申请' : ' 已拒绝你的好友申请'));
    });

    // 上下线通知：更新好友在线状态
    IMSocket.on(MSG.ONLINE, function (msg) {
        var f = friendList.find(function (x) { return x.username === msg.from_user; });
        if (f) {
            f.online = (msg.content === 'online');
            renderFriendList();
        }
        // 阶段二十七：归属校验——上下线提示仅群聊视图显示全部成员，私聊视图仅显示会话对方，
        // 原实现：无校验，任何人的上下线提示都渲染进当前打开的无关会话，切换会话后提示消失（串窗）
        if (currentChatUser !== '' && msg.from_user !== currentChatUser) return;
        appendSystem(msg.from_user + (msg.content === 'online' ? ' 上线了' : ' 下线了'));
    });

    // 群聊/私聊消息
    IMSocket.on(MSG.GROUP_CHAT, function (msg) {
        // 阶段二十七：归属校验——群聊消息仅在群聊视图渲染（与 GROUP_IMAGE 处理口径一致），
        // 原实现：无校验，私聊视图打开时收到的群聊消息被串入当前窗口，切换会话后"消失"
        if (currentChatUser !== '') return;
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
    var locateState = { active: false, msgId: 0, page: 1, maxPage: 50, src: 'search' }; // 会话内搜索定位翻页状态（src：定位来源 pin=置顶条/search=搜索结果）
    // 阶段二十七：向上滚动加载更多历史（对齐微信体验）
    // 原实现：切换会话仅加载最近 20 条且无向上翻页机制，实时/离线补发累积超过 20 条的消息
    // 在切换会话再切回后窗口按"最近 20 条"重渲染，更早内容从窗口消失且无法再查看（用户反馈"聊天记录没了"）
    var PAGE_SIZE = 20;      // 每页历史条数（与服务端分页默认一致）
    var historyPage = 1;     // 当前会话已加载到的最大页码
    var historyHasMore = true;  // 是否还有更早的历史可加载
    var loadingMore = false;    // 翻页请求进行中标记（防止滚动重复触发）

    // 切换会话：设置目标、清空显示、加载历史
    function openConversation(user) {
        currentChatUser = user;
        // 登录持久化联动：记录最近选中会话（key 按用户名隔离，多账号互不干扰），刷新自动登录后恢复该会话
        try { localStorage.setItem('im_last_chat_' + IMSocket.getUsername(), user); } catch (e) {}
        // 原实现：if (currentChatUser !== '') unreadCount[currentChatUser] = 0; 本地计数清零
        // 未读数服务端归口：本地乐观清零会话列表未读角标，服务端处理已读回执后推送 CONV_LIST 归口确认
        if (currentChatUser !== '') {
            var conv = null;
            for (var ci = 0; ci < convList.length; ci++) {
                if (convList[ci].target === currentChatUser) { conv = convList[ci]; break; }
            }
            if (conv && conv.unread > 0) conv.unread = 0;
        }
        updateChatTitle();
        // 切换会话后无条件重渲染两个列表，保证选中高亮跟随点击切换
        // 原实现：renderConvList 仅在该会话有未读时调用（unread>0 分支内），点击无未读的好友时会话列表 active 停留在上一个会话
        // if (conv && conv.unread > 0) { conv.unread = 0; renderConvList(); renderFriendList(); }
        // renderFriendList();
        renderConvList();
        renderFriendList();
        // 切换会话：重置定位状态、关闭搜索浮层、刷新置顶条
        locateState.active = false;
        closeConvSearch();
        messageList.innerHTML = '';
        renderPinBar();
        // 阶段二十七：切换会话重置滚动分页状态（重新从第 1 页加载）
        historyPage = 1;
        historyHasMore = true;
        loadingMore = false;
        loadHistory();
    }

    function loadHistory() {
        historyTarget = currentChatUser;
        var msg = { msg_type: MSG.HISTORY, page: 1, page_size: PAGE_SIZE };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        IMSocket.send(msg);
    }

    // 阶段二十七：滚动到顶部自动加载更早的历史消息（prepend 渲染并保持滚动位置不跳动）
    // 原实现：无滚动加载机制，窗口内只有最近 20 条，更早记录无法查看
    messageList.addEventListener('scroll', function () {
        if (locateState.active || loadingMore || !historyHasMore) return; // 定位翻页中/请求中/无更多：不触发
        if (messageList.scrollTop > 60) return; // 未滚动到顶部附近
        if (messageList.scrollHeight <= messageList.clientHeight) return; // 内容未撑满一屏时不触发
        loadingMore = true;
        var msg = { msg_type: MSG.HISTORY, page: historyPage + 1, page_size: PAGE_SIZE };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        IMSocket.send(msg);
    });

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

        // 阶段二十七：向上滚动翻页（page>1）：prepend 渲染更早消息并保持滚动位置
        if (msg.page > 1) {
            loadingMore = false;
            historyPage = msg.page;
            // 返回条数不足一页说明已到最早记录，停止继续向上加载
            historyHasMore = records.length >= msg.page_size;
            if (!records.length) return; // 已到最早记录（边界兜底）
            var prevHeight = messageList.scrollHeight;
            // 服务端按 ID 倒序返回（新→旧），依次插到列表最前，保持时间正序
            records.forEach(function (r) { renderHistoryRecord(r, messageList.firstChild); });
            // 用高度差补偿滚动位置，避免 prepend 后视口跳动
            messageList.scrollTop = messageList.scrollHeight - prevHeight;
            return;
        }

        // 服务端按 ID 倒序返回，正序渲染
        records.reverse().forEach(function (r) { renderHistoryRecord(r); });
        // 阶段二十七：首页返回不足一页说明全部记录已加载完
        historyHasMore = records.length >= msg.page_size;

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
        // 阶段二十四：图片消息(4)/文件消息(5)持久化渲染（content 为 JSON：url/name/size）
        if (r.msg_type === 4 || r.msg_type === 5) {
            // 贴底快照在插入前采样：向上补插历史（beforeEl）不参与滚底；追加场景按当前是否贴底决定
            var mediaDiv = createMediaMessageEl(r, isMine, ts, isPrivate, isRead, !beforeEl && isNearBottom());
            if (beforeEl) {
                messageList.insertBefore(mediaDiv, beforeEl);
            } else {
                messageList.appendChild(mediaDiv);
                messageList.scrollTop = messageList.scrollHeight;
            }
            return;
        }
        var div = createMessageEl(r.from_user, r.content, isMine ? 'self' : 'other', r.id, ts, isPrivate, isRead);
        if (beforeEl) {
            messageList.insertBefore(div, beforeEl);
        } else {
            messageList.appendChild(div);
            messageList.scrollTop = messageList.scrollHeight;
        }
    }

    // 阶段二十四：构建图片/文件历史消息元素（元数据与文字消息一致：msg-id/from/ts/已读状态，供撤回、定位复用）
    // stickBottom：贴底快照由调用方在插入前采样（向上插入历史时为 false，不参与滚底）
    function createMediaMessageEl(r, isMine, ts, isPrivate, isRead, stickBottom) {
        var type = isMine ? 'self' : 'other';
        var meta = {};
        try { meta = JSON.parse(r.content); } catch (e) { meta = {}; }
        var div = document.createElement('div');
        div.className = 'message ' + type;
        if (r.id) div.setAttribute('data-msg-id', r.id);
        div.setAttribute('data-from', r.from_user);
        if (ts) div.setAttribute('data-ts', ts);
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = r.from_user;
        // 头像缺失修复：与文字消息一致，头像 + 内容列（昵称/气泡/状态）微信风格结构
        // 原代码：div.appendChild(nameEl); 平铺在 .message 下，无头像
        var body = document.createElement('div');
        body.className = 'message-body';
        // 私聊窗口标题已显示对方名称，气泡内昵称冗余，仅群聊显示发送者昵称
        // 原实现：body.appendChild(nameEl);
        // body.appendChild(nameEl);
        if (!isPrivate) body.appendChild(nameEl);
        if (r.msg_type === 4) {
            // 图片消息：URL 直出，点击查看大图
            var bubbleImg = document.createElement('div');
            bubbleImg.className = 'message-bubble bubble-image';
            var img = document.createElement('img');
            img.className = 'chat-image';
            img.src = meta.url || '';
            // 图片显示一半修复（与实时渲染一致）：按调用方插入前的贴底快照决定加载撑高后是否滚底
            // 原实现：load 回调内实时 isNearBottom() 判定——列表已被撑高导致误判，已废弃
            // img.addEventListener('load', function () {
            //     if (isNearBottom()) messageList.scrollTop = messageList.scrollHeight;
            // });
            img.addEventListener('load', function () {
                if (stickBottom) messageList.scrollTop = messageList.scrollHeight;
            });
            img.addEventListener('click', function () {
                // 原实现：window.open(meta.url, '_blank') 弹裸图片窗口
                // 阶段三十八：历史图片消息统一走图片查看器（与实时气泡一致）
                openImageViewer(meta.url || '');
            });
            bubbleImg.appendChild(img);
            body.appendChild(bubbleImg);
        } else {
            // 文件消息：文件卡片（图标+文件名+大小），点击下载
            var bubbleFile = document.createElement('div');
            bubbleFile.className = 'message-bubble bubble-file';
            var icon = document.createElement('div');
            icon.className = 'file-icon';
            icon.textContent = '📄';
            var info = document.createElement('div');
            info.className = 'file-info';
            var fileName = document.createElement('div');
            fileName.className = 'file-name';
            fileName.textContent = meta.name || '未命名文件';
            var fileSize = document.createElement('div');
            fileSize.className = 'file-size';
            fileSize.textContent = formatSize(meta.size || 0);
            info.appendChild(fileName);
            info.appendChild(fileSize);
            bubbleFile.appendChild(icon);
            bubbleFile.appendChild(info);
            if (meta.url) {
                bubbleFile.style.cursor = 'pointer';
                bubbleFile.addEventListener('click', function () {
                    var a = document.createElement('a');
                    a.href = meta.url;
                    a.download = meta.name || 'file';
                    a.click();
                });
            }
            body.appendChild(bubbleFile);
        }
        // 自己发送的私聊消息显示已读/未读状态（与文字消息一致）
        if (isMine && isPrivate && r.id) {
            var status = document.createElement('div');
            status.className = 'msg-status' + (isRead ? ' read' : '');
            status.setAttribute('data-msg-id', r.id);
            status.textContent = isRead ? '已读' : '未读';
            body.appendChild(status);
        }
        // 头像缺失修复：头像在左（他人）/右（自己）
        div.appendChild(getAvatarEl(r.from_user));
        div.appendChild(body);
        return div;
    }

    // ===== 会话内搜索定位：向前翻页加载直到找到目标消息 =====
    // 阶段十六增强：locateState.src 区分定位来源（pin=置顶条/search=搜索结果），未找到时按来源给出精确原因提示
    // 原实现：未找到一律提示"未找到该消息"，置顶条场景下无法区分"原消息已删除/不可见"与"超出加载范围"
    function handleLocatePage(records) {
        if (!locateState.active) return;
        // 阶段二十七：定位翻页与滚动翻页共用历史页码——定位已加载的页数计入 historyPage，
        // 防止定位加载过早期数后，向上滚动又从旧页码重复请求造成消息重复渲染
        if (locateState.page > historyPage) historyPage = locateState.page;
        // 无更多历史仍未找到：停止定位
        if (!records.length) {
            locateState.active = false;
            historyHasMore = false; // 阶段二十七：服务端已无更早记录，滚动翻页同步停止
            // 历史接口排除已撤回与自己删除的消息：置顶条定位翻完仍无，多为原消息已被自己删除或已撤回
            showToast(locateState.src === 'pin' ? '原消息已删除或不可见' : '未找到该消息');
            return;
        }
        // 返回条数不足一页：说明已翻到最早记录，滚动翻页同步停止
        if (records.length < PAGE_SIZE) historyHasMore = false;
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
            showToast(locateState.src === 'pin' ? '原消息超出可加载范围，未能定位' : '未找到该消息（超出可加载范围）');
            return;
        }
        var msg = { msg_type: MSG.HISTORY, page: locateState.page, page_size: PAGE_SIZE };
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
                    // 消息尚未加载：从第 2 页起向前翻页查找（第 1 页已渲染），标记来源为搜索结果
                    locateState.active = true;
                    locateState.msgId = r.id;
                    locateState.page = 1;
                    locateState.src = 'search'; // 阶段十六增强：标记定位来源，未找到时提示精确原因
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

    // 阶段十五增强：点击置顶条定位原消息，复用会话内搜索的定位高亮机制
    // 消息已在窗口内直接高亮，未加载则向前翻页查找；原消息不可见时由翻页上限兜底提示
    // 原实现：置顶条仅展示内容，点击无响应
    pinBarMain.addEventListener('click', function () {
        var info = pinInfo[currentChatUser];
        if (!info || !info.msg_id) return;
        var el = messageList.querySelector('.message[data-msg-id="' + info.msg_id + '"]');
        if (el) {
            // 消息已在窗口中：直接定位高亮
            highlightMessage(el);
            return;
        }
        // 消息尚未加载：从第 2 页起向前翻页查找（第 1 页已渲染），标记来源为置顶条
        locateState.active = true;
        locateState.msgId = info.msg_id;
        locateState.page = 1;
        locateState.src = 'pin'; // 阶段十六增强：标记定位来源，未找到时提示精确原因
        loadNextLocatePage();
    });

    // ===== 关键词搜索：输入时本地过滤联系人（用户名/备注），回车/放大镜搜索聊天记录，结果面板分区展示 =====
    var searchInput = document.getElementById('search-input');
    var searchClearBtn = document.getElementById('search-clear-btn');
    var searchPanel = document.getElementById('search-panel');
    var searchIconBtn = document.getElementById('search-icon-btn');
    var lastSearchRecords = null; // 最近一次服务端聊天记录搜索结果（null=本次尚未搜索，[]=搜索无结果）

    // 阶段二十三：收起侧栏搜索状态（Tab切换/关闭结果共用）
    function closeSidebarSearch() {
        searchPanel.classList.add('hidden');
        searchPanel.innerHTML = '';
        searchClearBtn.classList.add('hidden');
        searchInput.value = '';
        lastSearchRecords = null; // 原实现：无此重置，收起后重开面板仍显示上次聊天记录结果
    }

    // 联系人本地过滤：匹配用户名/备注（不区分大小写），数据源为登录后服务端下发的好友列表（USER_LIST）
    function filterContacts(keyword) {
        var kw = keyword.toLowerCase();
        return friendList.filter(function (f) {
            return (f.username && f.username.toLowerCase().indexOf(kw) !== -1) ||
                   (f.remark && f.remark.toLowerCase().indexOf(kw) !== -1);
        });
    }

    // 构建联系人搜索结果项：头像（失效降级首字母）+ 显示名（备注优先）+ 用户名/在线状态，点击打开会话
    function buildContactItem(f) {
        var item = document.createElement('div');
        item.className = 'search-contact';
        var displayName = f.remark || f.username;
        var avatar = document.createElement('div');
        avatar.className = 'search-contact-avatar';
        var avatarUrl = f.username ? getAvatarUrl(f.username) : '';
        if (avatarUrl) {
            var img = document.createElement('img');
            img.src = avatarUrl;
            img.alt = '';
            // 头像文件失效时降级为首字母占位，避免破图（与会话列表同口径）
            img.addEventListener('error', function () {
                img.remove();
                avatar.textContent = displayName.charAt(0).toUpperCase();
            });
            avatar.appendChild(img);
        } else {
            avatar.textContent = displayName.charAt(0).toUpperCase();
        }
        var main = document.createElement('div');
        main.className = 'search-contact-main';
        var nameEl = document.createElement('div');
        nameEl.className = 'search-contact-name';
        nameEl.textContent = displayName;
        main.appendChild(nameEl);
        // 副标题：好友显示用户名与在线状态；群聊项无用户名，不显示副标题
        if (f.username) {
            var subEl = document.createElement('div');
            subEl.className = 'search-contact-sub';
            subEl.textContent = f.username + (f.online ? ' · 在线' : '');
            main.appendChild(subEl);
        }
        item.appendChild(avatar);
        item.appendChild(main);
        item.addEventListener('click', function () {
            // 群聊项 username 为空，openConversation('') 即打开群聊会话（与会话列表口径一致）
            openConversation(f.username);
            searchPanel.classList.add('hidden');
            searchClearBtn.classList.add('hidden');
        });
        return item;
    }

    // 统一渲染搜索面板：联系人分区（本地实时过滤）+ 群聊分区 + 聊天记录分区（服务端搜索结果）
    function renderSearchPanel() {
        var keyword = searchInput.value.trim();
        searchPanel.innerHTML = '';
        if (!keyword) {
            searchPanel.classList.add('hidden');
            searchClearBtn.classList.add('hidden');
            return;
        }
        searchPanel.classList.remove('hidden');
        searchClearBtn.classList.remove('hidden');

        // 联系人分区：好友用户名/备注模糊匹配，输入即时过滤
        var contacts = filterContacts(keyword);
        var contactTitle = document.createElement('div');
        contactTitle.className = 'search-title';
        contactTitle.textContent = '联系人 (' + contacts.length + ')';
        searchPanel.appendChild(contactTitle);
        if (contacts.length === 0) {
            var emptyContact = document.createElement('div');
            emptyContact.className = 'search-empty';
            emptyContact.textContent = '暂无匹配的联系人';
            searchPanel.appendChild(emptyContact);
        } else {
            contacts.forEach(function (f) {
                searchPanel.appendChild(buildContactItem(f));
            });
        }

        // 群聊分区：会话列表存在群聊会话（target 为空）且关键词与「群聊」匹配时展示
        // 原实现：搜索面板仅展示聊天记录，无联系人/群聊分区
        var hasGroupConv = convList.some(function (cv) { return cv.target === ''; });
        if (hasGroupConv && '群聊'.indexOf(keyword) !== -1) {
            var groupTitle = document.createElement('div');
            groupTitle.className = 'search-title';
            groupTitle.textContent = '群聊';
            searchPanel.appendChild(groupTitle);
            searchPanel.appendChild(buildContactItem({ username: '', remark: '群聊', online: false }));
        }

        // 聊天记录分区：回车/放大镜触发服务端搜索（MSG.SEARCH）后展示，未搜索时给出操作提示
        var msgTitle = document.createElement('div');
        msgTitle.className = 'search-title';
        searchPanel.appendChild(msgTitle);
        if (lastSearchRecords === null) {
            msgTitle.textContent = '聊天记录（回车搜索）';
        } else {
            msgTitle.textContent = '聊天记录 (' + lastSearchRecords.length + ')';
            if (lastSearchRecords.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'search-empty';
                empty.textContent = '暂无匹配的聊天记录';
                searchPanel.appendChild(empty);
            }
            lastSearchRecords.forEach(function (r) {
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
        }
    }

    function sendSidebarSearch() {
        var keyword = searchInput.value.trim();
        if (!keyword) return;
        IMSocket.send({ msg_type: MSG.SEARCH, content: keyword });
    }

    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            sendSidebarSearch();
        } else if (e.key === 'Escape') {
            // 阶段二十三：Esc 关闭搜索结果（输入框聚焦时优先作用于搜索）
            closeSidebarSearch();
        }
    });

    // 阶段二十三：点击放大镜图标触发搜索（等价回车）
    searchIconBtn.addEventListener('click', sendSidebarSearch);

    // 输入即搜：联系人本地实时过滤，聊天记录分区保持上次服务端结果
    // 原实现：input 事件仅切换清除按钮显隐，回车后面板才显示
    searchInput.addEventListener('input', function () {
        renderSearchPanel();
    });

    searchClearBtn.addEventListener('click', function () {
        closeSidebarSearch();
        searchInput.focus();
    });

    IMSocket.on(MSG.SEARCH_RESP, function (msg) {
        var records = [];
        try { records = JSON.parse(msg.content) || []; } catch (err) {}
        lastSearchRecords = records; // 原实现：收到响应直接重渲染面板，现交由 renderSearchPanel 统一分区渲染
        renderSearchPanel();
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
            // 头像降级统一：有头像显示图片，无头像显示首字母占位（原为空白方块）
            // 原实现：var avatarHtml = f.avatar ? '<img class="avatar" src="' + f.avatar + '" alt="">' : '<div class="avatar placeholder"></div>';
            var avatarHtml = f.avatar
                ? '<img class="avatar" src="' + f.avatar + '" alt="">'
                : '<div class="avatar placeholder">' + displayName.charAt(0).toUpperCase() + '</div>';
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
            // 阶段三十：点击好友列表头像弹出微信式资料卡（群聊条目除外）
            var target = item.getAttribute('data-user');
            var avatarNode = item.querySelector('.avatar');
            if (target && avatarNode) {
                avatarNode.style.cursor = 'pointer';
                avatarNode.addEventListener('click', function (e) {
                    e.stopPropagation(); // 阻止触发整行的打开会话
                    openFriendCard(target);
                });
            }
            // 好友右键菜单（群聊不显示）
            if (target !== '') {
                item.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    menuTarget = target;
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
    // 头像缺失修复：按用户名解析头像 URL（空字符串表示无头像）
    // 优先级：自己（LOGIN_RESP/上传成功下发） > 好友列表（FRIEND_LIST 携带 avatar） > 在线用户表（USER_LIST 推送）
    // 会话列表/好友列表/消息气泡共用同一解析归口，头像数据更新后各处渲染口径一致
    function getAvatarUrl(name) {
        if (name === IMSocket.getUsername()) {
            if (myAvatar) return myAvatar;
        }
        for (var i = 0; i < friendList.length; i++) {
            if (friendList[i].username === name) return friendList[i].avatar || '';
        }
        return userAvatars[name] || '';
    }

    // 头像缺失修复：按发送者解析头像并构建头像元素（返回 DOM 节点）
    // 优先级：自己（LOGIN_RESP/上传成功下发） > 好友列表（FRIEND_LIST 携带 avatar） > 在线用户表（USER_LIST 推送） > 首字母占位
    // 原实现：解析逻辑内联于此，会话列表无法复用（会话列表头像长期为首字母占位）
    function getAvatarEl(fromUser) {
        var url = getAvatarUrl(fromUser);
        // 原实现：解析逻辑内联
        // var url = '';
        // if (fromUser === IMSocket.getUsername()) {
        //     url = myAvatar;
        // }
        // if (!url) {
        //     for (var i = 0; i < friendList.length; i++) {
        //         if (friendList[i].username === fromUser) { url = friendList[i].avatar || ''; break; }
        //     }
        // }
        // if (!url) url = userAvatars[fromUser] || '';
        if (url) {
            var img = document.createElement('img');
            img.className = 'msg-avatar';
            img.src = url;
            img.alt = '';
            // 头像文件失效（文件被清理/路径变更）时降级为首字母占位，避免破图
            img.addEventListener('error', function () {
                img.replaceWith(buildAvatarPlaceholder(fromUser));
            });
            // 阶段三十：点击消息气泡头像弹出微信式资料卡（点自己头像打开个人资料面板）
            img.style.cursor = 'pointer';
            img.addEventListener('click', function () {
                openFriendCard(fromUser);
            });
            return img;
        }
        return buildAvatarPlaceholder(fromUser);
    }

    // 首字母占位头像（与会话列表 conv-avatar 同风格，跟随主题色）
    function buildAvatarPlaceholder(fromUser) {
        var ph = document.createElement('div');
        ph.className = 'msg-avatar placeholder';
        ph.textContent = (fromUser || '?').charAt(0).toUpperCase();
        // 阶段三十：占位头像同样可点击弹出资料卡
        ph.style.cursor = 'pointer';
        ph.addEventListener('click', function () {
            openFriendCard(fromUser);
        });
        return ph;
    }

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
        // 头像缺失修复：改为微信风格结构——头像 + 内容列（昵称/气泡/状态），
        // 头像在左（他人）/右（自己），由 CSS flex 与 flex-direction:row-reverse 控制
        // 原代码：div.appendChild(nameEl); div.appendChild(bubble); 平铺在 .message 下，无头像
        var body = document.createElement('div');
        body.className = 'message-body';
        // 私聊窗口标题已显示对方名称，气泡内昵称冗余，仅群聊显示发送者昵称
        // （第 6 参 showReadStatus 实际传入的是 isPrivate：私聊 true / 群聊 false）
        // 原实现：body.appendChild(nameEl); 私聊/群聊气泡一律显示发送者昵称
        // body.appendChild(nameEl);
        if (!showReadStatus) body.appendChild(nameEl);
        body.appendChild(bubble);
        // 自己发送的私聊消息显示已读/未读状态
        if (showReadStatus && type === 'self' && msgId) {
            var status = document.createElement('div');
            status.className = 'msg-status' + (isRead ? ' read' : '');
            status.setAttribute('data-msg-id', msgId);
            status.textContent = isRead ? '已读' : '未读';
            body.appendChild(status);
        }
        div.appendChild(getAvatarEl(fromUser));
        div.appendChild(body);
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
    // 判断消息列表是否接近底部（容差 80px）：图片异步加载撑高后决定是否跟随滚底，
    // 用户正在翻看历史时（不在底部）不强行拉底打断浏览
    function isNearBottom() {
        return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
    }

    // 阶段三十八：打开图片查看器（PC 端 Electron 无边框工具栏窗口 / Web 端浏览器新标签，同套工具栏页面）
    // 收集当前会话 DOM 内全部 http 图片作为翻页/缩略图列表；blob:// 仅本页面有效，跨窗口加载失败需过滤
    function openImageViewer(url) {
        var urls = [];
        document.querySelectorAll('.chat-image').forEach(function (im) {
            var u = im.getAttribute('src') || '';
            if (u && u.indexOf('blob:') !== 0 && urls.indexOf(u) === -1) urls.push(u);
        });
        var idx = urls.indexOf(url);
        if (window.desktop && window.desktop.openImageViewer) {
            window.desktop.openImageViewer({ url: url, list: urls, index: idx });
        } else {
            window.__imageViewerList = urls; // Web 端查看器页从 opener 拉取列表
            window.open('/image-viewer.html?url=' + encodeURIComponent(url), '_blank');
        }
    }

    function appendImageMsg(fromUser, url, type, isPrivate) {
        // 贴底状态必须在插入前快照：原实现 load 时再判 isNearBottom()，此时图片已把列表撑高
        // （gap 瞬间≈图片高度>80px 容差），会被误判为"翻历史中"而放弃滚底，导致图片仍只显示一半
        var stick = isNearBottom();
        var div = document.createElement('div');
        div.className = 'message ' + type;
        // 撤回能力前提：气泡携带发送者与时间戳（撤回菜单"本人发送+窗口时间内"判断依赖此属性）
        // 原实现：未设置 data-from/data-ts，实时图片气泡回填 msg_id 后撤回菜单仍不可见（isMine 恒 false）
        div.setAttribute('data-from', fromUser);
        div.setAttribute('data-ts', Math.floor(Date.now() / 1000));
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        nameEl.textContent = fromUser;
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble bubble-image';
        var img = document.createElement('img');
        img.className = 'chat-image';
        img.src = url;
        // 图片显示一半修复：图片异步加载完成前高度为 0，插入后立即滚底会停在半截；
        // 加载完成后按"插入前贴底快照"决定是否再次滚底（stick 在插入前采样，不受加载撑高影响）
        // 原实现：load 回调内实时 isNearBottom() 判定——此时列表已被撑高导致误判，已废弃
        // img.addEventListener('load', function () {
        //     if (isNearBottom()) messageList.scrollTop = messageList.scrollHeight;
        // });
        img.addEventListener('load', function () {
            if (stick) messageList.scrollTop = messageList.scrollHeight;
        });
        img.addEventListener('click', function () {
            // 原实现：window.open(url, '_blank') 直接弹裸图片窗口，无工具栏
            // 阶段三十八：改走图片查看器（置顶/翻页/缩略图/缩放/旋转/另存为）
            openImageViewer(url);
        });
        bubble.appendChild(img);
        // 头像缺失修复：与文字消息一致，头像 + 内容列微信风格结构
        // 原代码：div.appendChild(nameEl); div.appendChild(bubble); 平铺在 .message 下，无头像
        var body = document.createElement('div');
        body.className = 'message-body';
        // 私聊窗口标题已显示对方名称，气泡内昵称冗余，仅群聊显示发送者昵称
        // 原实现：body.appendChild(nameEl);
        // body.appendChild(nameEl);
        if (!isPrivate) body.appendChild(nameEl);
        body.appendChild(bubble);
        div.appendChild(getAvatarEl(fromUser));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
        return div;
    }

    // 文件消息渲染（文件卡片：图标 + 文件名 + 大小，点击下载）
    function appendFileMsg(fromUser, name, sizeText, url, type, isPrivate) {
        var div = document.createElement('div');
        div.className = 'message ' + type;
        // 撤回能力前提：气泡携带发送者与时间戳（撤回菜单"本人发送+窗口时间内"判断依赖此属性）
        // 原实现：未设置 data-from/data-ts，实时文件气泡回填 msg_id 后撤回菜单仍不可见（isMine 恒 false）
        div.setAttribute('data-from', fromUser);
        div.setAttribute('data-ts', Math.floor(Date.now() / 1000));
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
        // 头像缺失修复：与文字消息一致，头像 + 内容列微信风格结构
        // 原代码：div.appendChild(nameEl); div.appendChild(bubble); 平铺在 .message 下，无头像
        var body = document.createElement('div');
        body.className = 'message-body';
        // 私聊窗口标题已显示对方名称，气泡内昵称冗余，仅群聊显示发送者昵称
        // 原实现：body.appendChild(nameEl);
        // body.appendChild(nameEl);
        if (!isPrivate) body.appendChild(nameEl);
        body.appendChild(bubble);
        div.appendChild(getAvatarEl(fromUser));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
        return div;
    }
})();
