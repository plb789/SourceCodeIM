# IM Overlay SDK — Unity 详细接入指南

> 适用 Unity 版本：2020.3 LTS ~ 2026.x（任何渲染管线）
> 目标平台：Windows Standalone（x64 / x86）
> 接入耗时：**5 分钟（最简）~ 2 小时（完整自定义 UI）**

---

## 一、准备工作

### 1.1 你需要什么

| 物品 | 来源 |
|------|------|
| `sdk/unity/` 整个目录 | IM-Client SDK 发布包 |
| `IM-Client` 主程序 | 玩家电脑上先装好（游戏外跑的客户端） |
| Unity 2020.3+ | 你的项目 |

### 1.2 Unity 封装里有什么

```
sdk/unity/
├── Plugins/
│   ├── x64/IMOverlay.dll      ← 编译好的 DLL（Editor + Standalone 用）
│   └── x86/IMOverlay.dll      ← 32 位版本（可选，Windows 10 ARM 设备）
├── Runtime/
│   ├── IMOverlay.cs           ← 单例门面（商户主要用这个）
│   ├── IMOverlayNative.cs     ← P/Invoke 层（内部用）
│   ├── IMOverlayFrame.cs      ← 托管帧数据结构
│   └── IMOverlay.Runtime.asmdef
└── Editor/
    ├── IMOverlayMenuItem.cs   ← 一键添加 Overlay 菜单
    └── IMOverlay.Editor.asmdef
```

Unity 会自动根据 `Plugins/x64` / `Plugins/x86` 选择正确的 DLL，**不需要手动配置 Plugin Inspector**。

---

## 二、最简接法（5 分钟）

### Step 1：复制文件

把 `sdk/unity/` 目录**整个复制**到 Unity 项目的 `Assets/` 下。目录结构保持不变。

### Step 2：添加 Overlay

Unity 菜单栏 → **Tools → IM Overlay → Add Overlay**

这会自动创建：
- 一个名为 `IMOverlay` 的 GameObject（自动挂到 Main Camera 上）
- 上面挂着 `IMOverlay` MonoBehaviour

**完事！** 运行游戏，IM Overlay 自动连接 IM-Client，5 秒内没调帧内渲染就自动悬浮窗兜底。

### Step 3（可选）：验证是否成功

运行游戏后看 Unity Console：
```
[IMOverlay] Start rc=0    ← 启动成功
```

如果 IM-Client 主程序没开：
```
[IMOverlay] Start rc=-3   ← Pipe 连接失败（正常，后台会自动重连）
```

### Step 4（可选）：手动控制渲染模式

默认 Unity MonoBehaviour 会在 `LateUpdate` 里自动调 `RenderPresent`（D3D11 自动识别）。

如果你的 Unity 用的是 **Vulkan 渲染后端**：
```csharp
// 在自己的 MonoBehaviour 里
void Update() {
    // Unity 的 Vulkan API 没公开 device/queue/cmdBuffer 给外部
    // 简化：让 SDK 自动悬浮窗兜底（5 秒后自动启动）
    // 或者用自己的 Vulkan 插件拿 device 指针后调：
    // IMOverlay.Instance.RenderPresentVulkan(device, queue, cmdBuf, rp, fb, w, h);
}
```

---

## 三、帧数据详解

### 3.1 Frame 类（核心数据结构）

SDK 每收到一帧，`Frame` 事件就触发一次。在你的 MonoBehaviour 里订阅：

```csharp
using IMOverlay;
using UnityEngine;

public class MyGameUI : MonoBehaviour
{
    void Start()
    {
        IMOverlay.Instance.OnFrame += HandleFrame;
    }

    void OnDestroy()
    {
        IMOverlay.Instance.OnFrame -= HandleFrame;  // 记得取消订阅！
    }

    void HandleFrame(Frame frame)
    {
        // 这里是 Unity 主线程，安全调任何 UnityEngine API
        switch (frame.Type)
        {
            case FrameType.Friends:    HandleFriends(frame);    break;
            case FrameType.Msg:        HandleMsg(frame);        break;
            case FrameType.Room:       HandleRoom(frame);       break;
            case FrameType.RoomChat:   HandleRoomChat(frame);   break;
            case FrameType.Hotkey:     HandleHotkey(frame);     break;
            case FrameType.Me:         HandleMe(frame);         break;
            case FrameType.Avatar:     HandleAvatar(frame);     break;
            case FrameType.Follow:     HandleFollow(frame);     break;
        }
    }
}
```

### 3.2 各帧类型详细说明

#### FrameType.Friends（好友全量快照）

**触发时机**：IM-Client 启动时 / 好友列表变化时（全量推送，不是增量）

```csharp
void HandleFriends(Frame f)
{
    // f.Friends 是 List<Friend>，每个 Friend 有：
    //   .Username  → IM 账号（如 "alice"）
    //   .Nickname  → 显示名（如 "爱丽丝"）
    //   .Online    → bool

    Debug.Log($"收到好友列表，共 {f.Friends.Count} 人");
    foreach (Friend friend in f.Friends)
    {
        Debug.Log($"  {friend.Username} ({friend.Nickname}) online={friend.Online}");
    }

    // 更新你的 UGUI/UI Toolkit 好友列表
    friendListUI.Refresh(f.Friends);
}
```

#### FrameType.Msg（私聊消息）

**触发时机**：收到私聊消息时（实时）

```csharp
void HandleMsg(Frame f)
{
    // f.From  → 发送者 username（如 "bob"）
    // f.Name  → 发送者显示名（如 "鲍勃"）
    // f.Text  → 消息正文
    // f.To    → 接收者（应该是你自己的 Me.U）

    Debug.Log($"[{f.Name}] {f.Text}");

    // 在游戏界面显示聊天气泡
    chatBubble.Show(f.Name, f.Text);

    // 或者在大厅聊天面板里追加一行
    chatLog.Append(f.Name, f.Text);
}
```

#### FrameType.Room（房间快照）

**触发时机**：房间状态变化时（进入房间 / 房间内成员变化 / 房间解散）

```csharp
void HandleRoom(Frame f)
{
    // f.HasRoom     → 是否在房间里（false 表示房间被解散或你已离开）
    // f.RoomId      → 房间 ID（int）
    // f.RoomPlayers → List<Player>（房间内所有人，包括自己）

    if (!f.HasRoom)
    {
        // 房间解散了 / 你不在房里
        lobbyUI.Show();
        roomUI.Hide();
        return;
    }

    Debug.Log($"房间 {f.RoomId}，共 {f.RoomPlayers.Count} 人");
    foreach (Player p in f.RoomPlayers)
    {
        Debug.Log($"  {p.Username} ({p.Nickname})");
    }

    roomUI.Refresh(f.RoomPlayers);
}
```

#### FrameType.RoomChat（房间聊天）

**触发时机**：房间内有人发聊天时（实时）

```csharp
void HandleRoomChat(Frame f)
{
    // f.Name → 发送者显示名
    // f.Text → 消息正文

    roomChatUI.Append(f.Name, f.Text);
}
```

#### FrameType.Hotkey（热键配置下发）

**触发时机**：IM-Client 启动时 / 用户改了热键配置时

```csharp
void HandleHotkey(Frame f)
{
    // f.Vk     → Virtual-Key Code（如 9=Tab）
    // f.Ctrl   → 是否要 Ctrl 组合
    // f.Shift  → 是否要 Shift 组合
    // f.Alt    → 是否要 Alt 组合

    Debug.Log($"IM Overlay 热键: {(f.Ctrl ? "Ctrl+" : "")}{(f.Shift ? "Shift+" : "")}{(f.Alt ? "Alt+" : "")}键{f.Vk}");

    // 注册 Unity 端的热键监听（让玩家也能在游戏里按这个快捷键打开 Overlay）
    // 注意：这个热键是 IM-Client 主进程全局监听的，游戏进程只需要记录显示
}
```

#### FrameType.Me（我的账号）

**触发时机**：握手成功时 / 用户切换账号时

```csharp
void HandleMe(Frame f)
{
    // f.U → 我的 IM 账号
    Debug.Log($"我是 {f.U}");
    playerUI.SetUsername(f.U);
}
```

#### FrameType.Avatar（好友头像）

**触发时机**：好友列表推送后，逐个头像下发

```csharp
void HandleAvatar(Frame f)
{
    // f.U     → 头像所属好友的 username
    // f.Text  → 头像数据（BGRA base64 编码）
    // f.W, f.H → 像素尺寸（固定 48×48）

    // base64 → byte[] → Texture2D
    byte[] bytes = Convert.FromBase64String(f.Text);
    var tex = new Texture2D(f.W, f.H, TextureFormat.BGRA32, false);
    tex.LoadRawTextureData(bytes);
    tex.Apply();

    friendListUI.SetAvatar(f.U, tex);
}
```

#### FrameType.Follow（关注名单）

**触发时机**：关注配置变化时

```csharp
void HandleFollow(Frame f)
{
    // f.FollowAll   → true 表示关注所有人
    // f.FollowList  → List<string>（关注名单里的 username）
    Debug.Log($"关注所有人={f.FollowAll}，名单={f.FollowList.Count}人");
}
```

### 3.3 帧队列深度保护

SDK 内部每帧 Pump 最多 256 帧（防止堆积）。如果你的游戏里 Overlay 面板关着但 IM-Client 消息轰炸，队列可能被截断。

**建议**：你的游戏 UI 打开好友面板时才订阅 `OnFrame`，关掉时取消订阅。或者在 HandleFrame 里自己做批量处理。

---

## 四、上行帧（主动发送）

### 4.1 发送私聊

```csharp
// 玩家点"发送"按钮
public void OnSendButtonClick()
{
    string target = targetInput.text;   // "alice"
    string message = messageInput.text; // "你好！"
    
    int rc = IMOverlay.Instance.SendChat(target, message);
    if (rc != 0) Debug.LogWarning($"SendChat failed rc={rc}");
}
```

### 4.2 房间操作

```csharp
// 玩家点击"准备"
public void OnReadyButtonClick()
{
    IMOverlay.Instance.SendRoomReady(currentRoomId);
}

// 玩家点击"离开房间"
public void OnLeaveRoomButtonClick()
{
    IMOverlay.Instance.SendRoomLeave(currentRoomId);
}

// 房间内聊天
public void OnRoomChatSend()
{
    IMOverlay.Instance.SendRoomChat(currentRoomId, roomChatInput.text);
}
```

### 4.3 面板状态上报（可选）

告诉 IM-Client 主进程："我的游戏内 IM 面板打开了，你的悬浮窗让位"。

```csharp
void OnImPanelOpenChanged(bool open)
{
    IMOverlay.Instance.SendPanelOpen(open);
}
```

---

## 五、样式定制

### 5.1 主题色

```csharp
void Start()
{
    // 在 Init 之前调（也可以在之后，但 Start 前最好）
    IMOverlay.Instance.Init();
    
    // 比如你的游戏主色调是绿色
    IMOverlay.Instance.SetThemeColor(52, 199, 89);  // RGB 0~255
    
    IMOverlay.Instance.Start();
}
```

### 5.2 自定义字体（可选）

如果你的游戏用了自定义字体（支持中文/日文/韩文），可以让 Overlay 面板也用这个字体，风格统一。

```csharp
// 比如把项目里的 Font.ttf 路径读进来
IEnumerator LoadCustomFont()
{
    string ttfPath = Path.Combine(Application.streamingAssetsPath, "fonts/MyCustom.ttf");
    byte[] data = File.ReadAllBytes(ttfPath);
    
    // SetFont 需要在 Init / Start 之后调
    while (!IMOverlay.Instance.IsRunning()) yield return null;
    
    IMOverlay.Instance.SetFont(data, data.Length, 16f);  // 16px
}
```

---

## 六、生命周期管理

### 6.1 自动模式（推荐）

`IMOverlay` MonoBehaviour 的 `Awake` 里自动调 `Init()`，`Update` 里自动 Pump 帧，`LateUpdate` 里自动 RenderPresent，`OnDestroy` 里自动 Shutdown。

**最简接法 = 零代码**（只要加个 MonoBehaviour 就行）。

### 6.2 手动模式

如果你想自己控制时机：

```csharp
public class GameBootstrap : MonoBehaviour
{
    void Start()
    {
        // 手动 Init（注册回调）
        bool ok = IMOverlay.Instance.Init();
        if (!ok) { Debug.LogError("IMOverlay Init failed"); return; }
        
        // 手动 Start（启动后台线程）
        IMOverlay.Instance.Start();
    }

    void Update()
    {
        // 手动 Pump 帧（主线程消费）
        IMOverlay.Instance.PumpFrames();  // 内置 Update 里已经自动调了，手动模式才需要
    }

    void OnDestroy()
    {
        IMOverlay.Instance.Shutdown();
    }
}
```

### 6.3 DontDestroyOnLoad

Unity 封装自动做了 `DontDestroyOnLoad(gameObject)`，场景切换不会丢。

---

## 七、多场景 / 多 Canvas 注意事项

### 7.1 UGUI Canvas 上显示聊天气泡

Overlay SDK 自己画 ImGUI 面板（悬浮窗里），但**不画你的游戏原生 UI**。你需要用 UGUI / UI Toolkit 自己画聊天气泡 / 好友列表。

**典型做法**：
1. 场景里有一个 UGUI Canvas（Screen Space - Overlay 或 Camera）
2. Canvas 上挂你的聊天 UI 脚本（订阅 `OnFrame`）
3. 收到 Msg 帧 → 实例化一个聊天气泡 Prefab 加到 Canvas 上

### 7.2 多 Canvas 冲突

Overlay 悬浮窗的 ImGUI 是顶层 HWND 独立窗口，和 Unity 的 Canvas 完全隔离，**不会冲突**。

帧内渲染模式下，ImGUI 画在 D3D11/D3D12 的 backbuffer 上，也在 Canvas 背后（Canvas 是引擎后期画的）。

---

## 八、常见问题 FAQ

### Q1：Overlay 面板的文字 / 按钮点不到？

**A**：悬浮窗模式下 Overlay 默认有 `WS_EX_TRANSPARENT`（点击穿透到游戏）。玩家需要按热键（默认 `Shift+Tab`，由 IM-Client 配置）激活输入模式才能点击面板。

### Q2：全屏独占模式下悬浮窗消失？

**A**：全屏独占（Exclusive Fullscreen）时操作系统不会合成覆盖窗。解决：
1. 让玩家用 **窗口化全屏**（Borderless Windowed）
2. 或者用帧内渲染模式（传 D3D11/D3D12 设备指针给 SDK）

### Q3：DLL 找不到 / DllNotFoundException？

**A**：Unity Editor 里 DLL 应该在 `Assets/Plugins/x64/IMOverlay.dll`。检查：
- 文件是否存在
- Unity Console 里有没有 "DllNotFoundException: IMOverlay"
- 确认 `Runtime/IMOverlayRuntime.asmdef` 没有把 Plugins 目录排除

### Q4：和 Steam Overlay / Discord Overlay 冲突？

**A**：不冲突。各自画各自的 Overlay，管道独立。如果三者叠加可能有点重叠，但互不影响。

### Q5：反作弊拦截吗？

**A**：零风险：
- 帧内模式：和游戏自己画 UI 一样，正常 D3D API 调用
- 悬浮窗模式：独立 HWND，和 Notepad 窗口一样，不注入游戏进程
- SDK 只创建 Named Pipe 客户端连接 IM-Client 主进程，不做任何注入

### Q6：游戏退出时 SDK 还在跑？

**A**：MonoBehaviour 的 `OnDestroy` 会自动调 `IMOVERLAY_Stop()`。但如果游戏被 Task Manager 强杀，SDK 后台线程会被操作系统强制清理，不会泄漏。

### Q7：多人游戏里每个人都要接入 SDK？

**A**：是的。每个玩家的客户端游戏都要接 SDK（SDK 连各自电脑上的 IM-Client）。SDK 本身不做网络，IM-Client 负责。

### Q8：想让 Overlay 面板在我的游戏 UI 里显示？

**A**：Overlay SDK 的 ImGUI 面板是自绘的，**不能嵌进 Unity Canvas**。如果你想完全自定义外观：
1. 订阅 SDK 的 `OnFrame` 事件拿数据
2. 用 UGUI / UI Toolkit 自己画好友列表 / 聊天面板
3. 调 SDK 的 `SendChat` / `SendRoom*` 上行
4. 可以把 Overlay SDK 的 ImGUI 面板藏起来（不调用任何 RenderPresent，也不自动启动悬浮窗 — 但 SDK 没有关闭 ImGUI 的 API，建议在 Start 之后 5 秒内手动调一次 `RenderPresent` 让它走帧内模式但不画内容）

---

## 九、发布 Checklist

- [x] `Assets/Plugins/x64/IMOverlay.dll` 存在（Editor + Standalone）
- [x] 如果支持 32 位：`Assets/Plugins/x86/IMOverlay.dll` 也有
- [x] `IMOverlay` MonoBehaviour 已添加到场景（或代码里 Init）
- [x] 发布设置里 Scripting Backend 是 Mono 或 IL2CPP 都行（SDK 是原生 DLL，不影响）
- [x] 运行时测试：启动游戏 → 打开 IM-Client → 看 Overlay 是否出现
- [x] 退出游戏测试：Unity Console 里没有遗留的 SDK 日志错误
