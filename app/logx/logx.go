// Package logx 提供应用日志增强工具：panic recovery、统一 tag、reqID context 透传。
//
// 背景（v0.6.0）：
//   - Go 标准库 log/slog 已经满足大部分需求
//   - 但有以下缺口需要本包补齐：
//     1. binding 方法 panic 时不能只让 Wails 兜底——必须落盘到日志（用户反馈问题时看到崩溃堆栈）
//     2. 一次操作链路（绑定调用 → platform 请求 → git 克隆）需要 reqID 串联
//     3. 平台 / 账号 / 仓库三个高频业务字段需要低成本透传
//
// 设计原则：
//   - 零外部依赖，全部用 log/slog + context.Context 标准接口
//   - 不与 config.NewLogger 耦合（只通过 *slog.Logger 接口）
//   - panic recovery 默认 no-op（让 Wails 走自己的 ErrorFormatter），需要时显式 SafeGo / SafeCall
package logx

import (
	"context"
	"log/slog"
	"runtime/debug"
)

// ContextKey context key 类型（避免与其它包 key 撞名）
type contextKey string

const (
	// KeyReqID 请求 ID（一次 binding 调用 → 一次操作链路共用）
	KeyReqID contextKey = "reqID"
	// KeyPlatform 平台名（gitea / github），方便日志过滤
	KeyPlatform contextKey = "platform"
	// KeyAccountID 当前账号 ID，方便关联账号相关操作
	KeyAccountID contextKey = "accountID"
	// KeyProjectID 当前 project ID（owner/repo），方便关联仓库操作
	KeyProjectID contextKey = "projectID"
)

// WithReqID 把 reqID 写进 ctx。生成与透传由调用方负责。
func WithReqID(ctx context.Context, reqID string) context.Context {
	return context.WithValue(ctx, KeyReqID, reqID)
}

// ReqID 从 ctx 拿 reqID（无值时返空字符串，不报错）
func ReqID(ctx context.Context) string {
	if v, ok := ctx.Value(KeyReqID).(string); ok {
		return v
	}
	return ""
}

// WithPlatform 把 platform 写进 ctx
func WithPlatform(ctx context.Context, platform string) context.Context {
	return context.WithValue(ctx, KeyPlatform, platform)
}

// Platform 从 ctx 拿 platform
func Platform(ctx context.Context) string {
	if v, ok := ctx.Value(KeyPlatform).(string); ok {
		return v
	}
	return ""
}

// WithAccountID 把 accountID 写进 ctx
func WithAccountID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, KeyAccountID, id)
}

// AccountID 从 ctx 拿 accountID
func AccountID(ctx context.Context) string {
	if v, ok := ctx.Value(KeyAccountID).(string); ok {
		return v
	}
	return ""
}

// WithProjectID 把 projectID 写进 ctx
func WithProjectID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, KeyProjectID, id)
}

// ProjectID 从 ctx 拿 projectID
func ProjectID(ctx context.Context) string {
	if v, ok := ctx.Value(KeyProjectID).(string); ok {
		return v
	}
	return ""
}

// FromContext 从 ctx 提取所有已知 tag（reqID/platform/accountID/projectID）
//
// 用法：logger.LogAttrs(ctx, slog.LevelInfo, "msg", logx.FromContext(ctx)...)
//
// 设计：返 []slog.Attr 让调用方能拼到任意 LogAttrs 调用里。
// 注意：从 ctx 取值失败时返 nil（不返错误、不抛）
func FromContext(ctx context.Context) []slog.Attr {
	if ctx == nil {
		return nil
	}
	var attrs []slog.Attr
	if v := ReqID(ctx); v != "" {
		attrs = append(attrs, slog.String("reqID", v))
	}
	if v := Platform(ctx); v != "" {
		attrs = append(attrs, slog.String("platform", v))
	}
	if v := AccountID(ctx); v != "" {
		attrs = append(attrs, slog.String("accountID", v))
	}
	if v := ProjectID(ctx); v != "" {
		attrs = append(attrs, slog.String("projectID", v))
	}
	return attrs
}

// SafeGo 用 panic recovery 包一层 goroutine 启动
//
// 设计动机：
//   - Wails binding 回调里起 goroutine 后台干活（clone / fetch），如果 panic
//     没有兜底，会让进程直接退出且日志丢失
//   - recover 后写 ERROR 级日志（含 stack），便于 bug 上报时定位
//
// 用法：logx.SafeGo(logger, "CloneRepo", func() { ... })
func SafeGo(logger *slog.Logger, op string, fn func()) {
	go func() {
		defer Recover(logger, op)
		fn()
	}()
}

// Recover panic 兜底 + 写 ERROR 日志
//
// 设计：
//   - 拿到 panic 值后尝试断言为 error，失败就用 String()
//   - 写完整 stack trace（runtime/debug.Stack()，不是 panic value 自带的）
//   - 写 ERROR 级日志（让用户 grep main.log "level=ERROR" 看到所有崩溃点）
//
// 为什么不 Fatal：Fatal 会 os.Exit(1)，但崩溃后我们更希望 app 继续跑
// （其它 binding 还能用）。Wails 自己的 binding 错误会被 ErrorFormatter 走 IPC 报错。
func Recover(logger *slog.Logger, op string) {
	r := recover()
	if r == nil {
		return
	}
	if logger == nil {
		return
	}
	msg := "<non-error panic>"
	var err error
	if e, ok := r.(error); ok {
		msg = e.Error()
		err = e
	} else {
		msg = stringify(r)
	}
	logger.Error("panic recovered",
		"op", op,
		"panic", msg,
		"stack", string(debug.Stack()),
	)
	_ = err // 保留 future 扩展
}

// stringify 把非 error 的 panic 值转字符串
//
// 极简实现：fmt-style 转换。大多数场景是 string("xxx")，极少数是其它类型
func stringify(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	if e, ok := v.(error); ok {
		return e.Error()
	}
	return strings_repr(v)
}

// strings_repr 不引 fmt（hot path）— 用 log/slog 的 Stringer 接口
func strings_repr(v interface{}) string {
	type stringerT interface {
		String() string
	}
	if s, ok := v.(stringerT); ok {
		return s.String()
	}
	return "<non-string panic>"
}
