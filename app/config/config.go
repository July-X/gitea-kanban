// Package config 负责应用级配置：数据根目录解析、日志初始化
//
// 数据根目录优先级（对齐 AGENTS.md §8.2）：
//  1. 环境变量 GITEA_KANBAN_DATA_DIR（必须是绝对路径）
//  2. 兜底 ~/.gitea-kanban
//
// 日志策略（v0.6.0 重写）：
//   - 按天切分：log/main-YYYY-MM-DD.log（用户开「应用数据目录」直接看日期）
//   - 启动期 + 每天第一次写入时 GC：删掉 >14d 的文件
//   - 用 log/slog 标准库 + 一个轻量日切 handler（Zero 新依赖，符合 AGENTS §13）
//   - 兜底环境变量 GITEA_KANBAN_LOG_LEVEL=debug 切到 Debug 级
package config

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AppName 应用名
const AppName = "gitea-kanban"

// DefaultDataDirBasename 默认数据目录名（在用户主目录下）
const DefaultDataDirBasename = ".gitea-kanban"

// logRetentionDays 日志文件保留天数（用户拍板 2026-07-02）
//
// 设计：14 天是用户拍板的方案。桌面 app 的实际场景：
//   - 日常使用 → 一周内能复现的问题就反馈了
//   - Bug 上报场景 → 14 天足够覆盖「周末没开 app + 周一复现」的最坏情况
//   - 体积控制：单日 log 50MB × 14d = 700MB 上限，与"撑爆用户磁盘"风险划清界限
const logRetentionDays = 14

// dailyRotateHandler slog handler，按天切分日志文件
//
// 设计动机：
//   - 旧版 NewLogger 单文件 append → 几 GB 不切分，反馈问题时 tail 打开卡顿
//   - 改用日切后，文件名带日期，用户开数据目录一目了然
//   - 启动期 + 跨天写入时各 GC 一次，零 cron 依赖
//
// 为什么不引 lumberjack：lumberjack 按大小切（与用户拍板的"按天"路线冲突），
// 且新增一个三方依赖。AGENTS §13 明确禁止自决引入重大新依赖。
// 我们自己写的 ~80 行 handler 完全够用，且零外部风险。
type dailyRotateHandler struct {
	mu       sync.Mutex
	logDir   string
	level    slog.Leveler
	attrs    []slog.Attr
	group    string
	now      func() time.Time // 可注入，便于测试
	inner    slog.Handler     // 当前活跃的文件 handler
	innerDay string           // 当前 handler 对应的日期（YYYY-MM-DD）
	file     *os.File         // 当前活跃的文件句柄（v0.8.0 加，Close() 直接关）
}

// newDailyRotateHandler 创建日切 handler（同时跑一次 GC）
//
// 参数 logDir 必须已存在。
func newDailyRotateHandler(logDir string, level slog.Leveler) *dailyRotateHandler {
	h := &dailyRotateHandler{
		logDir: logDir,
		level:  level,
		now:    time.Now,
	}
	h.rotateIfNeeded() // 第一次也走，确保 inner 初始化
	goRetainedLogs(logDir, h.now(), logRetentionDays)
	return h
}

// Enabled 实现 slog.Handler
func (h *dailyRotateHandler) Enabled(_ /*ctx*/ context.Context, level slog.Level) bool {
	return level >= h.level.Level()
}

// Handle 实现 slog.Handler：写入前先确保日期没变 + 触发 rotateIfNeeded
func (h *dailyRotateHandler) Handle(ctx context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.rotateIfNeeded(); err != nil {
		// 切分失败仍尝试走旧 handler，避免日志断流
		if h.inner != nil {
			return h.inner.Handle(ctx, r)
		}
		return err
	}
	return h.inner.Handle(ctx, r)
}

// WithAttrs 实现 slog.Handler：把 attrs 透传到 inner
func (h *dailyRotateHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	// attrs 只缓存到外层,真正的应用在 rotateIfNeeded 里(在 inner 上 WithAttrs)
	merged := append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &dailyRotateHandler{
		logDir: h.logDir,
		level:  h.level,
		attrs:  merged,
		group:  h.group,
		now:    h.now,
	}
}

// WithGroup 实现 slog.Handler：与 WithAttrs 同理
func (h *dailyRotateHandler) WithGroup(name string) slog.Handler {
	return &dailyRotateHandler{
		logDir: h.logDir,
		level:  h.level,
		attrs:  h.attrs,
		group:  name,
		now:    h.now,
	}
}

// rotateIfNeeded 必要时切分文件（已在 mu 锁内）
//
// 触发条件：
//  1. inner 为 nil（首次启动）
//  2. innerDay != 今天（跨天）
//
// 切分动作：
//  1. 关旧文件
//  2. 计算新文件名 main-YYYY-MM-DD.log
//  3. 创建新文件 + TextHandler
//  4. 应用已累积的 attrs + group（让 WithAttrs/WithGroup 语义不丢）
func (h *dailyRotateHandler) rotateIfNeeded() error {
	today := h.now().UTC().Format("2006-01-02")
	if h.inner != nil && h.innerDay == today {
		return nil
	}

	// 关闭旧文件
	if h.file != nil {
		_ = h.file.Close()
	}

	// 打开新文件
	logPath := filepath.Join(h.logDir, "main-"+today+".log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open log file %s: %w", logPath, err)
	}

	var inner slog.Handler = slog.NewTextHandler(f, &slog.HandlerOptions{
		Level: h.level,
	})
	// 应用 WithAttrs / WithGroup
	if len(h.attrs) > 0 {
		inner = inner.WithAttrs(h.attrs)
	}
	if h.group != "" {
		inner = inner.WithGroup(h.group)
	}

	h.inner = inner
	h.innerDay = today
	h.file = f
	return nil
}

// Close 关闭当前文件句柄（测试用）
func (h *dailyRotateHandler) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	// v0.8.0 修复 windows CI file lock：直接 Close *os.File file 引用，不依赖
	// inner.(io.Closer) 类型断言（slog.TextHandler 不实现 io.Closer）。
	if h.file != nil {
		_ = h.file.Close()
		h.file = nil
	}
	return nil
}

// goRetainedLogs GC 旧日志文件
//
// 删掉 <logDir>/main-YYYY-MM-DD.log 中日期早于 cutoff 的文件
// （同步执行；14d 文件总共 14 个左右，开销可忽略）
//
// 不删匹配不上的文件：避免误伤未来扩展的 log 类型
func goRetainedLogs(logDir string, now time.Time, retentionDays int) {
	cutoff := now.UTC().AddDate(0, 0, -retentionDays)
	cutoffStr := cutoff.Format("2006-01-02")

	entries, err := os.ReadDir(logDir)
	if err != nil {
		return // logDir 不存在等情况，安静失败（启动期尽量不阻断）
	}
	const prefix = "main-"
	const suffix = ".log"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		// main-YYYY-MM-DD.log
		dateStr := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
		// 校验格式 + 是否在 cutoff 之前
		t, perr := time.Parse("2006-01-02", dateStr)
		if perr != nil {
			continue // 名字不匹配我们的格式 → 不动（防御未来扩展）
		}
		if t.Before(cutoff) || dateStr < cutoffStr {
			_ = os.Remove(filepath.Join(logDir, name))
		}
	}
}

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

// NewLogger 创建 slog logger，写文件 ${dataDir}/logs/main/main-YYYY-MM-DD.log
//
// 数据布局（v2.2 user 拍板，2026-06-22）：
//   - ${dataDir} 放 state.json / logs/main/ / dev-tokens/
//   - ${dataDir}/workspace 放 git repos（唯一目录，不可改）
//
// v0.6.0 重写（用户拍板 2026-07-02）：
//   - 日志按天切分：main-YYYY-MM-DD.log
//   - 启动期 GC：删 >14d 旧文件
//   - 兜底环境变量 GITEA_KANBAN_LOG_LEVEL=debug 切到 Debug 级
//   - 文件打不开时 fallback 到 stderr（避免启动失败）
func NewLogger(dataDir string) *slog.Logger {
	logDir := filepath.Join(dataDir, "logs", "main")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}

	level := slog.LevelInfo
	if lvl := os.Getenv("GITEA_KANBAN_LOG_LEVEL"); lvl == "debug" {
		level = slog.LevelDebug
	}

	handler := newDailyRotateHandler(logDir, level)
	return slog.New(handler)
}
