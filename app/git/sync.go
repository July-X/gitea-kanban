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
	// v0.6.3 之前：超大仓库（如 UnrealEngine）全量遍历历史成本过高；UI 更新提示只需要有限窗口。
	// v0.6.3 之后：默认 0（统计全部），有动态加载后用户按需加载更深历史。
	CountLimit int
	// Depth fetch depth 限制（0 = 无限制，拉全量 commit + tree 元数据）。
	//
	// v0.6.3 架构调整：去掉硬编码 depth=2000，由 caller 决定。配合 loadMoreGraph 动态加载，
	// 用户首次可拉全量（元数据 = ~30MB/1000 commits，UnrealEngine 全量 ~28 GB），需要用户主动权衡。
	Depth int
	// SingleBranch true = 只 fetch 默认分支；false = fetch 所有分支（refs/heads/* + refs/tags/*）。
	//
	// v0.6.3 之前：GitHub 仓库硬编码 true（限制大仓库带宽）；v0.6.3 之后由 caller 决定。
	SingleBranch bool
	// NoTags true = 不 fetch tags；false = fetch 所有 tag refs。
	//
	// v0.6.3 之前：GitHub 仓库硬编码 true；v0.6.3 之后由 caller 决定。
	NoTags bool
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

	// v0.6.3 架构调整：去掉 isHugeRepo / depth<=0 硬限制
	//
	// 旧设计（v2.7~v2.9）：GitHub 仓库 + 启发式超大仓库关键词 → 走 gh + --filter=blob:none +
	// depth=2000 保护；避免拉全量元数据卡死前端（UnrealEngine release 中段 1407 lane / 963 flow 渲染
	// 卡死）。
	//
	// 新设计（user 拍板 2026-07-04）：
	//   - 有 loadMoreGraph 动态加载后，前端不再一次性画完整 264k commits，图谱只展示当前可见窗口
	//   - 深度限制由用户掌控——不传 depth 默认走全量，本地拉全部 commit + tree 元数据
	//   - isHugeRepo 启发式不再需要；GitHub / Gitea 统一走 gh + --filter=blob:none（不下载 blob），
	//     depth=0 = 全量 fetch
	//   - 单分支 / NoTags 也由 opts 驱动，不再硬编码
	//
	// 代价：UnrealEngine 全量 fetch ~28 GB 元数据 / 几十分钟；用户在 fetch 阶段需要等。
	// 收益：用户不再被「只能看 2000 条」束缚，看老 commit 自由滚动加载。
	//
	// 边界：fetch 阶段仍走 --filter=blob:none + --no-checkout 保证不下载 blob、不写工作区。
	// Go 端 go-git PlainClone/fetch 本身也支持 depth=0（=无限制）。
	if opts.UseGitHubCLI {
		// GitHub 仓库走 gh + partial clone（v2.9 引入，stable）
		err := FetchWithFilter(opts.LocalPath, opts.Depth, opts.Token)
		if err == nil {
			return &FetchResult{Updated: true}, nil
		}
		return nil, fmt.Errorf("GitHub 仓库走 gh partial fetch 失败: %w", err)
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

	// fetch（默认同步所有分支；opts.SingleBranch=true 时只取默认分支）
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

	// v2.7：添加 2 分钟超时保护（保护 Go 进程不被卡死；用户可接受 fetch 中途失败重试）
	//
	// v0.6.3 架构调整：depth=0 全量 fetch 可能需要几十分钟（UnrealEngine ~28 GB 元数据），
	// 2 分钟不够。改 30 分钟；gh 命令走 nativeGitTimeout=5min 另算（命令本身超时机制）。
	// 超大仓库 fetch 超过 30 分钟视为异常（网络/磁盘问题），用户可重试。
	slog.Default().Info("git fetch 开始", "localPath", opts.LocalPath, "remote", remoteName, "depth", opts.Depth)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
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

	slog.Default().Info("git pull 完成", "localPath", opts.LocalPath, "addedCommits", afterCount-beforeCount, "headChanged", headBefore != headAfter)
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
