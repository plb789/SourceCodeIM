# QQ同款远程协助功能实施计划（一期 PC↔PC）

## Context

用户希望为 IM 系统增加 QQ 同款远程协助：好友之间可远程连接、查看并操作对方桌面。经调研确认可行且基础良好——项目已有 WebRTC 音视频通话完整基础设施（信令状态机/会话表/话单落库/静默抓屏），传输路线已与用户确认为 **WebRTC P2P**：屏幕流走视频轨（H264 硬编码），鼠标键盘事件走 RTCDataChannel，信令走现有 WebSocket JSON 协议。一期范围：PC端（Electron）↔ PC端 完整互控。

## 已核实的关键事实

| 事实 | 位置 |
|---|---|
| msg_type 已用到 89，**90 空闲**（71 已被群聊占用） | protocol/message.go:L5-142 |
| `setDisplayMediaRequestHandler` 已静默放行主屏，被控端 getDisplayMedia 零新增 | pc/main.js:L1478-1496 |
| 通话信令先例（状态机/超时/话单/忙判定） | server/call.go（msg_type=70） |
| PC 端 WebRTC 建连蓝本 | web/js/call-page.js（buildPC L288、offer L564、answer L589、ICE L306+） |
| 独立窗口+信令队列缓冲先例 | pc/main.js:L1263-1350 ensureCallWindow/callSigQueue |
| PowerShell 常驻进程+stdin 行协议先例 | pc/main.js:L763-820 shotPickerProc |
| 三按钮自绘弹窗 showChoice(title,text,primary,onPrimary,{text,cb}) | web/js/chat.js:L189 |
| 好友校验 isFriend / 在线能力 hub.HasPC | server/friend.go:L247-306 / server/hub.go:L119 |
| 输入栏平铺按钮+caret 下拉先例（meet-btn/shot-btn） | web/index.html:L400-456 |
| 话单表先例 model.CallLog + AutoMigrate | model/model.go:L53-69 / store/mysql.go:L43 |

## 协议设计：msg_type=90

角色语义：请求方按入口决定 `mode`——「请求控制对方电脑」=`control`（请求方为控制方）、「请求对方协助」=`assist`（请求方为被控方）。被控端 accept 时决定最终授权 `grant`：`control`（允许操作）/ `view`（仅观看，可降级）。

| action | 方向 | content 关键字段 |
|---|---|---|
| invite | 请求方→被控方 | session_id(uuid)、mode、from_name、from_avatar |
| accept | 被控方→控制方 | session_id、grant、screen:{w,h} |
| reject / cancel | 被控方→对方 / 请求方→被控方 | session_id、reason? |
| offer / answer / candidate | 双向 | session_id + sdp/candidate（服务端校验参与者后透传） |
| disconnect | 任一方 | session_id、reason? |
| error / timeout / dismiss / ended（服务端生成） | 服务端→相关方 | session_id、reason |

坐标约定：控制端按 `video.videoWidth/Height` 归一化 `(nx,ny∈0~1)` 发事件；被控端 ps1 用 `GetSystemMetrics(SM_C*SCREEN)` 换算为 `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` 绝对坐标——DPI 缩放/多屏差异全在被控端本地消化。

## 服务端：新文件 `server/remote.go`（照抄 call.go 模式）

- 会话表 `remoteSessions map[string]*remoteSession{ID,Requester,Peer,Controller,Sharer,Grant,State,StartAt,AcceptAt,timer,offlineTimer}` + `remoteUserBusy` 忙表
- `HandleRemoteSignal(c, msg)` 入口，`from=c.username` 服务端归口防伪造；action switch 分发
- `remoteInvite` 校验链：目标存在 → **isFriend 好友强校验**（比通话严）→ 黑名单 → 双方在线且 `hub.HasPC`（两端必须 PC 端）→ 忙互斥 → 建会话双侧占忙 → 60s 超时兜底 → 转发
- `remoteAccept/Reject/Cancel/Disconnect`、`remoteRelayMedia`（offer/answer/candidate 透传，照 callRelayMedia call.go:L354-371）、`remoteFinish`（清表→转发结束信令→落库话单；不写聊天信封消息，QQ 同款无气泡）
- 常量：`remoteRingTimeout=60s`、`remoteOfflineGrace=30s`（对齐 call.go）
- **忙互斥 helper**：call.go 新增 `userBusyAny(users...)`（callUserBusy + remoteUserBusy 双表互查），`callInvite` 与 `remoteInvite` 均改用——通话/协助双向互斥
- 话单：model/model.go 追加 `RemoteLog`（表 `im_remote_log`：session_id/requester/peer/mode/grant→列名用 **auth_mode** 规避保留字/status/duration/create_time），注册进 store/mysql.go AutoMigrate
- protocol/message.go 追加 `MsgTypeRemoteSignal = 90`；server/server.go handleMessage（L303 通话 case 后）挂载

## 被控端

1. **屏幕采集**：主窗口渲染层 `getDisplayMedia` 直接可用（handler 已存在）；constraints 建议 `1920×1080 max, frameRate max 15`
2. **引擎**：新文件 `web/js/remote-engine.js`（挂 `window.RemoteEngine`，index.html 引入，避免 chat.js 膨胀）——`startSharer(session, grant)`：getDisplayMedia → buildPC（照 call-page.js）→ addTrack → DataChannel('remote-input') → createOffer 经 chat.js 上行；DataChannel 收注入事件 → `desktop.remoteInputSend(evt)`；`stop()` 收口
3. **确认弹窗**：chat.js `showChoice` 三按钮「接受并允许操作 / 仅观看 / 取消=拒绝」+ WebAudio 响铃（抄 web-call-bridge.js:L186-208）+ 60s 本地兜底
4. **悬浮条**：新文件 `web/remote-bar.html` + 主进程 `ensureRemoteBar/closeRemoteBar`（照 ringWin main.js:L1352-1365：无边框/置顶 screen-saver/skipTaskbar/focusable:false，屏幕顶部居中）；内容=绿点+「昵称正在远程协助你的电脑（可操作/仅观看）」+ 红色断开按钮 → `remote:bar-disconnect`；**创建后 `setContentProtection(true)` 防入镜**（抄 main.js:L1462）
5. **输入注入**：
   - 新文件 `pc/remote-sendinput.ps1`（**注释纯 ASCII**）：Add-Type 编译 SendInput P/Invoke（MOUSEINPUT/KEYBDINPUT）；stdout 首行 `ready` 握手；stdin 行协议——`{"t":"m","act","x","y","btn","dy"}`（归一化→绝对坐标）/ `{"t":"k","act","vk","scan"}` / `{"t":"txt","chars"}`（KEYEVENTF_UNICODE 成对发送，中文/IME 场景）；stdin EOF 自退防孤儿
   - 主进程 `remoteInputEnsure/Stop` 照 shotPickerEnsure/Stop（含 asar 路径替换），单例常驻、会话结束延迟 10s 回收
   - 新文件 `pc/remote-input.js`：`KeyboardEvent.code → Win VK+scanCode` 映射表（JS 侧，白名单），无映射可见字符降级 txt 事件
   - IPC：`remote:input-send`
6. preload.js 暴露：`remoteInputSend / remoteBarOpen / remoteBarClose / onRemoteBarAction / onRemoteSignal / remoteSignalIn`

## 控制端

1. 新文件 `web/remote-window.html` + `web/js/remote-page.js`（照 call-window.html/call-page.js 精简：无音频轨，仅 screen video + DataChannel）
2. 主进程 `ensureRemoteWindow` 照 ensureCallWindow：无边框深色沉浸窗（backgroundColor #161819）；**close 事件转断开语义**（Alt+F4 → 页面先发 disconnect 再销毁）；`remoteSigQueue` 缓冲 + `remote:open/remote:signal/remote:close` IPC 三件套照 callSigQueue 同构
3. UI：video `object-fit:contain` 铺满 + 顶部信息条（对方名+模式标签）+ 底部自绘断开条；letterbox 黑边计算得实际绘制区做归一化坐标
4. 事件节流：mmove 50ms+rAF 合并；mdown/mup 前强制 flush 最新坐标；ktxt 单帧限 32 字符
5. **全局快捷键挂起**：main.js 将 Alt+A/Ctrl+Alt+R/Ctrl+Shift+R（L2292-2311）重构为注册表 + `hotkeySuspend()/hotkeyResume()`（新 IPC `remote:hotkey-suspend/resume`）——控制会话建立挂起、结束恢复，否则按键被本机拦截无法透传
6. Esc 本地消费：弹自绘「断开协助？」确认

## Web 页面改动

- `web/index.html`：input-toolbar 在 meet-btn 后加 `remote-btn`（SVG+caret 下拉，照 meet-caret 先例），下拉两项「请求控制对方电脑 / 请求对方协助」
- `web/js/socket.js`：MSG 注册表追加 `REMOTE_SIGNAL: 90`
- `web/js/chat.js`：按钮显隐（callSupported 同款条件 + 真实好友私聊 + `desktop.remoteInputSend` 存在=仅PC端，AI 会话/群聊隐藏）；菜单点击→`remoteInvite(mode)`；下行 REMOTE_SIGNAL 分发（invite→响铃+showChoice；accept→被控端开悬浮条+startSharer、控制端 `desktop.remoteOpen` 开窗；reject/cancel/error/timeout/disconnect 收口）；控制态信令经 `desktop.remoteSignalIn` 中继
- `web/css/style.css`：remote-btn/caret/下拉样式全部用主题变量 var(--bg)/var(--primary)/var(--shadow-pop)；弹窗复用现有 modal 体系

## 实施步骤（依赖排序，每步验证）

1. **协议+服务端**：90/RemoteLog/AutoMigrate/remote.go/挂载/忙互斥 → `go build`；两账号手测 invite→accept→offer 透传→disconnect→查 im_remote_log
2. **前端信令骨架**：socket.js+chat.js 收发/弹窗/状态机（不含媒体）→ 双端实测五分支（接受/拒绝/取消/超时/忙）
3. **控制端窗口+屏幕流**：remote-window.html + ensureRemoteWindow/remoteSigQueue + remote-page.js 建连 + RemoteEngine.startSharer → 实测看到对方屏幕实时画面
4. **输入注入链路**：ps1+remote-input.js+remoteInputEnsure+preload+控制端捕获节流+被控端 DataChannel 桥 → 实测鼠标移动/左右键/滚轮/中文输入
5. **悬浮条+断开链路**：remote-bar.html+bar 窗+setContentProtection+各断开收口（含 Alt+F4 转断开）→ 实测悬浮条不入镜、断开即时
6. **快捷键挂起+边界分支**：hotkeySuspend/Resume + error/timeout/missed/离线宽限 UI → 实测控制期间 Alt+A 不触发本机截图
7. **全链路回归**：通话↔协助互斥、断线 30s 宽限恢复、话单落库、CPU/带宽/延迟观察、AI 会话/群聊无入口、WEB/手机端无回归

## 风险与边界

- **UAC 提权窗口无法注入**（UIPI 限制，QQ 同样受限）：悬浮条/信息条注明"系统安全窗口无法被远程操作"
- **一期仅共享主屏**（既有 handler 行为）；多屏/非 Windows 注入（Mac Quartz/Linux X11）二期
- 非 Windows 平台按钮降级"仅请求观看"（grant 强制 view）
- 性能：video constraints 1080p/15fps（WebRTC 带宽自适应兜底）、mmove 20Hz、PowerShell 子进程单例+延迟回收
- 安全：好友强校验+黑名单+from 归口；DataChannel 仅会话存续期接受、字段白名单、坐标 clamp 0~1；任一口收口立即停注入/停轨道/关流；ps1 stdin 断开自退
- 实测纪律：WebRTC 建连竞态（remoteSigQueue 回放）、ps1 ready 握手时长、DPI 150% 缩放坐标精度必须实测

## 改动清单

**新增 8**：`server/remote.go`、`pc/remote-sendinput.ps1`、`pc/remote-input.js`、`web/remote-window.html`、`web/remote-bar.html`、`web/js/remote-page.js`、`web/js/remote-engine.js`
**修改 10**：`im-server/protocol/message.go`、`im-server/model/model.go`、`im-server/store/mysql.go`、`im-server/server/server.go`、`im-server/server/call.go`、`im-client/pc/main.js`、`im-client/pc/preload.js`、`im-client/pc/package.json`（asarUnpack 追加 ps1）、`im-client/web/index.html`、`im-client/web/js/chat.js`、`im-client/web/js/socket.js`、`im-client/web/css/style.css`
