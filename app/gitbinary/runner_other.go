//go:build !windows

package gitbinary

import "os/exec"

// configureCmdHideWindow 在非 Windows 平台上是 no-op。
func configureCmdHideWindow(cmd *exec.Cmd) {}
