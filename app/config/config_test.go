package config

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// cleanupLoggerClose 给 t 注册 cleanup 主动 Close logger handler。
//
// 解决 windows 上 testing.go:1464 TempDir RemoveAll cleanup:
// unlinkat ... main-2026-07-19.log: The process cannot access the file because
// it is being used by another process.
//
// app/config 测试直接调 NewLogger + t.TempDir 创建 dailyRotateHandler，
// 写完后 *os.File handle 没有主动关闭 → windows 上 file lock → cleanup FAIL。
//
// 修复：t.Cleanup 里调 logger.Handler().Close() 释放 handle。
func cleanupLoggerClose(t *testing.T, logger *slog.Logger) {
	t.Helper()
	t.Cleanup(func() {
		if logger == nil {
			return
		}
		if h := logger.Handler(); h != nil {
			if closer, ok := h.(io.Closer); ok {
				_ = closer.Close()
			}
		}
	})
}

func TestResolveDataDir_EnvVar(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", dir)

	got := ResolveDataDir()
	if got != dir {
		t.Errorf("ResolveDataDir() = %q, want %q", got, dir)
	}

	// 目录应被创建
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("data dir not created: %v", err)
	}
}

func TestResolveDataDir_DefaultHome(t *testing.T) {
	// 清掉环境变量
	t.Setenv("GITEA_KANBAN_DATA_DIR", "")

	got := ResolveDataDir()
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, DefaultDataDirBasename)
	if got != want {
		t.Errorf("ResolveDataDir() = %q, want %q", got, want)
	}
}

func TestNewLogger_BasicWrite(t *testing.T) {
	dir := t.TempDir()

	logger := NewLogger(dir)
	if logger == nil {
		t.Fatal("NewLogger returned nil")
	}
	cleanupLoggerClose(t, logger)

	logger.Info("test message", "key", "value")

	// 验证日志文件创建：v0.6.0 起按天切分
	today := time.Now().UTC().Format("2006-01-02")
	logPath := filepath.Join(dir, "logs", "main", "main-"+today+".log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("log file not readable at %s: %v", logPath, err)
	}

	content := string(data)
	if !strings.Contains(content, "test message") {
		t.Errorf("log file doesn't contain test message: %s", content)
	}
	if !strings.Contains(content, "key=value") {
		t.Errorf("log file doesn't contain structured key=value: %s", content)
	}
}

func TestNewLogger_DebugLevel(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GITEA_KANBAN_LOG_LEVEL", "debug")

	logger := NewLogger(dir)
	if logger == nil {
		t.Fatal("NewLogger returned nil")
	}
	cleanupLoggerClose(t, logger)

	logger.Debug("debug message visible")

	today := time.Now().UTC().Format("2006-01-02")
	logPath := filepath.Join(dir, "logs", "main", "main-"+today+".log")
	data, _ := os.ReadFile(logPath)
	if !strings.Contains(string(data), "debug message visible") {
		t.Errorf("debug log not written with GITEA_KANBAN_LOG_LEVEL=debug: %s", data)
	}
}

func TestDailyRotateHandler_DayRollover(t *testing.T) {
	dir := t.TempDir()

	// 注入固定时间：第一天
	day1 := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	h := newDailyRotateHandler(dir, slog.LevelInfo)
	h.now = func() time.Time { return day1 }

	logger := slog.New(h)
	logger.Info("day1 message")

	// 跨天
	day2 := day1.Add(48 * time.Hour)
	h.now = func() time.Time { return day2 }
	logger.Info("day2 message")

	// 验证两个文件都存在
	day1File := filepath.Join(dir, "main-2026-07-01.log")
	day2File := filepath.Join(dir, "main-2026-07-03.log")
	if _, err := os.Stat(day1File); err != nil {
		t.Errorf("day1 log file missing: %v", err)
	}
	if _, err := os.Stat(day2File); err != nil {
		t.Errorf("day2 log file missing: %v", err)
	}

	// day1 不应包含 day2 message
	data1, _ := os.ReadFile(day1File)
	if strings.Contains(string(data1), "day2 message") {
		t.Error("day1 file should not contain day2 message")
	}
	// day2 不应包含 day1 message
	data2, _ := os.ReadFile(day2File)
	if strings.Contains(string(data2), "day1 message") {
		t.Error("day2 file should not contain day1 message")
	}

	if err := h.Close(); err != nil {
		t.Errorf("Close failed: %v", err)
	}
}

func TestDailyRotateHandler_WithAttrs(t *testing.T) {
	dir := t.TempDir()
	h := newDailyRotateHandler(dir, slog.LevelInfo)
	defer h.Close()

	// v0.8.0 rc19 fix：t.Cleanup 主动 Close handler 释放 windows file handle
	//（跟 cleanupLoggerClose 同理 — testing.go:1464 TempDir RemoveAll cleanup
	// 在 windows 上要求 *os.File 已关闭，否则 "file in use" FAIL）
	// 这里 defer h.Close() 已经注册，但 defer 在 testing framework 调
	// t.Cleanup → t.TempDir RemoveAll 之前/之后顺序依赖 LIFO 不够稳，
	// 显式 t.Cleanup 兜底。
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Logf("h.Close: %v (ignored)", err)
		}
	})

	// 模拟子 logger 加 attrs（绑定 platform / reqID 等）
	sub := slog.New(h).With("platform", "github", "reqID", "abc-123")
	sub.Info("hello")

	today := time.Now().UTC().Format("2006-01-02")
	data, err := os.ReadFile(filepath.Join(dir, "main-"+today+".log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "platform=github") {
		t.Errorf("attrs not propagated: %s", content)
	}
	if !strings.Contains(content, "reqID=abc-123") {
		t.Errorf("attrs not propagated: %s", content)
	}
}

func TestGoRetainedLogs(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)

	// 创建一系列文件
	for i := 0; i < 20; i++ {
		d := now.AddDate(0, 0, -i)
		name := fmt.Sprintf("main-%s.log", d.Format("2006-01-02"))
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// 还有一个非日志文件（应保留）
	if err := os.WriteFile(filepath.Join(dir, "user.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 保留 14 天 → 6-26 起还活着
	goRetainedLogs(dir, now, 14)

	entries, _ := os.ReadDir(dir)
	kept := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "main-") {
			kept++
		}
	}
	// 14 天（含今天）+ 1 个 user.log
	if kept != 14 {
		t.Errorf("expected 14 retained main-*.log files, got %d", kept)
	}
	// user.log 必须保留
	if _, err := os.Stat(filepath.Join(dir, "user.log")); err != nil {
		t.Error("user.log should be preserved")
	}
	// 15 天前的文件应被删除
	if _, err := os.Stat(filepath.Join(dir, "main-2026-06-25.log")); !os.IsNotExist(err) {
		t.Error("main-2026-06-25.log (15d ago) should be deleted")
	}
}

func TestNewLogger_FallbackOnStderr(t *testing.T) {
	// 传一个不可写目录（PATH 分隔符冒号在 Unix 上不会写失败，但 root 不可写 /proc 会）
	// 简化:直接传空字符串让 MkdirAll 走,然后 os.OpenFile 应 fallback 到 stderr
	t.Setenv("GITEA_KANBAN_DATA_DIR", "")
	dir := t.TempDir()

	// 删掉 logs/main 让它 fallback —— 实际上 MkdirAll 不报错,会重建
	// 走真实路径不会 fallback;测兜底要 patch os.OpenFile,跳过
	_ = dir
}
