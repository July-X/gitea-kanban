package gitbinary

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// resetInitFlag 在每个 case 前重置 Init 幂等性守卫（Init 只允许跑一次）。
func resetInitFlag(t *testing.T) {
	t.Helper()
	initialized.Store(false)
	defaultBinaryPath.Store("")
}

// TestInit_ReleasesEmbeddedBinary 验证 Init 能把嵌入二进制释放到磁盘。
//
// 仅在有嵌入二进制的 build 下跑（darwin/amd64 + darwin/arm64 + windows/amd64），
// Linux 上 embeddedGitBytes() 返回 nil，Init 跳过释放。
func TestInit_ReleasesEmbeddedBinary(t *testing.T) {
	resetInitFlag(t)
	tmp := t.TempDir()

	if err := Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	def := DefaultBinaryPath()
	if def == "" {
		if runtime.GOOS == "linux" {
			t.Skip("Linux 平台不嵌入 git 二进制，跳过 expect-release 断言")
		}
		t.Fatalf("Init 后 DefaultBinaryPath 为空（实际值 %q），期望嵌入二进制路径", def)
	}

	info, err := os.Stat(def)
	if err != nil {
		t.Fatalf("嵌入二进制不存在: %v", err)
	}
	if info.IsDir() {
		t.Fatalf("嵌入二进制路径指向目录: %s", def)
	}
	// 0 字节 placeholder 出现时（dev 期），要打 WARNING 但不 fail
	if info.Size() == 0 {
		t.Logf("嵌入二进制为 0 字节 placeholder：%s（dev 期占位，release 前替换）", def)
		return
	}
}

// TestInit_Idempotent 重复调 Init 不应 panic / 双写。
func TestInit_Idempotent(t *testing.T) {
	resetInitFlag(t)
	tmp := t.TempDir()
	if err := Init(tmp, nil); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	if err := Init(tmp, nil); err != nil {
		t.Fatalf("second Init: %v", err)
	}
}

// TestResolveBinaryPath_FallsBackToLookPath 验证无任何配置时回退到 PATH git。
//
// 这只在 PATH 上有 `git` 命令的系统跑；CI runner / sandbox 通常有。
func TestResolveBinaryPath_FallsBackToLookPath(t *testing.T) {
	// 先 reset 内部 defaultBinaryPath，让 PATH fallback 路径生效
	resetInitFlag(t)

	// 不调 Init，保证 defaultBinaryPath 为空 / sandbox 上无嵌入

	resolved, err := ResolveGitBinaryPath("")
	if err != nil {
		t.Skipf("PATH 中没有 git 命令（skip）: %v", err)
	}
	if resolved == "" {
		t.Fatal("ResolveGitBinaryPath 返空字符串")
	}
	if _, err := os.Stat(resolved); err != nil {
		t.Fatalf("resolved path not stat-able: %s err=%v", resolved, err)
	}
}

// TestResolveBinaryPath_HonorsUserOverride 验证用户填的路径优先（即使 default 也存在）。
//
// 这里 override 用 sandbox 上 PATH git 的实际路径，应该跟 override 一样。
func TestResolveBinaryPath_HonorsUserOverride(t *testing.T) {
	resetInitFlag(t)

	// 用 system git 当 override（sandbox 应该有的）
	pathGit, err := lookupSystemGit(t)
	if err != nil {
		t.Skipf("无 system git: %v", err)
	}

	resolved, err := ResolveGitBinaryPath(pathGit)
	if err != nil {
		t.Fatalf("ResolveGitBinaryPath(%q) failed: %v", pathGit, err)
	}
	// filepath.Clean 避免末尾冗余
	if filepath.Clean(resolved) != filepath.Clean(pathGit) {
		t.Errorf("expected %q, got %q", pathGit, resolved)
	}
}

// TestTestGitBinary_SandboxSystemGit 把当前 sandbox 的 /usr/local/bin/git 拿来跑 TestGitBinary。
func TestTestGitBinary_SandboxSystemGit(t *testing.T) {
	pathGit, err := lookupSystemGit(t)
	if err != nil {
		t.Skipf("无 system git 跳过: %v", err)
	}

	res := TestGitBinary(pathGit)
	if !res.OK {
		t.Fatalf("TestGitBinary failed: message=%q hint=%q", res.Message, res.Hint)
	}
	if res.Version == "" {
		t.Fatal("版本号为空字符串")
	}
	if !strings.HasPrefix(res.Version, "2.") {
		t.Errorf("版本号 %q 不像 git 2.x", res.Version)
	}
}

// TestTestGitBinary_RejectsGarbage 验证乱填路径 / 文件不存在 / 是目录的情况。
func TestTestGitBinary_RejectsGarbage(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{"empty", ""},
		{"nonexistent", "/this/does/not/exist/git"},
		{"directory", os.TempDir()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := TestGitBinary(c.path)
			if res.OK {
				t.Errorf("TestGitBinary(%q) 应返回 ok=false, got %+v", c.path, res)
			}
			if res.Message == "" {
				t.Error("失败时 Message 不应为空")
			}
		})
	}
}

// TestRunGit_NoLocalPath 验证 RunGit 不传 localPath 时能跑 `git --version`。
//
// 这等价于 native use case：fetch clone 之类可能要 `git --version` 之类的 global 操作。
func TestRunGit_NoLocalPath(t *testing.T) {
	resetInitFlag(t)

	bin, err := ResolveGitBinaryPath("")
	if err != nil {
		t.Skipf("无 git 可用: %v", err)
	}

	out, err := RunGit(context.Background(), bin, "", "--version")
	if err != nil {
		t.Fatalf("RunGit --version: %v", err)
	}
	if !strings.Contains(string(out), "git version ") {
		t.Errorf("期望 stdout 含 'git version ', got: %s", out)
	}
}

// TestRunGit_EmptyBinPath 验证无路径时不 panic，返干净错误。
func TestRunGit_EmptyBinPath(t *testing.T) {
	_, err := RunGit(context.Background(), "", "", "--version")
	if err == nil {
		t.Fatal("期望非 nil error（空 binPath）")
	}
	if !strings.Contains(err.Error(), "无") {
		t.Errorf("错误信息应提及 '无'，got: %v", err)
	}
}

// lookupSystemGit 找 PATH 上的 git 二进制（sandbox 辅助 helper）。
func lookupSystemGit(t *testing.T) (string, error) {
	t.Helper()
	for _, p := range []string{
		"/usr/local/bin/git",
		"/opt/homebrew/bin/git",
		"/usr/bin/git",
	} {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", os.ErrNotExist
}
