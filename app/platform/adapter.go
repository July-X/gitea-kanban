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

	// v0.7.25：UpdatePullTitle 修改合并请求标题（用于 WIP toggle 去掉 "WIP:" 前缀）
	// Gitea 走 PATCH /repos/{owner}/{repo}/issues/{index} body {"title": "new title"}
	// GitHub 走 PATCH /repos/{owner}/{repo}/issues/{number} body {"title": "new title"}（PR 也是 issue）
	// 返回更新后的 PullDetailDTO（含新 title / draft 字段，前端用 draft 判断是否去掉 WIP）。
	UpdatePullTitle(ctx context.Context, hostURL, username, token, owner, repo string, index int, title string) (*PullDetailDTO, error)

	// v0.7.26：GetPullCommitsBehind 拿"基础分支领先 head 分支的提交数"
	//
	// Gitea 走 GET /repos/{owner}/{repo}/compare/{head}...{base}，
	// response.total_commits 就是 commits_behind（base 领先 head）。
	// GitHub 走 GET /repos/{owner}/{repo}/compare/{base}...{head}，
	// response.behind_by 是 commits_behind。
	//
	// 用于：
	//   - 过期警告 "此分支相比基础分支已过期"（v0.7.26 跟 Gitea web pull_merge_box 1:1 对齐）
	//   - "通过合并更新分支"按钮（调 UpdatePullBranch API）
	//
	// 注意：Gitea 1.26+ /pulls/{index} 端点不返 commits_behind 字段（之前 v0.7.x
	// TODO），必须调 /compare 端点单独拿。
	GetPullCommitsBehind(ctx context.Context, hostURL, username, token, owner, repo, base, head string) (int, error)

	// v0.7.26：UpdatePullBranch 更新 head 分支（合并 base → head 或 rebase head on base）
	//
	// Gitea 走 POST /repos/{owner}/{repo}/pulls/{index}/update?style=merge
	//       或 POST .../update?style=rebase
	// GitHub 走 PUT /repos/{owner}/{repo}/pulls/{index}/update-branch
	//       body {"expected_head_sha": "..."}（用 rebase / merge 由 GitHub 决定）
	//
	// style: "merge" | "rebase"（对齐 Gitea 端 UpdateStyle）
	// 返回更新后的 PullDetailDTO。
	UpdatePullBranch(ctx context.Context, hostURL, username, token, owner, repo string, index int, style string) (*PullDetailDTO, error)

	// v0.7.28：RestorePullBranch 恢复 head 分支（PR 关闭后 head branch 被删时
	// GitHub web 显示 "Restore branch" 按钮调这个）
	//
	// Gitea + GitHub 端点统一都是 POST /repos/{owner}/{repo}/git/refs
	// body: {"ref": "refs/heads/{branch}", "sha": "{commit_sha}"}
	//   - branch: 要恢复的分支名（不带 refs/heads/ 前缀，前端 PR 详情 head.ref 拿）
	//   - sha:    分支指向的 commit SHA（PR 详情 head.sha）
	// 成功返 201 + ref 对象（含 ref URL）；失败常见错误：
	//   - 422: 分支已存在（ref exists）→ 提示用户"分支已存在，无需恢复"
	//   - 422: commit SHA 不存在 → 罕见
	RestorePullBranch(ctx context.Context, hostURL, username, token, owner, repo, branch, sha string) error

	// v0.7.29：DeletePullBranch 删除 head 分支（PR 关闭 + "Delete branch" 按钮用）
	//
	// Gitea 走 DELETE /api/v1/repos/{owner}/{repo}/git/refs/{ref}（ref 含 refs/heads/ 前缀）
	// GitHub 走 DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}（branch 不带 refs/heads/ 前缀）
	//
	// 成功返 204 No Content；分支不存在返 404（race condition：用户在两个 tab 同时删）。
	//
	// branch: 不带 refs/heads/ 前缀（前端 PR 详情 head.ref 拿，v0.7.28 已 split owner: 前缀）
	DeletePullBranch(ctx context.Context, hostURL, username, token, owner, repo, branch string) error

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

	// v0.7.2：timeline ref 字段（ref_issue / dependent_issue 用），ListIssues 端点不填
	RepoID       int64  `json:"repo_id,omitempty"`
	RepoFullName string `json:"repo_full_name,omitempty"` // "owner/repo"
	IsPull       bool   `json:"is_pull,omitempty"`
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
	Index         int          `json:"index"`
	Number        int          `json:"number"` // = Index；保留兼容 Gitea / GitHub 字段命名
	Title         string       `json:"title"`
	State         string       `json:"state"` // "open" | "closed"
	Draft         bool         `json:"draft"`
	Merged        bool         `json:"merged"`
	Head          PullRefDTO   `json:"head"`
	Base          PullRefDTO   `json:"base"`
	Author        *PullUserDTO `json:"author,omitempty"`
	CreatedAt     string       `json:"createdAt"`    // ISO 8601
	UpdatedAt     string       `json:"updatedAt"`    // ISO 8601
	Mergeable     bool         `json:"mergeable"`    // false=有冲突/不可合并
	HasConflicts  bool         `json:"hasConflicts"` // = !Mergeable（前端视图字段对齐）
	Body          string       `json:"body,omitempty"`
	CommentsCount int          `json:"commentsCount"`
	// v0.7.6：PR 头部分支信息显示 "请求将 N 次代码提交从 {head} 合并至 {base}" 用
	// （对齐 Gitea web `templates/repo/issue/view_title.tmpl` 渲染）。
	// Gitea 端 /repos/{owner}/{repo}/pulls/{index} 返回的 `commits` 字段（N=0 兜底"1 次"）。
	Commits        int            `json:"commits,omitempty"`
	Labels         []PullLabelDTO `json:"labels,omitempty"`
	Assignees      []PullUserDTO  `json:"assignees,omitempty"`
	Reviewers      []PullUserDTO  `json:"reviewers,omitempty"`
	MergedBy       *PullUserDTO   `json:"mergedBy,omitempty"`
	MergeCommitSHA string         `json:"mergeCommitSha,omitempty"` // 合并成功后回填
	// v0.7.26：commits_behind 字段（PR 基础分支领先 head 分支的提交数）
	//
	// Gitea 1.26+ /pulls/{index} 端点不返这个字段，必须调
	// GET /repos/{owner}/{repo}/compare/{head}...{base} 拿 total_commits。
	// giteaPullToDetail / githubPullToDetail 暂填 0，由 store.fetchPullDetail
	// 后调 platform.GetPullCommitsBehind 拿值 + patchItem 同步。
	//
	// 用于：
	//   - 过期警告 "此分支相比基础分支已过期"
	//   - "通过合并更新分支"按钮的 v-if 条件
	CommitsBehind int `json:"commitsBehind,omitempty"`
	// Milestone v0.6.0：get / patch 后填回（如设置过则填，否则 nil）
	// Gitea 端 LongPoll 时间充裕（v0.7.0 漏映射，由 github 端补 PullDetailDTO 字段后可在 gitea adapter 也映射）
	Milestone *MilestoneDTO `json:"milestone,omitempty"`
}

// PullRefDTO head / base 引用信息
//
// v0.7.9 增量：加 Label 字段（真实分支名显示用）。
// 背景：Gitea `/pulls/{index}` 端点 head.ref 返的是 git ref 全路径
// （如 `refs/pull/72/head`），不是真实分支名（`pr-with-labels-366575`）。
// Gitea 端额外返 `head.label` 字段（真实分支名，掉 `refs/heads/` 前缀），
// Gitea web 模板用 label 字段渲染分支名（Gitea web 端 PR header
// "X 请求将 N 次提交从 {head.label} 合并至 {base.label}"）。
// 我们 v0.7.6 改 PR header 格式时只用了 `selectedPR.head.ref`，
// 导致显示成 "refs/pull/72/head" 这种 ref id（user 反馈 "缺少明确的分支记录"）。
//
// v0.7.9 修：加 Label 字段映射，模板用 `head.label || head.ref` 兜底
// （Gitea < 1.20 / GitHub API 都没有 label 字段，回退到 ref）。
type PullRefDTO struct {
	Ref   string `json:"ref"`             // git ref 全路径（`refs/pull/N/head` / `refs/heads/main`）
	Label string `json:"label,omitempty"` // 真实分支名（`pr-with-labels-366575`），Gitea 1.20+ / GitHub 无此字段
	SHA   string `json:"sha"`             // 分支顶端 commit hash
}

// PullUserDTO 嵌套用户信息（author / assignees / reviewers / mergedBy / assignee / assigner / poster）
//
// v0.7.4 增量：加 FullName 字段，对齐 Gitea web 显示习惯。
// Gitea web 的 `shared/user/authorlink` 优先用 User.FullName，回退到 User.Login。
// 之前前端只用 Username（@login），导致用户用 DisplayName 注册时评论/事件里显示小写 login，
// 跟 Gitea web 的 "M4JAVA" 大写 display name 不一致。FullName 用 omitempty，
// Gitea / GitHub 没返回时不影响老 DTO 兼容性。
type PullUserDTO struct {
	Username  string `json:"username"`
	FullName  string `json:"fullName,omitempty"`
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
//	"review_request"=27 | "merge_pull"=28 | "pull_push"=29
//	"project"=30 | "project_column"=31 | "dismiss_review"=32 | "change_issue_ref"=33
//	"pr_scheduled_to_auto_merge"=34 | "pr_unscheduled_to_auto_merge"=35
//	"pin"=36 | "unpin"=37 | "change_time_estimate"=38
//
// **v0.7.8 类型归一化**：Gitea 端 `merge_pull` / `pull_push` 是 snake_case 字符串，
// 前端 type 字典表之前用 `merge` / `push` 假设 —— v0.7.5/v0.7.7 凭印象写的没实测，
// 导致所有 push / merge 事件模板都不渲染。`giteaTimelineToItem` 在适配层做归一化：
// `pull_push` → `push`、`merge_pull` → `merge`，前端 type 字符串保持稳定。
type TimelineItem struct {
	ID      int64        `json:"id"`
	Type    string       `json:"type"`
	Body    string       `json:"body"`
	Author  *PullUserDTO `json:"author,omitempty"`
	Created string       `json:"created"`
	Updated string       `json:"updated,omitempty"`

	// type=22 评审事件专属字段
	State    string `json:"state,omitempty"`    // "approved" / "changes_requested" / "commented"
	CommitID string `json:"commitId,omitempty"` // 评审针对的 commit SHA
	Official bool   `json:"official,omitempty"` // 是否是官方评审（有写权限）

	// type=29 推送事件专属
	CommitSHA string `json:"commitSha,omitempty"` // 推送后 head 的最新 commit SHA

	// v0.7.2：Gitea /timeline 端点暴露的二级详情字段。
	// 前端用这些字段渲染"系统事件卡"下方的 detail 块（对齐 Gitea web）。
	// 不是所有平台都暴露同样字段（GitHub /timeline 只返 type=0 评论，事件类型都是 stub），
	// 所以用 omitempty 让缺失时不出现在 JSON 里，前端按需读。
	//
	// v0.7.18 根因修复：json tag 全部改 camelCase（之前是 snake_case，跟 PullDetailDTO
	// 风格不一致）。Wails binding generator 用 Go struct json tag 生成 TS 字段名——
	// PullDetailDTO 用 camelCase 所以 Wails 生成 camelCase；TimelineItem 用 snake_case
	// 所以 Wails 生成 snake_case。前端 dto.ts 统一 camelCase（`commitIds` / `isWipToggle` /
	// `addedLabels` 等），store 把 Wails TimelineItem 强转成 TimelineItemDto 后所有
	// camelCase 访问都拿到 undefined（push 事件 block 块不渲染、merge event verb
	// 走 WIP toggle 兜底、label 合并走不到、assignees isSelfAssign 永远 false 等）。
	// 修法：改 Go 端 json tag 跟 PullDetailDTO 保持 camelCase，wails build 重新生成
	// models.ts，store 强转后字段直接对齐。

	// type=10 (change_title) —— 标题变化
	OldTitle string `json:"oldTitle,omitempty"`
	NewTitle string `json:"newTitle,omitempty"`

	// type=11 (delete_branch) / 25 (change_target_branch) / 33 (change_issue_ref) —— 分支/引用名
	OldRef string `json:"oldRef,omitempty"`
	NewRef string `json:"newRef,omitempty"`

	// type=7 (label) —— 单个 label（Gitea API 一次只暴露一个 label，不暴露 added/removed 数组）
	Label *PullLabelDTO `json:"label,omitempty"`

	// type=8 (milestone) —— 里程碑变化
	OldMilestone *MilestoneDTO `json:"oldMilestone,omitempty"`
	Milestone    *MilestoneDTO `json:"milestone,omitempty"`

	// type=9 (assignees) —— 指派人变化
	Assignee        *PullUserDTO `json:"assignee,omitempty"`
	RemovedAssignee bool         `json:"removedAssignee,omitempty"` // true=移除，false=添加

	// type=3 (issue_ref) / 5 (comment_ref) / 6 (pull_ref) / 33 (change_issue_ref) —— 跨引用
	RefIssue     *IssueDTO `json:"refIssue,omitempty"`
	RefAction    string    `json:"refAction,omitempty"`    // "close" / "reopen" / "cross" 之一
	RefCommitSHA string    `json:"refCommitSha,omitempty"` // type=4 commit ref 时引用到的 commit SHA

	// type=19 (add_dependency) / 20 (remove_dependency) —— 依赖 issue
	DependentIssue *IssueDTO `json:"dependentIssue,omitempty"`

	// v0.7.6：WIP toggle 标记（仅 type=10 change_title 事件可能命中）
	//
	// 根因：Gitea web 的 `modules/templates/util_render_comment.go:commentTimelineEventIsWipToggle`
	// 把"标题加了/去掉 WIP: 前缀"识别为特殊事件（用户拖 draft toggle 按钮的效果），
	// 渲染 "marked the pull request as work in progress / ready for review" 文案，
	// 而不是 "change_title_at" 文案。
	//
	// 后端检测规则（对齐 Gitea 源码 CutWorkInProgressPrefix）：
	//   - OldTitle / NewTitle 中一个带 WIP 前缀另一个不带（ok1 != ok2）
	//   - 去掉前缀后两个标题 TrimSpace 相等
	// → IsWipToggle=true；IsWip 表示"切换后是 WIP 状态"（NewTitle 有前缀）
	//
	// 前端 systemEventVerb 在 type='change_title' + IsWipToggle 时返回
	// "已将合并请求标记为进行中" / "已将合并请求标记为可评审"，对齐 Gitea web
	// `repo.pulls.marked_as_work_in_progress_at` / `marked_as_ready_for_review_at` 中文 locale。
	IsWipToggle bool `json:"isWipToggle,omitempty"`
	IsWip       bool `json:"isWip,omitempty"`

	// v0.7.6：label 事件聚合（对齐 Gitea web `routers/web/repo/issue_view.go:mergeLabels` 逻辑）
	//
	// Gitea /timeline 端点每个 label 变化返回 1 条独立 type=7 事件（单数 Label 字段），
	// Gitea web 在 web 端按"同作者 + 60s 内连续 label 事件"合并为 1 条带 AddedLabels /
	// RemovedLabels 数组的事件。我们 app 没 web 端的"修改后渲染"环节，需要在
	// 前端 timeline store fetchTimeline 后做同样的合并处理，结果写到 AddedLabels /
	// RemovedLabels 字段。
	//
	// Content 字段含义：Gitea `issues.Comment.Content` 在 type=7 时存 "1"=添加 / 其他=移除。
	// 解析时把单数 Label + Content 判断填到 AddedLabels 或 RemovedLabels 数组里。
	AddedLabels   []*PullLabelDTO `json:"addedLabels,omitempty"`
	RemovedLabels []*PullLabelDTO `json:"removedLabels,omitempty"`
	// LabelAction 标记单条 label 事件的 add/remove 方向（前端合并用）：
	//   "add" = Content == "1"（添加），"remove" = Content != "1"（移除）
	LabelAction string `json:"labelAction,omitempty"`

	// v0.7.8：type=29 (push) 事件专属字段 —— 重新对齐 Gitea 端实际 API。
	//
	// 根因（v0.7.7 错假设修复）：
	//   v0.7.7 假设 Gitea /issues/{index}/timeline 端点顶层会返回
	//   `old_commit_id / new_commit_id / commits_num / is_force_push` 4 个独立字段，
	//   实际 Gitea 1.26+ API 这 4 个字段**全部不返回**。
	//   真实数据在 `body` JSON 字符串里：`{"is_force_push":false,"commit_ids":["sha1","sha2"]}`。
	//   旧版（<= 1.25）返回 `commit_id` 单字段，新版改 body JSON，Gitea web 端模板
	//   `repo/issue/view_content/comments.tmpl` 是用 `commit_ids` 数组渲染 commit 列表。
	//
	// 字段含义：
	//   - CommitIDs: 本次 push 的所有 commit SHA 数组（full 40 位 SHA，按 push 顺序）
	//     前端直接拿这个数组渲染 commit 列表（短 SHA 链接 + 提交消息可选从
	//     /pulls/{index}/commits 二次拉取）。**不再需要调 /pulls/{index}/commits 端点
	//     做时间窗分组**（v0.7.7 简化版算法已弃用）。
	//   - IsForcePush: 是否强制推送（true → 模板走 force push 渲染分支）
	//   - 删 v0.7.7 假设的 OldCommit / NewCommit / CommitsNum 3 个字段 —— Gitea API 不返回。
	//
	// v0.7.7 还存在的字段：MergeCommitSHA，merge 事件专用。Gitea 1.26+ timeline
	// 端点 merge_pull 事件 body 是空字符串（**没有** merge commit SHA），必须从
	// PR 详情端点 /pulls/{index} 的 `merge_commit_sha` 字段拿（v0.7.8 修 giteaPullRaw 映射）。
	CommitIDs   []string `json:"commitIds,omitempty"`
	IsForcePush bool     `json:"isForcePush,omitempty"`
	// MergeCommitSHA：v0.7.7 加的，v0.7.8 修来源 —— Gitea 1.26+ timeline 不返回，
	// 由 PR 详情 GetPull 端点 `merge_commit_sha` 字段映射过来。TimelineItem 这个字段保留
	// 是为 v0.7.5 之前的 type 字符串表（"merge"）的渲染，模板里 inline 块可拿
	// selectedPR.mergeCommitSha 兜底（PullDetailDTO 已加 MergeCommitSHA 字段，v0.7.8 修 raw 映射）。
	MergeCommitSHA string `json:"mergeCommitSha,omitempty"`
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
