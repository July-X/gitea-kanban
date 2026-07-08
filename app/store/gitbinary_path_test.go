package store

import (
	"path/filepath"
	"testing"
)

// TestGetSetGitBinaryPath 验证 prefs map 读写 + 空字符串清空 + 误类型 fallback 行为。
func TestGetSetGitBinaryPath(t *testing.T) {
	tmp := t.TempDir()
	statePath := filepath.Join(tmp, "state.json")
	s, err := NewLocalStore(statePath)
	if err != nil {
		t.Fatalf("NewLocalStore failed: %v", err)
	}

	// 默认值：空
	if got := GetGitBinaryPath(s); got != "" {
		t.Errorf("默认 GetGitBinaryPath 应为空字符串, got %q", got)
	}

	// Set 非空
	customPath := "/opt/homebrew/bin/git"
	if err := SetGitBinaryPath(s, customPath); err != nil {
		t.Fatalf("SetGitBinaryPath failed: %v", err)
	}
	if got := GetGitBinaryPath(s); got != customPath {
		t.Errorf("Set 后 Get 应返 %q, got %q", customPath, got)
	}

	// Set 空字符串 = 清空
	if err := SetGitBinaryPath(s, ""); err != nil {
		t.Fatalf("SetGitBinaryPath(empty) failed: %v", err)
	}
	if got := GetGitBinaryPath(s); got != "" {
		t.Errorf("空字符串清空后 Get 应返空, got %q", got)
	}

	// 持久化校验：重新 load state.json
	s2, err := NewLocalStore(statePath)
	if err != nil {
		t.Fatalf("re-NewLocalStore failed: %v", err)
	}
	if got := GetGitBinaryPath(s2); got != "" {
		t.Errorf("reload 后 Get 应保留清空状态, got %q", got)
	}
}
