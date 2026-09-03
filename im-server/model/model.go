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
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (Message) TableName() string { return "im_message" }

// FileRecord 文件传输记录表 im_file
type FileRecord struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	FileName   string    `gorm:"column:file_name;type:varchar(255);not null" json:"file_name"`
	FileSize   int64     `gorm:"column:file_size;type:bigint;not null" json:"file_size"`
	FilePath   string    `gorm:"column:file_path;type:varchar(255);not null" json:"file_path"`
	FromUser   string    `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`
	ToUser     string    `gorm:"column:to_user;type:varchar(32);not null" json:"to_user"`
	Status     int8      `gorm:"column:status;type:tinyint;default:0" json:"status"` // 0传输中 1传输完成 2传输失败
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (FileRecord) TableName() string { return "im_file" }
