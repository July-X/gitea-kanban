// Package github 实现 PlatformAdapter 的 GitHub 版本。
//
// 支持范围（v2.x，v0.6+ 拓展）：
//   - VerifyToken：GET /user，Authorization: Bearer <token>
//   - ListRepos：GET /user/repos，列当前登录用户可访问的仓库（含 collaborator）
//   - CloneRepo：gh repo clone + partial clone（避免超大仓库下载 blob）
//   - LogGraph：vscode-git-graph 同款 git log 输入 + 自研 VSCode lane 布局
//   - ListPulls / GetPull / MergePull / ClosePull / UpdatePullLabels / UpdatePullAssignee / UpdatePullReviewers
//     v0.6+ 全量实现，对齐 Gitea adapter 业务语义
//   - ListIssues / ListLabels / ListMembers 仍返回 ErrNotSupported
//
// GitHub PAT scope 要求：
//   - ListRepos：classic PAT 勾选 repo（public_repo 不够拉 private 仓库）
//   - CloneRepo：classic PAT 勾选 repo（同上）
//   - 两者共用 repo scope 即可，首期最小权限。
package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform"
)

// GitHubAPIBase GitHub API 基础 URL
const GitHubAPIBase = "https://api.github.com"

// GitHubSiteBase GitHub 网站域名(给 doRequest 做归一化用)
//
// 关系:
//   - GitHubAPIBase = https://api.github.com    API endpoint(我们的 HTTP 请求用这个)
//   - GitHubSiteBase = https://github.com       网站域名(返回 HTML,Git Graph 不该走这个)
//
// 历史 bug:旧代码在 app.go 把 GitHub 平台的 GiteaURL 硬编码成 https://github.com
// 然后 VerifyToken / ListRepos 都拿这个 URL 去请求,实际拼成 https://github.com/user
// → 命中 GitHub 网站 HTML → 406 Not Acceptable(网站对 application/vnd.github+json 不接受)
//
// 现在 app.go 已经用 GitHubAPIBase,但**已存在的账号** localStore.GiteaURL 仍是
// 错的 "https://github.com",所以 normalizeGitHubHostURL 必须做归一化。
const GitHubSiteBase = "https://github.com"

// normalizeGitHubHostURL 把任何 github.com URL 归一化成 API endpoint
//
// 输入可能是以下几种,全部归一到 GitHubAPIBase:
//   - "https://github.com"              → "https://api.github.com"
//   - "https://github.com/"             → "https://api.github.com"
//   - "https://github.com/anything"     → "https://api.github.com"  (网站 URL 不该出现在这里)
//   - "https://api.github.com"          → 不变
//   - ""                                → GitHubAPIBase
//   - 自托管 GitHub Enterprise Server (https://github.acme.com)
//     → 不动,保留 host,只去掉 path
//
// 设计：用 url.Parse 提取 host,根据 host 判断
//   - github.com / www.github.com / api.github.com  → 归一到 GitHubAPIBase
//   - 自托管 GHES(其它 host)                       → 保留原 host
func normalizeGitHubHostURL(hostURL string) string {
	hostURL = strings.TrimSpace(hostURL)
	if hostURL == "" {
		return GitHubAPIBase
	}
	u, err := url.Parse(hostURL)
	if err != nil {
		// 解析失败 → 当成未知 host,原样返回(让后续 HTTP 报错)
		return hostURL
	}
	host := u.Host
	switch host {
	case "github.com", "www.github.com", "api.github.com":
		return GitHubAPIBase
	}
	// 自托管 GHES 或其它 host → 保留
	return hostURL
}

// GitHubAdapterVersion 发请求时塞进 User-Agent 的应用版本号
//
// 改版本号时同步更新 README + CHANGELOG.md
const GitHubAdapterVersion = "2.4.0"

// largeRepoGraphDepth GitHub 超大仓库初始浅克隆深度。
//
// v2.x 修复 July-X/UnrealEngine 渲染卡死：5000 会拉到 release 分支中段超宽 merge 历史
// （单行 1407 lane），前端渲染卡死。降到 2000：最近的提交 graph 很窄（列宽 ≤3），
// 更早历史交给用户手动「加载更多」（配合 RunGraphLog 的超宽 --first-parent 回退保护）。
const largeRepoGraphDepth = 2000

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
	hostURL = normalizeGitHubHostURL(hostURL)

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

// ===== 仓库 =====

// ListRepos 列出登录用户可访问的仓库（GET /user/repos）
//
// GitHub 的"可访问"含义：
//   - owner = 当前 PAT 持有者本人：owner 的所有 public + private
//   - collaborator：作为 collaborator 加入的仓库
//   - organization_member：通过 org 间接可访问的仓库
//   - 三个关系用 affiliation=owner,collaborator,organization_member 一次性拉回
//   - 默认排序：pushed desc（最近 push 在前）；前端不需要重排
//
// 鉴权：Bearer <token>，跟 VerifyToken 一致
// 鉴权失败（401/403）走 mapHTTPError → 友好 IpcError
//
// 分页 / 搜索：
//   - opts.Limit 映射 ?per_page=（GitHub 上限 100，默认 50）
//   - opts.Page 映射 ?page=
//   - opts.Query 在**客户端**做大小写不敏感模糊匹配（GitHub /user/repos
//     不支持服务端 q 参数，要搜全靠客户端过滤 —— 仓库量 < 上千够用）
//   - 客户端过滤后 hasMore 按"服务端返满 per_page"判断（与 Gitea adapter 对齐）
func (a *GitHubAdapter) ListRepos(ctx context.Context, hostURL, username, token string, opts platform.ListReposOpts) ([]platform.RepoDTO, error) {
	hostURL = normalizeGitHubHostURL(hostURL)

	perPage := opts.Limit
	if perPage <= 0 {
		perPage = 50
	}
	if perPage > 100 {
		// GitHub /user/repos 单页硬上限 100；超出截断
		perPage = 100
	}
	page := opts.Page
	if page <= 0 {
		page = 1
	}

	// 三个 affiliation 全要：让登录用户能拉到 collaborator + org member 的仓库
	// 而不仅是 owner 自己 —— "想看哪个仓库就能同步哪个"是产品目标
	params := url.Values{}
	params.Set("per_page", strconv.Itoa(perPage))
	params.Set("page", strconv.Itoa(page))
	params.Set("affiliation", "owner,collaborator,organization_member")
	// sort + direction：默认是 full_name asc，但产品上 "最近 push 在前" 更有用
	params.Set("sort", "pushed")
	params.Set("direction", "desc")

	var raw []struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Description   string `json:"description"`
		Private       bool   `json:"private"`
		Archived      bool   `json:"archived"`
		UpdatedAt     string `json:"updated_at"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
		// GitHub /user/repos 不返 permissions 子对象（只有 /repos/{owner}/{repo} 才返）
		// 前端用 isProject 标记代替；Permissions 字段留空即可
	}

	path := "/user/repos?" + params.Encode()
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}

	repos := make([]platform.RepoDTO, 0, len(raw))
	for _, r := range raw {
		repos = append(repos, platform.RepoDTO{
			ID:            r.ID,
			Owner:         r.Owner.Login,
			Name:          r.Name,
			FullName:      r.FullName,
			DefaultBranch: r.DefaultBranch,
			Description:   r.Description,
			Private:       r.Private,
			Archived:      r.Archived,
			UpdatedAt:     r.UpdatedAt,
			// Permissions 留空 —— GitHub /user/repos 不返回
		})
	}

	// 客户端过滤 query（GitHub /user/repos 不支持服务端 search）
	if opts.Query != "" {
		q := strings.ToLower(opts.Query)
		filtered := repos[:0]
		for _, r := range repos {
			if strings.Contains(strings.ToLower(r.FullName), q) ||
				strings.Contains(strings.ToLower(r.Description), q) {
				filtered = append(filtered, r)
			}
		}
		repos = filtered
	}

	return repos, nil
}

// ===== 分支 =====

// ListBranches 首期不支持（GitHub 分支通过 go-git 获取，不走 API）
func (a *GitHubAdapter) ListBranches(ctx context.Context, hostURL, username, token, owner, repo string) ([]platform.BranchDTO, error) {
	return nil, platform.ErrNotSupported
}

// ===== Git Graph（GitHub 首期支持）=====

// CloneRepo clone 仓库到本地 workspace
//
// GitHub clone URL: https://github.com/{owner}/{repo}.git（git 协议用网站域名,**不是** api.github.com）
// 鉴权：http.BasicAuth{Username: "oauth2" 或用户名, Password: token}
//
// hostURL 归一化(反向于 normalizeGitHubHostURL):
//   - ""                                       → "https://github.com"
//   - "https://api.github.com"                 → "https://github.com"  (老账号 localStore 存了 API URL,要 reverse)
//   - "https://github.com"                     → 不变
//   - 自托管 GHES: https://github.acme.com     → 不变(保留 host,git clone 走自己的 host)
func (a *GitHubAdapter) CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath, accountUsername string, progress git.ProgressCallback) (string, error) {
	apiHostURL := normalizeGitHubHostURL(hostURL)
	hostURL = strings.TrimRight(strings.TrimSpace(hostURL), "/")
	if hostURL == "" {
		hostURL = "https://github.com"
	}
	if hostURL == "https://api.github.com" || hostURL == "http://api.github.com" {
		hostURL = "https://github.com"
	}

	result, err := git.CloneRepo(git.CloneOptions{
		Platform:        "github",
		HostURL:         hostURL,
		Owner:           owner,
		Repo:            repo,
		Token:           token,
		Username:        username,
		WorkspacePath:   workspacePath,
		AccountUsername: accountUsername,
		NoCheckout:      true, // v2.4：只拉元信息
		Depth:           largeRepoGraphDepth,
		Progress:        progress,
		UseGitHubCLI:    true,
	})
	if err != nil {
		return "", err
	}
	_ = a.EnsureForkParentRemote(ctx, apiHostURL, token, owner, repo, result.LocalPath)
	return result.LocalPath, nil
}

// EnsureForkParentRemote 为 GitHub fork 仓库补齐上游 remote。
//
// VSCode Git Graph 会显示工作区里已有的 upstream 分支和 tag。应用自己的轻量克隆如果只拉
// origin，就会漏掉 fork parent 上的发布 tag / org 分支，表现为第二条 commit 没有标签。
// 这里不把失败升级成 clone/sync 失败：parent remote 是 Graph 装饰信息，origin 仍是主数据源。
func (a *GitHubAdapter) EnsureForkParentRemote(ctx context.Context, hostURL, token, owner, repo, localPath string) error {
	parentCloneURL, err := a.parentCloneURL(ctx, hostURL, token, owner, repo)
	if err != nil || parentCloneURL == "" {
		return err
	}
	if err := git.EnsureRemote(localPath, "org", parentCloneURL); err != nil {
		return err
	}
	return git.FetchWithFilter(localPath, largeRepoGraphDepth, token)
}

func (a *GitHubAdapter) parentCloneURL(ctx context.Context, hostURL, token, owner, repo string) (string, error) {
	var raw struct {
		Fork   bool `json:"fork"`
		Parent *struct {
			CloneURL string `json:"clone_url"`
		} `json:"parent"`
	}
	path := fmt.Sprintf("/repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	if err := a.doRequest(ctx, normalizeGitHubHostURL(hostURL), token, "GET", path, nil, &raw); err != nil {
		return "", err
	}
	if !raw.Fork || raw.Parent == nil {
		return "", nil
	}
	return strings.TrimSpace(raw.Parent.CloneURL), nil
}

// LogGraph 获取 commit 历史并构建 Graph 布局。
//
// GitHub 路径固定对齐 vscode-git-graph：用系统 git log 一次性读取
// --branches --remotes HEAD，并用 --max-count=N+1 判断是否还有更多提交。
func (a *GitHubAdapter) LogGraph(ctx context.Context, localPath string, opts platform.LogGraphOpts) (*platform.GraphResult, error) {
	logResult, err := git.LogCommitsVscode(ctx, git.LogOptions{
		LocalPath: localPath,
		MaxCount:  opts.MaxCount,
	})
	if err != nil {
		return nil, err
	}

	graphResult := graph.BuildGraphVscodeWithHead(logResult.Commits, opts.Head, logResult.Truncated)
	return graphResultToDTO(graphResult), nil
}

// ===== Pull Request 完整字段映射（v0.6+） =====

// githubPullRaw GitHub /pulls 列表 + /pulls/{index} 详情 共享的原始结构
//
// GitHub REST API: https://docs.github.com/en/rest/pulls/pulls
// Gitea 与 GitHub 的 PR 字段大致一致，差异：
//   - GitHub head.sha 在 head 字段内（与 Gitea 相同），base 同理
//   - GitHub user 是嵌套对象（含 login / avatar_url）
//   - GitHub requested_reviewers 直接是嵌套数组
//   - GitHub labels 走 /issues/{index}/labels（PR 也是 issue 的一种），结构一致
type githubPullRaw struct {
	Number             int                  `json:"number"`
	Title              string               `json:"title"`
	State              string               `json:"state"`
	Draft              bool                 `json:"draft"`
	Merged             bool                 `json:"merged"`
	Head               githubPullRefRaw     `json:"head"`
	Base               githubPullRefRaw     `json:"base"`
	User               *githubUserRaw       `json:"user"`
	Assignees          []githubUserRaw      `json:"assignees"`
	RequestedReviewers []githubUserRaw      `json:"requested_reviewers"`
	Labels             []githubPullLabelRaw `json:"labels"`
	Mergeable          *bool                `json:"mergeable"`
	Comments           int                  `json:"comments"`
	Body               string               `json:"body"`
	MergedBy           *githubUserRaw       `json:"merged_by"`
	CreatedAt          string               `json:"created_at"`
	UpdatedAt          string               `json:"updated_at"`
}

type githubPullRefRaw struct {
	Ref string `json:"ref"`
	SHA string `json:"sha"`
}

type githubUserRaw struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url"`
}

type githubPullLabelRaw struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// githubPullToDetail 把 GitHub 原始响应映射到平台中性 PullDetailDTO
//
// GitHub Mergeable 是 *bool（可空），HasConflicts 取反；
// Gitea Mergeable 是 bool（不可空）。两侧统一为 PullDetailDTO 的非指针字段，
// 不可合并时取 !Mergeable 处理（与 Gitea 行为一致）。
func githubPullToDetail(p githubPullRaw) platform.PullDetailDTO {
	mergeable := false
	if p.Mergeable != nil {
		mergeable = *p.Mergeable
	}
	out := platform.PullDetailDTO{
		Index:         p.Number,
		Number:        p.Number,
		Title:         p.Title,
		State:         p.State,
		Draft:         p.Draft,
		Merged:        p.Merged,
		Head:          platform.PullRefDTO{Ref: p.Head.Ref, SHA: p.Head.SHA},
		Base:          platform.PullRefDTO{Ref: p.Base.Ref, SHA: p.Base.SHA},
		Mergeable:     mergeable,
		HasConflicts:  !mergeable,
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

// encodeJSONBody 把任意 struct 序列化成 io.Reader，给 doRequest 当 body 用。
//
// GitHub adapter 现有方法都是 GET，v0.6+ PR 写入接口需要 POST/PUT/PATCH/DELETE。
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

// ===== 以下首期不支持 =====

// ListPulls 列出仓库合并请求（GET /repos/{owner}/{repo}/pulls）
//
// GitHub PR 字段对齐 platform.PullDetailDTO（owner/repo 走 path 参数）。
// state 可取 "open" | "closed" | "all"（与 Gitea 一致）。
// GitHub 把 merged PR 视为 state=closed + merged=true；通过 GraphQL 区分成本太高，列表阶段
// 只把 state/draft 等基础字段对齐，详细 merged 字段前端按需二次 GET。
func (a *GitHubAdapter) ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListPullsOpts) ([]platform.PullDetailDTO, error) {
	params := url.Values{}
	state := opts.State
	if state == "" {
		state = "open"
	}
	params.Set("state", state)
	if opts.Limit > 0 {
		params.Set("per_page", fmt.Sprintf("%d", opts.Limit))
	}
	if opts.Page > 0 {
		params.Set("page", fmt.Sprintf("%d", opts.Page))
	}
	if opts.Base != "" {
		params.Set("base", opts.Base)
	}
	// opts.Head 在 GitHub 是 branch 名，不一定与 Gitea head SHA 语义一致；不传避免歧义。

	var raw []githubPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls?%s", owner, repo, params.Encode())
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}

	pulls := make([]platform.PullDetailDTO, 0, len(raw))
	for i := range raw {
		pulls = append(pulls, githubPullToDetail(raw[i]))
	}
	return pulls, nil
}

// GetPull 获取单个合并请求详情（GET /repos/{owner}/{repo}/pulls/{index}）
func (a *GitHubAdapter) GetPull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*platform.PullDetailDTO, error) {
	var raw githubPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	d := githubPullToDetail(raw)
	return &d, nil
}

// MergePull 合并合并请求（PUT /repos/{owner}/{repo}/pulls/{index}/merge）
//
// GitHub 端点 body：{commit_title?, commit_message?, sha?, merge_method: "merge"|"squash"|"rebase"}
// 与 Gitea 区别：GitHub 不支持 "rebase-merge"（Gitea 专属），调用方需把 "rebase-merge" 映射成 "rebase"。
// 合并成功后返回的响应里有 sha 字段，直接回填到 PullDetailDTO.MergeCommitSHA（不再二次 GET）。
func (a *GitHubAdapter) MergePull(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts platform.MergePullOpts) (*platform.PullDetailDTO, error) {
	method := mapMergeMethodToGitHub(opts.Method)
	body := map[string]any{"merge_method": method}
	if opts.CommitMessage != "" {
		body["commit_message"] = opts.CommitMessage
	}
	// deleteBranchAfter 在 GitHub REST API 没有这个字段，合并后由调用方单独调 DELETE /branches 实现
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	var resp struct {
		SHA    string `json:"sha"`
		Merged bool   `json:"merged"`
	}
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "PUT", path, reader, &resp); err != nil {
		return nil, err
	}
	if opts.DeleteBranchAfter && resp.Merged {
		// GitHub 没有 merge 时删除 head 分支的语义；合并成功后单独 DELETE /git/refs/heads/<head.ref>
		detail, gerr := a.GetPull(ctx, hostURL, username, token, owner, repo, index)
		if gerr == nil && detail.Head.Ref != "" {
			delRef := fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", owner, repo, detail.Head.Ref)
			_ = a.doRequest(ctx, hostURL, token, "DELETE", delRef, nil, nil)
		}
	}
	d, err := a.GetPull(ctx, hostURL, username, token, owner, repo, index)
	if err != nil {
		return nil, err
	}
	d.MergeCommitSHA = resp.SHA
	return d, nil
}

// ClosePull 关闭合并请求（PATCH /repos/{owner}/{repo}/pulls/{index} state=closed）
func (a *GitHubAdapter) ClosePull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*platform.PullDetailDTO, error) {
	body := map[string]any{"state": "closed"}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	var raw githubPullRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
		return nil, err
	}
	d := githubPullToDetail(raw)
	return &d, nil
}

// UpdatePullLabels 替换合并请求标签（PUT /repos/{owner}/{repo}/issues/{index}/labels）
//
// GitHub 端点有趣：PR 的 labels 走 /issues/{index}/labels（PR 也是 issue 的一种）。
// body: {labels: ["bug", "feature"]}（按 name 字符串数组）
//
// 真实响应（v0.6+ integration test 验证）：
//   PUT /repos/{owner}/{repo}/issues/{index}/labels
//   → 200 OK + body = [{id, name, color, default, description}, ...]
//   **不是** issue object，所以不要尝试解码成 PullRaw
func (a *GitHubAdapter) UpdatePullLabels(ctx context.Context, hostURL, username, token, owner, repo string, index int, labelNames []string) (*platform.PullDetailDTO, error) {
	body := map[string]any{"labels": labelNames}
	reader, err := encodeJSONBody(body)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/labels", owner, repo, index)
	// 端点返回 label 数组，**不**解码（响应字段不参与业务，只用副作用：labels 已替换）
	if err := a.doRequest(ctx, hostURL, token, "PUT", path, reader, nil); err != nil {
		return nil, err
	}
	// 为保证返回 PullDetailDTO 字段完整，再 GET 一次 PR 详情（顺手拉最新 labels/assignees/reviewers）
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// UpdatePullAssignee 替换合并请求指派人（POST /repos/{owner}/{repo}/issues/{index}/assignees）
//
// GitHub 端点接受 JSON 对象 {"assignees": ["alice"]} 或 {"assignees": ["alice", "bob"]}（追加语义）。
// 为与前端契约（"替换所有"）一致：先 GET 现状，diff 后做 DELETE + POST。
// 同样 PR 走 /issues/{index}/assignees 端点。
func (a *GitHubAdapter) UpdatePullAssignee(ctx context.Context, hostURL, username, token, owner, repo string, index int, assignee string) (*platform.PullDetailDTO, error) {
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
		path := fmt.Sprintf("/repos/%s/%s/issues/%d/assignees", owner, repo, index)
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
		path := fmt.Sprintf("/repos/%s/%s/issues/%d/assignees", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, nil); err != nil {
			return nil, err
		}
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// UpdatePullReviewers 替换合并请求审查者（POST /repos/{owner}/{repo}/pulls/{index}/requested_reviewers）
//
// GitHub 端点 body：{reviewers: ["alice"], team_reviewers: ["team1"]}（追加语义）。
// 同样：先 GET 现状，diff 后做 DELETE + POST。
func (a *GitHubAdapter) UpdatePullReviewers(ctx context.Context, hostURL, username, token, owner, repo string, index int, reviewers []string) (*platform.PullDetailDTO, error) {
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
		// DELETE /repos/{owner}/{repo}/pulls/{index}/requested_reviewers
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
		// POST /repos/{owner}/{repo}/pulls/{index}/requested_reviewers
		path := fmt.Sprintf("/repos/%s/%s/pulls/%d/requested_reviewers", owner, repo, index)
		if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, nil); err != nil {
			return nil, err
		}
	}
	return a.GetPull(ctx, hostURL, username, token, owner, repo, index)
}

// ===== PR 评论（v0.6+）=====
//
// GitHub 端点与 Gitea 一致：/repos/{owner}/{repo}/issues/{index}/comments
// PR 在 GitHub 平台上本来就是 issue 的一种，所以 PR 评论走 issue comments 端点。

// ListPullComments 列 PR 评论（GET /repos/{owner}/{repo}/issues/{index}/comments）
func (a *GitHubAdapter) ListPullComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.CommentDTO, error) {
	var raw []githubCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.CommentDTO, 0, len(raw))
	for _, c := range raw {
		out = append(out, githubCommentToDTO(c))
	}
	return out, nil
}

// CreatePullComment 发 PR 评论（POST /repos/{owner}/{repo}/issues/{index}/comments）
//
// body: {body: "..."}
// 返回创建的评论（含 id / user / created_at），前端拿到权威时间戳。
func (a *GitHubAdapter) CreatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string) (*platform.CommentDTO, error) {
	if strings.TrimSpace(body) == "" {
		return nil, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	payload := map[string]any{"body": body}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw githubCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
		return nil, err
	}
	dto := githubCommentToDTO(raw)
	return &dto, nil
}

// githubCommentRaw GitHub /repos/.../issues/{index}/comments 原始响应
//
// 字段与上面 githubPullRaw 里的 user 部分对齐，复用不上不是问题但为可读性独立定义。
type githubCommentRaw struct {
	ID        int64          `json:"id"`
	Body      string         `json:"body"`
	User      *githubUserRaw `json:"user"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

// githubCommentToDTO 映射为平台中性 CommentDTO
func githubCommentToDTO(c githubCommentRaw) platform.CommentDTO {
	out := platform.CommentDTO{
		ID:        c.ID,
		Body:      c.Body,
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
	}
	if c.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  c.User.Login,
			AvatarURL: c.User.AvatarURL,
		}
	}
	return out
}
//
// 前端：'merge' | 'rebase' | 'rebase-merge' | 'squash'
// GitHub: 'merge' | 'rebase' | (无 'rebase-merge'，映射为 'rebase') | 'squash'
func mapMergeMethodToGitHub(method string) string {
	switch method {
	case "rebase-merge":
		// GitHub 没区分 rebase / rebase-merge，统一映射为 rebase
		return "rebase"
	case "", "merge":
		return "merge"
	default:
		return method
	}
}

// ===== 以下首期不支持 =====

// ListIssues 首期不支持
func (a *GitHubAdapter) ListIssues(ctx context.Context, hostURL, username, token, owner, repo string, opts platform.ListIssuesOpts) ([]platform.IssueDTO, error) {
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
//
// 必备请求头（GitHub REST API 文档要求）：
//   - Authorization: Bearer <token>
//   - Accept: application/vnd.github+json
//   - User-Agent: gitea-kanban/<version>
//   - Go http.Client 默认 UA 是 "Go-http-client/1.1" —— GitHub 偶尔会拒绝
//   - 文档明确"Requests without a valid User-Agent header will be rejected"
//   - 设成应用名 + 版本号让 GitHub 出问题时能联系到我们
//   - X-GitHub-Api-Version: 2022-11-28
//   - 文档推荐显式指定 API 版本,避免 GitHub 升级后端点行为变更导致 406
//
// 错误诊断：非 2xx 时把 status + URL + body 前 200 字符写到 slog
// （路径 app/config/,文件 ${dataDir}/logs/main/main.log）
// 用户下次遇到问题时能直接 cat 日志给我看具体响应
func (a *GitHubAdapter) doRequest(ctx context.Context, hostURL, token, method, path string, body io.Reader, out interface{}) error {
	base := strings.TrimRight(hostURL, "/")
	fullURL := base + path

	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		// 构造失败：URL 解析 / ctx 异常 / headers 异常，几乎不会发生但兜底
		slog.Default().Warn("GitHub HTTP request build failed",
			"method", method, "url", fullURL, "err", err.Error())
		return ipc.NewInternal("构造 GitHub 请求失败: " + err.Error())
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "gitea-kanban/"+GitHubAdapterVersion)
	// 钉死 API 版本：避免 GitHub 升级后默认行为变更触发 406 / 415
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	// v0.6+ bugfix：POST/PUT/PATCH 带 JSON body 时显式设 Content-Type，
	// 避免 Go http.NewRequest 默认成 application/x-www-form-urlencoded。
	// Gitea adapter 同修复（见 gitea/adapter.go）。
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		// 网络层错误（含 TLS、DNS、连接被拒、超时）
		// 必须包成 IpcError，否则前端 normalizeError 落到 "未知错误" 占位文案
		// 用户根本看不到真实原因（TLS handshake timeout / DNS 解析失败 / 502 等）
		slog.Default().Warn("GitHub HTTP request failed",
			"method", method, "url", fullURL, "err", err.Error())
		return ipc.NewNetworkOffline(fmt.Sprintf("GitHub %s %s: %s", method, fullURL, err.Error()))
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		bodyStr := ipc.TruncateCause(string(bodyBytes))
		// 关键诊断：每次非 2xx 都写一条 slog,这样用户报错时
		// ${dataDir}/logs/main/main.log 里有完整 status + url + body
		slog.Default().Warn("GitHub HTTP non-2xx",
			"method", method,
			"url", fullURL,
			"status", resp.StatusCode,
			"body", bodyStr,
		)
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
//
// 设计（v2.x · 修复"服务器开小差：GitHub 返回错误"模糊提示）：
//   - 任何分支都带 HTTPStatus（前端 messageText 拼接显示具体码）
//   - 400/415 走 validation_failed（请求参数/header 不被接受）
//   - 500/501/504 走 network_offline（远端暂时不可达，与 502/503 一致）
//   - default 兜底必须带状态码（让用户能看到"GitHub 返回 5xx"具体是什么）
//     → 不能继续走 ipc.NewGiteaError（message 是写死的"GitHub 返回错误"，不显示状态码）
func mapHTTPError(status int, body string) error {
	cause := ipc.TruncateCause(body)
	// 带 HTTPStatus 的 helper（对齐 errors.go FromHTTPStatus 模式）
	withStatus := func(err *ipc.IpcError) *ipc.IpcError {
		err.HTTPStatus = status
		return err
	}

	switch status {
	case 400:
		// GitHub 偶尔返 400 表示请求参数错误（如 affiliations 值非法）
		return withStatus(ipc.NewValidationFailed("请求参数不被 GitHub 接受", cause))
	case 401:
		return withStatus(&ipc.IpcError{
			Code:       ipc.CodeTokenInvalid,
			Message:    "登录已过期或 token 无效",
			Hint:       "请到 GitHub Settings → Developer settings 重新生成 token",
			Cause:      cause,
			HTTPStatus: status,
		})
	case 403:
		return withStatus(ipc.NewPermissionDenied(cause + "（可能 token scope 不足，或需要补 User-Agent header）"))
	case 404:
		return withStatus(ipc.NewNotFound(cause + "（可能已被删除或 token 无权访问）"))
	case 406:
		// 406 Not Acceptable：GitHub 严格匹配 Accept 头,应用送了它不支持的 MIME
		// 我们现在固定 application/vnd.github+json + 钉死 X-GitHub-Api-Version: 2022-11-28
		// 正常情况下不会触发;如果触发了,可能是 GitHub 服务端临时状态或账户被风控
		return withStatus(&ipc.IpcError{
			Code:       ipc.CodeValidationFailed,
			Message:    "GitHub 不接受请求格式（HTTP 406）",
			Hint:       "请把应用日志（设置页\"打开应用数据目录\" → logs/main/main.log）发给开发者,里面有完整 status + body",
			Cause:      cause,
			HTTPStatus: status,
		})
	case 415:
		// GitHub 偶尔对 Accept 头挑剔（如 /user/repos 不接受 application/vnd.github+json 时）
		// 当成请求参数错误，让用户重试或检查应用版本
		return withStatus(ipc.NewValidationFailed("GitHub 不接受请求头（Accept 不匹配）", cause))
	case 422:
		return withStatus(ipc.NewValidationFailed("请求参数不被服务端接受", cause))
	case 429:
		return withStatus(&ipc.IpcError{
			Code:       ipc.CodeRateLimited,
			Message:    "请求过于频繁（GitHub API 限流）",
			Hint:       "请稍候重试",
			Cause:      cause,
			HTTPStatus: status,
		})
	case 500, 501, 502, 503, 504:
		// 5xx 一律视为远端暂时不可达（network_offline + 提示"GitHub 服务暂不可用"）
		// 不再走 default → 用户不再看到"服务器开小差"模糊文案
		return withStatus(&ipc.IpcError{
			Code:       ipc.CodeNetworkOffline,
			Message:    "GitHub 服务暂不可用（HTTP " + strconv.Itoa(status) + "）",
			Hint:       "这是 GitHub 端的问题，不是你的 token；稍候重试即可",
			Cause:      cause,
			HTTPStatus: status,
		})
	default:
		// 兜底：必须把 HTTP 状态码塞进 message，让前端能显示具体码
		// 不要再用 ipc.NewGiteaError（message 写死"GitHub 返回错误"，看不到具体码）
		return withStatus(&ipc.IpcError{
			Code:       ipc.CodeGiteaError,
			Message:    "GitHub 返回 " + strconv.Itoa(status),
			Hint:       "请稍候重试；如果是 4xx 请检查 token 权限，5xx 请稍后再试",
			Cause:      cause,
			HTTPStatus: status,
		})
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
