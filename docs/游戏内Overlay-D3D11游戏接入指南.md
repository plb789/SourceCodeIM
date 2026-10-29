# 游戏内 Overlay —— D3D11 游戏接入指南（hijack 名单）

> 面向接入操作者。架构背景见《游戏内Overlay二期注入式设计.md》§十；玩家侧功能说明见《游戏内Overlay使用说明.md》。

## 一、为什么 D3D11 游戏必须走 hijack 名单

帧内面板的注入链有两条，按渲染 API 与介入时机分流：

| 路径 | 触发条件 | 支持的渲染 API | 原理 |
|---|---|---|---|
| **injector 注入** | 游戏在 `list` 名单、不在 `hijack` 名单 | D3D8 / D3D9 | 注入后探针钩 `CreateDevice` 槽 → 游戏建设备被捕获 → Present/Reset 补丁 |
| **版本劫持（hijack）** | 游戏同时在 `list` 与 `hijack` 名单 | **D3D11**（及 D3D9 动态解析型） | 代理 d3d9/d3d11.dll 借 DLL 搜索顺序被游戏加载 → 转发真身时 handoff 补虚表钩 → 游戏自建设备/交换链必经钩子 |

**D3D11 游戏走 injector 路径不支持帧内面板**：D3D11 的钩（工厂四槽 + 交换链双槽）依赖代理转发出口的 handoff 时机——injector 注入到达时游戏设备早已创建、无介入点，DLL 会回落 D3D9 探针（D3D11 游戏无 d3d9 调用面）→ 无渲染能力 → 悬浮窗形态。因此 **新增 D3D11 游戏必须同时加入两个名单**。

## 二、接入前判断：游戏主渲染是否为 D3D11

任选其一：

```powershell
# 方法 1：导入表静态判断（游戏主 exe）
dumpbin /imports "游戏目录\游戏.exe" | Select-String "d3d11|dxgi"
# 方法 2：运行时模块快照（启动游戏到主界面后）
Get-Process 游戏 | ForEach-Object { $_.Modules } | Where-Object { $_.ModuleName -match 'd3d11|dxgi|d3d9' } | Select-Object ModuleName, FileName
```

- 见 `d3d11.dll`/`dxgi.dll` 且无 `d3d9` 调用面 → D3D11 游戏，走本指南；
- 见 `d3d9.dll` 且游戏渲染走它 → D3D9 游戏，加 `list` 名单即可（勿加 hijack）；
- `d3d11` 与 `d3d9` 并存时以**主渲染**为准（可用 deny-time 模块快照日志终审：`%TEMP%\im-overlay-hook.log` 搜 `deny-time module`）。

## 三、名单配置（native-games.json）

文件位置（三处同步维护）：`im-client\bin\resources\overlay-native\native-games.json`（打包态）、`im-client\pc\overlay-native\native-games.json`（开发态源文件）、`im-client\pc\dist\win-unpacked\resources\overlay-native\native-games.json`（dist 副本）。用户侧可编辑副本在 `%APPDATA%\im-client-pc\overlay-native-games.json`（**优先级最高**，存在时覆盖分发模板）。

```json
{
  "mode": "list",
  "list":     ["ra2.exe", "yuri.exe", "StarCraft.exe", "GameCdonl.exe", "新游戏.exe"],
  "hijack":   ["starcraft.exe", "新游戏.exe"]
}
```

规则：

1. `list` 与 `hijack` **都要加**（hijack 是 list 的子集——hijack 命中的前提是 native 门禁通过，门禁按 list 判）；
2. **exe 名小写、不含路径**（解析时统一小写比较）；
3. 名单改动随客户端分发，用户副本存在时以用户副本为准（现场排查时先确认用户副本内容）；
4. 平台补丁型游戏（运行时整体替换设备虚表，如 War3+w3plus）**禁止加入**——槽位级对抗无效，实测确认。

## 四、部署机制（自动，无需手工）

`hijack` 名单命中后，客户端 `spawnGameChild` 启动游戏前自动执行 `deployD3D9Hijack(游戏目录)`，幂等部署五件套（size 相同跳过）：

| 游戏目录文件 | 来源 | 作用 |
|---|---|---|
| `d3d9.dll` | `overlay-native\bin\d3d9_proxy.dll` | D3D9 代理：17 导出代码级转发 + handoff（对象返回游戏前补 slot 16/20 钩） |
| `d3d9_orig.dll` | `C:\Windows\System32\d3d9.dll` | D3D9 真身（转发目标） |
| `d3d11.dll` | `overlay-native\bin\d3d11_proxy.dll` | D3D11 代理：D3D11CreateDevice* 精确签名转发 + handoff（设备/交换链交 hook DLL） |
| `d3d11_orig.dll` | `C:\Windows\System32\d3d11.dll` | D3D11 真身 |
| `overlay_hook_x64.dll` | `overlay-native\bin\overlay_hook_x64.dll` | 主 hook DLL（代理惰性 LoadLibrary 拉起） |

部署失败（游戏运行中锁文件等）自动降级普通启动（悬浮窗形态），日志 `[overlay] 版本劫持部署失败`。

**注意**：游戏运行中文件被锁会导致部署静默失败——部署发生在 spawn 之前（游戏未启动时），正常流程无此问题；手工更新 DLL 时须先退出游戏。

## 五、验证清单（按日志链逐环核对）

启动游戏 → 主界面，检查 `%TEMP%\im-overlay-hook.log`（及客户端 `%APPDATA%\im-client-pc\gn-tunnel.log`）：

| # | 日志特征 | 含义 |
|---|---|---|
| 1 | `d3d11proxy: D3D11CreateDevice called hr=0x0 dev=...` | 代理被游戏加载并转发 ✅ |
| 2 | `OverlayHookD3D11Device entered dev=...` | handoff 到达 hook DLL ✅ |
| 3 | `dxgi factory CreateSwapChain* vtable hooked (d3d11)` | 工厂四槽钩就位 ✅ |
| 4 | `Hooked_DXGISwapChain_Present called #N sc=...` | 游戏交换链 Present 进钩 ✅ |
| 5 | `imgui dx11 init ok (delayed retry after main window)` | DX11 后端就绪 ✅ |
| 6 | `panel ready reported (hotkey yield to native)` | 热键让位（客户端侧 gn-tunnel.log 出现「帧内渲染生效」）✅ |
| 7 | 按热键后 `d3d11 draw data: disp=WxH vtx=N idx=N rtv=1` | 面板真实绘制（rtv=1 = 绑定交换链 back buffer）✅ |

客户端无 `[overlay] 版本劫持部署失败` / `注入组件缺失` 即部署链健康。

## 六、反作弊红线（务必遵守）

1. **禁止在 hook DLL 的 InitThread 极早期做大面积 IAT 补丁**（全模块 GetProcAddress/LoadLibrary 钩实测触发 Warface/SC:R 反作弊完整性检测 = 游戏启动即被拦）。捕获网只走「代理 handoff / 探针 slot 钩 / 设备捕获」既有安全路径；
2. 虚表语义槽硬补前必须过 `ValidateVtblInModule` 布局校验（XFG 扩展虚表/版本差异时安全跳过）；
3. hook DLL 内所有外来行为（COM QI / GetParent / 跨堆写入）须 `__try` 包裹——异常转日志置 `g_d3d11Disabled`，游戏不死；
4. 新游戏首次接入先在测试机验证「启动 → 进主界面 → 热键 → Esc 退出」全流程无崩溃，再放开给用户。

## 七、常见问题对照

| 现象 | 日志特征 | 处置 |
|---|---|---|
| 热键弹游戏外悬浮窗 | 无 `D3D11CreateDevice called`（代理未被加载） | 核对 exe 名是否进 hijack 名单 / 用户副本名单覆盖 / 五件套是否在游戏目录 |
| 面板打开但不可见 | `draw data ... rtv=0` | RTV 绑定失败（交换链异常）——查 EnsureD3D11RenderTarget 的 GetBuffer/CreateRenderTargetView 返回 |
| 面板几秒自动消失 | `panel on 8s without render capability` | 渲染能力未就绪（init 链断）——查 init 日志断点 |
| 中文无法输入 | 无 `ime commit injected` 且无 `panel ime: attached` | 游戏窗口 IME 被禁且帧确保未触发——确认 PanelImeFrameEnsure 在渲染帧被调 |
| 进程内 D3D11 路径被禁 | `d3d11 handoff EXCEPTION ... -> d3d11 path disabled` | 反作弊拦截 handoff 内某调用——按异常码定位，勿盲目重试 |
| 游戏启动即退/崩溃 | hook 日志只有 `hook dll attached` 或为空 | 反作弊完整性检测——核对近期是否新增了早期 IAT/代码补丁类改动 |

## 八、回滚

1. 从 `hijack` 名单移除 exe 名（`list` 可保留——回退 injector 路径试探 D3D9 面，通常无捕获面，呈悬浮窗形态）；
2. 清理游戏目录五件套（游戏未运行时）；
3. 客户端重启生效。

> 三处名单与双架构产物（overlay_hook_x86/x64.dll、injector.exe/x64.exe）必须成对维护——单一文件缺失曾导致整链降级（门禁已按位数拆分，但产物完整性仍是部署前提）。
