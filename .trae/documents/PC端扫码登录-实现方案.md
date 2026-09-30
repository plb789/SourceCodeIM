# PC/WEB 端扫码登录（微信同款）实现方案（阶段二百四十）

## Context
用户需求：PC 登录页在账号密码之外支持扫码登录——PC 显示二维码，手机 APP「扫一扫」扫描并在手机上确认后 PC 免密登录（微信同款交互）。

现状基础（已探明）：
- 全系统密码鉴权：`im_auth` 存 `{u,p}`（chat.js L399），WS 登录 content=密码（socket.js L297），服务端 `handleLogin` 仅验密（server.go L413-429）
- 手机端扫一扫已存在：webview 内 getUserMedia + jsQR 解码，`handleResult` 目前只识别加好友协议串（qr.js L175-190）
- 二维码生成库 `qrcode.min.js` 已内嵌（index.html L2300 加载）
- 登录页：index.html L104-168（PC/WEB 共用，当前仅账号密码表单）
- HTTP 路由：main.go L110-232 `http.HandleFunc` 直注册模式

## 总体流程（微信同款三级状态）
```
PC登录页                服务端                    手机APP(已登录账号A)
  │ POST /api/qrlogin/create                       │
  │──────────────────────►│ 生成qr_id(2min TTL)     │
  │ ◄──{id}────────────── │                         │
  │ 渲染二维码(内容: https://<host>/qrl?t=<id>)      │
  │ GET /api/qrlogin/poll?id= (每1.5s)              │
  │──────────────────────►│                         │
  │                       │ ◄──msg71 {action:scan}──│ (扫一扫识别/qrl?t=)
  │ ◄──{state:scanned}─── │ 状态=scanned            │
  │ 二维码盖"已扫描"浮层   │ ◄──msg71{action:confirm}│ (手机确认页点确认)
  │ ◄──{state:confirmed, code}──│ 生成一次性登录码(60s)│
  │ WS登录 msg_type=7 content="qrc:<code>"          │
  │─────────────────────────────────────────────────│
  │            服务端 handleLogin 识别 qrc: 前缀      │
  │            校验一次性→按 qr 绑定账号走既有登录链路 │
```

## 服务端改动

### 1. 新建 `im-server/server/qrlogin.go`
- 内存状态机：`map[qrID]*qrSession{State, Username, Platform, ExpiresAt, Code, CodeExpiresAt}` + `sync.Mutex`；qrID = crypto/rand 32 hex；TTL 2 分钟，过期惰性清理
- HTTP handlers（注册进 main.go）：
  - `POST /api/qrlogin/create`：body `{platform}` → `{ok, id, expires_in:120}`；无鉴权（登录前），简单 IP 限频（每 IP 每分钟 ≤30 次，内存计数）
  - `GET /api/qrlogin/poll?id=`：`{state: waiting|scanned|confirmed|expired}`；confirmed 时生成一次性登录码（rand 48 hex，60s 有效）返回**一次**并置 used；响应不含用户名（防枚举）
  - `GET /qrl?t=`：极简落地页（内嵌 HTML 常量）——系统相机扫到提示「请使用即时通讯 APP 扫一扫打开」
- WS 71 帧处理（手机端，天然登录态鉴权）：`HandleQRSign(c, msg)`：校验 `c.username != ""`；action=scan→状态 waiting→scanned（校验归属不存在，任何人可扫，确认时定账号）；action=confirm→绑定 `Username=c.username`→confirmed；action=cancel→回 waiting 并作废；均回执帧 `{action:"ok"/"error", reason}`
- 实现时确认 msg_type=71 未被占用（protocol/message.go 现有：7/8/70/85/86/94 等，冲突则顺延取 91）

### 2. `im-server/server/server.go` handleLogin 扩展（L415 处）
- `password` 以 `qrc:` 前缀开头 → 走扫码通道：校验登录码（存在/未消费/未过期）→ 按 qr.Username 查 DB 得 user → **跳过 verifyUser**，直接进 L456 起的既有状态拦截/多端/配置下发链路（零重复实现）→ 消费登录码
- 排队器 `loginQ.admit` 仍前置（L420 不动）

### 3. `im-server/protocol/message.go`
- 新增 `MsgTypeQRSign = 71`（或确认未占用后的实际值）

### 4. `im-server/main.go`
- 注册 3 条路由（跟随现有注册风格与日志包装）

## 前端改动（PC/WEB 共用，APP 零原生改动）

### 5. `im-client/web/index.html`（登录表单区 L104-168）
- 登录卡片顶部加「账号密码登录 | 扫码登录」自绘切换 tab（主题色高亮，禁系统控件）
- 扫码面板：二维码容器（qrcode.min.js 渲染）+ 状态文案区；scanned 态二维码上盖绿色对勾浮层 +「已扫描，请在手机上确认」；expired 态置灰 +「二维码已过期，点击刷新」（点击重走 create）；底部提示「请使用手机 APP『扫一扫』扫描二维码登录」

### 6. `im-client/web/js/chat.js`
- 登录 tab 切换逻辑 + 扫码流程归口：create→渲染→轮询（1.5s，页面隐藏时暂停）→confirmed 拿 code→`IMSocket.connect(username, {qrCode: code})`（username 从 poll confirmed 响应…**不行，poll 不回 username**——改为 confirmed 后 socket 登录帧 from_user 留空、content=qrc:code，服务端以 qr.Username 为准；socket.js 登录帧发送处支持 qrCode 模式省略 from_user）
- 登录成功复用既有 LOGIN_RESP 链路（L394 起存储逻辑：扫码登录存 `{u:qr用户名, p:''}`——服务端不回传密码，本次会话内断线重连走已建立的连接；**PC 重启后需重新扫码或输密码**（微信 PC 未开自动登录时同款行为），自动登录失败自然回落登录页）
- create 请求失败（旧服务端 404）→ toast「当前服务端暂不支持扫码登录」并停留在密码 tab

### 7. `im-client/web/js/socket.js`（L297 登录帧）
- connect 增加 opts：qrCode 模式下 `from_user:''`, `content:'qrc:'+code`，platform 照旧上报

### 8. `im-client/web/js/qr.js`（handleResult L175）
- 新增分支：扫描结果为 URL 且 path=`/qrl` 且带 `t` 参数 → 手机端确认流程：
  1. 发 `msg_type:71 {action:'scan', qr_id:t}` → 收 ok 回执
  2. 弹自绘确认弹窗（禁系统弹窗）：「扫码登录」+ 当前账号头像/昵称 +「确认在 PC 端登录此账号？」+ platform 文案 + [取消] [确认登录]（主题色主按钮）
  3. confirm → 回执 ok → toast「已确认，请在电脑上查看」关弹窗；cancel → 发 cancel
  - 71 回执监听：socket 消息分发表加 case（qr.js 内注册或 chat.js 转发）

### 9. `im-client/web/css/style.css` + `i18n/zh-CN.json` / `en-US.json`
- 扫码登录 UI 样式（全部用现有主题色变量 + 自绘滚动条惯例）
- 新词条约 12 条（扫码登录/请使用手机APP扫一扫/已扫描，请在手机上确认/二维码已过期，点击刷新/确认登录/已确认等）

## 安全要点
- qr_id 与登录码均一次性 + 短 TTL；poll 不泄露用户名；确认者身份=手机 WS 登录态；create 限频防刷；71 帧要求已登录连接

## 影响面
- PC/WEB/APP 均为前端+服务端改动，**APP 无需重新编译**（扫码与确认都在 webview 内）
- 账号密码登录链路零改动（仅 handleLogin 入口加前缀分支），存量用户无感
- 手机端扫码加好友功能不受影响（handleResult 协议串分支保留在前）

## 验证方案（MuMu + 本地服务端实测）
1. 切本地测试配置（capacitor/web 指向 localhost:2087），编译运行 im-server
2. PC 浏览器打开登录页 → 切「扫码登录」→ 二维码出现
3. MuMu APP 登录账号 A → 扫一扫扫 PC 二维码 → PC 变「已扫描」→ 手机弹确认页（头像+昵称）→ 点确认 → PC 自动登录为 A，聊天列表正常
4. 异常路径：手机点取消（PC 回 waiting 可重扫）；等 2 分钟过期（置灰+刷新）；刷新后旧码 poll 返回 expired；登录码用过二次 poll 返回 used 不再登录
5. 回归：账号密码登录 tab 正常；手机扫加好友二维码正常；PC/WEB/APP 在线多端消息正常
6. 测完还原生产配置重编译，汇报远程同步清单（服务端 4 文件 + web 6 文件）
