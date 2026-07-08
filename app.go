package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"gitea-kanban/app/config"
	"gitea-kanban/app/git"
	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/logexport"
	"gitea-kanban/app/logx"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/platform/gitea"
	"gitea-kanban/app/platform/github"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
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

// ===== 暴露给前端的基础方法（桩化，后续步骤逐步实现）=====

// AppInfo 返回应用基本信息（前端启动时调用）
type AppInfo struct {
	Version  string `json:"version"`
	DataDir  string `json:"dataDir"`
	Platform string `json:"platform"` // darwin / windows / linux
}

// GetAppInfo 返回应用信息
func (a *App) GetAppInfo() AppInfo {
	return AppInfo{
		Version:  "2.0.0",
		DataDir:  a.dataDir,
		Platform: runtime.GOOS,
	}
}

// OpenDataDir 用系统文件管理器打开应用数据根目录
//
// v2.2：前端设置页"打开应用数据目录"按钮调，跨平台实现：
//   - macOS: `open <path>`
//   - Windows: `explorer <path>`
//   - Linux: `xdg-open <path>`
//
// 失败时返 *ipc.IpcError（前端可展示 toast）
func (a *App) OpenDataDir() error {
	if a.dataDir == "" {
		return ipc.NewInternal("dataDir 未初始化")
	}

	// 确保目录存在（避免打开空目录时某些 OS 报错）
	if err := os.MkdirAll(a.dataDir, 0o755); err != nil {
		return ipc.NewInternal("确保数据目录存在失败：" + err.Error())
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", a.dataDir)
	case "windows":
		cmd = exec.Command("explorer", a.dataDir)
	default: // linux + 其它 unix
		cmd = exec.Command("xdg-open", a.dataDir)
	}

	if a.logger != nil {
		a.logger.Info("OpenDataDir", "path", a.dataDir, "cmd", cmd.String())
	}

	if err := cmd.Start(); err != nil {
		return ipc.NewInternal("打开目录失败：" + err.Error())
	}

	// 不等 cmd.Wait() —— `open` / `xdg-open` / `explorer` 都是 detach 模式
	// 等会阻塞到子进程退出才返回
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}

// OpenDesktopFolder 用系统文件管理器打开用户桌面目录
//
// 跨平台实现：
//   - macOS: `open <path>`
//   - Windows: `explorer <path>`
//   - Linux: `xdg-open <path>`
//
// 优先使用 logexport.DesktopDir() 解析桌面路径；
// 若结果为空，fallback 到 os.UserHomeDir()。
// 失败时返 *ipc.IpcError（前端可展示 toast）
func (a *App) OpenDesktopFolder() error {
	desktopPath := logexport.DesktopDir()
	if desktopPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ipc.NewInternal("获取桌面目录失败：" + err.Error())
		}
		desktopPath = home
	}

	// 确保目录存在（避免打开空目录时某些 OS 报错）
	if err := os.MkdirAll(desktopPath, 0o755); err != nil {
		return ipc.NewInternal("确保桌面目录存在失败：" + err.Error())
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", desktopPath)
	case "windows":
		cmd = exec.Command("explorer", desktopPath)
	default: // linux + 其它 unix
		cmd = exec.Command("xdg-open", desktopPath)
	}

	if a.logger != nil {
		a.logger.Info("OpenDesktopFolder", "path", desktopPath, "cmd", cmd.String())
	}

	if err := cmd.Start(); err != nil {
		return ipc.NewInternal("打开桌面目录失败：" + err.Error())
	}

	// 不等 cmd.Wait() —— `open` / `xdg-open` / `explorer` 都是 detach 模式
	// 等会阻塞到子进程退出才返回
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}

// ===== v2.x 前端日志统一记录（前后端共用 slog）=====
//
// 设计动机：
//   - 旧版前端 console.error / toast.error 只在开发者工具里看，用户截图反馈问题时
//     信息丢失严重（renderer 重启就清空）
//   - 后端已有 slog 写 ${dataDir}/logs/main/main.log，按时间索引
//   - 现在前端把 warn / error 级 toast + console.error + window.onerror + unhandledrejection
//     都走 Go → 同一份文件
//   - 用户反馈问题 → 直接打开数据目录翻 main.log,看到时间戳 + 来源 + 内容
//
// 写入策略：
//   - 前端 fire-and-forget 调 LogFrontend,失败静默（不阻塞 UI,不弹 toast）
//   - Wails binding 自动把字符串参数转 JSON,前端不传 token / 敏感信息
//   - Go 端统一加 "src" 字段标识来源(toast / console / window / unhandledrejection)
//
// 安全：
//   - 不接受任意 level 字符串,固定白名单（防前端伪造日志级别）
//   - 不在日志里写 token / cookie / localStorage 内容
//   - description 字段最大 1KB 截断（防恶意前端打爆文件）

// LogFrontendLevel 前端日志级别（与 Go slog.Level 对应）
//
// 设计:导出为 const string 而不是 enum int,这样 Wails 自动生成的 TS 类型
// 直接是字面量联合类型,前端可以传 'debug' | 'info' | 'warn' | 'error'。
type LogFrontendLevel string

const (
	LogLevelDebug LogFrontendLevel = "debug"
	LogLevelInfo  LogFrontendLevel = "info"
	LogLevelWarn  LogFrontendLevel = "warn"
	LogLevelError LogFrontendLevel = "error"
)

// LogFrontendArgs 前端日志参数
//
// v0.6.0 增虽:
//   - ReqID: 与本次请求/操作联动的请求 ID。后端从 ctx 补上时,
//     优先用后端 ctx 里的,后端没有时用前端传来的
//   - AccountID/ProjectID: 与业务联动,被后端溯源调用栈(当前实现走简单取传)
//   - Source: 调用方(toast / console / window.onerror / unhandledrejection / 其它)
//
// 写日志时落到 src 字段方便过滤。
type LogFrontendArgs struct {
	Level       LogFrontendLevel `json:"level"`
	Message     string           `json:"message"`
	Description string           `json:"description,omitempty"`
	Source      string           `json:"source,omitempty"`
	ReqID       string           `json:"reqID,omitempty"`
	AccountID   string           `json:"accountID,omitempty"`
	ProjectID   string           `json:"projectID,omitempty"`
}

// LogFrontend 前端日志统一入口（fire-and-forget）
//
// 设计：
//   - logger 未初始化时（启动期极早或异常路径）静默忽略
//   - level 不在白名单 → 当成 info（防前端传 'panic' / 'fatal' 等让 slog 不识别）
//   - description 截断到 1024 字符（防恶意前端打爆日志文件）
//   - 永远不返回 error（Wails binding 抛错会触发前端 unhandledrejection 死循环）
//   - panic recovery（v0.6.0）：binding 里的 panic 不会击穿到 Wails 外面,
//     会被 recover 后落盘 main.log,下次启动反馈问题时能看到
func (a *App) LogFrontend(args LogFrontendArgs) {
	defer logx.Recover(a.logger, "App.LogFrontend")

	if a.logger == nil {
		return
	}

	// 截断 description（防爆文件）
	desc := args.Description
	if len(desc) > 1024 {
		desc = desc[:1024] + "...(truncated)"
	}

	// 过滤非法 level（白名单）
	var slogLevel slog.Level
	switch args.Level {
	case LogLevelDebug:
		slogLevel = slog.LevelDebug
	case LogLevelInfo:
		slogLevel = slog.LevelInfo
	case LogLevelWarn:
		slogLevel = slog.LevelWarn
	case LogLevelError:
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}

	// ctx 透传 + 前端覆盖：后端 ctx 有 reqID 则优先(后端是 source of truth),
	// 前端传的 reqID 作为 fallback
	ctx := a.ctx
	if logx.ReqID(ctx) == "" && args.ReqID != "" {
		ctx = logx.WithReqID(ctx, args.ReqID)
	}
	if logx.AccountID(ctx) == "" && args.AccountID != "" {
		ctx = logx.WithAccountID(ctx, args.AccountID)
	}
	if logx.ProjectID(ctx) == "" && args.ProjectID != "" {
		ctx = logx.WithProjectID(ctx, args.ProjectID)
	}

	// 写日志：source 字段方便 grep,desc 留原文方便定位
	a.logger.Log(ctx, slogLevel, args.Message,
		"src", args.Source,
		"desc", desc,
	)
}

// ===== v0.6.0 日志导出 / Bug 上报 =====
//
// 把 app/logexport 包的能力通过 Wails binding 暴露给前端：
//   - ExportLogs: 一键打包 zip 到桌面（logs + state.json 脱敏 + 元信息）
//   - CopyRecentLogs: 读最近 N 条日志到剪贴板（贴 issue 用）

// ExportLogsArgs 导出日志参数
type ExportLogsArgs struct {
	// MaxLogs 最多包含几个日志文件（默认 5）
	MaxLogs int `json:"maxLogs,omitempty"`
}

// ExportLogsResult 导出结果
type ExportLogsResult struct {
	ZipPath     string   `json:"zipPath"`
	LogCount    int      `json:"logCount"`
	LogBytes    int64    `json:"logBytes"`
	StateBytes  int64    `json:"stateBytes"`
	GeneratedAt string   `json:"generatedAt"`
	LogFiles    []string `json:"logFiles"`
}

// ExportLogs 一键导出日志 zip 到桌面
//
// 打包内容：
//   - app.json（版本/平台/数据目录/时间戳等元信息）
//   - state.json（token/password/secret 字段自动脱敏）
//   - logs/main-YYYY-MM-DD.log（最近 N 天）
//
// 文件名：gitea-kanban-logs-YYYY-MM-DD-HHMMSS.zip
func (a *App) ExportLogs(args ExportLogsArgs) (*ExportLogsResult, error) {
	ctx := a.newBindingCtx("ExportLogs")
	defer logx.Recover(a.logger, "App.ExportLogs")

	if a.logger == nil {
		return nil, ipc.NewInternal("logger 未初始化")
	}

	desktopPath := logexport.DesktopDir()
	if desktopPath == "" {
		// 桌面目录解析失败 → fallback 到 home
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, ipc.NewInternal("无法解析桌面目录")
		}
		desktopPath = home
	}

	logDir := filepath.Join(a.dataDir, "logs", "main")
	statePath := filepath.Join(a.dataDir, "state.json")

	summary, err := logexport.Export(logexport.ExportOptions{
		DesktopPath: desktopPath,
		LogDir:      logDir,
		StatePath:   statePath,
		Version:     "2.0.0",
		Platform:    runtime.GOOS,
		DataDir:     a.dataDir,
		MaxLogs:     args.MaxLogs,
	})
	if err != nil {
		a.logger.ErrorContext(ctx, "ExportLogs 失败", "err", err)
		return nil, ipc.NewInternal(fmt.Sprintf("导出日志失败: %v", err))
	}

	a.logger.InfoContext(ctx, "ExportLogs 完成",
		"zipPath", summary.ZipPath,
		"logCount", summary.LogCount,
		"logBytes", summary.LogBytes,
	)

	return &ExportLogsResult{
		ZipPath:     summary.ZipPath,
		LogCount:    summary.LogCount,
		LogBytes:    summary.LogBytes,
		StateBytes:  summary.StateBytes,
		GeneratedAt: summary.GeneratedAt,
		LogFiles:    summary.LogFiles,
	}, nil
}

// CopyRecentLogsArgs 复制最近日志参数
type CopyRecentLogsArgs struct {
	// MaxBytes 字节上限（默认 64KB）
	MaxBytes int `json:"maxBytes,omitempty"`
}

// CopyRecentLogsResult 复制结果
type CopyRecentLogsResult struct {
	Content string `json:"content"`
	Bytes   int    `json:"bytes"`
}

// CopyRecentLogs 读最近 N 条日志（贴 issue 用）
//
// 读最近 3 天的 main-*.log，截取尾部 maxBytes 字节。
// 前端拿到 content 后调剪贴板 API 复制。
func (a *App) CopyRecentLogs(args CopyRecentLogsArgs) (*CopyRecentLogsResult, error) {
	ctx := a.newBindingCtx("CopyRecentLogs")
	defer logx.Recover(a.logger, "App.CopyRecentLogs")

	if a.logger == nil {
		return nil, ipc.NewInternal("logger 未初始化")
	}

	logDir := filepath.Join(a.dataDir, "logs", "main")
	content, err := logexport.ReadRecentLogs(logDir, args.MaxBytes)
	if err != nil {
		a.logger.ErrorContext(ctx, "ReadRecentLogs 失败", "err", err)
		return nil, ipc.NewInternal(fmt.Sprintf("读取日志失败: %v", err))
	}

	a.logger.InfoContext(ctx, "CopyRecentLogs 完成", "bytes", len(content))

	return &CopyRecentLogsResult{
		Content: content,
		Bytes:   len(content),
	}, nil
}

// ===== v2.4 用户偏好（prefs）=====
//
// 修复 v2.0 stub bug：
//   - 旧版 shim user.prefs.{get,set} 是 notImplemented → StatusBar 选完仓库重启后
//     "应用没记住" 的根因之一（虽然 localStorage 兜底能恢复，但 IPC 路径死链）
//   - 新版：写 localStore.Prefs（与 AGENTS §6.4 业务态"应用偏好"对齐）
//   - frontend 不需要知道细节，shim 转发即可

// GetUserPrefsArgs 读取偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type GetUserPrefsArgs struct {
	Keys []string `json:"keys"`
}

// GetUserPrefs 读取指定 keys 的偏好值
//
// 请求：{ keys: string[] }
// 返：{ "key1": value1, "key2": value2 }（不存在的 key 不会出现在返回里）
func (a *App) GetUserPrefs(args GetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	state := a.localStore.Get()
	if state.Prefs == nil {
		return map[string]any{}, nil
	}

	out := make(map[string]any, len(args.Keys))
	if len(args.Keys) == 0 {
		// 没指定 keys → 返全部
		for k, v := range state.Prefs {
			out[k] = v
		}
		return out, nil
	}
	for _, k := range args.Keys {
		if v, ok := state.Prefs[k]; ok {
			out[k] = v
		}
	}
	if a.logger != nil && len(args.Keys) > 0 && len(args.Keys) < 20 {
		a.logger.Info("GetUserPrefs", "keys", args.Keys, "found", len(out))
	}
	return out, nil
}

// SetUserPrefsArgs 写入偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type SetUserPrefsArgs struct {
	Entries map[string]any `json:"entries"`
}

// SetUserPrefs 写入偏好（merge 到现有 Prefs，不存在键才加，null 删键）
//
// 请求：{ entries: { "key1": value1, "key2": null, ... } }
// 返：{ written: int, deleted: int }
//
// 语义：
//   - value != null → 写入
//   - value == null → 删除该 key
func (a *App) SetUserPrefs(args SetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	if args.Entries == nil {
		return map[string]any{"written": 0, "deleted": 0}, nil
	}

	written := 0
	deleted := 0
	err := a.localStore.Mutate(func(s *store.LocalState) {
		if s.Prefs == nil {
			s.Prefs = map[string]any{}
		}
		for k, v := range args.Entries {
			if v == nil {
				delete(s.Prefs, k)
				deleted++
			} else {
				s.Prefs[k] = v
				written++
			}
		}
	})
	if err != nil {
		return nil, ipc.NewInternal("保存 prefs 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("SetUserPrefs", "written", written, "deleted", deleted)
	}
	return map[string]any{"written": written, "deleted": deleted}, nil
}

// ===== Git Graph 相关方法（步骤 3.1）=====

// GraphResultDTO 图结果（暴露给前端，与 platform.GraphResult 对齐）
type GraphResultDTO struct {
	Nodes     []GraphNodeDTO   `json:"nodes"`
	Edges     []GraphEdgeDTO   `json:"edges"`
	Branches  []GraphBranchDTO `json:"branches,omitempty"`
	MaxLane   int              `json:"maxLane"`
	Truncated bool             `json:"truncated"`
	// LocalExhausted 本地 commit 已全部取出，远端可能有更多（需 deepen）。
	// 前端据此显示「本地历史已加载完」提示 + 是否加载更早历史的按钮。
	LocalExhausted bool `json:"localExhausted"`
	// DeepenTriggered 后端已启动后台增量 deepen 拉取远端 commit。
	// 前端收到此信号时不该再次触发 deepen，等待 repo:sync:progress 事件即可。
	DeepenTriggered bool `json:"deepenTriggered"`
}

// GraphBranchDTO 一条完整 branch path（对齐 platform.GraphBranchDTO）
type GraphBranchDTO struct {
	Color int                  `json:"color"`
	End   int                  `json:"end"`
	Lines []GraphBranchLineDTO `json:"lines"`
}

// GraphBranchLineDTO branch 上的一段线（对齐 platform.GraphBranchLineDTO）
type GraphBranchLineDTO struct {
	X1          int  `json:"x1"`
	Y1          int  `json:"y1"`
	X2          int  `json:"x2"`
	Y2          int  `json:"y2"`
	LockedFirst bool `json:"lockedFirst"`
	// IsCommitted 该 line 是否属于「已提交」段。
	// 对齐 vscode graph.ts:102 `line.isCommitted` 与 Branch.drawPath:152 stroke 切换；
	// false 时前端走 #808080 + stroke-dasharray: 2px 灰色虚线。
	// 不带 omitempty —— false（UNCOMMITTED 段）也是有效信号，omitempty 会吞掉
	IsCommitted bool `json:"isCommitted"`
}

// GraphNodeDTO 图节点
type GraphNodeDTO struct {
	Row         int      `json:"row"`
	Lane        int      `json:"lane"`
	Color       int      `json:"color"`
	SHA         string   `json:"sha"`
	ShortSHA    string   `json:"shortSha"`
	Subject     string   `json:"subject"`
	AuthorName  string   `json:"authorName"`
	AuthorEmail string   `json:"authorEmail"`
	Date        string   `json:"date"`
	IsMerge     bool     `json:"isMerge"`
	Parents     []string `json:"parents"`
	Refs        []string `json:"refs,omitempty"`
	RefTypes    []string `json:"refTypes,omitempty"`
	IsCurrent   bool     `json:"isCurrent,omitempty"`
	IsStash     bool     `json:"isStash,omitempty"`
	// IsCommitted 该节点是否已提交 (true) 还是 UNCOMMITTED 虚拟节点 (false)。
	// 对齐 vscode graph.ts Vertex.draw：uncommitted 时 dot stroke = #808080。
	// App 端 LogCommits / LogCommitsVscode 在 local 落后 origin 时 unshift 一颗
	// UNCOMMITTED 虚拟 commit (SHA = "*")，对应节点的 IsCommitted = false。
	// 不带 omitempty —— false（UNCOMMITTED 节点）也是有效信号，omitempty 会吞掉
	IsCommitted bool `json:"isCommitted"`
}

// GraphEdgeDTO 图边
type GraphEdgeDTO struct {
	FromRow  int `json:"fromRow"`
	ToRow    int `json:"toRow"`
	FromLane int `json:"fromLane"`
	ToLane   int `json:"toLane"`
	Color    int `json:"color"`
	Type     int `json:"type"`
}

// CloneRepoArgs clone 仓库参数
//
// v2.3 user 拍板：token 不再走 IPC
//   - 旧版前端传 token 给 Go 端 → 违反 AGENTS §8.2 鉴权铁律
//   - 现在 Go 端根据 platform+hostURL+username 自己去 keychain 拿
//   - 前端只传 (platform, hostURL, username, owner, repo)
type CloneRepoArgs struct {
	// ProjectID 优先（v2.x 推荐）：Go 端按 projectId 反查 project + account，
	// 自动拿 platform/hostUrl/username/owner/repo，前端无需再传。
	// 与 PullRepoByProjectId 范式对齐，符合 AGENTS §8.2 鉴权铁律（前端不传鉴权字段）。
	ProjectID string `json:"projectId,omitempty"`
	// 以下字段为旧协议（projectId 为空时回退用），新代码请只传 projectId
	Platform string `json:"platform"` // "gitea" | "github"
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// CloneRepoResult clone 结果
type CloneRepoResult struct {
	LocalPath string `json:"localPath"`
	Reused    bool   `json:"reused"` // 仓库已存在 = 复用没重新 clone
}

// ===== v2.6 进度事件（git clone / pull）=====
//
// 实现：go-git sideband → ProgressCallback → runtime.EventsEmit("git:sync:progress", payload)
// 前端订阅：repo store init 时挂一个 onMounted 监听，写到 progressByRepo[repoKey]
// StatusBar 消费：行末按钮下方渲染 <progress> + tooltip 显示百分比
//
// 设计取舍：
//   - Wails EventsEmit 是 push 模型（后端 → 前端单向），不需要前端订阅单独的 stream
//     不需要为进度开新 IPC endpoint，零额外 schema
//   - Event name 用单一 `git:sync:progress` 避免事件命名爆炸；payload 内区分 stage / repoKey
//   - repoKey 用 `<platform>/<hostURL>/<owner>/<repo>` 前缀（v2.5+ 账号隔离之后，
//     同 owner/repo 在不同账号下是不同的物理路径，前端 key 必须包含 hostURL/platform）
const GitSyncProgressEvent = "git:sync:progress"

// GitSyncProgressPayload 进度事件 payload（前端订阅用）
//
// 与 app/git.SyncProgress 同结构（透传）—— 这里不复用是避免前端 import Go 类型
// （前端 wailsjs 也不直接暴露 Go struct 给 TS，TS 这边手动声明更稳）。
type GitSyncProgressPayload struct {
	Stage   string `json:"stage"`
	Percent int    `json:"percent"`
	Message string `json:"message"`
	Cur     int    `json:"cur"`
	Total   int    `json:"total"`
	// RepoKey 仓库 key（前端用这个 map 到 clonedMap / progressByRepo）
	// 格式：`<platform>/<hostURL>/<owner>/<repo>`（与 useRepoStore.refreshClonedStatus 一致风格）
	RepoKey string `json:"repoKey"`
}

// buildSyncProgressCallback 构造 ProgressCallback，把每条 SyncProgress 包装成 Wails event
//
// 用法：CloneRepo / PullRepoByProjectId 调本函数生成 cb，传给 git.CloneRepo / git.PullRepo
//
// 参数：
//   - repoKey:前端用于 map 的仓库标识（建议 `${owner}/${repo}`，前端 clonedMap 风格）
//   - extra:可选 extra fields（占位，保留用于未来加 progressId / correlationId 等）
func (a *App) buildSyncProgressCallback(repoKey string) git.ProgressCallback {
	if a.ctx == nil {
		// 没初始化 context 时 EventsEmit 不能用，返 no-op（避免 nil panic）
		return func(p git.SyncProgress) {}
	}
	return func(p git.SyncProgress) {
		payload := GitSyncProgressPayload{
			Stage:   string(p.Stage),
			Percent: p.Percent,
			Message: p.Message,
			Cur:     p.Cur,
			Total:   p.Total,
			RepoKey: repoKey,
		}
		// 异步发，不阻塞 go-git sideband goroutine
		// （Wails EventsEmit 本身线程安全；wails dev 终端 + production 都行）
		wailsruntime.EventsEmit(a.ctx, GitSyncProgressEvent, payload)
	}
}

// CloneRepo clone 仓库到本地 workspace
//
// v2.3：token 走 secret.Store 从 keychain 拿（前端**不**传 token）
// 校验当前账号的 hostURL+username 必须匹配 localStore.Accounts 里某条记录
// （防 user 拿错 token clone 到别账号仓库 —— 但 hostURL 一样所以问题不大）
//
// v2.6：装上 progress 回调，通过 Wails EventsEmit 实时推百分比到前端
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("CloneRepo",
			"projectId", args.ProjectID,
			"platform", args.Platform,
			"owner", args.Owner,
			"repo", args.Repo,
			"workspace", a.workspacePath,
		)
	}

	// 优先按 projectId 反查（v2.x，与 PullRepoByProjectId 范式对齐）：
	//   前端 syncRepo 只传 projectId，Go 端反查 project→account 拿 platform/hostUrl/username/owner/repo。
	//   修复"GitHub 小仓库点同步报 hostUrl 不能为空"：旧协议要求前端传 platform/hostUrl/username，
	//   但前端只有 projectId，shim 把 hostUrl 透传成空字符串 → 校验失败。
	var (
		platformName   string
		hostURL        string
		username       string
		owner          string
		repo           string
		matchedAccount *store.GiteaAccount
		matchedProject *store.RepoProject
	)

	if strings.TrimSpace(args.ProjectID) != "" {
		project, account, err := a.findProjectAndAccount(args.ProjectID)
		if err != nil {
			return CloneRepoResult{}, err
		}
		matchedProject = project
		matchedAccount = account
		platformName = account.Platform
		hostURL = account.GiteaURL
		username = account.Username
		owner = project.Owner
		repo = project.Name
	} else {
		// 旧协议回退（projectId 为空时）：前端传 platform/hostUrl/username/owner/repo
		platformName = strings.TrimSpace(args.Platform)
		hostURL = strings.TrimSpace(args.HostURL)
		username = strings.TrimSpace(args.Username)
		owner = strings.TrimSpace(args.Owner)
		repo = strings.TrimSpace(args.Repo)
	}

	if platformName == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("platform 不能为空", "")
	}
	if !platformAdapter.IsValid(platformName) {
		return CloneRepoResult{}, ipc.NewValidationFailed("不支持的平台", "platform="+platformName)
	}
	if hostURL == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("hostUrl 不能为空", "projectId 为空时需传 hostUrl，或检查 project 是否关联了 account")
	}
	if username == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("username 不能为空", "")
	}
	if owner == "" || repo == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("owner/repo 不能为空",
			fmt.Sprintf("owner=%q repo=%q", owner, repo))
	}

	// 1. 从 localStore 找账号 → secret.Store 拿 token
	//    projectId 路径已通过 findProjectAndAccount 拿到 matchedAccount；
	//    旧协议路径需按 platform+hostURL+username 匹配（防越权 clone 别账号仓库）
	if matchedAccount == nil {
		state := a.localStore.Get()
		for i := range state.Accounts {
			if state.Accounts[i].Platform == platformName &&
				state.Accounts[i].GiteaURL == hostURL &&
				state.Accounts[i].Username == username {
				matchedAccount = &state.Accounts[i]
				break
			}
		}
	}
	if matchedAccount == nil {
		return CloneRepoResult{}, &ipc.IpcError{
			Code:    ipc.CodeNotFound,
			Message: "未找到匹配账号",
			Hint:    "请检查 hostUrl/username 是否正确，或重新连接",
			Cause: fmt.Sprintf(
				"platform=%s hostUrl=%s username=%s (localStore.Accounts 里找不到匹配项)",
				platformName, hostURL, username,
			),
		}
	}

	// 2. 从 keychain 拿 token（绝不传给前端）
	token, err := a.secretStore.Get(platformName, hostURL, username)
	if err != nil {
		return CloneRepoResult{}, classifyKeychainError(err)
	}
	if token == "" {
		return CloneRepoResult{}, ipc.NewInternal(
			"token 为空：keychain 里有记录但 token 字符串为空 (platform=" + platformName +
				" hostUrl=" + hostURL + " username=" + username + ")")
	}

	// 3. clone
	adapter := a.getAdapter(platformName)
	if adapter == nil {
		return CloneRepoResult{}, ipc.NewInternal("平台适配器未初始化：" + platformName)
	}

	// v2.5：clone 到账号隔离的子目录
	//   旧布局：${workspacePath}/repos/<owner>__<repo>/
	//   新布局：${workspacePath}/repos/<username>/<owner>__<repo>/
	//
	// v2.6：progress 回调（把 sideband 解析结果通过 EventsEmit 推到前端）
	localPath, err := adapter.CloneRepo(a.ctx, hostURL, username, token, owner, repo, a.workspacePath, matchedAccount.Username, a.buildSyncProgressCallback(owner+"/"+repo))
	if err != nil {
		return CloneRepoResult{}, err
	}

	// 4. 标记 project：projectId 路径已存在 project（只刷 LastSyncAt）；
	//    旧协议路径可能 project 不存在 → 新建。
	//
	// v2.3 重要：必须新建 project（之前是只更新，导致 pullRepo 找不到 project → 找不到 token）
	_ = a.localStore.Mutate(func(s *store.LocalState) {
		now := time.Now().UnixMilli()
		// projectId 路径：直接刷已知 project
		if matchedProject != nil {
			for i := range s.Projects {
				if s.Projects[i].ID == matchedProject.ID {
					s.Projects[i].LastSyncAt = now
					return
				}
			}
		}
		for i := range s.Projects {
			if s.Projects[i].Platform == platformName &&
				s.Projects[i].AccountID == matchedAccount.ID &&
				s.Projects[i].Owner == owner &&
				s.Projects[i].Name == repo {
				s.Projects[i].LastSyncAt = now
				return
			}
		}
		// 新建 project（仅旧协议路径会走到这里）
		s.Projects = append(s.Projects, store.RepoProject{
			ID:            uuid.NewString(),
			Platform:      platformName,
			AccountID:     matchedAccount.ID,
			Owner:         owner,
			Name:          repo,
			DefaultBranch: "", // CloneRepo 不知道 default branch，由 GetAppInfo / ListRepos 后续补充
			LastSyncAt:    now,
			CreatedAt:     now,
		})
	})

	if a.logger != nil {
		a.logger.Info("CloneRepo: success",
			"owner", owner, "repo", repo,
			"localPath", localPath, "accountId", matchedAccount.ID,
		)
	}

	return CloneRepoResult{LocalPath: localPath}, nil
}

// LogGraphArgs log graph 参数
type LogGraphArgs struct {
	Platform  string   `json:"platform"`
	LocalPath string   `json:"localPath"`
	Branches  []string `json:"branches"`
	MaxCount  int      `json:"maxCount"`
}

// LogGraph 获取 commit 历史并构建 Graph 布局
func (a *App) LogGraph(args LogGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("LogGraph", "platform", args.Platform, "path", args.LocalPath)
	}

	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return GraphResultDTO{}, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	result, err := adapter.LogGraph(a.ctx, args.LocalPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	return graphResultToAppDTO(result), nil
}

// ===== v2.4 鉴权修复：Git Graph 端到端可用 =====
//
// 修复 StatusBar 选完仓库后"看板、Git Graph 等功能还是不能使用"：
//   - 旧版 commits.gitgraph.lines 在 shim 里是 stubEmpty（永远返 0 commits）
//   - 旧版 commits.gitgraphCloneRepo 也是 notImplemented
//   - 旧版 commits.gitgraphPull 用错误的 localPath
//
// v2.4 新增：
//   - GetGitGraph(projectId) → 反查 localPath/token → adapter.LogGraph → GraphResultDTO
//   - GetRepoById(projectId) → 返 RepoDTO + localPath（前端 ListWorkspaceRepos 的替代品）
//
// 设计原则：前端只传 projectId（业务态概念），Go 端做所有"反查"

// GetGitGraphArgs Git Graph 入参
type GetGitGraphArgs struct {
	ProjectID string   `json:"projectId"`
	Branches  []string `json:"branches,omitempty"`
	MaxCount  int      `json:"maxCount,omitempty"`
	Offset    int      `json:"offset,omitempty"`
}

// GetGitGraph 获取项目的 commit DAG（用 projectId 反查 localPath + token）
//
// 步骤：
//  1. localStore.Projects 找 project → owner/name/accountID
//  2. localStore.Accounts 找 account → platform/hostURL/username
//  3. workspacePath + /repos/<owner>__<repo> = localPath
//  4. secretStore 拿 token
//  5. adapter.LogGraph → 自研 layout → 返 GraphResultDTO
func (a *App) GetGitGraph(args GetGitGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("GetGitGraph", "projectId", args.ProjectID, "branches", args.Branches)
	}

	if args.ProjectID == "" {
		return GraphResultDTO{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// 1-2. 找 project + account
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 3. 算 localPath（v2.5：按账号分层）
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	// 4. 拿 token
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return GraphResultDTO{}, classifyKeychainError(err)
	}
	if token == "" {
		return GraphResultDTO{}, ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}

	// 5. 调 adapter.LogGraph
	adapter := a.getAdapter(account.Platform)
	if adapter == nil {
		return GraphResultDTO{}, ipc.NewUnsupportedPlatform(account.Platform)
	}

	// 6. 解析本地 HEAD (用于 layout 给 local HEAD 节点打 isCurrent 标记,
	//    GitHub adapter 老版本没这个 fallback 会让 local HEAD 的 dot
	//    画成实心、tooltip 误标"不在 HEAD 中")。失败不致命,空字符串让
	//    layout 跳过 isCurrent 标记,跟旧行为兼容。
	head := git.ResolveLocalHead(localPath)

	// 6. token 透传给 adapter（go-git 用 BasicAuth，不需要 user 传）
	// v0.6.2: token 也用于 offset 越界时后台 deepen 认证。

	result, err := adapter.LogGraph(a.ctx, localPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
		Head:     head,
		Offset:   args.Offset,
		Token:    token,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 顺便返回 localPath（前端可显示"已 clone 在 ..."）
	return graphResultToAppDTO(result), nil
}

// GetGitGraphAscii 获取 git log --graph 字符流版本的 Git Graph。
//
// 主要用于 GitHub/gh partial clone 的超大仓库：让系统 git 直接输出 ASCII graph，
// 前端复用旧 parser 渲染，避免结构化 lane 算法在超大浅历史下生成过宽 SVG。
func (a *App) GetGitGraphAscii(args GetGitGraphArgs) (git.GraphLinesResult, error) {
	if a.logger != nil {
		a.logger.Info("GetGitGraphAscii", "projectId", args.ProjectID, "branches", args.Branches)
	}

	if args.ProjectID == "" {
		return git.GraphLinesResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return git.GraphLinesResult{}, err
	}
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)
	result, err := git.RunGraphLog(localPath, git.RunGraphLogOptions{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return git.GraphLinesResult{}, ipc.NewInternal(err.Error())
	}
	return *result, nil
}

// GetRepoByIdArgs 查项目参数
type GetRepoByIdArgs struct {
	ProjectID string `json:"projectId"`
}

// GetRepoByIdResult 查项目结果
type GetRepoByIdResult struct {
	// Project 项目的 RepoProjectDto（localStore.Projects 行的拷贝）
	Project store.RepoProject `json:"project"`
	// Account 项目的关联账号
	Account AccountDTO `json:"account"`
	// LocalPath 仓库本地路径（v2.4：按 owner+name + workspacePath 算）
	LocalPath string `json:"localPath"`
	// Cloned 本地是否已 clone（IsRepoCloned 检查）
	Cloned bool `json:"cloned"`
}

// GetRepoById 按 projectId 查项目 + 关联账号 + localPath + clone 状态
//
// v2.4 新增：前端"我选了哪个仓库"的关键信息聚合点
// 一次调用拿齐所有"画 Git Graph / 拉数据"所需的信息
func (a *App) GetRepoById(args GetRepoByIdArgs) (GetRepoByIdResult, error) {
	if args.ProjectID == "" {
		return GetRepoByIdResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GetRepoByIdResult{}, err
	}

	// v2.5：按账号分层
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)
	cloned := git.RepoExists(localPath)

	return GetRepoByIdResult{
		Project:   *project,
		Account:   accountToDTO(*account),
		LocalPath: localPath,
		Cloned:    cloned,
	}, nil
}

// findProjectAndAccount 内部 helper：按 projectId 找 project + 关联 account
//
// 找不到 project → NotFound
// 找到 project 但 account 已被删 → NotFound
func (a *App) findProjectAndAccount(projectID string) (*store.RepoProject, *store.GiteaAccount, error) {
	state := a.localStore.Get()

	var matchedProject *store.RepoProject
	for i := range state.Projects {
		if state.Projects[i].ID == projectID {
			matchedProject = &state.Projects[i]
			break
		}
	}
	if matchedProject == nil {
		return nil, nil, ipc.NewNotFound("未找到 project: " + projectID)
	}

	for i := range state.Accounts {
		if state.Accounts[i].ID == matchedProject.AccountID {
			return matchedProject, &state.Accounts[i], nil
		}
	}
	return nil, nil, ipc.NewNotFound(
		"project 关联的 account 不存在: projectId=" + projectID +
			" accountId=" + matchedProject.AccountID,
	)
}

// ===== 鉴权（步骤 2.x · v2.0 修复：token 接通链路）=====

// UserDTO 用户信息（暴露给前端，与 platform.UserDTO 对齐）
type UserDTO struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	FullName  string `json:"fullName,omitempty"`
	Email     string `json:"email,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// AccountDTO 账号信息（暴露给前端，与 store.GiteaAccount 对齐）
//
// 注：返回给前端**不**包含 token（AGENTS §8.2 鉴权铁律）
//
// 字段类型对齐 frontend/src/types/dto.ts 的 GiteaAccountDto：
//   - createdAt → ISO 8601 字符串（前端 formatDate / formatRelative 兼容 Date.parse）
//   - platform → "gitea" | "github"（v2 多平台）
type AccountDTO struct {
	ID              string    `json:"id"`
	Platform        string    `json:"platform"` // gitea | github
	GiteaURL        string    `json:"giteaUrl"`
	Username        string    `json:"username"`
	KeychainService string    `json:"keychainService"`
	CreatedAt       string    `json:"createdAt"` // ISO 8601 字符串
	UserInfo        *UserInfo `json:"userInfo,omitempty"`
}

// UserInfo 账号关联的用户信息
//
// 字段类型对齐 frontend/src/types/dto.ts 的 GiteaAccountDto.userInfo：
//   - updatedAt → ISO 8601 字符串
type UserInfo struct {
	GiteaUserID int64  `json:"giteaUserId"`
	Login       string `json:"login"`
	FullName    string `json:"fullName,omitempty"`
	Email       string `json:"email,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	UpdatedAt   string `json:"updatedAt"` // ISO 8601 字符串
}

// ConnectResult auth.connect 出参
type ConnectResult struct {
	Account AccountDTO `json:"account"`
	User    UserDTO    `json:"user"`
}

// StatusResult auth.status 出参
type StatusResult struct {
	Accounts    []AccountDTO `json:"accounts"`
	CurrentUser *UserDTO     `json:"currentUser,omitempty"`
}

// ConnectArgs auth.connect 入参
//
// v2 拍板：platform 从前端传入（"gitea" | "github"），URL 跟随 platform：
//   - gitea：用户填的 giteaUrl（自托管实例）
//   - github：固定 https://github.com（GitHub 公共 API）
type ConnectArgs struct {
	Platform string `json:"platform"`
	GiteaURL string `json:"giteaUrl"`
	Token    string `json:"token"`
}

// AuthConnect 验证 token + 写 keychain + 写 localStore 账号元信息
//
// 链路：
//  1. 校验 platform + url + token 非空（trim + 长度）
//  2. 调 adapter.VerifyToken 验证 token 有效性 + 拿用户信息
//  3. token 写 secret.Store（go-keyring / dev fallback）
//  4. localStore.Mutate 加 GiteaAccount（GiteaAccount.Platform 标 gitea/github）
//  5. 返 { account, user } 给前端
//
// 错误处理：
//   - 任何环节失败 → 返 *ipc.IpcError（前端 normalizeError 能正确识别）
//   - secret.Store 失败 → 已经写过的 keychain 也要回滚（Delete）
func (a *App) AuthConnect(args ConnectArgs) (ConnectResult, error) {
	platformName := strings.TrimSpace(args.Platform)
	if platformName == "" {
		return ConnectResult{}, ipc.NewValidationFailed("平台不能为空", "platform is empty")
	}
	if !platformAdapter.IsValid(platformName) {
		return ConnectResult{}, ipc.NewValidationFailed("不支持的平台", "platform="+platformName)
	}

	giteaURL := strings.TrimSpace(args.GiteaURL)
	token := strings.TrimSpace(args.Token)

	// GitHub 固定 URL 用 **API** 域名(不是 https://github.com 网站)
	//
	// 历史 bug(v2.x 修复前):这里写的是 https://github.com,
	// 然后 VerifyToken 拼成 https://github.com/user → 命中 GitHub 网站 HTML 页面
	// → 网站对 Accept: application/vnd.github+json 返 406 Not Acceptable
	// → 用户看到「输入有误:GitHub 不接受请求格式(HTTP 406)」
	//
	// 正确路径:https://api.github.com/user(API endpoint)
	//   - GitHubAPIBase 常量定义在 app/platform/github/adapter.go
	//   - 这里直接引用,避免硬编码漂移
	if platformName == string(platformAdapter.GitHub) {
		if _, err := exec.LookPath("gh"); err != nil {
			return ConnectResult{}, &ipc.IpcError{
				Code:    ipc.CodeValidationFailed,
				Message: "使用 GitHub 仓库需要先安装 GitHub CLI（gh）",
				Hint:    "请安装 gh 后重新连接 GitHub 账号；本应用会用它快速加载超大仓库提交记录",
				Cause:   err.Error(),
			}
		}
		giteaURL = github.GitHubAPIBase
	} else {
		if giteaURL == "" {
			return ConnectResult{}, ipc.NewValidationFailed("gitea 地址不能为空", "url is empty")
		}
		if u, err := url.Parse(giteaURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return ConnectResult{}, ipc.NewValidationFailed("gitea 地址必须以 http:// 或 https:// 开头", giteaURL)
		}
	}
	if len(token) < 8 {
		return ConnectResult{}, ipc.NewValidationFailed("令牌长度至少 8 个字符", fmt.Sprintf("len=%d", len(token)))
	}

	adapter := a.getAdapter(platformName)
	if adapter == nil {
		return ConnectResult{}, ipc.NewInternal("平台适配器未初始化: " + platformName)
	}

	// 1. 校验 token + 拿用户信息
	if a.logger != nil {
		a.logger.Info("AuthConnect: verifying token", "platform", platformName, "url", giteaURL)
	}
	user, err := adapter.VerifyToken(a.ctx, giteaURL, token)
	if err != nil {
		// adapter 返回的 *ipc.IpcError 已经结构化（带 code + hint）
		// 兜底：万一是非 IpcError，包成 internal
		var ipcErr *ipc.IpcError
		if !errorsAs(err, &ipcErr) {
			return ConnectResult{}, ipc.NewInternal("验证 token 失败：" + err.Error())
		}
		return ConnectResult{}, err
	}

	// 2. 写 keychain（先写，写成功再加账号；失败抛 keychain 错误）
	keychainService := secret.KeyringService(platformName, giteaURL)
	if err := a.secretStore.Set(secret.Credential{
		Platform: platformName,
		HostURL:  giteaURL,
		Username: user.Login,
		Token:    token,
	}); err != nil {
		return ConnectResult{}, classifyKeychainError(err)
	}

	// 3. localStore 加账号（幂等：已存在的同 URL+username 账号不重复加）
	now := time.Now().UnixMilli()
	accountID := ""
	var createdAccount store.GiteaAccount
	addedNew := false
	if err := a.localStore.Mutate(func(s *store.LocalState) {
		for i := range s.Accounts {
			if s.Accounts[i].GiteaURL == giteaURL && s.Accounts[i].Username == user.Login && s.Accounts[i].Platform == platformName {
				// 复用旧账号 ID，仅刷新 userInfo
				accountID = s.Accounts[i].ID
				s.Accounts[i].UserInfo = &store.UserInfo{
					GiteaUserID: user.ID,
					Login:       user.Login,
					FullName:    user.FullName,
					Email:       user.Email,
					AvatarURL:   user.AvatarURL,
					UpdatedAt:   now,
				}
				createdAccount = s.Accounts[i]
				return
			}
		}
		// 新账号
		newAccount := store.GiteaAccount{
			ID:              uuid.NewString(),
			Platform:        platformName,
			GiteaURL:        giteaURL,
			Username:        user.Login,
			KeychainService: keychainService,
			CreatedAt:       now,
			UserInfo: &store.UserInfo{
				GiteaUserID: user.ID,
				Login:       user.Login,
				FullName:    user.FullName,
				Email:       user.Email,
				AvatarURL:   user.AvatarURL,
				UpdatedAt:   now,
			},
		}
		s.Accounts = append(s.Accounts, newAccount)
		createdAccount = newAccount
		accountID = newAccount.ID
		addedNew = true
	}); err != nil {
		// localStore 写失败 → 回滚 keychain
		_ = a.secretStore.Delete(platformName, giteaURL, user.Login)
		return ConnectResult{}, ipc.NewInternal("保存账号元信息失败：" + err.Error())
	}

	if a.logger != nil {
		if addedNew {
			a.logger.Info("AuthConnect: account added", "accountId", accountID, "username", user.Login)
		} else {
			a.logger.Info("AuthConnect: account updated", "accountId", accountID, "username", user.Login)
		}
	}

	return ConnectResult{
		Account: accountToDTO(createdAccount),
		User:    userToDTO(user),
	}, nil
}

// AuthStatus 返回所有账号 + 当前用户（**不**含 token）
func (a *App) AuthStatus() (StatusResult, error) {
	if a.localStore == nil {
		return StatusResult{}, ipc.NewInternal("localStore 未初始化")
	}
	state := a.localStore.Get()

	accounts := make([]AccountDTO, 0, len(state.Accounts))
	for _, acc := range state.Accounts {
		accounts = append(accounts, accountToDTO(acc))
	}

	// currentUser = 第一个账号的 userInfo
	var currentUser *UserDTO
	if len(state.Accounts) > 0 && state.Accounts[0].UserInfo != nil {
		u := userInfoToDTO(*state.Accounts[0].UserInfo)
		currentUser = &u
	}

	return StatusResult{
		Accounts:    accounts,
		CurrentUser: currentUser,
	}, nil
}

// DisconnectArgs auth.disconnect 入参（按 giteaUrl 定位，删整站所有账号）
type DisconnectArgs struct {
	GiteaURL string `json:"giteaUrl"`
}

// AuthDisconnect 断开某个 gitea URL 的所有账号（删 keychain + 删 localStore 记录）
func (a *App) AuthDisconnect(args DisconnectArgs) error {
	return a.disconnectImpl(args.GiteaURL, "")
}

// DisconnectOneArgs auth.disconnectOne 入参（按 giteaUrl + username 精确定位单个账号）
type DisconnectOneArgs struct {
	GiteaURL string `json:"giteaUrl"`
	Username string `json:"username"`
}

// AuthDisconnectOne 断开单个账号（删 keychain + 删 localStore 单条记录）
func (a *App) AuthDisconnectOne(args DisconnectOneArgs) error {
	return a.disconnectImpl(args.GiteaURL, args.Username)
}

// RemoveWorkspaceReposArgs 移除账号 workspace 仓库的入参
type RemoveWorkspaceReposArgs struct {
	Username string `json:"username"`
}

// RemoveWorkspaceReposResult 移除结果
type RemoveWorkspaceReposResult struct {
	RemovedCount int    `json:"removedCount"` // 被删除的仓库数量（-1 = 账号目录不存在，幂等成功）
	Message      string `json:"message"`      // 供前端 toast 展示
}

// RemoveWorkspaceRepos 删除指定账号下的所有 workspace 仓库
//
// 调用方：AccountManagerDialog 移除账号时同步清理该账号 clone 的仓库数据。
//
// 安全策略：
//   - 只删 ${workspacePath}/repos/${username}/ 目录
//   - 二次确认由前端 UI 保证（本函数不弹窗）
func (a *App) RemoveWorkspaceRepos(args RemoveWorkspaceReposArgs) (RemoveWorkspaceReposResult, error) {
	username := strings.TrimSpace(args.Username)
	if username == "" {
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "用户名不能为空"},
			ipc.NewValidationFailed("用户名不能为空", "")
	}

	wm := git.NewWorkspaceManager()
	count, err := wm.RemoveReposForAccount(a.workspacePath, username)
	if err != nil {
		a.logger.Error("RemoveWorkspaceRepos failed", "username", username, "err", err)
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "删除失败: " + err.Error()}, err
	}

	if count < 0 {
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "账号无本地仓库数据，无需清理"}, nil
	}

	msg := fmt.Sprintf("已清理 %d 个仓库的本地数据", count)
	if count == 0 {
		msg = "账号无本地仓库数据，无需清理"
	}
	a.logger.Info("RemoveWorkspaceRepos done", "username", username, "removed_count", count)
	return RemoveWorkspaceReposResult{RemovedCount: count, Message: msg}, nil
}

// disconnectImpl 共用断开逻辑
//
// username 为空 → 删整站（GiteaURL 所有 username）；否则只删单个
func (a *App) disconnectImpl(giteaURL, username string) error {
	giteaURL = strings.TrimSpace(giteaURL)
	if giteaURL == "" {
		return ipc.NewValidationFailed("gitea 地址不能为空", "")
	}

	// 1. 找要删的账号
	state := a.localStore.Get()
	var toDelete []store.GiteaAccount
	for _, acc := range state.Accounts {
		if acc.GiteaURL != giteaURL {
			continue
		}
		if username != "" && acc.Username != username {
			continue
		}
		toDelete = append(toDelete, acc)
	}
	if len(toDelete) == 0 {
		return ipc.NewNotFound("账号不存在：" + giteaURL + " " + username)
	}

	// 2. 删 keychain（先删本地，再删远端凭据；本地删失败也不阻断远端）
	for _, acc := range toDelete {
		if err := a.secretStore.Delete(acc.Platform, acc.GiteaURL, acc.Username); err != nil {
			if a.logger != nil {
				a.logger.Warn("AuthDisconnect: keychain delete failed", "err", err, "username", acc.Username)
			}
		}
	}

	// 3. 删 localStore
	return a.localStore.Mutate(func(s *store.LocalState) {
		kept := make([]store.GiteaAccount, 0, len(s.Accounts))
		for _, acc := range s.Accounts {
			if acc.GiteaURL == giteaURL && (username == "" || acc.Username == username) {
				continue
			}
			kept = append(kept, acc)
		}
		s.Accounts = kept
	})
}

// SwitchAccountArgs auth.switchAccount 入参（按 accountId 重排 accounts 顺序）
type SwitchAccountArgs struct {
	AccountID string `json:"accountId"`
}

// AuthSwitchAccount 切换当前活跃账号（重排 accounts 顺序：指定 ID 变第一）
//
// UI 用途：账号管理弹窗里"切到该账号"按钮 → 把指定账号提到首位 → AuthStatus 返回的 currentUser 跟着变
func (a *App) AuthSwitchAccount(args SwitchAccountArgs) error {
	accountID := strings.TrimSpace(args.AccountID)
	if accountID == "" {
		return ipc.NewValidationFailed("账号 ID 不能为空", "")
	}

	state := a.localStore.Get()
	targetIdx := -1
	for i, acc := range state.Accounts {
		if acc.ID == accountID {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return ipc.NewNotFound("账号不存在：" + accountID)
	}
	if targetIdx == 0 {
		// 已经是首位 → noop
		return nil
	}

	return a.localStore.Mutate(func(s *store.LocalState) {
		// 把 target 提到第一位（其他相对顺序不变）
		target := s.Accounts[targetIdx]
		s.Accounts = append(s.Accounts[:targetIdx], s.Accounts[targetIdx+1:]...)
		s.Accounts = append([]store.GiteaAccount{target}, s.Accounts...)
	})
}

// ===== auth 辅助函数 =====

// accountToDTO 把 store.GiteaAccount 转成 AccountDTO
//
// epoch ms → ISO 8601 字符串对齐前端 GiteaAccountDto 契约
func accountToDTO(acc store.GiteaAccount) AccountDTO {
	dto := AccountDTO{
		ID:              acc.ID,
		Platform:        acc.Platform,
		GiteaURL:        acc.GiteaURL,
		Username:        acc.Username,
		KeychainService: acc.KeychainService,
		CreatedAt:       epochMsToISO(acc.CreatedAt),
	}
	if acc.UserInfo != nil {
		ui := UserInfo{
			GiteaUserID: acc.UserInfo.GiteaUserID,
			Login:       acc.UserInfo.Login,
			FullName:    acc.UserInfo.FullName,
			Email:       acc.UserInfo.Email,
			AvatarURL:   acc.UserInfo.AvatarURL,
			UpdatedAt:   epochMsToISO(acc.UserInfo.UpdatedAt),
		}
		dto.UserInfo = &ui
	}
	return dto
}

// userToDTO 把 platform.UserDTO 转成 App 的 UserDTO
func userToDTO(u *platformAdapter.UserDTO) UserDTO {
	if u == nil {
		return UserDTO{}
	}
	return UserDTO{
		ID:        u.ID,
		Login:     u.Login,
		FullName:  u.FullName,
		Email:     u.Email,
		AvatarURL: u.AvatarURL,
	}
}

// userInfoToDTO 把 store.UserInfo 转成 UserDTO
//
// epoch ms → ISO 8601 字符串对齐前端契约
func userInfoToDTO(u store.UserInfo) UserDTO {
	return UserDTO{
		ID:        u.GiteaUserID,
		Login:     u.Login,
		FullName:  u.FullName,
		Email:     u.Email,
		AvatarURL: u.AvatarURL,
	}
}

// epochMsToISO 把 epoch 毫秒转 ISO 8601 字符串（前端 new Date() 兼容）
//
// 0（未设置）→ 空字符串，让前端走"未设置"分支而不是显示 1970-01-01
func epochMsToISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

// errorsAs 是 errors.As 的薄封装（让 auth 流程读起来更顺眼）
//
// 用法：var ipcErr *ipc.IpcError; if errorsAs(err, &ipcErr) { ... }
func errorsAs(err error, target interface{}) bool {
	return errors.As(err, target)
}

// classifyKeychainError 把 secret.Store 的错误映射成 *ipc.IpcError
func classifyKeychainError(err error) *ipc.IpcError {
	msg := err.Error()
	// Linux 上 keyring 不可用时的常见错误
	if strings.Contains(msg, "keyring") ||
		strings.Contains(msg, "dbus") ||
		strings.Contains(msg, "Secret Service") ||
		strings.Contains(msg, "not supported") {
		return ipc.NewKeychainUnavailable(msg)
	}
	// 拒绝访问（macOS 用户拒绝授权 / Windows ACL）
	if strings.Contains(msg, "access denied") ||
		strings.Contains(msg, "permission denied") ||
		strings.Contains(msg, "User cancelled") {
		return ipc.NewKeychainAccessDenied(msg)
	}
	return ipc.NewInternal("凭证存储失败：" + msg)
}

// WorkspaceInfo GetWorkspace 返回值结构（对齐前端 ipc-client.ts 契约）
type WorkspaceInfo struct {
	// DataRoot 数据根目录（用户可感知的"全局路径"，默认 ~/.gitea-kanban）
	// 应用的所有持久化数据 (state.json / logs / workspace) 都放在 DataRoot 下。
	// 启动期若不存在自动 mkdir -p。
	DataRoot string `json:"dataRoot"`
	// WorkspacePath 内部 git 仓库目录 (= DataRoot + "/workspace")
	// 由应用根据业务自动创建，前端不应让用户直接选择这个路径
	// (用户只选 DataRoot 即可，workspace 是应用内部约定)。
	WorkspacePath string `json:"workspacePath"`
	IsDefault     bool   `json:"isDefault"`
	Validated     bool   `json:"validated"`
}

// GetWorkspace 返回当前数据根目录（**用户可感知的"全局路径"**）
//
// v2.x 重新设计：用户选的是数据根目录 (DataRoot)，不是 workspace 子目录
//   - DataRoot = ${GITEA_KANBAN_DATA_DIR | ~/.gitea-kanban} (启动期确定)
//   - WorkspacePath = ${DataRoot}/workspace (应用自动创建)
//   - 前端展示 DataRoot，git 操作走 WorkspacePath
func (a *App) GetWorkspace() WorkspaceInfo {
	root := a.dataDir
	wsPath := a.workspacePath

	// 校验路径是否可写（前端 SettingsView 仍展示状态）
	validated := true
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		validated = false
	}

	return WorkspaceInfo{
		DataRoot:      root,
		WorkspacePath: wsPath,
		IsDefault:     true, // 永远默认（不可改）
		Validated:     validated,
	}
}

// SetWorkspaceArgs 设置 workspace 参数
type SetWorkspaceArgs struct {
	Cwd string `json:"cwd"`
}

// SetWorkspace 设置 workspace 路径
//
// v2.2 user 拍板：路径不可改。本方法保留为 stub 返回 error（前端不再调用，但 App.d.ts 还有 binding）
// 任何调用都拒绝，error 走 slog 记录
func (a *App) SetWorkspace(args SetWorkspaceArgs) error {
	if a.logger != nil {
		a.logger.Warn("SetWorkspace called but workspace path is no longer user-configurable (v2.2)",
			"requestedCwd", args.Cwd)
	}
	return ipc.NewValidationFailed(
		"工作区路径不可修改",
		"v2.2 后 workspace 固定为 ${dataDir}/workspace，无法自定义",
	)
}

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
	var matchedPlatform string
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
			matchedPlatform = p.Platform
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
	token, e = a.secretStore.Get(matchedPlatform, matchedAccount.GiteaURL, matchedAccount.Username)
	if e != nil {
		return "", "", classifyKeychainError(e)
	}
	if token == "" {
		return "", "", ipc.NewInternal("token 为空：keychain 里有记录但 token 字符串为空")
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

// ===== v2.3 仓库管理（StatusBar 刷新按钮 + selectProject）=====

// ListReposArgs 列仓库参数
//
// v2.3 修复：前端 StatusBar 刷新按钮原来"没反应"的根本原因
//   - 旧版 shim repos.list 是 stub，永远返 {items: [], hasMore: false}
//   - 用户点刷新 → 拉 0 个仓库 → 没法选
//   - 修复：Go 端 ListRepos 调 platform.ListRepos，merge isProject/lastSyncAt
type ListReposArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Query          string `json:"query,omitempty"`
	Limit          int    `json:"limit"`
	Page           int    `json:"page"`
}

// ListReposResp 列仓库响应
type ListReposResp struct {
	Items   []platformAdapter.RepoDTO `json:"items"`
	Total   int                       `json:"total"`
	Page    int                       `json:"page"`
	HasMore bool                      `json:"hasMore"`
}

// ListRepos 列出某账号可访问的仓库
//
// 步骤：
//  1. localStore.Accounts 找 giteaAccountID 对应的 account
//  2. secretStore.Get 拿 token
//  3. adapter.ListRepos 拉远端列表
//  4. merge localStore.Projects 标记 isProject / lastSyncAt
func (a *App) ListRepos(args ListReposArgs) (ListReposResp, error) {
	// v0.6.0 生成 reqID，让 ListRepos 内部所有日志能贯穿
	ctx := a.newBindingCtx("ListRepos")
	defer logx.Recover(a.logger, "ListRepos")

	if a.logger != nil {
		a.logger.InfoContext(ctx, "ListRepos",
			"giteaAccountId", args.GiteaAccountID,
			"query", args.Query,
			"page", args.Page,
		)
	}

	// 1. 找 account
	state := a.localStore.Get()
	var matched *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == args.GiteaAccountID {
			matched = &state.Accounts[i]
			break
		}
	}
	if matched == nil {
		return ListReposResp{}, ipc.NewNotFound("未找到账号: " + args.GiteaAccountID)
	}

	// 2. 拿 token
	token, err := a.secretStore.Get(matched.Platform, matched.GiteaURL, matched.Username)
	if err != nil {
		return ListReposResp{}, classifyKeychainError(err)
	}
	if token == "" {
		return ListReposResp{}, ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}

	// 3. 远端拉
	adapter := a.getAdapter(matched.Platform)
	if adapter == nil {
		return ListReposResp{}, ipc.NewUnsupportedPlatform(matched.Platform)
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 50
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	remoteRepos, err := adapter.ListRepos(a.ctx, matched.GiteaURL, matched.Username, token, platformAdapter.ListReposOpts{
		Query: args.Query,
		Limit: limit,
		Page:  page,
	})
	if err != nil {
		return ListReposResp{}, err
	}

	// 4. merge isProject / lastSyncAt（按 owner+name 匹配）
	projects := state.Projects
	nowISO := time.Now().UTC().Format(time.RFC3339)
	_ = nowISO // 占位
	for i := range remoteRepos {
		for j := range projects {
			if projects[j].Platform == matched.Platform &&
				projects[j].AccountID == matched.ID &&
				projects[j].Owner == remoteRepos[i].Owner &&
				projects[j].Name == remoteRepos[i].Name {
				remoteRepos[i].IsProject = true
				remoteRepos[i].ProjectID = projects[j].ID
				if projects[j].LastSyncAt > 0 {
					remoteRepos[i].LastSyncAt = time.UnixMilli(projects[j].LastSyncAt).UTC().Format(time.RFC3339)
				}
				break
			}
		}
	}

	return ListReposResp{
		Items:   remoteRepos,
		Total:   len(remoteRepos),
		Page:    page,
		HasMore: len(remoteRepos) >= limit, // gitea /repos/search 返 data 数组不含 total，简单按 limit 估
	}, nil
}

// AddProjectArgs 加 project 参数
type AddProjectArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Owner          string `json:"owner"`
	Name           string `json:"name"`
}

// AddProjectResult 加 project 结果
type AddProjectResult struct {
	Project store.RepoProject `json:"project"`
}

// AddProject 标记仓库为本机 project
//
// 跟 CloneRepo 的自动加 project 是独立的：
//   - CloneRepo 加 project 是 "已 clone" 语义（lastSyncAt = now）
//   - AddProject 加 project 是 "已加入看板" 语义（lastSyncAt = 0，未 clone）
//
// 后续 PullRepo 找 token 依赖 Projects → 这条不能漏
func (a *App) AddProject(args AddProjectArgs) (AddProjectResult, error) {
	if a.logger != nil {
		a.logger.Info("AddProject", "giteaAccountId", args.GiteaAccountID, "owner", args.Owner, "name", args.Name)
	}

	if args.Owner == "" || args.Name == "" {
		return AddProjectResult{}, ipc.NewValidationFailed("owner/name 不能为空",
			fmt.Sprintf("owner=%q name=%q", args.Owner, args.Name))
	}

	// 1. 找 account
	state := a.localStore.Get()
	var matched *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == args.GiteaAccountID {
			matched = &state.Accounts[i]
			break
		}
	}
	if matched == nil {
		return AddProjectResult{}, ipc.NewNotFound("未找到账号: " + args.GiteaAccountID)
	}

	// 2. 幂等：已存在则返回原 project
	for i := range state.Projects {
		if state.Projects[i].Platform == matched.Platform &&
			state.Projects[i].AccountID == matched.ID &&
			state.Projects[i].Owner == args.Owner &&
			state.Projects[i].Name == args.Name {
			return AddProjectResult{Project: state.Projects[i]}, nil
		}
	}

	// 3. 新建
	now := time.Now().UnixMilli()
	project := store.RepoProject{
		ID:        uuid.NewString(),
		Platform:  matched.Platform,
		AccountID: matched.ID,
		Owner:     args.Owner,
		Name:      args.Name,
		CreatedAt: now,
	}
	if err := a.localStore.Mutate(func(s *store.LocalState) {
		s.Projects = append(s.Projects, project)
	}); err != nil {
		return AddProjectResult{}, ipc.NewInternal("保存 project 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("AddProject: created", "projectId", project.ID, "owner", args.Owner, "name", args.Name)
	}
	return AddProjectResult{Project: project}, nil
}

// RemoveProjectArgs 删 project 参数
type RemoveProjectArgs struct {
	ProjectID string `json:"projectId"`
}

// RemoveProject 取消仓库的本机 project 标记（**不**删远端仓库 / **不**删本地 clone）
func (a *App) RemoveProject(args RemoveProjectArgs) error {
	if a.logger != nil {
		a.logger.Info("RemoveProject", "projectId", args.ProjectID)
	}
	if args.ProjectID == "" {
		return ipc.NewValidationFailed("projectId 不能为空", "")
	}
	return a.localStore.Mutate(func(s *store.LocalState) {
		kept := make([]store.RepoProject, 0, len(s.Projects))
		for _, p := range s.Projects {
			if p.ID == args.ProjectID {
				continue
			}
			kept = append(kept, p)
		}
		s.Projects = kept
	})
}

// ===== 分支列表/收藏（步骤 3.2）=====

// BranchDTO 分支信息（暴露给前端）
type BranchDTO struct {
	Name        string `json:"name"`
	CommitSHA   string `json:"commitSha"`
	IsProtected bool   `json:"isProtected"`
}

// ListBranchesArgs 列分支参数
type ListBranchesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// ListBranches 列出仓库分支
func (a *App) ListBranches(args ListBranchesArgs) ([]BranchDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	branches, err := adapter.ListBranches(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo)
	if err != nil {
		return nil, err
	}

	result := make([]BranchDTO, 0, len(branches))
	for _, b := range branches {
		result = append(result, BranchDTO{
			Name:        b.Name,
			CommitSHA:   b.CommitSHA,
			IsProtected: b.IsProtected,
		})
	}
	return result, nil
}

// StarBranchArgs 收藏分支参数
type StarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// StarBranch 收藏分支（本地 localStore.starredBranches）
func (a *App) StarBranch(args StarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		// 避免重复收藏
		for _, sb := range s.StarredBranches {
			if sb.ProjectID == args.ProjectID && sb.Branch == args.Branch {
				return
			}
		}
		s.StarredBranches = append(s.StarredBranches, store.StarredBranch{
			ID:        uuid.NewString(),
			ProjectID: args.ProjectID,
			Branch:    args.Branch,
			CreatedAt: time.Now().UnixMilli(),
		})
	})
}

// UnstarBranchArgs 取消收藏分支参数
type UnstarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// UnstarBranch 取消收藏分支
func (a *App) UnstarBranch(args UnstarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		s.StarredBranches = filterStarredBranches(s.StarredBranches, args.ProjectID, args.Branch)
	})
}

// ListStarredBranchesArgs 列出收藏的分支
type ListStarredBranchesArgs struct {
	ProjectID string `json:"projectId"`
}

// ListStarredBranches 列出某项目收藏的分支
func (a *App) ListStarredBranches(args ListStarredBranchesArgs) ([]string, error) {
	state := a.localStore.Get()
	branches := make([]string, 0)
	for _, sb := range state.StarredBranches {
		if sb.ProjectID == args.ProjectID {
			branches = append(branches, sb.Branch)
		}
	}
	return branches, nil
}

// filterStarredBranches 过滤掉指定 project+branch 的收藏
func filterStarredBranches(branches []store.StarredBranch, projectID, branch string) []store.StarredBranch {
	result := make([]store.StarredBranch, 0, len(branches))
	for _, sb := range branches {
		if sb.ProjectID == projectID && sb.Branch == branch {
			continue
		}
		result = append(result, sb)
	}
	return result
}

// ===== commit 详情 + diff（步骤 3.3）=====

// CommitDetailDTO commit 详情（暴露给前端）
//
// v2.15 扩展：新增 Files / Additions / Deletions / FilesChanged 字段
// （从 GetCommitDiff + commit.Stats() 合并而来）。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 DTO 只有 8 个元信息字段，
// 完全没有文件变更数据，前端 CommitDetailPanel 永远拿不到 files。
type CommitDetailDTO struct {
	SHA          string          `json:"sha"`
	ShortSHA     string          `json:"shortSha"`
	Subject      string          `json:"subject"`
	AuthorName   string          `json:"authorName"`
	AuthorEmail  string          `json:"authorEmail"`
	AuthorWhen   string          `json:"authorWhen"`
	Message      string          `json:"message"`
	Parents      []string        `json:"parents"`
	Files        []FileChangeDTO `json:"files,omitempty"`        // 变更文件列表（含 +/- 行数）
	Additions    int             `json:"additions,omitempty"`    // 总新增行数
	Deletions    int             `json:"deletions,omitempty"`    // 总删除行数
	FilesChanged int             `json:"filesChanged,omitempty"` // 变更文件数
}

// FileChangeDTO 文件变更（前端 CommitDetailPanel 用）
//
// 字段命名跟前端 interface 对齐：
//   - Filename    （对应后端 Path）
//   - PreviousFilename （对应后端 OldPath）
//   - Status      （对应后端 Action：added/modified/deleted/renamed）
type FileChangeDTO struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previousFilename,omitempty"`
	Status           string `json:"status"` // added / modified / deleted / renamed
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Binary           bool   `json:"binary,omitempty"` // v2.15 暂不支持（go-git 无标记）
}

// GetCommitDetailArgs 获取 commit 详情参数
type GetCommitDetailArgs struct {
	LocalPath string `json:"localPath"`
	SHA       string `json:"sha"`
}

// GetCommitDetail 获取单个 commit 的详情（go-git）
//
// v2.15 扩展：除了元信息（message / author），还调 GetCommitDiff 拿文件变更列表，
// 计算 totals（Additions / Deletions / FilesChanged）填到 DTO。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 handler 只填元信息字段。
func (a *App) GetCommitDetail(args GetCommitDetailArgs) (CommitDetailDTO, error) {
	repo, err := git.OpenRepo(args.LocalPath)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	commit, err := repo.GetCommit(args.SHA)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	dto := CommitDetailDTO{
		SHA:         commit.SHA,
		ShortSHA:    commit.ShortSHA,
		Subject:     commit.Subject,
		AuthorName:  commit.AuthorName,
		AuthorEmail: commit.AuthorEmail,
		AuthorWhen:  commit.AuthorWhen,
		Message:     commit.Message,
		Parents:     commit.Parents,
	}

	// v2.15：调 GetCommitDiff 拿文件变更 + 累计 +/- 行数
	files, diffErr := repo.GetCommitDiff(args.SHA)
	if diffErr != nil {
		// diff 失败不阻塞主流程（meta 数据仍返回），只 log 警告
		a.logger.Warn("GetCommitDetail: GetCommitDiff failed", "sha", args.SHA, "err", diffErr)
	} else {
		dto.Files = make([]FileChangeDTO, 0, len(files))
		for _, f := range files {
			dto.Files = append(dto.Files, FileChangeDTO{
				Filename:         f.Path,
				PreviousFilename: f.OldPath,
				Status:           f.Action,
				Additions:        f.Additions,
				Deletions:        f.Deletions,
			})
			dto.Additions += f.Additions
			dto.Deletions += f.Deletions
		}
		dto.FilesChanged = len(files)
	}

	return dto, nil
}

// ===== 拉取/同步（步骤 3.4）=====

// PullRepoArgs 拉取参数
//
// v2.3 修复：token 不再走 IPC（AGENTS §8.2 鉴权铁律）
//   - 旧版前端传 token → 违反铁律
//   - 新版 Go 端从 localPath 反查 localStore.Projects 找到 projectId → accountId
//     → secretStore.Get(platform, hostUrl, username) 拿 token
type PullRepoArgs struct {
	LocalPath string `json:"localPath"`
}

// PullRepoResult 拉取结果
type PullRepoResult struct {
	BeforeCount  int    `json:"beforeCount"`
	AfterCount   int    `json:"afterCount"`
	AddedCommits int    `json:"addedCommits"`
	HeadBefore   string `json:"headBefore"`
	HeadAfter    string `json:"headAfter"`
	// HeadChanged HEAD SHA 是否变化（force push 场景 commit 数减少但 SHA 变了）
	HeadChanged bool `json:"headChanged"`
}

// PullRepo 拉取远端更新（fetch + 统计 commit 变化）
func (a *App) PullRepo(args PullRepoArgs) (PullRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("PullRepo", "path", args.LocalPath)
	}

	// v2.3：从 localPath 反查 token
	token, username, err := a.resolveTokenByLocalPath(args.LocalPath)
	if err != nil {
		return PullRepoResult{}, err
	}

	result, err := git.PullRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     token,
		Username:  username,
	})
	if err != nil {
		return PullRepoResult{}, err
	}

	return PullRepoResult{
		BeforeCount:  result.BeforeCount,
		AfterCount:   result.AfterCount,
		AddedCommits: result.AddedCommits,
		HeadBefore:   result.HeadBefore,
		HeadAfter:    result.HeadAfter,
		HeadChanged:  result.HeadChanged,
	}, nil
}

// PullRepoByProjectIdArgs 按 projectId 拉取参数（v2.4）
type PullRepoByProjectIdArgs struct {
	ProjectID string `json:"projectId"`
}

// PullRepoByProjectId 按 projectId 拉取（Go 端反查 localPath + token）
//
// 修复 StatusBar 更新按钮 localPath 拼接 bug：
//   - 旧前端 `~/.gitea-kanban/workspace/repos/...` → Go 端拒绝（带 ~）
//   - 新版：前端只传 projectId，Go 端按 owner+repo 算 localPath（用 workspacePath + RepoLocalPath）
func (a *App) PullRepoByProjectId(args PullRepoByProjectIdArgs) (PullRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("PullRepoByProjectId", "projectId", args.ProjectID)
	}

	if args.ProjectID == "" {
		return PullRepoResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// 1-2. 找 project + account
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return PullRepoResult{}, err
	}

	// 3. 算 localPath（v2.5：按账号分层）
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	// 4. 拿 token
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return PullRepoResult{}, classifyKeychainError(err)
	}
	if token == "" {
		return PullRepoResult{}, ipc.NewInternal("token 为空")
	}

	if account.Platform == "github" {
		if gh, ok := a.githubAdapter.(*github.GitHubAdapter); ok {
			_ = gh.EnsureForkParentRemote(a.ctx, account.GiteaURL, token, project.Owner, project.Name, localPath)
		}
	}

	// 5. 调 git.PullRepo（v2.6：装 progress 回调）
	//
	// v0.6.3 架构调整（user 拍板 2026-07-04）：
	//   去掉所有 hardcoded fetch depth 限制，由用户掌控要加载多少 commit 到本地。
	//   配合 loadMoreGraph 动态加载，首次 sync 可以拉全量元数据（depth=0），
	//   需要用户主动权衡磁盘/网络代价（UnrealEngine 全量 ~28 GB 元数据）。
	//
	//   - depth=0：fetch 全量 commit + tree 元数据（不下载 blob，blobless + NoCheckout 仍然生效）
	//   - countLimit=0：精确统计全量 commit 数（usedCountLimit=0 时 go-git 走全量遍历）
	//   - singleBranch=false：fetch 所有分支（refs/heads/* + refs/tags/*），不限定为默认分支
	//   - noTags=false：fetch tag refs（不走 git.NoTags）
	//
	// 旧 v2.7~v2.9 设计的 singleBranch / isHugeRepo 启发式判断（unreal/chromium/linux/webkit
	// 关键词）全部移除——这逻辑是过渡期 hack，现在 Git Graph 有动态加载后不再需要。

	result, err := git.PullRepo(git.PullOptions{
		LocalPath: localPath,
		Token:     token,
		Username:  account.Username,
		// v0.6.3：depth=0（全量元数据），countLimit=0（精确统计全部）
		// GitHub / Gitea 统一走完整 fetch，不再按平台差异化限制
		CountLimit:   0,
		Depth:        0,
		SingleBranch: false,
		NoTags:       false,
		Progress:     a.buildSyncProgressCallback(project.Owner + "/" + project.Name),
		UseGitHubCLI: account.Platform == "github",
	})
	if err != nil {
		// v2.6 错误溯源：wrap 时把 owner/repo/localPath 一并带上
		//   之前只 wrap "fetch 失败" 这种话，前端 normalize 后只看到 '未知错误'
		//   现在 include 路径 + 原始 err.Error() 让前端能展示'打开仓库失败: <real err>'
		//   注：slog INFO 已经在入口打了 projectId；这里 ERROR 是冗余但更精准
		if a.logger != nil {
			a.logger.Error("PullRepoByProjectId: pull failed",
				"owner", project.Owner,
				"repo", project.Name,
				"localPath", localPath,
				"err", err.Error(),
			)
		}
		return PullRepoResult{}, err
	}

	return PullRepoResult{
		BeforeCount:  result.BeforeCount,
		AfterCount:   result.AfterCount,
		AddedCommits: result.AddedCommits,
		HeadBefore:   result.HeadBefore,
		HeadAfter:    result.HeadAfter,
		HeadChanged:  result.HeadChanged,
	}, nil
}

// FetchRepoResultDTO fetch 结果
type FetchRepoResultDTO struct {
	Updated bool `json:"updated"`
}

// FetchRepo 仅 fetch（不 merge）
func (a *App) FetchRepo(args PullRepoArgs) (FetchRepoResultDTO, error) {
	token, username, err := a.resolveTokenByLocalPath(args.LocalPath)
	if err != nil {
		return FetchRepoResultDTO{}, err
	}

	result, err := git.FetchRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     token,
		Username:  username,
	})
	if err != nil {
		return FetchRepoResultDTO{}, err
	}
	return FetchRepoResultDTO{Updated: result.Updated}, nil
}

// ===== 看板（issue + label 映射，仅 Gitea）（步骤 3.5）=====

// IssueDTO 议题（暴露给前端）
type IssueDTO struct {
	Index  int    `json:"index"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Body   string `json:"body,omitempty"`
	Author string `json:"author"`
}

// ListIssuesArgs 列议题参数
type ListIssuesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
	State    string `json:"state"` // open | closed | all
}

// ListIssues 列出仓库议题（仅 Gitea 完整支持）
func (a *App) ListIssues(args ListIssuesArgs) ([]IssueDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	issues, err := adapter.ListIssues(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo, platformAdapter.ListIssuesOpts{
		State: args.State,
	})
	if err != nil {
		return nil, err
	}

	result := make([]IssueDTO, 0, len(issues))
	for _, i := range issues {
		result = append(result, IssueDTO{
			Index:  i.Index,
			Title:  i.Title,
			State:  i.State,
			Body:   i.Body,
			Author: i.Author,
		})
	}
	return result, nil
}

// ===== 合并请求（Pull Request）Wails bindings =====
//
// v0.6+ 用户拍板：合并请求与 Git Graph 一样适配用户当前绑定账号的 git 服务器类型
// （Gitea/GitHub），前端 store 拿 platform 中性 DTO，UI 不关心底层平台。
//
// 鉴权铁律（AGENTS §8.1）：
//   - 前端只传 projectId（业务态概念）
//   - Go 端反查 localStore.Projects → Accounts → secretStore 拿 token
//   - token 绝不离开主进程内存，不写日志，不返前端
//
// 设计：
//   - 每个 binding 共用 resolvePullContext helper 拿 project/account/token/adapter
//   - PullDetailDTO 直接透传给前端（结构对齐 frontend/src/types/dto.ts PullDto）
//   - 写操作（MergePull/ClosePull/Update*）走 slog.Info 记审计日志

// PullDetailAppDTO 暴露给前端的合并请求完整详情 DTO
//
// 字段对齐 frontend/src/types/dto.ts PullDto；前端 store 直接复用
type PullDetailAppDTO = platformAdapter.PullDetailDTO

// PullListAppResp 列合并请求的响应（items + hasMore，给前端"加载更多"用）
type PullListAppResp struct {
	Items   []PullDetailAppDTO `json:"items"`
	Total   int                `json:"total"`   // 当前 state 下 gitea 给的总数；GitHub 没有总数则 = len(items)
	HasMore bool               `json:"hasMore"` // hasMore = len(items) == limit 且还有潜在下一页
}

// resolvePullContext 合并请求 Wails bindings 的共享 helper
//
// 返回：project + account + token + adapter，调用方拿到后直接调 adapter 方法。
// 失败时返 IpcError，前端 ErrorFormatter 会结构化序列化。
//
// 注意：args 接受 projectId，**不**接受 hostUrl/token；AGENTS §8.1 铁律。
func (a *App) resolvePullContext(args struct {
	ProjectID string `json:"projectId"`
}) (*store.RepoProject, *store.GiteaAccount, string, platformAdapter.PlatformAdapter, error) {
	if strings.TrimSpace(args.ProjectID) == "" {
		return nil, nil, "", nil, ipc.NewValidationFailed("projectId 不能为空", "")
	}
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return nil, nil, "", nil, err
	}
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return nil, nil, "", nil, classifyKeychainError(err)
	}
	if token == "" {
		return nil, nil, "", nil, ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}
	adapter := a.getAdapter(account.Platform)
	if adapter == nil {
		return nil, nil, "", nil, ipc.NewUnsupportedPlatform(account.Platform)
	}
	return project, account, token, adapter, nil
}

// ===== ListPulls =====

// ListPullsArgs 列表合并请求参数
type ListPullsArgs struct {
	ProjectID string `json:"projectId"`
	State     string `json:"state"` // "open" | "closed" | "all"
	Head      string `json:"head,omitempty"`
	Base      string `json:"base,omitempty"`
	Page      int    `json:"page"`
	Limit     int    `json:"limit"`
}

// ListPulls 列出某项目的合并请求（Gitea + GitHub 都支持，v0.6+ 拍板）
//
// 鉴权铁律（AGENTS §8.1）：前端只传 projectId。
// 平台选择走 findProjectAndAccount → account.Platform → giteaAdapter / githubAdapter。
func (a *App) ListPulls(args ListPullsArgs) (PullListAppResp, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullListAppResp{}, err
	}

	items, err := adapter.ListPulls(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, platformAdapter.ListPullsOpts{
		State: args.State,
		Head:  args.Head,
		Base:  args.Base,
		Page:  args.Page,
		Limit: args.Limit,
	})
	if err != nil {
		return PullListAppResp{}, err
	}

	limit := args.Limit
	if limit <= 0 {
		limit = 30
	}
	hasMore := len(items) >= limit
	if a.logger != nil {
		a.logger.Info("ListPulls",
			"projectId", args.ProjectID, "platform", account.Platform,
			"state", args.State, "count", len(items), "hasMore", hasMore)
	}
	return PullListAppResp{
		Items:   items,
		Total:   len(items), // GitHub 不返总数；前端按 hasMore 触发加载更多
		HasMore: hasMore,
	}, nil
}

// ===== GetPull =====

// GetPullArgs 获取单个合并请求参数
type GetPullArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// GetPull 获取单个合并请求详情（Gitea + GitHub 都支持）
func (a *App) GetPull(args GetPullArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.GetPull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== MergePull =====

// MergePullArgs 合并合并请求参数
type MergePullArgs struct {
	ProjectID         string `json:"projectId"`
	Index             int    `json:"index"`
	Method            string `json:"method"` // "merge" | "rebase" | "rebase-merge" | "squash"
	DeleteBranchAfter bool   `json:"deleteBranchAfter"`
	CommitMessage     string `json:"commitMessage,omitempty"`
}

// MergePull 合并合并请求（**危险操作**，UI 层必须二次确认）
//
// 合并方式：
//   - "merge"        普通合并（保留所有提交历史）
//   - "rebase"       变基后快进（重写历史，单一线性）
//   - "rebase-merge" 变基后 merge commit（仅 Gitea 支持）
//   - "squash"       压缩为单提交
//
// method="squash" 时 CommitMessage 建议非空（部分平台要求）。
// 合并到主线分支（如 main）时 UI 层额外二次确认。
func (a *App) MergePull(args MergePullArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	if a.logger != nil {
		// 审计日志：合并动作记 method + deleteBranchAfter，方便事后追溯
		a.logger.Info("MergePull",
			"projectId", args.ProjectID, "platform", account.Platform,
			"index", args.Index, "method", args.Method, "deleteBranchAfter", args.DeleteBranchAfter)
	}

	d, err := adapter.MergePull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, platformAdapter.MergePullOpts{
		Method:            args.Method,
		DeleteBranchAfter: args.DeleteBranchAfter,
		CommitMessage:     args.CommitMessage,
	})
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== ClosePull =====

// ClosePullArgs 关闭合并请求参数
type ClosePullArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ClosePull 关闭合并请求（不合并，直接关闭）—— UI 层应二次确认
//
// 对应 gitea PATCH /pulls/{index} {state: 'closed'}；GitHub 等价。
// 关闭后合并请求状态变为 closed，不可再合并（除非 reopen，本期不实现 reopen）。
func (a *App) ClosePull(args ClosePullArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("ClosePull", "projectId", args.ProjectID, "platform", account.Platform, "index", args.Index)
	}

	d, err := adapter.ClosePull(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullLabels =====

// UpdatePullLabelsArgs 替换合并请求标签参数
type UpdatePullLabelsArgs struct {
	ProjectID  string   `json:"projectId"`
	Index      int      `json:"index"`
	LabelNames []string `json:"labels"` // 按 label 名替换（Gitea 自动解析为 id；GitHub 直接传 name）
}

// ListMilestonesArgs 列出仓库里程碑（v0.6.0）
type ListMilestonesArgs struct {
	ProjectID string `json:"projectId"`
	State     string `json:"state"` // "open" | "closed" | "all"（空 = open）
}

// UpdatePullMilestoneArgs 给合并请求关联里程碑（v0.6.0）
type UpdatePullMilestoneArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Milestone string `json:"milestone"` // "" 清空
}

// UpdatePullLabels 替换合并请求所有标签（替换语义）
//
// Gitea: PUT /repos/{owner}/{repo}/pulls/{index}/labels
// GitHub: PUT /repos/{owner}/{repo}/issues/{index}/labels
func (a *App) UpdatePullLabels(args UpdatePullLabelsArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullLabels(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.LabelNames)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullAssignee =====

// UpdatePullAssigneeArgs 替换合并请求指派人参数
type UpdatePullAssigneeArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	// Assignees 多人指派（空切片 = 清空）
	Assignees []string `json:"assignees"`
}

// UpdatePullAssignee 替换合并请求指派人（空 = 清空）
//
// 本期简化为单 assignee；多 assignees 后续迭代再加。
func (a *App) UpdatePullAssignee(args UpdatePullAssigneeArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullAssignee(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Assignees)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== UpdatePullReviewers =====

// UpdatePullReviewersArgs 替换合并请求审查者参数
type UpdatePullReviewersArgs struct {
	ProjectID string   `json:"projectId"`
	Index     int      `json:"index"`
	Reviewers []string `json:"reviewers"` // 空切片 = 清空
}

// UpdatePullReviewers 替换合并请求审查者（空 = 清空）
//
// Gitea: POST/DELETE /pulls/{index}/requested_reviewers
// GitHub: POST/DELETE /pulls/{index}/requested_reviewers（同名端点，语义一致）
func (a *App) UpdatePullReviewers(args UpdatePullReviewersArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}

	d, err := adapter.UpdatePullReviewers(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Reviewers)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

// ===== PR 评论（v0.6+）=====
//
// 范围限定：只做 PR 上下文（issue 评论另起 issue）。
// Gitea 与 GitHub 都走 /repos/{owner}/{repo}/issues/{index}/comments 端点
// （PR 与 issue 共享同一编号空间）。

// PullCommentDTO 是 frontend IssueCommentDto 的 Wails 边界类型别名
//
// v0.6+ 复用了 IssueCommentDto，是因为它的字段（id / body / author / createdAt / updatedAt）
// 与评论场景 1:1 对齐。若后续需要 PR review / inline review comment，可以拆出独立类型。
type PullCommentDTO = platformAdapter.CommentDTO

// ListPullCommentsArgs 列 PR 评论参数
type ListPullCommentsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullComments 列 PR 评论
//
// 错误码：
//   - 401/403 → token_invalid / permission_denied
//   - 404 → not_found（项目/仓库不存在）
func (a *App) ListPullComments(args ListPullCommentsArgs) ([]PullCommentDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}

	items, err := adapter.ListPullComments(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CreatePullCommentArgs 发 PR 评论参数
type CreatePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Body      string `json:"body"`
}

// CreatePullComment 发 PR 评论
//
// body 校验（两端都已走）：
//   - 空 → ipc.NewValidationFailed("评论内容不能为空", "")
//   - 两端实现都会在 trim 为空时 short-circuit返回，
//     不会进平台 API（防御设计）
//
// 返回创建的评论（含服务端 id / createdAt），前端拿这个刷列表以避免
// “前端猜时间戳与实际服务端时间不一致”问题。
func (a *App) CreatePullComment(args CreatePullCommentArgs) (PullCommentDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullCommentDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("CreatePullComment", "projectId", args.ProjectID, "index", args.Index)
	}
	d, err := adapter.CreatePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Body)
	if err != nil {
		return PullCommentDTO{}, err
	}
	if d == nil {
		return PullCommentDTO{}, nil
	}
	return *d, nil
}

// UpdatePullCommentArgs 编辑 PR 评论参数
type UpdatePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Body      string `json:"body"`
}

// UpdatePullComment 编辑 PR 评论
//
// 两端 adapter 实现都会在 trim 为空时 short-circuit 返回 ipc.ValidationFailed。
// 返回更新后的评论（含新 updatedAt + userId），前端以此判断"已编辑"状态。
func (a *App) UpdatePullComment(args UpdatePullCommentArgs) (PullCommentDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullCommentDTO{}, err
	}

	if a.logger != nil {
		a.logger.Info("UpdatePullComment", "projectId", args.ProjectID, "commentId", args.CommentID)
	}
	d, err := adapter.UpdatePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Body)
	if err != nil {
		return PullCommentDTO{}, err
	}
	if d == nil {
		return PullCommentDTO{}, nil
	}
	return *d, nil
}

// DeletePullCommentArgs 删除 PR 评论参数
type DeletePullCommentArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
}

// DeletePullComment 删除 PR 评论
//
// 成功返回 nil error（前端不关心返回值，只关心是否出错）。
// 两端对已删除评论重复删除都返 2xx（幂等）。
func (a *App) DeletePullComment(args DeletePullCommentArgs) error {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return err
	}

	if a.logger != nil {
		a.logger.Info("DeletePullComment", "projectId", args.ProjectID, "commentId", args.CommentID)
	}
	return adapter.DeletePullComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID)
}

// ===== 评论表情反应（v0.5.0 M2） =====

// ReactionDTO 是 frontend ReactionDto 的 Wails 边界类型别名（ReactionDTO 与 ReactionDTO 字段对齐）
type ReactionDTO = platformAdapter.ReactionDTO

// ListPullCommentReactionsArgs
type ListPullCommentReactionsArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
}

// ListPullCommentReactions 列评论表情反应
func (a *App) ListPullCommentReactions(args ListPullCommentReactionsArgs) ([]ReactionDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullCommentReactions(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// AddPullCommentReactionArgs
type AddPullCommentReactionArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Content   string `json:"content"`
}

// AddPullCommentReaction 添加表情反应
func (a *App) AddPullCommentReaction(args AddPullCommentReactionArgs) (ReactionDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return ReactionDTO{}, err
	}
	if a.logger != nil {
		a.logger.Info("AddPullCommentReaction", "projectId", args.ProjectID, "commentId", args.CommentID, "content", args.Content)
	}
	d, err := adapter.AddPullCommentReaction(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Content)
	if err != nil {
		return ReactionDTO{}, err
	}
	if d == nil {
		return ReactionDTO{}, nil
	}
	return *d, nil
}

// RemovePullCommentReactionArgs
type RemovePullCommentReactionArgs struct {
	ProjectID string `json:"projectId"`
	CommentID int64  `json:"commentId"`
	Content   string `json:"content"`
}

// RemovePullCommentReaction 移除表情反应
func (a *App) RemovePullCommentReaction(args RemovePullCommentReactionArgs) error {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return err
	}
	if a.logger != nil {
		a.logger.Info("RemovePullCommentReaction", "projectId", args.ProjectID, "commentId", args.CommentID, "content", args.Content)
	}
	return adapter.RemovePullCommentReaction(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Content)
}

// ===== 合并请求评审（v0.5.0 M3） =====

// PullReviewDTO 类型别名（ReactionDTO 在 platform 包已定义）
type PullReviewDTO = platformAdapter.PullReviewDTO

// ListPullReviewsArgs
type ListPullReviewsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullReviews 列评审
func (a *App) ListPullReviews(args ListPullReviewsArgs) ([]PullReviewDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullReviews(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	return items, nil
}

// CreatePullReviewArgs
type CreatePullReviewArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	CommitID  string `json:"commitId"`
	Body      string `json:"body"`
	Event     string `json:"event"`
}

// CreatePullReview 创建评审
//
// 前端传 event: "approve" | "request_changes" | "comment"（统一小写）
// GitHub adapter 内部映射为 APPROVE / REQUEST_CHANGES / COMMENT
func (a *App) CreatePullReview(args CreatePullReviewArgs) (PullReviewDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullReviewDTO{}, err
	}
	if a.logger != nil {
		a.logger.Info("CreatePullReview", "projectId", args.ProjectID, "index", args.Index, "event", args.Event)
	}
	opts := platformAdapter.CreateReviewOpts{
		CommitID: args.CommitID,
		Body:     args.Body,
		Event:    args.Event,
	}
	d, err := adapter.CreatePullReview(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, opts)
	if err != nil {
		return PullReviewDTO{}, err
	}
	if d == nil {
		return PullReviewDTO{}, nil
	}
	return *d, nil
}

// ===== 行内评审评论 (Review Comments) =====

// ListPullReviewCommentsArgs 列行内评审评论参数
type ListPullReviewCommentsArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullReviewComments 列 PR 行内评审评论（v0.5.0 M4）
func (a *App) ListPullReviewComments(args ListPullReviewCommentsArgs) ([]platformAdapter.PullReviewCommentDto, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullReviewComments(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		return nil, err
	}
	out := make([]platformAdapter.PullReviewCommentDto, 0, len(items))
	for _, it := range items {
		out = append(out, platformAdapter.PullReviewCommentDto{
			ID:        it.ID,
			Body:      it.Body,
			Path:      it.Path,
			Line:      it.Line,
			CreatedAt: it.CreatedAt,
			UpdatedAt: it.UpdatedAt,
		})
	}
	return out, nil
}

// CreatePullReviewCommentArgs 发行内评审评论参数
type CreatePullReviewCommentArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	Body      string `json:"body"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
}

// CreatePullReviewComment 发行内评审评论（v0.5.0 M4）
func (a *App) CreatePullReviewComment(args CreatePullReviewCommentArgs) (platformAdapter.PullReviewCommentDto, error) {
	if strings.TrimSpace(args.Body) == "" {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	if strings.TrimSpace(args.Path) == "" {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("路径不能为空", "")
	}
	if args.Line <= 0 {
		return platformAdapter.PullReviewCommentDto{}, ipc.NewValidationFailed("行号必须大于0", "")
	}
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return platformAdapter.PullReviewCommentDto{}, err
	}
	if a.logger != nil {
		a.logger.Info("CreatePullReviewComment", "projectId", args.ProjectID, "index", args.Index, "path", args.Path, "line", args.Line)
	}
	d, err := adapter.CreatePullReviewComment(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Body, args.Path, args.Line)
	if err != nil {
		return platformAdapter.PullReviewCommentDto{}, err
	}
	if d == nil {
		return platformAdapter.PullReviewCommentDto{}, nil
	}
	return *d, nil
}

// ===== 文件修改列表 (PR Files) =====

// ListPullFilesArgs 列 PR 修改文件
type ListPullFilesArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
}

// ListPullFiles 列 PR 修改文件（v0.5.0 M4）
func (a *App) ListPullFiles(args ListPullFilesArgs) ([]platformAdapter.PullFileDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}
	items, err := adapter.ListPullFiles(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			// 低版本 Gitea / GitHub 不支援此端点，前端隐藏此区
			return []platformAdapter.PullFileDTO{}, nil
		}
		return nil, err
	}
	out := make([]platformAdapter.PullFileDTO, 0, len(items))
	for _, it := range items {
		out = append(out, platformAdapter.PullFileDTO{
			Filename:         it.Filename,
			Status:           it.Status,
			Additions:        it.Additions,
			Deletions:        it.Deletions,
			Changes:          it.Changes,
			Patch:            it.Patch,
			PreviousFilename: it.PreviousFilename,
		})
	}
	return out, nil
}

// GetPullFileDiffArgs 单文件 Diff 参数
type GetPullFileDiffArgs struct {
	ProjectID string `json:"projectId"`
	Index     int    `json:"index"`
	FilePath  string `json:"filePath"`
}

// GetPullFileDiff 获取单个文件的 diff 内容（v0.5.0 M4）
func (a *App) ListMilestones(args ListMilestonesArgs) ([]platformAdapter.MilestoneDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return nil, err
	}
	d, err := adapter.ListMilestones(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.State)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return []platformAdapter.MilestoneDTO{}, nil
		}
		return nil, err
	}
	return d, nil
}

func (a *App) UpdatePullMilestone(args UpdatePullMilestoneArgs) (PullDetailAppDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return PullDetailAppDTO{}, err
	}
	d, err := adapter.UpdatePullMilestone(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.Milestone)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return PullDetailAppDTO{}, nil
		}
		return PullDetailAppDTO{}, err
	}
	return *d, nil
}

func (a *App) GetPullFileDiff(args GetPullFileDiffArgs) (platformAdapter.PullFileDiffDTO, error) {
	ctx := struct {
		ProjectID string `json:"projectId"`
	}{ProjectID: args.ProjectID}
	project, account, token, adapter, err := a.resolvePullContext(ctx)
	if err != nil {
		return platformAdapter.PullFileDiffDTO{}, err
	}
	d, err := adapter.GetPullFileDiff(a.ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.Index, args.FilePath)
	if err != nil {
		if errors.Is(err, platformAdapter.ErrNotSupported) {
			return platformAdapter.PullFileDiffDTO{}, nil
		}
		return platformAdapter.PullFileDiffDTO{}, err
	}
	return platformAdapter.PullFileDiffDTO{
		Filename: d.Filename,
		RawDiff:  d.RawDiff,
	}, nil
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

// graphResultToAppDTO 把 platform.GraphResult 转为 App 的 GraphResultDTO
func graphResultToAppDTO(r *platformAdapter.GraphResult) GraphResultDTO {
	if r == nil {
		return GraphResultDTO{}
	}

	nodes := make([]GraphNodeDTO, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		nodes = append(nodes, GraphNodeDTO{
			Row:         n.Row,
			Lane:        n.Lane,
			Color:       n.Color,
			SHA:         n.SHA,
			ShortSHA:    n.ShortSHA,
			Subject:     n.Subject,
			AuthorName:  n.AuthorName,
			AuthorEmail: n.AuthorEmail,
			Date:        n.Date,
			IsMerge:     n.IsMerge,
			Parents:     n.Parents,
			Refs:        n.Refs,
			RefTypes:    n.RefTypes,
			IsCurrent:   n.IsCurrent,
			IsStash:     n.IsStash,
			IsCommitted: n.IsCommitted,
		})
	}

	edges := make([]GraphEdgeDTO, 0, len(r.Edges))
	for _, e := range r.Edges {
		edges = append(edges, GraphEdgeDTO{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Color:    e.Color,
			Type:     e.Type,
		})
	}

	branches := make([]GraphBranchDTO, 0, len(r.Branches))
	for _, b := range r.Branches {
		lines := make([]GraphBranchLineDTO, 0, len(b.Lines))
		for _, ln := range b.Lines {
			lines = append(lines, GraphBranchLineDTO{
				X1:          ln.X1,
				Y1:          ln.Y1,
				X2:          ln.X2,
				Y2:          ln.Y2,
				LockedFirst: ln.LockedFirst,
				IsCommitted: ln.IsCommitted,
			})
		}
		branches = append(branches, GraphBranchDTO{
			Color: b.Color,
			End:   b.End,
			Lines: lines,
		})
	}

	return GraphResultDTO{
		Nodes:     nodes,
		Edges:     edges,
		Branches:  branches,
		MaxLane:   r.MaxLane,
		Truncated: r.Truncated,
	}
}
