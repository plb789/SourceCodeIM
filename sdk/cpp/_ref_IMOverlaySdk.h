// =====================================================================
//  IM Overlay SDK — 商户游戏集成版
//  Header-only 接口（实现见 im-overlay-sdk.cpp）
//  依赖：Windows SDK（<windows.h> / <string> / <thread> / <functional>）
//  C++ 标准：C++11 及以上（Unity 2018+/UE 4.25+ 全部支持）
//
//  接入：把 im-overlay-sdk.{h,cpp} 拷进你的游戏工程，#include 头文件，
//        游戏启动时调 IMOverlay::connect()，退出时调 stop()。
//  协议：详见 docs/sdk/overlay-protocol.md
// =====================================================================
#pragma once

#include <windows.h>
#include <string>
#include <vector>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>

namespace im {

// =====================================================================
//  帧类型定义（协议文档 §3）
// =====================================================================

// 上行 / 下行帧的基类——只用 std::map 风格的字符串到 variant 映射，
// 避免对外部 JSON 库的硬依赖（sdk 内置极简 NDJSON 解析器）。
struct IMFrame {
    std::string type;   // 对应 NDJSON 的 "t" 字段，如 "hello-ack" / "msg" / "chat-send"

    // —— 方便访问的字段（按需填充，未出现的字段为空 / 零） ——
    // 下行通用
    std::string u;            // me / follow 里的账号
    std::string from, name, to; // msg / roomchat 里的发送者 / 接收者
    std::string text;         // msg / roomchat / chat-send / room-act(chat)
    std::string action;       // room-act: ready / leave / chat
    std::string sdk;          // hello
    std::string version;      // hello

    int pid = 0;              // hello
    int room_id = 0;          // room / roomchat / room-act
    int vk = 0;               // hotkey
    int ctrl = 0, shift = 0, alt = 0; // hotkey
    int w = 0, h = 0;         // avatar 尺寸
    int max = 0;              // room

    bool online = false;      // friends.list[].on
    bool open = false;        // panel
    bool follow_all = false;  // follow.mode == "all"

    std::string b64;          // avatar 像素数据
    std::string mode;         // room.mode / follow.mode

    std::vector<std::pair<std::string, std::string>> friends; // [{u, n}]
    std::vector<std::string> follow_list;                     // follow.list
    std::vector<std::pair<std::string, std::string>> players; // room.players [{u, n}]

    bool has_room = false;    // room 帧里 room != null 时 true
};

// =====================================================================
//  IMOverlay — 主类
//  使用方式：
//    auto overlay = IMOverlay::connect(cb);  // 返回一个实例（工厂，不自动启动）
//    overlay.start();                         // 启后台线程收 pipe 帧
//    // 游戏运行，IMFrame 回调持续触发
//    overlay.stop();                          // 退出前调（或靠析构自动 stop）
// =====================================================================

class IMOverlay {
public:
    using OnFrameCallback = std::function<void(const IMFrame&)>;

    // 工厂方法：构造实例但不自动 start()。游戏启动阶段调。
    // cb = 每收到一帧回调一次（在后台线程里触发；如果你的 UI 不是线程安全的，
    //      需要自己把帧转到渲染线程再处理——Unity: MonoBehaviour.Update + 队列；
    //      UE: GameThread enqueue；纯 C++: 你自己的主线程消息泵）
    static std::unique_ptr<IMOverlay> connect(OnFrameCallback cb);

    ~IMOverlay();

    // —— 生命周期 ——
    void start();             // 启动后台线程，连接 pipe 并持续收帧
    void stop();              // 停止（幂等，多次调安全）
    bool running() const { return running_.load(); }

    // —— 上行帧发送（商户游戏主动发起）——

    // 发送私聊给指定好友
    void sendChat(const std::string& to, const std::string& text);

    // 房间动作：ready（准备）/ leave（离开）/ chat（房间聊天）
    void sendRoomReady(int roomId);
    void sendRoomLeave(int roomId);
    void sendRoomChat(int roomId, const std::string& text);

    // 面板状态上报（可选：主进程据此处理热键归属）
    void sendPanelOpen(bool open);

private:
    IMOverlay(OnFrameCallback cb);

    // 后台线程主循环
    void runLoop();

    // 创建 pipe 连接（\\.\pipe\im-overlay-<PID>），带自动重连
    bool connectPipe();

    // 断开 pipe（被动/主动）
    void disconnectPipe();

    // NDJSON 写一行（自动加 \n）
    bool writeLine(const std::string& line);

    // NDJSON 解析一行 → IMFrame（内置极简解析器）
    static IMFrame parseFrame(const std::string& line);

    // —— 成员 ——
    OnFrameCallback on_frame_;
    std::atomic<bool> running_{false};
    std::atomic<bool> should_stop_{false};
    std::thread worker_;
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
};

} // namespace im
