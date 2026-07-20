//go:build windows

package git

import (
	"os"

	"golang.org/x/sys/windows"
)

// flockAcquire 在 Windows 平台走 Win32 LockFileEx 排他锁。
//
// LockFileEx 语义与 POSIX flock 类似：跨进程互斥，但需要 overlapped 指针。
// 这里用零值 overlapped 同步锁整个文件（dwBytesLow=MaxInt32 / dwBytesHigh=0）。
//
// 参考：
//   - https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex
//   - golang.org/x/sys/windows.LockFileEx
func flockAcquire(f *os.File) error {
	handle := windows.Handle(f.Fd())
	var overlapped windows.Overlapped
	flags := uint32(0x00000002) // LOCKFILE_EXCLUSIVE_LOCK
	const maxUint32 = ^uint32(0)
	return windows.LockFileEx(handle, flags, 0, maxUint32, 0, &overlapped)
}

// flockRelease 在 Windows 平台走 Win32 UnlockFileEx。
//
// 与 LockFileEx 一一对应：overlapped / bytesLow / bytesHigh 必须一致。
// 失败仅记日志（lockPath 走 best-effort 释放，主流程不阻塞）。
func flockRelease(f *os.File) error {
	handle := windows.Handle(f.Fd())
	var overlapped windows.Overlapped
	const maxUint32 = ^uint32(0)
	return windows.UnlockFileEx(handle, 0, maxUint32, 0, &overlapped)
}