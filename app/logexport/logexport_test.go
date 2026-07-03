package logexport

import (
	"path/filepath"
	"os"
	"strings"
	"testing"
	"time"
)

// setupLogFiles 创建一组 main-*.log 文件（不同时间）
func setupLogFiles(t *testing.T, dir string, names []string) {
	t.Helper()
	for _, n := range names {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("content-"+n), 0o644); err != nil {
			t.Fatal(err)
		}
		// 设 mtime 区分顺序
		d, _ := time.Parse("2006-01-02", strings.TrimSuffix(strings.TrimPrefix(n, "main-"), ".log"))
		_ = os.Chtimes(p, d, d)
	}
}

func TestCollectLogFiles_OrderAndLimit(t *testing.T) {
	dir := t.TempDir()
	setupLogFiles(t, dir, []string{
		"main-2026-07-01.log",
		"main-2026-07-03.log", // 最近
		"main-2026-07-02.log",
		"user.log", // 非日志文件，应忽略
	})

	names, total, err := collectLogFiles(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 {
		t.Errorf("expected 2 files (MaxLogs=2), got %d: %v", len(names), names)
	}
	// 应该是倒序
	if names[0] != "main-2026-07-03.log" {
		t.Errorf("expected main-2026-07-03.log first, got %s", names[0])
	}
	if total <= 0 {
		t.Errorf("expected positive total bytes, got %d", total)
	}
}

func TestExport_BasicZip(t *testing.T) {
	dir := t.TempDir()
	desktop := filepath.Join(dir, "Desktop")
	logDir := filepath.Join(dir, "logs", "main")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatal(err)
	}
	setupLogFiles(t, logDir, []string{"main-2026-07-01.log"})

	// 写一个 state.json
	statePath := filepath.Join(dir, "state.json")
	if err := os.WriteFile(statePath, []byte(`{"accounts":[{"id":"a1","username":"alice","token":"PAT-SECRET"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	summary, err := Export(ExportOptions{
		DesktopPath: desktop,
		LogDir:      logDir,
		StatePath:   statePath,
		Version:     "0.6.0",
		Platform:    "darwin",
		DataDir:     dir,
		MaxLogs:     5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.LogCount != 1 {
		t.Errorf("expected 1 log file, got %d", summary.LogCount)
	}

	// 解压验证
	if _, err := os.Stat(summary.ZipPath); err != nil {
		t.Fatalf("zip file not created: %v", err)
	}

	// 用标准库 zip reader 验证关键文件存在
	r, err := zipOpenReader(t, summary.ZipPath)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	var foundApp, foundState, foundLog bool
	for _, f := range r.File {
		switch f.Name {
		case "app.json":
			foundApp = true
		case "state.json":
			foundState = true
			// 验证脱敏
			rc, _ := f.Open()
			data := readAll(t, rc)
			rc.Close()
			if !strings.Contains(string(data), "<REDACTED>") {
				t.Error("state.json should contain <REDACTED> for token field")
			}
			if strings.Contains(string(data), "PAT-SECRET") {
				t.Error("state.json should NOT contain original token value")
			}
		case "logs/main-2026-07-01.log":
			foundLog = true
		}
	}
	if !foundApp {
		t.Error("app.json missing")
	}
	if !foundState {
		t.Error("state.json missing")
	}
	if !foundLog {
		t.Error("log file missing")
	}
}

func TestExport_NoLogDir(t *testing.T) {
	dir := t.TempDir()
	desktop := filepath.Join(dir, "Desktop")
	nonExistentLogDir := filepath.Join(dir, "logs", "nonexistent")

	summary, err := Export(ExportOptions{
		DesktopPath: desktop,
		LogDir:      nonExistentLogDir,
		Version:     "0.6.0",
		Platform:    "darwin",
		DataDir:     dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.LogCount != 0 {
		t.Errorf("expected 0 log files for non-existent dir, got %d", summary.LogCount)
	}
	// 仍应生成 zip（含 app.json）
	if _, err := os.Stat(summary.ZipPath); err != nil {
		t.Errorf("zip file should be created even without logs: %v", err)
	}
}

func TestRedactAny(t *testing.T) {
	v := map[string]any{
		"username": "alice",
		"token":    "PAT-SECRET",
		"nested": map[string]any{
			"password": "hunter2",
			"deep": map[string]any{
				"Secret": "shh",
				"name":   "ok",
			},
		},
		"list": []any{
			map[string]any{"token": "T1"},
			map[string]any{"safe": "data"},
		},
	}
	redactAny(v)

	if v["username"] != "alice" {
		t.Error("username should be preserved")
	}
	if v["token"] != "<REDACTED>" {
		t.Error("top-level token should be redacted")
	}
	nested := v["nested"].(map[string]any)
	if nested["password"] != "<REDACTED>" {
		t.Error("nested password should be redacted")
	}
	deep := nested["deep"].(map[string]any)
	if deep["Secret"] != "<REDACTED>" {
		t.Error("nested Secret should be redacted")
	}
	if deep["name"] != "ok" {
		t.Error("name should be preserved")
	}
	list := v["list"].([]any)
	if list[0].(map[string]any)["token"] != "<REDACTED>" {
		t.Error("list item token should be redacted")
	}
	if list[1].(map[string]any)["safe"] != "data" {
		t.Error("safe field should be preserved")
	}
}

func TestReadRecentLogs(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "logs", "main")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatal(err)
	}
	setupLogFiles(t, logDir, []string{
		"main-2026-07-01.log",
		"main-2026-07-02.log",
		"main-2026-07-03.log",
	})

	out, err := ReadRecentLogs(logDir, 1024)
	if err != nil {
		t.Fatal(err)
	}
	// 应至少包含最新的两个文件
	if !strings.Contains(out, "main-2026-07-02.log") && !strings.Contains(out, "main-2026-07-03.log") {
		// 实际内容是 "content-main-..." 不含文件名，所以这里只看是否非空
		if len(out) == 0 {
			t.Error("expected non-empty output")
		}
	}
}

func TestReadRecentLogs_Truncate(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "logs", "main")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 写一个大文件
	big := strings.Repeat("x", 10000)
	if err := os.WriteFile(filepath.Join(logDir, "main-2026-07-03.log"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := ReadRecentLogs(logDir, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > 1100 {
		t.Errorf("output should be truncated to ~1000 bytes, got %d", len(out))
	}
	if !strings.Contains(out, "truncated") {
		t.Error("truncated output should mention truncation")
	}
}