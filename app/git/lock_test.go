package git

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

// TestLockPath_ConcurrentAccess 验证 lockPath 在并发调用下提供互斥
func TestLockPath_ConcurrentAccess(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "test-repo")

	var counter int32
	var wg sync.WaitGroup

	// 启动 10 个并发 goroutine 全部尝试 lock 同一路径
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock, err := lockPath(localPath)
			if err != nil {
				t.Errorf("lockPath failed: %v", err)
				return
			}
			defer unlock()

			// 临界区：原子递增
			n := atomic.AddInt32(&counter, 1)
			if n != 1 {
				// 多个 goroutine 同时进入临界区 → 互斥失效
				t.Errorf("expected counter=1, got %d (mutex broken)", n)
			}

			// 短暂持有
			atomic.AddInt32(&counter, -1)
		}()
	}

	wg.Wait()
}

// TestLockPath_UnlockAllowsRelock 验证 unlock 后可重新 lock
func TestLockPath_UnlockAllowsRelock(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "test-repo")

	unlock1, err := lockPath(localPath)
	if err != nil {
		t.Fatalf("first lockPath failed: %v", err)
	}
	unlock1()

	// 应该能立刻再次 lock
	unlock2, err := lockPath(localPath)
	if err != nil {
		t.Fatalf("second lockPath after unlock failed: %v", err)
	}
	defer unlock2()
}

// TestLockPath_DifferentPathsIndependent 不同路径互不干扰
func TestLockPath_DifferentPathsIndependent(t *testing.T) {
	dir := t.TempDir()
	path1 := filepath.Join(dir, "repo1")
	path2 := filepath.Join(dir, "repo2")

	unlock1, err := lockPath(path1)
	if err != nil {
		t.Fatalf("lockPath(path1) failed: %v", err)
	}
	defer unlock1()

	// path2 应该能同时 lock（不同路径）
	unlock2, err := lockPath(path2)
	if err != nil {
		t.Fatalf("lockPath(path2) should not be blocked by path1: %v", err)
	}
	defer unlock2()
}

// TestLockFileCreated 验证锁文件被创建（用于跨进程锁的 flock）
func TestLockFileCreated(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "test-repo")

	unlock, err := lockPath(localPath)
	if err != nil {
		t.Fatalf("lockPath failed: %v", err)
	}
	defer unlock()

	lockFile := localPath + ".lock"
	if _, err := os.Stat(lockFile); err != nil {
		t.Errorf("lock file not created: %v", err)
	}
}
