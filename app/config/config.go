// Package config 负责应用级配置：数据根目录解析、日志初始化
//
// 数据根目录优先级（对齐 AGENTS.md §8.2）：
//  1. 环境变量 GITEA_KANBAN_DATA_DIR（必须是绝对路径）
//  2. 兜底 ~/.gitea-kanban
package config

import (
	"log/slog"
	"os"
	"path/filepath"
)

// AppName 应用名
const AppName = "gitea-kanban"

// DefaultDataDirBasename 默认数据目录名（在用户主目录下）
const DefaultDataDirBasename = ".gitea-kanban"

// ResolveDataDir 解析数据根目录
//
// 优先级：
//   - GITEA_KANBAN_DATA_DIR 环境变量（绝对路径）
//   - ~/.gitea-kanban 兜底
//
// 返回的目录会被 mkdir -p 确保，出错时 fallback 到 os.TempDir。
func ResolveDataDir() string {
	// 1. 环境变量
	if env := os.Getenv("GITEA_KANBAN_DATA_DIR"); env != "" {
		if filepath.IsAbs(env) {
			_ = os.MkdirAll(env, 0o755)
			return env
		}
	}

	// 2. 兜底 ~/.gitea-kanban
	home, err := os.UserHomeDir()
	if err != nil {
		// 极端情况：拿不到 home → 用 tmp
		return filepath.Join(os.TempDir(), AppName)
	}
	dir := filepath.Join(home, DefaultDataDirBasename)
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// NewLogger 创建 slog logger，写文件 ${dataDir}/logs/main/main.log
//
// 数据布局（v2.2 user 拍板，2026-06-22）：
//   - ${dataDir} 放 state.json / logs/main/ / dev-tokens/
//   - ${dataDir}/workspace 放 git repos（唯一目录，不可改）
//   - 旧版 ${dataDir}/workspace/logs/main/main.log 路径废弃（嵌套太深）
//
// 对齐 AGENTS.md §8.2：日志级别默认 Info，可通过 GITEA_KANBAN_LOG_LEVEL 环境变量调为 debug。
func NewLogger(dataDir string) *slog.Logger {
	logDir := filepath.Join(dataDir, "logs", "main")
	_ = os.MkdirAll(logDir, 0o755)

	logPath := filepath.Join(logDir, "main.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}

	level := slog.LevelInfo
	if lvl := os.Getenv("GITEA_KANBAN_LOG_LEVEL"); lvl == "debug" {
		level = slog.LevelDebug
	}

	handler := slog.NewTextHandler(f, &slog.HandlerOptions{
		Level: level,
	})
	return slog.New(handler)
}

// runtimeGOOS 已移除——app.go 直接用 runtime.GOOS
