package server

// ===== 阶段一百四十二：内置 TURN/STUN 中继服务（形态 A：与 im-server 同进程，零额外部署） =====
// 定位：P2P 直连（host/srflx 候选）打洞失败时（对称 NAT / 企业防火墙）的音视频媒体中继兜底。
// 基于 pion/turn v4（纯 Go 实现，协议同 coturn：RFC 5389 STUN + RFC 5766 TURN 长期凭证）。
// 约束：
//   1. 必须部署在拥有公网 IP 的服务器上；防火墙/安全组放行 turn.port（UDP+TCP）与
//      turn.min_port~turn.max_port（UDP，媒体中继端口段）
//   2. config.yaml turn.enabled=false（默认）时整段不启动，零开销零回归
//   3. 信令/话单/UI 链路零改动；客户端接入二期实现（RTCPeerConnection iceServers 填
//      turn:<public_ip>:<port>，建议经 invite/accept 信令由服务端下发，凭证可按通话轮换）

import (
	"crypto/md5"
	"fmt"
	"net"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"

	"im-server/config"
	"im-server/logger"
)

// turnRuntime TURN 运行时参数快照（StartTURN 启动成功时归口一次，信令下发 iceServers 用）
var turnRuntime struct {
	enabled  bool
	host     string // 对外可达地址（public_ip 或回退本机非链路本地 IPv4）
	port     int
	username string
	password string
}

// TurnICEServers 信令下发用 ICE 配置（阶段一百四十二二期：经 invite/accept 帧下发双方）
// 服务端归口：turn 未启用返回 nil（客户端退化为纯 P2P 直连，零改动兼容）
func TurnICEServers() []map[string]interface{} {
	if !turnRuntime.enabled {
		return nil
	}
	addr := fmt.Sprintf("%s:%d", turnRuntime.host, turnRuntime.port)
	return []map[string]interface{}{
		// STUN 条目让浏览器可收集 srflx 候选（跨网段 NAT 打洞）；pion/turn 同时是 STUN 服务器，复用同端口
		{"urls": "stun:" + addr},
		// TURN 条目：打洞失败时走中继兜底（credential 为明文长期凭证，浏览器侧自行参与 RFC 5766 摘要认证）
		{"urls": "turn:" + addr, "username": turnRuntime.username, "credential": turnRuntime.password},
	}
}

// StartTURN 启动内置 TURN/STUN 服务（main.go 归口调用）
// enabled=false 时静默返回；关键配置缺失返回错误（避免"看起来启用了实际在空转"的静默失败）
func StartTURN(cfg *config.Config) error {
	t := cfg.Turn
	if !t.Enabled {
		return nil
	}

	// 参数兜底：与 coturn 默认值对齐（realm/端口/中继端口段）
	realm := t.Realm
	if realm == "" {
		realm = "im-server"
	}
	port := t.Port
	if port <= 0 {
		port = 3478
	}
	minPort := t.MinPort
	if minPort <= 0 {
		minPort = 49160
	}
	maxPort := t.MaxPort
	if maxPort <= 0 {
		maxPort = 49200
	}
	if t.Username == "" || t.Password == "" {
		return fmt.Errorf("TURN 已启用但 turn.username/turn.password 未配置（config.yaml turn 节）")
	}
	// 巡检间隔归口：public_ip 为域名时生效（未配置/0 用默认 30 秒；IP 直填无巡检，值不参与）
	recheckSec := t.RecheckSec
	if recheckSec <= 0 {
		recheckSec = 30
	}

	// 中继对外地址：优先显式配置 public_ip（NAT 后部署必须填公网 IP，
	// XOR-RELAYED-ADDRESS 里报告的是这个地址，客户端据此向中继端口发媒体流）；
	// 阶段一百四十五：public_ip 支持域名——解析取首个 IPv4 作为中继地址（单机多出口/多线 IP
	// 场景任一出口均可达时等效；注意：多机集群不能共享同一轮询域名——中继会话绑定具体机器，
	// 客户端必须直连实际分配中继的那台，须每台机器配置解析到自身 IP 的独立域名或直接填 IP）；
	// 未配置时回退本机首个非回环非链路本地的 IPv4（实测多网卡机器会命中 169.254.* 虚拟网卡，
	// 故显式排除；仍可能命中 VMware 等虚拟网段，多网卡环境建议一律显式配置 public_ip）
	relayIP := net.ParseIP(t.PublicIP)
	// isDomainCfg 标记 public_ip 为域名（非 IP 字面量且非空）——域名场景启动巡检 goroutine
	// 跟随上游 DNS 活跃检测做线路故障自动切换（turnRecheckLoop）
	isDomainCfg := relayIP == nil && t.PublicIP != ""
	if isDomainCfg {
		// 域名解析归口：显式配置了域名（ParseIP 失败且非空）时经 DNS 解析取首个 IPv4；
		// 解析失败/无 A 记录直接报错退出（不静默回退本机地址，避免配置看似生效实际错位）
		addrs, err := net.LookupIP(t.PublicIP)
		if err == nil {
			for _, ip := range addrs {
				if ip.To4() != nil {
					relayIP = ip
					break
				}
			}
		}
		if relayIP == nil {
			return fmt.Errorf("TURN public_ip %s 无法解析出 IPv4 地址（检查域名 A 记录与本机 DNS）", t.PublicIP)
		}
		logger.Info("TURN public_ip 为域名 %s，解析为中继地址 %s（巡检间隔 %d 秒，线路故障自动切换无需重启）", t.PublicIP, relayIP.String(), recheckSec)
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
			return fmt.Errorf("TURN 已启用但无法确定中继地址：请配置 turn.public_ip")
		}
		logger.Info("TURN 未配置 public_ip，回退本机地址 %s（NAT 后/多网卡部署必须显式配置公网 IP）", relayIP.String())
	}

	// 长期凭证（RFC 5766 标准）：key = MD5(username:realm:password)，
	// 仅放行 config.yaml 中配置的单一账号，其余用户名一律拒绝
	auth := func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
		if username != t.Username {
			return nil, false
		}
		h := md5.Sum([]byte(username + ":" + realm + ":" + t.Password))
		return h[:], true
	}

	// STUN/TURN 监听端口（UDP + TCP 双栈，coturn 同款默认）
	turnAddr := fmt.Sprintf("0.0.0.0:%d", port)

	// buildTURN 组装指定中继 IP 的监听与服务（归口函数：启动与故障切换重建共用；
	// 重建时先关旧释放 3478 端口再建新，无端口冲突）
	buildTURN := func(relay net.IP) (func(), error) {
		udpListener, err := net.ListenPacket("udp4", turnAddr)
		if err != nil {
			return nil, fmt.Errorf("TURN UDP 监听失败 %s: %w", turnAddr, err)
		}
		tcpListener, err := net.Listen("tcp4", turnAddr)
		if err != nil {
			_ = udpListener.Close()
			return nil, fmt.Errorf("TURN TCP 监听失败 %s: %w", turnAddr, err)
		}
		// 中继地址生成器各 listener 独立实例——pion 约定 generator 含分配状态不可共享
		newGen := func() *turn.RelayAddressGeneratorPortRange {
			return &turn.RelayAddressGeneratorPortRange{
				RelayAddress: relay,      // 对外报告的中继 IP
				Address:      "0.0.0.0", // 中继端口实际 bind 地址
				MinPort:      uint16(minPort),
				MaxPort:      uint16(maxPort),
				MaxRetries:   10,
			}
		}
		// 驻留后台：TURN 服务在 pion 内部 goroutine 中运行，随进程生命周期存活
		// （srv.AllocationCount() 可用于后续性能仪表盘指标，二期接入）
		srv, err := turn.NewServer(turn.ServerConfig{
			Realm:       realm,
			AuthHandler: auth,
			// pion 默认日志工厂（输出到 stdout 与服务端日志同流；自定义降噪二期再做）
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
			return nil, fmt.Errorf("TURN 服务启动失败: %w", err)
		}
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

	// iceServers 下发地址归口：显式配置 public_ip（IP 或域名）时原样下发——域名场景客户端
	// 自行解析，DNS 活跃检测故障转移与运营商三线优选在客户端侧实时生效（多线同机映射部署
	// 的核心收益）；XOR-RELAYED-ADDRESS 中继报告为启动时解析的 IP 字面量（STUN 协议要求），
	// 服务端侧由巡检 goroutine（turnRecheckLoop）跟随上游活跃检测自动切换，无需重启。
	// 未配置 public_ip 时下发回退解析的本机地址
	turnHost := t.PublicIP
	if turnHost == "" {
		turnHost = relayIP.String()
	}

	logger.Info("TURN/STUN 中继服务已启动: udp+tcp %s | realm=%s | user=%s | 中继地址 %s | iceServers 下发地址 %s | 端口段 %d-%d",
		turnAddr, realm, t.Username, relayIP.String(), turnHost, minPort, maxPort)

	// ===== 阶段一百四十五：域名线路故障自动跟随（多线路域名 + 上游活跃检测场景，零重启切换） =====
	// public_ip 为域名时驻留巡检 goroutine：当前中继 IP 不在解析结果中（线路被剔除/故障）→
	// 自动重建 TURN 服务切换到解析结果首个可用 IPv4；三线路全部健康时解析结果恒含当前 IP
	// （轮询顺序变化不触发重建，杜绝抖动）。代价：重建终止存量中继 Allocation——正在经中继
	// 兜底的通话媒体中断（客户端按断网收口），但线路故障时这些通话本已不可达，重建保证
	// 后续新通话立即使用存活线路
	if isDomainCfg {
		go turnRecheckLoop(t.PublicIP, time.Duration(recheckSec)*time.Second, relayIP, buildTURN, closeTURN)
	}

	// 运行时快照归口：启动成功后 invite/accept 信令即可下发 iceServers（callInjectICE）
	turnRuntime.enabled = true
	turnRuntime.host = turnHost
	turnRuntime.port = port
	turnRuntime.username = t.Username
	turnRuntime.password = t.Password
	return nil
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
func turnRecheckLoop(domain string, interval time.Duration, initRelay net.IP, build func(net.IP) (func(), error), closeOld func()) {
	cur := initRelay
	closeFn := closeOld
	healthy := true
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		ips, err := net.LookupIP(domain)
		if err != nil {
			logger.Warn("TURN 中继地址巡检：域名 %s 解析失败（保留当前中继地址 %s）", domain, cur.String())
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
			logger.Error("TURN 中继地址切换失败（目标 %s）：%v（下一轮巡检重试，期间 TURN 服务不可用）", desired.String(), berr)
			continue
		}
		logger.Info("TURN 中继地址已自动切换：%s -> %s（域名 %s 线路故障跟随，无需重启服务端）", cur.String(), desired.String(), domain)
		cur = desired
		closeFn = newClose
		healthy = true
	}
}
