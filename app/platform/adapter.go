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

	"gitea-kanban/app/git"
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
	// 前端 RepoDto 必备 projectId / isProject / lastSyncAt —— App.ListRepos 拼好
	ProjectID  string `json:"projectId,omitempty"`
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
	Name        string `json:"name"`
	CommitSHA   string `json:"commitSha"`
	IsProtected bool   `json:"isProtected"`
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
	//
	// v2.5：accountUsername 用于按账号隔离的子目录布局
	//   旧布局：${workspacePath}/repos/<owner>__<repo>/
	//   新布局：${workspacePath}/repos/<accountUsername>/<owner>__<repo>/
	//
	// v2.6：progress 可选进度回调（nil = 不推送，向后兼容）
	CloneRepo(ctx context.Context, hostURL, username, token, owner, repo, workspacePath, accountUsername string, progress git.ProgressCallback) (localPath string, err error)

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
	// Head 当前 checkout 的 commit hash, 用于标记 isCurrent (vscode HEAD 高亮).
	// 空字符串则全部 isCurrent=false (HEAD 由 vscode 自身显示 uncommitted dot)
	Head string
}

// GraphResult Graph 布局结果（与 app/git/graph.GraphResult 对齐，但作为 DTO 不含内部类型）
type GraphResult struct {
	Nodes []GraphNodeDTO `json:"nodes"`
	Edges []GraphEdgeDTO `json:"edges"`
	// Branches vscode 风格 branch 列表 (BuildGraphVscodeWithHead 才会填)
	// 前端按 branch 画 SVG path, 完整保留 vscode Branch.draw 几何
	Branches  []GraphBranchDTO `json:"branches,omitempty"`
	MaxLane   int              `json:"maxLane"`
	Truncated bool             `json:"truncated"`
}

// GraphBranchDTO 1:1 复刻 vscode-git-graph 的 Branch 对象
// 一条 branch = 一条完整 SVG path
type GraphBranchDTO struct {
	Color int                  `json:"color"`
	End   int                  `json:"end"`
	Lines []GraphBranchLineDTO `json:"lines"`
}

// GraphBranchLineDTO branch 上的一段 line
// 坐标以 row/lane 为单位 (像素 = row*GRID_Y + offsetY, lane*GRID_X + offsetX)
type GraphBranchLineDTO struct {
	X1          int  `json:"x1"`
	Y1          int  `json:"y1"`
	X2          int  `json:"x2"`
	Y2          int  `json:"y2"`
	LockedFirst bool `json:"lockedFirst"`
	// IsCommitted 该 line 是否属于「已提交」段。
	// 对齐 vscode graph.ts:102 `line.isCommitted` 与 Branch.drawPath:152 stroke 切换。
	// 不带 omitempty —— false（UNCOMMITTED 段）也是有效信号，omitempty 会吞掉
	IsCommitted bool `json:"isCommitted"`
}

// GraphNodeDTO 图节点
type GraphNodeDTO struct {
	Row         int      `json:"row"`
	Lane        int      `json:"lane"`
	Color       int      `json:"color"`
	SHA         string   `json:"sha"`
	ShortSHA    string   `json:"shortSha"`
	Subject     string   `json:"subject"`
	AuthorName  string   `json:"authorName"`
	AuthorEmail string   `json:"authorEmail"`
	Date        string   `json:"date"`
	IsMerge     bool     `json:"isMerge"`
	Parents     []string `json:"parents"`
	// Refs 关联的 ref 名称（branch / remote / tag 短名）
	// 透传自 GraphNode.Refs，前端右侧 commit 行渲染 badge
	Refs []string `json:"refs,omitempty"`
	// RefTypes 与 Refs 一一对应的 ref 类型（v2.8 新增）
	// "branch" / "remoteBranch" / "tag"，让前端严格区分，不再用启发式猜
	RefTypes []string `json:"refTypes,omitempty"`
	// IsCurrent 是否 HEAD 节点 (vscode Vertex.draw 画成空心 stroke-only)
	IsCurrent bool `json:"isCurrent,omitempty"`
	// IsStash 是否 stash 节点 (vscode Vertex.draw 画成 r=4.5 外圈 + r=2 内圈)
	IsStash bool `json:"isStash,omitempty"`
	// IsCommitted 是否已提交 (true) 还是未提交的 worktree 变更 (false)
	// 对齐 vscode graph.ts Vertex.draw：uncommitted 时 stroke = #808080
	// 不带 omitempty —— false（UNCOMMITTED 节点）也是有效信号，omitempty 会吞掉
	IsCommitted bool `json:"isCommitted"`
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
	Index  int    `json:"index"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Body   string `json:"body,omitempty"`
	Author string `json:"author"`
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
