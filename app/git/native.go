package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// CloneWithFilter 使用原生 git 命令执行 partial clone（只拉取 commits，不拉取 blobs）
//
// v2.9：go-git 不支持 --filter=blob:none，对于超大仓库使用原生 git
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
//   - 需要系统安装了 git 命令
//   - 不支持进度回调（无法实时显示百分比）
func CloneWithFilter(url, localPath string, depth int, token string) error {
	// 检查 git 命令是否可用
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("系统未安装 git 命令，无法使用 partial clone: %w", err)
	}

	// 确保父目录存在
	parentDir := filepath.Dir(localPath)
	if err := os.MkdirAll(parentDir, 0755); err != nil {
		return fmt.Errorf("创建父目录失败: %w", err)
	}

	// 构造 git clone 命令
	args := []string{
		"clone",
		"--filter=blob:none", // 关键：不下载 blob（文件内容）
		"--no-checkout",      // 不 checkout 到工作区
		"--single-branch",    // 只拉取默认分支
		"--no-tags",          // 不拉取 tags
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}

	// 处理 HTTPS 认证（将 token 嵌入 URL）
	cloneURL := url
	if token != "" && !isSSHURL(url) {
		// https://github.com/owner/repo -> https://oauth2:TOKEN@github.com/owner/repo
		cloneURL = injectTokenToURL(url, token)
	}

	args = append(args, cloneURL, localPath)

	// 执行命令
	cmd := exec.Command("git", args...)

	// 捕获输出和错误
	output, err := cmd.CombinedOutput()
	if err != nil {
		// 清理失败的克隆
		os.RemoveAll(localPath)
		return fmt.Errorf("git clone 失败: %w\n输出: %s", err, string(output))
	}

	return nil
}

// isSSHURL 判断是否是 SSH URL
func isSSHURL(url string) bool {
	return len(url) > 4 && url[:4] == "git@"
}

// injectTokenToURL 将 token 注入到 HTTPS URL
//
// https://github.com/owner/repo -> https://oauth2:TOKEN@github.com/owner/repo
func injectTokenToURL(url, token string) string {
	if len(url) < 8 || url[:8] != "https://" {
		return url
	}

	// https:// + oauth2:TOKEN@ + github.com/owner/repo
	return "https://oauth2:" + token + "@" + url[8:]
}

// FetchWithFilter 使用原生 git 命令执行 partial fetch（只拉取新的 commits）
//
// v2.9：对已存在的仓库执行 fetch，使用 --filter=blob:none 避免下载文件内容
//
// 参数：
//   - localPath: 本地仓库路径
//   - depth: 深度限制（可选）
//
// 限制：
//   - 需要系统安装了 git 命令
//   - 仓库必须已经存在
func FetchWithFilter(localPath string, depth int) error {
	// 检查 git 命令是否可用
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("系统未安装 git 命令: %w", err)
	}

	// 检查仓库是否存在
	if _, err := os.Stat(filepath.Join(localPath, ".git")); err != nil {
		return fmt.Errorf("仓库不存在: %w", err)
	}

	// 构造 git fetch 命令
	args := []string{
		"-C", localPath, // 在指定目录执行
		"fetch",
		"--filter=blob:none", // 不下载 blob
	}

	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}

	// 执行命令
	cmd := exec.Command("git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git fetch 失败: %w\n输出: %s", err, string(output))
	}

	return nil
}
