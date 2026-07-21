//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

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

	if logger != nil {
		logger("info", "update: Windows apply, launching NSIS installer: %s /S /D=%s", installerPath, installDir)
	}

	cmd := exec.Command(installerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:    installerCommandLine(installerPath, installDir),
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
