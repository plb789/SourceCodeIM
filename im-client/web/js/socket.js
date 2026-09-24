// socket.js - WebSocket 连接管理、心跳、重连、消息分发
(function () {
    var ws = null;
    var heartbeatTimer = null;
    var reconnectTimer = null;
    var currentUsername = '';
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
        CALL_SIGNAL: 70,     // 阶段一百四十一：音视频通话信令（双向，content 为 JSON：{action,call_id,call_type?,sdp?,candidate?,reason?}；话单由服务端归口落库）
        // 阶段一百四十二：微信同款多群聊信令（新群会话目标编码 to_user='g'+群ID；群内收发复用 1/34/69，仅 to_user 携带群编码）
        GROUP_CREATE: 71,        // 上行：建群（content 为 JSON：{name, members:["u1","u2"]}，成员选自好友）
        GROUP_CREATE_RESP: 72,   // 下行：建群回执（content 为 JSON：{group_id, name, members, create_time}；群信息本体以 73 全量同步归口）
        GROUP_LIST_SYNC: 73,     // 下行：群列表全量同步（content 为 JSON：{groups:[{group_id,name,avatar,owner,member_count,members,create_time}]}；登录+变更推送，前端维护 groupMap）
        GROUP_INVITE: 74,        // 上行：邀请入群（content 为 JSON：{group_id, members:["u2"]}，仅群主可邀请）
        GROUP_INVITE_NOTICE: 75, // 下行：群邀请通知（被邀请人收，content 为 JSON：{invite_id, group_id, name, from_user, from_name, member_count}；离线登录补推同帧）
        GROUP_INVITE_RESP: 76,   // 上行：邀请响应（content 为 JSON：{invite_id, accept:true/false}）
        GROUP_MEMBER_NOTICE: 77, // 下行：成员变更通知（content 为 JSON：{group_id, action:"create"/"join"/"reject"/"kick"/"leave", users, member_count, name}；join 同时作邀请人同意回执，reject 仅邀请人收；kick/leave 为被移出/退群者收，阶段一百四十三）
        // ===== 阶段一百四十三：群设置面板信令（数据变更统一以 73 全量同步归口，回执仅作结果提示） =====
        GROUP_SETTING: 78,       // 上行：修改群设置（content 为 JSON：{group_id, name?, announce?}，仅群主）
        GROUP_SETTING_RESP: 79,  // 下行：设置回执（content 为 JSON：{ok, group_id, err?}）
        GROUP_KICK: 80,          // 上行：移出成员（content 为 JSON：{group_id, member:"u2"}，仅群主）
        GROUP_KICK_RESP: 81,     // 下行：踢人回执（content 为 JSON：{ok, group_id, err?}）
        GROUP_QUIT: 82,          // 上行：退出群聊（content 为 JSON：{group_id}，仅普通成员可退）
        GROUP_QUIT_RESP: 83,     // 下行：退群回执（content 为 JSON：{ok, group_id, err?}）
        ANNOUNCEMENT_PUSH: 84,   // 阶段一百四十四：公告发布实时推送（下行，content 为 JSON：{id,title,category,digest,publisher,publish_time}；客户端亮红点并入公告列表头）
        REGISTER: 85,            // 阶段一四五：独立注册页注册信令（双向同类型，上行注册请求；下行 content="ok" 或错误提示）
        // ===== 阶段一百五十四：积分红包（微信同款，金额计算/拆分/扣减/退回全部服务端归口） =====
        RED_PACKET: 86,          // 红包消息（与普通消息同链路落库转发，content 为 JSON：{rp:{id,type,count,amount,greeting,status}}）
        RED_PACKET_OPEN: 87,     // 双向：上行打开红包 {packet_id}；下行结果按 act 区分（send=发送回执含余额 / open=领取结果含详情 / detail=详情响应）
        RED_PACKET_SYNC: 88,     // 下行：红包状态同步（领取/领完/过期退回后广播，content 为 JSON：{packet_id,status,claimed_count,...,msg_id}；卡片原位刷新）
        RED_PACKET_DETAIL: 89,   // 双向：上行详情查询 {packet_id}；下行领取明细列表（打开红包页/详情页共用数据源）
        REMOTE_SIGNAL: 90,       // 阶段一百五十五：QQ 同款远程协助信令（双向，content 为 JSON：{action,session_id,mode?,grant?,sdp?,candidate?,reason?}；好友强校验，话单由服务端归口落库）
        FILE_P2P_SIGNAL: 91,     // 阶段一百五十六：好友文件 P2P 直传信令（双向，content 为 JSON：{action,transfer_id,name?,size?,mime?,sha256?,reason?,sdp?,candidate?,platform?,nonce?}；服务端仅转发信令+归口判定，文件字节点对点直传）
        DRIVE_SHARE: 92          // 网盘二期：文件分享卡片（服务端创建分享后投递，content 为 JSON：{share:{id,code,name,is_dir,size,from,has_extract,expire_at}}；点击弹详情保存/下载）
    };

    function connect(username, password) {
        currentUsername = username;
        // 登录失败提示修复：记录本次连接使用的密码，登录成功后断线自动重连需携带真实密码
        // 原实现：window._lastPassword 从未被赋真实值（恒为空字符串），断线重连用空密码登录必然失败
        window._lastPassword = password || '';
        // 阶段一百二十二：恢复 location 推导（同 origin http 拦截方案下页面 origin 不变，推导依旧有效；
        // 原 app://local 方案曾改用 preload 注入的 desktop.serverOrigin，实测导航稳定性问题后回退）
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var url = proto + location.host + '/ws';

        ws = new WebSocket(url);

        ws.onopen = function () {
            connected = true;
            // 发送登录消息（阶段六十：PC 端 Electron preload 暴露 window.desktop，据此上报设备类型，
            // 服务端 Agent 本地执行器按 platform=pc 判定文件/命令工具下发目标；Web/手机端为空走服务端执行）
            // 原代码：platform: window.desktop ? 'pc' : ''
            // 阶段一百四十五：WEB 端浏览器通话桥上线后 window.desktop 同样存在，经 __webCallBridge 标记区分——
            // 浏览器上报 'web'（服务端通话/会议被叫能力改归口 HasCall），Electron PC 端仍报 'pc'，手机端无桥报空
            // 独立分享页阶段：/s/ 分享页上报独立端型 'share'，与主应用（'pc'/'web'/''）跨端共存——
            // 原实现分享页与浏览器主应用同为 '' 端被服务端同端互踢（hub.go platform 相等即踢），
            // 用户开分享链接会把正在使用的主应用踢下线且双方自动重连互相反踢形成循环
            var _loginPlatform = window.desktop ? (window.__webCallBridge ? 'web' : 'pc')
                : (location.pathname.indexOf('/s/') === 0 ? 'share' : '');
            send({ msg_type: MSG.LOGIN, from_user: username, content: password, platform: _loginPlatform });
            // 启动心跳
            startHeartbeat();
        };

        ws.onmessage = function (e) {
            var msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                return;
            }
            dispatch(msg);
        };

        ws.onclose = function () {
            connected = false;
            stopHeartbeat();
            // 阶段一百三十五：服务端拒绝登录（账号封禁/注销/密码错误等）先下发 ERROR 帧再立即关连接，
            // 1 秒内收到过 ERROR 视为服务端拒绝而非网络断开，置 loginOk=false 阻断自动重连
            // （修复：密码被修改/账号被封禁后重连陷入"拒绝→3 秒重连→拒绝"无限循环）
            if (Date.now() - lastRejectAt < 1000) {
                loginOk = false;
            }
            // 登录失败提示修复：仅登录成功后才自动重连。
            // 登录失败（密码错误等）服务端会下发错误提示并关闭连接，原实现无条件重连会陷入
            // "失败→3秒重连→失败"无限循环且每次都无提示，页面表现为点击登录后毫无反应
            if (loginOk) {
                scheduleReconnect();
            } else {
                // 登录持久化：未登录成功即断开（服务端未启动/密码错误被拒），
                // 派发连接失败事件，供乐观显示的聊天界面回退到登录界面
                try { window.dispatchEvent(new CustomEvent('im_connect_failed')); } catch (e) {}
            }
        };

        ws.onerror = function () {
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
    var heartbeatWorker = null;
    function startHeartbeat() {
        stopHeartbeat();
        try {
            var code = 'var t=null;onmessage=function(e){' +
                'if(e.data==="start"){if(!t)t=setInterval(function(){postMessage("tick")},30000)}' +
                'else if(e.data==="stop"){if(t){clearInterval(t);t=null}}};';
            heartbeatWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
            heartbeatWorker.onmessage = function () { send({ msg_type: MSG.HEARTBEAT }); };
            heartbeatWorker.postMessage('start');
            return;
        } catch (e) { }
        // Worker 创建失败（file:// 等受限环境）：降级主线程定时器（后台节流风险回到原状，前台使用不受影响）
        heartbeatTimer = setInterval(function () {
            send({ msg_type: MSG.HEARTBEAT });
        }, 30000); // 30s 心跳
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
            if (!connected && currentUsername) {
                connect(currentUsername, window._lastPassword || '');
            }
        }, 3000); // 3s 后重连
    }

    // 阶段一百四十九：回前台立即恢复防线——后台节流期间若 WS 已被掐断，回到页面瞬间
    // 立即补发心跳/触发重连（不等被节流拉长的重连定时器），缩短"回到页面仍显示离线"的窗口
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible' || !loginOk) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            send({ msg_type: MSG.HEARTBEAT });
        } else if (!connected) {
            scheduleReconnect();
        }
    });

    function dispatch(msg) {
        // 阶段一百三十五：记录 ERROR 帧到达时间（登录拒绝/踢出先发 ERROR 再关连接，
        // onclose 据此判定为服务端拒绝而非网络断开，阻断自动重连防循环）
        if (msg.msg_type === MSG.ERROR) {
            lastRejectAt = Date.now();
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
                if (info && info.recall_window > 0) {
                    recallWindow = info.recall_window;
                }
                // 阶段一百三十八：接收服务端计费模式（usage 按量 / percall 按次 TRAE CN 同款）与按次单价——
                // 标题栏 ⚡ 积分悬停提示按模式显示对应扣费口径；归口 chat.js 的 window.applyTitlebarBillingTip
                if (info && info.billing_mode && typeof window.applyTitlebarBillingTip === 'function') {
                    window.applyTitlebarBillingTip(info.billing_mode, info.percall_cost);
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
