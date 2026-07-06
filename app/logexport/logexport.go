// Package logexport 提供日志导出/复制能力，供前端 Bug 报告场景使用。
//
// v0.6.0 用户拍板 2026-07-02：
//   - "一键导出 + 一键复制"两种快捷方式
//   - 一键导出：把 logs/main/*.log + state.json (脱敏) + 元信息（版本/平台/时间戳）打包成 zip 放桌面
//   - 一键复制：把最近 N 条日志写到剪贴板，方便直接贴 issue
//
// 设计原则：
//   - 零外部依赖（archive/zip + bufio + strings 都是标准库）
//   - state.json 脱敏：token 字段置空（GiteaAccount 里没存 token，但账号列表里有 username，
//     username 不算敏感；只把任何 "token" key 的 value 清空）
//   - 元信息：app.json 含版本号/平台/数据目录/打包时间，方便定位环境
package logexport

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// ExportSummary 导出结果摘要（前端展示用）
type ExportSummary struct {
	ZipPath     string   `json:"zipPath"`
	LogCount    int      `json:"logCount"`
	LogBytes    int64    `json:"logBytes"`
	StateBytes  int64    `json:"stateBytes"`
	GeneratedAt string   `json:"generatedAt"`
	LogFiles    []string `json:"logFiles"`
}

// ExportOptions 导出参数
type ExportOptions struct {
	// DesktopPath 桌面目录（macOS/Windows 自动解析；Linux 兜底 home）
	DesktopPath string
	// LogDir 日志目录（${dataDir}/logs/main）
	LogDir string
	// StatePath state.json 路径；为空则跳过
	StatePath string
	// Version 应用版本号
	Version string
	// Platform runtime.GOOS
	Platform string
	// DataDir 数据根目录（写入元信息供定位）
	DataDir string
	// MaxLogs 最多包含几个 log 文件（默认 5，按修改时间倒序）
	MaxLogs int
}

// Export 把日志 + 状态 + 元信息打包成 zip 到桌面
//
// 文件名：gitea-kanban-logs-YYYY-MM-DD-HHMMSS.zip
//
// zip 内结构：
//   - app.json（元信息）
//   - state.json（脱敏）
//   - logs/main-YYYY-MM-DD.log（按修改时间倒序，最多 MaxLogs 个）
func Export(opts ExportOptions) (*ExportSummary, error) {
	if opts.DesktopPath == "" {
		return nil, fmt.Errorf("DesktopPath 不能为空")
	}
	if opts.LogDir == "" {
		return nil, fmt.Errorf("LogDir 不能为空")
	}
	if opts.MaxLogs <= 0 {
		opts.MaxLogs = 5
	}

	// 确保桌面目录存在
	if err := os.MkdirAll(opts.DesktopPath, 0o755); err != nil {
		return nil, fmt.Errorf("创建桌面目录失败: %w", err)
	}

	// 收集要打包的日志文件
	logFiles, logBytes, err := collectLogFiles(opts.LogDir, opts.MaxLogs)
	if err != nil {
		return nil, fmt.Errorf("扫描日志失败: %w", err)
	}

	// 生成文件名：gitea-kanban-logs-YYYY-MM-DD-HHMMSS.zip
	ts := time.Now()
	zipName := fmt.Sprintf("gitea-kanban-logs-%s.zip", ts.Format("2006-01-02-150405"))
	zipPath := filepath.Join(opts.DesktopPath, zipName)

	// 创建 zip 文件
	zipFile, err := os.Create(zipPath)
	if err != nil {
		return nil, fmt.Errorf("创建 zip 文件失败: %w", err)
	}
	defer zipFile.Close()

	zw := zip.NewWriter(zipFile)

	// 1. 元信息 app.json
	if err := writeAppMeta(zw, opts, ts, logFiles); err != nil {
		_ = zw.Close()
		return nil, fmt.Errorf("写入 app.json 失败: %w", err)
	}

	// 2. state.json（脱敏）
	var stateBytes int64
	if opts.StatePath != "" {
		if sb, err := writeStateRedacted(zw, opts.StatePath); err != nil {
			_ = zw.Close()
			return nil, fmt.Errorf("写入 state.json 失败: %w", err)
		} else {
			stateBytes = sb
		}
	}

	// 3. 日志文件
	for _, lf := range logFiles {
		if err := writeLogFile(zw, opts.LogDir, lf); err != nil {
			_ = zw.Close()
			return nil, fmt.Errorf("写入日志 %s 失败: %w", lf, err)
		}
	}

	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("关闭 zip 失败: %w", err)
	}

	return &ExportSummary{
		ZipPath:     zipPath,
		LogCount:    len(logFiles),
		LogBytes:    logBytes,
		StateBytes:  stateBytes,
		GeneratedAt: ts.Format(time.RFC3339),
		LogFiles:    logFiles,
	}, nil
}

// collectLogFiles 按修改时间倒序收集 main-*.log
func collectLogFiles(logDir string, max int) ([]string, int64, error) {
	entries, err := os.ReadDir(logDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil // 日志目录不存在 → 空 zip（让前端知道）
		}
		return nil, 0, err
	}

	type fileInfo struct {
		name    string
		modTime time.Time
		size    int64
	}
	var files []fileInfo
	const prefix = "main-"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{e.Name(), info.ModTime(), info.Size()})
	}

	// 按修改时间倒序
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.After(files[j].modTime)
	})

	if len(files) > max {
		files = files[:max]
	}

	var totalBytes int64
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, f.name)
		totalBytes += f.size
	}
	return names, totalBytes, nil
}

// writeAppMeta 写 app.json（元信息）
func writeAppMeta(zw *zip.Writer, opts ExportOptions, ts time.Time, logFiles []string) error {
	meta := map[string]any{
		"app":          "gitea-kanban",
		"version":      opts.Version,
		"platform":     opts.Platform,
		"goVersion":    runtime.Version(),
		"dataDir":      opts.DataDir,
		"exportedAt":   ts.Format(time.RFC3339),
		"logFiles":     logFiles,
		"logFileCount": len(logFiles),
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	w, err := zw.Create("app.json")
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// writeStateRedacted 写 state.json（脱敏 token / 密码类字段）
func writeStateRedacted(zw *zip.Writer, statePath string) (int64, error) {
	data, err := os.ReadFile(statePath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil // 没 state.json → 跳过（脱敏的空写也无意义）
		}
		return 0, err
	}

	// 解析 → 清掉 token 字段 → 重新序列化
	// 用 any 而非 map 是为了支持嵌套；脱敏策略：清掉所有 key 含 "token" / "password" / "secret" 的字段
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		// state.json 损坏 → 写原文，但加 .corrupt 标记
		w, werr := zw.Create("state.json.corrupt")
		if werr != nil {
			return 0, werr
		}
		_, werr = w.Write(data)
		return int64(len(data)), werr
	}
	redactAny(v)
	redacted, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return 0, err
	}

	w, err := zw.Create("state.json")
	if err != nil {
		return 0, err
	}
	if _, err := w.Write(redacted); err != nil {
		return 0, err
	}
	return int64(len(redacted)), nil
}

// redactAny 递归清掉 token/password/secret 字段
func redactAny(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			kl := strings.ToLower(k)
			if kl == "token" || kl == "password" || kl == "secret" || kl == "pat" {
				x[k] = "<REDACTED>"
				continue
			}
			redactAny(val)
		}
	case []any:
		for _, item := range x {
			redactAny(item)
		}
	}
}

// writeLogFile 写单个日志文件到 zip
func writeLogFile(zw *zip.Writer, logDir, name string) error {
	src, err := os.Open(filepath.Join(logDir, name))
	if err != nil {
		return err
	}
	defer src.Close()

	w, err := zw.Create("logs/" + name)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, src)
	return err
}

// ReadRecentLogs 读最近 N 条日志行（按所有 main-*.log 文件，按修改时间倒序拼接）
//
// 用于「一键复制」：把日志读到一个 buffer 里，前端再调剪贴板 API 复制。
//
// 参数 maxBytes 控制 buffer 上限（避免一次性复制 100MB 日志撑爆剪贴板）
func ReadRecentLogs(logDir string, maxBytes int) (string, error) {
	if maxBytes <= 0 {
		maxBytes = 64 * 1024 // 默认 64KB（足够贴 issue）
	}
	names, _, err := collectLogFiles(logDir, 3) // 只取最近 3 天（避免跨日刷屏）
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", nil
	}

	var buf bytes.Buffer
	for _, name := range names {
		if buf.Len() >= maxBytes {
			buf.WriteString("\n...(truncated, more in log files)\n")
			break
		}
		data, err := os.ReadFile(filepath.Join(logDir, name))
		if err != nil {
			continue
		}
		// 文件太大的话只取尾部
		if buf.Len()+len(data) > maxBytes {
			remain := maxBytes - buf.Len()
			if remain > 0 {
				buf.Write(data[len(data)-remain:])
			}
			buf.WriteString("\n...(truncated)\n")
			break
		}
		buf.Write(data)
		buf.WriteString("\n")
	}
	return buf.String(), nil
}

// DesktopDir 跨平台解析桌面目录
//
// 优先级：
//  1. macOS: $HOME/Desktop
//  2. Windows: %USERPROFILE%\Desktop
//  3. Linux: XDG_DESKTOP_DIR 环境变量 → 兜底 $HOME/Desktop
//
// 找不到时返空字符串（让调用方决定 fallback 到 home 根目录）
func DesktopDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(home, "Desktop")
	default:
		// macOS / Linux: 都按 $HOME/Desktop 找
		// Linux 也可以试 XDG_DESKTOP_DIR，但很多发行版不设
		return filepath.Join(home, "Desktop")
	}
}
