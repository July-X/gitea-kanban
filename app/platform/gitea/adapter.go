// Package gitea 实现 PlatformAdapter 的 Gitea 版本。
//
// 用 Go net/http 调 Gitea REST API（/api/v1），替代旧版 gitea-js TS 客户端。
// 鉴权：Authorization: token <pat>（Gitea 习惯，不是 OAuth2 Bearer）。
// HTTP 错误映射沿用旧版 httpErrorToIpcError 表。
package gitea

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/logx"
	"gitea-kanban/app/platform"
	gogit "github.com/go-git/go-git/v5"
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
		Token:     opts.Token,
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
	graphResult.LocalExhausted = logResult.LocalExhausted
	graphResult.DeepenTriggered = logResult.DeepenTriggered

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
	// v0.7.6：PR 头部分支显示 "请求将 N 次代码提交从 {head} 合并至 {base}" 用
	// 对齐 Gitea web `templates/repo/issue/view_title.tmpl` 渲染。
	Commits            int                 `json:"commits"`
	Body               string              `json:"body"`
	MergedBy           *giteaUserRaw       `json:"merged_by"`
	// v0.7.8：merge commit SHA —— Gitea 1.26+ timeline 端点 `merge_pull` 事件
	// body 是空字符串（不像 v0.7.6 假设的 "merged commit {sha} into {branch}"），
	// 拿 merge commit SHA 只能从 PR 详情端点 `/repos/{owner}/{repo}/pulls/{index}`
	// 的 `merge_commit_sha` 字段。前端 timeline 渲染 merge 事件 inline 块时拿这个字段。
	MergeCommitSHA     string              `json:"merge_commit_sha,omitempty"`
	CreatedAt          string              `json:"created_at"`
	UpdatedAt          string              `json:"updated_at"`
}

type giteaPullRefRaw struct {
	// v0.7.9：Label 字段 —— 真实分支名（去掉 refs/heads/ 前缀）
	// Gitea web PR header 用这个字段渲染分支名（对齐 `templates/repo/issue/view_title.tmpl`）
	// Ref 字段保留（git ref 全路径），Label 缺失时模板用 Ref 兜底
	Label string `json:"label,omitempty"`
	Ref   string `json:"ref"`
	SHA   string `json:"sha"`
}

type giteaUserRaw struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	// FullName 是 Gitea 的 DisplayName（用户在 Gitea web 显示成 M4JAVA 这种）。
	// Gitea web shared/user/authorlink.tmpl 优先用 .FullName 渲染用户名，
	// 我们 v0.7.4 也对齐这个行为（之前只用 Login，display name 用户看着不一样）。
	FullName  string `json:"full_name"`
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
		Head:          platform.PullRefDTO{Ref: p.Head.Ref, Label: p.Head.Label, SHA: p.Head.SHA},
		Base:          platform.PullRefDTO{Ref: p.Base.Ref, Label: p.Base.Label, SHA: p.Base.SHA},
		Mergeable:     p.Mergeable,
		HasConflicts:  !p.Mergeable,
		Body:          p.Body,
		CommentsCount: p.Comments,
		Commits:       p.Commits, // v0.7.6：PR header "请求将 N 次代码提交从 {head} 合并至 {base}" 用
		// v0.7.8：merge 事件 commit SHA 链接用 —— timeline 端点 merge_pull body 是空，
		// 拿这个字段兜底。PR 未合并时为空字符串（omitempty），前端模板 v-if 跳过。
		MergeCommitSHA: p.MergeCommitSHA,
		CreatedAt:     p.CreatedAt,
		UpdatedAt:     p.UpdatedAt,
	}
	if p.User != nil {
		out.Author = &platform.PullUserDTO{Username: p.User.Login, FullName: p.User.FullName, AvatarURL: p.User.AvatarURL}
	}
	if p.MergedBy != nil {
		out.MergedBy = &platform.PullUserDTO{Username: p.MergedBy.Login, FullName: p.MergedBy.FullName, AvatarURL: p.MergedBy.AvatarURL}
	}
	if len(p.Assignees) > 0 {
		out.Assignees = make([]platform.PullUserDTO, 0, len(p.Assignees))
		for _, u := range p.Assignees {
			out.Assignees = append(out.Assignees, platform.PullUserDTO{Username: u.Login, FullName: u.FullName, AvatarURL: u.AvatarURL})
		}
	}
	if len(p.RequestedReviewers) > 0 {
		out.Reviewers = make([]platform.PullUserDTO, 0, len(p.RequestedReviewers))
		for _, u := range p.RequestedReviewers {
			out.Reviewers = append(out.Reviewers, platform.PullUserDTO{Username: u.Login, FullName: u.FullName, AvatarURL: u.AvatarURL})
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
		"merge_style_field":         style,
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
// v0.6.0 支持多人 assignees
func (a *GiteaAdapter) UpdatePullAssignee(ctx context.Context, hostURL, username, token, owner, repo string, index int, assignees []string) (*platform.PullDetailDTO, error) {
	cur, err := a.GetPull(ctx, hostURL, username, token, owner, repo, index)
	if err != nil {
		return nil, err
	}
	existing := make([]string, 0, len(cur.Assignees))
	for _, u := range cur.Assignees {
		existing = append(existing, u.Username)
	}
	target := make(map[string]bool, len(assignees))
	for _, u := range assignees {
		target[u] = true
	}
	toRemove := []string{}
	for _, u := range existing {
		if !target[u] {
			toRemove = append(toRemove, u)
		}
	}
	toAdd := []string{}
	for _, u := range assignees {
		found := false
		for _, e := range existing {
			if e == u {
				found = true
				break
			}
		}
		if !found {
			toAdd = append(toAdd, u)
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

// UpdatePullTitle 修改合并请求标题（v0.7.25 WIP toggle 用）
//
// Gitea 走 PATCH /repos/{owner}/{repo}/issues/{index} body {"title": "new title"}
// （PR 在 Gitea API 里也是 issue 端点）。返回更新后的 PullDetailDTO。
func (a *GiteaAdapter) UpdatePullTitle(ctx context.Context, hostURL, username, token, owner, repo string, index int, title string) (*platform.PullDetailDTO, error) {
	body := map[string]any{"title": title}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, nil); err != nil {
		return nil, err
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// GetPullCommitsBehind 拿"基础分支领先 head 分支的提交数"（v0.7.26）
//
// Gitea 走 GET /repos/{owner}/{repo}/compare/{head}...{base}，
// response.total_commits 就是 commits_behind。
//   - 注意 Git diff `A...B` 三点语法：列出"从 B 可达但 A 不可达"的 commit
//   - 我们传 `{head}...{base}` = 列出"base 领先 head"的提交 = commits_behind
//   - PR #74 实测：head=conflict-same-line-106921, base=main → total_commits=53
//
// 失败（API 错误 / 仓库无 compare 端点 / 跨 fork 私有仓库权限）时返 0，
// 前端按"没过期"渲染（v-if="commitsBehind > 0" 不显示警告行）。
func (a *GiteaAdapter) GetPullCommitsBehind(ctx context.Context, hostURL, username, token, owner, repo, base, head string) (int, error) {
	// 防御：head / base 不能为空，否则 Gitea 返 500
	if head == "" || base == "" {
		return 0, nil
	}
	path := fmt.Sprintf("/repos/%s/%s/compare/%s...%s", owner, repo, head, base)
	var resp struct {
		TotalCommits int `json:"total_commits"`
	}
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &resp); err != nil {
		// compare 端点失败（404 跨 fork 私有仓库 / 500 等）按 0 兜底
		// 不让 timeline 加载因为 compare 失败而整体挂掉
		return 0, nil
	}
	return resp.TotalCommits, nil
}

// UpdatePullBranch 更新 head 分支（v0.7.26 "通过合并更新分支"按钮用）
//
// Gitea 走 POST /repos/{owner}/{repo}/pulls/{index}/update?style={merge|rebase}
// style 参数：
//   - "merge"（默认）：把 base 合并到 head（merge commit）
//   - "rebase"：把 head 变基到 base（replay commits）
//
// 失败：返 401/403/409（permission/分支保护）等错误让前端 toast 显示。
// 成功后重拉 PR 详情（head ref SHA 已变），前端展示新 commits_behind = 0。
func (a *GiteaAdapter) UpdatePullBranch(ctx context.Context, hostURL, username, token, owner, repo string, index int, style string) (*platform.PullDetailDTO, error) {
	// style 兜底：Gitea 默认 merge（无 style 时 backend 走 repo 的 DefaultUpdateStyle）
	if style == "" {
		style = "merge"
	}
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/update?style=%s", owner, repo, index, style)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, nil, nil); err != nil {
		return nil, err
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// RestorePullBranch 恢复被删的 head 分支（v0.7.28）
//
// Gitea 端点：POST /repos/{owner}/{repo}/git/refs
// body: {"ref": "refs/heads/{branch}", "sha": "{commit_sha}"}
//   - branch: 不带 refs/heads/ 前缀
//   - sha: 任意 commit SHA（PR 详情 head.sha 即可）
//
// 成功返 201 Created；分支已存在返 422（提示用户"分支已存在，无需恢复"）。
func (a *GiteaAdapter) RestorePullBranch(ctx context.Context, hostURL, username, token, owner, repo, branch, sha string) error {
	if strings.TrimSpace(branch) == "" {
		return ipc.NewValidationFailed("分支名不能为空", "")
	}
	if strings.TrimSpace(sha) == "" {
		return ipc.NewValidationFailed("commit SHA 不能为空", "")
	}
	payload := map[string]any{
		"ref": "refs/heads/" + branch,
		"sha": sha,
	}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/repos/%s/%s/git/refs", owner, repo)
	return a.doRequest(ctx, hostURL, token, "POST", path, reader, nil)
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

// ===== 里程碑（v0.6.0） =====

// giteaMilestoneRaw Gitea 里程碑原始响应
type giteaMilestoneRaw struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	State       string `json:"state"`
	Description string `json:"description"`
}

// ListMilestones 列出仓库里程碑（GET /repos/{owner}/{repo}/milestones?state=open|closed|all）
func (a *GiteaAdapter) ListMilestones(ctx context.Context, hostURL, username, token, owner, repo string, state string) ([]platform.MilestoneDTO, error) {
	if state == "" {
		state = "open"
	}
	var raw []giteaMilestoneRaw
	path := fmt.Sprintf("/repos/%s/%s/milestones?state=%s", owner, repo, state)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.MilestoneDTO, 0, len(raw))
	for _, r := range raw {
		out = append(out, platform.MilestoneDTO{
			ID:          r.ID,
			Title:       r.Title,
			State:       r.State,
			Description: r.Description,
		})
	}
	return out, nil
}

// giteaMilestoneToDTO 把 giteaMilestoneRaw 映射到 platform.MilestoneDTO
// （v0.7.2 timeline 解析复用）
func giteaMilestoneToDTO(r giteaMilestoneRaw) platform.MilestoneDTO {
	return platform.MilestoneDTO{
		ID:          r.ID,
		Title:       r.Title,
		State:       r.State,
		Description: r.Description,
	}
}

// UpdatePullMilestone 给合并请求关联里程碑（PATCH /repos/{owner}/{repo}/pulls/{index} {"milestone": <title>|""}）
func (a *GiteaAdapter) UpdatePullMilestone(ctx context.Context, hostURL, username, token, owner, repo string, index int, milestone string) (*platform.PullDetailDTO, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, index)
	body := map[string]any{"milestone": milestone}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	var raw giteaPullRaw
	if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
		return nil, err
	}
	d := giteaPullToDetail(raw)
	return &d, nil
}

// ===== 合并请求评论（v0.6+） =====
//
// Gitea 端点：/repos/{owner}/{repo}/issues/{index}/comments
// 重要：Gitea 上 PR 和 issue 共享同一编号空间，所以 PR 评论走 issue comments 端点
// （与 GitHub 习惯一致 —— GitHub 上 PR 就是 issue）。

// ListPullComments 列合并请求评论（GET /repos/{owner}/{repo}/issues/{index}/comments）
//
// v0.7.x 重构：对齐 Gitea web 行为——返回所有 type 的评论（含 type=21 review body、
// type=22 review event record、type=1/2 REOPEN/CLOSE、type=28 MERGE、type=4 COMMIT_REF 等）。
//
// Gitea web 在 `templates/repo/issue/view_content/comments.tmpl` 端遍历所有 comments
// 并按 type 渲染不同卡片（普通评论 / 评审事件 / 系统事件等），不在服务端过滤。
// 前端用 comments[i].Type 字段决定如何渲染：type=0/21 渲染普通评论卡，type=22
// 跟 reviews 端点配合渲染评审 event+body，type=其他渲染对应系统事件卡。
//
// 旧 db84089 版本在服务端过滤 type != 0，导致 Gitea web 显示的 review body
// (type=21 评论) 和评审事件 (type=22 跟 reviews 端点组合) 都丢失, 与 Gitea web 行为不一致。
func (a *GiteaAdapter) ListPullTimeline(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.TimelineItem, error) {
	var raw []giteaTimelineRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/timeline", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.TimelineItem, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaTimelineToItem(r))
	}
	return out, nil
}

// ListPullComments 列合并请求评论（GET /repos/{owner}/{repo}/issues/{index}/comments）
// 只返回 type=0 普通评论。系统事件走 ListPullTimeline。
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

// giteaTimelineRaw Gitea /issues/{index}/timeline 端点原始响应
//
// v0.7.2 增量：把 Gitea /timeline 暴露的二级详情字段都加上，对齐 Gitea web
// `services/convert/issue_comment.go:ToTimelineComment` 输出的结构。
// 这些字段在不同 type 下含义不同（前缀 OldXxx 表示"变化前"，无前缀的是"变化后/当前"）：
//
//   - type=7 (label):        Label
//   - type=8 (milestone):    OldMilestone / Milestone
//   - type=9 (assignees):    Assignee + RemovedAssignee（true=移除，false=添加）
//   - type=10 (change_title): OldTitle / NewTitle
//   - type=11/25/33:         OldRef / NewRef
//   - type=3/5/6/33:         RefIssue + RefAction
//   - type=4 (commit_ref):   RefCommitSHA
//   - type=19/20:            DependentIssue
//
// 不暴露字段：AddedLabels / RemovedLabels（每次只一个 Label）、Commits 列表（xorm:"-" 服务端字段）、
// IsForcePush（同样是 xorm:"-"），这些是 Gitea web 端模板直渲染用，API 没暴露，
// 对应系统事件卡显示完整 detail 有数据缺口（Push 只能显示"N 提交"文案，没有列表）。
type giteaTimelineRaw struct {
	ID           int64              `json:"id"`
	Type         string             `json:"type"`
	Body         string             `json:"body"`
	// v0.7.6：type=7 (label) 事件时存 "1"=add / 其他=remove（用于前端聚合）。
	// 对应 Gitea 源码 `models/issues/comment.go: Content` 字段在 label change 时
	// 写 "1" 表示添加，写 label name 表示移除（罕见，用其他值兜底）。
	//
	// v0.7.19 根因修复：Gitea 1.26+ timeline 端点 (`/issues/{index}/timeline`)
	// label 事件**没有 `content` 字段**——label add/remove 信息在 `body` 字段
	//（值为 "1" 表示 add，其他值/空串表示 remove）。实测 pr72/pr81 timeline 数据：
	//   type="label", body="1", label={bug, feature, needs-review, 测试tag, 进行中}
	// v0.7.6 写代码时把字段名搞错了（`r.Content` 永远空串，因为 API 没 content 字段），
	// 导致判断走 else 分支永远填 RemovedLabels + LabelAction="remove"，前端 verb
	// 显示"移除了标签"，跟 Gitea web "添加了标签" 相反。
	//
	// 修法 v0.7.19：直接用上面已定义的 `r.Body` 字段判断（不要新加 Content 字段——
	// 加 Content 字段 json tag 改 "body" 会跟 Body 字段冲突，Go json.Unmarshal
	// 同一 tag 多个字段会全部不填值，实测 /tmp/test_json.go 确认）。把 label 判断
	// 改成 `r.Body == "1"` 即可。如果未来 Gitea 版本改字段名，跟踪 gitea 源码
	// `models/issues/comment.go` 即可。
	User          *giteaUserRaw      `json:"user"`
	Created       string             `json:"created_at"`
	Updated       string             `json:"updated_at"`
	State         string             `json:"state,omitempty"`
	CommitID      string             `json:"commit_id,omitempty"`
	Official      bool               `json:"official,omitempty"`
	CommitSHA     string             `json:"commit_sha,omitempty"`
	OldTitle      string             `json:"old_title,omitempty"`
	NewTitle      string             `json:"new_title,omitempty"`
	OldRef        string             `json:"old_ref,omitempty"`
	NewRef        string             `json:"new_ref,omitempty"`
	Label         *giteaPullLabelRaw `json:"label,omitempty"`
	OldMilestone  *giteaMilestoneRaw `json:"old_milestone,omitempty"`
	Milestone     *giteaMilestoneRaw `json:"milestone,omitempty"`
	Assignee      *giteaUserRaw      `json:"assignee,omitempty"`
	// AssigneeTeam: Gitea 有，但 platform 包当前没有 TeamDTO，v0.7.2 不暴露（保留扩展位）
	RemovedAssignee bool              `json:"removed_assignee,omitempty"`
	RefIssue        *giteaIssueRefRaw `json:"ref_issue,omitempty"`
	RefAction       string            `json:"ref_action,omitempty"`
	RefCommitSHA    string            `json:"ref_commit_sha,omitempty"`
	DependentIssue  *giteaIssueRefRaw `json:"dependent_issue,omitempty"`
	// v0.7.8：删 4 个无用独立字段。
	// v0.7.7 假设 Gitea 端会返回 old_commit_id / new_commit_id / commits_num / is_force_push
	// 4 个顶层独立字段，实际 Gitea 1.26+ API 这 4 个字段**全部不返回**：
	//   - OldCommit / NewCommit / CommitsNum: Gitea timeline 端点根本不返回
	//   - IsForcePush: 实际在 body JSON 字符串里（见下方 `giteaTimelineToItem` 解析）
	// 真实 commit 数据从 body JSON 解析（"commit_ids" 数组 + "is_force_push" 布尔）。
}

// giteaIssueRefRaw timeline 上下文里的 issue 引用（type=3/5/6/19/20/33 都用）
//
// 对应 Gitea api.Issue 结构的子集。is_pull 字段不存在，由 PullRequest 字段 != nil 推导。
// RepoID / RepoFullName 从嵌套的 RepositoryMeta 拿（json: "repository"），前端用
// platform.IssueDTO.RepoID / RepoFullName 表达。
type giteaIssueRefRaw struct {
	ID    int64  `json:"id"`
	Index int64  `json:"number"`
	Title string `json:"title"`
	State string `json:"state"`
	// PullRequest 字段为 nil → issue，!= nil → PR
	PullRequest *struct{} `json:"pull_request,omitempty"`
	Repository  *struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
	} `json:"repository,omitempty"`
}

func giteaTimelineToItem(r giteaTimelineRaw) platform.TimelineItem {
	item := platform.TimelineItem{
		ID:              r.ID,
		Type:            r.Type,
		Body:            r.Body,
		Created:         r.Created,
		Updated:         r.Updated,
		State:           r.State,
		CommitID:        r.CommitID,
		Official:        r.Official,
		CommitSHA:       r.CommitSHA,
		OldTitle:        r.OldTitle,
		NewTitle:        r.NewTitle,
		OldRef:          r.OldRef,
		NewRef:          r.NewRef,
		RefAction:       r.RefAction,
		RefCommitSHA:    r.RefCommitSHA,
		RemovedAssignee: r.RemovedAssignee,
	}

	// v0.7.8：类型归一化 —— Gitea 1.26+ timeline 端点 push / merge 事件 type 字符串
	// 是 snake_case（"pull_push" / "merge_pull"），前端 type 字典表用的是
	// "push" / "merge"（v0.7.5/v0.7.7 凭印象写的没实测过 API）。归一化在适配层做，
	// 前端 type 字符串保持稳定（不需要改 systemEventVerb / 模板 / systemEventIcon 等）。
	if r.Type == "pull_push" {
		item.Type = "push"
	} else if r.Type == "merge_pull" {
		item.Type = "merge"
	}

	// v0.7.22 根因修复：review event state 字段推断 —— Gitea 1.26+ timeline 端
	// review event `state` 字段恒为 null（实测 pr74 id=578 / id=579 都 null）。
	// Gitea API `/pulls/{index}/reviews` 端点返空数组 + `/pulls/{index}/reviews/{id}`
	// 端点 500 Internal Server Error（Gitea 1.26+ bug），无法直接拿 state。
	//
	// 临时方案：从 review body 关键词推断 state（master 端用，Gitea web 端用
	// 后端关联 review 表拿 state 但 SPA 拿不到）。关键词：
	//   - "approved" / "approve" / "lgtm" / "looks good" / "looks great" →
	//     state="approved"
	//   - "request changes" / "request_change" / "blocking" / "needs changes" /
	//     "needs to be changed" → state="changes_requested"
	//   - 其他 → state="commented"
	//
	// 限制：关键词不匹配 Gitea web 后端逻辑（看 `services/pull/review.go`），
	// 但能 cover 大多数 Gitea web UI 提交的场景（approve / request changes /
	// comment 3 个按钮 + 自定义 body）。等 Gitea 1.26+ reviews 端点修好后再
	// 改成后端查 review_id 拿 state（更准确）。
	if item.Type == "review" {
		body := strings.ToLower(item.Body)
		switch {
		case strings.Contains(body, "approved") || strings.Contains(body, "approve") || strings.Contains(body, "lgtm") || strings.Contains(body, "looks good") || strings.Contains(body, "looks great"):
			item.State = "approved"
		case strings.Contains(body, "request changes") || strings.Contains(body, "request_change") || strings.Contains(body, "blocking") || strings.Contains(body, "needs changes") || strings.Contains(body, "needs to be changed"):
			item.State = "changes_requested"
		default:
			item.State = "commented"
		}
	}

	// v0.7.8：push 事件 commit 信息从 body JSON 字符串解析。
	// 根因：v0.7.7 假设 Gitea timeline 端点顶层会返 old_commit_id / new_commit_id /
	// commits_num / is_force_push 4 个独立字段，实际 Gitea 1.26+ API 这 4 个字段全不返回，
	// 真实数据在 `body` JSON 字符串里（`{"is_force_push":false,"commit_ids":["sha1"]}`）。
	// Gitea web 端模板 `repo/issue/view_content/comments.tmpl` 就是用 `commit_ids` 数组
	// 渲染 commit 列表的，我们对齐这个行为。
	if item.Type == "push" && r.Body != "" {
		var pushPayload struct {
			IsForcePush bool     `json:"is_force_push"`
			CommitIDs   []string `json:"commit_ids"`
		}
		// 解析失败（如 body 不是合法 JSON）静默忽略 —— 旧 Gitea 版本（<= 1.25）push event
		// body 可能是 "added N commits {time}" 文本格式（type 字符串也是 "push" 不是 "pull_push"），
		// 走不到这条路径。如果未来需要兼容旧版，可以加更宽松的解析。
		if err := json.Unmarshal([]byte(r.Body), &pushPayload); err == nil {
			item.IsForcePush = pushPayload.IsForcePush
			item.CommitIDs = pushPayload.CommitIDs
		}
	}

	if r.User != nil {
		item.Author = &platform.PullUserDTO{
			Username:  r.User.Login,
			FullName:  r.User.FullName,
			AvatarURL: r.User.AvatarURL,
		}
	}
	if r.Label != nil {
		item.Label = &platform.PullLabelDTO{
			ID:    r.Label.ID,
			Name:  r.Label.Name,
			Color: r.Label.Color,
		}
		// v0.7.6：label 事件按 add/remove 方向填到 AddedLabels/RemovedLabels 单元素数组
		// （前端 timeline store 会按"同作者 + 60s 内连续 label 事件"聚合对齐 Gitea web）
		label := platform.PullLabelDTO{
			ID:    r.Label.ID,
			Name:  r.Label.Name,
			Color: r.Label.Color,
		}
		if r.Body == "1" {
			item.AddedLabels = []*platform.PullLabelDTO{&label}
			item.LabelAction = "add"
		} else {
			item.RemovedLabels = []*platform.PullLabelDTO{&label}
			item.LabelAction = "remove"
		}
	}
	if r.OldMilestone != nil {
		dto := giteaMilestoneToDTO(*r.OldMilestone)
		item.OldMilestone = &dto
	}
	if r.Milestone != nil {
		dto := giteaMilestoneToDTO(*r.Milestone)
		item.Milestone = &dto
	}
	// v0.7.6：WIP toggle 检测 —— type=10 (change_title) 改标题事件可能是
	// "拖 draft toggle 按钮" 触发的特殊事件，需要单独标记让前端渲染不同文案。
	// 对齐 Gitea 源码 `models/issues/pull.go: CutWorkInProgressPrefix` +
	// `modules/templates/util_render_comment.go: commentTimelineEventIsWipToggle`。
	if r.Type == "change_title" {
		isToggle, isWip := isWipToggleEvent(r.OldTitle, r.NewTitle)
		item.IsWipToggle = isToggle
		item.IsWip = isWip
	}
	if r.Assignee != nil {
		item.Assignee = &platform.PullUserDTO{
			Username:  r.Assignee.Login,
			FullName:  r.Assignee.FullName,
			AvatarURL: r.Assignee.AvatarURL,
		}
	}
	if r.RefIssue != nil {
		item.RefIssue = giteaIssueRefToDTO(r.RefIssue)
	}
	if r.DependentIssue != nil {
		item.DependentIssue = giteaIssueRefToDTO(r.DependentIssue)
	}
	return item
}

// WIP 前缀列表 —— 对齐 Gitea `setting.Repository.PullRequest.WorkInProgressPrefixes` 默认值
//
// v0.7.6 注：Gitea 服务端默认 ["WIP:", "Draft:"]，但用户可在 app.ini 改。
// 我们客户端没法动态知道服务端的 custom 列表，只能用默认两份做兼容。
// 若用户配置了自定义前缀（如 "[WIP]"），WIP toggle 会降级到普通"修改了标题"渲染
// —— 视觉上能区分（修改标题会显示 oldTitle → newTitle；WIP toggle 不会），
// 但文案会错。v0.7.6 接受这个 limitation，v0.7.7 计划从 Gitea /api/v1/settings
// 拉服务端 prefix 列表（需要 admin 权限，应用层用 mock 兜底）。
var giteaWipPrefixes = []string{"WIP:", "Draft:"}

// cutWipPrefix 模仿 Gitea `CutWorkInProgressPrefix` 行为：
// 返回 (去掉前缀的标题, 是否有前缀)
func cutWipPrefix(title string) (string, bool) {
	for _, prefix := range giteaWipPrefixes {
		if len(title) >= len(prefix) && strings.EqualFold(title[:len(prefix)], prefix) {
			return title[len(prefix):], true
		}
	}
	return title, false
}

// isWipToggleEvent 判断改标题事件是否是"切换 WIP / Ready for review"操作
//
// 返回：
//   - isToggle: 是否命中 WIP toggle 特殊渲染
//     （OldTitle/NewTitle 一边有前缀一边没，且去掉前缀后内容相同）
//   - isWip: 切换后是否是 WIP 状态（NewTitle 有前缀）
//
// 对齐 Gitea `modules/templates/util_render_comment.go: commentTimelineEventIsWipToggle` 行为。
func isWipToggleEvent(oldTitle, newTitle string) (isToggle, isWip bool) {
	title1, ok1 := cutWipPrefix(oldTitle)
	title2, ok2 := cutWipPrefix(newTitle)
	if ok1 == ok2 {
		return false, false // 两边都带或都不带 → 普通标题修改
	}
	if strings.TrimSpace(title1) != strings.TrimSpace(title2) {
		return false, false // 去掉前缀后内容不同 → 普通标题修改（不是单纯 toggle）
	}
	return true, ok2 // 切换后 NewTitle 有前缀 = 进入 WIP 状态
}

// giteaIssueRefToDTO 把 giteaIssueRefRaw 映射到 platform.IssueDTO
func giteaIssueRefToDTO(r *giteaIssueRefRaw) *platform.IssueDTO {
	dto := &platform.IssueDTO{
		Index: int(r.Index),
		Title: r.Title,
		State: r.State,
	}
	if r.PullRequest != nil {
		dto.IsPull = true
	}
	if r.Repository != nil {
		dto.RepoID = r.Repository.ID
		dto.RepoFullName = r.Repository.FullName
	}
	return dto
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
//
// ⚠️ Gitea 1.26.2 实际返回的 JSON 字段是 `content`（不是 `reaction`），
// 且不包含 `id` 字段。旧版代码误用 `reaction` 作为 JSON key，导致
// Reaction.Content 始终为空字符串 → 前端 groupedReactions 匹配不到
// 任何表情 → ReactionBar 不显示任何表情。
//
// 实测 Gitea 1.26.2 响应格式：
//
//	[{"user":{...},"content":"rocket","created_at":"..."}]
type giteaReactionRaw struct {
	ID      int64         `json:"id"`
	User    *giteaUserRaw `json:"user"`
	Content string        `json:"content"` // Gitea 1.26.2 实际字段名
}

// giteaReactionToDTO 映射为平台中性 ReactionDTO
func giteaReactionToDTO(r giteaReactionRaw) platform.ReactionDTO {
	out := platform.ReactionDTO{
		ID:      r.ID,
		Content: r.Content,
	}
	if r.User != nil {
		out.User = &platform.PullUserDTO{
			Username:  r.User.Login,
			FullName:  r.User.FullName,
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
//
// ⚠️ Gitea 1.26.2 实际返回的 JSON 日期字段名是 `submitted_at`（不是 `submitted`）。
// 旧版代码用 `submitted` 导致 SubmittedAt 始终为空字符串 →
// timelineItems 排序时 new Date(”) = Invalid Date → 评审卡片排在错误位置。
type giteaReviewRaw struct {
	ID          int64         `json:"id"`
	State       string        `json:"state"`
	Body        string        `json:"body"`
	User        *giteaUserRaw `json:"user"`
	CommitID    string        `json:"commit_id"`
	SubmittedAt string        `json:"submitted_at"` // Gitea 1.26.2 实际字段名
}

// giteaReviewToDTO 映射为平台中性 PullReviewDTO
//
// 关键：Gitea 1.22+ 返回 state 是大写（APPROVED / PENDING / COMMENT / REQUEST_CHANGES / REQUEST_REVIEW），
// 必须归一化到前端约定的小写 3 种值（approved / changes_requested / commented），
// 否则 reviewStateLabel 会 fallthrough 显示原文、CSS class 不匹配、review 头像永远显示 💬。
func giteaReviewToDTO(r giteaReviewRaw) platform.PullReviewDTO {
	out := platform.PullReviewDTO{
		ID:          r.ID,
		State:       platform.NormalizeReviewState(r.State),
		Body:        r.Body,
		CommitID:    r.CommitID,
		SubmittedAt: r.SubmittedAt,
	}
	if r.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  r.User.Login,
			FullName:  r.User.FullName,
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

func giteaReviewCommentFromOpts(opts platform.CreateReviewCommentOpts) map[string]any {
	return map[string]any{
		"body":         opts.Body,
		"path":         opts.Path,
		"new_position": opts.Position,
	}
}

// ListPullReviews 列评审列表（GET /repos/{owner}/{repo}/pulls/{index}/reviews）
//
// limit=50 确保不因 Gitea 默认分页（30 条/页）丢失评审记录。
// 单 PR 评审数通常 < 20，50 足够覆盖；超大批量场景待后续按需分页。
func (a *GiteaAdapter) ListPullReviews(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullReviewDTO, error) {
	var raw []giteaReviewRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews?limit=50", owner, repo, index)
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
	comments := make([]map[string]any, 0, len(opts.Comments))
	for _, c := range opts.Comments {
		comments = append(comments, giteaReviewCommentFromOpts(c))
	}
	payload := map[string]any{
		"commit_id": opts.CommitID,
		"body":      opts.Body,
		"event":     opts.Event,
		"comments":  comments,
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
// 字段只取必要项：id / body / user / created_at / updated_at / type。
//
// ⚠️ Gitea 1.26.2 实际返回的 JSON 日期字段名是 `created_at` / `updated_at`
// （不是 `created` / `updated`）。旧版代码用错误字段名导致日期始终为空 →
// timelineItems 排序时 new Date(”) = Invalid Date → 评论顺序乱。
//
// type 字段：Gitea CommentType 常量（API 不返回此字段，默认 0）
//
//	0  = CommentTypePlain（普通评论）
//	21 = CommentTypeReview（评审总结文，提交 review 时自动创建）
//	22 = CommentTypeReviewComment（行内代码评审评论）
//	其它类型：系统事件（rebase / commit / title change 等），不渲染
//
// 复用上面已定义的 giteaUserRaw（line 338），不在这里重复定义。
type giteaCommentRaw struct {
	ID        int64         `json:"id"`
	Body      string        `json:"body"`
	User      *giteaUserRaw `json:"user"`
	CreatedAt string        `json:"created_at"` // Gitea 1.26.2 实际字段名
	UpdatedAt string        `json:"updated_at"` // Gitea 1.26.2 实际字段名
	Type      int           `json:"type"`
}

// giteaCommentToDTO 映射为平台中性 CommentDTO
func giteaCommentToDTO(c giteaCommentRaw) platform.CommentDTO {
	out := platform.CommentDTO{
		ID:        c.ID,
		Body:      c.Body,
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
		Type:      c.Type, // v0.7.x: 透传 type 字段供前端分类渲染
	}
	if c.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  c.User.Login,
			FullName:  c.User.FullName,
			AvatarURL: c.User.AvatarURL,
		}
		out.UserID = c.User.ID
	}
	return out
}

// ===== PR 修改文件列表 (v0.5.0 M4) =====

// giteaPullFileRaw Gitea /pulls/{index}/files 原始响应
type giteaPullFileRaw struct {
	Filename         string `json:"filename"`
	Status           string `json:"status"`
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Changes          int    `json:"changes"`
	Patch            string `json:"patch,omitempty"`
	PreviousFilename string `json:"previous_filename"`
}

// giteaPullFileToDTO 映射为平台中性 PullFileDTO
func giteaPullFileToDTO(r giteaPullFileRaw) platform.PullFileDTO {
	return platform.PullFileDTO{
		Filename:         r.Filename,
		Status:           r.Status,
		Additions:        r.Additions,
		Deletions:        r.Deletions,
		Changes:          r.Changes,
		Patch:            r.Patch,
		PreviousFilename: r.PreviousFilename,
	}
}

// ListPullFiles 列出 PR 修改的文件列表 (GET /repos/{owner}/{repo}/pulls/{index}/files)
func (a *GiteaAdapter) ListPullFiles(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullFileDTO, error) {
	var raw []giteaPullFileRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/files", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		var ipcErr *ipc.IpcError
		if errors.As(err, &ipcErr) && ipcErr.Code == "NOT_FOUND" {
			return nil, platform.ErrNotSupported
		}
		return nil, err
	}
	out := make([]platform.PullFileDTO, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaPullFileToDTO(r))
	}
	return out, nil
}

// GetPullFileDiff 获取单个文件的 diff 内容（Gitea 拉完整 diff 后按文件拆分）
func (a *GiteaAdapter) GetPullFileDiff(ctx context.Context, hostURL, username, token, owner, repo string, index int, filePath string) (*platform.PullFileDiffDTO, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d.diff", owner, repo, index)
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(hostURL, "/")+"/api/v1"+path, nil)
	if err != nil {
		return nil, ipc.NewInternal("构造 Gitea 请求失败: " + err.Error())
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, ipc.NewNetworkOffline(fmt.Sprintf("Gitea GET pulls/%d.diff: %s", index, err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, ipc.NewInternal(fmt.Sprintf("Gitea diff %d 失败: %d %s", index, resp.StatusCode, string(body)))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, ipc.NewInternal("读取 diff 响应失败: " + err.Error())
	}

	fileDiff := a.splitDiffByFile(string(data), filePath)
	if fileDiff == nil {
		return nil, ipc.NewNotFound(fmt.Sprintf("文件 %s 在此 PR diff 中不存在", filePath))
	}
	return fileDiff, nil
}

// splitDiffByFile 把完整 unified diff 按文件头拆分为单个文件的 diff
func (a *GiteaAdapter) splitDiffByFile(fullDiff, targetPath string) *platform.PullFileDiffDTO {
	lines := strings.Split(fullDiff, "\n")

	fileLines := []string{}
	inTarget := false
	var currentHunk *platform.PullDiffHunk
	hunks := []platform.PullDiffHunk{}
	hunkRegexp := regexp.MustCompile("^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@(.*)")

	for _, line := range lines {
		if strings.HasPrefix(line, "diff --git") {
			if inTarget && len(fileLines) > 0 {
				break
			}
			filePathFromDiff := ""
			parts := strings.SplitN(line, " ", 3)
			if len(parts) >= 3 {
				filePathFromDiff = strings.TrimPrefix(parts[2], "b/")
			}
			inTarget = (filePathFromDiff == targetPath)
			if inTarget {
				fileLines = append(fileLines, line)
			}
			continue
		}
		if !inTarget {
			continue
		}
		fileLines = append(fileLines, line)

		if matches := hunkRegexp.FindStringSubmatch(line); matches != nil {
			oldStart, _ := strconv.Atoi(matches[1])
			oldLines := 1
			if matches[2] != "" {
				oldLines, _ = strconv.Atoi(matches[2])
			}
			newStart, _ := strconv.Atoi(matches[3])
			newLines := 1
			if matches[4] != "" {
				newLines, _ = strconv.Atoi(matches[4])
			}
			hunk := platform.PullDiffHunk{
				OldStart: oldStart,
				OldLines: oldLines,
				NewStart: newStart,
				NewLines: newLines,
				Header:   "@@" + line[3:],
				Lines:    []string{},
			}
			hunks = append(hunks, hunk)
			currentHunk = &hunks[len(hunks)-1]
			continue
		}

		if currentHunk != nil && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "+") || strings.HasPrefix(line, "-")) {
			currentHunk.Lines = append(currentHunk.Lines, line)
		}
	}

	if !inTarget {
		return nil
	}
	return &platform.PullFileDiffDTO{
		Filename: targetPath,
		RawDiff:  strings.Join(fileLines, "\n"),
		Hunks:    hunks,
	}
}

// ===== HTTP 请求封装 =====

// ===== 行内评审评论 API (v0.5.0 M4) =====

// giteaReviewCommentRaw Gitea /pulls/{index}/comments 原始响应
type giteaReviewCommentRaw struct {
	ID      int64         `json:"id"`
	Body    string        `json:"body"`
	User    *giteaUserRaw `json:"user"`
	Path    string        `json:"path"`
	Line    int           `json:"new_position"`
	Created string        `json:"created_at"`
	Updated string        `json:"updated_at"`
}

// giteaReviewCommentToDTO 映射为平台中性 PullReviewCommentDto
func giteaReviewCommentToDTO(r giteaReviewCommentRaw) platform.PullReviewCommentDto {
	out := platform.PullReviewCommentDto{
		ID:        r.ID,
		Body:      r.Body,
		Path:      r.Path,
		Line:      r.Line,
		CreatedAt: r.Created,
		UpdatedAt: r.Updated,
	}
	if r.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  r.User.Login,
			FullName:  r.User.FullName,
			AvatarURL: r.User.AvatarURL,
		}
	}
	return out
}

// ListPullReviewComments 列行内评审评论 (GET /repos/{owner}/{repo}/pulls/{index}/comments)
func (a *GiteaAdapter) ListPullReviewComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullReviewCommentDto, error) {
	var raw []giteaReviewCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.PullReviewCommentDto, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaReviewCommentToDTO(r))
	}
	return out, nil
}

// CreatePullReviewComment 创建行内评审评论 (POST /repos/{owner}/{repo}/pulls/{index}/comments)
func (a *GiteaAdapter) CreatePullReviewComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string, filePath string, line int) (*platform.PullReviewCommentDto, error) {
	if strings.TrimSpace(body) == "" {
		return nil, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	payload := map[string]any{
		"body":         body,
		"path":         filePath,
		"new_position": line,
	}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaReviewCommentRaw
	apiPath := fmt.Sprintf("/repos/%s/%s/pulls/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", apiPath, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaReviewCommentToDTO(raw)
	return &dto, nil
}

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
// doMultipartRequest 走 multipart/form-data 的 Gitea 请求（v0.7.0 贴图支持）
//
// doRequest 默认 Content-Type: application/json,multipart 需要另一条路。
// Gitea attachment API (POST /repos/.../issues/{index}/assets) 要求 multipart/form-data
// 字段名是 'attachment'（不是 'file'），与 GitHub 的 'file' 字段名不同——
// 字段名翻译在调用方 UploadIssueAttachment 内部处理，helper 只负责构造 multipart body。
func (a *GiteaAdapter) doMultipartRequest(
	ctx context.Context, hostURL, token, method, path string,
	formFields map[string]string, fileField, fileName string, fileContent []byte,
	out interface{},
) error {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	// 先写普通 form 字段
	for k, v := range formFields {
		if err := writer.WriteField(k, v); err != nil {
			return ipc.NewInternal("构造 multipart form 失败: " + err.Error())
		}
	}
	// 写文件字段
	if fileContent != nil {
		part, err := writer.CreateFormFile(fileField, fileName)
		if err != nil {
			return ipc.NewInternal("构造 multipart 文件字段失败: " + err.Error())
		}
		if _, err := part.Write(fileContent); err != nil {
			return ipc.NewInternal("写 multipart 文件内容失败: " + err.Error())
		}
	}
	if err := writer.Close(); err != nil {
		return ipc.NewInternal("关闭 multipart writer 失败: " + err.Error())
	}

	base := strings.TrimRight(hostURL, "/")
	fullURL := base + "/api/v1" + path
	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return ipc.NewInternal("构造 Gitea multipart 请求失败: " + err.Error())
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", writer.FormDataContentType())

	start := time.Now()
	resp, err := a.httpClient.Do(req)
	duration := time.Since(start)
	if err != nil {
		platform.LogHTTP(ctx, method, path, 0, duration, err, logx.FromContext(ctx)...)
		return ipc.NewNetworkOffline(fmt.Sprintf("Gitea multipart %s %s: %s", method, fullURL, err.Error()))
	}
	defer resp.Body.Close()
	platform.LogHTTP(ctx, method, path, resp.StatusCode, duration, nil, logx.FromContext(ctx)...)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return mapHTTPError(resp.StatusCode, string(bodyBytes), fullURL)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return ipc.NewInternal("解析 Gitea multipart 响应失败: " + err.Error())
	}
	return nil
}

// giteaAttachmentRaw Gitea /repos/.../issues/{index}/assets 原始响应
type giteaAttachmentRaw struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	UUID               string `json:"uuid"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// giteaAttachmentToDTO 映射为平台中性 AttachmentDTO
func giteaAttachmentToDTO(a giteaAttachmentRaw) platform.AttachmentDTO {
	return platform.AttachmentDTO{
		ID:                 a.ID,
		Name:               a.Name,
		Size:               a.Size,
		UUID:               a.UUID,
		BrowserDownloadURL: a.BrowserDownloadURL,
	}
}

// UploadIssueAttachment 上传 PR/issue 附件（v0.7.0 贴图支持）
//
// Gitea 端点：POST /repos/{owner}/{repo}/issues/{index}/assets
//   - multipart/form-data，form field: attachment（注意不是 'file'）
//   - 响应：Gitea Attachment (id/name/size/uuid/browser_download_url)
//   - browser_download_url 形如 https://<host>/attachments/<uuid>，可直接塞到
//     markdown `![](url)` 让 Gitea 渲染。
//
// 回归证据：v0.7.0 之前 PR 评论贴图走前端 FileReader.readAsDataURL 转 data URI
// 嵌入 markdown，Gitea 服务端不存图片，渲染时只看到"贴图"占位符。
// 修复后走这条上传到 Gitea 的 attachments 表，markdown 引用真 url。
func (a *GiteaAdapter) UploadIssueAttachment(ctx context.Context, hostURL, username, token, owner, repo string, index int, fileName string, fileContent []byte) (*platform.AttachmentDTO, error) {
	if len(fileContent) == 0 {
		return nil, ipc.NewValidationFailed("附件内容不能为空", "")
	}
	var raw giteaAttachmentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/assets", owner, repo, index)
	if err := a.doMultipartRequest(
		ctx, hostURL, token, "POST", path,
		nil,                                 // 普通 form 字段
		"attachment", fileName, fileContent, // 文件字段
		&raw,
	); err != nil {
		return nil, err
	}
	dto := giteaAttachmentToDTO(raw)
	return &dto, nil
}

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
		platform.LogHTTP(ctx, method, path, 0, duration, err, logx.FromContext(ctx)...)
		return ipc.NewNetworkOffline(fmt.Sprintf("Gitea %s %s: %s", method, fullURL, err.Error()))
	}
	defer resp.Body.Close()

	// 成功/失败都写 HTTP 日志（区分级别：成功 INFO/Debug，失败 WARN）
	platform.LogHTTP(ctx, method, path, resp.StatusCode, duration, nil, logx.FromContext(ctx)...)

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
		Nodes:           nodes,
		Edges:           edges,
		Branches:        branches,
		MaxLane:         r.MaxLane,
		Truncated:       r.Truncated,
		LocalExhausted:  r.LocalExhausted,
		DeepenTriggered: r.DeepenTriggered,
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

// ===== PR 提交列表 =====

// giteaPullCommitRaw Gitea /pulls/{index}/commits 返回的原始 JSON 结构
type giteaPullCommitRaw struct {
	SHA    string `json:"sha"`
	Commit struct {
		Message string `json:"message"`
		Author  struct {
			Name  string `json:"name"`
			Email string `json:"email"`
			Date  string `json:"date"`
		} `json:"author"`
		Committer struct {
			Name string `json:"name"`
			Date string `json:"date"`
		} `json:"committer"`
		Verification struct {
			Verified bool `json:"verified"`
		} `json:"verification"`
	} `json:"commit"`
	HTMLURL string `json:"html_url"`
}

// ListPullCommits 列出 PR 中包含的提交 (GET /repos/{owner}/{repo}/pulls/{index}/commits)
func (a *GiteaAdapter) ListPullCommits(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullCommitDTO, error) {
	var raw []giteaPullCommitRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/commits", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		var ipcErr *ipc.IpcError
		if errors.As(err, &ipcErr) && ipcErr.Code == "NOT_FOUND" {
			return nil, platform.ErrNotSupported
		}
		return nil, err
	}
	out := make([]platform.PullCommitDTO, 0, len(raw))
	for _, r := range raw {
		sha := r.SHA
		shortSha := sha
		if len(shortSha) > 7 {
			shortSha = sha[:7]
		}
		// subject = message 第一行；body = 剩余行
		msg := r.Commit.Message
		subject := msg
		body := ""
		if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
			subject = msg[:idx]
			body = strings.TrimSpace(msg[idx+1:])
		}
		out = append(out, platform.PullCommitDTO{
			SHA:        sha,
			ShortSHA:   shortSha,
			Subject:    subject,
			Body:       body,
			AuthorName: r.Commit.Author.Name,
			AuthorMail: r.Commit.Author.Email,
			AuthoredAt: r.Commit.Author.Date,
			Committed:  r.Commit.Committer.Date,
			Verified:   r.Commit.Verification.Verified,
		})
	}
	return out, nil
}
