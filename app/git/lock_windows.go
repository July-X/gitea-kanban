//go:build windows

package git

import (
	"fmt"
	"os"
	"path/filepath"
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

	// v0.8.0 修 windows CI：跟 unix 平台一致，先 MkdirAll parent dir
	//（早期版本漏了 → CloneRepo 测试 `___` repo 写 `___.lock` 失败 "path specified"）
	// unix 版本用 `os.O_CREATE|os.O_RDWR` + flock，windows 这里简化为
	// 占位文件（仅做跨进程可见性提示，无 flock 强保证）。
	lockFilePath := localPath + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockFilePath), 0o755); err != nil {
		return func() { mu.Unlock() }, fmt.Errorf("mkdir parent for lock: %w", err)
	}
	if _, err := os.Stat(lockFilePath); err != nil {
		if err := os.WriteFile(lockFilePath, []byte(fmt.Sprintf("pid=%d\ntime=%s\n", os.Getpid(), time.Now().Format(time.RFC3339))), 0o644); err != nil {
			return func() { mu.Unlock() }, fmt.Errorf("write lock file: %w", err)
		}
	}

	return func() { mu.Unlock() }, nil
}

func cleanupStaleGitLock(localPath, name string) error {
	// windows 跟 unix 一致：`.git/<name>` 而非 `localPath + ".lock"`
	//（修 v0.8.0 TestCleanupStaleGitLock_RemovesOldLock FAIL）
	lockFile := filepath.Join(localPath, ".git", name)
	info, err := os.Stat(lockFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // 不存在就跳过
		}
		return err
	}
	if time.Since(info.ModTime()) >= staleGitLockAge {
		if err := os.Remove(lockFile); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// 避免 unused import warnings（sync 和 time 都用于 pathLocks/staleGitLockAge，os/filepath 用于锁文件 IO）
var _ = filepath.Join
var _ = os.Getpid
