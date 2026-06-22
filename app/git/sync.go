package git

import (
	"fmt"
	"strings"

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
	// AddedCommits 新增 commit 数（force push 场景可能为负）
	AddedCommits int
	// HeadBefore pull 前 HEAD SHA
	HeadBefore string
	// HeadAfter pull 后 HEAD SHA
	HeadAfter string
	// HeadChanged HEAD SHA 是否变化（force push 场景 commit 数减少但 SHA 变了）
	HeadChanged bool
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

	// fetch（v2.5 修复：同步所有分支）
	// 旧版只 fetch 默认分支，导致其他分支的 commit 看不到。
	err = remote.Fetch(&git.FetchOptions{
		Auth: auth,
		RefSpecs: []config.RefSpec{
			config.RefSpec("+refs/heads/*:refs/remotes/origin/*"),
		},
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

// PullRepo fetch + 更新本地 HEAD + 统计 commit 数变化
//
// v2.4 适配 NoCheckout 模式：
//   - 1. 记录 pull 前 HEAD SHA + commit 数
//   - 2. git fetch origin
//   - 3. 读 origin 的 default branch HEAD（remote tracking ref）
//   - 4. 把本地 HEAD ref 指向新 commit（NoCheckout 模式没 worktree，不能"merge 到工作区"）
//   - 5. AddedCommits = after - before
//   - 6. HeadChanged = beforeSHA != afterSHA（force push 场景 commit 数减少但 SHA 变了）
//
// 跟旧版区别：旧版 `git pull` 在 worktree 里 merge；本应用没 worktree，
// 所以"pull"=fetch + 强制更新 HEAD ref 到远端最新 commit（user 拍板的轻量语义）。
func PullRepo(opts PullOptions) (*PullResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}

	repo, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}

	// 1. 记录 pull 前 HEAD SHA + commit 数
	ref, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("获取 HEAD 失败: %w", err)
	}
	headBefore := ref.Hash().String()
	beforeCount, err := countCommitsReal(repo, ref.Hash())
	if err != nil {
		return nil, fmt.Errorf("统计 commit 数失败: %w", err)
	}

	// 2. fetch
	if _, err := FetchRepo(opts); err != nil {
		return nil, err
	}

	// 3. 重新打开 + 找 origin 的 default branch
	//    注：repo2.Storer 才是 fetch 后的新状态（PlainOpen 有缓存）
	repo2, err := git.PlainOpen(opts.LocalPath)
	if err != nil {
		return nil, fmt.Errorf("重新打开仓库失败: %w", err)
	}

	remoteName := opts.RemoteName
	if remoteName == "" {
		remoteName = "origin"
	}

	// 优先顺序：origin/HEAD → origin/{default branch from HEAD ref name}
	remoteHead, err := resolveOriginHead(repo2, remoteName, ref.Name().Short())
	if err != nil {
		return nil, fmt.Errorf("解析 origin HEAD 失败: %w", err)
	}
	headAfter := remoteHead.String()

	// 4. 更新本地 HEAD ref 指向新 commit
	//    （NoCheckout 模式没 worktree，"pull" 语义就是更新 HEAD 指向）
	if headBefore != headAfter {
		headRef := plumbing.NewHashReference(ref.Name(), remoteHead)
		if err := repo2.Storer.SetReference(headRef); err != nil {
			return nil, fmt.Errorf("更新 HEAD 失败: %w", err)
		}
	}

	// 5. 统计新 commit 数
	afterCount, err := countCommitsReal(repo2, remoteHead)
	if err != nil {
		return nil, fmt.Errorf("统计 commit 数失败: %w", err)
	}

	return &PullResult{
		BeforeCount:  beforeCount,
		AfterCount:   afterCount,
		AddedCommits: afterCount - beforeCount,
		HeadBefore:   headBefore,
		HeadAfter:    headAfter,
		HeadChanged:  headBefore != headAfter,
	}, nil
}

// resolveOriginHead 找 origin 的 default branch HEAD
//
// 步骤：
//   1. 读 refs/remotes/{remote}/HEAD（remote tracking ref，gitea 在 clone 时一般会建）
//   2. 失败则用原 HEAD 的 branch 名（refs/heads/main → origin/main）
func resolveOriginHead(repo *git.Repository, remoteName, currentBranchShort string) (plumbing.Hash, error) {
	storer := repo.Storer

	// 1. 尝试 refs/remotes/{remote}/HEAD
	headRefName := plumbing.NewRemoteHEADReferenceName(remoteName)
	symRef, err := storer.Reference(headRefName)
	if err == nil && symRef.Type() == plumbing.SymbolicReference {
		// refs/remotes/origin/HEAD → "refs/remotes/origin/main"
		target := symRef.Target()
		// 去掉 "refs/remotes/{remote}/" 前缀 → "main"
		short := strings.TrimPrefix(target.String(), "refs/remotes/"+remoteName+"/")
		branchRefName := plumbing.NewRemoteReferenceName(remoteName, short)
		branchRef, err := storer.Reference(branchRefName)
		if err == nil {
			return branchRef.Hash(), nil
		}
	}

	// 2. fallback：用 current branch 名直接拿 origin/{branch}
	branchRefName := plumbing.NewRemoteReferenceName(remoteName, currentBranchShort)
	branchRef, err := storer.Reference(branchRefName)
	if err == nil {
		return branchRef.Hash(), nil
	}

	return plumbing.ZeroHash, fmt.Errorf("找不到 origin 的 default branch（当前 branch=%s）", currentBranchShort)
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
