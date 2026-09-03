package server

import (
	"context"
	"encoding/json"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

const offlineMsgTTL = 7 * 24 * time.Hour // 离线消息缓存 7 天

// isOnline 判断用户是否在线（依据 Redis 在线缓存）
func (s *Server) isOnline(username string) bool {
	exists, _ := store.RDB.Exists(context.Background(), store.KeyOnlineUser+username).Result()
	return exists > 0
}

// queueOffline 将消息加入指定用户的离线消息队列（按时间顺序追加）
func (s *Server) queueOffline(username string, msg *protocol.Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx := context.Background()
	key := store.KeyOfflineMsg + username
	store.RDB.RPush(ctx, key, string(data))
	store.RDB.Expire(ctx, key, offlineMsgTTL)
}

// pushOfflineMessages 用户上线后批量推送离线消息并清空队列
func (s *Server) pushOfflineMessages(c *Client) {
	ctx := context.Background()
	key := store.KeyOfflineMsg + c.username

	msgs, err := store.RDB.LRange(ctx, key, 0, -1).Result()
	if err != nil || len(msgs) == 0 {
		return
	}

	for _, raw := range msgs {
		var m protocol.Message
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		// 以数据库为准修正撤回状态：离线期间已被撤回的消息不再补发，
		// 其撤回提示由打开会话时的历史加载按 recalled 字段统一渲染，避免前后不一致
		// 原实现：直接按离线队列快照补发，撤回状态无法同步
		if m.MsgID > 0 {
			var rec model.Message
			if err := store.DB.Select("recalled").First(&rec, m.MsgID).Error; err == nil && rec.Recalled {
				continue
			}
		}
		data, _ := json.Marshal(m)
		c.send(data)
	}

	// 推送完成后清空离线队列，避免重复推送
	store.RDB.Del(ctx, key)
	logger.Info("用户 %s 上线，推送离线消息 %d 条", c.username, len(msgs))
}
