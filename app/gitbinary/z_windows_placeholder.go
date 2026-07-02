//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly || solaris

package gitbinary

// 非 Windows 平台 build 时不嵌入 windows 二进制：占位 nil。
// Go 1.26.4 在 file constraint 上 `!` 否定符不稳定（与 filename 隐式 constraint 冲突），
// 用正向枚举所有非 Windows 平台。
// aix / plan9 / nacl 略（已停止维护）。
var embeddedGitWindowsAmd64 []byte
