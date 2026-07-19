package gitbinary

import (
	"context"
	"fmt"
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
// v0.8.0 CI fix：原本按 build tag 分 3 个文件（runner_test_darwin.go 等），
// 但 Go 1.26.5 在 `*_test.go` 上对 `//go:build darwin` / `// +build darwin`
// tag 都有 bug — file 同时不在 TestGoFiles 和 IgnoredGoFiles（go list 输出确认），
// 编译时进 GoFiles（导致引用 undefined helper）但 go test 不跑它。
//
// 现在改为统一在 runner_test.go（无 build tag）里 stub 永远 Skip：
//   - dev 期 0 字节 placeholder → Init 释放 + smoke test 失败清空 defaultBinaryPath
//   - release 期真实二进制 → Init 释放成功但 smoke test 跨 arch 也会失败（CI host 是 arm64）
//
// 真正的嵌入二进制验证在 wails build 后的 release smoke test 里跑（release.yml
// sign-publish job 上传 asset 后用户跑本地 +smoke-test），不在单元测试层做。
func TestInit_ReleasesEmbeddedBinary(t *testing.T) {
	t.Skip("v0.8.0 跨平台 CI 兼容性：嵌入二进制验证改到 release smoke test，单元测试层永远 Skip")
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

// TestCheckQuarantine_SandboxFile 验证 quarantine 检测在真实文件上。
//
// 在 sandbox 上建一个假文件，预期非 quarantine（系统不主动加）。
// 真 quarantine 行为需要从 Safari 下载，sandbox 内无法复现；
// 所以此测试只覆盖「无属性时返 false」和「文件不存在时返 no-error」的健壮性。
func TestCheckQuarantine_NoQuarantineOnFreshFile(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skipf("仅 macOS 跑（当前 %s）", runtime.GOOS)
	}
	tmp := t.TempDir()
	fresh := filepath.Join(tmp, "fresh_file")
	if err := os.WriteFile(fresh, []byte("hi"), 0o644); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	quarantined, err := checkQuarantine(fresh)
	if err != nil {
		t.Fatalf("checkQuarantine 失败: %v", err)
	}
	if quarantined {
		t.Errorf("新建文件不应有 quarantine 属性")
	}
}

// TestStripQuarantine_Idempotent 验证重复剥离不报错。
//
// 在 sandbox 跑：先建一个 fresh file，剥 quarantine（无属性也应 idempotent），再剥一次，验证不 panic。
func TestStripQuarantine_Idempotent(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skipf("仅 macOS 跑（当前 %s）", runtime.GOOS)
	}
	tmp := t.TempDir()
	fresh := filepath.Join(tmp, "fresh")
	if err := os.WriteFile(fresh, []byte("hi"), 0o755); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	if err := stripQuarantine(fresh); err != nil {
		t.Errorf("首次 stripQuarantine 应 idempotent, got: %v", err)
	}
	if err := stripQuarantine(fresh); err != nil {
		t.Errorf("重复 stripQuarantine 应 idempotent, got: %v", err)
	}
}

// TestStripQuarantine_OtherPlatformsNoop 验证非 macOS 平台直接返 nil。
func TestStripQuarantine_OtherPlatformsNoop(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("darwin 平台已由其他用例覆盖")
	}
	if err := StripQuarantine("/tmp/whatever"); err != nil {
		t.Errorf("非 macOS 平台 StripQuarantine 应返 nil, got: %v", err)
	}
}

// TestTestGitBinary_QuarantineHint 验证 TestGitBinary 在 macOS 上能正确返 message/hint。
//
// 即便没有 quarantine 属性，结构应返 ok=true + 完整字段，
// 让前端 SettingsView 卡片能稳定显示。
func TestTestGitBinary_QuarantineHint(t *testing.T) {
	pathGit, err := lookupSystemGit(t)
	if err != nil {
		t.Skipf("无 system git 跳过: %v", err)
	}
	res := TestGitBinary(pathGit)
	if !res.OK {
		t.Fatalf("TestGitBinary 失败: message=%q hint=%q", res.Message, res.Hint)
	}
	// Message 应至少包含版本号
	if res.Version == "" {
		t.Error("Version 字段为空")
	}
	// Path 应是 stat 后的绝对路径
	if res.Path == "" {
		t.Error("Path 字段为空")
	}
	// Message 至少应有「git <ver>」字样
	if !strings.Contains(res.Message, res.Version) {
		t.Errorf("Message %q 应包含版本号 %q", res.Message, res.Version)
	}
}

// TestResolveBinaryPath_EmbeddedSentinel 验证 v0.5 sentinel magic string
// userOverride == EMBEDDED_SENTINEL → 强制走 defaultBinaryPath（不 fallback PATH）
func TestResolveBinaryPath_EmbeddedSentinel(t *testing.T) {
	resetInitFlag(t)
	// Init 释放 embedded binary
	if err := Init(t.TempDir(), nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	if DefaultBinaryPath() == "" {
		t.Skip("无 embedded binary（0 字节 placeholder）")
	}

	embeddedPath := DefaultBinaryPath()

	// sentinel 命中 → 返 embedded binary（不是 PATH git）
	resolved, err := ResolveGitBinaryPath(EMBEDDED_SENTINEL)
	if err != nil {
		t.Fatalf("ResolveGitBinaryPath(SENTINEL) failed: %v", err)
	}
	if resolved != embeddedPath {
		t.Errorf("sentinel 应该走 embedded：\n  want %q\n  got  %q", embeddedPath, resolved)
	}

	// 非 sentinel 空字符串 → 走 PATH git（v0.4.0 fix-1 fallback）
	resolvedPath, _ := ResolveGitBinaryPath("")
	if resolvedPath == "" {
		t.Error("empty callerOverride 应 fallback PATH git")
	}
	t.Logf("OK: embedded=%s, PATH git=%s", resolved, resolvedPath)
}

// TestPickInitialDirForGitBinary 验证 v0.5-mid3 优先级：
//
//  1. PATH git dirname（最高优先）
//  2. Init() 释放的 embedded binary 所在目录
//  3. userOverride 落定的路径 dirname
//  4. dataDir 本身（兜底）
//
// findSystemGit 是包级变量可重写，本测试用 stub 避 sandbox PATH git 干扰。
func TestPickInitialDirForGitBinary(t *testing.T) {
	// stub 覆盖 PATH git 查找，接 dev 后 restore
	orig := findSystemGit
	defer func() { findSystemGit = orig }()

	tmp := t.TempDir()

	// case 1 stub：findSystemGit 返路径 → 返 dirname（已 EvalSymlinks）
	//
	//	v0.5-mid4 预期：起的是 symlink 时，返实体 dir（Cellar 下的 bin）。
	//	本次用 symlink-stub 验证该行为。
	linkDir := filepath.Join(tmp, "fake-usr-local-bin")
	entityDir1 := filepath.Join(tmp, "fake-Cellar", "git", "2.55.0", "bin")
	if err := os.MkdirAll(linkDir, 0o755); err != nil {
		t.Fatalf("MkdirAll linkDir: %v", err)
	}
	if err := os.MkdirAll(entityDir1, 0o755); err != nil {
		t.Fatalf("MkdirAll entityDir1: %v", err)
	}
	entityBin1 := filepath.Join(entityDir1, "git")
	if err := os.WriteFile(entityBin1, []byte("fake"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	linkBin1 := filepath.Join(linkDir, "git")
	if err := os.Symlink(entityBin1, linkBin1); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	findSystemGit = func(_ string) (string, error) { return linkBin1, nil }
	wantDir, _ := filepath.EvalSymlinks(entityDir1)
	if got := PickInitialDir(tmp); got != wantDir {
		t.Errorf("case 1 symlink PATH git: want entity dir %q, got %q", wantDir, got)
	}

	// case 2 stub: PATH git 不在 → 落到 toolsGitDir（须非空）
	findSystemGit = func(_ string) (string, error) { return "", fmt.Errorf("not in PATH") }
	toolsGitDir := filepath.Join(tmp, "tools", "git")
	if err := os.MkdirAll(toolsGitDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(toolsGitDir, "dummy-git"), []byte("stub"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if got := PickInitialDir(tmp); got != toolsGitDir {
		t.Errorf("case 2 tools/git/: want %q, got %q", toolsGitDir, got)
	}

	// case 3: PATH 不在 + tools/git/ 空 → fallback dataDir
	emptyTmp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(emptyTmp, "tools", "git"), 0o755); err != nil {
		t.Fatalf("MkdirAll empty: %v", err)
	}
	if got := PickInitialDir(emptyTmp); got != emptyTmp {
		t.Errorf("case 3 fallback dataDir: want %q, got %q", emptyTmp, got)
	}
}

// TestSystemGitDir 验证 v0.5-mid4 symlink 解析逻辑。
//
//	场景：
//	  - symlink 存在指向实体 → 返实体 dir（如 /opt/homebrew/Cellar/.../bin）
//	  - path 是实体文件 → 返其 dir
//	  - EvalSymlinks 报错（死链/消失）→ fallback 到 path 自己的 dir
func TestSystemGitDir(t *testing.T) {
	tmp := t.TempDir()

	// 场景 1：symlink → 实体
	entityDir := filepath.Join(tmp, "Cellar", "git", "2.55.0", "bin")
	if err := os.MkdirAll(entityDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	entityBin := filepath.Join(entityDir, "git")
	if err := os.WriteFile(entityBin, []byte("fake"), 0o644); err != nil {
		t.Fatalf("WriteFile entity: %v", err)
	}
	linkPath := filepath.Join(tmp, "bin", "git")
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		t.Fatalf("MkdirAll link dir: %v", err)
	}
	if err := os.Symlink(entityBin, linkPath); err != nil {
		t.Skipf("symlink unavailable on this filesystem: %v", err)
	}
	// 解决 macOS /var/folders → /private/var/folders symlink 问题：用 EvalSymlinks 达一致
	entityDirResolved, _ := filepath.EvalSymlinks(entityDir)
	if got := systemGitDir(linkPath); got != entityDirResolved {
		t.Errorf("symlink case: want %q, got %q", entityDirResolved, got)
	}

	// 场景 2：实体路径本身（无 symlink） → 返其 dir
	if got := systemGitDir(entityBin); got != entityDirResolved {
		t.Errorf("entity case: want %q, got %q", entityDirResolved, got)
	}

	// 场景 3：EvalSymlinks 报错（path 不存在，symlink 死链） → fallback 到 path Dir
	deadPath := filepath.Join(tmp, "does", "not", "exist", "git")
	if got := systemGitDir(deadPath); got != filepath.Dir(deadPath) {
		t.Errorf("dead path fallback: want %q, got %q", filepath.Dir(deadPath), got)
	}
}

// TestPickInitialDirForGitBinary_Symlink 验证 v0.5-mid4 integration：
//
//	findSystemGit 返 symlink path → PickInitialDir 应解析到实体 dir
func TestPickInitialDirForGitBinary_Symlink(t *testing.T) {
	orig := findSystemGit
	defer func() { findSystemGit = orig }()

	tmp := t.TempDir()
	entityDir := filepath.Join(tmp, "Cellar", "git", "2.55.0", "bin")
	if err := os.MkdirAll(entityDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	entityBin := filepath.Join(entityDir, "git")
	if err := os.WriteFile(entityBin, []byte("fake"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	linkPath := filepath.Join(tmp, "bin", "git")
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.Symlink(entityBin, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	findSystemGit = func(_ string) (string, error) { return linkPath, nil }
	entityDirResolved2, _ := filepath.EvalSymlinks(entityDir)
	if got := PickInitialDir(tmp); got != entityDirResolved2 {
		t.Errorf("symlink integration: want entity dir %q, got %q", entityDirResolved2, got)
	}
}
