package server

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// recallWindow 撤回时间窗口：2 分钟内可撤回
// 原实现：const recallWindow = 2 * time.Minute 硬编码，现改为配置文件 recall_window 参数
// const recallWindow = 2 * time.Minute

// pushReadWatermarks 登录时补发用户全部私聊会话的对端已读水位（服务端归口，多端同步）
// 以 MSG.READ（from_user=对端）形式推送，复用前端现有已读处理（幂等，水位前进才更新）：
// 重连/重登后本地已读水位即时恢复，历史渲染无需等待实时回执即可显示"已读"
// 原实现：已读水位仅存于前端内存，重连丢失后需重新打开会话依赖服务端 is_read 恢复显示
func (s *Server) pushReadWatermarks(c *Client) {
	var convs []model.Conversation
	store.DB.Where("user_id = ? AND target <> ''", c.username).Find(&convs)
	for _, cv := range convs {
		// 对端已读水位：我发给对方且已读的最大消息 ID
		var maxID uint
		store.DB.Model(&model.Message{}).
			Where("from_user = ? AND to_user = ? AND is_read = ?", c.username, cv.Target, true).
			Select("COALESCE(MAX(id), 0)").Scan(&maxID)
		if maxID == 0 {
			continue
		}
		data, _ := json.Marshal(&protocol.Message{
			MsgType:   protocol.MsgTypeRead,
			FromUser:  cv.Target,
			ToUser:    c.username,
			Content:   strconv.FormatUint(uint64(maxID), 10),
			Timestamp: time.Now().Unix(),
		})
		c.send(data)
	}
}

// handleRead 已读回执：更新已读状态并转发给对方
// content 为已读到的最大消息 ID，服务端统一归口更新该范围内的消息状态
// 阶段十一增强：基于会话行 last_read_id 水位去重，仅水位前进才写库+转发+推送，
// 防止多端同时打开同一会话重复发送回执造成回执风暴（重复写库、重复转发、重复推送会话列表）
func (s *Server) handleRead(c *Client, msg *protocol.Message) {
	if msg.ToUser == "" || msg.ToUser == c.username {
		return
	}
	lastID, err := strconv.ParseUint(strings.TrimSpace(msg.Content), 10, 64)
	if err != nil || lastID == 0 {
		return
	}

	// 读取者会话行：承载已读回执水位（对方发消息时会创建会话行，此处兜底创建保证水位有落点）
	var conv model.Conversation
	if err := store.DB.Where("user_id = ? AND target = ?", c.username, msg.ToUser).First(&conv).Error; err != nil {
		conv = model.Conversation{UserID: c.username, Target: msg.ToUser}
		store.DB.Create(&conv)
	}
	// 原实现：无水位判断，多端重复回执每次都写库+转发+推送
	if uint(lastID) <= conv.LastReadID {
		// 水位未前进：重复回执，去重跳过（不写库、不转发、不推送会话列表）
		return
	}
	// 水位前进：先落水位，再更新消息状态
	store.DB.Model(&model.Conversation{}).Where("id = ?", conv.ID).Update("last_read_id", lastID)

	// 更新对方发给我的、ID 不超过 lastID 的消息为已读
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ? AND id <= ?", msg.ToUser, c.username, lastID).
		Update("is_read", true)

	// 回执转发给对方全部在线连接，供其界面显示"已读"（多端同步）
	// 原实现：s.hub.Get(msg.ToUser) 仅转发单一连接
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeRead,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   msg.Content,
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(msg.ToUser, data)

	// 未读数变化，刷新读取者全部在线连接的会话列表（多端同步未读清零）
	// 原实现：s.pushConvList(c) 仅刷新当前连接
	for _, conn := range s.hub.GetAll(c.username) {
		s.pushConvList(conn)
	}
}

// handleRecall 消息撤回：仅限 2 分钟内自己发送的消息
func (s *Server) handleRecall(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		s.sendError(c, "撤回消息无效")
		return
	}
	var record model.Message
	if err := store.DB.First(&record, msg.MsgID).Error; err != nil {
		s.sendError(c, "消息不存在")
		return
	}
	if record.FromUser != c.username {
		s.sendError(c, "只能撤回自己发送的消息")
		return
	}
	// 阶段一百五十四：红包消息禁止撤回（积分已扣减且可能已被领取，撤回语义与资金一致性问题归口为不支持）
	if record.MsgType == int8(protocol.MsgTypeRedPacket) {
		s.sendError(c, "红包消息不支持撤回")
		return
	}
	// 撤回时间窗口从配置文件读取（recall_window，单位秒）
	if time.Since(record.CreateTime) > time.Duration(s.cfg.RecallWindow)*time.Second {
		s.sendError(c, "超过撤回时间限制的消息无法撤回")
		return
	}
	// 阶段十二增强：撤回幂等校验，已撤回消息拒绝重复撤回，
	// 防止重复撤回通知（多端重复系统提示）、重复摘要刷新与重复置顶清理
	// 原实现：无已撤回校验，同一消息可被重复撤回并重复通知双方
	if record.Recalled {
		s.sendError(c, "该消息已撤回，请勿重复操作")
		return
	}

	// 标记为已撤回（保留记录，历史中显示"撤回了一条消息"）
	store.DB.Model(&model.Message{}).Where("id = ?", record.ID).Update("recalled", true)

	// 撤回后会话摘要联动：若撤回的是会话最后一条可见消息，摘要更新为撤回提示（服务端归口，多端随 CONV_LIST 同步）
	s.refreshConvSummaryAfterRecall(record)

	// 被撤回消息若已被置顶，自动取消置顶并同步双方
	var pins []model.MessagePin
	store.DB.Where("msg_id = ?", record.ID).Find(&pins)
	for _, p := range pins {
		store.DB.Delete(&model.MessagePin{}, p.ID)
		s.syncPinByKey(p.ConvKey)
	}

	// 通知双方（群聊则广播）
	// 阶段十二增强：通知携带原始消息接收方 ToUser（群聊为空），
	// 供前端校验撤回消息归属会话，杜绝跨会话串窗（撤回提示渲染进无关会话窗口）
	// 原实现：通知仅携带 FromUser/MsgID，前端无法判断归属，元素未找到时误渲染到当前打开的会话
	notice := protocol.Message{
		MsgType:   protocol.MsgTypeRecall,
		FromUser:  c.username,
		ToUser:    record.ToUser,
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(notice)
	if record.ToUser == "" {
		s.hub.Broadcast(data)
	} else {
		// 私聊撤回：通知双方全部在线连接（多端同步）
		s.sendToUser(record.ToUser, data)
		s.sendToUser(c.username, data)
	}
}

// refreshConvSummaryAfterRecall 撤回后会话摘要联动：
// 若被撤回消息是该会话最后一条可见消息，则相关会话行摘要更新为撤回提示，并推送会话列表多端同步
// 原实现：撤回不影响会话摘要，撤回最后一条消息后会话列表仍显示原消息内容
func (s *Server) refreshConvSummaryAfterRecall(record model.Message) {
	// 查询该会话最新的未撤回消息，判断撤回的是否为最后一条可见消息
	query := store.DB.Model(&model.Message{}).Where("recalled = ?", false)
	var users []string // 需要更新摘要的会话归属者
	if record.ToUser == "" {
		// 群聊会话：全部群消息，摘要更新所有已存在群会话行的用户
		// 阶段二十六：纳入群聊图片消息(4)——撤回群聊图片后摘要应重算为最新可见的图片/文字消息；
		// 需限定 to_user 为空，私聊图片同样为 msg_type=4 但 to_user 非空
		// 原实现：query = query.Where("msg_type = ?", 1)
		// 阶段一百五十四：纳入红包消息(86)——红包不可撤回但可作为"最新可见消息"，撤回旧消息时摘要应重算为红包摘要
		query = query.Where("msg_type IN ? AND to_user = ''", []int{1, 4, 86})
		store.DB.Model(&model.Conversation{}).Where("target = ''").Pluck("user_id", &users)
	} else {
		// 私聊会话：双方互发消息，摘要更新双方
		// 阶段二十四：纳入图片消息(4)与文件消息(5)，撤回文字后摘要应重算为最新的图片/文件消息摘要
		// 阶段一百五十四：纳入红包消息(86)，语义同群聊分支
		query = query.Where("msg_type IN ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			[]int{2, 4, 5, 86}, record.FromUser, record.ToUser, record.ToUser, record.FromUser)
		users = []string{record.FromUser, record.ToUser}
	}
	var latest model.Message
	err := query.Order("id desc").First(&latest).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		// 查询异常，保守跳过
		return
	}
	// 原实现：err != nil 一律 return，会话内全部消息均已撤回时查询无结果（ErrRecordNotFound），
	// 被误判为"存在更新的可见消息"导致摘要不更新；实际此时被撤回的就是最后的可见消息，应更新摘要
	// 摘要重算：撤回最后一条可见消息时显示撤回提示；撤回中间消息时重算为最新可见消息内容，
	// 避免摘要残留已撤回内容（服务端统一归口，与会话列表展示保持一致）
	// 阶段二十四：图片/文件消息的摘要按类型显示 [图片]/[文件]，避免 JSON 原文出现在会话列表
	summary := "[消息已撤回]"
	// 原实现：if err == nil && latest.ID != record.ID {
	// 判断条件缺陷：被撤回消息已先标记 recalled，查询（recalled=false）必不返回自身，
	// latest.ID 恒不等于 record.ID，导致撤回"最后一条可见消息"时误用更早的历史消息重算摘要
	// （如显示旧消息内容/[图片]），而非预期的"[消息已撤回]"；
	// 正确语义为仅当存在比被撤回消息更新的可见消息（即撤回的是中间消息）才重算摘要
	if err == nil && latest.ID > record.ID {
		// 会话存在更新的可见消息：摘要重算为最新可见消息内容
		summary = latest.Content
		switch latest.MsgType {
		case 4:
			summary = "[图片]"
		case 5:
			summary = "[文件]"
		case 86:
			// 阶段一百五十四：红包信封归口——撤回中间消息且最新可见消息为红包时，
			// 摘要显示"[红包] 祝福语"，复用 messageSummary 与正常会话摘要链路同口径，防 JSON 原串外泄
			summary = messageSummary(latest.Content)
		}
		if len(summary) > 200 {
			// 阶段六十六同源修复：按字符截断（原字节截断会切碎中文多字节字符，MySQL 拒绝无效 UTF-8）
			summary = string([]rune(summary)[:200])
		}
	}
	// 更新相关会话行摘要（保留 LastTime 不变，避免列表排序跳动）
	for _, u := range users {
		// 原实现：双方统一按 record.ToUser 匹配会话行，接收方的会话 target 为发送者导致匹配失败，摘要不更新
		target := record.ToUser // 发送方视角：会话对端为接收者
		if u == record.ToUser {
			// 接收方视角：会话对端为发送者
			target = record.FromUser
		}
		store.DB.Model(&model.Conversation{}).
			Where("user_id = ? AND target = ?", u, target).
			Update("last_msg", summary)
		s.notifyConvUpdate(u)
	}
}

// handleDelete 消息删除：仅记录删除者视角，不影响对方
func (s *Server) handleDelete(c *Client, msg *protocol.Message) {
	if msg.MsgID == 0 {
		return
	}
	var count int64
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ? AND msg_id = ?", c.username, msg.MsgID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.MessageDelete{UserID: c.username, MsgID: msg.MsgID})
	}
	// 阶段十四增强：删除的消息若是对方发给我的未读私聊消息，联动刷新未读角标（服务端归口）
	// 原实现：删除后不推送会话列表，未读数包含已删除消息，角标不减
	// 原实现：if err := store.DB.First(&record, msg.MsgID).Error; err == nil &&
	// 	record.MsgType == 2 && record.ToUser == c.username && !record.IsRead {
	// 	s.notifyConvUpdate(c.username)
	// }
	// 阶段十五增强：提取消息查询结果复用，删除联动置顶需按消息归属会话校验置顶记录
	var record model.Message
	recordErr := store.DB.First(&record, msg.MsgID).Error
	// 阶段一百五十四：未读联动扩为文字/图片/文件/红包——未读数已把这四类计入角标，
	// 删除未读消息时若不联动刷新，角标会残留到下次会话列表推送才消失
	if recordErr == nil && (record.MsgType == 2 || record.MsgType == 4 || record.MsgType == 5 || record.MsgType == 86) && record.ToUser == c.username && !record.IsRead {
		s.notifyConvUpdate(c.username)
	}
	// 阶段十五增强：置顶者删除置顶消息时联动取消置顶并同步（对齐撤回联动，服务端归口）
	// 仅置顶人（pin_user）删除才联动，对方删除仅对自己生效、云端消息对置顶人仍可见
	// 原实现：删除不处理置顶记录，置顶者视图中已删除的消息仍展示在置顶条
	if recordErr == nil {
		var pin model.MessagePin
		if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(record.FromUser, record.ToUser), c.username).
			First(&pin).Error; err == nil && pin.MsgID == record.ID {
			store.DB.Delete(&model.MessagePin{}, pin.ID)
			s.syncPinByKey(pin.ConvKey)
		}
	}
	s.sendError(c, "消息已删除")
}

// truncateEllipsis 阶段一百三十五：按字符数截断（中文友好），超长追加省略号
// 与 memory.go truncateRunes（无省略号）区分，避免改动既有调用方行为
func truncateEllipsis(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// searchRewriteRecords 阶段一百三十五：搜索结果展示文本归口（用户实测反馈：搜索结果出现
// 合并转发 JSON 原串）。JSON 信封类消息（合并转发/引用/AI 图片/AI 文档）content 为 JSON 原串，
// LIKE 命中可能落在结构字段（时间戳/url/用户名等）而非用户可见文本，且原串外泄到搜索结果。
// 此处解析已知信封改写为用户可见的展示文本；关键词未命中任何用户可见文本的消息直接剔除
// （误命中本就不该出现）。未知 JSON 一律原样保留——那是用户手打的 JSON 文本消息，属可见文本。
// 仅改写 Content 展示文本，不动 ID/时间等定位字段（搜索结果点击按 msg_id 定位，不受影响）
func (s *Server) searchRewriteRecords(records []model.Message, keyword string) []model.Message {
	kw := strings.ToLower(keyword)
	out := make([]model.Message, 0, len(records))
	for _, r := range records {
		content := r.Content
		if content == "" || content[0] != '{' {
			out = append(out, r) // 纯文本/数字等非 JSON 消息原样保留
			continue
		}
		// 合并转发信封：{"merged":{"c":N,"i":[{"f":发送者,"t":时间戳,"k":类型,"x":文本摘要}]}}
		// （与 server.go 会话摘要同款判定：c>0 或 i 非空才算信封）
		var mergedEnv struct {
			Merged struct {
				C int               `json:"c"`
				I []json.RawMessage `json:"i"`
			} `json:"merged"`
		}
		if err := json.Unmarshal([]byte(content), &mergedEnv); err == nil && (mergedEnv.Merged.C > 0 || len(mergedEnv.Merged.I) > 0) {
			count := mergedEnv.Merged.C
			if count == 0 {
				count = len(mergedEnv.Merged.I)
			}
			hitText := ""    // 首个命中的子消息文本（预览价值最高，优先返回）
			nameHit := false // 仅发送者名命中（搜人名找聊天记录场景）
			for _, raw := range mergedEnv.Merged.I {
				var item struct {
					F string `json:"f"`
					X string `json:"x"`
				}
				if err := json.Unmarshal(raw, &item); err != nil {
					continue
				}
				if hitText == "" && item.X != "" && strings.Contains(strings.ToLower(item.X), kw) {
					hitText = item.X
					break
				}
				if !nameHit && strings.Contains(strings.ToLower(item.F), kw) {
					nameHit = true // 不 break：继续找文本命中，文本预览优先于人名命中
				}
			}
			if hitText != "" {
				r.Content = "[聊天记录] " + truncateEllipsis(hitText, 80)
			} else if nameHit {
				r.Content = "[聊天记录] " + strconv.Itoa(count) + "条消息"
			} else {
				continue // 关键词仅命中 JSON 结构字段（时间戳/类型标记等），属误命中，剔除
			}
			out = append(out, r)
			continue
		}
		// 引用信封：{"quote":{"text":被引用原文,...},"text":回复正文}——气泡两者都显示，任一命中都保留；
		// 展示回复正文（与客户端 quoteDisplayText 同口径）
		var quoteEnv struct {
			Quote json.RawMessage `json:"quote"`
			Text  string          `json:"text"`
		}
		if err := json.Unmarshal([]byte(content), &quoteEnv); err == nil && quoteEnv.Quote != nil && quoteEnv.Text != "" {
			quoted := ""
			var q struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(quoteEnv.Quote, &q); err == nil {
				quoted = q.Text
			}
			if strings.Contains(strings.ToLower(quoteEnv.Text), kw) || strings.Contains(strings.ToLower(quoted), kw) {
				r.Content = quoteEnv.Text
			} else {
				continue
			}
			out = append(out, r)
			continue
		}
		// AI 图片/文档问答信封：{"image":url,"text":附言} / {"doc":url,"name":文件名,"text":附言}
		var aiEnv struct {
			Image string `json:"image"`
			Doc   string `json:"doc"`
			Name  string `json:"name"`
			Text  string `json:"text"`
		}
		if err := json.Unmarshal([]byte(content), &aiEnv); err == nil && (aiEnv.Image != "" || aiEnv.Doc != "") {
			switch {
			case strings.Contains(strings.ToLower(aiEnv.Text), kw):
				r.Content = aiEnv.Text
			case aiEnv.Doc != "" && strings.Contains(strings.ToLower(aiEnv.Name), kw):
				r.Content = "[文档] " + aiEnv.Name // 文档名命中：按会话摘要同款形态展示
			default:
				continue // 仅 url 命中属误命中（url 非用户可见语义文本），剔除
			}
			out = append(out, r)
			continue
		}
		out = append(out, r) // 其余 JSON：用户手打的 JSON 文本消息，原样保留
	}
	return out
}

// handleSearch 消息关键词搜索：ToUser 为空时搜索全部会话，否则搜索指定会话
// 搜索范围仅限当前用户可见的消息（排除已撤回与自己删除的）
func (s *Server) handleSearch(c *Client, msg *protocol.Message) {
	keyword := strings.TrimSpace(msg.Content)
	if keyword == "" {
		s.sendError(c, "请输入搜索关键词")
		return
	}
	// 转义 LIKE 通配符，避免 % 和 _ 影响匹配
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(keyword)

	query := store.DB.Model(&model.Message{}).
		Where("content LIKE ? AND recalled = ?", "%"+escaped+"%", false)

	// 排除当前用户已删除的消息
	var delIDs []uint
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ?", c.username).Pluck("msg_id", &delIDs)
	if len(delIDs) > 0 {
		query = query.Where("id NOT IN ?", delIDs)
	}

	if msg.ToUser != "" {
		// 指定会话搜索（私聊双向）
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, c.username, msg.ToUser, msg.ToUser, c.username)
	} else {
		// 全局搜索：与我相关的群聊 + 私聊
		query = query.Where("(msg_type = 1 OR (msg_type = 2 AND (from_user = ? OR to_user = ?)))", c.username, c.username)
	}

	var records []model.Message
	if err := query.Order("id desc").Limit(20).Find(&records).Error; err != nil {
		s.sendError(c, "搜索失败")
		return
	}
	// 阶段一百三十五：JSON 信封类消息展示文本归口（合并转发原串外泄修复，详见函数注释）
	records = s.searchRewriteRecords(records, keyword)

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeSearchResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}

// handleConvSearch 会话内消息搜索：在当前聊天窗口对应会话范围内搜索
// ToUser 为空表示群聊会话，非空表示与指定用户的私聊会话
func (s *Server) handleConvSearch(c *Client, msg *protocol.Message) {
	keyword := strings.TrimSpace(msg.Content)
	if keyword == "" {
		s.sendError(c, "请输入搜索关键词")
		return
	}
	// 转义 LIKE 通配符，避免 % 和 _ 影响匹配
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(keyword)

	query := store.DB.Model(&model.Message{}).
		Where("content LIKE ? AND recalled = ?", "%"+escaped+"%", false)

	// 排除当前用户已删除的消息
	var delIDs []uint
	store.DB.Model(&model.MessageDelete{}).Where("user_id = ?", c.username).Pluck("msg_id", &delIDs)
	if len(delIDs) > 0 {
		query = query.Where("id NOT IN ?", delIDs)
	}

	if msg.ToUser == "" {
		// 群聊会话内搜索：全部群消息
		query = query.Where("msg_type = ?", 1)
	} else {
		// 私聊会话内搜索：双方互发的消息
		query = query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
			2, c.username, msg.ToUser, msg.ToUser, c.username)
	}

	var records []model.Message
	if err := query.Order("id desc").Limit(50).Find(&records).Error; err != nil {
		s.sendError(c, "搜索失败")
		return
	}
	// 阶段一百三十五：JSON 信封类消息展示文本归口（合并转发原串外泄修复，详见函数注释）
	records = s.searchRewriteRecords(records, keyword)

	data, _ := json.Marshal(records)
	resp := protocol.Message{
		MsgType:   protocol.MsgTypeConvSearchResp,
		FromUser:  c.username,
		ToUser:    msg.ToUser,
		Content:   string(data),
		Timestamp: time.Now().Unix(),
	}
	respData, _ := json.Marshal(resp)
	c.send(respData)
}
