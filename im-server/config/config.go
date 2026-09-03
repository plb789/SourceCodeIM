package config

// Config 服务端全局配置
type Config struct {
	// WebSocket 监听地址
	WSAddr string
	// 心跳超时时间（秒）
	HeartbeatTimeout int
	// 心跳发送间隔（秒，客户端侧）
	HeartbeatInterval int
	// 文件分片大小（字节）
	ChunkSize int
	// 最大在线连接数
	MaxConnections int

	// MySQL 配置
	MySQLDSN string
	// Redis 配置
	RedisAddr     string
	RedisPassword string
	RedisDB       int
}

// Default 返回默认配置，与《开发文档》5.2 核心配置参数保持一致
func Default() *Config {
	return &Config{
		WSAddr:            ":8888",
		HeartbeatTimeout:  90,
		HeartbeatInterval: 30,
		ChunkSize:         4096,
		MaxConnections:    1000,

		MySQLDSN:      "root:root@tcp(127.0.0.1:3306)/im?charset=utf8mb4&parseTime=True&loc=Local",
		RedisAddr:     "127.0.0.1:6379",
		RedisPassword: "",
		RedisDB:       0,
	}
}
