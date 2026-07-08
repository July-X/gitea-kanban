package main

import (
	"gitea-kanban/app/git"
	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/store"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"path/filepath"
	"runtime"
	"strings"
)

// ===== v0.4.0 Git 二进制设置（v2.0 拍板「默认内嵌 git 2.55.0」）=====
//
// 流程：
//   1. OnStartup 调 gitbinary.Init → 释放嵌入二进制到 ${dataDir}/tools/git/
//   2. OnStartup 调 gitbinary.SetUserOverride(store.GetGitBinaryPath(a.localStore))
//      让之前保存的用户配置立即生效
//   3. 用户在 SettingsView 改路径：App.SetGitBinaryPath → store.SetGitBinaryPath
//      + gitbinary.SetUserOverride → 本次进程后续所有 git CLI 立即走新路径
//   4. 用户点「测试」：App.TestGitBinary 调 gitbinary.TestGitBinary 验证
//   5. macOS 上二进制被 Gatekeeper 拦截：TestGitBinary 返 quarantine 提示，
//      用户点「解除隔离」调 App.StripGitBinaryQuarantine → 调 xattr -d
//   6. 用户点「选择文件」：App.OpenGitBinaryPicker 调 wailsruntime.OpenFileDialog
//      （平台特定 filter，macOS / Windows / Linux 区分）

// GitBinaryConfig 暴露给前端的 git 二进制配置（SettingsView 卡片用）
type GitBinaryConfig struct {
	// UserOverride 用户在 UI 填的路径；空字符串 = 用默认（内嵌或 PATH）
	UserOverride string `json:"userOverride"`
	// DefaultPath 内嵌二进制实际释放路径（dev 期可能为 "" 因 0 字节占位）
	DefaultPath string `json:"defaultPath"`
	// EmbeddedVersion 内嵌版本号（当前固定 "2.55.0"）
	EmbeddedVersion string `json:"embeddedVersion"`
	// EffectivePath 当前进程实际用的 git 路径（= ResolveGitBinaryPath 解析结果）
	EffectivePath string `json:"effectivePath"`
	// EmbeddedAvailable 当前平台是否真嵌入二进制（linux 永远 false）
	EmbeddedAvailable bool `json:"embeddedAvailable"`
}

// GetGitBinaryConfig 读取当前 git binary 配置 + 当前实际生效路径
func (a *App) GetGitBinaryConfig() GitBinaryConfig {
	userOverride := store.GetGitBinaryPath(a.localStore)
	effective, _ := gitbinary.ResolveGitBinaryPath(userOverride)
	// 把 userOverride 也存到全局，让后续 ResolveGitBinaryPath("") 也走它
	gitbinary.SetUserOverride(userOverride)
	return GitBinaryConfig{
		UserOverride:      userOverride,
		DefaultPath:       gitbinary.DefaultBinaryPath(),
		EmbeddedVersion:   "2.55.0",
		EffectivePath:     effective,
		EmbeddedAvailable: gitbinary.DefaultBinaryPath() != "",
	}
}

// SetGitBinaryPathArgs 写入参数
type SetGitBinaryPathArgs struct {
	Path string `json:"path"` // "" = 清空用户覆盖
}

// SetGitBinaryPath 持久化用户填的 git binary 路径，并立刻让本次进程生效。
//
// 空字符串 = 删 prefs["app.gitBinaryPath"]，回退到内嵌 / PATH git。
// 非空字符串 = 写 prefs + gitbinary.SetUserOverride。
func (a *App) SetGitBinaryPath(args SetGitBinaryPathArgs) error {
	if a.logger != nil {
		a.logger.Info("SetGitBinaryPath", "path", args.Path)
	}
	if err := store.SetGitBinaryPath(a.localStore, args.Path); err != nil {
		return ipc.NewInternal("保存 git 二进制路径失败: " + err.Error())
	}
	gitbinary.SetUserOverride(args.Path)
	return nil
}

// TestGitBinary 验证给定 git 二进制路径是否可执行（用户填完路径点「测试」时调）。
//
// 直接调 gitbinary.TestGitBinary，返结构化结果含 ok/version/path/message/hint。
// 失败 hint 给出 macOS Gatekeeper / 路径不存在 / 非 git 二进制 等具体建议。
func (a *App) TestGitBinary(args SetGitBinaryPathArgs) gitbinary.TestGitResult {
	if a.logger != nil {
		a.logger.Info("TestGitBinary", "path", args.Path)
	}
	return gitbinary.TestGitBinary(args.Path)
}

// StripGitBinaryQuarantineArgs 主动剥离 macOS quarantine 参数
type StripGitBinaryQuarantineArgs struct {
	Path string `json:"path"`
}

// StripGitBinaryQuarantine 主动剥离 macOS quarantine 属性（用户点「解除隔离」按钮调）。
//
// 仅 macOS 有效；其它平台返 nil 即可。失败时返 error 让 UI 提示用户手动允许。
func (a *App) StripGitBinaryQuarantine(args StripGitBinaryQuarantineArgs) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	if a.logger != nil {
		a.logger.Info("StripGitBinaryQuarantine", "path", args.Path)
	}
	if err := gitbinary.StripQuarantine(args.Path); err != nil {
		return ipc.NewInternal("剥离 quarantine 失败: " + err.Error() +
			"；如需手动允许：右键 → 打开 → 仍要打开")
	}
	return nil
}

// OpenGitBinaryPicker 平台特定文件选择对话框（用户在 SettingsView 选 git 二进制）。
//
//   - macOS: 允许选 .app/Contents/MacOS/git（显示包内容）也允许选单文件
//   - Windows: 过滤器限定 .exe
//   - Linux: 不限定后缀（git 通常无扩展名）
//
// 取消返空字符串，错误时返 error。
func (a *App) OpenGitBinaryPicker() (string, error) {
	if a.logger != nil {
		a.logger.Info("OpenGitBinaryPicker")
	}

	// v0.5-mid3 优先让文件对话框初始目录落在系统 git 所在目录（开箱体验）
	//
	// 优先级：
	//   1. exec.LookPath("git") 找到的路径取 dir（如 /usr/bin、/opt/homebrew/bin）
	//   2. ${dataDir}/tools/git/    释放的嵌入式 binary 所在目录
	//   3. dataDir 本身             隐含 fallback，让用户可手动导航
	//
	// 为什么不直接固定 home：很多 mac git 装在 /opt/homebrew/bin，不在 $HOME
	// 为什么不依赖环境变量 GITHUB_PATH：易被 .zshrc 覆盖，绕开更鲁棒
	initialDir := a.pickInitialDirForGitBinary()

	options := func(title string, filters []wailsruntime.FileFilter) (string, error) {
		return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
			Title:            title,
			Filters:          filters,
			DefaultDirectory: initialDir,
		})
	}

	switch runtime.GOOS {
	case "windows":
		return options("选择 git.exe 路径",
			[]wailsruntime.FileFilter{
				{DisplayName: "Git 可执行文件 (*.exe)", Pattern: "*.exe;*.EXE"},
			})
	case "darwin":
		// macOS NSOpenPanel bug: Pattern: "*" 只匹配有扩展名的文件 + alias，
		// Unix executable（如 /usr/bin/git, /opt/homebrew/Cellar/git/2.55.0/bin/git）
		// 无扩展名，被 Pattern:"*" 过滤掉。
		// 修复:传 nil filters → NSOpenPanel 显示所有文件（含 extensionless Unix exec）。
		return options("选择 git 二进制路径", nil)
	default:
		// Linux: git 通常无扩展名，不设过滤器
		return options("选择 git 二进制路径", nil)
	}
}

// pickInitialDirForGitBinary 决策 git binary 文件选择对话框的初始目录。
// 实现位于 app/gitbinary/picker_init_dir.go（包级导出 PickInitialDir）。
func (a *App) pickInitialDirForGitBinary() string {
	return gitbinary.PickInitialDir(a.dataDir)
}

// resolveTokenByLocalPath 从本地仓库路径反查 keychain 里的 token
//
// 步骤（v2.5 升级：按账号分层）：
//  1. localPath 形如 ${workspacePath}/repos/<username>/<owner>__<repo>
//     从路径解析 username / owner / repo（兜底旧版两层路径）
//  2. 在 localStore.Projects 里找匹配的 project（owner+name 匹配）
//  3. 用 project.AccountID 找到 GiteaAccount → 拿 hostURL/username
//  4. 从 secretStore 拿 token
//
// 失败模式：路径不在 workspace 下 / project 没找到 / 账号被删 → 返 NotFound
//
// v2.5 兼容：仍接受旧版 ${workspacePath}/repos/<owner>__<repo> 两层路径
//
//	（迁移期用户手动 mv 仓库、CI 测试等场景；通过 parts.length == 2 兼容）
func (a *App) resolveTokenByLocalPath(localPath string) (token string, username string, err error) {
	// 1. localPath → accountUsername?, owner, repo
	rel, e := filepath.Rel(a.workspacePath, localPath)
	if e != nil || strings.HasPrefix(rel, "..") {
		return "", "", ipc.NewValidationFailed(
			"localPath 不在 workspace 下",
			"localPath="+localPath+" workspace="+a.workspacePath,
		)
	}
	// rel = "repos/<username>/<owner>__<repo>" (v2.5) 或 "repos/<owner>__<repo>" (v2.4 旧)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 2 || parts[0] != "repos" {
		return "", "", ipc.NewValidationFailed(
			"localPath 不是 repos/<...>/<owner>__<repo> 形态",
			"localPath="+localPath+" rel="+rel,
		)
	}
	var accountUsername string
	var repoDirName string
	if len(parts) == 2 {
		// 旧版两层：repos/<owner>__<repo>
		repoDirName = parts[1]
		accountUsername = "" // 不限定账号，按 owner+repo 匹配 project
	} else if len(parts) == 3 {
		// v2.5 三层：repos/<username>/<owner>__<repo>
		accountUsername = parts[1]
		repoDirName = parts[2]
	} else {
		return "", "", ipc.NewValidationFailed(
			"localPath 层级过深（v2.5 期望 repos/<username>/<owner>__<repo>）",
			"localPath="+localPath+" rel="+rel,
		)
	}
	idx := strings.Index(repoDirName, "__")
	if idx < 0 {
		return "", "", ipc.NewValidationFailed(
			"localPath 的目录名不含 '__' 分隔符",
			"dirName="+repoDirName,
		)
	}
	owner := repoDirName[:idx]
	repo := repoDirName[idx+2:]
	// repo 可能带 .git 后缀
	repo = strings.TrimSuffix(repo, ".git")

	// 2. localStore.Projects 里找匹配
	state := a.localStore.Get()
	var matchedAccountID string
	for _, p := range state.Projects {
		if p.Owner == owner && p.Name == repo {
			// 如果 path 里给了 accountUsername，优先匹配同账号的 project
			if accountUsername != "" {
				var accUsername string
				for _, acc := range state.Accounts {
					if acc.ID == p.AccountID {
						accUsername = acc.Username
						break
					}
				}
				if accUsername != accountUsername {
					continue // 跳过不同账号的同名 project
				}
			}
			matchedAccountID = p.AccountID
			break
		}
	}
	if matchedAccountID == "" {
		return "", "", ipc.NewNotFound(
			"未找到匹配 project：owner=" + owner + " name=" + repo,
		)
	}

	// 3. 找 account 拿 hostURL/username
	var matchedAccount *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == matchedAccountID {
			matchedAccount = &state.Accounts[i]
			break
		}
	}
	if matchedAccount == nil {
		return "", "", ipc.NewNotFound(
			"未找到匹配 account：accountId=" + matchedAccountID,
		)
	}

	// 4. secretStore 拿 token
	token, e = a.resolveToken(matchedAccount)
	if e != nil {
		return "", "", e
	}

	return token, matchedAccount.Username, nil
}

// ListWorkspaceRepos 列出 workspace 中已 clone 的仓库
//
// workspace = ${dataDir}/workspace（v2.2 固定）
// v2.5：每个仓库带 accountUsername（所属账号 username）
func (a *App) ListWorkspaceRepos() ([]map[string]string, error) {
	wm := git.NewWorkspaceManager()
	repos, err := wm.ListRepos(a.workspacePath)
	if err != nil {
		return nil, err
	}

	result := make([]map[string]string, 0, len(repos))
	for _, r := range repos {
		result = append(result, map[string]string{
			"name":            r.Name,
			"path":            r.Path,
			"owner":           r.Owner,
			"repo":            r.Repo,
			"accountUsername": r.AccountUsername,
		})
	}
	return result, nil
}

// IsRepoClonedArgs 检查仓库是否已 clone 本地参数
//
// v2.5：新增 Username 字段（按账号分层的布局需要）
//   - 旧版只查 ${workspacePath}/repos/<owner>__<repo>/
//   - 新版查 ${workspacePath}/repos/<username>/<owner>__<repo>/
//   - Username 为空时 fallback 到旧版路径（迁移期兼容 + 测试）
type IsRepoClonedArgs struct {
	Username string `json:"username,omitempty"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// IsRepoCloned 检查指定 owner/repo 是否已 clone 到本地 workspace
//
// v2.3 StatusBar 仓库管理面板用：判断行末按钮是"同步"还是"更新"
// v2.5 升级：按账号分层（args.Username 决定子目录）
func (a *App) IsRepoCloned(args IsRepoClonedArgs) bool {
	if args.Owner == "" || args.Repo == "" {
		return false
	}
	var localPath string
	if args.Username != "" {
		localPath = git.RepoLocalPathForAccount(a.workspacePath, args.Username, args.Owner, args.Repo)
	} else {
		// 兼容旧调用方（不传 username）
		localPath = git.RepoLocalPath(a.workspacePath, args.Owner, args.Repo)
	}
	return git.RepoExists(localPath)
}
