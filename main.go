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
		Width:     1280,
		Height:    800,
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
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
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
