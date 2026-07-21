package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/ipc"
)

const nativeGitTimeout = 5 * time.Minute

// CloneWithFilter 使用 gh repo clone 执行 partial clone（只拉取 commits，不拉取 blobs）
//
// v2.9：go-git 不支持 --filter=blob:none，对于超大仓库使用 git partial clone
// v2.10：GitHub 仓库要求本机安装 gh，由 gh 负责 GitHub 认证链路
//
// 使用场景：
//   - UnrealEngine 等超大仓库
//   - go-git 超时或性能不满足需求
//
// 参数：
//   - url: 仓库 URL（支持 HTTPS 或 SSH）
//   - localPath: 本地路径
//   - depth: 深度限制
//   - token: HTTPS 认证 token（可选，SSH 不需要）
//
// 限制：
//   - 需要系统安装 gh（gh 内部调用 git）
//   - 不支持进度回调（无法实时显示百分比）
func CloneWithFilter(url, localPath string, depth int, token string) error {
	if _, err := gitbinary.ResolveGhPath(); err != nil {
		// v0.7.21：gh 未找到时返回结构化 IpcError，前端引导用户安装
		var ghNotFound *gitbinary.GhNotFoundError
		if errors.As(err, &ghNotFound) {
			return ipc.NewGhNotInstalled(ghNotFound.Cause)
		}
		return ipc.NewGhNotInstalled(err.Error())
	}

	// 确保父目录存在
	parentDir := filepath.Dir(localPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("创建父目录失败: %w", err)
	}

	// 构造 gh repo clone 命令；-- 之后的参数会透传给底层 git clone。
	args := []string{
		"repo",
		"clone",
		url,
		localPath,
		"--",
		"--filter=blob:none", // 关键：不下载 blob（文件内容）
		"--no-checkout",      // 不 checkout 到工作区
		"--no-single-branch", // depth 默认隐含 single-branch；这里要保留所有分支 refs
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}

	// 执行命令
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	// v0.4.0：gh 调用同样需要 GH_TOKEN env；抽 helper（与 gitbinary.RunGitWithEnv 同样的 env 注入模式）
	configureGHCommandEnv(cmd, token)

	// 捕获输出和错误
	output, err := cmd.CombinedOutput()
	if err != nil {
		// 清理失败的克隆
		os.RemoveAll(localPath)
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("gh repo clone 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return fmt.Errorf("gh repo clone 失败: %w\n输出: %s", err, string(output))
	}

	// v0.7.22：gh clone 退出只代表 refs 拉完，commit 对象在 blobless 模式下懒加载。
	// 等待 commit DAG 真正可用再返回，避免前端 StageDone 后 loadGraph() 拿到 truncated=true。
	if err := waitForCommitsAvailable(localPath, 20*time.Minute); err != nil {
		return fmt.Errorf("gh clone 后等待 commit 可用失败: %w", err)
	}
	return nil
}

// FetchWithFilter 使用 gh credential helper + git partial fetch（只拉取新的 commits）
//
// v2.9：对已存在的仓库执行 fetch，使用 --filter=blob:none 避免下载文件内容
//
// 参数：
//   - localPath: 本地仓库路径
//   - depth: 深度限制（可选）
//
// 限制：
//   - 需要系统安装 gh 和 git
//   - 仓库必须已经存在
func FetchWithFilter(localPath string, depth int, token string) error {
	unlock, err := lockPath(localPath)
	if err != nil {
		return err
	}
	defer unlock()

	// 检查 git 命令是否可用
	if _, err := gitbinary.ResolveGitBinaryPath(""); err != nil {
		return fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	if _, err := gitbinary.ResolveGhPath(); err != nil {
		var ghNotFound *gitbinary.GhNotFoundError
		if errors.As(err, &ghNotFound) {
			return ipc.NewGhNotInstalled(ghNotFound.Cause)
		}
		return ipc.NewGhNotInstalled(err.Error())
	}

	// 检查仓库是否存在（兼容 bare 布局）
	// 旧代码只 os.Stat(.git)，但 gh blobless clone / 旧版 mirror clone 产出的是
	// bare 仓库（bare=true，无 .git 子目录，HEAD+objects 直接在根目录），
	// 导致 PullRepo 的 FetchWithFilter 误报"仓库不存在"→ 同步按钮报错。
	// RepoExists 已兼容两种布局（.git 子目录 → HEAD+objects 回退），与
	// ascii_graph.go 的检测逻辑对齐。
	if !RepoExists(localPath) {
		return fmt.Errorf("仓库不存在: %s（既无 .git 目录，也无 HEAD/objects，可能 clone 未完成）", localPath)
	}
	if err := cleanupStaleGitLock(localPath, "shallow.lock"); err != nil {
		return err
	}

	remotes, err := listGitRemotes(localPath)
	if err != nil {
		return err
	}
	if len(remotes) == 0 {
		return fmt.Errorf("仓库没有配置远程: %s", localPath)
	}
	for _, remote := range remotes {
		if err := fetchRemoteWithFilter(localPath, remote, depth, token); err != nil {
			return err
		}
	}
	return nil
}

// EnsureRemote 确保仓库存在指定 remote；URL 变化时更新。
func EnsureRemote(localPath, name, remoteURL string) error {
	name = strings.TrimSpace(name)
	remoteURL = strings.TrimSpace(remoteURL)
	if name == "" || remoteURL == "" {
		return fmt.Errorf("remote 名称和 URL 不能为空")
	}
	if !RepoExists(localPath) {
		return fmt.Errorf("仓库不存在: %s", localPath)
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return fmt.Errorf("gitbinary: %w", err)
	}

	getOut, err := gitbinary.RunGit(ctx, bin, localPath, "remote", "get-url", name)
	if err == nil {
		if strings.TrimSpace(string(getOut)) == remoteURL {
			return nil
		}
		setOut, setErr := gitbinary.RunGit(ctx, bin, localPath, "remote", "set-url", name, remoteURL)
		if setErr != nil {
			return fmt.Errorf("更新 remote %s 失败: %w\n输出: %s", name, setErr, string(setOut))
		}
		return nil
	}

	addOut, addErr := gitbinary.RunGit(ctx, bin, localPath, "remote", "add", name, remoteURL)
	if addErr != nil {
		return fmt.Errorf("添加 remote %s 失败: %w\n输出: %s", name, addErr, string(addOut))
	}
	return nil
}

func listGitRemotes(localPath string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return nil, fmt.Errorf("gitbinary: %w", err)
	}
	out, err := gitbinary.RunGit(ctx, bin, localPath, "remote")
	if err != nil {
		return nil, fmt.Errorf("读取 remote 列表失败: %w", err)
	}
	return strings.Fields(string(out)), nil
}

// repoIsShallow 检测本地仓库是否为 shallow clone（用于判断是否需要 --unshallow）
//
// v0.6.3 根因修复：UnrealEngine 测试仓库滚不到底报「加载更多不生效」。
//
//	背景：gh repo clone 初始化时传了 --no-single-branch，但 gh 内部仍会按
//	single-branch 初始化 remote.origin.fetch（+refs/heads/release），而且
//	本机仓库 .git/shallow 有 78 条记录——clone 阶段就是 shallow clone。
//	用户后续 fetch 阶段，调用方传 depth=0 期望「拉全量」，但 git fetch
//	在 shallow repo 状态下默认不会 deepen（必须显式 --unshallow），
//	导致本地 commit 数永远停在浅克隆的状态。
//
// 检测方法：.git/shallow 文件存在即 shallow clone（兼容 bare 仓库直接 shallow）。
func repoIsShallow(localPath string) bool {
	for _, p := range []string{
		filepath.Join(localPath, ".git", "shallow"),
		filepath.Join(localPath, "shallow"),
	} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

func fetchRemoteWithFilter(localPath, remote string, depth int, token string) error {
	args := []string{
		"-c", "credential.helper=!gh auth git-credential",
		"fetch",
		"--filter=blob:none", // 不下载 blob
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	} else if repoIsShallow(localPath) {
		// v0.6.3 修复：depth=0（无限制）+ shallow repo → 显式 --unshallow
		// git fetch 在 shallow repo 默认不 deepen；不传 --unshallow 会导致
		// fetch 「看起来成功」但本地 commit 数永远停在浅克隆状态（UnrealEngine
		// 测试仓库 4492 commits，GitHub 实际 264k）。如果仓库不是 shallow，
		// 下面的 --unshallow 不传即可，避免 git 报「not a shallow repository」。
		args = append(args, "--unshallow")
	}

	args = append(args,
		remote,
		fmt.Sprintf("+refs/heads/*:refs/remotes/%s/*", remote),
		"+refs/tags/*:refs/tags/*",
	)

	// 执行命令
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return fmt.Errorf("gitbinary: %w", err)
	}
	envVars := map[string]string{}
	if token != "" {
		envVars["GH_TOKEN"] = token
	}
	output, err := gitbinary.RunGitWithEnv(ctx, bin, localPath, envVars, args...)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("git fetch 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return fmt.Errorf("git fetch %s 失败: %w\n输出: %s", remote, err, string(output))
	}

	// v0.7.22：fetch 成功后 commit 对象可能还在后台深化（blobless 懒加载）。
	// 等待 commit DAG 可用，避免前端 StageDone 后 loadGraph() 拿到 truncated=true。
	if err := waitForCommitsAvailable(localPath, 20*time.Minute); err != nil {
		return fmt.Errorf("fetch 后等待 commit 可用失败: %w", err)
	}
	return nil
}

// waitForCommitsAvailable 轮询 git rev-list --all --count，直到 commit 数 > 0 才返回。
//
// 用于 gh partial clone / git fetch blobless 场景：命令退出只代表 refs 拉完，
// commit 对象是懒加载的（git 后台异步下载 commit 对象）。
// 必须等待 commit DAG 真正可用后再返回，否则前端 loadGraph() 拿到 truncated=true。
//
// 超大仓库（UnrealEngine 264k commits）懒加载可能持续 10+ 分钟，timeout 设为 20 分钟。
//
// 轮询间隔 2 秒：太短会过度消耗 git rev-list CPU（每次都要读 .git/objects）；
// 太长会让 StageDone 发出后用户感觉"卡住"。2 秒是经验值。
//
// 注：本函数只对 git CLI / gh CLI 路径生效（native.go 内的 CloneWithFilter /
// fetchRemoteWithFilter 调用方）。Gitea 路径走 go-git PlainClone + sideband writer
// （app/git/clone.go / app/git/sync.go），不经过本函数——Gitea 路径的同类问题由
// commit 0cc8d10 修复（StageDone 从 FetchRepo 末尾挪到 PullRepo 末尾）。
func waitForCommitsAvailable(localPath string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return fmt.Errorf("gitbinary: %w", err)
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("等待 commit 可用超时（%s）", timeout)
		case <-ticker.C:
			cmd := exec.CommandContext(ctx, bin, "-C", localPath, "rev-list", "--all", "--count")
			out, err := cmd.Output()
			if err != nil {
				// rev-list 失败（可能 .git 还没初始化完成 / lock 文件存在 / 临时错误）
				// 不立即放弃，2 秒后重试
				continue
			}
			count := strings.TrimSpace(string(out))
			if count != "" && count != "0" {
				return nil
			}
		}
	}
}

// gitClone 用 git CLI clone 仓库（blobless + NoCheckout）
//
// v0.7.22 替代 go-git.PlainClone 的统一方案：
//   - git CLI 对 HTTP progress 支持更好（sideband progress 输出稳定）
//   - Gitea HTTPS 走此路径，行为一致 + blobless 省 28GB blob 下载
//   - git clone --filter=blob:none --no-checkout --no-single-branch
//
// 参数：
//   - url: 仓库 URL（https / file）
//   - localPath: 本地目标路径
//   - depth: 深度限制（0 = 无限制）
//   - token: HTTPS 认证 token（空 = 不传，依赖 ~/.netrc 或 SSH）
//   - progress: 可选 progress 回调（nil = 静默，向后兼容）
//
// 鉴权策略：
//   - HTTPS + token：用 -c credential.helper=!f("...") 注入 token
//   - SSH：依赖 ~/.ssh/config + ssh-agent（不传 token，不做 key 检测）
//   - file://：无鉴权
//
// 失败模式：
//   - 超时（5 分钟）：返回 timeout 错误
//   - git 退出非 0：返回 CombinedOutput 内容
//   - 失败时清理半成品目录（避免下次 clone 误判"已存在"）
//
// 注：本 helper 只支持 HTTPS / file，**不**翻译 go-git 的 `transport.AuthMethod`
// 到 git CLI 的 SSH key 路径。SSH 鉴权的 Gitea 仓库仍走原 go-git 链路
// （app/git/clone.go:PlainClone + SSH 失败回退 HTTPS）。
func gitClone(url, localPath string, depth int, token string, progress ProgressCallback) error {
	parentDir := filepath.Dir(localPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("创建父目录失败: %w", err)
	}

	args := []string{
		"clone",
		"--filter=blob:none", // 关键：不下载 blob（文件内容）
		"--no-checkout",      // 不 checkout 到工作区
		"--no-single-branch", // 保留所有分支 refs
	}
	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}
	args = append(args, url, localPath)

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()

	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return fmt.Errorf("gitbinary: %w", err)
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = "" // 不预设 Dir——git clone 的 <local_path> 参数会自己处理

	// env: token 注入用 credential helper（一次性 inline，不污染 ~/.gitconfig）
	env := os.Environ()
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	if token != "" && !strings.HasPrefix(url, "file://") && !strings.HasPrefix(url, "git@") {
		// HTTPS 鉴权：用一次性 credential helper（不写 .gitconfig）
		// helper 格式：!cmd 输出 username=xxx / password=xxx 行
		// 用 single-quote 包裹避免 password 含特殊字符被 shell 解析
		escaped := strings.ReplaceAll(token, "'", "'\\''")
		helper := fmt.Sprintf("!f() { echo username=oauth2; echo password='%s'; }; f", escaped)
		env = append(env, "GIT_ASKPASS=true", "GIT_CONFIG_COUNT=1",
			"credential.helper="+helper)
	}
	cmd.Env = env

	// progress 回调：把 git CLI 的 stderr 输出包装成 io.Writer，
	// 走 ParseProgress → cb(SyncProgress)。格式仿 go-git sideband。
	// git CLI 的 sideband 输出格式与 go-git 类似（"Receiving objects: N% (cur/total)\r"）
	if progress != nil {
		cmd.Stderr = NewSidebandWriter(SafeWrap(progress))
		cmd.Stdout = NewSidebandWriter(SafeWrap(progress))
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		// 清理失败的克隆
		os.RemoveAll(localPath)
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("git clone 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return fmt.Errorf("git clone 失败: %w\n输出: %s", err, string(output))
	}
	return nil
}

// configureGHCommandEnv 给 gh 命令注入 env（GH_TOKEN + 防认证锁）。
//
// v0.4.0：原名 configureGitHubCLIEnv（2.10 引入），重命名后语义更明确（与
// gitbinary.RunGitWithEnv 同等职能，但仅用于 gh CLI 调用；gh 不在 v0.4.0 内嵌范围）。
func configureGHCommandEnv(cmd *exec.Cmd, token string) {
	env := os.Environ()
	if token != "" {
		env = append(env, "GH_TOKEN="+token)
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	cmd.Env = env
}
