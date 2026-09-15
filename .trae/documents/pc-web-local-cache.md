# PC 客户端网页资源本地缓存 + 自动增量更新

## Context（背景）

PC 客户端（Electron，`im-client/pc`）目前每次都从服务端 `http://127.0.0.1:8888/` 拉取整个页面，且服务端对所有静态资源强制 `Cache-Control: no-cache` 回源校验（im-server/main.go:114-122，历史原因为防发版后客户端用旧缓存）。每次打开/切换页面，几十个 js/css/字体/monaco 分片文件都要逐个回源往返，页面打开与切换感觉慢。

方案（用户已选定 B）：网页代码资源本地缓存 + 启动时按服务端资源清单增量更新；自定义协议 `app://local` 加载页面，静态资源读本地磁盘（毫秒级），动态请求（API/上传/下载/OnlyOffice）仍代理到服务端，服务端仍是资源归口。快照随安装包内置保证首次启动即秒开。

已确认的前端依赖事实：
- 前端仅 `web/js/socket.js:101-102` 从 `location.protocol/location.host` 推导 WebSocket 地址，其余全部相对路径（fetch('/api/...')、iframe 相对 src、window.open('/image-viewer.html')），换协议后由 handler 代理自动兼容，零改动。
- 文档在线编辑 OnlyOffice 用外域 http api_url 加载脚本/iframe；页面大量用 `navigator.clipboard`（需 secure context）→ 协议必须注册 `secure:true`，同时需放开混合内容。
- `static/` 子树（avatar/upload/_git_extract + ~400MB 工具链 zip）全是用户数据/大文件，绝不进缓存与清单。

**用户决策**：升级后首次启动自动迁移旧 origin（http://127.0.0.1:8888）的 localStorage（im_auth 登录态、主题偏好等）到新 origin（app://local），用户无感知。

## 实施步骤

### 1. 服务端：资源清单接口（新文件 `im-server/server/webmanifest.go`）

- `func (s *Server) HandleWebManifest(w http.ResponseWriter, r *http.Request)`：`GET /api/web-manifest`，无鉴权（与静态文件同级）。
- `filepath.WalkDir(s.cfg.WebDir)` 遍历：路径段含 `static` 即 `fs.SkipDir`（整个子树排除）；跳过 `.git`、隐藏目录；仅收文件。
- 条目 `{p: 斜杠相对路径, s: size, t: mtimeUnix}`；`version = sha256(规范化清单 JSON) 前 12 位`。
- 响应：`{version, files:[...]}`，`Cache-Control: no-cache`，中文注释，UTF-8 无 BOM。响应写法参考同包 `adminJSON`（server/adminkb.go:27）。
- 注册：main.go 在 `/api/` 路由区（约 95 行后）加 `http.HandleFunc("GET /api/web-manifest", srv.HandleWebManifest)`。

### 2. 客户端：缓存与同步模块（新文件 `im-client/pc/web-cache.js`）

命名与结构对齐现有模块（browser-manager.js / toolchain-manager.js），中文注释。

- `init({ serverUrl })`：缓存目录 = `path.join(app.getPath('userData'), 'webcache')`；快照目录 = `app.isPackaged ? path.join(process.resourcesPath, 'web-snapshot') : path.resolve(__dirname, '..', 'web')`。
- `sync()`（总超时 4s，try/catch 全静默，中文日志）：
  1. `net.fetch(SERVER_URL + 'api/web-manifest')` 取远端清单；
  2. 读 `webcache/manifest.json` 本地清单比对（size+mtime，文件存在性校验）；
  3. 差异文件并发 4 下载到 `tmp` 再 `rename` 原子替换；服务端已删文件同步删除本地；
  4. 写新 `manifest.json`。任一步失败静默保留旧清单（代理兜底覆盖运行期缺口）。
  - 注意：快照只读、缓存只存增量（首启无需整目录拷贝，命中顺序 缓存→快照→代理）。
- `registerProtocol(protocol)`：app ready 后对 defaultSession `protocol.handle('app', handler)`。
- `handler(req)` 三级回退，`new URL(req.url)` 取 pathname：
  1. 动态前缀（`/api/ /upload/ /export/ /doc/ /agent/ /static/upload/ /static/avatar/ /static/_git_extract/`）→ `net.fetch(SERVER_URL + pathname + search)` 流式透传（`/ws` 不经此处，WebSocket 不走 protocol handler）；
  2. 缓存目录命中 → `net.fetch(pathToFileURL(p))`（自动 MIME/流式；若 Range 实测不支持，兜底手动解析 Range 返回 206 流）；
  3. 快照目录命中 → 同上；
  4. 都没有 → 代理服务端（兜底：工具链 zip 等大文件、清单遗漏）。
  - 响应统一补 `Cache-Control: no-cache`（页面刷新仍拿最新本地文件，语义与现状一致）；404 返回 `new Response(null, {status:404})` 不抛异常。
- `migrateLegacyStorage(mainWindow)`：仅首次（userData 下 `webcache/.migrated` 标记）：
  1. 隐藏 BrowserWindow 加载 `SERVER_URL + '__legacy_storage__'`（服务端 404 纯文本页，origin 仍是 http://127.0.0.1:8888，localStorage 可用）；
  2. `executeJavaScript('JSON.stringify(Object.entries(localStorage))')` 读全量；
  3. 再用隐藏窗口加载 `app://local/__legacy_storage__` 写入 `localStorage.setItem`；
  4. 写标记文件，关闭窗口。失败静默（退化为用户重新登录一次）。

### 3. 客户端：main.js 接线

- 顶部（app ready 前，约 16 行 require 后）：`protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true, supportFetchAPI:true, stream:true, codeCache:true}}])`。
- `app.whenReady()`（约 1066 行）内、`createWindow()` 前：`webCache.init(...)` → `webCache.registerProtocol` → `await webCache.sync()`（内部自带 4s 超时）→ `webCache.migrateLegacyStorage()`。
- 页面加载地址替换（原代码注释保留）：
  - main.js:72 `mainWindow.loadURL('app://local/')`
  - main.js:291 `viewerWin.loadURL('app://local/image-viewer.html')`
  - main.js:982 `panelWin.loadURL('app://local/tray-panel.html')`
  - main.js:1082 `browserManager.setViewerUrl('app://local/file-viewer.html?v=131')`（仅非空校验用，同步改保持一致）
- **保持不动**：main.js:703 `compilerManager.setServerBase(SERVER_URL)`、browserManager 的 http/https 白名单（外网浏览标签）、Ctrl+R/F5 刷新逻辑（reload app:// 即重读本地最新）。
- 主窗口 webPreferences：加 `additionalArguments: ['--im-server-url=' + SERVER_URL]` 与 `allowRunningInsecureContent: true`（OnlyOffice 外域 http 脚本/iframe 与外链 http 图片；实测无效再叠 `app.commandLine.appendSwitch('allow-running-insecure-content')`）。

### 4. 客户端：preload.js + socket.js（WS 地址修复）

- preload.js：解析 `process.argv` 中 `--im-server-url=`，在 `contextBridge.exposeInMainWorld('desktop', {...})` 增加 `serverOrigin` 字段。
- socket.js:101-102：优先 `window.desktop && window.desktop.serverOrigin` 推导 `ws(s)://host:port/ws`；无则走原逻辑（Web/手机端不受影响）。原代码注释保留。

### 5. 打包：内置快照

- `pc/package.json` build.extraResources 增加 `{ "from": "bundled/web-snapshot", "to": "web-snapshot" }`。
- `pc/build.bat`（GBK 编码，新增 echo 用英文防乱码）在 [4/5] electron-builder 前插入：
  `robocopy "%~dp0..\web" "%~dp0bundled\web-snapshot" /MIR /XD static .git /XF *.zip`
  注意 robocopy 0~7 均为成功码，判定须 `if errorlevel 8`。

## 关键风险与待实测项

1. `net.fetch(file://)` 的 MIME 与 Range（audio seek 206）行为 — 实测，不支持则手动 206 流兜底。
2. `allowRunningInsecureContent`（webPreferences vs 命令行开关）在 Electron 28 的实际生效性 — 实测 OnlyOffice 与外链图片。
3. OnlyOffice 编辑 iframe 内 `/doc/callback` 回源是否受 app:// referer 影响 — 实测。
4. origin 变化导致 localStorage 隔离 → 已定自动迁移方案（步骤 2）；迁移失败兜底为重新登录。
5. 打包后 `process.resourcesPath` 路径解析 — 实测 NSIS 安装版。

## 验证清单

1. 服务端：`go build` 后启动，`curl http://127.0.0.1:8888/api/web-manifest` 返回清单（确认无 static/ 条目、version 稳定）。
2. dev（`npm start`，需先启动 im-server）：登录/WS 重连、消息收发、图片消息与查看器、文件上传下载、iframe 文件预览、monaco 编辑、AI Excel 导出、工具链 zip 下载（走代理兜底）、Ctrl+R 刷新。
3. 升级场景模拟：在旧版（http 加载）登录并设置主题 → 换新版启动 → 验证免登录、主题保留、`webcache/.migrated` 生成。
4. 增量同步：改 web 下一个 css/重启服务端 → 客户端重启 → 日志显示仅下载该文件、页面生效。
5. 断网启动：禁用网络适配器 → 客户端仍从缓存/快照秒开（登录态可用、历史不可连属正常）。
6. 打包验证：build.bat 后 `im-client\bin\im-client.exe` 全新目录首启（快照基线秒开）+ 二启增量。
