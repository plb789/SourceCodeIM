# 后台在线账号管理（在线列表 / 端标记 / 踢下线 / 封禁）

## Context
用户要求在管理后台新增"在线账号管理"：显示已登录账号、IP、端标记（WEB/PC/APP），并支持踢下线、封禁等管理操作。

调研结论（可行性）：**全部可行，且大部分设施已存在**——
- hub（[hub.go](e:\SourceCodeIM\im-server\server\hub.go)）维护 `clients map[username]map[*Client]bool` 多端在线结构；`platformName()` 已归一化端型：`pc→PC`、`web→WEB`、`app/''→手机`、`share→分享页`
- 封禁/解锁已有完整链路：`PUT /admin/api/users/{username}/lock`（[adminaccounts.go L183](e:\SourceCodeIM\im-server\server\adminaccounts.go)），写 `status/lock_reason` + `kickUserConnections` 即时踢出全部连接（含集群总线尽力送达）
- admin 路由体系与前端 admin.html/js 完备（`adminGuard` 鉴权、`api()` 封装、`openEditModal` 自绘弹窗、showToast、账号管理页表格模板 L365-404）

缺口只有两个：**Client 未存 IP**、**无在线列表查询接口/页面**。

## 改动

### 服务端（im-server）

1. **Client 加 ip 字段**（[client.go](e:\SourceCodeIM\im-server\server\client.go)）
   - `Client` struct 加 `ip string`；`newClient` 加参数 `ip string`（调用点仅 server.go HandleWS 一处，传 realIP）
2. **Hub 加快照方法**（hub.go）
   - `Snapshot()`：加锁遍历 `clients`，返回 `[]OnlineConn{Username, Platform, IP, LoginTime}`（LoginTime 用现有 `client.loginTime`，登录时赋值；零值则回退 `createdAt`）
3. **新建 adminonline.go**（实现归口，仿 adminaccounts.go 风格）
   - `GET /admin/api/online`（`handleAdminOnlineList`）：`hub.Snapshot()` → 批量查 DB `im_user`（username IN ...，取 nickname/status）→ 返回 `{ok, data:{conns:[{username,nickname,platform,platform_name,ip,login_time,status,lock_reason}], total}}`；按上线时间倒序
   - `POST /admin/api/online/kick`（`handleAdminOnlineKick`）：body `{"username":"..."}`，复用 `kickUserConnections(username, "您的账号已被管理员强制下线")`；防自踢（管理员自己不踢，与 lock 同口径）
   - 路由注册进 [admin.go](e:\SourceCodeIM\im-server\server\admin.go) `RegisterAdminRoutes`（`adminGuard` 包裹）
   - 注释写明集群边界：列表为本实例连接；封禁落库全局生效、跨实例踢出为总线尽力送达（与既有 kickUserConnections 口径一致）

### 前端（im-client/web）

4. **admin.html**
   - 侧边导航加 `<button data-view="online">在线账号</button>`（放"账号管理"之后）
   - 新增 `<section id="admin-view-online">`：仿账号管理页（L365-404）——说明文字、工具条（搜索框 + 刷新按钮 + 自动刷新开关）、表格（列：用户名/昵称/端/IP/上线时间/账号状态/操作）、分页可省（在线量可控，直接全量渲染 + 前端搜索过滤）
5. **js/admin.js**
   - 仿 `loadAccounts/renderAccountsTable`（L3119-3184）写 `loadOnline/renderOnlineTable`：10 秒自动轮询（仅 online view 激活时拉取，切走清除定时器）
   - 操作列两个按钮：**踢下线**（confirm 自绘弹窗 → POST kick → 刷新列表）、**封禁/解锁**（复用账号管理页现有 lock 弹窗逻辑与 `PUT /users/{username}/lock` 接口）
   - 端徽标：直接用服务端 `platform_name`（PC/WEB/手机/分享页）
   - NAV_ICONS 补 online 项 Material 图标 path
   - admin.html 引用版本 `js/admin.js?v=1.47` → `v1.48`

## 验证
1. `go build -ldflags "-s -w" -o bin\im-server.exe main.go` + `go test ./server`
2. 重启本地服务（Hidden 窗口，日志 server-out.log）
3. 浏览器实测（http://127.0.0.1:2087/）：
   - kicktest1/pass123 登录主应用（WEB 端）；再用管理员账号打开 admin.html → 在线账号页应显示 kicktest1：WEB、IP 127.0.0.1、上线时间、状态正常
   - 用 WS 脚本模拟 app/pc platform 登录 → 列表出现多端多行
   - 点"踢下线"→ 主应用页被踢回登录页并弹提示、列表刷新后消失
   - 点"封禁"填原因 → 在线列表消失 + kicktest1 重新登录被拒（提示封禁原因）；解锁后恢复登录
   - 回归：账号管理页原有功能（搜索/编辑/锁定）不受影响
