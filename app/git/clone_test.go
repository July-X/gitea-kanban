package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
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

	// 直接测路径计算
	path := RepoLocalPath(workspace, "my-org", "my-repo")
	expected := filepath.Join(workspace, "repos", "my-org__my-repo")
	if path != expected {
		t.Errorf("RepoLocalPath = %q, want %q", path, expected)
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
