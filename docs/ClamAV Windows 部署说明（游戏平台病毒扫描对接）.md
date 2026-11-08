# ClamAV Windows 部署说明（游戏平台病毒扫描对接）

本说明用于在一台 Windows 服务器上完成 ClamAV（clamd）部署，并向业务后端提供 TCP 3310 扫描服务，用于游戏安装包的异步病毒扫描与上架拦截。文档按「准备 → 配置 → 拉库 → 起服务 → 验证 → 对接 → 运维」的执行顺序组织，最后集中说明引擎自身的硬限制与排障路径。

**一句话结论：**使用官方原版 Windows 包，固定部署在 **D:\\clamav**，clamd 监听 **127\.0\.0\.1:3310**，病毒库由 freshclam 负责增量更新，业务侧以异步方式调用，异常时 fail\-open 放行、由人工审核兜底。全程免费（GPLv2），仅通过 TCP 协议调用，不触发病毒库开源协议的传染约束。

# 部署目标与关键参数

先明确部署形态，后续所有路径、端口与配置项都以此为准。

|项目|取值|
|---|---|
|**程序版本**|ClamAV Windows x64 绿色 zip 包（官方 GitHub Release）|
|**部署路径**|D:\\clamav，要求全路径无中文、无空格、无特殊符号|
|**服务监听**|127\.0\.0\.1:3310；异机部署改为 0\.0\.0\.0 并仅放行业务后端内网 IP|
|**对外协议**|clamd 原生 TCP 协议，**无身份认证**|
|**扫描模式**|业务侧异步：登记后后台扫描，检出即自动驳回，不阻塞上架响应|
|**授权成本**|GPLv2 开源，免费商用；仅 TCP 调用，无传染风险|

# 前置条件

- **系统：**Windows Server 2019 / 2022，或 Win10 / 11 x64。

- **磁盘：**D 盘预留不小于 50G，用于病毒库、扫描临时文件与日志。

- **内存：**单实例建议不低于 16G；存在并发扫描时建议 32G 以上。

- **权限：**安装、注册服务与修改配置全程使用管理员权限。

- **防火墙：**默认仅本机可访问 3310；异机调用时精确放行业务服务器 IP，禁止对公网开放。

- **Defender 排除：**将 D:\\clamav 加入排除目录，避免扫描时文件锁冲突导致读取失败。

# 程序与病毒库获取

## 引擎程序

官方仓库同时提供源码与 Release 安装包，Windows 包文件名形如 **clamav\-x\.y\.z\.win\.x64\.zip**。国内官网直连较慢时，可采用以下两种等效方式，下载后务必核对哈希或签名，不使用网盘、论坛流传的第三方修改包。

```powershell
# 方式一：winget 一键安装（源走微软 CDN，最稳）
winget install Cisco.ClamAV

# 方式二：GitHub Release 经加速前缀下载固定版本
https://mirror.ghproxy.com/https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.win.x64.zip
```

## 病毒库获取路线

官方不在 GitHub 托管实时病毒库，签名文件只由 database\.clamav\.net 分发，不存在国内官方镜像站。按部署规模选择下表对应路线。

|路线|适用场景|做法与代价|
|---|---|---|
|**在线更新**|单机、可出外网|freshclam 走 db\.cn\.clamav\.net 首选节点，支持增量 CDIFF 与自动校验；高峰时段易超时|
|**离线摆渡**|扫描机无外网|联网机跑一次 freshclam，整目录拷贝 database 后重启 clamd；无需手工挑文件|
|**私有镜像**|多台扫描节点、长期生产|cvdupdate 对外拉库、内网 HTTP 分发，freshclam 配 PrivateMirror；一次投入长期免维护|
|**手工直下**|应急单次|浏览器下载 main\.cvd、daily\.cvd、bytecode\.cvd 三个文件覆盖替换；无增量、必须重启服务|

# 目录初始化

1. 解压压缩包至 D:\\clamav，并新建 D:\\clamav\\database、D:\\clamav\\logs 两个子目录。

2. 管理员打开 CMD，进入 D:\\clamav。

3. 复制两份配置模板：conf\_examples\\clamd\.conf\.sample 复制为 clamd\.conf，conf\_examples\\freshclam\.conf\.sample 复制为 freshclam\.conf。

```cmd
copy conf_examples\clamd.conf.sample clamd.conf
copy conf_examples\freshclam.conf.sample freshclam.conf
```

# 服务端配置

## clamd\.conf

两份模板中的 **Example 行必须删除或注释**，这是首次启动失败最常见的原因。其余按下表写入，全部使用绝对路径。

```ini
DatabaseDirectory "D:\clamav\database"
LogFile "D:\clamav\logs\clamd.log"
LogTime yes

TCPSocket 3310
TCPAddr 127.0.0.1

MaxFileSize 4G
StreamMaxLength 4G
MaxScanSize 8G
MaxRecursion 16
MaxThreads 8
AlertExceedsMax yes

ArchiveMaxFiles 2000
ArchiveMaxRecursion 10
```

启动日志出现如下警告属正常现象，不是报错：引擎会把超出 32 位范围的值自动压到上限并继续启动。

```text
WARNING: Numerical value for option MaxFileSize too high, resetting to 4294967295
WARNING: Numerical value for option StreamMaxLength too high, resetting to 4294967295
```

|参数|作用|取值说明|
|---|---|---|
|**StreamMaxLength**|INSTREAM 流式传输上限|硬上限 4G，业务侧传流超过该值会被截断|
|**MaxFileSize**|单个内嵌文件扫描上限|设到 4G 仍受引擎内部 2G 单文件限制，更大文件跳过|
|**MaxScanSize**|解压展开后总扫描数据量|不受上述 4G 约束，建议放开到 8G|
|**AlertExceedsMax**|超限时返回告警|置 yes，返回 Heuristics\.Limits\.Exceeded，供业务识别未完整扫描|
|**MaxThreads**|并发扫描线程|按 CPU 核数与内存配比，建议不超过核数|
|**Archive\***|压缩包递归深度与文件数|防止恶意嵌套压缩导致资源耗尽|

## freshclam\.conf

同样先注释 Example 行，再按下述内容配置。NotifyClamd 让病毒库更新完成后自动热加载，无需重启服务。

```ini
DatabaseDirectory "D:\clamav\database"
UpdateLogFile "D:\clamav\logs\freshclam.log"

DatabaseMirror db.cn.clamav.net
DatabaseMirror database.clamav.net

NotifyClamd "D:\clamav\clamd.conf"
Checks 24
```

使用私有镜像时，注释全部 DatabaseMirror，改为 **PrivateMirror http://内网镜像地址**；需要代理出网时增加 **HTTPProxy 地址:端口**。

# 病毒库更新

## 首次拉取

首次下载体积大、耗时从数分钟到数十分钟不等，建议在业务低峰执行。完成后 database 目录应出现 main\.cvd、daily\.cvd、bytecode\.cvd。

```cmd
freshclam.exe --config-file=D:\clamav\freshclam.conf --verbose
```

## 定时更新

Windows 版 freshclam 没有常驻守护进程，必须用任务计划程序实现周期性更新。

1. 新建任务，设置为「不管用户是否登录都运行」，勾选最高权限。

2. 触发器设为每 6 小时一次，时间避开业务高峰。

3. 操作项填写程序 D:\\clamav\\freshclam\.exe，参数 \-\-config\-file=D:\\clamav\\freshclam\.conf。

## 离线摆渡

1. 在一台可联网、ClamAV 版本一致的机器执行一次 freshclam 完成更新。

2. net stop clamd 停止目标机服务。

3. 整目录拷贝 database 覆盖到目标机同名目录。

4. net start clamd 重启服务，触发新库加载。

**注意：**手工拷贝的库文件不会触发热加载，必须重启 clamd 才生效；浏览器直下的 cvd 无增量补丁，跨版本过久时可能加载失败。

# 服务注册与启停

```cmd
clamd.exe --config-file=D:\clamav\clamd.conf --install-service
net start clamd
net stop clamd
clamd.exe --uninstall-service
```

# 上线前验证

两步验证，分别确认协议通道与检出能力正常，验证通过后再打开业务开关。

1. **通道连通：**telnet 127\.0\.0\.1 3310，发送 PING 并返回 PONG。

2. **检出能力：**准备 EICAR 标准测试文件，用 clamdscan 扫描并确认报毒。禁止使用真实病毒样本测试。

```cmd
clamdscan.exe --config-file=D:\clamav\clamd.conf D:\eicar.txt
```

# 业务后端对接

服务就绪后修改业务配置，建议先以异步模式灰度一段时间再评估是否切同步。

```yaml
clamav:
  enabled: true
  addr: "127.0.0.1:3310"
  timeout_sec: 600
  sync: false
```

- **enabled：**缺乏 clamd 时保持 false，业务侧零开销。

- **addr：**异机部署时改为扫描服务器内网 IP，端口不变。

- **timeout\_sec：**GB 级单文件扫描耗时长，600 秒为合理下限，不建议调小。

- **sync：**false 为异步扫描，上架不阻塞，检出后自动驳回；切 true 则登记前同步扫描，大包会把上架响应拖到分钟级。

# 运维监控

|监控项|判断标准|
|---|---|
|**服务存活**|clamd 服务处于运行状态，异常退出需告警|
|**通道心跳**|定时对 3310 发送 PING，非 PONG 即视为不可用|
|**病毒库时效**|核对库更新时间，超过设定阈值未更新需告警|
|**超限记录**|巡检 clamd\.log 中 Heuristics\.Limits\.Exceeded，转为人工复核|
|**容量**|监控 database 与日志目录占用，日志按月归档|
|**业务事件**|病毒命中、扫描超时、扫描失败均推送告警|

# 限制与风险

- **无鉴权：**clamd 协议不做身份校验，任何能连上 3310 的客户端都可以让其扫描本机文件，**严禁对公网开放**，这是本方案最大的安全边界。

- **大包截断：**超过 4G 的传输流会被 StreamMaxLength 截断，单文件超 2G 会被引擎跳过；需依靠 AlertExceedsMax 识别，并由人工兜底。

- **资源消耗：**大包与嵌套压缩解压会显著占用内存和磁盘 IO，多节点并发时应分机部署而非单机堆并发。

- **误报特性：**对加壳、游戏自定义资源与模拟器打包误报率偏高，宜作为前置拦截而非唯一判定。

- **隐私边界：**自建 clamd 不主动上传任何文件，隐私可控；日志会记录传入的文件名，业务侧建议传随机 ID 或哈希，避免原始包名外泄。

# 故障排查

|现象|优先排查|处理|
|---|---|---|
|**服务启动失败**|配置文件是否残留 Example 行、路径是否写错|查看 logs\\clamd\.log，注释 Example 后重试注册|
|**freshclam 超时**|CDN 节点连通性、IP 是否被限流|换低峰时段更新，或改用私有镜像|
|**扫描读取失败**|Defender 占用文件、临时目录未排除|排除 D:\\clamav 与扫描临时目录|
|**文件被跳过**|是否超出大小或压缩嵌套限制|对照日志判定，超限项转人工复核|
|**库更新不生效**|是否手工拷贝而未重启服务|重启 clamd 或确认 NotifyClamd 生效|
|**业务连不上 3310**|监听地址、防火墙白名单|核对 TCPAddr 配置与入站规则|

# 上线执行顺序

1. 解压程序、建目录、写两份配置文件并删除 Example 行。

2. 执行 freshclam 完成首次拉库，确认三个 cvd 文件就位。

3. 注册 clamd 服务并启动。

4. 完成 PING 与 EICAR 两项验证。

5. 配置任务计划实现病毒库定时更新。

6. 业务侧启用 enabled，保持 sync = false 灰度运行。

7. 执行后台「游戏审核 → 病毒扫描」存量回溯，补扫历史包。

> （注：部分内容由豆包工作 AI 生成）
