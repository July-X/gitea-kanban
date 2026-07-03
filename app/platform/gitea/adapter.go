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
	"time"

	gogit "github.com/go-git/go-git/v5"
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
		Offset:    opts.Offset,
	})
	if err != nil {
		return nil, err
	}

	// 解析 HEAD (跟 debug 工具保持一致): 空则全不标 isCurrent
	head := opts.Head
	if head == "" {
		head = resolveLocalHead(localPath)
	}

	graphResult := graph.BuildGraphVscodeWithHead(logResult.Commits, head, logResult.Truncated)

	return graphResultToDTO(graphResult), nil
}

// resolveLocalHead 用 go-git 读本地 HEAD hash, 失败返回 ""
func resolveLocalHead(localPath string) string {
	r, err := gogit.PlainOpen(localPath)
	if err != nil {
		return ""
	}
	head, err := r.Head()
	if err != nil {
		return ""
	}
	return head.Hash().String()
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
//
// v0.6+ 返回值升级为 *PullDetailDTO（之前是 *PullDTO 轻量版）。
// Gitea /pulls 列表接口本身返回完整字段（head.sha / user / mergeable / labels / assignees / reviewers），
// 没必要列表/详情拆两次请求。轻量字段需求由前端 store 端按需 pick。
func (a *GiteaAdapter) ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListPullsOpts) ([]platform.PullDetailDTO, error) {
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

	var raw []giteaPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls?%s", owner, repo, params.Encode())
	err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw)
	if err != nil {
		return nil, err
	}

	pulls := make([]platform.PullDetailDTO, 0, len(raw))
	for i := range raw {
		pulls = append(pulls, giteaPullToDetail(raw[i]))
	}
	return pulls, nil
}

// ===== Pull Request 完整详情字段映射（v0.6+） =====

// giteaPullRaw Gitea /pulls 列表 + /pulls/{index} 详情 共享的原始结构
//
// Gitea 1.21+ swagger：https://try.gitea.io/swagger#/repository/repoGetPullRequest
// 仅保留本应用需要的字段，详见 PullRequest 端点定义。
type giteaPullRaw struct {
	Number             int                 `json:"number"`
	Title              string              `json:"title"`
	State              string              `json:"state"`
	Draft              bool                `json:"draft"`
	Merged             bool                `json:"merged"`
	Head               giteaPullRefRaw     `json:"head"`
	Base               giteaPullRefRaw     `json:"base"`
	User               *giteaUserRaw       `json:"user"`
	Assignees          []giteaUserRaw      `json:"assignees"`
	RequestedReviewers []giteaUserRaw      `json:"requested_reviewers"`
	Labels             []giteaPullLabelRaw `json:"labels"`
	Mergeable          bool                `json:"mergeable"`
	Comments           int                 `json:"comments"`
	Body               string              `json:"body"`
	MergedBy           *giteaUserRaw       `json:"merged_by"`
	CreatedAt          string              `json:"created_at"`
	UpdatedAt          string              `json:"updated_at"`
}

type giteaPullRefRaw struct {
	Ref string `json:"ref"`
	SHA string `json:"sha"`
}

type giteaUserRaw struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type giteaPullLabelRaw struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// giteaPullToDetail 把 Gitea 原始响应映射到平台中性 PullDetailDTO
func giteaPullToDetail(p giteaPullRaw) platform.PullDetailDTO {
	out := platform.PullDetailDTO{
		Index:         p.Number,
		Number:        p.Number,
		Title:         p.Title,
		State:         p.State,
		Draft:         p.Draft,
		Merged:        p.Merged,
		Head:          platform.PullRefDTO{Ref: p.Head.Ref, SHA: p.Head.SHA},
		Base:          platform.PullRefDTO{Ref: p.Base.Ref, SHA: p.Base.SHA},
		Mergeable:     p.Mergeable,
		HasConflicts:  !p.Mergeable,
		Body:          p.Body,
		CommentsCount: p.Comments,
		CreatedAt:     p.CreatedAt,
		UpdatedAt:     p.UpdatedAt,
	}
	if p.User != nil {
		out.Author = &platform.PullUserDTO{Username: p.User.Login, AvatarURL: p.User.AvatarURL}
	}
	if p.MergedBy != nil {
		out.MergedBy = &platform.PullUserDTO{Username: p.MergedBy.Login, AvatarURL: p.MergedBy.AvatarURL}
	}
	if len(p.Assignees) > 0 {
		out.Assignees = make([]platform.PullUserDTO, 0, len(p.Assignees))
		for _, u := range p.Assignees {
			out.Assignees = append(out.Assignees, platform.PullUserDTO{Username: u.Login, AvatarURL: u.AvatarURL})
		}
	}
	if len(p.RequestedReviewers) > 0 {
		out.Reviewers = make([]platform.PullUserDTO, 0, len(p.RequestedReviewers))
		for _, u := range p.RequestedReviewers {
			out.Reviewers = append(out.Reviewers, platform.PullUserDTO{Username: u.Login, AvatarURL: u.AvatarURL})
		}
	}
	if len(p.Labels) > 0 {
		out.Labels = make([]platform.PullLabelDTO, 0, len(p.Labels))
		for _, l := range p.Labels {
			out.Labels = append(out.Labels, platform.PullLabelDTO{ID: l.ID, Name: l.Name, Color: l.Color})
		}
	}
	return out
}

// GetPull 获取单个合并请求详情（GET /api/v1/repos/{owner}/{repo}/pulls/{index}）
func (a *GiteaAdapter) GetPull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*platform.PullDetailDTO, error) {
	var raw giteaPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	d := giteaPullToDetail(raw)
	return &d, nil
}

// MergePull 合并合并请求（POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge）
//
// Gitea body: { Do: { merge_style_field, title?, message?, delete_branch_after_merge? } }
// merge_style_field: "merge" | "rebase" | "rebase_merge" | "squash"
func (a *GiteaAdapter) MergePull(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts platform.MergePullOpts) (*platform.PullDetailDTO, error) {
	style := mapMergeMethodToGitea(opts.Method)
	do := map[string]any{
		"merge_style_field":        style,
		"delete_branch_after_merge": opts.DeleteBranchAfter,
	}
	if opts.CommitMessage != "" {
		do["message"] = opts.CommitMessage
	}
	body := map[string]any{"Do": do}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, nil); err != nil {
		return nil, err
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// ClosePull 关闭合并请求（PATCH /api/v1/repos/{owner}/{repo}/pulls/{index} state=closed）
func (a *GiteaAdapter) ClosePull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*platform.PullDetailDTO, error) {
	body := map[string]any{"state": "closed"}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	var raw giteaPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
		return nil, err
	}
	d := giteaPullToDetail(raw)
	return &d, nil
}

// UpdatePullLabels 替换合并请求标签（PUT /api/v1/repos/{owner}/{repo}/pulls/{index}/labels）
//
// gitea 端点 PUT body: {labels: [{name: "..."}]}（替换语义）。
// 为简化，前端传 label 名称数组；gitea 会按 name 自动解析为 id。
func (a *GiteaAdapter) UpdatePullLabels(ctx context.Context, hostURL, username, token, owner, repo string, index int, labelNames []string) (*platform.PullDetailDTO, error) {
	labels := make([]map[string]any, 0, len(labelNames))
	for _, n := range labelNames {
		labels = append(labels, map[string]any{"name": n})
	}
	body := map[string]any{"labels": labels}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	var raw giteaPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/labels", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "PUT", path, reader, &raw); err != nil {
		return nil, err
	}
	d := giteaPullToDetail(raw)
	return &d, nil
}

// UpdatePullAssignee 替换合并请求指派人（Gitea 端点为 POST/DELETE /pulls/{index}/assignees 追加/移除）
//
// 为与前端契约（"替换所有"）一致：先 GET 现状，diff 后做 1 次 DELETE + 1 次 POST。
// 简化：当前仅支持单 assignee；assignee="" 表示清空。
func (a *GiteaAdapter) UpdatePullAssignee(ctx context.Context, hostURL, username, token, owner, repo string, index int, assignee string) (*platform.PullDetailDTO, error) {
	cur, err := a.GetPull(ctx, hostURL, username, token, owner, repo, index)
	if err != nil {
		return nil, err
	}
	existing := make([]string, 0, len(cur.Assignees))
	for _, u := range cur.Assignees {
		existing = append(existing, u.Username)
	}
	toRemove := []string{}
	for _, u := range existing {
		if u != assignee {
			toRemove = append(toRemove, u)
		}
	}
	toAdd := []string{}
	if assignee != "" {
		found := false
		for _, u := range existing {
			if u == assignee {
				found = true
				break
			}
		}
		if !found {
			toAdd = append(toAdd, assignee)
		}
	}
	if len(toRemove) > 0 {
		body := map[string]any{"assignees": toRemove}
		reader, err := encodeJSONBody(body)
		if err != nil {
			return nil, err
		}
		path := fmt.Sprintf("/repos/%s/%s/pulls/%d/assignees", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "DELETE", path, reader, nil); err != nil {
			return nil, err
		}
	}
	if len(toAdd) > 0 {
		body := map[string]any{"assignees": toAdd}
		reader, err := encodeJSONBody(body)
		if err != nil {
			return nil, err
		}
		path := fmt.Sprintf("/repos/%s/%s/pulls/%d/assignees", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, nil); err != nil {
			return nil, err
		}
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// UpdatePullReviewers 替换合并请求审查者（POST/DELETE /api/v1/repos/{owner}/{repo}/pulls/{index}/requested_reviewers）
func (a *GiteaAdapter) UpdatePullReviewers(ctx context.Context, hostURL, username, token, owner, repo string, index int, reviewers []string) (*platform.PullDetailDTO, error) {
	cur, err := a.GetPull(ctx, hostURL, username, token, owner, repo, index)
	if err != nil {
		return nil, err
	}
	desired := make(map[string]struct{}, len(reviewers))
	for _, r := range reviewers {
		desired[r] = struct{}{}
	}
	existing := make([]string, 0, len(cur.Reviewers))
	for _, u := range cur.Reviewers {
		existing = append(existing, u.Username)
	}
	toRemove := []string{}
	for _, u := range existing {
		if _, ok := desired[u]; !ok {
			toRemove = append(toRemove, u)
		}
	}
	toAdd := []string{}
	for r := range desired {
		found := false
		for _, u := range existing {
			if u == r {
				found = true
				break
			}
		}
		if !found {
			toAdd = append(toAdd, r)
		}
	}
	if len(toRemove) > 0 {
		body := map[string]any{"reviewers": toRemove}
		reader, err := encodeJSONBody(body)
		if err != nil {
			return nil, err
		}
		path := fmt.Sprintf("/repos/%s/%s/pulls/%d/requested_reviewers", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "DELETE", path, reader, nil); err != nil {
			return nil, err
		}
	}
	if len(toAdd) > 0 {
		body := map[string]any{"reviewers": toAdd}
		reader, err := encodeJSONBody(body)
		if err != nil {
			return nil, err
		}
		path := fmt.Sprintf("/repos/%s/%s/pulls/%d/requested_reviewers", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, nil); err != nil {
			return nil, err
		}
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// mapMergeMethodToGitea 把前端 MergeMethod 转换为 gitea merge_style_field
//
// 前端：'merge' | 'rebase' | 'rebase-merge' | 'squash'
// gitea: 'merge'  | 'rebase' | 'rebase_merge'  | 'squash'
func mapMergeMethodToGitea(method string) string {
	switch method {
	case "rebase-merge":
		return "rebase_merge"
	case "", "merge":
		return "merge"
	default:
		return method
	}
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

// ===== 合并请求评论（v0.6+） =====
//
// Gitea 端点：/repos/{owner}/{repo}/issues/{index}/comments
// 重要：Gitea 上 PR 和 issue 共享同一编号空间，所以 PR 评论走 issue comments 端点
// （与 GitHub 习惯一致 —— GitHub 上 PR 就是 issue）。

// ListPullComments 列合并请求评论（GET /repos/{owner}/{repo}/issues/{index}/comments）
func (a *GiteaAdapter) ListPullComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.CommentDTO, error) {
	var raw []giteaCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.CommentDTO, 0, len(raw))
	for _, c := range raw {
		out = append(out, giteaCommentToDTO(c))
	}
	return out, nil
}

// CreatePullComment 发合并请求评论（POST /repos/{owner}/{repo}/issues/{index}/comments）
//
// body: {body: "..."} —— Gitea API 限制 body 必填且非空。
// 返回服务端创建的评论（含 id / author / createdAt ），前端以此刷列表。
func (a *GiteaAdapter) CreatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string) (*platform.CommentDTO, error) {
	if strings.TrimSpace(body) == "" {
		return nil, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	payload := map[string]any{"body": body}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaCommentToDTO(raw)
	return &dto, nil
}

// UpdatePullComment 编辑合并请求评论（PATCH /repos/{owner}/{repo}/issues/comments/{id}）
//
// body: {body: "..."} —— 服务端会更新 updatedAt。
// 返回更新后的评论（含新 updatedAt），前端以此判断"已编辑"状态。
func (a *GiteaAdapter) UpdatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, body string) (*platform.CommentDTO, error) {
	if strings.TrimSpace(body) == "" {
		return nil, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	payload := map[string]any{"body": body}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
	if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaCommentToDTO(raw)
	return &dto, nil
}

// DeletePullComment 删除合并请求评论（DELETE /repos/{owner}/{repo}/issues/comments/{id}）
//
// 成功 → 服务端返 204 No Content；对已删除评论重复删除也返 2xx（幂等）。
func (a *GiteaAdapter) DeletePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) error {
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
	return a.doRequest(ctx, hostURL, token, "DELETE", path, nil, nil)
}

// ===== 评论表情反应（v0.5.0 M2） =====
//
// Gitea 端点：/repos/{owner}/{repo}/issues/comments/{id}/reactions
// Gitea 字段：reaction 字段名（不是 content）; DELETE 必须带 body: {content: "..."}

// giteaReactionRaw Gitea reactions 端点原始响应
type giteaReactionRaw struct {
	ID       int64         `json:"id"`
	User     *giteaUserRaw `json:"user"`
	Reaction string        `json:"reaction"` // Gitea 字段名（非 content）
}

// giteaReactionToDTO 映射为平台中性 ReactionDTO
func giteaReactionToDTO(r giteaReactionRaw) platform.ReactionDTO {
	out := platform.ReactionDTO{
		ID:      r.ID,
		Content: r.Reaction,
	}
	if r.User != nil {
		out.User = &platform.PullUserDTO{
			Username:  r.User.Login,
			AvatarURL: r.User.AvatarURL,
		}
	}
	return out
}

// ListPullCommentReactions 列评论表情反应（GET /repos/{owner}/{repo}/issues/comments/{id}/reactions）
func (a *GiteaAdapter) ListPullCommentReactions(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) ([]platform.ReactionDTO, error) {
	var raw []giteaReactionRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.ReactionDTO, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaReactionToDTO(r))
	}
	return out, nil
}

// AddPullCommentReaction 添加表情反应（POST /repos/{owner}/{repo}/issues/comments/{id}/reactions）
//
// body: {content: "+1"}。Gitea 已存在的 reaction（同 user 同 content）会已被幂等——
// 查 API 文档确认 Gitea 会静默返回 201 + 已有 reaction（不返 409）。
func (a *GiteaAdapter) AddPullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) (*platform.ReactionDTO, error) {
	payload := map[string]any{"content": content}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaReactionRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaReactionToDTO(raw)
	return &dto, nil
}

// RemovePullCommentReaction 移除表情反应（DELETE /repos/{owner}/{repo}/issues/comments/{id}/reactions）
//
// ⚠️ Gitea 的 DELETE reactions 必须带 body: {content: "..."}（不是按 reaction id 删，区别于 GitHub）。
func (a *GiteaAdapter) RemovePullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) error {
	payload := map[string]any{"content": content}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
	return a.doRequest(ctx, hostURL, token, "DELETE", path, reader, nil)
}

// ===== 合并请求评审（v0.5.0 M3） =====
//
// Gitea review API: /repos/{owner}/{repo}/pulls/{index}/reviews
// event 值: "approve" / "request_changes" / "comment"（小写，与前端统一）

// giteaReviewRaw Gitea /pulls/{index}/reviews 原始响应
type giteaReviewRaw struct {
	ID        int64         `json:"id"`
	State     string        `json:"state"`
	Body      string        `json:"body"`
	User      *giteaUserRaw `json:"user"`
	CommitID  string        `json:"commit_id"`
	Submitted string        `json:"submitted"`
}

// giteaReviewToDTO 映射为平台中性 PullReviewDTO
func giteaReviewToDTO(r giteaReviewRaw) platform.PullReviewDTO {
	out := platform.PullReviewDTO{
		ID:          r.ID,
		State:       r.State,
		Body:        r.Body,
		CommitID:    r.CommitID,
		SubmittedAt: r.Submitted,
	}
	if r.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  r.User.Login,
			AvatarURL: r.User.AvatarURL,
		}
	}
	return out
}

// validateGiteaReviewEvent 校验评审事件值（Gitea 支持 3 种小写）
func validateGiteaReviewEvent(event string) error {
	validEvents := map[string]bool{"approve": true, "request_changes": true, "comment": true}
	if !validEvents[event] {
		return ipc.NewValidationFailed("非法的评审事件: "+event, "支持的值: approve / request_changes / comment")
	}
	return nil
}

// ListPullReviews 列评审列表（GET /repos/{owner}/{repo}/pulls/{index}/reviews）
func (a *GiteaAdapter) ListPullReviews(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullReviewDTO, error) {
	var raw []giteaReviewRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.PullReviewDTO, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaReviewToDTO(r))
	}
	return out, nil
}

// CreatePullReview 创建评审（POST /repos/{owner}/{repo}/pulls/{index}/reviews）
//
// body: {commit_id, body, event, comments: []}
// Gitea event 值: "approve" / "request_changes" / "comment"（小写，与前端统一）
func (a *GiteaAdapter) CreatePullReview(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts platform.CreateReviewOpts) (*platform.PullReviewDTO, error) {
	if err := validateGiteaReviewEvent(opts.Event); err != nil {
		return nil, err
	}
	payload := map[string]any{
		"commit_id": opts.CommitID,
		"body":      opts.Body,
		"event":     opts.Event,
		"comments":  []interface{}{}, // 暂无行内评审（M4+）
	}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaReviewRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaReviewToDTO(raw)
	return &dto, nil
}

// giteaCommentRaw Gitea /repos/.../issues/{index}/comments 原始响应
//
// swagger: https://try.gitea.io/swagger#/issueissueComment
// 字段只取必要项：id / body / user / created / updated。
//
// 复用上面已定义的 giteaUserRaw（line 338），不在这里重复定义。
type giteaCommentRaw struct {
	ID      int64         `json:"id"`
	Body    string        `json:"body"`
	User    *giteaUserRaw `json:"user"`
	Created string        `json:"created"`
	Updated string        `json:"updated"`
}

// giteaCommentToDTO 映射为平台中性 CommentDTO
func giteaCommentToDTO(c giteaCommentRaw) platform.CommentDTO {
	out := platform.CommentDTO{
		ID:        c.ID,
		Body:      c.Body,
		CreatedAt: c.Created,
		UpdatedAt: c.Updated,
	}
	if c.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  c.User.Login,
			AvatarURL: c.User.AvatarURL,
		}
		out.UserID = c.User.ID
	}
	return out
}

// ===== HTTP 请求封装 =====

// encodeJSONBody 把任意对象序列化为 io.Reader
//
// GiteaAdapter 现有方法都是 GET，v0.6+ PR 写入接口需要 POST/PATCH/PUT。
// 直接复用 doRequest 但需要 io.Reader 参数，故加这个 helper。
func encodeJSONBody(v any) (io.Reader, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("序列化 JSON body 失败: %w", err)
	}
	return strings.NewReader(string(b)), nil
}

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

	// v0.6+ bugfix：POST/PUT/PATCH 带 JSON body 时必须显式设 Content-Type。
	// Go http.NewRequest 在 body != nil 且未显式设 Content-Type 时，
	// 会默认 "Content-Type: application/x-www-form-urlencoded"
	// —— Gitea swagger 在 POST /comments 上检测 Content-Type 为 form-urlencoded，
	//   错报 422 "Empty Content-Type" （实际意思是"Gitea 期望 application/json"）。
	// GitHub adapter 同 bug 但 GitHub 后端对 form-urlencoded 宽客（自动检测 JSON），
	// Gitea 严格 → 在这里补一下。
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	// v0.6.1 log enhancement: 记录 HTTP 耗时、状态码（Bug 上报时 grep "HTTP" 一链可见）
	start := time.Now()
	resp, err := a.httpClient.Do(req)
	duration := time.Since(start)
	if err != nil {
		// 网络层错误（含 TLS、DNS、连接被拒、超时）
		// 包成 IpcError，code=network_offline，前端能识别为"网络问题"而非"未知错误"
		platform.LogHTTP(ctx, method, path, 0, duration, err)
		return ipc.NewNetworkOffline(fmt.Sprintf("Gitea %s %s: %s", method, fullURL, err.Error()))
	}
	defer resp.Body.Close()

	// 成功/失败都写 HTTP 日志（区分级别：成功 INFO/Debug，失败 WARN）
	platform.LogHTTP(ctx, method, path, resp.StatusCode, duration, nil)

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
			IsCurrent:   n.IsCurrent,
			IsStash:     n.IsStash,
			IsCommitted: n.IsCommitted,
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

	// 序列化 branches (vscode 风格: 一条 branch = 一条 SVG path)
	branches := make([]platform.GraphBranchDTO, 0, len(r.Branches))
	for _, b := range r.Branches {
		lines := make([]platform.GraphBranchLineDTO, 0, len(b.Lines))
		for _, ln := range b.Lines {
			lines = append(lines, platform.GraphBranchLineDTO{
				X1:          ln.X1,
				Y1:          ln.Y1,
				X2:          ln.X2,
				Y2:          ln.Y2,
				LockedFirst: ln.LockedFirst,
				IsCommitted: ln.IsCommitted,
			})
		}
		branches = append(branches, platform.GraphBranchDTO{
			Color: b.Color,
			End:   b.End,
			Lines: lines,
		})
	}

	return &platform.GraphResult{
		Nodes:     nodes,
		Edges:     edges,
		Branches:  branches,
		MaxLane:   r.MaxLane,
		Truncated: r.Truncated,
	}
}

// GraphResultToDTOForTest 是 graphResultToDTO 的测试导出。
//
// graphResultToDTO 本身小写不可见,但根 package main 下的端到端 DTO 测试
// (app_gitgraph_dto_e2e_test.go)需要跨包调用它,故保留这个薄包装。
// 仅供测试使用,生产代码不要调。
func GraphResultToDTOForTest(r *graph.GraphResult) *platform.GraphResult {
	return graphResultToDTO(r)
}
