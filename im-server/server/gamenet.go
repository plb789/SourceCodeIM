package server

// ===== 阶段二百九十二：局域网游戏跨公网联机（Steam 同款"局域网联机跨公网"） =====
// 路线 B：P2P 打洞直连优先 + TURN 中继兜底（不做虚拟网卡；虚拟网卡另案评估）
// 设计文档：docs/局域网公网联机开发文档.md（含影响分析、容量模型、中继集群部署方案）
//
// 职责划分（服务端数据归口，与文件直传同水位）：
//   1. 109 房间层：房主建房 / 加入 / 退出 / 踢人 / 就绪 / 开局 / 房间态全量广播 / 关房，
//      沿用项目既有 action 模式（同 70 通话 / 90 远程 / 91 直传 / 105 位置共享）
//   2. 110 连接层：probe → accept（先到先得锁定赢家）→ offer/answer/candidate → ping → abort，
//      整体照搬 filep2p.go 骨架（含懒清理看门狗 + from_user 归口防伪造）
//   3. 服务端只见信令：游戏字节走 WebRTC DataChannel 点对点，或经内置 TURN 中继转发，服务端零参与
//
// 开关：config.yaml game_net.enabled（false 时 109/110 一律回错，既有功能零回归）
// 本期（一期）主线形态：形态二「通用端口隧道」——客户端本地监听游戏端口，游戏零改动
//
// 房间态跨实例归口（15.6 必做）：房间表落 Redis（非进程内存），各实例读写同一份，
// 房间态广播经 sendToUsers（本地 + 总线定向信封）送达，多实例部署不漏推。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/protocol"
	"im-server/store"

	"github.com/redis/go-redis/v9"
)

// ----- Redis 键（房间态跨实例共享；room_ttl 秒过期，activity 惰性续期）-----
const (
	gnKeyRoomPrefix   = "im:game:room:" // + room_id → 房间元数据 hash
	gnKeyMemberSuffix = ":m"            // 房间元数据键 + 该后缀 → 成员 hash（username → "1"/"0" 就绪）
	gnKeyRoomsIndex   = "im:game:rooms" // set：活跃房间号索引（create 时惰性剔除已过期项）
	gnKeyUserPrefix   = "im:game:user:" // + username → set：该用户所在房间号
	// 阶段二百九十二 M8：大厅在场名单（ZSET：username → 最近心跳 unix 秒；惰性剔除，不落库）
	gnKeyLobby = "im:game:lobby"
)

// gnLobbyTimeout 大厅在场判定窗口（秒）：客户端 20s 续期心跳，45s 未续期即视为离线
const gnLobbyTimeout = 45

func gnRoomKey(id string) string   { return gnKeyRoomPrefix + id }
func gnMemberKey(id string) string { return gnKeyRoomPrefix + id + gnKeyMemberSuffix }
func gnUserKey(u string) string    { return gnKeyUserPrefix + u }

// ----- Lua 原子脚本（跨实例并发写归口：max_rooms / max_per_user / max_members 原子校验）-----

// gnCreateScript 建房原子脚本
//
//	KEYS[1]=房间索引set KEYS[2]=用户房间set KEYS[3]=房间元数据hash KEYS[4]=成员hash
//	ARGV[1]=room_id ARGV[2]=host ARGV[3]=name ARGV[4]=group_id ARGV[5]=pass_hash
//	     ARGV[6]=host_port ARGV[7]=mode ARGV[8]=now ARGV[9]=max_rooms ARGV[10]=max_per_user
//	     ARGV[11]=ttl ARGV[12]=房间键前缀
//	     ARGV[13]=game_mode ARGV[14]=max_players ARGV[15]=game_id ARGV[16]=game_name（M8 建房扩展）
//
// 返回：1=成功 / -1=房间数达上限 / -2=用户并发房间达上限 / -3=房间号冲突
const gnCreateScript = `
local idx = KEYS[1]
local uset = KEYS[2]
local meta = KEYS[3]
local mem = KEYS[4]
local prefix = ARGV[12]
local ttl = tonumber(ARGV[11])
local ids = redis.call('SMEMBERS', idx)
for i = 1, #ids do
  if redis.call('EXISTS', prefix .. ids[i]) == 0 then
    redis.call('SREM', idx, ids[i])
  end
end
if redis.call('SCARD', idx) >= tonumber(ARGV[9]) then return -1 end
if redis.call('SCARD', uset) >= tonumber(ARGV[10]) then return -2 end
if redis.call('EXISTS', meta) == 1 then return -3 end
redis.call('HSET', meta, 'host', ARGV[2], 'name', ARGV[3], 'group_id', ARGV[4],
  'pass', ARGV[5], 'host_port', ARGV[6], 'mode', ARGV[7], 'status', 'waiting',
  'created_at', ARGV[8], 'updated_at', ARGV[8],
  'game_mode', ARGV[13], 'max_players', ARGV[14], 'game_id', ARGV[15], 'game_name', ARGV[16])
redis.call('HSET', mem, ARGV[2], '0')
redis.call('SADD', idx, ARGV[1])
redis.call('SADD', uset, ARGV[1])
redis.call('EXPIRE', meta, ttl)
redis.call('EXPIRE', mem, ttl)
return 1
`

// gnJoinScript 加入原子脚本
//
//	KEYS[1]=用户房间set KEYS[2]=房间元数据hash KEYS[3]=成员hash
//	ARGV[1]=room_id ARGV[2]=user ARGV[3]=now ARGV[4]=max_per_user ARGV[5]=max_members ARGV[6]=ttl
//
// 返回：1=已加入 / 2=已在房（幂等续期） / -1=房间不存在 / -2=用户并发房间达上限 / -3=房间满员
const gnJoinScript = `
local uset = KEYS[1]
local meta = KEYS[2]
local mem = KEYS[3]
local ttl = tonumber(ARGV[6])
if redis.call('EXISTS', meta) == 0 then return -1 end
if redis.call('HEXISTS', mem, ARGV[2]) == 1 then
  redis.call('SADD', uset, ARGV[1])
  redis.call('HSET', meta, 'updated_at', ARGV[3])
  redis.call('EXPIRE', meta, ttl)
  redis.call('EXPIRE', mem, ttl)
  return 2
end
if redis.call('SCARD', uset) >= tonumber(ARGV[4]) then return -2 end
if redis.call('HLEN', mem) >= tonumber(ARGV[5]) then return -3 end
redis.call('HSET', mem, ARGV[2], '0')
redis.call('SADD', uset, ARGV[1])
redis.call('HSET', meta, 'updated_at', ARGV[3])
redis.call('EXPIRE', meta, ttl)
redis.call('EXPIRE', mem, ttl)
return 1
`

// ----- 数据结构 -----

// gnRoomSignal 109 上行信令体（action 分发；字段按 action 取用）
type gnRoomSignal struct {
	Action   string `json:"action"`
	RoomID   string `json:"room_id"`
	Name     string `json:"name"`
	Pass     string `json:"pass"`
	GroupID  uint   `json:"group_id"`
	HostPort int    `json:"host_port"`
	Mode     string `json:"mode"`
	Target   string `json:"target"` // kick 目标
	// 阶段二百九十二 M8：建房扩展（对战模式/房间总人数/已入库联机游戏）与房内聊天正文
	GameMode   string `json:"game_mode"`   // 对战模式（1v1/2v2/3v3/4v4/5v5/8v8/16v16/ffa 混战）
	MaxPlayers int    `json:"max_players"` // 房间总人数（服务端按 game_net.max_members 收敛）
	GameID     int    `json:"game_id"`     // 已入库联机游戏 id（0=未指定）
	GameName   string `json:"game_name"`   // 游戏名（列表展示；服务端按 rune 裁剪归口）
	Text       string `json:"text"`        // chat：房内聊天正文（服务端裁剪 + 归口 from/ts）
}

// gnLobbySignal 112 上行信令体（大厅层：在场心跳 + 大厅聊天）
type gnLobbySignal struct {
	Action string `json:"action"` // enter / ping / leave / msg
	Text   string `json:"text"`   // msg：大厅聊天正文
}

// gnLobbyUser 大厅在场玩家视图（下行 users；仅账号 + 昵称，不含房间/端口等敏感信息）
type gnLobbyUser struct {
	Username string `json:"username"`
	Name     string `json:"name"`
}

// gnMemberView 房间成员视图（下行 state.members）
type gnMemberView struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Ready    bool   `json:"ready"`
	Host     bool   `json:"host"`
	Online   bool   `json:"online"`
}

// gnRoomBrief 房间列表条目（下行 list.rooms）
type gnRoomBrief struct {
	RoomID     string `json:"room_id"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	HostName   string `json:"host_name"`
	GroupID    uint   `json:"group_id,omitempty"`
	Count      int    `json:"count"`
	Status     string `json:"status"`
	GameID     int    `json:"game_id,omitempty"`     // M8：已入库联机游戏 id（列表按游戏筛选）
	GameName   string `json:"game_name,omitempty"`   // M8：游戏名
	GameMode   string `json:"game_mode,omitempty"`   // M8：对战模式
	MaxPlayers int    `json:"max_players,omitempty"` // M8：房间总人数
}

// gnEnvelope 109/112 下行统一信封（content）
type gnEnvelope struct {
	Action   string         `json:"action"`
	RoomID   string         `json:"room_id,omitempty"`
	GroupID  uint           `json:"group_id,omitempty"`
	Host     string         `json:"host,omitempty"`
	HostPort int            `json:"host_port,omitempty"`
	Mode     string         `json:"mode,omitempty"`
	Status   string         `json:"status,omitempty"`
	Members  []gnMemberView `json:"members,omitempty"`
	Rooms    []gnRoomBrief  `json:"rooms,omitempty"`
	Reason   string         `json:"reason,omitempty"`
	// 阶段二百九十二 M8：房间元数据回吐（created/state/list 共用）+ chat/msg 聊天字段 + users 在场名单
	GameID     int           `json:"game_id,omitempty"`
	GameName   string        `json:"game_name,omitempty"`
	GameMode   string        `json:"game_mode,omitempty"`
	MaxPlayers int           `json:"max_players,omitempty"`
	From       string        `json:"from,omitempty"`      // chat/msg：发送者账号（服务端归口，防伪造）
	FromName   string        `json:"from_name,omitempty"` // chat/msg：发送者昵称
	Text       string        `json:"text,omitempty"`      // chat/msg：正文
	TS         int64         `json:"ts,omitempty"`        // chat/msg：服务端时间戳（秒）
	Users      []gnLobbyUser `json:"users,omitempty"`     // 112 users：大厅在场名单
}

// HandleGameRoomSignal 房间层信令入口（msg_type=109）
func (s *Server) HandleGameRoomSignal(c *Client, msg *protocol.Message) {
	if !s.cfg.GameNet.Enabled {
		s.sendError(c, "游戏联机未启用")
		return
	}
	var p gnRoomSignal
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" {
		s.sendError(c, "游戏房间信令格式错误")
		return
	}
	switch p.Action {
	case "create":
		s.gnHandleCreate(c, &p)
	case "join":
		s.gnHandleJoin(c, &p)
	case "leave":
		s.gnHandleLeave(c, &p)
	case "kick":
		s.gnHandleKick(c, &p)
	case "ready":
		s.gnHandleReady(c, &p)
	case "start":
		s.gnHandleStart(c, &p)
	case "state":
		s.gnHandleState(c, &p)
	case "list":
		s.gnHandleList(c, &p)
	case "chat":
		s.gnHandleChat(c, &p)
	default:
		s.sendError(c, "未知游戏房间操作")
	}
}

// HandleGameLobbySignal 大厅层信令入口（msg_type=112）
//
// 大厅是"页签级公共空间"：在场名单与聊天都不落库、不进离线队列/历史/未读（对齐"大厅不持久化"口径）。
// 在场态用 Redis ZSET（score=最近心跳秒，45s 未续期即视为离线）做惰性剔除，与 110 连接层同款懒清理，
// 不起定时器风暴；跨实例共享同一份 ZSET，多实例部署的在场名单与聊天广播一致。
func (s *Server) HandleGameLobbySignal(c *Client, msg *protocol.Message) {
	if !s.cfg.GameNet.Enabled {
		s.sendError(c, "游戏联机未启用")
		return
	}
	var p gnLobbySignal
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" {
		s.sendError(c, "游戏大厅信令格式错误")
		return
	}
	from := c.username // from 一律以连接登录名归口（防伪造他人发言）
	ctx := context.Background()
	now := time.Now().Unix()
	switch p.Action {
	case "enter":
		gnLobbyTouch(ctx, from, now)
		users := gnLobbyUsers(ctx, now)
		s.gnBroadcastLobby(users, &gnEnvelope{Action: "users", Users: gnLobbyViews(users)})
	case "ping":
		gnLobbyTouch(ctx, from, now)
	case "leave":
		store.RDB.ZRem(ctx, gnKeyLobby, from)
		users := gnLobbyUsers(ctx, now)
		s.gnBroadcastLobby(users, &gnEnvelope{Action: "users", Users: gnLobbyViews(users)})
	case "msg":
		text := gnTrimRunes(p.Text, 200)
		if text == "" {
			return
		}
		gnLobbyTouch(ctx, from, now)
		users := gnLobbyUsers(ctx, now)
		s.gnBroadcastLobby(users, &gnEnvelope{
			Action: "msg", From: from, FromName: nicknameOf(from), Text: text, TS: now,
		})
	default:
		s.sendError(c, "未知游戏大厅操作")
	}
}

// HandleGameNetSignal 连接层信令入口（msg_type=110）
//
// 与 filep2p.go 同水位同骨架：服务端只见信令，游戏字节走 WebRTC DataChannel 点对点，
// 或经内置 TURN 中继转发，服务端零参与。
func (s *Server) HandleGameNetSignal(c *Client, msg *protocol.Message) {
	if !s.cfg.GameNet.Enabled {
		s.sendError(c, "游戏联机未启用")
		return
	}
	var p gnNetSignalPayload
	if err := json.Unmarshal([]byte(msg.Content), &p); err != nil || p.Action == "" || p.ConnID == "" {
		s.sendError(c, "游戏连接信令格式错误")
		return
	}
	// from_user 一律以连接登录名归口（防伪造他人身份发信令，同 call.go/filep2p.go）
	from := c.username
	switch p.Action {
	case "probe":
		s.gnNetProbe(c, msg, from, &p)
	case "accept":
		s.gnNetAccept(from, msg.Content, &p)
	case "offer", "answer", "candidate", "relay":
		s.gnNetRelay(from, msg.Content, &p)
	case "ping":
		s.gnNetPing(from, &p)
	case "abort":
		s.gnNetAbort(from, msg.Content, &p)
	default:
		s.sendError(c, "未知游戏连接操作")
	}
}

// ----- 基础工具 -----

// gnNewRoomID 生成 6 位房间号（冲突由建房脚本 EXISTS 校验兜底，重试即可）
func gnNewRoomID() string {
	return fmt.Sprintf("%06d", rand.Intn(1000000))
}

// gnModeSlots 对战模式 → 所需席位数（ffa 混战不在此表，人数由房主自选，见 gnHandleCreate）
var gnModeSlots = map[string]int{
	"1v1": 2, "2v2": 4, "3v3": 6, "4v4": 8, "5v5": 10, "8v8": 16, "16v16": 32,
}

// gnTrimRunes 房间名按 rune 裁剪（防多字节截断）
func gnTrimRunes(s string, max int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > max {
		r = r[:max]
	}
	return string(r)
}

// gnPruneUser 惰性剔除该用户已失效（房间键过期）的历史房间号，保证并发房间计数准确
func gnPruneUser(u string) {
	ctx := context.Background()
	ids, err := store.RDB.SMembers(ctx, gnUserKey(u)).Result()
	if err != nil || len(ids) == 0 {
		return
	}
	for _, id := range ids {
		if n, _ := store.RDB.Exists(ctx, gnRoomKey(id)).Result(); n == 0 {
			store.RDB.SRem(ctx, gnUserKey(u), id)
		}
	}
}

// gnLobbyTouch 大厅在场续期（ZSET score=当前秒，对齐惰性剔除口径，不落库）
func gnLobbyTouch(ctx context.Context, u string, now int64) {
	_ = store.RDB.ZAdd(ctx, gnKeyLobby, redis.Z{Score: float64(now), Member: u}).Err()
}

// gnLobbyUsers 大厅在场用户名（先惰性剔除超时项，再按心跳时间升序返回，多端展示稳定）
func gnLobbyUsers(ctx context.Context, now int64) []string {
	store.RDB.ZRemRangeByScore(ctx, gnKeyLobby, "-inf", strconv.FormatInt(now-gnLobbyTimeout, 10))
	users, _ := store.RDB.ZRange(ctx, gnKeyLobby, 0, -1).Result()
	return users
}

// gnLobbyViews 在场玩家视图（账号 + 昵称，不含房间/端口等敏感信息）
func gnLobbyViews(users []string) []gnLobbyUser {
	out := make([]gnLobbyUser, 0, len(users))
	for _, u := range users {
		out = append(out, gnLobbyUser{Username: u, Name: nicknameOf(u)})
	}
	return out
}

// gnTouch 房间活跃续期（room_ttl 惰性续期 + updated_at；110 连接层 ping 亦调用此函数）
func (s *Server) gnTouch(roomID string) {
	ctx := context.Background()
	ttl := time.Duration(s.cfg.GameNet.RoomTTL) * time.Second
	now := strconv.FormatInt(time.Now().Unix(), 10)
	pipe := store.RDB.Pipeline()
	pipe.Expire(ctx, gnRoomKey(roomID), ttl)
	pipe.Expire(ctx, gnMemberKey(roomID), ttl)
	pipe.HSet(ctx, gnRoomKey(roomID), "updated_at", now)
	_, _ = pipe.Exec(ctx)
}

// gnRoomMembers 房间成员表（username → 就绪标记）
func gnRoomMembers(ctx context.Context, roomID string) map[string]string {
	m, _ := store.RDB.HGetAll(ctx, gnMemberKey(roomID)).Result()
	return m
}

// gnStateEnv 组装房间态信封（state/created；成员排序：房主优先 + 用户名升序，保证多端展示稳定）
func (s *Server) gnStateEnv(ctx context.Context, roomID, action string) *gnEnvelope {
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	env := &gnEnvelope{Action: action, RoomID: roomID}
	if len(meta) == 0 {
		return env
	}
	env.Host = meta["host"]
	env.HostPort, _ = strconv.Atoi(meta["host_port"])
	env.Mode = meta["mode"]
	env.Status = meta["status"]
	// M8 建房扩展字段回吐（房主页与加入者房间页展示，列表亦复用同一份 meta）
	env.GameMode = meta["game_mode"]
	env.GameName = meta["game_name"]
	env.GameID, _ = strconv.Atoi(meta["game_id"])
	env.MaxPlayers, _ = strconv.Atoi(meta["max_players"])
	gid, _ := strconv.Atoi(meta["group_id"])
	env.GroupID = uint(gid)
	members := gnRoomMembers(ctx, roomID)
	env.Members = make([]gnMemberView, 0, len(members))
	for u, r := range members {
		env.Members = append(env.Members, gnMemberView{
			Username: u,
			Name:     nicknameOf(u),
			Ready:    r == "1",
			Host:     u == env.Host,
			Online:   s.isOnlineFast(u),
		})
	}
	sort.Slice(env.Members, func(i, j int) bool {
		if env.Members[i].Host != env.Members[j].Host {
			return env.Members[i].Host
		}
		return env.Members[i].Username < env.Members[j].Username
	})
	return env
}

// gnSendRoom 定向推送 109 信封（服务端归口 App FromUser 为空；本地 + 总线）
func (s *Server) gnSendRoom(user string, env *gnEnvelope) {
	content, _ := json.Marshal(env)
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeGameRoomSignal,
		ToUser:    user,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(user, data)
}

// gnBroadcast 批量推送 109 信封（一次总线信封覆盖全部成员，跨实例不漏推）
func (s *Server) gnBroadcast(users []string, env *gnEnvelope) {
	if len(users) == 0 {
		return
	}
	content, _ := json.Marshal(env)
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeGameRoomSignal,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUsers(users, data)
}

// gnBroadcastLobby 批量推送 112 大厅信封（一次总线信封覆盖全部在场玩家，跨实例不漏推；不落库）
func (s *Server) gnBroadcastLobby(users []string, env *gnEnvelope) {
	if len(users) == 0 {
		return
	}
	content, _ := json.Marshal(env)
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeGameLobbySignal,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUsers(users, data)
}

// gnBroadcastState 向房间全部成员广播最新房间态（成员变更即时同步，对齐 105 state 全量广播）
func (s *Server) gnBroadcastState(ctx context.Context, roomID string) {
	env := s.gnStateEnv(ctx, roomID, "state")
	if len(env.Members) == 0 {
		return
	}
	names := make([]string, 0, len(env.Members))
	for _, m := range env.Members {
		names = append(names, m.Username)
	}
	s.gnBroadcast(names, env)
}

// gnCloseRoom 关闭房间：向剩余成员广播 closed（先广播后删），再清理全部房间键与索引
func (s *Server) gnCloseRoom(ctx context.Context, roomID, reason string) {
	members := gnRoomMembers(ctx, roomID)
	names := make([]string, 0, len(members))
	for u := range members {
		names = append(names, u)
	}
	if len(names) > 0 {
		s.gnBroadcast(names, &gnEnvelope{Action: "closed", RoomID: roomID, Reason: reason})
	}
	// 连接层收口（110）：房间关闭即摘除该房间全部隧道会话，双方收 abort(room_closed/host_left/...)，防孤儿隧道
	s.gnNetAbortRoom(roomID, reason)
	store.RDB.Del(ctx, gnRoomKey(roomID), gnMemberKey(roomID))
	store.RDB.SRem(ctx, gnKeyRoomsIndex, roomID)
	for _, u := range names {
		store.RDB.SRem(ctx, gnUserKey(u), roomID)
	}
	logger.Info("游戏房间 %s 关闭（原因 %s）", roomID, reason)
}

// ----- action 处理 -----

// gnHandleCreate 建房：群房间校验群成员资格；口令服务端哈希；max_rooms/max_per_user 由 Lua 原子校验
func (s *Server) gnHandleCreate(c *Client, p *gnRoomSignal) {
	from := c.username
	if p.GroupID > 0 && !isGroupMember(p.GroupID, from) {
		s.sendError(c, "你不是该群成员，无法创建群房间")
		return
	}
	if p.HostPort < 0 || p.HostPort > 65535 {
		s.sendError(c, "游戏端口无效")
		return
	}
	// 接入形态：以房间声明为准，受全局 mode 收敛（一期主线 tunnel）
	mode := "tunnel"
	switch s.cfg.GameNet.Mode {
	case "lane":
		mode = "lane"
	case "tunnel":
		mode = "tunnel"
	default:
		if m := strings.TrimSpace(p.Mode); m == "lane" || m == "tunnel" {
			mode = m
		}
	}
	name := gnTrimRunes(p.Name, 32)
	passHash := ""
	if pw := strings.TrimSpace(p.Pass); pw != "" {
		sum := sha256.Sum256([]byte(pw))
		passHash = hex.EncodeToString(sum[:])
	}
	// M8：对战模式与房间总人数归口。模式须在白名单内；席位需求与房间总人数互相收敛，
	// 超出 game_net.max_members 的模式（4v4 及以上）直接拒绝（客户端虽置灰，服务端仍须防绕过），
	// 容量扩容（Mesh 三段拓扑）为三期承载。
	gameMode := strings.TrimSpace(p.GameMode)
	maxPlayers := p.MaxPlayers
	if maxPlayers <= 0 || maxPlayers > s.cfg.GameNet.MaxMembers {
		maxPlayers = s.cfg.GameNet.MaxMembers
	}
	if slots, ok := gnModeSlots[gameMode]; ok {
		if slots > s.cfg.GameNet.MaxMembers {
			s.sendError(c, fmt.Sprintf("该对战模式需 %d 个席位，超出当前联机上限（%d 人）", slots, s.cfg.GameNet.MaxMembers))
			return
		}
		maxPlayers = slots
	} else if gameMode != "ffa" { // 混战（ffa）人数由房主设定，其余非法值一律清空（列表显示"—"）
		gameMode = ""
	}
	if maxPlayers < 2 {
		maxPlayers = 2
	}
	gameName := gnTrimRunes(p.GameName, 32)

	ctx := context.Background()
	gnPruneUser(from)
	now := strconv.FormatInt(time.Now().Unix(), 10)
	ttl := strconv.Itoa(s.cfg.GameNet.RoomTTL)
	maxRooms := strconv.Itoa(s.cfg.GameNet.MaxRooms)
	maxPerUser := strconv.Itoa(s.cfg.GameNet.MaxPerUser)

	ret := 0
	var roomID string
	for attempt := 0; attempt < 6; attempt++ {
		roomID = gnNewRoomID()
		res, err := store.RDB.Eval(ctx, gnCreateScript,
			[]string{gnKeyRoomsIndex, gnUserKey(from), gnRoomKey(roomID), gnMemberKey(roomID)},
			roomID, from, name, strconv.Itoa(int(p.GroupID)), passHash,
			strconv.Itoa(p.HostPort), mode, now, maxRooms, maxPerUser, ttl, gnKeyRoomPrefix,
			gameMode, strconv.Itoa(maxPlayers), strconv.Itoa(p.GameID), gameName).Int()
		if err != nil {
			logger.Error("游戏房间创建失败（房主 %s）：%v", from, err)
			s.sendError(c, "创建房间失败，请重试")
			return
		}
		if res == -3 { // 房间号冲突：换号重试
			continue
		}
		ret = res
		break
	}
	switch ret {
	case 1:
		logger.Info("游戏房间 %s 建立：房主 %s（%d 端口，mode=%s，group=%d，game=%s/%s，人数=%d）",
			roomID, from, p.HostPort, mode, p.GroupID, gameName, gameMode, maxPlayers)
		s.gnSendRoom(from, s.gnStateEnv(ctx, roomID, "created"))
	case -1:
		s.sendError(c, "房间数量已达上限，请稍后再试")
	case -2:
		s.sendError(c, "你已加入的房间过多，请先退出其他房间")
	default:
		s.sendError(c, "创建房间失败，请重试")
	}
}

// gnHandleJoin 加入：口令 + 关系链强校验（好友或同群）+ 黑名单拦截；满员/并发由 Lua 原子校验
func (s *Server) gnHandleJoin(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	if roomID == "" {
		s.sendError(c, "缺少房间号")
		return
	}
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	host := meta["host"]
	// 口令校验（服务端归口，客户端不可自行判定）
	if passHash := meta["pass"]; passHash != "" {
		sum := sha256.Sum256([]byte(strings.TrimSpace(p.Pass)))
		if hex.EncodeToString(sum[:]) != passHash {
			s.sendError(c, "房间口令错误")
			return
		}
	}
	// 关系链强校验：群房间校验群成员资格；私聊房校验与房主的好友关系
	if from != host {
		gid, _ := strconv.Atoi(meta["group_id"])
		if gid > 0 {
			if !isGroupMember(uint(gid), from) {
				s.sendError(c, "你不是该群成员，无法加入")
				return
			}
		} else if !s.isFriend(from, host) {
			s.sendError(c, "仅房主好友可加入该房间")
			return
		}
		if s.isBlocked(from, host) {
			s.sendError(c, "你与房主之间存在拉黑关系，无法加入")
			return
		}
	}

	gnPruneUser(from)
	now := strconv.FormatInt(time.Now().Unix(), 10)
	// 满员上限以房间自定人数为准（M8 建房时落库的 max_players），缺失/越界回落全局上限
	maxMembers := s.cfg.GameNet.MaxMembers
	if mp, _ := strconv.Atoi(meta["max_players"]); mp >= 2 && mp <= s.cfg.GameNet.MaxMembers {
		maxMembers = mp
	}
	res, err := store.RDB.Eval(ctx, gnJoinScript,
		[]string{gnUserKey(from), gnRoomKey(roomID), gnMemberKey(roomID)},
		roomID, from, now, strconv.Itoa(s.cfg.GameNet.MaxPerUser),
		strconv.Itoa(maxMembers), strconv.Itoa(s.cfg.GameNet.RoomTTL)).Int()
	if err != nil {
		logger.Error("游戏房间加入失败（%s → %s）：%v", from, roomID, err)
		s.sendError(c, "加入房间失败，请重试")
		return
	}
	switch res {
	case -1:
		s.sendError(c, "房间不存在或已解散")
		return
	case -2:
		s.sendError(c, "你已加入的房间过多，请先退出其他房间")
		return
	case -3:
		s.sendError(c, "房间人数已满")
		return
	}
	logger.Info("游戏房间 %s 成员加入：%s", roomID, from)
	s.gnBroadcastState(ctx, roomID)
}

// gnHandleLeave 退出：房主退出即关房；全员走空自动回收；否则广播剩余成员
func (s *Server) gnHandleLeave(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	if roomID == "" {
		return
	}
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		return // 房间已解散，静默（客户端态以 closed 为准）
	}
	host := meta["host"]
	store.RDB.HDel(ctx, gnMemberKey(roomID), from)
	store.RDB.SRem(ctx, gnUserKey(from), roomID)
	if from == host {
		s.gnCloseRoom(ctx, roomID, "host_left")
		return
	}
	if remain, _ := store.RDB.HLen(ctx, gnMemberKey(roomID)).Result(); remain <= 0 {
		s.gnCloseRoom(ctx, roomID, "empty")
		return
	}
	s.gnTouch(roomID)
	s.gnBroadcastState(ctx, roomID)
	// 连接层收口（110）：退出者在该房间的隧道会话摘除，双方收 abort(left)
	s.gnNetAbortUser(roomID, from, "left")
	logger.Info("游戏房间 %s 成员退出：%s", roomID, from)
}

// gnHandleKick 踢人：仅房主；向被踢者下发 closed(kicked)，其余成员广播房间态
func (s *Server) gnHandleKick(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	target := strings.TrimSpace(p.Target)
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	if meta["host"] != from {
		s.sendError(c, "仅房主可踢人")
		return
	}
	if target == "" || target == from {
		s.sendError(c, "踢人目标无效")
		return
	}
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), target).Result(); !ok {
		s.sendError(c, "该成员不在房间中")
		return
	}
	store.RDB.HDel(ctx, gnMemberKey(roomID), target)
	store.RDB.SRem(ctx, gnUserKey(target), roomID)
	// 连接层收口（110）：被踢者在该房间的隧道会话一并摘除，双方收 abort(kicked)
	s.gnNetAbortUser(roomID, target, "kicked")
	s.gnSendRoom(target, &gnEnvelope{Action: "closed", RoomID: roomID, Reason: "kicked"})
	s.gnTouch(roomID)
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 成员被踢：%s（房主 %s）", roomID, target, from)
}

// gnHandleReady 就绪切换：成员自身上报，翻转后广播房间态
func (s *Server) gnHandleReady(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	cur, err := store.RDB.HGet(ctx, gnMemberKey(roomID), from).Result()
	if err != nil {
		s.sendError(c, "你不在该房间中")
		return
	}
	next := "1"
	if cur == "1" {
		next = "0"
	}
	store.RDB.HSet(ctx, gnMemberKey(roomID), from, next)
	s.gnTouch(roomID)
	s.gnBroadcastState(ctx, roomID)
}

// gnHandleStart 开局：仅房主；要求除房主外成员全部就绪；房间态置 playing
func (s *Server) gnHandleStart(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	if meta["host"] != from {
		s.sendError(c, "仅房主可开局")
		return
	}
	for u, r := range gnRoomMembers(ctx, roomID) {
		if u != from && r != "1" {
			s.sendError(c, "有成员未就绪，无法开局")
			return
		}
	}
	store.RDB.HSet(ctx, gnRoomKey(roomID), "status", "playing")
	s.gnTouch(roomID)
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 开局（房主 %s）", roomID, from)
}

// gnHandleState 主动拉取房间态（仅成员可查）
func (s *Server) gnHandleState(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), from).Result(); !ok {
		s.sendError(c, "你不在该房间中")
		return
	}
	s.gnSendRoom(from, s.gnStateEnv(ctx, roomID, "state"))
}

// gnHandleChat 房内聊天：仅房间成员可发；服务端归口 from/from_name/ts 后广播给全部成员。
// 与大厅聊天（112）同口径：只走即时广播，不落库、不进历史/未读，房间解散即随会话消失。
func (s *Server) gnHandleChat(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	text := gnTrimRunes(p.Text, 200)
	if roomID == "" || text == "" {
		return
	}
	ctx := context.Background()
	if n, _ := store.RDB.Exists(ctx, gnRoomKey(roomID)).Result(); n == 0 {
		s.sendError(c, "房间不存在或已解散")
		return
	}
	// 成员资格校验：非成员不得向房间广播（防外人插话）
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), from).Result(); !ok {
		s.sendError(c, "你不在该房间中")
		return
	}
	s.gnTouch(roomID)
	members := gnRoomMembers(ctx, roomID)
	names := make([]string, 0, len(members))
	for u := range members {
		names = append(names, u)
	}
	s.gnBroadcast(names, &gnEnvelope{
		Action: "chat", RoomID: roomID,
		From: from, FromName: nicknameOf(from), Text: text, TS: time.Now().Unix(),
	})
}

// gnHandleList 房间列表：仅返回对请求者可见的房间（房主为其好友，或其所在群的群房间）
func (s *Server) gnHandleList(c *Client, p *gnRoomSignal) {
	from := c.username
	ctx := context.Background()
	ids, err := store.RDB.SMembers(ctx, gnKeyRoomsIndex).Result()
	if err != nil {
		s.sendError(c, "房间列表获取失败")
		return
	}
	rooms := make([]gnRoomBrief, 0, len(ids))
	for _, id := range ids {
		meta, err := store.RDB.HGetAll(ctx, gnRoomKey(id)).Result()
		if err != nil || len(meta) == 0 {
			continue
		}
		host := meta["host"]
		gid, _ := strconv.Atoi(meta["group_id"])
		if !s.isFriend(from, host) && !(gid > 0 && isGroupMember(uint(gid), from)) {
			continue
		}
		cnt, _ := store.RDB.HLen(ctx, gnMemberKey(id)).Result()
		gidGame, _ := strconv.Atoi(meta["game_id"])
		maxp, _ := strconv.Atoi(meta["max_players"])
		rooms = append(rooms, gnRoomBrief{
			RoomID:     id,
			Name:       meta["name"],
			Host:       host,
			HostName:   nicknameOf(host),
			GroupID:    uint(gid),
			Count:      int(cnt),
			Status:     meta["status"],
			GameID:     gidGame,
			GameName:   meta["game_name"],
			GameMode:   meta["game_mode"],
			MaxPlayers: maxp,
		})
	}
	s.gnSendRoom(from, &gnEnvelope{Action: "list", Rooms: rooms})
}

// ----- 110 连接层：P2P 打洞优先 + TURN 中继兜底（房主 ↔ 加入者点对点，一期星型拓扑）-----
// 与 filep2p.go 同水位同骨架（整体照搬其状态机与懒清理口径）：
//
//	probe     加入者探测房主：服务端校验「目标必须是该房间房主 + 发起者是房间成员 + 双方端在线」，
//	          再转发房主全部在线端（多端在线全部自动 accept）
//	accept    房主端应答：会话表先到先得锁定唯一赢家，后到端收服务端 abort(already_accepted)
//	offer/answer/candidate/relay  校验会话参与者后按用户名定向中继（原样透传，不解析媒体字段）
//	ping      联机期保活：刷新会话活跃 + 复用 gnTouch 续期房间 TTL，并转发对端喂其看门狗
//	abort     任一方中止；房间关闭 / 成员退出 / 成员被踢由服务端主动下发（防孤儿隧道）
//
// 懒清理（同 fileP2PProbeTimeout/fileP2PDoneTimeout 口径，不启用定时器风暴）：
//
//	probe 后 15s 未 accept / 协商后 30s 无 ping 刷新，任一新信令触发清扫并向双方发服务端 abort
//
// host_port 归口：以房间态（109 建房时落 Redis 的 host_port）为准，不信客户端自报。

// 连接层会话状态
const (
	gnNetStateProbing int8 = 0 // 已 probe，等待房主 accept（先到先得）
	gnNetStateLinked  int8 = 1 // 赢家已锁定，SDP/ICE 协商与联机中
)

// 懒清理超时阈值
const (
	gnNetProbeTimeout = 15 * time.Second // probe 后未进入协商（无 accept）的兜底
	gnNetIdleTimeout  = 30 * time.Second // 进入协商后无任何信令（ping 刷新）的兜底
)

// gnNetSession 连接层会话（内存态，重启即清空——客户端收不到 offer/answer 自动收口重试，
// 不丢功能，同 callSessions/fileP2PSessions 取舍；房间态才是跨实例共享的 Redis 态）
type gnNetSession struct {
	ConnID       string    // 连接唯一标识（加入者生成）
	RoomID       string    // 所属房间（ping 续期与房间关闭清理用）
	From         string    // 加入者（隧道发起方）
	To           string    // 房主（隧道目标，提供游戏端口）
	HostPort     int       // 房主游戏端口（服务端以房间态归口）
	Mode         string    // 接入形态（一期 tunnel）
	State        int8      // gnNetStateProbing / gnNetStateLinked
	Accepted     bool      // accept 竞态归口：是否已有赢家端
	AcceptAt     time.Time // 赢家锁定时间
	CreateAt     time.Time // probe 建会话时间（15s 协商兜底的起算锚点）
	LastActive   time.Time // 最近信令活跃时间（联机期 ping 刷新，防懒清扫按固定锚点误杀长联机）
	PeerPlatform string    // accept 携带的被选端平台（pc），供发起方 UI 提示
}

var (
	gnNetMu       sync.RWMutex
	gnNetSessions = map[string]*gnNetSession{} // conn_id -> 会话
)

// gnNetSignalPayload 110 信令 content 公共字段（轻解析归口：仅取 action/conn_id/room_id/platform，
// sdp/candidate 等媒体字段原样中继不解析，同通话/文件直传信令轻解析原则）
type gnNetSignalPayload struct {
	Action   string `json:"action"`
	ConnID   string `json:"conn_id"`
	RoomID   string `json:"room_id"`
	Platform string `json:"platform"`
}

// gnNetSessionOf 查会话（不校验参与者，同 fileP2PSessionOf 模式）
func gnNetSessionOf(connID string) *gnNetSession {
	gnNetMu.RLock()
	defer gnNetMu.RUnlock()
	return gnNetSessions[connID]
}

// gnNetForward 信令转发：原 content 中继 + from_user 强制为发送者登录名（防伪造，同 fileP2PForward）
func (s *Server) gnNetForward(from, toUser, content string) {
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeGameNetSignal,
		FromUser:  from,
		ToUser:    toUser,
		Content:   content,
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// gnNetSystem 以服务端归口身份构造系统帧下发（probe_fail/abort，同 fileP2PSystem 模式）
func (s *Server) gnNetSystem(toUser string, payload map[string]interface{}) {
	content, _ := json.Marshal(payload)
	frame := protocol.Message{
		MsgType:   protocol.MsgTypeGameNetSignal,
		FromUser:  "", // 服务端归口帧不携带发起人
		ToUser:    toUser,
		Content:   string(content),
		Timestamp: time.Now().Unix(),
	}
	data, _ := json.Marshal(frame)
	s.sendToUser(toUser, data)
}

// gnNetCountByUser 统计该用户当前并发连接会话数（含协商中与联机中，DoS 边界归口）
func gnNetCountByUser(username string) int {
	n := 0
	gnNetMu.RLock()
	for _, sess := range gnNetSessions {
		if sess.From == username || sess.To == username {
			n++
		}
	}
	gnNetMu.RUnlock()
	return n
}

// gnNetSweep 懒清理过期会话（同 fileP2PSweep 模式：任一新信令触发清扫，不启用定时器风暴；
// 无人触发时由客户端看门狗独立兜底）：
//   - probe 后 15s 未 accept / 协商后 30s 无 ping 刷新 → 删会话并回双方 abort(timeout)
//   - 房间键已过期（房间被关闭/回收）→ 一并收口，回双方 abort(room_closed)，防孤儿隧道
func (s *Server) gnNetSweep() {
	now := time.Now()
	ctx := context.Background()
	type expiredNet struct {
		sess   *gnNetSession
		reason string
	}
	var expired []expiredNet
	gnNetMu.Lock()
	for id, sess := range gnNetSessions {
		anchor := sess.CreateAt
		limit := gnNetProbeTimeout
		if sess.State == gnNetStateLinked {
			// 协商后以最近信令活跃时间兜底（客户端联机期定时 ping 刷新）；
			// LastActive 为零值（异常数据）回退 AcceptAt
			anchor = sess.LastActive
			if anchor.IsZero() {
				anchor = sess.AcceptAt
			}
			limit = gnNetIdleTimeout
		}
		if now.Sub(anchor) > limit {
			delete(gnNetSessions, id)
			expired = append(expired, expiredNet{sess: sess, reason: "timeout"})
			continue
		}
		if n, _ := store.RDB.Exists(ctx, gnRoomKey(sess.RoomID)).Result(); n == 0 {
			delete(gnNetSessions, id)
			expired = append(expired, expiredNet{sess: sess, reason: "room_closed"})
		}
	}
	gnNetMu.Unlock()
	for _, e := range expired {
		sess := e.sess
		logger.Warn("游戏连接会话清理：%s → %s（conn_id=%s，房间 %s，原因 %s）",
			sess.From, sess.To, sess.ConnID, sess.RoomID, e.reason)
		s.gnNetSystem(sess.From, map[string]interface{}{"action": "abort", "conn_id": sess.ConnID, "reason": e.reason})
		s.gnNetSystem(sess.To, map[string]interface{}{"action": "abort", "conn_id": sess.ConnID, "reason": e.reason})
	}
}

// gnNetProbe 加入者探测房主（决策归口：不满足即回 probe_fail(原因)，发起方立即收口不白等超时）
func (s *Server) gnNetProbe(c *Client, msg *protocol.Message, from string, p *gnNetSignalPayload) {
	// 懒清理入口：新探测触发一次过期会话清扫
	s.gnNetSweep()

	to := msg.ToUser
	if to == "" || to == from {
		s.sendError(c, "游戏连接对象无效")
		return
	}
	// 一期形态二（端口隧道）由 Electron 主进程承载 UDP/TCP 监听 → 发起端必须 PC 端；
	// 非 PC 端（web/app）明确回绝，不让其白等 15s 协商超时（且不影响其既有功能）
	if c.platform != "pc" {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "unsupported"})
		return
	}
	roomID := strings.TrimSpace(p.RoomID)
	if roomID == "" {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "room_closed"})
		return
	}
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "room_closed"})
		return
	}
	// 一期星型拓扑：加入者只与房主建隧道（房主端即游戏进程所在端）
	if meta["host"] != to {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "forbidden"})
		return
	}
	// 成员资格归口：仅房间成员可发起（防非成员借房间号蹭隧道）
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), from).Result(); !ok {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "forbidden"})
		return
	}
	// 房主可服务端判定：本实例 PC 端在线即通过；本实例有该用户连接但无 PC 端 → 明确回绝（unsupported）；
	// 本实例无该用户连接（集群部署下房主可能在别的实例）→ 退化为全局在线判定，平台能力由
	// 房主端自行判定（非 PC 端不会 accept，15s 后由 gnNetSweep 回 probe 侧 timeout 收口）
	if !s.hub.HasPC(to) {
		if len(s.hub.GetAll(to)) > 0 {
			s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "unsupported"})
			return
		}
		if !s.isOnlineFast(to) {
			s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "offline"})
			return
		}
	}
	// 并发水位归口（DoS 边界）：单用户连接会话上限 = 房间并发数上限 × 单房间成员上限
	if gnNetCountByUser(from) >= s.cfg.GameNet.MaxPerUser*s.cfg.GameNet.MaxMembers {
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "busy"})
		return
	}

	hostPort, _ := strconv.Atoi(meta["host_port"])
	sess := &gnNetSession{
		ConnID:   p.ConnID,
		RoomID:   roomID,
		From:     from,
		To:       to,
		HostPort: hostPort,
		Mode:     meta["mode"],
		State:    gnNetStateProbing,
		CreateAt: time.Now(),
	}
	gnNetMu.Lock()
	if _, exists := gnNetSessions[sess.ConnID]; exists {
		// conn_id 冲突（重发/碰撞）：拒绝重复建会话
		gnNetMu.Unlock()
		s.gnNetSystem(from, map[string]interface{}{"action": "probe_fail", "conn_id": p.ConnID, "reason": "busy"})
		return
	}
	gnNetSessions[sess.ConnID] = sess
	gnNetMu.Unlock()

	logger.Info("游戏连接探测：%s → %s（房间 %s，host_port=%d，conn_id=%s）", from, to, roomID, hostPort, sess.ConnID)
	// 转发房主全部在线端（多端在线全部自动 accept）；TURN 启用时服务端注入 iceServers（复用 callInjectICE）
	s.gnNetForward(from, to, callInjectICE(msg.Content))
}

// gnNetAccept 房主端应答（多端在线全部自动 accept，服务端会话表先到先得锁定唯一赢家）
func (s *Server) gnNetAccept(from, content string, p *gnNetSignalPayload) {
	sess := gnNetSessionOf(p.ConnID)
	if sess == nil {
		// 会话已结束（超时竞态）：回服务端 abort 让该端立即收口，不等看门狗
		s.gnNetSystem(from, map[string]interface{}{"action": "abort", "conn_id": p.ConnID, "reason": "timeout"})
		return
	}
	gnNetMu.Lock()
	// 防竞态：锁内校验会话仍有效（与懒清扫并发时防操作孤儿会话，同 fileP2PAccept 惯用法）
	if cur, ok := gnNetSessions[sess.ConnID]; !ok || cur != sess {
		gnNetMu.Unlock()
		return
	}
	// 参与者归口：仅房主端可 accept，加入者/无关人员帧静默丢弃
	if sess.To != from {
		gnNetMu.Unlock()
		return
	}
	if sess.Accepted {
		// 竞态归口：赢家已锁定，后到端收服务端 abort(already_accepted) 自行收口
		gnNetMu.Unlock()
		s.gnNetSystem(from, map[string]interface{}{"action": "abort", "conn_id": p.ConnID, "reason": "already_accepted"})
		return
	}
	sess.Accepted = true
	sess.State = gnNetStateLinked
	sess.AcceptAt = time.Now()
	sess.LastActive = sess.AcceptAt
	sess.PeerPlatform = p.Platform
	gnNetMu.Unlock()

	logger.Info("游戏连接应答：%s 接受 %s 的隧道（端=%s，房间=%s，conn_id=%s）",
		from, sess.From, p.Platform, sess.RoomID, sess.ConnID)
	// accept 转发加入者（from 强制房主；TURN 启用时服务端注入 iceServers）
	s.gnNetForward(from, sess.From, callInjectICE(content))
}

// gnNetRelay 协商中继（offer/answer/candidate/relay）：校验会话存在与参与者身份后向对端转发，
// TURN 启用时服务端注入 iceServers（复用 callInjectICE，原样中继媒体字段不解析）
func (s *Server) gnNetRelay(from, content string, p *gnNetSignalPayload) {
	sess := gnNetSessionOf(p.ConnID)
	if sess == nil {
		return // 会话已结束：静默丢弃（客户端看门狗兜底）
	}
	gnNetMu.Lock()
	peer := ""
	if cur, ok := gnNetSessions[sess.ConnID]; ok && cur == sess {
		if sess.From == from {
			peer = sess.To
		} else if sess.To == from {
			peer = sess.From
		}
		if peer != "" {
			// 协商/联机期信令刷新会话活跃（防长联机被懒清扫按固定锚点误杀）
			sess.LastActive = time.Now()
		}
	}
	gnNetMu.Unlock()
	if peer == "" {
		return
	}
	s.gnNetForward(from, peer, callInjectICE(content))
}

// gnNetPing 联机期保活帧：刷新会话活跃 + 续期房间 TTL（联机期间房间活跃由 110 共同维持），
// 并原样转发对端喂其看门狗；帧不落库不产生业务副作用
func (s *Server) gnNetPing(from string, p *gnNetSignalPayload) {
	sess := gnNetSessionOf(p.ConnID)
	if sess == nil {
		return
	}
	gnNetMu.Lock()
	peer := ""
	if cur, ok := gnNetSessions[sess.ConnID]; ok && cur == sess {
		if sess.From == from {
			peer = sess.To
		} else if sess.To == from {
			peer = sess.From
		}
		if peer != "" {
			sess.LastActive = time.Now()
		}
	}
	gnNetMu.Unlock()
	if peer == "" {
		return
	}
	s.gnTouch(sess.RoomID) // 房间活跃续期（room_ttl 惰性续期 + updated_at）
	s.gnNetForward(from, peer, `{"action":"ping","conn_id":"`+sess.ConnID+`"}`)
}

// gnNetAbort 任一方中止（协商失败/中途取消），原 content 转发对方并清理会话；
// 客户端按 reason 决定是否重试或回退（服务端只归口转发与会话清理）
func (s *Server) gnNetAbort(from, content string, p *gnNetSignalPayload) {
	sess := gnNetSessionOf(p.ConnID)
	if sess == nil {
		return
	}
	gnNetMu.Lock()
	// 防竞态：锁内校验会话仍有效（与懒清扫并发时防误删同名新会话）
	if cur, ok := gnNetSessions[sess.ConnID]; !ok || cur != sess {
		gnNetMu.Unlock()
		return
	}
	peer := ""
	if sess.From == from {
		peer = sess.To
	} else if sess.To == from {
		peer = sess.From
	}
	if peer == "" {
		gnNetMu.Unlock()
		return
	}
	delete(gnNetSessions, sess.ConnID)
	gnNetMu.Unlock()
	logger.Info("游戏连接中止：%s（conn_id=%s）", from, sess.ConnID)
	s.gnNetForward(from, peer, content)
}

// gnNetAbortUser 服务端主动收口该用户在指定房间的全部连接会话（成员退出/被踢），
// 双方均收 abort(reason)，房间内其余成员不受影响
func (s *Server) gnNetAbortUser(roomID, user, reason string) {
	s.gnNetAbortFiltered(func(sess *gnNetSession) bool {
		return sess.RoomID == roomID && (sess.From == user || sess.To == user)
	}, reason)
}

// gnNetAbortRoom 服务端主动收口整个房间的连接会话（房主退出/房间回收/房间关闭）
func (s *Server) gnNetAbortRoom(roomID, reason string) {
	s.gnNetAbortFiltered(func(sess *gnNetSession) bool { return sess.RoomID == roomID }, reason)
}

// gnNetAbortFiltered 按条件摘除会话并向双方下发服务端 abort（统一收口，防孤儿隧道）
func (s *Server) gnNetAbortFiltered(match func(*gnNetSession) bool, reason string) {
	gnNetMu.Lock()
	var hit []*gnNetSession
	for id, sess := range gnNetSessions {
		if match(sess) {
			delete(gnNetSessions, id)
			hit = append(hit, sess)
		}
	}
	gnNetMu.Unlock()
	for _, sess := range hit {
		s.gnNetSystem(sess.From, map[string]interface{}{"action": "abort", "conn_id": sess.ConnID, "reason": reason})
		s.gnNetSystem(sess.To, map[string]interface{}{"action": "abort", "conn_id": sess.ConnID, "reason": reason})
	}
}
