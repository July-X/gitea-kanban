package git

import (
	"fmt"
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
	iter, err := repo.Log(gitLogOpts)
	if err != nil {
		return nil, fmt.Errorf("log 遍历失败: %w", err)
	}

	commits := make([]CommitInfo, 0)
	truncated := false

	err = iter.ForEach(func(c *object.Commit) error {
		if opts.MaxCount > 0 && len(commits) >= opts.MaxCount {
			truncated = true
			return storer.ErrStop // 用这个错误中断迭代
		}

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
		})
		return nil
	})

	if err != nil && err != storer.ErrStop {
		return nil, fmt.Errorf("迭代 commits 失败: %w", err)
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
