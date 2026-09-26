# 网盘分享页改 123 云盘风格（含文件夹浏览 + 批量勾选保存/下载）实施计划

## Context

用户要求把 `/s/<code>` 分享落地页从"单卡片式"改造成 123 云盘风格（截图参照）：顶部导航栏 + 分享者信息条 + 主操作按钮排 + **文件列表区**（勾选列/名称/大小/时间）。用户已确认做**完整版**：文件夹分享可进入子文件夹浏览、子文件可勾选后批量保存到网盘/批量下载。

现状差距：服务端"一个分享=一个文件/文件夹整体"，无子文件列表接口；前端为单卡片布局。旧单文件分享与聊天卡片链路必须零回归。

## 服务端改动（全部归口 im-server/server/drive_share.go，不新增文件）

### 1. 新增子文件列表接口（核心）
- 路由（L35-43 处追加）：`http.HandleFunc("GET /api/drive/share/children", s.handleDriveShareChildren)`
- `GET /api/drive/share/children?code=&extract=&fid=0`：
  1. 复用 `driveShareLoadAndCheck(r, code, extract)`（L492，分享三态校验+提取码锁定，零改动）——失败回 `{error, need_extract}` 同现有格式
  2. fid 子树校验：新增 `driveShareInSubtree(rootID, fid, owner) bool`——从 fid **向上走 parent 链**（限深 32，与保存 BFS 同款防环），每步查询都带 `owner = sh.Owner`；祖先软删→查不到→false 天然容错。fid=0 表示分享根的直接子项
  3. 查询：`store.DB.Where("owner = ? AND parent_id = ?", sh.Owner, dirID).Order("is_dir DESC, name ASC").Find(&items)`（与 handleDriveList drive.go L155 同款索引查询）
  4. 响应 `{items:[{id,name,is_dir,size,mime_type,update_time}]}`——**不回 object_key/owner/md5**（防泄露）；不 bump view_count（浏览计数仍归 info）

### 2. 下载扩展子文件（改 handleDriveShareDownload L653-684）
- 请求增加可选 `fid`：fid 缺省/0 → 现有整分享行为**原样保留**；fid>0 → `driveOwnFile(fid, sh.Owner)` + `driveShareInSubtree` 校验 + IsDir 拒绝（400"文件夹不支持下载"），preview=1 inline、serveDriveFile 同现有链路
- 下载计数去重键 `driveShareDlShouldCount` 由 `code|ip` 升级为 `code|ip|<fileID>`（60s 窗口内批量下载逐文件计数，preview 不计）

### 3. 保存支持批量勾选（改 handleDriveShareSave L547-649）
- 请求体增加可选 `items?: [fid,...]`（现有 Username/Code/Extract/ParentID 不动）；items 空 → **现有整树保存原样保留**
- items 非空：去重、上限 500；逐个 `driveShareInSubtree` 校验（任一越权 403 整批拒绝）；**冗余跳过**（祖先命中另一选中项则跳过其子树）；顶层项：文件=单条，目录=BFS 其子树；配额 413/同名 409 语义复用；共享 idMap 按 BFS 序落库；成功 bump 一次 save_count
- 重构抽出（纯搬移不改行为）：L582-608 的 node/BFS 收集循环 → 包级 `type driveShareNode struct` + `(s *Server) driveShareCollectSubtree(owner string, rootID uint, maxNodes int)`，整树与 items 两路径共用

### 4. 不改动项
info/view_count、提取码锁定、driveShareToClient、卡片投递、失效三态、serveDriveFile、guardDrive。

## 前端改动

### share.html 骨架（版本号：share-page.js?v=1.6、share.css?v=1.3；style.css 不改不 bump）
保留区：sp-topbar（logo 右加口号 span）、sp-card（仅作为提取码锁定态卡片）、sp-invalid、登录浮层、预览浮层、toast、页脚。
新增 `sp-wrap`（提取通过后显示）：
```
sp-hero（图标 64px + 信息列[名称/元信息/统计] + 按钮排右置[保存到我的网盘|下载|在线预览]）
sp-panel（sp-crumb 面包屑 + sp-batchbar 勾选批量条 + sp-list-head 表头 + sp-list 行区 + sp-empty）
```

### js/share-page.js v1.6
**保留**：T()/TR()、ICONS/kindOf、getAuth 三件套、apiJSON、fmtSize、toast、自绘滑块 v1.5（新列表容器 sp-list 挂 _osbInit）、fetchInfo 提取流程、登录面板与 WS 事件链（IMSocket.connect + LOGIN_RESP/ERROR，'未在线'原文判定）、canPreviewName。
**新增**：
- 导航状态机：`crumbs`（面包屑数组）、`curFid`、`listSeq` 乱序守卫；`loadChildren(fid)` 调 children 接口；`enterDir(id,name)`；面包屑回跳
- 行渲染 `spRowHtml(it)`：`.sp-row > .sp-cell-name(.drive-check + .drive-icon.k-* + 名称) + .sp-cell-size + .sp-cell-time`；目录行点击进入；文件行点击=可预览则 openViewer
- 勾选体系：`selSet`（不跨目录，进目录即清）；表头主勾选框两态 toggle；checkbox click stopPropagation；`updateBatchBar()`（已选 n 项｜保存选中｜下载选中｜取消；选中无文件时下载置灰）
- `openViewer(item)` 泛化签名：item 空回退 shareInfo（hero 按钮）；`shareFileUrl(preview, fid)`——根路径不传 fid 走旧链路，子文件传 `&fid=`
- `doSave` 扩展：selSet 非空带 `items`，否则整树；成功文案区分'已保存到我的网盘（共 {n} 项）'/'已保存选中 {n} 项'
- 批量下载队列（页内精简版）：串行 fetch→blob→a[download]，进度显示'正在下载 {i}/{n}…'并禁用按钮；全目录选中提示'所选项目均不支持下载'；单文件 hero 下载仍 location.href

### css/share.css v1.3（全部既有主题变量，零硬编码色值）
- `.sp-wrap`（min(960px,100%)，面板背景/圆角/阴影同 .sp-card 语言）、`.sp-hero`（flex，≤720px 折行）
- `.sp-panel`：`.sp-crumb` 直接复用 style.css 的 `.drive-crumb/.drive-crumb-sep/.drive-crumb-cur` 类名；`.sp-list-head/.sp-row` 网格 `36px minmax(0,1fr) 110px 170px`（对齐主程序 .drive-columns 比例）
- **勾选框常显覆盖**：`.drive-check` 默认 display:none（style.css L14763）→ 加 `.sp-list-head .drive-check, .sp-row .drive-check { display:inline-flex }`，选中态样式直接继承
- 复用主程序类：`.drive-check`、`.drive-icon.k-*`（style.css L13889 色板）、`.drive-crumb` 系、`.osb-thumb/.sb-show`
- 响应式：≤560px 隐藏时间列、hero 纵排、批量条按钮换行

### 交互矩阵（要点）
- 未提取：仅 sp-card 提取行 + 顶栏（现有逻辑不变）
- 文件夹分享·已提取：hero **无下载/无预览按钮**（整树无下载语义），保存=无勾选存整树/有勾选存选中；预览走文件行点击
- 单文件分享·已提取：hero 下载/预览照旧，列表区仅一行（勾选等价整树）
- 批量下载/保存均**免登录**可发起（保存时服务端 driveCheckUser 拦截→登录浮层→自动补发，现有链路）

## i18n
新增词条约 12 条（口号/表头/空态/批量条/下载进行中/保存选中文案）同步 zh-CN.json / en-US.json；i18n.js PACK_VER 3.1→3.2。服务端文案（403"无权访问该目录"等）前端 TR() 反查登记。

## 风险与回归点
1. 旧单文件分享/聊天卡片：save 无 items、download 无 fid 走原路径——回归必测卡片气泡详情→保存/下载全链路
2. 下载计数键升级属有意修正，注释写明统计口径
3. children 每次请求全量走提取码校验，**禁止缓存/绕过**（同 code|ip 锁定计数器天然覆盖）
4. 分享者删子文件：children 空 + 下载/保存服务端文案 toast(TR)，前端不自行兜底枚举
5. openViewer 泛化后单文件根路径仍走无 fid URL（旧 MinIO 对象 MimeType 兜底依赖原记录）
6. 安全：所有新查询带 owner 条件；fid 校验前置；响应不含敏感字段；无新增依赖

## 验证
1. 编译 im-server → bin/im-server.exe 并启动（MinIO 需在线）
2. curl 序列（dstest01 造目录树 A/B/文件 + 带提取码分享）：children fid=0/子目录/越权 403；错误提取码×5 锁定；download fid 文件/目录 400/preview inline；save items 未登录 401→登录后 saved 计数→重复 409
3. 浏览器实测 /s/<code>：提取→列表布局→进目录→勾选→批量保存（登录浮层→自动补发）→批量下载串行→行点击预览（office/图/文本/pdf）→面包屑回根→空目录→失效三态→旧单文件分享回归→375px 窄屏→console 零错误
4. 服务端文件回归：serveDriveFile 老链路 + guardDrive

## 关键文件
- e:\SourceCodeIM\im-server\server\drive_share.go
- e:\SourceCodeIM\im-client\web\share.html
- e:\SourceCodeIM\im-client\web\js\share-page.js
- e:\SourceCodeIM\im-client\web\css\share.css
- e:\SourceCodeIM\im-client\web\i18n\zh-CN.json、en-US.json（+ js/i18n.js PACK_VER）
