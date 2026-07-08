// Package git 封装 go-git 操作，替代旧版 spawn('git', ...) 子进程调用。
//
// 设计目标（对齐 AGENTS.md 迁移计划 §4）：
//   - 不依赖用户环境 git 二进制（go-git 纯 Go 实现）
//   - clone 带 token 鉴权（Gitea/GitHub 通用）
//   - clone 后不在磁盘留 token（go-git 的 auth 仅内存态）
//   - workspace 路径规则沿用旧版：${workspacePath}/repos/${owner}__${repo}
//
// v2.4 · user 拍板 2026-06-22 "go-git 同步策略"：
//   - 本应用**只**用 git 元信息（commit / tree / branch / tag）画 Git Graph
//   - **不** clone 工作区文件（README / src / 等 blob）—— 无业务需求
//   - 减小磁盘占用 + clone 速度提升（典型仓库从几十 MB → 几百 KB）
//   - 实现：go-git NoCheckout=true + Bare=false，clone 完后 worktree 空
//     但 .git/objects/ 完整（commits / trees / refs 都在），仍能 LogGraph + GetCommit
//   - 注：NoCheckout 跟 "浅 clone"（Depth=N）不一样 —— 我们要全 commit DAG 画图，
//     所以保留所有 commits，只跳过 blob fetch
package git

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
)

// CloneOptions clone 参数
type CloneOptions struct {
	// Platform 平台类型 "gitea" | "github"
	Platform string
	// HostURL 平台 URL（如 https://gitea.example.com 或 https://github.com）
	HostURL string
	// Owner 仓库 owner
	Owner string
	// Repo 仓库名
	Repo string
	// Token PAT（Gitea）或 Personal Access Token（GitHub）
	Token string
	// Username 用户名（Gitea 用 login；GitHub token 鉴权时可用 "oauth2" 或用户名）
	Username string
	// WorkspacePath workspace 根目录（repos 会 clone 到 ${workspacePath}/repos/${accountUsername}/${owner}__${repo}）
	WorkspacePath string
	// AccountUsername 账号 username（v2.5：用于按账号分层目录）
	//
	// 旧布局：${workspacePath}/repos/${owner}__${repo}
	// 新布局：${workspacePath}/repos/${accountUsername}/${owner}__${repo}
	//
	// 若为空字符串 → fallback 到 ${workspacePath}/repos/${owner}__${repo}（仅供测试）
	AccountUsername string
	// NoCheckout 跳过 worktree 检出（v2.4：只拉元信息不拉文件）
	//
	// 设为 true 后 go-git 走 "info-only" 模式：
	//   - .git/objects/ 完整（commits / trees / blobs 都有）
	//   - 不会 checkout HEAD 到 worktree
	//   - 仍能 LogGraph / GetCommit / ListBranches
	// 默认 true —— 本应用只画 Git Graph，**不**需要工作区文件
	NoCheckout bool
	// Depth 浅 clone 限制（0 = 不限，画 Git Graph 需要全 commit DAG）
	//
	// v2.4：暂不启用浅 clone，原因：
	//   - Git Graph 需要完整 DAG 才能正确画 lane（浅 clone 会丢早期 commit → lane 错位）
	//   - 仓库典型 commit 数 100~10k，全 clone 元信息也只占 ~MB 级（no checkout 后）
	Depth int
	// SingleBranch 只拉默认分支。超大 GitHub 仓库用它避免同步全分支历史。
	SingleBranch bool
	// NoTags 不拉 tag。超大仓库 tag 很多时能明显减少对象和 ref 处理成本。
	NoTags bool
	// URL 直接指定 clone URL（v2.4 测试用：跳过 CleanRepoURL(hostURL+owner+repo) 拼接）
	//
	// 设置后：URL 字段**直接**当 git.CloneOptions.URL 用，
	// 忽略 hostURL/owner/repo。
	// 仅在测试 / 特殊协议（file:// 指向 bare 仓库）时使用。
	URL string
	// Progress 进度回调（v2.6：可选，给前端实时推送百分比）
	//
	// 设为非 nil 后，clone 过程中 go-git 的 sideband 输出会被解析成 SyncProgress 事件
	// 通过本 callback 推给 caller。nil = 不推送（保持原行为，向后兼容）。
	Progress ProgressCallback
	// UseGitHubCLI 使用 gh repo clone + git partial clone 参数。
	//
	// GitHub 超大仓库的核心诉求是快速拿提交记录，不下载 blob；go-git 不支持 blobless clone。
	UseGitHubCLI bool
}

// CloneResult clone 结果
type CloneResult struct {
	// LocalPath 本地仓库路径
	LocalPath string
}

// CloneRepo 使用 go-git clone 仓库到本地 workspace
//
// 鉴权策略（对齐旧版安全要求）：
//   - token 仅用于 clone 时的 HTTP auth（内存态）
//   - go-git 不像 git 二进制那样在 .git/config 留 URL（无 set-url 需求）
//   - clone 完成后 token 不落盘
//
// 路径规则（v2.5）：
//   - 首选：${workspacePath}/repos/${accountUsername}/${owner}__${repo}
//   - 兜底（AccountUsername 为空）：${workspacePath}/repos/${owner}__${repo}
//     仅在测试场景使用——生产代码必须传 accountUsername
//
// 并发安全：使用 per-repo 锁避免两个 CloneRepo 同时 clone 同一仓库时竞态
// （os.Stat + PlainClone 不是原子的，可能产生损坏仓库）
func CloneRepo(opts CloneOptions) (*CloneResult, error) {
	if opts.URL == "" && (opts.HostURL == "" || opts.Owner == "" || opts.Repo == "") {
		return nil, fmt.Errorf("URL 或 hostURL+owner+repo 至少填一个")
	}
	if opts.WorkspacePath == "" {
		return nil, fmt.Errorf("workspacePath 不能为空")
	}

	// 1. 计算本地路径（v2.5：按账号分层）
	var localPath string
	if opts.AccountUsername != "" {
		localPath = RepoLocalPathForAccount(opts.WorkspacePath, opts.AccountUsername, opts.Owner, opts.Repo)
	} else {
		// 兜底（旧布局）：测试场景 + 防御
		localPath = RepoLocalPath(opts.WorkspacePath, opts.Owner, opts.Repo)
	}

	// 2. 拿 per-repo 锁（避免并发 clone 同一仓库竞态）
	unlock, err := lockPath(localPath)
	if err != nil {
		return nil, err
	}
	defer unlock()

	// 3. 检查是否已存在
	if RepoExists(localPath) {
		return nil, fmt.Errorf("路径已存在（看起来是 git 仓库）：%s", localPath)
	}

	// 4. 确保父目录存在
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建父目录失败: %w", err)
	}

	// 5. 构造 clone URL（v2.4：opts.URL 优先 → 测试可直传 file://bare 路径；
	//    生产代码用 CleanRepoURL 拼接 https://host/owner/repo.git）
	cloneURL := opts.URL
	if cloneURL == "" {
		if opts.HostURL == "" || opts.Owner == "" || opts.Repo == "" {
			return nil, fmt.Errorf("hostURL, owner, repo 不能为空")
		}
		cloneURL = CleanRepoURL(opts.HostURL, opts.Owner, opts.Repo)
	}

	// 6. 构造 auth（v2.8：优先 SSH，回退 HTTPS）
	//
	// 对于 GitHub 仓库，自动尝试使用 SSH 认证（更稳定，适合大仓库）
	// 检测 ~/.ssh/id_ed25519 或 ~/.ssh/id_rsa（无 passphrase）
	// SSH 失败时自动回退到 HTTPS + token
	auth, finalURL, authMethod := BuildAuth(cloneURL, opts.Username, opts.Token)

	// v0.6.3 架构调整：去掉 isHugeRepo 启发式 + depth<=0 硬限制
	//
	// 旧设计（v2.9）：GitHub 仓库 + 启发式超大仓库关键词（unreal/chromium/linux/webkit）→ 走 gh +
	// partial clone (--filter=blob:none) + depth>0 保护；避免下载全量 blob + 元数据。
	//
	// 新设计（user 拍板 2026-07-04）：
	//   - GitHub 仓库始终走 gh + --filter=blob:none（稳定 + 避免下载 blob）
	//   - depth=0 走全量元数据（克隆所有 commit + tree 元数据，不下载 blob）
	//   - 代价：UnrealEngine 全量 ~28 GB 元数据 / 几十分钟 clone 时间
	//
	// v0.6.3 不再需要 isHugeRepo 启发式判断（caller 已决定 opts.Depth / opts.UseGitHubCLI）。
	// CloneWithFilter 已支持 depth=0（不传 --depth 参数等于无限制）。
	if opts.UseGitHubCLI {
		// GitHub 仓库走 gh + partial clone（始终启用，确保 blobless + NoCheckout）
		// 即使 opts.Depth=0 也走这里：gh 会透传所有 git 参数给底层 git clone
		nativeURL := finalURL
		nativeToken := opts.Token

		// SSH 模式不需要 token
		if authMethod == AuthMethodSSH {
			nativeToken = ""
		}

		err = CloneWithFilter(nativeURL, localPath, opts.Depth, nativeToken)
		if err == nil {
			// gh + partial clone 成功，直接返回
			return &CloneResult{LocalPath: localPath}, nil
		}
		return nil, fmt.Errorf("GitHub 仓库走 gh partial clone 失败: %w", err)
	}

	// 7. 执行 clone（v2.4 轻量模式：NoCheckout=true 跳过工作区文件）
	//
	// go-git 的 NoCheckout 选项：
	//   - .git/objects/ 仍拉全（commits + trees + blobs 都有）
	//   - 不会创建 worktree 里的文件（README / src / ...）
	//   - 仍能调 LogGraph / GetCommit 画 Git Graph
	// 节省磁盘：典型仓库从几十 MB → 几百 KB
	//
	// 未来如果用户需要"在本地看代码"，可加个开关走 PlainClone 默认（带工作区），
	// 但当前业务用不到。
	//
	// v2.5 修复：同步所有远程分支。
	// 不用 Mirror：Mirror 会强制创建 bare 仓库，后续 HEAD/remote refs 语义和普通仓库不一致。
	// go-git 默认 refspec 已是 refs/heads/* -> refs/remotes/origin/*，足够 Git Graph 使用。
	cloneOpts := &git.CloneOptions{
		URL:        finalURL,
		Auth:       auth,
		NoCheckout: opts.NoCheckout,
		Depth:      opts.Depth,
		// ReferenceName=HEAD + SingleBranch 表示只取远端默认分支。
		ReferenceName: plumbing.HEAD,
		SingleBranch:  opts.SingleBranch,
		// v2.6：progress 回调（go-git sideband → 前端）
		//
		// opts.Progress 为 nil 时不设这一字段（go-git 会用默认空 writer，无 sideband 输出）
		// opts.Progress 非 nil 时包成 sideband.Progress（实现 io.Writer），
		// 每次 sideband 行触发一次 ParseProgress → cb(SyncProgress)
	}
	if opts.NoTags {
		cloneOpts.Tags = git.NoTags
	}
	if opts.Progress != nil {
		cloneOpts.Progress = NewSidebandWriter(SafeWrap(opts.Progress))
	}

	// go-git 的 PlainClone 第 2 个参数是 isBare，固定 false
	// （我们走 NoCheckout 模式不是 Bare 模式 —— NoCheckout 保留 worktree 概念但空，
	//  Bare 完全无 worktree）
	slog.Default().Info("git clone 开始",
		"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
		"depth", opts.Depth, "singleBranch", opts.SingleBranch, "noTags", opts.NoTags,
	)
	start := time.Now()
	_, err = git.PlainClone(localPath, false, cloneOpts)
	duration := time.Since(start)
	if err != nil {
		// v2.8：SSH 失败时自动回退到 HTTPS
		if authMethod == AuthMethodSSH {
			// SSH 失败，使用 HTTPS 重试
			username := opts.Username
			if username == "" {
				username = "oauth2"
			}
			httpAuth := &http.BasicAuth{
				Username: username,
				Password: opts.Token,
			}
			cloneOpts.URL = cloneURL
			cloneOpts.Auth = httpAuth
			slog.Default().Warn("git clone SSH 失败，回退 HTTPS",
				"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
			)
			httpsStart := time.Now()
			_, err = git.PlainClone(localPath, false, cloneOpts)
			httpsDuration := time.Since(httpsStart)
			if err != nil {
				slog.Default().Error("git clone HTTPS 回退也失败",
					"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
					"ms", httpsDuration.Milliseconds(),
					"err", err.Error(),
				)
				// 失败时清理半成品目录（避免下次 clone 误判"已存在"）
				os.RemoveAll(localPath)
				return nil, fmt.Errorf("go-git clone 失败: %w", err)
			}
		} else {
			slog.Default().Error("git clone 失败",
				"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
				"ms", duration.Milliseconds(),
				"auth", authMethod,
				"err", err.Error(),
			)
			// 失败时清理半成品目录（避免下次 clone 误判"已存在"）
			os.RemoveAll(localPath)
			return nil, fmt.Errorf("go-git clone 失败: %w", err)
		}
	}

	// SSH 回退成功 / 正常成功都记完成日志
	if authMethod == AuthMethodSSH {
		slog.Default().Info("git clone 完成（SSH→HTTPS 回退）",
			"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
			"ms", duration.Milliseconds(),
		)
	} else {
		slog.Default().Info("git clone 完成",
			"platform", opts.Platform, "owner", opts.Owner, "repo", opts.Repo,
			"ms", duration.Milliseconds(),
		)
	}

	return &CloneResult{LocalPath: localPath}, nil
}

// AccountDirName 账号目录名 = sanitize(username)
//
// 命名规则（v2.5 · user 拍板 2026-06-22）：
//   - 用 account.Username（login），不用 account.ID（UUID）
//   - 理由：前端 UI 展示的就是 username，用户从路径能直接看懂"这个仓库属于哪个账号"
//   - 重命名账号时同步搬家（一次性 rename）也是合理代价
func AccountDirName(accountUsername string) string {
	if accountUsername == "" {
		return "_unknown"
	}
	return sanitizeName(accountUsername)
}

// RepoLocalPath 计算仓库在 workspace 中的本地路径（旧版布局）
//
// 规则（v2.4 之前）：${workspacePath}/repos/${owner}__${repo}
//
// v2.5 起仅在迁移逻辑 / 旧数据回退场景使用，新代码一律走 RepoLocalPathForAccount。
// 保留这个函数的原因是迁移期 + 测试可能需要直接拼路径，避免重复计算逻辑。
func RepoLocalPath(workspacePath, owner, repo string) string {
	safeOwner := sanitizeName(owner)
	safeRepo := sanitizeName(repo)
	return filepath.Join(workspacePath, "repos", fmt.Sprintf("%s__%s", safeOwner, safeRepo))
}

// RepoLocalPathForAccount 按账号隔离的仓库本地路径（v2.5 · user 拍板 2026-06-22）
//
// 规则：
//   - ${workspacePath}/repos/${username}/${owner}__${repo}
//   - username 来自 GiteaAccount.Username（对齐前端展示 + 零术语"账号"概念）
//
// 为什么按账号再做一层：
//   - 多账号场景：用户在不同平台（Gitea 实例 / GitHub）有同名用户名会撞目录名
//     （如 July-X 在 gitea.example.com 和 github.com 都同名 → 物理隔离避免冲突）
//   - 删账号 / 切换平台：清账号目录即丢所有本地仓库，不用按 project 一个个删
//
// 沙箱校验：所有 caller 必须保证 accountDir 在 ${workspacePath}/repos/ 下，否则
// RepoExists 等下游函数无法识别 git 仓库。
func RepoLocalPathForAccount(workspacePath, accountUsername, owner, repo string) string {
	safeAccount := sanitizeName(accountUsername)
	safeOwner := sanitizeName(owner)
	safeRepo := sanitizeName(repo)
	return filepath.Join(
		workspacePath, "repos", safeAccount,
		fmt.Sprintf("%s__%s", safeOwner, safeRepo),
	)
}

// CleanRepoURL 构造干净的仓库 URL（不含 token）
//
// https://gitea.example.com/owner/repo.git
func CleanRepoURL(hostURL, owner, repo string) string {
	base := strings.TrimRight(hostURL, "/")
	return fmt.Sprintf("%s/%s/%s.git", base, owner, repo)
}

// sanitizeName 替换文件名中的不安全字符
func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// RepoExists 检查本地仓库路径是否已存在（含 .git 目录）
func RepoExists(localPath string) bool {
	if _, err := os.Stat(filepath.Join(localPath, ".git")); err == nil {
		return true
	}
	// 裸仓库可能没有 .git 目录，检查 HEAD + objects
	if _, err := os.Stat(filepath.Join(localPath, "HEAD")); err == nil {
		if _, err := os.Stat(filepath.Join(localPath, "objects")); err == nil {
			return true
		}
	}
	return false
}
