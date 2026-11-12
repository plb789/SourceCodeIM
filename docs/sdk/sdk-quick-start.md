# IM Overlay SDK — 商户快速接入指南

> 游戏内 IM 聊天 / 好友 / 房间 Overlay，和 Steam Overlay 同款体验。
> 帧内渲染 + 悬浮窗双模式，D3D11 / D3D12 / Vulkan / OpenGL 3 全后端支持。

---

## 你是哪种商户？

| 你的游戏 | 推荐接入方式 | 预计耗时 |
|---------|------------|---------|
| **Unity**（任何版本） | Unity 封装（零代码） | **5 分钟** |
| **Unreal Engine 5** | UE Plugin（Blueprint 节点） | **10 分钟** |
| **自研 C++ 引擎** | C++ SDK 直连（纯 C 接口） | **30 分钟** |
| **黑盒 exe（无源码）** | 不用 SDK，用 IM-Client 自动注入 Overlay | **0 分钟** |

---

## 通用前置条件（所有商户）

1. **IM-Client 主程序** — 玩家电脑上必须先安装 IM-Client（从官方下载）
2. **Windows 10 / 11（x64 推荐）** — SDK 是原生 DLL，不支持 macOS / Linux / 移动端
3. **游戏安装在本地** — SDK 通过 Named Pipe 和 IM-Client 主进程通信，主进程根据游戏 PID 自动建 pipe

### 玩家启动流程（商户不用担心，自动完成）

```
玩家点击游戏启动
    │
    ├─ IM-Client 主进程启动 IMOverlay.dll
    ├─ IMOverlay.dll 自动连接 \\.\pipe\im-overlay-<游戏PID>
    ├─ 默认帧内模式 → 等游戏 Present 前调 RenderPresent
    │                  ↓ 5 秒没调 → 自动启动悬浮窗兜底
    └─ 游戏运行 → Overlay 实时显示好友/消息/房间
```

---

## Unity 接入（最简方案）

### Step 1：复制文件

把 Unity 封装目录下的文件**整个复制**进 Unity 项目的 `Assets/` 目录：

```
复制前：sdk/unity/
复制后：Assets/
        ├── Plugins/
        │   ├── x64/
        │   │   └── IMOverlay.dll
        │   └── x86/
        │       └── IMOverlay.dll
        └── IMOverlay/
            ├── Runtime/
            │   ├── IMOverlay.cs
            │   ├── IMOverlayNative.cs
            │   ├── IMOverlayFrame.cs
            │   └── IMOverlay.Runtime.asmdef
            └── Editor/
                ├── IMOverlayMenuItem.cs
                └── IMOverlay.Editor.asmdef
```

### Step 2：让 Unity 自动处理 DLL

Unity 会根据 Plugins/x64/ 和 Plugins/x86/ 目录自动选对平台。  
**不需要手动配置 Plugin Inspector**（封装已经写好了 Runtime 自动 Init）。

### Step 3：添加 Overlay 到场景

Unity 菜单栏 → **Tools → IM Overlay → Add Overlay**

这会自动创建：
- 一个名为 `IMOverlay` 的 GameObject（自动挂到 Main Camera 上）
- 上面挂着 `IMOverlay` MonoBehaviour（自动 Init + Start）

**完事！** 运行游戏，IM Overlay 自动出现。

### Step 4（可选）：在代码里用帧数据

```csharp
// 你自己的聊天面板脚本
using IMOverlay;
using UnityEngine;

public class MyChatPanel : MonoBehaviour
{
    void Start()
    {
        // 订阅帧事件（主线程安全）
        IMOverlay.Instance.OnFrame += HandleFrame;
    }

    void HandleFrame(Frame f)
    {
        switch (f.Type)
        {
            case FrameType.Friends:
                // f.Friends[i].Username / .Nickname / .Online
                RefreshMyFriendListUI(f);
                break;
            case FrameType.Msg:
                // f.From / f.Name / f.Text — 收到私聊
                ShowChatBubble(f.From, f.Text);
                break;
            case FrameType.Room:
                // f.HasRoom / f.RoomPlayers
                UpdateRoomLobby(f);
                break;
            case FrameType.RoomChat:
                // f.Name / f.Text
                AppendRoomChatLine(f);
                break;
            case FrameType.Hotkey:
                // f.Vk / f.Ctrl / f.Shift — 热键配置下发
                RegisterHotkey((HotkeyKey)f.Vk, f.Ctrl != 0, f.Shift != 0);
                break;
        }
    }

    // 玩家点"发送"按钮
    public void OnSendButtonClick()
    {
        IMOverlay.Instance.SendChat(targetInput.text, messageInput.text);
    }
}
```

### Step 5（可选）：手动切换渲染模式

默认 Unity MonoBehaviour 会在 `LateUpdate` 里自动调 `RenderPresent`（帧内模式）。  
如果你的 Unity 用的不是 D3D11（比如 Vulkan），可以手动指定：

```csharp
void LateUpdate()
{
    // Unity 渲染 API 自动识别
    var graphicsSettings = UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null;
    if (PlayerSettings.GetGraphicsAPIs(BuildTarget.StandaloneWindows64).Any(a => a == UnityEngine.Rendering.GraphicsDeviceType.Vulkan))
    {
        // Vulkan 需要自己拿 device/queue/cmdBuffer（Unity 没公开 API）
        // 简化：让 SDK 自动悬浮窗兜底
    }
    else
    {
        // D3D11 自动 RenderPresent
        IMOverlay.Instance.RenderPresent(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    }
}
```

---

## Unreal Engine 5 接入

### Step 1：复制插件

把 UE 插件目录复制进 UE 项目的 `Plugins/` 目录：

```
复制前：sdk/ue5/Plugins/ImOverlay/
复制后：<YourProject>/Plugins/ImOverlay/
```

然后把编译好的 DLL 和 LIB 放进去：

```
Plugins/ImOverlay/
├── Binaries/Win64/IMOverlay.dll      ← 你的编译产物
├── Lib/Win64/IMOverlay.lib
└── ImOverlay.uplugin
```

### Step 2：启用插件

UE 编辑器 → **Edit → Plugins** → 搜索 "IM Overlay" → 勾上 **Enabled** → 重启 UE。

### Step 3：完成！

插件会在游戏启动时自动：
1. LoadLibrary IMOverlay.dll
2. 调 IMOVERLAY_Init（注册回调）+ IMOVERLAY_Start（启动后台线程）
3. GameViewportClient 上注册 OnEndFrame → 每帧自动 RenderPresent

**运行游戏，IM Overlay 自动出现。**

### Step 4（可选）：蓝图里用

打开任意 Level Blueprint 或 GameInstance Blueprint：

```
Event BeginPlay
  │
  ├── Get IM Overlay Subsystem (Game Instance)
  │
  └── Bind Event to OnFrame
        ├── → Branch (Branch: Type == Friends)
        │     → Refresh Friend Widget
        └── → Branch (Branch: Type == Msg)
              → Show Chat Toast

玩家点击"发送"按钮
  │
  └── [IM Overlay > Send] → Send Chat
        Target: To (string)
        Text: Message (string)
```

### Step 5（可选）：C++ 里用

```cpp
// 你的 GameMode BeginPlay
void AMyGameMode::BeginPlay()
{
    Super::BeginPlay();

    if (auto* Sub = GetGameInstance()->GetSubsystem<UImOverlaySubsystem>())
    {
        Sub->OnFrame.AddDynamic(this, &AMyGameMode::HandleFrame);
    }
}

void AMyGameMode::HandleFrame(const FImOverlayFrame& Frame)
{
    switch (Frame.Type)
    {
        case EImOverlayFrameType::Friends:
            // Frame.Friends 是 TArray<FImOverlayFriend>
            for (auto& f : Frame.Friends)
            {
                UE_LOG(LogTemp, Log, TEXT("[IM] Friend: %s (%s) Online=%d"),
                    *f.Username, *f.Nickname, f.Online);
            }
            break;
        case EImOverlayFrameType::Msg:
            // Frame.From / Frame.Name / Frame.Text
            break;
    }
}
```

---

## 自研 C++ 引擎接入

### Step 1：复制头文件 + DLL

```
sdk/dll/
├── IMOverlay.h            ← 对外头文件（唯一需要 #include 的）
├── IMOverlay.dll          ← 放游戏可执行文件同目录
└── IMOverlay.lib          ← link 用（Windows）
```

### Step 2：链接 DLL

**MSVC 项目：**
```
项目属性 → 链接器 → 输入 → 附加依赖项：IMOverlay.lib
项目属性 → 链接器 → 常规 → 附加库目录：sdk/dll/
```

**CMake 项目：**
```cmake
add_library(IMOverlay SHARED IMPORTED)
set_target_properties(IMOverlay PROPERTIES
    IMPORTED_LOCATION "sdk/dll/IMOverlay.dll"
    IMPORTED_IMPLIB   "sdk/dll/IMOverlay.lib"
)
target_link_libraries(YourGame PRIVATE IMOverlay)
```

### Step 3：代码示例（最简）

```cpp
#include "IMOverlay.h"
#include <windows.h>
#include <string>

// DLL 回调（后台线程触发，不要直接调引擎 API！）
// 简单做法：入队 → 主线程消费
struct FrameQueue {
    std::mutex mtx;
    std::vector<IMOVERLAY_Frame> frames;
};
static FrameQueue g_queue;

void IMOverlayCallback(const IMOVERLAY_Frame* frame, void* user) {
    std::lock_guard<std::mutex> lock(g_queue.mtx);
    g_queue.frames.push_back(*frame);
}

// 游戏启动时
void GameEngine::Start() {
    IMOVERLAY_Init(IMOverlayCallback, nullptr);
    IMOVERLAY_Start();  // 默认帧内模式
}

// 游戏引擎渲染 Present 前（帧内模式）
void GameEngine::PresentFrame(ID3D11Device* dev, ID3D11DeviceContext* ctx, ID3D11RenderTargetView* rtv) {
    // 先让引擎自己渲染
    // ... DrawIndexedPrimitive / Present ...

    // IM Overlay 帧内叠加
    IMOVERLAY_RenderPresent(dev, ctx, rtv);
}

// 游戏引擎主循环 Pump（每帧调）
void GameEngine::Tick() {
    std::vector<IMOVERLAY_Frame> local;
    {
        std::lock_guard<std::mutex> lock(g_queue.mtx);
        local.swap(g_queue.frames);
    }
    for (auto& f : local) {
        // 主线程消费帧数据，更新你的聊天 UI
        HandleFrame(f);
    }
}

// 发送私聊（玩家点发送按钮）
void OnSendButtonClick(const std::string& target, const std::string& text) {
    IMOVERLAY_SendChat(target.c_str(), text.c_str());
}

// 游戏退出
void GameEngine::Shutdown() {
    IMOVERLAY_Stop();
}
```

### Step 4：Vulkan 引擎接入

```cpp
void GameEngine::PresentVulkan(
    VkDevice device, VkQueue queue, VkCommandBuffer cmdBuf,
    VkRenderPass rp, VkFramebuffer fb, int w, int h)
{
    // 引擎自己的 vkCmdEndRenderPass / vkQueuePresentKHR
    // ...

    // IM Overlay（Vulkan 后端）
    IMOVERLAY_RenderPresentVulkan(
        (uint64_t)device, (uint64_t)queue, (uint64_t)cmdBuf,
        (uint64_t)rp, (uint64_t)fb, w, h);
}
```

**约束（商户需注意）：**
- 你的 `renderPass` 必须绑定 `VK_ATTACHMENT_LOAD_OP_LOAD`（保留 backbuffer 给 ImGui 叠加绘制）
- `cmdBuf` 必须处于 recording 状态（`vkBeginCommandBuffer` 已调）

### Step 5：OpenGL 引擎接入

```cpp
void GameEngine::SwapBuffers() {
    // 引擎自己的 glFlush / SwapBuffers
    // ...

    // IM Overlay（OpenGL 3+ 后端，零参数）
    IMOVERLAY_RenderPresentGL();
}
```

### 悬浮窗模式（不调 RenderPresent 也行）

如果你的引擎没有渲染钩子可以挂（或者你根本不想管），**跳过 Step 3 的 RenderPresent 调用**，SDK 会自动：

```
IMOVERLAY_Start()
    │
    ├─ 默认帧内模式（等 RenderPresent）
    ├─ 5 秒过去还没收到任何 RenderPresent* 调用
    ├─ 自动 StartFloatingWindow()（创建透明覆盖窗）
    └─ 启动独立 D3D11 渲染线程（60FPS 画 ImGUI 面板）
```

**悬浮窗 = 零商户配置，自动兜底。**

---

## 常见问题 FAQ

### Q1：Overlay 面板的文字/按钮点不到？

**A：** 默认 Overlay 透明悬浮窗有 `WS_EX_TRANSPARENT`（点击穿透游戏）。  
需要玩家按热键（默认 `Shift+Tab`）激活 Overlay 输入模式才能点击面板。  
热键由主进程 IM-Client 配置下发（SDK 收到 `Hotkey` 帧）。

### Q2：全屏独占模式下悬浮窗消失了？

**A：** 全屏独占（Exclusive Fullscreen）时操作系统不会合成覆盖窗。  
请让玩家用 **窗口化全屏**（Borderless Windowed），或者你的引擎提供 D3D11/D3D12 设备指针让 SDK 走**帧内渲染**模式。

### Q3：和 Steam Overlay / Discord Overlay 冲突吗？

**A：** 不冲突。IM Overlay 用独立的 pipe 协议和主进程通信，和 Steam/Discord 的 hook 互不干扰。  
如果三者都在同画面渲染，各自画各自的 — 可能有点重叠，但互不影响。

### Q4：反作弊拦截吗？

**A：** 零风险。
- **帧内模式**：和游戏自己画 UI 一样，正常 D3D/Vulkan API 调用
- **悬浮窗模式**：独立 HWND 和 Notepad 窗口一样，不注入游戏进程

### Q5：DLL 文件太大（1.5MB）能减小吗？

**A：** 可以，有两个选项：
1. **剥离 ImGUI**：不用内置 UI，商户自己渲染面板（纯数据收发器 ~100KB）
2. **只链接需要的后端**：比如只链接 D3D11，去掉 Vulkan/OpenGL 后端（~800KB）

### Q6：DLL 版本升级后商户需要改代码吗？

**A：** 不需要。SDK 保证：
- 导出函数签名向后兼容（字段只增不删）
- 新版本 DLL 替换旧文件就行，游戏客户端零改动
- 协议层（pipe NDJSON）也向后兼容

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0.0 | 2026-11-12 | 首个正式版 — C++ DLL 核心 + 渲染引擎（五后端 + 帧内/悬浮窗） + Unity C# 封装 + UE 5 Plugin |

---

## 技术支持

接入过程中遇到问题？联系 IM-Client 官方技术支持，附日志（游戏目录下 `im-overlay.log`）。
