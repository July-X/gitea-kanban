//go:build windows

package git

import (
	"sync"
	"time"
)

// windows 平台无 unix.Flock 等价物（Windows 用 LockFileEx 等）。
//
// v0.4.0 设计（user 拍板 2026-07-02）：windows 暂不实现跨进程文件锁，
// 仅靠内存级 pathLocks sync.Mutex 保护同进程并发。
// 调用方需要自行保证单用户单实例（v0.8.0 在 Wails 单窗口下天然满足）。
//
// 如未来需要 windows 跨进程锁，可用 golang.org/x/sys/windows LockFileEx 实现。

// pathLocks 内存级 per-path 锁（保护同进程内并发）
//
// windows 平台复制一份（lock.go 在 !windows build tag 下）。
// 运行时不会跨平台共享，但每个 build 单独编译时各自保留自己的一份。
var pathLocks sync.Map // map[string]*sync.Mutex

// staleGitLockAge windows 也保持一致（cleanupStaleGitLock 是 stub 但常量要存在）
const staleGitLockAge = 10 * time.Minute

func lockPath(localPath string) (func(), error) {
	v, _ := pathLocks.LoadOrStore(localPath, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return func() { mu.Unlock() }, nil
}

func cleanupStaleGitLock(localPath, name string) error {
	// windows 暂不实现 stale lock cleanup（同 unix 平台行为，依赖调用方定期检查）
	return nil
}
