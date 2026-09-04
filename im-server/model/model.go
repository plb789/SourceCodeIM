package model

import "time"

// User 用户信息表 im_user
type User struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Username   string    `gorm:"column:username;type:varchar(32);uniqueIndex;not null" json:"username"`
	Password   string    `gorm:"column:password;type:varchar(64);not null" json:"-"`
	Avatar     string    `gorm:"column:avatar;type:varchar(255);default:''" json:"avatar"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (User) TableName() string { return "im_user" }

// Message 聊天消息表 im_message
type Message struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	MsgType    int8      `gorm:"column:msg_type;type:tinyint;not null" json:"msg_type"` // 1群聊 2私聊 3文件消息
	FromUser   string    `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`
	ToUser     string    `gorm:"column:to_user;type:varchar(32)" json:"to_user"` // 群聊为空
	Content    string    `gorm:"column:content;type:text" json:"content"`
	IsRead     bool      `gorm:"column:is_read;default:false" json:"is_read"`   // 已读状态
	Recalled   bool      `gorm:"column:recalled;default:false" json:"recalled"` // 是否已撤回
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (Message) TableName() string { return "im_message" }

// MessageDelete 用户删除消息记录表 im_msg_delete（仅影响删除者自己的视图）
type MessageDelete struct {
	ID     uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID string `gorm:"column:user_id;type:varchar(32);not null;index:idx_del_user_msg" json:"user_id"`
	MsgID  uint   `gorm:"column:msg_id;not null;index:idx_del_user_msg" json:"msg_id"`
}

// TableName 指定表名
func (MessageDelete) TableName() string { return "im_msg_delete" }

// Conversation 会话表 im_conversation（最近会话列表，服务端统一归口）
type Conversation struct {
	ID       uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID   string    `gorm:"column:user_id;type:varchar(32);not null;uniqueIndex:idx_conv_user_target" json:"user_id"`
	Target   string    `gorm:"column:target;type:varchar(32);not null;uniqueIndex:idx_conv_user_target" json:"target"` // 对方用户名，空表示群聊
	LastMsg  string    `gorm:"column:last_msg;type:varchar(255)" json:"last_msg"`                                      // 最后一条消息摘要
	LastTime time.Time `gorm:"column:last_time" json:"last_time"`
	Pinned   bool      `gorm:"column:pinned;default:false" json:"pinned"` // 是否置顶
	// 原实现：无已读回执水位字段，多端同时打开会话重复发送回执会重复写库+转发（回执风暴）
	LastReadID uint `gorm:"column:last_read_id;default:0" json:"last_read_id"` // 已读回执水位：已读到的对方最大消息 ID（仅私聊会话使用，仅水位前进才处理回执）
}

// TableName 指定表名
func (Conversation) TableName() string { return "im_conversation" }

// MessagePin 置顶消息表 im_msg_pin（会话维度，每个会话仅一条置顶消息，服务端统一归口）
type MessagePin struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	ConvKey    string    `gorm:"column:conv_key;type:varchar(65);not null;uniqueIndex" json:"conv_key"` // 会话键：群聊固定 group，私聊按字典序拼接 userA|userB
	MsgID      uint      `gorm:"column:msg_id;not null" json:"msg_id"`                                  // 被置顶的消息 ID
	PinUser    string    `gorm:"column:pin_user;type:varchar(32);not null" json:"pin_user"`             // 置顶操作人
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (MessagePin) TableName() string { return "im_msg_pin" }

// FileRecord 文件传输记录表 im_file
type FileRecord struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	FileName   string    `gorm:"column:file_name;type:varchar(255);not null" json:"file_name"`
	FileSize   int64     `gorm:"column:file_size;type:bigint;not null" json:"file_size"`
	FilePath   string    `gorm:"column:file_path;type:varchar(255);not null" json:"file_path"`
	FromUser   string    `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`
	ToUser     string    `gorm:"column:to_user;type:varchar(32);not null" json:"to_user"`
	Status     int8      `gorm:"column:status;type:tinyint;default:0" json:"status"` // 0传输中 1传输完成 2传输失败 3已持久化（阶段二十四：文件已回传存储并落库消息）
	MsgID      uint      `gorm:"column:msg_id;default:0" json:"msg_id"`              // 阶段二十四：持久化后对应的 im_message 消息 ID（幂等依据）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (FileRecord) TableName() string { return "im_file" }

// Friend 好友关系表 im_friend
type Friend struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID     string    `gorm:"column:user_id;type:varchar(32);not null;index:idx_user_friend" json:"user_id"`
	FriendID   string    `gorm:"column:friend_id;type:varchar(32);not null" json:"friend_id"`
	Remark     string    `gorm:"column:remark;type:varchar(64);default:''" json:"remark"`         // 备注名
	GroupName  string    `gorm:"column:group_name;type:varchar(32);default:''" json:"group_name"` // 分组
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (Friend) TableName() string { return "im_friend" }

// FriendRequest 好友申请表 im_friend_request
type FriendRequest struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	FromUser   string    `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`
	ToUser     string    `gorm:"column:to_user;type:varchar(32);not null;index:idx_to_user" json:"to_user"`
	Message    string    `gorm:"column:message;type:varchar(255);default:''" json:"message"` // 验证消息
	Status     int8      `gorm:"column:status;type:tinyint;default:0" json:"status"`         // 0待处理 1已同意 2已拒绝
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (FriendRequest) TableName() string { return "im_friend_request" }

// Blacklist 黑名单表 im_blacklist
type Blacklist struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID     string    `gorm:"column:user_id;type:varchar(32);not null;index:idx_user_block" json:"user_id"`
	BlockedID  string    `gorm:"column:blocked_id;type:varchar(32);not null" json:"blocked_id"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (Blacklist) TableName() string { return "im_blacklist" }
