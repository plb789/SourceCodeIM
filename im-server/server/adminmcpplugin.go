// ===== 阶段一百一十三：MCP 插件市场清单管理（TRAE CN 同款插件市场，服务端归口） =====
// 职责：
//  1. 清单表懒迁移 + 空表自动播种内置默认插件（8 个常用 MCP server 预设，admin 可改可删可增）
//  2. admin CRUD：/admin/api/mcp/plugins（adminGuard 归口，路由注册见 admin.go）
//  3. 用户端公开只读拉取：GET /api/mcp/plugins（仅返回上架条目，清单本身无敏感数据；
//     PC 端设置页"插件市场"同源 fetch 展示 + 一键安装——安装即写入本机 MCP 配置并自动建连）
package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// mcpPluginSeedOnce 播种只执行一次（并发请求下防重复播种）
var mcpPluginSeedOnce sync.Once

// mcpPluginEnsure 懒迁移 + 空表播种（首次访问插件接口时执行，与 agentrun 模块内 AutoMigrate 同款模式）
func mcpPluginEnsure() {
	mcpPluginSeedOnce.Do(func() {
		if err := store.DB.AutoMigrate(&model.MCPPlugin{}); err != nil {
			logger.Error("MCP 插件表迁移失败: %v", err)
			return
		}
		var count int64
		if err := store.DB.Model(&model.MCPPlugin{}).Count(&count).Error; err != nil || count > 0 {
			return // 查询失败或已有数据：不播种（管理员数据优先）
		}
		for i := range mcpPluginDefaults {
			rec := mcpPluginDefaults[i]
			if err := store.DB.Create(&rec).Error; err != nil {
				logger.Error("播种内置 MCP 插件 %s 失败: %v", rec.Name, err)
			}
		}
		logger.Info("内置 MCP 插件播种完成：共 %d 个（后台管理 → MCP 插件库 可维护）", len(mcpPluginDefaults))
	})
}

// mcpPluginDefaults 内置默认插件（与 PC 端插件库预设同源；服务端归口后以本表为准，admin 可在线调整）
var mcpPluginDefaults = []model.MCPPlugin{
	{Name: "filesystem", Title: "文件系统访问", Category: "文件系统", Sort: 10, Command: "npx",
		Args: "-y\n@modelcontextprotocol/server-filesystem\nD:\\workspace", NeedsConfig: true,
		Description: "AI 读写指定目录内的文件与目录树（Node 系）。安装时把参数最后一行改为你要授权的目录。"},
	{Name: "fetch", Title: "网页抓取", Category: "网络", Sort: 20, Command: "uvx",
		Args:        "mcp-server-fetch",
		Description: "AI 联网抓取网页并转为 Markdown（Python 系，需 uv 工具链，首次安装自动下载）。"},
	{Name: "memory", Title: "长期记忆", Category: "工具", Sort: 30, Command: "npx",
		Args:        "-y\n@modelcontextprotocol/server-memory",
		Description: "AI 跨对话记住要点并按需回忆（Node 系，知识图谱式存储）。"},
	{Name: "mysql", Title: "MySQL 数据库查询", Category: "数据库", Sort: 40, Command: "npx",
		Args: "-y\n@benborla29/mcp-server-mysql",
		Env:  "MYSQL_HOST=127.0.0.1\nMYSQL_PORT=3306\nMYSQL_USER=root\nMYSQL_PASS=你的密码\nMYSQL_DB=你的数据库", NeedsConfig: true,
		Description: "对 MySQL 库执行 SQL 查询（Node 系）。安装时请补全环境变量中的连接信息，建议只读账号。"},
	{Name: "sqlite", Title: "SQLite 数据库查询", Category: "数据库", Sort: 50, Command: "uvx",
		Args: "mcp-server-sqlite\n--db-path\nD:\\data\\demo.db", NeedsConfig: true,
		Description: "查询本地 SQLite 数据库文件（Python 系，需 uv 工具链）。安装时把参数改为你的 .db 文件路径。"},
	{Name: "postgres", Title: "PostgreSQL 数据库查询", Category: "数据库", Sort: 60, Command: "npx",
		Args: "-y\n@modelcontextprotocol/server-postgres",
		Env:  "POSTGRES_CONNECTION_STRING=postgresql://用户:密码@127.0.0.1:5432/数据库名", NeedsConfig: true,
		Description: "对 PostgreSQL 库执行只读 SQL 查询（Node 系）。安装时请补全连接串，建议只读账号。"},
	{Name: "github", Title: "GitHub 仓库管理", Category: "网络", Sort: 70, Command: "npx",
		Args: "-y\n@modelcontextprotocol/server-github",
		Env:  "GITHUB_TOKEN=你的令牌", NeedsConfig: true,
		Description: "管理 GitHub 仓库/Issue/PR（Node 系）。安装时请补全个人访问令牌（GitHub → Settings → Developer settings）。"},
	{Name: "everything", Title: "链路测试服务器", Category: "工具", Sort: 80, Command: "npx",
		Args:        "-y\n@modelcontextprotocol/server-everything",
		Description: "官方测试服务器：回显/计数/文件模拟等演示工具，用于验证本机 MCP 链路是否正常（Node 系）。"},
	{Name: "file-server", Title: "文件服务器检索", Category: "网络", Sort: 90, Command: "npx",
		Args: "-y\nim-file-server-mcp", NeedsConfig: true,
		Env:  "FILE_API_URL=http://你的文件服务器地址\nFILE_API_TOKEN=",
		Description: "连接自有文件服务器 REST API，AI 按关键词检索资料/获取文件内容/分页列出清单（包装器源码见项目 tools/file-server-mcp，发布 npm 包后即可一键安装）。安装时请补填 API 地址与访问令牌。"},
}

// adminMCPPluginReq 插件编辑请求体（字段与 model 一致，Args/Env 为多行文本原样保存）
type adminMCPPluginReq struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Command     string `json:"command"`
	Args        string `json:"args"`
	Env         string `json:"env"`
	NeedsConfig bool   `json:"needs_config"`
	Icon        string `json:"icon"` // 图标链接（http/https 图片 URL，留空降级首字母徽标）
	Sort        int    `json:"sort"`
	Enabled     bool   `json:"enabled"`
}

// mcpPluginValidate 编辑请求校验归口（新增与编辑共用；name 唯一性由 DB uniqueIndex 兜底）
func mcpPluginValidate(req *adminMCPPluginReq) string {
	req.Name = strings.TrimSpace(req.Name)
	req.Title = strings.TrimSpace(req.Title)
	req.Command = strings.TrimSpace(req.Command)
	if req.Name == "" {
		return "插件名不能为空（安装时作为本机服务器名，仅限字母数字下划线连字符）"
	}
	if len(req.Name) > 64 {
		return "插件名过长（≤64 字符）"
	}
	if req.Title == "" {
		return "展示标题不能为空"
	}
	if req.Command == "" {
		return "启动命令不能为空（如 npx / uvx / node）"
	}
	if len(req.Description) > 512 {
		return "描述过长（≤512 字符）"
	}
	if len(req.Args) > 1024 {
		return "命令参数过长（≤1024 字符）"
	}
	if len(req.Env) > 1024 {
		return "环境变量过长（≤1024 字符）"
	}
	req.Icon = strings.TrimSpace(req.Icon)
	if req.Icon != "" && !strings.HasPrefix(req.Icon, "http://") && !strings.HasPrefix(req.Icon, "https://") {
		return "图标链接必须以 http:// 或 https:// 开头（留空则显示首字母徽标）"
	}
	if len(req.Icon) > 512 {
		return "图标链接过长（≤512 字符）"
	}
	return ""
}

// handleAdminMCPPluginList 后台插件清单（含未上架条目，编辑需要）
func (s *Server) handleAdminMCPPluginList(w http.ResponseWriter, r *http.Request) {
	mcpPluginEnsure()
	var list []model.MCPPlugin
	if err := store.DB.Order("sort ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询插件清单失败")
		return
	}
	adminJSON(w, map[string]interface{}{"plugins": list})
}

// handleAdminMCPPluginCreate 新增插件
func (s *Server) handleAdminMCPPluginCreate(w http.ResponseWriter, r *http.Request) {
	mcpPluginEnsure()
	var req adminMCPPluginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := mcpPluginValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	var dup int64
	store.DB.Model(&model.MCPPlugin{}).Where("name = ?", req.Name).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusConflict, "插件名已存在："+req.Name)
		return
	}
	rec := model.MCPPlugin{Name: req.Name, Title: req.Title, Description: req.Description, Category: req.Category,
		Command: req.Command, Args: req.Args, Env: req.Env, NeedsConfig: req.NeedsConfig, Icon: req.Icon, Sort: req.Sort, Enabled: req.Enabled}
	if err := store.DB.Create(&rec).Error; err != nil {
		logger.Error("新增 MCP 插件 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "新增插件失败（名称可能重复）")
		return
	}
	logger.Info("后台管理：新增 MCP 插件 %s（%s）", rec.Name, rec.Command)
	adminJSON(w, map[string]interface{}{"id": rec.ID})
}

// handleAdminMCPPluginUpdate 编辑插件
func (s *Server) handleAdminMCPPluginUpdate(w http.ResponseWriter, r *http.Request) {
	mcpPluginEnsure()
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.MCPPlugin
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "插件不存在")
		return
	}
	var req adminMCPPluginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		adminFail(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if msg := mcpPluginValidate(&req); msg != "" {
		adminFail(w, http.StatusBadRequest, msg)
		return
	}
	var dup int64
	store.DB.Model(&model.MCPPlugin{}).Where("name = ? AND id <> ?", req.Name, rec.ID).Count(&dup)
	if dup > 0 {
		adminFail(w, http.StatusConflict, "插件名已存在")
		return
	}
	rec.Name, rec.Title, rec.Description, rec.Category = req.Name, req.Title, req.Description, req.Category
	rec.Command, rec.Args, rec.Env = req.Command, req.Args, req.Env
	rec.NeedsConfig, rec.Icon, rec.Sort, rec.Enabled = req.NeedsConfig, req.Icon, req.Sort, req.Enabled
	if err := store.DB.Save(&rec).Error; err != nil {
		logger.Error("编辑 MCP 插件 %s 失败: %v", rec.Name, err)
		adminFail(w, http.StatusInternalServerError, "保存插件失败")
		return
	}
	logger.Info("后台管理：编辑 MCP 插件 %s", rec.Name)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleAdminMCPPluginDelete 删除插件（仅删清单条目，不影响用户已安装的本机配置）
func (s *Server) handleAdminMCPPluginDelete(w http.ResponseWriter, r *http.Request) {
	mcpPluginEnsure()
	id, ok := adminPathID(w, r)
	if !ok {
		return
	}
	var rec model.MCPPlugin
	if err := store.DB.First(&rec, id).Error; err != nil {
		adminFail(w, http.StatusNotFound, "插件不存在")
		return
	}
	if err := store.DB.Delete(&rec).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "删除插件失败")
		return
	}
	logger.Info("后台管理：删除 MCP 插件 %s", rec.Name)
	adminJSON(w, map[string]interface{}{"ok": true})
}

// handleMCPPluginPublicList 用户端公开只读拉取（仅上架条目；无需鉴权——清单为公开目录数据，不含凭据）
func (s *Server) handleMCPPluginPublicList(w http.ResponseWriter, r *http.Request) {
	mcpPluginEnsure()
	var list []model.MCPPlugin
	if err := store.DB.Where("enabled = ?", true).Order("sort ASC, id ASC").Find(&list).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询插件清单失败")
		return
	}
	adminJSON(w, map[string]interface{}{"plugins": list})
}
