# 二期补丁工具（GamePatchTool）实施方案 —— 游戏增量更新

> 目标：商户用补丁工具对比新旧版本生成 patch.zip，上传登记后老玩家只下载变更文件（秒级小更新），新玩家照常全量安装。
> 形态决策（已定）：**本地 CLI**，且主模式以**服务端导出的已上架清单**为 diff 基准（免保留本地旧版副本、消除基线漂移）；管理员服务端自动 diff 列为后续可选增强。理由：商户上传流量决定性（CLI 只传补丁包几十 MB vs 服务端 diff 需先传全量新版几十 GB），且散文件方式（pack 0）本身已增量、服务端自动对比收益重叠。
> 核心洞察：一期勘察确认现有链路已具备全部增量基础设施——散文件更新时同路径同 SHA256 的未变更文件**硬链接复用**（download-manager.js dedup，注释即"补丁更新核心"），`_commit` **整目录原子换入**（旧版被删文件自动消失）。因此补丁做成**纯服务端清单合成**，客户端仅一处一行归一改动。
> 分期定位：一期已预留 pack_type=3 扩展位；本方案落 pack_type=3。

## 0. 设计决策（为什么是"服务端清单合成"而非"客户端解补丁"）

| 对比项 | 方案 A：客户端下载 patch.zip 自行解包覆盖 | 方案 B（选定）：服务端解包 + 清单合成 |
|---|---|---|
| 客户端改动 | 新增补丁应用阶段（覆盖写/删除应用/回滚） | 仅 packType=3 归一为散文件语义（1 行） |
| 新玩家安装 | 需先装 base 再打补丁，或另发全量包 | 合成清单即完整版，正常安装 |
| 删除文件生效 | 客户端需读 patch.json 逐个删 | `_commit` 整目录换入自动生效 |
| 断点续传/校验/进度 | 补丁应用阶段需另行实现 | 全部复用现有下载引擎 |
| 失败回滚 | 补丁应用半途失败状态复杂 | 暂存目录机制天然回滚 |

patch.zip 只是**上传/传输载体**，登记时服务端解包落位，之后磁盘上就是标准散文件版本。

## 1. 补丁制作工具（GamePatchTool，Go CLI）

位置：`im-server/tools/gamepatch/`（独立 main 包，复用 im-server 的 Go 工具链编译）。

### 1.1 命令
```
gametool diff -base-list filelist.txt -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1] [-list filelist_new.txt]
gametool diff -old <旧版目录> -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1]   （离线备选：本地旧目录为基准）
gametool verify -base-list filelist.txt -patch patch.zip   （可复检：模拟应用校验一致性）
gametool list   -dir <目录> -out filelist.txt              （FileListGenerator 同款清单：类型|相对路径|sha256|大小）
```

**基准选择（关键设计）**：主模式 `-base-list` 以商户网页"导出清单"按钮下载的已上架版本清单为基准（格式 `0|rel_path|sha256|size` 行，与 FileListGenerator 同构）——
- 商户**不需要保留旧版本地副本**，且基准与服务端登记版本精确对齐，杜绝"本地目录与已上架版本漂移"导致的错补丁；
- 登记时服务端第二道校验（delete ⊆ base 清单、change 与 zip 条目一致）兜底，漂移包直接拒绝。

### 1.2 diff 逻辑
1. 遍历两棵目录树（rel_path 归一 `/`，跳过临时文件 `*.tmp/~$*`，空文件跳过与服务端约定一致）；
2. 逐路径比对 `size + sha256`（流式哈希，4MB 缓冲）：
   - 仅存在于 new → **新增**；两边都有但哈希不同 → **变更**；仅存在于 old → **删除**；
3. 产出 patch.zip：
   - 压缩条目 = 新增+变更文件（保持相对路径，deflate）；
   - 末尾附 `patch.json`：
     ```json
     {"format":1,"base_version":"1.0.0","version":"1.0.1",
      "change":["game.exe","data/new.pak"],"delete":["old.cfg","data/removed.pak"]}
     ```
4. `-list` 可选输出新版完整清单（FileListGenerator 精神，供商户归档/核对）；
5. 输出摘要：N 变更 / M 新增 / K 删除 / 补丁大小 / 相对全量的体积节省比。

### 1.3 约束
- 删除与变更集合不得重叠；patch.json 的 change 必须与 zip 内条目一一对应（工具内自检）；
- 单文件 ≤50GB（与服务端 MaxFileSize 一致）；补丁整体大小无专门限制（走分片上传既有通道）。

## 2. 服务端改动（im-server）

### 2.1 模型
```go
// GameVersion 增：
BaseVersion  string `gorm:"column:base_version;type:varchar(32);default:''" json:"base_version"`
// PatchDelete 补丁删除清单（JSON 数组串；登记时从 patch.json 提取存库——zip 解包后即使条目
// 缺失也不丢删除语义；合成清单时消费）
PatchDelete  string `gorm:"column:patch_delete;type:text" json:"patch_delete"`
```

### 2.2 版本登记（gameVersionCreateCore 新增 pack_type=3 分支）
1. 前置校验：`base_version` 必填且为**同游戏**已登记版本（404 防跨游戏）；base 版本必须为散文件（pack 0）或另一补丁（pack 3）——ZIP 整包版（pack 1/2）的 GameFile 行只有 zip 本体无法合成，直接拒绝并提示；补丁链深度 ≤10（沿 base_version 递归计数，防环+防无限链）；
2. 文件清单：必须恰好 1 项 `.zip`（走现有分片上传+SHA256 合并落位，零改动）；
3. 合并落位后**解包**：`zip.OpenReader` 逐条目——条目路径安检（复用 `zipEntryUnsafe`）→ 解压到 `games/<slug>/<ver>/`（patch.json 条目本身保留落盘）；
4. 解析 patch.json：format=1、delete/change 逐路径安检（同 zipEntryUnsafe 规则）、change 与 zip 条目一致、delete ∩ change = ∅、delete 路径必须存在于（合成后的）base 清单；
5. **合成最终清单**（核心）：
   ```
   baseManifest = gameManifest 合成结果（递归取 base 的 rel_path→(size,sha) 映射）
   final = baseManifest − delete − change  ∪  zip 条目（change/新增，size/sha 用登记声明值）
   ```
   按 rel_path 排序生成 GameFile 行（storage_path 指向 verRoot 下真实落位文件）+ ManifestHash（对合成清单按既有 `rel:size:sha` 规则计算——客户端更新检测机制不变）；
6. 登记版本行：PackType=3、PackSize=合成清单大小和、BaseVersion、PatchDelete（JSON 串）。
   失败回滚沿用 gameVersionRollback（整版本目录删除）。

### 2.3 manifest 下发
- 合成清单对客户端完全透明：`gameManifest` 对 pack 3 版本返回的就是合成后的散文件清单（url=/api/game/file/{fid} 全部有效）；
- `pack_type: 3`、`base_version` 一并下发（客户端归一用）；
- 递归合成沿 BaseVersion 链（深度 ≤10，超限报"补丁链过深请发布完整版"）。

### 2.4 服务端清单导出接口 + 商户 Web 端
- **清单导出**（新小接口）：`GET /api/merchant/games/{id}/versions/{ver}/filelist`（merchantGuard，归属校验；管理端同款 `/admin/api/game/versions/{ver}/filelist`）——按 GameFile 行输出 `0|rel_path|sha256|size` 排序文本（zip 本体行标注 `1|` 目录/包类型前缀，散文件版即全量清单）；商户网页版本列表每行加"导出清单"按钮（浏览器直接下载 txt）；
- 上传方式加第四项"补丁包"：上传 patch.zip（accept=.zip）+ `base_version` 下拉（loadVersions 已有的版本列表填充，仅列散文件/补丁版本，ZIP 整包版置灰）+ 版本号默认 = base 递增提示；弹窗附指引文案（①导出 base 清单 ②gametool diff ③上传 patch.zip）；
- 版本列表"方式"列加"补丁"徽标（含 base 版本号提示）。

### 2.5 配置
无新增配置项（补丁链深度上限用常量 10 即可）。config.yaml 不动。

## 3. 客户端改动（一处一行）

`download-manager.js start()`：
```js
// pack_type=3（补丁）：服务端已解包合成完整散文件清单，客户端按散文件语义走
// （dedup 硬链接未变更文件 + 下载变更文件 + _commit 整目录换入，删除自动生效）
const packType = (pt === 1 || pt === 2) ? pt : 0;
```
其余零改动：manifest 拉取、payload 透传、进度/去重/断点续传全部现成。

## 4. 各场景行为推演（设计自检）

| 场景 | 行为 |
|---|---|
| 老玩家（installed=base_version） | manifest=合成清单 → 未变更文件硬链接秒过、只下载变更文件 → commit 换入，删除文件消失 → **秒级小更新** |
| 新玩家 | 同一份合成清单 = 完整版，正常全量安装 |
| 跨版本玩家（installed=base-2） | 变更文件照下、未变更硬链接复用（sha 命中多少省多少）、**已删除的旧文件会在 commit 时随整目录换入消失**；但 base 后新增而玩家版本没有的文件正常补齐——行为正确 |
| 补丁链 v1.0.0→1.0.1→1.0.2 | 1.0.2 合成时递归取 1.0.1 合成清单，逐层叠加，深度 ≤10 |
| base 是 ZIP 整包版 | 登记直接拒绝，提示"请先发布散文件版或改发完整 ZIP 版" |
| patch.zip 内含恶意路径 | 服务端解包前 zipEntryUnsafe 拦截（登记失败回滚） |

## 5. 测试清单（完成定义）

1. 工具：diff 正确性（增/删/改三类识别）、verify 复检通过、filelist 输出格式；
2. 服务端登记：正常补丁 200 且合成清单 = 预期（单元测试直接断言 rel_path 集合与 sha）；
3. 校验分支：base 不存在 404 / base 是 ZIP 整包版 400 / delete∩change 非空 400 / change 与 zip 条目不一致 400 / delete 路径不在 base 清单 400 / 恶意路径条目 400 / 链深超限 400；
4. 链式补丁：v1→v1.1→v1.2 两层合成结果 = 逐层手算结果一致；
5. 客户端实测：老玩家更新只下载变更文件（dedupedBytes≈未变更总量）、删除文件换入后消失、exe 探测与启动正常；
6. 回归：散文件/单 ZIP/分卷三种既有方式登记与下载全流程不受影响（packType=3 归一不影响 0/1/2）。

## 6. 实施顺序与工作量分布

| 步骤 | 内容 |
|---|---|
| 1 | GamePatchTool CLI（diff -base-list/-old 双模式、list、verify）+ 单元测试 |
| 2 | 模型加列 + 登记分支 + 合成清单（服务端核心，含测试） |
| 3 | 清单导出接口（商户+管理端）+ 商户 Web 第四上传方式/导出按钮/base 下拉 |
| 4 | 客户端 1 行归一 + 真机回归 |
| 5 | 开发文档归档（7.3.60） |

后续可选增强（本期不做，决策已归档）：管理端"基于某散文件版本一键生成补丁"——服务端磁盘直接 diff 两个已上架散文件版本并登记（零上传，仅管理员自建游戏场景），diff 逻辑与 CLI 同源复用。
