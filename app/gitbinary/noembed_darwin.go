//go:build !darwin

package gitbinary

// Linux / Windows / 其他平台 build 时不嵌入 darwin 二进制：
// 占位 nil，让 runner.go 的 switch 编译通过且 runtime 不会走到 darwin 分支。
var (
	embeddedGitDarwinAmd64 []byte
	embeddedGitDarwinArm64 []byte
)
