package model

import "time"

// User 用户信息表 im_user
type User struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Username string `gorm:"column:username;type:varchar(32);uniqueIndex;not null" json:"username"`
	Password string `gorm:"column:password;type:varchar(64);not null" json:"-"`
	Avatar   string `gorm:"column:avatar;type:varchar(255);default:''" json:"avatar"`
	// 原实现：仅 username/password/avatar 三字段，无个人资料，点击头像只能直接换图
	// 阶段三十：新增个人资料字段（微信式"我的个人资料"：昵称/性别/地区/签名），AutoMigrate 自动加列
	Nickname  string `gorm:"column:nickname;type:varchar(32);default:''" json:"nickname"`    // 昵称（空则前端展示用户名）
	Gender    int8   `gorm:"column:gender;type:tinyint;default:0" json:"gender"`             // 性别：0未知 1男 2女
	Region    string `gorm:"column:region;type:varchar(64);default:''" json:"region"`        // 地区（如：山西 太原）
	Signature string `gorm:"column:signature;type:varchar(128);default:''" json:"signature"` // 个性签名
	// 阶段四十九：后台管理权限角色（0普通用户 1管理员）——config.yaml admin_users 白名单启动时自动标记
	Role       int8      `gorm:"column:role;type:tinyint;default:0" json:"role"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (User) TableName() string { return "im_user" }

// AIProvider AI 模型服务表 im_ai_provider（阶段四十九：AI 配置迁入数据库，后台管理界面可热更新增删改）
// 原实现：providers 存于 config.yaml，修改后需重启服务端生效
type AIProvider struct {
	ID     uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name   string `gorm:"column:name;type:varchar(64);uniqueIndex;not null" json:"name"` // 提供方名称（智能体绑定锚点，全局唯一）
	APIURL string `gorm:"column:api_url;type:varchar(255);not null" json:"api_url"`      // OpenAI 兼容 chat/completions 完整接口地址
	APIKey string `gorm:"column:api_key;type:varchar(255);default:''" json:"-"`          // API 密钥（仅服务端与管理后台归口，普通聊天链路不下发）
	Model  string `gorm:"column:model;type:varchar(128);not null" json:"model"`          // 模型名（如 deepseek-v4-flash）
	// VisionModel 视觉模型名（选填）：文本与视觉分立的模型（如 DeepSeek 文本/视觉双模型）填此字段，
	// 带图提问时服务端自动路由到该模型，纯文本仍走主模型；为空则统一走主模型（单模型多模态如 glm-4v 无需填）
	VisionModel string `gorm:"column:vision_model;type:varchar(128);default:''" json:"vision_model"`
	// SupportsImage 是否支持图片识别（多模态），为 true 时绑定的智能体开放图片提问入口
	SupportsImage bool `gorm:"column:supports_image;default:false" json:"supports_image"`
	// Enabled 启用状态：false 时绑定的智能体降级为本地 Mock 应答
	Enabled    bool      `gorm:"column:enabled;default:true" json:"enabled"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AIProvider) TableName() string { return "im_ai_provider" }

// AIAgent AI 智能体表 im_ai_agent（阶段四十九：面向用户的聊天助手，后台管理界面可热更新增删改）
type AIAgent struct {
	ID   uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name string `gorm:"column:name;type:varchar(64);uniqueIndex;not null" json:"name"` // 智能体名称（会话列表展示名，全局唯一——对话路由按名字，重名会歧义）
	// Provider 绑定的提供方名称（空或未命中时降级本地 Mock 应答）
	Provider string `gorm:"column:provider;type:varchar(64);default:''" json:"provider"`
	// SystemPrompt 系统提示词（人设/能力定义）
	SystemPrompt string `gorm:"column:system_prompt;type:text" json:"system_prompt"`
	// Avatar 头像 URL（空时前端回退 🤖 占位）
	Avatar string `gorm:"column:avatar;type:varchar(255);default:''" json:"avatar"`
	// Enabled 启用状态：false 时不下发客户端（停用不删除，可随时恢复）
	Enabled bool `gorm:"column:enabled;default:true" json:"enabled"`
	// SortID 排序号（越小越靠前，同值按 ID 升序）
	SortID int `gorm:"column:sort_id;default:0" json:"sort_id"`
	// KBIDs 阶段五十一：绑定的知识库 ID（逗号分隔字符串，空=不启用知识库检索；个人库仅库归属者对话时生效）
	KBIDs string `gorm:"column:kb_ids;type:varchar(255);default:''" json:"kb_ids"`
	// Scope 阶段五十七：归属范围（public=管理员全局智能体，user=用户个人智能体；存量数据默认 public）
	Scope string `gorm:"column:scope;type:varchar(8);default:'public'" json:"scope"`
	// Owner 阶段五十七：个人智能体归属用户名（公共智能体为空；个人智能体仅归属者可见可对话）
	Owner      string    `gorm:"column:owner;type:varchar(32);default:'';index" json:"owner"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AIAgent) TableName() string { return "im_ai_agent" }

// KB 知识库表 im_kb（阶段五十一：公共/个人知识库，scope 归口权限）
type KB struct {
	ID   uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name string `gorm:"column:name;type:varchar(64);not null;uniqueIndex:idx_kb_name_scope" json:"name"`
	// Scope 库范围：public 公共库（绑定它的智能体对所有用户生效）/ user 个人库（仅归属者对话时生效）
	Scope string `gorm:"column:scope;type:varchar(16);not null;default:'public';uniqueIndex:idx_kb_name_scope" json:"scope"`
	// Owner 个人库归属用户名（公共库为空）
	Owner string `gorm:"column:owner;type:varchar(64);default:''" json:"owner"`
	// Desc 库描述（用途说明）
	Desc string `gorm:"column:desc;type:varchar(255);default:''" json:"desc"`
	// EmbedModel 建库时的 embedding 模型名（入库与检索必须同模型，更换模型需重建库）
	EmbedModel string `gorm:"column:embed_model;type:varchar(128);default:''" json:"embed_model"`
	// Dim 向量维度（首片入库时确定，后续文件维度不一致拒绝入库）
	Dim        int       `gorm:"column:dim;default:0" json:"dim"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (KB) TableName() string { return "im_kb" }

// KBFile 知识库文件表 im_kb_file（阶段五十一：上传→解析→切片→向量化流水线状态归口）
type KBFile struct {
	ID   uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	KBID uint   `gorm:"column:kb_id;index;not null" json:"kb_id"`
	Name string `gorm:"column:name;type:varchar(255);not null" json:"name"`   // 原始文件名
	Path string `gorm:"column:path;type:varchar(255);default:''" json:"path"` // 落盘路径（DataDir/files/<kbID>/）
	Size int64  `gorm:"column:size;default:0" json:"size"`
	// Chunks 成功入库的切片数
	Chunks int `gorm:"column:chunks;default:0" json:"chunks"`
	// Status 处理状态：processing 处理中 / ready 可检索 / failed 失败
	Status string `gorm:"column:status;type:varchar(16);default:'processing'" json:"status"`
	// Error 失败原因（status=failed 时展示）
	Error      string    `gorm:"column:error;type:varchar(255);default:''" json:"error"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (KBFile) TableName() string { return "im_kb_file" }

// UserKB 用户知识库勾选表 im_user_kb（阶段五十六：用户端自选知识库，对所有智能体对话生效）
// 与 AIAgent.KBIDs（智能体绑定库）并行的用户级勾选，AI 问答链路两方合并去重后注入；
// 个人库命中权限由 kbSearch 归口过滤（仅归属者生效），勾选串仅是候选集不构成越权面
type UserKB struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Username string `gorm:"column:username;type:varchar(32);uniqueIndex;not null" json:"username"`
	// KBIDs 用户勾选的知识库 ID（逗号分隔字符串，空=未勾选）
	KBIDs      string    `gorm:"column:kb_ids;type:varchar(1024);default:''" json:"kb_ids"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (UserKB) TableName() string { return "im_user_kb" }

// AIMemory AI 智能体长期记忆（阶段五十八）：按 用户+智能体 隔离（agent_id + username 联合索引），
// MySQL 为权威归口，chromem 向量集合 mem_<agentID> 仅作检索索引（元数据带 username/memid）
type AIMemory struct {
	ID      uint `gorm:"primaryKey;autoIncrement" json:"id"`
	AgentID uint `gorm:"column:agent_id;not null;index:idx_mem_agent_user" json:"agent_id"` // 智能体 DB ID（改名不变；智能体删除级联清理）
	// Username 记忆归属用户（谁与该智能体聊出的记忆；跨用户零泄露）
	Username string `gorm:"column:username;type:varchar(32);not null;index:idx_mem_agent_user" json:"username"`
	// Content 记忆条目正文（独立事实句，提取时截断至 200 字）
	Content string `gorm:"column:content;type:varchar(512);not null" json:"content"`
	// Source 记忆来源：auto=AI 对话自动提取 manual=用户手动新增
	Source     string    `gorm:"column:source;type:varchar(8);default:'auto'" json:"source"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (AIMemory) TableName() string { return "im_ai_memory" }

// AIMemoryPref 用户级记忆总开关（阶段五十八）：username 唯一，缺行默认开启；
// 关闭后该用户不再触发自动提取也不再注入召回（手动新增仍允许）
type AIMemoryPref struct {
	Username string `gorm:"column:username;type:varchar(32);primaryKey" json:"username"`
	// Enabled 禁用 default:true 标签——GORM 对零值字段+default 标签会从 INSERT 剔除交给 DB 默认值，
	// 导致"新建偏好行且要求 enabled=false"永远落库为 true（阶段五十八实测）；缺行默认开启语义由 memUserEnabled 代码层保证
	Enabled    bool      `gorm:"column:enabled" json:"enabled"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AIMemoryPref) TableName() string { return "im_ai_memory_pref" }

// AgentTaskRecord 智能 Agent 自动化任务记录（阶段五十九）：任务闭环审计归口。
// 运行态在内存（事件流实时推送），结束态（completed/failed/cancelled）落库供追溯；
// Result 存最终答复摘要，Error 存失败/取消原因
type AgentTaskRecord struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	TaskID     string    `gorm:"column:task_id;type:varchar(40);not null;uniqueIndex" json:"task_id"`
	Username   string    `gorm:"column:username;type:varchar(32);not null;index" json:"username"` // 发起用户
	AgentName  string    `gorm:"column:agent_name;type:varchar(64);not null" json:"agent_name"`   // 执行智能体
	Goal       string    `gorm:"column:goal;type:text" json:"goal"`                               // 任务目标
	Status     string    `gorm:"column:status;type:varchar(16);not null" json:"status"`           // completed/failed/cancelled
	Result     string    `gorm:"column:result;type:text" json:"result"`                           // 最终答复（完成时）
	Error      string    `gorm:"column:error;type:text" json:"error"`                             // 失败/取消原因
	Steps      int       `gorm:"column:steps;not null;default:0" json:"steps"`                    // 实际迭代步数
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AgentTaskRecord) TableName() string { return "im_agent_task" }

// AgentWhitelist 智能 Agent 审批白名单（阶段六十二）：审批弹窗"同意并加白"的持久化归口。
// kind=cmd → value 为命令首词前缀（如 node/git），后续命中前缀的 run_command 自动放行；
// kind=autowrite → 写文件免审批开关（存在记录即开启）。启动时加载进内存白名单，重启不丢
type AgentWhitelist struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Kind       string    `gorm:"column:kind;type:varchar(16);not null;index" json:"kind"`
	Value      string    `gorm:"column:value;type:varchar(128);not null" json:"value"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (AgentWhitelist) TableName() string { return "im_agent_whitelist" }

// AgentStepRecord Agent 任务执行步骤留痕（阶段六十五）：每步工具调用即时落库，任务运行中亦可追溯。
// Params 存参数 JSON 摘要、Result 存结果摘要（均截断）；Approval 记录审批情况
// （none=免审批 / approved=审批通过（可能改参）/ rejected=用户拒绝 / cancelled=用户取消 / timeout=审批超时）；
// Env 记录执行环境（server=服务端工作区 / pc=用户 PC 本地执行）
type AgentStepRecord struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	TaskID     string    `gorm:"column:task_id;type:varchar(40);not null;index" json:"task_id"`
	Seq        int       `gorm:"column:seq;not null" json:"seq"`                    // 任务内递增步骤序号（从 1 开始）
	Tool       string    `gorm:"column:tool;type:varchar(32);not null" json:"tool"` // 工具名
	Params     string    `gorm:"column:params;type:text" json:"params"`             // 参数 JSON 摘要
	Result     string    `gorm:"column:result;type:text" json:"result"`             // 结果摘要
	OK         bool      `gorm:"column:ok;not null" json:"ok"`                      // 结果是否成功
	Env        string    `gorm:"column:env;type:varchar(8)" json:"env"`             // 执行环境 pc/server
	Approval   string    `gorm:"column:approval;type:varchar(16)" json:"approval"`  // 审批情况
	DurationMS int64     `gorm:"column:duration_ms;not null;default:0" json:"duration_ms"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (AgentStepRecord) TableName() string { return "im_agent_step" }

// Message 聊天消息表 im_message
type Message struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	MsgType  int8   `gorm:"column:msg_type;type:tinyint;not null" json:"msg_type"` // 1群聊 2私聊 3文件消息
	FromUser string `gorm:"column:from_user;type:varchar(32);not null" json:"from_user"`
	ToUser   string `gorm:"column:to_user;type:varchar(32)" json:"to_user"` // 群聊为空
	Content  string `gorm:"column:content;type:text" json:"content"`
	IsRead   bool   `gorm:"column:is_read;default:false" json:"is_read"`   // 已读状态
	Recalled bool   `gorm:"column:recalled;default:false" json:"recalled"` // 是否已撤回
	// AI 回复 Token 消耗（服务端 usage 归口；普通消息恒为 0，历史加载同样可显示）
	PromptTokens     int       `gorm:"column:prompt_tokens;default:0" json:"prompt_tokens,omitempty"`
	CompletionTokens int       `gorm:"column:completion_tokens;default:0" json:"completion_tokens,omitempty"`
	TotalTokens      int       `gorm:"column:total_tokens;default:0" json:"total_tokens,omitempty"`
	CreateTime       time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
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

// DocEdit 文档在线编辑版本表 im_doc_edit（阶段四十六：OnlyOffice 保存回调后追加版本，每条消息一条记录）
type DocEdit struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	MsgID      uint      `gorm:"column:msg_id;uniqueIndex;not null" json:"msg_id"`               // 关联的 im_message 消息 ID（文档版本归口锚点）
	LatestURL  string    `gorm:"column:latest_url;type:varchar(255);not null" json:"latest_url"` // 最新版本文件 URL（/static/upload/xxx）
	Version    int       `gorm:"column:version;default:0" json:"version"`                        // 已保存版本数（参与 document.key 组成，防 DS 缓存旧版）
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (DocEdit) TableName() string { return "im_doc_edit" }
