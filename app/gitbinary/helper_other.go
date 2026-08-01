//go:build !darwin && !windows

package gitbinary

import "io/fs"

// embeddedHelperFS 在 linux/freebsd 等平台返 nil（当前不嵌入 remote helper）。
//
// 当前实现仅 Windows 嵌入 MinGit 提取的 helper + DLL 依赖。
// 若后续 Linux 用户遇到同类 'remote-https is not a git command' 报错，
// 可以扩展到这里：内嵌 portable MinGit + helper。
func embeddedHelperFS() fs.FS {
	return nil
}

// embeddedHelperAvailable 报告当前平台是否嵌入 helper（其他平台永远 false）。
func embeddedHelperAvailable() bool {
	return false
}
