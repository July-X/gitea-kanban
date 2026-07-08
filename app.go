package main

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"gitea-kanban/app/config"
	"gitea-kanban/app/git"
	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/logx"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/platform/gitea"
	"gitea-kanban/app/platform/github"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
	"github.com/google/uuid"
)


// App 是暴露给前端的主后端对象（Wails binding）
//
// 所有前端可调用的方法都定义在 App 上，Wails 会自动生成 TS bindings 到 frontend/wailsjs/。
// 具体业务逻辑委托给 app/ 下的各子包（store / platform / git / secret 等）。
type App struct {
	ctx     context.Context
	logger  *slog.Logger
	dataDir string
	// workspacePath = ${dataDir}/workspace（放 git repos 唯一目录，v2.2 user 拍板不可改）
	//   - 应用数据（state.json / logs / dev-tokens）在 ${dataDir} 直接放
	//   - git 同步下来的仓库统一在 ${dataDir}/workspace/repos/<owner>__<repo>/
	//   - macOS/Linux: ~/.gitea-kanban/workspace
	//   - Windows: %USERPROFILE%\.gitea-kanban\workspace
	workspacePath string
	localStore    *store.LocalStore
	giteaAdapter  platformAdapter.PlatformAdapter
	githubAdapter platformAdapter.PlatformAdapter
	// secretStore token 凭证存储（go-keyring / dev 文件 fallback）
	// v2.0 新增：AuthConnect 把 token 写进这里 + localStore 持久化账号元信息
	secretStore *secret.Store
}

// NewApp 创建后端应用实例
func NewApp() *App {
	return &App{}
}

// newBindingCtx 为每次 binding 调用生成带 reqID 的局部 ctx
//
// 设计动机（v0.6.0）：
//
//   - 一次 binding 调用是一次「业务操作」,所有后续日志应该能用同一个 reqID 贯穿
//
//   - a.ctx 是共享的、不能改（并发 binding 会竞态）
//
//   - 本 helper 生成 ctx 副本,业务 binding 第一行调一下即可:
//
//     ctx := a.newBindingCtx("CloneRepo")
//     a.logger.InfoContext(ctx, "...")
//
// 这样 grep main.log "reqID=bind-CloneRepo-xxx" 能一次性看到整个调用栈。
func (a *App) newBindingCtx(op string) context.Context {
	reqID := "bind-" + op + "-" + uuid.NewString()[:8]
	return logx.WithReqID(a.ctx, reqID)
}

// getAdapter 根据平台返回对应的 PlatformAdapter
func (a *App) getAdapter(platformStr string) platformAdapter.PlatformAdapter {
	switch platformStr {
	case "gitea":
		return a.giteaAdapter
	case "github":
		return a.githubAdapter
	}
	return nil
}

// OnStartup 在 Wails 前端启动前调用
func (a *App) OnStartup(ctx context.Context) {
	// v0.6.0 · 生成启动期 reqID，让启动期日志都有同一个 reqID 贯穿
	// 背景：之前启动期日志裸写,一条条看不到关联。启动阶段是一次「冷启动操作」,
	// reqID 串起来能让用户反馈问题时一次性看到启动期所有事件
	a.ctx = logx.WithReqID(ctx, "startup-"+uuid.NewString()[:8])

	// 1. 解析数据根目录
	a.dataDir = config.ResolveDataDir()

	// 2. 初始化日志（写文件 ${dataDir}/logs/main/main-YYYY-MM-DD.log）
	//
	// v2.2 简化（user 拍板 2026-06-22）：之前的 "${dataDir}/workspace/logs/..." 太深
	// 现在 logs / state / dev-tokens 直接放 ${dataDir} 下
	// git repos 才进 ${dataDir}/workspace
	// v0.6.0 重写：slog + 自研 dailyRotateHandler 按天切分 + 14d GC
	a.logger = config.NewLogger(a.dataDir)
	a.logger.Info("gitea-kanban starting", "dataDir", a.dataDir, "version", "2.0.0")

	// 把 slog.Default() 也指向同一个文件 logger
	//
	// 背景：github adapter (app/platform/github/adapter.go) 里的 doRequest
	// 调了 slog.Default().Warn(...) 记诊断日志,但 slog.Default() 默认指向 stderr
	// → wails dev 时只显示在终端,文件 main.log 里看不到。
	// 把 default 重定向到 a.logger 后,slog.Default() 也会写到 main.log
	// (wails dev 终端 + 文件 双写,production 仍然是只文件)
	//
	// 注意:slog.SetDefault 是进程全局副作用,只调一次。
	slog.SetDefault(a.logger)

	// 3. workspacePath = ${dataDir}/workspace（放 git repos 唯一目录）
	a.workspacePath = filepath.Join(a.dataDir, "workspace")
	if err := os.MkdirAll(a.workspacePath, 0o755); err != nil {
		a.logger.Warn("workspace mkdir failed", "path", a.workspacePath, "err", err)
	}

	// 4. 初始化 localStore（${dataDir}/state.json）
	ls, err := store.NewLocalStore(filepath.Join(a.dataDir, "state.json"))
	if err != nil {
		a.logger.Error("localStore init failed", "err", err)
	} else {
		a.localStore = ls
		a.logger.Info("localStore initialized", "path", filepath.Join(a.dataDir, "state.json"))
	}

	// 5. 初始化平台适配器
	a.giteaAdapter = gitea.NewGiteaAdapter()
	a.githubAdapter = github.NewGitHubAdapter()
	a.logger.Info("platform adapters initialized")

	// 6. 初始化凭证存储（go-keyring + dev fallback）
	// v2 迁移：开发模式默认走 dev fallback（避免 macOS keychain 弹窗阻断开发）
	// 生产模式走系统 keychain（go-keyring）
	// v2.2：dev-tokens 也直接放 ${dataDir}/dev-tokens/（跟 log/state 一致）
	devMode := os.Getenv("GITEA_KANBAN_DEV_KEYCHAIN") == "1"
	a.secretStore = secret.NewStore(devMode, a.dataDir)
	if devMode {
		a.logger.Info("secret store: dev fallback (file)", "dir", filepath.Join(a.dataDir, "dev-tokens"))
	} else {
		a.logger.Info("secret store: system keychain (go-keyring)")
	}

	// 7. v2.5 · 旧布局 → 新布局迁移（一次性，启动期同步执行）
	//
	// 必须放在 localStore / secretStore 初始化**之后**（resolver 需要读 Projects / Accounts），
	// 放在业务方法前（任何 CloneRepo / GetGitGraph 都依赖新布局）。
	//
	// 用户拍板 2026-06-22：
	//   - ${dataDir}/workspace/repos/<owner>__<repo>/ → ${dataDir}/workspace/repos/<username>/<owner>__<repo>/
	//   - 启动同步，失败时把整个旧 repos 目录 mv 到 _pre_v25_workspace 保留
	//   - 旧布局一旦迁完就标记完成，新代码不再回退到旧路径
	a.runLegacyWorkspaceMigration()

	// 8. v0.4.0 · 释放嵌入 git 2.55.0 二进制 + 把 prefs["app.gitBinaryPath"] 推给 gitbinary 全局
	//
	// 必须放在 runLegacyWorkspaceMigration 之后（不冲突），放在业务方法前
	// （Git Graph 第一次加载就会调 git.RunGit，没有 Init 会回退到 PATH git，行为 OK 但
	// 跳过 macOS 自动脱 quarantine 这一步）。
	//
	// 自动脱 quarantine 失败仅记 WARN 日志，不阻断启动（用户后续手动允许）。
	if err := gitbinary.Init(a.dataDir, a.logger); err != nil {
		a.logger.Warn("gitbinary.Init 失败，仍可启动；后续 git 调用回退到 PATH git", "err", err.Error())
	}
	gitbinary.SetUserOverride(store.GetGitBinaryPath(a.localStore))

	if a.logger != nil {
		a.logger.Info("git binary 配置就绪",
			"userOverride", gitbinary.UserOverride(),
			"defaultBin", gitbinary.DefaultBinaryPath(),
		)
	}
}

// runLegacyWorkspaceMigration 执行一次性的 v2.4 → v2.5 旧布局迁移
//
// 设计：
//   - localStore 未初始化时跳过（启动期错误已经在前面日志记过）
//   - 只跑一次：迁移成功后即便用户手动把 _pre_v25_workspace mv 回 repos，
//     也**不会**再触发迁移（识别规则"repos 下有 __owner__repo 仓库"成立时**仍**会触发，
//     但用户主动 mv 回去的场景罕见，行为可接受）
//   - 失败时整个旧 repos 目录被 mv 到 _pre_v25_workspace，新数据 clone 会失败
//     —— 前端在 UI 上提示"工作区迁移失败"（待 v2.5.x 单独任务做）
func (a *App) runLegacyWorkspaceMigration() {
	if a.localStore == nil || a.logger == nil {
		return
	}

	wm := git.NewWorkspaceManager()
	resolver := func(platform, owner, repo string) (string, bool) {
		state := a.localStore.Get()
		// 用 (Owner, Name) 在 Projects 里找 → AccountID → Accounts 里找 Username
		var matchedAccountID string
		for _, p := range state.Projects {
			if p.Owner == owner && p.Name == repo {
				matchedAccountID = p.AccountID
				break
			}
		}
		if matchedAccountID == "" {
			return "", false
		}
		for _, acc := range state.Accounts {
			if acc.ID == matchedAccountID && acc.Username != "" {
				return acc.Username, true
			}
		}
		return "", false
	}

	result, err := wm.MigrateLegacyWorkspaceLayout(a.workspacePath, resolver)
	if err != nil {
		a.logger.Error("legacy workspace migration failed",
			"err", err, "result", result)
		return
	}
	if result.MigratedCount == 0 && result.FailedCount == 0 {
		// 没有旧布局 → 不记 INFO（每次启动都记会刷屏）
		return
	}
	if result.BackupKept {
		a.logger.Warn("legacy workspace migration: failures detected, backup kept",
			"migrated", result.MigratedCount,
			"failed", result.FailedCount,
			"backup", result.RenamedTo,
		)
	} else {
		a.logger.Info("legacy workspace migration: completed",
			"migrated", result.MigratedCount,
			"skipped", result.SkippedCount,
			"backup", result.RenamedTo,
		)
	}
}

// OnShutdown 在应用退出前调用
func (a *App) OnShutdown(ctx context.Context) {
	if a.logger != nil {
		a.logger.Info("gitea-kanban shutting down")
	}
}
