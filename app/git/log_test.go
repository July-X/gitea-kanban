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
