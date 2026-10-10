package model

import "time"

// Moment 阶段二百八十：朋友圈动态表 im_moment（微信同款朋友圈，服务端归口）
// 时间线可见范围：双向好友 + 自己；Visibility 控制单条可见性，服务端过滤后下发
type Moment struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Username string `gorm:"column:username;type:varchar(32);not null;index" json:"username"` // 发布者
	Content  string `gorm:"column:content;type:text" json:"content"`                         // 文字内容（可空=纯图片）
	// Images 图片路径数组 JSON（/static/upload/xxx，复用静态目录；空数组=纯文字动态）
	Images string `gorm:"column:images;type:text" json:"images"`
	// Visibility 可见范围：0公开(全部好友可见) 1私密(仅自己) 2部分可见 3不给谁看（2/3 结合 VisibleUsers）
	Visibility   int8      `gorm:"column:visibility;type:tinyint;default:0" json:"visibility"`
	VisibleUsers string    `gorm:"column:visible_users;type:text" json:"visible_users"` // JSON 用户名数组（visibility=2/3 生效）
	CreateTime   time.Time `gorm:"column:create_time;autoCreateTime;index" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (Moment) TableName() string { return "im_moment" }

// MomentLike 朋友圈点赞表 im_moment_like（(moment_id, username) 唯一索引防重复点赞）
type MomentLike struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	MomentID   uint      `gorm:"column:moment_id;not null;uniqueIndex:uk_moment_like" json:"moment_id"`
	Username   string    `gorm:"column:username;type:varchar(32);not null;uniqueIndex:uk_moment_like" json:"username"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (MomentLike) TableName() string { return "im_moment_like" }

// MomentComment 朋友圈评论表 im_moment_comment（ReplyTo=0 直接评论动态，>0 回复指定评论=微信同款楼中楼）
type MomentComment struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	MomentID uint   `gorm:"column:moment_id;not null;index" json:"moment_id"`
	Username string `gorm:"column:username;type:varchar(32);not null" json:"username"` // 评论人
	ReplyTo  uint   `gorm:"column:reply_to;default:0" json:"reply_to"`                 // 被回复的评论ID（0=直接评论）
	// ReplyToUser 被回复人（冗余存储：被回复评论删除后"张三回复李四"展示仍完整）
	ReplyToUser string    `gorm:"column:reply_to_user;type:varchar(32);default:''" json:"reply_to_user"`
	Content     string    `gorm:"column:content;type:varchar(512)" json:"content"`
	CreateTime  time.Time `gorm:"column:create_time;autoCreateTime;index" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (MomentComment) TableName() string { return "im_moment_comment" }

// MomentUnread 朋友圈互动未读表 im_moment_unread（红点归口：我发布的动态收到新互动时落一行，
// 打开朋友圈时整单已读；Action=like/comment/reply 归口红点文案）
type MomentUnread struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Username   string    `gorm:"column:username;type:varchar(32);not null;index" json:"username"` // 动态归属人（红点接收者）
	MomentID   uint      `gorm:"column:moment_id;not null" json:"moment_id"`
	Actor      string    `gorm:"column:actor;type:varchar(32);not null" json:"actor"` // 互动人
	Action     string    `gorm:"column:action;type:varchar(16)" json:"action"`        // like / comment / reply
	IsRead     bool      `gorm:"column:is_read;default:false" json:"is_read"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (MomentUnread) TableName() string { return "im_moment_unread" }
