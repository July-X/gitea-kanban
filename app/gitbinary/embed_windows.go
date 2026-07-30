//go:build windows

package gitbinary

import (
	"embed"
	"io/fs"
	"runtime"
)

// v0.4.0 内嵌 Git 2.55.0 Windows 二进制（windows only，build tag 隔离）。
//
// 文件来源：wails build release 前用 Git for Windows portable 替换：
//   - windows-amd64: https://github.com/git-for-windows/git/releases
//     （下载 MinGit-<ver>-64-bit.zip，含 cmd/git.exe）
//
// 当前为 0 字节 placeholder，Init() 检测 size==0 时跳过释放 + WARNING 日志。
// Init() 释放后路径：${dataDir}/tools/git/git-2.55.0-windows-amd64.exe

//go:embed binaries/git/gk-git-2.55.0-windows-amd64.exe
var embeddedGitWindowsAmd64 []byte

// embeddedGitBytes 在 windows 平台返嵌入二进制内容。
func embeddedGitBytes() []byte {
	if runtime.GOARCH == "amd64" {
		return embeddedGitWindowsAmd64
	}
	return nil
}

// embeddedGitFileName 生成 windows 平台嵌入二进制文件名（带 .exe 后缀）。
func embeddedGitFileName() string {
	return "gk-git-" + gitVersion + "-windows-" + runtime.GOARCH + ".exe"
}

// embeddedHelperFS 嵌入 Windows git remote helper + DLL 依赖。
//
// 背景（v0.8.26+）：内嵌 git 主二进制（gk-git-...exe）是 MinGit 提取的 cmd/git.exe 单文件，
// 不带 git-remote-https.exe / git-remote-http.exe 等 remote helper，也不带 libcurl/libssl
// 等 DLL 依赖。Windows 上 `git fetch <https remote>` 会 fork git-remote-https.exe，
// helper 查找路径是 <argv0>/../mingw64/libexec/git-core（单文件布局不存在）→ PATH
// （用户没装系统 git）→ 报「git: 'remote-https' is not a git command」。
//
// 修法：从 MinGit-2.55.0-64-bit.zip 解压 mingw64/bin/ 下的 helper exes + 16 个 DLL 依赖，
// 嵌入到 binaries/git/windows-helper/ 子目录，Init() 释放到 ${dataDir}/tools/git/ 同目录，
// runner 在 RunGitWithEnv / RunGit 时注入 GIT_EXEC_PATH=<该目录> 让 git 能找到 helper。
//
// 依赖链（实测 PE 静态 + LoadLibrary 动态依赖）：
//   - git-remote-https.exe / git-remote-http.exe / git-http-fetch.exe / git-http-push.exe
//     静态依赖：libiconv-2.dll / libintl-8.dll / libpcre2-8-0.dll / zlib1.dll
//   - git-remote-https 动态加载 libcurl-openssl-4.dll（SSL 后端实现）
//   - libcurl-openssl-4.dll 依赖：libbrotlidec/libbrotlicommon/libcrypto-3-x64/libidn2-0/
//     libnghttp2-14/libpsl-5/libssh2-1/libssl-3-x64/libunistring-5/libzstd
//   - gk-git 主 exe 直接 import：zlib1.dll / libpcre2-8-0.dll / libiconv-2.dll / libintl-8.dll
//
// 总计 4 exes + 16 DLLs = 20 文件，约 22 MB。
//
//go:embed binaries/git/windows-helper
var embeddedHelperFSWindows embed.FS

// embeddedHelperFS 在 windows 平台返嵌入 helper 文件系统；其他平台返 nil。
//
// 实际目录访问通过 fs.Sub 限定到 windows-helper/ 子目录，避免包内路径污染。
func embeddedHelperFS() fs.FS {
	if runtime.GOARCH != "amd64" {
		return nil
	}
	sub, err := fs.Sub(embeddedHelperFSWindows, "binaries/git/windows-helper")
	if err != nil {
		return nil
	}
	return sub
}

// embeddedHelperAvailable 报告当前平台是否实际嵌入 helper。
//
// Init() 用此判断要不要执行 helper 释放步骤。
func embeddedHelperAvailable() bool {
	return embeddedHelperFS() != nil
}