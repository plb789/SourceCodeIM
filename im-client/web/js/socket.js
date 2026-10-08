// socket.js - WebSocket 连接管理、心跳、重连、消息分发
(function () {
    var ws = null;
    var heartbeatTimer = null;
    var reconnectTimer = null;
    var currentUsername = '';
    var qrLoginConn = false; // 阶段二百四十：本次连接是否走扫码登录通道（凭码成功后校正账号并清空重连凭据）
    // 原实现：recallWindow 未声明（隐式全局）且未暴露 getRecallWindow，
    // 服务端下发的撤回窗口配置从未被前端撤回菜单使用（恒用 120 秒兜底）
    // 阶段十二修复：声明变量并暴露 getRecallWindow，撤回菜单显隐与配置文件 recall_window 保持一致
    var recallWindow = 120;
    // 阶段三十一：服务端下发的文件分片大小与大文件直传阈值（服务端归口，登录响应覆盖默认值）
    // 原实现：分片大小硬编码在前端 chat.js（4KB），与服务端配置脱节
    var chunkSize = 4096;        // 兜底默认值，登录响应携带 chunk_size 后覆盖
    var uploadThreshold = 1048576; // 兜底默认值（1MB），登录响应携带 upload_threshold 后覆盖
    // 阶段三十二：分片直传相关配置（服务端归口下发，兜底值与服务端默认一致）
    var maxFileSize = 20971520;      // 单请求直传上限（20MB），超过走分片直传
    var uploadChunkSize = 4194304;   // 分片直传单片大小（4MB）
    var maxDirectSize = 2147483648;  // 分片直传文件大小上限（2GB），超过直接拒绝
    // 阶段一百五十七：群聊文件大小上限（服务端归口下发，独立于私聊 max_file_size；兜底值与服务端默认一致）
    var groupFileMaxSize = 20971520; // 群聊文件上限（20MB）
    // 阶段一百六十：服务器文件保留天数（服务端归口下发；默认 7，-1=永不清理；前端历史渲染过期标记用）
    var fileRetentionDays = 7;
    // 阶段一百五十六：好友文件 P2P 直传决策参数（服务端归口下发，兜底默认值与服务端 config.yaml 一致）
    var p2pCfg = {
        enabled: true,          // 服务端总开关（false 时全部文件走现有链路）
        threshold: 1048576,     // 大于该字节数且私聊才尝试 P2P
        negotiateTimeout: 10,   // 协商超时秒
        chunkSize: 16384,       // DataChannel 分片字节
        highWater: 8388608,     // 发送缓冲高水位
        lowWater: 1048576,      // 发送缓冲低水位
        archive: false          // 归档开关
    };
    var messageHandlers = {}; // msg_type -> handler 函数数组
    var connected = false;
    // 登录失败提示修复：登录成功标记——登录成功前连接断开不自动重连，
    // 修复密码错误后服务端关闭连接、前端无条件重连导致"失败→重连→失败"无限循环且每次无提示
    var loginOk = false;
    // 阶段一百三十五：最近一次服务端 ERROR 帧到达时间——登录拒绝/账号封禁踢出场景
    // 服务端会先下发 ERROR 帧再立即关连接，onclose 据此区分"服务端拒绝"与"网络断开"
    var lastRejectAt = 0;

    // ===== 阶段二百二十五：手机 APP 切后台/息屏后台保活（WebView ↔ 原生前台服务连接交接） =====
    // 根因：Android 切后台/息屏后 WebView 网络与定时器被系统冻结，心跳发不出 → 服务端判死断线。
    // 方案：由原生前台服务（KeepAliveService，同协议同 platform='app'）在后台期间接管收消息弹通知。
    // 阶段二百四十四 P1 make-before-break：交接不再"先断旧连再建新连"（原方案切后台主动 close、
    // 回前台先 handBack 断原生，两处均产生 1~3s 连接真空，红包/撤回/已读等操作帧可能落入丢失）——
    //   切后台：页面连接保持不动，仅通知原生接管；原生登录成功后服务端同端互踢自动顶掉页面连接，
    //           页面以 bgHandover 标记静默让位（弱网下原生连不上时页面连接继续收消息，优于先断）；
    //   回前台：页面立即重连登录，服务端同端互踢顶掉原生连接（原生收 kick 静默待命），
    //           登录回执后再补一次 handBack（幂等，兼撤后台期来电通知）。交接全程单连接在线，
    //           真空窗口归零。同一时刻仅一条 app 端连接由服务端同端互踢收敛保证。
    var nativeBG = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    // 阶段二百三十一：桥可能晚于本脚本注入（页面加载早期 isNativePlatform 尚未就绪），
    // nativeBG 一次性求值会永久锁死 false——load 后重算一次，晚注册的窗口事件同样受益
    window.addEventListener('load', function () {
        nativeBG = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        // 桥就绪但登录已成功且服务未拉起的场景（此前 nativeBG=false 跳过了 startKeepAlive）：
        // 重算后立即尝试补拉（幂等；桥仍未就绪则进入轮询等待，登录响应先于桥注入时由此兜住）
        try { bgDoStart() || bgWaitStart(); } catch (e) {}
    });
    var bgHandover = false;     // true=交接期（切后台起至重连成功止）：连接断开/kick 均按交接口径静默
    var bgHandoverAt = 0;       // 最近一次交接动作（切后台/回前台）时刻——WebView 冻结会把被踢帧的
                                // onmessage/onclose 排迟到回前台之后（此时 visibilityState 已 visible，
                                // bgHoldReconnect 判定失效），以 8 秒交接活动窗口兜底识别交接型 kick
    var bgResyncPending = false;// 回前台重连成功后需重拉当前会话历史（后台期消息由原生连接接收，WebView 未渲染）
    // 阶段二百五十六补丁：后台期可能丢帧标记（与 bgResyncPending 区分——pending 绑定"需要重连"，
    // missed 仅标记"后台期有帧由原生接收 WebView 未渲染"）。原实现交接 kick 即置 pending：
    // 相册/拍摄等半透明浮层场景页面仍可见、3s 补位重连登录成功即派发 resync → 选图期间聊天页
    // 可见刷新。现 kick 仅置 missed，回前台（visibilitychange visible）统一消费派发，选图期间零刷新
    var bgMissedFrames = false;
    // 阶段二百三十二修复：bgPlugin 原实现以 !!(...) 返回布尔值，调用处却当插件对象用
    // （bgp.startKeepAlive / bgPlugin().takeOver()）——true 上取方法恒 undefined 抛
    // TypeError，startKeepAlive/takeOver/handBack 从未真正发出（prefs 凭据为空 → 后台接管
    // 登录失败 → 切后台即下线；此前切后台接管全靠原生 ActivityLifecycleCallbacks 兜底）。
    // 现返回插件对象（桥未就绪返回 null），调用处按对象判空使用
    function bgPlugin() {
        // 全实时求值：isNativePlatform 现查而非依赖加载期快照（防桥晚注入竞态）
        if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
            && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundIM) {
            return window.Capacitor.Plugins.BackgroundIM;
        }
        return null;
    }
    function bgStartHandover() {
        if (!nativeBG || bgHandover || !loginOk) return;
        // 阶段二百四十四 P1：不再主动 close 本页面连接（先断后建产生交接真空）。
        // 仅置交接标记 + 通知原生接管：原生登录成功后服务端同端互踢顶掉本连接，
        // onclose 以 bgHandover=true 静默让位（dispatch kick 分支同口径保持登录态）；
        // 弱网下原生接管失败时页面连接保持在线，后台期间消息不丢
        bgHandover = true;
        bgHandoverAt = Date.now();
        try { var bgp = bgPlugin(); if (bgp) bgp.takeOver(); } catch (e) {}
    }
    function bgEndHandover() {
        // 阶段二百二十五：不要求 bgHandover 已置位——JS 被系统瞬间冻结未及走交接流程时
        // （切后台 close/takeOver 均未执行），回前台仍须交还并重连
        if (!nativeBG || !loginOk) return;
        bgHandoverAt = Date.now();
        // 阶段二百五十六补丁：相册/拍摄等独立 Activity 仍在前台（pause 未配对 resume）时，
        // 个别机型/模拟器 visibilitychange 会误报 visible——此刻重连会与原生保活互踢循环
        // （RESYNC_CLEAR 每 4~5s 连发、聊天页持续刷新）。门禁：pause 期间连接归原生所有
        if (bgAppPaused) return;
        if (!connected && currentUsername) {
            // 阶段二百四十四 P1：不再先 handBack 断原生连接（真空窗口元凶）——页面立即重连，
            // 登录成功后服务端同端互踢顶掉原生连接（KeepAliveService 收 kick 静默待命），
            // 登录回执处再补一次 handBack（幂等）。交接态保持至重连登录成功（LOGIN_RESP ok
            // 处解除），期间排迟的 kick/onclose 均按交接口径静默。成功后重拉当前会话历史
            // 阶段二百五十六补丁：missed 并入 pending（LOGIN_RESP 归口消费）
            bgResyncPending = bgResyncPending || bgMissedFrames;
            bgMissedFrames = false;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            connect(currentUsername, window._lastPassword || '');
        } else {
            // 阶段二百四十四 P1：页面连接看似存活——但 WebView 冻结解冻瞬间，后台期被互踢的
            // kick/onclose 可能仍在事件队列排迟未跑（此刻 connected=true 是假象，实测 100%
            // 复现：立即 handBack 后排迟 onclose 才到，连接已断且无人重连 → 卡死/回登录页）。
            // 延迟 300ms 重判：真活 → 解除交接态并交还原生待命（弱网未接管/交接未走成的收尾）；
            // 假死（已断且无人在重连）→ 立即补位重连。排迟 onclose 已自行 scheduleReconnect
            // 时不重复建连
            setTimeout(function () {
                // 重判前又被处置（真实被踢）或已再次切后台（交回新一轮 pause 流程）则不动
                if (!loginOk || bgHoldReconnect()) return;
                if (connected) {
                    bgHandover = false;
                    try { var bgp = bgPlugin(); if (bgp) bgp.handBack(); } catch (e) {}
                    // 阶段二百五十六补丁：连接存活但后台期帧由原生接收——直接消费 missed 派发重拉
                    if (bgMissedFrames) {
                        bgMissedFrames = false;
                        try { window.dispatchEvent(new CustomEvent('im_resync_history')); } catch (e) {}
                    }
                } else if (!reconnectTimer) {
                    bgResyncPending = bgResyncPending || bgMissedFrames;
                    bgMissedFrames = false;
                    connect(currentUsername, window._lastPassword || '');
                }
            }, 300);
        }
    }
    // 阶段二百五十六补丁：APP 级 pause 标记（相册/拍摄等独立 Activity 在前台期间为 true）。
    // 根因（leveldb 取证）：相册打开期间页面与原生保活互踢循环——RESYNC_CLEAR 每 4~5s 连发，
    // 每轮 LOGIN_RESP 触发 resync 构成持续可见刷新。原 bgHoldReconnect 仅看 visibilityState，
    // 部分机型/模拟器上独立 Activity 覆盖时 WebView 不报 hidden，门禁失效。pause/resume 由
    // 原生 ActivityLifecycleCallbacks 驱动，语义可靠，并入重连门禁
    var bgAppPaused = false;
    // 页面隐藏且已登录：连接归原生服务所有，WebView 一律不得重连（防互踢循环）
    function bgHoldReconnect() {
        return nativeBG && loginOk && (document.visibilityState === 'hidden' || bgAppPaused);
    }

    // 阶段二百三十一：桥就绪等待器——LOGIN_RESP 到达时 Capacitor 桥可能尚未注入完成
    // （实测：两次独立会话 LOGIN_RESP 时 bgPlugin() 恒为 false，而更早会话同机制可通——
    // 桥注入走 handleProxyRequest 代理/DocumentStart，就绪时机不受页面控制）。
    // 不能因一次求值 false 就放弃保活拉起：轮询等待桥就绪后补拉 startKeepAlive（幂等），
    // 上限 50 次×200ms=10 秒，超时放弃（原生侧凭据空则本来就忽略）。
    var bgWaitTimer = null;
    var bgStartDone = false;
    function bgDoStart() {
        if (bgStartDone || !loginOk) return false;
        var bgp = bgPlugin();
        if (!bgp) return false;
        bgStartDone = true;
        if (bgWaitTimer) {
            clearInterval(bgWaitTimer);
            bgWaitTimer = null;
        }
        try {
            bgp.startKeepAlive({ username: currentUsername, password: window._lastPassword || '' });
        } catch (e) {
            bgStartDone = false; // 调用异常不锁死，下次轮询可重试
            return false;
        }
        return true;
    }
    function bgWaitStart() {
        if (bgStartDone || bgWaitTimer || !loginOk) return;
        var tries = 0;
        bgWaitTimer = setInterval(function () {
            tries++;
            if (bgDoStart() || tries > 50) {
                clearInterval(bgWaitTimer);
                bgWaitTimer = null;
            }
        }, 200);
    }
    // 登录态失效（服务端拒绝/被踢/登出）时复位等待器——切账号重登需重新拉起，
    // 原生侧以最近一次 startKeepAlive 的凭据为准（旧账号服务被顶掉属预期互踢）
    function bgResetStart() {
        bgStartDone = false;
        if (bgWaitTimer) {
            clearInterval(bgWaitTimer);
            bgWaitTimer = null;
        }
    }

    // 消息类型常量
    var MSG = {
        GROUP_CHAT: 1,
        PRIVATE: 2,
        FILE: 3,
        HEARTBEAT: 4,
        ONLINE: 5,
        USER_LIST: 6,
        LOGIN: 7,
        LOGIN_RESP: 8,
        ERROR: 9,
        HISTORY: 10,
        HISTORY_RESP: 11,
        TYPING: 12,
        READ: 13,
        RECALL: 14,
        DELETE: 15,
        SEARCH: 16,
        SEARCH_RESP: 17,
        CONV_LIST: 18,
        CONV_PIN: 19,
        CONV_CLEAR: 27,
        CONV_DELETE: 28,
        FRIEND_REQUEST: 20,
        FRIEND_REQUEST_RESP: 21,
        FRIEND_LIST: 22,
        FRIEND_DELETE: 23,
        BLACKLIST: 24,
        FRIEND_UPDATE: 25,
        BLACKLIST_LIST: 26,
        MSG_PIN: 29,
        MSG_PIN_SYNC: 30,
        CONV_SEARCH: 31,
        CONV_SEARCH_RESP: 32,
        FILE_PERSISTED: 33,
        GROUP_IMAGE: 34, // 阶段二十六：群聊图片消息广播（HTTP 上传落库后服务端下发，content 为 JSON：url/name/size/nonce）
        GROUP_FILE: 69,  // 阶段一百三十四：群聊文件消息广播（与群图片同链路，content 为 JSON：url/name/size/nonce）
        FRIEND_REQ_LIST: 35,      // 阶段二十九：好友申请列表请求（微信式"新的朋友"归口查询）
        FRIEND_REQ_LIST_RESP: 36, // 阶段二十九：好友申请列表响应（content 为 JSON：list 申请记录 + pending 待处理数量）
        PROFILE_UPDATE: 37, // 阶段三十：个人资料更新（content 为 JSON：nickname/gender/region/signature）
        PROFILE_QUERY: 38,  // 阶段三十：个人资料查询（to_user 为目标用户名，微信式好友资料卡）
        PROFILE_RESP: 39,   // 阶段三十：个人资料响应/同步（content 为 JSON：username/nickname/gender/region/signature/avatar/is_friend/remark）
        FILE_PROGRESS: 40,  // 阶段三十二：超大文件分片直传进度（content 为 JSON：upload_id/nonce/received/total/file_name/file_size，服务端节流推送）
        FILE_CANCEL: 41,    // 阶段三十二：超大文件上传取消（下行 content 为 JSON：upload_id/nonce，双方移除进度气泡）
        AI_AGENTS: 42,      // 阶段四十三：AI 智能体列表请求/响应（content 为 JSON：[{name,avatar,model}]）
        AI_CHAT: 43,        // 阶段四十三：AI 问答提问（to_user=智能体名，服务端归口调用模型）
        AI_STREAM: 44,      // 阶段四十三：AI 流式回复增量（content=增量文本，stream_id 关联同一次回复）
        AI_STREAM_END: 45,  // 阶段四十三：AI 流式回复结束（content=完整回复，msg_id=落库 ID，remark=error 表示失败）
        AGENT_RUN: 46,      // 阶段五十九：Agent 任务发起/取消（上行，content 为 JSON：{goal,agent_name} / {task_id,action:"cancel"}）
        AGENT_EVENT: 47,    // 阶段五十九：Agent 任务事件流（下行，content 为 JSON：{task_id,type,...}）
        AGENT_APPROVE_REQ: 48, // 阶段五十九：Agent 高危工具审批请求（下行，content 为 JSON：{task_id,step,tool,params,reason}）
        AGENT_APPROVE: 49,  // 阶段五十九：Agent 审批结果（上行，content 为 JSON：{task_id,step,action,params?}）
        AGENT_EXEC_REQ: 50, // 阶段六十：Agent 本地执行请求（下行，仅 PC 端处理，content 为 JSON：{task_id,step,tool,params}）
        AGENT_EXEC_RESP: 51, // 阶段六十：Agent 本地执行结果（上行，content 为 JSON：{task_id,step,ok,output}）
        AGENT_SANDBOX: 52, // 阶段六十一：Agent 沙箱白名单上报（上行，仅 PC 端，content 为 JSON：{primary,dirs}）
        AGENT_PC_TOOLS: 67, // 阶段九十：本机 MCP 工具清单上报（上行，仅 PC 端，content 为 JSON：{tools:[{server,tool,description,input_schema}]}；下行确认帧 {ok,count}）
        AI_SUGGEST: 53,    // 阶段六十二：AI 后续提问建议（下行，content 为 JSON 字符串数组，回复完成后浮现）
        AI_SESSION_LIST: 54, // 阶段七十一：AI 多会话列表请求/响应（上行 to_user=智能体名；下行 content 为 JSON：{current_id,sessions}）
        AI_SESSION_NEW: 55,  // 阶段七十一：新建会话（上行 to_user=智能体名；下行 content 为 JSON：{session_id,title}）
        AI_SESSION_DEL: 56,  // 阶段七十一：删除会话（上行 to_user=智能体名 + session_id）
        PURGE_APPLY: 57,     // 阶段七十二：私聊永久删除审批（上行发起 to_user=对方；下行卡片状态 content 为 JSON：{apply_id,from_user,to_user,status}）
        PURGE_RESP: 58,      // 阶段七十二：私聊永久删除审批响应（上行 to_user=发起方，msg_id=apply_id，content=agree/reject）
        AI_STOP: 59,         // 阶段七十三：AI 流式问答停止（上行 to_user=智能体名；发送按钮"停止"态触发）
        AGENT_TOOL_OUTPUT: 60, // 阶段七十五：本地命令输出流上行（PC 渲染进程 → 服务端，content 为 JSON：{task_id,step,chunk,total_bytes,over,final,exit_code,duration_ms}）
        AGENT_BG: 61,        // 阶段七十五：长命令"转后台"（上行前端 → 服务端 {task_id,step}；下行服务端 → PC 渲染层原样转发桥接执行器）
        WS_FILE_REQ: 62,     // 阶段七十六：工作区文件面板请求上行（web 前端 → 服务端，content 为 JSON：{op:"tree"/"read"/"save",req_id,path,content?}）
        WS_FILE_RESP: 63,    // 阶段七十六：工作区文件面板响应下行（服务端 → web 前端，content 为 JSON：{op,req_id,ok,error,root?,entries?/content?,binary?,truncated?}）
        PC_FILE_REQ: 64,     // 阶段七十六：本地文件操作请求下行（服务端 → PC 渲染进程，仅 PC 端处理，content 为 JSON：{op,req_id,path,content?}）
        PC_FILE_RESP: 65,    // 阶段七十六：本地文件操作结果上行（PC 渲染进程 → 服务端，content 为 JSON：{op,req_id,ok,error,root?,entries?/content?,binary?,truncated?}）
        AGENT_CHANGES: 66,   // 阶段七十七：文件变更审查（上行 {task_id,action:"keep"/"revert",path?}；下行全量刷新帧 {task_id,session_id,changes,total_adds,total_dels}）
        AGENT_ASK: 68,       // 阶段一百二十五：Agent 向用户提问的回答上行（TRAE CN 同款，content 为 JSON：{task_id,step,action:"answer"/"skip",answer?}；提问本身经 AGENT_EVENT 下发）
        AGENT_PLAN: 95,      // 阶段一百六十四：计划模式计划审批结果上行（TRAE CN Plan 同款，content 为 JSON：{task_id,step,action:"approve"/"reject",feedback?}；计划本身经 AGENT_EVENT 下发）
        CALL_SIGNAL: 70,     // 阶段一百四十一：音视频通话信令（双向，content 为 JSON：{action,call_id,call_type?,sdp?,candidate?,reason?}；话单由服务端归口落库）
        // 阶段一百四十二：微信同款多群聊信令（新群会话目标编码 to_user='g'+群ID；群内收发复用 1/34/69，仅 to_user 携带群编码）
        GROUP_CREATE: 71,        // 上行：建群（content 为 JSON：{name, members:["u1","u2"]}，成员选自好友）
        GROUP_CREATE_RESP: 72,   // 下行：建群回执（content 为 JSON：{group_id, name, members, create_time}；群信息本体以 73 全量同步归口）
        GROUP_LIST_SYNC: 73,     // 下行：群列表全量同步（content 为 JSON：{groups:[{group_id,name,avatar,owner,member_count,members,create_time}]}；登录+变更推送，前端维护 groupMap）
        GROUP_INVITE: 74,        // 上行：邀请入群（content 为 JSON：{group_id, members:["u2"]}，阶段二百六十五：全员可邀请，邀请人须为群成员）
        GROUP_INVITE_NOTICE: 75, // 下行：群邀请通知（被邀请人收，content 为 JSON：{invite_id, group_id, name, from_user, from_name, member_count}；离线登录补推同帧）
        GROUP_INVITE_RESP: 76,   // 上行：邀请响应（content 为 JSON：{invite_id, accept:true/false}）
        GROUP_MEMBER_NOTICE: 77, // 下行：成员变更通知（content 为 JSON：{group_id, action:"create"/"join"/"reject"/"kick"/"leave"/"transfer"/"dissolve", users, member_count, name}；join 同时作邀请人同意回执，reject 仅邀请人收；kick/leave 为被移出/退群者收，阶段一百四十三；transfer=群主已转让（users=新群主）/dissolve=群聊已解散，阶段二百六十四）
        // ===== 阶段一百四十三：群设置面板信令（数据变更统一以 73 全量同步归口，回执仅作结果提示） =====
        GROUP_SETTING: 78,       // 上行：修改群设置（content 为 JSON：{group_id, name?, announce?}，仅群主）
        GROUP_SETTING_RESP: 79,  // 下行：设置回执（content 为 JSON：{ok, group_id, err?}）
        GROUP_KICK: 80,          // 上行：移出成员（content 为 JSON：{group_id, member:"u2"}，仅群主）
        GROUP_KICK_RESP: 81,     // 下行：踢人回执（content 为 JSON：{ok, group_id, err?}）
        GROUP_QUIT: 82,          // 上行：退出群聊（content 为 JSON：{group_id}，仅普通成员可退）
        GROUP_QUIT_RESP: 83,     // 下行：退群回执（content 为 JSON：{ok, group_id, err?}）
        // ===== 阶段二百六十四：群主转让与解散群聊（微信同款群管理闭环，数据变更统一以 73 全量同步归口） =====
        GROUP_TRANSFER: 98,      // 上行：转让群主（content 为 JSON：{group_id, to:"u2"}，仅群主；目标须为在群成员且非自己）
        GROUP_TRANSFER_RESP: 99, // 下行：转让回执（content 为 JSON：{ok, group_id, err?}；成功后全群收 77 transfer + 73 归位）
        GROUP_DISSOLVE: 100,     // 上行：解散群聊（content 为 JSON：{group_id}，仅群主）
        GROUP_DISSOLVE_RESP: 101,// 下行：解散回执（content 为 JSON：{ok, group_id, err?}；成功后全员收 77 dissolve 清会话）
        GROUP_SET_ROLE: 102,     // 上行：任命/罢免管理员（content 为 JSON：{group_id, member:"u2", admin:true/false}，仅群主；阶段二百六十七）
        GROUP_SET_ROLE_RESP: 103,// 下行：设置回执（content 为 JSON：{ok, group_id, err?}；成功后全群收 77 action=role + 73 刷新）
        ANNOUNCEMENT_PUSH: 84,   // 阶段一百四十四：公告发布实时推送（下行，content 为 JSON：{id,title,category,digest,publisher,publish_time}；客户端亮红点并入公告列表头）
        REGISTER: 85,            // 阶段一四五：独立注册页注册信令（双向同类型，上行注册请求；下行 content="ok" 或错误提示）
        // ===== 阶段一百五十四：积分红包（微信同款，金额计算/拆分/扣减/退回全部服务端归口） =====
        RED_PACKET: 86,          // 红包消息（与普通消息同链路落库转发，content 为 JSON：{rp:{id,type,count,amount,greeting,status}}）
        RED_PACKET_OPEN: 87,     // 双向：上行打开红包 {packet_id}；下行结果按 act 区分（send=发送回执含余额 / open=领取结果含详情 / detail=详情响应）
        RED_PACKET_SYNC: 88,     // 下行：红包状态同步（领取/领完/过期退回后广播，content 为 JSON：{packet_id,status,claimed_count,...,msg_id}；卡片原位刷新）
        RED_PACKET_DETAIL: 89,   // 双向：上行详情查询 {packet_id}；下行领取明细列表（打开红包页/详情页共用数据源）
        REMOTE_SIGNAL: 90,       // 阶段一百五十五：QQ 同款远程协助信令（双向，content 为 JSON：{action,session_id,mode?,grant?,sdp?,candidate?,reason?}；好友强校验，话单由服务端归口落库）
        FILE_P2P_SIGNAL: 91,     // 阶段一百五十六：好友文件 P2P 直传信令（双向，content 为 JSON：{action,transfer_id,name?,size?,mime?,sha256?,reason?,sdp?,candidate?,platform?,nonce?}；服务端仅转发信令+归口判定，文件字节点对点直传）
        DRIVE_SHARE: 92,         // 网盘二期：文件分享卡片（服务端创建分享后投递，content 为 JSON：{share:{id,code,name,is_dir,size,from,has_extract,expire_at}}；点击弹详情保存/下载）
        USER_LIST_DELTA: 93,     // 5万容量改造：在线名单增量同步（下行 content 为 JSON：{online:[{username,avatar}],offline:["u1"]}；全量快照仅登录者单发，此后上下线/头像变更走本帧 1s 窗口聚合广播）
        LOGIN_QUEUE: 94,         // 阶段一百六十一：登录排队位置推送（下行 content 为 JSON：{position 当前第 N 位, wait 预计等待秒}；排到队首后正常收 LOGIN_RESP，排队遮罩由 chat.js 渲染）
        QR_SIGN: 97,             // 阶段二百四十：扫码登录确认信令（上行 {action:"scan"/"confirm"/"cancel", qr_id}；下行同类型回执 {action, ok, reason?, platform?}）
        LOCATION: 104,           // 阶段二百六十八：位置消息（微信同款发送位置，content 为 JSON：{loc:{lat,lng,name,address}}；GCJ-02 坐标，落库转发同红包链路，历史按类型渲染位置气泡）
        LOCATION_SHARE: 105      // 阶段二百六十八：实时位置共享信令（action 模式，纯信令不落库坐标；上行 start/join/leave/update/end，下行 started/joined/state/left/ended/error，房间态服务端内存归口）
    };

    // 阶段二百四十八：连接入口统一锁屏门禁——FSI 来电会把页面在锁屏后面拉起（onNewIntent/
    // resume/visibilitychange 触发"回前台"交接流程），此刻 WebView 随时被系统冻结：页面若
    // 抢线重连（服务端互踢顶掉原生连接），后续 cancel/超时帧无人处理（原生铃声被 handBack
    // 停掉后页内 WebAudio 又无声=「响半下就停」、等待画面残留、二次来电误回 busy 拒绝）。
    // 锁屏中拒绝建连（连接保持归原生服务），解锁后经 bgUnlock 事件重入（bgUnlock 监听见下）
    // 阶段二百五十：锁屏话务豁免窗——用户在锁屏来电页主动点接听/挂断时（chat.js 置
    // window._ringBypassAt）开 10 秒豁免，页面临时抢线完成接听话务动作；其余锁屏场景
    // 仍不抢线（保原生铃声与连接归口）
    function connect(username, password) {
        var bgp = nativeBG ? bgPlugin() : null;
        var bypass = function () { return Date.now() - (window._ringBypassAt || 0) < 10000; };
        if (!bypass() && bgp && bgp.isKeyguardLocked && loginOk && currentUsername) {
            try {
                bgp.isKeyguardLocked().then(function (res) {
                    if (res && res.locked && !bypass()) return; // 锁屏中：不抢线，解锁后 bgUnlock/重入补偿
                    doConnect(username, password);
                }).catch(function () { doConnect(username, password); });
                return;
            } catch (e) { /* 桥异常走同步直连 */ }
        }
        doConnect(username, password);
    }

    function doConnect(username, password) {
        currentUsername = username;
        // 登录失败提示修复：记录本次连接使用的密码，登录成功后断线自动重连需携带真实密码
        // 原实现：window._lastPassword 从未被赋真实值（恒为空字符串），断线重连用空密码登录必然失败
        window._lastPassword = password || '';
        // 阶段二百四十：扫码登录通道标记（content 前缀 qrc: = 一次性登录码免密登录）——
        // LOGIN_RESP 成功后以服务端归口账号校正 currentUsername 并清空 _lastPassword
        // （码已消费，重连不能复用；断线后自动重登失败回落登录页，与微信 PC 扫码会话行为一致）
        qrLoginConn = (password || '').indexOf('qrc:') === 0;
        // 阶段一百二十二：恢复 location 推导（同 origin http 拦截方案下页面 origin 不变，推导依旧有效；
        // 原 app://local 方案曾改用 preload 注入的 desktop.serverOrigin，实测导航稳定性问题后回退）
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var url = proto + location.host + '/ws';

        // 阶段二百三十五修复：connect 防重入——回前台 visibilitychange 与 Capacitor App resume
        // 双通道先后触发 bgEndHandover，两次调用间隔仅几毫秒，首个连接尚未 onopen（connected
        // 仍 false）第二次调用即再建一条同端连接并覆盖 ws 引用 → 服务端同端互踢连环触发
        // （本地 15 轮交接循环 100% 复现：connect#30/#31 成对、open 相差 8ms、服务端连环互踢）
        // 已有连接在建/存活时拒绝重复建连；断线重连场景旧连接已 CLOSED 不受影响
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }
        ws = new WebSocket(url);
        // 阶段二百三十五修复：固化本连接引用——回调触发时与外部 ws 变量比对，
        // 外部已被新连接覆盖（或已置空）即本次回调来自被遗弃的旧连接，一律忽略
        var sock = ws;

        ws.onopen = function () {
            // 阶段二百三十五修复：owner 检查——被覆盖/被踢旧连接的回调事件被 WebView 冻结
            // 延迟数秒补发（实测 close code=1006 迟到 1~7 秒+），若不核对归属，迟到的 open
            // 会重置 connected 并发出第二条登录帧触发互踢
            if (ws !== sock) return;
            connected = true;
            // 发送登录消息（阶段六十：PC 端 Electron preload 暴露 window.desktop，据此上报设备类型，
            // 服务端 Agent 本地执行器按 platform=pc 判定文件/命令工具下发目标；Web/手机端为空走服务端执行）
            // 原代码：platform: window.desktop ? 'pc' : ''
            // 阶段一百四十五：WEB 端浏览器通话桥上线后 window.desktop 同样存在，经 __webCallBridge 标记区分——
            // 浏览器上报 'web'（服务端通话/会议被叫能力改归口 HasCall），Electron PC 端仍报 'pc'，手机端无桥报空
            // 独立分享页阶段：/s/ 分享页上报独立端型 'share'，与主应用（'pc'/'web'/''）跨端共存——
            // 原实现分享页与浏览器主应用同为 '' 端被服务端同端互踢（hub.go platform 相等即踢），
            // 用户开分享链接会把正在使用的主应用踢下线且双方自动重连互相反踢形成循环
            // 阶段一百九十八：手机 APP 端（Capacitor）通话放开后同样注入 window.desktop 通话桥，
            // 须在 desktop 判定前先识别原生环境上报 'app'（hub.HasCall 已纳入；app↔app 同端互踢，与 web/pc 共存）
            var _loginPlatform;
            if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
                _loginPlatform = 'app';
            } else if (location.pathname.indexOf('/s/') === 0) {
                _loginPlatform = 'share';
            } else if (window.desktop && !window.__webCallBridge) {
                _loginPlatform = 'pc';
            } else {
                // 阶段二百二十一修复：纯浏览器 WEB 端原上报 ''（空值在服务端 platformName 归"手机"），
                // 与旧版手机 APP（同报 ''）构成同端互踢——用户 WEB 端登录即把手机踢下线且双方重连反踢
                // 形成循环。现统一上报 'web'：web↔web 互踢、与 app/pc 跨端共存，语义与端型命名一致
                _loginPlatform = 'web';
            }
            send({ msg_type: MSG.LOGIN, from_user: username, content: password, platform: _loginPlatform });
            // 启动心跳
            startHeartbeat();
        };

        ws.onmessage = function (e) {
            // 阶段二百三十五修复：owner 检查——旧连接迟到的消息帧（含 kick ERROR）不得
            // 触发当前连接的登录态处置（实测旧连接 kick 迟到会把 loginOk 误杀回登录页）
            if (ws !== sock) return;
            var msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                return;
            }
            dispatch(msg);
        };

        ws.onclose = function (ev) {
            // 阶段二百三十五修复：owner 检查——本 bug 的核心放大器：被踢旧连接的 close
            // 事件迟到补发时 loginOk 已被后继连接置 true，原逻辑判「网络断开」走
            // scheduleReconnect 再建新连接，把当前在线的后继连接踢下线（本地实测
            // #30迟到close→3s后connect#32→#32踢掉在线的#31→用户回登录页）
            if (ws !== sock) return;
            connected = false;
            stopHeartbeat();
            // 阶段一百三十五：服务端拒绝登录（账号封禁/注销/密码错误等）先下发 ERROR 帧再立即关连接，
            // 1 秒内收到过 ERROR 视为服务端拒绝而非网络断开，置 loginOk=false 阻断自动重连
            // （修复：密码被修改/账号被封禁后重连陷入"拒绝→3 秒重连→拒绝"无限循环）
            // 阶段二百二十五：页面隐藏期（连接归原生服务）的 ERROR+关闭视为交接顶掉，
            // 保持登录态——回前台 bgEndHandover 统一重连，防误回登录界面
            // 阶段二百四十四 P1：交接期标记（bgHandover）与原生环境 8 秒交接活动窗口同口径
            // 保护——WebView 冻结把被互踢的 kick ERROR 排迟到回前台之后，此刻可见态
            // bgHoldReconnect 判 false，无保护会误置 loginOk=false 回登录页（实测 100% 复现）
            if (Date.now() - lastRejectAt < 1000 && !bgHoldReconnect()
                && !bgHandover && !(nativeBG && Date.now() - bgHandoverAt < 8000)) {
                loginOk = false;
                bgResetStart();
            }
            // 阶段二百五十六：交接型断开（kick ERROR 帧丢失/排迟未到而 close 先到时按同口径判定）
            // 置 missed 标记——后台期消息与控制帧由原生连接接收，WebView 未渲染，
            // 回前台统一消费派发重拉（与 dispatch kick 分支同口径，选图浮层期间零刷新）
            if (loginOk && (bgHandover || bgHoldReconnect()
                || (nativeBG && Date.now() - bgHandoverAt < 8000))) {
                bgMissedFrames = true;
            }
            // 登录失败提示修复：仅登录成功后才自动重连。
            // 登录失败（密码错误等）服务端会下发错误提示并关闭连接，原实现无条件重连会陷入
            // "失败→3秒重连→失败"无限循环且每次都无提示，页面表现为点击登录后毫无反应
            // 阶段二百四十四 P1：重连条件收敛为「页面可见即可重连」——隐藏期（连接归原生
            // 服务）一律不得重连防互踢循环；交接期可见场景（回前台后排迟 kick 关闭连接）
            // 必须重连补位，原 !bgHandover 条件会在此场景既不重连也不派发事件 → 静默卡死
            if (loginOk && !bgHoldReconnect()) {
                scheduleReconnect();
            } else if (!loginOk) {
                // 登录持久化：未登录成功即断开（服务端未启动/密码错误被拒），
                // 派发连接失败事件，供乐观显示的聊天界面回退到登录界面。
                // 阶段二百四十一修复：交接型断开（bgHandover 切后台主动 close /
                // bgHoldReconnect 页面隐藏期被自家原生接管顶掉）loginOk 仍为 true，
                // 原实现 else 无条件派发 im_connect_failed → chat.js 把聊天界面切
                // 成登录界面 → 切后台瞬间/回前台/打开文件选择器（Activity 离开前台
                // 均触发 visibilitychange 交接）闪现登录页；交接期登录态保持，
                // 回前台由 bgEndHandover 统一重连恢复，不应回退登录页
                try { window.dispatchEvent(new CustomEvent('im_connect_failed')); } catch (e) {}
            }
        };

        ws.onerror = function () {
            if (ws !== sock) return;
            connected = false;
        };
    }

    function send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
            return true;
        }
        return false;
    }

    // 阶段一四五：独立注册通道（注册页专用短连接，与主聊天 connect 全程隔离）
    // 建连后发送 REGISTER 信令（from_user=用户名，content=密码），
    // 服务端回执 content="ok" 或错误提示文本后即关闭连接；onResult(ok, text) 回调必达
    function register(username, password, onResult) {
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var url = proto + location.host + '/ws';
        var regWs = new WebSocket(url);
        var settled = false;
        var done = function (ok, text) {
            if (settled) return;
            settled = true;
            try { regWs.close(); } catch (e) {}
            if (typeof onResult === 'function') onResult(ok, text || '');
        };
        regWs.onopen = function () {
            regWs.send(JSON.stringify({
                msg_type: MSG.REGISTER,
                from_user: username,
                content: password
            }));
        };
        regWs.onmessage = function (e) {
            var msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            if (msg.msg_type !== MSG.REGISTER && msg.msg_type !== MSG.ERROR) return;
            done(msg.content === 'ok', msg.content !== 'ok' ? msg.content : '注册成功');
        };
        regWs.onclose = function () {
            // 服务端拒绝注册时先发错误帧再关连接，onmessage 已回执；
            // 未收到任何帧即断开视为网络/服务异常
            done(false, '注册服务连接异常，请稍后重试');
        };
        regWs.onerror = function () {
            done(false, '注册服务连接异常，请稍后重试');
        };
    }

    // ===== 阶段一百四十九：心跳改由 Web Worker 定时驱动（后台标签保活） =====
    // 原代码：主线程 setInterval 30s 心跳。Chrome 对隐藏约 5 分钟后的标签页启用密集节流
    //（intensive throttling），定时器被强制合并到约 1 分钟一次——心跳实际间隔被拉长到与
    // CDN WS 空闲超时（60s）压线，稍有抖动即超：CDN 掐 WS → 服务端广播下线 → 被节流的重连
    // 约 1 分钟后才完成 → 广播上线，好友侧即看到账号反复"下线/上线"（账号实际从未退出登录）。
    // Worker 内定时器不受页面可见性节流影响，后台/最小化标签心跳依旧稳定 30s
    //
    // ===== 阶段二百四十五：CDN 空闲超时收紧（60s→30s），心跳同步加密至 15s =====
    // 实测复现（node 二分扫描）：CDN 侧 WS 空闲超时已从 60s 收紧至 30s（帧流动间隔 ≥30s 即在
    // 发出下一帧的瞬间收到 1006 异常断连），原 30s 心跳与阈值零裕度压线，网络抖动 0.3s 即触发：
    // CDN 静默掐连接 → 页面半开不知情 → 点红包（89 上行发往死连接）等 20s+ → 点「開」（87 同理）
    // 8s 兜底报「网络异常」→ 重连后队列补发 87 反而领取成功 → 详情显示已领取（用户截图现象 100%
    // 吻合）。心跳加密至 15s（2 倍裕度），Worker 与降级定时器同步修改
    var heartbeatWorker = null;
    function startHeartbeat() {
        stopHeartbeat();
        try {
            var code = 'var t=null;onmessage=function(e){' +
                'if(e.data==="start"){if(!t)t=setInterval(function(){postMessage("tick")},15000)}' +
                'else if(e.data==="stop"){if(t){clearInterval(t);t=null}}};';
            heartbeatWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
            heartbeatWorker.onmessage = function () { send({ msg_type: MSG.HEARTBEAT }); };
            heartbeatWorker.postMessage('start');
            return;
        } catch (e) { }
        // Worker 创建失败（file:// 等受限环境）：降级主线程定时器（后台节流风险回到原状，前台使用不受影响）
        heartbeatTimer = setInterval(function () {
            send({ msg_type: MSG.HEARTBEAT });
        }, 15000); // 15s 心跳（CDN 空闲超时 30s，2 倍裕度）
    }

    function stopHeartbeat() {
        if (heartbeatWorker) {
            try { heartbeatWorker.postMessage('stop'); heartbeatWorker.terminate(); } catch (e) { }
            heartbeatWorker = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            // 阶段二百二十一：补 loginOk 判定——被踢/登录被拒置 loginOk=false 后，
            // 此前已排队的重连定时器不得再触发（原判定仅 connected/username，
            // 存在"处置后挂起定时器仍重连"的竞态漏洞）
            // 阶段二百四十四 P1：触发判定同步收敛为「页面可见即可重连」——交接期（bgHandover）
            // 页面可见场景（回前台排迟 kick 触发的重连）到达触发时刻时须放行；仅页面隐藏期
            // （连接归原生服务）阻断，防后台 WebView 与原生服务互踢循环
            if (!connected && currentUsername && loginOk && !bgHoldReconnect()) {
                connect(currentUsername, window._lastPassword || '');
            }
        }, 3000); // 3s 后重连
    }

    // 阶段一百四十九：回前台立即恢复防线——后台节流期间若 WS 已被掐断，回到页面瞬间
    // 立即补发心跳/触发重连（不等被节流拉长的重连定时器），缩短"回到页面仍显示离线"的窗口
    // 阶段二百二十五：手机 APP 端改造为连接交接归口——切后台/息屏（hidden/pause）主动断开
    // 并由原生前台服务接管；回前台（visible/resume）原生交还并立即重连。WEB/PC 端保持原逻辑。
    document.addEventListener('visibilitychange', function () {
        if (nativeBG) {
            if (!loginOk) return;
            if (document.visibilityState === 'hidden') {
                bgStartHandover();
            } else {
                bgEndHandover();
            }
            return;
        }
        if (document.visibilityState !== 'visible' || !loginOk) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            send({ msg_type: MSG.HEARTBEAT });
        } else if (!connected) {
            scheduleReconnect();
        }
    });
    // 阶段二百二十五：Capacitor App 插件 pause/resume 兜底（与 visibilitychange 同语义，
    // 双通道幂等——JS 被冻结前监听器仍在原生事件桥上，保证交接不丢）
    if (nativeBG && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        try {
            window.Capacitor.Plugins.App.addListener('pause', function () {
                // 阶段二百五十六补丁：APP 级 pause 置位（相册/拍摄独立 Activity 前台期间
                // 连接归原生所有，页面不得重连防互踢循环）
                bgAppPaused = true;
                if (loginOk) bgStartHandover();
            });
            window.Capacitor.Plugins.App.addListener('resume', function () {
                bgAppPaused = false;
                if (loginOk) bgEndHandover();
            });
        } catch (e) {}
    }
    // 阶段二百四十八：解锁重入——FSI 拉起的页面停在锁屏后时，visibilityState 可能保持
    // 'visible' 不再变化（门禁跳过的重连无人重推），用户解锁后由原生 USER_PRESENT 广播
    // 经插件事件驱动重入交接（重连登录 → 互踢顶掉原生 → handBack，页面接管）
    if (nativeBG && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundIM
            && window.Capacitor.Plugins.BackgroundIM.addListener) {
        try {
            window.Capacitor.Plugins.BackgroundIM.addListener('bgUnlock', function () {
                if (loginOk && !connected) bgEndHandover();
            });
        } catch (e) {}
    }

    function dispatch(msg) {
        // 阶段一百三十五：记录 ERROR 帧到达时间（登录拒绝/踢出先发 ERROR 再关连接，
        // onclose 据此判定为服务端拒绝而非网络断开，阻断自动重连防循环）
        if (msg.msg_type === MSG.ERROR) {
            lastRejectAt = Date.now();
            // 阶段二百二十一：断连型踢出立即终止自动重连——服务端 SendErrorAndClose（同端互踢/
            // 封禁踢出/登录拒绝）下发的 ERROR 帧带 kick 标记（普通操作提示 sendError 不带）。
            // 原实现仅靠 onclose 时 1 秒窗口（lastRejectAt）判定，移动网络/公网下连接关闭事件
            // 迟到超 1 秒即误判"网络断开"→ 3 秒自动重连 → 把新登录端反踢下线 → 双方互踢循环
            // （服务端日志表现为每 3 秒一次"同端互踢"）。已登录态收到 kick 即刻处置，不等 onclose
            if (msg.kick) {
                // 阶段二百四十四 P1：交接型 kick 三态静默（静默即整体 return，ERROR 不再
                // 分发业务层——chat.js 会 toast「账号在其他地方登录」打断交接无感体验）：
                //   1. bgHoldReconnect：页面隐藏期被自家原生接管登录顶掉（预期交接）；
                //   2. bgHandover：交接期显式标记（切后台起至重连登录成功止全程）；
                //   3. 原生环境 8 秒交接活动窗口：WebView 冻结把 kick 帧排迟到回前台之后，
                //      此刻可见态 bgHoldReconnect 判 false、bgHandover 可能已被清除——以
                //      最近交接动作时刻兜底识别。实测切后台→回前台 100% 复现误回登录页
                // （LOGIN_RESP ok 处会清零 bgHandoverAt：本端重新登录落地后任何 kick 必是
                //   真实异端互踢，8 秒窗口不再吞并，须正常处置防重连循环）
                if (bgHoldReconnect() || bgHandover
                    || (nativeBG && Date.now() - bgHandoverAt < 8000)) {
                    // 阶段二百五十六：交接期被自家原生顶掉=后台期消息由原生连接接收、WebView 未渲染
                    // （含 57 审批终态等仅在线推送的控制帧），回前台须重拉历史归位视图。
                    // 补丁：仅置 missed 标记（回前台统一消费），不在此置 pending——相册/拍摄等半透明
                    // 浮层场景页面仍可见，补位重连登录成功即派发 resync 会造成选图期间聊天页可见刷新
                    bgMissedFrames = true;
                    return;
                }
                loginOk = false;
                bgResetStart();
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                // 阶段二百三十四修复：被踢=本端登录态已失效——停掉原生前台服务并清除凭据。
                // 原实现只阻断 WebView 自动重连，KeepAliveService 仍持有旧凭据：被踢设备
                // 息屏/切后台时原生服务照旧 TAKEOVER 自动登录「抢线」，把当前在线设备踢下线，
                // 双端各持凭据互相顶掉形成循环（真机+模拟器同账号两端互踢实测复现）。
                // 交接期被顶（自家原生接管）走上方三态静默分支不受影响；
                // 用户重新登录成功后 startKeepAlive 会重写凭据，正常使用无感
                try { var bgpKicked = bgPlugin(); if (bgpKicked) bgpKicked.stopKeepAlive(); } catch (e) {}
            }
        }
        if (msg.msg_type === MSG.LOGIN_RESP) {
            // 登录失败提示修复：记录登录成功标记（新格式 content 为 JSON result='ok'，旧格式 content 为 'ok' 字符串），
            // 登录成功前连接断开不自动重连
            if (msg.content === 'ok') {
                loginOk = true;
            }
            // 登录响应携带服务端撤回时间窗口（recall_window 秒），供撤回菜单判断使用
            // 兼容旧格式：content 为 "ok" 字符串时保持默认 120 秒
            try {
                var info = JSON.parse(msg.content);
                if (info && info.result === 'ok') {
                    loginOk = true;
                }
                // 账号归口（扫码 + 密码登录统一）：服务端 hub 以 DB 规范用户名注册（server.go: c.username = user.Username），
                // MySQL 排序规则大小写不敏感——登录输入 PLB1 也能命中 plb1 账号：登录成功但本地 currentUsername
                // 仍为输入原样，后续所有 HTTP username= 参数（上传直传/网盘/远程控制，均走 getUsername()）
                // 在 hub 查无此名 → 401「用户未在线，请先登录」。登录回执恒携带归口账号名，此处统一校正；
                // 登录码一次性已消费：仅扫码登录清空重连密码，断线重连失败自然回落登录页重新扫码或输密码
                if (loginOk && info && info.username) {
                    currentUsername = info.username;
                    if (qrLoginConn) {
                        window._lastPassword = '';
                    }
                }
                if (info && info.recall_window > 0) {
                    recallWindow = info.recall_window;
                }
                // 阶段一百九十八：接收网盘 API 鉴权 token（登录签发、Redis 会话、连接断开即吊销）；
                // drive.js 网盘请求头归口注入。无 token/旧服务端走兼容路径，敏感字段（提取码）不回传
                if (info && info.drive_token) {
                    try { localStorage.setItem('drive_token', info.drive_token); } catch (err) {}
                }
                // 阶段一百三十八：接收服务端计费模式（usage 按量 / percall 按次 TRAE CN 同款）与按次单价——
                // 标题栏 ⚡ 积分悬停提示按模式显示对应扣费口径；归口 chat.js 的 window.applyTitlebarBillingTip
                if (info && info.billing_mode && typeof window.applyTitlebarBillingTip === 'function') {
                    window.applyTitlebarBillingTip(info.billing_mode, info.percall_cost);
                }
                // 阶段二百六十八：接收高德地图 JS API Key 与安全密钥（位置消息/实时位置共享数据源；
                // 均空=管理员未配置，位置入口隐藏）。Key 与密钥仅内存保存，刷新页面后随下次登录响应刷新
                if (info && info.amap_key) {
                    window._amapKey = info.amap_key;
                    window._amapSecurity = info.amap_security || '';
                    // Web 服务类型 Key：位置气泡静态地图缩略图 REST 专用（平台校验与 JS API Key 不互通），空回退 _amapKey
                    window._amapWebKey = info.amap_web_key || info.amap_key;
                } else {
                    window._amapKey = '';
                    window._amapSecurity = '';
                    window._amapWebKey = '';
                }
                // 阶段三十一：接收服务端下发的分片大小与大文件直传阈值（服务端归口）
                if (info && info.chunk_size > 0) {
                    chunkSize = info.chunk_size;
                }
                if (info && info.upload_threshold > 0) {
                    uploadThreshold = info.upload_threshold;
                }
                // 阶段三十二：接收分片直传配置（服务端归口）
                if (info && info.max_file_size > 0) {
                    maxFileSize = info.max_file_size;
                }
                if (info && info.upload_chunk_size > 0) {
                    uploadChunkSize = info.upload_chunk_size;
                }
                if (info && info.max_direct_size > 0) {
                    maxDirectSize = info.max_direct_size;
                }
                // 阶段一百五十七：接收群聊文件大小上限（服务端归口，群文件独立于私聊 max_file_size）
                if (info && info.group_file_max_size > 0) {
                    groupFileMaxSize = info.group_file_max_size;
                }
                // 阶段一百六十：接收文件保留天数（服务端归口；负数=永不清理，前端仅对 >0 做过期标记）
                if (info && typeof info.file_retention_days === 'number') {
                    fileRetentionDays = info.file_retention_days;
                }
                // 阶段一百五十六：接收文件直传决策参数（服务端归口，客户端零硬编码）并注入 P2P 引擎
                if (info && info.file_p2p_threshold > 0) p2pCfg.threshold = info.file_p2p_threshold;
                if (info && info.file_p2p_negotiate_timeout > 0) p2pCfg.negotiateTimeout = info.file_p2p_negotiate_timeout;
                if (info && info.file_p2p_chunk_size > 0) p2pCfg.chunkSize = info.file_p2p_chunk_size;
                if (info && info.file_p2p_high_water > 0) p2pCfg.highWater = info.file_p2p_high_water;
                if (info && info.file_p2p_low_water > 0) p2pCfg.lowWater = info.file_p2p_low_water;
                if (info) {
                    p2pCfg.enabled = !!info.file_p2p_enabled;
                    p2pCfg.archive = !!info.file_p2p_archive;
                }
                if (window.P2PFile && window.P2PFile.config) window.P2PFile.config(p2pCfg);
            } catch (e) {}
            // 阶段二百二十五：登录成功后启动原生前台服务（保存凭据+拉起服务，幂等）；
            // 回前台交接重连成功后派发历史补拉事件（后台期消息由原生连接接收，WebView 未渲染）
            // 阶段二百三十一：登录成功即尝试拉起保活；桥未就绪时由等待器轮询补拉——
            // 实测桥注入（handleProxyRequest 代理/DocumentStart）就绪时机不受页面控制，
            // LOGIN_RESP 到达时 bgPlugin() 可为 false，不能就此放弃保活
            if (loginOk) {
                // 阶段二百四十四 P1：重连登录成功=交接期结束——解除交接静默标记并清零交接
                // 活动窗口。本端已重新登录落地，此后任何 kick 必是真实异端互踢，8 秒窗口不再
                // 吞并（否则交接后 8 秒内被他端同端踢下线会被静默吞掉，陷入 3 秒重连循环）
                bgHandover = false;
                bgHandoverAt = 0;
                try { if (!bgDoStart()) bgWaitStart(); } catch (e) {}
                // 阶段二百四十四 P1 双保险：回前台重连登录成功时服务端同端互踢已顶掉原生连接
                // （KeepAliveService 收 kick 自行静默待命），此处再补一次 handBack（幂等）——
                // 覆盖原生 kick 帧迟到/丢失的边界让服务确定进入待命态，并顺手撤下后台期来电通知
                try { var bgpHB = bgPlugin(); if (bgpHB) bgpHB.handBack(); } catch (e) {}
                if (bgResyncPending) {
                    bgResyncPending = false;
                    try { window.dispatchEvent(new CustomEvent('im_resync_history')); } catch (e) {}
                }
            }
            window._lastPassword = window._lastPassword || '';
        }
        // 阶段一百五十六：文件直传信令分流到 P2P 引擎（协商/数据面处理；
        // 气泡 UI 由 chat.js 自行注册 91 处理器，两侧职责解耦）
        if (msg.msg_type === 91 && window.P2PFile && window.P2PFile.onSignal) {
            window.P2PFile.onSignal(msg);
        }
        var handlers = messageHandlers[msg.msg_type];
        if (handlers) {
            handlers.forEach(function (h) { h(msg); });
        }
    }

    function on(msgType, handler) {
        if (!messageHandlers[msgType]) {
            messageHandlers[msgType] = [];
        }
        messageHandlers[msgType].push(handler);
    }

    function isConnected() {
        return connected;
    }

    // 阶段二百四十三：发送类调用在「交接重连窗口」的兜底——APP 端拉起系统相册/文件选择器、
    // 息屏、切后台均触发 pause 交接，阶段二百四十四 P1 后交接已无真空（页面连接不被主动断开、
    // 回前台立即重连互踢原生），但弱网下原生已接管顶掉页面连接时，返回页面仍需 1~3 秒重连，
    // 此刻 IMSocket.send 返回 false 静默丢失（红包领取/图片发送均踩过此窗口）。
    // whenReady 供发送入口等待连接就绪后再走原链路。
    // isConnected=true 即可发——onopen 同步先发 LOGIN 帧，WS 帧序保证后续业务帧
    // 必然在服务端登录处理之后执行，无需额外等待登录回执
    function whenReady(fn, timeoutMs) {
        if (isConnected()) { fn(true); return; }
        var waited = 0;
        var step = 150;
        var budget = (timeoutMs && timeoutMs > 0) ? timeoutMs : 10000;
        var timer = setInterval(function () {
            waited += step;
            if (isConnected()) {
                clearInterval(timer);
                fn(true);
            } else if (waited >= budget) {
                clearInterval(timer);
                fn(false);
            }
        }, step);
    }

    function getUsername() {
        return currentUsername;
    }

    // 获取服务端下发的撤回时间窗口（秒），供消息菜单撤回项显隐判断
    function getRecallWindow() {
        return recallWindow;
    }

    // 阶段三十一：获取服务端下发的文件分片大小（字节），分片发送逻辑与服务端配置保持一致
    function getChunkSize() {
        return chunkSize;
    }

    // 阶段三十一：获取服务端下发的大文件直传阈值（字节），超过该值的文件走 HTTP 直传
    function getUploadThreshold() {
        return uploadThreshold;
    }

    // 阶段三十一：获取底层 WebSocket 发送缓冲积压字节数（背压限速依据，防分片瞬间挤爆链路）
    function getBufferedAmount() {
        return ws ? ws.bufferedAmount : 0;
    }

    // 阶段三十二：获取服务端下发的单请求直传上限（字节），超过走分片直传
    function getMaxFileSize() {
        return maxFileSize;
    }

    // 阶段三十二：获取服务端下发的分片直传单片大小（字节）
    function getUploadChunkSize() {
        return uploadChunkSize;
    }

    // 阶段三十二：获取服务端下发的分片直传文件大小上限（字节），超过直接拒绝发送
    function getMaxDirectSize() {
        return maxDirectSize;
    }

    // 阶段一百五十七：获取服务端下发的群聊文件大小上限（字节），sendGroupFile 发送前校验用
    function getGroupFileMaxSize() {
        return groupFileMaxSize;
    }

    // 阶段一百六十：获取服务端下发的文件保留天数（前端历史渲染过期标记用；负数=永不清理）
    function getFileRetentionDays() {
        return fileRetentionDays;
    }

    // 阶段一百五十六：获取文件直传决策参数（服务端归口下发，chat.js 分流判定用）
    function getP2PConfig() {
        return p2pCfg;
    }

    window.IMSocket = {
        MSG: MSG,
        connect: connect,
        register: register,
        send: send,
        on: on,
        isConnected: isConnected,
        whenReady: whenReady,
        getUsername: getUsername,
        getRecallWindow: getRecallWindow,
        getChunkSize: getChunkSize,
        getUploadThreshold: getUploadThreshold,
        getBufferedAmount: getBufferedAmount,
        getMaxFileSize: getMaxFileSize,
        getUploadChunkSize: getUploadChunkSize,
        getMaxDirectSize: getMaxDirectSize,
        getGroupFileMaxSize: getGroupFileMaxSize,
        getFileRetentionDays: getFileRetentionDays,
        getP2PConfig: getP2PConfig,
        stopHeartbeat: stopHeartbeat
    };
})();
