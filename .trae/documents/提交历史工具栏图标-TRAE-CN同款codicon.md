# 提交历史工具栏图标改为 TRAE CN 同款 codicon

## 概述
把「源代码管理」面板头部的拉取/推送/刷新按钮从裸 Unicode 字形（⬇ / ⬆ / ⟳）替换为 TRAE CN（VS Code 内核）同款的 codicon 矢量图标（内联 SVG，`fill="currentColor"` 自动跟随主题色）。`···` 菜单钮保持省略号字形不变。

## 现状分析（已实测排查）
- [chat.js](file:///e:/SourceCodeIM/im-client/web/js/chat.js) 当前按钮全部是文本字形，无任何 SVG 图标：
  - L5863：`pullB.textContent = '⬇'`（拉取）
  - L5869：`pushB.textContent = '⬆'`（推送）
  - L5875：`rmB.textContent = '⇄'`（远程地址，不在本次范围）
  - L5892：`refB.textContent = '⟳'`（刷新）
  - L4751：文件树头部刷新 `refreshBtn.textContent = '⟳'`（同面板保持一致，一并替换）
- codicon 图标源文件已下载到 `.tmp-cdp/`（上一轮从 microsoft/vscode-codicons 获取，即 TRAE CN 所用图标库）：
  - `repo-pull.svg`：向下箭头汇入底部节点托盘（VS Code SCM 标准"拉取"图标）
  - `repo-push.svg`：向上箭头从底部节点托盘发出（VS Code SCM 标准"推送"图标）
  - `refresh.svg`：双段圆弧循环箭头
- codicon 使用 `fill="currentColor"`，颜色继承按钮 `color`（`--text-secondary` → hover `--text`），天然跟随主题色，无需额外处理。
- [style.css](file:///e:/SourceCodeIM/im-client/web/css/style.css) `.ws-panel-btn`（L5553）目前无 svg 子元素样式，需补充尺寸规则。
- [index.html](file:///e:/SourceCodeIM/im-client/web/index.html) L549 版本号为 `v=2.54`，需升级做缓存穿透。

## 修改内容

### 1. chat.js — 新增图标构建函数 `wsGitIco(name)`
位置：`wsPanelGitRender` 函数前的工具函数区。SVG 内容直接取自 `.tmp-cdp/` 三个源文件的 `<path>` 数据，内联到 JS 常量中（无路径硬编码、无额外请求）：

```javascript
// TRAE CN 同款 codicon 图标（microsoft/vscode-codicons，fill=currentColor 随主题色变化）
var WS_GIT_ICONS = {
    'repo-pull': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4.85 6.15C4.755 6.05 4.627 6 4.5 6C4.372 6 4.245 6.05 4.15 6.15C4.05 6.245 4 6.373 4 6.5C4 6.627 4.05 6.755 4.15 6.85L7.15 9.85C7.245 9.95 7.372 10 7.5 10C7.628 10 7.755 9.95 7.85 9.85L10.85 6.85C10.95 6.755 11 6.628 11 6.5C11 6.372 10.95 6.245 10.85 6.15C10.755 6.05 10.627 6 10.5 6C10.373 6 10.245 6.05 10.15 6.15L8 8.29V1.5C8 1.22 7.78 1 7.5 1C7.22 1 7 1.22 7 1.5V8.29L4.85 6.15Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9.95 13H12.5C12.78 13 13 13.22 13 13.5C13 13.78 12.78 14 12.5 14H9.95C9.72 15.14 8.71 16 7.5 16C6.29 16 5.28 15.14 5.05 14H2.5C2.22 14 2 13.78 2 13.5C2 13.22 2.22 13 2.5 13H5.05C5.28 11.86 6.29 11 7.5 11C8.71 11 9.72 11.86 9.95 13ZM6.09 14C6.29 14.58 6.85 15 7.5 15C8.15 15 8.71 14.58 8.91 14C8.97 13.84 9 13.68 9 13.5C9 13.32 8.97 13.16 8.91 13C8.71 12.42 8.15 12 7.5 12C6.85 12 6.29 12.42 6.09 13C6.03 13.16 6 13.32 6 13.5C6 13.68 6.03 13.84 6.09 14Z"/></svg>',
    'repo-push': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4.85 4.85C4.755 4.95 4.627 5 4.5 5C4.372 5 4.245 4.95 4.15 4.85C4.05 4.755 4 4.627 4 4.5C4 4.373 4.05 4.245 4.15 4.15L7.15 1.15C7.245 1.05 7.372 1 7.5 1C7.628 1 7.755 1.05 7.85 1.15L10.85 4.15C10.95 4.245 11 4.372 11 4.5C11 4.628 10.95 4.755 10.85 4.85C10.755 4.95 10.627 5 10.5 5C10.373 5 10.245 4.95 10.15 4.85L8 2.71V9.5C8 9.78 7.78 10 7.5 10C7.22 10 7 9.78 7 9.5V2.71L4.85 4.85Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9.95 13H12.5C12.78 13 13 13.22 13 13.5C13 13.78 12.78 14 12.5 14H9.95C9.72 15.14 8.71 16 7.5 16C6.29 16 5.28 15.14 5.05 14H2.5C2.22 14 2 13.78 2 13.5C2 13.22 2.22 13 2.5 13H5.05C5.28 11.86 6.29 11 7.5 11C8.71 11 9.72 11.86 9.95 13ZM6.09 14C6.29 14.58 6.85 15 7.5 15C8.15 15 8.71 14.58 8.91 14C8.97 13.84 9 13.68 9 13.5C9 13.32 8.97 13.16 8.91 13C8.71 12.42 8.15 12 7.5 12C6.85 12 6.29 12.42 6.09 13C6.03 13.16 6 13.32 6 13.5C6 13.68 6.03 13.84 6.09 14Z"/></svg>',
    'refresh': '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H10C9.72386 5 9.5 5.22386 9.5 5.5C9.5 5.77614 9.72386 6 10 6H12.8904C12.8973 6.00014 12.9041 6.00014 12.911 6H13C13.2761 6 13.5 5.77614 13.5 5.5V2.5C13.5 2.22386 13.2761 2 13 2C12.7239 2 12.5 2.22386 12.5 2.5V4.03138C11.4009 2.78613 9.79253 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14C11.1301 14 13.6999 11.6035 13.9756 8.54488C14.0003 8.26985 13.7975 8.0268 13.5225 8.00202C13.2474 7.97723 13.0044 8.1801 12.9796 8.45512C12.75 11.003 10.6079 13 8 13C5.23858 13 3 10.7614 3 8Z"/></svg>'
};
function wsGitIco(name) { return WS_GIT_ICONS[name] || ''; }
```

### 2. chat.js — 替换按钮字形（仅替换，不改事件逻辑）
- L5863：`pullB.textContent = '⬇'` → `pullB.innerHTML = wsGitIco('repo-pull')`
- L5869：`pushB.textContent = '⬆'` → `pushB.innerHTML = wsGitIco('repo-push')`
- L5892：`refB.textContent = '⟳'` → `refB.innerHTML = wsGitIco('refresh')`
- L4751：`refreshBtn.textContent = '⟳'` → `refreshBtn.innerHTML = wsGitIco('refresh')`（文件树头部刷新，与 git 头部刷新图标统一）
- 保持不变：`rmB`（⇄ 远程地址）、`helpB`（? 帮助）、`moreBtn`（··· 更多菜单，用户明确要求保留省略号）、按钮 title 提示与 click 事件全部原样。

### 3. style.css — 补充 svg 尺寸样式
加在 `.ws-panel-btn` 相关规则附近（L5553 区块后）：

```css
/* TRAE CN 同款 codicon 矢量图标（拉取/推送/刷新）：currentColor 随主题色 */
.ws-panel-btn svg {
    width: 13px;
    height: 13px;
    display: block;
    pointer-events: none;
}
```

说明：codicon 源文件自带 `width/height="16"` 属性，CSS 尺寸优先生效；`pointer-events: none` 防止点中 svg 时 `e.target` 判断异常（更多菜单的点外收起逻辑依赖 contains 判断，svg 在按钮内不受影响，双保险）。

### 4. index.html — 版本号缓存穿透
L549：`chat.js?v=2.54` → `chat.js?v=2.55`

### 5. 删除临时目录 `.tmp-cdp/`
SVG path 数据提取进 chat.js 后，整个 `.tmp-cdp/` 目录（图标源文件 + shot.js/cdp.js/test-logparse.js 等调试脚本）全部删除——正式环境只剩既有的 web 三个文件改动，不新增任何目录。

## 假设与决策
- 用户"不要向下箭头和向上箭头"指不用当前裸 Unicode 箭头字形（⬇/⬆）；"和 TRAE CN 一样"即上一轮已确认并下载的 codicon `repo-pull` / `repo-push` / `refresh`（TRAE CN 为 VS Code 内核，源代码管理视图即用这套图标）。
- **内联 SVG，正式环境零多余目录**：图标 path 数据直接写成 chat.js 内的 JS 字符串常量，编译产物只有 chat.js / style.css / index.html 三个既有文件，运行时**不读取任何 .svg 文件**，不新增任何资源目录。
- **`.tmp-cdp/` 仅为临时素材下载与调试目录**（4 个图标源文件 + 排查用测试脚本 shot.js/cdp.js/test-logparse.js 等），已验证 im-client / im-server 全部正式代码对其零引用。**实施完成后整个目录删除**，项目内不留多余目录。
- 文件树头部刷新按钮一并替换：与 git 头部刷新属于同一面板体系，保留字形 `⟳` 会造成两种刷新图标并存的不一致。
- 本次只动图标呈现，不改任何按钮行为与提交历史功能（拉取/推送/刷新事件、悬停详情卡、分页加载等全部不动）。

## 验证
1. 强刷页面（Ctrl+F5）→ 打开工作区 →「源代码管理」页签。
2. 目视确认：拉取/推送/刷新三个按钮显示为 codicon 矢量图标（不再是 ⬇/⬆/⟳ 字形），悬停变色正常。
3. 切换主题色，确认图标颜色跟随主题。
4. 依次点击拉取/推送/刷新，确认原功能不受影响（刷新状态、分支领先/落后数字等）。
5. 切到「文件」页签确认文件树刷新按钮同样为 codicon 图标。
6. 删除 `.tmp-cdp/` 后再次强刷页面，确认图标仍正常（证明运行时零依赖该目录）。
7. 若 PC 端 exe 内置 web 资源，需按项目现有打包流程重新编译前端后验证 PC 端显示。
