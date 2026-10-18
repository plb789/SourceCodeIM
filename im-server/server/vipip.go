// vipip.go —— 虚拟 IP 内存池（联机虚拟网卡路线，设计文档 docs/虚拟IP池设计方案.md）
// 职责：① 用户名级 IP 分配/释放（登录绑定、全设备下线释放，O(1) 空闲栈无扫描）
//
//	② MAC 与 IP 同生（确定性映射 02:00:0A:28:AA:BB ← IP 四段，IP 唯一⇒MAC 唯一）
//	③ 建房社区名/密钥生成（-c 5 位纯数字活跃房间内唯一 / -k 6 位纯数字，Redis HASH 归口）
//	④ admin 展示数据源（Stats/Snapshot）与游戏表单 supernode 白名单校验
//
// 运行态纯内存（重启即全量空闲，重连用户重新分配）；DB 仅存池本体与预留标记（store 层归口）
package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/store"
)

// vipLease 一次分配的完整租约：IP + 配套 MAC（p2p-host -a/-s 参数数据源，随登录回执下发）
type vipLease struct {
	IP  string
	MAC string
}

// vipEntry admin 占用明细条目
type vipEntry struct {
	IP       string `json:"ip"`
	Username string `json:"username"`
	AllocAt  int64  `json:"alloc_at"`
}

// errVipExhausted IP 耗尽（分配失败不阻塞登录，调用方按"未分配"降级，设计 §9.1）
var errVipExhausted = errors.New("虚拟IP池已耗尽")

// vipCommHash 活跃社区名归口（Redis HASH：社区名 → 房间号，跨实例共享）。
// 用 HASH 而非 SET：撞名时 HGET 取回房间号即可 EXISTS 校验房间键存活（TTL 过期残留惰性剪枝后复用）
const vipCommHash = "im:game:communities"

// vipPool 内存虚拟 IP 池（enabled=false 时全部方法旁路：零分配、零社区生成、登录回执恒空）
type vipPool struct {
	enabled    bool
	gateway    string
	mask       string
	supernodes []string
	base       uint32 // 分配池起始 IP（uint32）
	size       int    // 池容量（含预留——预留位构建空闲栈时跳过）
	mu         sync.Mutex
	free       []uint32          // 空闲偏移栈：分配 pop / 释放 push，O(1) 无扫描
	assigned   map[string]string // username → ip（用户名级绑定：多端共用同 IP，同端互踢不变）
	owner      map[string]string // ip → username（admin 明细反查）
	allocAt    map[string]int64  // ip → 分配时刻（admin 明细排序）
}

// newVipPool 构建内存池（NewServer 调用；store.VipPool 种子为 nil=功能旁路，返回禁用空池）
func newVipPool(cfg *config.Config) *vipPool {
	p := &vipPool{enabled: false}
	seed := store.VipPool
	if seed == nil {
		return p
	}
	p.enabled = true
	p.gateway = seed.Gateway
	p.mask = seed.Mask
	p.supernodes = seed.Supernodes
	p.base = seed.Base
	p.size = seed.Size
	p.assigned = map[string]string{}
	p.owner = map[string]string{}
	p.allocAt = map[string]int64{}
	// 空闲栈构建：预留位（status=1）跳过不参与分配；偏移升序入栈，分配从栈顶（尾端）pop
	p.free = make([]uint32, 0, seed.Size)
	for off := 0; off < seed.Size; off++ {
		ip := vipU32ToIP(p.base + uint32(off))
		if seed.Reserved[ip] {
			continue
		}
		p.free = append(p.free, uint32(off))
	}
	logger.Info("虚拟IP内存池就绪: 空闲 %d / 容量 %d（网关 %s）", len(p.free), seed.Size, seed.Gateway)
	return p
}

// Alloc 登录绑定（finishLogin 调用）：已绑定沿用同租约（多端第二设备/同端互踢不掉 IP）；
// 池空返回 errVipExhausted（调用方降级不阻塞登录）；旁路态返回空租约无错误
func (p *vipPool) Alloc(username string) (vipLease, error) {
	if !p.enabled || username == "" {
		return vipLease{}, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if ip, ok := p.assigned[username]; ok {
		return vipLease{IP: ip, MAC: vipMacOf(ip)}, nil
	}
	if len(p.free) == 0 {
		return vipLease{}, errVipExhausted
	}
	off := p.free[len(p.free)-1]
	p.free = p.free[:len(p.free)-1]
	ip := vipU32ToIP(p.base + off)
	p.assigned[username] = ip
	p.owner[ip] = username
	p.allocAt[ip] = time.Now().Unix()
	return vipLease{IP: ip, MAC: vipMacOf(ip)}, nil
}

// Release 全设备下线释放（unregister remaining==0 分支调用）：未绑定 no-op，旁路态 no-op
func (p *vipPool) Release(username string) {
	if !p.enabled || username == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	ip, ok := p.assigned[username]
	if !ok {
		return
	}
	delete(p.assigned, username)
	delete(p.owner, ip)
	delete(p.allocAt, ip)
	if off := int(vipIPToU32(ip) - p.base); off >= 0 && off < p.size {
		p.free = append(p.free, uint32(off))
	}
}

// Get 查询当前绑定 IP（空串=未绑定/旁路）
func (p *vipPool) Get(username string) string {
	if !p.enabled || username == "" {
		return ""
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.assigned[username]
}

// Supernodes 全局候选（登录回执 vip_supernodes 下发；旁路态返回空数组保证 JSON 为 [] 而非 null）
func (p *vipPool) Supernodes() []string {
	if !p.enabled || len(p.supernodes) == 0 {
		return []string{}
	}
	return p.supernodes
}

// vipStats admin 统计（总数/占用/空闲/预留）
type vipStats struct {
	Total    int `json:"total"`
	Used     int `json:"used"`
	Free     int `json:"free"`
	Reserved int `json:"reserved"`
}

func (p *vipPool) Stats() vipStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return vipStats{
		Total:    p.size,
		Used:     len(p.assigned),
		Free:     len(p.free),
		Reserved: p.size - len(p.free) - len(p.assigned),
	}
}

// Snapshot 占用明细（按分配时间倒序，admin 列表数据源；旁路态返回空切片）
func (p *vipPool) Snapshot() []vipEntry {
	if !p.enabled {
		return []vipEntry{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]vipEntry, 0, len(p.assigned))
	for ip, u := range p.owner {
		out = append(out, vipEntry{IP: ip, Username: u, AllocAt: p.allocAt[ip]})
	}
	// 倒序：最新分配在前（插入排序按时间，占用量级=在线用户数，规模小无需快排）
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].AllocAt > out[j-1].AllocAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// ClaimCommunity 建房成功后领取社区名/密钥（gnHandleCreate 调用，设计 §5.2）：
//
//	-c 社区名 5 位纯数字（10000~99999），活跃房间内唯一——Redis HASH HSetNX 原子占位
//	  （值=房间号），撞名重试 5 次并惰性剪枝（对应房间键已 TTL 过期=残留，删除后复用该名）；
//	-k 社区密钥 6 位纯数字（100000~999999）。
//
// 建房 Lua 成功后调用（失败路径不领取，无占位泄漏面）；旁路态返回空串 nil
// （客户端按无虚拟网卡路由处理，既有联机隧道链路不受影响）
func (p *vipPool) ClaimCommunity(ctx context.Context, roomID string) (string, string, error) {
	if !p.enabled || roomID == "" {
		return "", "", nil
	}
	for attempt := 0; attempt < 5; attempt++ {
		comm, err := vipRandDigits(10000, 99999)
		if err != nil {
			return "", "", err
		}
		ok, err := store.RDB.HSetNX(ctx, vipCommHash, comm, roomID).Result()
		if err != nil {
			return "", "", err
		}
		if ok {
			key, err := vipRandDigits(100000, 999999)
			if err != nil {
				store.RDB.HDel(ctx, vipCommHash, comm) // 密钥生成失败不残留半领取态
				return "", "", err
			}
			return comm, key, nil
		}
		// 撞名：惰性剪枝——占用者房间键已不存在（TTL 过期残留）即删除后重试复用
		if holder, _ := store.RDB.HGet(ctx, vipCommHash, comm).Result(); holder != "" {
			if exists, _ := store.RDB.Exists(ctx, gnRoomKey(holder)).Result(); exists == 0 {
				store.RDB.HDel(ctx, vipCommHash, comm)
			}
		}
	}
	return "", "", errors.New("社区名生成繁忙（活跃房间社区名冲突重试耗尽）")
}

// ReleaseCommunity 关房释放社区名（gnCloseRoom 调用；比对房号防误删他房，幂等无害）
func (p *vipPool) ReleaseCommunity(ctx context.Context, comm, roomID string) {
	if !p.enabled || comm == "" {
		return
	}
	if cur, _ := store.RDB.HGet(ctx, vipCommHash, comm).Result(); cur == roomID || cur == "@creating" {
		store.RDB.HDel(ctx, vipCommHash, comm)
	}
}

// vipSupernodesClean 游戏表单联机 supernode 串清洗校验（gameadmin 保存归口）：
// 逗号分隔 → 去重去空 → 每项必须 ⊆ vip_pool.supernodes 全局候选（防后台接口被直接调用提交任意地址）。
// 返回归一化 CSV（空串=未配置走全局兜底）；候选为空且提交非空 → 报错（功能未配置时不允许私配）
func vipSupernodesClean(cfg *config.Config, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	var out []string
	seen := map[string]bool{}
	for _, seg := range strings.Split(raw, ",") {
		if seg = strings.TrimSpace(seg); seg == "" || seen[seg] {
			continue
		}
		seen[seg] = true
		out = append(out, seg)
	}
	if len(out) == 0 {
		return "", nil
	}
	allowed := map[string]bool{}
	for _, s := range cfg.VipPool.Supernodes {
		allowed[strings.TrimSpace(s)] = true
	}
	for _, s := range out {
		if !allowed[s] {
			return "", fmt.Errorf("联机 supernode %q 未在 vip_pool.supernodes 候选中登记，请先在配置文件补录", s)
		}
	}
	return strings.Join(out, ","), nil
}

// vipMacOf IP → MAC 确定性映射（设计 §4.4）：02:00:0A:28:AA:BB（AA/BB=IP 后两段）。
// 首字节 0x02=本地管理地址（U/L 位=1），永不与 IEEE 全球唯一 OUI 冲突；映射可逆可读
func vipMacOf(ipStr string) string {
	ip := net.ParseIP(ipStr)
	if ip == nil || ip.To4() == nil {
		return ""
	}
	v4 := ip.To4()
	return fmt.Sprintf("02:00:%02X:%02X:%02X:%02X", v4[0], v4[1], v4[2], v4[3])
}

// vipRandDigits crypto/rand 均匀随机纯数字串（区间 [min,max] 无前导零）
func vipRandDigits(min, max int64) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(max-min+1))
	if err != nil {
		return "", err
	}
	return strconv.FormatInt(min+n.Int64(), 10), nil
}

func vipU32ToIP(v uint32) string {
	return net.IPv4(byte(v>>24), byte(v>>16), byte(v>>8), byte(v)).String()
}

func vipIPToU32(s string) uint32 {
	ip := net.ParseIP(s)
	if ip == nil || ip.To4() == nil {
		return 0
	}
	v4 := ip.To4()
	return uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3])
}
