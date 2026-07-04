package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"gitea-kanban/app/ipc"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func main() {
	// 创建后端应用实例
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Gitea Kanban",
		Width:     1680,
		Height:    1050,
		MinWidth:  800,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 15, G: 17, B: 21, A: 1}, // #0F1115 dark 基底
		OnStartup:        app.OnStartup,
		OnShutdown:       app.OnShutdown,
		// ErrorFormatter 把 *ipc.IpcError 结构化序列化到 Wails CallbackMessage.Err，
		// 前端 ipc-client.ts 的 isIpcErrorPayload() 就能正确识别 code + message + hint。
		// 非 IpcError 的 error 走 .Error() 字符串兜底，前端走 normalizeError 的 "internal" 分支。
		ErrorFormatter: ipc.FormatError,
		Bind: []interface{}{
			app,
		},
		// v1.x 拍板 2026-07-04 v3（标题栏主题跟随收尾）：
		// 之前 v1-v2.2 回合的 mac.TitleBarHiddenInset + AppShell 让位 32px + ::before drag region
		// 反复让 StatusBar / view topbar / NavRail 各种错位，本质上是因为 FullSizeContent 让 webview
		// 占满整个 NSWindow（含 traffic lights 区），AppShell 需要协调 macOS chrome + 让位 + drag region
		// 多方约束。Wails v2 + WKWebView 在 macOS Big Sur+ 圆角 mask + 不同 NSWindow style 之间
		// 各种 corner case 拼不上，反而把标题栏颜色、StatusBar 可见性都搞砸了。
		//
		// 简化方案：退回 mac.TitleBarDefault（标准 28px 系统 titlebar）。
		//   - macOS dark mode 下标题栏背景 = #1e1e1e（深色，跟应用 #0F1115 dark canvas 视觉协调）
		//   - 用户截图反馈"暗色主题下标题栏颜色跟主题一致" —— 实测 NSWindow chrome 已经是深色
		//   - webview 从 y=28 起，不需要让位 / drag region / FullSizeContent 协调
		//   - AppShell 简单：.shell height = var(--vheight)，NSWindow.titlebar = 系统托管
		//   - StatusBar 作为 flex item 自动贴 NSWindow.bottom
		//
		// 用户后续如果要做 macOS dark/light mode 与应用主题完全同步（含标题栏），需要走 cgo/objc bridge
		// 调用 NSWindow.appearance setter（超出 Wails v2 暴露 API 范围）。本轮先确保稳定正确。
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About: &mac.AboutInfo{
				Title:   "Gitea Kanban",
				Message: "版本 2.0.0\n基于 Gitea/GitHub 的桌面端看板 + 时间轴工具",
				Icon:    appIcon,
			},
		},
		// Debug 选项（仅 wails dev 生效,production build 会忽略）：
		//   - OpenInspectorOnStartup: 启动时自动弹出 Web Inspector(DevTools)
		//   - 用来排查前端 console.log / 前端日志通道 / 性能问题
		// 配合 frontend-log.ts 的 [frontend-log] 前缀 console 输出,
		// 排错时可以直接在 DevTools Console 里看 send() 是否真的被调
		// 不影响生产:wails build 不会读 Debug 字段
		Debug: options.Debug{
			OpenInspectorOnStartup: true,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
