// Package git 封装 go-git 操作，替代旧版 spawn('git', ...) 子进程调用。
//
// 设计目标（对齐 AGENTS.md 迁移计划 §4）：
//   - 不依赖用户环境 git 二进制（go-git 纯 Go 实现）
//   - clone 带 token 鉴权（Gitea/GitHub 通用）
//   - clone 后不在磁盘留 token（go-git 的 auth 仅内存态）
//   - workspace 路径规则沿用旧版：${workspacePath}/repos/${owner}__${repo}
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
	// Bare 是否裸仓库（默认 false）
	Bare bool
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
func CloneRepo(opts CloneOptions) (*CloneResult, error) {
	if opts.HostURL == "" || opts.Owner == "" || opts.Repo == "" {
		return nil, fmt.Errorf("hostURL, owner, repo 不能为空")
	}
	if opts.WorkspacePath == "" {
		return nil, fmt.Errorf("workspacePath 不能为空")
	}

	// 1. 计算本地路径
	localPath := RepoLocalPath(opts.WorkspacePath, opts.Owner, opts.Repo)

	// 2. 检查是否已存在
	if _, err := os.Stat(filepath.Join(localPath, ".git")); err == nil {
		return nil, fmt.Errorf("路径已存在（看起来是 git 仓库）：%s", localPath)
	}

	// 3. 确保父目录存在
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建父目录失败: %w", err)
	}

	// 4. 构造 clone URL（干净的 URL，不含 token）
	cloneURL := CleanRepoURL(opts.HostURL, opts.Owner, opts.Repo)

	// 5. 构造 auth（内存态，不落盘）
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

	// 6. 执行 clone
	cloneOpts := &git.CloneOptions{
		URL:  cloneURL,
		Auth: auth,
	}

	_, err := git.PlainClone(localPath, opts.Bare, cloneOpts)
	if err != nil {
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
