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

	// 验证 parents（线性历史）
	// 最新 commit 有 1 个 parent
	if len(result.Commits[0].Parents) != 1 {
		t.Errorf("first commit parents = %d, want 1", len(result.Commits[0].Parents))
	}
	// 最早 commit 无 parent
	if len(result.Commits[2].Parents) != 0 {
		t.Errorf("last commit parents = %d, want 0", len(result.Commits[2].Parents))
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
		t.Fatalf("expected 2 commits (MaxCount), got %d", len(result.Commits))
	}
	if !result.Truncated {
		t.Error("expected truncated=true")
	}
}

func TestLogCommits_Order(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 按时间降序：third > second > first
	subs := []string{result.Commits[0].Subject, result.Commits[1].Subject, result.Commits[2].Subject}
	if subs[0] != "third commit" || subs[1] != "second commit" || subs[2] != "first commit" {
		t.Errorf("order wrong: %v", subs)
	}
}

func TestExtractSubject(t *testing.T) {
	cases := []struct {
		msg    string
		expect string
	}{
		{"single line", "single line"},
		{"first line\nsecond line", "first line"},
		{"no newline at end", "no newline at end"},
		{"", ""},
		{"标题\n\n正文段落", "标题"},
	}
	for _, c := range cases {
		got := extractSubject(c.msg)
		if got != c.expect {
			t.Errorf("extractSubject(%q) = %q, want %q", c.msg, got, c.expect)
		}
	}
}

func TestLogCommits_NonExistentRepo(t *testing.T) {
	_, err := LogCommits(LogOptions{
		LocalPath: "/nonexistent/path",
	})
	if err == nil {
		t.Error("expected error for non-existent repo")
	}
	if !strings.Contains(err.Error(), "打开仓库失败") {
		t.Errorf("error should mention repo open failure: %v", err)
	}
}

// createTestRepoWithRefs 创建一个有 branch + tag 的测试仓库
func createTestRepoWithRefs(t *testing.T) string {
	t.Helper()
	dir := createTestRepoWithCommits(t)

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// 创建 feature 分支指向最新 commit
	runGit("checkout", "-b", "feature")

	// 创建一个 tag 指向中间 commit（second commit）
	// 用 git rev-parse 找 commit SHA
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

	// 最新 commit (third commit) → Refs 应包含默认分支和 feature
	head := result.Commits[0]
	if !contains(head.Refs, defaultBranch) {
		t.Errorf("head commit Refs missing %q: got %v", defaultBranch, head.Refs)
	}
	if !contains(head.Refs, "feature") {
		t.Errorf("head commit Refs missing 'feature': got %v", head.Refs)
	}

	// 中间 commit (second commit) → Refs 应包含 v1.0 tag
	middle := result.Commits[1]
	if !contains(middle.Refs, "v1.0") {
		t.Errorf("middle commit Refs missing 'v1.0': got %v", middle.Refs)
	}

	// 最早 commit (first commit) → 无 ref
	root := result.Commits[2]
	if len(root.Refs) != 0 {
		t.Errorf("root commit should have no refs, got %v", root.Refs)
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
