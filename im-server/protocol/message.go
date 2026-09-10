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
	MsgTypeRead        = 13 // 已读回执
	MsgTypeRecall      = 14 // 消息撤回
	MsgTypeDelete      = 15 // 消息删除（仅删除者自己的视图）
	MsgTypeSearch      = 16 // 消息搜索请求（content 为关键词）
	MsgTypeSearchResp  = 17 // 消息搜索响应
	MsgTypeConvList    = 18 // 最近会话列表同步
	MsgTypeConvPin     = 19 // 会话置顶/取消置顶（content: pin/unpin）

	MsgTypeFriendRequest     = 20 // 好友申请
	MsgTypeFriendRequestResp = 21 // 好友申请响应
	MsgTypeFriendList        = 22 // 好友列表同步
	MsgTypeFriendDelete      = 23 // 删除好友
	MsgTypeBlacklist         = 24 // 黑名单操作
	MsgTypeFriendUpdate      = 25 // 好友备注/分组更新
	MsgTypeBlacklistList     = 26 // 黑名单列表同步
	MsgTypeConvClear         = 27 // 会话清空（clear=false 缺省：仅清当前用户视图，写删除表云端保留；clear=true：永久删除——物理删除云端消息，群聊拒绝，AI 会话按 session_id 限定当前会话）
	MsgTypeConvDelete        = 28 // 会话删除（从列表移除，云端记录保留）
	MsgTypeMsgPin            = 29 // 消息置顶/取消置顶（content: pin/unpin，msg_id 指定消息）
	MsgTypeMsgPinSync        = 30 // 置顶消息状态同步（content 为 JSON，msg_id=0 表示无置顶）
	MsgTypeConvSearch        = 31 // 会话内消息搜索（当前聊天窗口内）
	MsgTypeConvSearchResp    = 32 // 会话内搜索响应
	MsgTypeFilePersisted     = 33 // 聊天文件持久化完成同步（携带 file_id + msg_id，双方实时气泡回填消息 ID）
	MsgTypeGroupImage        = 34 // 群聊图片消息（阶段二十六：HTTP 上传后广播，content 为 JSON：url/name/size/nonce）
	MsgTypeFriendReqList     = 35 // 好友申请列表请求（阶段二十九：微信式"新的朋友"，拉取申请记录与待处理数量）
	MsgTypeFriendReqListResp = 36 // 好友申请列表响应（content 为 JSON：list 申请记录 + pending 待处理数量，服务端归口）
	MsgTypeProfileUpdate     = 37 // 个人资料更新（阶段三十：content 为 JSON：nickname/gender/region/signature）
	MsgTypeProfileQuery      = 38 // 个人资料查询（阶段三十：to_user 为目标用户名，查看微信式资料卡）
	MsgTypeProfileResp       = 39 // 个人资料响应/同步（content 为 JSON：username/nickname/gender/region/signature/avatar/is_friend/remark）

	MsgTypeFileProgress = 40 // 阶段三十二：超大文件分片直传进度同步（content 为 JSON：upload_id/nonce/received/total/file_name/file_size，服务端节流推送接收方）
	MsgTypeFileCancel   = 41 // 阶段三十二：超大文件上传取消（上行 file_id=upload_id；下行 content 为 JSON：upload_id/nonce，双方移除进度气泡）

	// 阶段四十三：AI 问答（服务端归口调用模型服务，密钥仅存服务端配置）
	MsgTypeAIAgents    = 42 // AI 智能体列表请求/响应（响应 content 为 JSON：[{name,avatar,model}]）
	MsgTypeAIChat      = 43 // AI 问答提问（to_user=智能体名，content=问题文本）
	MsgTypeAIStream    = 44 // AI 流式回复增量（from_user=智能体名，content=增量文本，stream_id 关联同一次回复）
	MsgTypeAIStreamEnd = 45 // AI 流式回复结束（content=完整回复，msg_id=落库 ID，remark=error 时表示本次回复失败）

	// 阶段五十九：智能 Agent 自动化任务（工具调用闭环 + 权限审批，事件流推送给发起用户）
	MsgTypeAgentRun        = 46 // 上行：发起/取消任务（content 为 JSON：发起 {goal,agent_name}；取消 {task_id,action:"cancel"}）
	MsgTypeAgentEvent      = 47 // 下行：任务事件流（content 为 JSON：{task_id,type,...}，type=thought/tool_start/tool_result/todo/status/done/error）
	MsgTypeAgentApproveReq = 48 // 下行：高危工具审批请求（content 为 JSON：{task_id,step,tool,params,reason}）
	MsgTypeAgentApprove    = 49 // 上行：审批结果（content 为 JSON：{task_id,step,action:"approve"/"reject",params?}，params 为改参放行后的新参数）

	// 阶段六十：Agent 本地执行器（PC 端在线时文件/命令工具下放到用户本地执行，文件落在用户电脑）
	MsgTypeAgentExecReq  = 50 // 下行：服务端 → PC 渲染进程，本地工具执行请求（content 为 JSON：{task_id,step,tool,params}，step=tool_call ID 归属校验键）
	MsgTypeAgentExecResp = 51 // 上行：PC 渲染进程 → 服务端，本地执行结果（content 为 JSON：{task_id,step,ok,output}，迟到/不匹配直接丢弃）

	// 阶段六十一：Agent 用户自选工作区/沙箱白名单（PC 端用户自选任意文件夹作为本地工作区，白名单目录内允许文件操作）
	MsgTypeAgentSandbox = 52 // 上行：PC 渲染进程 → 服务端，沙箱白名单上报（content 为 JSON：{primary:"主工作区目录",dirs:["授权目录",...]}；登录后/变更时上报，服务端仅内存保存用于提示词注入）

	// 阶段六十二：AI 后续提问建议（Trae CN 同款，回复完成后点击可直接继续提问）
	MsgTypeAISuggest = 53 // 下行：后续提问建议（from_user=智能体名，content 为 JSON 字符串数组，仅当前查看会话时渲染）

	// 阶段七十一：AI 多会话（Trae CN 同款"新建会话"）——用户+智能体 多会话归口，im_message 表结构零改动
	MsgTypeAISessionList = 54 // 上行请求/下行响应：会话列表（上行 to_user=智能体名；下行 content 为 JSON：{current_id,sessions:[{id,title,create_time}]}）
	MsgTypeAISessionNew  = 55 // 上行：新建会话（to_user=智能体名；下行 content 为 JSON：{session_id,title}，首条消息落库时回填区间起点）
	MsgTypeAISessionDel  = 56 // 上行：删除/清空会话（to_user=智能体名，session_id 指定；默认会话（最早一条）禁止删除）。clear=true 时为"清空会话"：真删除该会话全部消息与任务记录（含默认会话 sid=0，会话行保留）；clear=false 为删除会话：消息并入默认会话

	// 阶段七十二：私聊永久删除审批（双方同意才物理删除，会话内审批卡片）
	MsgTypePurgeApply = 57 // 上行：发起删除申请（to_user=对方）；下行：审批卡片状态同步（content 为 JSON：{apply_id,from_user,to_user,status}，status 0待处理 1已同意 2已拒绝；发起/响应/登录补推/结果变更 复用同一帧）
	MsgTypePurgeResp  = 58 // 上行：审批结果（to_user=发起方，msg_id=apply_id，content=agree/reject）；无独立下行——结果经 57 卡片帧同步双方

	// 阶段七十三：AI 流式问答停止（Trae CN 同款"停止"按钮）——中断该用户对该智能体进行中的流式回复
	MsgTypeAIStop = 59 // 上行：停止问答（to_user=智能体名）；停止后由问答协程统一收口：已生成部分落库 + 下行 45 结束帧（remark="stopped"）

	// 阶段七十五：命令执行实时输出流 + 转后台（TRAE 同款——长命令不阻塞对话，输出控制台实时可见）
	MsgTypeAgentToolOutput = 60 // 上行：PC 渲染进程 → 服务端，本地命令输出增量/终态（content 为 JSON：{task_id,step,chunk,total_bytes,over,final,exit_code,duration_ms}；final=true 为进程结束帧，服务端转发为任务事件流 tool_output/tool_exit）
	MsgTypeAgentBg         = 61 // 双向：前端 → 服务端请求长命令转后台（{task_id,step}）；服务端执行的服务端本地命令直接生效，PC 本地执行时服务端原样转发给 PC 渲染进程桥接到执行器

	// 阶段七十六：Agent 工作区文件面板（Trae CN 同款——右侧文件树 + 高亮预览 + 手动编辑保存；
	// 执行环境与 Agent 工具同源：PC 在线走用户本地磁盘（经 64/65 转发），离线回退服务端工作区）
	MsgTypeWsFileReq  = 62 // 上行：web 前端 → 服务端文件面板请求（content 为 JSON：{op:"tree"/"read"/"save",req_id,path,content?}）
	MsgTypeWsFileResp = 63 // 下行：服务端 → web 前端文件面板响应（content 为 JSON：{op,req_id,ok,error,root?,entries?/content?,binary?,truncated?}）
	MsgTypePcFileReq  = 64 // 下行：服务端 → PC 渲染进程，本地文件操作请求（content 为 JSON：{op,req_id,path,content?}，路径校验复用执行器 safePath）
	MsgTypePcFileResp = 65 // 上行：PC 渲染进程 → 服务端本地文件操作结果（content 为 JSON：{op,req_id,ok,error,root?,entries?/content?,binary?,truncated?}）

	// 阶段七十七：Agent 文件变更审查（TRAE CN 同款"文件变更审查条"——撤销/保留归口）
	MsgTypeAgentChanges = 66 // 上行：审查操作（content 为 JSON：{task_id,action:"keep"/"revert",path?}，path 缺省=全部 pending）；下行：审查后全量刷新帧（content 为 JSON：{task_id,session_id,changes:[{path,kind,adds,dels,status}],total_adds,total_dels}）
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
	Page        int    `json:"page"`            // 分页页码（从 1 开始）
	PageSize    int    `json:"page_size"`       // 每页条数
	FileID      string `json:"file_id"`         // 文件传输唯一标识
	TotalChunks int    `json:"total_chunks"`    // 文件总分片数
	MsgID       uint   `json:"msg_id"`          // 消息唯一 ID（持久化后回填，用于去重）
	Remark      string `json:"remark"`          // 好友备注名
	Group       string `json:"group"`           // 好友分组
	StreamID    string `json:"stream_id"`       // 阶段四十三：AI 流式回复关联 ID（同一次回复的增量与结束帧共用）
	SessionID   uint   `json:"session_id"`      // 阶段七十一：AI 多会话 ID（HISTORY 按会话区间拉历史；0=不区分会话取全量）
	Clear       bool   `json:"clear,omitempty"` // 阶段七十二：AI_SESSION_DEL 置 true 时为"清空会话"（真删除消息+任务记录，会话行保留；sid=0 允许），缺省 false 维持"删除会话并入默认"语义
	Platform    string `json:"platform"`        // 阶段六十：登录设备类型（pc=Electron 桌面端；空=Web/手机，Agent 本地执行器按此判定下发）
	// AI 回复 Token 消耗（服务端 usage 归口，随 AI_STREAM_END 结束帧下发；其余消息恒为 0 不序列化）
	PromptTokens     int `json:"prompt_tokens,omitempty"`
	CompletionTokens int `json:"completion_tokens,omitempty"`
	TotalTokens      int `json:"total_tokens,omitempty"`
	// 已读状态（随私聊回显帧下发：AI 提问回显为 true——AI 会话无回执语义，服务端落库即视为已读；
	// 普通私聊回显为 false 保持既有回执链路）
	IsRead bool `json:"is_read,omitempty"`
}
