package server

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"
)

// ===== ClamAV 病毒扫描（安全加固·恶意软件分发防护） =====
// 商户游戏包天然允许 .exe（分发通道），病毒包会经版本下载下发到玩家机器。本模块经 clamd
// INSTREAM 协议对商户上架的版本文件做流式送扫：
//   - 挂点：gameVersionCreateCore 成功登记后异步执行（仅商户名下游戏 + clamav.enabled），
//     不阻塞上架响应——大包扫描分钟级，商户无需等待；
//   - 检出病毒 → 游戏整体自动驳回（audit_status=3 + audit_remark 携带病毒签名与文件名），
//     玩家侧过滤墙（audit IN (official, approved)）立即下架隐藏；病毒文件本体保留供管理员
//     取证，删版本走既有后台版本删除；
//   - clamd 不可达/超时 → fail-open 仅记 warn（扫描是增益不是准入门槛，防扫描服务故障
//     卡死正常上架），人工审核兜底不变；
//   - 病毒库由 clamd 侧 freshclam 自行更新，im-server 无感知。
// 部署：Linux 服务器 apt install clamav-daemon（默认 TCP 3310）后 config.yaml 开启 enabled。
// 设计文档：docs/商户上传安全加固方案.md §4

// clamScanChunkSize INSTREAM 单块字节数（clamd 官方建议 ≤64KB 上限流式送出）
const clamScanChunkSize = 64 << 10

// clamScanFile 单文件流式送扫：返回 (病毒签名, nil)=检出 / ("", nil)=干净 / (非空, err)=扫描失败
// 协议：zINSTREAM\0 → 循环 [4 字节大端长度 + 数据块] → 零长度块结束 → 读响应直至 EOF
// （响应 "OK"=干净；"<签名> FOUND"=检出；"... ERROR"=clamd 拒绝，如超大小限制）
func clamScanFile(conn net.Conn, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err // 文件被并发删除（版本刚下架）视为干净跳过
	}
	defer f.Close()

	if _, err := conn.Write([]byte("zINSTREAM\000")); err != nil {
		return "", err
	}
	buf := make([]byte, clamScanChunkSize)
	var lenPrefix [4]byte
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			binary.BigEndian.PutUint32(lenPrefix[:], uint32(n))
			if _, werr := conn.Write(lenPrefix[:]); werr != nil {
				return "", werr
			}
			if _, werr := conn.Write(buf[:n]); werr != nil {
				return "", werr
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", rerr
		}
	}
	// 零长度块 = 流结束
	binary.BigEndian.PutUint32(lenPrefix[:], 0)
	if _, err := conn.Write(lenPrefix[:]); err != nil {
		return "", err
	}

	resp, err := io.ReadAll(bufio.NewReader(conn))
	if err != nil {
		return "", err
	}
	// clamd INSTREAM 响应可能带 "stream:" 前缀 + 末尾可能含 \x00 空字节（Windows 版 clamd 会加），
	// 兼容 "stream:OK" / "stream: OK" / 老版本裸 "OK" 四种格式。
	// 先清 \x00 空字节，再去前缀，再 TrimSpace，统一成裸 "OK" / "<签名> FOUND" / "...ERROR" 做判定。
	line := strings.ReplaceAll(string(resp), "\x00", "")
	line = strings.TrimPrefix(strings.TrimSpace(line), "stream:")
	line = strings.TrimSpace(line)
	switch {
	case line == "OK":
		return "", nil
	case strings.HasSuffix(line, " FOUND"):
		// "Eicar-Test-Signature FOUND" / "Win.Test.EICAR_HDB-1 FOUND" → 取签名部分
		return strings.TrimSpace(strings.TrimSuffix(line, " FOUND")), nil
	default:
		// "INSTREAM size limit exceeded. ERROR" 等 clamd 拒绝：按扫描失败处理（fail-open）
		return "", fmt.Errorf("clamd 响应异常: %s", line)
	}
}

// clamHit 单个检出结果（文件绝对路径 + 病毒签名）
type clamHit struct {
	Path string
	Sig  string
}

// clamScanDir 逐个扫描目录下全部文件（WalkDir 顺序；复用同一 addr/timeout 配置）。
// onFile 每扫完一个文件触发（含 clamd 异常跳过的文件也会回调），供上层实时反馈进度。
// 返回扫描文件数与检出清单；clamd 不可达/拨号失败返回错误（fail-open 决策归调用方——
// 上架同步/异步路径与存量回溯均为 fail-open 语义）；单文件扫描异常仅记日志跳过不中断
func clamScanDir(addr, dir string, timeout time.Duration, onFile func(path string)) (scanned int, hits []clamHit, err error) {
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, werr error) error {
		if werr != nil || entry.IsDir() {
			return nil // 单条目失败不中断整体扫描
		}
		// 无论 clamd 连接是否成功，都算"扫过了"（供 onFile 回调展示进度）
		if onFile != nil {
			onFile(path)
		}
		conn, derr := net.DialTimeout("tcp", addr, timeout)
		if derr != nil {
			// clamd 连接失败（比如 MaxConnections 被打满）：记日志跳过这个文件，
			// 继续扫下一个。不再 return derr 中止整个 WalkDir。
			logger.Warn("病毒扫描连接失败跳过: %s, %v", path, derr)
			return nil
		}
		conn.SetDeadline(time.Now().Add(timeout))
		sig, serr := clamScanFile(conn, path)
		conn.Close()
		if serr != nil {
			logger.Warn("病毒扫描异常跳过: %s, %v", path, serr)
			return nil
		}
		scanned++
		if sig != "" {
			hits = append(hits, clamHit{Path: path, Sig: sig})
		}
		return nil
	})
	return scanned, hits, err
}

// clamScanGameVersionAsync 商户版本病毒扫描异步入口（goroutine 内执行）：
// 逐个扫描本版本落位文件，检出即自动驳回游戏（audit_status=3）+ 推 WS 通知商户，全干净记 info 日志
func clamScanGameVersionAsync(gameID uint, gameName, slug, version, verRoot, owner string) {
	s := defaultServer()
	if s == nil {
		return
	}
	start := time.Now()
	scanned, hits, err := clamScanDir(s.cfg.ClamAV.Addr, verRoot, time.Duration(s.cfg.ClamAV.TimeoutSec)*time.Second, nil)
	if err != nil {
		// fail-open：clamd 不可达不驳回不删档，仅记日志（人工审核兜底）
		logger.Warn("病毒扫描跳过（clamd 不可达 %s）: 游戏=%s(%s) v%s, %v", s.cfg.ClamAV.Addr, gameName, slug, version, err)
		return
	}

	if len(hits) > 0 {
		first := hits[0]
		for _, h := range hits {
			logger.Error("病毒扫描检出: %s（%s）, 游戏=%s(%s) v%s", h.Path, h.Sig, gameName, slug, version)
		}
		// 检出病毒：游戏整体自动驳回（与人工驳回同一状态机语义与展示/申诉链路）——
		// 玩家侧过滤墙立即下架隐藏；remark 携带签名与文件名供商户整改与管理员核查
		remark := "病毒扫描不通过（自动驳回）：检出 " + first.Sig + "（" +
			filepath.Base(first.Path) + "）；请清理文件后重新上架"
		res := store.DB.Model(&model.Game{}).Where("id = ?", gameID).Updates(map[string]interface{}{
			"audit_status": model.GameAuditRejected, "audit_remark": remark,
		})
		if res.Error == nil && res.RowsAffected > 0 {
			logger.Error("病毒扫描自动驳回: 游戏=%s(%s) v%s, 检出 %d 处, 首个=%s（%s）",
				gameName, slug, version, len(hits), filepath.Base(first.Path), first.Sig)
			// 推 WS 通知商户实时刷新
			if owner != "" {
				emitGameAuditChanged(s, owner, gameID, model.GameAuditRejected, remark, gameName)
			}
		} else if res.Error != nil {
			logger.Error("病毒扫描检出但自动驳回失败（请人工处理）: 游戏=%d, %v", gameID, res.Error)
		}
		return
	}
	logger.Info("病毒扫描完成: 游戏=%s(%s) v%s, 文件 %d 个全部干净, 耗时 %s",
		gameName, slug, version, scanned, time.Since(start).Round(time.Second))
}

// emitGameAuditChanged 统一的游戏审核状态变更 WS 推送：三个驳回/审核通过路径共用，
// 给商户端实时刷新"我的游戏"列表（前端 WS 收到后立即刷新；未接 WS 的商户页靠定时轮询兜底）
// 推送是尽力而为：hub 未就绪（测试环境/刚启动）时静默跳过，不影响主业务流程
func emitGameAuditChanged(s *Server, owner string, gameID uint, auditStatus int8, remark, gameName string) {
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("游戏审核变更 WS 推送 panic（已忽略）: %v", r)
		}
	}()
	if s == nil || owner == "" {
		return
	}
	payload, err := json.Marshal(map[string]interface{}{
		"type":          "game_audit_changed",
		"game_id":       gameID,
		"audit_status":  auditStatus,
		"audit_remark":   remark,
		"game_name":      gameName,
		"audit_time":     time.Now().Format("2006-01-02 15:04:05"),
	})
	if err != nil {
		logger.Warn("游戏审核变更 WS 推送序列化失败: %v", err)
		return
	}
	s.sendToUser(owner, payload)
	logger.Info("游戏审核变更 WS 推送: owner=%s, game_id=%d, audit_status=%d", owner, gameID, auditStatus)
}
