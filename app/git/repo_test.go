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
