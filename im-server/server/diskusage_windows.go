//go:build windows

package server

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

// dirDiskUsage 查询目录所在卷的空间水位（Windows：GetDiskFreeSpaceEx，返回字节）
// dir 必须为已存在的目录；返回 (总量, 剩余)
// 剩余取 AvailableToCaller（当前用户可用，含配额语义）——与 unix 侧 Statfs Bavail 同口径，
// 两平台使用率计算一致（不取 TotalFreeBytes：其含系统保留空间，会低估使用率）
func dirDiskUsage(dir string) (total, free int64, err error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return 0, 0, err
	}
	root := filepath.VolumeName(abs) + `\`
	var availBytes, totalBytes, freeBytes uint64
	if err = windows.GetDiskFreeSpaceEx(
		windows.StringToUTF16Ptr(root), &availBytes, &totalBytes, &freeBytes); err != nil {
		return 0, 0, err
	}
	return int64(totalBytes), int64(availBytes), nil
}
