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
	MsgTypeConvClear         = 27 // 会话清空（仅清当前用户视图，云端记录保留）
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
	Remark      string `json:"remark"`       // 好友备注名
	Group       string `json:"group"`        // 好友分组
}
