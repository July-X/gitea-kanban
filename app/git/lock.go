package git

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// pathLocks 内存级 per-path 锁（保护同进程内并发）
//
// 文件级锁（flock）由 lockFilePath 提供（保护跨进程并发）。
// 两层组合：先拿内存锁（快速），再拿文件锁（防多进程）。
var pathLocks sync.Map // map[string]*sync.Mutex

// lockPath 给 localPath 拿锁（per-repo 互斥）
//
// 返回 unlock 函数（defer 调用）
func lockPath(localPath string) (func(), error) {
	// 1. 内存锁（key=绝对路径）
	v, _ := pathLocks.LoadOrStore(localPath, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()

	// 2. 文件锁（flock on lockFilePath）
	lockFilePath := localPath + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockFilePath), 0o755); err != nil {
		mu.Unlock()
		return nil, fmt.Errorf("创建锁目录失败: %w", err)
	}

	f, err := os.OpenFile(lockFilePath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		mu.Unlock()
		return nil, fmt.Errorf("打开锁文件失败: %w", err)
	}

	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		f.Close()
		mu.Unlock()
		return nil, fmt.Errorf("flock 失败: %w", err)
	}

	return func() {
		unix.Flock(int(f.Fd()), unix.LOCK_UN)
		f.Close()
		mu.Unlock()
	}, nil
}
