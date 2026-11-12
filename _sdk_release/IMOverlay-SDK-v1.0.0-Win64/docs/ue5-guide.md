# IM Overlay SDK — Unreal Engine 5 详细接入指南

> 适用 UE 版本：UE 5.0 ~ 5.5（5.3+ 推荐）
> 目标平台：Windows 64-bit（`Win64`）
> 接入耗时：**10 分钟（最简）~ 1 小时（完整自定义）**

---

## 一、快速开始（最简接法）

### Step 1：复制插件目录

把 `sdk/ue5/Plugins/ImOverlay/` **整个目录**复制到 UE 项目的 `Plugins/` 下：

```
你的项目/
├── Plugins/
│   └── ImOverlay/              ← 从 SDK 包里整个拷
│       ├── ImOverlay.uplugin
│       ├── Binaries/Win64/IMOverlay.dll
│       ├── Lib/Win64/IMOverlay.lib
│       ├── Include/IMOverlay.h
│       └── Source/ImOverlay/
└── Source/
```

### Step 2：启用插件

UE 编辑器 → **Edit → Plugins** → 搜索 "IM Overlay" → 勾上 **Enabled** → 点击弹窗 **Yes** 重启 UE。

### Step 3：完事！

插件自动完成：
1. `LoadLibrary IMOverlay.dll`
2. `IMOVERLAY_Init(OnFrameCallback, nullptr)` — 注册帧回调（DLL 后台线程 → Subsystem 队列）
3. `IMOVERLAY_Start()` — 启动后台 pipe 收帧线程
4. 渲染钩子自动注册（5 秒内没拿到 D3D 设备 → SDK 自动悬浮窗兜底）

**运行游戏，IM Overlay 自动连接 IM-Client。**

### Step 4（可选）：验证

运行游戏后看 **Output Log**（`Window → Developer Tools → Output Log`）：
```
LogTemp: [ImOverlay] IMOVERLAY_Start rc=0
```

---

## 二、架构总览

### 2.1 UE 5 Plugin 内部架构

```
┌─────────────────────────────────────────────────────────┐
│                  UE 5 游戏进程                           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ ImOverlay Plugin (模块)                           │    │
│  │ ┌──────────────┐  ┌──────────────────────────┐  │    │
│  │ │ Plugin.cpp    │  │ Subsystem (UGameInstance) │  │    │
│  │ │ ├─ LoadLibrary│  │ ├─ 帧队列 (线程安全)      │  │    │
│  │ │ ├─ Init/Start │  │ ├─ OnTick Pump → 委托     │  │    │
│  │ │ └─ Shutdown   │  │ └─ SendChat/Render* ...  │  │    │
│  │ └──────────────┘  └──────────────────────────┘  │    │
│  │                                                   │    │
│  │  ┌──────────────┐  ┌──────────────┐             │    │
│  │  │ BPLibrary     │  │ RenderHook    │             │    │
│  │  │ (蓝图节点)    │  │ (帧内渲染)   │             │    │
│  │  └──────────────┘  └──────────────┘             │    │
│  └─────────────────────────────────────────────────┘    │
│                    ↓ 链接                               │
│  ┌─────────────────────────────────────────────────┐    │
│  │ IMOverlay.dll (原生 C)                            │    │
│  │ ├─ Pipe 连接 \\.\pipe\im-overlay-<PID>           │    │
│  │ ├─ 后台线程收帧 (NDJSON 协议)                     │    │
│  │ ├─ 渲染引擎 (ImGUI 五后端)                       │    │
│  │ └─ 悬浮窗兜底 (5s 未调 RenderPresent* 自动启动)    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         ↑ Named Pipe (跨进程)    ↑ NDJSON 协议
┌─────────────────────────────────────────────────────────┐
│            IM-Client 主进程（Electron）                  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 线程模型

| 线程 | 角色 |
|------|------|
| **游戏线程 (GameThread)** | `Subsystem.OnTick` → Pump 帧 → 触发 Blueprint/C++ 委托。商户在这里更新 UMG UI。 |
| **渲染线程 (RenderThread)** | `RenderHook.OnEndFrame` → 调 `IMOVERLAY_RenderPresent`（帧内渲染）。也由 Subsystem 的 `OnEndFrameRenderThread` 提供。 |
| **DLL 后台线程** | `workerLoop` → pipe 收帧 → 回调 `OnDllFrame`（DLL 端）→ 入队 Subsystem |

⚠️ **千万不要在 DLL 回调里调 UE API**！已经由 Plugin 内部桥接好了：
- DLL 回调 (`OnDllFrame`) → `Subsystem.EnqueueFrame()` → 锁入队
- `Subsystem.OnTick` → 锁出队 → `OnFrame.Broadcast()` → 商户

---

## 三、蓝图用法（零 C++ 代码）

### 3.1 绑定帧事件

打开你的 **Level Blueprint** 或 **GameInstance Blueprint**：

```
Event BeginPlay
  │
  ├── Get Game Instance
  │
  ├── Get IM Overlay Subsystem
  │     (节点分类: Gameplay > IM Overlay)
  │
  └── Bind Event to OnFrame
        │
        ├── ↓ Event (触发时带 Frame 参数)
        │     ├── Branch (Branch: Frame Type == Friends)
        │     │     → Refresh Friend Widget
        │     ├── Branch (Branch: Frame Type == Msg)
        │     │     → Show Chat Toast Widget
        │     ├── Branch (Branch: Frame Type == Room)
        │     │     → Update Lobby Widget
        │     └── Branch (Branch: Frame Type == RoomChat)
        │           → Append Chat Log
```

### 3.2 Frame（帧数据）蓝图节点

`OnFrame` 事件传一个 `FImOverlayFrame` 参数，里面包含：

| 属性 | 类型 | 说明 |
|------|------|------|
| `Type` | `EImOverlayFrameType` (Enum) | 帧类型 |
| `U` / `From` / `Name` / `To` / `Text` / `Action` / `Mode` | `FString` | 各字段 |
| `RoomId` / `Vk` / `Ctrl` / `Shift` / `Alt` / `W` / `H` | `int32` | 数值字段 |
| `Friends` | `TArray<FImOverlayFriend>` | 好友列表（Friends 帧） |
| `HasRoom` | `bool` | 是否在房间里 |
| `RoomPlayers` | `TArray<FImOverlayPlayer>` | 房间成员（Room 帧） |
| `FollowAll` | `bool` | 是否关注所有人 |
| `FollowList` | `TArray<FString>` | 关注名单 |

#### EImOverlayFrameType 枚举

| 值 | 含义 |
|----|------|
| Unknown (0) | 忽略 |
| HelloAck (1) | 握手成功 |
| Me (2) | 我的账号 |
| Friends (3) | 好友全量快照 |
| Msg (4) | 私聊消息 |
| Room (5) | 房间快照 |
| RoomChat (6) | 房间聊天 |
| Avatar (7) | 好友头像 |
| Hotkey (8) | 热键配置 |
| Follow (9) | 关注名单 |

### 3.3 上行帧（蓝图节点）

**分类 `IM Overlay > Send`：**

| 节点 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| **Send Chat** | `To` (String), `Text` (String) | `int32` | 发送私聊 |
| **Send Room Ready** | `RoomId` (Integer) | `int32` | 房间准备 |
| **Send Room Leave** | `RoomId` (Integer) | `int32` | 房间离开 |
| **Send Room Chat** | `RoomId` (Integer), `Text` (String) | `int32` | 房间聊天 |

**分类 `IM Overlay > Overlay`：**

| 节点 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| **Set Overlay Open** | `Open` (Boolean) | `int32` | 显示/隐藏悬浮窗 |
| **Show Panel** | （无） | `int32` | 强制面板显示 |
| **Set Overlay Rect** | `X`, `Y`, `W`, `H` (Integer) | `int32` | 悬浮窗位置尺寸 |

**分类 `IM Overlay > Query`：**

| 节点 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| **Is Overlay Running** | （无） | `bool` | 是否正在运行 |
| **Get Overlay Version** | （无） | `FString` | SDK 版本号 |

### 3.4 蓝图完整示例（私聊 UI）

```
玩家点击"发送"按钮 (UI Button OnClicked)
  │
  ├── Send Chat
  │     To: FriendUsername (String)
  │     Text: ChatInputText (String)
  │     → (int32) 0=成功
  │
  └── Set Chat Input Text (清空输入框)
```

---

## 四、C++ 用法

### 4.1 获取 Subsystem

```cpp
#include "ImOverlaySubsystem.h"
#include "Engine/GameInstance.h"

void AMyGameMode::BeginPlay()
{
    Super::BeginPlay();
    
    UGameInstance* GI = GetGameInstance();
    if (!GI) return;
    
    UImOverlaySubsystem* Sub = GI->GetSubsystem<UImOverlaySubsystem>();
    if (!Sub) {
        UE_LOG(LogTemp, Warning, TEXT("ImOverlay Subsystem not found"));
        return;
    }
    
    // 绑定帧委托（GameThread 安全）
    Sub->OnFrame.AddDynamic(this, &AMyGameMode::HandleIMFrame);
}
```

### 4.2 处理帧数据

```cpp
void AMyGameMode::HandleIMFrame(const FImOverlayFrame& Frame)
{
    switch (Frame.Type)
    {
        case EImOverlayFrameType::Friends:
            for (const FImOverlayFriend& Friend : Frame.Friends)
            {
                UE_LOG(LogTemp, Log, TEXT("[IM] Friend: %s (%s) Online=%d"),
                    *Friend.Username, *Friend.Nickname, Friend.Online);
            }
            // 刷新 UMG 好友列表
            FriendListWidget->Refresh(Frame.Friends);
            break;
            
        case EImOverlayFrameType::Msg:
            // Frame.From, Frame.Name, Frame.Text
            ChatLogWidget->AppendMessage(Frame.From, Frame.Name, Frame.Text);
            break;
            
        case EImOverlayFrameType::Room:
            if (!Frame.HasRoom) {
                LobbyWidget->Show();
                RoomWidget->Hide();
            } else {
                RoomWidget->Refresh(Frame.RoomId, Frame.RoomPlayers);
            }
            break;
            
        case EImOverlayFrameType::RoomChat:
            RoomWidget->AppendChat(Frame.Name, Frame.Text);
            break;
    }
}
```

### 4.3 上行帧

```cpp
// 发送私聊（在任何 GameThread 函数里）
void AMyPlayerController::SendChatToFriend(const FString& Target, const FString& Message)
{
    auto* Sub = GetGameInstance()->GetSubsystem<UImOverlaySubsystem>();
    if (Sub) {
        int32 Rc = Sub->SendChat(Target, Message);
        if (Rc != 0) {
            UE_LOG(LogTemp, Warning, TEXT("SendChat failed rc=%d"), Rc);
        }
    }
}
```

### 4.4 渲染钩子（进阶）

默认插件会自动尝试帧内渲染。如果你想自己控制，Subsystem 提供：

```cpp
// 在 RenderThread 上渲染（自己拿到 D3D 设备后调）
void AMyGameMode::OnMyRenderHook(void* Dev, void* Ctx, void* RTV)
{
    auto* Sub = GetGameInstance()->GetSubsystem<UImOverlaySubsystem>();
    if (Sub) {
        Sub->OnEndFrameRenderThread(Dev, Ctx, RTV);
    }
}
```

⚠️ `OnEndFrameRenderThread` 必须在 **RenderThread** 上调，不能在 GameThread 调。

---

## 五、UMG 集成示例

### 5.1 好友列表 Widget

```cpp
// FriendListWidget.h
UCLASS()
class UFriendListWidget : public UUserWidget
{
    GENERATED_BODY()
    
public:
    UFUNCTION(BlueprintCallable)
    void Refresh(const TArray<FImOverlayFriend>& Friends);
    
protected:
    UPROPERTY(meta = (BindWidget))
    UVerticalBox* FriendListBox;
    
    UPROPERTY()
    TSubclassOf<UFriendItemWidget> FriendItemClass;
};

// FriendListWidget.cpp
void UFriendListWidget::Refresh(const TArray<FImOverlayFriend>& Friends)
{
    FriendListBox->ClearChildren();
    
    for (const FImOverlayFriend& F : Friends)
    {
        UFriendItemWidget* Item = CreateWidget<UFriendItemWidget>(this, FriendItemClass);
        Item->UsernameText->SetText(FText::FromString(F.Username));
        Item->NicknameText->SetText(FText::FromString(F.Nickname));
        Item->OnlineIndicator->SetVisibility(F.Online ? ESlateVisibility::Visible : ESlateVisibility::Collapsed);
        FriendListBox->AddChildToVerticalBox(Item);
    }
}
```

### 5.2 聊天 Toast Widget（收到消息时弹出）

```cpp
void AMyGameMode::HandleIMFrame(const FImOverlayFrame& Frame)
{
    if (Frame.Type == EImOverlayFrameType::Msg)
    {
        // 创建 Toast Widget
        UChatToastWidget* Toast = CreateWidget<UChatToastWidget>(this, ToastClass);
        Toast->FromText->SetText(FText::FromString(Frame.Name));
        Toast->TextText->SetText(FText::FromString(Frame.Text));
        Toast->AddToViewport();
        
        // 3 秒后自动消失
        GetWorldTimerManager().SetTimerForNextTick([this, Toast]() {
            Toast->RemoveFromParent();
        });
    }
}
```

---

## 六、配置与自定义

### 6.1 插件启用配置

`ImOverlay.uplugin` 的结构：

```json
{
    "FileVersion": 3,
    "Version": 1,
    "VersionName": "1.0.0",
    "FriendlyName": "IM Overlay",
    "Description": "游戏内 IM 聊天 / 好友 / 房间 Overlay",
    "Category": "Gameplay",
    "Installed": true,
    "Modules": [
        {
            "Name": "ImOverlay",
            "Type": "Runtime",
            "LoadingPhase": "Default",
            "PlatformAllowList": ["Win64", "Win32"]
        }
    ]
}
```

`LoadingPhase: "Default"` 意味着插件在游戏主模块加载时初始化（StartupModule → Init → Start）。

### 6.2 渲染模式选择

插件提供两种渲染模式，**自动选择**：

| 模式 | 触发条件 | 说明 |
|------|---------|------|
| **帧内渲染** | 成功拿到 D3D11/D3D12 设备指针并调 RenderPresent | 和你的游戏画面合成，全屏独占也能显示 |
| **悬浮窗兜底** | 5 秒内没拿到 D3D 设备指针 | 独立 DX11 窗口，帧内渲染失败时自动切 |

商户 **不需要手动管**。帧内渲染是默认，拿不到设备 → 自动悬浮窗。

### 6.3 主题色 / 字体（插件预留接口）

当前插件没有暴露 `SetThemeColor` / `SetFont` 的蓝图节点（因为这是 Overlay ImGUI 面板自己的样式，商户一般不需要改）。如果需要，可以加一个 `SetThemeColor` 到 BPLibrary。

---

## 七、常见问题 FAQ

### Q1：插件加载失败，Output Log 里有 "IMOverlay.dll not found"？

**A**：检查文件路径：
```
Plugins/ImOverlay/Binaries/Win64/IMOverlay.dll
Plugins/ImOverlay/Lib/Win64/IMOverlay.lib
Plugins/ImOverlay/Include/IMOverlay.h
```
三个都要有。Build.cs 里有自动检测，找不到会打印 WARNING。

### Q2：帧内渲染不工作（全屏游戏里 Overlay 看不到）？

**A**：帧内渲染需要 UE 的 RenderHook 成功拿到 D3D 设备指针。当前 RenderHook 实现简化处理了这部分（没硬编码 UE RDG 内部 API）。

**解决**：让 SDK 自动悬浮窗兜底（默认行为）。或者你自己在 RenderThread 上拿到 D3D 设备后手动调 Subsystem 的 `OnEndFrameRenderThread`。

### Q3：收到 Msg 帧但 UMG Widget 不更新？

**A**：检查：
1. 你的 Widget 是在 **GameThread** 上创建和操作的（Plugin 的 `OnFrame` 委托是 GameThread 安全的）
2. 委托绑定是动态委托（`AddDynamic`），不是静态
3. Widget 已 `AddToViewport()`

### Q4：反作弊拦截吗？

**A**：零风险：
- Plugin 是标准 UPlugin，LoadLibrary + 正常 Named Pipe 客户端
- 帧内渲染是正常 D3D API 调用
- 悬浮窗是独立 HWND（不注入游戏进程）

### Q5：游戏崩溃时 SDK 会泄漏吗？

**A**：`ShutdownModule()` 会调 `IMOVERLAY_Stop()` 等线程退出 + `FreeLibrary`。如果游戏被 Task Manager 强杀，操作系统会清理所有线程和句柄。

### Q6：UE 5.3+ RDG 渲染管线兼容吗？

**A**：兼容。SDK 的帧内渲染不依赖 UE 的 RDG，是独立的 D3D11/D3D12 ImGui 后端。RDG 渲染完成后，RenderThread 上的 OnEndFrame 回调已经在合适的时机。

---

## 八、发布 Checklist

- [x] 项目 `Plugins/ImOverlay/` 目录下 3 个关键文件都有（.dll / .lib / .h）
- [x] UE Editor 里 Plugins 面板已启用 "IM Overlay"
- [x] 运行时测试：PIE 模式下 Output Log 有 `IMOVERLAY_Start rc=0`
- [x] UMG Widget 测试：收到好友帧 → Widget 刷新
- [x] 全屏独占测试：Overlay 帧内渲染或自动悬浮窗兜底
- [x] 退出游戏测试：Output Log 无遗留错误
- [x] Packaging 测试：打包 Standalone Win64 → 运行正常（Plugin 是 Runtime 模块，会自动打包）
