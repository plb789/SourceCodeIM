# P2P 直传文件详细设计（拟纳入阶段一百五十六）

# 一、背景与目标

## 1.1 背景

当前好友间文件传输全部经服务端中转（三层分流：WS 分片协议 / HTTP 单请求直传 / HTTP 分片直传），所有文件字节均占用服务器带宽并落盘服务端。大文件（如视频、安装包）在公网部署场景下对服务器上行带宽、磁盘、内存均构成主要压力源。

项目已具备完整的 WebRTC P2P 基础设施：

| 已有能力 | 位置 | 说明 |
|---------|------|------|
| 内置 TURN/STUN 中继 | im-server/server/turn.go | pion/turn v4 与 im-server 同进程，config.yaml `turn:` 节配置，长期凭证（RFC 5766），域名巡检自动切换 |
| 信令下发 ICE 配置 | turn.go `TurnICEServers()` / call.go `callInjectICE()` | 经 invite/accept 帧向双方下发 iceServers，未启用时客户端退化为纯 P2P 零改动兼容 |
| 通话信令状态机 | im-server/server/call.go（msg_type=70） | invite/accept/offer/answer/candidate 完整状态机：好友与黑名单校验、from_user 归口防伪造、多端转发、超时兜底、离线宽限 |
| DataChannel 实战 | im-client/web/js/remote-engine.js | 远程协助已用 `createDataChannel('remote-input', {ordered:true})` 点对点直传控制事件 |
| 文件三层分流 | chat.js sendFile 入口 | 小文件 WS 分片（chunk_size 64KB）/ 中文件 HTTP 直传（1MB~20MB）/ 超大文件分片直传（20MB~2GB，进度气泡 + 取消） |

## 1.2 目标

1. 好友私聊大文件优先 P2P 直连传输（WebRTC DataChannel），不经服务器，节省服务器带宽与磁盘；
2. 打洞失败 / 接收方离线 / 传输中断时**无缝回退**现有 HTTP 分片直传链路，送达率 100%，用户无感；
3. 服务端数据归口原则不破坏：传输决策（是否走 P2P）由服务端归口判定，元信息落库保证历史可见；
4. 小文件链路零改动，群聊零改动，离线收文件零改动，回归风险集中在新增模块。

## 1.3 非目标（一期不做）

- 群聊文件 P2P（mesh 多点打洞复杂，群聊维持 HTTP 链路）；
- 手机 APP 端 P2P（Capacitor WebView WebRTC 支持有限，一期手机端自然回退 HTTP 链路，二期评估）；
- 断点续传跨链路复用（P2P 中途失败回退 HTTP 需全量重传，因服务端无 P2P 已传数据，属兜底路径可接受）。

# 二、总体架构：混合模式决策流程

```
发送方选择文件
      │
      ▼
┌─────────────────────────────┐
│ 大小 < file_p2p.threshold ？ │──是──▶ 现有链路（WS 分片 / HTTP 直传），完全不变
└─────────────────────────────┘
      │否
      ▼
发 P2P probe 信令（msg_type=91）→ 服务端归口判定
      │
      ├─ 接收方无可 P2P 端在线 ──▶ 服务端回 probe_fail(offline) ──▶ 回退现有 HTTP 分片直传
      ├─ file_p2p.enabled=false ─▶ 服务端回 probe_fail(disabled) ─▶ 同上
      │
      ▼ 接收方在线：probe 转发到接收方全部在线端，各端自动 accept（先到先得，服务端归口唯一赢家）
      │
SDP/ICE 协商（offer/answer/candidate 经服务端中继，服务端注入 ice_servers，复用 callInjectICE）
      │
      ├─ 10s 协商超时 / ICE failed ──▶ abort 信令 + 客户端自动回退 HTTP 分片直传
      │
      ▼
DataChannel 直传（分片 + 累计 ACK + 背压限速 + SHA-256 校验），进度气泡标注"直传"
      │
      ├─ 传输中断（DataChannel onclose / 30s 无数据）─▶ 气泡保留进度，自动回退 HTTP 分片直传全量重传
      │
      ▼
双方发 done 信令 → 服务端归口落库文件消息（元信息）→ 气泡替换为文件卡片
      │
      └─ archive=true 时发送方异步 POST /upload/file 归档副本，FILE_PERSISTED 回填 url（历史永久可下载）
```

核心原则：**P2P 是加速路径，现有 HTTP 链路是兜底路径**。任何环节失败都自动降级，功能可用性不受影响；收益（省带宽）是纯增量。

# 三、信令协议设计（msg_type=91，FILE_P2P_SIGNAL）

## 3.1 消息类型定义

protocol/message.go 新增（90 已被 MsgTypeRemoteSignal 占用）：

```go
// 阶段一百五十六：好友文件 P2P 直传信令（WebRTC DataChannel，服务端仅转发信令 + 归口判定）
// content 为 JSON：{action, transfer_id, name?, size?, mime?, sha256?, reason?, sdp?, candidate?, platform?}
// action 取值：
//   probe（发送方→服务端→接收方全部在线端）/ accept（接收方→发送方，先到先得服务端归口唯一赢家）/
//   probe_fail（服务端→发送方：reason=offline/disabled/拒因）/ abort（任一方→对方，服务端生成兜底）/
//   offer / answer / candidate（WebRTC 协商中继帧，服务端注入 ice 后转发，复用 callInjectICE）/
//   done（双方→服务端，传输完成元信息归口落库）/ done_ack（服务端→双方，落库回执回填 msg_id）
MsgTypeFileP2PSignal = 91
```

客户端 MSG 表（socket.js）同步新增 `FILE_P2P_SIGNAL: 91`。

## 3.2 信令字段

| 字段 | 说明 |
|------|------|
| transfer_id | 发送方生成的传输唯一标识（uuid，同 upload_id 模式） |
| name / size / mime | 文件元信息（probe 携带，供接收方 UI 与预分配） |
| sha256 | 整文件哈希（发送方边读边算，offer 前得出；接收方校验完整性） |
| reason | probe_fail / abort 拒因（offline / disabled / timeout / channel_lost…） |
| sdp / candidate | WebRTC 协商载荷（原样中继不解析，同通话信令轻解析原则） |
| platform | accept 携带被选端平台（pc / web），供发送方 UI 提示 |
| nonce | 发送端本地气泡标识（复用 FILE_PERSISTED 的 nonce 回填模式） |

## 3.3 服务端校验归口（HandleFileP2PSignal，新增 server/filep2p.go，仿 call.go 模式）

1. **身份归口**：from 一律取连接登录名 `c.username`（防伪造他人身份，同 call.go）；
2. **probe**：好友关系校验（口径与通话一致）+ 文件大小上限校验（复用 max_direct_size）+ 接收方可 P2P 端在线判定（hub 在线 + 平台非手机，同 hub.HasCall 先例）→ 不满足直接回 probe_fail（发送方立即回退 HTTP 链路，**不产生任何等待**）；满足则建内存传输会话并转发 probe 到接收方全部在线端（每端附 ice_servers）；
3. **accept 竞态归口**：接收方多端在线全部自动 accept，服务端内存会话表先到先得：首个 accept 锁定该端为赢家并转发给发送方，其余端收服务端生成 abort(already_accepted)，杜绝双通道；
4. **offer/answer/candidate**：校验会话双方后 `callInjectICE` 注入 ice 转发（原样中继媒体字段）；
5. **超时兜底**：probe 后 15s 未进入协商 / 协商后 30s 未收到 done，服务端懒清理会话并向双方发 abort（同 uploadSessionTimeout 懒清理模式，不启用定时器风暴）；
6. **done**：双方各自上报，服务端归口写 im_message：msg_type=5（文件消息），file_name/file_size 真实值，content 为 JSON `{url:"", p2p:true, sha256, nonce}`；落库后 done_ack 回填 msg_id（双方气泡精确匹配，复用 FILE_PERSISTED 按 nonce 匹配模式）。

## 3.4 与"服务端归口"原则的兼容口径

- 是否走 P2P 的**决策**在服务端（enabled 开关、阈值、在线判定、好友校验）；
- 传输完成的**元信息与消息记录**归口服务端落库，历史会话可见（气泡为文件卡片）；
- 文件**内容**不经服务端（这是 P2P 的收益本体）。历史消息点击下载时 url 为空 → 前端提示"直传文件不保存到服务器"（i18n 词条，见 §6.4）；
- 可选归档（archive=true）时发送方传输完成后异步 POST /upload/file 上传副本，服务端 FILE_PERSISTED 回填 url，历史永久可下载（代价：发送方多一份上行流量，默认关闭）。

# 四、传输协议设计（DataChannel 数据面）

## 4.1 通道参数

| 参数 | 取值 | 依据 |
|------|------|------|
| 通道模式 | ordered + reliable（默认，不设 maxRetransmits） | 文件传输要求零丢失零乱序 |
| 分片大小 | 16KB（config.yaml file_p2p.chunk_size 可配） | SCTP 单消息安全上限 64KB 内跨浏览器稳妥；2GB 文件约 13 万片，seq 用 32 位无溢出 |
| 高水位 | 8MB（high_water） | bufferedAmount 超过后暂停读文件 |
| 低水位 | 1MB（low_water） | bufferedAmountLowThreshold 回调恢复读取 |
| 确认方式 | 累计 ACK：接收方每收 64 片回 `{next_seq}` 帧 | 简化滑窗，发送方据此推进 + 判速 |
| 校验 | 分片边收边算 + 整文件 SHA-256 终验 | sha256 不匹配视为失败，走 abort 回退 |

## 4.2 传输时序（通道建立后）

```
发送方                                    接收方
  │ ── 文件头帧 {transfer_id,name,size,mime,sha256,total,chunk_size} ──▶ │ 预分配接收缓冲 + 渲染进度气泡
  │ ◀────────────────────────────── ready 帧 ──────────────────────────┤
  │ ══ chunk(seq,data) 逐片入队（背压：high_water 暂停读 / low_water 恢复）══▶ │
  │ ◀══ ack{next_seq}（每 64 片 + 最后一片）═══════════════════════════╌ │
  │ ── eof{sha256} ──────────────────────────────────────────────────▶ │ 终验 SHA-256
  │ ◀────────────────────────────── complete 帧 ───────────────────────┤ 双方发 done 信令落库
```

- 保活：传输空闲期（大文件读盘间隙）发送 ping/pong 帧，30s 无任何数据判死回退；
- 速率统计：发送方按 ack 推进速率计算，进度气泡显示"xx MB/s · 直传"（微信同款体验）。

## 4.3 接收端落地

- Web 浏览器端：完成时自动触发下载（Blob → a[download]），内存 blob 保留供点击查看，刷新后走历史兜底提示；
- Electron PC 端：经现有保存链路落下载目录（自动保存，微信 PC 同款）。

# 五、前端接入设计（im-client/web）

## 5.1 新增模块 js/p2p-file.js（传输引擎，与 chat.js 解耦）

职责：RTCPeerConnection 生命周期、offer/answer/candidate 收发、DataChannel 数据面（分片/ACK/背压/校验）、协商超时与中断检测、回退回调抛出。对外仅暴露：

```js
// 发起一次 P2P 传输；成功 resolve({msg_id 由 done_ack 回填})，任何失败 resolve({fallback:true, reason}) 由 chat.js 接管走现有链路
window.P2PFile = { send(file, toUser, nonce, onProgress), }        // 发送方
window.P2PFile = { onSignal(msg) }                                  // 信令入口（socket.js 分发 91 帧到此）
```

## 5.2 chat.js 接入点（分流口径）

- 登录响应新增下发 `file_p2p_enabled` / `file_p2p_threshold`（服务端归口，客户端不硬编码决策参数）；
- sendFile 现有三层分流入口最前面加一层：`size ≥ file_p2p_threshold 且私聊且 enabled` → 先走 P2PFile.send()，其余场景**完全不变**；
- P2P 失败回退 = 复用现有 sendFileChunkedDirect / sendFileDirect（代码零改动，仅函数调用）；
- 进度气泡：复用分片直传气泡（FILE_PROGRESS 同款），发送方带取消按钮（取消 = abort 信令 + 停止读盘），完成后 done_ack 回填 msg_id 落正式文件卡片（与 FILE_PERSISTED 归口同模式）；
- 接收方：probe 到达自动 accept（不打扰用户，微信同款"在线即收"）；气泡显示"接收中 xx% · 直传"。

## 5.3 UI 细则

- 气泡角标：直传传输中与完成后文件卡片标注"直传"小角标，与服务器中转文件区分；
- 直传文件卡片点击下载：url 为空且内存无 blob → 提示"直传文件不保存到服务器，如需留存请发送方开启归档"；
- 设置页新增开关"好友文件直传"（关闭后本端不接受 probe 也从不发起，默认开启）。

## 5.4 i18n

新增词条（zh/en 语言包各补齐，key=中文原文）：`直传`、`接收中 xx% · 直传`、`发送中 xx% · 直传`、`直传文件不保存到服务器`、`好友文件直传` 等；跟随现有 I18N.t/I18N.tr 归口。

# 六、服务端配置（config.yaml 新增节）

```yaml
# 阶段一百五十六：好友文件 P2P 直传（WebRTC DataChannel，P2P 优先 + 现有 HTTP 链路兜底）
file_p2p:
  enabled: true            # 总开关：false 时全部文件走现有链路（客户端 probe 一律回 probe_fail(disabled)）
  threshold: 1048576       # 大于该字节数（1MB）且私聊才尝试 P2P；小文件 WS 分片更快更简单
  negotiate_timeout: 10    # 客户端协商超时秒（ICE failed/超时自动回退 HTTP 链路）
  chunk_size: 16384        # DataChannel 分片字节
  high_water: 8388608      # 发送缓冲高水位（暂停读文件）
  low_water: 1048576       # 发送缓冲低水位（恢复读文件）
  archive: false           # 直传完成后发送方是否异步归档副本到服务端（false 历史仅元信息）
```

决策参数全部服务端下发，客户端零硬编码（登录响应携带 enabled/threshold）。

# 七、回退策略矩阵（送达率 100% 的保证）

| 异常场景 | 检测方 | 动作 | 用户感知 |
|---------|--------|------|---------|
| 接收方离线 / 仅手机端在线 | 服务端 probe 判定 | probe_fail(offline)，发送方立即走 HTTP 分片直传 | 无感（等同现状） |
| file_p2p.enabled=false | 服务端 | probe_fail(disabled)，走现有链路 | 无感 |
| 对端关闭"好友文件直传" | 接收端 probe 时拒绝 | reject → 发送方走现有链路 | 无感 |
| ICE 打洞失败 / 10s 协商超时 | 发送端 | abort 信令 + 自动回退 HTTP 分片直传 | 进度气泡短暂等待后继续 |
| DataChannel 中途断开 | 双端 onclose | 保留进度气泡，自动回退全量重传 | 进度从零继续，无感切换 |
| 30s 无数据（假死） | 发送端看门狗 | 同上 | 同上 |
| SHA-256 终验失败 | 接收端 | abort → 回退重传 | 无感 |
| 发送方中途取消 | 发送端 | abort 信令，双端移除气泡（同 FILE_CANCEL 模式） | 气泡消失 |
| 服务端重启（会话丢失） | 双端超时检测 | 30s 看门狗回退 HTTP | 无感 |

# 八、安全设计

1. **身份防伪造**：信令 from_user 一律以连接登录名归口（同 call.go），不信任客户端自报；
2. **好友校验**：probe 服务端查库校验（口径与通话信令一致），陌生人无法发起 P2P 协商；
3. **传输加密**：DataChannel 强制 DTLS（WebRTC 规范，不可关闭）——比现有 HTTP 中转更私密（服务端不可见内容）；
4. **TURN 凭证**：复用内置 TURN 长期凭证机制（config.yaml turn 节），凭证经信令注入不下发明文配置文件；
5. **接收端文件名风控**：清洗路径穿越与非法字符（复用现有文件名风控口径），下载名以信令 name 经清洗后使用；
6. **大小上限**：probe 阶段服务端按 max_direct_size 拒绝，防止超大文件滥用；
7. **DoS 边界**：单用户并发 P2P 会话数上限（建议 3），超限 probe_fail；服务端会话表懒清理（同 uploadSessionTimeout 模式）。

# 九、性能与影响评估

| 维度 | 评估 |
|------|------|
| 服务端压力 | 信令均为小包低频（协商期十几个包/传输），转发开销可忽略；**大文件字节不再过服务器，带宽/磁盘/内存压力显著下降（本设计主要收益）** |
| 现有功能回归 | 现有三层链路、群聊、离线收文件、历史加载、FILE_PERSISTED 归口全部零改动（回退路径即现有代码）；新增代码独立成模块（server/filep2p.go + web/js/p2p-file.js） |
| 用户体验 | 同局域网/内网传输速度受限于本机网卡（远超服务器中转）；跨公网受双方上行带宽限制（通常仍优于经服务器绕行）；失败自动回退无感 |
| 稳定性 | 全异常路径均有自动回退（§7 矩阵），功能可用性与现状持平 |
| 隐私 | P2P 传输内容端到端加密且不经服务器；默认不归档（服务端不留副本），隐私增强 |
| 安全 | DTLS + 好友校验 + 身份归口 + 文件名风控，见 §8 |

# 十、实施阶段划分

1. **阶段 A（服务端）**：protocol 新增 91；config.go 新增 FileP2P 节；server/filep2p.go（probe 校验/accept 归口/中继注入/done 落库/懒清理/并发上限）；登录响应下发 enabled/threshold；config.yaml 补节；
2. **阶段 B（前端引擎）**：js/p2p-file.js（协商 + 数据面 + 背压 + ACK + SHA-256 + 看门狗 + 回退回调）；socket.js 路由 91 帧；chat.js 分流入口接入与回退接管；登录响应存储配置；
3. **阶段 C（UI）**：直传角标 + 速率显示 + 取消按钮 + 直传设置开关 + 接收端自动保存；i18n 词条补齐（zh/en）；
4. **阶段 D（归档可选）**：archive=true 时发送方完成后续传 /upload/file 归档 + FILE_PERSISTED 回填 url + 历史下载恢复；
5. **阶段 E（实测验收）**：Web↔Web、PC↔PC、Web↔PC 互传；同网段直连 / 跨公网打洞 / 对称 NAT 走 TURN 中继（看 turn.go 中继分配日志）/ 全部失败回退 HTTP；离线、中途拔网线、取消、SHA 不匹配、多端竞态（双端同账号）、群聊/小文件/离线文件回归验证；i18n 英文模式走查；性能对比（直传速率 vs 现有链路）。

# 十一、风险与对策

| 风险 | 对策 |
|------|------|
| 对称 NAT 且 TURN 不可达（企业防火墙全封） | 回退 HTTP 链路兜底，可用性不受影响；二期可加 turn TCP 443 兜底 |
| 手机端 WebView WebRTC 兼容性 | 一期手机端不参与 P2P（probe 判定排除），自然走现有链路 |
| 多端同账号竞态 | 服务端 accept 先到先得归口 + 其余端 abort（§3.3） |
| Electron 渲染进程 RTCPeerConnection | 通话已验证可用（call-page.js 同进程同 API），无新增风险 |
| 混合模式下历史文件下载困惑 | 直传角标 + 明确文案 + 可选归档开关（§5.3/§6） |
