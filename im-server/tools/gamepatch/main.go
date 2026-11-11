// GamePatchTool 游戏补丁制作工具（二期补丁方案，FileListGenerator 思路升级版）
// 职责：对比基准清单（服务端导出的已上架版本清单）与新版目录，生成增量补丁 patch.zip
//
//	（变更/新增文件 + patch.json 删除清单），交商户网页"补丁包"方式上传登记。
//
// 用法：
//
//	gametool diff   -base-list filelist.txt -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1] [-list 新版清单.txt] [--log log.txt]
//	gametool diff   -old <旧版目录> -new <新版目录> -out patch.zip [...]
//	gametool verify -base-list <清单> -patch patch.zip
//	gametool list   -dir <目录> -out filelist.txt
//
// 清单格式（与服务端导出接口同构）：0|rel_path|sha256|size（文件）；1|rel_path||size（目录行，读取时忽略）
// 所有进度/诊断信息输出到 stderr；--log 可同时落日志文件
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ============ 日志工具（stderr + 可选 tee 到日志文件） ============

type multiWriter struct {
	writers []io.Writer
}

func (m *multiWriter) Write(p []byte) (int, error) {
	for _, w := range m.writers {
		if _, err := w.Write(p); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// setupStderrLog 如果传了 --log，把 stderr tee 到目标文件；返回关闭函数（defer 用）
func setupStderrLog(logPath string) func() {
	if logPath == "" {
		return func() {}
	}
	f, err := os.Create(logPath)
	if err != nil {
		fmt.Fprintf(origStderr, "⚠ 无法创建日志文件 %s: %v\n", logPath, err)
		return func() {}
	}
	logWriters = []io.Writer{origStderr, f}
	fmt.Fprintf(origStderr, "日志已同步到: %s\n", logPath)
	return func() {
		f.Close()
		logWriters = []io.Writer{origStderr}
	}
}

var origStderr io.Writer = os.Stderr
var logWriters []io.Writer = []io.Writer{os.Stderr}

func stderr() io.Writer {
	return &multiWriter{writers: logWriters}
}

func stepf(format string, a ...interface{}) {
	fmt.Fprintln(stderr(), "▶ "+fmt.Sprintf(format, a...))
}
func infof(format string, a ...interface{}) {
	fmt.Fprintln(stderr(), "  "+fmt.Sprintf(format, a...))
}
func warnf(format string, a ...interface{}) {
	fmt.Fprintln(stderr(), "⚠ "+fmt.Sprintf(format, a...))
}
func donef(format string, a ...interface{}) {
	fmt.Fprintln(stderr(), "✓ "+fmt.Sprintf(format, a...))
}
func diffLine(mark, relPath string, extra ...string) {
	extraStr := ""
	if len(extra) > 0 {
		extraStr = "  (" + strings.Join(extra, ", ") + ")"
	}
	fmt.Fprintln(stderr(), "  "+mark+" "+relPath+extraStr)
}

// ============ 类型 ============

// patchJSON patch.zip 内嵌元数据（服务端登记时解析；change 必须与 zip 内条目一一对应）
type patchJSON struct {
	Format      int      `json:"format"`       // 1 = 当前格式
	BaseVersion string   `json:"base_version"` // 基底版本号（可空=未指定，登记时以请求为准）
	Version     string   `json:"version"`      // 补丁版本号（可空）
	Change      []string `json:"change"`       // 变更+新增文件相对路径（即 zip 内全部游戏文件条目）
	Delete      []string `json:"delete"`       // 删除文件相对路径
}

type fileMeta struct {
	rel  string
	sha  string
	size int64
}

// fileDiffResult 差异详情（给诊断输出用）
type fileDiffResult struct {
	rel      string
	kind     string // "新增" | "变更"
	reason   string // "路径缺失" | "SHA256 不同" | "大小不同"
	baseSize int64  // 仅变更时有值
	newSize  int64
	baseSHA  string
	newSHA   string
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "diff":
		err = cmdDiff(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "list":
		err = cmdList(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		usage()
		err = fmt.Errorf("未知命令: %s", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(stderr(), "✗ 错误: "+err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`GamePatchTool 游戏补丁制作工具
用法:
  gametool diff   -base-list <清单> -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1] [-list 新版清单.txt] [--log log.txt]
  gametool diff   -old <旧版目录>   -new <新版目录> -out patch.zip [...]
  gametool verify -base-list <清单> -patch patch.zip
  gametool list   -dir <目录> -out filelist.txt
清单格式: 0|rel_path|sha256|size（文件）  1|rel_path||size（目录行，忽略）
所有进度/诊断信息输出到 stderr；--log 可同时落日志文件。
`)
}

// ============ list：目录 → 清单 ============

func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	dir := fs.String("dir", "", "要扫描的目录")
	out := fs.String("out", "filelist.txt", "输出清单文件")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dir == "" {
		return fmt.Errorf("缺少 -dir 参数")
	}
	stepf("扫描目录: %s", *dir)
	files, err := scanDir(*dir)
	if err != nil {
		return err
	}
	infof("扫描完成：发现 %d 个文件，总大小 %s", len(files), humanSize(sumSize(files)))
	if err := writeFileList(*out, files); err != nil {
		return err
	}
	donef("清单已写入: %s", *out)
	return nil
}

// ============ diff：基准 → 补丁 ============

func cmdDiff(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	baseList := fs.String("base-list", "", "基准清单文件（服务端导出的已上架版本清单，主模式）")
	oldDir := fs.String("old", "", "旧版目录（离线备选基准，与 -base-list 二选一）")
	newDir := fs.String("new", "", "新版目录")
	out := fs.String("out", "patch.zip", "输出补丁包")
	baseVer := fs.String("base", "", "基底版本号（写入 patch.json，可空）")
	newVer := fs.String("ver", "", "补丁版本号（写入 patch.json，可空）")
	newList := fs.String("list", "", "可选：同时输出新版完整清单文件")
	logPath := fs.String("log", "", "可选：把完整日志同时写入文件")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *newDir == "" {
		return fmt.Errorf("缺少 -new 新版目录")
	}
	if (*baseList == "") == (*oldDir == "") {
		return fmt.Errorf("-base-list 与 -old 必须二选一")
	}

	// 设置日志 tee
	closeLog := setupStderrLog(*logPath)
	defer closeLog()

	fmt.Fprintln(stderr(), strings.Repeat("=", 50))
	fmt.Fprintln(stderr(), "  GamePatchTool diff 模式")
	fmt.Fprintln(stderr(), strings.Repeat("=", 50))

	// ===== Step 1: 加载基准 =====
	stepf("[1/4] 加载基准...")
	base := map[string]fileMeta{}
	var baseSrc string
	if *baseList != "" {
		stepf("读取基准清单: %s", *baseList)
		var err error
		base, err = readFileListWithProgress(*baseList)
		if err != nil {
			return fmt.Errorf("读取基准清单失败: %w", err)
		}
		baseSrc = "清单文件"
	} else {
		stepf("扫描旧版基准目录: %s", *oldDir)
		files, err := scanDir(*oldDir)
		if err != nil {
			return fmt.Errorf("扫描旧版目录失败: %w", err)
		}
		for _, f := range files {
			base[f.rel] = f
		}
		baseSrc = "旧版目录"
	}
	var baseSize int64
	for _, b := range base {
		baseSize += b.size
	}
	donef("基准加载完成：来源=%s，文件数=%d，总大小=%s", baseSrc, len(base), humanSize(baseSize))

	// ===== Step 2: 扫描新版 =====
	stepf("[2/4] 扫描新版目录: %s", *newDir)
	newFiles, err := scanDirWithProgress(*newDir)
	if err != nil {
		return fmt.Errorf("扫描新版目录失败: %w", err)
	}
	var newSize int64
	for _, f := range newFiles {
		newSize += f.size
	}
	donef("新版扫描完成：文件数=%d，总大小=%s", len(newFiles), humanSize(newSize))

	newMap := map[string]fileMeta{}
	for _, f := range newFiles {
		newMap[f.rel] = f
	}

	// ===== Step 2.5: 智能路径对齐 =====
	// 问题场景：清单里路径是 luna/bdcap32.dll（带 slug 前缀），但 new 目录是 H:\xxx\luna\
	// 扫描得到的相对路径是 bdcap32.dll（不带前缀）。两边 key 对不上 → 全部判为新增。
	// 解决方案：如果 base 所有路径都有一个公共前缀段（如 luna/），而 new 没有这个前缀，
	// 则自动剥离 base 的公共前缀后重建 map，让后续 diff 正确对齐。
	stepf("路径对齐检测...")
	basePrefix := detectCommonPrefix(base)
	newPrefix := detectCommonPrefix(newMap)
	if basePrefix != "" && basePrefix != newPrefix {
		// 尝试剥离 basePrefix 看能不能匹配上 new 的路径
		origMatch := countMatches(base, newMap)
		baseStripped := stripPrefix(base, basePrefix)
		strippedMatch := countMatches(baseStripped, newMap)
		// 如果剥离后匹配率显著提升（> 10 个匹配 或 匹配率翻倍），就采用剥离版本
		if strippedMatch > origMatch && (strippedMatch >= 10 || strippedMatch > origMatch*2) {
			warnf("检测到基准清单路径带公共子目录前缀 `%s`，与新版目录不对齐", basePrefix)
			warnf("  原始匹配数: %d  →  剥离后匹配数: %d", origMatch, strippedMatch)
			base = baseStripped
			infof("已自动剥离基准清单的公共前缀 `%s`，继续对比", basePrefix)
			donef("路径对齐完成：基准路径已剥离前缀，文件数仍=%d", len(base))
		} else {
			infof("基准前缀 `%s` 匹配提升不明显（原始 %d / 剥离 %d），保留原始路径",
				basePrefix, origMatch, strippedMatch)
		}
	} else if basePrefix != "" {
		infof("基准清单公共前缀 `%s` 与新版一致，路径天然对齐", basePrefix)
	} else {
		infof("基准清单无公共前缀，路径天然对齐")
	}

	// ===== Step 3: 差异对比 =====
	stepf("[3/4] 差异对比...")
	var diffs []fileDiffResult
	for _, f := range newFiles {
		b, ok := base[f.rel]
		if !ok {
			diffs = append(diffs, fileDiffResult{
				rel: f.rel, kind: "新增", reason: "路径不在基准清单",
				newSize: f.size, newSHA: f.sha,
			})
		} else if b.size != f.size {
			diffs = append(diffs, fileDiffResult{
				rel: f.rel, kind: "变更", reason: "大小不同",
				baseSize: b.size, newSize: f.size,
				baseSHA: b.sha, newSHA: f.sha,
			})
		} else if b.sha != f.sha {
			diffs = append(diffs, fileDiffResult{
				rel: f.rel, kind: "变更", reason: "SHA256 不同",
				baseSize: b.size, newSize: f.size,
				baseSHA: b.sha, newSHA: f.sha,
			})
		}
	}
	var del []fileMeta
	for rel, b := range base {
		if _, ok := newMap[rel]; !ok {
			del = append(del, b)
		}
	}
	sort.Slice(diffs, func(i, j int) bool { return diffs[i].rel < diffs[j].rel })
	sort.Slice(del, func(i, j int) bool { return del[i].rel < del[j].rel })

	// 统计
	addCount := 0
	changeCount := 0
	for _, d := range diffs {
		if d.kind == "新增" {
			addCount++
		} else {
			changeCount++
		}
	}

	// 打印差异详情（最多 30 条）
	maxShow := 30
	if len(diffs) > 0 {
		infof("差异详情（新增 %d，变更 %d，共 %d 项；最多显示前 %d 项）：",
			addCount, changeCount, len(diffs), maxShow)
		for i, d := range diffs {
			if i >= maxShow {
				infof("  ...（省略后 %d 项）", len(diffs)-maxShow)
				break
			}
			switch d.kind {
			case "新增":
				diffLine("+", d.rel, fmt.Sprintf("新增，大小 %s", humanSize(d.newSize)))
			case "变更":
				switch d.reason {
				case "大小不同":
					diffLine("~", d.rel, fmt.Sprintf("大小 %s → %s", humanSize(d.baseSize), humanSize(d.newSize)))
				case "SHA256 不同":
					diffLine("~", d.rel, fmt.Sprintf("大小相同 %s，SHA256 不同", humanSize(d.newSize)))
				}
			}
		}
	} else {
		donef("新版文件与基准完全一致（无新增/变更）")
	}
	if len(del) > 0 {
		infof("删除文件（共 %d 项）：", len(del))
		for i, d := range del {
			if i < maxShow {
				diffLine("-", d.rel, fmt.Sprintf("大小 %s", humanSize(d.size)))
			} else if i == maxShow {
				infof("  ...（省略后 %d 项）", len(del)-maxShow)
			}
		}
	}

	// 转换为 change 列表
	var change []fileMeta
	for _, d := range diffs {
		if nf, ok := newMap[d.rel]; ok {
			change = append(change, nf)
		}
	}
	if len(change) == 0 && len(del) == 0 {
		donef("✅ 未检测到任何差异：新版与基准一致，无需生成补丁")
		return fmt.Errorf("未检测到任何差异：新版与基准一致，无需补丁")
	}

	// ===== Step 4: 打包 =====
	fmt.Fprintln(stderr())
	stepf("[4/4] 打包补丁...")
	pj := patchJSON{Format: 1, BaseVersion: *baseVer, Version: *newVer}
	for _, f := range change {
		pj.Change = append(pj.Change, f.rel)
	}
	for _, f := range del {
		pj.Delete = append(pj.Delete, f.rel)
	}
	pjBytes, err := json.MarshalIndent(&pj, "", "  ")
	if err != nil {
		return err
	}
	if err := os.Remove(*out); err != nil && !os.IsNotExist(err) {
		return err
	}
	zf, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer zf.Close()
	zw := zip.NewWriter(zf)
	if len(change) > 0 {
		for i, f := range change {
			pct := float64(i+1) / float64(len(change)) * 100
			fmt.Fprintf(stderr(), "  打包中 [%d/%d] (%5.1f%%) %s\n", i+1, len(change), pct, f.rel)
			w, err := zw.Create(f.rel)
			if err != nil {
				fmt.Fprintf(stderr(), "  ← 创建失败: %v\n", err)
				return err
			}
			src, err := os.Open(filepath.Join(*newDir, filepath.FromSlash(f.rel)))
			if err != nil {
				fmt.Fprintf(stderr(), "  ← 打开失败: %v\n", err)
				return err
			}
			if _, err := io.Copy(w, src); err != nil {
				src.Close()
				fmt.Fprintf(stderr(), "  ← 写入失败: %v\n", err)
				return err
			}
			src.Close()
		}
	}
	metaEntry, err := zw.Create("patch.json")
	if err != nil {
		return err
	}
	if _, err := metaEntry.Write(pjBytes); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := zf.Sync(); err != nil {
		return err
	}

	// 可选输出新版清单
	if *newList != "" {
		if err := writeFileList(*newList, newFiles); err != nil {
			return fmt.Errorf("输出新版清单失败: %w", err)
		}
		donef("新版清单已写入: %s", *newList)
	}

	// 最终汇总
	st, _ := os.Stat(*out)
	var chgSize int64
	for _, f := range change {
		chgSize += f.size
	}
	fmt.Fprintln(stderr())
	fmt.Fprintln(stderr(), strings.Repeat("=", 50))
	fmt.Fprintln(stderr(), "  补丁生成完成！")
	fmt.Fprintln(stderr(), strings.Repeat("=", 50))
	// 结果同时输出到 stdout（方便脚本捕获）
	fmt.Printf("patch_file=%s\n", *out)
	fmt.Printf("patch_size=%d\n", st.Size())
	fmt.Printf("change_count=%d\n", len(change))
	fmt.Printf("change_total_bytes=%d\n", chgSize)
	fmt.Printf("delete_count=%d\n", len(del))
	fmt.Printf("base_total_bytes=%d\n", baseSize)
	fmt.Fprintf(stderr(), "  补丁包大小:     %s\n", humanSize(st.Size()))
	fmt.Fprintf(stderr(), "  变更/新增文件:  %d 个（原文件大小合计 %s）\n", len(change), humanSize(chgSize))
	fmt.Fprintf(stderr(), "  删除文件:       %d 个\n", len(del))
	fmt.Fprintf(stderr(), "  基准版本:       %s（总大小 %s）\n", *baseVer, humanSize(baseSize))
	fmt.Fprintf(stderr(), "  补丁版本:       %s\n", *newVer)
	fmt.Fprintf(stderr(), "  打包路径:       %s\n", *out)
	if len(change) > 0 && baseSize > 0 {
		fmt.Fprintf(stderr(), "  体积节省:       全量的 %.1f%%（%.1fMB / %.1fMB 对比）\n",
			float64(st.Size())/float64(baseSize)*100,
			float64(chgSize)/(1<<20), float64(baseSize)/(1<<20))
	}
	fmt.Fprintln(stderr())
	return nil
}

// ============ verify：补丁结构复检 ============

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	baseList := fs.String("base-list", "", "基准清单文件")
	patch := fs.String("patch", "patch.zip", "补丁包")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *baseList == "" {
		return fmt.Errorf("缺少 -base-list 参数")
	}
	stepf("读取基准清单: %s", *baseList)
	base, err := readFileListWithProgress(*baseList)
	if err != nil {
		return fmt.Errorf("读取基准清单失败: %w", err)
	}
	donef("基准清单 %d 项", len(base))

	stepf("解析补丁包: %s", *patch)
	zr, err := zip.OpenReader(*patch)
	if err != nil {
		return fmt.Errorf("补丁包无法解析: %w", err)
	}
	defer zr.Close()

	var pj patchJSON
	entries := map[string]bool{}
	for _, f := range zr.File {
		if f.Name == "patch.json" {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			pjBytes, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return err
			}
			if err := json.Unmarshal(pjBytes, &pj); err != nil {
				return fmt.Errorf("patch.json 解析失败: %w", err)
			}
			if pj.Format != 1 {
				return fmt.Errorf("patch.json 格式版本不支持: %d", pj.Format)
			}
			continue
		}
		if pathUnsafe(f.Name) {
			return fmt.Errorf("补丁含非法路径条目: %s", f.Name)
		}
		entries[strings.ToLower(filepath.ToSlash(f.Name))] = true
	}

	infof("zip 内条目: %d 个（不含 patch.json）", len(entries))
	infof("patch.json: base_version=%q, version=%q, change=%d, delete=%d",
		pj.BaseVersion, pj.Version, len(pj.Change), len(pj.Delete))

	if len(pj.Change) == 0 && len(pj.Delete) == 0 {
		return fmt.Errorf("patch.json 无 change/delete 内容")
	}
	for _, c := range pj.Change {
		c = strings.ToLower(strings.TrimSpace(c))
		if !entries[c] {
			return fmt.Errorf("change 条目缺失于 zip: %s", c)
		}
		if _, ok := base[c]; ok {
			_ = ok
		}
	}
	delSet := map[string]bool{}
	for _, d := range pj.Delete {
		d = strings.ToLower(strings.TrimSpace(d))
		if delSet[d] {
			return fmt.Errorf("delete 重复: %s", d)
		}
		delSet[d] = true
		if _, ok := base[d]; !ok {
			return fmt.Errorf("delete 路径不在基准清单中: %s", d)
		}
		if entries[d] {
			return fmt.Errorf("delete 与 change 冲突: %s", d)
		}
	}
	donef("✅ 复检通过：change=%d, delete=%d, base_version=%q, version=%q",
		len(pj.Change), len(pj.Delete), pj.BaseVersion, pj.Version)
	return nil
}

// ============ 公共 ============

// detectCommonPrefix 检测 map 中所有路径的公共前缀（最后一段以 / 结尾，如 "luna/" 或空串 ""）
// 只取第一段（一个目录层级）作为对齐候选，避免误剥离真实的多级公共目录
func detectCommonPrefix(m map[string]fileMeta) string {
	if len(m) == 0 {
		return ""
	}
	var firstSeg string
	for rel := range m {
		if idx := strings.IndexByte(rel, '/'); idx >= 0 {
			firstSeg = rel[:idx+1] // 包含尾 /
		}
		break
	}
	if firstSeg == "" {
		return ""
	}
	for rel := range m {
		if !strings.HasPrefix(rel, firstSeg) {
			return ""
		}
	}
	return firstSeg
}

// countMatches 统计 a 和 b 的 key 交集数量
func countMatches(a, b map[string]fileMeta) int {
	n := 0
	for k := range a {
		if _, ok := b[k]; ok {
			n++
		}
	}
	return n
}

// stripPrefix 给 map 里所有 key 去掉 prefix 前缀（prefix 以 / 结尾，剥离后重建 map）
func stripPrefix(m map[string]fileMeta, prefix string) map[string]fileMeta {
	out := make(map[string]fileMeta, len(m))
	for k, v := range m {
		if strings.HasPrefix(k, prefix) {
			nk := strings.TrimPrefix(k, prefix)
			v.rel = nk
			out[nk] = v
		} else {
			out[k] = v
		}
	}
	return out
}

// scanDir 递归扫描目录（rel_path 归一 / + 小写，跳过临时文件与空文件——与服务端登记约定一致；
// 大小写归一是 Windows 文件系统大小写不敏感与 Go map 大小写敏感之间的桥接，防止同路径因大小写差异
// 被 diff 逻辑全量识别为"新增"导致生成完整补丁包）
func scanDir(root string) ([]fileMeta, error) {
	var files []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = strings.ToLower(filepath.ToSlash(rel))
		name := d.Name()
		if strings.HasSuffix(name, ".tmp") || strings.HasPrefix(name, "~$") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() <= 0 {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	out := make([]fileMeta, 0, len(files))
	for _, rel := range files {
		sha, size, err := hashFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, fmt.Errorf("哈希失败 %s: %w", rel, err)
		}
		out = append(out, fileMeta{rel: rel, sha: sha, size: size})
	}
	return out, nil
}

// scanDirWithProgress 带进度的目录扫描（stdout 实时打印进度百分比）
func scanDirWithProgress(root string) ([]fileMeta, error) {
	// Phase A: Walk 收集文件列表
	stepf("阶段 A: 收集文件列表...")
	var files []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = strings.ToLower(filepath.ToSlash(rel))
		name := d.Name()
		if strings.HasSuffix(name, ".tmp") || strings.HasPrefix(name, "~$") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() <= 0 {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	donef("阶段 A 完成：发现 %d 个文件，开始哈希计算...", len(files))

	// Phase B: 逐文件哈希 + 进度
	stepf("阶段 B: 计算 SHA256 哈希...")
	out := make([]fileMeta, 0, len(files))
	for i, rel := range files {
		pct := float64(i+1) / float64(len(files)) * 100
		fmt.Fprintf(stderr(), "  [%d/%d] (%5.1f%%) %s\r", i+1, len(files), pct, rel)
		sha, size, err := hashFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			fmt.Fprintln(stderr())
			return nil, fmt.Errorf("哈希失败 %s: %w", rel, err)
		}
		out = append(out, fileMeta{rel: rel, sha: sha, size: size})
	}
	fmt.Fprintln(stderr())
	donef("阶段 B 完成：%d 个文件哈希计算完毕", len(files))
	return out, nil
}

// readFileList 解析清单文件（0|rel|sha|size 文件行；1|... 目录行忽略；# 注释行忽略；
// rel_path 统一转小写以匹配 scanDir 的 Windows 大小写归一策略，确保 diff 时两侧 key 对齐）
func readFileList(path string) (map[string]fileMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m := map[string]fileMeta{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(line, "\r")
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 || parts[0] != "0" {
			continue
		}
		rel := strings.ToLower(strings.TrimSpace(parts[1]))
		sha := strings.ToLower(strings.TrimSpace(parts[2]))
		size, err := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		if err != nil || rel == "" || len(sha) != 64 || size <= 0 {
			continue
		}
		m[rel] = fileMeta{rel: rel, sha: sha, size: size}
	}
	if len(m) == 0 {
		return nil, fmt.Errorf("清单无有效文件行: %s", path)
	}
	return m, nil
}

// readFileListWithProgress 带进度的清单读取
func readFileListWithProgress(path string) (map[string]fileMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	totalLines := len(strings.Split(string(data), "\n"))
	infof("读取 %d 行...", totalLines)

	m := map[string]fileMeta{}
	skipped := 0
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimRight(line, "\r")
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			skipped++
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 4 || parts[0] != "0" {
			skipped++
			continue
		}
		rel := strings.ToLower(strings.TrimSpace(parts[1]))
		sha := strings.ToLower(strings.TrimSpace(parts[2]))
		size, err := strconv.ParseInt(strings.TrimSpace(parts[3]), 10, 64)
		if err != nil || rel == "" || len(sha) != 64 || size <= 0 {
			skipped++
			continue
		}
		m[rel] = fileMeta{rel: rel, sha: sha, size: size}
	}
	var totalSize int64
	for _, f := range m {
		totalSize += f.size
	}
	donef("清单解析完成：有效 %d 项，跳过 %d 行，总大小 %s", len(m), skipped, humanSize(totalSize))
	return m, nil
}

// writeFileList 输出清单（0|rel|sha|size 排序行）
func writeFileList(out string, files []fileMeta) error {
	var b strings.Builder
	b.WriteString("# GamePatchTool filelist: type|rel_path|sha256|size\n")
	for _, f := range files {
		b.WriteString("0|" + f.rel + "|" + f.sha + "|" + strconv.FormatInt(f.size, 10) + "\n")
	}
	return os.WriteFile(out, []byte(b.String()), 0644)
}

func hashFile(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), size, nil
}

func sumSize(files []fileMeta) int64 {
	var s int64
	for _, f := range files {
		s += f.size
	}
	return s
}

// pathUnsafe 条目路径安检（与服务端 zipEntryUnsafe 同规则：绝对路径/盘符/..段拒绝）
func pathUnsafe(name string) bool {
	n := strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(n, "/") || strings.Contains(n, ":") {
		return true
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2fGB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.2fMB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.2fKB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}
