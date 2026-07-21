//go:build windows

package gitbinary

import (
	"os/exec"
	"syscall"
)

// configureCmdHideWindow 在 Windows 平台上设置子进程不创建可见 console 窗口。
//
// Wails Windows 安装包运行在 GUI 模式（无 attached console），通过 exec.Command
// 派生子进程（git.exe 是 console 类型）时，Windows 会自动分配一个新 console 窗口，
// 导致每次 git 调用都闪一下黑窗口。设置 Hide: 1 等于 CREATE_NO_WINDOW (0x08000000)，
// 让子进程静默执行，不弹出任何窗口。
func configureCmdHideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
