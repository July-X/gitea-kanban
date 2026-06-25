// Package github 实现 PlatformAdapter 的 GitHub 版本。
//
// 支持范围（v2.x）：
//   - VerifyToken：GET /user，Authorization: Bearer <token>
//   - ListRepos：GET /user/repos，列当前登录用户可访问的仓库（含 collaborator）
//   - CloneRepo：go-git clone（与 Gitea 共用 app/git.CloneRepo）
//   - LogGraph：go-git DAG Log + 自研 lane 布局（与 Gitea 共用）
//   - 其余方法返回 ErrNotSupported
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
func (a *GitHubAdapter) CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath string) (string, error) {
	hostURL = strings.TrimRight(strings.TrimSpace(hostURL), "/")
	if hostURL == "" {
		hostURL = "https://github.com"
	}
	if hostURL == "https://api.github.com" || hostURL == "http://api.github.com" {
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
//
// 必备请求头（GitHub REST API 文档要求）：
//   - Authorization: Bearer <token>
//   - Accept: application/vnd.github+json
//   - User-Agent: gitea-kanban/<version>
//     * Go http.Client 默认 UA 是 "Go-http-client/1.1" —— GitHub 偶尔会拒绝
//     * 文档明确"Requests without a valid User-Agent header will be rejected"
//     * 设成应用名 + 版本号让 GitHub 出问题时能联系到我们
//   - X-GitHub-Api-Version: 2022-11-28
//     * 文档推荐显式指定 API 版本,避免 GitHub 升级后端点行为变更导致 406
//
// 错误诊断：非 2xx 时把 status + URL + body 前 200 字符写到 slog
// （路径 app/config/,文件 ${dataDir}/logs/main/main.log）
// 用户下次遇到问题时能直接 cat 日志给我看具体响应
func (a *GitHubAdapter) doRequest(ctx context.Context, hostURL, token, method, path string, body io.Reader, out interface{}) error {
	base := strings.TrimRight(hostURL, "/")
	fullURL := base + path

	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return fmt.Errorf("构造请求失败: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "gitea-kanban/"+GitHubAdapterVersion)
	// 钉死 API 版本：避免 GitHub 升级后默认行为变更触发 406 / 415
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := a.httpClient.Do(req)
	if err != nil {
		// 网络层错误（含 TLS、DNS、连接被拒）→ 写 slog + 返回 generic error
		slog.Default().Warn("GitHub HTTP request failed",
			"method", method, "url", fullURL, "err", err.Error())
		return fmt.Errorf("请求失败: %w", err)
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
