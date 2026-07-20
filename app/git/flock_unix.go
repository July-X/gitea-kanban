//go:build !windows

package git

import (
	"os"

	"golang.org/x/sys/unix"
)

// flockAcquire 在非 Windows 平台走 POSIX flock(2)。
//
// 语义：LOCK_EX 排他锁，跨进程互斥；同一进程内多次 LOCK_EX（同一 fd）会叠加引用计数，
// 需要对应次数的 LOCK_UN 才能完全释放——但本项目 lockPath 总是 OpenFile 后立即
// Acquire / Release，避免叠加，所以一次 LOCK_UN 即可。
func flockAcquire(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_EX)
}

// flockRelease 在非 Windows 平台走 POSIX flock(2) LOCK_UN。
func flockRelease(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}