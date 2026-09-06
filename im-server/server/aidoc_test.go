package server

import (
	"archive/zip"
	"bytes"
	"fmt"
	"im-server/config"
	"os"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// 阶段四十五：AI 文档导出单元测试（表格解析 / Excel 生成 / Markdown→docx）

func TestParseMarkdownTables(t *testing.T) {
	md := "# 表格标题\n" +
		"| 姓名 | 年龄 | 备注 |\n" +
		"|:-----|-----:|------|\n" +
		"| 张三 | 25 | **组长** |\n" +
		"| 李四 | 30 | 含\\|竖线 |\n" +
		"\n" +
		"段落文字，后面还有第二个表格\n" +
		"| A | B |\n" +
		"|---|---|\n" +
		"| 1 | 2 |\n"
	tables := aiParseMarkdownTables(md)
	if len(tables) != 2 {
		t.Fatalf("应解析出 2 个表格，实际 %d", len(tables))
	}
	t1 := tables[0]
	if len(t1) != 3 || len(t1[0]) != 3 {
		t.Fatalf("表格1行列错误：%v", t1)
	}
	if t1[0][0] != "姓名" || t1[1][0] != "张三" || t1[2][1] != "30" {
		t.Fatalf("表格1单元格错误：%v", t1)
	}
	if t1[2][2] != "含|竖线" {
		t.Fatalf("转义竖线应还原：%q", t1[2][2])
	}
	t2 := tables[1]
	if len(t2) != 2 || t2[1][0] != "1" {
		t.Fatalf("表格2错误：%v", t2)
	}

	// 无表格：普通竖线文本不误判
	if n := len(aiParseMarkdownTables("普通文本 | 带 | 竖线但不是表格")); n != 0 {
		t.Fatalf("非表格不应解析出行，实际 %d", n)
	}
	// 缺表头（分隔行开头）不算表格
	if n := len(aiParseMarkdownTables("|---|---|\n| 1 | 2 |")); n != 0 {
		t.Fatalf("缺表头不应算表格，实际 %d", n)
	}
}

func TestExportExcelRoundTrip(t *testing.T) {
	tables := [][][]string{
		{{"姓名", "年龄"}, {"张三", "25"}, {"李四", "30"}},
		{{"列A", "列B"}, {"x", "y"}},
	}
	f := excelize.NewFile()
	for ti, rows := range tables {
		sheet := fmt.Sprintf("表格%d", ti+1)
		if ti == 0 {
			f.SetSheetName(f.GetSheetName(0), sheet)
		} else {
			f.NewSheet(sheet)
		}
		for ri, row := range rows {
			for ci, cell := range row {
				ref, _ := excelize.CoordinatesToCellName(ci+1, ri+1)
				f.SetCellValue(sheet, ref, cell)
			}
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	// 回读验证
	f2, err := excelize.OpenReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	sheets := f2.GetSheetList()
	if len(sheets) != 2 || sheets[0] != "表格1" || sheets[1] != "表格2" {
		t.Fatalf("sheet 名错误：%v", sheets)
	}
	v1, _ := f2.GetCellValue("表格1", "A2")
	if v1 != "张三" {
		t.Fatalf("单元格回读错误：%q", v1)
	}
	v2, _ := f2.GetCellValue("表格1", "B2")
	if v2 != "25" {
		t.Fatalf("单元格回读错误：%q", v2)
	}
}

func TestBuildDocx(t *testing.T) {
	md := "# 项目报告\n" +
		"## 一、概述\n" +
		"这是**加粗**段落，含 `code` 与 <xml> 特殊字符。\n" +
		"- 要点一\n" +
		"- 要点二\n" +
		"1. 步骤一\n" +
		"2. 步骤二\n" +
		"> 引用内容\n" +
		"| 列1 | 列2 |\n" +
		"|-----|-----|\n" +
		"| a< | b& |\n"
	blocks := aiParseMarkdownBlocks(md)
	// 期望：标题/标题/段落/2要点/2有序/引用/表格 = 9 块
	if len(blocks) != 9 {
		t.Fatalf("块数错误：%d（%+v）", len(blocks), blocks)
	}
	data, err := aiBuildDocx(blocks)
	if err != nil {
		t.Fatal(err)
	}
	// zip 结构校验
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("生成的 docx 不是合法 zip: %v", err)
	}
	names := map[string]bool{}
	var docXML string
	for _, f := range zr.File {
		names[f.Name] = true
		if f.Name == "word/document.xml" {
			rc, _ := f.Open()
			buf := new(bytes.Buffer)
			_, _ = buf.ReadFrom(rc)
			rc.Close()
			docXML = buf.String()
		}
	}
	for _, need := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml"} {
		if !names[need] {
			t.Fatalf("docx 缺少 %s", need)
		}
	}
	// XML 转义与结构校验
	if !strings.Contains(docXML, "&lt;xml&gt;") {
		t.Fatal("特殊字符未转义")
	}
	if !strings.Contains(docXML, "<w:tbl>") || !strings.Contains(docXML, "b&amp;") {
		t.Fatal("表格或转义缺失")
	}
	// 原：单 run 模板下编号与正文同处一个 <w:t>，直接断言 XML 连续串；
	// 现行内 run 拆分后编号与正文分属不同 <w:t>，改为回读拼接文本断言（语义等价）
	// if !strings.Contains(docXML, "1. 步骤一") || !strings.Contains(docXML, "2. 步骤二") {
	// 	t.Fatal("有序列表编号错误")
	// }
	// 原写法：if err != nil { Fatal } else { 断言 }，不符合 Go indent-error-flow 惯例，改为先 Fatal 后继续
	readBack, err := aiParseDocxText(data)
	if err != nil {
		t.Fatalf("回读 docx 失败: %v", err)
	}
	if !strings.Contains(readBack, "1. 步骤一") || !strings.Contains(readBack, "2. 步骤二") {
		t.Fatal("有序列表编号错误")
	}
	if strings.Contains(readBack, "**") || strings.Contains(readBack, "`") {
		t.Fatal("正文残留 Markdown 行内符号")
	}
	if !strings.Contains(docXML, "要点一") || !strings.Contains(docXML, "引用内容") {
		t.Fatal("列表/引用内容缺失")
	}
}

// ===== 阶段四十五 D：文档问答解析器单元测试 =====

// TestParseDocxText docx 文本提取：段落切分 / <w:t> 拼接 / 实体反转义 / 表格内容随提取
func TestParseDocxText(t *testing.T) {
	document := "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">" +
		"<w:body>" +
		"<w:p><w:r><w:t>项目报告标题</w:t></w:r></w:p>" +
		"<w:p><w:r><w:t>含特殊字符 a&lt;b &amp; c</w:t><w:t xml:space=\"preserve\"> 同段多片段</w:t></w:r></w:p>" +
		"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>年龄</w:t></w:r></w:p></w:tc></w:tr>" +
		"<w:tr><w:tc><w:p><w:r><w:t>张三</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>25</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
		"<w:p/>" +
		"</w:body></w:document>"
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	fw, _ := zw.Create("[Content_Types].xml")
	fw.Write([]byte("<Types/>"))
	fw, _ = zw.Create("word/document.xml")
	fw.Write([]byte(document))
	zw.Close()

	text, err := aiParseDocxText(buf.Bytes())
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if !strings.Contains(text, "项目报告标题") {
		t.Fatalf("标题段缺失: %q", text)
	}
	if !strings.Contains(text, "a<b & c") || !strings.Contains(text, "同段多片段") {
		t.Fatalf("实体反转义或多片段拼接错误: %q", text)
	}
	if !strings.Contains(text, "张三") || !strings.Contains(text, "25") {
		t.Fatalf("表格内容未提取: %q", text)
	}
	// 空段落（<w:p/>）不产出空行文本
	lines := strings.Split(text, "\n")
	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			t.Fatalf("空段落不应产出空行: %q", text)
		}
	}
}

// TestParseXlsxText xlsx 文本提取：多工作表 / 表标题 / 单元格连接
func TestParseXlsxText(t *testing.T) {
	f := excelize.NewFile()
	f.SetSheetName(f.GetSheetName(0), "人员")
	f.SetCellValue("人员", "A1", "姓名")
	f.SetCellValue("人员", "B1", "年龄")
	f.SetCellValue("人员", "A2", "张三")
	f.SetCellValue("人员", "B2", "25")
	f.NewSheet("统计")
	f.SetCellValue("统计", "A1", "DAU")
	f.SetCellValue("统计", "A2", "10000")
	path := t.TempDir() + "/测试.xlsx"
	if err := f.SaveAs(path); err != nil {
		t.Fatal(err)
	}
	text, err := aiParseXlsxText(path)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if !strings.Contains(text, "## 工作表：人员") || !strings.Contains(text, "## 工作表：统计") {
		t.Fatalf("工作表标题缺失: %q", text)
	}
	if !strings.Contains(text, "姓名 | 年龄") || !strings.Contains(text, "张三 | 25") {
		t.Fatalf("单元格连接格式错误: %q", text)
	}
}

// TestParseCsvAndMdText csv/md/txt 提取与空文档拒绝
func TestParseCsvAndMdText(t *testing.T) {
	dir := t.TempDir()

	csvPath := dir + "/数据.csv"
	if err := os.WriteFile(csvPath, []byte("名称,数量\r\n苹果,3\r\n香蕉,5\r\n"), 0644); err != nil {
		t.Fatal(err)
	}
	text, err := aiExtractDocText(csvPath, ".csv")
	if err != nil {
		t.Fatalf("csv 解析失败: %v", err)
	}
	if !strings.Contains(text, "名称 | 数量") || !strings.Contains(text, "苹果 | 3") || !strings.Contains(text, "香蕉 | 5") {
		t.Fatalf("csv 提取内容错误: %q", text)
	}

	mdPath := dir + "/说明.md"
	if err := os.WriteFile(mdPath, []byte("# 标题\n\n正文段落。"), 0644); err != nil {
		t.Fatal(err)
	}
	text, err = aiExtractDocText(mdPath, ".md")
	if err != nil || !strings.Contains(text, "# 标题") {
		t.Fatalf("md 提取错误: %q, err=%v", text, err)
	}

	// 空文档拒绝
	emptyPath := dir + "/空.txt"
	if err := os.WriteFile(emptyPath, []byte("   \n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := aiExtractDocText(emptyPath, ".txt"); err == nil {
		t.Fatal("空文档应返回错误")
	}
}

// TestAiBuildDocPrompt 文档信封提示词组装与截断
func TestAiBuildDocPrompt(t *testing.T) {
	prompt := aiBuildDocPrompt("报告.docx", "第一段内容\n第二段内容", "总结要点")
	if !strings.Contains(prompt, "【用户上传文档：报告.docx】") ||
		!strings.Contains(prompt, "【/用户上传文档】") ||
		!strings.Contains(prompt, "用户问题：总结要点") ||
		!strings.Contains(prompt, "第二段内容") {
		t.Fatalf("信封格式错误: %q", prompt)
	}
	// 空文件名兜底
	if p2 := aiBuildDocPrompt("", "内容", "问题"); !strings.Contains(p2, "未命名文档") {
		t.Fatalf("空文件名应兜底: %q", p2)
	}
}

// TestAiLoadDocTextTruncate 文档 URL 解析链路：路径安全 + 提取 + 截断归口
func TestAiLoadDocTextTruncate(t *testing.T) {
	dir := t.TempDir()
	srv := NewServer(&config.Config{UploadDir: dir})

	// 长文本 txt：超上限截断（保存/恢复全局上限，避免影响其他用例）
	content := strings.Repeat("字", 100)
	if err := os.WriteFile(dir+"/长文.txt", []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	old := aiDocMaxChars
	aiDocMaxChars = 10
	defer func() { aiDocMaxChars = old }()

	text, err := srv.aiLoadDocText("/static/upload/长文.txt")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	// 前缀保留 10 个"字"（提示语本身含"字"字，不能全串计数），且带截断提示
	if !strings.HasPrefix(text, strings.Repeat("字", 10)) {
		t.Fatalf("截断前缀错误: head=%q", []rune(text)[:12])
	}
	if !strings.Contains(text, "已截断到 10 字") {
		t.Fatalf("截断提示缺失: %q", text)
	}

	// 路径安全：非白名单目录 / 目录穿越 / 非法扩展名均拒绝
	for _, bad := range []string{"../长文.txt", "/static/upload/sub/../长文.txt", "/static/upload/长文.exe", "/other/长文.txt"} {
		if _, err := srv.aiLoadDocText(bad); err == nil {
			t.Fatalf("非法路径应拒绝: %s", bad)
		}
	}

	// 不存在的文件
	if _, err := srv.aiLoadDocText("/static/upload/不存在.txt"); err == nil {
		t.Fatal("不存在的文件应返回错误")
	}
}

// 原 TestWordExportNoMarkdownResidue（含用户反馈对话片段的回归测试）已按需求清理；
// Word 导出转换逻辑（aidoc.go 的 aiParseMarkdownBlocks / aiInlineRuns / aiBuildDocx）后续修改时
// 建议自行临时编写用例验证：**加粗** / • 列表 / 两位数编号 / 反引号 四类场景不残留原文符号。
