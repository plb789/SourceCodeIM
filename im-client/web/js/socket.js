// socket.js - WebSocket 连接管理、心跳、重连、消息分发
(function () {
    var ws = null;
    var heartbeatTimer = null;
    var reconnectTimer = null;
    var currentUsername = '';
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
        FRIEND_REQUEST: 20,
        FRIEND_REQUEST_RESP: 21,
        FRIEND_LIST: 22,
        FRIEND_DELETE: 23,
        BLACKLIST: 24,
        FRIEND_UPDATE: 25
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
            if (msg.content === 'ok') {
                window._lastPassword = window._lastPassword || '';
            }
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

    window.IMSocket = {
        MSG: MSG,
        connect: connect,
        send: send,
        on: on,
        isConnected: isConnected,
        getUsername: getUsername,
        stopHeartbeat: stopHeartbeat
    };
})();
