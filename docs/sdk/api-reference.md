# IM Overlay SDK — API Reference

> 版本：SDK v1.0.0 · IMOverlay.dll Build 2026-11-12
> 接口语言：纯 C（所有函数 `extern "C"` + `stdcall` 调用约定）
> 依赖：Windows 10/11 x64，零 VC 运行时（/MT 静态链接）

---

## 目录

| 模块 | 函数 |
|------|------|
| **生命周期** | `IMOVERLAY_Init` · `IMOVERLAY_Start` · `IMOVERLAY_Stop` · `IMOVERLAY_IsRunning` · `IMOVERLAY_GetVersion` |
| **帧内渲染** | `IMOVERLAY_RenderPresent` · `IMOVERLAY_RenderPresentVulkan` · `IMOVERLAY_RenderPresentGL` |
| **悬浮窗控制** | `IMOVERLAY_SetOverlayOpen` · `IMOVERLAY_ShowPanel` · `IMOVERLAY_SetOverlayRect` |
| **样式定制** | `IMOVERLAY_SetThemeColor` · `IMOVERLAY_SetFont` |
| **上行帧** | `IMOVERLAY_SendChat` · `IMOVERLAY_SendRoomReady` · `IMOVERLAY_SendRoomLeave` · `IMOVERLAY_SendRoomChat` · `IMOVERLAY_SendPanelOpen` |

---

## 错误码

所有返回 `int` 的函数使用以下错误码：

| 值 | 含义 | 说明 |
|----|------|------|
| **0** | 成功 | ✅ |
| **-1** | 未运行 | 调 `Start()` 之前或 `Stop()` 之后调用 |
| **-2** | 已在运行 | 重复调 `Start()`（幂等，实际是正常状态） |
| **-3** | Pipe 连接失败 | IM-Client 主进程未启动 / 版本不兼容 |
| **-4** | 参数非法 | NULL 指针、空字符串、越界值 |
| **-6** | 渲染设备无效 | D3D/Vulkan/GL 设备指针为 NULL 或 QueryInterface 失败 |
| **-7** | 渲染模式已切换 | 帧内模式 ↔ 悬浮窗自动切换，旧调用被忽略 |
| **-8** | Vulkan 参数不完整 | 本机没编译 Vulkan 后端（`IMOVERLAY_NO_VULKAN`） |

---

## 类型定义

### IMOVERLAY_FrameType（帧类型）

```c
typedef enum {
    IMOVERLAY_FT_UNKNOWN    = 0,   // 忽略
    IMOVERLAY_FT_HELLO_ACK  = 1,   // 握手成功
    IMOVERLAY_FT_ME         = 2,   // 我的账号
    IMOVERLAY_FT_FRIENDS    = 3,   // 好友全量快照
    IMOVERLAY_FT_MSG        = 4,   // 私聊消息
    IMOVERLAY_FT_ROOM       = 5,   // 房间快照（has_room=0 表示未在房）
    IMOVERLAY_FT_ROOMCHAT   = 6,   // 房间聊天
    IMOVERLAY_FT_AVATAR     = 7,   // 好友头像（BGRA base64）
    IMOVERLAY_FT_HOTKEY     = 8,   // 热键配置
    IMOVERLAY_FT_FOLLOW     = 9,   // 关注名单
} IMOVERLAY_FrameType;
```

### IMOVERLAY_Friend（好友条目）

```c
typedef struct {
    const char* username;   // IM 账号，如 "alice"
    const char* nickname;   // 显示名，可能等于 username
    int         online;     // 0=离线，1=在线
} IMOVERLAY_Friend;
```

### IMOVERLAY_Player（房间成员）

```c
typedef struct {
    const char* username;
    const char* nickname;
} IMOVERLAY_Player;
```

### IMOVERLAY_Frame（完整帧数据）

```c
typedef struct {
    IMOVERLAY_FrameType type;

    // —— 通用字段（各帧按需填充，未出现的为 NULL/0）——
    const char* u;          // me.u / follow 的账号
    const char* from;       // msg / roomchat 发送者 username
    const char* name;       // msg / roomchat 显示名
    const char* to;         // msg 接收者 username
    const char* text;       // msg / roomchat / avatar(b64) 内容
    const char* action;     // room-act 的 action（ready/leave/chat）
    const char* mode;       // room.mode / follow.mode（all/list）

    int room_id;            // room / roomchat / room-act
    int vk;                 // hotkey: Virtual-Key Code（如 9=Tab）
    int ctrl;               // hotkey: Ctrl 组合（0/1）
    int shift;              // hotkey: Shift 组合（0/1）
    int alt;                // hotkey: Alt 组合（0/1）
    int w;                  // avatar: 像素宽（固定 48）
    int h;                  // avatar: 像素高（固定 48）

    // —— friends 帧专属 ——
    const IMOVERLAY_Friend* friends;        // 可能为 NULL
    int friends_count;                      // 可能为 0

    // —— room 帧专属 ——
    int has_room;                           // 0=未在房，1=room 有效
    const IMOVERLAY_Player* room_players;   // 可能为 NULL
    int room_players_count;

    // —— follow 帧专属 ——
    int follow_all;                         // 1=关注所有人
    const char** follow_list;               // 可能为 NULL
    int follow_list_count;
} IMOVERLAY_Frame;
```

### 关键约束

⚠️ **所有 `const char*` 字段在回调返回后立即释放！** 商户必须在回调内自行复制。

### IMOVERLAY_FrameCallback（回调类型）

```c
typedef void (__cdecl *IMOVERLAY_FrameCallback)(
    const IMOVERLAY_Frame* frame,
    void* user_data
);
```

**线程模型**：回调在 SDK 后台 pipe 收帧线程触发，**不是游戏主线程**！  
商户不要在回调里直接调引擎 UI API（Unity/UE 的 UnityEngine / UEngine），会崩溃。  
正确做法：回调里 **入队 → 主线程消费**。

---

## 生命周期 API

### IMOVERLAY_Init

```c
int IMOVERLAY_Init(IMOVERLAY_FrameCallback cb, void* user_data);
```

**功能**：初始化 SDK，注册收帧回调。必须在所有其他函数前调用（`IMOVERLAY_GetVersion` 除外）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cb` | `IMOVERLAY_FrameCallback` | 收帧回调函数指针，**不能为 NULL** |
| `user_data` | `void*` | 用户数据，回调触发时原样传入，可为 NULL |

| 返回值 | 说明 |
|--------|------|
| 0 | 成功（已初始化，后续再调返回 0 不重复注册） |
| -4 | cb 为 NULL |

**示例**：
```c
static std::queue<IMOVERLAY_Frame> g_frameQueue;
static std::mutex g_mutex;

void __cdecl MyFrameCallback(const IMOVERLAY_Frame* frame, void* user) {
    // 注意：这里是后台线程，不能调 Unity/UE API
    std::lock_guard<std::mutex> lock(g_mutex);
    g_frameQueue.push(*frame);  // 值拷贝（POD 结构，字符串指针在回调内有效）
}

// 游戏启动时
IMOVERLAY_Init(MyFrameCallback, nullptr);
```

---

### IMOVERLAY_Start

```c
int IMOVERLAY_Start(void);
```

**功能**：启动后台线程（连 pipe + 收帧 + 自动重连），初始化渲染引擎（默认帧内模式）。

| 返回值 | 说明 |
|--------|------|
| 0 | 成功启动 |
| -1 | 未初始化（先调 Init） |
| -2 | 已在运行（幂等，正常状态） |
| -3 | Pipe 连接失败（后台线程会自动重连，不用立即报错） |

**渲染模式说明**：
- Start() 后默认 **帧内模式**（等待商户调 `RenderPresent*`）
- 5 秒内没收到任何 `RenderPresent*` 调用 → 自动切 **悬浮窗兜底**
- 悬浮窗兜底 = 零商户配置，自动在游戏画面上显示 Overlay 面板

---

### IMOVERLAY_Stop

```c
void IMOVERLAY_Stop(void);
```

**功能**：停止 SDK（幂等，多次调用安全）。内部流程：
1. `g_should_stop = true` → 通知后台线程退出
2. `DisconnectPipe()` → 打断阻塞的 `ReadFile`
3. `thread.join()` → 等收帧线程退出（最多 500ms）
4. 停止悬浮窗 → 释放 D3D11 设备
5. Shutdown ImGui

⚠️ **必须在游戏退出前调**，否则后台线程会变成僵尸线程。

---

### IMOVERLAY_IsRunning

```c
int IMOVERLAY_IsRunning(void);
```

| 返回值 | 说明 |
|--------|------|
| 1 | 正在运行 |
| 0 | 未运行 |

---

### IMOVERLAY_GetVersion

```c
const char* IMOVERLAY_GetVersion(void);
```

**功能**：获取 SDK 版本字符串。可在 Init 前调用（不需要初始化）。

| 返回值 | 说明 |
|--------|------|
| `"1.0.0"` 等 | 内部静态 buffer，不需要释放 |

---

## 帧内渲染 API

### IMOVERLAY_RenderPresent

```c
int IMOVERLAY_RenderPresent(void* dev, void* ctx, void* backbuffer);
```

**功能**：D3D11 或 D3D12 帧内渲染（自动识别）。在引擎 Present 前调用。

| 参数 | D3D11 | D3D12 |
|------|-------|-------|
| `dev` | `ID3D11Device*` | `ID3D12Device*` |
| `ctx` | `ID3D11DeviceContext*` | `ID3D12GraphicsCommandList*` |
| `backbuffer` | `ID3D11RenderTargetView*` | `D3D12_CPU_DESCRIPTOR_HANDLE*`（主 swapchain RTV） |

**自动识别逻辑**：`QueryInterface` 先试 D3D12 → 成功则 DX12 后端 → 失败则 D3D11。

| 返回值 | 说明 |
|--------|------|
| 0 | 已渲染 |
| -1 | 未运行 |
| -6 | 设备无效（dev 为 NULL 或 QueryInterface 失败） |
| -7 | 渲染模式已切换（之前是悬浮窗，现在自动转帧内） |

**注意**：首次调用会初始化 ImGui DX 后端，后续调用直接渲染。

---

### IMOVERLAY_RenderPresentVulkan

```c
int IMOVERLAY_RenderPresentVulkan(
    uint64_t device,       // VkDevice
    uint64_t queue,        // VkQueue
    uint64_t cmdBuffer,    // VkCommandBuffer
    uint64_t renderPass,   // VkRenderPass
    uint64_t framebuffer,  // VkFramebuffer
    int width,
    int height
);
```

**功能**：Vulkan 帧内渲染。所有 handle 用 `uint64_t` 传递（Vulkan 原生大小）。

**商户约束**：
- `renderPass` 必须绑定 `VK_ATTACHMENT_LOAD_OP_LOAD`（保留 backbuffer 内容给 ImGui 叠加绘制）
- `cmdBuffer` 必须处于 recording 状态

| 返回值 | 说明 |
|--------|------|
| 0 | 已渲染 |
| -1 | 未运行 |
| -8 | Vulkan 后端未编译（本机无 Vulkan SDK，定义了 `IMOVERLAY_NO_VULKAN`） |

---

### IMOVERLAY_RenderPresentGL

```c
int IMOVERLAY_RenderPresentGL(void);
```

**功能**：OpenGL 3+ 帧内渲染（零参数）。内部自动从当前线程的 GL context（`wglGetCurrentContext`）获取上下文。

**调用时机**：在 `SwapBuffers` 前调用。

---

## 悬浮窗控制 API

悬浮窗是兜底机制（5 秒没调 RenderPresent* 自动启动），商户也可以主动控制。

### IMOVERLAY_SetOverlayOpen

```c
int IMOVERLAY_SetOverlayOpen(int open);
```

| 参数 | 说明 |
|------|------|
| `open=1` | 显示悬浮窗（如果还没启动 → 自动 StartFloatingWindow） |
| `open=0` | 隐藏悬浮窗（窗口还在，只是 SW_HIDE） |

### IMOVERLAY_ShowPanel

```c
int IMOVERLAY_ShowPanel(void);
```

**功能**：强制面板显示并聚焦（忽略热键状态，SDK 激活输入模式）。  
用于商户游戏代码里主动打开面板（比如大厅里有个"打开聊天"按钮）。

### IMOVERLAY_SetOverlayRect

```c
int IMOVERLAY_SetOverlayRect(int x, int y, int w, int h);
```

**功能**：设置悬浮窗初始位置和尺寸（悬浮窗模式下有效）。

| 参数 | 说明 |
|------|------|
| `x, y` | 左上角屏幕坐标（像素） |
| `w, h` | 宽高（像素），0 表示用默认值 520×360 |

**可以在 Start 前调**（悬浮窗还没创建，位置会缓存下来）。

---

## 样式定制 API

### IMOVERLAY_SetThemeColor

```c
int IMOVERLAY_SetThemeColor(int r, int g, int b);
```

**功能**：设置面板主题色（RGB 0~255）。影响 Tab 高亮、按钮、进度条、头像边框等。  
默认值：SDK 内置 `#4A9EF2`（蓝色）。

**可以在 Start 前调**（主题色会缓存，渲染引擎初始化时应用）。

---

### IMOVERLAY_SetFont

```c
int IMOVERLAY_SetFont(const char* font_data, int data_len, float size);
```

**功能**：设置面板字体（可选）。

| 参数 | 说明 |
|------|------|
| `font_data` | TTF/OTF 字体文件数据指针，传 NULL 用内置字体 |
| `data_len` | 字节数，font_data 为 NULL 时忽略 |
| `size` | 字号（像素），范围 6.0 ~ 72.0，超出强制 18.0 |

**内置字体**：ImGui 默认 + 中文 fallback 已打包进 DLL。  
如果你的游戏用了自定义字体（支持中文/日文/韩文），可以传进来让 Overlay 面板风格统一。

---

## 上行帧 API（商户主动发起）

### IMOVERLAY_SendChat

```c
int IMOVERLAY_SendChat(const char* to, const char* text);
```

**功能**：发送私聊给指定好友。

| 参数 | 说明 |
|------|------|
| `to` | 目标好友 IM 账号（≤64 字，超出截断） |
| `text` | 消息正文（≤2000 字，超出截断） |

⚠️ **不保证送达**。主进程有白名单校验（防恶意客户端乱发）。

---

### IMOVERLAY_SendRoomReady

```c
int IMOVERLAY_SendRoomReady(int room_id);
```

**功能**：房间准备。room_id 必须非零。

### IMOVERLAY_SendRoomLeave

```c
int IMOVERLAY_SendRoomLeave(int room_id);
```

**功能**：房间离开。

### IMOVERLAY_SendRoomChat

```c
int IMOVERLAY_SendRoomChat(int room_id, const char* text);
```

**功能**：房间聊天（text ≤ 500 字）。

### IMOVERLAY_SendPanelOpen

```c
int IMOVERLAY_SendPanelOpen(int open);
```

**功能**：面板状态上报。告诉主进程游戏内 IM 面板是否打开（主进程悬浮窗让位）。

---

## 完整示例（C++ 自研引擎）

```c
#include "IMOverlay.h"
#include <windows.h>
#include <mutex>
#include <queue>
#include <thread>

struct FrameQueue {
    std::mutex mtx;
    std::queue<IMOVERLAY_Frame> frames;
} g_queue;

// 后台线程回调（不能调引擎 API）
void __cdecl OnFrame(const IMOVERLAY_Frame* frame, void*) {
    std::lock_guard<std::mutex> lock(g_queue.mtx);
    g_queue.frames.push(*frame);
}

// ===== 游戏生命周期 =====

void GameStart() {
    IMOVERLAY_Init(OnFrame, nullptr);
    
    // 可选：启动前配好样式
    IMOVERLAY_SetThemeColor(74, 158, 242);  // #4A9EF2
    IMOVERLAY_SetOverlayRect(100, 100, 520, 360);
    
    IMOVERLAY_Start();
}

void GameShutdown() {
    IMOVERLAY_Stop();
}

// ===== 主循环（每帧调）=====

void GameTick() {
    // 1. Pump 帧（主线程消费）
    std::queue<IMOVERLAY_Frame> local;
    {
        std::lock_guard<std::mutex> lock(g_queue.mtx);
        std::swap(local, g_queue.frames);
    }
    while (!local.empty()) {
        IMOVERLAY_Frame& f = local.front();
        switch (f.type) {
            case IMOVERLAY_FT_MSG:
                ShowChatBubble(f.from, f.text);  // 你的游戏 UI API
                break;
            case IMOVERLAY_FT_FRIENDS:
                UpdateFriendListUI(f.friends, f.friends_count);
                break;
            // ... 其他帧类型
        }
        local.pop();
    }
    
    // 2. 你的引擎渲染...
    // RenderEngine::Present(dev, ctx, backbuffer);
    
    // 3. IM Overlay 帧内叠加（可选，不调则 5 秒后自动悬浮窗）
    IMOVERLAY_RenderPresent(dev, ctx, backbuffer);
}

// ===== 玩家操作 =====

void OnPlayerSendChat(const char* target, const char* msg) {
    IMOVERLAY_SendChat(target, msg);
}

void OnPlayerJoinRoom(int roomId) {
    IMOVERLAY_SendRoomReady(roomId);
}
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0.0 | 2026-11-12 | 首个正式版 — 18 个导出 API |
