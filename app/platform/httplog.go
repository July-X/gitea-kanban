// Package platform 定义平台抽象层。
//
// v2 架构支持多平台（Gitea / GitHub），通过 PlatformAdapter interface 隔离平台差异。
// 上层业务只依赖 interface，GiteaAdapter / GitHubAdapter 各自实现。
//
// 首期范围（对齐迁移计划 §2）：
//   - GiteaAdapter：完整实现（repos/branches/commits/pulls/issues/labels/milestones/members）
//   - GitHubAdapter：仅 Git Graph（verifyToken + cloneRepo + logGraph），其余返回 ErrNotSupported
package platform

import (
	"context"
	"log/slog"
	"time"
)

// LogHTTP 是一次 HTTP 请求的轻量日志，写到 slog.Default()。
//
// 用途（v0.6.1 日志增强 · 方便 Bug 上报时 grep "HTTP" 看请求链路）：
//   - 2xx → Debug（日常请求量不大时可以通过 GITEA_KANBAN_LOG_LEVEL=debug 开启）；
//      生产 Info 级只记耗时 >500ms 的慢请求，避免日志刷屏
//   - 非 2xx → Warn（保持与旧代码一致，错误必现）
//   - 网络层错误 → Error（err 非空时）
//
// 安全：
//   - 不记 Authorization header、token、cookie
//   - path 记相对路径（不含 query string）；如需完整 URL 由调用方决定
//
// 设计原则：
//   - 零依赖：只走 slog.Default()，由 app.go OnStartup 同步到同一 main.log 文件
//   - 单次调用开销 <1µs（纯内存格式化 + 检查），不会阻塞 clone/fetch 热路径
//
// 参数：
//   - status: HTTP status code（200/401 等）
//   - duration: 请求耗时
//   - err: 网络层错误（a.httpClient.Do 抛的，非业务错误）
//   - attrs: 额外 attr（如 reqID），由调用方传入（调用 logx.ReqID(ctx) 透传）
func LogHTTP(ctx context.Context, method, path string, status int, duration time.Duration, err error, attrs ...slog.Attr) {
	if err != nil {
		slog.Default().ErrorContext(ctx, "HTTP",
			append([]any{
				"method", method,
				"path", path,
				"ms", duration.Milliseconds(),
				"err", err.Error(),
			}, attrsToAnySlice(attrs)...)...,
		)
		return
	}

	if status < 200 || status >= 300 {
		slog.Default().WarnContext(ctx, "HTTP",
			append([]any{
				"method", method,
				"path", path,
				"status", status,
				"ms", duration.Milliseconds(),
			}, attrsToAnySlice(attrs)...)...,
		)
		return
	}

	// 成功请求：慢请求（>500ms）走 Info，其余走 Debug
	if duration > 500*time.Millisecond {
		slog.Default().InfoContext(ctx, "HTTP slow",
			append([]any{
				"method", method,
				"path", path,
				"status", status,
				"ms", duration.Milliseconds(),
			}, attrsToAnySlice(attrs)...)...,
		)
		return
	}

	slog.Default().Log(ctx, slog.LevelDebug, "HTTP",
		append([]any{
			"method", method,
			"path", path,
			"status", status,
			"ms", duration.Milliseconds(),
		}, attrsToAnySlice(attrs)...)...,
	)
}

// attrsToAnySlice converte []slog.Attr para []any na ordem esperada pelo slog (key, value, key, value...)
func attrsToAnySlice(attrs []slog.Attr) []any {
	if len(attrs) == 0 {
		return nil
	}
	out := make([]any, 0, len(attrs)*2)
	for _, a := range attrs {
		out = append(out, a.Key, a.Value)
	}
	return out
}
