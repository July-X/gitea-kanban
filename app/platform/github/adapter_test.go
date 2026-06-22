package github

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gitea-kanban/app/platform"
)

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

	// ListRepos 应返回 ErrNotSupported
	_, err := adapter.ListRepos(ctx, "", "", "", platform.ListReposOpts{})
	if err != platform.ErrNotSupported {
		t.Errorf("ListRepos error = %v, want ErrNotSupported", err)
	}

	// ListBranches
	_, err = adapter.ListBranches(ctx, "", "", "", "", "")
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
