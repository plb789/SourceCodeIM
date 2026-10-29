# 游戏内 Overlay 二期：注入式真 Overlay 详细设计（D3D8/D3D9 优先）

> 状态：**M4 发布已完成，二期收官**（2026-10-27：兼容等级名单 `overlay-native/native-games.json`（本地名单起步，mode=list/all，exe 名匹配；名单内走注入链、名单外自动回退一期悬浮窗）+ `isNativeActive(exe)` 按等级判定（native 开关叠加名单，经真实 settings-set 链路单测 6/6 PASS）+ main.js spawn 按游戏 PE 位数选 injector/DLL 套件 + 用户文档《游戏内Overlay使用说明.md》（形态/开关/名单编辑/排障）。设置项「游戏帧内渲染（实验）」已于 M2 就位。真机游戏逐个验证随发布推进（排障指引见使用说明）。二期 M0-M4 全部完成。）
> 里程碑记录：M0 POC / M1 通信 / M2 面板（同日完成，见下）。
> M3 实测踩坑记录（D3D8 适配）：
> 1. **现代 WinSDK 不带 d3d8.h**——用 ReactOS psdk 的 d3d8.h/d3d8caps.h/d3d8types.h 三件套（third_party/d3d8），仅头文件（Direct3DCreate8 走 GetProcAddress，不链 d3d8.lib）；
> 2. **d3d8.h 与 d3d9.h 同 TU 重定义冲突**——hook 主模块用 void* 风格函数指针 + 裸虚表槽位，D3D8 后端独立 TU；
> 3. **D3D8 虚表槽位**（头文件顺序核对）：IDirect3D8::CreateDevice=15、IDirect3DDevice8::Reset=14/Present=15（各比 D3D9 前移一位）；
> 4. **ImDrawVert 不能直拷**——D3D8 固定 FVF 无 vertex declaration，内存序必须 x,y,z,rhw,col,tu,tv 且颜色 R/B 交换（dx9 后端有 declaration + IMGUI_COL_TO_DX9_ARGB 同款转换）；
> 5. **D3D8 严格要求场景内绘制**——场景外 DrawIndexedPrimitive "成功"但被忽略（D3D9 相反：场景外稳定、BeginScene 包裹反而崩，两个 API 结论互斥勿混用）；
> 6. **D3D8 后端必须显式建字体**——dx9 后端在 NewFrame 惰性 CreateDeviceObjects，自写后端漏建则 ImGui::NewFrame 撞 "Font Atlas not built" assert 弹窗阻塞游戏主线程（症状：present hook active 有日志、RenderDrawData 无日志、无异常记录）；
> 7. **测试宿主时序**——d3d8 测试宿主必须在进程启动即 LoadLibrary d3d8.dll（模拟真游戏静态导入），延迟加载会让 create8 调用先于热补丁（注入竞态）；
> 8. ReactOS 头依赖 __MSABI_LONG 宏（非 ReactOS 环境需自定义 #define __MSABI_LONG(x) x##L）；
> 9. **平台增强补丁的虚表替换（真机 War3 1.24+w3plus 实测）**——Cdon 等对战平台的 War3 增强补丁会：①动态加载 d3d8.dll 后 <50ms 即调 create8（已用 LoadLibrary 钩+探针根治竞态）；②整体替换设备实例的 vtable 指针（平台自己的渲染链钩）——槽位级"重打"对抗无效（平台后装且替换实例指针），此类带平台补丁的游戏**不兼容帧内渲染**，名单默认移除走悬浮窗形态；适配需针对平台补丁专项分析（后续持续工作）。另：War3 平台版进程提权运行，外部模块枚举不可读（诊断需靠 DLL 进程内日志）。
> M2 实测踩坑记录（重要）：
> 1. **ImGui 初始化时序死锁**——WndProc 子类化若等"首次激活帧"才装，第一次 Shift+Tab 会被原窗口过程吞掉；必须在 CreateDevice 捕获设备后立即 ImGuiEnsure+InstallWndProcHook；
> 2. **字体码段**——GetGlyphRangesChineseSimplifiedCommon 不含几何图形区（●/○ 显 "?"），需自定义 ranges 补 0x2500-0x25FF；
> 3. **卸载后游戏必死三连**：①虚表还原把 vt[16]=Reset/vt[17]=Present 装反（游戏每帧 Present 调到 Reset，数秒内 d3d9 AV 且日志无痕）；②看门狗线程释放 D3D 资源与在飞设备调用竞态（摘钩收尾必须挪到游戏线程 Present 内一次性执行）；③FreeLibrary 触发 /MT 静态析构链崩（改为逻辑卸载：钩子全摘+DLL 常驻休眠，ImGui 上下文不关停）；
> 4. **场景外渲染**——Present 钩位于游戏 EndScene 之后，实测场景外 RenderDrawData 长期稳定（160s+），BeginScene/EndScene 包裹反而在 ~130s 确定性 d3d9 AV（勿按官方例程改回）；
> 5. **SameLine 后不可直接 Separator**（画进同一行，后续布局错位把输入框推出窗口裁掉）；
> 6. **injector --launch 模式**：真实游戏 pid 经 stdout 首行 "pid:<n>" 回读（主进程 ovReadGamePid → onGamePid 校正 pipe 名），helper 等待游戏退出并透传 exit code（主进程 exit/close 监听语义不变）；
> 7. 测试工具层面：非前台窗口 ImGui 后端以真实光标为准（合成点击需 SetCursorPos 先行）；沙箱/作业对象会在命令结束时清理 Start-Process 子进程（跨命令探活假象）。
> M4 真机踩坑与审计修复记录（2026-10-28）：
> 1. **globalShortcut 系统级先吞 Shift+Tab**——客户端热键比游戏 WndProc 更先拿到按键，DLL 永远收不到 WM_KEYDOWN（弹的是一期悬浮窗）→ 热键让位机制：DLL 面板就绪期注销全局热键，断开/失败收回；
> 2. **连接即让位 = 启动器阶段死键（审计发现）**——启动器型进程（GameCdonl）无 D3D 设备永远走不到 ImGui 初始化，pipe 连接就让位会让启动器阶段 Shift+Tab 全程死键（跟随注入失败时无任何面板）→ 改为 **panel-ready 帧协议**：DLL 在 WndProc 子类化成功（ImGuiEnsure 成功路径）时上报 panel-ready，客户端收到才让位；断线收回、重连后 PipeThread 按 g_panelReady 补发。stub 冒烟 10/10 PASS（连接不让位/ready 让位/就绪期改键位不抢回/断开收回/重连再让位/nopanel 收回/child 建 pipe/退出注销）；
> 3. **DLL 断开后热键不收回（审计发现）**——socket close/error 处理只清引用不收热键，DLL 崩溃/看门狗卸载后 Shift+Tab 死键到游戏退出 → gone 处理补 setNativePanelActive(false)（旧连接被新连接顶替时除外防误收）；
> 4. **就绪期设置改键位抢回热键（审计发现）**——settings-set → registerHotkey 不看让位态 → registerHotkey 加 nativePanelActive 守卫；
> 5. **启动器防 hook 惯例：GetProcAddress 动态解析绕 IAT**（真机 GameCdonl：IAT hooked 成功但无 child 日志）→ 钩 IAT 里的 GetProcAddress，动态解析 CreateProcessA/W、ShellExecuteA/W 时返回钩地址（双覆盖）；
> 6. **启动器第二拉起路径 ShellExecuteA/W**（真机 dumpbin：IAT 含 ShellExecuteA）——ShellExecute 无 CREATE_SUSPENDED 介入点 → 透传后异步轮询 Toolhelp32 进程快照（~20s 上限）按 exe 名补注入（DLL 自带 2 分钟 d3d9 等待窗口，晚注入可达）；mode=all 时仅认 .exe 结尾防误跟 URL；
> 7. **ImGui 初始化失败后 Shift+Tab 仍切换 g_panelActive（审计发现）**——不可见面板照吞游戏输入=输入黑洞 → g_panelBroken 门禁（WndProc 切换与 Present 渲染双处短路）；
> 8. **IAT 换入与原始指针赋值间竞态（审计发现）**——Hooked_GetProcAddress/CreateProcess/ShellExecute 可能在 g_origXXX 赋值前被调 → NULL 兜底直调自身导入（HookIAT 只扫主 exe 导入表，自身 IAT 未被钩，无递归）。
> 二轮审计（对上述修复自身的复查，2026-10-28）：
> 9. **吞输入黑洞（一轮修复引入）**——g_panelBroken 置位后 WndProc 吞输入条件不查 broken：若初始化失败发生在面板已激活帧，g_panelActive 卡 1 且切换已被禁 = 不可见面板永久吞游戏输入 → ReportNoPanelOnce 复位 g_panelActive=0 并补发 panel off 帧 + 吞输入条件加 !g_panelBroken；
> 10. **init 失败后永不恢复（一轮修复引入）**——d3d8 首帧 init 每帧重试，失败→成功后 broken 仍禁切换而 ready 已让位 = 死键 → ImGuiEnsure 成功路径清 broken；
> 11. **重连补发 ready 改走发件箱（一轮修复引入）**——裸 WriteFile（NULL OVERLAPPED 写 FILE_FLAG_OVERLAPPED 句柄）不可靠、失败即丢无重试 → PipePushOut 出队路径，且必须在发件箱清空之后入队；
> 12. **DLL 崩溃时悬浮窗让位标记卡死（一轮修复引入）**——面板开着时 DLL 崩溃，nativePanelOpen 卡 true → showOverlay 让位守卫挡住悬浮窗打不开 → gone 处理补 nativePanelOpen=false；另 FollowNameMatch 补引号容错。既有发现：g_followDepth 从未递增（深度守卫为死代码，防递归实际由"每进程只跟直连子进程"保证，无害保留）。
> 三轮实测排障（2026-10-28 真机 Warface/GameCdonl「按热键什么都不弹」，日志证据链定位）：
> 13. **#endif 错位 = x64 迟加载 d3d9 永不挂钩（根因）**——InitThread 轮询循环里 D3D9 检查被圈进 `#ifndef _WIN64`（#endif 在 D3D9 检查之后），x64 轮询体只剩 Sleep(50)；d3d9host 静态导入 d3d9（注入时模块已在，走注入时模块检查）测试一直正常，掩盖了此缺陷。真 CryEngine 游戏（Warface）运行时动态加载 d3d9.dll → 三道防线全空。修复：#endif 挪到 D3D8 段后，D3D9 迟加载检测双架构生效；
> 14. **渲染器 DLL 才导入 Direct3DCreate9（dumpbin 证实 GameCdonl.exe 导入表无 d3d9.dll）**——Direct3DCreate9 由 CryRenderD3D9.dll（动态加载）导入，原「只钩主 exe IAT」兜底必失败 → HookIAT 重构为 HookIATInModule（按模块）+ HookIATAllModules（EnumProcessModules 枚举全部已加载模块逐个补丁）；同机制对 x86 渲染器 DLL 游戏同样生效；
> 15. **Loader 绑定竞态复检**——全模块补丁若落在「依赖已映射、IAT 未绑定完成」窗口，绑定会覆写回原地址 → 钩子来源标记 g_d3d9HookVia（0=hotpatch/1=主 exe IAT/2=全模块 IAT），仅路径 2 在挂钩成功后 300ms×3 复检重补（hotpatch 路径重补会经 trampoline 造成递归，禁止）；
> 16. **K_WAIT_MODULE_MS 2 分钟 → 10 分钟**——CryEngine 登录/大厅流程加载渲染器可能超 2 分钟（命中即退，非 D3D 进程仅多一个 Sleep 线程）。
> 17. **渲染器动态解析 create9 = IAT 类钩子全部无效（12:14 会话实测）**——修复 14 后全模块 IAT 仍 0 补丁：dumpbin 证实 CryRenderD3D9.dll 静态导入 d3d9.dll 但导入清单**无 Direct3DCreate9**（运行时 GetProcAddress 动态解析）→ 新增 **D3D9 探针**（M3 D3D8 探针同款模式）：自建一次性设备（显式桌面格式、HW VP、g_probeBusy 守卫防自捕获）双挂点——①IDirect3D9 虚表 CreateDevice 槽（捕获游戏后续创建，g_origD3DCreate9 保持 NULL 属正常）；②Device 虚表 Present/Reset 槽（静态表，**对已创建的游戏设备立即生效**）。配套 ImGui 两阶段初始化（Win32 后端+WndProc 前置=探针成功即报 panel-ready；DX9 后端等首帧游戏设备指针），否则首个 Shift+Tab 被原窗口过程吞掉（M2 踩坑 1 时序死锁）。探针 300ms 间隔重试（GPU 未就绪 CreateDevice 被拒，War3 踩坑同款）。
> M5 真机排障（12:23/12:33 会话，探针成功后面板仍不可见）：
> 18. **Present 从未被调（12:33 诊断定论）**——探针全链路成功（设备捕获/ready/让位/WndProc 收键/panel 帧上行全正常）但用户按 6+ 次 Shift+Tab **零 active frame 日志**=游戏每帧不走 Device::Present 槽 17；且引擎建了第二个设备→头号嫌疑 **引擎建设备后整体替换实例虚表指针（w3plus 同款对抗，M3 D3D8 先例）**，次要嫌疑交换链呈现。修复：①**虚表完整性守护**——InitThread 挂钩成功后不再返回，进入守护循环每 2s 比对实例虚表基址（g_vtDevBase），被换表立即在新表重打（PatchDeviceVtableSlots 幂等统一入口：slot 值已是钩则跳过防 orig 自指递归；orig 取当前槽位值，引擎钩链路不中断）；②**隐式交换链 Present 补钩**（GetSwapChain(0) 虚表槽 3，GetDevice 取呈现设备）；③渲染统一 RenderPanelFrame（双钩共用+8ms 同帧去重+诊断+自愈重绑+异常防御）；④Hooked_CreateDevice 改总是捕获最新设备+防重复补丁。
> 教训：**平台对抗是分层的——IAT 挡动态解析、虚表指针替换挡槽位补丁；钩子存活校验必须常驻守护循环而非一次性动作，任何"钩上就完事"的假设都会被平台下一层对抗击穿**。
> 教训：**测试宿主（静态导入）与真游戏（动态加载）的加载时序差异会系统性掩盖轮询类缺陷——x86/x64 双架构必须分别审查条件编译块；IAT 钩只覆盖"导入表里写了名字"的调用，动态解析必须走探针虚表路径**。
> 优先级决策：**D3D8/D3D9 优先**（经典魔兽 3 等平台主力老游戏），D3D11/OpenGL 后续里程碑扩展。

---

# 一、目标与定位

在一期悬浮窗（窗口级 overlay）基础上，二期把 UI **画进游戏渲染帧内**：

1. **独占全屏（Exclusive Fullscreen）游戏可用**——一期悬浮窗被独占全屏绕过，二期在游戏帧内渲染天然无此限制；
2. **Steam 级观感**——UI 与游戏同帧合成，无窗口级悬浮的边缘感；
3. **协议与服务端继续零改动**——DLL 只承担"渲染 + 输入"，所有业务逻辑（好友/房间/信令）仍归客户端主进程，复用一期全部镜像/中继协议；
4. **按游戏逐个适配**——平台自管游戏分发，可控制兼容性并在游戏库标注兼容等级。

**非目标**：不做游戏逻辑修改、不做内存修改、不碰反作弊；DLL 崩溃不得拖死游戏（看门狗硬约束）。

---

# 二、总体架构

```
┌─ 游戏进程（被注入）────────────────────────────────┐
│  游戏逻辑（不修改）                                  │
│      │ d3d9.dll Present/Reset                       │
│      ▼                                             │
│  overlay_hook.dll（C++/MinHook/ImGui）              │
│   ├ Present 尾部：面板激活期渲染 ImGui               │
│   ├ WndProc 子类化：Shift+Tab 检测 + 面板期输入劫持   │
│   └ Named Pipe 客户端 \\.\pipe\im-overlay-<pid>     │
└────────────────┬───────────────────────────────────┘
                 │ JSON 帧（复用一期镜像语义：chat-in/state/state-out）
┌────────────────▼───────────────────────────────────┐
│ PC 客户端主进程（Electron）                          │
│  game-overlay.js 扩展：                             │
│   ├ spawn 改造：CREATE_SUSPENDED → injector.exe     │
│   │   注入 overlay_hook.dll → resume                │
│   ├ pipe 服务端（JSON 帧编解码）                     │
│   └ 帧路由：game-frame 通道 ↔ gn 镜像/中继（已有）    │
│  呈现面三选一（按游戏兼容等级）：                      │
│   游戏帧内渲染（二期）＞ 悬浮窗（一期）＞ 不支持       │
└────────────────────────────────────────────────────┘
```

**关键决策：**

1. **注入方式 = `CREATE_SUSPENDED` + `LoadLibraryW` 远线程**。游戏由客户端 spawn（一期已有 `game:launch` 归口），创建时挂起 → 注入 → 再恢复，无需驱动级/手动映射注入，实现最简、痕迹最小；
2. **Hook 方式 = 设备虚表（vtable）hook**：从 `IDirect3DDevice9` 虚表取 `Present`/`Reset` 地址打 MinHook——D3D9 全版本稳定；`Reset` 必须同钩（设备丢失/全屏切换后重建渲染资源）；D3D8 为独立适配层（接口更老，`Present` 同在虚表）；
3. **UI = Dear ImGui（cimgui 静态链接 /MT）**：业界标准游戏内 UI，自带输入处理；样式对齐一期主题变量（CSS 变量 → ImGui Style 映射表）；
4. **通信 = Named Pipe JSON 帧**：DLL 侧零业务逻辑——好友列表/房间/消息全部由主进程推帧，DLL 只画。协议复用一期 `gn:chat-in` 镜像语义（新增 `game-frame` 管道通道）；
5. **静态链接 /MT**：不依赖目标机器 VC 运行库 redistributable。

---

# 三、模块分解

## 3.1 `injector.exe`（独立小工具，C++）

- 参数：`injector.exe <pid> <dll绝对路径>`；流程：`OpenProcess` → `VirtualAllocEx`（写 DLL 路径）→ `CreateRemoteThread(LoadLibraryW)` → 等待加载完成 → 退出；
- 由主进程在 spawn 后调用（`game-overlay.js` 扩展），失败静默降级一期悬浮窗（游戏库兼容等级兜底）；
- 单文件 ~200 行，静态链接 /MT。

## 3.2 `overlay_hook.dll`（核心，C++）

| 模块 | 职责 |
|---|---|
| hook 主模块 | D3D9 `Present`/`Reset` vtable hook；D3D8 适配层（`IDirect3DDevice8` 同思路） |
| ImGui 渲染 | 面板激活期每帧渲染；未激活零渲染开销（仅 hook 透传） |
| 输入 | `WndProc` 子类化：Shift+Tab 检测；面板期劫持键盘/鼠标喂 ImGui（`ImGui_ImplWin32` 现成桥） |
| pipe 客户端 | 连主进程 pipe；下行帧：面板开关/好友列表/消息流；上行：面板事件（发送消息/点击）|
| 看门狗 | 独立线程：pipe 断连超时 / 帧异常 → 自卸载（`FreeLibraryAndExitThread`），绝不拖死游戏 |

- 代码位置：`im-client/pc/overlay-native/`（`hook/` + `injector/` + `third_party/{minhook,cimgui}`）；
- 构建：`build-overlay-native.bat`（MSVC x64 + x86 双架构——32 位老游戏如经典 War3 需 x86 DLL）。

## 3.3 主进程扩展（`game-overlay.js`）

- `game:launch`/`local-game:launch` spawn 链改造：`CREATE_SUSPENDED` → `injector.exe` → `resume`；注入失败不影响游戏启动（回退一期悬浮窗）；
- pipe 服务端：每游戏实例一个 pipe 实例（`\\.\pipe\im-overlay-<pid>`）；
- 帧路由：pipe 下行复用 `gn:chat-in` 镜像流 + 面板状态；上行帧转 `gn:signal-send`（与悬浮窗同口径，经主窗口 WS 上行）；
- 兼容等级：游戏库数据新增"游戏帧内渲染"能力标记（本地名单起步，与服务端零改动一致）。

## 3.4 皮肤与交互对齐一期

- 面板内容（好友列表/私聊/房间）在 DLL 内以 ImGui 重绘一期面板的**精简版**（好友+私聊+房间镜像，与悬浮窗同范围）；
- CSS 主题变量 → ImGui 颜色映射表（`--primary/--panel-bg/--border/--text` 等，跟随 im_theme 下发）。

---

# 四、POC 范围（阶段 0，先行验证）

**只验证三件事：能画上去、游戏不崩、性能无感。**

- D3D9 `Present` hook + ImGui 初始化 + 一个 Shift+Tab 显隐测试窗（FPS/文本）；
- 注入链路：`game:launch` → `CREATE_SUSPENDED` → `injector.exe` → resume；
- 稳定性：注入/卸载反复 ≥100 次、全屏切换 ≥20 次、`Reset`（窗口化↔全屏）资源重建正确；
- 性能：面板关闭期帧率损耗 ≈0（只 hook 不渲染），面板期 ≤3%（ImGui 实测量级）。

POC 通过 = 整个方案的技术定心丸；不通过则回退评估（如 vtable hook 换指令 hook）。

---

# 五、风险矩阵

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | 游戏崩溃（hook 时序 / 设备丢失） | 高 | `Reset` 同钩重建资源；看门狗自动卸载；POC 先行；按游戏白名单灰度 |
| 2 | D3D8 接口差异（虚表布局/能力） | 中 | D3D8 独立适配层（不与 D3D9 共代码路径） |
| 3 | 32/64 位游戏混杂 | 中 | DLL 双架构构建，按游戏进程位数选 DLL |
| 4 | MSVC 运行库依赖 | 中 | /MT 静态链接 |
| 5 | Win7（2008R2 网关用户存在） | 中 | 工具集兼容评估（v141_xp 或 Win7 SDK 目标）；不支持则该平台回退一期悬浮窗 |
| 6 | 全屏切换/多显示器 | 中 | `TestCooperativeLevel`/`Reset` 处理；POC 覆盖 |
| 7 | 输入劫持范围过大影响游戏操作 | 中 | 仅面板激活期劫持；非激活期仅监听热键 |
| 8 | 反作弊误报 | 低 | 平台游戏自管；白名单按游戏启用 |
| 9 | 注入被杀软拦截 | 中 | injector.exe 签名 + 白名单文档引导（一期零注入无此问题，需用户教育） |
| 10 | 性能 | 低 | 非激活期零渲染；激活期 ImGui 实测量级 |

---

# 六、里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 · POC | D3D9 hook + ImGui 测试窗 + 注入链 | 三件事验证（§四）✅ 已完成 |
| M1 · 通信 | pipe 服务端 + JSON 帧 + 与 gn 中继打通 | 测试窗内显示真实好友列表 ✅ 已完成（DLL 侧截图验证 + 主进程侧协议断言 5/5；真实好友快照经 `gn:contacts-need`/`gn:contacts-reply` 归口与 `gn:chat-mirror` 镜像流复用，主进程实现见 `im-client/pc/game-overlay.js` pipe 段） |
| M2 · 面板 | ImGui 版精简面板（好友/私聊/房间镜像）+ 输入劫持 | 游戏内完成一次私聊收发 ✅ 已完成（E2E 截图：输入框打字→chat-send 上行→回显 self 路由→对方回复渲染，FPS 64；主进程侧断言 6/6——pid 校正/上行路由/白名单/me 帧/房间快照推送；注入链与设置开关就位默认关） |
| M3 · 多 API | D3D8 适配层 + 32/64 位 + 看门狗 | 平台游戏清单逐个过 ✅ 代码侧已完成（D3D8 适配层 + 自写 D3D8 ImGui 后端 E2E 收发闭环 FPS 65；x64 IAT hook 路径 E2E 面板渲染；双架构 7 件产物；真机游戏逐个过随 M4 发布推进） |
| M4 · 发布 | 游戏库兼容等级标注 + 设置项「游戏帧内渲染」+ 文档 | 与一期悬浮窗按等级自动选择 ✅ 已完成（兼容名单 `overlay-native/native-games.json` mode=list/all + `isNativeActive(exe)` 按等级判定单测 6/6；设置项 M2 已就位；用户文档《游戏内Overlay使用说明.md》；真机游戏逐个验证随发布推进） |

---

# 七、测试矩阵（初稿，随 POC 细化）

| 维度 | 用例 |
|---|---|
| 渲染 | 独占全屏/无边框/窗口化三种模式下面板显示；全屏↔窗口切换后 UI 恢复；Alt+Tab 往返 |
| 稳定 | 注入/卸载 ×100；连续游戏 2 小时无内存泄漏；强制结束客户端→DLL 自卸载不拖死游戏 |
| 性能 | 面板关/开帧率对比（损耗 ≤3%）；CPU 占用 |
| 输入 | 面板期游戏收不到输入；关闭后游戏输入即时恢复；Shift+Tab 与游戏键位冲突实测 |
| 通信 | pipe 断连自愈；客户端退出 → DLL 看门狗卸载 |
| 兼容 | 平台游戏清单逐个：注入成功率/崩溃率/画面异常 |
| 安全 | DLL 签名；pipe 只接受本机连接 |

---

# 八、实施前置与开放问题（评审拍板）

1. **经典 War3 的 D3D 版本确认**：D3D8 还是 D3D9 需实测（`dumpbin /imports war3.exe` 或 Process Explorer 看加载的 d3d8/d3d9）——决定 POC 的第一个适配层；请提供一台可跑游戏的测试机配合；
2. **32 位老游戏的 x86 DLL 构建**与双架构加载逻辑——是否一期就做；
3. **Win7 支持**是否二期必须（影响工具集选型与测试矩阵）；
4. **杀软白名单**：injector.exe + DLL 注入行为可能被误报，需签名与用户文档——是否接受；
5. **UI 皮肤范围**：二期 ImGui 面板一期只做精简版（好友/私聊/房间镜像），大厅聊天/邀请弹层是否需要——建议 M2 后按反馈定。

---

# 九、与一期的关系

| 场景 | 呈现面 |
|---|---|
| 游戏（按兼容等级标记） | 二期游戏帧内渲染 |
| 其余游戏（无边框/窗口化） | 一期悬浮窗 + 通知小窗（不动） |
| 独占全屏 + 未适配游戏 | 引导切无边框（一期策略） |

一期代码全部保留，二期是叠加的第三种呈现面；`game:launch` 注入失败自动回退一期，玩家无感。


---

# 十、SC:R（星际争霸重制版）D3D11 适配终版战果（2026-10-29 实测闭环）

## 10.1 架构：版本劫持代理（方案 B）

SC:R 主渲染为 **D3D11**（deny-time 模块快照实锤：d3d11.dll + dxgi.dll + nvd3dumx NVIDIA UMD），且反作弊对进程内外来模块行为全方位拦截（探针自建设备 D3DKMT 层 E_INVALIDARG、GetParent 父链失败、写外来堆 AV 被吞）。最终架构：

```
spawnGameChild（hijack 名单命中 + x64）
  → deployD3D9Hijack 五件套幂等部署到游戏目录
      d3d9_proxy.dll→d3d9.dll   （17 导出代码级转发 + handoff：对象返回游戏前补虚表钩）
      System32 d3d9→d3d9_orig.dll
      d3d11_proxy.dll→d3d11.dll （D3D11CreateDevice* 精确签名转发 + handoff）
      System32 d3d11→d3d11_orig.dll
      overlay_hook_x64.dll      （同目录，代理惰性 LoadLibrary）
  → 直接 spawn（不套 injector，防双 hook 实例）
游戏启动 → DLL 搜索顺序（应用目录优先）加载代理 → 代理转发真身 → handoff 出口
  → OverlayHookD3D9Object（slot 16+20）/ OverlayHookD3D11Device（工厂四槽+交换链双槽）
  → 探针交换链自证（自建链 Present 自探）→ 游戏交换链 Present 钩生效
  → 两段式延迟 init（pre-init 主窗口后建 context / init 挂 DX11 后端）
  → 每帧 RenderOverlayD3D11（Present 钩内）
```

## 10.2 关键修复链（实测排障定论）

| 问题 | 根因 | 修复 |
|---|---|---|
| 渲染跑通但面板不可见 | vendored imgui_impl_dx11 的 RenderDrawData **不绑 RTV**（官方把 OMSetRenderTargets 放宿主 main.cpp）——画进游戏遗留渲染目标（离屏/MSAA） | Present 钩内 GetBuffer+CreateRenderTargetView+OMSetRenderTargets 绑交换链 back buffer，画完恢复游戏原绑定；异常分支清 RTV 缓存 |
| 面板开几秒自动消失 | 8s 无渲染能力兜底（`!g_origPresent` 在 x64 恒真）未排除 D3D11 就绪态 | 兜底加 `!g_d3d11Ready` |
| 热键弹游戏外悬浮窗 | d3d9 探针 25 fails 置位 env-denied，覆盖 D3D11 init ok 的清零（时序竞争） | 置位处加 `g_d3d11Ready` 门禁 + 热键分支双保险 `!g_d3d11Ready` |
| 无法输入中文 | 游戏窗口 HIMC 被禁（暴雪惯例）；新建 IME 上下文默认英文关闭态 | 面板期渲染帧 `PanelImeFrameEnsure`：无上下文则挂+SetOpenStatus(TRUE)+中文模式；WM_ACTIVATE 焦点回归重挂——统一覆盖热键/toast 点击/焦点回归三路径 |
| 头像只显示首字母 | 头像纹理是纯 D3D9 实现，g_imguiDev（D3D9 设备）恒空 | 新增 AvatarTexGet11：BGRA 位图直映 DXGI_FORMAT_B8G8R8A8_UNORM（零转换）IMMUTABLE 上传+SRV 缓存 |
| 拖拽时气泡水平不跟随 | DrawList 屏幕绝对坐标混入窗口相对值（GetCursorPosX）——气泡偏移一个面板位置 | 气泡/头像统一 scr0.x（屏幕坐标）+ SetCursorPosX（窗口相对）双坐标系各归其位（私聊/房间共 4 处） |

## 10.3 IME 上下文管理（帧确保模式）

游戏窗口 IME 被禁的场景（暴雪/CryEngine 惯例）下，IME 生命周期必须与面板可见性严格绑定：

- **挂载**：面板期渲染帧确保（有上下文则保开态，无则挂新建上下文+中文模式）——覆盖热键/toast 点击/焦点回归全部打开路径；
- **还原**：热键收起 / Esc / ReportNoPanelOnce 异常收起——ImmAssociateContext 还原 + ImmDestroyContext 防句柄泄漏；
- **提交链**：WndProc 拦 GCS_RESULTSTR（ImmGetCompositionStringW 恒 UTF-16）注入 ImGui + 吞 WM_IME_CHAR 与 150ms 污染 WM_CHAR 回声；提交缓冲 64 字。

## 10.4 Warface 连带回归与修复（同日）

SC:R 适配期间两处连带损伤，均已修复并实测闭环：

1. **x86 DLL 丢失 → 注入链降级**：overlay_hook_x86.dll 在部署/清理事故中丢失，main.js 注入分支历史口径不分数位一律要求 x86 DLL 存在 → x64 的 Warface 整链降级悬浮窗。修复：重编 x86 套件 + **门禁按位数拆分**（x64 游戏只查 x64 套件，缺失日志带位数与文件名）。
2. **env-denied/8s 兜底误伤 → broken 永久卡死**：探针 25 fails 置位 env-denied → 热键回悬浮窗 → ReportNoPanelOnce 置 g_panelBroken → 无恢复路径。修复：设备捕获成功 / ImGuiEnsure9 init 成功时清 broken + 重发 panel-ready（「启动器 nopanel → 进游戏自动恢复」闭环）。根因补全：旧 injector 注入太晚（游戏设备已建、探针追不上）——新 injector 800ms 延迟注入赶在设备创建前装好 slot 钩，游戏建设备即被 Hooked_CreateDevice 捕获。
3. **翻车记录（反面教材）**：曾尝试「InitThread 极早期全模块 GetProcAddress/LoadLibrary IAT 补钩（20+ 模块）」修捕获链——**Warface/SC:R 反作弊完整性检测即拦=游戏都启动不了**，立即回滚。结论：IAT 钩覆盖面扩张必须评估反作弊检测面，宁走「早注入+slot 钩+设备捕获」的既有安全路径。

## 10.5 部署清单（SC:R 形态）

游戏目录（H:\...\XJ1R\x86_64）：d3d9.dll、d3d9_orig.dll、d3d11.dll、d3d11_orig.dll、overlay_hook_x64.dll 五件套（deployD3D9Hijack 幂等维护，size 相同跳过）。
客户端 resources\overlay-native\bin：双架构 overlay_hook_x*.dll + 双架构 injector*.exe + native-games.json（list + hijack 名单）——**双架构产物必须成对维护，部署后读回验证**。
