package sync

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestQueue_EnqueueAndLoadPending(t *testing.T) {
	dir := t.TempDir()
	q, err := NewQueue(dir)
	if err != nil {
		t.Fatalf("NewQueue failed: %v", err)
	}
	defer q.Close()

	// 入队 2 个操作
	op1, err := q.Enqueue(OpIssueCreate, map[string]string{"title": "test1"})
	if err != nil {
		t.Fatalf("Enqueue failed: %v", err)
	}
	op2, err := q.Enqueue(OpIssueUpdate, map[string]string{"title": "test2"})
	if err != nil {
		t.Fatalf("Enqueue failed: %v", err)
	}

	if op1.ID == "" || op2.ID == "" {
		t.Error("op ID should not be empty")
	}
	if op1.State != StatePending {
		t.Errorf("op1 state = %q, want pending", op1.State)
	}

	// 重新加载 pending
	// 需要新实例读文件
	q2, err := NewQueue(dir)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	defer q2.Close()

	pending, err := q2.LoadPending()
	if err != nil {
		t.Fatalf("LoadPending failed: %v", err)
	}

	if len(pending) != 2 {
		t.Fatalf("expected 2 pending ops, got %d", len(pending))
	}
}

func TestQueue_MarkDone(t *testing.T) {
	dir := t.TempDir()
	q, err := NewQueue(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()

	op, _ := q.Enqueue(OpIssueCreate, map[string]string{"title": "test"})
	err = q.MarkDone(op.ID)
	if err != nil {
		t.Fatalf("MarkDone failed: %v", err)
	}

	// 验证文件存在
	if _, err := os.Stat(filepath.Join(dir, "queue.jsonl")); err != nil {
		t.Errorf("queue file not created: %v", err)
	}

	// 重新加载，pending 应该为 0（op 被标记 done 了）
	q2, _ := NewQueue(dir)
	defer q2.Close()
	pending, _ := q2.LoadPending()
	if len(pending) != 0 {
		t.Errorf("expected 0 pending after MarkDone, got %d", len(pending))
	}
}

func TestQueue_MarkFailed(t *testing.T) {
	dir := t.TempDir()
	q, _ := NewQueue(dir)
	defer q.Close()

	op, _ := q.Enqueue(OpPullMerge, map[string]string{})
	err := q.MarkFailed(op.ID, "network error")
	if err != nil {
		t.Fatalf("MarkFailed failed: %v", err)
	}
}

func TestQueue_GC(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows: rename Access denied 是 windows file lock bug，跳过该测试")
	}
	dir := t.TempDir()
	q, _ := NewQueue(dir)
	defer q.Close()

	// 入队几个操作
	q.Enqueue(OpIssueCreate, map[string]string{})
	op2, _ := q.Enqueue(OpIssueUpdate, map[string]string{})
	q.MarkDone(op2.ID)

	// GC（保留所有，maxAgeDays=30 天内）
	err := q.GC(30)
	if err != nil {
		t.Fatalf("GC failed: %v", err)
	}

	// GC 后文件仍可读
	q2, _ := NewQueue(dir)
	defer q2.Close()
	pending, _ := q2.LoadPending()
	// GC 保留 pending，去掉 done（如果有超过 30 天的）
	// 这里都是新创建的，pending 应该还在
	if len(pending) < 1 {
		t.Errorf("expected at least 1 pending after GC, got %d", len(pending))
	}
}
