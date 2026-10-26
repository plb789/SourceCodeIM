// gn-room.js - 阶段二百九十二 M8：局域网游戏跨公网联机·房间层（游戏中心窗「联机大厅」页签）
// 设计文档：docs/局域网公网联机开发文档.md（§5.2 房间层 109 / §11 客户端 UI 设计）
//
// 职责划分：
//   1. 信令面：109 上行 create/join/leave/kick/ready/start/state/list/chat 收发与下行信封
//      created/state/list/closed/chat 状态流转（GNSignal 分流入口 onSignal）
//   2. 引擎联动：建房成功即 GameNet.hostStart；加入成功即 GameNet.connect；
//      退房/被踢/关房即 hostStop/disconnect（隧道与信令同收口，防孤儿）
//   3. UI：联机大厅（对战平台布局：顶栏 + 左联机游戏列 + 中房间表格 + 右大厅聊天）
//      与房间页（成员列表/就绪/踢人/开局 + 房内聊天）
//   4. 项目 UI 规则：全部颜色走主题 CSS 变量（跟随主题色）；自绘悬浮滚动条（window._osbInit）；
//      自实现弹窗（页内自绘确认/输入/建房表单，禁系统弹窗）；禁纯白/纯黑硬编码
//
// 位置归口（M8 修正）：本模块随「联机大厅」页签整页迁入游戏中心窗（game-store.html gsViewOnline），
// 不再覆盖主窗口聊天区；109/110/111/112 经 gn-signal.js + 主进程 IPC 中继复用主窗口唯一 WS
// （不给游戏中心窗开第二条 WS：同端互踢/未读双计/双心跳风险）。

(function () {
    'use strict';

    var view = document.getElementById('gn-view');
    if (!view) return; // 页面异常裁剪：静默退出

    var MSG_ROOM = 109;                 // protocol.MsgTypeGameRoomSignal
    var MSG_INVITE = 111;               // protocol.MsgTypeGameInvite
    var MSG_LOBBY = 112;                // protocol.MsgTypeGameLobbySignal（大厅聊天/在场名单，不落库）
    var MSG_ERR = 9;                    // 通用错误帧：游戏请求的服务端拒绝（109 层无成功回执，须显式提示）
    var MODE_TUNNEL = 'tunnel';         // 一期主线：通用端口隧道（服务端收敛，客户端声明用）
    var LOBBY_PING = 20000;             // 大厅在场心跳（服务端 45s 判定离线）

    // 对战模式（一期放行 ≤6 人：1v1/2v2/3v3；4v4 及以上需 Mesh 三期承载，UI 展示但置灰）
    var MODES = [
        { k: '1v1', label: '1v1', n: 2 },
        { k: '2v2', label: '2v2', n: 4 },
        { k: '3v3', label: '3v3', n: 6 },
        { k: '4v4', label: '4v4', n: 8, need: true },
        { k: '5v5', label: '5v5', n: 10, need: true },
        { k: '8v8', label: '8v8', n: 16, need: true },
        { k: '16v16', label: '16v16', n: 32, need: true },
        { k: 'ffa', label: '混战', n: 0 }   // 0 = 人数自定义（2-6）
    ];

    // 模式显示归口：'ffa' → 「混战」（列表/房间页与建房下拉口径一致），未知值原样展示
    function modeLabel(k) {
        for (var i = 0; i < MODES.length; i++) { if (MODES[i].k === k) return MODES[i].label; }
        return k;
    }

    // ===== 运行时状态 =====
    var my = null;          // 我的房间：{room_id,name,host,host_port,mode,game_mode,max_players,game_id,game_name,status,members[],isHost,ready,msgs[]}
    // 联机排障：房间层关键分支落盘主进程 gn-tunnel.log（渲染层无 console 可见的打包形态下唯一观测口）
    function gnDbg(m) {
        try { if (window.desktop && typeof window.desktop.gnDebugLog === 'function') window.desktop.gnDebugLog('[room] ' + m); } catch (e) { }
    }
    // 游戏适配类型：war3（广播代理注入）/ scr（星际重制版，mDNS 发现代理）/ null（未适配，透传反射）。
    // 独占端口游戏（war3/scr 均实测独占绑定游戏端口）加入方数据隧道都让出游戏端口，skipPort 生效
    function gnGameKind() {
        if (!my) return null;
        var n = String(my.game_name || '');
        if (/魔兽|war3|wc3/i.test(n)) return 'war3';
        if (/星际|starcraft/i.test(n)) return 'scr';
        return null;
    }
    var myName = '';        // 建房/加入时本端已知房间名（下行信封不带 name，本地留存展示）
    var rooms = [];         // 大厅房间列表（下行 list.rooms）
    var visible = false;
    var curPage = 'lobby';  // lobby / room
    var busy = { create: false, join: false, transfer: false }; // 请求在途（防重复提交；功能二期加 transfer）
    var pendingJoinId = ''; // 加入请求在途的房间号（首个 state 广播到达即确认入房）
    var busyTimer = null;   // 请求超时兜底（服务端错误走通用错误帧，无成功回执时须解锁）
    var lastListAt = 0;     // 列表节流（避免频繁切换抖动刷屏）
    // 聊天在途标记（''/'room'/'lobby'）：9 帧是全局通用错误，原先只建房/加入在途才呈现，
    // 聊天被服务端拒绝时彻底静默——实测：房间被回收后仍停在房间页发消息，输入框被清空且无任何反馈。
    // 发送成功以本人 chat/msg 回显为清标记信号（服务端广播含发送者本人）。
    var awaitingChat = '';
    var portBusy = false;   // 端口自动探测在途（防连点）
    var portProcs = [];     // 已登记游戏进程名（用于过滤本机监听端口）
    var gameFilter = 0;     // 左列选中的联机游戏 id（0=全部）
    var games = [];         // 联机游戏列表（游戏中心窗游戏库注入：{id,name}）
    var friendsCache = [];  // 好友列表（邀请选人数据源；主窗口环境取 IMContacts，游戏中心窗经 IPC 拉取）
    var lobbyUsers = [];    // 大厅在场玩家（下行 users）
    var lobbyMsgs = [];     // 大厅聊天消息（下行 msg；仅本次会话内存态，不落库）
    var roomMsgs = [];      // 房内聊天消息（下行 chat；仅本次会话内存态，不落库）
    var lobbyTimer = null;  // 大厅在场心跳
    // ===== 快速匹配状态机（纯前端事件驱动：房间列表更新即重新评估候选，命中自动加入） =====
    var MATCH_TIMEOUT = 30000;           // 匹配限时（30s 倒计时，超时未命中进失败结果页）
    var match = {
        active: false,                   // 匹配流程进行中（设置→搜索→结果 任一阶段）
        phase: '',                       // '' / 'search' / 'success' / 'fail'
        gameId: 0,                       // 匹配游戏 id（0=全部游戏）
        gameName: '',                    // 匹配游戏名（筛选摘要展示）
        statuses: { waiting: true, playing: false }, // 房间状态多选（默认仅等待中）
        deadline: 0,                     // 搜索截止时间戳 ms
        timer: null,                     // 倒计时 tick（200ms：数字 + 进度条平滑）
        tried: {},                       // 本轮已尝试且加入被拒的房间号（口令/满员变化等）→ 自动换下一间
        lastPoll: 0                      // 搜索中兜底拉列表节流（防 rooms_changed 推送丢失时卡死）
    };

    // ===== 工具 =====
    function u() {
        if (window.IMSocket && IMSocket.getUsername) return IMSocket.getUsername() || '';
        // 游戏中心窗（无 WS）：从 localStorage im_auth 解出登录名（与 game-store.js 同款编码）
        try { return (JSON.parse(decodeURIComponent(atob(localStorage.getItem('im_auth') || ''))) || {}).u || ''; } catch (e) { return ''; }
    }
    // T() 翻译归口：i18n.js 仅主窗口引入（game-store.html 不引）——游戏中心窗 window.I18N 不存在，
    // 原实现直接返回原文导致所有带 {x} 占位符的 toast 显示占位符原文（如「房间号 {id}」）。
    // 现 I18N 缺失时本地兜底做占位符替换（中文界面 i18n 也仅是透传中文，行为一致）
    function T(s, p) {
        if (window.I18N) return I18N.t(s, p);
        if (!p) return s;
        var out = String(s);
        for (var k in p) {
            if (Object.prototype.hasOwnProperty.call(p, k)) {
                out = out.split('{' + k + '}').join(String(p[k]));
            }
        }
        return out;
    }
    function avail() { return !!(window.GameNet && window.GameNet.available && window.GameNet.available()); }
    function isMobile() { return document.documentElement.classList.contains('m'); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toast(text) {
        if (typeof window.showToast === 'function') { window.showToast(text); return; }
        var el = document.getElementById('toast');
        if (!el) return;
        el.textContent = text;
        el.classList.remove('hidden');
        clearTimeout(el._gnT);
        el._gnT = setTimeout(function () { el.classList.add('hidden'); }, 2500);
    }
    // 头像：优先服务端 state.members 下发的 avatar（功能二期：游戏中心窗无主窗好友缓存，
    // chat.js 的 IMAvatarUrl 在本窗不可用）；缺失时回落 IMAvatarUrl（预留）→ 首字母占位
    function avatarHtml(username, name, avatarUrl) {
        var url = avatarUrl || ((typeof window.IMAvatarUrl === 'function') ? (window.IMAvatarUrl(username) || '') : '');
        var ch = (name || username || '?').slice(0, 1).toUpperCase();
        if (url) return '<span class="gn-avatar"><img src="' + esc(url) + '" alt=""></span>';
        return '<span class="gn-avatar gn-avatar-ch">' + esc(ch) + '</span>';
    }
    // 信令出口：统一走 GNSignal（游戏中心窗经 IPC 复用主窗口唯一 WS）
    function send(obj) {
        if (!window.GNSignal || !GNSignal.isConnected()) { toast(T('未连接，请稍后重试')); return false; }
        return GNSignal.send({ msg_type: MSG_ROOM, content: JSON.stringify(obj) });
    }
    function sendLobby(obj) {
        if (!window.GNSignal || !GNSignal.isConnected()) return false;
        return GNSignal.send({ msg_type: MSG_LOBBY, content: JSON.stringify(obj) });
    }
    function hhmm(ts) {
        var d = ts ? new Date(ts * 1000) : new Date();
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    // ===== DOM 构建（容器 #gn-view 常驻游戏中心窗 gsViewOnline，内部结构本模块一次性构建） =====
    var elRefresh, elClose, elPageLobby, elPageRoom, elName, elPort, elPortDetect, elPass, elCreateBtn, elCreateOpen, elCreateCancel, elCreateMask,
        elGsel, elGselToggle, elGselIco, elGselName, elGselCaret, elGselPanel, elGselSearch, elGselList,
        elInMode, elInMax, elGameList, elNetModeRow, elNetMode, elPortRow,
        elExePathRow, elExePath, elExePathPick, elExePathClear,
        elRoomIn, elJoinPass, elJoinBtn, elMatchBtn,
        elRoomList, elListEmpty,
        elLobbyChat, elLobbyIn, elLobbySend, elLobbyCount,
        elRoomName, elRoomMeta, elLinkBar, elMembers, elMemberCount, elRoomActions,
        elRoomChat, elRoomIn2, elRoomSend2,
        elMask, elModalTitle, elModalText, elModalIn, elModalOk, elModalCancel, elUnsupported,
        elInviteMask, elInviteList, elInviteSearch, elInviteSend, elInviteCancel,
        elPortMask, elPortList, elPortHint, elPortCancel,
        elMatchMask, elMatchStart, elMatchCancel, elMatchStatus,
        elMgsel, elMgselToggle, elMgselIco, elMgselName, elMgselPanel, elMgselSearch, elMgselList,
        elMatchRunMask, elMatchRunSearch, elMatchRunOk, elMatchRunFail,
        elMatchRunFilter, elMatchRunCount, elMatchRunBar, elMatchRunCancel, elMatchRunRoom, elMatchRunFailSub,
        elMatchRunCreate, elMatchRunRetry, elMatchRunBack;

    function buildDom() {
        view.innerHTML =
            '<div class="gn-bp">' +
            // 顶栏：标题 + 创建房间 / 快速匹配 / 刷新
            '<div class="gn-bp-top">' +
            '<span class="gn-logo"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M21.58 16.09l-1.09-7.66A3.996 3.996 0 0 0 16.53 5H7.47C5.48 5 3.79 6.46 3.51 8.43l-1.09 7.66C2.2 17.63 3.39 19 4.94 19c.68 0 1.32-.27 1.8-.75L9 15.5h6l2.25 2.75c.48.48 1.13.75 1.8.75 1.56 0 2.75-1.37 2.53-2.91zM11 11H4V9h7v2zm9-1c0 .55-.45 1-1 1s-1-.45-1-1 .45-1 1-1 1 .45 1 1zm-2-3c0 .55-.45 1-1 1s-1-.45-1-1 .45-1 1-1 1 .45 1 1z"/></svg></span>' +
            '<span class="gn-title">' + T('联机大厅') + '</span>' +
            '<span class="gn-bp-flex"></span>' +
            '<button id="gn-create-open" class="gn-btn primary">' + T('创建房间') + '</button>' +
            '<button id="gn-match-btn" class="gn-btn">' + T('快速匹配') + '</button>' +
            '<button id="gn-refresh" class="gn-tb-btn" title="' + T('刷新') + '">' +
            '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>' +
            '<span>' + T('刷新') + '</span></button>' +
            '<button id="gn-close" class="gn-tb-btn">' + T('返回') + '</button>' +
            '</div>' +
            // 大厅页：左联机游戏列 | 中房间表格 | 右大厅聊天
            '<div id="gn-page-lobby" class="gn-page gn-page-lobby">' +
            '<div class="gn-unsupported hidden" id="gn-unsupported">' + T('当前环境不支持联机（仅 PC 客户端可创建/加入房间）') + '</div>' +
            '<div class="gn-bp-cols">' +
            // 左列：联机游戏筛选
            '<div class="gn-bp-games">' +
            '<div class="gn-bp-col-title">' + T('联机游戏') + '</div>' +
            '<div class="gn-game-list gs-scroll" id="gn-game-list"></div>' +
            '</div>' +
            // 中列：房间表格 + 房间号加入
            '<div class="gn-bp-rooms">' +
            '<div class="gn-room-table-head">' +
            '<span class="gn-rt-col-name">' + T('房间名') + '</span>' +
            '<span class="gn-rt-col-game">' + T('游戏') + '</span>' +
            '<span class="gn-rt-col-mode">' + T('模式') + '</span>' +
            '<span class="gn-rt-col-slot">' + T('人数') + '</span>' +
            '<span class="gn-rt-col-host">' + T('房主') + '</span>' +
            '<span class="gn-rt-col-st">' + T('状态') + '</span>' +
            '<span class="gn-rt-col-act"></span>' +
            '</div>' +
            '<div class="gn-room-table" id="gn-room-list"></div>' +
            '<div class="gn-empty hidden" id="gn-list-empty">' + T('暂无数据') + '</div>' +
            '<div class="gn-join-row">' +
            '<input id="gn-in-room" type="text" inputmode="numeric" maxlength="6" placeholder="' + T('输入 6 位房间号加入') + '">' +
            '<input id="gn-in-join-pass" type="text" maxlength="32" placeholder="' + T('口令（选填）') + '">' +
            '<button id="gn-join-btn" class="gn-btn">' + T('加入') + '</button>' +
            '</div>' +
            '</div>' +
            // 右列：大厅聊天
            '<div class="gn-bp-chat">' +
            '<div class="gn-bp-col-title">' + T('大厅聊天') + ' <span class="gn-chat-count" id="gn-lobby-count"></span></div>' +
            '<div class="gn-chat-list" id="gn-lobby-chat"></div>' +
            '<div class="gn-chat-input">' +
            '<input id="gn-lobby-in" type="text" maxlength="200" placeholder="' + T('和在大厅的玩家聊聊…') + '">' +
            '<button id="gn-lobby-send" class="gn-btn primary tiny">' + T('发送') + '</button>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            // 房间页：左（房间信息/链路/成员/操作） | 右（房内聊天）
            '<div id="gn-page-room" class="gn-page gn-page-room hidden">' +
            '<div class="gn-room-cols">' +
            '<div class="gn-room-left">' +
            '<div class="gn-room-head">' +
            '<div class="gn-room-name" id="gn-room-name"></div>' +
            '<div class="gn-room-meta" id="gn-room-meta"></div>' +
            '</div>' +
            '<div class="gn-link-bar" id="gn-link-bar"></div>' +
            '<div class="gn-sec-title">' + T('成员') + ' <span id="gn-member-count" class="gn-member-count"></span></div>' +
            '<div class="gn-members" id="gn-members"></div>' +
            '<div class="gn-room-actions" id="gn-room-actions"></div>' +
            '</div>' +
            '<div class="gn-room-right">' +
            '<div class="gn-bp-col-title">' + T('房间聊天') + '</div>' +
            '<div class="gn-chat-list" id="gn-room-chat"></div>' +
            '<div class="gn-chat-input">' +
            '<input id="gn-room-in" type="text" maxlength="200" placeholder="' + T('和房间内的玩家聊聊…') + '">' +
            '<button id="gn-room-send" class="gn-btn primary tiny">' + T('发送') + '</button>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>' +
            // 建房弹窗（自绘表单：房名/联机游戏/对战模式/房间人数/游戏端口(自动探测)/口令）
            '<div class="gn-invite-mask hidden" id="gn-create-mask">' +
            '<div class="gn-invite-dialog gn-create-dialog">' +
            '<div class="gn-invite-title">' + T('创建房间') + '</div>' +
            '<div class="gn-create-form">' +
            '<div class="gn-form-row"><label>' + T('房间名') + '</label><input id="gn-in-name" type="text" maxlength="32" placeholder="' + T('如：我的世界生存') + '"></div>' +
            // 联机游戏自绘选择器（替代原生 select：原生无法显示游戏图标、无法搜索过滤，游戏多时下拉超长溢出）
            '<div class="gn-form-row"><label>' + T('联机游戏') + '</label><div class="gn-gsel" id="gn-gsel">' +
            '<button type="button" class="gn-gsel-toggle" id="gn-gsel-toggle"><span class="gn-gsel-ico" id="gn-gsel-ico"></span><span class="gn-gsel-name" id="gn-gsel-name"></span><span class="gn-gsel-caret" id="gn-gsel-caret"></span></button>' +
            '<div class="gn-gsel-panel hidden" id="gn-gsel-panel">' +
            '<input class="gn-gsel-search" id="gn-gsel-search" type="text" maxlength="32" placeholder="' + T('搜索游戏…') + '">' +
            '<div class="gn-gsel-list gs-scroll" id="gn-gsel-list"></div>' +
            '</div></div></div>' +
            // 联机方式行（随应用带出只读，服务端建房收敛归口；supernode=虚拟网卡 / tunnel=端口隧道 / 空=跟随全局）
            '<div class="gn-form-row" id="gn-in-netmode-row" style="display:none;"><label>' + T('联机方式') + '</label><span class="gn-tag" id="gn-in-netmode"></span></div>' +
            // 启动路径行（仅「不指定（虚拟网卡）」显示：本机游戏 exe，开局时自动启动；localStorage 各机自记忆）
            '<div class="gn-form-row" id="gn-in-exepath-row" style="display:none;"><label>' + T('启动路径') + '</label><span class="gn-exepath" id="gn-in-exepath"></span><button id="gn-exepath-pick" class="gn-link">' + T('浏览…') + '</button><button id="gn-exepath-clear" class="gn-link">' + T('清空') + '</button></div>' +
            '<div class="gn-form-row"><label>' + T('对战模式') + '</label><select id="gn-in-mode"></select></div>' +
            '<div class="gn-form-row"><label>' + T('房间人数') + '</label><select id="gn-in-max"></select></div>' +
            '<div class="gn-form-row" id="gn-in-port-row"><label>' + T('游戏端口') + '</label><input id="gn-in-port" type="text" inputmode="numeric" maxlength="5" placeholder="' + T('游戏局域网端口（1024-65535）') + '"><button id="gn-port-detect" class="gn-link">' + T('自动探测') + '</button></div>' +
            '<div class="gn-form-row"><label>' + T('房间口令') + '</label><input id="gn-in-pass" type="text" maxlength="32" placeholder="' + T('选填，留空则好友可直接加入') + '"></div>' +
            '</div>' +
            '<div class="gn-hint" id="gn-create-hint">' + T('创建后把房间号发给好友，对方在「加入房间」输入即可联机') + '</div>' +
            '<div class="gn-invite-actions">' +
            '<button class="gn-btn" id="gn-create-cancel">' + T('取消') + '</button>' +
            '<button class="gn-btn primary" id="gn-create-btn">' + T('创建房间') + '</button>' +
            '</div></div></div>' +
            // 邀请好友弹窗（微信同款选人：搜索 + 好友多选；自绘浮层）
            '<div class="gn-invite-mask hidden" id="gn-invite-mask">' +
            '<div class="gn-invite-dialog">' +
            '<div class="gn-invite-title">' + T('邀请好友联机') + '</div>' +
            '<input class="gn-invite-search" id="gn-invite-search" type="text" maxlength="32" placeholder="' + T('搜索好友') + '">' +
            '<div class="gn-invite-list" id="gn-invite-list"></div>' +
            '<div class="gn-invite-actions">' +
            '<button class="gn-btn" id="gn-invite-cancel">' + T('取消') + '</button>' +
            '<button class="gn-btn primary" id="gn-invite-send" disabled>' + T('发送邀请') + '</button>' +
            '</div></div></div>' +
            // 端口自动探测候选浮层（设计文档 §4.3 第 1 层；自绘浮层，列出本机监听端口 + 进程名供房主点选）
            '<div class="gn-invite-mask hidden" id="gn-port-mask">' +
            '<div class="gn-invite-dialog gn-port-dialog">' +
            '<div class="gn-invite-title">' + T('选择游戏端口') + '</div>' +
            '<div class="gn-port-hint" id="gn-port-hint"></div>' +
            '<div class="gn-invite-list" id="gn-port-list"></div>' +
            '<div class="gn-invite-actions">' +
            '<button class="gn-btn" id="gn-port-cancel">' + T('取消') + '</button>' +
            '</div></div></div>' +
            // 快速匹配设置弹窗（自绘：联机游戏选择 + 房间状态多选；复用 .gn-invite-* / .gn-gsel-* 骨架）
            '<div class="gn-invite-mask hidden" id="gn-match-mask">' +
            '<div class="gn-invite-dialog gn-match-dialog">' +
            '<div class="gn-invite-title">' + T('快速匹配') + '</div>' +
            '<div class="gn-match-form">' +
            '<div class="gn-form-row"><label>' + T('联机游戏') + '</label><div class="gn-gsel" id="gn-mgsel">' +
            '<button type="button" class="gn-gsel-toggle" id="gn-mgsel-toggle"><span class="gn-gsel-ico" id="gn-mgsel-ico"></span><span class="gn-gsel-name" id="gn-mgsel-name"></span><span class="gn-gsel-caret" id="gn-mgsel-caret"></span></button>' +
            '<div class="gn-gsel-panel hidden" id="gn-mgsel-panel">' +
            '<input class="gn-gsel-search" id="gn-mgsel-search" type="text" maxlength="32" placeholder="' + T('搜索游戏…') + '">' +
            '<div class="gn-gsel-list gs-scroll" id="gn-mgsel-list"></div>' +
            '</div></div></div>' +
            '<div class="gn-form-row"><label>' + T('房间状态') + '</label><div class="gn-match-status" id="gn-match-status">' +
            '<button type="button" class="gn-match-st sel" data-v="waiting">' + T('等待中') + '</button>' +
            '<button type="button" class="gn-match-st" data-v="playing">' + T('游戏中') + '</button>' +
            '</div></div>' +
            '</div>' +
            '<div class="gn-hint">' + T('在 30 秒内自动寻找符合条件且有空位的房间并加入') + '</div>' +
            '<div class="gn-invite-actions">' +
            '<button class="gn-btn" id="gn-match-cancel">' + T('取消') + '</button>' +
            '<button class="gn-btn primary" id="gn-match-start">' + T('开始匹配') + '</button>' +
            '</div></div></div>' +
            // 快速匹配进行/结果浮层（三态同壳切换：搜索中含雷达动画 + 30s 倒计时；成功/失败为结果页）
            '<div class="gn-invite-mask hidden" id="gn-matchrun-mask">' +
            '<div class="gn-matchrun-dialog">' +
            '<div class="gn-matchrun-stage" id="gn-matchrun-search">' +
            '<div class="gn-match-radar"><span class="gn-match-radar-ring"></span><span class="gn-match-radar-ring d2"></span><span class="gn-match-radar-sweep"></span><span class="gn-match-radar-core"></span></div>' +
            '<div class="gn-matchrun-title">' + T('正在匹配房间…') + '</div>' +
            '<div class="gn-matchrun-sub" id="gn-matchrun-filter"></div>' +
            '<div class="gn-matchrun-count" id="gn-matchrun-count">30</div>' +
            '<div class="gn-matchrun-bar"><i id="gn-matchrun-bar"></i></div>' +
            '<div class="gn-matchrun-actions"><button class="gn-btn" id="gn-matchrun-cancel">' + T('取消匹配') + '</button></div>' +
            '</div>' +
            '<div class="gn-matchrun-stage hidden" id="gn-matchrun-ok">' +
            '<div class="gn-match-res ok">✓</div>' +
            '<div class="gn-matchrun-title">' + T('匹配成功') + '</div>' +
            '<div class="gn-matchrun-room" id="gn-matchrun-room"></div>' +
            '<div class="gn-matchrun-sub">' + T('正在进入房间…') + '</div>' +
            '</div>' +
            '<div class="gn-matchrun-stage hidden" id="gn-matchrun-fail">' +
            '<div class="gn-match-res fail">✕</div>' +
            '<div class="gn-matchrun-title">' + T('未找到匹配房间') + '</div>' +
            '<div class="gn-matchrun-sub" id="gn-matchrun-failsub"></div>' +
            '<div class="gn-matchrun-actions">' +
            '<button class="gn-btn" id="gn-matchrun-create">' + T('创建房间') + '</button>' +
            '<button class="gn-btn" id="gn-matchrun-retry">' + T('重新匹配') + '</button>' +
            '<button class="gn-btn primary" id="gn-matchrun-back">' + T('返回') + '</button>' +
            '</div></div>' +
            '</div></div>' +
            // 自实现弹窗（确认/口令输入；禁系统弹窗）
            '<div class="gn-modal-mask hidden" id="gn-mask">' +
            '<div class="gn-modal">' +
            '<div class="gn-modal-title" id="gn-modal-title"></div>' +
            '<div class="gn-modal-text" id="gn-modal-text"></div>' +
            '<input class="gn-modal-in hidden" id="gn-modal-in" type="text" maxlength="32">' +
            '<div class="gn-modal-actions">' +
            '<button class="gn-btn" id="gn-modal-cancel">' + T('取消') + '</button>' +
            '<button class="gn-btn primary" id="gn-modal-ok">' + T('确定') + '</button>' +
            '</div></div></div>';

        var g = function (id) { return document.getElementById(id); };
        elRefresh = g('gn-refresh'); elClose = g('gn-close');
        elPageLobby = g('gn-page-lobby'); elPageRoom = g('gn-page-room');
        elUnsupported = g('gn-unsupported');
        elCreateOpen = g('gn-create-open'); elCreateMask = g('gn-create-mask');
        elName = g('gn-in-name'); elPort = g('gn-in-port'); elPass = g('gn-in-pass');
        elGsel = g('gn-gsel'); elGselToggle = g('gn-gsel-toggle'); elGselIco = g('gn-gsel-ico'); elGselName = g('gn-gsel-name');
        elGselCaret = g('gn-gsel-caret'); elGselPanel = g('gn-gsel-panel'); elGselSearch = g('gn-gsel-search'); elGselList = g('gn-gsel-list');
        elInMode = g('gn-in-mode'); elInMax = g('gn-in-max');
        elNetModeRow = g('gn-in-netmode-row'); elNetMode = g('gn-in-netmode');
        elPortRow = g('gn-in-port-row');
        elExePathRow = g('gn-in-exepath-row'); elExePath = g('gn-in-exepath');
        elExePathPick = g('gn-exepath-pick'); elExePathClear = g('gn-exepath-clear');
        elGameList = g('gn-game-list');
        elCreateBtn = g('gn-create-btn'); elCreateCancel = g('gn-create-cancel');
        elRoomIn = g('gn-in-room'); elJoinPass = g('gn-in-join-pass'); elJoinBtn = g('gn-join-btn');
        elMatchBtn = g('gn-match-btn');
        elRoomList = g('gn-room-list'); elListEmpty = g('gn-list-empty');
        elLobbyChat = g('gn-lobby-chat'); elLobbyIn = g('gn-lobby-in'); elLobbySend = g('gn-lobby-send'); elLobbyCount = g('gn-lobby-count');
        elRoomName = g('gn-room-name'); elRoomMeta = g('gn-room-meta');
        elLinkBar = g('gn-link-bar'); elMembers = g('gn-members'); elMemberCount = g('gn-member-count');
        elRoomActions = g('gn-room-actions');
        elRoomChat = g('gn-room-chat'); elRoomIn2 = g('gn-room-in'); elRoomSend2 = g('gn-room-send');
        elMask = g('gn-mask'); elModalTitle = g('gn-modal-title'); elModalText = g('gn-modal-text');
        elModalIn = g('gn-modal-in'); elModalOk = g('gn-modal-ok'); elModalCancel = g('gn-modal-cancel');
        elInviteMask = g('gn-invite-mask'); elInviteList = g('gn-invite-list');
        elInviteSearch = g('gn-invite-search'); elInviteSend = g('gn-invite-send'); elInviteCancel = g('gn-invite-cancel');
        elPortDetect = g('gn-port-detect'); elPortMask = g('gn-port-mask');
        elPortList = g('gn-port-list'); elPortHint = g('gn-port-hint'); elPortCancel = g('gn-port-cancel');
        // 快速匹配（设置弹窗 + 进行/结果浮层）
        elMatchMask = g('gn-match-mask'); elMatchStart = g('gn-match-start'); elMatchCancel = g('gn-match-cancel');
        elMgsel = g('gn-mgsel'); elMgselToggle = g('gn-mgsel-toggle'); elMgselIco = g('gn-mgsel-ico'); elMgselName = g('gn-mgsel-name');
        elMgselPanel = g('gn-mgsel-panel'); elMgselSearch = g('gn-mgsel-search'); elMgselList = g('gn-mgsel-list');
        elMatchStatus = g('gn-match-status');
        elMatchRunMask = g('gn-matchrun-mask');
        elMatchRunSearch = g('gn-matchrun-search'); elMatchRunOk = g('gn-matchrun-ok'); elMatchRunFail = g('gn-matchrun-fail');
        elMatchRunFilter = g('gn-matchrun-filter'); elMatchRunCount = g('gn-matchrun-count'); elMatchRunBar = g('gn-matchrun-bar');
        elMatchRunCancel = g('gn-matchrun-cancel'); elMatchRunRoom = g('gn-matchrun-room'); elMatchRunFailSub = g('gn-matchrun-failsub');
        elMatchRunCreate = g('gn-matchrun-create'); elMatchRunRetry = g('gn-matchrun-retry'); elMatchRunBack = g('gn-matchrun-back');

        buildModeOptions();
        // 自绘悬浮滚动条（原生条已全局禁用）：房间表格 + 成员区 + 大厅聊天 + 房内聊天 + 游戏列 + 选人/端口候选列表
        if (window._osbInit) {
            window._osbInit(elRoomList); window._osbInit(elMembers); window._osbInit(elLobbyChat);
            window._osbInit(elRoomChat); window._osbInit(elGameList);
            window._osbInit(elInviteList); window._osbInit(elPortList);
            window._osbInit(elGselList); // 联机游戏选择器列表（.gs-scroll 悬停浮现滑块，与大厅游戏列同模式）
            window._osbInit(elMgselList); // 快速匹配游戏选择器列表（同上）
        }
        bindEvents();
    }

    // 模式下拉：4v4 及以上展示但置灰（一期 ≤6 人，Mesh 三期承载）
    function buildModeOptions() {
        elInMode.innerHTML = '';
        MODES.forEach(function (m) {
            var o = document.createElement('option');
            o.value = m.k;
            o.textContent = m.need ? (m.label + '（' + T('需 Mesh（三期）') + '）') : m.label;
            if (m.need) o.disabled = true;
            elInMode.appendChild(o);
        });
        elInMode.value = '1v1';
        syncMaxOptions();
    }
    function modeOf(k) {
        for (var i = 0; i < MODES.length; i++) { if (MODES[i].k === k) return MODES[i]; }
        return MODES[0];
    }
    // 人数下拉：由模式决定（混战可自选 2-6；一期上限为服务端 max_members）
    function syncMaxOptions() {
        var m = modeOf(elInMode.value);
        var cap = maxMembers();
        elInMax.innerHTML = '';
        if (m.n > 0) {
            var o = document.createElement('option');
            o.value = String(m.n); o.textContent = m.n + ' ' + T('人'); elInMax.appendChild(o);
            elInMax.disabled = true;
        } else {
            for (var i = 2; i <= cap; i++) {
                var o2 = document.createElement('option');
                o2.value = String(i); o2.textContent = i + ' ' + T('人'); elInMax.appendChild(o2);
            }
            elInMax.value = String(Math.min(4, cap));
            elInMax.disabled = false;
        }
    }
    // 房间人数上限（服务端 game_net.max_members 归口；兜底 6）
    function maxMembers() {
        var n = (window.GameNet && GameNet.maxMembers) ? GameNet.maxMembers() : 0;
        return n > 0 ? n : 6;
    }

    // ===== 自实现弹窗（确认 / 口令输入；同一时刻仅一个，遮罩点击不关闭防误触） =====
    var modalCb = null;
    function showModal(opts) {
        elModalTitle.textContent = opts.title || T('提示');
        elModalText.textContent = opts.text || '';
        elModalText.classList.toggle('hidden', !opts.text);
        if (opts.input) {
            elModalIn.classList.remove('hidden');
            elModalIn.value = opts.value || '';
            elModalIn.placeholder = opts.placeholder || '';
        } else {
            elModalIn.classList.add('hidden');
            elModalIn.value = '';
        }
        elModalOk.textContent = opts.okText || T('确定');
        elModalCancel.classList.toggle('hidden', !!opts.single);
        modalCb = opts.onOk || null;
        elMask.classList.remove('hidden');
        if (opts.input) setTimeout(function () { try { elModalIn.focus(); } catch (e) { } }, 30);
    }
    function closeModal() {
        elMask.classList.add('hidden');
        modalCb = null;
        elModalIn.value = '';
    }
    function confirmBox(title, text, okText, fn) {
        showModal({ title: title, text: text, okText: okText, onOk: fn });
    }

    // ===== 页面切换 / 开关 =====
    function showPage(name) {
        curPage = name;
        elPageLobby.classList.toggle('hidden', name !== 'lobby');
        elPageRoom.classList.toggle('hidden', name !== 'room');
        if (name === 'lobby') {
            // 修复：从房间页返回大厅必须重新进入 112 在场集合——原实现 lobbyEnter 仅在面板 open 时
            // 调用一次，而心跳 tick 检测到 curPage!=='lobby' 即 lobbyLeave 退出集合；此后他人建房/
            // 解散的 rooms_changed 全部收不到（服务端只向在场集合广播），列表必须手动刷新才更新
            lobbyEnter();
            renderLobby(); renderGameList(); renderRoomList(); renderLobbyChat(); refreshList(true);
        }
        else { renderRoom(); renderRoomChat(); }
    }
    function open(payload) {
        // 桥接入口可能携带预填（邀请卡片 → {room_id}；游戏详情 → {name,port,procs}）
        if (payload && typeof payload === 'object') {
            if (payload.name) elName.value = String(payload.name).slice(0, 32);
            if (payload.port) elPort.value = String(payload.port).replace(/[^0-9]/g, '').slice(0, 5);
            if (payload.room_id) elRoomIn.value = String(payload.room_id).replace(/[^0-9]/g, '').slice(0, 6);
            if (Array.isArray(payload.procs)) portProcs = payload.procs.slice(0, 64);
        }
        visible = true;
        view.classList.remove('hidden');
        showPage(my ? 'room' : 'lobby');
        lobbyEnter();
        loadFriends();
    }
    function close() {
        visible = false;
        closeModal();
        createClose();
        inviteClose();   // 邀请选人弹窗随面板一同收口，避免残留浮层
        portClose();     // 端口候选浮层同理
        matchAbort();    // 快速匹配浮层/状态随面板一同收口（重进大厅重新发起）
        view.classList.add('hidden');
        lobbyLeave();
    }
    function isOpen() { return visible; }

    // ===== 大厅在场（112 心跳：open 进入 / close 退出 / 20s 续期；不落库） =====
    function lobbyEnter() {
        sendLobby({ action: 'enter' });
        if (lobbyTimer) clearInterval(lobbyTimer);
        lobbyTimer = setInterval(function () {
            if (!visible || curPage !== 'lobby') { lobbyLeave(); return; }
            sendLobby({ action: 'ping' });
        }, LOBBY_PING);
    }
    function lobbyLeave() {
        if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
        sendLobby({ action: 'leave' });
        lobbyUsers = [];
        lobbyMsgs = [];
    }

    // ===== 列表拉取（节流） =====
    function refreshList(force) {
        if (!avail() || !window.GNSignal || !GNSignal.isConnected()) return;
        var now = Date.now();
        if (!force && now - lastListAt < 1200) return;
        lastListAt = now;
        send({ action: 'list' });
    }

    // ===== 请求在途锁（服务端错误走通用错误帧、无成功回执，须超时兜底解锁） =====
    function lockBusy(kind) { busy[kind] = true; armBusy(); }
    function armBusy() {
        if (busyTimer) clearTimeout(busyTimer);
        busyTimer = setTimeout(function () {
            busyTimer = null;
            // 快速匹配加入在途超时兜底：无法确认结果，标记 tried 防倒计时 tick 反复撞同一间
            if (busy.join && pendingJoinId) matchTried(pendingJoinId);
            busy.create = false; busy.join = false; busy.transfer = false; pendingJoinId = '';
            renderLobby();
            if (curPage === 'room' && my) renderRoom(); // 移交在途超时：复位后重绘成员行（按钮恢复可用）
        }, 6000);
    }
    function unlockBusy() {
        if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
        busy.create = false; busy.join = false; busy.transfer = false; pendingJoinId = '';
        // 忙标志复位必须同步重绘（与 armBusy 超时分支同口径）：created/state 成功路径原先只清标志不重绘，
        // 实测导致建房成功后「创建房间」提交按钮永久置灰（文案停在「创建中…」），再点无任何反应。
        renderLobby();
    }

    // ===== 渲染：大厅 =====
    function renderLobby() {
        elUnsupported.classList.toggle('hidden', avail());
        elCreateOpen.disabled = !avail();
        elMatchBtn.disabled = !avail() || busy.join;
        elJoinBtn.disabled = !avail() || busy.join;
        elJoinBtn.textContent = busy.join ? T('加入中…') : T('加入');
        elCreateBtn.disabled = !avail() || busy.create;
        elCreateBtn.textContent = busy.create ? T('创建中…') : T('创建房间');
    }
    // 无封面图标占位：主题色底按游戏名散列色相 + 首字母（与游戏中心卡片 .gs-cover-ph 同款口径）
    function iconPh(name) {
        var h = 0, s = String(name || '?');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        var b = document.createElement('b');
        b.textContent = s.charAt(0).toUpperCase();
        return { hue: h % 360, node: b };
    }
    function fillGameIcon(box, name) {
        var ph = iconPh(name);
        box.style.filter = 'hue-rotate(' + ph.hue + 'deg)';
        box.innerHTML = '';
        box.appendChild(ph.node);
    }
    // 左列：联机游戏（游戏中心窗游戏库注入；0=全部）——图标取游戏封面，无封面走主题色首字母占位
    function renderGameList() {
        // 每次渲染同步游戏库：此前 games 仅在「创建房间」弹窗打开时填充（renderGameOptions），
        // 导致进入大厅时左列常只有「全部游戏」，须先开一次建房弹窗才出现游戏项（图标随之为空）
        if (typeof window.GSOnlineGames === 'function') games = window.GSOnlineGames() || [];
        var list = [{ id: 0, name: T('全部游戏') }].concat(games);
        elGameList.innerHTML = '';
        list.forEach(function (g_) {
            var row = document.createElement('div');
            row.className = 'gn-game-row' + (gameFilter === g_.id ? ' active' : '');
            var ic = document.createElement('span');
            ic.className = 'gn-game-icon';
            if (g_.cover) {
                var im = document.createElement('img');
                im.src = g_.cover;
                im.alt = '';
                im.draggable = false;
                im.onerror = function () { fillGameIcon(ic, g_.name); }; // 加载失败回退占位（不留破图）
                ic.appendChild(im);
            } else {
                fillGameIcon(ic, g_.name);
            }
            var nm = document.createElement('span');
            nm.className = 'gn-game-name';
            nm.textContent = g_.name;
            row.appendChild(ic);
            row.appendChild(nm);
            row.addEventListener('click', function () { gameFilter = g_.id; renderGameList(); renderRoomList(); });
            elGameList.appendChild(row);
        });
        // 无游戏库数据时的兜底提示（不阻断房间表格展示）
        if (!games.length) {
            var tip = document.createElement('div');
            tip.className = 'gn-game-empty';
            tip.textContent = T('游戏库为空');
            elGameList.appendChild(tip);
        }
    }
    function visibleRooms() {
        if (!gameFilter) return rooms || [];
        return (rooms || []).filter(function (r) { return Number(r.game_id || 0) === gameFilter; });
    }
    // 中列：房间表格
    function renderRoomList() {
        var list = visibleRooms();
        elRoomList.innerHTML = '';
        if (!list.length) {
            elListEmpty.classList.remove('hidden');
            elListEmpty.textContent = T('暂无数据');
            return;
        }
        elListEmpty.classList.add('hidden');
        list.forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'gn-room-row';
            var st = r.status === 'playing' ? T('游戏中') : T('等待中');
            var mp = Number(r.max_players || 0);
            var slot = (r.count || 0) + (mp ? '/' + mp : '');
            row.innerHTML =
                '<span class="gn-rt-col-name"><span class="gn-room-title">' + esc(r.name || (T('房间') + ' ' + r.room_id)) + '</span>' +
                '<span class="gn-room-sub">' + T('房间号') + ' ' + esc(r.room_id) + '</span></span>' +
                '<span class="gn-rt-col-game">' + esc(r.game_name || '—') + '</span>' +
                '<span class="gn-rt-col-mode">' + esc(r.game_mode ? modeLabel(r.game_mode) : '—') + '</span>' +
                '<span class="gn-rt-col-slot">' + esc(slot) + '</span>' +
                '<span class="gn-rt-col-host">' + esc(r.host_name || r.host) + '</span>' +
                '<span class="gn-rt-col-st">' + esc(st) + '</span>' +
                '<span class="gn-rt-col-act"><button class="gn-btn tiny gn-join-one">' + T('加入') + '</button></span>';
            row.querySelector('.gn-join-one').addEventListener('click', function () {
                joinRoom(r.room_id, '', r.name);
            });
            elRoomList.appendChild(row);
        });
    }
    // 右列：大厅聊天 + 在场名单
    function renderLobbyChat() {
        elLobbyCount.textContent = lobbyUsers.length ? ('· ' + lobbyUsers.length + ' ' + T('人在线')) : '';
        elLobbyChat.innerHTML = '';
        if (!lobbyMsgs.length) {
            var tip = document.createElement('div');
            tip.className = 'gn-chat-empty';
            tip.textContent = T('暂无消息');
            elLobbyChat.appendChild(tip);
            return;
        }
        lobbyMsgs.forEach(function (m) {
            elLobbyChat.appendChild(chatRowEl(m, false));
        });
        elLobbyChat.scrollTop = elLobbyChat.scrollHeight;
    }
    // 聊天行（微信式：他人左对齐黑白气泡 / 自己右对齐主题色气泡；系统行居中）
    function chatRowEl(m, mine) {
        var row = document.createElement('div');
        if (m.sys) {
            row.className = 'gn-chat-sys';
            row.textContent = m.text;
            return row;
        }
        row.className = 'gn-chat-row' + (mine ? ' mine' : '');
        row.innerHTML = avatarHtml(m.from, m.name) +
            '<span class="gn-chat-main"><span class="gn-chat-meta">' + esc(m.name || m.from) + ' · ' + esc(hhmm(m.ts)) + '</span>' +
            '<span class="gn-chat-text">' + esc(m.text) + '</span></span>';
        return row;
    }

    // ===== 渲染：房间页 =====
    function incoming() { return '<span class="gn-tag ing">' + T('连接中') + '</span>'; }
    function renderRoom() {
        if (!my) { showPage('lobby'); return; }
        elRoomName.textContent = my.name || (T('房间') + ' ' + my.room_id);
        // 联机方式徽标（服务端房间 mode 归口：supernode=虚拟网卡组网 / tunnel=端口隧道 / 其他=跟随全局）
        var nmLabel = my.mode === 'supernode' ? T('虚拟网卡') : (my.mode === 'tunnel' ? T('端口隧道') : T('跟随全局'));
        elRoomMeta.innerHTML =
            '<span class="gn-meta-item">' + T('房间号') + ' <b>' + esc(my.room_id) + '</b></span>' +
            '<span class="gn-meta-item">' + T('联机方式') + ' <b>' + esc(nmLabel) + '</b></span>' +
            (my.mode !== 'supernode' ? '<span class="gn-meta-item">' + T('游戏端口') + ' <b>' + esc(my.host_port || '-') + '</b></span>' : '') +
            (my.game_name ? '<span class="gn-meta-item">' + T('游戏') + ' <b>' + esc(my.game_name) + '</b></span>' : '') +
            (my.game_mode ? '<span class="gn-meta-item">' + T('模式') + ' <b>' + esc(modeLabel(my.game_mode)) + '</b></span>' : '') +
            '<span class="gn-meta-item">' + (my.status === 'playing' ? T('游戏中') : T('等待中')) + '</span>' +
            (my.isHost ? '<span class="gn-meta-item gn-badge-host">' + T('我是房主') + '</span>' : '');
        renderMembers();
        renderActions();
        renderLinkBar();
    }
    function renderMembers() {
        var st = (window.GameNet && GameNet.stateOf) ? GameNet.stateOf(my.room_id) : null;
        var peerMap = {};
        if (st && st.role === 'host' && st.peers) {
            st.peers.forEach(function (p) { peerMap[p.peer] = p; });
        }
        elMembers.innerHTML = '';
        elMemberCount.textContent = '(' + (my.members ? my.members.length : 0) + (my.max_players ? '/' + my.max_players : '') + ')';
        (my.members || []).forEach(function (m) {
            var row = document.createElement('div');
            row.className = 'gn-member-row';
            // 准备态徽标：已开局（status=playing）后准备语义失效，统一显示「游戏中」，与房间 meta
            // （游戏中/等待中）及房主按钮（游戏进行中）同口径——原实现只看 m.ready，开局后成员行仍挂
            // 「未准备」，出现"游戏都已开始却提示未准备"的自相矛盾。
            // 房主不参与准备（服务端仅校验除房主外成员就绪），未开局时房主行不再挂「未准备」以免误导。
            var ready;
            if (my.status === 'playing') {
                ready = '<span class="gn-tag ink">' + T('游戏中') + '</span>';
            } else if (m.host) {
                ready = '';
            } else {
                ready = m.ready ? '<span class="gn-tag ink">' + T('已准备') + '</span>' : '<span class="gn-tag wait">' + T('未准备') + '</span>';
            }
            // 联机链路：房主视角按对端映射；加入者视角只有自己一条链路（在链路条展示）。
            // 「不指定（虚拟网卡）」房（supernode 且无隧道端口）：无 GameNet 会话——成员链接列
            // 统一显示「虚拟网卡」徽标（组网由 p2p-host 承担），避免永久挂"连接中"误导
            var link = '';
            var vnicOnly = my.mode === 'supernode' && !my.host_port;
            if (vnicOnly) {
                link = '<span class="gn-tag ink">' + T('虚拟网卡') + '</span>';
            } else if (my.isHost && !m.host && peerMap[m.username]) {
                var ps = peerMap[m.username].state;
                link = (ps === 'linked' && peerMap[m.username].tunnel) ? '<span class="gn-tag ink">' + T('已联通') + '</span>'
                    : (ps === 'failed' || ps === 'aborted') ? '<span class="gn-tag off">' + T('未联接') + '</span>' : incoming();
            } else if (!my.isHost && !m.host && m.username === u()) {
                link = my._selfLinkCls === 'on' ? '<span class="gn-tag ink">' + T('已联通') + '</span>'
                    : my._selfLinkCls === 'off' ? '<span class="gn-tag off">' + T('未联接') + '</span>' : incoming();
            } else if (m.host) {
                link = my.isHost ? '<span class="gn-tag ink">' + T('本机') + '</span>' : '<span class="gn-tag off">' + T('房主') + '</span>';
            }
            row.innerHTML =
                avatarHtml(m.username, m.name || m.username, m.avatar) +
                '<span class="gn-member-main"><span class="gn-member-name">' + esc(m.name || m.username) + '</span>' +
                '<span class="gn-member-sub">' + esc(m.username) + '</span></span>' +
                '<span class="gn-member-tags">' + (m.host ? '<span class="gn-tag host">' + T('房主') + '</span>' : '') + ready + link + '</span>';
            // 房主操作（除自己/房主外）：移交房主 + 移出（功能二期）
            if (my.isHost && !m.host) {
                var tr = document.createElement('button');
                tr.className = 'gn-btn tiny';
                tr.textContent = T('移交');
                tr.disabled = !!busy.transfer;
                tr.addEventListener('click', function () { transferMember(m.username, m.name || m.username); });
                row.appendChild(tr);
                var kick = document.createElement('button');
                kick.className = 'gn-btn tiny danger';
                kick.textContent = T('移出');
                kick.addEventListener('click', function () { kickMember(m.username, m.name || m.username); });
                row.appendChild(kick);
            }
            elMembers.appendChild(row);
        });
    }
    function renderLinkBar() {
        if (!my) return;
        var st = (window.GameNet && GameNet.stateOf) ? GameNet.stateOf(my.room_id) : null;
        var txt = '', cls = '';
        if (!avail()) { txt = T('当前环境不支持联机'); cls = 'off'; }
        else if (my.mode === 'supernode' && !my.host_port) {
            // 「不指定（虚拟网卡）」房：无隧道会话，链接栏显示组网态而非"等待玩家加入/尚未建立联机"
            if (my.status === 'playing') { txt = T('虚拟网卡组网中，游戏局域网列表互见'); cls = 'on'; }
            else { txt = T('虚拟网卡联机，开局后自动组网'); cls = 'wait'; }
        }
        else if (my.isHost) {
            var n = (st && st.peers) ? st.peers.length : 0;
            txt = n ? T('已连接 {n} 位玩家', { n: n }) : T('等待玩家加入…');
            cls = n ? 'on' : 'wait';
        } else if (!st) { txt = T('尚未建立联机'); cls = 'wait'; }
        else {
            txt = my._selfLinkText || T('正在连接房主…');
            cls = my._selfLinkCls || 'wait';
        }
        elLinkBar.className = 'gn-link-bar ' + cls;
        elLinkBar.textContent = txt;
    }
    function renderActions() {
        elRoomActions.innerHTML = '';
        if (!my) return;
        var startPending = !!my._startPending && my.status !== 'playing';
        // 功能二期：游戏已启动但等待用户在游戏内创建房间（War3 等游戏建主后才监听端口）——
        // 主按钮禁用显示等待态，旁挂「跳过等待直接开局」兜底（按登记端口开局）
        var waitingHost = !!my._waitingHost && my.status !== 'playing';
        if (my.isHost) {
            var canStart = (my.members || []).every(function (m) { return m.host || m.ready || m.online === false; });
            var btn = document.createElement('button');
            btn.className = 'gn-btn primary';
            // 按钮四态：开始游戏(waiting) / 开局中(启动游戏在途) / 等待游戏内建主(已启动) / 游戏进行中(playing)
            btn.textContent = startPending ? T('开局中…')
                : waitingHost ? T('等待游戏内创建房间…')
                : (my.status === 'playing' ? T('游戏进行中') : T('开始游戏'));
            btn.disabled = my.status === 'playing' || startPending || waitingHost || !canStart;
            btn.addEventListener('click', function () { if (!my) return; doStart(btn); });
            elRoomActions.appendChild(btn);
            if (waitingHost) {
                var skip = document.createElement('button');
                skip.className = 'gn-btn';
                skip.textContent = T('跳过等待直接开局');
                skip.addEventListener('click', function () {
                    if (!my) return;
                    my._waitingHost = false;
                    send({ action: 'start', room_id: my.room_id, host_port: my.host_port || 0 }); // 按登记端口开局
                });
                elRoomActions.appendChild(skip);
            }
            // 功能二期：playing 态提供「结束对局」——回到等待中（成员保留），按钮回「开始游戏」可再开局
            if (my.status === 'playing') {
                var eb = document.createElement('button');
                eb.className = 'gn-btn danger';
                eb.textContent = T('结束游戏');
                eb.addEventListener('click', function () {
                    if (!my) return;
                    confirmBox(T('结束游戏'), T('结束本局对局？房间保留，成员重新准备后可再次开局。'), T('结束'), function () {
                        send({ action: 'end', room_id: my.room_id });
                    });
                });
                elRoomActions.appendChild(eb);
            }
        } else {
            var rb = document.createElement('button');
            rb.className = 'gn-btn' + (my.ready ? '' : ' primary');
            rb.textContent = my.ready ? T('取消准备') : T('准备');
            rb.addEventListener('click', function () {
                if (!my) return;
                // 中途加入主入口：对局中点准备 = 明确加入意图——拉起虚拟网卡组网（幂等静默，已运行不重复提示）
                // + 一次性启动引导（与开局过渡同口径）；waiting 态点准备为纯就绪信号，无附加动作
                if (my.status === 'playing' && my.mode === 'supernode' && !my.isHost) {
                    gnP2pStart(true);
                    gnJoinerLaunchAsk();
                }
                send({ action: 'ready', room_id: my.room_id });
            });
            elRoomActions.appendChild(rb);
        }
        // 邀请好友（房内成员均可邀请；走聊天邀请卡片 111，服务端校验邀请人须为房内成员）
        var iv = document.createElement('button');
        iv.className = 'gn-btn';
        iv.textContent = T('邀请好友');
        iv.addEventListener('click', function () { if (!my) return; inviteOpen(); });
        elRoomActions.appendChild(iv);
        var lv = document.createElement('button');
        lv.className = 'gn-btn danger';
        lv.textContent = my.isHost ? T('解散房间') : T('退出房间');
        lv.addEventListener('click', function () {
            if (!my) return;   // 关房/被踢后房间页可能残留旧按钮，防空引用
            confirmBox(my.isHost ? T('解散房间') : T('退出房间'),
                my.isHost ? T('解散后全部成员将被移出房间，确定吗？') : T('确定退出当前房间吗？'),
                T('确定'), function () { doLeave(); });
        });
        elRoomActions.appendChild(lv);
    }
    // 右列：房内聊天（仅成员可见，服务端只广播不落库）
    function renderRoomChat() {
        elRoomChat.innerHTML = '';
        if (!roomMsgs.length) {
            var tip = document.createElement('div');
            tip.className = 'gn-chat-empty';
            tip.textContent = T('暂无消息');
            elRoomChat.appendChild(tip);
            return;
        }
        roomMsgs.forEach(function (m) {
            elRoomChat.appendChild(chatRowEl(m, m.from === u()));
        });
        elRoomChat.scrollTop = elRoomChat.scrollHeight;
    }

    // ===== 服务端错误帧（9）：仅在本端游戏请求在途时呈现 =====
    // 109 层请求成功走 109 回包、失败走通用 9 错误帧（无成功回执故不可靠"等回包"判定），
    // 只认"有请求在途（建房/加入/聊天）"的 9，避免把主窗口其他模块的错误帧误当联机错误；
    // 此前 9 未中继到游戏中心窗——建房被拒（如"你已加入的房间过多"）完全静默，实测已修正。
    function onErr(msg) {
        var kind = awaitingChat;
        awaitingChat = '';
        var text = (msg && msg.content) ? String(msg.content) : T('操作失败，请重试');
        // 功能二期：重连沿房间重同步被拒（房间不存在或已解散 / 你不在该房间中）——幽灵房间就地收口：
        // 断线期间房间被解散本端收不到 closed，重连后停在旧成员列表且后续操作错误全被静默，此处统一恢复
        if (my && my._resyncPending) {
            my._resyncPending = false;
            toast(text);
            teardownLocal('closed');
            if (visible) showPage('lobby');
            refreshList(true);
            return;
        }
        // 功能二期：开局被服务端拒绝（成员未就绪等）——toast 错误 + 恢复「开局中…」按钮（否则永久卡死）
        if (my && my._startPending) {
            my._startPending = false;
            toast(text);
            if (curPage === 'room') renderRoom();
        }
        if (!busy.create && !busy.join && !busy.transfer && !kind) return;
        var joinTried = busy.join ? pendingJoinId : ''; // 匹配加入被拒：先截获房间号（unlockBusy 会清空）
        unlockBusy();
        toast(text);
        // 快速匹配中自动加入被拒（口令错误/瞬间满员等）：标记不再撞同一间，立即换下一候选继续匹配
        if (joinTried) matchTried(joinTried);
        // 房内聊天被服务端拒绝（房间已解散 / 本端已不在成员表）→ 本端房间态已失效：
        // 就地收口回大厅并刷新列表，避免停在幽灵房间页反复空转（房间 TTL 到期/异常清理后即会命中）
        if (kind === 'room' && my) {
            teardownLocal('closed');
            showPage('lobby');
        } else if (curPage === 'room' && my) {
            renderRoom(); // 移交失败等房内操作被拒：复位后重绘成员行（移交按钮恢复可用）
        }
        refreshList(true);
    }

    // ===== 动作 =====
    function openCreate() {
        if (!avail()) { toast(T('当前环境不支持联机')); return; }
        renderGameOptions();
        gnSyncRoomName(); // 房间名默认值：随当前所选游戏带出（用户可直接创建免输入）
        syncMaxOptions();
        elCreateMask.classList.remove('hidden');
        setTimeout(function () { try { elName.focus(); } catch (e) { } }, 30);
    }
    function createClose() { elCreateMask.classList.add('hidden'); gnGselOpen(false); }
    // 联机游戏自绘选择器（替代原生 select：原生无法显示游戏图标、无法搜索过滤，游戏多时下拉超长溢出屏幕）。
    // 数据源：游戏中心窗游戏库注入（window.GSOnlineGames，已入库可联机游戏，cover 为归一化封面 URL）
    var gnGameItems = [];   // 全量选项 [{val,name,cover}]（两个「不指定」置顶 + 已安装游戏）
    var gnGameValCur = '0'; // 当前选中值（'0'=虚拟网卡 / '0-tunnel'=通用端口隧道 / 数字字符串=游戏 id）
    function gnGameVal() { return gnGameValCur; }
    // 当前选中项完整数据（{val,name,cover,exe,local}）；本地游戏开局启动直接取 exe
    function gnGameSelItem() {
        for (var i = 0; i < gnGameItems.length; i++) { if (gnGameItems[i].val === gnGameValCur) return gnGameItems[i]; }
        return null;
    }
    // 房间名默认生成（用户免输入）：游戏房=「{游戏名}的房间」，不指定=「{用户名}的房间」。
    // 仅当输入框为空或仍是上次自动生成值时刷新——用户手改过的名字不覆盖
    var gnNameAuto = ''; // 上次自动生成的房间名
    function gnDefaultRoomName() {
        var it = gnGameSelItem();
        if (it && it.val !== '0' && it.val !== '0-tunnel' && it.name) return it.name + T('的房间'); // 商店/本地游戏房
        var un = u();
        return (un ? un : T('我的')) + T('的房间'); // 「不指定」两类：用户名的房间（无登录名兜底）
    }
    function gnSyncRoomName() {
        var d = gnDefaultRoomName();
        var cur = (elName.value || '').trim();
        if (!cur || cur === gnNameAuto) { elName.value = d; gnNameAuto = d; }
    }
    function renderGameOptions() {
        // 上次选中记忆（本机 localStorage）：窗体重开/页面刷新后带出上次所选（下方自愈仍校验有效性）
        try { var savedVal = localStorage.getItem('gn_gsel_val'); if (savedVal) gnGameValCur = savedVal; } catch (e) { }
        games = (typeof window.GSOnlineGames === 'function') ? (window.GSOnlineGames() || []) : [];
        gnGameItems = [
            { val: '0', name: T('不指定（虚拟网卡）'), cover: '' },
            { val: '0-tunnel', name: T('不指定（通用端口隧道）'), cover: '' }
        ];
        games.forEach(function (g_) { gnGameItems.push({ val: String(g_.id), name: g_.name, cover: g_.cover || '' }); });
        // 本地游戏（游戏库「添加本地游戏」入库，local_ 前缀 id，仅本机）：可选参与联机，
        // 选中后等同「不指定（虚拟网卡）」（服务端无此应用配置，显式声明 supernode），开局直接用其 exe 启动
        var locals = (typeof window.GSLocalGames === 'function') ? (window.GSLocalGames() || []) : [];
        locals.forEach(function (l_) { gnGameItems.push({ val: l_.id, name: l_.name, cover: l_.icon || '', exe: l_.exe, local: true }); });
        // 选中值失效自愈（游戏卸载/库刷新后 id 不存在）：回落默认「不指定（虚拟网卡）」。
        // 仅在库数据已到达（games 非空）时才判定缺失——刚进大厅库接口未返回的间隙 games 为空，
        // 此时保留选中（多为仍有效的上次选择），防"每次打开建房弹窗都被清回虚拟网卡"
        var still = gnGameItems.some(function (it) { return it.val === gnGameValCur; });
        if (!still && games.length) gnGameValCur = '0';
        gnGselSyncToggle();
        gnGselOpen(false);
        gnGselRender();
        gnSyncNetMode();
    }
    // 收起态同步（图标 + 名称，原位更新防闪烁）
    function gnGselSyncToggle() {
        var it = null;
        for (var i = 0; i < gnGameItems.length; i++) { if (gnGameItems[i].val === gnGameValCur) { it = gnGameItems[i]; break; } }
        var name = it ? it.name : T('不指定（虚拟网卡）');
        if (elGselName.textContent !== name) elGselName.textContent = name;
        gnGselRenderIco(elGselIco, it ? it.cover : '', name);
    }
    // 图标渲染：有封面用封面（src 变化才重设，防闪烁）；无封面显示名称首字占位（商店卡片同风格）
    function gnGselRenderIco(box, cover, name) {
        if (cover) {
            var img = box.querySelector('img');
            if (!img) { box.innerHTML = '<img alt="">'; img = box.querySelector('img'); }
            if (img.getAttribute('src') !== cover) img.setAttribute('src', cover);
            img.onerror = function () { img.onerror = null; gnGselPlaceholder(box, name || ''); };
        } else {
            gnGselPlaceholder(box, name || '');
        }
    }
    function gnGselPlaceholder(box, name) {
        var ch = (name || '·').trim().charAt(0).toUpperCase() || '·';
        ch = ch.replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
        if (box.textContent !== ch) box.innerHTML = '<span class="gn-gsel-ph">' + ch + '</span>';
    }
    // 面板列表渲染（搜索过滤：名称包含关键词忽略大小写；选中项打勾高亮；零游戏给提示行）
    function gnGselRender() {
        var kw = (elGselSearch.value || '').trim().toLowerCase();
        elGselList.innerHTML = '';
        var shown = gnGameItems.filter(function (it) {
            if (!kw) return true;
            return String(it.name || '').toLowerCase().indexOf(kw) >= 0;
        });
        if (!shown.length) {
            var empty = document.createElement('div');
            empty.className = 'gn-gsel-empty';
            empty.textContent = T('无匹配游戏');
            elGselList.appendChild(empty);
        } else {
            shown.forEach(function (it) {
                var row = document.createElement('div');
                row.className = 'gn-gsel-item' + (it.val === gnGameValCur ? ' sel' : '');
                row.setAttribute('data-val', it.val);
                var ico = document.createElement('span');
                ico.className = 'gn-gsel-ico';
                row.appendChild(ico);
                gnGselRenderIco(ico, it.cover, it.name);
                var nm = document.createElement('span');
                nm.className = 'gn-gsel-nm';
                nm.textContent = it.name;
                row.appendChild(nm);
                if (it.local) {
                    // 本地游戏徽标：与商店游戏区分（无服务端配置/云存档，联机走虚拟网卡）
                    var tg = document.createElement('span');
                    tg.className = 'gn-gsel-tag';
                    tg.textContent = T('本地');
                    row.appendChild(tg);
                }
                if (it.val === gnGameValCur) {
                    var ck = document.createElement('span');
                    ck.className = 'gn-gsel-ck';
                    ck.textContent = '✓';
                    row.appendChild(ck);
                }
                elGselList.appendChild(row);
            });
        }
        if (!games.length) {
            // 游戏库零已安装：提示行（不可选）——房主无从知晓开局不会启动游戏
            var hint = document.createElement('div');
            hint.className = 'gn-gsel-hint';
            hint.textContent = T('（游戏库暂无已安装游戏，可先到游戏中心安装）');
            elGselList.appendChild(hint);
        }
        if (window._osbTick) window._osbTick(elGselList); // 滑块重定位（内容重建后滚动范围变化）
    }
    function gnGselSelect(val) {
        if (gnGameValCur !== val) {
            gnGameValCur = val;
            gnGselSyncToggle();
            // 选中即同步列表 ✓ 位置（此前仅在开面板/搜索时渲染——重开面板 ✓ 停留在旧项，
            // 视觉上"明明选了游戏、再展开却在虚拟网卡上"）
            gnGselRender();
            gnSyncRoomName(); // 房间名默认值随所选游戏刷新（用户手改过则保留）
            gnSyncNetMode(); // 选中变化：联机方式/端口行/启动路径行随应用带出刷新（原 select change 同语义）
            // 功能二期保留：选联机游戏后自动探测该游戏进程监听端口（游戏已在跑则直接预填）；
            // 「不指定」两类（虚拟网卡/通用端口隧道）无游戏进程可探测，不触发（避免全端口误推荐）
            if (val !== '0' && val !== '0-tunnel' && gnNetModeSel() !== 'supernode') portDetect(false);
            try { localStorage.setItem('gn_gsel_val', val); } catch (e) { } // 选中记忆（本机）：窗体重开/刷新后带出
        }
        gnGselOpen(false);
    }
    // 面板开合（开后清空搜索词并聚焦，便于直接输入过滤；点外部/Esc 关闭）
    function gnGselOpen(open) {
        if (!elGselPanel) return;
        var willOpen = (open === undefined) ? elGselPanel.classList.contains('hidden') : !!open;
        if (willOpen) {
            if (elGselSearch.value) { elGselSearch.value = ''; gnGselRender(); }
            elGselPanel.classList.remove('hidden');
            elGsel.classList.add('open');
            setTimeout(function () { try { elGselSearch.focus(); } catch (e) { } }, 30);
            if (window._osbTick) window._osbTick(elGselList, 200); // 开面板多帧复查滑块位置（图片加载布局收敛）
        } else {
            elGselPanel.classList.add('hidden');
            elGsel.classList.remove('open');
            if (window._osbTick) window._osbTick(elGselList); // 关面板即隐滑块（列表不可滚，防残留浮层）
        }
    }
    // 联机方式随应用带出（只读，服务端建房收敛归口——联机方式路由设计 §五）：
    // supernode=虚拟网卡（隐藏端口行，虚拟网无需端口）/ tunnel=端口隧道 / 空=跟随全局。
    // 数据源 GSGameMeta().netMode（应用上架配置随库数据下发），缺省优雅降级"跟随全局"
    var gnTapInstalled = false; // TAP 驱动安装态缓存（supernode 应用建房前置校验；gnSyncNetMode 异步刷新）
    function gnNetModeSel() {
        // 「不指定（虚拟网卡）」（game_id=0）：无应用配置可跟随，客户端显式声明 supernode
        // （服务端建房收敛据此前置校验，不满足直接拒绝建房而非降级）
        if (gnGameVal() === '0') return 'supernode';
        // 「不指定（通用端口隧道）」：同样无应用配置，跟随全局走老隧道链路（端口行显示，需填端口）
        if (gnGameVal() === '0-tunnel') return '';
        // 本地游戏（local_ 前缀，仅本机库）：服务端无应用配置，等同「不指定（虚拟网卡）」声明 supernode
        if (gnGameVal().indexOf('local_') === 0) return 'supernode';
        var gm = window.GSGameMeta ? window.GSGameMeta(gnGameVal()) : null;
        return (gm && gm.netMode) || '';
    }
    function gnSyncNetMode() {
        var nm = gnNetModeSel();
        var label = nm === 'supernode' ? T('虚拟网卡') : (nm === 'tunnel' ? T('端口隧道') : T('跟随全局'));
        elNetMode.textContent = label;
        elNetModeRow.style.display = nm ? '' : 'none';
        // 虚拟网卡方式隐藏端口行（UI 层面无端口概念），但**内部预填登记主端口**——
        // 服务端前置不满足自动降级隧道时，房间仍有可用端口（防 host_port=0 断链）
        elPortRow.style.display = nm === 'supernode' ? 'none' : '';
        if (nm === 'supernode') {
            var gm = (gnGameVal() !== '0' && window.GSGameMeta) ? window.GSGameMeta(gnGameVal()) : null;
            var reg = (gm && gm.portsTCP && gm.portsTCP.length) ? gm.portsTCP : (gm && gm.portsUDP ? gm.portsUDP : []);
            if (reg.length && !elPort.value.trim()) elPort.value = String(reg[0]);
        }
        // supernode 前置状态异步刷新（TAP 驱动安装态；未装时徽标附引导，doCreate 亦拦截）
        if (nm === 'supernode' && window.desktop && typeof window.desktop.tapGet === 'function') {
            window.desktop.tapGet().then(function (st) {
                gnTapInstalled = !!(st && st.installed);
                if (!gnTapInstalled) {
                    elNetMode.textContent = label + T('（TAP 驱动未安装，请到 设置 → 网络 启用）');
                }
            }).catch(function () { });
        } else {
            gnTapInstalled = false;
        }
        // 启动路径行：仅「不指定（虚拟网卡）」显示（应用房走游戏库启动链，无需本机路径）
        var noApp = gnGameVal() === '0';
        elExePathRow.style.display = noApp ? '' : 'none';
        if (noApp) gnSyncExePath();
    }
    // 本机游戏启动路径记忆（localStorage 各机各自记忆，不下发房主、不同步服务端）
    function gnLocalGamePath() {
        try { return localStorage.getItem('gn_local_game_path') || ''; } catch (e) { return ''; }
    }
    function gnSyncExePath() {
        var p = gnLocalGamePath();
        elExePath.textContent = p || T('（可选）未设置，开局时将询问选择');
        elExePathClear.style.display = p ? '' : 'none';
    }
    function doCreate() {
        if (busy.create) return;
        if (!avail()) { toast(T('当前环境不支持联机')); return; }
        // 已在房间中不再发起建房：服务端 max_per_user 必然拒绝（且房间 TTL 内不会释放），
        // 本地直接回到自己的房间页并说明，避免一次无意义的往返与"点了没反应"的观感
        if (my && my.room_id) {
            createClose();
            showPage('room');
            toast(T('你已在房间中，请先退出房间再创建'));
            return;
        }
        var name = (elName.value || '').trim();
        var port = parseInt((elPort.value || '').trim(), 10);
        var pass = (elPass.value || '').trim();
        var m = modeOf(elInMode.value);
        var maxN = parseInt(elInMax.value || '', 10);
        var gid = parseInt(gnGameVal() || '0', 10) || 0;
        var gname = '';
        if (gid) { games.forEach(function (x) { if (x.id === gid) gname = x.name; }); }
        else {
            // 本地游戏房（game_id=0）：房间名带出本地游戏名（仅作展示，加入方仍按本机路径启动）
            var lit = gnGameSelItem();
            if (lit && lit.local) gname = lit.name;
        }
        // 免输入兜底：清空未填时静默用默认名（必非空）——置于路由校验之前，保证任何方式下名字都被回填
        if (!name) { name = gnDefaultRoomName(); elName.value = name; gnNameAuto = name; }
        // 联机方式路由（客户端侧前置引导，服务端建房收敛仍有兜底）：
        // supernode 应用：TAP 未装 → 引导设置页；虚拟 IP 未分配 → 提示服务端池未启用/耗尽
        var gmNet = gnNetModeSel();
        if (gmNet === 'supernode') {
            if (!gnTapInstalled) { toast(T('虚拟网卡联机需先启用虚拟网卡驱动，请到 设置 → 网络 启用')); return; }
            // vip_ip 存主窗口 localStorage（socket.js 登录响应写入，跨窗口共享；sessionStorage 按窗隔离读不到）
            var vipIp = '';
            try { vipIp = localStorage.getItem('vip_ip') || ''; } catch (eVip) { }
            if (!vipIp) { toast(T('虚拟 IP 未分配（服务端虚拟 IP 池未启用或已耗尽）')); return; }
        }
        // 端口校验与 payload：supernode 方式 UI 隐藏端口行但内部已预填登记主端口——
        // 服务端前置满足走虚拟网卡（不消费端口）、前置不满足自动降级隧道时端口仍可用（防断链）
        if (gmNet !== 'supernode' && (!isFinite(port) || port < 1024 || port > 65535)) { toast(T('游戏端口需为 1024-65535')); return; }
        if (!isFinite(maxN) || maxN < 2) { toast(T('房间人数至少 2 人')); return; }
        myName = name;
        lockBusy('create'); renderLobby();
        var payload = {
            action: 'create', name: name, pass: pass, host_port: port, mode: MODE_TUNNEL, group_id: 0,
            game_mode: m.k, max_players: maxN, game_id: gid, game_name: gname
        };
        if (!gid && gmNet === 'supernode') {
            // 仅「不指定（虚拟网卡）」显式声明 supernode（服务端前置校验不满足直接拒绝建房）；
            // 虚拟网卡无端口概念，host_port 置 0（隧道端口链不参与）。
            // 「不指定（通用端口隧道）」不声明：走老隧道链路（host_port 取端口输入，服务端默认 tunnel）
            payload.net_mode = 'supernode';
            payload.host_port = 0;
        }
        var ok = send(payload);
        if (ok) createClose();
        else { unlockBusy(); renderLobby(); }
    }
    // ===== 房主游戏端口自动探测（设计文档 §4.3 第 1 层）=====
    // 主进程枚举本机监听端口（netstat -ano + tasklist）→ 本面板自绘浮层供房主点选；
    // 命中唯一候选直接填入；零候选/探测失败/环境不支持一律回落手动输入（输入框始终可用）。
    function portPick(p) {
        elPort.value = String(p).replace(/[^0-9]/g, '').slice(0, 5);
        elPortMask.classList.add('hidden');
    }
    function portRenderList(list, filtered) {
        elPortHint.textContent = filtered
            ? T('以下是已登记游戏进程正在监听的端口，请选择游戏实际使用的那个')
            : T('以下是本机正在监听的端口，请选择游戏实际使用的那个');
        elPortList.innerHTML = '';
        for (var i = 0; i < list.length; i++) {
            var row = document.createElement('div');
            row.className = 'gn-invite-item gn-port-item';
            var tags = (list[i].protos || []).join('/').toUpperCase();
            var num = document.createElement('span');
            num.className = 'gn-port-num';
            num.textContent = String(list[i].port);
            var proc = document.createElement('span');
            proc.className = 'gn-port-proc';
            proc.textContent = list[i].proc || T('未知进程');
            var tag = document.createElement('span');
            tag.className = 'gn-tag';
            tag.textContent = tags;
            row.appendChild(num); row.appendChild(proc); row.appendChild(tag);
            row.addEventListener('click', (function (p) {
                return function () { portPick(p); };
            })(list[i].port));
            elPortList.appendChild(row);
        }
        elPortMask.classList.remove('hidden');
        if (window._osbInit) window._osbInit(elPortList); // 内容变更后重挂悬浮滑块（幂等）
    }
    // manual=true：手动点「自动探测」——游戏进程命中优先，零命中回落全量候选（由房主自行辨认）；
    // manual=false：选联机游戏自动触发——仅按该游戏进程过滤，零命中不弹窗（全量无关端口只添乱）：
    // 端口由登记端口预填兜底，唯一直接填入，多命中只列该游戏自己的端口
    function portDetect(manual) {
        if (portBusy) return;
        if (!avail()) { toast(T('当前环境不支持联机')); return; }
        var api = window.desktop;
        if (!api || typeof api.gnDetectPort !== 'function') { toast(T('当前环境不支持自动探测，请手动填写端口')); return; }
        // 功能二期：游戏登记端口先预填（游戏未启动时探测不到监听端口——登记端口即答案，不空转）；
        // 随后运行时探测实测合并：探测命中已填端口不重复处理（同端口只记一次），新端口提示追加
        var gm = (gnGameVal() !== '0' && window.GSGameMeta) ? window.GSGameMeta(gnGameVal()) : null;
        var reg = (gm && gm.portsTCP && gm.portsTCP.length) ? gm.portsTCP
            : (gm && gm.portsUDP ? gm.portsUDP : []);
        if (reg.length && !elPort.value.trim()) {
            elPort.value = String(reg[0]);
            if (reg.length > 1) toast(T('已按登记填入主端口 {p}（该游戏联机端口：{all}）', { p: reg[0], all: reg.join(' / ') }));
        }
        // 探测名单：手动=所选游戏进程优先+已登记进程名兜底（游戏中心窗比启动注册表更准）；
        // 自动=仅所选游戏进程（精准命中，绝不回落全量）
        var procs = [];
        if (gm && gm.proc) procs.push(gm.proc);
        if (manual) portProcs.forEach(function (p) { if (procs.indexOf(p) === -1) procs.push(p); });
        if (!manual && !(gm && gm.proc)) {
            // 自动触发但所选游戏无进程可过滤（未安装/未登记主程序）：无从精准探测，不弹全量端口窗
            toast(T('未登记该游戏进程，无法自动探测，请手动填写端口'));
            return;
        }
        portBusy = true;
        elPortDetect.textContent = T('探测中…');
        api.gnDetectPort({ procs: procs.slice(0, 64) }).then(function (r) {
            portBusy = false;
            elPortDetect.textContent = T('自动探测');
            var list = (r && r.ok && r.list) || [];
            if (!manual) {
                // 自动探测只认游戏进程命中：零命中（游戏未运行）不弹全量端口窗，提示启动游戏后再试
                if (!r || !r.ok || !r.filtered || !list.length) {
                    var it = gnGameSelItem();
                    toast(T('未检测到《{g}》进程监听的端口，可启动游戏后再点「自动探测」或手动填写', { g: (it && it.name) || '' }));
                    return;
                }
                if (list.length === 1) {
                    portPick(list[0].port);
                    toast(T('已填入端口 {p}', { p: list[0].port }));
                    return;
                }
                portRenderList(list, true);
                return;
            }
            if (!list.length) { toast(T('未探测到本机监听端口，请手动填写')); return; }
            if (list.length === 1) {
                portPick(list[0].port);
                toast(T('已填入端口 {p}', { p: list[0].port }));
                return;
            }
            portRenderList(list, !!(r && r.filtered));
        }, function () {
            portBusy = false;
            elPortDetect.textContent = T('自动探测');
            toast(T('探测失败，请手动填写端口'));
        });
    }
    function portClose() { elPortMask.classList.add('hidden'); }

    // ===== 功能二期：房主开始游戏联动（启动真实游戏 → 等待游戏内建主 → 探测监听端口 → 开局） =====
    // 关联游戏库游戏（game_id>0）时：游戏未运行则先启动（复用游戏库 launchGame，含云存档同步），
    // 随后进入「等待游戏内创建房间」态——War3 等 LAN 游戏在游戏内建主后才监听端口，探测循环
    // 持续轮询（不限时，跟随房间生命周期）命中即自动开局；「跳过等待直接开局」按钮按登记端口兜底。
    function doStart(btn) {
        if (!my || my.status === 'playing') return;
        var gid = my.game_id || 0;
        var sendStart = function (port) {
            if (!my) return;
            var payload = { action: 'start', room_id: my.room_id };
            if (port) payload.host_port = port;
            // 开局在途标志：按钮转「开局中…」；服务端拒绝走 onErr 恢复，无响应 6s 超时兜底恢复
            my._startPending = true;
            if (!send(payload)) {
                my._startPending = false;
                if (btn) { btn.disabled = false; btn.textContent = T('开始游戏'); }
            } else if (btn) {
                setTimeout(function () {
                    if (my && my._startPending && my.status !== 'playing') {
                        my._startPending = false;
                        renderRoom();
                    }
                }, 6000);
            }
        };
        if (!gid) {
            // 「不指定（虚拟网卡）」房（supernode）：无端口隧道链——跳过端口确认与探测，
            // 开局即按本机记忆路径启动游戏（各机自记忆，不下发房主）；组网由 p2p-host 承担
            if (my.mode === 'supernode') {
                var launchLocal = function (path) {
                    if (path && window.desktop && typeof window.desktop.localGameLaunch === 'function') {
                        window.desktop.localGameLaunch({ id: 'gn_room', exe: path }).then(function (r) {
                            if (r && r.ok) toast(T('游戏已启动：虚拟网卡组网中，进入游戏局域网列表即可互见'));
                            else toast(T('游戏启动失败（{r}），可手动启动游戏后进入局域网列表', { r: (r && (r.error || r.err)) || '' }));
                        });
                    } else {
                        toast(T('虚拟网卡组网中，进入游戏局域网列表即可互见'));
                    }
                    sendStart(0);
                };
                // 启动路径优先级：选中本地游戏直接用其库内 exe（建房会话内选择态仍在）；
                // 否则用本机记忆路径（页面刷新后选择态丢失/普通「不指定」房均回落此链）
                var selIt = gnGameSelItem();
                var exe = (selIt && selIt.local && selIt.exe) ? selIt.exe : gnLocalGamePath();
                if (exe) { launchLocal(exe); return; }
                if (window.desktop && typeof window.desktop.gameChooseGameExe === 'function') {
                    confirmBox(T('启动游戏'),
                        T('未设置本机游戏启动路径。现在选择游戏主程序并启动？（选择后本机会记住，下次自动启动）'),
                        T('选择并启动'), function () {
                            window.desktop.gameChooseGameExe().then(function (rr) {
                                if (rr && !rr.canceled && rr.filePath) {
                                    try { localStorage.setItem('gn_local_game_path', rr.filePath); } catch (e) { }
                                    launchLocal(rr.filePath);
                                } else {
                                    toast(T('已取消选择，直接开局（可手动启动游戏）'));
                                    sendStart(0);
                                }
                            });
                        });
                    return;
                }
                // WEB 端无启动能力：直接开局，提示手动启动
                toast(T('虚拟网卡组网中，请手动启动游戏，进入游戏局域网列表即可互见'));
                sendStart(0);
                return;
            }
            // 无游戏关联：没有可执行信息，无法自动启动游戏——原实现静默按端口直接开局，
            // 实测反馈「点了开始游戏游戏没启动」（建房时下拉停在「不指定」即触发）。
            // 现明示原因由房主决定：仍可按端口直接开局（手动开游戏走通用隧道），或取消后重新建房关联游戏
            confirmBox(T('未关联游戏'),
                T('当前房间未关联游戏库游戏：无法自动启动游戏，且局域网游戏列表发现（虚拟主机广播）也不会运行，对方游戏列表将看不到本房间。确定仍按端口 {p} 直接开局吗？建议取消后解散房间，重新建房时在「联机游戏」下拉选择已安装的游戏。', { p: my.host_port || '' }),
                T('仍要开局'), function () { sendStart(0); });
            return;
        }
        var meta = (typeof window.GSGameMeta === 'function') ? window.GSGameMeta(gid) : null;
        var canLaunch = !!(meta && meta.proc && window.GSLaunchGame && window.desktop &&
            typeof window.desktop.gnDetectPort === 'function');
        if (!canLaunch) {
            // 关联了游戏但启动能力不可用（未安装/未登记主程序/WEB 端）：同样明示后回落，不静默开局
            var why = !meta ? T('游戏未安装或已不在游戏库')
                : (!meta.proc ? T('未登记游戏主程序，无法自动启动') : T('当前环境不支持自动启动游戏'));
            confirmBox(T('无法自动启动游戏'),
                T('《{g}》{w}。确定按端口 {p} 直接开局吗？（也可先手动启动游戏，端口探测命中后自动开局）', { g: my.game_name || '', w: why, p: my.host_port || '' }),
                T('仍要开局'), function () { sendStart(0); });
            return;
        }
        var tryDetect = function () {
            return window.desktop.gnDetectPort({ procs: [meta.proc] }).then(function (r) {
                var list = (r && r.ok && r.list) || [];
                // 功能二期修复：filtered=false = 按游戏进程过滤零命中（接口回落返回全量监听端口，
                // 那些是无关进程的端口——实测曾把系统 1900 端口当游戏端口直接开局而未启动游戏）。
                // 开局自动联动只认「按进程过滤命中」的结果，未命中视为游戏未运行 → 走启动流程
                return (r && r.filtered && list.length)
                    ? { port: list[0].port, list: list }
                    : { port: 0, list: [] };
            }, function () { return { port: 0, list: [] }; });
        };
        if (btn) { btn.disabled = true; btn.textContent = T('启动游戏中…'); }
        var launched = false, exePick = false;
        // 实测端口分类上报：探测结果按协议分桶，剔除已登记端口（服务端仅累加新端口，同端口只记一次）
        var report = function (list) {
            var tcp = [], udp = [];
            (list || []).forEach(function (x) {
                var known = (meta && ((meta.portsTCP || []).indexOf(x.port) !== -1 || (meta.portsUDP || []).indexOf(x.port) !== -1));
                if (known) return;
                (x.protos && x.protos.indexOf('tcp') !== -1 ? tcp : udp).push(x.port);
            });
            return { tcp: tcp, udp: udp };
        };
        var poll = function () {
            if (!my || my.status === 'playing') return; // 已开局：轮询结束（playing 由 state 驱动 UI）
            tryDetect().then(function (res) {
                if (!my || stopped()) return;
                if (res && res.port) {
                    var payload = { action: 'start', room_id: my.room_id, host_port: res.port };
                    var rep = report(res.list);
                    if (rep.tcp.length) payload.online_ports_tcp = rep.tcp;
                    if (rep.udp.length) payload.online_ports_udp = rep.udp;
                    send(payload);
                    return;
                }
                if (!launched) {
                    if (my._gameLaunched) {
                        // 本房间已启动过游戏（如结束对局后重开局）：不重复 spawn，直接进等待轮询
                        my._waitingHost = true;
                        renderRoom();
                        setTimeout(poll, 2000);
                        return;
                    }
                    launched = true;
                    my._gameLaunched = true;
                    // 启动真实游戏（结果回调驱动后续，绝不静默）：成功→切「等待游戏内创建房间」态；
                    // need_exe→等用户在弹窗中选择（选择后自动重试并继续）；其余失败→toast 原因并按原端口开局
                    window.GSLaunchGame(gid, function (ok, info) {
                        if (!my || stopped()) return;
                        if (ok) {
                            // 游戏已启动：War3 等 LAN 游戏需用户在游戏内「局域网游戏」建主后才监听端口——
                            // 引导 + 持续探测（不限时），建主完成自动开局；「跳过等待直接开局」按钮兜底
                            my._waitingHost = true;
                            toast(T('游戏已启动：请进入游戏「局域网游戏」创建房间，创建后将自动开局'));
                            renderRoom();
                            setTimeout(poll, 2000);
                            return;
                        }
                        my._gameLaunched = false; // 启动失败：下次点开始可重试启动
                        if (info === 'need_exe') { exePick = true; toast(T('请在弹窗中选择游戏主程序，选择后将自动继续开局')); setTimeout(poll, 2000); return; }
                        if (info === 'canceled') { toast(T('已取消选择，按房间端口 {p} 开局', { p: my.host_port || '' })); sendStart(0); return; }
                        toast(T('游戏启动失败（{r}），按房间端口 {p} 开局', { r: info || '', p: my.host_port || '' }));
                        sendStart(0);
                    });
                    return;
                }
                if (exePick) { setTimeout(poll, 2000); return; } // 用户选 exe 中：持续等待（选择后自动续跑）
                setTimeout(poll, 2000); // 持续等待游戏内建主（探测命中即自动开局；跳过按钮兜底）
            });
        };
        var stopped = function () { return !my || !my.room_id; }; // 房间失效（解散/退出/被踢）即停
        poll();
    }

    function joinRoom(roomId, pass, roomName, fromMatch) {
        if (busy.join) return;
        if (!avail()) { toast(T('当前环境不支持联机')); return; }
        roomId = String(roomId || '').replace(/[^0-9]/g, '');
        if (!/^[0-9]{6}$/.test(roomId)) { toast(T('房间号需为 6 位数字')); return; }
        if (!fromMatch) matchAbort(); // 手动加入/邀请加入：终止进行中的匹配（匹配自动加入不受影响）
        myName = roomName || '';
        pendingJoinId = roomId;
        lockBusy('join'); renderLobby();
        if (!send({ action: 'join', room_id: roomId, pass: pass || '' })) {
            unlockBusy(); renderLobby();
            if (fromMatch) matchTried(roomId); // 发送失败（断连等）：标记跳过，倒计时 tick 自动换下一候选
        }
    }
    function doJoin() {
        var rid = (elRoomIn.value || '').replace(/[^0-9]/g, '');
        if (!/^[0-9]{6}$/.test(rid)) { toast(T('房间号需为 6 位数字')); return; }
        joinRoom(rid, (elJoinPass.value || '').trim(), '');
    }
    // ===== 快速匹配（设置弹窗 → 搜索中(30s 倒计时) → 成功/失败结果页；全程自绘浮层） =====
    // 点击入口：匹配未启动 → 设置弹窗；已在匹配 → 复位到当前阶段浮层（防重复点开设置）
    function doMatch() {
        if (!avail()) { toast(T('当前环境不支持联机')); return; }
        if (my) { toast(T('已在房间中，请先退出房间再匹配')); return; }
        if (match.active) { matchRunShow(); return; }
        matchOpen();
    }
    // —— 设置弹窗 ——
    function matchOpen() {
        // 游戏选择器：选项=全部游戏 + 已入库联机游戏（本地游戏无服务端房间，不参与匹配）；
        // 默认带出左列当前游戏筛选，改选不影响左列
        if (typeof window.GSOnlineGames === 'function') games = window.GSOnlineGames() || [];
        mGselItems = [{ val: '0', name: T('全部游戏'), cover: '' }];
        games.forEach(function (g_) { mGselItems.push({ val: String(g_.id), name: g_.name, cover: g_.cover || '' }); });
        var cur = String(match.gameId || gameFilter || 0);
        if (!mGselItems.some(function (it) { return it.val === cur; })) cur = '0';
        mGselValCur = cur;
        mGselSyncToggle();
        mGselRender(); // 重建选择器列表（与建房 renderGameOptions 收口一致：防首次展开列表为空）
        mGselOpen(false);
        elMatchMask.classList.remove('hidden');
    }
    function matchClose() {
        elMatchMask.classList.add('hidden');
        mGselOpen(false);
    }
    // 开始匹配：读取设置 → 进搜索浮层
    function matchStart() {
        var sts = {};
        var rows = elMatchStatus.querySelectorAll('.gn-match-st.sel');
        for (var i = 0; i < rows.length; i++) sts[rows[i].getAttribute('data-v')] = true;
        if (!Object.keys(sts).length) { toast(T('请至少选择一种房间状态')); return; }
        var it = null;
        for (var j = 0; j < mGselItems.length; j++) { if (mGselItems[j].val === mGselValCur) { it = mGselItems[j]; break; } }
        match.gameId = Number(mGselValCur || 0) || 0;
        match.gameName = (it && it.name) || T('全部游戏');
        match.statuses = sts;
        matchClose();
        matchRunStart();
    }
    // —— 搜索中 ——
    function matchRunStart() {
        match.active = true;
        match.phase = 'search';
        match.tried = {};
        match.deadline = Date.now() + MATCH_TIMEOUT;
        matchRunShow();
        elMatchRunFilter.textContent = T('{game} · {sts}', { game: match.gameName, sts: matchStsLabel() });
        elMatchRunCount.textContent = String(MATCH_TIMEOUT / 1000); // 立即重置数字（防重试时残留上轮旧值至下个 tick）
        elMatchRunBar.style.width = '100%';
        matchEval(); // 列表现存候选立即命中（不必等下一次推送）
        if (match.timer) clearInterval(match.timer);
        match.timer = setInterval(matchTick, 200);
    }
    function matchStsLabel() {
        var arr = [];
        if (match.statuses.waiting) arr.push(T('等待中'));
        if (match.statuses.playing) arr.push(T('游戏中'));
        return arr.join('/') || T('等待中');
    }
    // 搜索浮层三态切换（search/ok/fail 同壳换内容，原位 display 切换无闪烁）
    function matchRunShow() {
        elMatchRunSearch.classList.toggle('hidden', match.phase !== 'search');
        elMatchRunOk.classList.toggle('hidden', match.phase !== 'success');
        elMatchRunFail.classList.toggle('hidden', match.phase !== 'fail');
        elMatchRunMask.classList.remove('hidden');
    }
    // 倒计时 tick：数字 + 进度条 + 超时收口；搜索中兜底拉列表（防 rooms_changed 推送丢失）
    function matchTick() {
        if (!match.active || match.phase !== 'search') return;
        var left = match.deadline - Date.now();
        if (left <= 0) { matchFail(); return; }
        elMatchRunCount.textContent = String(Math.ceil(left / 1000));
        elMatchRunBar.style.width = Math.max(0, Math.min(100, left / MATCH_TIMEOUT * 100)) + '%';
        if (Date.now() - match.lastPoll > 5000) { match.lastPoll = Date.now(); refreshList(true); }
        matchEval();
    }
    // 候选评估：按 游戏 + 状态 + 有空位 过滤（排除本轮加入被拒的房间），优先人多（更快开局）→ 自动加入
    function matchEval() {
        if (!match.active || match.phase !== 'search' || busy.join) return;
        var cand = (rooms || []).filter(function (r) {
            if (match.tried[r.room_id]) return false;
            if (match.gameId && Number(r.game_id || 0) !== match.gameId) return false;
            if (!match.statuses[r.status || 'waiting']) return false;
            var mp = Number(r.max_players || 0);
            return !mp || (r.count || 0) < mp;
        });
        if (!cand.length) return;
        cand.sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
        joinRoom(cand[0].room_id, '', cand[0].name, true);
    }
    // 加入被拒（口令错误/瞬间满员等）：标记本轮不再撞同一间，立即换下一候选（onErr 调用）
    function matchTried(roomId) {
        if (!match.active || match.phase !== 'search' || !roomId) return;
        match.tried[roomId] = true;
        matchEval();
    }
    // 匹配成功（join-confirm 收口调用）：成功结果页，短暂展示后随房间页自动收口
    function matchSucceed() {
        if (!match.active) return;
        matchStopTimer();
        match.phase = 'success';
        elMatchRunRoom.innerHTML =
            '<div class="gn-matchrun-row"><span>' + T('房间名') + '</span><b>' + esc(my.name || (T('房间') + ' ' + my.room_id)) + '</b></div>' +
            '<div class="gn-matchrun-row"><span>' + T('房间号') + '</span><b>' + esc(my.room_id) + '</b></div>' +
            (my.game_name ? '<div class="gn-matchrun-row"><span>' + T('游戏') + '</span><b>' + esc(my.game_name) + '</b></div>' : '') +
            '<div class="gn-matchrun-row"><span>' + T('状态') + '</span><b>' + (my.status === 'playing' ? T('游戏中') : T('等待中')) + '</b></div>';
        matchRunShow();
        setTimeout(function () {
            // 结果页随入房完成自动关闭（room 页已由 join-confirm 切换）；期间面板已关则由 close() 收口
            if (match.active && match.phase === 'success') matchAbort();
        }, 1800);
    }
    // 匹配失败（30s 超时未命中）：失败结果页 + 三项后续操作
    function matchFail() {
        matchStopTimer();
        match.phase = 'fail';
        elMatchRunFailSub.textContent = T('30 秒内没有符合筛选条件且有空位的房间，可调整筛选后重试');
        matchRunShow();
        refreshList(true);
    }
    function matchRunCancel() {
        // 取消匹配：停搜索回大厅（在途 join 无法撤回，确认后照常进房，不额外提示）
        matchAbort();
        toast(T('已取消匹配'));
    }
    function matchAbort() {
        matchStopTimer();
        match.active = false;
        match.phase = '';
        elMatchMask.classList.add('hidden');
        elMatchRunMask.classList.add('hidden');
        mGselOpen(false);
    }
    function matchStopTimer() {
        if (match.timer) { clearInterval(match.timer); match.timer = null; }
    }
    // —— 匹配游戏选择器（建房 gn-gsel 同款骨架的独立实例：全部游戏 + 联机游戏，带搜索） ——
    var mGselItems = [];    // 选项 [{val,name,cover}]
    var mGselValCur = '0';  // 当前选中值（'0'=全部游戏 / 数字字符串=游戏 id）
    function mGselSyncToggle() {
        var it = null;
        for (var i = 0; i < mGselItems.length; i++) { if (mGselItems[i].val === mGselValCur) { it = mGselItems[i]; break; } }
        var name = it ? it.name : T('全部游戏');
        if (elMgselName.textContent !== name) elMgselName.textContent = name;
        gnGselRenderIco(elMgselIco, it ? it.cover : '', name);
    }
    function mGselRender() {
        var kw = (elMgselSearch.value || '').trim().toLowerCase();
        elMgselList.innerHTML = '';
        var shown = mGselItems.filter(function (it) {
            if (!kw) return true;
            return String(it.name || '').toLowerCase().indexOf(kw) >= 0;
        });
        if (!shown.length) {
            var empty = document.createElement('div');
            empty.className = 'gn-gsel-empty';
            empty.textContent = T('无匹配游戏');
            elMgselList.appendChild(empty);
        } else {
            shown.forEach(function (it) {
                var row = document.createElement('div');
                row.className = 'gn-gsel-item' + (it.val === mGselValCur ? ' sel' : '');
                row.setAttribute('data-val', it.val);
                var ico = document.createElement('span');
                ico.className = 'gn-gsel-ico';
                row.appendChild(ico);
                gnGselRenderIco(ico, it.cover, it.name);
                var nm = document.createElement('span');
                nm.className = 'gn-gsel-nm';
                nm.textContent = it.name;
                row.appendChild(nm);
                if (it.val === mGselValCur) {
                    var ck = document.createElement('span');
                    ck.className = 'gn-gsel-ck';
                    ck.textContent = '✓';
                    row.appendChild(ck);
                }
                elMgselList.appendChild(row);
            });
        }
        if (window._osbTick) window._osbTick(elMgselList);
    }
    function mGselSelect(val) {
        if (mGselValCur !== val) {
            mGselValCur = val;
            mGselSyncToggle();
            mGselRender(); // 选中即同步列表 ✓ 位置（与建房 gnGselSelect 同口径，防重开面板 ✓ 停留旧项）
        }
        mGselOpen(false);
    }
    function mGselOpen(open) {
        if (!elMgselPanel) return;
        var willOpen = (open === undefined) ? elMgselPanel.classList.contains('hidden') : !!open;
        if (willOpen) {
            if (elMgselSearch.value) { elMgselSearch.value = ''; mGselRender(); }
            elMgselPanel.classList.remove('hidden');
            elMgsel.classList.add('open');
            setTimeout(function () { try { elMgselSearch.focus(); } catch (e) { } }, 30);
            if (window._osbTick) window._osbTick(elMgselList, 200);
        } else {
            elMgselPanel.classList.add('hidden');
            elMgsel.classList.remove('open');
            if (window._osbTick) window._osbTick(elMgselList);
        }
    }
    function doLeave() {
        if (!my) return;
        var roomId = my.room_id;
        send({ action: 'leave', room_id: roomId });
        teardownLocal('left');
        showPage('lobby');
    }
    function kickMember(username, name) {
        if (!my) return;
        confirmBox(T('移出成员'), T('确定将「') + name + T('」移出房间吗？'), T('移出'), function () {
            if (!my) return;
            send({ action: 'kick', room_id: my.room_id, target: username });
        });
    }
    // 成员显示名（房主转让 toast 用）
    function memberName(username) {
        var ms = (my && my.members) || [];
        for (var i = 0; i < ms.length; i++) { if (ms[i].username === username) return ms[i].name || ms[i].username; }
        return username;
    }
    // 功能二期：房主转让（仅房主可发起；服务端校验目标为房内在线 PC 成员）。
    // 移交后由接收方提供游戏端口（需在相同端口运行同一款游戏），原房主变为普通成员需重新准备。
    function transferMember(username, name) {
        if (!my || !my.isHost || busy.transfer) return;
        confirmBox(T('移交房主'),
            T('将房主移交给「') + name + T('」？移交后由对方提供游戏端口（需在相同端口运行同一款游戏），你将变为普通成员并需重新准备。'),
            T('移交'),
            function () {
                if (!my || !my.isHost) return;
                if (!send({ action: 'transfer', room_id: my.room_id, target: username })) return;
                busy.transfer = true; armBusy();
                renderMembers(); // 移交按钮置灰（本轮在途防重复提交）
            });
    }
    // 功能二期：房主变更后重挂隧道（服务端已 abort 房间内全部旧隧道，双方按新 host 重连）
    // 原房主 hostStop→connect(新房主)；新房主 disconnect→hostStart(本机端口)；其余成员 disconnect→connect(新 host)
    function rewireHost(prevHost, nextHost) {
        if (!my || !window.GameNet) return;
        var wasHost = prevHost === u(), isHostNow = nextHost === u();
        if (isHostNow) gnBroadcastStopQuiet(); // 功能二期方案 B：成员变房主即停局域网发现（房主不广播）
        try {
            if (wasHost) { if (GameNet.hostStop) GameNet.hostStop(my.room_id); }
            else if (GameNet.disconnect) { GameNet.disconnect(my.room_id); }
        } catch (e) { }
        my._selfLinkText = ''; my._selfLinkCls = ''; // 链路态复位，等待新链路事件回填
        try {
            if (isHostNow) { if (GameNet.hostStart) GameNet.hostStart(my.room_id, my.host_port); }
            else if (my.host && my.host_port && GameNet.connect) { GameNet.connect(my.room_id, my.host, my.host_port); }
        } catch (e) { }
    }
    // 房内聊天：上行 109 chat（服务端只广播房内成员、不落库）
    function roomSendMsg() {
        if (!my) return;
        var t = (elRoomIn2.value || '').trim();
        if (!t) return;
        elRoomIn2.value = '';
        if (!send({ action: 'chat', room_id: my.room_id, text: t.slice(0, 200) })) { elRoomIn2.value = t; return; }
        awaitingChat = 'room'; // 未收到本人回显前，任何 9 帧都归因于本次聊天发送
    }
    // 大厅聊天：上行 112（服务端只广播在场玩家、不落库）
    function lobbySendMsg() {
        var t = (elLobbyIn.value || '').trim();
        if (!t) return;
        elLobbyIn.value = '';
        if (!sendLobby({ action: 'msg', text: t.slice(0, 200) })) { elLobbyIn.value = t; return; }
        awaitingChat = 'lobby';
    }

    // ===== 邀请好友（微信同款选人弹窗；上行 111 邀请卡片，落在聊天窗口） =====
    var invitePicked = {};     // username → true（多选）
    var inviteSearchTimer = null;

    // 好友数据源：主窗口环境取全局通讯录 window.IMContacts；游戏中心窗经 IPC 向主窗口拉取快照
    function loadFriends() {
        if (window.IMContacts && typeof IMContacts.friends === 'function') {
            friendsCache = IMContacts.friends() || [];
            return;
        }
        if (window.desktop && typeof window.desktop.gnContactsGet === 'function') {
            try {
                window.desktop.gnContactsGet().then(function (list) {
                    friendsCache = Array.isArray(list) ? list : [];
                }, function () { friendsCache = []; });
            } catch (e) { friendsCache = []; }
        }
    }
    function inviteEntries() {
        var me = u();
        var out = [];
        var list = (window.IMContacts && typeof IMContacts.friends === 'function') ? (IMContacts.friends() || []) : friendsCache;
        (list || []).forEach(function (f) {
            if (!f || !f.username || f.username === me) return;
            out.push({
                username: f.username,
                display: ((f.name || f.remark || '').trim()) || f.username,
                avatar: f.avatar || ''
            });
        });
        return out;
    }
    function inviteRenderList(kw) {
        var k = (kw || '').trim().toLowerCase();
        elInviteList.innerHTML = '';
        inviteEntries().forEach(function (it) {
            if (k && it.display.toLowerCase().indexOf(k) < 0 && it.username.toLowerCase().indexOf(k) < 0) return;
            var item = document.createElement('div');
            item.className = 'gn-invite-item' + (invitePicked[it.username] ? ' selected' : '');
            item.innerHTML = avatarHtml(it.username, it.display) +
                '<span class="gn-invite-name">' + esc(it.display) + '</span>' +
                '<span class="gn-invite-check"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>';
            item.addEventListener('click', function () {
                invitePicked[it.username] = !invitePicked[it.username];
                item.classList.toggle('selected', !!invitePicked[it.username]);
                inviteUpdateSend();
            });
            elInviteList.appendChild(item);
        });
        if (!elInviteList.children.length) {
            var empty = document.createElement('div');
            empty.className = 'gn-invite-empty';
            empty.textContent = T('暂无好友');
            elInviteList.appendChild(empty);
        }
    }
    function inviteUpdateSend() {
        var n = Object.keys(invitePicked).filter(function (k) { return invitePicked[k]; }).length;
        elInviteSend.disabled = n === 0;
        elInviteSend.textContent = n > 0 ? (T('发送邀请') + ' (' + n + ')') : T('发送邀请');
    }
    function inviteOpen() {
        if (!my) { toast(T('请先加入房间')); return; }
        invitePicked = {};
        elInviteSearch.value = '';
        loadFriends();
        setTimeout(function () { inviteRenderList(elInviteSearch.value); }, 220); // 好友快照异步到达后再渲染
        inviteUpdateSend();
        elInviteMask.classList.remove('hidden');
        if (window._osbInit) window._osbInit(elInviteList);
        setTimeout(function () { try { elInviteSearch.focus(); } catch (e) { } }, 50);
    }
    function inviteClose() {
        elInviteMask.classList.add('hidden');
    }
    // 发送：上行 111 帧（仅携带 room_id，房名/房主/端口由服务端读房间态富化），
    // 落库后双方聊天窗口实时出邀请卡片
    function inviteSend() {
        if (!my) { inviteClose(); return; }
        var names = Object.keys(invitePicked).filter(function (k) { return invitePicked[k]; });
        if (!names.length) return;
        var ok = 0;
        names.forEach(function (n) {
            if (window.GNSignal && GNSignal.isConnected()) {
                if (GNSignal.send({ msg_type: MSG_INVITE, to_user: n, content: JSON.stringify({ invite: { room_id: my.room_id } }) })) ok++;
            }
        });
        inviteClose();
        toast(ok > 0 ? T('已发送 {n} 个联机邀请', { n: ok }) : T('邀请发送失败，请检查网络'));
    }

    // 邀请卡片「加入房间」入口：唤醒游戏中心联机大厅并直接加入（端口隧道仅 PC 客户端可用）
    function joinFromInvite(roomId) {
        roomId = String(roomId || '').replace(/[^0-9]/g, '');
        if (!/^[0-9]{6}$/.test(roomId)) { toast(T('邀请的房间号无效')); return; }
        if (!avail()) { toast(T('当前环境不支持联机（请在 PC 客户端加入）')); return; }
        if (typeof window.GSShowOnline === 'function') window.GSShowOnline();
        if (my && my.room_id === roomId) { open({ room_id: roomId }); return; }   // 已在房内：直接进房间页
        if (my && my.room_id !== roomId) { toast(T('请先退出当前房间再接受邀请')); open({ room_id: roomId }); return; }
        open({ room_id: roomId });
        joinRoom(roomId, '', '');
    }

    // 本端收口：房主关房收口全部隧道，加入者断开自身连接（与 GameNet 引擎联动，防孤儿）
    function teardownLocal(reason) {
        if (my) {
            try {
                if (my.isHost) { if (window.GameNet && GameNet.hostStop) GameNet.hostStop(my.room_id); }
                else if (window.GameNet && GameNet.disconnect) GameNet.disconnect(my.room_id);
            } catch (e) { }
            gnBroadcastStopQuiet(); // 功能二期方案 B：房间页统一收口即停局域网发现
        }
        gnP2pStop(reason); // 虚拟网卡路线：supernode 房间收口即停 p2p-host（幂等，非 supernode 房间 no-op）
        my = null;
        myName = '';
        pendingJoinId = '';
        awaitingChat = ''; // 房间收口连带清房内聊天在途锁（关房瞬间发送的信令不会再来回显，防发送锁死）
        roomMsgs = [];
    }

    // ===== p2p-host.exe 启动器联动（联机虚拟网卡路线，设计文档 §七；生命周期归口主进程 p2pHost 块）=====
    // 开局（status→playing 且 mode=supernode）：收集参数启动（vip_ip/mac/mask 登录回执 localStorage +
    // comm/comm_key/supernodes 房间信令）；对局结束/退房/关房（teardownLocal）停止。单实例主进程归口
    // 注意：p2p-host -s 是子网掩码（n2n v2 此 fork 语义），非 MAC——MAC 由 TAP 驱动自取
    // quiet：静默成功分支（准备按钮/中途加入兜底触发用——已运行时不再重复 toast，失败仍告知）
    function gnP2pStart(quiet) {
        if (!window.desktop || typeof window.desktop.p2pHostStart !== 'function') {
            toast(T('当前客户端不支持虚拟网卡启动器，请联系升级'));
            return;
        }
        var vipIp = '', vipMac = '', vipMask = '';
        try {
            vipIp = localStorage.getItem('vip_ip') || '';
            vipMac = localStorage.getItem('vip_mac') || '';
            vipMask = localStorage.getItem('vip_mask') || '';
        } catch (eV) { }
        window.desktop.p2pHostStart({
            vip_ip: vipIp, vip_mac: vipMac,
            mask: vipMask || '255.255.0.0', // 设计网段 10.28.0.0/16；服务端回执缺省时按设计兜底
            comm: my.comm || '', comm_key: my.comm_key || '',
            supernodes: my.supernodes || []
        }).then(function (r) {
            if (r && r.ok) {
                if (!quiet) toast(r.already ? T('虚拟网卡组网已在运行') : T('p2p-host 已启动，虚拟网卡组网中…'));
            } else {
                toast(T((r && r.err) || 'p2p-host 启动失败'));
            }
        }).catch(function () { toast(T('p2p-host 启动失败')); });
    }
    function gnP2pStop(reason) {
        if (!window.desktop || typeof window.desktop.p2pHostStop !== 'function') return;
        try { window.desktop.p2pHostStop(reason || 'room-teardown'); } catch (e) { }
    }
    // 加入方启动引导（开局过渡 / 中途加入共用，每房一次 _launchAsked）：按房类型引导启动本机游戏。
    // 「不指定（虚拟网卡）」房按本机记忆路径询问（无记忆仅提示）；关联游戏房走游戏库启动链（云存档/启动参数同源）
    function gnJoinerLaunchAsk() {
        if (my._launchAsked) return;
        my._launchAsked = true;
        if (!(my.game_id || 0)) {
            // 不指定房分两种联机方式：虚拟网卡（局域网列表互见）/ 通用端口隧道（隧道已自动连接）——文案随方式区分
            var vnic = my.mode === 'supernode';
            var lp = gnLocalGamePath();
            if (lp && window.desktop && typeof window.desktop.localGameLaunch === 'function') {
                confirmBox(T('启动游戏'),
                    vnic ? T('对局进行中，是否立即启动本机游戏？进入游戏局域网列表即可互见。')
                         : T('对局进行中，是否立即启动本机游戏并加入？'),
                    T('启动'), function () {
                    window.desktop.localGameLaunch({ id: 'gn_room', exe: lp });
                });
            } else {
                toast(vnic ? T('虚拟网卡组网中，请启动游戏后进入局域网列表即可互见')
                           : T('端口隧道已连接，请启动游戏后即可加入对局'));
            }
            return;
        }
        var gl = my.game_name || '';
        if (typeof window.GSLaunchGame === 'function' && window.GSGameMeta && window.GSGameMeta(my.game_id)) {
            confirmBox(T('启动游戏'), T('对局进行中，是否立即启动《{g}》并加入？', { g: gl }), T('启动'), function () {
                window.GSLaunchGame(my.game_id);
            });
        } else {
            toast(T('请先在游戏中心安装并启动《{g}》', { g: gl }));
        }
    }
    // p2p-host 状态推送（全窗广播）：对局中异常退出即时告知（正常收口由 teardownLocal 触发不重复提示）
    if (window.desktop && typeof window.desktop.onP2pHostStatus === 'function') {
        window.desktop.onP2pHostStatus(function (st) {
            if (st && !st.running && my && my.status === 'playing' && my.mode === 'supernode') {
                toast(T('虚拟网卡组网已断开（{r}）', { r: st.reason || '进程退出' }));
            }
        });
    }

    // ===== 下行信封状态机（GNSignal 分流 109 帧） =====
    function onSignal(msg) {
        var env = null;
        try { env = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!env || !env.action) return;
        switch (env.action) {
            case 'created': {
                // 建房成功（仅发房主）：落房间态 + 联动 hostStart（隧道按对端惰性开启）
                if (env.room_id) {
                    matchAbort(); // 建房即终局：终止进行中的匹配（含失败结果页残留）
                    my = normRoom(env, true);
                    roomMsgs = [];
                    if (window.GameNet && GameNet.hostStart) {
                        try { GameNet.hostStart(my.room_id, my.host_port); } catch (e) { }
                    }
                    unlockBusy();
                    if (typeof window.GSShowOnline === 'function') window.GSShowOnline();
                    open(); // 已在页内则仅切页
                    toast(T('房间已创建，房间号 {id}', { id: my.room_id }));
                }
                break;
            }
            case 'state': {
                // 房间态全量广播（成员变更/就绪/开局），只发给房内成员
                if (!my) {
                    // 加入者的首次确认：本端无房且 room_id 与本端在途 join 一致 → 入房 + 发起连接
                    if (!pendingJoinId || env.room_id !== pendingJoinId) break;
                    my = normRoom(env, env.host === u());
                    roomMsgs = [];
                    gnDbg('join-confirm room=' + my.room_id + ' host=' + my.host + ' port=' + my.host_port + ' isHost=' + my.isHost);
                    if (typeof window.GSShowOnline === 'function') window.GSShowOnline();
                    unlockBusy();
                    if (window.GameNet && GameNet.connect && my.host && my.host_port) {
                        gnDbg('join-confirm → GameNet.connect skipPort=' + !!gnGameKind());
                        try { GameNet.connect(my.room_id, my.host, my.host_port, { skipPort: !!gnGameKind() }); } catch (e) { gnDbg('connect threw: ' + (e && e.message)); }
                    } else {
                        gnDbg('join-confirm gate blocked: GameNet=' + (window.GameNet ? 'ok' : 'null') + ' host=' + my.host + ' port=' + my.host_port);
                    }
                    if (visible) showPage('room');
                    toast(T('已加入房间'));
                    matchSucceed(); // 快速匹配自动加入命中：成功结果页（未在匹配中为空操作）
                    // 功能二期：房间关联了游戏库游戏但本机未安装——提前提醒获取安装，
                    // 免得到房主开局时才发现玩不了（开局沿另有引导；此处一次性提示）
                    if ((my.game_id || 0) > 0 && !my._installHinted &&
                        window.GSGameMeta && !window.GSGameMeta(my.game_id)) {
                        my._installHinted = true;
                        toast(T('该房间游戏《{g}》未安装，请先在游戏中心获取并安装', { g: my.game_name || '' }));
                    }
                    // 中途加入（加入确认时房间已在游戏中）：不自动组网——以「准备」为明确加入意图，
                    // 点准备时才拉起 p2p-host 并引导启动游戏（见准备按钮）；此处仅提示操作路径防迷路
                    if (!my.isHost && my.status === 'playing' && my.mode === 'supernode') {
                        toast(T('对局进行中：点击「准备」后将自动组网并引导启动游戏'));
                    }
                    if (visible && curPage === 'room') renderRoom();
                    break;
                }
                if (env.room_id !== my.room_id) break;
                my._resyncPending = false; // 重同步成功（房间仍在）：撤销恢复标记
                var prev = my.status;
                var prevHost = my.host;
                my = normRoom(env, env.host === u()); // 功能二期：isHost 以服务端 host 字段为准（房主转让后随广播切换）
                // host_port 晚到/会话失效补连（服务端设计口径"加入方随 state 对准真实端口"原缺执行体，实测
                // 房主开局探测回填 host_port 晚于首次确认时，加入方被门卫跳过 connect 后永不开隧道）：
                // 会话不在途/未建立即按当前房态端口补连；失败重试间隔 10s 防风暴；链路已建立不重连防断游戏
                if (!my.isHost && my.host && my.host_port && window.GameNet && GameNet.connect) {
                    var gnSt = (typeof GameNet.stateOf === 'function') ? GameNet.stateOf(my.room_id) : null;
                    var gnBusy = gnSt && (gnSt.state === 'probing' || gnSt.state === 'accepted' || gnSt.state === 'linked');
                    gnDbg('state-sync room=' + my.room_id + ' st=' + (gnSt ? gnSt.state : 'null') + ' port=' + my.host_port + ' → ' + (gnBusy ? 'in-flight skip' : (Date.now() - (my._lastConnectAt || 0) > 10000 ? 'reconnect' : 'backoff skip')));
                    if (!gnBusy && Date.now() - (my._lastConnectAt || 0) > 10000) {
                        my._lastConnectAt = Date.now();
                        try { GameNet.connect(my.room_id, my.host, my.host_port, { skipPort: !!gnGameKind() }); } catch (e) { gnDbg('reconnect threw: ' + (e && e.message)); }
                    }
                }
                // 功能二期：房主转让——host 字段切换即重挂隧道（服务端已 abort 旧隧道，双方按新 host 重连）
                if (prevHost && my.host && prevHost !== my.host) {
                    unlockBusy(); // 移交在途（发起者）成功收口
                    toast(my.host === u() ? T('你已成为房主') : T('房主已转让给 {name}', { name: memberName(my.host) }));
                    rewireHost(prevHost, my.host);
                }
                if (prev === 'playing' && my.status !== 'playing') {
                    // 功能二期：结束对局回环——清「等待游戏内建主/已启动」标志（下次开局重新走启动流程）
                    my._waitingHost = false;
                    my._gameLaunched = false;
                }
                if (prev !== 'playing' && my.status === 'playing') {
                    toast(T('房主已开始游戏'));
                    // 虚拟网卡路线：supernode 房间开局即启动 p2p-host（房主与成员各自拉起，组网参数随信令已到位；
                    // 启动器异常由 onP2pHostStatus 推送告知。启动器另案落地前此路径即真实启动链）
                    if (my.mode === 'supernode') gnP2pStart();
                    // 加入方启动引导（不指定房按本机记忆路径 / 游戏房走游戏库启动链；每房一次）。
                    // 中途加入的等价引导在 join-confirm 分支（状态已是 playing 时此处不会触发）
                    if (!my.isHost && (my.mode === 'supernode' || (my.game_id || 0) > 0)) gnJoinerLaunchAsk();
                }
                gnBroadcastEnsure(); // 功能二期方案 B：成员/人数变化同步到局域网发现广播包（幂等更新）
                if (visible && curPage === 'room') renderRoom();
                break;
            }
            case 'list': {
                rooms = env.rooms || [];
                renderRoomList();
                break;
            }
            case 'chat': {
                // 房内聊天广播（仅成员；不落库）
                if (!my || env.room_id !== my.room_id) break;
                if (env.from === u() && awaitingChat === 'room') awaitingChat = ''; // 本人回显：发送成功
                roomMsgs.push({ from: env.from || '', name: env.from_name || env.from || '', text: env.text || '', ts: env.ts || (Date.now() / 1000) });
                if (roomMsgs.length > 200) roomMsgs = roomMsgs.slice(-200);
                if (visible && curPage === 'room') renderRoomChat();
                break;
            }
            case 'closed': {
                // 关房（host_left/empty/kicked）：本端收口并回大厅
                if (my && env.room_id === my.room_id) {
                    var r = env.reason || '';
                    teardownLocal(r);
                    unlockBusy();
                    if (visible) showPage('lobby');
                    toast(r === 'kicked' ? T('你已被移出房间')
                        : r === 'host_left' ? T('房主已解散房间')
                            : r === 'empty' ? T('房间已解散') : T('房间已关闭'));
                }
                break;
            }
            default: break;
        }
    }
    function normRoom(env, isHost) {
        var members = env.members || [];
        var self = null;
        for (var i = 0; i < members.length; i++) { if (members[i].username === u()) { self = members[i]; break; } }
        return {
            room_id: env.room_id || (my && my.room_id) || '',
            name: (my && my.room_id === env.room_id && my.name) || myName || '',
            host: env.host || (my && my.host) || '',
            host_port: env.host_port || (my && my.host_port) || 0,
            mode: env.mode || (my && my.mode) || MODE_TUNNEL,
            // 虚拟网卡组网参数（supernode 房间随信令下发：建房生成的社区名/密钥 + 游戏级 supernode 列表）
            comm: env.comm || '',
            comm_key: env.comm_key || '',
            supernodes: env.supernodes || [],
            game_mode: env.game_mode || (my && my.game_mode) || '',
            max_players: env.max_players || (my && my.max_players) || 0,
            game_id: env.game_id || (my && my.game_id) || 0,
            game_name: env.game_name || (my && my.game_name) || '',
            group_id: env.group_id || 0,
            status: env.status || 'waiting',
            members: members,
            isHost: !!isHost,
            ready: !!(self && self.ready),
            _selfLinkText: (my && my._selfLinkText) || '',
            _selfLinkCls: (my && my._selfLinkCls) || ''
        };
    }

    // ===== 下行信封（112 大厅：在场名单 + 聊天，不落库） =====
    function onLobbySignal(msg) {
        var env = null;
        try { env = JSON.parse(msg.content || '{}'); } catch (e) { return; }
        if (!env) return;
        if (env.action === 'users') {
            lobbyUsers = env.users || [];
            renderLobbyChat();
        } else if (env.action === 'msg') {
            if (env.from === u() && awaitingChat === 'lobby') awaitingChat = ''; // 本人回显：发送成功
            lobbyMsgs.push({ from: env.from || '', name: env.from_name || env.from || '', text: env.text || '', ts: env.ts || (Date.now() / 1000) });
            if (lobbyMsgs.length > 200) lobbyMsgs = lobbyMsgs.slice(-200);
            renderLobbyChat();
        } else if (env.action === 'sys') {
            lobbyMsgs.push({ sys: true, text: env.text || '' });
            if (lobbyMsgs.length > 200) lobbyMsgs = lobbyMsgs.slice(-200);
            renderLobbyChat();
        } else if (env.action === 'rooms_changed') {
            // 功能二期：房间表变更实时通知（建房/加入/退出/踢人/开局/转让/关房）——自动重拉列表，
            // 无需手动点刷新；服务端已 1s 尾沿节流（推送频率≤2 次/秒），此处 force 拉取保证
            // 补推不被客户端节流窗口吞掉（force 拉取复用既有 list 链路与过滤，量小可控）
            refreshList(true);
        }
    }

    // 断链自动重连：会话死亡后不依赖房间状态广播（对局结束无 state 变更，原补连无触发点，
    // 实测须手动取消/准备才能重连）——指数退避自动重连（3s 起倍增封顶 60s）；
    // 重连成功/退出房间/新会话在途即停，幂等防抖与状态沿补连共享 _lastConnectAt
    function gnAutoReconnect() {
        if (!my || my.isHost || !my.host || !my.host_port || !window.GameNet || !GameNet.connect) return;
        if (my._reconnTimer) { clearTimeout(my._reconnTimer); my._reconnTimer = null; }
        var n = (my._reconnN || 0) + 1;
        my._reconnN = n;
        var delay = Math.min(3000 * Math.pow(2, n - 1), 60000);
        my._reconnTimer = setTimeout(function () {
            my._reconnTimer = null;
            if (!my || my.isHost || !my.host || !my.host_port) return; // 已退房/变房主：放弃
            var st = (typeof GameNet.stateOf === 'function') ? GameNet.stateOf(my.room_id) : null;
            if (st && (st.state === 'probing' || st.state === 'accepted' || st.state === 'linked')) return; // 已有会话在途/建立
            if (Date.now() - (my._lastConnectAt || 0) < 10000) return; // 状态沿补连刚发过：让路
            my._lastConnectAt = Date.now();
            gnDbg('auto-reconnect #' + n + ' (delay=' + delay + 'ms)');
            try { GameNet.connect(my.room_id, my.host, my.host_port, { skipPort: !!gnGameKind() }); } catch (e) { gnDbg('auto-reconnect threw: ' + (e && e.message)); }
        }, delay);
    }

    // ===== GameNet 引擎事件（链路态/降级/错误）→ 房间页实时反馈 =====
    function onNetEvent(ev) {
        gnDbg('net-event ' + (ev && ev.type) + ' room=' + (ev && ev.room_id) + (ev && ev.reason ? ' reason=' + ev.reason : '') + (ev && ev.type === 'gameinfo' ? ' hex=' + ((ev.d || '').length) + 'B' : ''));
        if (!ev || !my || ev.room_id !== my.room_id) return;
        if (ev.type === 'ready') {
            my._selfLinkText = T('已与房主建立联机'); my._selfLinkCls = 'on'; perfHintCheck();
            my._reconnN = 0; // 链路建立：清退避计数
            if (my._reconnTimer) { clearTimeout(my._reconnTimer); my._reconnTimer = null; }
        }
        else if (ev.type === 'accepted' || ev.type === 'probe') { my._selfLinkText = T('正在建立联机…'); my._selfLinkCls = 'wait'; }
        else if (ev.type === 'relay') { my._selfLinkText = T('联机已走中继转发'); my._selfLinkCls = 'on'; }
        else if (ev.type === 'listen') {
            my._selfLinkText = T('游戏端口隧道已就绪'); my._selfLinkCls = 'on';
            // 功能二期方案 B：广播发现代理——加入方 join 隧道就绪即启动虚拟主机应答，
            // 本机游戏「局域网游戏」列表直接出现好友房间（房主侧不广播：本机游戏自建主机）
            if (ev.role === 'join' && ev.proto === 'udp') gnBroadcastEnsure();
            // 功能二期：主机端探测模式——本机游戏为真实主机，代理周期探测本机游戏并把真实
            // GameInfo（名称/人数/槽位/地图）经 ctl 通道中继给加入方（广播帧不含名称，必经此路）
            else if (ev.role === 'host' && ev.proto === 'udp') gnBroadcastEnsure();
        }
        else if (ev.type === 'gameinfo') {
            // 功能二期：主机探测到的真实 GameInfo（hex）→ 交代理在应答/直投中使用真实数据
            if (window.desktop && typeof window.desktop.gnBroadcastRelay === 'function') {
                try { window.desktop.gnBroadcastRelay({ room_id: ev.room_id, hex: ev.d }); } catch (e) { }
            }
        }
        else if (ev.type === 'abort') {
            my._selfLinkText = T('联机已断开'); my._selfLinkCls = 'off'; perfHintRearm();
            gnBroadcastStopQuiet(); // 功能二期方案 B：断链即停局域网发现（幂等）
            gnAutoReconnect(); // 断链自动重连（对局结束无 state 广播，原补连无触发点须手动取消/准备）
        }
        else if (ev.type === 'error') {
            my._selfLinkText = T('联机异常：') + (ev.reason || ''); my._selfLinkCls = 'off'; perfHintRearm();
            gnAutoReconnect(); // 异常路径同样自动重连（幂等：与 abort 共享退避计时）
        }
        if (visible && curPage === 'room') { renderLinkBar(); renderMembers(); }
    }

    // 功能二期方案 B：局域网发现启动/同步（幂等；双模——加入方拦截/直投应答，主机端探测中继）
    // 发现模式分流：魔兽 III 走本地伪造应答（毫秒级，免跨机往返）；其余游戏走 L1 透传反射——
    // 搜索包经既有隧道由真实主机进程应答（零协议适配，无需代理会话，本函数直接跳过）
    // 成员变化时重发（主进程同端口重入仅更新名称/人数字段，条目指纹不变，列表平滑刷新）
    function gnBroadcastEnsure() {
        if (!my || !window.desktop || typeof window.desktop.gnBroadcastStart !== 'function') return;
        if (!gnGameKind()) return; // 未适配游戏：透传反射，无需代理
        var bHost = null;
        var mems = my.members || [];
        for (var bi = 0; bi < mems.length; bi++) { if (mems[bi].host) { bHost = mems[bi]; break; } }
        window.desktop.gnBroadcastStart({
            room_id: my.room_id, game: gnGameKind(), port: my.host_port || 0,
            role: my.isHost ? 'host' : 'join',
            game_name: T('[IM] {name}的房间', { name: (bHost && bHost.name) || '' }),
            host_name: (bHost && bHost.name) || '',
            host_ip: (bHost && (bHost.host_ip || bHost.ip)) || '',
            slots_total: my.max_players || 0, slots_used: mems.length
        }).then(function (r) {
            if (r && r.ok && !r.updated && !my.isHost) toast(T('已开启局域网发现：游戏列表将直接显示本房间'));
        }).catch(function () { });
    }

    // 功能二期方案 B：局域网发现停止归口（主进程幂等；非 PC/未启动时静默）
    function gnBroadcastStopQuiet() {
        if (!window.desktop || typeof window.desktop.gnBroadcastStop !== 'function') return;
        try { window.desktop.gnBroadcastStop({ room_id: my ? my.room_id : '' }); } catch (e) { }
    }

    // ===== 联机二期 §9.4-5：同机并发降级提示（按用户选定口径只落在联机侧）=====
    // 语义：联机真正建立（ready：本端与房主/对端隧道打通）时，反查本机是否另有通话/会议/远程协助在跑；
    // 命中则由本窗自绘 toast 提示一次——同机同时跑联机与实时音视频会争抢网络与上行带宽（体验级影响，
    // 非阻断）；同一次并存期内只提示一次，联机全部会话收口后重新武装（perfHintRearm）。
    // 依赖：主进程 act:other-get（通话窗/远程窗上报的活跃态缓存）；Web 端/非 Electron 环境无 desktop 即静默跳过。
    var perfHintDone = false;
    function perfHintCheck() {
        if (perfHintDone) return;
        if (!window.GameNet || !window.desktop || typeof window.desktop.actOtherGet !== 'function') return;
        var act = GameNet.activeCount();
        if (!act || !act.sessions) return; // 尚未真正联通（仅建房/等待成员时不算并发，不提示）
        Promise.resolve(window.desktop.actOtherGet()).then(function (s) {
            if (perfHintDone || !s || (!s.call && !s.remote)) return;
            perfHintDone = true;
            toast(T('本机正在通话/远程协助，与游戏联机同时运行会争抢网络与上行带宽，可能出现卡顿或话音不清'));
        }).catch(function () { /* 查询失败不提示（不阻塞联机） */ });
    }
    function perfHintRearm() {
        if (!window.GameNet) return;
        var act = GameNet.activeCount();
        if (!act || !act.sessions) perfHintDone = false;
    }

    // ===== 事件绑定 =====
    function bindEvents() {
        elRefresh.addEventListener('click', function () { refreshList(true); });
        elCreateOpen.addEventListener('click', openCreate);
        elCreateCancel.addEventListener('click', createClose);
        elCreateMask.addEventListener('click', function (e) { if (e.target === elCreateMask) createClose(); });
        elCreateBtn.addEventListener('click', doCreate);
        elMatchBtn.addEventListener('click', doMatch);
        elJoinBtn.addEventListener('click', doJoin);
        elInMode.addEventListener('change', syncMaxOptions);
        // 联机游戏自绘选择器：开合/搜索过滤/点选/点外部关闭（替代原生 select 的 change 监听）
        elGselToggle.addEventListener('click', function () { gnGselOpen(); });
        elGselSearch.addEventListener('input', gnGselRender);
        elGselSearch.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); gnGselOpen(false); } // 防冒泡触发外层弹窗关闭
            else if (e.key === 'Enter') e.preventDefault(); // 搜索即时生效，回车无其他语义
        });
        elGselList.addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.gn-gsel-item') : null;
            if (row && row.getAttribute('data-val')) gnGselSelect(row.getAttribute('data-val'));
        });
        document.addEventListener('click', function (e) {
            if (elGselPanel.classList.contains('hidden')) return;
            if (!elGsel.contains(e.target)) gnGselOpen(false);
        });
        elRoomIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
        elJoinPass.addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
        [elName, elPort, elPass].forEach(function (inp) {
            inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doCreate(); });
        });
        // 聊天输入（房间 / 大厅）
        elRoomSend2.addEventListener('click', roomSendMsg);
        elRoomIn2.addEventListener('keydown', function (e) { if (e.key === 'Enter') roomSendMsg(); });
        elLobbySend.addEventListener('click', lobbySendMsg);
        elLobbyIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') lobbySendMsg(); });
        elModalOk.addEventListener('click', function () {
            var cb = modalCb, val = elModalIn.value;
            closeModal();
            if (cb) cb(val);
        });
        elModalCancel.addEventListener('click', closeModal);
        elModalIn.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { elModalOk.click(); }
        });
        // 邀请好友弹窗（自绘选人：搜索节流 + 多选 + 点遮罩关闭 + Esc 关闭）
        elInviteSend.addEventListener('click', inviteSend);
        elInviteCancel.addEventListener('click', inviteClose);
        elInviteMask.addEventListener('click', function (e) { if (e.target === elInviteMask) inviteClose(); });
        elInviteSearch.addEventListener('input', function () {
            clearTimeout(inviteSearchTimer);
            inviteSearchTimer = setTimeout(function () { inviteRenderList(elInviteSearch.value); }, 150);
        });
        elInviteSearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') inviteClose(); });
        // 端口自动探测（自绘候选浮层：点条目填入 + 点遮罩/取消关闭 + Esc 关闭）；手动点击=全量候选口径
        elPortDetect.addEventListener('click', function () { portDetect(true); });
        // 启动路径浏览/清空（「不指定（虚拟网卡）」房的本机游戏 exe 记忆，开局自动启动）
        elExePathPick.addEventListener('click', function () {
            if (!window.desktop || typeof window.desktop.gameChooseGameExe !== 'function') { toast(T('请在 PC 客户端中操作')); return; }
            window.desktop.gameChooseGameExe().then(function (rr) {
                if (!rr || rr.canceled || !rr.filePath) return;
                try { localStorage.setItem('gn_local_game_path', rr.filePath); } catch (e) { }
                gnSyncExePath();
            });
        });
        elExePathClear.addEventListener('click', function () {
            try { localStorage.removeItem('gn_local_game_path'); } catch (e) { }
            gnSyncExePath();
        });
        elPortCancel.addEventListener('click', portClose);
        elPortMask.addEventListener('click', function (e) { if (e.target === elPortMask) portClose(); });
        // 快速匹配：设置弹窗（开始/取消/状态多选/游戏选择器）+ 匹配浮层（取消/重试/建房/返回）
        elMatchStart.addEventListener('click', matchStart);
        elMatchCancel.addEventListener('click', matchClose);
        elMatchMask.addEventListener('click', function (e) { if (e.target === elMatchMask) matchClose(); });
        elMatchStatus.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('.gn-match-st') : null;
            if (btn) btn.classList.toggle('sel');
        });
        elMgselToggle.addEventListener('click', function () { mGselOpen(); });
        elMgselSearch.addEventListener('input', mGselRender);
        elMgselSearch.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); mGselOpen(false); }
            else if (e.key === 'Enter') e.preventDefault();
        });
        elMgselList.addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.gn-gsel-item') : null;
            if (row && row.getAttribute('data-val')) mGselSelect(row.getAttribute('data-val'));
        });
        document.addEventListener('click', function (e) {
            if (elMgselPanel.classList.contains('hidden')) return;
            if (!elMgsel.contains(e.target)) mGselOpen(false);
        });
        elMatchRunCancel.addEventListener('click', matchRunCancel);
        elMatchRunBack.addEventListener('click', matchAbort);
        elMatchRunRetry.addEventListener('click', matchRunStart); // 重新匹配：沿用本轮筛选立即再开一轮
        elMatchRunCreate.addEventListener('click', function () { matchAbort(); openCreate(); });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (!elPortMask.classList.contains('hidden')) { portClose(); return; }
            if (!elCreateMask.classList.contains('hidden')) createClose();
            if (!elMatchRunMask.classList.contains('hidden')) { match.phase === 'fail' ? matchAbort() : matchRunCancel(); return; }
            if (!elMatchMask.classList.contains('hidden')) matchClose();
        });
        elClose.addEventListener('click', function () {
            // 页签化后「返回」交还宿主（游戏中心切回商店；主窗口环境回落关闭面板）
            if (typeof window.GSOnlineExit === 'function') { window.GSOnlineExit(); return; }
            close();
        });
        // 角色切换时刷新（GameNet 事件回调归口为 UI 唯一消费者）
        if (window.GameNet) window.GameNet.onEvent = onNetEvent;
        // 信令分流注册（109 房间层 / 112 大厅层；110 由引擎自注册）
        if (window.GNSignal) {
            GNSignal.on(MSG_ROOM, function (msg) { onSignal(msg); });
            GNSignal.on(MSG_LOBBY, function (msg) { onLobbySignal(msg); });
            GNSignal.on(MSG_ERR, function (msg) { onErr(msg); });
            // 功能二期：重连沿房间态重同步——断线期间房间被解散/成员被移出时本端收不到 closed，
            // 重连后会停在幽灵房间页（旧玩家列表）。重连成功且房态存在即主动拉一次 state：
            // 房间仍在 → 全量刷新成员列表；已解散/被移出 → 服务端 9 → onErr 按 _resyncPending 恢复回大厅
            if (typeof GNSignal.onState === 'function') {
                GNSignal.onState(function (on_) {
                    if (!on_ || !my || !my.room_id) return;
                    my._resyncPending = true;
                    send({ action: 'state', room_id: my.room_id });
                });
            }
        }
        // 跨窗桥：主进程 game:net-open（游戏详情「联机」/ 邀请卡片）→ 切联机页签 + 预填 +（可选）直接加入
        if (window.desktop && typeof window.desktop.onGameNetOpen === 'function') {
            window.desktop.onGameNetOpen(function (payload) {
                payload = payload || {};
                if (typeof window.GSShowOnline === 'function') window.GSShowOnline();
                if (payload.join && payload.room_id) { joinFromInvite(payload.room_id); return; }
                open(payload);
            });
        }
        // 功能二期：主机端探测到的真实 GameInfo → 经隧道 ctl 通道中继给全部加入方
        // （真实名称/人数/槽位/地图——广播帧不含名称，加入方列表条目数据必经此中继）
        if (window.desktop && typeof window.desktop.onGnBroadcastGameInfo === 'function') {
            window.desktop.onGnBroadcastGameInfo(function (p) {
                // hex 为空字符串=「主机游戏已消失」信令（防幻影），须放行——仅拦截非法载荷
                gnDbg('broadcast-gi 收到 room=' + (p && p.room_id) + ' hex=' + (p && typeof p.hex === 'string' ? p.hex.length + 'B' : typeof (p && p.hex)) +
                    ' | my=' + (my ? my.room_id + '/isHost=' + my.isHost : 'null'));
                if (!p || !p.room_id || typeof p.hex !== 'string') return;
                if (!my || my.room_id !== p.room_id || !my.isHost) return;
                if (window.GameNet && typeof GameNet.sendGameInfo === 'function') {
                    try {
                        var gnSent = GameNet.sendGameInfo(p.room_id, p.hex);
                        gnDbg('host relay gi ' + (p.hex ? p.hex.length + 'B' : 'gone') + ' → ctl 发给 ' + gnSent + ' 个对端');
                    } catch (e) { gnDbg('host relay gi threw: ' + (e && e.message)); }
                }
            });
        }
    }

    buildDom();
    window.IMGameRoom = { open: open, close: close, isOpen: isOpen, onSignal: onSignal, joinFromInvite: joinFromInvite };
})();
