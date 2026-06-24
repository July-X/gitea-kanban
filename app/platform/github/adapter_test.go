package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

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

	// ListPulls
	_, err = adapter.ListPulls(ctx, "", "", "", "", "", platform.ListPullsOpts{})
	if err != platform.ErrNotSupported {
		t.Errorf("ListPulls error = %v, want ErrNotSupported", err)
	}

	// ListLabels
	_, err = adapter.ListLabels(ctx, "", "", "", "", "")
	if err != platform.ErrNotSupported {
		t.Errorf("ListLabels error = %v, want ErrNotSupported", err)
	}

	// ListMembers
	_, err = adapter.ListMembers(ctx, "", "", "", "", "")
	if err != platform.ErrNotSupported {
		t.Errorf("ListMembers error = %v, want ErrNotSupported", err)
	}
}

func TestGitHubAdapter_Platform(t *testing.T) {
	adapter := NewGitHubAdapter()
	if adapter.Platform() != "github" {
		t.Errorf("Platform = %q, want github", adapter.Platform())
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