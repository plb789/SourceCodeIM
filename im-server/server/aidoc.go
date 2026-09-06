package server

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"

	"im-server/logger"
	"im-server/model"
	"im-server/protocol"
	"im-server/store"
)

// 阶段四十五：AI 文档导出（表格/Word 等结构化内容转档）
// 思路：AI 回复为 Markdown 文本 → 服务端归口解析 → 转档为 xlsx/docx 落盘
// → 以文件消息（msg_type=5）落库并推送会话（复用文件下载/多端同步/历史链路，零协议迁移）

// aiIsTableSeparator 判断表格分隔行（--- | :---: | ---）
func aiIsTableSeparator(cells []string) bool {
	if len(cells) == 0 {
		return false
	}
	for _, c := range cells {
		t := strings.TrimSpace(c)
		if t == "" {
			return false
		}
		t = strings.Trim(t, ":")
		for _, ch := range t {
			if ch != '-' {
				return false
			}
		}
	}
	return true
}

// aiSplitTableRow 拆分表格行为单元格（| a | b | 或 a | b；反转义 \|）
func aiSplitTableRow(line string) []string {
	t := strings.TrimSpace(line)
	t = strings.TrimPrefix(t, "|")
	t = strings.TrimSuffix(t, "|")
	// 先把转义竖线 \| 换成占位符再按 | 拆分，避免单元格内的 \| 被误切开
	const esc = "\x00PIPE\x00"
	t = strings.ReplaceAll(t, "\\|", esc)
	parts := strings.Split(t, "|")
	cells := make([]string, 0, len(parts))
	for _, p := range parts {
		cells = append(cells, strings.ReplaceAll(strings.TrimSpace(p), esc, "|"))
	}
	return cells
}

// aiIsTableRow 判断是否表格行（以 | 开头或包含 | 且非分隔行）
func aiLooksLikeTableRow(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "|") && strings.Contains(t, "|")
}

// aiParseMarkdownTables 提取 Markdown 中全部表格：每个表格为 [][]string（首行为表头）。
// 无表格返回空切片。单元格内 \| 转义、:---: 对齐标记均正确处理
func aiParseMarkdownTables(content string) [][][]string {
	lines := strings.Split(content, "\n")
	tables := make([][][]string, 0)
	i := 0
	for i < len(lines) {
		line := strings.TrimSpace(lines[i])
		// 表格起点：本行为表格行且下一行为分隔行
		if aiLooksLikeTableRow(line) && i+1 < len(lines) {
			header := aiSplitTableRow(line)
			sep := aiSplitTableRow(strings.TrimSpace(lines[i+1]))
			if aiIsTableSeparator(sep) && len(header) > 0 {
				rows := [][]string{header}
				j := i + 2
				for ; j < len(lines); j++ {
					rowLine := strings.TrimSpace(lines[j])
					if !aiLooksLikeTableRow(rowLine) {
						break
					}
					cells := aiSplitTableRow(rowLine)
					if aiIsTableSeparator(cells) {
						continue // 容错：正文中重复分隔行跳过
					}
					// 列数对齐表头（缺补空，超出截断）
					if len(cells) < len(header) {
						for len(cells) < len(header) {
							cells = append(cells, "")
						}
					} else if len(cells) > len(header) {
						cells = cells[:len(header)]
					}
					rows = append(rows, cells)
				}
				if len(rows) > 1 {
					tables = append(tables, rows)
				}
				i = j
				continue
			}
		}
		i++
	}
	return tables
}

// aiRandomFileName 生成导出文件名（前缀_时间戳_随机.ext），落盘 static/upload 与聊天文件同归口
func aiRandomFileName(prefix, ext string) string {
	b := make([]byte, 6)
	rand.Read(b)
	return fmt.Sprintf("%s_%d_%s%s", prefix, time.Now().UnixNano(), hex.EncodeToString(b), ext)
}

// aiUploadDir 服务端文件落盘目录归口（与 uploadfile.go 同规则）
func (s *Server) aiUploadDir() string {
	dir := s.cfg.UploadDir
	if dir == "" {
		dir = filepath.Join(s.cfg.WebDir, "static", "upload")
	}
	return dir
}

// persistAgentFileMessage AI 生成文件统一归口：建档 im_file + 落库文件消息(msg_type=5) +
// 会话摘要 + FILE_PERSISTED 推送（复用聊天文件全链路：下载/撤回占位/历史/多端同步零改动）
func (s *Server) persistAgentFileMessage(agent, username, absPath, url string) error {
	fi, err := os.Stat(absPath)
	if err != nil {
		return err
	}
	rec := model.FileRecord{
		FileName: filepath.Base(url),
		FileSize: fi.Size(),
		FilePath: url,
		FromUser: agent,
		ToUser:   username,
		Status:   3,
	}
	if err := store.DB.Create(&rec).Error; err != nil {
		return err
	}
	contentBytes, _ := json.Marshal(persistedMsgContent{URL: url, Name: filepath.Base(url), Size: fi.Size()})
	record := model.Message{
		MsgType:  MsgTypeFileSaved,
		FromUser: agent,
		ToUser:   username,
		Content:  string(contentBytes),
	}
	if err := store.DB.Create(&record).Error; err != nil {
		return err
	}
	store.DB.Model(&model.FileRecord{}).Where("id = ?", rec.ID).Update("msg_id", record.ID)

	s.touchConversation(username, agent, "[文件]")
	s.notifyConvUpdate(username)

	notice, _ := json.Marshal(&protocol.Message{
		MsgType:   protocol.MsgTypeFilePersisted,
		FromUser:  agent,
		ToUser:    username,
		Content:   string(contentBytes),
		FileID:    strconv.FormatUint(uint64(rec.ID), 10),
		MsgID:     record.ID,
		Timestamp: time.Now().Unix(),
	})
	s.sendToUser(username, notice)
	return nil
}

// HandleAIExportExcel 阶段四十五：AI 回复表格导出 Excel
// POST /export/ai/excel?msg_id=xx&username=yy
// 归口校验：消息必须为智能体发给该用户的回复（不能导出他人回复）；无表格返回 400
func (s *Server) HandleAIExportExcel(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	msgIDStr := r.URL.Query().Get("msg_id")
	if username == "" || msgIDStr == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		return
	}
	msgID, err := strconv.ParseUint(msgIDStr, 10, 32)
	if err != nil {
		http.Error(w, "msg_id 不合法", http.StatusBadRequest)
		return
	}
	var record model.Message
	if err := store.DB.First(&record, msgID).Error; err != nil {
		http.Error(w, "消息不存在", http.StatusNotFound)
		return
	}
	// 归口：仅能导出"智能体发给自己"的回复（他人会话内容不可见）
	if record.ToUser != username || aiAgentByName(record.FromUser) == nil {
		http.Error(w, "无权导出该消息", http.StatusForbidden)
		return
	}
	tables := aiParseMarkdownTables(record.Content)
	if len(tables) == 0 {
		http.Error(w, "该回复中没有可导出的表格", http.StatusBadRequest)
		return
	}

	// excelize 生成：每个表格一个 sheet（表格1/表格2…），首行表头加粗
	f := excelize.NewFile()
	for ti, rows := range tables {
		sheet := fmt.Sprintf("表格%d", ti+1)
		if ti == 0 {
			// 默认首个 sheet 名为 Sheet1，统一重命名为 表格1
			f.SetSheetName(f.GetSheetName(0), sheet)
		} else {
			f.NewSheet(sheet)
		}
		for ri, row := range rows {
			for ci, cell := range row {
				cellRef, _ := excelize.CoordinatesToCellName(ci+1, ri+1)
				f.SetCellValue(sheet, cellRef, cell)
			}
		}
	}
	// 表头加粗样式
	style, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	for ti := range tables {
		sheet := fmt.Sprintf("表格%d", ti+1)
		cols := len(tables[ti][0])
		lastCol, _ := excelize.CoordinatesToCellName(cols, 1)
		f.SetCellStyle(sheet, "A1", lastCol, style)
	}

	dir := s.aiUploadDir()
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	name := aiRandomFileName("AI表格", ".xlsx")
	dst := filepath.Join(dir, name)
	if err := f.SaveAs(dst); err != nil {
		http.Error(w, "Excel 生成失败", http.StatusInternalServerError)
		return
	}
	url := "/static/upload/" + name
	if err := s.persistAgentFileMessage(record.FromUser, username, dst, url); err != nil {
		logger.Error("AI Excel 导出落库失败（用户 %s）：%v", username, err)
		http.Error(w, "文件消息落库失败", http.StatusInternalServerError)
		return
	}
	logger.Info("AI 表格导出: 用户 %s 从消息 %d 导出 %d 个表格 -> %s", username, msgID, len(tables), url)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"url": url, "tables": len(tables)})
}

// ===== 阶段四十五：AI 回复导出 Word（Markdown → docx） =====
// docx 为 zip+XML（OOXML）结构：[Content_Types].xml + _rels/.rels + word/document.xml 三件最小集，
// Word/WPS 均可直接打开。支持：标题(1-3级)/段落/无序有序列表/引用块/表格/**加粗**行内转换；
// 复杂图文混排/图片嵌入不在范围（够用版归口）

// aiDocBlock Markdown 文档块
type aiDocBlock struct {
	Kind  string // heading / para / bullet / ordered / quote / table
	Level int    // 标题级别 1-3
	Text  string
	Rows  [][]string // 表格（首行表头）
}

// aiInlineXML 行内 Markdown 转换为 OOXML run 序列：**加粗** 生效，`code`/单个* 斜体降级为普通文本。
// 文本已做 XML 转义
func aiInlineXML(text string) string {
	text = strings.ReplaceAll(text, "`", "")
	text = strings.ReplaceAll(text, "&", "&amp;")
	text = strings.ReplaceAll(text, "<", "&lt;")
	text = strings.ReplaceAll(text, ">", "&gt;")
	text = strings.ReplaceAll(text, "\"", "&quot;")
	var sb strings.Builder
	rest := text
	for {
		idx := strings.Index(rest, "**")
		if idx < 0 {
			break
		}
		end := strings.Index(rest[idx+2:], "**")
		if end < 0 {
			break
		}
		bold := rest[idx+2 : idx+2+end]
		sb.WriteString(aiTextRun(rest[:idx], false))
		sb.WriteString(aiTextRun(bold, true))
		rest = rest[idx+2+end+2:]
	}
	sb.WriteString(aiTextRun(rest, false))
	return sb.String()
}

func aiTextRun(text string, bold bool) string {
	if text == "" {
		return ""
	}
	b := ""
	if bold {
		b = "<w:b/>"
	}
	return "<w:r><w:rPr>" + b + "</w:rPr><w:t xml:space=\"preserve\">" + text + "</w:t></w:r>"
}

// aiParseMarkdownBlocks Markdown → 块序列（Word 导出用；列表/引用/标题/表格/段落归口）
func aiParseMarkdownBlocks(content string) []aiDocBlock {
	lines := strings.Split(content, "\n")
	blocks := make([]aiDocBlock, 0, len(lines))
	i := 0
	for i < len(lines) {
		raw := strings.TrimRight(lines[i], "\r")
		line := strings.TrimSpace(raw)

		switch {
		case line == "":
			i++
		case strings.HasPrefix(line, "```"): // 代码块：整块作为段落保留原文
			var sb strings.Builder
			i++
			for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
				sb.WriteString(strings.TrimRight(lines[i], "\r"))
				sb.WriteString("\n")
				i++
			}
			i++ // 跳过收尾 ```
			blocks = append(blocks, aiDocBlock{Kind: "para", Text: strings.TrimSpace(sb.String())})
		case aiLooksLikeTableRow(line) && i+1 < len(lines):
			sep := aiSplitTableRow(strings.TrimSpace(lines[i+1]))
			if aiIsTableSeparator(sep) {
				rows := [][]string{}
				j := i
				for ; j < len(lines) && aiLooksLikeTableRow(strings.TrimSpace(lines[j])); j++ {
					cells := aiSplitTableRow(strings.TrimSpace(lines[j]))
					if aiIsTableSeparator(cells) {
						continue
					}
					rows = append(rows, cells)
				}
				if len(rows) > 0 {
					blocks = append(blocks, aiDocBlock{Kind: "table", Rows: rows})
				}
				i = j
				continue
			}
			blocks = append(blocks, aiDocBlock{Kind: "para", Text: line})
			i++
		case strings.HasPrefix(line, "#"):
			level := 0
			for level < len(line) && line[level] == '#' {
				level++
			}
			if level > 3 {
				level = 3
			}
			title := strings.TrimSpace(strings.TrimLeft(line, "#"))
			blocks = append(blocks, aiDocBlock{Kind: "heading", Level: level, Text: title})
			i++
		case strings.HasPrefix(line, ">"):
			blocks = append(blocks, aiDocBlock{Kind: "quote", Text: strings.TrimSpace(strings.TrimPrefix(line, ">"))})
			i++
		case strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* "):
			blocks = append(blocks, aiDocBlock{Kind: "bullet", Text: strings.TrimSpace(line[2:])})
			i++
		case len(line) > 2 && line[0] >= '0' && line[0] <= '9' && (strings.HasPrefix(line[1:], ". ") || strings.HasPrefix(line[1:], ".\t")):
			idx := strings.Index(line, ".")
			blocks = append(blocks, aiDocBlock{Kind: "ordered", Text: strings.TrimSpace(line[idx+1:])})
			i++
		case line == "---" || line == "***" || line == "___":
			i++ // 分隔线：Word 中省略（避免裸符号）
		default:
			blocks = append(blocks, aiDocBlock{Kind: "para", Text: line})
			i++
		}
	}
	return blocks
}

// aiBuildDocx Markdown 块 → 最小合法 docx（zip 三件套），返回字节数组
func aiBuildDocx(blocks []aiDocBlock) ([]byte, error) {
	var body strings.Builder
	orderedNum := 0 // 有序列表计数（非有序块时归零重排）
	for _, b := range blocks {
		switch b.Kind {
		case "heading":
			orderedNum = 0
			size := 32 - (b.Level-1)*4 // h1=32(16pt) h2=28 h3=24 半磅
			body.WriteString("<w:p><w:pPr><w:spacing w:before=\"160\" w:after=\"80\"/></w:pPr>" +
				"<w:r><w:rPr><w:b/><w:sz w:val=\"" + strconv.Itoa(size) + "\"/><w:szCs w:val=\"" + strconv.Itoa(size) + "\"/></w:rPr>" +
				"<w:t xml:space=\"preserve\">" + aiEscapeXML(b.Text) + "</w:t></w:r></w:p>")
		case "bullet":
			orderedNum = 0
			body.WriteString("<w:p><w:pPr><w:ind w:left=\"420\"/></w:pPr>" +
				"<w:r><w:t xml:space=\"preserve\">• " + aiEscapeXML(b.Text) + "</w:t></w:r></w:p>")
		case "ordered":
			orderedNum++
			body.WriteString("<w:p><w:pPr><w:ind w:left=\"420\"/></w:pPr>" +
				"<w:r><w:t xml:space=\"preserve\">" + strconv.Itoa(orderedNum) + ". " + aiEscapeXML(b.Text) + "</w:t></w:r></w:p>")
		case "quote":
			orderedNum = 0
			body.WriteString("<w:p><w:pPr><w:ind w:left=\"420\"/></w:pPr>" +
				"<w:r><w:rPr><w:i/><w:color w:val=\"808080\"/></w:rPr><w:t xml:space=\"preserve\">" + aiEscapeXML(b.Text) + "</w:t></w:r></w:p>")
		case "para":
			orderedNum = 0
			body.WriteString("<w:p><w:pPr><w:spacing w:after=\"60\"/></w:pPr>" + aiInlineXML(b.Text) + "</w:p>")
		case "table":
			orderedNum = 0
			body.WriteString(aiBuildDocxTable(b.Rows))
		}
	}

	document := "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
		"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>" +
		body.String() +
		"<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr>" +
		"</w:body></w:document>"

	contentTypes := "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
		"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
		"<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
		"<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
		"<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>" +
		"</Types>"

	rels := "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
		"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
		"<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>" +
		"</Relationships>"

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range []struct{ name, data string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rels},
		{"word/document.xml", document},
	} {
		fw, err := zw.Create(entry.name)
		if err != nil {
			return nil, err
		}
		if _, err := fw.Write([]byte(entry.data)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// aiBuildDocxTable Markdown 表格 → w:tbl（全边框，首行表头加粗灰底）
func aiBuildDocxTable(rows [][]string) string {
	// 列数对齐
	cols := 0
	for _, r := range rows {
		if len(r) > cols {
			cols = len(r)
		}
	}
	if cols == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>" +
		"<w:tblBorders>" +
		"<w:top w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/>" +
		"<w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/>" +
		"<w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"999999\"/>" +
		"</w:tblBorders></w:tblPr>")
	for ri, row := range rows {
		sb.WriteString("<w:tr>")
		for ci := 0; ci < cols; ci++ {
			cellText := ""
			if ci < len(row) {
				cellText = aiInlineXML(row[ci])
			}
			shade := ""
			if ri == 0 {
				shade = "<w:shd w:val=\"clear\" w:fill=\"F2F2F2\"/>"
			}
			sb.WriteString("<w:tc><w:tcPr>" + shade + "</w:tcPr><w:p>" + cellText + "</w:p></w:tc>")
		}
		sb.WriteString("</w:tr>")
	}
	sb.WriteString("</w:tbl>")
	// 表格后必须跟一个段落，否则连续表格/表尾可能被 Word 判为非法结构
	sb.WriteString("<w:p/>")
	return sb.String()
}

func aiEscapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	return s
}

// HandleAIExportWord 阶段四十五：AI 回复导出 Word（Markdown → docx），归口校验同 Excel 导出
func (s *Server) HandleAIExportWord(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	msgIDStr := r.URL.Query().Get("msg_id")
	if username == "" || msgIDStr == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		return
	}
	msgID, err := strconv.ParseUint(msgIDStr, 10, 32)
	if err != nil {
		http.Error(w, "msg_id 不合法", http.StatusBadRequest)
		return
	}
	var record model.Message
	if err := store.DB.First(&record, msgID).Error; err != nil {
		http.Error(w, "消息不存在", http.StatusNotFound)
		return
	}
	if record.ToUser != username || aiAgentByName(record.FromUser) == nil {
		http.Error(w, "无权导出该消息", http.StatusForbidden)
		return
	}
	blocks := aiParseMarkdownBlocks(record.Content)
	if len(blocks) == 0 {
		http.Error(w, "该回复没有可导出的内容", http.StatusBadRequest)
		return
	}
	data, err := aiBuildDocx(blocks)
	if err != nil {
		http.Error(w, "Word 生成失败", http.StatusInternalServerError)
		return
	}
	dir := s.aiUploadDir()
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	name := aiRandomFileName("AI文档", ".docx")
	dst := filepath.Join(dir, name)
	if err := os.WriteFile(dst, data, 0644); err != nil {
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	url := "/static/upload/" + name
	if err := s.persistAgentFileMessage(record.FromUser, username, dst, url); err != nil {
		logger.Error("AI Word 导出落库失败（用户 %s）：%v", username, err)
		http.Error(w, "文件消息落库失败", http.StatusInternalServerError)
		return
	}
	logger.Info("AI Word 导出: 用户 %s 从消息 %d 导出 %d 个块 -> %s", username, msgID, len(blocks), url)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"url": url, "blocks": len(blocks)})
}

// ===== 阶段四十五 D：AI 文档问答（上传落盘 → 服务端归口解析 → 文档全文信封注入提问） =====
// 设计归口：文档正文不经过前端——前端仅上传文件并持有 URL；提问时服务端按 URL 重新解析落盘文档，
// 提取文本以【文档】信封包裹注入当次提问（纯文本注入，不依赖模型多模态能力，全部智能体可用）。
// 历史上下文仅携带"[文档] 文件名 附言"摘要（messageSummary 归口），避免多轮重复携带全文撑爆 token。

// aiDocExts 阶段四十五：文档问答支持的扩展名白名单（大小写不敏感）
// .docx/.xlsx 走 OOXML 解析；.xlsm 为启用宏的工作簿（zip 结构与 xlsx 同源，excelize 可读）；
// .csv/.md/.txt 为纯文本直读。老版二进制格式 .doc/.xls/.ppt 结构复杂不支持，明确拒之门外
var aiDocExts = map[string]bool{
	".docx": true,
	".xlsx": true,
	".xlsm": true,
	".csv":  true,
	".md":   true,
	".txt":  true,
}

// aiDocXMLReplacer docx document.xml 标准实体反转义（&apos; 由 Word 生成器可能出现，一并处理）
var aiDocXMLReplacer = strings.NewReplacer(
	"&lt;", "<",
	"&gt;", ">",
	"&quot;", "\"",
	"&apos;", "'",
	"&#39;", "'",
	"&amp;", "&", // & 放最后，避免二次反转义
)

// aiParseDocxText 解析 docx：zip 读 word/document.xml → 按 <w:p> 段落切分 → 段内拼接 <w:t> 文本片段。
// 段落间换行，保留原文档段落结构；表格内容随 <w:t> 一并提取（每单元格即一段的一部分，够用版归口）
func aiParseDocxText(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("docx 文件结构非法")
	}
	var document string
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			rc, err := f.Open()
			if err != nil {
				return "", fmt.Errorf("docx 正文读取失败")
			}
			buf := new(bytes.Buffer)
			if _, err := buf.ReadFrom(rc); err != nil {
				rc.Close()
				return "", fmt.Errorf("docx 正文读取失败")
			}
			rc.Close()
			document = buf.String()
			break
		}
	}
	if document == "" {
		return "", fmt.Errorf("docx 缺少正文部分")
	}
	// 按 <w:p ...>...</w:p> 切分段落（(?s) 允许 . 匹配换行，正文为单行压缩 XML 时同样成立）
	paraRe := regexp.MustCompile(`(?s)<w:p\b[^>]*>.*?</w:p>|<w:p\b[^>]*/>`)
	textRe := regexp.MustCompile(`(?s)<w:t\b[^>]*>(.*?)</w:t>`)
	var lines []string
	for _, pm := range paraRe.FindAllStringSubmatch(document, -1) {
		var sb strings.Builder
		for _, tm := range textRe.FindAllStringSubmatch(pm[0], -1) {
			sb.WriteString(aiDocXMLReplacer.Replace(tm[1]))
		}
		line := strings.TrimSpace(sb.String())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n"), nil
}

// aiParseSpreadsheetRows 表格行 → 文本（单元格 " | " 连接，行间换行；与 Markdown 表格风格一致便于模型理解）
func aiSpreadsheetText(rows [][]string) string {
	var lines []string
	for _, row := range rows {
		line := strings.TrimSpace(strings.Join(row, " | "))
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// aiParseXlsxText 解析 xlsx/xlsm：excelize 读全部工作表，每个表带"## 工作表：名"标题行
func aiParseXlsxText(absPath string) (string, error) {
	f, err := excelize.OpenFile(absPath)
	if err != nil {
		return "", fmt.Errorf("表格文件解析失败")
	}
	defer f.Close()
	var parts []string
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil {
			continue // 单个表读取失败不影响整体（如隐藏图表表）
		}
		body := aiSpreadsheetText(rows)
		if body == "" {
			continue // 空表跳过
		}
		parts = append(parts, "## 工作表："+sheet+"\n"+body)
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("表格中没有可读取的内容")
	}
	return strings.Join(parts, "\n\n"), nil
}

// aiParseCsvText 解析 csv：encoding/csv 全量读取（变列数容错），格式同表格
func aiParseCsvText(absPath string) (string, error) {
	fp, err := os.Open(absPath)
	if err != nil {
		return "", fmt.Errorf("文件读取失败")
	}
	defer fp.Close()
	r := csv.NewReader(fp)
	r.FieldsPerRecord = -1 // 变列数容错：现实 CSV 常见列数不齐
	rows, err := r.ReadAll()
	if err != nil {
		return "", fmt.Errorf("CSV 格式非法")
	}
	text := aiSpreadsheetText(rows)
	if text == "" {
		return "", fmt.Errorf("CSV 文件为空")
	}
	return text, nil
}

// aiExtractDocText 文档文本提取归口：按扩展名分发解析器（absPath 为落盘文件绝对路径）
func aiExtractDocText(absPath, ext string) (string, error) {
	switch strings.ToLower(ext) {
	case ".docx":
		data, err := os.ReadFile(absPath)
		if err != nil {
			return "", fmt.Errorf("文档文件不存在或已清理")
		}
		return aiParseDocxText(data)
	case ".xlsx", ".xlsm":
		return aiParseXlsxText(absPath)
	case ".csv":
		return aiParseCsvText(absPath)
	case ".md", ".txt":
		data, err := os.ReadFile(absPath)
		if err != nil {
			return "", fmt.Errorf("文档文件不存在或已清理")
		}
		text := strings.TrimSpace(string(data))
		if text == "" {
			return "", fmt.Errorf("文档内容为空")
		}
		return text, nil
	}
	return "", fmt.Errorf("不支持的文档格式")
}

// aiLoadDocURLToPath 阶段四十五：文档 URL → 落盘绝对路径（路径安全归口：仅接受 /static/upload/ 下的纯文件名，
// 与 aiLoadImageDataURL 同规则，杜绝目录穿越）
func (s *Server) aiLoadDocURLToPath(url string) (absPath, ext string, err error) {
	const prefix = "/static/upload/"
	if !strings.HasPrefix(url, prefix) {
		return "", "", fmt.Errorf("文档路径不合法")
	}
	name := strings.TrimPrefix(url, prefix)
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", "", fmt.Errorf("文档路径不合法")
	}
	ext = strings.ToLower(filepath.Ext(name))
	if !aiDocExts[ext] {
		return "", "", fmt.Errorf("不支持的文档格式")
	}
	return filepath.Join(s.aiUploadDir(), filepath.Base(name)), ext, nil
}

// aiLoadDocText 阶段四十五：按信封 URL 解析落盘文档 → 提取文本 → 截断到 aiDocMaxChars
func (s *Server) aiLoadDocText(url string) (string, error) {
	absPath, ext, err := s.aiLoadDocURLToPath(url)
	if err != nil {
		return "", err
	}
	text, err := aiExtractDocText(absPath, ext)
	if err != nil {
		return "", err
	}
	if limit := aiDocMaxChars; limit > 0 {
		runes := []rune(text)
		if len(runes) > limit {
			text = string(runes[:limit]) + "\n…（文档过长，已截断到 " + strconv.Itoa(limit) + " 字）"
		}
	}
	return text, nil
}

// aiBuildDocPrompt 阶段四十五：文档问答最终提示词组装（文档全文信封 + 附言指令）
func aiBuildDocPrompt(name, text, question string) string {
	if strings.TrimSpace(name) == "" {
		name = "未命名文档"
	}
	var sb strings.Builder
	sb.WriteString("【用户上传文档：")
	sb.WriteString(name)
	sb.WriteString("】\n")
	sb.WriteString(text)
	sb.WriteString("\n【/用户上传文档】\n\n用户问题：")
	sb.WriteString(question)
	return sb.String()
}

// HandleAIDocUpload 阶段四十五：AI 文档问答专用上传 POST /upload/ai/doc?username=xxx&to_user=助手名
// 与 /upload/ai/image 同思路：不落库 im_message、不触会话摘要——提问正文由随后的 AI_CHAT 文档信封
// 消息统一落库（单条记录同时承载文档引用与附言，避免重复气泡）。
// 差异：文档问答不依赖多模态能力（服务端解析文本注入提示词），全部智能体开放；
// 上传时同步试解析（解析失败直接拒绝并清理落盘残留），保证提问时必然可提取文本
func (s *Server) HandleAIDocUpload(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	toAgent := r.URL.Query().Get("to_user")
	if username == "" || toAgent == "" {
		http.Error(w, "缺少参数", http.StatusBadRequest)
		return
	}
	if s.hub.Count(username) == 0 {
		http.Error(w, "用户未在线，请先登录", http.StatusUnauthorized)
		return
	}
	if aiAgentByName(toAgent) == nil {
		http.Error(w, "AI 助手不存在", http.StatusBadRequest)
		return
	}

	// 大小限制（与聊天文件同规则，读配置缺省 20MB）
	maxSize := int64(20 << 20)
	if s.cfg.MaxFileSize > 0 {
		maxSize = int64(s.cfg.MaxFileSize)
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "文件过大或解析失败", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "缺少文件", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 扩展名白名单校验（解析器按扩展名分发，非白名单一律拒绝）
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !aiDocExts[ext] {
		http.Error(w, "仅支持 docx/xlsx/xlsm/csv/md/txt 文档", http.StatusBadRequest)
		return
	}

	// 存储目录归口（与直传一致：UploadDir 配置优先，兜底 WebDir/static/upload）
	dir := s.aiUploadDir()
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		http.Error(w, "目录创建失败", http.StatusInternalServerError)
		return
	}
	b := make([]byte, 8)
	rand.Read(b)
	filename := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), hex.EncodeToString(b), ext)
	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		http.Error(w, "文件保存失败", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		os.Remove(dst) // 写入失败清理半截文件
		http.Error(w, "文件写入失败", http.StatusInternalServerError)
		return
	}
	out.Close()

	// 上传即试解析（服务端归口校验）：损坏/加密/空文档当场拒绝并清理落盘残留，
	// 避免提问时才发现文档不可读（届时用户已离开上传上下文，体验割裂）
	text, err := aiExtractDocText(dst, ext)
	if err != nil {
		os.Remove(dst)
		http.Error(w, "文档解析失败："+err.Error(), http.StatusBadRequest)
		return
	}

	url := "/static/upload/" + filename
	logger.Info("AI 文档问答上传: %s -> %s, %s (%d 字节, 提取 %d 字), url=%s", username, toAgent, header.Filename, header.Size, len([]rune(text)), url)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"url": url, "name": header.Filename, "size": header.Size, "chars": len([]rune(text))})
}
