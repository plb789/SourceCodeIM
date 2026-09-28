package store

// ===== DCDN 远程鉴权票据管理器（阶段一百九十七） =====
// 背景：MinIO 预签名直连下载（serveDriveFile 302）的 URL 在有效期内是裸凭证，拿到链接者
// 可在窗口内绕过分享页反复直连、转发他人，分享取消/提取码均无法即时收回。
// 方案：阿里云 DCDN 远程鉴权——minio 外网域名接入 DCDN 后，边缘节点把每个文件请求转发本服务
// GET /auth 校验（官方转发格式：鉴权地址+原始 query 参数，不含原路径——objectKey 交叉比对
// 不可行，由 MinIO 签名层独立挡 URL 篡改，双层防线）。本服务签发预签名 URL 时同步签发
// auth_ticket 并纳入 MinIO 签名（回源带参/剥参都兼容——若仅 URL 追加不参与签名，DCDN 回源
// 携带该参数会 SignatureDoesNotMatch），/auth 凭票据放行：存在+未过期即 200（滑动续期），
// 否则 403；分享取消时按 objectKey 即时吊销。
//
// 并发模型：sync.Map 读多写少（签发在 Presign 热路径、吊销低频全扫）；过期惰性删除 +
// 后台周期清扫防泄漏。票据为 crypto/rand 128bit 十六进制（32 字符），不可枚举伪造。

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"
)

// DriveTicketParam 预签名 URL 上的票据参数名（纳入 MinIO 签名，客户端篡改即签名失败）
const DriveTicketParam = "auth_ticket"

// driveTicketEntry 票据条目（objectKey 供按对象吊销；expire 为滑动续期到期时刻）
// expire 用 atomic int64（UnixNano）：Verify 滑动续期写与清扫协程/并发校验读并存，
// time.Time 多字结构直接读写会撕裂（go race 必报），atomic 免锁且热路径零开销
type driveTicketEntry struct {
	key    string
	expire int64
}

var (
	driveTickets     sync.Map // ticket(string) -> *driveTicketEntry
	driveTicketOn    bool     // edge_auth.enabled（DriveTicketInit 设初值，DriveTicketSetEnabled 热更；driveTicketMu 保护）
	driveTicketTTL   time.Duration
	driveTicketMu    sync.Mutex // 保护 on/TTL（启动 Init 一次性写入，后台热更可变）
	driveTicketSweep sync.Once
)

// DriveTicketInit 远程鉴权票据初始化（main.go 启动归口调用，config 驱动；DB 后台覆盖值由
// server 层 edgeauth.go edgeAuthSettingsInit 读取后改调 SetEnabled/SetTTL 应用，本函数只吃 yaml 默认）
func DriveTicketInit(enabled bool, ttlSeconds int) {
	driveTicketMu.Lock()
	driveTicketOn = enabled
	driveTicketTTL = time.Duration(ttlSeconds) * time.Second
	if driveTicketTTL <= 0 {
		driveTicketTTL = 1800 * time.Second // 缺省与 Presign 30min 对齐（config 注释同口径）
	}
	driveTicketMu.Unlock()
	if enabled {
		// 后台清扫协程（进程级一次）：周期删除过期项防 map 无限膨胀
		driveTicketSweep.Do(func() {
			go func() {
				for range time.Tick(5 * time.Minute) {
					driveTicketSweepExpired()
				}
			}()
		})
	}
}

// DriveTicketsEnabled 远程鉴权是否启用（Presign 签发与 /auth 行为归口判断）
func DriveTicketsEnabled() bool {
	driveTicketMu.Lock()
	defer driveTicketMu.Unlock()
	return driveTicketOn
}

// DriveTicketSetEnabled 后台热更启用开关：关闭时清空全部在期票据（已签发 URL 的鉴权层立即失效，
// DCDN 转发 /auth 由 handler 内开关判断返回 404 → 边缘拒绝），返回清空条数
func DriveTicketSetEnabled(on bool) int {
	driveTicketMu.Lock()
	driveTicketOn = on
	driveTicketMu.Unlock()
	if on {
		driveTicketSweep.Do(func() { // 热开启时确保清扫协程在跑（进程级一次，幂等）
			go func() {
				for range time.Tick(5 * time.Minute) {
					driveTicketSweepExpired()
				}
			}()
		})
		return 0
	}
	n := 0
	driveTickets.Range(func(k, _ any) bool {
		driveTickets.Delete(k)
		n++
		return true
	})
	return n
}

// DriveTicketSetTTL 后台热更票据滑动有效期（秒；<=0 回落 1800 与预签名 30min 对齐）。
// 对已在期票据：下次校验滑动续期即按新 TTL 延展，自然收敛无需清空
func DriveTicketSetTTL(seconds int) {
	if seconds <= 0 {
		seconds = 1800
	}
	driveTicketMu.Lock()
	driveTicketTTL = time.Duration(seconds) * time.Second
	driveTicketMu.Unlock()
}

// DriveTicketTTL 票据滑动有效期（启动日志展示用）
func DriveTicketTTL() time.Duration {
	driveTicketMu.Lock()
	defer driveTicketMu.Unlock()
	return driveTicketTTL
}

// DriveTicketIssue 签发票据并记录 objectKey 关联（minioStore.Presign 内部调用；
// 与 Verify/RevokeKey 对称的管理器公共 API——未启用时返回空串由调用方跳过附加）
func DriveTicketIssue(objectKey string) string {
	driveTicketMu.Lock()
	on, ttl := driveTicketOn, driveTicketTTL
	driveTicketMu.Unlock()
	if !on {
		return ""
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "" // 系统熵源异常（实际不发生）：失败则不附票，Presign 原 URL 仍可用（无鉴权层保护但不破坏链路）
	}
	t := hex.EncodeToString(b)
	driveTickets.Store(t, &driveTicketEntry{key: objectKey, expire: time.Now().Add(ttl).UnixNano()})
	return t
}

// DriveTicketVerify 校验票据（/auth 归口）：存在且未过期 → 滑动续期返回 true；
// 不存在/已过期 → 惰性删除返回 false
func DriveTicketVerify(ticket string) bool {
	if ticket == "" {
		return false
	}
	v, ok := driveTickets.Load(ticket)
	if !ok {
		return false
	}
	e := v.(*driveTicketEntry)
	now := time.Now()
	if now.UnixNano() > atomic.LoadInt64(&e.expire) {
		driveTickets.Delete(ticket)
		return false
	}
	atomic.StoreInt64(&e.expire, now.Add(func() time.Duration { // 滑动续期：支持视频 Range 多段请求（TTL 可后台热更，锁内取当前值）
		driveTicketMu.Lock()
		defer driveTicketMu.Unlock()
		return driveTicketTTL
	}()).UnixNano())
	return true
}

// DriveTicketRevokeKey 按对象吊销全部票据（分享取消/管理端批量取消归口调用），返回吊销条数。
// 同对象可能存在本人网盘下载与多分享引用的活跃票据，按 key 粒度吊销会一并失效——
// 受影响用户重新点下载即由 im-server 签发新票，影响可忽略
func DriveTicketRevokeKey(objectKey string) int {
	if objectKey == "" {
		return 0
	}
	n := 0
	driveTickets.Range(func(k, v any) bool {
		if v.(*driveTicketEntry).key == objectKey {
			driveTickets.Delete(k)
			n++
		}
		return true
	})
	return n
}

// driveTicketSweepExpired 全量清扫过期票据（后台协程周期调用）
func driveTicketSweepExpired() {
	now := time.Now().UnixNano()
	driveTickets.Range(func(k, v any) bool {
		if now > atomic.LoadInt64(&v.(*driveTicketEntry).expire) {
			driveTickets.Delete(k)
		}
		return true
	})
}
