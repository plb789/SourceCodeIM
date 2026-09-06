# 阶段四十六：OnlyOffice 在线文档编辑（docx/xlsx/pptx）

## Context

聊天中的文件消息（msg_type=5）和 AI 文档信封（`{"doc":url,...}`）目前点击只能下载（[chat.js L3412](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L3412)、[L4376](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L4376)、[L4033](file:///e:/SourceCodeIM/im-client/web/js/chat.js#L4033)）。目标：与豆包一致，点击 docx/xlsx/pptx 直接在自研弹窗中在线编辑；保存生成新版本（原文件保留），其余类型保持原下载行为。

技术路线：自建 OnlyOffice Document Server（Windows 版，本机无 Docker），im-server 签发 JWT 配置 + 提供回源下载/保存回调；前端 iframe 嵌入编辑器。默认 `enabled: false`，未部署时行为完全不变（零回归风险）。

## 关键设计决定（已按官方文档校正）

1. **JWT 结构**：HS256，**config 字段位于 claims 顶层**（不是包在 "payload" claim 里），官方要求 token payload 与 config 同构；校验用 `jwt.WithValidMethods([]string{"HS256"})`。
2. **document.url 统一指向 `/doc/download?msg_id=<N>`**（不指向原始静态 URL），由服务端归口解析最新版本（`im_doc_edit.latest_url` 优先，无记录回退 content.url），避免打开旧版本。
3. **版本表 `im_doc_edit`**（msg_id 唯一）：latest_url + version；每次回调保存 version++，`document.key = doc_<msgid>_v<version>` 随版本变化防 DS 缓存；同 key 打开即协同编辑。
4. **双鉴权** `/doc/download`：Bearer JWT（DS 回源）或 `?username=`（消息归属校验，供弹窗"下载"按钮用）。
5. **msg_id 点击时从 DOM 解析**：`bubble.closest('.message').getAttribute('data-msg-id')`——实时文件气泡渲染时 msg_id 尚未回填（FILE_PERSISTED 后只改 DOM 属性），闭包拿不到。
6. 已知边界（写入注释）：两人同时编辑时后保存者覆盖（last-write-wins）；DS 回调所有 status 分支都返回 `{"error":0}`。

## 实现步骤

### 服务端（im-server）

1. **依赖**：`go get github.com/golang-jwt/jwt/v5`（go 1.25.8 兼容，零冲突）。
2. **[config/config.go](file:///e:/SourceCodeIM/im-server/config/config.go)**：新增 `OnlyOfficeConfig{Enabled, APIURL, ServerURL, JWTSecret}` 字段（yaml 键 `onlyoffice`）；`Load()` 末尾兜底：Enabled 但三项任一为空 → 强制 Enabled=false。
3. **[model/model.go](file:///e:/SourceCodeIM/im-server/model/model.go)**：新增 `DocEdit` 模型（表 `im_doc_edit`：msg_id uniqueIndex / latest_url / version / update_time）。
4. **[store/mysql.go](file:///e:/SourceCodeIM/im-server/store/mysql.go) L32**：AutoMigrate 追加 `&model.DocEdit{}`。
5. **新建 `server/onlyoffice.go`**（全部中文注释）：
   - `ooEditableExt(ext)`：白名单 docx/xlsx/pptx；`ooDocumentType(ext)`：word/cell/slide。
   - `ooResolveDoc(msgID, username)`：校验消息归属（`username==FromUser||==ToUser||群聊 ToUser==""`）、未撤回（recalled 拒绝）、解析 content 拿 url/name（msg_type=5 或 doc 信封）、解析最新文件路径（basename 防目录穿越，必须在 UploadDir 下）。
   - `ooSignToken` / `ooVerifyToken`：HS256 签发/校验工具。
   - `HandleDocEditor`（GET /doc/editor）：校验→查版本→构建编辑器配置（document.url=`<ServerURL>/doc/download?msg_id=`、key=`doc_<msgid>_v<ver>`、callbackUrl、customization.forcesave=true、lang=zh-CN、permissions.edit）→ 签 token → 返回 `{config, api_url}`。
   - `HandleDocDownload`（GET /doc/download）：双鉴权 → ServeFile。
   - `HandleDocCallback`（POST /doc/callback）：验 JWT（claims 顶层即回调体）→ status∈{2,6} 时下载 body.url（`http.Client{Timeout:120s}`）→ 存为新文件（沿用 `时间戳_随机hex.ext` 命名）→ upsert im_doc_edit（version++）→ 返回 `{"error":0}`。
6. **[main.go](file:///e:/SourceCodeIM/im-server/main.go)**：`/export/ai/word` 后注册 `/doc/editor`、`/doc/download`、`/doc/callback`。
7. **[bin/config.yaml](file:///e:/SourceCodeIM/im-server/bin/config.yaml)** 末尾追加 onlyoffice 段（enabled:false 默认关闭）。

### 前端（im-client/web）

8. **[index.html](file:///e:/SourceCodeIM/im-client/web/index.html)**：新增自研弹窗 DOM（遮罩 `#doc-editor-mask` + 窗口 `#doc-editor-window` + 标题栏[文件名/下载/关闭] + `#doc-editor-placeholder` 挂载点），对齐现有 `modal-mask` 模式；style.css → `?v=1.46`、chat.js → `?v=1.84`。
9. **[chat.js](file:///e:/SourceCodeIM/im-client/web/js/chat.js)** 新增：
   - `isEditableDocName(name)`、`ensureDocsAPI(cb)`（懒加载 api.js，8s 超时）、`openDocEditor(msgId, name)`（fetch /doc/editor → new DocsAPI.DocEditor；失败回退下载+toast）、`closeDocEditor()`（**必须 `destroyEditor()`** 释放 DS 会话）、`onFileCardClick(bubbleEl, msgId, name, url)`（点击时从 DOM 解析 msg_id；`blob:` URL 不作编辑依据）。
   - 三处点击点改造：历史文件卡片 L3412、实时 appendFileMsg L4376、AI doc 卡片 L4033（可编辑且 msg_id>0 → 编辑器，否则原行为）。
10. **[css/style.css](file:///e:/SourceCodeIM/im-client/web/css/style.css)**：弹窗样式（90vw×88vh 居中、遮罩、标题栏用 `var(--primary)` 主题色，深浅主题自适应）。

### 部署清单（写入 /docs/开发文档.md 阶段四十六节）

1. 安装 Windows 版 ONLYOFFICE Docs（记录端口）。
2. 改 `%ProgramFiles%\ONLYOFFICE\DocumentServer\config\local.json`：token.enable 三项 true、secret.inbox/outbox/session.string 设为同一密钥（与 config.yaml jwt_secret 一致）、`request-filtering-agent.allowPrivateIPAddress=true` 与 `allowMetaIPAddress=true`（否则 DS 拉不了 127.0.0.1 回源，典型坑）。
3. 重启 ONLYOFFICE 相关 Windows 服务；浏览器访问欢迎页确认。
4. config.yaml 填 api_url（如 `http://127.0.0.1:8080/web-apps/apps/api/documents/api.js`）、server_url、jwt_secret，`enabled: true`，重启 im-server。

## 验证

1. `cd im-server && go build ./...`，编译通过（编码 UTF-8 无 BOM 校验）。
2. 双账号实测：A 发 docx → 双方点击卡片出弹窗（确认无系统弹窗）；A 编辑 Ctrl+S → upload 目录新增文件、im_doc_edit version=1 → 关闭重开显示新内容；B 点击同一消息拿到最新版。
3. 同消息 A、B 同时打开 → 协同实时同步。
4. 回归：pdf/png/zip 点击仍直接下载；撤回的 docx 拒绝编辑；未启用 OnlyOffice（enabled:false）时所有文件点击行为与改造前完全一致；AI 会话 txt/md 信封仍 window.open。
5. 伪密钥测试：local.json 改错密钥 → 编辑器报错（JWT 校验生效）。
6. 移动端 Capacitor 仅验证可打开；若 iframe 混合内容白屏（androidScheme https），记录为已知限制。

## 关键文件清单

- 新建：`im-server/server/onlyoffice.go`
- 修改：`im-server/config/config.go`、`im-server/model/model.go`、`im-server/store/mysql.go`、`im-server/main.go`、`im-server/bin/config.yaml`
- 修改：`im-client/web/index.html`、`im-client/web/js/chat.js`、`im-client/web/css/style.css`
- 文档：`/docs/开发文档.md`（新增阶段四十六节）
