# 联机原生 SDK（形态一）详细设计

> 状态：**待评审**（评审通过后实施）。归属：`局域网公网联机` 功能二期剩余项「形态一：原生 SDK（不可靠无序通道）」。
> 关联文档：`docs/局域网公网联机开发文档.md`（§4 形态对比、§12.2 功能分期、§16 中继集群）。

---

# 一、目标与定位

形态一 = **原生 SDK 通道**（`game_net.mode` 的 `lane`）：自研游戏进程内集成 SDK，直接收发不可靠无序字节，**玩家无需输入任何 IP/端口**，由游戏代码建连。

| | 形态二（已上线） | 形态一（本设计） |
|---|---|---|
| 接入方式 | 客户端本地监听游戏端口，游戏手动输入 IP | 游戏代码调用 SDK，进程内直发 |
| 游戏侧改动 | 零（仅支持手动填 IP 的游戏） | 集成 SDK（自研游戏） |
| 数据面 | WebRTC DataChannel → Electron 再转 UDP/TCP → 游戏 | WebRTC DataChannel → 游戏回调（**省一层本地转发**） |
| 星型拓扑 | 成员只连房主（Electron 承载） | 成员只连房主（SDK 承载），成员间经房主一跳转发 |
| 服务端 | 109/110 信令 + ICE 注入 | **全复用，仅 2 处最小改动（见第三节）** |

**核心原则：服务端零媒体参与不变**——109 房间层 / 110 连接层信令原样复用，游戏字节走 DataChannel 点对点（或 TURN 中继兜底）。

---

# 二、总体架构

```
┌─ 游戏进程 ──────────────────────────────┐      ┌─ 游戏进程（房主） ───────────────────────┐
│  游戏逻辑 ←→ gn_sdk.dll (C ABI)          │      │  游戏逻辑 ←→ gn_sdk.dll (C ABI)          │
│              │  ├ WS 信令（platform=game）│      │              │                           │
│              │  ├ pion/webrtc 数据面      │      │              ├ pion/webrtc（answerer）    │
│              │  └ 房主转发引擎（帧头路由） │      │              └ 房主转发引擎                │
└──────────────┼───────────────────────────┘      └──────────────┼───────────────────────────┘
               │ DTLS 加密 DataChannel（gn-ctl / gn-udp / gn-tcp）│
               └────────────────────星型：成员→房主──────────────┘
               │ 109 房间信令 / 110 连接信令（WS，服务端只转不碰数据）
        ┌──────┴──────┐
        │  im-server  │  房间态(Redis) + 110 中继 + ICE 注入(3478/3479)
        └─────────────┘
```

SDK 内部分层（Go 单 module，`-buildmode=c-shared` 导出 C ABI）：

1. **C ABI 导出层**：句柄管理、JSON 参数解析、回调结构体持有；
2. **会话核心**：登录/重连状态机、109 房间动作、110 建连状态机（对齐 `gn-net.js` 逻辑的 Go 移植）；
3. **数据面**：`pion/webrtc`（同族 `pion/turn` 已在服务端使用）——加入者 offerer 建 3 条 DataChannel；
4. **转发引擎**：仅房主实例启用——按帧头 `target_uid` 把成员间数据一跳转发；
5. **回调派发**：单 goroutine 串行派发（见第五节）。

---

# 三、服务端最小改动（仅 2 处，其余零改动）

## 3.1 新增 platform 值 `game`

- `server.go` 的 `c.platform = strings.TrimSpace(msg.Platform)`（L585）无白名单校验——**无需改动**；
- `hub.go` 的 `platformName()`（L76）新增 `case "game": return "游戏端"`——互踢提示与后台在线列表文案归口；
- 同端互踢语义自动成立：`game↔game` 互踢（同游戏多开仅保留最新），`game` 与 `pc/web/app` **跨端共存**——玩家可同时挂在 IM PC 客户端和游戏内。

## 3.2 `gamenet.go` 两处平台判定放宽

| 位置 | 现状 | 改为 | 理由 |
|---|---|---|---|
| `gnNetProbe` L1090 发起端校验 | `c.platform != "pc"` 回绝 | 非 `pc && 非 game` 回绝 | 形态二由 Electron 承载端口监听须 PC；形态一 SDK 自建 DataChannel，`game` 端同样具备发起能力 |
| `gnNetProbe` L1118 房主能力判定 | `s.hub.HasPC(to)` | 新增 `s.hub.HasGamePeer(to)`（pc 或 game 任一端在线即具备房主能力） | SDK 成员可作为房主（游戏进程即房主端） |

- `HasGamePeer` 实现放 `hub.go`：与 `HasPC`（L176）同款遍历，判定 `c.platform == "pc" || c.platform == "game"`；
- 集群注释（L1115-1117）同步改写；
- `mode` 字段（lane/tunnel/both）**不参与能力判定**（与现状一致，避免引入服务端分支）；配置注释更新说明。

**风险面**：上述改动只放宽联机 110 层的平台准入，109 房间层与既有通话/会议/直传/远程路径零接触；形态二 PC 端行为不变（`pc` 仍在放行集）。

---

# 四、SDK 接口定义（C ABI）

设计约束：**纯 C ABI**（游戏引擎绑定面最小）、复杂参数一律 JSON 字符串（规避跨 ABI 结构体布局差异）、所有房间操作**异步受理**（成败经回调回吐，同步返回值只做快速失败）。

## 4.1 返回码（同步）

| 值 | 含义 |
|---|---|
| 0 | 已受理（异步结果以 `on_event` 为准） |
| -1 | 参数错误（JSON 非法 / len 越界） |
| -2 | 未初始化或句柄无效 |
| -3 | 未登录（需等 `EV_LOGGED_IN` 后才可房间操作） |
| -4 | 状态机不允许（如非房主调 StartGame） |
| -5 | 正在关停 |

## 4.2 生命周期

```c
typedef struct GnCallbacks {
    void (*on_event)(int64_t handle, int code, const char* json, void* user); // 统一异步事件
    void (*on_data) (int64_t handle, uint32_t from_uid, uint8_t channel,
                     const uint8_t* data, int len, void* user);               // 游戏数据
    void (*on_log)  (int64_t handle, int level, const char* text, void* user);
    void* user;                                                               // 透传游戏侧指针
} GnCallbacks;

int64_t GnSdk_Init(const char* init_json, GnCallbacks cb);   // 返回句柄，0=失败
void    GnSdk_Shutdown(int64_t handle);                      // 幂等；内部断 WS/收 DC/停派发
const char* GnSdk_Version(void);                             // 静态串，无需释放
```

`init_json`：

```json
{ "server": "ws://host:2087/ws", "username": "u1", "password": "p1",
  "game_id": 12, "game_name": "示例游戏", "log_level": "info" }
```

**回调契约（游戏侧必须遵守）**：
- 三条回调固定在 SDK 的**单派发线程**串行执行——游戏回调内**无需加锁**；
- 回调内**禁止阻塞/等待**（尤其禁止等待下一个回调），耗时处理请入游戏自有队列；
- `on_data` 的 `data` 指针**仅在本次回调内有效**，跨线程使用请自行拷贝（SDK 已做单次拷贝，不再为每包二次分配）；
- 回调指针仅在 `Init` 时注册，运行期不可更换；`Shutdown` 后全部失效。

## 4.3 房间操作（109 全复用，异步）

```c
int GnSdk_CreateRoom  (int64_t h, const char* json); // {"name","host_port"?,"game_mode","max_players","pass"?}
int GnSdk_JoinRoom    (int64_t h, const char* json); // {"room_id","pass"?}
int GnSdk_LeaveRoom   (int64_t h);
int GnSdk_SetReady    (int64_t h, int ready);
int GnSdk_StartGame   (int64_t h);                   // 仅房主
int GnSdk_TransferHost(int64_t h, const char* target_username);
int GnSdk_Chat        (int64_t h, const char* text);
int GnSdk_ListRooms   (int64_t h, const char* filter_json); // 复用 109 list（含 game_id 筛选）
```

## 4.4 数据面（110 建连后）

```c
// channel: 0 = reliable-ordered（映射 gn-tcp 语义）；1 = unreliable-unordered（映射 gn-udp 语义）
int GnSdk_Send      (int64_t h, uint32_t to_uid, uint8_t channel, const uint8_t* data, int len);
int GnSdk_Broadcast (int64_t h, uint8_t channel, const uint8_t* data, int len);
int GnSdk_LinkState (int64_t h, char* buf, int buf_len); // 同步拉取快照 JSON（房间/成员/链路态），返回实际长度
```

- 单包上限 **64KB**（DataChannel 消息上限约束，SDK 拒绝超限并回 `EV_SEND_DROP`）；
- `unreliable` 通道发送缓冲满 → **丢本包**（游戏语义：新包优先）+ `EV_UDP_OVERFLOW` 计数事件；
- `to_uid=0` 于 `Send` 视为参数错误（广播请用 `Broadcast`）。

## 4.5 uid 映射（跨 ABI 省字符串开销）

游戏侧只认 `uint32 uid`，SDK 内部维护 `username ↔ uid` 映射：

- uid 从 **1 起自增**分配（会话内唯一），映射全量随 `EV_ROOM_STATE` 事件的 `members[].uid` 下发，增删随增量事件维护；
- `TransferHost` / 邀请等需要 username 的场景由游戏从 `EV_ROOM_STATE` 缓存反查（SDK 提供 `GnSdk_UidOf(h, buf, buf_len, username)` 不设——减少 API 面，游戏缓存即可）。

## 4.6 统一事件表（on_event 的 code）

| code | 事件 | json 要点 |
|---|---|---|
| 1 | `EV_LOGGED_IN` | `{username, uid}` |
| 2 | `EV_LOGIN_FAIL` | `{reason}` 后 SDK 自动重连退避 |
| 10 | `EV_ROOM_STATE` | 109 state 全量：`{room_id,host,host_port,status,members:[{username,uid,ready,host,online}]}` |
| 11 | `EV_ROOM_CREATED` / 12 `EV_ROOM_CLOSED` | `{room_id, reason?}` |
| 13 | `EV_HOST_CHANGED` | 房主转让收口：`{room_id, new_host}`（含 SDK 内部隧道重挂） |
| 14 | `EV_ROOM_ERROR` | 服务端 9 帧归口：`{text}` |
| 20 | `EV_LINKED` | `{room_id, peer_uid, role}` 链路就绪（ctl 打通） |
| 21 | `EV_LINK_LOST` | `{room_id, peer_uid, reason}` |
| 22 | `EV_UDP_OVERFLOW` | `{peer_uid, dropped}` 丢包计数 |
| 30 | `EV_KICKED` / 31 `EV_SELF_REMOVED` | 被移出房间 |
| 90 | `EV_LOG` 附属 / 99 `EV_SHUTDOWN` | — |

---

# 五、线程模型

## 5.1 SDK 内部 goroutine

| # | goroutine | 职责 |
|---|---|---|
| G1 | WS 读 | 7/8/9/109/110/112 帧解包、心跳 |
| G2 | pion 内部 | ICE 收集、DC onmessage（pion 自管） |
| G3 | **回调派发（唯一）** | 有界队列（4096 条，满丢最旧+计数）→ `runtime.LockOSThread` 串行调用游戏回调 |
| G4 | 重连/看门狗 | WS 指数退避（1s→2s→…→30s 封顶）、ping 周期、协商超时 |

## 5.2 数据路径

- **收**：DC onmessage → 剥帧头 → 每对端独立有界环形缓冲（256 条 / 1MB，溢出丢最旧 + `EV_UDP_OVERFLOW`）→ G3 → `on_data`；
- **发**：`Send` → 路由判定（成员→房主 DC 直发；房主→成员直发；房主收到成员间包按帧头一跳转发）→ `dc.Write`（同步写，pion 自带缓冲）；
- **跨 ABI 调用**：G3 派发线程调用 C 函数指针（c-shared 反向调用，实施 M1 第一周先用最小 demo 验证 amd64/386 两条调用约定——**已知风险点**）。

## 5.3 重连语义

- WS 断线：指数退避重连 + 重新登录（账号密码重放；`register_enabled=false` 环境下账号必已存在，无注册分支）；
- 重连成功：109 `state` 拉全量重建房间视图 → 若此前处于联机中，按 role 重新 probe（110 幂等：同对端新 `conn_id` 先收旧连接，服务端/对端均已按此口径处理——见 `gn-net.js` probe 去重逻辑）；
- DataChannel 断而 WS 活：直接重 probe，不重建房间。

---

# 六、与现有 110 信令的对接（帧级映射）

## 6.1 建连时序（与形态二完全同构，加入者 = offerer）

| # | 动作 | 方向 | 110 content 关键字段 | SDK 行为 |
|---|---|---|---|---|
| 1 | probe | 成员→房主 | `{action:"probe", conn_id, room_id, platform:"game"}` | 服务端校验成员资格/房主能力（3.2 放宽后）→ 转发并注入 `ice` |
| 2 | accept | 房主→成员 | `{action:"accept", conn_id, platform}` | 成员建 PC，创建 3 条 DC 后发 offer |
| 3 | offer | 成员→房主 | `{action:"offer", conn_id, sdp}` | 服务端中继（注入 ice）→ 房主 setRemote + answer |
| 4 | candidate | 双向 | `{action:"candidate", conn_id, candidate:{...}}` | 原样中继，透传 pion |
| 5 | answer | 房主→成员 | `{action:"answer", conn_id, sdp}` | 成员 setRemote |
| 6 | linked | —（本地） | — | **ctl DC open = 端到端就绪**，撤协商超时，回 `EV_LINKED` |
| 7 | ping | 双向 5s | `{action:"ping", conn_id}` | 保活（服务端 `gnNetPing` 刷会话 + 续房间 TTL） |
| 8 | abort | 双向 | `{action:"abort", conn_id, reason}` | 收口；重试策略见 5.3 |

- `conn_id`：SDK 内 UUID 生成，规则同形态二（重试换新 id）；
- 协商超时：沿用服务端下发的 `game_net.negotiate_timeout`（默认 10s）；
- `probe_fail` reason 表全复用（`unsupported / room_closed / forbidden / offline / busy / timeout / already_accepted`）。

## 6.2 DataChannel 与帧头

三条通道 label 与形态二保持同名（为后续 SDK↔Electron 混房互通预留，一期不承诺）：

| label | 参数 | 用途 |
|---|---|---|
| `gn-ctl` | ordered | 保活触达（内容仅刷新活跃），链路状态判定 |
| `gn-udp` | `ordered:false, maxRetransmits:0` | **不可靠无序游戏数据**（形态一主通道） |
| `gn-tcp` | ordered | 可靠有序（房间内需要可靠性的小数据，如聊天外游戏事件） |

DC 内应用层帧头（SDK 归口，游戏无感知）——**星型路由一跳转发**：

```
偏移  长度  字段
0     1    ver（当前 1）
1     1    flags（bit0: 1=房主转发包；其余保留，收端忽略未知位）
2     4    target_uid（小端；0=广播，仅房主展开）
6     ..   payload（游戏数据，≤64KB）
```

- 成员 A → 成员 B：A 发 `target_uid=B` → 房主剥包校验 B 在房 → 换 `flags bit0=1` 转发 → B 收包；
- 成员 → 房主：`target_uid=房主uid`；房主 → 全体：`Broadcast`（房主本地循环发送，无需帧头）；
- 防环：`flags bit0=1` 的包房主**不再转发**（一跳语义，硬件式 TTL=1）。

## 6.3 ICE / 中继

- `iceServers` **全部来自服务端注入**（probe/accept/offer 帧的 `ice` 字段，SDK 不内置任何地址）；
- `game_net.relay.enabled=true` → 联机专用池（`3479` / `49961~50760`）；`false` → 回退主实例池——SDK 完全无感知；
- 候选优先级 host → srflx → relay（WebRTC 标准，pion 默认）。

---

# 七、构建与产物

- 独立 Go module：`e:\SourceCodeIM\im-sdk\`（复用服务端 Go 工具链与 `protocol` 常量——经复制保持解耦，避免 SDK 拖上服务端依赖树）；
- 产物：

```
im-sdk/bin/gn_sdk_x64.dll    # GOOS=windows GOARCH=amd64 -buildmode=c-shared
im-sdk/bin/gn_sdk_x86.dll    # GOOS=windows GOARCH=386   -buildmode=c-shared（32 位游戏必须）
im-sdk/include/gn_sdk.h      # 手写 C 头（与导出表一一对应）
im-sdk/examples/c_host/      # 最小 C 宿主（协议级联测用）
im-sdk/examples/unity/       # Unity C# 绑定示例（M2）
```

- 版本：`GnSdk_Version()` 返回 semver；兼容性由 109/110 信令稳定性保障（服务端向后兼容现有字段）；
- 产物按项目惯例同步到 `im-client/bin/`？——**不**，SDK 独立分发（游戏工程直接引用 `im-sdk/bin`），不进 IM 客户端包。

---

# 八、安全

| 项 | 口径 |
|---|---|
| 身份 | 复用 IM 账号体系（7 帧登录）；凭证仅驻内存，不落盘；日志不打印密码 |
| 数据面 | DTLS（WebRTC 强制）——比形态二裸 UDP/TCP 转发链路更强 |
| 服务端防线 | 110 `from_user` 归口防伪造、成员资格/黑名单/口令/水位上限全部继承；SDK 无法绕过（服务端是唯一信令归口） |
| 平台伪装 | `platform="game"` 由服务端登录帧声明；`HasGamePeer` 判定后房主端实际建连能力由对端 probe 超时自愈兜底（同形态二口径） |
| 后续 | M2 引入 **token 免密登录**（IM 客户端签发一次性令牌，替代 init_json 明文密码——避免游戏配置文件存密码） |

---

# 九、测试计划（实施阶段执行，不属本设计评审范围的内容仅列大纲）

1. **单测**：帧头编解码、uid 表增删、建连状态机（probing→accepted→linked→abort）、重连退避；
2. **协议级 E2E**：`examples/c_host` 双实例互联（复用二期实测链路：好友→建房→加入→建连→收发→转让→收口），断言 probe 注入 `ice`、unreliable 丢包计数、房主一跳转发、abort 收口；
3. **回归**：`gnNetProbe` 平台放宽后形态二（PC 隧道）全链路复测；`HasGamePeer` 不影响既有 `HasPC` 调用点（通话忙态等）；
4. **性能**：Send 往返延迟基线、64KB×高-rate 洪泛下的丢包/内存水位（有界队列封顶验证）；
5. **安全/隐私**：不落盘凭证核验、DTLS 抓包验证、日志脱敏抽查。

---

# 十、实施分期

| 期 | 内容 | 交付 |
|---|---|---|
| **SDK-M1** | 服务端 2 处改动（3.1/3.2）+ SDK 核心（Init/登录/109 全动作/110 建连/双通道收发/房主转发/心跳重连）+ C 宿主联测 | `gn_sdk_x64.dll` + `gn_sdk_x86.dll` + `gn_sdk.h` + E2E 报告 |
| **SDK-M2** | 112 大厅接入、token 免密登录、Unity C# 绑定示例、邀请卡片联动（经 `EV_ROOM_*` 事件供游戏/IM 联动）；**广播发现代理（方案 B，§十一，魔兽 III 首个适配）：首选 PC 客户端集成（`gn-broadcast.js`）落地，独立 EXE `gn_sdk_host.exe` 为后续扩展宿主** | 绑定示例 + PC 集成广播 + EXE + 文档更新 |
| **SDK-M3** | SDK↔形态二混房互通评估（同 label 同帧头）、中继集群节点选择（§16 配合）、虚拟网卡路线（原功能三期项，视 M2 发现代理覆盖度重评） | 评估结论 |

**已知风险点（M1 优先消化）**：
1. c-shared 反向回调（Go→C 函数指针）在 amd64/386 两条调用约定下的正确性——M1 第一周用最小 demo 验证，若 386 有硬伤则降级方案：SDK 拆「32 位壳进程 + 命名管道」（接口不变，产物形态变化，提前告知）；
2. `pion/webrtc` 在 386 的编译兼容性（纯 Go，理论无 cgo，预期无碍，M1 首周同验）。

---

# 十一、广播发现代理（方案 B：伪造广播让游戏 LAN 列表直接出现房间）

> 目标体验：**好友建房/加入后，打开魔兽 III →「局域网游戏」列表直接看到好友房间 → 点加入开打**——玩家全程不输 IP。
> **宿主两形态，PC 客户端集成为 M2 首选**（见 11.0）；核心逻辑（模板/发生器/UDP NAT）宿主无关，独立 EXE 为后续扩展宿主。

## 11.0 宿主形态与实施顺序（M2）

| 形态 | 落地位置 | 触发流程 | 定位 |
|---|---|---|---|
| **A. PC 客户端集成（首选）** | Electron 主进程新增 `gn-broadcast.js`（Node dgram，与 `gn-net.js` 同生命周期） | **现有客户端流程**：建房/加入后按房间态自动广播 | 直接受益于好友联机主流程；role 由房间态天然给出，零角色探测；随客户端分发零安装 |
| B. 独立 EXE `gn_sdk_host.exe`（后续） | Go 独立进程 | 双击自动匹配，脱离 IM 客户端 | 覆盖不通过 IM 客户端联机的场景（含无 IM 在场玩家） |

- **共用资产**：广播包模板（二进制底包 + 字段偏移描述 JSON，**语言无关**）+ 发生器口径（周期 / 字段填充 / `[IM]` 前缀 / 开关）+ UDP NAT 语义——A/B 两实现同逻辑；
- **实施顺序**：M2-H1 抓包 → **形态 A 落地**（含 M2-H2/H3 回环与跨机实测）→ 形态 B（复用同模板，补自动匹配 / 托盘 / 凭据，见 11.5/11.6）；
- 服务端改动：两形态均**零新增**（3.1/3.2 已覆盖）。

## 11.1 定位与产物

```
im-client/web/js/gn-broadcast.js   # 形态 A：PC 客户端广播发生器（Electron 主进程，Node dgram）
im-sdk/bin/gn_sdk_host.exe         # 形态 B：独立后台进程（GOOS=windows GOARCH=amd64，普通 EXE 非 c-shared）
im-sdk/templates/                  # 广播包模板库（语言无关，A/B 共用，见 11.4-4）
im-sdk/docs/魔兽III广播包格式.md    # M2-H1 实测产出（格式以抓包为准，禁止猜测）
```

- 形态 A 随 PC 客户端 web 资源分发（主进程 require），**零额外进程、零安装**，与现有隧道引擎同生命周期；
- 形态 B 为独立进程，与游戏位数无关（32 位魔兽 III 也能配 x64 EXE）——SDK 的 386 双架构问题在 EXE 形态下不存在；
- 服务端改动：两形态均**零新增**（3.1/3.2 已覆盖 `game` 平台）；M2 的 token 免密登录若落地则属服务端第三处改动（见 11.6，与 SDK 共用）。

## 11.2 数据链路（魔兽 III 实例，宿主无关）

魔兽 III 联机两环节：**广播发现**（主机向 `255.255.255.255:6112` 发 game info，客户端列表靠它刷新，无手动输 IP 入口）+ **游戏数据**（加入者直连主机 `UDP 6112`，多开递增）。代理分角色各管一环（图中「广播代理」= 形态 A 的 PC 客户端主进程 / 形态 B 的 EXE，逻辑同源）：

> **实现修正（2026-10-15，形态 A 已落地）**：抓公开协议资料（w3gsdump 实测 dump + 1.32 版结构分析）后确认经典 W3GS LAN 的真实工作方式与「主动伪造广播」不同，是**虚拟主机应答模型**——
> ① 本机游戏（加入方，列表页）周期向 `255.255.255.255:6112` 发 **SearchGame（0xF7 0x2F）**；② 加入方客户端 join 隧道恰好 bind `0.0.0.0:<host_port>` → 收到搜索帧，**以虚拟主机身份单播应答 GameInfo（0xF7 0x30）**（房间名/人数来自 109 state，应答源地址=本机 → 列表条目地址命中隧道监听）；③ 周期发 **RefreshGame（0xF7 0x33）** 广播维持条目；④ 玩家点加入 → 游戏走 **TCP 连本机：6112**（W3GS 加入是 TCP）→ 命中既有 join 隧道 → 字节经 DataChannel 到房主游戏。
> 比原设计更简：无需嗅探、无需主动伪造源地址、且 **RefreshGame/应答复用 join 隧道套接字**（源端口与游戏看到的主机端口一致），SearchGame 帧本地消费**不进隧道**（避免给房主游戏塞垃圾包）。落地文件：`im-client/pc/game-broadcast.js`（策略与包构造）+ `game-tunnel.js`（钩子/广播发送口）+ `preload.js`（`gnBroadcastStart/Stop`）+ `gn-room.js`（join 隧道就绪启动 / 收口停止 / state 同步人数）。

```
加入侧 B（普通 UDP，无需管理员）                    主机侧 A（游戏真实主机）
┌─ 魔兽III(B) ─┐   ┌─ 广播代理(B) ────┐          ┌─ 广播代理(A) ────┐   ┌─ 魔兽III(A) ─┐
│ LAN 列表页    │←──│ bind 0.0.0.0:6112 │          │ UDP NAT 代理表    │←──│ 监听 :6112    │
│ 「[IM]房间名」│   │ 伪造广播发生器     │          │  成员i↔127.0.0.1:p│   └──────────────┘
└──────┬───────┘   └────────┬──────────┘          └────────┬──────────┘
       │ 点加入 → 连 本机:6112                               │
       └───────────> UDP 6112 ═══ DataChannel(DTLS) ═══════╝
                    （gn-udp 不可靠无序通道，与形态二同款 110 建连）
```

- **加入侧 B**：代理在游戏启动前 `bind 0.0.0.0:6112`（游戏作加入方不占 6112，仅主机占）→ 周期性发**伪造 game info 广播**（11.4）→ 玩家在游戏列表看到房间（主机地址显示为本机 IP）→ 点加入 → 游戏连 `本机:6112` → 命中代理监听 → 字节流经 DC 隧道转发到房主侧；
- **主机侧 A**：魔兽已占 6112，代理**不抢端口**，为每个远端成员 i 维护一条本地 UDP 代理（`127.0.0.1:随机端口` ↔ DC），隧道来的包写给 `127.0.0.1:6112`，游戏回包按五元组原路回——即 **UDP NAT**（形态 A 中房主侧现有隧道引擎已具备同款逻辑）；
- **同 IP 不同端口 = 不同玩家**：魔兽主机按地址五元组区分玩家，`127.0.0.1` 多端口多玩家与浩方/VS 对战平台把全网玩家 NAT 成同一出口 IP 的多年先例同构，可行性有历史验证；
- **无需成员间转发引擎**：魔兽主机模式本身是游戏层星型（所有玩家连游戏主机 = 房间房主），玩家间数据由游戏主机中转——代理只需「成员↔房主」链路，**天然对齐 110 现有拓扑**，SDK 设计 §6.2 的帧头转发引擎在广播代理场景不启用（形态 A/B 皆然）。

## 11.3 与 110 信令的对接（复用，无新信令；两形态一致）

| 代理动作 | 信令 | 说明 |
|---|---|---|
| 静默登录 | 7 帧，`platform:"game"` | 形态 B；形态 A 复用 PC 客户端既有登录态（跨端共存不互踢同源，3.1） |
| 自动匹配入房 | 109 list（`game_id` 筛选）/ create / join | 形态 B 状态机（11.5）；形态 A 由玩家在房间页操作 |
| 建立隧道 | 110 probe→accept→offer/answer/candidate | **与 §6.1 时序逐帧一致**（加入侧 offerer，`gn-ctl/gn-udp/gn-tcp` 同 label）；DC 建通后进入纯字节转发，不做任何解析 |
| 保活/收口 | 110 ping 5s / abort | 同 §6.1 第 7/8 步 |
| 房主转让/踢人 | 109 transfer / state | 收到 `EV_HOST_CHANGED`（形态 A：109 state 的 host 变更）后按新 role 重建隧道（客户端已有 `rewireHost` 同逻辑） |

**转发语义**：EXE 隧道是**四层以下透明字节管道**——不解析游戏协议、不重组、不缓存重组序（unreliable DC 保留丢包语义，游戏自愈）；魔兽包尺寸小（≤1400B 常见），64KB DC 上限不构成约束。

## 11.4 广播发现代理（魔兽 III 专项）

### 11.4-1 三无设计（相对 Hamachi 类方案的核心简化）

| 传统方案 | 本设计 |
|---|---|
| 嗅探主机广播再转发（需 npcap/SIO_RCVALL 原始套接字 + 管理员） | **不嗅探**——广播包由服务端 109 房间数据驱动**重新构造** |
| 伪造 UDP 源 IP（raw socket IP_HDRINCL + 管理员） | **不伪造源 IP**——普通 UDP socket 发广播，源地址即本机 IP，游戏连"本机:6112"恰好命中 EXE 监听 |
| 虚拟网卡 / 本机补假 IP（netsh + 管理员） | **不动网络配置**——零驱动、零路由表变更 |

**结论：加入侧全程普通用户权限**（唯一要求是防火墙放行，见 11.4-6）。

### 11.4-2 伪造广播的发生

- 触发：代理进入「已入房（waiting）」状态后，以 5s 周期向 `255.255.255.255:6112` 发 game info；离开房间/进 playing 即停（**仅加入方发送**——房主侧游戏自建主机无需看列表）；
- 内容：按模板（11.4-4）填充——游戏名（`[IM] {房主昵称}的房间`）、地图占位、当前人数/上限（形态 A 直接消费 109 `state`，形态 B 经 `EV_ROOM_STATE`）、版本指纹；
- 有效性：魔兽客户端列表刷新即依赖收到该包，加入时直接连**收包源地址**（本机）——行为链闭环于本机，无需跨机一致性。

### 11.4-3 角色判定与 bind 前置条件

| 形态 | 角色判定 | 行为 |
|---|---|---|
| **A. PC 客户端集成** | **房间 role 天然给出**（房主=主机方 / 成员=加入方，零探测） | 加入方：`connect` 时 bind `host_port` + 伪造广播；房主方：不 bind（游戏已占）仅 UDP NAT——与现有隧道 role 完全一致 |
| B. 独立 EXE | 启动时探测 6112 | 空闲 → 加入方（bind + 伪造广播 + 等待匹配/加入）；被占（本机已开魔兽当主机）→ 主机方（不 bind、不广播，仅起 UDP NAT） |

- 多开递增端口（6113/6114…）**一期不支持**（同机单开，两形态同口径）；
- 游戏启动顺序：代理先 bind 再由玩家手动启动游戏（代理不代启游戏，避免权限/路径耦合；形态 A 在房间页提示，形态 B 托盘提供「复制启动说明」）。

### 11.4-4 包模板机制（按游戏适配的扩展点，禁止猜测）

- **魔兽 III 广播包格式不在本设计中硬编码**——M2-H1 专项先抓包实测（Wireshark 过滤 `udp.port==6112`，基准版本国内主流 1.24e / 1.26），产出《魔兽 III 广播包格式记录》与模板文件；
- 模板 = 二进制底包（`templates/war3_126.bin`）+ 字段偏移描述 JSON（游戏名/地图/人数/校验各字段的偏移、编码、长度）——**适配新广播游戏只加模板不改代码**（红警/CS 1.6 等后续按此扩展）；
- 实测结论回填后如发现校验字段（checksum），在模板描述中声明算法（crc32/自定义），由 EXE 通用填充器计算。

### 11.4-5 已知副作用与缓解

| 副作用 | 缓解 |
|---|---|
| **真实局域网污染**：同局域网其他魔兽玩家会看到伪造房间 | 游戏名强制 `[IM]` 前缀（可辨识）；托盘提供「仅好友发现」开关（改单播好友 IP，不上广播） |
| 本机 6112 被 unrelated 程序占用 | 探测后明确托盘报错，不静默降级 |
| 防火墙拦截 | 首次运行自绘提示窗引导放行 UDP 6112 与 EXE 自身（一次） |

### 11.4-6 重制版（Reforged）边界

1.35+ 官方 LAN 同为 UDP 广播，但**强制暴雪账号在线登录后才能进 LAN 菜单**——模板适配需实测确认可达性后再承诺；一期适配目标锁定经典 1.24e/1.26。

## 11.5 进程模型与自动匹配状态机（形态 B 专属；形态 A 由现有房间页 UI 承担，无新增状态机）

```
未登录 ──静默登录──> 空闲 ──自动匹配──> 匹配中 ──┬─有等待房──> 已入房(waiting, 伪造广播+自动ready)
   │                │            │              └─无房──自动建房──┘
   └─首次运行:自绘登录窗           联机中(playing) ──游戏退出/房解散──> 空闲
```

- **自动匹配**：按 `game_id` 拉取 109 list——有未满等待房即 join，无即 create（房名 = `[IM] {昵称}`）；自动 `SetReady(true)`（托盘可关）；
- **开局**：房主（首个进入者）在托盘菜单点「开始游戏」或经 IM 客户端房间卡片操作（M2 邀请联动）；其余成员收到 109 start 后托盘提示「请启动魔兽 III 加入」；
- **托盘**：无主窗口——图标（状态着色：灰=未登录/黄=匹配中/绿=联机中）+ 右键菜单（状态行 / 开始 / 断开 / 退出）+ **自绘气泡通知**（无边框置顶小窗，底部渐隐，禁系统气泡弹窗，样式对齐 IM 主题色规范）；
- **退出净收口**：托盘退出 → 110 abort + 109 leave + WS 关闭，无残留会话（服务端 TTL 兜底）。

## 11.6 凭据安全（形态 B 专属；形态 A 复用 PC 客户端既有登录态，零新增）

- **首次运行**：自绘无边框登录小窗（微信登录页同款视觉，见 docs/UI.png 规范）输入账号密码 → 7 帧登录成功 → 请求 token（M2「token 免密登录」：服务端签发长效 token，复用扫码登录 `qrc:` 同源的前缀机制扩展 `tok:` 前缀，M2 细化）；
- **落盘**：token 经 **DPAPI（CryptProtectData，当前用户域）** 加密存 `%APPDATA%\im-sdk\cred.bin`——密码不落盘、跨用户不可解；
- **后续运行**：读 token 静默登录；token 失效自动回退登录窗；
- 与 SDK DLL 共用同一 token 机制（SDK 场景由游戏方传 token 而非密码）。

## 11.7 内核复用矩阵（三种产物形态）

| 内核模块 | SDK DLL | PC 客户端集成（形态 A） | EXE 宿主（形态 B） |
|---|---|---|---|
| WS 信令 / 109 / 110 状态机 / pion 数据面 / 重连退避 | ✅ 复用 | ✅（复用客户端既有 `gn-net` 隧道引擎，零移植） | ✅ 完全同源（Go 移植） |
| C ABI 导出层 | ✅ | ❌ | ❌ |
| 房主帧头转发引擎（§6.2） | ✅ | ❌ | ❌（魔兽星型无需） |
| 广播发生器 / 模板填充器 | ❌ | ✅（JS 实现，Node dgram） | ✅（Go 实现，同模板同口径） |
| UDP NAT（主机侧） | — | ✅（现有隧道 host 侧逻辑已具备） | ✅ |
| uid 映射 / 事件表 | ✅ | ❌（房间页直用 109 state） | 简化（托盘状态机消费） |
| 自动匹配 / 托盘 / DPAPI 凭据 | ❌ | ❌（房间页 UI 承担） | ✅（11.5/11.6） |

**形态 A 的增量最小**：一台已装客户端的机器上，新增代码仅「广播发生器 + 模板填充」（JS），隧道/NAT/角色全部复用现有实现。

## 11.8 实测清单（M2 执行，先实测后编码；M2-H1/H2/H3 形态 A 先行，B 复用同清单）

| # | 项 | 通过标准 |
|---|---|---|
| M2-H1 | 魔兽 III 1.24e/1.26 广播包抓包 | 产出格式记录 + 模板底包 + 偏移描述，包结构可复现填充 |
| M2-H2 | 加入侧单机回环（形态 A） | **机制层已完成并自测 14/14 PASS**（2026-10-15：SearchGame 应答/GameInfo 构造/RefreshGame 投递/重入更新/stop 收口，真实 UDP 往返验证）；列表可见性待真实魔兽 III 环境复验 |
| M2-H1' | **抓包校准（M2-H1 的执行形态已内置）** | 代理每会话首次应答/刷新自动 dump 发出包 hex 到主进程控制台——与本机真实魔兽主机的广播包（同网段抓包或代理日志）对照，修正 `game-broadcast.js` build 函数字段宽度即可，机制层零改动 |
| M2-H3 | 跨机协议级 E2E（形态 A） | 两真机（复用二期实测链路账号）：列表可见→加入→DC 建通→字节往返→房主侧写入 6112→游戏内可见玩家 |
| M2-H4 | 三人星型 | 2 成员 + 1 主机，游戏内三人互见、开始对局 |
| M2-H5 | 转让/退出收口 | transfer 后双方隧道重建、退出后广播停止、无端口残留 |
| M2-H6 | 形态 B 复测（EXE 宿主） | 同 M2-H2~H5 场景以 EXE 复跑（自动匹配/托盘链路一并验证） |
| M2-H7 | Reforged 1.3x 探测 | 确认 LAN 可达性与门槛，结论回填 §11.4-6（不通过则维持经典版范围） |
| 回归 | 形态二/SDK 全链路 | 广播代理零服务端改动，形态二 PC 隧道与既有联机全流程复测通过 |

**广播代理专属风险点（两形态同源）**：
1. 魔兽广播包格式版本漂移 / 存在校验字段——模板机制 + M2-H1 先行实测缓解；实测不通过（有强校验且算法未知）时降级路径：本机补假 IP 方案（netsh，需管理员，作为 B' 变体保留）；
2. 部分游戏对 `255.255.255.255` 与子网定向广播的接收差异——M2-H2 用两台真机验证，不只回环；
3. 防火墙/安全软件拦截 UDP 广播——形态 A 由客户端首次运行引导放行，形态 B 靠安装文档 + 首次运行引导。
