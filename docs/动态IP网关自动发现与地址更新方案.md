# 动态 IP 网关自动发现与地址更新方案

> 状态：设计评审稿（未实施）
> 关联代码：`im-server/gateway/`（网关心跳上报）、`im-server/server/game.go`（地址簿下发）、`im-server/model/model.go`（GatewayBook 扩展）、PC 客户端 `game-forward.js`

---

## 一、问题背景

### 1.1 现状

当前网关地址簿 `im_gateway_book` 中 `addr` 字段为**静态配置**（如 `1.2.3.4:30100`），由管理员在后台手动录入。PC 客户端登录后从 im-server 拉取地址簿，按游戏配置的 `@网关名` 找到对应地址进行 TLS 加密隧道连接。

### 1.2 痛点

部分商户的网关服务器运行在**动态外网 IP** 环境下（家庭宽带、动态IP云服务器等），IP 会定期变化。一旦 IP 变更，地址簿中记录的旧地址立即失效：

- PC 客户端连不上网关 → 玩家无法联机
- 管理员需手动登录后台修改地址 → 响应滞后（分钟级甚至小时级）
- 变更期间所有依赖该网关的游戏全部断联

### 1.3 目标

**实现网关地址零人工干预的自动更新**，确保 IP 变化后客户端在最短时间内（目标 ≤ 60 秒）自动获取新地址并恢复联机。

---

## 二、方案对比

| 方案 | 原理 | 优点 | 缺点 | 推荐度 |
|------|------|------|------|--------|
| **A. 网关心跳自报（推荐）** | 网关周期性向服务端上报自己的公网IP | 实时性强（秒级）、无需额外依赖、服务端可校验 | 需网关新增心跳模块 | ⭐⭐⭐⭐⭐ |
| **B. DDNS 域名方案** | 网关 IP 变化时更新动态 DNS，地址簿存域名 | 成熟稳定、TLS 证书可绑定域名 | 需商户注册域名、DNS 缓存延迟（分钟级）、证书管理复杂 | ⭐⭐⭐ |
| **C. 服务端 STUN 探测** | 服务端定期对网关发起 STUN 请求探测其公网IP | 网关零改动 | 网关机需额外开放 STUN 端口、服务端主动探测被防火墙拦截概率高、NAT 类型导致探测不准 | ⭐⭐ |
| **D. 客户端 P2P 打洞探测** | 客户端连不上时通过 TURN 中继尝试 P2P 发现新地址 | 完全去中心化 | 打洞成功率受限（对称NAT、运营商限制）、实现复杂 | ⭐⭐ |

### 最终方案：A（网关心跳自报）为主 + B（DDNS 可选）为辅

核心理由：
1. 网关本就有**出站拉取 im-server** 的需求（写库拉取器已实现），心跳是既有链路的自然扩展，零新增入站端口暴露面
2. 网关自报 IP 是**主动行为**，不受运营商 NAT/防火墙限制
3. 结合 DDNS 作为**额外兜底**（商户已有 DDNS 场景下可跳过心跳，直接存域名）

---

## 三、整体架构

```
                         im-server（中央服务端）
                         ┌─────────────────────────┐
                         │                         │
 ┌──────────────────┐   │  GatewayBook (DB)        │   ┌──────────────┐
 │  im-gateway       │──▶│  addr / hostname / IP   │◀──│   PC 客户端    │
 │  (商户服务器)      │   │  last_seen / last_ip   │   │  (拉库/游戏)   │
 └──────────────────┘   │                         │   └──────────────┘
                         │  心跳接口 /internal/gw/  │
                         │  heartbeat (HMAC 鉴权)  │
                         └─────────────────────────┘
                                  ▲
                                  │ 网关出站（复用写库拉取链路）
                                  │
                      ┌───────────┴───────────┐
                      │  网关自报内容：         │
                      │  - 网关名 (gateway_name)│
                      │  - 公网 IP (自探测)     │
                      │  - 监听端口 (配置)      │
                      │  - TLS 指纹 (证书)      │
                      │  - HMAC 签名 (密钥)     │
                      └───────────────────────┘
```

### 3.1 数据流时序

```
网关启动
  │
  ├── 1. 从 gateway.yaml 读取 gateway_name / im_addr / token_secret
  │
  ├── 2. 启动公网 IP 探测模块（多源并行：ipify / icanhazip / ifconfig.me 等）
  │
  ├── 3. 向 im-server /internal/gw/heartbeat 发送首次心跳（携带当前 IP）
  │
  ├── 4. 进入 30s 周期心跳循环
  │       │
  │       ├── 每次心跳前重新探测公网 IP
  │       ├── IP 变化 → 立即上报（不等周期到）
  │       └── IP 未变 → 正常周期上报（维持 last_seen 新鲜度）
  │
  └── （与既有写库拉取器、积分充值拉取器并行运行，互不影响）
```

---

## 四、详细设计

### 4.1 GatewayBook 模型扩展

在现有 `GatewayBook` 表基础上新增字段（AutoMigrate 自动加列，存量行零回归）：

```go
// GatewayBook 网关地址簿（扩展后）
type GatewayBook struct {
    ID          uint      `gorm:"primaryKey" json:"id"`
    Name        string    `gorm:"column:name;size:64;uniqueIndex" json:"name"`
    
    // ===== 地址相关（三选一，优先顺序：AutoHeartbeat > Hostname > Addr）=====
    Addr        string    `gorm:"column:addr;size:128" json:"addr"`
                           // 静态地址（如 1.2.3.4:30100），留空则走自动地址
    Hostname    string    `gorm:"column:hostname;size:256;default:''" json:"hostname"`
                           // 动态 DNS 域名（如 gw1.merchant.com:30100），客户端自解析
    AutoAddr    string    `gorm:"column:auto_addr;size:128;default:''" json:"auto_addr"`
                           // 心跳自报地址（由网关心跳自动更新，客户端优先使用）
    
    // ===== TLS 与鉴权 =====
    Fingerprint string    `gorm:"column:fingerprint;size:128" json:"fingerprint"`
    Secret      string    `gorm:"column:secret;size:128;default:''" json:"secret"`
    Enabled     bool      `gorm:"column:enabled;default:true" json:"enabled"`
    Sort        int       `gorm:"column:sort;default:0" json:"sort"`
    
    // ===== 心跳状态（网关健康度，仅供管理端排查，不下发客户端）=====
    LastSeen    time.Time `gorm:"column:last_seen" json:"last_seen"`
                           // 最近一次心跳时间
    LastIP      string    `gorm:"column:last_ip;size:64;default:''" json:"last_ip"`
                           // 最近一次心跳上报的 IP（用于检测频繁抖动）
    LastPort    int       `gorm:"column:last_port;default:0" json:"last_port"`
                           // 最近一次心跳上报的端口
    IPChangeCount int     `gorm:"column:ip_change_count;default:0" json:"ip_change_count"`
                           // IP 累计变更次数（管理端运维参考）
    CreateTime  time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
    UpdateTime  time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}
```

#### 客户端地址解析优先级

```
优先级（高 → 低）：
1. AutoAddr  （网关心跳自报，最新最准）
2. Hostname  （DDNS 域名，DNS 解析获取 IP）
3. Addr      （管理员手动配置的静态地址，兜底）
```

- 三条路径互斥使用：`AutoAddr` 非空时客户端直接用它；`AutoAddr` 为空但 `Hostname` 非空时客户端 DNS 解析域名后连接；两者都空才用 `Addr`
- 管理后台保存时校验：三者至少配置一个；若同时配置多个，按优先级自动覆盖下发

### 4.2 网关新增：公网 IP 自探测模块

#### 4.2.1 探测策略

```
探测流程：
  并行请求多个公网 IP 探测服务（全部超时/失败即判定为内网或防火墙阻断）：
  ├── https://api.ipify.org?format=json
  ├── https://icanhazip.com
  ├── https://ifconfig.me/ip
  ├── https://checkip.amazonaws.com
  └── https://ident.me

  过滤规则：
  ├── 命中 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 / 127.0.0.0/8 → 丢弃（内网 IP）
  ├── IPv6 临时不处理（先聚焦 IPv4）
  └── 多个源返回 IP 不一致 → 取多数投票（≥2/3 一致），否则丢弃本次探测

  探测间隔：
  ├── 心跳周期内探测一次（默认 30s）
  ├── 检测到 IP 变化 → 立即上报（下次心跳不等周期到）
  └── 探测全部失败 → 不上报 IP 字段，服务端不更新 auto_addr
```

#### 4.2.2 实现要点

```go
// detectPublicIP 多源并行探测公网 IPv4（私网段过滤 + 多数投票）
func detectPublicIP(ctx context.Context) (string, error) {
    services := []string{
        "https://api.ipify.org?format=json",
        "https://icanhazip.com",
        "https://ifconfig.me/ip",
        "https://checkip.amazonaws.com",
        "https://ident.me",
    }
    // ... 并行请求，收集返回值，过滤私网，多数投票
}

// isPrivateIP 判断是否为内网 IP
func isPrivateIP(ip string) bool {
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16
}
```

- 超时：每个请求 3 秒超时（默认 5 个源并行 → 最坏情况 3 秒完成一轮探测）
- HTTP 客户端：复用既有配置的 TLS 设置，禁用代理（网关侧不走代理）
- 探测全部失败时，本次心跳不带 IP 字段，服务端不更新 `auto_addr`，仅刷新 `last_seen`（表明网关活着但暂时无法自报 IP）

### 4.3 网关心跳上报

#### 4.3.1 心跳接口（服务端）

```
POST /internal/gw/heartbeat

请求体（JSON）：
{
    "gw":          "game-a",           // 网关名（必须与 GatewayBook.Name 匹配）
    "ip":          "1.2.3.4",          // 公网 IPv4（探测失败时留空）
    "port":        30100,              // 当前监听端口（便于多端口场景识别）
    "fingerprint": "abcdef...",        // TLS 证书 SHA256 指纹（服务端比对校验）
    "sig":         "hex(HMAC-SHA256(secret, payload))"
}

鉴权：
  sig = HMAC-SHA256(secret, "heartbeat:" + gw + ":" + timestamp + ":" + ip + ":" + port)
  timestamp 内嵌 payload，±300s 防重放

响应（JSON）：
{
    "ok":        true,
    "addr":      "1.2.3.4:30100",     // 服务端记录的当前地址（网关侧日志确认用）
    "need_cfg":  false                 // true=服务端请求网关上报完整 gateway.yaml 用于后台展示（二期功能）
}
```

#### 4.3.2 心跳处理逻辑（服务端）

```go
func (s *Server) handleInternalGwHeartbeat(w http.ResponseWriter, r *http.Request) {
    // 1. 解析请求体（网关名必须存在，其他字段允许空）
    // 2. 查 GatewayBook（按 name）：
    //    - 条目不存在 → 404 "unknown gateway"
    //    - enabled=false → 403 "gateway disabled"
    // 3. HMAC 签名校验（条目 secret 非空用条目密钥，空用共享密钥）
    // 4. fingerprint 比对（网关自报的 TLS 指纹与条目记录不一致 → 记录 WARN 日志但仍更新，
    //    因为网关可能更换了证书；fingerprint 不一致时 auto_addr 更新但客户端会因 pin 校验失败，
    //    需等管理员同步更新条目 fingerprint——二期可做证书轮转自动协商）
    // 5. 更新 GatewayBook：
    //    - last_seen = now
    //    - ip 非空 && ip != last_ip → auto_addr = ip:port, last_ip = ip, ip_change_count++
    //    - ip 非空 && ip == last_ip → 仅刷新 last_seen（无变化）
    //    - ip 为空 → 仅刷新 last_seen（探测失败，不动 auto_addr）
    // 6. 返回 addr 供网关日志确认
}
```

#### 4.3.3 网关心跳循环

```go
// heartbeatLoop 心跳主循环（与写库拉取器并行运行，互不影响）
func heartbeatLoop(cfg *Config) {
    ticker := time.NewTicker(cfg.HeartbeatInterval) // 默认 30s
    defer ticker.Stop()
    
    var lastReportedIP string
    for {
        // 1. 探测公网 IP
        ip, err := detectPublicIP(context.Background())
        if err != nil {
            log.Printf("[heartbeat] 公网 IP 探测失败: %v", err)
            // 探测失败 → 仍发送心跳但不带 IP（让服务端知道网关活着）
        }
        
        // 2. 构造心跳请求（IP 变化时立即上报，不等 ticker 触发）
        if ip != "" && ip != lastReportedIP {
            log.Printf("[heartbeat] 公网 IP 变化: %s → %s", lastReportedIP, ip)
            sendHeartbeat(cfg, ip)
            lastReportedIP = ip
            continue
        }
        
        // 3. 正常周期心跳
        sendHeartbeat(cfg, ip)
        <-ticker.C
    }
}
```

#### 4.3.4 gateway.yaml 新增配置

```yaml
# ===== 网关心跳（动态 IP 自动上报；默认启用，无需额外配置即可工作）=====
heartbeat:
  enabled: true                       # 总开关（false 时不启动心跳，适合固定 IP 网关）
  gateway_name: "game-a"              # 网关名（须与 im-server 地址簿条目 name 一致，心跳/写库/充值共用）
  im_addr: "http://im服务器地址:2087"  # im-server 地址（心跳/写库/充值共用，出站零新增暴露面）
  interval: 30                        # 心跳周期秒（默认 30s，范围 5~300）
  ip_services: []                     # 公网 IP 探测服务列表（空=用内置默认 5 个；可自定义覆盖）
  #   - "https://api.ipify.org?format=json"
  #   - "https://icanhazip.com"
```

> **重要**：`heartbeat.gateway_name` 和 `heartbeat.im_addr` 与 `dbwrite` 节下同名字段语义完全相同。若同时配置，以 `heartbeat` 节为准；若只在 `dbwrite` 节配置，心跳自动复用（写库和心跳通常一起部署，避免商户填两次）。

### 4.4 客户端地址解析与容错

#### 4.4.1 地址解析逻辑

```typescript
// game-forward.js 中网关地址获取
function resolveGatewayAddr(gwBook) {
    // gwBook 为服务端下发的网关条目（每次拉库刷新）
    const { auto_addr, hostname, addr } = gwBook;
    
    // 优先级 1：心跳自报（最新）
    if (auto_addr) {
        return auto_addr;  // "1.2.3.4:30100"
    }
    
    // 优先级 2：DDNS 域名
    if (hostname) {
        return hostname;  // 客户端 DNS 解析 "gw1.merchant.com:30100"
    }
    
    // 优先级 3：静态地址（兜底）
    return addr;
}
```

#### 4.4.2 连接失败时的刷新策略

```
网关连接失败（TLS 握手超时 / token 验签失败 / 连接被拒）：
  │
  ├── 场景 1：auto_addr 与上次相同（服务端未更新）
  │   └── 提示用户"网关暂时不可用，请稍后重试" + 显示网关名
  │
  ├── 场景 2：auto_addr 与上次不同（服务端已更新）
  │   └── 自动用新地址重试一次（用户无感知）
  │
  └── 场景 3：DNS 解析失败（hostname 模式）
      └── 尝试 addr 兜底；仍失败则提示
```

- 客户端现有**每次启动拉库**的机制已能获取最新地址（库接口 gameGatewayResp 实时读 GatewayBook 表）
- 游戏运行中网关地址变化（极少见，但家宽重新拨号可能出现）→ 客户端下次重连网关时自动用新地址（TLS 握手阶段会用到最新的地址簿数据）
- 无需新增"地址变化推送"信令——拉库周期已足够覆盖（游戏启动/房间创建前都会触发拉库）

### 4.5 服务端下发接口适配

`gameGatewayResp` 函数（服务端下发网关配置给客户端）需调整：

```go
// gameGatewayResp 扩展后：auto_addr 优先下发
func (s *Server) gameGatewayResp(username string) map[string]interface{} {
    // ... 现有逻辑 ...
    for _, g := range list {
        item := map[string]string{
            "name":        g["name"],
            // 地址优先级：auto_addr > hostname > addr
            "addr":        firstNonEmpty(g["auto_addr"], g["hostname"], g["addr"]),
            "fingerprint": g["fingerprint"],
        }
        // ... 签名/令牌逻辑不变 ...
    }
}
```

### 4.6 管理后台展示扩展

网关地址簿管理页新增以下信息展示（**仅管理端可见，不下发客户端**）：

| 字段 | 说明 |
|------|------|
| 地址来源徽标 | 🟢 心跳自报 / 🟡 DDNS 域名 / 🔵 静态配置 |
| 最近心跳 | 上次自报时间（如 "3 秒前" / "5 分钟前"） |
| IP 变更次数 | 累计变更计数（运维参考：频繁抖动可能是网关不稳定） |
| 心跳状态 | 在线（心跳在 interval×3 内）/ 离线（超 interval×10 无心跳） |

---

## 五、安全设计

| 威胁面 | 对策 |
|--------|------|
| 伪造心跳更新他人网关地址 | **HMAC 签名**：心跳 payload 用 `GatewayBook.Secret`（或共享密钥）签名，密钥仅网关持有，无法伪造 |
| 心跳重放 | 心跳 payload 内嵌时间戳，服务端校验 ±300s 有效窗口 |
| 中间人篡改心跳 | HMAC 签名对 payload 做完整性校验，篡改即验签失败 |
| 恶意网关上报虚假 IP 劫持流量 | ① fingerprint 比对：上报 IP 必须对应正确 TLS 指纹，否则客户端 pin 校验失败自动拒绝；② fingerprint 与条目不一致时服务端记 WARN 但不拦截 auto_addr 更新——但客户端 pin 到旧指纹会连接失败，自然阻断劫持链；③ 管理员应同步更新 fingerprint（二期可做证书协商自动更新） |
| 探测接口被 SLA 限流 | 多源并行探测 + 超时兜底；全部失败时不上报 IP，仅刷新 last_seen |
| 心跳刷接口 DoS | ① 心跳接口按网关名限速（单网关 10/min，超过丢弃）；② last_seen 在内存用 atomic 刷新避免 DB 写风暴 |

### 5.1 密钥体系不变

心跳 HMAC 验签密钥 = `GatewayBook.Secret`（条目专属，空则回退全局 `gateway_token_secret`）——**完全复用现有密钥体系**，不新增密钥管理复杂度。

### 5.2 地址簿变更审计

GatewayBook 表新增 `last_seen`/`last_ip`/`last_port`/`ip_change_count` 字段后：
- 心跳更新 `auto_addr` 时自动刷新 `update_time`
- 管理后台可查看地址变更历史（通过 `ip_change_count` 递增 + `update_time` 时间线）

---

## 六、兼容与降级

| 场景 | 行为 |
|------|------|
| 旧版 im-gateway（无心跳功能）连新版 im-server | 旧网关不发心跳 → `auto_addr` 保持空 → 客户端走 `addr` 静态地址兜底 |
| 新版 im-gateway 连旧版 im-server | 心跳请求 404 → 网关日志告警 → 自动降级为固定 IP 模式（`heartbeat.enabled=false`） |
| DDNS 域名已配置 + 心跳同时启用 | `auto_addr` 非空优先，`hostname` 仅当 `auto_addr` 空时生效 |
| 心跳周期内 IP 变更 | 网关立即探测并上报（不等下次 ticker 触发） |
| 探测服务全部不可达（运营商网络限制） | 心跳不带 IP 字段 → `auto_addr` 保持上次有效值（未超时）→ 客户端继续用旧地址（可能短暂失效但不会断联恶化） |

---

## 七、分期计划

| 期 | 内容 |
|----|------|
| **P1 核心闭环** | GatewayBook 模型扩展（AutoMigrate 自动加列）+ 网关心跳模块（IP 探测 + HMAC 签名 + 上报循环）+ 服务端心跳接口（鉴权 + 地址更新逻辑）+ gameGatewayResp 下发优先级调整 + 管理后台心跳状态展示 |
| **P2** | DDNS 域名完整支持（hostname 字段 DNS 缓存 + 客户端 TTL 优化）+ TLS 证书指纹自动协商更新（网关更换证书后自动同步服务端条目）+ 心跳失败自动告警（last_seen 超阈值时管理后台红点 + 邮件/钉钉通知） |
| **P3 可选增强** | 客户端连接失败自动触发服务端拉库（不等下次启动/开房）+ 多条目同 IP 聚合（服务端识别同公网 IP 的多个网关，心跳时批量更新） |

---

## 八、改动点清单

### 网关端（im-server/gateway/）

| 文件 | 动作 | 内容 |
|------|------|------|
| `main.go` | 改 | 启动时并行启动 heartbeatLoop（与 dbwriteLoop / rechargeLoop 并列） |
| `heartbeat.go` | **新增** | 心跳主循环 + 公网 IP 探测 + HMAC 签名上报 |
| `gateway.yaml` | 改 | Heartbeat 配置节（enabled / gateway_name / im_addr / interval）|
| `config.go` | 改 | Config 结构体新增 HeartbeatConfig |

### 服务端（im-server/server/）

| 文件 | 动作 | 内容 |
|------|------|------|
| `model/model.go` | 改 | GatewayBook 新增 AutoAddr / Hostname / LastSeen / LastIP / LastPort / IPChangeCount 字段 |
| `game.go` | 改 | gameGatewayResp 调整地址优先级（auto_addr > hostname > addr）|
| `gatewaydbwrite.go` | 改 | 网关心跳接口（/internal/gw/heartbeat）+ GatewayBook 自动更新逻辑 |
| `gameadmin.go` | 改 | 管理后台网关地址簿接口适配新字段（心跳状态展示） |

### 客户端（im-client/pc/）

| 文件 | 动作 | 内容 |
|------|------|------|
| `game-forward.js` | 改 | 地址解析逻辑（auto_addr 优先）+ 连接失败自动重试新地址 |

---

## 九、验收清单（P1）

- [ ] 网关启动后 30s 内向服务端发送首次心跳
- [ ] 服务端收到心跳后 GatewayBook.auto_addr 被正确更新（IP:Port）
- [ ] 网关 IP 变化后，最多下次 ticker（30s，P1 做不到立即，P1 用检测到变化即上报优化）内 auto_addr 更新
- [ ] 网关心跳签名错误（用错密钥/过期时间戳）→ 服务端拒绝，auto_addr 不更新
- [ ] 网关 fingerprint 与条目不一致 → 服务端记录 WARN 日志但 auto_addr 仍更新；客户端因 pin 校验失败自然阻断（指纹比对逻辑在客户端转发器）
- [ ] auto_addr 优先级正确：客户端拿到 auto_addr 后用它连接，忽略 addr/hostname
- [ ] 探测服务全部失败 → 心跳仍发送但不带 IP，auto_addr 保持上次有效，last_seen 刷新
- [ ] 旧版网关（无心跳）→ auto_addr 保持空 → 客户端走 addr 静态地址
- [ ] 心跳接口单网关限速生效（高频请求被丢弃）
- [ ] 管理后台网关地址簿展示心跳状态徽标 + 最近心跳时间 + IP 变更次数
- [ ] 既有写库拉取器、积分充值拉取器功能零回归
- [ ] 既有隧道联机功能零回归（心跳是独立 goroutine，不占用隧道端口/连接）

---

## 十、附录

### A. 公网 IP 探测服务列表

| 服务 | 格式 | 备注 |
|------|------|------|
| ipify | JSON `{"ip":"1.2.3.4"}` | 推荐，有 HTTPS，可 JSON 解析 |
| icanhazip | 纯文本 `1.2.3.4` | 老牌，无 JSON 直接取 body |
| ifconfig.me | 纯文本 `1.2.3.4` | 支持大量参数，默认返回文本 |
| checkip.amazon.com | 纯文本 `1.2.3.4` | 亚马逊出品，稳定 |
| ident.me | 纯文本 `1.2.3.4` | 简单可靠 |

### B. 心跳 HMAC 签名算法

```
payload = "heartbeat:" + gateway_name + ":" + timestamp + ":" + ip + ":" + port
sig     = HMAC-SHA256(secret, payload) → hex 编码
```

- `timestamp` 为 Unix 秒级时间戳
- `ip` 探测失败时填空字符串 `""`
- `secret` 优先用 GatewayBook.Secret，空则回退 config.yaml 中 gateway_token_secret

### C. 地址优先级决策树

```
                    ┌─ auto_addr 非空？─── YES ──▶ 用 auto_addr（最新心跳自报）
                    │
GatewayBook 各地址 ──┼─ hostname 非空？─── YES ──▶ 客户端 DNS 解析后连接（DDNS）
                    │
                    └─ addr 非空？─────── YES ──▶ 用 addr（管理员静态配置，兜底）
                                                  NO ──▶ 连接失败，提示用户
```

### D. config.yaml 与 gateway.yaml 字段复用关系

```yaml
# gateway.yaml
heartbeat:
  enabled: true
  gateway_name: "game-a"           # ──┐
  im_addr: "http://im-server:2087" #   ├── 与 dbwrite 节同名字段语义完全相同
  interval: 30                      #   │   心跳/写库/充值三个模块共用这两项
dbwrite:                           #   │   避免商户填两次
  gateway_name: "game-a"           # ──┘（若 heartbeat.gateway_name 空，自动复用 dbwrite.gateway_name）
  im_addr: "http://im-server:2087"
```
