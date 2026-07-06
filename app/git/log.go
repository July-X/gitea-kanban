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
	AuthorWhen  time.Time // 作者时间
	Parents     []string  // parent SHA 列表
	IsMerge     bool      // 是否 merge commit（parents >= 2）
	// Refs 关联的 ref 名称列表（branch / tag / PR 编号等）
	// 顺序固定：本地分支 → 远程跟踪分支 → tag（collectRefNamesByHash 已排序）。
	// 名称已剥掉 `refs/heads/`、`refs/remotes/origin/`、`refs/tags/` 前缀；
	// 远程跟踪分支保留 `<remote>/<branch>` 形式（如 `origin/main`）。
	Refs []string
	// RefTypes 与 Refs 一一对应的 ref 类型（v2.8 新增）
	// 让前端严格区分 branch / remoteBranch / tag，不再用启发式猜。
	RefTypes []RefType
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
	candidateLimit := opts.MaxCount
	if candidateLimit <= 0 {
		candidateLimit = 0
	} else if candidateLimit < 50 {
		candidateLimit = 50
	}

	for _, headHash := range allHeads {
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

			commits = append(commits, CommitInfo{
				SHA:         c.Hash.String(),
				ShortSHA:    c.Hash.String()[:7],
				Subject:     extractSubject(c.Message),
				AuthorName:  c.Author.Name,
				AuthorEmail: c.Author.Email,
				AuthorWhen:  c.Author.When,
				Parents:     parents,
				IsMerge:     len(parents) >= 2,
				Refs:        refDataByHash[c.Hash.String()].Names,
				RefTypes:    refDataByHash[c.Hash.String()].Types,
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
				commits = append(commits, CommitInfo{
					SHA:         commit.Hash.String(),
					ShortSHA:    commit.Hash.String()[:7],
					Subject:     extractSubject(commit.Message),
					AuthorName:  commit.Author.Name,
					AuthorEmail: commit.Author.Email,
					AuthorWhen:  commit.Author.When,
					Parents:     parents,
					IsMerge:     len(parents) >= 2,
					Refs:        refDataByHash[commit.Hash.String()].Names,
					RefTypes:    refDataByHash[commit.Hash.String()].Types,
				})
			}
			continue
		}
	}

	// 按时间降序排序（所有分支合并后需要重排）
	// 用 SHA 作为 tie-breaker 保证稳定顺序（避免 layout 算法因不稳定顺序而 lane 错位）
	// SliceStable 保持 SHA 字典序相同时的原始顺序
	sort.Slice(commits, func(i, j int) bool {
		if !commits[i].AuthorWhen.Equal(commits[j].AuthorWhen) {
			return commits[i].AuthorWhen.After(commits[j].AuthorWhen)
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
func collectLimitedBranchHeads(repo *git.Repository, maxCount int) ([]plumbing.Hash, error) {
	const maxBranches = 20 // 最多遍历 20 个分支（覆盖绝大部分使用场景）

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
		if headHash != plumbing.ZeroHash && !seen[headHash] {
			seen[headHash] = true
			branches = append(branches, branchInfo{
				hash:     headHash,
				name:     "HEAD",
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

	// 6. 提取 hash 列表
	heads := make([]plumbing.Hash, len(branches))
	for i, b := range branches {
		heads[i] = b.hash
	}

	return heads, nil
}

// min 返回两个整数中的较小值
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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

		sha := ref.Hash().String()
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
