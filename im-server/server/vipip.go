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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
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
	enabled   bool
	gateway   string
	mask      string
	base      uint32 // 分配池起始 IP（uint32）
	size      int    // 池容量（含预留——预留位构建空闲栈时跳过）
	mu        sync.Mutex
	free      []uint32          // 空闲偏移栈：分配 pop / 释放 push，O(1) 无扫描
	assigned  map[string]string // username → ip（用户名级绑定：多端共用同 IP，同端互踢不变）
	owner     map[string]string // ip → username（admin 明细反查）
	allocAt   map[string]int64  // ip → 分配时刻（admin 明细排序）
	static    map[string]string // username → ip（静态绑定：admin 后台绑定，登录优先分配且独占不回池）
	staticRev map[string]string // ip → username（静态绑定反查：绑定冲突校验与列表）
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
	p.base = seed.Base
	p.size = seed.Size
	// supernode 候选 config 兜底注入（admin 后台热更块懒初始化时 DB 无行即用它，见 vipSup 块）
	vipSupMu.Lock()
	vipSupFb = seed.Supernodes
	vipSupMu.Unlock()
	p.assigned = map[string]string{}
	p.owner = map[string]string{}
	p.allocAt = map[string]int64{}
	p.static = map[string]string{}
	p.staticRev = map[string]string{}
	// 静态绑定初始化（admin 后台绑定事实源：DB status=1 且 username 非空，设计 §8.4）
	for u, ip := range seed.Bindings {
		p.static[u] = ip
		p.staticRev[ip] = u
	}
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
	// 静态绑定命中（admin 后台绑定，设计 §8.4）：直接分配绑定 IP——该 IP 不在空闲栈，
	// 动态分配发不出去（独占）；绑定后首次登录即生效，本次会话内进入 assigned 沿用
	if ip, ok := p.static[username]; ok {
		p.assigned[username] = ip
		p.owner[ip] = username
		p.allocAt[ip] = time.Now().Unix()
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

// Release 全设备下线释放（unregister remaining==0 分支调用）：未绑定 no-op，旁路态 no-op。
// 静态绑定的 IP 不回池（admin 绑定独占语义——其他用户动态分配占用不了，用户重上线即回原 IP）
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
	if p.static[username] == ip {
		return // 静态绑定：保留不回池（解绑后才重新入栈可分配）
	}
	if off := int(vipIPToU32(ip) - p.base); off >= 0 && off < p.size {
		if !p.freeContains(uint32(off)) { // 判重兜底：防 no-op 释放路径双 push（测试覆盖）
			p.free = append(p.free, uint32(off))
		}
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

// Supernodes 全局候选（登录回执 vip_supernodes 下发；旁路态返回空数组保证 JSON 为 [] 而非 null）。
// 数据源：DB 热更值（admin 后台 supernode 管理，保存即热生效）优先，config.yaml 兜底
func (p *vipPool) Supernodes() []string {
	if !p.enabled {
		return []string{}
	}
	list := vipSupList()
	if len(list) == 0 {
		return []string{}
	}
	return list
}

// ===== supernode 候选热更管理（admin 后台界面化，比照 linkwhitelist.go 全局 KV 模式） =====
// DB 全局 KV 行为真源（重启不丢）+ 内存直更（保存即热生效，无需重启）；
// DB 无行=从未在后台管理过，回退 config.yaml vip_pool.supernodes（首次部署平滑过渡）。
// 生效面：登录回执 vip_supernodes（下次登录）+ admin 游戏表单候选（打开即拉）。

// vipSupKind 全局 KV 行类型（model.AgentWhitelist 表 kind 列；username="" 为全局行）
const vipSupKind = "vip_supernodes"

// vipSupMaxItems 候选上限（防滥用）
const vipSupMaxItems = 20

var (
	vipSupMu   sync.Mutex
	vipSupRaw  string   // 当前生效归一串（逗号分隔 host:port）
	vipSupKnow bool     // 懒初始化标记（首读 DB 后置 true）
	vipSupRow  bool     // DB KV 行存在标记——存在即"后台已接管"（空值也生效，不回退 config）
	vipSupFb   []string // config.yaml 兜底列表（newVipPool 注入；仅未接管时使用）
)

// vipSupInitLocked 懒初始化：首次访问读 DB 全局 KV 行。
// 行存在=后台已接管（清空也生效，不回退 config——否则管理员永远无法真正清空）；
// 无行=从未在后台管理过，回退 config.yaml 兜底
func vipSupInitLocked() {
	if vipSupKnow {
		return
	}
	vipSupKnow = true
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", vipSupKind, "").First(&row).Error; err == nil {
		vipSupRow = true
		vipSupRaw = row.Value
		return
	}
	if len(vipSupFb) > 0 {
		vipSupRaw = strings.Join(vipSupFb, ",") // config 兜底（不落库——落库保存即视为接管）
	}
}

// vipSupList 当前生效候选列表（vipPool.Supernodes / admin GET / 游戏保存校验 归口）。
// 返回副本（未接管分支的 config 兜底切片为包级共享，副本防调用方污染）
func vipSupList() []string {
	vipSupMu.Lock()
	defer vipSupMu.Unlock()
	vipSupInitLocked()
	if !vipSupRow { // 未接管：config 兜底（副本返回）
		out := make([]string, len(vipSupFb))
		copy(out, vipSupFb)
		return out
	}
	if vipSupRaw == "" { // 已接管且清空：显式空（登录回执不下发、游戏表单提示未配置）
		return nil
	}
	return strings.Split(vipSupRaw, ",")
}

// vipSupSet 保存归口：DB 落库（失败内存不更，避免重启回退）+ 内存直更（热生效）。
// 落库成功即置接管标记（含清空——空串也是一次明确的接管操作）
func vipSupSet(norm string) error {
	vipSupMu.Lock()
	defer vipSupMu.Unlock()
	vipSupInitLocked()
	var row model.AgentWhitelist
	if err := store.DB.Where("kind = ? AND username = ?", vipSupKind, "").First(&row).Error; err == nil {
		if err := store.DB.Model(&row).Update("value", norm).Error; err != nil {
			return err
		}
	} else if err := store.DB.Create(&model.AgentWhitelist{Kind: vipSupKind, Value: norm}).Error; err != nil {
		return err
	}
	vipSupRaw = norm
	vipSupRow = true
	return nil
}

// vipSupValidate supernode 候选校验：每行/逗号分隔 "host:port"（host=域名或 IPv4，不支持
// IPv6 字面量——冒号与端口分隔歧义，需要时另行扩展）；port 1~65535；逐条去重去空、总量限制。
// 返回归一串（逗号分隔）与错误
func vipSupValidate(raw string) (string, error) {
	raw = strings.ReplaceAll(strings.TrimSpace(raw), "\n", ",")
	if raw == "" {
		return "", nil
	}
	seen := map[string]bool{}
	items := make([]string, 0, 8)
	for _, item := range strings.Split(raw, ",") {
		item = strings.ToLower(strings.TrimSpace(item)) // host 大小写不敏感，归一小写防同址双条目
		if item == "" {
			continue
		}
		idx := strings.LastIndex(item, ":")
		if idx <= 0 || idx == len(item)-1 {
			return "", errors.New("格式错误（须为 host:port）: " + item)
		}
		host, portStr := item[:idx], item[idx+1:]
		if len(host) > 253 {
			return "", errors.New("host 长度超限: " + item)
		}
		for _, c := range host {
			// 域名/IPv4 安全字符集（字母数字点横线）
			if !('a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '.' || c == '-') {
				return "", errors.New("host 含非法字符: " + item)
			}
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			return "", errors.New("端口无效（1~65535）: " + item)
		}
		if seen[item] {
			continue
		}
		seen[item] = true
		items = append(items, item)
	}
	if len(items) > vipSupMaxItems {
		return "", errors.New("候选条目过多（上限 20 条）")
	}
	norm := strings.Join(items, ",")
	// 总长对齐 KV 列容量（model.AgentWhitelist.Value varchar(512)）：超长时严格模式保存报错、
	// 非严格模式静默截断损坏候选——入口显式拒绝，提示拆分或缩短 host
	if len(norm) > 512 {
		return "", errors.New("候选总长超限（512 字符），请缩短 host 或减少条目")
	}
	return norm, nil
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
	// 静态绑定未在线数：其 IP 不在空闲栈也不在 assigned（独占保留态，重上线即回绑定 IP）——
	// 含用户在线但占用其他 IP（换绑后旧会话）的绑定 IP
	boundOffline := 0
	for u, ip := range p.static {
		if cur, ok := p.assigned[u]; !ok || cur != ip {
			boundOffline++
		}
	}
	used := len(p.assigned) + boundOffline
	return vipStats{
		Total:    p.size,
		Used:     used,
		Free:     len(p.free),
		Reserved: p.size - len(p.free) - used, // 纯预留（管理员保留，无绑定无占用）
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
	// 倒序：最新分配在前（稳定排序——同秒分配保持插入序，10s 轮询行序不抖动；
	// 占用量级=在线用户数，标准库 O(N log N) 防万级在线时 O(N²) 卡死）
	sort.SliceStable(out, func(i, j int) bool { return out[i].AllocAt > out[j].AllocAt })
	return out
}

// ===== 静态绑定（admin 后台绑定/解绑，设计 §8.4） =====
// 流程：handler 先 Check（冲突校验 + 取旧绑定）→ DB 写（新行 status=1+username、旧行清理）→ Apply 内存生效。
// 两阶段保证内存与 DB 一致：校验失败直接拒绝、DB 失败内存未动（无半生效态）

// vipBinding 绑定列表条目
type vipBinding struct {
	IP       string `json:"ip"`
	Username string `json:"username"`
	Online   bool   `json:"online"` // 用户当前是否在线占用该 IP
}

// CheckBind 绑定校验：IP 须在池内、未被他人静态绑定、未被他人动态占用。
// 返回该用户此前的绑定 IP（空=无旧绑定；换绑时 handler 须清理旧行）
func (p *vipPool) CheckBind(ip, username string) (oldIP string, err error) {
	if !p.enabled {
		return "", errors.New("虚拟IP池未启用")
	}
	offI := int64(vipIPToU32(ip)) - int64(p.base)
	if username == "" || offI < 0 || offI >= int64(p.size) {
		return "", errors.New("IP 不在分配池范围内")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if holder := p.staticRev[ip]; holder != "" && holder != username {
		return "", fmt.Errorf("该 IP 已绑定用户 %s，请先解绑", holder)
	}
	if owner := p.owner[ip]; owner != "" && owner != username {
		return "", fmt.Errorf("该 IP 正被用户 %s 动态占用，其下线后可绑定", owner)
	}
	return p.static[username], nil
}

// ApplyBind 内存生效（DB 写成功后调用）：写新绑定映射、清理旧绑定并回池、将新 IP 移出空闲栈（独占）
func (p *vipPool) ApplyBind(ip, username, oldIP string) {
	if !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if oldIP != "" && oldIP != ip {
		delete(p.static, username)
		delete(p.staticRev, oldIP)
		// 旧绑定 IP 回池（换绑泄漏防护）：无在线占用即入栈（用户在线动态持有时，
		// 其下线 Release 走动态分支自动回池）
		if p.owner[oldIP] == "" {
			offO := int64(vipIPToU32(oldIP)) - int64(p.base)
			if offO >= 0 && offO < int64(p.size) {
				p.freeAddIfAbsent(uint32(offO))
			}
		}
	}
	p.static[username] = ip
	p.staticRev[ip] = username
	// 新 IP 移出栈（用户在线动态占用中升格：本就不在栈；空闲/预留态：移出防动态分配发出——
	// O(N) 遍历，admin 低频操作可接受）
	p.freeRemove(uint32(vipIPToU32(ip) - p.base))
}

// CheckUnbind 解绑校验：须为静态绑定 IP；返回绑定用户名（handler 提示用）
func (p *vipPool) CheckUnbind(ip string) (string, error) {
	if !p.enabled {
		return "", errors.New("虚拟IP池未启用")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	u := p.staticRev[ip]
	if u == "" {
		return "", errors.New("该 IP 未绑定用户")
	}
	return u, nil
}

// ApplyUnbind 内存生效（DB 写成功后调用）：清映射；无在线占用即回空闲栈（判重兜底），
// 在线占用者下线时 Release 的动态分支（static 映射已删）自动回池
func (p *vipPool) ApplyUnbind(ip string) {
	if !p.enabled {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	username := p.staticRev[ip]
	if username == "" {
		return
	}
	delete(p.static, username)
	delete(p.staticRev, ip)
	if p.owner[ip] == "" {
		offI := int64(vipIPToU32(ip)) - int64(p.base)
		if offI >= 0 && offI < int64(p.size) {
			p.freeAddIfAbsent(uint32(offI))
		}
	}
}

// Bindings 绑定列表（admin 明细合并数据源；含"已绑定未在线"行——动态占用快照不可见）
func (p *vipPool) Bindings() []vipBinding {
	if !p.enabled {
		return []vipBinding{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]vipBinding, 0, len(p.static))
	for ip, u := range p.staticRev {
		online := false
		if cur, ok := p.assigned[u]; ok && cur == ip {
			online = true
		}
		out = append(out, vipBinding{IP: ip, Username: u, Online: online})
	}
	// IP 升序稳定呈现（绑定量级小，仍归口标准库稳定排序）
	sort.SliceStable(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	return out
}

// freeRemove 空闲栈内移除偏移（存在才删；O(N) 遍历，admin 低频操作可接受）
func (p *vipPool) freeRemove(off uint32) {
	for i, f := range p.free {
		if f == off {
			p.free = append(p.free[:i], p.free[i+1:]...)
			return
		}
	}
}

// freeContains 偏移是否已在栈中（Release 回池判重 / 回栈前预检）
func (p *vipPool) freeContains(off uint32) bool {
	for _, f := range p.free {
		if f == off {
			return true
		}
	}
	return false
}

// freeAddIfAbsent 不在栈中才入栈（判重兜底，防双 push 导致同 IP 重复分配）
func (p *vipPool) freeAddIfAbsent(off uint32) {
	if !p.freeContains(off) {
		p.free = append(p.free, off)
	}
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
// 逗号分隔 → 去重去空 → 每项必须 ⊆ 当前生效候选（vipSupList：admin 热更值优先，config 兜底——
// 与游戏表单多选的候选来源同源，否则后台新加的候选在保存游戏时会被误拒）。
// 返回归一化 CSV（空串=未配置走全局兜底）；候选为空且提交非空 → 报错（功能未配置时不允许私配）
func vipSupernodesClean(raw string) (string, error) {
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
	for _, s := range vipSupList() { // 运行期真实生效列表（后台热更值优先于 config 兜底）
		allowed[strings.TrimSpace(s)] = true
	}
	for _, s := range out {
		if !allowed[s] {
			return "", fmt.Errorf("联机 supernode %q 不在当前候选中，请先在「虚拟 IP」页补充或更正", s)
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
