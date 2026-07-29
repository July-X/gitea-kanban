//go:build windows

package updater

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// getShortPathNameW 调用 kernel32!GetShortPathNameW 把含空格的路径转成 8.3 短路径
//
// NSIS installer 的 /D=<dir> 参数不支持引号且遇到空格会截断（例如
// "C:\Program Files\Gitea Kanban\" 会被截成 "C:\Program" 导致安装失败）。
// Windows 8.3 短路径没有空格（如 C:\PROGRA~1\GITEA-K~1\），是 Win32 子系统的标准方案。
func getShortPathNameW(longPath string) string {
	kernel32, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return longPath // 回退：原样返回，让后续逻辑保守处理
	}
	proc, err := kernel32.FindProc("GetShortPathNameW")
	if err != nil {
		return longPath
	}
	// 调用 GetShortPathNameW(longPath, buf, bufSize)
	longPtr, err := syscall.UTF16PtrFromString(longPath)
	if err != nil {
		return longPath
	}
	// 先传 nil 缓冲区获取所需大小（UTF-16 rune 数）
	n, _, _ := proc.Call(uintptr(unsafe.Pointer(longPtr)), 0, 0)
	if n == 0 {
		return longPath // 路径不存在或其他错误，返回原值
	}
	// 分配 n+1 个 UTF-16 rune（+1 for null terminator）
	buf := make([]uint16, n+1)
	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(longPtr)), uintptr(unsafe.Pointer(&buf[0])), uintptr(n+1))
	if ret == 0 {
		return longPath
	}
	return syscall.UTF16ToString(buf[:ret])
}

const installerArgSilent = "/S"

// quoteIfNeeded 按 cmd.exe 规则：含空格才包双引号；不含空格不包
func quoteIfNeeded(p string) string {
	if !strings.ContainsAny(p, ` `) {
		return p
	}
	return `"` + p + `"`
}

// installerCommandLine 裸拼命令行（NSIS 要求 /D=<dir> 必须是不带引号的最后 token）
//
// 背景（v0.8.0.1 / 对齐 DeepSeek-Reasonix 修复）：
// user 路径常含空格（C:\Program Files\gitea-kanban\），exec.Command 默认 quote 路径
// 会让 NSIS 解析 /D= 时截断到第一个空格。
//
// v0.8.24 起改走 ShellExecuteExW + lpParameters（不再用 exec.Command），该函数保留
// 用于"如果未来切回 CreateProcess 路径"或调试日志。
func installerCommandLine(name, installDir string) string {
	return fmt.Sprintf(`%s %s /D=%s`, quoteIfNeeded(name), installerArgSilent, installDir)
}

// launcherForTest 是 ShellExecuteExW 的可注入实现，方便单元测试参数拼装。
// 生产代码在 launchElevated 里走真实 syscall；测试在 launchElevatedForTest 里替换。
type launcherForTest func(info *shellExecuteInfoW) error

// shellExecuteInfoW 是 Win32 SHELLEXECUTEINFOW 的 Go 镜像。
//
// 字段顺序和类型必须严格匹配 Win32 头文件（结构体布局错一位 ShellExecuteExW 就返 FALSE），
// 用 unsafe.Sizeof(info) 算 cbSize 而不是写常量，避免将来加字段忘记同步。
type shellExecuteInfoW struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     uintptr
}

// ShellExecuteExW 标志常量（Win32 shobjidl.h / shellapi.h）
const (
	seeMaskNoCloseProcess = 0x00004000 // SEE_MASK_NOCLOSEPROCESS：hProcess 持有子进程句柄
	seeMaskFlagNoUI       = 0x00000400 // SEE_MASK_FLAG_NO_UI：不显示系统错误对话框（避免弹窗污染）
	swHide                = 0          // SW_HIDE：隐藏窗口（NSIS /S 静默安装本身就是隐藏 UI）
)

// Windows 错误码常量（Win32 winerror.h）
const (
	errorCancelled = 1223 // ERROR_CANCELLED：UAC 用户点了"否"
)

// errElevationCancelled 在 launchElevated 里被吞掉（不算 bug），仅日志记录。
// 返回给调用方时转为 nil，让 applyWindows 走正常"应用退出但没升级"的语义。
var errElevationCancelled = errors.New("shell execute: elevation cancelled by user")

// shell32Proc lazy-loaded shell32.dll 句柄，全进程单例。
var shell32Proc uintptr

// loadShell32Proc 获取 shell32.dll 的 ShellExecuteExW 函数指针。
func loadShell32Proc() uintptr {
	if shell32Proc != 0 {
		return shell32Proc
	}
	dll := syscall.NewLazyDLL("shell32.dll")
	shell32Proc = dll.NewProc("ShellExecuteExW").Addr()
	return shell32Proc
}

// launchElevated 用 ShellExecuteExW + lpVerb="runas" 触发 UAC 拉起 installer。
//
// 为什么不用 exec.Command / CreateProcess：
//
//	NSIS installer manifest 声明 requireAdministrator（要写 C:\Program Files\），
//	CreateProcess 不会触发 UAC，会直接返 Win32 错误 740 ERROR_ELEVATION_REQUIRED
//	（user 实测截图就是这个错）。只有 ShellExecuteExW + runas verb 才会弹 UAC。
//
// 返回值：
//   - nil：UAC 同意，installer 已拉起（旧进程应尽快 os.Exit(0) 让 NSIS 覆盖文件）
//   - errElevationCancelled：UAC 用户点了"否"，静默不视为错误
//   - 其他 error：ShellExecuteExW 失败（win32 错误码）
func launchElevated(installerPath, shortInstallDir string) error {
	return launchElevatedWith(installerPath, shortInstallDir, realShellExecuteExW)
}

// launchElevatedWith 是 launchElevated 的可注入版本，单元测试里替换 launcher。
func launchElevatedWith(installerPath, shortInstallDir string, launcher launcherForTest) error {
	// 参数拼装：/S 静默 + /D=<短路径>。短路径保证无空格，NSIS 直接解析。
	// 注：lpParameters 是单个字符串，NSIS 会按空格拆 token，不需要外面 quote installerPath。
	params := installerArgSilent + " /D=" + shortInstallDir

	verb, err := syscall.UTF16PtrFromString("runas")
	if err != nil {
		return fmt.Errorf("utf16 verb: %w", err)
	}
	file, err := syscall.UTF16PtrFromString(installerPath)
	if err != nil {
		return fmt.Errorf("utf16 file: %w", err)
	}
	paramPtr, err := syscall.UTF16PtrFromString(params)
	if err != nil {
		return fmt.Errorf("utf16 params: %w", err)
	}

	info := &shellExecuteInfoW{
		fMask:        seeMaskNoCloseProcess | seeMaskFlagNoUI,
		lpVerb:       verb,
		lpFile:       file,
		lpParameters: paramPtr,
		nShow:        swHide,
	}
	info.cbSize = uint32(unsafe.Sizeof(*info))

	if err := launcher(info); err != nil {
		return err
	}

	// 释放子进程句柄（os.Exit(0) 进程会释放，但显式 CloseHandle 更稳）。
	if info.hProcess != 0 {
		_ = syscall.CloseHandle(syscall.Handle(info.hProcess))
	}
	return nil
}

// realShellExecuteExW 调真实 Win32 API，是生产 launcherForTest 默认值。
func realShellExecuteExW(info *shellExecuteInfoW) error {
	proc := loadShell32Proc()
	if proc == 0 {
		return errors.New("load shell32!ShellExecuteExW failed")
	}
	ret, _, errno := syscall.Syscall6(proc, 1, uintptr(unsafe.Pointer(info)), 0, 0, 0, 0, 0)
	if ret == 0 {
		// ShellExecuteExW 返 FALSE，错误码在 GetLastError（== errno）。
		if errno == errorCancelled {
			return errElevationCancelled
		}
		if errno != 0 {
			return fmt.Errorf("ShellExecuteExW failed (win32 errno=%d): %s", errno, win32ErrorHint(uintptr(errno)))
		}
		return errors.New("ShellExecuteExW returned FALSE (unknown win32 error)")
	}
	return nil
}

// win32ErrorHint 把常见的 ShellExecuteExW 错误码转成"人话"提示，给 fallback 用。
//
// ShellExecuteExW 的 GetLastError 可能返 SE_ERR_*（0x28~0x40 区间）或通用 Win32 错误。
// 这里只列出最常见的几个，其余返空字符串让上层用通用提示。
func win32ErrorHint(errno uintptr) string {
	switch errno {
	case 2: // ERROR_FILE_NOT_FOUND
		return "找不到安装包文件（可能已被清理或路径错误）"
	case 3: // ERROR_PATH_NOT_FOUND
		return "安装包路径不存在"
	case 5: // ERROR_ACCESS_DENIED
		return "访问被拒绝（即便有 UAC 也无法运行，检查文件权限）"
	case 8: // ERROR_NOT_ENOUGH_MEMORY
		return "内存不足"
	case 11: // ERROR_BAD_EXE_FORMAT
		return "安装包不是有效的 Win32 可执行文件（下载可能损坏）"
	case 26, 27: // SE_ERR_SHARE / SE_ERR_ASSOCINCOMPLETE
		return "文件关联或共享冲突"
	case 31: // SE_ERR_NOASSOC
		return "系统未配置 .exe 文件关联"
	default:
		return ""
	}
}

// openInstallerInExplorer 用 explorer.exe 高亮选中 installer，让用户手动双击。
//
// fallback 触发条件：UAC 取消（已静默吞掉）或 ShellExecuteExW 真的失败。
// 必须 fallback 到 explorer.exe 而不是直接 return——错误体验 = 让用户去下载目录找他下载的文件。
func openInstallerInExplorer(installerPath string) {
	dir := filepath.Dir(installerPath)
	cmd := exec.Command("explorer.exe", "/select,"+installerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		// 极端 fallback：explorer 也炸了，至少留个日志让前端 IPC 把错误上报。
		// 这里没法 return error 给前端——调用方已经决定走 fallback 了。
		_ = dir
	}
}

// applyWindows 启动 NSIS installer 静默安装（Windows 平台）
//
// v0.8.24 修复（user 截图：Win32 错误 740 ERROR_ELEVATION_REQUIRED）：
//
//	旧逻辑 exec.Command(installerPath).Start() 走 CreateProcess，
//	无法触发 UAC → NSIS installer（manifest 要求 requireAdministrator）失败。
//	改走 ShellExecuteExW + lpVerb="runas" 触发 UAC 弹窗，用户点确认后
//	NSIS 才能以管理员权限写 C:\Program Files\gitea-kanban\。
//
// 流程：
//  1. 拿当前 exe 路径（解析 symlink）+ installDir
//  2. 短路径化 installDir（NSIS /D= 不支持引号且遇空格截断）
//  3. ShellExecuteExW 弹 UAC → 用户点确认 → installer 拉起
//  4. os.Exit(0) 让旧进程退出，NSIS 才能覆盖文件
//
// UAC 取消（错误 1223）→ 静默返回 nil（不算错误）。
// 其他 ShellExecuteExW 失败 → fallback 到 explorer.exe 打开下载目录，
// 让用户手动双击安装；返回包装错误（前端 IPC 已统一处理）。
func applyWindows(installerPath string, logger func(level, format string, args ...any)) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	installDir := filepath.Dir(exe)

	// NSIS /D= 参数不支持引号且遇空格会截断，转成 8.3 短路径避免空格问题
	shortDir := getShortPathNameW(installDir)

	if logger != nil {
		logger("info", "update: Windows apply, launching NSIS installer via ShellExecuteExW+runas: %s /S /D=%s (orig: %s)", installerPath, shortDir, installDir)
	}

	err = launchElevated(installerPath, shortDir)
	switch {
	case err == nil:
		// installer 已拉起，旧进程必须退出让 NSIS 覆盖文件
		os.Exit(0)
		return nil // unreachable
	case errors.Is(err, errElevationCancelled):
		// UAC 用户点了"否"，不算 bug。日志记一下，前端无感知。
		if logger != nil {
			logger("info", "update: Windows apply, UAC cancelled by user, aborting upgrade")
		}
		return nil
	default:
		// 其他失败：打开下载目录让用户手动重试
		hint := win32ErrorHint(uintptrFromErrno(err))
		if hint == "" {
			hint = err.Error()
		}
		if logger != nil {
			logger("error", "update: Windows apply, ShellExecuteExW failed: %v; opening explorer fallback", err)
		}
		openInstallerInExplorer(installerPath)
		return fmt.Errorf("%w: launch NSIS installer: %v（可手动双击运行安装包）", ErrApplyFailed, err)
	}
}

// uintptrFromErrno 尝试从 error 里抠 syscall.Errno 再转 uintptr，否则返 0。
// 我们的 launcher 返回的是 fmt.Errorf 包装，可能不是 syscall.Errno——这里只是尽力而为。
func uintptrFromErrno(err error) uintptr {
	var eno syscall.Errno
	if errors.As(err, &eno) {
		return uintptr(eno)
	}
	return 0
}

// applyMacOS windows 平台的 stub，返 ErrUnsupportedOS
func applyMacOS(newBinaryPath string, logger func(level, format string, args ...any), openBrowser func(url string) error) error {
	return fmt.Errorf("%w: macOS apply called from Windows build", ErrUnsupportedOS)
}
