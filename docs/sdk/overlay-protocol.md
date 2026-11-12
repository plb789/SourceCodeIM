# IM Overlay 管道协议（SDK v1）

> 本文档定义商户游戏与 IM-Client 之间的 Named Pipe 通信协议。
> 游戏进程作为 **客户端** 连接 IM-Client 主进程已创建好的 Named Pipe，
> 收发 NDJSON 帧完成好友列表、聊天消息、房间状态等功能。

---

## 1. 管道命名与生命周期

### 1.1 管道名

```
\\.\pipe\im-overlay-<PID>
```

`<PID>` = 游戏进程自身的 PID（decimal 字符串，无前导零）。

IM-Client 在游戏 **刚 spawn 出来** 时就同步创建对应的 Named Pipe Server，
游戏进程在自己的 `main()` / Engine 初始化里调用 `GetCurrentProcessId()` 拼成路径连接即可。

### 1.2 时序

```
IM-Client 主进程                      游戏进程
    │                                   │
    ├─ spawn(game.exe) ───────────────→ 创建
    ├─ onGameStart(pid)                 │
    │   └─ startPipeServer(pid) ──────── pipe server ready
    │                                   ├─ WinMain / main()
    │                                   ├─ 加载模块、初始化引擎
    │                                   ├─ IMOverlay::connect() ← pipe client 连接
    │                                   │   (pipe 早已 ready，必定秒连)
    │                                   ├─ IMOverlay::start() 启收帧线程
    │                                   └─ 游戏运行，收发帧
    │                                   ├─ IMOverlay::stop() 退出游戏
    ├─ game exit ──────────────────────┤  pipe server 自动关闭
```

### 1.3 断线重连

- 主进程 pipe 被动断开（游戏崩溃）：主进程自动关闭 pipe server，日志记录
- 游戏端 pipe 断开：SDK 在后台线程里自动 **1 秒重连一次**，直到重连成功或 SDK `stop()` 被调用
- 重连后主进程会重新下发 `hello-ack` / `friends` / `me` / `hotkey` / 等全部快照帧

### 1.4 并发

- **1 pipe : 1 game** —— 每个游戏实例一条 pipe；多开同一款游戏各自独立
- IM-Client 主进程维护 pipe 表 `Map<PID, { server, sock }>`，按需广播帧到所有在线 pipe

---

## 2. 帧格式

**NDJSON（Newline-Delimited JSON）**：每一帧是一行完整的 JSON 对象，以 `\n`（LF，0x0A）结尾。

```
{"t":"hello-ack"}\n
{"t":"me","u":"player123"}\n
{"t":"friends","list":[{"u":"alice","n":"Alice","on":true},{"u":"bob","n":"Bob","on":false}]}\n
{"t":"msg","from":"alice","name":"Alice","to":"player123","text":"你好"}\n
```

### 2.1 为什么用 NDJSON

- 所有语言原生支持（JavaScript `JSON.parse` / C++ `nlohmann::json` / Unity `JsonUtility` / UE `FJsonSerializer`）
- 无头部、无长度字段、无校验——极简协议
- 帧间天然分隔（按 `\n` 切分流），不排队列

### 2.2 字符编码

所有字符串 **UTF-8**。emoji 等多字节字符正常支持。

### 2.3 帧大小限制

单行 JSON **≤ 262 KB**（主进程端硬性校验，超限断开 pipe 等游戏重连）。
头像帧（48×48 BGRA base64 ~12 KB）远小于此阈值；若未来头像分辨率上调，需同步放大阈值。

---

## 3. 帧定义

每帧必有 `t` 字段（string），表示帧类型。其他字段按类型不同。

### 3.1 主进程 → 游戏（下行）

#### `hello-ack` — 握手成功

```json
{"t":"hello-ack"}
```

游戏连上 pipe 后，主进程下发的第一帧。告知游戏 "pipe 就绪，可以发消息/收消息了"。

#### `me` — 我的账号

```json
{"t":"me","u":"player123"}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `u` | string | 本端账号名（登录 IM-Client 用的那个） |

游戏据此可以：
- 在面板标题显示 "player123 的好友列表"
- 回显消息时判定自己发的还是收到的（`from == me.u` → 自己发的）

#### `friends` — 好友快照

```json
{
  "t": "friends",
  "list": [
    {"u":"alice","n":"Alice","on":true},
    {"u":"bob","n":"Bob","on":false},
    {"u":"carol","n":"卡罗尔","on":true}
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `list` | array | 最多 50 人（后续扩展可至 200，当前按 IM-Client 好友上限） |
| `list[].u` | string | 好友 username（IM-Client 登录账号） |
| `list[].n` | string | 好友显示名（可能与 u 相同） |
| `list[].on` | bool | 是否在线 |

触发时机：
- pipe 连接刚建立时（立即推送完整快照）
- 在线状态变化（93 信令合并后节流 1.5s 推送）
- 好友列表变化（加好友/删好友）

游戏收到后应 **全量替换** 自己的好友列表（不是增量合并——主进程保证每次下发的都是完整快照）。

#### `msg` — 私聊消息

```json
{"t":"msg","from":"alice","name":"Alice","to":"player123","text":"你好，加个好友？"}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 发送方 username |
| `name` | string | 发送方显示名（可能与 from 相同） |
| `to` | string | 接收方 username（应等于 `me.u`） |
| `text` | string | 消息正文（≤ 2000 字，已截断） |

游戏侧 UI 表现建议：
- 弹出聊天气泡 / 通知 toast（首次收到该好友消息时）
- 或在好友列表里给对应好友标记有未读

#### `room` — 房间快照

```json
{
  "t": "room",
  "room": {
    "room_id": 42,
    "name": "战争前线·新兵组",
    "owner": "captain",
    "players": [{"u":"captain","n":"队长"},{"u":"player123","n":"我"}],
    "max": 8,
    "mode": "battle"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `room` | object / null | null = 我没在房间；有值 = 我当前所在房间 |
| `room.room_id` | int | 房间 ID |
| `room.name` | string | 房间名 |
| `room.owner` | string | 房主 username |
| `room.players` | array | 已在房成员 [{u, n}] |
| `room.max` | int | 最大容纳 |
| `room.mode` | string | 房间模式（battle/lobby/training...） |

游戏收到后：
- `room == null` → 清空房间面板（或隐藏房间入口）
- 有值 → 刷新房间面板（显示成员、准备按钮等）

#### `roomchat` — 房间聊天

```json
{"t":"roomchat","name":"队长","text":"大家准备好，3 2 1...","room_id":42}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 发送方显示名 |
| `text` | string | 消息正文 |
| `room_id` | int | 来自哪个房间 |

#### `avatar` — 好友头像（base64 BGRA）

```json
{
  "t": "avatar",
  "u": "alice",
  "w": 48,
  "h": 48,
  "b64": "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvcP..."
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `u` | string | 这个头像属于谁（username） |
| `w` | int | 像素宽（固定 48） |
| `h` | int | 像素高（固定 48） |
| `b64` | string | BGRA 原始像素 base64 编码（**不是 PNG/JPEG**，是裸像素，方便游戏直接上传 GPU 纹理） |

格式说明：
- **BGRA 顺序**（Windows GDI/D3D 原生格式，上传纹理时直接 Copy）
- **8 bits per channel**，每像素 4 字节
- **总大小** = `w * h * 4` = 48 × 48 × 4 = 9216 字节 → base64 后 ~12 KB

游戏侧使用：
- Unity：`Texture2D.LoadRawTextureData(Convert.FromBase64String(b64))` + `texture.Format = TextureFormat.BGRA32`
- UE：`Texture2D.Create(..., BGRA)` → `Lock()` → 写入 `FMemory::Memcpy` → `Unlock()`

#### `hotkey` — 热键配置

```json
{"t":"hotkey","vk":9,"ctrl":0,"shift":1,"alt":0}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `vk` | int | Windows Virtual-Key Code（9 = Tab，0x70+ = F1~F12） |
| `ctrl` | int | 是否要 Ctrl 组合（0/1） |
| `shift` | int | 是否要 Shift 组合（0/1） |
| `alt` | int | 是否要 Alt 组合（0/1） |

游戏侧据此：
- 注册自己的热键监听（WndProc 捕获 WM_KEYDOWN / GetAsyncKeyState 轮询）
- 按下匹配时弹出游戏内 IM 面板

热键变更时主进程会重新下发（用户在 IM-Client 设置页改了热键后，正在运行的所有游戏都能收到更新帧）。

#### `follow` — 关注名单

```json
{"t":"follow","mode":"all","list":["alice","bob"]}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | `"all"` 或 `"list"` — `"all"` 时关注所有人，`"list"` 时仅关注名单内 |
| `list` | array | 关注对象 username 列表 |

用于大厅/匹配功能（关注的人上线时优先匹配等）。商户集成可按需使用。

---

### 3.2 游戏 → 主进程（上行）

#### `hello` — 注册/握手

```json
{"t":"hello","pid":12345,"sdk":"cpp","version":"1.0.0"}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pid` | int | ✓ | 游戏进程 PID（主进程据此确认 pipe 归属） |
| `sdk` | string | 建议 | SDK 类型标识：`cpp` / `unity` / `ue` / 自定义 |
| `version` | string | 建议 | SDK 版本号（便于主进程日志区分接入方式） |

游戏连上 pipe 后 **应立即发送** `hello` 帧。主进程收到后会回送 `hello-ack`。

#### `chat-send` — 发送私聊

```json
{"t":"chat-send","to":"alice","text":"好的，等我 5 分钟"}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | string | ✓ | 目标好友 username |
| `text` | string | ✓ | 消息正文（≤ 2000 字，超出会被主进程截断） |

主进程白名单校验：`to` 非空 + `text` 非空才放行。不合法直接丢弃不报错（游戏侧无从感知）。

#### `room-act` — 房间动作

```json
{"t":"room-act","action":"ready","room_id":42}
{"t":"room-act","action":"leave","room_id":42}
{"t":"room-act","action":"chat","room_id":42,"text":"准备好了"}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | string | ✓ | 只能是 `"ready"` / `"leave"` / `"chat"` 之一（主进程白名单硬校验） |
| `room_id` | int | ✓ | 目标房间 ID |
| `text` | string | chat 时必填 | 房间聊天正文（≤ 500 字） |

主进程白名单校验：
- `action` 必须是三种之一，否则丢弃
- `room_id` 必须非零
- `action == "chat"` 时 `text` 必须非空且 ≤ 500 字

#### `panel` — 面板状态（可选）

```json
{"t":"panel","open":true}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `open` | bool | true = 游戏内 IM 面板打开中 |

主进程据此：
- 面板打开时，IM-Client 悬浮窗让位（不弹出、不接收热键）
- 面板关闭后，悬浮窗恢复工作

商户 SDK 实现可按需上报（不影响核心功能）。

---

## 4. 安全设计

### 4.1 白名单收敛

主进程 pipe 服务端 **只放行以下上行帧**：

```
chat-send  → msg_type:2 → IM 服务器（私聊）
room-act   → msg_type:109 → IM 服务器（房间信令）
  action ∈ {ready, leave, chat}  硬校验
hello      → 仅日志登记
panel      → 仅状态同步
```

**任何其他帧类型一律丢弃**，防止被攻陷的游戏进程借 pipe 注入 IM 服务器任意信令（比如强制踢人、改房间模式等）。

### 4.2 长度截断

| 字段 | 最大长度 | 主进程行为 |
|------|---------|----------|
| chat-send.text | 2000 字 | 超出截断后放行 |
| room-act.text | 500 字 | 超出截断后放行 |
| chat-send.to | 64 字 | 超出取前 64 |
| room-act.room_id | 正整数 | Number(Number(f.room_id) \|\| 0) — 零值截断 |

### 4.3 进程归属

pipe 名硬编码 PID —— 游戏进程只能连自己 PID 对应的 pipe（其他游戏进程的 pipe 路径不同，连不上）。
主进程维护 pipe 表，**同一 PID 只能有一个 sock**（新的连进来会把旧的踢掉）。

### 4.4 进程隔离

- pipe server 跑在 **im-client.exe** 主进程内（Electron main process）
- 游戏进程只能 **读/写 NDJSON 帧**，不能：
  - 直接连 IM 服务器（需要 X-Drive-Token，游戏进程拿不到）
  - 访问 IM-Client 的文件系统（pipe 是进程间通信，不是 RPC）
  - 影响其他游戏的 pipe（每个 pipe 独立）

### 4.5 不做什么

- **不鉴权游戏进程身份**（反作弊/签名验证不在 pipe 协议层处理——如果游戏被破解，鉴权挡不住；防攻陷靠的是白名单收敛）
- **不做帧加密**（本机 IPC，用户态攻击者已经能注入游戏进程了，加密 pipe 意义不大；IM 服务器侧仍然走加密 WS + Token）
- **不做请求/响应模型**（NDJSON 是单向帧，无事务性；需要确认回调的场景由上层实现——比如发完 chat-send 等待对应的 msg 下行帧）

---

## 5. 接入流程（商户游戏侧）

```cpp
// 伪代码（实际 SDK 封装见 im-overlay-sdk.h）
#include "im-overlay-sdk.h"

void GameEngine::OnEngineStart() {
    auto overlay = IMOverlay::connect([](const IMFrame& f) {
        switch (f.type) {
            case "hello-ack": /* pipe ready */ break;
            case "me":       /* 更新 UI：标题显示 me.u */ break;
            case "friends":  /* 刷新好友列表 */ break;
            case "msg":      /* 收到私聊，弹通知 */ break;
            case "room":     /* 刷新房间面板 */ break;
            case "roomchat": /* 房间聊天追加 */ break;
            case "avatar":   /* 更新好友头像纹理 */ break;
            case "hotkey":   /* 注册游戏内热键监听 */ break;
        }
    });
    overlay.start();
    // 游戏继续正常运行...
}

void GameEngine::OnEngineShutdown() {
    overlay.stop();
}
```

---

## 6. 版本与兼容性

- **协议版本**：v1（当前稳定版）
- **帧扩展**：未来 IM-Client 新增帧类型时 **只增不删**，旧商户 SDK 收到未知 `t` 字段应 **忽略**（不要 crash）
- **上行扩展**：主进程新增白名单时，旧商户 SDK 不会受影响（只是没有调用而已）
- **破坏性变更**：仅在大版本升级时发生，届时 pipe 名会改（如 `im-overlay-v2-<pid>`），新旧版互不影响
