// Package sync 实现离线写操作队列（queue.jsonl append-only + 崩恢复 + GC）。
//
// 设计（对齐旧版 src/main/sync/queue.ts + runner.ts）：
//   - 离线时写操作不丢弃，持久化到 queue.jsonl
//   - 后台 runner 定期重试队列中的 op
//   - 30 天 GC（清理已完成的旧 op）
package sync

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// OpType 操作类型
type OpType string

const (
	OpIssueCreate     OpType = "issue.create"
	OpIssueUpdate     OpType = "issue.update"
	OpIssueMoveColumn OpType = "issue.moveColumn"
	OpPullMerge       OpType = "pull.merge"
	OpPullClose       OpType = "pull.close"
)

// OpState 操作状态
type OpState string

const (
	StatePending OpState = "pending"
	StateDone    OpState = "done"
	StateFailed  OpState = "failed"
)

// Op 队列中的操作
type Op struct {
	ID        string          `json:"id"`
	Type      OpType          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	State     OpState         `json:"state"`
	CreatedAt int64           `json:"createdAt"` // epoch ms
	DoneAt    int64           `json:"doneAt,omitempty"`
	Error     string          `json:"error,omitempty"`
	Retries   int             `json:"retries"`
}

// Queue 同步队列（append-only JSONL + 崩恢复）
type Queue struct {
	mu   sync.Mutex
	path string
	file *os.File
}

// NewQueue 创建同步队列
//
// 路径：${dataDir}/queue.jsonl
func NewQueue(dataDir string) (*Queue, error) {
	path := filepath.Join(dataDir, "queue.jsonl")

	// 以 append 模式打开（不存在则创建）
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("打开队列文件失败: %w", err)
	}

	return &Queue{
		path: path,
		file: file,
	}, nil
}

// Enqueue 入队一个操作（append 到 JSONL）
//
// 写后调 Sync() 确保内核缓冲区落盘（避免进程崩溃丢失已 enqueue 的 op）
func (q *Queue) Enqueue(opType OpType, payload interface{}) (*Op, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化 payload 失败: %w", err)
	}

	op := Op{
		ID:        uuid.NewString(),
		Type:      opType,
		Payload:   payloadBytes,
		State:     StatePending,
		CreatedAt: time.Now().UnixMilli(),
	}

	line, err := json.Marshal(op)
	if err != nil {
		return nil, fmt.Errorf("序列化 op 失败: %w", err)
	}

	if _, err := q.file.Write(append(line, '\n')); err != nil {
		return nil, fmt.Errorf("写入队列失败: %w", err)
	}
	// 显式 Sync 避免崩溃丢 op（队列是低频写，成本可接受）
	if err := q.file.Sync(); err != nil {
		return nil, fmt.Errorf("sync 队列失败: %w", err)
	}

	return &op, nil
}

// LoadPending 加载所有 pending 操作（崩恢复用）
//
// append-only 设计：同一 op ID 可能有多条记录（pending + done/failed）。
// 这里按 op ID 去重：如果某 op 有 done/failed 记录，则不算 pending。
func (q *Queue) LoadPending() ([]Op, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	// 关闭写句柄临时切读
	q.file.Sync()

	file, err := os.Open(q.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Op{}, nil
		}
		return nil, err
	}
	defer file.Close()

	// 先读全部，记录每个 op 的最终状态
	opFinalState := make(map[string]Op)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var op Op
		if err := json.Unmarshal(line, &op); err != nil {
			continue // 跳过损坏行
		}

		// 后出现的记录覆盖前面的（append-only 语义：done/failed 在 pending 之后）
		opFinalState[op.ID] = op
	}

	// 收集所有最终状态为 pending 的操作
	pending := []Op{}
	for _, op := range opFinalState {
		if op.State == StatePending {
			pending = append(pending, op)
		}
	}

	return pending, nil
}

// MarkDone 标记操作完成（append 一条 done 状态的记录）
//
// 写后调 Sync() 避免崩溃后 runner 重做已成功的 op（issue.update / pull.merge 不幂等）
func (q *Queue) MarkDone(opID string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	op := Op{
		ID:     opID,
		State:  StateDone,
		DoneAt: time.Now().UnixMilli(),
	}

	line, err := json.Marshal(op)
	if err != nil {
		return err
	}

	if _, err := q.file.Write(append(line, '\n')); err != nil {
		return err
	}
	return q.file.Sync()
}

// MarkFailed 标记操作失败
//
// 写后调 Sync() 防止崩溃丢失"失败"标记（runner 会重新读 LoadPending 跳过已 done/failed 的 op）
func (q *Queue) MarkFailed(opID, errMsg string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	op := Op{
		ID:     opID,
		State:  StateFailed,
		Error:  errMsg,
		DoneAt: time.Now().UnixMilli(),
	}

	line, err := json.Marshal(op)
	if err != nil {
		return err
	}

	if _, err := q.file.Write(append(line, '\n')); err != nil {
		return err
	}
	return q.file.Sync()
}

// Close 关闭队列文件
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.file != nil {
		return q.file.Close()
	}
	return nil
}

// GC 清理 30 天前的已完成操作（重写文件）
func (q *Queue) GC(maxAgeDays int) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	// 读取全部行
	file, err := os.Open(q.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	cutoff := time.Now().AddDate(0, 0, -maxAgeDays).UnixMilli()
	keep := []Op{}

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var op Op
		if err := json.Unmarshal(line, &op); err != nil {
			continue
		}

		// 保留：pending 操作 + 30 天内的操作
		if op.State == StatePending || op.CreatedAt > cutoff {
			keep = append(keep, op)
		}
	}
	file.Close()

	// 重写文件
	tmpPath := q.path + ".tmp"
	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	for _, op := range keep {
		line, _ := json.Marshal(op)
		tmpFile.Write(append(line, '\n'))
	}
	tmpFile.Close()

	// 原子替换
	if err := os.Rename(tmpPath, q.path); err != nil {
		return err
	}

	// 重新打开写句柄
	q.file, err = os.OpenFile(q.path, os.O_APPEND|os.O_WRONLY, 0o644)
	return err
}
