package gitbinary

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestResolveGhPath_UserOverride 验证用户覆盖优先级最高
func TestResolveGhPath_UserOverride(t *testing.T) {
	// 创建一个临时可执行文件模拟 gh
	tmpDir := t.TempDir()
	fakeGh := filepath.Join(tmpDir, "gh")
	if err := os.WriteFile(fakeGh, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("create fake gh: %v", err)
	}

	// 设置用户覆盖
	SetGhOverride(fakeGh)
	defer ClearGhOverride()

	path, err := ResolveGhPath()
	if err != nil {
		t.Fatalf("ResolveGhPath should find user override: %v", err)
	}
	if path != fakeGh {
		t.Errorf("ResolveGhPath = %q, want %q", path, fakeGh)
	}
}

// TestResolveGhPath_NoGh 模拟 gh 完全不存在时返回 GhNotFoundError
func TestResolveGhPath_NoGh(t *testing.T) {
	// 确保没有用户覆盖
	ClearGhOverride()

	// 临时清空 PATH（确保 LookPath 失败）
	origPath := os.Getenv("PATH")
	t.Setenv("PATH", "/nonexistent_path_that_does_not_exist")
	defer os.Setenv("PATH", origPath)

	_, err := ResolveGhPath()
	if err == nil {
		t.Fatal("ResolveGhPath should return error when gh is not found")
	}

	var ghNotFound *GhNotFoundError
	if !isGhNotFoundError(err, &ghNotFound) {
		t.Fatalf("expected *GhNotFoundError, got %T: %v", err, err)
	}
}

// TestCommonGhPaths 验证返回的路径列表不为空（macOS / Linux）
func TestCommonGhPaths(t *testing.T) {
	paths := commonGhPaths()
	if runtime.GOOS == "windows" {
		// Windows 返回 nil（依赖 PATH）
		if paths != nil {
			t.Errorf("commonGhPaths on windows should return nil, got %v", paths)
		}
		return
	}
	if len(paths) == 0 {
		t.Error("commonGhPaths should return at least one path on macOS/Linux")
	}
}

// TestEnsureGhInPath 验证在 PATH 中已有 gh 时不重复追加
func TestEnsureGhInPath(t *testing.T) {
	// 此测试不验证具体行为（因为依赖系统 PATH），只确保不 panic
	EnsureGhInPath()
}

// TestSetGhOverride_ClearGhOverride 验证设置和清空覆盖
func TestSetGhOverride_ClearGhOverride(t *testing.T) {
	SetGhOverride("/usr/local/bin/gh")
	if got := GhOverride(); got != "/usr/local/bin/gh" {
		t.Errorf("GhOverride = %q, want %q", got, "/usr/local/bin/gh")
	}
	ClearGhOverride()
	if got := GhOverride(); got != "" {
		t.Errorf("GhOverride after clear = %q, want empty", got)
	}
}

// isGhNotFoundError 是 errors.As 的简化版（避免导入 errors 包）
func isGhNotFoundError(err error, target **GhNotFoundError) bool {
	if err == nil {
		return false
	}
	// 类型断言
	if ge, ok := err.(*GhNotFoundError); ok {
		*target = ge
		return true
	}
	return false
}
