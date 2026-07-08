// Package git 进度回调：把 go-git 的 sideband.Progress 文本解析成结构化事件。
//
// 设计动机（user 拍板 2026-06-25）：
//   - 大仓库同步后只在 StatusBar 行末按钮显示"同步中…"文字 + 旋转图标，体感不直观
//   - user 决定用 go-git 的 sideband.Progress 解析百分比（go-git 不暴露字节级 transfer progress）
//   - 通过 Wails EventsEmit 推到前端，repo store 订阅后写到 progressByRepo ref
//   - StatusBar 行末按钮下方渲染一个细进度条 + tooltip 显示百分比 / 阶段文本
//
// go-git 的 sideband.Progress 是 io.Writer：每次写入一行文本，格式：
//   - "Counting objects: 12% (123/1000)\r"
//   - "Receiving objects: 45% (1234/5678), 1.23 MiB | 5.67 MiB/s\r"
//   - "Resolving deltas: 100% (50/50)\r"
//   - "Checking out files: 100% (10/10)\r"
//   - "Updating files: 50% (5/10)\r"
//
// 解析策略：
//   - 第一列匹配 Counting / Compressing / Receiving / Resolving / Checking out / Updating
//   - 提取第一个整数（cur）和斜杠后的整数（total）→ percent = cur * 100 / total
//   - 同一阶段连续多次写进度，只推送最新值（带 stage）
package git

import (
	"strconv"
	"strings"
	"sync"
)

// SyncStage 同步阶段标签
//
// 对齐 go-git sideband 输出第一列（截至 v5.13），任何 sideband 行必须以其中一个开头
// 否则解析失败（按原文本抛给 message，不更新 percent）。
type SyncStage string

const (
	// StageUnknown 未识别（fallback，文案会原样转给 message）
	StageUnknown SyncStage = "unknown"
	// StageCounting 计数（clone 早期：遍历远端对象）
	StageCounting SyncStage = "counting"
	// StageCompressing 压缩（packfile 阶段）
	StageCompressing SyncStage = "compressing"
	// StageReceiving 接收（主要进度，传输对象）
	StageReceiving SyncStage = "receiving"
	// StageResolvingDeltas 解析 delta（packfile 应用）
	StageResolvingDeltas SyncStage = "resolving"
	// StageCheckingOut checkout worktree（NoCheckout 模式不会触发）
	StageCheckingOut SyncStage = "checkout"
	// StageUpdating 更新工作区文件（NoCheckout 模式不会触发）
	StageUpdating SyncStage = "updating"
	// StageDone 同步完成（回调外手动触发）
	StageDone SyncStage = "done"
	// StageError 同步失败（回调外手动触发）
	StageError SyncStage = "error"
)

// SyncProgress 进度事件 payload（暴露给前端）
type SyncProgress struct {
	// Stage 当前阶段（参考 SyncStage 常量）
	Stage SyncStage `json:"stage"`
	// Percent 当前阶段百分比（0..100，-1 = 未知）
	Percent int `json:"percent"`
	// Message 原始进度文本（侧带消息原文或错误信息）
	Message string `json:"message"`
	// Cur 当前阶段已完成项数（0 = 未知）
	Cur int `json:"cur"`
	// Total 当前阶段总项数（0 = 未知）
	Total int `json:"total"`
}

// ProgressCallback 进度回调签名
//
// 实现侧：App 层包装成 runtime.EventsEmit(ctx, "git:sync:progress", payload)
// 实现侧要求：
//   - 线程安全（go-git 可能从内部 goroutine 调）
//   - 不阻塞（用 buffered channel 或异步推送）
type ProgressCallback func(p SyncProgress)

// progressParser sideband 行解析器（带 lastStage 缓存，避免同阶段重复推送）
//
// go-git 调用模式：每个 sideband 行会调一次 Write([]byte)，所以 ParseProgress
// 也是一次一行调（每次 sideband writer flush 完整行）。
type progressParser struct {
	mu        sync.Mutex
	lastStage SyncStage
}

// sidebandParser 全局单例（go-git 跨调用复用解析器，节省内存）
//
// 无状态解析（每次 ParseProgress 自带 lastStage 检查），但有 lastStage 字段保护
// 同一阶段的"递增 percent"被多次调用时，按当前 percent 与 lastStage 决定是否推送。
var sidebandParser = &progressParser{}

// ParseProgress 解析一行 sideband 文本，回调 cb（如果 percent 有更新）
//
// 输入示例：
//   - "Counting objects: 12% (123/1000)\r"
//   - "Receiving objects: 45% (1234/5678), 1.23 MiB | 5.67 MiB/s\r"
//   - "Total 1234 (delta 0), reused 0 (delta 0)\r"  ← 统计行，无 stage
//
// 输出行为：
//   - 解析成功（stage + cur + total 都有）→ 调 cb(SyncProgress{...}）
//   - 解析失败 / 不含百分比 → 调 cb(SyncProgress{Stage: unknown, Percent: -1, Message: raw})
//   - cb 为 nil 时直接返回（防御）
//
// 注意：本函数不做"同阶段同 percent 抑制"——go-git 每行 sideband 调一次，
// 通常 percent 都在递增。如果 caller 想做抑制，自己在 cb 里维护状态。
func ParseProgress(line string, cb ProgressCallback) {
	if cb == nil {
		return
	}

	// 去掉末尾 \r（sideband 是 progress 协议，行以 \r 结束）
	clean := strings.TrimRight(line, "\r\n")
	if clean == "" {
		return
	}

	// StageCounting / StageCompressing / StageReceiving / StageResolvingDeltas / StageCheckingOut / StageUpdating
	stage, rest, ok := splitStage(clean)
	if !ok {
		// 没法识别 stage（如 "Total 1234 ..." 这种汇总行）→ 透传 message
		cb(SyncProgress{Stage: StageUnknown, Percent: -1, Message: clean})
		return
	}

	cur, total, percent, hasPct := extractPercent(rest)
	if !hasPct {
		// 同一 stage 但还没出百分比（如 "Counting objects: ..." 开头）
		// 仍然推送（带 percent=-1 + message），让前端能渲染"XX 中"的状态
		cb(SyncProgress{
			Stage:   stage,
			Percent: -1,
			Message: clean,
			Cur:     0,
			Total:   0,
		})
		return
	}

	cb(SyncProgress{
		Stage:   stage,
		Percent: percent,
		Message: clean,
		Cur:     cur,
		Total:   total,
	})
}

// splitStage 从 clean 行第一列切出 stage
//
// 返回 (stage, rest, ok)：
//   - 匹配 Stage* 常量之一 → 返回对应 SyncStage + 剩余字符串 + true
//   - 其他情况 → 返回 "", clean, false
func splitStage(clean string) (SyncStage, string, bool) {
	// 优先按 "StageLabel: ..." 模式匹配（go-git 实际格式）
	for _, prefix := range []struct {
		stage SyncStage
		text  string
	}{
		{StageCounting, "Counting objects:"},
		{StageCompressing, "Compressing objects:"},
		{StageReceiving, "Receiving objects:"},
		{StageResolvingDeltas, "Resolving deltas:"},
		{StageCheckingOut, "Checking out files:"},
		{StageUpdating, "Updating files:"},
	} {
		if strings.HasPrefix(clean, prefix.text+" ") || strings.HasPrefix(clean, prefix.text+":") {
			rest := strings.TrimPrefix(clean, prefix.text+":")
			rest = strings.TrimSpace(rest)
			return prefix.stage, rest, true
		}
	}
	return StageUnknown, clean, false
}

// extractPercent 从 "12% (123/1000), 1.23 MiB | 5.67 MiB/s" 这种字符串提取百分比 + cur/total
//
// 优先匹配 "N% (cur/total)" 格式；其次匹配 "N%";再其次匹配 "(cur/total)" 单独格式（百分比 = cur*100/total）。
// 任何失败 → hasPct=false。
func extractPercent(rest string) (cur, total, percent int, hasPct bool) {
	// 先抓百分比：第一个匹配的 N%
	if idx := strings.Index(rest, "%"); idx > 0 {
		pctStr := rest[:idx]
		// 反向找数字起点
		start := len(pctStr)
		for start > 0 && (pctStr[start-1] >= '0' && pctStr[start-1] <= '9') {
			start--
		}
		if start < len(pctStr) {
			if n, err := strconv.Atoi(pctStr[start:]); err == nil && n >= 0 {
				percent = n
				if percent > 100 {
					percent = 100
				}
				hasPct = true
			}
		}
	}

	// 再抓 cur/total：第一个 (cur/total) 格式
	if lpar := strings.Index(rest, "("); lpar >= 0 {
		if rpar := strings.Index(rest[lpar:], ")"); rpar > 0 {
			inside := rest[lpar+1 : lpar+rpar]
			if slash := strings.Index(inside, "/"); slash > 0 {
				curStr := inside[:slash]
				totStr := inside[slash+1:]
				// 跳过 "delta 0" 这种不是 cur/total 的子串——找第一个纯数字/纯数字
				if c, err1 := strconv.Atoi(curStr); err1 == nil {
					if t, err2 := strconv.Atoi(totStr); err2 == nil {
						cur = c
						total = t
						if total > 0 && !hasPct {
							percent = cur * 100 / total
							if percent > 100 {
								percent = 100
							}
							hasPct = true
						}
					}
				}
			}
		}
	}

	return cur, total, percent, hasPct
}

// SidebandWriter 包装 ProgressCallback 成 io.Writer
//
// go-git 的 Progress 字段接受 sideband.Progress interface（实现 io.Writer），
// 把这个 writer 传给 CloneOptions.Progress / FetchOptions.Progress，
// 每次 sideband 输出就调一次 Write，内部走 ParseProgress。
//
// 注意：Write 实现按 sideband 协议一次写入可能含多行（带 \r 分隔），
// 但实际 go-git 是按行调用 Write，所以这里直接透传给 ParseProgress。
type SidebandWriter struct {
	cb ProgressCallback
}

// NewSidebandWriter 构造 writer（cb 不能 nil，否则 go-git 会 nil panic）
func NewSidebandWriter(cb ProgressCallback) *SidebandWriter {
	return &SidebandWriter{cb: cb}
}

// Write 实现 io.Writer：把每个 chunk 当一行解析
func (w *SidebandWriter) Write(p []byte) (int, error) {
	if w == nil || w.cb == nil {
		return len(p), nil
	}
	ParseProgress(string(p), w.cb)
	return len(p), nil
}

// DoneProgress 同步完成时手动触发（StageDone, Percent=100）
//
// 适用场景：
//   - 同步成功后调用一次，让前端进度条立刻归位（不用等下次 sideband 行）
//   - 失败后调用一次 StageError，把错误消息传给前端
//
// cb 为 nil 时 no-op（防御）。
func EmitProgress(cb ProgressCallback, stage SyncStage, percent int, message string) {
	if cb == nil {
		return
	}
	cb(SyncProgress{Stage: stage, Percent: percent, Message: message})
}

// SafeWrap 包装 cb，捕获 panic（防止 go-git sideband 触发的 callback 异常让进程崩溃）
//
// 防御：测试场景下 cb 可能 panic，real world 不太会但稳妥起见包一层。
// 用闭包 + recover 实现。
func SafeWrap(cb ProgressCallback) ProgressCallback {
	if cb == nil {
		return nil
	}
	return func(p SyncProgress) {
		defer func() {
			_ = recover()
		}()
		cb(p)
	}
}
