package gitea

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	appgit "gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
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

// ===== PR 评论测试（v0.6+）=====
//
// 覆盖：ListPullComments / CreatePullComments / 空 body short-circuit / 请求参数
//
// 设计原则：复用现有的 httptest mock server 模式。

// TestGiteaAdapter_ListPullComments 验证路径 + 字段映射
func TestGiteaAdapter_ListPullComments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/dolphin/issues/42/comments" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		auth := r.Header.Get("Authorization")
		if auth != "token test-token" {
			t.Errorf("Authorization = %q, want 'token test-token'", auth)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":      100,
				"body":    "looks good to me!",
				"user":    map[string]string{"login": "bob", "avatar_url": "https://gitea/bob.png"},
				"created": "2024-06-01T10:00:00Z",
				"updated": "2024-06-01T10:00:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullComments(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullComments failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].ID != 100 {
		t.Errorf("ID = %d, want 100", items[0].ID)
	}
	if items[0].Body != "looks good to me!" {
		t.Errorf("Body = %q", items[0].Body)
	}
	if items[0].Author == nil || items[0].Author.Username != "bob" {
		t.Errorf("Author = %+v", items[0].Author)
	}
	if items[0].CreatedAt != "2024-06-01T10:00:00Z" {
		t.Errorf("CreatedAt = %q", items[0].CreatedAt)
	}
}

// TestGiteaAdapter_CreatePullComment 验证 POST body + 字段映射
func TestGiteaAdapter_CreatePullComment(t *testing.T) {
	var capturedMethod, capturedPath string
	var capturedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		// v0.6+ bugfix regression：验证 Content-Type 是 application/json
		// （修复前 Go 默认设 application/x-www-form-urlencoded，
		//  Gitea swagger 返 422 "Empty Content-Type"）
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":      200,
			"body":    capturedBody["body"],
			"user":    map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
			"created": "2024-06-02T12:00:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	d, err := adapter.CreatePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42, "approved!")
	if err != nil {
		t.Fatalf("CreatePullComment failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/42/comments" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedBody["body"] != "approved!" {
		t.Errorf("body = %v, want 'approved!'", capturedBody["body"])
	}
	if d.ID != 200 || d.Body != "approved!" {
		t.Errorf("d = %+v", d)
	}
	if d.Author == nil || d.Author.Username != "alice" {
		t.Errorf("d.Author = %+v", d.Author)
	}
}

// TestGiteaAdapter_CreatePullComment_EmptyBody 验证 trim 后空 body short-circuit（不发请求）
func TestGiteaAdapter_CreatePullComment_EmptyBody(t *testing.T) {
	serverHit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	_, err := adapter.CreatePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42, "   ")
	if err == nil {
		t.Fatal("expected validation error for whitespace-only body")
	}
	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("expected *IpcError, got %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeValidationFailed {
		t.Errorf("Code = %q, want %q", ipcErr.Code, ipc.CodeValidationFailed)
	}
	if serverHit {
		t.Error("server should not be hit for empty body (short-circuit)")
	}
}
