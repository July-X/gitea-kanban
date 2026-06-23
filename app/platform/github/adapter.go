// Package github 实现 PlatformAdapter 的 GitHub 版本（首期仅 Git Graph）。
//
// 首期范围（对齐迁移计划 §2.4）：
//   - VerifyToken：GET /user，Authorization: Bearer <token>
//   - CloneRepo：go-git clone（与 Gitea 共用 app/git.CloneRepo）
//   - LogGraph：go-git DAG Log + 自研 lane 布局（与 Gitea 共用）
//   - 其余方法返回 ErrNotSupported
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform"
)

// GitHubAPIBase GitHub API 基础 URL
const GitHubAPIBase = "https://api.github.com"

// GitHubAdapter GitHub 平台适配器（首期仅 Git Graph）
type GitHubAdapter struct {
	httpClient *http.Client
}

// NewGitHubAdapter 创建 GitHubAdapter
func NewGitHubAdapter() *GitHubAdapter {
	return &GitHubAdapter{
		httpClient: &http.Client{},
	}
}

// Platform 返回平台标识
func (a *GitHubAdapter) Platform() platform.Platform {
	return platform.GitHub
}

// ===== 鉴权 =====

// VerifyToken 验证 token 有效性（GET /user）
//
// GitHub 鉴权：Authorization: Bearer <token>（与 Gitea 的 token <pat> 不同）
func (a *GitHubAdapter) VerifyToken(ctx context.Context, hostURL, token string) (*platform.UserDTO, error) {
	if hostURL == "" {
		hostURL = GitHubAPIBase
	}

	var raw struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}

	err := a.doRequest(ctx, hostURL, token, "GET", "/user", nil, &raw)
	if err != nil {
		return nil, err
	}

	return &platform.UserDTO{
		ID:        raw.ID,
		Login:     raw.Login,
		FullName:  raw.Name,
		Email:     raw.Email,
		AvatarURL: raw.AvatarURL,
	}, nil
}

// ===== 仓库（首期不支持，UI 隐藏）=====

// ListRepos 首期不支持
func (a *GitHubAdapter) ListRepos(ctx context.Context, hostURL, username, token string, opts platform.ListReposOpts) ([]platform.RepoDTO, error) {
	return nil, platform.ErrNotSupported
}

// ===== 分支 =====

// ListBranches 首期不支持（GitHub 分支通过 go-git 获取，不走 API）
func (a *GitHubAdapter) ListBranches(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.BranchDTO, error) {
	return nil, platform.ErrNotSupported
}

// ===== Git Graph（GitHub 首期支持）=====

// CloneRepo clone 仓库到本地 workspace
//
// GitHub clone URL: https://github.com/{owner}/{repo}.git
// 鉴权：http.BasicAuth{Username: "oauth2" 或用户名, Password: token}
func (a *GitHubAdapter) CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath string) (string, error) {
	if hostURL == "" {
		hostURL = "https://github.com"
	}

	result, err := git.CloneRepo(git.CloneOptions{
		Platform:      "github",
		HostURL:       hostURL,
		Owner:         owner,
		Repo:          repo,
		Token:         token,
		Username:      username,
		WorkspacePath: workspacePath,
		NoCheckout:    true, // v2.4：只拉元信息
	})
	if err != nil {
		return "", err
	}
	return result.LocalPath, nil
}

// LogGraph 获取 commit 历史并构建 Graph 布局（与 Gitea 共用）
func (a *GitHubAdapter) LogGraph(ctx context.Context, localPath string, opts platform.LogGraphOpts) (*platform.GraphResult, error) {
	logResult, err := git.LogCommits(git.LogOptions{
		LocalPath: localPath,
		Branches:  opts.Branches,
		MaxCount:  opts.MaxCount,
	})
	if err != nil {
		return nil, err
	}

	graphResult := graph.BuildGraph(logResult.Commits)
	return graphResultToDTO(graphResult), nil
}

// ===== 以下首期不支持 =====

// ListIssues 首期不支持
func (a *GitHubAdapter) ListIssues(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListIssuesOpts) ([]platform.IssueDTO, error) {
	return nil, platform.ErrNotSupported
}

// ListPulls 首期不支持
func (a *GitHubAdapter) ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListPullsOpts) ([]platform.PullDTO, error) {
	return nil, platform.ErrNotSupported
}

// ListLabels 首期不支持
func (a *GitHubAdapter) ListLabels(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.LabelDTO, error) {
	return nil, platform.ErrNotSupported
}

// ListMembers 首期不支持
func (a *GitHubAdapter) ListMembers(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.MemberDTO, error) {
	return nil, platform.ErrNotSupported
}

// ===== HTTP 请求封装 =====

// doRequest 发送 GitHub API 请求
//
// 鉴权：Authorization: Bearer <token>（与 Gitea 的 token <pat> 不同）
// URL：${hostURL}${path}（GitHub API 不需要 /api/v1 前缀）
func (a *GitHubAdapter) doRequest(ctx context.Context, hostURL, token, method, path string, body io.Reader, out interface{}) error {
	base := strings.TrimRight(hostURL, "/")
	fullURL := base + path

	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return fmt.Errorf("构造请求失败: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return mapHTTPError(resp.StatusCode, string(bodyBytes))
	}

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("解析响应失败: %w", err)
		}
	}

	return nil
}

// mapHTTPError 把 GitHub HTTP 错误码映射为友好 IpcError
//
// 跟 Gitea mapHTTPError 保持一致的结构（main.go ErrorFormatter 会序列化到前端）
func mapHTTPError(status int, body string) error {
	cause := ipc.TruncateCause(body)
	switch status {
	case 401:
		return &ipc.IpcError{
			Code:       ipc.CodeTokenInvalid,
			Message:    "登录已过期或 token 无效",
			Hint:       "请到 GitHub Settings → Developer settings 重新生成 token",
			Cause:      cause,
			HTTPStatus: status,
		}
	case 403:
		return ipc.NewPermissionDenied(cause + "（可能 token scope 不足）")
	case 404:
		return ipc.NewNotFound(cause + "（可能已被删除或 token 无权访问）")
	case 422:
		return ipc.NewValidationFailed("请求参数不被服务端接受", cause)
	case 429:
		return &ipc.IpcError{
			Code:       ipc.CodeRateLimited,
			Message:    "请求过于频繁（GitHub API 限流）",
			Hint:       "请稍候重试",
			Cause:      cause,
			HTTPStatus: status,
		}
	case 502, 503:
		return ipc.NewNetworkOffline(cause)
	default:
		return ipc.NewGiteaError("GitHub 返回错误", cause)
	}
}

// graphResultToDTO 把 graph.GraphResult 转为 platform.GraphResult DTO
func graphResultToDTO(r *graph.GraphResult) *platform.GraphResult {
	if r == nil {
		return nil
	}

	nodes := make([]platform.GraphNodeDTO, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		nodes = append(nodes, platform.GraphNodeDTO{
			Row:         n.Row,
			Lane:        n.Lane,
			SHA:         n.SHA,
			ShortSHA:    n.ShortSHA,
			Subject:     n.Subject,
			AuthorName:  n.AuthorName,
			AuthorEmail: n.AuthorEmail,
			Date:        n.Date,
			IsMerge:     n.IsMerge,
			Parents:     n.Parents,
			Refs:        n.Refs,
		})
	}

	edges := make([]platform.GraphEdgeDTO, 0, len(r.Edges))
	for _, e := range r.Edges {
		edges = append(edges, platform.GraphEdgeDTO{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Color:    e.Color,
			Type:     int(e.Type),
		})
	}

	return &platform.GraphResult{
		Nodes:     nodes,
		Edges:     edges,
		MaxLane:   r.MaxLane,
		Truncated: r.Truncated,
	}
}
