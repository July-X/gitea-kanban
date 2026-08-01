//go:build darwin

package gitbinary

import "io/fs"

// embeddedHelperFS 在 darwin 平台返 nil（当前不嵌入 macOS remote helper）。
//
// macOS 内嵌 git（来自 sandbox /usr/local/bin/git 的 homebrew copy）在 exec-path
// 解析上不会落空（git 自己会找 /usr/local/libexec/git-core/ 或 /usr/libexec/git-core/
// 的 helper）。如果未来发现某些 macOS 部署场景下也撞 'remote-https is not a git command'
// 报错（例如 sandbox git 是 universal 单文件而不是 homebrew Cellar 完整布局），可以
// 在这里嵌入 homebrew 的 helper 链。详见 v0.8.27+ 修复文档。
func embeddedHelperFS() fs.FS {
	return nil
}

// embeddedHelperAvailable macOS 平台当前不嵌入 helper。
func embeddedHelperAvailable() bool {
	return false
}
