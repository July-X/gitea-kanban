// v0.8.27+ 端到端验证：模拟 wails dev 启动流程
//
//  1. Init 释放主二进制 + helper + DLL 到 ${dataRoot}/tools/git/
//  2. 验证 helper 文件被正确释放
//  3. 验证 RunGitWithEnv 注入 GIT_EXEC_PATH 后，git 不再报
//     'remote-https is not a git command'（即 helper 找到）
//
// 这只在 Windows 上有意义（mac/linux 内嵌二进制不带 helper）。
//
// 沙箱 / 离线环境可能无法真实联通 GitHub，所以这里用「断言非 remote-https 错误」
// 而不是「断言 fetch 成功」：
//   - 老 bug：remote-https is not a git command（helper 缺失）
//   - 修复后：网络错误 / 401 / 404（helper 找到了，链路通）
package gitbinary

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEndToEnd_InitReleasesHelpers(t *testing.T) {
	if !embeddedHelperAvailable() {
		t.Skip("当前平台不嵌入 helper（macOS / Linux），跳过")
	}

	resetInitFlag(t)
	tmp := t.TempDir()
	if err := Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	bin := DefaultBinaryPath()
	if bin == "" {
		t.Fatal("Init 后 DefaultBinaryPath 仍为空（Init 应该已成功）")
	}

	// 验证 helper 文件确实被释放到 tools/git/（与主二进制同目录）
	toolsDir := filepath.Dir(bin)
	expectedHelpers := []string{
		"git-remote-https.exe",
		"git-remote-http.exe",
		"git-http-fetch.exe",
		"git-http-push.exe",
		"libcurl-openssl-4.dll",
		"libssl-3-x64.dll",
		"libcrypto-3-x64.dll",
		"zlib1.dll",
		"libpcre2-8-0.dll",
		"libiconv-2.dll",
		"libintl-8.dll",
	}
	for _, h := range expectedHelpers {
		path := filepath.Join(toolsDir, h)
		if _, err := os.Stat(path); err != nil {
			t.Errorf("helper 文件 %s 应被 Init 释放到 %s，实际找不到: %v", h, path, err)
		}
	}
	t.Logf("OK: Init 释放了 %d 个 helper + DLL 到 %s", len(expectedHelpers), toolsDir)
}

// TestEndToEnd_RunGitWithEnv_HelperFound 验证 RunGitWithEnv 注入 GIT_EXEC_PATH
// 后 git 能找到 remote helper（不再报 'remote-https is not a git command'）。
//
// 沙箱 / 离线环境可能无法联通 github.com。我们不强求 fetch 成功，只断言
// 错误信息里没有 "remote-https is not a git command" 字符——这表示 helper
// 链通了（找不到 helper 会报这个；找到 helper 但网络不通会报 connect 错误）。
func TestEndToEnd_RunGitWithEnv_HelperFound(t *testing.T) {
	if !embeddedHelperAvailable() {
		t.Skip("当前平台不嵌入 helper（macOS / Linux），跳过")
	}

	// resetInitFlag：避免前一个测试调 Init 后 defaultBinaryPath 指向被清理的 tmpdir
	resetInitFlag(t)
	tmp := t.TempDir()
	if err := Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	bin := DefaultBinaryPath()
	if bin == "" {
		t.Fatal("Init 后 DefaultBinaryPath 仍为空")
	}

	// 用 octocat/Hello-World 公开小仓库（避免 git/git 太大）
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	_, err := RunGitWithEnv(ctx, bin, "", nil, "ls-remote", "https://github.com/octocat/Hello-World.git", "HEAD")
	if err != nil {
		errStr := err.Error()
		// 老 bug 特征：helper 缺失
		if strings.Contains(errStr, "remote-https is not a git command") {
			t.Fatalf("RunGitWithEnv 仍报 'remote-https is not a git command'——helper 没正确释放或 GIT_EXEC_PATH 没注入: %v", err)
		}
		// 网络失败是预期内（沙箱无网），只 WARN 不 FAIL
		t.Logf("OK: 错误不是 'remote-https is not a git command'（helper 链通了），网络失败是预期内: %v", err)
		return
	}
	// err == nil 才是完整成功（沙箱有网时）
	t.Logf("OK: ls-remote 成功，helper 链 + 网络都通")
}
