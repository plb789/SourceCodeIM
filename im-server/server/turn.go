package server

// ===== 阶段一百四十二：内置 TURN/STUN 中继服务（形态 A：与 im-server 同进程，零额外部署） =====
// 定位：P2P 直连（host/srflx 候选）打洞失败时（对称 NAT / 企业防火墙）的音视频媒体中继兜底。
// 基于 pion/turn v4（纯 Go 实现，协议同 coturn：RFC 5389 STUN + RFC 5766 TURN 长期凭证）。
// 约束：
//   1. 必须部署在拥有公网 IP 的服务器上；防火墙/安全组放行 turn.port（UDP+TCP）与
//      turn.min_port~turn.max_port（UDP，媒体中继端口段）
//   2. config.yaml turn.enabled=false（默认）时整段不启动，零开销零回归
//   3. 信令/话单/UI 链路零改动；客户端接入已完成——1v1 通话（invite/accept 经 callInjectICE
//      注入）、群会议（meet_invite/room_info 等）、文件 P2P 直传（probe/answer）、远程协助
//      （rc_ok）均下发 iceServers，call-page.js 建连时填入 RTCPeerConnection.iceServers

import (
	"crypto/md5"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"

	"im-server/config"
	"im-server/logger"
)

// turnRT TURN 运行时参数快照（启动成功时归口一次，信令下发 iceServers 用）
type turnRT struct {
	enabled  bool
	host     string // 对外可达地址（public_ip 或回退本机非链路本地 IPv4）
	port     int
	username string
	password string
	capacity int // 中继端口段容量（max_port-min_port+1；占用水位告警分母）
}

var (
	turnRuntime   turnRT // 通话/会议/文件直传/远程协助 主实例
	gnTurnRuntime turnRT // 功能二期：联机专用实例（独立监听端口 + 独立端口子段）
)

// ===== 联机二期 §9.4-4：中继占用量可观测 =====
// pion Server.AllocationCount() 为现成只读 API（各 allocationManager 存量求和，微秒级开销），
// 归口在 turnServerRef 上供周期采样与仪表盘/告警读取；域名巡检重建（turnRecheckLoop）会
// 换掉 Server 实例，故读取点统一走加锁引用而非捕获旧指针（避免读到已关闭实例）。
// 功能二期起为「主实例（通话等）」与「联机专用实例」各持一份引用与峰值（两池独立观测）。
type turnSrvHolder struct {
	sync.Mutex
	srv *turn.Server
}

var (
	turnServerRef   turnSrvHolder
	gnTurnServerRef turnSrvHolder
	// 进程启动以来中继占用峰值（采样点与指标读取点分别抬高，取最大）
	turnAllocPeak   atomic.Int64
	gnTurnAllocPeak atomic.Int64
)

// turnStatsOf 指定实例的中继占用现状：当前会话数 / 启动以来峰值 / 端口段容量
// ok=false 表示该实例未启用或服务实例尚未就绪（调用方据此跳过展示与告警）
func turnStatsOf(ref *turnSrvHolder, peak *atomic.Int64, capacity int) (cur, pk, cap int, ok bool) {
	ref.Lock()
	srv := ref.srv
	ref.Unlock()
	if srv == nil {
		return 0, int(peak.Load()), capacity, false
	}
	cur = srv.AllocationCount()
	for {
		p := peak.Load()
		if int64(cur) <= p || peak.CompareAndSwap(p, int64(cur)) {
			break
		}
	}
	return cur, int(peak.Load()), capacity, true
}

// turnAllocationStats 主实例（通话/会议/直传/远程）中继占用现状
func turnAllocationStats() (cur, peak, capacity int, ok bool) {
	return turnStatsOf(&turnServerRef, &turnAllocPeak, turnRuntime.capacity)
}

// gnTurnAllocationStats 联机专用实例中继占用现状（功能二期；未启用时 ok=false）
func gnTurnAllocationStats() (cur, peak, capacity int, ok bool) {
	return turnStatsOf(&gnTurnServerRef, &gnTurnAllocPeak, gnTurnRuntime.capacity)
}

// turnAllocSampler 中继占用周期采样日志（60 秒周期；label 区分主实例/联机专用实例）
// 静默口径：零占用的轮次不输出（无中继兜底=所有打洞成功，属正常态）；
// 有占用时每轮输出一行当前值，归零时输出一次释放收口行——
// 运维据此判断"当前有多少通话/联机正走中继兜底"，并在打洞失败率上升时提前发现
func turnAllocSampler(label string, stats func() (int, int, int, bool)) {
	last := 0
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		cur, peak, capacity, ok := stats()
		if !ok {
			continue
		}
		if cur == 0 {
			if last > 0 {
				logger.Info("[%s] 中继会话已全部释放（本次峰值 %d/%d）", label, peak, capacity)
			}
		} else {
			logger.Info("[%s] 当前中继会话 %d/%d（启动以来峰值 %d）", label, cur, capacity, peak)
		}
		last = cur
	}
}

// iceServersOf 由某实例快照构造 ICE 配置（STUN + TURN 长期凭证）
// 服务端归口：实例未启用返回 nil（客户端退化为纯 P2P 直连，零改动兼容）
func iceServersOf(rt turnRT) []map[string]interface{} {
	if !rt.enabled {
		return nil
	}
	addr := fmt.Sprintf("%s:%d", rt.host, rt.port)
	return []map[string]interface{}{
		// STUN 条目让浏览器可收集 srflx 候选（跨网段 NAT 打洞）；pion/turn 同时是 STUN 服务器，复用同端口
		{"urls": "stun:" + addr},
		// TURN 条目：打洞失败时走中继兜底（credential 为明文长期凭证，浏览器侧自行参与 RFC 5766 摘要认证）
		{"urls": "turn:" + addr, "username": rt.username, "credential": rt.password},
	}
}

// TurnICEServers 主实例 ICE 配置（通话 invite/accept、会议、文件直传、远程协助下发）
func TurnICEServers() []map[string]interface{} {
	return iceServersOf(turnRuntime)
}

// GameNetICEServers 联机专用实例 ICE 配置（110 连接层 probe/accept/offer 等下发）；
// 功能二期：联机专用实例未启用时**回退主实例池**——与历史行为完全一致（零回归），
// 启用后联机中继走独立端口池，不再与通话/会议抢同一池
func GameNetICEServers() []map[string]interface{} {
	if gnTurnRuntime.enabled {
		return iceServersOf(gnTurnRuntime)
	}
	return TurnICEServers()
}

// injectICE 将 ICE 配置注入 content 的 ice 键（轻解析口径：非 JSON 原样中继不拦）
func injectICE(content string, ice []map[string]interface{}) string {
	if ice == nil {
		return content
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(content), &m); err != nil {
		return content // 轻解析原则：非 JSON content 原样中继不拦
	}
	m["ice"] = ice
	b, err := json.Marshal(m)
	if err != nil {
		return content
	}
	return string(b)
}

// gnInjectICE 联机信令 ICE 注入（与 callInjectICE 同口径，但走联机专用实例/回退主实例池）
func gnInjectICE(content string) string {
	return injectICE(content, GameNetICEServers())
}

// relayGenObserved 中继地址生成器可观测包装（内嵌端口段生成器，行为零改动）
// 目的：pion 默认日志级别不输出分配成功事件，中继分配归口在此打中文日志——
// 服务端运维据此判断"是否真的有通话/联机走了中继兜底"（无分配记录=全部 P2P 直连成功，属正常）；
// label 区分主实例（通话等）与联机专用实例
type relayGenObserved struct {
	*turn.RelayAddressGeneratorPortRange
	label string
}

func (g *relayGenObserved) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.RelayAddressGeneratorPortRange.AllocatePacketConn(network, requestedPort)
	if err == nil {
		logger.Info("[%s] 分配中继端口 %s（network=%s，打洞失败兜底会话）", g.label, addr.String(), network)
	}
	return conn, addr, err
}

// turnStartOpts 单个 TURN 实例启动参数（通话主实例与联机专用实例共用同一套启动逻辑）
type turnStartOpts struct {
	label      string // 日志标识前缀（"TURN 中继" / "联机中继"）
	realm      string // 凭证域（空=im-server）
	publicIP   string // 对外报告地址（IP 或域名；空=回退本机首个非回环非链路本地 IPv4）
	recheckSec int    // 域名巡检间隔秒（<=0=30）
	port       int    // STUN/TURN 监听端口（<=0=3478）
	username   string
	password   string
	minPort    int
	maxPort    int
	rt         *turnRT        // 运行时快照回填目标
	ref        *turnSrvHolder // 服务实例引用归口（观测/重建用）
	peak       *atomic.Int64  // 占用峰值归口
	sampler    bool           // 是否启动占用采样协程
	genDfltMin int            // minPort 缺省值
	genDfltMax int            // maxPort 缺省值
}

// startTURNInstance 启动一个 TURN/STUN 实例（通话主实例与联机专用实例共用；各自的端口/端口段/观测引用）
// 关键配置缺失返回错误（避免"看起来启用了实际在空转"的静默失败）
func startTURNInstance(o turnStartOpts) error {
	// 参数兜底：与 coturn 默认值对齐（realm/端口/中继端口段）
	realm := o.realm
	if realm == "" {
		realm = "im-server"
	}
	port := o.port
	if port <= 0 {
		port = 3478
	}
	minPort := o.minPort
	if minPort <= 0 {
		minPort = o.genDfltMin
	}
	maxPort := o.maxPort
	if maxPort <= 0 {
		maxPort = o.genDfltMax
	}
	if o.username == "" || o.password == "" {
		return fmt.Errorf("%s 已启用但 username/password 未配置（config.yaml 对应节）", o.label)
	}
	// 巡检间隔归口：public_ip 为域名时生效（未配置/0 用默认 30 秒；IP 直填无巡检，值不参与）
	recheckSec := o.recheckSec
	if recheckSec <= 0 {
		recheckSec = 30
	}

	// 中继对外地址：优先显式配置 public_ip（NAT 后部署必须填公网 IP，
	// XOR-RELAYED-ADDRESS 里报告的是这个地址，客户端据此向中继端口发媒体流）；
	// public_ip 支持域名——解析取首个 IPv4 作为中继地址（多机集群不能共享同一轮询域名）；
	// 未配置时回退本机首个非回环非链路本地的 IPv4
	relayIP := net.ParseIP(o.publicIP)
	// isDomainCfg 标记 public_ip 为域名（非 IP 字面量且非空）——域名场景启动巡检 goroutine
	isDomainCfg := relayIP == nil && o.publicIP != ""
	if isDomainCfg {
		// 域名解析归口：解析失败/无 A 记录直接报错退出（不静默回退本机地址，避免配置看似生效实际错位）
		addrs, err := net.LookupIP(o.publicIP)
		if err == nil {
			for _, ip := range addrs {
				if ip.To4() != nil {
					relayIP = ip
					break
				}
			}
		}
		if relayIP == nil {
			return fmt.Errorf("%s public_ip %s 无法解析出 IPv4 地址（检查域名 A 记录与本机 DNS）", o.label, o.publicIP)
		}
		logger.Info("%s public_ip 为域名 %s，解析为中继地址 %s（巡检间隔 %d 秒，线路故障自动切换无需重启）", o.label, o.publicIP, relayIP.String(), recheckSec)
	}
	if relayIP == nil {
		addrs, err := net.InterfaceAddrs()
		if err == nil {
			for _, a := range addrs {
				if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil &&
					!ipnet.IP.IsLoopback() && !ipnet.IP.IsLinkLocalUnicast() {
					relayIP = ipnet.IP
					break
				}
			}
		}
		if relayIP == nil {
			return fmt.Errorf("%s 已启用但无法确定中继地址：请配置 public_ip", o.label)
		}
		logger.Info("%s 未配置 public_ip，回退本机地址 %s（NAT 后/多网卡部署必须显式配置公网 IP）", o.label, relayIP.String())
	}

	// 长期凭证（RFC 5766 标准）：key = MD5(username:realm:password)，
	// 仅放行配置的单一账号，其余用户名一律拒绝
	auth := func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
		if username != o.username {
			return nil, false
		}
		h := md5.Sum([]byte(username + ":" + realm + ":" + o.password))
		return h[:], true
	}

	// STUN/TURN 监听端口（UDP + TCP 双栈，coturn 同款默认）
	turnAddr := fmt.Sprintf("0.0.0.0:%d", port)

	// buildTURN 组装指定中继 IP 的监听与服务（归口函数：启动与故障切换重建共用；
	// 重建时先关旧释放端口再建新，无端口冲突）
	buildTURN := func(relay net.IP) (func(), error) {
		udpListener, err := net.ListenPacket("udp4", turnAddr)
		if err != nil {
			return nil, fmt.Errorf("%s UDP 监听失败 %s: %w", o.label, turnAddr, err)
		}
		tcpListener, err := net.Listen("tcp4", turnAddr)
		if err != nil {
			_ = udpListener.Close()
			return nil, fmt.Errorf("%s TCP 监听失败 %s: %w", o.label, turnAddr, err)
		}
		// 中继地址生成器各 listener 独立实例——pion 约定 generator 含分配状态不可共享；
		// 外层 relayGenObserved 包装归口分配可观测日志（不影响端口段分配行为）
		newGen := func() *relayGenObserved {
			return &relayGenObserved{RelayAddressGeneratorPortRange: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: relay,     // 对外报告的中继 IP
				Address:      "0.0.0.0", // 中继端口实际 bind 地址
				MinPort:      uint16(minPort),
				MaxPort:      uint16(maxPort),
				MaxRetries:   10,
			}, label: o.label}
		}
		// 驻留后台：TURN 服务在 pion 内部 goroutine 中运行，随进程生命周期存活
		srv, err := turn.NewServer(turn.ServerConfig{
			Realm:       realm,
			AuthHandler: auth,
			// pion 默认日志工厂（输出到 stdout 与服务端日志同流）
			LoggerFactory: logging.NewDefaultLoggerFactory(),
			PacketConnConfigs: []turn.PacketConnConfig{
				{PacketConn: udpListener, RelayAddressGenerator: newGen()},
			},
			ListenerConfigs: []turn.ListenerConfig{
				{Listener: tcpListener, RelayAddressGenerator: newGen()},
			},
		})
		if err != nil {
			_ = udpListener.Close()
			_ = tcpListener.Close()
			return nil, fmt.Errorf("%s 服务启动失败: %w", o.label, err)
		}
		o.ref.Lock()
		o.ref.srv = srv
		o.ref.Unlock()
		// 关闭归口：pion Server 收尾（清理存量 Allocation）+ 双监听释放
		return func() {
			_ = srv.Close()
			_ = tcpListener.Close()
			_ = udpListener.Close()
		}, nil
	}

	closeTURN, err := buildTURN(relayIP)
	if err != nil {
		return err
	}

	// iceServers 下发地址归口：显式配置 public_ip（IP 或域名）时原样下发；未配置时下发回退解析的本机地址
	turnHost := o.publicIP
	if turnHost == "" {
		turnHost = relayIP.String()
	}

	logger.Info("%s/STUN 中继服务已启动: udp+tcp %s | realm=%s | user=%s | 中继地址 %s | iceServers 下发地址 %s | 端口段 %d-%d",
		o.label, turnAddr, realm, o.username, relayIP.String(), turnHost, minPort, maxPort)

	// ===== 阶段一百四十五：域名线路故障自动跟随（多线路域名 + 上游活跃检测场景，零重启切换） =====
	// public_ip 为域名时驻留巡检 goroutine：当前中继 IP 不在解析结果中（线路被剔除/故障）→
	// 自动重建 TURN 服务切换到解析结果首个可用 IPv4
	if isDomainCfg {
		go turnRecheckLoop(o.label, o.publicIP, time.Duration(recheckSec)*time.Second, relayIP, buildTURN, closeTURN)
	}

	// 运行时快照归口：启动成功后信令即可下发 iceServers
	o.rt.enabled = true
	o.rt.host = turnHost
	o.rt.port = port
	o.rt.username = o.username
	o.rt.password = o.password
	// 端口段容量归口（占用水位告警分母）：UDP/TCP 各持独立端口池，此处取单个池的端口数（保守下限）
	o.rt.capacity = maxPort - minPort + 1
	if o.sampler {
		ref, peak, rt := o.ref, o.peak, o.rt
		go turnAllocSampler(o.label, func() (int, int, int, bool) {
			return turnStatsOf(ref, peak, rt.capacity)
		})
	}
	return nil
}

// StartTURN 启动通话主实例（音视频通话/会议/文件直传/远程协助；main.go 归口调用）
// enabled=false 时静默返回，零开销零回归
func StartTURN(cfg *config.Config) error {
	t := cfg.Turn
	if !t.Enabled {
		return nil
	}
	return startTURNInstance(turnStartOpts{
		label:      "TURN 中继",
		realm:      t.Realm,
		publicIP:   t.PublicIP,
		recheckSec: t.RecheckSec,
		port:       t.Port,
		username:   t.Username,
		password:   t.Password,
		minPort:    t.MinPort,
		maxPort:    t.MaxPort,
		rt:         &turnRuntime,
		ref:        &turnServerRef,
		peak:       &turnAllocPeak,
		sampler:    true,
		genDfltMin: 49160,
		genDfltMax: 49960,
	})
}

// StartGameNetTURN 启动联机专用 TURN 实例（功能二期：独立监听端口 + 独立端口子段，
// 避免联机中继与通话/会议抢同一端口池）。未启用联机、未启用 turn 或未开本项开关时静默返回（零回归）。
func StartGameNetTURN(cfg *config.Config) error {
	r := cfg.GameNet.Relay
	if !cfg.GameNet.Enabled || !cfg.Turn.Enabled || !r.Enabled {
		return nil
	}
	if r.Port == cfg.Turn.Port {
		return fmt.Errorf("联机专用中继端口 %d 与 turn.port 相同（须使用不同监听端口，避免端口冲突）", r.Port)
	}
	return startTURNInstance(turnStartOpts{
		label:      "联机中继",
		realm:      cfg.Turn.Realm,
		publicIP:   cfg.Turn.PublicIP,
		recheckSec: cfg.Turn.RecheckSec,
		port:       r.Port,
		username:   cfg.Turn.Username,
		password:   cfg.Turn.Password,
		minPort:    r.MinPort,
		maxPort:    r.MaxPort,
		rt:         &gnTurnRuntime,
		ref:        &gnTurnServerRef,
		peak:       &gnTurnAllocPeak,
		sampler:    true,
		genDfltMin: 49961,
		genDfltMax: 50760,
	})
}

// selectRelayIP 中继地址切换判定（纯函数，单测归口）
// 返回：期望中继 IP 与是否需要切换。
//   - cur 仍在解析结果（健康集合）中 → 维持现状（多 A 记录轮询顺序变化不重建，杜绝抖动）
//   - cur 不在其中（该线路被上游活跃检测剔除/故障）→ 切到解析结果首个 IPv4
//   - 解析结果无 IPv4 → 维持现状（保留当前可用地址，不误切）
func selectRelayIP(cur net.IP, ips []net.IP) (net.IP, bool) {
	var first4 net.IP
	found := false
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			if first4 == nil {
				first4 = v4
			}
			if v4.Equal(cur) {
				found = true
			}
		}
	}
	if first4 == nil || found {
		return cur, false
	}
	return first4, true
}

// turnRecheckLoop 域名中继地址巡检循环（阶段一百四十五：线路故障自动跟随，零重启切换）
// 说明：ticker 单协程串行执行，重建不存在并发进入；域名解析失败仅告警保留现状（不误切）；
// 重建失败置不健康标记，下一轮巡检重试直至成功（期间 TURN 服务不可用，错误日志归口）
func turnRecheckLoop(label, domain string, interval time.Duration, initRelay net.IP, build func(net.IP) (func(), error), closeOld func()) {
	cur := initRelay
	closeFn := closeOld
	healthy := true
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		ips, err := net.LookupIP(domain)
		if err != nil {
			logger.Warn("%s 中继地址巡检：域名 %s 解析失败（保留当前中继地址 %s）", label, domain, cur.String())
			continue
		}
		desired, needSwitch := selectRelayIP(cur, ips)
		if !needSwitch && healthy {
			continue // 当前线路健康且服务正常：维持现状（多记录轮询顺序变化不重建）
		}
		if !needSwitch {
			desired = cur // 切换判定为维持：healthy=false 时按当前 IP 重试重建
		}
		closeFn()
		newClose, berr := build(desired)
		if berr != nil {
			healthy = false
			logger.Error("%s 中继地址切换失败（目标 %s）：%v（下一轮巡检重试，期间该 TURN 服务不可用）", label, desired.String(), berr)
			continue
		}
		logger.Info("%s 中继地址已自动切换：%s -> %s（域名 %s 线路故障跟随，无需重启服务端）", label, cur.String(), desired.String(), domain)
		cur = desired
		closeFn = newClose
		healthy = true
	}
}
