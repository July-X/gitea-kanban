package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
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
	if _, err := exec.LookPath("gh"); err != nil {
		return fmt.Errorf("系统未安装 gh 命令，无法快速加载 GitHub 超大仓库提交记录: %w", err)
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
		"--single-branch",    // 只拉取默认分支
		"--no-tags",          // 不拉取 tags
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}

	// 执行命令
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", args...)
	configureGitHubCLIEnv(cmd, token)

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
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	if _, err := exec.LookPath("gh"); err != nil {
		return fmt.Errorf("系统未安装 gh 命令，无法快速加载 GitHub 超大仓库提交记录: %w", err)
	}

	// 检查仓库是否存在
	if _, err := os.Stat(filepath.Join(localPath, ".git")); err != nil {
		return fmt.Errorf("仓库不存在: %w", err)
	}
	if err := cleanupStaleGitLock(localPath, "shallow.lock"); err != nil {
		return err
	}

	// 构造 git fetch 命令
	args := []string{
		"-C", localPath, // 在指定目录执行
		"-c", "credential.helper=!gh auth git-credential",
		"fetch",
		"--filter=blob:none", // 不下载 blob
		"--no-tags",          // 不拉取 tags
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}

	// 执行命令
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	configureGitHubCLIEnv(cmd, token)

	output, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("git fetch 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return fmt.Errorf("git fetch 失败: %w\n输出: %s", err, string(output))
	}

	return nil
}

func configureGitHubCLIEnv(cmd *exec.Cmd, token string) {
	env := os.Environ()
	if token != "" {
		env = append(env, "GH_TOKEN="+token)
	}
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	cmd.Env = env
}
