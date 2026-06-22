package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

func TestNewLogger(t *testing.T) {
	dir := t.TempDir()

	logger := NewLogger(dir)
	if logger == nil {
		t.Fatal("NewLogger returned nil")
	}

	logger.Info("test message", "key", "value")

	// 验证日志文件创建
	// v2.2 路径：${dataDir}/logs/main/main.log
	logPath := filepath.Join(dir, "logs", "main", "main.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("log file not readable: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "test message") {
		t.Errorf("log file doesn't contain test message: %s", content)
	}
	if !strings.Contains(content, "key=value") {
		t.Errorf("log file doesn't contain structured key=value: %s", content)
	}
}
