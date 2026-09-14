# im-file-server-mcp

把自有文件服务器的 REST API 包装成 MCP（stdio）工具，供 IM 客户端智能体调用（插件市场一键安装 / agent_mcp.json 手动配置）。

## 提供的工具

| 工具 | 说明 | 默认对接接口 |
|---|---|---|
| search_docs | 按关键词检索资料 | `GET {FILE_API_URL}/api/search?q=关键词&limit=N` |
| get_file | 按文件 id 获取详情/内容 | `GET {FILE_API_URL}/api/files/{id}` |
| list_files | 分页列出文件清单 | `GET {FILE_API_URL}/api/files?page=N&size=M` |

接口路径可用环境变量改写（`FILE_API_SEARCH_PATH` / `FILE_API_FILE_PATH` / `FILE_API_LIST_PATH`）。
返回文本单次 8000 字符封顶。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| FILE_API_URL | 是 | 文件服务器根地址（如 `http://192.168.1.100:9000`） |
| FILE_API_TOKEN | 否 | Bearer 令牌（有值自动挂 `Authorization` 头） |
| FILE_API_*_PATH | 否 | 三个接口路径改写（默认值见上表） |

## 本地调试

```bash
npm install
set FILE_API_URL=http://你的文件服务器地址
node index.js
```

进程启动后即在标准输入输出上等待 MCP JSON-RPC 握手（由客户端作为子进程拉起管理，无需手动交互）。

## 发布为 npm 包（插件市场分发）

```bash
# 1. 注册/登录 npm 账号（npmjs.com），如需组织包先创建 organization
npm login
# 2. 按需修改 package.json 的 name（如 @yourorg/file-server-mcp）与 version
npm publish
```

发布后：管理后台 → MCP 插件管理 → 新增，command 填 `npx`，Args 每行一个：`-y`、`im-file-server-mcp`（或你的包名），Env 预填 `FILE_API_URL=` 模板，勾选 NeedsConfig 让用户安装时补填地址与令牌。
