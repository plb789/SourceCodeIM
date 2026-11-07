// GamePatchTool 游戏补丁制作工具（二期补丁方案，FileListGenerator 思路升级版）
// 职责：对比基准清单（服务端导出的已上架版本清单）与新版目录，生成增量补丁 patch.zip
//
//	（变更/新增文件 + patch.json 删除清单），交商户网页"补丁包"方式上传登记。
//
// 用法：
//
//	gametool diff   -base-list filelist.txt -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1] [-list 新版清单.txt]
//	gametool diff   -old <旧版目录> -new <新版目录> -out patch.zip [...]          （离线备选：本地旧目录为基准）
//	gametool verify -base-list filelist.txt -patch patch.zip                       （复检补丁结构一致性）
//	gametool list   -dir <目录> -out filelist.txt                                  （清单：类型|相对路径|sha256|大小）
//
// 清单格式（与服务端导出接口同构）：0|rel_path|sha256|size（文件）；1|rel_path||size（目录行，读取时忽略）
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
		fmt.Fprintln(os.Stderr, "错误: "+err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`GamePatchTool 游戏补丁制作工具
用法:
  gametool diff   -base-list <清单> -new <新版目录> -out patch.zip [-base 1.0.0] [-ver 1.0.1] [-list 新版清单.txt]
  gametool diff   -old <旧版目录>   -new <新版目录> -out patch.zip [...]
  gametool verify -base-list <清单> -patch patch.zip
  gametool list   -dir <目录> -out filelist.txt
清单格式: 0|rel_path|sha256|size（文件）  1|rel_path||size（目录行，忽略）
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
	files, err := scanDir(*dir)
	if err != nil {
		return err
	}
	return writeFileList(*out, files)
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
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *newDir == "" {
		return fmt.Errorf("缺少 -new 新版目录")
	}
	if (*baseList == "") == (*oldDir == "") {
		return fmt.Errorf("-base-list 与 -old 必须二选一")
	}
	// 基准集合
	base := map[string]fileMeta{}
	if *baseList != "" {
		m, err := readFileList(*baseList)
		if err != nil {
			return fmt.Errorf("读取基准清单失败: %w", err)
		}
		base = m
	} else {
		files, err := scanDir(*oldDir)
		if err != nil {
			return fmt.Errorf("扫描旧版目录失败: %w", err)
		}
		for _, f := range files {
			base[f.rel] = f
		}
	}
	// 新版集合
	newFiles, err := scanDir(*newDir)
	if err != nil {
		return fmt.Errorf("扫描新版目录失败: %w", err)
	}
	newMap := map[string]fileMeta{}
	for _, f := range newFiles {
		newMap[f.rel] = f
	}
	// 三类差异（change=变更+新增，与 zip 条目一一对应）
	var change, del []fileMeta
	for _, f := range newFiles {
		b, ok := base[f.rel]
		if !ok || b.sha != f.sha || b.size != f.size {
			change = append(change, f)
		}
	}
	for rel, b := range base {
		if _, ok := newMap[rel]; !ok {
			del = append(del, b)
		}
	}
	sort.Slice(change, func(i, j int) bool { return change[i].rel < change[j].rel })
	sort.Slice(del, func(i, j int) bool { return del[i].rel < del[j].rel })
	if len(change) == 0 && len(del) == 0 {
		return fmt.Errorf("未检测到任何差异：新版与基准一致，无需补丁")
	}
	// 写 patch.json
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
	// 打包（变更文件 deflate + patch.json）
	if err := os.Remove(*out); err != nil && !os.IsNotExist(err) {
		return err
	}
	zf, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer zf.Close()
	zw := zip.NewWriter(zf)
	for _, f := range change {
		w, err := zw.Create(f.rel)
		if err != nil {
			return err
		}
		src, err := os.Open(filepath.Join(*newDir, filepath.FromSlash(f.rel)))
		if err != nil {
			return err
		}
		if _, err := io.Copy(w, src); err != nil {
			src.Close()
			return err
		}
		src.Close()
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
	}
	st, _ := os.Stat(*out)
	var baseSize int64
	for _, b := range base {
		baseSize += b.size
	}
	fmt.Printf("补丁已生成: %s (%s)\n", *out, humanSize(st.Size()))
	fmt.Printf("  变更/新增 %d 个, 删除 %d 个, 基准总量 %s\n", len(change), len(del), humanSize(baseSize))
	if len(change) > 0 && baseSize > 0 {
		fmt.Printf("  体积节省: 全量的 %.1f%%\n", float64(st.Size())/float64(baseSize)*100)
	}
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
	base, err := readFileList(*baseList)
	if err != nil {
		return fmt.Errorf("读取基准清单失败: %w", err)
	}
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
		entries[f.Name] = true
	}
	if len(pj.Change) == 0 && len(pj.Delete) == 0 {
		return fmt.Errorf("patch.json 无 change/delete 内容")
	}
	for _, c := range pj.Change {
		if !entries[c] {
			return fmt.Errorf("change 条目缺失于 zip: %s", c)
		}
		if _, ok := base[c]; ok {
			// 变更：允许（基准存在且哈希应不同，此处不强制复算）
			_ = ok
		}
	}
	delSet := map[string]bool{}
	for _, d := range pj.Delete {
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
	fmt.Printf("复检通过: change=%d delete=%d, base_version=%q version=%q\n",
		len(pj.Change), len(pj.Delete), pj.BaseVersion, pj.Version)
	return nil
}

// ============ 公共 ============

// scanDir 递归扫描目录（rel_path 归一 /，跳过临时文件与空文件——与服务端登记约定一致）
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
		rel = filepath.ToSlash(rel)
		name := d.Name()
		if strings.HasSuffix(name, ".tmp") || strings.HasPrefix(name, "~$") {
			fmt.Println("跳过临时文件: " + rel)
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Size() <= 0 {
			fmt.Println("跳过空文件: " + rel)
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

// readFileList 解析清单文件（0|rel|sha|size 文件行；1|... 目录行忽略；# 注释行忽略）
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
			continue // 目录行/包行/非法行忽略
		}
		rel, sha := parts[1], parts[2]
		size, err := strconv.ParseInt(parts[3], 10, 64)
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
