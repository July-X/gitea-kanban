package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/google/uuid"

	"gitea-kanban/app/config"
	"gitea-kanban/app/git"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/platform/github"
	"gitea-kanban/app/platform/gitea"
	"gitea-kanban/app/store"
)

// App 是暴露给前端的主后端对象（Wails binding）
//
// 所有前端可调用的方法都定义在 App 上，Wails 会自动生成 TS bindings 到 frontend/wailsjs/。
// 具体业务逻辑委托给 app/ 下的各子包（store / platform / git 等）。
type App struct {
	ctx           context.Context
	logger        *slog.Logger
	dataDir       string
	localStore    *store.LocalStore
	giteaAdapter  platformAdapter.PlatformAdapter
	githubAdapter platformAdapter.PlatformAdapter
}

// NewApp 创建后端应用实例
func NewApp() *App {
	return &App{}
}

// OnStartup 在 Wails 前端启动前调用
func (a *App) OnStartup(ctx context.Context) {
	a.ctx = ctx

	// 1. 解析数据根目录
	a.dataDir = config.ResolveDataDir()

	// 2. 初始化日志（写文件）
	a.logger = config.NewLogger(a.dataDir)
	a.logger.Info("gitea-kanban starting", "dataDir", a.dataDir, "version", "2.0.0")

	// 3. 初始化 localStore（state.json）
	ls, err := store.NewLocalStore(filepath.Join(a.dataDir, "state.json"))
	if err != nil {
		a.logger.Error("localStore init failed", "err", err)
		// 不 panic —— localStore 内部会 fallback 到默认值
	} else {
		a.localStore = ls
		a.logger.Info("localStore initialized")
	}

	// 4. 确保 workspace 目录存在
	wsPath := store.GetWorkspacePath(a.localStore)
	if wsPath != "" {
		if err := os.MkdirAll(wsPath, 0o755); err != nil {
			a.logger.Warn("workspace mkdir failed", "path", wsPath, "err", err)
		}
	}

	// 5. 初始化平台适配器
	a.giteaAdapter = gitea.NewGiteaAdapter()
	a.githubAdapter = github.NewGitHubAdapter()
	a.logger.Info("platform adapters initialized")
}

// OnShutdown 在应用退出前调用
func (a *App) OnShutdown(ctx context.Context) {
	if a.logger != nil {
		a.logger.Info("gitea-kanban shutting down")
	}
}

// ===== 暴露给前端的基础方法（桩化，后续步骤逐步实现）=====

// AppInfo 返回应用基本信息（前端启动时调用）
type AppInfo struct {
	Version  string `json:"version"`
	DataDir  string `json:"dataDir"`
	Platform string `json:"platform"` // darwin / windows / linux
}

// GetAppInfo 返回应用信息
func (a *App) GetAppInfo() AppInfo {
	return AppInfo{
		Version:  "2.0.0",
		DataDir:  a.dataDir,
		Platform: runtime.GOOS,
	}
}

// ===== Git Graph 相关方法（步骤 3.1）=====

// GraphResultDTO 图结果（暴露给前端，与 platform.GraphResult 对齐）
type GraphResultDTO struct {
	Nodes     []GraphNodeDTO `json:"nodes"`
	Edges     []GraphEdgeDTO `json:"edges"`
	MaxLane   int            `json:"maxLane"`
	Truncated bool           `json:"truncated"`
}

// GraphNodeDTO 图节点
type GraphNodeDTO struct {
	Row         int      `json:"row"`
	Lane        int      `json:"lane"`
	SHA         string   `json:"sha"`
	ShortSHA    string   `json:"shortSha"`
	Subject     string   `json:"subject"`
	AuthorName  string   `json:"authorName"`
	AuthorEmail string   `json:"authorEmail"`
	Date        string   `json:"date"`
	IsMerge     bool     `json:"isMerge"`
	Parents     []string `json:"parents"`
}

// GraphEdgeDTO 图边
type GraphEdgeDTO struct {
	FromRow  int `json:"fromRow"`
	ToRow    int `json:"toRow"`
	FromLane int `json:"fromLane"`
	ToLane   int `json:"toLane"`
	Type     int `json:"type"`
}

// CloneRepoArgs clone 仓库参数
type CloneRepoArgs struct {
	Platform      string `json:"platform"`      // "gitea" | "github"
	HostURL       string `json:"hostUrl"`
	Username      string `json:"username"`
	Token         string `json:"token"`
	Owner         string `json:"owner"`
	Repo          string `json:"repo"`
	WorkspacePath string `json:"workspacePath"`
}

// CloneRepoResult clone 结果
type CloneRepoResult struct {
	LocalPath string `json:"localPath"`
}

// CloneRepo clone 仓库到本地 workspace
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("CloneRepo", "platform", args.Platform, "owner", args.Owner, "repo", args.Repo)
	}

	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return CloneRepoResult{}, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	localPath, err := adapter.CloneRepo(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo, args.WorkspacePath)
	if err != nil {
		return CloneRepoResult{}, err
	}

	return CloneRepoResult{LocalPath: localPath}, nil
}

// LogGraphArgs log graph 参数
type LogGraphArgs struct {
	Platform  string   `json:"platform"`
	LocalPath string   `json:"localPath"`
	Branches  []string `json:"branches"`
	MaxCount  int      `json:"maxCount"`
}

// LogGraph 获取 commit 历史并构建 Graph 布局
func (a *App) LogGraph(args LogGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("LogGraph", "platform", args.Platform, "path", args.LocalPath)
	}

	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return GraphResultDTO{}, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	result, err := adapter.LogGraph(a.ctx, args.LocalPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	return graphResultToAppDTO(result), nil
}

// GetWorkspace 返回当前 workspace 路径
func (a *App) GetWorkspace() map[string]string {
	wsPath := store.GetWorkspacePath(a.localStore)
	if wsPath == "" {
		wm := git.NewWorkspaceManager()
		wsPath = wm.DefaultPath()
	}
	return map[string]string{
		"path":        wsPath,
		"defaultPath": git.NewWorkspaceManager().DefaultPath(),
	}
}

// ListWorkspaceRepos 列出 workspace 中已 clone 的仓库
func (a *App) ListWorkspaceRepos() ([]map[string]string, error) {
	wsPath := store.GetWorkspacePath(a.localStore)
	if wsPath == "" {
		return []map[string]string{}, nil
	}

	wm := git.NewWorkspaceManager()
	repos, err := wm.ListRepos(wsPath)
	if err != nil {
		return nil, err
	}

	result := make([]map[string]string, 0, len(repos))
	for _, r := range repos {
		result = append(result, map[string]string{
			"name":  r.Name,
			"path":  r.Path,
			"owner": r.Owner,
			"repo":  r.Repo,
		})
	}
	return result, nil
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
type CommitDetailDTO struct {
	SHA         string `json:"sha"`
	ShortSHA    string `json:"shortSha"`
	Subject     string `json:"subject"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	AuthorWhen  string `json:"authorWhen"`
	Message     string `json:"message"`
	Parents     []string `json:"parents"`
}

// GetCommitDetailArgs 获取 commit 详情参数
type GetCommitDetailArgs struct {
	LocalPath string `json:"localPath"`
	SHA       string `json:"sha"`
}

// GetCommitDetail 获取单个 commit 的详情（go-git）
func (a *App) GetCommitDetail(args GetCommitDetailArgs) (CommitDetailDTO, error) {
	repo, err := git.OpenRepo(args.LocalPath)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	commit, err := repo.GetCommit(args.SHA)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	return CommitDetailDTO{
		SHA:         commit.SHA,
		ShortSHA:    commit.ShortSHA,
		Subject:     commit.Subject,
		AuthorName:  commit.AuthorName,
		AuthorEmail: commit.AuthorEmail,
		AuthorWhen:  commit.AuthorWhen,
		Message:     commit.Message,
		Parents:     commit.Parents,
	}, nil
}

// ===== 拉取/同步（步骤 3.4）=====

// PullRepoArgs 拉取参数
type PullRepoArgs struct {
	LocalPath string `json:"localPath"`
	Token     string `json:"token"`
	Username  string `json:"username"`
}

// PullRepoResult 拉取结果
type PullRepoResult struct {
	BeforeCount  int  `json:"beforeCount"`
	AfterCount   int  `json:"afterCount"`
	AddedCommits int  `json:"addedCommits"`
	Updated      bool `json:"updated"`
}

// PullRepo 拉取远端更新（fetch + 统计 commit 变化）
func (a *App) PullRepo(args PullRepoArgs) (PullRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("PullRepo", "path", args.LocalPath)
	}

	result, err := git.PullRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     args.Token,
		Username:  args.Username,
	})
	if err != nil {
		return PullRepoResult{}, err
	}

	return PullRepoResult{
		BeforeCount:  result.BeforeCount,
		AfterCount:   result.AfterCount,
		AddedCommits: result.AddedCommits,
		Updated:      true,
	}, nil
}

// FetchRepoResultDTO fetch 结果
type FetchRepoResultDTO struct {
	Updated bool `json:"updated"`
}

// FetchRepo 仅 fetch（不 merge）
func (a *App) FetchRepo(args PullRepoArgs) (FetchRepoResultDTO, error) {
	result, err := git.FetchRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     args.Token,
		Username:  args.Username,
	})
	if err != nil {
		return FetchRepoResultDTO{}, err
	}
	return FetchRepoResultDTO{Updated: result.Updated}, nil
}

// ===== 看板（issue + label 映射，仅 Gitea）（步骤 3.5）=====

// IssueDTO 议题（暴露给前端）
type IssueDTO struct {
	Index  int    `json:"index"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Body   string `json:"body,omitempty"`
	Author string `json:"author"`
}

// ListIssuesArgs 列议题参数
type ListIssuesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
	State    string `json:"state"` // open | closed | all
}

// ListIssues 列出仓库议题（仅 Gitea 完整支持）
func (a *App) ListIssues(args ListIssuesArgs) ([]IssueDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	issues, err := adapter.ListIssues(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo, platformAdapter.ListIssuesOpts{
		State: args.State,
	})
	if err != nil {
		return nil, err
	}

	result := make([]IssueDTO, 0, len(issues))
	for _, i := range issues {
		result = append(result, IssueDTO{
			Index:  i.Index,
			Title:  i.Title,
			State:  i.State,
			Body:   i.Body,
			Author: i.Author,
		})
	}
	return result, nil
}

// ColumnDTO 看板列（暴露给前端，与 store.BoardColumn 对齐）
type ColumnDTO struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
	Position  int    `json:"position"`
	WipLimit  *int   `json:"wipLimit,omitempty"`
}

// ListColumnsArgs 列看板列参数
type ListColumnsArgs struct {
	ProjectID string `json:"projectId"`
}

// ListColumns 列出项目的看板列（本地 localStore）
func (a *App) ListColumns(args ListColumnsArgs) ([]ColumnDTO, error) {
	state := a.localStore.Get()
	result := make([]ColumnDTO, 0)
	for _, c := range state.Columns {
		if c.ProjectID == args.ProjectID {
			result = append(result, ColumnDTO{
				ID:        c.ID,
				ProjectID: c.ProjectID,
				Title:     c.Title,
				Position:  c.Position,
				WipLimit:  c.WipLimit,
			})
		}
	}
	return result, nil
}

// CreateColumnArgs 新建列参数
type CreateColumnArgs struct {
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
	Position  int    `json:"position"`
}

// CreateColumn 新建看板列（本地 localStore）
func (a *App) CreateColumn(args CreateColumnArgs) (ColumnDTO, error) {
	col := store.BoardColumn{
		ID:        uuid.NewString(),
		ProjectID: args.ProjectID,
		Title:     args.Title,
		Position:  args.Position,
		CreatedAt: time.Now().UnixMilli(),
	}

	err := a.localStore.Mutate(func(s *store.LocalState) {
		s.Columns = append(s.Columns, col)
	})
	if err != nil {
		return ColumnDTO{}, err
	}

	return ColumnDTO{
		ID:        col.ID,
		ProjectID: col.ProjectID,
		Title:     col.Title,
		Position:  col.Position,
	}, nil
}

// DeleteColumnArgs 删除列参数
type DeleteColumnArgs struct {
	ColumnID string `json:"columnId"`
}

// DeleteColumn 删除看板列（本地 localStore，同时删关联的 labelMaps）
func (a *App) DeleteColumn(args DeleteColumnArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		// 删列
		s.Columns = filterColumns(s.Columns, args.ColumnID)
		// 删关联的 labelMaps
		s.LabelMaps = filterLabelMapsByColumn(s.LabelMaps, args.ColumnID)
	})
}

// filterColumns 过滤掉指定 ID 的列
func filterColumns(cols []store.BoardColumn, id string) []store.BoardColumn {
	result := make([]store.BoardColumn, 0, len(cols))
	for _, c := range cols {
		if c.ID != id {
			result = append(result, c)
		}
	}
	return result
}

// filterLabelMapsByColumn 过滤掉指定 columnId 的 labelMaps
func filterLabelMapsByColumn(maps []store.ColumnLabelMap, columnID string) []store.ColumnLabelMap {
	result := make([]store.ColumnLabelMap, 0, len(maps))
	for _, m := range maps {
		if m.ColumnID != columnID {
			result = append(result, m)
		}
	}
	return result
}

// getAdapter 根据平台返回对应的 PlatformAdapter
func (a *App) getAdapter(platformStr string) platformAdapter.PlatformAdapter {
	switch platformStr {
	case "gitea":
		return a.giteaAdapter
	case "github":
		return a.githubAdapter
	}
	return nil
}

// graphResultToAppDTO 把 platform.GraphResult 转为 App 的 GraphResultDTO
func graphResultToAppDTO(r *platformAdapter.GraphResult) GraphResultDTO {
	if r == nil {
		return GraphResultDTO{}
	}

	nodes := make([]GraphNodeDTO, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		nodes = append(nodes, GraphNodeDTO{
			Row:         n.Row,
			Lane:        n.Lane,
			SHA:         n.SHA,
			ShortSHA:    n.ShortSHA,
			Subject:     n.Subject,
			AuthorName:  n.AuthorName,
			AuthorEmail: n.AuthorEmail,
			Date:        n.Date,
			IsMerge:     n.IsMerge,
			Parents:     n.Parents,
		})
	}

	edges := make([]GraphEdgeDTO, 0, len(r.Edges))
	for _, e := range r.Edges {
		edges = append(edges, GraphEdgeDTO{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Type:     e.Type,
		})
	}

	return GraphResultDTO{
		Nodes:   nodes,
		Edges:   edges,
		MaxLane: r.MaxLane,
	}
}
