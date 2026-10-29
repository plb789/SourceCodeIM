package server

// ===== IP 属地显示（ip2region 离线解析，微信同款资料卡「IP属地」标签）=====
// 设计文档：docs/IP属地显示设计方案.md。归口原则：
//   1. 解析归口服务端：客户端拿不到他人 IP，属地必须由服务端解析后下发
//   2. 下发只含解析结果不含 IP 明文：PROFILE_RESP 报文只有 ip_region 属地文本
//   3. 离线零交互：xdb 数据文件随 bin/data 分发，运行期与外部网络零交互
//   4. 降级静默：未启用/文件缺失/损坏/查询失败一律返回空串，前端整行隐藏，不影响其他功能
//   5. 显示口径单一归口：国内取省级、海外取国家级、内网直连显示「内网」
// IPv6 双栈：v4/v6 数据文件独立加载互不拖累——某一栈文件缺失仅该栈属地降级为空；
// 按 ParseIP 字节长度路由到对应 searcher（v2 binding 实测：跨栈查询返回 error，此处提前分流避免无效锁竞争）

import (
	"net"
	"strings"
	"sync"

	"im-server/config"
	"im-server/logger"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

var (
	// 官方 searcher 明确非线程安全（Search 内部重置 ioCount 计数），全局单实例 + 互斥串行化。
	// 资料查询为低频操作（打开资料卡触发），单次查询微秒级，串行化无性能影响；
	// 双栈共用同一把锁（两栈查询天然互斥，粒度换简单）
	ipRegionMu sync.Mutex
	ipRegionV4 *xdb.Searcher
	ipRegionV6 *xdb.Searcher
)

// loadIPRegionStack 加载单栈数据文件（全文件缓存模式，查询纯内存无 IO）。
// 返回 nil 表示该栈不可用（加载失败仅禁用该栈，不 panic 不阻塞启动）
func loadIPRegionStack(path, name string) *xdb.Searcher {
	cBuff, err := xdb.LoadContentFromFile(path)
	if err != nil {
		logger.Error("IP 属地 %s 数据文件加载失败（%s）：%v——该栈降级关闭", name, path, err)
		return nil
	}
	// 从文件头自动识别数据版本（防御性校验：防止 v4/v6 文件放反位置）
	header, err := xdb.LoadHeaderFromBuff(cBuff)
	if err != nil {
		logger.Error("IP 属地 %s 数据文件头解析失败（%s）：%v——该栈降级关闭", name, path, err)
		return nil
	}
	version, err := xdb.VersionFromHeader(header)
	if err != nil {
		logger.Error("IP 属地 %s 数据版本识别失败（%s）：%v——该栈降级关闭", name, path, err)
		return nil
	}
	searcher, err := xdb.NewWithBuffer(version, cBuff)
	if err != nil {
		logger.Error("IP 属地 %s 查询器构建失败（%s）：%v——该栈降级关闭", name, path, err)
		return nil
	}
	logger.Info("IP 属地 %s 数据加载完成：%s（%s，%.1fMB）", name, path, version.Name, float64(len(cBuff))/1024/1024)
	return searcher
}

// initIPRegion 启动时加载 IPv4/IPv6 双栈数据文件。
// 任何一栈失败只记日志并禁用该栈（降级关闭），不阻塞服务启动——对齐 amap_key 留空的降级惯例
func initIPRegion(cfg *config.IPRegionConfig) {
	if !cfg.Enabled {
		logger.Info("IP 属地显示未启用（ip_region.enabled=false），功能旁路")
		return
	}
	ipRegionV4 = loadIPRegionStack(cfg.XdbPathV4, "IPv4")
	ipRegionV6 = loadIPRegionStack(cfg.XdbPathV6, "IPv6")
}

// ipRegionEnabled 功能是否可用（至少一个栈的数据文件加载成功才可用；不可用时属地恒空串）
func ipRegionEnabled() bool {
	return ipRegionV4 != nil || ipRegionV6 != nil
}

// ipRegion IP 归属地归口查询：返回属地（国内省份/海外国家），
// 内网/保留地址返回「内网」；未启用/对应栈未加载/查询失败返回空串（前端整行隐藏）
func ipRegion(ip string) string {
	if ip == "" {
		return ""
	}
	// 内网/回环/链路本地（v4 私网段与 ::1/fe80:: 等）：xdb 数据不覆盖，显式归口「内网」（设计口径 §一）
	if isPrivateIP(ip) {
		return "内网"
	}
	// 按解析后字节长度路由双栈（net.IP.To4 非空=IPv4 或 IPv4 映射地址，否则按 IPv6 处理）
	parsed := net.ParseIP(ip)
	var s *xdb.Searcher
	if parsed == nil {
		return "" // 非法 IP 串（XFF 伪造等）：两层 ParseIP 防线第一层，直接空串
	}
	if parsed.To4() != nil {
		s = ipRegionV4
	} else {
		s = ipRegionV6
	}
	if s == nil {
		return "" // 对应栈数据未加载（文件缺失/损坏）：该栈降级
	}
	ipRegionMu.Lock()
	defer ipRegionMu.Unlock()
	region, err := s.Search(ip)
	if err != nil {
		// 查询异常（数据段缺失等）：静默降级返回空串
		return ""
	}
	return displayRegion(region)
}

// isPrivateIP 判断是否内网/回环/链路本地/未指定地址（127.0.0.1、192.168.x.x、::1、fe80:: 等）
func isPrivateIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

// displayRegion 解析 xdb region 串 → 显示口径（国内省-市两级，海外国家级）：
//   数据段序自适应（2026-10 实测两种格式并存，禁止按记忆猜测）：
//     3.x 新格式：国家|省份|城市|ISP|国家码，如 "中国|江苏省|南京市|0|CN"（尾段两位大写国家码为特征）
//     2.x 旧格式：国家|区域|省份|城市|ISP，如 "中国|0|广东省|深圳市|电信"（区域段为 0 或大区）
//   国内：显示「省-市」（如 山西省-太原市），直辖市/省同市去重（北京市-北京市 → 北京市），市缺失仅显示省
//   海外：仅显示国家段
//   内网（xdb 返回含 "内网IP" 的串）：返回「内网」（防御性兜底，正常已被 isPrivateIP 拦截）
//   任一段为 "0" 视为空；解析不出有效属地返回空串（前端整行隐藏）
//   注：免费版数据不含县级（第四段为运营商非区县），区县级显示需更换数据源另案评估
func displayRegion(region string) string {
	parts := strings.Split(region, "|")
	for i := range parts {
		if parts[i] == "0" {
			parts[i] = ""
		}
	}
	if len(parts) > 3 && parts[3] == "内网IP" {
		return "内网"
	}
	if len(parts) == 0 || parts[0] == "" {
		return ""
	}
	if parts[0] != "中国" {
		return parts[0] // 海外仅国家
	}
	// 国内：按尾段特征自适应两种段序取省/市
	var prov, city string
	if len(parts) >= 5 && isCountryCode(parts[4]) {
		// 3.x 新格式：国家|省份|城市|ISP|国家码
		prov, city = parts[1], parts[2]
	} else {
		// 2.x 旧格式：国家|区域|省份|城市|ISP
		if len(parts) > 2 {
			prov = parts[2]
		}
		if len(parts) > 3 {
			city = parts[3]
		}
	}
	if prov == "" {
		return ""
	}
	if city == "" || city == prov {
		return prov // 市缺失或直辖市/省同市去重
	}
	return prov + "-" + city
}

// isCountryCode 两位大写 ASCII 国家码判别（CN/US/JP 等，ISO 3166-1 alpha-2；
// 用于区分 3.x 新数据与 2.x 旧数据的尾段特征，中文 ISP 段不会命中）
func isCountryCode(s string) bool {
	if len(s) != 2 {
		return false
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// onlineIPOf 取目标用户任一在线连接的真实 IP（多端取任一即可，属地粒度为省）；
// 不在线返回空串。集群模式目标连接在其他实例时同样返回空（一期接受该降级，见设计文档 §4.4）
func (s *Server) onlineIPOf(username string) string {
	s.hub.mu.RLock()
	defer s.hub.mu.RUnlock()
	for c := range s.hub.clients[username] {
		return c.ip
	}
	return ""
}
