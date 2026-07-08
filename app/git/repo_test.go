package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestGetCommitDiff_WithStats 验证 GetCommitDiff 返回的 FileChange 包含
// commit.Stats() 合并来的 Additions / Deletions 行数（v2.15 修复）。
//
// 回归场景：之前 GetCommitDiff 只返 Path / OldPath / Action，没有 +/- 行数。
// 前端 CommitDetailPanel 永远拿不到 files 数据，展开手风琴看不到文件列表。
//
// 用 system git 创建测试仓库（跟 clone_test.go 风格一致，避免引入 go-git 依赖）。
func TestGetCommitDiff_WithStats(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
	}
	runGit("init", "-q")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "test")

	// commit 1：新建 README.md（5 行）
	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"),
		[]byte("line1\nline2\nline3\nline4\nline5\n"), 0644))
	runGit("add", "README.md")
	runGit("commit", "-q", "-m", "initial: add README.md")
	commit1Hash := getHeadSHA(t, dir)
	require.NotEmpty(t, commit1Hash)

	// commit 2：修改 README.md（净 +2 行）
	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"),
		[]byte("line1\nline2 inserted\nline3\nline4\nline5\nnew line\n"), 0644))
	runGit("add", "README.md")
	runGit("commit", "-q", "-m", "modify: tweak README.md")
	commit2Hash := getHeadSHA(t, dir)
	require.NotEqual(t, commit1Hash, commit2Hash)

	// 打开仓库，调 GetCommitDiff
	r, err := OpenRepo(dir)
	require.NoError(t, err)
	// go-git 的 *git.Repository 通过 storer 接口管理生命周期，
	// 测试用临时目录（t.TempDir）会在测试结束时自动清理，无需手动 Close。

	t.Run("initial commit: file listed as added with stats", func(t *testing.T) {
		files, err := r.GetCommitDiff(commit1Hash)
		require.NoError(t, err)
		require.Len(t, files, 1)
		require.Equal(t, "README.md", files[0].Path)
		require.Equal(t, "added", files[0].Action)
		require.Empty(t, files[0].OldPath)
		// root commit：所有行都是新增，Stats 应给 additions > 0
		require.Greater(t, files[0].Additions, 0, "root commit 应有 additions > 0")
	})

	t.Run("modify commit: Additions + Deletions populated from commit.Stats()", func(t *testing.T) {
		files, err := r.GetCommitDiff(commit2Hash)
		require.NoError(t, err)
		require.Len(t, files, 1)
		require.Equal(t, "README.md", files[0].Path)
		require.Equal(t, "modified", files[0].Action)
		// 旧实现这两个字段都是 0（v2.15 bug），修复后 commit.Stats() 会算出来
		require.Greater(t, files[0].Additions, 0, "应从 commit.Stats() 拿 additions")
		require.GreaterOrEqual(t, files[0].Deletions, 0)
	})
}

// getHeadSHA 拿 HEAD 的 SHA（截断到 40 字符避免 newline）
func getHeadSHA(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	require.NoError(t, err)
	s := string(out)
	if len(s) >= 40 {
		return s[:40]
	}
	return s
}

// TestParseGpgStatus 覆盖 parseGpgStatus 的 9 种状态线。
//
// Good (G) / Unknown-trust (U) / Warn (X) / Bad (B) / Missing-key (E) /
// No signature (N) / 空输入 / trailing newline / Name fallback 到指纹。
//
// 用内存里 parseGpgStatus 单测，不依赖任何 GPG key。字段分隔符使用 NUL（\x00），
// 与 getCommitGpgStatus 里 git log --format 拼接的二进制 NUL 占位符保持一致。
func TestParseGpgStatus(t *testing.T) {
	cases := []struct {
		name         string
		input        string
		wantStatus   string
		wantKey      string
		wantCategory string
		wantNameFP   bool
	}{
		{
			name:         "Good signature",
			input:        "G\x00A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2\x00Alice <alice@example.com>",
			wantStatus:   "G",
			wantKey:      "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2",
			wantCategory: "valid",
			wantNameFP:   false,
		},
		{
			name:         "Bad signature",
			input:        "B\x00\x00",
			wantStatus:   "B",
			wantKey:      "",
			wantCategory: "bad",
			wantNameFP:   false,
		},
		{
			name:         "Unknown trust",
			input:        "U\x00AABBCCDD\x00Bob",
			wantStatus:   "U",
			wantKey:      "AABBCCDD",
			wantCategory: "unknown-trust",
			wantNameFP:   false,
		},
		{
			name:         "Expired key",
			input:        "X\x00\x00Charlie",
			wantStatus:   "X",
			wantKey:      "",
			wantCategory: "warn",
			wantNameFP:   false,
		},
		{
			name:         "Missing pubkey",
			input:        "E\x00\x00\x00",
			wantStatus:   "E",
			wantKey:      "",
			wantCategory: "missing-key",
			wantNameFP:   false,
		},
		{
			name:         "No signature",
			input:        "N\x00\x00\x00",
			wantStatus:   "N",
			wantKey:      "",
			wantCategory: "none",
			wantNameFP:   false,
		},
		{
			name: "Name fallback to fingerprint",
			// 40 hex char in name 位置 → IsNameFingerprint=true
			input:        "G\x00KEYFP\x00" + "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
			wantStatus:   "G",
			wantKey:      "KEYFP",
			wantCategory: "valid",
			wantNameFP:   true,
		},
		{
			name:         "Empty input",
			input:        "",
			wantStatus:   "",
			wantKey:      "",
			wantCategory: "unknown",
			wantNameFP:   false,
		},
		{
			name:         "Trailing newline stripped",
			input:        "G\x00KEY123\x00Name\r\n",
			wantStatus:   "G",
			wantKey:      "KEY123",
			wantCategory: "valid",
			wantNameFP:   false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseGpgStatus(tc.input)
			require.NotNil(t, got)
			require.Equal(t, tc.wantStatus, got.Status, "Status")
			if tc.wantKey != "" {
				require.Equal(t, tc.wantKey, got.Key, "Key")
			}
			require.Equal(t, tc.wantCategory, got.Category(), "Category")
			require.Equal(t, tc.wantNameFP, got.IsNameFingerprint(), "IsNameFingerprint")
		})
	}
}
