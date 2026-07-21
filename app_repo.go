package main

import (
	"errors"
	"fmt"
	"gitea-kanban/app/git"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/logx"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/store"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/google/uuid"
	"time"
)

// ===== v2.3 仓库管理（StatusBar 刷新按钮 + selectProject）=====

// ListReposArgs 列仓库参数
//
// v2.3 修复：前端 StatusBar 刷新按钮原来"没反应"的根本原因
//   - 旧版 shim repos.list 是 stub，永远返 {items: [], hasMore: false}
//   - 用户点刷新 → 拉 0 个仓库 → 没法选
//   - 修复：Go 端 ListRepos 调 platform.ListRepos，merge isProject/lastSyncAt
type ListReposArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Query          string `json:"query,omitempty"`
	Limit          int    `json:"limit"`
	Page           int    `json:"page"`
}

// ListReposResp 列仓库响应
type ListReposResp struct {
	Items   []platformAdapter.RepoDTO `json:"items"`
	Total   int                       `json:"total"`
	Page    int                       `json:"page"`
	HasMore bool                      `json:"hasMore"`
}

// ListRepos 列出某账号可访问的仓库
//
// 步骤：
//  1. localStore.Accounts 找 giteaAccountID 对应的 account
//  2. secretStore.Get 拿 token
//  3. adapter.ListRepos 拉远端列表
//  4. merge localStore.Projects 标记 isProject / lastSyncAt
func (a *App) ListRepos(args ListReposArgs) (ListReposResp, error) {
	// v0.6.0 生成 reqID，让 ListRepos 内部所有日志能贯穿
	ctx := a.newBindingCtx("ListRepos")
	defer logx.Recover(a.logger, "ListRepos")

	if a.logger != nil {
		a.logger.InfoContext(ctx, "ListRepos",
			"giteaAccountId", args.GiteaAccountID,
			"query", args.Query,
			"page", args.Page,
		)
	}

	// 1. 找 account
	matched, err := a.findAccountByID(args.GiteaAccountID)
	if err != nil {
		return ListReposResp{}, err
	}

	// 2. 拿 token
	token, err := a.resolveToken(matched)
	if err != nil {
		return ListReposResp{}, err
	}

	// 3. 远端拉
	adapter := a.getAdapter(matched.Platform)
	if adapter == nil {
		return ListReposResp{}, ipc.NewUnsupportedPlatform(matched.Platform)
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 50
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	remoteRepos, err := adapter.ListRepos(a.ctx, matched.GiteaURL, matched.Username, token, platformAdapter.ListReposOpts{
		Query: args.Query,
		Limit: limit,
		Page:  page,
	})
	if err != nil {
		return ListReposResp{}, err
	}

	// 4. merge isProject / lastSyncAt（按 owner+name 匹配）
	state := a.localStore.Get()
	projects := state.Projects
	for i := range remoteRepos {
		for j := range projects {
			if projects[j].Platform == matched.Platform &&
				projects[j].AccountID == matched.ID &&
				projects[j].Owner == remoteRepos[i].Owner &&
				projects[j].Name == remoteRepos[i].Name {
				remoteRepos[i].IsProject = true
				remoteRepos[i].ProjectID = projects[j].ID
				if projects[j].LastSyncAt > 0 {
					remoteRepos[i].LastSyncAt = time.UnixMilli(projects[j].LastSyncAt).UTC().Format(time.RFC3339)
				}
				break
			}
		}
	}

	return ListReposResp{
		Items:   remoteRepos,
		Total:   len(remoteRepos),
		Page:    page,
		HasMore: len(remoteRepos) >= limit, // gitea /repos/search 返 data 数组不含 total，简单按 limit 估
	}, nil
}

// AddProjectArgs 加 project 参数
type AddProjectArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Owner          string `json:"owner"`
	Name           string `json:"name"`
}

// AddProjectResult 加 project 结果
type AddProjectResult struct {
	Project store.RepoProject `json:"project"`
}

// AddProject 标记仓库为本机 project
//
// 跟 CloneRepo 的自动加 project 是独立的：
//   - CloneRepo 加 project 是 "已 clone" 语义（lastSyncAt = now）
//   - AddProject 加 project 是 "已加入看板" 语义（lastSyncAt = 0，未 clone）
//
// 后续 PullRepo 找 token 依赖 Projects → 这条不能漏
func (a *App) AddProject(args AddProjectArgs) (AddProjectResult, error) {
	if a.logger != nil {
		a.logger.Info("AddProject", "giteaAccountId", args.GiteaAccountID, "owner", args.Owner, "name", args.Name)
	}

	if args.Owner == "" || args.Name == "" {
		return AddProjectResult{}, ipc.NewValidationFailed("owner/name 不能为空",
			fmt.Sprintf("owner=%q name=%q", args.Owner, args.Name))
	}

	// 1. 找 account
	matched, err := a.findAccountByID(args.GiteaAccountID)
	if err != nil {
		return AddProjectResult{}, err
	}

	// 2. 幂等：已存在则返回原 project
	state := a.localStore.Get()
	for i := range state.Projects {
		if state.Projects[i].Platform == matched.Platform &&
			state.Projects[i].AccountID == matched.ID &&
			state.Projects[i].Owner == args.Owner &&
			state.Projects[i].Name == args.Name {
			return AddProjectResult{Project: state.Projects[i]}, nil
		}
	}

	// 3. 新建
	now := time.Now().UnixMilli()
	project := store.RepoProject{
		ID:        uuid.NewString(),
		Platform:  matched.Platform,
		AccountID: matched.ID,
		Owner:     args.Owner,
		Name:      args.Name,
		CreatedAt: now,
	}
	if err := a.localStore.Mutate(func(s *store.LocalState) {
		s.Projects = append(s.Projects, project)
	}); err != nil {
		return AddProjectResult{}, ipc.NewInternal("保存 project 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("AddProject: created", "projectId", project.ID, "owner", args.Owner, "name", args.Name)
	}
	return AddProjectResult{Project: project}, nil
}

// RemoveProjectArgs 删 project 参数
type RemoveProjectArgs struct {
	ProjectID string `json:"projectId"`
}

// RemoveProject 取消仓库的本机 project 标记（**不**删远端仓库 / **不**删本地 clone）
func (a *App) RemoveProject(args RemoveProjectArgs) error {
	if a.logger != nil {
		a.logger.Info("RemoveProject", "projectId", args.ProjectID)
	}
	if args.ProjectID == "" {
		return ipc.NewValidationFailed("projectId 不能为空", "")
	}
	return a.localStore.Mutate(func(s *store.LocalState) {
		kept := make([]store.RepoProject, 0, len(s.Projects))
		for _, p := range s.Projects {
			if p.ID == args.ProjectID {
				continue
			}
			kept = append(kept, p)
		}
		s.Projects = kept
	})
}

// ===== 分支列表/收藏（步骤 3.2）=====

// BranchDTO 分支信息（暴露给前端）
type BranchDTO struct {
	Name        string `json:"name"`
	CommitSHA   string `json:"commitSha"`
	IsProtected bool   `json:"isProtected"`
}

// ListBranchesArgs 列分支参数
type ListBranchesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// ListBranches 列出仓库分支
func (a *App) ListBranches(args ListBranchesArgs) ([]BranchDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	branches, err := adapter.ListBranches(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo)
	if err != nil {
		return nil, err
	}

	result := make([]BranchDTO, 0, len(branches))
	for _, b := range branches {
		result = append(result, BranchDTO{
			Name:        b.Name,
			CommitSHA:   b.CommitSHA,
			IsProtected: b.IsProtected,
		})
	}
	return result, nil
}

// StarBranchArgs 收藏分支参数
type StarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// StarBranch 收藏分支（本地 localStore.starredBranches）
func (a *App) StarBranch(args StarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		// 避免重复收藏
		for _, sb := range s.StarredBranches {
			if sb.ProjectID == args.ProjectID && sb.Branch == args.Branch {
				return
			}
		}
		s.StarredBranches = append(s.StarredBranches, store.StarredBranch{
			ID:        uuid.NewString(),
			ProjectID: args.ProjectID,
			Branch:    args.Branch,
			CreatedAt: time.Now().UnixMilli(),
		})
	})
}

// UnstarBranchArgs 取消收藏分支参数
type UnstarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// UnstarBranch 取消收藏分支
func (a *App) UnstarBranch(args UnstarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		s.StarredBranches = filterStarredBranches(s.StarredBranches, args.ProjectID, args.Branch)
	})
}

// ListStarredBranchesArgs 列出收藏的分支
type ListStarredBranchesArgs struct {
	ProjectID string `json:"projectId"`
}

// ListStarredBranches 列出某项目收藏的分支
func (a *App) ListStarredBranches(args ListStarredBranchesArgs) ([]string, error) {
	state := a.localStore.Get()
	branches := make([]string, 0)
	for _, sb := range state.StarredBranches {
		if sb.ProjectID == args.ProjectID {
			branches = append(branches, sb.Branch)
		}
	}
	return branches, nil
}

// filterStarredBranches 过滤掉指定 project+branch 的收藏
func filterStarredBranches(branches []store.StarredBranch, projectID, branch string) []store.StarredBranch {
	result := make([]store.StarredBranch, 0, len(branches))
	for _, sb := range branches {
		if sb.ProjectID == projectID && sb.Branch == branch {
			continue
		}
		result = append(result, sb)
	}
	return result
}

// ===== commit 详情 + diff（步骤 3.3）=====

// CommitDetailDTO commit 详情（暴露给前端）
//
// v2.15 扩展：新增 Files / Additions / Deletions / FilesChanged 字段
// （从 GetCommitDiff + commit.Stats() 合并而来）。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 DTO 只有 8 个元信息字段，
// 完全没有文件变更数据，前端 CommitDetailPanel 永远拿不到 files。
type CommitDetailDTO struct {
	SHA          string               `json:"sha"`
	ShortSHA     string               `json:"shortSha"`
	Subject      string               `json:"subject"`
	AuthorName   string               `json:"authorName"`
	AuthorEmail  string               `json:"authorEmail"`
	AuthorWhen   string               `json:"authorWhen"`
	Message      string               `json:"message"`
	Parents      []string             `json:"parents"`
	Files        []FileChangeDTO      `json:"files,omitempty"`        // 变更文件列表（含 +/- 行数）
	Additions    int                  `json:"additions,omitempty"`    // 总新增行数
	Deletions    int                  `json:"deletions,omitempty"`    // 总删除行数
	FilesChanged int                  `json:"filesChanged,omitempty"` // 变更文件数
	Gpg          *git.CommitGpgStatus `json:"gpg,omitempty"`
}

// FileChangeDTO 文件变更（前端 CommitDetailPanel 用）
//
// 字段命名跟前端 interface 对齐：
//   - Filename    （对应后端 Path）
//   - PreviousFilename （对应后端 OldPath）
//   - Status      （对应后端 Action：added/modified/deleted/renamed）
type FileChangeDTO struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previousFilename,omitempty"`
	Status           string `json:"status"` // added / modified / deleted / renamed
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Binary           bool   `json:"binary,omitempty"` // v2.15 暂不支持（go-git 无标记）
}

// GetCommitDetailArgs 获取 commit 详情参数
type GetCommitDetailArgs struct {
	ProjectID string `json:"projectId"`
	SHA       string `json:"sha"`
}

// GetCommitDetail 获取单个 commit 的详情（go-git）
//
// v2.15 扩展：除了元信息（message / author），还调 GetCommitDiff 拿文件变更列表，
// 计算 totals（Additions / Deletions / FilesChanged）填到 DTO。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 handler 只填元信息字段。
//
// v2.4 对齐：接受 projectId（业务态概念），Go 端反查 localPath。
func (a *App) GetCommitDetail(args GetCommitDetailArgs) (CommitDetailDTO, error) {
	if args.ProjectID == "" {
		return CommitDetailDTO{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// v2.4：按 projectId 反查 localPath（对齐 GetGitGraph / PullRepoByProjectId 链路）
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return CommitDetailDTO{}, err
	}
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	repo, err := git.OpenRepo(localPath)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	commit, err := repo.GetCommit(args.SHA)
	if err != nil {
		// v0.8.x 降级：commit 对象在本地裸仓库找不到时（例如 shallow clone、
		// force-push 抹掉的历史 commit），返回空 DTO 而非 error。
		// 前端走 fallback：显示 subject（来自 graph 数据）+ 提示"详情暂不可用"。
		if errors.Is(err, plumbing.ErrObjectNotFound) {
			a.logger.Warn("GetCommitDetail: commit not found locally, returning empty DTO",
				"sha", args.SHA, "projectID", args.ProjectID)
			return CommitDetailDTO{
				SHA:          args.SHA,
				Subject:      "（该提交详情暂不可用）",
				Parents:      []string{},
				Additions:    0,
				Deletions:    0,
				FilesChanged: 0,
			}, nil
		}
		return CommitDetailDTO{}, err
	}

	dto := CommitDetailDTO{
		SHA:         commit.SHA,
		ShortSHA:    commit.ShortSHA,
		Subject:     commit.Subject,
		AuthorName:  commit.AuthorName,
		AuthorEmail: commit.AuthorEmail,
		AuthorWhen:  commit.AuthorWhen,
		Message:     commit.Message,
		Parents:     commit.Parents,
		Gpg:         commit.Gpg,
	}

	// v2.15：调 GetCommitDiff 拿文件变更 + 累计 +/- 行数
	files, diffErr := repo.GetCommitDiff(args.SHA)
	if diffErr != nil {
		// diff 失败不阻塞主流程（meta 数据仍返回），只 log 警告
		a.logger.Warn("GetCommitDetail: GetCommitDiff failed", "sha", args.SHA, "err", diffErr)
	} else {
		dto.Files = make([]FileChangeDTO, 0, len(files))
		for _, f := range files {
			dto.Files = append(dto.Files, FileChangeDTO{
				Filename:         f.Path,
				PreviousFilename: f.OldPath,
				Status:           f.Action,
				Additions:        f.Additions,
				Deletions:        f.Deletions,
			})
			dto.Additions += f.Additions
			dto.Deletions += f.Deletions
		}
		dto.FilesChanged = len(files)
	}

	return dto, nil
}
