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
    var agentModeBtn = document.getElementById('agent-mode-btn'); // 阶段五十九：Agent 任务模式开关（未定义会在下方 addEventListener 处抛 TypeError 打断整个脚本初始化）
    var agentWsBtn = document.getElementById('agent-ws-btn'); // 阶段六十一：Agent 工作区/沙箱白名单入口（仅 PC 端本地执行器可用）
    var emojiPanel = document.getElementById('emoji-panel');
    var imageInput = document.getElementById('image-input');
    var fileInput = document.getElementById('file-input');
    var docInput = document.getElementById('doc-input'); // 阶段四十五：AI 文档问答选择框
    var convListEl = document.getElementById('conv-list');
    var friendsPanel = document.getElementById('friends-panel');
    // 阶段四十三：AI 助手面板与智能体列表（服务端配置归口下发）
    var aiPanel = document.getElementById('ai-panel');
    var aiAgentList = document.getElementById('ai-agent-list');

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
        // 阶段四十二：Esc 关闭添加好友弹窗
        if (e.key === 'Escape' && !addFriendMask.classList.contains('hidden')) closeAddFriendDialog();
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
    // 阶段四十七：账号输入框回车也能登录（参考图风格改版配套，原仅密码框支持回车）
    loginUsername.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
    });
    // 阶段四十七：密码显隐切换（参考图右侧眼睛按钮）
    var loginEye = document.getElementById('login-eye');
    var loginEyeShow = document.getElementById('login-eye-show');
    var loginEyeHide = document.getElementById('login-eye-hide');
    if (loginEye) {
        loginEye.addEventListener('click', function () {
            var show = loginPassword.type === 'password';
            loginPassword.type = show ? 'text' : 'password';
            loginEyeShow.classList.toggle('hidden', show);
            loginEyeHide.classList.toggle('hidden', !show);
            loginEye.title = show ? '隐藏密码' : '显示密码';
        });
    }
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
        // 阶段四十二：添加好友弹窗查询路由——查询结果填充搜索结果区（头像/昵称/用户名，点选后确认才发申请）
        // 修复记录：此分支曾因同文件并行编辑相互覆盖而丢失，表现为搜索存在用户一直停在"搜索中..."
        if (addFriendQuery && info.username === addFriendQuery) {
            addFriendQuery = null;
            if (info.is_friend) {
                renderAddFriendHint('该用户已是你的好友'); // 已是好友：仅提示，"确定"保持禁用（服务端同样会拒绝重复申请）
            } else {
                renderAddFriendItem(info);
            }
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
    // 阶段四十二：添加好友弹窗改版（先搜索后申请）
    // 原实现：showPrompt 输入用户名直接发申请，不存在的账号也提示"好友申请已发送"（误导）
    // 新流程：输入 → 防抖后 PROFILE_QUERY 服务端查询 → 结果区展示头像/昵称条目（同通讯录样式）
    //        → 点选该用户后"确定"才可用 → 确定发送申请；查无此人结果区显示"无该用户"
    var addFriendMask = document.getElementById('add-friend-mask');
    var addFriendInput = document.getElementById('add-friend-input');
    var addFriendResult = document.getElementById('add-friend-result');
    var addFriendOk = document.getElementById('add-friend-ok');
    var addFriendCancel = document.getElementById('add-friend-cancel');
    var addFriendQuery = null;      // 进行中的查询目标用户名（用于 PROFILE_RESP/ERROR 路由到本弹窗）
    var addFriendFound = null;      // 已点选的用户资料（PROFILE_RESP JSON）
    var addFriendSearchTimer = null; // 输入防抖定时器

    function openAddFriendDialog() {
        addFriendInput.value = '';
        addFriendResult.classList.add('hidden');
        addFriendResult.innerHTML = '';
        addFriendQuery = null;
        addFriendFound = null;
        addFriendOk.disabled = true;
        addFriendMask.classList.remove('hidden');
        setTimeout(function () { addFriendInput.focus(); }, 50);
    }

    function closeAddFriendDialog() {
        addFriendMask.classList.add('hidden');
        addFriendQuery = null;
        addFriendFound = null;
        if (addFriendSearchTimer) { clearTimeout(addFriendSearchTimer); addFriendSearchTimer = null; }
    }

    // 渲染提示行（搜索中/无该用户/不能添加自己/已是好友等纯文字状态）
    function renderAddFriendHint(text) {
        addFriendResult.classList.remove('hidden');
        addFriendResult.innerHTML = '';
        var hint = document.createElement('div');
        hint.className = 'add-friend-hint';
        hint.textContent = text;
        addFriendResult.appendChild(hint);
    }

    // 渲染查询结果条目（样式同通讯录好友条目：头像+主名+用户名副行；点击选中后"确定"才可用）
    function renderAddFriendItem(info) {
        addFriendResult.classList.remove('hidden');
        addFriendResult.innerHTML = '';
        var item = document.createElement('div');
        item.className = 'add-friend-item';
        // 头像降级：有头像显示图片，无头像显示首字母占位（与通讯录 renderFriendList 同规则）
        if (info.avatar) {
            var av = document.createElement('img');
            av.className = 'avatar';
            av.src = info.avatar;
            item.appendChild(av);
        } else {
            var ph = document.createElement('div');
            ph.className = 'avatar placeholder';
            ph.textContent = (info.nickname || info.username).charAt(0).toUpperCase();
            item.appendChild(ph);
        }
        var nameBox = document.createElement('div');
        nameBox.className = 'add-friend-names';
        var mainName = document.createElement('div');
        mainName.className = 'user-name';
        mainName.textContent = info.nickname || info.username; // 主名：昵称优先（同通讯录备注/昵称优先规则）
        var subName = document.createElement('div');
        subName.className = 'add-friend-sub';
        subName.textContent = '用户名：' + info.username;
        nameBox.appendChild(mainName);
        nameBox.appendChild(subName);
        item.appendChild(nameBox);
        // 点选：选中高亮，"确定"解禁（用户明确要求点选确认后才发送申请）
        item.addEventListener('click', function () {
            addFriendResult.querySelectorAll('.add-friend-item').forEach(function (el) { el.classList.remove('selected'); });
            item.classList.add('selected');
            addFriendFound = info;
            addFriendOk.disabled = false;
        });
        addFriendResult.appendChild(item);
    }

    // 查询用户：自己直接本地提示；否则 PROFILE_QUERY 服务端归口查询（查无此人服务端回 ERROR"用户不存在"）
    function searchAddFriend() {
        var name = addFriendInput.value.trim();
        addFriendFound = null;
        addFriendOk.disabled = true;
        if (!name) {
            addFriendQuery = null;
            addFriendResult.classList.add('hidden');
            addFriendResult.innerHTML = '';
            return;
        }
        if (name === IMSocket.getUsername()) {
            addFriendQuery = null;
            renderAddFriendHint('不能添加自己为好友');
            return;
        }
        addFriendQuery = name;
        renderAddFriendHint('搜索中...');
        IMSocket.send({ msg_type: MSG.PROFILE_QUERY, to_user: name });
    }

    addFriendBtn.addEventListener('click', openAddFriendDialog);
    addFriendCancel.addEventListener('click', closeAddFriendDialog);
    addFriendInput.addEventListener('input', function () {
        clearTimeout(addFriendSearchTimer);
        addFriendSearchTimer = setTimeout(searchAddFriend, 400); // 停止输入 400ms 后自动查询
    });
    addFriendInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(addFriendSearchTimer); searchAddFriend(); }
        if (e.key === 'Escape') closeAddFriendDialog();
    });
    // 确定：向点选的用户发送好友申请（成功提示走服务端回执"好友申请已发送成功"）
    addFriendOk.addEventListener('click', function () {
        if (!addFriendFound) return;
        IMSocket.send({ msg_type: MSG.FRIEND_REQUEST, to_user: addFriendFound.username, content: '请求添加你为好友' });
        closeAddFriendDialog();
    });
    // 原实现：showPrompt 直接发送申请，不校验用户是否存在
    // addFriendBtn.addEventListener('click', function () {
    //     showPrompt('添加好友', '请输入对方用户名', function (name) {
    //         if (name === IMSocket.getUsername()) {
    //             showToast('不能添加自己为好友');
    //             return;
    //         }
    //         IMSocket.send({ msg_type: MSG.FRIEND_REQUEST, to_user: name, content: '请求添加你为好友' });
    //     });
    // });

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
                } else if (action === 'quote' && msgId) {
                    // 阶段四十：引用消息——收集被引用消息摘要，显示输入框上方引用条，随下一条文本消息一起发出（微信同款）
                    // 阶段四十一：图片引用带图片地址（quote.url）——引用块内直接显示真实图片缩略图而非仅"[图片]"文字
                    var qBubble = msgTarget.querySelector('.message-bubble');
                    var qImg = qBubble ? qBubble.querySelector('.chat-image') : null;
                    var qFrom = msgTarget.getAttribute('data-from') || '';
                    if (qImg) {
                        var qSrc = qImg.getAttribute('src') || '';
                        // blob: URL 跨端无效（本页临时预览），转 dataURL 后随信封发出；服务器 URL 直接使用
                        if (qSrc.indexOf('blob:') === 0) {
                            // 原实现：图片引用仅存"[图片]"文字摘要，无真实图片内容
                            blobToDataUrl(qSrc).then(function (d) {
                                setQuoteTarget({ msg_id: msgId, from: qFrom, text: '[图片]', url: d || '' });
                                messageInput.focus();
                            });
                        } else {
                            setQuoteTarget({ msg_id: msgId, from: qFrom, text: '[图片]', url: qSrc });
                            messageInput.focus();
                        }
                    } else if (qBubble) {
                        // 引用消息正文取 .msg-text（引用块自身不重复计入摘要）；普通消息取气泡全文
                        var qTextEl = qBubble.querySelector('.msg-text');
                        var qSummary = ((qTextEl ? qTextEl.textContent : qBubble.textContent) || '').trim();
                        if (qSummary.length > 50) qSummary = qSummary.slice(0, 50) + '…'; // 摘要截断（微信同款）
                        setQuoteTarget({ msg_id: msgId, from: qFrom, text: qSummary });
                        messageInput.focus();
                    }
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
    // ===== 阶段三十八：截图待发送区（QQ 同款：编辑完成不直接发送，先进输入框上方待发送条，点发送才出） =====
    // 阶段三十九：多次截图一起发送——待发送区改为截图列表，连续截多张累积暂存，点发送一次性全部发出
    // 原实现：var pendingShot = null;（单张待发送 blob，新截图覆盖旧截图）
    // var pendingShot = null;     // 待发送截图 blob
    var pendingShots = [];      // 待发送截图列表（多次截图累积，每项为 blob）
    var pendingShotBar = null;  // 待发送条 DOM（输入区顶部，仅一条，内部横向排列多张缩略图）
    var pendingShotListEl = null; // 缩略图列表容器

    // 惰性创建待发送条（首张截图入列时才插入输入区顶部）
    function ensurePendingShotBar() {
        if (pendingShotBar) return;
        pendingShotBar = document.createElement('div');
        pendingShotBar.className = 'pending-shot';
        pendingShotListEl = document.createElement('div');
        pendingShotListEl.className = 'pending-shot-list';
        pendingShotBar.appendChild(pendingShotListEl);
        var bar = document.querySelector('.input-bar');
        if (bar) bar.insertBefore(pendingShotBar, bar.firstChild);
    }

    function setPendingShot(blob) {
        if (!blob) return;
        ensurePendingShotBar();
        var item = { blob: blob };
        pendingShots.push(item);
        // 单张缩略图节点（右上角 × 可单独移除该张）
        var cell = document.createElement('div');
        cell.className = 'pending-shot-item';
        var thumb = document.createElement('img');
        thumb.src = URL.createObjectURL(blob);
        thumb.onload = function () { URL.revokeObjectURL(thumb.src); }; // 已渲染即可释放
        var del = document.createElement('button');
        del.className = 'pending-shot-del';
        del.textContent = '×';
        del.title = '移除截图';
        del.addEventListener('click', function () {
            var idx = pendingShots.indexOf(item);
            if (idx >= 0) pendingShots.splice(idx, 1);
            cell.remove();
            if (!pendingShots.length) removePendingShotBar(); // 全部移除后收起待发送条
            messageInput.focus();
        });
        cell.appendChild(thumb);
        cell.appendChild(del);
        pendingShotListEl.appendChild(cell);
        // 阶段三十九：点击缩略图预览编辑后的最终画面（确认无误再发送）
        thumb.addEventListener('click', function () { openShotPreview(item, cell); });
        // 原实现（单张：先清旧再建整条，文件名固定"截图.png"）
        // clearPendingShot();
        // pendingShot = blob;
        // pendingShotBar = document.createElement('div');
        // pendingShotBar.className = 'pending-shot';
        // var thumb = document.createElement('img');
        // thumb.src = URL.createObjectURL(blob);
        // thumb.onload = function () { URL.revokeObjectURL(thumb.src); }; // 已渲染即可释放
        // var name = document.createElement('span');
        // name.className = 'pending-shot-name';
        // name.textContent = '截图.png';
        // var del = document.createElement('button');
        // del.className = 'pending-shot-del';
        // del.textContent = '×';
        // del.title = '移除截图';
        // del.addEventListener('click', function () { clearPendingShot(); messageInput.focus(); });
        // pendingShotBar.appendChild(thumb);
        // pendingShotBar.appendChild(name);
        // pendingShotBar.appendChild(del);
        // var bar = document.querySelector('.input-bar');
        // if (bar) bar.insertBefore(pendingShotBar, bar.firstChild);
    }

    // 仅收起待发送条 DOM（列表已空时调用）
    function removePendingShotBar() {
        if (pendingShotBar) {
            pendingShotBar.remove();
            pendingShotBar = null;
            pendingShotListEl = null;
        }
    }

    function clearPendingShot() {
        // 原实现：pendingShot = null; + 移除单条 bar
        pendingShots = [];
        removePendingShotBar();
    }

    // ===== 阶段三十九：待发送截图预览浮层（点击缩略图放大查看编辑后效果，确认后可一键发送此图） =====
    var shotPreviewMask = null; // 预览遮罩 DOM（惰性创建，全局仅一份）

    function openShotPreview(item, cell) {
        if (!shotPreviewMask) {
            // 惰性构建：深色遮罩 + 大图 + 关闭/发送按钮（自绘浮层，禁止系统默认弹窗）
            shotPreviewMask = document.createElement('div');
            shotPreviewMask.className = 'shot-preview-mask hidden';
            var img = document.createElement('img');
            img.className = 'shot-preview-img';
            var bar = document.createElement('div');
            bar.className = 'shot-preview-bar';
            var sendBtn = document.createElement('button');
            sendBtn.className = 'shot-preview-btn primary';
            sendBtn.textContent = '发送此图';
            var closeBtn = document.createElement('button');
            closeBtn.className = 'shot-preview-btn';
            closeBtn.textContent = '关闭';
            bar.appendChild(sendBtn);
            bar.appendChild(closeBtn);
            shotPreviewMask.appendChild(img);
            shotPreviewMask.appendChild(bar);
            document.body.appendChild(shotPreviewMask);
            // 事件只绑一次：点空白处/关闭按钮收起；发送此图走既有图片链路并从待发送区移除该张
            closeBtn.addEventListener('click', hideShotPreview);
            shotPreviewMask.addEventListener('click', function (e) {
                if (e.target === shotPreviewMask) hideShotPreview(); // 仅点遮罩空白处关闭（点图/按钮不关）
            });
            sendBtn.addEventListener('click', function () {
                var it = shotPreviewMask._item;
                hideShotPreview();
                if (!it) return;
                var idx = pendingShots.indexOf(it);
                if (idx >= 0) pendingShots.splice(idx, 1);
                if (it._cell) it._cell.remove();
                if (!pendingShots.length) removePendingShotBar(); // 发完最后一张收起待发送条
                sendScreenshotFile(it.blob);
                messageInput.focus();
            });
            // Esc 快捷关闭（仅预览可见时响应）
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && shotPreviewMask && !shotPreviewMask.classList.contains('hidden')) hideShotPreview();
            });
        }
        shotPreviewMask._item = item;
        item._cell = cell; // 记录对应缩略图节点（发送此图后移除用）
        var pImg = shotPreviewMask.querySelector('.shot-preview-img');
        if (pImg.src && pImg.src.indexOf('blob:') === 0) URL.revokeObjectURL(pImg.src); // 释放上一张预览的 blob URL
        pImg.src = URL.createObjectURL(item.blob);
        shotPreviewMask.classList.remove('hidden');
    }

    function hideShotPreview() {
        if (!shotPreviewMask) return;
        var pImg = shotPreviewMask.querySelector('.shot-preview-img');
        if (pImg.src && pImg.src.indexOf('blob:') === 0) URL.revokeObjectURL(pImg.src);
        pImg.src = '';
        shotPreviewMask._item = null;
        shotPreviewMask.classList.add('hidden');
    }

    // ===== 阶段四十：消息引用（微信同款：右键引用 → 输入框上方引用条 → 随下一条文本消息一起发出） =====
    var quoteTarget = null; // 当前引用目标 { msg_id, from, text }（text 为被引用消息摘要）
    var quoteBarEl = null;  // 引用条 DOM（输入区顶部，惰性创建）

    // 设置引用目标并显示引用条（摘要过长截断，微信同款）
    function setQuoteTarget(q) {
        quoteTarget = q;
        if (!quoteBarEl) {
            quoteBarEl = document.createElement('div');
            quoteBarEl.className = 'quote-bar hidden';
            var info = document.createElement('span');
            info.className = 'quote-bar-info';
            var del = document.createElement('button');
            del.className = 'quote-bar-del';
            del.textContent = '×';
            del.title = '取消引用';
            del.addEventListener('click', function () { clearQuoteTarget(); messageInput.focus(); });
            quoteBarEl.appendChild(info);
            quoteBarEl.appendChild(del);
            var bar = document.querySelector('.input-bar');
            if (bar) {
                // 插在截图待发送条之下（无截图条时插在最前），紧贴输入区工具栏
                var ps = bar.querySelector('.pending-shot');
                if (ps && ps.nextSibling) bar.insertBefore(quoteBarEl, ps.nextSibling);
                else if (ps) bar.appendChild(quoteBarEl);
                else bar.insertBefore(quoteBarEl, bar.firstChild);
            }
        }
        quoteBarEl.querySelector('.quote-bar-info').textContent = '引用 ' + (q.from || '') + '：' + (q.text || '');
        quoteBarEl.classList.remove('hidden');
    }

    function clearQuoteTarget() {
        quoteTarget = null;
        if (quoteBarEl) quoteBarEl.classList.add('hidden');
    }

    // 解析引用信封 content（{"quote":{msg_id,from,text},"text":回复}）；
    // 非信封（普通文本/图片 JSON 等）返回 null——必须同时有 quote 对象与 text 字符串才判定为引用，
    // 防止把图片消息 JSON（url/name/size）或纯数字文本误判为引用
    function parseQuoteEnvelope(content) {
        if (!content || content.charAt(0) !== '{') return null;
        var m = null;
        try { m = JSON.parse(content); } catch (e) { return null; }
        if (!m || typeof m !== 'object' || !m.quote || typeof m.quote !== 'object' || typeof m.text !== 'string') return null;
        return m;
    }

    // 搜索结果展示文本：引用信封显示回复正文（搜索命中含引用原文的 JSON 串，展示正文即可）
    function quoteDisplayText(content) {
        var m = parseQuoteEnvelope(content);
        return m ? m.text : content;
    }

    // 阶段四十四：解析 AI 图片提问信封 content（{"image":url,"text":附言}）；非图片信封返回 null。
    // 必须同时有 image 字符串与 text 字段才判定，防止普通文本误判
    function parseAIImageEnvelope(content) {
        if (!content || content.charAt(0) !== '{') return null;
        var m = null;
        try { m = JSON.parse(content); } catch (e) { return null; }
        if (!m || typeof m !== 'object' || typeof m.image !== 'string' || !m.image || typeof m.text !== 'string') return null;
        return m;
    }

    // 阶段四十五：解析 AI 文档问答信封 content（{"doc":url,"name":文件名,"text":附言}）；
    // 必须有 doc 字符串 + text 字段（name 可缺省）才判定，防止普通 JSON 文本误判
    function parseAIDocEnvelope(content) {
        if (!content || content.charAt(0) !== '{') return null;
        var m = null;
        try { m = JSON.parse(content); } catch (e) { return null; }
        if (!m || typeof m !== 'object' || typeof m.doc !== 'string' || !m.doc || typeof m.text !== 'string') return null;
        return m;
    }

    // 阶段四十四：当前会话的 AI 智能体是否支持图片识别（服务端 AI_AGENTS 能力标记归口）
    function aiAgentSupportsImage(name) {
        for (var i = 0; i < aiAgents.length; i++) {
            if (aiAgents[i].name === name) return !!aiAgents[i].image;
        }
        return false;
    }

    function sendMessage() {
        var content = messageInput.value.trim();
        // 阶段三十八：待发送截图优先（QQ 同款：Enter/发送按钮先发出待发送区的截图）
        // 阶段三十九：一次发出全部待发送截图（逐张走既有图片链路，各自 nonce 气泡独立回填）
        // 截图附言随发：输入框文字取走并清空后随截图一并发出——AI 会话作为图片附言入信封（单气泡图+文），
        // 普通会话作为独立文字消息紧随图片发出；原实现分支无条件 return，文字留在输入框需二次点击发送
        if (pendingShots.length) {
            var shots = pendingShots.slice();
            var note = content;
            clearPendingShot();
            messageInput.value = '';
            // 修复：必须传 item.blob（列表项为 { blob: xx } 包装对象，直传会把对象序列化成 "[object Object]" 垃圾内容导致图片全碎）
            // 原实现：for (var i = 0; i < shots.length; i++) sendScreenshotFile(shots[i]);
            for (var i = 0; i < shots.length; i++) sendScreenshotFile(shots[i].blob, note);
            messageInput.focus();
            if (currentChatUser !== '' && isAIAgent(currentChatUser)) return; // AI：附言已入图片信封
            if (!note) return; // 无附言：仅发图
            content = note; // 普通/群聊：附言继续走下方普通消息链路，与截图同次点击一起发出
        }
        if (!content) return;
        // 阶段四十三：AI 智能体会话走专用问答协议（服务端归口调用模型并流式回复，密钥不下发）
        var msg;
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            // 阶段五十九：Agent 任务模式——发送内容作为自动化任务目标（服务端建任务闭环，事件流实时回推）
            if (agentMode) {
                clearQuoteTarget(); // 任务目标不参与引用（引用信封 JSON 会破坏 AGENT_RUN 协议格式）
                msg = { msg_type: MSG.AGENT_RUN, to_user: currentChatUser, content: JSON.stringify({ goal: content, agent_name: currentChatUser }) };
                if (IMSocket.send(msg)) {
                    messageInput.value = '';
                    messageInput.focus();
                    // 本地回显任务目标（任务事件不落库，仅实时展示；最终答复同样实时渲染）
                    appendMessage(IMSocket.getUsername(), content, 'self', 0, Math.floor(Date.now() / 1000), false);
                }
                return;
            }
            msg = { msg_type: MSG.AI_CHAT, to_user: currentChatUser, content: content };
        } else {
            msg = { msg_type: currentChatUser === '' ? MSG.GROUP_CHAT : MSG.PRIVATE, content: content };
            if (currentChatUser !== '') msg.to_user = currentChatUser;
        }
        // 阶段四十：引用发送——content 换成引用信封 JSON（服务端归口解析会话摘要），发送后清引用条
        // 原实现：content 始终为纯文本
        if (quoteTarget) {
            msg.content = JSON.stringify({ quote: quoteTarget, text: content });
            clearQuoteTarget();
        }
        // 阶段四十三：记录 AI 提问原文（在引用信封包装后取最终发送内容，重新生成与首次发送解析口径完全一致；
        // text 为纯文本供"编辑提问"回填）
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            lastAIQuestion[currentChatUser] = { raw: msg.content, text: quoteDisplayText(msg.content) };
        }
        if (IMSocket.send(msg)) {
            messageInput.value = '';
            messageInput.focus();
            // 阶段四十三："思考中"指示不在发送时显示（原实现点发送即插入，会排在服务端回显的问题消息上面），
            // 改为在 PRIVATE 回显处理器中问题消息上屏后再显示，保证时序为：我的提问 → 思考中 → AI 流式回复
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
        // 阶段四十三：AI 会话无输入状态语义（对方非真实用户），跳过 TYPING 推送
        if (currentChatUser !== '' && !isAIAgent(currentChatUser)) {
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
        // 阶段四十四：AI 会话走图片识别链路——仅支持图片的智能体（配置归口）可发图
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            if (!aiAgentSupportsImage(currentChatUser)) {
                showToast('该助手不支持图片识别');
                return;
            }
        }
        imageInput.click();
    });
    fileBtn.addEventListener('click', function () {
        if (currentChatUser === '') { showToast('群聊暂不支持发送文件'); return; }
        // 阶段四十五：AI 会话文件按钮 = 文档问答入口（服务端解析文档文本注入提问，不依赖模型多模态）；
        // 普通私聊仍走分片文件链路
        if (isAIAgent(currentChatUser)) { docInput.click(); return; }
        fileInput.click();
    });
    imageInput.addEventListener('change', function () {
        if (imageInput.files[0]) {
            // 阶段二十六：群聊视图走 HTTP 上传链路（sendGroupImage），私聊仍走分片协议（sendFile）
            // 原实现：if (imageInput.files[0]) sendFile(imageInput.files[0]);
            if (currentChatUser === '') sendGroupImage(imageInput.files[0]);
            else if (isAIAgent(currentChatUser)) sendAIImage(imageInput.files[0]); // 阶段四十四：AI 图片识别链路
            else sendFile(imageInput.files[0]);
        }
        imageInput.value = '';
    });
    fileInput.addEventListener('change', function () {
        if (fileInput.files[0]) sendFile(fileInput.files[0]);
        fileInput.value = '';
    });
    // 阶段四十五：AI 文档问答入口（文件按钮在 AI 会话触发）
    docInput.addEventListener('change', function () {
        if (docInput.files[0]) sendAIDoc(docInput.files[0]);
        docInput.value = '';
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
    // 图片/文件气泡已读状态回填：气泡 msg_id 落库回填时，同步回填状态元素（发送时元素已建、msg_id 为空），
    // 并按对方已读水位即时定态——处理"回执先于落库通知到达"的时序（对方开着会话时秒读）
    function applyBubbleReadStatus(el, msgId, peer) {
        var st = el.querySelector('.msg-status');
        if (!st) return;
        st.setAttribute('data-msg-id', msgId);
        var read = (readWatermark[peer] || 0) >= msgId;
        st.textContent = read ? '已读' : '未读';
        if (read) st.classList.add('read');
    }

    IMSocket.on(MSG.FILE_PERSISTED, function (msg) {
        if (!msg.file_id || !msg.msg_id) return;
        // 分片路径：气泡已存在（file_id 随文件头回执记录），仅回填 msg_id
        var el = messageList.querySelector('.message[data-file-id="' + msg.file_id + '"]');
        if (el) {
            el.setAttribute('data-msg-id', msg.msg_id);
            // 发送端图片气泡带已读状态元素（接收端无），按对端回填
            var peer = msg.from_user === IMSocket.getUsername() ? (msg.to_user || '') : msg.from_user;
            applyBubbleReadStatus(el, msg.msg_id, peer);
            // 接收端正在查看会话：自动发已读回执（与文字消息一致；水位去重，服务端归口清除未读角标）
            if (msg.from_user !== IMSocket.getUsername() && currentChatUser === msg.from_user) {
                sendReadReceipt(msg.from_user, msg.msg_id);
            }
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
                applyBubbleReadStatus(mineEl, msg.msg_id, msg.to_user || '');
                // 阶段三十八：图片气泡 src 从 blob: 回填为服务器 URL——blob 仅本页面有效，
                // 图片查看器（独立窗口）收集列表时跨窗口加载失败，导致自己发的图进不了翻页/缩略图列表
                // 原实现：仅回填 msg_id/file_id，img.src 永远停留在 blob:
                var mImg = mineEl.querySelector('.chat-image');
                if (mImg && meta.url && mImg.getAttribute('src') && mImg.getAttribute('src').indexOf('blob:') === 0) {
                    mImg.setAttribute('src', meta.url);
                }
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
        // 接收端正在查看会话：自动发已读回执（与文字消息一致；发送端图片即时翻"已读"，未读角标服务端归口清除）
        if (!isMine) sendReadReceipt(msg.from_user, msg.msg_id);
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

    // 阶段四十四：AI 图片提问（图片识别）——POST /upload/ai/image 落盘（服务端不落库），
    // 成功后发送 AI_CHAT 图片信封（{"image":url,"text":附言}），提问由服务端 AI_CHAT 归口统一落库
    // （单条记录同时承载图片与附言，避免图片消息+信封消息重复气泡）。附言取发送时输入框内容（可空，
    // 服务端给模型默认指令"请描述并分析这张图片"）；本地 blob 气泡仅作上传中预览，发送成功后由
    // 服务端 PRIVATE 回显渲染最终气泡（无 nonce 去重链路，故发送前移除本地气泡防重复）
    // noteText 可选：截图附言（sendMessage 截图分支预先取走输入框文字传入）；
    // 缺省时取发送时输入框内容（图片按钮路径）
    function sendAIImage(file, noteText) {
        var agent = currentChatUser;
        if (!agent || !isAIAgent(agent)) return;
        if (!isImageName(file.name)) { showToast('仅支持发送图片文件'); return; }
        var maxFile = (IMSocket.getMaxFileSize && IMSocket.getMaxFileSize()) || 20971520;
        if (file.size > maxFile) { showToast('图片超过大小上限（' + formatSize(maxFile) + '）'); return; }
        var note = (noteText !== undefined && noteText !== null) ? String(noteText) : messageInput.value.trim();
        var bubble = appendImageMsg(IMSocket.getUsername(), URL.createObjectURL(file), 'self', true);
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/ai/image?username=' + encodeURIComponent(IMSocket.getUsername()) +
              '&to_user=' + encodeURIComponent(agent), {
            method: 'POST',
            body: fd
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) { throw new Error(t || ('HTTP ' + res.status)); });
            }
            return res.json();
        }).then(function (data) {
            if (!data || !data.url) throw new Error('上传响应缺少图片地址');
            var envelope = JSON.stringify({ image: data.url, text: note });
            // 记录提问原文（重新生成按信封原样重发，服务端重新读图，口径与首次发送一致）
            lastAIQuestion[agent] = { raw: envelope, text: note || '[图片]' };
            bubble.remove(); // 回显渲染最终气泡，移除本地预览防重复
            if (currentChatUser !== agent) return; // 上传期间切走了会话：信封不再补发（图片已存档，可重新发）
            if (!IMSocket.send({ msg_type: MSG.AI_CHAT, to_user: agent, content: envelope })) {
                throw new Error('消息发送失败');
            }
            messageInput.value = '';
        }).catch(function (e) {
            bubble.remove(); // 上传/发送失败：移除本地预览气泡（服务端无记录，避免幽灵气泡）
            showToast('图片发送失败：' + (e.message || e));
        });
    }

    // 阶段四十五：AI 文档问答——POST /upload/ai/doc 落盘+服务端试解析（不落库），成功后发送
    // AI_CHAT 文档信封（{"doc":url,"name":原名,"text":附言}）。文档正文不经过前端：提问时服务端
    // 按 URL 重新解析落盘文档提取文本注入提示词。附言取发送时输入框内容（可空，服务端给默认指令）。
    // 不依赖模型多模态能力：全部智能体均可发文档
    function sendAIDoc(file) {
        var agent = currentChatUser;
        if (!agent || !isAIAgent(agent)) return;
        if (!/\.(docx|xlsx|xlsm|csv|md|txt)$/i.test(file.name)) { showToast('仅支持 docx/xlsx/xlsm/csv/md/txt 文档'); return; }
        var maxFile = (IMSocket.getMaxFileSize && IMSocket.getMaxFileSize()) || 20971520;
        if (file.size > maxFile) { showToast('文档超过大小上限（' + formatSize(maxFile) + '）'); return; }
        var note = messageInput.value.trim();
        showToast('正在上传文档…');
        var fd = new FormData();
        fd.append('file', file);
        fetch('/upload/ai/doc?username=' + encodeURIComponent(IMSocket.getUsername()) +
              '&to_user=' + encodeURIComponent(agent), {
            method: 'POST',
            body: fd
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) { throw new Error(t || ('HTTP ' + res.status)); });
            }
            return res.json();
        }).then(function (data) {
            if (!data || !data.url) throw new Error('上传响应缺少文档地址');
            var envelope = JSON.stringify({ doc: data.url, name: file.name, text: note });
            // 记录提问原文（重新生成按信封原样重发，服务端重新解析文档，口径与首次发送一致）
            lastAIQuestion[agent] = { raw: envelope, text: note ? '[文档] ' + file.name + ' ' + note : '[文档] ' + file.name };
            if (currentChatUser !== agent) return; // 上传期间切走了会话：信封不再补发（文档已存档，可重新发）
            if (!IMSocket.send({ msg_type: MSG.AI_CHAT, to_user: agent, content: envelope })) {
                throw new Error('消息发送失败');
            }
            messageInput.value = '';
        }).catch(function (e) {
            showToast('文档发送失败：' + (e.message || e));
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

    // 抓屏结果统一进入冻结截图编辑器（QQ 同款全屏冻结）
    // prepared=true：主进程在窗口透明期间推送快照（shot:prepare），编辑器就绪后需通知揭幕（shotReady）
    function openShotEditor(blob, prepared) {
        if (!blob) {
            showToast('截图失败');
            if (prepared && window.desktop) {
                // 失败兜底：主进程已切全屏冻结态，必须退出全屏（否则卡在全屏聊天界面挡住任务栏）+ 揭幕恢复透明度
                // 原实现：仅 shotReady 揭幕（全屏态残留，用户反馈"程序全屏显示连任务栏都挡住"）
                if (window.desktop.exitFreeze) window.desktop.exitFreeze();
                if (window.desktop.shotReady) window.desktop.shotReady();
            }
            return;
        }
        // 阶段三十八：QQ 同款全屏冻结截图——PC 端主窗口已被主进程置为全屏+置顶（透明期间预加载），
        // freeze 模式画面铺满视口（视觉=屏幕被冻结画面覆盖），拖拽框选 → 工具栏标注 → 完成；
        // 编辑完成/取消后 onClose 退出全屏冻结，截图进输入框待发送区（点发送才真正发出）
        // 原实现：ScreenshotEditor.open(blob, sendScreenshotFile);（窗口式居中缩放，用户反馈"像在程序里打开图片"而非 QQ 截图）
        ScreenshotEditor.freeze(blob, setPendingShot, function () {
            if (window.desktop && window.desktop.exitFreeze) window.desktop.exitFreeze();
            // Esc/取消退出后清掉残留焦点（用户反馈：退出截图后截图按钮残留黄色焦点框）
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        }, function () {
            // 首帧绘制就绪：通知主进程揭幕（透明度归位，第一帧即冻结画面，无聊天界面闪现）
            if (prepared && window.desktop && window.desktop.shotReady) window.desktop.shotReady();
        });
    }

    // 主进程抓屏完成推送（窗口透明期间预加载冻结编辑器，就绪后主进程才揭幕——闪烁最小化）
    if (window.desktop && window.desktop.onShotPrepare) {
        window.desktop.onShotPrepare(function (dataUrl) {
            openShotEditor(dataUrlToBlob(dataUrl), true);
        });
    }

    screenshotBtn.addEventListener('click', function () {
        this.blur(); // 移除按钮焦点（避免退出截图后按钮残留焦点框高亮）
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
        // AI 智能体会话：截图同样走 AI 图片识别链路（/upload/ai/image + AI_CHAT 信封），
        // 与图片按钮一致；原实现直走通用文件链路，AI 不响应文件消息导致截图提问无应答
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) { sendAIImage(shot); return; }
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
            // 阶段四十三：登录成功后拉取 AI 智能体列表（刷新自动重登/断线重连均会走 LOGIN_RESP，服务端配置归口）
            requestAIAgents();
            // 阶段六十一：登录成功后自动上报本机沙箱白名单（服务端仅内存保存，重启即丢失；
            // PC 重启/断线重连均走 LOGIN_RESP，从主进程本地持久化拉取后重新上报，保证 Agent 任务随时可用授权目录）
            if (agentWsSupported()) {
                window.desktop.sandboxGet(IMSocket.getUsername()).then(function (cfg) {
                    cfg = cfg || {};
                    if (!cfg.primary && (!cfg.dirs || !cfg.dirs.length)) return; // 未配置=默认工作区语义，无需上报
                    IMSocket.send({
                        msg_type: MSG.AGENT_SANDBOX,
                        content: JSON.stringify({ primary: cfg.primary || '', dirs: cfg.dirs || [] })
                    });
                });
            }
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
        // 阶段四十二：添加好友弹窗查询中收到"用户不存在"时定向显示在结果区（不弹全局 toast）
        // 修复记录：此分支曾因同文件并行编辑相互覆盖而丢失，导致查无此人时一直停在"搜索中..."且无提示
        if (addFriendQuery && !addFriendMask.classList.contains('hidden') && msg.content === '用户不存在') {
            addFriendQuery = null;
            renderAddFriendHint('无该用户');
            return;
        }
        showToast(msg.content);
        // 阶段四十三：AI 限流/智能体不存在等失败路径只发 ERROR 无 END 帧，这里同步收起"思考中"指示防空等
        if (aiThinking[currentChatUser]) {
            hideAIThinking(currentChatUser);
        }
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

    // ===== 侧栏 Tab 切换：聊天（会话列表）/ AI 助手（智能体列表）/ 好友 =====
    document.querySelectorAll('.sidebar-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.sidebar-tab').forEach(function (t) { t.classList.remove('active'); });
            this.classList.add('active');
            // 阶段四十三：新增 AI Tab（智能体列表），三面板互斥切换
            var tabName = this.getAttribute('data-tab');
            convListEl.classList.toggle('hidden', tabName !== 'chat');
            friendsPanel.classList.toggle('hidden', tabName !== 'friends');
            aiPanel.classList.toggle('hidden', tabName !== 'ai');
            // 阶段二十三：切换Tab时清空搜索状态（收起结果面板、清空输入与清除按钮），避免残留干扰
            closeSidebarSearch();
        });
    });

    // ===== 阶段四十三：AI 问答（智能体列表 / 流式打字机渲染） =====
    // 服务端归口：智能体由 config.yaml 配置下发（仅名称/头像/模型名，密钥不下发），每人会话按 用户+智能体 隔离
    var aiAgents = [];      // 智能体列表 [{name, avatar, model}]
    var agentAvatars = {};  // 智能体头像映射（getAvatarUrl 渲染归口：服务端配置头像优先，缺失回退 emoji）
    var aiStreams = {};     // 进行中的流式回复：stream_id -> {el, textEl, cursorEl, pending, shown, timer, done, finalId}
    var aiThinking = {};    // 等待 AI 首段回复的"思考中"指示：agent -> {el}
    var lastAIQuestion = {}; // 各智能体最近一次提问（重新生成/编辑提问按钮数据源）：agent -> { raw, text }

    function isAIAgent(name) {
        return aiAgents.some(function (a) { return a.name === name; });
    }

    // 阶段五十七：头像形态判定——URL（图片头像）与 emoji/文本（自建智能体 emoji 头像）分路渲染，
    // emoji 直接作为 img.src 会触发破图降级丢失用户所选表情，须走文本占位链路
    function aiAvatarIsUrl(v) {
        return /^(https?:\/\/|\/|\.\.?\/)/.test(v);
    }

    // 请求智能体列表（登录成功后调用，断线重连重新登录后再次拉取）
    function requestAIAgents() {
        IMSocket.send({ msg_type: MSG.AI_AGENTS });
    }

    IMSocket.on(MSG.AI_AGENTS, function (msg) {
        try { aiAgents = JSON.parse(msg.content) || []; } catch (e) { aiAgents = []; }
        aiAgents.forEach(function (a) {
            if (a && a.name && a.avatar) agentAvatars[a.name] = a.avatar;
        });
        renderAgentList();
        // 阶段四十三：智能体列表晚于会话列表/历史消息到达（刷新页面时的正常时序），
        // 此前 isAIAgent() 全部返回 false 导致 AI 头像降级为首字母——就绪后刷新会话列表与
        // 当前智能体会话，头像统一回正为 🤖/配置图片
        renderConvList();
        if (currentChatUser && isAIAgent(currentChatUser)) {
            openConversation(currentChatUser);
        }
        // 当前正停留在智能体会话时，刷新标题区（头像/名称就绪）
        updateChatTitle();
    });

    // 渲染 AI 助手面板的智能体列表（布局对齐通讯录 user-item，主题色跟随现有变量）
    function renderAgentList() {
        aiAgentList.innerHTML = '';
        if (!aiAgents.length) {
            var empty = document.createElement('li');
            empty.className = 'ai-agent-empty';
            empty.textContent = '暂无可用的 AI 助手';
            aiAgentList.appendChild(empty);
            return;
        }
        aiAgents.forEach(function (a) {
            var li = document.createElement('li');
            li.className = 'user-item ai-agent-item' + (currentChatUser === a.name ? ' active' : '');

            // 头像：服务端配置头像优先（图片失效降级 emoji），无配置回退 emoji 占位
            // 阶段五十七：emoji 文本头像（自建智能体）直接渲染文本，不按 URL 走 img 破图降级
            var avatar = document.createElement('div');
            avatar.className = 'avatar ai-agent-avatar';
            if (a.avatar && aiAvatarIsUrl(a.avatar)) {
                var img = document.createElement('img');
                img.src = a.avatar;
                img.alt = '';
                img.addEventListener('error', function () {
                    img.remove();
                    avatar.textContent = '🤖';
                });
                avatar.appendChild(img);
            } else {
                avatar.textContent = a.avatar || '🤖';
            }

            var info = document.createElement('div');
            info.className = 'ai-agent-info';
            var name = document.createElement('div');
            name.className = 'ai-agent-name';
            name.textContent = a.name;
            // 阶段五十七：个人智能体标记（owner 非空=自建，服务端按用户视角过滤下发）
            if (a.owner) {
                var ownerTag = document.createElement('span');
                ownerTag.className = 'ai-agent-owner-tag';
                ownerTag.textContent = '个人';
                name.appendChild(ownerTag);
            }
            var model = document.createElement('div');
            model.className = 'ai-agent-model';
            // 阶段四十四：图片识别能力标记（服务端配置归口下发，true 时该助手可收图）
            model.textContent = (a.model || '智能助手') + (a.image ? ' · 支持图片' : '');
            info.appendChild(name);
            info.appendChild(model);

            li.appendChild(avatar);
            li.appendChild(info);
            // 点击智能体进入对应 AI 会话（复用私聊会话链路：标题/历史/气泡渲染）
            li.addEventListener('click', function () {
                openConversation(a.name);
                // 阶段四十三：重渲染列表让选中高亮跟随点击项（原实现只切会话，active 类停留在渲染时的旧状态）
                renderAgentList();
            });
            aiAgentList.appendChild(li);
        });
    }

    // "思考中"指示：发送后立即显示（豆包同款三点跳动），首段回复/失败时移除
    function showAIThinking(agent) {
        hideAIThinking(agent); // 连续提问时复用同一个指示气泡
        var div = document.createElement('div');
        div.className = 'message other ai-thinking';
        div.setAttribute('data-from', agent);
        var body = document.createElement('div');
        body.className = 'message-body';
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble ai-thinking-bubble';
        var label = document.createElement('span');
        label.className = 'ai-thinking-text';
        label.textContent = '思考中';
        var dots = document.createElement('span');
        dots.className = 'ai-thinking-dots';
        for (var i = 0; i < 3; i++) {
            dots.appendChild(document.createElement('i'));
        }
        bubble.appendChild(label);
        bubble.appendChild(dots);
        body.appendChild(bubble);
        div.appendChild(getAvatarEl(agent));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
        aiThinking[agent] = { el: div };
    }

    function hideAIThinking(agent) {
        var t = aiThinking[agent];
        if (t) {
            t.el.remove();
            delete aiThinking[agent];
        }
    }

    // 剪贴板复制：clipboard API 优先，不可用回退 execCommand（HTTP 环境兼容）
    function copyTextToClipboard(text) {
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('已复制'); } catch (e) { showToast('复制失败'); }
            ta.remove();
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { showToast('已复制'); }).catch(fallback);
        } else {
            fallback();
        }
    }

    // AI 回复操作栏（豆包同款）：复制回复 / 重新生成 / 编辑提问（SVG 线性图标，currentColor 跟随主题色）
    // fullText 为回复 Markdown 原文（复制原文，渲染样式不带出）
    // 阶段四十五：表格回复追加「导出 Excel/Word」——服务端归口转档（POST /export/ai/excel|word，
    // 服务端取回复原文解析转 xlsx 并以文件消息回发会话），msgId 缺失（流式未回填完）时不显示
    // tokens 为本次回复 Token 消耗（服务端 usage 归口，{total,prompt,completion}），无数据不显示
    function buildAIActionBar(agent, fullText, msgId, tokens) {
        var bar = document.createElement('div');
        bar.className = 'ai-actions';
        if (tokens && tokens.total > 0) {
            var tk = document.createElement('span');
            tk.className = 'ai-token-info';
            tk.title = '提示 ' + tokens.prompt + ' + 生成 ' + tokens.completion + ' = 共 ' + tokens.total + ' Tokens';
            tk.textContent = '⚡ ' + tokens.total + ' tokens';
            bar.appendChild(tk);
        }
        // 24x24 线性图标（Feather 风格），stroke=currentColor 使悬停变色跟随主题
        var ICONS = {
            copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
            redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
            edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
            excel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m9 13 6 6"/><path d="m15 13-6 6"/></svg>',
            word: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2l1 5 2-10 1 5h2"/></svg>',
            ppt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
        };
        function addBtn(title, icon, handler) {
            var b = document.createElement('span');
            b.className = 'ai-action-btn';
            b.title = title;
            b.innerHTML = icon; // 静态 SVG 常量，无用户内容
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                handler();
            });
            bar.appendChild(b);
        }
        addBtn('复制', ICONS.copy, function () { copyTextToClipboard(fullText); });
        // 重新生成：原样重发最近一次提问（含引用信封原文，服务端解析口径与首次发送一致）
        addBtn('重新生成', ICONS.redo, function () {
            var q = lastAIQuestion[agent];
            if (!q || !q.raw) { showToast('暂无原始提问，无法重新生成'); return; }
            IMSocket.send({ msg_type: MSG.AI_CHAT, to_user: agent, content: q.raw });
        });
        // 编辑提问：提问正文回填输入框，修改后自行发送
        addBtn('编辑提问', ICONS.edit, function () {
            var q = lastAIQuestion[agent];
            if (!q || !q.text) { showToast('暂无原始提问'); return; }
            messageInput.value = q.text;
            messageInput.focus();
        });
        // 阶段四十五：Markdown 表格 → 导出 Excel（服务端归口转档，文件消息回发会话）
        if (msgId && detectMarkdownTable(fullText)) {
            addBtn('导出 Excel', ICONS.excel, function () { exportAIDocument(msgId, 'excel'); });
        }
        // 原：Word 导出与 Excel 共用表格检测条件，纯文字回复无导出入口，用户感知"无法生成 Word"
        // if (msgId && detectMarkdownTable(fullText)) {
        //     addBtn('导出 Excel', ICONS.excel, function () { exportAIDocument(msgId, 'excel'); });
        //     addBtn('导出 Word', ICONS.word, function () { exportAIDocument(msgId, 'word'); });
        // }
        // Word 导出支持标题/段落/列表/引用/表格（aiParseMarkdownBlocks 归口），任何非空回复均可导出
        if (msgId) {
            addBtn('导出 Word', ICONS.word, function () { exportAIDocument(msgId, 'word'); });
        }
        // 阶段四十五：标题/要点结构 → 生成 PPT（前端 pptxgenjs 本地生成，直传回会话）
        if (detectMarkdownSlides(fullText)) {
            addBtn('生成 PPT', ICONS.ppt, function () { generateAIPpt(agent, fullText); });
        }
        return bar;
    }

    // 阶段四十五：检测文本是否含 Markdown 表格（表头行 + --- 分隔行），用于显隐导出按钮
    function detectMarkdownTable(text) {
        if (!text) return false;
        var lines = String(text).split('\n');
        for (var i = 0; i < lines.length - 1; i++) {
            if (/^\s*\|.+\|\s*$/.test(lines[i]) && /^\s*\|[\s:|\-]+\|\s*$/.test(lines[i + 1])) return true;
        }
        return false;
    }

    // 阶段四十五：导出 AI 文档（excel→xlsx / word→docx），成功后文件消息由服务端推送回会话
    function exportAIDocument(msgId, format) {
        var url = format === 'word' ? '/export/ai/word' : '/export/ai/excel';
        showToast('正在生成' + (format === 'word' ? ' Word' : ' Excel') + '…');
        fetch(url + '?msg_id=' + encodeURIComponent(msgId) + '&username=' + encodeURIComponent(IMSocket.getUsername()), {
            method: 'POST'
        }).then(function (res) {
            if (!res.ok) return res.text().then(function (t) { throw new Error(t || ('HTTP ' + res.status)); });
            return res.json();
        }).then(function (data) {
            if (data && data.url) showToast('已生成，文件已发送到会话');
            else throw new Error('响应缺少文件地址');
        }).catch(function (e) {
            showToast('导出失败：' + (e.message || e));
        });
    }

    // 阶段四十五：检测文本是否有演示文稿结构（标题行 或 ≥2 条列表项），用于显隐「生成 PPT」按钮
    function detectMarkdownSlides(text) {
        if (!text) return false;
        var lines = String(text).split('\n');
        var bullets = 0;
        for (var i = 0; i < lines.length; i++) {
            var t = lines[i].trim();
            if (/^#{1,4}\s+\S/.test(t)) return true;
            if (/^[-*]\s+\S/.test(t) || /^\d+\.\s+\S/.test(t)) bullets++;
            if (bullets >= 2) return true;
        }
        return false;
    }

    // 阶段四十五：Markdown 大纲 → 幻灯片数据（# 首个为封面页，##/### 分页，列表/段落为要点，表格入当前页）
    // 跳过代码块内容（代码不适合投影展示）
    function parseMarkdownSlides(text) {
        var slides = [];
        var cur = null;
        function newSlide(title) {
            cur = { title: title, items: [], table: null };
            slides.push(cur);
        }
        var lines = String(text).split('\n');
        var inCode = false;
        var firstH1 = true;
        for (var i = 0; i < lines.length; i++) {
            var t = lines[i].trim();
            if (/^```/.test(t)) { inCode = !inCode; continue; }
            if (inCode) continue;
            if (/^#\s+\S/.test(t)) {
                if (firstH1) {
                    // 首个一级标题作封面页
                    slides.push({ title: t.replace(/^#\s+/, ''), cover: true, items: [], table: null });
                    firstH1 = false;
                    cur = null;
                } else {
                    newSlide(t.replace(/^#\s+/, ''));
                }
            } else if (/^#{2,4}\s+\S/.test(t)) {
                newSlide(t.replace(/^#{2,4}\s+/, ''));
            } else if (/^\s*\|.+\|\s*$/.test(t) && i + 1 < lines.length && /^\s*\|[\s:|\-]+\|\s*$/.test(lines[i + 1].trim())) {
                var target = cur || (newSlide(slides.length ? slides[slides.length - 1].title : '数据表格'), slides[slides.length - 1]);
                var rows = [];
                var j = i;
                for (; j < lines.length; j++) {
                    var rl = lines[j].trim();
                    if (!/^\s*\|.+\|\s*$/.test(rl)) break;
                    if (/^\s*\|[\s:|\-]+\|\s*$/.test(rl)) continue;
                    rows.push(rl.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }));
                }
                if (rows.length) target.table = rows;
                i = j - 1;
            } else if (/^[-*]\s+\S/.test(t) || /^\d+\.\s+\S/.test(t)) {
                if (!cur) newSlide(slides.length ? slides[slides.length - 1].title : '内容');
                cur.items.push(t.replace(/^([-*]|\d+\.)\s+/, ''));
            } else if (t) {
                if (!cur) newSlide('内容');
                cur.items.push(t);
            }
        }
        return slides;
    }

    // 阶段四十五：AI 回复生成 PPT（前端 pptxgenjs 本地转档 → 复用 /upload/file 直传回会话，
    // 本地气泡 + 服务端落库 + FILE_PERSISTED 回填 msg_id 全走既有链路）
    function generateAIPpt(agent, text) {
        if (typeof PptxGenJS === 'undefined') { showToast('PPT 组件未加载，请刷新重试'); return; }
        var slides = parseMarkdownSlides(text);
        if (!slides.length) { showToast('没有可生成演示文稿的内容'); return; }
        showToast('正在生成 PPT…');
        try {
            var pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_16x9';
            var PRIMARY = '0B7C51'; // 主题绿（与 IM 主题色一致）
            slides.forEach(function (s) {
                var slide = pptx.addSlide();
                if (s.cover) {
                    slide.background = { color: PRIMARY };
                    slide.addText(s.title, { x: 0.5, y: 2.0, w: 9, h: 1.2, fontSize: 30, bold: true, color: 'FFFFFF', align: 'center' });
                    slide.addText('AI 生成 · ' + agent, { x: 0.5, y: 3.2, w: 9, h: 0.4, fontSize: 13, color: 'CFE8DB', align: 'center' });
                    return;
                }
                slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 23, bold: true, color: PRIMARY });
                var hasTable = s.table && s.table.length;
                if (s.items.length) {
                    var maxItems = hasTable ? 5 : 10;
                    var arr = s.items.slice(0, maxItems).map(function (it) {
                        return { text: it.length > 60 ? it.slice(0, 60) + '…' : it, options: { bullet: true, breakLine: true } };
                    });
                    slide.addText(arr, { x: 0.6, y: 1.15, w: 8.8, h: hasTable ? 2.4 : 4.3, fontSize: 15, color: '333333', valign: 'top' });
                }
                if (hasTable) {
                    var rows = s.table.slice(0, 7).map(function (r) {
                        return r.slice(0, 6).map(function (c) { return c.length > 20 ? c.slice(0, 20) + '…' : c; });
                    });
                    slide.addTable(rows, {
                        x: 0.6, y: hasTable && s.items.length ? 3.6 : 1.3, w: 8.8, fontSize: 12,
                        border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
                        headerRow: false, fill: { color: 'F5F7F6' }
                    });
                }
            });
            pptx.write({ outputType: 'blob' }).then(function (blob) {
                if (currentChatUser !== agent) { showToast('已切离会话，PPT 未发送'); return; }
                var file = new File([blob], 'AI演示_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
                sendFileDirect(file); // 直传链路：本地气泡 + 落库 + FILE_PERSISTED 回填
                showToast('PPT 已生成并发送到会话');
            }).catch(function (e) {
                showToast('PPT 生成失败：' + (e.message || e));
            });
        } catch (e) {
            showToast('PPT 生成失败：' + (e.message || e));
        }
    }

    // 阶段四十三：AI 代码块"复制代码"按钮（事件委托：流式/历史动态生成的代码块无需逐个绑定）
    messageList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.ai-code-copy') : null;
        if (!btn) return;
        var block = btn.closest('.ai-code-block');
        var codeEl = block ? block.querySelector('pre code') : null;
        if (codeEl) copyTextToClipboard(codeEl.textContent);
    });

    // 阶段四十三：列表栏折叠/展开（悬停聊天区左缘显示按钮，折叠后按钮常驻；
    // 解决 AI 长文本/宽代码被列表挤占看不全的问题；折叠状态持久化，刷新后保持）
    var listPanel = document.getElementById('list-panel');
    var listToggleBtn = document.getElementById('list-toggle-btn');
    function applyListCollapsed(c) {
        listPanel.classList.toggle('list-collapsed', c);
        listToggleBtn.classList.toggle('collapsed', c);
        listToggleBtn.title = c ? '展开列表' : '折叠列表';
    }
    try {
        applyListCollapsed(localStorage.getItem('im_list_collapsed') === '1');
    } catch (e) {}
    listToggleBtn.addEventListener('click', function () {
        var c = !listPanel.classList.contains('list-collapsed');
        applyListCollapsed(c);
        try { localStorage.setItem('im_list_collapsed', c ? '1' : '0'); } catch (e) {}
    });

    // 创建流式回复气泡（空气泡 + 闪烁光标，打字机逐字填充）
    function createStreamBubble(agent, streamId) {
        var div = document.createElement('div');
        div.className = 'message other';
        div.setAttribute('data-from', agent);
        div.setAttribute('data-stream-id', streamId);
        var body = document.createElement('div');
        body.className = 'message-body';
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble ai-stream-bubble';
        var text = document.createElement('span');
        text.className = 'ai-stream-text ai-md';
        var cursor = document.createElement('span');
        cursor.className = 'ai-stream-cursor';
        bubble.appendChild(text);
        bubble.appendChild(cursor);
        body.appendChild(bubble);
        div.appendChild(getAvatarEl(agent));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;
        return { el: div, textEl: text, cursorEl: cursor, pending: '', shown: '', timer: null, done: false, finalId: 0, agent: agent };
    }

    // 启动/复用打字机定时器：每 30ms 取一小段增量渲染（自适应步长，长文本加速追平）
    function ensureStreamTimer(st) {
        if (st.timer) return;
        st.timer = setInterval(function () {
            if (st.pending.length) {
                var step = Math.max(2, Math.ceil(st.pending.length / 15));
                st.shown += st.pending.slice(0, step);
                st.pending = st.pending.slice(step);
                // 阶段四十三：打字过程中同步渲染 Markdown（豆包同款，格式随输出逐步成型）
                st.textEl.innerHTML = renderAIMarkdown(st.shown);
                // 打字期间始终贴底跟随（微信/豆包同款体验）
                messageList.scrollTop = messageList.scrollHeight;
            }
            if (st.done && !st.pending.length) {
                clearInterval(st.timer);
                st.timer = null;
                finishStream(st);
            }
        }, 30);
    }

    // 流式回复收尾：去光标、回填消息 ID、发送已读回执（AI 回复计入未读，查看后归口清除）
    function finishStream(st) {
        st.cursorEl.remove();
        // 最终态兜底渲染一次 Markdown（done 时 pending 可能为空，tick 内不再触发渲染）
        st.textEl.innerHTML = renderAIMarkdown(st.shown);
        // 阶段四十三：回复完成后追加操作栏（复制/重新生成/编辑提问，豆包同款）
        // 阶段四十五：表格回复追加导出按钮（服务端归口转档，msg_id 用于取回复原文）
        // Token 消耗标注随操作栏渲染（服务端 usage 归口，随结束帧下发）
        var bodyEl = st.el.querySelector('.message-body');
        if (bodyEl && !bodyEl.querySelector('.ai-actions')) {
            bodyEl.appendChild(buildAIActionBar(st.agent, st.shown, st.finalId, st.tokens));
        }
        if (st.finalId) st.el.setAttribute('data-msg-id', st.finalId);
        var agent = st.el.getAttribute('data-from');
        delete aiStreams[st.el.getAttribute('data-stream-id')];
        if (st.finalId) sendReadReceipt(agent, st.finalId);
        if (!st.shown) st.el.remove(); // 空回复（服务端异常）：移除空气泡
    }

    // AI 流式增量：仅当前正查看该智能体会话时实时渲染（未查看时忽略，完整回复落库后经历史/会话摘要可见）
    IMSocket.on(MSG.AI_STREAM, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return; // 只处理自己的流
        if (currentChatUser !== msg.from_user) return;
        hideAIThinking(msg.from_user); // 首段回复到达，移除"思考中"指示
        removeAISuggestRow(); // 新一轮回复开始，移除上一轮的后续提问建议
        var st = aiStreams[msg.stream_id];
        if (!st) {
            st = createStreamBubble(msg.from_user, msg.stream_id);
            aiStreams[msg.stream_id] = st;
        }
        st.pending += msg.content || '';
        ensureStreamTimer(st);
    });

    // AI 流式结束：有流则收尾（END.content 为完整回复，仅在未曾收到增量时降级整段打字防重复）；
    // 无流（如降级路径）且正在查看该会话时补一条完整回复
    IMSocket.on(MSG.AI_STREAM_END, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        hideAIThinking(msg.from_user); // 失败/降级路径同样收起"思考中"指示
        var st = aiStreams[msg.stream_id];
        if (st) {
            if (!st.shown && !st.pending.length && msg.content) st.pending = msg.content;
            st.done = true;
            st.finalId = msg.msg_id || 0;
            // Token 消耗随结束帧下发（服务端 usage 归口），收尾时渲染到操作栏
            st.tokens = { total: msg.total_tokens || 0, prompt: msg.prompt_tokens || 0, completion: msg.completion_tokens || 0 };
            ensureStreamTimer(st);
            return;
        }
        if (msg.remark === 'error') return; // 失败且无气泡：服务端已 toast 提示
        if (currentChatUser === msg.from_user) {
            appendMessage(msg.from_user, msg.content, 'other', msg.msg_id, msg.timestamp, true, false,
                { total: msg.total_tokens || 0, prompt: msg.prompt_tokens || 0, completion: msg.completion_tokens || 0 });
            if (msg.msg_id) sendReadReceipt(msg.from_user, msg.msg_id);
        }
    });

    // ===== 阶段六十二：后续提问建议（Trae CN 同款，点击直接继续提问）=====
    // 服务端回复完成后异步生成、独立帧推送（晚于结束帧浮现）；仅渲染在最后一条回复下方
    function removeAISuggestRow() {
        var old = messageList.querySelector('.ai-suggest-row');
        if (old) old.remove();
    }

    function renderAISuggestRow(agent, list) {
        removeAISuggestRow();
        if (!list.length) return;
        var row = document.createElement('div');
        row.className = 'ai-suggest-row';
        list.forEach(function (q) {
            var chip = document.createElement('button');
            chip.className = 'ai-suggest-chip';
            chip.type = 'button';
            chip.textContent = q;
            chip.title = '点击发送：' + q;
            chip.addEventListener('click', function () {
                if (currentChatUser !== agent || !isAIAgent(agent)) return; // 已切走会话则不发送
                messageInput.value = q;
                removeAISuggestRow(); // 发送即消费，等新一轮回复再生成
                sendMessage(); // 复用既有提问链路（AI_CHAT 信封/思考中/上下文归口）
            });
            row.appendChild(chip);
        });
        messageList.appendChild(row);
        messageList.scrollTop = messageList.scrollHeight;
    }

    IMSocket.on(MSG.AI_SUGGEST, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;  // 只处理自己的建议
        if (currentChatUser !== msg.from_user) return;       // 仅当前正查看的会话渲染（切回会话不重放，与 Trae 一致）
        var list = [];
        try { list = JSON.parse(msg.content) || []; } catch (e) {}
        if (Array.isArray(list)) renderAISuggestRow(msg.from_user, list);
    });

    // ===== 阶段五十九：智能 Agent 任务模式（工具调用闭环 + 权限审批，事件流实时渲染） =====
    // 交互设计对齐 Trae CN：发起任务 → 任务卡片（清单+进度条）→ 思考/工具/审批子事件流 → 最终答复
    var agentMode = false;    // 当前是否处于 Agent 任务模式（仅 AI 智能体会话内可开启）
    var agentTaskCards = {};  // task_id → 任务卡片状态（切会话 DOM 清空但状态保留，重进不重放事件）

    function setAgentMode(on) {
        agentMode = on;
        agentModeBtn.classList.toggle('active', on);
        messageInput.placeholder = on ? '描述任务目标，Agent 将规划步骤并调用工具自动执行' : '输入消息';
    }

    agentModeBtn.addEventListener('click', function () {
        if (!currentChatUser || !isAIAgent(currentChatUser)) return;
        setAgentMode(!agentMode);
    });

    // ===== 阶段六十一：Agent 工作区/沙箱白名单面板（仅 PC 端本地执行器可用） =====
    // 主工作区=相对路径落盘根目录；授权目录白名单=绝对路径文件操作仅允许落在这些目录内（本地执行时强校验）。
    // 配置持久化在 PC 主进程本机文件（按用户名隔离，本地磁盘路径不上服务端库），保存成功后经 WS msg 52
    // 上报服务端注入 Agent 提示词（告知可用目录）；服务端仅内存保存用于提示，不据此放行任何路径。
    var agentWsMask = document.getElementById('agent-ws-mask');
    var agentWsDirsEl = document.getElementById('agent-ws-dirs');
    var agentWsPrimaryEl = document.getElementById('agent-ws-primary');
    var agentWsPrimary = ''; // 面板编辑态：主工作区目录（空=默认工作区）
    var agentWsDirs = [];    // 面板编辑态：授权目录列表

    // 是否支持本地工作区配置（仅 PC 端 preload 暴露了 sandbox API；Web 端工作区在服务端，无自选意义）
    function agentWsSupported() {
        return !!(window.desktop && typeof window.desktop.sandboxChoose === 'function');
    }

    // 渲染授权目录列表（每行：路径 + 移除按钮；空白名单给占位提示）
    function renderAgentWsDirs() {
        agentWsDirsEl.innerHTML = '';
        if (!agentWsDirs.length) {
            var empty = document.createElement('div');
            empty.className = 'agent-ws-empty';
            empty.textContent = '尚未授权任何目录（Agent 仅能操作主工作区内的相对路径）';
            agentWsDirsEl.appendChild(empty);
            return;
        }
        agentWsDirs.forEach(function (d, i) {
            var row = document.createElement('div');
            row.className = 'agent-ws-dir-row';
            var p = document.createElement('span');
            p.className = 'agent-ws-dir-path';
            p.textContent = d;
            p.title = d;
            var del = document.createElement('button');
            del.className = 'agent-ws-dir-del';
            del.title = '移除该目录';
            del.textContent = '×';
            del.addEventListener('click', function () {
                agentWsDirs.splice(i, 1);
                if (agentWsPrimary && agentWsDirs.indexOf(agentWsPrimary) < 0) agentWsPrimary = ''; // 主工作区被移除则回退默认工作区
                agentWsPrimaryEl.textContent = agentWsPrimary || '未设置（使用默认工作区）';
                agentWsPrimaryEl.title = agentWsPrimary || '';
                renderAgentWsDirs();
            });
            row.appendChild(p);
            row.appendChild(del);
            agentWsDirsEl.appendChild(row);
        });
    }

    // 打开面板：先从主进程拉取当前用户已保存配置填充编辑态
    function openAgentWsPanel() {
        if (!agentWsSupported()) { showToast('仅 PC 客户端支持自定义工作区'); return; }
        window.desktop.sandboxGet(IMSocket.getUsername()).then(function (cfg) {
            cfg = cfg || {};
            agentWsPrimary = cfg.primary || '';
            agentWsDirs = (cfg.dirs || []).slice();
            agentWsPrimaryEl.textContent = agentWsPrimary || '未设置（使用默认工作区）';
            agentWsPrimaryEl.title = agentWsPrimary || '';
            renderAgentWsDirs();
            agentWsMask.classList.remove('hidden');
        });
    }

    agentWsBtn.addEventListener('click', openAgentWsPanel);
    document.getElementById('agent-ws-close').addEventListener('click', function () {
        agentWsMask.classList.add('hidden');
    });
    agentWsMask.addEventListener('click', function (e) {
        if (e.target === agentWsMask) agentWsMask.classList.add('hidden'); // 点遮罩关闭
    });

    // 选择主工作区：原生目录对话框；主工作区自动并入授权目录（相对路径落盘依赖它，保存端也强制归一化）
    document.getElementById('agent-ws-pick').addEventListener('click', function () {
        window.desktop.sandboxChoose('选择主工作区文件夹').then(function (dir) {
            if (!dir) return;
            agentWsPrimary = dir;
            if (agentWsDirs.indexOf(dir) < 0) agentWsDirs.unshift(dir);
            agentWsPrimaryEl.textContent = dir;
            agentWsPrimaryEl.title = dir;
            renderAgentWsDirs();
        });
    });

    // 添加授权目录（重复选择去重；上限由主进程归一化裁剪）
    document.getElementById('agent-ws-add').addEventListener('click', function () {
        window.desktop.sandboxChoose('选择授权目录').then(function (dir) {
            if (!dir) return;
            if (agentWsDirs.indexOf(dir) < 0) {
                agentWsDirs.push(dir);
                renderAgentWsDirs();
            }
        });
    });

    // 保存：主进程归一化+持久化（本机文件）→ WS msg 52 上报服务端注入提示词 → 关面板
    document.getElementById('agent-ws-save').addEventListener('click', function () {
        var dirs = agentWsDirs.slice();
        if (agentWsPrimary && dirs.indexOf(agentWsPrimary) < 0) dirs.unshift(agentWsPrimary);
        window.desktop.sandboxSave({ username: IMSocket.getUsername(), primary: agentWsPrimary, dirs: dirs }).then(function (r) {
            if (!r || !r.ok) { showToast((r && r.msg) || '保存失败'); return; }
            agentWsPrimary = r.cfg.primary;
            agentWsDirs = r.cfg.dirs;
            IMSocket.send({
                msg_type: MSG.AGENT_SANDBOX,
                content: JSON.stringify({ primary: agentWsPrimary, dirs: agentWsDirs })
            });
            agentWsMask.classList.add('hidden');
            showToast('工作区配置已保存');
        });
    });

    // 任务卡片：每次任务一张容器卡片，内部追加思考/工具/审批子事件流
    function createAgentTaskCard(agent, taskId, goal) {
        var div = document.createElement('div');
        div.className = 'message other';
        var body = document.createElement('div');
        body.className = 'message-body';
        var card = document.createElement('div');
        card.className = 'agent-task-card';

        var head = document.createElement('div');
        head.className = 'agent-task-head';
        var title = document.createElement('span');
        title.className = 'agent-task-title';
        title.textContent = '任务';
        var goalEl = document.createElement('span');
        goalEl.className = 'agent-task-goal';
        goalEl.textContent = goal || '';
        goalEl.title = goal || '';
        var statusEl = document.createElement('span');
        statusEl.className = 'agent-task-status running';
        statusEl.textContent = '执行中';
        var stopBtn = document.createElement('button');
        stopBtn.className = 'agent-task-stop';
        stopBtn.textContent = '停止';
        stopBtn.addEventListener('click', function () {
            if (stopBtn.disabled) return;
            IMSocket.send({ msg_type: MSG.AGENT_RUN, content: JSON.stringify({ task_id: taskId, action: 'cancel' }) });
            stopBtn.disabled = true;
            stopBtn.textContent = '取消中…';
        });
        head.appendChild(title);
        head.appendChild(goalEl);
        head.appendChild(statusEl);
        head.appendChild(stopBtn);
        card.appendChild(head);

        // 进度条（todo_write 驱动：done/total；track 轨道 + bar 填充）
        var prog = document.createElement('div');
        prog.className = 'agent-task-progress';
        var track = document.createElement('div');
        track.className = 'agent-task-track';
        var bar = document.createElement('div');
        bar.className = 'agent-task-bar';
        track.appendChild(bar);
        var pct = document.createElement('span');
        pct.className = 'agent-task-pct';
        pct.textContent = '0%';
        prog.appendChild(track);
        prog.appendChild(pct);
        card.appendChild(prog);

        var todoList = document.createElement('div');
        todoList.className = 'agent-todo-list hidden';
        card.appendChild(todoList);

        var events = document.createElement('div');
        events.className = 'agent-events';
        card.appendChild(events);

        body.appendChild(card);
        div.appendChild(getAvatarEl(agent));
        div.appendChild(body);
        messageList.appendChild(div);
        messageList.scrollTop = messageList.scrollHeight;

        var st = { taskId: taskId, agent: agent, el: div, statusEl: statusEl, stopBtn: stopBtn, bar: bar, pct: pct, todoList: todoList, events: events, tools: {}, toolGroup: null };
        agentTaskCards[taskId] = st;
        createAgentTaskDock(st, goal); // 阶段六十二（完整版）：输入区上方常驻任务栏
        return st;
    }

    // ===== 阶段六十二（完整版）：底部常驻任务栏（Trae 同款）=====
    // 任务运行期间在输入区上方常驻"N/M 个任务已完成"，点击展开清单面板；任务结束后隐藏
    function createAgentTaskDock(st, goal) {
        var inputBar = document.querySelector('.input-bar');
        if (!inputBar || !inputBar.parentNode) return;
        var dock = document.createElement('div');
        dock.className = 'agent-task-dock';
        var icon = document.createElement('span');
        icon.className = 'agent-task-dock-icon';
        icon.textContent = '☑';
        var text = document.createElement('span');
        text.className = 'agent-task-dock-text';
        text.textContent = goal || '任务执行中';
        text.title = goal || '';
        var count = document.createElement('span');
        count.className = 'agent-task-dock-count';
        count.textContent = '0/0 个任务已完成';
        var arrow = document.createElement('span');
        arrow.className = 'agent-task-dock-arrow';
        dock.appendChild(icon);
        dock.appendChild(text);
        dock.appendChild(count);
        dock.appendChild(arrow);
        var panel = document.createElement('div');
        panel.className = 'agent-task-dock-panel hidden';
        dock.addEventListener('click', function () {
            panel.classList.toggle('hidden');
            dock.classList.toggle('open');
        });
        var parent = inputBar.parentNode;
        parent.insertBefore(dock, inputBar);
        parent.insertBefore(panel, inputBar);
        st.dock = dock;
        st.dockCount = count;
        st.dockPanel = panel;
    }

    function agentTaskScroll() {
        messageList.scrollTop = messageList.scrollHeight;
    }

    function setAgentTaskStatus(st, text, cls) {
        st.statusEl.textContent = text;
        if (cls === 'running') st.statusEl.appendChild(agentDotsEl()); // 执行中：附跳动三点（其他状态仅文字）
        st.statusEl.className = 'agent-task-status ' + (cls || 'running');
    }

    function finishAgentTask(st, text, cls) {
        setAgentTaskStatus(st, text, cls);
        st.stopBtn.disabled = true;
        st.stopBtn.textContent = '已结束';
        // 阶段六十二（完整版）：任务结束收起底部任务栏（卡片内已完成状态接管）
        if (st.dock) st.dock.classList.add('hidden');
        if (st.dockPanel) st.dockPanel.classList.add('hidden');
    }

    // 思考事件：可折叠子块（新一轮思考默认展开，旧的自动折叠，避免卡片过长）
    function addAgentThought(st, text) {
        if (st.events.querySelector('.agent-event.thought.collapsed')) {
            // 无操作：旧思考块保持折叠状态
        }
        var olds = st.events.querySelectorAll('.agent-event.thought:not(.collapsed)');
        for (var i = 0; i < olds.length; i++) olds[i].classList.add('collapsed');
        var block = document.createElement('div');
        block.className = 'agent-event thought';
        var head = document.createElement('div');
        head.className = 'agent-event-head';
        head.textContent = '思考';
        head.addEventListener('click', function () { block.classList.toggle('collapsed'); });
        var bodyEl = document.createElement('div');
        bodyEl.className = 'agent-event-body ai-md';
        bodyEl.innerHTML = renderAIMarkdown(text || '');
        block.appendChild(head);
        block.appendChild(bodyEl);
        st.events.appendChild(block);
        agentTaskScroll();
    }

    // 阶段六十二：工具人性化映射（Trae CN 同款）——中文标题 + 关键参数芯片（路径/命令/条目数）
    var AGENT_TOOL_TITLE = { read_file: '读取文件', write_file: '写入文件', run_command: '执行命令', todo_write: '更新任务清单' };

    function agentToolChipText(tool, params) {
        var p = params || {};
        if (tool === 'read_file' || tool === 'write_file') return String(p.path || p.file || '');
        if (tool === 'run_command') return String(p.command || p.cmd || '');
        if (tool === 'todo_write') {
            var n = Object.prototype.toString.call(p.todos) === '[object Array]' ? p.todos.length : 0;
            return n ? n + ' 项任务' : '';
        }
        return '';
    }

    // ===== 阶段六十二：Agent 执行动态反馈 =====
    // 跳动三点（复用普通 AI 聊天"思考中"的点动画样式）：思考中标签、工具执行中、任务状态共用
    function agentDotsEl() {
        var dots = document.createElement('span');
        dots.className = 'ai-thinking-dots';
        dots.innerHTML = '<i></i><i></i><i></i>';
        return dots;
    }

    // ===== 阶段六十二：Agent 流式文本块（Trae CN 同款打字机）=====
    // text_delta/thought_delta 增量进入同一流式块；归类在收尾时确定：
    // tool_start 到来 → 收尾为"思考过程"折叠块；done → 收尾为正文（保持展开，Trae 同款）
    function agentStreamText(st, delta) {
        var cur = st.curText;
        if (!cur) {
            var block = document.createElement('div');
            block.className = 'agent-event textstream';
            var head = document.createElement('div');
            head.className = 'agent-stream-head';
            head.textContent = '思考中';
            head.appendChild(agentDotsEl()); // 动态三点：正在生成，非卡住
            var bodyEl = document.createElement('div');
            bodyEl.className = 'agent-event-body ai-md';
            var span = document.createElement('span');
            span.className = 'agent-stream-text';
            var cursor = document.createElement('span');
            cursor.className = 'ai-stream-cursor';
            bodyEl.appendChild(span);
            bodyEl.appendChild(cursor);
            block.appendChild(head);
            block.appendChild(bodyEl);
            st.events.appendChild(block);
            cur = st.curText = { el: block, head: head, textEl: span, cursorEl: cursor, pending: '', shown: '', timer: null };
            cur.timer = setInterval(function () {
                if (cur.pending.length) {
                    var step = Math.max(2, Math.ceil(cur.pending.length / 15));
                    cur.shown += cur.pending.slice(0, step);
                    cur.pending = cur.pending.slice(step);
                    cur.textEl.innerHTML = renderAIMarkdown(cur.shown);
                    agentTaskScroll();
                }
            }, 30);
        }
        cur.pending += delta || '';
    }

    // 收尾流式块：asThought=true 归类思考过程（折叠），false 归类正文（展开）。
    // 返回是否收尾了非空内容（done 据此跳过重复的整段结果气泡）
    function agentFinalizeText(st, asThought) {
        var cur = st.curText;
        if (!cur) return false;
        clearInterval(cur.timer);
        cur.timer = null;
        cur.pending = '';
        cur.cursorEl.remove();
        st.curText = null;
        if (!cur.shown.trim()) { cur.el.remove(); return false; }
        cur.textEl.innerHTML = renderAIMarkdown(cur.shown);
        if (asThought) {
            cur.el.classList.add('thought');
            cur.head.textContent = '思考过程';
            cur.head.addEventListener('click', function () { cur.el.classList.toggle('collapsed'); });
            cur.el.classList.add('collapsed');
        } else {
            cur.el.classList.add('answer');
            cur.head.remove(); // 正文直出（Trae 同款无标题）
        }
        agentTaskScroll();
        return true;
    }

    // 工具事件：tool_start 建块等待结果回填（同一 tool_call 一块）
    // 阶段六十二：人性化渲染——标题行（中文标题+芯片）+ 折叠详情（参数 JSON/输出），Trae CN 同款
    function addAgentTool(st, ev) {
        var block = document.createElement('div');
        block.className = 'agent-event tool pending';
        var head = document.createElement('div');
        head.className = 'agent-event-head';
        var title = document.createElement('span');
        title.className = 'agent-tool-title';
        title.textContent = AGENT_TOOL_TITLE[ev.tool] || ('工具 · ' + (ev.tool || ''));
        head.appendChild(title);
        var chip = agentToolChipText(ev.tool, ev.params);
        if (chip) {
            var chipEl = document.createElement('span');
            chipEl.className = 'agent-tool-chip';
            chipEl.textContent = chip;
            chipEl.title = chip;
            head.appendChild(chipEl);
        }
        // 阶段六十：执行环境标签（pc=用户本地 / server=服务端，tool_result 回填时按真实环境更新）
        head.appendChild(buildAgentEnvTag(ev.env));
        // 阶段六十二：执行中动态指示（"执行中"文字 + 跳动三点），命令/本地执行耗时时表明未卡住
        var running = document.createElement('span');
        running.className = 'agent-tool-running';
        running.textContent = '执行中';
        running.appendChild(agentDotsEl());
        head.appendChild(running);
        var argsEl = document.createElement('pre');
        argsEl.className = 'agent-event-args';
        argsEl.textContent = JSON.stringify(ev.params || {}, null, 2);
        var outEl = document.createElement('pre');
        outEl.className = 'agent-event-output hidden';
        block.appendChild(head);
        block.appendChild(argsEl);
        block.appendChild(outEl);
        block.setAttribute('data-tool', ev.tool || ''); // 阶段六十二：回填匹配键（标题已中文化，不再含原始工具名）
        // 参数默认折叠（Trae 同款简洁行），点击标题展开/收起
        block.classList.add('collapsed');
        head.addEventListener('click', function () { block.classList.toggle('collapsed'); });
        // 阶段六十二（完整版）：连续同类操作分组汇总（Trae 同款"已编辑 N 个文件，执行 M 条命令"）
        // 仅 write_file/run_command 参与分组；组后被任何其他事件打断（思考/文本/读文件/清单行成为最后子块）则重新开组
        var cat = ev.tool === 'write_file' ? 'w' : (ev.tool === 'run_command' ? 'c' : '');
        if (cat && st.toolGroup && st.events.lastElementChild === st.toolGroup.el) {
            st.toolGroup[cat]++;
            updateAgentGroupHead(st.toolGroup);
            st.toolGroup.body.appendChild(block);
        } else if (cat) {
            if (st.toolGroup) st.toolGroup.el.classList.remove('open'); // 旧组自动收起，仅保留当前组展开
            var gEl = document.createElement('div');
            gEl.className = 'agent-tool-group open';
            var gHead = document.createElement('div');
            gHead.className = 'agent-tool-group-head';
            var gBody = document.createElement('div');
            gBody.className = 'agent-tool-group-body';
            gEl.appendChild(gHead);
            gEl.appendChild(gBody);
            var group = { el: gEl, head: gHead, body: gBody, w: cat === 'w' ? 1 : 0, c: cat === 'c' ? 1 : 0 };
            gHead.addEventListener('click', function () { gEl.classList.toggle('open'); });
            updateAgentGroupHead(group);
            st.toolGroup = group;
            st.events.appendChild(gEl);
            gBody.appendChild(block);
        } else {
            st.toolGroup = null; // 读文件/清单等独立行打断分组
            st.events.appendChild(block);
        }
        st.tools[ev.tool + ':' + st.events.children.length] = block; // 占位（真实关联按 tool 名回填兜底）
        agentTaskScroll();
    }

    // 分组汇总标题："已编辑 N 个文件，执行 M 条命令"（含项数角标，点击组头展开/收起）
    function updateAgentGroupHead(g) {
        var parts = [];
        if (g.w > 0) parts.push('已编辑 ' + g.w + ' 个文件');
        if (g.c > 0) parts.push('执行 ' + g.c + ' 条命令');
        if (!parts.length) parts.push('执行操作');
        g.head.textContent = parts.join('，');
        var cnt = document.createElement('span');
        cnt.className = 'agent-tool-group-count';
        cnt.textContent = (g.w + g.c) + ' 项';
        g.head.appendChild(cnt);
    }

    // 阶段六十：执行环境小标签（跟随主题色，"本地执行"标识文件落在用户电脑）
    function buildAgentEnvTag(env) {
        var tag = document.createElement('span');
        tag.className = 'agent-env-tag' + (env === 'pc' ? ' pc' : '');
        tag.textContent = env === 'pc' ? '本地执行' : '服务端执行';
        return tag;
    }

    function fillAgentTool(st, ev) {
        // 回填规则：优先匹配该工具名最后一个 pending 块（阶段六十二：按 data-tool 匹配，标题已中文化）
        var blocks = st.events.querySelectorAll('.agent-event.tool.pending');
        var block = null;
        for (var i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].getAttribute('data-tool') === (ev.tool || '')) { block = blocks[i]; break; }
        }
        if (!block) { addAgentTool(st, { tool: ev.tool, params: {} }); blocks = st.events.querySelectorAll('.agent-event.tool.pending'); block = blocks[blocks.length - 1]; }
        block.classList.remove('pending');
        block.classList.add(ev.ok === false ? 'fail' : 'ok');
        var running = block.querySelector('.agent-tool-running');
        if (running) running.remove(); // 结果摘要行（✓/✕）接管执行态展示
        var outEl = block.querySelector('.agent-event-output');
        outEl.textContent = ev.output || '';
        outEl.classList.remove('hidden');
        // 阶段六十二：结果摘要行（输出首行常显）——"已编辑 main.go（+1 -1，34 字节）"/"命令已执行 xxx"/错误首行
        var firstLine = (ev.output || '').split('\n')[0] || '';
        if (firstLine.length > 120) firstLine = firstLine.slice(0, 120) + '…';
        var resultLine = document.createElement('div');
        resultLine.className = 'agent-tool-result' + (ev.ok === false ? ' fail' : '');
        resultLine.textContent = (ev.ok === false ? '✕ ' : '✓ ') + firstLine;
        var head = block.querySelector('.agent-event-head');
        head.parentNode.insertBefore(resultLine, head.nextSibling);
        // 失败自动展开详情（错误立即可见），成功保持折叠简洁行
        if (ev.ok === false) block.classList.remove('collapsed');
        // 阶段六十：按真实执行环境更新标签（tool_start 的 env 仅为预判——本地等待超时会回退服务端）
        if (ev.env) {
            var oldTag = head.querySelector('.agent-env-tag');
            if (oldTag) oldTag.remove();
            head.appendChild(buildAgentEnvTag(ev.env));
        }
        agentTaskScroll();
    }

    // 任务清单事件：全量重绘清单 + 进度条（Trae 同款实时反馈）
    function renderAgentTodo(st, ev) {
        var todos = ev.todos || [];
        st.todoList.innerHTML = '';
        st.todoList.classList.remove('hidden');
        todos.forEach(function (t) {
            var item = document.createElement('div');
            item.className = 'agent-todo-item ' + (t.status || 'pending');
            var mark = document.createElement('span');
            mark.className = 'agent-todo-mark';
            mark.textContent = t.status === 'done' ? '✓' : (t.status === 'in_progress' ? '▸' : '○');
            var text = document.createElement('span');
            text.className = 'agent-todo-text';
            text.textContent = t.content || '';
            item.appendChild(mark);
            item.appendChild(text);
            st.todoList.appendChild(item);
        });
        var done = ev.done || 0, total = ev.total || todos.length || 1;
        var percent = Math.round((done / total) * 100);
        st.bar.style.width = percent + '%';
        st.pct.textContent = percent + '%';
        // 阶段六十二（完整版）：底部任务栏同步（计数 + 清单面板镜像）
        if (st.dockCount) st.dockCount.textContent = done + '/' + total + ' 个任务已完成';
        if (st.dockPanel) {
            st.dockPanel.innerHTML = '';
            todos.forEach(function (t) {
                var item = document.createElement('div');
                item.className = 'agent-todo-item ' + (t.status || 'pending');
                var mark = document.createElement('span');
                mark.className = 'agent-todo-mark';
                mark.textContent = t.status === 'done' ? '✓' : (t.status === 'in_progress' ? '▸' : '○');
                var text = document.createElement('span');
                text.className = 'agent-todo-text';
                text.textContent = t.content || '';
                item.appendChild(mark);
                item.appendChild(text);
                st.dockPanel.appendChild(item);
            });
        }
        agentTaskScroll();
    }

    // Agent 事件流分发（事件不落库：仅当前会话实时渲染，切换会话后不重放）
    IMSocket.on(MSG.AGENT_EVENT, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        var ev;
        try { ev = JSON.parse(msg.content); } catch (e) { return; }
        if (!ev || !ev.task_id) return;
        if (currentChatUser !== msg.from_user) return; // 仅当前会话实时渲染
        var st = agentTaskCards[ev.task_id];
        if (ev.type === 'status' && ev.status === 'running' && ev.goal && !st) {
            st = createAgentTaskCard(msg.from_user, ev.task_id, ev.goal);
        }
        if (!st) return;
        switch (ev.type) {
            case 'status':
                if (ev.status === 'waiting_approval') setAgentTaskStatus(st, '等待审批', 'waiting');
                else if (ev.status === 'running') setAgentTaskStatus(st, '执行中', 'running');
                else if (ev.status === 'cancelled') { agentFinalizeText(st, true); finishAgentTask(st, '已取消', 'cancelled'); }
                break;
            case 'thought': addAgentThought(st, ev.text); break;
            case 'text_delta': case 'thought_delta': agentStreamText(st, ev.text); break; // 阶段六十二：流式打字
            case 'tool_start':
                agentFinalizeText(st, true); // 流式文本归入"思考过程"折叠块（Trae 同款：出工具即收思考）
                addAgentTool(st, ev);
                break;
            case 'tool_result': fillAgentTool(st, ev); break;
            case 'todo': renderAgentTodo(st, ev); break;
            case 'done':
                st.bar.style.width = '100%';
                st.pct.textContent = '100%';
                finishAgentTask(st, '已完成', 'done');
                // 阶段六十二：最终答复已流式打字输出时直接收尾为正文，不再重复渲染整段气泡
                if (ev.result) {
                    if (!agentFinalizeText(st, false)) {
                        // 最终答复以正常 AI 消息气泡展示（含 Markdown 渲染与操作栏）
                        appendMessage(st.agent, ev.result, 'other', 0, msg.timestamp, true);
                    }
                } else {
                    agentFinalizeText(st, true);
                }
                break;
            case 'error':
                agentFinalizeText(st, true);
                finishAgentTask(st, '失败', 'failed');
                showToast(ev.message || '任务执行失败');
                break;
        }
    });

    // 审批请求卡片：参数 JSON 可直接编辑（改参放行），同意/拒绝上行归口
    IMSocket.on(MSG.AGENT_APPROVE_REQ, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        var ev;
        try { ev = JSON.parse(msg.content); } catch (e) { return; }
        if (!ev || !ev.task_id) return;
        if (currentChatUser !== msg.from_user) return;
        var st = agentTaskCards[ev.task_id];
        if (!st) return;

        var block = document.createElement('div');
        block.className = 'agent-event approve';
        var head = document.createElement('div');
        head.className = 'agent-event-head approve';
        head.textContent = '需要审批 · ' + (ev.tool || '');
        var reason = document.createElement('div');
        reason.className = 'agent-approve-reason';
        reason.textContent = ev.reason || '该操作需要确认';
        var editor = document.createElement('textarea');
        editor.className = 'agent-approve-params';
        editor.rows = 4;
        editor.value = JSON.stringify(ev.params || {}, null, 2);
        var actions = document.createElement('div');
        actions.className = 'agent-approve-actions';
        var okBtn = document.createElement('button');
        okBtn.className = 'agent-approve-ok';
        okBtn.textContent = '同意执行';
        // 阶段六十二：同意并加入白名单——run_command 放行该命令首词（链式命令除外），write_file 开启写文件免审批，
        // 服务端 DB 持久化，重启不丢；后续同类操作不再弹审批
        var wlBtn = document.createElement('button');
        wlBtn.className = 'agent-approve-wl';
        wlBtn.textContent = '同意并加白';
        wlBtn.title = ev.tool === 'write_file' ? '同意本次，且之后的写文件操作不再需要审批'
            : '同意本次，且之后以相同命令开头的操作不再需要审批（链式命令除外）';
        var noBtn = document.createElement('button');
        noBtn.className = 'agent-approve-no';
        noBtn.textContent = '拒绝';
        actions.appendChild(okBtn);
        actions.appendChild(wlBtn);
        actions.appendChild(noBtn);
        block.appendChild(head);
        block.appendChild(reason);
        block.appendChild(editor);
        block.appendChild(actions);
        st.events.appendChild(block);
        agentTaskScroll();

        function settle(done) {
            okBtn.disabled = true;
            wlBtn.disabled = true;
            noBtn.disabled = true;
            editor.disabled = true;
            block.classList.add('settled');
            var tip = document.createElement('div');
            tip.className = 'agent-approve-tip';
            tip.textContent = done;
            block.appendChild(tip);
        }

        function sendApprove(action, doneText) {
            var params = null;
            try { params = JSON.parse(editor.value); } catch (e) {
                showToast('参数 JSON 格式错误，请修正后再同意');
                return;
            }
            IMSocket.send({
                msg_type: MSG.AGENT_APPROVE,
                content: JSON.stringify({ task_id: ev.task_id, step: ev.step, action: action, params: params })
            });
            settle(doneText);
        }

        okBtn.addEventListener('click', function () {
            if (okBtn.disabled) return;
            sendApprove('approve', '已同意');
        });
        wlBtn.addEventListener('click', function () {
            if (wlBtn.disabled) return;
            sendApprove('whitelist', '已同意并加入白名单，同类操作后续不再提示');
        });
        noBtn.addEventListener('click', function () {
            if (noBtn.disabled) return;
            IMSocket.send({
                msg_type: MSG.AGENT_APPROVE,
                content: JSON.stringify({ task_id: ev.task_id, step: ev.step, action: 'reject' })
            });
            settle('已拒绝，等待 Agent 调整方案');
        });
    });

    // ===== 阶段六十：Agent 本地执行器桥接（仅 PC 端生效） =====
    // 服务端下发的本地执行请求（50）经 preload 暴露的 agentExec 转发主进程执行，结果（51）回传服务端。
    // Web/手机端无 window.desktop.agentExec，不注册监听，服务端对其永远走服务端执行（hub.HasPC=false）
    if (window.desktop && typeof window.desktop.agentExec === 'function') {
        IMSocket.on(MSG.AGENT_EXEC_REQ, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (!ev || !ev.task_id || !ev.step) return;
            // 请求里带当前登录用户名：主进程按用户名隔离本地工作区（防同机多账号串目录）
            var req = { username: IMSocket.getUsername(), tool: ev.tool, params: ev.params || {} };
            window.desktop.agentExec(req).then(function (res) {
                IMSocket.send({
                    msg_type: MSG.AGENT_EXEC_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({
                        task_id: ev.task_id, step: ev.step,
                        ok: !!(res && res.ok), output: (res && res.output) || ''
                    })
                });
            }).catch(function (err) {
                // IPC 链路异常（主进程执行器崩溃等）：按工具级失败回传，模型据此调整方案
                IMSocket.send({
                    msg_type: MSG.AGENT_EXEC_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({
                        task_id: ev.task_id, step: ev.step, ok: false,
                        output: '错误：本地执行器异常 ' + (err && err.message || err)
                    })
                });
            });
        });
    }

    // 阶段四十三：代码块渲染（豆包同款：标题栏=语言名+复制按钮；highlight.js 本地语法高亮，
    // 库未加载/不支持的语言自动回退纯文本转义，不影响降级路径）
    function renderCodeBlock(lang, code) {
        var displayLang = lang || '';
        var H = (typeof hljs !== 'undefined') ? hljs : null;
        var highlighted = null;
        if (H && code) {
            try {
                if (lang && H.getLanguage(lang.toLowerCase())) {
                    highlighted = H.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true }).value;
                } else if (!lang) {
                    // 无语言标记：自动检测（检测结果回显到标题栏）
                    var auto = H.highlightAuto(code);
                    highlighted = auto.value;
                    if (auto.language) displayLang = auto.language;
                }
            } catch (e) { highlighted = null; }
        }
        if (highlighted === null) {
            // 回退：手动 HTML 转义（hljs 未加载/语言不支持时仍保持代码框样式）
            highlighted = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
        return '<div class="ai-code-block">'
            + '<div class="ai-code-head">'
            + '<span class="ai-code-lang">' + (displayLang || '代码') + '</span>'
            + '<span class="ai-code-copy" title="复制代码">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'
            + '</span></div>'
            + '<pre class="ai-md-pre"><code class="hljs">' + highlighted + '</code></pre>'
            + '</div>';
    }

    // 阶段四十三：AI 消息 Markdown 渲染（安全白名单版）
    // 先整体 HTML 转义防注入，再仅转换：代码块/行内代码/链接(仅http/s)/无序列表/有序列表/标题/加粗/斜体，
    // 其余 Markdown 语法（表格/脚注等）按纯文本显示，AI 未使用语法时与纯文本渲染视觉一致
    function renderAIMarkdown(text) {
        if (!text) return '';
        var raw = String(text);

        // 代码块 ```...``` 先在原文上提取占位（hljs 需要未经转义的原始代码）：
        // 阶段四十三优化：AI 偶尔漏写收尾 ```（流式输出中途更常见），奇数个围栏时自动补闭合，
        // 避免整段代码连同 ``` 符号原样漏出（豆包同款行为）
        if (((raw.match(/```/g) || []).length) % 2 === 1) {
            raw += '\n```';
        }
        var codeBlocks = [];
        raw = raw.replace(/```[ \t]*(\w*)[ \t]*\n?([\s\S]*?)```/g, function (_, lang, code) {
            codeBlocks.push(renderCodeBlock(lang, code.replace(/\n$/, '')));
            return '\u0000CB' + (codeBlocks.length - 1) + '\u0000';
        });

        // 剩余文本整体转义防注入，再做白名单行内/块级转换
        var esc = raw
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // 阶段四十五：Markdown 表格（表头行 + | --- | 分隔行 + 数据行）→ 真表格。
        // 行级扫描提取占位（先于列表/加粗等转换，避免表格结构被行内规则破坏）；单元格内支持 **加粗**
        var tables = [];
        esc = (function (src) {
            var lines = src.split('\n');
            var out = [];
            var rowRe = /^\s*\|.+\|\s*$/;
            var sepRe = /^\s*\|[\s:|\-]+\|\s*$/;
            function cell(c) {
                return String(c).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            }
            for (var i = 0; i < lines.length; i++) {
                if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
                    var rows = [];
                    var j = i;
                    for (; j < lines.length; j++) {
                        if (!rowRe.test(lines[j])) break;
                        if (sepRe.test(lines[j])) continue; // 分隔行不进数据（正文中重复分隔行跳过）
                        var cells = lines[j].trim().replace(/^\||\|$/g, '').split('|').map(function (c) {
                            return c.trim().replace(/\\\|/g, '|');
                        });
                        rows.push(cells);
                    }
                    if (rows.length >= 1) {
                        var h = rows[0];
                        var html = '<div class="ai-md-table-wrap"><table class="ai-md-table"><thead><tr>';
                        h.forEach(function (c) { html += '<th>' + cell(c) + '</th>'; });
                        html += '</tr></thead><tbody>';
                        for (var k = 1; k < rows.length; k++) {
                            html += '<tr>';
                            for (var c2 = 0; c2 < h.length; c2++) html += '<td>' + cell(rows[k][c2] || '') + '</td>';
                            html += '</tr>';
                        }
                        html += '</tbody></table></div>';
                        tables.push(html);
                        out.push('\u0000TB' + (tables.length - 1) + '\u0000');
                    }
                    i = j - 1;
                    continue;
                }
                out.push(lines[i]);
            }
            return out.join('\n');
        })(esc);

        // 行内代码 `...` 提取占位
        var inlineCodes = [];
        esc = esc.replace(/`([^`\n]+)`/g, function (_, c) {
            inlineCodes.push('<code class="ai-md-code">' + c.trim() + '</code>');
            return '\u0000IC' + (inlineCodes.length - 1) + '\u0000';
        });
        // 链接 [text](url)：仅允许 http/https，防 javascript: 注入
        esc = esc.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a class="ai-md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        // 阶段四十三优化：水平分隔线 --- / *** / ___（独占一行）转为 <hr>，避免原样漏出符号
        esc = esc.replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '<hr class="ai-md-hr">');
        // 阶段四十三优化：引用行 > 文字 转为引用块（转义后 > 为 &gt;），避免 ">" 原样漏出
        esc = esc.replace(/^&gt;[ \t]?(.*)$/gm, '<blockquote class="ai-md-quote">$1</blockquote>');
        // 无序列表：连续的 * / - 开头行合并为 ul（块级转换先于行内加粗斜体，避免列表符号被误转斜体）
        esc = esc.replace(/((?:^[ \t]*[\*\-][ \t]+[^\n]+(?:\n|$))+)/gm, function (block) {
            var items = block.trim().split('\n').map(function (l) {
                return '<li>' + l.replace(/^[ \t]*[\*\-][ \t]+/, '') + '</li>';
            }).join('');
            return '<ul class="ai-md-ul">' + items + '</ul>';
        });
        // 有序列表：连续的 1. 2. 开头行合并为 ol
        esc = esc.replace(/((?:^[ \t]*\d+\.[ \t]+[^\n]+(?:\n|$))+)/gm, function (block) {
            var items = block.trim().split('\n').map(function (l) {
                return '<li>' + l.replace(/^[ \t]*\d+\.[ \t]+/, '') + '</li>';
            }).join('');
            return '<ol class="ai-md-ol">' + items + '</ol>';
        });
        // 标题 # ~ ####：转为加粗行（聊天气泡内不需要真正的大标题层级）
        esc = esc.replace(/^#{1,4}[ \t]+([^\n]+)$/gm, '<strong>$1</strong>');
        // 加粗 **...**（先于斜体，避免 ** 被斜体规则拆解）
        esc = esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // 斜体 *...*（排除行首列表符号残余与相邻星号）
        esc = esc.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        // 换行转 <br>（占位的代码块/行内代码不含换行，不受影响）
        esc = esc.replace(/\n/g, '<br>');
        // 还原占位
        esc = esc.replace(/\u0000CB(\d+)\u0000/g, function (_, i) { return codeBlocks[+i]; });
        esc = esc.replace(/\u0000TB(\d+)\u0000/g, function (_, i) { return tables[+i]; });
        esc = esc.replace(/\u0000IC(\d+)\u0000/g, function (_, i) { return inlineCodes[+i]; });
        return esc;
    }

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
            // 阶段四十三：AI 智能体无配置头像时回退 🤖 占位（与 AI 列表口径一致，原实现降级首字母不一致）
            var avatarFallback = !isGroup && isAIAgent(cv.target) ? '🤖' : convName.charAt(0).toUpperCase();
            if (avatarUrl) {
                var avatarImg = document.createElement('img');
                avatarImg.src = avatarUrl;
                avatarImg.alt = '';
                // 头像文件失效（文件被清理/路径变更）时降级占位，避免破图
                avatarImg.addEventListener('error', function () {
                    avatarImg.remove();
                    avatar.textContent = avatarFallback;
                });
                avatar.appendChild(avatarImg);
            } else {
                avatar.textContent = avatarFallback;
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
            // 标题栏在线状态联动：当前打开的会话正是该好友时，同步刷新"在线/离线"显示
            // 原实现：只更新好友列表，标题栏状态停留在打开会话时的旧值，出现"提示下线了但标题栏仍显示在线"
            updateChatTitle();
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
            // 已读状态随回显帧下发（服务端归口）：AI 提问回显 is_read=true 显示"已读"；
            // 普通私聊帧无该字段保持"未读"，由对方阅读回执链路更新
            appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id, msg.timestamp, true,
                isMine ? msg.is_read === true : undefined);
            // 阶段四十三：发给 AI 智能体的提问上屏后，紧随其后显示"思考中"指示（服务端回显先于流式帧送达，时序稳定）
            if (isMine && isAIAgent(msg.to_user)) {
                showAIThinking(msg.to_user);
            }
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
        // 阶段五十九：Agent 任务模式按钮仅 AI 智能体会话可用；切换会话退出任务模式
        if (agentMode) setAgentMode(false);
        agentModeBtn.classList.toggle('hidden', !(user && isAIAgent(user)));
        // 阶段六十一：工作区按钮与 Agent 模式按钮同显隐，但仅 PC 端可用（Web 端工作区在服务端，无本地自选意义）
        agentWsBtn.classList.toggle('hidden', !(user && isAIAgent(user) && agentWsSupported()));
        // 阶段四十三：切换会话丢弃进行中的 AI 流式气泡（DOM 已随 messageList 清空，回复落库后历史可见；
        // 重新进入该会话时增量会重建气泡继续打字，END 帧保证最终完整）
        for (var sid in aiStreams) {
            if (aiStreams[sid].timer) clearInterval(aiStreams[sid].timer);
            delete aiStreams[sid];
        }
        // 阶段四十三：同步清空"思考中"指示映射（DOM 随 messageList 清空，回复到达时若已离开该会话不影响渲染）
        for (var ag in aiThinking) {
            delete aiThinking[ag];
        }
        // 阶段三十八：切换会话清空待发送截图（防止把 A 会话的截图误发到 B 会话）
        clearPendingShot();
        // 阶段四十：切换会话清空引用条（防止把 A 会话的消息引用发到 B 会话）
        clearQuoteTarget();
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
            // 阶段三十八：图片查看器请求的更早历史——本页图片推回查看器（翻页/缩略图联动）
            if (viewerMorePending) {
                viewerMorePending = false;
                pushViewerOlderImages(records);
            }
            return;
        }

        // 服务端按 ID 倒序返回，正序渲染
        records.reverse().forEach(function (r) {
            renderHistoryRecord(r);
            // 阶段四十三：恢复各智能体最近一次提问（正序遍历后写即最新，供重新生成/编辑提问按钮使用）
            if (r.from_user === IMSocket.getUsername() && isAIAgent(r.to_user)) {
                lastAIQuestion[r.to_user] = { raw: r.content, text: quoteDisplayText(r.content) };
            }
        });
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
        var div = createMessageEl(r.from_user, r.content, isMine ? 'self' : 'other', r.id, ts, isPrivate, isRead,
            isAIAgent(r.from_user) ? { total: r.total_tokens || 0, prompt: r.prompt_tokens || 0, completion: r.completion_tokens || 0 } : undefined);
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
                    // 原实现：直接创建 <a download> 触发下载
                    // 阶段四十六：docx/xlsx/pptx 点击在线编辑（msg_id 取历史消息 r.id），其余类型保持下载
                    onFileCardClick(bubbleFile, r.id, meta.name, meta.url);
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
            body.textContent = quoteDisplayText(r.content); // 阶段四十：引用消息显示回复正文而非 JSON 原串
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
                body.textContent = quoteDisplayText(r.content); // 阶段四十：引用消息显示回复正文而非 JSON 原串
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
        } else if (isAIAgent(currentChatUser)) {
            // 阶段四十三：AI 智能体会话标题（非好友，不查在线状态）
            chatTitle.textContent = currentChatUser;
            chatStatus.textContent = 'AI 助手';
        } else {
            var f = friendList.find(function (x) { return x.username === currentChatUser; });
            chatTitle.textContent = (f && f.remark) ? f.remark + '(' + currentChatUser + ')' : currentChatUser;
            chatStatus.textContent = f && f.online ? '在线' : '离线';
        }
        // 阶段五十八：记忆管理按钮仅 AI 智能体会话显示（群聊/普通用户会话隐藏）
        memoryBtn.classList.toggle('hidden', !(currentChatUser !== '' && isAIAgent(currentChatUser)));
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
        // 阶段四十三：AI 智能体头像（服务端配置归口下发，优先于在线用户表）
        // 阶段五十七：emoji 文本头像不作为 img.src（破图），交由占位元素渲染 emoji
        if (agentAvatars[name] && aiAvatarIsUrl(agentAvatars[name])) return agentAvatars[name];
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
            // 阶段四十三：AI 智能体非真实用户，无资料卡
            img.style.cursor = 'pointer';
            img.addEventListener('click', function () {
                if (!isAIAgent(fromUser)) openFriendCard(fromUser);
            });
            return img;
        }
        return buildAvatarPlaceholder(fromUser);
    }

    // 首字母占位头像（与会话列表 conv-avatar 同风格，跟随主题色）
    function buildAvatarPlaceholder(fromUser) {
        var ph = document.createElement('div');
        ph.className = 'msg-avatar placeholder';
        // 阶段四十三：AI 智能体无配置头像时回退 🤖 占位（与 AI 列表/会话列表口径一致）
        // 阶段五十七：自建智能体 emoji 文本头像直接作为占位文本展示（aiAvatarIsUrl 分路）
        if (isAIAgent(fromUser)) {
            var aiAv = agentAvatars[fromUser] || '';
            ph.textContent = aiAv && !aiAvatarIsUrl(aiAv) ? aiAv : '🤖';
        } else {
            ph.textContent = (fromUser || '?').charAt(0).toUpperCase();
        }
        // 阶段三十：占位头像同样可点击弹出资料卡（AI 智能体无资料卡）
        ph.style.cursor = 'pointer';
        ph.addEventListener('click', function () {
            if (!isAIAgent(fromUser)) openFriendCard(fromUser);
        });
        return ph;
    }

    // 构建消息元素（返回 DOM 节点，不插入列表）：供实时消息与历史消息渲染复用
    // tokens 可选：AI 回复的 Token 消耗（服务端 usage 归口，历史加载/END 降级路径透传给操作栏）
    function createMessageEl(fromUser, content, type, msgId, timestamp, showReadStatus, isRead, tokens) {
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
        // 阶段四十：引用消息渲染——content 为引用信封时，气泡内先渲染引用块（灰底小字，点击定位原消息）再渲染回复正文；
        // 阶段四十一：引用块加"引用"前缀（用户一眼识别引用消息）；quote.url 存在时显示真实图片缩略图
        // 原实现：bubble.textContent = content（引用信封会原样显示 JSON 串）
        // 阶段四十四：AI 图片提问信封（{"image":url,"text":附言}）渲染为图片气泡 + 附言——
        // 仅对自己的消息且当前为 AI 会话时判定，普通聊天里手打的 JSON 字符串不受影响
        // 阶段四十五：AI 文档问答信封（{"doc":url,"name":文件名,"text":附言}）渲染为文件卡片 + 附言
        var aiDocEnv = (type === 'self' && isAIAgent(currentChatUser)) ? parseAIDocEnvelope(content) : null;
        var aiImgEnv = (!aiDocEnv && type === 'self' && isAIAgent(currentChatUser)) ? parseAIImageEnvelope(content) : null;
        var envelope = (aiDocEnv || aiImgEnv) ? null : parseQuoteEnvelope(content);
        if (aiDocEnv) {
            // 微信文件卡片风格：扩展名色块图标 + 文件名 + 点击打开服务端文档（下载归口）
            var docCard = document.createElement('div');
            docCard.className = 'msg-doc-card';
            var extName = ((aiDocEnv.doc || '').split('.').pop() || 'doc').toUpperCase();
            var docIcon = document.createElement('span');
            docIcon.className = 'msg-doc-icon';
            docIcon.textContent = extName;
            var docInfo = document.createElement('div');
            docInfo.className = 'msg-doc-info';
            var docName = document.createElement('div');
            docName.className = 'msg-doc-name';
            docName.textContent = aiDocEnv.name || '未命名文档';
            var docSub = document.createElement('div');
            docSub.className = 'msg-doc-sub';
            docSub.textContent = '点击查看文档';
            docInfo.appendChild(docName);
            docInfo.appendChild(docSub);
            docCard.appendChild(docIcon);
            docCard.appendChild(docInfo);
            docCard.addEventListener('click', function () {
                // 原实现：window.open 直接打开服务端文档（下载归口）
                // 阶段四十六：docx/xlsx/pptx 文档信封点击在线编辑（msg_id 闭包可得，失败落预览层），其余类型保持原打开行为
                if (isEditableDocName(aiDocEnv.name || aiDocEnv.doc) && msgId && openDocEditor(msgId, aiDocEnv.name, aiDocEnv.doc)) return;
                window.open(aiDocEnv.doc, '_blank');
            });
            bubble.appendChild(docCard);
            if (aiDocEnv.text) {
                var docText = document.createElement('div');
                docText.className = 'msg-text';
                docText.textContent = aiDocEnv.text;
                bubble.appendChild(docText);
            }
        } else if (aiImgEnv) {
            bubble.classList.add('bubble-image');
            var qImg = document.createElement('img');
            qImg.className = 'chat-image';
            qImg.src = aiImgEnv.image;
            qImg.alt = '';
            qImg.addEventListener('click', function () {
                openImageViewer(aiImgEnv.image); // 与聊天图片一致走图片查看器
            });
            bubble.appendChild(qImg);
            if (aiImgEnv.text) {
                var aiImgText = document.createElement('div');
                aiImgText.className = 'msg-text';
                aiImgText.textContent = aiImgEnv.text;
                bubble.appendChild(aiImgText);
            }
        } else if (envelope) {
            var q = envelope.quote;
            var quoteBlock = document.createElement('div');
            quoteBlock.className = 'msg-quote';
            // "引用"前缀 + 来源 + 摘要（textContent 赋值防 XSS，摘要来自用户消息原文）
            var qLabel = document.createElement('span');
            qLabel.className = 'msg-quote-text';
            qLabel.textContent = '引用 ' + (q.from || '') + '：' + (q.text || '');
            quoteBlock.appendChild(qLabel);
            // 图片引用：引用块内嵌真实缩略图（加载失败退化为纯"[图片]"文字）
            if (q.url) {
                var quoteImg = document.createElement('img');
                quoteImg.className = 'msg-quote-img';
                quoteImg.src = q.url;
                quoteImg.addEventListener('error', function () { quoteImg.remove(); });
                quoteBlock.appendChild(quoteImg);
            }
            if (q.msg_id) {
                quoteBlock.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    // 定位被引用的原消息（微信同款）
                    var qEl = messageList.querySelector('.message[data-msg-id="' + q.msg_id + '"]');
                    if (qEl) {
                        highlightMessage(qEl);
                    } else {
                        // 阶段四十一修复：原消息不在当前窗口（在未加载的更早历史中）时走翻页定位链路——
                        // 复用会话内搜索的逐页向前加载机制，找到即滚动高亮；翻完无结果提示"未找到该消息"
                        // 原实现：仅当前窗口内查找，找不到无操作（用户反馈：对方点击引用无法定位未加载的历史消息，
                        // 必须手动滚轮翻到那条消息才能定位）
                        locateState.active = true;
                        locateState.msgId = q.msg_id;
                        locateState.page = 1;
                        locateState.src = 'search';
                        loadNextLocatePage();
                    }
                });
            }
            bubble.appendChild(quoteBlock);
            var textDiv = document.createElement('div');
            textDiv.className = 'msg-text';
            // 阶段四十三：AI 智能体消息渲染 Markdown，普通消息纯文本直出防 XSS
            if (isAIAgent(fromUser)) {
                textDiv.classList.add('ai-md');
                textDiv.innerHTML = renderAIMarkdown(envelope.text);
            } else {
                textDiv.textContent = envelope.text;
            }
            bubble.appendChild(textDiv);
        } else if (isAIAgent(fromUser)) {
            // 阶段四十三：AI 智能体回复渲染 Markdown（先 HTML 转义防注入，仅白名单转换：
            // 加粗/斜体/标题/列表/行内代码/代码块/链接），解决 AI 返回的 **加粗**、* 列表 符号原样显示的问题
            var mdDiv = document.createElement('div');
            mdDiv.className = 'msg-text ai-md';
            mdDiv.innerHTML = renderAIMarkdown(content);
            bubble.appendChild(mdDiv);
        } else {
            // 原实现：bubble.textContent = content;（普通文本消息直出）
            bubble.textContent = content;
        }
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
        // 阶段四十三：AI 智能体回复（历史加载/END 降级整段渲染）气泡下追加操作栏（流式路径在 finishStream 追加）
        // 阶段四十五：携带消息 ID 供导出按钮服务端归口取原文
        // 阶段六十二修复：透传 tokens（历史响应含 prompt/completion/total_tokens，此前构建操作栏漏传第 4 参，
        // 刷新浏览器/重新登录后 AI 回复只剩操作栏、Token 消耗标注消失）
        if (isAIAgent(fromUser)) {
            body.appendChild(buildAIActionBar(fromUser, envelope ? envelope.text : content, msgId, tokens));
        }
        div.appendChild(getAvatarEl(fromUser));
        div.appendChild(body);
        return div;
    }

    // 实时消息：构建元素后追加到列表末尾并滚动到底部
    // tokens 可选：AI 回复 Token 消耗（END 降级整段渲染路径透传）
    function appendMessage(fromUser, content, type, msgId, timestamp, showReadStatus, isRead, tokens) {
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
        var div = createMessageEl(fromUser, content, type, msgId, timestamp, showReadStatus, isRead, tokens);
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
    // 收集当前会话 DOM 内全部图片作为翻页/缩略图列表：
    // - http(s) 图直接入列（跨窗口可用）
    // - blob: 图（刚发送落库回填前/本地预览）跨窗口加载失败，转 dataURL 后入列（按 DOM 顺序保序）
    function blobToDataUrl(u) {
        return fetch(u).then(function (r) { return r.blob(); }).then(function (b) {
            return new Promise(function (res) {
                var fr = new FileReader();
                fr.onload = function () { res(fr.result); };
                fr.onerror = function () { res(''); };
                fr.readAsDataURL(b);
            });
        }).catch(function () { return ''; });
    }

    function openImageViewer(url) {
        var ordered = [];
        var jobs = [];
        document.querySelectorAll('.chat-image').forEach(function (im) {
            var u = im.getAttribute('src') || '';
            if (!u) return;
            var i = ordered.length;
            ordered.push(null); // 占位保序（DOM 顺序即时间顺序）
            if (u.indexOf('blob:') === 0) {
                jobs.push(blobToDataUrl(u).then(function (d) { ordered[i] = d || ''; }));
            } else {
                ordered[i] = u;
            }
        });
        Promise.all(jobs).then(function () {
            // 保序去重（同 URL 或同内容 dataURL 只留第一张）
            var list = [];
            ordered.forEach(function (u) {
                if (u && list.indexOf(u) === -1) list.push(u);
            });
            // 点击目标是 blob 时先转 dataURL 再定位（blob 字符串在列表中找不到）
            var locate = Promise.resolve(url);
            if (url && url.indexOf('blob:') === 0) {
                locate = blobToDataUrl(url);
            }
            locate.then(function (target) {
                var idx = list.indexOf(target);
                if (idx === -1) {
                    if (target) { list.unshift(target); idx = 0; }
                    else idx = 0;
                }
                if (window.desktop && window.desktop.openImageViewer) {
                    window.desktop.openImageViewer({ url: target, list: list, index: idx });
                } else {
                    window.__imageViewerList = list; // Web 端查看器页从 opener 拉取列表
                    window.open('/image-viewer.html?url=' + encodeURIComponent(target), '_blank');
                }
            });
        });
    }

    // ===== 阶段四十六：OnlyOffice 在线文档编辑（docx/xlsx/pptx 点击弹出自研编辑窗口，保存走服务端版本归口） =====
    var docEditorInstance = null;  // DocsAPI.DocEditor 实例（关闭时必须 destroyEditor 释放 DS 协同会话）
    var docEditorMsgId = 0;        // 当前编辑的消息 ID（标题栏"下载"按钮按最新版本下载）
    var docEditorName = '';        // 当前编辑的展示文件名
    var docEditorMode = 'edit';    // 弹窗模式：edit=OnlyOffice 编辑 / preview=免费纯前端只读预览
    var docPreviewUrl = '';        // 预览模式的文档地址（标题栏"下载"按钮直接下载该地址）

    // 可编辑扩展名判断（docx/xlsx/pptx）
    function isEditableDocName(name) {
        return /\.(docx|xlsx|pptx)$/i.test(name || '');
    }

    // 触发浏览器下载（标题栏"下载"按钮 / 在线编辑不可用时的回退行为）
    // 走服务端 /doc/download 归口：服务端解析最新版本后以附件下发（未启用在线编辑时不可用）
    function triggerDocDownload(msgId, name) {
        var a = document.createElement('a');
        a.href = '/doc/download?msg_id=' + msgId + '&username=' + encodeURIComponent(IMSocket.getUsername());
        a.download = name || 'file';
        a.click();
    }

    // 打开文档编辑弹窗（双层架构·编辑层）：服务端签发配置（含归属校验/版本解析/JWT）→ 懒加载 api.js → 拉起编辑器
    // 任一环节失败（未启用 OnlyOffice/无权限/加载超时）→ 静默回退预览层（fallbackUrl 有效时）或下载
    function openDocEditor(msgId, name, fallbackUrl) {
        if (!msgId) return false;
        fetch('/doc/editor?msg_id=' + msgId + '&username=' + encodeURIComponent(IMSocket.getUsername()))
            .then(function (res) {
                return res.json().then(function (data) {
                    if (!res.ok) throw new Error((data && data.error) || '在线编辑不可用');
                    return data;
                });
            })
            .then(function (data) {
                if (!data.config || !data.api_url) throw new Error('编辑器配置缺失');
                docEditorMode = 'edit';
                docEditorMsgId = msgId;
                docEditorName = name || '';
                document.getElementById('doc-editor-name').textContent = docEditorName || '文档';
                document.getElementById('doc-editor-mask').classList.remove('hidden');
                document.getElementById('doc-editor-window').classList.remove('hidden');
                ensureDocsAPI(data.api_url, function (ok) {
                    if (!ok) {
                        // 编辑器脚本加载失败：回退预览层（原实现：提示后直接下载）
                        closeDocEditor();
                        if (fallbackUrl) { openDocPreview(fallbackUrl, docEditorName); return; }
                        showToast('编辑器加载失败，已改为下载');
                        triggerDocDownload(msgId, docEditorName);
                        return;
                    }
                    try {
                        if (docEditorInstance) { docEditorInstance.destroyEditor(); docEditorInstance = null; }
                        document.getElementById('doc-editor-placeholder').innerHTML = '';
                        docEditorInstance = new DocsAPI.DocEditor('doc-editor-placeholder', data.config);
                    } catch (e) {
                        closeDocEditor();
                        if (fallbackUrl) { openDocPreview(fallbackUrl, docEditorName); return; }
                        showToast('编辑器启动失败，已改为下载');
                        triggerDocDownload(msgId, docEditorName);
                    }
                });
            })
            .catch(function () {
                // 未启用 OnlyOffice（403）/网络异常：静默回退预览层（免费纯前端渲染，始终可用）
                if (fallbackUrl) { openDocPreview(fallbackUrl, name); return; }
                showToast('在线编辑不可用');
                triggerDocDownload(msgId, name);
            });
        return true;
    }

    // 打开文档预览弹窗（双层架构·预览层，阶段四十六）：免费纯前端库渲染（零服务端依赖，未部署 OnlyOffice 也可用）
    // docx/xlsx → doc-preview.html（docx-preview + SheetJS）；pptx → pptx-preview.html（PPTXjs）
    // 通过 iframe 隔离：预览库的全局变量（JSZip v2/v3、jQuery、d3）不污染主应用，主应用也无需加载这批库
    function openDocPreview(url, name) {
        if (!url) return;
        docEditorMode = 'preview';
        docPreviewUrl = url;
        docEditorName = name || '';
        document.getElementById('doc-editor-name').textContent = docEditorName || '文档';
        var ext = (name ? name.toLowerCase() : url.toLowerCase()).match(/\.(docx|xlsx|pptx)/);
        var page = (ext && ext[1] === 'pptx') ? 'pptx-preview.html' : 'doc-preview.html';
        var type = (ext && ext[1]) || 'docx';
        var holder = document.getElementById('doc-editor-placeholder');
        holder.innerHTML = '';
        var frame = document.createElement('iframe');
        frame.id = 'doc-preview-iframe';
        frame.src = '/' + page + '?type=' + type + '&url=' + encodeURIComponent(url);
        holder.appendChild(frame);
        document.getElementById('doc-editor-mask').classList.remove('hidden');
        document.getElementById('doc-editor-window').classList.remove('hidden');
    }

    // 关闭文档编辑/预览弹窗：编辑模式销毁实例释放 DocumentServer 会话（约 10 秒缓存期内同 key 重开可复现现场）；
    // 预览模式清空容器即卸载 iframe（停止渲染与播放）
    function closeDocEditor() {
        if (docEditorInstance) {
            try { docEditorInstance.destroyEditor(); } catch (e) {}
            docEditorInstance = null;
        }
        document.getElementById('doc-editor-placeholder').innerHTML = '';
        document.getElementById('doc-editor-mask').classList.add('hidden');
        document.getElementById('doc-editor-window').classList.add('hidden');
    }

    // 文件卡片点击统一入口（阶段四十六·双层架构）：
    // msgId 优先取入参（历史/AI 卡片闭包可得），否则点击时从气泡 DOM 的 data-msg-id 解析——
    // 实时文件消息渲染时尚未持久化，FILE_PERSISTED 回填只改 DOM 属性，闭包拿不到，必须动态读取
    // 可编辑类型 → 编辑层（OnlyOffice 已部署时在线编辑，失败自动落预览层）；预览层免费兜底始终可用
    // 其余类型（pdf/zip/图片等）→ 保持原下载行为
    function onFileCardClick(bubbleEl, msgId, name, url) {
        if (!msgId) {
            var el = bubbleEl && bubbleEl.closest ? bubbleEl.closest('.message') : null;
            msgId = el ? (parseInt(el.getAttribute('data-msg-id'), 10) || 0) : 0;
        }
        if (isEditableDocName(name) && url) {
            // 编辑层要求已持久化（msg_id 存在）且地址为服务端 URL（blob 本地预览地址不送编辑层）
            if (msgId > 0 && url.indexOf('blob:') !== 0 && openDocEditor(msgId, name, url)) return;
            openDocPreview(url, name);
            return;
        }
        var a = document.createElement('a');
        a.href = url || '';
        a.download = name || 'file';
        a.click();
    }

    // 编辑/预览弹窗按钮绑定（关闭销毁实例/卸载 iframe；遮罩点击不关闭，防误触丢失未保存内容）
    (function () {
        document.getElementById('doc-editor-close').addEventListener('click', closeDocEditor);
        document.getElementById('doc-editor-download').addEventListener('click', function () {
            // 预览模式：直接下载消息内文档地址；编辑模式：走服务端 /doc/download 归口下载最新版本
            if (docEditorMode === 'preview' && docPreviewUrl) {
                var a = document.createElement('a');
                a.href = docPreviewUrl;
                a.download = docEditorName || 'file';
                a.click();
                return;
            }
            if (docEditorMsgId > 0) triggerDocDownload(docEditorMsgId, docEditorName);
        });
    })();

    // ===== 查看器历史联动：查看器翻到列表头部时向主窗口请求更早图片 =====
    // Electron：desktop.onViewerNeedMore 订阅（主进程转发查看器请求）；拉取复用 HISTORY 翻页链路
    // （page+1 请求在 HISTORY_RESP page>1 分支渲染 DOM 后，检测 pending 标志把本页图片推回查看器）
    var viewerMorePending = false; // 查看器请求更早图片中（HISTORY_RESP 到达时消费）
    var viewerWebCallback = null;  // Web 端查看器回调（opener 桥直调）

    function pushViewerOlderImages(records) {
        var urls = [];
        records.forEach(function (r) {
            if (r.msg_type !== 4) return;
            var m = {};
            try { m = JSON.parse(r.content || '{}'); } catch (e) {}
            if (m.url && urls.indexOf(m.url) === -1) urls.push(m.url);
        });
        if (!urls.length) return;
        if (window.desktop && window.desktop.pushViewerImages) {
            window.desktop.pushViewerImages(urls); // PC 端：主进程转发查看器窗口
        }
        if (viewerWebCallback) {
            var cb = viewerWebCallback;
            viewerWebCallback = null;
            cb(urls); // Web 端：opener 桥回调
        }
    }

    if (window.desktop && window.desktop.onViewerNeedMore) {
        window.desktop.onViewerNeedMore(function () {
            viewerMorePending = true;
            // 复用滚动加载翻页链路（无更多历史时 HISTORY_RESP 空列表会自然终止，查看器侧去重兜底）
            var msg = { msg_type: MSG.HISTORY, page: historyPage + 1, page_size: PAGE_SIZE };
            if (currentChatUser !== '') msg.to_user = currentChatUser;
            IMSocket.send(msg);
        });
    }

    // Web 浏览器端：查看器页（window.open 新标签）通过 opener 桥请求更早图片
    // （与上方 desktop 订阅同一拉取链路，回调用 viewerWebCallback 承接）
    window.__imageViewerBridge = {
        requestOlder: function (cb) {
            viewerWebCallback = cb;
            viewerMorePending = true;
            var msg = { msg_type: MSG.HISTORY, page: historyPage + 1, page_size: PAGE_SIZE };
            if (currentChatUser !== '') msg.to_user = currentChatUser;
            IMSocket.send(msg);
        }
    };

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
        // 自己发送的私聊图片同样显示已读/未读（与文字消息一致）。发送时 msg_id 未落库，先建元素显示"未读"，
        // FILE_PERSISTED 回填气泡 msg_id 时同步回填状态元素（回执处理器按 data-msg-id 水位翻已读）
        if (type === 'self' && isPrivate) {
            var imgStatus = document.createElement('div');
            imgStatus.className = 'msg-status';
            imgStatus.setAttribute('data-msg-id', '');
            imgStatus.textContent = '未读';
            body.appendChild(imgStatus);
        }
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
                // 原实现：直接创建 <a download> 触发下载
                // 阶段四十六：docx/xlsx/pptx 点击在线编辑（msg_id 点击时从 DOM 解析，兼容 FILE_PERSISTED 回填时机），其余保持下载
                onFileCardClick(bubble, 0, name, url);
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

    // ===== 阶段五十六：我的知识库（个人库自建/上传/文件管理 + 勾选，勾选后对所有 AI 助手对话生效） =====
    // 服务端归口：/api/kb 系列（个人库仅归属者可管理，公共库只读可勾选）；检索命中权限由服务端 kbSearch 过滤
    var kbMask = document.getElementById('kb-mask');
    var kbEntry = document.getElementById('kb-entry');
    var kbEntryBadge = document.getElementById('kb-entry-badge');
    var kbStatusEl = document.getElementById('kb-status');
    var kbListEl = document.getElementById('kb-list');
    var kbNewName = document.getElementById('kb-new-name');
    var kbCreateBtn = document.getElementById('kb-create-btn');
    var kbCloseBtn = document.getElementById('kb-close');
    var kbData = null;       // 服务端总览数据（embed 状态 + 库列表 + 勾选态）
    var kbFilesCache = {};   // 展开的文件面板缓存：kbId -> 文件数组（null=加载中）
    var kbExpanded = {};     // 文件面板展开态：kbId -> true
    var kbPollTimer = null;  // 处理中文件状态轮询（弹窗打开期间每 5 秒）

    function kbUsername() {
        return encodeURIComponent(IMSocket.getUsername());
    }

    function kbOpenDialog() {
        kbMask.classList.remove('hidden');
        kbLoadData();
        // 弹窗打开期间统一轮询：展开面板中存在处理中文件时刷新状态（轮询内部自判，无开销空转）
        if (kbPollTimer) clearInterval(kbPollTimer);
        kbPollTimer = setInterval(kbPollTick, 5000);
    }

    function kbCloseDialog() {
        kbMask.classList.add('hidden');
        if (kbPollTimer) {
            clearInterval(kbPollTimer);
            kbPollTimer = null;
        }
    }

    kbEntry.addEventListener('click', kbOpenDialog);
    kbCloseBtn.addEventListener('click', kbCloseDialog);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !kbMask.classList.contains('hidden')) kbCloseDialog();
    });

    // 拉取总览数据并重渲染（建库/删除/上传后复用）
    function kbLoadData() {
        fetch('/api/kb?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '知识库加载失败'); return; }
                kbData = res.data;
                kbRender();
            })
            .catch(function () { showToast('知识库加载失败'); });
    }

    // 轮询 tick：仅刷新展开中的文件面板（processing 状态变化由重渲染反映）
    function kbPollTick() {
        if (kbMask.classList.contains('hidden')) {
            clearInterval(kbPollTimer);
            kbPollTimer = null;
            return;
        }
        Object.keys(kbFilesCache).forEach(function (id) {
            if (!kbExpanded[id] || kbFilesCache[id] === null) return;
            fetch('/api/kb/' + id + '/files?username=' + kbUsername())
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (res.ok) {
                        kbFilesCache[id] = res.data;
                        kbRender();
                    }
                })
                .catch(function () { /* 轮询失败静默，下轮再试 */ });
        });
    }

    function kbRender() {
        if (!kbData) return;
        // 状态行：勾选语义 + embedding 通道提示（未配置时可建库但不可向量化，服务端归口下发）
        kbStatusEl.innerHTML = kbData.embed_enabled
            ? '勾选的知识库对所有 AI 助手对话生效，命中参考资料自动注入（每问前 ' + kbData.top_k + ' 条）。向量模型：' + (kbData.model || '-')
            : '<span class="kb-status-off">embedding 服务未配置：可建库与上传，文件暂无法向量化检索（需管理员在 config.yaml 配置 ai.embedding）</span>';
        // 库列表
        kbListEl.innerHTML = '';
        if (!kbData.kbs || !kbData.kbs.length) {
            var empty = document.createElement('div');
            empty.className = 'kb-empty';
            empty.textContent = '暂无知识库，可在上方新建个人知识库';
            kbListEl.appendChild(empty);
        } else {
            kbData.kbs.forEach(function (kb) {
                kbListEl.appendChild(kbRenderItem(kb));
            });
        }
        // 入口角标：已勾选数量（无勾选时隐藏，微信红点同款语义）
        var selCount = (kbData.kbs || []).filter(function (k) { return k.selected; }).length;
        if (selCount > 0) {
            kbEntryBadge.textContent = selCount;
            kbEntryBadge.classList.remove('hidden');
        } else {
            kbEntryBadge.classList.add('hidden');
        }
    }

    function kbRenderItem(kb) {
        var item = document.createElement('div');
        item.className = 'kb-item';

        var head = document.createElement('div');
        head.className = 'kb-item-head';

        // 勾选框：即时保存（服务端 upsert 归口，失败回滚重渲染）
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'kb-item-check';
        check.checked = !!kb.selected;
        check.title = '勾选后该知识库对所有 AI 助手对话生效';
        check.addEventListener('change', function () {
            kbToggleSelect(kb.id, check.checked);
        });

        var name = document.createElement('span');
        name.className = 'kb-item-name';
        name.textContent = kb.name;
        name.title = kb.name;

        var tag = document.createElement('span');
        tag.className = 'kb-item-tag ' + kb.scope;
        tag.textContent = kb.scope === 'user' ? '个人' : '公共';

        var meta = document.createElement('span');
        meta.className = 'kb-item-meta';
        meta.textContent = kb.file_count + ' 文件 / ' + kb.chunk_count + ' 切片';

        var ops = document.createElement('span');
        ops.className = 'kb-item-ops';
        // 文件面板展开/收起（公共库同样可查看文件列表，仅个人库可管理）
        var filesBtn = document.createElement('button');
        filesBtn.className = 'kb-op-btn';
        filesBtn.textContent = kbExpanded[kb.id] ? '收起' : '文件';
        filesBtn.addEventListener('click', function () {
            kbExpanded[kb.id] = !kbExpanded[kb.id];
            kbRender();
        });
        ops.appendChild(filesBtn);
        // 删除整库：仅个人库
        if (kb.scope === 'user') {
            var delBtn = document.createElement('button');
            delBtn.className = 'kb-op-btn';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                showConfirm('删除知识库', '确定删除个人知识库「' + kb.name + '」？库内所有文件与向量将同步清理。', function () {
                    fetch('/api/kb/' + kb.id + '?username=' + kbUsername(), { method: 'DELETE' })
                        .then(function (r) { return r.json(); })
                        .then(function (res) {
                            if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                            showToast('知识库已删除');
                            delete kbFilesCache[kb.id];
                            delete kbExpanded[kb.id];
                            kbLoadData();
                        })
                        .catch(function () { showToast('删除失败'); });
                }, '删除');
            });
            ops.appendChild(delBtn);
        }

        head.appendChild(check);
        head.appendChild(name);
        head.appendChild(tag);
        head.appendChild(meta);
        head.appendChild(ops);
        item.appendChild(head);

        if (kb.desc) {
            var desc = document.createElement('div');
            desc.className = 'kb-item-desc';
            desc.textContent = kb.desc;
            item.appendChild(desc);
        }

        // 展开的文件面板（懒加载，缓存命中直接渲染）
        if (kbExpanded[kb.id]) {
            var fp = document.createElement('div');
            fp.className = 'kb-files';
            var files = kbFilesCache[kb.id];
            if (files === null || files === undefined) {
                fp.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '加载中…' }));
                kbLoadFiles(kb.id);
            } else if (!files.length) {
                fp.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '暂无文件，点击下方按钮上传' }));
            } else {
                files.forEach(function (f) {
                    fp.appendChild(kbRenderFileRow(kb.id, f));
                });
            }
            // 上传入口：仅个人库
            if (kb.scope === 'user') {
                var upRow = document.createElement('div');
                upRow.className = 'kb-upload-row';
                var upBtn = document.createElement('button');
                upBtn.className = 'kb-upload-btn';
                upBtn.textContent = '上传文件（docx / xlsx / xlsm / csv / md / txt）';
                upBtn.addEventListener('click', function () {
                    kbUploadFiles(kb.id);
                });
                upRow.appendChild(upBtn);
                fp.appendChild(upRow);
            }
            item.appendChild(fp);
        }
        return item;
    }

    function kbRenderFileRow(kbId, f) {
        var row = document.createElement('div');
        row.className = 'kb-file-row';
        var fn = document.createElement('span');
        fn.className = 'kb-file-name';
        fn.textContent = f.name;
        fn.title = f.name + (f.status === 'failed' && f.error ? '（失败原因：' + f.error + '）' : '');
        var st = document.createElement('span');
        st.className = 'kb-file-status ' + f.status;
        st.textContent = f.status === 'processing' ? '处理中' : (f.status === 'ready' ? '可检索' : '失败');
        var del = document.createElement('button');
        del.className = 'kb-file-del';
        del.textContent = '×';
        del.title = '删除文件';
        del.addEventListener('click', function () {
            showConfirm('删除文件', '确定删除「' + f.name + '」？该文件的向量将同步清理。', function () {
                fetch('/api/kb/file/' + f.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('文件已删除');
                        delete kbFilesCache[kbId];
                        kbLoadData();
                    })
                    .catch(function () { showToast('删除失败'); });
            }, '删除');
        });
        row.appendChild(fn);
        row.appendChild(st);
        row.appendChild(del);
        return row;
    }

    function kbLoadFiles(kbId) {
        kbFilesCache[kbId] = null; // 加载中标记（防重复触发）
        fetch('/api/kb/' + kbId + '/files?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                kbFilesCache[kbId] = res.ok ? (res.data || []) : [];
                kbRender();
            })
            .catch(function () {
                kbFilesCache[kbId] = [];
                kbRender();
            });
    }

    // 勾选/取消勾选：以当前勾选集为基线增删后整体保存（服务端逐库校验权限）
    function kbToggleSelect(kbId, on) {
        var cur = (kbData.kbs || []).filter(function (k) { return k.selected; }).map(function (k) { return k.id; });
        var next = on ? cur.concat([kbId]) : cur.filter(function (id) { return id !== kbId; });
        fetch('/api/kb/select?username=' + kbUsername(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kb_ids: next })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '保存勾选失败'); kbRender(); return; }
                // 本地同步勾选态（服务端已归口，避免整表重查）
                kbData.kbs.forEach(function (k) { k.selected = next.indexOf(k.id) !== -1; });
                kbRender();
            })
            .catch(function () { showToast('保存勾选失败'); kbRender(); });
    }

    // 新建个人知识库
    function kbCreate() {
        var name = kbNewName.value.trim();
        if (!name) { showToast('请输入知识库名称'); return; }
        kbCreateBtn.disabled = true;
        fetch('/api/kb?username=' + kbUsername(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, desc: '' })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '新建失败'); return; }
                showToast('知识库「' + name + '」已创建');
                kbNewName.value = '';
                kbLoadData();
            })
            .catch(function () { showToast('新建失败'); })
            .finally(function () { kbCreateBtn.disabled = false; });
    }
    kbCreateBtn.addEventListener('click', kbCreate);
    kbNewName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            kbCreate();
        }
    });

    // 上传文件到个人库（多选逐个串行上传，全部完成后刷新状态）
    function kbUploadFiles(kbId) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.docx,.xlsx,.xlsm,.csv,.md,.txt';
        input.multiple = true;
        input.addEventListener('change', function () {
            var files = Array.prototype.slice.call(input.files || []);
            if (!files.length) return;
            var i = 0;
            (function next() {
                if (i >= files.length) {
                    showToast('上传完成，向量化处理中');
                    delete kbFilesCache[kbId];
                    kbLoadData();
                    return;
                }
                var fd = new FormData();
                fd.append('file', files[i]);
                fetch('/api/kb/file?username=' + kbUsername() + '&kb_id=' + kbId, { method: 'POST', body: fd })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) showToast(res.msg || '上传失败：' + files[i].name);
                        i++;
                        next();
                    })
                    .catch(function () {
                        showToast('上传失败：' + files[i].name);
                        i++;
                        next();
                    });
            })();
        });
        input.click();
    }

    // ===== 阶段五十七：我的智能体（个人智能体自建/编辑/删除，仅归属者可见可对话） =====
    // 服务端归口：/api/agents 系列（模型可选范围由管理员在 config.yaml ai.user_agent 白名单圈定，
    // 提示词/名称长度与数量上限均由服务端校验）；新建/编辑/删除成功后服务端按用户视角广播 AI_AGENTS，
    // 侧栏智能体列表经既有监听自动刷新，此处无需手动同步
    var uaMask = document.getElementById('ua-mask');
    var uaEntry = document.getElementById('ua-entry');
    var uaEntryBadge = document.getElementById('ua-entry-badge');
    var uaStatusEl = document.getElementById('ua-status');
    var uaNameInput = document.getElementById('ua-name');
    var uaAvatarInput = document.getElementById('ua-avatar');
    var uaProviderSel = document.getElementById('ua-provider');
    var uaPromptInput = document.getElementById('ua-prompt');
    var uaSaveBtn = document.getElementById('ua-save-btn');
    var uaCancelBtn = document.getElementById('ua-cancel-btn');
    var uaCloseBtn = document.getElementById('ua-close');
    var uaListEl = document.getElementById('ua-list');
    var uaForm = document.querySelector('.ua-form');
    var uaData = null;       // 服务端总览数据（开关/白名单/我的智能体）
    var uaEditingId = 0;     // 编辑中的智能体 ID（0=新建态）

    function uaOpenDialog() {
        uaMask.classList.remove('hidden');
        uaResetForm();
        uaLoad();
    }

    function uaCloseDialog() {
        uaMask.classList.add('hidden');
    }

    uaEntry.addEventListener('click', uaOpenDialog);
    uaCloseBtn.addEventListener('click', uaCloseDialog);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !uaMask.classList.contains('hidden')) uaCloseDialog();
    });

    // 拉取总览数据并重渲染（新建/编辑/删除后复用）
    function uaLoad() {
        fetch('/api/agents?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '智能体加载失败'); return; }
                uaData = res.data;
                uaRender();
            })
            .catch(function () { showToast('智能体加载失败'); });
    }

    function uaRender() {
        if (!uaData) return;
        // 功能关闭：隐藏表单，仅提示（服务端归口 ai.user_agent.enabled）
        if (!uaData.enabled) {
            uaStatusEl.innerHTML = '<span class="kb-status-off">管理员未开放自建智能体功能（config.yaml ai.user_agent.enabled）</span>';
            uaForm.classList.add('hidden');
            uaListEl.innerHTML = '';
            uaEntryBadge.classList.add('hidden');
            return;
        }
        uaForm.classList.remove('hidden');
        uaStatusEl.textContent = '自建智能体仅自己可见可对话，模型范围由管理员圈定（' +
            (uaData.mine ? uaData.mine.length : 0) + '/' + uaData.max_per_user + ' 个）';
        // 模型下拉（白名单归口下发：名称 + 模型名，不含密钥；保留当前已选项）
        var cur = uaProviderSel.value;
        uaProviderSel.innerHTML = '';
        (uaData.providers || []).forEach(function (p) {
            var opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name + '（' + p.model + '）';
            uaProviderSel.appendChild(opt);
        });
        if (cur && Array.prototype.some.call(uaProviderSel.options, function (o) { return o.value === cur; })) {
            uaProviderSel.value = cur;
        }
        // 我的智能体列表
        uaListEl.innerHTML = '';
        if (!uaData.mine || !uaData.mine.length) {
            uaListEl.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '暂无自建智能体，在上方填写名称与提示词即可创建' }));
        } else {
            uaData.mine.forEach(function (a) {
                uaListEl.appendChild(uaRenderItem(a));
            });
        }
        // 入口角标：自建数量（0 时隐藏，与知识库入口红点同语义）
        var count = (uaData.mine || []).length;
        if (count > 0) {
            uaEntryBadge.textContent = count;
            uaEntryBadge.classList.remove('hidden');
        } else {
            uaEntryBadge.classList.add('hidden');
        }
    }

    function uaRenderItem(a) {
        var item = document.createElement('div');
        item.className = 'kb-item';

        var head = document.createElement('div');
        head.className = 'kb-item-head';

        var name = document.createElement('span');
        name.className = 'kb-item-name';
        name.textContent = (a.avatar && !aiAvatarIsUrl(a.avatar) ? a.avatar + ' ' : '') + a.name;
        name.title = a.name;

        var tag = document.createElement('span');
        tag.className = 'kb-item-tag user';
        tag.textContent = a.enabled ? '启用中' : '已停用';

        var meta = document.createElement('span');
        meta.className = 'kb-item-meta';
        meta.textContent = a.provider;

        var ops = document.createElement('span');
        ops.className = 'kb-item-ops';
        var editBtn = document.createElement('button');
        editBtn.className = 'kb-op-btn';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', function () {
            uaBeginEdit(a);
        });
        ops.appendChild(editBtn);
        var delBtn = document.createElement('button');
        delBtn.className = 'kb-op-btn';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', function () {
            showConfirm('删除智能体', '确定删除个人智能体「' + a.name + '」？历史聊天记录保留，仅不可再对话。', function () {
                fetch('/api/agents/' + a.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('智能体已删除');
                        if (uaEditingId === a.id) uaResetForm();
                        uaLoad();
                    })
                    .catch(function () { showToast('删除失败'); });
            }, '删除');
        });
        ops.appendChild(delBtn);

        head.appendChild(name);
        head.appendChild(tag);
        head.appendChild(meta);
        head.appendChild(ops);
        item.appendChild(head);

        // 提示词预览（单行截断，编辑时表单完整回显）
        if (a.system_prompt) {
            var desc = document.createElement('div');
            desc.className = 'kb-item-desc';
            desc.textContent = a.system_prompt;
            item.appendChild(desc);
        }
        return item;
    }

    // 进入编辑态：表单回显 + 按钮切换（再点"保存"走 PUT）
    function uaBeginEdit(a) {
        uaEditingId = a.id;
        uaNameInput.value = a.name;
        uaAvatarInput.value = a.avatar && !aiAvatarIsUrl(a.avatar) ? a.avatar : '';
        uaProviderSel.value = a.provider;
        uaPromptInput.value = a.system_prompt || '';
        uaSaveBtn.textContent = '保存修改';
        uaCancelBtn.classList.remove('hidden');
        uaNameInput.focus();
    }

    // 表单复位为新建态
    function uaResetForm() {
        uaEditingId = 0;
        uaNameInput.value = '';
        uaAvatarInput.value = '';
        uaPromptInput.value = '';
        uaSaveBtn.textContent = '新建';
        uaCancelBtn.classList.add('hidden');
    }

    // 新建/保存（服务端校验归口：名称唯一/长度/数量上限/模型白名单，失败提示服务端消息）
    function uaSave() {
        var name = uaNameInput.value.trim();
        if (!name) { showToast('请填写智能体名称'); return; }
        var body = {
            name: name,
            avatar: uaAvatarInput.value.trim(),
            system_prompt: uaPromptInput.value,
            provider: uaProviderSel.value
        };
        var isEdit = uaEditingId > 0;
        var url = isEdit ? '/api/agents/' + uaEditingId + '?username=' + kbUsername() : '/api/agents?username=' + kbUsername();
        uaSaveBtn.disabled = true;
        fetch(url, {
            method: isEdit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || (isEdit ? '保存失败' : '新建失败')); return; }
                showToast(isEdit ? '智能体已更新' : '智能体「' + name + '」已创建');
                uaResetForm();
                uaLoad();
            })
            .catch(function () { showToast(isEdit ? '保存失败' : '新建失败'); })
            .finally(function () { uaSaveBtn.disabled = false; });
    }
    uaSaveBtn.addEventListener('click', uaSave);
    uaCancelBtn.addEventListener('click', uaResetForm);
    uaNameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            uaSave();
        }
    });

    // ===== 阶段五十八：记忆管理（用户+智能体 隔离的长期记忆查看/手动新增/删除/清空/开关） =====
    // 服务端归口：/api/agents/{id}/memory 系列（id 取 AI_AGENTS 下发列表；提取/注入全在服务端，此处仅展示管理）
    var memoryBtn = document.getElementById('memory-btn');
    var memoryMask = document.getElementById('memory-mask');
    var memoryStatusEl = document.getElementById('memory-status');
    var memoryPrefInput = document.getElementById('memory-pref');
    var memoryAddRow = document.getElementById('memory-add-row');
    var memoryInput = document.getElementById('memory-input');
    var memoryAddBtn = document.getElementById('memory-add-btn');
    var memoryListEl = document.getElementById('memory-list');
    var memoryClearBtn = document.getElementById('memory-clear');
    var memoryCloseBtn = document.getElementById('memory-close');
    var memFeatureOk = false; // 服务端功能可用性缓存（总开关关闭/向量降级时隐藏新增区与开关）

    // 当前会话智能体的 DB ID（AI_AGENTS 下发归口携带 id；未就绪返回 0）
    function memAgentId() {
        var a = aiAgents.find(function (x) { return x.name === currentChatUser; });
        return a ? (a.id || 0) : 0;
    }

    function memOpenDialog() {
        if (currentChatUser === '' || !isAIAgent(currentChatUser)) return;
        if (!memAgentId()) {
            showToast('智能体信息未就绪，请稍后重试');
            return;
        }
        memoryMask.classList.remove('hidden');
        memoryStatusEl.textContent = '当前智能体：' + currentChatUser + '（记忆按 账号+智能体 隔离，仅你可见）';
        memoryListEl.innerHTML = '<div class="kb-empty">加载中…</div>';
        memLoad();
    }

    function memCloseDialog() {
        memoryMask.classList.add('hidden');
    }

    // 拉取记忆列表 + 用户开关 + 功能可用性
    function memLoad() {
        var id = memAgentId();
        if (!id) { memCloseDialog(); return; }
        fetch('/api/agents/' + id + '/memory?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '记忆加载失败'); return; }
                memFeatureOk = !!res.data.feature;
                memoryPrefInput.checked = !!res.data.pref;
                memoryPrefInput.disabled = !memFeatureOk;
                memoryAddRow.classList.toggle('hidden', !memFeatureOk);
                memoryClearBtn.classList.toggle('hidden', !(res.data.memories || []).length);
                memRender(res.data.memories || []);
            })
            .catch(function () { showToast('记忆加载失败'); });
    }

    function memRender(list) {
        memoryListEl.innerHTML = '';
        if (!list.length) {
            memoryListEl.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '暂无记忆，聊几句或手动添加一条试试' }));
            return;
        }
        list.forEach(function (m) {
            var item = document.createElement('div');
            item.className = 'kb-item';

            var head = document.createElement('div');
            head.className = 'kb-item-head';

            // 记忆正文（单行截断，悬停 title 看全文）
            var name = document.createElement('span');
            name.className = 'kb-item-name';
            name.textContent = m.content;
            name.title = m.content;

            // 来源标签：自动提取（灰）/ 手动添加（主题色，与"个人"标签同款）
            var tag = document.createElement('span');
            tag.className = 'kb-item-tag ' + (m.source === 'manual' ? 'user' : 'public');
            tag.textContent = m.source === 'manual' ? '手动' : '自动';

            var meta = document.createElement('span');
            meta.className = 'kb-item-meta';
            meta.textContent = memFormatTime(m.create_time);

            var ops = document.createElement('span');
            ops.className = 'kb-item-ops';
            var delBtn = document.createElement('button');
            delBtn.className = 'kb-op-btn';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                fetch('/api/agents/' + memAgentId() + '/memory/' + m.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('记忆已删除');
                        memLoad();
                    })
                    .catch(function () { showToast('删除失败'); });
            });
            ops.appendChild(delBtn);

            head.appendChild(name);
            head.appendChild(tag);
            head.appendChild(meta);
            head.appendChild(ops);
            item.appendChild(head);
            memoryListEl.appendChild(item);
        });
    }

    function memFormatTime(ts) {
        var d = new Date(ts);
        if (!ts || isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // 手动新增记忆（服务端同样走去重归口，重复内容会提示已存在）
    function memAdd() {
        var content = memoryInput.value.trim();
        if (!content) { showToast('请输入记忆内容'); return; }
        memoryAddBtn.disabled = true;
        fetch('/api/agents/' + memAgentId() + '/memory?username=' + kbUsername(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '添加失败'); return; }
                showToast('记忆已添加');
                memoryInput.value = '';
                memLoad();
            })
            .catch(function () { showToast('添加失败'); })
            .finally(function () { memoryAddBtn.disabled = false; });
    }

    memoryBtn.addEventListener('click', memOpenDialog);
    memoryCloseBtn.addEventListener('click', memCloseDialog);
    memoryAddBtn.addEventListener('click', memAdd);
    memoryInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            memAdd();
        }
    });
    memoryClearBtn.addEventListener('click', function () {
        showConfirm('清空记忆', '确定清空与「' + currentChatUser + '」的全部记忆？此操作不可恢复。', function () {
            fetch('/api/agents/' + memAgentId() + '/memory?username=' + kbUsername(), { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (!res.ok) { showToast(res.msg || '清空失败'); return; }
                    showToast('记忆已清空');
                    memLoad();
                })
                .catch(function () { showToast('清空失败'); });
        }, '清空');
    });
    // 用户级开关（关闭后不再自动提取与注入召回，已存记忆保留；失败回滚勾选态）
    memoryPrefInput.addEventListener('change', function () {
        var want = memoryPrefInput.checked;
        fetch('/api/agents/' + memAgentId() + '/memory/pref?username=' + kbUsername(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: want })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) {
                    showToast(res.msg || '保存失败');
                    memoryPrefInput.checked = !want;
                    return;
                }
                showToast(want ? '已开启记忆' : '已关闭记忆（已存记忆保留）');
            })
            .catch(function () {
                showToast('保存失败');
                memoryPrefInput.checked = !want;
            });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !memoryMask.classList.contains('hidden')) memCloseDialog();
    });

    // ===== 阶段四十四：滚动条悬停显隐（微信设置页同款：默认隐藏，悬停滚动容器浮现，移出立即隐藏） =====
    // 纯 CSS :hover 在 Chromium 滚动条伪元素上存在滞留（拖动滑块后移出/快速划过时 hover 不重算，滑块不消失），
    // 改由 JS 精确控制：mouseover 时给最近的滚动容器加 .sb-hover（滑块浮现），mouseout 时移除（滑块隐藏）
    (function () {
        var sbLast = null; // 当前标记的滚动容器
        // 判定是否为可滚动元素（存在纵向溢出才可能显示滚动条）
        function sbScrollable(el) {
            return el.scrollHeight > el.clientHeight + 1;
        }
        // 自触发点向上找最近的滚动容器（与 CSS :hover 命中语义一致）；
        // 滑块本身挂在 body 上（不在容器内），鼠标移到滑块上时映射回其宿主容器
        function sbFind(el) {
            if (el && el._osbHost) return el._osbHost;
            while (el && el !== document.documentElement) {
                if (sbScrollable(el)) return el;
                el = el.parentElement;
            }
            return null;
        }
        document.addEventListener('mouseover', function (e) {
            var el = sbFind(e.target);
            if (el === sbLast) { if (el) clearTimeout(el._osbHideT); return; }
            if (sbLast) sbScheduleHide(sbLast);
            sbLast = el;
            if (sbLast) { clearTimeout(sbLast._osbHideT); sbMark(sbLast, true); }
        });
        // 鼠标移出：不立即隐藏，延迟 180ms 后按浏览器真实悬停状态决定是否隐藏
        // （容器与滑块任一处于悬停则保持显示）——彻底解决"移到滑块上→判定离开容器→隐藏→
        // 露出容器→又判定悬停→再显示"的循环闪烁，滑块可稳定点击拖拽
        document.addEventListener('mouseout', function (e) {
            if (!sbLast) return;
            if (!sbLast.contains(e.relatedTarget) && !(e.relatedTarget && e.relatedTarget._osbHost === sbLast)) {
                sbScheduleHide(sbLast);
            }
        });
        function sbScheduleHide(el) {
            clearTimeout(el._osbHideT);
            el._osbHideT = setTimeout(function () {
                if (sbLast === el) sbLast = null;
                if (!el.matches(':hover') && !(el._osbThumb && el._osbThumb.matches(':hover'))) {
                    sbMark(el, false);
                } else if (el._osbThumb) {
                    el._osbThumb.classList.add('sb-show'); // 仍在悬停则保持滑块可见
                }
            }, 180);
        }
        // 标记/取消标记：容器加 .sb-hover，自绘滑块（挂在 body 上的 fixed 浮层）同步加 .sb-show 控制显隐
        function sbMark(el, on) {
            el.classList.toggle('sb-hover', on);
            if (el._osbThumb) el._osbThumb.classList.toggle('sb-show', on);
        }

        // ===== 阶段四十五：自绘悬浮滚动条（微信同款：不占布局空间，消除容器边缘空隙） =====
        // 滑块挂载在 body 上（position:fixed 浮层）而非滚动容器内部：
        // 滚轮滚动由合成器线程即时移动内容层，容器内绝对定位的滑块会随内容先漂移、下一帧才被主线程
        // 修正回来，快速滚动时视觉上出现"重影"；fixed 浮层不受滚动位移影响，彻底消除
        function initOsb(el) {
            if (el._osb) return; // 防重复初始化
            el._osb = true;
            var thumb = document.createElement('div');
            thumb.className = 'osb-thumb';
            document.body.appendChild(thumb);
            thumb._osbHost = el; // 反向引用：悬停/移出判定时把滑块映射回宿主容器（防闪烁）
            el._osbThumb = thumb; // 供显隐标记联动（sbMark）
            // 按滚动比例刷新滑块位置与长度（比例同步，微信同款）；fixed 定位基于容器可视区实时矩形
            function osbUpdate() {
                var sh = el.scrollHeight, ch = el.clientHeight, st = el.scrollTop;
                if (sh <= ch + 1 || ch === 0) { thumb.style.display = 'none'; return; }
                var rect = el.getBoundingClientRect();
                if (rect.height === 0) { thumb.style.display = 'none'; return; }
                thumb.style.display = 'block';
                var h = Math.max(30, Math.round(ch * ch / sh)); // 滑块最小 30px，内容越多越短
                var maxTop = ch - h - 2; // 上下各留 2px 边距
                var viewTop = 2 + Math.round(st / Math.max(1, sh - ch) * (maxTop - 2));
                thumb.style.height = h + 'px';
                thumb.style.top = Math.round(rect.top + viewTop) + 'px';
                thumb.style.left = Math.round(rect.right - 8) + 'px'; // 右侧 2px 边距（宽 6px）
            }
            // 滚动同步：scroll 事件里只排 rAF，回调在"本轮渲染、绘制前"执行，与合成器滚动同帧，无滞后重影
            el.addEventListener('scroll', function () {
                if (!el._osbRaf) {
                    el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; osbUpdate(); });
                }
            }, { passive: true });
            if (window.ResizeObserver) new ResizeObserver(osbUpdate).observe(el); // 容器尺寸变化同步（窗口缩放/侧栏切换）
            // 列表重渲染（innerHTML 置空）后同步滚动范围（滑块在 body 上不会被移除，无需补回）
            if (window.MutationObserver) new MutationObserver(osbUpdate).observe(el, { childList: true });
            el.addEventListener('load', osbUpdate, true); // 捕获阶段监听内部图片加载完成（高度变化影响滚动范围）
            // 滑块拖拽：按下后按位移比例映射回 scrollTop（比例与 osbUpdate 一致）
            thumb.addEventListener('mousedown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var startY = e.clientY, startTop = el.scrollTop;
                thumb.classList.add('osb-drag');
                function osbMove(ev) {
                    var maxTop = el.clientHeight - thumb.offsetHeight - 2;
                    var dy = ev.clientY - startY;
                    el.scrollTop = startTop + dy * (el.scrollHeight - el.clientHeight) / Math.max(1, maxTop - 2);
                }
                function osbUp() {
                    thumb.classList.remove('osb-drag');
                    document.removeEventListener('mousemove', osbMove);
                    document.removeEventListener('mouseup', osbUp);
                }
                document.addEventListener('mousemove', osbMove);
                document.addEventListener('mouseup', osbUp);
            });
            osbUpdate();
        }
        // 主窗口全部纵向滚动容器（与 style.css 中 overflow-y: auto 的面板一一对应）
        // 阶段五十六：追加我的知识库弹窗库列表 .kb-list
        // 阶段五十七：追加我的智能体弹窗列表 #ua-list（该元素复用 kb-list 类，querySelector('.kb-list')
        // 仅命中 DOM 序靠前的知识库弹窗列表，须按 id 显式补初始化）
        // 阶段五十八：追加记忆管理弹窗列表 #memory-list（同坑：复用 kb-list 类，按 id 显式补初始化）
        // 通讯录/AI 助手列表同坑修复：.user-list 类被 #conv-list/#user-list/#ai-agent-list 三处复用，
        // 原 querySelector('.user-list') 仅命中 DOM 序第一的会话列表，通讯录与 AI Tab 列表从未挂上自绘滑块
        ['.message-list', '.conv-list', '#user-list', '#ai-agent-list', '.emoji-panel', '.search-panel', '.conv-search-results', '.new-friends-list', '.profile-content', '.kb-list', '#ua-list', '#memory-list']
            .forEach(function (sel) {
                var el = document.querySelector(sel);
                if (el) initOsb(el);
            });
    })();
})();
