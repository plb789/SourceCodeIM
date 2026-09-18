package model

import "time"

// ===== 阶段一百四十二：微信同款多群聊（一期：建群 + 邀请 + 多群收发） =====
// 会话目标编码：新群 target = 'g' + 群ID（如 g1），存于 Conversation.Target 与 Message.ToUser；
// 现有 ''（全局群）/ 用户名（私聊/AI）语义不变，全局群路径零改动。

// Group 群聊信息表 im_group
type Group struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Name       string    `gorm:"column:name;type:varchar(64);not null" json:"name"`   // 群名称
	OwnerID    string    `gorm:"column:owner_id;type:varchar(32);not null" json:"owner_id"` // 群主用户名
	Avatar     string    `gorm:"column:avatar;type:varchar(255);default:''" json:"avatar"`  // 群头像（一期为空走前端默认头像，二期支持上传）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (Group) TableName() string { return "im_group" }

// GroupMember 群成员表 im_group_member
type GroupMember struct {
	ID       uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	GroupID  uint      `gorm:"column:group_id;not null;uniqueIndex:idx_group_user" json:"group_id"` // 复合唯一索引：防重复入群
	UserID   string    `gorm:"column:user_id;type:varchar(32);not null;uniqueIndex:idx_group_user" json:"user_id"`
	Role     int8      `gorm:"column:role;type:tinyint;default:2" json:"role"` // 1群主 2成员（二期扩展管理员）
	JoinTime time.Time `gorm:"column:join_time;autoCreateTime" json:"join_time"`
}

// TableName 指定表名
func (GroupMember) TableName() string { return "im_group_member" }

// GroupInvite 群邀请表 im_group_invite
// 不做 (group_id,to_user) 唯一索引：微信允许拒绝后再次邀请；
// 防重复归口在业务层：同群同人存在 Status=0 在途邀请则拦截
type GroupInvite struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	GroupID    uint      `gorm:"column:group_id;not null;index:idx_invite_to,priority:1" json:"group_id"`
	FromUser   string    `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`                    // 邀请人
	ToUser     string    `gorm:"column:to_user;type:varchar(32);not null;index:idx_invite_to,priority:2" json:"to_user"` // 被邀请人
	Status     int8      `gorm:"column:status;type:tinyint;default:0" json:"status"`                             // 0待处理 1已同意 2已拒绝（与好友申请状态对齐）
	Message    string    `gorm:"column:message;type:varchar(255);default:''" json:"message"`                     // 邀请附言（预留）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (GroupInvite) TableName() string { return "im_group_invite" }
