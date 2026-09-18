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
	// 阶段七十八：AI 积分（TRAE CN 同款问答积分）——按 Token 消耗折算扣除（1000 tokens = 1 积分，
	// 双精度保留 3 位小数，如 4506 tokens = 4.506 积分），余额不足拦截 AI 提问；
	// 列默认值 100：AutoMigrate 加列时存量用户自动补 100，注册逻辑另显式赋值；
	// 双精度迁移：int → double（AutoMigrate 改列型，存量整数值自动成为浮点值，无需数据修复）
	Points float64 `gorm:"column:points;type:double;default:100" json:"points"`
	// 阶段一百三十五：账号状态（后台账号管理：锁定封禁/注销）——AutoMigrate 自动加列，存量用户默认 0 正常
	Status int8 `gorm:"column:status;type:tinyint;default:0" json:"status"`
	// LockReason 锁定封禁原因（管理员填写，登录拒绝与在线踢出时提示给用户；解锁/注销时清空）
	LockReason string `gorm:"column:lock_reason;type:varchar(255);default:''" json:"lock_reason"`
}

// 用户状态常量（阶段一百三十五：后台账号锁定封禁/注销归口）
const (
	UserStatusNormal  int8 = 0 // 正常
	UserStatusLocked  int8 = 1 // 锁定封禁（登录拒绝并提示 LockReason，在线连接被踢出）
	UserStatusDeleted int8 = 2 // 已注销（软删除：用户名继续占用防同名重新注册继承旧好友/消息数据，列表不再展示）
)

// PointsLog 阶段七十八：积分流水（AI 扣分/管理员调整/注册赠送全量审计，后台积分管理面板数据源）
type PointsLog struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	Username     string    `gorm:"column:username;type:varchar(64);index" json:"username"` // 积分归属用户
	Change       float64   `gorm:"column:change;type:double" json:"change"`                // 变动量：正=增加 负=扣除（双精度，保留 3 位小数）
	BalanceAfter float64   `gorm:"column:balance_after;type:double" json:"balance_after"`  // 变动后余额（对账归口，双精度）
	Reason       string    `gorm:"column:reason;type:varchar(32);index" json:"reason"`     // ai_deduct / admin_adjust / register_grant
	Operator     string    `gorm:"column:operator;type:varchar(64)" json:"operator"`       // 操作人（管理员调整时记录；系统行为为 system）
	Detail       string    `gorm:"column:detail;type:varchar(255)" json:"detail"`          // 人类可读说明（如 AI 问答消耗 tokens 数）
	CreateTime   time.Time `gorm:"column:create_time;autoCreateTime;index" json:"create_time"`
}

// CallLog 通话话单表 im_call_log（阶段一百四十一：音视频通话归口，服务端数据归口——
// 通话结束/中断/超时/拒绝均由服务端写话单，客户端零计算只展示）
type CallLog struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	CallID   string `gorm:"column:call_id;type:varchar(64);index" json:"call_id"`
	Caller   string `gorm:"column:caller;type:varchar(32);index" json:"caller"` // 主叫
	Callee   string `gorm:"column:callee;type:varchar(32);index" json:"callee"` // 被叫
	CallType string `gorm:"column:call_type;type:varchar(8)" json:"call_type"`  // audio 语音 / video 视频
	// Status 通话结果：completed 已接通（含时长）/ rejected 被叫拒绝 / canceled 主叫取消 / missed 无人接听 / busy 对方忙
	Status     string    `gorm:"column:status;type:varchar(16)" json:"status"`
	Duration   int       `gorm:"column:duration;default:0" json:"duration"` // 接通时长（秒，未接通为 0）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime;index" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (CallLog) TableName() string { return "im_call_log" }

// TableName 表名沿用 im_ 前缀约定（GORM 默认复数命名不符合本项目规范，显式指定）
func (PointsLog) TableName() string { return "im_points_log" }

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

// AIRule 用户自定义 AI 行为规则（阶段一百零四，Trae CN 同款"规则"功能）：AI 回答前先读规则并遵守。
// 两层范围：AgentID=0 用户级全局规则（对该用户全部智能体生效）；AgentID>0 仅该智能体生效。
// 与记忆的语义差异：记忆=背景参考（向量召回，相关才注入）；规则=硬性约束（全量注入，每问必守）
type AIRule struct {
	ID uint `gorm:"primaryKey;autoIncrement" json:"id"`
	// Username 规则归属用户（仅本人可见可管理；跨用户零泄露）
	Username string `gorm:"column:username;type:varchar(32);not null;index:idx_rule_user_agent" json:"username"`
	// AgentID 生效范围：0=用户级全局规则；>0 仅该智能体（智能体删除级联清理）
	AgentID uint `gorm:"column:agent_id;not null;default:0;index:idx_rule_user_agent" json:"agent_id"`
	// Content 规则正文（单条硬性约束，如"所有注释必须中文"）
	Content string `gorm:"column:content;type:varchar(512);not null" json:"content"`
	// Enabled 启用开关（禁用后不注入不删除，可随时恢复；不用 default 标签——GORM 零值+default
	// 会从 INSERT 剔除交给 DB 默认值导致 false 落库为 true，阶段五十八实测教训）
	Enabled    bool      `gorm:"column:enabled" json:"enabled"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 指定表名
func (AIRule) TableName() string { return "im_ai_rules" }

// AISession AI 多会话（阶段七十一，Trae CN 同款"新建会话"）：用户+智能体 多会话归口表。
// 消息归属采用消息级盖戳：im_message.ai_session_id 记录所属会话 id，任意会话均可随时续聊
// （0=默认会话：存量历史与未区分消息归口；本表仅存会话元信息）。
// FirstMsgID 为区间法方案遗留列（仅作存量数据一次性迁移的解析源，回填后恒 0 不再使用）
type AISession struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Username   string    `gorm:"column:username;type:varchar(32);not null;index:idx_aisess_user_agent" json:"username"`     // 会话归属用户（联合普通索引：一用户+智能体多会话，勿用唯一索引）
	AgentName  string    `gorm:"column:agent_name;type:varchar(64);not null;index:idx_aisess_user_agent" json:"agent_name"` // 智能体名
	Title      string    `gorm:"column:title;type:varchar(64);not null;default:''" json:"title"`                            // 会话标题（首问截取，服务端归口生成）
	FirstMsgID uint      `gorm:"column:first_msg_id;not null;default:0" json:"first_msg_id"`                                // 遗留列：区间法首条消息 id（迁移后恒 0）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AISession) TableName() string { return "im_ai_session" }

// AgentTaskRecord 智能 Agent 自动化任务记录（阶段五十九）：任务闭环审计归口。
// 运行态在内存（事件流实时推送），结束态（completed/failed/cancelled）落库供追溯；
// Result 存最终答复摘要，Error 存失败/取消原因
type AgentTaskRecord struct {
	ID        uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	TaskID    string `gorm:"column:task_id;type:varchar(40);not null;uniqueIndex" json:"task_id"`
	Username  string `gorm:"column:username;type:varchar(32);not null;index" json:"username"` // 发起用户
	AgentName string `gorm:"column:agent_name;type:varchar(64);not null" json:"agent_name"`   // 执行智能体
	Goal      string `gorm:"column:goal;type:text" json:"goal"`                               // 任务目标
	Status    string `gorm:"column:status;type:varchar(16);not null" json:"status"`           // completed/failed/cancelled
	Result    string `gorm:"column:result;type:text" json:"result"`                           // 最终答复（完成时）
	Error     string `gorm:"column:error;type:text" json:"error"`                             // 失败/取消原因
	Steps     int    `gorm:"column:steps;not null;default:0" json:"steps"`                    // 实际迭代步数
	// ElapsedMs 任务执行耗时毫秒（阶段一百三十八）：StartAt（实际开始执行）到完结的时长，
	// 完结落库并随 done/error/cancelled 帧、任务列表接口下发，前端展示"耗时 X 分 Y 秒"（TRAE CN 同款）
	ElapsedMs int64 `gorm:"column:elapsed_ms;not null;default:0" json:"elapsed_ms"`
	// PointsCost 任务全程实际扣费积分累计（阶段一百三十八）：每轮即时扣费时累加，完结落库并随
	// 任务列表接口下发（历史卡/重放卡展示"扣 N 积分"，无论按量/按次模式均为真实扣费精确值）
	PointsCost float64 `gorm:"column:points_cost;not null;default:0" json:"points_cost"`
	// ReplyMsgID 完结通知消息 ID（阶段七十）：前端重进会话时以答复气泡为锚点内联重放任务卡，执行过程历史可见
	ReplyMsgID uint `gorm:"column:reply_msg_id;not null;default:0" json:"reply_msg_id"`
	// SessionID 归属 AI 会话（阶段七十一）：任务回显落库时按当前生效会话盖戳，任务卡重放按会话区间过滤防串会话
	SessionID  uint      `gorm:"column:session_id;not null;default:0" json:"session_id"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AgentTaskRecord) TableName() string { return "im_agent_task" }

// AgentWhitelist 智能 Agent 审批白名单（阶段六十二）：审批弹窗"同意并加白"的持久化归口。
// kind=cmd → value 为命令首词前缀（如 node/git），后续命中前缀的 run_command 自动放行（阶段八十二：后台全量管理，DB 即真值）；
// kind=autowrite → 写文件免审批开关（value "0"=关，空/"on"/"1"=开，兼容旧记录）；
// kind=cmdinit → 命令白名单 DB 初始化标记（存在即 DB 集合为唯一真值，空集亦合法）；
// 阶段八十一/八十二扩展 kind=maxsteps/tool_timeout/approve_timeout/concurrency/queue_size/enabled/pcexec/
// http_enabled/http_private/search_enabled/search_provider/search_key/search_endpoint → 后台热更新参数（数值/开关存 "1"/"0"，密钥与地址原文存 value）。
// 阶段八十三：白名单按用户隔离——username 空=全局行（后台管理员设置，对全员生效）；非空=该用户个人行
// （审批弹窗"同意并加白"仅对发起用户本人生效，A 加白不影响 B）；生效判定=个人行 ∪ 全局行。
// 热更新参数行（maxsteps 等）恒为全局行（username 恒空）。
// 启动时加载进内存（atomic），重启不丢
type AgentWhitelist struct {
	ID    uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Kind  string `gorm:"column:kind;type:varchar(16);not null;index" json:"kind"`
	Value string `gorm:"column:value;type:varchar(512);not null" json:"value"` // 阶段八十二：512 容纳搜索 endpoint 完整 URL
	// Username 白名单归属（阶段八十三）：空=全局（后台设置对全员生效）；非空=用户个人（仅该用户生效）
	Username   string    `gorm:"column:username;type:varchar(32);not null;default:'';index" json:"username"`
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

// AgentChangeRecord 阶段七十七：Agent 任务文件变更审查记录（TRAE CN 同款"文件变更审查条"归口）。
// 工具 write_file/edit_file/delete_file 落盘前快照改前内容（BackupFile 指向备份文件），
// 任务完结时统一统计增删行数；撤销即按 Kind 还原/删除文件，保留即弃备份。
// Status: pending=待审查 kept=已保留 reverted=已撤销
type AgentChangeRecord struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	TaskID     string    `gorm:"column:task_id;type:varchar(40);not null;index" json:"task_id"`
	Username   string    `gorm:"column:username;type:varchar(32);not null;index" json:"username"` // 发起用户（撤销上行归属校验）
	Path       string    `gorm:"column:path;type:varchar(512);not null" json:"path"`              // 工作区相对路径（正斜杠）
	Kind       string    `gorm:"column:kind;type:varchar(8);not null" json:"kind"`                // create/modify/delete
	Adds       int       `gorm:"column:adds;not null;default:0" json:"adds"`                      // 新增行数（完结时统计回写）
	Dels       int       `gorm:"column:dels;not null;default:0" json:"dels"`                      // 删除行数（完结时统计回写）
	BackupFile string    `gorm:"column:backup_file;type:varchar(512)" json:"backup_file"`         // 改前内容备份文件绝对路径（create 为空）
	Env        string    `gorm:"column:env;type:varchar(8);not null;default:server" json:"env"`   // 阶段八十：归属环境 server=服务端工作区 / pc=用户本地磁盘（撤销需下发执行器）
	LocalPath  string    `gorm:"column:local_path;type:varchar(512)" json:"local_path"`           // 阶段八十：pc 环境文件本地绝对路径（撤销下发执行器还原用）
	Status     string    `gorm:"column:status;type:varchar(12);not null;default:pending" json:"status"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (AgentChangeRecord) TableName() string { return "im_agent_change" }

// Message 聊天消息表 im_message
type Message struct {
	ID      uint `gorm:"primaryKey;autoIncrement" json:"id"`
	MsgType int8 `gorm:"column:msg_type;type:tinyint;not null" json:"msg_type"` // 1群聊 2私聊 3文件消息
	// 阶段七十二：复合索引 idx_msg_from_to_read（from_user+to_user+is_read 全等值前缀）——
	// 登录会话列表的未读数 COUNT 原为全表扫描（EXPLAIN type=ALL，千万级消息时登录分钟级卡顿），
	// 私聊历史按双方互发对查询同样受益；群聊历史/AI 会话历史仍走主键倒扫 LIMIT（实测无劣化）
	FromUser string `gorm:"column:from_user;type:varchar(32);not null;index:idx_msg_from_to_read,priority:1" json:"from_user"`
	ToUser   string `gorm:"column:to_user;type:varchar(32);index:idx_msg_from_to_read,priority:2" json:"to_user"` // 群聊为空
	Content  string `gorm:"column:content;type:text" json:"content"`
	IsRead   bool   `gorm:"column:is_read;default:false;index:idx_msg_from_to_read,priority:3" json:"is_read"` // 已读状态
	Recalled bool   `gorm:"column:recalled;default:false" json:"recalled"`                                     // 是否已撤回
	// AI 回复 Token 消耗（服务端 usage 归口；普通消息恒为 0，历史加载同样可显示）
	PromptTokens     int `gorm:"column:prompt_tokens;default:0" json:"prompt_tokens,omitempty"`
	CompletionTokens int `gorm:"column:completion_tokens;default:0" json:"completion_tokens,omitempty"`
	TotalTokens      int `gorm:"column:total_tokens;default:0" json:"total_tokens,omitempty"`
	// AISessionID 归属 AI 多会话（阶段七十一）：AI 提问/回复、Agent 任务回显与答复落库时盖戳，
	// 上下文/历史/任务卡按列过滤实现会话隔离；0=默认会话（存量历史与未区分消息归口）
	AISessionID uint      `gorm:"column:ai_session_id;not null;default:0;index" json:"ai_session_id"`
	CreateTime  time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
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

// MsgPurgeApply 私聊永久删除审批表 im_msg_purge_apply（阶段七十二）
// 一方发起"彻底删除双方聊天记录"申请，对方同意后服务端才物理删除申请时点前的双方互发消息；
// 同一对用户同时仅允许一条待处理申请；申请落库归口，离线方重登时补推审批卡片不丢失
type MsgPurgeApply struct {
	ID         uint       `gorm:"primaryKey;autoIncrement" json:"id"`
	FromUser   string     `gorm:"column:from_user;type:varchar(32);not null;index:idx_purge_from" json:"from_user"` // 发起方
	ToUser     string     `gorm:"column:to_user;type:varchar(32);not null;index:idx_purge_to" json:"to_user"`       // 审批方
	Status     int8       `gorm:"column:status;type:tinyint;default:0" json:"status"`                               // 0待处理 1已同意 2已拒绝
	CreateTime time.Time  `gorm:"column:create_time;autoCreateTime" json:"create_time"`                             // 发起时间（删除范围截止点，审批期间的新消息不连带）
	HandleTime *time.Time `gorm:"column:handle_time" json:"handle_time"`                                            // 处理时间（未处理为 NULL；零值 time.Time 会被严格模式拒插，故用指针）
}

// TableName 指定表名
func (MsgPurgeApply) TableName() string { return "im_msg_purge_apply" }

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

// MCPServer MCP 服务器配置表 im_mcp_server（阶段八十八：TRAE CN 同款 MCP 能力，服务端归口）
// Go 服务端作为 MCP Host 统一管理所有 MCP Server 连接：stdio（服务端本地子进程）/
// sse（远程 SSE）/ http（远程 Streamable HTTP）三种传输；发现的工具供 AI 问答与智能
// Agent 注入调用（阶段八十九接入 Agent Loop），工具定义与执行细节客户端零感知
type MCPServer struct {
	ID        uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name      string `gorm:"column:name;type:varchar(64);uniqueIndex;not null" json:"name"`              // 服务器名（连接条目与工具命名空间锚点，全局唯一）
	Transport string `gorm:"column:transport;type:varchar(8);not null;default:'stdio'" json:"transport"` // stdio / sse / http
	// Command/Args 仅 stdio：可执行命令与参数（Args 为 JSON 数组字符串，含空格参数不丢真）
	Command string `gorm:"column:command;type:varchar(255);default:''" json:"command"`
	Args    string `gorm:"column:args;type:text" json:"args"`
	// Env 仅 stdio：环境变量（JSON 对象字符串，可能含密钥，仅服务端归口不下发普通链路）
	Env string `gorm:"column:env;type:text" json:"-"`
	// URL/Headers 仅 sse/http：完整端点地址与附加请求头（Headers 为 JSON 对象字符串，可挂 Bearer 鉴权）
	URL     string `gorm:"column:url;type:varchar(512);default:''" json:"url"`
	Headers string `gorm:"column:headers;type:text" json:"-"`
	// Owner 归属用户名（空=管理员公共服务器；阶段八十九用户自建预留：个人服务器 stdio 受白名单约束）
	Owner string `gorm:"column:owner;type:varchar(32);default:''" json:"owner"`
	// Enabled 启用状态（false 时连接循环退出、工具不注入）；AutoApprove 免审批开关
	// （true 时 Agent 调用该服务器工具自动放行，false 默认逐次人工审批——TRAE 同款默认确认）
	Enabled       bool   `gorm:"column:enabled;default:true" json:"enabled"`
	AutoApprove   bool   `gorm:"column:auto_approve;default:false" json:"auto_approve"`
	DisabledTools string `gorm:"column:disabled_tools;type:text" json:"-"`
	// Status 运行状态（连接管理器回写）：connecting/connected/disconnected/error；StatusMsg 附言（错误原因等）
	Status    string `gorm:"column:status;type:varchar(16);default:'disconnected'" json:"status"`
	StatusMsg string `gorm:"column:status_msg;type:varchar(512);default:''" json:"status_msg"`
	// ToolsCache 工具发现缓存（JSON 数组：name/description/input_schema，离线时管理页展示兜底）；ToolCount 工具数量
	ToolsCache string    `gorm:"column:tools_cache;type:mediumtext" json:"-"`
	ToolCount  int       `gorm:"column:tool_count;default:0" json:"tool_count"`
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (MCPServer) TableName() string { return "im_mcp_server" }

// MCPPlugin 阶段一百一十三：MCP 插件市场清单表（admin 后台维护，PC 端设置页插件市场拉取展示 + 一键安装）。
// 服务端归口：清单由管理员增删改（空表自动播种内置默认插件），客户端拉取后按预设自动写入本机 MCP 配置；
// Args 换行分隔（每行一个参数）、Env 换行 KEY=VALUE（与 PC 端编辑表单格式一致，安装时原样带入）
type MCPPlugin struct {
	ID          uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Name        string `gorm:"column:name;type:varchar(64);uniqueIndex;not null" json:"name"` // 唯一名（安装时作为本机 MCP 服务器名，重复安装将被拦截）
	Title       string `gorm:"column:title;type:varchar(128);default:''" json:"title"`        // 展示标题
	Description string `gorm:"column:description;type:varchar(512);default:''" json:"description"`
	Category    string `gorm:"column:category;type:varchar(32);default:''" json:"category"` // 分类页签（文件系统/数据库/网络/工具…）
	Command     string `gorm:"column:command;type:varchar(128);default:''" json:"command"`  // 启动命令（npx/uvx/node…）
	Args        string `gorm:"column:args;type:varchar(1024);default:''" json:"args"`       // 命令参数（换行分隔）
	Env         string `gorm:"column:env;type:varchar(1024);default:''" json:"env"`         // 环境变量模板（换行 KEY=VALUE，占位值由用户安装时补填）
	// NeedsConfig 含占位参数（密码/令牌/目录）：安装时打开预填表单让用户补填；false=默认参数可直接装完即用
	NeedsConfig bool `gorm:"column:needs_config;default:false" json:"needs_config"`
	// Icon 图标链接（http/https 图片 URL，admin 后台配置）；留空降级为首字母徽标（用户偏好：服务端图标优先，无图降级）
	Icon       string    `gorm:"column:icon;type:varchar(512);default:''" json:"icon"`
	Sort       int       `gorm:"column:sort;default:0" json:"sort"`          // 展示排序（小在前）
	Enabled    bool      `gorm:"column:enabled;default:true" json:"enabled"` // 上架状态（下架后用户端拉取不显示）
	CreateTime time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (MCPPlugin) TableName() string { return "im_mcp_plugin" }

// SysPrompt 阶段一百零六：系统提示词配置表（admin 后台可配置、保存即热更新，无需重启服务端）。
// 代码内硬编码提示词降级为默认值：本表有记录且内容非空时优先生效（后台调整属最新意图，重启不丢）；
// 清空保存即恢复默认（删除记录）。Key 模块唯一标识（如 git_commitmsg=AI 提交信息生成、
// git_review=AI 代码审查报告），后续其它提示词后台化复用本表归口。
// 列名 key_name：key 为 MySQL 保留字，显式改名防建表/查询歧义
type SysPrompt struct {
	ID         uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Key        string    `gorm:"column:key_name;type:varchar(32);not null;uniqueIndex" json:"key"`
	Content    string    `gorm:"column:content;type:text;not null" json:"content"` // 完整提示词文本
	UpdateTime time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 指定表名
func (SysPrompt) TableName() string { return "im_sys_prompt" }

// ===== 公司公告与动态（一期：后台发布归口 + 客户端微信式阅读 + 红点实时提醒） =====

// 公告分类常量（客户端与服务端同口径）
const (
	AnnCategoryNotice = "notice" // 公告
	AnnCategoryNews   = "news"   // 动态
	AnnCategoryRed    = "red"    // 红头文件
)

// 公告状态常量
const (
	AnnStatusDraft     int8 = 0 // 草稿（仅后台可见）
	AnnStatusPublished int8 = 1 // 已发布（客户端可见）
	AnnStatusWithdrawn int8 = 2 // 已撤回（客户端不可见，保留数据）
)

// Announcement 公告主表 im_announcement
type Announcement struct {
	ID       uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	Title    string `gorm:"column:title;type:varchar(128);not null" json:"title"`
	Category string `gorm:"column:category;type:varchar(16);default:'notice';index" json:"category"` // notice/news/red
	Cover    string `gorm:"column:cover;type:varchar(255);default:''" json:"cover"`                  // 封面图 URL（空则列表回退分类图标）
	Digest   string `gorm:"column:digest;type:varchar(255);default:''" json:"digest"`                // 摘要（列表页展示）
	// ContentHTML 富文本正文（后台编辑器产出，服务端白名单消毒后入库，客户端只渲染可信 HTML）
	ContentHTML string `gorm:"column:content_html;type:longtext" json:"content_html"`
	Status      int8   `gorm:"column:status;type:tinyint;default:0;index" json:"status"` // 0草稿 1已发布 2已撤回
	// ContentType 正文类型归口：html=富文本页（在线渲染消毒后 HTML）/ doc=文档型（以附件为主，详情直开文档预览）/ link=链接型（external_url 内置浏览器查看）
	ContentType string `gorm:"column:content_type;type:varchar(8);default:'html'" json:"content_type"`
	// CardStyle 卡牌样式归口（后台每篇可选，客户端按预设样式集渲染）：standard=微信标准卡 / cover-left=左文右封面 / cover-top=大图卡 / compact=紧凑条目
	CardStyle string `gorm:"column:card_style;type:varchar(16);default:'standard'" json:"card_style"`
	// ExternalURL 链接型公告目标地址（content_type=link 时生效；仅 http/https，服务端校验）
	ExternalURL string `gorm:"column:external_url;type:varchar(512);default:''" json:"external_url"`
	// OpenInBrowser 链接型打开方式：true=PC 内置浏览器浏览区打开（浏览器版/手机端 fallback 弹窗）/ false=系统外部打开
	OpenInBrowser bool `gorm:"column:open_in_browser;default:true" json:"open_in_browser"`
	// RequireConfirm 红头文件签收开关：true 时用户详情页需点击"已确认"，后台可看签收统计
	RequireConfirm bool      `gorm:"column:require_confirm;default:false" json:"require_confirm"`
	Stick          bool      `gorm:"column:stick;default:false" json:"stick"` // 置顶（列表最前）
	Publisher      string    `gorm:"column:publisher;type:varchar(32);default:''" json:"publisher"`
	PublishTime    time.Time `gorm:"column:publish_time" json:"publish_time"`
	CreateTime     time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
	UpdateTime     time.Time `gorm:"column:update_time;autoUpdateTime" json:"update_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (Announcement) TableName() string { return "im_announcement" }

// AnnouncementAttachment 公告附件表 im_announcement_attach（一篇公告多附件：pdf/word/表格/图片等）
// URL 复用聊天静态资源约定（/static/upload/ann_xxx.ext），预览复用 file-viewer 链路
type AnnouncementAttachment struct {
	ID             uint   `gorm:"primaryKey;autoIncrement" json:"id"`
	AnnouncementID uint   `gorm:"column:announcement_id;index" json:"announcement_id"`
	Name           string `gorm:"column:name;type:varchar(255);not null" json:"name"` // 原始文件名（展示用）
	URL            string `gorm:"column:url;type:varchar(255);not null" json:"url"`   // 静态资源 URL
	Size           int64  `gorm:"column:size;type:bigint;default:0" json:"size"`
	SortID         int    `gorm:"column:sort_id;default:0" json:"sort_id"` // 附件排序（小在前）
}

// TableName 表名沿用 im_ 前缀约定
func (AnnouncementAttachment) TableName() string { return "im_announcement_attach" }

// AnnouncementRead 公告已读/签收记录表 im_announcement_read（服务端归口统计，多端一致）
type AnnouncementRead struct {
	ID             uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	AnnouncementID uint      `gorm:"column:announcement_id;uniqueIndex:idx_ann_read" json:"announcement_id"`
	Username       string    `gorm:"column:username;type:varchar(32);uniqueIndex:idx_ann_read" json:"username"`
	Confirmed      bool      `gorm:"column:confirmed;default:false" json:"confirmed"` // 红头文件签收标记
	CreateTime     time.Time `gorm:"column:create_time;autoCreateTime" json:"create_time"`
}

// TableName 表名沿用 im_ 前缀约定
func (AnnouncementRead) TableName() string { return "im_announcement_read" }
