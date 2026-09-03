package protocol

// 消息类型常量，与《开发文档》3.5 数据交互协议保持一致
const (
	MsgTypeGroupChat   = 1  // 文字群聊
	MsgTypePrivate     = 2  // 文字私聊
	MsgTypeFile        = 3  // 文件传输
	MsgTypeHeartbeat   = 4  // 心跳包
	MsgTypeOnline      = 5  // 上下线通知
	MsgTypeUserList    = 6  // 用户列表同步
	MsgTypeLogin       = 7  // 登录/注册请求
	MsgTypeLoginResp   = 8  // 登录/注册响应
	MsgTypeError       = 9  // 服务端错误提示
	MsgTypeHistory     = 10 // 历史记录请求
	MsgTypeHistoryResp = 11 // 历史记录响应
	MsgTypeTyping      = 12 // 输入状态提示
)

// Message 客户端与服务端统一 JSON 消息协议
type Message struct {
	MsgType     int    `json:"msg_type"`
	FromUser    string `json:"from_user"`
	ToUser      string `json:"to_user"`
	Content     string `json:"content"`
	FileName    string `json:"file_name"`
	FileSize    int64  `json:"file_size"`
	FileData    []byte `json:"file_data"`
	ChunkIndex  int    `json:"chunk_index"`
	Timestamp   int64  `json:"timestamp"`
	Page        int    `json:"page"`         // 分页页码（从 1 开始）
	PageSize    int    `json:"page_size"`    // 每页条数
	FileID      string `json:"file_id"`      // 文件传输唯一标识
	TotalChunks int    `json:"total_chunks"` // 文件总分片数
	MsgID       uint   `json:"msg_id"`       // 消息唯一 ID（持久化后回填，用于去重）
}
