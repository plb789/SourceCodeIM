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
    var messageHandlers = {}; // msg_type -> handler 函数数组
    var connected = false;

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
        FRIEND_REQ_LIST: 35,      // 阶段二十九：好友申请列表请求（微信式"新的朋友"归口查询）
        FRIEND_REQ_LIST_RESP: 36, // 阶段二十九：好友申请列表响应（content 为 JSON：list 申请记录 + pending 待处理数量）
        PROFILE_UPDATE: 37, // 阶段三十：个人资料更新（content 为 JSON：nickname/gender/region/signature）
        PROFILE_QUERY: 38,  // 阶段三十：个人资料查询（to_user 为目标用户名，微信式好友资料卡）
        PROFILE_RESP: 39    // 阶段三十：个人资料响应/同步（content 为 JSON：username/nickname/gender/region/signature/avatar/is_friend/remark）
    };

    function connect(username, password) {
        currentUsername = username;
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var url = proto + location.host + '/ws';

        ws = new WebSocket(url);

        ws.onopen = function () {
            connected = true;
            // 发送登录消息
            send({ msg_type: MSG.LOGIN, from_user: username, content: password });
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
            scheduleReconnect();
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

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatTimer = setInterval(function () {
            send({ msg_type: MSG.HEARTBEAT });
        }, 30000); // 30s 心跳
    }

    function stopHeartbeat() {
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

    function dispatch(msg) {
        if (msg.msg_type === MSG.LOGIN_RESP) {
            // 登录响应携带服务端撤回时间窗口（recall_window 秒），供撤回菜单判断使用
            // 兼容旧格式：content 为 "ok" 字符串时保持默认 120 秒
            try {
                var info = JSON.parse(msg.content);
                if (info && info.recall_window > 0) {
                    recallWindow = info.recall_window;
                }
                // 阶段三十一：接收服务端下发的分片大小与大文件直传阈值（服务端归口）
                if (info && info.chunk_size > 0) {
                    chunkSize = info.chunk_size;
                }
                if (info && info.upload_threshold > 0) {
                    uploadThreshold = info.upload_threshold;
                }
            } catch (e) {}
            window._lastPassword = window._lastPassword || '';
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

    window.IMSocket = {
        MSG: MSG,
        connect: connect,
        send: send,
        on: on,
        isConnected: isConnected,
        getUsername: getUsername,
        getRecallWindow: getRecallWindow,
        getChunkSize: getChunkSize,
        getUploadThreshold: getUploadThreshold,
        getBufferedAmount: getBufferedAmount,
        stopHeartbeat: stopHeartbeat
    };
})();
