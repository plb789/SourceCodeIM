package server

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// ConvInfo 会话信息（推送给前端）
type ConvInfo struct {
	Target   string `json:"target"`    // 对方用户名，空表示群聊
	LastMsg  string `json:"last_msg"`  // 最后一条消息摘要
	LastTime int64  `json:"last_time"` // 最后消息时间戳
	Unread   int64  `json:"unread"`    // 未读数（仅私聊统计）
	Pinned   bool   `json:"pinned"`    // 是否置顶
}

// touchConversation 刷新会话（存在则更新最后消息，不存在则创建）
func (s *Server) touchConversation(userID, target, lastMsg string) {
	// 阶段六十六修复：摘要截断按字符截取——原实现 lastMsg[:200] 按字节截断，中文多字节字符
	// 被拦腰切断产生无效 UTF-8，MySQL 拒绝写入且错误被吞，导致会话行创建/更新静默失败（任务完结通知无角标）
	if runes := []rune(lastMsg); len(runes) > 200 {
		lastMsg = string(runes[:200])
	}
	now := time.Now()
	var conv model.Conversation
	err := store.DB.Where("user_id = ? AND target = ?", userID, target).First(&conv).Error
	if err != nil {
		if err := store.DB.Create(&model.Conversation{UserID: userID, Target: target, LastMsg: lastMsg, LastTime: now}).Error; err != nil {
			logger.Error("会话行创建失败（用户 %s，目标 %s）：%v", userID, target, err)
		}
	} else {
		conv.LastMsg = lastMsg
		conv.LastTime = now
		if err := store.DB.Save(&conv).Error; err != nil {
			logger.Error("会话行更新失败（用户 %s，目标 %s）：%v", userID, target, err)
		}
	}
}

// ensureGroupConv 登录时确保群聊会话存在（不刷新时间，避免每次登录都跳到最前）
func (s *Server) ensureGroupConv(userID string) {
	var count int64
	store.DB.Model(&model.Conversation{}).Where("user_id = ? AND target = ''", userID).Count(&count)
	if count == 0 {
		store.DB.Create(&model.Conversation{UserID: userID, Target: "", LastMsg: "群聊", LastTime: time.Now()})
	}
}

// pushConvList 推送会话列表（置顶优先，按最后消息时间倒序）
func (s *Server) pushConvList(c *Client) {
	var convs []model.Conversation
	store.DB.Where("user_id = ?", c.username).
		Order("pinned DESC, last_time DESC").Limit(50).Find(&convs)

	infos := make([]ConvInfo, 0, len(convs))
	for _, cv := range convs {
		var unread int64
		if cv.Target != "" {
			// 私聊未读数：对方发给我且未读的未撤回消息
			// 阶段十四增强：排除自己已删除的消息（删除仅对自己生效，不可见消息不应计入未读）
			// 原实现：仅排除已撤回，删除未读消息后角标不减，与"删除仅对自己生效"语义矛盾
			// 阶段二十四：图片消息(4)与文件消息(5)同样计入未读
			store.DB.Model(&model.Message{}).
				Where("msg_type IN ? AND from_user = ? AND to_user = ? AND is_read = ? AND recalled = ?"+
					" AND id NOT IN (SELECT msg_id FROM im_msg_delete WHERE user_id = ?)",
					[]int{2, 4, 5}, cv.Target, c.username, false, false, c.username).
				Count(&unread)
		}
		// 阶段四十补充：读取侧摘要归口自愈——历史引用消息曾把 JSON 原串直存进群聊摘要，
		// 推送时统一再走一次 messageSummary，坏数据同时回写修正，避免旧摘要一直显示 JSON
		healed := messageSummary(cv.LastMsg)
		if healed != cv.LastMsg {
			cv.LastMsg = healed
			store.DB.Model(&model.Conversation{}).Where("id = ?", cv.ID).Update("last_msg", healed)
		}
		infos = append(infos, ConvInfo{
			Target:   cv.Target,
			LastMsg:  cv.LastMsg,
			LastTime: cv.LastTime.Unix(),
			Unread:   unread,
			Pinned:   cv.Pinned,
		})
	}

	content, _ := json.Marshal(infos)
	msg := protocol.Message{
		MsgType:   protocol.MsgTypeConvList,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(msg)
	c.send(data)
}

// notifyConvUpdate 在线时向指定用户推送会话列表（推送其全部在线连接，多端同步）
// 原实现：仅推送单一连接
func (s *Server) notifyConvUpdate(username string) {
	for _, c := range s.hub.GetAll(username) {
		s.pushConvList(c)
	}
}

// handleConvPin 会话置顶/取消置顶
func (s *Server) handleConvPin(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空
	pin := msg.Content == "pin"
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("pinned", pin)
	if pin {
		s.sendError(c, "已置顶该会话")
	} else {
		s.sendError(c, "已取消置顶")
	}
	s.pushConvList(c)
}

// convMessageQuery 构建指定会话的消息范围查询（target 为空表示群聊）
func convMessageQuery(userID, target string) *gorm.DB {
	query := store.DB.Model(&model.Message{})
	if target == "" {
		// 群聊：全部群消息
		// 阶段二十六：纳入群聊图片消息(4)，需限定 to_user 为空——私聊图片同样为 msg_type=4 但 to_user 非空
		// 原实现：return query.Where("msg_type = ?", 1)
		return query.Where("msg_type IN ? AND to_user = ''", []int{1, 4})
	}
	// 私聊：双方互发的消息
	return query.Where("msg_type = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
		2, userID, target, target, userID)
}

// markConvRead 清空指定私聊会话未读：对方发给我的未读消息标记为已读，并同步提升已读回执水位
// 水位前进时转发回执给对方全部在线连接（多端同步），供发送方实时显示"已读"
// 原实现：仅更新 is_read 不同步水位，会话删除重建后水位从 0 开始，旧消息回执会重复写库+转发
func (s *Server) markConvRead(userID, target string) {
	// 对方发给我的最大消息 ID（含已读），作为水位提升目标
	var maxID uint
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ?", target, userID).
		Select("COALESCE(MAX(id), 0)").Scan(&maxID)

	// 未读清零：对方发给我的未读消息标记为已读
	store.DB.Model(&model.Message{}).
		Where("from_user = ? AND to_user = ? AND is_read = ?", target, userID, false).
		Update("is_read", true)

	// 水位仅在前进时提升，避免回退
	var oldWater uint
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", userID, target).
		Select("COALESCE(last_read_id, 0)").Scan(&oldWater)
	if maxID <= oldWater {
		return
	}
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", userID, target).
		Update("last_read_id", maxID)

	// 转发回执给对方全部在线连接，发送方实时看到"已读"（多端同步）
	data, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeRead,
		FromUser:  userID,
		ToUser:    target,
		Content:   strconv.FormatUint(uint64(maxID), 10),
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(target, data)
}

// handleConvClear 会话清空：将该会话全部消息标记为当前用户已删除（复用消息删除表，云端记录保留）
// 同时清空未读与会话摘要，保留会话行与最后时间，避免列表排序跳动
func (s *Server) handleConvClear(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 查询会话范围内全部消息 ID
	var ids []uint
	convMessageQuery(c.username, target).Pluck("id", &ids)
	if len(ids) > 0 {
		// 排除已存在于删除表的记录，避免重复插入
		var exist []uint
		store.DB.Model(&model.MessageDelete{}).
			Where("user_id = ? AND msg_id IN ?", c.username, ids).
			Pluck("msg_id", &exist)
		existSet := make(map[uint]bool, len(exist))
		for _, id := range exist {
			existSet[id] = true
		}
		var records []model.MessageDelete
		for _, id := range ids {
			if !existSet[id] {
				records = append(records, model.MessageDelete{UserID: c.username, MsgID: id})
			}
		}
		if len(records) > 0 {
			store.DB.CreateInBatches(&records, 500)
		}
	}

	// 清空未读：对方发给我的未读消息标记为已读，并同步提升回执水位转发对方
	// 原实现：仅批量更新 is_read，不同步水位、不转发回执
	if target != "" {
		s.markConvRead(c.username, target)
	}

	// 清空会话摘要（保留会话行，云端记录不受影响）
	store.DB.Model(&model.Conversation{}).
		Where("user_id = ? AND target = ?", c.username, target).
		Update("last_msg", "")

	// 阶段十五增强：清空联动置顶——清空者为置顶人时自动取消置顶并同步双方
	// （清空者视图内该会话消息已全部删除，置顶条不应继续展示；对方清空不影响置顶）
	// 原实现：清空不处理置顶记录，置顶者清空后置顶条仍展示已清空的消息
	var pin model.MessagePin
	if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(c.username, target), c.username).
		First(&pin).Error; err == nil {
		store.DB.Delete(&model.MessagePin{}, pin.ID)
		s.syncPinByKey(pin.ConvKey)
	}

	s.sendError(c, "聊天记录已清空")
	s.pushConvList(c)
}

// handleConvDelete 会话删除：从会话列表移除该会话（云端聊天记录保留，收到新消息时会话自动重建）
// 同时将未读清零，避免下次会话重建时旧未读重新出现
func (s *Server) handleConvDelete(c *Client, msg *protocol.Message) {
	target := strings.TrimSpace(msg.ToUser) // 群聊为空

	// 删除会话记录
	store.DB.Where("user_id = ? AND target = ?", c.username, target).Delete(&model.Conversation{})

	// 未读清零：对方发给我的未读消息标记为已读，并同步提升回执水位转发对方
	// 原实现：仅批量更新 is_read，会话删除重建后水位从 0 开始，旧消息回执会重复写库+转发
	if target != "" {
		s.markConvRead(c.username, target)
	}

	// 阶段十五增强：删除会话联动置顶——会话删除者为置顶人时自动取消置顶并同步双方，
	// 防止会话行删除后登录补发孤儿置顶（pushPinList 仍会推送已删除会话的置顶）
	// 原实现：删除会话不处理置顶记录，置顶者删除会话重登后仍被还原已删除会话的置顶条
	var pin model.MessagePin
	if err := store.DB.Where("conv_key = ? AND pin_user = ?", convKey(c.username, target), c.username).
		First(&pin).Error; err == nil {
		store.DB.Delete(&model.MessagePin{}, pin.ID)
		s.syncPinByKey(pin.ConvKey)
	}

	s.sendError(c, "会话已删除")
	s.pushConvList(c)
}
