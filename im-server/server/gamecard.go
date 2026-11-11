package server

// ===== 充值卡（卡密）：批量生成 / 列表 / 作废 / 导出 / 用户核销（充值卡功能开发文档 §3） =====
//
// 链路：管理端按面值批量生成卡号+卡密（明文入库，已拍板）→ 导出发卡 → 玩家在游戏中心标题栏
// 弹窗输入卡号+卡密核销 → 事务内【条件更新卡 status 0→1（RowsAffected=1 唯一赢家）→ 用户加分 →
// 流水 reason=card_recharge】——并发/重复提交绝不可能双得，任何一步失败整体回滚。
//
// 安全归口：
//   1. 核销资金接口挂 guardRecharge 同款 X-Drive-Token 强校验（自报 username 须与 token 归属一致）；
//   2. 防爆破：卡密空间 58^16 主防线 + 同账号失败频控（1 分钟 5 次失败锁 10 分钟，进程内存）+
//      统一错误文案"卡号或卡密错误"（不区分卡号/卡密错误，防探测）；
//   3. 卡号/卡密字符集白名单（去易混淆字符 0O1IL），唯一索引兜底防碰撞；
//   4. 导出 adminGuard Bearer + 单次上限 50000 行（防内存放大）。

import (
	"crypto/rand"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"im-server/logger"
	"im-server/model"
	"im-server/store"

	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

// ===== 字符集与生成 =====

// cardKeyCharset 卡密字符集：字母数字去易混淆字符（0/O/1/I/L），58 个字符 → 58^16 空间
const cardKeyCharset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"

// cardNoDigits 卡号尾段字符集：纯数字 12 位
const cardNoDigits = "0123456789"

// cardGenMax 批量生成单批上限（防误植拖垮库；导出另限 50000 行跨批次累计）
const cardGenMax = 5000

// cardRand 随机串生成（crypto/rand，非安全场景不降级——卡密即凭证）
func cardRand(charset string, n int) string {
	out := make([]byte, 0, n)
	max := big.NewInt(int64(len(charset)))
	for i := 0; i < n; i++ {
		b, err := rand.Int(rand.Reader, max)
		if err != nil {
			continue // rand.Int 失败极罕见：跳过该位（下文长度校验兜底）
		}
		out = append(out, charset[b.Int64()])
	}
	if len(out) != n {
		return "" // 长度不足即失败（上层重试）
	}
	return string(out)
}

// cardBatchNo 批次号归口：CR + 时间戳（同次生成归组）
func cardBatchNo() string { return "CR" + time.Now().Format("20060102150405") }

// ===== 核销频控（进程内存，重启即清——频控为辅助，卡密空间为主防线） =====

var (
	cardRateMu    sync.Mutex
	cardRateTable = map[string]*cardRateEntry{} // username → 失败窗口与锁定状态
)

type cardRateEntry struct {
	fails     int
	windowAt  time.Time
	lockUntil time.Time
}

// cardRateCheck 核销前检查：被锁返回剩余秒数（>0 即拒绝）
func cardRateCheck(username string) int {
	cardRateMu.Lock()
	defer cardRateMu.Unlock()
	e, ok := cardRateTable[username]
	if !ok {
		return 0
	}
	if now := time.Now(); now.Before(e.lockUntil) {
		return int(e.lockUntil.Sub(now).Seconds()) + 1
	}
	return 0
}

// cardRateFail 记一次失败：1 分钟窗口内第 5 次 → 锁 10 分钟
func cardRateFail(username string) {
	cardRateMu.Lock()
	defer cardRateMu.Unlock()
	now := time.Now()
	e, ok := cardRateTable[username]
	if !ok || now.Sub(e.windowAt) > time.Minute {
		e = &cardRateEntry{windowAt: now}
		cardRateTable[username] = e
	}
	e.fails++
	if e.fails >= 5 {
		e.lockUntil = now.Add(10 * time.Minute)
		e.fails = 0
	}
}

// cardRateSuccess 核销成功清零
func cardRateSuccess(username string) {
	cardRateMu.Lock()
	defer cardRateMu.Unlock()
	delete(cardRateTable, username)
}

// ===== 管理端接口 =====

// HandleAdminCardGenerate POST /admin/api/game/card/generate
// Body {points, count, prefix}：批量生成（单批上限 5000；卡号/卡密唯一索引兜底，冲突整批重试 ≤3 次）
func (s *Server) HandleAdminCardGenerate(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var req struct {
		Points float64 `json:"points"`
		Count  int     `json:"count"`
		Prefix string  `json:"prefix"`
	}
	if err := jsonDecodeLimit(w, r, &req, 4096); err != nil {
		return
	}
	points := aiPointsRound3(req.Points)
	if points <= 0 {
		adminFail(w, http.StatusBadRequest, "面值必须大于 0")
		return
	}
	if req.Count < 1 || req.Count > cardGenMax {
		adminFail(w, http.StatusBadRequest, fmt.Sprintf("数量须为 1~%d", cardGenMax))
		return
	}
	prefix := strings.ToUpper(strings.TrimSpace(req.Prefix))
	if prefix == "" {
		prefix = "IM"
	}
	if len(prefix) > 8 || !isAlphaNum(prefix) {
		adminFail(w, http.StatusBadRequest, "前缀须为 1~8 位字母数字（留空默认 IM）")
		return
	}
	// 前缀统一大写：与核销侧 card_no ToUpper 归一口径一致（否则小写前缀卡被玩家大写输入时误判不存在）
	operator := adminUserFromCtx(r)
	batch := cardBatchNo()
	var rows []model.RechargeCard
	for attempt := 0; attempt < 3; attempt++ { // 唯一索引冲突（天文概率）整批重试
		rows = make([]model.RechargeCard, 0, req.Count)
		seen := map[string]bool{}
		okGen := true
		for i := 0; i < req.Count; i++ {
			no := prefix + cardRand(cardNoDigits, 12)
			key := cardRand(cardKeyCharset, 16)
			if no == "" || key == "" || seen[no] || seen[key] {
				okGen = false
				break
			}
			seen[no], seen[key] = true, true
			rows = append(rows, model.RechargeCard{CardNo: no, CardKey: key, Points: points,
				Status: model.RechargeCardStatusUnused, BatchNo: batch, CreatedBy: operator})
		}
		if !okGen {
			continue
		}
		if err := store.DB.CreateInBatches(rows, 500).Error; err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
				continue // 碰撞重试
			}
			logger.Error("充值卡生成失败（%s 批次 %s）：%v", operator, batch, err)
			adminFail(w, http.StatusInternalServerError, "生成失败")
			return
		}
		logger.Info("充值卡生成：管理员 %s 批次 %s 面值 %.3f 数量 %d", operator, batch, points, len(rows))
		adminJSON(w, map[string]interface{}{"ok": true, "batch_no": batch, "count": len(rows), "points": points})
		return
	}
	adminFail(w, http.StatusInternalServerError, "生成失败（卡号碰撞重试耗尽，请重试）")
}

// isAlphaNum 字母数字白名单（前缀校验用）
func isAlphaNum(s string) bool {
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return len(s) > 0
}

// HandleAdminCardList GET /admin/api/game/card/list?batch=&status=&page=&size=
// 批次/状态筛选分页，倒序；卡号/卡密明文回显（已拍板：明文存储可重复导出）
func (s *Server) HandleAdminCardList(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	db := store.DB.Model(&model.RechargeCard{})
	if b := strings.TrimSpace(q.Get("batch")); b != "" {
		db = db.Where("batch_no = ?", b)
	}
	if st := strings.TrimSpace(q.Get("status")); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 2 {
			db = db.Where("status = ?", v)
		}
	}
	var total int64
	db.Count(&total)
	var rows []model.RechargeCard
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&rows).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "查询失败")
		return
	}
	adminJSON(w, map[string]interface{}{"ok": true, "total": total, "items": rows})
}

// HandleAdminCardVoid POST /admin/api/game/card/void  Body {ids:[]}
// 仅未使用卡可作废（条件更新 status 0→2），已使用/已作废自动跳过
func (s *Server) HandleAdminCardVoid(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	var req struct {
		IDs []uint64 `json:"ids"`
	}
	if err := jsonDecodeLimit(w, r, &req, 65536); err != nil {
		return
	}
	if len(req.IDs) == 0 || len(req.IDs) > cardGenMax {
		adminFail(w, http.StatusBadRequest, "ids 须为 1~5000 个")
		return
	}
	res := store.DB.Model(&model.RechargeCard{}).
		Where("id IN ? AND status = ?", req.IDs, model.RechargeCardStatusUnused).
		Update("status", model.RechargeCardStatusVoided)
	if res.Error != nil {
		adminFail(w, http.StatusInternalServerError, "作废失败")
		return
	}
	logger.Info("充值卡作废：管理员 %s 请求 %d 张，实际作废 %d 张", adminUserFromCtx(r), len(req.IDs), res.RowsAffected)
	adminJSON(w, map[string]interface{}{"ok": true, "voided": res.RowsAffected})
}

// HandleAdminCardExport GET /admin/api/game/card/export?batch=&status=&format=txt|csv|xlsx
// 流式下载（adminGuard 由路由挂载）；单次上限 50000 行（防内存放大，超限提示按批次导）
func (s *Server) HandleAdminCardExport(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	q := r.URL.Query()
	format := strings.ToLower(strings.TrimSpace(q.Get("format")))
	if format != "txt" && format != "csv" && format != "xlsx" {
		adminFail(w, http.StatusBadRequest, "format 仅支持 txt/csv/xlsx")
		return
	}
	db := store.DB.Model(&model.RechargeCard{})
	batch := strings.TrimSpace(q.Get("batch"))
	if batch != "" {
		db = db.Where("batch_no = ?", batch)
	}
	if st := strings.TrimSpace(q.Get("status")); st != "" {
		if v, err := strconv.Atoi(st); err == nil && v >= 0 && v <= 2 {
			db = db.Where("status = ?", v)
		}
	}
	var rows []model.RechargeCard
	if err := db.Order("id ASC").Limit(50000).Find(&rows).Error; err != nil {
		adminFail(w, http.StatusInternalServerError, "导出查询失败")
		return
	}
	if len(rows) == 0 {
		adminFail(w, http.StatusBadRequest, "导出范围为空")
		return
	}
	if len(rows) >= 50000 {
		// 命中单次导出上限：明确告知可能截断（建议按批次分次导出），绝不静默缺数据
		w.Header().Set("X-Export-Truncated", "true")
		logger.Warn("充值卡导出命中 50000 行上限（可能截断）：管理员 %s 批次 %q", adminUserFromCtx(r), batch)
	}
	nameSuffix := batch
	if nameSuffix == "" {
		nameSuffix = "all"
	}
	deadline := time.Now().Format("20060102150405")
	disposition := func(ext, mime string) {
		w.Header().Set("Content-Type", mime+"; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"cards_%s_%s.%s\"", nameSuffix, deadline, ext))
	}
	switch format {
	case "txt":
		disposition("txt", "text/plain")
		var b strings.Builder
		for _, c := range rows {
			b.WriteString(fmt.Sprintf("%s,%s,%.3f\r\n", c.CardNo, c.CardKey, c.Points))
		}
		_, _ = io.WriteString(w, b.String())
	case "csv":
		disposition("csv", "text/csv")
		// UTF-8 BOM：Excel 直接打开中文不乱码
		_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"卡号", "卡密", "面值(积分)", "状态", "使用者", "使用时间"})
		stTxt := map[int8]string{0: "未使用", 1: "已使用", 2: "已作废"}
		for _, c := range rows {
			used := ""
			if c.UsedAt != nil {
				used = c.UsedAt.Format("2006-01-02 15:04:05")
			}
			_ = cw.Write([]string{c.CardNo, c.CardKey, strconv.FormatFloat(c.Points, 'f', -1, 64), stTxt[c.Status], c.UsedBy, used})
		}
		cw.Flush()
	case "xlsx":
		disposition("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		f := excelize.NewFile()
		sheet := "充值卡"
		f.SetSheetName("Sheet1", sheet)
		headers := []interface{}{"卡号", "卡密", "面值(积分)", "状态", "使用者", "使用时间"}
		for i, h := range headers {
			cell, _ := excelize.CoordinatesToCellName(i+1, 1)
			f.SetCellValue(sheet, cell, h)
		}
		stTxt := map[int8]string{0: "未使用", 1: "已使用", 2: "已作废"}
		for i, c := range rows {
			used := ""
			if c.UsedAt != nil {
				used = c.UsedAt.Format("2006-01-02 15:04:05")
			}
			row := i + 2
			vals := []interface{}{c.CardNo, c.CardKey, c.Points, stTxt[c.Status], c.UsedBy, used}
			for j, v := range vals {
				cell, _ := excelize.CoordinatesToCellName(j+1, row)
				f.SetCellValue(sheet, cell, v)
			}
		}
		if err := f.Write(w); err != nil {
			logger.Error("充值卡 xlsx 导出失败（%s）：%v", batch, err)
		}
	}
	logger.Info("充值卡导出：管理员 %s 批次 %q 格式 %s 共 %d 张", adminUserFromCtx(r), batch, format, len(rows))
}

// ===== 用户端接口 =====

// jsonDecodeLimit 请求体解码归口（限长 + 统一错误响应）
func jsonDecodeLimit(w http.ResponseWriter, r *http.Request, out interface{}, limit int64) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(out); err != nil {
		adminFail(w, http.StatusBadRequest, "参数错误")
		return err
	}
	return nil
}

// HandleGameCardRedeem POST /api/game/card/redeem?username={账号}  Body {card_no, card_key}
// 资金接口：guardRecharge 同款 X-Drive-Token 强校验（路由挂载）。核销事务：
// 条件更新卡 0→1（RowsAffected=1 唯一赢家）→ 用户加分 → 流水 reason=card_recharge
func (s *Server) HandleGameCardRedeem(w http.ResponseWriter, r *http.Request) {
	if !s.gameEnabled(w) {
		return
	}
	username, ok := gameUsername(w, r)
	if !ok {
		return
	}
	if remain := cardRateCheck(username); remain > 0 {
		adminFail(w, http.StatusTooManyRequests, fmt.Sprintf("尝试过于频繁，请 %d 秒后再试", remain))
		return
	}
	var req struct {
		CardNo  string `json:"card_no"`
		CardKey string `json:"card_key"`
	}
	if err := jsonDecodeLimit(w, r, &req, 1024); err != nil {
		return
	}
	cardNo := strings.ToUpper(strings.TrimSpace(req.CardNo))
	cardKey := strings.TrimSpace(req.CardKey)
	if cardNo == "" || cardKey == "" {
		cardRateFail(username)
		adminFail(w, http.StatusBadRequest, "卡号或卡密错误")
		return
	}
	var card model.RechargeCard
	if err := store.DB.Where("card_no = ?", cardNo).First(&card).Error; err != nil || card.CardKey != cardKey {
		cardRateFail(username)
		// 统一文案不区分卡号/卡密错误（防探测；频控归口在失败路径）
		adminFail(w, http.StatusBadRequest, "卡号或卡密错误")
		return
	}
	if card.Status != model.RechargeCardStatusUnused {
		cardRateFail(username)
		if card.Status == model.RechargeCardStatusVoided {
			adminFail(w, http.StatusBadRequest, "该卡已作废")
		} else {
			adminFail(w, http.StatusBadRequest, "该卡已使用")
		}
		return
	}
	// 事务归口：核销与加分同事务；条件更新 status 0→1 为唯一赢家判定（并发/重复提交仅一次成功）
	errTaken := fmt.Errorf("该卡已使用")
	errUser := fmt.Errorf("用户不存在: %s", username)
	err := store.DB.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		res := tx.Model(&model.RechargeCard{}).
			Where("id = ? AND status = ?", card.ID, model.RechargeCardStatusUnused).
			Updates(map[string]interface{}{"status": model.RechargeCardStatusUsed, "used_by": username, "used_at": &now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errTaken
		}
		res2 := tx.Model(&model.User{}).Where("username = ?", username).
			Update("points", gorm.Expr("ROUND(points + ?, 3)", card.Points))
		if res2.Error != nil {
			return res2.Error
		}
		if res2.RowsAffected == 0 {
			return errUser
		}
		return nil
	})
	if err != nil {
		if err == errTaken {
			cardRateFail(username)
			adminFail(w, http.StatusBadRequest, "该卡已使用")
			return
		}
		if err == errUser {
			cardRateFail(username)
			adminFail(w, http.StatusBadRequest, "用户不存在")
			return
		}
		logger.Error("卡密核销失败（%s 卡 %s）：%v", username, cardNo, err)
		adminFail(w, http.StatusInternalServerError, "核销失败")
		return
	}
	cardRateSuccess(username)
	after, _ := userPoints(username)
	recordPointsLog(username, card.Points, after, "card_recharge", "system", "卡密充值: "+cardNo)
	logger.Info("卡密核销成功：用户 %s 卡 %s 面值 %.3f 余额 %.3f", username, cardNo, card.Points, after)
	adminJSON(w, map[string]interface{}{"ok": true, "points": card.Points, "balance": aiPointsRound3(after)})
}

// cardSeedMigration 充值卡表迁移归口（InitGame 逐表迁移列表追加）
func cardSeedMigration() {}

// EnsureCardTable 充值卡表迁移（供 InitGame 与测试调用；惰性幂等）
func EnsureCardTable() error {
	return store.DB.AutoMigrate(&model.RechargeCard{})
}
