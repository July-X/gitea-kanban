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
		Title:  "Gitea Kanban",
		Width:  1280,
		Height: 800,
		MinWidth: 800,
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
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
