package main

import (
	"fmt"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/logexport"
	"gitea-kanban/app/logx"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

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
// v2.2：前端设置页"打开应用数据目录"按钮调
func (a *App) OpenDataDir() error {
	if a.dataDir == "" {
		return ipc.NewInternal("dataDir 未初始化")
	}
	return a.openFolderInOS(a.dataDir)
}

// OpenDesktopFolder 用系统文件管理器打开用户桌面目录
//
// 优先使用 logexport.DesktopDir() 解析桌面路径；
// 若结果为空，fallback 到 os.UserHomeDir()。
func (a *App) OpenDesktopFolder() error {
	desktopPath := logexport.DesktopDir()
	if desktopPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ipc.NewInternal("获取桌面目录失败：" + err.Error())
		}
		desktopPath = home
	}
	return a.openFolderInOS(desktopPath)
}

// openFolderInOS 跨平台用系统文件管理器打开目录
//
// macOS: `open <path>` / Windows: `explorer <path>` / Linux: `xdg-open <path>`
// 不等 cmd.Wait() —— 这些命令都是 detach 模式，等会阻塞到子进程退出才返回
func (a *App) openFolderInOS(path string) error {
	if err := os.MkdirAll(path, 0o755); err != nil {
		return ipc.NewInternal("确保目录存在失败：" + err.Error())
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}

	if a.logger != nil {
		a.logger.Info("openFolderInOS", "path", path, "cmd", cmd.String())
	}

	if err := cmd.Start(); err != nil {
		return ipc.NewInternal("打开目录失败：" + err.Error())
	}
	go func() { _ = cmd.Wait() }()
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
