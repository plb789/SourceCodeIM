package main

// GamePatchTool 单元测试：diff 三类差异识别（增/删/改）、-base-list 与 -old 双基准一致、
// 清单读写格式、verify 结构复检、临时/空文件跳过、非法路径拒绝

import (
	"archive/zip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// TestDiffBaseListMode 主模式：服务端清单为基准，识别 增/删/改 三类差异
func TestDiffBaseListMode(t *testing.T) {
	dir := t.TempDir()
	// 旧版（基准清单内容）：keep.txt 不变 / changed.txt 改动 / gone.txt 删除
	mustWrite(t, filepath.Join(dir, "old", "keep.txt"), "KEEP")
	mustWrite(t, filepath.Join(dir, "old", "changed.txt"), "OLD")
	mustWrite(t, filepath.Join(dir, "old", "gone.txt"), "GONE")
	oldFiles, err := scanDir(filepath.Join(dir, "old"))
	if err != nil {
		t.Fatal(err)
	}
	baseFile := filepath.Join(dir, "base.txt")
	if err := writeFileList(baseFile, oldFiles); err != nil {
		t.Fatal(err)
	}
	// 新版：keep.txt 不变 / changed.txt 改动 / gone.txt 没有 / added.txt 新增（子目录）
	mustWrite(t, filepath.Join(dir, "new", "keep.txt"), "KEEP")
	mustWrite(t, filepath.Join(dir, "new", "changed.txt"), "NEW")
	mustWrite(t, filepath.Join(dir, "new", "sub", "added.txt"), "ADDED")

	patch := filepath.Join(dir, "patch.zip")
	if err := cmdDiff([]string{"-base-list", baseFile, "-new", filepath.Join(dir, "new"),
		"-out", patch, "-base", "1.0.0", "-ver", "1.0.1"}); err != nil {
		t.Fatalf("diff 失败: %v", err)
	}
	// 校验 patch.zip 结构
	zr, err := zip.OpenReader(patch)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	entries := map[string]bool{}
	var pj patchJSON
	for _, f := range zr.File {
		entries[f.Name] = true
		if f.Name == "patch.json" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if err := json.Unmarshal(b, &pj); err != nil {
				t.Fatalf("patch.json 解析失败: %v", err)
			}
		}
	}
	if !entries["changed.txt"] || !entries["sub/added.txt"] || entries["keep.txt"] || entries["gone.txt"] {
		t.Fatalf("zip 条目不符: %v", entries)
	}
	if pj.BaseVersion != "1.0.0" || pj.Version != "1.0.1" || pj.Format != 1 {
		t.Fatalf("patch.json 元数据不符: %+v", pj)
	}
	if strings.Join(pj.Change, ",") != "changed.txt,sub/added.txt" || strings.Join(pj.Delete, ",") != "gone.txt" {
		t.Fatalf("change/delete 不符: %+v", pj)
	}
	// 复检
	if err := cmdVerify([]string{"-base-list", baseFile, "-patch", patch}); err != nil {
		t.Fatalf("verify 应通过: %v", err)
	}
}

// TestDiffOldDirMode 离线模式：本地旧目录基准应与清单基准产出一致
func TestDiffOldDirMode(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "old", "a.txt"), "A1")
	mustWrite(t, filepath.Join(dir, "old", "b.txt"), "B")
	mustWrite(t, filepath.Join(dir, "new", "a.txt"), "A2")
	mustWrite(t, filepath.Join(dir, "new", "b.txt"), "B")
	oldFiles, err := scanDir(filepath.Join(dir, "old"))
	if err != nil {
		t.Fatal(err)
	}
	baseFile := filepath.Join(dir, "base.txt")
	if err := writeFileList(baseFile, oldFiles); err != nil {
		t.Fatal(err)
	}
	p1, p2 := filepath.Join(dir, "p1.zip"), filepath.Join(dir, "p2.zip")
	if err := cmdDiff([]string{"-base-list", baseFile, "-new", filepath.Join(dir, "new"), "-out", p1}); err != nil {
		t.Fatal(err)
	}
	if err := cmdDiff([]string{"-old", filepath.Join(dir, "old"), "-new", filepath.Join(dir, "new"), "-out", p2}); err != nil {
		t.Fatal(err)
	}
	// 结构化比对两模式的 patch.json（zip 内容压缩，不能直接字符串匹配）
	getPJ := func(p string) patchJSON {
		t.Helper()
		zr, err := zip.OpenReader(p)
		if err != nil {
			t.Fatal(err)
		}
		defer zr.Close()
		var pj patchJSON
		for _, f := range zr.File {
			if f.Name == "patch.json" {
				rc, _ := f.Open()
				b, _ := io.ReadAll(rc)
				rc.Close()
				if err := json.Unmarshal(b, &pj); err != nil {
					t.Fatal(err)
				}
			}
		}
		return pj
	}
	j1, j2 := getPJ(p1), getPJ(p2)
	if strings.Join(j1.Change, ",") != "a.txt" || strings.Join(j2.Change, ",") != "a.txt" {
		t.Fatalf("两模式均应识别 a.txt 变更: %+v vs %+v", j1, j2)
	}
	if len(j1.Delete) != 0 || len(j2.Delete) != 0 {
		t.Fatalf("不应有删除: %+v vs %+v", j1, j2)
	}
}

// TestScanDirSkip 临时文件/空文件跳过
func TestScanDirSkip(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "ok.txt"), "OK")
	mustWrite(t, filepath.Join(dir, "junk.tmp"), "TMP")
	mustWrite(t, filepath.Join(dir, "~$lock"), "LOCK")
	mustWrite(t, filepath.Join(dir, "empty.txt"), "")
	files, err := scanDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].rel != "ok.txt" {
		t.Fatalf("应仅保留 ok.txt，实得: %+v", files)
	}
}

// TestVerifyRejects 结构异常拒绝：delete 不在基准 / 路径穿越
func TestVerifyRejects(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "base", "x.txt"), "X")
	baseFiles, err := scanDir(filepath.Join(dir, "base"))
	if err != nil {
		t.Fatal(err)
	}
	baseFile := filepath.Join(dir, "base.txt")
	if err := writeFileList(baseFile, baseFiles); err != nil {
		t.Fatal(err)
	}
	// delete 路径不在基准 → verify 拒绝
	mustWrite(t, filepath.Join(dir, "w", "patch.json"), `{"format":1,"change":["x.txt"],"delete":["nope.txt"]}`)
	mustWrite(t, filepath.Join(dir, "w", "x.txt"), "NEW")
	if err := zipDir(t, filepath.Join(dir, "w"), filepath.Join(dir, "bad1.zip")); err != nil {
		t.Fatal(err)
	}
	if err := cmdVerify([]string{"-base-list", baseFile, "-patch", filepath.Join(dir, "bad1.zip")}); err == nil {
		t.Fatal("delete 不在基准应被拒绝")
	}
	// zip 条目路径穿越 → verify 拒绝（构造含 .. 的 zip）
	zout := filepath.Join(dir, "bad2.zip")
	zf, err := os.Create(zout)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(zf)
	w, _ := zw.Create("../evil.txt")
	w.Write([]byte("pwn"))
	w2, _ := zw.Create("patch.json")
	w2.Write([]byte(`{"format":1,"change":["../evil.txt"],"delete":[]}`))
	zw.Close()
	zf.Close()
	if err := cmdVerify([]string{"-base-list", baseFile, "-patch", zout}); err == nil {
		t.Fatal("路径穿越条目应被拒绝")
	}
}

// TestReadFileList 清单格式：目录行/注释/非法行忽略
func TestReadFileList(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte(strings.Join([]string{
		"# comment",
		"0|a.txt|" + strings.Repeat("a", 64) + "|12",
		"1|subdir||0",
		"9|bad||x",
		"",
	}, "\n")), 0644)
	m, err := readFileList(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 1 {
		t.Fatalf("应仅 1 个有效文件行: %+v", m)
	}
	if f, ok := m["a.txt"]; !ok || f.size != 12 {
		t.Fatalf("a.txt 解析不符: %+v", f)
	}
}

func zipDir(t *testing.T, src, out string) error {
	t.Helper()
	zf, err := os.Create(out)
	if err != nil {
		return err
	}
	defer zf.Close()
	zw := zip.NewWriter(zf)
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		w, err := zw.Create(filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	})
}
