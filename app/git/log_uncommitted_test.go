package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// createTestRepoWithCommit 创建一个本地仓库，commit 1 个文件。
// 返回 localPath。user.email/name 已设置。
func createTestRepoWithCommit(t *testing.T) string {
	t.Helper()
	localPath := t.TempDir()
	runGitAt(t, localPath, "init")
	runGitAt(t, localPath, "config", "user.email", "test@test.com")
	runGitAt(t, localPath, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(localPath, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatalf("write a.txt: %v", err)
	}
	runGitAt(t, localPath, "add", ".")
	envCommit(t, localPath, "initial commit", "2026-01-01T10:00:00Z")
	return localPath
}

// envCommit 显式设置 author/committer date，避免秒级时间戳冲突
func envCommit(t *testing.T, dir, msg, date string) {
	t.Helper()
	cmd := exec.Command("git", "commit", "-m", msg)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_DATE="+date,
		"GIT_COMMITTER_DATE="+date,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit %q: %v\n%s", msg, err, out)
	}
}

// runGitAt 在 dir 跑 git，失败时 t.Fatal
func runGitAt(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v (in %q): %v\n%s", args, dir, err, out)
	}
}

// dirtyWorktree 把 repo 的 worktree 弄成 N 个 dirty entry。
// 通过创建 N 个新文件 + git add（不 commit）模拟 "staged but uncommitted"。
// 也可以走 modify / delete / untracked 路径；这里用 add-only 是最稳定的方式。
// 用 6 位 zero-pad suffix 保证 n > 9999 也不重名。
func dirtyWorktree(t *testing.T, localPath string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		name := filepath.Join(localPath, fmt.Sprintf("dirty_%06d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatalf("write dirty file %d: %v", i, err)
		}
	}
	// staged but uncommitted → git status --porcelain 报告 "A  filename"
	runGitAt(t, localPath, "add", "-A")
}

// dirtyWorktreeUntracked 制造 N 个 untracked 文件（git status --porcelain 报告 "?? filename"）
// 用 i 做 4 位 zero-pad suffix 保证 n > 9999 也不重复。
func dirtyWorktreeUntracked(t *testing.T, localPath string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		name := filepath.Join(localPath, fmt.Sprintf("untracked_%06d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatalf("write untracked file %d: %v", i, err)
		}
	}
}

// TestDetectUncommittedChanges_CleanWorktree 干净 worktree → found=false
func TestDetectUncommittedChanges_CleanWorktree(t *testing.T) {
	localPath := createTestRepoWithCommit(t)

	headSHA, count, found, err := detectUncommittedChanges(localPath)
	if err != nil {
		t.Fatalf("detectUncommittedChanges err: %v", err)
	}
	if found {
		t.Errorf("干净 worktree 应该 found=false，实际 found=true (count=%d)", count)
	}
	if headSHA == "" {
		t.Errorf("headSHA 不应为空")
	}
	if count != 0 {
		t.Errorf("count 应为 0，实际 %d", count)
	}
}

// TestDetectUncommittedChanges_StagedFiles staged-but-not-committed → found=true, count=N
func TestDetectUncommittedChanges_StagedFiles(t *testing.T) {
	localPath := createTestRepoWithCommit(t)
	dirtyWorktree(t, localPath, 3)

	headSHA, count, found, err := detectUncommittedChanges(localPath)
	if err != nil {
		t.Fatalf("detectUncommittedChanges err: %v", err)
	}
	if !found {
		t.Fatalf("3 个 staged 文件应 found=true，实际 false")
	}
	if count != 3 {
		t.Errorf("count 应为 3，实际 %d", count)
	}
	if headSHA == "" {
		t.Errorf("headSHA 不应为空")
	}
}

// TestDetectUncommittedChanges_UntrackedFiles untracked 文件 → found=true, count=N
func TestDetectUncommittedChanges_UntrackedFiles(t *testing.T) {
	localPath := createTestRepoWithCommit(t)
	dirtyWorktreeUntracked(t, localPath, 5)

	headSHA, count, found, err := detectUncommittedChanges(localPath)
	if err != nil {
		t.Fatalf("detectUncommittedChanges err: %v", err)
	}
	if !found {
		t.Fatalf("5 个 untracked 文件应 found=true，实际 false")
	}
	if count != 5 {
		t.Errorf("count 应为 5，实际 %d", count)
	}
	if headSHA == "" {
		t.Errorf("headSHA 不应为空")
	}
}

// TestDetectUncommittedChanges_ModifiedFiles 改一个文件的内容 → found=true
func TestDetectUncommittedChanges_ModifiedFiles(t *testing.T) {
	localPath := createTestRepoWithCommit(t)
	if err := os.WriteFile(filepath.Join(localPath, "a.txt"), []byte("modified"), 0o644); err != nil {
		t.Fatalf("modify: %v", err)
	}

	_, count, found, err := detectUncommittedChanges(localPath)
	if err != nil {
		t.Fatalf("detectUncommittedChanges err: %v", err)
	}
	if !found {
		t.Fatalf("modified file 应 found=true")
	}
	if count != 1 {
		t.Errorf("count 应为 1，实际 %d", count)
	}
}

// TestDetectUncommittedChanges_BadPath 不存在路径 → found=false 且不返回 error
func TestDetectUncommittedChanges_BadPath(t *testing.T) {
	_, _, found, err := detectUncommittedChanges("/nonexistent/path/should/not/exist")
	if err != nil {
		t.Errorf("bad path 应 silently skip，实际 err: %v", err)
	}
	if found {
		t.Errorf("bad path 应 found=false")
	}
}

// TestDetectUncommittedChanges_DirtyFileCap dirty 数 > cap 时仍 found=true（仅 cap 内精确计数）
func TestDetectUncommittedChanges_DirtyFileCap(t *testing.T) {
	localPath := createTestRepoWithCommit(t)
	// dirty 数量 > dirtyFileCap (5000) → 函数早停但仍返回 found=true
	dirtyWorktreeUntracked(t, localPath, dirtyFileCap+10)

	_, count, found, err := detectUncommittedChanges(localPath)
	if err != nil {
		t.Fatalf("detectUncommittedChanges err: %v", err)
	}
	if !found {
		t.Fatalf("dirty 数 > cap 应仍 found=true")
	}
	// count 应 == cap+1（break 时 count 已经被 ++ 一次，实际值是 cap+1）
	// 真实场景下 UI 看到 count >= cap 就展示 ">N files"，不再精确计数
	if count != dirtyFileCap+1 {
		t.Errorf("count 应早停在 cap+1=%d，实际 %d", dirtyFileCap+1, count)
	}
}

// TestLogCommitsVscode_PrependsUncommittedWhenDirty 集成测试：
// LogCommitsVscode 在 worktree dirty 时应该 unshift UNCOMMITTED 虚拟 commit
// 到 commits[0]（对齐 vscode-git-graph dataSource.ts:191）。
func TestLogCommitsVscode_PrependsUncommittedWhenDirty(t *testing.T) {
	localPath := createTestRepoWithCommit(t)
	dirtyWorktree(t, localPath, 2)

	ctx := context.Background()
	result, err := LogCommitsVscode(ctx, LogOptions{
		LocalPath: localPath,
		MaxCount:  100,
	})
	if err != nil {
		t.Fatalf("LogCommitsVscode err: %v", err)
	}
	if len(result.Commits) < 2 {
		t.Fatalf("commits 至少 2 个（1 UNCOMMITTED + 至少 1 真实），实际 %d", len(result.Commits))
	}

	// commits[0] 必须是 UNCOMMITTED 虚拟 commit
	first := result.Commits[0]
	if first.SHA != UNCOMMITTED_HASH {
		t.Errorf("commits[0].SHA 应该是 %q (UNCOMMITTED)，实际 %q", UNCOMMITTED_HASH, first.SHA)
	}
	if first.Subject == "" {
		t.Errorf("UNCOMMITTED Subject 不应为空")
	}
	if !strings.Contains(first.Subject, "2") {
		t.Errorf("UNCOMMITTED Subject 应包含 dirty 数 2，实际 %q", first.Subject)
	}

	// UNCOMMITTED.Parents[0] = local HEAD SHA
	cmd := exec.Command("git", "-C", localPath, "rev-parse", "HEAD")
	out, _ := cmd.Output()
	expectedHead := strings.TrimSpace(string(out))
	if len(first.Parents) != 1 || first.Parents[0] != expectedHead {
		t.Errorf("UNCOMMITTED.Parents 应该是 [headSHA=%q]，实际 %v", expectedHead, first.Parents)
	}
}

// TestLogCommitsVscode_NoUncommittedWhenClean 集成测试：clean worktree → 没有 UNCOMMITTED
func TestLogCommitsVscode_NoUncommittedWhenClean(t *testing.T) {
	localPath := createTestRepoWithCommit(t)

	ctx := context.Background()
	result, err := LogCommitsVscode(ctx, LogOptions{
		LocalPath: localPath,
		MaxCount:  100,
	})
	if err != nil {
		t.Fatalf("LogCommitsVscode err: %v", err)
	}
	if len(result.Commits) == 0 {
		t.Fatal("commits 不应为空")
	}
	if result.Commits[0].SHA == UNCOMMITTED_HASH {
		t.Errorf("clean worktree 不应 prepend UNCOMMITTED，但 commits[0].SHA = %q", result.Commits[0].SHA)
	}
}
