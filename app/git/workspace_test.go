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

	// v2.5 新布局：repos/<accountUsername>/<owner>__<repo>
	// 建两个账号各放一个仓库
	reposByAccount := map[string][]string{
		"alice": {"org1__repo1"},
		"bob":   {"org2__repo2"},
	}
	for account, repos := range reposByAccount {
		for _, name := range repos {
			repoPath := filepath.Join(reposDir, account, name)
			os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755)
		}
	}
	// 创建一个非 git 目录（应被忽略）
	os.MkdirAll(filepath.Join(reposDir, "alice", "not-a-repo"), 0o755)

	repos, err := wm.ListRepos(wsPath)
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("expected 2 repos, got %d", len(repos))
	}

	// 验证排序（按 AccountUsername + Name）
	if repos[0].AccountUsername != "alice" || repos[0].Name != "org1__repo1" {
		t.Errorf("first repo = account=%q name=%q, want alice/org1__repo1",
			repos[0].AccountUsername, repos[0].Name)
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

// ===== v2.5 · MigrateLegacyWorkspaceLayout 测试 =====

// fakeRepo 在给定路径创建一个 fake git 仓库（含 .git 目录）
func fakeRepo(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(path, ".git"), 0o755); err != nil {
		t.Fatalf("fakeRepo mkdir %s: %v", path, err)
	}
}

// TestMigrateLegacy_NoLegacy 验证没有旧布局时（全新启动）不触发迁移
func TestMigrateLegacy_NoLegacy(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()
	// 直接建新布局（repos/alice/org__demo）
	fakeRepo(t, filepath.Join(wsPath, "repos", "alice", "org__demo"))

	resolver := func(platform, owner, repo string) (string, bool) {
		return "alice", true
	}
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result.MigratedCount != 0 {
		t.Errorf("expected 0 migrated (no legacy dirs), got %d", result.MigratedCount)
	}
	if result.FailedCount != 0 {
		t.Errorf("expected 0 failed, got %d", result.FailedCount)
	}
	if result.RenamedTo != "" {
		t.Errorf("expected no rename, got %q", result.RenamedTo)
	}
}

// TestMigrateLegacy_HappyPath 验证标准旧 → 新迁移（单账号、多仓库）
func TestMigrateLegacy_HappyPath(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	// 旧布局：repos/<owner>__<repo>
	fakeRepo(t, filepath.Join(wsPath, "repos", "org__repo1"))
	fakeRepo(t, filepath.Join(wsPath, "repos", "myorg__repo2"))

	// resolver：org → alice，myorg → alice（一个用户管多个仓库）
	resolver := func(platform, owner, repo string) (string, bool) {
		switch owner {
		case "org", "myorg":
			return "alice", true
		}
		return "", false
	}

	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result.MigratedCount != 2 {
		t.Errorf("expected 2 migrated, got %d (result=%+v)", result.MigratedCount, result)
	}
	if result.FailedCount != 0 {
		t.Errorf("expected 0 failed, got %d", result.FailedCount)
	}
	if result.RenamedTo == "" {
		t.Error("expected RenamedTo to be set on success")
	}
	if result.BackupKept {
		t.Error("expected BackupKept=false on success")
	}

	// 验证新布局
	if !RepoExists(filepath.Join(wsPath, "repos", "alice", "org__repo1")) {
		t.Error("expected repos/alice/org__repo1 to exist after migration")
	}
	if !RepoExists(filepath.Join(wsPath, "repos", "alice", "myorg__repo2")) {
		t.Error("expected repos/alice/myorg__repo2 to exist after migration")
	}

	// 验证新 repos 目录包含 alice 子目录（不再是空的——旧模式会清空，新模式 staging 切换）
	entries, _ := os.ReadDir(filepath.Join(wsPath, "repos"))
	if len(entries) != 1 || entries[0].Name() != "alice" {
		t.Errorf("expected new repos dir to contain only 'alice', got %v", entries)
	}

	// 验证 staging 临时目录已被清理（成功路径：staging mv 走了）
	if _, err := os.Stat(filepath.Join(wsPath, "_v25_migration_staging")); err == nil {
		t.Error("staging directory should be cleaned up after successful migration")
	}

	// 验证备份目录存在
	if _, err := os.Stat(result.RenamedTo); err != nil {
		t.Errorf("backup dir not found: %v", err)
	}
}

// TestMigrateLegacy_MultiAccount 验证多账号场景：每个仓库迁到对应的 username 子目录
func TestMigrateLegacy_MultiAccount(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	// 旧布局下两个仓库，按 resolver 分别归 alice / bob
	fakeRepo(t, filepath.Join(wsPath, "repos", "shared__alice-repo"))
	fakeRepo(t, filepath.Join(wsPath, "repos", "shared__bob-repo"))

	resolver := func(platform, owner, repo string) (string, bool) {
		if repo == "alice-repo" {
			return "alice", true
		}
		if repo == "bob-repo" {
			return "bob", true
		}
		return "", false
	}

	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result.MigratedCount != 2 {
		t.Errorf("expected 2 migrated, got %d", result.MigratedCount)
	}

	if !RepoExists(filepath.Join(wsPath, "repos", "alice", "shared__alice-repo")) {
		t.Error("expected repos/alice/shared__alice-repo")
	}
	if !RepoExists(filepath.Join(wsPath, "repos", "bob", "shared__bob-repo")) {
		t.Error("expected repos/bob/shared__bob-repo")
	}
}

// TestMigrateLegacy_UnknownAccount 验证 resolver 找不到的仓库 → _unknown 目录
func TestMigrateLegacy_UnknownAccount(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	fakeRepo(t, filepath.Join(wsPath, "repos", "org__orphan"))

	// resolver 永远返 false
	resolver := func(platform, owner, repo string) (string, bool) {
		return "", false
	}

	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result.MigratedCount != 1 {
		t.Errorf("expected 1 migrated (to _unknown), got %d", result.MigratedCount)
	}
	// 仓库迁到 _unknown 子目录
	if !RepoExists(filepath.Join(wsPath, "repos", "_unknown", "org__orphan")) {
		t.Error("expected repos/_unknown/org__orphan")
	}
}

// TestMigrateLegacy_NonRepoSkipped 验证非 git 仓库的同名目录被跳过（不进入 staging）
//
// 关键：
//   - migration 扫到 fake__dir → RepoExists=false → 跳过（不进 legacyRepos 列表）
//   - 但 happy path 仍会把整个 reposDir mv 成 _pre_v25_workspace，
//     所以 fake__dir 也跟着备份走了
//   - 验证：fake__dir 不在新 repos 下（说明它没被当成仓库迁移过）
//   - 验证：fake__dir 在备份目录下（说明它被备份了，没被误删）
func TestMigrateLegacy_NonRepoSkipped(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	// 创建一个含 __ 但不是 git 仓库的目录
	if err := os.MkdirAll(filepath.Join(wsPath, "repos", "fake__dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 再建一个真仓库
	fakeRepo(t, filepath.Join(wsPath, "repos", "real__repo"))

	resolver := func(platform, owner, repo string) (string, bool) {
		return "alice", true
	}
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result.MigratedCount != 1 {
		t.Errorf("expected 1 migrated (real__repo), got %d", result.MigratedCount)
	}
	// 真仓库正确迁移
	if !RepoExists(filepath.Join(wsPath, "repos", "alice", "real__repo")) {
		t.Error("expected repos/alice/real__repo")
	}
	// fake__dir 不在新 repos 下（说明它没被迁移器错误地当成仓库）
	if _, err := os.Stat(filepath.Join(wsPath, "repos", "fake__dir")); err == nil {
		t.Error("non-repo fake__dir should NOT be migrated to new layout")
	}
	// 但 fake__dir 在备份目录里（happy path 把整个 reposDir mv 走，非仓库也跟着备份）
	if _, err := os.Stat(filepath.Join(result.RenamedTo, "fake__dir")); err != nil {
		t.Errorf("fake__dir should be in backup dir, got err: %v", err)
	}
}

// TestMigrateLegacy_TargetExistsIsFailure 验证迁移失败时走整体回退分支
//
// 构造方式：预创建 staging 目标（用户手动放了一个同名仓库在 staging），
// resolver 把它分到 alice → mv 时撞到 alice/org__dup → 失败
func TestMigrateLegacy_TargetExistsIsFailure(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	// 旧仓库
	fakeRepo(t, filepath.Join(wsPath, "repos", "org__dup"))

	// staging 里预先放一个干扰（模拟上次迁移半成品 / 用户手动操作）
	fakeRepo(t, filepath.Join(wsPath, "_v25_migration_staging", "alice", "org__dup"))

	resolver := func(platform, owner, repo string) (string, bool) {
		return "alice", true
	}
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("migration returned err: %v", err)
	}
	if result.FailedCount != 1 {
		t.Errorf("expected 1 failed (target exists in staging), got %d", result.FailedCount)
	}
	if !result.BackupKept {
		t.Error("expected BackupKept=true on failure")
	}
	if result.RenamedTo == "" {
		t.Error("expected RenamedTo set to _pre_v25_workspace")
	}
}

// TestMigrateLegacy_BackupNameUnique 验证备份目录名冲突时自动加 .1/.2 后缀
//
// 构造方式：复用 TestMigrateLegacy_TargetExistsIsFailure 的 staging 冲突手法，
// 触发失败路径；预创建 _pre_v25_workspace / .1 让 uniqueBackupPath 返回 .2
func TestMigrateLegacy_BackupNameUnique(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()

	// 预创建 _pre_v25_workspace 和 _pre_v25_workspace.1，触发 .2 后缀
	if err := os.MkdirAll(filepath.Join(wsPath, "_pre_v25_workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(wsPath, "_pre_v25_workspace.1"), 0o755); err != nil {
		t.Fatal(err)
	}

	fakeRepo(t, filepath.Join(wsPath, "repos", "org__dup"))
	fakeRepo(t, filepath.Join(wsPath, "_v25_migration_staging", "alice", "org__dup"))

	resolver := func(platform, owner, repo string) (string, bool) {
		return "alice", true
	}
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, resolver)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !result.BackupKept {
		t.Fatal("expected backup to be kept on failure")
	}
	expected := filepath.Join(wsPath, "_pre_v25_workspace.2")
	if result.RenamedTo != expected {
		t.Errorf("RenamedTo = %q, want %q (auto-suffixed)", result.RenamedTo, expected)
	}
}

// TestMigrateLegacy_EmptyRepos 验证空 repos 目录不触发迁移
func TestMigrateLegacy_EmptyRepos(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()
	if err := os.MkdirAll(filepath.Join(wsPath, "repos"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if result.MigratedCount != 0 || result.FailedCount != 0 {
		t.Errorf("expected no-op, got %+v", result)
	}
}

// TestMigrateLegacy_NoReposDir 验证 repos 目录不存在 = 全新启动
func TestMigrateLegacy_NoReposDir(t *testing.T) {
	wm := NewWorkspaceManager()
	wsPath := t.TempDir()
	// 完全不创建 repos 子目录
	result, err := wm.MigrateLegacyWorkspaceLayout(wsPath, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if result.MigratedCount != 0 || result.FailedCount != 0 {
		t.Errorf("expected no-op, got %+v", result)
	}
}

