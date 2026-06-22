package git

import (
	"fmt"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
)

// PullOptions pull 参数
type PullOptions struct {
	// LocalPath 本地仓库路径
	LocalPath string
	// Token 鉴权 token（远程 fetch 需要）
	Token string
	// Username 用户名（token 鉴权用）
	Username string
	// RemoteName 远程名（默认 "origin"）
	RemoteName string
}

// PullResult pull 结果
type PullResult struct {
	// BeforeCount pull 前本地 commit 数
	BeforeCount int
	// AfterCount pull 后本地 commit 数
	AfterCount int
	// AddedCommits 新增 commit 数
	AddedCommits int
}

// FetchResult fetch 结果
type FetchResult struct {
	// Updated 是否有更新
	Updated bool
}

// FetchRepo 从远程拉取最新 refs（git fetch）
//
// 对齐旧版 pullRepo 中的 fetch 步骤：
//   - fetch origin（拉远端最新 refs）
//   - 不修改工作区
func FetchRepo(opts PullOptions) (*FetchResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}

	repo, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}

	remoteName := opts.RemoteName
	if remoteName == "" {
		remoteName = "origin"
	}

	remote, err := repo.Remote(remoteName)
	if err != nil {
		return nil, fmt.Errorf("远程 %s 不存在: %w", remoteName, err)
	}

	// 构造 auth
	var auth *http.BasicAuth
	if opts.Token != "" {
		username := opts.Username
		if username == "" {
			username = "oauth2"
		}
		auth = &http.BasicAuth{
			Username: username,
			Password: opts.Token,
		}
	}

	// fetch
	err = remote.Fetch(&git.FetchOptions{
		Auth: auth,
	})
	if err != nil {
		if err == git.NoErrAlreadyUpToDate {
			return &FetchResult{Updated: false}, nil
		}
		return nil, fmt.Errorf("fetch 失败: %w", err)
	}

	return &FetchResult{Updated: true}, nil
}

// CountCommits 统计本地 HEAD commit 数
func CountCommits(localPath string) (int, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return 0, fmt.Errorf("打开仓库失败: %w", err)
	}

	ref, err := repo.Head()
	if err != nil {
		return 0, fmt.Errorf("获取 HEAD 失败: %w", err)
	}

	return countCommitsReal(repo, ref.Hash())
}

// countCommitsReal 实际的 commit 计数实现
func countCommitsReal(repo *git.Repository, from plumbing.Hash) (int, error) {
	iter, err := repo.Log(&git.LogOptions{From: from})
	if err != nil {
		return 0, err
	}

	count := 0
	err = iter.ForEach(func(c *object.Commit) error {
		count++
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

// PullRepo fetch + 统计 commit 数变化
//
// 对齐旧版 pullRepo：
//   1. 先统计本地 HEAD commit 数（beforeCount）
//   2. git fetch origin
//   3. 再统计本地 HEAD commit 数（afterCount）
//   4. addedCommits = after - before
//
// 注：go-git 的 worktree.Pull 需要 worktree（非 bare 仓库），
// 本函数只做 fetch + 统计，不做 worktree merge/rebase
// （合并/rebase 需要用户决策，后续步骤在前端交互层处理）。
func PullRepo(opts PullOptions) (*PullResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}

	repo, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}

	// 1. 统计 pull 前 commit 数
	ref, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("获取 HEAD 失败: %w", err)
	}
	beforeCount, err := countCommitsReal(repo, ref.Hash())
	if err != nil {
		return nil, fmt.Errorf("统计 commit 数失败: %w", err)
	}

	// 2. fetch
	_, err = FetchRepo(opts)
	if err != nil {
		return nil, err
	}

	// 3. 统计 pull 后 commit 数
	// 重新打开 repo 以获取最新 refs
	repo2, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("重新打开仓库失败: %w", err)
	}
	ref2, err := repo2.Head()
	if err != nil {
		return nil, fmt.Errorf("重新获取 HEAD 失败: %w", err)
	}
	afterCount, err := countCommitsReal(repo2, ref2.Hash())
	if err != nil {
		return nil, fmt.Errorf("统计 commit 数失败: %w", err)
	}

	return &PullResult{
		BeforeCount:  beforeCount,
		AfterCount:   afterCount,
		AddedCommits: afterCount - beforeCount,
	}, nil
}

// RemoteExists 检查仓库是否有指定的 remote
func RemoteExists(localPath, remoteName string) (bool, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return false, err
	}

	remotes, err := repo.Remotes()
	if err != nil {
		return false, err
	}

	for _, r := range remotes {
		if r.Config().Name == remoteName {
			return true, nil
		}
	}
	return false, nil
}

// ListRemotes 列出仓库的所有 remote
func ListRemotes(localPath string) ([]*config.RemoteConfig, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return nil, err
	}

	remotes, err := repo.Remotes()
	if err != nil {
		return nil, err
	}

	configs := make([]*config.RemoteConfig, 0, len(remotes))
	for _, r := range remotes {
		configs = append(configs, r.Config())
	}
	return configs, nil
}
