# 游戏中心 ZIP 整包/分卷下载功能 —— 详细实施计划

> 目标：商户可上传单 ZIP 或分卷 ZIP 作为游戏版本包；客户端下载后自动解压（单 ZIP 与分卷通吃）。
> 原则：新增 `pack_type` 通道，默认值 0 严格等价现状，散文件上传/下载所有代码路径零改动。
> 分期：一期 = ZIP 整包 + 分卷解压；二期 = 补丁工具（差异更新，另立计划）。

## 0. 已确认的技术前提

| 事实 | 位置 | 影响 |
|---|---|---|
| GORM AutoMigrate 加列自动生效 | model/model.go:16 先例 | GameVersion 加字段无需手写迁移 |
| 商户/管理端共用分片上传 + 版本登记核心 | gameadmin.go:1457 gameVersionCreateCore | 服务端只改这一处入口 |
| manifest 接口按版本返回文件清单 | game.go:1141-1156 | 加返回字段即可 |
| 下载引擎逐文件：.part 续传 + SHA256 + 暂存目录 rename | download-manager.js | 分卷=多文件，引擎零改动 |
| 外置 exe sidecar 打包先例（dlbt-host.exe） | bt-download-manager.js:623 _hostExePath | 7z.exe 沿用同一打包模式 |
| 商户版本上传 UI（分片 + SHA256 + 登记） | web/js/merchant.js:521-624 | 只加"上传方式"选择与校验 |

## 1. 服务端改动（im-server）

### 1.1 模型：GameVersion 加字段
文件：`im-server/model/model.go:1238`

```go
// PackType 打包方式（AutoMigrate 自动加列，存量版本默认 0 散文件，行为不变）：
// 0=散文件清单（现有方式） 1=单 ZIP 包 2=分卷 ZIP（game.zip.001/.002…）
PackType int8  `gorm:"column:pack_type;type:tinyint;default:0" json:"pack_type"`
// PackSize 解压后总大小（字节；单 ZIP 由服务端读 central directory 自动计算；
// 分卷由商户登记时填写，客户端解压前磁盘余量预检用；0=未知不预检）
PackSize int64 `gorm:"column:pack_size;default:0" json:"pack_size"`
```

### 1.2 版本登记核心：接收并校验 pack_type
文件：`im-server/server/gameadmin.go:1457 gameVersionCreateCore`

1. req 结构加 `PackType int8` / `PackSize int64` 字段。
2. 校验规则（合并落位**之后**、登记版本**之前**执行）：
   - `pack_type=0`：不校验（现状）。
   - `pack_type=1`：文件清单必须恰好 1 项且以 `.zip` 结尾（大小写不敏感）；合并成功后用
     `archive/zip.OpenReader` 读 central directory 累加 `f.UncompressedSize64` 得 PackSize 并回填；
     同时校验条目路径无 `..`、无盘符前缀（服务端侧第一道 Zip Slip 防线）。
     单条目解压大小上限校验：`PackSize` 超过 `cfg.Game.MaxUnpackSize`（新配置项）直接拒绝并回滚。
   - `pack_type=2`：文件清单 ≥2 项、命名必须为 `同前缀.zip.001…zip.NNN`（前缀一致、序号从 001 连续递增）；
     服务端无法解析分卷 central directory → 要求商户端填 `pack_size`（>0 校验，未填拒绝）。
3. 版本行登记带上 PackType/PackSize（gameadmin.go:1564 处赋值）。

### 1.3 manifest 下发新字段
文件：`im-server/server/game.go:1151-1156 gameManifest` 返回 map 增加：

```go
"pack_type": v.PackType,
"pack_size": v.PackSize,
```

老客户端 JSON 解析忽略未知字段，完全兼容。

### 1.4 配置项（防压缩炸弹）
文件：`im-server/bin/config.yaml` game 段新增：

```yaml
game:
  # ZIP 打包版本解压后总大小上限（字节，0=不限）：版本登记时校验，防 ZIP 炸弹撑爆磁盘
  max_unpack_size: 107374182400   # 100GB
```

同步补齐到 `config - linux.yaml`（工作区规则）。对应 `cfg.Game.MaxUnpackSize` 读取字段与
现有 Game 配置结构同处定义（搜 `MaxFileSize` 所在 struct）。

### 1.5 测试
文件：`im-server/server/merchant_test.go`（沿用 TestMerchantVersionOwnership 先例）新增：
- 单 ZIP 登记：pack_type=1 自动算 PackSize 正确；
- pack_type=1 但清单含非 zip 项 → 400；
- pack_type=2 分卷序号断档（001,003）→ 400；连续 → 200；
- pack_type=2 未填 pack_size → 400；
- pack_type=0 回归：现有用例全部保持通过。

命令：`go test ./server/ -run TestMerchantVersion -v`（cwd=im-server）。

## 2. PC 客户端改动（im-client/pc）

### 2.1 下载页 payload 透传
文件：`im-client/web/js/game-store.js:2944-3057`

manifest 拉取后构造下载 payload 处（两处 files: manifest.files 的对象字面量）增加：

```js
packType: manifest.pack_type || 0,
packSize: manifest.pack_size || 0,
```

注意同步维护 `im-client/pc/bundled/web-obfuscated/` 构建产物（发布构建流程自动生成）。

### 2.2 download-manager.js 新增解压阶段
文件：`im-client/pc/download-manager.js`

**start()（L71-174）**：payload 增收 `packType`/`packSize` 存入 task（新建与旧任务重置两处都要赋值）。
packType>0 时 rel_path 白名单不变（分卷也是普通文件照常下载落暂存目录）。

**_finish（L600）拆分**：当前 `_finish` 直接 `_commit` + emit done。改为：

```
全部文件下载并校验通过
  → packType==0：走原 _finish 原路径（零改动）
  → packType>0：task.state='extracting' → _extract(task)
       1) 磁盘余量预检：fs.statfs(stagingDir)（Node/Electron 支持）bavail*bsize ≥ packSize，
          不足 → error 事件 '磁盘空间不足（需解压后 xx GB）'，保留 ZIP 卷
       2) Zip Slip 预检：spawn 7z l -slt -ba <首卷>，逐行解析 'Path = ...'，
          resolve 后必须位于暂存目录内且无盘符/UNC 前缀，越界 → error '压缩包内含非法路径'
       3) spawn 7z x <首卷> -o<stagingDir> -y -bsp1：
          - 单 ZIP：首卷即 game.zip
          - 分卷：7z 自动发现同前缀 .zip.001…（.z01 旧式同样支持）
          - stdout 解析 'xx% ' 进度 → 进度事件带 phase:'extract'，pct 为解压段进度
          - 解压期间收到 pause → 返回 '解压阶段不支持暂停'；cancel → kill 7z，ZIP 卷保留，
            任务置 cancelled（重试时下载引擎对已校验卷去重跳过，直接进解压）
       4) 成功后：删除 ZIP 卷（fs.unlink 逐个，失败忽略——_commit 前 rename 不受影响），
          task.total 复算为 packSize（进度语义修正），→ 原 _commit 换入正式目录 → emit done
```

进度事件契约扩展：`progress` 事件负载增加 `phase` 字段（'download'=现有默认 / 'extract'），
`done` 前必然有一条 `phase:'extract', pct:100`。页面按 phase 切文案"下载中/解压中"。

### 2.3 内置 7z 与打包
- 放置：`im-client/pc/7z/7z.exe + 7z.dll`（开发态，与 dlbt-host/ 同构）；
- 路径解析（照抄 bt-download-manager.js:623 _hostExePath 模式）：
  打包态 `process.resourcesPath/7z/7z.exe`，开发态 `__dirname/7z/`；
- electron-builder 配置（im-client/pc/package.json build 段）加
  `extraResources: [{ from: '7z', to: '7z' }]`（与 dlbt-host 条目并列）；
- publish-update.bat 打包流程不变（extraResources 自动带上）；
- 7z.exe 缺失兜底：error 事件 '解压组件缺失'（同 BT 引擎缺失文案风格）。

### 2.4 游戏中心页面进度显示
文件：`im-client/web/js/game-store.js` 下载任务条渲染处：按 `evt.phase` 显示
"解压中 xx%（不可暂停）"，其余不变。

## 3. 商户 Web 端改动（im-client/web）

### 3.1 版本上传弹窗加"上传方式"
文件：`im-client/web/merchant.html`（m-ver-* 弹窗）+ `web/js/merchant.js:521-624`

1. 弹窗顶部加自绘三选一（复用现有自绘 radio/segment 样式，禁系统控件）：
   `散文件（默认）｜单 ZIP 包｜分卷 ZIP`。
2. 选单 ZIP：文件选择器 accept=.zip，清单只允许 1 项，rel_path 即文件名；
   pack_size 不填（服务端自动算）。
3. 选分卷 ZIP：accept=.zip.001,.zip.002,…；前端校验：同前缀、序号 001 起连续；
   弹窗出现"解压后大小（GB）"必填输入框 → pack_size。
4. runVersionPublish（L612）登记请求体增加 `pack_type`、`pack_size`（仅打包方式非 0 时携带）。
5. 上传条目 SHA256/分片逻辑（verUploadOne）零改动——分卷就是普通文件。

### 3.2 管理端（可选，低优先）
`web/js/admin.js:7078` 管理端上传走同一核心，可后续复制同样的三选一；一期商户端先行。

## 4. 文档与收尾

- `docs/开发文档.md` 追加"游戏中心 ZIP 打包版本"章节（登记规则/分卷命名/客户端解压阶段/事件契约）。
- 编译验证：服务端 `go build` → bin/im-server.exe；客户端按现有流程出 im-client.exe。
- config.yaml 与 config - linux.yaml 同步核对。

## 5. 测试清单（完成定义）

1. 商户端：散文件上传全流程回归（现有功能不受影响）。
2. 商户端：单 ZIP 上传 → 登记成功，服务端自动算出 pack_size。
3. 商户端：game.zip.001/002/003 上传 → 登记成功；断档/前缀不一致 → 明确报错。
4. 客户端：下载单 ZIP 版本 → 下载条切"解压中"→ 完成，目录结构与 ZIP 内一致，exe 探测正常启动。
5. 客户端：分卷版本下载 → 中断续传 → 解压 → 完成；解压后 ZIP 卷已清理。
6. 解压取消：kill 7z 后卷保留，重试不重下直接解压。
7. 磁盘不足：预检报错，卷保留。
8. Zip Slip：构造含 `../evil.txt` 条目的 zip → 客户端与服务端双重拒绝。
9. 老版本兼容：旧客户端拉取含 pack_type 的 manifest 正常下载散文件版本（字段忽略）。
10. 性能/稳定性：大 ZIP（>10GB）解压期间主进程无阻塞（spawn 子进程 + stdout 流式解析），
    内存占用平稳；限速功能在下载阶段仍生效。

## 6. 二期（补丁工具）备忘

FileListGenerator 思路升级版：新旧版本目录 SHA256 对比 → 变更文件打 patch.zip + 删除清单 →
版本登记加 base_version → 客户端已装 base 时只下补丁覆盖解压。解决 ZIP 方案全量重下短板。
一期不实现，接口设计预留：pack_type 可扩展 3=patch（增量包）。
