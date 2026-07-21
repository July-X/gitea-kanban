// Package gitbinary 统一管理 git / gh 二进制探测与调用。
//
// v0.7.21 新增 gh 探测：
//   - macOS .app 由 launchd 派生时 PATH 可能不含 /usr/local/bin / /opt/homebrew/bin，
//     导致 exec.LookPath("gh") 失败（即使系统已安装 gh）
//   - ResolveGhPath() 统一处理：用户覆盖 → LookPath（PATH 已被 OnStartup 补过）→ 常见位置扫描
//   - 启动期由 main.go OnStartup 调 ensureGhInPath() 把找到的 gh 目录追加到 PATH

package gitbinary

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
)

// ghBinaryPath 缓存进程内解析到的 gh 路径（用户覆盖或启动期扫描结果）
var ghBinaryPath atomic.Value // string

// commonGhPaths 返回当前平台下 gh 常见的安装路径清单（不含 PATH 中已有目录）
//
// 覆盖范围：
//   - macOS Homebrew (Apple Silicon + Intel)
//   - macOS MacPorts
//   - Linux 标准包管理
//   - Linux Snap
//   - 用户级安装 (~/.local/bin)
//   - 版本管理器 (asdf / mise)
func commonGhPaths() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "~"
	}
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/opt/homebrew/bin", // Homebrew (Apple Silicon)
			"/usr/local/bin",    // Homebrew (Intel) / 手动安装
			"/opt/local/bin",    // MacPorts
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".asdf", "shims"), // asdf 版本管理
			filepath.Join(home, ".local", "share", "mise", "installs", "gh", "current", "bin"), // mise
		}
	case "linux":
		return []string{
			"/usr/local/bin",
			"/snap/bin",
			filepath.Join(home, ".local", "bin"),
			"/opt/gh/bin", // 企业部署
			filepath.Join(home, ".asdf", "shims"),
			filepath.Join(home, ".local", "share", "mise", "installs", "gh", "current", "bin"),
		}
	default:
		// Windows：不额外扫描，依赖 PATH
		return nil
	}
}

// EnsureGhInPath 启动期扫描常见 gh 安装路径，把第一个找到的目录追加到当前进程 PATH。
//
// 只对当前 Go 进程生效（os.Setenv），不影响系统环境。派生的 gh 子进程继承补过的 PATH。
// 已在 PATH 中的目录不重复追加。
func EnsureGhInPath() {
	// 先检查 PATH 中是否已有可用的 gh（dev 模式 PATH 完整，直接命中）
	if _, err := exec.LookPath("gh"); err == nil {
		slog.Default().Debug("gh found in PATH", "path", os.Getenv("PATH"))
		return
	}

	// PATH 中没找到，扫描常见位置
	for _, dir := range commonGhPaths() {
		ghPath := filepath.Join(dir, "gh")
		if _, err := os.Stat(ghPath); err == nil {
			// 找到了，追加到 PATH
			currentPath := os.Getenv("PATH")
			if strings.Contains(currentPath, dir) {
				// 目录已在 PATH 中（但 LookPath 没命中，可能权限问题）
				continue
			}
			newPath := dir + string(os.PathListSeparator) + currentPath
			if err := os.Setenv("PATH", newPath); err != nil {
				slog.Default().Warn("failed to add gh dir to PATH", "dir", dir, "err", err)
				continue
			}
			slog.Default().Info("gh found in common location, added to PATH", "dir", dir, "gh", ghPath)
			// 缓存结果
			ghBinaryPath.Store(ghPath)
			return
		}
	}

	slog.Default().Debug("gh not found in common locations, will rely on user override or PATH")
}

// GhNotFoundError 表示 gh CLI 未找到（PATH 探测 + 常见位置扫描都失败）。
//
// 调用方（native.go / app_auth.go）通过 errors.As 识别后，
// 包装成 ipc.NewGhNotInstalled(cause) 返回前端，引导用户安装。
type GhNotFoundError struct {
	Cause string
}

func (e *GhNotFoundError) Error() string {
	if e.Cause != "" {
		return "未找到 gh 二进制: " + e.Cause
	}
	return "未找到 gh 二进制：系统 PATH 中无 gh，请在「设置 → gh 二进制」手动指定路径，或安装 GitHub CLI (https://cli.github.com/)"
}

// ResolveGhPath 统一探测 gh 二进制路径。
//
// 优先级：
//  1. 用户覆盖（prefs["app.ghBinaryPath"]，放进程内缓存）
//  2. exec.LookPath("gh")（PATH 已被 OnStartup 补过）
//  3. 返回 *GhNotFoundError（调用方用 errors.As 识别后包 ipc.NewGhNotInstalled）
func ResolveGhPath() (string, error) {
	// 1. 用户覆盖
	if v, ok := ghBinaryPath.Load().(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v), nil
	}

	// 2. PATH 探测（PATH 已被 OnStartup EnsureGhInPath 补过）
	if path, err := exec.LookPath("gh"); err == nil {
		return path, nil
	}

	// 3. 未找到
	return "", &GhNotFoundError{Cause: "PATH=" + os.Getenv("PATH")}
}

// SetGhOverride 设置进程内 gh 路径覆盖（与 SetUserOverride 对称）
//
// app.SetGhBinaryPath 在持久化到 LocalState.prefs 后调一次，让本次进程后续
// 所有 gh 调用立刻走新路径，无需重启。
func SetGhOverride(path string) {
	ghBinaryPath.Store(strings.TrimSpace(path))
}

// GhOverride 暴露当前 gh 覆盖值（UI 初始化默认值用）
func GhOverride() string {
	if v, ok := ghBinaryPath.Load().(string); ok {
		return v
	}
	return ""
}

// ClearGhOverride 清空 gh 路径覆盖，回退到 PATH 探测
func ClearGhOverride() {
	ghBinaryPath.Store("")
}

// GhBinaryResult 暴露给前端的 gh 二进制配置（SettingsView 卡片用）
type GhBinaryResult struct {
	// UserOverride 用户在 UI 填的路径；空字符串 = 用默认（PATH 探测）
	UserOverride string `json:"userOverride"`
	// EffectivePath 当前进程实际用的 gh 路径（= ResolveGhPath 解析结果）
	EffectivePath string `json:"effectivePath"`
	// EffectiveVersion gh --version 输出的版本号（探测失败时为空）
	EffectiveVersion string `json:"effectiveVersion"`
	// Found 是否找到 gh（PATH 探测 + 常见位置扫描）
	Found bool `json:"found"`
}

// TestGhResult 验证 gh 二进制结果（与 TestGitResult 对称）
type TestGhResult struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	Path    string `json:"path"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

// TestGhBinary 验证用户在 SettingsView 选择的 gh 路径是否正确。
//
// 实现：
//  1. stat 文件存在 + 是可执行 (mode & 0111) 或 .exe 后缀
//  2. 调用 <binPath> --version，捕获 stdout，期望首行匹配 `gh version X.Y.Z`
//  3. macOS 平台检查 quarantine 属性；有 → 返回 hint
func TestGhBinary(binPath string) TestGhResult {
	binPath = strings.TrimSpace(binPath)
	if binPath == "" {
		return TestGhResult{Message: "路径为空", Hint: "请输入 gh 二进制的绝对路径"}
	}
	info, err := os.Stat(binPath)
	if err != nil {
		return TestGhResult{
			Message: fmt.Sprintf("文件不存在：%s", binPath),
			Hint:    "请确认路径正确；macOS 上 gh 通常在 /usr/local/bin/gh 或 /opt/homebrew/bin/gh",
		}
	}
	if info.IsDir() {
		return TestGhResult{Message: "路径是目录而非文件", Hint: "请选择 gh 二进制文件本身，不是它所在的目录"}
	}
	// 可执行权限检查（Windows 跳过）
	if runtime.GOOS != "windows" {
		if info.Mode()&0o111 == 0 {
			return TestGhResult{Message: "文件没有可执行权限", Hint: "请运行 chmod +x " + binPath}
		}
	}
	// 运行 gh --version
	out, err := exec.Command(binPath, "--version").Output()
	if err != nil {
		return TestGhResult{
			Message: fmt.Sprintf("执行 %s --version 失败: %v", binPath, err),
			Hint:    "请确认这是 gh CLI 可执行文件（git 不行）",
		}
	}
	// 解析第一行: gh version 2.55.0 (2025-01-01)
	firstLine := strings.SplitN(string(out), "\n", 2)[0]
	result := TestGhResult{
		OK:      true,
		Path:    binPath,
		Message: firstLine,
	}
	// 版本号提取
	if idx := strings.Index(firstLine, "gh version "); idx >= 0 {
		ver := strings.TrimSpace(firstLine[idx+len("gh version "):])
		// 去掉可能的 (date) 后缀
		if spaceIdx := strings.Index(ver, " "); spaceIdx >= 0 {
			ver = ver[:spaceIdx]
		}
		result.Version = ver
	}
	// macOS quarantine 检查
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("xattr", "-p", "com.apple.quarantine", binPath).Output(); err == nil && len(out) > 0 {
			result.Hint = "此 gh 被 macOS Gatekeeper 隔离；请在「系统设置 → 隐私与安全性」允许运行，或右键 → 打开 → 仍要打开"
		}
	}
	return result
}
