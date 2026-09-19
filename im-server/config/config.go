package config

import (
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config 服务端全局配置
type Config struct {
	// WebSocket 监听地址
	WSAddr string `yaml:"ws_addr"`
	// 心跳超时时间（秒）
	HeartbeatTimeout int `yaml:"heartbeat_timeout"`
	// 心跳发送间隔（秒，客户端侧）
	HeartbeatInterval int `yaml:"heartbeat_interval"`
	// 文件分片大小（字节）
	ChunkSize int `yaml:"chunk_size"`
	// 最大在线连接数
	MaxConnections int `yaml:"max_connections"`
	// 消息撤回时间窗口（秒），仅该窗口内的消息可撤回
	RecallWindow int `yaml:"recall_window"`
	// 阶段一四五：注册开关（后台 config.yaml 归口）
	// true  = 登录时账号不存在自动注册（保留"首次登录即注册"默认行为），独立注册页亦可正常注册
	// false = 登录不再自动注册，账号不存在时提示"该账号不存在，请先注册账号"引导用户前往注册页；
	//         独立注册页（register.html）始终可用，注册链路经 REGISTER 信令显式完成
	RegisterEnabled bool `yaml:"register_enabled"`
	// 阶段一百三十六：PC 前端资源密文下发密钥（AES-256-GCM，64 位 hex = 32 字节）
	// 留空时 /api/secure-file 密文接口停用（返回 503），PC 端自动回退明文链路
	// 与 PC 构建期注入密钥（secure-key.js 掩码扰乱）同源，明文仅存本文件不下发
	SecureFileKey string `yaml:"secure_file_key"`
	// 前端静态目录（web_dir，缺省时从 exe 所在目录逐级向上查找 im-client/web，相对路径基于 exe 所在目录解析）
	WebDir string `yaml:"web_dir"`
	// 阶段二十四：聊天文件持久化存储目录（相对路径基于 exe 所在目录解析，缺省时基于 WebDir 推导，位于前端静态目录内可直接 URL 访问）
	UploadDir string `yaml:"upload_dir"`
	// 阶段二十四：聊天文件持久化大小上限（字节）
	MaxFileSize int `yaml:"max_file_size"`
	// 阶段三十一：单连接发送队列缓冲条数（文件分片与聊天消息共用，过小会挤爆队列导致丢消息）
	SendQueueSize int `yaml:"send_queue_size"`
	// 阶段三十一：大文件直传阈值（字节）：文件超过该值走 HTTP 直传链路，WebSocket 仅传信令，避免海量分片占用连接
	HttpUploadThreshold int `yaml:"http_upload_threshold"`
	// 阶段三十二：超大文件分片直传的单片大小（字节）：超过 MaxFileSize 的文件按该值分片逐片 HTTP 上传
	UploadChunkSize int `yaml:"upload_chunk_size"`
	// 阶段三十二：分片直传文件大小上限（字节）：超过该值前端直接拒绝（默认 2GB）
	MaxDirectSize int `yaml:"max_direct_size"`

	// MySQL 配置
	MySQLDSN string `yaml:"mysql_dsn"`
	// Redis 配置
	RedisAddr     string `yaml:"redis_addr"`
	RedisPassword string `yaml:"redis_password"`
	RedisDB       int    `yaml:"redis_db"`

	// 阶段四十三：AI 问答配置（服务端归口：API 地址与密钥仅存服务端配置文件，客户端不接触密钥）
	AI AIConfig `yaml:"ai"`

	// 阶段八十八：MCP（Model Context Protocol）功能配置（服务端归口，TRAE CN 同款 MCP 能力）
	MCP MCPConfig `yaml:"mcp"`

	// 阶段四十九：后台管理——管理员用户名白名单（启动时自动标记 im_user.role=1；
	// 管理登录时同时实时比对白名单，未注册账号首次登录 IM 注册后下次启动补标记）
	AdminUsers []string `yaml:"admin_users"`

	// 阶段四十六：OnlyOffice 在线文档编辑配置（服务端归口：JWT 密钥仅存 config.yaml，不下发客户端）
	OnlyOffice OnlyOfficeConfig `yaml:"onlyoffice"`

	// 阶段一百四十二：内置 TURN/STUN 中继服务（server/turn.go，音视频通话 P2P 打洞失败时的媒体中继兜底）
	Turn TurnConfig `yaml:"turn"`
}

// TurnConfig 阶段一百四十二：TURN/STUN 中继配置节（基于 pion/turn，与 im-server 同进程零额外部署）
// 使用前提：im-server 部署在公网 IP 服务器上，防火墙/安全组放行 port(UDP+TCP) 与 min_port~max_port(UDP)
type TurnConfig struct {
	// Enabled 总开关（默认 false 不启动，零开销零回归）
	Enabled bool `yaml:"enabled"`
	// PublicIP 中继对外报告的 IP（NAT 后部署必填公网 IP；缺省回退本机首个非回环 IPv4，仅适配单公网 IP 直挂）
	PublicIP string `yaml:"public_ip"`
	// Port STUN/TURN 监听端口（0=3478，UDP+TCP 双栈）
	Port int `yaml:"port"`
	// Realm 凭证域（0=im-server；参与长期凭证 MD5 计算，客户端配置需一致）
	Realm string `yaml:"realm"`
	// Username/Password 长期凭证账号（RFC 5766；仅允许该账号 Allocation，缺一启动报错）
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	// MinPort/MaxPort 媒体中继 UDP 端口段（0=49160-49200，需放行安全组）
	MinPort int `yaml:"min_port"`
	MaxPort int `yaml:"max_port"`
}

// OnlyOfficeConfig OnlyOffice Document Server 对接配置（自建 Windows/Docker 版）
type OnlyOfficeConfig struct {
	// Enabled 是否启用在线编辑（false 时前端点击文件保持原下载行为，零回归）
	Enabled bool `yaml:"enabled"`
	// APIURL 浏览器加载编辑器 api.js 的完整地址（DocumentServer 对浏览器可见的地址）
	APIURL string `yaml:"api_url"`
	// ServerURL DocumentServer 回源拉取/保存文档时访问 im-server 的地址（需与 DS 网络互通）
	ServerURL string `yaml:"server_url"`
	// JWTSecret 与 DocumentServer local.json 中三处 secret 一致的服务端 JWT 密钥
	JWTSecret string `yaml:"jwt_secret"`
}

// AIProviderConfig AI 模型服务提供方（OpenAI 兼容 chat/completions 接口，可接 DeepSeek/Kimi/智谱/通义等）
type AIProviderConfig struct {
	Name   string `yaml:"name"`    // 提供方名称（智能体通过该名称绑定模型服务）
	APIURL string `yaml:"api_url"` // chat/completions 完整接口地址
	APIKey string `yaml:"api_key"` // API 密钥（仅存服务端）
	Model  string `yaml:"model"`   // 模型名（如 deepseek-chat / glm-4-flash）
	// VisionModel 视觉模型名（选填）：文本/视觉分立的模型（如 deepseek-v4-flash-vision-exp）填此字段，
	// 带图提问时服务端自动路由，纯文本仍走主模型；为空统一走主模型
	VisionModel string `yaml:"vision_model"`
	// SupportsImage 模型是否支持图片识别（多模态，如 glm-4v/qwen-vl/gpt-4o）。
	// 阶段四十四：为 true 时绑定的智能体开放图片提问入口，服务端按 OpenAI 兼容多模态
	// 格式（content 数组：text + image_url data URL）调模型；false 时前端隐藏发图入口，
	// 服务端对图片提问直接拒绝（双保险）
	SupportsImage bool `yaml:"supports_image"`
}

// AIAgentConfig AI 智能体（面向用户的聊天助手，绑定模型服务与系统提示词）
type AIAgentConfig struct {
	Name         string `yaml:"name"`          // 智能体名称（会话列表展示名，需全局唯一）
	Provider     string `yaml:"provider"`      // 绑定的提供方名称（缺省或未命中时使用本地 Mock 应答）
	SystemPrompt string `yaml:"system_prompt"` // 系统提示词（人设/能力定义）
	Avatar       string `yaml:"avatar"`        // 头像 URL（缺省时前端回退 emoji 占位）
}

// EmbeddingConfig 阶段五十一：知识库向量化 embedding 服务配置（OpenAI 兼容 /embeddings 接口归口）
// DeepSeek 不提供 embedding API，可接任意兼容服务（硅基流动 bge-m3 / 智谱 embedding-3 / 本地 ollama 等）
type EmbeddingConfig struct {
	APIURL    string `yaml:"api_url"`    // 完整接口地址（如 https://api.siliconflow.cn/v1/embeddings）
	APIKey    string `yaml:"api_key"`    // API 密钥（仅存服务端，不下发客户端）
	Model     string `yaml:"model"`      // 向量模型名（如 BAAI/bge-m3）
	BatchSize int    `yaml:"batch_size"` // 单次请求批量条数（0=16）
}

// KBConfig 阶段五十一：知识库配置（切片/检索参数与数据目录，config 归口避免硬编码）
type KBConfig struct {
	ChunkSize      int     `yaml:"chunk_size"`      // 切片字符数（0=500）
	ChunkOverlap   int     `yaml:"chunk_overlap"`   // 相邻切片重叠字符（0=50）
	TopK           int     `yaml:"top_k"`           // AI 对话注入条数（0=3）
	MaxContext     int     `yaml:"max_context"`     // 注入文本总长上限字符（0=4000）
	ScoreThreshold float64 `yaml:"score_threshold"` // 阶段五十二：命中相似度阈值（0=不过滤；低于阈值的命中视为不相关不注入，不同 embedding 服务分布不同需按实测调整）
	DataDir        string  `yaml:"data_dir"`        // 知识文件与向量库根目录（空=exe目录/data/kb，锚定 exe 解析）
}

// UserAgentConfig 阶段五十七：用户自建智能体配置（模型白名单归口，防费用失控；enabled=false 时功能整体关闭）
type UserAgentConfig struct {
	Enabled     bool     `yaml:"enabled"`      // 用户自建智能体总开关（false 时用户侧接口返回明确提示）
	Providers   []string `yaml:"providers"`    // 用户可选模型服务白名单（provider 名，须与已启用的模型服务名匹配）
	MaxPerUser  int      `yaml:"max_per_user"` // 每人自建数量上限（0=10）
	PromptLimit int      `yaml:"prompt_limit"` // 提示词最大字符数（0=2000）
}

// MemoryConfig 阶段五十八：智能体长期记忆配置（提取-去重-存储-注入-管理五环；关闭/降级时全链路静默，不影响聊天）
type MemoryConfig struct {
	Enabled         bool    `yaml:"enabled"`          // 总开关（false 时不提取不注入，管理接口仍可查看已存记忆）
	TopK            int     `yaml:"top_k"`            // 每次提问注入的召回记忆条数（0=5）
	MaxPerAgent     int     `yaml:"max_per_agent"`    // 每 用户+智能体 记忆条数上限，超出淘汰最旧（0=200）
	DedupThreshold  float64 `yaml:"dedup_threshold"`  // 去重相似度阈值（0=0.85，与已有记忆最高相似度达阈值则跳过）
	ExtractProvider string  `yaml:"extract_provider"` // 提取用模型服务名（留空=用智能体当前绑定模型；建议填本地 ollama 零成本）
}

// AgentConfig 阶段五十九：智能 Agent 自动化任务配置（工具调用闭环+权限审批；enabled=false 时功能整体关闭）
type AgentConfig struct {
	Enabled               bool     `yaml:"enabled"`                 // 总开关（false 时 AGENT_RUN 返回明确提示）
	MaxSteps              int      `yaml:"max_steps"`               // 单任务最大迭代步数（0=30，防模型死循环）
	ToolTimeoutSeconds    int      `yaml:"tool_timeout_seconds"`    // 命令执行默认超时秒（0=60，上限 300）
	ApproveTimeoutSeconds int      `yaml:"approve_timeout_seconds"` // 高危工具审批等待超时秒（0=300，超时任务挂起）
	AutoWrite             bool     `yaml:"auto_write"`              // write_file 是否免审批（默认 false 走审批；内网信任环境可开）
	AutoCommands          []string `yaml:"auto_commands"`           // run_command 命令前缀白名单（命中自动放行，其余强制审批）
	WorkspaceRoot         string   `yaml:"workspace_root"`          // 工作区根目录（空=exe目录/agent_workspace，按 username 隔离子目录）
	// PcExecutor 阶段六十：本地执行器开关——true 时用户 PC 端在线，文件/命令工具下放到其电脑本地执行
	// （文件直接落在用户磁盘 %APPDATA%/即时通讯/agent_workspace/<用户名>/；PC 离线或执行超时自动回退服务端工作区）
	PcExecutor bool `yaml:"pc_executor"`
	// Concurrency 阶段六十七：每用户同时运行任务数上限（0=1；超过上限的新任务进入排队）
	Concurrency int `yaml:"concurrency"`
	// QueueSize 阶段六十七：每用户排队任务数上限（0=5；排队已满时新任务直接拒绝）
	QueueSize int `yaml:"queue_size"`
	// HttpEnabled 阶段六十八：http_request 工具开关（nil=默认开启；服务端代理 HTTP 接口调用/数据查询/网页抓取）
	HttpEnabled *bool `yaml:"http_enabled"`
	// HttpAllowPrivate 阶段六十八：是否允许 http_request 访问内网/回环地址（nil=默认允许，内网信任部署；
	// 显式 false 时在拨号层拦截私网/回环/链路本地 IP，防模型被诱导探测内网——DNS 解析后的真实 IP 拦截，域名绕不过）
	HttpAllowPrivate *bool `yaml:"http_allow_private"`
	// PCBrowser 阶段九十一：内置浏览器工具开关（nil=默认开启；TRAE CN 同款内置浏览区——
	// browser_* 工具族经 PC 端 WebContentsView 在用户电脑本地执行，能操作登录态/JS 渲染页面；
	// false 时 browser_* 不注入不执行，http_request 等服务端工具不受影响）
	PCBrowser *bool `yaml:"pc_browser"`
	// WebSearch 阶段六十八：web_search 联网搜索配置（多服务商，默认关闭须显式开启）
	WebSearch WebSearchConfig `yaml:"web_search"`
	// ToolResultMaxChars 阶段八十四：工具结果写入模型上下文的字符上限（TRAE 同款上下文瘦身；
	// 超长保留头 2/3 + 尾 1/3 并留省略标注，前端执行控制台仍显示全量）。0=默认 8000，负数=不截断
	ToolResultMaxChars int `yaml:"tool_result_max_chars"`
}

// WebSearchConfig 阶段六十八：Agent 联网搜索服务商配置（web_search 工具归口）
type WebSearchConfig struct {
	// Enabled 总开关（nil=默认关闭；须配置 provider 后开启，避免未配置时模型反复调用失败浪费步数）
	Enabled *bool `yaml:"enabled"`
	// Provider 搜索服务商：tavily / bocha / searxng / duckduckgo
	Provider string `yaml:"provider"`
	// APIKey tavily/bocha 需要的 API Key（searxng/duckduckgo 留空）
	APIKey string `yaml:"api_key"`
	// Endpoint searxng 自建实例地址（如 http://127.0.0.1:8889；其他服务商留空）
	Endpoint string `yaml:"endpoint"`
}

// MCPServerConfig 阶段八十八：MCP 服务器种子配置（config.yaml 归口，仅首次启动表空时导入
// im_mcp_server 表，之后以后台管理配置为唯一数据源，与 AI providers 种子导入同款策略）
type MCPServerConfig struct {
	Name      string            `yaml:"name"`      // 服务器名（全局唯一）
	Transport string            `yaml:"transport"` // stdio / sse / http
	Command   string            `yaml:"command"`   // stdio：可执行命令（如 npx）
	Args      []string          `yaml:"args"`      // stdio：命令参数
	Env       map[string]string `yaml:"env"`       // stdio：附加环境变量
	URL       string            `yaml:"url"`       // sse/http：完整端点地址
	Headers   map[string]string `yaml:"headers"`   // sse/http：附加请求头（如 Authorization）
	Enabled   *bool             `yaml:"enabled"`   // 缺省启用
}

// MCPConfig 阶段八十八：MCP（Model Context Protocol）功能配置节
type MCPConfig struct {
	// Enabled 总开关：false 时连接管理器断开全部会话，MCP 工具不参与 AI 对话（后台已配置的记录保留）
	Enabled bool `yaml:"enabled"`
	// UserEnabled 用户自建 MCP 总开关（阶段八十九开放用户侧入口时生效，先归口配置位）
	UserEnabled bool `yaml:"user_enabled"`
	// StdioWhitelist 用户自建服务器（owner 非空）允许的 stdio 命令白名单（按可执行名精确比对，
	// 兼容 .exe/.cmd/.bat 后缀；空=用户自建 stdio 全部拒绝）。管理员公共服务器（owner 空）不受限——
	// 管理员本就掌控服务端主机，配置面与 config.yaml 同权
	StdioWhitelist []string `yaml:"stdio_whitelist"`
	// ConnectTimeoutSeconds 建连（初始化握手）与工具发现超时秒（0=30）
	ConnectTimeoutSeconds int `yaml:"connect_timeout_seconds"`
	// ToolTimeoutSeconds 单次工具调用超时秒（0=60，阶段八十九 Agent 链路归口使用）
	ToolTimeoutSeconds int `yaml:"tool_timeout_seconds"`
	// Servers 种子服务器列表（仅首次启动导入，之后数据库为唯一数据源）
	Servers []MCPServerConfig `yaml:"servers"`
}

// AIConfig AI 问答配置节
type AIConfig struct {
	Providers []AIProviderConfig `yaml:"providers"` // 模型服务列表（多模型支持）
	Agents    []AIAgentConfig    `yaml:"agents"`    // 智能体列表（用户可选择性聊天）
	// 阶段五十一：知识库向量化通道与参数（embedding 未配置时知识库功能降级关闭，不影响其他功能）
	Embedding EmbeddingConfig `yaml:"embedding"`
	KB        KBConfig        `yaml:"kb"`
	// 阶段五十七：用户自建智能体（个人智能体仅归属者可见可用，模型从白名单中选）
	UserAgent UserAgentConfig `yaml:"user_agent"`
	// 阶段五十八：智能体长期记忆（按 用户+智能体 隔离；回复后异步提取，提问时向量召回注入）
	Memory MemoryConfig `yaml:"memory"`
	// 阶段五十九：智能 Agent 自动化任务（工具调用闭环+权限审批）
	Agent AgentConfig `yaml:"agent"`
	// 多轮对话携带的历史消息条数（按用户+智能体隔离取最近 N 条）
	ContextWindow int `yaml:"context_window"`
	// 限流：单用户在限流窗口内最大提问次数
	LimitCount int `yaml:"limit_count"`
	// 限流窗口（秒）
	LimitWindow int `yaml:"limit_window"`
	// 阶段四十五：文档问答单文档提取文本上限（字符），超出截断，防止超长文档撑爆模型上下文
	DocMaxChars int `yaml:"doc_max_chars"`
	// 阶段八十四：TRAE 同款历史对话压缩触发阈值（估算 token 数，AI 问答与 Agent 任务共用；
	// 历史上下文超过阈值时把较旧部分 LLM 摘要成一条摘要消息注入，仅最近 N 条保留原文）。
	// 0=默认 12000，负数=禁用压缩
	CompressThresholdTokens int `yaml:"compress_threshold_tokens"`
	// 阶段八十四：压缩时保留最近原文消息条数（0=默认 6），更早历史并入摘要；摘要按会话缓存增量合并
	CompressKeepMessages int `yaml:"compress_keep_messages"`
	// 阶段一百三十九：Agent 任务上下文压缩触发阈值（KB，UTF-8 字节口径，与 TRAE CN 状态栏同款；
	// 任务循环上下文累计达到该值触发 LLM 摘要压缩）。仅作用于 Agent 任务，AI 问答仍用 compress_threshold_tokens。
	// 0=默认 200，负数=禁用 Agent 任务压缩
	CompressThresholdKB int `yaml:"compress_threshold_kb"`
}

// Default 返回默认配置，与《开发文档》5.2 核心配置参数保持一致
func Default() *Config {
	return &Config{
		WSAddr:            ":8888",
		HeartbeatTimeout:  90,
		HeartbeatInterval: 30,
		// 原实现：ChunkSize: 4096（4KB 分片在大文件场景产生海量消息与 Redis 操作）
		// 阶段三十一：提升至 64KB（base64 后约 87KB，仍在单条消息 1MB 读取上限内），消息数降 16 倍
		ChunkSize: 65536,
		// 原实现：MaxConnections: 1000（万级在线场景不足）
		// 阶段三十一：提升至 10000，并在 HandleWS 中实际执行校验（原配置项从未被使用）
		MaxConnections: 10000,
		RecallWindow:   120,
		// 阶段一四五：注册开关默认开启（与历史"首次登录即注册"行为一致，存量部署零回归；
		// 需要收紧为"仅显式注册"时在 config.yaml 中置 false）
		RegisterEnabled: true,
		// 原实现：UploadDir: "../im-client/web/static/upload"（相对进程工作目录，从 bin 目录双击 exe 启动会失效）
		// 现改为留空，由 Load 基于 WebDir 推导（锚定 exe 所在目录，任意目录启动均正确）
		UploadDir:   "",
		MaxFileSize: 20 << 20, // 20MB
		// 阶段三十一：发送队列缓冲 1024 条（原实现固定 256，大文件分片易溢出丢消息）
		SendQueueSize: 1024,
		// 阶段三十一：大文件直传阈值 1MB，超过走 HTTP 直传（io.Copy 流式落盘），绕开分片链路
		HttpUploadThreshold: 1 << 20,

		MySQLDSN:      "root:root@tcp(127.0.0.1:3306)/im?charset=utf8mb4&parseTime=True&loc=Local",
		RedisAddr:     "127.0.0.1:6379",
		RedisPassword: "",
		RedisDB:       0,

		// 阶段四十三：AI 问答默认参数（未配置 providers 时使用本地 Mock 应答保证功能可用）
		AI: AIConfig{
			ContextWindow: 20,
			LimitCount:    10,
			LimitWindow:   60,
			// 阶段四十五：文档问答默认提取上限 60000 字
			DocMaxChars: 60000,
		},

		// 阶段八十八：MCP 默认开启（未配置服务器时空转零开销；超时由 server/mcp.go 兜底）
		MCP: MCPConfig{Enabled: true},
	}
}

// Load 加载配置：先取默认值，再按候选路径读取 config.yaml 覆盖（文件不存在时使用默认值）
// 候选路径依次为：当前工作目录、当前工作目录下的 bin 目录（兼容从服务端根目录与 bin 目录两种启动方式），不硬编码绝对路径
func Load() *Config {
	cfg := Default()
	candidates := []string{"config.yaml", "bin/config.yaml"}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if err := yaml.Unmarshal(data, cfg); err != nil {
			// 配置文件格式错误时保留默认值，避免服务无法启动
			continue
		}
		break
	}
	// 关键参数兜底：配置缺省或非法时回退默认值
	if cfg.RecallWindow <= 0 {
		cfg.RecallWindow = 120
	}
	if cfg.HeartbeatTimeout <= 0 {
		cfg.HeartbeatTimeout = 90
	}
	// 前端静态目录兜底：缺省时从 exe 所在目录逐级向上查找 im-client/web
	// 原实现：静态目录硬编码相对进程工作目录，从 bin 目录双击 exe 启动会 404
	// 现改为锚定 exe 所在目录解析，任意目录启动均正确
	cfg.WebDir = resolveWebDir(cfg.WebDir)
	// 阶段二十四：文件持久化配置兜底
	if cfg.UploadDir == "" {
		// 原实现：cfg.UploadDir = "../im-client/web/static/upload"
		cfg.UploadDir = filepath.Join(cfg.WebDir, "static", "upload")
	} else {
		cfg.UploadDir = resolvePath(cfg.UploadDir)
	}
	if cfg.MaxFileSize <= 0 {
		cfg.MaxFileSize = 20 << 20
	}
	// 阶段三十一：发送队列缓冲兜底（过小会导致高并发下丢消息）
	if cfg.SendQueueSize <= 0 {
		// 原实现：客户端固定 make(chan []byte, 256)
		cfg.SendQueueSize = 1024
	}
	// 阶段三十一：大文件直传阈值兜底（1MB）
	if cfg.HttpUploadThreshold <= 0 {
		cfg.HttpUploadThreshold = 1 << 20
	}
	// 阶段三十二：分片直传配置兜底（单片 4MB / 上限 2GB）
	if cfg.UploadChunkSize <= 0 {
		cfg.UploadChunkSize = 4 << 20
	}
	if cfg.MaxDirectSize <= 0 {
		cfg.MaxDirectSize = 2 << 30
	}
	// 阶段四十三：AI 问答参数兜底（显式配 0 时回退默认值）
	if cfg.AI.ContextWindow <= 0 {
		cfg.AI.ContextWindow = 20
	}
	if cfg.AI.LimitCount <= 0 {
		cfg.AI.LimitCount = 10
	}
	if cfg.AI.LimitWindow <= 0 {
		cfg.AI.LimitWindow = 60
	}
	// 阶段四十五：文档问答提取上限兜底
	if cfg.AI.DocMaxChars <= 0 {
		cfg.AI.DocMaxChars = 60000
	}
	// 阶段五十一：知识库数据目录兜底（锚定 exe 目录/data/kb，与 UploadDir 同规则不硬编码绝对路径）
	if cfg.AI.KB.DataDir == "" {
		cfg.AI.KB.DataDir = filepath.Join(exeDir(), "data", "kb")
	} else {
		cfg.AI.KB.DataDir = resolvePath(cfg.AI.KB.DataDir)
	}
	// 阶段五十九：Agent 工作区根目录兜底（锚定 exe 目录/agent_workspace，按 username 隔离子目录）
	if cfg.AI.Agent.WorkspaceRoot == "" {
		cfg.AI.Agent.WorkspaceRoot = filepath.Join(exeDir(), "agent_workspace")
	} else {
		cfg.AI.Agent.WorkspaceRoot = resolvePath(cfg.AI.Agent.WorkspaceRoot)
	}
	// 阶段五十一：知识库参数兜底（切片 500 字/重叠 50/注入 3 条/上下文上限 4000 字）
	if cfg.AI.KB.ChunkSize <= 0 {
		cfg.AI.KB.ChunkSize = 500
	}
	if cfg.AI.KB.ChunkOverlap < 0 {
		cfg.AI.KB.ChunkOverlap = 0
	}
	if cfg.AI.KB.ChunkOverlap >= cfg.AI.KB.ChunkSize {
		cfg.AI.KB.ChunkOverlap = cfg.AI.KB.ChunkSize / 10
	}
	if cfg.AI.KB.TopK <= 0 {
		cfg.AI.KB.TopK = 3
	}
	if cfg.AI.KB.MaxContext <= 0 {
		cfg.AI.KB.MaxContext = 4000
	}
	// 阶段五十二：相似度阈值兜底（负值视 0=不过滤）
	if cfg.AI.KB.ScoreThreshold < 0 {
		cfg.AI.KB.ScoreThreshold = 0
	}
	// 阶段五十一：embedding 批量大小兜底
	if cfg.AI.Embedding.BatchSize <= 0 {
		cfg.AI.Embedding.BatchSize = 16
	}
	// 阶段四十六：OnlyOffice 配置兜底——声明启用但参数残缺时强制关闭（避免启动后编辑器静默失败）
	if cfg.OnlyOffice.Enabled && (cfg.OnlyOffice.APIURL == "" || cfg.OnlyOffice.ServerURL == "" || cfg.OnlyOffice.JWTSecret == "") {
		cfg.OnlyOffice.Enabled = false
	}
	return cfg
}

// exeDir 返回可执行文件所在目录（路径解析锚点，与进程工作目录无关，支持双击 bin 目录下的 exe 启动）
func exeDir() string {
	exePath, err := os.Executable()
	if err != nil {
		// 极端情况下获取失败回退进程工作目录
		return "."
	}
	return filepath.Dir(exePath)
}

// resolvePath 将配置路径解析为绝对路径：绝对路径直接返回，相对路径基于 exe 所在目录解析
func resolvePath(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(exeDir(), p)
}

// resolveWebDir 解析前端 web 目录：配置项优先，缺省时从 exe 所在目录逐级向上查找 im-client/web
func resolveWebDir(configured string) string {
	if configured != "" {
		return resolvePath(configured)
	}
	dir := exeDir()
	for i := 0; i < 4; i++ {
		candidate := filepath.Join(dir, "im-client", "web")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// 兜底：exe 所在目录上上级（与 exe 位于 im-server/bin 的目录结构对应）
	return filepath.Join(exeDir(), "..", "..", "im-client", "web")
}
