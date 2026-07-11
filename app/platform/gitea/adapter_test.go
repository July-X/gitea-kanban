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
