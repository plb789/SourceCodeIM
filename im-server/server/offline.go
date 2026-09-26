package server

import (
	"context"
	"encoding/json"
	"strconv"
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

// isOnlineFast 并发改造 A4：内存优先在线判定（hub 存在该用户连接即在线，零 Redis 往返）。
// 消息热路径（群成员离线判定、好友列表在线态、私聊投递/入队分流）使用。
// 集群模式升级为全局判定：本实例 hub 未命中时回退全局在线名单（HASH im:list 心跳时间戳，
// 60s 新鲜度）——用户连接在其他实例时仍判在线，实时投递经总线跨实例送达
// 单实例模式（总线关闭）行为不变：纯本地判定零 Redis 往返
func (s *Server) isOnlineFast(username string) bool {
	if s.hub.Count(username) > 0 {
		return true
	}
	if s.hub.bus == nil {
		return false
	}
	ts, err := store.RDB.HGet(context.Background(), KeyUserList, username).Result()
	if err != nil {
		return false
	}
	t, _ := strconv.ParseInt(ts, 10, 64)
	return t >= time.Now().Add(-onlineFreshS*time.Second).Unix()
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

// queueOfflineBatch 批量离线入队（集群模式全局群离线名单归口）：pipeline 一次往返写入
// 全部离线用户的队列并续期（原逐用户 2 次 Redis 往返/人，万级离线名单 = 2 万次往返 → 1 次）
func (s *Server) queueOfflineBatch(usernames []string, msg *protocol.Message) {
	if len(usernames) == 0 {
		return
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx := context.Background()
	pipe := store.RDB.Pipeline()
	for _, name := range usernames {
		key := store.KeyOfflineMsg + name
		pipe.RPush(ctx, key, string(data))
		pipe.Expire(ctx, key, offlineMsgTTL)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		logger.Error("批量离线入队失败（%d 人）: %v", len(usernames), err)
	}
}

// pushOfflineMessages 用户上线后批量推送离线消息并清空队列
// 并发改造 C1：撤回状态校验原逐条查库（N 条离线消息 = N 次查询），现一次 IN 查询批量化；
// 投递原走非阻塞 send（发送队列满静默丢弃，且丢完即清队列无法恢复），现改 sendBlock
// 短超时背压——队列满时短暂等待写循环消费，等待失败保留队列中止补发，高负载下不再无声丢消息。
// 回归修复（多端登录双推）：原实现 LRange 全量快照后 Del——同用户两连接（web+pc）同时登录时
// 各自拿到同一批快照，同一端同一条消息可能收到两份（文本消息客户端无 msg_id 去重，重复气泡）；
// 现改 LPop 逐条原子消费，每条消息只被一个补发任务取走，多端各自消费到不重叠的条目
func (s *Server) pushOfflineMessages(c *Client) {
	ctx := context.Background()
	key := store.KeyOfflineMsg + c.username

	// 预览快照仅用于批量撤回校验（LRange 不消费），消费以 LPop 为准
	msgs, err := store.RDB.LRange(ctx, key, 0, -1).Result()
	if err != nil || len(msgs) == 0 {
		return
	}
	total := len(msgs)

	// 收集预览快照中带库 ID 的消息做批量撤回校验（500 个/批）
	preview := make(map[uint]struct{}, len(msgs))
	var ids []uint
	for _, raw := range msgs {
		var m protocol.Message
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		if m.MsgID > 0 {
			ids = append(ids, m.MsgID)
			preview[m.MsgID] = struct{}{}
		}
	}
	recalledSet := make(map[uint]struct{})
	for i := 0; i < len(ids); i += 500 {
		end := i + 500
		if end > len(ids) {
			end = len(ids)
		}
		var recRows []uint
		store.DB.Model(&model.Message{}).
			Where("id IN ? AND recalled = ?", ids[i:end], true).
			Pluck("id", &recRows)
		for _, id := range recRows {
			recalledSet[id] = struct{}{}
		}
	}

	pushed := 0
	keepQueue := false
	for {
		// C1 审计加固：连接已关闭（被踢/断网/写失败）立即中止，避免对死连接
		// 逐条空等背压超时（大积压 × 3s/条的登录协程空转）；未消费条目天然留在队列
		if c.isClosed() {
			keepQueue = true
			break
		}
		raw, err := store.RDB.LPop(ctx, key).Result()
		if err != nil {
			break // 队列已空（redis.Nil），本次补发完成
		}
		var m protocol.Message
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue // 坏帧直接丢弃
		}
		// 以数据库为准修正撤回状态：离线期间已被撤回的消息不再补发。
		// 多端并发消费场景预览快照可能覆盖不到个别条目，此时单条查库兜底
		//（单端登录常规路径预览覆盖全部，零额外查询，与批量校验等价）
		if m.MsgID > 0 {
			if _, checked := preview[m.MsgID]; !checked {
				var rec model.Message
				if store.DB.Select("recalled").First(&rec, m.MsgID).Error == nil && rec.Recalled {
					continue
				}
			}
		}
		if _, bad := recalledSet[m.MsgID]; bad {
			continue // 已撤回，直接丢弃
		}
		data, _ := json.Marshal(m)
		if !c.sendBlock(data, 3*time.Second) {
			// 队列满且 3s 未消化：多为连接异常，本条回推队头保留（下次登录从这条续推），
			// 后续未消费条目仍在队列；替代原"非阻塞丢弃+清队列"的静默丢失
			store.RDB.LPush(ctx, key, raw)
			keepQueue = true
			break
		}
		pushed++
	}

	if keepQueue {
		logger.Warn("用户 %s 离线补发中止（连接异常/关闭），剩余条目保留待下次登录重推", c.username)
	} else {
		// 补发完成即结束：LPop 消费至空时 Redis 空列表键自动删除，无需显式 Del——
		// 回归修复：原 Del 与并发 RPUSH（上线瞬间消息判定离线入队）交错会误删刚入队的新消息
		logger.Info("用户 %s 上线，推送离线消息 %d/%d 条", c.username, pushed, total)
	}
}
