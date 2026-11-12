# IM Overlay SDK — 开发文档

> 版本：SDK v1.0 · 协议 v1
> 最后更新：2026-11-12

---

## 一、项目定位

### 1.1 解决什么问题

IM-Client 游戏内 Overlay 功能有两条接入路径：

| 路径 | 适用对象 | 前提 | 接入成本 |
|------|---------|------|---------|
| **DLL 注入**（现有） | 任何游戏（黑盒 exe） | 无（不需要源码） | 零（游戏侧不用改） |
| **商户 SDK 集成**（本文档） | 有源码的商户游戏 | 有引擎项目源码 | 极低（拷 DLL + 调几个 API） |

为什么商户还要 SDK 而不是全靠 DLL 注入：

1. **反作弊风险** — 有些 AC 拦远程线程注入，SDK 是正常 Named Pipe 客户端调用，零风险
2. **功能上限** — DLL 注入只能画顶层悬浮 UI（ImGUI），SDK 能做聊天气泡、好友头像、房间入口等**游戏原生 UI 元素**
3. **性能** — SDK 是原生集成，零额外渲染开销
4. **Steam 同款** — 一个 DLL 文件搞定，不暴露实现细节

### 1.2 不做什么

- **不替代 IM-Client 主进程** — SDK 只是 pipe 客户端，IM-Client 仍然负责 WS 连接、消息路由、好友管理、安全鉴权
- **不做 UI 渲染** — SDK 只负责数据收发，商户用自己引擎的 UI 系统（UGUI / UMG / 自研）画
- **不做游戏内 Overlay 的 DLL 注入** — 那是另一条独立路径（game-overlay.js + injector）
- **不做跨平台** — 第一版只做 Windows（IM-Client 本身就是 Windows Electron 应用）

### 1.3 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                    IM-Client 主进程                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ WS 连接   │  │ 好友/消息 │  │ 房间/头像快照 │  │ 安全白名单   │ │
│  └──────────┘  └──────────┘  └──────────────┘  └─────────────┘ │
│                           ↓ 全部汇聚到                         │
│              ┌────────────────────────────┐                     │
│              │  Named Pipe 服务端          │                     │
│              │  \\.\pipe\im-overlay-<pid>  │                     │
│              │  协议：NDJSON（见协议文档）  │                     │
│              └──────────┬─────────────────┘                     │
└────────────────────────┼───────────────────────────────────────┘
                         │
          ┌──────────────┼───────────────────┐
          ↓              ↓                   ↓
   ┌────────────┐  ┌────────────┐    ┌──────────────┐
   │ IMOverlay.dll  │  │ Unity 薄封装 │    │ UE 薄封装     │
   │ (核心)     │→│ (C# P/Invoke)│    │ (BP 节点)     │
   └────────────┘  └────────────┘    └──────────────┘
        ↑                ↑                   ↑
        └────────────────┴───────────────────┘
                         │
                   ┌─────┴──────┐
                   │  商户游戏   │  ← 用 Unity/UE/自研引擎的 UI 系统画
                   └────────────┘
```

---

## 二、交付物定义

### 2.1 核心 DLL（商户主要用）

```
IMOverlay.dll         ← 预编译核心实现（x64 + x86 两个版本）
IMOverlay.lib         ← 导入库（C++ 项目 link 用）
IMOverlay.h           ← 对外头文件（唯一接口定义）
IMOverlay.pdb         ← 调试符号（可选，发发行版时不打包）
```

**A BI 稳定性原则**：

- 对外 API 全部是 **纯 C 接口 + POD 结构体**
- 不暴露 STL / 不暴露 C++ 模板 / 不暴露类
- 不抛 C++ 异常（内部 catch 后返回错误码）
- 所有字符串用 `const char*`（UTF-8，不含零终止符之外的语义）
- 回调签名固定（`__cdecl`，Windows 标准调用约定）

### 2.2 Unity 适配层（额外包）

```
IMOverlay.Unity.unitypackage   ← 一键导入 Unity 的 .unitypackage
  Plugins/x86_64/IMOverlay.dll
  Plugins/x86/IMOverlay.dll
  Runtime/IMOverlay.cs          ← C# P/Invoke 封装 + MonoBehaviour 自动挂载
  Runtime/IMOverlayFrame.cs     ← C# 帧结构体
```

### 2.3 UE 5 适配层（额外包）

```
IMOverlay.uplugin              ← UE 插件描述文件
  Binaries/Win64/IMOverlay.dll
  Binaries/Win32/IMOverlay.dll
  Source/IMOverlay/Public/IMOverlayBP.h    ← Blueprint 节点声明
  Source/IMOverlay/Private/IMOverlayBP.cpp  ← 内部 P/Invoke 调 IMOverlay.dll
```

### 2.4 Godot 适配层（额外包）

```
im_sdk.gdextension    ← GDExtension 描述
im_sdk.dll            ← 核心（同 Windows）
im_sdk.gd             ← GDScript wrapper
```

### 2.5 不交付什么

- **不交付 C++ 源码** — 商户只能看到 .h 头文件（Steam 同款）
- **不交付协议文档** — 商户不需要知道 pipe 路径、NDJSON 格式（这些是实现细节）
- **不交付构建脚本** — 商户零编译

---

## 三、核心 DLL API 定义

### 3.1 设计原则

1. **最小 API 面** — 商户需要的函数数量 ≤ 15
2. **无状态函数** — 所有函数可任意顺序调用（除了 Init 必须先于 Start）
3. **线程安全** — Start 后后台线程自动收帧，主线程调 Send* 系列函数不阻塞
4. **不崩溃** — 回调里抛异常、空指针、重复 Stop 等都内部 catch 不崩

### 3.2 完整 API（纯 C 接口）

```c
// IMOverlay.h

typedef void (__cdecl *IMOVERLAY_FrameCallback)(const IMOVERLAY_Frame* frame, void* user_data);

// === 生命周期 ===
int IMOVERLAY_Init(IMOVERLAY_FrameCallback cb, void* user_data);   // 返回 0=成功
int IMOVERLAY_Start(void);                                       // 返回 0=成功 / 负数=错误码
void IMOVERLAY_Stop(void);                                       // 幂等
int IMOVERLAY_IsRunning(void);                                   // 1=运行中 / 0=未运行

// === 上行帧 ===
int IMOVERLAY_SendChat(const char* to, const char* text);       // 返回 0=已发送（不保证送达，主进程白名单兜底）
int IMOVERLAY_SendRoomReady(int room_id);
int IMOVERLAY_SendRoomLeave(int room_id);
int IMOVERLAY_SendRoomChat(int room_id, const char* text);
int IMOVERLAY_SendPanelOpen(int open);                           // open: 0/1

// === 工具 ===
const char* IMOVERLAY_GetVersion(void);                          // "1.0.0"
```

### 3.3 帧回调结构体

```c
typedef struct IMOVERLAY_Friend {
    const char* username;    // "alice"（IM 账号）
    const char* nickname;    // "Alice"（显示名，可能 == username）
    int online;              // 0/1
} IMOVERLAY_Friend;

typedef struct IMOVERLAY_Player {
    const char* username;
    const char* nickname;
} IMOVERLAY_Player;

typedef enum IMOVERLAY_FrameType {
    IMOVERLAY_FT_UNKNOWN = 0,
    IMOVERLAY_FT_HELLO_ACK,    // pipe 握手成功
    IMOVERLAY_FT_ME,           // 我的账号
    IMOVERLAY_FT_FRIENDS,      // 好友全量快照
    IMOVERLAY_FT_MSG,          // 私聊消息
    IMOVERLAY_FT_ROOM,         // 房间快照（null=未在房）
    IMOVERLAY_FT_ROOMCHAT,     // 房间聊天
    IMOVERLAY_FT_AVATAR,       // 好友头像（BGRA base64）
    IMOVERLAY_FT_HOTKEY,       // 热键配置
    IMOVERLAY_FT_FOLLOW,       // 关注名单
} IMOVERLAY_FrameType;

typedef struct IMOVERLAY_Frame {
    IMOVERLAY_FrameType type;

    // 通用字段（按需填充，未出现的为 NULL/0）
    const char* u;           // me / follow
    const char* from;        // msg / roomchat 发送者
    const char* name;        // msg / roomchat 显示名
    const char* to;          // msg 接收者
    const char* text;        // msg / roomchat / avatar(b64)
    const char* action;      // room-act
    const char* mode;        // room.mode / follow.mode
    int room_id;
    int vk, ctrl, shift, alt; // hotkey
    int w, h;                // avatar 尺寸

    // friends 数组
    const IMOVERLAY_Friend* friends;
    int friends_count;

    // room 数组（has_room=1 时有意义）
    int has_room;
    const IMOVERLAY_Player* room_players;
    int room_players_count;

    // follow
    int follow_all;
    const char** follow_list;
    int follow_list_count;
} IMOVERLAY_Frame;
```

### 3.4 回调生命周期（重要！）

**所有 `const char*` 字段在回调返回后立即释放**。商户必须在回调内自行复制：

```c
// 正确示范：
static std::string g_last_msg;  // 持久化存储

void OnFrame(const IMOVERLAY_Frame* f, void*) {
    if (f->type == IMOVERLAY_FT_MSG) {
        g_last_msg = f->text;     // ✓ 立即复制
    }
}

// 错误示范：
const char* g_bad_text;  // 存指针，不复制

void OnFrame(const IMOVERLAY_Frame* f, void*) {
    if (f->type == IMOVERLAY_FT_MSG) {
        g_bad_text = f->text;     // ✗ 回调返回后指针失效！
    }
}

void Later() {
    printf("%s\n", g_bad_text);    // ✗ 野指针！
}
```

### 3.5 错误码

| 错误码 | 含义 |
|--------|------|
| 0 | 成功 |
| -1 | 未初始化（Init 未调） |
| -2 | 已停止（Stop 后再调 Start） |
| -3 | pipe 路径无效（PID 拼接失败） |
| -4 | 参数非法（to 空、text 空、room_id=0） |
| -5 | 内部错误（NDJSON 解析失败 / 内存分配失败） |

---

## 四、核心 DLL 内部实现

### 4.1 模块划分

```
IMOverlay.dll
├── init.h/.cpp          ← Init / Start / Stop / IsRunning
├── pipe.h/.cpp          ← Named Pipe 客户端 + 自动重连
├── protocol.h/.cpp      ← NDJSON 解析 + 序列化（上行帧）
├── frame.h/.cpp         ← 内部帧结构 → C 接口 POD 转换
├── thread.h/.cpp        ← 后台收帧线程（Windows CreateThread）
└── exports.def          ← 导出函数列表（避免 name mangling）
```

### 4.2 依赖

| 依赖 | 说明 |
|------|------|
| **Windows SDK** | CreateFile / ReadFile / WriteFile / CloseHandle |
| **C++11 标准库** | std::string / std::thread / std::atomic / std::vector |
| **无第三方库** | NDJSON 解析器内置（极简版） |

### 4.3 内部数据结构（商户看不到）

```cpp
// 内部帧（用 std::string / std::vector 方便操作，最后转成 POD 再回调）
struct InternalFrame {
    std::string type;
    std::string u, from, name, to, text, action, mode;
    int room_id = 0, pid = 0, vk = 0, ctrl = 0, shift = 0, alt = 0;
    int w = 0, h = 0;
    std::vector<std::pair<std::string, std::string>> friends;
    std::vector<std::pair<std::string, std::string>> players;
    bool has_room = false, follow_all = false;
    std::vector<std::string> follow_list;

    // 转换为对外 POD（内部分配内存，回调后立即释放）
    IMOVERLAY_Frame toPod();
};
```

### 4.4 线程模型

```
┌───────────────────────────────────────────────────────────┐
│  商户游戏主线程                                             │
│  ├── IMOVERLAY_Init(cb, user_data)  ← 仅设置回调，不启线程       │
│  ├── IMOVERLAY_Start()              ← 创建后台线程               │
│  ├── IMOVERLAY_SendChat(...)        ← 同步写 pipe（不阻塞，内核缓冲）│
│  ├── ... 游戏继续正常运行 ...                                │
│  └── IMOVERLAY_Stop()               ← 等后台线程退出，断开 pipe   │
└───────────────────────────────────────────────────────────┘
                           │
    CreateThread(IMOVERLAY_WorkerThread) →
                           │
┌──────────────────────────▼───────────────────────────────┐
│  后台收帧线程                                               │
│  ├── connectPipe()  ← CreateFile("\\\\.\\pipe\\im-overlay-<pid>") │
│  ├── send hello（立即发注册帧）                               │
│  └── 主循环：                                               │
│      ├── ReadFile(pipe) → NDJSON buffer 积累                 │
│      ├── 按 \n 切帧 → InternalFrame → IMOVERLAY_Frame (POD)    │
│      ├── cb(&pod, user_data)  ← 回调商户（在这个线程里！）     │
│      ├── pipe 断开 → 1 秒重连循环                           │
│      └── Stop 信号 → 退出循环                                │
└───────────────────────────────────────────────────────────┘
```

### 4.5 回调线程警告

**IMOVERLAY_FrameCallback 在后台收帧线程里触发，不是游戏主线程！**

各引擎处理方式：

| 引擎 | 处理方式 |
|------|---------|
| **Unity** | MonoBehaviour.Update() 里消费队列（C# ConcurrentQueue 跨线程安全） |
| **UE 5** | AsyncTask(ENamedThreads::GameThread, ...) 把帧转发到游戏线程 |
| **纯 C++** | 商户自己的主线程消息泵里消费队列 |

### 4.6 重连策略

```
pipe 断开（游戏关闭 / IM-Client 关闭 / 网络错误）
    │
    ├─ disconnectPipe()
    │
    └─ 循环：
        ├─ should_stop_? → 退出
        ├─ Sleep(1000)   ← 每秒重试
        ├─ CreateFileA(path)
        │   ├─ 成功 → send hello → 进入主循环
        │   └─ 失败 → 继续 Sleep
        └─ ...
```

重连成功后，IM-Client 主进程会重新下发完整快照（hello-ack + me + friends + hotkey + follow），商户 UI 可以全量刷新。

### 4.7 Pipe 路径拼接

```cpp
DWORD pid = GetCurrentProcessId();
char path[64];
_snprintf_s(path, sizeof(path), "\\\\.\\pipe\\im-overlay-%lu", pid);
```

IM-Client 主进程在 spawn 游戏后立即创建 `\\.\pipe\im-overlay-<pid>` Named Pipe Server，游戏进程启动后连接即可。

### 4.8 ABI 稳定措施

| 措施 | 说明 |
|------|------|
| **extern "C"** | 防止 C++ name mangling，导出符号名固定 |
| **.def 文件** | 显式指定导出符号名，不受编译器影响 |
| **__cdecl** | Windows 标准调用约定，与所有引擎兼容 |
| **POD 结构体 + C 枚举** | 不含虚函数、不含 STL 成员、不含编译器扩展 |
| **MSVC v140/v141 工具集 + MT 运行时** | 静态链接 CRT，商户不需要额外 VC 运行时 |
| **不抛异常** | `/EHsc` + 内部 try/catch 全包裹，异常转错误码 |

### 4.9 字符串内存管理（核心难点）

**问题**：回调里给商户的 `const char*` 必须保证不悬空，但回调返回后我们又不知道商户会不会复制。

**解法**：每帧用线程局部 buffer 存储所有字符串，回调返回后立即释放：

```cpp
// 伪代码：内部线程分配 + POD 组装 + 回调 + 释放
void DispatchFrame(InternalFrame& iframe, IMOVERLAY_FrameCallback cb, void* user_data) {
    // 1. 把 InternalFrame (std::string) 转成 IMOVERLAY_Frame (const char*)
    std::vector<char> storage;  // 本帧专用存储
    storage.reserve(2048);
    
    auto copyStr = [&](const std::string& s) -> const char* {
        const char* p = reinterpret_cast<const char*>(storage.size());
        storage.insert(storage.end(), s.begin(), s.end());
        storage.push_back('\0');
        return reinterpret_cast<const char*>(storage.data() + p);
    };
    
    IMOVERLAY_Frame pod = {};
    pod.type = iframe.type_enum;
    pod.u = copyStr(iframe.u);
    pod.text = copyStr(iframe.text);
    // ... 其他字段同理
    
    // 2. 回调（商户必须在回调内复制所有 const char*）
    cb(&pod, user_data);
    
    // 3. 回调返回 → storage 析构 → 所有字符串内存释放
    //    商户之前存的任何 const char* 现在都悬空了！
}
```

---

## 五、Unity 适配层（P1 详细设计）

### 5.1 目录结构

```
Assets/Plugins/
  x86_64/
    IMOverlay.dll              ← Win64 核心（Copy if Newer, Plugin = Editor & Standalone）
  x86/
    IMOverlay.dll              ← Win32 核心

Assets/IMOverlay/
  IMOverlay.cs                 ← P/Invoke + MonoBehaviour
  IMOverlayFrame.cs            ← C# 帧结构体
  IMOverlayExample.cs          ← 使用示例（Demo 场景里挂）
  Editor/
    IMOverlayMenuItem.cs       ← "IMOverlay/Add Overlay" 菜单
```

### 5.2 IMOverlay.cs 核心代码（概要）

```csharp
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using UnityEngine;

public static class IMOverlay {
    private const string DLL = "IMOverlay";

    // === P/Invoke 声明 ===
    [DllImport(DLL)] private static extern int IMOVERLAY_Init(FrameCallback cb, IntPtr ud);
    [DllImport(DLL)] private static extern int IMOVERLAY_Start();
    [DllImport(DLL)] private static extern void IMOVERLAY_Stop();
    [DllImport(DLL)] private static extern int IMOVERLAY_IsRunning();
    [DllImport(DLL)] private static extern int IMOVERLAY_SendChat(string to, string text);
    [DllImport(DLL)] private static extern int IMOVERLAY_SendRoomReady(int roomId);
    [DllImport(DLL)] private static extern int IMOVERLAY_SendRoomLeave(int roomId);
    [DllImport(DLL)] private static extern int IMOVERLAY_SendRoomChat(int roomId, string text);
    [DllImport(DLL)] private static extern int IMOVERLAY_SendPanelOpen(int open);
    [DllImport(DLL)] private static extern IntPtr IMOVERLAY_GetVersion();

    public delegate void FrameCallback(IntPtr frame, IntPtr ud);
    private static FrameCallback _nativeCb;   // 保持引用防 GC

    // 跨线程帧队列（后台线程生产 / 主线程消费）
    private static readonly ConcurrentQueue<IMOverlayFrame> _queue = new ConcurrentQueue<IMOverlayFrame>();

    // 后台线程回调：把 POD 转成 C# 对象入队
    private static void OnFrame(IntPtr framePtr, IntPtr ud) {
        if (framePtr == IntPtr.Zero) return;
        var frame = Marshal.PtrToStructure<IMOverlayFrameNative>(framePtr);
        _queue.Enqueue(frame.ToManaged());
    }

    // 主线程消费（由 MonoBehaviour.Update 驱动）
    public static event Action<IMOverlayFrame> OnFrame;
    public static void PumpFrames() {
        while (_queue.TryDequeue(out var frame)) {
            OnFrame?.Invoke(frame);
        }
    }

    // 商户入口：一行接入
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void AutoInit() {
        _nativeCb = OnFrame;
        IMOVERLAY_Init(_nativeCb, IntPtr.Zero);
        IMOVERLAY_Start();
    }
}
```

### 5.3 Unity 使用示例（商户侧）

```csharp
public class ChatManager : MonoBehaviour {
    void OnEnable() {
        IMOverlay.OnFrame += HandleFrame;
    }
    void OnDisable() {
        IMOverlay.OnFrame -= HandleFrame;
    }

    // MonoBehaviour.Update 驱动 PumpFrames（主线程安全）
    void Update() {
        IMOverlay.PumpFrames();
    }

    private void HandleFrame(IMOverlayFrame f) {
        switch (f.type) {
            case FrameType.HelloAck:  /* pipe ready */ break;
            case FrameType.Me:        nameText.text = $"IM: {f.meUsername}"; break;
            case FrameType.Friends:   friendsList.Refresh(f.friends); break;
            case FrameType.Msg:       StartCoroutine(ShowToast(f.msgText)); break;
            case FrameType.Room:      RefreshRoomPanel(f.room); break;
            case FrameType.Hotkey:    RegisterHotkey(f.hotkeyVK, f.hotkeyModifiers); break;
        }
    }

    public void OnSendButton() {
        IMOverlay.SendChat(targetInput.text, msgInput.text);
    }
}
```

---

## 六、UE 5 适配层（P2 概要设计）

### 6.1 实现思路

- `UIMOverlaySubsystem : UGameInstanceSubsystem`（Engine 模块，所有 GameMode 自动可用）
- `UFunction(BlueprintCallable)` 暴露 SendChat / SendRoomReady 等节点
- `DECLARE_DYNAMIC_MULTICAST_DELEGATE` 暴露 OnFrame（蓝图可绑定）
- 内部用 `AsyncTask(ENamedThreads::GameThread, ...)` 把后台线程帧转到游戏线程

### 6.2 Blueprint 使用（商户侧）

```
GameMode.BeginPlay
  → Get UIMOverlaySubsystem
  → BindEvent OnFrame → Create Widget（聊天 UI）
  → Event OnSendClicked → Call SendChat(To, Text)
```

---

## 七、安全边界

### 7.1 三层防线

| 防线 | 位置 | 说明 |
|------|------|------|
| **① IMOverlay.dll 内部** | 导出 API 参数校验 | SendChat 自动截断 text 至 2000 字；空 to 直接返回错误码 |
| **② Named Pipe 协议** | NDJSON 帧格式校验 | 主进程解析后只认 t 字段 + 白名单字段 |
| **③ IM-Client 主进程** | 白名单硬校验 | 只放行 chat-send / room-act + action 枚举 + 长度截断 |

### 7.2 不做什么安全措施

| 项目 | 原因 |
|------|------|
| **DLL 签名验证** | 商户自己 load IMOverlay.dll，签名挡不住逆向；主进程白名单才是防线 |
| **帧加密** | 本机 IPC，用户态攻击者已经能注入游戏进程了，加密 pipe 意义不大；IM 服务器侧仍然走加密 WS + Token |
| **反篡改保护** | 主进程对 pipe 上行帧做了白名单校验，篡改 IMOverlay.dll 也发不出额外信令 |
| **进程身份验证** | pipe 名硬编码 PID，游戏只能连自己 PID 对应的 pipe；主进程 pipe 表同 PID 只允许一个 sock |

---

## 七-A、内置渲染模式（帧内 + 悬浮窗双模式）

### 7A.1 设计目标

SDK 不只是"数据收发器"，而是**完整的游戏内 IM Overlay 解决方案**——和 Steam Overlay 同款体验：
- 商户零 UI 开发即可获得好友列表、聊天面板、房间面板、通知 toast
- 内置 **两种渲染模式**，商户按接入条件自由选择
- UI 代码 100% 复用注入式 Overlay 的 ImGUI 面板（`overlay_hook.cpp` L1309-L1839）

### 7A.2 模式对比

| 维度 | 模式 A：帧内渲染（默认） | 模式 B：悬浮窗（兜底） |
|------|----------------|---------------------|
| **渲染位置** | 游戏 D3D backbuffer 上叠加绘制 | SDK 自己创建的透明 HWND 上独立绘制 |
| **商户接入成本** | 需提供 D3D 设备 + Present 时机 | **零**（Init + Start 两行完事） |
| **反作弊安全** | 零风险（正常 D3D 调用，和游戏自己画 UI 一样） | 零风险（独立 HWND，和 Notepad 窗口一样） |
| **UI 融合度** | 完美（和游戏画面一体，无边界） | 良好（独立透明窗，可拖拽/可最小化） |
| **全屏独占兼容** | **100%**（帧内渲染，游戏独占全屏照样有） | **可能被覆盖**（部分独占全屏游戏跳过窗口合成 → 悬浮窗消失） |
| **输入体验** | 完美（游戏内鼠标键盘直喂 ImGui） | 良好（SDK 自己 WndProc 子类化） |
| **性能开销** | 极低（帧末尾加一次 ImGui 绘制） | 中等（独立的 D3D 设备 + 渲染线程） |
| **和注入版 Overlay 对比** | 等价（走同一条 Present 路径） | 更轻量（不 hook 游戏代码） |
| **商户最适合场景** | Unity/UE 等已知渲染管线 | 黑盒 C++ / 自研引擎 / 最小接入 |

### 7A.3 默认行为 + 自动切换

```cpp
// 商户最简接法 —— 帧内模式（默认）：
IMOVERLAY_Init(OnFrame, nullptr);
IMOVERLAY_Start();  // Start() 后立即在引擎 Present 前调：
IMOVERLAY_RenderPresent(dev, ctx);   // ← 商户渲染管线 Present 前一行

// 没有渲染管线支持的黑盒游戏 —— 自动回退悬浮窗：
IMOVERLAY_Init(OnFrame, nullptr);
IMOVERLAY_Start();  // Start() 后若商户始终不调 RenderPresent()，
                    // SDK 会在 5 秒后自动启动悬浮窗作为兜底
```

切换逻辑：
- `Start()` → 默认**帧内模式**（等待商户首次调 `RenderPresent` 传入 D3D/Vulkan 设备）
- 5 秒内未收到 `RenderPresent()` 调用 → **自动启动悬浮窗兜底**（不中断启动流程）
- 帧内模式运行中商户调 `RenderPresent()` → SDK 检测设备有效性 → 切换到帧内模式（从悬浮窗切回）
- 设备丢失（DXGI_ERROR_DEVICE_REMOVED / VK_ERROR_DEVICE_LOST）→ SDK 自动回退到悬浮窗模式 → 等设备恢复再切回
- 悬浮窗兜底运行中商户后续调 `RenderPresent()` → 自动关闭悬浮窗，切到帧内模式

### 7A.4 新增导出 API

#### 帧内渲染（D3D11 / D3D12）

```c
/// 帧内渲染（D3D11 或 D3D12）：商户在自己引擎的 Present 前调。
/// 首次调用会初始化 ImGui DX 后端并切换到帧内模式（自动关闭悬浮窗）。
/// dev:        D3D11=ID3D11Device*   D3D12=ID3D12Device*（内部通过 QueryInterface 识别）
/// ctx:        D3D11=ID3D11DeviceContext*   D3D12=ID3D12GraphicsCommandList*
/// backbuffer: D3D11=ID3D11RenderTargetView*   D3D12=D3D12_CPU_DESCRIPTOR_HANDLE*（主 swapchain RTV）
/// 返回：0=已渲染 / -1=未运行 / -6=设备无效 / -7=渲染模式已切换
IMOVERLAY_API int IMOVERLAY_RenderPresent(void* dev, void* ctx, void* backbuffer);
```

#### 帧内渲染（Vulkan）

```c
/// 帧内渲染（Vulkan）：商户在自己引擎的 vkQueuePresentKHR 前调。
/// 首次调用会初始化 ImGui Vulkan 后端并切换到帧内模式（自动关闭悬浮窗）。
/// 依赖：ImGUI Vulkan backend（imgui_impl_vulkan.h/.cpp，SDK 内置）
///   - SDK 会在首次调用时自动创建 ImGui 的 VkDescriptorPool / ImGui 的 VkPipelineCache
///   - 要求商户在自己的 renderPass 里绑定 VK_ATTACHMENT_LOAD_OP_LOAD（保留 backbuffer 内容）
///   - width/height 为当前 swapchain 尺寸（像素），ImGui 需要它来调整缩放
///   - cmdBuffer 必须处于 recording 状态（vkBeginCommandBuffer 已调，vkEndCommandBuffer 未调）
///
/// 参数：
///   device:       VkDevice（uint64_t，Vulkan handle）
///   queue:        VkQueue（uint64_t，Present 或 Graphics queue）
///   cmdBuffer:    VkCommandBuffer（uint64_t，当前正在 recording 的 command buffer）
///   renderPass:   VkRenderPass（uint64_t，当前 swapchain 的 render pass）
///   framebuffer:  VkFramebuffer（uint64_t，当前 swapchain 对应的 framebuffer）
///   width:        int，swapchain image 宽（像素）
///   height:       int，swapchain image 高（像素）
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
```

#### 帧内渲染（OpenGL 3）

```c
/// 帧内渲染（OpenGL 3+）：商户在自己引擎的 SwapBuffers 前调。
/// 内部自动从当前线程的 GL context（wglGetCurrentContext）获取上下文，商户无需额外传递。
/// 无需显式参数（OpenGL 绑定在当前线程）。
/// 返回：0=已渲染 / -1=未运行 / -6=GL context 无效 / -7=渲染模式已切换
IMOVERLAY_API int IMOVERLAY_RenderPresentGL(void);
```

#### 悬浮窗控制

```c
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
```

#### ImGUI 样式定制（可选）

```c
/// 设置面板主题色（RGB，0~255）
/// 覆盖 ImGui 面板的主色调（默认值：主进程 IM-Client 主题色）
/// 影响：Tab 高亮、按钮、进度条、头像边框等
IMOVERLAY_API int IMOVERLAY_SetThemeColor(int r, int g, int b);

/// 设置面板字体（可选）
/// font_data: TTF/OTF 字体文件数据（UTF-16 适配中文字形）
/// size: 字号（像素）
/// 传 NULL 则使用内置字体（ImGui 默认 + 中文 fallback 已打包）
IMOVERLAY_API int IMOVERLAY_SetFont(const char* font_data, int data_len, float size);
```

### 7A.5 ImGUI 面板 UI 结构（复用注入版）

```
┌─────────────────────────────────────────────────────┐
│  好友列表 Tab  │ 房间 │ ⚙  │       [关闭]          │
├─────────────────────────────────────────────────────┤
│ ┌─ Alice 在线  🟢 ───────────────────────────┐     │
│ │ 你好！加个好友？                             │     │
│ │                                    [回复] [×]│     │
│ └──────────────────────────────────────────────┘     │
│ ┌─ Bob 离线  ⚪ ──────────────────────────────┐     │
│ └──────────────────────────────────────────────┘     │
│ ┌─ Carol 在线  🟢 ────────────────────────────┐     │
│ │ 准备好了，在房间里等你                       │     │
│ │                                    [回复] [×]│     │
│ └──────────────────────────────────────────────┘     │
│                                                     │
│ ──────────────── 输入框 ──────────────── [发送]     │
│                                                     │
└─────────────────────────────────────────────────────┘

Room Tab：房间成员列表 + 准备/离开按钮 + 房间聊天
Settings Tab：主题色 / 字号 / 热键预览
```

**UI 代码来源**：直接从 `overlay_hook.cpp` 的 `DrawFriendsList` / `DrawRoomTab` / `DrawToastNotifications` 抽成独立 TU，改成回调方式（UI 层不直接访问 hook 全局变量，而是从 SDK 核心拿当前好友/房间快照）。

### 7A.6 两种模式的内部实现

#### 模式 A：帧内渲染

```
商户游戏 Present 前
    │
    ├─ 游戏正常 DrawIndexedPrimitive / Present 调用
    │
    ├─ SDK: ImGui_ImplDX11_NewFrame()
    ├─ SDK: ImGui_ImplWin32_NewFrame()   ← 用游戏主窗口 HWND
    ├─ SDK: ImGui::NewFrame()
    ├─ SDK: DrawAllPanels()              ← 复用注入版 UI 代码
    ├─ SDK: ImGui::Render()
    └─ SDK: ImGui_ImplDX11_RenderDrawData()  ← 叠加到游戏 backbuffer
```

**设备丢失处理**：订阅游戏的 `Present` 返回值（DXGI_ERROR_DEVICE_REMOVED / DXGI_ERROR_DEVICE_RESET），自动回退到悬浮窗模式；等游戏设备重建后商户下次调 `RenderPresent` 时 SDK 重新初始化 ImGui 后端。

#### 模式 B：悬浮窗渲染

```
SDK Start()
    │
    ├─ CreateWindowEx(WS_EX_LAYERED | WS_EX_TRANSPARENT,
                      "IM Overlay", WS_POPUP)
    │
    ├─ 创建独立 D3D11 设备（D3D11CreateDevice + DXGI swapchain → 绑定到覆盖窗）
    │
    ├─ CreateThread(RenderLoop)
    │   └─ 每 16ms（~60FPS）：
    │       ├─ swapchain->Present(1, 0)  ← VSync 等下
    │       ├─ ImGui_ImplDX11_NewFrame()
    │       ├─ ImGui_ImplWin32_NewFrame()
    │       ├─ ImGui::NewFrame()
    │       ├─ DrawAllPanels()
    │       ├─ ImGui::Render()
    │       └─ ImGui_ImplDX11_RenderDrawData() → 覆盖窗的 backbuffer
    │
    └─ SetWindowsHookEx(WH_KEYBOARD_LL, ...)  ← 全局热键监听（SDK 内部自己来）
```

**全屏独占兼容**：`WS_EX_TRANSPARENT` + DXGI swapchain 独立呈现时，部分游戏（走 `IDXGISwapChain::Present(0, DXGI_PRESENT_ALLOW_BEHIND)`）会把覆盖窗压到游戏后面。SDK 每帧检测窗口是否可见（`GetVisibleRect` vs `GetMonitorRect`），发现被覆盖时自动：
1. 把自己的 swapchain 绑到游戏主窗口（`SetWindowLongPtr` 改 HWND）
2. 或回退到"只在游戏窗口可见时才渲染"

### 7A.7 ImGUI 三方库集成

| 项 | 说明 |
|------|------|
| **来源** | 直接复用 `overlay-native/third_party/imgui/`（ImGUI 1.90+，已在项目内） |
| **后端** | 帧内模式（按 API 自动切换）：<br>　• D3D9 → `imgui_impl_dx9.h/.cpp`<br>　• D3D11 → `imgui_impl_dx11.h/.cpp`<br>　• D3D12 → `imgui_impl_dx12.h/.cpp`<br>　• **Vulkan → `imgui_impl_vulkan.h/.cpp`**（新增，ImGUI 官方内置）<br>　• OpenGL 3+ → `imgui_impl_opengl3.h/.cpp`<br>悬浮窗模式：固定 `imgui_impl_dx11`（内部 D3D11 设备）<br>所有模式共用 `imgui_impl_win32`（WndProc 子类化） |
| **字体** | ImGUI 默认字体 + 已打包的中文字形 fallback（覆盖 CJK 统一汉字区间） |
| **编译** | ImGUI 源码直接编进 DLL（静态链接，不单独分发）。Vulkan 后端需 link `vulkan-1.lib`（Windows SDK 自带） |

### 7A.8 DLL 产物变化

| 之前 Phase 0 产物 | 渲染模式加入后 |
|------------------|--------------|
| IMOverlay.dll（~100KB，无 UI） | IMOverlay.dll（~1.5MB，含 ImGUI 三方库） |
| 导出 API：Init / Start / Stop / Send* | 新增：RenderPresent(D3D11/D3D12) / **RenderPresentVulkan** / **RenderPresentGL** / SetOverlayOpen / ShowPanel / SetOverlayRect / SetThemeColor / SetFont |
| 内部模块：pipe + NDJSON + 重连 | 新增：ui/（ImGUI 面板 TU）+ renderer/（帧内 + 悬浮窗后端） + hotkey/（WH_KEYBOARD_LL） |

### 7A.9 Unity / UE 适配层变化

适配层（C# P/Invoke / Blueprint 节点）**只需新增对应封装**，Phase 0 的接口零改动。

Unity 商户侧最简单接法（不改 C# 代码）：

```
导入 IMOverlay.Unity.unitypackage
  → 自动加载 IMOverlay.dll
  → RuntimeInitializeOnLoadMethod 自动 Init + Start
  → Start() 后自动切帧内模式（Unity 有 D3D/Vulkan 渲染管线）→ 完事！
```

想切帧内模式时在 `MonoBehaviour.Update` 里加一行：

```csharp
void LateUpdate() {
    var dev = GL.GetNativePtr();  // D3D11 device
    var ctx = ...;                // D3D11 context
    IMOverlay.RenderPresent(dev, ctx, IntPtr.Zero);
}
```

### 7A.10 与注入版 Overlay 的关系

| 关系 | 说明 |
|------|------|
| **UI 代码复用** | 90%+（DrawFriendsList / DrawRoomTab / DrawToastNotifications），只改了全局变量访问方式 |
| **渲染管线解耦** | 注入版 hook 虚表 → SDK 版由商户主动调 `RenderPresent`，解耦彻底 |
| **互斥使用** | 同一游戏实例：开注入就不用 SDK 帧内；开 SDK 帧内就不用注入。注入版 Overlay 检测到 pipe 已被 SDK 占用时自动跳过渲染 |
| **独立悬浮窗模式** | 悬浮窗模式和注入版 Overlay 不互斥（甚至可以共存），但建议二选一 |
| **协议层完全相同** | NDJSON 帧格式、pipe 命名、白名单校验全部沿用，零协议变更 |

---

## 八、编译与构建

### 8.1 构建工具链

| 工具 | 版本 | 说明 |
|------|------|------|
| **Visual Studio** | 2019 或 2022 | MSVC v140/v141 工具集 |
| **Windows SDK** | 10.0.19041.0+ | CreateFile / ReadFile 等 API |
| **构建系统** | CMake 3.16+ | 跨平台构建（虽然目标只有 Windows） |

### 8.2 构建配置

```cmake
# CMakeLists.txt 关键点
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")  # /MT 静态链接，免 VC 运行时
add_compile_options(/EHsc /W4 /permissive-)       # 不抛异常 / 高警告 / 严格模式

add_library(IMOverlay SHARED
    src/init.cpp
    src/pipe.cpp
    src/protocol.cpp
    src/frame.cpp
    src/thread.cpp
    src/exports.def
)

target_compile_definitions(IMOverlay PRIVATE IMOVERLAY_EXPORTS)  # __declspec(dllexport)
target_include_directories(IMOverlay PUBLIC include)        # 对外 IMOverlay.h
```

### 8.3 多架构产物

```
build/
  Win64/Release/
    IMOverlay.dll
    IMOverlay.lib
    IMOverlay.pdb              ← 仅内部调试用，发发行版时删除
  Win32/Release/
    IMOverlay.dll
    IMOverlay.lib
    IMOverlay.pdb
```

### 8.4 加壳/混淆（可选）

发行前可选使用 VMProtect / Themida / UPX 等工具：
- 提高逆向还原 pipe 路径和协议格式的难度
- 注意：加壳后 DLL 体积会变大，首次加载稍慢（毫秒级，可忽略）

---

## 九、实施计划

### Phase 0：核心 DLL（1-2 天）

| 任务 | 产出 |
|------|------|
| 把已有 C++ 实现改造成 DLL（加 exports.def + extern "C"） | `IMOverlay.dll` 雏形 |
| 完成完整 API 实现（Init/Start/Stop/Send*/回调） | 所有导出函数 |
| 完成 NDJSON 解析器 + 内部帧 → POD 转换 | 协议层 |
| CMakeLists.txt + Win64/Win32 构建验证 | 两个架构的 DLL + lib |
| 独立测试程序（test_im_sdk.exe） | 能连上真实 IM-Client 主进程 |
| API 文档（doxygen 风格注释写在 .h 里） | IMOverlay.h 注释 |

### Phase 1：Unity 适配（1 天）

| 任务 | 产出 |
|------|------|
| IMOverlay.cs（P/Invoke + MonoBehaviour） | 运行时代码 |
| IMOverlayFrame.cs（C# 帧结构体） | 类型定义 |
| IMOverlayExample.cs（Demo 聊天面板） | 商户可直接用的示例 |
| Unity .unitypackage 打包 | 一键导入 |

### Phase 2：UE 5 适配（1 天）

| 任务 | 产出 |
|------|------|
| UIMOverlaySubsystem（GameInstanceSubsystem） | UE 模块 |
| Blueprint 节点绑定（ChatSend / RoomReady / OnFrame） | 蓝图可视化 |
| .uplugin + Build.cs | 插件描述 |

### Phase 3：协议文档 + 交付（半天）

| 任务 | 产出 |
|------|------|
| 商户快速接入指南 | 独立文档 `docs/sdk/merchant-guide.md` |
| Unity / UE 集成步骤截图 | 接入文档配图 |
| 版本号打 tag + changelog | Git 标签 |

---

## 十、版本策略

### 10.1 语义化版本

```
MAJOR.MINOR.PATCH

MAJOR  协议破坏性变更或 API 删除 → 新旧版互不兼容
MINOR  新增帧类型 / 新增 API 函数 → 旧客户端仍能正常工作（忽略新帧）
PATCH  bug 修复 / 性能优化 → 完全向后兼容
```

### 10.2 向后兼容保证

| 变更 | 兼容策略 |
|------|---------|
| 新增下行帧类型 | 旧 SDK 收到 `t` 不在枚举里 → `IMOVERLAY_FT_UNKNOWN` → 忽略，不 crash |
| 新增下行帧字段 | JSON 对象新增 key → SDK 解析器自动忽略未知 key |
| 新增上行帧类型 | 旧 SDK 没有 IMOVERLAY_SendXxx 函数 → 不存在调用，主进程新增白名单对旧版无影响 |
| 删除下行帧字段 | **不允许**（破坏性变更，升 MAJOR） |
| 删除导出函数 | **不允许**（破坏性变更，升 MAJOR） |

### 10.3 未来可能的破坏性变更（提前告知）

| 变更 | 触发条件 | 影响 |
|------|---------|------|
| pipe 名改前缀 | 协议大版本升级 | 旧 SDK 连不上新主进程；主进程可同时监听两个 pipe 名过渡 |
| IMOVERLAY_Init 签名加新参数 | 极少见 | 用 `InitEx(cb, ud, flags)` 新函数，旧 Init 保留 |
