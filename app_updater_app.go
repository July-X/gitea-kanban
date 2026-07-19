package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"

	"gitea-kanban/app/logx"
	"gitea-kanban/app/store"
	"gitea-kanban/app/updater"
)

// appVersion 编译期注入（main.go 用 -ldflags "-X main.appVersion=v0.8.0"）
//
// dev build 时是 "dev"，updater.Check 会自动跳过（避免噪音）
var appVersion = "dev"

// appChannel 发布通道（编译期注入），默认 stable。
var appChannel = "stable"

// Version Wails binding — 返当前运行版本（前端 banner / 设置页显示用）
func (a *App) Version() string {
	return appVersion
}

// SetCheckUpdatesPref Wails binding — SettingsView 切换「启动时自动检查更新」开关
//
// v0.8.0 引入。返 error 让前端 toast 显示。
func (a *App) SetCheckUpdatesPref(enabled bool) error {
	if a.localStore == nil {
		return fmt.Errorf("localStore not initialized")
	}
	return store.SetPrefBool(a.localStore, store.CheckUpdatesPrefKey, enabled)
}

// GetCheckUpdatesPref Wails binding — SettingsView 读当前 toggle 状态
func (a *App) GetCheckUpdatesPref() bool {
	return store.GetPrefBool(a.localStore, store.CheckUpdatesPrefKey, true)
}

// CheckUpdate Wails binding — 拉取 GitHub latest release，跟 running version 比较
func (a *App) CheckUpdate() (*updater.UpdateInfo, error) {
	if a.updater == nil {
		return nil, fmt.Errorf("updater not initialized")
	}
	return a.updater.Check(a.ctx)
}

// DownloadUpdate Wails binding — 流式下载 + ed25519 校验 + 落盘缓存
func (a *App) DownloadUpdate() (*updater.UpdateDownloadResult, error) {
	if a.updater == nil {
		return nil, fmt.Errorf("updater not initialized")
	}
	res, err := a.updater.Download(a.ctx)
	if err != nil {
		return nil, err
	}
	a.logger.Info("update download done",
		"version", res.Version,
		"platform", res.Platform,
		"size", res.Size,
		"sha256", res.SHA256,
	)
	return res, nil
}

// InstallUpdate Wails binding — 把缓存的 binary 应用到当前平台
//
// 注意：applyWindows 末尾调 os.Exit(0)，调用方拿不到返回值。
func (a *App) InstallUpdate() error {
	if a.updater == nil {
		return fmt.Errorf("updater not initialized")
	}
	a.logger.Info("update install start", "version", a.updaterRunningVersion())
	return a.updater.Install()
}

// OpenDownloadPage Wails binding — 打开浏览器到 GitHub release 页
//
// macOS 未签名 build 走这条路径。
func (a *App) OpenDownloadPage() error {
	if a.updater == nil {
		return fmt.Errorf("updater not initialized")
	}
	return a.updater.OpenDownloadPage()
}

// updaterRunningVersion 内部 helper — 取运行版本字符串。
func (a *App) updaterRunningVersion() string {
	return appVersion
}

// initUpdater 在 OnStartup 里调一次，初始化 Updater 实例。
//
// 设计：
//   - CacheDir = ${dataDir}/updates/
//   - HTTP client 用默认（不注入 token 也不会有，公开 GitHub API）
//   - Logger 走 slog
//   - OpenBrowser 用平台默认（macOS open / Windows rundll32 / Linux xdg-open）
func (a *App) initUpdater() {
	if a.dataDir == "" {
		if a.logger != nil {
			a.logger.Warn("updater: dataDir not set, skipping init")
		}
		return
	}
	if a.logger == nil {
		// 测试环境或 logger 初始化顺序问题：不阻断 startup
		return
	}
	cacheDir := a.dataDir + "/updates"
	cfg := updater.UpdaterConfig{
		RunningVersion: appVersion,
		Channel:        appChannel,
		CacheDir:       cacheDir,
		Logger:         a.slogFunc(),
		OpenBrowser:    defaultOpenBrowser,
	}
	a.updater = updater.New(cfg)
	a.logger.Info("updater initialized", "version", appVersion, "channel", appChannel, "cacheDir", cacheDir)
}

// slogFunc 把 slog.Logger 适配成 updater.UpdaterConfig.Logger 签名。
func (a *App) slogFunc() func(level, format string, args ...any) {
	if a.logger == nil {
		return func(string, string, ...any) {}
	}
	return func(level, format string, args ...any) {
		// updater 内部用 (level, format, args...) 风格；映射到 slog
		msg := fmt.Sprintf(format, args...)
		switch level {
		case "error":
			a.logger.Error(msg)
		case "warn":
			a.logger.Warn(msg)
		case "info":
			a.logger.Info(msg)
		default:
			a.logger.Debug(msg)
		}
	}
}

// checkUpdatesAtStartup 启动期异步检查更新（非阻塞 UI 启动）
//
// 触发条件：localStore.prefs["app.checkUpdates"] 默认 true
// 不触发时返 silently。
func (a *App) checkUpdatesAtStartup() {
	if a.updater == nil || a.localStore == nil || a.logger == nil {
		return
	}
	checkEnabled := store.GetPrefBool(a.localStore, store.CheckUpdatesPrefKey, true)
	if !checkEnabled {
		a.logger.Info("update check: skipped (disabled in prefs)")
		return
	}

	// 异步跑，不阻塞 Wails 启动
	go func() {
		ctx := logx.WithReqID(context.Background(), "updatecheck-"+appVersion)
		info, err := a.updater.Check(ctx)
		if err != nil {
			a.logger.Warn("update check failed", "err", err.Error())
			return
		}
		if info == nil {
			return
		}
		if info.Available {
			a.logger.Info("update available",
				"current", info.Current,
				"latest", info.Latest,
				"manualOnly", info.ManualOnly,
				"manualReason", info.ManualReason,
			)
		} else if info.Err != "" {
			a.logger.Info("update check: no available", "err", info.Err)
		} else {
			a.logger.Info("update check: up to date",
				"current", info.Current,
				"latest", info.Latest,
			)
		}
	}()
}

// defaultOpenBrowser 跨平台打开浏览器
func defaultOpenBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
