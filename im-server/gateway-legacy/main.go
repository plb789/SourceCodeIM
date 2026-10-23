// im-gateway - 游戏端口透传·远程加密网关（独立部署，与 im-server 进程隔离）
//
// 职责：接收 PC 客户端转发器（game-forward.js gateway 模式）的加密流量，校验解密后
//      无损转发到本机 127.0.0.1 上的真实游戏服务端（真实服务端只监听回环，公网不可达）。
//
// 安全模型（其他任何流量全部拒绝）：
//   TCP → TLS 1.3 握手（Go 标准库自动拒绝非 TLS 明文）；首帧声明 token+目标端口，
//         token HMAC 验签失败 / 过期 / 目标不在白名单 → 回错误帧立即断开（无业务信息泄漏）
//   UDP → 逐包 AES-256-GCM：未知会话 / 解密失败 / 计数器重放 / 窗口外包 → 静默丢弃不回包，
//         外部探测连端口存在性都无法感知
//   目标 → 仅允许 127.0.0.1 且端口在 allow_targets 白名单内（防被当内网跳板）
//
// 协议 v1（TLS 通道内，帧 = 一行 JSON + '\n'）：
//   TCP 数据连接：{"token","target"} → {"ok":true} 后进入裸字节双向透传（每游戏连接一条 TLS）
//   UDP 控制连接：{"token","target","udp":true} → {"ok":true,"session":hex8,"k1","k2"}
//                 （k1=客户端→网关密钥 / k2=网关→客户端密钥，双向独立防 nonce 重用；
//                  每会话密钥随机，标准 12B nonce = 方向前缀 4B + counter 8B 全局唯一）
//                 控制连接断开或 90s 无帧 → 会话失效；客户端周期发空行保活
//   UDP 数据包：[session 4B][counter 8B]（12B 明文头 = AAD）+ [AES-256-GCM 密文+16B tag]
//                 nonce = dirPrefix("C2G0"/"G2C0") || counter；载荷上限 1200B（公网 MTU 安全值）
//   token 格式：hex(expire).username.hex16(HMAC-SHA256(secret,"im-gateway:"+username+":"+hex(expire)))
//
// 部署：单二进制 + gateway.yaml（listen/token_secret/allow_targets）；证书缺省自动生成
//      自签 ECDSA P-256 并在日志输出 SHA256 指纹（管理员复制到 im-server 后台随登录下发客户端 pin）

package main

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"
)

// ===== 常量 =====

const udpHeadLen = 12         // session 4B + counter 8B（明文头，作 AAD）
const udpTagLen = 16          // GCM 认证标签
const udpMaxPayload = 1200    // 公网 MTU 安全载荷上限（与直连公网行为一致）
const udpCtlIdleSec = 90      // 控制连接/会话空闲回收
const noncePrefixC2G = "C2G0" // 客户端→网关方向 nonce 前缀 4B
const noncePrefixG2C = "G2C0" // 网关→客户端方向 nonce 前缀 4B

// ===== 配置 =====

// ListenGroup 一组监听（一个公网接入端口对 + 专属目标白名单）：多组=单实例多监听，
// 各组独立白名单/独立会话表/独立连接上限（隔离性等同多实例，省进程管理成本）
type ListenGroup struct {
	Name         string `yaml:"name"`          // 组名（日志标识；缺省 listenN）
	ListenTCP    string `yaml:"listen_tcp"`    // 该组 TLS 监听（TCP 数据面 + UDP 控制面同端口）
	ListenUDP    string `yaml:"listen_udp"`    // 该组 UDP 数据面监听（可与 TCP 同号）
	AllowTargets []int  `yaml:"allow_targets"` // 该组专属的目标端口白名单（仅允许转发到本组白名单内的 127.0.0.1 端口）
}

type Config struct {
	// Listens 多监听组数组（新格式，推荐）：每组独立监听与白名单
	Listens []ListenGroup `yaml:"listens"`
	// ===== Web 管理后台（可选；两字段齐备才启动，默认仅绑 127.0.0.1，远程走 SSH 隧道）=====
	AdminListen   string `yaml:"admin_listen"`   // 后台监听地址（建议 127.0.0.1:30101）
	AdminPassword string `yaml:"admin_password"` // 后台登录密码（强密码；登录后发内存 session）
	// ===== 游戏账号写库（可选；dbwrite.enabled 才启动拉取器，见 dbwrite.go）=====
	Dbwrite DbwriteConfig `yaml:"dbwrite"`
	// —— 以下为旧版单监听格式（向后兼容：listens 为空时自动转为 name=default 的一组）——
	ListenTCP      string `yaml:"listen_tcp"`       // TLS 监听（TCP 数据面 + UDP 控制面同端口）
	ListenUDP      string `yaml:"listen_udp"`       // UDP 数据面监听（可与 TCP 同号）
	AllowTargets   []int  `yaml:"allow_targets"`    // 允许转发到的 127.0.0.1 端口白名单
	TokenSecret    string `yaml:"token_secret"`     // 与 im-server 共享的 token 验签密钥（必填）
	MaxTCPConns    int    `yaml:"max_tcp_conns"`    // TCP 透传连接上限（每组独立计数，默认 512）
	MaxUDPSessions int    `yaml:"max_udp_sessions"` // UDP 会话上限（每组独立计数，默认 256）
	TLSCert        string `yaml:"tls_cert"`         // 证书路径（缺省 gateway.crt）
	TLSKey         string `yaml:"tls_key"`          // 私钥路径（缺省 gateway.key）
}

// normalize 归一配置：listens 为空时旧单监听字段转一组（name=default）；
// 校验 token_secret/各组白名单/监听地址查重（同机同端口必冲突，启动即报错）
func (c *Config) normalize() error {
	if strings.TrimSpace(c.TokenSecret) == "" {
		return errors.New("token_secret 不能为空（与 im-server 共享的验签密钥）")
	}
	if c.MaxTCPConns <= 0 {
		c.MaxTCPConns = 512
	}
	if c.MaxUDPSessions <= 0 {
		c.MaxUDPSessions = 256
	}
	if c.TLSCert == "" {
		c.TLSCert = "gateway.crt"
	}
	if c.TLSKey == "" {
		c.TLSKey = "gateway.key"
	}
	if len(c.Listens) == 0 {
		// 旧格式兼容：顶层单监听字段转一组
		allow := c.AllowTargets
		if len(allow) == 0 {
			return errors.New("allow_targets 白名单不能为空（仅允许转发到白名单内的 127.0.0.1 端口）")
		}
		tcpAddr := c.ListenTCP
		if tcpAddr == "" {
			tcpAddr = "0.0.0.0:30100"
		}
		udpAddr := c.ListenUDP
		if udpAddr == "" {
			udpAddr = "0.0.0.0:30100"
		}
		c.Listens = []ListenGroup{{Name: "default", ListenTCP: tcpAddr, ListenUDP: udpAddr, AllowTargets: allow}}
	}
	seen := map[string]bool{}
	for i := range c.Listens {
		g := &c.Listens[i]
		if g.Name == "" {
			g.Name = "listen" + strconv.Itoa(i+1)
		}
		g.Name = strings.ToLower(strings.TrimSpace(g.Name))
		if g.ListenTCP == "" {
			g.ListenTCP = "0.0.0.0:30100"
		}
		if g.ListenUDP == "" {
			g.ListenUDP = g.ListenTCP
		}
		if len(g.AllowTargets) == 0 {
			return fmt.Errorf("监听组 %s 的 allow_targets 白名单不能为空", g.Name)
		}
		for _, p := range g.AllowTargets {
			if p < 1 || p > 65535 {
				return fmt.Errorf("监听组 %s 白名单端口非法: %d", g.Name, p)
			}
		}
		if seen[g.ListenTCP] {
			return fmt.Errorf("监听组 %s 的 TCP 地址重复: %s（同机同端口必冲突）", g.Name, g.ListenTCP)
		}
		seen[g.ListenTCP] = true
	}
	return nil
}

// ===== token 验签（与 im-server 签发口径一致） =====

// token 格式：hex(expire).username.hex16(hmac)，
// hmac = HMAC-SHA256(secret, "im-gateway:"+username+":"+hex(expire)) 前 16 字节
func verifyToken(secret, token string) (username string, err error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("token 格式非法")
	}
	expire, err1 := strconv.ParseInt(parts[0], 16, 64)
	user := parts[1]
	mac, err2 := hex.DecodeString(parts[2])
	if err1 != nil || err2 != nil || len(user) == 0 || len(user) > 64 {
		return "", errors.New("token 字段非法")
	}
	if time.Now().Unix() > expire {
		return "", errors.New("token 已过期")
	}
	mac2 := hmac.New(sha256.New, []byte(secret))
	mac2.Write([]byte("im-gateway:" + user + ":" + parts[0]))
	if !hmac.Equal(mac, mac2.Sum(nil)[:16]) {
		return "", errors.New("token 验签失败")
	}
	return user, nil
}

// ===== 自签证书（缺省自动生成，日志输出指纹供客户端 pin） =====

func ensureCert(certPath, keyPath string) (tls.Certificate, error) {
	if _, err := os.Stat(certPath); err == nil {
		if _, err2 := os.Stat(keyPath); err2 == nil {
			return tls.LoadX509KeyPair(certPath, keyPath)
		}
	}
	// 自动生成 ECDSA P-256 自签（10 年有效；客户端按 SHA256 指纹 pin，不依赖 CA 链）
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "im-gateway"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		return tls.Certificate{}, err
	}
	sum := sha256.Sum256(der)
	log.Printf("[cert] 已自动生成自签证书 %s（SHA256 指纹=%s，复制到 im-server 后台配置下发客户端）", certPath, hex.EncodeToString(sum[:]))
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ===== UDP 会话表 =====

type udpSession struct {
	id       uint32
	kC2G     cipher.AEAD // 客户端→网关
	kG2C     cipher.AEAD // 网关→客户端
	txCount  uint64      // 网关→客户端发送计数器（仅回包 goroutine 读写，无竞争）
	rxWindow uint64      // 接收滑动窗口基线（仅数据面读循环 goroutine 读写，无竞争）
	rxBitmap uint64      // 已收 counter 位图（相对基线 0..63）
	target   int
	client   atomic.Pointer[net.UDPAddr] // 最近数据包来源（回包目的地；数据面写/回包读，atomic 消除竞争）
	upstream *net.UDPConn                // 到 127.0.0.1:target 的回包通道（惰性建立）
	lastSeen atomic.Int64                // 最后活跃时刻（UnixNano；数据面/控制面写、清扫读，atomic）
}

type sessionTable struct {
	mu  sync.RWMutex
	m   map[uint32]*udpSession
	max int
}

func newSessionTable(max int) *sessionTable {
	return &sessionTable{m: map[uint32]*udpSession{}, max: max}
}

// listenRuntime 一组监听的运行时容器：各组独立白名单/会话表/UDP socket/TCP 连接计数
// （隔离性等同多实例；token 验签密钥与证书为全局共享）
type listenRuntime struct {
	cfg   *Config
	name  string
	allow atomic.Pointer[map[int]bool] // 白名单（后台热更归口：整表原子替换，转发读侧无锁）
	tbl   *sessionTable
	sock  *net.UDPConn // 该组 UDP 数据面 socket（回包经它发出，保证同一公网映射）
	conns int64        // 该组 TCP 透传连接数
	mu    sync.Mutex
}

// allowTarget 白名单命中判断（读侧无锁：atomic.Pointer 整表替换，热更不阻塞转发路径）
func (g *listenRuntime) allowTarget(port int) bool { return (*g.allow.Load())[port] }

// setAllow 白名单热更（Web 后台归口）：整表原子替换即时生效；落盘由调用方负责
func (g *listenRuntime) setAllow(m map[int]bool) { g.allow.Store(&m) }

func newListenRuntime(cfg *Config, g ListenGroup) *listenRuntime {
	allow := make(map[int]bool, len(g.AllowTargets))
	for _, p := range g.AllowTargets {
		allow[p] = true
	}
	rt := &listenRuntime{cfg: cfg, name: g.Name, tbl: newSessionTable(cfg.MaxUDPSessions)}
	rt.allow.Store(&allow)
	return rt
}

// randomID 纯随机生成（调用方持写锁后自行查重——本函数不得触碰 mu，防同 goroutine 写锁内 RLock 自死锁）
func (t *sessionTable) randomID() uint32 {
	for {
		var b [4]byte
		rand.Read(b[:])
		id := binary.BigEndian.Uint32(b[:])
		if id != 0 {
			return id
		}
	}
}

// rxCounterCheck 接收侧防重放：滑动窗口 64（返回 true=放行并记账）
func (s *udpSession) rxCounterCheck(counter uint64) bool {
	if counter < s.rxWindow {
		return false // 已滑出窗口（疑似重放）
	}
	shift := counter - s.rxWindow
	if shift >= 64 {
		s.rxWindow = counter // 大幅前跳：基线推进，窗口清空
		s.rxBitmap = 1
		return true
	}
	mask := uint64(1) << shift
	if s.rxBitmap&mask != 0 {
		return false // 窗口内重复（重放）
	}
	s.rxBitmap |= mask
	return true
}

func (s *udpSession) closeUpstream() {
	if s.upstream != nil {
		s.upstream.Close()
		s.upstream = nil
	}
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// ===== TLS 连接分流（TCP 数据连接 / UDP 控制连接共用同一 TLS 端口，按首帧 udp 字段路由） =====

func handleTLSConn(conn net.Conn, grp *listenRuntime) {
	remote := conn.RemoteAddr().String()
	// 首帧声明：限 512B / 5s（明文探测与慢速占位都在此被拒）
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReaderSize(conn, 4096)
	line, err := readLineLimit(reader, 512)
	if err != nil {
		if err == io.EOF {
			// EOF = 对端握手后未发首帧即主动关闭——指纹探测（im-server「从网关获取」）、
			// 端口扫描、健康检查的统一特征：连接无数据无风险，降噪为普通提示不记"失败"
			log.Printf("[conn][%s] %s 探测连接（TLS 握手后未发首帧即断开，正常）", grp.name, remote)
		} else {
			log.Printf("[conn][%s] %s 首帧读取失败: %v", grp.name, remote, err)
		}
		conn.Close()
		return
	}
	var req struct {
		Token  string `json:"token"`
		Target int    `json:"target"`
		UDP    bool   `json:"udp"`
	}
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		log.Printf("[conn][%s] %s 首帧 JSON 解析失败（疑似非客户端探测）", grp.name, remote)
		conn.Close()
		return
	}
	if req.UDP {
		handleUDPControl(conn, grp, req) // 分流：UDP 会话注册/保活连接（控制面）
		return
	}
	handleTCPData(conn, grp, req, reader) // TCP 数据面透传
}

func handleTCPData(conn net.Conn, grp *listenRuntime, req struct {
	Token  string `json:"token"`
	Target int    `json:"target"`
	UDP    bool   `json:"udp"`
}, reader *bufio.Reader) {
	defer func() {
		grp.mu.Lock()
		grp.conns--
		grp.mu.Unlock()
		conn.Close()
	}()
	remote := conn.RemoteAddr().String()
	user, terr := verifyToken(grp.cfg.TokenSecret, req.Token)
	if terr != nil {
		log.Printf("[tcp][%s] %s token 拒绝: %v", grp.name, remote, terr)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "auth"})
		return
	}
	if !grp.allowTarget(req.Target) {
		log.Printf("[tcp][%s] %s 目标端口 %d 不在本组白名单（用户=%s）", grp.name, remote, req.Target, user)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "target"})
		return
	}
	upstream, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(req.Target), 3*time.Second)
	if err != nil {
		log.Printf("[tcp] %s 连接 127.0.0.1:%d 失败（用户=%s）: %v", remote, req.Target, user, err)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "down"})
		return
	}
	defer upstream.Close()
	if err := writeJSONLine(conn, map[string]interface{}{"ok": true}); err != nil {
		return
	}
	conn.SetDeadline(time.Time{}) // 透传期撤销首帧超时（长连接不限时）
	log.Printf("[tcp][%s] 会话建立 用户=%s 目标=127.0.0.1:%d 来源=%s", grp.name, user, req.Target, remote)
	done := make(chan struct{}, 2)
	// 首帧后的字节可能已进 bufio 缓冲：MultiReader 先接续缓冲再回归裸 conn，防丢首帧尾随数据
	go func() { io.Copy(upstream, io.MultiReader(reader, conn)); done <- struct{}{} }()
	go func() { io.Copy(conn, upstream); done <- struct{}{} }()
	<-done // 任一方向结束即收口（defer 双向关闭解除另一方向）
	log.Printf("[tcp][%s] 会话结束 用户=%s 目标=127.0.0.1:%d", grp.name, user, req.Target)
}

func readLineLimit(r *bufio.Reader, limit int) (string, error) {
	var b strings.Builder
	for {
		chunk, err := r.ReadString('\n')
		b.WriteString(chunk)
		if b.Len() > limit {
			return "", errors.New("首帧超长")
		}
		if err != nil {
			if err == io.EOF && strings.HasSuffix(b.String(), "\n") {
				return strings.TrimRight(b.String(), "\n"), nil
			}
			return "", err
		}
		return strings.TrimRight(b.String(), "\r\n"), nil
	}
}

func writeJSONLine(w io.Writer, v interface{}) error {
	b, _ := json.Marshal(v)
	b = append(b, '\n')
	_, err := w.Write(b)
	return err
}

// ===== UDP 控制连接（会话注册与保活；首帧已由分流层解析） =====

func handleUDPControl(conn net.Conn, grp *listenRuntime, req struct {
	Token  string `json:"token"`
	Target int    `json:"target"`
	UDP    bool   `json:"udp"`
}) {
	defer conn.Close()
	remote := conn.RemoteAddr().String()
	conn.SetDeadline(time.Time{}) // 撤销分流层 5s 首帧 deadline：控制连接长驻（90s 空闲由清扫归口）
	tbl := grp.tbl
	user, terr := verifyToken(grp.cfg.TokenSecret, req.Token)
	if terr != nil {
		log.Printf("[udp-ctl][%s] %s token 拒绝: %v", grp.name, remote, terr)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "auth"})
		return
	}
	if !grp.allowTarget(req.Target) {
		log.Printf("[udp-ctl][%s] %s 目标端口 %d 不在本组白名单（用户=%s）", grp.name, remote, req.Target, user)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "target"})
		return
	}
	tbl.mu.Lock()
	if len(tbl.m) >= tbl.max {
		tbl.mu.Unlock()
		log.Printf("[udp-ctl][%s] %s 会话数已达上限 %d（用户=%s）", grp.name, remote, tbl.max, user)
		writeJSONLine(conn, map[string]interface{}{"ok": false, "err": "limit"})
		return
	}
	var id uint32
	for { // 写锁内查重（randomID 已去锁）
		id = tbl.randomID()
		if _, exists := tbl.m[id]; !exists {
			break
		}
	}
	sess := &udpSession{id: id, target: req.Target}
	sess.lastSeen.Store(time.Now().UnixNano())
	var keyC2G, keyG2C [32]byte
	rand.Read(keyC2G[:])
	rand.Read(keyG2C[:])
	var err error
	if sess.kC2G, err = newAEAD(keyC2G[:]); err != nil {
		tbl.mu.Unlock()
		log.Printf("[udp-ctl] AEAD 初始化失败: %v", err)
		return
	}
	if sess.kG2C, err = newAEAD(keyG2C[:]); err != nil {
		tbl.mu.Unlock()
		log.Printf("[udp-ctl] AEAD 初始化失败: %v", err)
		return
	}
	tbl.m[id] = sess
	tbl.mu.Unlock()
	writeJSONLine(conn, map[string]interface{}{
		"ok":      true,
		"session": fmt.Sprintf("%08x", id),
		"k1":      base64.StdEncoding.EncodeToString(keyC2G[:]),
		"k2":      base64.StdEncoding.EncodeToString(keyG2C[:]),
	})
	log.Printf("[udp-ctl][%s] 会话注册 用户=%s 目标=127.0.0.1:%d 会话=%08x 来源=%s", grp.name, user, req.Target, id, remote)

	// 保活读循环：任意帧仅刷新存活（空行保活即可）；连接断开（PC 退出/崩溃）→ 会话立即失效
	buf := make([]byte, 512)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			break
		}
		if n > 0 {
			sess.lastSeen.Store(time.Now().UnixNano())
		}
	}
	tbl.mu.Lock()
	if tbl.m[id] == sess {
		sess.closeUpstream()
		delete(tbl.m, id)
	}
	tbl.mu.Unlock()
	log.Printf("[udp-ctl][%s] 控制连接断开，会话 %08x 回收（用户=%s）", grp.name, id, user)
}

// ===== UDP 数据面（逐包 AEAD 透传；按监听组隔离） =====

func handleUDPData(grp *listenRuntime) {
	sock := grp.sock
	tbl := grp.tbl
	buf := make([]byte, udpHeadLen+udpTagLen+udpMaxPayload)
	for {
		n, addr, err := sock.ReadFromUDP(buf)
		if err != nil {
			return
		}
		// 结构过滤：长度不符 → 静默丢弃（不回包不记日志，不向探测者泄漏任何处理痕迹）
		if n < udpHeadLen+udpTagLen || n > udpHeadLen+udpTagLen+udpMaxPayload {
			continue
		}
		head := make([]byte, udpHeadLen)
		copy(head, buf[:udpHeadLen])
		id := binary.BigEndian.Uint32(head[0:4])
		tbl.mu.RLock()
		sess := tbl.m[id]
		tbl.mu.RUnlock()
		if sess == nil {
			continue // 未知会话：静默丢弃
		}
		// 解密校验：nonce = "C2G0" + counter（12B 标准），AAD = 12B 明文头；tag 不符 → 伪造/篡改 → 丢
		nonce := make([]byte, 12)
		copy(nonce[0:4], noncePrefixC2G)
		copy(nonce[4:12], head[4:12])
		plain, err := sess.kC2G.Open(nil, nonce, buf[udpHeadLen:n], head)
		if err != nil {
			continue
		}
		// 防重放：counter 滑动窗口 64
		counter := binary.BigEndian.Uint64(head[4:12])
		if !sess.rxCounterCheck(counter) {
			continue
		}
		sess.lastSeen.Store(time.Now().UnixNano())
		sess.client.Store(addr) // 回包目的地（允许 NAT 地址漂移，取最近来源）
		// 惰性建立到真实服务端的收发通道
		if sess.upstream == nil {
			up, derr := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: sess.target})
			if derr != nil {
				log.Printf("[udp] 会话 %08x 回包通道建立失败: %v", id, derr)
				continue
			}
			sess.upstream = up
			go udpUpstreamReader(grp, up, sess, id)
		}
		if _, err := sess.upstream.Write(plain); err != nil {
			continue
		}
	}
}

// udpUpstreamReader 真实服务端回包 → k2 加密 → 经本组主 UDP socket（同一公网映射）回投客户端
func udpUpstreamReader(grp *listenRuntime, up *net.UDPConn, sess *udpSession, id uint32) {
	defer func() {
		sess.closeUpstream()
		grp.tbl.mu.Lock()
		delete(grp.tbl.m, id)
		grp.tbl.mu.Unlock()
		up.Close()
	}()
	buf := make([]byte, udpMaxPayload)
	for {
		n, err := up.Read(buf)
		if err != nil {
			return
		}
		// 会话仍存活才回包（控制连接断开/超时回收后静默终止）
		if !sessionAlive(grp, id, sess) {
			return
		}
		sess.txCount++
		var counter [8]byte
		binary.BigEndian.PutUint64(counter[:], sess.txCount)
		nonce := make([]byte, 12)
		copy(nonce[0:4], noncePrefixG2C)
		copy(nonce[4:12], counter[:])
		head := make([]byte, udpHeadLen)
		binary.BigEndian.PutUint32(head[0:4], id)
		copy(head[4:12], counter[:])
		sealed := sess.kG2C.Seal(nil, nonce, buf[:n], head)
		out := append(head, sealed...)
		if dst := sess.client.Load(); dst != nil { // 回包经本组主 UDP socket（同一公网映射）发出
			grp.sock.WriteToUDP(out, dst)
		}
	}
}

// 会话存活检查（回包路径终止判断；tbl 随监听组隔离）
func sessionAlive(grp *listenRuntime, id uint32, sess *udpSession) bool {
	grp.tbl.mu.RLock()
	defer grp.tbl.mu.RUnlock()
	return grp.tbl.m[id] == sess
}

// ===== 会话惰性回收（90s 无任何流量的兜底；正常由控制连接断开归口） =====

func sweepSessions(grp *listenRuntime) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		grp.tbl.mu.Lock()
		var dead []uint32
		for id, s := range grp.tbl.m {
			if time.Since(time.Unix(0, s.lastSeen.Load())) > udpCtlIdleSec*time.Second {
				dead = append(dead, id)
			}
		}
		for _, id := range dead {
			grp.tbl.m[id].closeUpstream()
			delete(grp.tbl.m, id)
		}
		grp.tbl.mu.Unlock()
		if len(dead) > 0 {
			log.Printf("[udp][%s] 惰性回收超时会话 %d 个", grp.name, len(dead))
		}
	}
}

// ===== 入口 =====

func main() {
	cfgPath := "gateway.yaml"
	if len(os.Args) > 1 {
		cfgPath = os.Args[1]
	}
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		log.Fatalf("[启动] 读取配置失败: %v", err)
	}
	cfg := &Config{}
	if err := yaml.Unmarshal(b, cfg); err != nil {
		log.Fatalf("[启动] 解析配置失败: %v", err)
	}
	if err := cfg.normalize(); err != nil {
		log.Fatalf("[启动] %v", err)
	}
	cert, err := ensureCert(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		log.Fatalf("[启动] 证书准备失败: %v", err)
	}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13, // 仅 TLS 1.3：明文/老协议握手一律失败断开
	}

	// 多监听组逐组启动：每组独立 TLS 监听 + UDP socket + 会话表 + 白名单（隔离性等同多实例）
	var runtimes []*listenRuntime // 运行时收集（Web 后台状态读取/白名单热更归口）
	for i := range cfg.Listens {
		grp := newListenRuntime(cfg, cfg.Listens[i])
		// TCP 监听：TLS accept（明文扫描在握手层被拒）→ 首帧声明 → 校验 → 127.0.0.1 透传
		ln, err := tls.Listen("tcp", grp.cfg.Listens[i].ListenTCP, tlsCfg)
		if err != nil {
			log.Fatalf("[启动][%s] TCP 监听失败: %v", grp.name, err)
		}
		// UDP 监听：逐包 AEAD 校验解密（非法包静默丢弃）
		udpAddr, err := net.ResolveUDPAddr("udp", grp.cfg.Listens[i].ListenUDP)
		if err != nil {
			log.Fatalf("[启动][%s] UDP 地址解析失败: %v", grp.name, err)
		}
		sock, err := net.ListenUDP("udp", udpAddr)
		if err != nil {
			log.Fatalf("[启动][%s] UDP 监听失败: %v", grp.name, err)
		}
		grp.sock = sock
		log.Printf("[启动][%s] 组就绪 TCP=%s UDP=%s 白名单端口=%v", grp.name,
			grp.cfg.Listens[i].ListenTCP, grp.cfg.Listens[i].ListenUDP, grp.cfg.Listens[i].AllowTargets)
		go func(grp *listenRuntime, ln net.Listener) {
			for {
				conn, err := ln.Accept()
				if err != nil {
					log.Printf("[tcp][%s] Accept 异常: %v", grp.name, err)
					continue
				}
				grp.mu.Lock()
				grp.conns++
				over := grp.conns > int64(grp.cfg.MaxTCPConns)
				grp.mu.Unlock()
				if over {
					conn.Close()
					log.Printf("[tcp][%s] 连接数超上限 %d，拒绝 %s", grp.name, grp.cfg.MaxTCPConns, conn.RemoteAddr())
					continue
				}
				go handleTLSConn(conn, grp)
			}
		}(grp, ln)
		go handleUDPData(grp)
		go sweepSessions(grp)
		runtimes = append(runtimes, grp)
	}

	// Web 管理后台（可选：admin_listen/admin_password 齐备才启动；默认仅绑 127.0.0.1，见 admin.go）
	if strings.TrimSpace(cfg.AdminListen) != "" && cfg.AdminPassword != "" {
		startAdmin(cfg, cfgPath, runtimes)
	} else {
		log.Printf("[admin] 未配置 admin_listen/admin_password，Web 后台不启动")
	}
	// 游戏账号写库拉取器（可选：dbwrite.enabled 才启动；配置/模板非法仅记日志不启动，隧道不受影响）
	startDbwrite(cfg)

	select {} // 常驻
}
