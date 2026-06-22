package git

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkspaceManager_DefaultPath(t *testing.T) {
	wm := NewWorkspaceManager()
	path := wm.DefaultPath()

	if path == "" {
		t.Error("DefaultPath should not be empty")
	}
	if !filepath.IsAbs(path) {
		t.Errorf("DefaultPath should be absolute, got %q", path)
	}

	// v2.2：默认路径是 ~/.gitea-kanban/workspace（git repos 目录）
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, ".gitea-kanban", "workspace")
	if path != want {
		t.Errorf("DefaultPath = %q, want %q", path, want)
	}
}

func TestWorkspaceManager_ResolvePath(t *testing.T) {
	wm := NewWorkspaceManager()

	// 用户配置优先
	custom := "/tmp/custom-workspace"
	if got := wm.ResolvePath(custom); got != custom {
		t.Errorf("ResolvePath(%q) = %q, want %q", custom, got, custom)
	}

	// 空字符串走默认
	if got := wm.ResolvePath(""); got != wm.DefaultPath() {
		t.Errorf("ResolvePath('') = %q, want %q", got, wm.DefaultPath())
	}
}

func TestWorkspaceManager_EnsureDir(t *testing.T) {
	wm := NewWorkspaceManager()
	dir := filepath.Join(t.TempDir(), "ws-test")

	if err := wm.EnsureDir(dir); err != nil {
		t.Fatalf("EnsureDir failed: %v", err)
	}

	if _, err := os.Stat(dir); err != nil {
		t.Errorf("dir not created: %v", err)
	}
}

func TestWorkspaceManager_ValidatePath(t *testing.T) {
	wm := NewWorkspaceManager()

	// 存在且可写的目录
	dir := t.TempDir()
	if err := wm.ValidatePath(dir); err != nil {
		t.Errorf("ValidatePath(valid dir) failed: %v", err)
	}

	// 不存在
	if err := wm.ValidatePath("/nonexistent/path/xyz"); err == nil {
		t.Error("expected error for non-existent path")
	}

	// 不是目录（是文件）
	file := filepath.Join(t.TempDir(), "notdir")
	os.WriteFile(file, []byte("x"), 0o644)
	if err := wm.ValidatePath(file); err == nil {
		t.Error("expected error for file path")
	}
}

func TestWorkspaceManager_ListRepos_Empty(t *testing.T) {
	wm := NewWorkspaceManager()
	dir := t.TempDir()

	repos, err := wm.ListRepos(dir)
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if len(repos) != 0 {
		t.Errorf("expected 0 repos, got %d", len(repos))
	}
}

func TestWorkspaceManager_ListRepos_WithRepos(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()
	reposDir := filepath.Join(wsPath, "repos")

	// 创建两个仓库目录（含 .git）
	for _, name := range []string{"org1__repo1", "org2__repo2"} {
		repoPath := filepath.Join(reposDir, name)
		os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755)
	}

	// 创建一个非 git 目录（应被忽略）
	os.MkdirAll(filepath.Join(reposDir, "not-a-repo"), 0o755)

	repos, err := wm.ListRepos(wsPath)
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("expected 2 repos, got %d", len(repos))
	}

	// 验证排序
	if repos[0].Name != "org1__repo1" {
		t.Errorf("first repo = %q, want org1__repo1", repos[0].Name)
	}

	// 验证 owner/repo 解析
	if repos[0].Owner != "org1" || repos[0].Repo != "repo1" {
		t.Errorf("repo1 parsed: owner=%q repo=%q", repos[0].Owner, repos[0].Repo)
	}
}

func TestParseRepoDirName(t *testing.T) {
	cases := []struct {
		name     string
		wantOwner string
		wantRepo  string
	}{
		{"org__repo", "org", "repo"},
		{"my-org__my-repo", "my-org", "my-repo"},
		{"org__repo.git", "org", "repo"},
		{"norepo", "", "norepo"},
	}
	for _, c := range cases {
		owner, repo := parseRepoDirName(c.name)
		if owner != c.wantOwner || repo != c.wantRepo {
			t.Errorf("parseRepoDirName(%q) = (%q, %q), want (%q, %q)",
				c.name, owner, repo, c.wantOwner, c.wantRepo)
		}
	}
}

func TestWorkspaceManager_MigrateRepo(t *testing.T) {
	wm := NewWorkspaceManager()

	// 创建源仓库
	srcPath := filepath.Join(t.TempDir(), "src-repo")
	os.MkdirAll(filepath.Join(srcPath, ".git"), 0o755)
	os.WriteFile(filepath.Join(srcPath, "README.md"), []byte("hello"), 0o644)

	// 迁移到新 workspace
	newWs := t.TempDir()
	// 沙箱校验：newWs 必须在 workspaceDir 之下（这里 workspaceDir = newWs 本身）
	newPath, err := wm.MigrateRepo(srcPath, newWs, "org", "repo", newWs)
	if err != nil {
		t.Fatalf("MigrateRepo failed: %v", err)
	}

	// 验证文件复制
	data, err := os.ReadFile(filepath.Join(newPath, "README.md"))
	if err != nil {
		t.Fatalf("README.md not copied: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("README.md content = %q, want 'hello'", string(data))
	}

	// 验证 .git 目录复制
	if !RepoExists(newPath) {
		t.Error("migrated repo should have .git")
	}

	// 幂等：再次迁移不报错
	_, err = wm.MigrateRepo(srcPath, newWs, "org", "repo", newWs)
	if err != nil {
		t.Errorf("idempotent migrate should not fail: %v", err)
	}
}

func TestWorkspaceManager_MigrateRepo_Sandbox(t *testing.T) {
	wm := NewWorkspaceManager()

	srcPath := filepath.Join(t.TempDir(), "src-repo")
	os.MkdirAll(filepath.Join(srcPath, ".git"), 0o755)
	os.WriteFile(filepath.Join(srcPath, "README.md"), []byte("hello"), 0o644)

	allowedRoot := t.TempDir()

	cases := []struct {
		name        string
		newWs       string
		expectError bool
	}{
		{
			name:        "newWs 恰好等于 allowedRoot（合法）",
			newWs:       allowedRoot,
			expectError: false,
		},
		{
			name:        "newWs 是 allowedRoot 的子目录（合法）",
			newWs:       filepath.Join(allowedRoot, "sub"),
			expectError: false,
		},
		{
			name:        "newWs 是 allowedRoot 的同级（拒绝）",
			newWs:       t.TempDir(),
			expectError: true,
		},
		{
			name:        "newWs 是 /etc（绝对路径，强制拒绝）",
			newWs:       "/etc",
			expectError: true,
		},
		{
			name:        "newWs 包含 .. 试图逃逸（拒绝）",
			newWs:       filepath.Join(allowedRoot, "..", "escape"),
			expectError: true,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 用占位 srcPath + 不同 owner 避免影响其它子测试
			_, err := wm.MigrateRepo(srcPath, c.newWs, "sandbox-test-owner", "sandbox-test-repo", allowedRoot)
			if c.expectError && err == nil {
				t.Errorf("expected error for newWs=%q under allowedRoot=%q, got nil",
					c.newWs, allowedRoot)
			}
			if !c.expectError && err != nil {
				t.Errorf("unexpected error for newWs=%q: %v", c.newWs, err)
			}
		})
	}
}
