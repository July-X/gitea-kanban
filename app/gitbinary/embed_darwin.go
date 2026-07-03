//go:build darwin

package gitbinary

import _ "embed"

// v0.4.0 内嵌 Git 2.55.0 macOS 二进制（darwin only，build tag 隔离）。
//
// 文件来源：wails build release 前用对应平台官方 git 2.55.0 替换：
//   - macos-amd64: https://git-scm.com/download/mac (extract from .dmg .pkg) / 或 homebrew
//   - macos-arm64: 同上（Apple Silicon 用 brew install git 装的二进制；或 git-scm.com universal .dmg）
//
// 当前为占位文件：
//   - app/gitbinary/binaries/git/git-2.55.0-macos-amd64 由 sandbox /usr/local/bin/git 真实复制（3.85 MB）
//   - app/gitbinary/binaries/git/git-2.55.0-macos-arm64 为 0 字节 placeholder
//
// Init() 检测 size==0 时跳过释放、降级到 exec.LookPath("git")，并写 WARNING 日志：
//   「内嵌 git-${VER}-${GOOS}-${GOARCH} 大小为 0，请用真实二进制替换后重新 wails build」
//
// 为什么不嵌入 Linux（v0.4.0 user 拍板 2026-07-02）：
//   - Linux 发行版自带 git / 系统包管理安装，不需要嵌入避免体积膨胀
//   - 用户在「Git 二进制」设置 UI 里仍可手动指定系统 git 路径

//go:embed binaries/git/gk-git-2.55.0-macos-amd64
var embeddedGitDarwinAmd64 []byte

//go:embed binaries/git/gk-git-2.55.0-macos-arm64
var embeddedGitDarwinArm64 []byte
