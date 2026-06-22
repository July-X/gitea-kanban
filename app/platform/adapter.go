// Package platform 定义平台抽象层。
//
// v2 架构支持多平台（Gitea / GitHub），通过 PlatformAdapter interface 隔离平台差异。
// 上层业务只依赖 interface，GiteaAdapter / GitHubAdapter 各自实现。
//
// 首期范围（对齐迁移计划 §2）：
//   - GiteaAdapter：完整实现（repos/branches/commits/pulls/issues/labels/milestones/members）
//   - GitHubAdapter：仅 Git Graph（verifyToken + cloneRepo + logGraph），其余返回 ErrNotSupported
package platform

import (
	"context"
	"errors"
)

// ErrNotSupported 平台不支持该功能（如 GitHub 首期不支持 issue/PR）
var ErrNotSupported = errors.New("该平台不支持此功能")

// UserDTO 平台用户信息（从 /user 接口获取）
type UserDTO struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	FullName  string `json:"fullName,omitempty"`
	Email     string `json:"email,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// RepoDTO 仓库信息
type RepoDTO struct {
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	FullName      string `json:"fullName"`
	DefaultBranch string `json:"defaultBranch"`
	Description   string `json:"description,omitempty"`
	Private       bool   `json:"private"`
	// v2.3 StatusBar 多行仓库管理需要这些字段：
	ID        int64  `json:"id"`        // gitea repo id
	Archived  bool   `json:"archived"`  // 是否归档
	UpdatedAt string `json:"updatedAt"` // ISO 8601
	// 前端 Permissions 是 {pull, push, admin}，gitea API /repos/search
	// 已经包含 permissions 字段（{pull: bool, push: bool, admin: bool}）
	Permissions *RepoPermissions `json:"permissions,omitempty"`
	// 前端 RepoDto 必备 isProject / lastSyncAt —— App.ListRepos 拼好
	IsProject  bool   `json:"isProject"`
	LastSyncAt string `json:"lastSyncAt,omitempty"`
}

// RepoPermissions gitea /repos/search 返的 permissions 子字段
type RepoPermissions struct {
	Pull  bool `json:"pull"`
	Push  bool `json:"push"`
	Admin bool `json:"admin"`
}

// BranchDTO 分支信息
type BranchDTO struct {
	Name       string `json:"name"`
	CommitSHA  string `json:"commitSha"`
	IsProtected bool  `json:"isProtected"`
}

// PlatformAdapter 平台抽象层
//
// 所有方法都接收 ctx（用于超时/取消）+ 凭证信息（token/username）。
// 实现方负责构造正确的 HTTP 请求（Gitea: Authorization: token <pat>；GitHub: Authorization: Bearer <token>）。
type PlatformAdapter interface {
	// Platform 返回平台标识
	Platform() Platform

	// ===== 鉴权 =====

	// VerifyToken 验证 token 有效性，返回用户信息
	VerifyToken(ctx context.Context, hostURL, token string) (*UserDTO, error)

	// ===== 仓库 =====

	// ListRepos 列出用户可访问的仓库
	ListRepos(ctx context.Context, hostURL, username, token string, opts ListReposOpts) ([]RepoDTO, error)

	// ===== 分支 =====

	// ListBranches 列出仓库分支
	ListBranches(ctx context.Context, hostURL, username, token, owner, repo string) ([]BranchDTO, error)

	// ===== Git Graph（Gitea + GitHub 都支持）=====

	// CloneRepo clone 仓库到本地 workspace
	// 实际调用 app/git.CloneRepo，但通过 adapter 暴露让上层统一调用
	CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath string) (localPath string, err error)

	// LogGraph 获取 commit 历史并构建 Graph 布局
	LogGraph(ctx context.Context, localPath string, opts LogGraphOpts) (*GraphResult, error)

	// ===== 以下首期仅 Gitea 实现，GitHub 返回 ErrNotSupported =====

	// ListIssues 列出仓库议题
	ListIssues(ctx context.Context, hostURL, username, token, owner, repo string, opts ListIssuesOpts) ([]IssueDTO, error)

	// ListPulls 列出仓库合并请求
	ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts ListPullsOpts) ([]PullDTO, error)

	// ListLabels 列出仓库标签
	ListLabels(ctx context.Context, hostURL, username, token, owner, repo string) ([]LabelDTO, error)

	// ListMembers 列出仓库成员
	ListMembers(ctx context.Context, hostURL, username, token, owner, repo string) ([]MemberDTO, error)
}

// ListReposOpts 列仓库参数
type ListReposOpts struct {
	Query string
	Page  int
	Limit int
}

// ListIssuesOpts 列议题参数
type ListIssuesOpts struct {
	State    string // "open" | "closed" | "all"
	Labels   []string
	Assignee string
	Page     int
	Limit    int
}

// ListPullsOpts 列合并请求参数
type ListPullsOpts struct {
	State string // "open" | "closed" | "all"
	Page  int
	Limit int
}

// LogGraphOpts log graph 参数
type LogGraphOpts struct {
	Branches []string
	MaxCount int
}

// GraphResult Graph 布局结果（与 app/git/graph.GraphResult 对齐，但作为 DTO 不含内部类型）
type GraphResult struct {
	Nodes     []GraphNodeDTO `json:"nodes"`
	Edges     []GraphEdgeDTO `json:"edges"`
	MaxLane   int            `json:"maxLane"`
	Truncated bool           `json:"truncated"`
}

// GraphNodeDTO 图节点
type GraphNodeDTO struct {
	Row         int    `json:"row"`
	Lane        int    `json:"lane"`
	SHA         string `json:"sha"`
	ShortSHA    string `json:"shortSha"`
	Subject     string `json:"subject"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	Date        string `json:"date"`
	IsMerge     bool   `json:"isMerge"`
	Parents     []string `json:"parents"`
}

// GraphEdgeDTO 图边
type GraphEdgeDTO struct {
	FromRow  int `json:"fromRow"`
	ToRow    int `json:"toRow"`
	FromLane int `json:"fromLane"`
	ToLane   int `json:"toLane"`
	Color    int `json:"color"` // 0..15，对齐 Gitea Color16()，前端按此染色
	Type     int `json:"type"`  // 0=normal, 1=branch, 2=merge
}

// IssueDTO 议题信息（首期简化，仅 Git Graph 场景不需要完整字段）
type IssueDTO struct {
	Index    int    `json:"index"`
	Title    string `json:"title"`
	State    string `json:"state"`
	Body     string `json:"body,omitempty"`
	Author   string `json:"author"`
}

// PullDTO 合并请求信息（首期简化）
type PullDTO struct {
	Index  int    `json:"index"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Head   string `json:"head"`
	Base   string `json:"base"`
	Merged bool   `json:"merged"`
}

// LabelDTO 标签信息
type LabelDTO struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description,omitempty"`
}

// MemberDTO 成员信息
type MemberDTO struct {
	Login      string `json:"login"`
	Permission string `json:"permission"`
}
