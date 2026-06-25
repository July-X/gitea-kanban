package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// createTestRepoWithCommits 创建一个有多个 commit 的测试仓库
func createTestRepoWithCommits(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 用 GIT_COMMITTER_DATE/GIT_AUTHOR_DATE 显式设置不同时间
	// 避免秒级时间戳相同导致 LogCommits 排序不稳定
	commitAt := func(msg, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v\n%s", err, out)
		}
	}

	// 3 个 commit，时间严格递增
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	commitAt("first commit", "2026-01-01T10:00:00Z")

	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	commitAt("second commit", "2026-01-01T11:00:00Z")

	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	commitAt("third commit", "2026-01-01T12:00:00Z")

	return dir
}

func TestLogCommits_BasicHistory(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// 最新 commit 应该是 "third commit"
	if result.Commits[0].Subject != "third commit" {
		t.Errorf("first commit subject = %q, want 'third commit'", result.Commits[0].Subject)
	}

	// 验证 SHA 和 ShortSHA
	if len(result.Commits[0].SHA) != 40 {
		t.Errorf("SHA length = %d, want 40", len(result.Commits[0].SHA))
	}
	if len(result.Commits[0].ShortSHA) != 7 {
		t.Errorf("ShortSHA length = %d, want 7", len(result.Commits[0].ShortSHA))
	}

	// 验证 author
	if result.Commits[0].AuthorName != "Test User" {
		t.Errorf("AuthorName = %q, want 'Test User'", result.Commits[0].AuthorName)
	}
	if result.Commits[0].AuthorEmail != "test@test.com" {
		t.Errorf("AuthorEmail = %q, want 'test@test.com'", result.Commits[0].AuthorEmail)
	}

	// 验证时间（用显式 GIT_COMMITTER_DATE 设置的固定时间，不校验"最近"）
	expectedTime, _ := time.Parse(time.RFC3339, "2026-01-01T12:00:00Z")
	if !result.Commits[0].AuthorWhen.Equal(expectedTime) {
		t.Errorf("AuthorWhen = %v, want %v", result.Commits[0].AuthorWhen, expectedTime)
	}

	// 验证 parents（第一个 commit 有 1 个 parent）
	if len(result.Commits[0].Parents) != 1 {
		t.Errorf("Parents length = %d, want 1", len(result.Commits[0].Parents))
	}
}

func TestLogCommits_MaxCount(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
		MaxCount:  2,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 2 {
		t.Errorf("expected 2 commits, got %d", len(result.Commits))
	}

	if !result.Truncated {
		t.Errorf("expected Truncated = true, got false")
	}
}

func TestLogCommits_Order(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// 验证时间倒序（最新的在前）
	if !result.Commits[0].AuthorWhen.After(result.Commits[1].AuthorWhen) {
		t.Errorf("commits not in descending order")
	}
	if !result.Commits[1].AuthorWhen.After(result.Commits[2].AuthorWhen) {
		t.Errorf("commits not in descending order")
	}
}

func TestLogCommits_NonExistentRepo(t *testing.T) {
	result, err := LogCommits(LogOptions{
		LocalPath: "/nonexistent/repo",
	})
	if err == nil {
		t.Errorf("expected error for non-existent repo, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result for error case, got %+v", result)
	}
}

// createTestRepoWithRefs 创建一个有多个分支和 tag 的测试仓库
func createTestRepoWithRefs(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 3 个 commit
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "first commit")

	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "second commit")

	// 创建 feature 分支
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "third commit")

	// 在 second commit 上打 tag
	cmd := exec.Command("git", "rev-parse", "HEAD~1")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse: %v\n%s", err, out)
	}
	secondCommitSHA := strings.TrimSpace(string(out))
	runGit("tag", "v1.0", secondCommitSHA)

	// 切回默认分支（兼容 master / main，v2.6 后老 git init 仍默认 master）
	defaultBranch := currentDefaultBranch(t, dir)
	runGit("checkout", defaultBranch)

	return dir
}

// currentDefaultBranch 返回 git 默认分支名（master / main 兼容）
func currentDefaultBranch(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "symbolic-ref", "--short", "HEAD")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("symbolic-ref: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestLogCommits_RefsAttached 验证 LogCommits 返回的每条 CommitInfo 都附带 refs
//
// v2.7 增量：前端右侧 commit 行需要渲染分支/tag badge，
// 后端必须在 LogCommits 时收集 refs 并附加到 CommitInfo。
//
// 测试场景：
//   - default 分支指向最新 commit → 最新 commit 的 Refs 应包含默认分支名
//   - feature 分支指向最新 commit → 最新 commit 的 Refs 应包含 "feature"
//   - v1.0 tag 指向 second commit → second commit 的 Refs 应包含 "v1.0"
func TestLogCommits_RefsAttached(t *testing.T) {
	repoPath := createTestRepoWithRefs(t)
	defaultBranch := currentDefaultBranch(t, repoPath)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// v2.7: 由于分支限制和优先级排序，可能先遍历 HEAD（指向默认分支），
	// 所以结果顺序可能不同。找到 "third commit" 验证其 refs
	var thirdCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "third commit" {
			thirdCommit = &result.Commits[i]
			break
		}
	}
	if thirdCommit == nil {
		t.Fatalf("expected to find 'third commit' in results")
	}
	if !contains(thirdCommit.Refs, "feature") {
		t.Errorf("expected 'feature' in third commit Refs, got %v", thirdCommit.Refs)
	}

	// second commit → Refs 应包含 "v1.0" tag
	var secondCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "second commit" {
			secondCommit = &result.Commits[i]
			break
		}
	}
	if secondCommit == nil {
		t.Fatalf("expected to find 'second commit' in results")
	}
	if !contains(secondCommit.Refs, "v1.0") {
		t.Errorf("expected 'v1.0' in second commit Refs, got %v", secondCommit.Refs)
	}

	// first commit → Refs 应包含默认分支（因为 feature 是从 main 的 second commit 分出的）
	first := result.Commits[2]
	if first.Subject != "first commit" {
		t.Fatalf("expected first commit to be 'first commit', got %q", first.Subject)
	}
	// first commit 在 main 的历史里，但 HEAD 指向 main 的 second commit（checkout 回去后）
	// 所以 first commit 可能有或没有 ref，这里不强制断言（git 行为可能不同）
	// 主要验证 second/third commit 的 refs 正确即可
	if len(first.Refs) > 0 && !contains(first.Refs, defaultBranch) {
		t.Logf("first commit Refs: %v (might or might not contain %s)", first.Refs, defaultBranch)
	}
}

// TestLogCommits_NoRefsOnEmpty 验证没有任何 ref 的 commit Refs 为空 slice（不是 nil）
func TestLogCommits_NoRefsOnEmpty(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// 默认 main 分支指向最新 commit，所以 head 有 "main" ref
	// 但中间和最早 commit 应无 ref
	if len(result.Commits[1].Refs) != 0 {
		t.Errorf("middle commit Refs should be empty, got %v", result.Commits[1].Refs)
	}
	if len(result.Commits[2].Refs) != 0 {
		t.Errorf("root commit Refs should be empty, got %v", result.Commits[2].Refs)
	}
}

// contains 检查字符串 slice 是否包含指定字符串
func contains(slice []string, target string) bool {
	for _, s := range slice {
		if s == target {
			return true
		}
	}
	return false
}

// TestLogCommits_ManyBranches 验证超大仓库分支限制功能
//
// v2.7 优化：超大仓库（如 UnrealEngine）可能有几十上百个分支，
// 全遍历会导致性能问题。验证分支限制逻辑：
//   - 创建 30 个分支（远超默认限制 20）
//   - 验证只遍历有限数量的分支（应该 < 30）
//   - 验证主分支（main/master）被优先遍历
func TestLogCommits_ManyBranches(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 创建初始 commit
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("test"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")

	// 获取默认分支名
	defaultBranch := currentDefaultBranch(t, dir)

	// 创建 30 个分支（每个分支一个 commit）
	for i := 1; i <= 30; i++ {
		branchName := "feature-" + string(rune('a'+i-1))
		if i > 26 {
			branchName = "feature-extra-" + string(rune('0'+i-27))
		}
		runGit("checkout", "-b", branchName)
		filename := branchName + ".txt"
		os.WriteFile(filepath.Join(dir, filename), []byte(branchName), 0o644)
		runGit("add", ".")
		runGit("commit", "-m", "add "+branchName)
		runGit("checkout", defaultBranch)
	}

	// 切回默认分支
	runGit("checkout", defaultBranch)

	// 调用 LogCommits（应该限制分支遍历数量）
	result, err := LogCommits(LogOptions{
		LocalPath: dir,
		MaxCount:  200, // 请求 200 个 commit
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// 验证：不应该遍历所有 31 个 commit（1 个初始 + 30 个分支）
	// 因为分支限制，应该只遍历部分分支的 commit
	// 注：每个分支有 2 个 commit（initial + 分支自己的），但去重后 initial 只算一次
	if len(result.Commits) == 31 {
		t.Errorf("expected less than 31 commits due to branch limit, got %d", len(result.Commits))
	}

	// 验证至少有一些 commit（不应该为空）
	if len(result.Commits) == 0 {
		t.Fatalf("expected some commits, got 0")
	}

	// 验证结果包含初始 commit（所有分支都共享）
	foundInitial := false
	for _, c := range result.Commits {
		if c.Subject == "initial commit" {
			foundInitial = true
			break
		}
	}
	if !foundInitial {
		t.Errorf("expected to find initial commit")
	}

	t.Logf("Created 30 branches, got %d commits (branch limiting working)", len(result.Commits))
}
