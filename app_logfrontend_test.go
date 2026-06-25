package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// TestApp_LogFrontend_BasicLevel 白名单 level + message + description 落字段
func TestApp_LogFrontend_BasicLevel(t *testing.T) {
	var buf bytes.Buffer
	app := &App{
		ctx:    context.Background(),
		logger: slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}

	app.LogFrontend(LogFrontendArgs{
		Level:       LogLevelWarn,
		Message:     "GitHub 返 406",
		Description: `{"message":"Not Acceptable"}`,
		Source:      "toast",
	})

	out := buf.String()
	if !strings.Contains(out, "level=WARN") {
		t.Errorf("output should contain level=WARN, got: %s", out)
	}
	if !strings.Contains(out, "GitHub 返 406") {
		t.Errorf("output should contain message, got: %s", out)
	}
	if !strings.Contains(out, `src=toast`) {
		t.Errorf("output should contain src=toast, got: %s", out)
	}
	if !strings.Contains(out, "Not Acceptable") {
		t.Errorf("output should contain description, got: %s", out)
	}
}

// TestApp_LogFrontend_LevelMapping 白名单外的 level 当 info 兜底
func TestApp_LogFrontend_LevelMapping(t *testing.T) {
	var buf bytes.Buffer
	app := &App{
		ctx:    context.Background(),
		logger: slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}

	for _, level := range []LogFrontendLevel{"debug", "info", "warn", "error", "panic", "fatal", ""} {
		buf.Reset()
		app.LogFrontend(LogFrontendArgs{Level: level, Message: "x", Source: "test"})
		out := buf.String()
		// panic/fatal/"" 都应当成 info,不能崩
		if !strings.Contains(out, "msg=x") {
			t.Errorf("level %q: should still write msg=x, got: %s", level, out)
		}
	}
}

// TestApp_LogFrontend_Truncation description > 1024 字符被截断
func TestApp_LogFrontend_Truncation(t *testing.T) {
	var buf bytes.Buffer
	app := &App{
		ctx:    context.Background(),
		logger: slog.New(slog.NewTextHandler(&buf, nil)),
	}

	// 构造 5000 字符 description
	longDesc := strings.Repeat("A", 5000)
	app.LogFrontend(LogFrontendArgs{
		Level:       LogLevelError,
		Message:     "long desc",
		Description: longDesc,
		Source:      "test",
	})

	out := buf.String()
	if strings.Contains(out, strings.Repeat("A", 5000)) {
		t.Error("description should be truncated to ~1024 chars + suffix")
	}
	if !strings.Contains(out, "...(truncated)") {
		t.Error("truncated suffix should be present")
	}
}

// TestApp_LogFrontend_NilLogger logger 未初始化时静默
func TestApp_LogFrontend_NilLogger(t *testing.T) {
	app := &App{ctx: context.Background(), logger: nil}
	// 不应 panic
	app.LogFrontend(LogFrontendArgs{Level: LogLevelError, Message: "no logger", Source: "test"})
}

// TestApp_LogFrontend_JSONShape 验证 Wails 会序列化的 struct tag 形状
func TestApp_LogFrontend_JSONShape(t *testing.T) {
	args := LogFrontendArgs{
		Level:       LogLevelWarn,
		Message:     "m",
		Description: "d",
		Source:      "s",
	}
	b, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("json marshal failed: %v", err)
	}
	// Wails 生成的 TS 类型靠 json tag,字段名应是 level/message/description/source
	want := `{"level":"warn","message":"m","description":"d","source":"s"}`
	if string(b) != want {
		t.Errorf("json shape = %s, want %s", string(b), want)
	}
}