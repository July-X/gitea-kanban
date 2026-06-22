package gitea

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gitea-kanban/app/platform"
)

func TestGiteaAdapter_VerifyToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 验证请求路径
		if r.URL.Path != "/api/v1/user" {
			t.Errorf("path = %q, want /api/v1/user", r.URL.Path)
		}
		// 验证鉴权头
		if auth := r.Header.Get("Authorization"); auth != "token test-token" {
			t.Errorf("Authorization = %q, want 'token test-token'", auth)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         123,
			"login":      "alice",
			"full_name":  "Alice",
			"email":      "alice@example.com",
			"avatar_url": "https://example.com/avatar.png",
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	user, err := adapter.VerifyToken(context.Background(), server.URL, "test-token")
	if err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}

	if user.ID != 123 {
		t.Errorf("ID = %d, want 123", user.ID)
	}
	if user.Login != "alice" {
		t.Errorf("Login = %q, want alice", user.Login)
	}
	if user.FullName != "Alice" {
		t.Errorf("FullName = %q, want Alice", user.FullName)
	}
}

func TestGiteaAdapter_VerifyToken_InvalidToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"message": "token invalid"})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	_, err := adapter.VerifyToken(context.Background(), server.URL, "bad-token")
	if err == nil {
		t.Fatal("expected error for invalid token")
	}
}

func TestGiteaAdapter_ListRepos(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/search" {
			t.Errorf("path = %q, want /api/v1/repos/search", r.URL.Path)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"data": []map[string]interface{}{
				{
					"name":           "myrepo",
					"full_name":      "myorg/myrepo",
					"default_branch": "main",
					"description":    "test repo",
					"private":        false,
					"owner": map[string]interface{}{
						"login": "myorg",
					},
				},
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	repos, err := adapter.ListRepos(context.Background(), server.URL, "alice", "token", platform.ListReposOpts{})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}

	if len(repos) != 1 {
		t.Fatalf("expected 1 repo, got %d", len(repos))
	}
	if repos[0].Name != "myrepo" {
		t.Errorf("Name = %q, want myrepo", repos[0].Name)
	}
	if repos[0].Owner != "myorg" {
		t.Errorf("Owner = %q, want myorg", repos[0].Owner)
	}
	if repos[0].DefaultBranch != "main" {
		t.Errorf("DefaultBranch = %q, want main", repos[0].DefaultBranch)
	}
}

func TestGiteaAdapter_ListBranches(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/myorg/myrepo/branches" {
			t.Errorf("path = %q, want /api/v1/repos/myorg/myrepo/branches", r.URL.Path)
		}

		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"name": "main",
				"commit": map[string]interface{}{
					"id": "abc123def456",
				},
				"protected": true,
			},
			{
				"name": "feature",
				"commit": map[string]interface{}{
					"id": "def789abc012",
				},
				"protected": false,
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	branches, err := adapter.ListBranches(context.Background(), server.URL, "alice", "token", "myorg", "myrepo")
	if err != nil {
		t.Fatalf("ListBranches failed: %v", err)
	}

	if len(branches) != 2 {
		t.Fatalf("expected 2 branches, got %d", len(branches))
	}
	if branches[0].Name != "main" {
		t.Errorf("first branch = %q, want main", branches[0].Name)
	}
	if !branches[0].IsProtected {
		t.Error("main should be protected")
	}
	if branches[1].IsProtected {
		t.Error("feature should not be protected")
	}
}

func TestGiteaAdapter_Platform(t *testing.T) {
	adapter := NewGiteaAdapter()
	if adapter.Platform() != "gitea" {
		t.Errorf("Platform = %q, want gitea", adapter.Platform())
	}
}

func TestMapHTTPError(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{401, "登录已过期"},
		{403, "权限"},
		{404, "找不到"},
		{429, "频繁"},
		{503, "离线"},
	}
	for _, c := range cases {
		err := mapHTTPError(c.status, "body", "/test")
		if err == nil {
			t.Errorf("expected error for status %d", c.status)
			continue
		}
	}
}

