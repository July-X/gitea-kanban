package main

import (
	"errors"
	"gitea-kanban/app/ipc"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/store"
	"strings"
)

// ===== 合并请求（Pull Request）Wails bindings =====
//
// v0.6+ 用户拍板：合并请求与 Git Graph 一样适配用户当前绑定账号的 git 服务器类型
// （Gitea/GitHub），前端 store 拿 platform 中性 DTO，UI 不关心底层平台。
//
// 鉴权铁律（AGENTS §8.1）：
//   - 前端只传 projectId（业务态概念）
//   - Go 端反查 localStore.Projects → Accounts → secretStore 拿 token
//   - token 绝不离开主进程内存，不写日志，不返前端
//
// 设计：
//   - 每个 binding 共用 resolvePullContext helper 拿 project/account/token/adapter
//   - PullDetailDTO 直接透传给前端（结构对齐 frontend/src/types/dto.ts PullDto）
//   - 写操作（MergePull/ClosePull/Update*）走 slog.Info 记审计日志

// PullDetailAppDTO 暴露给前端的合并请求完整详情 DTO
//
// 字段对齐 frontend/src/types/dto.ts PullDto；前端 store 直接复用
type PullDetailAppDTO = platformAdapter.PullDetailDTO

// PullListAppResp 列合并请求的响应（items + hasMore，给前端"加载更多"用）
type PullListAppResp struct {
	Items   []PullDetailAppDTO `json:"items"`
	Total   int                `json:"total"`   // 当前 state 下 gitea 给的总数；GitHub 没有总数则 = len(items)
	HasMore bool               `json:"hasMore"` // hasMore = len(items) == limit 且还有潜在下一页
}

// resolvePullContext 合并请求 Wails bindings 的共享 helper
//
// 返回：project + account + token + adapter，调用方拿到后直接调 adapter 方法。
// 失败时返 IpcError，前端 ErrorFormatter 会结构化序列化。
//
// 注意：只接受 projectId，**不**接受 hostUrl/token；AGENTS §8.1 铁律。
func (a *App) resolvePullContext(projectID string) (*store.RepoProject, *store.GiteaAccount, string, platformAdapter.PlatformAdapter, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, nil, "", nil, ipc.NewValidationFailed("projectId 不能为空", "")
	}
	project, account, err := a.findProjectAndAccount(projectID)
	if err != nil {
		return nil, nil, "", nil, err
	}
	token, err := a.resolveToken(account)
	if err != nil {
		return nil, nil, "", nil, err
	}
	adapter := a.getAdapter(account.Platform)
	if adapter == nil {
		return nil, nil, "", nil, ipc.NewUnsupportedPlatform(account.Platform)
	}
	return project, account, token, adapter, nil
}

// ===== ListPulls =====

// ListPullsArgs 列表合并请求参数
type ListPullsArgs struct {
	ProjectID string `json:"projectId"`
	State     string `json:"state"` // "open" | "closed" | "all"
	Head      string `json:"head,omitempty"`
	Base      string `json:"base,omitempty"`
	Page      int    `json:"page"`
	Limit     int    `json:"limit"`
}

// ListPulls 列出某项目的合并请求（Gitea + GitHub 都支持，v0.6+ 拍板）
//
// 鉴权铁律（AGENTS §8.1）：前端只传 projectId。
// 平台选择走 findProjectAndAccount → account.Platform → giteaAdapter / githubAdapter。
func (a *App) ListPulls(args ListPullsArgs) (PullListAppResp, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullListAppResp{}, err
	}

	items, err := adapter.ListPulls(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, platformAdapter.ListPullsOpts{
		State: args.State,
		Head:  args.Head,
		Base:  args.Base,
		Page:  args.Page,
		Limit: args.Limit,
	})
	if err != nil {
		return PullListAppResp{}, err
	}

	limit := args.Limit
	if limit <= 0 {
		limit = 30
	}
	hasMore := len(items) >= limit
	if a.logger != nil {
		a.logger.Info("ListPulls",
			"projectId", args.ProjectID, "platform", account.Platform,
			"state", args.State, "count", len(items), "hasMore", hasMore)
	}
	return PullListAppResp{
		Items:   items,
		Total:   len(items), // GitHub 不返总数；前端按 hasMore 触发加载更多
		HasMore: hasMore,
	}, nil
}

// ===== GetPull =====

// GetPullArgs 获取单个合并请求参数
type GetPullArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// GetPull 获取单个合并请求详情（Gitea + GitHub 都支持）
func (a *App) GetPull(args GetPullArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.GetPull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== MergePull =====

// MergePullArgs 合并合并请求参数
type MergePullArgs struct {
	ProjectID         string `json:"projectId"`
	Index             int    `json:"index"`
	Method            string `json:"method"` // "merge" | "rebase" | "rebase-merge" | "squash"
	DeleteBranchAfter bool   `json:"deleteBranchAfter"`
	CommitMessage     string `json:"commitMessage,omitempty"`
}

// MergePull 合并合并请求（**危险操作**，UI 层必须二次确认）
//
// 合并方式：
//   - "merge"        普通合并（保留所有提交历史）
//   - "rebase"       变基后快进（重写历史，单一线性）
//   - "rebase-merge" 变基后 merge commit（仅 Gitea 支持）
//   - "squash"       压缩为单提交
//
// method="squash" 时 CommitMessage 建议非空（部分平台要求）。
// 合并到主线分支（如 main）时 UI 层额外二次确认。
func (a *App) MergePull(args MergePullArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	if a.logger != nil {
		// 审计日志：合并动作记 method + deleteBranchAfter，方便事后追溯
		a.logger.Info("MergePull",
			"projectId", args.ProjectID, "platform", account.Platform,
			"index", args.Index, "method", args.Method, "deleteBranchAfter", args.DeleteBranchAfter)
	}

	d, err := adapter.MergePull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, platformAdapter.MergePullOpts{
		Method:            args.Method,
		DeleteBranchAfter: args.DeleteBranchAfter,
		CommitMessage:     args.CommitMessage,
	})
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== ClosePull =====

// ClosePullArgs 关闭合并请求参数
type ClosePullArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ClosePull 关闭合并请求（不合并，直接关闭）—— UI 层应二次确认
//
// 对应 gitea PATCH /pulls/{index} {state: 'closed'}；GitHub 等价。
// 关闭后合并请求状态变为 closed，不可再合并（除非 reopen，本期不实现 reopen）。
func (a *App) ClosePull(args ClosePullArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("ClosePull", "projectId", args.ProjectID, "platform", account.Platform, "index", args.Index)
	}

	d, err := adapter.ClosePull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullLabels =====

// UpdatePullLabelsArgs 替换合并请求标签参数
type UpdatePullLabelsArgs struct {
	ProjectID  string   `json:"projectId"`
	Index      int      `json:"index"`
	LabelNames []string `json:"labels"` // 按 label 名替换（Gitea 自动解析为 id；GitHub 直接传 name）
}

// ListMilestonesArgs 列出仓库里程碑（v0.6.0）
type ListMilestonesArgs struct {
	ProjectID string `json:"projectId"`
	State     string `json:"state"` // "open" | "closed" | "all"（空 = open）
}

// UpdatePullMilestoneArgs 给合并请求关联里程碑（v0.6.0）
type UpdatePullMilestoneArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Milestone string `json:"milestone"` // "" 清空
}

// UpdatePullLabels 替换合并请求所有标签（替换语义）
//
// Gitea: PUT /repos/{owner}/{repo}/pulls/{index}/labels
// GitHub: PUT /repos/{owner}/{repo}/issues/{index}/labels
func (a *App) UpdatePullLabels(args UpdatePullLabelsArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullLabels(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.LabelNames)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullAssignee =====

// UpdatePullAssigneeArgs 替换合并请求指派人参数
type UpdatePullAssigneeArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	// Assignees 多人指派（空切片 = 清空）
	Assignees []string `json:"assignees"`
}

// UpdatePullAssignee 替换合并请求指派人（空 = 清空）
//
// 本期简化为单 assignee；多 assignees 后续迭代再加。
func (a *App) UpdatePullAssignee(args UpdatePullAssigneeArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullAssignee(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Assignees)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullReviewers =====

// UpdatePullReviewersArgs 替换合并请求审查者参数
type UpdatePullReviewersArgs struct {
	ProjectID string   `json:"projectId"`
	Index     int      `json:"index"`
	Reviewers []string `json:"reviewers"` // 空切片 = 清空
}

// UpdatePullReviewers 替换合并请求审查者（空 = 清空）
//
// Gitea: POST/DELETE /pulls/{index}/requested_reviewers
// GitHub: POST/DELETE /pulls/{index}/requested_reviewers（同名端点，语义一致）
func (a *App) UpdatePullReviewers(args UpdatePullReviewersArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullReviewers(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Reviewers)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== PR 评论（v0.6+）=====
//
// 范围限定：只做 PR 上下文（issue 评论另起 issue）。
// Gitea 与 GitHub 都走 /repos/{owner}/{repo}/issues/{index}/comments 端点
// （PR 与 issue 共享同一编号空间）。

// PullCommentDTO 是 frontend IssueCommentDto 的 Wails 边界类型别名
//
// v0.6+ 复用了 IssueCommentDto，是因为它的字段（id / body / author / createdAt / updatedAt）
// 与评论场景 1:1 对齐。若后续需要 PR review / inline review comment，可以拆出独立类型。
type PullCommentDTO = platformAdapter.CommentDTO

// ListPullCommentsArgs 列 PR 评论参数
type ListPullCommentsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullComments 列 PR 评论
//
// 错误码：
//   - 401/403 → token_invalid / permission_denied
//   - 404 → not_found（项目/仓库不存在）
func (a *App) ListPullComments(args ListPullCommentsArgs) ([]PullCommentDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}

	items, err := adapter.ListPullComments(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CreatePullCommentArgs 发 PR 评论参数
type CreatePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Body      string `json:"body"`
}

// CreatePullComment 发 PR 评论
//
// body 校验（两端都已走）：
//   - 空 → ipc.NewValidationFailed("评论内容不能为空", "")
//   - 两端实现都会在 trim 为空时 short-circuit返回，
//     不会进平台 API（防御设计）
//
// 返回创建的评论（含服务端 id / createdAt），前端拿这个刷列表以避免
// “前端猜时间戳与实际服务端时间不一致”问题。
func (a *App) CreatePullComment(args CreatePullCommentArgs) (PullCommentDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullCommentDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("CreatePullComment", "projectId", args.ProjectID, "index", args.Index)
	}
	d, err := adapter.CreatePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Body)
	if err != nil {
		return PullCommentDTO{}, err
	}
	if d == nil {
		return PullCommentDTO{}, nil
	}
	return *d, nil
}

// UpdatePullCommentArgs 编辑 PR 评论参数
type UpdatePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Body      string `json:"body"`
}

// UpdatePullComment 编辑 PR 评论
//
// 两端 adapter 实现都会在 trim 为空时 short-circuit 返回 ipc.ValidationFailed。
// 返回更新后的评论（含新 updatedAt + userId），前端以此判断"已编辑"状态。
func (a *App) UpdatePullComment(args UpdatePullCommentArgs) (PullCommentDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullCommentDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("UpdatePullComment", "projectId", args.ProjectID, "commentId", args.CommentID)
	}
	d, err := adapter.UpdatePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Body)
	if err != nil {
		return PullCommentDTO{}, err
	}
	if d == nil {
		return PullCommentDTO{}, nil
	}
	return *d, nil
}

// DeletePullCommentArgs 删除 PR 评论参数
type DeletePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
}

// DeletePullComment 删除 PR 评论
//
// 成功返回 nil error（前端不关心返回值，只关心是否出错）。
// 两端对已删除评论重复删除都返 2xx（幂等）。
func (a *App) DeletePullComment(args DeletePullCommentArgs) error {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return err
	}

	if a.logger != nil {
		a.logger.Info("DeletePullComment", "projectId", args.ProjectID, "commentId", args.CommentID)
	}
	return adapter.DeletePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID)
}

// ===== 评论表情反应（v0.5.0 M2） =====

// ReactionDTO 是 frontend ReactionDto 的 Wails 边界类型别名（ReactionDTO 与 ReactionDTO 字段对齐）
type ReactionDTO = platformAdapter.ReactionDTO

// ListPullCommentReactionsArgs
type ListPullCommentReactionsArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
}

// ListPullCommentReactions 列评论表情反应
func (a *App) ListPullCommentReactions(args ListPullCommentReactionsArgs) ([]ReactionDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullCommentReactions(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// AddPullCommentReactionArgs
type AddPullCommentReactionArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Content   string `json:"content"`
}

// AddPullCommentReaction 添加表情反应
func (a *App) AddPullCommentReaction(args AddPullCommentReactionArgs) (ReactionDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return ReactionDTO{}, err
	}
	if a.logger != nil {
		a.logger.Info("AddPullCommentReaction", "projectId", args.ProjectID, "commentId", args.CommentID, "content", args.Content)
	}
	d, err := adapter.AddPullCommentReaction(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Content)
	if err != nil {
		return ReactionDTO{}, err
	}
	if d == nil {
		return ReactionDTO{}, nil
	}
	return *d, nil
}

// RemovePullCommentReactionArgs
type RemovePullCommentReactionArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Content   string `json:"content"`
}

// RemovePullCommentReaction 移除表情反应
func (a *App) RemovePullCommentReaction(args RemovePullCommentReactionArgs) error {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return err
	}
	if a.logger != nil {
		a.logger.Info("RemovePullCommentReaction", "projectId", args.ProjectID, "commentId", args.CommentID, "content", args.Content)
	}
	return adapter.RemovePullCommentReaction(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Content)
}

// ===== 合并请求评审（v0.5.0 M3） =====

// PullReviewDTO 类型别名（ReactionDTO 在 platform 包已定义）
type PullReviewDTO = platformAdapter.PullReviewDTO

// ListPullReviewsArgs
type ListPullReviewsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullReviews 列评审
func (a *App) ListPullReviews(args ListPullReviewsArgs) ([]PullReviewDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullReviews(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CreatePullReviewArgs
type CreatePullReviewArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	CommitID  string `json:"commitId"`
	Body      string `json:"body"`
	Event     string `json:"event"`
}

// CreatePullReview 创建评审
//
// 前端传 event: "approve" | "request_changes" | "comment"（统一小写）
// GitHub adapter 内部映射为 APPROVE / REQUEST_CHANGES / COMMENT
func (a *App) CreatePullReview(args CreatePullReviewArgs) (PullReviewDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullReviewDTO{}, err
	}
	if a.logger != nil {
		a.logger.Info("CreatePullReview", "projectId", args.ProjectID, "index", args.Index, "event", args.Event)
	}
	opts := platformAdapter.CreateReviewOpts{
		CommitID: args.CommitID,
		Body:     args.Body,
		Event:    args.Event,
	}
	d, err := adapter.CreatePullReview(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, opts)
	if err != nil {
		return PullReviewDTO{}, err
	}
	if d == nil {
		return PullReviewDTO{}, nil
	}
	return *d, nil
}

// ===== 行内评审评论 (Review Comments) =====

// ListPullReviewCommentsArgs 列行内评审评论参数
type ListPullReviewCommentsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullReviewComments 列 PR 行内评审评论（v0.5.0 M4）
func (a *App) ListPullReviewComments(args ListPullReviewCommentsArgs) ([]platformAdapter.PullReviewCommentDto, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullReviewComments(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CreatePullReviewCommentArgs 发行内评审评论参数
type CreatePullReviewCommentArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Body      string `json:"body"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
}

// CreatePullReviewComment 发行内评审评论（v0.5.0 M4）
func (a *App) CreatePullReviewComment(args CreatePullReviewCommentArgs) (platformAdapter.PullReviewCommentDto, error) {
	if strings.TrimSpace(args.Body) == "" {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	if strings.TrimSpace(args.Path) == "" {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("路径不能为空", "")
	}
	if args.Line <= 0 {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("行号必须大于0", "")
	}
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return platformAdapter.PullReviewCommentDto{}, err
	}
	if a.logger != nil {
		a.logger.Info("CreatePullReviewComment", "projectId", args.ProjectID, "index", args.Index, "path", args.Path, "line", args.Line)
	}
	d, err := adapter.CreatePullReviewComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Body, args.Path, args.Line)
	if err != nil {
		return platformAdapter.PullReviewCommentDto{}, err
	}
	if d == nil {
		return platformAdapter.PullReviewCommentDto{}, nil
	}
	return *d, nil
}

// ===== 文件修改列表 (PR Files) =====

// ListPullFilesArgs 列 PR 修改文件
type ListPullFilesArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullFiles 列 PR 修改文件（v0.5.0 M4）
func (a *App) ListPullFiles(args ListPullFilesArgs) ([]platformAdapter.PullFileDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullFiles(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			// 低版本 Gitea / GitHub 不支援此端点，前端隐藏此区
			return []platformAdapter.PullFileDTO{}, nil
		}
		return nil, err
	}
	return items, nil
}

// ===== PR 提交列表 (PR Commits) =====

// ListPullCommitsArgs 列 PR 提交
type ListPullCommitsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullCommits 列 PR 中包含的提交（head 分支有但 base 分支没有的 commit）
func (a *App) ListPullCommits(args ListPullCommitsArgs) ([]platformAdapter.PullCommitDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullCommits(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return []platformAdapter.PullCommitDTO{}, nil
		}
		return nil, err
	}
	return items, nil
}

// GetPullFileDiffArgs 单文件 Diff 参数
type GetPullFileDiffArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	FilePath  string `json:"filePath"`
}

// ListMilestones 列出仓库里程碑（v0.6.0）
func (a *App) ListMilestones(args ListMilestonesArgs) ([]platformAdapter.MilestoneDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return nil, err
	}
	d, err := adapter.ListMilestones(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.State)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return []platformAdapter.MilestoneDTO{}, nil
		}
		return nil, err
	}
	return d, nil
}

func (a *App) UpdatePullMilestone(args UpdatePullMilestoneArgs) (PullDetailAppDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	d, err := adapter.UpdatePullMilestone(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Milestone)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return PullDetailAppDTO{}, nil
		}
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

func (a *App) GetPullFileDiff(args GetPullFileDiffArgs) (platformAdapter.PullFileDiffDTO, error) {
	project, account, token, adapter, err := a.resolvePullContext(args.ProjectID)
	if err != nil {
		return platformAdapter.PullFileDiffDTO{}, err
	}
	d, err := adapter.GetPullFileDiff(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.FilePath)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return platformAdapter.PullFileDiffDTO{}, nil
		}
		return platformAdapter.PullFileDiffDTO{}, err
	}
	return *d, nil
}
