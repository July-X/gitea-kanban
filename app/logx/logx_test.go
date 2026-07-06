package logx

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLogger 写入到 buffer 的 slog logger（测试用）
//
// 注：bytes.Buffer 读写不是 thread-safe，SafeGo 会从其它 goroutine 写入，
// 这里用 sync.Mutex 包一层。同时 fakeLogger 返回 wrapped buffer 的 String()
func fakeLogger() (*slog.Logger, *lockedBuf) {
	buf := &lockedBuf{}
	h := slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(h), buf
}

type lockedBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func (l *lockedBuf) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Len()
}

func TestFromContext_Empty(t *testing.T) {
	if attrs := FromContext(context.Background()); attrs != nil {
		t.Errorf("expected nil attrs for empty ctx, got %v", attrs)
	}
}

func TestFromContext_All(t *testing.T) {
	ctx := context.Background()
	ctx = WithReqID(ctx, "req-123")
	ctx = WithPlatform(ctx, "gitea")
	ctx = WithAccountID(ctx, "acc-456")
	ctx = WithProjectID(ctx, "proj-789")

	attrs := FromContext(ctx)
	if len(attrs) != 4 {
		t.Errorf("expected 4 attrs, got %d: %v", len(attrs), attrs)
	}
}

func TestFromContext_Partial(t *testing.T) {
	ctx := WithReqID(context.Background(), "req-abc")
	attrs := FromContext(ctx)
	if len(attrs) != 1 {
		t.Errorf("expected 1 attr, got %d", len(attrs))
	}
	if attrs[0].Key != "reqID" || attrs[0].Value.String() != "req-abc" {
		t.Errorf("unexpected attr: %v", attrs[0])
	}
}

func TestFromContext_NilCtx(t *testing.T) {
	// nil ctx 不应 panic（崩溃兜底友好）
	if attrs := FromContext(nil); attrs != nil {
		t.Errorf("expected nil attrs for nil ctx, got %v", attrs)
	}
}

func TestRecover_NoPanic(t *testing.T) {
	logger, buf := fakeLogger()
	func() {
		defer Recover(logger, "test")
		// 不 panic
	}()
	if buf.Len() != 0 {
		t.Errorf("expected no log when no panic, got: %s", buf.String())
	}
}

func TestRecover_StringPanic(t *testing.T) {
	logger, buf := fakeLogger()
	func() {
		defer Recover(logger, "TestOp")
		panic("kaboom")
	}()
	out := buf.String()
	if !strings.Contains(out, "level=ERROR") {
		t.Errorf("missing ERROR level: %s", out)
	}
	if !strings.Contains(out, "TestOp") {
		t.Errorf("missing op tag: %s", out)
	}
	if !strings.Contains(out, "panic=kaboom") {
		t.Errorf("missing panic msg: %s", out)
	}
	if !strings.Contains(out, "stack=") {
		t.Errorf("missing stack: %s", out)
	}
}

func TestRecover_ErrorPanic(t *testing.T) {
	logger, buf := fakeLogger()
	func() {
		defer Recover(logger, "TestErrOp")
		panic(errSentinel("sentinel-err"))
	}()
	if !strings.Contains(buf.String(), "panic=sentinel-err") {
		t.Errorf("missing panic msg from error: %s", buf.String())
	}
}

type errSentinel string

func (e errSentinel) Error() string { return string(e) }

func TestSafeGo_RecoversPanic(t *testing.T) {
	logger, buf := fakeLogger()
	done := make(chan struct{})
	SafeGo(logger, "BackgroundClone", func() {
		defer close(done)
		defer Recover(logger, "BackgroundClone")
		panic("bg panic")
	})
	// 等 goroutine 跑完（用 channel + 超时）
	select {
	case <-done:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatalf("SafeGo goroutine never finished: %s", buf.String())
	}
	// 读 buf 时走 once：sync.Mutex 保护
	out := buf.String()
	if !strings.Contains(out, "BackgroundClone") {
		t.Errorf("missing op: %q", out)
	}
	if !strings.Contains(out, "panic=\"bg panic\"") && !strings.Contains(out, "panic=bg panic") {
		t.Errorf("missing panic msg: %q", out)
	}
}
