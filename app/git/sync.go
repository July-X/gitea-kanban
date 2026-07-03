package git

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/plumbing/transport"
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
	// CountLimit commit 计数上限（0 = 精确统计全部）。
	//
	// 超大仓库（如 UnrealEngine）全量遍历历史成本过高；UI 更新提示只需要有限窗口。
	CountLimit int
	// Depth/SingleBranch/NoTags 用于超大仓库更新：只取默认分支最近窗口。
	Depth        int
	SingleBranch bool
	NoTags       bool
	// Progress 进度回调（v2.6：可选，给前端实时推送百分比）
	//
	// fetch 阶段 go-git 的 sideband 输出会被解析成 SyncProgress 事件
	// 通过本 callback 推给 caller。nil = 不推送（向后兼容）。
	Progress ProgressCallback
	// UseGitHubCLI 使用 gh credential helper + git partial fetch。
	UseGitHubCLI bool
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
//
// v2.7 超时保护：超大仓库（如 UnrealEngine）可能长时间卡住，
// 添加 2 分钟超时避免无限等待。
//
// v2.9：超大仓库使用 gh credential helper + git partial fetch
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

	// 获取 remote URL
	remoteConfig := remote.Config()
	var remoteURL string
	if len(remoteConfig.URLs) > 0 {
		remoteURL = remoteConfig.URLs[0]
	}

	// v2.9：超大仓库优化 - 使用 gh credential helper + git partial fetch
	// 检测是否是超大仓库（通过 URL 判断）
	isHugeRepo := strings.Contains(strings.ToLower(remoteURL), "unreal") ||
		strings.Contains(strings.ToLower(remoteURL), "chromium") ||
		strings.Contains(strings.ToLower(remoteURL), "linux") ||
		strings.Contains(strings.ToLower(remoteURL), "webkit")

	if opts.UseGitHubCLI || (isHugeRepo && opts.Depth > 0) {
		if opts.Depth <= 0 {
			return nil, fmt.Errorf("GitHub CLI blobless fetch 需要 depth > 0")
		}
		// GitHub 仓库必须走 gh credential helper + partial fetch；go-git 不支持 blobless，
		// 回退会重新下载大量对象，违背“快速获得提交记录”的核心诉求。
		err := FetchWithFilter(opts.LocalPath, opts.Depth, opts.Token)
		if err == nil {
			return &FetchResult{Updated: true}, nil
		}
		return nil, fmt.Errorf("GitHub 仓库需要使用 gh 的 blobless fetch，但执行失败: %w", err)
	}

	// v2.8：构造 auth（不改变 URL，使用仓库现有的 remote URL）
	var auth transport.AuthMethod
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

	refSpecs := []config.RefSpec{config.RefSpec("+refs/heads/*:refs/remotes/origin/*")}
	if opts.SingleBranch {
		refSpecs = []config.RefSpec{config.RefSpec("+HEAD:refs/remotes/origin/HEAD")}
	}

	// fetch（默认同步所有分支；超大仓库可走 SingleBranch 只取默认分支）
	fetchOpts := &git.FetchOptions{
		Auth:     auth,
		RefSpecs: refSpecs,
		Depth:    opts.Depth,
	}
	if opts.NoTags {
		fetchOpts.Tags = git.NoTags
	}
	if opts.Progress != nil {
		fetchOpts.Progress = NewSidebandWriter(SafeWrap(opts.Progress))
	}

	// v2.7：添加 2 分钟超时保护（超大仓库如 UnrealEngine 可能卡很久）
	slog.Default().Info("git fetch 开始", "localPath", opts.LocalPath, "remote", remoteName, "depth", opts.Depth)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	start := time.Now()
	err = remote.FetchContext(ctx, fetchOpts)
	duration := time.Since(start)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			slog.Default().Warn("git fetch 超时", "localPath", opts.LocalPath, "remote", remoteName, "ms", duration.Milliseconds())
			return nil, fmt.Errorf("同步超时（2分钟）：此仓库可能过大，建议减少 Depth 或使用在线版本查看")
		}
		if err == git.NoErrAlreadyUpToDate {
			slog.Default().Info("git fetch 已是最新", "localPath", opts.LocalPath, "remote", remoteName, "ms", duration.Milliseconds())
			return &FetchResult{Updated: false}, nil
		}
		slog.Default().Error("git fetch 失败", "localPath", opts.LocalPath, "remote", remoteName, "ms", duration.Milliseconds(), "err", err.Error())
		return nil, fmt.Errorf("fetch 失败: %w", err)
	}

	slog.Default().Info("git fetch 完成", "localPath", opts.LocalPath, "remote", remoteName, "ms", duration.Milliseconds())
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
	if errors.Is(err, plumbing.ErrObjectNotFound) {
		return count, nil
	}
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

	// 1. 记录 pull 前 HEAD SHA + commit 数。
	// 兼容历史 Mirror/中断 clone 产生的断 HEAD：先 fetch，再用远端 HEAD 修复本地 HEAD。
	ref, headRefName, currentBranchShort, err := currentHeadInfo(repo)
	headBefore := ""
	beforeCount := 0
	if err == nil {
		headBefore = ref.Hash().String()
		beforeCount, err = countCommitsWithLimit(repo, ref.Hash(), opts.CountLimit)
		if err != nil {
			return nil, fmt.Errorf("统计 commit 数失败: %w", err)
		}
	}

	// 2. fetch
	slog.Default().Info("git pull 开始", "localPath", opts.LocalPath)
	if _, err := FetchRepo(opts); err != nil {
		return nil, err
	}
	slog.Default().Info("git pull fetch 阶段完成", "localPath", opts.LocalPath)

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

	// 优先顺序：origin/HEAD → origin/{default branch from HEAD ref name} → 任一远端/本地分支
	remoteHead, err := resolveOriginHead(repo2, remoteName, currentBranchShort)
	if err != nil {
		return nil, fmt.Errorf("解析 origin HEAD 失败: %w", err)
	}
	headAfter := remoteHead.String()

	// 4. 更新本地 HEAD ref 指向新 commit
	//    （NoCheckout 模式没 worktree，"pull" 语义就是更新 HEAD 指向）
	if headBefore != headAfter {
		headRef := plumbing.NewHashReference(headRefName, remoteHead)
		if err := repo2.Storer.SetReference(headRef); err != nil {
			return nil, fmt.Errorf("更新 HEAD 失败: %w", err)
		}
	}

	// 5. 统计新 commit 数
	afterCount, err := countCommitsWithLimit(repo2, remoteHead, opts.CountLimit)
	if err != nil {
		return nil, fmt.Errorf("统计 commit 数失败: %w", err)
	}

	slog.Default().Info("git pull 完成", "localPath", opts.LocalPath, "addedCommits", afterCount - beforeCount, "headChanged", headBefore != headAfter)
	return &PullResult{
		BeforeCount:  beforeCount,
		AfterCount:   afterCount,
		AddedCommits: afterCount - beforeCount,
		HeadBefore:   headBefore,
		HeadAfter:    headAfter,
		HeadChanged:  headBefore != headAfter,
	}, nil
}

func countCommitsWithLimit(repo *git.Repository, from plumbing.Hash, limit int) (int, error) {
	if limit <= 0 {
		return countCommitsReal(repo, from)
	}
	iter, err := repo.Log(&git.LogOptions{From: from})
	if err != nil {
		return 0, err
	}

	count := 0
	err = iter.ForEach(func(c *object.Commit) error {
		count++
		if count >= limit {
			return storer.ErrStop
		}
		return nil
	})
	if errors.Is(err, plumbing.ErrObjectNotFound) {
		return count, nil
	}
	if err != nil && err != storer.ErrStop {
		return 0, err
	}
	return count, nil
}

func currentHeadInfo(repo *git.Repository) (*plumbing.Reference, plumbing.ReferenceName, string, error) {
	head, err := repo.Head()
	if err == nil {
		return head, head.Name(), head.Name().Short(), nil
	}
	headRef, refErr := repo.Storer.Reference(plumbing.HEAD)
	if refErr == nil && headRef.Type() == plumbing.SymbolicReference {
		target := headRef.Target()
		return nil, target, target.Short(), err
	}
	return nil, plumbing.NewBranchReferenceName("master"), "master", err
}

// resolveOriginHead 找 origin 的 default branch HEAD
//
// 步骤：
//  1. 读 refs/remotes/{remote}/HEAD（remote tracking ref，gitea 在 clone 时一般会建）
//  2. 失败则用原 HEAD 的 branch 名（refs/heads/main → origin/main）
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
	if currentBranchShort != "" {
		branchRefName := plumbing.NewRemoteReferenceName(remoteName, currentBranchShort)
		branchRef, err := storer.Reference(branchRefName)
		if err == nil {
			return branchRef.Hash(), nil
		}
		localRefName := plumbing.NewBranchReferenceName(currentBranchShort)
		localRef, err := storer.Reference(localRefName)
		if err == nil {
			return localRef.Hash(), nil
		}
	}

	var first plumbing.Hash
	refs, err := repo.References()
	if err == nil {
		_ = refs.ForEach(func(ref *plumbing.Reference) error {
			if first != plumbing.ZeroHash || ref.Type() != plumbing.HashReference {
				return nil
			}
			if ref.Name().IsRemote() || ref.Name().IsBranch() {
				first = ref.Hash()
			}
			return nil
		})
	}
	if first != plumbing.ZeroHash {
		return first, nil
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
