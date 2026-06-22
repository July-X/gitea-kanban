package git

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// WorkspaceManager 管理 gitgraph 仓库的工作区根目录
//
// 对齐旧版 src/main/local/workspace.ts：
//   - 全局配置（不是 per-project），所有 gitgraph 仓库路径派生自此
//   - 持久化到 localStore.prefs['app.workspacePath']
//   - 默认值：~/.gitea-kanban/workspace
type WorkspaceManager struct {
	// defaultPath 默认 workspace 路径
	defaultPath string
}

// NewWorkspaceManager 创建 workspace 管理器
func NewWorkspaceManager() *WorkspaceManager {
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return &WorkspaceManager{
		defaultPath: filepath.Join(home, ".gitea-kanban", "workspace"),
	}
}

// DefaultPath 返回默认 workspace 路径
func (wm *WorkspaceManager) DefaultPath() string {
	return wm.defaultPath
}

// ResolvePath 解析 workspace 路径
//
// 优先级：
//  1. 用户配置的路径（prefs.app.workspacePath）
//  2. 默认路径 ~/.gitea-kanban/workspace
func (wm *WorkspaceManager) ResolvePath(userPath string) string {
	if userPath != "" {
		return userPath
	}
	return wm.defaultPath
}

// EnsureDir 确保 workspace 目录存在（mkdir -p）
func (wm *WorkspaceManager) EnsureDir(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return fmt.Errorf("创建 workspace 目录失败: %w", err)
	}
	return nil
}

// ValidatePath 校验 workspace 路径：存在 / 是目录 / 可写
func (wm *WorkspaceManager) ValidatePath(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("路径不存在")
		}
		return fmt.Errorf("stat 失败: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录")
	}

	// 写测试：创建临时文件
	tmpFile := filepath.Join(path, fmt.Sprintf(".gitea-kanban-ws-test-%d", os.Getpid()))
	if err := os.WriteFile(tmpFile, []byte("test"), 0o644); err != nil {
		return fmt.Errorf("不可写: %w", err)
	}
	os.Remove(tmpFile)
	return nil
}

// WorkspaceRepo 表示 workspace 中的一个已 clone 仓库
type WorkspaceRepo struct {
	// Name 仓库名（owner__repo 格式）
	Name string
	// Path 本地路径
	Path string
	// Owner owner（从 Name 解析）
	Owner string
	// Repo repo 名（从 Name 解析）
	Repo string
}

// ListRepos 列出 workspace 中已 clone 的仓库
//
// 扫描 ${workspacePath}/repos/ 目录，返回所有 ${owner}__${repo} 格式的目录。
func (wm *WorkspaceManager) ListRepos(workspacePath string) ([]WorkspaceRepo, error) {
	reposDir := filepath.Join(workspacePath, "repos")

	entries, err := os.ReadDir(reposDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []WorkspaceRepo{}, nil // 目录不存在 = 没有仓库
		}
		return nil, fmt.Errorf("读取 repos 目录失败: %w", err)
	}

	repos := make([]WorkspaceRepo, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		// 检查是否是 git 仓库
		repoPath := filepath.Join(reposDir, name)
		if !RepoExists(repoPath) {
			continue
		}

		owner, repo := parseRepoDirName(name)
		repos = append(repos, WorkspaceRepo{
			Name:  name,
			Path:  repoPath,
			Owner: owner,
			Repo:  repo,
		})
	}

	// 按 Name 排序
	sort.Slice(repos, func(i, j int) bool {
		return repos[i].Name < repos[j].Name
	})

	return repos, nil
}

// parseRepoDirName 从 ${owner}__${repo} 目录名解析 owner 和 repo
//
// "myorg__myrepo" → ("myorg", "myrepo")
// "myorg__myrepo.git" → ("myorg", "myrepo")（兼容旧版 .git 后缀）
func parseRepoDirName(name string) (owner, repo string) {
	// 去掉 .git 后缀
	clean := strings.TrimSuffix(name, ".git")

	idx := strings.Index(clean, "__")
	if idx < 0 {
		return "", clean
	}
	return clean[:idx], clean[idx+2:]
}

// MigrateRepo 迁移单个仓库到新 workspace
//
// 从 oldPath 复制到 newPath（cp -R），返回新路径。
//
// 沙箱校验：newWorkspacePath 必须在 allowedRoot 之下（防止恶意 caller
// 把仓库复制到 /etc 等系统目录）。allowedRoot 通常是 dataDir。
func (wm *WorkspaceManager) MigrateRepo(oldPath, newWorkspacePath, owner, repo, allowedRoot string) (string, error) {
	// 1. 沙箱校验：newWorkspacePath 必须在 allowedRoot 之下
	if allowedRoot == "" {
		return "", fmt.Errorf("沙箱校验失败：allowedRoot 不能为空")
	}
	cleanNew := filepath.Clean(newWorkspacePath)
	cleanAllowed := filepath.Clean(allowedRoot)
	// 必须满足 cleanNew == cleanAllowed 或 cleanNew 是 cleanAllowed 的子路径
	if cleanNew != cleanAllowed && !strings.HasPrefix(cleanNew, cleanAllowed+string(filepath.Separator)) {
		return "", fmt.Errorf("沙箱校验失败：newWorkspacePath %q 不在 allowedRoot %q 之下", newWorkspacePath, allowedRoot)
	}

	newPath := RepoLocalPath(newWorkspacePath, owner, repo)

	// 2. 检查目标是否已存在
	if RepoExists(newPath) {
		return newPath, nil // 已存在 = 幂等成功
	}

	// 3. 确保父目录存在
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		return "", fmt.Errorf("创建目标父目录失败: %w", err)
	}

	// 4. 复制目录
	if err := copyDir(oldPath, newPath); err != nil {
		return "", fmt.Errorf("复制仓库失败: %w", err)
	}

	return newPath, nil
}

// copyDir 递归复制目录
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		dstPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(dstPath, info.Mode())
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dstPath, data, info.Mode())
	})
}
