# 远程面板增强：历史一键直连 + 用户自定义远程卡片

## Context

远程控制面板（向日葵同款）目前每次连接都要手输设备ID+验证码，且动态码仅 5 分钟有效，重复连接繁琐。用户需求：
1. "我的电脑"页增加**历史访问记录**，点一下直接重连（免输 ID/码）
2. 用户可**自定义远程卡片**（设备ID+备注名），存服务端三端同步
3. PC 端"我的电脑"设备卡片**一键直连**（自动取最新动态码，手机首页 homeQuickConnect 已有同款逻辑）

已确认的方案决策（AskUserQuestion）：
- 免密直连采用 **同账号自动取码 + 跨账号信任机制**（静态密码成功连接一次后服务端自动记录信任对，之后免码直连；被控端可查看/移除信任名单）
- 卡片存储在**服务端**（与 /api/rc/* 数据归口一致）

## 安全设计要点（不可妥协）

- **动态码绝不建信任**：仅静态密码（static_pw）验证成功才建信任对。动态码 5 分钟有效且"看到即可用"，若建信任会把一次性窥视升级为永久权限（提权漏洞）
- **信任预查在验证码之前**：命中信任对直接放行、不进入验证码流程（含爆破锁检查）——防止攻击者故意输错码触发设备锁定，把真实账号主人也挡在门外
- **同账号自控不建不查信任**：自身连自家设备靠客户端自动取动态码
- 新接口全部走既有 guardRC 鉴权（X-Drive-Token）
- rc_error 帧新增 `err_code` 字段为增量兼容，旧客户端忽略

## 一、服务端（im-server，Go）

### 1. 数据层
- `im-server/model/model.go`（Device/RemoteLog 同文件，跟随 TableName 惯例）追加两表：
  - `RemoteTrust`（表 `im_remote_trust`）：owner_username + device_id + controller_username（三者组合唯一索引）+ create_time
  - `RemoteCard`（表 `im_remote_card`）：username + device_id（组合唯一索引）+ remark（≤32字符）+ create_time
- `im-server/store/mysql.go` AutoMigrate 列表（约 L99）追加两个模型

### 2. rcVerifyCode 返回匹配方式
- `im-server/server/remotedevice.go` L227：返回值改 `(ok, locked, via string)`，via = "dyn"/"static"/""；唯一调用方在 remote.go L303

### 3. remoteRCConnect 校验顺序（remote.go L274-388）
1. 格式/锁定检查（不变）→ 2. 设备查找（不变）→ **3. 信任预查**：查 `RemoteTrust{owner=dev.Username, device_id, controller=from}`，命中跳过验证码 → 4. 未命中走 rcVerifyCode（不变）→ 5. 通过且 `via=="static"` 且 `from != dev.Username` 时 FirstOrCreate 信任对
- `remoteSendError`（remote.go L130）加可选 err_code 参数（variadic，旧调用点不动）；免码尝试未信任时回 `err_code: "need_code"`

### 4. 新 API（remotedevice.go，RegisterRCRoutes L305 追加，全走 guardRC）
| 路由 | 说明 |
|---|---|
| GET `/api/rc/trust` | 我的设备的信任名单（JOIN im_device 补设备名） |
| POST `/api/rc/trust/remove` | `{device_id, controller}`，仅 owner 可删 |
| GET `/api/rc/card/list` | 我的卡片，JOIN 设备表补 device_name/online/trusted |
| POST `/api/rc/card/add` | `{device_id, remark}`，校验 ID 格式+设备已注册，重复添加=改备注 |
| POST `/api/rc/card/remove` | `{device_id}` |
| GET `/api/rc/visits` | 历史访问：im_remote_log 派生查询（mode=rc AND requester=me AND status=connected AND device_id<>''，GROUP BY device_id 取 MAX(create_time)+COUNT，LIMIT 50），补 device_name/online/trusted |

无新增 config 项（开关复用 rc.disabled），无需同步 config - linux.yaml。

## 二、客户端（im-client/web）

### 1. chat.js（信令层）
- L21866：删除 `if (!code)` 拒绝——允许空 code 发起（信任直连，服务端归口校验）
- L22005：error 回执回调透传 err_code：`rcPending.cb(false, p.reason, p.err_code)`

### 2. rc-panel.js（面板逻辑，版本 bump ?v=1.1）
- 通用直连 `quickConnect(id, cb)`：`rcConnect(id, '', cb)`；收到 `need_code` → 跳连接页预填 ID + 状态条提示"该设备未信任此账号，请输入验证码"
- **一键直连**：renderMine 的"连接此设备"改走 homeQuickConnect 同款（用卡片上的动态码，剩余<10s 或离线才回退预填）
- **信任名单**：本机设备卡片加"信任名单"按钮，卡内展开列表（复用 rc-pw-form 内嵌展开交互），行=控制方账号+移除按钮
- **我的卡片区块**：mine 页底部（手机 home 页同步）渲染卡片网格，含添加表单（设备ID+备注，页内自绘）、连接（quickConnect）、删除
- **历史访问区块**：visits 列表（设备名+最后时间+次数+在线点），点击 quickConnect
- showPage 增加 mine/home 的数据加载钩子

### 3. index.html（版本不变，rc-panel.js bump 即可）
- rc-page-mine 加 `rc-cards-sec` / `rc-visits-sec` 容器；rc-page-home 加 `rc-home-cards` / `rc-home-visits` 容器（空壳，JS 渲染）

### 4. style.css（bump ?v=3.56）
- rc- 样式区段（L18749-18858）尾部追加：卡片区块网格、添加表单、信任列表行、历史访问行；全部走现有 CSS 变量主题色，复用 rc-device-card/rc-tb-btn 模式

### 5. chat.js 版本 bump
- index.html：`chat.js?v=3.170`

## 部署

1. 服务端：`Go一键编译-Windows.bat` → `im-server/bin/im-server.exe`，重启服务
2. WEB：同步 `rc-panel.js`、`chat.js`、`index.html`、`style.css` 到服务器 web 目录
3. PC 客户端无需重打包（改动全在服务器下发页面；chat.js/主页共用文件由服务器加载）

## 验证清单（两端实测）

1. 同账号一键直连：我的电脑页点"连接此设备"→ 免输码直接接通
2. 跨账号首次连接：连接页输**访问密码**成功 → 服务端建信任对
3. 跨账号再次连接：历史访问/卡片点击 → 免码直连
4. 动态码连接**不**建信任：输动态码成功后，下次点击仍需输码
5. 被控端信任名单：查看/移除后，对方再连需重新输码
6. 卡片增删改：添加→列表显示（在线状态/信任标记）→ 删除
7. 历史访问：成功连接后列表出现该设备，按最后时间倒序
8. 爆破锁定仍生效：连续输错 5 次锁定；信任账号不受锁定影响
9. 手机端：home 页卡片+历史区块可用；未信任时正确回退到输码页
10. 回归：好友协助（invite/accept）、通话、既有控制记录页不受影响

## 风险点

- 在线判断是账号级（hub.HasPC）：多 PC 账号下目标机可能实际离线，靠既有 20s 超时兜底，UI 文案标注"账号在线"
- 信任预查每次连接多一次索引查询，量小无碍；移除信任即时生效（不缓存）
- visits 派生查询依赖 im_remote_log 已有数据，老记录（如有 device_id 为空）已被条件过滤
