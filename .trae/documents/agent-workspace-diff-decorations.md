# Agent 模式浏览区：文件内 diff 变更标记（Trae CN 同款）

## Context（背景与目标）

用户希望：Agent 修改代码后，在 Agent 模式工作区的**文件预览区**打开文件时，能像 Trae CN / VSCode 那样直接看到变更标记——

- 新增/修改的行：**绿色底色**标记
- 删除的行：在删除位置（行号栏）显示**红色标记**，悬停可预览被删除的内容，点击可打开完整差异对比标签

**可行性结论：完全可行，且只需改前端（chat.js + style.css），不动服务端与 PC 执行器。** 依据：

1. git 基础设施双端已就绪：前端 `wsPanelGitReq({sub:'diff', path})` → PC 走本地 `git diff HEAD -- <path>`（agent-executor.js），PC 离线回退服务端（agentfiles.go `wsServerGit`），两端返回格式一致。
2. 行级覆盖高亮机制已存在：`wsPanelBindCode`（chat.js ~L6747）已实现 `.ws-code-hl` 绝对定位高亮条（`top = codeTop + line*LINE_H`），绿色装饰条完全复用该机制。
3. 未跟踪文件检测已有现成接口：`{sub:'untracked'}`（`git ls-files --others --exclude-standard`），新文件可整文件标绿（Trae 同款）。
4. 配色有现成锚点：现有 diff 标签（`.ws-diff-pre` + hljs github-dark）已用 `hljs-addition #033a16` / `hljs-deletion #67060c`，装饰色保持同色系。

## 改动文件

- `e:\SourceCodeIM\im-client\web\js\chat.js`（核心逻辑）
- `e:\SourceCodeIM\im-client\web\css\style.css`（装饰样式）

## 实现步骤

### 1. 新增 unified diff 解析器 `wsParseDiffHunks(diffText)`（chat.js，放在 git 面板函数区）

解析 `git diff HEAD -- <path>` 输出，返回：

```js
{ added: Set<newLine0>, deleted: [{ at: newLine0, lines: [被删行文本...] }] }
```

- 逐行扫描：`@@ -a[,b] +c[,d] @@` 进入 hunk（新文件行计数器 `cur = c`，1-based）；`+` 行 → `added.add(cur-1)` 后 `cur++`；` ` 上下文行 → `cur++`；`-` 行 → 暂存到当前删除组
- 遇到上下文/`+`/新 hunk/结尾时，若删除组非空 → 落一条 `{at: cur-1}`（删除内容位于新文件该行上缘之前）
- 跳过 `---/+++/index/diff --git/new file mode/\ No newline at end of file` 等头尾行；`Binary files ... differ` → 返回空结果
- 文本以 `\ No newline` 结尾、hunk 尾部删除等边界按上述规则自然覆盖

### 2. 新增装饰数据加载 `wsPanelLoadGitDecor(path)`（chat.js）

- 在 `wsPanelOpen`（~L6079）读取文本文件成功后、以及 `wsPanelSave`（~L6869）保存成功后调用（后台异步，不阻塞打开）
- 跳过条件：binary / docx / xlsx / pptx / md（这些不走源码视图，md 走 `.ai-md` 渲染）
- 流程：`wsPanelGitReq({sub:'diff', path})` → `wsParseDiffHunks` → 存 `t.gitDecor`；若 active 标签且非编辑态则重渲染
- diff 为空时：调 `{sub:'untracked'}`（带 10 秒 TTL 缓存 `wsPanel.git.untrackedCache`，避免多次打开文件重复拉全量清单）判断该文件是否未跟踪 → 未跟踪则 `added` = 全部行（整文件标绿，Trae 同款）；否则无装饰
- 任何 git 错误（不是仓库 / 无提交 HEAD 不存在 / 未装 git / 超时）→ 静默置 `t.gitDecor = null`，绝不出错误提示打扰预览

### 3. 渲染装饰（`wsPanelBindCode` ~L6747 内，该处已有 `LINE_H`、`codeTop`、`wrap`）

- 通过 `wrap.querySelector('.ws-code-ln')` 取行号栏；从 `wsPanel.tabs[path].gitDecor` 取数据
- **绿色行条**：建容器 `div.ws-diff-decor` 追加到 `wrap`，每个 `added` 行（0-based < lineCount）放一个绝对定位 `div.ws-code-diff-add`，`top = codeTop + line0*LINE_H`，`height = LINE_H`，宽度 `max(wrap.scrollWidth, wrap.clientWidth)`（与 `placeHl` 同款算法）
- **删除标记**：每个删除组在**行号栏 `ln` 内**（sticky 定位、不透明背景、z-index 1，横向滚动时标记不跑偏）放 `div.ws-code-diff-del`，`top = ln padding-top(10px) + at*LINE_H - 1`（压在边界线上），小红色圆角短条
  - `mouseenter/mousemove` → 挂 body 的 `.ws-hover-tip` 悬浮框：标题「删除了 N 行」+ 删除内容等宽预览（≤8 行，超出省略）
  - `click` → `wsPanelGitOpenDiff(path, null)`（~L5760，复用现有差异对比标签，点击行号标记直达完整对比）
- 编辑态（textarea）不加装饰；退出编辑/保存后重渲染自动恢复
- 迟到响应保护：decor 返回时标签已关闭或已切换 → 不渲染（`wsPanel.tabs[path]` 判空 + activeTab 判断，与现有 `wsPanelLoad` 同款防抖）

### 4. 样式（style.css，放在 `.ws-code-hl` 附近 ~L5733）

```css
/* 新增/修改行：绿色底色条（与 hljs diff 的 #033a16 同色系，参照 GitHub Dark diff 绿） */
.ws-code-diff-add {
    position: absolute; left: 0; z-index: 0;
    background: rgba(46, 160, 67, 0.16);
    border-left: 2px solid rgba(46, 160, 67, 0.65);
    pointer-events: none;
}
/* 删除位置标记：行号栏内小红条 */
.ws-code-diff-del {
    position: absolute; right: 4px; width: 16px; height: 3px;
    border-radius: 2px; background: #f85149; cursor: pointer; z-index: 2;
}
.ws-diff-tip-pre { /* 删除内容预览 */ }
```

绿/红为 git 语义色，与产品现有 diff 视图（hljs-addition/deletion）同色系，符合"主题色关联"约束。

## 不改的部分

- 服务端（agentfiles.go）、PC 执行器（agent-executor.js）：diff/untracked 接口现成
- 现有差异对比标签、git 视图逻辑：只复用不改动

## 验证方案（实测，不猜测）

1. Web 端：启动前端（或直接用现有 webbin 服务），登录 → 打开 Agent 会话 → 工作区文件树
2. 场景 A：Agent 已修改的已提交文件 → 打开后对应行绿底 + 绿左条；删除位置行号栏有红条
3. 场景 B：悬停红条 → 显示「删除了 N 行」+ 内容预览；点击红条 → 打开「差异对比」标签，+绿/−红一致
4. 场景 C：Agent 新建的未跟踪文件 → 打开后整文件绿底
5. 场景 D：非 git 目录 / 全新无提交仓库 → 打开文件无装饰、无报错提示
6. 场景 E：编辑保存（新增几行/删几行）→ 保存后装饰即时刷新
7. 场景 F：非源码文件（md/docx/xlsx/图片）→ 不受影响；深浅主题切换 → 绿红条与代码区底色协调
8. PC 端（im-client.exe）重复 2-6（PC 走本地 git，离线时回退服务端路径同样验证）
