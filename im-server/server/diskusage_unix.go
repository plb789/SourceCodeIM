//go:build !windows

package server

import (
	"golang.org/x/sys/unix"
)

// dirDiskUsage 查询目录所在文件系统的空间水位（Linux/Unix：Statfs，返回字节）
// dir 必须为已存在的目录；返回 (总量, 剩余)
func dirDiskUsage(dir string) (total, free int64, err error) {
	var st unix.Statfs_t
	if err = unix.Statfs(dir, &st); err != nil {
		return 0, 0, err
	}
	// Bavail（非特权可用块）比 Bfree 更贴近应用真实可写空间；按块大小换算字节
	bsize := int64(st.Bsize)
	return int64(st.Blocks) * bsize, int64(st.Bavail) * bsize, nil
}
