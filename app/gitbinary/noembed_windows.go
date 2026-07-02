//go:build !windows

package gitbinary

// 非 Windows build 时不嵌入 windows 二进制：占位 nil。
var embeddedGitWindowsAmd64 []byte
