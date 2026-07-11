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
	ListPulls(ctx context.Context, hostURL, username, token, owner, repo string, opts ListPullsOpts) ([]PullDetailDTO, error)

	// GetPull 获取单个合并请求详情
	GetPull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*PullDetailDTO, error)

	// MergePull 合并合并请求（按指定 merge method）
	MergePull(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts MergePullOpts) (*PullDetailDTO, error)

	// ClosePull 关闭合并请求（不合并）
	ClosePull(ctx context.Context, hostURL, username, token, owner, repo string, index int) (*PullDetailDTO, error)

	// UpdatePullLabels 替换合并请求的标签
	UpdatePullLabels(ctx context.Context, hostURL, username, token, owner, repo string, index int, labelNames []string) (*PullDetailDTO, error)

	// UpdatePullAssignee 替换合并请求的指派人（空字符串 = 清空）
	UpdatePullAssignee(ctx context.Context, hostURL, username, token, owner, repo string, index int, assignees []string) (*PullDetailDTO, error)

	// UpdatePullReviewers 替换合并请求的审查者（空切片 = 清空；Gitea 走 requested_reviewers，GitHub 等价）
	UpdatePullReviewers(ctx context.Context, hostURL, username, token, owner, repo string, index int, reviewers []string) (*PullDetailDTO, error)

	// ListPullTimeline 列合并请求时间轴（v0.7.x 对齐 Gitea web）
	//
	// 时间轴包含所有 type: 普通评论 + 评审事件 + 系统事件 + 推送事件,
	// 是 Gitea web 时间轴的 1:1 还原。
	//
	// 底层调 Gitea /repos/{owner}/{repo}/issues/{index}/timeline (TimelineComment),
	// 或 GitHub 对应的 issues events 端点组合。
	ListPullTimeline(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]TimelineItem, error)

	// ListPullComments 列合并请求评论（v0.6+ PR 评论，按 createdAt 升序）
	//
	// 底层调 Gitea /repos/{owner}/{repo}/issues/{index}/comments，只返回 type=0 普通评论。
	// 系统事件 (REOPEN/CLOSE/LABEL/MILESTONE/...) 走 ListPullTimeline。
	ListPullComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]CommentDTO, error)

	// CreatePullComment 在合并请求下发评论（v0.6+ PR 评论）
	//
	// 返回创建的评论（含服务端分配的 id / createdAt / author），前端用此
	// 拿到权威时间戳去更新 UI（避免"前端猜时间戳 + 实际服务端时间"不一致）。
	CreatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string) (*CommentDTO, error)

	// UpdatePullComment 编辑合并请求评论
	//
	// Gitea:  PATCH /repos/{owner}/{repo}/issues/comments/{id}
	// GitHub: PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
	//
	// 仅评论作者本人能编辑（服务端 403 如果不是作者）。返回更新后的评论 DTO。
	UpdatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, body string) (*CommentDTO, error)

	// DeletePullComment 删除合并请求评论
	//
	// Gitea:  DELETE /repos/{owner}/{repo}/issues/comments/{id}
	// GitHub: DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}
	//
	// 仅评论作者本人 / 仓库管理员能删除。成功时返回 nil error。
	// 两端对已删除的评论重复删除都返 2xx（幂等）。
	DeletePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) error

	// ListPullCommentReactions 列评论表情反应（v0.5.0 M2）
	//
	// Gitea:  GET /repos/{owner}/{repo}/issues/comments/{id}/reactions
	// GitHub: GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
	// 返回反应列表（按 user 维度，每个 user 一个 ReactionDTO）。
	ListPullCommentReactions(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) ([]ReactionDTO, error)

	// AddPullCommentReaction 添加表情反应（v0.5.0 M2）
	//
	// Gitea:  POST /repos/{owner}/{repo}/issues/comments/{id}/reactions {content: "+1"}
	// GitHub: POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions {content: "+1"}
	// 返回新增的 ReactionDTO；重复添加同一 reaction 时 GitHub 返 422 / Gitea 静默返回已有 reaction。
	AddPullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) (*ReactionDTO, error)

	// RemovePullCommentReaction 移除表情反应（v0.5.0 M2）
	//
	// Gitea:  DELETE /repos/{owner}/{repo}/issues/comments/{id}/reactions {content: "+1"}（按 content 删，带 body）
	// GitHub: DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}（按 reaction id 删，不带 body）
	// 成功返回 nil error。
	RemovePullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) error

	// ListPullReviews 列合并请求评审（v0.5.0 M3）
	//
	// Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/reviews
	// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
	// 按 createdAt 升序。
	ListPullReviews(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]PullReviewDTO, error)

	// CreatePullReview 创建评审（v0.5.0 M3）
	//
	// Gitea:  POST /repos/{owner}/{repo}/pulls/{index}/reviews
	// GitHub: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
	// event: "approve" / "request_changes" / "comment"（前端统一英语词，GitHub adapter 做大写映射）
	// 返回创建评审（含服务端 id / state / submittedAt）。
	CreatePullReview(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts CreateReviewOpts) (*PullReviewDTO, error)

	// ListPullReviewComments 列合并请求行内评审评论（v0.5.0 M4）
	//
	// 按文件分组的行内 review comment（diff 评论），区别于 ListPullComments（整体 issue 评论）。
	// Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/comments
	// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
	ListPullReviewComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]PullReviewCommentDto, error)

	// CreatePullReviewComment 创建行内评审评论（v0.5.0 M4）
	//
	// Gitea:  POST /repos/{owner}/{repo}/pulls/{index}/comments
	//          body: {body, path, new_position: <line>}
	// GitHub: POST /repos/{owner}/{repo}/pulls/{pull_number}/comments
	//          body: {body, path, line}
	CreatePullReviewComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string, path string, line int) (*PullReviewCommentDto, error)

	// ListPullFiles 列出 PR 修改的文件列表（v0.5.0 M4）
	//
	// 每个元素包含文件名 + 变更类型（added / modified / deleted / renamed）+
	// 增删行数 + 文件级 patch（可选，小文件直接带，大文件前端按需 GetPullFileDiff）。
	//
	// Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/files
	// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/files
	// GitHub 返 JSON 数组；Gitea 也返 JSON 数组（Gitea 1.21+）。
	// 对于低版本 Gitea 不支援此端点（404），前端隐藏"文件评论" Tab。
	ListPullFiles(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]PullFileDTO, error)

	// GetPullFileDiff 获取单个文件的 diff 内容（v0.5.0 M4）
	//
	// 返回 unified diff 格式文本（patch 格式），前端按行解析后渲染
	// 代码折叠 / 行内评论挂载点。
	//
	// Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/files/{file_index}/patch
	//        或直接 GET /repos/{owner}/{repo}/pulls/{index}.diff 取完整 diff 再按文件拆分
	// GitHub: GET /repos/{owner}/{repo}/pulls/{filename} 走 redir；推荐用 pulls/{number}.diff
	//        后端统一拉完整 diff 后按文件拆分 → 降低实现跨平台一致性成本
	GetPullFileDiff(ctx context.Context, hostURL, username, token, owner, repo string, index int, filePath string) (*PullFileDiffDTO, error)

	// ListPullCommits 列出 PR 中包含的提交（head 分支有但 base 分支没有的 commit）
	//
	// Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/commits
	// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/commits
	ListPullCommits(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]PullCommitDTO, error)

	ListLabels(ctx context.Context, hostURL, username, token, owner, repo string) ([]LabelDTO, error)

	// ListMembers 列出仓库成员
	ListMembers(ctx context.Context, hostURL, username, token, owner, repo string) ([]MemberDTO, error)

	// ListMilestones 列出仓库里程碑（v0.6.0）
	//
	// Gitea:  GET /repos/{owner}/{repo}/milestones?state=open|closed|all
	// GitHub: GET /repos/{owner}/{repo}/miliseconds?state=open|closed|all
	ListMilestones(ctx context.Context, hostURL, username, token, owner, repo string, state string) ([]MilestoneDTO, error)

	// UpdatePullMilestone 给合并请求关联里程碑（v0.6.0）
	//
	// Gitea:  PATCH /repos/{owner}/{repo}/pulls/{index} {"milestone": <title>|""}（title 查找或 404）
	// GitHub: PATCH /repos/{owner}/{repo}/pulls/{pull_number} {"milestone": <number>|null}
	UpdatePullMilestone(ctx context.Context, hostURL, username, token, owner, repo string, index int, milestone string) (*PullDetailDTO, error)

	// UploadIssueAttachment 上传 PR/issue 附件（v0.7.0 贴图支持）
	//
	// Gitea:  POST /repos/{owner}/{repo}/issues/{index}/assets multipart/form-data
	//         form field: attachment (required) — 注意不是 "file"
	//         返回 Gitea Attachment（id/name/size/uuid/browser_download_url）
	// GitHub: POST /repos/{owner}/{repo}/issues/{issue_number}/assets multipart/form-data
	//         form field: file (required) — 与 Gitea 字段名不同，adapter 层翻译
	//
	// fileName 仅作日志/debug 用，真正写到 multipart body 的是 fileContent
	// (调用方把 File 转 base64 通过 Wails binding 传过来，Go 端解码)。
	// browserDownloadURL 形如 https://<host>/attachments/<uuid>，可直接塞到
	// markdown `![](url)` 里让 Gitea 渲染。
	UploadIssueAttachment(ctx context.Context, hostURL, username, token, owner, repo string, index int, fileName string, fileContent []byte) (*AttachmentDTO, error)
}

// AttachmentDTO 平台中性附件 DTO（v0.7.0 贴图支持）
//
// BrowserDownloadURL 形如 https://<host>/attachments/<uuid>，可直接塞到
// markdown `![](url)` 里让 Gitea/GitHub 渲染。也可省略 host 用相对路径
// `![](/attachments/<uuid>)` — Gitea 渲染器会处理 /attachments/* 路由的鉴权。
type AttachmentDTO struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	UUID               string `json:"uuid"`
	BrowserDownloadURL string `json:"browserDownloadUrl"`
}

// PullCommitDTO PR 提交列表项
//
// 对齐 Gitea /repos/{owner}/{repo}/pulls/{index}/commits 返回结构。
type PullCommitDTO struct {
	SHA        string `json:"sha"`
	ShortSHA   string `json:"shortSha"`
	Subject    string `json:"subject"`
	Body       string `json:"body,omitempty"`
	AuthorName string `json:"authorName"`
	AuthorMail string `json:"authorMail,omitempty"`
	AuthoredAt string `json:"authoredAt"`
	Committed  string `json:"committed,omitempty"`
	Verified   bool   `json:"verified,omitempty"`
}

// MilestoneDTO 里程碑（v0.6.0）
type MilestoneDTO struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	State       string `json:"state"` // "open" | "closed"
	Description string `json:"description,omitempty"`
}

// PullFileDTO PR 修改文件列表项（v0.5.0 M4）
//
// Gitea 字段：filename, status, additions, deletions, changes, patch, blob_url, raw_url
// GitHub 字段：filename, status, additions, deletions, changes, patch, blob_url, raw_url, sha
// 两者结构几乎一致，必须用 filename + status + additions + deletions。
type PullFileDTO struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"` // "added" | "modified" | "deleted" | "renamed"
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Changes   int    `json:"changes"`
	// Patch 可选（小文件才带，大文件前端按需 GetPullFileDiff）；
	// Gitea 和 GitHub 都返 patch 字段但内容量不稳定。
	Patch string `json:"patch,omitempty"`
	// PreviousFilename 仅 status=renamed 时有值（旧文件名）。
	PreviousFilename string `json:"previousFilename,omitempty"`
}

// PullFileDiffDTO 单文件的 diff 详情（v0.5.0 M4）
//
// 包含原始 unified diff 文本 + 解析后行号锚点（前端行内评论挂载点）。
type PullFileDiffDTO struct {
	Filename string `json:"filename"`
	// RawDiff 完整 unified diff 文本（hunk header + context +/- lines）
	RawDiff string `json:"rawDiff"`
	// Hunks 解析后的 diff hunk 列表（前端按 hunk 渲染上下文代码块）
	Hunks []PullDiffHunk `json:"hunks"`
}

// PullDiffHunk 单个 diff hunk（v0.5.0 M4）
//
// 对应 unified diff 中一个 @@ 块。
type PullDiffHunk struct {
	OldStart int `json:"oldStart"`
	OldLines int `json:"oldLines"`
	NewStart int `json:"newStart"`
	NewLines int `json:"newLines"`
	// Header hunk 第一行（@@ -a,b +c,d @@ 上下文）
	Header string `json:"header"`
	// Lines hunk 内所有代码行（前缀 ' ' = 上下文, '+' = 新增, '-' = 删除）
	Lines []string `json:"lines"`
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
	Head  string // 可选：head 分支过滤
	Base  string // 可选：base 分支过滤
	Page  int
	Limit int
}

// MergePullOpts 合并合并请求参数
//
// MergeMethod 与前端 MergeMethod 对齐（Gitea / GitHub 共有值）：
//   - "merge"        → 普通合并（保留所有提交历史）
//   - "rebase"       → 变基后快进（重写历史，单一线性，GitHub 把它叫 "rebase"）
//   - "rebase-merge" → 变基后 merge commit（Gitea 专属）
//   - "squash"       → 压缩为单提交
//
// GitHub 不支持 "rebase-merge"，调用方需按平台分支处理（详见 GitHubAdapter.MergePull）
type MergePullOpts struct {
	Method            string // 见 MergeMethod
	DeleteBranchAfter bool   // 合并后是否删除源分支
	CommitMessage     string // 可选；method="squash" 时部分平台要求非空
}

// LogGraphOpts log graph 参数
type LogGraphOpts struct {
	Branches []string
	MaxCount int
	// Head 当前 checkout 的 commit hash, 用于标记 isCurrent (vscode HEAD 高亮).
	// 空字符串则全部 isCurrent=false (HEAD 由 vscode 自身显示 uncommitted dot)
	Head string
	// Offset 跳过前 N 条 commit（分页用，0 = 不跳过）
	Offset int
	// Token 仓库 token（offset 越界 + repoIsShallow 时后台增量 deepen 用）
	Token string
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
	// LocalExhausted 本地 commit 已全部取出，远端可能有更多（需 deepen）。
	LocalExhausted bool `json:"localExhausted"`
	// DeepenTriggered 后端已启动后台增量 deepen 拉取远端 commit。
	DeepenTriggered bool `json:"deepenTriggered"`
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

// PullDetailDTO 合并请求完整详情（GetPull / MergePull / ClosePull / UpdatePull* 返回值）
//
// 与 PullDTO 区分：列表接口轻量，详情接口完整。
// 字段对齐前端 PullDto（frontend/src/types/dto.ts），前端 store 直接复用。
type PullDetailDTO struct {
	Index          int            `json:"index"`
	Number         int            `json:"number"` // = Index；保留兼容 Gitea / GitHub 字段命名
	Title          string         `json:"title"`
	State          string         `json:"state"` // "open" | "closed"
	Draft          bool           `json:"draft"`
	Merged         bool           `json:"merged"`
	Head           PullRefDTO     `json:"head"`
	Base           PullRefDTO     `json:"base"`
	Author         *PullUserDTO   `json:"author,omitempty"`
	CreatedAt      string         `json:"createdAt"`    // ISO 8601
	UpdatedAt      string         `json:"updatedAt"`    // ISO 8601
	Mergeable      bool           `json:"mergeable"`    // false=有冲突/不可合并
	HasConflicts   bool           `json:"hasConflicts"` // = !Mergeable（前端视图字段对齐）
	Body           string         `json:"body,omitempty"`
	CommentsCount  int            `json:"commentsCount"`
	Labels         []PullLabelDTO `json:"labels,omitempty"`
	Assignees      []PullUserDTO  `json:"assignees,omitempty"`
	Reviewers      []PullUserDTO  `json:"reviewers,omitempty"`
	MergedBy       *PullUserDTO   `json:"mergedBy,omitempty"`
	MergeCommitSHA string         `json:"mergeCommitSha,omitempty"` // 合并成功后回填
	// Milestone v0.6.0：get / patch 后填回（如设置过则填，否则 nil）
	// Gitea 端 LongPoll 时间充裕（v0.7.0 漏映射，由 github 端补 PullDetailDTO 字段后可在 gitea adapter 也映射）
	Milestone *MilestoneDTO `json:"milestone,omitempty"`
}

// PullRefDTO head / base 引用信息
type PullRefDTO struct {
	Ref string `json:"ref"` // 分支名
	SHA string `json:"sha"` // 分支顶端 commit hash
}

// PullUserDTO 嵌套用户信息（author / assignees / reviewers / mergedBy）
type PullUserDTO struct {
	Username  string `json:"username"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// PullLabelDTO 嵌套标签信息
type PullLabelDTO struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// CommentDTO 合并请求 / 议题评论（v0.6+ 共享）
//
// v0.7.x 备注：仅 ListPullComments (走 /issues/{index}/comments) 使用此 DTO,
// 该端点只返回 type=0 普通评论。系统事件走 ListPullTimeline DTO。
type CommentDTO struct {
	ID        int64        `json:"id"`
	Body      string       `json:"body"`
	Author    *PullUserDTO `json:"author,omitempty"`
	CreatedAt string       `json:"createdAt"`
	UpdatedAt string       `json:"updatedAt,omitempty"`
	UserID    int64        `json:"userId,omitempty"`
	// Type 评论类型（0=COMMENT 普通评论）
	Type int `json:"type"`
}

// TimelineItem 时间线条目（v0.7.x 对齐 Gitea web）
//
// Gitea web 的时间轴是 50+ 种 CommentType 统一走 /issues/{index}/timeline 端点,
// 返回所有评论 + 评审事件 + 系统事件, 前端按 Type 分类渲染不同卡片。
//
// Type 取值（对应 Gitea CommentType.String()）:
//
//	"comment"=0 普通评论 | "review"=22 评审事件 | "code"=21 行内代码评论
//	"reopen"=1 | "close"=2 | "issue_ref"=3 | "commit_ref"=4 | "comment_ref"=5 | "pull_ref"=6
//	"label"=7 | "milestone"=8 | "assignees"=9 | "change_title"=10 | "delete_branch"=11
//	"start_tracking"=12 | "stop_tracking"=13 | "add_time_manual"=14 | "cancel_tracking"=15
//	"added_deadline"=16 | "modified_deadline"=17 | "removed_deadline"=18
//	"add_dependency"=19 | "remove_dependency"=20
//	"lock"=23 | "unlock"=24 | "change_target_branch"=25 | "delete_time_manual"=26
//	"review_request"=27 | "merge_pull"=28 | "pull_request_push"=29
//	"project"=30 | "project_column"=31 | "dismiss_review"=32 | "change_issue_ref"=33
//	"pr_scheduled_to_auto_merge"=34 | "pr_unscheduled_to_auto_merge"=35
//	"pin"=36 | "unpin"=37 | "change_time_estimate"=38
type TimelineItem struct {
	ID      int64        `json:"id"`
	Type    string       `json:"type"`
	Body    string       `json:"body"`
	Author  *PullUserDTO `json:"author,omitempty"`
	Created string       `json:"created"`
	Updated string       `json:"updated,omitempty"`

	// type=22 评审事件专属字段
	State    string `json:"state,omitempty"`     // "approved" / "changes_requested" / "commented"
	CommitID string `json:"commit_id,omitempty"` // 评审针对的 commit SHA
	Official bool   `json:"official,omitempty"`  // 是否是官方评审（有写权限）

	// type=29 推送事件专属
	CommitSHA string `json:"commit_sha,omitempty"` // 推送后 head 的最新 commit SHA
}

// ReactionDTO 单条表情反应（v0.5.0 M2）
type ReactionDTO struct {
	ID      int64        `json:"id"`
	Content string       `json:"content"` // "+1" / "-1" / "laugh" / "confused" / "heart" / "hooray" / "eyes" / "rocket"
	User    *PullUserDTO `json:"user,omitempty"`
}

// PullReviewDTO 合并请求评审（v0.5.0 M3）
type PullReviewDTO struct {
	ID          int64        `json:"id"`
	State       string       `json:"state"` // 前端约定小写: "approved" / "changes_requested" / "commented"
	Body        string       `json:"body"`  // 评审总结文
	Author      *PullUserDTO `json:"author"`
	CommitID    string       `json:"commitId"`    // 评审针对的 commit SHA
	SubmittedAt string       `json:"submittedAt"` // 评审时间（Gitea: submitted; GitHub: submitted_at）
}

// NormalizeReviewState 把上游平台返回的 review state 归一化到前端约定的小写值。
//
// 上游差异（实测）:
//   - Gitea 1.22+ /pulls/{index}/reviews 返回: APPROVED / PENDING / COMMENT / REQUEST_CHANGES / REQUEST_REVIEW
//   - GitHub /repos/{owner}/{repo}/pulls/{number}/reviews 返回: APPROVED / CHANGES_REQUESTED / COMMENTED / PENDING / DISMISSED
//
// 前端 union type 期望: 'approved' | 'changes_requested' | 'commented'（见 dto.ts ReviewState）
// 大小写不一致 + 字段名不同（REQUEST_CHANGES vs CHANGES_REQUESTED, COMMENT vs COMMENTED）会
// 导致 reviewStateLabel fallthrough、CSS class 不匹配、review 头像永远显示 💬。必须归一化。
//
// 不可识别的值原样回传,留待后续版本或前端处理。
func NormalizeReviewState(raw string) string {
	switch raw {
	// 已批准
	case "APPROVED", "approved":
		return "approved"
	// 请求修改
	case "REQUEST_CHANGES", "request_changes", "CHANGES_REQUESTED", "changes_requested":
		return "changes_requested"
	// 仅评论（Gitea 与 GitHub 字段名不一致）
	case "COMMENT", "COMMENTED", "commented":
		return "commented"
	// 待定（Gitea "REQUEST_REVIEW" 也归为待定,前端用 'commented' 兜底显示）
	case "PENDING", "REQUEST_REVIEW", "DISMISSED":
		return "commented"
	default:
		return raw
	}
}

// CreatePullReviewOpts 创建评审参数（v0.5.0 M3 + v0.6.0 补 comments）
type CreateReviewOpts struct {
	CommitID string // 可选：评审针对的 commit SHA（空 = HEAD）
	Body     string // 评审总结文
	Event    string // "approve" | "request_changes" | "comment"（前端统一小写）
	// Comments 行内评审评论列表（v0.6.0 新增，允许创建 Review 时一次性附带）
	// Gitea: comments[].body, comments[].path, comments[].new_position
	// GitHub: comments[].body, comments[].path, comments[].line
	Comments []CreateReviewCommentOpts `json:"comments,omitempty"`
}

// CreateReviewCommentOpts 创建评审时附带的单条行内评论（v0.6.0）
type CreateReviewCommentOpts struct {
	Body     string `json:"body"`
	Path     string `json:"path"`
	Position int    `json:"new_position"` // Gitea 用 new_position；GitHub 用 line（adapter 层翻译）
}

// PullReviewCommentDto 行内评审评论 DTO（v0.5.0 M4）
//
// 字段对齐 Gitea ReviewComment + GitHub Pull Request Review Comment，
// 包含文件路径 + 行号，前端按 path 分组渲染到 diff 侧边栏。
type PullReviewCommentDto struct {
	ID        int64        `json:"id"`
	Body      string       `json:"body"`
	Author    *PullUserDTO `json:"author,omitempty"`
	Path      string       `json:"path"`
	Line      int          `json:"line"`
	CreatedAt string       `json:"createdAt"`
	UpdatedAt string       `json:"updatedAt,omitempty"`
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
