package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	appgit "gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform"
)

// errorsAs 引用 errors.As（避免和 package 内的 errorsAs shadow）
func errorsAs(err error, target **ipc.IpcError) bool {
	return errors.As(err, target)
}

func TestGitHubAdapter_VerifyToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 验证请求路径
		if r.URL.Path != "/user" {
			t.Errorf("path = %q, want /user", r.URL.Path)
		}
		// 验证鉴权头（GitHub 用 Bearer，不是 token）
		if auth := r.Header.Get("Authorization"); auth != "Bearer ghp-test-token" {
			t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", auth)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         456,
			"login":      "octocat",
			"name":       "The Octocat",
			"email":      "octo@github.com",
			"avatar_url": "https://github.com/octocat.png",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	user, err := adapter.VerifyToken(context.Background(), server.URL, "ghp-test-token")
	if err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}

	if user.ID != 456 {
		t.Errorf("ID = %d, want 456", user.ID)
	}
	if user.Login != "octocat" {
		t.Errorf("Login = %q, want octocat", user.Login)
	}
	if user.FullName != "The Octocat" {
		t.Errorf("FullName = %q, want 'The Octocat'", user.FullName)
	}
}

func TestGitHubAdapter_VerifyToken_DefaultHost(t *testing.T) {
	// hostURL 为空时应该用 GitHubAPIBase
	// 这里只验证不 panic（不实际请求 GitHub）
	adapter := NewGitHubAdapter()
	// 不实际调（需要网络），只验证 Platform 方法
	if adapter.Platform() != platform.GitHub {
		t.Errorf("Platform = %q, want github", adapter.Platform())
	}
}

func TestGitHubAdapter_NotSupported(t *testing.T) {
	adapter := NewGitHubAdapter()
	ctx := context.Background()

	// ListRepos 已实现（v2.x 走 GET /user/repos），不再 ErrNotSupported
	// 真实测试见 TestGitHubAdapter_ListRepos_*

	// ListBranches
	_, err := adapter.ListBranches(ctx, "", "", "", "", "")
	if err != platform.ErrNotSupported {
		t.Errorf("ListBranches error = %v, want ErrNotSupported", err)
	}

	// ListIssues
	_, err = adapter.ListIssues(ctx, "", "", "", "", "", platform.ListIssuesOpts{})
	if err != platform.ErrNotSupported {
		t.Errorf("ListIssues error = %v, want ErrNotSupported", err)
	}

	// ListPulls v0.6+ 已实现（GET /repos/{owner}/{repo}/pulls），不在 NotSupported 范围
	// 真实测试见 TestGitHubAdapter_ListPulls_Basic

	// ListLabels v0.7.0 已实现（GET /repos/{owner}/{repo}/labels）
	// 真实测试见 TestGitHubAdapter_ListLabels

	// ListMembers v0.7.0 已实现（GET /repos/{owner}/{repo}/collaborators），见 TestGitHubAdapter_ListMembers
}

// TestGitHubAdapter_ListLabels 验证路径 + 字段映射（v0.7.0 Phase 1 Task 1.1）
func TestGitHubAdapter_ListLabels(t *testing.T) {
	var capturedPath, capturedMethod, capturedAuth string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedMethod = r.Method
		capturedAuth = r.Header.Get("Authorization")
		// per_page=100 在 ListLabels 里硬编码
		if r.URL.RawQuery != "per_page=100" {
			t.Errorf("query = %q, want per_page=100", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `[
			{"id":1001,"name":"bug","color":"f29513","description":"Something isn't working"},
			{"id":1002,"name":"enhancement","color":"84b6eb","description":"New feature or request","default":true},
			{"id":1003,"name":"docs","color":"0075ca","description":"Documentation only changes","default":false}
		]`)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	labels, err := adapter.ListLabels(context.Background(), server.URL, "alice", "ghp-test-token", "owner-x", "repo-y")
	if err != nil {
		t.Fatalf("ListLabels failed: %v", err)
	}

	if capturedPath != "/repos/owner-x/repo-y/labels" {
		t.Errorf("path = %q, want /repos/owner-x/repo-y/labels", capturedPath)
	}
	if capturedMethod != "GET" {
		t.Errorf("method = %q, want GET", capturedMethod)
	}
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = [redacted], want 'Bearer ghp-test-token'")
	}

	if len(labels) != 3 {
		t.Fatalf("len(labels) = %d, want 3", len(labels))
	}

	// 验证字段映射
	if labels[0].ID != 1001 || labels[0].Name != "bug" || labels[0].Color != "f29513" || labels[0].Description != "Something isn't working" {
		t.Errorf("labels[0] = %+v, want {ID:1001 Name:bug Color:f29513 Description:Something isn't working}", labels[0])
	}
	if labels[1].ID != 1002 || labels[1].Name != "enhancement" || labels[1].Color != "84b6eb" {
		t.Errorf("labels[1] = %+v, want {ID:1002 Name:enhancement Color:84b6eb}", labels[1])
	}
	if labels[2].ID != 1003 || labels[2].Name != "docs" || labels[2].Color != "0075ca" {
		t.Errorf("labels[2] = %+v, want {ID:1003 Name:docs Color:0075ca}", labels[2])
	}
}

func TestGitHubAdapter_Platform(t *testing.T) {
	adapter := NewGitHubAdapter()
	if adapter.Platform() != "github" {
		t.Errorf("Platform = %q, want github", adapter.Platform())
	}
}

func TestGraphResultToDTO_IncludesBranches(t *testing.T) {
	dto := graphResultToDTO(&graph.GraphResult{
		Nodes: []graph.GraphNode{{
			Row:      0,
			Lane:     0,
			Color:    1,
			SHA:      "abcdef",
			ShortSHA: "abcdef",
			RefTypes: []appgit.RefType{appgit.RefTypeRemoteBranch},
		}},
		Branches: []graph.GraphBranch{{
			Color: 2,
			End:   2,
			Lines: []graph.GraphBranchLine{{
				X1: 0, Y1: 0,
				X2: 1, Y2: 1,
				LockedFirst: true,
			}},
		}},
		MaxLane: 1,
	})
	if dto == nil || len(dto.Branches) != 1 {
		t.Fatalf("branches not propagated: %#v", dto)
	}
	line := dto.Branches[0].Lines[0]
	if line.X1 != 0 || line.X2 != 1 || !line.LockedFirst {
		t.Fatalf("branch line mismatch: %#v", line)
	}
	if got := dto.Nodes[0].RefTypes[0]; got != "remoteBranch" {
		t.Fatalf("ref type = %q, want remoteBranch", got)
	}
}

func TestMapHTTPError(t *testing.T) {
	cases := []int{401, 403, 404, 422, 429, 503}
	for _, status := range cases {
		err := mapHTTPError(status, "body")
		if err == nil {
			t.Errorf("expected error for status %d", status)
		}
	}
}

// ===== ListRepos 测试（v2.x 新增）=====
//
// 设计目标（对齐 AGENTS §7.1 测试策略）：
//   - 用 httptest.NewServer 模拟 GitHub API
//   - 验证：鉴权头、URL 路径、查询参数、字段映射、错误码、客户端过滤

// TestGitHubAdapter_ListRepos_Basic 验证鉴权头 + 路径 + 字段映射
func TestGitHubAdapter_ListRepos_Basic(t *testing.T) {
	var capturedPath string
	var capturedAuth string
	var capturedQuery url.Values

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		capturedQuery = r.URL.Query()

		// 模拟 GitHub /user/repos 返回两条
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":             1001,
				"name":           "hello-world",
				"full_name":      "octocat/hello-world",
				"default_branch": "main",
				"description":    "My first repo",
				"private":        false,
				"archived":       false,
				"updated_at":     "2024-06-01T12:00:00Z",
				"owner":          map[string]string{"login": "octocat"},
			},
			{
				"id":             1002,
				"name":           "private-tool",
				"full_name":      "octocat/private-tool",
				"default_branch": "master",
				"description":    "Internal tool",
				"private":        true,
				"archived":       false,
				"updated_at":     "2024-06-15T08:30:00Z",
				"owner":          map[string]string{"login": "octocat"},
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	repos, err := adapter.ListRepos(context.Background(), server.URL, "octocat", "ghp-test-token", platform.ListReposOpts{Limit: 50})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}

	// 鉴权头：Bearer（不是 Gitea 的 token <pat>）
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", capturedAuth)
	}
	// 路径
	if capturedPath != "/user/repos" {
		t.Errorf("path = %q, want /user/repos", capturedPath)
	}
	// affiliation 必须含三个关系 —— "想看哪个仓库就能同步哪个"是产品目标
	aff := capturedQuery.Get("affiliation")
	if aff != "owner,collaborator,organization_member" {
		t.Errorf("affiliation = %q, want owner,collaborator,organization_member", aff)
	}
	if capturedQuery.Get("sort") != "pushed" || capturedQuery.Get("direction") != "desc" {
		t.Errorf("sort/direction = %q/%q, want pushed/desc", capturedQuery.Get("sort"), capturedQuery.Get("direction"))
	}
	if capturedQuery.Get("per_page") != "50" {
		t.Errorf("per_page = %q, want 50", capturedQuery.Get("per_page"))
	}

	// 字段映射：2 条 → 2 个 RepoDTO
	if len(repos) != 2 {
		t.Fatalf("len(repos) = %d, want 2", len(repos))
	}

	// 第 1 条：public
	r0 := repos[0]
	if r0.ID != 1001 || r0.Owner != "octocat" || r0.Name != "hello-world" ||
		r0.FullName != "octocat/hello-world" || r0.DefaultBranch != "main" ||
		r0.Description != "My first repo" || r0.Private != false ||
		r0.Archived != false || r0.UpdatedAt != "2024-06-01T12:00:00Z" {
		t.Errorf("repos[0] = %+v, want id=1001 owner=octocat name=hello-world ...", r0)
	}
	if r0.Permissions != nil {
		t.Errorf("repos[0].Permissions should be nil (GitHub /user/repos doesn't return it)")
	}

	// 第 2 条：private
	r1 := repos[1]
	if r1.Private != true || r1.UpdatedAt != "2024-06-15T08:30:00Z" {
		t.Errorf("repos[1] = %+v, want private=true updated_at=2024-06-15T08:30:00Z", r1)
	}
}

// TestGitHubAdapter_ListRepos_QueryFilter 客户端 query 模糊匹配
func TestGitHubAdapter_ListRepos_QueryFilter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":             1,
				"name":           "hello-world",
				"full_name":      "octocat/hello-world",
				"default_branch": "main",
				"description":    "Greet the world",
				"private":        false,
				"archived":       false,
				"updated_at":     "2024-01-01T00:00:00Z",
				"owner":          map[string]string{"login": "octocat"},
			},
			{
				"id":             2,
				"name":           "private-tool",
				"full_name":      "octocat/private-tool",
				"default_branch": "main",
				"description":    "Internal tool",
				"private":        true,
				"archived":       false,
				"updated_at":     "2024-01-02T00:00:00Z",
				"owner":          map[string]string{"login": "octocat"},
			},
			{
				"id":             3,
				"name":           "docs",
				"full_name":      "octo-org/docs",
				"default_branch": "main",
				"description":    "Hello documentation",
				"private":        false,
				"archived":       false,
				"updated_at":     "2024-01-03T00:00:00Z",
				"owner":          map[string]string{"login": "octo-org"},
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()

	// 关键词 "hello" → 匹配 hello-world（full_name）+ docs（description）
	repos, err := adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{Query: "hello"})
	if err != nil {
		t.Fatalf("ListRepos(query=hello) failed: %v", err)
	}
	if len(repos) != 2 {
		t.Fatalf("len(repos) = %d, want 2", len(repos))
	}
	got := []string{repos[0].FullName, repos[1].FullName}
	want := map[string]bool{"octocat/hello-world": true, "octo-org/docs": true}
	for _, n := range got {
		if !want[n] {
			t.Errorf("unexpected repo %q in filter result", n)
		}
	}

	// 大小写不敏感
	repos, err = adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{Query: "PRIVATE"})
	if err != nil {
		t.Fatalf("ListRepos(query=PRIVATE) failed: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "octocat/private-tool" {
		t.Errorf("uppercase query: got %+v, want only private-tool", repos)
	}

	// 不匹配任何
	repos, err = adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{Query: "nonexistent"})
	if err != nil {
		t.Fatalf("ListRepos(query=nonexistent) failed: %v", err)
	}
	if len(repos) != 0 {
		t.Errorf("len(repos) = %d, want 0", len(repos))
	}
}

// TestGitHubAdapter_ListRepos_Pagination 分页参数透传 + 上限 100 截断
func TestGitHubAdapter_ListRepos_Pagination(t *testing.T) {
	var capturedQuery url.Values

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.Query()
		json.NewEncoder(w).Encode([]map[string]interface{}{}) // 空即可
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()

	// Limit > 100 应该被截到 100
	_, err := adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{Limit: 500, Page: 3})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if capturedQuery.Get("per_page") != "100" {
		t.Errorf("per_page = %q, want 100 (Limit>100 should be clamped)", capturedQuery.Get("per_page"))
	}
	if capturedQuery.Get("page") != "3" {
		t.Errorf("page = %q, want 3", capturedQuery.Get("page"))
	}

	// 默认值：Limit=0 → 50；Page=0 → 1
	_, err = adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if capturedQuery.Get("per_page") != "50" {
		t.Errorf("default per_page = %q, want 50", capturedQuery.Get("per_page"))
	}
	if capturedQuery.Get("page") != "1" {
		t.Errorf("default page = %q, want 1", capturedQuery.Get("page"))
	}
}

// TestGitHubAdapter_ListRepos_Empty 空响应（用户没仓库 / 全部私有但 token scope 不够拿不到）
func TestGitHubAdapter_ListRepos_Empty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// GitHub 空数组返 [] 而非 {}
		w.Write([]byte("[]"))
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	repos, err := adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{})
	if err != nil {
		t.Fatalf("ListRepos failed: %v", err)
	}
	if len(repos) != 0 {
		t.Errorf("len(repos) = %d, want 0", len(repos))
	}
}

// TestGitHubAdapter_RequestHeaders 验证请求头符合 GitHub 文档要求
//
// 用户曾报告 406 Not Acceptable:GitHub 文档明确要求
//   - User-Agent: 应用名(Go 默认 Go-http-client/1.1 偶尔被拒)
//   - X-GitHub-Api-Version: 2022-11-28(钉死避免 API 升级导致兼容问题)
//   - Accept: application/vnd.github+json
//
// 这两个 header 缺失是 GitHub 返 406/415 的常见根因
func TestGitHubAdapter_RequestHeaders(t *testing.T) {
	var capturedHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header.Clone()
		w.WriteHeader(200)
		// 返最小可用 JSON,让 /user VerifyToken 走通
		fmt.Fprintln(w, `{"id":1,"login":"octocat"}`)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	if _, err := adapter.VerifyToken(context.Background(), server.URL, "test-token"); err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}

	if got := capturedHeaders.Get("Accept"); got != "application/vnd.github+json" {
		t.Errorf("Accept = %q, want application/vnd.github+json", got)
	}
	if got := capturedHeaders.Get("Authorization"); got != "Bearer test-token" {
		t.Errorf("Authorization = %q, want 'Bearer test-token'", got)
	}
	// 关键:User-Agent 不能是默认 Go-http-client/1.1,必须是应用名
	if got := capturedHeaders.Get("User-Agent"); got == "" || got == "Go-http-client/1.1" {
		t.Errorf("User-Agent = %q (must be gitea-kanban/<version>, GitHub 文档要求)", got)
	}
	if !strings.HasPrefix(capturedHeaders.Get("User-Agent"), "gitea-kanban/") {
		t.Errorf("User-Agent = %q, want prefix gitea-kanban/", capturedHeaders.Get("User-Agent"))
	}
	// 关键:X-GitHub-Api-Version 钉死,避免 GitHub 升级后行为变更
	if got := capturedHeaders.Get("X-GitHub-Api-Version"); got == "" {
		t.Error("X-GitHub-Api-Version is empty, GitHub API 行为可能因版本升级而变化")
	}
}

// TestGitHubAdapter_ListRepos_NetworkError 网络层失败 → IpcError(network_offline)
//
// 关键回归：v2.x 修复前 doRequest 网络层失败返 fmt.Errorf("请求失败: ...")。
// 前端 normalizeError 落到 "未知错误" 占位文案（用户根本看不到原因）。
// 修复后必须返 *ipc.IpcError 且 code=network_offline，前端才能识别为"网络问题"。
func TestGitHubAdapter_ListRepos_NetworkError(t *testing.T) {
	// 用永远连不上的地址（RFC 5737 TEST-NET-1 198.51.100.0/24）模拟网络层失败
	// httptest server close 后立刻断，httpClient.Do 会拿到 connection refused
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.Close() // 立即关闭 → 后续请求必失败

	adapter := NewGitHubAdapter()
	_, err := adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{})

	if err == nil {
		t.Fatalf("expected network error, got nil")
	}

	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("error is not *ipc.IpcError, type = %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeNetworkOffline {
		t.Errorf("code = %q, want %q (network_offline)", ipcErr.Code, ipc.CodeNetworkOffline)
	}
	if !strings.Contains(ipcErr.Message, "离线") && !strings.Contains(ipcErr.Message, "网络") {
		t.Errorf("message = %q, want 含「离线」或「网络」(提示用户网络问题)", ipcErr.Message)
	}
}

// TestGitHubAdapter_VerifyToken_NetworkError 同上,VerifyToken 路径也得走 IpcError
func TestGitHubAdapter_VerifyToken_NetworkError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.VerifyToken(context.Background(), server.URL, "tok")

	if err == nil {
		t.Fatalf("expected network error, got nil")
	}

	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("error is not *ipc.IpcError, type = %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeNetworkOffline {
		t.Errorf("code = %q, want %q", ipcErr.Code, ipc.CodeNetworkOffline)
	}
}

// TestGitHubAdapter_ListRepos_AuthError 400/401/403/404/415/422/429/5xx/default 全部走 mapHTTPError
//
// v2.x 修复重点：每个分支都必须带 HTTPStatus（前端 toast 显示具体码）；
// 5xx 一律走 network_offline，不再出现"服务器开小差"模糊文案；
// default 兜底 message 必须包含状态码（不再写死"GitHub 返回错误"）。
func TestGitHubAdapter_ListRepos_AuthError(t *testing.T) {
	cases := []struct {
		status     int
		body       string
		wantCode   string
		wantStatus int
	}{
		{400, `{"message":"Invalid query"}`, ipc.CodeValidationFailed, 400},
		{401, `{"message":"Bad credentials"}`, ipc.CodeTokenInvalid, 401},
		{403, `{"message":"Resource not accessible"}`, ipc.CodePermissionDenied, 403},
		{404, `{"message":"Not Found"}`, ipc.CodeNotFound, 404},
		{406, `{"message":"Not Acceptable"}`, ipc.CodeValidationFailed, 406},
		{415, `{"message":"Unsupported 'Accept' header"}`, ipc.CodeValidationFailed, 415},
		{422, `{"message":"Validation Failed"}`, ipc.CodeValidationFailed, 422},
		{429, `{"message":"API rate limit exceeded"}`, ipc.CodeRateLimited, 429},
		// 5xx 全走 network_offline（不再走 default → 用户不再看到"服务器开小差"模糊文案）
		{500, `{"message":"Internal Server Error"}`, ipc.CodeNetworkOffline, 500},
		{502, `{"message":"Bad Gateway"}`, ipc.CodeNetworkOffline, 502},
		{503, `{"message":"Service Unavailable"}`, ipc.CodeNetworkOffline, 503},
		{504, `{"message":"Gateway Timeout"}`, ipc.CodeNetworkOffline, 504},
		// 418 Teapot 兜底：必须带 HTTPStatus + message 含状态码
		{418, `{"message":"I'm a teapot"}`, ipc.CodeGiteaError, 418},
	}

	for _, c := range cases {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(c.status)
			w.Write([]byte(c.body))
		}))

		adapter := NewGitHubAdapter()
		_, err := adapter.ListRepos(context.Background(), server.URL, "", "tok", platform.ListReposOpts{})
		server.Close()

		if err == nil {
			t.Errorf("status %d: expected error, got nil", c.status)
			continue
		}

		var ipcErr *ipc.IpcError
		if !errorsAs(err, &ipcErr) {
			t.Errorf("status %d: error is not *ipc.IpcError: %v", c.status, err)
			continue
		}
		if ipcErr.Code != c.wantCode {
			t.Errorf("status %d: code = %q, want %q", c.status, ipcErr.Code, c.wantCode)
		}
		// 关键断言：每个分支都必须带 HTTPStatus —— 前端 toast 才能显示具体码
		if ipcErr.HTTPStatus != c.wantStatus {
			t.Errorf(
				"status %d: HTTPStatus = %d, want %d (前端 toast 看不到具体码 = 用户体验差)",
				c.status, ipcErr.HTTPStatus, c.wantStatus,
			)
		}
		// 5xx message 应该提及"GitHub"，让用户知道是 GitHub 端的问题
		if c.status >= 500 && c.status <= 599 {
			if !strings.Contains(ipcErr.Message, "GitHub") {
				t.Errorf("status %d: 5xx message should mention GitHub, got %q", c.status, ipcErr.Message)
			}
		}
	}
}

// TestGitHubAdapter_MapHTTPError_DefaultIncludesStatus 单独验证 default 兜底带具体码
//
// 用户反馈 "服务器开小差：GitHub 返回错误" 完全看不到状态码。
// 期望：message 形如 "GitHub 返回 418"，HTTPStatus = 418，code = gitea_error
func TestGitHubAdapter_MapHTTPError_DefaultIncludesStatus(t *testing.T) {
	err := mapHTTPError(418, `{"message":"I'm a teapot"}`)
	if err == nil {
		t.Fatal("expected error")
	}
	var ipcErr *ipc.IpcError
	if !errorsAs(err, &ipcErr) {
		t.Fatalf("not IpcError: %v", err)
	}
	if ipcErr.HTTPStatus != 418 {
		t.Errorf("HTTPStatus = %d, want 418", ipcErr.HTTPStatus)
	}
	if !strings.Contains(ipcErr.Message, "418") {
		t.Errorf("message should contain 418, got %q", ipcErr.Message)
	}
	// 不能继续用写死的"GitHub 返回错误"——必须能区分 4xx 和 5xx
	if ipcErr.Message == "GitHub 返回错误" {
		t.Error("message 仍写死为 'GitHub 返回错误', 用户看不到具体状态码")
	}
}

// TestGitHubAdapter_MapHTTPError_5xxNotGiteaError 验证 5xx 不再走 default（不再被分类为 gitea_error）
//
// 用户原本看到 "服务器开小差：GitHub 返回错误"（category=gitea_error）。
// 现在 5xx 应该走 network_offline（category=网络问题），文案明确写"GitHub 服务暂不可用"。
func TestGitHubAdapter_MapHTTPError_5xxNotGiteaError(t *testing.T) {
	for _, status := range []int{500, 502, 503, 504} {
		err := mapHTTPError(status, "body")
		var ipcErr *ipc.IpcError
		if !errorsAs(err, &ipcErr) {
			t.Fatalf("status %d: not IpcError: %v", status, err)
		}
		if ipcErr.Code == ipc.CodeGiteaError {
			t.Errorf("status %d: 5xx 不应被归类为 gitea_error, code=%q", status, ipcErr.Code)
		}
		if ipcErr.Code != ipc.CodeNetworkOffline {
			t.Errorf("status %d: code=%q, want %q", status, ipcErr.Code, ipc.CodeNetworkOffline)
		}
	}
}

// ===== normalizeGitHubHostURL 测试（v2.x 修复 406 bug）=====
//
// 背景:app.go AuthConnect 旧版硬编码 https://github.com(网站 URL)
// → VerifyToken 拼成 https://github.com/user → 命中 GitHub 网站 HTML
// → 网站对 Accept: application/vnd.github+json 返 406 Not Acceptable
//
// 修复:所有 GitHub HTTP 请求前必须归一化成 https://api.github.com
func TestNormalizeGitHubHostURL(t *testing.T) {
	cases := []struct {
		input  string
		want   string
		whyWhy string
	}{
		{"", GitHubAPIBase, "空字符串 → API base"},
		{"https://github.com", GitHubAPIBase, "网站 URL → API(主修复)"},
		{"https://github.com/", GitHubAPIBase, "网站 URL 带 trailing slash → API"},
		{"https://github.com/anything", GitHubAPIBase, "网站 URL 带 path → API"},
		{"http://github.com", GitHubAPIBase, "http 网站 URL → API(不常见,做防御)"},
		{GitHubAPIBase, GitHubAPIBase, "已经是 API URL → 不变"},
		{"https://api.github.com/", GitHubAPIBase, "API URL 带 trailing slash → 不变"},
		// 自托管 GHES:保留 host,只 trim 末尾 slash(trim 空格但保留 path)
		{"https://github.acme.com", "https://github.acme.com", "自托管 GHES 保留 host"},
		{"  https://github.acme.com  ", "https://github.acme.com", "自托管 GHES trim 空格"},
		// 含前后空格
		{"  https://github.com  ", GitHubAPIBase, "前后空格 + 网站 URL → API"},
	}
	for _, c := range cases {
		got := normalizeGitHubHostURL(c.input)
		if got != c.want {
			t.Errorf("normalizeGitHubHostURL(%q) = %q, want %q (%s)", c.input, got, c.want, c.whyWhy)
		}
	}
}

// TestGitHubAdapter_VerifyToken_NormalizesHostURL 集成测试:
// 即使 caller 传错的 https://github.com(网站 URL),VerifyToken 也能归一化后正常走通
//
// 技巧:用自定义 Transport 把所有请求重定向到 httptest server,
// 让 server 接到归一化后的 /user 请求(从 Authorization 头里抓出 host 看)
func TestGitHubAdapter_VerifyToken_NormalizesHostURL(t *testing.T) {
	var capturedHost string
	var capturedPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHost = r.Host
		capturedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"id":1,"login":"octocat"}`)
	}))
	defer server.Close()

	adapter := &GitHubAdapter{
		httpClient: &http.Client{
			Transport: redirectToServerTransport{target: server.URL},
		},
	}

	// 故意传 https://github.com(网站 URL,触发归一化)
	_, err := adapter.VerifyToken(context.Background(), "https://github.com", "test-token")
	if err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}
	if capturedPath != "/user" {
		t.Errorf("path = %q, want /user", capturedPath)
	}
	// host 应该是归一化后的 api.github.com(虽然实际 transport 重定向到 httptest server)
	if capturedHost == "" {
		t.Error("host should not be empty")
	}
}

// redirectToServerTransport 把所有 HTTP 请求重定向到目标 server(用于集成测试)
// 只重写 Scheme + Host,path 不动
type redirectToServerTransport struct {
	target string // 形如 "http://127.0.0.1:xxxx"
}

func (t redirectToServerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	targetURL, err := url.Parse(t.target)
	if err != nil {
		return nil, err
	}
	req.URL.Scheme = targetURL.Scheme
	req.URL.Host = targetURL.Host
	return http.DefaultTransport.RoundTrip(req)
}

// TestGraphResultToDTO_PropagatesIsCommitted 验证 graphResultToDTO 把
// graph.GraphNode.IsCommitted / graph.GraphBranchLine.IsCommitted 透传到
// platform.GraphNodeDTO / platform.GraphBranchLineDTO（GitHub 适配器）。
//
// v3.x UNCOMMITTED 灰色虚线 lane 的端到端链路依赖该字段从 layout_vscode.go
// 一路传到前端；这个测试守住 platform → 上层 App 转换的入口。
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
					IsCommitted: false,
				},
				{
					X1: 0, Y1: 1, X2: 0, Y2: 2,
					IsCommitted: true,
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

// ===== Pull Request 测试（v0.6+ 完整功能）=====
//
// 覆盖：ListPulls / GetPull / MergePull / ClosePull / UpdatePullLabels /
//       mapMergeMethodToGitHub
//
// 设计原则（与 ListRepos 测试一致）：
//   - 用 httptest.NewServer 模拟 GitHub API
//   - 验证：路径、查询参数、鉴权头、HTTP method、请求 body、响应字段映射

// TestGitHubAdapter_ListPulls_Basic 验证路径 + state + 字段映射
func TestGitHubAdapter_ListPulls_Basic(t *testing.T) {
	var capturedListPath, capturedListQuery, capturedListMethod string
	var hitsIssuesEndpoint bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer ghp-test-token" {
			t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", auth)
		}

		// v0.6+ bugfix：GitHub 列表 API 实际响应不带 comments 字段
		// （仅在 GetPull 单 PR 详情或 GET /issues/{N} 有）。
		// 模拟真实行为：列表响应去掉 comments 字段。
		if r.URL.Path == "/repos/alice/dolphin/pulls" {
			capturedListPath = r.URL.Path
			capturedListMethod = r.Method
			capturedListQuery = r.URL.RawQuery
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{
					"number":     42,
					"title":      "feat: add dolphin loader",
					"state":      "open",
					"draft":      false,
					"merged":     false,
					"head":       map[string]string{"ref": "feature/dolphin", "sha": "abc1234"},
					"base":       map[string]string{"ref": "main", "sha": "def5678"},
					"user":       map[string]string{"login": "alice", "avatar_url": "https://github.com/alice.png"},
					"mergeable":  true,
					"created_at": "2024-06-01T00:00:00Z",
					"updated_at": "2024-06-02T00:00:00Z",
					"body":       "adds the spinning dolphin loader",
				},
			})
			return
		}

		// v0.6+ 补全流程：fillGitHubCommentsCount 调 GET /issues/{N} 拿 comments
		if r.URL.Path == "/repos/alice/dolphin/issues/42" {
			hitsIssuesEndpoint = true
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{"comments": 3})
			return
		}

		t.Errorf("unexpected path: %q", r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	pulls, err := adapter.ListPulls(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", platform.ListPullsOpts{
		State: "open",
		Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListPulls failed: %v", err)
	}

	if capturedListMethod != "GET" {
		t.Errorf("list method = %q, want GET", capturedListMethod)
	}
	if capturedListPath != "/repos/alice/dolphin/pulls" {
		t.Errorf("list path = %q, want /repos/alice/dolphin/pulls", capturedListPath)
	}
	if !strings.Contains(capturedListQuery, "state=open") {
		t.Errorf("list query = %q, want contains state=open", capturedListQuery)
	}

	if len(pulls) != 1 {
		t.Fatalf("len(pulls) = %d, want 1", len(pulls))
	}
	p := pulls[0]
	if p.Number != 42 || p.Index != 42 {
		t.Errorf("Number/Index = %d/%d, want 42/42", p.Number, p.Index)
	}
	if p.Title != "feat: add dolphin loader" {
		t.Errorf("Title = %q", p.Title)
	}
	if p.Head.Ref != "feature/dolphin" || p.Head.SHA != "abc1234" {
		t.Errorf("Head = %+v", p.Head)
	}
	if p.Base.Ref != "main" {
		t.Errorf("Base.Ref = %q", p.Base.Ref)
	}
	if p.Author == nil || p.Author.Username != "alice" {
		t.Errorf("Author = %+v", p.Author)
	}
	if !p.Mergeable || p.HasConflicts {
		t.Errorf("Mergeable/HasConflicts = %v/%v, want true/false", p.Mergeable, p.HasConflicts)
	}
	// v0.6+ bugfix：CommentsCount 来自 fillGitHubCommentsCount（GET /issues/{N}），
	// 不是直接来自列表响应
	if !hitsIssuesEndpoint {
		t.Error("fillGitHubCommentsCount 未调 GET /issues/42 拿 comments")
	}
	if p.CommentsCount != 3 {
		t.Errorf("CommentsCount = %d, want 3", p.CommentsCount)
	}
	if p.Body != "adds the spinning dolphin loader" {
		t.Errorf("Body = %q", p.Body)
	}
}

// TestGitHubAdapter_ListPulls_FillCommentsFailure 验证 issues 端点 500 时不中断主流程
func TestGitHubAdapter_ListPulls_FillCommentsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/alice/dolphin/pulls" {
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{
					"number": 42,
					"state":  "open",
					"head":   map[string]string{"ref": "f", "sha": "a"},
					"base":   map[string]string{"ref": "main", "sha": "b"},
				},
			})
			return
		}
		// issues 端点返 500
		if r.URL.Path == "/repos/alice/dolphin/issues/42" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		t.Errorf("unexpected: %q", r.URL.Path)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	pulls, err := adapter.ListPulls(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", platform.ListPullsOpts{State: "open"})
	if err != nil {
		t.Fatalf("ListPulls 不应被 issues 端点 500 中断: %v", err)
	}
	if len(pulls) != 1 {
		t.Fatalf("len(pulls) = %d, want 1", len(pulls))
	}
	// comments 补全失败，保留 0
	if pulls[0].CommentsCount != 0 {
		t.Errorf("CommentsCount = %d, want 0 （issues 端点 500）", pulls[0].CommentsCount)
	}
}

// TestGitHubAdapter_GetPull_Basic 验证单 PR 拉取
func TestGitHubAdapter_GetPull_Basic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/alice/dolphin/pulls/42" {
			t.Errorf("path = %q", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number":    42,
			"title":     "feat: dolphin",
			"state":     "open",
			"draft":     true,
			"head":      map[string]string{"ref": "feature/dolphin", "sha": "abc"},
			"base":      map[string]string{"ref": "main", "sha": "def"},
			"user":      map[string]string{"login": "alice"},
			"mergeable": false,
			"comments":  0,
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	p, err := adapter.GetPull(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if p.Number != 42 || !p.Draft {
		t.Errorf("Number/Draft = %d/%v", p.Number, p.Draft)
	}
	if p.Mergeable || !p.HasConflicts {
		t.Errorf("Mergeable/HasConflicts = %v/%v, want false/true", p.Mergeable, p.HasConflicts)
	}
}

// TestGitHubAdapter_MergePull_Basic 验证 PUT /pulls/{index}/merge + merge_method
func TestGitHubAdapter_MergePull_Basic(t *testing.T) {
	var capturedMethod, capturedPath string
	var capturedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/merge") && r.Method == "PUT":
			capturedMethod = r.Method
			capturedPath = r.URL.Path
			if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			// 合并成功后返回 sha + merged
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintln(w, `{"sha":"deadbeef00000000","merged":true,"message":"PR merged"}`)
		case strings.HasSuffix(r.URL.Path, "/pulls/42") && r.Method == "GET":
			// 后续 GetPull 拉详情
			json.NewEncoder(w).Encode(map[string]interface{}{
				"number": 42,
				"title":  "feat: dolphin",
				"state":  "closed",
				"merged": true,
				"head":   map[string]string{"ref": "feature/dolphin", "sha": "abc"},
				"base":   map[string]string{"ref": "main", "sha": "def"},
			})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.MergePull(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.MergePullOpts{
		Method:        "rebase-merge", // 应被映射成 "rebase"
		CommitMessage: "manual merge",
	})
	if err != nil {
		t.Fatalf("MergePull failed: %v", err)
	}
	if capturedMethod != "PUT" {
		t.Errorf("method = %q, want PUT", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/pulls/42/merge" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedBody["merge_method"] != "rebase" {
		t.Errorf("merge_method = %v, want rebase (rebase-merge 被映射)", capturedBody["merge_method"])
	}
	if capturedBody["commit_message"] != "manual merge" {
		t.Errorf("commit_message = %v", capturedBody["commit_message"])
	}
	if !d.Merged {
		t.Errorf("Merged = false, want true")
	}
	if d.MergeCommitSHA != "deadbeef00000000" {
		t.Errorf("MergeCommitSHA = %q, want deadbeef00000000", d.MergeCommitSHA)
	}
}

// TestGitHubAdapter_ClosePull_Basic 验证 PATCH /pulls/{index} state=closed
func TestGitHubAdapter_ClosePull_Basic(t *testing.T) {
	var capturedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			t.Errorf("method = %q, want PATCH", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number": 42,
			"state":  "closed",
			"merged": false,
			"head":   map[string]string{"ref": "feature/dolphin", "sha": "abc"},
			"base":   map[string]string{"ref": "main", "sha": "def"},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.ClosePull(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ClosePull failed: %v", err)
	}
	if capturedBody["state"] != "closed" {
		t.Errorf("state = %v, want closed", capturedBody["state"])
	}
	if d.State != "closed" {
		t.Errorf("returned State = %q, want closed", d.State)
	}
}

// TestGitHubAdapter_UpdatePullLabels_Basic 验证 PUT /issues/{index}/labels
func TestGitHubAdapter_UpdatePullLabels_Basic(t *testing.T) {
	var capturedPath, capturedMethod string
	var capturedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/alice/dolphin/issues/42/labels" && r.Method == "PUT" {
			capturedPath = r.URL.Path
			capturedMethod = r.Method
			if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			// 模拟 GitHub 返回的 PUT 响应（issue 视图）
			json.NewEncoder(w).Encode(map[string]interface{}{
				"number": 42,
				"head":   map[string]string{"ref": "feature/dolphin", "sha": "abc"},
				"base":   map[string]string{"ref": "main", "sha": "def"},
				"labels": []map[string]interface{}{
					{"id": 1, "name": "bug", "color": "f29513"},
				},
			})
			return
		}
		if r.URL.Path == "/repos/alice/dolphin/pulls/42" && r.Method == "GET" {
			// 后续 GetPull 拉完整 PR 详情
			json.NewEncoder(w).Encode(map[string]interface{}{
				"number": 42,
				"title":  "feat: dolphin",
				"state":  "open",
				"head":   map[string]string{"ref": "feature/dolphin", "sha": "abc"},
				"base":   map[string]string{"ref": "main", "sha": "def"},
				"labels": []map[string]interface{}{
					{"id": 1, "name": "bug", "color": "f29513"},
				},
			})
			return
		}
		t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.UpdatePullLabels(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, []string{"bug"})
	if err != nil {
		t.Fatalf("UpdatePullLabels failed: %v", err)
	}
	if capturedMethod != "PUT" {
		t.Errorf("method = %q, want PUT", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/issues/42/labels" {
		t.Errorf("path = %q", capturedPath)
	}
	labels, ok := capturedBody["labels"].([]interface{})
	if !ok || len(labels) != 1 || labels[0] != "bug" {
		t.Errorf("labels = %+v, want [bug]", capturedBody["labels"])
	}
	if len(d.Labels) != 1 || d.Labels[0].Name != "bug" {
		t.Errorf("returned Labels = %+v", d.Labels)
	}
}

// TestMapMergeMethodToGitHub 验证前端 MergeMethod → GitHub merge_method 映射
func TestMapMergeMethodToGitHub(t *testing.T) {
	cases := []struct {
		input, want string
	}{
		{"merge", "merge"},
		{"rebase", "rebase"},
		{"rebase-merge", "rebase"}, // GitHub 没区分，统一映射为 rebase
		{"squash", "squash"},
		{"", "merge"},          // 空 = 默认 merge
		{"unknown", "unknown"}, // 未知透传（让 GitHub API 返 422 给前端友好提示）
	}
	for _, c := range cases {
		got := mapMergeMethodToGitHub(c.input)
		if got != c.want {
			t.Errorf("mapMergeMethodToGitHub(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

// ===== PR 评论测试（v0.6+）=====
//
// 覆盖：ListPullComments / CreatePullComment / 空 body short-circuit / Bearer 鉴权

// TestGitHubAdapter_ListPullComments 验证路径 + Bearer + 字段映射
func TestGitHubAdapter_ListPullComments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/alice/dolphin/issues/42/comments" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer ghp-test-token" {
			t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", auth)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":         101,
				"body":       "lgtm",
				"user":       map[string]string{"login": "bob", "avatar_url": "https://github.com/bob.png"},
				"created_at": "2024-06-01T10:00:00Z",
				"updated_at": "2024-06-01T10:00:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullComments(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullComments failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].ID != 101 {
		t.Errorf("ID = %d, want 101", items[0].ID)
	}
	if items[0].Body != "lgtm" {
		t.Errorf("Body = %q", items[0].Body)
	}
	if items[0].Author == nil || items[0].Author.Username != "bob" {
		t.Errorf("Author = %+v", items[0].Author)
	}
	if items[0].CreatedAt != "2024-06-01T10:00:00Z" {
		t.Errorf("CreatedAt = %q", items[0].CreatedAt)
	}
}

// TestGitHubAdapter_CreatePullComment 验证 POST body + Bearer 鉴权
func TestGitHubAdapter_CreatePullComment(t *testing.T) {
	var capturedMethod, capturedPath string
	var capturedBody map[string]interface{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		if auth := r.Header.Get("Authorization"); auth != "Bearer ghp" {
			t.Errorf("Authorization = %q", auth)
		}
		// v0.6+ bugfix regression：验证 Content-Type 是 application/json
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&capturedBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         201,
			"body":       capturedBody["body"],
			"user":       map[string]string{"login": "alice"},
			"created_at": "2024-06-02T12:00:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.CreatePullComment(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, "+1")
	if err != nil {
		t.Fatalf("CreatePullComment failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/issues/42/comments" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedBody["body"] != "+1" {
		t.Errorf("body = %v, want '+1'", capturedBody["body"])
	}
	if d.ID != 201 || d.Body != "+1" {
		t.Errorf("d = %+v", d)
	}
}

// TestGitHubAdapter_CreatePullComment_EmptyBody 验证 short-circuit
func TestGitHubAdapter_CreatePullComment_EmptyBody(t *testing.T) {
	serverHit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.CreatePullComment(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, " \t\n ")
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

// TestGitHubAdapter_UpdatePullComment 验证 PATCH 路径 + Bearer + 字段映射
func TestGitHubAdapter_UpdatePullComment(t *testing.T) {
	var capturedMethod, capturedPath, capturedAuth string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         300,
			"body":       capturedBody["body"],
			"user":       map[string]interface{}{"login": "alice", "avatar_url": "https://github.com/alice.png", "id": 1},
			"created_at": "2024-06-01T10:00:00Z",
			"updated_at": "2024-06-03T09:00:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.UpdatePullComment(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 300, "Updated via v0.5")
	if err != nil {
		t.Fatalf("UpdatePullComment failed: %v", err)
	}
	if capturedMethod != "PATCH" {
		t.Errorf("method = %q, want PATCH", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/issues/comments/300" {
		t.Errorf("path = %q", capturedPath)
	}
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", capturedAuth)
	}
	if capturedBody["body"] != "Updated via v0.5" {
		t.Errorf("body = %v", capturedBody["body"])
	}
	if d.ID != 300 {
		t.Errorf("ID = %d, want 300", d.ID)
	}
	if d.UpdatedAt != "2024-06-03T09:00:00Z" {
		t.Errorf("UpdatedAt = %q", d.UpdatedAt)
	}
}

// TestGitHubAdapter_UpdatePullComment_EmptyBody 验证 short-circuit
func TestGitHubAdapter_UpdatePullComment_EmptyBody(t *testing.T) {
	serverHit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.UpdatePullComment(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 300, "   ")
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
		t.Error("server should not be hit for empty body")
	}
}

// TestGitHubAdapter_DeletePullComment 验证 DELETE 路径 + 204 No Content
func TestGitHubAdapter_DeletePullComment(t *testing.T) {
	var capturedMethod, capturedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	err := adapter.DeletePullComment(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 300)
	if err != nil {
		t.Fatalf("DeletePullComment failed: %v", err)
	}
	if capturedMethod != "DELETE" {
		t.Errorf("method = %q, want DELETE", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/issues/comments/300" {
		t.Errorf("path = %q", capturedPath)
	}
}

// TestGitHubAdapter_DeletePullComment_NotFound 验证 404 错误映射
func TestGitHubAdapter_DeletePullComment_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"message": "Not Found"})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	err := adapter.DeletePullComment(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 999)
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

// TestGitHubAdapter_ListPullCommentReactions 验证 GET + Bearer + content 字段（GitHub 字段名）
func TestGitHubAdapter_ListPullCommentReactions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/alice/dolphin/issues/comments/100/reactions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer ghp-test-token" {
			t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", auth)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":      5,
				"content": "+1",
				"user":    map[string]interface{}{"login": "alice", "avatar_url": "https://github.com/alice.png", "id": 1},
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullCommentReactions(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 100)
	if err != nil {
		t.Fatalf("ListPullCommentReactions failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].Content != "+1" {
		t.Errorf("Content = %q, want +1 (GitHub content 字段映射)", items[0].Content)
	}
	if items[0].User == nil || items[0].User.Username != "alice" {
		t.Errorf("User = %+v", items[0].User)
	}
}

// TestGitHubAdapter_AddPullCommentReaction 验证 POST + 白名单校验
func TestGitHubAdapter_AddPullCommentReaction(t *testing.T) {
	var capturedMethod string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":      20,
			"content": capturedBody["content"],
			"user":    map[string]interface{}{"login": "alice", "avatar_url": "https://github.com/alice.png"},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.AddPullCommentReaction(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 100, "hooray")
	if err != nil {
		t.Fatalf("AddPullCommentReaction failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedBody["content"] != "hooray" {
		t.Errorf("content = %v, want hooray", capturedBody["content"])
	}
	if d.ID != 20 || d.Content != "hooray" {
		t.Errorf("d = %+v", d)
	}
}

// TestGitHubAdapter_AddPullCommentReaction_InvalidContent 验证 content 白名单校验
func TestGitHubAdapter_AddPullCommentReaction_InvalidContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.AddPullCommentReaction(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 100, "invalid_emoji")
	if err == nil {
		t.Fatal("expected validation error for invalid reaction content")
	}
	var ipcErr *ipc.IpcError
	if !errors.As(err, &ipcErr) {
		t.Fatalf("expected *IpcError, got %T: %v", err, err)
	}
	if ipcErr.Code != ipc.CodeValidationFailed {
		t.Errorf("Code = %q, want %q", ipcErr.Code, ipc.CodeValidationFailed)
	}
}

// TestGitHubAdapter_RemovePullCommentReaction 验证 list + DELETE by reaction_id
func TestGitHubAdapter_RemovePullCommentReaction(t *testing.T) {
	var deletedID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "GET":
			// list reactions
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{"id": 30, "content": "+1", "user": map[string]interface{}{"login": "alice", "id": 1}},
				{"id": 31, "content": "heart", "user": map[string]interface{}{"login": "bob", "id": 2}},
			})
		case "DELETE":
			// DELETE /repos/.../reactions/{reaction_id}
			deletedID = r.URL.Path
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected method %q", r.Method)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	err := adapter.RemovePullCommentReaction(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 100, "+1")
	if err != nil {
		t.Fatalf("RemovePullCommentReaction failed: %v", err)
	}
	expectedDelPath := "/repos/alice/dolphin/issues/comments/100/reactions/30"
	if deletedID != expectedDelPath {
		t.Errorf("DELETE path = %q, want %q (deleted by reaction_id, not content)", deletedID, expectedDelPath)
	}
}

// ===== 合并请求评审测试（v0.5.0 M3） =====

// TestGitHubAdapter_ListPullReviews 验证 GET + Bearer + snake_case 字段
func TestGitHubAdapter_ListPullReviews(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/alice/dolphin/pulls/42/reviews" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer ghp-test-token" {
			t.Errorf("Authorization = %q, want 'Bearer ghp-test-token'", auth)
		}
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{
				"id":           70,
				"state":        "APPROVED",
				"body":         "Ship it!",
				"user":         map[string]interface{}{"login": "alice", "avatar_url": "https://github.com/alice.png"},
				"commit_id":    "def456",
				"submitted_at": "2024-06-06T10:00:00Z",
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullReviews(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullReviews failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].State != "approved" {
		t.Errorf("State = %q, want approved (GitHub 大写 state 必须归一化)", items[0].State)
	}
	if items[0].Body != "Ship it!" {
		t.Errorf("Body = %q", items[0].Body)
	}
	if items[0].SubmittedAt != "2024-06-06T10:00:00Z" {
		t.Errorf("SubmittedAt = %q (snake_case field mapping)", items[0].SubmittedAt)
	}
}

// TestGitHubAdapter_CreatePullReview_Approve 验证 POST + 大写 event 映射
func TestGitHubAdapter_CreatePullReview_Approve(t *testing.T) {
	var capturedMethod string
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":           80,
			"state":        "APPROVED",
			"body":         "Looks great",
			"user":         map[string]interface{}{"login": "alice"},
			"commit_id":    "abc123",
			"submitted_at": "2024-06-07T12:00:00Z",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	d, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Body:  "Looks great",
		Event: "approve",
	})
	if err != nil {
		t.Fatalf("CreatePullReview failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedBody["event"] != "APPROVE" {
		t.Errorf("event = %v, want APPROVE (GitHub uses uppercase)", capturedBody["event"])
	}
	if d.State != "approved" {
		t.Errorf("State = %q, want approved (归一化后)", d.State)
	}
}

// TestGitHubAdapter_ListPullReviews_UppercaseStates 验证 GitHub 真实 API
// 返回的 state 是大写（APPROVED / CHANGES_REQUESTED / COMMENTED / PENDING / DISMISSED），
// adapter 必须归一化到前端约定的小写 3 种值（approved / changes_requested / commented）。
// 字段名差异：GitHub 用 CHANGES_REQUESTED / COMMENTED,与 Gitea 的 REQUEST_CHANGES / COMMENT 都不一致。
func TestGitHubAdapter_ListPullReviews_UppercaseStates(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{"id": 1, "state": "APPROVED", "body": "LGTM", "user": map[string]interface{}{"login": "alice"}, "commit_id": "abc", "submitted_at": "2024-06-05T10:00:00Z"},
			{"id": 2, "state": "CHANGES_REQUESTED", "body": "改一下", "user": map[string]interface{}{"login": "bob"}, "commit_id": "abc", "submitted_at": "2024-06-05T11:00:00Z"},
			{"id": 3, "state": "COMMENTED", "body": "提个建议", "user": map[string]interface{}{"login": "carol"}, "commit_id": "abc", "submitted_at": "2024-06-05T12:00:00Z"},
			{"id": 4, "state": "PENDING", "body": "等人审", "user": map[string]interface{}{"login": "dave"}, "commit_id": "abc", "submitted_at": "2024-06-05T13:00:00Z"},
			{"id": 5, "state": "DISMISSED", "body": "撤回", "user": map[string]interface{}{"login": "eve"}, "commit_id": "abc", "submitted_at": "2024-06-05T14:00:00Z"},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullReviews(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullReviews failed: %v", err)
	}
	if len(items) != 5 {
		t.Fatalf("len(items) = %d, want 5", len(items))
	}
	want := []string{"approved", "changes_requested", "commented", "commented", "commented"}
	for i, w := range want {
		if items[i].State != w {
			t.Errorf("items[%d].State = %q, want %q (GitHub 大写 state 必须归一化)", i, items[i].State, w)
		}
	}
}

// TestGitHubAdapter_CreatePullReview_RequestChanges 验证 event request_changes → REQUEST_CHANGES
func TestGitHubAdapter_CreatePullReview_RequestChanges(t *testing.T) {
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id": 81, "state": "CHANGES_REQUESTED",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Body:  "Please fix line 42",
		Event: "request_changes",
	})
	if err != nil {
		t.Fatalf("CreatePullReview failed: %v", err)
	}
	if capturedBody["event"] != "REQUEST_CHANGES" {
		t.Errorf("event = %v, want REQUEST_CHANGES", capturedBody["event"])
	}
}

// TestGitHubAdapter_CreatePullReview_InvalidEvent 验证 event 校验
func TestGitHubAdapter_CreatePullReview_InvalidEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Event: "bad_event",
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

// TestGitHubAdapter_ListMembers 验证路径 + permissions 映射（v0.7.0 Phase 1 Task 1.2）
func TestGitHubAdapter_ListMembers(t *testing.T) {
	var capturedPath, capturedAuth string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		if r.URL.RawQuery != "per_page=100" {
			t.Errorf("query = %q, want per_page=100", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `[{"login":"alice","permissions":{"admin":false,"push":true,"maintain":false,"triage":false,"pull":true}},{"login":"bob","permissions":{"pull":true}},{"login":"carol","permissions":{"admin":true}}]`)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	members, err := adapter.ListMembers(context.Background(), server.URL, "alice", "ghp-test-token", "owner-x", "repo-y")
	if err != nil {
		t.Fatalf("ListMembers failed: %v", err)
	}

	if capturedPath != "/repos/owner-x/repo-y/collaborators" {
		t.Errorf("path = %q, want /repos/owner-x/repo-y/collaborators", capturedPath)
	}
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = [redacted], want 'Bearer ghp-test-token'")
	}
	if len(members) != 3 {
		t.Fatalf("len(members) = %d, want 3", len(members))
	}
	if members[0].Login != "alice" || members[0].Permission != "push" {
		t.Errorf("members[0] = %+v, want {Login:alice Permission:push}", members[0])
	}
	if members[1].Login != "bob" || members[1].Permission != "pull" {
		t.Errorf("members[1] = %+v, want {Login:bob Permission:pull}", members[1])
	}
	if members[2].Login != "carol" || members[2].Permission != "admin" {
		t.Errorf("members[2] = %+v, want {Login:carol Permission:admin}", members[2])
	}
}

// TestGitHubAdapter_ListMilestones 验证 state 参数 + 字段映射（v0.7.0 Phase 1 Task 1.3）
func TestGitHubAdapter_ListMilestones(t *testing.T) {
	// 测试 open/closed/all 三种 state
	for _, state := range []string{"open", "closed", "all"} {
		state := state
		t.Run("state="+state, func(t *testing.T) {
			var capturedPath, capturedQuery, capturedAuth string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				capturedPath = r.URL.Path
				capturedQuery = r.URL.RawQuery
				capturedAuth = r.Header.Get("Authorization")
				w.Header().Set("Content-Type", "application/json")
				if state == "open" {
					fmt.Fprintln(w, `[{"id":1,"title":"v1.0","state":"open","description":"First release"}]`)
				} else if state == "closed" {
					fmt.Fprintln(w, `[{"id":2,"title":"v0.9","state":"closed","description":"Beta"}]`)
				} else {
					fmt.Fprintln(w, `[{"id":3,"title":"Backlog","state":"open"}]`)
				}
			}))
			defer server.Close()

			adapter := NewGitHubAdapter()
			milestones, err := adapter.ListMilestones(context.Background(), server.URL, "alice", "ghp-test-token", "owner-x", "repo-y", state)
			if err != nil {
				t.Fatalf("ListMilestones(state=%q) failed: %v", state, err)
			}
			if capturedPath != "/repos/owner-x/repo-y/milestones" {
				t.Errorf("path = %q, want /repos/owner-x/repo-y/milestones", capturedPath)
			}
			if capturedAuth != "Bearer ghp-test-token" {
				t.Errorf("Authorization = [redacted], want 'Bearer ghp-test-token'")
			}
			wantQuery := "state=" + state + "&per_page=100"
			if capturedQuery != wantQuery {
				t.Errorf("query = %q, want %q", capturedQuery, wantQuery)
			}
			if len(milestones) != 1 {
				t.Fatalf("len(milestones) = %d, want 1", len(milestones))
			}
			m := milestones[0]
			if state == "open" {
				if m.ID != 1 || m.Title != "v1.0" || m.State != "open" {
					t.Errorf("milestone = %+v, want {ID:1 Title:v1.0 State:open}", m)
				}
			} else if state == "closed" {
				if m.ID != 2 || m.Title != "v0.9" || m.State != "closed" {
					t.Errorf("milestone = %+v, want {ID:2 Title:v0.9 State:closed}", m)
				}
			} else {
				if m.ID != 3 || m.Title != "Backlog" || m.State != "open" {
					t.Errorf("milestone = %+v, want {ID:3 Title:Backlog State:open}", m)
				}
			}
		})
	}

	// 默认 state=open
	t.Run("default-open", func(t *testing.T) {
		var capturedQuery string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			capturedQuery = r.URL.RawQuery
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintln(w, `[{"id":5,"title":"Sprint 1","state":"open"}]`)
		}))
		defer server.Close()
		adapter := NewGitHubAdapter()
		milestones, err := adapter.ListMilestones(context.Background(), server.URL, "alice", "ghp-test-token", "o", "r", "")
		if err != nil {
			t.Fatalf("ListMilestones(default) failed: %v", err)
		}
		if capturedQuery != "state=open&per_page=100" {
			t.Errorf("default query = %q, want state=open&per_page=100", capturedQuery)
		}
		if len(milestones) != 1 || milestones[0].Title != "Sprint 1" {
			t.Errorf("milestones[0] = %+v", milestones[0])
		}
	})
}

// TestGitHubAdapter_UpdatePullMilestone 验证清空场景（v0.7.0 Phase 1 Task 1.4）
func TestGitHubAdapter_UpdatePullMilestone(t *testing.T) {
	var capturedPath, capturedMethod string
	var patchHits int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/repos/alice/dolphin/issues/42" && r.Method == "PATCH" {
			patchHits++
			capturedPath = r.URL.Path
			capturedMethod = r.Method
			// 验证 body 中 milestone 是 null
			var body map[string]interface{}
			dec := json.NewDecoder(r.Body)
			_ = dec.Decode(&body)
			if ms, ok := body["milestone"]; !ok || ms != nil {
				t.Errorf("milestone = %v, want nil", body["milestone"])
			}
			// 204 No Content 即可，GetPull 会单独调
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// GetPull 调用：GET /repos/{owner}/{repo}/pulls/{index}
		if r.URL.Path == "/repos/alice/dolphin/pulls/42" && r.Method == "GET" {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"number":    42,
				"title":     "test",
				"state":     "open",
				"head":      map[string]string{"ref": "fix", "sha": "abc"},
				"base":      map[string]string{"ref": "main", "sha": "def"},
				"user":      map[string]string{"login": "alice"},
				"milestone": nil,
			})
			return
		}
		w.WriteHeader(400)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.UpdatePullMilestone(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42, "")
	if err != nil {
		t.Fatalf("UpdatePullMilestone(clear) failed: %v", err)
	}
	if patchHits != 1 {
		t.Errorf("patchHits = %d, want 1", patchHits)
	}
	if capturedPath != "/repos/alice/dolphin/issues/42" {
		t.Errorf("path = %q, want /repos/alice/dolphin/issues/42", capturedPath)
	}
	if capturedMethod != "PATCH" {
		t.Errorf("method = %q, want PATCH", capturedMethod)
	}
}

// TestGitHubAdapter_ListPullCommits 验证字段映射（v0.7.0 Phase 1 Task 1.5）
func TestGitHubAdapter_ListPullCommits(t *testing.T) {
	var capturedPath, capturedAuth string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `[
			{"sha":"abc123def456","commit":{"message":"feat: add dolphin\n\nImplement dolphin feature","author":{"name":"alice","email":"alice@example.com","date":"2024-06-01T00:00:00Z"},"committer":{"date":"2024-06-01T01:00:00Z"}}}
		]`)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	commits, err := adapter.ListPullCommits(context.Background(), server.URL, "alice", "ghp-test-token", "owner-x", "repo-y", 42)
	if err != nil {
		t.Fatalf("ListPullCommits failed: %v", err)
	}

	if capturedPath != "/repos/owner-x/repo-y/pulls/42/commits" {
		t.Errorf("path = %q, want /repos/owner-x/repo-y/pulls/42/commits", capturedPath)
	}
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = [redacted], want 'Bearer ghp-test-token'")
	}

	if len(commits) != 1 {
		t.Fatalf("len(commits) = %d, want 1", len(commits))
	}
	c := commits[0]
	if c.SHA != "abc123def456" || c.ShortSHA != "abc123def456" {
		t.Errorf("SHA = %q, want abc123def456", c.SHA)
	}
	if c.Subject != "feat: add dolphin" {
		t.Errorf("Subject = %q, want feat: add dolphin", c.Subject)
	}
	if c.AuthorName != "alice" || c.AuthorMail != "alice@example.com" {
		t.Errorf("Author = %q / %q, want alice / alice@example.com", c.AuthorName, c.AuthorMail)
	}
	if c.AuthoredAt != "2024-06-01T00:00:00Z" {
		t.Errorf("AuthoredAt = %q, want 2024-06-01T00:00:00Z", c.AuthoredAt)
	}
}

// TestGitHubAdapter_CreatePullReview_Comments 验证带行内评论的 CreatePullReview（v0.7.0 Task 2.4）
func TestGitHubAdapter_CreatePullReview_Comments(t *testing.T) {
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":    90,
			"state": "COMMENTED",
			"body":  "Review with inline",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Body:  "see inline",
		Event: "comment",
		Comments: []platform.CreateReviewCommentOpts{
			{Body: "fix this typo", Path: "src/main.go", Position: 42},
			{Body: "and here", Path: "src/util.go", Position: 17},
		},
	})
	if err != nil {
		t.Fatalf("CreatePullReview failed: %v", err)
	}

	// 验证 comments 字段被翻译为 GitHub API 格式（path/line/body）
	comments, ok := capturedBody["comments"].([]interface{})
	if !ok {
		t.Fatalf("comments field type = %T, want []interface{}", capturedBody["comments"])
	}
	if len(comments) != 2 {
		t.Fatalf("len(comments) = %d, want 2", len(comments))
	}
	c0 := comments[0].(map[string]interface{})
	if c0["path"] != "src/main.go" {
		t.Errorf("comments[0].path = %v, want src/main.go", c0["path"])
	}
	// JSON 把数字反序列化为 float64
	if c0["line"].(float64) != 42 {
		t.Errorf("comments[0].line = %v, want 42", c0["line"])
	}
	if c0["body"] != "fix this typo" {
		t.Errorf("comments[0].body = %v", c0["body"])
	}

	// 验证 event 也被翻译
	if capturedBody["event"] != "COMMENT" {
		t.Errorf("event = %v, want COMMENT", capturedBody["event"])
	}
}

// TestGitHubAdapter_CreatePullReview_NoComments 验证不传 comments 时传空数组
func TestGitHubAdapter_CreatePullReview_NoComments(t *testing.T) {
	var capturedBody map[string]interface{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&capturedBody)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"id": 91, "state": "APPROVED"})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	_, err := adapter.CreatePullReview(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42, platform.CreateReviewOpts{
		Body:  "LGTM",
		Event: "approve",
	})
	if err != nil {
		t.Fatalf("CreatePullReview failed: %v", err)
	}
	comments, ok := capturedBody["comments"].([]interface{})
	if !ok {
		t.Fatalf("comments field type = %T, want []interface{}", capturedBody["comments"])
	}
	if len(comments) != 0 {
		t.Errorf("len(comments) = %d, want 0", len(comments))
	}
}

// TestGitHubAdapter_GetPull_Milestone 验证 milestone 字段映射（v0.7.0 Task 2.3）
func TestGitHubAdapter_GetPull_Milestone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number":    42,
			"title":     "feat: dolphin",
			"state":     "open",
			"head":      map[string]string{"ref": "feature/dolphin", "sha": "abc"},
			"base":      map[string]string{"ref": "main", "sha": "def"},
			"user":      map[string]string{"login": "alice"},
			"mergeable": false,
			"milestone": map[string]interface{}{
				"number":      1,
				"title":       "v1.0",
				"state":       "open",
				"description": "First release",
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	p, err := adapter.GetPull(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if p.Milestone == nil {
		t.Fatal("Milestone = nil, want non-nil")
	}
	if p.Milestone.ID != 1 {
		t.Errorf("Milestone.ID = %d, want 1 (= GitHub number)", p.Milestone.ID)
	}
	if p.Milestone.Title != "v1.0" {
		t.Errorf("Milestone.Title = %q, want v1.0", p.Milestone.Title)
	}
	if p.Milestone.State != "open" {
		t.Errorf("Milestone.State = %q, want open", p.Milestone.State)
	}
}

// TestGitHubAdapter_GetPull_NoMilestone 验证未设 milestone 时为 nil
func TestGitHubAdapter_GetPull_NoMilestone(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number":    42,
			"title":     "feat: dolphin",
			"state":     "open",
			"head":      map[string]string{"ref": "feature/dolphin", "sha": "abc"},
			"base":      map[string]string{"ref": "main", "sha": "def"},
			"user":      map[string]string{"login": "alice"},
			"mergeable": false,
			"milestone": nil,
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	p, err := adapter.GetPull(context.Background(), server.URL, "alice", "ghp", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if p.Milestone != nil {
		t.Errorf("Milestone = %+v, want nil", p.Milestone)
	}
}

// TestGitHubAdapter_GetPull_RefLabel 验证 v0.7.28 修复：GitHub head.label
// 是 "owner:branch" 格式（不是完整 ref 路径），需要 split 拿 branch 名
//
// 根因：v0.7.9 写代码时注释错说"GitHub 端 label == ref（都是 refs/heads/main 路径）"，
// user 反馈 PR header 显示 "July-X:main" / "July-X:int-test-..." 把 owner 前缀
// 拼进去了。v0.7.28 加 githubRefLabel helper split(":") 拿 branch 部分。
func TestGitHubAdapter_GetPull_RefLabel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"number": 19,
			"title":  "int test",
			"state":  "closed",
			"head": map[string]interface{}{
				"label": "July-X:int-test-1782998094151278000", // owner:branch 格式
				"ref":   "int-test-1782998094151278000",        // 纯 branch 名
				"sha":   "aaa",
			},
			"base": map[string]interface{}{
				"label": "July-X:main", // owner:branch 格式
				"ref":   "main",        // 纯 branch 名
				"sha":   "bbb",
			},
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	pull, err := adapter.GetPull(context.Background(), server.URL, "alice", "ghp", "alice", "kanban-test", 19)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}

	// head label 应该是纯 branch 名（v0.7.28 修复：去 owner 前缀）
	if pull.Head.Label != "int-test-1782998094151278000" {
		t.Errorf("Head.Label = %q, want int-test-1782998094151278000 (v0.7.28 修复：去 owner 前缀)", pull.Head.Label)
	}
	if pull.Head.Ref != "int-test-1782998094151278000" {
		t.Errorf("Head.Ref = %q, want int-test-1782998094151278000", pull.Head.Ref)
	}

	// base label 应该是纯 branch 名
	if pull.Base.Label != "main" {
		t.Errorf("Base.Label = %q, want main (v0.7.28 修复：去 owner 前缀)", pull.Base.Label)
	}
	if pull.Base.Ref != "main" {
		t.Errorf("Base.Ref = %q, want main", pull.Base.Ref)
	}
}

// TestGitHubAdapter_RestorePullBranch 验证 v0.7.28 恢复 head 分支端点
// GitHub 端点跟 Gitea 一致：POST /repos/{owner}/{repo}/git/refs
// body {ref: "refs/heads/{branch}", sha: "..."}
func TestGitHubAdapter_RestorePullBranch(t *testing.T) {
	refsPath := "/repos/alice/dolphin/git/refs"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != refsPath || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body failed: %v", err)
		}
		if body["ref"] != "refs/heads/feature-branch" {
			t.Errorf("body.ref = %q, want refs/heads/feature-branch", body["ref"])
		}
		if body["sha"] != "abc123def" {
			t.Errorf("body.sha = %q, want abc123def", body["sha"])
		}
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"ref":"refs/heads/feature-branch","node_id":"...","url":"...","object":{"sha":"abc123def"}}`)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	if err := adapter.RestorePullBranch(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", "feature-branch", "abc123def"); err != nil {
		t.Errorf("RestorePullBranch failed: %v", err)
	}

	// 验证 validation
	if err := adapter.RestorePullBranch(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", "", "abc"); err == nil {
		t.Error("empty branch should fail validation")
	}
	if err := adapter.RestorePullBranch(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", "feature", ""); err == nil {
		t.Error("empty sha should fail validation")
	}
}

// TestGitHubAdapter_DeletePullBranch 验证 v0.7.29 "Delete branch" 按钮端点
// GitHub 走 DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}（路径里不带 refs/heads/ 前缀）
func TestGitHubAdapter_DeletePullBranch(t *testing.T) {
	expectedPath := "/repos/alice/dolphin/git/refs/heads/feature-branch"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != expectedPath || r.Method != "DELETE" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	if err := adapter.DeletePullBranch(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", "feature-branch"); err != nil {
		t.Errorf("DeletePullBranch failed: %v", err)
	}
	// 验证空 branch 走 validation
	if err := adapter.DeletePullBranch(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", ""); err == nil {
		t.Error("empty branch should fail validation")
	}
}

// TestGitHubAdapter_HeadRefRestored 验证 v0.7.29 head_ref_restored event 改独立
// type="restore_branch"（v0.7.27.1 用 type=delete_branch 兜底错的）
func TestGitHubAdapter_HeadRefRestored(t *testing.T) {
	item, ok := githubEventToTimelineItem(githubIssueEventRaw{
		ID:        1,
		Event:     "head_ref_restored",
		CreatedAt: "2024-06-05T10:00:00Z",
		Actor:     &githubUserRaw{Login: "alice"},
	})
	if !ok {
		t.Fatalf("head_ref_restored should be rendered")
	}
	if item.Type != "restore_branch" {
		t.Errorf("Type = %q, want restore_branch (v0.7.29 改独立 type，v0.7.27.1 用 delete_branch 兜底错的)", item.Type)
	}
}

// TestGitHubAdapter_GithubRefLabel 单元测 githubRefLabel helper
func TestGitHubAdapter_GithubRefLabel(t *testing.T) {
	tests := []struct {
		name  string
		label string
		ref   string
		want  string
	}{
		{"owner:branch", "July-X:int-test-178...", "int-test-178...", "int-test-178..."},
		{"branch only (no colon)", "main", "main", "main"},
		{"empty label, ref fallback", "", "main", "main"},
		{"multi-colon (defensive)", "owner:sub:branch", "branch", "branch"},
		{"empty label and ref", "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := githubRefLabel(tt.label, tt.ref)
			if got != tt.want {
				t.Errorf("githubRefLabel(%q, %q) = %q, want %q", tt.label, tt.ref, got, tt.want)
			}
		})
	}
}

// TestGitHubAdapter_UploadIssueAttachment 验证 multipart/form-data 上传到
// POST /repos/{owner}/{repo}/issues/{issue_number}/assets。form field 必须是 'file'
// （与 Gitea 的 'attachment' 不同——adapter 层翻译）。
//
// 回归证据：v0.7.0 之前 PR 评论贴图走前端 FileReader.readAsDataURL 转 data URI，
// GitHub 不存图片（其实 GitHub 也不渲染 data: URI 引用）。
// 修复后走这条上传到 GitHub 的 attachments 表，markdown 引用真 url。
func TestGitHubAdapter_UploadIssueAttachment(t *testing.T) {
	const fakePng = "fake-png-bytes-v0.7.0-github"
	var capturedMethod, capturedPath, capturedContentType, capturedAuth string
	var capturedFormField, capturedFileName string
	var capturedFileContent []byte
	_ = capturedFileName // 保留作调试用
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedMethod = r.Method
		capturedPath = r.URL.Path
		capturedContentType = r.Header.Get("Content-Type")
		capturedAuth = r.Header.Get("Authorization")
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
			if part.FormName() == "file" {
				capturedFormField = "file"
				capturedFileName = part.FileName()
				buf, _ := io.ReadAll(part)
				capturedFileContent = buf
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":                   99,
			"name":                 "screenshot.png",
			"size":                 len(fakePng),
			"uuid":                 "github-uuid-xyz",
			"browser_download_url": "https://github-cloud.s3.amazonaws.com/screenshot.png",
		})
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	dto, err := adapter.UploadIssueAttachment(
		context.Background(),
		server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42,
		"screenshot.png", []byte(fakePng),
	)
	if err != nil {
		t.Fatalf("UploadIssueAttachment failed: %v", err)
	}
	if capturedMethod != "POST" {
		t.Errorf("method = %q, want POST", capturedMethod)
	}
	if capturedPath != "/repos/alice/dolphin/issues/42/assets" {
		t.Errorf("path = %q, want /repos/alice/dolphin/issues/42/assets", capturedPath)
	}
	if capturedAuth != "Bearer ghp-test-token" {
		t.Errorf("Authorization = [redacted], want 'Bearer ghp-test-token'")
	}
	if !strings.HasPrefix(capturedContentType, "multipart/form-data; boundary=") {
		t.Errorf("Content-Type = %q, want multipart/form-data; boundary=...", capturedContentType)
	}
	if capturedFormField != "file" {
		t.Errorf("form field = %q, want 'file' (GitHub 端点用 'file'，与 Gitea 'attachment' 不同)", capturedFormField)
	}
	if string(capturedFileContent) != fakePng {
		t.Errorf("file content mismatch")
	}
	if dto.BrowserDownloadURL == "" {
		t.Errorf("BrowserDownloadURL should not be empty")
	}
}

// TestGitHubAdapter_ListPullTimeline_CommentAndReview 验证 GitHub timeline 组合
// v0.7.26 根因修复：之前 ListPullTimeline 返 ErrNotSupported 导致评论全丢
// 现改为组合 ListPullComments + ListPullReviews，按时间倒序合并
func TestGitHubAdapter_ListPullTimeline_CommentAndReview(t *testing.T) {
	commentsPath := "/repos/alice/dolphin/issues/42/comments"
	reviewsPath := "/repos/alice/dolphin/pulls/42/reviews"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case commentsPath:
			// 3 条评论：2024-06-05 09:00 / 11:30 / 14:00
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{"id": 101, "body": "first comment", "user": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T09:00:00Z", "updated_at": "2024-06-05T09:00:00Z"},
				{"id": 102, "body": "second comment", "user": map[string]interface{}{"login": "bob"}, "created_at": "2024-06-05T11:30:00Z", "updated_at": "2024-06-05T11:30:00Z"},
				{"id": 103, "body": "third comment", "user": map[string]interface{}{"login": "carol"}, "created_at": "2024-06-05T14:00:00Z", "updated_at": "2024-06-05T14:00:00Z"},
			})
		case reviewsPath:
			// 2 条评审：2024-06-05 10:00 (APPROVED) / 13:00 (CHANGES_REQUESTED)
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{"id": 201, "state": "APPROVED", "body": "LGTM", "user": map[string]interface{}{"login": "dave"}, "commit_id": "abc", "submitted_at": "2024-06-05T10:00:00Z"},
				{"id": 202, "state": "CHANGES_REQUESTED", "body": "fix this", "user": map[string]interface{}{"login": "eve"}, "commit_id": "def", "submitted_at": "2024-06-05T13:00:00Z"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 5 {
		t.Fatalf("len(items) = %d, want 5 (3 comment + 2 review)", len(items))
	}

	// v0.7.33 验证按时间升序（对齐 GitHub web PR timeline 实际渲染顺序）：
	// 09:00 first comment → 10:00 LGTM → 11:30 second comment → 13:00 fix this → 14:00 third comment
	wantOrder := []struct {
		Type      string
		Body      string
		CreatedAt string
		State     string
	}{
		{"comment", "first comment", "2024-06-05T09:00:00Z", ""},
		{"review", "LGTM", "2024-06-05T10:00:00Z", "approved"},
		{"comment", "second comment", "2024-06-05T11:30:00Z", ""},
		{"review", "fix this", "2024-06-05T13:00:00Z", "changes_requested"},
		{"comment", "third comment", "2024-06-05T14:00:00Z", ""},
	}
	for i, w := range wantOrder {
		if items[i].Type != w.Type {
			t.Errorf("items[%d].Type = %q, want %q", i, items[i].Type, w.Type)
		}
		if items[i].Body != w.Body {
			t.Errorf("items[%d].Body = %q, want %q", i, items[i].Body, w.Body)
		}
		if items[i].Created != w.CreatedAt {
			t.Errorf("items[%d].Created = %q, want %q", i, items[i].Created, w.CreatedAt)
		}
		if w.State != "" && items[i].State != w.State {
			t.Errorf("items[%d].State = %q, want %q (GitHub 大写 state 必须归一化)", i, items[i].State, w.State)
		}
	}

	// 验证 comment items 带 author
	for _, it := range items {
		if it.Type == "comment" && (it.Author == nil || it.Author.Username == "") {
			t.Errorf("comment item 缺 author: id=%d", it.ID)
		}
		if it.Type == "review" && (it.Author == nil || it.Author.Username == "") {
			t.Errorf("review item 缺 author: id=%d", it.ID)
		}
	}
}

// TestGitHubAdapter_ListPullTimeline_EmptyCase 验证评论和评审都为空时返空 slice（不返 nil）
func TestGitHubAdapter_ListPullTimeline_EmptyCase(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[]")
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if items == nil {
		t.Errorf("ListPullTimeline should return empty slice, not nil (前端 range 会 panic)")
	}
	if len(items) != 0 {
		t.Errorf("len(items) = %d, want 0", len(items))
	}
}

// TestGitHubAdapter_ListPullTimeline_CommentsFailureFallback 验证评论接口失败时，
// 不阻断评审拉取（fallback 单边容错）
func TestGitHubAdapter_ListPullTimeline_CommentsFailureFallback(t *testing.T) {
	reviewsPath := "/repos/alice/dolphin/pulls/42/reviews"
	commentsPath := "/repos/alice/dolphin/issues/42/comments"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case commentsPath:
			http.Error(w, "internal server error", http.StatusInternalServerError)
		case reviewsPath:
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `[{"id": 1, "state": "APPROVED", "body": "ok", "user": {"login": "alice"}, "commit_id": "x", "submitted_at": "2024-06-05T10:00:00Z"}]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline 应该在评论失败时仍返评审列表: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("len(items) = %d, want 1 (评论失败 fallback 到评审)", len(items))
	}
	if items[0].Type != "review" {
		t.Errorf("items[0].Type = %q, want review", items[0].Type)
	}
}

// ============== v0.7.27 GitHub Issue Events API 集成测试 ==============
//
// v0.7.27 根因修复：v0.7.26 follow-up 注释错误地认为"GitHub REST v3 没对等
// /timeline 聚合端点"，导致 PR 系统事件（labeled / assigned / closed / merged /
// renamed / head_ref_deleted / cross-referenced 等）全不显示。
// 实际 GitHub 公开的 Issue Events API（GET /repos/{owner}/{repo}/issues/{number}/events）
// 就是 PR timeline 事件来源，本测试组覆盖端到端集成。

// TestGitHubAdapter_ListPullTimeline_IssueEvents 验证完整事件流：
// comments + reviews + Issue Events 三端点组合 + event type 映射
//
//	labeled → label (LabelAction=add)
//	unlabeled → label (LabelAction=remove)
//	assigned → assignees (RemovedAssignee=false)
//	closed (无 commit_id) → close
//	closed (有 commit_id) → merge
//	reopened → reopen
//	renamed → change_title
//	head_ref_deleted → delete_branch
//	review_requested → review_request
//	cross-referenced → pull_ref (RefAction=cross)
//	pinned → pin
//	locked → lock
//
// 不渲染：mentioned / subscribed / commented / reviewed（评论和评审已走其他端点）
func TestGitHubAdapter_ListPullTimeline_IssueEvents(t *testing.T) {
	commentsPath := "/repos/alice/dolphin/issues/42/comments"
	reviewsPath := "/repos/alice/dolphin/pulls/42/reviews"
	eventsPath := "/repos/alice/dolphin/issues/42/events"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case commentsPath:
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{"id": 101, "body": "comment 1", "user": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T09:00:00Z", "updated_at": "2024-06-05T09:00:00Z"},
			})
		case reviewsPath:
			json.NewEncoder(w).Encode([]map[string]interface{}{
				{"id": 201, "state": "APPROVED", "body": "LGTM", "user": map[string]interface{}{"login": "dave"}, "commit_id": "abc", "submitted_at": "2024-06-05T10:00:00Z"},
			})
		case eventsPath:
			// 13 个 events：12 个渲染 + 1 个不渲染 (mentioned)
			json.NewEncoder(w).Encode([]map[string]interface{}{
				// 不渲染类型测试
				{"id": 301, "event": "mentioned", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:00:00Z"},
				{"id": 302, "event": "subscribed", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:00:00Z"},
				{"id": 303, "event": "commented", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:00:00Z"},
				// 渲染类型
				{"id": 304, "event": "locked", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:30:00Z"},
				{"id": 305, "event": "assigned", "actor": map[string]interface{}{"login": "alice"}, "assignee": map[string]interface{}{"login": "bob"}, "created_at": "2024-06-05T08:35:00Z"},
				{"id": 306, "event": "head_ref_deleted", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:40:00Z", "commit_id": "feature-branch-123"},
				{"id": 307, "event": "review_requested", "actor": map[string]interface{}{"login": "alice"}, "assignee": map[string]interface{}{"login": "carol"}, "created_at": "2024-06-05T08:45:00Z"},
				{"id": 308, "event": "cross-referenced", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T08:50:00Z", "source": map[string]interface{}{"type": "pull_request", "issue": map[string]interface{}{"number": 10, "title": "other PR", "state": "open"}}},
				{"id": 309, "event": "labeled", "actor": map[string]interface{}{"login": "alice"}, "label": map[string]interface{}{"name": "bug", "color": "f29513"}, "created_at": "2024-06-05T08:55:00Z"},
				{"id": 310, "event": "renamed", "actor": map[string]interface{}{"login": "alice"}, "rename": map[string]interface{}{"from": "old title", "to": "new title"}, "created_at": "2024-06-05T11:00:00Z"},
				{"id": 311, "event": "closed", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T12:00:00Z"},
				{"id": 312, "event": "reopened", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T13:00:00Z"},
				{"id": 313, "event": "merged", "actor": map[string]interface{}{"login": "alice"}, "commit_id": "merge-sha-abc123", "created_at": "2024-06-05T14:00:00Z"},
				{"id": 314, "event": "pinned", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T15:00:00Z"},
				{"id": 315, "event": "unlabeled", "actor": map[string]interface{}{"login": "alice"}, "label": map[string]interface{}{"name": "bug", "color": "f29513"}, "created_at": "2024-06-05T16:00:00Z"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	// 期望：1 comment + 1 review + 12 个 events (15 events - 3 不渲染 mentioned/subscribed/commented)
	expectedTotal := 14
	if len(items) != expectedTotal {
		t.Fatalf("len(items) = %d, want %d", len(items), expectedTotal)
	}

	// v0.7.33 验证按时间升序（对齐 GitHub web PR timeline 实际渲染顺序）：
	// 08:30 locked → 08:35 assigned → 08:40 head_ref_deleted → 08:45 review_requested →
	// 08:50 cross-referenced → 08:55 labeled → 09:00 comment → 10:00 review →
	// 11:00 renamed → 12:00 closed → 13:00 reopened → 14:00 closed+commit_id (merge) →
	// 15:00 pinned → 16:00 unlabeled
	wantOrder := []struct {
		Type string
	}{
		{"lock"},           // 08:30 locked
		{"assignees"},      // 08:35 assigned
		{"delete_branch"},  // 08:40 head_ref_deleted
		{"review_request"}, // 08:45 review_requested
		{"pull_ref"},       // 08:50 cross-referenced
		{"label"},          // 08:55 labeled
		{"comment"},        // 09:00 comment
		{"review"},         // 10:00 review
		{"change_title"},   // 11:00 renamed
		{"close"},          // 12:00 closed (no commit_id)
		{"reopen"},         // 13:00 reopened
		{"merge"},          // 14:00 closed+commit_id → merge
		{"pin"},            // 15:00 pinned
		{"label"},          // 16:00 unlabeled → label
	}
	for i, w := range wantOrder {
		if items[i].Type != w.Type {
			t.Errorf("items[%d].Type = %q, want %q (created=%s)", i, items[i].Type, w.Type, items[i].Created)
		}
	}

	// 验证特定字段（v0.7.33 索引按升序更新）
	// unlabeled (16:00): LabelAction=remove, RemovedLabels=[bug] → items[13]
	if items[13].LabelAction != "remove" {
		t.Errorf("items[13] (unlabeled).LabelAction = %q, want remove", items[13].LabelAction)
	}
	if len(items[13].RemovedLabels) != 1 || items[13].RemovedLabels[0].Name != "bug" {
		t.Errorf("items[13] (unlabeled) RemovedLabels = %+v, want [bug]", items[13].RemovedLabels)
	}

	// closed+commit_id (14:00): Type=merge, CommitID=merge-sha-abc123 → items[11]
	mergeItem := items[11]
	if mergeItem.Type != "merge" || mergeItem.CommitID != "merge-sha-abc123" {
		t.Errorf("merge item = Type=%q, CommitID=%q, want Type=merge, CommitID=merge-sha-abc123",
			mergeItem.Type, mergeItem.CommitID)
	}

	// renamed (11:00): OldTitle=old title, NewTitle=new title → items[8]
	renamedItem := items[8]
	if renamedItem.OldTitle != "old title" || renamedItem.NewTitle != "new title" {
		t.Errorf("renamed item = OldTitle=%q, NewTitle=%q, want old title / new title",
			renamedItem.OldTitle, renamedItem.NewTitle)
	}

	// labeled (08:55): LabelAction=add, AddedLabels=[bug] → items[5]
	labeledItem := items[5]
	if labeledItem.LabelAction != "add" {
		t.Errorf("labeled item LabelAction = %q, want add", labeledItem.LabelAction)
	}
	if len(labeledItem.AddedLabels) != 1 || labeledItem.AddedLabels[0].Name != "bug" {
		t.Errorf("labeled item AddedLabels = %+v, want [bug]", labeledItem.AddedLabels)
	}

	// cross-referenced (08:50): Type=pull_ref, RefAction=cross, RefIssue.Number=10 → items[4]
	crossItem := items[4]
	if crossItem.Type != "pull_ref" {
		t.Errorf("cross-ref item Type = %q, want pull_ref", crossItem.Type)
	}
	if crossItem.RefAction != "cross" {
		t.Errorf("cross-ref item RefAction = %q, want cross", crossItem.RefAction)
	}
	if crossItem.RefIssue == nil || crossItem.RefIssue.Index != 10 {
		t.Errorf("cross-ref item RefIssue = %+v, want Index=10", crossItem.RefIssue)
	}

	// review_requested (08:45): Assignee.Username=carol → items[3]
	reviewReqItem := items[3]
	if reviewReqItem.Assignee == nil || reviewReqItem.Assignee.Username != "carol" {
		t.Errorf("review_request item Assignee = %+v, want Username=carol", reviewReqItem.Assignee)
	}
	if reviewReqItem.RemovedAssignee {
		t.Errorf("review_request item RemovedAssignee = true, want false")
	}

	// head_ref_deleted (08:40): OldRef="" (v0.7.27.1 修正) → items[2]
	deleteItem := items[2]
	if deleteItem.OldRef != "" {
		t.Errorf("head_ref_deleted item OldRef = %q, want empty (v0.7.27.1 修复)", deleteItem.OldRef)
	}

	// assigned (08:35): Assignee.Username=bob, RemovedAssignee=false → items[1]
	assignItem := items[1]
	if assignItem.Assignee == nil || assignItem.Assignee.Username != "bob" {
		t.Errorf("assigned item Assignee = %+v, want Username=bob", assignItem.Assignee)
	}
	if assignItem.RemovedAssignee {
		t.Errorf("assigned item RemovedAssignee = true, want false")
	}
}

// TestGitHubAdapter_ListPullTimeline_EventsFailureFallback 验证 events 端点失败时
// 不阻断评论+评审（单边容错）
func TestGitHubAdapter_ListPullTimeline_EventsFailureFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice/dolphin/issues/42/comments":
			fmt.Fprint(w, `[{"id": 1, "body": "c", "user": {"login": "alice"}, "created_at": "2024-06-05T09:00:00Z", "updated_at": "2024-06-05T09:00:00Z"}]`)
		case "/repos/alice/dolphin/pulls/42/reviews":
			fmt.Fprint(w, `[{"id": 1, "state": "APPROVED", "body": "ok", "user": {"login": "dave"}, "commit_id": "x", "submitted_at": "2024-06-05T10:00:00Z"}]`)
		case "/repos/alice/dolphin/issues/42/events":
			http.Error(w, "internal server error", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline 不应在 events 失败时中断: %v", err)
	}
	if len(items) != 2 {
		t.Errorf("len(items) = %d, want 2 (评论+评审 fallback)", len(items))
	}
}

// TestGitHubAdapter_ListPullTimeline_RenamedWipToggle 验证 GitHub renamed 事件
// 命中 WIP toggle 检测（前端走"已将合并请求标记为进行中" / "可评审"特殊渲染）
func TestGitHubAdapter_ListPullTimeline_RenamedWipToggle(t *testing.T) {
	// 单元测 githubEventToTimelineItem 转换函数，不走 HTTP server

	// 单元测 githubEventToTimelineItem 转换函数
	// case 1: 加 WIP: 前缀 → IsWipToggle=true, IsWip=true
	item, ok := githubEventToTimelineItem(githubIssueEventRaw{
		ID:        1,
		Event:     "renamed",
		CreatedAt: "2024-06-05T10:00:00Z",
		Rename: &struct {
			From string `json:"from"`
			To   string `json:"to"`
		}{From: "fix bug", To: "WIP: fix bug"},
	})
	if !ok {
		t.Fatalf("renamed event should be rendered")
	}
	if !item.IsWipToggle {
		t.Errorf("IsWipToggle = false, want true (加了 WIP: 前缀)")
	}
	if !item.IsWip {
		t.Errorf("IsWip = false, want true (NewTitle 有 WIP: 前缀)")
	}

	// case 2: 去 WIP: 前缀 → IsWipToggle=true, IsWip=false
	item, ok = githubEventToTimelineItem(githubIssueEventRaw{
		ID:        2,
		Event:     "renamed",
		CreatedAt: "2024-06-05T10:00:00Z",
		Rename: &struct {
			From string `json:"from"`
			To   string `json:"to"`
		}{From: "WIP: fix bug", To: "fix bug"},
	})
	if !ok {
		t.Fatalf("renamed event should be rendered")
	}
	if !item.IsWipToggle {
		t.Errorf("IsWipToggle = false, want true (去 WIP: 前缀)")
	}
	if item.IsWip {
		t.Errorf("IsWip = true, want false (NewTitle 无 WIP: 前缀)")
	}

	// case 3: 普通标题修改 → IsWipToggle=false
	item, ok = githubEventToTimelineItem(githubIssueEventRaw{
		ID:        3,
		Event:     "renamed",
		CreatedAt: "2024-06-05T10:00:00Z",
		Rename: &struct {
			From string `json:"from"`
			To   string `json:"to"`
		}{From: "fix bug", To: "fix bug 2"},
	})
	if !ok {
		t.Fatalf("renamed event should be rendered")
	}
	if item.IsWipToggle {
		t.Errorf("IsWipToggle = true, want false (普通标题修改)")
	}
}

// TestGitHubAdapter_ListPullTimeline_NotRenderedEventTypes 验证不渲染 event 类型
// （commented / reviewed / mentioned / subscribed / converted_to_discussion 等）
// 都跳过，timeline 数组不包含这些 item
func TestGitHubAdapter_ListPullTimeline_NotRenderedEventTypes(t *testing.T) {
	// 单元测转换函数：所有不渲染 event 返回 (zero, false)
	notRendered := []string{
		"commented", "reviewed", "mentioned", "subscribed", "unsubscribed",
		"converted_to_discussion", "marked_as_duplicate", "unmarked_as_duplicate",
		"transferred", "added_to_project", "moved_columns_in_project",
		"removed_from_project",
	}
	for _, evt := range notRendered {
		t.Run(evt, func(t *testing.T) {
			_, ok := githubEventToTimelineItem(githubIssueEventRaw{
				ID:        1,
				Event:     evt,
				CreatedAt: "2024-06-05T10:00:00Z",
			})
			if ok {
				t.Errorf("event %q should NOT be rendered (returns false)", evt)
			}
		})
	}
}

// ============== v0.7.27.1 GitHub Issue Events 补全测试 ==============
//
// v0.7.27 漏了 6 个 event type：
//   - `merged`（独立 event，不是 closed+commit_id 推断）
//   - `committed`（push 事件，GitHub 端独立 event）
//   - `head_ref_force_pushed`（强制推送）
//   - `head_ref_deleted`（v0.7.27 用 commit SHA 填 OldRef 是错的）
//   - `base_ref_changed`（改 base branch）
//   - `ready_for_review` / `convert_to_draft`（draft 状态切换）
// 补全测试覆盖。

// TestGitHubAdapter_ListPullTimeline_MergedAndPush 验证：
//   - `merged` 独立 event（v0.7.27.1 修正，不再用 closed 推断）→ type=merge + CommitID=真实 merge SHA
//   - `closed` event 没有 commit_id 推断逻辑（v0.7.27 错逻辑已删）→ type=close
//   - `committed` event（push 提交）→ type=push + CommitIDs=[commit_id] 单元素数组
//   - `head_ref_force_pushed` event（强制 push）→ type=push + IsForcePush=true + CommitIDs=[commit_id]
func TestGitHubAdapter_ListPullTimeline_MergedAndPush(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice/dolphin/issues/42/comments":
			fmt.Fprint(w, "[]")
		case "/repos/alice/dolphin/pulls/42/reviews":
			fmt.Fprint(w, "[]")
		case "/repos/alice/dolphin/issues/42/events":
			json.NewEncoder(w).Encode([]map[string]interface{}{
				// 关闭但没合并（commit_id 应该不被当作 merge 触发）
				{"id": 401, "event": "closed", "actor": map[string]interface{}{"login": "alice"}, "created_at": "2024-06-05T10:00:00Z"},
				// 独立 merge event（commit_id 是真实 merge commit SHA）
				{"id": 402, "event": "merged", "actor": map[string]interface{}{"login": "alice"}, "commit_id": "merge-sha-real-abc123def456", "created_at": "2024-06-05T11:00:00Z"},
				// push 事件（committed）
				{"id": 403, "event": "committed", "actor": map[string]interface{}{"login": "alice"}, "commit_id": "push-commit-sha-xyz789", "created_at": "2024-06-05T12:00:00Z"},
				// 强制 push（head_ref_force_pushed）
				{"id": 404, "event": "head_ref_force_pushed", "actor": map[string]interface{}{"login": "alice"}, "commit_id": "force-push-sha-987xyz", "created_at": "2024-06-05T13:00:00Z"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	adapter := NewGitHubAdapter()
	items, err := adapter.ListPullTimeline(context.Background(), server.URL, "alice", "ghp-test-token", "alice", "dolphin", 42)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	if len(items) != 4 {
		t.Fatalf("len(items) = %d, want 4", len(items))
	}

	// 时间升序（v0.7.33 改）：10:00 close → 11:00 merge → 12:00 push → 13:00 force push
	// 对齐 GitHub web PR timeline 实际渲染顺序（first 最早，last 最新）。
	if items[0].Type != "close" {
		t.Errorf("items[0] Type=%q IsForcePush=%v, want close", items[0].Type, items[0].IsForcePush)
	}
	if items[0].IsForcePush {
		t.Errorf("items[0] IsForcePush=true, want false")
	}
	if items[1].Type != "merge" || items[1].CommitID != "merge-sha-real-abc123def456" {
		t.Errorf("items[1] Type=%q CommitID=%q, want merge+merge-sha-real-abc123def456", items[1].Type, items[1].CommitID)
	}
	if items[2].Type != "push" || items[2].IsForcePush || len(items[2].CommitIDs) != 1 || items[2].CommitIDs[0] != "push-commit-sha-xyz789" {
		t.Errorf("items[2] Type=%q IsForcePush=%v CommitIDs=%v, want push+false+[push-commit-sha-xyz789]", items[2].Type, items[2].IsForcePush, items[2].CommitIDs)
	}
	if items[3].Type != "push" || !items[3].IsForcePush || len(items[3].CommitIDs) != 1 || items[3].CommitIDs[0] != "force-push-sha-987xyz" {
		t.Errorf("items[3] Type=%q IsForcePush=%v CommitIDs=%v, want push+true+[force-push-sha-987xyz]", items[3].Type, items[3].IsForcePush, items[3].CommitIDs)
	}
}

// TestGitHubAdapter_ListPullTimeline_HeadRefDeletedFix 验证 v0.7.27.1 修复：
// head_ref_deleted event **不**填 OldRef（v0.7.27 错把 commit SHA 当 branch name）
func TestGitHubAdapter_ListPullTimeline_HeadRefDeletedFix(t *testing.T) {
	item, ok := githubEventToTimelineItem(githubIssueEventRaw{
		ID:        1,
		Event:     "head_ref_deleted",
		CreatedAt: "2024-06-05T10:00:00Z",
		CommitID:  "d52a39c-deadbeef-1234-5678-abcdef",
		Actor:     &githubUserRaw{Login: "alice"},
	})
	if !ok {
		t.Fatalf("head_ref_deleted should be rendered")
	}
	if item.Type != "delete_branch" {
		t.Errorf("Type = %q, want delete_branch", item.Type)
	}
	if item.OldRef != "" {
		t.Errorf("OldRef = %q, want empty (v0.7.27.1 修复：commit_id 是 SHA 不是 branch name，"+
			"branch name 由前端 selectedPR.head.label 兜底)", item.OldRef)
	}
}

// TestGitHubAdapter_ListPullTimeline_DraftToggle 验证 v0.7.27.1 新增：
// `ready_for_review` / `convert_to_draft` event 触发 IsWipToggle 检测，
// 前端走 "已将合并请求标记为可评审/进行中" verb 渲染
func TestGitHubAdapter_ListPullTimeline_DraftToggle(t *testing.T) {
	// ready_for_review: user 取消 draft → IsWipToggle=true, IsWip=false
	item, ok := githubEventToTimelineItem(githubIssueEventRaw{
		ID:        1,
		Event:     "ready_for_review",
		CreatedAt: "2024-06-05T10:00:00Z",
	})
	if !ok {
		t.Fatalf("ready_for_review should be rendered")
	}
	if item.Type != "change_title" {
		t.Errorf("Type = %q, want change_title", item.Type)
	}
	if !item.IsWipToggle {
		t.Errorf("IsWipToggle = false, want true (draft toggle 事件)")
	}
	if item.IsWip {
		t.Errorf("IsWip = true, want false (ready_for_review = 取消 draft)")
	}

	// convert_to_draft: user 标记 draft → IsWipToggle=true, IsWip=true
	item, ok = githubEventToTimelineItem(githubIssueEventRaw{
		ID:        2,
		Event:     "convert_to_draft",
		CreatedAt: "2024-06-05T11:00:00Z",
	})
	if !ok {
		t.Fatalf("convert_to_draft should be rendered")
	}
	if !item.IsWipToggle {
		t.Errorf("IsWipToggle = false, want true (draft toggle 事件)")
	}
	if !item.IsWip {
		t.Errorf("IsWip = false, want true (convert_to_draft = 进入 draft)")
	}
}

// TestGitHubAdapter_ListPullTimeline_BaseRefChanged 验证 v0.7.27.1 新增：
// `base_ref_changed` event → type=change_target_branch
// GitHub events 端不返 base ref name，OldRef/NewRef 留空，前端用 selectedPR.base.label 兜底
func TestGitHubAdapter_ListPullTimeline_BaseRefChanged(t *testing.T) {
	item, ok := githubEventToTimelineItem(githubIssueEventRaw{
		ID:        1,
		Event:     "base_ref_changed",
		CreatedAt: "2024-06-05T10:00:00Z",
	})
	if !ok {
		t.Fatalf("base_ref_changed should be rendered")
	}
	if item.Type != "change_target_branch" {
		t.Errorf("Type = %q, want change_target_branch", item.Type)
	}
	if item.OldRef != "" || item.NewRef != "" {
		t.Errorf("OldRef=%q NewRef=%q, want empty (v0.7.27.1：events 端不返 base ref name)",
			item.OldRef, item.NewRef)
	}
}
