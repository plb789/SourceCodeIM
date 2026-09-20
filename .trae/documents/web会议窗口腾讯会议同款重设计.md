# WEB 视频会议窗口重设计（腾讯会议同款）

## Context

当前会议窗（WEB iframe / PC BrowserWindow 同源实现）固定 1100×700 且不可拉伸，布局为 √n 列等分宫格——共享屏幕时画面被压进等大瓦片里，看不清内容。用户要求重设计为腾讯会议同款：**共享画面占主舞台大区域，参会者摄像头变右侧缩略图，窗口更大且可缩放/全屏**。

## 现状关键位置

- 窗口尺寸：`im-client/pc/main.js` L1143 `callWindowSize()`（会议视频 1100×700）、L1159 `resizable:false`；WEB 端 `im-client/web/js/web-call-bridge.js` L30 `frameSize()`（同 1100×700）、L39 `.wcb-frame` 居中浮动 iframe
- 布局：`im-client/web/js/call-page.js` L672 `renderMeetGrid()`（√n 列 flex 宫格）、L691 `buildMeetTile()`；CSS 在 `im-client/web/call-window.html` L234-275（`.meet-wrap`/`.meet-grid`/`.meet-tile`）
- 共享屏媒体面已通（replaceTrack 换轨，远端 ontrack 即见屏幕画面），缺的只是「谁在共享」的全员一致视图 + 舞台布局

## 方案（5 个文件）

### 1. 共享状态信令（`im-server/server/meet.go`）

新增 `meet_share` 动作：共享开启/关闭时广播。`HandleCallSignal` 加 `case "meet_share"` → 校验发送者是房间成员（复用 `meetRelayMedia` 的成员校验模式）→ 转发给房间内**其他所有成员**（帧 `from_user=共享者`，content `{action:'meet_share', call_id, on:true/false}`）。~20 行。

### 2. 舞台布局（`im-client/web/js/call-page.js`）

- 新状态：`st.members[u].sharing`（远端共享中）、`st.stageUser`（主舞台目标，默认最新共享者）
- `toggleMeetShare`/`stopMeetShare`：开启/关闭时上行 `meet_share` 信令（on/off）
- `meetOnSignal` 加 `case 'meet_share'`：更新成员共享标记；开启则抢舞台，关闭且是舞台目标则切回宫格或下一个共享者；触发重渲染
- 渲染拆双模式（入口统一 `renderMeetStage()`）：
  - **无人共享** → 现宫格（`renderMeetGrid` 原样保留）
  - **有人共享** → 主舞台（共享者当前流，`object-fit:contain` 居中占满剩余空间）+ 右侧竖排缩略图列（全部成员，宽 ~168px 固定；共享者缩略图即其屏幕画面小图——Mesh 单流架构拿不到其摄像头轨）
  - 缩略图点击 → 切换主舞台目标（多人同时共享时可手动切换）
  - 自己共享时主舞台显示自己屏幕（复用现有 `(sharing&&screenStream)?screenStream:st.local` 逻辑）
- 全屏：主舞台双击 / 右上角按钮 → `document.documentElement.requestFullscreen()`（Esc 退出）

### 3. 样式与骨架（`im-client/web/call-window.html`）

- `.meet-wrap` 改 flex：`.meet-main`（flex:1）+ `.meet-side`（缩略图列，仅共享时显示）
- 主舞台/缩略图样式沿用现有 `.meet-tile` 视觉（圆角/边框/深色底），主题色关联现有变量
- 缩略图超高需滚动：按项目规则用**自绘悬浮滑块滚动条**（复用项目现有自绘滚动条样式，禁系统默认）
- 顶部栏加全屏按钮

### 4. 窗口加大 + 可缩放（`im-client/pc/main.js`）

- `callWindowSize()`：会议视频 1100×700 → **1280×800**（语音会议 420×620、1v1 各形态不动）
- 会议形态 `resizable:true / maximizable:true`（复用 `ensureCallWindow`，按 `isMeet` 调 `setResizable`；1v1 保持微信同款固定窗）；尺寸 clamp 不超屏幕工作区（复用 L1154 workArea 逻辑）

### 5. WEB iframe 同步（`im-client/web/js/web-call-bridge.js`）

- `frameSize()` 会议视频同步 1280×800，clamp 不超 `innerWidth/innerHeight - 40`
- iframe `allow` 加 `fullscreen`（Fullscreen API 需授权）；`.wcb-frame` 加 max-width/max-height 100vw/100vh 兜底

## 不影响范围

- 1v1 通话窗（860×620 固定，微信同款）零改动
- 语音会议（头像宫格 420×620）零改动
- 共享屏媒体面（黑帧占位/replaceTrack 链路，阶段一百四十九成果）零改动

## 验证

1. `go build -o bin/im-server.exe .` + `go test ./server/ -count=1`（im-server 根目录）
2. JS 语法 `node --check` + 两文件 UTF-8 无 BOM 校验
3. 实测（浏览器双账号）：
   - 无共享 → 宫格模式正常（回归）
   - 任一方共享 → 主舞台大幅显示共享画面 + 右侧缩略图；双击/按钮全屏；Esc 退出
   - 停止共享 → 自动回宫格；多人先后共享 → 舞台切换 + 缩略图点击切换
   - 对端视角同步（meet_share 信令生效）
   - PC 端：会议窗可拉伸/最大化，1v1 窗仍固定
4. 回归确认：1v1 界面、语音会议、会议邀请/超时/取消通知（阶段一百四十九/一百五十）均不受影响
