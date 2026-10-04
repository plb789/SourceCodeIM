# APP 远程控制：迁入个人资料页 + 布局重构 + 控制层浮动工具栏

## Context（背景与目标）

用户诉求：把手机版 APP 的"远程控制"入口收进个人资料页，并重新设计远程布局，让手机端控制更人性化。

现状问题（已实测确认）：
1. 远程控制同时存在底栏 tab（index.html L251）与个人页条目（L966），入口重复；底栏已有 5 个 tab，拥挤。
2. **移动端远程控制实际不可用**：个人页条目走 `data-target-tab` 转发（mobile.js L744-752）→ `exitChat()` 退回列表视图 + 点侧栏 tab。但 `#rc-view` 是挂在 `.main-chat` 内的 absolute 覆盖层（style.css L18734-18741），列表视图下 main-chat 平移到视口外——用户点"我的电脑/远程控制其他电脑/控制记录"子页时整页在屏幕外（与网盘阶段二百零七修复前同款缺陷）。
3. 手机端进入后默认"连接页"（手动输 ID+验证码，rc-panel.js L322），而"我的电脑"列表里已有设备 ID+动态验证码，多一步手动输入不合理。
4. 实时控制层（rc-mobile-view.js）纯手势操作，无显式左/右键、滚轮、组合键入口，误触后难纠正。

用户已确认的方案决策：
- 首页布局：**设备卡片优先**（向日葵/ToDesk 手机版同款）
- 实时控制层：**加浮动工具栏**
- 底栏图标：**隐藏，仅保留个人页入口**

## 改动一：入口收口到个人资料页

1. **style.css**（L5151-5155 分组）：`html.m .nav-icon[data-tab="rc"] { display:none; }` 加入隐藏组（与公告/网盘同策略）。
2. **style.css**：`html.m #rc-panel { display:none; }` —— 移动端不再使用侧栏 3 入口面板（子页导航改由 rc-view 内部承担）。
3. **mobile.js**（L738-764 `.mpc-actions` 转发处）：`data-target-tab="rc"` 特判——不 `exitChat()`，改为 `enterChat()` 后点 tab（tab 按钮 display:none 仍可程序化 click，chat.js L7679-7684 会调 `IMRC.open()`）。与 drive 阶段二百零七桥接同思路（mobile.js L244-262）。
4. **mobile.js**：`#rc-close` 委托——`IMRC.isOpen()` 为 false（已关页）时 `exitChat()`，与 drive L257-258 同款，防退回空聊天页。

## 改动二：移动端远程控制首页（设备卡片优先）

全部在 **rc-panel.js** 内实现（数据/渲染归口不变），**index.html** 在 `#rc-view` 内新增 `#rc-page-home`（位于 `rc-head` 之后）：

```
#rc-page-home（仅移动端）
├─ .rc-home-devices  设备卡片区（复用 renderMine 数据源 GET /api/rc/device/my）
│   └─ 卡片：设备名+在线点 / 设备ID(点击复制) / 大按钮"远程控制"（一键直连）
├─ .rc-home-rows     微信设置式列表行（复用 .settings-home-item 视觉语言 L18609-18636）
│   ├─ 连接其他电脑 → showPage('connect')
│   └─ 控制记录     → showPage('records')
└─ 空态：无设备时提示"请在 PC 端登录本账号注册设备"+ 引导行
```

- **一键直连**：卡片按钮直接 `window.rcConnect(device_id, dyn_code, cb)`（chat.js L21840，内部已含会话占用/通话中互斥校验 L21845-21846）。dyn_code 缺失或剩余 <10s → 跳连接页预填 ID（复用 L207-213 逻辑）。连接中按钮置灰防重复（rcPending 互斥已兜底，UI 同步禁用即可）。
- **rc-head 返回分级**（移动端）：子页（connect/records）→ 返回箭头回 home；home → `#rc-close` 关页。PC 端返回按钮文案/行为不变（"返回聊天"）。
- `open()`（L315-323）：移动端默认 `showPage('home')`；PC 端保持 mine/connect 不变。
- `showPage()`（L93-103）：新增 home 分支；home 页标题"远程控制"；home 复用 `loadMine()` 数据但渲染进 `#rc-home-devices`（`renderMine` 加 `mobileHome` 参数切换卡片模板，PC 模板零改动）。
- 动态码倒计时归零静默刷新逻辑（L183-192）home 页同样生效。

## 改动三：实时控制层浮动工具栏

**rc-mobile-view.js** `ensureDom()`（L32-72）内、`.rc-mv-stage` 之后追加（absolute 叠在 stage 上，DOM 在 video 之外，触摸监听绑在 elVideo 上故工具栏点击天然不触发手势）：

```
.rc-mv-tools（右侧边缘悬浮把手，点击展开/收起工具条）
├─ 左键模式 / 右键模式（切换后下一次点击视频=该键 down+up，head 的 mode 文本同步提示当前模式）
├─ 滚轮上 / 滚轮下（{t:'m',act:'wheel',dy:±400}，被控端 pushWheel 换算≈整格）
├─ 组合键（弹自绘底部面板：Alt+Tab / Win+D / Win / Esc / PrintScreen，
│   序列 down Meta/Alt → down/up 字符 → up，全部走现有 {t:'k',act,code,key} 协议，
│   remote-input.js VK_BY_CODE 已支持；Ctrl+Alt+Del 属安全桌面 SendInput 不可注入，不做）
├─ 键盘（复用现有 toggleKeyboard）
└─ 断开（复用 askClose）
```

- 手势层（L224-292）不动；仅轻点/长按语义受"当前鼠标键模式"变量影响（L281-286 的 `btn: 0` 改为 `btn: curBtn`）。
- 工具栏样式走 CSS 变量跟随主题；半透明深色底 + `env(safe-area-inset-right)` 适配刘海屏。

## 改动文件清单

| 文件 | 内容 |
|---|---|
| `im-client/web/index.html` | `#rc-page-home` DOM 块（L2212 后） |
| `im-client/web/js/rc-panel.js` | home 渲染/一键直连/返回分级/open 分支 |
| `im-client/web/js/mobile.js` | rc 入口 enterChat 特判 + #rc-close 委托 |
| `im-client/web/js/rc-mobile-view.js` | 浮动工具栏 + 鼠标键模式 |
| `im-client/web/css/style.css` | 隐藏组 + home 页样式 + 工具栏样式 |

## 验证（按项目规则全量回归）

1. `node --check` 全部改动 JS。
2. 浏览器窄窗（html.m）：个人页→远程控制→全屏 home；卡片一键直连（需 PC 端在线配合，验证 rcConnect→rc_ok→RCMobileView.open 链路）；子页返回分级；底栏无 rc tab。
3. PC 端：侧栏 rc 面板/三子页/设备卡片行为与改前一致（回归）。
4. 控制层：工具栏展开/收起、左/右键模式、滚轮、组合键注入到 PC 被控端生效（remote-input.js 日志确认）；手势不误触；断开确认弹窗正常。
5. 主题切换：home/工具栏颜色跟随；无系统弹窗；滚动条为全局自绘悬浮样式。
6. 性能/稳定性：home 仅多一个定时器复用现有 codeTimer，无新增轮询；工具栏纯 CSS/DOM 无额外资源。

## 风险与对策

- dyn_code 过期竞态：一键直连前校验剩余 ≥10s，否则预填跳连接页。
- 移动端 tab 按钮 display:none 后 chat.js switchTab 仍可达（程序化 click），与公告/网盘同机制，已验证可用。
- 工具栏与软键盘同时弹出挤压画面：工具栏 bottom 值在 kb 可见时上移（CSS class 联动）。
