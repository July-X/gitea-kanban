//go:build darwin

package updater

import (
	"fmt"
	"os"
	"os/exec"
)

// applyMacOS macOS dmg 自动下载 → 打开 Finder
//
// v0.8.22 改：不再做 in-place binary 替换（macOS Gatekeeper 拦未签名 binary 替换）。
// 改为 "download dmg → exec.Command('open', dmgPath)"，Finder 自动弹出 dmg，
// user 看到 .app bundle + Applications symlink，拖 .app 到 /Applications 完成升级。
//
// 老的 in-place replace 逻辑（写 .new + shell 脚本替换）保留在
// openDmgInstaller 之前的代码里注释掉，需要做签名发布时可恢复。
func applyMacOS(dmgPath string, logger func(level, format string, args ...any), openBrowser func(url string) error) error {
	if logger != nil {
		logger("info", "update: macOS apply, opening dmg %s in Finder", dmgPath)
	}

	// macOS 默认行为：open <filepath> 会让 Finder 弹窗显示该 dmg 文件，
	// 用户的 Applications symlink 也在 dmg 顶部（dmg 是用 hdiutil 造的，含 symlink），
	// 拖 .app 到 /Applications 即可完成升级。
	cmd := exec.Command("open", dmgPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: open dmg: %v", ErrApplyFailed, err)
	}
	return nil
}

// applyWindows darwin 平台的 stub，返 ErrUnsupportedOS
func applyWindows(installerPath string, logger func(level, format string, args ...any)) error {
	return fmt.Errorf("%w: Windows apply called from macOS build", ErrUnsupportedOS)
}
