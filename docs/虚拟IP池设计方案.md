# 虚拟 IP 池设计方案（联机虚拟网卡路线 · 服务端 IP 分配归口）

> 状态：设计评审稿（未实施）
> 关联文档：`docs/局域网公网联机开发文档.md`（十三、风险与边界——虚拟网卡路线"另案评估"即本案）、`docs/联机原生SDK设计.md`（M3 虚拟网卡路线重评）
> 关联代码：`im-server`（本方案主体）、`im-client/pc`（p2p-host.exe 承载宿主，后续另案）、`im-client/pc/Driver`（TAP 驱动，已随包分发并在设置页支持安装/卸载；安装成功后自动重命名适配器连接名为 **IM-client** 并固定**接口跃点数为 1**（关闭自动跃点；TAP 无默认网关不劫持互联网流量，跃点 1 使受限广播/多播的源接口优先选虚拟网卡，配合 n2n 广播转发与 `-E` 多播放行完成发现闭环；游戏间对连流量目标即对端虚拟 IP，最长前缀匹配天然走 TAP）（InterfaceGuid 差集只改本包新装块；设备描述受 cat 签名保护不可改，wintap 按 GUID 探测定位与名字无关））

---

## 一、背景与目标

局域网公网联机走虚拟网卡路线（对标 ZeroTier/Hamachi）时，每个在线用户需要一个**虚拟局域网 IP**，后续 PC 端启动 `p2p-host.exe` 时以参数形式传入，客户端据此组建虚拟网段联机。

本方案覆盖服务端侧：

1. 预生成 `10.28.0.0/16` 网段的 IP 池，落 MySQL（注：服务端现有数据库为 **MySQL+GORM**，[store/mysql.go](../im-server/store/mysql.go)；原设想"SQLite"经评审改为复用现有 MySQL，零新增依赖）；
2. 服务端启动时全量载入内存，登录自动分配、全部设备下线自动释放，防 IP 空占用；
3. 登录回执下发 `vip_ip` 字段（预留 p2p-host.exe 启动参数数据源）；
4. admin 后台新增「虚拟 IP」页签：总/占/空闲统计 + 占用明细（IP、账号、上线时间）。

## 二、网段规划

`10.28.0.0/16` 共 65536 个地址，规划如下：

| 地址 | 用途 | 是否参与分配 |
|---|---|---|
| `10.28.0.0` | /16 网络地址 | 否 |
| `10.28.0.1` | 虚拟网关（p2p-host 虚拟网卡网关预留） | 否 |
| `10.28.0.2 ~ 10.28.0.255` | 网关段保留（DHCP/DNS 等后续扩展） | 否 |
| **`10.28.1.1 ~ 10.28.255.254`** | **用户分配池** | **是，共 65278 个** |
| `10.28.255.255` | /16 广播地址 | 否 |

> 说明：原需求写"10.28.1.1 ~ 10.28.255.255"，`10.28.255.255` 是 /16 广播地址必须排除，故池上界为 `10.28.255.254`。

容量评估：服务端在线容量按 5 万连接设计（见 server 侧既有容量改造），且分配粒度为**用户名级**（同用户多端共用一个 IP，见 §5），65278 个充足。耗尽时按 §9.1 降级，不阻塞登录。

## 三、存储设计（MySQL）

### 3.1 表结构（GORM AutoMigrate 自动建表，随 [model/model.go](../im-server/model/model.go) 既有惯例）

```go
// VipIP 虚拟 IP 池（联机虚拟网卡路线）：启动时生成/补齐，运行态以内存为权威，DB 仅存池与审计参考
type VipIP struct {
    IP       string `gorm:"column:ip;primaryKey;size:15"` // 点分十进制，如 10.28.1.1
    Status   int8   `gorm:"column:status;default:0"`      // 0=空闲 1=预留（管理员保留，不参与分配）
    Username string `gorm:"column:username;size:64"`      // 最近使用者（审计参考，运行时实时更新）
    AllocAt  int64  `gorm:"column:alloc_at"`              // 最近分配时间戳（秒，审计参考）
}
```

- 表名沿用 GORM 默认复数化（`im_` 前缀策略与现有模型保持一致，实施时对齐 model 包既有 TableName 惯例）
- `Status=1`（预留）的 IP 启动加载时不入空闲栈——管理员可在 DB 手工保留特定 IP（如后续服务器节点固定 IP），admin 界面的预留管理列为后续演进项，一期不做

### 3.2 池生成（幂等）

启动时（InitMySQL 之后、NewServer 之前）执行：

1. `AutoMigrate(&model.VipIP{})`
2. 查 `SELECT COUNT(*) FROM im_vip_ip`，为 0 则批量 INSERT 全量 65278 行（单条批量语句分片提交，避免超长事务）
3. 非零则跳过（**不补齐被手工删除的行**——手工删了就是明确不想分配，保持语义简单）

### 3.3 运行态写库策略（关键决策）

**DB 只存"池"，分配/释放状态以内存为权威，不实时写库。**

- 理由：服务端重启后所有连接必然掉线重连，"重启前谁占着 IP"是天然失效的脏数据；实时写库换不来任何可用语义，反而每次登录/登出多一次 UPDATE
- 副作用：重启后用户重连会拿到**可能与之前不同的 IP**——可接受（p2p-host 虚拟网会话随进程重启本就重建）
- `Username/AllocAt` 列仅作最近一次使用的历史参考，由 admin 展示接口按需读内存补充，DB 不追写

## 四、内存池设计（server/vipip.go，新增归口模块）

### 4.1 结构

```go
type vipPool struct {
    mu       sync.Mutex
    assigned map[string]string // username -> ip（在线绑定，登录/登出路径维护）
    owner    map[string]string // ip -> username（admin 明细反查）
    free     []uint32          // 空闲 IP 栈（存池内偏移 idx，还原为 10.28.(idx>>8).(idx&0xff)）
    base     uint32            // 网段基址（10.28.0.0 的 uint32 表示）
}
```

### 4.2 算法与复杂度

- **分配 O(1)**：`free` 栈 pop 一个偏移 → 写双 map → 返回 IP 字符串
- **释放 O(1)**：双 map 删除 → 偏移 push 回 `free`
- **无扫描循环**：相比"从头找第一个空闲"的 O(N) 扫描，栈式分配在频繁上下线 churn 下依旧恒定耗时
- **内存占用**：free 栈 65278×8B ≈ 0.5MB + 双 map 在线量级条目 ≈ 几 MB 上限，可忽略
- 并发保护：`sync.Mutex`（分配/释放均在登录/断开路径，QPS 低，锁竞争可忽略；不引入分片锁等过度设计）

### 4.3 启动加载流程

```
main.go: store.InitMySQL → [新增] store.InitVipPool(cfg)（建表+建池）
       → server.NewServer(cfg)（构造函数内 [新增] s.vippool = newVipPool(cfg) 从 DB 读全量池，
         Status=1 跳过，其余全部入 free 栈；记录加载日志"虚拟IP池就绪: 总N 预留M 空闲K"）
```

- 池表读取失败：**启动失败退出**（与 InitMySQL 同级处理——联机是核心依赖，半死池不如明确报错）
- `vip_ip` 分配范围/网关等全部来自配置（§7），不硬编码

### 4.4 预留接口（Go 侧归口，p2p-host 数据源）

```go
// server/vipip.go
type VipLease struct { // 一次分配的完整租约：IP + 配套 MAC（同时生成，见下）
    IP  string
    MAC string
}
func (p *vipPool) Alloc(username string) (VipLease, error) // 登录绑定；池空返回 ErrExhausted
func (p *vipPool) Release(username string)                 // 全设备下线释放；未绑定则 no-op
func (p *vipPool) Get(username string) string              // 查询当前绑定 IP（空串=未绑定）
func (p *vipPool) Stats() VipPoolStats                     // {Total, Used, Free, Reserved}（admin 用）
func (p *vipPool) Snapshot() []VipEntry                    // 占用明细 [{IP, Username, LoginTime}]（admin 用）
```

**MAC 与 IP 同生规则（确定性映射，IP 唯一 ⇒ MAC 唯一，社区内天然无冲突）：**

```
MAC = 02:00:0A:1C:AA:BB        IP 四字节逐段 hex 编码（10→0A、28→1C），AA=第 3 字节、BB=第 4 字节
例：10.28.1.5     → 02:00:0A:1C:01:05
    10.28.255.254 → 02:00:0A:1C:FF:FE
```

- 首字节 `0x02`：本地管理地址（locally administered，U/L 位=1），永不与 IEEE 分配的全球唯一 OUI 冲突，可安全用于虚拟网卡
- MAC 各段必须为合法十六进制，故 IP 字节逐段 hex 编码（十进制 28 = hex 1C）；实现为 `vipMacOf` 纯函数，单测覆盖
- 由服务端统一生成并随 IP 一起下发（`vip_ip` + `vip_mac`），客户端**零推导逻辑**，避免两端规则各自实现漂移
- 社区（-c）按房间/群组隔离，L2 域互不可见，不同社区即使复用 IP/MAC 也不冲突（一期全局 IP 唯一，进一步无冲突）

后续 p2p-host 启动参数规范见 **附录 A**（`-a`/`-s` 即取自本租约）。

## 五、生命周期挂载点（已核实至行号）

| 时机 | 位置 | 动作 |
|---|---|---|
| 登录成功 | [server/server.go finishLogin](../im-server/server/server.go)（hub.Add 之后，约 L600 附近） | `Alloc(username)`：首绑定即分配；已绑定（多端第二台设备上线）沿用同一 IP |
| 全部设备下线 | [server/server.go unregister](../im-server/server/server.go)（`remaining==0` 分支，约 L186 后） | `Release(username)` |
| 建房（联机） | [server/gamenet.go gnHandleCreate](../im-server/server/gamenet.go)（game_id 落房间 meta 处，约 L674） | ① 按 game_id 读该游戏配置的 supernodes → 写入房间 meta（空=走全局兜底，§8.3）；② 生成社区名/密钥 -c/-k 写入房间 meta（§5.2） |
| 开局（联机） | [server/gamenet.go gnHandleStart/gnBroadcastState](../im-server/server/gamenet.go)（status 置 playing 广播处，约 L996/L622） | 房间态广播携带房间级 supernodes + 社区名/密钥，成员端"开局即可用"，零手动配置 |
| 关房（联机） | [server/gamenet.go gnCloseRoom](../im-server/server/gamenet.go)（约 L651） | 释放社区名（活跃社区集合 SREM，§5.2）；房间 meta 随 TTL 过期，密钥生命周期与房间一致 |
| 服务端重启 | §4.3 启动序列 | 内存池全量空闲，在线用户重连后重新分配 |
| 集群模式 | NewServer 内判定 `cluster_enabled` | 集群开启时**禁用本功能**（Alloc 恒返空+启动警告日志），见 §9.4 |

### 5.1 与多端架构的语义对齐（重点）

现有架构：同账号**多端共存**（PC+WEB+手机同时在线，[hub.go Hub.Add](../im-server/server/hub.go)）+ **同端互踢**（同 platform 新连接替换旧连接）。

分配粒度取**用户名级**（一用户一 IP），推演：

| 场景 | 行为 | 评估 |
|---|---|---|
| 用户 PC 登录 | 分配 IP-A | p2p-host 拿 IP-A |
| 用户再开 WEB/手机端 | 沿用 IP-A | 不额外占池，语义"每用户一个 IP" |
| PC 同端互踢（重连/顶号） | IP-A 不变 | **联机会话最友好**——虚拟网内地址稳定，互踢不掉虚拟网 |
| 全部设备下线 | 释放 IP-A 回池 | 防空占用（需求核心） |
| 用户重新上线 | 分配"当前栈顶"IP（不保证还是 IP-A） | 可接受；如后续需要"粘连"（优先还发原 IP），演进项见 §12 |

> 备选粒度"每连接一 IP"（每条在线连接独占）已评审否决：WEB/手机端无 p2p-host 需求却占 IP，且同端互踢必然换 IP，破坏联机会话。

### 5.2 社区名与社区密钥（-c/-k）：建房生成与成员下发

p2p-host 的 `-c`（社区名=组名）与 `-k`（社区密钥）决定谁能加入同一虚拟二层网——同 `-c` 且 `-k` 匹配的成员经 supernode 组网互通。设计为**建房时服务端自动生成**，房主与成员零输入。

**生成规则（建房时 gnHandleCreate 内，一次性生成）**：

| 项 | 规则 | 说明 |
|---|---|---|
| `-c` 社区名 | `10000~99999` 均匀随机，**5 位纯数字** | 起始 1 避免前导零在命令行/日志场景的歧义；`^\d{5}$` 严格校验后入 meta |
| `-k` 社区密钥 | `100000~999999` 均匀随机，**6 位纯数字** | 同上 6 位纯数字；`^\d{6}$` 校验 |

纯数字约束的收益：CLI 参数零转义/编码歧义，用户口头转述、日志排查、admin 后续展示都直观。

**唯一性（-c 活跃房间内去重，关键）**：

同一 supernode 上社区名即 L2 域标识，两个活跃房间撞 `-c` 会互相干扰（即使 -k 不同）。处理：

- Redis SET `gn:vip:communities` 维护**活跃社区名集合**：建房 SADD 前先 SISMEMBER 查重，命中则重新随机（**重试上限 5 次**，仍撞则回"组网繁忙请稍后再试"——10 万空间 + 活跃房间量级，实际不可能耗尽重试）
- 惰性剪枝：查重命中时对候选做 EXISTS 校验（房间 meta 键已过期=残留），过期即 SREM 后复用该名——房间 TTL 到期不会永久泄漏社区名
- 关房/离线清退（gnCloseRoom/gnScheduleOfflineLeave 到期路径）统一 SREM 归口释放

**存储**：房间 meta hash 新增两字段 `comm`、`comm_key`，随房间键 TTL（room_ttl 2h）自动过期——**密钥生命周期与房间严格一致**，无独立清理面；服务端重启 Redis 持久化存活，无需重建。

**下发（仅房间成员信令通道，三条路全量覆盖）**：

| 时机 | 通道 | 接收方 |
|---|---|---|
| 建房成功 | 建房回执 | 房主（立即拿到，可先行启动联机） |
| 加入房间 | [gnHandleJoin](../im-server/server/gamenet.go) 房间态全量同步 | 新成员（与 host_port/supernodes 同帧，中途加入无缝） |
| 开局广播 | [gnBroadcastState](../im-server/server/gamenet.go) | 全体成员（重连/重进房间后重取同款） |

**安全边界**：

- `comm_key` **只出现在房间成员信令与成员端内存**（p2p-host 启动参数）——不进大厅房间列表、不进登录回执、不在 admin 占用明细展示、不落客户端磁盘
- 被踢/退出房间：成员端随联机会话结束退出 p2p-host（客户端生命周期另案），密钥即刻失用；房间密钥不因单成员退出轮换（剩余成员会话不中断）
- 熵评估：6 位纯数字 ≈ 20bit，弱于强随机密钥——威胁模型为"公网路人"，社区对 supernode 不可枚举（未知 -c 不可见）+ 密钥仅成员可见，风险可接受；如需增强见 §12.6 演进
- **重开局不换 key**：同房间多轮对局（gnHandleEnd → 再 start）成员不变，复用同社区密钥，避免每轮全员重启虚拟网卡；如需每轮轮换列入演进项（§12.6）

## 六、协议下发（登录回执）

[server/server.go sendLoginResp](../im-server/server/server.go)（约 L1298）的 respInfo JSON map 追加字段：

```go
"vip_ip":         c.vipIP,  // 下发虚拟网卡 IP（联机 p2p-host -a 参数数据源；空串=未分配/功能未启用）
"vip_mac":        c.vipMAC, // 下发虚拟网卡 MAC（p2p-host -s 参数数据源，与 vip_ip 同生，见 §4.4）
"vip_supernodes": s.cfg.VipPool.Supernodes, // 全局 supernode 候选/兜底（p2p-host -l 参数；房间级下发优先于它，见 §8.3）
```

- `Client` 结构（[server/client.go](../im-server/server/client.go)）新增 `vipIP string`、`vipMAC string` 字段（finishLogin 中分配后写入，连接级缓存，连接生命周期与绑定一致）
- `vip_supernodes` 来自服务端配置（§7），登录时随回执统一下发，作为**全局兜底**——联机房间会另行下发游戏级 supernodes（§8.3），客户端取值优先级：房间级 > 登录全局；supernode 部署变更只改服务端配置，客户端零更新
- **协议向后兼容**：新增字段为纯增量，旧客户端忽略未知字段，零回归
- 前端接收：socket.js 登录响应处理处存 `localStorage`（**跨窗口共享**——联机房间层运行在游戏中心独立窗，sessionStorage 按窗隔离读不到）；本期前端仅透传存储，不做 UI

## 七、配置设计（config/config.go + config.yaml）

```yaml
# 虚拟 IP 池（联机虚拟网卡路线；enabled=false 时全链路旁路，不建表不加载不分配）
vip_pool:
  enabled: true
  segment: "10.28.0.0/16"      # 网段（保留段：网络地址/网关/广播自动排除）
  gateway: "10.28.0.1"         # 虚拟网关（下发 p2p-host 用）
  range_start: "10.28.1.1"     # 分配池起
  range_end: "10.28.255.254"   # 分配池止（/16 广播地址排除）
  mask: "255.255.0.0"          # 子网掩码（p2p-host 参数预留）
  supernodes:                  # 全局 supernode 候选池/兜底（登录回执 vip_supernodes 下发；游戏未单独配置时用）
    - "127.0.0.1:7654"         #   admin 游戏表单的可选项即来自此列表；可配多个，p2p-host 自动选可用节点
```

- `Config` 结构新增 `VipPool VipPoolConfig \`yaml:"vip_pool"\``（对齐 GameNetConfig/FileP2PConfig 惯例，[config/config.go](../im-server/config/config.go)）
- 默认值：enabled=false（**新功能默认关闭**，部署方显式开启），网段/网关/起止取 §2 规划值
- 配置校验：Load 后校验 range 在 segment 内、起止合法、gateway 不在分配区间内，非法即启动报错
- **改 config.yaml 后同步补齐 `config - linux.yaml`**（工作区规则强制项）

## 八、admin 后台

### 8.1 服务端接口（[server/admin.go](../im-server/server/admin.go) 路由注册中心追加，adminGuard 鉴权同款）

```
GET /admin/api/vipip
→ { ok, data: {
      total: 65278, used: 123, free: 65156, reserved: 0,
      list: [ { ip: "10.28.1.5", username: "zhangsan", login_time: "2026-10-18 14:30:21" } ]  // 仅占用明细
   } }
```

- 实现仿 [server/adminonline.go](../im-server/server/adminonline.go)（hub.Snapshot → 组装 → adminJSON），数据源为 `vippool.Snapshot()/Stats()` 纯内存读取，无 DB 查询，开销可忽略
- 明细按分配时间倒序；支持 `?q=` 参数按 IP/账号模糊过滤（服务端过滤，列表上限单页 500 条返回）

### 8.2 admin 前端（web/js/admin.js + index.html）

- 新增「虚拟 IP」页签（视图注册复用在线账号页模式，[admin.js 阶段二百二十二区块](../im-client/web/js/admin.js)）
- 顶部统计卡片：总数 / 占用 / 空闲 / 预留；下方明细表格（IP、账号、上线时间），搜索框走 `?q=`
- 10 秒轮询复用在线页同款节奏；进视图拉取、离视图停轮询
- UI 沿用 admin 既有卡片/表格/自绘滚动条样式，主题色跟随现有体系

### 8.3 游戏维度 supernode 配置（admin 游戏表单多选 + 房间级下发）

**需求**：admin 后台新增/编辑游戏时可选择该游戏使用哪个（或多个）supernode；房间开局后成员自动可用，零手动配置。

**存储**：`im_game` 表新增一列（AutoMigrate 自动加列，存量游戏默认空=走全局兜底）：

```go
// model.Game 新增（逗号分隔存储，如 "supernode1.example.com:7654,supernode2.example.com:7654"）
Supernodes string `gorm:"column:supernodes;size:512;default:''"` // 联机 supernode 列表（空=vip_pool.supernodes 全局兜底）
```

**admin 表单交互**：

- 游戏新增/编辑弹窗新增「联机 supernode」多选项，候选列表即 `vip_pool.supernodes` 全局配置（表单打开时经 `GET /admin/api/vipip` 响应新增的 `supernodes` 候选字段获取，不新增接口）
- 保存时服务端校验：所选值必须 ⊆ 全局候选列表（防手工提交任意地址），非法即拒绝
- 不选 = 空 = 该游戏联机走全局兜底（向后兼容，存量游戏零迁移）
- 多选项仅在该游戏联机相关配置可见时展示（与联机端口登记等既有联机表单项同区）

**房间级下发链路**（"开局即默认可用"的实现）：

1. **建房**：[gamenet.go gnHandleCreate](../im-server/server/gamenet.go) 写房间 meta 时按 `game_id` 读该游戏 `supernodes` 列，空则标记兜底 → 一并写入房间 meta（如 `supernodes` 字段）
2. **开局**：[gnHandleStart → gnBroadcastState](../im-server/server/gamenet.go) 房间态广播携带房间级 supernodes → 成员端 gn-room.js 存会话
3. **成员中途加入**：加入（gnHandleJoin）随房间态全量同步拿到，与 host_port 同款语义
4. **客户端启动 p2p-host**：`-l` 取值优先级 = **房间开局下发的游戏级列表 > 登录回执 vip_supernodes 全局兜底**；两者皆空（功能未配置）则不启动 p2p-host 并提示
5. supernode 部署变更：改 config.yaml 全局列表 → 新建房即生效（存量房间沿用建房时刻快照，对局中不变更——联机会话稳定性优先）

### 8.4 静态绑定用户（admin 绑定/解绑，§12.1 演进项落地）

**语义**：admin 后台将指定 IP 绑定给指定用户——绑定后该 IP **独占**（移出空闲栈，动态分配永远发不出去），用户登录优先分配绑定 IP，全部设备下线后 IP 仍保留（不回池），重上线即回绑定 IP；解绑后 IP 回池可被动态分配。

**存储**：复用 `im_vip_ip` 既有列（零加表加列）——绑定 = `status=1 + username=账号`；解绑 = `status=0 + username=''`。启动加载时 `status=1 且 username 非空` 的行进入内存 static 映射（`Bindings` 种子）。

**接口**（adminGuard 鉴权，实现归口 adminvipip.go）：

```
PUT /admin/api/vipip/bind    {"ip":"10.28.1.5","username":"alice"}
PUT /admin/api/vipip/unbind  {"ip":"10.28.1.5"}
```

**两阶段一致性**（server/vipip.go）：`Check`（内存冲突校验：IP 在池内 / 未被他人静态绑定 / 未被他人动态占用；取旧绑定）→ `DB 事务`（新行绑定 + 旧绑定行清理）→ `Apply`（内存生效：写映射、新 IP 出栈、旧 IP 回池）。任一步失败均无半生效态；账号存在性服务端校验。

**运行期语义表**（已单测覆盖）：

| 场景 | 行为 |
|---|---|
| 绑定用户登录 | 直接拿绑定 IP（static 命中优先于空闲栈） |
| 绑定用户全设备下线 | IP 不回池（Release 识别 static 跳过），重上线回原 IP |
| 绑定瞬间 IP 被他人动态占用 | 拒绝（不抢在线用户的 IP），其下线后可绑 |
| 换绑（用户改绑新 IP） | 旧 IP 自动回池（无在线占用时；在线持有则下线后回池） |
| 解绑时用户在线占用 | 本次会话用完（下线 Release 动态分支）后回池 |
| 服务端重启 | static 映射自 DB 重建，绑定关系持久 |

**UI**（虚拟 IP 页签增强）：明细表加「状态」列（在线占用/已绑定含未在线）与「操作」列（绑定/解绑，确认弹窗输账号防误操作）；工具条加「按 IP 绑定」入口（空闲 IP 预绑）；统计口径 `已占用 = 在线占用 + 静态绑定未在线`。

### 8.5 全局 supernode 候选热更管理（admin 界面化）

**背景**：原设计候选仅存 config.yaml（改后需重启）。现升级为后台界面化管理（比照链接白名单的全局 KV 模式）。

**存储与生效**：复用 `model.AgentWhitelist` 全局 KV 表（`kind="vip_supernodes"`，零新表）；保存即内存直更热生效 + 落库持久化（重启不丢）；DB 无行时回退 config.yaml `vip_pool.supernodes`（首次部署平滑过渡，config 改为纯兜底）。

**接口**：`PUT /admin/api/vipip/supernodes`（`{"list":"每行/逗号分隔 host:port"}`）——host=域名/IPv4（不支持 IPv6 字面量）、port 1~65535、去重去空、上限 20 条、格式非法拒绝；空串=清空。

**生效面**：登录回执 `vip_supernodes`（下次登录）→ admin 游戏表单多选候选（打开即拉）→ 游戏未单独配置时的全局兜底。

**UI**（虚拟 IP 页签）：统计卡下方「supernode 候选」卡（textarea 每行一个 + 保存按钮，保存后状态行显示热生效时间；轮询回填仅在用户未编辑 textarea 时进行，防覆盖输入）。

## 九、边界与降级

| # | 场景 | 处理 |
|---|---|---|
| 9.1 | IP 耗尽（free 栈空） | `Alloc` 返回 ErrExhausted → **不阻塞登录**，vip_ip 下发空串，记 WARN 日志；联机功能侧按"未分配"降级隐藏入口 |
| 9.2 | 服务端重启 | 内存池全量空闲；重连用户重新分配（IP 可能变化，§3.3 已论证可接受） |
| 9.3 | 池表 DB 异常 | 仅影响启动加载（失败即退出，§4.3）；运行期不碰 DB，无新增故障面 |
| 9.4 | 集群模式 | 一期禁用：`cluster_enabled=true` 时本功能强制旁路（enabled 配置视为 false）+ 启动 WARN。内存态分配跨实例必冲突，后续演进走 Redis 原子分配（§12） |
| 9.5 | 恶意高频上下线占池 | 分配粒度用户名级 + 下线即释放，天然无泄漏面；free 栈 65278 深度，churn 不损耗（pop/push 对称） |
| 9.6 | 重复注册同 IP | 双 map + 栈结构结构性保证不重复（pop 唯一性） |
| 9.7 | enabled=false | 全链路旁路：不建表、不加载、finishLogin 不分配、协议字段恒空串、admin 接口返回 403 语义（前端页签保留并提示未启用） |
| 9.8 | 游戏未配置 supernode | 房间 meta 标记兜底 → 客户端回退登录回执全局列表（§8.3 优先级链）；全局也未配置则 p2p-host 不启动并提示 |
| 9.9 | 存量对局中 supernode 变更 | 房间沿用建房时刻快照，对局中不变更（联机会话稳定性优先）；新房间即生效 |

## 十、测试与验收清单

1. **建池幂等**：首启生成 65278 行；重启不重复生成；手工删行后重启不补
2. **分配语义**：单用户登录分配唯一 IP；多端登录共用同 IP；同端互踢 IP 不变；全端下线释放；重新上线拿到新 IP
3. **并发**：压测脚本 500 并发模拟登录/登出 churn，断言无重复分配、无泄漏（free 栈深度守恒 = 总数 - 占用数）
4. **协议**：登录回执含 `vip_ip` 与配套 `vip_mac`（映射规则一致，如 10.28.1.5 → 02:00:0A:28:01:05）及 `vip_supernodes`；旧客户端（未升级）登录不受影响
5. **admin**：统计数与明细一致；搜索过滤生效；未占用时不显示空列表报错（显示"暂无占用"）
6. **游戏级 supernode**：admin 游戏表单多选保存生效；提交候选外地址被拒绝；不选走全局兜底；建房写入房间 meta；开局广播携带；成员中途加入同步拿到；客户端优先级链（房间级 > 全局）正确
7. **社区名/密钥（-c/-k）**：建房生成格式严格匹配 `^\d{5}$`/`^\d{6}$`；两房间并发建房 -c 不重复；关房后社区名释放可复用（含 TTL 过期残留的惰性剪枝）；-c/-k 仅成员信令可见（大厅房间列表/登录回执/admin 明细均无）；被踢成员不再收到后续下发；重开局复用同 -c/-k
8. **降级**：enabled=false 全链路旁路；模拟 free 清空（调小 range）登录不被阻塞；-c 撞名重试 5 次耗尽回"组网繁忙"（可人为灌满集合模拟）
9. **回归**：登录/多端/互踢/下线广播/游戏联机（game_net）既有链路无影响（本方案仅在 finishLogin/unregister/gnHandleCreate/gnCloseRoom 追加旁路安全调用）
10. **配置**：config.yaml 与 config - linux.yaml 同步；非法网段启动报错文案明确

## 十一、实施文件清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `im-server/model/model.go` | 增 | VipIP 模型；Game.Supernodes 列（AutoMigrate 自动加列） |
| `im-server/config/config.go` | 增 | VipPoolConfig 结构 + 默认值 + 校验 |
| `im-server/store/`（新 vipip.go） | 增 | 建表 + 建池 + 加载（InitVipPool） |
| `im-server/server/vipip.go` | 新 | vipPool 内存池（Alloc/Release/Get/Stats/Snapshot） |
| `im-server/server/server.go` | 改 | Client.vipIP/vipMAC 字段；finishLogin 挂 Alloc；unregister 挂 Release；sendLoginResp 加字段 |
| `im-server/server/gamenet.go` | 改 | gnHandleCreate 写房间 meta.supernodes（按 game_id 读游戏配置）+ 生成 -c/-k（唯一性校验，§5.2）；gnHandleJoin/gnBroadcastState 携带下发；gnCloseRoom 释放社区名 |
| `im-server/server/admin.go` + 新 adminvipip.go | 增 | GET /admin/api/vipip（含全局 supernodes 候选字段）；游戏保存接口校验所选 ⊆ 候选 |
| `im-server/main.go` | 改 | 启动序列插入 InitVipPool |
| `im-server/bin/config.yaml` + `config - linux.yaml` | 改 | vip_pool 配置段 |
| `im-client/web/js/socket.js` | 改 | 登录响应存 vip_ip/vip_mac/vip_supernodes（透传） |
| `im-client/web/js/admin.js` + index.html | 增 | 「虚拟 IP」页签；游戏新增/编辑弹窗「联机 supernode」多选项 |

## 十二、后续演进（本期不做）

1. ~~**IP 粘连**~~：已落地为 §8.4 静态绑定（admin 绑定/解绑界面化，绑定优先分配 + 独占保留）
2. **Redis 原子分配**：集群模式启用时，分配/释放改 Redis Lua 原子操作，多实例共享池
3. **admin 预留管理**：界面上直接标记/取消预留 IP
4. **p2p-host 联动**：客户端侧以 sidecar 启动 p2p-host（参照 dlbt-host 生命周期管理模式，另案设计；启动参数规范见附录 A）
5. **网段扩容**：当前栈式分配按单 /16 设计；跨网段聚合需重构为多池路由，届时评估
6. **社区密钥增强**：一期 -k 为 6 位纯数字（熵 ≈20bit，满足纯数字约束下的可用安全）；如后续需要更强保护，可升级 12 位纯数字或十六进制（-k 本身支持任意字符串），生成/校验规则同源替换
7. **每轮对局密钥轮换**：当前同房间多轮对局复用同 -c/-k（避免成员重启虚拟网卡）；如需单轮隔离可改为开局时轮换 -k（成本：全员重启 p2p-host）
8. **admin 社区视角**：后台展示活跃社区列表（社区名/房间/成员数），排查组网冲突

---

## 附录 A：p2p-host.exe 启动参数规范

p2p-host 为虚拟网边缘节点进程（参数与 n2n edge 对齐），由 PC 客户端在联机开始时以 sidecar 方式启动（参照 [bt-download-manager.js](../im-client/pc/bt-download-manager.js) 的 dlbt-host 生命周期管理模式：dev 取 `pc/dlbt-host/`、打包取 `resources/dlbt-host/`，进程随联机会话启停）。

### A.0 启动授权与停止指令（安全门槛）

exe 仅允许本项目客户端拉起，双重校验缺一即退出（code 1）：

1. **父进程校验**：父进程必须是 `im-client.exe`（打包版）/ `electron.exe`（dev）；
2. **stdin 密钥握手**：父进程 spawn 后 10 秒内经 stdin 写入 32 位授权密钥（与客户端 `P2P_HOST_AUTH` 常量一致），错误/超时即退。

管理控制台端口由客户端**随机分配**（`-t`，40000-59999，仅绑 127.0.0.1），停止指令需带密钥：`stop <key>`——优雅退出（反注册 supernode、关 TAP）；密钥错误指令被忽略。客户端停止归口：退房/关房先发 UDP stop、1.5s 后 taskkill 兜底；app 退出/社区切换直接 taskkill。

**父进程存活看门狗**：授权 stdin 管道在客户端存活期间保持打开（任何路径不得 `stdin.end()`）——客户端崩溃/被强杀时管道 EOF，p2p-host 检测到后自行优雅退出，杜绝孤儿进程（正常退出与意外退出均不遗留）。

> 密钥编译于 exe 内，防的是第三方程序直接复用与手工运行，非绝对防逆向。
>
> 提权说明：客户端以 `requireAdministrator` 提权运行（package.json `win.requestExecutionLevel`），启动时 UAC 确认一次，p2p-host.exe 经 Windows 令牌继承自动获得管理员权限——TAP 的 netsh 配 IP/跃点、驱动装卸均无需额外提权，p2p-host 自身不含提权检测代码。

### A.1 参数总表与取值来源

| 参数 | 说明 | 取值来源 |
|---|---|---|
| `-r` | 开启数据包转发（路由模式） | 固定开启（联机转发依赖） |
| `-a` | 指定虚拟网卡 IP | 登录回执 `vip_ip`（服务端分配，§4） |
| `-s` | 指定虚拟网卡**子网掩码**（n2n v2 此 fork 语义；MAC 无 CLI 参数，由 TAP 驱动自取） | 登录回执 `vip_mask`（服务端 `vip_pool.mask`，§4）；空串时客户端按 `255.255.0.0`（设计网段 /16）兜底 |
| `-c` | 社区名（组名） | 建房时服务端自动生成，5 位纯数字，活跃房间内唯一（§5.2） |
| `-k` | 社区密钥 | 建房时服务端自动生成，6 位纯数字，仅房间成员信令下发（§5.2） |
| `-E` | 接受多播以太网帧（`01:00:5E:*`/`33:33:*`，mDNS/SSDP 类发现依赖；固定 `drop_multicast=0`） | 固定开启（多播发现类应用依赖）；局域网游戏的纯广播 `FF:FF:FF:FF:FF:FF` 默认即转发无需参数（原 `-B` 此 fork getopt 未定义、被静默忽略，已移除） |
| `-t <port>` | 管理控制台端口（仅绑 127.0.0.1） | 客户端每次启动**随机分配**（40000-59999），UDP stop 发往该口——多实例无冲突、固定端口不再被扫 |
| `-i <秒>` | 打洞/重注册**初始**间隔（默认 25s） | 客户端固定 20s；实际运行值由 supernode ACK lifetime 覆盖并钳制在 10-120 秒 |
| `-l` | supernode 地址，可写多个，自动选可用节点 | 优先级链：房间开局下发的**游戏级配置**（admin 游戏表单所选，§8.3）→ 登录回执 `vip_supernodes` 全局兜底 |

### A.2 启动命令示例

```
p2p-host.exe -r -a 10.28.1.5 -s 255.255.0.0 -c 57321 -k 830471 -E -l supernode1.example.com:7654 -l supernode2.example.com:7654
```

> 组网语义：所有 `-c` 相同且 `-k` 匹配的边缘节点经 supernode 汇聚为同一虚拟二层网，各自 `10.28.x.x` 直互通——老游戏的纯广播发现帧（FF:FF:FF:FF:FF:FF）默认即转发，多播发现（mDNS/SSDP）由 `-E` 放行，虚拟 IP 池保证每用户地址唯一不冲突。
>
> MAC 说明：`vip_mac`（§4.4）随登录回执下发仅作身份记录——n2n v2 此 fork 的 edge/wintap 未实装 MAC 设置（`device_mac` 形参未使用），实际 MAC 由 TAP 驱动分配。若后续需要 MAC 绑定校验，需扩展 wintap（注册表 NetworkAddress 方案）另案实施。

### A.3 与本期实施的边界

- 本期（服务端 IP 池）负责：`vip_ip` / `vip_mac` / `vip_supernodes` 经登录回执送达客户端；`-c`/`-k` 建房生成并经房间信令下发成员（§5.2）
- 客户端启动 p2p-host 的时机（何时拉起、房间生命周期联动、p2p-host 进程随开局/结束/退房启停）属联机模块另案设计，本期不实现
