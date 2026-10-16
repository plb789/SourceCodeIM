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
	"im-server/model"
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
	// 功能二期：开局实测端口（房主启动游戏后探测的监听端口）——服务端累加进游戏登记集
	// （追加去重，不覆盖管理端手工登记），下次建房选游戏预填直接可用
	OnlinePortsTCP []int `json:"online_ports_tcp,omitempty"`
	OnlinePortsUDP []int `json:"online_ports_udp,omitempty"`
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
	Avatar   string `json:"avatar,omitempty"` // 功能二期：头像 URL 服务端归口下发（游戏中心窗无主窗好友缓存，IMAvatarUrl 不可用）
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
	// 功能二期：房主转让（仅当前房主可发起，目标须为房内在线成员）
	case "transfer":
		s.gnHandleTransfer(c, &p)
	case "ready":
		s.gnHandleReady(c, &p)
	case "start":
		s.gnHandleStart(c, &p)
	// 功能二期：结束对局（仅房主；playing → waiting，成员保留重新准备，按钮回「开始游戏」可再开局）
	case "end":
		s.gnHandleEnd(c, &p)
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

// gnLobbyDisconnect 断连即离场：客户端进程直接退出不会发 112 leave，在场 ZSET 条目要等
// 45s 惰性过期，且过期后没有任何触发点广播 users——其他玩家的大厅「N 人在线」与在场名单
// 长期停留在旧值（实测：对方退出进程后仍显示 2 人在线）。unregister 最后连接断开路径调用：
// 仍在场即移除并广播最新名单；同端互踢/多端场景由 unregister 的 remaining>0 早退挡住不误清。
func (s *Server) gnLobbyDisconnect(username string) {
	ctx := context.Background()
	n, _ := store.RDB.ZRem(ctx, gnKeyLobby, username).Result()
	if n == 0 {
		return // 不在大厅（未打开联机大厅/页面切换时已显式离场）：零开销旁路
	}
	users := gnLobbyUsers(ctx, time.Now().Unix())
	s.gnBroadcastLobby(users, &gnEnvelope{Action: "users", Users: gnLobbyViews(users)})
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
			Avatar:   avatarOf(u),
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

// ----- 功能二期：房间列表变更实时通知（建房/加入/退出/踢人/开局/转让/关房 → 大厅即时可见） -----
// 原实现：房间列表纯手动拉取（109 list），他人建房/解散后须手动点刷新才可见。
// 现口径：房间表变更 → 向 112 大厅在场用户广播轻量 rooms_changed 事件（不含列表内容——
// 列表按"好友或同群"因人而异，推送统一内容会泄露无关系房间；客户端收到即自动拉取），
// 客户端复用既有 list 拉取链路（自带 1.2s 节流）。服务端 1s 尾沿节流：窗口内多次变更合并，
// 窗口结束补推一次（最后一次变更不丢）；大厅无人时零开销旁路。
const gnRoomsNotifyGap = time.Second

var (
	gnRoomsNotifyMu      sync.Mutex
	gnRoomsNotifyAt      time.Time
	gnRoomsNotifyPending bool
)

// gnRoomsChanged 房间表变更入口（各变更点调用；幂等无害）
func (s *Server) gnRoomsChanged() {
	users := gnLobbyUsers(context.Background(), time.Now().Unix())
	if len(users) == 0 {
		return
	}
	gnRoomsNotifyMu.Lock()
	now := time.Now()
	if !gnRoomsNotifyAt.IsZero() && now.Sub(gnRoomsNotifyAt) < gnRoomsNotifyGap {
		gnRoomsNotifyPending = true
		gnRoomsNotifyMu.Unlock()
		return
	}
	gnRoomsNotifyAt = now
	gnRoomsNotifyMu.Unlock()
	s.gnRoomsChangedPush()
	// 尾沿补推：窗口结束后若仍有变更（窗口内被合并的最后一次），再推一轮
	time.AfterFunc(gnRoomsNotifyGap, s.gnRoomsChangedTail)
}

// gnRoomsChangedTail 尾沿补推处理器（实测修复：原实现闭包只跑一轮且不续挂——「立即推送→尾沿补推→
// 窗口内又来新变更」序列中，新变更标 pending 后永远等不到下一轮补推，关房通知真实丢失）。
// 尾沿推送后必须链式续挂，直到某个窗口内无新变更链才终止（AfterFunc 时间差递归，无栈深风险）。
func (s *Server) gnRoomsChangedTail() {
	gnRoomsNotifyMu.Lock()
	if !gnRoomsNotifyPending {
		gnRoomsNotifyMu.Unlock()
		return
	}
	gnRoomsNotifyPending = false
	gnRoomsNotifyAt = time.Now()
	gnRoomsNotifyMu.Unlock()
	s.gnRoomsChangedPush()
	time.AfterFunc(gnRoomsNotifyGap, s.gnRoomsChangedTail)
}

func (s *Server) gnRoomsChangedPush() {
	users := gnLobbyUsers(context.Background(), time.Now().Unix())
	if len(users) == 0 {
		return
	}
	s.gnBroadcastLobby(users, &gnEnvelope{Action: "rooms_changed"})
}

// ----- 功能二期：离线成员自动清退（客户端退出进程/断网不会显式 leave，防成员表残留） -----
// 原实现：成员仅显式 leave/被踢才移出，直接退出客户端后残留为离线成员——既造成成员表失真，
// 又卡死房主开局（其 ready 恒未就绪），只能等 room_ttl（2h）回收。
// 现口径：最后一个连接断开（unregister）时挂 30s 宽限定时器——闪断/APP 息屏交接（1~3s 重连）
// 宽限内回来即取消（handleLogin 取消），真退出/长断网到期自动移出全部房间（房主离线=关房，
// 语义同"房主退出即关房"）。同端互踢路径不走此处（旧连接 unregister 时新连接已在集合，
// remaining>0 提前返回，见 hub.Add 互踢语义）。
const gnOfflineLeaveGrace = 30 * time.Second

var (
	gnOfflineLeaveMu     sync.Mutex
	gnOfflineLeaveTimers = make(map[string]*time.Timer)
)

// gnScheduleOfflineLeave 调度离线清退（unregister 最后连接断开路径调用；同用户重复断开续窗）
func (s *Server) gnScheduleOfflineLeave(username string) {
	gnOfflineLeaveMu.Lock()
	if t := gnOfflineLeaveTimers[username]; t != nil {
		t.Reset(gnOfflineLeaveGrace)
	} else {
		gnOfflineLeaveTimers[username] = time.AfterFunc(gnOfflineLeaveGrace, func() {
			gnOfflineLeaveMu.Lock()
			delete(gnOfflineLeaveTimers, username)
			gnOfflineLeaveMu.Unlock()
			// 宽限内重连由 gnCancelOfflineLeave 删定时器，此处防御性双查（Redis 在线缓存为准）
			if s.isOnlineFast(username) {
				return
			}
			s.gnOfflineLeaveSweep(username)
		})
	}
	gnOfflineLeaveMu.Unlock()
}

// gnCancelOfflineLeave 宽限内重连即取消清退（handleLogin 登录成功路径调用）
func gnCancelOfflineLeave(username string) {
	gnOfflineLeaveMu.Lock()
	if t := gnOfflineLeaveTimers[username]; t != nil {
		t.Stop()
		delete(gnOfflineLeaveTimers, username)
	}
	gnOfflineLeaveMu.Unlock()
}

// gnOfflineLeaveSweep 到期清扫：移出该用户在所有房间的成员身份
func (s *Server) gnOfflineLeaveSweep(username string) {
	ctx := context.Background()
	ids, _ := store.RDB.SMembers(ctx, gnUserKey(username)).Result()
	for _, roomID := range ids {
		meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
		if len(meta) == 0 {
			store.RDB.SRem(ctx, gnUserKey(username), roomID) // 惰性清理悬空索引
			continue
		}
		reason := "offline"
		if meta["host"] == username {
			reason = "host_offline" // 房主离线：关房，语义同"房主退出即关房"
		}
		s.gnRemoveMember(ctx, roomID, username, reason)
	}
	if len(ids) > 0 {
		logger.Info("用户 %s 离线超时，已自动移出 %d 个游戏房间", username, len(ids))
	}
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

// gnBroadcastMemberRooms 登录/重连沿房间态全量广播：成员 Online 字段是广播时刻实时快照
// （isOnlineFast），但断网沿（30s 宽限，设计无感）与重连沿都没有成员变更事件——其他成员的
// 成员列表在线标记无限期停留旧值（断网者「假在线」误拦房主开局判定 canStart；宽限内回来者
// 他人列表不恢复）。仅在重连沿广播一次修正；断网沿维持宽限无感口径（30s 到期清退沿另有广播）。
func (s *Server) gnBroadcastMemberRooms(username string) {
	ctx := context.Background()
	ids, _ := store.RDB.SMembers(ctx, gnUserKey(username)).Result()
	for _, roomID := range ids {
		if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), username).Result(); !ok {
			store.RDB.SRem(ctx, gnUserKey(username), roomID) // 悬空索引惰性清理
			continue
		}
		s.gnBroadcastState(ctx, roomID)
	}
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
	s.gnRoomsChanged() // 功能二期：房间从列表消失，通知大厅即时刷新
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
		s.gnRoomsChanged() // 功能二期：新房间进入列表，通知大厅即时刷新
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
	s.gnRoomsChanged() // 功能二期：列表人数变化，通知大厅即时刷新
	s.gnBroadcastState(ctx, roomID)
}

// gnRemoveMember 房间成员移出归口（显式 leave 与离线清退共用，单一口径防两处漂移）：
// 房主移出=关房（host_<reason>）；剩余为空=关房（empty）；否则广播剩余成员 +
// 收口该用户 110 隧道会话（对端收 abort(reason)）+ 通知大厅列表刷新。返回房间是否仍存在。
func (s *Server) gnRemoveMember(ctx context.Context, roomID, username, reason string) bool {
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		return false // 房间已解散，静默（客户端态以 closed 为准）
	}
	// 成员资格预检：非成员（重复 leave/悬空索引/清退竞态残留请求）仅惰性清理索引后静默返回——
	// 原实现无条件继续走广播+日志，非成员 leave 会产出虚假「成员退出」记录与冗余 state/rooms_changed。
	// 房主分支不受预检影响（房主退出/离线即关房语义优先，成员哈希缺失时仍按关房收口）。
	isMember, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), username).Result()
	store.RDB.HDel(ctx, gnMemberKey(roomID), username)
	store.RDB.SRem(ctx, gnUserKey(username), roomID)
	if username == meta["host"] {
		s.gnCloseRoom(ctx, roomID, "host_"+reason)
		return false
	}
	if !isMember {
		return false
	}
	if remain, _ := store.RDB.HLen(ctx, gnMemberKey(roomID)).Result(); remain <= 0 {
		s.gnCloseRoom(ctx, roomID, "empty")
		return false
	}
	s.gnTouch(roomID)
	s.gnBroadcastState(ctx, roomID)
	// 连接层收口（110）：移出者在该房间的隧道会话摘除，双方收 abort(<reason>)
	s.gnNetAbortUser(roomID, username, reason)
	logger.Info("游戏房间 %s 成员退出：%s（%s）", roomID, username, reason)
	s.gnRoomsChanged()
	return true
}

// gnHandleLeave 退出：房主退出即关房；全员走空自动回收；否则广播剩余成员
func (s *Server) gnHandleLeave(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	if roomID == "" {
		return
	}
	s.gnRemoveMember(context.Background(), roomID, from, "left")
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
	s.gnRoomsChanged() // 功能二期：列表人数变化，通知大厅即时刷新
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 成员被踢：%s（房主 %s）", roomID, target, from)
}

// gnHandleTransfer 房主转让（功能二期）：仅当前房主可发起；目标须为房内成员、在线且为 PC 端
// （端口隧道由 PC 端 Electron 主进程承载，WEB/APP 端无法提供游戏端口，故拒绝对其转让）。
// 转让后房间态 host 字段切换，随 state 全量广播同步给全部成员；同时摘除房间内全部既有隧道
// （双方 abort(host_transfer)），由客户端据新 host 重新建链，避免指向旧房主的半死隧道残留。
func (s *Server) gnHandleTransfer(c *Client, p *gnRoomSignal) {
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
		s.sendError(c, "仅房主可移交房主")
		return
	}
	if target == "" || target == from {
		s.sendError(c, "移交目标无效")
		return
	}
	if ok, _ := store.RDB.HExists(ctx, gnMemberKey(roomID), target).Result(); !ok {
		s.sendError(c, "该成员不在房间中")
		return
	}
	if !s.isOnlineFast(target) {
		s.sendError(c, "该成员当前不在线，无法移交房主")
		return
	}
	// 目标端能力归口：端口隧道需 PC 端承载（同 gnNetProbe 口径；跨实例未知端放行，由其自身判定）
	if !s.hub.HasPC(target) && len(s.hub.GetAll(target)) > 0 {
		s.sendError(c, "该成员所在端不支持作为房主（需 PC 客户端）")
		return
	}
	// 转让归口：房主字段切换 + 活跃续期；新 host 的 ready 标记清零（房主不参与准备，同建房口径）
	ttl := time.Duration(s.cfg.GameNet.RoomTTL) * time.Second
	pipe := store.RDB.Pipeline()
	pipe.HSet(ctx, gnRoomKey(roomID), "host", target, "updated_at", strconv.FormatInt(time.Now().Unix(), 10))
	pipe.HSet(ctx, gnMemberKey(roomID), target, "0")
	pipe.Expire(ctx, gnRoomKey(roomID), ttl)
	pipe.Expire(ctx, gnMemberKey(roomID), ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		logger.Error("游戏房间 %s 房主转让写库失败：%v", roomID, err)
		s.sendError(c, "移交房主失败，请重试")
		return
	}
	// 连接层收口（110）：房主变更后既有隧道（原 host 为端点）全部失效，摘除并双方 abort(host_transfer)
	s.gnNetAbortRoom(roomID, "host_transfer")
	s.gnRoomsChanged() // 功能二期：列表建主名变化，通知大厅即时刷新
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 房主转让：%s → %s", roomID, from, target)
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
		if u == from || r == "1" {
			continue
		}
		// 功能二期：离线成员不阻塞开局——其 ready 恒未就绪但已无法操作（断线宽限内，30s 后自动移出）；
		// 若不放行，客户端退出进程即永久卡死房主开局
		if !s.isOnlineFast(u) {
			continue
		}
		s.sendError(c, "有成员未就绪，无法开局")
		return
	}
	// 功能二期：开局实测端口回填——房主端「开始游戏」联动启动真实游戏并自动探测监听端口，
	// 探测结果与建房预填不同时经 start 信令携带（host_port 合法范围才生效，0=沿用原端口），
	// 加入方随 state 更新 host_port 后 connect 自动对准真实端口
	if p.HostPort >= 1024 && p.HostPort <= 65535 {
		store.RDB.HSet(ctx, gnRoomKey(roomID), "host_port", strconv.Itoa(p.HostPort))
	}
	// 功能二期：实测发现的新端口自动累加进游戏登记集（追加去重，管理端手工登记为准不覆盖），
	// 同端口不重复登记（天然只记一次）；下次建房选该游戏即预填完整端口集。
	// 游戏归属以房间 meta.game_id 为准（start 信令无需重复携带）
	if len(p.OnlinePortsTCP) > 0 || len(p.OnlinePortsUDP) > 0 {
		if gid, _ := strconv.Atoi(meta["game_id"]); gid > 0 {
			s.gnMergeOnlinePorts(gid, p.OnlinePortsTCP, p.OnlinePortsUDP)
		}
	}
	store.RDB.HSet(ctx, gnRoomKey(roomID), "status", "playing")
	s.gnTouch(roomID)
	s.gnRoomsChanged() // 功能二期：列表状态变化（等待→进行中），通知大厅即时刷新
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 开局（房主 %s）", roomID, from)
}

// gnHandleEnd 结束对局（功能二期）：仅房主；playing → waiting（幂等：非 playing 静默）。
// 成员 ready 清零（新对局重新准备）、对局隧道收口（对局结束连接即失效）——
// 房间与成员保留，房主可再次开局（按钮回「开始游戏」），加入方无需重新加入
func (s *Server) gnHandleEnd(c *Client, p *gnRoomSignal) {
	from := c.username
	roomID := strings.TrimSpace(p.RoomID)
	ctx := context.Background()
	meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
	if len(meta) == 0 {
		return
	}
	if meta["host"] != from {
		s.sendError(c, "仅房主可结束对局")
		return
	}
	if meta["status"] != "playing" {
		return
	}
	members := gnRoomMembers(ctx, roomID)
	for u := range members {
		if u != from {
			store.RDB.HSet(ctx, gnMemberKey(roomID), u, "0")
		}
	}
	store.RDB.HSet(ctx, gnRoomKey(roomID), "status", "waiting")
	s.gnTouch(roomID)
	s.gnNetAbortRoom(roomID, "game_end")
	s.gnRoomsChanged() // 列表状态回「等待中」
	s.gnBroadcastState(ctx, roomID)
	logger.Info("游戏房间 %s 结束对局（房主 %s）", roomID, from)
}

// gnStartupSweep 启动补偿扫描（功能二期）：离线清退定时器为进程内存态，服务端重启即丢失——
// 重启前未到期的清退随之失效，孤儿房间（成员已全部断线）会挂到 room_ttl（2h）才回收。
// 启动后延迟扫描全部活跃房间：全离线=关房；房主离线=关房；部分离线=逐个移出。
// 重启场景全体连接必然已断（unregister 已删 Redis 在线缓存），30s 宽限无意义，直接清；
// 启动后已重连上线的用户（isOnlineFast=true）保留其房间（断线重连恢复语义不受影响）
func (s *Server) gnStartupSweep() {
	if !s.cfg.GameNet.Enabled {
		return
	}
	ctx := context.Background()
	ids, _ := store.RDB.SMembers(ctx, gnKeyRoomsIndex).Result()
	for _, roomID := range ids {
		meta, _ := store.RDB.HGetAll(ctx, gnRoomKey(roomID)).Result()
		if len(meta) == 0 {
			store.RDB.SRem(ctx, gnKeyRoomsIndex, roomID) // 惰性清理悬空索引
			continue
		}
		members := gnRoomMembers(ctx, roomID)
		var offline []string
		allOffline := true
		for u := range members {
			if s.isOnlineFast(u) {
				allOffline = false
				continue
			}
			offline = append(offline, u)
		}
		if len(offline) == 0 {
			continue // 全员在线：正常房间保留
		}
		if allOffline || isHostOffline(meta, offline) {
			s.gnCloseRoom(ctx, roomID, "startup_sweep")
			continue
		}
		for _, u := range offline {
			s.gnRemoveMember(ctx, roomID, u, "offline")
		}
	}
	if len(ids) > 0 {
		logger.Info("游戏房间启动补偿扫描完成：扫描 %d 个活跃房间（清理离线成员/孤儿房间）", len(ids))
	}
}

// isHostOffline 房主是否在离线名单中（启动补偿用）
func isHostOffline(meta map[string]string, offline []string) bool {
	host := meta["host"]
	for _, u := range offline {
		if u == host {
			return true
		}
	}
	return false
}

// gnMergeOnlinePorts 开局实测端口累加进游戏登记集（功能二期）：读 im_game.online_ports_tcp/udp
// 现值 → 与实测端口并集去重 → 仅在有新增时写回（追加不覆盖，管理端手工登记为准）；
// 游戏不存在（已下架）静默跳过。写库失败仅记日志（不影响本局联机，端口已在房间 meta 生效）。
// 全局互斥：读-改-写非原子，两个房间同游戏并发开局累加时无锁会互相覆盖丢端口（稳定性实测项）
var gnMergeOnlinePortsMu sync.Mutex

func (s *Server) gnMergeOnlinePorts(gameID int, tcpPorts, udpPorts []int) {
	gnMergeOnlinePortsMu.Lock()
	defer gnMergeOnlinePortsMu.Unlock()
	var g model.Game
	if err := store.DB.First(&g, gameID).Error; err != nil {
		return
	}
	merge := func(cur string, add []int) (string, bool) {
		seen := map[int]bool{}
		var out []string
		for _, seg := range strings.Split(cur, ",") {
			p, err := strconv.Atoi(strings.TrimSpace(seg))
			if err != nil || p < 1024 || p > 65535 || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, strconv.Itoa(p))
		}
		changed := false
		for _, p := range add {
			if p < 1024 || p > 65535 || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, strconv.Itoa(p))
			changed = true
		}
		return strings.Join(out, ","), changed
	}
	nt, ct := merge(g.OnlinePortsTCP, tcpPorts)
	nu, cu := merge(g.OnlinePortsUDP, udpPorts)
	if !ct && !cu {
		return
	}
	updates := map[string]interface{}{}
	if ct {
		updates["online_ports_tcp"] = nt
	}
	if cu {
		updates["online_ports_udp"] = nu
	}
	if err := store.DB.Model(&model.Game{}).Where("id = ?", gameID).Updates(updates).Error; err != nil {
		logger.Error("游戏 %d 联机端口登记累加失败：%v", gameID, err)
		return
	}
	logger.Info("游戏 %d 联机端口登记累加：tcp=%s udp=%s", gameID, nt, nu)
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
	// 转发房主全部在线端（多端在线全部自动 accept）；功能二期：注入联机专用中继 iceServers
	// （未启用联机专用实例时 gnInjectICE 回退主实例池，与历史行为一致）
	s.gnNetForward(from, to, gnInjectICE(msg.Content))
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
	// accept 转发加入者（from 强制房主；功能二期：注入联机专用中继 iceServers）
	s.gnNetForward(from, sess.From, gnInjectICE(content))
}

// gnNetRelay 协商中继（offer/answer/candidate/relay）：校验会话存在与参与者身份后向对端转发，
// 功能二期：注入联机专用中继 iceServers（未启用专用实例时回退主实例池，原样中继媒体字段不解析）
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
	s.gnNetForward(from, peer, gnInjectICE(content))
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
