package gitea

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

// TestGiteaAdapter_ListPullComments 验证路径 + 字段映射 + 不再过滤 type
//
// v0.7.x 重构：对齐 Gitea web 行为——返回所有 type 的评论（包括 type=21 review body、
// type=22 review event、type=1/2 REOPEN/CLOSE、type=28 MERGE 等）。前端按 type 分类渲染。
//
// 旧 db84089 版本在服务端过滤 type != 0,导致 Gitea web 显示的 review body
// 和评审事件都丢失, 与 Gitea web 行为不一致。回归证据:用户 PR #74 反馈
// "提交请求修改后对话区只有评审事件卡, 没有 review body 内容"——根本原因
// 是 db84089 错误过滤 type=21。
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
				"id":         100,
				"body":       "looks good to me!",
				"user":       map[string]string{"login": "bob", "avatar_url": "https://gitea/bob.png"},
				"created_at": "2024-06-01T10:00:00Z",
				"updated_at": "2024-06-01T10:00:00Z",
				"type":       0, // CommentTypePlain
			},
			{
				"id":         101,
				"body":       "review body content (type=21 评审总结文)",
				"user":       map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
				"created_at": "2024-06-01T11:00:00Z",
				"updated_at": "2024-06-01T11:00:00Z",
				"type":       21, // CommentTypeReview 评审总结文 (v0.7.x 不再过滤, 前端走普通评论卡渲染)
			},
			{
				"id":         102,
				"body":       "reopened this pull request",
				"user":       map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
				"created_at": "2024-06-01T12:00:00Z",
				"updated_at": "2024-06-01T12:00:00Z",
				"type":       1, // CommentTypeReopen 系统事件
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullComments(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullComments failed: %v", err)
	}
	// v0.7.x: 应该返回所有 3 条评论, 不过滤 type
	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3 (v0.7.x 不过滤 type, 返回所有评论)", len(items))
	}
	// 验证 type 字段正确透传
	typeMap := map[int64]int{}
	for _, item := range items {
		typeMap[item.ID] = item.Type
	}
	if typeMap[100] != 0 {
		t.Errorf("item 100 type = %d, want 0 (COMMENT)", typeMap[100])
	}
	if typeMap[101] != 21 {
		t.Errorf("item 101 type = %d, want 21 (REVIEW)", typeMap[101])
	}
	if typeMap[102] != 1 {
		t.Errorf("item 102 type = %d, want 1 (REOPEN)", typeMap[102])
	}
	// 验证普通评论字段映射
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
			"id":         200,
			"body":       capturedBody["body"],
			"user":       map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
			"created_at": "2024-06-02T12:00:00Z",
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

// ===== UpdatePullComment / DeletePullComment 测试（v0.5.0 M1） =====

// TestGiteaAdapter_UpdatePullComment 验证 PATCH 路径 + Content-Type + 字段映射
func TestGiteaAdapter_UpdatePullComment(t *testing.T) {
	var capturedMethod, capturedPath, capturedContentType string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         100,
			"body":       capturedBody["body"],
			"user":       map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
			"created_at": "2024-06-01T10:00:00Z",
			"updated_at": "2024-06-02T15:30:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	d, err := adapter.UpdatePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100, "@bob 请再看看第 42 行")
	if err != nil {
		t.Fatalf("UpdatePullComment failed: %v", err)
	}
	if capturedMethod != "PATCH" {
		t.Errorf("method = %q, want PATCH", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/comments/100" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", capturedContentType)
	}
	if capturedBody["body"] != "@bob 请再看看第 42 行" {
		t.Errorf("body = %v", capturedBody["body"])
	}
	if d.ID != 100 {
		t.Errorf("ID = %d, want 100", d.ID)
	}
	if d.UpdatedAt != "2024-06-02T15:30:00Z" {
		t.Errorf("UpdatedAt = %q (edited mark check)", d.UpdatedAt)
	}
}

// TestGiteaAdapter_UpdatePullComment_EmptyBody 验证 trim 后空 body short-circuit
func TestGiteaAdapter_UpdatePullComment_EmptyBody(t *testing.T) {
	serverHit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	_, err := adapter.UpdatePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100, "   ")
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

// TestGiteaAdapter_DeletePullComment 验证 DELETE 路径 + 204 No Content
func TestGiteaAdapter_DeletePullComment(t *testing.T) {
	var capturedMethod, capturedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	err := adapter.DeletePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100)
	if err != nil {
		t.Fatalf("DeletePullComment failed: %v", err)
	}
	if capturedMethod != "DELETE" {
		t.Errorf("method = %q, want DELETE", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/comments/100" {
		t.Errorf("path = %q", capturedPath)
	}
}

// TestGiteaAdapter_DeletePullComment_NotFound 验证 404 错误映射
func TestGiteaAdapter_DeletePullComment_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"message":"comment not found"}`))
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	err := adapter.DeletePullComment(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 999)
	if err == nil {
		t.Fatal("expected error for non-existent comment")
	}
	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("expected *IpcError, got %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeNotFound {
		t.Errorf("Code = %q, want %q", ipcErr.Code, ipc.CodeNotFound)
	}
}

// ===== 评论表情反应测试（v0.5.0 M2） =====

// TestGiteaAdapter_ListPullCommentReactions 验证 GET + 字段映射（content 字段）
//
// Gitea 1.26.2 实际返回的 JSON 字段是 `content`（不是 `reaction`），
// 且不包含 `id` 字段。测试 mock 数据对齐真实 API 格式。
func TestGiteaAdapter_ListPullCommentReactions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/dolphin/issues/comments/100/reactions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"content": "+1",
				"user":    map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
			},
			{
				"content": "heart",
				"user":    map[string]string{"login": "bob", "avatar_url": "https://gitea/bob.png"},
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullCommentReactions(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100)
	if err != nil {
		t.Fatalf("ListPullCommentReactions failed: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].Content != "+1" {
		t.Errorf("Content = %q, want +1 (Gitea content 字段映射)", items[0].Content)
	}
	if items[0].User == nil || items[0].User.Username != "alice" {
		t.Errorf("User = %+v", items[0].User)
	}
	if items[1].Content != "heart" {
		t.Errorf("Content = %q, want heart", items[1].Content)
	}
}

// TestGiteaAdapter_AddPullCommentReaction 验证 POST + Content-Type + body
func TestGiteaAdapter_AddPullCommentReaction(t *testing.T) {
	var capturedMethod, capturedPath, capturedContentType string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": capturedBody["content"],
			"user":    map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	d, err := adapter.AddPullCommentReaction(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100, "+1")
	if err != nil {
		t.Fatalf("AddPullCommentReaction failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/comments/100/reactions" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", capturedContentType)
	}
	if capturedBody["content"] != "+1" {
		t.Errorf("content = %v, want +1", capturedBody["content"])
	}
	if d.ID != 0 || d.Content != "+1" {
		t.Errorf("d = %+v", d)
	}
}

// TestGiteaAdapter_RemovePullCommentReaction 验证 DELETE + 带 body（Gitea 特色！）
func TestGiteaAdapter_RemovePullCommentReaction(t *testing.T) {
	var capturedMethod, capturedPath string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		// Gitea DELETE reactions 必须带 body
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	err := adapter.RemovePullCommentReaction(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 100, "+1")
	if err != nil {
		t.Fatalf("RemovePullCommentReaction failed: %v", err)
	}
	if capturedMethod != "DELETE" {
		t.Errorf("method = %q, want DELETE", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/comments/100/reactions" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedBody == nil || capturedBody["content"] != "+1" {
		t.Errorf("DELETE body should contain content=+1 (Gitea spec), got %+v", capturedBody)
	}
}

// ===== 合并请求评审测试（v0.5.0 M3） =====

// TestGiteaAdapter_ListPullReviews 验证 GET + 字段映射
func TestGiteaAdapter_ListPullReviews(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/dolphin/pulls/42/reviews" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":           50,
				"state":        "approved",
				"body":         "LGTM!",
				"user":         map[string]string{"login": "alice", "avatar_url": "https://gitea/alice.png"},
				"commit_id":    "abc123",
				"submitted_at": "2024-06-05T10:00:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullReviews(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullReviews failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].State != "approved" {
		t.Errorf("State = %q, want approved", items[0].State)
	}
	if items[0].Body != "LGTM!" {
		t.Errorf("Body = %q", items[0].Body)
	}
	if items[0].CommitID != "abc123" {
		t.Errorf("CommitID = %q, want abc123", items[0].CommitID)
	}
	if items[0].Author == nil || items[0].Author.Username != "alice" {
		t.Errorf("Author = %+v", items[0].Author)
	}
}

// TestGiteaAdapter_CreatePullReview_Approve 验证 POST + event approve
func TestGiteaAdapter_CreatePullReview_Approve(t *testing.T) {
	var capturedMethod, capturedPath string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":           60,
			"state":        "approved",
			"body":         "Looks good!",
			"user":         map[string]string{"login": "alice"},
			"commit_id":    "abc123",
			"submitted_at": "2024-06-05T12:00:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	d, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Body:  "Looks good!",
		Event: "approve",
	})
	if err != nil {
		t.Fatalf("CreatePullReview failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/pulls/42/reviews" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedBody["event"] != "approve" {
		t.Errorf("event = %v, want approve (Gitea uses lowercase)", capturedBody["event"])
	}
	if d.State != "approved" {
		t.Errorf("State = %q, want approved", d.State)
	}
}

// TestGiteaAdapter_CreatePullReview_InvalidEvent 验证 event 校验
func TestGiteaAdapter_CreatePullReview_InvalidEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	_, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Event: "invalid_event",
	})
	if err == nil {
		t.Fatal("expected validation error for invalid event")
	}
	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("expected *IpcError, got %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeValidationFailed {
		t.Errorf("Code = %q, want %q", ipcErr.Code, ipc.CodeValidationFailed)
	}
}

// TestGiteaAdapter_ListPullReviews_UppercaseStates 验证 Gitea 1.22+ 真实 API
// 返回的 state 是大写（APPROVED / PENDING / COMMENT / REQUEST_CHANGES / REQUEST_REVIEW），
// adapter 必须归一化到前端约定的小写 3 种值（approved / changes_requested / commented），
// 否则 reviewStateLabel 会 fallthrough 显示原文、CSS class 不匹配、review 头像永远显示 💬。
//
// 回归证据：PR #74（kanban_bot 2026-07-10 19:58:27 提交 request_changes review）截图显示 PENDING 徽章，
// 根因是 adapter 原样透传 "PENDING" 大写，reviewStateLabel fallthrough 返回原文。
func TestGiteaAdapter_ListPullReviews_UppercaseStates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{"id": 1, "state": "APPROVED", "body": "LGTM", "user": map[string]string{"login": "alice"}, "commit_id": "abc", "submitted_at": "2024-06-05T10:00:00Z"},
			{"id": 2, "state": "REQUEST_CHANGES", "body": "改一下", "user": map[string]string{"login": "bob"}, "commit_id": "abc", "submitted_at": "2024-06-05T11:00:00Z"},
			{"id": 3, "state": "COMMENT", "body": "提个建议", "user": map[string]string{"login": "carol"}, "commit_id": "abc", "submitted_at": "2024-06-05T12:00:00Z"},
			{"id": 4, "state": "PENDING", "body": "等人审", "user": map[string]string{"login": "dave"}, "commit_id": "abc", "submitted_at": "2024-06-05T13:00:00Z"},
			{"id": 5, "state": "REQUEST_REVIEW", "body": "求审", "user": map[string]string{"login": "eve"}, "commit_id": "abc", "submitted_at": "2024-06-05T14:00:00Z"},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullReviews(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullReviews failed: %v", err)
	}
	if len(items) != 5 {
		t.Fatalf("len(items) = %d, want 5", len(items))
	}
	want := []string{"approved", "changes_requested", "commented", "commented", "commented"}
	for i, w := range want {
		if items[i].State != w {
			t.Errorf("items[%d].State = %q, want %q (Gitea 大写 state 必须归一化)", i, items[i].State, w)
		}
	}
}

// TestGiteaAdapter_UploadIssueAttachment 验证 multipart/form-data 上传附件到
// POST /repos/{owner}/{repo}/issues/{index}/assets。form field 必须是 'attachment'
// （不是 'file'），Gitea 才认。返回 browser_download_url（形如 /attachments/<uuid>）。
//
// 回归证据：v0.7.0 之前 PR 评论贴图走前端 FileReader.readAsDataURL 转 data URI，
// Gitea 不存图片，渲染时只看到"贴图"占位符。修复后走这条上传到 Gitea 的
// attachments 表，markdown 引用真 url。
func TestGiteaAdapter_UploadIssueAttachment(t *testing.T) {
	const fakePng = "fake-png-bytes-v0.7.0"
	var capturedMethod, capturedPath, capturedContentType string
	var capturedFormField string
	var capturedFileName string
	var capturedFileContent []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedContentType = r.Header.Get("Content-Type")
		// 解析 multipart
		reader, err := r.MultipartReader()
		if err != nil {
			t.Errorf("MultipartReader failed: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			if part.FormName() == "attachment" {
				capturedFormField = "attachment"
				capturedFileName = part.FileName()
				buf, _ := io.ReadAll(part)
				capturedFileContent = buf
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":                   42,
			"name":                 "screenshot.png",
			"size":                 len(fakePng),
			"uuid":                 "abc-123-uuid",
			"browser_download_url": "https://gitea.example/attachments/abc-123-uuid",
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	dto, err := adapter.UploadIssueAttachment(
		context.Background(),
		server.URL, "alice", "test-token", "alice", "dolphin", 74,
		"screenshot.png", []byte(fakePng),
	)
	if err != nil {
		t.Fatalf("UploadIssueAttachment failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/api/v1/repos/alice/dolphin/issues/74/assets" {
		t.Errorf("path = %q, want /api/v1/repos/alice/dolphin/issues/74/assets", capturedPath)
	}
	if !strings.HasPrefix(capturedContentType, "multipart/form-data; boundary=") {
		t.Errorf("Content-Type = %q, want multipart/form-data; boundary=...", capturedContentType)
	}
	if capturedFormField != "attachment" {
		t.Errorf("form field = %q, want 'attachment' (Gitea 端点强制要求这个字段名)", capturedFormField)
	}
	if capturedFileName != "screenshot.png" {
		t.Errorf("file name = %q, want screenshot.png", capturedFileName)
	}
	if string(capturedFileContent) != fakePng {
		t.Errorf("file content mismatch")
	}
	if dto.BrowserDownloadURL != "https://gitea.example/attachments/abc-123-uuid" {
		t.Errorf("BrowserDownloadURL = %q", dto.BrowserDownloadURL)
	}
	if dto.UUID != "abc-123-uuid" {
		t.Errorf("UUID = %q", dto.UUID)
	}
}

// TestGiteaAdapter_UploadIssueAttachment_EmptyContent 验证空内容直接返回 validation error,
// 不发 HTTP 请求（防御性设计，避免浪费网络往返）。
func TestGiteaAdapter_UploadIssueAttachment_EmptyContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("empty content 不应发 HTTP 请求")
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	_, err := adapter.UploadIssueAttachment(
		context.Background(),
		server.URL, "alice", "test-token", "alice", "dolphin", 74,
		"screenshot.png", nil, // 空内容
	)
	if err == nil {
		t.Fatal("expected validation error for empty content")
	}
}

// TestGiteaAdapter_ListPullTimeline_DetailFields 验证 v0.7.2 timeline 端点二级详情字段解析
//
// 覆盖 7 个 system event 类型的 detail 字段映射：
//   - type=7 (label):        Label
//   - type=8 (milestone):    OldMilestone / Milestone
//   - type=9 (assignees):    Assignee + RemovedAssignee
//   - type=10 (change_title): OldTitle / NewTitle
//   - type=11 (delete_branch): OldRef
//   - type=3 (issue_ref):    RefIssue + RefAction
//   - type=19 (add_dependency): DependentIssue
func TestGiteaAdapter_ListPullTimeline_DetailFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/repos/alice/dolphin/issues/42/timeline" {
			t.Errorf("path = %q, want /timeline", r.URL.Path)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			// type=7 label
			{
				"id":         200,
				"type":       "label",
				"body":       "",
				"user":       map[string]string{"login": "bob"},
				"created_at": "2024-06-01T10:00:00Z",
				"label":      map[string]interface{}{"id": 1, "name": "bug", "color": "fbca04"},
			},
			// type=8 milestone (加)
			{
				"id":         201,
				"type":       "milestone",
				"body":       "",
				"user":       map[string]string{"login": "bob"},
				"created_at": "2024-06-01T10:01:00Z",
				"milestone":  map[string]interface{}{"id": 5, "title": "v1.0", "state": "open"},
			},
			// type=8 milestone (换: old + new)
			{
				"id":            202,
				"type":          "milestone",
				"body":          "",
				"user":          map[string]string{"login": "alice"},
				"created_at":    "2024-06-01T10:02:00Z",
				"old_milestone": map[string]interface{}{"id": 5, "title": "v1.0", "state": "open"},
				"milestone":     map[string]interface{}{"id": 6, "title": "v2.0", "state": "open"},
			},
			// type=9 assignees (加)
			{
				"id":         203,
				"type":       "assignees",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-01T10:03:00Z",
				"assignee":   map[string]string{"login": "bob", "avatar_url": "https://gitea/bob.png"},
			},
			// type=9 assignees (移除)
			{
				"id":               204,
				"type":             "assignees",
				"body":             "",
				"user":             map[string]string{"login": "alice"},
				"created_at":       "2024-06-01T10:04:00Z",
				"assignee":         map[string]string{"login": "bob", "avatar_url": "https://gitea/bob.png"},
				"removed_assignee": true,
			},
			// type=10 change_title
			{
				"id":         205,
				"type":       "change_title",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-01T10:05:00Z",
				"old_title":  "old title",
				"new_title":  "new title",
			},
			// type=11 delete_branch
			{
				"id":         206,
				"type":       "delete_branch",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-01T10:06:00Z",
				"old_ref":    "feature/old-branch",
			},
			// type=3 issue_ref (引用)
			{
				"id":         207,
				"type":       "issue_ref",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-01T10:07:00Z",
				"ref_action": "close",
				"ref_issue": map[string]interface{}{
					"id":     100,
					"number": 7,
					"title":  "related issue",
					"state":  "open",
					"repository": map[string]interface{}{
						"id":        1,
						"full_name": "alice/dolphin",
					},
				},
			},
			// type=19 add_dependency
			{
				"id":         208,
				"type":       "add_dependency",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-01T10:08:00Z",
				"dependent_issue": map[string]interface{}{
					"id":           200,
					"number":       8,
					"title":        "blocker issue",
					"state":        "open",
					"pull_request": map[string]interface{}{}, // 存在 = 是 PR
					"repository": map[string]interface{}{
						"id":        2,
						"full_name": "alice/seahorse",
					},
				},
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 9 {
		t.Fatalf("len(items) = %d, want 9", len(items))
	}

	// 200: label
	if items[0].Label == nil || items[0].Label.Name != "bug" || items[0].Label.Color != "fbca04" {
		t.Errorf("items[0] Label = %+v, want bug/fbca04", items[0].Label)
	}

	// 201: milestone (加)
	if items[1].Milestone == nil || items[1].Milestone.Title != "v1.0" {
		t.Errorf("items[1] Milestone = %+v, want v1.0", items[1].Milestone)
	}
	if items[1].OldMilestone != nil {
		t.Errorf("items[1] OldMilestone should be nil, got %+v", items[1].OldMilestone)
	}

	// 202: milestone (换)
	if items[2].OldMilestone == nil || items[2].OldMilestone.Title != "v1.0" {
		t.Errorf("items[2] OldMilestone = %+v, want v1.0", items[2].OldMilestone)
	}
	if items[2].Milestone == nil || items[2].Milestone.Title != "v2.0" {
		t.Errorf("items[2] Milestone = %+v, want v2.0", items[2].Milestone)
	}

	// 203: assignees (加)
	if items[3].Assignee == nil || items[3].Assignee.Username != "bob" {
		t.Errorf("items[3] Assignee = %+v, want bob", items[3].Assignee)
	}
	if items[3].RemovedAssignee {
		t.Errorf("items[3] RemovedAssignee = true, want false")
	}

	// 204: assignees (移除)
	if items[4].Assignee == nil || items[4].Assignee.Username != "bob" {
		t.Errorf("items[4] Assignee = %+v, want bob", items[4].Assignee)
	}
	if !items[4].RemovedAssignee {
		t.Errorf("items[4] RemovedAssignee = false, want true")
	}

	// 205: change_title
	if items[5].OldTitle != "old title" || items[5].NewTitle != "new title" {
		t.Errorf("items[5] title = %q/%q, want old title/new title", items[5].OldTitle, items[5].NewTitle)
	}

	// 206: delete_branch
	if items[6].OldRef != "feature/old-branch" {
		t.Errorf("items[6] OldRef = %q, want feature/old-branch", items[6].OldRef)
	}

	// 207: issue_ref
	if items[7].RefAction != "close" {
		t.Errorf("items[7] RefAction = %q, want close", items[7].RefAction)
	}
	if items[7].RefIssue == nil || items[7].RefIssue.Index != 7 {
		t.Errorf("items[7] RefIssue = %+v, want index 7", items[7].RefIssue)
	}
	if items[7].RefIssue == nil || items[7].RefIssue.RepoFullName != "alice/dolphin" {
		t.Errorf("items[7] RefIssue.RepoFullName = %+v, want alice/dolphin", items[7].RefIssue)
	}
	if items[7].RefIssue != nil && items[7].RefIssue.IsPull {
		t.Errorf("items[7] RefIssue.IsPull = true, want false (issue not PR)")
	}

	// 208: add_dependency (dependent_issue 是 PR, 不是普通 issue)
	if items[8].DependentIssue == nil {
		t.Fatal("items[8] DependentIssue = nil, want 8")
	}
	if items[8].DependentIssue.Index != 8 {
		t.Errorf("items[8] DependentIssue.Index = %d, want 8", items[8].DependentIssue.Index)
	}
	if items[8].DependentIssue.RepoFullName != "alice/seahorse" {
		t.Errorf("items[8] DependentIssue.RepoFullName = %q, want alice/seahorse", items[8].DependentIssue.RepoFullName)
	}
	if !items[8].DependentIssue.IsPull {
		t.Errorf("items[8] DependentIssue.IsPull = false, want true (pull_request 字段存在)")
	}
}

// TestGiteaAdapter_isWipToggleEvent 验证 WIP toggle 检测逻辑
//
// 4 种 case 覆盖 Gitea 端 `commentTimelineEventIsWipToggle` 等价行为：
//   - 普通标题修改（两边都没/都有 WIP 前缀）→ false, false
//   - toggle to WIP（OldTitle 没前缀 → NewTitle 加 WIP:）→ true, true
//   - toggle to ready（OldTitle 有 WIP: → NewTitle 去掉）→ true, false
//   - 加前缀但内容变化（不是 toggle）→ false, false
func TestGiteaAdapter_isWipToggleEvent(t *testing.T) {
	cases := []struct {
		name     string
		oldTitle string
		newTitle string
		wantTog  bool
		wantWip  bool
	}{
		{"普通修改", "old", "new", false, false},
		{"两侧都有WIP前缀", "WIP: a", "WIP: b", false, false},
		{"两侧都无WIP前缀", "a", "b", false, false},
		{"toggle to WIP", "feat: add foo", "WIP: feat: add foo", true, true},
		{"toggle to ready (大小写不敏感)", "WIP: fix bug", "fix bug", true, false},
		{"toggle to WIP (Draft: 前缀)", "fix bug", "Draft: fix bug", true, true},
		{"加前缀但内容变化", "feat: a", "WIP: feat: b", false, false},
		{"去前缀但内容变化", "WIP: feat: a", "feat: b", false, false},
		{"前后加空格 (TrimSpace 容忍)", "WIP:  feat  ", "  feat", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotTog, gotWip := isWipToggleEvent(tc.oldTitle, tc.newTitle)
			if gotTog != tc.wantTog || gotWip != tc.wantWip {
				t.Errorf("isWipToggleEvent(%q, %q) = (%v, %v), want (%v, %v)",
					tc.oldTitle, tc.newTitle, gotTog, gotWip, tc.wantTog, tc.wantWip)
			}
		})
	}
}

// TestGiteaAdapter_ListPullTimeline_WipToggle 验证 type=10 (change_title) 事件
// WIP toggle 标记是否被正确识别
func TestGiteaAdapter_ListPullTimeline_WipToggle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":         300,
				"type":       "change_title",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-02T10:00:00Z",
				"old_title":  "feat: add foo",
				"new_title":  "WIP: feat: add foo",
			},
			{
				"id":         301,
				"type":       "change_title",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-02T10:01:00Z",
				"old_title":  "WIP: fix bug",
				"new_title":  "fix bug",
			},
			{
				"id":         302,
				"type":       "change_title",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-02T10:02:00Z",
				"old_title":  "old",
				"new_title":  "new",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(items))
	}

	// 300: toggle to WIP
	if !items[0].IsWipToggle || !items[0].IsWip {
		t.Errorf("items[0] IsWipToggle=%v IsWip=%v, want true/true", items[0].IsWipToggle, items[0].IsWip)
	}

	// 301: toggle to ready
	if !items[1].IsWipToggle || items[1].IsWip {
		t.Errorf("items[1] IsWipToggle=%v IsWip=%v, want true/false", items[1].IsWipToggle, items[1].IsWip)
	}

	// 302: 普通标题修改
	if items[2].IsWipToggle || items[2].IsWip {
		t.Errorf("items[2] IsWipToggle=%v IsWip=%v, want false/false", items[2].IsWipToggle, items[2].IsWip)
	}
}

// TestGiteaAdapter_ListPullTimeline_LabelAction 验证 type=7 (label) 事件
// 根据 body 字段填到 AddedLabels/RemovedLabels 数组
//
// v0.7.19 根因修复：Gitea 1.26+ timeline 端点 label 事件 add/remove 信息在
// `body` 字段（值为 "1" 表示 add，其他值/空串表示 remove），不是 `content` 字段。
// v0.7.6 当时按 Gitea 源码注释写 `content` 字段是错的，实测 pr72/pr81 timeline
// 数据 label event body="1"、无 content 字段。修法：测试 input 改用 `body` 字段。
func TestGiteaAdapter_ListPullTimeline_LabelAction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			// 添加 label
			{
				"id":         400,
				"type":       "label",
				"body":       "1",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-03T10:00:00Z",
				"label":      map[string]interface{}{"id": 1, "name": "bug", "color": "fbca04"},
			},
			// 移除 label
			{
				"id":         401,
				"type":       "label",
				"body":       "",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-03T10:01:00Z",
				"label":      map[string]interface{}{"id": 2, "name": "wontfix", "color": "cccccc"},
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}

	// 400: 添加 → AddedLabels=[bug], RemovedLabels=nil
	if items[0].LabelAction != "add" {
		t.Errorf("items[0] LabelAction = %q, want add", items[0].LabelAction)
	}
	if len(items[0].AddedLabels) != 1 || items[0].AddedLabels[0].Name != "bug" {
		t.Errorf("items[0] AddedLabels = %+v, want [bug]", items[0].AddedLabels)
	}
	if len(items[0].RemovedLabels) != 0 {
		t.Errorf("items[0] RemovedLabels = %+v, want nil", items[0].RemovedLabels)
	}

	// 401: 移除 → AddedLabels=nil, RemovedLabels=[wontfix]
	if items[1].LabelAction != "remove" {
		t.Errorf("items[1] LabelAction = %q, want remove", items[1].LabelAction)
	}
	if len(items[1].AddedLabels) != 0 {
		t.Errorf("items[1] AddedLabels = %+v, want nil", items[1].AddedLabels)
	}
	if len(items[1].RemovedLabels) != 1 || items[1].RemovedLabels[0].Name != "wontfix" {
		t.Errorf("items[1] RemovedLabels = %+v, want [wontfix]", items[1].RemovedLabels)
	}
}

// TestGiteaAdapter_ListPullTimeline_PushMergeTypeNormalization 验证 v0.7.8 根因修复
//
// 根因：v0.7.5/v0.7.7 凭印象假设 Gitea /timeline 端点 type 字符串是 "push" / "merge"，
// 实际 Gitea 1.26+ 返回 snake_case 命名 "pull_push" / "merge_pull"，导致前端模板
// 永远不进 push/merge 渲染分支。同时 commit 信息在 body JSON 字符串里
//（{"is_force_push":false,"commit_ids":["sha1"]}），不在顶层独立字段。
//
// 修复：giteaTimelineToItem 做两层归一化 ——
//   1. type 字符串：pull_push → push / merge_pull → merge
//   2. push 事件 body JSON 解析：commit_ids → CommitIDs 数组 / is_force_push → IsForcePush
//   3. 删 v0.7.7 假设的 4 个独立顶层字段（OldCommit / NewCommit / CommitsNum / IsForcePush
//      在 API 里都不存在）
func TestGiteaAdapter_ListPullTimeline_PushMergeTypeNormalization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			// type=pull_push + body JSON 含 1 个 commit —— v0.7.8 应归一化为 type=push + CommitIDs=[sha]
			{
				"id":         500,
				"type":       "pull_push",
				"body":       `{"is_force_push":false,"commit_ids":["aabbccddeeff00112233445566778899aabbccdd"]}`,
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-04T10:00:00Z",
			},
			// type=pull_push + body JSON 含 2 个 commit + is_force_push=true —— force push
			{
				"id":         501,
				"type":       "pull_push",
				"body":       `{"is_force_push":true,"commit_ids":["1111111111111111111111111111111111111111","2222222222222222222222222222222222222222"]}`,
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-04T10:05:00Z",
			},
			// type=merge_pull + 空 body —— v0.7.8 应归一化为 type=merge
			{
				"id":         502,
				"type":       "merge_pull",
				"body":       "",
				"user":       map[string]string{"login": "bob"},
				"created_at": "2024-06-04T10:10:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(items))
	}

	// 500: type 归一化 + 1 个 commit
	if items[0].Type != "push" {
		t.Errorf("items[0].Type = %q, want push (normalized from pull_push)", items[0].Type)
	}
	if items[0].IsForcePush {
		t.Errorf("items[0].IsForcePush = true, want false")
	}
	if len(items[0].CommitIDs) != 1 || items[0].CommitIDs[0] != "aabbccddeeff00112233445566778899aabbccdd" {
		t.Errorf("items[0].CommitIDs = %+v, want [aabbccddeeff00112233445566778899aabbccdd]", items[0].CommitIDs)
	}
	// v0.7.8 删了 v0.7.7 加的 4 个无用字段（OldCommit / NewCommit / CommitsNum
	// / 顶层 IsForcePush），编译期就不存在 —— CommitIDs 数组 + IsForcePush 才是
	// push 事件的权威来源。v0.7.8 删了这些字段后 timeline 模板渲染也能进 push 分支
	// （type 归一化 + CommitIDs 有值）

	// 501: type 归一化 + 2 个 commit + force push
	if items[1].Type != "push" {
		t.Errorf("items[1].Type = %q, want push", items[1].Type)
	}
	if !items[1].IsForcePush {
		t.Errorf("items[1].IsForcePush = false, want true")
	}
	if len(items[1].CommitIDs) != 2 {
		t.Errorf("items[1].CommitIDs = %+v, want 2 entries", items[1].CommitIDs)
	}

	// 502: type 归一化 merge
	if items[2].Type != "merge" {
		t.Errorf("items[2].Type = %q, want merge (normalized from merge_pull)", items[2].Type)
	}
	if len(items[2].CommitIDs) != 0 {
		t.Errorf("items[2].CommitIDs = %+v, want nil (merge_pull body is empty)", items[2].CommitIDs)
	}
}

// TestGiteaAdapter_ListPullTimeline_PushBodyInvalid 验证 push event body 不是
// 合法 JSON 时静默忽略（兼容老 Gitea 版本 body 格式 "added N commits {time}"）
func TestGiteaAdapter_ListPullTimeline_PushBodyInvalid(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			// 旧 Gitea（<= 1.25）push event body 是文本格式，type 字符串也是 "push"
			// —— v0.7.8 不会走这条路径（type 字符串是 "push" 不是 "pull_push"），
			// 但万一某天有混合 / proxy 场景 body 不是 JSON，应静默忽略
			{
				"id":         600,
				"type":       "pull_push",
				"body":       "added 2 commits 5 minutes ago",
				"user":       map[string]string{"login": "alice"},
				"created_at": "2024-06-04T10:00:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	// type 归一化 OK
	if items[0].Type != "push" {
		t.Errorf("items[0].Type = %q, want push", items[0].Type)
	}
	// body 解析失败 → CommitIDs 留空 + IsForcePush 留 false（不报错）
	if len(items[0].CommitIDs) != 0 {
		t.Errorf("items[0].CommitIDs = %+v, want nil (body parse failed)", items[0].CommitIDs)
	}
	if items[0].IsForcePush {
		t.Errorf("items[0].IsForcePush = true, want false (body parse failed)")
	}
}

// TestGiteaAdapter_GetPull_MergeCommitSHA 验证 v0.7.8 新增 merge_commit_sha 字段映射
//
// 背景：v0.7.7 加了 PullDetailDTO.MergeCommitSHA 字段但 Gitea adapter 漏了 raw struct
// 字段 + 映射，PR 详情拿不到 merge commit SHA，timeline 渲染 merge 事件没有 SHA 链接。
// v0.7.8 修：giteaPullRaw 加 MergeCommitSHA 字段，giteaPullToDetail 映射到 DTO。
func TestGiteaAdapter_GetPull_MergeCommitSHA(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 模拟 PR 已合并场景
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number":           42,
			"title":            "test merged PR",
			"state":            "closed",
			"merged":           true,
			"merge_commit_sha": "deadbeef1234567890abcdef1234567890abcdef",
			"mergeable":        false, // 已合并 PR mergeable=false
			"comments":         0,
			"commits":          3,
			"merged_by":        map[string]string{"login": "bob"},
			"head":             map[string]string{"ref": "feat-x", "sha": "aaaa"},
			"base":             map[string]string{"ref": "main", "sha": "bbbb"},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	pull, err := adapter.GetPull(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if pull.MergeCommitSHA != "deadbeef1234567890abcdef1234567890abcdef" {
		t.Errorf("MergeCommitSHA = %q, want deadbeef1234567890abcdef1234567890abcdef",
			pull.MergeCommitSHA)
	}
}

// TestGiteaAdapter_GetPull_RefLabel 验证 v0.7.9 新增 head/base ref Label 字段映射
//
// 背景：Gitea 1.20+ /pulls/{index} 端点 head/base 嵌套对象里返 Label 字段
// （真实分支名，去掉 refs/heads/ 前缀），跟 ref 字段（git ref 全路径）不同。
// 比如 PR 头部 ref = "refs/pull/72/head"，Label = "pr-with-labels-366575"。
// v0.7.6 改 PR header 格式时只用了 ref 字段，导致显示成 ref id 而不是真实分支名
// （user 反馈 "缺少明确的分支记录"）。
//
// 修复：giteaPullRefRaw 加 Label 字段，giteaPullToDetail 映射到 PullRefDTO.Label。
// 前端 PR header 模板用 `selectedPR.head.label || selectedPR.head.ref` 渲染。
func TestGiteaAdapter_GetPull_RefLabel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 模拟 Gitea 实际行为：head ref 是 git ref 全路径，label 是真实分支名
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number": 72,
			"title":  "test ref label",
			"state":  "closed",
			"merged": false,
			"head": map[string]interface{}{
				"label": "pr-with-labels-366575", // 真实分支名
				"ref":   "refs/pull/72/head",     // git ref 全路径
				"sha":   "aaaa",
			},
			"base": map[string]interface{}{
				"label": "main",  // base 通常 label == ref
				"ref":   "main",  // Gitea base 不带 refs/heads/ 前缀（已对齐）
				"sha":   "bbbb",
			},
		})
	}))
	defer server.Close()

	adapter := NewGiteaAdapter()
	pull, err := adapter.GetPull(context.Background(), server.URL, "alice", "test-token", "alice", "dolphin", 72)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}

	// head label = 真实分支名
	if pull.Head.Label != "pr-with-labels-366575" {
		t.Errorf("Head.Label = %q, want pr-with-labels-366575", pull.Head.Label)
	}
	if pull.Head.Ref != "refs/pull/72/head" {
		t.Errorf("Head.Ref = %q, want refs/pull/72/head", pull.Head.Ref)
	}

	// base label/ref 都应该 = main
	if pull.Base.Label != "main" {
		t.Errorf("Base.Label = %q, want main", pull.Base.Label)
	}
	if pull.Base.Ref != "main" {
		t.Errorf("Base.Ref = %q, want main", pull.Base.Ref)
	}
}
