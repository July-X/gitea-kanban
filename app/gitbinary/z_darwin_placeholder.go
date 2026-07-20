//go:build !darwin

package gitbinary

// 非 darwin 平台 build 时不嵌入 darwin 二进制：占位 nil。
// 注意：runner.go 的 embeddedGitBytes() 在 windows/linux 上仍会编译
// "darwin/amd64"/"darwin/arm64" 两个 case 分支（Go 不按运行时淘汰分支），
// 必须同时声明两个 var，否则非 darwin 平台下编译失败。
var embeddedGitDarwinAmd64 []byte
var embeddedGitDarwinArm64 []byte
