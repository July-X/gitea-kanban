package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

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
		Bind: []interface{}{
			app,
		},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About: &mac.AboutInfo{
				Title:   "Gitea Kanban",
				Message: "版本 2.0.0\n基于 Gitea/GitHub 的桌面端看板 + 时间轴工具",
			},
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
