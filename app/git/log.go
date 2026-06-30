package git

import (
	"fmt"
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

// CommitRef commit 关联的 ref（带类型）
type CommitRef struct {
	Name string  // ref 短名（已剥前缀）：main, v1.0, origin/main
	Type RefType // branch / remoteBranch / tag
	// IsHEAD 标记是否是 HEAD 指向（如 main 当前指向的 commit）
	// 用于前端给 HEAD 引用特殊样式（v2.8 暂未消费，预留）
	IsHEAD bool
}

// LogOptions log 遍历参数
type LogOptions struct {
	// LocalPath 本地仓库路径
	LocalPath string
	// Branches 要包含的分支名（空 = HEAD 全部历史）
	Branches []string
	// MaxCount 最大 commit 数（0 = 不限）
	MaxCount int
}

// LogResult log 遍历结果
type LogResult struct {
	Commits   []CommitInfo
	Truncated bool // 是否达到 MaxCount 截断
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

	truncated := false
	if opts.MaxCount > 0 && len(commits) > opts.MaxCount {
		commits = commits[:opts.MaxCount]
		truncated = true
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

// collectAllBranchHeads 收集仓库所有分支的 HEAD hash（本地 + 远程跟踪）
func collectAllBranchHeads(repo *git.Repository) ([]plumbing.Hash, error) {
	heads := make([]plumbing.Hash, 0)
	seen := make(map[plumbing.Hash]bool)

	// 1. 本地分支
	localRefs, err := repo.References()
	if err != nil {
		return nil, err
	}
	err = localRefs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() == plumbing.HashReference && ref.Name().IsBranch() {
			if !seen[ref.Hash()] {
				seen[ref.Hash()] = true
				heads = append(heads, ref.Hash())
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 2. 远程跟踪分支
	remoteRefs, err := repo.References()
	if err != nil {
		return nil, err
	}
	err = remoteRefs.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() == plumbing.HashReference && ref.Name().IsRemote() {
			if !seen[ref.Hash()] {
				seen[ref.Hash()] = true
				heads = append(heads, ref.Hash())
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 3. 如果没有分支，fallback 到 HEAD
	if len(heads) == 0 {
		head, err := repo.Head()
		if err == nil {
			heads = append(heads, head.Hash())
		}
	}

	return heads, nil
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
