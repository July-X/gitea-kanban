package gitea

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	appgit "gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
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

// TestGraphResultToDTO_PropagatesIsCommitted 验证 graphResultToDTO 把
// graph.GraphNode.IsCommitted / graph.GraphBranchLine.IsCommitted 透传到
// platform.GraphNodeDTO / platform.GraphBranchLineDTO。这是 v3.x UNCOMMITTED
// 灰色虚线 lane 能正确渲染的前提：App 端 GetGitGraph → graphResultToAppDTO →
// 前端 node.isCommitted / line.isCommitted 都要拿到正确值。
func TestGraphResultToDTO_PropagatesIsCommitted(t *testing.T) {
	dto := graphResultToDTO(&graph.GraphResult{
		Nodes: []graph.GraphNode{
			{
				Row:         0,
				Lane:        0,
				Color:       1,
				SHA:         appgit.UNCOMMITTED_HASH,
				ShortSHA:    appgit.UNCOMMITTED_HASH,
				IsCommitted: false,
			},
			{
				Row:         1,
				Lane:        0,
				Color:       1,
				SHA:         "deadbeef",
				ShortSHA:    "deadbee",
				IsCommitted: true,
			},
		},
		Branches: []graph.GraphBranch{{
			Color: 1,
			End:   2,
			Lines: []graph.GraphBranchLine{
				{
					X1: 0, Y1: 0, X2: 0, Y2: 1,
					IsCommitted: false, // UNCOMMITTED → HEAD 段
				},
				{
					X1: 0, Y1: 1, X2: 0, Y2: 2,
					IsCommitted: true, // HEAD → parent 段
				},
			},
		}},
		MaxLane: 0,
	})

	if len(dto.Nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(dto.Nodes))
	}
	if dto.Nodes[0].IsCommitted {
		t.Errorf("UNCOMMITTED 节点 IsCommitted 应该透传为 false，实际 true")
	}
	if !dto.Nodes[1].IsCommitted {
		t.Errorf("HEAD 节点 IsCommitted 应该透传为 true，实际 false")
	}
	if len(dto.Branches) != 1 || len(dto.Branches[0].Lines) != 2 {
		t.Fatalf("expected 1 branch with 2 lines, got %#v", dto.Branches)
	}
	if dto.Branches[0].Lines[0].IsCommitted {
		t.Errorf("UNCOMMITTED→HEAD 边 IsCommitted 应该透传为 false，实际 true")
	}
	if !dto.Branches[0].Lines[1].IsCommitted {
		t.Errorf("HEAD→parent 边 IsCommitted 应该透传为 true，实际 false")
	}
}
