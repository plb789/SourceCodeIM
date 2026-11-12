// =====================================================================
//  IM Overlay SDK — 预编译 DLL 对外头文件
//  本 DLL 提供游戏内聊天 / 好友 / 房间功能的商户侧接入能力。
//  商户只需把 IMOverlay.dll + IMOverlay.lib + IMOverlay.h 拷进项目即可，
//  零额外依赖，零源码暴露。协议详见 docs/sdk/overlay-protocol.md。
//
//  接入三步：
//    1. IMSDK_Init(cb, user_data)   — 设置收帧回调
//    2. IMSDK_Start()               — 启动后台线程（连 pipe + 收帧 + 重连）
//    3. 游戏退出前 IMSDK_Stop()     — 幂等，多次调安全
//
//  关键约束：
//    - 回调在后台线程触发，不是游戏主线程！商户需自行转到渲染线程消费
//    - 回调里的 const char* 字段在回调返回后立即释放，必须在回调内自行复制
//    - 所有字符串 UTF-8 编码
//
//  版本：1.0.0（协议 v1）
// =====================================================================
#ifndef IMOVERLAY_H
#define IMOVERLAY_H

#include <stdint.h>

#ifdef _WIN32
    #ifdef IMOVERLAY_EXPORTS
        #define IMOVERLAY_API __declspec(dllexport)
    #else
        #define IMOVERLAY_API __declspec(dllimport)
    #endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

// =====================================================================
//  类型定义
// =====================================================================

/// 帧类型枚举（对应协议文档 §3 的 t 字段）
typedef enum IMOVERLAY_FrameType {
    IMOVERLAY_FT_UNKNOWN = 0,   ///< 未知类型（忽略）
    IMOVERLAY_FT_HELLO_ACK,    ///< 握手成功
    IMOVERLAY_FT_ME,           ///< 我的账号
    IMOVERLAY_FT_FRIENDS,      ///< 好友全量快照
    IMOVERLAY_FT_MSG,          ///< 私聊消息
    IMOVERLAY_FT_ROOM,         ///< 房间快照（room==null 时 has_room=0）
    IMOVERLAY_FT_ROOMCHAT,     ///< 房间聊天
    IMOVERLAY_FT_AVATAR,       ///< 好友头像（BGRA base64）
    IMOVERLAY_FT_HOTKEY,       ///< 热键配置
    IMOVERLAY_FT_FOLLOW,       ///< 关注名单
} IMOVERLAY_FrameType;

/// 好友条目（friends.list[]）
typedef struct IMOVERLAY_Friend {
    const char* username;   ///< IM 账号，如 "alice"
    const char* nickname;   ///< 显示名，可能等于 username
    int online;             ///< 0=离线，1=在线
} IMOVERLAY_Friend;

/// 房间成员（room.players[]）
typedef struct IMOVERLAY_Player {
    const char* username;
    const char* nickname;
} IMOVERLAY_Player;

/// 关注名单条目（follow.list[]，可能是 username 或昵称，视主进程配置）
/// 注意：协议里 follow.list 是 string 数组，这里直接复用 Friend 结构但 online 字段无意义

/// 一帧完整数据（所有字段按需填充，未出现的为 NULL/0）
/// 重要：所有 const char* 在回调返回后立即释放！商户必须在回调内自行复制！
typedef struct IMOVERLAY_Frame {
    IMOVERLAY_FrameType type;

    // —— 通用字段（各帧按需填充）——
    const char* u;           ///< me.u / follow 的账号
    const char* from;        ///< msg / roomchat 发送者 username
    const char* name;        ///< msg / roomchat 显示名
    const char* to;          ///< msg 接收者 username（应等于自己的 me.u）
    const char* text;        ///< msg / roomchat / avatar(b64) 的内容
    const char* action;      ///< room-act 的 action 字段（ready/leave/chat）
    const char* mode;        ///< room.mode / follow.mode（all/list 等）

    int room_id;             ///< room / roomchat / room-act
    int vk;                  ///< hotkey: Virtual-Key Code（如 9=Tab）
    int ctrl;                ///< hotkey: 是否要 Ctrl 组合（0/1）
    int shift;               ///< hotkey: 是否要 Shift 组合（0/1）
    int alt;                 ///< hotkey: 是否要 Alt 组合（0/1）
    int w;                   ///< avatar: 像素宽（固定 48）
    int h;                   ///< avatar: 像素高（固定 48）

    // —— friends 帧专属 ——
    const IMOVERLAY_Friend* friends;   ///< 好友数组指针（可能为 NULL）
    int friends_count;                 ///< 好友数量（可能为 0）

    // —— room 帧专属 ——
    int has_room;                      ///< 0=room==null（未在房），1=room 有效
    const IMOVERLAY_Player* room_players;   ///< 房间成员数组（可能为 NULL）
    int room_players_count;            ///< 成员数量

    // —— follow 帧专属 ——
    int follow_all;                    ///< 1=关注所有人，0=仅关注 follow_list
    const char** follow_list;          ///< 关注对象数组（可能为 NULL）
    int follow_list_count;             ///< 数组长度
} IMOVERLAY_Frame;

/// 收帧回调类型：每收到一帧触发一次
/// frame 指针在回调返回后立即失效（内部 buffer 释放）。
/// user_data 原样传入（Init 时指定）。
typedef void (__cdecl *IMOVERLAY_FrameCallback)(const IMOVERLAY_Frame* frame, void* user_data);

// =====================================================================
//  导出 API
// =====================================================================

// —— 生命周期 ——

/// 初始化 SDK：设置收帧回调 + 可选 user_data
/// 必须在所有其他函数前调用（除了 IMOVERLAY_GetVersion）。
/// cb 不能为 NULL。
/// 返回：0=成功，-4=参数非法。
IMOVERLAY_API int IMOVERLAY_Init(IMOVERLAY_FrameCallback cb, void* user_data);

/// 启动后台线程（连 pipe + 收帧 + 自动重连）。
/// 返回：0=成功，-1=未初始化，-2=已在运行，-3=pipe 创建失败。
IMOVERLAY_API int IMOVERLAY_Start(void);

/// 停止（幂等：多次调安全，内部做标志位保护）。
/// 等后台线程退出（最多 500ms，超时强制 detach），断开 pipe。
IMOVERLAY_API void IMOVERLAY_Stop(void);

/// 查询是否正在运行。
/// 返回：1=运行中，0=未运行。
IMOVERLAY_API int IMOVERLAY_IsRunning(void);

// —— 帧内渲染（D3D11 / D3D12）——

/// 帧内渲染（D3D11 或 D3D12）：商户在自己引擎的 Present 前调。
/// 首次调用会初始化 ImGui DX 后端并切换到帧内模式（自动关闭悬浮窗）。
/// dev:        D3D11=ID3D11Device*   D3D12=ID3D12Device*（内部 QueryInterface 识别）
/// ctx:        D3D11=ID3D11DeviceContext*   D3D12=ID3D12GraphicsCommandList*
/// backbuffer: D3D11=ID3D11RenderTargetView*   D3D12=D3D12_CPU_DESCRIPTOR_HANDLE*（主 swapchain RTV）
/// 返回：0=已渲染 / -1=未运行 / -6=设备无效 / -7=渲染模式已切换
IMOVERLAY_API int IMOVERLAY_RenderPresent(void* dev, void* ctx, void* backbuffer);

// —— 帧内渲染（Vulkan）——

/// 帧内渲染（Vulkan）：商户在自己引擎的 vkQueuePresentKHR 前调。
/// 首次调用会初始化 ImGui Vulkan 后端并切换到帧内模式（自动关闭悬浮窗）。
/// 要求商户 renderPass 绑定 VK_ATTACHMENT_LOAD_OP_LOAD（保留 backbuffer 内容）。
/// cmdBuffer 必须处于 recording 状态。
/// 所有 Vulkan handle 用 uint64_t 传递（Vulkan API 的原生大小）。
/// 返回：0=已渲染 / -1=未运行 / -6=设备无效 / -7=渲染模式已切换 / -8=Vulkan 参数不完整
IMOVERLAY_API int IMOVERLAY_RenderPresentVulkan(
    uint64_t device,
    uint64_t queue,
    uint64_t cmdBuffer,
    uint64_t renderPass,
    uint64_t framebuffer,
    int width,
    int height
);

// —— 帧内渲染（OpenGL 3）——

/// 帧内渲染（OpenGL 3+）：商户在自己引擎的 SwapBuffers 前调。
/// 内部自动从当前线程的 GL context（wglGetCurrentContext）获取上下文，商户无需额外传递。
/// 无需显式参数（OpenGL 绑定在当前线程）。
/// 返回：0=已渲染 / -1=未运行 / -6=GL context 无效 / -7=渲染模式已切换
IMOVERLAY_API int IMOVERLAY_RenderPresentGL(void);

// —— 悬浮窗控制（Start() 后默认帧内模式，5 秒未调 Render* 自动悬浮窗兜底）——

/// 显示/隐藏悬浮窗（悬浮窗模式下有效）
/// open: 1=显示，0=隐藏。隐藏后 StartPanelHotkey 仍响应。
IMOVERLAY_API int IMOVERLAY_SetOverlayOpen(int open);

/// 强制面板显示并聚焦（忽略热键状态，SDK 激活输入模式）
/// 用于商户游戏代码里主动打开面板（比如大厅里有个"打开聊天"按钮）
IMOVERLAY_API int IMOVERLAY_ShowPanel(void);

/// 设置悬浮窗初始位置和尺寸（悬浮窗模式下有效）
/// x, y: 左上角屏幕坐标（像素）
/// w, h: 宽高（像素），0 表示用默认值 520×360
IMOVERLAY_API int IMOVERLAY_SetOverlayRect(int x, int y, int w, int h);

// —— ImGUI 样式定制（可选）——

/// 设置面板主题色（RGB，0~255）
/// 覆盖 ImGui 面板的主色调（默认值：SDK 内置 #4A9EF2，可由 SetThemeColor 覆盖）
/// 影响：Tab 高亮、按钮、进度条、头像边框等
IMOVERLAY_API int IMOVERLAY_SetThemeColor(int r, int g, int b);

/// 设置面板字体（可选）
/// font_data: TTF/OTF 字体文件数据（UTF-16 适配中文字形）
/// data_len: 字节数
/// size: 字号（像素）
/// 传 NULL 则使用内置字体（ImGui 默认 + 中文 fallback 已打包）
IMOVERLAY_API int IMOVERLAY_SetFont(const char* font_data, int data_len, float size);

// —— 上行帧（商户主动发起）——

/// 发送私聊给指定好友。
/// to: 目标好友 IM 账号（非空，≤64 字）
/// text: 消息正文（≤2000 字，超出主进程截断）
/// 返回：0=已提交发送（不保证送达，主进程白名单兜底），-4=参数非法，-1=未运行。
IMOVERLAY_API int IMOVERLAY_SendChat(const char* to, const char* text);

/// 房间动作：准备。room_id 必须非零。
/// 返回：0=已提交，-4=参数非法，-1=未运行。
IMOVERLAY_API int IMOVERLAY_SendRoomReady(int room_id);

/// 房间动作：离开。room_id 必须非零。
IMOVERLAY_API int IMOVERLAY_SendRoomLeave(int room_id);

/// 房间动作：房间聊天。text ≤ 500 字。
IMOVERLAY_API int IMOVERLAY_SendRoomChat(int room_id, const char* text);

/// 面板状态上报（可选）：告诉主进程游戏内 IM 面板是否打开。
/// open: 1=打开中（主进程悬浮窗让位），0=关闭。
/// 返回：0=已提交，-1=未运行。
IMOVERLAY_API int IMOVERLAY_SendPanelOpen(int open);

// —— 工具 ——

/// SDK 版本字符串（如 "1.0.0"）。返回内部静态 buffer，不需要释放。
IMOVERLAY_API const char* IMOVERLAY_GetVersion(void);

#ifdef __cplusplus
} // extern "C"
#endif

#endif // IMOVERLAY_H
