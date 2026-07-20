// Copyright (c) 2026 gitea-kanban. SPDX-License-Identifier: MIT
//
// 测试 util：给 App 注册 cleanup，Close logger handler 释放 windows file handle。
//
// 为什么需要：
//
//	windows 上 testing.go TempDir RemoveAll cleanup 会尝试删
//	${tmp}/logs/main/main-YYYY-MM-DD.log 文件。如果 dailyRotateHandler 的
//	*os.File handle 没释放，RemoveAll 失败报：
//	"The process cannot access the file because it is being used by another process."
//	导致所有 TempDir-based 测试 FAIL（即使测试本身逻辑全过）。
//
// 修复方式：
//
//	t.Cleanup 里显式 Close handler 释放 handle，让 windows 上的
//	testing TempDir cleanup 干净完成。
//
// 仅 windows 需要（unix 上 TempDir RemoveAll 不因 file handle 失败）；
// 但为了跨平台一致性，所有平台都注册。
package main

import (
	"io"
	"log/slog"
	"testing"
)

// CleanupAppLogger 给 t 注册 cleanup 主动 Close logger handler。
//
// 典型用法（在 NewApp + OnStartup 之后调）：
//
//	app := NewApp()
//	app.OnStartup(context.Background())
//	CleanupAppLogger(t, app)
//
// 返回 app 自身，支持链式：
//
//	app := CleanupAppLogger(t, NewApp())
//	app.OnStartup(context.Background())
func CleanupAppLogger(t *testing.T, app *App) *App {
	t.Helper()
	t.Cleanup(func() {
		if app.logger == nil {
			return
		}
		if h := app.logger.Handler(); h != nil {
			if closer, ok := h.(io.Closer); ok {
				_ = closer.Close()
			}
		}
	})
	return app
}

// cleanupAppLoggerManual is unexported helper
func cleanupAppLoggerManual(t *testing.T, logger *slog.Logger) {
	t.Helper()
	t.Cleanup(func() {
		if logger == nil {
			return
		}
		if h := logger.Handler(); h != nil {
			if closer, ok := h.(io.Closer); ok {
				_ = closer.Close()
			}
		}
	})
}
