# 游戏内 Overlay（Shift+Tab 好友/大厅面板）技术设计

> 状态：**一期已实施**（2026-10-26）；**十、游戏内通知小窗：已实施**（2026-10-27 评审通过并落地）。归属：游戏中心 / 联机功能增强。
> 关联文档：`docs/局域网公网联机开发文档.md`（109/110/112 房间信令）、`docs/联机原生SDK设计.md`（二期注入式的 `platform=game` WS 共存基础）。

---

# 一、目标与定位

玩家从客户端启动游戏后，**游戏内按 Shift+Tab 呼出面板**（Steam 同款交互）：

1. 好友列表（在线状态）与好友私聊；
2. 当前游戏的大厅/房间状态查看（我的房间成员、房间聊天）；
3. 邀请好友加入房间、加入好友的房间；
4. 关闭面板后焦点自动回到游戏，游戏全程不退出、不最小化。

**一期形态**：全局热键 + 置顶透明悬浮窗（下称「Overlay 悬浮窗」）。不注入游戏进程、不修改服务端。

**非目标（一期）**：
- 独占全屏（Exclusive Fullscreen）游戏内渲染——二期注入式承载（见第八节）；
- 游戏内语音、群聊、朋友圈等重功能；
- Web 浏览器端与手机 APP 端（浏览器无全局热键与跨应用置顶能力，物理不可行）。

---

# 二、方案选型

| | 路线 A：置顶透明悬浮窗（本设计） | 路线 B：注入式图形 Hook | 路线 C：第三方框架（Overwolf 等） |
|---|---|---|---|
| 原理 | 全局热键 + 永远置顶的透明窗口盖在游戏上 | CREATE_SUSPENDED 启动游戏时注入 DLL，钩 D3D/OpenGL Present 把 UI 画进游戏帧 | 商业 SDK 自带注入与渲染 |
| 覆盖范围 | 无边框全屏 / 窗口化游戏 | 含独占全屏 | 完整 overlay 能力 |
| 改造规模 | **低**：纯 Electron/JS，复用现有房间信令 | 高：原生 C++ 模块 + UI 移植 + 多图形 API 适配 | 中：接入 + 商业审核 |
| 主要风险 | 独占全屏不显示（有成熟规避手段） | 反作弊冲突、兼容性矩阵、崩溃面扩大 | 商业授权、数据不可控 |
| 服务端改动 | **零** | 零（复用 109 信令） | 不适用 |
| 结论 | **一期先行** | 二期演进（第八节） | 不采用 |

选 A 的核心理由：本平台游戏由客户端启动（`game:launch`）、房间/好友/信令体系全部现成（109~112 + `gn:*` 跨窗中继），路线 A 能以最小代价交付 90% 的产品体验，且无反作弊风险（平台游戏均为自管、无第三方反作弊冲突，但路线 B 的注入终究扩大崩溃与兼容面）。

---

# 三、一期总体架构

```
┌────────┐  Shift+Tab   ┌─────────────────────────────────────────────┐
│ 游戏进程 │ ──────────→ │ PC 客户端（Electron）                         │
│(无需注入)│  全局热键    │                                             │
└────────┘              │  主进程 game-overlay.js（新模块）              │
                        │   ├ 热键注册/注销（随游戏启停联动）              │
                        │   ├ Overlay 悬浮窗创建/定位/显隐/焦点归还        │
                        │   ▼                                         │
                        │  Overlay 悬浮窗（overlay.html，brand 新增）    │
                        │   好友列表 · 私聊 · 房间镜像 · 邀请             │
                        │   │            ▲                            │
                        │   │ gn:signal-send（上行中继，已有）│            │
                        │   │ gn:chat-mirror（下行镜像，新增）│            │
                        │   ▼            │                            │
                        │  主窗口（唯一 WebSocket 持有者）— socket.js    │
                        └──────────────────┬──────────────────────────┘
                                           │ WS（既有）
                                     ┌─────▼─────┐
                                     │ IM 服务端  │  零改动
                                     └───────────┘
```

**关键设计决策：**

1. **零注入、零服务端改动。** 悬浮窗是客户端自有窗口，不触碰游戏进程；全部数据面复用既有消息类型（1 私聊 / 9 错误 / 109 房间 / 111 邀请 / 112 大厅）。
2. **悬浮窗不开第二条 WebSocket。** 与游戏中心窗（`game-store.html`）同款承载：经 `gn:*` IPC 中继复用主窗口唯一 WS，规避同端互踢/未读双计/双心跳（先例见 `gn-signal.js` 头注释）。
3. **服务端回显语义已验证。** `server/server.go` L924-926：私聊「回显给发送方全部在线连接（多端同步）」——悬浮窗发出的消息会经主窗口 WS 回显、再镜像回悬浮窗，收发闭环天然成立，聊天落库/会话摘要/多端同步全部走既有逻辑。
4. **房间引擎归口游戏中心窗（防双份脑裂）。** `socket.js` L805-812 已确立原则：主窗口不持房间/引擎状态。悬浮窗同样**不内嵌** `gn-room.js` 全量逻辑（其建房/加入会触发 `GameNet.hostStart/connect` 隧道引擎），只做**只读镜像 + 轻操作**：
   - 查看：我的房间状态/成员/房内聊天/大厅聊天（镜像渲染）；
   - 轻操作：邀请好友（109 invite，无引擎参与）、退房、就绪——同一 WS 单上行，服务端仲裁后广播两窗，状态一致；
   - 重操作：创建房间 / 加入房间 → 转交游戏中心窗**后台执行**（见 4.4，不弹窗抢焦点）。
5. **热键生命周期绑定游戏运行态。** 仅当 `runningGames` / `runningLocalGames` 非空时注册 Shift+Tab，游戏全退即注销——平时不占用系统热键，不影响 Alt+A 截图 / 录屏热键等既有功能。

---

# 四、模块设计

## 4.1 主进程：`pc/game-overlay.js`（新模块，main.js 接线）

参照 `game-forward.js` / `game-tunnel.js` 的独立模块惯例，`main.js` 仅保留少量接线（约 30 行）。

### 4.1.1 Overlay 悬浮窗创建（`ensureOverlayWindow`）

```js
new BrowserWindow({
    width: 520, height: 680,               // 面板尺寸（居中显示于游戏所在显示器）
    show: false,
    frame: false,                          // 无边框，页面自绘
    transparent: true,                     // 全屏遮罩底 + 居中卡片（Steam 式）
    alwaysOnTop: true, 'screen-saver' 级,   // 盖过全屏游戏（先例：remoteBarWin L3689）
    skipTaskbar: true,
    fullscreenable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
});
win.loadURL(SERVER_URL + 'overlay.html?v=1');
```

- 窗口实际占满游戏所在显示器（`screen.getDisplayNearestPoint`），面板卡片居中，四周半透明遮罩（`rgba(0,0,0,.55)`）——Steam overlay 观感；
- 单例复用：关闭仅 `hide()`（同 `gameStoreWin` 模式），首次呼出才创建，隐藏时 Chromium 自动节流，常驻内存增量约 80~120MB；
- `transparent` 依赖 DWM：Win7 关闭 Aero 时透明失效露黑底——启动时检测（`dwmapi` 组合键省略，渲染层 `matchMedia` 兜底），不支持则退化为**不透明圆角卡片窗口**（仅去遮罩层，功能不受影响）。

### 4.1.2 定位策略

- 一期按「游戏所在显示器」整屏覆盖：游戏启动时记录 `screen.getCursorScreenPoint()` 与主屏判断不可靠，改用游戏 PID 探测窗口矩形（见下）取其中点所在显示器；探测失败兜底主显示器；
- 显示器级覆盖已覆盖 95% 场景（游戏全屏/无边框必然铺满所在显示器）。精确游戏窗口矩形（`EnumWindows` 按 PID 过滤）作为 P2 增强：PowerShell `Add-Type` 调 user32（项目已有 PowerShell spawn 先例 `game:disk-list` L1536），一次性编译缓存。

### 4.1.3 热键生命周期

```js
// 注册时机：gameStartBroadcast / localGameBroadcast(start) 处挂接
overlayHotkeyArm();   // globalShortcut.register(hotkey, toggleOverlay)
// 注销时机：game exit / error 广播处挂接（含 game-launch-error 路径）
overlayHotkeyDisarm(); // globalShortcut.unregister(hotkey)
```

- 默认 `Shift+Tab`；键位可配置（渲染层设置页 → IPC 存主进程内存 + localStorage 持久，参照 `recShortcutKey` 模式 L4766）；
- 注册失败（被占用）静默降级：托盘气泡提示一次，游戏内呼出不可用但不影响其他功能；
- `will-quit` 的 `globalShortcut.unregisterAll()`（L4788）天然兜底。

### 4.1.4 显隐状态机与焦点归还

```
closed ──热键──→ showing（show + 定位 + focus）──渲染完成──→ open
open   ──热键/Esc/关闭按钮──→ hiding（hide）──→ closed
```

- **呼出**：`win.setBounds`（游戏显示器整屏）→ `show()`（不动画）→ `focus()`；
- **关闭**：`hide()` 后 Windows 依 Z 序把焦点还给前一前台窗口（即游戏）。若实测个别游戏不回收（全屏轮询焦点类），启用兜底：按 `runningGames` 记录的 `child.pid` 枚举顶层窗口 → `SetForegroundWindow`（PowerShell user32，同 4.1.2 缓存机制）；
- 呼出期间游戏失去键盘输入（Windows 焦点语义，与 Steam overlay 行为一致）；游戏继续运行不掉帧（无边框模式下 DWM 合成正常）。

### 4.1.5 IPC 新增（main.js 注册 + preload.js 桥）

| 通道 | 方向 | 说明 |
|---|---|---|
| `overlay:toggle` | 渲染层 → 主 | 任意窗口可请求呼出/关闭（托盘菜单、设置页测试按钮用） |
| `overlay:hotkey-set` | 设置页 → 主 | 配置热键并即时重注册 |
| `overlay:state` | 主 → 全窗口 | 显隐状态广播（设置页展示/游戏库入口态） |
| `game:net-open`（扩展） | 渲染层 → 主 | payload 增加 `silent:true`：仅投递游戏中心窗**不 show/focus**（游戏内加入房间不弹窗，见 4.4） |

## 4.2 渲染层：`web/overlay.html` + `web/js/overlay.js` + `web/css/overlay.css`

### 4.2.1 页面结构（微信式，全部走主题 CSS 变量 + 自绘悬浮滚动条）

```
┌──────────────────────────────────┐
│ 遮罩层（点击空白处 = 关闭）          │
│  ┌────────────────────────────┐  │
│  │ 标题栏：当前游戏名  [—][×]    │  │
│  ├──────┬─────────────────────┤  │
│  │ 页签  │                     │  │
│  │ 好友  │   内容区             │  │
│  │ 房间  │  （列表/聊天气泡）     │  │
│  │ 大厅  │                     │  │
│  ├──────┴─────────────────────┤  │
│  │ 输入区（私聊/房间聊天复用）     │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- **好友页签**：在线好友列表（头像/昵称/在线点），点开即私聊（微信式左列表右会话）；
- **房间页签**：我的房间卡（房间名/成员列表/状态）+ 成员操作（邀请/踢人/就绪/退房）+ 房内聊天；未在房间时显示房间列表（只读）+ 「创建/加入」按钮（转交游戏中心窗后台执行）；
- **大厅页签**：当前游戏大厅聊天 + 在场玩家（112 镜像渲染）。

### 4.2.2 数据通道（全部经主窗口 WS 中继/镜像）

| 数据 | 上行 | 下行 | 说明 |
|---|---|---|---|
| 好友列表+在线态 | `gn:contacts-get`（已有） | `gn:chat-mirror`（新增：好友上下线帧转发） | contacts-reply 载荷**扩展 `isOnline` 字段**（主窗口 IMContacts 应答时附带，socket.js L946-955 处取值） |
| 私聊文本 | `gn:signal-send` → `IMSocket.send`（msg_type=1，已有通道，无类型白名单） | `gn:chat-mirror` 转发 msg_type=1 帧 | 服务端回显发送方全连接（server.go L924-926），悬浮窗自己的消息经回显闭环；悬浮窗本地乐观渲染 + 回显去重 |
| 房间/大厅信令 | `gn:signal-send`（109/112 动作） | `gn:*` 中继**升级为多订阅窗广播**（见 4.3） | 悬浮窗只读渲染 + invite/ready/leave 轻操作 |
| 游戏邀请卡 | —（对方发来 111） | 镜像转发 111 | 悬浮窗渲染精简邀请卡：「接受并加入」→ `game:net-open{silent:true}` |
| 连接态 | — | `gn:socket-state`（已有，改广播） | 顶部断线提示条 |
| 已读回执 | 悬浮窗会话打开时发 msg_type=8（经中继） | — | 清服务端未读，主窗口徽标同步消除 |

### 4.2.3 私聊历史（一期范围界定）

一期悬浮窗私聊仅展示**呼出后**收到/发出的消息（镜像流）。完整历史查看属 P2：需为 History 请求/响应加中继标记防止主窗口重复渲染，复杂度高收益低，暂不做。悬浮窗聊天输入框上方提供提示文案「完整聊天记录请在退出游戏后于主窗口查看」。

### 4.2.4 `socket.js` 改动（主窗口侧，约 20 行）

- L812 既有 `9/109/110/112` 中继分支保持，`gnSignalForward` 语义不变（主进程负责广播给订阅窗）；
- **新增** `gn:chat-mirror` 转发：msg_type ∈ {1（私聊文本）, 111（邀请卡）, 好友上下线帧} → `desktop.gnChatMirror(msg)`；
- **新增** `gn:contacts-need` 应答附带 `isOnline`（L950-952 取 IMContacts 数据时多带一字段）。

## 4.3 跨窗中继升级：单目标 → 多订阅窗广播

现状（`main.js` L1406-1415）：`gn:signal-recv` / `gn:socket-state` / `gn:net-config` 硬编码只投 `gameStoreWin`。

改造为**订阅注册表**：

```js
var gnRelayWins = new Set();   // 订阅窗注册表（gameStoreWin / overlayWin）
function gnRelayBroadcast(channel, payload) {
    gnRelayWins.forEach(function (w) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
    });
}
// 窗口销毁自动出表；ensureGameStoreWindow / ensureOverlayWindow 时各自注册
```

- `gameStoreWin` 行为完全不变（广播集合里只有它一个 = 原语义）；
- 悬浮窗 `preload.js` 已具备全部 `gn:*` 桥 API（preload 为全窗口共用），`overlay.html` 引入 `gn-signal.js` 即工作（其 `window.IMSocket` 缺失分支自动走 IPC 中继）。

## 4.4 房间重操作「后台归口」：`game:net-open` 扩展 `silent`

游戏内加入房间/接受邀请时，隧道引擎（`GameNet.hostStart/connect`）必须归口游戏中心窗（脑裂原则），但**不能** `show()+focus()` 抢走游戏焦点（现有 L1391-1392 行为）：

```js
ipcMain.on('game:net-open', function (e, payload) {
    ...
    var win = ensureGameStoreWindow();
    var deliver = function () { /* 投递 payload，不变 */ };
    if (payload && payload.silent) {
        // 后台归口：仅投递（窗口保持隐藏/最小化，引擎照常建连）
        if (win.isMinimized()) { /* 保持最小化，不 restore */ }
        deliver();
        return;
    }
    ... // 原逻辑：show + focus
});
```

- 游戏中心窗本就支持隐藏驻留（关闭即 hide，L1322-1329），后台建隧道零障碍；
- 悬浮窗收到加入成功（109 created/state 镜像）后 toast「已加入房间，联机链路已建立」；
- 邀请方无需 silent：邀请动作（109 invite）直接经中继上行，无引擎参与。

## 4.5 `gn-room.js` 改动（最小化）

- **不改**其核心状态机与引擎联动（游戏中心窗继续全权持有）；
- 仅当镜像广播送达悬浮窗时，悬浮窗用**自有的轻量渲染逻辑**（overlay.js 内 ~150 行）解析 109 信封（`created/state/list/closed/chat`）与 112（`msg/users`）——信封格式为既有协议，无服务端改动；
- L933 `gnSyncRoomName` 等函数不受影响（仍归属游戏中心窗环境）；
- **房间镜像冷启动查询**（真机实测补强）：面板页后加载，建房/加入时的 109 广播已错过，悬浮窗无从得知"我在哪个房"——新增 `overlay:room-get` 查询链路（悬浮窗 → 主进程 → 游戏中心窗 gn-room.js 回房间快照，模式同 `gn:contacts-get`，3s 超时兜底；游戏中心窗未创建=不可能在房直接 null），悬浮窗打开房间页签时查询补全 `myRoom`，快照后的状态变化仍走 109 广播实时跟随。

## 4.6 服务端：零改动

依赖的既有行为清单（评审时逐项核对）：

| 行为 | 位置 | 说明 |
|---|---|---|
| 私聊回显发送方全连接 | server.go L924-926 | 悬浮窗聊天闭环基础 |
| 109/110/111/112 路由 | server.go handleMessage | 房间/邀请/大厅信令复用 |
| 9 通用错误帧 | 既有 | 悬浮窗轻操作被拒时的提示来源 |
| msg_type=8 已读 | 既有 | 悬浮窗读信消除主窗口未读 |
| 好友上下线推送 | 既有 presence 帧 | 镜像转发即可，无新帧 |

---

# 五、关键问题与对策

| # | 问题 | 对策 |
|---|---|---|
| 1 | **独占全屏游戏悬浮窗不可见**（绕过 DWM 合成，Windows 机制限制；Steam 亦然） | ① 游戏库详情页/帮助文档标注「支持游戏内面板：请使用无边框全屏或窗口化」；② 常见游戏引导启动参数（War3 加 `-window`，启动参数机制现成）；③ 二期注入式根治 |
| 2 | **Shift+Tab 与游戏内键位冲突**（Tab 常是计分板/地图） | 热键可配置（设置页）；仅游戏运行中注册，冲突窗口期最小化 |
| 3 | globalShortcut 注册期间 Shift+Tab 被系统级吞掉 | 注册窗口期仅限游戏运行中；文档说明（游戏内本就极少用 Shift+Tab 组合） |
| 4 | 关闭面板后焦点不回游戏（个别全屏抢焦点游戏） | 主路径：hide 依 Z 序自动归还；兜底：按游戏 PID `SetForegroundWindow`（4.1.4） |
| 5 | 主窗口未登录 / WS 断开 | `gn:socket-state` 镜像 → 悬浮窗顶部断线条 + 面板内操作禁用；登录页期间热键不注册 |
| 6 | 悬浮窗与游戏中心窗同时操作房间的状态一致性 | 单 WS 单上行，服务端仲裁广播两窗，最终一致；引擎仅游戏中心窗持有（脑裂原则，4.4） |
| 7 | 悬浮窗与主窗口未读不同步 | 悬浮窗打开某会话即发已读回执（msg_type=8 经中继），主窗口徽标联动消除 |
| 8 | 游戏内收邀请卡片被打断 | 主窗口系统通知行为不变（OS 级 toast 不抢焦点）；悬浮窗内同步渲染精简邀请卡，游戏内可直接接受 |
| 9 | 透明窗口 Win7 兼容（DWM 关闭露黑底） | 启动检测降级为不透明圆角卡片（4.1.1）；`pc/win7` 旧壳如不支持 transparent 则整体禁用入口 |
| 10 | 性能/资源 | 常驻仅 1 个隐藏 BrowserWindow（Chromium 后台节流）；透明层仅在显示期合成；热键空闲期零注册 |
| 11 | 安全 | 同源同会话（SERVER_URL + localStorage）；`contextIsolation` 无 nodeIntegration；不注入不触碰游戏进程内存；热键仅游戏运行期注册 |
| 12 | 多显示器/游戏在副屏 | 游戏显示器定位（4.1.2），探测失败兜底主屏 |

---

# 六、交互稿（文字版）

1. **呼出**：游戏内按 Shift+Tab → 全屏暗色遮罩淡入（100ms）+ 居中面板，默认落「好友」页签；
2. **私聊**：点好友 → 右侧会话气泡（微信式：对方左头像左气泡，自己右气泡）→ 底部输入框回车发送；
3. **邀请**：房间页签「+ 邀请」→ 在线好友多选（复用游戏中心窗同款选人交互）→ 发送后成员列表出现「邀请中」态；
4. **被邀请**：游戏内好友发来邀请 → 悬浮窗若开着则在房间页签顶部出现邀请卡；若没开面板，主窗口聊天区既有邀请卡照常（OS 通知提醒），玩家可 Shift+Tab 呼出后点「接受并加入」；
5. **关闭**：Shift+Tab / Esc / 点遮罩空白 / 右上角 ×，均收面板还焦点给游戏；
6. **收起为角标（P2 可选）**：面板关闭后屏幕角落留一枚半透明小角标显示未读数，点击重新展开。

---

# 七、分期实施清单

## P1 主进程
- 新增 `pc/game-overlay.js`：窗口创建/定位/显隐/焦点归还/热键生命周期/IPC（4.1）；
- `pc/main.js` 接线：`gameStartBroadcast` / `gameExitBroadcast` / `localGameBroadcast` / `game-launch-error` 四处挂接热键联动；`gn:*` 中继改多订阅广播（4.3）；`game:net-open` 加 `silent`（4.4）；
- `pc/preload.js`：新增 `overlay:*` 桥与 `gnChatMirror` 转发桥。

## P2 渲染层
- 新增 `web/overlay.html` / `web/js/overlay.js` / `web/css/overlay.css`：三页签面板 + 轻量房间镜像渲染 + 私聊（4.2）；
- `web/js/socket.js`：`gn:chat-mirror` 转发分支 + contacts 应答带 `isOnline`（4.2.4）；
- `web/js/i18n.js` 语言包补 key；`style.css` 无需动（overlay 独立样式文件，主题变量同源）。

## P3 设置与入口
- 设置页新增「游戏」分类：热键配置 + 「游戏内面板」开关；
- 游戏库详情页标注「支持游戏内面板」（数据源：管理端游戏编辑可选字段，P2 接服务端——若坚持服务端零改动则一期按游戏名单客户端 localStorage 配置，评审定夺）。

## P4 测试项（验收矩阵）

| 维度 | 用例 |
|---|---|
| 热键 | 游戏启动后 Shift+Tab 呼出/再按关闭；游戏退出热键注销（普通游戏+本地游戏+启动失败路径）；Alt+A 截图/录屏热键回归 |
| 私聊 | 游戏内收/发消息双向实时；消息落库（主窗口历史可见）；已读回执消除主窗口未读；断线提示条 |
| 房间 | 游戏内查看我的房间成员/状态实时跟随；邀请在线好友 → 对方主窗口收卡 → 对方接受加入 → 我方成员列表更新；游戏内加入好友房间（silent 后台建隧道）→ 游戏能连上联机端口 |
| 大厅 | 大厅聊天收发、在场玩家列表 |
| 焦点 | 关面板焦点回游戏（无边框/窗口化各测一款）；面板打开时游戏输入被屏蔽 |
| 兼容 | 独占全屏游戏不可见提示链路；Win7 降级卡片；多显示器副屏游戏 |
| 回归 | 游戏中心窗联机大厅全流程（建房/加入/开局）不受中继广播改造影响；主窗口聊天/未读/邀请卡回归 |
| 资源 | 面板隐藏期 CPU/内存基线；游戏帧率对比（开/关面板） |

---

# 八、二期展望：注入式真 Overlay（Steam 同级）

一期验证产品形态后，二期升级为进程内渲染（独占全屏可用、观感与 Steam 完全一致）：

```
game:launch（改造）：spawn CREATE_SUSPENDED → 注入 overlay.dll → resume
overlay.dll（C++）：MinHook 钩 D3D9/11/12/OpenGL/Vulkan Present
                  → 热键触发时在游戏帧内渲染 ImGui UI（皮肤对齐主题变量）
                  → 命名管道与本机客户端主进程通信（复用一期全部信令/中继协议）
信令通道演进：overlay.dll 内可直连 platform=game WS（联机原生SDK设计.md §3.1，
            与 PC 端跨端共存不互踢——该设计落地后即为本模块复用点）
```

- 风险清单：多图形 API 适配矩阵、HDR/多 GPU、反作弊白名单、崩溃面扩大（独立 DLL 隔离 + 看门狗卸载）；
- 平台优势：游戏均为平台自管分发，可按游戏逐个适配并在游戏库标注兼容等级，可控性远高于公网平台。

---

# 九、开放问题（评审拍板）

1. **面板形态**：全屏遮罩 + 居中卡片（Steam 式，本文默认）vs 右侧停靠半屏面板（微信式）？——已按默认实施
2. **「支持游戏内面板」标注的数据源**：管理端游戏字段（需动服务端+后台）vs 客户端本地名单（零服务端改动）？——一期未做标注（所有游戏均可呼出）
3. **默认热键** Shift+Tab 是否合适（部分游戏 Tab 为计分板，Shift+Tab 冲突概率低但非零；可否接受默认改为 Ctrl+Tab 或首启引导选择）？——已按 Shift+Tab 实施（可配置）
4. **游戏内通知策略**：面板开启期间主窗口 OS 通知是否静音？——v1 并存（Steam 同款），静音方案见 §10.7.3
5. **收起角标**（第六节 P2）——由 **§十、游戏内通知小窗** 覆盖（堆叠 toast 形态优于静态角标）

---

# 十、游戏内通知小窗（Steam 式消息/邀请提醒）——已实施（2026-10-27）

## 10.1 目标与交互对照

Steam 游戏内通知行为对照：

| Steam 行为 | 本设计 |
|---|---|
| 好友消息 → 右下角滑入 toast（头像+昵称+内容预览） | 同款（avatarEl 降级头像 + 昵称 + 两行截断预览） |
| 多条堆叠，悬停暂停，失焦自动消失 | 同款（堆叠上限 4 条，同会话合并 ×N，6s 计时） |
| 点击 toast → 打开与该好友的聊天页（游戏内） | 点击 → 呼出 Shift+Tab 面板并**直达该好友会话**（游戏内完成） |
| 好友邀请 → 邀请卡 toast，点击进入 | 点击 → 呼出面板并落**房间页签**（邀请条可见可接受） |
| 面板/好友列表打开期间不弹 toast | 面板打开时抑制（消息面板内可见） |

范围：一期仅**好友私聊（2）+ 联机邀请（111）**；群聊不弹（面板/主窗口承载）。

## 10.2 总体架构

```
主窗口 WS（唯一连接）
   │ gn:chat-mirror（已有：2 私聊 / 111 邀请 / 93 在线增量）
   ▼
主进程 gnRelayBroadcast（多订阅广播，已有）
   ├─► 游戏中心窗（已有，忽略 chat-in）
   ├─► Overlay 面板窗（已有）
   └─► 通知小窗 notifyWin（新增）★
          │ 通知页自管堆叠/计时/合并
          ├─ 栈空 = 窗口隐藏（不占游戏画面不挡操作）
          ├─ 点击 toast → ipc 'notify:open' {username|invite}
          ▼
       主进程：gameOverlay.showOverlay() + 面板页投递直达参数
       （overlay:open-chat → 直达好友会话 / overlay:open-room → 房间页签）
```

关键决策：
1. **独立小窗而非复用全屏面板窗**——面板关闭即 hide，若借面板窗弹通知，需全屏透明遮罩层参与鼠标穿透（`setIgnoreMouseEvents` + hover 前瞻切换，复杂易碎）。独立小窗 = 窗口本体即通知区域（remote-bar 悬浮条同款先例），天然不挡游戏操作；
2. **数据面零新增**：通知窗加入 `gnRelayWins` 订阅 `gn:chat-in`，头像/昵称复用 `gn:contacts-get`；109/110/112 到达即忽略（仅面板关心）；不新开 WS、服务端零改动；
3. **抑制规则**：`overlay:state` 广播（已有）通知页订阅——面板打开期间不弹 toast，关闭恢复；
4. **不夺焦**：通知窗 `focusable:false`（toast 悬停/消失不打断游戏输入），仅点击时经 `showOverlay()` 夺焦（与热键呼出同语义，RegisterHotKey 激活授予前台权限）。

## 10.3 窗口规格（pc/game-overlay.js 扩展）

- BrowserWindow：宽 320 × 高 ~660（堆叠区，内容锚定底部右对齐），`transparent + frame:false + alwaysOnTop('screen-saver') + skipTaskbar + focusable:false + resizable:false`；
- 位置：`gameDisplay.bounds` 右下角内缩 12px（复用面板窗的显示器解析结果，多显示器/副屏自动跟随）；
- 生命周期：与面板窗同款——`armHotkey` 预热创建（隐藏）、`disarmHotkey` 收口、WIN7 随 overlay 硬性禁用、设置「游戏内通知」开关控制是否创建与订阅；
- 显隐归口：通知页栈空/非空时经 `notify:visible` 请求，主进程只执行 show/hide（不猜内容）。

## 10.4 IPC 协议新增

| 通道 | 方向 | 说明 |
|---|---|---|
| `notify:visible` | 通知页 → 主 | 堆叠非空 show / 清空 hide |
| `notify:open` | 通知页 → 主 | 点击 toast：`{username}`（私聊）或 `{invite:true}`（邀请）→ `showOverlay()` + 向面板页投递直达参数 |
| `overlay:open-chat` | 主 → 面板页 | 面板 overlay.js 订阅：`{username}` → showTab('friends') + openChat(username) |
| `overlay:open-room` | 主 → 面板页 | `{}` → showTab('room')（邀请条可见可接受） |

`overlay:state` 广播（已有）通知页订阅 → 面板打开抑制。preload.js 新增 `notifyVisible / notifyOpen / onOverlayOpenChat / onOverlayOpenRoom` 桥。

## 10.5 通知页（web/notify.html + js/notify.js + css/notify.css）

- 数据：`desktop.onGnChatIn`（2/111/93）+ `gnContactsGet` 快照（avatar/name 映射）；93 增量仅刷新头像昵称缓存；
- toast 结构：左头像（avatarEl 同款降级）+ 右昵称/预览；邀请卡显示「X 邀请你加入房间 Y + 房间名/房主」；
- 堆叠：同会话新消息**合并更新**（×N 计数 + 最新内容置顶）；上限 4 条，超出丢最旧并显示「+N 更多」；
- 计时：6s 自动消失；`mouseenter` 暂停 / `mouseleave` 恢复；滑入滑出动画（transform + opacity，150ms）；
- 主题：style.css 变量同源 + `im_theme` storage 监听跟随（面板同款）；
- 显窗：栈空 → `notifyVisible(false)`；非空 → `(true)`。

## 10.6 设置项

设置页「游戏」分类新增「游戏内通知」开关（默认开启，与「游戏内面板」并列）：关闭 = 主进程不创建通知窗且不加入镜像订阅（动态生效，免重启）。

## 10.7 边界与风险

| # | 问题 | 对策 |
|---|---|---|
| 1 | `focusable:false` 窗口的点击行为存在 Electron 版本差异 | 实测验证；异常回退 `focusable:true + showInactive`（不夺焦） |
| 2 | toast 区域遮挡游戏右下角 UI（小地图/聊天框） | 宽 320 仅角部；位置设置项（右下/右上）列 P2 |
| 3 | 与主窗口 OS 通知并存（双份提醒） | v1 并存（Steam 同款）；后续可做「面板+通知窗运行期静音主窗口通知」 |
| 4 | 消息风暴刷屏 | 同会话合并 + 上限 4 条 + 主窗口 mirror 单窗节流已有 |
| 5 | 面板开着时到达的消息 | 订阅 `overlay:state` 抑制；面板关闭瞬间的未读不回放 toast（一期接受，面板内有未读徽标） |
| 6 | Win7 | 随 overlay 硬性禁用（`supported=false` 已有，通知窗不创建） |
| 7 | 已读语义 | 点击 toast 直达会话 = 打开会话，自动发已读回执（与面板内打开会话行为一致，评审确认） |

## 10.8 实施清单

- P1 主进程：`game-overlay.js` 扩展（`ensureNotifyWindow`/右下定位/`notify:visible`/`notify:open`/设置开关接入）；`main.js`：通知窗加入 `gnRelayWins`（`gnRelayAdd`）；`preload.js`：四桥新增；
- P2 渲染层：`web/notify.html` + `web/js/notify.js` + `web/css/notify.css`（新增三件套）；`overlay.js`：`overlay:open-chat/room` 订阅（直达会话/房间页签）；i18n 键补齐（zh+en）；
- P3 设置：「游戏内通知」开关（设置页「游戏」分类，默认开）；
- P4 测试项见 §10.10。

## 10.9 版本与部署

- `notify.html?v=1` 新增；`overlay.js` bump v4；设置页 index.html 不变（开关复用既有结构）；i18n PACK_VER bump；
- 部署：web 三件套 + i18n + preload/game-overlay/main 重打包，与一期同一批发布可合并。

## 10.10 测试项（验收矩阵）

| 维度 | 用例 |
|---|---|
| 消息 toast | 面板关闭时私聊到达→右下滑入（头像/昵称/预览）；同会话合并 ×N；点击→面板呼出并直达该好友会话；6s 自动消失；悬停暂停恢复 |
| 邀请 toast | 面板关闭时收到 111→邀请卡 toast；点击→面板呼出并落房间页签（邀请条可见可接受） |
| 堆叠 | 3 个好友各发 1 条→3 条堆叠；第 5 条到达→最旧丢弃显示 +N；同一好友连发→合并为一条 ×N |
| 抑制 | 面板打开时不弹 toast；面板关闭后恢复弹 |
| 焦点 | toast 悬停/消失不夺游戏焦点（游戏输入持续）；点击唤起面板后焦点行为与热键呼出一致 |
| 生命周期 | 游戏退出通知窗收口；Win7 不创建；「游戏内通知」开关关闭后立即不再弹（免重启） |
| 回归 | 面板/游戏中心窗/主窗口聊天不受影响（通知窗只读镜像）；gnRelayWins 新增订阅窗后无回环；镜像来源守卫（gnFromMain）不拦截通知窗收流 |

## 10.11 开放问题（评审拍板）

1. toast 位置一期固定右下（Steam 同款），右上设置项列 P2——是否接受？
2. 点击私聊 toast 直达会话即发已读回执（=点击即读）——是否接受？（主窗口未读徽标随之消除）
3. 群聊消息一期不通知——是否接受？
