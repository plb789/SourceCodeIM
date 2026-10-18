// vipip.go —— 虚拟 IP 池 DB 归口（联机虚拟网卡路线，设计文档 docs/虚拟IP池设计方案.md）
// 职责：① 配置合法性校验（网段/起止/网关，非法即启动失败退出——联机是核心依赖，半死池不如明确报错）
//
//	② 建表 + 建池（幂等：首启批量生成全量 IP 行，非零行数跳过——手工删行=明确不想分配，不补）
//	③ 全量加载入内存种子（VipPoolSeed，server 层 newVipPool 消费；运行期不再读库）
//
// 运行态以内存为权威：分配/释放不实时写库（重启后在线用户必然掉线重连，写库换不来可用语义），
// Username/AllocAt 仅作最近一次使用的历史参考列
package store

import (
	"fmt"
	"net"
	"strings"

	"im-server/config"
	"im-server/logger"
	"im-server/model"
)

// VipPoolSeed 启动加载的池种子（server.newVipPool 消费；Enabled=false 时不填充不使用）
type VipPoolSeed struct {
	IPs        []string          // 全量池 IP（升序，点分十进制）
	Reserved   map[string]bool   // status=1 预留集合（不入空闲栈）
	Bindings   map[string]string // username → ip（status=1 且 username 非空的静态绑定，登录优先分配）
	Base       uint32            // 分配池起始 IP 的 uint32（如 10.28.1.1）
	Size       int               // 分配池容量（含预留——预留位在 free 栈构建时跳过）
	Gateway    string
	Mask       string
	Supernodes []string
}

// VipPool 启动加载后的池种子包级归口（InitVipPool 成功后非 nil；nil=功能旁路，server.newVipPool 判定）
var VipPool *VipPoolSeed

// InitVipPool 虚拟 IP 池初始化归口（main.go 在 InitMySQL/InitRedis 之后调用；失败即退出）
// enabled=false 时直接返回零值种子（全链路旁路：不建表不加载，§9.7）
func InitVipPool(cfg *config.Config) (*VipPoolSeed, error) {
	if !cfg.VipPool.Enabled {
		return nil, nil
	}
	// 集群模式强制旁路（设计 §9.4）：内存态分配跨实例必冲突，Redis 原子分配为后续演进
	if cfg.ClusterEnabled {
		logger.Warn("虚拟IP池与集群模式互斥（cluster_enabled=true），本功能已旁路；如需启用请关闭集群或等待 Redis 原子分配演进")
		return nil, nil
	}
	seed, err := vipPoolValidate(cfg)
	if err != nil {
		return nil, err
	}
	// 建表（单表，失败即退出）
	if err := DB.AutoMigrate(&model.VipIP{}); err != nil {
		return nil, fmt.Errorf("虚拟IP池建表失败: %w", err)
	}
	// 建池幂等：行数为 0 批量生成；非 0 跳过（不补手工删行，语义见文件头）
	var cnt int64
	if err := DB.Model(&model.VipIP{}).Count(&cnt).Error; err != nil {
		return nil, fmt.Errorf("虚拟IP池计数失败: %w", err)
	}
	if cnt == 0 {
		batch := make([]model.VipIP, 0, seed.Size)
		for off := 0; off < seed.Size; off++ {
			batch = append(batch, model.VipIP{IP: vipOffsetToIP(seed.Base, off)})
		}
		// 分片提交（每片 5000 行），避免 6.5 万行单事务过长
		for i := 0; i < len(batch); i += 5000 {
			end := i + 5000
			if end > len(batch) {
				end = len(batch)
			}
			if err := DB.CreateInBatches(batch[i:end], 5000).Error; err != nil {
				return nil, fmt.Errorf("虚拟IP池生成失败: %w", err)
			}
		}
		logger.Info("虚拟IP池已生成: %d 个地址（%s ~ %s）", len(batch),
			vipOffsetToIP(seed.Base, 0), vipOffsetToIP(seed.Base, seed.Size-1))
	}
	// 全量加载（含 status，server 层据此构建空闲栈）
	var rows []model.VipIP
	if err := DB.Order("ip ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("虚拟IP池加载失败: %w", err)
	}
	seed.IPs = make([]string, 0, len(rows))
	seed.Reserved = map[string]bool{}
	seed.Bindings = map[string]string{}
	for _, r := range rows {
		seed.IPs = append(seed.IPs, r.IP)
		if r.Status == 1 {
			seed.Reserved[r.IP] = true
			// 静态绑定（admin 后台绑定用户，设计 §8.4）：status=1 且 username 非空 → 登录优先分配该 IP
			if r.Username != "" {
				seed.Bindings[r.Username] = r.IP
			}
		}
	}
	logger.Info("虚拟IP池就绪: 总 %d 预留 %d 静态绑定 %d（网关 %s 掩码 %s）",
		len(seed.IPs), len(seed.Reserved), len(seed.Bindings), seed.Gateway, seed.Mask)
	VipPool = seed
	return seed, nil
}

// vipPoolValidate 配置校验与种子解析：网段/起止/网关合法性，非法返回错误（启动即退出）
func vipPoolValidate(cfg *config.Config) (*VipPoolSeed, error) {
	v := cfg.VipPool
	start, err := vipParseIP(v.RangeStart)
	if err != nil {
		return nil, fmt.Errorf("虚拟IP池 range_start 非法: %w", err)
	}
	end, err := vipParseIP(v.RangeEnd)
	if err != nil {
		return nil, fmt.Errorf("虚拟IP池 range_end 非法: %w", err)
	}
	gw, err := vipParseIP(v.Gateway)
	if err != nil {
		return nil, fmt.Errorf("虚拟IP池 gateway 非法: %w", err)
	}
	if end < start {
		return nil, fmt.Errorf("虚拟IP池 range_end(%s) 不得小于 range_start(%s)", v.RangeEnd, v.RangeStart)
	}
	// 网段一致性：起止与网关必须同处 Segment 网段内（防配置拼错网段导致跨段分配）
	if _, ipnet, err := net.ParseCIDR(v.Segment); err != nil {
		return nil, fmt.Errorf("虚拟IP池 segment 非法（须为 CIDR 如 10.28.0.0/16）: %w", err)
	} else {
		ones, _ := ipnet.Mask.Size()
		mask := uint32(0xFFFFFFFF) << uint(32-ones)
		base := ipToU32(ipnet.IP)
		for _, ip := range []uint32{start, end, gw} {
			if ip&mask != base {
				return nil, fmt.Errorf("虚拟IP池配置越段: %s 不在 %s 内", u32ToIP(ip), v.Segment)
			}
		}
	}
	// 网关不得落在分配区间内（网关地址自身被分配出去会导致组网冲突）
	if gw >= start && gw <= end {
		return nil, fmt.Errorf("虚拟IP池 gateway(%s) 不得落在分配区间 [%s, %s] 内", v.Gateway, v.RangeStart, v.RangeEnd)
	}
	// supernodes 去重去空归一（admin 候选列表与登录回执下发同源）
	sns := make([]string, 0, len(v.Supernodes))
	seen := map[string]bool{}
	for _, s := range v.Supernodes {
		if s = strings.TrimSpace(s); s == "" || seen[s] {
			continue
		}
		seen[s] = true
		sns = append(sns, s)
	}
	return &VipPoolSeed{
		Base:       start,
		Size:       int(end-start) + 1,
		Gateway:    v.Gateway,
		Mask:       v.Mask,
		Supernodes: sns,
	}, nil
}

// ipToU32/vipParseIP/u32ToIP/vipOffsetToIP/trimSpace —— 小工具归口（避免引入多余依赖）

func ipToU32(ip net.IP) uint32 {
	v4 := ip.To4()
	if v4 == nil {
		return 0
	}
	return uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3])
}

func vipParseIP(s string) (uint32, error) {
	ip := net.ParseIP(s)
	if ip == nil || ip.To4() == nil {
		return 0, fmt.Errorf("非合法 IPv4 地址: %q", s)
	}
	return ipToU32(ip), nil
}

func u32ToIP(v uint32) string {
	return net.IPv4(byte(v>>24), byte(v>>16), byte(v>>8), byte(v)).String()
}

// vipOffsetToIP 池内偏移 → 点分十进制（base + off）
func vipOffsetToIP(base uint32, off int) string {
	return u32ToIP(base + uint32(off))
}
