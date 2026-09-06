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
}

// AIProviderConfig AI 模型服务提供方（OpenAI 兼容 chat/completions 接口，可接 DeepSeek/Kimi/智谱/通义等）
type AIProviderConfig struct {
	Name   string `yaml:"name"`    // 提供方名称（智能体通过该名称绑定模型服务）
	APIURL string `yaml:"api_url"` // chat/completions 完整接口地址
	APIKey string `yaml:"api_key"` // API 密钥（仅存服务端）
	Model  string `yaml:"model"`   // 模型名（如 deepseek-chat / glm-4-flash）
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

// AIConfig AI 问答配置节
type AIConfig struct {
	Providers []AIProviderConfig `yaml:"providers"` // 模型服务列表（多模型支持）
	Agents    []AIAgentConfig    `yaml:"agents"`    // 智能体列表（用户可选择性聊天）
	// 多轮对话携带的历史消息条数（按用户+智能体隔离取最近 N 条）
	ContextWindow int `yaml:"context_window"`
	// 限流：单用户在限流窗口内最大提问次数
	LimitCount int `yaml:"limit_count"`
	// 限流窗口（秒）
	LimitWindow int `yaml:"limit_window"`
	// 阶段四十五：文档问答单文档提取文本上限（字符），超出截断，防止超长文档撑爆模型上下文
	DocMaxChars int `yaml:"doc_max_chars"`
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
