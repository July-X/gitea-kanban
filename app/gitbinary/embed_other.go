//go:build !darwin && !windows

package gitbinary

// embeddedGitBytes 在 linux/freebsd 等平台返 nil（不嵌入二进制）。
//
// v0.4.0 设计（user 拍板 2026-07-02）：Linux 发行版自带 git / 系统包管理安装，
// 不需要嵌入避免体积膨胀；用户可在「Git 二进制」设置 UI 里手动指定系统 git 路径。
func embeddedGitBytes() []byte {
	return nil
}

// embeddedGitFileName 在不支持嵌入的平台返空字符串。
func embeddedGitFileName() string {
	return ""
}
