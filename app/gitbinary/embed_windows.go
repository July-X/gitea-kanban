//go:build windows

package gitbinary

import _ "embed"

// v0.4.0 内嵌 Git 2.55.0 Windows 二进制（windows only，build tag 隔离）。
//
// 文件来源：wails build release 前用 Git for Windows portable 替换：
//   - windows-amd64: https://github.com/git-for-windows/git/releases
//     （下载 MinGit-<ver>-64-bit.zip，含 cmd/git.exe）
//
// 当前为 0 字节 placeholder，Init() 检测 size==0 时跳过释放 + WARNING 日志。
// Init() 释放后路径：${dataDir}/tools/git/git-2.55.0-windows-amd64.exe

//go:embed binaries/git/git-2.55.0-windows-amd64.exe
var embeddedGitWindowsAmd64 []byte
