package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// createTestRepoWithRemote 创建一个本地仓库 + 一个 bare 远端，并 push main 上去。
// 返回 (localPath, remotePath)。本地和远端都设置了 user.email/name。
func createTestRepoWithRemote(t *testing.T) (string, string) {
	t.Helper()
	base := t.TempDir()
	localPath := filepath.Join(base, "local")
	remotePath := filepath.Join(base, "remote.git")

	// 1. 创建 bare 远端
	if err := os.MkdirAll(remotePath, 0o755); err != nil {
		t.Fatalf("mkdir remote: %v", err)
	}
	runGitAt(t, remotePath, "init", "--bare")

	// 2. 创建本地仓库，提交一个 commit，push 到远端
	if err := os.MkdirAll(localPath, 0o755); err != nil {
		t.Fatalf("mkdir local: %v", err)
	}
	runGitAt(t, localPath, "init")
	runGitAt(t, localPath, "config", "user.email", "test@test.com")
	runGitAt(t, localPath, "config", "user.name", "Test User")

	os.WriteFile(filepath.Join(localPath, "a.txt"), []byte("a"), 0o644)
	runGitAt(t, localPath, "add", ".")
	envCommit(t, localPath, "initial commit", "2026-01-01T10:00:00Z")
	runGitAt(t, localPath, "branch", "-M", "main")
	runGitAt(t, localPath, "remote", "add", "origin", remotePath)
	runGitAt(t, localPath, "push", "-u", "origin", "main")

	return localPath, remotePath
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

// runGitAt 在 dir 跑 git，失败时 t.Fatal（与 ascii_graph_test.go 的 runGit
// 冲突时改名以避免重复定义；本文件用 runGitAt 显式带 dir 参数）
func runGitAt(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v (in %q): %v\n%s", args, dir, err, out)
	}
}

// advanceRemote 在远端加 N 个 commit，然后 fetch 到本地（不 merge），制造
// "local 落后 origin" 的场景。
func advanceRemote(t *testing.T, localPath, remotePath string, n int) {
	t.Helper()
	// 1. 用一个临时 worktree 在远端目录 commit（bare 不能直接 commit）
	workPath := t.TempDir()
	runGitAt(t, workPath, "init")
	runGitAt(t, workPath, "config", "user.email", "test@test.com")
	runGitAt(t, workPath, "config", "user.name", "Test User")
	runGitAt(t, workPath, "remote", "add", "origin", remotePath)
	runGitAt(t, workPath, "fetch", "origin", "main")
	runGitAt(t, workPath, "checkout", "-b", "main", "origin/main")

	for i := 0; i < n; i++ {
		fname := []byte{'a' + byte(i+1)}
		os.WriteFile(filepath.Join(workPath, string(fname)+".txt"), fname, 0o644)
		runGitAt(t, workPath, "add", ".")
		date := "2026-01-02T1" + string(rune('0'+i)) + ":00:00Z"
		envCommit(t, workPath, "remote commit "+string(fname), date)
	}
	runGitAt(t, workPath, "push", "origin", "main")

	// 2. 本地 fetch，但**不 pull/merge**（保持本地落后）
	runGitAt(t, localPath, "fetch", "origin")
}

func TestDetectUnpulledCommits_NoAhead(t *testing.T) {
	localPath, _ := createTestRepoWithRemote(t)

	headSHA, count, found, err := detectUnpulledCommits(localPath)
	if err != nil {
		t.Fatalf("detectUnpulledCommits err: %v", err)
	}
	if found {
		t.Errorf("local 和 origin 平，应该 found=false，实际 found=true (count=%d)", count)
	}
	if headSHA == "" {
		t.Errorf("headSHA 应该是本地 HEAD SHA，实际为空")
	}
	if count != 0 {
		t.Errorf("count 应该为 0，实际 %d", count)
	}
}

func TestDetectUnpulledCommits_LocalBehind(t *testing.T) {
	localPath, remotePath := createTestRepoWithRemote(t)
	advanceRemote(t, localPath, remotePath, 3)

	headSHA, count, found, err := detectUnpulledCommits(localPath)
	if err != nil {
		t.Fatalf("detectUnpulledCommits err: %v", err)
	}
	if !found {
		t.Fatalf("local 落后 3 commit，found 应该为 true，实际 false")
	}
	if count != 3 {
		t.Errorf("count 应该为 3，实际 %d", count)
	}
	if headSHA == "" {
		t.Errorf("headSHA 不应为空")
	}
	// 验证 headSHA 真的是本地 HEAD
	cmd := exec.Command("git", "-C", localPath, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git rev-parse HEAD: %v", err)
	}
	if headSHA != string(out[:len(out)-1]) { // trim newline
		t.Errorf("headSHA = %q, git rev-parse HEAD = %q", headSHA, string(out))
	}
}

func TestDetectUnpulledCommits_NoOriginHEAD(t *testing.T) {
	// 不创建远端，本地仓库有 commit。origin/HEAD 不存在，应该 found=false
	localPath := t.TempDir()
	runGitAt(t, localPath, "init")
	runGitAt(t, localPath, "config", "user.email", "test@test.com")
	runGitAt(t, localPath, "config", "user.name", "Test User")
	os.WriteFile(filepath.Join(localPath, "a.txt"), []byte("a"), 0o644)
	runGitAt(t, localPath, "add", ".")
	envCommit(t, localPath, "only commit", "2026-01-01T10:00:00Z")

	_, _, found, err := detectUnpulledCommits(localPath)
	if err != nil {
		t.Fatalf("detectUnpulledCommits err: %v", err)
	}
	if found {
		t.Errorf("没有 origin/HEAD 时应该 found=false")
	}
}

func TestDetectUnpulledCommits_BadPath(t *testing.T) {
	// 路径不存在应该 found=false 且不返回 error
	_, _, found, err := detectUnpulledCommits("/nonexistent/path")
	if err != nil {
		t.Errorf("bad path 应该 silently skip，实际返回 error: %v", err)
	}
	if found {
		t.Errorf("bad path 应该 found=false")
	}
}

func TestLogCommitsVscode_PrependsUncommitted(t *testing.T) {
	// 集成测试：LogCommitsVscode 在 local 落后 origin 时应该 insert UNCOMMITTED 到
	// local HEAD 之前（不是直接 unshift 到最前 —— all-branches 视图下 commits[0] 可能是
	// origin 上的 commit，应保持原顺序，UNCOMMITTED 紧贴本地 HEAD 上方）。
	localPath, remotePath := createTestRepoWithRemote(t)
	advanceRemote(t, localPath, remotePath, 2)

	ctx := context.Background()
	result, err := LogCommitsVscode(ctx, LogOptions{
		LocalPath: localPath,
		MaxCount:  100,
	})
	if err != nil {
		t.Fatalf("LogCommitsVscode err: %v", err)
	}
	if len(result.Commits) < 2 {
		t.Fatalf("commits 至少 2 个（1 本地 + 3 远端），实际 %d", len(result.Commits))
	}

	// 找到 local HEAD 在 commits 列表中的位置
	cmd := exec.Command("git", "-C", localPath, "rev-parse", "HEAD")
	out, _ := cmd.Output()
	expectedHead := string(out[:len(out)-1])

	headIdx := -1
	for i, c := range result.Commits {
		if c.SHA == expectedHead {
			headIdx = i
			break
		}
	}
	if headIdx < 0 {
		t.Fatalf("commits 列表中找不到本地 HEAD %q", expectedHead)
	}
	// headIdx - 1 必须是 UNCOMMITTED
	uncommitted := result.Commits[headIdx-1]
	if uncommitted.SHA != UNCOMMITTED_HASH {
		t.Errorf("commits[headIdx-1].SHA 应该是 %q，实际 %q (headIdx=%d)",
			UNCOMMITTED_HASH, uncommitted.SHA, headIdx)
	}
	if uncommitted.Subject == "" {
		t.Errorf("UNCOMMITTED Subject 不应为空")
	}
	if len(uncommitted.Parents) != 1 || uncommitted.Parents[0] != expectedHead {
		t.Errorf("UNCOMMITTED.Parents 应该是 [headSHA=%q]，实际 %v", expectedHead, uncommitted.Parents)
	}
}

func TestLogCommitsVscode_NoUncommittedWhenUpToDate(t *testing.T) {
	// 集成测试：local 不落后时不应该有 UNCOMMITTED
	localPath, _ := createTestRepoWithRemote(t)

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
		t.Errorf("local 与 origin 平时不应该 prepend UNCOMMITTED，但 commits[0].SHA = %q", result.Commits[0].SHA)
	}
}
