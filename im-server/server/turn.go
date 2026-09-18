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

	// 中继对外地址：优先显式配置 public_ip（NAT 后部署必须填公网 IP，
	// XOR-RELAYED-ADDRESS 里报告的是这个地址，客户端据此向中继端口发媒体流）；
	// 未配置时回退本机首个非回环非链路本地的 IPv4（实测多网卡机器会命中 169.254.* 虚拟网卡，
	// 故显式排除；仍可能命中 VMware 等虚拟网段，多网卡环境建议一律显式配置 public_ip）
	relayIP := net.ParseIP(t.PublicIP)
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

	// STUN/TURN 监听端口（UDP + TCP 双栈，coturn 同款默认；
	// 中继地址生成器各 listener 独立实例——pion 约定 generator 含分配状态不可共享）
	turnAddr := fmt.Sprintf("0.0.0.0:%d", port)
	udpListener, err := net.ListenPacket("udp4", turnAddr)
	if err != nil {
		return fmt.Errorf("TURN UDP 监听失败 %s: %w", turnAddr, err)
	}
	tcpListener, err := net.Listen("tcp4", turnAddr)
	if err != nil {
		_ = udpListener.Close()
		return fmt.Errorf("TURN TCP 监听失败 %s: %w", turnAddr, err)
	}

	newGen := func() *turn.RelayAddressGeneratorPortRange {
		return &turn.RelayAddressGeneratorPortRange{
			RelayAddress: relayIP,   // 对外报告的中继 IP（public_ip）
			Address:      "0.0.0.0", // 中继端口实际 bind 地址
			MinPort:      uint16(minPort),
			MaxPort:      uint16(maxPort),
			MaxRetries:   10,
		}
	}

	// 驻留后台：TURN 服务在 pion 内部 goroutine 中运行，随进程生命周期存活
	// （无需优雅关闭钩子——进程退出时端口句柄由内核回收，与 HTTP 监听同生命周期；
	// srv.AllocationCount() 可用于后续性能仪表盘指标，二期接入）
	if _, err = turn.NewServer(turn.ServerConfig{
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
	}); err != nil {
		_ = udpListener.Close()
		_ = tcpListener.Close()
		return fmt.Errorf("TURN 服务启动失败: %w", err)
	}

	logger.Info("TURN/STUN 中继服务已启动: udp+tcp %s | realm=%s | user=%s | 中继地址 %s | 端口段 %d-%d",
		turnAddr, realm, t.Username, relayIP.String(), minPort, maxPort)

	// 运行时快照归口：启动成功后 invite/accept 信令即可下发 iceServers（callInjectICE）
	turnRuntime.enabled = true
	turnRuntime.host = relayIP.String()
	turnRuntime.port = port
	turnRuntime.username = t.Username
	turnRuntime.password = t.Password
	return nil
}
