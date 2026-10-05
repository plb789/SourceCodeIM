// appchecksum：安装包校验和生成工具（客户端更新"外部URL"发布辅助）
//
// 用途：对安装包文件（.exe/.apk）一键计算后台「客户端更新 - 外部URL」登记所需的三项数据：
//  1. sha256（十六进制）→ 填入后台"sha256"框（APP/PC 通用，推荐）
//  2. sha512 base64     → 填入后台"sha512 base64"框（PC 备选，一般可空）
//  3. 文件大小（字节）  → 填入后台"文件大小"框
//
// 用法：双击运行后把安装包拖进窗口按回车；或直接把文件拖到本程序图标上。
// 实现说明：流式一次读盘同步计算 sha256+sha512（大文件内存友好），实时进度反馈；
// 结果可一键复制到剪贴板（Windows API，CF_UNICODETEXT）。
package main

import (
	"bufio"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// ===== Windows 控制台/剪贴板 API（纯标准库 syscall，不引第三方依赖）=====

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	user32           = syscall.NewLazyDLL("user32.dll")
	procSetOutCP     = kernel32.NewProc("SetConsoleOutputCP")
	procSetInCP      = kernel32.NewProc("SetConsoleCP")
	procSetTitle     = kernel32.NewProc("SetConsoleTitleW")
	procGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procGlobalLock   = kernel32.NewProc("GlobalLock")
	procGlobalUnlock = kernel32.NewProc("GlobalUnlock")
	procGlobalFree   = kernel32.NewProc("GlobalFree")
	procOpenClip     = user32.NewProc("OpenClipboard")
	procCloseClip    = user32.NewProc("CloseClipboard")
	procEmptyClip    = user32.NewProc("EmptyClipboard")
	procSetClipData  = user32.NewProc("SetClipboardData")
)

const (
	gmemMoveable   = 0x0002
	cfUnicodeText  = 13
	clipRetryCount = 5
	clipRetryDelay = 100 * time.Millisecond
	copyBufSize    = 1 << 20 // 1MB 流式缓冲
	progressStepMB = 8       // 进度刷新粒度（MB），避免刷屏
)

// setupConsole 控制台输出/输入代码页切换为 UTF-8（Go 字符串原生 UTF-8，
// 缺省 936 代码页下中文乱码；Win10+ 对 65001 支持稳定），并设置窗口标题
func setupConsole() {
	procSetOutCP.Call(65001)
	procSetInCP.Call(65001)
	if title, err := syscall.UTF16PtrFromString("安装包校验和生成工具"); err == nil {
		procSetTitle.Call(uintptr(unsafe.Pointer(title)))
	}
}

// copyToClipboard 写入剪贴板（CF_UNICODETEXT；OpenClipboard 可能被其他程序短暂占用，重试）
func copyToClipboard(text string) error {
	u16, err := syscall.UTF16FromString(text) // 含结尾 \0
	if err != nil {
		return err
	}
	size := len(u16) * 2
	var opened uintptr
	for i := 0; i < clipRetryCount; i++ {
		r, _, _ := procOpenClip.Call(0)
		if r != 0 {
			opened = r
			break
		}
		time.Sleep(clipRetryDelay)
	}
	if opened == 0 {
		return errors.New("剪贴板被占用，打开失败")
	}
	defer procCloseClip.Call()
	if r, _, _ := procEmptyClip.Call(); r == 0 {
		return errors.New("清空剪贴板失败")
	}
	h, _, _ := procGlobalAlloc.Call(gmemMoveable, uintptr(size))
	if h == 0 {
		return errors.New("内存分配失败")
	}
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 {
		procGlobalFree.Call(h)
		return errors.New("内存锁定失败")
	}
	dst := unsafe.Slice((*byte)(ptrFromUintptr(p)), size)
	copy(dst, unsafe.Slice((*byte)(unsafe.Pointer(&u16[0])), size))
	procGlobalUnlock.Call(h)
	if r, _, _ := procSetClipData.Call(cfUnicodeText, h); r == 0 {
		procGlobalFree.Call(h) // SetClipboardData 失败时所有权仍在调用方，需释放
		return errors.New("写入剪贴板失败")
	}
	return nil // 成功后系统接管内存，勿再 GlobalFree
}

// ptrFromUintptr 把 Windows API 返回的 uintptr 指针转为 unsafe.Pointer
// （经 &v 二次取址转换，规避 vet 的 unsafeptr 误报；指针仅用于 API 约定范围内的读写）
func ptrFromUintptr(v uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&v))
}

// progressWriter 流式哈希期间的实时进度（\r 原位刷新，完成后由调用方换行清行）
type progressWriter struct {
	total  int64
	done   int64
	marked int64
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.done >= p.total && p.marked >= p.total && p.total > 0 {
		return len(b), nil // 已到末尾且进度已刷满，避免重复打印
	}
	if p.done-p.marked >= progressStepMB*1024*1024 || p.done >= p.total {
		if p.total > 0 {
			fmt.Printf("\r  计算进度: %3d%%  (%s / %s)   ", p.done*100/p.total, humanSize(p.done), humanSize(p.total))
		} else {
			fmt.Printf("\r  已处理: %s   ", humanSize(p.done))
		}
		p.marked = p.done
	}
	return len(b), nil
}

func humanSize(n int64) string {
	const k = 1024
	switch {
	case n >= k*k*k:
		return fmt.Sprintf("%.2f GB", float64(n)/k/k/k)
	case n >= k*k:
		return fmt.Sprintf("%.2f MB", float64(n)/k/k)
	case n >= k:
		return fmt.Sprintf("%.2f KB", float64(n)/k)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// computeChecksums 一次读盘同步计算 sha256（hex）+ sha512（base64），流式不占大内存
func computeChecksums(path string) (sha256Hex, sha512B64 string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", "", 0, err
	}
	size = st.Size()
	h256 := sha256.New()
	h512 := sha512.New()
	pw := &progressWriter{total: size}
	if _, err = io.CopyBuffer(io.MultiWriter(h256, h512, pw), f, make([]byte, copyBufSize)); err != nil {
		return "", "", 0, err
	}
	fmt.Println("\r  计算进度: 100%                                  ")
	return hex.EncodeToString(h256.Sum(nil)), base64.StdEncoding.EncodeToString(h512.Sum(nil)), size, nil
}

// normalizePath 清理拖入/手输路径（去引号、去首尾空白；控制台拖入路径自带引号）
func normalizePath(raw string) string {
	return strings.Trim(strings.TrimSpace(raw), `"`)
}

// readLine 读一行用户输入
func readLine(r *bufio.Reader) string {
	line, _ := r.ReadString('\n')
	return strings.TrimRight(line, "\r\n")
}

func printHeader() {
	fmt.Println()
	fmt.Println("==================================================")
	fmt.Println("  安装包校验和生成工具（外链更新发布辅助）")
	fmt.Println("==================================================")
	fmt.Println("  填入后台「客户端更新 - 外部URL」弹窗对应输入框：")
	fmt.Println("  ① sha256（十六进制）  ② sha512 base64  ③ 文件大小（字节）")
	fmt.Println("==================================================")
}

func main() {
	setupConsole()
	stdin := bufio.NewReader(os.Stdin)

	// 支持拖拽启动：把文件拖到 exe 图标上，参数即路径；用一次即清，循环时改由窗口拖入
	var argPath string
	if len(os.Args) > 1 {
		argPath = normalizePath(os.Args[1])
		os.Args = os.Args[:1]
	}

	for {
		printHeader()
		var path string
		for {
			if argPath != "" {
				path = argPath
				argPath = ""
			} else {
				fmt.Println()
				fmt.Println("请把安装包文件（.exe/.apk）拖到本窗口，然后按回车：")
				fmt.Print("  > ")
				path = normalizePath(readLine(stdin))
			}
			if path == "" {
				continue
			}
			st, err := os.Stat(path)
			if err != nil || st.IsDir() {
				fmt.Printf("  [错误] 文件不存在或不可读：%s\n", path)
				continue
			}
			break
		}

		// 后台外链登记按 URL 路径后缀校验平台，提前提醒免得登记录入被拒
		switch strings.ToLower(filepath.Ext(path)) {
		case ".exe", ".apk":
		default:
			fmt.Println("  [提醒] 后台外链登记要求 .exe（PC）或 .apk（APP），当前后缀不在其中")
		}

		fmt.Printf("\n  正在计算：%s\n", path)
		sha256Hex, sha512B64, size, err := computeChecksums(path)
		if err != nil {
			fmt.Printf("  [错误] 计算失败：%v\n", err)
			continue
		}

		fmt.Println()
		fmt.Println("  --------------------------------------------------")
		fmt.Println("  ① sha256（十六进制）——填入后台「sha256」框：")
		fmt.Printf("     %s\n", sha256Hex)
		fmt.Println()
		fmt.Println("  ② sha512 base64 ——填入后台「sha512 base64」框（一般可空）：")
		fmt.Printf("     %s\n", sha512B64)
		fmt.Println()
		fmt.Println("  ③ 文件大小（字节）——填入后台「文件大小」框：")
		fmt.Printf("     %s\n", strconv.FormatInt(size, 10))
		fmt.Printf("     (%s)\n", humanSize(size))
		fmt.Println("  --------------------------------------------------")

		fmt.Println()
		fmt.Print("  复制到剪贴板： 1=①sha256  2=②sha512  3=③大小  直接回车=不复制  > ")
		switch strings.TrimSpace(readLine(stdin)) {
		case "1":
			if err := copyToClipboard(sha256Hex); err != nil {
				fmt.Printf("  [错误] %v\n", err)
			} else {
				fmt.Println("  ✓ 已复制 sha256 到剪贴板")
			}
		case "2":
			if err := copyToClipboard(sha512B64); err != nil {
				fmt.Printf("  [错误] %v\n", err)
			} else {
				fmt.Println("  ✓ 已复制 sha512 base64 到剪贴板")
			}
		case "3":
			if err := copyToClipboard(strconv.FormatInt(size, 10)); err != nil {
				fmt.Printf("  [错误] %v\n", err)
			} else {
				fmt.Println("  ✓ 已复制文件大小到剪贴板")
			}
		}

		fmt.Println()
		fmt.Print("  直接回车=继续算下一个文件  N=退出  > ")
		if strings.EqualFold(strings.TrimSpace(readLine(stdin)), "N") {
			break
		}
	}
}
