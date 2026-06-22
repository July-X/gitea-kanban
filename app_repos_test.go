package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gitea-kanban/app/ipc"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
)

// mockGiteaReposServer 模拟 gitea /repos/search 端点
//
// 返回一个含两个仓库的列表：org/repo-a（私有，有权限）、org/repo-b（公开）
func mockGiteaReposServer(t *testing.T) (hostURL string, cleanup func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/search", func(w http.ResponseWriter, r *http.Request) {
		// 验证 token
		if auth := r.Header.Get("Authorization"); !strings.HasPrefix(auth, "token ") {
			t.Errorf("missing/wrong Authorization header: %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [
				{
					"id": 100,
					"name": "repo-a",
					"full_name": "org/repo-a",
					"owner": {"login": "org"},
					"default_branch": "main",
					"description": "Test repo A",
					"private": true,
					"archived": false,
					"updated_at": "2024-01-15T10:00:00Z",
					"permissions": {"pull": true, "push": true, "admin": false}
				},
				{
					"id": 200,
					"name": "repo-b",
					"full_name": "org/repo-b",
					"owner": {"login": "org"},
					"default_branch": "main",
					"description": "Test repo B (public)",
					"private": false,
					"archived": false,
					"updated_at": "2024-02-20T14:00:00Z",
					"permissions": {"pull": true, "push": false, "admin": false}
				}
			],
			"ok": true
		}`))
	})
	server := httptest.NewServer(mux)
	return server.URL, server.Close
}

// TestApp_ListRepos_BasicFlow 验证 StatusBar 刷新按钮的完整链路
func TestApp_ListRepos_BasicFlow(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	hostURL, cleanup := mockGiteaReposServer(t)
	defer cleanup()

	// 准备 account + token
	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID:       accountID,
			Platform: "gitea",
			GiteaURL: hostURL,
			Username: "alice",
		})
	})
	if err := app.secretStore.Set(secret.Credential{
		Platform: "gitea",
		HostURL:  hostURL,
		Username: "alice",
		Token:    "test-token",
	}); err != nil {
		t.Fatalf("set secret: %v", err)
	}

	// 调 ListRepos
	resp, err := app.ListRepos(ListReposArgs{
		GiteaAccountID: accountID,
		Limit:          50,
		Page:           1,
	})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("expected 2 repos, got %d", len(resp.Items))
	}

	// 验证字段
	r0 := resp.Items[0]
	if r0.Owner != "org" || r0.Name != "repo-a" {
		t.Errorf("repo-a mismatch: owner=%q name=%q", r0.Owner, r0.Name)
	}
	if r0.ID != 100 {
		t.Errorf("repo-a.ID = %d, want 100", r0.ID)
	}
	if !r0.Private {
		t.Error("repo-a should be private")
	}
	if r0.UpdatedAt == "" {
		t.Error("repo-a.UpdatedAt should not be empty")
	}
	if r0.Permissions == nil || !r0.Permissions.Pull || !r0.Permissions.Push {
		t.Errorf("repo-a permissions mismatch: %+v", r0.Permissions)
	}
	if r0.Description != "Test repo A" {
		t.Errorf("repo-a.Description = %q, want %q", r0.Description, "Test repo A")
	}

	// 默认 isProject = false（没加 project）
	if r0.IsProject {
		t.Error("repo-a should not be isProject initially")
	}
}

// TestApp_ListRepos_MergesIsProject 验证 ListRepos 把 localStore.Projects merge 进 isProject
func TestApp_ListRepos_MergesIsProject(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	hostURL, cleanup := mockGiteaReposServer(t)
	defer cleanup()

	// 准备 account + token
	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID:       accountID,
			Platform: "gitea",
			GiteaURL: hostURL,
			Username: "alice",
		})
		// 预先把 repo-a 加为 project
		s.Projects = append(s.Projects, store.RepoProject{
			ID:         "proj-a",
			Platform:   "gitea",
			AccountID:  accountID,
			Owner:      "org",
			Name:       "repo-a",
			LastSyncAt: 1719000000000, // 2024-06-21
			CreatedAt:  1719000000000,
		})
	})
	_ = app.secretStore.Set(secret.Credential{
		Platform: "gitea", HostURL: hostURL, Username: "alice", Token: "test-token",
	})

	resp, err := app.ListRepos(ListReposArgs{
		GiteaAccountID: accountID,
		Limit:          50, Page: 1,
	})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}

	if !resp.Items[0].IsProject {
		t.Error("repo-a should be isProject=true (matched in localStore.Projects)")
	}
	if resp.Items[0].LastSyncAt == "" {
		t.Error("repo-a.LastSyncAt should be set")
	}
	// repo-b 没在 Projects → isProject=false
	if resp.Items[1].IsProject {
		t.Error("repo-b should be isProject=false (not in localStore.Projects)")
	}
}

// TestApp_ListRepos_AccountNotFound 验证未知账号 → NotFound
func TestApp_ListRepos_AccountNotFound(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	_, err := app.ListRepos(ListReposArgs{GiteaAccountID: "nonexistent"})
	if err == nil {
		t.Fatal("ListRepos should fail for nonexistent account")
	}
	// error.Message = "找不到该资源"（NewNotFound 默认），Cause 含 "未找到账号"
	ipcErr, ok := err.(*ipc.IpcError)
	if !ok {
		t.Fatalf("expected *IpcError, got %T", err)
	}
	if ipcErr.Code != ipc.CodeNotFound {
		t.Errorf("expected code=%s, got %s", ipc.CodeNotFound, ipcErr.Code)
	}
	if !strings.Contains(ipcErr.Cause, "未找到账号") {
		t.Errorf("expected Cause contain '未找到账号', got %q", ipcErr.Cause)
	}
}

// TestApp_AddProject_Idempotent 验证 AddProject 幂等
func TestApp_AddProject_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID:       accountID,
			Platform: "gitea",
			GiteaURL: "https://gitea.example.com",
			Username: "alice",
		})
	})

	// 第一次加
	r1, err := app.AddProject(AddProjectArgs{
		GiteaAccountID: accountID, Owner: "org", Name: "demo",
	})
	if err != nil {
		t.Fatalf("first AddProject failed: %v", err)
	}

	// 第二次加同一个 → 应返相同 ID
	r2, err := app.AddProject(AddProjectArgs{
		GiteaAccountID: accountID, Owner: "org", Name: "demo",
	})
	if err != nil {
		t.Fatalf("second AddProject failed: %v", err)
	}
	if r1.Project.ID != r2.Project.ID {
		t.Errorf("idempotent AddProject should return same ID: %s vs %s", r1.Project.ID, r2.Project.ID)
	}
}

// TestApp_RemoveProject 验证 RemoveProject 删掉指定 project
func TestApp_RemoveProject(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("GITEA_KANBAN_DATA_DIR", tmp)
	t.Setenv("GITEA_KANBAN_DEV_KEYCHAIN", "1")

	app := NewApp()
	app.OnStartup(context.Background())
	defer app.OnShutdown(context.Background())

	// 加一个 project
	accountID := "acc-1"
	_ = app.localStore.Mutate(func(s *store.LocalState) {
		s.Accounts = append(s.Accounts, store.GiteaAccount{
			ID: accountID, Platform: "gitea",
			GiteaURL: "https://gitea.example.com", Username: "alice",
		})
	})
	r, err := app.AddProject(AddProjectArgs{
		GiteaAccountID: accountID, Owner: "org", Name: "demo",
	})
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	// 删
	if err := app.RemoveProject(RemoveProjectArgs{ProjectID: r.Project.ID}); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}

	// 验证 state
	state := app.localStore.Get()
	for _, p := range state.Projects {
		if p.ID == r.Project.ID {
			t.Error("project should be removed")
		}
	}

	// 删不存在的 ID → 不报错（幂等）
	if err := app.RemoveProject(RemoveProjectArgs{ProjectID: "nonexistent"}); err != nil {
		t.Errorf("RemoveProject for nonexistent ID should be no-op, got: %v", err)
	}
}

// 仅为保证 json import 被使用（mockGiteaReposServer 用 raw string 写 JSON，
// 真实 Go 端不需要 unmarshal，但要 import 避免编译错误）
var _ = json.Marshal