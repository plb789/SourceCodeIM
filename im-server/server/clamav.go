package server

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
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
//   - 检出病毒：
//     · quarantine_on_detect=true（默认）→ 写入隔离库 + audit_status=4（隔离态），
//       等待管理员人工审核。文件保留磁盘不动，通过审核后立即可用，商户无需重传；
//     · quarantine_on_detect=false → 直接 audit_status=3（驳回），旧行为兼容；
//   - clamd 不可达/超时 → fail-open 仅记 warn（扫描是增益不是准入门槛，防扫描服务故障
//     卡死正常上架），人工审核兜底不变；
//   - 病毒库由 clamd 侧 freshclam 自行更新，im-server 无感知。
// 部署：Linux 服务器 apt install clamav-daemon（默认 TCP 3310）后 config.yaml 开启 enabled。
// 设计文档：docs/病毒隔离库与扫描白名单设计方案.md

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
// whitelistMatcher 可选白名单匹配器（nil 时不跳过任何文件）；命中白名单的文件记日志跳过。
// 返回扫描文件数与检出清单；clamd 不可达/拨号失败返回错误（fail-open 决策归调用方——
// 上架同步/异步路径与存量回溯均为 fail-open 语义）；单文件扫描异常仅记日志跳过不中断
func clamScanDir(addr, dir string, timeout time.Duration, onFile func(path string), whitelistMatcher func(relPath string) bool) (scanned int, hits []clamHit, err error) {
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, werr error) error {
		if werr != nil || entry.IsDir() {
			return nil // 单条目失败不中断整体扫描
		}
		// 白名单匹配：命中则跳过扫描
		if whitelistMatcher != nil {
			if rel, rerr := filepath.Rel(dir, path); rerr == nil {
				rel = filepath.ToSlash(rel)
				if whitelistMatcher(rel) {
					// 白名单命中跳过扫描
					if onFile != nil {
						onFile(path)
					}
					return nil
				}
			}
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

// fileSHA256 计算文件 SHA256 哈希（流式读取，适用于大文件）
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// clamScanGameVersionAsync 商户版本病毒扫描异步入口（goroutine 内执行）：
// 逐个扫描本版本落位文件，检出根据 quarantine_on_detect 配置进入隔离库或直接驳回
func clamScanGameVersionAsync(gameID uint, gameName, slug, version, verRoot, owner string) {
	s := defaultServer()
	if s == nil {
		return
	}
	start := time.Now()
	// 预取版本 ID（隔离库记录需要关联版本）
	var versionID uint
	var gv model.GameVersion
	if err := store.DB.Where("game_id = ? AND version = ?", gameID, version).First(&gv).Error; err == nil {
		versionID = gv.ID
	}

	// 构建白名单匹配器（可选）
	wlMatcher := ClamavWhitelistMatcherFactory(gameID)

	scanned, hits, err := clamScanDir(s.cfg.ClamAV.Addr, verRoot, time.Duration(s.cfg.ClamAV.TimeoutSec)*time.Second, nil, wlMatcher)
	if err != nil {
		// fail-open：clamd 不可达不驳回不删档，仅记日志（人工审核兜底）
		logger.Warn("病毒扫描跳过（clamd 不可达 %s）: 游戏=%s(%s) v%s, %v", s.cfg.ClamAV.Addr, gameName, slug, version, err)
		return
	}

	if len(hits) > 0 {
		isQuarantine := s.cfg.ClamAV.IsQuarantineOnDetect()
		for _, h := range hits {
			logger.Error("病毒扫描检出: %s（%s）, 游戏=%s(%s) v%s", h.Path, h.Sig, gameName, slug, version)
		}
		if isQuarantine {
			// 进入隔离库：写隔离记录 + audit_status=4，文件保留磁盘不动
			handleClamavDetectedQuarantine(gameID, versionID, gameName, slug, version, owner, verRoot, hits)
		} else {
			// 直接驳回（旧行为，兼容 quarantine_on_detect=false 时）
			remark := "病毒扫描不通过（自动驳回）：检出 " + hits[0].Sig + "（" +
				filepath.Base(hits[0].Path) + "）；请清理文件后重新上架"
			res := store.DB.Model(&model.Game{}).Where("id = ?", gameID).Updates(map[string]interface{}{
				"audit_status": model.GameAuditRejected, "audit_remark": remark,
			})
			if res.Error == nil && res.RowsAffected > 0 {
				logger.Error("病毒扫描自动驳回: 游戏=%s(%s) v%s, 检出 %d 处", gameName, slug, version, len(hits))
				if owner != "" {
					emitGameAuditChanged(s, owner, gameID, model.GameAuditRejected, remark, gameName)
				}
			} else if res.Error != nil {
				logger.Error("病毒扫描检出但自动驳回失败（请人工处理）: 游戏=%d, %v", gameID, res.Error)
			}
		}
		return
	}
	logger.Info("病毒扫描完成: 游戏=%s(%s) v%s, 文件 %d 个全部干净, 耗时 %s",
		gameName, slug, version, scanned, time.Since(start).Round(time.Second))
}

// handleClamavDetectedQuarantine 检出病毒进入隔离库的统一处置：写隔离记录 + 游戏置隔离态 + 推 WS
func handleClamavDetectedQuarantine(gameID, versionID uint, gameName, slug, version, owner, verRoot string, hits []clamHit) {
	s := defaultServer()
	now := time.Now()

	// 构建隔离记录（每个检出文件一行，相对路径 + SHA256）
	quarRecords := make([]model.ClamavQuarantine, 0, len(hits))
	for _, h := range hits {
		rel, rerr := filepath.Rel(verRoot, h.Path)
		if rerr != nil {
			rel = filepath.Base(h.Path)
		}
		rel = filepath.ToSlash(rel)
		sha, _ := fileSHA256(h.Path)
		var fsize int64
		if st, err := os.Stat(h.Path); err == nil {
			fsize = st.Size()
		}
		quarRecords = append(quarRecords, model.ClamavQuarantine{
			GameID:        gameID,
			VersionID:     versionID,
			GameName:      gameName,
			Slug:          slug,
			Version:       version,
			Owner:         owner,
			FilePath:      rel,
			FileSize:      fsize,
			FileSHA256:    sha,
			VirusSig:      h.Sig,
			QuarantinedAt: &now,
			Status:        0, // 待审核
		})
	}

	// 事务内：写隔离记录 + 更新游戏隔离态
	tx := store.DB.Begin()
	if err := tx.CreateInBatches(&quarRecords, 200).Error; err != nil {
		tx.Rollback()
		logger.Error("隔离记录写入失败: 游戏=%d, 版本=%d, %v", gameID, versionID, err)
		return
	}

	firstSig := hits[0].Sig
	firstFile := filepath.Base(hits[0].Path)
	remark := fmt.Sprintf("病毒扫描检出 %d 项，已进入隔离库待管理员审核（首个：%s - %s）", len(hits), firstSig, firstFile)
	res := tx.Model(&model.Game{}).Where("id = ?", gameID).Updates(map[string]interface{}{
		"audit_status": model.GameAuditQuarantined, "audit_remark": remark,
	})
	if res.Error != nil {
		tx.Rollback()
		logger.Error("游戏隔离态更新失败: 游戏=%d, %v", gameID, res.Error)
		return
	}
	tx.Commit()

	logger.Error("病毒扫描进入隔离库: 游戏=%s(%s) v%s, 商户=%s, 检出 %d 处, 文件保留不动",
		gameName, slug, version, owner, len(hits))

	// 推 WS 通知商户实时刷新隔离态
	if owner != "" {
		emitGameQuarantined(s, owner, gameID, gameName, remark, len(hits))
	}
}

// emitGameQuarantined 游戏病毒隔离 WS 推送（独立于审核状态变更的新消息类型）
// payload: {type, game_id, game_name, audit_remark, hit_count, audit_time}
func emitGameQuarantined(s *Server, owner string, gameID uint, gameName, remark string, hitCount int) {
	defer func() {
		if r := recover(); r != nil {
			logger.Warn("游戏隔离 WS 推送 panic（已忽略）: %v", r)
		}
	}()
	if s == nil || owner == "" {
		return
	}
	payload, err := json.Marshal(map[string]interface{}{
		"type":           "game_quarantined",
		"game_id":        gameID,
		"game_name":      gameName,
		"audit_remark":    remark,
		"hit_count":      hitCount,
		"audit_time":     time.Now().Format("2006-01-02 15:04:05"),
	})
	if err != nil {
		logger.Warn("游戏隔离 WS 推送序列化失败: %v", err)
		return
	}
	s.sendToUser(owner, payload)
	logger.Info("游戏隔离 WS 推送: owner=%s, game_id=%d, hit_count=%d", owner, gameID, hitCount)
}

// emitGameAuditChanged 统一的游戏审核状态变更 WS 推送（审核通过/驳回路径共用）
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
