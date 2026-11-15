# 游戏介绍富文本 HTML 编辑改造方案

> 状态：**方案阶段** · 草稿 · 待评审
> 日期：2026-11-16
> 涉及模块：服务端（Game 模型保存链路）、Web 前端（游戏详情页渲染 + 后台/商户后台编辑器）

---

## 一、背景与现状

### 1.1 当前行为

| 层面 | 现状 |
|---|---|
| 数据库 | `games.description` — `TEXT` 字段，最大 20000 字 |
| 后台编辑器 | textarea `gm-f-desc`（admin.html L1526），placeholder 提示"详细介绍（详情页图文混排：正文任意换行，插入的图片单独成行自动展示）" |
| 图片插入 | 已有"插入图片"按钮（`gm-desc-img-btn`），写入 `[img]URL` 占位符 |
| 商户后台 | merchant.html 复用同样的 Game 编辑器（gm 系列字段） |
| 服务端保存 | `gameadmin.go` / `merchantgame.go` 中 `g.Description = strings.TrimSpace(req.Description)` — **零 HTML 消毒** |
| 前端渲染 | `game-store.js` `buildDetailDesc(text)` 用 `document.createTextNode` 纯文本渲染 + 解析 `[img]URL` 占位符为 `<img>` |

### 1.2 核心问题

1. **前端渲染能力弱**：只能纯文本 + 图片占位符，无法实现标题、列表、粗体、表格、引用等富文本排版
2. **服务端零消毒**：`description` 字段无任何 HTML 过滤 → 存储型 XSS 隐患（当前因前端用 createTextNode 纯文本渲染所以没触发，但属隐形炸弹）
3. **无实时预览**：后台编辑时只能盲写，保存后才知道效果

### 1.3 目标

- ✅ 支持富文本 HTML 编辑（纯文本 + HTML 标签混写）
- ✅ 前端安全渲染（消毒后的 HTML，零 XSS）
- ✅ 服务端入库前强制消毒（双道防线）
- ✅ 编辑器内**实时预览**（编辑时右侧同步显示渲染效果）
- ✅ 完全向后兼容（旧的纯文本 + `[img]URL` 继续工作）

---

## 二、安全放行的 HTML 标签范围

### 2.1 放行清单（白名单，RE2 正则匹配）

| 类别 | 标签 | 允许属性 | 说明 |
|---|---|---|---|
| 段落结构 | `<p> <br> <hr>` | p: 无；br/hr: 无 | 分段、换行、分隔线 |
| 标题 | `<h1> <h2> <h3>` | 无 | h4+ 不放行（详情页不宜过大字体） |
| 强调/样式 | `<b> <strong> <i> <em> <u> <s> <del> <mark> <small>` | 无 | 粗体、斜体、下划线、删除线、高亮、小号 |
| 列表 | `<ul> <ol> <li>` | 无 | 有序/无序列表 |
| 链接 | `<a>` | `href`（强制 `target="_blank" rel="noopener noreferrer"`） | URL 安全校验（http/https/站内路径） |
| 图片 | `<img>` | `src`（强制加 `loading="lazy"`）、`alt`、`width`、`height` | src URL 需过安全校验 |
| 内联代码 | `<code> <pre>` | 无 | 代码片段 |
| 引用 | `<blockquote>` | 无 | 引用块 |
| 表格 | `<table> <thead> <tbody> <tr> <th> <td>` | 无 | 简单表格（无 colspan/rowspan 避免复杂布局） |

### 2.2 危险标签/属性一律拦截

| 类型 | 拦截清单 |
|---|---|
| 危险标签 | `<script> <style> <iframe> <object> <embed> <form> <input> <button> <link> <meta> <base> <svg> <math> <template>` |
| 危险协议 | `javascript:` `vbscript:` `data:` `file:` |
| 事件属性 | 所有 `on*` 属性（onclick/onerror/onmouseover 等，正则 `\son[a-z]+\s*=`） |
| `<img src=` 中的 xss | `src="javascript:..."` 拦截；`src="data:..."` 拦截 |
| `<a>` 的其他属性 | 只放行 href，onclick/onmouseover/title 等一律剥离 |

### 2.3 现有公告消毒函数的改造复用

已存在的 `gameNoticeContentClean`（gameadmin.go）消毒公告正文。Game.description 改造时**不直接复用原函数**，而是：

1. **提取公共逻辑**：URL 安全校验函数 `safeURL(url string) bool` 提到公共位置（例如 `server/sanitize.go`）
2. **新建专用函数** `gameDescContentClean(content string) string`：
   - 复用 safeURL
   - 用**两层正则**：先保护放行标签为占位符 → 再剥壳其他所有标签 → 还原占位符
   - 放行范围比公告大（多了 p/h1-h3/b/i/ul/ol/img/blockquote 等）
   - 统一剥离危险标签 + 事件属性

---

## 三、技术方案

### 3.1 服务端改造

#### 3.1.1 新增 `server/sanitize.go`（公共消毒模块）

```go
// server/sanitize.go

// safeURL 统一 URL 安全校验（公告 + Game 共用）
func safeURL(url string) bool

// gameNoticeContentClean 公告正文消毒（已实现，可保留在 gameadmin.go 或迁移到 sanitize.go）
func gameNoticeContentClean(content string) string

// gameDescContentClean Game 详细介绍消毒（本次新增）
// 放行范围比公告大：支持 p/h1-h3/b/strong/i/em/u/s/del/mark/small/ul/ol/li/a/img/code/pre/blockquote/table
// 消毒流程：
//  Step1: 遍历所有放行标签，替换为唯一占位符保护（防后续 anyTagRe 误杀）
//  Step2: 正则剥离所有 on* 事件属性
//  Step3: 正则剥离剩余所有 HTML 标签外壳（危险标签已被 Step1 占位符保护）
//  Step4: 还原占位符为规范化标签（a 自动加 target=_blank rel=noopener；img 自动加 loading=lazy）
func gameDescContentClean(content string) string
```

#### 3.1.2 接入 Game 保存链路

| 入口 | 文件 | 当前代码 | 改造 |
|---|---|---|---|
| 管理端 Create Game | gameadmin.go | `Description: req.Description` | `gameDescContentClean(req.Description)` |
| 管理端 Update Game | gameadmin.go | `rec.Description = req.Description` | 同上 |
| 商户端 Create Game | merchantgame.go L118 | `g.Description = strings.TrimSpace(req.Description)` | `g.Description = gameDescContentClean(req.Description)` |
| 商户端 Update Game | merchantgame.go | 同上 | 同上 |

#### 3.1.3 正则设计（RE2 兼容，不支持反向引用）

```go
// 放行标签正则（一次匹配所有白名单标签组）
// 标签名是固定白名单，用 alternation 列出
var allowedTagRe = regexp.MustCompile(
    `(?is)<\s*` +
    `(?:p|br|hr|h[1-3]|b|strong|i|em|u|s|del|mark|small|` +
    `ul|ol|li|a|img|code|pre|blockquote|table|thead|tbody|tr|th|td)` +
    `(\s[^>]*)?\s*>` +         // 可选属性组（后续消毒）
    `|</\s*(?:p|br|hr|h[1-3]|b|strong|i|em|u|s|del|mark|small|` +
    `ul|ol|li|a|img|code|pre|blockquote|table|thead|tbody|tr|th|td)\s*>`)

// 事件属性剥离正则
var onAttrRe = regexp.MustCompile(`(?is)\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)`)

// 任意标签外壳（所有未被保护的标签统一剥壳）
var anyTagRe = regexp.MustCompile(`(?is)<\s*[^>]+\s*>`)
```

### 3.2 前端渲染改造

#### 3.2.1 改 `buildDetailDesc`（game-store.js）

当前逻辑：
```
有 [img] 占位符 → 逐行解析 → 纯文本 createTextNode + [img] 转为 <img>
无 [img] → createTextNode(raw)  → 所有 HTML 标签被转义
```

改造后逻辑（纯静态 HTML 渲染器）：
```
Step1: 兼容旧语法 → [img]URL 独立成行替换为 <img src="URL"> 安全标签
Step2: 消毒解析 → 正则遍历放行标签 + 剥离事件属性 + 安全 URL 校验
Step3: 安全 DOM 构建 → 逐片段 document.createElement 构建节点树（不用 innerHTML）
Step4: 返回 Fragment 追加到详情页
```

#### 3.2.2 渲染效果示例

编辑器输入：
```html
更新内容：

<h3>✨ 主要更新</h3>
<ul>
  <li>内挂全面升级 <a href="http://luna.cdonl.com/detail">查看详情</a></li>
  <li>装备对比系统上线</li>
  <li>新增 3 张新地图</li>
</ul>

<blockquote>内挂加载方式：进入游戏按 F6 呼出</blockquote>

<hr>
官方讨论群：<a href="https://discord.gg/xxx">Discord</a>
```

详情页渲染：
---
**✨ 主要更新**
- 内挂全面升级 [查看详情 ↗](http://luna.cdonl.com/detail)
- 装备对比系统上线
- 新增 3 张新地图

> 内挂加载方式：进入游戏按 F6 呼出
---
官方讨论群：[Discord ↗](https://discord.gg/xxx)

#### 3.2.3 CSS 样式适配（game-store.html）

当前 `.gs-desc-*` 系列 CSS 只定义了 p/img。改造后需补充：

```css
.gs-desc h1, .gs-desc h2, .gs-desc h3 { /* 标题样式 */ }
.gs-desc ul, .gs-desc ol { /* 列表缩进 */ }
.gs-desc li { /* 列表项 */ }
.gs-desc a { /* 链接颜色，hover 下划线 */ }
.gs-desc blockquote { /* 引用块：左边框 + 浅灰背景 */ }
.gs-desc hr { /* 分隔线 */ }
.gs-desc code, .gs-desc pre { /* 代码样式 */ }
.gs-desc table { /* 表格边框 */ }
.gs-desc strong, .gs-desc b { /* 粗体 */ }
.gs-desc em, .gs-desc i { /* 斜体 */ }
.gs-desc del, .gs-desc s { /* 删除线 */ }
.gs-desc mark { /* 高亮（用主题色） */ }
```

---

## 四、HTML 预览功能方案

### 4.1 方案选型

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. 右侧 iframe 实时预览** | textarea 输入 → 右侧同高度 iframe 实时显示渲染结果 | ✅ 完全隔离，编辑不影响页面 | ⚠️ iframe 内无法复用页面主题色 CSS，需额外引入 |
| **B. 同区域 tab 切换** | "编辑" tab = textarea；"预览" tab = 渲染结果 | ✅ 实现简单，同页面 CSS 直接复用 | ⚠️ 看不到编辑区（切换时丢失上下文） |
| **C. 分屏分栏（推荐）** | 左侧 textarea 编辑 + 右侧同高度 div 实时渲染，中间可拖拽调节宽度 | ✅ **边写边看**，主题色自动跟随，体验最佳 | 需处理 textarea 与预览区同高度滚动同步 |
| **D. 弹窗预览** | 编辑器区域保留不变，加"预览"按钮 → 弹窗显示渲染结果 | ✅ 最小改动 | ⚠️ 不是**实时**，每次要点按钮；弹窗关闭后上下文丢失 |

### 4.2 推荐方案：C 分屏分栏实时预览

#### 4.2.1 布局结构

```
┌─────────────────────────────────────────────────────────────────┐
│  详细介绍                                                        │
├──────────────────────────────┬──────────────────────────────────┤
│  <textarea>                  │  预览区（class=gs-desc-preview）  │
│                              │                                  │
│  正在写的 HTML/纯文本        │  ← 实时渲染结果                   │
│                              │  + 支持 hover 点击图片放大      │
├──────────────────────────────┴──────────────────────────────────┤
│  [插入图片] [重置]                                              │
└─────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 技术实现要点

**分隔条拖拽（可调节左右宽度）**：
```javascript
// 可拖拽分隔条（与聊天窗口/设置面板分隔条同源模式）
var split = el('div', 'gm-desc-split');
split.addEventListener('mousedown', function (e) {
    var startX = e.clientX;
    var leftW = textarea.getBoundingClientRect().width;
    function onMove(e) {
        var delta = e.clientX - startX;
        textarea.parentElement.style.setProperty('--split-left', (leftW + delta) + 'px');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', function () {
        document.removeEventListener('mousemove', onMove);
    }, { once: true });
});
```

**实时预览 debounce（150ms）**：
```javascript
var previewTimer = null;
textarea.addEventListener('input', function () {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
        var sanitized = gameDescPreviewClean(textarea.value); // 客户端轻量消毒（同服务端逻辑）
        previewEl.innerHTML = sanitized; // 只写入消毒后的安全 HTML
    }, 150);
});
```

**客户端预览消毒（轻量版）**：
- 复用渲染时的 HTML 消毒逻辑（不用 innerHTML 写，而是 DOM API 构建后 append，零风险）
- 只过滤放行标签 + 剥离事件属性
- 不做 URL 强制改写（preview 是临时渲染，不入库）

**滚动同步（可选）**：
- textarea scroll 事件 → 预览区 scrollTop 同步（比率）
- 预览区 scroll 事件 → textarea scrollTop 同步（反向比率）
- **不是必须**，可后续迭代

#### 4.2.3 预览功能对"客户端消毒"的要求

预览区**绝对不能**直接 `innerHTML = textarea.value` 原始内容。即使是管理员，也不能让 HTML 直接执行。必须：

```javascript
// ❌ 错误（存储型 XSS 如果管理员电脑有 keylogger 或插件）
previewEl.innerHTML = textarea.value;

// ✅ 正确（消毒后写，双保险）
var safeHTML = gameDescPreviewClean(textarea.value);
previewEl.innerHTML = safeHTML;
// 更安全：完全 DOM API 构建（零 innerHTML）
var frag = buildSafeDescFrag(textarea.value);
previewEl.innerHTML = '';
previewEl.appendChild(frag);
```

#### 4.2.4 商户后台预览

merchant.html 里 Game 编辑器复用 gm 系列字段 → 分屏预览只需改同一套 HTML 结构，**admin.html 和 merchant.html 同时生效**。

### 4.3 预览功能改动清单

| 文件 | 改动 |
|---|---|
| admin.html | `gm-f-desc` textarea 外包一层 flex 容器 + 新增 `<div class="gm-desc-preview">` 预览区 + 分隔条 |
| merchant.html | 同上（结构完全一致，复用同一个 HTML） |
| admin.js | 新增分屏拖拽逻辑 + 预览 debounce + 客户端消毒函数 |
| merchant.js | 同上（Game 编辑保存链路已在 admin.js 里实现，merchant.html 可能通过 iframe 或共享脚本） |

---

## 五、实时安全提示功能

### 5.1 需求动机

后台/商户后台编辑器里的 textarea 允许输入 HTML 代码，但管理员可能：
- 不小心写出不安全的代码（如 `<a href="javascript:alert(1)">`）
- 尝试用 `<script>` 实现动画效果 → 保存后被后端静默剥离，内容丢失却不知道为什么
- 复制粘贴带 `onclick/onerror` 属性的第三方 HTML → 同样被静默剥离

**"静默剥离"的用户体验差**：保存后发现内容少了一截，但不知道哪段被删了、为什么、该怎么改。

**目标**：编辑器输入时**实时扫描**，发现不安全代码时**即时纠正提示**，告诉管理员：
1. 哪一行/哪段不安全
2. 具体违反了什么安全规则
3. 保存后会被怎么处理（替换/剥离）
4. 给出修复建议代码

### 5.2 功能设计

#### 5.2.1 触发时机

| 时机 | 说明 |
|---|---|
| textarea input 事件 | 每次输入触发（debounce 300ms，避免逐字符扫描闪烁） |
| 粘贴内容后 | paste 事件 + 额外立即扫描一次 |
| cursor 位置附近 | 只扫描光标所在的"可视区域"？（可选优化，当前全量扫描即可，text 上限 20000 字） |

#### 5.2.2 提示 UI 形态

在分屏分栏布局的基础上，安全提示以**右侧预览区底部的可折叠提示面板**呈现：

```
┌──────────────┬──────────────────────────┐
│  textarea    │  预览区                  │
│              │                          │
│  <input...>  │  ← 实时渲染结果          │
│  <script>    │                          │
│    alert(1)  │──────────────────────────│
│  </script>   │  ⚠️ 安全提示 (2) [展开▼]│ ← 折叠状态，只显示数量
│              │  ┌────────────────────┐  │
│              │  │ ❌ <script> 标签将被整行移除 │  │
│              │  │     位置：第 3 行        │  │
│              │  │     原因：脚本标签禁止执行 │  │
│              │  │     建议：改用 <code>alert(1)</code> │  │
│              │  │     [自动修复] [忽略]     │  │
│              │  └────────────────────┘  │
│              │  ┌────────────────────┐  │
│              │  │ ⚠️ <img> 缺少 alt 属性    │  │
│              │  │     位置：第 8 行        │  │
│              │  │     建议：<img src="..." alt="截图"> │  │
│              │  └────────────────────┘  │
└──────────────┴──────────────────────────┘
```

#### 5.2.3 提示项数据结构

每条提示包含：

```javascript
{
  level: 'error' | 'warning' | 'info',  // 严重级别
  line: 3,                              // 起始行号（textarea 里的行号）
  endLine: 5,                           // 结束行号（可选，跨多行标签）
  col: 1,                               // 起始列（可选，精确定位）
  code: '<script>alert(1)</script>',    // 触发的原始代码片段
  rule: 'script_tag_blocked',           // 触发的规则 ID（可追溯）
  reason: '脚本标签不允许执行',          // 原因说明（中文）
  action: '整段剥离',                    // 后端保存后的处理结果
  suggestion: '改用 <code>alert(1)</code> 纯文本显示',  // 修复建议（可包含 HTML）
  suggestedCode: '<code>alert(1)</code>', // 建议替换的代码（可选，支持一键替换）
  fixable: true                         // 是否支持一键修复
}
```

#### 5.2.4 安全规则库（前端消毒镜像）

前端规则库**与服务端 `gameDescContentClean` 完全镜像**（同一份白名单 + 同一份黑名单），确保"前端提示"和"后端处理"结果一致。

| 规则 ID | 级别 | 触发条件 | 处理 | 修复建议 |
|---|---|---|---|---|
| `script_tag_blocked` | **error** | `<script ...>` | 整块剥离 | 改用 `<code>` 显示代码片段 |
| `style_tag_blocked` | error | `<style ...>` | 整块剥离 | 样式请写到主题 CSS 里 |
| `iframe_blocked` | error | `<iframe ...>` | 整块剥离 | — |
| `event_attr_stripped` | error | `onclick/onerror/onmouseover` 等 `on*` 属性 | 剥离属性 | 移除该属性，或改用安全交互方式 |
| `dangerous_protocol` | error | `href="javascript:..."` / `src="data:..."` | URL 剥离，降级为纯文本 | 改用 http:// 或 https:// 开头的链接 |
| `disallowed_tag` | warning | `<div> <span> <font> <center>` 等不在白名单里的标签 | 标签壳剥离，保留内文 | 改用 `<p>` `<h3>` `<strong>` 等白名单标签 |
| `image_no_alt` | info | `<img>` 缺少 alt 属性 | 保留 img，补空 alt | 建议加上有意义的 alt 描述 |
| `image_no_src` | error | `<img>` 缺少 src 属性 | img 元素移除 | — |
| `anchor_no_href` | info | `<a>` 缺少 href | a 变为纯文本（无链接） | 加上 href 属性 |
| `anchor_target_warning` | info | `<a>` 没写 target | 消毒时自动加 `target="_blank" rel="noopener"` | 已自动处理，无需干预 |
| `disallowed_attr` | warning | `<a title="...">` / `<img width="...">`（超范围属性） | 属性剥离 | 移除该属性 |
| `table_no_structure` | warning | `<td>` 不在 `<tr>` 内 | 消毒时保留但浏览器渲染可能异常 | 确保表格结构完整 |
| `html_comment` | info | `<!-- 注释 -->` | 保留（注释不执行） | — |
| `old_img_syntax` | info | `[img]URL` 旧语法 | 自动转为 `<img src="URL">` | 两种写法都支持，可随意使用 |

#### 5.2.5 "自动修复"按钮实现

```javascript
function fixIssue(issue, textareaEl) {
    // 按 line/col 定位原始代码在 textarea.value 里的位置
    var lines = textareaEl.value.split('\n');
    var before = lines.slice(0, issue.line - 1).join('\n');
    var after  = lines.slice(issue.endLine || issue.line).join('\n');
    
    var fixed = issue.suggestedCode !== undefined ? issue.suggestedCode : '';
    textareaEl.value = before + (fixed ? '\n' + fixed + '\n' : '\n') + after;
    
    // 触发 input 事件 → 重新扫描 → 提示消失
    textareaEl.dispatchEvent(new Event('input'));
    
    // 光标定位到修复后的位置，方便用户继续编辑
    textareaEl.focus();
}
```

#### 5.2.6 扫描性能

| 维度 | 数据 |
|---|---|
| 每帧扫描频率 | 300ms debounce |
| 文本上限 | 20000 字（Game.description 限制） |
| 规则数量 | ~14 条正则（同服务端） |
| 单条正则开销 | < 0.1ms（20000 字文本匹配） |
| 总计 | < 2ms / 次（14 × 0.14ms ≈ 1.96ms） |

前端扫描**不做任何 DOM 构建**（只做正则匹配收集提示项），比服务端消毒快得多。

#### 5.2.7 保存按钮状态联动

```
有 error 级别提示 → 保存按钮变 disabled，hover 显示原因 tooltip
有 warning 级别提示 → 保存按钮正常，但点击时弹出 confirm 对话框：
   "检测到 2 条安全警告，保存后会被自动处理，是否继续？"
```

### 5.3 安全提示改动清单

| 文件 | 改动 |
|---|---|
| admin.html | 预览区底部新增 `<div class="gm-desc-warnings">` 提示面板（可折叠） |
| merchant.html | 同上 |
| admin.js | 新增 `scanDescSecurity(text)` 函数（~14 条规则正则）+ 提示面板渲染 + 自动修复逻辑 + 保存按钮状态联动 |
| merchant.js | 同上 |
| admin.js (现有) | 分屏布局里把提示面板放到预览区底部（不是新增独立区域，避免页面过长） |

### 5.4 安全提示与服务端消毒的关系

```
管理员输入 textarea
    │
    ├──▶ 前端实时扫描（300ms debounce）
    │       → 提示面板显示 N 条 error/warning/info
    │       → 保存按钮状态联动
    │
    ├──▶ 管理员点"自动修复" / 手动修改
    │
    └──▶ 点保存 → 前端 POST 到服务端
              │
              └──▶ 服务端 gameDescContentClean 消毒（独立运行）
                      → 与前端提示规则一致但不完全依赖（双保险）
                      → 消毒后入库
              ← 服务端返回消毒后的最终内容给前端（可选）
                      → 前端可对比：提示过的是否都被正确处理
```

**核心原则**：前端提示是**辅助工具**（给管理员看、帮助修正）；服务端消毒是**强制防线**（任何绕过前端的恶意 POST 都会被拦截）。即使管理员忽略所有提示直接点保存，服务端依然会正确处理。

---

## 六、改动总清单

### 6.1 涉及文件

| # | 文件 | 改动类型 | 改动量 | 风险 |
|---|---|---|---|---|
| 1 | `im-server/server/sanitize.go`（新建） | 消毒函数 | ~80 行 | 低（纯函数，无副作用） |
| 2 | `im-server/server/gameadmin.go` | 接入消毒 | ~6 行（4 个入口 × 1-2 行） | 低 |
| 3 | `im-server/server/merchantgame.go` | 接入消毒 | ~2 行 | 低 |
| 4 | `im-client/web/js/game-store.js` | 改 buildDetailDesc 为安全 HTML 渲染 + 兼容 [img] | ~40 行 | 中（核心渲染路径） |
| 5 | `im-client/web/game-store.html` | 补充 .gs-desc 富文本样式 | ~40 行 | 低（纯 CSS） |
| 6 | `im-client/web/admin.html` | textarea → 分屏结构 + 预览区 | ~15 行 HTML | 中（表单结构变更） |
| 7 | `im-client/web/merchant.html` | 同上 | ~15 行 HTML | 中 |
| 8 | `im-client/web/js/admin.js` | 分屏拖拽 + 预览 debounce + 客户端消毒 | ~50 行 | 中（编辑器路径） |
| 9 | `im-client/web/js/merchant.js` | 同上 | ~30 行 | 中 |

### 6.2 不需要改动

| 方面 | 原因 |
|---|---|
| 数据库 schema | `description` 已是 TEXT 字段，可直接存 HTML |
| API 路径 | 不新增 API，复用现有 Game Create/Update 接口 |
| 公告相关 | gameNoticeContentClean 独立，不受影响 |
| 其他页面（chat/index/image-viewer） | 完全不涉及 |
| 前端其他 JS（merchant.js 公告编辑 / admin.js 公告编辑） | 不涉及 Game.description |

---

## 七、向后兼容

| 场景 | 行为 |
|---|---|
| 旧数据：纯文本 description | ✅ createTextNode → 消毒后 createTextNode → 渲染一致 |
| 旧数据：`[img]URL` 占位符 | ✅ Step1 先解析 `[img]` → Step2 消毒 → `<img>` 放行 → 渲染一致 |
| 旧数据：HTML 标签 | 之前被 createTextNode 转义显示；改造后被消毒放行/剥壳 → **可能视觉变化**（如用户之前写了 `<br>` 显示为文字，现在变成真换行） |
| 旧编辑器输入 `[img]URL` | ✅ 继续支持，新渲染器识别 |
| 新编辑器输入 `<img src="...">` | ✅ 消毒放行，新渲染器识别 |
| 新编辑器输入 `javascript:alert(1)` | ✅ 消毒剥离 |
| 旧 Game 页面（非详情页） | 如商店列表的"一句话介绍"走 `short_desc` 字段，本次不涉及 |

---

## 八、安全测试用例

| # | 输入 | 预期输出 |
|---|---|---|
| 1 | 纯文本"这是介绍" | 原样渲染 |
| 2 | `<p>段落1</p><p>段落2</p>` | 两段正文 |
| 3 | `<h3>标题</h3>` | 三级标题样式 |
| 4 | `<a href="http://x.com">链接</a>` | 可点击，自动 target=_blank rel=noopener |
| 5 | `<a href="javascript:alert(1)">点击</a>` | 降级为纯文本"点击"（链接壳被剥掉） |
| 6 | `<img src="http://x.com/a.gif">` | 渲染为图片，自动 loading=lazy |
| 7 | `<img src="javascript:alert(1)">` | src 被剥离，img 元素消失 |
| 8 | `<img src=x onerror=alert(1)>` | onerror 属性剥离，src 不可访问 → 图片 alt 或占位 |
| 9 | `<script>alert(1)</script>` | script 整块剥离 → 无执行 |
| 10 | `<div onmouseover="alert(1)">hi</div>` | onmouseover 剥离，div 壳剥掉 → "hi"纯文本 |
| 11 | `<iframe src=http://evil.com>` | iframe 整块剥离 |
| 12 | `<table><tr><td>A</td><td>B</td></tr></table>` | 渲染为表格 |
| 13 | `[img]http://x.com/a.gif` | 兼容旧语法，渲染为图片 |
| 14 | `**粗体** _斜体_` | 保留为纯文本（不引入 markdown，保持简单） |
| 15 | `<style>body{background:#000}</style>` | style 整块剥离 |
| 16 | 中英文混排 + emoji + `<br>` | 正常渲染，换行生效 |

---

## 九、实施步骤

按以下顺序逐步推进，每步完成后独立测试：

| 步骤 | 任务 | 依赖 | 产出 |
|---|---|---|---|
| **Step 1** | 服务端 `sanitize.go` + `gameDescContentClean` + 4 个入口接入 | 无 | 编译通过 + 单元测试覆盖 16 个用例 |
| **Step 2** | 前端 `buildDetailDesc` 改造 + CSS 样式补充 | Step1（同帧可并行） | 详情页 HTML 正确渲染，旧数据零视觉变化 |
| **Step 3** | admin.html + merchant.html 编辑器分屏预览 + 客户端消毒 | Step2 | 后台编辑时右边实时预览，保存后效果一致 |
| **Step 4** | 全链路集成测试 + 安全测试 | Step 1-3 | 16 个安全用例全过，编辑器/详情页/后台全闭环 |

---

## 十、风险与缓解

| 风险 | 概率 | 缓解措施 |
|---|---|---|
| 消毒正则写漏，放行了不该放行的标签 | 中 | Step1 单元测试覆盖所有危险 tag + 事件属性；客户端再消毒一次 |
| 旧数据里的 `<br>` 之前显示为文字、现在变成真换行 → 用户感知"内容变了" | 低 | 属于正向变化（内容正确显示）；文档里标注 |
| buildDetailDesc 改造后 HTML 标签嵌套不合法导致渲染错乱 | 低 | 逐标签 DOM API 构建（不用 innerHTML 整段写），浏览器自动纠正非法嵌套 |
| 分屏预览滚动同步处理不当 | 低 | Step3 先只做宽度拖拽，滚动同步可后续迭代 |
| RE2 正则性能差（长文本） | 极低 | 20000 字文本在 RE2 里毫秒级完成；保存频率极低 |

---

## 十一、后续可扩展

| 方向 | 说明 | 优先级 |
|---|---|---|
| **Markdown 支持** | 在 HTML 之前先 parse markdown → sanitize → 渲染。可引入 marked.js（CDN，20KB） | P2（当前先做 HTML） |
| **富文本编辑器** | 引入 Quill/TinyMCE/editor.js 等所见即所得编辑器 → 输出 sanitize 后的 HTML | P3（需评估引入成本） |
| **预览区图片点击放大** | 预览区的 `<img>` 绑定 click → openImageViewer | P2 |
| **预览区链接安全** | 预览区 `<a href="javascript:...">` 客户端消毒已拦截，但可再加一层 `target=_blank` | P1 |
| **公告模块是否也加分屏预览** | 当前公告 textarea 较小（2000 字上限），可后续评估 | P2 |
