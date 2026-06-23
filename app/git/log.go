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
	SHA         string    // 完整 hash
	ShortSHA    string    // 短 hash（前 7 位）
	Subject     string    // commit message 第一行
	AuthorName  string
	AuthorEmail string
	AuthorWhen  time.Time // 作者时间
	Parents     []string  // parent SHA 列表
	IsMerge     bool      // 是否 merge commit（parents >= 2）
	// Refs 关联的 ref 名称列表（branch / tag / PR 编号等）
	// v2.7 增量：从 go-git References() 收集所有指向此 commit 的 ref。
	// 顺序：本地分支 → 远程跟踪分支 → tag（顺序固定，前端可直接按顺序渲染）。
	// 名称已剥掉 `refs/heads/`、`refs/remotes/origin/`、`refs/tags/` 前缀。
	Refs []string
}

// RefType ref 类型
type RefType string

const (
	RefTypeBranch      RefType = "branch"      // 本地分支（refs/heads/...）
	RefTypeRemoteBranch RefType = "remoteBranch" // 远程跟踪分支（refs/remotes/<remote>/...）
	RefTypeTag         RefType = "tag"         // tag（refs/tags/...）
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
	// 步骤：
	//   1. 收集所有分支（本地 + 远程跟踪）的 HEAD hash
	//   2. 对每个分支起点做 Log 遍历
	//   3. 用 seen map 去重，合并所有 commit
	allHeads, err := collectAllBranchHeads(repo)
	if err != nil {
		return nil, fmt.Errorf("收集分支列表失败: %w", err)
	}

	// 收集所有 ref 名称（branch / tag）并按 SHA 索引
	// v2.7 增量：让 commit 列表附带 refs 名称，前端右侧 commit 行直接渲染
	// 格式：[branch/ref-name-1, branch/ref-name-2, tag/v1.0]
	refNameByHash := collectRefNamesByHash(repo)

	commits := make([]CommitInfo, 0)
	seen := make(map[string]bool)
	truncated := false

	for _, headHash := range allHeads {
		if truncated {
			break
		}
		gitLogOpts := &git.LogOptions{
			From:  headHash,
			Order: git.LogOrderCommitterTime,
		}
		iter, err := repo.Log(gitLogOpts)
		if err != nil {
			continue // 某些分支可能无法遍历，跳过
		}
		err = iter.ForEach(func(c *object.Commit) error {
			if opts.MaxCount > 0 && len(commits) >= opts.MaxCount {
				truncated = true
				return storer.ErrStop
			}
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
				Refs:        refNameByHash[c.Hash.String()],
			})
			return nil
		})
		if err != nil && err != storer.ErrStop {
			return nil, fmt.Errorf("迭代 commits 失败: %w", err)
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

// collectRefNamesByHash 收集仓库所有 ref 名称（branch + tag）并按 SHA 索引
//
// 返回 map[SHA][]string。每个 SHA 对应的 ref 列表顺序固定：本地分支 → 远程跟踪分支 → tag。
// ref 名称已剥掉标准前缀（refs/heads/、refs/remotes/<remote>/、refs/tags/），
//   远程跟踪分支保留 `<remote>/<branch>` 形式（如 `origin/main`），与 Gitea 行为一致。
//
// v2.7 增量：让 LogCommits 返回的每条 CommitInfo 自带 refs，前端右侧 commit 行
// 直接渲染分支/tag badge，无需额外 API 调用。
func collectRefNamesByHash(repo *git.Repository) map[string][]string {
	result := make(map[string][]string)

	refs, err := repo.References()
	if err != nil {
		// 收集失败不致命：log 命令仍可工作，只是 ref 列表为空
		return result
	}

	_ = refs.ForEach(func(ref *plumbing.Reference) error {
		// 跳过 symbolic ref（如 HEAD → refs/heads/main）
		if ref.Type() != plumbing.HashReference {
			return nil
		}

		name := ref.Name().String()
		var shortName string
		switch {
		case strings.HasPrefix(name, "refs/heads/"):
			// 本地分支 → 剥前缀，保留 main、feature/xxx 等
			shortName = strings.TrimPrefix(name, "refs/heads/")
		case strings.HasPrefix(name, "refs/remotes/"):
			// 远程跟踪分支 → 保留 origin/main 形式（与 Gitea 一致）
			shortName = strings.TrimPrefix(name, "refs/remotes/")
		case strings.HasPrefix(name, "refs/tags/"):
			// tag → 剥前缀
			shortName = strings.TrimPrefix(name, "refs/tags/")
		default:
			// 其他 ref（notes、stash 等）跳过
			return nil
		}

		if shortName == "" {
			return nil
		}

		sha := ref.Hash().String()
		result[sha] = append(result[sha], shortName)
		return nil
	})

	return result
}
