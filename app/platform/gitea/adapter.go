// Package gitea 实现 PlatformAdapter 的 Gitea 版本。
//
// 用 Go net/http 调 Gitea REST API（/api/v1），替代旧版 gitea-js TS 客户端。
// 鉴权：Authorization: token <pat>（Gitea 习惯，不是 OAuth2 Bearer）。
// HTTP 错误映射沿用旧版 httpErrorToIpcError 表。
package gitea

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform"
)

// GiteaAdapter Gitea 平台适配器
type GiteaAdapter struct {
	httpClient *http.Client
}

// NewGiteaAdapter 创建 GiteaAdapter
func NewGiteaAdapter() *GiteaAdapter {
	return &GiteaAdapter{
		httpClient: &http.Client{},
	}
}

// Platform 返回平台标识
func (a *GiteaAdapter) Platform() platform.Platform {
	return platform.Gitea
}

// ===== 鉴权 =====

// VerifyToken 验证 token 有效性（GET /api/v1/user）
func (a *GiteaAdapter) VerifyToken(ctx context.Context, hostURL, token string) (*platform.UserDTO, error) {
	var raw struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		FullName  string `json:"full_name"`
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
		FullName:  raw.FullName,
		Email:     raw.Email,
		AvatarURL: raw.AvatarURL,
	}, nil
}

// ===== 仓库 =====

// ListRepos 列出用户可访问的仓库（GET /api/v1/repos/search）
//
// v2.3 扩展：解析 id / archived / updated_at / permissions（前端 RepoDto 需要这些字段）
func (a *GiteaAdapter) ListRepos(ctx context.Context, hostURL, username, token string, opts platform.ListReposOpts) ([]platform.RepoDTO, error) {
	params := url.Values{}
	if opts.Query != "" {
		params.Set("q", opts.Query)
	}
	if opts.Limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", opts.Limit))
	} else {
		params.Set("limit", "50")
	}
	if opts.Page > 0 {
		params.Set("page", fmt.Sprintf("%d", opts.Page))
	}

	var raw struct {
		Data []struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			FullName string `json:"full_name"`
			Owner    struct {
				Login string `json:"login"`
			} `json:"owner"`
			DefaultBranch string `json:"default_branch"`
			Description   string `json:"description"`
			Private       bool   `json:"private"`
			Archived      bool   `json:"archived"`
			UpdatedAt     string `json:"updated_at"`
			Permissions   *struct {
				Pull  bool `json:"pull"`
				Push  bool `json:"push"`
				Admin bool `json:"admin"`
			} `json:"permissions"`
		} `json:"data"`
	}

	path := "/repos/search?" + params.Encode()
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	repos := make([]platform.RepoDTO, 0, len(raw.Data))
	for _, r := range raw.Data {
		dto := platform.RepoDTO{
			ID:            r.ID,
			Owner:         r.Owner.Login,
			Name:          r.Name,
			FullName:      r.FullName,
			DefaultBranch: r.DefaultBranch,
			Description:   r.Description,
			Private:       r.Private,
			Archived:      r.Archived,
			UpdatedAt:     r.UpdatedAt,
		}
		if r.Permissions != nil {
			dto.Permissions = &platform.RepoPermissions{
				Pull:  r.Permissions.Pull,
				Push:  r.Permissions.Push,
				Admin: r.Permissions.Admin,
			}
		}
		repos = append(repos, dto)
	}
	return repos, nil
}

// ===== 分支 =====

// ListBranches 列出仓库分支（GET /api/v1/repos/{owner}/{repo}/branches）
func (a *GiteaAdapter) ListBranches(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.BranchDTO, error) {
	var raw []struct {
		Name   string `json:"name"`
		Commit struct {
			ID string `json:"id"`
		} `json:"commit"`
		Protected bool `json:"protected"`
	}

	path := fmt.Sprintf("/repos/%s/%s/branches", owner, repo)
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	branches := make([]platform.BranchDTO, 0, len(raw))
	for _, b := range raw {
		branches = append(branches, platform.BranchDTO{
			Name:        b.Name,
			CommitSHA:   b.Commit.ID,
			IsProtected: b.Protected,
		})
	}
	return branches, nil
}

// ===== Git Graph =====

// CloneRepo clone 仓库到本地 workspace（委托 app/git.CloneRepo）
//
// v2.4 轻量模式：NoCheckout=true 跳过工作区文件（Git Graph 元信息足够）
// v2.5 按账号分层：accountUsername 用于子目录布局
// v2.6 progress 可选进度回调（nil = 静默，向后兼容）
func (a *GiteaAdapter) CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath, accountUsername string, progress git.ProgressCallback) (string, error) {
	result, err := git.CloneRepo(git.CloneOptions{
		Platform:        "gitea",
		HostURL:         hostURL,
		Owner:           owner,
		Repo:            repo,
		Token:           token,
		Username:        username,
		WorkspacePath:   workspacePath,
		AccountUsername: accountUsername,
		NoCheckout:      true, // v2.4：只拉元信息
		Progress:        progress,
	})
	if err != nil {
		return "", err
	}
	return result.LocalPath, nil
}

// LogGraph 获取 commit 历史并构建 Graph 布局
func (a *GiteaAdapter) LogGraph(ctx context.Context, localPath string, opts platform.LogGraphOpts) (*platform.GraphResult, error) {
	logResult, err := git.LogCommits(git.LogOptions{
		LocalPath: localPath,
		Branches:  opts.Branches,
		MaxCount:  opts.MaxCount,
	})
	if err != nil {
		return nil, err
	}

	graphResult := graph.BuildGraphVscodeWithHead(logResult.Commits, "")

	return graphResultToDTO(graphResult), nil
}

// ===== 以下首期仅 Gitea 完整实现 =====

// ListIssues 列出仓库议题（GET /api/v1/repos/{owner}/{repo}/issues）
func (a *GiteaAdapter) ListIssues(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListIssuesOpts) ([]platform.IssueDTO, error) {
	params := url.Values{}
	if opts.State != "" {
		params.Set("state", opts.State)
	} else {
		params.Set("state", "open")
	}
	if opts.Limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	if opts.Page > 0 {
		params.Set("page", fmt.Sprintf("%d", opts.Page))
	}

	var raw []struct {
		Index int    `json:"number"`
		Title string `json:"title"`
		State string `json:"state"`
		Body  string `json:"body"`
		User  struct {
			Login string `json:"login"`
		} `json:"user"`
	}

	path := fmt.Sprintf("/repos/%s/%s/issues?%s", owner, repo, params.Encode())
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	issues := make([]platform.IssueDTO, 0, len(raw))
	for _, i := range raw {
		issues = append(issues, platform.IssueDTO{
			Index:  i.Index,
			Title:  i.Title,
			State:  i.State,
			Body:   i.Body,
			Author: i.User.Login,
		})
	}
	return issues, nil
}

// ListPulls 列出仓库合并请求（GET /api/v1/repos/{owner}/{repo}/pulls）
func (a *GiteaAdapter) ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListPullsOpts) ([]platform.PullDTO, error) {
	params := url.Values{}
	if opts.State != "" {
		params.Set("state", opts.State)
	} else {
		params.Set("state", "open")
	}
	if opts.Limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	if opts.Page > 0 {
		params.Set("page", fmt.Sprintf("%d", opts.Page))
	}

	var raw []struct {
		Index int    `json:"number"`
		Title string `json:"title"`
		State string `json:"state"`
		Head  struct {
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
		Merged bool `json:"merged"`
	}

	path := fmt.Sprintf("/repos/%s/%s/pulls?%s", owner, repo, params.Encode())
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	pulls := make([]platform.PullDTO, 0, len(raw))
	for _, p := range raw {
		pulls = append(pulls, platform.PullDTO{
			Index:  p.Index,
			Title:  p.Title,
			State:  p.State,
			Head:   p.Head.Ref,
			Base:   p.Base.Ref,
			Merged: p.Merged,
		})
	}
	return pulls, nil
}

// ListLabels 列出仓库标签（GET /api/v1/repos/{owner}/{repo}/labels）
func (a *GiteaAdapter) ListLabels(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.LabelDTO, error) {
	var raw []struct {
		ID          int64  `json:"id"`
		Name        string `json:"name"`
		Color       string `json:"color"`
		Description string `json:"description"`
	}

	path := fmt.Sprintf("/repos/%s/%s/labels", owner, repo)
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	labels := make([]platform.LabelDTO, 0, len(raw))
	for _, l := range raw {
		labels = append(labels, platform.LabelDTO{
			ID:          l.ID,
			Name:        l.Name,
			Color:       l.Color,
			Description: l.Description,
		})
	}
	return labels, nil
}

// ListMembers 列出仓库成员（GET /api/v1/repos/{owner}/{repo}/collaborators）
func (a *GiteaAdapter) ListMembers(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.MemberDTO, error) {
	var raw []struct {
		Login string `json:"login"`
	}

	path := fmt.Sprintf("/repos/%s/%s/collaborators", owner, repo)
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	members := make([]platform.MemberDTO, 0, len(raw))
	for _, m := range raw {
		members = append(members, platform.MemberDTO{
			Login: m.Login,
		})
	}
	return members, nil
}

// ===== HTTP 请求封装 =====

// doRequest 发送 Gitea API 请求
//
// 鉴权：Authorization: token <pat>（Gitea 习惯）
// URL：${hostURL}/api/v1${path}
func (a *GiteaAdapter) doRequest(ctx context.Context, hostURL, token, method, path string, body io.Reader, out interface{}) error {
	base := strings.TrimRight(hostURL, "/")
	fullURL := base + "/api/v1" + path

	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		// 构造失败：URL 解析 / ctx 异常 / headers 异常，几乎不会发生但兜底
		return ipc.NewInternal("构造 Gitea 请求失败: " + err.Error())
	}

	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		// 网络层错误（含 TLS、DNS、连接被拒、超时）
		// 包成 IpcError，code=network_offline，前端能识别为"网络问题"而非"未知错误"
		return ipc.NewNetworkOffline(fmt.Sprintf("Gitea %s %s: %s", method, fullURL, err.Error()))
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return mapHTTPError(resp.StatusCode, string(bodyBytes), fullURL)
	}

	if resp.StatusCode == http.StatusNoContent {
		return nil // 204 No Content
	}

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return ipc.NewInternal("解析 Gitea 响应失败: " + err.Error())
		}
	}

	return nil
}

// mapHTTPError 把 Gitea HTTP 错误码映射为友好 IpcError
//
// 对齐旧版 httpErrorToIpcError（src/main/gitea/client.ts）
// 返回 *ipc.IpcError：main.go 的 ErrorFormatter 会把它结构化序列化到前端，
// 前端 isIpcErrorPayload() 就能识别 code + message + hint。
func mapHTTPError(status int, body, url string) error {
	cause := ipc.TruncateCause(body)
	switch status {
	case 401:
		return &ipc.IpcError{
			Code:       ipc.CodeTokenInvalid,
			Message:    "登录已过期或 token 无效",
			Hint:       "请到 Gitea 重新生成 token 后再连接",
			Cause:      cause,
			HTTPStatus: status,
		}
	case 403:
		return ipc.NewPermissionDenied(cause)
	case 404:
		return ipc.NewNotFound(cause)
	case 409:
		return &ipc.IpcError{
			Code:       ipc.CodeConflict,
			Message:    "操作冲突：资源已存在或状态不允许",
			Hint:       "请刷新后重试",
			Cause:      cause,
			HTTPStatus: status,
		}
	case 422:
		return ipc.NewValidationFailed("请求参数不被服务端接受", cause)
	case 429:
		return &ipc.IpcError{
			Code:       ipc.CodeRateLimited,
			Message:    "请求过于频繁",
			Hint:       "请稍候重试",
			Cause:      cause,
			HTTPStatus: status,
		}
	case 502, 503, 504:
		return ipc.NewNetworkOffline(cause)
	default:
		return ipc.NewGiteaError("Gitea 返回错误", cause)
	}
}

// graphResultToDTO 把 graph.GraphResult 转为 platform.GraphResult DTO
func graphResultToDTO(r *graph.GraphResult) *platform.GraphResult {
	if r == nil {
		return nil
	}

	nodes := make([]platform.GraphNodeDTO, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		refTypes := make([]string, len(n.RefTypes))
		for i, t := range n.RefTypes {
			refTypes[i] = string(t)
		}
		nodes = append(nodes, platform.GraphNodeDTO{
			Row:         n.Row,
			Lane:        n.Lane,
			Color:       n.Color,
			SHA:         n.SHA,
			ShortSHA:    n.ShortSHA,
			Subject:     n.Subject,
			AuthorName:  n.AuthorName,
			AuthorEmail: n.AuthorEmail,
			Date:        n.Date,
			IsMerge:     n.IsMerge,
			Parents:     n.Parents,
			Refs:        n.Refs,
			RefTypes:    refTypes,
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
