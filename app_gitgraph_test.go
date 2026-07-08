package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	gitpkg "gitea-kanban/app/git"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
)

// TestApp_FindProjectAndAccount 验证 v2.4 内部 helper
func TestApp_FindProjectAndAccount(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 1. 没 project → NotFound
	_, _, err := app.findProjectAndAccount("nonexistent")
	if err == nil {
		t.Error("expected error for missing project")
	}

	// 2. 有 project 但 account 被删 → NotFound
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Projects = append(s.Projects, store.RepoProject{
			ID: "proj-1", Platform: "gitea", AccountID: "acc-deleted",
			Owner: "org", Name: "demo",
		})
	})
	_, _, err = app.findProjectAndAccount("proj-1")
	if err == nil {
		t.Error("expected error for missing account")
	}

	// 3. 正常：把 project 关联到 acc-1
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID: "acc-1", Platform: "gitea",
			GiteaURL: "https://gitea.example.com", Username: "alice",
		})
		// 同时更新 project 的 AccountID → acc-1（之前是 acc-deleted）
		for i := range s.Projects {
			if s.Projects[i].ID == "proj-1" {
				s.Projects[i].AccountID = "acc-1"
			}
		}
	})
	project, account, err := app.findProjectAndAccount("proj-1")
	if err != nil {
		t.Fatalf("findProjectAndAccount failed: %v", err)
	}
	if project.Owner != "org" || project.Name != "demo" {
		t.Errorf("project owner/name = %s/%s, want org/demo", project.Owner, project.Name)
	}
	if account.Username != "alice" {
		t.Errorf("account username = %s, want alice", account.Username)
	}
}

// TestApp_PullRepoByProjectId 验证 v2.4 按 projectId 反查 localPath + token 的链路
//
// 修复 StatusBar 更新按钮的 localPath 拼接 bug：
//   - 旧版前端拼 `~/.gitea-kanban/workspace/repos/...` → Go 端 resolveTokenByLocalPath 拒绝
//   - 新版只传 projectId，Go 端按 owner+repo + workspacePath 反算
func TestApp_PullRepoByProjectId(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 准备 account + project + keychain
	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID: accountID, Platform: "gitea",
			GiteaURL: "https://gitea.example.com", Username: "alice",
		})
		s.Projects = append(s.Projects, store.RepoProject{
			ID: "proj-1", Platform: "gitea", AccountID: accountID,
			Owner: "org", Name: "demo",
		})
	})
	_ = app.secretStore.Set(secret.Credential{
		Platform: "gitea", HostURL: "https://gitea.example.com",
		Username: "alice", Token: "fake-token",
	})

	// 创建 fake 仓库（含 .git）让 RepoExists=true
	workspace := filepath.Join(tmp, "workspace")
	repoDir := filepath.Join(workspace, "repos", "org__demo")
	if err := os.MkdirAll(filepath.Join(repoDir, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir fake repo: %v", err)
	}

	// PullRepoByProjectId 应该反查 localPath（无需前端传）然后失败在
	// "fetch from https://gitea.example.com"（因为 mock URL 不响应）——
	// 关键不是 fetch 成功，是**反查 localPath + 找 token 这一步不报 "路径不在 workspace 下" 错误**
	_, err := app.PullRepoByProjectId(PullRepoByProjectIdArgs{ProjectID: "proj-1"})
	if err == nil {
		t.Fatal("PullRepoByProjectId should fail (no real gitea server)")
	}
	// 关键断言：错误**不是** "localPath 不在 workspace 下"（v2.3 之前的错误）
	if strings.Contains(err.Error(), "localPath 不在 workspace 下") {
		t.Errorf("v2.4 should NOT fail with 'localPath 不在 workspace 下' (path resolution fix), got: %v", err)
	}
	// 也不应该是 token 为空 / account 不存在（keychain 已设）
	if strings.Contains(err.Error(), "token 为空") {
		t.Errorf("v2.4 should not fail with empty token, got: %v", err)
	}
	if strings.Contains(err.Error(), "未找到 project") {
		t.Errorf("v2.4 should find the project, got: %v", err)
	}
}

// TestApp_GetGitGraph 验证 v2.4 GetGitGraph 端到端（反查 localPath + token + 调 adapter）
func TestApp_GetGitGraph(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID: accountID, Platform: "gitea",
			GiteaURL: "https://gitea.example.com", Username: "alice",
		})
		s.Projects = append(s.Projects, store.RepoProject{
			ID: "proj-1", Platform: "gitea", AccountID: accountID,
			Owner: "org", Name: "demo",
		})
	})
	_ = app.secretStore.Set(secret.Credential{
		Platform: "gitea", HostURL: "https://gitea.example.com",
		Username: "alice", Token: "fake-token",
	})

	// 1. 空 projectId → ValidationFailed
	_, err := app.GetGitGraph(GetGitGraphArgs{ProjectID: ""})
	if err == nil {
		t.Error("GetGitGraph with empty projectId should fail")
	}

	// 2. 找不到 project → NotFound
	_, err = app.GetGitGraph(GetGitGraphArgs{ProjectID: "nonexistent"})
	if err == nil {
		t.Error("GetGitGraph with nonexistent projectId should fail")
	}

	// 3. 正常路径：会调 adapter.LogGraph（fake localPath → 打开仓库失败）
	//    关键不是 graph 渲染成功，是反查路径/token 通了
	_, err = app.GetGitGraph(GetGitGraphArgs{ProjectID: "proj-1"})
	if err == nil {
		t.Error("GetGitGraph with fake localPath should fail (no real clone)")
	}
	// 关键断言：不是 "未找到 project" / "localPath" / "token 为空" —— 这些都通过
	if strings.Contains(err.Error(), "未找到 project") {
		t.Errorf("v2.4 should find the project, got: %v", err)
	}
	if strings.Contains(err.Error(), "token 为空") {
		t.Errorf("v2.4 should not fail with empty token, got: %v", err)
	}
}

// TestApp_GetRepoById 验证 v2.4 GetRepoById 端到端
//
// 修复 "选择已经同步的仓库，看板、Git Graph 等功能还是不能使用"：
//   - 前端 StatusBar 选完仓库后，调 GetRepoById 拿 { localPath, cloned, account } → 渲染
//   - 之前前端要自己拼 localPath（拼错），现在 Go 端算
func TestApp_GetRepoById(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 准备 account + project
	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID: accountID, Platform: "gitea",
			GiteaURL: "https://gitea.example.com", Username: "alice",
		})
		s.Projects = append(s.Projects, store.RepoProject{
			ID: "proj-1", Platform: "gitea", AccountID: accountID,
			Owner: "org", Name: "demo",
		})
	})
	_ = app.secretStore.Set(secret.Credential{
		Platform: "gitea",
		HostURL:  "https://gitea.example.com",
		Username: "alice",
		Token:    "fake-token",
	})

	// 1. 没 clone → cloned=false
	r, err := app.GetRepoById(GetRepoByIdArgs{ProjectID: "proj-1"})
	if err != nil {
		t.Fatalf("GetRepoById failed: %v", err)
	}
	if r.Cloned {
		t.Error("expected Cloned=false before clone")
	}
	// v2.5：按账号分层（alice 是 account username）
	wantPath := filepath.Join(tmp, "workspace", "repos", "alice", "org__demo")
	if r.LocalPath != wantPath {
		t.Errorf("LocalPath = %q, want %q", r.LocalPath, wantPath)
	}
	if r.Project.ID != "proj-1" {
		t.Errorf("Project.ID = %q, want proj-1", r.Project.ID)
	}
	if r.Account.ID != accountID {
		t.Errorf("Account.ID = %q, want %q", r.Account.ID, accountID)
	}

	// 2. 模拟 clone（建 .git 目录）→ cloned=true
	if err := os.MkdirAll(filepath.Join(wantPath, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	r2, err := app.GetRepoById(GetRepoByIdArgs{ProjectID: "proj-1"})
	if err != nil {
		t.Fatalf("GetRepoById (after clone) failed: %v", err)
	}
	if !r2.Cloned {
		t.Error("expected Cloned=true after mkdir .git")
	}

	// 3. 未知 projectId → ValidationFailed
	_, err = app.GetRepoById(GetRepoByIdArgs{ProjectID: ""})
	if err == nil {
		t.Error("GetRepoById with empty projectId should fail")
	}
}

// TestResolveLocalHead 验证 app/git.ResolveLocalHead 直接行为
func TestResolveLocalHead(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "r")
	mustMkdirLocal(t, repo)
	runGitLocal(t, repo, "init")
	runGitLocal(t, repo, "config", "user.email", "t@t")
	runGitLocal(t, repo, "config", "user.name", "T")
	mustWriteLocal(t, filepath.Join(repo, "f"), []byte("x"))
	runGitLocal(t, repo, "add", ".")
	envCommitLocal(t, repo, "first", "2026-01-01T10:00:00Z")

	headCmd := exec.Command("git", "-C", repo, "rev-parse", "HEAD")
	headOut, _ := headCmd.Output()
	want := strings.TrimSpace(string(headOut))

	got := gitpkg.ResolveLocalHead(repo)
	if got != want {
		t.Errorf("ResolveLocalHead = %q, want %q", got, want)
	}
	// 坏路径返回空字符串 (不报错)
	if got := gitpkg.ResolveLocalHead("/nonexistent/path"); got != "" {
		t.Errorf("bad path 应返回空,实际 %q", got)
	}
}

// helpers
func mustMkdirLocal(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
}
func mustWriteLocal(t *testing.T, p string, d []byte) {
	t.Helper()
	if err := os.WriteFile(p, d, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}
func runGitLocal(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
func envCommitLocal(t *testing.T, dir, msg, date string) {
	t.Helper()
	cmd := exec.Command("git", "commit", "-m", msg)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_DATE="+date,
		"GIT_COMMITTER_DATE="+date,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}
func nodeSHAs(nodes []GraphNodeDTO) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.SHA[:7])
	}
	return out
}
