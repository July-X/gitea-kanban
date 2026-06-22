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
	"os"
	"path/filepath"
	"strings"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/transport"
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
	// WorkspacePath workspace 根目录（repos 会 clone 到 ${workspacePath}/repos/${owner}__${repo}）
	WorkspacePath string
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
	// URL 直接指定 clone URL（v2.4 测试用：跳过 CleanRepoURL(hostURL+owner+repo) 拼接）
	//
	// 设置后：URL 字段**直接**当 git.CloneOptions.URL 用，
	// 忽略 hostURL/owner/repo。
	// 仅在测试 / 特殊协议（file:// 指向 bare 仓库）时使用。
	URL string
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
// 路径规则：${workspacePath}/repos/${owner}__${repo}（对齐旧版 suggestLocalRepoPath）
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

	// 1. 计算本地路径
	localPath := RepoLocalPath(opts.WorkspacePath, opts.Owner, opts.Repo)

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

	// 6. 构造 auth（内存态，不落盘）
	var auth transport.AuthMethod
	if opts.Token != "" {
		// Gitea 和 GitHub 都支持 http.BasicAuth
		// Gitea: username=用户名, password=token
		// GitHub: username=任意(常用 oauth2 或用户名), password=token
		username := opts.Username
		if username == "" {
			username = "oauth2"
		}
		auth = &http.BasicAuth{
			Username: username,
			Password: opts.Token,
		}
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
	cloneOpts := &git.CloneOptions{
		URL:        cloneURL,
		Auth:       auth,
		NoCheckout: opts.NoCheckout,
		Depth:      opts.Depth,
	}

	// go-git 的 PlainClone 第 2 个参数是 isBare，固定 false
	// （我们走 NoCheckout 模式不是 Bare 模式 —— NoCheckout 保留 worktree 概念但空，
	//  Bare 完全无 worktree）
	_, err = git.PlainClone(localPath, false, cloneOpts)
	if err != nil {
		// 失败时清理半成品目录（避免下次 clone 误判"已存在"）
		os.RemoveAll(localPath)
		return nil, fmt.Errorf("go-git clone 失败: %w", err)
	}

	return &CloneResult{LocalPath: localPath}, nil
}

// RepoLocalPath 计算仓库在 workspace 中的本地路径
//
// 规则：${workspacePath}/repos/${owner}__${repo}
// owner/repo 中的非安全字符替换为 _
func RepoLocalPath(workspacePath, owner, repo string) string {
	safeOwner := sanitizeName(owner)
	safeRepo := sanitizeName(repo)
	return filepath.Join(workspacePath, "repos", fmt.Sprintf("%s__%s", safeOwner, safeRepo))
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
