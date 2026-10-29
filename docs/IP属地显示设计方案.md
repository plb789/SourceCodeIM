# IP 属地显示设计方案（ip2region 离线解析 · 服务端归口）

> 状态：**已实施（2026-10-29）**。一期全部落地并实测通过：Go 单测（xdb 加载/内网/公网/口径矩阵）+ WS 端到端（在线 ip_region="内网"、离线空串降级）+ 浏览器 UI 实测（资料卡弹出、IP属地行位于地区与签名行之间、在线显示「IP属地：内网」、离线整行隐藏）。实施与设计差异：①官方 binding 实测 searcher 非线程安全（Search 内部写 ioCount），采用全局单实例 + 互斥串行化（资料查询低频，无性能影响）；②官方新版 binding 的 NewWithBuffer 需传 *Version（经 LoadHeaderFromBuff + VersionFromHeader 从文件头自动识别，天然兼容旧版纯 IPv4 与 3.0 双栈 xdb）；③数据文件现名 ip2region_v4.xdb（仓库 3.x 结构），随包分发为 bin/data/ip2region.xdb。
> 关联项目：https://github.com/lionsoul2014/ip2region（Apache 2.0 协议，离线 IP 归属地查询库）
> 关联代码：`im-server/server`（新增 ipregion.go、扩展 profile.go 协议）、`im-client/web/js/chat.js`（资料卡渲染，PC/WEB 共用）、`im-server/config/config.go`（配置项）、`im-server/bin/config.yaml` 与 `config - linux.yaml`（配置同步）
> 术语约定：本文「IP 属地」= 微信同款属地标签（国内显示省份、海外显示国家），非 GPS 位置消息/实时共享（那是 `server/location.go` 的 msg_type=104/105 链路，两者互不相干）

---

## 一、背景与目标

微信在资料卡/评论区展示「IP 属地：XX」标签，用于表达账号当前大致所在地域。本项目拟在 PC/WEB 客户端资料卡增加同款显示。

技术路线采用 **ip2region 离线解析、服务端归口、客户端纯展示**：

1. 服务端在 WS 接入时已经拿到真实客户端 IP（既有能力，零新增采集）；
2. 服务端用 ip2region 的 XDB 离线数据文件把 IP 解析为属地（省级/国家级），查询微秒级；
3. 解析结果随既有 PROFILE_RESP 资料协议下发，客户端资料卡渲染；
4. **IPv4/IPv6 双栈**（2026-10-29 增补）：v4/v6 数据文件（bin/data/ip2region_v4.xdb ~10.6MB + ip2region_v6.xdb ~35.6MB）独立加载互不拖累，按 ParseIP 字节长度路由；某一栈文件缺失仅该栈属地降级为空（另一栈不受影响），双栈皆缺失才整体关闭。内存常驻约 46MB（两栈合计）。

### 目标

- 资料卡显示「IP属地：XX」，在线用户即时生效；
- 显示口径微信同款：**国内取省级、海外取国家级**；内网/保留地址（127.0.0.1 / 局域网直连）统一显示「内网」；
  **省-市两级增强（2026-10-29）**：国内显示「省-市」两段式（如 山西省-太原市、广东省-深圳市），直辖市/省同市去重（北京市）；海外仍仅国家级。**注：ip2region 免费数据不含县级**（第四段为运营商非区县），「太原市-清徐县」粒度需更换数据源另案评估；
- 全程离线，不向任何第三方 API 泄露用户 IP；
- 未启用/数据文件缺失时静默降级（整行隐藏），不影响其他功能。

### 非目标（一期）

- 不显示城市与运营商（隐私粒度对齐微信）；
- 不做消息流内属地标签、群成员列表属地（二期另案）;
- 不做离线用户的属地显示（需登录 IP 落库，二期）；
- 不做 xdb 热更新/后台上传（一期以替换文件+重启方式更新）。

## 二、技术选型

### 2.1 为什么选 ip2region

| 特性 | 说明 | 对本项目的意义 |
|---|---|---|
| 离线 XDB 数据文件 | ~11MB 单文件，查询 10μs 级 | 不依赖第三方 API、无配额、**零隐私外泄** |
| 官方 Go binding | 仓库自带 `binding/golang` | im-server 是 Go，直接引入，零进程间通信 |
| 返回格式 | `国家\|区域\|省份\|城市\|ISP`，如 `中国\|0\|广东省\|深圳市\|电信` | 按 `\|` 切分取省级即可，微信同款口径 |
| 数据持续更新 | 社区定期发布新 xdb，替换文件即完成更新 | 运维成本低 |
| 协议 | Apache 2.0 | 可随闭源服务端分发数据文件 |

### 2.2 备选方案对比（均不采用）

| 方案 | 否决理由 |
|---|---|
| 客户端调公网 IP 归属 API（ipinfo 等） | ① 把用户 IP 泄露给第三方；② 只能查自己，查不到别人（属地展示的本质是看他人）；③ 有配额与可用性风险 |
| 服务端调公网 IP 归属 API | 同样有配额/可用性风险，且每次资料查询都外呼，万级在线不可接受 |
| 自建 IP 段库 | 维护成本远高于直接使用社区数据 |

### 2.3 版本选择

- 2.x 分支：仅 IPv4，binding 成熟稳定；
- 3.x 分支：IPv4+IPv6 双栈（ipv4.xdb / ipv6.xdb 双文件）。

实施时以**实测**为准（遵循"禁止猜测"原则）：一期先引入官方 Go binding + IPv4 xdb 打通全链路；若部署环境存在 IPv6 接入用户（日志中 `realClientIP` 出现 IPv6 地址），再升级 3.x 双栈，升级只影响 ipregion.go 内部实现，归口函数签名不变。

## 三、总体架构

```
┌─ im-server（Go）─────────────────────────────────────────────┐
│                                                              │
│  WS 接入 ──realClientIP──> Client.ip ──查询──> ipRegion()      │
│  （server.go L103，   （client.go L39，    （新增，xdb 全文件   │
│    main.go L117 解析）   连接级属性）        缓存，微秒级）      │
│                                        │          │          │
│                                        │          ▼          │
│                                        │   data/ip2region.xdb │
│                                        │   （离线文件，启动加载）│
│                                        ▼                     │
│                              ProfileInfo.ip_region           │
│                              （profile.go，随 PROFILE_RESP 下发）│
└──────────────────────────────┬───────────────────────────────┘
                               ▼
              PC/WEB 资料卡（chat.js，微信式「IP属地：广东」）
```

### 归口原则

1. **解析归口服务端**：客户端永远拿不到他人 IP，属地必须由服务端解析后下发——这也是微信的实现方式；
2. **下发只含解析结果，不含 IP 明文**：PROFILE_RESP 报文只有 `ip_region: "广东省"`，原始 IP 不出服务端；
3. **离线零交互**：xdb 文件随服务端分发，运行期与外部网络零交互；
4. **降级静默**：`enabled=false` / 文件缺失 / 解析失败 一律返回空串，前端整行隐藏（对齐 `location.go` 中 `AmapKey == ""` 的降级惯例）；
5. **显示口径单一归口**：`国家|区域|省份|城市|ISP` → 属地的换算只在服务端 `displayRegion()` 一处做，前端零计算。

## 四、服务端设计

### 4.1 配置项（config/config.go + config.yaml + config - linux.yaml）

新增嵌套配置组（对齐 `login_queue:`/`splash_ad:` 的既有结构惯例）：

```go
// IPRegionConfig IP 属地（ip2region 离线解析）配置
type IPRegionConfig struct {
    Enabled bool   `yaml:"enabled"`   // 总开关，false 时功能整体关闭
    XdbPath string `yaml:"xdb_path"`  // xdb 数据文件路径，相对 bin 目录，支持绝对路径
}
```

```yaml
# IP 属地显示（ip2region 离线解析，数据文件随 bin 分发；enabled=false 或文件缺失时功能降级关闭）
ip_region:
  enabled: true
  xdb_path_v4: "data/ip2region_v4.xdb"  # IPv4 数据文件（相对 exe 目录，支持绝对路径）
  xdb_path_v6: "data/ip2region_v6.xdb"  # IPv6 数据文件（可选，缺失仅 IPv6 栈降级）
```

- 路径不硬编码（工作区规则），相对服务端工作目录解析；
- **修改后必须同步补齐到 `config - linux.yaml`**（工作区规则）。

### 4.2 新增 im-server/server/ipregion.go

**加载模式**：启动时一次 `xdb.LoadContentFromFile()` 全文件读入内存（~11MB），`xdb.NewWithBuffer()` 构建全局 searcher。全缓冲模式下查询为纯内存只读切片访问，无文件 IO，并发安全；相比 vector-index 模式（~512KB 内存）多占约 10MB，换来零 IO 与最简并发模型，对 55000 连接上限的服务端无感。

```go
// ipRegion IP 归属地归口查询：返回属地（国内省份/海外国家），
// 内网/保留地址返回「内网」；未启用/查询失败返回空串（前端整行隐藏）
func ipRegion(ip string) string

// displayRegion 解析 xdb region 串 → 显示口径（国内省-市两级，海外国家级）：
//   数据段序自适应（2026-10 实测两种格式并存，禁止按记忆猜测）：
//     3.x 新格式：国家|省份|城市|ISP|国家码，如 "中国|江苏省|南京市|0|CN"（尾段两位大写国家码为特征）
//     2.x 旧格式：国家|区域|省份|城市|ISP，如 "中国|0|广东省|深圳市|电信"
//   国内：显示「省-市」（直辖市/省同市去重，如 北京市）；海外：取国家段
//   内网/保留地址（xdb 返回含 "内网IP" 的串）：返回「内网」
//   任一段为 "0" 视为空；解析不出有效属地返回空串（前端整行隐藏）
//   注：免费版数据不含县级（第四段为运营商非区县），区县级显示需更换数据源另案评估
func displayRegion(region string) string
```

要点：

- 启动加载失败（路径不存在/文件损坏）只 `logger.Error` 并置禁用标志，**不阻塞服务启动**；
- 提供 `ipRegionEnabled()` 供降级判断；
- 输入 IP 来自 `realClientIP()` 既有归口（XFF 首跳优先、回退 RemoteAddr），IPv6 字符串直接透传给 searcher（2.x 会查询失败返回空 → 自然降级，与 §2.3 的版本策略一致）。

### 4.3 在线用户 IP 获取（hub.go 既有结构）

Hub 已有 `clients map[string]map[*Client]bool`（[hub.go#L17](../im-server/server/hub.go#L17)，`mu sync.RWMutex` 保护）。新增只读 helper：

```go
// onlineIPOf 取目标用户任一在线连接的真实 IP（多端取任一即可，属地粒度为省）；
// 不在线或启用了集群且目标不在本实例时返回空串
func (s *Server) onlineIPOf(username string) string {
    h.mu.RLock()
    defer h.mu.RUnlock()
    for c := range h.clients[username] {
        return c.ip
    }
    return ""
}
```

### 4.4 协议扩展（server/profile.go）

`ProfileInfo`（[profile.go#L15](../im-server/server/profile.go#L15)）增加一个字段，`buildProfileInfo`（[profile.go#L47](../im-server/server/profile.go#L47)）组装时填充：

```go
type ProfileInfo struct {
    // ... 既有字段不动 ...
    IpRegion string `json:"ip_region"` // IP 属地（微信口径：国内省份/海外国家；空串=不显示）
}
```

```go
// buildProfileInfo 内，DB 读取成功后：
if ipRegionEnabled() {
    info.IpRegion = displayRegionFromIP(s.onlineIPOf(target))
}
```

- 自己与他人的资料查询走同一归口，天然一致；
- **集群模式边界**：`cluster_enabled=true` 且目标用户连接在其他实例时，本实例 hub 查不到 → `ip_region` 为空 → 前端整行隐藏。一期接受该降级（本项目当前主部署为单实例）；跨实例属地查询（经集群总线）列为二期项；
- 离线用户：属地返回空（二期经 `last_login_ip` 落库补齐，AutoMigrate 自动加列，见 §6）。

### 4.5 数据文件分发与更新

- `data/ip2region.xdb`（~11MB）随 `im-server/bin/` 一并分发，来源为 ip2region 官方仓库 `data/ip2region.xdb`；
- 更新流程（一期）：下载社区新版 xdb → 替换文件 → 重启服务端。属低频运维操作，文档化即可；
- 二期可选：admin 后台上传 xdb + 信号量热重载（构建新 searcher 后原子替换全局指针）。

## 五、客户端设计

### 5.1 PC/WEB（im-client/web/js/chat.js，一处改动两端生效）

- PC 是 Electron 壳加载 `im-client/web`，资料卡渲染在 chat.js 资料卡填充函数（PROFILE_RESP 响应处理处，约 L2287 起）增加属地行；
- 渲染规则：`ip_region` 非空才创建该行（空串整行隐藏，降级天然闭环；「内网」为正常值照常渲染）；
- 文案与布局：微信同款「IP属地：XX」，置于地区/签名行之后；
- 样式必须走现有主题色变量（跟随主题切换），自绘元素，不引入系统控件；
- 赋值一律走既有安全渲染通道（textContent 类），属地字符串虽来自服务端数据文件（可信源），仍不拼 HTML。

### 5.2 手机端（im-client/app，二期顺带）

mobile.js 复用同一 `ip_region` 字段，改动模式与 5.1 一致；一期以 PC/WEB 验收，APP 随二期跟进（字段已在协议中，APP 不改也不受影响）。

## 六、实施步骤

| # | 内容 | 涉及文件 |
|---|---|---|
| 1 | 配置项定义与加载 | `im-server/config/config.go`、`bin/config.yaml`、`bin/config - linux.yaml` |
| 2 | ip2region 引入 + xdb 数据文件入 bin/data | `im-server/go.mod`、`bin/data/ip2region.xdb` |
| 3 | 新增解析归口 | `im-server/server/ipregion.go`（新增） |
| 4 | 在线 IP helper | `im-server/server/hub.go` 或 ipregion.go |
| 5 | ProfileInfo 扩展与组装 | `im-server/server/profile.go` |
| 6 | 资料卡渲染 | `im-client/web/js/chat.js` |
| 7 | 编译 + 全量测试（见 §7） | `go build`、PC 端 `build.bat` |

二期候选（各自独立立项，不阻塞一期）：

1. `User` 模型加 `last_login_ip`/`last_login_at`（登录成功处更新，AutoMigrate 自动加列）→ 离线用户属地；
2. 群聊消息流发送者属地标签（消息帧加字段，涉及历史消息渲染，改动大）；
3. 集群模式跨实例属地查询；
4. admin 后台 xdb 上传热更新。

## 七、测试要点（完成后逐项实测）

功能：

- [ ] 公网 IP 用户资料卡显示属地（国内显示省份、海外显示国家），自查 IP 与他人 IP 两个视角；
- [ ] 多端在线（PC+WEB 同账号）属地一致；
- [ ] 内网直连场景（127.0.0.1 / 局域网 IP）资料卡显示「内网」标签；
- [ ] 属地行样式跟随主题色切换，无系统默认控件。

降级与异常：

- [ ] `enabled=false` → 字段恒空、资料卡无该行、无报错日志刷屏；
- [ ] xdb 文件缺失/损坏 → 服务端正常启动、logger.Error 一条、功能关闭；
- [ ] IPv6 连接（如有条件）→ 查询失败返回空，不 panic、不影响登录链路。

影响面（工作区规则逐项核对）：

- [ ] 资料卡其他字段（昵称/性别/地区/签名/备注/添加到通讯录）渲染不受影响；
- [ ] PROFILE_UPDATE 保存链路不受影响（新字段只读下发，不参与更新回写）；
- [ ] 性能：内存增量 ~11MB 常驻；资料查询耗时增量微秒级，5 万在线容量模型无感知；
- [ ] 群聊/私聊消息、位置共享（104/105）等既有链路回归正常；
- [ ] 安全/隐私：报文抓包确认 PROFILE_RESP 不含 IP 明文；属地行无 HTML 注入面。

## 八、风险与注意事项

| 风险 | 评估与对策 |
|---|---|
| IPv6 用户属地查不出 | **已解决（2026-10-29 双栈实施）**：v4/v6 数据文件独立加载、按 ParseIP 字节长度路由，单栈缺失仅该栈降级 |
| 数据精度偏差 | 国内市级/海外国家级，社区数据个别段有偏差，属该数据源正常水平；属地粒度只到省，偏差影响更小 |
| 隐私 | 只下发省级/国家级解析结果，不下发 IP 明文；粒度与微信一致，风险低。「内网」标签仅表明用户处于局域网/本机环境，不含网段与拓扑信息。若需更保守可加管理员开关直接关闭（enabled） |
| 集群模式属地缺失 | 目标在其他实例时查不到，整行隐藏（§4.4），单实例部署不受影响；二期经总线补齐 |
| binding 版本 API 差异 | 引入时以实际版本 README/API 实测为准，禁止照抄记忆中的 API 签名 |
| 内存 | 双栈合计 +~46MB 常驻（v4 10.6MB + v6 35.6MB），服务端既有容量模型（55000 连接）下无感 |
