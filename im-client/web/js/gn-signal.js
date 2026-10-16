// gn-signal.js - 阶段二百九十二 M8：游戏联机信令统一收发口（游戏中心窗 transport 层）
//
// 背景：房间层（gn-room.js）与连接层引擎（gn-net.js）整体迁入游戏中心窗（联机大厅页签）。
// 游戏中心窗是「无 WS 的独立窗」——不给它开第二条 WebSocket（同账号同端第二条连接有互踢风险、
// 未读双计、双心跳），109/110/111/112 一律经主进程 IPC 中继，复用主窗口唯一 WS：
//
//   上行：本窗口 GNSignal.send(payload) → desktop.gnSignalSend → 主进程 → 主窗口 IMSocket.send
//   下行：主窗口 socket.js dispatch 109/110/112 → desktop.gnSignalForward → 主进程 → 本窗口 onGnSignalIn
//
// 连接态：主窗口每秒上报 WS 连接态（变化才发）→ 主进程缓存 → 本窗口 onGnSocketState 同步；
// 首开窗口经 gnSocketStateGet 主动拉一次（避免开场窗口早于首次上报时的判定真空）。
//
// 兜底：本模块若被载入主窗口（存在 window.IMSocket），send/isConnected 直接走 IMSocket，行为等价。
(function () {
    'use strict';

    var handlers = {};      // msg_type → [fn]
    var connected = false;  // 主窗口 WS 连接态（中继口径）

    function isConnected() {
        if (window.IMSocket && typeof IMSocket.isConnected === 'function') return !!IMSocket.isConnected();
        return connected;
    }

    // payload = { msg_type, to_user?, content }（与 IMSocket.send 同形，服务端归口 from_user）
    function send(payload) {
        if (!payload || !payload.msg_type) return false;
        if (window.IMSocket && typeof IMSocket.send === 'function') return !!IMSocket.send(payload);
        if (!window.desktop || typeof window.desktop.gnSignalSend !== 'function') return false;
        if (!connected) return false; // 与 IMSocket.send 的"未连接不发"口径一致（调用方据返回值提示）
        try { window.desktop.gnSignalSend(payload); } catch (e) { return false; }
        return true;
    }

    function on(msgType, fn) {
        if (typeof fn !== 'function') return;
        (handlers[msgType] = handlers[msgType] || []).push(fn);
    }

    // 连接态变化订阅（true=重连成功 / false=断开）：房间层据此做重连沿状态重同步
    var stateHandlers = [];
    function onState(fn) {
        if (typeof fn === 'function') stateHandlers.push(fn);
    }
    function fireState(v) {
        for (var i = 0; i < stateHandlers.length; i++) {
            try { stateHandlers[i](v); } catch (e) { /* 单订阅者异常不阻断其余 */ }
        }
    }

    function dispatch(msg) {
        if (!msg || !msg.msg_type) return;
        var list = handlers[msg.msg_type];
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
            try { list[i](msg); } catch (e) { /* 单处理器异常不阻断其余分流 */ }
        }
    }

    window.GNSignal = { on: on, onState: onState, send: send, isConnected: isConnected };

    if (window.desktop) {
        if (typeof window.desktop.onGnSignalIn === 'function') {
            window.desktop.onGnSignalIn(function (msg) { dispatch(msg); });
        }
        if (typeof window.desktop.onGnSocketState === 'function') {
            window.desktop.onGnSocketState(function (on_) {
                var prev = connected;
                connected = !!on_;
                if (connected !== prev) fireState(connected); // 仅变化沿派发（主窗口本就变化才上报）
            });
        }
        if (typeof window.desktop.gnSocketStateGet === 'function') {
            try { window.desktop.gnSocketStateGet().then(function (on_) { connected = !!on_; }); } catch (e) { /* 拉取失败按未连接 */ }
        }
    }
})();
