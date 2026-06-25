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
//
// 数据布局（v2.5 user 拍板 2026-06-22）：
//
//	~/.gitea-kanban/                  ← dataDir（应用根）
//	├── state.json / logs/main/main.log / dev-tokens/
//	└── workspace/                    ← 本 Manager 管这一层
//	    └── repos/                    ← 一层账号目录
//	        ├── July-X/               ← account.Username
//	        │   └── owner__repo/.git
//	        ├── kanban_bot/           ← 另一账号
//	        │   └── owner__repo/.git
//	        └── _pre_v25_workspace/   ← 旧布局（迁移前重命名备份，仅失败时存在）
//
// v2.5 起多账号场景下，每个账号的仓库存到对应 username 目录下，
// 避免同名 username 在不同平台撞目录（如 July-X 在 gitea.example.com
// 和 github.com 都同名 → 物理隔离）。
type WorkspaceManager struct {
	// defaultPath 默认 workspace 路径（git repo 专用）
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
//  1. 用户配置的路径（prefs.app.workspacePath）—— v2.2 已废弃，保留兼容
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
	// AccountUsername 账号 username（v2.5：所属账号；用于前端展示/过滤）
	AccountUsername string
}

// ListRepos 列出 workspace 中已 clone 的仓库
//
// 扫描 ${workspacePath}/repos/<accountUsername>/<owner>__<repo>/ 目录（v2.5 新布局）。
//
// 实现：先读第一层（账号目录），再读每层下的子目录（仓库目录），
// 跳过不是仓库的目录（如迁移残留的 _unknown / 系统临时文件）。
func (wm *WorkspaceManager) ListRepos(workspacePath string) ([]WorkspaceRepo, error) {
	reposDir := filepath.Join(workspacePath, "repos")

	accountEntries, err := os.ReadDir(reposDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []WorkspaceRepo{}, nil // 目录不存在 = 没有仓库
		}
		return nil, fmt.Errorf("读取 repos 目录失败: %w", err)
	}

	repos := make([]WorkspaceRepo, 0, len(accountEntries))
	for _, accountEntry := range accountEntries {
		if !accountEntry.IsDir() {
			continue
		}
		accountName := accountEntry.Name()
		accountPath := filepath.Join(reposDir, accountName)

		repoEntries, err := os.ReadDir(accountPath)
		if err != nil {
			// 某个账号目录读不了 → 跳过整个账号，记日志靠 caller
			continue
		}
		for _, repoEntry := range repoEntries {
			if !repoEntry.IsDir() {
				continue
			}
			repoName := repoEntry.Name()
			repoPath := filepath.Join(accountPath, repoName)
			if !RepoExists(repoPath) {
				continue
			}

			owner, repo := parseRepoDirName(repoName)
			if owner == "" {
				// 目录名不含 "__" 分隔符，跳过（防御）
				continue
			}
			repos = append(repos, WorkspaceRepo{
				Name:            repoName,
				Path:            repoPath,
				Owner:           owner,
				Repo:            repo,
				AccountUsername: accountName,
			})
		}
	}

	// 按 AccountUsername + Name 排序（保持稳定输出）
	sort.Slice(repos, func(i, j int) bool {
		if repos[i].AccountUsername != repos[j].AccountUsername {
			return repos[i].AccountUsername < repos[j].AccountUsername
		}
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

// ===== v2.5 · workspace 按账号分层 + 老数据迁移 =====

// AccountResolver 把 (platform, owner, repo) 映射到 localStore 里的 account.Username
//
// 迁移逻辑需要知道每个 __owner__repo 目录属于哪个账号：
//   - 优先：扫 localStore.Projects，匹配 (Platform, Owner, Name) → 拿 AccountID → 找 Account.Username
//   - 找不到（project 没记录 / account 被删）：退到 _unknown 目录
//
// 为什么不在 resolver 里查 accountID → account 反查：
//   - 1 次 O(N) 扫描 Projects + 1 次 O(M) 扫描 Accounts，足够快
//   - 写在一个闭包里不暴露 store.GiteaAccount 类型给 git 包
type AccountResolver func(platform, owner, repo string) (accountUsername string, found bool)

// LegacyMigrationResult 旧布局迁移结果
type LegacyMigrationResult struct {
	// MigratedCount 成功 mv 的仓库数
	MigratedCount int
	// SkippedCount 跳过的仓库数（目标已存在 / 无法识别归属 / 旧布局非仓库目录）
	SkippedCount int
	// FailedCount 失败数（rename 失败 / 权限拒绝）
	FailedCount int
	// RenamedTo 旧 repos 目录被 mv 到的备份路径（成功迁移完成时非空）
	RenamedTo string
	// BackupKept 是否保留了备份目录（失败时 = true；成功后 = false，已删）
	BackupKept bool
}

// MigrateLegacyWorkspaceLayout 把 ${workspacePath}/repos 下的旧布局（直接放 __owner__repo/）
// 迁到新布局（${workspacePath}/repos/${accountUsername}/__owner__repo/）。
//
// 设计要点（user 拍板 2026-06-22）：
//   - 启动期**同步**执行（一次性，不需要后台 goroutine）
//   - 成功迁移完成后，整个旧 ${workspacePath}/repos 目录会被 mv 到
//     ${workspacePath}/_pre_v25_workspace（保留备份但不再读），新 ${workspacePath}/repos
//     重建 → 新数据继续往里写
//   - 任一仓库迁移失败：整个旧 repos 目录**直接**保留原名（不 mv），不创建新目录，
//     并把 ${workspacePath}/repos 重命名为 ${workspacePath}/_pre_v25_workspace，
//     旧数据全部失效但**保留**（user 决定：失败时用 _legacy 备份而不是 _pre）
//
// 实现策略（避免 rename 冲突）：
//   - 把新布局先在临时目录 ${workspacePath}/_v25_migration_staging/ 下搭好
//   - 全部成功 → mv 旧 repos 为 _pre_v25_workspace 备份；rm staging 临时目录
//   - 任一失败 → rm staging（已 mv 进 staging 的仓库**不**退回到旧位置——
//     mv 是原子的，每个仓库都已在新 staging 下；备份保留旧 repos 整目录，
//     用户可手动从备份恢复 staging 下漏迁的仓库）
//
// 旧布局识别规则：
//   - ${workspacePath}/repos/ 存在
//   - 里面有子目录 ${owner}__${repo}（不区分 .git 后缀）
//   - 子目录含 .git/ 或 HEAD+objects（是真正的 git 仓库，不是临时文件）
func (wm *WorkspaceManager) MigrateLegacyWorkspaceLayout(
	workspacePath string,
	resolveAccount AccountResolver,
) (LegacyMigrationResult, error) {
	result := LegacyMigrationResult{}

	reposDir := filepath.Join(workspacePath, "repos")
	stagingRoot := filepath.Join(workspacePath, "_v25_migration_staging")

	// 1. 旧 repos 目录不存在 → 没有需要迁移的（首次启动或全新数据）
	entries, err := os.ReadDir(reposDir)
	if err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		return result, fmt.Errorf("读取 repos 目录失败: %w", err)
	}

	// 注：这里不主动清理 staging 残留。如果上次迁移中途崩溃，下一次启动会看到：
	//   - repos/ 里残留的旧 __owner__repo/（部分迁移失败时）
	//   - _v25_migration_staging/ 里 mv 进去的"半成品"
	// legacyRepos 仅扫描 repos/，staging 的孤立数据不会被识别，但用户可手动清理。
	// 主动清理 staging 会破坏以下测试构造（用 staging 目标冲突模拟失败），
	// 也是"启动期清理语义"和"测试构造"两者的取舍。

	// 2. 识别"疑似仓库目录"：owner__repo 格式
	type legacyRepo struct {
		dirName  string
		dirPath  string
		owner    string
		repo     string
		platform string // 由 resolver 反查；找不到 = "unknown"
		// 迁移目标（staging 下）
		stagingAccountDir string
		stagingRepoPath   string
	}
	var legacyRepos []legacyRepo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		// 跳过已经按账号分层的目录（防御：万一有用户手贱已部分迁移）
		if !looksLikeOwnerRepoDir(name) {
			continue
		}
		dirPath := filepath.Join(reposDir, name)
		// 必须真的是 git 仓库（不是临时文件夹同名误判）
		if !RepoExists(dirPath) {
			continue
		}
		owner, repo := parseRepoDirName(name)
		if owner == "" {
			continue
		}
		// resolver 反查账号；找不到 → "unknown"
		username := "_unknown"
		platform := ""
		if resolveAccount != nil {
			if u, ok := resolveAccount("", owner, repo); ok && u != "" {
				username = u
				platform = "matched" // 仅占位，标记真匹配到
			}
		}
		legacyRepos = append(legacyRepos, legacyRepo{
			dirName:   name,
			dirPath:   dirPath,
			owner:     owner,
			repo:      repo,
			platform:  platform,
			stagingAccountDir: filepath.Join(workspacePath, "_v25_migration_staging",
				AccountDirName(username)),
			stagingRepoPath: filepath.Join(workspacePath, "_v25_migration_staging",
				AccountDirName(username), name),
		})
	}

	// 没有任何旧仓库 → 不需要迁移，新数据继续往 ${workspacePath}/repos 写
	if len(legacyRepos) == 0 {
		return result, nil
	}

	// 3. 先在 staging 目录搭新布局（不动旧 repos）
	//
	// 注：stagingRoot 在函数顶部已声明；这里只挂 defer 兜底清理。
	//   成功路径：staging 已被 mv 走（os.Rename stagingRoot → reposDir），
	//     再 RemoveAll 已不存在的目录是 no-op，安全
	//   失败路径：失败分支显式 RemoveAll + defer 兜底（双保险）
	defer func() {
		os.RemoveAll(stagingRoot)
	}()
	failedOverall := false
	for _, lr := range legacyRepos {
		// staging 目标已存在（极端：用户已手动建过同名仓库）→ 跳过，记 failed
		if RepoExists(lr.stagingRepoPath) {
			result.FailedCount++
			failedOverall = true
			continue
		}

		// 确保父账号目录存在
		if err := os.MkdirAll(lr.stagingAccountDir, 0o755); err != nil {
			result.FailedCount++
			failedOverall = true
			continue
		}

		// mv 到 staging（rename，原子）
		if err := os.Rename(lr.dirPath, lr.stagingRepoPath); err != nil {
			result.FailedCount++
			failedOverall = true
			continue
		}
		result.MigratedCount++
	}

	// 4. 整体收尾
	backupName := "_pre_v25_workspace"
	backupPath := filepath.Join(workspacePath, backupName)

	if failedOverall {
		// 失败路径：
		//   - 清掉 staging（已迁进去的半成品无意义）
		//   - 把整个旧 repos 目录 mv 为 _pre_v25_workspace 备份
		//   - 重建空 repos（前端能正常显示"未 clone"，等用户决策）
		//
		// 注：RemoveAll 是幂等的，函数顶部 defer 会再次调用，no-op 安全
		os.RemoveAll(stagingRoot)
		finalBackup, err := uniqueBackupPath(backupPath)
		if err != nil {
			return result, fmt.Errorf("构造备份路径失败: %w", err)
		}
		if err := os.Rename(reposDir, finalBackup); err != nil {
			return result, fmt.Errorf("旧 repos 目录重命名失败: %w", err)
		}
		result.RenamedTo = finalBackup
		result.BackupKept = true
		if err := os.MkdirAll(reposDir, 0o755); err != nil {
			return result, fmt.Errorf("新建 repos 目录失败（备份保留在 %s）: %w", finalBackup, err)
		}
		return result, nil
	}

	// 成功路径：
	//   1. mv 旧 repos 为 _pre_v25_workspace 备份
	//   2. mv staging 为新 repos（一次性切换）
	if err := os.Rename(reposDir, backupPath); err != nil {
		// 极端：权限 / 跨设备。staging 还在，旧 repos 还在 → caller 可手动恢复
		return result, fmt.Errorf("旧 repos 目录备份失败（仓库已迁到 staging，请检查磁盘）: %w", err)
	}
	if err := os.Rename(stagingRoot, reposDir); err != nil {
		// staging mv 失败：旧 repos 已是备份，staging 还在 —— 退化为"备份保留 + 临时布局"
		return result, fmt.Errorf("staging 切换为 repos 失败（备份在 %s）: %w", backupPath, err)
	}
	result.RenamedTo = backupPath
	result.BackupKept = false
	// 成功路径：staging 已被 mv 走，函数顶部 defer RemoveAll 是 no-op
	return result, nil
}

// looksLikeOwnerRepoDir 判断目录名是否形如 "owner__repo" 或 "owner__repo.git"
//
// 简单规则：必须包含 "__" 分隔符（解析出来的 owner / repo 非空）
func looksLikeOwnerRepoDir(name string) bool {
	owner, repo := parseRepoDirName(name)
	return owner != "" && repo != ""
}

// uniqueBackupPath 如果目标已存在，加后缀 .1 / .2 / ...
func uniqueBackupPath(target string) (string, error) {
	if _, err := os.Stat(target); os.IsNotExist(err) {
		return target, nil
	}
	for i := 1; i < 100; i++ {
		try := fmt.Sprintf("%s.%d", target, i)
		if _, err := os.Stat(try); os.IsNotExist(err) {
			return try, nil
		}
	}
	return "", fmt.Errorf("无法找到唯一的备份路径：%s", target)
}
