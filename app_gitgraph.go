package main

import (
	"fmt"
	"gitea-kanban/app/git"
	"gitea-kanban/app/ipc"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/store"
	"github.com/google/uuid"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"strings"
	"time"
)

// ===== Git Graph 相关方法（步骤 3.1）=====

// GraphResultDTO 图结果（暴露给前端，与 platform.GraphResult 对齐）
type GraphResultDTO struct {
	Nodes     []GraphNodeDTO   `json:"nodes"`
	Edges     []GraphEdgeDTO   `json:"edges"`
	Branches  []GraphBranchDTO `json:"branches,omitempty"`
	MaxLane   int              `json:"maxLane"`
	Truncated bool             `json:"truncated"`
	// LocalExhausted 本地 commit 已全部取出，远端可能有更多（需 deepen）。
	// 前端据此显示「本地历史已加载完」提示 + 是否加载更早历史的按钮。
	LocalExhausted bool `json:"localExhausted"`
	// DeepenTriggered 后端已启动后台增量 deepen 拉取远端 commit。
	// 前端收到此信号时不该再次触发 deepen，等待 repo:sync:progress 事件即可。
	DeepenTriggered bool `json:"deepenTriggered"`
}

// GraphBranchDTO 一条完整 branch path（对齐 platform.GraphBranchDTO）
type GraphBranchDTO struct {
	Color int                  `json:"color"`
	End   int                  `json:"end"`
	Lines []GraphBranchLineDTO `json:"lines"`
}

// GraphBranchLineDTO branch 上的一段线（对齐 platform.GraphBranchLineDTO）
type GraphBranchLineDTO struct {
	X1          int  `json:"x1"`
	Y1          int  `json:"y1"`
	X2          int  `json:"x2"`
	Y2          int  `json:"y2"`
	LockedFirst bool `json:"lockedFirst"`
	// IsCommitted 该 line 是否属于「已提交」段。
	// 对齐 vscode graph.ts:102 `line.isCommitted` 与 Branch.drawPath:152 stroke 切换；
	// false 时前端走 #808080 + stroke-dasharray: 2px 灰色虚线。
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
	Refs        []string `json:"refs,omitempty"`
	RefTypes    []string `json:"refTypes,omitempty"`
	IsCurrent   bool     `json:"isCurrent,omitempty"`
	IsStash     bool     `json:"isStash,omitempty"`
	// IsCommitted 该节点是否已提交 (true) 还是 UNCOMMITTED 虚拟节点 (false)。
	// 对齐 vscode graph.ts Vertex.draw：uncommitted 时 dot stroke = #808080。
	// App 端 LogCommits / LogCommitsVscode 在 local 落后 origin 时 unshift 一颗
	// UNCOMMITTED 虚拟 commit (SHA = "*")，对应节点的 IsCommitted = false。
	// 不带 omitempty —— false（UNCOMMITTED 节点）也是有效信号，omitempty 会吞掉
	IsCommitted bool `json:"isCommitted"`
}

// GraphEdgeDTO 图边
type GraphEdgeDTO struct {
	FromRow  int `json:"fromRow"`
	ToRow    int `json:"toRow"`
	FromLane int `json:"fromLane"`
	ToLane   int `json:"toLane"`
	Color    int `json:"color"`
	Type     int `json:"type"`
}

// CloneRepoArgs clone 仓库参数
//
// v2.3 user 拍板：token 不再走 IPC
//   - 旧版前端传 token 给 Go 端 → 违反 AGENTS §8.2 鉴权铁律
//   - 现在 Go 端根据 platform+hostURL+username 自己去 keychain 拿
//   - 前端只传 (platform, hostURL, username, owner, repo)
type CloneRepoArgs struct {
	// ProjectID 优先（v2.x 推荐）：Go 端按 projectId 反查 project + account，
	// 自动拿 platform/hostUrl/username/owner/repo，前端无需再传。
	// 与 PullRepoByProjectId 范式对齐，符合 AGENTS §8.2 鉴权铁律（前端不传鉴权字段）。
	ProjectID string `json:"projectId,omitempty"`
	// 以下字段为旧协议（projectId 为空时回退用），新代码请只传 projectId
	Platform string `json:"platform"` // "gitea" | "github"
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// CloneRepoResult clone 结果
type CloneRepoResult struct {
	LocalPath string `json:"localPath"`
	Reused    bool   `json:"reused"` // 仓库已存在 = 复用没重新 clone
}

// ===== v2.6 进度事件（git clone / pull）=====
//
// 实现：go-git sideband → ProgressCallback → runtime.EventsEmit("git:sync:progress", payload)
// 前端订阅：repo store init 时挂一个 onMounted 监听，写到 progressByRepo[repoKey]
// StatusBar 消费：行末按钮下方渲染 <progress> + tooltip 显示百分比
//
// 设计取舍：
//   - Wails EventsEmit 是 push 模型（后端 → 前端单向），不需要前端订阅单独的 stream
//     不需要为进度开新 IPC endpoint，零额外 schema
//   - Event name 用单一 `git:sync:progress` 避免事件命名爆炸；payload 内区分 stage / repoKey
//   - repoKey 用 `<platform>/<hostURL>/<owner>/<repo>` 前缀（v2.5+ 账号隔离之后，
//     同 owner/repo 在不同账号下是不同的物理路径，前端 key 必须包含 hostURL/platform）
const GitSyncProgressEvent = "git:sync:progress"

// GitSyncProgressPayload 进度事件 payload（前端订阅用）
//
// 与 app/git.SyncProgress 同结构（透传）—— 这里不复用是避免前端 import Go 类型
// （前端 wailsjs 也不直接暴露 Go struct 给 TS，TS 这边手动声明更稳）。
type GitSyncProgressPayload struct {
	Stage   string `json:"stage"`
	Percent int    `json:"percent"`
	Message string `json:"message"`
	Cur     int    `json:"cur"`
	Total   int    `json:"total"`
	// RepoKey 仓库 key（前端用这个 map 到 clonedMap / progressByRepo）
	// 格式：`<platform>/<hostURL>/<owner>/<repo>`（与 useRepoStore.refreshClonedStatus 一致风格）
	RepoKey string `json:"repoKey"`
}

// buildSyncProgressCallback 构造 ProgressCallback，把每条 SyncProgress 包装成 Wails event
//
// 用法：CloneRepo / PullRepoByProjectId 调本函数生成 cb，传给 git.CloneRepo / git.PullRepo
//
// 参数：
//   - repoKey:前端用于 map 的仓库标识（建议 `${owner}/${repo}`，前端 clonedMap 风格）
//   - extra:可选 extra fields（占位，保留用于未来加 progressId / correlationId 等）
func (a *App) buildSyncProgressCallback(repoKey string) git.ProgressCallback {
	if a.ctx == nil {
		// 没初始化 context 时 EventsEmit 不能用，返 no-op（避免 nil panic）
		return func(p git.SyncProgress) {}
	}
	// 测试场景（app.OnStartup(context.Background())）拿不到 Wails events，
	// wails runtime.EventsEmit 内部 log.Fatalf → os.Exit(1) 会让测试进程 abort。
	// 检查 ctx 中是否注册了 events key（Wails app_production.go:77 / app_dev.go:225
	// 都会 context.WithValue(ctx, "events", eventHandler)），没有则返 no-op。
	if a.ctx.Value("events") == nil {
		return func(p git.SyncProgress) {}
	}
	return func(p git.SyncProgress) {
		payload := GitSyncProgressPayload{
			Stage:   string(p.Stage),
			Percent: p.Percent,
			Message: p.Message,
			Cur:     p.Cur,
			Total:   p.Total,
			RepoKey: repoKey,
		}
		// 异步发，不阻塞 go-git sideband goroutine
		// （Wails EventsEmit 本身线程安全；wails dev 终端 + production 都行）
		wailsruntime.EventsEmit(a.ctx, GitSyncProgressEvent, payload)
	}
}

// CloneRepo clone 仓库到本地 workspace
//
// v2.3：token 走 secret.Store 从 keychain 拿（前端**不**传 token）
// 校验当前账号的 hostURL+username 必须匹配 localStore.Accounts 里某条记录
// （防 user 拿错 token clone 到别账号仓库 —— 但 hostURL 一样所以问题不大）
//
// v2.6：装上 progress 回调，通过 Wails EventsEmit 实时推百分比到前端
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("CloneRepo",
			"projectId", args.ProjectID,
			"platform", args.Platform,
			"owner", args.Owner,
			"repo", args.Repo,
			"workspace", a.workspacePath,
		)
	}

	// 优先按 projectId 反查（v2.x，与 PullRepoByProjectId 范式对齐）：
	//   前端 syncRepo 只传 projectId，Go 端反查 project→account 拿 platform/hostUrl/username/owner/repo。
	//   修复"GitHub 小仓库点同步报 hostUrl 不能为空"：旧协议要求前端传 platform/hostUrl/username，
	//   但前端只有 projectId，shim 把 hostUrl 透传成空字符串 → 校验失败。
	var (
		platformName   string
		hostURL        string
		username       string
		owner          string
		repo           string
		matchedAccount *store.GiteaAccount
		matchedProject *store.RepoProject
	)

	if strings.TrimSpace(args.ProjectID) != "" {
		project, account, err := a.findProjectAndAccount(args.ProjectID)
		if err != nil {
			return CloneRepoResult{}, err
		}
		matchedProject = project
		matchedAccount = account
		platformName = account.Platform
		hostURL = account.GiteaURL
		username = account.Username
		owner = project.Owner
		repo = project.Name
	} else {
		// 旧协议回退（projectId 为空时）：前端传 platform/hostUrl/username/owner/repo
		platformName = strings.TrimSpace(args.Platform)
		hostURL = strings.TrimSpace(args.HostURL)
		username = strings.TrimSpace(args.Username)
		owner = strings.TrimSpace(args.Owner)
		repo = strings.TrimSpace(args.Repo)
	}

	if platformName == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("platform 不能为空", "")
	}
	if !platformAdapter.IsValid(platformName) {
		return CloneRepoResult{}, ipc.NewValidationFailed("不支持的平台", "platform="+platformName)
	}
	if hostURL == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("hostUrl 不能为空", "projectId 为空时需传 hostUrl，或检查 project 是否关联了 account")
	}
	if username == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("username 不能为空", "")
	}
	if owner == "" || repo == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("owner/repo 不能为空",
			fmt.Sprintf("owner=%q repo=%q", owner, repo))
	}

	// 1. 从 localStore 找账号 → secret.Store 拿 token
	//    projectId 路径已通过 findProjectAndAccount 拿到 matchedAccount；
	//    旧协议路径需按 platform+hostURL+username 匹配（防越权 clone 别账号仓库）
	if matchedAccount == nil {
		state := a.localStore.Get()
		for i := range state.Accounts {
			if state.Accounts[i].Platform == platformName &&
				state.Accounts[i].GiteaURL == hostURL &&
				state.Accounts[i].Username == username {
				matchedAccount = &state.Accounts[i]
				break
			}
		}
	}
	if matchedAccount == nil {
		return CloneRepoResult{}, &ipc.IpcError{
			Code:    ipc.CodeNotFound,
			Message: "未找到匹配账号",
			Hint:    "请检查 hostUrl/username 是否正确，或重新连接",
			Cause: fmt.Sprintf(
				"platform=%s hostUrl=%s username=%s (localStore.Accounts 里找不到匹配项)",
				platformName, hostURL, username,
			),
		}
	}

	// 2. 从 keychain 拿 token（绝不传给前端）
	token, err := a.resolveToken(matchedAccount)
	if err != nil {
		return CloneRepoResult{}, err
	}

	// 3. clone
	adapter := a.getAdapter(platformName)
	if adapter == nil {
		return CloneRepoResult{}, ipc.NewInternal("平台适配器未初始化：" + platformName)
	}

	// v2.5：clone 到账号隔离的子目录
	//   旧布局：${workspacePath}/repos/<owner>__<repo>/
	//   新布局：${workspacePath}/repos/<username>/<owner>__<repo>/
	//
	// v2.6：progress 回调（把 sideband 解析结果通过 EventsEmit 推到前端）
	localPath, err := adapter.CloneRepo(a.ctx, hostURL, username, token, owner, repo, a.workspacePath, matchedAccount.Username, a.buildSyncProgressCallback(owner+"/"+repo))
	if err != nil {
		return CloneRepoResult{}, err
	}

	// 4. 标记 project：projectId 路径已存在 project（只刷 LastSyncAt）；
	//    旧协议路径可能 project 不存在 → 新建。
	//
	// v2.3 重要：必须新建 project（之前是只更新，导致 pullRepo 找不到 project → 找不到 token）
	_ = a.localStore.Mutate(func(s *store.LocalState) {
		now := time.Now().UnixMilli()
		// projectId 路径：直接刷已知 project
		if matchedProject != nil {
			for i := range s.Projects {
				if s.Projects[i].ID == matchedProject.ID {
					s.Projects[i].LastSyncAt = now
					return
				}
			}
		}
		for i := range s.Projects {
			if s.Projects[i].Platform == platformName &&
				s.Projects[i].AccountID == matchedAccount.ID &&
				s.Projects[i].Owner == owner &&
				s.Projects[i].Name == repo {
				s.Projects[i].LastSyncAt = now
				return
			}
		}
		// 新建 project（仅旧协议路径会走到这里）
		s.Projects = append(s.Projects, store.RepoProject{
			ID:            uuid.NewString(),
			Platform:      platformName,
			AccountID:     matchedAccount.ID,
			Owner:         owner,
			Name:          repo,
			DefaultBranch: "", // CloneRepo 不知道 default branch，由 GetAppInfo / ListRepos 后续补充
			LastSyncAt:    now,
			CreatedAt:     now,
		})
	})

	if a.logger != nil {
		a.logger.Info("CloneRepo: success",
			"owner", owner, "repo", repo,
			"localPath", localPath, "accountId", matchedAccount.ID,
		)
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

// ===== v2.4 鉴权修复：Git Graph 端到端可用 =====
//
// 修复 StatusBar 选完仓库后"看板、Git Graph 等功能还是不能使用"：
//   - 旧版 commits.gitgraph.lines 在 shim 里是 stubEmpty（永远返 0 commits）
//   - 旧版 commits.gitgraphCloneRepo 也是 notImplemented
//   - 旧版 commits.gitgraphPull 用错误的 localPath
//
// v2.4 新增：
//   - GetGitGraph(projectId) → 反查 localPath/token → adapter.LogGraph → GraphResultDTO
//   - GetRepoById(projectId) → 返 RepoDTO + localPath（前端 ListWorkspaceRepos 的替代品）
//
// 设计原则：前端只传 projectId（业务态概念），Go 端做所有"反查"

// GetGitGraphArgs Git Graph 入参
type GetGitGraphArgs struct {
	ProjectID string   `json:"projectId"`
	Branches  []string `json:"branches,omitempty"`
	MaxCount  int      `json:"maxCount,omitempty"`
	Offset    int      `json:"offset,omitempty"`
}

// GetGitGraph 获取项目的 commit DAG（用 projectId 反查 localPath + token）
//
// 步骤：
//  1. localStore.Projects 找 project → owner/name/accountID
//  2. localStore.Accounts 找 account → platform/hostURL/username
//  3. workspacePath + /repos/<owner>__<repo> = localPath
//  4. secretStore 拿 token
//  5. adapter.LogGraph → 自研 layout → 返 GraphResultDTO
func (a *App) GetGitGraph(args GetGitGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("GetGitGraph", "projectId", args.ProjectID, "branches", args.Branches)
	}

	if args.ProjectID == "" {
		return GraphResultDTO{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// 1-2. 找 project + account
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 3. 算 localPath（v2.5：按账号分层）
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	// 4. 拿 token
	token, err := a.resolveToken(account)
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 5. 调 adapter.LogGraph
	adapter := a.getAdapter(account.Platform)
	if adapter == nil {
		return GraphResultDTO{}, ipc.NewUnsupportedPlatform(account.Platform)
	}

	// 6. 解析本地 HEAD (用于 layout 给 local HEAD 节点打 isCurrent 标记,
	//    GitHub adapter 老版本没这个 fallback 会让 local HEAD 的 dot
	//    画成实心、tooltip 误标"不在 HEAD 中")。失败不致命,空字符串让
	//    layout 跳过 isCurrent 标记,跟旧行为兼容。
	head := git.ResolveLocalHead(localPath)

	// 6. token 透传给 adapter（go-git 用 BasicAuth，不需要 user 传）
	// v0.6.2: token 也用于 offset 越界时后台 deepen 认证。

	result, err := adapter.LogGraph(a.ctx, localPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
		Head:     head,
		Offset:   args.Offset,
		Token:    token,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 顺便返回 localPath（前端可显示"已 clone 在 ..."）
	return graphResultToAppDTO(result), nil
}

// GetGitGraphAscii 获取 git log --graph 字符流版本的 Git Graph。
//
// 主要用于 GitHub/gh partial clone 的超大仓库：让系统 git 直接输出 ASCII graph，
// 前端复用旧 parser 渲染，避免结构化 lane 算法在超大浅历史下生成过宽 SVG。
func (a *App) GetGitGraphAscii(args GetGitGraphArgs) (git.GraphLinesResult, error) {
	if a.logger != nil {
		a.logger.Info("GetGitGraphAscii", "projectId", args.ProjectID, "branches", args.Branches)
	}

	if args.ProjectID == "" {
		return git.GraphLinesResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return git.GraphLinesResult{}, err
	}
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)
	result, err := git.RunGraphLog(localPath, git.RunGraphLogOptions{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return git.GraphLinesResult{}, ipc.NewInternal(err.Error())
	}
	return *result, nil
}

// GetRepoByIdArgs 查项目参数
type GetRepoByIdArgs struct {
	ProjectID string `json:"projectId"`
}

// GetRepoByIdResult 查项目结果
type GetRepoByIdResult struct {
	// Project 项目的 RepoProjectDto（localStore.Projects 行的拷贝）
	Project store.RepoProject `json:"project"`
	// Account 项目的关联账号
	Account AccountDTO `json:"account"`
	// LocalPath 仓库本地路径（v2.4：按 owner+name + workspacePath 算）
	LocalPath string `json:"localPath"`
	// Cloned 本地是否已 clone（IsRepoCloned 检查）
	Cloned bool `json:"cloned"`
}

// GetRepoById 按 projectId 查项目 + 关联账号 + localPath + clone 状态
//
// v2.4 新增：前端"我选了哪个仓库"的关键信息聚合点
// 一次调用拿齐所有"画 Git Graph / 拉数据"所需的信息
func (a *App) GetRepoById(args GetRepoByIdArgs) (GetRepoByIdResult, error) {
	if args.ProjectID == "" {
		return GetRepoByIdResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GetRepoByIdResult{}, err
	}

	// v2.5：按账号分层
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)
	cloned := git.RepoExists(localPath)

	return GetRepoByIdResult{
		Project:   *project,
		Account:   accountToDTO(*account),
		LocalPath: localPath,
		Cloned:    cloned,
	}, nil
}

// findProjectAndAccount 内部 helper：按 projectId 找 project + 关联 account
//
// 找不到 project → NotFound
// 找到 project 但 account 已被删 → NotFound
func (a *App) findProjectAndAccount(projectID string) (*store.RepoProject, *store.GiteaAccount, error) {
	state := a.localStore.Get()

	var matchedProject *store.RepoProject
	for i := range state.Projects {
		if state.Projects[i].ID == projectID {
			matchedProject = &state.Projects[i]
			break
		}
	}
	if matchedProject == nil {
		return nil, nil, ipc.NewNotFound("未找到 project: " + projectID)
	}

	for i := range state.Accounts {
		if state.Accounts[i].ID == matchedProject.AccountID {
			return matchedProject, &state.Accounts[i], nil
		}
	}
	return nil, nil, ipc.NewNotFound(
		"project 关联的 account 不存在: projectId=" + projectID +
			" accountId=" + matchedProject.AccountID,
	)
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
			RefTypes:    n.RefTypes,
			IsCurrent:   n.IsCurrent,
			IsStash:     n.IsStash,
			IsCommitted: n.IsCommitted,
		})
	}

	edges := make([]GraphEdgeDTO, 0, len(r.Edges))
	for _, e := range r.Edges {
		edges = append(edges, GraphEdgeDTO{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Color:    e.Color,
			Type:     e.Type,
		})
	}

	branches := make([]GraphBranchDTO, 0, len(r.Branches))
	for _, b := range r.Branches {
		lines := make([]GraphBranchLineDTO, 0, len(b.Lines))
		for _, ln := range b.Lines {
			lines = append(lines, GraphBranchLineDTO{
				X1:          ln.X1,
				Y1:          ln.Y1,
				X2:          ln.X2,
				Y2:          ln.Y2,
				LockedFirst: ln.LockedFirst,
				IsCommitted: ln.IsCommitted,
			})
		}
		branches = append(branches, GraphBranchDTO{
			Color: b.Color,
			End:   b.End,
			Lines: lines,
		})
	}

	return GraphResultDTO{
		Nodes:     nodes,
		Edges:     edges,
		Branches:  branches,
		MaxLane:   r.MaxLane,
		Truncated: r.Truncated,
	}
}
