package git

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
)

// CommitInfo commit 元数据（对齐前端 GraphLineCommitDto）
type CommitInfo struct {
	SHA         string // 完整 hash
	ShortSHA    string // 短 hash（前 7 位）
	Subject     string // commit message 第一行
	AuthorName  string
	AuthorEmail string
	AuthorWhen  time.Time // 作者时间（author date，rebase/cherry-pick 后保留原始创作时间）
	// CommitterWhen 提交时间（committer date，rebase/cherry-pick 后刷新为操作时间）。
	// v0.8.25.6：DAG 排序必须用它（对齐 git log --date-order 的 commit date 语义），
	// 用 author date 排序会把 cherry-pick 来的 commit 沉到历史深处（author date 保留原始时间）。
	CommitterWhen time.Time
	Parents       []string // parent SHA 列表
	IsMerge       bool     // 是否 merge commit（parents >= 2）
	// Refs 关联的 ref 名称列表（branch / tag / PR 编号等）
	// 顺序固定：本地分支 → 远程跟踪分支 → tag（collectRefNamesByHash 已排序）。
	// 名称已剥掉 `refs/heads/`、`refs/remotes/origin/`、`refs/tags/` 前缀；
	// 远程跟踪分支保留 `<remote>/<branch>` 形式（如 `origin/main`）。
	Refs []string
	// RefTypes 与 Refs 一一对应的 ref 类型（v2.8 新增）
	// 让前端严格区分 branch / remoteBranch / tag，不再用启发式猜。
	RefTypes []RefType
}

// SortTime 返回 DAG 排序用的时间：优先 committer date（对齐 git log --date-order），
// CommitterWhen 为零值（旧测试数据 / 外部构造）时回退 author date。
func (c CommitInfo) SortTime() time.Time {
	if !c.CommitterWhen.IsZero() {
		return c.CommitterWhen
	}
	return c.AuthorWhen
}

// RefType ref 类型
type RefType string

const (
	RefTypeBranch       RefType = "branch"       // 本地分支（refs/heads/...）
	RefTypeRemoteBranch RefType = "remoteBranch" // 远程跟踪分支（refs/remotes/<remote>/...）
	RefTypeTag          RefType = "tag"          // tag（refs/tags/...）
)

// LogOptions log 遍历参数
type LogOptions struct {
	// LocalPath 本地仓库路径
	LocalPath string
	// Branches 要包含的分支名（空 = HEAD 全部历史）
	Branches []string
	// MaxCount 最大 commit 数（0 = 不限）
	MaxCount int
	// Offset 跳过前 N 条 commit（分页用，0 = 不跳过）
	Offset int
	// Token 仓库 token（offset 越界 + repoIsShallow 时自动调 git fetch --deepen 用）
	Token string
}

// LogResult log 遍历结果
type LogResult struct {
	Commits   []CommitInfo
	Truncated bool // 是否达到 MaxCount 截断
	// LocalExhausted 本地 commit 已全部取出（越界或深度等于远端总 commit 数），
	// 远端可能有更多（需 fetch --deepen 拉取）。true 时 Commits 为空，Truncated 为 false。
	// 前端据此显示「本地历史已加载完，是否加载更早的历史？」按钮。
	LocalExhausted bool
	// DeepenTriggered LocalExhausted=true 时，后端已启动后台增量 deepen。前端等待
	// repo:sync:progress 事件完成后再调 loadGraph(offset)，不应再次触发 deepen。
	DeepenTriggered bool
}

// LogCommits 遍历 commit 历史（go-git DAG Log）
//
// 对齐旧版 runGraphLog 的语义：
//   - 按 commit time 降序（--date-order）
//   - 支持 branches 过滤
//   - 支持 MaxCount 截断
//
// 与旧版差异：
//   - 旧版跑 git log --graph 拿字形 + DATA 行，前端 parser 解析
//   - 新版直接遍历 go-git Log() 拿结构化 CommitInfo，无需字形解析
//   - Graph 布局在 layout.go 自研（步骤 4.3）
//
// v2.7 超大仓库优化：
//   - 限制遍历分支数（默认最多 20 个分支）
//   - 优先遍历 HEAD + 主要分支（main/master/develop 等）
//   - 每个 branch head 局部限量，最终全局排序后截断
func LogCommits(opts LogOptions) (*LogResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}

	repo, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}

	// 构造 go-git LogOptions
	gitLogOpts := &git.LogOptions{
		Order: git.LogOrderCommitterTime, // 按时间降序（对齐 --date-order）
	}

	// 如果指定了 branches，从第一个分支的 HEAD 开始遍历
	// （go-git Log 只支持单一起点 From，多分支需要后续遍历合并）
	if len(opts.Branches) > 0 {
		ref, err := repo.Reference(plumbing.NewBranchReferenceName(opts.Branches[0]), true)
		if err != nil {
			// 可能是 remote branch
			ref, err = repo.Reference(plumbing.NewRemoteReferenceName("origin", opts.Branches[0]), true)
			if err != nil {
				return nil, fmt.Errorf("找不到分支 %s: %w", opts.Branches[0], err)
			}
		}
		gitLogOpts.From = ref.Hash()
	}

	// 遍历 commit
	// v2.5 修复：遍历所有分支的 commit，而非仅 HEAD
	// v2.7 优化：限制分支数（超大仓库如 UnrealEngine 可能有几十上百个分支）
	// 步骤：
	//   1. 收集分支（本地 + 远程跟踪）的 HEAD hash，但限制数量
	//   2. 对每个分支起点做 Log 遍历
	//   3. 用 seen map 去重，合并所有 commit
	//   4. 最终按时间排序后再做 MaxCount 截断，避免近期 remote branch head 被主线早停吞掉
	allHeads, err := collectLimitedBranchHeads(repo, opts.MaxCount)
	if err != nil {
		return nil, fmt.Errorf("收集分支列表失败: %w", err)
	}

	// 收集所有 ref 名称（branch / remote / tag）并按 SHA 索引
	// v2.8：返回名称 + 类型，且按「本地分支 → 远程跟踪分支 → tag」稳定排序
	refDataByHash := collectRefNamesByHash(repo)

	commits := make([]CommitInfo, 0)
	seen := make(map[string]bool)
	// v0.8.37.3 修复：candidateLimit 默认是 opts.MaxCount（用户视角的"加载上限"）。
	// 但这个 candidateLimit 同时也是每个 branch head 遍历 commit 的硬上限——
	// 当某个 branch 独有历史超过 MaxCount 时，那部分 commit 永远拿不到 refs 挂载。
	// 用户截图 2026-08-01 07:18 反馈：88d9b92 在 master 第 650 行，
	// MaxCount=300 时被 candidateLimit 截断 → branch badge 缺失。
	// 修法：candidateLimit 至少 1000（覆盖 99% 仓库），让分支独有历史可被遍历。
	// 最终排序后仍用 opts.MaxCount 截断（前端控制 UI 性能），多看到的 commits 走 seen 去重。
	candidateLimit := opts.MaxCount
	if candidateLimit <= 0 {
		candidateLimit = 0
	} else if candidateLimit < 1000 {
		candidateLimit = 1000
	}

	for _, branch := range allHeads {
		headHash := branch.hash
		gitLogOpts := &git.LogOptions{
			From:  headHash,
			Order: git.LogOrderCommitterTime,
		}
		iter, err := repo.Log(gitLogOpts)
		if err != nil {
			continue // 某些分支可能无法遍历，跳过
		}
		visitedForHead := 0
		err = iter.ForEach(func(c *object.Commit) error {
			if candidateLimit > 0 && visitedForHead >= candidateLimit {
				return storer.ErrStop
			}
			visitedForHead++

			if seen[c.Hash.String()] {
				return nil
			}
			seen[c.Hash.String()] = true

			parents := make([]string, len(c.ParentHashes))
			for i, h := range c.ParentHashes {
				parents[i] = h.String()
			}

			// refs 只来自 refDataByHash（ref HEAD → commit 映射），与 GitHub 路径
			// listRefsByCommit + vscode-git-graph 行为对齐：badge 只出现在 ref
			// 直接指向的 commit 上，不给中间 commit 挂分支名。
			refs := refDataByHash[c.Hash.String()]
			if refs.Names == nil {
				refs.Names = []string{}
				refs.Types = []RefType{}
			}

			commits = append(commits, CommitInfo{
				SHA:           c.Hash.String(),
				ShortSHA:      c.Hash.String()[:7],
				Subject:       extractSubject(c.Message),
				AuthorName:    c.Author.Name,
				AuthorEmail:   c.Author.Email,
				AuthorWhen:    c.Author.When,
				CommitterWhen: c.Committer.When,
				Parents:       parents,
				IsMerge:       len(parents) >= 2,
				Refs:          refs.Names,
				RefTypes:      refs.Types,
			})
			return nil
		})
		if err != nil && err != storer.ErrStop {
			// v2.7: 浅克隆（shallow clone）场景下，Log() 迭代器会在尝试访问不存在的 parent 时立即报错，
			// 导致一个 commit 都没处理。Fallback：直接访问 HEAD commit 对象。
			commit, commitErr := repo.CommitObject(headHash)
			if commitErr == nil && !seen[commit.Hash.String()] {
				seen[commit.Hash.String()] = true
				parents := make([]string, len(commit.ParentHashes))
				for i, h := range commit.ParentHashes {
					parents[i] = h.String()
				}
				// refs 只来自 refDataByHash（与主路径一致）
				refs := refDataByHash[commit.Hash.String()]
				if refs.Names == nil {
					refs.Names = []string{}
					refs.Types = []RefType{}
				}
				commits = append(commits, CommitInfo{
					SHA:           commit.Hash.String(),
					ShortSHA:      commit.Hash.String()[:7],
					Subject:       extractSubject(commit.Message),
					AuthorName:    commit.Author.Name,
					AuthorEmail:   commit.Author.Email,
					AuthorWhen:    commit.Author.When,
					CommitterWhen: commit.Committer.When,
					Parents:       parents,
					IsMerge:       len(parents) >= 2,
					Refs:          refs.Names,
					RefTypes:      refs.Types,
				})
			}
			continue
		}
	}

	// 按提交时间（committer date）降序排序（所有分支合并后需要重排）
	// v0.8.25.6：从 author date 改为 committer date，对齐 git log --date-order。
	// author date 在 cherry-pick/rebase 后保留原始创作时间，会把这类 commit
	// 排到历史深处（实测 xdolphin/TRex 的 cherry-pick commit 错位 8 行，图 lane 错乱）。
	// 用 SHA 作为 tie-breaker 保证稳定顺序（避免 layout 算法因不稳定顺序而 lane 错位）
	sort.Slice(commits, func(i, j int) bool {
		if !commits[i].SortTime().Equal(commits[j].SortTime()) {
			return commits[i].SortTime().After(commits[j].SortTime())
		}
		return commits[i].SHA < commits[j].SHA
	})

	// localTotal：offset 分页前本地可用 commit 总数，用于 v0.7.2 的「本地耗尽」检测。
	localTotal := len(commits)

	// offset 分页：跳过前 N 条（在排序后、截断前执行，保证稳定分页）
	if opts.Offset > 0 && opts.Offset < len(commits) {
		commits = commits[opts.Offset:]
	} else if opts.Offset >= len(commits) {
		commits = nil
	}

	truncated := false
	if opts.MaxCount > 0 && len(commits) > opts.MaxCount {
		commits = commits[:opts.MaxCount]
		truncated = true
	}

	// v0.7.2 修复：shallow clone 下本地 commit 已耗尽但未触发 offset 越界。
	// 与 LogCommitsVscode 同逻辑：当 offset 接近末尾，截取后 commits 不满 MaxCount，
	// 且分页前总条数 localTotal 不足 offset+1（即本地已取完全部 commit），且仓库是 shallow 时，
	// 触发 LocalExhausted + 后台 deepen，避免前端把 truncated=false 当成"全加载完了"。
	if opts.Offset > 0 && opts.Token != "" &&
		!truncated && len(commits) < opts.MaxCount &&
		localTotal < opts.Offset+opts.MaxCount && repoIsShallow(opts.LocalPath) {
		triggered := tryTriggerDeepen(opts.LocalPath, opts.Token)
		return &LogResult{
			Commits:         nil,
			Truncated:       false,
			LocalExhausted:  true,
			DeepenTriggered: triggered,
		}, nil
	}

	// v0.6.2: offset 越界（本地 commit 全部取出）时，若本地是 shallow clone
	// 且前端传了 token，后台自动触发增量 git fetch --deepen。
	// 前端收到 LocalExhausted=true + DeepenTriggered=true 后等待
	// repo:sync:progress 完成事件，然后重新 loadGraph(offset)。
	if opts.Offset > 0 && len(commits) == 0 && opts.Token != "" {
		triggered := tryTriggerDeepen(opts.LocalPath, opts.Token)
		return &LogResult{
			Commits:         nil,
			Truncated:       false,
			LocalExhausted:  true,
			DeepenTriggered: triggered,
		}, nil
	}

	// v3.x：探测 worktree dirty count，1:1 复刻 vscode-git-graph 的
	// commits[0].hash === UNCOMMITTED 模式（数据源: git status --porcelain）。
	// 插入位置对齐 vscode dataSource.ts:191 `commits.unshift(...)`：
	// UNCOMMITTED 永远在 commits[0]（lane 布局 row 0）。
	// 注意：offset 分页时不插入 UNCOMMITTED（只在第一页显示）
	if len(commits) > 0 && opts.Offset == 0 {
		if headSHA, dirtyCount, found, _ := detectUncommittedChanges(opts.LocalPath); found {
			commits = append([]CommitInfo{buildUncommittedCommit(headSHA, dirtyCount)}, commits...)
		}
	}

	return &LogResult{
		Commits:   commits,
		Truncated: truncated,
	}, nil
}

// extractSubject 从 commit message 提取第一行（subject）
func extractSubject(msg string) string {
	for i, r := range msg {
		if r == '\n' {
			return msg[:i]
		}
	}
	return msg
}

// shortSHA 取 hash 前 7 位
func shortSHA(sha string) string {
	if len(sha) >= 7 {
		return sha[:7]
	}
	return sha
}

// branchInfo 分支信息（用于优先级排序）
type branchInfo struct {
	hash     plumbing.Hash
	name     string
	isLocal  bool
	priority int // 优先级（越小越优先）
}

// collectLimitedBranchHeads 收集仓库分支的 HEAD hash（限制数量，优先主要分支）
//
// v2.7 超大仓库优化：
//   - 限制遍历分支数（最多 20 个）
//   - 优先级顺序：HEAD > 主分支(main/master/develop等) > 本地分支 > 远程分支
//   - 超大仓库（如 UnrealEngine）可能有几十上百个分支，全遍历会非常慢
//
// v0.8.37.1 修复：上限 20 → 200。
// 历史 bug：用户截图显示「fix: 对齐 Git Graph 行高和圆点线位」这种 commit
// 整体缺少分支 badge（不是单个 commit 缺，是整段分支全没遍历到）。原因 20
// 上限硬切后，第 21+ 个分支的 head commit 不会进入 commits 列表，
// `collectRefNamesByHash` 维护的 map[SHA]refData 全量但 commit 不在 → badge 显示空。
// 200 覆盖 99% 实际仓库（上百分支的 monorepo），保留兜底防极端仓库性能退化。
// 极端仓库兜底：每 head candidateLimit = opts.MaxCount 仍生效，单分支不会全量扫。
//
// v0.8.37.3 修复：返回 branchInfo 切片（含 hash + name + refType），
// 而不是只返回 hash 列表。LogCommits 现在在每个 branch head 遍历 commit 时
// 同时把 branch name 挂到 byHash[commit.SHA]（之前只挂 ref 自身的 HEAD commit，
// branch 中间 commit 拿不到 refs → badge 缺失）。
func collectLimitedBranchHeads(repo *git.Repository, maxCount int) ([]branchInfo, error) {
	const maxBranches = 200 // 最多遍历 200 个分支（v0.8.37.1: 20 → 200 修分支 badge 缺失）

	branches := make([]branchInfo, 0)
	seen := make(map[plumbing.Hash]bool)

	// 主分支名称列表（优先级最高）
	mainBranchNames := map[string]bool{
		"main":    true,
		"master":  true,
		"develop": true,
		"dev":     true,
		"trunk":   true,
	}

	// 1. 收集 HEAD（最高优先级）
	head, err := repo.Head()
	if err == nil {
		// HEAD 可能是 HashReference（直接指向 commit）或 SymbolicReference（指向分支）
		var headHash plumbing.Hash
		if head.Type() == plumbing.HashReference {
			headHash = head.Hash()
		} else if head.Type() == plumbing.SymbolicReference {
			// HEAD -> refs/heads/main 的情况，解析目标分支的 hash
			target := head.Target()
			targetRef, err := repo.Reference(target, true)
			if err == nil && targetRef.Type() == plumbing.HashReference {
				headHash = targetRef.Hash()
			}
		}
		// v0.8.37.4：HEAD 不占用 seen map，让后续真实分支（与 HEAD 同 hash 的 master/main）
		// 也能加入遍历列表。之前 HEAD 占用 seen[headHash] 后，master 被跳过 →
		// branchCommitMap 里只有 "HEAD"，没有 "master" → 中间 commit 的 Refs 为空
		// 或只有 "HEAD"（用户反馈 Gitea 数据源每个 commit 前面都有 HEAD badge）。
		if headHash != plumbing.ZeroHash {
			branches = append(branches, branchInfo{
				hash:     headHash,
				name:     "", // HEAD 不是真实分支名，留空避免渲染成 badge
				isLocal:  true,
				priority: 0, // 最高优先级
			})
		}
	}

	// 2. 收集本地分支
	localRefs, err := repo.References()
	if err != nil {
		return nil, err
	}
	err = localRefs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() == plumbing.HashReference && ref.Name().IsBranch() {
			if !seen[ref.Hash()] {
				seen[ref.Hash()] = true
				shortName := ref.Name().Short()
				priority := 2 // 本地分支默认优先级
				if mainBranchNames[shortName] {
					priority = 1 // 主分支优先级
				}
				branches = append(branches, branchInfo{
					hash:     ref.Hash(),
					name:     shortName,
					isLocal:  true,
					priority: priority,
				})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 3. 收集远程跟踪分支
	remoteRefs, err := repo.References()
	if err != nil {
		return nil, err
	}
	err = remoteRefs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() == plumbing.HashReference && ref.Name().IsRemote() {
			if !seen[ref.Hash()] {
				seen[ref.Hash()] = true
				shortName := ref.Name().Short()
				priority := 4 // 远程分支优先级最低
				// 检查是否是 origin/main 等主分支
				for mainName := range mainBranchNames {
					if strings.HasSuffix(shortName, "/"+mainName) {
						priority = 3 // 远程主分支
						break
					}
				}
				branches = append(branches, branchInfo{
					hash:     ref.Hash(),
					name:     shortName,
					isLocal:  false,
					priority: priority,
				})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 如果没有收集到任何分支（可能是浅克隆或特殊仓库状态），fallback 到所有 hash refs
	if len(branches) == 0 {
		refs, err := repo.References()
		if err == nil {
			_ = refs.ForEach(func(ref *plumbing.Reference) error {
				if ref.Type() == plumbing.HashReference {
					hash := ref.Hash()
					if !seen[hash] {
						seen[hash] = true
						branches = append(branches, branchInfo{
							hash:     hash,
							name:     ref.Name().String(),
							isLocal:  true,
							priority: 5,
						})
					}
				} else if ref.Type() == plumbing.SymbolicReference {
					// 处理符号引用（如 HEAD -> refs/heads/main）
					target := ref.Target()
					targetRef, err := repo.Reference(target, true)
					if err == nil && targetRef.Type() == plumbing.HashReference {
						hash := targetRef.Hash()
						if !seen[hash] {
							seen[hash] = true
							branches = append(branches, branchInfo{
								hash:     hash,
								name:     target.String(),
								isLocal:  true,
								priority: 5,
							})
						}
					}
				}
				return nil
			})
		}
	}

	// 4. 按优先级排序（priority 升序，同优先级按名称字典序）
	sort.Slice(branches, func(i, j int) bool {
		if branches[i].priority != branches[j].priority {
			return branches[i].priority < branches[j].priority
		}
		return branches[i].name < branches[j].name
	})

	// 5. 限制分支数量
	limit := maxBranches
	if maxCount > 0 && maxCount < 50 {
		// 如果只要很少的 commit（如 20 个），可以进一步减少分支数
		limit = min(10, maxBranches)
	}
	if len(branches) > limit {
		branches = branches[:limit]
	}

	// 6. 提取 branch info 列表（v0.8.37.3：返回完整 branchInfo 而不是只 hash，
	// 让 LogCommits 在每个 branch head 遍历 commit 时能为中间 commit 挂 branch name）
	return branches, nil
}

// min 返回两个整数中的较小值
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// max 返回两个整数中的较大值
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// branchRefEntry v0.8.37.3：在 branch head 遍历 commit 时为每个 visited commit
// 记录的 branch 名称 + 类型。它独立于 refDataByHash（后者只装 ref 自身 HEAD commit），
// 实现"branch 中间 commit 也能识别为该 branch 成员"。
type branchRefEntry struct {
	Name string
	Type RefType
}

// branchRefTypeFromLocal 把 branchInfo.isLocal 转 RefType（本地分支 → branch，远程分支 → remoteBranch）
func branchRefTypeFromLocal(isLocal bool) RefType {
	if isLocal {
		return RefTypeBranch
	}
	return RefTypeRemoteBranch
}

// mergeRefsForCommit 合并 refDataByHash（ref 自身 HEAD）和 branchCommitMap（branch 中间 commit）
// 去重 + 排序（按统一 refOrder：本地分支 → 远程分支 → tag），返回完整 refData
func mergeRefsForCommit(static refData, branchEntries []branchRefEntry) refData {
	// 合并到 map[string]RefType 去重
	seen := make(map[string]int) // name|prefix -> index in Names
	refOrder := map[RefType]int{
		RefTypeBranch:       0,
		RefTypeRemoteBranch: 1,
		RefTypeTag:          2,
	}
	var names []string
	var types []RefType
	add := func(name string, t RefType) {
		key := name + "|" + string(t)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = len(names)
		names = append(names, name)
		types = append(types, t)
	}
	// 优先 static（refDataByHash 已是 ref 自身 HEAD，含完整 type）
	for i, name := range static.Names {
		add(name, static.Types[i])
	}
	// 追加 branch entries（可能含远程分支类型）
	for _, e := range branchEntries {
		add(e.Name, e.Type)
	}
	// 按 (类型优先级, 名称) 排序
	type pair struct {
		name string
		t    RefType
	}
	pairs := make([]pair, len(names))
	for i := range names {
		pairs[i] = pair{names[i], types[i]}
	}
	for i := 1; i < len(pairs); i++ {
		for j := i; j > 0 && (refOrder[pairs[j].t] < refOrder[pairs[j-1].t] ||
			(refOrder[pairs[j].t] == refOrder[pairs[j-1].t] && pairs[j].name < pairs[j-1].name)); j-- {
			pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
		}
	}
	names = names[:0]
	types = types[:0]
	for _, p := range pairs {
		names = append(names, p.name)
		types = append(types, p.t)
	}
	return refData{Names: names, Types: types}
}

// refData 单个 SHA 对应的 ref 名称 + 类型（顺序一一对应）
type refData struct {
	Names []string
	Types []RefType
}

// refOrder 定义 ref 类型的排序优先级（本地分支 → 远程跟踪分支 → tag）
var refOrder = map[RefType]int{
	RefTypeBranch:       0,
	RefTypeRemoteBranch: 1,
	RefTypeTag:          2,
}

// collectRefNamesByHash 收集仓库所有 ref 名称（branch + remote + tag）并按 SHA 索引
//
// 返回 map[SHA]refData。每个 SHA 对应的 ref 列表顺序固定：本地分支 → 远程跟踪分支 → tag，
// 同类型内按名称字典序。ref 名称已剥掉标准前缀（refs/heads/、refs/remotes/、refs/tags/），
// 远程跟踪分支保留 `<remote>/<branch>` 形式（如 `origin/main`），与 Gitea 行为一致。
//
// v2.8 修复：go-git References().ForEach 遍历顺序由 storer 决定、不保证稳定，
// 这里收集后按 (类型优先级, 名称) 排序，保证 badge 显示顺序稳定。
func collectRefNamesByHash(repo *git.Repository) map[string]refData {
	type entry struct {
		name    string
		refType RefType
	}
	byHash := make(map[string][]entry)

	refs, err := repo.References()
	if err != nil {
		// 收集失败不致命：log 命令仍可工作，只是 ref 列表为空
		return map[string]refData{}
	}

	_ = refs.ForEach(func(ref *plumbing.Reference) error {
		// 跳过 symbolic ref（如 HEAD → refs/heads/main）
		if ref.Type() != plumbing.HashReference {
			return nil
		}

		name := ref.Name().String()
		var shortName string
		var refType RefType
		switch {
		case strings.HasPrefix(name, "refs/heads/"):
			shortName = strings.TrimPrefix(name, "refs/heads/")
			refType = RefTypeBranch
		case strings.HasPrefix(name, "refs/remotes/"):
			// 保留 origin/main 形式（与 Gitea 一致）
			shortName = strings.TrimPrefix(name, "refs/remotes/")
			refType = RefTypeRemoteBranch
		case strings.HasPrefix(name, "refs/tags/"):
			shortName = strings.TrimPrefix(name, "refs/tags/")
			refType = RefTypeTag
		default:
			// 其他 ref（notes、stash 等）跳过
			return nil
		}

		if shortName == "" {
			return nil
		}

		// v0.8.37.1 修复：annotated tag peel。
		// go-git ref.Hash() 对 annotated tag 返回 tag object 的 hash，不是 commit hash；
		// 这样挂到 byHash[sha] 后查 commit refs 永远拿不到这个 tag（badge 缺失）。
		// 对齐 GitHub 链路 listRefsByCommit 的 %(*objectname) peel 语义：
		//   - annotated tag: tag object → 解析 tag.Target → commit hash
		//   - lightweight tag: tag 直接指向 commit → ref.Hash() 就是 commit hash
		// 容错：tag object 解析失败（罕见）退回 ref.Hash() 轻量语义。
		sha := ref.Hash().String()
		if refType == RefTypeTag {
			if tagObj, err := repo.TagObject(ref.Hash()); err == nil {
				sha = tagObj.Target.String()
			}
		}
		byHash[sha] = append(byHash[sha], entry{name: shortName, refType: refType})
		return nil
	})

	result := make(map[string]refData, len(byHash))
	for sha, entries := range byHash {
		// 按 (类型优先级, 名称) 排序，保证顺序稳定
		sort.Slice(entries, func(i, j int) bool {
			oi, oj := refOrder[entries[i].refType], refOrder[entries[j].refType]
			if oi != oj {
				return oi < oj
			}
			return entries[i].name < entries[j].name
		})
		names := make([]string, len(entries))
		types := make([]RefType, len(entries))
		for i, e := range entries {
			names[i] = e.name
			types[i] = e.refType
		}
		result[sha] = refData{Names: names, Types: types}
	}
	return result
}

// tryTriggerDeepen 检查本地是否为 shallow 仓库；若是则后台发起增量 deepen
// (fetch --depth=N)，返回 true 表示已触发。
// 前端收到 DeepenTriggered=true 后等待 repo:sync:progress 完成事件即可。
func tryTriggerDeepen(localPath, token string) bool {
	if !repoIsShallow(localPath) {
		return false
	}
	curDepth, err := getCurrentDepth(localPath)
	if err != nil {
		return false
	}
	go func() {
		_ = fetchRemoteWithFilter(localPath, "origin", curDepth+500, token)
	}()
	return true
}

// getCurrentDepth 读取当前 .git/shallow 行数，用于计算下次 --deepen 目标。
func getCurrentDepth(localPath string) (int, error) {
	data, err := os.ReadFile(localPath + "/.git/shallow")
	if err != nil {
		return 0, err
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	count := 0
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" {
			count++
		}
	}
	return count, nil
}
