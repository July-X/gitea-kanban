//go:build !darwin && !windows

package gitbinary

// v0.4.0 user 拍板：Linux 平台不内嵌 git 二进制。
//
// 理由（与 docs/adr/0005-electron-to-go-wails-migration.md 对齐）：
//   - Linux 发行版自带 git / apt install git 即可；包管理是最权威安装路径
//   - 内嵌 Linux 二进制会让 wails build 出来的 AppImage 体积 +50MB 而无明显收益
//   - sandbox / 服务器 / WSL 等 Linux 子场景若需 git，PATH 已就绪
//
// 用户在「Git 二进制」设置 UI 仍可手动指定路径（覆盖默认 PATH git）；
// Init() 不释放任何二进制，ResolveGitBinaryPath() 走 exec.LookPath("git") fallback。

// 占位：no-op（build tag 过滤掉 darwin/windows 的真二进制嵌入）
var embeddedBinary = func() []byte { return nil }

// 占位 marker，让 runner 通过 build tag 区分平台
const platformSupportsEmbeddedBinary = false
