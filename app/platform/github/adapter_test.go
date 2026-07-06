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
	if items[0].State != "APPROVED" {
		t.Errorf("State = %q, want APPROVED", items[0].State)
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
	if d.State != "APPROVED" {
		t.Errorf("State = %q, want APPROVED", d.State)
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
