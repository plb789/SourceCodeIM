package config

import (
	"os"

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

	// MySQL 配置
	MySQLDSN string `yaml:"mysql_dsn"`
	// Redis 配置
	RedisAddr     string `yaml:"redis_addr"`
	RedisPassword string `yaml:"redis_password"`
	RedisDB       int    `yaml:"redis_db"`
}

// Default 返回默认配置，与《开发文档》5.2 核心配置参数保持一致
func Default() *Config {
	return &Config{
		WSAddr:            ":8888",
		HeartbeatTimeout:  90,
		HeartbeatInterval: 30,
		ChunkSize:         4096,
		MaxConnections:    1000,
		RecallWindow:      120,

		MySQLDSN:      "root:root@tcp(127.0.0.1:3306)/im?charset=utf8mb4&parseTime=True&loc=Local",
		RedisAddr:     "127.0.0.1:6379",
		RedisPassword: "",
		RedisDB:       0,
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
	return cfg
}
