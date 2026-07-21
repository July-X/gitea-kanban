//go:build darwin

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// applyMacOS macOS in-place 替换 .app bundle 中的 binary
//
// 对齐 DeepSeek-Reasonix desktop/updater_mac.go：
//  1. 拿当前 .app/Contents/MacOS/gitea-kanban 路径
//  2. 写新 binary 到 .app/Contents/MacOS/gitea-kanban.new
//  3. 写一个 shell 脚本执行原子替换（mv old→backup, mv new→old）
//  4. exec.Command("/bin/sh", script).Start() + os.Exit(0)
//  5. 失败回滚（如果有 backup）
//
// 注意：仅当 .app 已签名+notarize 后才能生效（否则 Gatekeeper 会拦）。未签名 build 走 OpenDownloadPage。
func applyMacOS(newBinaryPath string, logger func(level, format string, args ...any), openBrowser func(url string) error) error {
	// 拿当前 .app 路径
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	// .app/Contents/MacOS/gitea-kanban → .app
	macOSDir := filepath.Dir(exe)         // Contents/MacOS
	contentsDir := filepath.Dir(macOSDir) // Contents
	appDir := filepath.Dir(contentsDir)   // gitea-kanban.app

	if logger != nil {
		logger("info", "update: macOS apply, replacing %s with %s", exe, newBinaryPath)
	}

	// 新 binary 写到 .new
	newPath := exe + ".new"
	if err := copyFile(newBinaryPath, newPath); err != nil {
		return fmt.Errorf("%w: copy new binary: %v", ErrApplyFailed, err)
	}

	// 写 shell 脚本执行原子替换
	script := fmt.Sprintf(`#!/bin/sh
set -e
sleep 1
mv "%s" "%s.backup"
mv "%s.new" "%s"
open "%s"
exit 0
`, exe, exe, exe, exe, appDir)

	scriptPath := filepath.Join(filepath.Dir(newPath), "gitea-kanban-update.sh")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		return fmt.Errorf("%w: write script: %v", ErrApplyFailed, err)
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	cmd.Dir = macOSDir
	if err := cmd.Start(); err != nil {
		// 失败回滚
		if _, err := os.Stat(exe + ".backup"); err == nil {
			os.Rename(exe+".backup", exe)
		}
		os.Remove(exe + ".new")
		os.Remove(scriptPath)
		return fmt.Errorf("%w: launch update script: %v", ErrApplyFailed, err)
	}
	os.Exit(0)
	return nil // unreachable
}

// copyFile 从 src 拷贝文件到 dest
func copyFile(src, dest string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dest, data, 0o755)
}

// applyWindows darwin 平台的 stub，返 ErrUnsupportedOS
func applyWindows(installerPath string, logger func(level, format string, args ...any)) error {
	return fmt.Errorf("%w: Windows apply called from macOS build", ErrUnsupportedOS)
}
