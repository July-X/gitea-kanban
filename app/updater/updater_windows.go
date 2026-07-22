//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// getShortPathNameW 调用 kernel32!GetShortPathNameW 把含空格的路径转成 8.3 短路径
//
// NSIS installer 的 /D=<dir> 参数不支持引号且遇到空格会截断（例如
// "C:\Program Files\Gitea Kanban\" 会被截成 "C:\Program" 导致安装失败）。
// Windows 8.3 短路径没有空格（如 C:\PROGRA~1\GITEA-K~1\），是 Win32 子系统的标准方案。
func getShortPathNameW(longPath string) string {
	kernel32, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return longPath // 回退：原样返回，让后续逻辑保守处理
	}
	proc, err := kernel32.FindProc("GetShortPathNameW")
	if err != nil {
		return longPath
	}
	// 调用 GetShortPathNameW(longPath, buf, bufSize)
	longPtr, err := syscall.UTF16PtrFromString(longPath)
	if err != nil {
		return longPath
	}
	// 先传 nil 缓冲区获取所需大小（UTF-16 rune 数）
	n, _, _ := proc.Call(uintptr(unsafe.Pointer(longPtr)), 0, 0)
	if n == 0 {
		return longPath // 路径不存在或其他错误，返回原值
	}
	// 分配 n+1 个 UTF-16 rune（+1 for null terminator）
	buf := make([]uint16, n+1)
	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(longPtr)), uintptr(unsafe.Pointer(&buf[0])), uintptr(n+1))
	if ret == 0 {
		return longPath
	}
	return syscall.UTF16ToString(buf[:ret])
}

const installerArgSilent = "/S"

// quoteIfNeeded 按 cmd.exe 规则：含空格才包双引号；不含空格不包
func quoteIfNeeded(p string) string {
	if !strings.ContainsAny(p, ` `) {
		return p
	}
	return `"` + p + `"`
}

// installerCommandLine 裸拼命令行（NSIS 要求 /D=<dir> 必须是不带引号的最后 token）
//
// 背景（v0.8.0.1 / 对齐 DeepSeek-Reasonix 修复）：
// user 路径常含空格（C:\Program Files\gitea-kanban\），exec.Command 默认 quote 路径
// 会让 NSIS 解析 /D= 时截断到第一个空格。
func installerCommandLine(name, installDir string) string {
	return fmt.Sprintf(`%s %s /D=%s`, quoteIfNeeded(name), installerArgSilent, installDir)
}

// applyWindows 启动 NSIS installer 静默安装（Windows 平台）
//
// 对齐 DeepSeek-Reasonix desktop/updater_windows.go：
//  1. 拿当前 exe 路径（解析 symlink）
//  2. installDir = exe 所在目录
//  3. 裸拼命令行 + SysProcAttr.CmdLine（避开 exec.Command 默认 quote 的 /D= 空格 bug）
//  4. cmd.Start() + os.Exit(0)
func applyWindows(installerPath string, logger func(level, format string, args ...any)) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	installDir := filepath.Dir(exe)

	// NSIS /D= 参数不支持引号且遇空格会截断，转成 8.3 短路径避免空格问题
	shortDir := getShortPathNameW(installDir)

	if logger != nil {
		logger("info", "update: Windows apply, launching NSIS installer: %s /S /D=%s (orig: %s)", installerPath, shortDir, installDir)
	}

	cmd := exec.Command(installerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:    installerCommandLine(installerPath, shortDir),
		HideWindow: true,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("%w: launch NSIS installer: %v", ErrApplyFailed, err)
	}
	os.Exit(0)
	return nil // unreachable
}

// applyMacOS windows 平台的 stub，返 ErrUnsupportedOS
func applyMacOS(newBinaryPath string, logger func(level, format string, args ...any), openBrowser func(url string) error) error {
	return fmt.Errorf("%w: macOS apply called from Windows build", ErrUnsupportedOS)
}
