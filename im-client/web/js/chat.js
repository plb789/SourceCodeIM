// chat.js - 消息收发、好友管理、渲染、主题、头像
(function () {
    var MSG = IMSocket.MSG;
    var currentChatUser = ''; // 空字符串表示群聊
    var friendList = []; // 好友列表 [{username, remark, group, online, avatar}]
    // 阶段八十五：群聊发送者昵称缓存（服务端归口：群聊帧 from_name / 历史帧 names 合并填充，逐条覆盖保持最新）
    var nickCache = {};
    // 群聊发送者展示名解析（微信式，与资料卡主名称规则一致）：好友备注 → 昵称 → 账号
    // 覆盖：群聊文字/图片/文件名称标签、引用前缀、撤回提示；备注是 viewing 方视角数据，由前端 friendList 叠加
    function senderDisplayName(u) {
        if (!u) return '';
        for (var i = 0; i < friendList.length; i++) {
            if (friendList[i].username === u) {
                var rk = (friendList[i].remark || '').trim();
                if (rk) return rk;
                break;
            }
        }
        return (nickCache[u] || '').trim() || u;
    }
    // 头像缺失修复：登录用户自己头像（服务端 LOGIN_RESP 下发，上传成功后同步更新），供消息气泡头像渲染
    var myAvatar = '';
    // 头像缺失修复：在线用户头像表（服务端 USER_LIST 推送，username -> avatar），
    // 群聊发送者可能不在好友列表（无法从 friendList 取头像），从在线用户列表兜底获取
    var userAvatars = {};
    // 阶段八十六：在线用户快照（同一 USER_LIST 推送重建，含非好友）——
    // 非好友私聊标题的在线状态兜底数据源（好友仍以 friendList.online 为准）
    var onlineUsers = {};
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
    // 阶段七十八：标题栏用户区元素（仅 PC 端 Electron 壳内可见；Web/手机端无 pc-titlebar 类标题栏整体不显示，保持 nav-rail 原位）
    var titlebarUserEl = document.getElementById('titlebar-user');
    var titlebarAvatarEl = document.getElementById('titlebar-avatar');
    var titlebarAvatarPhEl = document.getElementById('titlebar-avatar-ph');
    var titlebarUsernameEl = document.getElementById('titlebar-username');
    // 阶段七十八：标题栏 AI 积分（TRAE CN 同款，⚡ + 余额数字，服务端归口下发，前端不做任何积分计算）
    var titlebarPointsEl = document.getElementById('titlebar-points');
    var titlebarPointsNumEl = document.getElementById('titlebar-points-num');
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
    // 阶段八十六：资料面板积分行（只读，三端可见；与标题栏积分共用 setPointsBalance 归口刷新）
    var profilePointsEl = document.getElementById('profile-points');
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
    var agentMcpBtn = document.getElementById('agent-mcp-btn'); // 阶段九十：我的 MCP 服务器入口（仅 PC 端，本机 stdio 自定义）
    var webSearchBtn = document.getElementById('web-search-btn'); // 阶段六十九：普通聊天联网搜索开关（AI 会话且服务端开启时显示）
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
    // 阶段七十二：弹窗第二动作按钮（红色危险操作，如"永久删除"）——showChoice 双选项确认用，常规弹窗恒隐藏
    var modalExtra = document.getElementById('modal-extra');
    var toastEl = document.getElementById('toast');
    var toastTimer = null;
    var modalOkCallback = null; // 当前弹窗确定按钮回调
    var modalExtraCallback = null; // 第二动作按钮回调

    // 关闭弹窗
    function closeModal() {
        modalMask.classList.add('hidden');
        modalOkCallback = null;
        modalExtraCallback = null;
    }

    // 确认弹窗：title 标题、text 内容、onOk 确定回调、okText 确定按钮文字（默认"确定"）、cancelText 取消按钮文字（默认"取消"）
    function showConfirm(title, text, onOk, okText, cancelText) {
        modalTitle.textContent = title;
        modalText.textContent = text;
        modalText.classList.remove('hidden');
        modalInput.classList.add('hidden');
        modalOk.textContent = okText || '确定';
        modalCancel.textContent = cancelText || '取消';
        modalExtra.classList.add('hidden'); // 常规确认无第二动作
        modalOkCallback = onOk;
        modalMask.classList.remove('hidden');
    }

    // 阶段七十二：双选项弹窗——主选项（绿色 primary）+ 可选危险选项（红色）+ 取消。
    // 用于"清空显示（云端保留）/ 永久删除（不可恢复）"类二选一场景；extra 为 null 时退化为单选确认
    function showChoice(title, text, primaryText, onPrimary, extra) {
        modalTitle.textContent = title;
        modalText.textContent = text;
        modalText.classList.remove('hidden');
        modalInput.classList.add('hidden');
        modalOk.textContent = primaryText;
        modalOkCallback = onPrimary;
        if (extra) {
            modalExtra.textContent = extra.text;
            modalExtraCallback = extra.cb;
            modalExtra.classList.remove('hidden');
        } else {
            modalExtra.textContent = '';
            modalExtraCallback = null;
            modalExtra.classList.add('hidden');
        }
        modalCancel.textContent = '取消';
        modalMask.classList.remove('hidden');
    }

    // 输入弹窗：title 标题、placeholder 输入框占位提示、onOk 确定回调（参数为输入值）
    function showPrompt(title, placeholder, onOk, prefill) {
        if (typeof prefill !== 'string') prefill = '';
        modalTitle.textContent = title;
        modalText.textContent = '';
        modalText.classList.add('hidden');
        modalInput.classList.remove('hidden');
        modalInput.value = prefill; // 预填（如修改远程地址时带入当前地址），不传则保持空输入
        modalInput.placeholder = placeholder || '';
        modalOk.textContent = '确定';
        modalExtra.classList.add('hidden'); // 输入弹窗无第二动作
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
    // 阶段七十二：第二动作按钮（红色危险项，如"永久删除"）
    modalExtra.addEventListener('click', function () {
        var cb = modalExtraCallback;
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
        // 启动防闪揭幕：视图决策完成（有凭据→聊天界面 / 无凭据→登录界面），
        // 摘除 html.app-booting 显示目标视图，消除"登录页先画出来再被切换"的闪现
        document.documentElement.classList.remove('app-booting');
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
    // ===== 阶段七十七：PC 端自定义标题栏（Electron titleBarOverlay）主题同步 =====
    // 仅 Electron 壳内生效（window.desktop.setTitlebarColors 由 preload 注入，浏览器/手机 APP 不存在自动旁路）；
    // 原生窗口按钮底色/符号色必须与 style.css --titlebar-bg/--titlebar-fg、main.js titleBarOverlay 初值一致（三方同值，改动需同步）
    var TITLEBAR_COLORS = {
        light: { color: '#f5f5f5', symbolColor: '#333333' },
        dark: { color: '#1a1a1a', symbolColor: '#e0e0e0' }
    };
    // 解析生效主题（system 模式下跟随系统深浅）
    function titlebarIsDark(theme) {
        return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    function syncTitlebarTheme(theme) {
        if (!(window.desktop && window.desktop.setTitlebarColors)) return;
        var c = TITLEBAR_COLORS[titlebarIsDark(theme) ? 'dark' : 'light'];
        window.desktop.setTitlebarColors(c.color, c.symbolColor);
    }
    // 「跟随系统」模式下系统深浅切换时同步标题栏按钮配色（主题变量由 CSS 媒体查询自动生效）
    var titlebarSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var titlebarSchemeHandler = function () { syncTitlebarTheme(getTheme()); };
    if (titlebarSchemeQuery.addEventListener) titlebarSchemeQuery.addEventListener('change', titlebarSchemeHandler);
    else if (titlebarSchemeQuery.addListener) titlebarSchemeQuery.addListener(titlebarSchemeHandler);
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('im_theme', theme);
        syncTitlebarTheme(theme);
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

    // ===== 阶段一百零五：全屏设置页（TRAE CN 同款：标题栏齿轮入口，左侧分类导航+右侧内容区） =====
    var settingsMask = document.getElementById('settings-mask');
    var settingsBtn = document.getElementById('titlebar-settings');
    var settingsCloseBtn = document.getElementById('settings-close');
    var settingsNavItems = document.querySelectorAll('.settings-nav-item');
    var settingsViews = document.querySelectorAll('.settings-view');
    // 修订（用户实测反馈：铺满全屏会盖住左侧列表栏）——设置页仅占用主聊天区（浏览区）：
    // DOM 移入 .main-chat（position:relative 已就绪）配合 CSS absolute 定位，左侧列表保持可见可点
    var mainChatEl = document.querySelector('.main-chat');
    if (mainChatEl && settingsMask && settingsMask.parentElement !== mainChatEl) {
        mainChatEl.appendChild(settingsMask);
    }

    // 分类切换归口：导航高亮 + 内容面板显隐
    function settingsShowView(view) {
        // 阶段一百零五：MCP 仅 PC 端支持（Web/手机端无 desktop 桥），不支持时提示并留在当前分类
        if (view === 'mcp' && !agentMcpSupported()) {
            showToast('仅 PC 客户端支持自定义 MCP 服务器');
            return;
        }
        settingsNavItems.forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
        settingsViews.forEach(function (s) { s.classList.toggle('hidden', s.id !== 'settings-view-' + view); });
        if (view === 'appearance') settingsRenderTheme();
        if (view === 'rules') settingsRulesEnter(); // 阶段一百零五：TRAE 同款页内直管，进入即加载
    }

    // 主题卡片高亮当前主题（与标题栏主题按钮同源 getTheme）
    function settingsRenderTheme() {
        var cur = getTheme();
        document.querySelectorAll('.settings-theme-card').forEach(function (c) {
            c.classList.toggle('active', c.dataset.theme === cur);
        });
    }

    // 打开设置页：回填账号信息（用户名/头像/积分与标题栏同源，前端零计算），默认账号分类
    function settingsOpen() {
        settingsMask.classList.remove('hidden');
        var name = IMSocket.getUsername() || '';
        document.getElementById('settings-account-name').textContent = name || '未登录';
        document.getElementById('settings-username').textContent = name || '未登录';
        // 头像降级与导航栏同规则：img 默认隐藏，无头像/加载失败时显示首字母占位
        var av = document.getElementById('settings-avatar');
        var ph = document.getElementById('settings-avatar-ph');
        var src = currentAvatarEl && currentAvatarEl.src ? currentAvatarEl.src : '';
        if (src) {
            av.src = src; av.style.display = ''; ph.style.display = 'none';
        } else {
            av.style.display = 'none'; ph.style.display = '';
            ph.textContent = name ? name.charAt(0).toUpperCase() : '?';
        }
        // 积分与标题栏同源（服务端下发归口 setPointsBalance，前端只读取展示）
        var pts = titlebarPointsNumEl ? titlebarPointsNumEl.textContent : '';
        var ptsText = pts ? '⚡ ' + pts : '—';
        document.getElementById('settings-points').textContent = ptsText;
        document.getElementById('settings-account-points').textContent = pts ? pts + ' 积分' : '—';
        settingsShowView('account');
    }

    function settingsClose() {
        settingsMask.classList.add('hidden');
        // 阶段一百零五：MCP 面板随设置页关闭时同步停止状态轮询（closeMcpPanel 内含轮询清理）
        closeMcpPanel();
    }

    settingsBtn.addEventListener('click', settingsOpen);
    settingsCloseBtn.addEventListener('click', settingsClose);
    settingsNavItems.forEach(function (b) {
        b.addEventListener('click', function () { settingsShowView(b.dataset.view); });
    });
    // 主题卡片点击：应用主题并同步标题栏主题按钮图标（同一 applyTheme 归口，双入口状态一致）
    document.querySelectorAll('.settings-theme-card').forEach(function (c) {
        c.addEventListener('click', function () {
            applyTheme(c.dataset.theme);
            renderThemeBtn(c.dataset.theme);
            settingsRenderTheme();
        });
    });
    // 聚合入口：任务历史（复用现有弹窗，先关设置页避免层级叠置）
    // 【阶段一百零五修订】"打开规则与记忆管理"按钮已随页内直管改造移除（原弹窗与 memory-btn 入口保留可用）
    var settingsOpenTask = document.getElementById('settings-open-taskhist');
    if (settingsOpenTask) settingsOpenTask.addEventListener('click', function () {
        settingsClose();
        var tb = document.getElementById('taskhist-btn');
        if (tb) tb.click();
    });
    // 退出登录：与导航栏退出按钮同归口（清凭据+刷新），加二次确认防误触
    var settingsLogout = document.getElementById('settings-logout');
    if (settingsLogout) settingsLogout.addEventListener('click', function () {
        showConfirm('退出登录', '确定退出当前账号？', function () {
            clearAuth();
            location.reload();
        }, '退出');
    });
    // Esc 关闭设置页（捕获阶段优先处理：设置页在全屏最顶层，开启时不让 Esc 穿透到下层弹窗）
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !settingsMask.classList.contains('hidden')) {
            e.stopPropagation();
            settingsClose();
        }
    }, true);

    // ===== 阶段一百零五：设置页"规则与记忆"TRAE CN 同款页内直管 =====
    // 布局：规则卡片（头+范围页签+创建行+条目）/ 记忆卡片（头+总开关+添加行+条目）；
    // API 与阶段一百零四弹窗同归口 /api/agents/{id}/rules、/api/agents/{id}/memory，双入口并存
    var settingsRuleScope = 'global'; // 规则页签当前范围（global=全局 / agent=仅本智能体）
    var settingsRulesData = [];       // 规则全量缓存（一次拉取，前端按页签范围过滤渲染）

    // 空态渲染归口（居中图标+主副两行文字，TRAE 同款）
    function settingsEmptyAt(listId, main, sub) {
        var el = document.getElementById(listId);
        if (!el) return;
        el.innerHTML = '<div class="settings-empty">' +
            '<svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>' +
            '<div class="settings-empty-main"></div><div class="settings-empty-sub"></div></div>';
        el.querySelector('.settings-empty-main').textContent = main;
        el.querySelector('.settings-empty-sub').textContent = sub;
    }

    // 进入"规则与记忆"分类：校验智能体上下文并加载两组数据
    // silent=静默刷新（会话切换联动用）：不清空列表不显示"加载中"，数据到达后原位重绘，避免残影闪烁
    function settingsRulesEnter(silent) {
        var idOk = memAgentId() > 0; // 依赖当前会话智能体（memAgentId 为函数声明提升，同作用域可调）
        var ruleCreate = document.getElementById('settings-rule-create');
        if (ruleCreate) ruleCreate.disabled = !idOk;
        var pref = document.getElementById('settings-mem-pref');
        if (!idOk) {
            if (pref) { pref.disabled = true; pref.checked = false; }
            var row = document.getElementById('settings-mem-create-row');
            if (row) row.classList.add('hidden');
            settingsEmptyAt('settings-rule-list', '请先选择智能体', '在左侧会话列表选择一个 AI 智能体后再管理规则');
            settingsEmptyAt('settings-mem-list', '请先选择智能体', '在左侧会话列表选择一个 AI 智能体后再管理记忆');
            return;
        }
        if (pref) pref.disabled = false;
        var memRow = document.getElementById('settings-mem-create-row');
        if (memRow) memRow.classList.remove('hidden');
        sRulesLoad(silent);
        sMemLoad(silent);
    }

    // 规则列表：全量拉取后按页签范围过滤（全局=agent_id 0 / 仅本智能体=当前会话智能体 id）
    function sRulesLoad(silent) {
        var listEl = document.getElementById('settings-rule-list');
        if (!silent && listEl) listEl.innerHTML = '<div class="kb-empty">加载中…</div>';
        fetch('/api/agents/' + memAgentId() + '/rules?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '规则加载失败'); return; }
                settingsRulesData = res.data.rules || [];
                sRulesRender();
            })
            .catch(function () { showToast('规则加载失败'); });
    }

    function sRulesRender() {
        var listEl = document.getElementById('settings-rule-list');
        if (!listEl) return;
        var scopeId = settingsRuleScope === 'global' ? 0 : memAgentId();
        var list = settingsRulesData.filter(function (ru) { return (ru.agent_id || 0) === scopeId; });
        if (!list.length) {
            settingsEmptyAt('settings-rule-list', '暂无规则', '点击右上角「+ 创建」以添加你的第一个规则');
            return;
        }
        listEl.innerHTML = '';
        list.forEach(function (ru) {
            var item = document.createElement('div');
            item.className = 'settings-entity-item';
            var content = document.createElement('span');
            content.className = 'settings-entity-content';
            content.textContent = ru.content;
            content.title = ru.content;
            // 启用开关（禁用后不注入不删除，可随时恢复；复用弹窗同款 memory-switch 样式）
            var en = document.createElement('input');
            en.type = 'checkbox';
            en.className = 'memory-switch';
            en.checked = !!ru.enabled;
            en.title = en.checked ? '已启用（点击禁用）' : '已禁用（点击启用）';
            en.addEventListener('change', function () {
                var want = en.checked;
                fetch('/api/agents/' + memAgentId() + '/rules/' + ru.id + '/enabled?username=' + kbUsername(), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: want })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '保存失败'); en.checked = !want; return; }
                        ru.enabled = want;
                        showToast(want ? '规则已启用' : '规则已禁用（不删除）');
                    })
                    .catch(function () { showToast('保存失败'); en.checked = !want; });
            });
            var del = document.createElement('button');
            del.className = 'kb-op-btn';
            del.textContent = '删除';
            del.addEventListener('click', function () {
                fetch('/api/agents/' + memAgentId() + '/rules/' + ru.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('规则已删除');
                        sRulesLoad();
                    })
                    .catch(function () { showToast('删除失败'); });
            });
            item.appendChild(content);
            item.appendChild(en);
            item.appendChild(del);
            listEl.appendChild(item);
        });
    }

    // 规则添加：范围=当前页签（global/agent），保存后下轮回答即生效
    function sRulesAdd() {
        var input = document.getElementById('settings-rule-input');
        var content = (input.value || '').trim();
        if (!content) { showToast('请输入规则内容'); return; }
        fetch('/api/agents/' + memAgentId() + '/rules?username=' + kbUsername(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, scope: settingsRuleScope })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '添加失败'); return; }
                showToast('规则已添加，下轮回答即生效');
                input.value = '';
                sRulesLoad();
            })
            .catch(function () { showToast('添加失败'); });
    }

    // 记忆：列表+总开关（feature 未配置时禁用开关并提示）+添加+单条删除（silent 同规则列表）
    function sMemLoad(silent) {
        var listEl = document.getElementById('settings-mem-list');
        if (!silent && listEl) listEl.innerHTML = '<div class="kb-empty">加载中…</div>';
        fetch('/api/agents/' + memAgentId() + '/memory?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '记忆加载失败'); return; }
                var featureOk = !!res.data.feature;
                var pref = document.getElementById('settings-mem-pref');
                if (pref) { pref.checked = !!res.data.pref; pref.disabled = !featureOk; }
                var memRow = document.getElementById('settings-mem-create-row');
                if (memRow) memRow.classList.toggle('hidden', !featureOk);
                sMemRender(res.data.memories || []);
            })
            .catch(function () { showToast('记忆加载失败'); });
    }

    function sMemRender(list) {
        var listEl = document.getElementById('settings-mem-list');
        if (!listEl) return;
        if (!list.length) {
            settingsEmptyAt('settings-mem-list', '暂无记忆', '聊几句或手动添加一条试试');
            return;
        }
        listEl.innerHTML = '';
        list.forEach(function (m) {
            var item = document.createElement('div');
            item.className = 'settings-entity-item';
            var content = document.createElement('span');
            content.className = 'settings-entity-content';
            content.textContent = m.content;
            content.title = m.content;
            // 来源标签：手动添加（主题色实底）/ 任务经验（主题色描边）/ 自动提取（灰），与弹窗同规则
            var tag = document.createElement('span');
            if (m.source === 'manual') {
                tag.className = 'kb-item-tag user';
                tag.textContent = '手动';
            } else if (m.source === 'agent') {
                tag.className = 'kb-item-tag agent';
                tag.textContent = '任务';
            } else {
                tag.className = 'kb-item-tag public';
                tag.textContent = '自动';
            }
            var del = document.createElement('button');
            del.className = 'kb-op-btn';
            del.textContent = '删除';
            del.addEventListener('click', function () {
                fetch('/api/agents/' + memAgentId() + '/memory/' + m.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('记忆已删除');
                        sMemLoad();
                    })
                    .catch(function () { showToast('删除失败'); });
            });
            item.appendChild(content);
            item.appendChild(tag);
            item.appendChild(del);
            listEl.appendChild(item);
        });
    }

    // 记忆手动添加（服务端走去重归口，重复内容会提示已存在）
    function sMemAdd() {
        var input = document.getElementById('settings-mem-input');
        var content = (input.value || '').trim();
        if (!content) { showToast('请输入记忆内容'); return; }
        fetch('/api/agents/' + memAgentId() + '/memory?username=' + kbUsername(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '添加失败'); return; }
                showToast('记忆已添加');
                input.value = '';
                sMemLoad();
            })
            .catch(function () { showToast('添加失败'); });
    }

    // 设置页规则与记忆交互绑定
    var sRuleCreate = document.getElementById('settings-rule-create');
    if (sRuleCreate) sRuleCreate.addEventListener('click', function () {
        var row = document.getElementById('settings-rule-create-row');
        row.classList.toggle('hidden');
        if (!row.classList.contains('hidden')) document.getElementById('settings-rule-input').focus();
    });
    document.querySelectorAll('.settings-scope-tab').forEach(function (t) {
        t.addEventListener('click', function () {
            settingsRuleScope = t.dataset.scope;
            document.querySelectorAll('.settings-scope-tab').forEach(function (x) {
                x.classList.toggle('active', x === t);
            });
            sRulesRender(); // 页签切换仅前端过滤，不重新拉取
        });
    });
    var sRuleConfirm = document.getElementById('settings-rule-confirm');
    if (sRuleConfirm) sRuleConfirm.addEventListener('click', sRulesAdd);
    var sRuleInput = document.getElementById('settings-rule-input');
    if (sRuleInput) sRuleInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sRulesAdd(); }
    });
    var sMemConfirm = document.getElementById('settings-mem-confirm');
    if (sMemConfirm) sMemConfirm.addEventListener('click', sMemAdd);
    var sMemInput = document.getElementById('settings-mem-input');
    if (sMemInput) sMemInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sMemAdd(); }
    });
    // 记忆总开关（与弹窗同归口 PUT /memory/pref；关闭后不再提取与注入，已存记忆保留）
    var sMemPref = document.getElementById('settings-mem-pref');
    if (sMemPref) sMemPref.addEventListener('change', function () {
        var want = sMemPref.checked;
        fetch('/api/agents/' + memAgentId() + '/memory/pref?username=' + kbUsername(), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: want })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '保存失败'); sMemPref.checked = !want; return; }
                showToast(want ? '已开启记忆' : '已关闭记忆（已存记忆保留）');
            })
            .catch(function () { showToast('保存失败'); sMemPref.checked = !want; });
    });

    // ===== 头像降级修复：导航栏左上角头像统一入口 =====
    // 原实现：各处直接 currentAvatarEl.src 赋值，新注册账号 avatar 为空时 img 空 src 被浏览器渲染为破图（碎图标）
    var navAvatarFailedUrl = ''; // 记录加载失败的头像地址，避免重复设置同一失效 URL（缓存错误结果）导致空白
    // 有头像显示图片，无头像显示账号首字母占位（跟随主题色）
    function setNavAvatar(url) {
        var okImg = url && url !== navAvatarFailedUrl;
        if (okImg) {
            currentAvatarEl.src = url;
            currentAvatarEl.style.display = '';
            navAvatarPhEl.style.display = 'none';
            // 阶段七十八：标题栏头像同步（同一数据源，上传/资料保存后两处同时刷新）
            titlebarAvatarEl.src = url;
            titlebarAvatarEl.style.display = '';
            titlebarAvatarPhEl.style.display = 'none';
        } else {
            // 关键：空 src 会被浏览器渲染为破图，必须移除 src 并隐藏 img，改显首字母占位
            currentAvatarEl.removeAttribute('src');
            currentAvatarEl.style.display = 'none';
            navAvatarPhEl.textContent = (IMSocket.getUsername() || '?').charAt(0).toUpperCase();
            navAvatarPhEl.style.display = 'flex';
            // 阶段七十八：标题栏同步降级为首字母占位
            titlebarAvatarEl.removeAttribute('src');
            titlebarAvatarEl.style.display = 'none';
            titlebarAvatarPhEl.textContent = (IMSocket.getUsername() || '?').charAt(0).toUpperCase();
            titlebarAvatarPhEl.style.display = 'flex';
        }
    }
    // 头像文件失效（文件被清理/路径变更）时降级为首字母占位，避免破图
    currentAvatarEl.addEventListener('error', function () {
        navAvatarFailedUrl = currentAvatarEl.getAttribute('src') || '';
        setNavAvatar('');
    });
    // 阶段七十八：标题栏头像同样降级（两处 img 同 src，任一失效统一走降级入口）
    titlebarAvatarEl.addEventListener('error', function () {
        navAvatarFailedUrl = titlebarAvatarEl.getAttribute('src') || '';
        setNavAvatar('');
    });
    // 占位头像与图片头像点击行为一致：打开个人资料面板
    navAvatarPhEl.addEventListener('click', openProfilePanel);
    // 阶段七十八：标题栏用户区（头像+账号）整块可点，行为与 nav-rail 顶部头像一致（CSS no-drag 保证可点击）
    titlebarUserEl.addEventListener('click', openProfilePanel);

    // ===== 阶段七十八：标题栏 AI 积分显示（TRAE CN 同款）=====
    // 服务端归口：余额仅来自登录响应/AI 结束帧下发，前端只做展示，不做任何扣减计算；
    // 双精度：服务端按 tokens/1000 保留 3 位小数扣除，前端展示格式化最多 2 位小数去尾零（94.506 → 94.51）
    function setPointsBalance(n) {
        var v = Math.round(Number(n) * 100) / 100;
        titlebarPointsNumEl.textContent = String(v);
        titlebarPointsEl.style.display = ''; // CSS 默认 display:none，清空内联后按样式表 flex 显示
        // 阶段八十六：资料面板积分行同步刷新（面板打开时实时跟随，Web/手机端仅此处可见积分）
        if (profilePointsEl) profilePointsEl.textContent = String(v);
        // 悬停提示走 index.html 静态 data-tip + CSS 自绘气泡（不设原生 title，否则停留 1-2 秒会叠出系统气泡）
    }

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

    // 我的名称展示归口：昵称优先，无昵称（空/纯空白）降级显示账号
    // 覆盖位置：PC 端标题栏用户区 + Web/手机端侧栏顶部用户名（两侧同步刷新，三端规则一致）
    // 数据源：登录响应 profile.nickname / 资料响应 PROFILE_RESP（服务端归口，多端同步）
    function syncMyDisplayName() {
        var name = (myProfile.nickname || '').trim() || IMSocket.getUsername();
        if (titlebarUsernameEl) titlebarUsernameEl.textContent = name;
        if (currentUserEl) currentUserEl.textContent = name;
    }

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
            // 资料更新/多端同步后展示名即时跟随：昵称优先，无昵称降级账号（标题栏+侧栏顶部）
            syncMyDisplayName();
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
        // 阶段八十八：只改 .mi-text 文字节点——直接赋 textContent 会连同 SVG 图标一起清掉（实测丢图标根因）
        var pinItem = msgMenu.querySelector('[data-action="pin"]');
        var pinLabel = pinItem.querySelector('.mi-text') || pinItem;
        var p = pinInfo[currentChatUser];
        pinLabel.textContent = (p && p.msg_id && p.msg_id === msgId) ? '取消置顶' : '置顶';
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
                } else if (action === 'forward' && msgId) {
                    // 阶段八十六：微信同款消息转发——打开目标选择弹窗（文本/引用原样；图片/文件重取后走直传）
                    fwdMode = 'single';
                    openForwardPicker(msgTarget);
                } else if (action === 'copy') {
                    // 阶段八十八：右键复制——文本取气泡可见文本（含引用块）；图片转 PNG 写剪贴板（降级复制链接）；文件复制文件名
                    copyMsgContent(msgTarget);
                } else if (action === 'multi' && msgId) {
                    // 阶段八十七：进入多选模式（复选框 + 底部工具栏，合并转发/逐条转发）
                    enterMultiSelect();
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

    // ===== 阶段八十六：消息转发（微信同款：右键转发 → 目标选择弹窗 → 确认发送） =====
    var fwdMask = document.getElementById('fwd-mask');
    var fwdSearch = document.getElementById('fwd-search');
    var fwdList = document.getElementById('fwd-list');
    var fwdCancel = document.getElementById('fwd-cancel');
    var fwdPendingEl = null; // 待转发的消息元素（弹窗关闭即释放）
    // 阶段八十七：转发模式——single 单条（默认）｜merge 多选合并｜multi 多选逐条
    var fwdMode = 'single';

    function openForwardPicker(el) {
        fwdPendingEl = el || null; // 多选模式不携带单条元素（阶段八十七）
        fwdSearch.value = '';
        renderForwardList('');
        fwdMask.classList.remove('hidden');
    }

    function closeForwardPicker() {
        fwdMask.classList.add('hidden');
        fwdPendingEl = null;
    }
    fwdCancel.addEventListener('click', closeForwardPicker);
    fwdMask.addEventListener('click', function (e) {
        if (e.target === fwdMask) closeForwardPicker(); // 点遮罩关闭（转发未执行无误操作风险）
    });
    fwdSearch.addEventListener('input', function () {
        renderForwardList(fwdSearch.value.trim().toLowerCase());
    });

    // 目标列表：群聊置顶 + 好友（排除 AI 智能体会话，在线优先同通讯录排序），按备注/昵称/账号关键字过滤
    function renderForwardList(kw) {
        fwdList.innerHTML = '';
        var items = [];
        if (!kw || '群聊'.indexOf(kw) >= 0 || 'group'.indexOf(kw) >= 0) {
            items.push({ target: '', name: '群聊', sub: '群内所有成员可见', ph: '群' });
        }
        for (var i = 0; i < friendList.length; i++) {
            var f = friendList[i];
            if (isAIAgent(f.username)) continue; // AI 智能体会话不作为转发目标（微信无此语义）
            var disp = (f.remark || '').trim() || (nickCache[f.username] || '').trim() || f.username;
            if (kw && disp.toLowerCase().indexOf(kw) < 0 && f.username.toLowerCase().indexOf(kw) < 0) continue;
            items.push({ target: f.username, name: disp, sub: f.username + (f.online ? ' · 在线' : ''), avatar: f.avatar, online: f.online });
        }
        if (!items.length) {
            fwdList.innerHTML = '<div class="fwd-empty">无匹配联系人</div>';
            return;
        }
        items.sort(function (a, b) { // 在线优先（群聊项视为恒在线置顶）
            return (b.online === true || b.target === '' ? 1 : 0) - (a.online === true || a.target === '' ? 1 : 0);
        });
        items.forEach(function (it) {
            var item = document.createElement('div');
            item.className = 'fwd-item';
            if (it.avatar) {
                var av = document.createElement('img');
                av.className = 'fwd-avatar';
                av.src = it.avatar;
                item.appendChild(av);
            } else {
                var ph = document.createElement('span');
                ph.className = 'fwd-avatar-ph';
                ph.textContent = it.ph || (it.name || '?').charAt(0).toUpperCase();
                item.appendChild(ph);
            }
            var info = document.createElement('div');
            info.className = 'fwd-info';
            var nm = document.createElement('div');
            nm.className = 'fwd-name';
            nm.textContent = it.name;
            var sub = document.createElement('div');
            sub.className = 'fwd-sub';
            sub.textContent = it.sub || '';
            info.appendChild(nm);
            info.appendChild(sub);
            item.appendChild(info);
            item.addEventListener('click', function () {
                var el = fwdPendingEl; // 闭包先捕获，弹窗关闭会清空引用
                var mode = fwdMode;
                closeForwardPicker();
                if (mode === 'merge') {
                    // 阶段八十七：多选合并转发——多条打包为一条"聊天记录"信封消息
                    showConfirm('合并转发', '将选中的 ' + multiSelectedCount() + ' 条消息合并转发给「' + it.name + '」？', function () {
                        sendMergedForward(it.target);
                    }, '发送');
                } else if (mode === 'multi') {
                    // 阶段八十七：逐条转发——按时间顺序逐条原样转发
                    showConfirm('逐条转发', '将选中的 ' + multiSelectedCount() + ' 条消息逐条转发给「' + it.name + '」？', function () {
                        sendMultiForward(it.target);
                    }, '发送');
                } else {
                    showConfirm('转发', '转发给「' + it.name + '」？', function () {
                        doForward(el, it.target);
                    }, '发送');
                }
            });
            fwdList.appendChild(item);
        });
    }

    // 从消息源地址（服务端 URL / 本地 blob / dataURL）重取内容构造 File，复用既有上传链路
    function fetchSrcAsFile(src, fallbackName) {
        return fetch(src).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
        }).then(function (b) {
            return new File([b], fallbackName || '文件', { type: b.type || 'application/octet-stream' });
        });
    }

    // 执行转发：图片/文件重取后走直传（suppressLocal 防污染当前视图）；文本/引用信封原样重发（服务端回显渲染）
    // silent：逐条转发（阶段八十七）循环调用时抑制单条 toast，由 sendMultiForward 汇总提示
    function doForward(el, target, silent) {
        if (!el) return;
        var bubble = el.querySelector('.message-bubble');
        // 图片消息
        var img = bubble ? bubble.querySelector('.chat-image') : null;
        if (img && img.getAttribute('src')) {
            fetchSrcAsFile(img.getAttribute('src'), 'image.png').then(function (f) {
                if (target === '') {
                    sendGroupImage(f, true);
                    if (!silent) showToast('已转发');
                } else {
                    sendFileDirect(f, target, true).then(function (res) {
                        if (!silent) showToast(res && res.ok ? '已转发' : '转发失败（HTTP ' + (res ? res.status : '网络') + '）');
                    }).catch(function () { if (!silent) showToast('转发失败'); });
                }
            }).catch(function () { if (!silent) showToast('转发失败：图片获取失败'); });
            return;
        }
        // 文件消息（群聊不收文件，与发送按钮既有口径一致）
        if (bubble && bubble.classList.contains('bubble-file')) {
            if (target === '') { showToast('群聊暂不支持转发文件'); return; }
            var furl = bubble.getAttribute('data-url') || '';
            if (!furl) { showToast('该消息暂不支持转发'); return; }
            var fnameEl = bubble.querySelector('.file-name');
            fetchSrcAsFile(furl, (fnameEl && fnameEl.textContent) || '文件').then(function (f) {
                sendFileDirect(f, target, true).then(function (res) {
                    if (!silent) showToast(res && res.ok ? '已转发' : '转发失败（HTTP ' + (res ? res.status : '网络') + '）');
                }).catch(function () { if (!silent) showToast('转发失败'); });
            }).catch(function () { if (!silent) showToast('转发失败：文件获取失败'); });
            return;
        }
        // 文本 / 引用信封 / AI 文本：原始 content 原样重发（引用块完整保真），降级取正文可见文本
        var raw = el.getAttribute('data-raw');
        var tx = bubble ? bubble.querySelector('.msg-text') : null;
        var content = raw || ((tx ? tx.textContent : (bubble ? bubble.textContent : '')) || '').trim();
        if (!content) { showToast('该消息不支持转发'); return; }
        var m = { msg_type: target === '' ? MSG.GROUP_CHAT : MSG.PRIVATE, content: content };
        if (target !== '') m.to_user = target;
        if (IMSocket.send(m)) { if (!silent) showToast('已转发'); } else showToast('转发失败');
    }

    // ===== 阶段八十七：多选合并转发（微信同款：复选框勾选 → 工具栏合并/逐条转发） =====
    var multiSelectMode = false;
    var multiSelected = {};   // msgId -> true（选中集合，DOM 顺序在发送时按列表顺序重采）
    var inputBarEl = document.getElementById('input-bar');
    var msBarEl = document.getElementById('ms-bar');
    var msCountEl = document.getElementById('ms-count');
    var msMergeBtn = document.getElementById('ms-merge');
    var msSingleBtn = document.getElementById('ms-single');
    var msSaveBtn = document.getElementById('ms-save');   // 阶段八十八：保存到电脑
    var msCopyBtn = document.getElementById('ms-copy');   // 阶段八十八：复制
    var msDelBtn = document.getElementById('ms-del');     // 阶段八十八：删除
    var msCancelBtn = document.getElementById('ms-cancel');
    var mergedCache = {};     // mergeKey -> 合并信封（详情弹窗数据源；信封可能超 data-raw 上限不走 DOM）
    var mergedSeq = 0;

    function multiSelectedCount() {
        return Object.keys(multiSelected).length;
    }

    function enterMultiSelect() {
        if (multiSelectMode) return;
        // AI 会话消息为问答流，合并转发语义不适用（群聊 currentChatUser==='' 是多选主场景，放行）
        if (isAIAgent(currentChatUser)) {
            showToast('AI 会话暂不支持多选转发');
            return;
        }
        multiSelectMode = true;
        multiSelected = {};
        inputBarEl.classList.add('ms-mode');
        msBarEl.classList.remove('hidden');
        messageList.classList.add('multi-select'); // 阶段八十八：复选框列样式归口（悬停手型 + 自消息行放宽对齐）
        updateMsCount();
        // 为可选中消息（有 msg_id）插入复选框；系统提示/撤回提示等无 id 消息自然排除
        messageList.querySelectorAll('.message[data-msg-id]').forEach(function (el) {
            if (el.querySelector('.ms-check')) return;
            var ck = document.createElement('span');
            ck.className = 'ms-check';
            el.appendChild(ck);
        });
    }

    function exitMultiSelect() {
        if (!multiSelectMode) return;
        multiSelectMode = false;
        multiSelected = {};
        inputBarEl.classList.remove('ms-mode');
        msBarEl.classList.add('hidden');
        messageList.classList.remove('multi-select');
        messageList.querySelectorAll('.ms-check').forEach(function (ck) { ck.remove(); });
        messageList.querySelectorAll('.message.selected').forEach(function (el) { el.classList.remove('selected'); });
    }

    function updateMsCount() {
        var n = multiSelectedCount();
        msCountEl.textContent = '已选 ' + n + ' 条';
        msMergeBtn.disabled = msSingleBtn.disabled = n === 0;
        // 阶段八十八：保存到电脑/复制/删除同样需有选中项才可用
        msSaveBtn.disabled = msCopyBtn.disabled = msDelBtn.disabled = n === 0;
    }

    // 多选模式点击归口（捕获阶段）：整条消息点击即切换勾选，并拦截图片预览/文件下载/头像资料卡等子交互
    messageList.addEventListener('click', function (e) {
        if (!multiSelectMode) return;
        var row = e.target.closest ? e.target.closest('.message[data-msg-id]') : null;
        e.stopPropagation();
        e.preventDefault();
        if (!row) return;
        var id = row.getAttribute('data-msg-id');
        // 多选模式期间新到达的消息无复选框，首次勾选时补插（与既有消息视觉一致）
        if (!row.querySelector('.ms-check')) {
            var ck = document.createElement('span');
            ck.className = 'ms-check';
            row.appendChild(ck);
        }
        if (multiSelected[id]) {
            delete multiSelected[id];
            row.classList.remove('selected');
        } else {
            multiSelected[id] = true;
            row.classList.add('selected');
        }
        updateMsCount();
    }, true);

    msCancelBtn.addEventListener('click', exitMultiSelect);
    // 合并/逐条转发：带模式打开目标选择弹窗（选择器确认后按模式分流）
    msMergeBtn.addEventListener('click', function () {
        if (!multiSelectedCount()) return;
        fwdMode = 'merge';
        openForwardPicker(null);
    });
    msSingleBtn.addEventListener('click', function () {
        if (!multiSelectedCount()) return;
        fwdMode = 'multi';
        openForwardPicker(null);
    });

    // ===== 阶段八十八：多选保存到电脑/复制/删除 =====
    // 选区内容重采（与 buildMergedPayload 同构的 DOM 提取，但不做 blob/data 跳过——
    // 本会话内 blob/data 地址可下载可读，仅转发跨会话场景才不可用）
    function collectSelectedItems() {
        var items = [];
        multiSelectedEls().forEach(function (el) {
            var bubble = el.querySelector('.message-bubble');
            if (!bubble) return;
            var item = {
                f: el.getAttribute('data-from') || '',
                t: parseInt(el.getAttribute('data-ts'), 10) || 0
            };
            var img = bubble.querySelector('.chat-image');
            if (img && img.getAttribute('src')) {
                item.k = 'image';
                item.u = img.getAttribute('src');
            } else if (bubble.classList.contains('bubble-file')) {
                item.k = 'file';
                item.u = bubble.getAttribute('data-url') || '';
                var fnEl = bubble.querySelector('.file-name');
                item.n = (fnEl && fnEl.textContent) || '文件';
            } else {
                var tx = bubble.querySelector('.msg-text');
                var text = ((tx ? tx.textContent : (bubble.textContent || '')) || '').trim();
                if (!text) return;
                item.k = 'text';
                item.x = text;
            }
            items.push(item);
        });
        return items;
    }

    // 选中项展示时间（txt 导出/复制用，无时间戳省略）
    function fmtSelTime(ts) {
        if (!ts) return '';
        var d = new Date(ts * 1000);
        return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
            ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    // 从 URL 猜下载文件名（data:/blob: 无路径语义用 fallback；服务端 URL 取末段）
    function guessSelFileName(u, fallback) {
        if (!u || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) return fallback;
        var seg = (u.split('?')[0] || '').split('/');
        try { return decodeURIComponent(seg.pop()) || fallback; } catch (e) { return fallback; }
    }

    // 触发浏览器下载（与 onFileCardClick 同一 <a download> 归口；多文件间隔 200ms 防浏览器连发限流）
    function triggerSelDownload(url, name, delayMs) {
        setTimeout(function () {
            var a = document.createElement('a');
            a.href = url || '';
            a.download = name || 'file';
            a.click();
        }, delayMs || 0);
    }

    // 保存到电脑：图片/文件逐个下载，文本消息汇总为 txt（仅存在文本消息时生成）
    msSaveBtn.addEventListener('click', function () {
        var items = collectSelectedItems();
        if (!items.length) { showToast('选中的消息暂无可保存的内容'); return; }
        var delay = 0;
        var fileCount = 0;
        var lines = [];
        items.forEach(function (it) {
            var name = senderDisplayName(it.f) || it.f || '';
            var time = fmtSelTime(it.t);
            if (it.k === 'image') {
                triggerSelDownload(it.u, guessSelFileName(it.u, 'image_' + ((it.t || Date.now() / 1000) | 0) + '.png'), delay);
                delay += 200;
                fileCount++;
            } else if (it.k === 'file') {
                triggerSelDownload(it.u, guessSelFileName(it.u, it.n || 'file'), delay);
                delay += 200;
                fileCount++;
            } else {
                lines.push((name + (time ? ' ' + time : '')) + '\n' + (it.x || ''));
            }
        });
        if (lines.length) {
            var d = new Date();
            var stamp = '' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) +
                '_' + ('0' + d.getHours()).slice(-2) + ('0' + d.getMinutes()).slice(-2);
            var blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = '聊天记录_' + stamp + '.txt';
            a.click();
            fileCount++;
        }
        exitMultiSelect();
        showToast('已保存 ' + fileCount + ' 个文件到下载目录');
    });

    // 复制：文本原文 + 图片/文件占位，带发送者与时间头（微信合并复制同款格式）
    msCopyBtn.addEventListener('click', function () {
        var items = collectSelectedItems();
        if (!items.length) { showToast('选中的消息暂无可复制的内容'); return; }
        var lines = items.map(function (it) {
            var name = senderDisplayName(it.f) || it.f || '';
            var time = fmtSelTime(it.t);
            var head = name + (time ? ' ' + time : '');
            var body = it.k === 'image' ? '[图片]' : (it.k === 'file' ? '[文件] ' + (it.n || '') : (it.x || ''));
            return head + '\n' + body;
        });
        copyTextToClipboard(lines.join('\n\n'));
    });

    // 删除：与单条删除同归口（MSG.DELETE 仅从自己的聊天窗口移除，云端对对方仍可见）
    msDelBtn.addEventListener('click', function () {
        var els = multiSelectedEls();
        var n = els.length;
        if (!n) { showToast('未选中任何消息'); return; }
        showConfirm('删除消息', '确定删除选中的 ' + n + ' 条消息吗？仅从你的聊天窗口移除。', function () {
            els.forEach(function (el) {
                var id = parseInt(el.getAttribute('data-msg-id'), 10) || 0;
                if (id) IMSocket.send({ msg_type: MSG.DELETE, msg_id: id });
                el.remove();
            });
            exitMultiSelect();
            showToast('已删除 ' + n + ' 条消息');
        }, '删除');
    });

    // 从 DOM 顺序重采选中元素（列表顺序即时间顺序，跨页选中的历史消息仅取当前窗口内存在的）
    function multiSelectedEls() {
        var els = [];
        messageList.querySelectorAll('.message[data-msg-id]').forEach(function (el) {
            if (multiSelected[el.getAttribute('data-msg-id')]) els.push(el);
        });
        return els;
    }

    // 构造合并信封 {merged:{c:总条数,i:[{f:发送者,t:时间,k:类型,...}]}}；超出 48KB 拒发（Message.Content 为 TEXT 64KB 上限，留安全余量）
    // blob:/data: 源（图片/文件尚未完成上传回填）无法跨会话访问，跳过并计数提示
    function buildMergedPayload() {
        var items = [];
        var skipped = 0;
        multiSelectedEls().forEach(function (el) {
            var bubble = el.querySelector('.message-bubble');
            if (!bubble) return;
            var item = {
                f: el.getAttribute('data-from') || '',
                t: parseInt(el.getAttribute('data-ts'), 10) || 0
            };
            var img = bubble.querySelector('.chat-image');
            if (img && img.getAttribute('src')) {
                var src = img.getAttribute('src');
                if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) { skipped++; return; }
                item.k = 'image';
                item.u = src;
            } else if (bubble.classList.contains('bubble-file')) {
                var furl = bubble.getAttribute('data-url') || '';
                if (!furl || furl.indexOf('blob:') === 0) { skipped++; return; }
                item.k = 'file';
                item.u = furl;
                var fnEl = bubble.querySelector('.file-name');
                item.n = (fnEl && fnEl.textContent) || '文件';
                var fsEl = bubble.querySelector('.file-size');
                item.s = (fsEl && fsEl.textContent) || '';
            } else {
                var tx = bubble.querySelector('.msg-text');
                var text = ((tx ? tx.textContent : (bubble.textContent || '')) || '').trim();
                if (!text) { skipped++; return; }
                item.k = 'text';
                item.x = text;
            }
            items.push(item);
        });
        if (!items.length) return { err: '选中的消息暂不支持合并转发' };
        var payload = JSON.stringify({ merged: { c: items.length, i: items } });
        if (payload.length > 48000) return { err: '合并内容过大，请减少勾选条数' };
        return { payload: payload, items: items, skipped: skipped };
    }

    function sendMergedForward(target) {
        var built = buildMergedPayload();
        if (built.err) { showToast(built.err); return; }
        var m = { msg_type: target === '' ? MSG.GROUP_CHAT : MSG.PRIVATE, content: built.payload };
        if (target !== '') m.to_user = target;
        if (!IMSocket.send(m)) { showToast('转发失败'); return; }
        exitMultiSelect();
        showToast(built.skipped ? ('已转发（' + built.skipped + '条未完成上传的消息已跳过）') : '已转发');
    }

    function sendMultiForward(target) {
        var els = multiSelectedEls();
        if (!els.length) { showToast('选中的消息暂不支持转发'); return; }
        var n = els.length;
        els.forEach(function (el) { doForward(el, target, true); }); // 静默逐条（异步上传各自进行）
        exitMultiSelect();
        showToast('已逐条转发 ' + n + ' 条消息');
    }

    // 合并信封解析：仅识别 {"merged":{c,i:[...]}} 结构，普通 JSON 文本不受影响
    function parseMergedEnvelope(content) {
        if (!content || content.charAt(0) !== '{') return null;
        var o = null;
        try { o = JSON.parse(content); } catch (e) { return null; }
        if (o && o.merged && typeof o.merged === 'object' && Object.prototype.toString.call(o.merged.i) === '[object Array]') {
            return o.merged;
        }
        return null;
    }

    // 合并转发详情弹窗：按信封逐条渲染（文本/图片/文件），显示名按备注→昵称→账号归口解析
    function openMergedDetail(key) {
        var env = mergedCache[key];
        var mask = document.getElementById('merged-mask');
        var parties = document.getElementById('merged-parties');
        var detail = document.getElementById('merged-detail');
        if (!env) { showToast('详情已过期，请重新打开会话'); return; }
        // 阶段八十八：原生滚动条全局隐藏（style.css ::-webkit-scrollbar 归零 + scrollbar-width:none），
        // 详情列表须挂自绘悬浮滑块否则滚动时无任何滚动条指示；initOsb 幂等（el._osb 防重复）
        if (window._osbInit) window._osbInit(detail);
        var names = [];
        (env.i || []).forEach(function (it) {
            var dn = senderDisplayName(it.f);
            if (dn && names.indexOf(dn) < 0) names.push(dn);
        });
        parties.textContent = names.join('、') + '：' + (env.c || (env.i || []).length) + '条消息';
        detail.innerHTML = '';
        var items = env.i || [];
        if (!items.length) {
            detail.innerHTML = '<div class="md-empty">暂无内容</div>';
        }
        items.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'md-row';
            var url = getAvatarUrl(it.f);
            var av;
            if (url) {
                av = document.createElement('img');
                av.className = 'md-avatar';
                av.src = url;
            } else {
                av = document.createElement('span');
                av.className = 'md-avatar-ph';
                av.textContent = (senderDisplayName(it.f) || '?').charAt(0).toUpperCase();
            }
            row.appendChild(av);
            var main = document.createElement('div');
            main.className = 'md-main';
            var head = document.createElement('div');
            head.className = 'md-head';
            var nm = document.createElement('span');
            nm.className = 'md-name';
            nm.textContent = senderDisplayName(it.f);
            var tm = document.createElement('span');
            tm.className = 'md-time';
            tm.textContent = it.t ? fmtMdTime(it.t) : '';
            head.appendChild(nm);
            head.appendChild(tm);
            main.appendChild(head);
            if (it.k === 'image' && it.u) {
                var im = document.createElement('img');
                im.className = 'md-img';
                im.src = it.u;
                // 阶段八十七：点击查看大图——查看列表限定在该条合并记录内的图片（微信详情内翻页语义）
                im.style.cursor = 'pointer';
                im.addEventListener('click', function () {
                    var imgs = [];
                    items.forEach(function (x) {
                        if (x.k === 'image' && x.u && imgs.indexOf(x.u) < 0) imgs.push(x.u);
                    });
                    openImageViewer(it.u, imgs);
                });
                main.appendChild(im);
            } else if (it.k === 'file' && it.u) {
                var fc = document.createElement('div');
                fc.className = 'md-file';
                fc.title = '点击下载';
                var fn = document.createElement('span');
                fn.className = 'md-file-name';
                fn.textContent = it.n || '文件';
                var fs = document.createElement('span');
                fs.className = 'md-file-size';
                fs.textContent = it.s || '';
                fc.appendChild(fn);
                fc.appendChild(fs);
                fc.addEventListener('click', function () { window.open(it.u, '_blank'); });
                main.appendChild(fc);
            } else {
                var tx = document.createElement('div');
                tx.className = 'md-text';
                tx.textContent = it.x || '';
                main.appendChild(tx);
            }
            row.appendChild(main);
            detail.appendChild(row);
        });
        mask.classList.remove('hidden');
    }

    // 详情时间格式化：当天 HH:mm，跨天 MM-DD HH:mm
    function fmtMdTime(ts) {
        var d = new Date(ts * 1000);
        var now = new Date();
        var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
        return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + hm;
    }

    (function bindMergedModal() {
        var mask = document.getElementById('merged-mask');
        document.getElementById('merged-close').addEventListener('click', function () {
            mask.classList.add('hidden');
        });
        mask.addEventListener('click', function (e) {
            if (e.target === mask) mask.classList.add('hidden');
        });
    })();

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
        // 阶段七十三：停止态优先（Trae 同款）——AI 问答生成中/任务执行中时，发送按钮与 Enter 均为"停止"：
        // 任务模式下取消进行中任务（复用 AGENT_RUN cancel 既有机制），否则停止进行中的流式问答（AI_STOP）
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            var stopTaskId = agentMode ? agentActiveTask[currentChatUser] : null;
            if (stopTaskId) {
                IMSocket.send({ msg_type: MSG.AGENT_RUN, content: JSON.stringify({ task_id: stopTaskId, action: 'cancel' }) });
                return;
            }
            if (aiAgentGenerating(currentChatUser)) {
                IMSocket.send({ msg_type: MSG.AI_STOP, to_user: currentChatUser });
                return;
            }
        }
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
            // 阶段七十一：本端当前查看会话 id（发问/任务按它归口盖戳，任意历史会话均可续聊）
            var sid = aiViewSession[currentChatUser] || 0;
            // 阶段五十九：Agent 任务模式——发送内容作为自动化任务目标（服务端建任务闭环，事件流实时回推）
            if (agentMode) {
                clearQuoteTarget(); // 任务目标不参与引用（引用信封 JSON 会破坏 AGENT_RUN 协议格式）
                msg = { msg_type: MSG.AGENT_RUN, to_user: currentChatUser, content: JSON.stringify({ goal: content, agent_name: currentChatUser, session_id: sid }) };
                if (IMSocket.send(msg)) {
                    messageInput.value = '';
                    messageInput.focus();
                    // 阶段七十：任务目标改由服务端落库回显（真实 msg_id，切会话/重登历史不丢，与 AI 问答同口径）；
                    // 标记待达回显，PRIVATE 处理器据此抑制"思考中"指示（任务模式无 AI 问答指示）
                    agentEchoPending[currentChatUser] = true;
                }
                return;
            }
            // 阶段七十一：流式回复按会话归属渲染（服务端落库同源，AI_STREAM/END 帧携带同 sid 过滤）
            msg = { msg_type: MSG.AI_CHAT, to_user: currentChatUser, content: content, session_id: sid };
            // 阶段六十九：联网搜索开关开启时经 remark 上行（服务端归口校验配置，未开启时降级普通问答）
            if (webSearchOn && webSearchAvailable) msg.remark = 'web_search';
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
    // 阶段八十六：toUserOverride/suppressLocal 供消息转发复用——指定目标会话（默认仍取当前会话）、
    // 抑制本地气泡（FILE_PERSISTED 对 nonce 无匹配气泡时静默跳过，已确认容错）；
    // 返回上传 fetch 的 Promise（普通发送不关心返回值，转发据此 toast 成败）
    function sendFileDirect(file, toUserOverride, suppressLocal) {
        var toUser = toUserOverride || currentChatUser;
        var nonce = Date.now() + '_' + Math.random().toString(36).slice(2);
        if (!suppressLocal) {
            var url = URL.createObjectURL(file);
            if (isImageName(file.name)) {
                var b1 = appendImageMsg(IMSocket.getUsername(), url, 'self', true);
                b1.setAttribute('data-nonce', nonce);
            } else {
                var b2 = appendFileMsg(IMSocket.getUsername(), file.name, formatSize(file.size), url, 'self', true);
                b2.setAttribute('data-nonce', nonce);
            }
        }
        var fd = new FormData();
        fd.append('file', file);
        return fetch('/upload/file?username=' + encodeURIComponent(IMSocket.getUsername()) +
              '&to_user=' + encodeURIComponent(toUser) +
              '&nonce=' + encodeURIComponent(nonce), {
            method: 'POST',
            body: fd
        }).then(function (res) {
            // 异常加固：HTTP 4xx/5xx（文件过大/未在线/被拉黑等）统一告警，本地 blob 预览保留
            if (!res.ok) console.warn('大文件直传被拒绝:', res.status);
            return res; // 阶段八十六：转发链路据此判定成败
        }).catch(function (e) {
            // 上传失败仅告警：本地 blob 预览保留，刷新后该消息消失（未落库）属预期降级；不自动重试（服务端无幂等锚点）
            console.warn('大文件直传失败:', e);
            throw e; // 阶段八十六：转发链路据此提示失败
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
        // 阶段八十五：发送者展示名（备注→昵称→账号）
        nameEl.textContent = senderDisplayName(fromUser);
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
    // suppressLocal：转发场景（阶段八十六）抑制本地回显气泡——目标会话非当前窗口，本地渲染会污染当前视图；
    // 服务端广播回来后由 GROUP_IMAGE 处理器按 currentChatUser 归口渲染（目标群聊打开时正常上屏，未打开仅记未读）
    function sendGroupImage(file, suppressLocal) {
        if (!isImageName(file.name)) { showToast('群聊仅支持发送图片'); return; }
        // nonce：本地气泡唯一标识，广播回填 msg_id 时精确匹配（对齐 FILE_PERSISTED 按 file_id 匹配的归口思路，并发发送不错位）
        var nonce = Date.now() + '_' + Math.random().toString(36).slice(2);
        if (!suppressLocal) {
            var url = URL.createObjectURL(file);
            var bubble = appendImageMsg(IMSocket.getUsername(), url, 'self', false); // 群聊图片：显示发送者昵称
            bubble.setAttribute('data-nonce', nonce);
        }
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
            if (!IMSocket.send({ msg_type: MSG.AI_CHAT, to_user: agent, content: envelope, session_id: aiViewSession[agent] || 0 })) {
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
            if (!IMSocket.send({ msg_type: MSG.AI_CHAT, to_user: agent, content: envelope, session_id: aiViewSession[agent] || 0 })) {
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
        // 阶段八十五：先合并服务端下发的发送者昵称，再渲染（群聊图片标签与文字标签同规则）
        if (msg.from_name) nickCache[msg.from_user] = msg.from_name;
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
        var isGroup = currentChatUser === '';
        var isAI = !isGroup && isAIAgent(currentChatUser);
        // 阶段七十二：清空聊天双选项——清空显示（服务端写删除表，本端不再加载，云端保留）/ 永久删除（物理删除云端记录，不可恢复）。
        // 原实现仅清本地视图不写删除表，刷新或重开会话后历史原样回来，清空形同虚设
        // 永久删除仅私聊与 AI 会话提供（群聊消息影响全员，仅提供清空显示）；AI 会话永久删除范围为当前查看会话
        showChoice('清空聊天',
            '仅清空本端显示，云端记录保留且不再加载；私聊永久删除需对方同意后执行，AI 会话可直接删除当前会话。',
            '云端保留',
            function () {
                IMSocket.send({ msg_type: MSG.CONV_CLEAR, to_user: currentChatUser });
                messageList.innerHTML = '';
                appendSystem('聊天显示已清空（云端记录保留）');
            },
            isGroup ? null : {
                text: isAI ? '永久删除' : '申请删除双方记录',
                cb: function () {
                    if (isAI) {
                        // AI 会话：自己的数据自己删，无需审批
                        IMSocket.send({
                            msg_type: MSG.CONV_CLEAR,
                            to_user: currentChatUser,
                            clear: true,
                            session_id: aiViewSession[currentChatUser] || 0
                        });
                        messageList.innerHTML = '';
                        // 服务端已物理删除，重拉得到空态（分页游标归位）
                        historyPage = 1;
                        historyHasMore = true;
                        loadingMore = false;
                        loadHistory();
                        appendSystem('当前会话已从云端永久删除');
                    } else {
                        // 私聊走双方审批流：服务端落申请单并推审批卡片，对方同意才物理删除申请前的记录
                        IMSocket.send({ msg_type: MSG.PURGE_APPLY, to_user: currentChatUser });
                    }
                }
            });
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
            // 先按账号显示（侧栏顶部+PC 标题栏），登录响应解析出昵称后由 syncMyDisplayName() 纠正为"昵称优先"
            syncMyDisplayName();
            titlebarUserEl.classList.remove('hidden');
            // 阶段一百零五：登录成功显示标题栏设置齿轮（与用户区同生死；点击打开全屏设置页）
            var settingsEntry = document.getElementById('titlebar-settings');
            if (settingsEntry) settingsEntry.style.display = '';
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
                    // 有昵称时展示名从账号纠正为昵称（无昵称 syncMyDisplayName 内部降级仍显账号）
                    syncMyDisplayName();
                }
                // 阶段三十一：同步服务端下发的分片大小（服务端归口，覆盖前端兜底默认值）
                // 原实现：CHUNK_SIZE 恒为前端硬编码 4KB，与服务端 chunk_size 配置脱节
                if (loginInfo && loginInfo.chunk_size > 0) {
                    CHUNK_SIZE = loginInfo.chunk_size;
                }
                // 阶段七十八：登录响应携带 AI 积分余额（服务端归口），标题栏 ⚡ 积分显示
                if (loginInfo && typeof loginInfo.points === 'number') {
                    setPointsBalance(loginInfo.points);
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
            // 阶段九十：登录后拉起本机 MCP 会话并上报工具清单（首查触发主进程自动建连，
            // 建连异步完成，轮询窗口内每次工具清单变化即重报，服务端全量覆盖语义）
            if (agentMcpSupported()) startPcMcpReportLoop(12);
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
        var nextOnline = {}; // 阶段八十六：快照整体重建（上下线都伴随全量推送），确保掉线用户被移除
        infos.forEach(function (u) {
            if (u && u.username) {
                userAvatars[u.username] = u.avatar || '';
                nextOnline[u.username] = true;
            }
            // 自己头像以 LOGIN_RESP/上传结果为最高优先级，USER_LIST 仅在缺失时兜底
            if (u.username === IMSocket.getUsername()) {
                if (!myAvatar && u.avatar) {
                    myAvatar = u.avatar;
                    setNavAvatar(myAvatar);
                }
            }
        });
        onlineUsers = nextOnline;
        // 在线快照变化后刷新当前会话标题状态（覆盖非好友会话：好友会话另有 USER_STATUS 联动）
        updateChatTitle();
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
    var agentEchoPending = {}; // 阶段七十：AGENT_RUN 回显待达标记（PRIVATE 处理器据此抑制"思考中"，任务模式无 AI 问答指示）：agent -> true
    var agentActiveTask = {}; // 阶段七十三：各智能体进行中的任务（agent -> 最近 task_id），发送按钮"停止"态数据源

    function isAIAgent(name) {
        return aiAgents.some(function (a) { return a.name === name; });
    }

    // 阶段七十三：当前会话是否有进行中的 AI 问答（"思考中"或流式打字中）
    function aiAgentGenerating(agent) {
        if (aiThinking[agent]) return true;
        for (var sid in aiStreams) {
            var st = aiStreams[sid];
            if (st.agent === agent && !st.done) return true;
        }
        return false;
    }

    // 阶段七十三：发送按钮"停止"态归口（Trae CN 同款）——当前会话为 AI 智能体且有进行中的
    // 问答或（任务模式下的）执行中任务时，按钮由"发送"切换为"停止"，点击中断生成/取消任务。
    // 问答停止走 AI_STOP（服务端中断模型流式调用），任务停止复用 AGENT_RUN cancel（既有机制）
    function updateSendBtnState() {
        var stopping = currentChatUser !== '' && isAIAgent(currentChatUser) &&
            ((agentMode && agentActiveTask[currentChatUser]) || aiAgentGenerating(currentChatUser));
        if (stopping) {
            sendBtn.classList.add('stopping');
            sendBtn.innerHTML = '<span class="stop-icon"></span>停止';
        } else {
            sendBtn.classList.remove('stopping');
            sendBtn.textContent = '发送';
        }
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
        // 阶段六十九：服务端联网搜索能力标志（随列表全局归口下发，前端据此显隐联网开关按钮）
        webSearchAvailable = aiAgents.length > 0 && !!aiAgents[0].web_search;
        if (!webSearchAvailable) webSearchOn = false;
        webSearchBtn.classList.toggle('active', webSearchOn);
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
        updateSendBtnState(); // 阶段七十三：提问已受理即进入"停止"态（思考阶段同样可停止）
    }

    function hideAIThinking(agent) {
        var t = aiThinking[agent];
        if (t) {
            t.el.remove();
            delete aiThinking[agent];
            updateSendBtnState();
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

    // ===== 阶段八十八：消息右键复制归口 =====
    // 按气泡类型分发：图片→canvas 转 PNG 写剪贴板；文件→复制文件名；其余→复制可见文本（含引用块）
    function copyMsgContent(el) {
        var bubble = el.querySelector('.message-bubble');
        if (!bubble) { showToast('该消息不支持复制'); return; }
        var img = bubble.querySelector('.chat-image');
        if (img && img.getAttribute('src')) { copyImageToClipboard(img.getAttribute('src')); return; }
        if (bubble.classList.contains('bubble-file')) {
            var fnEl = bubble.querySelector('.file-name');
            copyTextToClipboard((fnEl && fnEl.textContent) || '文件');
            return;
        }
        var text = (bubble.innerText || bubble.textContent || '').trim();
        if (!text) { showToast('该消息不支持复制'); return; }
        copyTextToClipboard(text);
    }

    // 图片复制：图片同源加载无跨域污染，canvas 转 PNG 写入剪贴板；
    // Clipboard API 不可用（HTTP 非安全上下文）或写入失败时降级复制图片链接
    function copyImageToClipboard(url) {
        var img = new Image();
        img.onload = function () {
            try {
                var cv = document.createElement('canvas');
                cv.width = img.naturalWidth;
                cv.height = img.naturalHeight;
                cv.getContext('2d').drawImage(img, 0, 0);
                cv.toBlob(function (blob) {
                    if (!blob || !navigator.clipboard || !window.ClipboardItem) { copyTextToClipboard(url); return; }
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
                        .then(function () { showToast('图片已复制'); })
                        .catch(function () { copyTextToClipboard(url); });
                }, 'image/png');
            } catch (e) { copyTextToClipboard(url); }
        };
        img.onerror = function () { showToast('图片加载失败，无法复制'); };
        img.src = url;
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
        // 重新生成：原样重发最近一次提问（含引用信封原文，服务端解析口径与首次发送一致；
        // 阶段六十九：按当前联网开关状态随行 remark，与服务端配置双重归口）
        addBtn('重新生成', ICONS.redo, function () {
            var q = lastAIQuestion[agent];
            if (!q || !q.raw) { showToast('暂无原始提问，无法重新生成'); return; }
            var regen = { msg_type: MSG.AI_CHAT, to_user: agent, content: q.raw, session_id: aiViewSession[agent] || 0 };
            if (webSearchOn && webSearchAvailable) regen.remark = 'web_search';
            IMSocket.send(regen);
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
        div.className = 'message other ai'; // ai 标记：AI 回复行放宽 max-width（宽表格/代码按需扩大展示范围）
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
        // 注意：此处不调用 updateSendBtnState——调用方在返回后才把流注册进 aiStreams，
        // 注册前"生成中"判定查不到本流会误判为空闲（实测：思考中是停止、流式输出却回到发送）
        return { el: div, textEl: text, cursorEl: cursor, pending: '', shown: '', timer: null, done: false, finalId: 0, agent: agent, stopped: false };
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
        initAIMdHScroll(st.textEl); // 收尾后 DOM 稳定，宽表格/代码块挂横向自绘滑块
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
        // 阶段七十三：用户停止生成的留痕标注（部分回复正常保留，操作栏照常渲染）
        if (st.stopped && bodyEl && !bodyEl.querySelector('.ai-stopped-note')) {
            var note = document.createElement('span');
            note.className = 'ai-stopped-note';
            note.textContent = '已停止生成';
            bodyEl.appendChild(note);
        }
        if (st.finalId) sendReadReceipt(agent, st.finalId);
        if (!st.shown) st.el.remove(); // 空回复（服务端异常）：移除空气泡
        updateSendBtnState(); // 阶段七十三：问答收尾后复位发送按钮
    }

    // AI 流式增量：仅当前正查看该智能体会话时实时渲染（未查看时忽略，完整回复落库后经历史/会话摘要可见）
    IMSocket.on(MSG.AI_STREAM, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return; // 只处理自己的流
        if (currentChatUser !== msg.from_user) return;
        // 阶段七十一：流帧携带会话归属（服务端落库同源），与本端查看会话不符（他端在其他会话发起/
        // 本端已切走）则不渲染（回复落库按会话归位，切回该会话经历史可见；旧服务端无 sid 字段=0 兼容）
        if ((msg.session_id || 0) !== (aiViewSession[msg.from_user] || 0)) return;
        // 阶段八十四：历史压缩提示帧（remark=compress）——TRAE 同款"历史对话压缩中"，
        // 较早历史被服务端 LLM 摘要归并时的实时状态行，与联网搜索行同款交互（不进正文不落库）
        if (msg.remark === 'compress') {
            hideAIThinking(msg.from_user);
            removeAISuggestRow();
            var stc = aiStreams[msg.stream_id];
            if (!stc) {
                stc = createStreamBubble(msg.from_user, msg.stream_id);
                aiStreams[msg.stream_id] = stc;
                updateSendBtnState(); // 流式输出即将开始，保持"停止"态一致
            }
            insertAICompressRow(stc);
            return;
        }
        // 阶段六十九：工具状态帧（remark=tool，content 为 JSON）——普通聊天联网搜索过程行，
        // 渲染在回复气泡正文上方，不进打字机正文
        if (msg.remark === 'tool') {
            var meta = null;
            try { meta = JSON.parse(msg.content); } catch (e) { return; }
            if (!meta || meta.tool !== 'web_search') return;
            hideAIThinking(msg.from_user); // 搜索行为先于正文出现，同样收起"思考中"指示
            removeAISuggestRow();
            var st0 = aiStreams[msg.stream_id];
            if (!st0) {
                st0 = createStreamBubble(msg.from_user, msg.stream_id);
                aiStreams[msg.stream_id] = st0;
                updateSendBtnState(); // 阶段七十三：注册后再刷新（流式输出中保持"停止"态）
            }
            insertAISearchRow(st0, meta);
            return;
        }
        hideAIThinking(msg.from_user); // 首段回复到达，移除"思考中"指示
        removeAISuggestRow(); // 新一轮回复开始，移除上一轮的后续提问建议
        var st = aiStreams[msg.stream_id];
        if (!st) {
            st = createStreamBubble(msg.from_user, msg.stream_id);
            aiStreams[msg.stream_id] = st;
            updateSendBtnState(); // 阶段七十三：注册后再刷新（流式输出中保持"停止"态）
        }
        st.pending += msg.content || '';
        ensureStreamTimer(st);
    });

    // 阶段六十九：在流式气泡正文上方插入「联网搜索」状态行（结果条数/失败态跟随，主题色变量渲染）
    function insertAISearchRow(st, meta) {
        var bubble = st.textEl.parentElement;
        if (!bubble) return;
        var row = document.createElement('div');
        row.className = 'ai-search-row' + (meta.ok ? '' : ' ai-search-fail');
        row.setAttribute('data-round', st.searchRound = (st.searchRound || 0) + 1);
        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '14');
        icon.setAttribute('height', '14');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z');
        icon.appendChild(path);
        var label = document.createElement('span');
        label.className = 'ai-search-label';
        if (meta.ok) {
            label.textContent = '联网搜索：' + (meta.query || '') + '（' + (meta.results || 0) + ' 条结果）';
        } else {
            label.textContent = '联网搜索：' + (meta.query || '') + '（失败，已基于已有知识作答）';
        }
        row.appendChild(icon);
        row.appendChild(label);
        bubble.insertBefore(row, st.textEl); // 正文上方，随打字机输出保持在搜索行之下
        messageList.scrollTop = messageList.scrollHeight;
    }

    // 阶段八十四：在流式气泡正文上方插入「历史对话压缩中」状态行（TRAE 同款；复用联网搜索行
    // 的主题样式类，跟随主题色变化；每次回复至多一条，压缩完成后保留作过程留痕，不落库）
    function insertAICompressRow(st) {
        var bubble = st.textEl.parentElement;
        if (!bubble || st.compressRow) return; // 已插入过则跳过（一次回复仅压缩一次）
        var row = document.createElement('div');
        row.className = 'ai-search-row';
        st.compressRow = row;
        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '14');
        icon.setAttribute('height', '14');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute('d', 'M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8A5.87 5.87 0 0 1 6 12c0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z');
        icon.appendChild(path);
        var label = document.createElement('span');
        label.className = 'ai-search-label';
        label.textContent = '历史对话压缩中…（较早记录正在归并为摘要以提升响应速度）';
        row.appendChild(icon);
        row.appendChild(label);
        bubble.insertBefore(row, st.textEl); // 正文上方，压缩完成后保留为过程留痕
        messageList.scrollTop = messageList.scrollHeight;
    }

    // AI 流式结束：有流则收尾（END.content 为完整回复，仅在未曾收到增量时降级整段打字防重复）；
    // 无流（如降级路径）且正在查看该会话时补一条完整回复
    IMSocket.on(MSG.AI_STREAM_END, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        hideAIThinking(msg.from_user); // 失败/降级路径同样收起"思考中"指示
        // 阶段七十八：结束帧携带扣分后积分余额（服务端归口，仅成功扣分帧有值）→ 标题栏实时刷新
        if (msg.points_balance != null) setPointsBalance(msg.points_balance);
        // 阶段七十一：结束帧同口径按会话归属过滤（与本端查看会话不符不渲染，回复已落库切回经历史可见）
        if ((msg.session_id || 0) !== (aiViewSession[msg.from_user] || 0)) return;
        var st = aiStreams[msg.stream_id];
        if (st) {
            if (!st.shown && !st.pending.length && msg.content) st.pending = msg.content;
            st.done = true;
            st.finalId = msg.msg_id || 0;
            if (msg.remark === 'stopped') st.stopped = true; // 阶段七十三：用户停止，收尾时留痕
            // Token 消耗随结束帧下发（服务端 usage 归口），收尾时渲染到操作栏
            st.tokens = { total: msg.total_tokens || 0, prompt: msg.prompt_tokens || 0, completion: msg.completion_tokens || 0 };
            ensureStreamTimer(st);
            return;
        }
        if (msg.remark === 'error') return; // 失败且无气泡：服务端已 toast 提示
        // 阶段七十三：停止且无已生成内容（"思考中"阶段停止，无气泡无落库）：无帧可补
        if (msg.remark === 'stopped' && !msg.content && !msg.msg_id) return;
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
                sendMessage(); // 复用既有提问链路（Agent 模式开启走 AGENT_RUN 新任务，关闭走 AI_CHAT 普通问答）
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
    // 阶段七十八：各 AI 会话的 Agent 开关记忆——切换好友再切回自动恢复原开关，不用重新打开；
    // localStorage 按账号持久化，刷新页面后同样恢复
    var agentModeByUser = (function () {
        try { return JSON.parse(localStorage.getItem('im_agent_mode_' + (IMSocket.getUsername() || '')) || '{}') || {}; }
        catch (e) { return {}; }
    })();
    function agentModeMemSave() {
        try { localStorage.setItem('im_agent_mode_' + (IMSocket.getUsername() || ''), JSON.stringify(agentModeByUser)); } catch (e) {}
    }
    var agentConsoleOpenByUser = {}; // 各 AI 会话的控制台开合记忆（内存级：日志本身按会话复位，仅恢复显示状态）

    // ===== 阶段六十九：普通聊天联网搜索开关（仅 AI 智能体会话且服务端开启 web_search 时可用） =====
    var webSearchOn = false;        // 当前联网搜索开关状态（跨会话保持用户选择）
    var webSearchAvailable = false; // 服务端联网搜索能力标志（AI_AGENTS 列表下发，配置归口）

    webSearchBtn.addEventListener('click', function () {
        if (!currentChatUser || !isAIAgent(currentChatUser) || !webSearchAvailable) return;
        webSearchOn = !webSearchOn;
        webSearchBtn.classList.toggle('active', webSearchOn);
        showToast(webSearchOn ? '已开启联网搜索，AI 问答可实时查询最新信息' : '已关闭联网搜索');
    });

    function setAgentMode(on) {
        agentMode = on;
        agentModeBtn.classList.toggle('active', on);
        messageInput.placeholder = on ? '描述任务目标，Agent 将规划步骤并调用工具自动执行' : '输入消息';
        updateSendBtnState(); // 阶段七十三：模式切换联动发送按钮停止态（任务执行中开/关任务模式）
        // 阶段七十六：Agent 模式联动工作区文件面板（开启显示右侧文件树，关闭隐藏只留聊天）
        wsPanelSetVisible(on && !!currentChatUser && isAIAgent(currentChatUser));
    }

    agentModeBtn.addEventListener('click', function () {
        if (!currentChatUser || !isAIAgent(currentChatUser)) return;
        setAgentMode(!agentMode);
        agentModeByUser[currentChatUser] = agentMode; // 开关记忆落盘：切会话/刷新后恢复
        agentModeMemSave();
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

    // ===== 阶段九十：我的 MCP 服务器（仅 PC 端；TRAE 同款本机 stdio，工具清单上报服务端注入 Agent） =====
    // 配置与凭据存 PC 主进程 agent_mcp.json（按用户名隔离）；面板仅增删改/测试/展示状态，
    // 工具清单上报归口 reportPcMcpTools（登录/保存后轮询窗口内清单变化即重报，服务端全量覆盖）
    // 阶段一百零五：原弹窗壳 agent-mcp-mask 已废弃（DOM 注释归档于 index.html），面板迁入设置页 settings-view-mcp；
    // 列表/表单全部 DOM id 平移复用，本区逻辑仅"打开/关闭"两处适配设置页模式
    var agentMcpPanel = document.getElementById('settings-view-mcp');
    var agentMcpListEl = document.getElementById('agent-mcp-list');
    var agentMcpEditEl = document.getElementById('agent-mcp-edit');
    var agentMcpServers = [];     // 编辑态：本机服务器配置（与主进程存储同构）
    var agentMcpEditing = -1;     // 当前编辑行索引（-1=新增）
    var agentMcpLiveStatus = [];  // 会话状态快照：[{name,status,status_msg,tool_count}]
    var agentMcpLastReport = '';  // 上次上报工具清单指纹（去重，避免重复上报）
    var agentMcpStatusTimer = null; // 面板打开期间的状态轮询

    // 是否支持本机 MCP 配置（仅 PC 端 preload 暴露 mcpGet；Web 端无本机进程概念）
    function agentMcpSupported() {
        return !!(window.desktop && typeof window.desktop.mcpGet === 'function');
    }

    // 工具清单上报归口：主进程快照变化才上报（服务端 sync.Map 全量覆盖，空清单=清除注入）
    function reportPcMcpTools() {
        if (!agentMcpSupported()) return;
        window.desktop.mcpSyncState(IMSocket.getUsername()).then(function (st) {
            var fingerprint = JSON.stringify((st && st.tools) || []);
            if (fingerprint === agentMcpLastReport) return;
            agentMcpLastReport = fingerprint;
            IMSocket.send({
                msg_type: MSG.AGENT_PC_TOOLS,
                content: JSON.stringify({ tools: (st && st.tools) || [] })
            });
        }).catch(function () { /* 主进程异常时静默，下轮重试 */ });
    }

    // 建连/保存后的上报窗口：会话建连异步，窗口期内每秒快照一次，清单稳定即自动停报
    function startPcMcpReportLoop(times) {
        var n = 0;
        (function tick() {
            if (n++ >= times) return;
            reportPcMcpTools();
            setTimeout(tick, 1000);
        })();
    }

    // 面板打开期间轮询会话状态（连接中/已连接/错误实时可见），关闭即停
    function startMcpStatusPoll() {
        stopMcpStatusPoll();
        agentMcpStatusTimer = setInterval(function () {
            window.desktop.mcpSyncState(IMSocket.getUsername()).then(function (st) {
                agentMcpLiveStatus = (st && st.status) || [];
                renderAgentMcpList();
            }).catch(function () {});
        }, 1200);
    }
    function stopMcpStatusPoll() {
        if (agentMcpStatusTimer) { clearInterval(agentMcpStatusTimer); agentMcpStatusTimer = null; }
    }

    function mcpStatusText(s) {
        return { connected: '已连接', connecting: '连接中', error: '错误', disabled: '已停用' }[s] || s || '未连接';
    }

    function renderAgentMcpList() {
        // 阶段一百零五：签名比对防闪烁——面板打开期间 1.2 秒轮询会话状态，每次回调都调本函数，
        // 状态无变化时跳过重建（原实现每次清空重建，MCP 面板开着列表就持续闪烁且悬停态丢失）
        var sig = JSON.stringify([agentMcpServers, agentMcpLiveStatus]);
        if (sig === renderAgentMcpList._sig) return;
        renderAgentMcpList._sig = sig;
        agentMcpListEl.innerHTML = '';
        if (!agentMcpServers.length) {
            var empty = document.createElement('div');
            empty.className = 'agent-mcp-empty';
            empty.textContent = '尚未配置本机 MCP 服务器';
            agentMcpListEl.appendChild(empty);
            return;
        }
        agentMcpServers.forEach(function (sv, i) {
            var row = document.createElement('div');
            row.className = 'agent-mcp-server-row';
            var live = null;
            agentMcpLiveStatus.forEach(function (s) { if (s.name === sv.name) live = s; });
            var dot = document.createElement('span');
            dot.className = 'mcp-dot ' + (sv.enabled ? ((live && live.status) || 'connecting') : 'disabled');
            dot.title = mcpStatusText(sv.enabled ? ((live && live.status) || 'connecting') : 'disabled');
            var name = document.createElement('span');
            name.className = 'agent-mcp-server-name';
            name.textContent = sv.name;
            var meta = document.createElement('span');
            meta.className = 'agent-mcp-server-meta';
            if (!sv.enabled) {
                meta.textContent = '已停用';
            } else if (live && live.status === 'error' && live.status_msg) {
                meta.textContent = live.status_msg;
                meta.title = live.status_msg;
            } else {
                meta.textContent = '工具 ' + ((live && live.tool_count) || 0) + ' 个 · ' + mcpStatusText((live && live.status) || 'connecting');
            }
            var cmd = document.createElement('span');
            cmd.className = 'agent-mcp-server-cmd';
            cmd.textContent = sv.command + ' ' + (sv.args || []).join(' ');
            cmd.title = cmd.textContent;
            row.appendChild(dot);
            row.appendChild(name);
            row.appendChild(meta);
            row.appendChild(cmd);
            var edit = document.createElement('button');
            edit.className = 'agent-mcp-op';
            edit.textContent = '编辑';
            edit.addEventListener('click', function () { openMcpEdit(i); });
            var del = document.createElement('button');
            del.className = 'agent-mcp-op danger';
            del.textContent = '删除';
            del.addEventListener('click', function () {
                showConfirm('删除 MCP 服务器', '确定删除「' + sv.name + '」吗？本机进程将立即停止并回收。', function () {
                    window.desktop.mcpDel({ username: IMSocket.getUsername(), name: sv.name }).then(function (r) {
                        if (!r || !r.ok) { showToast((r && r.msg) || '删除失败'); return; }
                        agentMcpServers.splice(i, 1);
                        agentMcpLastReport = ''; // 允许重新上报（含工具减少后的清单）
                        startPcMcpReportLoop(8);
                        renderAgentMcpList();
                        showToast('已删除并停止本机进程');
                    });
                });
            });
            row.appendChild(edit);
            row.appendChild(del);
            agentMcpListEl.appendChild(row);
        });
    }

    function openMcpPanel() {
        if (!agentMcpSupported()) { showToast('仅 PC 客户端支持自定义 MCP 服务器'); return; }
        window.desktop.mcpGet(IMSocket.getUsername()).then(function (r) {
            agentMcpServers = (r && r.servers) || [];
            agentMcpLiveStatus = [];
            agentMcpEditEl.classList.add('hidden');
            renderAgentMcpList();
            // 阶段一百零五：原独立弹窗改为打开设置页并切到 MCP 分类（settingsOpen/settingsShowView
            // 为函数声明提升，同作用域可直接调用）；标题栏工具栏按钮与设置页导航双入口同归此处
            settingsOpen();
            settingsShowView('mcp');
            reportPcMcpTools(); // 打开面板先快照一次状态
            startMcpStatusPoll();
        });
    }

    function closeMcpPanel() {
        // 阶段一百零五：原 agentMcpMask 隐藏已废弃——面板显隐归设置页 settingsShowView 状态机；
        // 关闭设置页时由 settingsClose 统一调用本函数停止状态轮询
        stopMcpStatusPoll();
    }

    // 编辑区填充（idx=-1 新增）：args/env 转行文本
    function openMcpEdit(idx) {
        agentMcpEditing = idx;
        var sv = idx >= 0 ? agentMcpServers[idx] : { name: '', command: '', args: [], env: {}, enabled: true };
        document.getElementById('agent-mcp-name').value = sv.name;
        document.getElementById('agent-mcp-command').value = sv.command || '';
        document.getElementById('agent-mcp-args').value = (sv.args || []).join('\n');
        var envLines = [];
        Object.keys(sv.env || {}).forEach(function (k) { envLines.push(k + '=' + sv.env[k]); });
        document.getElementById('agent-mcp-env').value = envLines.join('\n');
        document.getElementById('agent-mcp-enabled').checked = sv.enabled !== false;
        document.getElementById('agent-mcp-test-out').textContent = '';
        agentMcpEditEl.classList.remove('hidden');
    }

    function collectMcpForm() {
        var env = {};
        String(document.getElementById('agent-mcp-env').value || '').split(/\r?\n/).forEach(function (line) {
            line = line.trim();
            if (!line) return;
            var j = line.indexOf('=');
            if (j <= 0) return;
            env[line.slice(0, j).trim()] = line.slice(j + 1).trim();
        });
        return {
            name: String(document.getElementById('agent-mcp-name').value || '').trim(),
            command: String(document.getElementById('agent-mcp-command').value || '').trim(),
            args: String(document.getElementById('agent-mcp-args').value || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s; }),
            env: env,
            enabled: document.getElementById('agent-mcp-enabled').checked
        };
    }

    // 持久化归口：保存 → 本机会话重建 → 清指纹重报工具清单
    function persistMcpServers() {
        window.desktop.mcpSave({ username: IMSocket.getUsername(), servers: agentMcpServers }).then(function (r) {
            if (!r || !r.ok) { showToast((r && r.msg) || '保存失败'); return; }
            agentMcpServers = r.servers || agentMcpServers;
            agentMcpLastReport = '';
            startPcMcpReportLoop(12); // 建连窗口内清单稳定后自动完成上报
            renderAgentMcpList();
            showToast('已保存，正在建连并上报工具清单');
        });
    }

    document.getElementById('agent-mcp-add').addEventListener('click', function () {
        if (agentMcpServers.length >= 10) { showToast('最多配置 10 个本机 MCP 服务器'); return; }
        openMcpEdit(-1);
    });
    document.getElementById('agent-mcp-edit-cancel').addEventListener('click', function () {
        agentMcpEditEl.classList.add('hidden');
    });
    document.getElementById('agent-mcp-edit-save').addEventListener('click', function () {
        var cfg = collectMcpForm();
        if (!cfg.name || !/^[0-9A-Za-z_\-\u4e00-\u9fa5]{1,64}$/.test(cfg.name)) { showToast('服务器名称需为 1-64 位中文/字母/数字/中划线/下划线'); return; }
        if (!cfg.command) { showToast('启动命令不能为空'); return; }
        for (var i = 0; i < agentMcpServers.length; i++) {
            if (i !== agentMcpEditing && agentMcpServers[i].name === cfg.name) { showToast('服务器名称已存在'); return; }
        }
        if (agentMcpEditing >= 0) agentMcpServers[agentMcpEditing] = cfg;
        else agentMcpServers.push(cfg);
        agentMcpEditEl.classList.add('hidden');
        persistMcpServers();
    });
    // 测试连接：临时会话验证（不常驻），展示服务信息/工具数/耗时
    document.getElementById('agent-mcp-test').addEventListener('click', function () {
        var out = document.getElementById('agent-mcp-test-out');
        var cfg = collectMcpForm();
        if (!cfg.name || !cfg.command) { out.textContent = '请先填写服务器名称与启动命令'; return; }
        out.textContent = '连接中…';
        window.desktop.mcpTest(cfg).then(function (r) {
            if (!r || !r.ok) { out.textContent = (r && r.msg) || '连接失败'; return; }
            out.textContent = '连接成功：' + (r.server_name || cfg.name) +
                (r.server_version ? ' v' + r.server_version : '') +
                '，' + ((r.tools || []).length) + ' 个工具，耗时 ' + (r.elapsed_ms || 0) + 'ms';
        }).catch(function (e) {
            out.textContent = '测试异常：' + (e && e.message || e);
        });
    });
    agentMcpBtn.addEventListener('click', openMcpPanel);
    // 阶段一百零五：原弹窗"关闭"按钮与遮罩点击关闭已随 agent-mcp-mask 废弃（DOM 注释归档），
    // 面板显隐归设置页状态机，关闭设置页时由 settingsClose 统一停轮询（见设置页区块）

    // ===== 阶段九十一：内置浏览区（TRAE CN 同款，仅 PC Electron 壳内启用） =====
    // 阶段九十三（全 DOM 化）：file 标签由主页面同源 iframe 承载，web 标签由主页面 <webview>
    // 承载（真 Chromium 内核但是 DOM 元素，与 iframe 同层级）——工具提示/弹窗遮罩/分隔线/控制台
    // 等页面 DOM 恢复最高层级，不再被原生 BrowserView 层遮挡。渲染层负责面板自绘与 iframe/webview
    // 元素建/删/显隐，状态归口主进程推送（browser:state 单向数据流）。
    // Web/手机端无 desktop 桥自动旁路：开关按钮保持 hidden，面板永不展开
    var browserBtn = document.getElementById('browser-btn');
    var browserPanelEl = document.getElementById('browser-panel');
    var browserTabsEl = document.getElementById('browser-tabs');
    var browserUrlEl = document.getElementById('browser-url');
    var browserContentEl = document.getElementById('browser-content');
    var browserBackBtn = document.getElementById('browser-back');
    var browserForwardBtn = document.getElementById('browser-forward');
    var browserReloadBtn = document.getElementById('browser-reload');
    var browserCrumbsEl = document.getElementById('browser-crumbs');
    var browserGoBtn = document.getElementById('browser-go');
    var browserLastState = null; // 最近一次主进程推送的浏览区状态（判断文件标签是否已开用）

    function browserSupported() {
        return !!(window.desktop && typeof window.desktop.browserPanel === 'function');
    }

    // 阶段九十二：PC 端锁定页面缩放——Ctrl+滚轮/Ctrl±0 缩放会改变主页面刻度，浏览区内
    // iframe/webview 与页面 UI 的视觉比例随之失衡（TRAE 同款固定缩放，保持 1:1 观感稳定）
    if (window.desktop) {
        window.addEventListener('wheel', function (e) {
            if (e.ctrlKey) e.preventDefault();
        }, { passive: false });
        window.addEventListener('keydown', function (e) {
            if (e.ctrlKey && !e.altKey && !e.shiftKey &&
                (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
                e.preventDefault();
            }
        });
    }

    // ===== 阶段九十二（DOM 化 viewer）：file 标签由主页面同源 iframe 承载。
    // 宿主职责：按 tab_id 建 iframe / 跟随活动态显隐 / 分发 file-load payload / 代 viewer 页转发保存与脏标记
    var fileFrames = {}; // tab_id → {frame, ready, pending}

    function fileFramePush(rec, payload) {
        try { rec.frame.contentWindow.__wsFileLoad(JSON.stringify(payload)); } catch (e) { /* 页面未就绪忽略 */ }
    }

    function fileFrameFor(tabId) {
        var rec = fileFrames[tabId];
        if (rec) return rec;
        var frame = document.createElement('iframe');
        frame.className = 'browser-file-frame hidden';
        // viewer 地址带版本参数防 iframe HTTP 缓存命中旧版（阶段一百零九：与 pc/main.js
        // setViewerUrl 的版本号保持一致，页面逻辑更新后两处同步改）
        frame.src = 'file-viewer.html?v=123'; // 与主页面同源（服务端同源静态页），可直调 contentWindow
        frame.addEventListener('load', function () {
            var r = fileFrames[tabId];
            if (!r) return;
            r.ready = true;
            if (r.pending) { fileFramePush(r, r.pending); r.pending = null; } // 早于 load 到达的 payload 补投
        });
        browserContentEl.appendChild(frame);
        return (fileFrames[tabId] = { frame: frame, ready: false, pending: null });
    }

    if (browserSupported() && typeof window.desktop.onFileLoad === 'function') {
        window.desktop.onFileLoad(function (data) {
            var tabId = String((data && data.tab_id) || '');
            var payload = data && data.payload;
            if (!tabId || !payload) return;
            var rec = fileFrameFor(tabId);
            if (rec.ready) fileFramePush(rec, payload);
            else rec.pending = payload;
        });
    }

    // viewer 页桥：iframe 内 file-viewer.html 无 preload（viewer-preload 仅原生视图时代使用），
    // 保存/脏标记经 parent.__imViewerHost 转发主进程（路径校验归口不变）
    window.__imViewerHost = {
        save: function (tabId, content) {
            return window.desktop.browserFileSave(tabId, content);
        },
        setDirty: function (tabId, dirty) {
            window.desktop.browserViewerDirty(tabId, dirty);
        },
        // 阶段一百：任务变更保留/撤销桥接（此前缺失导致 viewer 页按钮点击抛 TypeError 无反应）
        taskKeep: function (tabId) {
            return window.desktop.browserTaskKeep(tabId);
        },
        taskRevert: function (tabId) {
            return window.desktop.browserTaskRevert(tabId);
        },
        // 阶段一百一十：viewer 推送代码符号（TRAE CN 同款符号面包屑）——存于 frame 记录，
        // 若为当前活动 file 标签则立即刷新面包屑（符号段可点击，经 __fvReveal 跳转编辑器行）
        reportSymbols: function (tabId, symbols) {
            var rec = fileFrames[tabId];
            if (!rec) return;
            rec.symbols = Array.isArray(symbols) ? symbols : [];
            var st = browserLastState;
            if (st && st.kind === 'file' && String(st.active_id || '') === String(tabId)) {
                browserRenderCrumbs(st.url, st);
            }
        }
    };

    // ===== 阶段九十三（全 DOM 化）：web 标签由主页面 <webview> 承载 =====
    // 真 Chromium 内核但属页面 DOM（与 file iframe 同层级）：工具提示/弹窗遮罩/分隔线等
    // 页面 DOM 恒在其上，不再被原生层遮挡。宿主职责：按 tab_id 建 webview（src=首载地址）/
    // 跟随活动态显隐 / 标签关闭即移除（元素移除即销毁 guest）；dom-ready 上报宿主 webContents
    // id（主进程 fromId 挂事件+执行导航与 Agent 工具）。持久分区 persist:agent-browser 与
    // 主窗口会话隔离（登录态/Cookie 跨会话保留）；allowpopups 仅为主进程 setWindowOpenHandler
    // 能收到 window.open/target=_blank（deny 弹窗并转应用内新标签）
    var webFrames = {}; // tab_id → {el, reported}

    function webFrameFor(tabId, url) {
        var rec = webFrames[tabId];
        if (rec) return rec;
        var el = document.createElement('webview');
        el.className = 'browser-web-frame hidden';
        el.setAttribute('partition', 'persist:agent-browser');
        el.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes, nodeIntegration=no');
        el.setAttribute('allowpopups', '');
        el.addEventListener('dom-ready', function () {
            var r = webFrames[tabId];
            if (!r || r.reported) return;
            r.reported = true;
            try { window.desktop.browserWvReady(tabId, el.getWebContentsId()); } catch (e) { /* 桥异常忽略 */ }
        });
        // guest 进程崩溃重建后 webContents id 会变：允许下次 dom-ready 重新上报（主进程幂等重挂）
        function wvGone() { var r = webFrames[tabId]; if (r) r.reported = false; }
        el.addEventListener('render-process-gone', wvGone);
        el.addEventListener('crashed', wvGone);
        // src 先于插入 DOM 设置：插入即按首载地址加载（避免先 about:blank 再二次跳转）
        el.setAttribute('src', url || 'about:blank');
        browserContentEl.appendChild(el);
        return (webFrames[tabId] = { el: el, reported: false });
    }

    // 阶段九十二：分栏宽度同步——浏览区居中（贴主区左缘）、聊天列压缩到右侧（padding-left），
    // 消息/输入框保持可见可用；宽度持久化 localStorage（拖拽调整后跨会话保留）。
    // 基准宽度 = .main-chat 的 clientWidth（border-box 恒定总宽，与 padding 无关，实测确认）；
    // 同时写 --browser-w 供 conv-search 等通栏浮层避让浏览区
    var BROWSER_SPLIT_KEY = 'im_browser_split_w';
    var BROWSER_SPLIT_COLLAPSED_KEY = 'im_browser_split_chat_collapsed';
    var browserSplitLastPersisted = 0; // 上次已持久化的分栏宽度（去抖：宽度不变不重复写存储）
    var browserChatCollapsed = false;  // 聊天列是否已收起（浏览区占满全宽，右缘把手可拖回）
    var BROWSER_SPLIT_MIN_PANEL = 280;  // 浏览区最小宽
    var BROWSER_SPLIT_MIN_CHAT = 290;   // 聊天列最小保留宽（未收起时）
    var BROWSER_SPLIT_COLLAPSE_AT = 280; // 展开态向右压缩：聊天列窄于此值吸附收起（与恢复线拉开迟滞防抖）
    // 基准宽度：.main-chat 为 border-box，clientWidth 恒等于总宽（与 padding 无关，实测确认），
    // 浏览区宽 w，聊天列宽 = clientWidth - w（旧实现误减 padding 当总宽，导致拖拽宽度振荡）
    function browserClampSplitW(w, totalW) {
        var maxW = totalW - BROWSER_SPLIT_MIN_CHAT;
        if (w > maxW) w = maxW;
        if (w < BROWSER_SPLIT_MIN_PANEL) w = Math.min(BROWSER_SPLIT_MIN_PANEL, totalW);
        return Math.round(w);
    }
    function browserApplySplit(w, collapsed) {
        w = Math.round(w);
        var mc = browserPanelEl.parentElement;
        if (!mc) return;
        browserChatCollapsed = !!collapsed;
        browserPanelEl.style.width = w + 'px';
        mc.style.paddingLeft = w + 'px';
        mc.style.setProperty('--browser-w', w + 'px');
        mc.classList.toggle('browser-chat-collapsed', browserChatCollapsed);
        try {
            localStorage.setItem(BROWSER_SPLIT_COLLAPSED_KEY, browserChatCollapsed ? '1' : '0');
            // 收起时不覆盖宽度存储（保留上次展开宽度供拖回后继续用）；展开时去抖写存储
            if (!browserChatCollapsed && w !== browserSplitLastPersisted) {
                browserSplitLastPersisted = w;
                localStorage.setItem(BROWSER_SPLIT_KEY, String(w));
            }
        } catch (e) {}
    }
    function browserSyncSplit() {
        var mc = browserPanelEl.parentElement;
        if (!mc) return;
        if (browserPanelEl.classList.contains('hidden')) {
            mc.style.paddingLeft = '';
            mc.style.setProperty('--browser-w', '0px');
            mc.classList.remove('browser-chat-collapsed');
            return;
        }
        // 主区可用宽不能读 mc.clientWidth——收起态 padding-left 即面板宽，窗口缩小时旧 padding
        // 会把 main-chat 的 border box 撑到大于容器（padding 属于 border box，flex 压不掉），
        // clientWidth 被钉死在历史最大值，重算输入=输出永远卡死（实例：最大化后还原，浏览区
        // 仍为最大化宽度超出视口被裁）。改为：父容器宽减去流内兄弟实占宽，与自身 padding 无关。
        var host = mc.parentElement;
        var totalW = host ? host.clientWidth : mc.clientWidth;
        if (host) {
            for (var k = 0; k < host.children.length; k++) {
                var sib = host.children[k];
                if (sib === mc) continue;
                var sp = getComputedStyle(sib);
                if (sp.position === 'absolute' || sp.position === 'fixed') continue;
                totalW -= sib.offsetWidth;
            }
        }
        var collapsed = false;
        try { collapsed = localStorage.getItem(BROWSER_SPLIT_COLLAPSED_KEY) === '1'; } catch (e) {}
        var saved = parseInt(localStorage.getItem(BROWSER_SPLIT_KEY), 10);
        // 收起态直接占满全宽（不走钳制：钳制的聊天列保底与收起互斥）
        browserApplySplit(collapsed ? totalW : browserClampSplitW((saved > 0) ? saved : Math.round(totalW * 0.52), totalW), collapsed);
    }

    // 阶段九十三：窗口尺寸变化时重新钳制分栏宽——--browser-w 是拖拽时按当时窗口宽算出的固定像素
    // 并持久化，窗口缩窄后若不重算，浏览区面板会超出视口导致右侧内容看不到（实例：缩窗后文件
    // 标签页右缘被裁）。收起态重算后仍占满全宽，展开态按存档宽钳制进新窗口。
    // 双保险：window resize 之外再挂 ResizeObserver 直盯主区尺寸——系统原生 overlay 最大化/
    // 还原按钮在部分环境下不向页面派发 resize 事件（实测：最大化后浏览区仍为拖拽旧宽度超出
    // 视口），而主区尺寸变化必然来自 flex 重排，Observer 全覆盖；面板宽度/padding 均不改变
    // 主区 border box，不会自我循环触发。
    var browserSyncSplitTimer = null;
    function browserQueueSyncSplit() {
        if (browserPanelEl.classList.contains('hidden')) return;
        if (browserSyncSplitTimer) clearTimeout(browserSyncSplitTimer);
        browserSyncSplitTimer = setTimeout(browserSyncSplit, 80); // 轻防抖：连续变化只算最后一次，避免高频写存储
    }
    window.addEventListener('resize', browserQueueSyncSplit);
    if (window.ResizeObserver && browserPanelEl.parentElement) {
        new ResizeObserver(browserQueueSyncSplit).observe(browserPanelEl.parentElement);
    }

    // 分栏拖拽：按住浏览区右缘把手左右拖动调宽；聊天列压过收起阈值吸附为全宽，
    // 从全宽往回拖直接展开到最小保留宽（迟滞区间不重叠，无抖动）。
    // 拖拽期间 body 挂 browser-resizing 类，CSS 对 iframe/webview 施加 pointer-events:none
    // （guest 不再截获鼠标，渲染层全局收 mousemove）
    (function browserInitSplitter() {
        var sp = document.getElementById('browser-splitter');
        if (!sp || sp.dataset.splitBound) return;
        sp.dataset.splitBound = '1';
        var dragging = false, startX = 0, startW = 0;
        function endDrag() {
            if (!dragging) return;
            dragging = false;
            sp.classList.remove('dragging');
            document.body.classList.remove('browser-resizing');
        }
        sp.addEventListener('mousedown', function (e) {
            if (browserPanelEl.classList.contains('hidden')) return;
            dragging = true;
            startX = e.clientX;
            startW = browserPanelEl.offsetWidth;
            sp.classList.add('dragging');
            document.body.classList.add('browser-resizing');
            e.preventDefault();
        });
        window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var mc = browserPanelEl.parentElement;
            var totalW = mc.clientWidth;
            var target = startW + (e.clientX - startX);
            if (!browserChatCollapsed && totalW - target < BROWSER_SPLIT_COLLAPSE_AT) {
                browserApplySplit(totalW, true); // 展开态压过收起线 → 吸附收起
            } else if (browserChatCollapsed && target >= totalW - BROWSER_SPLIT_COLLAPSE_AT) {
                browserApplySplit(totalW, true); // 收起态未拖过恢复线 → 保持收起
            } else {
                if (browserChatCollapsed) target = Math.min(target, totalW - BROWSER_SPLIT_MIN_CHAT); // 拖回即展开到最小保留宽
                browserApplySplit(browserClampSplitW(target, totalW), false);
            }
            e.preventDefault();
        });
        window.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag); // 拖拽中窗口失焦（鼠标在窗外释放）兜底复位
    })();

    // 阶段九十三：聊天列收起态展开按钮（TRAE CN 收起条同款）——收起后右缘常显半胶囊，
    // 点击一次性恢复收起前的展开宽度（收起期间宽度存档不被覆盖，见 browserApplySplit），
    // 比拖把手显眼；无存档时回落默认 52%
    (function browserInitExpandBtn() {
        var btn = document.getElementById('browser-expand-btn');
        if (!btn || btn.dataset.expandBound) return;
        btn.dataset.expandBound = '1';
        btn.addEventListener('click', function () {
            var mc = browserPanelEl.parentElement;
            if (!mc || !browserChatCollapsed || browserPanelEl.classList.contains('hidden')) return;
            var totalW = mc.clientWidth;
            var saved = 0;
            try { saved = parseInt(localStorage.getItem(BROWSER_SPLIT_KEY), 10); } catch (e) {}
            browserApplySplit(browserClampSplitW((saved > 0) ? saved : Math.round(totalW * 0.52), totalW), false);
        });
    })();

    // ===== 阶段一百一十(2)：符号全量菜单（TRAE CN 同款折叠交互）=====
    // 自绘弹层挂在 body（面包屑 overflow-x:auto 会裁剪子元素）；项=符号图标+名称+行号，
    // 点击跳转编辑器对应行；外点/Esc/重复点"…"关闭。滚动条走全局自绘样式
    var bcSymMenuEl = null;
    var bcSymAnchor = null;
    function bcCloseSymMenu() {
        if (!bcSymMenuEl) return;
        var el = bcSymMenuEl;
        bcSymMenuEl = null;
        bcSymAnchor = null;
        // 自绘滚动条清理：滑块浮层移出 body，宿主登记表移除本容器（菜单每次开关都是新节点，不清理会累积死引用）
        var listEl = el.querySelector('.bc-sym-menu-list');
        if (listEl) {
            if (listEl._osbThumb) {
                listEl._osbThumb.remove();
                listEl._osbThumb = null;
            }
            if (window._osbHosts) {
                var ix = window._osbHosts.indexOf(listEl);
                if (ix >= 0) window._osbHosts.splice(ix, 1);
            }
        }
        el.remove();
        document.removeEventListener('mousedown', bcSymMenuOutside, true);
        document.removeEventListener('keydown', bcSymMenuEsc, true);
    }
    function bcSymMenuOutside(ev) {
        if (!bcSymMenuEl) return;
        if (bcSymAnchor && (ev.target === bcSymAnchor || bcSymAnchor.contains(ev.target))) return; // 点锚点交给 click 做开/关切换
        if (!bcSymMenuEl.contains(ev.target)) bcCloseSymMenu();
    }
    function bcSymMenuEsc(ev) {
        if (ev.key === 'Escape') bcCloseSymMenu();
    }
    function bcOpenSymMenu(anchor, syms, onPick) {
        bcCloseSymMenu();
        var expanded = {};
        syms.forEach(function (s, k) { expanded[k] = false; }); // 默认全部折叠（用户反馈 2026-09-14），点三角逐级展开
        var menu = document.createElement('div');
        menu.className = 'bc-sym-menu';
        var head = document.createElement('div');
        head.className = 'bc-sym-menu-head';
        head.textContent = '符号（' + syms.length + ' 个）';
        menu.appendChild(head);
        var list = document.createElement('div');
        list.className = 'bc-sym-menu-list';
        // 树形渲染（TRAE CN 同款）：按 depth 缩进，hasKids 的行带 ▾/▸ 三角折叠；
        // 收起父节点时隐藏其所有后代行（hideAt 记录折叠层级，遇到不深于它的行即复位）
        function renderRows() {
            list.innerHTML = '';
            var hideAt = -1;
            syms.forEach(function (s, idx) {
                if (hideAt >= 0) {
                    if (s.depth > hideAt) return; // 折叠父节点内的后代行
                    hideAt = -1;
                }
                var item = document.createElement('div');
                item.className = 'bc-sym-menu-item';
                item.style.paddingLeft = (10 + s.depth * 14) + 'px';
                item.title = (s.kind === 'class' ? '类 ' : '函数 ') + s.name + '（第 ' + s.line + ' 行）';
                var tri = document.createElement('span');
                tri.className = 'tri' + (s.hasKids ? '' : ' leaf');
                if (s.hasKids) {
                    tri.textContent = expanded[idx] ? '▾' : '▸';
                    tri.addEventListener('click', function (ev) {
                        ev.stopPropagation(); // 只切换折叠，不触发跳转
                        expanded[idx] = !expanded[idx];
                        renderRows();
                    });
                }
                item.appendChild(tri);
                var ico = document.createElement('span');
                ico.className = 'bc-sym-ico ' + (s.kind === 'class' ? 'cls' : 'fn');
                ico.textContent = s.kind === 'class' ? '◇' : 'ƒ';
                var nm = document.createElement('span');
                nm.className = 'nm';
                nm.textContent = s.name;
                var ln = document.createElement('span');
                ln.className = 'ln';
                ln.textContent = ':' + s.line; // 同名符号（声明+定义）靠行号区分
                item.appendChild(ico);
                item.appendChild(nm);
                item.appendChild(ln);
                item.addEventListener('click', function () {
                    bcCloseSymMenu();
                    onPick(s);
                });
                list.appendChild(item);
                if (s.hasKids && !expanded[idx]) hideAt = s.depth;
            });
            if (list._osbUpdate) list._osbUpdate('rows'); // 折叠/展开重建行后刷新滑块几何（位置/长度）
        }
        renderRows();
        menu.appendChild(list);
        if (window._osbInit) window._osbInit(list); // 阶段一百一十(4)：注册自绘悬浮滚动条（原生条已全局禁用，未注册则限高可滚但无滑块）
        document.body.appendChild(menu);
        bcSymMenuEl = menu;
        bcSymAnchor = anchor;
        // 定位：锚点下方，右缘夹紧防溢出；下方放不下翻转到锚点上方
        var r = anchor.getBoundingClientRect();
        menu.style.visibility = 'hidden';
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var left = Math.min(r.left, window.innerWidth - mw - 8);
        var top = r.bottom + 4;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = '';
        document.addEventListener('mousedown', bcSymMenuOutside, true);
        document.addEventListener('keydown', bcSymMenuEsc, true);
    }

    // file 标签路径面包屑（TRAE CN 同款）：seg=路径段，sep='›'，末段文件名带文件类型图标
    // （与标签页图标同源），其后为代码符号段（viewer 页扫描推送：函数ƒ紫/类◇蓝，点击跳转对应行）；
    // 符号超过 6 个时按 TRAE CN 同款折叠：内联前 6 个 + "…"展开段点击弹出全量符号菜单
    function browserRenderCrumbs(relPath, st) {
        browserCrumbsEl.innerHTML = '';
        var parts = String(relPath || '').split(/[\\/]+/).filter(function (s) { return !!s; });
        if (!parts.length) parts = ['文件预览'];
        var tab = null;
        if (st && st.kind === 'file') {
            (st.tabs || []).forEach(function (t) {
                if (t.kind === 'file' && t.id === st.active_id) tab = t;
            });
        }
        parts.forEach(function (seg, i) {
            if (i > 0) {
                var sep = document.createElement('span');
                sep.className = 'bc-sep';
                sep.textContent = '›';
                browserCrumbsEl.appendChild(sep);
            }
            var el = document.createElement('span');
            el.className = 'bc-seg' + (i === parts.length - 1 ? ' current' : '');
            el.textContent = seg;
            // 末段文件名前缀文件类型图标（CPP/JS/MD…，复用标签页图标构造器）
            if (i === parts.length - 1 && tab) {
                el.insertBefore(browserTabIcon({ kind: 'file', data_kind: tab.data_kind, ext: tab.ext }), el.firstChild);
            }
            browserCrumbsEl.appendChild(el);
        });
        // 符号段：点击跳转 viewer 编辑器对应行（编辑态 monaco 精确定位/静态预览近似滚动）；
        // 超过 6 个折叠：内联前 6 个，"…"段点击弹出全量符号菜单（TRAE CN 同款）
        var rec = (st && st.active_id) ? fileFrames[st.active_id] : null;
        var syms = (rec && rec.symbols) || [];
        function bcJump(s) {
            var r = st ? fileFrames[st.active_id] : null;
            if (r && r.ready) {
                try { r.frame.contentWindow.__fvReveal(s.line); } catch (e) { /* 未就绪忽略 */ }
            }
        }
        function makeSymSeg(s) {
            var sep = document.createElement('span');
            sep.className = 'bc-sep';
            sep.textContent = '›';
            browserCrumbsEl.appendChild(sep);
            var seg = document.createElement('span');
            seg.className = 'bc-seg bc-sym';
            seg.title = (s.kind === 'class' ? '类 ' : '函数 ') + s.name + '（第 ' + s.line + ' 行，点击跳转）';
            var ico = document.createElement('span');
            ico.className = 'bc-sym-ico ' + (s.kind === 'class' ? 'cls' : 'fn');
            ico.textContent = s.kind === 'class' ? '◇' : 'ƒ';
            seg.appendChild(ico);
            var nm = document.createElement('span');
            nm.textContent = s.name;
            seg.appendChild(nm);
            seg.addEventListener('click', function () { bcJump(s); });
            browserCrumbsEl.appendChild(seg);
        }
        if (syms.length) {
            if (syms.length <= 6) {
                syms.forEach(makeSymSeg);
            } else {
                for (var k = 0; k < 6; k++) makeSymSeg(syms[k]);
                var msep = document.createElement('span');
                msep.className = 'bc-sep';
                msep.textContent = '›';
                browserCrumbsEl.appendChild(msep);
                var more = document.createElement('span');
                more.className = 'bc-seg bc-more';
                more.textContent = '…';
                more.title = '查看全部 ' + syms.length + ' 个符号';
                more.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    if (bcSymMenuEl && bcSymAnchor === more) { bcCloseSymMenu(); return; } // 再点一次收起
                    bcOpenSymMenu(more, syms, bcJump);
                });
                browserCrumbsEl.appendChild(more);
            }
        }
    }

    // 工作区相对路径是否已有对应浏览区文件标签（statePush 的 file_name 即 relPath）
    function browserHasFileTab(relPath) {
        return !!(browserLastState && (browserLastState.tabs || []).some(function (t) {
            return t.kind === 'file' && t.file_name === relPath;
        }));
    }

    // 地址栏输入补协议：无 scheme 时默认 https://（主进程 urlAllowed 仅放行 http/https）
    function browserNormalizeUrl(raw) {
        var u = String(raw || '').trim();
        if (!u) return '';
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'https://' + u;
        return u;
    }

    // 阶段九十三：原生层已移除，iframe/webview 尺寸完全由 CSS 布局驱动（inset:0 铺满内容区），
    // 无需主进程 bounds 贴合；分栏/侧栏/窗口变化时浏览器内容自动跟随

    // 阶段九十二：标签图标（TRAE CN 同款语义）——file 标签按扩展名/数据类型着色徽标，
    // web 标签站点 favicon（无则地球兜底）。语言色为 VSCode 通行配色（文件类型语义色，非主题色）
    var BROWSER_EXT_COLORS = {
        js: '#e8d44d', mjs: '#e8d44d', cjs: '#e8d44d', jsx: '#e8d44d',
        ts: '#3178c6', tsx: '#3178c6', go: '#00add8', py: '#3572a5', java: '#b07219',
        rs: '#dea584', c: '#8a6fd6', h: '#8a6fd6', cpp: '#8a6fd6', cc: '#8a6fd6',
        cxx: '#8a6fd6', hpp: '#8a6fd6', cs: '#68217a', rb: '#cc3428', php: '#4f5d95',
        swift: '#f05138', kt: '#7f52ff', md: '#519aba', json: '#cbcb41', xml: '#e37933',
        html: '#e34c26', htm: '#e34c26', css: '#563d7c', scss: '#c6538c', sql: '#c9a96e',
        sh: '#89e051', bat: '#c1f12e', ps1: '#5391c1', yml: '#6d80a6', yaml: '#6d80a6',
        txt: '#9aa0a6', log: '#9aa0a6', ini: '#9aa0a6', conf: '#9aa0a6',
        doc: '#2b579a', docx: '#2b579a', docm: '#2b579a', xls: '#217346', xlsx: '#217346',
        xlsm: '#217346', ppt: '#d24726', pptx: '#d24726', pptm: '#d24726', pdf: '#b30b00',
        png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4',
        bmp: '#a074c4', svg: '#ffb13b', ico: '#ffb13b', zip: '#efb43c', rar: '#efb43c', '7z': '#efb43c'
    };

    // 地球兜底图标（web 标签无 favicon 时）
    function browserGlobeIcon() {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.classList.add('browser-tab-globe');
        var g = document.createElementNS(NS, 'g');
        g.setAttribute('fill', 'none');
        g.setAttribute('stroke', 'currentColor');
        g.setAttribute('stroke-width', '1.2');
        var c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', '6');
        var mer = document.createElementNS(NS, 'ellipse');
        mer.setAttribute('cx', '8'); mer.setAttribute('cy', '8'); mer.setAttribute('rx', '2.6'); mer.setAttribute('ry', '6');
        var eq = document.createElementNS(NS, 'line');
        eq.setAttribute('x1', '2'); eq.setAttribute('y1', '8'); eq.setAttribute('x2', '14'); eq.setAttribute('y2', '8');
        g.appendChild(c); g.appendChild(mer); g.appendChild(eq);
        svg.appendChild(g);
        return svg;
    }

    // 按标签类型构造图标节点
    function browserTabIcon(t) {
        var el = document.createElement('span');
        el.className = 'browser-tab-ico';
        if (t.kind === 'file') {
            var dk = t.data_kind || '';
            var label, color;
            if (dk === 'diff') { label = '±'; color = '#d29922'; }
            else if (dk === 'commit') { label = '⎇'; color = '#b48ce3'; }
            else if (dk === 'md') { label = 'MD'; color = BROWSER_EXT_COLORS.md; }
            else if (dk === 'text') { label = 'TXT'; color = BROWSER_EXT_COLORS.txt; }
            else {
                var ext = (t.ext || '').toLowerCase();
                label = ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
                color = BROWSER_EXT_COLORS[ext] || 'var(--text-light)';
            }
            el.textContent = label;
            el.style.color = color;
            return el;
        }
        if (t.favicon) {
            var img = document.createElement('img');
            img.className = 'browser-tab-fav';
            img.src = t.favicon;
            img.alt = '';
            img.addEventListener('error', function () {
                img.replaceWith(browserGlobeIcon());
            });
            el.classList.add('bare');
            el.appendChild(img);
            return el;
        }
        el.classList.add('bare');
        el.appendChild(browserGlobeIcon());
        return el;
    }

    // 标签栏渲染：主进程推送全量 tabs，按 active_id 高亮；加载中显示旋转指示；
    // file 标签预览态斜体+ (Preview) 后缀 + 未保存圆点（TRAE CN 同款）
    function browserRenderTabs(state) {
        browserTabsEl.innerHTML = '';
        (state.tabs || []).forEach(function (t) {
            var isFile = t.kind === 'file';
            var chip = document.createElement('div');
            chip.className = 'browser-tab' + (t.id === state.active_id ? ' active' : '') + (isFile ? ' is-file' : '') + (t.dirty ? ' dirty' : '') + (t.pinned ? ' pinned' : '');
            // 阶段九十四：悬停 tooltip 显示完整路径（TRAE 同款）——文件标签显绝对路径，网页标签仍显标题
            chip.title = isFile ? (t.file_path || t.file_name || t.title || '') : (t.title || '(无标题)');
            if (t.pinned) { // 阶段九十四：固定标签——锁形小图标（防误关，批量关闭跳过，菜单可取消固定）
                var pin = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                pin.setAttribute('viewBox', '0 0 24 24');
                pin.setAttribute('width', '10');
                pin.setAttribute('height', '10');
                pin.setAttribute('class', 'browser-tab-pin');
                pin.innerHTML = '<path fill="currentColor" d="M16 12V7a4 4 0 0 0-8 0v5H6v8h12v-8h-2zm-6-5a2 2 0 0 1 4 0v5h-4V7z"/>';
                chip.appendChild(pin);
            }
            if (t.loading) {
                var spin = document.createElement('span');
                spin.className = 'browser-tab-loading';
                chip.appendChild(spin);
            } else {
                chip.appendChild(browserTabIcon(t));
            }
            var title = document.createElement('span');
            title.className = 'browser-tab-title';
            title.textContent = t.title || '(无标题)';
            chip.appendChild(title);
            var close = document.createElement('span');
            close.className = 'browser-icon-btn browser-tab-close';
            close.title = '关闭标签页';
            close.textContent = t.dirty ? '●' : '×';
            if (t.pinned) close.classList.add('hidden'); // 固定标签不显示关闭按钮（防误关）
            if (t.dirty) { // 未保存圆点：悬停时切回 × 供关闭（TRAE 同款）
                chip.addEventListener('mouseenter', function () { close.textContent = '×'; });
                chip.addEventListener('mouseleave', function () { close.textContent = '●'; });
            }
            close.addEventListener('click', function (e) {
                e.stopPropagation();
                window.desktop.browserCloseTab(t.id);
            });
            chip.appendChild(close);
            chip.addEventListener('click', function () { window.desktop.browserSelect(t.id); });
            chip.addEventListener('contextmenu', function (e) { // 阶段九十四：标签右键菜单（TRAE CN 同款子集）
                e.preventDefault();
                browserTabContextMenu(e, t, state);
            });
            browserTabsEl.appendChild(chip);
        });
        if (window._osbInitH) window._osbInitH(browserTabsEl); // 标签多时横向自绘滑块（悬停浮现可拖拽，Trae CN 同款；幂等防重复挂载）
        var actTab = browserTabsEl.querySelector('.browser-tab.active'); // 激活标签滚入可视区（切换/新开在溢出区时可见）
        if (actTab && actTab.scrollIntoView) {
            try { actTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { actTab.scrollIntoView(); }
        }
    }

    // ===== 阶段九十四：浏览区标签右键菜单（TRAE CN 同款子集；自绘 .friend-menu 主题样式，
    // 禁用系统默认菜单；动态构建——菜单项随标签类型/固定态/位置变化） =====
    var browserTabMenuEl = null;
    function browserCloseTabMenu() {
        if (browserTabMenuEl) { browserTabMenuEl.remove(); browserTabMenuEl = null; }
        document.removeEventListener('mousedown', browserTabMenuOutside, true);
        document.removeEventListener('keydown', browserTabMenuEsc, true);
    }
    function browserTabMenuOutside(e) {
        if (browserTabMenuEl && !browserTabMenuEl.contains(e.target)) browserCloseTabMenu();
    }
    function browserTabMenuEsc(e) { if (e.key === 'Escape') browserCloseTabMenu(); }
    function browserTabContextMenu(e, t, state) {
        browserCloseTabMenu();
        var all = state.tabs || [];
        var idx = -1;
        all.forEach(function (x, i) { if (x.id === t.id) idx = i; });
        var isFile = t.kind === 'file';
        var items = [
            { label: '关闭', fn: function () { window.desktop.browserCloseTab(t.id); } },
            { label: '关闭其他', fn: function () { window.desktop.browserTabsOp('close-others', t.id); } },
            { label: '关闭右侧标签页', disabled: idx >= all.length - 1, fn: function () { window.desktop.browserTabsOp('close-right', t.id); } },
            { label: '全部关闭', fn: function () { window.desktop.browserTabsOp('close-all', ''); } },
            { sep: true },
            { label: isFile ? '复制路径' : '复制网址', fn: function () {
                var txt = isFile ? (t.file_path || t.file_name || '') : (t.url || ''); // 优先绝对路径（file_name 兜底，不再回落到标题避免复制成文件名）
                if (!txt) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt).then(function () { showToast('已复制'); }, function () {});
                }
            } }
        ];
        if (!isFile && t.url && /^https?:\/\//i.test(t.url)) {
            items.push({ label: '在系统浏览器打开', fn: function () { // 阶段九十四：结果回执——失败 toast 具体原因（禁止静默无反应）
                window.desktop.browserTabsOp('open-external', '', t.url).then(function (r) {
                    if (!r || !r.ok) showToast('打开失败：主进程拒绝该地址');
                }).catch(function (err) {
                    showToast('打开失败：' + (err && err.message ? err.message : 'IPC 异常'));
                });
            } });
        }
        if (isFile && t.file_path) {
            items.push({ label: '打开文件所在目录', fn: function () { window.desktop.browserTabsOp('show-in-folder', t.id); } }); // 阶段九十四：TRAE"在文件资源管理器中显示"同款
        }
        items.push({ sep: true });
        items.push({ label: t.pinned ? '取消固定' : '固定标签', fn: function () { window.desktop.browserTabsOp('pin', t.id); } });
        items.push({ sep: true });
        items.push({ label: '左移标签', disabled: t.pinned || idx <= 0, fn: function () { window.desktop.browserTabsOp('move', t.id, 'left'); } });
        items.push({ label: '右移标签', disabled: t.pinned || idx < 0 || idx >= all.length - 1, fn: function () { window.desktop.browserTabsOp('move', t.id, 'right'); } });
        // 动态构建菜单 DOM（复用 .friend-menu 主题样式容器）
        var menu = document.createElement('div');
        menu.className = 'friend-menu browser-tab-menu';
        items.forEach(function (it) {
            if (it.sep) {
                var sep = document.createElement('div');
                sep.className = 'menu-sep';
                menu.appendChild(sep);
                return;
            }
            var mi = document.createElement('div');
            mi.className = 'menu-item' + (it.disabled ? ' disabled' : '');
            var txt = document.createElement('span');
            txt.className = 'mi-text';
            txt.textContent = it.label;
            mi.appendChild(txt);
            if (!it.disabled) {
                mi.addEventListener('click', function () {
                    browserCloseTabMenu();
                    it.fn();
                });
            }
            menu.appendChild(mi);
        });
        document.body.appendChild(menu);
        // 定位：右/下缘防溢出翻转
        var r = menu.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - r.width - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - r.height - 8)) + 'px';
        browserTabMenuEl = menu;
        setTimeout(function () { // 异步挂全局关闭（避开本次右键事件冒泡）
            document.addEventListener('mousedown', browserTabMenuOutside, true);
            document.addEventListener('keydown', browserTabMenuEsc, true);
        }, 0);
    }

    // 状态应用（主进程 browser:state 推送归口）：显隐/标签栏/地址栏/导航按钮可用态
    function browserApplyState(state) {
        if (!state) return;
        browserLastState = state;
        browserPanelEl.classList.toggle('hidden', !state.visible);
        browserSyncSplit(); // 分栏宽度与聊天列压缩同步（展开/收起/标签变化统一归口）
        if (!state.visible) return;
        browserRenderTabs(state);
        // 阶段九十二：DOM viewer 同步——file 标签 iframe 建池/显隐/清理（仅活动 file 标签可见；
        // 网页标签活动时全部隐藏、webview 接管），标签关闭即移除对应 iframe
        var activeFileId = state.kind === 'file' ? String(state.active_id || '') : '';
        var alive = {};
        (state.tabs || []).forEach(function (t) { if (t.kind === 'file') alive[t.id] = true; });
        Object.keys(fileFrames).forEach(function (id) {
            if (!alive[id]) { // 标签已关闭 → 移除 iframe
                fileFrames[id].frame.remove();
                delete fileFrames[id];
                return;
            }
            fileFrames[id].frame.classList.toggle('hidden', id !== activeFileId);
        });
        if (activeFileId && !fileFrames[activeFileId]) {
            fileFrameFor(activeFileId).frame.classList.remove('hidden'); // 状态先于 file-load 到达的兜底建框
        }
        // 阶段九十三：web 标签 webview 同步——仅活动 web 标签建框/可见（首次激活时按当前
        // url 首载），file 标签活动时全部隐藏；标签关闭即移除对应 webview（元素移除即销毁 guest）
        var activeWebId = state.kind === 'web' ? String(state.active_id || '') : '';
        var aliveWeb = {};
        var activeWebUrl = 'about:blank';
        (state.tabs || []).forEach(function (t) {
            if (t.kind !== 'web') return;
            aliveWeb[t.id] = true;
            if (t.id === activeWebId) activeWebUrl = t.url || 'about:blank';
        });
        Object.keys(webFrames).forEach(function (id) {
            if (!aliveWeb[id]) { // 标签已关闭 → 移除 webview
                webFrames[id].el.remove();
                delete webFrames[id];
                return;
            }
            webFrames[id].el.classList.toggle('hidden', id !== activeWebId);
        });
        if (activeWebId) {
            webFrameFor(activeWebId, activeWebUrl).el.classList.remove('hidden');
        }
        // 阶段九十二：file 标签显示只读路径面包屑（TRAE 同款），web 标签才显示网址输入栏
        var isFileTab = state.kind === 'file';
        browserCrumbsEl.classList.toggle('hidden', !isFileTab);
        browserUrlEl.classList.toggle('hidden', isFileTab);
        browserGoBtn.classList.toggle('hidden', isFileTab);
        // 阶段一百一十：file 标签无网页导航语义 → 后退/前进/刷新一并隐藏（原仅随 can_back/can_forward
        // 置灰仍占位，用户实测反馈文件标签下这三个按钮多余，应不显示）
        browserBackBtn.classList.toggle('hidden', isFileTab);
        browserForwardBtn.classList.toggle('hidden', isFileTab);
        browserReloadBtn.classList.toggle('hidden', isFileTab);
        if (isFileTab) browserRenderCrumbs(state.url, state);
        // 地址栏：用户正在输入时不覆盖（避免打字被状态推送清掉）
        if (document.activeElement !== browserUrlEl) {
            browserUrlEl.value = (!state.url || state.url === 'about:blank') ? '' : state.url;
        }
        browserBackBtn.disabled = !state.can_back;
        browserForwardBtn.disabled = !state.can_forward;
        browserReloadBtn.disabled = false;
    }

    if (browserSupported()) {
        // 状态订阅（主进程 did-finish-load/操作/页面事件均会推送）
        window.desktop.onBrowserState(browserApplyState);
        // 阶段九十二：浏览区文件标签保存写盘 → 刷新工作区树（角标/状态对齐磁盘实际）
        if (typeof window.desktop.onFileSaved === 'function') {
            window.desktop.onFileSaved(function () { wsPanelRefreshTree(); });
        }
        // 尺寸变化跟随（分栏拖拽/侧栏折叠/窗口缩放改变浏览区宽度 → 分栏宽度与聊天列压缩重算；
        // iframe/webview 尺寸由 CSS 自动跟随，无需额外上报）
        if (typeof ResizeObserver === 'function') {
            var browserRO = new ResizeObserver(function () {
                browserSyncSplit();
            });
            browserRO.observe(browserContentEl);
            if (browserPanelEl.parentElement) browserRO.observe(browserPanelEl.parentElement);
        } else {
            window.addEventListener('resize', browserSyncSplit);
        }
        // 阶段九十二：窗口缩放时分栏宽度重算（面板为像素宽，需随主区尺寸重新分配）
        window.addEventListener('resize', browserSyncSplit);
        // 工具栏开关：请求展开/收起（实际显隐以主进程回推状态为准）
        browserBtn.addEventListener('click', function () {
            window.desktop.browserPanel(browserPanelEl.classList.contains('hidden'));
        });
        document.getElementById('browser-panel-close').addEventListener('click', function () {
            window.desktop.browserPanel(false);
        });
        document.getElementById('browser-newtab').addEventListener('click', function () {
            window.desktop.browserNav('newtab', '');
        });
        browserBackBtn.addEventListener('click', function () { window.desktop.browserNav('back', ''); });
        browserForwardBtn.addEventListener('click', function () { window.desktop.browserNav('forward', ''); });
        browserReloadBtn.addEventListener('click', function () { window.desktop.browserNav('reload', ''); });
        function browserGo() {
            var u = browserNormalizeUrl(browserUrlEl.value);
            if (!u) return;
            window.desktop.browserNav('goto', u);
        }
        document.getElementById('browser-go').addEventListener('click', browserGo);
        browserUrlEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); browserGo(); }
        });
        // 开关按钮仅在 PC 壳内显示（能力检测）
        browserBtn.classList.remove('hidden');
    }

    // 任务卡片：每次任务一张容器卡片，内部追加思考/工具/审批子事件流
    // sid：归属会话 id（事件帧携带，服务端盖戳同源；缺省回落当前查看会话）
    function createAgentTaskCard(agent, taskId, goal, sid) {
        var div = document.createElement('div');
        div.className = 'message other ai'; // ai 标记：任务卡行同宽放宽
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

        // 阶段一百零三：每轮 Token 消耗行（step_tokens 事件驱动实时更新，首轮到达才显示）
        var costEl = document.createElement('div');
        costEl.className = 'agent-task-cost hidden';
        card.appendChild(costEl);

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

        // 阶段七十一：任务卡归属会话盖戳（事件帧 sid 优先，缺省回落当前查看会话），完结气泡/重挂按此归口防串会话
        var stampSess = (typeof sid === 'number') ? sid : (aiViewSession[agent] || 0);
        var st = { taskId: taskId, agent: agent, goal: goal || '', sessionId: stampSess, el: div, head: head, statusEl: statusEl, stopBtn: stopBtn, bar: bar, pct: pct, costEl: costEl, todoList: todoList, events: events, tools: {}, toolGroup: null, todoDone: 0, todoTotal: 0, todoRaw: [] };
        agentTaskCards[taskId] = st;
        agentActiveTask[agent] = taskId; // 阶段七十三：进行中任务登记（发送按钮"停止"态数据源）
        updateSendBtnState();
        removeAISuggestRow(); // 阶段七十：新任务开始即消费上一轮后续提问胶囊（与 AI 问答新一轮回复同语义）
        agentDockSync(); // 阶段七十九：输入区上方停靠栏"任务"页签亮起（TRAE CN 同款单栏双页签）
        return st;
    }

    // ===== 阶段七十九：输入区上方停靠栏（TRAE CN 同款单栏双页签）=====
    // "任务"页签：任务运行期间显示（目标 + N/M 个任务已完成，面板为清单镜像）；
    // "文件变更"页签：存在待审查文件变更时显示（N 个文件待审查 +X -Y，面板为文件行 + 全部撤销/保留）。
    // 两页签同时存在时靠左侧双图标切换视图，点击栏体展开/收起面板；均无时整栏隐藏
    var agentPendingChanges = {}; // agent → {taskId, changes, totalAdds, totalDels, pending}（待审查变更状态归口：实时事件/下行66/历史重放三路共用）
    var agentDock = null;         // 停靠栏单例句柄（DOM 引用 + 当前激活页签）

    function agentDockEnsure() {
        if (agentDock) return agentDock;
        var inputBar = document.querySelector('.input-bar');
        if (!inputBar || !inputBar.parentNode) return null;
        var root = document.createElement('div');
        root.className = 'agent-dock hidden';
        var tabs = document.createElement('div');
        tabs.className = 'agent-dock-tabs';
        // 页签图标：SVG 线条图标（TRAE CN 同款风格，stroke=currentColor 跟随主题色）
        // 原实现：文本字符 '☑'/'耘'（'耘'为占位字，无图标语义）
        var taskTab = document.createElement('span');
        taskTab.className = 'agent-dock-tab task';
        taskTab.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.75" y="2" width="10.5" height="12.5" rx="1.5"/><path d="M5.25 1.5h5.5v2h-5.5z"/><path d="M5.5 8.2l1.8 1.8 3.4-3.6"/></svg>';
        taskTab.title = '任务进度';
        var chTab = document.createElement('span');
        chTab.className = 'agent-dock-tab changes';
        // 文件差异图标：文档折角 + 上加号下减号（git diff 同款语义）
        chTab.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z"/><path d="M9 1.5V5h3.5"/><path d="M8 6.8v3.4M6.3 8.5h3.4"/><path d="M6.3 12h3.4"/></svg>';
        chTab.title = '文件变更待审查';
        tabs.appendChild(taskTab);
        tabs.appendChild(chTab);
        var text = document.createElement('span');
        text.className = 'agent-dock-text';
        var metaTask = document.createElement('span');
        metaTask.className = 'agent-dock-meta task';
        var metaChA = document.createElement('span');
        metaChA.className = 'diff-add';
        var metaChD = document.createElement('span');
        metaChD.className = 'diff-del';
        var metaChanges = document.createElement('span');
        metaChanges.className = 'agent-dock-meta changes hidden';
        metaChanges.appendChild(metaChA);
        metaChanges.appendChild(metaChD);
        // 展开箭头：SVG chevron（原 '⌄' 字符受字体基线影响，与文字垂直错位）
        var arrow = document.createElement('span');
        arrow.className = 'agent-dock-arrow';
        arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>';
        root.appendChild(tabs);
        root.appendChild(text);
        root.appendChild(metaTask);
        root.appendChild(metaChanges);
        root.appendChild(arrow);
        var panel = document.createElement('div');
        panel.className = 'agent-task-dock-panel hidden'; // 复用既有面板样式（输入区上方展开）
        // 点页签图标切换视图（不展开面板）；点栏体其余区域展开/收起面板
        taskTab.addEventListener('click', function (e) {
            e.stopPropagation();
            if (agentDock && agentDock.active !== 'task') { agentDock.active = 'task'; agentDockSync(); }
        });
        chTab.addEventListener('click', function (e) {
            e.stopPropagation();
            if (agentDock && agentDock.active !== 'changes') { agentDock.active = 'changes'; agentDockSync(); }
        });
        root.addEventListener('click', function () {
            panel.classList.toggle('hidden');
            root.classList.toggle('open');
        });
        var parent = inputBar.parentNode;
        parent.insertBefore(panel, inputBar);
        parent.insertBefore(root, panel);
        agentDock = {
            root: root, taskTab: taskTab, chTab: chTab, text: text,
            metaTask: metaTask, metaChanges: metaChanges, metaChA: metaChA, metaChD: metaChD,
            arrow: arrow, panel: panel, active: ''
        };
        return agentDock;
    }

    // agentDockSetChanges 待审查变更状态归口：done/error/cancelled 事件、下行 66 刷新帧、历史任务详情重放三路共用。
    // pending 清零即摘除该智能体条目；仅当前查看的智能体变化时才刷新停靠栏（其他会话静默登记，切回时呈现）
    function agentDockSetChanges(agent, taskId, changes) {
        var list = (changes || []).filter(function (c) { return c && c.path; });
        if (!agent || !list.length) return;
        var totalAdds = 0, totalDels = 0, pending = 0;
        list.forEach(function (c) {
            totalAdds += (c.adds || 0);
            totalDels += (c.dels || 0);
            if ((c.status || 'pending') === 'pending') pending++;
        });
        if (pending > 0) {
            agentPendingChanges[agent] = { taskId: taskId, changes: list, totalAdds: totalAdds, totalDels: totalDels, pending: pending };
        } else {
            delete agentPendingChanges[agent];
        }
        if (agent === currentChatUser) agentDockSync();
    }

    // agentDockSync 停靠栏重绘归口：按当前会话智能体的运行任务与待审查变更计算页签显隐/视图内容/面板内容。
    // 激活页签失效时自动切换（任务完结→切文件变更；变更清零→切任务；均无→整栏隐藏）
    function agentDockSync() {
        var d = agentDockEnsure();
        if (!d) return;
        var agent = (currentChatUser && isAIAgent(currentChatUser)) ? currentChatUser : '';
        var taskSt = agent ? agentTaskCards[agentActiveTask[agent]] : null;
        var ch = agent ? agentPendingChanges[agent] : null;
        var hasTask = !!taskSt && !taskSt.finished;
        var hasChanges = !!ch;
        d.taskTab.classList.toggle('hidden', !hasTask);
        d.chTab.classList.toggle('hidden', !hasChanges);
        if (!hasTask && !hasChanges) {
            d.root.classList.add('hidden');
            d.panel.classList.add('hidden');
            d.root.classList.remove('open');
            d.active = '';
            return;
        }
        if (d.active !== 'task' && d.active !== 'changes') d.active = hasTask ? 'task' : 'changes';
        if (d.active === 'task' && !hasTask) d.active = 'changes';
        if (d.active === 'changes' && !hasChanges) d.active = hasTask ? 'task' : 'changes';
        // 阶段一百零五：签名比对防闪烁——停靠栏由 Agent 事件高频驱动（进度/todo 逐步更新），
        // 渲染输入无变化时跳过重建（原实现每次清空重建面板，任务执行期间反复闪烁）
        var dockSig = JSON.stringify([d.active, hasTask, hasChanges,
            taskSt ? [taskSt.goal, taskSt.todoDone, taskSt.todoTotal, taskSt.todoRaw] : null,
            ch ? [ch.pending, ch.totalAdds, ch.totalDels, ch.changes] : null]);
        if (dockSig === d._sig) return;
        d._sig = dockSig;
        d.root.classList.remove('hidden');
        d.taskTab.classList.toggle('active', d.active === 'task');
        d.chTab.classList.toggle('active', d.active === 'changes');
        if (d.active === 'task') {
            d.text.textContent = taskSt.goal || '任务执行中';
            d.text.title = taskSt.goal || '';
            d.metaTask.textContent = (taskSt.todoDone || 0) + '/' + (taskSt.todoTotal || 0) + ' 个任务已完成';
            d.metaTask.classList.remove('hidden');
            d.metaChanges.classList.add('hidden');
        } else {
            d.text.textContent = ch.pending + ' 个文件待审查';
            d.text.title = '仅统计服务端工作区变更；撤销将还原文件到任务前内容';
            d.metaChA.textContent = '+' + ch.totalAdds;
            d.metaChD.textContent = '-' + ch.totalDels;
            d.metaTask.classList.add('hidden');
            d.metaChanges.classList.remove('hidden');
        }
        // 面板内容重绘（展开/收起状态下均准备就绪，展开时即时可见）
        d.panel.innerHTML = '';
        if (d.active === 'task' && taskSt) {
            (taskSt.todoRaw || []).forEach(function (t) {
                var item = document.createElement('div');
                item.className = 'agent-todo-item ' + (t.status || 'pending');
                var mark = document.createElement('span');
                mark.className = 'agent-todo-mark';
                mark.textContent = t.status === 'done' ? '✓' : (t.status === 'in_progress' ? '▸' : '○');
                var tEl = document.createElement('span');
                tEl.className = 'agent-todo-text';
                tEl.textContent = t.content || '';
                item.appendChild(mark);
                item.appendChild(tEl);
                d.panel.appendChild(item);
            });
        } else if (ch) {
            d.panel.appendChild(agentBuildChangesList(ch.taskId, ch.changes));
        }
    }

    function agentTaskScroll() {
        messageList.scrollTop = messageList.scrollHeight;
    }

    function setAgentTaskStatus(st, text, cls) {
        st.statusEl.textContent = text;
        if (cls === 'running') st.statusEl.appendChild(agentDotsEl()); // 执行中：附跳动三点（其他状态仅文字）
        st.statusEl.className = 'agent-task-status ' + (cls || 'running');
    }

    // 阶段一百零二：任务卡状态行的 Token 消耗标注（与气泡操作栏 ⚡ 格式一致；0=上游未返回 usage 不显示）
    function agentTokensTag(tokens) {
        return tokens && tokens.total > 0 ? '（⚡ ' + tokens.total + ' tokens）' : '';
    }

    function finishAgentTask(st, text, cls) {
        st.finished = true; // 阶段七十：完结标记（会话重放时据此区分实时卡与已完结任务）
        setAgentTaskStatus(st, text, cls);
        st.stopBtn.disabled = true;
        st.stopBtn.textContent = '已结束';
        // 阶段七十三：任务完结即清进行中标记（当前会话发送按钮"停止"态复位）
        if (agentActiveTask[st.agent] === st.taskId) {
            delete agentActiveTask[st.agent];
            updateSendBtnState();
        }
        // 阶段七十九：任务结束收"任务"页签（卡片内已完成状态接管）；若该任务有待审查变更，
        // 停靠栏自动切换到"文件变更"页签（TRAE CN 同款：任务完成后待审查条顶到输入区上方）
        agentDockSync();
    }

    // collapseAgentCard 阶段七十：任务完结卡片折叠归口——执行过程（思考/工具/清单）整体收起，
    // 与重进会话时的重放卡观感一致；点击卡头可再展开/回看完整过程（仅隐藏，不销毁任何子块）
    function collapseAgentCard(st) {
        if (!st.headToggle) {
            st.headToggle = true;
            st.head.style.cursor = 'pointer'; // 折叠后卡头可点击展开（仅完结态显示手型，运行态不变）
            st.head.addEventListener('click', function () {
                var hidden = st.events.classList.toggle('hidden'); // true=现已被隐藏
                if (!hidden && st.todoList.children.length) st.todoList.classList.remove('hidden');
                else st.todoList.classList.add('hidden');
            });
        }
        st.events.classList.add('hidden');
        st.todoList.classList.add('hidden');
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
        initAIMdHScroll(bodyEl); // 宽表格/代码块挂横向自绘滑块（思考文本一次性渲染，DOM 已稳定）
        block.appendChild(head);
        block.appendChild(bodyEl);
        st.events.appendChild(block);
        agentTaskScroll();
    }

    // 阶段六十二：工具人性化映射（Trae CN 同款）——中文标题 + 关键参数芯片（路径/命令/条目数）
    // 阶段六十八：新增 http_request / web_search 映射；阶段七十四：新增 edit_file/delete_file/list_dir/grep 映射
    var AGENT_TOOL_TITLE = { read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件', delete_file: '删除文件', list_dir: '列目录', grep: '搜索文件', run_command: '执行命令', todo_write: '更新任务清单', http_request: 'HTTP 请求', web_search: '联网搜索' };

    function agentToolChipText(tool, params) {
        var p = params || {};
        if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file' || tool === 'delete_file' || tool === 'list_dir') return String(p.path || p.file || '');
        if (tool === 'grep') return String(p.pattern || '');
        if (tool === 'run_command') return String(p.command || p.cmd || '');
        if (tool === 'http_request') {
            var m = String(p.method || 'GET').toUpperCase();
            var u = String(p.url || '');
            if (u.length > 70) u = u.slice(0, 70) + '…';
            return (m + ' ' + u).trim();
        }
        if (tool === 'web_search') return String(p.query || '');
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
        // 打字机未播完的增量先拼回已展示文本再收尾，避免 done/tool_start 到达时截断答复
        cur.shown += cur.pending;
        cur.pending = '';
        cur.cursorEl.remove();
        st.curText = null;
        if (!cur.shown.trim()) { cur.el.remove(); return false; }
        cur.textEl.innerHTML = renderAIMarkdown(cur.shown);
        initAIMdHScroll(cur.el); // 收尾后 DOM 稳定，宽表格/代码块挂横向自绘滑块
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

    // ===== 阶段七十：任务卡会话重放归口 =====
    // 事件流仅实时渲染（不落库），切会话后卡片 DOM 随 messageList 清空；重进智能体会话按 DB 归口恢复可见性：
    // 1) 已完结任务：以完结答复气泡（reply_msg_id）为锚点，在其上方内联重放任务卡（点击展开详情与执行轨迹，
    //    复用任务历史弹窗的渲染链路与样式）；任务在切走期间完结时同步校正内存卡状态（done 事件因会话归属被跳过）
    // 2) 运行中/排队任务：内存实时卡仍在（事件流继续推送）则重挂 DOM 续播；无内存卡（他端发起）按 DB 快照渲染静态卡
    function agentReplayTasks() {
        var agent = currentChatUser;
        // 阶段七十一：按当前查看会话过滤（服务端归口；0=默认会话，仅重放未盖戳存量任务，防跨会话串显）
        fetch('/api/agent/tasks?username=' + encodeURIComponent(kbUsername()) +
            '&agent=' + encodeURIComponent(agent) + '&page=1&size=20' +
            '&session_id=' + (aiViewSession[agent] || 0))
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok || currentChatUser !== agent) return; // 会话已切换：丢弃过期响应
                var tasks = (res.data && res.data.tasks) || [];
                var liveAny = false;
                var seenTasks = {}, seenPending = {};
                tasks.forEach(function (t) {
                    seenTasks[t.task_id] = true;
                    var finished = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';
                    var st = agentTaskCards[t.task_id];
                    if (finished) {
                        // 完结任务统一按 DB 归口重放（答复气泡锚点插入，与重新登录视图一致）。
                        // 原漏洞：内存卡存在（st）时既不重挂也不插重放卡，切会话返回后卡片消失，
                        // 仅重登（内存为空）才走重放分支显示；实时卡 DOM 已随切会话分离且状态滞后于 DB，不再复用
                        if (st && !st.finished) finishAgentTask(st, thStateLabel(t.status), t.status); // 切走期间完结：校正滞留状态并收任务栏
                        // 阶段七十三：切走期间完结的任务清进行中标记（finishAgentTask 仅对内存卡生效，此处兜底）
                        if (agentActiveTask[agent] === t.task_id) {
                            delete agentActiveTask[agent];
                            updateSendBtnState();
                        }
                        if (t.reply_msg_id) agentInsertReplayCard(agent, t);
                        // 阶段七十九：待审查变更登记停靠栏（服务端列表仅 pending 任务带 changes 键；
                        // 重进会话/刷新页面后输入区上方仍可见，无需点开任务卡）
                        if (t.changes && t.changes.length) {
                            seenPending[t.task_id] = true;
                            agentDockSetChanges(agent, t.task_id, t.changes);
                        }
                        return;
                    }
                    // 运行中/排队：内存实时卡重挂续播（后续事件继续上屏）；无内存卡（他端发起）按 DB 快照渲染静态卡
                    // 会话归属双保险：内存卡盖戳校验 + 服务端 session_id 过滤，他端/跨会话任务不进当前视图
                    if (st && st.sessionId === (aiViewSession[agent] || 0)) {
                        messageList.appendChild(st.el);
                    } else if (!st) {
                        messageList.appendChild(agentBuildReplayCard(agent, t));
                    }
                    // 阶段七十三：重放发现的进行中任务登记（当前会话发送按钮"停止"态恢复）
                    agentActiveTask[agent] = t.task_id;
                    liveAny = true;
                });
                if (liveAny) agentTaskScroll();
                // 阶段七十九：已登记的 pending 任务若出现在本页且服务端已无 pending 行（他端已处置），
                // 摘除停靠栏残留页签（本页未出现的任务不动——可能在更早分页）
                var pc = agentPendingChanges[agent];
                if (pc && seenTasks[pc.taskId] && !seenPending[pc.taskId]) {
                    delete agentPendingChanges[agent];
                    agentDockSync();
                }
                updateSendBtnState();
            })
            .catch(function () { /* 任务重放失败静默：历史消息与任务历史弹窗兜底 */ });
    }

    // agentBuildReplayCard 重放卡构造（复用任务历史弹窗卡样式；包裹消息行容器对齐气泡宽度，带智能体头像）
    function agentBuildReplayCard(agent, t) {
        var row = document.createElement('div');
        row.className = 'message other ai'; // ai 标记：重放卡行同宽放宽
        var body = document.createElement('div');
        body.className = 'message-body';
        var card = document.createElement('div');
        card.className = 'taskhist-card';

        var head = document.createElement('div');
        head.className = 'taskhist-head';
        var badge = document.createElement('span');
        badge.className = 'taskhist-badge st-' + t.status;
        badge.textContent = thStateLabel(t.status);
        var goal = document.createElement('span');
        goal.className = 'taskhist-goal';
        goal.textContent = t.goal || '(无目标)';
        goal.title = t.goal || '';
        head.appendChild(badge);
        head.appendChild(goal);
        card.appendChild(head);

        var meta = document.createElement('div');
        meta.className = 'taskhist-meta';
        meta.textContent = (t.steps || 0) + ' 步 · ' + thFormatTime(t.update_time || t.create_time);
        card.appendChild(meta);

        var detail = document.createElement('div');
        detail.className = 'taskhist-detail hidden';
        card.appendChild(detail);

        card.addEventListener('click', function () {
            if (card.classList.contains('expanded')) {
                card.classList.remove('expanded');
                detail.classList.add('hidden');
                return;
            }
            card.classList.add('expanded');
            detail.classList.remove('hidden');
            detail.textContent = '加载详情…';
            fetch('/api/agent/task/' + encodeURIComponent(t.task_id) + '?username=' + encodeURIComponent(kbUsername()))
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (!res.ok) { detail.textContent = res.msg || '详情加载失败'; return; }
                    var d = res.data || {};
                    detail.innerHTML = '';
                    function row(label, text) {
                        if (!text) return;
                        var lab = document.createElement('div');
                        lab.className = 'taskhist-d-label';
                        lab.textContent = label;
                        var bod = document.createElement('div');
                        bod.className = 'taskhist-d-body';
                        bod.textContent = text;
                        detail.appendChild(lab);
                        detail.appendChild(bod);
                    }
                    row('任务目标', d.goal);
                    if (d.status === 'completed') row('最终总结', d.result);
                    if (d.status === 'failed') row('失败原因', d.error);
                    if (d.status === 'cancelled') row('取消说明', d.error);
                    // 阶段七十七：文件变更审查条（历史任务 pending 可操作，kept/reverted 只读徽标）
                    if (d.changes && d.changes.length) {
                        var chBox = agentBuildChangesBox(t.task_id, d.changes);
                        if (chBox) detail.appendChild(chBox);
                        // 阶段七十九：pending 变更登记到停靠栏（重进会话/刷新页面后输入区上方仍可见）
                        agentDockSetChanges(agent, t.task_id, d.changes);
                    }
                    thLoadSteps(detail, t.task_id); // 执行轨迹懒加载（与任务历史弹窗同链路）
                })
                .catch(function () { detail.textContent = '详情加载失败'; });
        });

        body.appendChild(card);
        row.appendChild(getAvatarEl(agent));
        row.appendChild(body);
        return row;
    }

    // agentInsertReplayCard 重放卡插入完结答复气泡之前（reply_msg_id 锚点；气泡不在已加载窗口则不插，翻页兜底走任务历史）
    function agentInsertReplayCard(agent, t) {
        var anchor = messageList.querySelector('.message[data-msg-id="' + t.reply_msg_id + '"]');
        if (!anchor) return;
        messageList.insertBefore(agentBuildReplayCard(agent, t), anchor);
    }

    // ===== 阶段七十七：文件变更审查条（TRAE CN 同款）=====
    // 任务 done/error/cancelled 后渲染"N 个文件已更改 +X -Y"折叠汇总 + 逐文件行（git 同款 A/M/D 标
    // + 增删行数）+ 待审查底栏（全部撤销/全部保留）。仅统计服务端工作区变更（PC 本地执行不经服务端归口）；
    // 撤销为 git discard 语义：直接还原任务前内容。live 卡与重放卡详情共用 agentBuildChangesBox。

    // 上行审查操作（path 缺省=全部 pending；服务端处理后回下行 66 全量刷新帧同步多端）
    function sendAgentChangesAction(taskId, action, path) {
        var payload = { task_id: taskId, action: action };
        if (path) payload.path = path;
        IMSocket.send({ msg_type: MSG.AGENT_CHANGES, content: JSON.stringify(payload) });
    }

    // 路径拆分：[文件名, 目录]（正斜杠归一，目录部分悬停可见全文）
    function splitChangePath(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        if (i < 0) return [s, ''];
        return [s.slice(i + 1), s.slice(0, i)];
    }

    // 构建逐文件行列表 + 待审查底栏（卡片审查条主体与停靠栏面板共用；返回包裹层）。
    // pending 行存在时附"N 个文件待审查 + 全部撤销/全部保留"底栏
    function agentBuildChangesList(taskId, changes) {
        var list = (changes || []).filter(function (c) { return c && c.path; });
        var totalAdds = 0, totalDels = 0, pending = 0;
        list.forEach(function (c) {
            totalAdds += (c.adds || 0);
            totalDels += (c.dels || 0);
            if ((c.status || 'pending') === 'pending') pending++;
        });

        var wrap = document.createElement('div');
        wrap.className = 'agent-changes-body';

        // 逐文件列表
        var bodyEl = document.createElement('div');
        bodyEl.className = 'agent-changes-list';
        list.forEach(function (c) {
            var st = c.status || 'pending';
            var row = document.createElement('div');
            row.className = 'agent-changes-row st-' + st;
            var ico = document.createElement('span');
            ico.className = 'agent-changes-ico k-' + (c.kind || 'modify');
            ico.textContent = c.kind === 'create' ? 'A' : (c.kind === 'delete' ? 'D' : 'M');
            ico.title = c.kind === 'create' ? '新建' : (c.kind === 'delete' ? '删除' : '修改');
            var names = splitChangePath(c.path);
            var nameEl = document.createElement('span');
            nameEl.className = 'agent-changes-name';
            nameEl.textContent = names[0];
            var dirEl = document.createElement('span');
            dirEl.className = 'agent-changes-dir';
            dirEl.textContent = names[1];
            dirEl.title = c.path;
            var dstat = document.createElement('span');
            dstat.className = 'agent-changes-dstat';
            var a = document.createElement('span');
            a.className = 'diff-add';
            a.textContent = '+' + (c.adds || 0);
            var d = document.createElement('span');
            d.className = 'diff-del';
            d.textContent = '-' + (c.dels || 0);
            dstat.appendChild(a);
            dstat.appendChild(d);
            var badge = document.createElement('span');
            badge.className = 'agent-changes-badge ' + st;
            if (st === 'kept') {
                badge.textContent = '已保留';
            } else if (st === 'reverted') {
                badge.textContent = '已撤销';
            } else {
                badge.textContent = '待审查';
                var rv = document.createElement('button');
                rv.className = 'agent-changes-revert';
                rv.textContent = '撤销';
                rv.title = '还原该文件到任务前内容';
                rv.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (rv.disabled) return;
                    rv.disabled = true;
                    sendAgentChangesAction(taskId, 'revert', c.path);
                });
                badge.appendChild(rv);
            }
            row.appendChild(ico);
            row.appendChild(nameEl);
            row.appendChild(dirEl);
            row.appendChild(dstat);
            row.appendChild(badge);
            // 点击行打开工作区预览（面板可见时；强制重读磁盘最新）。PC 端改道浏览区标签（阶段九十二）
            row.addEventListener('click', function (e) {
                e.stopPropagation(); // 阻断冒泡：避免触发外层任务卡折叠切换
                if ((wsPcViewer() || wsPanel.visible) && typeof wsOpenFile === 'function') wsOpenFile(c.path, true);
            });
            bodyEl.appendChild(row);
        });
        wrap.appendChild(bodyEl);

        // 底栏（仅存在 pending 时）：N 个文件待审查 + 全部撤销/全部保留
        if (pending > 0) {
            var actions = document.createElement('div');
            actions.className = 'agent-changes-actions';
            var label = document.createElement('span');
            label.className = 'agent-changes-pending';
            label.textContent = pending + ' 个文件待审查';
            var btns = document.createElement('div');
            btns.className = 'agent-changes-btns';
            var revertAll = document.createElement('button');
            revertAll.className = 'agent-approve-no';
            revertAll.textContent = '全部撤销';
            revertAll.addEventListener('click', function () {
                if (revertAll.disabled) return;
                revertAll.disabled = true;
                keepAll.disabled = true;
                sendAgentChangesAction(taskId, 'revert');
            });
            var keepAll = document.createElement('button');
            keepAll.className = 'agent-approve-ok';
            keepAll.textContent = '全部保留';
            keepAll.addEventListener('click', function () {
                if (keepAll.disabled) return;
                revertAll.disabled = true;
                keepAll.disabled = true;
                sendAgentChangesAction(taskId, 'keep');
            });
            btns.appendChild(revertAll);
            btns.appendChild(keepAll);
            // 底栏整块阻断冒泡：点按钮/空白处均不触发外层任务卡折叠
            actions.addEventListener('click', function (e) { e.stopPropagation(); });
            actions.appendChild(label);
            actions.appendChild(btns);
            wrap.appendChild(actions);
        }
        return wrap;
    }

    // 构建审查条卡片块（可重入：下行 66 全量刷新时整块重建）。changes 为空返回 null。
    // 结构：折叠汇总头（N 个文件已更改 +X -Y，默认收起）+ 逐文件列表 + 待审查底栏
    function agentBuildChangesBox(taskId, changes) {
        var list = (changes || []).filter(function (c) { return c && c.path; });
        if (!list.length) return null;
        var totalAdds = 0, totalDels = 0;
        list.forEach(function (c) {
            totalAdds += (c.adds || 0);
            totalDels += (c.dels || 0);
        });

        var box = document.createElement('div');
        box.className = 'agent-changes';
        box.dataset.changesTask = taskId; // 66 帧全量刷新定位标记（live 卡与重放卡共用，按 task_id 扫描重建）
        box.title = '仅统计服务端工作区变更；撤销将还原该文件到任务前内容';

        // 折叠汇总头：N 个文件已更改  +X -Y（默认收起，点击展开逐文件）
        var head = document.createElement('div');
        head.className = 'agent-changes-head';
        var cnt = document.createElement('span');
        cnt.className = 'agent-changes-cnt';
        cnt.textContent = list.length + ' 个文件已更改';
        var stat = document.createElement('span');
        stat.className = 'agent-changes-stat';
        var addEl = document.createElement('span');
        addEl.className = 'diff-add';
        addEl.textContent = '+' + totalAdds;
        var delEl = document.createElement('span');
        delEl.className = 'diff-del';
        delEl.textContent = '-' + totalDels;
        stat.appendChild(addEl);
        stat.appendChild(delEl);
        var arrow = document.createElement('span');
        arrow.className = 'agent-changes-arrow';
        arrow.textContent = '▸';
        head.appendChild(cnt);
        head.appendChild(stat);
        head.appendChild(arrow);

        var body = agentBuildChangesList(taskId, changes);
        var listEl = body.querySelector('.agent-changes-list');
        listEl.classList.add('hidden'); // 默认收起
        head.addEventListener('click', function (e) {
            e.stopPropagation(); // 阻断冒泡：避免点击展开文件列表时连带触发外层任务卡折叠
            var hidden = listEl.classList.toggle('hidden');
            arrow.textContent = hidden ? '▸' : '▾';
        });

        box.appendChild(head);
        box.appendChild(body);
        return box;
    }

    // live 任务卡渲染/刷新审查条（事件与下行 66 刷新共用，整块重建可重入）
    function agentRenderChanges(st, changes) {
        var card = st.head ? st.head.parentNode : null;
        if (card) {
            var old = card.querySelector('.agent-changes');
            if (old) old.remove();
            var box = agentBuildChangesBox(st.taskId, changes);
            if (box) {
                card.appendChild(box);
                agentTaskScroll();
            }
        }
        // 阶段七十九：同步停靠栏"文件变更"页签（TRAE CN 同款：待审查条顶到输入区上方）
        agentDockSetChanges(st.agent, st.taskId, changes);
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
        // 阶段八十九：MCP 工具服务端下发人类可读展示名（label="MCP · 服务器 / 工具"），命名空间 key 不可反解
        title.textContent = ev.label || AGENT_TOOL_TITLE[ev.tool] || ('工具 · ' + (ev.tool || ''));
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
        if (ev.call_id) block.setAttribute('data-call-id', ev.call_id); // 阶段七十五：控制台输出/转后台按步骤精确归属
        // 阶段七十五：run_command 实时控制台 + 转后台按钮（Trae 同款——输出流式可见不再"盲等"，
        // >5 秒浮现"转后台"，点击立即返回不阻塞对话、进程继续输出继续流）
        if (ev.tool === 'run_command' && ev.call_id) {
            buildAgentCmdConsole(block, st, ev.call_id);
            agentConsoleBegin(st, ev); // 阶段七十五（增强）：同步写入底部独立控制台抽屉 + 浮出"打开控制台"入口
        }
        // 阶段七十六：文件面板角标（write_file=新 / edit_file=改），工具结果到达后刷新树并自动打开
        // delete_file 同记路径（结果到达后删行/关标签），但不打角标
        if ((ev.tool === 'write_file' || ev.tool === 'edit_file' || ev.tool === 'delete_file') && ev.params && ev.params.path) {
            if (ev.tool !== 'delete_file') wsPanelTouchPath(ev.params.path, ev.tool === 'write_file' ? 'new' : 'mod');
            wsPanel.lastToolPath[ev.tool] = ev.params.path; // 记路径：tool_result 不带 params，按工具名取回刷新预览
        }
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

    // ===== 阶段七十五：run_command 实时控制台（Trae 同款）=====
    // 命令输出流式滚动展示（tool_output 事件驱动），执行中"执行中 · Xs"计时防"卡住"错觉，
    // >5 秒浮现"转后台"按钮（点击上行 msg 61：命令立即返回不阻塞对话，进程继续、输出继续流，
    // 结束后 tool_exit 终帧在控制台标注退出码/耗时）
    function buildAgentCmdConsole(block, st, callId) {
        var con = document.createElement('div');
        con.className = 'agent-cmd-console hidden';
        var pre = document.createElement('pre');
        pre.className = 'agent-cmd-console-pre';
        con.appendChild(pre);
        var outEl = block.querySelector('.agent-event-output');
        block.insertBefore(con, outEl); // 控制台位于参数详情与结果详情之间
        var bgBtn = document.createElement('button');
        bgBtn.className = 'agent-tool-bgbtn hidden';
        bgBtn.type = 'button';
        bgBtn.textContent = '转后台';
        bgBtn.title = '命令转入后台继续执行，对话不再等待（输出仍在控制台实时展示）';
        bgBtn.addEventListener('click', function () {
            if (bgBtn.disabled) return;
            IMSocket.send({ msg_type: MSG.AGENT_BG, content: JSON.stringify({ task_id: st.taskId, step: callId }) });
            bgBtn.disabled = true;
            bgBtn.textContent = '已转后台';
        });
        block.querySelector('.agent-event-head').appendChild(bgBtn);
        block._bgBtn = bgBtn;
        block._bgTimer = setTimeout(function () {
            if (block.classList.contains('pending')) bgBtn.classList.remove('hidden');
        }, 5000);
        // 执行计时："执行中 · Xs"（每秒刷新；保留原三点跳动动画节点不被重建）
        var running = block.querySelector('.agent-tool-running');
        if (running) {
            var dots = running.querySelector('.ai-thinking-dots');
            var secSpan = document.createElement('span');
            secSpan.className = 'agent-tool-elapsed';
            running.textContent = '';
            secSpan.textContent = '执行中';
            running.appendChild(secSpan);
            if (dots) running.appendChild(dots);
            var t0 = Date.now();
            block._elapsedTimer = setInterval(function () {
                if (!running.isConnected) { clearInterval(block._elapsedTimer); return; }
                secSpan.textContent = '执行中 · ' + Math.round((Date.now() - t0) / 1000) + 's';
            }, 1000);
        }
    }

    // 收尾工具块动态元素（转后台按钮/计时器；tool_result 或 tool_exit 先到者触发）
    function stopAgentToolTimers(block) {
        if (block._bgTimer) { clearTimeout(block._bgTimer); block._bgTimer = null; }
        if (block._elapsedTimer) { clearInterval(block._elapsedTimer); block._elapsedTimer = null; }
        if (block._bgBtn) { block._bgBtn.remove(); block._bgBtn = null; }
    }

    // 控制台归属：按 call_id 精确匹配；兜底最后一个执行中的 run_command 块（旧服务端事件无 call_id 时）
    function findAgentCmdBlock(st, callId) {
        if (callId) {
            var hit = st.events.querySelector('.agent-event.tool[data-call-id="' + callId + '"]');
            if (hit) return hit;
        }
        var blocks = st.events.querySelectorAll('.agent-event.tool.pending[data-tool="run_command"]');
        return blocks.length ? blocks[blocks.length - 1] : null;
    }

    // 实时输出帧 → 控制台追加（底部跟随：用户上翻查看历史时暂停自动滚动；展示上限后提示）
    function updateAgentToolOutput(st, ev) {
        agentConsoleOutput(st, ev); // 底部独立控制台抽屉同步（同源双写）
        var block = findAgentCmdBlock(st, ev.call_id);
        if (!block) return;
        var con = block.querySelector('.agent-cmd-console');
        var pre = block.querySelector('.agent-cmd-console-pre');
        if (!con || !pre) return;
        if (con.classList.contains('hidden')) {
            con.classList.remove('hidden');
            // 抽屉已打开时不自动展开内嵌控制台（同一输出两处展开重复刷屏；点标题可手动回看）
            if (!agentConsole.open) block.classList.remove('collapsed');
        }
        var stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
        if (ev.chunk) {
            pre.appendChild(document.createTextNode(ev.chunk));
            // 展示环上限：仅保留尾部 60KB（完整输出以 tool_result 汇总与服务端留档为准）
            if (pre.textContent.length > 80000) pre.textContent = pre.textContent.slice(-60000);
        }
        if (ev.over && !block._overTip) {
            block._overTip = true;
            pre.appendChild(document.createTextNode('\n…（输出已达实时展示上限，后续增量不再下发，结束后按上限汇总）\n'));
        }
        if (stick) {
            pre.scrollTop = pre.scrollHeight;
            agentTaskScroll();
        }
    }

    // 进程结束终帧 → 控制台标注退出码/耗时/输出量（仅前端控制台展示，不进模型上下文）
    function finalizeAgentToolExit(st, ev) {
        agentConsoleExit(st, ev); // 底部独立控制台抽屉同步退出码行
        var block = findAgentCmdBlock(st, ev.call_id);
        if (!block) return;
        stopAgentToolTimers(block);
        var pre = block.querySelector('.agent-cmd-console-pre');
        if (!pre || block._exitShown) return;
        block._exitShown = true;
        var dur = ev.duration_ms || 0;
        var durText = dur >= 1000 ? (dur / 1000).toFixed(1) + ' 秒' : dur + ' 毫秒';
        var line = document.createElement('div');
        line.className = 'agent-cmd-console-exit' + (ev.exit_code ? ' fail' : '');
        line.textContent = '— 进程已退出 · 退出码 ' + (ev.exit_code || 0) + ' · 耗时 ' + durText +
            (ev.total_bytes ? ' · 输出 ' + Math.max(1, Math.round(ev.total_bytes / 102.4) / 10) + ' KB' : '');
        pre.parentNode.appendChild(line);
        pre.scrollTop = pre.scrollHeight;
    }

    // ===== 阶段七十五（增强）：TRAE CN 同款独立控制台抽屉 + "打开控制台"浮标 =====
    // 任务执行中命令开始跑/有输出时输入区上方浮现"打开控制台"浮标，点击展开底部独立控制台面板
    //（统一展示本任务全部命令输出流：> 命令头 + 实时输出 + 退出码标注），与任务卡内嵌控制台同源双写；
    // 抽屉会话级归属：切换会话/新任务自动清空重开
    // 阶段七十七：控制台多标签（Trae CN 同款）——tabs[0] 固定"任务输出"（Agent 命令输出流），
    // "+" 新建本地终端标签（手敲命令逐条执行，纯本地 IPC 环路不经服务端，仅 PC 客户端可用）
    var agentConsole = { root: null, body: null, cmdEl: null, chip: null, open: false, stick: true, taskId: null, agent: null, overTip: false,
        tabs: [], active: '__task__', seq: 0, tabsEl: null, inputWrap: null, promptEl: null, inputEl: null, stopBtn: null };

    function agentConsoleEnsure() {
        if (agentConsole.root) return true;
        // 停靠点（阶段九十二）：PC 优先浏览器面板底部停靠（Trae CN 同款——浏览区下方控制台抽屉；
        // #browser-panel 为 flex 纵排，抽屉排到内容区之下即"浏览区底部"，开合改变内容元素尺寸，
        // ResizeObserver 自动重报原生视图 bounds 无需额外同步）。窄屏（≤900px 工作区整体隐藏）
        // 或面板未就绪时回退：PC 旧布局回退工作区预览列下方，Web/手机回退输入框上方
        var host = null, before = null, chipHost = null, chipBefore = null;
        var wsReady = wsPanelEnsure() && wsPanel.colView;
        var narrow = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
        if (browserSupported() && browserPanelEl) {
            host = browserPanelEl; // 浏览区底部停靠（Trae CN 同款）
        } else if (wsReady && !narrow) {
            host = wsPanel.colView;
        } else {
            var inputBar = document.querySelector('.input-bar');
            if (!inputBar || !inputBar.parentNode) return false;
            host = inputBar.parentNode;
            before = inputBar;
        }
        // "打开控制台"浮标始终归属聊天区输入框上方（浏览区停靠时引导入口仍在聊天侧）
        chipHost = host; chipBefore = before;
        if (host === browserPanelEl) {
            var ib = document.querySelector('.input-bar');
            if (ib && ib.parentNode) { chipHost = ib.parentNode; chipBefore = ib; }
        }
        var root = document.createElement('div');
        root.className = 'agent-console-drawer hidden';
        // 头部：标签栏（任务输出 + 终端标签 + 新建）+ 当前 Agent 命令 + 清空/收起
        var head = document.createElement('div');
        head.className = 'agent-console-head';
        var tabsEl = document.createElement('div');
        tabsEl.className = 'agent-console-tabs';
        var cmd = document.createElement('span');
        cmd.className = 'agent-console-cmd';
        var clearBtn = document.createElement('button');
        clearBtn.className = 'agent-console-btn';
        clearBtn.type = 'button';
        clearBtn.textContent = '清空';
        clearBtn.addEventListener('click', function () {
            var t = agentConsoleTabActive();
            if (t) t.bodyEl.textContent = '';
        });
        var closeBtn = document.createElement('button');
        closeBtn.className = 'agent-console-btn';
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.title = '收起控制台';
        closeBtn.addEventListener('click', function () { agentConsoleToggle(false); });
        head.appendChild(tabsEl);
        head.appendChild(cmd);
        head.appendChild(clearBtn);
        head.appendChild(closeBtn);
        // 任务输出标签体（默认标签）：agentConsoleBegin/Output/Exit 同源双写目标不变
        var body = document.createElement('div');
        body.className = 'agent-console-body';
        body.addEventListener('scroll', function () {
            agentConsole.stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
        });
        if (window._osbInit) window._osbInit(body); // 自绘悬浮滑块（全局系统滚动条已禁用）
        // 终端输入行（仅终端标签显示）：提示符 + 命令输入 + 停止按钮
        var inputWrap = document.createElement('div');
        inputWrap.className = 'agent-console-inputrow hidden';
        var promptEl = document.createElement('span');
        promptEl.className = 'agent-console-prompt';
        var inputEl = document.createElement('input');
        inputEl.className = 'agent-console-input';
        inputEl.type = 'text';
        inputEl.spellcheck = false;
        inputEl.placeholder = '输入命令，回车执行（↑↓ 翻历史）';
        inputEl.addEventListener('keydown', agentConsoleTermKey);
        var stopBtn = document.createElement('button');
        stopBtn.className = 'agent-console-stop';
        stopBtn.type = 'button';
        stopBtn.textContent = '■';
        stopBtn.title = '停止当前命令';
        stopBtn.disabled = true;
        stopBtn.addEventListener('click', function () {
            var t = agentConsoleTabActive();
            if (!t || t.kind !== 'term' || !(window.desktop && window.desktop.termOp)) return;
            window.desktop.termOp({ username: IMSocket.getUsername() || '', action: 'stop', term_id: t.id });
        });
        inputWrap.appendChild(promptEl);
        inputWrap.appendChild(inputEl);
        inputWrap.appendChild(stopBtn);
        root.appendChild(head);
        root.appendChild(body);
        root.appendChild(inputWrap);
        host.insertBefore(root, before); // before=null 时等同 append（浏览区/中栏停靠：排到内容区之下）
        var chip = document.createElement('button');
        chip.className = 'agent-console-chip hidden';
        chip.type = 'button';
        chip.textContent = '▤ 打开控制台';
        chip.addEventListener('click', function () { agentConsoleToggle(true); });
        chipHost.insertBefore(chip, chipBefore); // 浮标固定聊天区输入框上方
        agentConsole.root = root;
        agentConsole.body = body;
        agentConsole.cmdEl = cmd;
        agentConsole.chip = chip;
        agentConsole.tabsEl = tabsEl;
        agentConsole.inputWrap = inputWrap;
        agentConsole.promptEl = promptEl;
        agentConsole.inputEl = inputEl;
        agentConsole.stopBtn = stopBtn;
        agentConsole.tabs = [{ id: '__task__', kind: 'task', name: '任务输出', bodyEl: body, fixed: true, running: false, cwd: '' }];
        agentConsole.active = '__task__';
        // 本地终端帧路由（执行器输出/退出帧 → 对应标签；仅 PC 端有此桥）
        if (window.desktop && window.desktop.onTermEvent) {
            window.desktop.onTermEvent(function (f) { agentConsoleTermFrame(f); });
        }
        agentConsoleRenderTabs();
        return true;
    }

    // 当前激活标签对象（兜底任务输出标签）
    function agentConsoleTabActive() {
        for (var i = 0; i < agentConsole.tabs.length; i++) {
            if (agentConsole.tabs[i].id === agentConsole.active) return agentConsole.tabs[i];
        }
        return agentConsole.tabs[0];
    }

    // 标签栏渲染：任务输出固定（不可关），终端标签可关（✕），末尾"+"新建终端
    function agentConsoleRenderTabs() {
        var bar = agentConsole.tabsEl;
        if (!bar) return;
        bar.textContent = '';
        agentConsole.tabs.forEach(function (t) {
            var el = document.createElement('div');
            el.className = 'agent-console-tab' + (t.id === agentConsole.active ? ' active' : '');
            var name = document.createElement('span');
            name.className = 'agent-console-tab-name';
            name.textContent = (t.kind === 'term' && t.running ? '⟳ ' : '') + t.name; // 运行中标记
            el.appendChild(name);
            if (t.kind === 'term') {
                var x = document.createElement('span');
                x.className = 'agent-console-tab-x';
                x.textContent = '✕';
                x.title = '关闭终端';
                x.addEventListener('click', function (e) { e.stopPropagation(); agentConsoleTermClose(t.id); });
                el.appendChild(x);
            }
            el.addEventListener('click', function () { agentConsoleSwitchTab(t.id); });
            bar.appendChild(el);
        });
        var add = document.createElement('button');
        add.className = 'agent-console-tab-add';
        add.type = 'button';
        add.textContent = '+';
        add.title = (window.desktop && window.desktop.termOp) ? '新建终端' : '新建终端（仅 PC 客户端支持本地执行）';
        add.addEventListener('click', agentConsoleTermCreate);
        bar.appendChild(add);
        // SSH 连接入口（仅 PC 端本地终端可用时显示）：快连弹窗 → 终端托管 ssh 会话
        if (window.desktop && window.desktop.termOp && window.desktop.sshList) {
            var sshBtn = document.createElement('button');
            sshBtn.className = 'agent-console-tab-add';
            sshBtn.type = 'button';
            sshBtn.textContent = 'SSH';
            sshBtn.style.width = 'auto';
            sshBtn.style.padding = '0 7px';
            sshBtn.style.fontSize = '10px';
            sshBtn.title = '连接远程主机（SSH）';
            sshBtn.addEventListener('click', agentConsoleSshDlg);
            bar.appendChild(sshBtn);
        }
    }

    // 切换标签：体显隐 + 输入行随终端标签显隐 + 提示符/停止按钮状态同步
    function agentConsoleSwitchTab(id) {
        agentConsole.active = id;
        agentConsole.tabs.forEach(function (t) { t.bodyEl.classList.toggle('hidden', t.id !== id); });
        var t = agentConsoleTabActive();
        var isTerm = !!(t && t.kind === 'term');
        agentConsole.inputWrap.classList.toggle('hidden', !isTerm);
        if (isTerm) {
            agentConsole.promptEl.textContent = (t.cwd || '') + '>';
            agentConsole.stopBtn.disabled = !t.running;
            if (agentConsole.open) setTimeout(function () { agentConsole.inputEl.focus(); }, 0);
        }
        agentConsoleRenderTabs();
    }

    // 新建终端标签：PC 端（有本地执行器桥）经 IPC 打开会话；浏览器端占位提示
    function agentConsoleTermCreate() {
        if (!agentConsoleEnsure()) return;
        var id = 'term' + (++agentConsole.seq) + '_' + (Date.now() % 100000);
        var bodyEl = document.createElement('div');
        bodyEl.className = 'agent-console-body hidden';
        var tab = { id: id, kind: 'term', name: '终端 ' + agentConsole.seq, bodyEl: bodyEl, cwd: '', running: false, hist: [], histIdx: -1, stick: true };
        bodyEl.addEventListener('scroll', function () {
            tab.stick = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 40;
        });
        if (window._osbInit) window._osbInit(bodyEl);
        agentConsole.root.insertBefore(bodyEl, agentConsole.inputWrap);
        agentConsole.tabs.push(tab);
        agentConsoleSwitchTab(id);
        if (!(window.desktop && window.desktop.termOp)) {
            agentConsoleTermAppend(tab, '✕ 本地终端仅 PC 客户端支持（浏览器端无本地执行能力）。\r\n');
            return;
        }
        window.desktop.termOp({ username: IMSocket.getUsername() || '', action: 'open', term_id: id }).then(function (res) {
            if (res && res.ok) {
                tab.cwd = String(res.cwd || '');
                agentConsoleTermAppend(tab, tab.cwd + '>\r\n');
                if (agentConsole.active === id) agentConsole.promptEl.textContent = tab.cwd + '>';
            } else {
                agentConsoleTermAppend(tab, '✕ ' + ((res && res.error) || '终端打开失败') + '\r\n');
            }
        }).catch(function () {
            agentConsoleTermAppend(tab, '✕ 终端打开失败（本地桥异常）。\r\n');
        });
    }

    // ===== SSH 远程主机连接（阶段八十一）：快连弹窗 → 终端托管 ssh 会话 =====
    // 快连簿存 PC 本地（host/port/user，无密码）；密码/密钥认证由 ssh 自身提示处理（远端 TTY 负责回显/关闭回显）
    function agentConsoleSshDlg() {
        var old = document.getElementById('ws-ssh-dlg');
        if (old) old.remove();
        var mask = document.createElement('div');
        mask.id = 'ws-ssh-dlg';
        mask.className = 'ws-proj-mask';
        var dlg = document.createElement('div');
        dlg.className = 'ws-proj-dlg';
        var ttl = document.createElement('div');
        ttl.className = 'ws-proj-dlg-t';
        ttl.textContent = '连接远程主机（SSH）';
        dlg.appendChild(ttl);
        var fields = [
            { key: 'host', label: '主机（IP 或域名）', ph: '如 192.168.1.10', type: 'text' },
            { key: 'port', label: '端口（默认 22）', ph: '22', type: 'text' },
            { key: 'user', label: '用户名（可留空）', ph: '如 root', type: 'text' }
        ];
        var inputs = {};
        var bookEl = null;
        fields.forEach(function (f, fi) {
            var lb = document.createElement('div');
            lb.className = 'ws-proj-dlg-l';
            lb.textContent = f.label;
            var inp = document.createElement('input');
            inp.className = 'ws-proj-dlg-i';
            inp.type = f.type;
            inp.placeholder = f.ph;
            inputs[f.key] = inp;
            dlg.appendChild(lb);
            dlg.appendChild(inp);
            if (fi === 0) {
                bookEl = document.createElement('div');
                bookEl.className = 'ws-proj-dlg-recents';
                dlg.appendChild(bookEl);
            }
        });
        var errEl = document.createElement('div');
        errEl.className = 'ws-proj-dlg-err hidden';
        dlg.appendChild(errEl);
        var btnRow = document.createElement('div');
        btnRow.className = 'ws-proj-dlg-btns';
        var cancel = document.createElement('button');
        cancel.className = 'ws-panel-btn';
        cancel.type = 'button';
        cancel.textContent = '取消';
        var ok = document.createElement('button');
        ok.className = 'ws-panel-btn primary';
        ok.type = 'button';
        ok.textContent = '连接';
        btnRow.appendChild(cancel);
        btnRow.appendChild(ok);
        dlg.appendChild(btnRow);
        mask.appendChild(dlg);
        document.body.appendChild(mask);

        var close = function () { mask.remove(); };
        cancel.addEventListener('click', close);
        mask.addEventListener('mousedown', function (ev) { if (ev.target === mask) close(); });
        inputs.host.focus();

        // 快连簿渲染（点击回填，双击直连，右侧 × 删除）
        window.desktop.sshList().then(function (res) {
            var list = (res && res.list) || [];
            if (!list.length || !bookEl) return;
            list.forEach(function (it) {
                var row = document.createElement('div');
                row.className = 'ws-proj-dlg-ri';
                var n = document.createElement('span');
                n.className = 'ws-proj-dlg-ri-n';
                n.textContent = it.name || (it.user ? it.user + '@' : '') + it.host;
                var u = document.createElement('span');
                u.className = 'ws-proj-dlg-ri-u';
                u.textContent = (it.user ? it.user + '@' : '') + it.host + (it.port && it.port !== 22 ? ':' + it.port : '');
                var del = document.createElement('span');
                del.textContent = '✕';
                del.style.cssText = 'color:#d1242f;cursor:pointer;flex-shrink:0;padding:0 2px;';
                del.title = '删除此快连';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    window.desktop.sshDel({ host: it.host, user: it.user || '', port: it.port || 22 }).then(function () { row.remove(); }).catch(function () {});
                });
                row.appendChild(n);
                row.appendChild(u);
                row.appendChild(del);
                row.addEventListener('click', function () {
                    inputs.host.value = it.host || '';
                    inputs.port.value = it.port && it.port !== 22 ? String(it.port) : '';
                    inputs.user.value = it.user || '';
                    inputs.host.focus();
                });
                row.addEventListener('dblclick', function () { conn(it); });
                bookEl.appendChild(row);
            });
        }).catch(function () {});

        function conn(it) {
            close();
            agentConsoleTermCreateSsh(it.host, it.port || 22, it.user || '');
        }

        ok.addEventListener('click', function () {
            var host = inputs.host.value.trim();
            var port = parseInt(inputs.port.value, 10) || 22;
            var user = inputs.user.value.trim();
            if (!host) {
                errEl.textContent = '主机不能为空';
                errEl.classList.remove('hidden');
                return;
            }
            if (inputs.port.value.trim() && (!/^\d+$/.test(inputs.port.value.trim()) || port < 1 || port > 65535)) {
                errEl.textContent = '端口需为 1-65535 的数字';
                errEl.classList.remove('hidden');
                return;
            }
            if (window.desktop.sshSave) {
                window.desktop.sshSave({ host: host, port: port, user: user, name: '' }).catch(function () {});
            }
            close();
            agentConsoleTermCreateSsh(host, port, user);
        });
    }

    // 新建 SSH 终端标签：term_id 独立命名空间（ssh 前缀），提示符=user@host，输入经执行器直写远端 stdin
    function agentConsoleTermCreateSsh(host, port, user) {
        if (!agentConsoleEnsure()) return;
        var id = 'ssh' + (++agentConsole.seq) + '_' + (Date.now() % 100000);
        var bodyEl = document.createElement('div');
        bodyEl.className = 'agent-console-body hidden';
        var label = (user ? user + '@' : '') + host;
        var tab = { id: id, kind: 'term', ssh: true, name: label, bodyEl: bodyEl, cwd: label, running: false, hist: [], histIdx: -1, stick: true };
        bodyEl.addEventListener('scroll', function () {
            tab.stick = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 40;
        });
        if (window._osbInit) window._osbInit(bodyEl);
        agentConsole.root.insertBefore(bodyEl, agentConsole.inputWrap);
        agentConsole.tabs.push(tab);
        agentConsoleSwitchTab(id);
        agentConsoleTermAppend(tab, '正在连接 ' + label + (port !== 22 ? ':' + port : '') + '…（首次连接自动接受主机指纹；密码/密钥口令在远端提示后输入）\r\n');
        window.desktop.termOp({ username: IMSocket.getUsername() || '', action: 'ssh', term_id: id, host: host, port: port, user: user }).then(function (res) {
            if (!res || res.ok !== true) {
                agentConsoleTermAppend(tab, '✕ ' + ((res && res.error) || 'SSH 连接失败') + '\r\n');
            }
        }).catch(function () {
            agentConsoleTermAppend(tab, '✕ SSH 连接失败（本地桥异常）。\r\n');
        });
    }

    // 关闭终端标签：通知执行器销毁会话（运行中命令一并 kill），激活相邻标签
    function agentConsoleTermClose(id) {
        var idx = -1;
        for (var i = 0; i < agentConsole.tabs.length; i++) {
            if (agentConsole.tabs[i].id === id) { idx = i; break; }
        }
        if (idx < 0) return;
        var tab = agentConsole.tabs[idx];
        if (tab.kind === 'term' && window.desktop && window.desktop.termOp) {
            window.desktop.termOp({ username: IMSocket.getUsername() || '', action: 'close', term_id: id });
        }
        tab.bodyEl.remove();
        agentConsole.tabs.splice(idx, 1);
        if (agentConsole.active === id) {
            var next = agentConsole.tabs[Math.min(idx, agentConsole.tabs.length - 1)];
            agentConsoleSwitchTab(next ? next.id : '__task__');
        } else {
            agentConsoleRenderTabs();
        }
    }

    // 终端输出追加（底部跟随：上翻查历史时暂停自动滚动；展示上限保留尾部 100KB）
    function agentConsoleTermAppend(tab, text) {
        if (!tab || !text) return;
        var el = tab.bodyEl;
        var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
        el.appendChild(document.createTextNode(text));
        if (el.textContent.length > 130000) el.textContent = el.textContent.slice(-100000);
        if (stick) el.scrollTop = el.scrollHeight;
    }

    // 执行器帧路由：out→追加输出；exit→退出码/耗时行 + cwd 更新 + 解除运行态
    function agentConsoleTermFrame(f) {
        if (!f || !f.term_id) return;
        var tab = null;
        for (var i = 0; i < agentConsole.tabs.length; i++) {
            if (agentConsole.tabs[i].id === f.term_id) { tab = agentConsole.tabs[i]; break; }
        }
        if (!tab || tab.kind !== 'term') return;
        if (f.type === 'out') {
            agentConsoleTermAppend(tab, String(f.chunk || ''));
            return;
        }
        if (f.type === 'exit') {
            tab.running = false;
            var dur = f.duration_ms || 0;
            var durText = dur >= 1000 ? (dur / 1000).toFixed(1) + ' 秒' : dur + ' 毫秒';
            if (f.ssh) { // SSH 会话退出（exit 命令/连接断开）：区分文案，提示符恢复就绪态
                agentConsoleTermAppend(tab, 'SSH 连接已关闭' + (f.exit_code ? '（退出码 ' + f.exit_code + '）' : '') + '\r\n');
            } else {
                agentConsoleTermAppend(tab, '进程已结束，退出码 ' + (f.exit_code || 0) + '，耗时 ' + durText + (f.over ? '（输出超限已截断）' : '') + '\r\n');
            }
            tab.cwd = String(f.cwd || tab.cwd || '');
            if (agentConsole.active === tab.id) {
                agentConsole.promptEl.textContent = tab.cwd + '>';
                agentConsole.stopBtn.disabled = true;
            }
        }
    }

    // 终端输入：回车执行（运行中拒绝，执行器同步受理），↑↓ 翻本标签命令历史
    function agentConsoleTermKey(e) {
        var tab = agentConsoleTabActive();
        if (!tab || tab.kind !== 'term') return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (!tab.hist.length) return;
            if (e.key === 'ArrowUp') {
                tab.histIdx = tab.histIdx < 0 ? tab.hist.length - 1 : Math.max(0, tab.histIdx - 1);
                agentConsole.inputEl.value = tab.hist[tab.histIdx] || '';
            } else {
                if (tab.histIdx < 0) return;
                tab.histIdx++;
                if (tab.histIdx >= tab.hist.length) { tab.histIdx = -1; agentConsole.inputEl.value = ''; }
                else agentConsole.inputEl.value = tab.hist[tab.histIdx];
            }
            return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var cmd = agentConsole.inputEl.value.replace(/\s+$/, '');
        if (!cmd || tab.running) return;
        if (!(window.desktop && window.desktop.termOp)) {
            agentConsoleTermAppend(tab, '✕ 本地终端仅 PC 客户端支持。\r\n');
            return;
        }
        tab.hist.push(cmd);
        if (tab.hist.length > 50) tab.hist.shift();
        tab.histIdx = -1;
        agentConsole.inputEl.value = '';
        tab.running = true;
        agentConsole.stopBtn.disabled = false;
        window.desktop.termOp({ username: IMSocket.getUsername() || '', action: 'input', term_id: tab.id, cmd: cmd }).then(function (res) {
            if (res && res.ok === false) { // 执行器拒绝（上一条未结束/会话失效）
                tab.running = false;
                agentConsole.stopBtn.disabled = true;
                agentConsoleTermAppend(tab, '✕ ' + ((res && res.error) || '命令被拒绝') + '\r\n');
            } else if (res && (res.sync || res.cwd)) { // cd/切盘等本地记账命令：无 exit 帧，这里同步解除运行态并更新提示符
                // 兼容判断：新执行器返回 sync 标记；旧执行器（未重启主进程）cd 也只带 cwd 回来——
                // 两条路径都无 exit 帧，若不在此解除运行态，tab.running 永久卡死后续命令全部被吞
                tab.running = false;
                agentConsole.stopBtn.disabled = true;
                if (res.cwd) {
                    tab.cwd = String(res.cwd);
                    if (agentConsole.active === tab.id) agentConsole.promptEl.textContent = tab.cwd + '>';
                }
            }
        }).catch(function () {
            tab.running = false;
            agentConsole.stopBtn.disabled = true;
            agentConsoleTermAppend(tab, '✕ 命令执行异常（本地桥）。\r\n');
        });
    }

    function agentConsoleToggle(open) {
        if (!agentConsole.root) return;
        agentConsole.open = open;
        agentConsole.root.classList.toggle('hidden', !open);
        if (agentConsole.chip) agentConsole.chip.classList.add('hidden'); // 打开即收浮标；关闭后下方输出事件会再浮出
        // "⋯"菜单里的控制台项同步：开=高亮"收起控制台"，关="打开控制台"（图标不动，仅文字切换）
        if (wsPanel.conItem) {
            var conTxt = wsPanel.conItem.querySelector('.ws-more-txt');
            if (conTxt) conTxt.textContent = open ? '收起控制台' : '打开控制台';
            wsPanel.conItem.classList.toggle('active', open);
        }
        if (open) {
            var t = agentConsoleTabActive();
            if (t && t.kind === 'term' && t.stick) t.bodyEl.scrollTop = t.bodyEl.scrollHeight;
            if (agentConsole.stick) agentConsole.body.scrollTop = agentConsole.body.scrollHeight;
            // 浏览区底部停靠模式：面板隐藏时随控制台一并唤起（Trae 同款，点"打开控制台"带出浏览区）；
            // 收起不动面板（关控制台≠关浏览区）
            if (browserSupported() && browserPanelEl && browserPanelEl.contains(agentConsole.root) &&
                browserPanelEl.classList.contains('hidden') &&
                window.desktop && typeof window.desktop.browserPanel === 'function') {
                window.desktop.browserPanel(true);
            }
        }
        wsPanelSyncViewCol(); // 回退停靠（中栏）时保底逻辑；浏览区停靠模式下对中栏为无操作
    }

    // 新命令开始（run_command tool_start）：换任务清空重开、写命令头、浮标提示
    function agentConsoleBegin(st, ev) {
        if (!agentConsoleEnsure()) return;
        if (agentConsole.agent !== st.agent || agentConsole.taskId !== st.taskId) {
            agentConsole.body.textContent = '';
            agentConsole.overTip = false;
            agentConsole.agent = st.agent;
            agentConsole.taskId = st.taskId;
        }
        agentConsole.cmdEl.textContent = (ev.params && ev.params.command) || '';
        agentConsole.cmdEl.title = agentConsole.cmdEl.textContent;
        var line = document.createElement('div');
        line.className = 'agent-console-line-cmd';
        line.textContent = '> ' + ((ev.params && ev.params.command) || '');
        agentConsole.body.appendChild(line);
        agentConsoleShowHint();
        if (agentConsole.stick) agentConsole.body.scrollTop = agentConsole.body.scrollHeight;
    }

    // 实时输出帧 → 抽屉追加（与任务卡内嵌控制台同源双写）
    function agentConsoleOutput(st, ev) {
        if (!agentConsole.root || !agentConsole.taskId || agentConsole.taskId !== st.taskId) return;
        if (ev.chunk) {
            agentConsole.body.appendChild(document.createTextNode(ev.chunk));
            // 展示环上限：仅保留尾部（完整输出以任务卡与服务端留档为准）
            if (agentConsole.body.textContent.length > 100000) {
                while (agentConsole.body.textContent.length > 80000 && agentConsole.body.firstChild) {
                    agentConsole.body.removeChild(agentConsole.body.firstChild);
                }
            }
        }
        if (ev.over && !agentConsole.overTip) {
            agentConsole.overTip = true;
            agentConsole.body.appendChild(document.createTextNode('\n…（输出已达实时展示上限，后续增量不再下发）\n'));
        }
        agentConsoleShowHint();
        if (agentConsole.stick) agentConsole.body.scrollTop = agentConsole.body.scrollHeight;
    }

    // 进程结束 → 抽屉追加退出码标注行
    function agentConsoleExit(st, ev) {
        if (!agentConsole.root || !agentConsole.taskId || agentConsole.taskId !== st.taskId) return;
        var dur = ev.duration_ms || 0;
        var durText = dur >= 1000 ? (dur / 1000).toFixed(1) + ' 秒' : dur + ' 毫秒';
        var line = document.createElement('div');
        line.className = 'agent-console-line-exit' + (ev.exit_code ? ' fail' : '');
        line.textContent = '— 进程已退出 · 退出码 ' + (ev.exit_code || 0) + ' · 耗时 ' + durText +
            (ev.total_bytes ? ' · 输出 ' + Math.max(1, Math.round(ev.total_bytes / 102.4) / 10) + ' KB' : '');
        agentConsole.body.appendChild(line);
        if (agentConsole.stick) agentConsole.body.scrollTop = agentConsole.body.scrollHeight;
    }

    // 浮标提示：抽屉收起时命令有动静即浮现（TRAE 同款"打开控制台"入口）
    function agentConsoleShowHint() {
        if (!agentConsole.open && agentConsole.chip) {
            agentConsole.chip.classList.remove('hidden');
            wsPanelSyncViewCol(); // 浮标停靠预览下方：浮现时中栏可能全隐（无标签），须联动显示
        }
    }

    // 任务完结收浮标（抽屉保留日志，用户手动关闭）
    function agentConsoleTaskEnd() {
        if (agentConsole.chip) {
            agentConsole.chip.classList.add('hidden');
            wsPanelSyncViewCol(); // 浮标收起后中栏可能全隐（无标签且抽屉收起），联动收回
        }
    }

    // 切换会话复位：抽屉收起清空、浮标隐藏（控制台会话级归属，不跨会话串日志）
    function agentConsoleReset() {
        if (!agentConsole.root) return;
        agentConsoleToggle(false);
        agentConsole.body.textContent = '';
        agentConsole.taskId = null;
        agentConsole.agent = null;
    }

    // ===== 阶段七十六：Agent 工作区文件面板（Trae CN 同款）=====
    // Agent 模式开启时聊天区右侧显示工作区文件树（目录懒加载展开），点击文件高亮预览源码
    //（highlight.js 本地库，cpp/go/js/py 等常用语言），可切编辑模式手动修改保存回磁盘；
    // write_file/edit_file 工具执行后自动刷新树、打"新/改"角标并自动打开该文件。
    // 文件操作经服务端归口（msg 62/63）：PC 在线落到用户本地磁盘（沙箱白名单校验），离线回退服务端工作区。
    var wsPanel = {
        aside: null, treeEl: null, viewEl: null, viewBody: null, viewName: null, rootEl: null,
        btnEdit: null, btnSave: null, btnCancel: null, ta: null,
        visible: false, root: '', reqSeq: 0, pending: {},
        // 项目体系（TRAE「打开文件夹/克隆 Git 仓库/最近」同款）：proj=当前项目名（''=工作区根），projList=项目缓存
        proj: '', projList: [], projLoaded: false,
        expanded: {},  // 目录路径 → true（刷新后保持展开）
        dirRows: {},   // 目录路径 → { arrow, kids }
        fileRows: {},  // 文件路径 → 行元素（角标定位）
        badges: {},    // 文件路径 → 'new' | 'mod'
        // 工具名 → 最近一次 tool_start 的写入路径：tool_result 事件不带 params（服务端只回 tool/ok/output），
        // 结果到达时按工具名取回路径刷新已开标签（与 fillAgentTool 按工具名匹配最后一个 pending 块同一语义）
        lastToolPath: {},
        curPath: null, curContent: '', editing: false,
        // 阶段七十六增强（Trae CN 同款标签页）：多文件同时打开、点标签切换、× 关闭；
        // tabs: path → {name,content,binary,truncated,isMd,error,loading,draft?}，draft=未保存编辑草稿（切标签保留）
        tabs: {}, tabOrder: [], activeTab: null,
        // 跨文件符号表：path → wsScanDefs 结果（打开文件时缓存 + 后台扫同目录源码文件），悬停提示跨文件命中
        symTab: {}, symBusy: {}, pendingGoto: null, codeView: null,
        // 源代码管理（Trae CN 同款）：mode=git 视图显示中；busy=git 操作进行中（防并发点击）
        // repo=false=尚非 git 仓库（引导初始化）；staged/changes= porcelain XY 解析结果
        // amend=修改上次提交模式；log=提交历史缓存（null=加载中）；logHasMore=log 还有下一页（滚动到底自动加载）
        // branches=本地分支缓存（审查目标选择）
        // reviewTarget=审查目标分支；reviewBusy=审查进行中；lastReviewKey=上次报告标签键（查看上次报告）
        // reviewCollapsed/logCollapsed=审查/提交历史折叠态；reviewH/logH=审查/历史各自固定高度（独立拖拽条调整，localStorage 持久化）
        git: {
            mode: false, loaded: false, busy: false, repo: true, branch: '', upstream: '', ahead: 0, behind: 0,
            staged: [], changes: [], amend: false, log: null, logBusy: false, logHasMore: false, logOpen: {},
            branches: null, reviewTarget: '', reviewBusy: false, lastReviewKey: '',
            untrackedCache: null, // 未跟踪文件清单 TTL 缓存 {t, list}：文件预览"新文件整绿"判断用，防频繁全量拉取
            reviewCollapsed: false, logCollapsed: false, reviewH: 150, logH: 220
        },
        gitEl: null, gitBody: null, gitMsg: null, gitCommitBtn: null, headEl: null
    };

    // 扩展名 → highlight.js 语言映射（覆盖常见源码/配置；未命中走纯文本）
    var WS_LANG_MAP = {
        go: 'go', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'typescript', tsx: 'typescript', py: 'python', c: 'c', h: 'c',
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', java: 'java', cs: 'csharp',
        rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
        sh: 'bash', bash: 'bash', bat: 'batch', cmd: 'batch', ps1: 'powershell',
        json: 'json', xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
        md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', ini: 'ini', toml: 'toml',
        lua: 'lua', vue: 'xml', dart: 'dart', r: 'r', pl: 'perl', m: 'objectivec'
    };

    // 扩展名 → 文件类型图标（Trae CN 同款彩色语言徽标）：bg=品牌底色 label=徽标字母 fg=深色字（黄底等浅背景用）
    // 特殊类型（图片/音视频/压缩/可执行）用 emoji 更直观；未命中回退 📄
    var WS_ICON_MAP = {
        go:    { bg: '#00ADD8', label: 'GO' },
        js:    { bg: '#F7DF1E', label: 'JS', fg: '#323330' },
        mjs:   { bg: '#F7DF1E', label: 'JS', fg: '#323330' },
        cjs:   { bg: '#F7DF1E', label: 'JS', fg: '#323330' },
        ts:    { bg: '#3178C6', label: 'TS' },
        tsx:   { bg: '#3178C6', label: 'TS' },
        jsx:   { bg: '#61DAFB', label: 'JX', fg: '#20232a' },
        py:    { bg: '#3776AB', label: 'PY' },
        java:  { bg: '#EA2D2E', label: 'JV' },
        c:     { bg: '#5C6BC0', label: 'C' },
        h:     { bg: '#5C6BC0', label: 'H' },
        cpp:   { bg: '#00599C', label: 'C++' },
        hpp:   { bg: '#00599C', label: 'H+' },
        cc:    { bg: '#00599C', label: 'C++' },
        cs:    { bg: '#68217A', label: 'C#' },
        rs:    { bg: '#DEA584', label: 'RS', fg: '#4a2b1d' },
        php:   { bg: '#777BB4', label: 'PHP' },
        rb:    { bg: '#CC342D', label: 'RB' },
        swift: { bg: '#F05138', label: 'SW' },
        kt:    { bg: '#7F52FF', label: 'KT' },
        dart:  { bg: '#0175C2', label: 'DA' },
        vue:   { bg: '#42B883', label: 'V' },
        html:  { bg: '#E34F26', label: '<>' },
        htm:   { bg: '#E34F26', label: '<>' },
        css:   { bg: '#1572B6', label: 'CS' },
        scss:  { bg: '#CC6699', label: 'SC' },
        less:  { bg: '#2B5E91', label: 'LE' },
        json:  { bg: '#E8E4B8', label: '{}', fg: '#5a5510' },
        xml:   { bg: '#0060AC', label: 'XM' },
        yml:   { bg: '#cb171e', label: 'Y' },
        yaml:  { bg: '#cb171e', label: 'Y' },
        md:    { bg: '#519ABA', label: 'MD' },
        markdown: { bg: '#519ABA', label: 'MD' },
        sql:   { bg: '#DD6B20', label: 'SQ' },
        sh:    { bg: '#89e051', label: 'SH', fg: '#283c1a' },
        bat:   { bg: '#C1F12E', label: 'BT', fg: '#3d4a12' },
        cmd:   { bg: '#C1F12E', label: 'BT', fg: '#3d4a12' },
        ps1:   { bg: '#5391FE', label: 'PS' },
        lua:   { bg: '#4B62C6', label: 'LU' },
        ini:   { bg: '#9AA0A6', label: 'IN' },
        toml:  { bg: '#9AA0A6', label: 'TM' },
        pdf:   { bg: '#B30B00', label: 'PD' },
        docx:  { bg: '#2B579A', label: 'W' },
        docm:  { bg: '#2B579A', label: 'W' },
        doc:   { bg: '#2B579A', label: 'W' },
        xlsx:  { bg: '#217346', label: 'X' },
        pptx:  { bg: '#D24726', label: 'P' },
        // 特殊类型 emoji（缩略图形义直观看图即知）
        png: { emoji: '🖼' }, jpg: { emoji: '🖼' }, jpeg: { emoji: '🖼' }, gif: { emoji: '🖼' },
        webp: { emoji: '🖼' }, bmp: { emoji: '🖼' }, svg: { emoji: '🖼' }, ico: { emoji: '🖼' },
        mp3: { emoji: '🎵' }, wav: { emoji: '🎵' }, flac: { emoji: '🎵' }, ogg: { emoji: '🎵' },
        mp4: { emoji: '🎬' }, avi: { emoji: '🎬' }, mkv: { emoji: '🎬' }, mov: { emoji: '🎬' },
        zip: { emoji: '📦' }, rar: { emoji: '📦' }, '7z': { emoji: '📦' }, tar: { emoji: '📦' }, gz: { emoji: '📦' },
        exe: { emoji: '⚙️' }, dll: { emoji: '⚙️' }, msi: { emoji: '⚙️' }, apk: { emoji: '🤖' },
        woff: { emoji: '🅰' }, ttf: { emoji: '🅰' }, otf: { emoji: '🅰' }
    };

    // 生成文件类型图标元素（目录=文件夹；命中映射出彩色徽标/emoji；未识别=普通文件）
    function wsMakeFileIcon(en) {
        var el = document.createElement('span');
        el.className = 'ws-row-icon';
        if (en.dir) {
            el.textContent = '📁';
            return el;
        }
        var ext = (en.name.replace(/^.*\./, '') || '').toLowerCase();
        var ic = WS_ICON_MAP[ext];
        if (!ic) {
            el.textContent = '📄';
            return el;
        }
        if (ic.emoji) {
            el.textContent = ic.emoji;
            return el;
        }
        el.className = 'ws-row-icon ws-file-icon';
        el.style.background = ic.bg;
        el.textContent = ic.label;
        if (ic.fg) el.style.color = ic.fg;
        el.title = ext.toUpperCase();
        return el;
    }

    function wsPanelEnsure() {
        if (wsPanel.aside) return true;
        var view = document.querySelector('.chat-view');
        if (!view) return false;
        var aside = document.createElement('aside');
        aside.id = 'ws-panel';
        aside.className = 'ws-panel hidden';
        // 三栏布局（Trae CN 同款）：工作区树(左) | 拖拽条 | 预览(中)，聊天主体排右侧；
        // 两栏宽度经 CSS 变量注入，拖拽分隔条调整并 localStorage 持久化
        try {
            var tw = parseInt(localStorage.getItem('ws_tree_w'), 10);
            var vw = parseInt(localStorage.getItem('ws_view_w'), 10);
            if (tw >= 160 && tw <= 480) aside.style.setProperty('--ws-tree-w', tw + 'px');
            if (vw >= 240 && vw <= 760) aside.style.setProperty('--ws-view-w', vw + 'px');
        } catch (e) {}
        // 左分栏：工作区树
        var colTree = document.createElement('div');
        colTree.className = 'ws-col-tree';
        // 头部：标题 + 工作区根路径回显 + 刷新
        var head = document.createElement('div');
        head.className = 'ws-panel-head';
        var title = document.createElement('span');
        title.className = 'ws-panel-title';
        title.textContent = '工作区';
        wsPanel.rootEl = document.createElement('span');
        wsPanel.rootEl.className = 'ws-panel-root';
        var refreshBtn = document.createElement('button');
        refreshBtn.className = 'ws-panel-btn ws-refresh-btn';
        refreshBtn.type = 'button';
        refreshBtn.innerHTML = wsGitIco('refresh'); // TRAE CN 同款 codicon 刷新图标（与源代码管理头部统一）
        refreshBtn.title = '重新加载文件树';
        refreshBtn.addEventListener('click', function () { wsPanelRefreshTree(); });
        // 头部"更多操作"（⋯）下拉菜单（阶段七十七，自绘浮层不用系统弹窗）：低频操作统一收纳，
        // 以后新按钮直接往 wsMoreItems 里加一项即可，不再撑爆头部
        var moreWrap = document.createElement('div');
        moreWrap.className = 'ws-more';
        var moreBtn = document.createElement('button');
        moreBtn.className = 'ws-panel-btn ws-more-btn';
        moreBtn.type = 'button';
        moreBtn.textContent = '···';
        moreBtn.title = '更多操作';
        var menu = document.createElement('div');
        menu.className = 'ws-more-menu hidden';
        var conItem = document.createElement('div');
        conItem.className = 'ws-more-item';
        // 图标 + 文字（后续新菜单项照此结构：span.ws-more-ico 图标 + span.ws-more-txt 文字）
        var conIco = document.createElement('span');
        conIco.className = 'ws-more-ico';
        conIco.textContent = '▤';
        var conTxt = document.createElement('span');
        conTxt.className = 'ws-more-txt';
        conTxt.textContent = '打开控制台';
        conItem.appendChild(conIco);
        conItem.appendChild(conTxt);
        conItem.addEventListener('click', function () {
            agentConsoleEnsure();
            agentConsoleToggle(!agentConsole.open); // 常驻入口：随时展开/收起底部控制台
            wsPanelMenuClose();
        });
        menu.appendChild(conItem);
        moreWrap.appendChild(moreBtn);
        moreWrap.appendChild(menu);
        moreBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            menu.classList.toggle('hidden');
            moreBtn.classList.toggle('active', !menu.classList.contains('hidden'));
        });
        // 点外部收起（捕获一次注册，含 Esc）；stopPropagation 防点按钮自身立即关闭
        document.addEventListener('click', function (e) {
            if (!moreWrap.contains(e.target)) wsPanelMenuClose();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') wsPanelMenuClose();
        });
        head.appendChild(title);
        head.appendChild(wsPanel.rootEl);
        // 项目切换（TRAE「打开文件夹/克隆仓库」同款入口）：▾ 弹层 = 克隆 Git 仓库 + 项目列表（最近优先）
        var projBtn = document.createElement('button');
        projBtn.className = 'ws-panel-btn ws-proj-btn';
        projBtn.type = 'button';
        projBtn.textContent = '▾';
        projBtn.title = '切换项目 / 克隆 Git 仓库';
        projBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            wsPanelProjMenu(projBtn);
        });
        head.appendChild(projBtn);
        head.appendChild(refreshBtn);
        head.appendChild(moreWrap);
        wsPanel.moreBtn = moreBtn;
        wsPanel.moreMenu = menu;
        wsPanel.conItem = conItem;
        // 文件树（懒加载：展开目录时才拉取子级）
        wsPanel.treeEl = document.createElement('div');
        wsPanel.treeEl.className = 'ws-panel-tree';
        wsPanel.headEl = head;
        // 顶部视图页签（Trae CN 同款）：文件树 / 源代码管理 互相切换（git 视图不销毁树状态）
        var nav = document.createElement('div');
        nav.className = 'ws-nav-tabs';
        var navFile = document.createElement('div');
        navFile.className = 'ws-nav-tab active';
        navFile.textContent = '文件';
        var navGit = document.createElement('div');
        navGit.className = 'ws-nav-tab';
        navGit.textContent = '源代码管理';
        nav.appendChild(navFile);
        nav.appendChild(navGit);
        navFile.addEventListener('click', function () { wsPanelGitSetMode(false); });
        navGit.addEventListener('click', function () { wsPanelGitSetMode(true); });
        // git 视图（静态骨架一次建好，数据渲染由 wsPanelGitRender 重建内部）
        var gitEl = document.createElement('div');
        gitEl.className = 'ws-git-view hidden';
        wsPanel.gitEl = gitEl;
        colTree.appendChild(nav);
        colTree.appendChild(head);
        colTree.appendChild(wsPanel.treeEl);
        colTree.appendChild(gitEl);
        // 右键菜单挂 body（fixed 贴光标，不受面板 overflow 裁剪）；树空白区右键出根级菜单（新建/刷新）
        if (!wsPanel.ctxMenu) {
            wsPanel.ctxMenu = document.createElement('div');
            wsPanel.ctxMenu.className = 'ws-more-menu ws-ctx-menu hidden';
            document.body.appendChild(wsPanel.ctxMenu);
            document.addEventListener('click', wsPanelCtxClose);
        }
        wsPanel.treeEl.addEventListener('contextmenu', function (e) {
            if (e.target.closest('.ws-row')) return; // 行内右键由行处理器负责（已 stopPropagation，此处兜底）
            e.preventDefault();
            wsPanelShowCtx(e, '', true);
        });
        // 左分隔条：拖拽调整树宽（贴树分栏右缘的悬浮热区，hover 显主题色竖线）
        var splitL = document.createElement('div');
        splitL.className = 'ws-splitter';
        splitL.title = '拖拽调整宽度';
        colTree.appendChild(splitL);
        // 中分栏：文件预览/编辑（Trae CN 同款标签页 + 内容区，多文件并存切换）
        wsPanel.viewEl = document.createElement('div');
        wsPanel.viewEl.className = 'ws-view hidden';
        // 中栏包装容器（Trae CN 同款）：预览(上) + 控制台抽屉(下) 纵向停靠；宽度变量/显隐归此容器，
        // 预览与控制台各自独立显隐（有标签或控制台展开任一即显示整栏，见 wsPanelSyncViewCol）
        wsPanel.colView = document.createElement('div');
        wsPanel.colView.className = 'ws-col-view hidden';
        var viewHead = document.createElement('div');
        viewHead.className = 'ws-view-head';
        wsPanel.tabBarEl = document.createElement('div');
        wsPanel.tabBarEl.className = 'ws-tab-bar';
        if (window._osbInitH) window._osbInitH(wsPanel.tabBarEl); // 多标签横向自绘滑块（悬停浮现可拖拽，Trae CN 同款）
        wsPanel.btnEdit = document.createElement('button');
        wsPanel.btnEdit.className = 'ws-panel-btn';
        wsPanel.btnEdit.type = 'button';
        wsPanel.btnEdit.textContent = '编辑';
        wsPanel.btnEdit.addEventListener('click', wsPanelStartEdit);
        wsPanel.btnSave = document.createElement('button');
        wsPanel.btnSave.className = 'ws-panel-btn primary';
        wsPanel.btnSave.type = 'button';
        wsPanel.btnSave.textContent = '保存';
        wsPanel.btnSave.addEventListener('click', wsPanelSave);
        wsPanel.btnCancel = document.createElement('button');
        wsPanel.btnCancel.className = 'ws-panel-btn';
        wsPanel.btnCancel.type = 'button';
        wsPanel.btnCancel.textContent = '取消';
        wsPanel.btnCancel.addEventListener('click', function () { if (wsPanel.activeTab) wsPanelOpen(wsPanel.activeTab, true); });
        var btnClose = document.createElement('button');
        btnClose.className = 'ws-panel-btn';
        btnClose.type = 'button';
        btnClose.textContent = '×';
        btnClose.title = '关闭当前标签';
        btnClose.addEventListener('click', function () { if (wsPanel.activeTab) wsPanelCloseTab(wsPanel.activeTab); });
        viewHead.appendChild(wsPanel.tabBarEl);
        viewHead.appendChild(wsPanel.btnEdit);
        viewHead.appendChild(wsPanel.btnSave);
        viewHead.appendChild(wsPanel.btnCancel);
        viewHead.appendChild(btnClose);
        wsPanel.viewBody = document.createElement('div');
        wsPanel.viewBody.className = 'ws-view-body';
        // 面包屑路径条（Trae CN 同款）：固定在标签栏下方显示当前文件完整路径，不随内容滚动
        wsPanel.crumbsEl = document.createElement('div');
        wsPanel.crumbsEl.className = 'ws-crumbs';
        wsPanel.viewEl.appendChild(viewHead);
        wsPanel.viewEl.appendChild(wsPanel.crumbsEl);
        wsPanel.viewEl.appendChild(wsPanel.viewBody);
        // 右分隔条：拖拽调整预览宽（贴中栏右缘，罩全栏高度；中栏显隐由 wsPanelSyncViewCol 统一同步）
        var splitR = document.createElement('div');
        splitR.className = 'ws-splitter';
        splitR.title = '拖拽调整宽度';
        wsPanel.colView.appendChild(splitR);
        wsPanel.colView.appendChild(wsPanel.viewEl);
        // 阶段七十六：文件树与预览区挂自绘悬浮滑块（全局系统滚动条已禁用，动态容器须显式注册）
        if (window._osbInit) { window._osbInit(wsPanel.treeEl); window._osbInit(wsPanel.viewBody); }
        aside.appendChild(colTree);
        aside.appendChild(wsPanel.colView);
        // 面板插到聊天主体之前（工作区左、预览中、聊天右）
        var mainChat = view.querySelector('.main-chat');
        if (mainChat) view.insertBefore(aside, mainChat); else view.appendChild(aside);
        wsPanel.aside = aside;
        syncListToggleAnchor(); // 创建即锚定：面板显示时列表折叠按钮搬入面板贴左缘外沿（=列表右缘）
        // 水平拖拽调宽（与聊天输入框高度拖拽同款交互：mousedown→mousemove→mouseup，持久化）
        function wsBindSplitter(sp, col, cssVar, minW, maxW, storeKey) {
            sp.addEventListener('mousedown', function (e) {
                e.preventDefault();
                sp.classList.add('dragging');
                document.body.style.userSelect = 'none'; // 拖拽期间禁用文本选择
                var startX = e.clientX;
                var startW = col.getBoundingClientRect().width;
                function onMove(ev) {
                    // 拖拽边界跟随鼠标：右移 dx>0 加宽（两栏一致，往哪拖边界往哪走）
                    var w = Math.min(Math.max(startW + (ev.clientX - startX), minW), maxW);
                    aside.style.setProperty(cssVar, Math.round(w) + 'px');
                }
                function onUp() {
                    sp.classList.remove('dragging');
                    document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    try { localStorage.setItem(storeKey, String(Math.round(col.getBoundingClientRect().width))); } catch (err) {}
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
        wsBindSplitter(splitL, colTree, '--ws-tree-w', 160, 480, 'ws_tree_w');
        wsBindSplitter(splitR, wsPanel.colView, '--ws-view-w', 240, 760, 'ws_view_w');
        // 响应归路：服务端 63 帧按 req_id 投递；type=progress 为克隆进度中间帧（同 req_id 多帧，不结束 Promise）
        IMSocket.on(MSG.WS_FILE_RESP, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (ev.type === 'progress') {
                if (wsPanel.onCloneProgress) { try { wsPanel.onCloneProgress(ev); } catch (err) {} }
                return;
            }
            if (window.desktop && window.desktop.fileopTrace) window.desktop.fileopTrace({ phase: 'recv63', t: Date.now(), rid: ev.req_id });
            var p = wsPanel.pending[ev.req_id];
            if (!p) return;
            clearTimeout(p.timer);
            delete wsPanel.pending[ev.req_id];
            if (ev.ok) p.resolve(ev); else p.reject(new Error(ev.error || '操作失败'));
        });
        return true;
    }

    // 头部"更多操作"菜单收起归口（点外部/Esc/选中菜单项共用）
    function wsPanelMenuClose() {
        if (!wsPanel.moreMenu) return;
        wsPanel.moreMenu.classList.add('hidden');
        if (wsPanel.moreBtn) wsPanel.moreBtn.classList.remove('active');
    }

    // 中栏显隐归口：有打开标签、控制台展开、或"打开控制台"浮标可见 任一即显示整栏
    // （控制台停靠预览下方后，预览与控制台/浮标独立显隐）
    // 阶段九十二：控制台已改停靠浏览区底部（browser-panel 内）——中栏显隐不再受控制台/浮标影响，
    // 否则控制台一开就会把空的旧预览列撑出来（工作区与浏览区之间出现空白条）；
    // 仅回退停靠中栏的旧布局（Web/窄屏/无浏览面板）保留该联动
    function wsPanelSyncViewCol() {
        if (!wsPanel.colView) return;
        if (browserSupported() && browserPanelEl && agentConsole.root && browserPanelEl.contains(agentConsole.root)) {
            wsPanel.colView.classList.toggle('hidden', !wsPanel.activeTab);
            return;
        }
        var chipOn = !!(agentConsole && agentConsole.chip && !agentConsole.chip.classList.contains('hidden'));
        var show = !!wsPanel.activeTab || !!(agentConsole && (agentConsole.open || chipOn));
        wsPanel.colView.classList.toggle('hidden', !show);
    }

    // 阶段九十三：列表折叠按钮锚点归口——工作区面板开启时面板插在列表栏与聊天区之间
    //（wsPanelEnsure 的 insertBefore），.main-chat 左缘退到面板右缘，按钮留 .main-chat 会贴到
    // 工作区右缘（用户看到"列表按钮跑到工作区上"）。归口：面板显示时按钮搬入 .ws-panel 锚其
    // 左缘外沿（= 列表栏右缘，视觉位置与无面板时完全一致），面板隐藏时搬回 .main-chat。
    function syncListToggleAnchor() {
        if (!listToggleBtn || !wsPanel.aside) return;
        if (!wsPanel.aside.classList.contains('hidden')) {
            if (listToggleBtn.parentNode !== wsPanel.aside) {
                wsPanel.aside.insertBefore(listToggleBtn, wsPanel.aside.firstChild);
            }
        } else if (listToggleBtn.parentNode === wsPanel.aside) {
            var host = document.querySelector('.main-chat');
            if (host) host.insertBefore(listToggleBtn, host.firstChild);
        }
    }

    // 面板显隐归口：Agent 模式开 + 当前会话为 AI 智能体 才显示（开面板即恢复上次项目并拉取根目录）
    function wsPanelSetVisible(on) {
        if (on) {
            if (!wsPanelEnsure()) return;
            wsPanel.visible = true;
            wsPanel.aside.classList.remove('hidden');
            syncListToggleAnchor();
            if (!wsPanel.projLoaded) {
                wsPanelProjRestore().catch(function () { wsPanelRefreshTree(); });
            } else {
                wsPanelRefreshTree();
            }
        } else {
            wsPanel.visible = false;
            if (wsPanel.aside) wsPanel.aside.classList.add('hidden');
            syncListToggleAnchor();
        }
    }

    // 恢复上次项目（服务端归口 .im_proj.json）：有当前项目则树根定位项目目录，随后刷新
    function wsPanelProjRestore() {
        return wsPanelReq('proj_list', '').then(function (res) {
            var d = {};
            try { d = JSON.parse(res.content || '{}'); } catch (e) {}
            wsPanel.projList = Array.isArray(d.list) ? d.list : [];
            wsPanel.proj = String(d.proj || '');
            wsPanel.projLoaded = true;
            wsPanelProjSyncLabel();
            wsPanelRefreshTree();
            if (wsPanel.git.mode) wsPanelGitRefresh();
        });
    }

    // ===== 项目体系 UI（TRAE 同款）：▾ 弹层 + 克隆弹窗 + 项目切换 =====

    // git 视角路径（相对项目根）→ 文件面板 fs 视角（带 proj/ 前缀）
    function wsProjFsPath(p) {
        return (wsPanel.proj && p && p.indexOf(wsPanel.proj + '/') !== 0) ? wsPanel.proj + '/' + p : p;
    }

    // 根路径回显：项目模式下显示「项目名 · 完整根」，工作区根模式显示完整根
    function wsPanelProjSyncLabel() {
        if (!wsPanel.rootEl) return;
        if (wsPanel.proj) {
            wsPanel.rootEl.textContent = wsPanel.proj + ' · ' + wsPanel.root;
        } else {
            wsPanel.rootEl.textContent = wsPanel.root;
        }
        wsPanel.rootEl.title = wsPanel.proj ? ('当前项目：' + wsPanel.proj) : wsPanel.root;
    }

    // 切换当前项目：proj_open 落库 → 清空所有预览标签（旧项目路径失效）→ 重建树 → git 面板刷新
    function wsPanelProjSwitch(name) {
        wsPanelReq('proj_open', '', JSON.stringify({ proj: name })).then(function () {
            wsPanel.proj = name || '';
            var meta = wsPanel.projList.filter(function (it) { return it.name === name; })[0];
            if (meta) meta.ts = Math.floor(Date.now() / 1000); // 本地列表最近使用置顶
            wsPanelProjListRefresh();
            Object.keys(wsPanel.tabs).forEach(wsPanelCloseTab);
            wsPanel.expanded = {};
            wsPanel.badges = {};
            wsPanel.git.loaded = false; wsPanel.git.repo = true; wsPanel.git.branch = ''; wsPanel.git.log = null;
            wsPanelProjSyncLabel();
            wsPanelRefreshTree();
            if (wsPanel.git.mode) wsPanelGitRefresh();
        }).catch(function (err) {
            showToast('切换失败：' + (err && err.message || err));
        });
    }

    // 项目列表刷新（静默，弹层每次打开也拉一次保新鲜）
    function wsPanelProjListRefresh() {
        wsPanelReq('proj_list', '').then(function (res) {
            var d = {};
            try { d = JSON.parse(res.content || '{}'); } catch (e) {}
            wsPanel.projList = Array.isArray(d.list) ? d.list : [];
            if (typeof d.proj === 'string' && d.proj !== wsPanel.proj) wsPanel.proj = d.proj;
        }).catch(function () {});
    }

    // 项目弹层（TRAE 菜单同款自绘浮层）：克隆 Git 仓库 / 工作区根 / 项目列表（最近使用倒序，✓ 标当前）
    function wsPanelProjMenu(anchorBtn) {
        var old = document.getElementById('ws-proj-menu');
        if (old) { old.remove(); return; }
        wsPanelMenuClose();
        var menu = document.createElement('div');
        menu.id = 'ws-proj-menu';
        menu.className = 'ws-more-menu ws-proj-menu';
        // 顶部：克隆 Git 仓库入口（TRAE 同款图标行）
        var cloneItem = document.createElement('div');
        cloneItem.className = 'ws-more-item';
        var ci = document.createElement('span');
        ci.className = 'ws-more-ico';
        ci.textContent = '⤓';
        var ct = document.createElement('span');
        ct.className = 'ws-more-txt';
        ct.textContent = '克隆 Git 仓库';
        cloneItem.appendChild(ci);
        cloneItem.appendChild(ct);
        cloneItem.addEventListener('click', function () {
            menu.remove();
            wsPanelProjCloneDlg();
        });
        menu.appendChild(cloneItem);
        // 工作区根入口（proj 非空时显示，回到根目录视图）
        if (wsPanel.proj) {
            var rootItem = document.createElement('div');
            rootItem.className = 'ws-more-item';
            var ri = document.createElement('span');
            ri.className = 'ws-more-ico';
            ri.textContent = '⌂';
            var rt = document.createElement('span');
            rt.className = 'ws-more-txt';
            rt.textContent = '工作区根';
            rootItem.appendChild(ri);
            rootItem.appendChild(rt);
            rootItem.addEventListener('click', function () {
                menu.remove();
                wsPanelProjSwitch('');
            });
            menu.appendChild(rootItem);
        }
        // 项目列表标题（有项目才显示）
        var sec = document.createElement('div');
        sec.className = 'ws-proj-sec';
        sec.textContent = '项目';
        menu.appendChild(sec);
        var listWrap = document.createElement('div');
        listWrap.className = 'ws-proj-list';
        listWrap.textContent = '加载中…';
        menu.appendChild(listWrap);
        document.body.appendChild(menu);
        // 定位：.ws-more-menu 的 absolute top:calc(100%+4px) 只适配 .ws-more 内嵌锚点；
        // 本弹层挂 body，须改 fixed 视口坐标——锚按钮下方右对齐，下方放不下翻转到上方，四边留 8px
        var br = anchorBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.right = 'auto';
        var mw = menu.offsetWidth || 240;
        var mh = menu.offsetHeight || 0;
        var ml = Math.min(Math.max(8, br.right - mw), window.innerWidth - mw - 8);
        var mt = br.bottom + 4;
        if (mt + mh > window.innerHeight - 8 && br.top - mh - 4 > 8) mt = br.top - mh - 4;
        menu.style.left = Math.max(8, ml) + 'px';
        menu.style.top = Math.max(8, mt) + 'px';
        var close = function () { menu.remove(); document.removeEventListener('mousedown', outside, true); };
        var outside = function (ev) { if (!menu.contains(ev.target) && ev.target !== anchorBtn) close(); };
        setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
        // 拉取列表渲染（色块缩写 + 名称 + git 标记 + ✓ 当前）——TRAE「最近」同款
        wsPanelReq('proj_list', '').then(function (res) {
            var d = {};
            try { d = JSON.parse(res.content || '{}'); } catch (e) {}
            wsPanel.projList = Array.isArray(d.list) ? d.list : [];
            if (menu.parentNode === null) return; // 弹层已被关掉：丢弃
            listWrap.textContent = '';
            var list = wsPanel.projList;
            if (!list.length) {
                var empty = document.createElement('div');
                empty.className = 'ws-proj-empty';
                empty.textContent = '暂无项目，克隆一个仓库试试';
                listWrap.appendChild(empty);
                return;
            }
            list.forEach(function (it) {
                var row = document.createElement('div');
                row.className = 'ws-proj-item' + (it.name === wsPanel.proj ? ' active' : '');
                var av = document.createElement('span');
                av.className = 'ws-proj-av';
                av.textContent = (it.name.slice(0, 1) || '?').toUpperCase();
                var nm = document.createElement('span');
                nm.className = 'ws-proj-name';
                nm.textContent = it.name;
                var tag = document.createElement('span');
                tag.className = 'ws-proj-tag';
                tag.textContent = it.is_git ? 'GIT' : 'DIR';
                var cur = document.createElement('span');
                cur.className = 'ws-proj-cur';
                cur.textContent = it.name === wsPanel.proj ? '✓' : '';
                row.appendChild(av);
                row.appendChild(nm);
                row.appendChild(tag);
                row.appendChild(cur);
                row.addEventListener('click', function () {
                    close();
                    if (it.name !== wsPanel.proj) wsPanelProjSwitch(it.name);
                });
                listWrap.appendChild(row);
            });
        }).catch(function () {
            if (listWrap.parentNode) {
                listWrap.textContent = '';
                var err = document.createElement('div');
                err.className = 'ws-proj-empty';
                err.textContent = '项目列表加载失败';
                listWrap.appendChild(err);
            }
        });
    }

    // 克隆弹窗（自绘：仓库地址 / 目录名（可留空自动取尾段）/ 访问 Token（私有仓库可选））
    // P0：克隆中进度条（主题色）+ 取消克隆（63/65 progress 多帧驱动）；P1：最近克隆回填 + Token 记忆（PC safeStorage）
    function wsPanelProjCloneDlg() {
        var old = document.getElementById('ws-proj-dlg');
        if (old) old.remove();
        var isPC = !!(window.desktop && window.desktop.tokenGet && window.desktop.tokenSet);
        var mask = document.createElement('div');
        mask.id = 'ws-proj-dlg';
        mask.className = 'ws-proj-mask';
        var dlg = document.createElement('div');
        dlg.className = 'ws-proj-dlg';
        var ttl = document.createElement('div');
        ttl.className = 'ws-proj-dlg-t';
        ttl.textContent = '克隆 Git 仓库';
        dlg.appendChild(ttl);
        var fields = [
            { key: 'url', label: '仓库地址', ph: 'https://github.com/用户名/仓库名.git', type: 'text' },
            { key: 'name', label: '目录名（留空自动取地址尾段）', ph: '如 my-repo', type: 'text' },
            { key: 'token', label: '访问 Token（私有仓库选填，不落盘）', ph: 'ghp_xxxxxxxx', type: 'password' }
        ];
        var inputs = {};
        var recentsEl = null;
        fields.forEach(function (f, fi) {
            var lb = document.createElement('div');
            lb.className = 'ws-proj-dlg-l';
            lb.textContent = f.label;
            var inp = document.createElement('input');
            inp.className = 'ws-proj-dlg-i';
            inp.type = f.type;
            inp.placeholder = f.ph;
            inputs[f.key] = inp;
            dlg.appendChild(lb);
            dlg.appendChild(inp);
            if (fi === 0) {
                // 最近克隆列表（P1：proj_list 归口返回 recents，点击回填地址与目录名）
                recentsEl = document.createElement('div');
                recentsEl.className = 'ws-proj-dlg-recents';
                dlg.appendChild(recentsEl);
            }
        });
        // Token 记忆（仅 PC 端：Electron safeStorage 按 host 加密存本机，浏览器端无此能力自动隐藏）
        var rememberRow = null;
        var rememberChk = null;
        if (isPC) {
            rememberRow = document.createElement('label');
            rememberRow.className = 'ws-proj-dlg-remember';
            rememberChk = document.createElement('input');
            rememberChk.type = 'checkbox';
            rememberChk.checked = true;
            var rememberTxt = document.createElement('span');
            rememberTxt.textContent = '记住此站点的 Token（本机加密保存）';
            rememberRow.appendChild(rememberChk);
            rememberRow.appendChild(rememberTxt);
            dlg.appendChild(rememberRow);
        }
        var errEl = document.createElement('div');
        errEl.className = 'ws-proj-dlg-err hidden';
        dlg.appendChild(errEl);
        // 进度区（克隆中显示）：主题色进度条 + 阶段/速度状态行
        var prog = document.createElement('div');
        prog.className = 'ws-proj-dlg-prog';
        var bar = document.createElement('div');
        bar.className = 'ws-proj-dlg-bar';
        var fill = document.createElement('div');
        fill.className = 'ws-proj-dlg-fill';
        bar.appendChild(fill);
        var stageEl = document.createElement('div');
        stageEl.className = 'ws-proj-dlg-stage';
        prog.appendChild(bar);
        prog.appendChild(stageEl);
        dlg.appendChild(prog);
        var btnRow = document.createElement('div');
        btnRow.className = 'ws-proj-dlg-btns';
        var cancel = document.createElement('button');
        cancel.className = 'ws-panel-btn';
        cancel.type = 'button';
        cancel.textContent = '取消';
        var ok = document.createElement('button');
        ok.className = 'ws-panel-btn primary';
        ok.type = 'button';
        ok.textContent = '克隆';
        var stopBtn = document.createElement('button');
        stopBtn.className = 'ws-panel-btn danger';
        stopBtn.type = 'button';
        stopBtn.textContent = '取消克隆';
        stopBtn.style.display = 'none';
        btnRow.appendChild(cancel);
        btnRow.appendChild(stopBtn);
        btnRow.appendChild(ok);
        dlg.appendChild(btnRow);
        mask.appendChild(dlg);
        document.body.appendChild(mask);

        var cloneReqId = '';      // 运行中克隆的 req_id（取消目标）
        var canceled = false;     // 取消后忽略迟到错误展示
        var urlFillSeq = 0;       // Token 回填竞态序号（url 快速变更时丢弃过期回填）

        function fmtBytes(n) {
            if (!n || n <= 0) return '';
            var u = ['B', 'KB', 'MB', 'GB'], i = 0;
            while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
            return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
        }

        function hostOf(u) {
            var m = /^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?([^@/:]+)/.exec(u) || /^git@([^:]+):/.exec(u);
            return (m && m[1] || '').toLowerCase();
        }

        var close = function () {
            wsPanel.onCloneProgress = null; // 解绑进度回调（弹窗生命周期内持有）
            mask.remove();
        };

        // 进度帧归口：63（服务端直推/PC 65 转发）与 65 多帧统一走这里更新 UI
        wsPanel.onCloneProgress = function (ev) {
            if (!cloneReqId || ev.req_id !== cloneReqId) return;
            prog.classList.add('on');
            fill.style.width = Math.max(2, Math.min(100, ev.pct || 0)) + '%';
            var extra = [];
            if (ev.speed) extra.push(ev.speed);
            var sentTxt = fmtBytes(ev.sent);
            if (sentTxt) extra.push('已接收 ' + sentTxt);
            stageEl.innerHTML = '';
            var b = document.createElement('b');
            b.textContent = (ev.pct || 0) + '%';
            stageEl.appendChild(b);
            stageEl.appendChild(document.createTextNode(' ' + (ev.stage || '克隆中') + (extra.length ? ' · ' + extra.join(' · ') : '')));
        };

        // 最近克隆列表渲染（拉取失败静默——列表属增强体验）
        wsPanelReq('proj_list', '', '', 8000).then(function (res) {
            var data = {};
            try { data = JSON.parse(res.content || '{}'); } catch (e) {}
            var list = data.recents || [];
            if (!list.length || !recentsEl) return;
            list.slice(0, 6).forEach(function (r) {
                var it = document.createElement('div');
                it.className = 'ws-proj-dlg-ri';
                var n = document.createElement('span');
                n.className = 'ws-proj-dlg-ri-n';
                n.textContent = r.name || '';
                var u = document.createElement('span');
                u.className = 'ws-proj-dlg-ri-u';
                u.textContent = r.url || '';
                u.title = r.url || '';
                it.appendChild(n);
                it.appendChild(u);
                it.addEventListener('click', function () {
                    inputs.url.value = r.url || '';
                    if (!inputs.name.value) inputs.name.value = r.name || '';
                    inputs.url.focus();
                });
                recentsEl.appendChild(it);
            });
        }).catch(function () {});

        // Token 自动回填（PC 端）：url 就绪后按 host 查本机加密存储，命中即回填并勾选记住
        function maybeFillToken() {
            if (!isPC) return;
            var seq = ++urlFillSeq;
            var host = hostOf(inputs.url.value.trim());
            if (!host) return;
            window.desktop.tokenGet(host).then(function (t) {
                if (seq !== urlFillSeq || !t) return;
                if (!inputs.token.value) inputs.token.value = t;
                if (rememberChk) rememberChk.checked = true;
            }).catch(function () {});
        }
        inputs.url.addEventListener('change', maybeFillToken);
        inputs.url.addEventListener('blur', maybeFillToken);

        cancel.addEventListener('click', close);
        mask.addEventListener('mousedown', function (ev) { if (ev.target === mask) close(); });
        inputs.url.focus();
        // 取消克隆：按 req_id 精确取消（服务端/PC 执行器双路归口），迟到结果按已取消处理
        stopBtn.addEventListener('click', function () {
            if (!cloneReqId) return;
            canceled = true;
            wsPanelReq('proj_clone_cancel', '', JSON.stringify({ target: cloneReqId }), 10000).catch(function () {});
            close();
            showToast('正在取消克隆…');
        });
        ok.addEventListener('click', function () {
            var url = inputs.url.value.trim();
            var name = inputs.name.value.trim();
            var token = inputs.token.value.trim();
            if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s'"`]+$/.test(url)) {
                errEl.textContent = '仓库地址需以 https:// 、git@ 或 ssh:// 开头，不含空格与引号类字符';
                errEl.classList.remove('hidden');
                return;
            }
            if (name && (name.length > 100 || /[\\/]/.test(name) || name.indexOf('..') >= 0 || name.indexOf(':') >= 0)) {
                errEl.textContent = '目录名不合法（不含路径分隔符与 ..）';
                errEl.classList.remove('hidden');
                return;
            }
            errEl.classList.add('hidden');
            ok.disabled = true;
            ok.textContent = '克隆中…';
            cancel.style.display = 'none';
            stopBtn.style.display = '';
            prog.classList.add('on');
            fill.style.width = '2%';
            stageEl.innerHTML = '';
            stageEl.appendChild(document.createTextNode('正在连接仓库…'));
            var req = wsPanelReq('proj_clone', '', JSON.stringify({ url: url, name: name, token: token }), 620000);
            cloneReqId = req.reqId;
            req.then(function (res) {
                if (!res.ok) throw new Error(res.error || '克隆失败');
                if (isPC && rememberChk) {
                    window.desktop.tokenSet(hostOf(url), rememberChk.checked ? token : '').catch(function () {});
                }
                close();
                showToast('克隆完成');
                var newName = name || url.slice(url.lastIndexOf('/') + 1).replace(/\.git$/, '');
                wsPanelProjSwitch(newName); // 克隆成功自动切换到新项目（TRAE 同款体验）
            }).catch(function (err) {
                var msg = err && err.message || String(err);
                close();
                if (canceled || msg === '已取消') { showToast('克隆已取消'); return; }
                showToast('克隆失败：' + msg.split('\n')[0].slice(0, 80));
                // 复开弹窗回填原值与错误，便于修正重试
                wsPanelProjCloneDlg();
                var dlg2 = document.getElementById('ws-proj-dlg');
                if (dlg2) {
                    var ins = dlg2.querySelectorAll('.ws-proj-dlg-i');
                    if (ins[0]) ins[0].value = url;
                    if (ins[1]) ins[1].value = name;
                    if (ins[2]) ins[2].value = token;
                    var e2 = dlg2.querySelector('.ws-proj-dlg-err');
                    if (e2) {
                        e2.textContent = msg;
                        e2.classList.remove('hidden');
                    }
                }
            });
        });
    }

    // 面板请求归口（tree/read/save/git…），req_id 归属 + 超时（默认 20 秒；git push/pull 网络操作传更长）。
    // reqId 挂在返回 Promise 上（p.reqId），克隆取消按钮等场景需拿到 target
    function wsPanelReq(op, path, content, timeoutMs) {
        if (!wsPanelEnsure()) return Promise.reject(new Error('面板未就绪'));
        var reqId = 'fp' + (++wsPanel.reqSeq) + '_' + Date.now();
        var p = new Promise(function (resolve, reject) {
            var rec = {
                resolve: resolve, reject: reject,
                timer: setTimeout(function () {
                    delete wsPanel.pending[reqId];
                    reject(new Error('请求超时'));
                }, timeoutMs || 20000)
            };
            wsPanel.pending[reqId] = rec;
            if (window.desktop && window.desktop.fileopTrace) window.desktop.fileopTrace({ phase: 'send62', t: Date.now(), rid: reqId });
            var okSend = IMSocket.send({
                msg_type: MSG.WS_FILE_REQ,
                from_user: IMSocket.getUsername(),
                content: JSON.stringify({ op: op, req_id: reqId, path: path || '', content: content || '' })
            });
            if (!okSend) {
                clearTimeout(rec.timer);
                delete wsPanel.pending[reqId];
                reject(new Error('连接不可用'));
            }
        });
        p.reqId = reqId;
        return p;
    }

    // 刷新文件树：保留展开状态与角标，根目录重拉，已展开目录随渲染自动重载（根=当前项目目录）
    function wsPanelRefreshTree() {
        if (!wsPanel.visible || !wsPanel.treeEl) return;
        wsPanel.dirRows = {};
        wsPanel.fileRows = {};
        wsPanel.treeEl.textContent = '';
        wsPanelLoadDir(wsPanel.proj || '', wsPanel.treeEl);
    }

    // ===== 源代码管理（Trae CN 同款）：工作区 git 面板 =====
    // 执行归口 wsPanelReq('git')：PC 在线走本地执行器（execFile 异步，不阻塞客户端），
    // 离线回退服务端工作区（服务器需装 git）。视图切换不销毁文件树状态。

    // git 请求包装：硬错误（ok=false）与业务错误（content.error）统一抛出，成功返回解析后的 JSON。
    // 项目归口：自动携带 proj（git cwd=项目目录）；path/paths 若是文件面板视角（带 proj/ 前缀）剥为项目内相对路径
    function wsPanelGitReq(payload, timeoutMs) {
        var proj = wsPanel.proj || '';
        if (proj) {
            var pre = proj + '/';
            if (payload.path && payload.path.indexOf(pre) === 0) payload.path = payload.path.slice(pre.length);
            if (payload.paths) {
                payload.paths = payload.paths.map(function (p) {
                    return (p && p.indexOf(pre) === 0) ? p.slice(pre.length) : p;
                });
            }
            payload.proj = proj;
        }
        var isNet = payload.sub === 'push' || payload.sub === 'pushu' || payload.sub === 'pull';
        return wsPanelReq('git', '', JSON.stringify(payload), timeoutMs || (isNet ? 125000 : 25000)).then(function (res) {
            if (!res.ok) throw new Error(res.error || 'git 操作失败');
            var data;
            try { data = JSON.parse(res.content || '{}'); } catch (e) { throw new Error('git 响应解析失败'); }
            if (data.error) throw new Error(data.error);
            return data;
        });
    }

    // unified diff 解析：git diff 输出 → 行级变更标记数据（文件预览绿底/删除标记用）
    // 返回 { added:Set<newLine0>, deleted:[{at:newLine0, lines:[被删行文本]}] }
    // added=新文件中新增/修改行（0-based）；deleted.at=删除内容在新文件中的落点行（0-based，标记压在该行上缘）
    function wsParseDiffHunks(diffText) {
        var res = { added: new Set(), deleted: [] };
        if (!diffText || /Binary files .* differ|GIT binary patch/.test(diffText)) return res;
        var cur = -1;        // 当前新文件行号（1-based；-1=尚未进入 hunk）
        var pend = null;     // 暂存中的删除组
        function flush() {
            if (pend && pend.lines.length) res.deleted.push(pend);
            pend = null;
        }
        var rows = diffText.split('\n');
        for (var i = 0; i < rows.length; i++) {
            var ln = rows[i];
            var m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
            if (m) { flush(); cur = parseInt(m[1], 10); continue; } // hunk 头：cur=该 hunk 新文件起始行
            if (cur < 0) continue;                                  // hunk 前的文件头（diff --git/+++/---/index 等）
            if (ln.indexOf('\\ No newline at end of file') === 0) continue; // git 无换行结尾标记（'\\' 转义反斜杠）
            var c = ln.charAt(0);
            if (c === '+') {                    // 新增/修改行（1-based cur → 0-based cur-1）
                if (pend && pend.lines.length) { pend.at = cur - 1; flush(); } // 修改块：删除组紧贴 + 行
                res.added.add(cur - 1);
                cur++;
            } else if (c === '-') {             // 删除行：暂存，落点=下一条上下文/新增行
                if (!pend) pend = { at: cur - 1, lines: [] };
                pend.lines.push(ln.slice(1));
            } else if (c === ' ' || ln === '') { // 上下文行（空行=上下文空行，diff 行首必带空格，防御空串）
                if (pend && pend.lines.length) { pend.at = cur - 1; flush(); }
                cur++;
            } else { flush(); cur = -1; }        // 其余（新 hunk 间文件头等）：结束当前 hunk
        }
        flush();                                 // hunk 尾部删除组
        return res;
    }

    // 视图切换：git 视图显示时隐藏树与文件树头部（git 有自己的头部），首次/每次切入自动刷新状态
    function wsPanelGitSetMode(on) {
        if (!wsPanelEnsure()) return;
        wsPanel.git.mode = on;
        var navTabs = wsPanel.gitEl.parentNode.querySelectorAll('.ws-nav-tab');
        if (navTabs[0]) navTabs[0].classList.toggle('active', !on);
        if (navTabs[1]) navTabs[1].classList.toggle('active', on);
        wsPanel.treeEl.classList.toggle('hidden', on);
        wsPanel.headEl.classList.toggle('hidden', on);
        wsPanel.gitEl.classList.toggle('hidden', !on);
        if (on) wsPanelGitRefresh();
    }

    // git 操作进度条开关：提交/推送/拉取全程显示（Trae CN 同款），完成/失败隐藏。
    // 进度条元素每次渲染随 git 视图重建，这里实时查询（操作期间无全量重渲染，元素稳定）
    function wsGitProgress(on) {
        var el = wsPanel.gitEl;
        if (!el) return;
        var p = el.querySelector('.ws-git-progress');
        if (p) p.classList.toggle('on', !!on);
    }

    // 拉取 git 状态并重渲染（busy 防并发；失败 Toast 后仍重渲染保持视图一致）
    function wsPanelGitRefresh() {
        var g = wsPanel.git;
        if (g.busy) return Promise.resolve();
        g.busy = true;
        if (wsPanel.gitBody) wsPanel.gitBody.classList.add('git-busy');
        return wsPanelGitReq({ sub: 'status' }).then(function (d) {
            g.repo = d.repo !== false;
            g.branch = d.branch || '';
            g.upstream = d.upstream || '';
            g.ahead = d.ahead || 0;
            g.behind = d.behind || 0;
            g.noCommits = !!d.no_commits; // 全新仓库尚无提交（首次 commit 后分支才真正诞生）
            var all = d.changes || [];
            // 暂存区：X 列非空格且非未跟踪；工作区更改：Y 列非空格，或未跟踪文件（??）
            g.staged = all.filter(function (e) { return e.x !== ' ' && e.x !== '?'; });
            g.changes = all.filter(function (e) { return e.y !== ' ' || e.x === '?'; });
            g.loaded = true;
            // 提交历史每次刷新重拉（提交/推送后未推送标记会变）；分支列表同源刷新（审查目标选择用）。
            // 阶段一百零五修复：已有数据时保留旧列表静默校准（原实现先置 null，每次切换模式/刷新都闪"加载中…"），
            // LoadLog 完成后经元素签名比对：数据未变零重绘，变了才原位替换；首次打开仍为加载中占位
            g.log = g.noCommits ? [] : (g.log || null);
            if (g.repo && !g.noCommits) {
                wsPanelGitLoadLog();
                wsPanelGitLoadBranches();
            } else {
                g.branches = [];
            }
            // git status 把整个未跟踪目录折叠为 "dir/"——展开成目录内的具体文件后再渲染
            return wsPanelGitExpandUntracked();
        }).catch(function (err) {
            showToast('源代码管理：' + (err && err.message || err));
        }).then(function () {
            g.busy = false;
            wsPanelGitRender();
        });
    }

    // 关联远程仓库弹窗：自绘输入框收集远程地址；URL 非法时 toast 提示并携带上次输入重弹。
    // prefill 为输入框预填值（修改远程地址时带入当前地址，选中即可改）
    function wsPromptRemoteUrl(onOk, lastUrl, prefill) {
        showPrompt('关联远程仓库', lastUrl || 'https://github.com/用户名/仓库名.git', function (url) {
            // 除协议与无空白外，额外拒绝反引号/引号（从文档示例复制时易夹带的脏字符，会导致 remote URL 存脏数据）
            if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s'"`]+$/.test(url)) {
                showToast('地址需以 https:// 、git@ 或 ssh:// 开头，不含空格与引号类字符');
                wsPromptRemoteUrl(onOk, null, url); // 非法重弹：带上刚输入的值便于就地修正
                return;
            }
            onOk(url);
        }, prefill);
    }

    // 远程地址查看/修改弹窗：先读当前 origin 地址（未关联则静默预填空），确定后 set-url 更新
    function wsPanelGitRemoteDlg() {
        var edit = function (cur) {
            wsPromptRemoteUrl(function (url) {
                wsPanelGitAct({ sub: 'remoteseturl', target: url }, '远程地址已更新');
            }, null, cur);
        };
        wsPanelGitReq({ sub: 'remoteurl' }).then(function (d) {
            edit((d.output || '').trim());
        }).catch(function () { edit(''); }); // 未关联 origin（No such remote）：预填空
    }

    // git 动作归口（stage/unstage/discard/push/pull/init）：执行后刷新状态；pull 顺带刷新文件树（拉取可能改文件）
    function wsPanelGitAct(payload, doneTip) {
        if (wsPanel.git.busy) return Promise.resolve(); // 忙碌时静默忽略，返回已决议 promise 便于链式调用
        wsPanel.git.busy = true;
        if (wsPanel.gitBody) wsPanel.gitBody.classList.add('git-busy');
        // 阶段一百零五：耗时操作（提交/推送/拉取）全程显示不定态水平进度条（Trae CN 同款），
        // 无上游兜底重推（push→pushu）递归续接，进度条持续到整链完结
        var longOp = payload.sub === 'commit' || payload.sub === 'push' ||
            payload.sub === 'pushu' || payload.sub === 'pull';
        if (longOp) wsGitProgress(true);
        return wsPanelGitReq(payload).then(function () {
            if (doneTip) showToast(doneTip);
        }).catch(function (err) {
            var msg = err && err.message || String(err);
            // push 无上游分支：自动改用 -u origin <branch> 兜底重推一次（TRAE 同款首次推送体验）
            if (payload.sub === 'push' && /no upstream|上游/.test(msg)) {
                wsPanel.git.busy = false;
                return wsPanelGitAct({ sub: 'pushu', branch: wsPanel.git.branch }, doneTip);
            }
            // 仓库未关联远程地址：弹自绘输入框收集 URL → remoteadd → pushu 首推（面板内闭环，免去终端命令）
            if ((payload.sub === 'push' || payload.sub === 'pushu') && /No configured push destination/i.test(msg)) {
                wsPanel.git.busy = false;
                if (wsPanel.git.noCommits) { showToast('请先提交至少一次，再关联远程推送'); return; }
                wsPromptRemoteUrl(function (url) {
                    wsPanelGitAct({ sub: 'remoteadd', target: url }).then(function () {
                        return wsPanelGitAct({ sub: 'pushu', branch: wsPanel.git.branch }, doneTip || '远程已关联，推送成功');
                    }).catch(function () {}); // 失败细节已由内层 toast 提示
                });
                return;
            }
            // 远程已存在（重复关联）：自动转 set-url 更新地址——同一弹窗既可首次关联也可随时改地址
            if (payload.sub === 'remoteadd' && /already exists/i.test(msg)) {
                wsPanel.git.busy = false; // 先释放，递归调用才能过 busy guard（同 no-upstream/无 remote 分支）
                return wsPanelGitAct({ sub: 'remoteseturl', target: payload.target }, doneTip);
            }
            showToast('操作失败：' + msg);
        }).then(function () {
            wsGitProgress(false); // 进度条随操作完结隐藏（成功/失败同口径）
            wsPanel.git.busy = false;
            wsPanelGitRefresh().then(function () {
                if (payload.sub === 'pull') wsPanelRefreshTree(); // 拉取落地的新文件同步到树
            });
        });
    }

    // 展开 git status 折叠的未跟踪目录条目（"dir/" → 目录内各文件）：
    // 折叠条目会导致目录内文件不显示、且名称取空段渲染只剩目录维度。展开失败静默退回折叠显示
    function wsPanelGitExpandUntracked() {
        var g = wsPanel.git;
        var collapsed = g.changes.filter(function (e) { return e.x === '?' && /\/$/.test(e.p); });
        if (!collapsed.length) return Promise.resolve();
        return wsPanelGitReq({ sub: 'untracked' }).then(function (d) {
            var files = d.files || [];
            var merged = [];
            g.changes.forEach(function (e) {
                if (!(e.x === '?' && /\/$/.test(e.p))) { merged.push(e); return; }
                var kids = files.filter(function (f) { return f.indexOf(e.p) === 0; });
                kids.forEach(function (f) { merged.push({ p: f, x: '?', y: '?' }); });
                if (!kids.length) merged.push(e); // 目录内无非忽略文件（如仅有忽略项）：保留目录条目可整目录暂存
            });
            g.changes = merged;
        }).catch(function () {});
    }

    // 状态字母 → 展示字符（未跟踪 ?，其余原样）
    function wsGitStChar(e, zone) {
        if (zone === 'staged') return e.x === ' ' ? e.y : e.x;
        return e.x === '?' ? '?' : (e.y === ' ' ? e.x : e.y);
    }

    // 变更行：状态徽标 + 文件名（目录维度灰显）+ 悬停操作（暂存 +/取消 −/放弃 ↩）；点击行看 diff
    // 未跟踪目录折叠条目（p 以 / 结尾）：名称取去尾斜杠后的末段，点击无动作（无 diff 概念）
    function wsGitFileRow(p, e, zone) {
        var row = document.createElement('div');
        row.className = 'ws-git-row';
        var st = document.createElement('span');
        var ch = wsGitStChar(e, zone);
        st.className = 'ws-git-st st-' + (ch === '?' ? 'u' : ch.toLowerCase());
        st.textContent = ch;
        var clean = p.replace(/\/+$/, '');
        var isDir = p !== clean; // 折叠的未跟踪目录条目
        var nm = document.createElement('span');
        nm.className = 'ws-git-name';
        var li = clean.lastIndexOf('/');
        nm.textContent = (isDir ? '📁 ' : '') + (li >= 0 ? clean.slice(li + 1) : clean);
        nm.title = isDir ? p + '（未跟踪目录）' : p;
        var dirPart = document.createElement('span');
        dirPart.className = 'ws-git-dir';
        dirPart.textContent = li >= 0 ? clean.slice(0, li + 1) : '';
        row.appendChild(st);
        row.appendChild(nm);
        row.appendChild(dirPart);
        var acts = document.createElement('span');
        acts.className = 'ws-git-acts';
        if (zone === 'staged') {
            var un = document.createElement('span');
            un.className = 'ws-git-act';
            un.textContent = '−';
            un.title = '取消暂存';
            un.addEventListener('click', function (ev) { ev.stopPropagation(); wsPanelGitAct({ sub: 'unstage', paths: [p] }); });
            acts.appendChild(un);
            // 已暂存变更的放弃：从 HEAD 恢复（staged=discard 语义，checkout HEAD --）。
            // staged 删除/改名旧路径 index 中已无该文件，checkout -- 必报 pathspec 不匹配（实测 Developer 场景）
            if (e.x !== 'A') { // 暂存的新增文件 HEAD 中不存在，放弃必失败——只留取消暂存
                var sdis = document.createElement('span');
                sdis.className = 'ws-git-act danger';
                sdis.textContent = '↩';
                sdis.title = '放弃已暂存的修改（不可恢复）';
                sdis.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    showConfirm('放弃修改', '确定放弃「' + p + '」的暂存修改吗？将恢复为上次提交的内容，不可恢复。', function () {
                        wsPanelGitAct({ sub: 'discard', paths: [p], staged: true });
                    }, '放弃');
                });
                acts.appendChild(sdis);
            }
        } else {
            var ad = document.createElement('span');
            ad.className = 'ws-git-act';
            ad.textContent = '+';
            ad.title = '暂存';
            ad.addEventListener('click', function (ev) { ev.stopPropagation(); wsPanelGitAct({ sub: 'add', paths: [p] }); });
            acts.appendChild(ad);
            if (e.x !== '?' && e.y !== '?') { // 未跟踪文件无"放弃"概念（放弃=删除，走文件树右键）
                var dis = document.createElement('span');
                dis.className = 'ws-git-act danger';
                dis.textContent = '↩';
                dis.title = '放弃修改（不可恢复）';
                dis.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    showConfirm('放弃修改', '确定放弃「' + p + '」的全部修改吗？将恢复为上次提交的内容，不可恢复。', function () {
                        wsPanelGitAct({ sub: 'discard', paths: [p] });
                    }, '放弃');
                });
                acts.appendChild(dis);
            }
        }
        row.appendChild(acts);
        // 折叠的未跟踪目录条目：无 diff/预览概念，点击不动作（展开后的具体文件行才有点击）
        if (!isDir) row.addEventListener('click', function () { wsPanelGitOpenDiff(p, e); });
        return row;
    }

    // 分区（暂存的更改 / 更改）
    function wsGitSection(title, list, zone) {
        var sec = document.createElement('div');
        sec.className = 'ws-git-sec';
        var h = document.createElement('div');
        h.className = 'ws-git-sec-h';
        h.textContent = title + (list.length ? '（' + list.length + '）' : '');
        sec.appendChild(h);
        if (!list.length) {
            var empty = document.createElement('div');
            empty.className = 'ws-git-empty';
            empty.textContent = '（无）';
            sec.appendChild(empty);
            return sec;
        }
        list.forEach(function (e) { sec.appendChild(wsGitFileRow(e.p, e, zone)); });
        return sec;
    }

    // 剪贴板（帮助气泡命令一键复制）：优先 Clipboard API，失败回退 execCommand（非安全上下文可用）
    function wsGitCopyText(t) {
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = t;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('已复制'); } catch (e) { showToast('复制失败'); }
            document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(t).then(function () { showToast('已复制'); }, fallback);
        } else fallback();
    }

    // 帮助气泡外点收起（pop 已被重渲染移除时自动解绑）
    function wsGitHelpOutside(ev) {
        var el = wsPanel.gitEl;
        var pop = el && el.querySelector('.ws-git-help-pop');
        if (!pop) { document.removeEventListener('mousedown', wsGitHelpOutside); return; }
        if (pop.contains(ev.target) || ev.target.closest && ev.target.closest('.ws-git-help-btn')) return;
        pop.remove();
        document.removeEventListener('mousedown', wsGitHelpOutside);
    }

    // Esc 收起帮助气泡
    function wsGitHelpEsc(ev) {
        var pop = wsPanel.gitEl && wsPanel.gitEl.querySelector('.ws-git-help-pop');
        if (ev.key === 'Escape' && pop) {
            pop.remove();
            document.removeEventListener('keydown', wsGitHelpEsc);
        }
    }

    // 帮助气泡：分步配置指南（身份/远程/鉴权），命令行带一键复制；点击按钮切换，外点/Esc 收起
    function wsPanelGitToggleHelp() {
        var el = wsPanel.gitEl;
        if (!el) return;
        var old = el.querySelector('.ws-git-help-pop');
        if (old) { old.remove(); document.removeEventListener('mousedown', wsGitHelpOutside); return; }
        var pop = document.createElement('div');
        pop.className = 'ws-git-help-pop';
        function sec(title) {
            var s = document.createElement('div');
            s.className = 'ws-git-help-sec';
            var h = document.createElement('div');
            h.className = 'ws-git-help-h';
            h.textContent = title;
            s.appendChild(h);
            pop.appendChild(s);
            return s;
        }
        function line(s, text, cmd) {
            var ln = document.createElement('div');
            ln.className = 'ws-git-help-line';
            var tx = document.createElement('span');
            tx.textContent = text;
            ln.appendChild(tx);
            if (cmd) {
                var cd = document.createElement('code');
                cd.className = 'ws-git-help-cmd';
                cd.textContent = cmd;
                cd.title = cmd;
                ln.appendChild(cd);
                var cp = document.createElement('span');
                cp.className = 'ws-git-help-copy';
                cp.textContent = '复制';
                cp.title = '复制命令';
                cp.addEventListener('click', function () { wsGitCopyText(cmd); });
                ln.appendChild(cp);
            }
            s.appendChild(ln);
            return ln;
        }
        var s1 = sec('① 配置 git 身份（首次提交前，全局一次）');
        line(s1, '', 'git config --global user.name "你的名字"');
        line(s1, '', 'git config --global user.email "你的邮箱@example.com"');
        var s2 = sec('② 连接远程仓库（三选一）');
        line(s2, '推送到新建空仓库（先去平台建仓库拿地址）：', '');
        line(s2, '', 'git remote add origin https://github.com/用户名/仓库名.git');
        line(s2, '然后在本面板：暂存 → 提交 → ⬆ 推送（自动建立跟踪）', '');
        line(s2, '拉取远程已有项目（克隆到工作区子目录）：', '');
        line(s2, '', 'git clone https://github.com/用户名/仓库名.git');
        line(s2, '工作区本就是 git 仓库（含 .git）：无需配置，面板自动识别', '');
        var s3 = sec('③ 推送/拉取鉴权');
        line(s3, 'HTTPS：推送时密码填平台生成的 Token（GitHub/Gitee → 设置 → 开发者设置 → 令牌），Windows 会记住凭据', '');
        line(s3, 'SSH：ssh-keygen 生成密钥，公钥贴到平台，remote 换 git@github.com:用户名/仓库名.git', '');
        var s4 = sec('提示');
        line(s4, '以上命令在「控制台」终端执行（当前目录即工作区根）。', '');
        el.appendChild(pop);
        if (window._osbInit) window._osbInit(pop); // 全局滚动条已禁用，超长气泡内容挂自绘滑块
        setTimeout(function () {
            document.addEventListener('mousedown', wsGitHelpOutside);
            document.addEventListener('keydown', wsGitHelpEsc);
        }, 0);
    }

    // TRAE CN 同款 codicon 图标（microsoft/vscode-codicons，fill=currentColor 随主题色变化）：
    // path 数据内联为 JS 常量，运行时零外部文件依赖，正式环境不新增任何资源目录
    var WS_GIT_ICONS = {
        // 裸「?」帮助图标：弧线笔画 1.5 + 实心圆点，点独立绘制保证小尺寸下清晰可见
        'question': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none"><path d="M5.1 6A2.9 2.9 0 0 1 10.9 6A2.9 2.9 0 0 1 8 8.9L8 10.2" fill="none" stroke="currentColor" stroke-linecap="round" style="stroke-width:1.5"/><circle cx="8" cy="12.7" r="1.15" fill="currentColor" stroke="none"/></svg>',
        'arrow-swap': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M11.3536 1.64645C11.1583 1.45118 10.8417 1.45118 10.6464 1.64645C10.4512 1.84171 10.4512 2.15829 10.6464 2.35355L12.2929 4H2.5C2.22386 4 2 4.22386 2 4.5C2 4.77614 2.22386 5 2.5 5H12.2929L10.6464 6.64645C10.4512 6.84171 10.4512 7.15829 10.6464 7.35355C10.8417 7.54882 11.1583 7.54882 11.3536 7.35355L13.8536 4.85355C14.0488 4.65829 14.0488 4.34171 13.8536 4.14645L11.3536 1.64645ZM5.35355 9.35355C5.54882 9.15829 5.54882 8.84171 5.35355 8.64645C5.15829 8.45118 4.84171 8.45118 4.64645 8.64645L2.14645 11.1464C1.95118 11.3417 1.95118 11.6583 2.14645 11.8536L4.64645 14.3536C4.84171 14.5488 5.15829 14.5488 5.35355 14.3536C5.54882 14.1583 5.54882 13.8417 5.35355 13.6464L3.70711 12H13.5C13.7761 12 14 11.7761 14 11.5C14 11.2239 13.7761 11 13.5 11H3.70711L5.35355 9.35355Z"/></svg>',
        'repo-pull': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4.85 6.15C4.755 6.05 4.627 6 4.5 6C4.372 6 4.245 6.05 4.15 6.15C4.05 6.245 4 6.373 4 6.5C4 6.627 4.05 6.755 4.15 6.85L7.15 9.85C7.245 9.95 7.372 10 7.5 10C7.628 10 7.755 9.95 7.85 9.85L10.85 6.85C10.95 6.755 11 6.628 11 6.5C11 6.372 10.95 6.245 10.85 6.15C10.755 6.05 10.627 6 10.5 6C10.373 6 10.245 6.05 10.15 6.15L8 8.29V1.5C8 1.22 7.78 1 7.5 1C7.22 1 7 1.22 7 1.5V8.29L4.85 6.15Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9.95 13H12.5C12.78 13 13 13.22 13 13.5C13 13.78 12.78 14 12.5 14H9.95C9.72 15.14 8.71 16 7.5 16C6.29 16 5.28 15.14 5.05 14H2.5C2.22 14 2 13.78 2 13.5C2 13.22 2.22 13 2.5 13H5.05C5.28 11.86 6.29 11 7.5 11C8.71 11 9.72 11.86 9.95 13ZM6.09 14C6.29 14.58 6.85 15 7.5 15C8.15 15 8.71 14.58 8.91 14C8.97 13.84 9 13.68 9 13.5C9 13.32 8.97 13.16 8.91 13C8.71 12.42 8.15 12 7.5 12C6.85 12 6.29 12.42 6.09 13C6.03 13.16 6 13.32 6 13.5C6 13.68 6.03 13.84 6.09 14Z"/></svg>',
        'repo-push': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4.85 4.85C4.755 4.95 4.627 5 4.5 5C4.372 5 4.245 4.95 4.15 4.85C4.05 4.755 4 4.627 4 4.5C4 4.373 4.05 4.245 4.15 4.15L7.15 1.15C7.245 1.05 7.372 1 7.5 1C7.628 1 7.755 1.05 7.85 1.15L10.85 4.15C10.95 4.245 11 4.372 11 4.5C11 4.628 10.95 4.755 10.85 4.85C10.755 4.95 10.627 5 10.5 5C10.373 5 10.245 4.95 10.15 4.85L8 2.71V9.5C8 9.78 7.78 10 7.5 10C7.22 10 7 9.78 7 9.5V2.71L4.85 4.85Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9.95 13H12.5C12.78 13 13 13.22 13 13.5C13 13.78 12.78 14 12.5 14H9.95C9.72 15.14 8.71 16 7.5 16C6.29 16 5.28 15.14 5.05 14H2.5C2.22 14 2 13.78 2 13.5C2 13.22 2.22 13 2.5 13H5.05C5.28 11.86 6.29 11 7.5 11C8.71 11 9.72 11.86 9.95 13ZM6.09 14C6.29 14.58 6.85 15 7.5 15C8.15 15 8.71 14.58 8.91 14C8.97 13.84 9 13.68 9 13.5C9 13.32 8.97 13.16 8.91 13C8.71 12.42 8.15 12 7.5 12C6.85 12 6.29 12.42 6.09 13C6.03 13.16 6 13.32 6 13.5C6 13.68 6.03 13.84 6.09 14Z"/></svg>',
        'refresh': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H10C9.72386 5 9.5 5.22386 9.5 5.5C9.5 5.77614 9.72386 6 10 6H12.8904C12.8973 6.00014 12.9041 6.00014 12.911 6H13C13.2761 6 13.5 5.77614 13.5 5.5V2.5C13.5 2.22386 13.2761 2 13 2C12.7239 2 12.5 2.22386 12.5 2.5V4.03138C11.4009 2.78613 9.79253 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14C11.1301 14 13.6999 11.6035 13.9756 8.54488C14.0003 8.26985 13.7975 8.0268 13.5225 8.00202C13.2474 7.97723 13.0044 8.1801 12.9796 8.45512C12.75 11.003 10.6079 13 8 13C5.23858 13 3 10.7614 3 8Z"/></svg>'
    };
    function wsGitIco(name) { return WS_GIT_ICONS[name] || ''; }

    // git 视图渲染（每次数据刷新全量重建；DOM 简单量小，无性能压力）
    function wsPanelGitRender() {
        var g = wsPanel.git;
        var el = wsPanel.gitEl;
        if (!el) return;
        // 阶段一百零五修复：清理前先捕获旧提交历史分区——数据未变（元素签名一致）时整区重渲染原样复用，
        // 模式切换/状态刷新触发的重建不再丢失历史区滚动位置与悬停详情卡
        var prevLogSec = el.querySelector('.ws-git-log');
        el.textContent = '';
        // 头部：标题 + 拉取/推送/刷新（非仓库时仅初始化引导，不显示动作按钮）
        var head = document.createElement('div');
        head.className = 'ws-git-head';
        var ttl = document.createElement('span');
        ttl.className = 'ws-git-title';
        ttl.textContent = '源代码管理';
        head.appendChild(ttl);
        if (g.repo && g.loaded) {
            var pullB = document.createElement('button');
            pullB.className = 'ws-panel-btn';
            pullB.type = 'button';
            pullB.innerHTML = wsGitIco('repo-pull'); // TRAE CN 同款 codicon 拉取图标
            pullB.title = '拉取（pull）';
            pullB.addEventListener('click', function () { wsPanelGitAct({ sub: 'pull' }, '已拉取'); });
            var pushB = document.createElement('button');
            pushB.className = 'ws-panel-btn';
            pushB.type = 'button';
            pushB.innerHTML = wsGitIco('repo-push'); // TRAE CN 同款 codicon 推送图标
            pushB.title = '推送（push）';
            pushB.addEventListener('click', function () { wsPanelGitAct({ sub: 'push' }, '已推送'); });
            var rmB = document.createElement('button');
            rmB.className = 'ws-panel-btn';
            rmB.type = 'button';
            rmB.innerHTML = wsGitIco('arrow-swap'); // TRAE CN 同款 codicon ⇄ 交换箭头（上→下←，与拉取/推送同粗细）
            rmB.title = '远程仓库地址（查看/修改）';
            rmB.addEventListener('click', wsPanelGitRemoteDlg);
            head.appendChild(pullB);
            head.appendChild(pushB);
            head.appendChild(rmB);
        }
        var helpB = document.createElement('button');
        helpB.className = 'ws-panel-btn ws-git-help-btn';
        helpB.type = 'button';
        helpB.innerHTML = wsGitIco('question'); // 自绘裸「?」矢量图标（与其它按钮同粗细，圆点小尺寸下清晰）
        helpB.title = '配置帮助（身份 / 远程仓库 / 鉴权）';
        helpB.addEventListener('click', function () { wsPanelGitToggleHelp(); });
        head.appendChild(helpB);
        var refB = document.createElement('button');
        refB.className = 'ws-panel-btn ws-refresh-btn';
        refB.type = 'button';
        refB.innerHTML = wsGitIco('refresh'); // TRAE CN 同款 codicon 刷新图标
        refB.title = '刷新状态';
        refB.addEventListener('click', function () { wsPanelGitRefresh(); });
        head.appendChild(refB);
        el.appendChild(head);
        // 阶段一百零五：git 操作进度条（Trae CN 同款不定态水平滑动）——提交/推送/拉取期间显示，完成即隐
        var prog = document.createElement('div');
        prog.className = 'ws-git-progress';
        el.appendChild(prog);
        // 尚非 git 仓库：引导初始化（Trae CN 同款）
        if (!g.repo) {
            var hint = document.createElement('div');
            hint.className = 'ws-git-norepo';
            hint.textContent = '当前工作区还不是 Git 仓库。';
            var initB = document.createElement('button');
            initB.className = 'ws-git-init';
            initB.type = 'button';
            initB.textContent = '初始化仓库';
            initB.addEventListener('click', function () {
                wsPanelGitAct({ sub: 'init' }, '已初始化 Git 仓库');
            });
            el.appendChild(hint);
            el.appendChild(initB);
            return;
        }
        if (!g.loaded) {
            var loading = document.createElement('div');
            loading.className = 'ws-panel-hint';
            loading.textContent = '加载中…';
            el.appendChild(loading);
            return;
        }
        // 分支 + 领先/落后
        var br = document.createElement('div');
        br.className = 'ws-git-branch';
        var brName = document.createElement('span');
        brName.className = 'ws-git-branch-name';
        brName.textContent = '⎇ ' + (g.branch || '(无分支)');
        if (g.upstream) brName.title = g.branch + ' → ' + g.upstream;
        br.appendChild(brName);
        if (g.ahead > 0 || g.behind > 0) {
            var ab = document.createElement('span');
            ab.className = 'ws-git-ab';
            ab.textContent = (g.ahead ? '↑' + g.ahead : '') + (g.behind ? ' ↓' + g.behind : '');
            ab.title = '领先 ' + g.ahead + ' 个提交，落后 ' + g.behind + ' 个提交';
            br.appendChild(ab);
        }
        el.appendChild(br);
        // 全新仓库（尚无任何提交）：分支要首次 commit 后才真正诞生，给出引导提示
        if (g.noCommits) {
            var nc = document.createElement('div');
            nc.className = 'ws-git-nocommits';
            nc.textContent = '尚无任何提交——完成首次「提交」后，分支 ' + (g.branch || 'master') + ' 即创建。';
            el.appendChild(nc);
        }
        // 提交框（Trae CN 同款单行紧凑框）：✦ AI 生成 + ▾ 菜单内嵌右侧；单行起步、多行内容自动增高
        var msgWrap = document.createElement('div');
        msgWrap.className = 'ws-git-msg-wrap';
        var msg = document.createElement('textarea');
        msg.className = 'ws-git-msg';
        msg.rows = 1;
        // 阶段一百零五：占位缩短为单行（原"提交变更内容（Ctrl+Enter 提交）"在窄面板折行，
        // 撑高输入框两倍；完整提示移入 title），高度上限 96→64px（约 3 行，TRAE CN 同款紧凑）
        msg.placeholder = '提交信息';
        msg.title = '提交变更内容，Ctrl+Enter 提交';
        msg.value = wsPanel.gitMsg && wsPanel.gitMsg.value || ''; // 重渲染保留输入
        wsPanel.gitMsg = msg;
        // 自动增高：单行起步（Trae CN 同款高度），换行内容多时最高撑到 3 行左右
        function growMsg() {
            msg.style.height = 'auto';
            msg.style.height = Math.min(msg.scrollHeight, 64) + 'px';
        }
        wsPanel.gitMsgGrow = growMsg;
        msg.addEventListener('input', growMsg);
        var aiB = document.createElement('button');
        aiB.className = 'ws-git-ai-btn';
        aiB.type = 'button';
        aiB.textContent = '✦';
        aiB.title = 'AI 生成提交信息（根据代码变更自动填写）';
        aiB.addEventListener('click', function () { wsPanelGitGenMsg(aiB); });
        var mArr = document.createElement('button');
        mArr.className = 'ws-git-msg-arrow';
        mArr.type = 'button';
        mArr.textContent = '▾';
        mArr.title = '更多';
        mArr.addEventListener('click', function (e) {
            e.stopPropagation();
            wsGitMenu(mArr, [
                { label: 'AI 生成提交信息', onclick: function () { wsPanelGitGenMsg(aiB); } },
                { label: '使用上次提交信息', title: '预填上一次提交的信息', onclick: wsPanelGitPrefillHead },
                { label: '清空', onclick: function () { msg.value = ''; growMsg(); msg.focus(); } }
            ]);
        });
        msgWrap.appendChild(msg);
        msgWrap.appendChild(aiB);
        msgWrap.appendChild(mArr);
        el.appendChild(msgWrap);
        growMsg();
        // Ctrl+Enter 快捷提交（Trae CN 同款）
        msg.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); wsPanelGitDoCommit(); }
        });
        var commitRow = document.createElement('div');
        commitRow.className = 'ws-git-commit-row';
        var commitB = document.createElement('button');
        commitB.className = 'ws-git-commit' + (g.amend ? ' amend' : '');
        commitB.type = 'button';
        commitB.textContent = g.amend ? '✓ 修改上次提交' : (g.staged.length ? '✓ 提交' : (g.changes.length ? '✓ 提交全部更改' : '✓ 提交'));
        commitB.title = '提交（Ctrl+Enter）';
        commitB.disabled = g.busy;
        commitB.addEventListener('click', function () { wsPanelGitDoCommit(); });
        wsPanel.gitCommitBtn = commitB;
        var arrowB = document.createElement('button');
        arrowB.className = 'ws-git-commit-arrow';
        arrowB.type = 'button';
        arrowB.textContent = '▾';
        arrowB.title = '更多提交方式';
        arrowB.disabled = g.busy;
        arrowB.addEventListener('click', function (e) {
            e.stopPropagation();
            wsGitMenu(arrowB, [
                { label: '提交', onclick: function () { wsPanelGitDoCommit(); } },
                { label: '提交并推送', onclick: function () { wsPanelGitDoCommit(true); } },
                { label: g.amend ? '取消修改模式' : '修改上次提交（amend）', title: '将暂存的更改并入上一次提交并覆盖其信息', onclick: wsPanelGitToggleAmend }
            ]);
        });
        commitRow.appendChild(commitB);
        commitRow.appendChild(arrowB);
        el.appendChild(commitRow);
        // 修改模式提示条（可点击取消）
        if (g.amend) {
            var am = document.createElement('div');
            am.className = 'ws-git-amend-tip';
            am.textContent = '× 修改模式：提交将覆盖上一次提交（点击取消）';
            am.title = '取消修改模式';
            am.addEventListener('click', function () { wsPanelGitToggleAmend(); });
            el.appendChild(am);
        }
        // 变更主体：文件列表独立滚动区（文件多时自身滚动，不把审查区顶走）
        var body = document.createElement('div');
        body.className = 'ws-git-body';
        body.appendChild(wsGitSection('暂存的更改', g.staged, 'staged'));
        body.appendChild(wsGitSection('更改', g.changes, 'changes'));
        wsPanel.gitBody = body;
        el.appendChild(body);
        // 拖拽条×2（输入区同款交互）各自独立：① 文件区下方→调智能体审查高度 ② 审查与历史之间→仅调提交历史高度
        // 拖动时上方分区整体平移不缩放、历史永不越过审查边界（上限按另一分区当前高度动态钳制）；高度 localStorage 持久化
        if (g._hRestored !== true) {
            g._hRestored = true;
            try {
                var sh1 = parseInt(localStorage.getItem('im_git_review_h'), 10);
                var sh2 = parseInt(localStorage.getItem('im_git_log_h'), 10);
                if (sh1 >= 72 && sh1 <= 800) g.reviewH = sh1;
                if (sh2 >= 80 && sh2 <= 800) g.logH = sh2;
            } catch (e2) {}
        }
        // 底部两区独立高度调整（直觉交互）：拖历史条只动历史区、拖审查条只动审查区，
        // 另一侧恒不动——高度变化由弹性的文件列表区（.ws-git-body，flex:1 自身滚动）吸收，
        // 文件区保底 bodyMin 不被压没。上限 = 面板高 - 两拖拽条12 - bodyMin - 对方当前高度，
        // 比旧版固定 reserve 300 宽裕得多（旧版矮窗口锁死的根因）
        var bodyMin = 48;
        var minReview = 72, minLog = 80;
        function saveSplit() {
            try {
                localStorage.setItem('im_git_review_h', String(g.reviewH));
                localStorage.setItem('im_git_log_h', String(g.logH));
            } catch (e2) {}
        }
        function bindGitDrag(bar, which) { // which='review'（drag① 文件区下方）| 'log'（drag② 审查与历史之间）
            var minSelf = which === 'review' ? minReview : minLog;
            bar.addEventListener('mousedown', function (e) {
                e.preventDefault();
                var startY = e.clientY;
                var startH = which === 'review' ? g.reviewH : g.logH;
                // 对方快照：拖拽过程中恒不动；对方折叠时不占高度，本区可用上限相应放开
                var otherH = which === 'review' ? (g.logCollapsed ? 0 : g.logH) : (g.reviewCollapsed ? 0 : g.reviewH);
                var maxSelf = el.clientHeight - 12 - bodyMin - otherH;
                // 拖拽目标实时从 DOM 查（不用闭包快照）：提交历史分区会被 wsPanelGitLoadLog 异步
                // replaceWith 原位刷新，闭包捕获的旧元素已脱离 DOM——拖它高度纹丝不动，
                // 直到点三角全量重渲染重建闭包才恢复（实测踩坑根因）
                var sel = which === 'review' ? '.ws-git-review' : '.ws-git-log';
                bar.classList.add('dragging');
                document.body.style.userSelect = 'none'; // 拖拽期间禁用文本选择（与输入区拖拽条同款）
                function onMove(ev) {
                    var nh = Math.max(minSelf, Math.min(startH + (startY - ev.clientY), Math.max(minSelf, maxSelf)));
                    if (which === 'review') g.reviewH = Math.round(nh);
                    else g.logH = Math.round(nh);
                    var target = el.querySelector(sel);
                    if (target) target.style.height = nh + 'px';
                    saveSplit();
                }
                function onUp() {
                    bar.classList.remove('dragging');
                    document.body.style.userSelect = '';
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }
        // 底部固定区：智能体审查（固定高度）+ 拖拽条② + 提交历史（固定高度）
        var bottom = document.createElement('div');
        bottom.className = 'ws-git-bottom';
        var reviewSec = wsGitReviewSection(g);
        // 历史分区复用判定：有数据且签名一致 → 复用旧分区（滚动/悬停/滑块状态保留）；
        // 否则新建（数据变化路径先收起 body 级单例悬停详情卡，防旧行销毁后卡片悬空）。
        // 阶段一百零五修复：折叠态必须入签名——点击头部三角只翻 logCollapsed、数据不变，
        // 旧签名一致会误判复用旧展开分区，导致三角不转向也不折叠（折叠后内容结构不同本就该重建）
        var logSig = (g.log && g.log.length) ? JSON.stringify([g.branch, g.log, g.ahead, g.logCollapsed ? 1 : 0]) : null;
        var logSec = (prevLogSec && logSig !== null && prevLogSec._logSig === logSig) ? prevLogSec : wsGitLogSection(g);
        if (logSec !== prevLogSec) {
            if (logSig !== null) logSec._logSig = logSig;
            wsGitCommitCardHide();
        }
        // 初始高度钳制（与拖拽模型同源）：avail = 面板高 - 两条拖拽条12 - 文件区保底 bodyMin。
        // 折叠分区不设固定高度（收缩为头部自然高度，腾出的空间由文件区 flex:1 向下吸收——
        // 否则折叠后留下固定高度的空白盒、底部布局整体上蹿）；展开分区照旧钳制，
        // clientHeight<150 视为面板尚未完成布局——跳过钳制与落盘，仅设 style
        if (el.clientHeight >= 150) {
            var avail = Math.max(minReview + minLog, el.clientHeight - 12 - bodyMin);
            var revOpen = !g.reviewCollapsed, logOpen = !g.logCollapsed;
            if (revOpen && logOpen) {
                var hr = Math.max(minReview, Math.min(g.reviewH, avail - minLog));
                var hl = Math.max(minLog, Math.min(g.logH, avail - minReview));
                if (hr + hl > avail) { // 超预算：压较大者到预算内（另一侧保最小值）
                    var over = hr + hl - avail;
                    if (hr > hl) hr = Math.max(minReview, hr - over);
                    else hl = Math.max(minLog, hl - over);
                }
                reviewSec.style.height = hr + 'px';
                logSec.style.height = hl + 'px';
                g.reviewH = Math.round(hr);
                g.logH = Math.round(hl);
            } else if (revOpen) { // 仅审查展开：历史不占预算，审查可用上限放开到 avail
                reviewSec.style.height = Math.max(minReview, Math.min(g.reviewH, avail)) + 'px';
                logSec.style.height = '';
            } else if (logOpen) { // 仅历史展开：审查不占预算，历史可用上限放开到 avail
                logSec.style.height = Math.max(minLog, Math.min(g.logH, avail)) + 'px';
                reviewSec.style.height = '';
            } else { // 双折叠：均收缩为头部自然高度
                reviewSec.style.height = '';
                logSec.style.height = '';
            }
        } else {
            reviewSec.style.height = g.reviewCollapsed ? '' : g.reviewH + 'px';
            logSec.style.height = g.logCollapsed ? '' : g.logH + 'px';
        }
        var drag2 = document.createElement('div');
        drag2.className = 'ws-git-dragbar';
        drag2.title = '拖拽调整提交历史高度';
        var drag = document.createElement('div');
        drag.className = 'ws-git-dragbar';
        drag.title = '拖拽调整智能体审查高度';
        bindGitDrag(drag, 'review');
        bindGitDrag(drag2, 'log');
        bottom.appendChild(reviewSec);
        bottom.appendChild(drag2);
        bottom.appendChild(logSec);
        el.appendChild(drag);
        el.appendChild(bottom);
        if (g.reviewCollapsed) drag.style.display = 'none'; // 审查收起时无可调对象
        if (g.logCollapsed) drag2.style.display = 'none'; // 历史收起时无可调对象
        if (window._osbInit) { window._osbInit(body); window._osbInit(reviewSec); window._osbInit(logSec); } // 各分区自绘滚动条（原生滚动条全局隐藏，历史区同方案挂悬浮滑块）
    }

    // 折叠分区头（Trae CN 同款）：▾ 三角 + 标题，点击收起/展开；collapsed 时三角右转
    function wsGitSecHeader(title, count, collapsed, onToggle) {
        var h = document.createElement('div');
        h.className = 'ws-git-sec-h toggle';
        var tri = document.createElement('span');
        tri.className = 'ws-git-tri' + (collapsed ? ' closed' : '');
        tri.textContent = '▾';
        h.appendChild(tri);
        var t = document.createElement('span');
        t.textContent = title + (count !== null && count !== undefined ? '（' + count + '）' : '');
        h.appendChild(t);
        h.addEventListener('click', onToggle);
        return h;
    }

    // 使用上次提交信息：预填 HEAD 的提交主题（输入框已有内容时不覆盖）
    function wsPanelGitPrefillHead() {
        var g = wsPanel.git;
        if (g.log && g.log[0]) {
            if (wsPanel.gitMsg && !wsPanel.gitMsg.value.trim()) {
                wsPanel.gitMsg.value = g.log[0].msg;
                if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
            }
            return;
        }
        wsPanelGitReq({ sub: 'log', branch: g.branch }).then(function (d) {
            g.log = d.commits || [];
            if (wsPanel.gitMsg && !wsPanel.gitMsg.value.trim() && g.log[0]) {
                wsPanel.gitMsg.value = g.log[0].msg;
                if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
            }
        }).catch(function (err) {
            showToast('读取上次提交信息失败：' + (err && err.message || err));
        });
    }

    // 修改上次提交（amend）模式切换：进入时预填上一次提交信息便于改写
    function wsPanelGitToggleAmend() {
        var g = wsPanel.git;
        if (!g.amend) {
            var pre = (g.log && g.log[0] && g.log[0].msg) || '';
            if (!wsPanel.gitMsg || !wsPanel.gitMsg.value.trim()) {
                if (pre) { wsPanel.gitMsg.value = pre; }
                else if (!g.log) {
                    // 历史尚未加载完成：先拉一次再预填
                    wsPanelGitReq({ sub: 'log', branch: g.branch }).then(function (d) {
                        g.log = d.commits || [];
                        if (g.amend && wsPanel.gitMsg && !wsPanel.gitMsg.value.trim() && g.log[0]) {
                            wsPanel.gitMsg.value = g.log[0].msg;
                            if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
                        }
                    }).catch(function () {});
                }
            }
            g.amend = true;
            showToast('已进入修改模式：提交将覆盖上一次提交');
        } else {
            g.amend = false;
        }
        wsPanelGitRender();
    }

    // 提交动作归口：amend 模式带 --amend；andPush=true 提交成功后自动推送（无上游自动 -u 兜底）
    function wsPanelGitDoCommit(andPush) {
        var g = wsPanel.git;
        if (g.busy) return;
        // 阶段一百零五：AI 生成流式中禁止提交（框内是未完成的打字机文本，防误提交半截信息）
        if (g.aiBusy || wsGitAIStreaming) { showToast('AI 正在生成提交信息，请稍候'); return; }
        var msg = wsPanel.gitMsg;
        var text = (msg && msg.value || '').trim();
        if (!text) { showToast(g.amend ? '请填写修改后的提交信息' : '请填写提交信息'); if (msg) msg.focus(); return; }
        if (!g.amend && !g.staged.length && g.changes.length) {
            showConfirm('提交', '没有已暂存的更改，要提交全部更改吗？', function () {
                if (g.busy) return;
                var paths = g.changes.map(function (e) { return e.p; });
                g.busy = true; // add→commit 两跳串行期间挡住并发点击
                wsPanelGitReq({ sub: 'add', paths: paths })
                    .then(function () { return wsPanelGitCommitCore(text, andPush); })
                    .catch(function (err) {
                        showToast('提交失败：' + (err && err.message || err));
                    })
                    .then(function () { g.busy = false; wsPanelGitRefresh(); });
            }, '提交全部');
            return;
        }
        g.busy = true;
        wsPanelGitCommitCore(text, andPush).then(function () {
            g.busy = false;
            wsPanelGitRefresh();
        });
    }

    // 提交核心：commit（amend 由状态决定）→ 可选 push；成功清空输入与 amend 态
    function wsPanelGitCommitCore(text, andPush) {
        var g = wsPanel.git;
        var wasAmend = g.amend;
        return wsPanelGitReq({ sub: 'commit', msg: text, amend: wasAmend }).then(function () {
            if (wsPanel.gitMsg) wsPanel.gitMsg.value = '';
            if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
            g.amend = false;
            showToast(wasAmend ? '已修改上一次提交' : '已提交');
            if (!andPush) return null;
            showToast('推送中…');
            return wsPanelGitReq({ sub: 'push' }).then(function () {
                showToast('已提交并推送');
            }).catch(function (err) {
                // push 无上游分支：自动改用 -u origin <branch> 兜底重推一次（TRAE 同款首次推送体验）
                if (/no upstream|上游/.test(err && err.message || '')) {
                    return wsPanelGitReq({ sub: 'pushu', branch: g.branch }).then(function () { showToast('已提交并推送'); });
                }
                throw err;
            });
        }).catch(function (err) {
            showToast((andPush ? '提交/推送失败：' : '提交失败：') + (err && err.message || err));
        });
    }

    // ===== 源代码管理 AI（Trae CN 同款）：提交信息生成 / 智能体审查 =====
    // 归口：op=gitai 固定服务端执行（模型服务归口服务端，PC 不参与），diff 由前端收集上行

    // gitai 请求包装：与 wsPanelGitReq 同款解析（错误统一抛出，成功返回 {mode, text}）
    function wsPanelGitAIReq(payload, timeoutMs) {
        // 服务端 AI 调用上限 150s，前端等待放宽到 170s
        return wsPanelReq('gitai', '', JSON.stringify(payload), timeoutMs || 170000).then(function (res) {
            if (!res.ok) throw new Error(res.error || 'AI 请求失败');
            var data;
            try { data = JSON.parse(res.content || '{}'); } catch (e) { throw new Error('AI 响应解析失败'); }
            if (data.error) throw new Error(data.error);
            return data;
        });
    }

    // 自绘下拉菜单（不用系统弹窗）：锚定按钮右下对齐，外点/Esc 收起；items: {label,title,disabled,onclick}
    function wsGitMenu(anchor, items) {
        var el = wsPanel.gitEl;
        if (!el) return;
        var old = el.querySelector('.ws-git-menu');
        if (old) old.remove();
        var m = document.createElement('div');
        m.className = 'ws-git-menu';
        items.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'ws-git-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
            row.textContent = it.label;
            if (it.title) row.title = it.title;
            if (!it.disabled) {
                row.addEventListener('click', function () { m.remove(); if (it.onclick) it.onclick(); });
            }
            m.appendChild(row);
        });
        el.appendChild(m);
        if (window._osbInit) window._osbInit(m); // 分支较多时菜单内部滚动（自绘滑块）
        // 定位：锚元素相对 git 视图坐标，贴其下方右对齐；下方放不下（面板 overflow:hidden 会裁剪）自动翻转到锚点上方
        var gr = el.getBoundingClientRect();
        var ar = anchor.getBoundingClientRect();
        var mh = m.offsetHeight || 0;
        var topDown = ar.bottom - gr.top + 4;
        if (mh && topDown + mh > gr.height && ar.top - gr.top - 4 - mh > 0) {
            topDown = ar.top - gr.top - 4 - mh;
        }
        m.style.top = Math.max(4, topDown) + 'px';
        m.style.right = Math.max(4, gr.right - ar.right) + 'px';
        setTimeout(function () {
            function close(ev) {
                if (m.contains(ev.target)) return;
                m.remove();
                document.removeEventListener('mousedown', close);
                document.removeEventListener('keydown', closeEsc);
            }
            function closeEsc(ev) { if (ev.key === 'Escape') close(ev); }
            document.addEventListener('mousedown', close);
            document.addEventListener('keydown', closeEsc);
        }, 0);
    }

    // AI 生成提交信息：暂存区 diff 优先（即将提交的内容最有代表性），为空回退全部工作区变更。
    // 阶段一百零五：流式打字机（TRAE CN 同款）——服务端经 AGENT_EVENT 下发 git_ai_delta 增量填入
    // 提交框，最终响应到达后以清洗后全文校准；生成期间清空原输入，失败恢复原值。
    // 阶段一百零五流畅度修复（TRAE CN 同款）：点击先显示「AI 正在生成」占位，网络增量不再整块直填
    // （帧大跳字/帧间停顿卡顿），先进缓冲再由 20ms 定时器按积压量步进吐字——积压越多吐越快，
    // 视觉上始终匀速打字；生成期间输入框只读防误编辑，重试（git_ai_reset）同步清缓冲
    var wsGitAIStreaming = false;  // 生成中标记（delta 事件与请求响应的窗口期判定）
    var wsGitAIPending = '';       // 待渲染增量缓冲（网络帧节奏与渲染节奏解耦）
    var wsGitAITimer = null;       // 打字机渲染定时器（首个增量到达启动，完结/失败停止）
    var wsGitAIPh = false;         // 「AI 正在生成」占位展示中（首个增量到达时清除）

    // 打字机单帧吐字：按积压量放大步长（约 0.5s 内追平积压），保证任意帧到达节奏下都平滑
    function wsGitAITick() {
        if (!wsGitAIPending) return;
        var msg = wsPanel.gitMsg;
        if (!msg) { wsGitAIPending = ''; return; }
        var cut = Math.max(2, Math.ceil(wsGitAIPending.length / 25));
        var cc = wsGitAIPending.charCodeAt(cut - 1);
        if (cc >= 0xD800 && cc <= 0xDBFF && wsGitAIPending.length > cut) cut += 1; // 代理对防截断
        if (wsGitAIPh) { // 首个增量到达：清掉「AI 正在生成」占位与置灰样式
            msg.value = '';
            msg.classList.remove('ai-ph');
            wsGitAIPh = false;
        }
        msg.value += wsGitAIPending.slice(0, cut);
        wsGitAIPending = wsGitAIPending.slice(cut);
        if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
    }

    // 停止打字机（成功校准/失败恢复/链条收尾共用）：清定时器与缓冲，恢复输入框可编辑
    function wsGitAIStopStream() {
        wsGitAIStreaming = false;
        if (wsGitAITimer) { clearInterval(wsGitAITimer); wsGitAITimer = null; }
        wsGitAIPending = '';
        wsGitAIPh = false;
        if (wsPanel.gitMsg) wsPanel.gitMsg.classList.remove('ai-ph');
    }

    function wsGitAIDelta(text) {
        if (!wsGitAIStreaming || !text) return;
        wsGitAIPending += text;
        if (!wsGitAITimer) wsGitAITimer = setInterval(wsGitAITick, 20);
    }

    function wsPanelGitGenMsg(btn) {
        var g = wsPanel.git;
        if (g.aiBusy) return;
        g.aiBusy = true;
        var msg = wsPanel.gitMsg;
        var prev = msg ? msg.value : '';
        wsGitAIStreaming = true;
        if (msg) { // 先显示「AI 正在生成」占位（TRAE CN 同款），置灰斜体 + 只读防生成期间误编辑
            msg.value = 'AI 正在生成提交信息…';
            msg.classList.add('ai-ph');
            msg.readOnly = true;
            wsGitAIPh = true;
            if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
        }
        btn.classList.add('loading');
        var diffTxt = '';
        wsPanelGitReq({ sub: 'diffcached' }).then(function (d) {
            diffTxt = d.diff || '';
            if (!diffTxt.trim()) return wsPanelGitReq({ sub: 'diffhead' }).then(function (d2) { diffTxt = d2.diff || ''; });
        }).then(function () {
            if (!diffTxt.trim()) throw new Error('没有可分析的变更（暂存区与工作区均为空）');
            return wsPanelGitAIReq({ mode: 'commitmsg', diff: diffTxt });
        }).then(function (r) {
            wsGitAIStopStream(); // 先停打字机（含残余缓冲）再校准，防响应文本被增量覆盖
            if (wsPanel.gitMsg && r.text) {
                wsPanel.gitMsg.value = r.text;
                if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
                wsPanel.gitMsg.focus();
            }
        }).catch(function (err) {
            wsGitAIStopStream();
            if (msg) { msg.value = prev; if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow(); } // 失败恢复原输入
            showToast('AI 提交信息：' + (err && err.message || err));
        }).then(function () {
            wsGitAIStopStream();
            if (msg) msg.readOnly = false;
            g.aiBusy = false;
            btn.classList.remove('loading');
        });
    }

    // 拉取分支列表（审查目标选择用）：本地 + 远端跟踪分支（origin/xxx，服务端 refs/heads+refs/remotes）；
    // 默认目标优先 main/master，其次首个非当前分支；都没有（仓库仅当前分支）时回退
    // '@worktree' 工作区伪目标（TRAE CN 同款：单分支仓库可审查未提交变更，不再直接拒绝）
    // origin/HEAD 是符号引用不是真分支，全链路排除
    var GIT_REVIEW_WORKTREE = '@worktree'; // 工作区伪目标标识（非真实分支名）
    function wsGitReviewTargetLabel(t) {
        return t === GIT_REVIEW_WORKTREE ? '工作区（未提交变更）' : t;
    }
    function wsPanelGitLoadBranches() {
        var g = wsPanel.git;
        wsPanelGitReq({ sub: 'branches' }).then(function (d) {
            g.branches = (d.list || []).filter(function (b) { return !/\/HEAD$/.test(b); });
            // 目标分支已失效（伪目标除外）；无有效目标时按偏好选默认，仍无则回退工作区伪目标
            if (g.reviewTarget && g.reviewTarget !== GIT_REVIEW_WORKTREE && g.branches.indexOf(g.reviewTarget) < 0) g.reviewTarget = '';
            if (!g.reviewTarget) {
                var pref = ['main', 'master', 'origin/main', 'origin/master'].filter(function (b) {
                    return b !== g.branch && g.branches.indexOf(b) >= 0;
                });
                g.reviewTarget = pref[0] || g.branches.filter(function (b) { return b !== g.branch; })[0] || GIT_REVIEW_WORKTREE;
            }
        }).catch(function () {
            g.branches = g.branches || [];
        });
    }

    // 智能体审查区：总结并审查按钮（+下拉）与 当前分支 → 目标分支 选择行；头部三角可折叠
    function wsGitReviewSection(g) {
        var sec = document.createElement('div');
        sec.className = 'ws-git-review';
        sec.appendChild(wsGitSecHeader('智能体审查', null, g.reviewCollapsed, function () {
            g.reviewCollapsed = !g.reviewCollapsed;
            wsPanelGitRender();
        }));
        if (g.reviewCollapsed) return sec;
        var row = document.createElement('div');
        row.className = 'ws-git-review-btnrow';
        var btn = document.createElement('button');
        btn.className = 'ws-git-review-btn';
        btn.type = 'button';
        btn.textContent = g.reviewBusy ? '审查中…' : '总结并审查';
        btn.title = 'AI 审查当前分支相对目标分支的变更，生成审查报告';
        btn.disabled = !!g.reviewBusy;
        btn.addEventListener('click', function () { wsPanelGitDoReview(); });
        var arr = document.createElement('button');
        arr.className = 'ws-git-review-arrow';
        arr.type = 'button';
        arr.textContent = '▾';
        arr.title = '更多';
        arr.addEventListener('click', function (e) {
            e.stopPropagation();
            var items = [{ label: '总结并审查', onclick: function () { wsPanelGitDoReview(); } }];
            if (g.lastReviewKey && wsPanel.tabs[g.lastReviewKey]) {
                items.push({ label: '查看上次报告', onclick: function () {
                    wsPanel.viewEl.classList.remove('hidden');
                    wsPanelActivate(g.lastReviewKey);
                    wsPanelSyncViewCol();
                } });
            }
            wsGitMenu(arr, items);
        });
        row.appendChild(btn);
        row.appendChild(arr);
        sec.appendChild(row);
        // 分支选择行：⎇ 当前分支 → ⎇ 目标分支▾（三点 diff 口径）
        var br = document.createElement('div');
        br.className = 'ws-git-review-branches';
        var from = document.createElement('span');
        from.className = 'ws-git-review-branch';
        from.textContent = '⎇ ' + (g.branch || '(无分支)');
        var sep = document.createElement('span');
        sep.className = 'ws-git-review-sep';
        sep.textContent = '→';
        var to = document.createElement('button');
        to.className = 'ws-git-review-branch to';
        to.type = 'button';
        var toLabel = g.reviewTarget ? wsGitReviewTargetLabel(g.reviewTarget) : '选择目标分支';
        to.textContent = '⎇ ' + toLabel;
        to.title = g.reviewTarget === GIT_REVIEW_WORKTREE
            ? '审查目标：工作区未提交变更（git diff HEAD）'
            : '审查目标分支（对比 ' + (g.reviewTarget || '…') + '...HEAD 的变更）';
        to.disabled = g.reviewBusy;
        to.addEventListener('click', function (e) {
            e.stopPropagation();
            if (g.branches === null) { showToast('分支列表加载中，请稍候'); return; }
            // 目标菜单：工作区伪目标恒在首项（TRAE CN 同款，单分支仓库也能审查未提交变更），
            // 其余可选分支按原口径排除当前分支与 origin/HEAD 符号引用
            var items = [{ label: '⎇ ' + wsGitReviewTargetLabel(GIT_REVIEW_WORKTREE), onclick: function () {
                g.reviewTarget = GIT_REVIEW_WORKTREE;
                wsPanelGitRender();
            } }];
            g.branches.filter(function (b) { return b !== g.branch && !/\/HEAD$/.test(b); }).forEach(function (b) {
                items.push({ label: '⎇ ' + b, onclick: function () {
                    g.reviewTarget = b;
                    wsPanelGitRender();
                } });
            });
            wsGitMenu(to, items);
        });
        br.appendChild(from);
        br.appendChild(sep);
        br.appendChild(to);
        sec.appendChild(br);
        return sec;
    }

    // ===== 阶段一百零六：审查报告流式反馈（TRAE CN 同款） =====
    // 点"总结并审查"确认 diff 可审后立即开报告页占位；服务端经 git_review_delta 增量推进，
    // 前端同键刷新逐字呈现（PC 浏览区标签同 key 复用刷新 / web 面板标签原位重渲染）；
    // 流式期间 600ms 节流防高频重建，收尾（成功/失败）强制刷新定稿。reviewBusy 单飞无需多路复用
    var wsReviewStream = null; // 当前审查流 { key, title, target, acc, lastFlush }
    function wsGitReviewDelta(text) {
        if (!wsReviewStream || !text) return;
        wsReviewStream.acc += text;
        wsReviewStreamFlush(null);
    }
    function wsReviewStreamFlush(finalText) {
        var s = wsReviewStream;
        if (!s) return;
        var now = Date.now();
        if (finalText === null && now - s.lastFlush < 600) return; // 流式节流（收尾定稿强制刷新）
        s.lastFlush = now;
        var content = finalText !== null ? finalText : (s.acc || '> ⏳ 正在生成审查报告，请稍候…');
        if (wsPcViewer()) { // PC：浏览区标签同 key 复用刷新（主进程 openDataTab 重开即刷新）
            wsOpenData({ key: s.key, kind: 'md', title: s.title, content: content, meta: { target: s.target } });
            return;
        }
        var t = wsPanel.tabs[s.key]; // web：面板报告标签原位重渲染
        if (t && t.review) {
            t.loading = false;
            t.content = content;
            if (wsPanel.activeTab === s.key) wsPanelRenderTab();
        }
    }

    // 执行智能体审查：目标分支三点 diff（或工作区未提交变更）→ gitai 流式生成 Markdown 报告
    // → 报告标签即时打开并随增量逐字刷新（PC 进浏览区）
    function wsPanelGitDoReview() {
        var g = wsPanel.git;
        if (g.reviewBusy) return;
        if (!g.reviewTarget) { showToast('请先选择审查目标分支'); return; }
        g.reviewBusy = true;
        wsPanelGitRender(); // 按钮进入"审查中…"态
        var target = g.reviewTarget;
        var isWt = target === GIT_REVIEW_WORKTREE; // 工作区伪目标：审未提交变更（git diff HEAD），非三点 diff
        var aiTarget = wsGitReviewTargetLabel(target); // AI 提示词 {target} 注入与报告标题统一用显示名
        var key = 'review:' + target;
        var diffTxt = '';
        wsPanelGitReq(isWt ? { sub: 'diffhead' } : { sub: 'diffrev', target: target }).then(function (d) {
            diffTxt = d.diff || '';
            var emptyTip = isWt ? '当前没有未提交的变更，无需审查' : '当前分支相对 ' + target + ' 没有差异，无需审查';
            if (!diffTxt.trim()) throw new Error(emptyTip);
            // 即时反馈（TRAE CN 同款）：确认可审后立即开报告页占位，后续流式增量同键逐字刷新，不再干等
            wsReviewStream = { key: key, title: '审查报告: ' + aiTarget, target: target, acc: '', lastFlush: 0 };
            g.lastReviewKey = key;
            if (wsPcViewer()) {
                wsReviewStreamFlush(null);
            } else {
                wsPanel.viewEl.classList.remove('hidden');
                if (wsPanel.tabOrder.indexOf(key) < 0) wsPanel.tabOrder.push(key);
                wsPanel.tabs[key] = { name: '审查报告: ' + aiTarget, review: true, isMd: true, reviewTarget: target, content: '> ⏳ 正在生成审查报告，请稍候…' };
                wsPanelActivate(key);
                wsPanelSyncViewCol();
            }
            return wsPanelGitAIReq({ mode: 'review', diff: diffTxt, target: aiTarget }).then(function (r) {
                var text = r.text || '（AI 未返回内容）';
                if (wsReviewStream) { // 收尾定稿：以服务端清洗后的全文最终渲染一次
                    wsReviewStream.acc = text;
                    wsReviewStreamFlush(text);
                    wsReviewStream = null;
                }
                showToast('审查报告已生成');
            });
        }).catch(function (err) {
            if (wsReviewStream) { // 流中断：已收到的部分落地 + 失败尾注，防报告页停留"审查中"假态
                var partial = wsReviewStream.acc;
                wsReviewStreamFlush((partial ? partial + '\n\n' : '') + '> ⚠️ 审查失败：' + (err && err.message || err));
                wsReviewStream = null;
            }
            showToast('智能体审查：' + (err && err.message || err));
        }).then(function () {
            g.reviewBusy = false;
            if (wsPanel.git.mode) wsPanelGitRender();
        });
    }

    // 时间格式化（提交历史/详情用）：unix 秒 → YYYY-MM-DD HH:mm
    function wsGitFmtTime(at) {
        var d = new Date((at || 0) * 1000);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // 拉取提交历史首页（skip=0 前 30 条 + 未推送标记）；完成后原位替换时间线分区（不打断其余视图）
    function wsPanelGitLoadLog() {
        var g = wsPanel.git;
        if (g.logBusy) return;
        g.logBusy = true;
        wsPanelGitReq({ sub: 'log', branch: g.branch, skip: 0 }).then(function (d) {
            g.log = d.commits || [];
            g.logHasMore = !!d.has_more;
        }).catch(function () {
            // 拉取失败：此前已有数据则保留静默降级（下次刷新自动重试，不把已有历史误显示为"暂无提交"）；
            // 仅首次（null）置空数组走"暂无提交"口径
            if (!g.log) g.log = [];
        }).then(function () {
            g.logBusy = false;
            var el = wsPanel.gitEl;
            if (!el || g.log === null) return;
            var old = el.querySelector('.ws-git-log');
            var fresh = wsGitLogSection(g);
            // 阶段一百零五：签名比对防闪烁——提交/推送后重拉历史，内容（分支/提交列表/未推送数）
            // 无变化时跳过整区替换（原实现每次 replaceWith，悬停详情卡/滚动位置丢失且视觉闪烁）
            var sig = JSON.stringify([g.branch, g.log, g.ahead]);
            // 阶段一百零五修复：签名锚定到旧分区元素本身（原静态闭包签名在整区重渲染后失真——
            // 模式切换回源代码管理触发 wsPanelGitRender 重建出"加载中…"分区，随后相同数据
            // 被静态签名误判为无变化而跳过替换，提交历史永久停留加载中）。
            // 元素级签名：重建的加载中分区无 _logSig 必替换；数据未变的原位分区仍跳过（防闪烁）
            if (old && old._logSig === sig) return;
            fresh._logSig = sig;
            if (old) {
                wsGitCommitCardHide(); // 旧分区被替换后其悬停行消失，先收起详情卡防悬空
                // 继承旧分区的行内固定高度：异步刷新若不继承，历史区会被内容撑高、拖拽条失效，
                // 直到点三角折叠/展开触发全量重渲染才恢复（实测踩坑）
                fresh.style.height = old.style.height;
                old.replaceWith(fresh);
            } else { // 渲染时占位分区缺失（时序兜底）：补进底部固定区
                var b = el.querySelector('.ws-git-bottom');
                (b || el).appendChild(fresh);
            }
            if (window._osbInit) window._osbInit(fresh); // 自绘悬浮滑块（原生滚动条全局隐藏，见 .ws-git-log）
        });
    }

    // 滚动到底自动加载下一页（Trae CN 同款）：skip=已加载条数，新行原位追加不整区重渲染（保持滚动位置）
    function wsPanelGitLoadMore() {
        var g = wsPanel.git;
        if (g.logBusy || g.log === null || !g.log.length || !g.logHasMore || g.logCollapsed) return;
        g.logBusy = true;
        var el = wsPanel.gitEl;
        var sec = el && el.querySelector('.ws-git-log');
        var moreEl = sec && sec.querySelector('.ws-git-log-more');
        if (moreEl) moreEl.textContent = '加载中…';
        wsPanelGitReq({ sub: 'log', branch: g.branch, skip: g.log.length }).then(function (d) {
            if (g.log === null) return; // 加载期间 status 刷新已重置历史（首页重拉中），丢弃本页
            g.logHasMore = !!d.has_more;
            g.log = g.log.concat(d.commits || []);
            var el2 = wsPanel.gitEl;
            var sec2 = el2 && el2.querySelector('.ws-git-log');
            if (sec2) { // 原位追加：新行插到分页指示行前，指示文案随 has_more 更新
                var m = sec2.querySelector('.ws-git-log-more');
                (d.commits || []).forEach(function (c) { sec2.insertBefore(wsGitLogRow(g, c), m || null); });
                if (m) m.textContent = g.logHasMore ? '上滑加载更多' : '已全部加载';
                if (sec2._osbUpdate) sec2._osbUpdate(); // 内容增高后同步滑块长度/位置
                // 元素签名同步追加后的全量数据：保持「元素._logSig == 当前渲染数据签名」不变量——
                // 否则签名停在第一页，之后刷新即使数据完全一致也会误判变化整区替换（历史区滚动位置丢失）
                sec2._logSig = JSON.stringify([g.branch, g.log, g.ahead]);
            } else if (wsPanel.git.mode) {
                wsPanelGitRender(); // 兜底：分区已被重建（如折叠切换），整区重渲染
            }
        }).catch(function () {
            var el3 = wsPanel.gitEl;
            var m3 = el3 && el3.querySelector('.ws-git-log-more');
            if (m3) m3.textContent = '上滑加载更多'; // 失败不终止分页：再次滚到底可重试
        }).then(function () {
            g.logBusy = false;
        });
    }

    // 提交历史时间线（Trae CN 同款）：纵向时间线 + 未推送云标记 + HEAD 分支徽标，点击查看提交详情；头部三角可折叠
    function wsGitLogSection(g) {
        var sec = document.createElement('div');
        sec.className = 'ws-git-log';
        sec.appendChild(wsGitSecHeader('提交历史', g.log && g.log.length ? g.log.length : null, g.logCollapsed, function () {
            g.logCollapsed = !g.logCollapsed;
            wsPanelGitRender();
        }));
        if (g.logCollapsed) return sec;
        if (!g.log) {
            var ld = document.createElement('div');
            ld.className = 'ws-git-empty';
            ld.textContent = '加载中…';
            sec.appendChild(ld);
            return sec;
        }
        if (!g.log.length) {
            var empty = document.createElement('div');
            empty.className = 'ws-git-empty';
            empty.textContent = '（暂无提交）';
            sec.appendChild(empty);
            return sec;
        }
        g.log.forEach(function (c) { sec.appendChild(wsGitLogRow(g, c)); });
        // 分页指示行（Trae CN 同款滚动加载）：整页或有下一页时显示，滚到底自动拉下一页
        if (g.logHasMore || g.log.length >= 30) {
            var more = document.createElement('div');
            more.className = 'ws-git-log-more';
            more.textContent = g.logHasMore ? '上滑加载更多' : '已全部加载';
            sec.appendChild(more);
        }
        sec.addEventListener('scroll', function () { // 距底 60px 内触发加载（logBusy 防重复触发）
            wsGitCommitCardHide(); // 滚动时悬停行已移位，详情卡立即隐藏
            if (!g.logHasMore || g.logBusy || g.log === null || !g.log.length) return;
            if (sec.scrollTop + sec.clientHeight >= sec.scrollHeight - 60) wsPanelGitLoadMore();
        }, { passive: true });
        return sec;
    }

    // 时间线单项（全量渲染与滚动分页追加共用，TRAE CN 同款）：
    // 提交头行（圆点+箭头+主题+HEAD 徽标+未推送云标，悬停弹详情卡，点击展开/收起文件列表）+ 可展开文件区
    function wsGitLogRow(g, c) {
        var item = document.createElement('div');
        item.className = 'ws-git-log-item';
        var head = document.createElement('div');
        head.className = 'ws-git-log-row' + (c.head ? ' head' : '');
        var files = c.files || [];
        var arrow = document.createElement('span');
        arrow.className = 'ws-git-log-arrow';
        arrow.textContent = files.length ? '▸' : '';
        var dot = document.createElement('span');
        dot.className = 'ws-git-log-dot';
        var main = document.createElement('span');
        main.className = 'ws-git-log-msg';
        main.textContent = c.msg;
        head.appendChild(dot);
        head.appendChild(arrow);
        head.appendChild(main);
        if (c.head && g.branch) {
            var bb = document.createElement('span');
            bb.className = 'ws-git-log-branch';
            bb.textContent = g.branch;
            head.appendChild(bb);
        }
        if (c.un) {
            var cl = document.createElement('span');
            cl.className = 'ws-git-log-un';
            cl.textContent = '☁';
            cl.title = '未推送';
            head.appendChild(cl);
        }
        item.appendChild(head);
        // 可展开文件列表（TRAE CN 同款）：状态/增删数据随 log 一次带回，展开零请求；点文件看该提交内此文件 diff
        var box = document.createElement('div');
        box.className = 'ws-git-log-files';
        box.style.display = 'none';
        files.forEach(function (f) {
            var fr = document.createElement('div');
            fr.className = 'ws-git-log-file';
            var badge = document.createElement('span');
            badge.className = 'ws-git-file-badge';
            badge.textContent = wsGitFileBadge(f.p);
            var nm = document.createElement('span');
            nm.className = 'ws-git-file-name';
            nm.textContent = f.p.replace(/^.*[\\/]/, '');
            var di = f.p.lastIndexOf('/');
            var dir = document.createElement('span');
            dir.className = 'ws-git-file-dir';
            dir.textContent = di >= 0 ? f.p.slice(0, di) : '';
            fr.title = f.p;
            var mk = document.createElement('span');
            mk.className = 'ws-git-file-mark mk-' + String(f.s || 'M').toLowerCase();
            mk.textContent = f.s || 'M';
            fr.appendChild(badge);
            fr.appendChild(nm);
            fr.appendChild(dir);
            fr.appendChild(mk);
            fr.addEventListener('click', function (ev) {
                ev.stopPropagation();
                wsPanelGitOpenCommitFile(c, f.p);
            });
            box.appendChild(fr);
        });
        if (c.fm) { // 大提交截断提示（服务端每提交限 200 文件防 JSON 膨胀）
            var fm = document.createElement('div');
            fm.className = 'ws-git-log-file fm-more';
            fm.textContent = '文件过多，仅显示前 200 个';
            box.appendChild(fm);
        }
        item.appendChild(box);
        var setOpen = function (on) { // 展开状态记在 g.logOpen（hash→bool），全量重渲染/分页追加后保持
            g.logOpen[c.h] = on;
            item.classList.toggle('open', on);
            box.style.display = on ? '' : 'none';
            if (files.length) arrow.textContent = on ? '▾' : '▸';
        };
        head.addEventListener('click', function () { setOpen(!g.logOpen[c.h]); });
        if (g.logOpen[c.h]) setOpen(true);
        head.addEventListener('mouseenter', function () { wsGitCommitCardShow(head, c); });
        head.addEventListener('mouseleave', wsGitCommitCardHide);
        return item;
    }

    // 提交详情悬浮卡（TRAE CN 同款）：悬停提交行 400ms 弹出——作者+相对/绝对时间、完整提交信息（标题+正文）、
    // 增删统计、短 hash 复制。单例复用防频繁创建；移出行 250ms 后隐藏（允许移入卡内），卡自身移出立即隐藏。
    // 内容全部 DOM+textContent 构建（提交信息来自 git 任意输入，防注入）
    var wsGitCardEl = null, wsGitCardShowTimer = null, wsGitCardHideTimer = null;
    function wsGitCommitCardShow(anchor, c) {
        clearTimeout(wsGitCardHideTimer);
        clearTimeout(wsGitCardShowTimer);
        wsGitCardShowTimer = setTimeout(function () {
            if (!wsGitCardEl) {
                wsGitCardEl = document.createElement('div');
                wsGitCardEl.className = 'ws-git-commit-card';
                wsGitCardEl.addEventListener('mouseenter', function () { clearTimeout(wsGitCardHideTimer); });
                wsGitCardEl.addEventListener('mouseleave', wsGitCommitCardHide);
                document.body.appendChild(wsGitCardEl);
                if (window._osbInit) window._osbInit(wsGitCardEl); // 卡内容超高可滚动（原生滚动条全局隐藏，统一自绘悬浮滑块）
            }
            var card = wsGitCardEl;
            card.textContent = '';
            var au = document.createElement('div');
            au.className = 'wc-author';
            var av = document.createElement('span');
            av.className = 'wc-avatar';
            av.textContent = (c.an || '?').slice(0, 1).toUpperCase();
            var an = document.createElement('b');
            an.textContent = c.an || '';
            var tm = document.createElement('span');
            tm.className = 'wc-time';
            tm.textContent = wsGitRelTime(c.at) + ' (' + wsGitAbsTime(c.at) + ')';
            au.appendChild(av);
            au.appendChild(an);
            au.appendChild(tm);
            card.appendChild(au);
            var ms = document.createElement('div');
            ms.className = 'wc-msg';
            ms.textContent = c.msg || '';
            card.appendChild(ms);
            if (c.body) { // 提交正文（git %b，可为空）
                var bd = document.createElement('div');
                bd.className = 'wc-body';
                bd.textContent = c.body;
                card.appendChild(bd);
            }
            // 统计行：仅有文件数/增删数据时显示（PC 本地执行器旧版不带 c.n/c.files，此时跳过，
            // 不能引用 files——本函数在 wsGitLogRow 外，files 不在作用域，实测 ReferenceError 导致卡中断构建永不显示）
            if (c.n != null || c.files) {
                var st = document.createElement('div');
                st.className = 'wc-stat';
                var n = c.n != null ? c.n : (c.files || []).length;
                st.appendChild(document.createTextNode('已更改 ' + n + ' 个文件，'));
                var ins = document.createElement('span');
                ins.className = 'wc-ins';
                ins.textContent = (c.ins || 0) + ' 行插入(+)';
                var dl = document.createElement('span');
                dl.className = 'wc-del';
                dl.textContent = (c.del || 0) + ' 行删除(-)';
                st.appendChild(ins);
                st.appendChild(document.createTextNode('，'));
                st.appendChild(dl);
                card.appendChild(st);
            }
            var hr = document.createElement('div');
            hr.className = 'wc-hash';
            var cd = document.createElement('code');
            cd.textContent = c.sh || (c.h || '').slice(0, 7);
            var cp = document.createElement('button');
            cp.type = 'button';
            cp.textContent = '复制 hash';
            cp.addEventListener('click', function () {
                navigator.clipboard.writeText(c.h || '').then(function () { showToast('已复制提交 hash'); }, function () { showToast('复制失败'); });
            });
            hr.appendChild(cd);
            hr.appendChild(cp);
            card.appendChild(hr);
            card.style.display = 'block';
            // 定位：行右侧（面板外空档），右侧放不下换左侧；垂直夹取在视口内
            var r = anchor.getBoundingClientRect();
            var cw = 380, ch = card.offsetHeight;
            var left = r.right + 10;
            if (left + cw > window.innerWidth - 8) left = Math.max(8, r.left - cw - 10);
            if (left + cw > window.innerWidth - 8) left = window.innerWidth - cw - 8;
            var top = Math.min(Math.max(8, r.top - 10), Math.max(8, window.innerHeight - ch - 8));
            card.style.left = left + 'px';
            card.style.top = top + 'px';
        }, 400);
    }
    function wsGitCommitCardHide() {
        clearTimeout(wsGitCardShowTimer);
        clearTimeout(wsGitCardHideTimer);
        wsGitCardHideTimer = setTimeout(function () {
            if (wsGitCardEl) wsGitCardEl.style.display = 'none';
        }, 250);
    }

    // 相对时间（详情卡用，TRAE CN 同款）：刚刚/N 分钟前/N 小时前/N 天前/日期
    function wsGitRelTime(at) {
        var diff = Date.now() - (at || 0) * 1000;
        if (diff < 60e3) return '刚刚';
        if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
        if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
        if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
        return wsGitAbsTime(at);
    }

    // 绝对时间（详情卡用）：2026年9月11日 09:03
    function wsGitAbsTime(at) {
        var d = new Date((at || 0) * 1000);
        function p(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // 文件语言短徽标（TRAE CN 同款风格：JS/TS/GO/MD/#…），未知扩展名显示占位点
    function wsGitFileBadge(path) {
        var name = path.replace(/^.*[\\/]/, '');
        var ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
        var map = { js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', jsx: 'JSX', tsx: 'TSX', go: 'GO', md: 'MD', json: '{}', html: '<>', htm: '<>', css: '#', scss: '#', less: '#', py: 'PY', java: 'JA', c: 'C', h: 'H', cpp: 'C+', cc: 'C+', hpp: 'C+', cs: 'C#', rs: 'RS', php: 'PHP', rb: 'RB', sh: 'SH', bat: 'BAT', cmd: 'BAT', ps1: 'PS', yaml: 'Y', yml: 'Y', toml: 'T', sql: 'SQL', vue: 'VUE', xml: 'XML', svg: 'SVG', lua: 'LUA', swift: 'SW', kt: 'KT', txt: 'T', log: 'T' };
        return map[ext] || '•';
    }

    // 点击提交展开列表中的文件：打开该提交内单文件 diff 标签（git show <hash> -- <path>）
    function wsPanelGitOpenCommitFile(c, p) {
        var sh = c.sh || (c.h || '').slice(0, 7);
        var key = 'cfile:' + c.h + ':' + p;
        if (wsPcViewer()) { // PC：提交单文件 diff 进浏览区标签（阶段九十二）
            wsPanelGitReq({ sub: 'show', path: c.h, file: p }).then(function (d) {
                wsOpenData({ key: key, kind: 'commit', title: '提交: ' + sh + ' · ' + p.replace(/^.*[\\/]/, ''), content: d.diff || '', meta: d.meta || {} });
            }).catch(function (err) {
                showToast('提交详情获取失败：' + (err && err.message || err));
            });
            return;
        }
        wsPanel.viewEl.classList.remove('hidden');
        if (wsPanel.tabOrder.indexOf(key) < 0) wsPanel.tabOrder.push(key);
        wsPanel.tabs[key] = { name: '提交: ' + sh + ' · ' + p.replace(/^.*[\\/]/, ''), commitView: true, diffPath: sh, loading: true }; // 重开即刷新
        wsPanelActivate(key);
        wsPanelSyncViewCol();
        wsPanelGitReq({ sub: 'show', path: c.h, file: p }).then(function (d) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            t.loading = false;
            t.commitMeta = d.meta || {};
            t.diffText = d.diff || '';
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        }).catch(function (err) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            t.loading = false;
            t.error = err && err.message || String(err);
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        });
    }

    // 点击时间线条目：打开提交详情标签（元信息头 + 全量 diff）
    function wsPanelGitOpenCommit(c) {
        var sh = c.sh || (c.h || '').slice(0, 7);
        var key = 'show:' + c.h;
        if (wsPcViewer()) { // PC：提交详情进浏览区标签（阶段九十二）
            wsPanelGitReq({ sub: 'show', path: c.h }).then(function (d) {
                wsOpenData({ key: key, kind: 'commit', title: '提交: ' + sh, content: d.diff || '', meta: d.meta || {} });
            }).catch(function (err) {
                showToast('提交详情获取失败：' + (err && err.message || err));
            });
            return;
        }
        wsPanel.viewEl.classList.remove('hidden');
        if (wsPanel.tabOrder.indexOf(key) < 0) wsPanel.tabOrder.push(key);
        wsPanel.tabs[key] = { name: '提交: ' + sh, commitView: true, diffPath: sh, loading: true }; // 重开即刷新
        wsPanelActivate(key);
        wsPanelSyncViewCol();
        wsPanelGitReq({ sub: 'show', path: c.h }).then(function (d) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            t.loading = false;
            t.commitMeta = d.meta || {};
            t.diffText = d.diff || '';
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        }).catch(function (err) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            t.loading = false;
            t.error = err && err.message || String(err);
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        });
    }

    // 点击变更文件：跟踪中 → diff 预览标签；未跟踪 → 直接打开文件预览。
    // p 是 git 视角路径（相对项目根）：文件面板 open/read 需要 fs 视角（带 proj/ 前缀）
    function wsPanelGitOpenDiff(p, e) {
        if (e && (e.x === '?' || e.y === '?')) { wsOpenFile(wsProjFsPath(p)); return; }
        if (wsPcViewer()) { // PC：diff 进浏览区标签（阶段九十二）
            var diffKey = 'diff:' + p;
            // 工作树对比标题（Trae/VSCode 同款语义）：文件名 +（工作树）后缀，区别于历史版本对比
            var diffTitle = p.replace(/^.*[\\/]/, '') + '（工作树）';
            // diffopen：-U100000 全文上下文 diff → 浏览区还原整文件对比（普通 diff 只有变更片段）
            wsPanelGitReq({ sub: 'diffopen', path: p }).then(function (d) {
                wsOpenData({ key: diffKey, kind: 'diff', title: diffTitle, content: d.diff || '', meta: { path: p } });
            }).catch(function (err) {
                var msg = err && err.message || String(err);
                // 仓库已 init 但尚无任何提交（HEAD 不存在）：以"整文件新增"为对比基线（Trae/VSCode 同款语义）
                if (/bad revision 'HEAD'/i.test(msg)) {
                    wsPanelReq('read', wsProjFsPath(p)).then(function (res) {
                        if (res.binary) { showToast('仓库尚未有任何提交，二进制文件暂无对比基线'); return; }
                        var lines = (res.content || '').split('\n');
                        if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 去掉结尾换行产生的空串
                        var pseudo = ['diff --git a/' + p + ' b/' + p, '--- /dev/null', '+++ b/' + p,
                            '@@ -0,0 +1,' + lines.length + ' @@'];
                        lines.forEach(function (l) { pseudo.push('+' + l); });
                        wsOpenData({ key: diffKey, kind: 'diff', title: diffTitle, content: pseudo.join('\n'), meta: { path: p } });
                    }).catch(function () {
                        showToast('仓库尚未有任何提交，暂无对比基线');
                    });
                    return;
                }
                // 非 git 仓库：友好提示，不暴露 git 原始报错
                if (/not a git repository/i.test(msg)) msg = '当前工作区不是 Git 仓库，无法对比差异';
                showToast('diff 获取失败：' + msg);
            });
            return;
        }
        var key = 'diff:' + p;
        wsPanel.viewEl.classList.remove('hidden');
        var idx = wsPanel.tabOrder.indexOf(key);
        if (idx < 0) wsPanel.tabOrder.push(key);
        wsPanel.tabs[key] = { name: p.replace(/^.*[\\/]/, '') + '（工作树）', diffPath: p, loading: true }; // 重开即刷新 diff
        wsPanelActivate(key);
        wsPanelSyncViewCol();
        // diffopen：-U100000 全文上下文 diff → 面板 diff 全文渲染（普通 diff 只有变更片段）
        wsPanelGitReq({ sub: 'diffopen', path: p }).then(function (d) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            t.loading = false;
            t.diffText = d.diff || '';
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        }).catch(function (err) {
            var t = wsPanel.tabs[key];
            if (!t) return;
            var msg = err && err.message || String(err);
            // 仓库已 init 但尚无任何提交（HEAD 不存在）：以"整文件新增"为对比基线（Trae/VSCode 同款语义）
            if (/bad revision 'HEAD'/i.test(msg)) {
                wsPanelReq('read', wsProjFsPath(p)).then(function (res) {
                    var tt = wsPanel.tabs[key];
                    if (!tt) return;
                    tt.loading = false;
                    if (res.binary) { tt.error = '仓库尚未有任何提交，二进制文件暂无对比基线'; }
                    else {
                        var lines = (res.content || '').split('\n');
                        if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 去掉结尾换行产生的空串
                        var pseudo = ['diff --git a/' + p + ' b/' + p, '--- /dev/null', '+++ b/' + p,
                            '@@ -0,0 +1,' + lines.length + ' @@'];
                        lines.forEach(function (l) { pseudo.push('+' + l); });
                        tt.diffText = pseudo.join('\n');
                    }
                    if (wsPanel.activeTab === key) wsPanelRenderTab();
                }).catch(function () {
                    var tt = wsPanel.tabs[key];
                    if (!tt) return;
                    tt.loading = false;
                    tt.error = '仓库尚未有任何提交，暂无对比基线';
                    if (wsPanel.activeTab === key) wsPanelRenderTab();
                });
                return;
            }
            // 非 git 仓库：友好提示，不暴露 git 原始报错
            if (/not a git repository/i.test(msg)) msg = '当前工作区不是 Git 仓库，无法对比差异';
            t.loading = false;
            t.error = msg;
            if (wsPanel.activeTab === key) wsPanelRenderTab();
        });
    }

    // 未跟踪文件清单（10 秒 TTL 缓存）：diff 为空时判断"新文件整绿"用；失败静默回空清单
    function wsPanelGitUntracked() {
        var g = wsPanel.git;
        var now = Date.now();
        if (g.untrackedCache && now - g.untrackedCache.t < 10000) return Promise.resolve(g.untrackedCache.list);
        return wsPanelGitReq({ sub: 'untracked' }).then(function (d) {
            var list = d.files || [];
            g.untrackedCache = { t: now, list: list };
            return list;
        });
    }

    // 文件预览 git 变更装饰（Trae CN 同款）：后台拉该文件 diff 解析行级变更，存 t.gitDecor 供渲染；
    // 新增/修改行绿底、删除位置行号栏红条。任何 git 错误静默降级（不是仓库/无提交/未装 git 均不出提示）
    function wsPanelLoadGitDecor(path) {
        var t = wsPanel.tabs[path];
        if (!t) return;
        var apply = function (decor) {
            var tt = wsPanel.tabs[path];
            if (!tt) return;
            tt.gitDecor = decor;
            // 仅当前激活标签且非编辑态时重渲染；恢复纵横滚动位置防长文件跳顶
            if (wsPanel.activeTab === path && !wsPanel.editing) {
                var vb = wsPanel.viewBody;
                var oldWrap = vb.querySelector('.ws-code-wrap');
                var st = vb.scrollTop, sl = oldWrap ? oldWrap.scrollLeft : 0;
                wsPanelRenderTab();
                vb.scrollTop = st;
                var nw = vb.querySelector('.ws-code-wrap');
                if (nw) nw.scrollLeft = sl;
            }
        };
        // 未跟踪新文件 → 整文件标绿（Trae 同款）：未跟踪清单带 TTL 缓存，未命中/失败静默
        var tryUntrackedAllGreen = function () {
            var key = String(path).replace(/\\/g, '/');
            wsPanelGitUntracked().then(function (files) {
                var tt = wsPanel.tabs[path];
                if (!tt) return;
                var hit = (files || []).some(function (f) { return String(f).replace(/\\/g, '/') === key; });
                if (!hit) return;
                var n = (tt.content || '').split('\n').length;
                var all = new Set();
                for (var i = 0; i < n; i++) all.add(i);
                apply({ added: all, deleted: [] });
            }).catch(function () {});
        };
        wsPanelGitReq({ sub: 'diff', path: path }).then(function (d) {
            if (!wsPanel.tabs[path]) return; // 标签已关闭：丢弃迟到响应
            var decor = wsParseDiffHunks(d.diff || '');
            if (decor.added.size || decor.deleted.length) { apply(decor); return; }
            tryUntrackedAllGreen(); // diff 为空：可能整文件未跟踪（新文件）
        }).catch(function () {
            // diff 失败（全新仓库无提交 HEAD 不存在/非仓库）：仍可识别未跟踪新文件整绿
            if (!wsPanel.tabs[path]) return;
            tryUntrackedAllGreen();
        });
    }


    // 拉取并渲染一级目录（path 为空=工作区根；子路径用 / 拼接）
    function wsPanelLoadDir(path, container) {
        container.textContent = '';
        var loading = document.createElement('div');
        loading.className = 'ws-panel-hint';
        loading.textContent = '加载中…';
        container.appendChild(loading);
        wsPanelReq('tree', path).then(function (res) {
            if (path === (wsPanel.proj || '') && wsPanel.rootEl) {
                wsPanel.root = res.root || '';
                wsPanelProjSyncLabel();
            }
            container.textContent = '';
            if (!res.entries || !res.entries.length) {
                var empty = document.createElement('div');
                empty.className = 'ws-panel-hint';
                empty.textContent = '（空目录）';
                container.appendChild(empty);
                return;
            }
            res.entries.forEach(function (en) {
                container.appendChild(wsPanelMakeRow(path, en));
            });
        }).catch(function (err) {
            container.textContent = '';
            var tip = document.createElement('div');
            tip.className = 'ws-panel-hint';
            tip.textContent = '加载失败：' + (err && err.message || err);
            container.appendChild(tip);
        });
    }

    // 生成一行（目录可展开懒加载；文件点击预览；带 新/改 角标）
    // 结构：row（块级）= head（flex 行：箭头+图标+名称）+ kids（子节点缩进容器，目录独有）
    // 修复：原 kids 直接塞进 flex row 被横排到目录名右侧（层级深了视觉错乱），现 head/kids 分层标准缩进树
    function wsPanelMakeRow(parentPath, en) {
        var selfPath = parentPath ? parentPath + '/' + en.name : en.name;
        var row = document.createElement('div');
        row.className = 'ws-row ' + (en.dir ? 'dir' : 'file');
        var head = document.createElement('div');
        head.className = 'ws-row-head';
        head.title = en.name + (en.dir ? '' : '（' + (en.size || 0) + ' 字节）');
        var arrow = document.createElement('span');
        arrow.className = 'ws-row-arrow';
        arrow.textContent = en.dir ? '▸' : '';
        var icon = wsMakeFileIcon(en); // 按扩展名出彩色语言徽标（Trae CN 同款）
        var name = document.createElement('span');
        name.className = 'ws-row-name';
        name.textContent = en.name;
        head.appendChild(arrow);
        head.appendChild(icon);
        head.appendChild(name);
        row.appendChild(head);
        // 右键菜单（Trae CN 同款）：文件/目录通用，阻止冒泡防树空白区处理器覆盖为根级菜单
        head.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            wsPanelShowCtx(e, selfPath, !!en.dir);
        });
        if (!en.dir) {
            wsPanel.fileRows[selfPath] = head;
            if (wsPanel.badges[selfPath]) head.classList.add(wsPanel.badges[selfPath] === 'new' ? 'badge-new' : 'badge-mod');
            head.addEventListener('click', function () {
                Array.prototype.forEach.call(wsPanel.treeEl.querySelectorAll('.ws-row-head.active'), function (el) { el.classList.remove('active'); });
                head.classList.add('active');
                wsOpenFile(selfPath); // PC 进浏览区标签，Web/手机走 wsPanel（阶段九十二）
            });
            return row;
        }
        var kids = document.createElement('div');
        kids.className = 'ws-row-kids hidden';
        wsPanel.dirRows[selfPath] = { arrow: arrow, kids: kids, head: head }; // head 引用：程序化展开时补 open 样式
        head.addEventListener('click', function () {
            var key = selfPath;
            if (wsPanel.expanded[key]) {
                wsPanel.expanded[key] = false;
                kids.classList.add('hidden');
                arrow.textContent = '▸';
                head.classList.remove('open');
            } else {
                wsPanel.expanded[key] = true;
                if (!kids.dataset.loaded) {
                    kids.dataset.loaded = '1';
                    wsPanelLoadDir(key, kids);
                }
                kids.classList.remove('hidden');
                arrow.textContent = '▾';
                head.classList.add('open');
            }
        });
        // 刷新后恢复展开态（懒加载链式自动重建整棵展开子树）
        if (wsPanel.expanded[selfPath]) {
            kids.dataset.loaded = '1';
            wsPanelLoadDir(selfPath, kids);
            arrow.textContent = '▾';
            head.classList.add('open');
            kids.classList.remove('hidden');
        }
        row.appendChild(kids);
        return row;
    }

    // 绝对路径 → 相对工作区键（根前缀剥离；无法归一化返回 null，仅触发刷新不打角标）
    function wsPanelNormalizeKey(p) {
        var key = String(p || '').trim().replace(/\\/g, '/');
        if (!key) return null;
        if (!wsPanel.root) return null;
        var rootN = wsPanel.root.replace(/\\/g, '/').replace(/\/+$/, '');
        var lowKey = key.toLowerCase(), lowRoot = rootN.toLowerCase();
        if (lowKey === lowRoot) return '';
        if (lowKey.indexOf(lowRoot + '/') === 0) return key.slice(rootN.length + 1);
        if (key.indexOf('/') === 0 || /^[a-zA-Z]:/.test(key)) return null; // 工作区外绝对路径
        return key; // 已是相对路径
    }

    // 工具写入/编辑文件：打角标（addAgentTool 工具开始时调用）
    function wsPanelTouchPath(path, kind) {
        var key = wsPanelNormalizeKey(path);
        if (!key && key !== '') return;
        wsPanel.badges[key] = kind;
        var row = wsPanel.fileRows[key];
        if (row) row.classList.add(kind === 'new' ? 'badge-new' : 'badge-mod');
    }

    // 工具结果到达：刷新树 + TRAE 同款自动打开该文件（面板可见时）；已开标签强制重读磁盘最新内容
    // 路径取值：tool_result 不带 params（服务端只回 tool/ok/output），回退用 tool_start 时按工具名记下的路径
    function wsPanelOnToolResult(ev) {
        if (!wsPanel.visible && !wsPcViewer()) return;
        if (ev.tool !== 'write_file' && ev.tool !== 'edit_file' && ev.tool !== 'delete_file') return;
        var path = (ev.params && ev.params.path) || wsPanel.lastToolPath[ev.tool] || '';
        var key = wsPanelNormalizeKey(path);
        if (ev.tool === 'delete_file') {
            wsPanelRefreshTree(); // 无论成败先刷新树对齐磁盘实际
            if (ev.ok === false || key === null) return; // 删除失败/路径无法归一化：仅刷新
            if (wsPcViewer()) { // PC：联动关闭对应浏览区文件标签（含子路径，删目录场景）
                (browserLastState && browserLastState.tabs || []).forEach(function (t) {
                    if (t.kind === 'file' && t.file_name && (t.file_name === key || t.file_name.indexOf(key + '/') === 0)) {
                        window.desktop.browserCloseTab(t.id);
                    }
                });
            }
            wsPanelForgetKey(key); // 删除成功：清该路径（含子路径，删目录场景）角标/符号缓存/展开态，关闭相关预览标签
            return;
        }
        if (key || key === '') {
            delete wsPanel.symTab[key]; // 文件被工具改写，符号缓存失效（下次渲染/扫描重建）
            if (wsPcViewer()) {
                wsOpenFile(key, true); // PC：浏览区标签复用重读磁盘最新（未开则自动打开，TRAE 同款）
            } else {
                Array.prototype.forEach.call(wsPanel.treeEl.querySelectorAll('.ws-row-head.active'), function (el) { el.classList.remove('active'); });
                wsPanelOpen(key, true); // 重载：工具已改磁盘，丢弃旧内容/草稿读最新
            }
        }
        wsPanelRefreshTree();
    }

    // 路径失效清理（工具删除/右键删除/重命名后调用）：清该路径（含子路径，目录场景）的
    // 角标/符号缓存/展开态，并关闭相关预览标签（关闭后自动激活相邻标签）
    function wsPanelForgetKey(key) {
        if (!key && key !== '') return;
        var low = (key || '').toLowerCase();
        var lowDir = low ? low + '/' : '';
        var isHit = function (k) { var lk = k.toLowerCase(); return lk === low || (lowDir && lk.indexOf(lowDir) === 0); };
        Object.keys(wsPanel.tabs).forEach(function (t) { if (isHit(t)) wsPanelCloseTab(t); });
        [wsPanel.badges, wsPanel.symTab, wsPanel.expanded].forEach(function (m) {
            Object.keys(m).forEach(function (k) { if (isHit(k)) delete m[k]; });
        });
    }

    // 局部刷新指定目录层级（key=''=根）：右键新建/重命名/删除后只刷该层，
    // 不整棵重建（保留其他目录展开态）；父级未渲染时回退整树刷新
    function wsPanelRefreshDir(key) {
        if (key === '') {
            wsPanelLoadDir(wsPanel.proj || '', wsPanel.treeEl);
            return;
        }
        var d = wsPanel.dirRows[key];
        if (d) {
            d.kids.dataset.loaded = '1';
            wsPanelLoadDir(key, d.kids);
        } else {
            wsPanelRefreshTree();
        }
    }

    // 新建内容落在目录后：刷新该层并确保目录展开（新条目立即可见）
    function wsPanelExpandAndRefresh(key) {
        wsPanelRefreshDir(key);
        var d = wsPanel.dirRows[key];
        if (d && !wsPanel.expanded[key]) {
            wsPanel.expanded[key] = true;
            d.kids.classList.remove('hidden');
            d.arrow.textContent = '▾';
            d.head.classList.add('open');
        }
    }

    // ===== 工作区文件右键菜单（Trae CN 同款）：打开/所在目录/复制路径/重命名/删除/新建/刷新 =====
    // 菜单挂 body（fixed 贴光标，不受面板 overflow 裁剪），项目按目标类型（文件/目录/根空白）动态装配
    function wsPanelCtxClose() {
        if (wsPanel.ctxMenu) wsPanel.ctxMenu.classList.add('hidden');
    }
    function wsPanelShowCtx(e, path, isDir) {
        var m = wsPanel.ctxMenu;
        if (!m) return;
        m.textContent = '';
        var add = function (ico, txt, fn, danger) {
            var it = document.createElement('div');
            it.className = 'ws-more-item' + (danger ? ' danger' : '');
            var i = document.createElement('span');
            i.className = 'ws-more-ico';
            i.textContent = ico;
            var t = document.createElement('span');
            t.className = 'ws-more-txt';
            t.textContent = txt;
            it.appendChild(i);
            it.appendChild(t);
            it.addEventListener('click', function () { wsPanelCtxClose(); fn(); });
            m.appendChild(it);
        };
        // 请求封装：失败 toast（错误信息由 PC 执行器/服务端归口返回，前端只透传）
        var req = function (op, p, content, done) {
            wsPanelReq(op, p, content).then(function (r) {
                if (!r.ok) { showToast(r.error || '操作失败'); return; }
                if (done) done();
            }).catch(function (err) { showToast('操作失败：' + (err && err.message || err)); });
        };
        var name = path.replace(/^.*[\\/]/, '') || '工作区根目录';
        var parent = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';

        if (!isDir) add('📄', '打开', function () { wsOpenFile(path); }); // PC 进浏览区标签，Web/手机走 wsPanel
        // 打开所在目录/复制路径需具体目标（文件或目录），树空白区右键（path=''）无意义不显示
        if (path) add('📂', '打开所在目录', function () { req('reveal', path, ''); });
        if (path) add('🔗', '复制路径', function () {
            var full = path ? (wsPanel.root ? wsPanel.root.replace(/[\\/]+$/, '') + '/' + path : path) : (wsPanel.root || '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(full).then(function () { showToast('路径已复制'); }, function () { showToast('复制失败'); });
            } else showToast('当前环境不支持复制');
        });
        if (isDir) {
            add('📄', '新建文件', function () {
                showPrompt('新建文件', '位于 ' + name, function (val) {
                    req('newfile', path, val, function () { wsPanelExpandAndRefresh(path); });
                });
            });
            add('📁', '新建文件夹', function () {
                showPrompt('新建文件夹', '位于 ' + name, function (val) {
                    req('newdir', path, val, function () { wsPanelExpandAndRefresh(path); });
                });
            });
        }
        if (path) add('✏️', '重命名', function () {
            showPrompt('重命名', '当前：' + name, function (val) {
                req('rename', path, val, function () {
                    var newKey = parent ? parent + '/' + val : val;
                    wsPanelForgetKey(path);   // 旧键失效：关旧标签清缓存
                    wsPanelForgetKey(newKey); // 防旧角标/缓存挂到新键
                    wsPanelRefreshDir(parent);
                });
            });
        });
        if (path) add('🗑', '删除', function () {
            showConfirm('删除' + (isDir ? '目录' : '文件'),
                '确定删除「' + name + '」吗？' + (isDir ? '目录内全部内容将被删除，' : '') + '该操作不可恢复。',
                function () {
                    req('delete', path, '', function () {
                        wsPanelForgetKey(path);
                        wsPanelRefreshDir(parent);
                    });
                });
        }, true);
        if (isDir) add('🔄', '刷新', function () { wsPanelRefreshDir(path); });

        // 先渲染测尺寸再钳位，防视口下缘/右缘溢出
        m.classList.remove('hidden');
        m.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - m.offsetHeight - 8)) + 'px';
        m.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - m.offsetWidth - 8)) + 'px';
    }

    // ===== 阶段九十二：文件查看归口（TRAE CN 化） =====
    // PC 端（desktop 桥具备 browserOpenFile）所有文件查看/预览/编辑、git diff、提交详情、
    // 审查报告统一进内置浏览区标签；Web/手机端（无桥）走 wsPanel 原路，行为完全不变
    function wsPcViewer() {
        return !!(window.desktop && typeof window.desktop.browserOpenFile === 'function' && typeof window.desktop.browserOpenData === 'function');
    }
    // 打开工作区文件（浏览区标签：主进程 safePath 校验读盘；同文件复用标签刷新）
    function wsOpenFile(path, forceReload) {
        if (wsPcViewer()) {
            window.desktop.browserOpenFile({ username: IMSocket.getUsername(), path: path }).then(function (r) {
                if (r && !r.ok) showToast('浏览区打开失败：' + (r.error || '未知错误'));
            }).catch(function (e) {
                showToast('浏览区打开失败：' + (e && e.message || e));
            });
            return;
        }
        wsPanelOpen(path, forceReload); // Web/手机原路（forceReload 仅 wsPanel 语义需要）
    }
    // 打开直传内容标签（diff/提交详情/审查报告）：payload = {key?, kind, title, content, meta?}。
    // key 相同复用标签刷新（重开即刷新语义）。PC 走浏览区返回 true；Web/手机返回 false 由调用方走原路
    function wsOpenData(payload) {
        if (!wsPcViewer()) return false;
        window.desktop.browserOpenData(payload).then(function (r) {
            if (r && !r.ok) showToast('浏览区打开失败：' + (r.error || '未知错误'));
        }).catch(function (e) {
            showToast('浏览区打开失败：' + (e && e.message || e));
        });
        return true;
    }

    // 打开文件预览（Trae CN 同款标签页）：已打开→激活切换；未打开→建标签读内容。
    // forceReload=true（取消编辑/保存后重读）：丢弃草稿重读磁盘内容
    function wsPanelOpen(path, forceReload) {
        wsPanel.viewEl.classList.remove('hidden');
        if (wsPanel.tabs[path] && !forceReload) {
            wsPanelActivate(path);
            wsPanelSyncViewCol(); // 先激活再同步：首开时 activeTab 在此刻才就位，提前同步会误判"无标签"把中栏藏掉
            return;
        }
        if (!wsPanel.tabs[path]) {
            wsPanel.tabs[path] = { name: path.replace(/^.*[\\/]/, ''), loading: true };
            wsPanel.tabOrder.push(path);
        } else {
            wsPanel.tabs[path] = { name: path.replace(/^.*[\\/]/, ''), loading: true }; // 重载：清旧内容与草稿
        }
        wsPanelActivate(path);
        wsPanelSyncViewCol(); // 先激活再同步（同上）
        var extOpen = (path.replace(/^.*\./, '') || '').toLowerCase();
        // Office 文档走二进制读取 + 前端解析预览（Trae CN 同款）：docx=mammoth / xlsx=SheetJS / pptx=PptxViewJS
        var docKinds = { docx: 'isDocx', docm: 'isDocx', xlsx: 'isXlsx', xlsm: 'isXlsx', pptx: 'isPptx', pptm: 'isPptx' };
        if (docKinds[extOpen]) {
            wsPanel.tabs[path][docKinds[extOpen]] = true;
            wsPanelLoadBin(path); // 统一 base64 读通道（PC IPC 直读 / 浏览器 62 readb）
            return;
        }
        wsPanelReq('read', path).then(function (res) {
            var t = wsPanel.tabs[path];
            if (!t) return; // 标签已被关闭，丢弃迟到响应
            t.loading = false;
            t.binary = !!res.binary;
            t.truncated = !!res.truncated;
            t.content = res.content || '';
            t.error = '';
            var ext = (path.replace(/^.*\./, '') || '').toLowerCase();
            t.isMd = ext === 'md' || ext === 'markdown'; // MD 文件走渲染预览（Trae CN 同款）
            if (!t.binary && !t.isMd) wsPanelLoadGitDecor(path); // git 变更装饰（后台静默，失败无感）
            if (wsPanel.activeTab === path) wsPanelRenderTab();
        }).catch(function (err) {
            var t = wsPanel.tabs[path];
            if (!t) return;
            t.loading = false;
            t.error = (err && err.message || err);
            if (wsPanel.activeTab === path) wsPanelRenderTab();
        });
    }

    // base64 → ArrayBuffer（docx 等二进制文档前端解析用）
    function wsB64ToBuf(b64) {
        var bin = atob(b64 || '');
        var buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    }

    // Office 文档（docx/xlsx/pptx）读取：PC 端直接 IPC 读本地文件（绕 WS 帧限），浏览器端走 62 readb（服务端/PC 转发，≤2MB）
    // 结果为 base64 存 t.b64，渲染时各解析器消费（解析结果缓存，切标签秒开）
    function wsPanelLoadBin(path) {
        var done = function (b64) {
            var t = wsPanel.tabs[path];
            if (!t) return;
            t.loading = false;
            t.b64 = b64 || '';
            if (wsPanel.activeTab === path) wsPanelRenderTab();
        };
        var fail = function (err) {
            var t = wsPanel.tabs[path];
            if (!t) return;
            t.loading = false;
            t.error = (err && err.message || err) || '读取失败';
            if (wsPanel.activeTab === path) wsPanelRenderTab();
        };
        if (window.desktop && window.desktop.workspaceOp) {
            window.desktop.workspaceOp({ username: IMSocket.getUsername(), op: 'readb', path: path }).then(function (r) {
                if (r && r.ok) done(r.content);
                else fail(new Error((r && r.error) || '读取失败'));
            }).catch(fail);
            return;
        }
        wsPanelReq('readb', path).then(function (res) {
            done(res.content || '');
        }).catch(fail);
    }

    // 激活标签（编辑中切走先存草稿，切回恢复编辑态不丢改动）
    function wsPanelActivate(path) {
        if (wsPanel.editing && wsPanel.ta && wsPanel.activeTab && wsPanel.tabs[wsPanel.activeTab]) {
            wsPanel.tabs[wsPanel.activeTab].draft = wsPanel.ta.value; // 草稿随标签留存
        }
        wsPanel.editing = false;
        wsPanel.ta = null;
        wsPanel.activeTab = path;
        wsPanelRenderTabs();
        wsPanelRenderTab();
    }

    // 关闭标签：激活相邻标签；全部关闭收起预览区
    function wsPanelCloseTab(path) {
        var idx = wsPanel.tabOrder.indexOf(path);
        if (idx < 0) return;
        delete wsPanel.tabs[path];
        wsPanel.tabOrder.splice(idx, 1);
        if (wsPanel.activeTab === path) {
            wsPanel.editing = false;
            wsPanel.ta = null;
            wsPanel.activeTab = wsPanel.tabOrder[Math.min(idx, wsPanel.tabOrder.length - 1)] || null;
        }
        if (!wsPanel.activeTab) {
            wsPanel.viewEl.classList.add('hidden');
            wsPanelSyncViewCol(); // 全关后中栏仅当控制台仍展开时保留（控制台停靠预览下方）
            wsPanelRenderTabs();
            return;
        }
        wsPanelRenderTabs();
        wsPanelRenderTab();
    }

    // 渲染标签栏（横向滚动，active 高亮 + 主题色顶条；× 关闭单标签）
    function wsPanelRenderTabs() {
        if (!wsPanel.tabBarEl) return;
        wsPanel.tabBarEl.textContent = '';
        wsPanel.tabOrder.forEach(function (p) {
            var t = wsPanel.tabs[p];
            var tab = document.createElement('div');
            tab.className = 'ws-tab' + (p === wsPanel.activeTab ? ' active' : '');
            tab.title = p;
            tab.appendChild(wsMakeFileIcon({ name: (t && t.name) || p, dir: false })); // 标签前缀文件类型徽标
            var nm = document.createElement('span');
            nm.className = 'ws-tab-name';
            nm.textContent = (t && t.draft !== undefined ? '● ' : '') + (t ? t.name : p); // 有草稿标 ● 提示未保存
            var x = document.createElement('span');
            x.className = 'ws-tab-close';
            x.textContent = '×';
            x.title = '关闭';
            x.addEventListener('click', function (e) { e.stopPropagation(); wsPanelCloseTab(p); });
            tab.appendChild(nm);
            tab.appendChild(x);
            tab.addEventListener('click', function () { if (p !== wsPanel.activeTab) wsPanelActivate(p); });
            wsPanel.tabBarEl.appendChild(tab);
        });
        // 激活标签自动滚入可视区（Trae CN 同款）：标签多到横向溢出时，切换/新开标签后保证当前标签可见
        var act = wsPanel.tabBarEl.querySelector('.ws-tab.active');
        if (act) {
            var al = act.offsetLeft, ar = al + act.offsetWidth, sl = wsPanel.tabBarEl.scrollLeft, cw = wsPanel.tabBarEl.clientWidth;
            if (al < sl + 4) wsPanel.tabBarEl.scrollLeft = al - 4;
            else if (ar > sl + cw - 4) wsPanel.tabBarEl.scrollLeft = ar - cw + 4;
        }
    }

    // 渲染当前标签内容：加载中/错误/二进制提示；MD 走 renderAIMarkdown 渲染（复用 .ai-md 样式：表格/代码块/复制）；
    // 其余源码 hljs 高亮；编辑态 textarea（草稿恢复）
    function wsPanelRenderTab() {
        var path = wsPanel.activeTab;
        var t = path ? wsPanel.tabs[path] : null;
        wsPanel.btnEdit.classList.add('hidden');
        wsPanel.btnSave.classList.add('hidden');
        wsPanel.btnCancel.classList.add('hidden');
        wsPanel.viewBody.textContent = '';
        if (!t) { wsPanel.crumbsEl.textContent = ''; return; }
        // 面包屑路径（Trae CN 同款）：靠左正序显示，逐段 › 分隔，末段文件名高亮；超长省略头部段
        // 标签类型徽标：审查报告 / 提交详情 / 差异对比（普通 diff 标签）
        wsPanel.crumbsEl.textContent = '';
        var badgeText = '';
        if (t.review) badgeText = '审查报告';
        else if (t.commitMeta) badgeText = '提交详情';
        else if (t.diffPath) badgeText = '差异对比';
        if (badgeText) {
            var dbadge = document.createElement('span');
            dbadge.className = 'ws-crumbs-diff';
            dbadge.textContent = badgeText;
            wsPanel.crumbsEl.appendChild(dbadge);
            var dsep = document.createElement('span');
            dsep.className = 'ws-crumbs-sep';
            dsep.textContent = '›';
            wsPanel.crumbsEl.appendChild(dsep);
        }
        // 审查报告：面包屑显示目标分支；其余按路径/短 hash 分段
        var segSrc = t.review ? (t.reviewTarget || t.name) : (t.diffPath || path);
        var segs = segSrc.split(/[\\/]+/).filter(function (s) { return s.length > 0; });
        segs.forEach(function (seg, si) {
            if (si > 0) {
                var sep = document.createElement('span');
                sep.className = 'ws-crumbs-sep';
                sep.textContent = '›';
                wsPanel.crumbsEl.appendChild(sep);
            }
            var it = document.createElement('span');
            it.className = 'ws-crumbs-item' + (si === segs.length - 1 ? ' file' : '');
            it.textContent = seg;
            it.title = path;
            wsPanel.crumbsEl.appendChild(it);
        });
        // 宽度放不下时从头移除段落，最左补 …（保留靠近文件名的尾部段）
        (function fitCrumbs() {
            var el = wsPanel.crumbsEl;
            var guard = 0;
            while (el.scrollWidth > el.clientWidth && el.children.length > 2 && guard++ < 20) {
                el.removeChild(el.firstChild);                       // 首段
                if (el.firstChild && el.firstChild.classList.contains('ws-crumbs-sep')) el.removeChild(el.firstChild); // 随后分隔符
                if (!el.querySelector('.ws-crumbs-ellipsis')) {
                    var dots = document.createElement('span');
                    dots.className = 'ws-crumbs-ellipsis';
                    dots.textContent = '…';
                    el.insertBefore(dots, el.firstChild);
                }
            }
        })();
        var editable = !t.loading && !t.error && !t.binary;
        if (wsPanel.editing && editable) {
            var ta = document.createElement('textarea');
            ta.className = 'ws-edit-ta ws-edit-ta-overlay';
            ta.value = t.draft !== undefined ? t.draft : t.content;
            ta.spellcheck = false;
            ta.wrap = 'off'; // 关闭软换行（长行横向滚动），保证行号与代码行一一对应
            // 编辑态行号列（Trae CN 同款）：输入增删行时同步刷新行号
            var lnCol = document.createElement('div');
            lnCol.className = 'ws-code-ln';
            // 高亮底层：与预览同款 pre+code，透明 textarea 叠加其上（文字透明只留光标/选区，颜色由底层呈现）
            var pre = document.createElement('pre');
            pre.className = 'ws-view-pre ws-edit-pre';
            pre.setAttribute('aria-hidden', 'true');
            var code = document.createElement('code');
            pre.appendChild(code);
            var editStack = document.createElement('div');
            editStack.className = 'ws-edit-body'; // grid 单格叠放：pre 与 ta 同位置同尺寸
            editStack.appendChild(pre);
            editStack.appendChild(ta);
            var editWrap = document.createElement('div');
            editWrap.className = 'ws-code-wrap';
            editWrap.appendChild(lnCol);
            editWrap.appendChild(editStack);
            wsPanel.viewBody.appendChild(editWrap);
            var H = (typeof hljs !== 'undefined') ? hljs : null;
            var extE = (path.replace(/^.*\./, '') || '').toLowerCase();
            var langE = WS_LANG_MAP[extE] || '';
            var hlTimer = null;
            function syncEditLn() {
                var n = ta.value.split('\n').length;
                var s = '';
                for (var i = 1; i <= n; i++) s += i + '\n';
                lnCol.textContent = s;
                // textarea 显式撑到内容高度（纵向滚动由 wrap 承接，行号随之对齐；grid 叠放保证与高亮层同高）
                ta.style.height = 'auto';
                ta.style.height = ta.scrollHeight + 'px';
                pre.style.minHeight = ta.scrollHeight + 'px';
            }
            // 实时重高亮底层（150ms 防抖；hljs 全文重刷，512KB 截断上限内可接受）
            function refreshEditHl() {
                var v = ta.value;
                var done = false;
                if (H && v) {
                    try {
                        code.innerHTML = (langE && H.getLanguage(langE))
                            ? H.highlight(v, { language: langE, ignoreIllegals: true }).value
                            : H.highlightAuto(v).value;
                        done = true;
                    } catch (e) { done = false; }
                }
                if (!done) code.textContent = v;
            }
            ta.addEventListener('input', function () {
                syncEditLn();
                if (hlTimer) clearTimeout(hlTimer);
                hlTimer = setTimeout(refreshEditHl, 150);
            });
            refreshEditHl();
            syncEditLn();
            if (window._osbInit) window._osbInit(editWrap);
            wsPanel.ta = ta;
            wsPanel.btnSave.classList.remove('hidden');
            wsPanel.btnCancel.classList.remove('hidden');
            ta.focus();
            return;
        }
        if (t.truncated) {
            var tip = document.createElement('div');
            tip.className = 'ws-panel-hint';
            tip.textContent = '— 文件较大，仅显示前 512KB，编辑保存将覆盖全文，请注意 —';
            wsPanel.viewBody.appendChild(tip);
        }
        if (t.loading) {
            var hint = document.createElement('div');
            hint.className = 'ws-panel-hint';
            hint.textContent = '加载中…';
            wsPanel.viewBody.appendChild(hint);
            return;
        }
        if (t.error) {
            var errTip = document.createElement('div');
            errTip.className = 'ws-panel-hint';
            errTip.textContent = '读取失败：' + t.error;
            wsPanel.viewBody.appendChild(errTip);
            return;
        }
        if (t.binary) {
            var binTip = document.createElement('div');
            binTip.className = 'ws-panel-hint';
            binTip.textContent = '二进制文件暂不支持面板预览';
            wsPanel.viewBody.appendChild(binTip);
            return;
        }
        // git 差异标签（源代码管理点击文件进入）：unified diff 全文，hljs diff 语法高亮
        //（+行绿/−行红/@@行蓝由 hljs 内置 diff 高亮出色），只读不可编辑
        if (t.diffPath && t.diffText !== undefined) {
            // 提交详情标签（提交历史点击进入）：diff 上方加元信息头（主题/作者/时间/短 hash）
            if (t.commitMeta && t.commitMeta.msg) {
                var cmh = document.createElement('div');
                cmh.className = 'ws-commit-meta';
                var csj = document.createElement('div');
                csj.className = 'ws-commit-subject';
                csj.textContent = t.commitMeta.msg;
                var cif = document.createElement('div');
                cif.className = 'ws-commit-info';
                cif.textContent = (t.commitMeta.an || '') + ' · ' + wsGitFmtTime(t.commitMeta.at) + ' · ' + (t.commitMeta.sh || '');
                cmh.appendChild(csj);
                cmh.appendChild(cif);
                wsPanel.viewBody.appendChild(cmh);
            }
            var dpre = document.createElement('pre');
            dpre.className = 'ws-view-pre ws-diff-pre';
            var dcode = document.createElement('code');
            var DH = (typeof hljs !== 'undefined') ? hljs : null;
            var dOk = false;
            if (DH) {
                try {
                    dcode.innerHTML = DH.highlight(t.diffText, { language: 'diff', ignoreIllegals: true }).value;
                    dOk = true;
                } catch (e) { dOk = false; }
            }
            if (!dOk) dcode.textContent = t.diffText;
            dpre.appendChild(dcode);
            wsPanel.viewBody.appendChild(dpre);
            if (!t.diffText) {
                var noDiff = document.createElement('div');
                noDiff.className = 'ws-panel-hint';
                noDiff.textContent = '— 无差异（文件与上次提交一致，或仅有暂存区外的格式变化）—';
                wsPanel.viewBody.appendChild(noDiff);
            }
            return;
        }
        if (t.isMd) {
            var md = document.createElement('div');
            md.className = 'ws-view-md ai-md'; // 复用 AI 消息 Markdown 全套样式（表格/代码块高亮/复制按钮）
            md.innerHTML = renderAIMarkdown(t.content);
            wsPanel.viewBody.appendChild(md);
            if (!t.review) wsPanel.btnEdit.classList.remove('hidden'); // 审查报告只读，不进入源码编辑
            return;
        }
        if (t.isDocx) { // Word 文档预览：mammoth 转 HTML（复用 ai-md 排版样式），不支持编辑保存
            wsPanel.btnEdit.classList.add('hidden'); // docx 只读，隐藏编辑按钮（防源码标签切来时残留）
            var docTip = document.createElement('div');
            docTip.className = 'ws-panel-hint';
            docTip.textContent = 'Word 文档预览（只读）';
            wsPanel.viewBody.appendChild(docTip);
            if (!t.docHtml) {
                if (typeof mammoth === 'undefined') {
                    var noLib = document.createElement('div');
                    noLib.className = 'ws-panel-hint';
                    noLib.textContent = '文档组件未加载，无法预览';
                    wsPanel.viewBody.appendChild(noLib);
                    return;
                }
                if (!t.b64) {
                    var noData = document.createElement('div');
                    noData.className = 'ws-panel-hint';
                    noData.textContent = '文档数据为空';
                    wsPanel.viewBody.appendChild(noData);
                    return;
                }
                var parsing = document.createElement('div');
                parsing.className = 'ws-panel-hint';
                parsing.textContent = '文档解析中…';
                wsPanel.viewBody.appendChild(parsing);
                (function (p) {
                    mammoth.convertToHtml({ arrayBuffer: wsB64ToBuf(t.b64) }).then(function (r) {
                        var tt = wsPanel.tabs[p];
                        if (!tt) return;
                        tt.docHtml = (r && r.value) || '<p>（空文档）</p>';
                        if (wsPanel.activeTab === p) wsPanelRenderTab();
                    }).catch(function (e) {
                        var tt = wsPanel.tabs[p];
                        if (!tt) return;
                        tt.docHtml = '<p>解析失败：' + (e && e.message || e) + '</p>';
                        if (wsPanel.activeTab === p) wsPanelRenderTab();
                    });
                })(path);
                return;
            }
            var docBody = document.createElement('div');
            docBody.className = 'ws-view-md ai-md ws-view-docx';
            docBody.innerHTML = t.docHtml;
            wsPanel.viewBody.appendChild(docBody);
            return;
        }
        if (t.isXlsx) { // Excel 表格预览：SheetJS 解析（sheet 名切换条 + HTML 表格），只读
            wsPanel.btnEdit.classList.add('hidden');
            var xlsxTip = document.createElement('div');
            xlsxTip.className = 'ws-panel-hint';
            xlsxTip.textContent = 'Excel 表格预览（只读）';
            wsPanel.viewBody.appendChild(xlsxTip);
            if (typeof XLSX === 'undefined') {
                var noX = document.createElement('div');
                noX.className = 'ws-panel-hint';
                noX.textContent = '表格组件未加载，无法预览';
                wsPanel.viewBody.appendChild(noX);
                return;
            }
            if (!t.b64) {
                var noXd = document.createElement('div');
                noXd.className = 'ws-panel-hint';
                noXd.textContent = '文件数据为空';
                wsPanel.viewBody.appendChild(noXd);
                return;
            }
            if (!t.wb) {
                try { t.wb = XLSX.read(wsB64ToBuf(t.b64), { type: 'array' }); }
                catch (e) {
                    var badX = document.createElement('div');
                    badX.className = 'ws-panel-hint';
                    badX.textContent = '解析失败：' + (e && e.message || e);
                    wsPanel.viewBody.appendChild(badX);
                    return;
                }
            }
            var names = t.wb.SheetNames || [];
            if (!names.length) {
                var emptyX = document.createElement('div');
                emptyX.className = 'ws-panel-hint';
                emptyX.textContent = '（空工作簿）';
                wsPanel.viewBody.appendChild(emptyX);
                return;
            }
            if (!t.sheetIdx) t.sheetIdx = 0; // 当前 sheet 下标（切标签后保留）
            var bar = document.createElement('div');
            bar.className = 'ws-xlsx-tabs';
            names.forEach(function (nm, si) {
                var chip = document.createElement('span');
                chip.className = 'ws-xlsx-chip' + (si === t.sheetIdx ? ' active' : '');
                chip.textContent = nm;
                chip.title = '切换到 ' + nm;
                (function (idx) {
                    chip.addEventListener('click', function () {
                        var tt = wsPanel.tabs[path];
                        if (!tt) return;
                        tt.sheetIdx = idx;
                        wsPanelRenderTab();
                    });
                })(si);
                bar.appendChild(chip);
            });
            wsPanel.viewBody.appendChild(bar);
            var xbody = document.createElement('div');
            xbody.className = 'ws-view-md ai-md ws-xlsx-body';
            try {
                var wsObj = t.wb.Sheets[names[t.sheetIdx]];
                xbody.innerHTML = XLSX.utils.sheet_to_html(wsObj, { header: '', footer: '' }) || '<p>（空表）</p>';
            } catch (e2) {
                xbody.innerHTML = '<p>渲染失败：' + (e2 && e2.message || e2) + '</p>';
            }
            wsPanel.viewBody.appendChild(xbody);
            return;
        }
        if (t.isPptx) { // PPT 幻灯片预览：PptxViewJS Canvas 渲染（翻页工具条），只读
            wsPanel.btnEdit.classList.add('hidden');
            var pptTip = document.createElement('div');
            pptTip.className = 'ws-panel-hint';
            pptTip.textContent = 'PPT 幻灯片预览（只读）';
            wsPanel.viewBody.appendChild(pptTip);
            if (typeof PptxViewJS === 'undefined' || typeof JSZip === 'undefined') {
                var noP = document.createElement('div');
                noP.className = 'ws-panel-hint';
                noP.textContent = '幻灯片组件未加载，无法预览';
                wsPanel.viewBody.appendChild(noP);
                return;
            }
            if (!t.b64) {
                var noPd = document.createElement('div');
                noPd.className = 'ws-panel-hint';
                noPd.textContent = '文件数据为空';
                wsPanel.viewBody.appendChild(noPd);
                return;
            }
            var pptBox = document.createElement('div');
            pptBox.className = 'ws-pptx';
            var pptBar = document.createElement('div');
            pptBar.className = 'ws-pptx-bar';
            var btnPrev = document.createElement('button');
            btnPrev.className = 'ws-pptx-btn';
            btnPrev.textContent = '‹ 上一页';
            var pptIdx = document.createElement('span');
            pptIdx.className = 'ws-pptx-idx';
            pptIdx.textContent = '加载中…';
            var btnNext = document.createElement('button');
            btnNext.className = 'ws-pptx-btn';
            btnNext.textContent = '下一页 ›';
            pptBar.appendChild(btnPrev);
            pptBar.appendChild(pptIdx);
            pptBar.appendChild(btnNext);
            var canvas = document.createElement('canvas');
            canvas.className = 'ws-pptx-canvas';
            pptBox.appendChild(pptBar);
            pptBox.appendChild(canvas);
            wsPanel.viewBody.appendChild(pptBox);
            (function (p) {
                try {
                    var viewer = new PptxViewJS.PPTXViewer({ canvas: canvas });
                    var blob = new Blob([wsB64ToBuf(t.b64)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
                    var syncIdx = function () {
                        var total = 0, cur = 0;
                        try { total = viewer.getSlideCount(); cur = viewer.getCurrentSlideIndex() + 1; } catch (e) {}
                        pptIdx.textContent = total ? (cur + ' / ' + total) : '—';
                    };
                    viewer.on('slideChanged', syncIdx);
                    viewer.on('renderComplete', syncIdx);
                    viewer.loadFile(blob).then(function () {
                        syncIdx();
                        return viewer.render();
                    }).then(syncIdx).catch(function (e) {
                        pptIdx.textContent = '解析失败：' + (e && e.message || e);
                    });
                    btnPrev.addEventListener('click', function () { viewer.previousSlide().then(syncIdx).catch(function () {}); });
                    btnNext.addEventListener('click', function () { viewer.nextSlide().then(syncIdx).catch(function () {}); });
                } catch (e) {
                    pptIdx.textContent = '加载失败：' + (e && e.message || e);
                }
            })(path);
            return;
        }
        var text = t.content;
        var ext = (path.replace(/^.*\./, '') || '').toLowerCase();
        var lang = WS_LANG_MAP[ext] || '';
        // 源码预览：行号列 + 高亮代码（同字体行高严格对齐，横向滚动时行号 sticky 固定）
        var wrap = document.createElement('div');
        wrap.className = 'ws-code-wrap';
        var ln = document.createElement('div');
        ln.className = 'ws-code-ln';
        var lines = text.split('\n');
        var lnText = '';
        for (var i = 1; i <= lines.length; i++) lnText += i + '\n';
        ln.textContent = lnText;
        var pre = document.createElement('pre');
        pre.className = 'ws-view-pre';
        var code = document.createElement('code');
        var H = (typeof hljs !== 'undefined') ? hljs : null;
        var done = false;
        if (H && text) {
            try {
                if (lang && H.getLanguage(lang)) {
                    code.innerHTML = H.highlight(text, { language: lang, ignoreIllegals: true }).value;
                    done = true;
                } else {
                    var auto = H.highlightAuto(text);
                    code.innerHTML = auto.value;
                    done = true;
                }
            } catch (e) { done = false; }
        }
        if (!done) code.textContent = text;
        pre.appendChild(code);
        wrap.appendChild(ln);
        wrap.appendChild(pre);
        wsPanel.viewBody.appendChild(wrap);
        wsPanelBindCode(wrap, code, t.content, lines.length, path); // 当前行高亮 + 悬停定义提示（文件内+同目录跨文件）
        wsSymScanDir(wsDirOf(path)); // 后台懒扫同目录源码文件符号表（busy 防重，下次悬停生效）
        // 跨文件跳转：目标文件渲染完成后滚到定义行
        if (wsPanel.pendingGoto && wsPanel.pendingGoto.path === path) {
            var gotoLine = wsPanel.pendingGoto.line;
            wsPanel.pendingGoto = null;
            if (wsPanel.codeView) wsPanel.codeView.fixLine(gotoLine);
        }
        wsPanel.btnEdit.classList.remove('hidden');
    }

    // 扫描当前文件内的函数/方法/变量/类型定义（轻量词法级，非 LSP）：悬停标识符命中定义时给提示
    // 提取声明行上方紧邻的连续注释（Go //、Python #）作为文档（Trae CN 同款悬停文档效果），最多 3 行
    function wsDocAbove(rows, i) {
        var docs = [];
        var j = i - 1;
        while (j >= 0 && docs.length < 3) {
            var t = rows[j].trim();
            if (/^\/\/|^#/.test(t) && !/^#!/.test(t)) {
                docs.unshift(t.replace(/^(\/\/+|#)\s?/, ''));
                j--;
            } else break;
        }
        var s = docs.join(' ').trim();
        return s.length > 140 ? s.slice(0, 140) + '…' : s;
    }

    function wsScanDefs(content) {
        var defs = [];
        var rows = content.split('\n');
        // 函数：func/def/function 关键字 + c 系“类型 名(…){”粗匹配（行内无 = 防调用误报）
        var reKw = /^\s*(?:func|def|function)\s+\(?[^)]*\)?\s*\(?\s*([A-Za-z_$][\w$]*)/;
        var reBrace = /^ {0,8}([A-Za-z_][\w$]*(?:::\s*[\w$]+)?)\s*\([^;=]*\)\s*(?:const\s*)?\{?\s*$/;
        // 变量声明：go/js/ts 的 var/const/let NAME（后跟 =、: 或类型）；Go type NAME struct/interface；
        // Python 顶层赋值 NAME = value（非比较、无函数调用括号开头，粗收）
        var reVar = /^\s*(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*(?:[=:]|\s|$)/;
        var reType = /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)?\s*[A-Za-z_{]?/;
        var rePyAssign = /^ {0,4}([A-Za-z_]\w*)\s*=\s*[^=]/;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row.trim() || /^\s*\/\//.test(row) || /^\s*#/.test(row) || /^\s*\*/.test(row)) continue;
            var m = row.match(reKw);
            if (!m && !/[=;]/.test(row)) m = row.match(reBrace);
            if (!m) m = row.match(reVar) || row.match(reType);
            if (!m && /^\s*[A-Za-z_]\w*\s*=[^=]/.test(row) && !/\(\s*$/.test(row)) m = row.match(rePyAssign);
            if (m && m[1] && m[1].length > 1) {
                defs.push({ name: m[1], line: i, sig: row.trim().slice(0, 200), doc: wsDocAbove(rows, i) });
            }
        }
        return defs;
    }

    // ===== 跨文件符号表（懒加载）：打开文件时后台扫描同目录源码文件，悬停提示可跨文件命中并跳转 =====
    var WS_SOURCE_EXTS = ['go', 'js', 'ts', 'py', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'java', 'rs', 'php', 'rb', 'swift', 'kt', 'vue', 'mjs'];
    var WS_SYM_DIR_LIMIT = 40;  // 单目录最多扫描文件数（防大目录洪泛）
    var WS_SYM_CONCURRENCY = 4; // 同时在途的 read 请求数

    function wsDirOf(path) {
        var i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return i < 0 ? '' : path.slice(0, i);
    }

    function wsBaseName(path) {
        return path.replace(/^.*[\\/]/, '');
    }

    function wsIsSourceFile(name) {
        var ext = (name.replace(/^.*\./, '') || '').toLowerCase();
        return WS_SOURCE_EXTS.indexOf(ext) >= 0;
    }

    // 后台扫描目录：tree 拉目录清单 → 过滤源码文件 → 限流并发 read → 符号表入缓存；失败静默（提示降级为文件内级）
    function wsSymScanDir(dir) {
        if (wsPanel.symBusy[dir]) return;
        wsPanel.symBusy[dir] = true;
        wsPanelReq('tree', dir).then(function (res) {
            var entries = (res && res.entries) || [];
            var files = [];
            for (var i = 0; i < entries.length && files.length < WS_SYM_DIR_LIMIT; i++) {
                var en = entries[i];
                if (!en.dir && wsIsSourceFile(en.name)) {
                    var full = dir ? (dir.replace(/[\\/]+$/, '') + '/' + en.name) : en.name;
                    if (!wsPanel.symTab[full]) files.push(full); // 已缓存的跳过（文件被工具改写时按路径精确失效）
                }
            }
            var idx = 0, done = 0;
            function next() {
                if (idx >= files.length) {
                    if (++done >= Math.min(files.length, WS_SYM_CONCURRENCY) || idx >= files.length) delete wsPanel.symBusy[dir];
                    return;
                }
                var p = files[idx++];
                wsPanelReq('read', p).then(function (r) {
                    if (r && !r.binary) wsPanel.symTab[p] = wsScanDefs(r.content || '');
                    next();
                }).catch(next);
            }
            if (files.length === 0) { delete wsPanel.symBusy[dir]; return; }
            for (var k = 0; k < Math.min(WS_SYM_CONCURRENCY, files.length); k++) next();
        }).catch(function () { delete wsPanel.symBusy[dir]; });
    }

    // 符号查找：当前文件优先，其次同目录其他文件（跨文件）；返回 def 附 file 字段
    function wsFindDef(name, curPath) {
        var local = wsPanel.symTab[curPath];
        if (local) {
            for (var i = 0; i < local.length; i++) if (local[i].name === name) {
                return { name: name, line: local[i].line, sig: local[i].sig, doc: local[i].doc, file: curPath };
            }
        }
        var dir = wsDirOf(curPath);
        for (var p in wsPanel.symTab) {
            if (p === curPath || wsDirOf(p) !== dir) continue;
            var arr = wsPanel.symTab[p];
            for (var j = 0; j < arr.length; j++) if (arr[j].name === name) {
                return { name: name, line: arr[j].line, sig: arr[j].sig, doc: arr[j].doc, file: p };
            }
        }
        return null;
    }

    // 跳转到指定文件的指定行（跨文件）：已打开直接滚，未打开先打开，渲染完成后消费 pendingGoto
    function wsPanelGoto(path, line) {
        if (wsPanel.activeTab === path) {
            if (wsPanel.codeView) wsPanel.codeView.fixLine(line);
            return;
        }
        wsPanel.pendingGoto = { path: path, line: line };
        if (wsPanel.tabs[path]) wsPanelActivate(path); // activate 内部会 renderTab → 消费 pendingGoto
        else wsPanelOpen(path);                        // read 完成渲染后消费
    }

    // 代码区交互：当前行高亮（悬停跟随/点击固定）+ 标识符悬停提示（文件内+同目录跨文件定义，点击跳转定义行）
    function wsPanelBindCode(wrap, code, content, lineCount, path) {
        var cs = getComputedStyle(code);
        var LINE_H = parseFloat(cs.lineHeight) || 19.2;
        var tip = null;
        // 双高亮条（内容坐标系，随 wrap 滚动）：悬停条跟随鼠标（暗色微亮），固定条点击行常驻（主题色），互不覆盖
        var hlHover = document.createElement('div');
        hlHover.className = 'ws-code-hl';
        hlHover.style.display = 'none';
        wrap.appendChild(hlHover);
        var hlFixed = document.createElement('div');
        hlFixed.className = 'ws-code-hl-fixed';
        hlFixed.style.display = 'none';
        wrap.appendChild(hlFixed);
        var codeTop = code.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - (parseFloat(cs.paddingTop) || 0);
        var fixedLine = -1; // 点击固定的行（-1 无）
        function placeHl(el, line0) {
            if (line0 < 0 || line0 >= lineCount) { el.style.display = 'none'; return; }
            el.style.display = 'block';
            el.style.top = (codeTop + line0 * LINE_H) + 'px';
            el.style.height = LINE_H + 'px';
            el.style.width = Math.max(wrap.scrollWidth, wrap.clientWidth) + 'px';
        }
        // 暴露给跨文件跳转：滚动到行 + 固定高亮
        wsPanel.codeView = {
            wrap: wrap,
            fixLine: function (line0) {
                fixedLine = line0;
                placeHl(hlFixed, line0);
                wrap.scrollTop = Math.max(0, line0 * LINE_H - wrap.clientHeight / 3);
            }
        };
        function lineFromEvent(e) {
            var rect = code.getBoundingClientRect();
            return Math.floor((e.clientY - rect.top) / LINE_H);
        }
        // 悬停提示（挂 body 避免被 wrap overflow 裁剪）
        function hideTip() { if (tip) { tip.remove(); tip = null; } }
        function showTip(e, def) {
            if (!tip) {
                tip = document.createElement('div');
                tip.className = 'ws-hover-tip';
                tip.addEventListener('mousedown', function (ev) {
                    ev.stopPropagation();
                    var target = def.line;
                    hideTip();
                    wsPanelGoto(def.file, target); // 跨文件：切到定义文件并滚到定义行
                });
                document.body.appendChild(tip);
            }
            tip.textContent = '';
            var sig = document.createElement('div');
            sig.className = 'ws-hover-tip-sig';
            sig.textContent = def.sig;
            tip.appendChild(sig);
            if (def.doc) {
                var doc = document.createElement('div');
                doc.className = 'ws-hover-tip-doc';
                doc.textContent = def.doc; // 声明上方注释文档（Trae CN 同款悬停文档）
                tip.appendChild(doc);
            }
            var meta = document.createElement('div');
            meta.className = 'ws-hover-tip-meta';
            meta.textContent = '第 ' + (def.line + 1) + ' 行定义' + (def.file && def.file !== path ? ' · ' + wsBaseName(def.file) : '') + ' · 点击跳转';
            tip.appendChild(sig);
            if (def.doc) tip.appendChild(doc);
            tip.appendChild(meta);
            var tw = Math.min(520, Math.max(260, sig.textContent.length * 7));
            tip.style.width = tw + 'px';
            var x = Math.min(e.clientX + 14, window.innerWidth - tw - 12);
            var y = e.clientY + 18;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
            tip.style.display = 'block';
        }
        // 标识符提取（caretRangeFromPoint 字符级向两侧扩展）
        function identAt(e) {
            var range = document.caretRangeFromPoint(e.clientX, e.clientY);
            if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return '';
            var text = range.startContainer.textContent || '';
            var off = range.startOffset;
            var isw = function (ch) { return /[A-Za-z0-9_$]/.test(ch); };
            var s = off, t2 = off;
            while (s > 0 && isw(text[s - 1])) s--;
            while (t2 < text.length && isw(text[t2])) t2++;
            return s === t2 ? '' : text.slice(s, t2);
        }
        var defs = wsScanDefs(content);
        wsPanel.symTab[path] = defs; // 本文件符号入缓存（保存/重渲染后同步刷新）
        var lastIdent = '';
        wrap.addEventListener('mousemove', function (e) {
            placeHl(hlHover, lineFromEvent(e)); // 悬停条跟随（固定条不受影响）
            var ident = identAt(e);
            if (ident && ident !== lastIdent) {
                var hit = wsFindDef(ident, path); // 文件内优先，其次同目录跨文件
                if (hit) showTip(e, hit); else hideTip();
            } else if (!ident) {
                hideTip();
            }
            lastIdent = ident;
        });
        wrap.addEventListener('mouseleave', function () {
            placeHl(hlHover, -1);
            hideTip();
            lastIdent = '';
        });
        wrap.addEventListener('click', function (e) {
            var line0 = lineFromEvent(e);
            fixedLine = (line0 === fixedLine) ? -1 : line0; // 点击固定当前行（主题色条），再点同行取消
            placeHl(hlFixed, fixedLine);
        });
        // git 变更装饰（Trae CN 同款）：绿底=新增/修改行；行号栏红条=删除位置（悬停预览删除内容、点击开差异对比）
        var decorTab = wsPanel.tabs[path];
        var decor = decorTab && decorTab.gitDecor;
        if (decor && (decor.added.size || decor.deleted.length)) {
            var oldDTip = document.querySelector('.ws-diff-tip');
            if (oldDTip) oldDTip.remove(); // 上一次渲染残留的删除预览浮层清理（重渲染后旧标记已随 DOM 销毁）
            var dw = Math.max(wrap.scrollWidth, wrap.clientWidth);
            decor.added.forEach(function (l0) { // 绿色底色条：与 .ws-code-hl 同款绝对定位覆盖（横向滚动随内容）
                if (l0 < 0 || l0 >= lineCount) return;
                var bar = document.createElement('div');
                bar.className = 'ws-code-diff-add';
                bar.style.top = (codeTop + l0 * LINE_H) + 'px';
                bar.style.height = LINE_H + 'px';
                bar.style.width = dw + 'px';
                wrap.appendChild(bar);
            });
            var lnEl = wrap.querySelector('.ws-code-ln');
            if (lnEl && decor.deleted.length) {
                var lnPadTop = parseFloat(getComputedStyle(lnEl).paddingTop) || 0;
                var dTip = null;
                var hideDelTip = function () { if (dTip) { dTip.remove(); dTip = null; } };
                decor.deleted.forEach(function (g) {
                    if (g.at < 0 || g.at > lineCount) return;
                    var mark = document.createElement('div');
                    mark.className = 'ws-code-diff-del';
                    mark.style.top = (lnPadTop + g.at * LINE_H - 1.5) + 'px'; // 压在删除落点行上缘
                    mark.addEventListener('mouseenter', function () {
                        hideDelTip();
                        dTip = document.createElement('div');
                        dTip.className = 'ws-hover-tip ws-diff-tip';
                        var h = document.createElement('div');
                        h.className = 'ws-diff-tip-head';
                        h.textContent = '删除了 ' + g.lines.length + ' 行 · 点击查看差异对比';
                        dTip.appendChild(h);
                        var dp = document.createElement('pre');
                        dp.className = 'ws-diff-tip-pre';
                        dp.textContent = g.lines.slice(0, 8).join('\n') + (g.lines.length > 8 ? '\n…' : '');
                        dTip.appendChild(dp);
                        document.body.appendChild(dTip);
                        var r = mark.getBoundingClientRect();
                        dTip.style.left = Math.max(8, Math.min(r.right + 10, window.innerWidth - 360)) + 'px';
                        dTip.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - 180)) + 'px';
                        dTip.style.display = 'block';
                    });
                    mark.addEventListener('mouseleave', hideDelTip);
                    mark.addEventListener('click', function (e2) {
                        e2.stopPropagation();
                        hideDelTip();
                        wsPanelGitOpenDiff(path, null); // 直达该文件完整差异对比标签
                    });
                    lnEl.appendChild(mark);
                });
                wrap.addEventListener('scroll', hideDelTip); // 滚动/点击别处时收浮层
                wrap.addEventListener('mousedown', hideDelTip);
            }
        }
    }

    // 进入编辑模式（纯文本 textarea，等宽字体与预览一致；二进制/加载中/错误禁编辑）
    function wsPanelStartEdit() {
        if (!wsPanel.activeTab || wsPanel.editing) return;
        var t = wsPanel.tabs[wsPanel.activeTab];
        if (!t || t.loading || t.error || t.binary) return;
        wsPanel.editing = true;
        wsPanelRenderTab();
    }

    // 保存（写回磁盘：PC 在线=用户本地，离线=服务端工作区），成功后更新标签内容 + 刷新树
    function wsPanelSave() {
        var path = wsPanel.activeTab;
        if (!path || !wsPanel.editing || !wsPanel.ta) return;
        var t = wsPanel.tabs[path];
        var content = wsPanel.ta.value;
        wsPanel.btnSave.disabled = true;
        wsPanelReq('save', path, content).then(function () {
            wsPanel.btnSave.disabled = false;
            showToast('已保存：' + path.replace(/^.*[\\/]/, ''));
            delete wsPanel.badges[path];
            t.content = content;
            delete t.draft;
            wsPanel.editing = false;
            wsPanel.ta = null;
            wsPanelRenderTabs();
            wsPanelRenderTab();
            wsPanelLoadGitDecor(path); // 保存后重拉变更装饰（绿底/删除标记随编辑即时更新）
            wsPanelRefreshTree();
        }).catch(function (err) {
            wsPanel.btnSave.disabled = false;
            showToast('保存失败：' + (err && err.message || err));
        });
    }

    function fillAgentTool(st, ev) {
        // 回填规则：优先匹配该工具名最后一个 pending 块（阶段六十二：按 data-tool 匹配，标题已中文化）
        var blocks = st.events.querySelectorAll('.agent-event.tool.pending');
        var block = null;
        for (var i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].getAttribute('data-tool') === (ev.tool || '')) { block = blocks[i]; break; }
        }
        if (!block) { addAgentTool(st, { tool: ev.tool, params: {} }); blocks = st.events.querySelectorAll('.agent-event.tool.pending'); block = blocks[blocks.length - 1]; }
        stopAgentToolTimers(block); // 阶段七十五：收尾转后台按钮/执行计时（命令已结束）
        block.classList.remove('pending');
        block.classList.add(ev.ok === false ? 'fail' : 'ok');
        var running = block.querySelector('.agent-tool-running');
        if (running) running.remove(); // 结果摘要行（✓/✕）接管执行态展示
        var outEl = block.querySelector('.agent-event-output');
        // 阶段七十五：run_command 有实时控制台时输出已在控制台流式展示，不再重复灌满详情区
        // （控制台保留完整流与退出码行；无控制台的兜底路径仍走详情区文本）
        if (block.querySelector('.agent-cmd-console')) {
            outEl.classList.add('hidden');
        } else {
            outEl.textContent = ev.output || '';
            outEl.classList.remove('hidden');
        }
        // 阶段六十二：结果摘要行（输出首行常显）——"已编辑 main.go（+1 -1，34 字节）"/"命令已执行 xxx"/错误首行
        // +/-行数着色（git 同款绿/红）：仅带符号数字着色，替换处数/字节数等无符号数字不受影响
        var firstLine = (ev.output || '').split('\n')[0] || '';
        if (firstLine.length > 120) firstLine = firstLine.slice(0, 120) + '…';
        var resultLine = document.createElement('div');
        resultLine.className = 'agent-tool-result' + (ev.ok === false ? ' fail' : '');
        resultLine.appendChild(document.createTextNode(ev.ok === false ? '✕ ' : '✓ '));
        // 后随分隔符（空格/逗号/闭括号/行尾）才着色：防路径中 "file-2.txt" 的 "-2" 误着色
        var statRe = /([+-]\d+)(?=[\s，）]|$)/g, statM, statLast = 0;
        while ((statM = statRe.exec(firstLine))) {
            if (statM.index > statLast) resultLine.appendChild(document.createTextNode(firstLine.slice(statLast, statM.index)));
            var stat = document.createElement('span');
            stat.className = statM[1].charAt(0) === '+' ? 'diff-add' : 'diff-del';
            stat.textContent = statM[1];
            resultLine.appendChild(stat);
            statLast = statM.index + statM[0].length;
        }
        if (statLast < firstLine.length) resultLine.appendChild(document.createTextNode(firstLine.slice(statLast)));
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
        // 阶段七十九：停靠栏"任务"页签数据源（计数 + 清单面板镜像由 agentDockSync 重绘）
        st.todoDone = done;
        st.todoTotal = total;
        st.todoRaw = todos;
        agentDockSync();
        agentTaskScroll();
    }

    // Agent 事件流分发（事件不落库：仅当前会话实时渲染，切换会话后不重放）
    IMSocket.on(MSG.AGENT_EVENT, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        var ev;
        try { ev = JSON.parse(msg.content); } catch (e) { return; }
        // 阶段一百零五：AI 提交信息流式增量（无 task_id，不走任务卡分发；生成中打字机填入提交框）
        if (ev && ev.type === 'git_ai_delta') { wsGitAIDelta(ev.text || ''); return; }
        // 阶段一百零六：审查报告流式增量（TRAE CN 同款逐字生成，锚定当前审查流同键刷新）
        if (ev && ev.type === 'git_review_delta') { wsGitReviewDelta(ev.text || ''); return; }
        // 阶段一百零五补强：多文件仅标题时服务端自动纠偏重试，重试前清空提交框第一次的残文
        if (ev && ev.type === 'git_ai_reset') {
            if (wsGitAIStreaming) {
                wsGitAIPending = ''; // 同步清打字机缓冲，防第一次的残余增量重试期间混入
                if (wsPanel.gitMsg) {
                    wsPanel.gitMsg.value = '';
                    if (wsPanel.gitMsgGrow) wsPanel.gitMsgGrow();
                }
            }
            return;
        }
        if (!ev || !ev.task_id) return;
        // 阶段一百零二：Agent 任务扣后积分余额实时刷新（done 帧携带，服务端归口；
        // 与当前查看会话无关——切走会话/最小化时完结也要刷新标题栏 ⚡ 积分）
        if (ev.points_balance != null) setPointsBalance(ev.points_balance);
        var st = agentTaskCards[ev.task_id];
        // 阶段七十三：任务完结/取消即清进行中标记（不依赖当前查看会话——切走期间完结也要复位发送按钮态）
        if (agentActiveTask[msg.from_user] === ev.task_id &&
            (ev.type === 'done' || ev.type === 'error' || (ev.type === 'status' && ev.status === 'cancelled'))) {
            delete agentActiveTask[msg.from_user];
            updateSendBtnState();
        }
        // 阶段六十六：完结事件不依赖当前会话——切走会话/最小化后也要弹系统级提醒
        // （会话角标与摘要由服务端完结消息落库联动归口，此处补即时可感知；当前会话路径由 switch 内 agentTaskNotify 覆盖）
        if ((ev.type === 'done' || ev.type === 'error') && currentChatUser !== msg.from_user) {
            agentTaskNotify(msg, st, ev.type === 'done' ? '已完成' : '执行失败');
            return;
        }
        if (currentChatUser !== msg.from_user) return; // 仅当前会话实时渲染
        // 阶段六十七：排队任务同样建卡（含位次）；后续位次更新事件复用既有卡片
        // 阶段七十一：事件帧携带会话归属（服务端盖戳同源），建卡按它盖戳防串会话
        if (ev.type === 'status' && (ev.status === 'running' || ev.status === 'queued') && ev.goal && !st) {
            st = createAgentTaskCard(msg.from_user, ev.task_id, ev.goal, ev.session_id);
        }
        if (!st) return;
        switch (ev.type) {
            case 'status':
                if (ev.status === 'queued') {
                    // 阶段六十七：排队中（含位次前移更新），按钮转"取消排队"
                    setAgentTaskStatus(st, '排队中 · 第 ' + (ev.position || 1) + ' 位', 'queued');
                    st.stopBtn.disabled = false;
                    st.stopBtn.textContent = '取消排队';
                }
                else if (ev.status === 'waiting_approval') setAgentTaskStatus(st, '等待审批', 'waiting');
                else if (ev.status === 'running') {
                    setAgentTaskStatus(st, '执行中', 'running');
                    // 阶段六十七：自队列派发后按钮复位（排队态曾改为"取消排队"）
                    st.stopBtn.disabled = false;
                    st.stopBtn.textContent = '停止';
                }
                else if (ev.status === 'cancelled') {
                    // 阶段七十：取消同样折叠执行过程（与完成态观感一致，点击卡头可回看）
                    collapseAgentCard(st);
                    agentFinalizeText(st, true);
                    // 阶段一百零二：取消不扣积分，已消耗 Token 标注到任务卡
                    finishAgentTask(st, '已取消' + agentTokensTag({ total: ev.total_tokens || 0 }), 'cancelled');
                    // 阶段六十六：取消通知留档气泡（服务端落库 is_read=true 本人操作无未读），实时端同步渲染保持一致
                    if (ev.msg_id) appendMessage(msg.from_user, '任务已取消', 'other', ev.msg_id, msg.timestamp, true);
                }
                break;
            case 'thought': addAgentThought(st, ev.text); break;
            case 'text_delta': case 'thought_delta': agentStreamText(st, ev.text); break; // 阶段六十二：流式打字
            case 'history_compress':
                // 阶段八十四：TRAE 同款"历史对话压缩中"——长任务上下文自动瘦身（较早已完成工具轮归并为摘要）；
                // start=压缩开始提示，done=完成（完成不重复上屏，避免思考区出现两条）
                if (!ev.phase || ev.phase === 'start') {
                    addAgentThought(st, '历史对话压缩中…（较早执行记录正在归并为摘要，节省 token 并加速响应）');
                }
                break;
            case 'step_tokens':
                // 阶段一百零三：每轮 Token 消耗实时行（单行更新不新增行；任务循环每轮全量重发
                // 上下文，可见每轮增量与累计才能定位消耗烧点——测量先行）
                if (st.costEl) {
                    st.costEl.classList.remove('hidden');
                    st.costEl.innerHTML = '';
                    var cLabel = document.createElement('span');
                    cLabel.textContent = '⚡ 第 ' + (ev.round || '?') + ' 轮：提示 ' + (ev.prompt_tokens || 0) +
                        ' + 生成 ' + (ev.completion_tokens || 0) + '，累计 ';
                    var cNum = document.createElement('span');
                    cNum.className = 'cost-num';
                    cNum.textContent = (ev.total_all || 0) + ' tokens';
                    st.costEl.appendChild(cLabel);
                    st.costEl.appendChild(cNum);
                }
                break;
            case 'tool_start':
                agentFinalizeText(st, true); // 流式文本归入"思考过程"折叠块（Trae 同款：出工具即收思考）
                addAgentTool(st, ev);
                break;
            case 'tool_result':
                fillAgentTool(st, ev);
                wsPanelOnToolResult(ev); // 阶段七十六：文件面板刷新树 + 自动打开生成/修改的文件
                break;
            case 'tool_output': updateAgentToolOutput(st, ev); break; // 阶段七十五：命令实时输出 → 控制台
            case 'tool_exit': finalizeAgentToolExit(st, ev); break;   // 阶段七十五：进程结束 → 退出码/耗时标注
            case 'todo': renderAgentTodo(st, ev); break;
            case 'done':
                st.bar.style.width = '100%';
                st.pct.textContent = '100%';
                // 阶段一百零二：全任务 Token 消耗记录（任务卡标注 + 答复气泡操作栏复用）
                st.tokens = { total: ev.total_tokens || 0, prompt: ev.prompt_tokens || 0, completion: ev.completion_tokens || 0 };
                // 阶段七十：任务完成自动折叠——执行过程整体收起保持卡片紧凑（点击卡头可回看），与重进会话重放卡观感一致
                collapseAgentCard(st);
                finishAgentTask(st, '已完成' + agentTokensTag(st.tokens), 'done');
                // 阶段七十七：文件变更审查条（TRAE CN 同款，撤销/保留归口）
                if (ev.changes && ev.changes.length) agentRenderChanges(st, ev.changes);
                agentConsoleTaskEnd(); // 阶段七十五（增强）：任务完结收"打开控制台"浮标
                // 阶段七十：最终答复统一以正常 AI 消息气泡展示（含 Markdown 渲染与操作栏）。
                // 原路径"已流式则收尾为卡内正文"被 .agent-event-body 240px 滚动框限制且混在执行日志里，
                // 观感似过程输出而非回复（用户感知"总结没出现，切会话才看到"）；现卡内流式文本折叠归入
                // 思考过程防内容丢失，答复气泡实时上屏，与切会话/重登后的历史视图完全一致
                agentFinalizeText(st, true);
                if (ev.result) {
                    // 阶段七十一：完结气泡按任务归属会话渲染（执行中切走会话不串视图；回复已落库，切回经历史可见）
                    if (st.sessionId === (aiViewSession[st.agent] || 0)) {
                        // 阶段六十六：事件携带落库 msg_id（气泡关联库记录，撤回/引用/操作栏正常）
                        // 阶段一百零二：透传全任务 Token 消耗（答复气泡操作栏 ⚡ 标注，与普通回复同口径）
                        appendMessage(st.agent, ev.result, 'other', ev.msg_id || 0, msg.timestamp, true, false, st.tokens);
                        // 阶段六十六：正查看该会话时完结消息视为已读（不留假未读角标）
                        if (ev.msg_id) sendReadReceipt(msg.from_user, ev.msg_id);
                    }
                }
                agentConsoleTaskEnd(); // 阶段七十五（增强）：任务完结收"打开控制台"浮标
                agentTaskNotify(msg, st, '已完成');
                break;
            case 'error':
                agentFinalizeText(st, true);
                // 阶段一百零二：失败不扣积分，已消耗 Token 标注到任务卡
                finishAgentTask(st, '失败' + agentTokensTag({ total: ev.total_tokens || 0 }), 'failed');
                // 阶段七十七：失败同样结算变更（已落盘的脏改可撤销）
                if (ev.changes && ev.changes.length) agentRenderChanges(st, ev.changes);
                agentConsoleTaskEnd(); // 阶段七十五（增强）：任务完结收"打开控制台"浮标
                showToast(ev.message || '任务执行失败');
                // 阶段六十六：失败通知气泡实时渲染（内容与服务端落库留档一致），并已读归口
                if (ev.msg_id) {
                    appendMessage(msg.from_user, '任务执行失败：' + (ev.message || '未知原因'), 'other', ev.msg_id, msg.timestamp, true);
                    sendReadReceipt(msg.from_user, ev.msg_id);
                }
                agentTaskNotify(msg, st, '执行失败');
                break;
        }
    });

    // 阶段六十六：任务完结系统级提醒归口——窗口隐藏或已切走会话时，PC 端弹系统桌面通知，
    // Web 端轻提示兜底；会话角标/摘要由服务端完结消息落库联动（CONV_LIST 归口），此处补"即时可感知"体验
    function agentTaskNotify(msg, st, statusText) {
        if (!document.hidden && currentChatUser === msg.from_user) return; // 正盯着该会话，任务卡片即通知
        var goal = (st && st.goal) ? String(st.goal) : '';
        if (goal.length > 20) goal = goal.slice(0, 20) + '…';
        var body = '任务' + statusText + (goal ? '：' + goal : '');
        if (window.desktop && typeof window.desktop.notify === 'function') {
            window.desktop.notify('Agent 任务', body);
        } else {
            showToast(body);
        }
    }

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
        head.textContent = '需要审批 · ' + (ev.label || AGENT_TOOL_TITLE[ev.tool] || ev.tool || '');
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
        // 服务端 DB 持久化，重启不丢；后续同类操作不再弹审批。
        // 阶段七十四：edit_file 共用写文件免审批；delete_file 不可加白（不可恢复操作逐次确认），不显示加白按钮
        var wlBtn = document.createElement('button');
        wlBtn.className = 'agent-approve-wl';
        wlBtn.textContent = '同意并加白';
        wlBtn.title = (ev.tool === 'write_file' || ev.tool === 'edit_file') ? '同意本次，且之后的写/编辑文件操作不再需要审批'
            : '同意本次，且之后以相同命令开头的操作不再需要审批（链式命令除外）';
        var noBtn = document.createElement('button');
        noBtn.className = 'agent-approve-no';
        noBtn.textContent = '拒绝';
        actions.appendChild(okBtn);
        // 阶段八十九：MCP 工具无命令前缀/写文件白名单语义（服务端 whitelist 分支无副作用），不显示加白按钮
        if (ev.tool !== 'delete_file' && String(ev.tool || '').indexOf('mcp_') !== 0) actions.appendChild(wlBtn);
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

    // ===== 阶段七十七：文件变更审查全量刷新帧（保留/撤销后服务端回推，多端一致） =====
    IMSocket.on(MSG.AGENT_CHANGES, function (msg) {
        if (msg.to_user !== IMSocket.getUsername()) return;
        var ev;
        try { ev = JSON.parse(msg.content); } catch (e) { return; }
        if (!ev || !ev.task_id) return;
        // live 卡状态同步（后续任务事件渲染用最新变更集）
        var st = agentTaskCards[ev.task_id];
        if (st) st.changes = ev.changes;
        // 阶段一百：live 卡与重放卡审查条统一按容器标记整块重建——此前仅刷 live 卡，
        // 重进会话后的历史（重放）卡点"全部保留/全部撤销"后 UI 不动，被误以为按钮无效
        if (currentChatUser === msg.from_user) {
            document.querySelectorAll('.agent-changes[data-changes-task="' + ev.task_id + '"]').forEach(function (old) {
                var fresh = agentBuildChangesBox(ev.task_id, ev.changes); // 每处独立实例（事件监听器不随节点复用）
                if (fresh) old.replaceWith(fresh); else old.remove();
            });
        }
        // 阶段七十九：同步停靠栏"文件变更"页签（pending 清零自动摘除页签/收面板）
        agentDockSetChanges(msg.from_user, ev.task_id, ev.changes);
        // 工作区面板对齐磁盘实际：撤销已改变工作区内容（新建撤销=文件被删，关相关标签；
        // 其余撤销=内容还原，已开标签强制重读）——仅当前查看智能体的变更需要刷新
        if ((wsPanel.visible || wsPcViewer()) && currentChatUser === msg.from_user) {
            (ev.changes || []).forEach(function (c) {
                if (c.status !== 'reverted') return;
                var key = wsPanelNormalizeKey(c.path);
                if (c.kind === 'create') {
                    if (!wsPcViewer()) wsPanelForgetKey(key); // PC：撤销新建=文件已删，标签随删除联动另行关闭（delete_file 事件）
                    return;
                }
                // PC：已开标签重读磁盘还原后内容；未开不强行打开（对齐 wsPanel 仅刷新已开语义）
                if ((key || key === '') && (wsPcViewer() ? browserHasFileTab(key) : wsPanel.tabs[key])) wsOpenFile(key, true);
            });
            wsPanelRefreshTree();
        }
    });

    // ===== 阶段六十：Agent 本地执行器桥接（仅 PC 端生效） =====
    // 服务端下发的本地执行请求（50）经 preload 暴露的 agentExec 转发主进程执行，结果（51）回传服务端。
    // Web/手机端无 window.desktop.agentExec，不注册监听，服务端对其永远走服务端执行（hub.HasPC=false）
    if (window.desktop && typeof window.desktop.agentExec === 'function') {
        // 阶段七十五：当前本地执行中的 run_command 归属（{task_id,step}），输出帧按它盖戳上行；
        // 同用户同时至多一条命令（服务端任务队列串行派发 + 执行器按用户名归口），迟到终帧后即清
        var activeExec = null;
        window.desktop.onAgentOutput(function (frame) {
            if (!activeExec) return;
            IMSocket.send({
                msg_type: MSG.AGENT_TOOL_OUTPUT,
                from_user: IMSocket.getUsername(),
                content: JSON.stringify({
                    task_id: activeExec.task_id, step: activeExec.step,
                    chunk: frame.chunk || '', total_bytes: frame.total_bytes || 0,
                    over: !!frame.over, final: !!frame.final,
                    exit_code: frame.exit_code || 0, duration_ms: frame.duration_ms || 0
                })
            });
            if (frame.final) activeExec = null; // 终帧：本次命令输出流结束
        });
        IMSocket.on(MSG.AGENT_EXEC_REQ, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (!ev || !ev.task_id || !ev.step) return;
            // 请求里带当前登录用户名：主进程按用户名隔离本地工作区（防同机多账号串目录）
            // task_id 阶段八十：本地文件工具据此做首触备份，撤销/保留链路（审查条）依赖
            var req = { username: IMSocket.getUsername(), tool: ev.tool, params: ev.params || {}, task_id: ev.task_id };
            if (ev.tool === 'run_command') activeExec = { task_id: ev.task_id, step: ev.step };
            window.desktop.agentExec(req).then(function (res) {
                if (ev.tool === 'run_command' && activeExec && activeExec.step === ev.step) activeExec = null;
                IMSocket.send({
                    msg_type: MSG.AGENT_EXEC_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({
                        task_id: ev.task_id, step: ev.step,
                        ok: !!(res && res.ok), output: (res && res.output) || '',
                        changes: (res && res.changes) || [] // 阶段八十：本地文件变更上报（服务端登记审查条）
                    })
                });
            }).catch(function (err) {
                // IPC 链路异常（主进程执行器崩溃等）：按工具级失败回传，模型据此调整方案
                if (ev.tool === 'run_command' && activeExec && activeExec.step === ev.step) activeExec = null;
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
        // 阶段七十五：服务端转后台请求下行桥接（服务端执行时直接生效；PC 本地执行时转发给执行器）
        IMSocket.on(MSG.AGENT_BG, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (!ev || !ev.step) return;
            if (activeExec && activeExec.step === ev.step) window.desktop.agentBg(IMSocket.getUsername());
        });
        // 阶段九十：本机 MCP 工具清单上报的服务端确认帧（下行回执：{ok,count}）
        IMSocket.on(MSG.AGENT_PC_TOOLS, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (ev && ev.ok) showToast('本机 MCP 工具已上报（' + (ev.count || 0) + ' 个）');
        });
        // 阶段七十六：工作区文件面板本地操作桥（服务端下行 msg 64 → 主进程 fs → 结果经 65 回传）
        IMSocket.on(MSG.PC_FILE_REQ, function (msg) {
            if (msg.to_user !== IMSocket.getUsername()) return;
            var ev;
            try { ev = JSON.parse(msg.content); } catch (e) { return; }
            if (!ev || !ev.req_id || !ev.op) return;
            if (window.desktop && window.desktop.fileopTrace) window.desktop.fileopTrace({ phase: 'recv64', t: Date.now(), rid: ev.req_id });
            window.desktop.workspaceOp({ username: IMSocket.getUsername(), op: ev.op, path: ev.path || '', content: ev.content || '', req_id: ev.req_id }).then(function (res) {
                if (window.desktop && window.desktop.fileopTrace) window.desktop.fileopTrace({ phase: 'send65', t: Date.now() });
                IMSocket.send({
                    msg_type: MSG.PC_FILE_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({
                        op: ev.op, req_id: ev.req_id,
                        ok: !!(res && res.ok), error: (res && res.error) || '',
                        root: (res && res.root) || '', entries: (res && res.entries) || [],
                        content: (res && res.content) || '', binary: !!(res && res.binary), truncated: !!(res && res.truncated)
                    })
                });
            }).catch(function (err) {
                IMSocket.send({
                    msg_type: MSG.PC_FILE_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({ op: ev.op, req_id: ev.req_id, ok: false, error: '本地文件操作异常 ' + (err && err.message || err) })
                });
            });
        });
        // 克隆进度多帧桥（仅 PC 端）：主进程执行器 stderr 解析 → IPC 推帧 → 65 progress 帧上行服务端 → 63 下发 web
        if (window.desktop && window.desktop.onWorkspaceProgress && !window._wsCloneProgressBound) {
            window._wsCloneProgressBound = true;
            window.desktop.onWorkspaceProgress(function (p) {
                if (!p || !p.req_id) return;
                IMSocket.send({
                    msg_type: MSG.PC_FILE_RESP,
                    from_user: IMSocket.getUsername(),
                    content: JSON.stringify({
                        op: 'proj_clone', req_id: p.req_id, type: 'progress',
                        pct: p.pct || 0, stage: p.stage || '', speed: p.speed || '', sent: p.sent || 0
                    })
                });
            });
        }
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

    // AI Markdown 内横向滚动容器（宽表格/代码块）挂横向自绘悬浮滑块：
    // 原生滚动条已全局隐藏（scrollbar-width:none），气泡夹紧后超宽表格转为内部横滚，
    // 无滑块则横向溢出内容不可见也不可拖（仅 Shift+滚轮可用）；复用阶段四十五横向版滑块
    // （悬停浮现、可拖拽，微信同款）。仅在稳定态调用（流式收尾/历史加载）——
    // 打字机期间每 30ms 整体重建 innerHTML，逐元素挂 Observer/滑块会随重建泄漏
    function initAIMdHScroll(root) {
        if (!window._osbInitH || !root || !root.querySelectorAll) return;
        var wraps = root.querySelectorAll('.ai-md-table-wrap:not([data-osb-h]), .ai-md-pre:not([data-osb-h])');
        for (var i = 0; i < wraps.length; i++) {
            wraps[i].setAttribute('data-osb-h', '1'); // 防重复挂载标记
            window._osbInitH(wraps[i]);
        }
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
        // 阶段一百零五：签名比对防闪烁——每条消息/CONV_LIST 推送都会调本函数，
        // 数据无变化时跳过清空重建（原实现每次 innerHTML='' 全量重建，连续消息/群聊场景
        // 会话列表反复闪烁、头像重载、悬停态丢失；签名含 高亮会话+列表全字段+好友备注头像）
        var convSig = JSON.stringify([currentChatUser, convList, friendList]);
        if (convSig === renderConvList._sig) return;
        renderConvList._sig = convSig;
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
                // 阶段八十八：只改 .mi-text 文字节点，防止 textContent 连同 SVG 图标一起清掉（与消息菜单同坑同修）
                var pinLabel = pinItem.querySelector('.mi-text') || pinItem;
                pinLabel.textContent = cv.pinned ? '取消置顶' : '置顶聊天';
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
        // 阶段八十五：先合并服务端下发的发送者昵称（服务端归口），再渲染名称标签（备注→昵称→账号）
        if (msg.from_name) nickCache[msg.from_user] = msg.from_name;
        var isMine = msg.from_user === IMSocket.getUsername();
        appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id, msg.timestamp, false);
    });
    IMSocket.on(MSG.PRIVATE, function (msg) {
        var isMine = msg.from_user === IMSocket.getUsername();
        var relevantUser = isMine ? msg.to_user : msg.from_user;
        // 阶段七十一：AI 提问/任务目标回显帧携带会话归属（服务端落库同源），与本端查看会话不符
        //（他端在其他会话发起）不渲染（落库按会话归位，切回经历史可见；旧服务端无 sid 字段不拦截）
        if (isMine && isAIAgent(msg.to_user) && msg.session_id !== undefined &&
            (msg.session_id || 0) !== (aiViewSession[msg.to_user] || 0)) return;
        if (currentChatUser === relevantUser) {
            // 已读状态随回显帧下发（服务端归口）：AI 提问回显 is_read=true 显示"已读"；
            // 普通私聊帧无该字段保持"未读"，由对方阅读回执链路更新
            appendMessage(msg.from_user, msg.content, isMine ? 'self' : 'other', msg.msg_id, msg.timestamp, true,
                isMine ? msg.is_read === true : undefined);
            // 阶段四十三：发给 AI 智能体的提问上屏后，紧随其后显示"思考中"指示（服务端回显先于流式帧送达，时序稳定）
            // 阶段七十：AGENT_RUN 回显（agentEchoPending 标记）不显示"思考中"——任务模式由任务卡接管反馈
            if (isMine && isAIAgent(msg.to_user)) {
                if (agentEchoPending[msg.to_user]) delete agentEchoPending[msg.to_user];
                else showAIThinking(msg.to_user);
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

    // ===== 阶段七十二：私聊永久删除审批（会话内审批卡片）=====
    // 归口：服务端申请单落库（同一对用户仅一条待处理）；卡片状态经 PURGE_APPLY 帧同步双方
    // （发起/审批/登录补推/终态变更 复用同一帧），前端按 from_user===自己 区分发起/审批视角
    var purgeCards = {}; // peer -> {apply_id, from_user, to_user, status}

    IMSocket.on(MSG.PURGE_APPLY, function (msg) {
        var p = null;
        try { p = JSON.parse(msg.content) || {}; } catch (e) { return; }
        if (!p.apply_id || !p.from_user) return;
        var me = IMSocket.getUsername();
        var peer = (p.from_user === me) ? p.to_user : p.from_user;
        purgeCards[peer] = p;
        if (currentChatUser !== peer) return;
        if (p.status === 1) {
            // 对方已同意：云端已物理删除，重拉当前视图清掉残留气泡（卡片由历史加载钩子重挂终态）
            messageList.innerHTML = '';
            historyPage = 1;
            historyHasMore = true;
            loadingMore = false;
            loadHistory();
            return;
        }
        renderPurgeCard();
    });

    // 渲染/更新当前会话的审批卡片（历史加载后追加与会话内实时状态同步共用；原位替换幂等）
    function renderPurgeCard() {
        var p = purgeCards[currentChatUser];
        if (!p) return;
        var me = IMSocket.getUsername();
        var isSender = p.from_user === me;
        var text = '', actions = null;
        if (p.status === 0) {
            if (isSender) {
                text = '已向对方发送删除申请，等待对方处理';
            } else {
                text = '对方申请彻底删除你们双方的聊天记录（申请前的消息），是否同意？';
                actions = [
                    { text: '同意删除', cls: 'purge-btn-agree', act: 'agree' },
                    { text: '拒绝', cls: 'purge-btn-reject', act: 'reject' }
                ];
            }
        } else if (p.status === 1) {
            text = isSender ? '对方已同意删除申请，双方聊天记录已彻底删除' : '已同意删除申请，双方聊天记录已彻底删除';
        } else {
            text = isSender ? '对方拒绝了你的删除申请，聊天记录保留' : '已拒绝删除申请，聊天记录保留';
        }
        var card = document.createElement('div');
        card.className = 'msg-purge-card';
        card.setAttribute('data-apply-id', p.apply_id);
        var tip = document.createElement('div');
        tip.className = 'purge-tip';
        tip.textContent = text;
        card.appendChild(tip);
        if (actions) {
            var bar = document.createElement('div');
            bar.className = 'purge-actions';
            actions.forEach(function (a) {
                var btn = document.createElement('button');
                btn.className = 'purge-btn ' + a.cls;
                btn.textContent = a.text;
                btn.addEventListener('click', function () {
                    // 点击即锁按钮防重复提交，终态以服务端 57 帧归口回推（拒绝/同意后卡片原位更新）
                    bar.querySelectorAll('.purge-btn').forEach(function (b) { b.disabled = true; });
                    tip.textContent = '处理中…';
                    IMSocket.send({ msg_type: MSG.PURGE_RESP, to_user: p.from_user, msg_id: p.apply_id, content: a.act });
                });
                bar.appendChild(btn);
            });
            card.appendChild(bar);
        }
        var old = messageList.querySelector('.msg-purge-card');
        if (old) {
            messageList.replaceChild(card, old);
        } else {
            messageList.appendChild(card);
        }
        messageList.scrollTop = messageList.scrollHeight;
    }

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
        var tip = msg.from_user === IMSocket.getUsername() ? '你撤回了一条消息' : senderDisplayName(msg.from_user) + ' 撤回了一条消息';
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
        // 阶段八十七：切换会话强制退出多选模式（多选仅对当前会话有效，跨会话勾选无意义）
        exitMultiSelect();
        // 阶段七十八：离开旧会话前记忆其 Agent 开关（仅 AI 会话）——切回时自动恢复，不用重新打开
        if (currentChatUser && isAIAgent(currentChatUser)) {
            agentModeByUser[currentChatUser] = agentMode;
            agentModeMemSave();
            agentConsoleOpenByUser[currentChatUser] = agentConsole.open; // 控制台开合状态同样按会话记忆
        }
        currentChatUser = user;
        // 阶段五十九：Agent 任务模式按钮仅 AI 智能体会话可用
        // 阶段七十八：AI 会话恢复该会话记忆的开关状态；普通好友会话强制关闭（Agent 仅对 AI 有意义）
        var targetIsAgent = !!(user && isAIAgent(user));
        setAgentMode(targetIsAgent ? !!agentModeByUser[user] : false);
        agentModeBtn.classList.toggle('hidden', !targetIsAgent);
        // 阶段六十九：联网搜索开关仅 AI 智能体会话且服务端开启时显示（开关状态跨会话保持）
        webSearchBtn.classList.toggle('hidden', !(user && isAIAgent(user) && webSearchAvailable));
        // 阶段六十一：工作区按钮与 Agent 模式按钮同显隐，但仅 PC 端可用（Web 端工作区在服务端，无本地自选意义）
        agentWsBtn.classList.toggle('hidden', !(user && isAIAgent(user) && agentWsSupported()));
        // 阶段九十：我的 MCP 服务器按钮同显隐（仅 PC 端，本机 stdio 自定义）
        agentMcpBtn.classList.toggle('hidden', !(user && isAIAgent(user) && agentMcpSupported()));
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
        // 阶段七十五（增强）：切换会话复位独立控制台抽屉（控制台会话级归属，不跨会话串日志）
        agentConsoleReset();
        // 阶段七十八：恢复该 AI 会话的控制台开合状态（日志仍按会话清空，仅恢复"开着"的显示状态；
        // 需 Agent 模式已恢复开启——工作区面板可见控制台才有停靠位）
        if (targetIsAgent && agentMode && agentConsoleOpenByUser[user]) {
            agentConsoleEnsure();
            agentConsoleToggle(true);
        }
        // 阶段七十九：停靠栏按新会话归口重绘（该智能体的运行任务/待审查变更页签；非 AI 会话整栏隐藏，
        // 待重放接口返回后补充登记 pending 变更）
        agentDockSync();
        // 阶段一百零五修复（2026-09-13 用户反馈"仅本智能体规则在切换智能体后仍可见"）：
        // 设置页停留在"规则与记忆"分类时切换会话，规则/记忆列表须按新会话智能体重载——
        // 原实现仅进入分类时加载一次，切换会话后列表仍显示上一智能体的数据
        if (settingsMask && !settingsMask.classList.contains('hidden')) {
            var srv = document.getElementById('settings-view-rules');
            if (srv && !srv.classList.contains('hidden')) settingsRulesEnter(true); // 静默刷新防残影闪烁
        }
        // 阶段四十：切换会话清空引用条（防止把 A 会话的消息引用发到 B 会话）
        clearQuoteTarget();
        // 阶段七十：清空 AGENT_RUN 回显待达标记（防会话切换后误吞后续 AI 问答的"思考中"指示）
        for (var ep in agentEchoPending) delete agentEchoPending[ep];
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
        // 阶段七十一：AI 智能体会话先归口会话列表（确定当前查看会话）再按区间拉历史；
        // 普通会话直接拉全量历史（行为不变）
        updateSendBtnState(); // 阶段七十三：切换会话后按新会话的生成/任务状态刷新发送按钮
        if (user && isAIAgent(user)) {
            aiSessionRequestList(user, function () { loadHistory(); });
        } else {
            loadHistory();
        }
    }

    function loadHistory() {
        historyTarget = currentChatUser;
        var msg = { msg_type: MSG.HISTORY, page: 1, page_size: PAGE_SIZE };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        // 阶段七十一：AI 多会话恒传当前查看会话（服务端按消息盖戳 ai_session_id 过滤；
        // 0=默认会话存量全量，普通会话不传不受影响）
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            msg.session_id = aiViewSession[currentChatUser] || 0;
        }
        IMSocket.send(msg);
    }

    // ====== 阶段七十一：AI 多会话（Trae 同款"新建会话"）======
    // 归属归口：服务端消息级盖戳（im_message.ai_session_id），上下文/历史/任务卡全部按列过滤；
    // AI 提问、Agent 任务、流式回复/事件帧均携带 session_id（服务端落库同源），客户端仅持有查看态——
    // aiViewSession 记录各智能体当前查看的会话 id（HISTORY/发问盖戳/渲染过滤按它归口，任意会话可续聊）
    var aiSessions = {};      // agent -> { list: [{id,title,first_msg_id,create_time}], currentId }
    var aiViewSession = {};   // agent -> 当前查看会话 id（0=默认全量，无会话行）
    var aiSessionListCb = {}; // agent -> 会话列表响应回调（openConversation 等列表到达后再拉历史）
    var aiClearPending = null; // 阶段七十二：在途清空请求 {agent,sid}——清空回执（列表帧）到达后按此刷新当前查看视图（他端清空不受影响，视图下次切换自然归位）

    // aiSessionDisplayList 服务端无会话行时注入虚拟"默认会话"（id=0=全量历史，老用户无感）
    function aiSessionDisplayList(agent) {
        var st = aiSessions[agent];
        if (st && st.list.length) return st.list;
        return [{ id: 0, title: '默认会话', first_msg_id: 0, create_time: 0 }];
    }

    function aiSessionExists(agent, sid) {
        return aiSessionDisplayList(agent).some(function (s) { return s.id === sid; });
    }

    // aiSessionRequestList 拉会话列表（AI_SESSION_LIST 响应归口更新缓存/面板并回调）；
    // 2.5s 兜底：旧服务端不识别新帧时直接回调（session_id=0 全量，行为不回退）
    function aiSessionRequestList(agent, cb) {
        var done = false;
        var finish = function () {
            if (done) return;
            done = true;
            delete aiSessionListCb[agent];
            if (cb) cb();
        };
        var to = setTimeout(finish, 2500);
        aiSessionListCb[agent] = function () {
            if (done) return;
            done = true;
            clearTimeout(to);
            if (cb) cb();
        };
        IMSocket.send({ msg_type: MSG.AI_SESSION_LIST, to_user: agent });
    }

    function closeAISessionPanel() {
        var p = document.getElementById('ai-session-panel');
        if (p) p.classList.add('hidden');
    }

    function renderAISessionPanel(agent) {
        var box = document.getElementById('ai-session-list');
        if (!box) return;
        box.innerHTML = '';
        var view = aiViewSession[agent] || 0;
        aiSessionDisplayList(agent).forEach(function (s) {
            var item = document.createElement('div');
            item.className = 'ai-session-item' + (s.id === view ? ' active' : '');
            var main = document.createElement('div');
            main.className = 'ai-session-item-main';
            var t = document.createElement('div');
            t.className = 'ai-session-item-title';
            t.textContent = s.title || '未命名会话';
            var tm = document.createElement('div');
            tm.className = 'ai-session-item-time';
            tm.textContent = s.create_time ? thFormatTime(s.create_time * 1000) : '全部历史'; // create_time 为 Unix 秒（任务历史 API 为毫秒，thFormatTime 归一口径）
            main.appendChild(t);
            main.appendChild(tm);
            item.appendChild(main);
            // 阶段七十二：清空按钮（扫帚图标，真删除消息，所有会话含默认会话均有——默认会话堆积的唯一消化入口）
            var clr = document.createElement('button');
            clr.className = 'ai-session-item-del ai-session-item-clear';
            clr.title = '清空会话（彻底删除消息，不可恢复）';
            // 扫帚 SVG：柄=描边斜线，帚头=实心大梯形（实心比描边在 18px 下辨识度高），与垃圾桶图标区分度最高；currentColor 随悬停变红
            clr.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M20 4 L12.6 11.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M11.2 10.2 L13.8 12.8 L10.6 20 L3.2 12.8 Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
            clr.addEventListener('click', function (e) {
                e.stopPropagation();
                var isDefault = s.id === 0;
                var name = isDefault ? '默认会话' : '「' + (s.title || '未命名会话') + '」';
                showConfirm('清空会话', '将彻底删除' + name + '的全部消息与任务记录，此操作不可恢复。确定清空吗？', function () {
                    aiClearPending = { agent: agent, sid: s.id }; // 列表回执（清空完成后下发）到达时按此刷新当前查看视图
                    IMSocket.send({ msg_type: MSG.AI_SESSION_DEL, to_user: agent, session_id: s.id, clear: true });
                }, '清空');
            });
            item.appendChild(clr);
            if (s.id > 0) { // 虚拟默认会话（id=0）不可删除，仅可清空
                var del = document.createElement('button');
                del.className = 'ai-session-item-del';
                del.title = '删除会话';
                // 阶段七十二：删除按钮改垃圾桶图标（与"清空聊天"按钮同款 SVG，currentColor 随悬停变红；15px 保证小面板下可辨识）
                del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    showConfirm('删除会话', '删除后该会话消息将并入默认会话展示，确定删除「' + (s.title || '未命名会话') + '」吗？', function () {
                        IMSocket.send({ msg_type: MSG.AI_SESSION_DEL, to_user: agent, session_id: s.id });
                    }, '删除');
                });
                item.appendChild(del);
            }
            item.addEventListener('click', function () {
                if ((aiViewSession[agent] || 0) === s.id) { closeAISessionPanel(); return; }
                aiSwitchSession(agent, s.id);
            });
            box.appendChild(item);
        });
    }

    // aiSwitchSession 切换查看会话：清空视图按新区间重拉（与 openConversation 同口径），
    // 在途流式/任务卡按帧内 session_id 过滤自动隔离（回复落库按会话归位，切回经历史可见）
    function aiSwitchSession(agent, sid) {
        aiViewSession[agent] = sid;
        closeAISessionPanel();
        messageList.innerHTML = '';
        historyPage = 1;
        historyHasMore = true;
        loadingMore = false;
        for (var sid2 in aiStreams) {
            if (aiStreams[sid2].timer) clearInterval(aiStreams[sid2].timer);
            delete aiStreams[sid2];
        }
        for (var ag in aiThinking) delete aiThinking[ag];
        updateSendBtnState(); // 阶段七十三：会话内切换后刷新发送按钮态（视图已清，问答流标记随帧重建）
        loadHistory();
    }

    // 会话列表响应：更新缓存；查看中的会话已被删除（他端操作）时回落到最新会话并重载视图
    // 响应帧按协议惯例 from=发起人自己，智能体名取 to_user（服务端归口回填）
    IMSocket.on(MSG.AI_SESSION_LIST, function (msg) {
        var agent = msg.to_user;
        if (!isAIAgent(agent)) return;
        var data;
        try { data = JSON.parse(msg.content) || {}; } catch (e) { return; }
        aiSessions[agent] = { list: data.sessions || [], currentId: data.current_id || 0 };
        if (!aiSessionExists(agent, aiViewSession[agent] || 0)) {
            aiViewSession[agent] = aiSessions[agent].currentId;
            if (currentChatUser === agent) {
                messageList.innerHTML = '';
                historyPage = 1;
                historyHasMore = true;
                loadingMore = false;
                loadHistory();
            }
        }
        // 阶段七十二：清空回执（列表帧仅在清空落库后下发）——正在查看被清空会话时立即刷新为空态
        if (aiClearPending && aiClearPending.agent === agent) {
            var p = aiClearPending;
            aiClearPending = null;
            if ((aiViewSession[agent] || 0) === p.sid && currentChatUser === agent) {
                messageList.innerHTML = '';
                historyPage = 1;
                historyHasMore = true;
                loadingMore = false;
                loadHistory(); // 服务端已删空，回执后重拉得到空态提示
            }
        }
        renderAISessionPanel(agent);
        if (aiSessionListCb[agent]) aiSessionListCb[agent]();
    });

    // 新建会话响应：切换到新会话（服务端返回空页 → 空态提示），并刷新会话列表缓存
    // 响应帧按协议惯例 from=发起人自己，智能体名取 to_user（原误取 from_user 致 isAIAgent 校验失败静默丢弃——"点击新建没反应"根因）
    IMSocket.on(MSG.AI_SESSION_NEW, function (msg) {
        var agent = msg.to_user;
        if (!isAIAgent(agent)) return;
        var data;
        try { data = JSON.parse(msg.content) || {}; } catch (e) { return; }
        if (currentChatUser !== agent) return; // 入口仅在当前会话视图，他端响应不处理
        aiViewSession[agent] = data.session_id || 0;
        closeAISessionPanel();
        messageList.innerHTML = '';
        historyPage = 1;
        historyHasMore = true;
        loadingMore = false;
        aiSessionRequestList(agent);
        loadHistory();
    });

    // 阶段七十一：新会话空态提示（历史为空时居中引导；首条消息上屏时由 appendMessage 移除）
    function renderAISessionEmpty() {
        if (messageList.querySelector('.ai-session-empty')) return;
        var d = document.createElement('div');
        d.className = 'ai-session-empty';
        d.textContent = '开始新的对话吧，直接输入提问，或开启 Agent 模式派发任务';
        messageList.appendChild(d);
    }

    // 会话面板交互：开合 + 新建（事件委托绑一次，渲染仅刷新列表区）
    (function () {
        var btn = document.getElementById('ai-session-btn');
        var panel = document.getElementById('ai-session-panel');
        var newBtn = document.getElementById('ai-session-new');
        var closeBtn = document.getElementById('ai-session-close');
        if (!btn || !panel) return;
        btn.addEventListener('click', function () {
            if (currentChatUser === '' || !isAIAgent(currentChatUser)) return;
            if (!panel.classList.contains('hidden')) { closeAISessionPanel(); return; }
            panel.classList.remove('hidden');
            renderAISessionPanel(currentChatUser);
            aiSessionRequestList(currentChatUser); // 打开即刷新（服务端归口）
        });
        closeBtn.addEventListener('click', closeAISessionPanel);
        newBtn.addEventListener('click', function () {
            if (currentChatUser === '' || !isAIAgent(currentChatUser)) return;
            IMSocket.send({ msg_type: MSG.AI_SESSION_NEW, to_user: currentChatUser });
        });
    })();

    // 阶段二十七：滚动到顶部自动加载更早的历史消息（prepend 渲染并保持滚动位置不跳动）
    // 原实现：无滚动加载机制，窗口内只有最近 20 条，更早记录无法查看
    messageList.addEventListener('scroll', function () {
        if (locateState.active || loadingMore || !historyHasMore) return; // 定位翻页中/请求中/无更多：不触发
        if (messageList.scrollTop > 60) return; // 未滚动到顶部附近
        if (messageList.scrollHeight <= messageList.clientHeight) return; // 内容未撑满一屏时不触发
        loadingMore = true;
        var msg = { msg_type: MSG.HISTORY, page: historyPage + 1, page_size: PAGE_SIZE };
        if (currentChatUser !== '') msg.to_user = currentChatUser;
        // 阶段七十一：翻页同口径按当前查看会话拉取
        if (currentChatUser !== '' && isAIAgent(currentChatUser)) {
            msg.session_id = aiViewSession[currentChatUser] || 0;
        }
        IMSocket.send(msg);
    });

    IMSocket.on(MSG.HISTORY_RESP, function (msg) {
        // 响应与会话不匹配（期间用户已切换会话）则忽略
        var target = msg.to_user || '';
        if (target !== historyTarget || target !== currentChatUser) return;

        var records = [];
        try { records = JSON.parse(msg.content) || []; } catch (e) {}
        // 阶段八十五：先合并服务端下发的页内发送者昵称映射（服务端归口），再渲染（群聊标签/引用前缀/撤回提示共用）
        if (msg.names) {
            for (var nk in msg.names) {
                if (msg.names[nk]) nickCache[nk] = msg.names[nk];
            }
        }

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
        // 阶段七十一：空会话空态引导（新建会话/默认空会话；首条消息上屏时移除）
        if (!records.length && isAIAgent(target)) renderAISessionEmpty();

        // 阶段七十：智能体会话历史渲染后归口恢复任务可见性——
        // 已完结任务在答复气泡前内联重放任务卡（执行过程 DB 归口），运行中任务重挂实时卡续播
        if (isAIAgent(currentChatUser)) agentReplayTasks();

        // 阶段七十二：历史渲染后补挂永久删除审批卡片（若有未处理/已终态申请）
        renderPurgeCard();

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
            tip.textContent = (isMine ? '你' : senderDisplayName(r.from_user)) + ' 撤回了一条消息';
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

    // 阶段八十六：会话对端在线状态统一解析——好友以 friendList.online（USER_STATUS 逐条联动）为准；
    // 非好友没有好友条目，从 USER_LIST 在线快照兜底（原实现直接判'离线'，非好友私聊恒显离线）
    function isPeerOnline(u) {
        if (!u) return false;
        if (u === IMSocket.getUsername()) return true; // 自己与自己的多端会话视为在线
        for (var i = 0; i < friendList.length; i++) {
            if (friendList[i].username === u) return !!friendList[i].online;
        }
        return !!onlineUsers[u];
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
            chatStatus.textContent = isPeerOnline(currentChatUser) ? '在线' : '离线';
        }
        // 阶段五十八：记忆管理按钮仅 AI 智能体会话显示（群聊/普通用户会话隐藏）
        memoryBtn.classList.toggle('hidden', !(currentChatUser !== '' && isAIAgent(currentChatUser)));
        // 阶段六十四：任务历史按钮同口径显隐（与记忆按钮一致，仅 AI 智能体会话显示）
        var taskhistBtn = document.getElementById('taskhist-btn');
        if (taskhistBtn) taskhistBtn.classList.toggle('hidden', !(currentChatUser !== '' && isAIAgent(currentChatUser)));
        // 阶段七十一：AI 多会话按钮同口径显隐（Trae 同款"新建会话"入口）
        var aiSessionBtn = document.getElementById('ai-session-btn');
        if (aiSessionBtn) {
            aiSessionBtn.classList.toggle('hidden', !(currentChatUser !== '' && isAIAgent(currentChatUser)));
            if (aiSessionBtn.classList.contains('hidden')) closeAISessionPanel();
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
        // ai 标记：AI 智能体消息行放宽 max-width（宽表格/代码块按需扩大展示范围；普通用户消息保持 70%）
        div.className = 'message ' + type + (isAIAgent(fromUser) ? ' ai' : '');
        // 携带消息 ID / 发送者 / 时间戳，供撤回、删除、已读、置顶定位功能使用
        if (msgId) div.setAttribute('data-msg-id', msgId);
        div.setAttribute('data-from', fromUser);
        if (timestamp) div.setAttribute('data-ts', timestamp);
        // 阶段八十六：消息转发——保留原始 content（纯文本或引用信封 JSON），转发时原样重发（引用块完整保真）；
        // 超过 64KB（如含 dataURL 图片的引用信封）不存，转发时降级取气泡可见文本
        if (content && String(content).length <= 65536) div.setAttribute('data-raw', content);
        var nameEl = document.createElement('div');
        nameEl.className = 'message-name';
        // 阶段八十五：发送者展示名（备注→昵称→账号），历史与实时同源解析
        nameEl.textContent = senderDisplayName(fromUser);
        var bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        // 阶段四十：引用消息渲染——content 为引用信封时，气泡内先渲染引用块（灰底小字，点击定位原消息）再渲染回复正文；
        // 阶段四十一：引用块加"引用"前缀（用户一眼识别引用消息）；quote.url 存在时显示真实图片缩略图
        // 原实现：bubble.textContent = content（引用信封会原样显示 JSON 串）
        // 阶段四十四：AI 图片提问信封（{"image":url,"text":附言}）渲染为图片气泡 + 附言——
        // 仅对自己的消息且当前为 AI 会话时判定，普通聊天里手打的 JSON 字符串不受影响
        // 阶段四十五：AI 文档问答信封（{"doc":url,"name":文件名,"text":附言}）渲染为文件卡片 + 附言
        // 阶段八十七：合并转发信封（{"merged":{c:条数,i:[{f:发送者,k:类型,...}]}}）渲染为"聊天记录"卡片气泡
        var mergedEnv = parseMergedEnvelope(content);
        var aiDocEnv = mergedEnv ? null : ((type === 'self' && isAIAgent(currentChatUser)) ? parseAIDocEnvelope(content) : null);
        var aiImgEnv = (mergedEnv || aiDocEnv) ? null : ((!aiDocEnv && type === 'self' && isAIAgent(currentChatUser)) ? parseAIImageEnvelope(content) : null);
        var envelope = (aiDocEnv || aiImgEnv || mergedEnv) ? null : parseQuoteEnvelope(content);
        if (mergedEnv) {
            // 微信"聊天记录"卡片：标题 + 参与人摘要 + 条数，点击打开详情弹窗（openMergedDetail）
            bubble.classList.add('merged-bubble');
            var mTitle = document.createElement('div');
            mTitle.className = 'merged-title';
            mTitle.textContent = '聊天记录';
            bubble.appendChild(mTitle);
            var mNames = [];
            (mergedEnv.i || []).forEach(function (it) {
                var dn = senderDisplayName(it.f);
                if (dn && mNames.indexOf(dn) < 0 && mNames.length < 4) mNames.push(dn);
            });
            var mSub = document.createElement('div');
            mSub.className = 'merged-sub';
            mSub.textContent = mNames.join('、') + '：' + (mergedEnv.c || (mergedEnv.i || []).length) + '条消息';
            bubble.appendChild(mSub);
            // 详情数据注册缓存（信封可能超过 data-raw 的 64KB 上限，DOM 属性不可靠，走运行时缓存）
            var mergeKey = 'mk' + Date.now() + '_' + (mergedSeq++);
            mergedCache[mergeKey] = mergedEnv;
            bubble.setAttribute('data-merge-key', mergeKey);
            bubble.addEventListener('click', function () {
                openMergedDetail(mergeKey);
            });
        } else if (aiDocEnv) {
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
            // 阶段八十五：来源按展示名解析（备注→昵称→账号），群聊/私聊引用一致
            var qLabel = document.createElement('span');
            qLabel.className = 'msg-quote-text';
            qLabel.textContent = '引用 ' + (senderDisplayName(q.from) || '') + '：' + (q.text || '');
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
        // AI 回复（历史加载/END 降级整段渲染）DOM 稳定后，宽表格/代码块挂横向自绘滑块
        if (isAIAgent(fromUser)) initAIMdHScroll(div);
        return div;
    }

    // 实时消息：构建元素后追加到列表末尾并滚动到底部
    // tokens 可选：AI 回复 Token 消耗（END 降级整段渲染路径透传）
    function appendMessage(fromUser, content, type, msgId, timestamp, showReadStatus, isRead, tokens) {
        // 阶段七十一：新会话首条消息上屏时移除空态引导
        var emptyTip = messageList.querySelector('.ai-session-empty');
        if (emptyTip) emptyTip.remove();
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

    function openImageViewer(url, listOverride) {
        // 阶段八十七：listOverride（合并转发详情）直接以指定列表查看（信封内图片均为服务器 URL），
        // 不收集聊天窗口 DOM——详情弹窗属 modal 层，混入聊天列表会出现"看不见的图"参与翻页
        if (listOverride && listOverride.length) {
            var oList = listOverride.slice();
            var oTarget = (url && oList.indexOf(url) >= 0) ? url : oList[0];
            var oIdx = oList.indexOf(oTarget);
            if (window.desktop && window.desktop.openImageViewer) {
                window.desktop.openImageViewer({ url: oTarget, list: oList, index: oIdx });
            } else {
                window.__imageViewerList = oList;
                window.open('/image-viewer.html?url=' + encodeURIComponent(oTarget), '_blank');
            }
            return;
        }
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
        // 阶段八十五：发送者展示名（备注→昵称→账号）
        nameEl.textContent = senderDisplayName(fromUser);
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
        // 阶段八十五：发送者展示名（备注→昵称→账号）
        nameEl.textContent = senderDisplayName(fromUser);
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
            // 阶段八十六：消息转发需要文件源地址（服务端 URL 或本地 blob），存 DOM 供转发重取
            bubble.setAttribute('data-url', url);
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
        // 阶段一百零五：签名比对防闪烁——5 秒轮询展开面板每次回调都会重渲染，
        // 数据无变化时跳过（原实现弹窗开着每 5 秒整弹窗清空重建，展开/悬停交互被打断）
        var ksig = JSON.stringify([kbData, kbFilesCache, kbExpanded]);
        if (ksig === kbRender._sig) return;
        kbRender._sig = ksig;
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

    // ===== 阶段一百零四：规则页签（TRAE CN 同款"AI 回答前先看规则"）=====
    var memTabs = document.querySelectorAll('.memtabs .memtab');
    var tabRules = document.getElementById('tab-rules');
    var tabMemory = document.getElementById('tab-memory');
    var ruleScopeSel = document.getElementById('rule-scope');
    var ruleInput = document.getElementById('rule-input');
    var ruleAddBtn = document.getElementById('rule-add-btn');
    var ruleListEl = document.getElementById('rule-list');
    var ruleClearBtn = document.getElementById('rule-clear');
    var memTabCur = 'rules'; // 当前页签（默认规则：弹窗主诉求即规则管理）

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
        memTabShow(memTabCur); // 阶段一百零四：按当前页签展示并加载（默认规则）
    }

    // 阶段一百零四：页签切换归口（显隐面板/清空按钮/状态行文案，并加载对应列表）
    function memTabShow(tab) {
        memTabCur = tab;
        memTabs.forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
        tabRules.classList.toggle('hidden', tab !== 'rules');
        tabMemory.classList.toggle('hidden', tab !== 'memory');
        ruleClearBtn.classList.toggle('hidden', tab !== 'rules');
        memoryClearBtn.classList.toggle('hidden', tab !== 'memory');
        if (tab === 'rules') {
            memoryStatusEl.textContent = '当前智能体：' + currentChatUser + '（规则分 全局/本智能体 两层，回答与任务执行前都会先对照检查）';
            ruleListEl.innerHTML = '<div class="kb-empty">加载中…</div>';
            rulesLoad();
        } else {
            memoryStatusEl.textContent = '当前智能体：' + currentChatUser + '（记忆按 账号+智能体 隔离，仅你可见）';
            memoryListEl.innerHTML = '<div class="kb-empty">加载中…</div>';
            memLoad();
        }
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

            // 来源标签：手动添加（主题色实底）/ 任务经验（主题色描边，Agent 任务沉淀）/ 自动提取（灰）
            // 原实现：仅 manual/auto 两态；阶段六十三新增 Agent 任务经验来源
            var tag = document.createElement('span');
            if (m.source === 'manual') {
                tag.className = 'kb-item-tag user';
                tag.textContent = '手动';
            } else if (m.source === 'agent') {
                tag.className = 'kb-item-tag agent';
                tag.textContent = '任务';
            } else {
                tag.className = 'kb-item-tag public';
                tag.textContent = '自动';
            }

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

    // ===== 阶段一百零四：规则管理（服务端归口 /api/agents/{id}/rules，注入在问答与 Agent 任务双链路）=====

    // 拉取规则列表（该用户全部规则：全局 + 当前智能体级，含禁用项）
    function rulesLoad() {
        var id = memAgentId();
        if (!id) { memCloseDialog(); return; }
        fetch('/api/agents/' + id + '/rules?username=' + kbUsername())
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '规则加载失败'); return; }
                rulesRender(res.data.rules || []);
            })
            .catch(function () { showToast('规则加载失败'); });
    }

    function rulesRender(list) {
        ruleListEl.innerHTML = '';
        if (!list.length) {
            ruleListEl.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '暂无规则，添加一条如"所有回答使用中文"试试' }));
            return;
        }
        list.forEach(function (ru) {
            var item = document.createElement('div');
            item.className = 'kb-item';

            var head = document.createElement('div');
            head.className = 'kb-item-head';

            // 规则正文（单行截断，悬停 title 看全文）
            var name = document.createElement('span');
            name.className = 'kb-item-name';
            name.textContent = ru.content;
            name.title = ru.content;

            // 范围标签：全局（主题色实底，对该用户全部智能体生效）/ 本智能体（描边）
            var tag = document.createElement('span');
            if (ru.agent_id === 0) {
                tag.className = 'kb-item-tag user';
                tag.textContent = '全局';
            } else {
                tag.className = 'kb-item-tag agent';
                tag.textContent = '本智能体';
            }

            // 启用开关（禁用后不注入不删除，可随时恢复）
            var en = document.createElement('input');
            en.type = 'checkbox';
            en.className = 'memory-switch rule-enable';
            en.checked = !!ru.enabled;
            en.title = en.checked ? '已启用（点击禁用）' : '已禁用（点击启用）';
            en.addEventListener('change', function () {
                var want = en.checked;
                fetch('/api/agents/' + memAgentId() + '/rules/' + ru.id + '/enabled?username=' + kbUsername(), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: want })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '保存失败'); en.checked = !want; return; }
                        showToast(want ? '规则已启用' : '规则已禁用（不删除）');
                    })
                    .catch(function () { showToast('保存失败'); en.checked = !want; });
            });

            var ops = document.createElement('span');
            ops.className = 'kb-item-ops';
            var delBtn = document.createElement('button');
            delBtn.className = 'kb-op-btn';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', function () {
                fetch('/api/agents/' + memAgentId() + '/rules/' + ru.id + '?username=' + kbUsername(), { method: 'DELETE' })
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { showToast(res.msg || '删除失败'); return; }
                        showToast('规则已删除');
                        rulesLoad();
                    })
                    .catch(function () { showToast('删除失败'); });
            });
            ops.appendChild(delBtn);

            head.appendChild(name);
            head.appendChild(tag);
            head.appendChild(en);
            head.appendChild(ops);
            item.appendChild(head);
            ruleListEl.appendChild(item);
        });
    }

    // 新增规则（scope=agent 仅本智能体 / global 全局）
    function rulesAdd() {
        var content = ruleInput.value.trim();
        if (!content) { showToast('请输入规则内容'); return; }
        ruleAddBtn.disabled = true;
        fetch('/api/agents/' + memAgentId() + '/rules?username=' + kbUsername(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, scope: ruleScopeSel.value })
        })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '添加失败'); return; }
                showToast('规则已添加，下轮回答即生效');
                ruleInput.value = '';
                rulesLoad();
            })
            .catch(function () { showToast('添加失败'); })
            .finally(function () { ruleAddBtn.disabled = false; });
    }

    ruleClearBtn.addEventListener('click', function () {
        var scope = ruleScopeSel.value;
        var tip = scope === 'global' ? '确定清空你的全部全局规则？此操作不可恢复。' : '确定清空与「' + currentChatUser + '」的全部智能体规则？此操作不可恢复。';
        showConfirm('清空规则', tip, function () {
            fetch('/api/agents/' + memAgentId() + '/rules?username=' + kbUsername() + '&scope=' + scope, { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (!res.ok) { showToast(res.msg || '清空失败'); return; }
                    showToast('规则已清空');
                    rulesLoad();
                })
                .catch(function () { showToast('清空失败'); });
        }, '清空');
    });

    memoryBtn.addEventListener('click', memOpenDialog);
    memoryCloseBtn.addEventListener('click', memCloseDialog);
    memTabs.forEach(function (b) {
        b.addEventListener('click', function () { memTabShow(b.dataset.tab); });
    });
    ruleAddBtn.addEventListener('click', rulesAdd);
    ruleInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            rulesAdd();
        }
    });
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

    // ===== 阶段六十四：Agent 任务历史（本人任务分页列表/状态筛选/点击展开详情） =====
    // 服务端归口：GET /api/agent/tasks（分页+状态筛选）/ GET /api/agent/task/{task_id}（全文详情），
    // 此处仅展示；运行中任务同样入库可见，展开后可点"刷新"查看最新状态
    var taskhistBtn = document.getElementById('taskhist-btn');
    var taskhistMask = document.getElementById('taskhist-mask');
    var taskhistStatusEl = document.getElementById('taskhist-status');
    var taskhistFilterEl = document.getElementById('taskhist-filter');
    var taskhistListEl = document.getElementById('taskhist-list');
    var taskhistPageInfo = document.getElementById('taskhist-page-info');
    var taskhistPrev = document.getElementById('taskhist-prev');
    var taskhistNext = document.getElementById('taskhist-next');
    var taskhistClose = document.getElementById('taskhist-close');
    var thPage = 1;        // 当前页码
    var thTotal = 0;       // 匹配总条数
    var TH_SIZE = 20;      // 每页条数（与服务端上限一致）
    var thStatus = '';     // 当前状态筛选（空=全部）
    var thExpandId = '';   // 当前展开详情的 task_id（翻页后保持展开语义无必要，翻页重置）

    // thStateLabel 状态中文标签映射（queued 排队中/running 运行中/completed 已完成/failed 失败/cancelled 已取消）
    function thStateLabel(s) {
        return { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' }[s] || s;
    }

    // thFormatTime 时间展示归口：yyyy-MM-dd HH:mm
    function thFormatTime(ts) {
        var d = new Date(ts);
        if (!ts || isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
            ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function taskhistOpenDialog() {
        if (currentChatUser === '' || !isAIAgent(currentChatUser)) return;
        taskhistMask.classList.remove('hidden');
        taskhistStatusEl.textContent = '当前智能体：' + currentChatUser + '（任务历史仅本人可见）';
        taskhistListEl.innerHTML = '<div class="kb-empty">加载中…</div>';
        thPage = 1;
        thStatus = '';
        // 重置筛选 chips 到"全部"
        taskhistFilterEl.querySelectorAll('.taskhist-chip').forEach(function (c) {
            c.classList.toggle('active', c.dataset.status === '');
        });
        taskhistLoad();
    }

    function taskhistCloseDialog() {
        taskhistMask.classList.add('hidden');
    }

    // taskhistLoad 拉取任务分页列表（筛选与页码取自模块内状态）
    function taskhistLoad() {
        var url = '/api/agent/tasks?username=' + encodeURIComponent(kbUsername()) +
            '&page=' + thPage + '&size=' + TH_SIZE;
        if (thStatus) url += '&status=' + encodeURIComponent(thStatus);
        taskhistListEl.innerHTML = '<div class="kb-empty">加载中…</div>';
        fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { showToast(res.msg || '加载失败'); taskhistListEl.innerHTML = '<div class="kb-empty">加载失败</div>'; return; }
                thTotal = res.data.total || 0;
                var pages = Math.max(1, Math.ceil(thTotal / TH_SIZE));
                if (thPage > pages) { thPage = pages; taskhistLoad(); return; } // 筛选后页码越界兜底
                taskhistRender(res.data.tasks || []);
                taskhistPageInfo.textContent = thTotal ? ('共 ' + thTotal + ' 条 · 第 ' + thPage + ' / ' + pages + ' 页') : '暂无任务';
                taskhistPrev.disabled = thPage <= 1;
                taskhistNext.disabled = thPage >= pages;
            })
            .catch(function () { showToast('加载失败'); taskhistListEl.innerHTML = '<div class="kb-empty">加载失败</div>'; });
    }

    // taskhistRender 任务卡渲染：状态徽标 + 目标摘要 + 元信息；点击卡片展开/收起全文详情
    // 详情全文按需拉取（列表项 goal/result 为截断摘要），展开态懒加载避免列表响应过大
    function taskhistRender(tasks) {
        taskhistListEl.innerHTML = '';
        if (!tasks.length) {
            taskhistListEl.appendChild(Object.assign(document.createElement('div'), { className: 'kb-empty', textContent: '暂无任务' }));
            return;
        }
        tasks.forEach(function (t) {
            var card = document.createElement('div');
            card.className = 'taskhist-card' + (t.task_id === thExpandId ? ' expanded' : '');

            var head = document.createElement('div');
            head.className = 'taskhist-head';
            // 状态徽标（状态名做 class 锚点，主题色变量关联）
            var badge = document.createElement('span');
            badge.className = 'taskhist-badge st-' + t.status;
            badge.textContent = thStateLabel(t.status);
            // 目标摘要（单行截断，悬停 title 看列表截断文本）
            var goal = document.createElement('span');
            goal.className = 'taskhist-goal';
            goal.textContent = t.goal || '(无目标)';
            goal.title = t.goal || '';
            head.appendChild(badge);
            head.appendChild(goal);
            card.appendChild(head);

            // 元信息行：智能体 · N 步 · 发起时间（结束态展示最近活动时间）
            var meta = document.createElement('div');
            meta.className = 'taskhist-meta';
            meta.textContent = t.agent_name + ' · ' + (t.steps || 0) + ' 步 · ' + thFormatTime(t.update_time || t.create_time);
            card.appendChild(meta);

            // 详情容器（展开时懒加载全文）
            var detail = document.createElement('div');
            detail.className = 'taskhist-detail hidden';
            card.appendChild(detail);

            card.addEventListener('click', function () {
                if (card.classList.contains('expanded')) {
                    card.classList.remove('expanded');
                    detail.classList.add('hidden');
                    thExpandId = '';
                    return;
                }
                // 收起其他已展开卡片（手风琴语义，避免长详情堆叠看不清）
                taskhistListEl.querySelectorAll('.taskhist-card.expanded').forEach(function (c) {
                    c.classList.remove('expanded');
                    c.querySelector('.taskhist-detail').classList.add('hidden');
                });
                card.classList.add('expanded');
                thExpandId = t.task_id;
                detail.classList.remove('hidden');
                detail.textContent = '加载详情…';
                fetch('/api/agent/task/' + encodeURIComponent(t.task_id) + '?username=' + encodeURIComponent(kbUsername()))
                    .then(function (r) { return r.json(); })
                    .then(function (res) {
                        if (!res.ok) { detail.textContent = res.msg || '详情加载失败'; return; }
                        var d = res.data || {};
                        detail.innerHTML = '';
                        // 详情行构造辅助：标签 + pre-wrap 正文（保留换行）
                        function row(label, text) {
                            if (!text) return;
                            var lab = document.createElement('div');
                            lab.className = 'taskhist-d-label';
                            lab.textContent = label;
                            var body = document.createElement('div');
                            body.className = 'taskhist-d-body';
                            body.textContent = text;
                            detail.appendChild(lab);
                            detail.appendChild(body);
                        }
                        row('任务目标', d.goal);
                        if (d.status === 'completed') row('最终总结', d.result);
                        if (d.status === 'failed') row('失败原因', d.error);
                        if (d.status === 'cancelled') row('取消说明', d.error);
                        // 阶段六十五：详情渲染完成后追加执行轨迹区块（在详情回调内触发，避免 innerHTML 清空竞态）
                        thLoadSteps(detail, t.task_id);
                    })
                    .catch(function () { detail.textContent = '详情加载失败'; });
            });
            taskhistListEl.appendChild(card);
        });
    }

    taskhistBtn.addEventListener('click', taskhistOpenDialog);
    taskhistClose.addEventListener('click', taskhistCloseDialog);

    // ===== 阶段六十五：执行轨迹渲染 =====
    // thApprovalLabel 审批情况标签文案归口
    function thApprovalLabel(a) {
        return { none: '免审批', approved: '审批通过', rejected: '用户拒绝', cancelled: '用户取消', timeout: '审批超时' }[a] || a || '—';
    }
    // thEnvLabel 执行环境标签文案归口
    function thEnvLabel(e) {
        return e === 'pc' ? '本地执行' : '服务端';
    }
    // thLoadSteps 执行轨迹拉取与渲染：每步工具调用时间线（序号/工具/环境/审批/耗时 + 参数结果摘要）
    // 调用时机由任务详情回调触发（详情渲染完成后追加，避免并行竞态清空）
    function thLoadSteps(detail, taskID) {
        var box = document.createElement('div');
        box.className = 'th-steps';
        box.textContent = '执行轨迹加载中…';
        detail.appendChild(box);
        fetch('/api/agent/task/' + encodeURIComponent(taskID) + '/steps?username=' + encodeURIComponent(kbUsername()))
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { box.textContent = res.msg || '执行轨迹加载失败'; return; }
                var steps = res.data.steps || [];
                box.innerHTML = '';
                var title = document.createElement('div');
                title.className = 'th-steps-title';
                title.textContent = steps.length ? ('执行轨迹（' + steps.length + ' 步）') : '执行轨迹（无工具调用）';
                box.appendChild(title);
                steps.forEach(function (s) {
                    var item = document.createElement('div');
                    item.className = 'th-step' + (s.ok ? '' : ' fail');
                    var head = document.createElement('div');
                    head.className = 'th-step-head';
                    var seq = document.createElement('span');
                    seq.className = 'th-step-seq';
                    seq.textContent = s.seq;
                    var tool = document.createElement('span');
                    tool.className = 'th-step-tool';
                    tool.textContent = s.tool;
                    head.appendChild(seq);
                    head.appendChild(tool);
                    // 元信息一次拼接：执行环境 · 审批情况 · 耗时
                    var meta = document.createElement('span');
                    meta.className = 'th-step-meta';
                    meta.textContent = thEnvLabel(s.env) + ' · ' + thApprovalLabel(s.approval) + ' · ' + (s.duration_ms || 0) + 'ms';
                    head.appendChild(meta);
                    item.appendChild(head);
                    if (s.params) {
                        var p = document.createElement('div');
                        p.className = 'th-step-body';
                        p.textContent = '参数：' + s.params;
                        p.title = s.params; // 悬停看全文（服务端已截断）
                        item.appendChild(p);
                    }
                    if (s.result) {
                        var rEl = document.createElement('div');
                        rEl.className = 'th-step-body';
                        rEl.textContent = (s.ok ? '结果：' : '错误：') + s.result;
                        rEl.title = s.result;
                        item.appendChild(rEl);
                    }
                    box.appendChild(item);
                });
            })
            .catch(function () { box.textContent = '执行轨迹加载失败'; });
    }

    taskhistPrev.addEventListener('click', function () { if (thPage > 1) { thPage--; taskhistLoad(); } });
    taskhistNext.addEventListener('click', function () { thPage++; taskhistLoad(); });
    // 状态筛选 chips：切换后重置页码并重新加载
    taskhistFilterEl.addEventListener('click', function (e) {
        var chip = e.target.closest('.taskhist-chip');
        if (!chip) return;
        taskhistFilterEl.querySelectorAll('.taskhist-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        thStatus = chip.dataset.status || '';
        thPage = 1;
        taskhistLoad();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !taskhistMask.classList.contains('hidden')) taskhistCloseDialog();
    });

    // ===== 阶段四十四：滚动条悬停显隐（微信设置页同款：默认隐藏，悬停滚动容器浮现，移出立即隐藏） =====
    // 纯 CSS :hover 在 Chromium 滚动条伪元素上存在滞留（拖动滑块后移出/快速划过时 hover 不重算，滑块不消失），
    // 改由 JS 精确控制：mouseover 时给最近的滚动容器加 .sb-hover（滑块浮现），mouseout 时移除（滑块隐藏）
    (function () {
        var sbLast = null; // 当前标记的滚动容器
        // 判定是否为可滚动元素（存在纵向或横向溢出才可能显示滚动条；横向用于标签栏等纯横滚容器）
        function sbScrollable(el) {
            return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
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
        // 终极兜底：滑块可见期间每次鼠标移动都强制重定位。
        // 折叠/展开、滚动锚定钳制、面板布局变化等任何时序漏洞导致的位置残留，
        // 都会在下一次 mousemove 时被覆盖（osbUpdate 只读几个缓存布局值，move 频率下无性能压力）
        document.addEventListener('mousemove', function () {
            if (sbLast && sbLast._osbUpdate && sbLast._osbThumb && sbLast._osbThumb.classList.contains('sb-show')) {
                sbLast._osbUpdate('move');
            }
        }, { passive: true });
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
        // 标记/取消标记：容器加 .sb-hover，自绘滑块（挂在 body 上的 fixed 浮层）同步加 .sb-show 控制显隐；
        // 浮现时强制重定位（_osbUpdate）：折叠/展开等布局变化若发生在滑块显示期间，
        // 任何遗漏的同步路径（滚动锚定钳制等）都会在下次浮现时被纠正，滑块不再残留旧位置
        function sbMark(el, on) {
            el.classList.toggle('sb-hover', on);
            if (el._osbThumb) el._osbThumb.classList.toggle('sb-show', on);
            if (on && el._osbUpdate) el._osbUpdate('sbOn'); // 浮现时强制重定位，杜绝残留旧位置
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
                if (sh <= ch + 1 || ch === 0) {
                    thumb.style.display = 'none'; return;
                }
                var rect = el.getBoundingClientRect();
                if (rect.height === 0) {
                    thumb.style.display = 'none'; return;
                }
                thumb.style.display = 'block';
                var h = Math.max(30, Math.round(ch * ch / sh)); // 滑块最小 30px，内容越多越短
                var maxTop = ch - h - 2; // 上下各留 2px 边距
                var viewTop = 2 + Math.round(st / Math.max(1, sh - ch) * (maxTop - 2));
                thumb.style.height = h + 'px';
                thumb.style.top = Math.round(rect.top + viewTop) + 'px';
                thumb.style.left = Math.round(rect.right - 8) + 'px'; // 右侧 2px 边距（宽 6px）
            }
            // 时长制多帧复查：按墙钟时长（默认 600ms）逐帧重测。帧数制（18 帧）在高刷屏
            // （144Hz≈125ms）会提前收兵，追不完 250ms 宽度过渡等布局动画；期间位置稳定即静默收敛
            function osbTick(ms) {
                if (el._osbTicking) return;
                el._osbTicking = true;
                var t0 = Date.now(), n = 0;
                (function tick() {
                    n++;
                    osbUpdate();
                    if (Date.now() - t0 < (ms || 600) && n < 90) requestAnimationFrame(tick);
                    else el._osbTicking = false;
                })();
            }
            // 滚动同步：scroll 事件里只排 rAF，回调在"本轮渲染、绘制前"执行，与合成器滚动同帧，无滞后重影
            el.addEventListener('scroll', function () {
                if (!el._osbRaf) {
                    el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; osbUpdate(); });
                }
            }, { passive: true });
            if (window.ResizeObserver) new ResizeObserver(function () { osbUpdate(); }).observe(el); // 容器尺寸变化同步（窗口缩放/侧栏切换）
            // 折叠/展开类点击：click 后时长制复查（默认 600ms）。捕获阶段监听容器内一切点击，
            // 无论折叠由哪个处理器实现（class 切换/懒加载/子树重建），布局收敛后滑块必然归位
            el.addEventListener('click', function () { osbUpdate(); osbTick(); }, true);
            if (window.MutationObserver) new MutationObserver(function () {
                osbUpdate();
                osbTick();
            }).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
            el._osbUpdate = osbUpdate; // 暴露给显隐联动：每次滑块浮现都强制重定位（sbMark 调用），杜绝残留旧位置
            el._osbTick = osbTick;     // 暴露给过渡钩子：布局动画进行中持续跟踪（见下方 transitionrun 监听）
            (window._osbHosts = window._osbHosts || []).push(el); // 宿主登记：过渡钩子按目标节点反查所属滚动容器
            el.addEventListener('load', function () { osbUpdate(); }, true); // 捕获阶段监听内部图片加载完成（高度变化影响滚动范围）
            // textarea 编辑输入改变内容高度（行增减），MutationObserver 感知不到 value 变化，input 时同步滑块
            if (el.tagName === 'TEXTAREA') el.addEventListener('input', function () { osbUpdate(); });
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
        // ===== 横向自绘悬浮滚动条（initOsb 的水平镜像）：预览区标签栏等多标签横滚容器用 =====
        // 滑块贴容器底边（宽 6px 高度按比例），几何/拖拽/同步触发与纵向版同构；显隐复用 sbMark（el._osbThumb 指向本滑块）
        function initOsbH(el) {
            if (el._osbH) return; // 防重复初始化
            el._osbH = true;
            el._osb = true;       // 同时占住纵向版防重复标记（横滚容器无需再挂纵向滑块）
            var thumb = document.createElement('div');
            thumb.className = 'osb-thumb osb-h';
            document.body.appendChild(thumb);
            thumb._osbHost = el;
            el._osbThumb = thumb; // 悬停显隐联动（sbMark/sbScheduleHide 通用读写 _osbThumb）
            // 按横向滚动比例刷新滑块位置与长度；fixed 定位基于容器可视区实时矩形
            function osbUpdate() {
                var sw = el.scrollWidth, cw = el.clientWidth, sl = el.scrollLeft;
                if (sw <= cw + 1 || cw === 0) {
                    thumb.style.display = 'none'; return;
                }
                var rect = el.getBoundingClientRect();
                if (rect.width === 0) {
                    thumb.style.display = 'none'; return;
                }
                thumb.style.display = 'block';
                var w = Math.max(30, Math.round(cw * cw / sw)); // 滑块最小 30px，标签越多越短
                var maxLeft = cw - w - 2; // 左右各留 2px 边距
                var viewLeft = 2 + Math.round(sl / Math.max(1, sw - cw) * (maxLeft - 2));
                thumb.style.width = w + 'px';
                thumb.style.left = Math.round(rect.left + viewLeft) + 'px';
                thumb.style.top = Math.round(rect.bottom - 8) + 'px'; // 底部 2px 边距（高 6px）
            }
            // 时长制多帧复查（与纵向版同参）：标签增删/窗口缩放等布局收敛后滑块必然归位
            function osbTick(ms) {
                if (el._osbTicking) return;
                el._osbTicking = true;
                var t0 = Date.now(), n = 0;
                (function tick() {
                    n++;
                    osbUpdate();
                    if (Date.now() - t0 < (ms || 600) && n < 90) requestAnimationFrame(tick);
                    else el._osbTicking = false;
                })();
            }
            el.addEventListener('scroll', function () {
                if (!el._osbRaf) {
                    el._osbRaf = requestAnimationFrame(function () { el._osbRaf = 0; osbUpdate(); });
                }
            }, { passive: true });
            if (window.ResizeObserver) new ResizeObserver(function () { osbUpdate(); }).observe(el);
            el.addEventListener('click', function () { osbUpdate(); osbTick(); }, true);
            if (window.MutationObserver) new MutationObserver(function () {
                osbUpdate();
                osbTick();
            }).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
            el._osbUpdate = osbUpdate; // mousemove 兜底/过渡钩子通用入口
            el._osbTick = osbTick;
            (window._osbHosts = window._osbHosts || []).push(el); // 登记宿主：CSS 布局过渡时全程跟踪
            // 滑块拖拽：按下后按位移比例映射回 scrollLeft（比例与 osbUpdate 一致）
            thumb.addEventListener('mousedown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var startX = e.clientX, startLeft = el.scrollLeft;
                thumb.classList.add('osb-drag');
                function osbMove(ev) {
                    var maxLeft = el.clientWidth - thumb.offsetWidth - 2;
                    var dx = ev.clientX - startX;
                    el.scrollLeft = startLeft + dx * (el.scrollWidth - el.clientWidth) / Math.max(1, maxLeft - 2);
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
        // 阶段七十二：追加 AI 多会话列表 #ai-session-list（超过 5 条后滚动查看；
        // 面板初始带 hidden 但 DOM 常驻，启动时可直接注册，滚轮/悬停行为与其余面板一致）
        // 阶段一百零五：追加设置页规则/记忆列表 #settings-rule-list/#settings-mem-list
        // （同坑：TRAE 版设置页直管列表，DOM 静态常驻但未注册导致限高可滚却不显示滑块，2026-09-13 用户反馈）
        ['.message-list', '.conv-list', '#user-list', '#ai-agent-list', '.emoji-panel', '.search-panel', '.conv-search-results', '.new-friends-list', '.profile-content', '.kb-list', '#ua-list', '#memory-list', '#ai-session-list', '#settings-rule-list', '#settings-mem-list']
            .forEach(function (sel) {
                var el = document.querySelector(sel);
                if (el) initOsb(el);
            });
        // 阶段七十六：暴露给动态创建的滚动容器挂自绘滑块（Agent 工作区文件树/预览区/编辑 textarea）
        window._osbInit = initOsb;
        window._osbInitH = initOsbH; // 横向版：预览区多标签栏（动态创建，建栏时挂）
        // ===== 布局类 CSS 过渡钩子：列表栏折叠（#list-panel width 0.25s）等布局动画进行中，
        // 内容逐帧重排（每帧 sh 变一行高），mutation/resize 均不触发——必须在过渡全程逐帧跟踪。
        // transitionrun/start 起查，transitionend/cancel 收尾再复查一次
        var OSB_LAYOUT_PROPS = ',width,height,max-height,min-height,padding,padding-top,padding-bottom,margin,margin-top,margin-bottom,top,bottom,left,right,font-size,line-height,flex-basis,';
        function osbOnTransition(e) {
            if (OSB_LAYOUT_PROPS.indexOf(',' + e.propertyName + ',') < 0 || e.propertyName.indexOf(' ') >= 0) return;
            // 过渡元素可能不在任何滚动容器内（如列表栏折叠动画改的是聊天区宽度），
            // 布局属性过渡一律复查全部登记容器（读布局共享一次回流，成本可忽略）
            (window._osbHosts || []).forEach(function (h) { if (h._osbTick) h._osbTick(700); });
        }
        document.addEventListener('transitionrun', osbOnTransition, true);
        document.addEventListener('transitionstart', osbOnTransition, true);
        document.addEventListener('transitionend', osbOnTransition, true);
        document.addEventListener('transitioncancel', osbOnTransition, true);
    })();
})();
