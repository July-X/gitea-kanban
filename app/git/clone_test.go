package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
)

// createBareTestRepo 创建一个本地 bare git 仓库（用系统 git，仅测试用）
//
// 生产代码用 go-git，但测试中需要一个"远端"仓库作为 clone 源。
// 用系统 git 创建 bare 仓库是最简单的方式。
func createBareTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	repoPath := filepath.Join(dir, "test-repo.git")

	// git init --bare
	cmd := exec.Command("git", "init", "--bare", repoPath)
	if err := cmd.Run(); err != nil {
		t.Skipf("git not available, skipping: %v", err)
	}

	// 创建一个源仓库，提交后 push 到 bare 仓库
	srcPath := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcPath, 0o755); err != nil {
		t.Fatal(err)
	}

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = srcPath
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")
	os.WriteFile(filepath.Join(srcPath, "README.md"), []byte("# Test\n"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")
	runGit("remote", "add", "origin", repoPath)
	runGit("push", "origin", "master")

	return repoPath
}

func TestCloneRepo_LocalFileProtocol(t *testing.T) {
	bareRepo := createBareTestRepo(t)

	workspace := t.TempDir()

	// 用 file:// 协议 clone（不需要 token）
	result, err := CloneRepo(CloneOptions{
		Platform:      "gitea",
		HostURL:       filepath.Dir(bareRepo),
		Owner:         "",
		Repo:          "",
		Token:         "",
		Username:      "",
		WorkspacePath: workspace,
	})
	// 这种调用方式 URL 构造不对（owner/repo 空），应该报错
	if err == nil {
		t.Fatal("expected error for empty owner/repo, got nil")
	}
	_ = result
}

func TestCloneRepo_FilePath(t *testing.T) {
	workspace := t.TempDir()

	// 直接测路径计算（旧版）
	path := RepoLocalPath(workspace, "my-org", "my-repo")
	expected := filepath.Join(workspace, "repos", "my-org__my-repo")
	if path != expected {
		t.Errorf("RepoLocalPath = %q, want %q", path, expected)
	}

	// v2.5 新版：按账号分层
	newPath := RepoLocalPathForAccount(workspace, "alice", "my-org", "my-repo")
	newExpected := filepath.Join(workspace, "repos", "alice", "my-org__my-repo")
	if newPath != newExpected {
		t.Errorf("RepoLocalPathForAccount = %q, want %q", newPath, newExpected)
	}

	// AccountDirName 测试
	if got := AccountDirName("alice"); got != "alice" {
		t.Errorf("AccountDirName(\"alice\") = %q, want alice", got)
	}
	if got := AccountDirName(""); got != "_unknown" {
		t.Errorf("AccountDirName(\"\") = %q, want _unknown", got)
	}
	// 含特殊字符的 username 应被 sanitize
	if got := AccountDirName("July@X"); got != "July_X" {
		t.Errorf("AccountDirName(\"July@X\") = %q, want July_X", got)
	}
}

func TestCloneRepo_SanitizeName(t *testing.T) {
	cases := []struct {
		input  string
		expect string
	}{
		{"simple", "simple"},
		{"org/repo", "org_repo"},
		{"my-org.my-repo", "my-org.my-repo"},
		{"中文", "__"},
		{"a@b#c", "a_b_c"},
	}
	for _, c := range cases {
		got := sanitizeName(c.input)
		if got != c.expect {
			t.Errorf("sanitizeName(%q) = %q, want %q", c.input, got, c.expect)
		}
	}
}

func TestCleanRepoURL(t *testing.T) {
	cases := []struct {
		host   string
		owner  string
		repo   string
		expect string
	}{
		{"https://gitea.example.com", "myorg", "myrepo", "https://gitea.example.com/myorg/myrepo.git"},
		{"https://github.com/", "octocat", "hello-world", "https://github.com/octocat/hello-world.git"},
		{"https://gitea.example.com///", "a", "b", "https://gitea.example.com/a/b.git"},
	}
	for _, c := range cases {
		got := CleanRepoURL(c.host, c.owner, c.repo)
		if got != c.expect {
			t.Errorf("CleanRepoURL(%q,%q,%q) = %q, want %q", c.host, c.owner, c.repo, got, c.expect)
		}
	}
}

func TestRepoExists(t *testing.T) {
	dir := t.TempDir()

	// 不存在的路径
	if RepoExists(dir) {
		t.Error("RepoExists should be false for empty dir")
	}

	// 创建 .git 目录
	gitDir := filepath.Join(dir, ".git")
	os.MkdirAll(gitDir, 0o755)
	if !RepoExists(dir) {
		t.Error("RepoExists should be true for dir with .git")
	}
}

// TestCloneRepo_NoCheckout_NoWorktreeFiles 验证 v2.4 关键性质：
//   - 源仓库 push 了 README.md → clone 后 worktree 目录**不**应有 README.md
//   - .git/objects/ 完整 → LogCommits 能跑（Git Graph 元信息足够）
func TestCloneRepo_NoCheckout_NoWorktreeFiles(t *testing.T) {
	// 创建带 README.md + main.go 的源仓库
	dir := t.TempDir()
	repoPath := filepath.Join(dir, "test-repo.git")
	cmd := exec.Command("git", "init", "--bare", "-b", "main", repoPath)
	if err := cmd.Run(); err != nil {
		// 旧版 git (≤2.28) 不支持 -b，fallback
		cmd = exec.Command("git", "init", "--bare", repoPath)
		if err := cmd.Run(); err != nil {
			t.Skipf("git not available: %v", err)
		}
		// 改 default branch → main（通过改 HEAD symbolic ref）
		hcmd := exec.Command("git", "symbolic-ref", "HEAD", "refs/heads/main")
		hcmd.Dir = repoPath
		if out, err := hcmd.CombinedOutput(); err != nil {
			t.Skipf("git symbolic-ref HEAD failed: %v\n%s", err, out)
		}
	}

	srcPath := filepath.Join(dir, "src")
	os.MkdirAll(srcPath, 0o755)
	runGit := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = srcPath
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")
	os.WriteFile(filepath.Join(srcPath, "README.md"), []byte("# Hello\n"), 0o644)
	os.WriteFile(filepath.Join(srcPath, "main.go"), []byte("package main\n"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")
	runGit("branch", "-M", "main")
	runGit("remote", "add", "origin", repoPath)
	runGit("push", "-u", "origin", "main")

	// v2.5 clone（默认 refspec 同步远程分支；NoCheckout=true 跳过工作区文件）
	workspace := t.TempDir()
	result, err := CloneRepo(CloneOptions{
		Platform:      "gitea",
		URL:           "file://" + repoPath, // 直传 file:// + bare 仓库绝对路径
		WorkspacePath: workspace,
		NoCheckout:    true, // v2.4：只拉元信息
	})
	if err != nil {
		t.Fatalf("CloneRepo failed: %v", err)
	}

	// 1. 应创建普通仓库（有 .git），不能再生成 Mirror/bare 仓库
	if !RepoExists(result.LocalPath) {
		t.Errorf("仓库应该存在: %s", result.LocalPath)
	}
	if _, err := os.Stat(filepath.Join(result.LocalPath, ".git")); err != nil {
		t.Errorf("仓库应为普通 NoCheckout 仓库，必须有 .git 目录: %v", err)
	}

	// 2. worktree 目录**应该没有** README.md / main.go（NoCheckout 模式）
	readmePath := filepath.Join(result.LocalPath, "README.md")
	mainGoPath := filepath.Join(result.LocalPath, "main.go")
	if _, err := os.Stat(readmePath); err == nil {
		t.Error("v2.4 轻量 clone 不应 checkout README.md 到 worktree")
	}
	if _, err := os.Stat(mainGoPath); err == nil {
		t.Error("v2.4 轻量 clone 不应 checkout main.go 到 worktree")
	}

	// 3. .git/objects/ 完整 → LogCommits 能跑
	logResult, err := LogCommits(LogOptions{
		LocalPath: result.LocalPath,
		Branches:  []string{"main"},
		MaxCount:  10,
	})
	if err != nil {
		t.Errorf("LogCommits failed (应该是 NoCheckout 后 .git/objects 完整): %v", err)
	}
	if len(logResult.Commits) == 0 {
		t.Error("expected at least 1 commit, got 0")
	}
	// v3.x: NoCheckout 模式 worktree 空, index 有文件 → git status 报告 N 个 D,
	// detectUncommittedChanges 把 UNCOMMITTED 虚拟 commit 插到 commits[0]。
	// 真实 commit 在 commits[1]。
	if len(logResult.Commits) < 2 {
		t.Fatalf("expected at least 2 commits (UNCOMMITTED + initial), got %d", len(logResult.Commits))
	}
	if logResult.Commits[0].SHA != UNCOMMITTED_HASH {
		t.Errorf("commits[0].SHA = %q, want %q (UNCOMMITTED 虚拟 commit)", logResult.Commits[0].SHA, UNCOMMITTED_HASH)
	}
	if logResult.Commits[1].Subject != "initial commit" {
		t.Errorf("commit[1] subject = %q, want %q", logResult.Commits[1].Subject, "initial commit")
	}
}

// TestCloneRepo_AllBranchesSynced 验证 v2.5 关键性质：
//   - 默认 refspec 应同步所有远程分支的 commit
//   - LogCommits 不指定 branches 时应返回所有分支的 commit
func TestCloneRepo_AllBranchesSynced(t *testing.T) {
	// 创建带多个分支的源仓库
	dir := t.TempDir()
	repoPath := filepath.Join(dir, "test-repo.git")
	cmd := exec.Command("git", "init", "--bare", "-b", "main", repoPath)
	if err := cmd.Run(); err != nil {
		cmd = exec.Command("git", "init", "--bare", repoPath)
		if err := cmd.Run(); err != nil {
			t.Skipf("git not available: %v", err)
		}
		hcmd := exec.Command("git", "symbolic-ref", "HEAD", "refs/heads/main")
		hcmd.Dir = repoPath
		hcmd.Run()
	}

	srcPath := filepath.Join(dir, "src")
	os.MkdirAll(srcPath, 0o755)
	runGit := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = srcPath
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("init", "-b", "main")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")

	// main 分支 1 个 commit
	os.WriteFile(filepath.Join(srcPath, "main.txt"), []byte("main"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "main commit")
	runGit("branch", "-M", "main")
	runGit("remote", "add", "origin", repoPath)
	runGit("push", "-u", "origin", "main")

	// feature 分支 1 个 commit
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(srcPath, "feature.txt"), []byte("feature"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "feature commit")
	runGit("push", "-u", "origin", "feature")

	// v2.5 clone（默认 refspec 同步所有远程分支）
	workspace := t.TempDir()
	result, err := CloneRepo(CloneOptions{
		Platform:      "gitea",
		URL:           "file://" + repoPath,
		WorkspacePath: workspace,
		NoCheckout:    true,
	})
	if err != nil {
		t.Fatalf("CloneRepo failed: %v", err)
	}

	// 1. LogCommits 不指定 branches 时应返回所有分支的 commit
	logResult, err := LogCommits(LogOptions{
		LocalPath: result.LocalPath,
		MaxCount:  10,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// v3.x: NoCheckout 模式会 prepend UNCOMMITTED 虚拟 commit, 所以是 3 个 commit
	// (UNCOMMITTED + main commit + feature commit)
	if len(logResult.Commits) != 3 {
		t.Errorf("expected 3 commits (UNCOMMITTED + main + feature), got %d", len(logResult.Commits))
		for i, c := range logResult.Commits {
			t.Logf("  commit[%d]: %s", i, c.Subject)
		}
	}
	if logResult.Commits[0].SHA != UNCOMMITTED_HASH {
		t.Errorf("commits[0] 应是 UNCOMMITTED, 实际 sha=%q", logResult.Commits[0].SHA)
	}

	hasMain := false
	hasFeature := false
	for _, c := range logResult.Commits {
		if c.Subject == "main commit" {
			hasMain = true
		}
		if c.Subject == "feature commit" {
			hasFeature = true
		}
	}
	if !hasMain {
		t.Error("expected 'main commit' in LogCommits result")
	}
	if !hasFeature {
		t.Error("expected 'feature commit' in LogCommits result (remote branch refs should sync)")
	}
}

func TestCloneRepo_LargeRepoMode_ShallowSingleBranchNoTags(t *testing.T) {
	dir := t.TempDir()
	repoPath := filepath.Join(dir, "test-repo.git")
	cmd := exec.Command("git", "init", "--bare", "-b", "main", repoPath)
	if err := cmd.Run(); err != nil {
		t.Skipf("git not available: %v", err)
	}

	srcPath := filepath.Join(dir, "src")
	os.MkdirAll(srcPath, 0o755)
	runGit := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = srcPath
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	runGit("init", "-b", "main")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test")
	for i := 1; i <= 3; i++ {
		os.WriteFile(filepath.Join(srcPath, "main.txt"), []byte{byte('0' + i)}, 0o644)
		runGit("add", ".")
		runGit("commit", "-m", "main commit")
	}
	runGit("tag", "v1.0.0")
	runGit("remote", "add", "origin", repoPath)
	runGit("push", "-u", "origin", "main", "--tags")
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(srcPath, "feature.txt"), []byte("feature"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "feature commit")
	runGit("push", "-u", "origin", "feature")

	result, err := CloneRepo(CloneOptions{
		URL:           "file://" + repoPath,
		WorkspacePath: t.TempDir(),
		NoCheckout:    true,
		Depth:         1,
		SingleBranch:  true,
		NoTags:        true,
	})
	if err != nil {
		t.Fatalf("CloneRepo failed: %v", err)
	}

	logResult, err := LogCommits(LogOptions{LocalPath: result.LocalPath, MaxCount: 10})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	// v3.x: NoCheckout 模式会 prepend UNCOMMITTED 虚拟 commit → 2 个 commit
	if len(logResult.Commits) != 2 {
		t.Fatalf("expected shallow clone to expose 2 commits (UNCOMMITTED + main), got %d", len(logResult.Commits))
	}
	if logResult.Commits[0].SHA != UNCOMMITTED_HASH {
		t.Fatalf("commits[0] 应是 UNCOMMITTED, 实际 sha=%q", logResult.Commits[0].SHA)
	}
	if logResult.Commits[1].Subject != "main commit" {
		t.Fatalf("commits[1] 应是 main commit, 实际 %q", logResult.Commits[1].Subject)
	}

	repo, err := gogit.PlainOpen(result.LocalPath)
	if err != nil {
		t.Fatalf("PlainOpen failed: %v", err)
	}
	tags, err := repo.Tags()
	if err != nil {
		t.Fatalf("Tags failed: %v", err)
	}
	tagCount := 0
	if err := tags.ForEach(func(_ *plumbing.Reference) error {
		tagCount++
		return nil
	}); err != nil {
		t.Fatalf("iterating tags failed: %v", err)
	}
	if tagCount != 0 {
		t.Fatalf("expected no tags to be fetched, got %d", tagCount)
	}
}
